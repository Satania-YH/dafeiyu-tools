#!/usr/bin/env node
'use strict';
/**
 * 给数据源补向量（bge-m3，走本机 Ollama）
 *
 * 用法：
 *   node server/embed.mjs                    处理 data-sources/cheng.json
 *   node server/embed.mjs --file=xxx.json    指定文件
 *   node server/embed.mjs --force            忽略缓存，全部重算
 *
 * 结果写回同一个 JSON 的 vector 字段。
 * 向量缓存在 data/vector-cache.json，按「文本哈希」索引 —— 文本没变就不重算。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const ARGS = process.argv.slice(2);
const argOf = (n) => {
  const hit = ARGS.find(a => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : null;
};
const FORCE = ARGS.includes('--force');
const FILE = path.resolve(ROOT, argOf('file') || 'data-sources/cheng.json');
const CACHE_FILE = path.join(ROOT, 'data', 'vector-cache.json');
const OLLAMA = 'http://localhost:11434';
const MODEL = 'bge-m3';
const CONCURRENCY = 2;          // Ollama 单模型，2 路并发刚好

const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

async function embedOne(text) {
  const res = await fetch(`${OLLAMA}/api/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, prompt: text }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const d = await res.json();
  if (!Array.isArray(d.embedding)) throw new Error('返回里没有 embedding');
  return d.embedding;
}

async function main() {
  if (!fs.existsSync(FILE)) {
    console.error(`找不到文件：${FILE}`);
    process.exit(1);
  }

  // 检查 Ollama
  try {
    const r = await fetch(`${OLLAMA}/api/version`, { signal: AbortSignal.timeout(4000) });
    const v = await r.json();
    console.log(`Ollama ${v.version} 在线`);
  } catch {
    console.error(`连不上 Ollama（${OLLAMA}）。先启动它再跑。`);
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const nodes = Array.isArray(data) ? data : (data.nodes || []);
  console.log(`文件：${path.relative(ROOT, FILE)}  共 ${nodes.length} 条`);

  // 缓存
  let cache = {};
  if (fs.existsSync(CACHE_FILE) && !FORCE) {
    try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch {}
  }
  const cachedCount = Object.keys(cache).length;
  if (cachedCount) console.log(`缓存里有 ${cachedCount} 条向量`);

  // 找出要算的
  const todo = [];
  let hit = 0;
  for (const n of nodes) {
    const text = String(n.text || '').trim();
    if (!text) continue;
    const key = hash(text);
    if (!FORCE && cache[key]) { hit++; continue; }
    todo.push({ n, key, text });
  }
  console.log(`命中缓存 ${hit} 条，需要新算 ${todo.length} 条`);

  if (todo.length) {
    const t0 = Date.now();
    let done = 0;
    let failed = 0;

    // 简单并发池
    let cursor = 0;
    async function worker() {
      while (true) {
        const i = cursor++;
        if (i >= todo.length) return;
        const { n, key, text } = todo[i];
        try {
          const vec = await embedOne(text.slice(0, 2000));
          cache[key] = vec;
          done++;
          const pct = ((done + failed) / todo.length * 100).toFixed(0);
          const el = (Date.now() - t0) / 1000;
          const eta = done ? (el / done * (todo.length - done - failed)).toFixed(0) : '?';
          process.stdout.write(`\r  ${pct}%  ${done}/${todo.length}  已用 ${el.toFixed(0)}s  预计还剩 ${eta}s   `);
        } catch (e) {
          failed++;
          console.error(`\n  失败：${n.id} — ${e.message}`);
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    console.log(`\n算完：成功 ${done}，失败 ${failed}，用时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);

    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
    console.log(`缓存已写：${path.relative(ROOT, CACHE_FILE)}（${Object.keys(cache).length} 条）`);
  }

  // 写回 vector 字段
  let written = 0;
  for (const n of nodes) {
    const text = String(n.text || '').trim();
    if (!text) continue;
    const v = cache[hash(text)];
    if (v) { n.vector = v; written++; }
  }

  if (Array.isArray(data)) {
    fs.writeFileSync(FILE, JSON.stringify(data, null, 1));
  } else {
    fs.writeFileSync(FILE, JSON.stringify(data, null, 1));
  }
  console.log(`已写回 ${written} 条向量 → ${path.relative(ROOT, FILE)}`);
  console.log(`维度 ${written ? nodes.find(n => n.vector)?.vector.length : 0}`);
}

main().catch(e => { console.error('出错：', e.message); process.exit(1); });
