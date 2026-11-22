
// 把「每天一次记忆整理」这类定时任务的目标会话，跟着换房一起指到新房。
// 用法: node schedule-retarget.mjs <新sessionId> [--dry]
// 原理：DSH 的 schedule 服务是内存态，改 schedule.json 不生效；只能走 RPC。
// RPC 要浏览器认证 cookie，这里用 ~/.dsh/.credentials.yaml 里的 browser-session secret 现签一个。
import fs from 'node:fs';
import path from 'node:path';
import { createHash, createHmac } from 'node:crypto';

const HOME = process.env.USERPROFILE || 'C:\\Users\\14127';
const CRED = path.join(HOME, '.dsh', '.credentials.yaml');
const DISC = path.join(HOME, '.dsh', 'fish-room.discovery.json');
const LOG = 'D:\\大肥鱼工具\\room-sync.log';

const args = process.argv.slice(2);
const newSid = args.find((a) => a.startsWith('session-')) || '';
const dry = args.includes('--dry');
const fileLog = !args.includes('--no-file-log'); // 由 room-sync.ps1 调用时它负责写日志，这里只输出

function log(msg) {
  if (fileLog) {
    const line = new Date().toLocaleString('sv-SE').replace('T', ' ') + '  sched: ' + msg;
    try { fs.appendFileSync(LOG, line + '\n', 'utf8'); } catch {}
    console.log(line);
  } else {
    console.log(msg); // 由调用方（room-sync.ps1）加时间戳和前缀写日志
  }
}

if (!newSid) { log('没给新 sessionId，跳过'); process.exit(0); }
if (!fs.existsSync(DISC)) { log('找不到 fish-room.discovery.json，跳过'); process.exit(0); }

const disc = JSON.parse(fs.readFileSync(DISC, 'utf8'));
const u = new URL(disc.url);
const authority = u.host; // 127.0.0.1:50205
const origin = u.origin;

// 从 credentials.yaml 里抠出 browser-session 的 secret（32 字节 base64url）
const yaml = fs.readFileSync(CRED, 'utf8');
const m = /client-connection\/browser-session:\s*\n(?:.*\n)*?\s*secret:\s*(\S+)/.exec(yaml);
if (!m) { log('credentials.yaml 里没找到 browser-session secret，跳过'); process.exit(0); }
const secret = Buffer.from(m[1].trim(), 'base64url');
if (secret.length !== 32) { log('secret 长度不是 32，跳过'); process.exit(0); }

const b64u = (b) => Buffer.from(b).toString('base64url');
const now = Date.now();
const payload = { version: 1, authority, issuedAt: now, expiresAt: now + 30 * 60 * 1000 };
const body = b64u(Buffer.from(JSON.stringify(payload), 'utf8'));
const cookie =
  'dsh-auth-' + b64u(createHash('sha256').update(authority).digest()) +
  '=v1.' + body + '.' + b64u(createHmac('sha256', secret).update(body).digest());

async function rpc(endpoint, reqArgs) {
  const r = await fetch(origin + '/api/' + endpoint, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'retarget-' + now, method: endpoint, payload: { args: reqArgs } }),
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(endpoint + ' 返回的不是 JSON: ' + text.slice(0, 200)); }
  if (!json.result) throw new Error(endpoint + ' 没有 result: ' + text.slice(0, 200));
  if (json.result.ok !== true) throw new Error(endpoint + ' 失败: ' + JSON.stringify(json.result.error));
  return json.result.value;
}

try {
  const listed = await rpc('schedule/list', { request: {} });
  const tasks = Array.isArray(listed.items) ? listed.items : [];
  let changed = 0;
  for (const t of tasks) {
    const tg = t.target || {};
    if (tg.kind !== 'session') continue;          // new / new_once 那种不跟房间
    if (tg.sessionId === newSid) continue;         // 已经指对了
    if (t.status !== 'active') continue;
    if (dry) { log('（试运行）' + t.id + ' 会从 ' + tg.sessionId + ' 改到 ' + newSid); continue; }
    await rpc('schedule/edit', { request: { id: t.id, action: 'update', patch: { target: { kind: 'session', sessionId: newSid } } } });
    log('改挂 ' + t.id + ' : ' + tg.sessionId + ' -> ' + newSid);
    changed += 1;
  }
  log(changed === 0 ? '定时任务已经都指在 ' + newSid + '，没动' : ('改挂完成，共 ' + changed + ' 条'));
} catch (error) {
  log('出错: ' + (error && error.message ? error.message : String(error)));
  process.exit(1);
}
