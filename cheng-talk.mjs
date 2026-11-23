#!/usr/bin/env node
// cheng-talk —— 让别的程序（Alma）正经地跟澄说话，不借道鱼鱼窝房间。
//
// 每次调用都现读 ~/.dsh/fish-room.discovery.json 拿 origin + sessionId，
// 所以 DSH 重启、端口变、换房之后，下一次调用自己就连到新的那间上了。
//
//   node cheng-talk.mjs status                 看看现在接的是谁、那间会话活着没
//   node cheng-talk.mjs say "话"               说一句，等澄回完，把回话打出来
//   node cheng-talk.mjs say "话" --no-wait     只投进去，不等回话
//   node cheng-talk.mjs read [--limit 20]      读最近几条对话（她说的/我说的）
//   node cheng-talk.mjs watch                  盯着，来一句打一句（Ctrl+C 退）
//   node cheng-talk.mjs serve [--port 17801]   起一个常驻小服务，别的程序用 HTTP 说（推荐给 Alma）
//
// 选项：--json 输出结构化结果；--timeout <秒> 等回话的上限（默认 240）
//
// serve 的 HTTP 接口（只认 127.0.0.1）：
//   GET  /health                 → 现在接的是哪间、活着没
//   POST /say   {text, wait?, timeoutMs?}  → 说一句；wait=true 会等回话
//   POST /ask   {text, timeoutMs?}         → 说一句并等回话（= say + wait）
//   GET  /read?limit=20          → 最近几条对话
// 房间切换不用管：每次请求都现读 discovery 文件，DSH 重启/换房自己就跟上了。

import fs from 'node:fs';
import path from 'node:path';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HOME = process.env.USERPROFILE || process.env.HOME || 'C:\\Users\\14127';
const DISC = path.join(HOME, '.dsh', 'fish-room.discovery.json');
const CRED = path.join(HOME, '.dsh', '.credentials.yaml');

const argv = process.argv.slice(2);
const cmd = argv[0] || 'status';
const flag = (n) => argv.includes('--' + n);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const AS_JSON = flag('json');
const TIMEOUT = Number(opt('timeout', '240')) * 1000;

function die(msg) {
  if (AS_JSON) console.log(JSON.stringify({ ok: false, error: msg }));
  else console.error('✗ ' + msg);
  process.exit(1);
}
function out(obj, human) {
  if (AS_JSON) console.log(JSON.stringify(obj, null, 2));
  else console.log(human);
}

// ── 找到现在那间屋子 ─────────────────────────────────────────
function discovery() {
  if (!fs.existsSync(DISC)) die('找不到 ' + DISC + ' —— DSH 或鱼鱼窝插件没开着？');
  const d = JSON.parse(fs.readFileSync(DISC, 'utf8'));
  if (!d.url) die('discovery 里没有 url');
  return d;
}

// ── 用 browser-session secret 现签一个 cookie ────────────────
function makeCookie(authority) {
  if (!fs.existsSync(CRED)) die('找不到 ' + CRED);
  const yaml = fs.readFileSync(CRED, 'utf8');
  const m = /client-connection\/browser-session:\s*\n(?:.*\n)*?\s*secret:\s*(\S+)/.exec(yaml);
  if (!m) die('credentials.yaml 里没有 browser-session secret');
  const secret = Buffer.from(m[1].trim(), 'base64url');
  if (secret.length !== 32) die('secret 不是 32 字节');
  const b64u = (b) => Buffer.from(b).toString('base64url');
  const now = Date.now();
  const payload = { version: 1, authority, issuedAt: now, expiresAt: now + 30 * 60 * 1000 };
  const body = b64u(Buffer.from(JSON.stringify(payload), 'utf8'));
  return 'dsh-auth-' + b64u(createHash('sha256').update(authority).digest()) +
    '=v1.' + body + '.' + b64u(createHmac('sha256', secret).update(body).digest());
}

// ── 连接 ────────────────────────────────────────────────────
function connect() {
  const d = discovery();
  const u = new URL(d.url);
  const origin = u.origin;
  const authority = u.host;
  const cookie = makeCookie(authority);
  let rpcId = 0;
  async function rpc(endpoint, args) {
    rpcId += 1;
    const r = await fetch(origin + '/api/' + endpoint, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'cheng-' + rpcId + '-' + Date.now(), method: endpoint, payload: { args } }),
    });
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch { throw new Error(endpoint + ' 不是 JSON: ' + text.slice(0, 300)); }
    if (!json.result) throw new Error(endpoint + ' 没有 result: ' + text.slice(0, 300));
    if (json.result.ok !== true) throw new Error(endpoint + ' 失败: ' + JSON.stringify(json.result.error));
    return json.result.value;
  }
  return { d, origin, authority, rpc, sessionId: d.sessionId };
}

