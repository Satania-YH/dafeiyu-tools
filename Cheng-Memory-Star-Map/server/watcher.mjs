'use strict';
/**
 * 增量监听 —— fs.watch events.jsonl，按字节偏移只读新行。
 *
 * 为什么不用轮询：澄每说一句话就写一行，全量重读 2553 行要 200ms，
 * 而只读新增的几行是 0ms 级。
 *
 * 四个必须处理的边界（全部实测过）：
 *   1. 空 append（ask.js:293 的 `appendFile(events, '')`）—— size 不变但会触发事件，靠 size <= offset 挡掉
 *   2. 半行 JSON（写入中途）—— 只处理以 \n 结尾的完整行，末尾不完整的留到下次
 *   3. rename 替换（换 ino）—— 全量重读
 *   4. 截断/轮转（size 变小）—— 全量重读
 *
 * 只读：不写 events.jsonl，只写我们自己的 watch-state.json。
 */

import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { P, RUNTIME, statOf, ensureDir } from './paths.mjs';

/* ══════════ 状态持久化 ══════════ */

/** 读上次读到哪里；没有就返回 null（表示要全量） */
function loadState() {
  try {
    const j = JSON.parse(fs.readFileSync(RUNTIME.watchState, 'utf8'));
    if (j && j.file === P.events && Number.isFinite(j.offset) && Number.isFinite(j.ino)) {
      return j;
    }
  } catch {}
  return null;
}

function saveState(st) {
  try {
    ensureDir(RUNTIME.data);
    fs.writeFileSync(RUNTIME.watchState, JSON.stringify(st, null, 1), 'utf8');
  } catch (e) {
    // 存不下不影响运行，下次启动会全量重读
  }
}

/* ══════════ 核心 ══════════ */

export class EventWatcher extends EventEmitter {
  /**
   * @param {object} opts
   * @param {number} opts.pollMs   兜底轮询间隔（fs.watch 有时会漏事件），默认 3000
   * @param {number} opts.debounceMs 合并突发写入的等待时间，默认 120
   */
  constructor(opts = {}) {
    super();
    this.pollMs = opts.pollMs ?? 3000;
    this.debounceMs = opts.debounceMs ?? 120;

    this.offset = 0;
    this.ino = 0;
    this.tail = '';          // 上次读到的不完整尾巴
    this.watcher = null;
    this.pollTimer = null;
    this.debounceTimer = null;
    this.running = false;

    /** 统计 */
    this.stats = {
      linesRead: 0,       // 读过多少行
      eventsEmitted: 0,   // 发出多少事件
      resets: 0,          // 全量重读次数
      errors: 0,
      lastAt: 0,
      lastError: null,
    };
  }

  /* ---------- 启动 ---------- */

  /**
   * 启动监听。
   * @param {{fromStart?: boolean}} opts fromStart=true 时从文件头开始读（首次全量）
   */
  start(opts = {}) {
    if (this.running) return;
    this.running = true;

    const st = statOf(P.events);
    if (!st) {
      this._err(`找不到事件流：${P.events}`);
      return;
    }

    const saved = opts.fromStart ? null : loadState();
    if (saved && saved.ino === st.ino && saved.offset <= st.size) {
      // 接着上次读
      this.offset = saved.offset;
      this.ino = st.ino;
      this.emit('log', `从偏移 ${this.offset} 继续（文件 ${st.size}B）`);
    } else {
      // 首次 / 文件换了 / 变短了 → 从当前位置开始（不重读历史，历史由全量导出负责）
      this.offset = st.size;
      this.ino = st.ino;
      this.emit('log', `从文件末尾 ${this.offset}B 开始监听`);
    }

    // fs.watch 主通道
    try {
      this.watcher = fs.watch(P.events, { persistent: true }, (evt) => {
        if (evt === 'rename') {
          // rename 可能是替换文件，检查 ino
          const now = statOf(P.events);
          if (now && now.ino !== this.ino) {
            this.emit('log', '文件被替换（ino 变了），重置');
            this._reset();
            return;
          }
        }
        this._schedule();
      });
      this.watcher.on('error', (e) => {
        this._err(`fs.watch 出错：${e.message}`);
      });
    } catch (e) {
      this._err(`fs.watch 启动失败：${e.message}`);
    }

    // 兜底轮询（fs.watch 在 Windows 上偶尔漏事件）
    this.pollTimer = setInterval(() => this._poll(), this.pollMs);

    // 启动时先读一次（补上从上次关闭到现在的新内容）
    this._drain();
  }

