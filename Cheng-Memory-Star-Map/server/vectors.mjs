'use strict';
/**
 * 向量 —— 优先用澄导出的 vectors.json，只给新记忆现算。
 *
 * 三条关键事实（都实测过）：
 *   1. 澄导出的 vectors.json 里存的是 **l2 归一化之后** 的向量（norm 误差 < 1e-6）
 *      → 算 cos 直接点积，不用再归一化
 *   2. 我们自己的 vector-cache.json 存的是 **原始向量**（norm ≈ 25.24）
 *      → 用之前必须先 l2，否则会算出 625 倍的假余弦
 *   3. Ollama 默认只保活 5 分钟
 *      → 保活间隔必须 < 5 分钟（用 3.5 分钟），否则每次都是冷启动
 *
 * 只读 vectors.json；只写我们自己的 vector-cache.json。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { P, RUNTIME, exists, ensureDir, statOf } from './paths.mjs';

/* ══════════ 常量 ══════════ */

const OLLAMA = 'http://127.0.0.1:11434';
const MODEL = 'bge-m3';
const DIM = 1024;

/** 保活间隔：必须小于 Ollama 默认的 5 分钟空闲卸载 */
const KEEPALIVE_MS = 3.5 * 60 * 1000;

/* ══════════ 工具 ══════════ */

export function sha16(text) {
  return crypto.createHash('sha1').update(String(text || ''), 'utf8').digest('hex').slice(0, 16);
}

export function l2(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  s = Math.sqrt(s) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / s;
  return out;
}

