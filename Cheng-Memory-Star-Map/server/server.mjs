#!/usr/bin/env node
'use strict';
/**
 * 澄的记忆星图 · 后台服务
 *
 * 把记忆画成一片星图：一颗星 = 一条记忆。
 * 只读：不改任何记忆文件、不回写。
 *
 * 用法：
 *   node server.mjs                启动（默认 17800）
 *   node server.mjs --port 18000   换端口
 *
 * 接口：
 *   GET  /                 → 前端页面
 *   GET  /api/sources      → 可用数据源列表
 *   GET  /api/source?id=…  → 某个数据源的节点
 *   GET  /api/health       → 健康检查
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const HOME = os.homedir();

const ARGS = process.argv.slice(2);
const argOf = (name) => {
  const hit = ARGS.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const PORT = Number(argOf('port') || process.env.PORT || 17800);
const HOST = '127.0.0.1';

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

/* ══════════ 数据源发现 ══════════
   和 Electron 版一致的三个位置，多一个项目内的 data-sources/ */
function customDirs() {
  return [...new Set([
    path.join(ROOT, 'data-sources'),                          // 项目内
    path.join(HOME, '.starmap', 'sources'),                   // 用户级
    path.join(ROOT, 'data'),                                  // 兼容旧的 data/
  ])];
}

function listSourceFiles() {
  const out = [];
  for (const dir of customDirs()) {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (ext !== '.json' && ext !== '.jsonl') continue;
      // 内部文件不当数据源
      if (e.name.startsWith('_') || e.name === 'vector-cache.json') continue;
      out.push({ dir, file: path.join(dir, e.name), name: e.name });
    }
  }
  return out;
}

/* ══════════ 节点规范化 ══════════
   字段和 memory-graph/1 一致，前端已经认这套 */
function normNode(x, i, tag) {
  x = x || {};
  return {
    id: String(x.id != null ? x.id : `${tag}-${i}`),
    k: String(x.kind || x.k || 'fact'),
    t: String(x.text || x.t || ''),
    ts: String(x.ts || x.time || x.date || '').slice(0, 10),
    imp: clamp01(x.importance != null ? x.importance : (x.imp != null ? x.imp : 0.5)),
    conf: clamp01(x.confidence != null ? x.confidence : (x.conf != null ? x.conf : 0.8)),
    scope: String(x.scope || ''),
    tags: Array.isArray(x.tags) ? x.tags.map(String) : [],
    arch: !!x.archived,
    use: Number(x.useCount || x.use || 0),
    src: String(x.source || tag),
    det: (x.details && typeof x.details === 'object') ? x.details : {},
    v: -1,
  };
}

/* ══════════ 读一个源 ══════════ */
function loadSource(meta) {
  let raw;
  try {
    const txt = fs.readFileSync(meta.file, 'utf8');
    if (path.extname(meta.file).toLowerCase() === '.jsonl') {
      raw = {
        nodes: txt.split('\n')
          .filter(l => l.trim())
          .map(l => { try { return JSON.parse(l); } catch { return null; } })
          .filter(Boolean),
      };
    } else {
      raw = JSON.parse(txt);
    }
  } catch (e) {
    return { error: `读取失败：${e.message}` };
  }

  const list = Array.isArray(raw) ? raw : (raw.nodes || []);
  if (!list.length) return { error: '这个文件里没有节点' };

  const id = 'custom:' + meta.name.replace(/\.[^.]+$/, '');
  const nodes = [];
  const quant = [];          // 量化后的向量，前端算余弦用
  let dim = 0;
  let withVec = 0;

  for (let i = 0; i < list.length; i++) {
    const n = normNode(list[i], i, id);
    const vec = list[i] && list[i].vector;
    if (Array.isArray(vec) && vec.length && quant.length < 4000) {
      if (!dim) dim = vec.length;
      if (vec.length === dim) {
        // 量化到 int8，前端能省内存也够用（和 Electron 版一个做法）
        const q = new Int8Array(dim);
        let norm = 0;
        for (let d = 0; d < dim; d++) norm += vec[d] * vec[d];
        norm = Math.sqrt(norm) || 1;
        for (let d = 0; d < dim; d++) {
          q[d] = Math.max(-127, Math.min(127, Math.round((vec[d] / norm) * 127)));
        }
        n.v = withVec;
        quant.push(Array.from(q));
        withVec++;
      }
    }
    nodes.push(n);
  }

  // 有向量就打包成 base64 的 int8 数组（前端 decodeVectors 认这个格式）
  let vecB64 = '';
  if (withVec && dim) {
    const flat = new Int8Array(withVec * dim);
    let off = 0;
    for (const q of quant) {
      flat.set(q, off);
      off += dim;
    }
    vecB64 = Buffer.from(flat.buffer).toString('base64');
  }

  // 统计（前端 HUD 要用）
  const kinds = {};
  let missingVector = 0;
  for (const n of nodes) {
    kinds[n.k] = (kinds[n.k] || 0) + 1;
    if (n.v < 0) missingVector++;
  }

  return {
    ok: true,
    id,
    title: String(raw.title || meta.name.replace(/\.[^.]+$/, '')),
    note: String(raw.note || ''),
    nodes,
    dim,
    withVec,
    vecB64,
    linkMode: withVec ? 'vector' : 'text',
    stats: {
      total: nodes.length,
      kinds,
      withVector: withVec,
      missingVector,
    },
  };
}

