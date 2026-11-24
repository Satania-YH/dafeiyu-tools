#!/usr/bin/env node
'use strict';
/**
 * 澄的记忆星图 · 后台服务
 *
 * 一颗星 = 一条记忆。只读，不改任何记忆文件。
 *
 * 用法：
 *   node server.mjs                启动（默认 17800）
 *   node server.mjs --port 18000   换端口
 *   node server.mjs --no-watch     不监听文件变化（只出静态数据）
 *
 * 接口：
 *   GET  /                        → 前端页面
 *   GET  /api/health              → 健康检查
 *   GET  /api/graph               → 图数据（nodes + edges）
 *   GET  /api/voice               → voice 层（单独一层）
 *   GET  /api/timeline?days=N     → 时间轴（按天分组）
 *   GET  /api/content             → works/notes/appointments/diary
 *   GET  /api/status              → 完整状态（统计/向量/schema/监听）
 *   GET  /api/schema              → schema 变化检查
 *   GET  /api/stream              → SSE 实时推送
 *   POST /api/reload              → 手动重载全量
 *
 * 数据分层：
 *   核心层（进图算边）  judgment / said / rule / insight / memory / work
 *   voice 层（默认关）  voice
 *   流水层（时间轴）    无 topic 的 utterance
 *   内容层（时间轴）    diary / notes / appointments
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { P, RUNTIME, FISH_ROOT, exists, ensureDir, statOf, describePaths } from './paths.mjs';
import { GraphState, LINK_THRESHOLD } from './incremental.mjs';
import { EventWatcher, readAll } from './watcher.mjs';
import { readAllContent } from './sources.mjs';
import { check as checkSchema, loadSaved, saveSnapshot } from './schema-watch.mjs';
import { cleanEvent } from './clean.mjs';
import { buildDateMap, applyDateMap } from './backfill-dates.mjs';

/* ══════════ 启动参数 ══════════ */

