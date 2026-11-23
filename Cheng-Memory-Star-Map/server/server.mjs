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
const ROOT = path.resolve(HERE, '..');

/* ══════════ 全局状态 ══════════ */

/** 图 + 时间轴 */
const GS = new GraphState();

/** 内容层（works/notes/appointments/diary） */
let CONTENT = null;

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
    return json(res, { ok: true, ...GS.toGraphJSON(), linkThreshold: LINK_THRESHOLD });
  }

  /* ---------- voice 层 ---------- */
  if (url.pathname === '/api/voice') {
    return json(res, { ok: true, nodes: GS.voiceLayer() });
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
    return json(res, { ok: true, ...(CONTENT || readAllContent()) });
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

// 保活 Ollama（澄实测：bge-m3 只占 657MiB，跟 ComfyUI 不打架）
GS.vectors.startKeepalive((m) => console.log(`[向量] ${m}`));

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