// ── 从事件里抠出人话 ────────────────────────────────────────
function 正文(content) {
  if (!Array.isArray(content)) return '';
  return content.filter((p) => p && p.type === 'text' && p.text).map((p) => p.text).join('').trim();
}

async function 读事件(c, { maxMessages = 200, beforeSeq } = {}) {
  const addr = { kind: 'session', sessionId: c.sessionId };
  const req = { address: addr, maxMessages };
  if (beforeSeq !== undefined) req.beforeSeq = beforeSeq;
  const page = await c.rpc('session/events', { request: req });
  const recs = (page.records || []).filter((x) => x && x.type === 'event' && x.event).map((x) => x.event);
  return { events: recs, cursor: page.cursor, hasMore: page.hasMore };
}

// 等一轮对话完成。session/wait 会一直挂到会话安静下来，并把 afterSeq 之后的回话带回来
async function 等回话(c, baselineSeq, deadline, 总时长) {
  const 上限 = 总时长 || TIMEOUT;
  let after = baselineSeq;
  const texts = [];
  let reason = null;
  // 刚投进去可能还没起来，先给它一点时间
  await new Promise((r) => setTimeout(r, 1200));
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error('等回话超时（' + Math.round(上限 / 1000) + ' 秒，她这轮还没说完）');
    const res = await c.rpc('session/wait', {
      request: {
        sessionId: c.sessionId,
        timeoutMs: Math.max(1000, Math.min(left, 60000)),
        afterSeq: after,
        maxMessages: 200,
      },
    });
    reason = res.reason || null;
    const recs = (res.output && res.output.records) || [];
    let lastSeq = after;
    for (const rec of recs) {
      const e = rec && rec.event ? rec.event : rec;
      if (!e || typeof e.seq !== 'number') continue;
      if (e.seq <= after) continue;
      if (e.seq > lastSeq) lastSeq = e.seq;
      if (e.type === 'assistant/message' && e.data && !e.data.interrupted) {
        const t = 正文(e.data.message && e.data.message.content);
        if (t) texts.push({ turn: e.data.turn, text: t });
      }
    }
    after = lastSeq;
    const 收 = () => 收尾(texts, reason);
    if (reason === 'input-required') return { ...收(), needInput: true };
    if (reason === 'idle') {
      const st = res.state || {};
      // 刚投进去那一下可能还是 idle，等它真的跑完再算
      if (!st.running && texts.length > 0) return 收();
      if (!st.running && Date.now() > deadline - 上限 + 15000) return 收();
    }
  }
}

// 只留最后一轮的话——中间步骤的碎话不给别人看
function 收尾(texts, reason) {
  if (!texts.length) return { text: '', turns: 0, reason };
  const lastTurn = texts[texts.length - 1].turn;
  const 这轮 = texts.filter((x) => x.turn === lastTurn);
  const seen = new Set();
  const parts = [];
  for (const x of 这轮) if (!seen.has(x.text)) { seen.add(x.text); parts.push(x.text); }
  return { text: parts.join('\n\n'), turns: parts.length, turn: lastTurn, reason };
}

// ── 命令 ────────────────────────────────────────────────────
async function cmdStatus() {
  const c = connect();
  const st = await c.rpc('session/state', { request: { sessionId: c.sessionId } });
  const list = await c.rpc('session/list', { _request: {} });
  const item = (list.items || []).find((x) => x.sessionId === c.sessionId);
  out({
    ok: true, origin: c.origin, sessionId: c.sessionId, bridgeVersion: c.d.bridgeVersion,
    alive: st.active, running: st.running, cursor: st.cursor, cwd: item && item.cwd, title: item && item.title,
  }, [
    '接在 ' + c.origin,
    '会话 ' + c.sessionId,
    '那间屋子：' + (st.active ? '活着' : '没开') + ' · ' + (st.running ? '正在想事情' : '闲着'),
    '工作目录 ' + ((item && item.cwd) || '?'),
  ].join('\n'));
}