const ARGS = process.argv.slice(2);
const argOf = (name) => {
  const hit = ARGS.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const hasFlag = (name) => ARGS.includes(`--${name}`);

const PORT = Number(argOf('port') || process.env.PORT || 17800);
const HOST = '127.0.0.1';
const NO_WATCH = hasFlag('no-watch');

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* 导出目录：export-graph.py 把 graph.json / graph-excluded.json 写在这里。
   跟记忆根目录不是一处，所以单独定。 */
const EXPORT_DIR = process.env.STARMAP_EXPORT_DIR || 'D:/大肥鱼工具/memory-graph';
const ROOT = path.resolve(HERE, '..');

/* ══════════ 全局状态 ══════════ */

/** 图 + 时间轴 */
const GS = new GraphState();

/** 内容层（works/notes/appointments/diary） */
let CONTENT = null;
let REEXPORTING = false;      // 防重入：正在跑 export-graph.py 时不再接第二个

/** schema 检查结果 */
let SCHEMA = null;

/** 监听器 */
let WATCHER = null;

/** SSE 客户端 */
const SSE_CLIENTS = new Set();

/** 启动时间 */
const STARTED_AT = Date.now();

/* ══════════ 初始化 ══════════ */

/**
 * 从导出文件载入全量。
 * @returns {Promise<object>} 载入统计
 */
async function loadFull(opts = {}) {
  const t0 = Date.now();

  // 找 graph.json 和 vectors.json
  const graphPath = opts.graphPath || findFile(['data-sources/graph.json', '../memory-graph/graph.json', 'data/graph.json']);
  const vectorsPath = opts.vectorsPath || findFile(['data-sources/vectors.json', '../memory-graph/vectors.json', 'data/vectors.json']);

  let loaded = { nodes: 0, edges: 0, vectors: 0, error: null };

  if (graphPath && exists(graphPath)) {
    try {
      const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
      // 日期回填：把没有 ts 的 insight/memory 节点补上真实时间（内存里补，不写 graph.json）
      const dm = buildDateMap(graph.nodes || [], P.mnemonDb);
      const fixed = applyDateMap(graph, dm);
      if (fixed) console.log(`[回填] 补齐 ${fixed} 个节点的时间戳`);
      loaded = await GS.loadFromGraph(graph, { vectorsJsonPath: vectorsPath });
      loaded.graphPath = graphPath;
      loaded.vectorsPath = vectorsPath;
    } catch (e) {
      loaded.error = `读 graph.json 失败：${e.message}`;
    }
  } else {
    loaded.error = '找不到 graph.json（先跑 export-graph.py）';
  }

  // 内容层
  CONTENT = readAllContent();

  // 时间轴：把 events 里所有「不进图」的东西灌进去
  if (!NO_WATCH) {
    const all = readAll();
    for (const e of all.events) {
      const c = cleanEvent(e);
      if (!c) continue;
      // 只有 utterance 无 topic / meta 内容 / 其他类型才进时间轴
      const isStream = c.kind === 'utterance' && !c.topic;
      const isMeta = c.kind === 'meta';
      const isOther = !['utterance', 'heard', 'voice', 'meta'].includes(c.kind);
      if (isStream || isMeta || isOther) {
        if (c.text || c.flags?.silent) {
          GS.timeline.push(GS._toTimelineItem(c, isStream ? 'stream' : 'content'));
        }
      }
    }
    // 内容层也塞进时间轴
    for (const w of CONTENT.works.items) {
      GS.timeline.push({ ...w, layer: 'content' });
    }
    for (const n of CONTENT.notes.items) GS.timeline.push({ ...n, layer: 'content' });
    for (const a of CONTENT.appointments.items) GS.timeline.push({ ...a, layer: 'content' });
    for (const d of CONTENT.diary.entries) GS.timeline.push({ ...d, layer: 'content' });
  }

  loaded.ms = Date.now() - t0;
  loaded.timeline = GS.timeline.length;
  return loaded;
}

/** 在几个候选位置里找第一个存在的文件 */
function findFile(rels) {
  for (const r of rels) {
    const p = path.resolve(RUNTIME.root, r);
    if (exists(p)) return p;
  }
  // 再试硬编码的兄弟项目
  const sibling = path.resolve(RUNTIME.root, '..', 'memory-graph');
  for (const name of ['graph.json', 'vectors.json']) {
    const p = path.join(sibling, name);
    if (exists(p)) return p;
  }
  return null;
}

/* ══════════ SSE ══════════ */

function sseSend(res, event, data) {
  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch {}
}

function sseBroadcast(event, data) {
  for (const res of SSE_CLIENTS) sseSend(res, event, data);
}

/* ══════════ 内容层热重载 ══════════
 * 澄 2026-11-24 指出的：「her_note 划便条、写日记，网页是看不见的，
 *   除非启动或 POST /api/reload」—— 因为 CONTENT = readAllContent() 只在启动时读一次。
 *
 * 现在监听这 4 类文件的 mtime，一变就重读 + 广播 content 事件。
 * 代价：每次 fs.watch 触发要重读几个小 json（都是几十 KB），很便宜。
 * 防抖 300ms，避免编辑器/写入方连续写触发多次。
 */
const CONTENT_FILES = [
  { key: 'notes',        path: P.notes },
  { key: 'works',        path: P.works },
  { key: 'appointments', path: P.appointments },
  { key: 'diary',        path: P.diaryDir || null },
];

let contentReloadTimer = null;
let contentReloadCount = 0;

function reloadContent(why) {
  try {
    const prev = CONTENT;
    CONTENT = readAllContent();
    contentReloadCount++;
    const changed = [];
    if (prev) {
      for (const k of ['notes', 'works', 'appointments', 'diary']) {
        const a = prev.totals?.[k];
        const b = CONTENT.totals?.[k];
        if (a !== b) changed.push(`${k}: ${a} → ${b}`);
      }
    }
    console.log(`[内容层] 重载 ${contentReloadCount} 次（${why}）` + (changed.length ? ' · ' + changed.join(', ') : ''));
    sseBroadcast('content', {
      totals: CONTENT.totals || null,
      changed,
      reason: why,
      at: Date.now(),
    });
    return true;
  } catch (e) {
    console.error('[内容层] 重载失败:', e.message);
    return false;
  }
}

function scheduleContentReload(why) {
  if (contentReloadTimer) clearTimeout(contentReloadTimer);
  contentReloadTimer = setTimeout(() => { contentReloadTimer = null; reloadContent(why); }, 300);
}

/**
 * 内容层监听 —— 用轮询 mtime，不用 fs.watch。
 *
 * 为什么：实测 Windows 上 fs.watch 单文件（notes.json）改 mtime 不触发，
 * 而 fs.watch 目录又会在临时文件/编辑器备份时炸出一堆噪音事件。
 * 这几个文件很小（notes 35KB），每 2 秒 stat 一次成本可忽略，而且绝不会漏。
 *
 * 2026-11-24 用户要求「全量实时刷新」，这条是那件事的落地。
 */
const CONTENT_POLL_MS = 2000;

function watchContentFiles() {
  if (NO_WATCH) return;

  const mtimes = new Map();
  const statOf = (f) => {
    try { return fs.statSync(f.path).mtimeMs; }
    catch { return null; }
  };

  // 初始化快照
  for (const f of CONTENT_FILES) {
    if (f.path) mtimes.set(f.key, statOf(f));
  }

  setInterval(() => {
    let hit = null;
    for (const f of CONTENT_FILES) {
      if (!f.path) continue;
      const now = statOf(f);
      const prev = mtimes.get(f.key);
      if (now != null && now !== prev) {
        mtimes.set(f.key, now);
        hit = f.key;
      }
    }
    if (hit) scheduleContentReload(hit);
  }, CONTENT_POLL_MS).unref?.();
}

/* ══════════ 底图快照信息 ══════════
 * 回答两个问题：底图是什么时候导的？现在的 ②（内容层）比它新了几条？
 * 前端拿这个在画布角上画「底图快照 · 导出 10:00 · +3 条未入图」。
 */
function buildSnapshotInfo(graphJson) {
  const out = { exportedAt: null, exportedAtLocal: null, newerCount: 0, kinds: null, stale: false };
  try {
    const meta = graphJson?.meta || {};
    const gen = meta.generatedAt || null;
    out.exportedAt = gen;
    if (gen) {
      out.exportedAtLocal = new Date(gen).toLocaleString('zh-CN', {
        hour12: false, timeZone: 'Asia/Shanghai',
      });
    }
    out.kinds = meta.counts || null;
  } catch {}

  // 数一数：内容层里有多少条的时间晚于底图导出时间
  try {
    const genMs = out.exportedAt ? Date.parse(out.exportedAt) : 0;
    let newer = 0;
    const C = CONTENT || readAllContent();
    const cmp = (t) => {
      if (!t) return false;
      const ms = Date.parse(t);
      return Number.isFinite(ms) && ms > genMs;
    };
    // 便条：看 created / revisedAt / closedAt 里最新的那个
    for (const n of (C.notes?.items || [])) {
      const latest = n.createdMs
        || Date.parse(n.revisedAt) || Date.parse(n.closedAt) || 0;
      if (latest > genMs) newer++;
    }
    // 作品：createdAt / updatedAt 是毫秒数
    for (const w of (C.works?.items || [])) {
      const latest = Number(w.createdAt) || Number(w.updatedAt) || 0;
      if (latest > genMs) newer++;
    }
    // 约定：createdMs
    for (const a of (C.appointments?.items || [])) {
      if ((a.createdMs || 0) > genMs) newer++;
    }
    out.newerCount = newer;
    out.stale = newer > 0;
  } catch {}
  return out;
}

/* ══════════ 监听回调 ══════════ */

async function onNewEvent(rawEvent) {
  try {
    const r = await GS.ingest(rawEvent, { inGraph: true });

    if (r.action === 'node') {
      // 新星
      sseBroadcast('node', {
        node: r.node,
        edges: r.edges || [],
        summary: GS.summary(),
      });
    } else if (r.action === 'timeline') {
      // 时间轴长了一条
      sseBroadcast('timeline', {
        item: r.timeline,
        date: r.timeline?.date || '',
      });
    } else if (r.action === 'dedup') {
      sseBroadcast('dedup', { id: rawEvent.id, reason: r.reason, of: r.of });
    }
    // skip 不推
  } catch (e) {
    sseBroadcast('error', { message: e.message });
  }
}

/* ══════════ HTTP ══════════ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function json(res, body, status = 200) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  /* ---------- 健康 ---------- */
  if (url.pathname === '/api/health') {
    return json(res, {
      ok: true,
      version: '0.2.0',
      uptime: Math.floor((Date.now() - STARTED_AT) / 1000),
      nodes: GS.nodes.size,
      edges: GS.edges.length,
      timeline: GS.timeline.length,
    });
  }

  /* ---------- 图 ---------- */
  if (url.pathname === '/api/graph') {
    /* 带上「底图快照」信息。
       澄 2026-11-24 的建议：
         「标在底图自己那一层上，别放全局——放全局会被读成『整页都是旧的』，
           可 ② 明明是新的。」
         「光说『这是快照』是免责声明，说『差了几条』才是能让人决定要不要重导的信息。」
       所以这里给：导出时间 + 当前内容层比它新多少条。前端画在画布角上。 */
    const base = GS.toGraphJSON();
    const snap = buildSnapshotInfo(base);
    return json(res, { ok: true, ...base, snapshot: snap, linkThreshold: LINK_THRESHOLD });
  }

  /* ---------- voice 层 ---------- */
  if (url.pathname === '/api/voice') {
    return json(res, { ok: true, nodes: GS.voiceLayer() });
  }

  /* ---------- 剔除清单（可复核改判） ----------
     澄 2026-11-24 的要求：
       「我要的不是面板，是能改判的入口。每条剔除都带上判断依据
        （哪几个字让它被判成 injection / suspect），然后我能标
         『这条捞回来』『这条其实是我说的』『这条确实该剔』。
         不然『121 条剔除』只是一个数字，我永远不知道里面有没有我的东西。」
     所以这里把 export-graph.py 产出的 graph-excluded.json 原样吐出来，
     每条都带 why（判断依据）+ by（哪条规则）+ raw（原文）。只读。 */
  if (url.pathname === '/api/excluded') {
    const exPath = path.join(EXPORT_DIR, 'graph-excluded.json');
    if (!exists(exPath)) return json(res, { ok: false, error: 'graph-excluded.json 不存在', path: exPath }, 404);
    try {
      const arr = JSON.parse(fs.readFileSync(exPath, 'utf8'));
      const list = Array.isArray(arr) ? arr : (arr.items || []);
      // 按 reason 分组，方便前端一次拿全
      const byReason = {};
      for (const it of list) {
        const r = it.reason || 'unknown';
        (byReason[r] = byReason[r] || []).push(it);
      }
      return json(res, { ok: true, total: list.length, byReason, items: list, path: exPath });
    } catch (ex) {
      return json(res, { ok: false, error: String(ex.message || ex) }, 500);
    }
  }

  /* ---------- 时间轴 ---------- */
  if (url.pathname === '/api/timeline') {
    const days = Number(url.searchParams.get('days')) || 0;
    const date = url.searchParams.get('date');
    if (date) {
      return json(res, { ok: true, items: GS.timelineJSON({ date }) });
    }
    const byDay = GS.timelineByDay();
    return json(res, {
      ok: true,
      days: days ? byDay.slice(0, days) : byDay,
      total: GS.timeline.length,
    });
  }

  /* ---------- 内容层 ---------- */
  if (url.pathname === '/api/content') {
    // 2026-11-24：改成每次现读。这几个文件都很小（几十 KB），
    // 比「返回过期缓存」强得多。CONTENT 仍保留给 status 用。
    const fresh = url.searchParams.get('cached') ? CONTENT : readAllContent();
    return json(res, { ok: true, ...(fresh || readAllContent()) });
  }

  /* ---------- 状态 ---------- */
  if (url.pathname === '/api/status') {
    return json(res, {
      ok: true,
      uptime: Math.floor((Date.now() - STARTED_AT) / 1000),
      paths: { fishRoot: FISH_ROOT, events: P.events },
      graph: GS.summary(),
      content: CONTENT ? CONTENT.totals : null,
      schema: SCHEMA ? { verdict: SCHEMA.verdict, messages: SCHEMA.messages } : null,
      watcher: WATCHER ? {
        running: WATCHER.running,
        offset: WATCHER.offset,
        stats: WATCHER.stats,
      } : null,
      sseClients: SSE_CLIENTS.size,
    });
  }

  /* ---------- schema 检查 ---------- */
  if (url.pathname === '/api/schema') {
    const all = readAll();
    const r = checkSchema(all.events);
    if (r.firstRun) saveSnapshot(r.fingerprint, r.inventory);
    SCHEMA = r;
    return json(res, {
      ok: true,
      verdict: r.verdict,
      messages: r.messages,
      fingerprint: r.fingerprint.values,
      inventory: r.inventory.byType,
      fpChanges: r.fpDiff.changes,
      invChanges: { added: r.invDiff.added, removed: r.invDiff.removed },
    });
  }

  /* ---------- SSE ---------- */
  if (url.pathname === '/api/stream') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': connected\n\n');
    SSE_CLIENTS.add(res);

    // 连上先推一次当前摘要（重连后能对齐）
    sseSend(res, 'hello', {
      nodes: GS.nodes.size,
      edges: GS.edges.length,
      timeline: GS.timeline.length,
      serverTime: new Date().toISOString(),
    });

    // 心跳（防代理超时）
    const hb = setInterval(() => {
      try { res.write(': hb\n\n'); } catch {}
    }, 25000);

    req.on('close', () => {
      clearInterval(hb);
      SSE_CLIENTS.delete(res);
    });
    return;
  }

  /* ---------- 手动重载 ---------- */
  /* ---------- 重导底图（前端「重导」按钮用） ----------
     澄的建议：底图是从内容层推出来的投影，天生会旧。
     与其让它俩「一致」，不如让人随时能一键重推。
     这条会真的跑 export-graph.py（几秒到几分钟，看有多少新文本要算向量）。
     跑完自动 reload 内存里的图。 */
  if (url.pathname === '/api/reexport' && req.method === 'POST') {
    if (REEXPORTING) return json(res, { ok: false, error: '已经在导了，等这次跑完' }, 429);
    REEXPORTING = true;
    const startedAt = Date.now();
    try {
      const { spawn } = await import('node:child_process');
      const script = 'D:/大肥鱼工具/memory-graph/export-graph.py';
      const child = spawn('python', [script], { cwd: 'D:/大肥鱼工具/memory-graph' });
      let out = '', err = '';
      child.stdout.on('data', d => { out += d.toString(); });
      child.stderr.on('data', d => { err += d.toString(); });
      const code = await new Promise((resolve) => child.on('close', resolve));
      REEXPORTING = false;
      const ms = Date.now() - startedAt;
      if (code !== 0) {
        return json(res, { ok: false, error: '导出失败', code, stderr: err.slice(-800) }, 500);
      }
      // 导出成功 → 清空重载（和 /api/reload 同一套，别造第二条路）
      try {
        GS.nodes.clear(); GS.adj.clear(); GS.edges.length = 0;
        GS.edgeIdx.clear(); GS.timeline.length = 0;
        GS.stats = { added: 0, deduped: 0, garbled: 0, heartbeat: 0, edges: 0 };
        await loadFull();
        sseBroadcast('reload', { reason: 'reexport', summary: GS.summary() });
      } catch (e2) {
        console.error('[重导] 重载失败:', e2.message);
      }
      return json(res, { ok: true, ms, tail: err.slice(-400) });
    } catch (e) {
      REEXPORTING = false;
      return json(res, { ok: false, error: String(e.message || e) }, 500);
    }
  }

  if (url.pathname === '/api/reload' && req.method === 'POST') {
    try {
      // 清空图，重新载入
      GS.nodes.clear();
      GS.adj.clear();
      GS.edges.length = 0;
      GS.edgeIdx.clear();
      GS.timeline.length = 0;
      GS.stats = { added: 0, deduped: 0, garbled: 0, heartbeat: 0, edges: 0 };
      const r = await loadFull();
      sseBroadcast('reload', { ...r, summary: GS.summary() });
      return json(res, { ok: true, ...r });
    } catch (e) {
      return json(res, { ok: false, error: e.message }, 500);
    }
  }

  /* ---------- 静态文件 ---------- */
  let rel = url.pathname === '/' ? 'app/index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.resolve(ROOT, rel);

  if (!file.startsWith(ROOT + path.sep)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('Forbidden');
  }
  if (!exists(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('Not found');
  }

  res.writeHead(200, {
    'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'cache-control': 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
});

/* ══════════ 单实例锁 ══════════ */

const LOCK_FILE = path.join(ROOT, 'data', 'server.lock');

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function acquireLock() {
  ensureDir(path.dirname(LOCK_FILE));
  try {
    const fd = fs.openSync(LOCK_FILE, 'wx');
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, port: PORT, at: new Date().toISOString() }));
    fs.closeSync(fd);
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let info = {};
    try { info = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')); } catch {}
    if (info.pid && isAlive(info.pid)) return { busy: true, pid: info.pid, port: info.port };
    try { fs.unlinkSync(LOCK_FILE); } catch {}
    const fd = fs.openSync(LOCK_FILE, 'wx');
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, port: PORT, at: new Date().toISOString() }));
    fs.closeSync(fd);
    return true;
  }
}