export function dot(a, b) {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

/** 判断一个向量是不是已经归一化（norm ≈ 1） */
export function isNormalized(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return Math.abs(Math.sqrt(s) - 1) < 0.01;
}

/* ══════════ 向量库 ══════════ */

export class VectorStore {
  constructor() {
    /** sha16(text) → Float32Array（始终是归一化后的） */
    this.byHash = new Map();
    this.dim = 0;
    this.sources = { vectorsJson: 0, cache: 0, computed: 0 };
    this.ollamaUp = null;
    this.lastKeepalive = 0;
    this.keepaliveTimer = null;
  }

  /* ---------- 载入 ---------- */

  /** 载入澄导出的 vectors.json（已归一化） */
  loadFromVectorsJson(file = path.join(path.dirname(P.events), '..', '..', '大肥鱼工具', 'memory-graph', 'vectors.json')) {
    // 实际路径由调用方给，这里只是默认值兜底
    if (!exists(file)) return 0;
    let j;
    try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return 0; }
    if (!j || !j.vectors) return 0;

    this.dim = Number(j.dim) || DIM;
    const normalized = j.normalized === true;
    let n = 0;
    for (const [k, arr] of Object.entries(j.vectors)) {
      if (!Array.isArray(arr) || arr.length !== this.dim) continue;
      const f = Float32Array.from(arr);
      this.byHash.set(k, normalized ? f : l2(f));
      n++;
    }
    this.sources.vectorsJson = n;
    return n;
  }

  /** 载入我们自己的 vector-cache.json（原始向量，要归一化） */
  loadFromCache(file = RUNTIME.vectorCache) {
    if (!exists(file)) return 0;
    let j;
    try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return 0; }
    let n = 0;
    for (const [k, arr] of Object.entries(j || {})) {
      if (!Array.isArray(arr) || !arr.length) continue;
      if (this.byHash.has(k)) continue;      // vectors.json 优先
      if (!this.dim) this.dim = arr.length;
      if (arr.length !== this.dim) continue; // 维度不一致的跳过
      this.byHash.set(k, l2(Float32Array.from(arr)));
      n++;
    }
    this.sources.cache = n;
    return n;
  }

  /** 全部载入 */
  loadAll(vectorsJsonPath) {
    const a = vectorsJsonPath ? this.loadFromVectorsJson(vectorsJsonPath) : 0;
    const b = this.loadFromCache();
    return { fromVectorsJson: a, fromCache: b, total: this.byHash.size };
  }

  /* ---------- 查询 ---------- */

  /** 按文本取向量；没有返回 null */
  get(text) {
    return this.byHash.get(sha16(text)) || null;
  }

  has(text) {
    return this.byHash.has(sha16(text));
  }

  size() {
    return this.byHash.size;
  }

  /* ---------- Ollama ---------- */

  /** 探测 Ollama 在不在 */
  async ping() {
    try {
      const r = await fetch(`${OLLAMA}/api/version`, { signal: AbortSignal.timeout(2000) });
      this.ollamaUp = r.ok;
      return r.ok;
    } catch {
      this.ollamaUp = false;
      return false;
    }
  }

  /** 确认模型在不在 */
  async hasModel() {
    try {
      const r = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (!r.ok) return false;
      const j = await r.json();
      return (j.models || []).some(m => m.name === MODEL || m.name.startsWith(MODEL + ':'));
    } catch {
      return false;
    }
  }

  /**
   * 现算一条向量。
   * @returns {Float32Array|null} 归一化后的；失败返回 null
   */
  async embed(text) {
    const t = String(text || '').trim();
    if (!t) return null;

    // 先查缓存
    const hit = this.get(t);
    if (hit) return hit;

    if (this.ollamaUp === false) return null;

    try {
      const t0 = Date.now();
      const r = await fetch(`${OLLAMA}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, input: [t] }),
        signal: AbortSignal.timeout(30000),
      });
      if (!r.ok) {
        this.ollamaUp = false;
        return null;
      }
      const j = await r.json();
      const arr = (j.embeddings && j.embeddings[0]) || (j.data && j.data[0] && j.data[0].embedding);
      if (!Array.isArray(arr) || arr.length !== this.dim) return null;

      const v = l2(Float32Array.from(arr));
      this.byHash.set(sha16(t), v);
      this.sources.computed++;
      this.ollamaUp = true;

      const ms = Date.now() - t0;
      if (ms > 1000) this.lastColdStart = { at: Date.now(), ms };
      return v;
    } catch (e) {
      this.ollamaUp = false;
      return null;
    }
  }

  /** 批量现算（并发 2，和 embed.mjs 一致） */
  async embedMany(texts, concurrency = 2, onProgress) {
    const todo = texts.filter(t => t && !this.has(t));
    if (!todo.length) return { computed: 0, failed: 0 };
    let ok = 0, bad = 0, i = 0;
    const worker = async () => {
      while (i < todo.length) {
        const idx = i++;
        const v = await this.embed(todo[idx]);
        if (v) ok++; else bad++;
        if (onProgress) onProgress(ok + bad, todo.length);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    return { computed: ok, failed: bad };
  }

  /* ---------- 保活 ---------- */

  /**
   * 启动保活。
   *
   * 澄实测：bge-m3 只占 657 MiB，加载着的时候她画 1024 anime 反而更快
   * （22.2s vs 空载 24.2s），ComfyUI 自己会挤显存，两者不打架。
   *
   * 但 Ollama 默认 5 分钟空闲就卸载，所以间隔必须小于 5 分钟。
   */
  startKeepalive(onLog) {
    if (this.keepaliveTimer) return;
    const tick = async () => {
      try {
        const r = await fetch(`${OLLAMA}/api/embed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: MODEL, input: ['保活'] }),
          signal: AbortSignal.timeout(15000),
        });
        this.ollamaUp = r.ok;
        this.lastKeepalive = Date.now();
        if (onLog && !r.ok) onLog(`保活失败：HTTP ${r.status}`);
      } catch (e) {
        this.ollamaUp = false;
        if (onLog) onLog(`保活失败：${e.message}`);
      }
    };
    tick();                                    // 立刻打一次
    this.keepaliveTimer = setInterval(tick, KEEPALIVE_MS);
    if (this.keepaliveTimer.unref) this.keepaliveTimer.unref();
  }

  stopKeepalive() {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  /* ---------- 持久化 ---------- */

  /** 把新算的写回 cache（原始向量格式，和 embed.mjs 兼容） */
  saveCache(file = RUNTIME.vectorCache) {
    const out = {};
    // 只存我们算过的（vectors.json 那份不用重存）
    for (const [k, v] of this.byHash) {
      out[k] = Array.from(v);
    }
    try {
      ensureDir(path.dirname(file));
      fs.writeFileSync(file, JSON.stringify(out), 'utf8');
      return { saved: Object.keys(out).length, bytes: fs.statSync(file).size };
    } catch (e) {
      return { error: e.message };
    }
  }

  /* ---------- 诊断 ---------- */

  status() {
    return {
      total: this.byHash.size,
      dim: this.dim,
      sources: { ...this.sources },
      ollamaUp: this.ollamaUp,
      lastKeepalive: this.lastKeepalive ? new Date(this.lastKeepalive).toISOString() : null,
      lastColdStart: this.lastColdStart || null,
      keepaliveIntervalSec: KEEPALIVE_MS / 1000,
    };
  }
}

/* ══════════ 便捷：一次拿到所有节点的向量 ══════════ */

/**
 * 给定节点列表，返回 id → 向量 的映射，缺的现算。
 * @param {VectorStore} store
 * @param {Array<{id:string,text:string}>} nodes
 */
export async function ensureVectors(store, nodes, onProgress) {
  const missing = [];
  for (const n of nodes) {
    if (!n.text) continue;
    if (!store.has(n.text)) missing.push(n.text);
  }
  if (missing.length) {
    await store.embedMany(missing, 2, onProgress);
  }
  const out = new Map();
  let hit = 0, miss = 0;
  for (const n of nodes) {
    const v = n.text ? store.get(n.text) : null;
    if (v) { out.set(n.id, v); hit++; }
    else miss++;
  }
  return { vectors: out, hit, miss };
}