async function cmdSay(text, wait) {
  if (!text) die('要说点什么？用法：cheng-talk.mjs say "话"');
  const c = connect();
  const before = await c.rpc('session/state', { request: { sessionId: c.sessionId } });
  if (!before.active) die('那间会话现在没开着（sessionId ' + c.sessionId + '）');
  const requestId = 'cheng-' + randomUUID();
  const t0 = Date.now();
  await c.rpc('session/prompt', {
    request: { requestId, sessionId: c.sessionId, mode: 'queue', content: [{ type: 'text', text }] },
  });
  if (!wait) {
    out({ ok: true, requestId, accepted: true, sessionId: c.sessionId }, '✓ 投进去了（不等回话）');
    return;
  }
  const res = await 等回话(c, before.cursor, Date.now() + TIMEOUT, TIMEOUT);
  if (AS_JSON) out({ ok: true, requestId, reply: res.text, reason: res.reason, ms: Date.now() - t0 });
  else console.log(res.text || '（这轮没有文字回话）');
}

async function cmdRead() {
  const c = connect();
  const limit = Number(opt('limit', '20'));
  // 一页只给 200 条事件、其中大半是工具调用；往前翻，直到凑够人话
  let beforeSeq;
  const events = [];
  for (let i = 0; i < 12; i += 1) {
    const page = await 读事件(c, { maxMessages: 200, beforeSeq });
    if (!page.events.length) break;
    events.unshift(...page.events);
    const 有人话 = events.filter((e) => e.type === 'user/message' || e.type === 'assistant/message').length;
    if (有人话 >= limit || !page.hasMore) break;
    beforeSeq = page.events[0].seq;
  }
  const lines = [];
  for (const e of events) {
    if (e.type === 'user/message' && e.data) {
      const t = 正文(e.data.content);
      const k = (e.data.source && e.data.source.kind) || '?';
      if (t) lines.push('[她/' + k + '] ' + t.slice(0, 300));
    } else if (e.type === 'assistant/message' && e.data && !e.data.interrupted) {
      const t = 正文(e.data.message && e.data.message.content);
      if (t) lines.push('[我] ' + t.slice(0, 300));
    }
  }
  const tail = lines.slice(-limit);
  if (AS_JSON) out({ ok: true, count: tail.length, messages: tail });
  else console.log(tail.join('\n---\n') || '（没读到对话）');
}