/* ══════════ 缓存（按 mtime 失效） ══════════ */
const cache = new Map();

function getSource(name) {
  const files = listSourceFiles();
  const meta = files.find(f => f.name === name || f.name.replace(/\.[^.]+$/, '') === name);
  if (!meta) return { error: '找不到这个源' };

  let mtime = 0;
  try { mtime = fs.statSync(meta.file).mtimeMs; } catch {}

  const hit = cache.get(meta.file);
  if (hit && hit.mtime === mtime) return hit.data;

  const data = loadSource(meta);
  if (data.ok) cache.set(meta.file, { mtime, data });
  return data;
}

function sourceList() {
  const files = listSourceFiles();
  return files.map(f => {
    let size = 0;
    try { size = fs.statSync(f.file).size; } catch {}

    // 列表项要带 stats/title/subtitle，前端直接用
    const d = getSource(f.name);
    const total = d.ok ? d.nodes.length : 0;
    const title = d.ok ? d.title : f.name.replace(/\.[^.]+$/, '');
    const sub = d.ok
      ? `${d.stats.withVector ? '向量 ' + d.stats.withVector : '无向量'} · ${(size / 1024).toFixed(0)} KB`
      : '读取失败';

    return {
      id: f.name,
      name: f.name.replace(/\.[^.]+$/, ''),
      file: f.name,
      dir: f.dir,
      size,
      title,
      subtitle: sub,
      stats: { total, kinds: d.ok ? d.stats.kinds : {}, withVector: d.ok ? d.stats.withVector : 0 },
    };
  });
}

/* ══════════ HTTP ══════════ */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
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

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/api/health') {
    return json(res, { ok: true, version: '0.1.0', sources: sourceList().length });
  }

  if (url.pathname === '/api/sources') {
    return json(res, { ok: true, sources: sourceList() });
  }

  if (url.pathname === '/api/source') {
    const id = url.searchParams.get('id');
    if (!id) return json(res, { ok: false, error: '缺少 id' }, 400);
    const data = getSource(id);
    if (!data.ok) return json(res, { ok: false, error: data.error }, 404);
    return json(res, data);
  }

  // 静态文件：/ → app/index.html
  let rel = url.pathname === '/' ? 'app/index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.resolve(ROOT, rel);

  if (!file.startsWith(ROOT + path.sep)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('Forbidden');
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('Not found');
  }

  res.writeHead(200, {
    'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'cache-control': 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
});

/* ══════════ 单实例锁 ══════════
   两把锁：
   1. 端口（操作系统级）—— 已有实例在跑就起不来
   2. 锁文件（应用级）—— 给出可读的提示，并防止同端口不同 PID 的竞态
*/
const LOCK_FILE = path.join(ROOT, 'data', 'server.lock');

function acquireLock() {
  fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
  try {
    // wx = 独占创建，已存在就抛
    const fd = fs.openSync(LOCK_FILE, 'wx');
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, port: PORT, at: new Date().toISOString() }));
    fs.closeSync(fd);
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    // 已存在：看看那个 PID 还活着吗
    let info = {};
    try { info = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')); } catch {}
    if (info.pid && isAlive(info.pid)) {
      return { busy: true, pid: info.pid, port: info.port };
    }
    // 残留锁：前一次没退干净，接管
    try { fs.unlinkSync(LOCK_FILE); } catch {}
    const fd = fs.openSync(LOCK_FILE, 'wx');
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, port: PORT, at: new Date().toISOString() }));
    fs.closeSync(fd);
    return true;
  }
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function releaseLock() {
  try {
    const info = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    if (info.pid === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch {}
}

const lock = acquireLock();
if (lock && lock.busy) {
  console.error(`[星图] 已经在运行了（PID ${lock.pid}，端口 ${lock.port}）`);
  console.error(`[星图] 直接打开：http://${HOST}:${lock.port}/`);
  console.error('[星图] 要重启就先停掉它。');
  process.exit(0);
}

server.listen(PORT, HOST, () => {
  const srcs = sourceList();
  console.log(`[星图] http://${HOST}:${PORT}  (PID ${process.pid})`);
  console.log(`[星图] 数据源目录：${customDirs().join('  |  ')}`);
  console.log(`[星图] 发现 ${srcs.length} 个源：${srcs.map(s => s.name).join(', ') || '（空）'}`);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[星图] 端口 ${PORT} 已被占用 —— 可能已经有一个实例在跑了`);
    console.error(`[星图] 打开 http://${HOST}:${PORT}/ 看看`);
    releaseLock();
    process.exit(0);
  }
  console.error('[星图] 启动失败：', e.message);
  releaseLock();
  process.exit(1);
});

function shutdown(sig) {
  console.log(`\n[星图] ${sig} 收到，正在停止…`);
  releaseLock();
  server.close(() => process.exit(0));
  // 兜底：1.5 秒还没关干净就硬退
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('exit', releaseLock);