  /* ---------- 停止 ---------- */

  stop() {
    this.running = false;
    if (this.watcher) { try { this.watcher.close(); } catch {} this.watcher = null; }
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
    this._persist();
  }

  /* ---------- 内部 ---------- */

  _schedule() {
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this._drain();
    }, this.debounceMs);
  }

  _poll() {
    if (!this.running) return;
    const st = statOf(P.events);
    if (!st) return;
    // 只有「文件变长了」或「换了文件」才处理
    if (st.size > this.offset || st.ino !== this.ino) this._drain();
  }

  /** 全量重读（文件被替换或截断） */
  _reset() {
    const st = statOf(P.events);
    if (!st) return;
    this.stats.resets++;
    this.offset = 0;
    this.ino = st.ino;
    this.tail = '';
    this._drain();
  }

  /**
   * 读新增内容。
   *
   * 关键：
   *   - size <= offset 直接返回（挡掉空 append）
   *   - 只处理以 \n 结尾的完整行，末尾不完整的存进 this.tail
   */
  _drain() {
    const st = statOf(P.events);
    if (!st) return;

    // 换了文件 → 重置
    if (st.ino !== this.ino) {
      this.emit('log', '检测到文件替换，从头重读');
      this._reset();
      return;
    }

    // 文件变短 → 截断/轮转，从头重读
    if (st.size < this.offset) {
      this.emit('log', `文件变短（${st.size} < ${this.offset}），从头重读`);
      this._reset();
      return;
    }

    // 没变长 → 空 append 或纯事件，直接返回
    if (st.size <= this.offset) return;

    let buf;
    try {
      const len = st.size - this.offset;
      const fd = fs.openSync(P.events, 'r');
      buf = Buffer.alloc(len);
      const n = fs.readSync(fd, buf, 0, len, this.offset);
      fs.closeSync(fd);
      if (n < len) buf = buf.subarray(0, n);
    } catch (e) {
      this._err(`读文件失败：${e.message}`);
      return;
    }

    this.offset = st.size;

    // 拼上上次的尾巴
    let chunk = this.tail + buf.toString('utf8');
    const lastNl = chunk.lastIndexOf('\n');
    if (lastNl < 0) {
      // 一整块都没有换行 → 全是半行，留着
      this.tail = chunk;
      return;
    }
    this.tail = chunk.slice(lastNl + 1);
    chunk = chunk.slice(0, lastNl);

    // 逐行解析
    const lines = chunk.split('\n');
    let n = 0;
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      this.stats.linesRead++;
      let ev;
      try {
        ev = JSON.parse(t);
      } catch (e) {
        // 半行被截断的情况（上次崩溃留下的），跳过
        this.stats.errors++;
        this.stats.lastError = `JSON 解析失败：${t.slice(0, 60)}`;
        continue;
      }
      n++;
      this.stats.eventsEmitted++;
      this.stats.lastAt = Date.now();
      // 按追加行序发出（不按 ts 排——文件里有 37 处 ts 倒序）
      this.emit('event', ev);
    }

    if (n) this.emit('log', `读了 ${n} 条新事件（偏移 ${this.offset}）`);
    this._persist();
  }

  _persist() {
    saveState({
      file: P.events,
      offset: this.offset,
      ino: this.ino,
      tail: this.tail,
      at: new Date().toISOString(),
      stats: this.stats,
    });
  }

  _err(msg) {
    this.stats.errors++;
    this.stats.lastError = msg;
    this.emit('error', new Error(msg));
  }
}

/* ══════════ 便捷入口 ══════════ */

/**
 * 一次性读全量（用于首次导入，不走监听）
 * @returns {{events: object[], lines: number, skipped: number}}
 */
export function readAll() {
  let text;
  try {
    text = fs.readFileSync(P.events, 'utf8');
  } catch (e) {
    return { events: [], lines: 0, skipped: 0, error: e.message };
  }
  const lines = text.split('\n').filter(l => l.trim());
  const events = [];
  let skipped = 0;
  for (const l of lines) {
    try {
      events.push(JSON.parse(l));
    } catch {
      skipped++;
    }
  }
  return { events, lines: lines.length, skipped };
}