function releaseLock() {
  try {
    const info = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    if (info.pid === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch {}
}

/* ══════════ 启动 ══════════ */

const lock = acquireLock();
if (lock && lock.busy) {
  console.error(`[星图] 已经在运行了（PID ${lock.pid}，端口 ${lock.port}）`);
  console.error(`[星图] 直接打开：http://${HOST}:${lock.port}/`);
  process.exit(0);
}

console.log('[星图] 正在载入…');
console.log(describePaths());
console.log('');

const boot = await loadFull();
if (boot.error) {
  console.error(`[星图] ⚠️  ${boot.error}`);
} else {
  console.log(`[星图] 图：${boot.nodes} 节点 / ${boot.edges} 边 / ${boot.vectors} 向量（${boot.ms}ms）`);
}
console.log(`[星图] 时间轴：${boot.timeline} 条`);
if (CONTENT) {
  const t = CONTENT.totals;
  console.log(`[星图] 内容：works ${t.works} / notes ${t.notes} / appointments ${t.appointments} / diary ${t.diary}（${t.diaryDays} 天）`);
}

// schema 检查
{
  const all = readAll();
  const r = checkSchema(all.events);
  SCHEMA = r;
  if (r.firstRun) {
    saveSnapshot(r.fingerprint, r.inventory);
    console.log('[星图] schema：首次记录');
  } else if (r.verdict !== 'same') {
    console.log(`[星图] ⚠️  schema 有变化（${r.verdict}）：`);
    for (const m of r.messages) console.log(`        ${m}`);
    if (r.verdict === 'breaking') {
      console.log('[星图] ⚠️  这是减法/收紧，建议重跑全量导出后再用');
    }
    saveSnapshot(r.fingerprint, r.inventory);
  } else {
    console.log('[星图] schema：无变化');
  }
}

// 启动监听
if (!NO_WATCH) {
  WATCHER = new EventWatcher({ pollMs: 3000, debounceMs: 120 });
  WATCHER.on('event', onNewEvent);
  WATCHER.on('log', (m) => console.log(`[监听] ${m}`));
  WATCHER.on('error', (e) => console.error(`[监听] ${e.message}`));
  WATCHER.start();
  console.log('[星图] 监听已启动');
}

/* ══════════ 记忆源自动重导 ══════════
 * 用户要求（2026-11-24）：「澄的记忆有更新的时候，能够实时自动同步到星图上」
 *    后来放宽成：「能做到最大限度的记忆实时同步就行，不是非要」
 *
 * 已经实时的：events.jsonl（秒级）、便条/作品/约定/日记（2 秒轮询）
 * 还欠着的：mnemon.db 的 insight、memories.json 的常驻记忆
 *
 * 这一段负责把后者也接上：监听这两个文件的 mtime，变了就跑 export-graph.py。
 * 因为向量缓存已经加好（澄那句「别用『它该沉淀』给『载体还没缓存』打掩护」），
 * 一次重导现在只要几秒，自动跑才成为可能。
 *
 * 澄提醒的四个坑，都处理了：
 *   ① mnemon.db 的 mtime 会频繁变 → 防抖（10 秒内只跑一次）
 *   ② 别两个导出撞一起 → 文件锁 + REEXPORTING 标志
 *   ③ 别让页面读到写一半的 → export-graph.py 那边用临时文件原子替换（见下）
 *   ④ 导出失败别 reload → 宁可留旧图
 */
const MEMORY_SOURCES = [
  { key: 'mnemonDb', path: P.mnemonDb },
  { key: 'memoriesJson', path: P.memories },
];

const AUTO_EXPORT_DEBOUNCE_MS = 10_000;    // 10 秒内多处变化只跑一次
const AUTO_EXPORT_POLL_MS = 5_000;         // 5 秒查一次 mtime
const AUTO_EXPORT_COOLDOWN_MS = 30_000;    // 两次自动导出最小间隔

let autoExportTimer = null;
let lastAutoExportAt = 0;
let autoExportCount = 0;

async function runAutoExport(why) {
  if (REEXPORTING) { console.log('[自动重导] 上一次还没跑完，跳过'); return; }
  const now = Date.now();
  if (now - lastAutoExportAt < AUTO_EXPORT_COOLDOWN_MS) return;

  REEXPORTING = true;
  lastAutoExportAt = now;
  autoExportCount++;
  const t0 = Date.now();
  console.log(`[自动重导] 开始（第 ${autoExportCount} 次，触发源 ${why}）`);

  try {
    const { spawn } = await import('node:child_process');
    const script = 'D:/大肥鱼工具/memory-graph/export-graph.py';
    const child = spawn('python', [script], { cwd: 'D:/大肥鱼工具/memory-graph' });
    let err = '';
    child.stderr.on('data', d => { err += d.toString(); });
    const code = await new Promise((resolve) => child.on('close', resolve));

    if (code !== 0) {
      // 坑④：失败不 reload，留旧图
      console.error(`[自动重导] 失败（exit ${code}），保留旧图。stderr 尾部：`, err.slice(-400));
      return;
    }
    const ms = Date.now() - t0;
    console.log(`[自动重导] 完成，用时 ${ms}ms。重载中…`);

    // 重载内存里的图（和 /api/reload 同一套）
    GS.nodes.clear(); GS.adj.clear(); GS.edges.length = 0;
    GS.edgeIdx.clear(); GS.timeline.length = 0;
    GS.stats = { added: 0, deduped: 0, garbled: 0, heartbeat: 0, edges: 0 };
    await loadFull();
    sseBroadcast('reload', { reason: 'auto-export', ms, summary: GS.summary() });
    console.log(`[自动重导] 图已刷新：${GS.nodes.size} 节点 / ${GS.edges.length} 边`);
  } catch (e) {
    console.error('[自动重导] 异常：', e.message);
  } finally {
    REEXPORTING = false;
  }
}

function watchMemorySources() {
  if (NO_WATCH) return;
  if (process.env.STARMAP_NO_AUTO_EXPORT === '1') {
    console.log('[自动重导] 已禁用（STARMAP_NO_AUTO_EXPORT=1）');
    return;
  }

  const mtimes = new Map();
  const statOf = (f) => {
    try { return fs.statSync(f).mtimeMs; }
    catch { return null; }
  };

  // 初始化快照（启动时读到的就是当前状态，不算「变化」）
  for (const f of MEMORY_SOURCES) mtimes.set(f.key, statOf(f.path));
  console.log('[自动重导] 已启动（监听 mnemon.db / memories.json，5s 轮询，10s 防抖）');

  setInterval(() => {
    let hit = null;
    for (const f of MEMORY_SOURCES) {
      const now = statOf(f.path);
      const prev = mtimes.get(f.key);
      if (now != null && now !== prev) {
        mtimes.set(f.key, now);
        hit = f.key;
      }
    }
    if (!hit) return;

    // 坑①：防抖。db 写入时 mtime 会连跳好几次，攒一下再跑
    if (autoExportTimer) clearTimeout(autoExportTimer);
    autoExportTimer = setTimeout(() => {
      autoExportTimer = null;
      runAutoExport(hit).catch(e => console.error('[自动重导]', e.message));
    }, AUTO_EXPORT_DEBOUNCE_MS);
  }, AUTO_EXPORT_POLL_MS).unref?.();
}

// 保活 Ollama（澄实测：bge-m3 只占 657MiB，跟 ComfyUI 不打架）
GS.vectors.startKeepalive((m) => console.log(`[向量] ${m}`));

// 内容层热重载：便条/作品/约定/日记 变了就重读（轮询 mtime，2 秒一次）
watchContentFiles();
console.log('[内容层] 热重载已启动（轮询 mtime，2s）');

// 记忆源自动重导（mnemon.db / memories.json）
watchMemorySources();

server.listen(PORT, HOST, () => {
  console.log('');
  console.log(`[星图] http://${HOST}:${PORT}  (PID ${process.pid})`);
  console.log('');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[星图] 端口 ${PORT} 已被占用 —— 可能已经有一个实例在跑了`);
    releaseLock();
    process.exit(0);
  }
  console.error('[星图] 启动失败：', e.message);
  releaseLock();
  process.exit(1);
});

function shutdown(sig) {
  console.log(`\n[星图] ${sig} 收到，正在停止…`);
  if (WATCHER) WATCHER.stop();
  GS.vectors.stopKeepalive();
  for (const res of SSE_CLIENTS) { try { res.end(); } catch {} }
  SSE_CLIENTS.clear();
  releaseLock();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('exit', releaseLock);