async function cmdWatch() {
  const c = connect();
  let cursor = (await 读事件(c, { maxMessages: 1 })).cursor;
  console.error('· 盯着 ' + c.sessionId + '（Ctrl+C 退出）');
  for (;;) {
    try {
      const { events } = await 读事件(c, { maxMessages: 200 });
      const fresh = events.filter((e) => e.seq > (cursor || 0));
      if (fresh.length) cursor = fresh[fresh.length - 1].seq;
      for (const e of fresh) {
        if (e.type === 'user/message' && e.data) {
          const t = 正文(e.data.content);
          if (t) console.log('[她] ' + t);
        } else if (e.type === 'assistant/message' && e.data && !e.data.interrupted) {
          const t = 正文(e.data.message && e.data.message.content);
          if (t) console.log('[我] ' + t);
        }
      }
    } catch (err) {
      console.error('· 断了，重连：' + (err && err.message ? err.message : err));
      try { const d = discovery(); cursor = 0; console.error('· 现在接 ' + d.url); } catch {}
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

// ── serve：给别的程序（Alma）用的常驻 HTTP 小门 ──────────────
async function cmdServe() {
  const { createServer } = await import('node:http');
  const port = Number(opt('port', '17801'));
  const host = '127.0.0.1';

  const send = (res, code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 200000) { reject(new Error('body 太大')); req.destroy(); } });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('body 不是 JSON')); }
    });
    req.on('error', reject);
  });

  async function 说话(text, wait, timeoutMs) {
    const c = connect();
    const before = await c.rpc('session/state', { request: { sessionId: c.sessionId } });
    if (!before.active) throw new Error('那间会话现在没开着（' + c.sessionId + '）');
    const requestId = 'alma-' + randomUUID();
    const t0 = Date.now();
    await c.rpc('session/prompt', {
      request: { requestId, sessionId: c.sessionId, mode: 'queue', content: [{ type: 'text', text }] },
    });
    const base = { ok: true, requestId, sessionId: c.sessionId, origin: c.origin, accepted: true };
    if (!wait) return base;
    const 上限 = Math.min(Math.max(5000, timeoutMs || TIMEOUT), 600000);
    const res = await 等回话(c, before.cursor, Date.now() + 上限, 上限);
    return { ...base, reply: res.text, needInput: !!res.needInput, reason: res.reason, ms: Date.now() - t0 };
  }

  const server = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://' + host + ':' + port);
    const route = req.method + ' ' + u.pathname.replace(/\/+$/, '');
    try {
      if (route === 'GET /health' || route === 'GET ') {
        try {
          const c = connect();
          const st = await c.rpc('session/state', { request: { sessionId: c.sessionId } });
          return send(res, 200, { ok: true, room: { origin: c.origin, sessionId: c.sessionId, bridgeVersion: c.d.bridgeVersion }, alive: st.active, running: st.running, cursor: st.cursor });
        } catch (err) {
          return send(res, 200, { ok: false, room: null, error: err && err.message ? err.message : String(err) });
        }
      }
      if (route === 'POST /say' || route === 'POST /ask') {
        const b = await readBody(req);
        const text = String(b.text || '').trim();
        if (!text) return send(res, 400, { ok: false, error: 'text 是空的' });
        const wait = route === 'POST /ask' ? true : b.wait === true;
        const r = await 说话(text, wait, Number(b.timeoutMs) || TIMEOUT);
        return send(res, 200, r);
      }
      if (route === 'GET /read') {
        const c = connect();
        const limit = Math.min(200, Number(u.searchParams.get('limit') || '20'));
        let beforeSeq;
        const events = [];
        for (let i = 0; i < 12; i += 1) {
          const page = await 读事件(c, { maxMessages: 200, beforeSeq });
          if (!page.events.length) break;
          events.unshift(...page.events);
          const n = events.filter((e) => e.type === 'user/message' || e.type === 'assistant/message').length;
          if (n >= limit || !page.hasMore) break;
          beforeSeq = page.events[0].seq;
        }
        const msgs = [];
        for (const e of events) {
          if (e.type === 'user/message' && e.data) {
            const t = 正文(e.data.content);
            const k = (e.data.source && e.data.source.kind) || '?';
            if (t && k !== 'time-context') msgs.push({ who: 'user', source: k, text: t, at: e.time });
          } else if (e.type === 'assistant/message' && e.data && !e.data.interrupted) {
            const t = 正文(e.data.message && e.data.message.content);
            if (t) msgs.push({ who: 'cheng', text: t, at: e.time });
          }
        }
        return send(res, 200, { ok: true, sessionId: c.sessionId, messages: msgs.slice(-limit) });
      }
      return send(res, 404, { ok: false, error: '没有这个路口：' + route });
    } catch (err) {
      return send(res, 500, { ok: false, error: err && err.message ? err.message : String(err) });
    }
  });

  // 让别人能找到这个门：写一份 endpoint，房间换了跟着更新
  const ENDPOINT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cheng-talk.endpoint.json');
  function 写门牌() {
    let room = null;
    try { const d = discovery(); room = { origin: new URL(d.url).origin, sessionId: d.sessionId, bridgeVersion: d.bridgeVersion }; } catch {}
    const info = { schema: 'cheng-talk.endpoint/1', url: 'http://' + host + ':' + port, pid: process.pid, at: Date.now(), room };
    try { fs.writeFileSync(ENDPOINT, JSON.stringify(info, null, 2), 'utf8'); } catch {}
  }

  server.listen(port, host, () => {
    console.log('cheng-talk serve · http://' + host + ':' + port + '  （Ctrl+C 退出）');
    try { const d = discovery(); console.log('现在接 ' + d.url + ' / ' + d.sessionId); } catch {}
    写门牌();
  });
  setInterval(写门牌, 10000).unref?.();
  process.on('SIGINT', () => { console.log('\n收摊'); try { fs.unlinkSync(ENDPOINT); } catch {} server.close(); process.exit(0); });
}

try {
  if (cmd === 'status' || cmd === 'whoami') await cmdStatus();
  else if (cmd === 'serve') await cmdServe();
  else if (cmd === 'say') {
    const words = [];
    for (let i = 1; i < argv.length; i += 1) {
      const a = argv[i];
      if (a === '--timeout') { i += 1; continue; }
      if (a.startsWith('--')) continue;
      words.push(a);
    }
    await cmdSay(words.join(' '), !flag('no-wait'));
  }
  else if (cmd === 'read') await cmdRead();
  else if (cmd === 'watch') await cmdWatch();
  else if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log('用法：node cheng-talk.mjs <status|say|read|watch> [参数]');
  } else die('不认识的命令：' + cmd);
} catch (err) {
  die(err && err.message ? err.message : String(err));
}
