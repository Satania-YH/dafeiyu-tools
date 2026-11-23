'use strict';
/**
 * 插件变化检测 —— 两层，分工不重叠。
 *
 * 这是澄设计的。我原来想「算 schema.js 的 hash」或「挑两个稳定字段当指纹」，
 * 两个都错：
 *   - hash 会因注释变化误报
 *   - 挑最稳定的字段当变化检测器，等于把检测废掉
 *     （ALL_TYPES 和 FLAGS 恰好是三版里唯一没变的两个，WHO_TYPES 加了三个常量完全无感）
 *
 * 第一层：指纹 = 所有 export 常量的「名字 + 值」
 *   抓的是「定义变了」——加常量、改常量值、改枚举
 *
 * 第二层：字段清单 = 数据里实际出现的字段集合
 *   抓的是「数据形状变了」——代码没变但事件里多了字段（比如 who）
 *
 * 第二层的盲区：ALL_TYPES 新加了 'dream'，但库里一条 dream 都没有，
 * 字段清单根本看不见 —— 只有第一层能抓到。
 *
 * 所以两层都要，报警时分开说，别混成一条。
 *
 * 只读 schema.js；只写我们自己的 data/schema-fingerprint.json。
 */

import fs from 'node:fs';
import path from 'node:path';
import { P, RUNTIME, exists, ensureDir } from './paths.mjs';

/* ══════════ 第一层：指纹 ══════════ */

/** 我们要盯的常量名（其余忽略） */
const WATCHED = [
  'HER_TYPES', 'ALL_TYPES', 'EVENT_SCHEMA_VERSION',
  'SCENES', 'HUMAN_SCENES',
  'WHO_TYPES', 'WHO_NAME_MAX', 'WHO_ID_MAX',
  'FLAGS',
];

/** 上限类常量：放宽是提示，收紧是拒绝 */
const LIMIT_NAMES = new Set(['WHO_NAME_MAX', 'WHO_ID_MAX']);

/** 枚举类常量：加值是提示，减值是拒绝 */
const ENUM_NAMES = new Set(['HER_TYPES', 'ALL_TYPES', 'SCENES', 'HUMAN_SCENES', 'WHO_TYPES', 'FLAGS']);

/**
 * 从 schema.js 抽指纹。
 *
 * 不用 eval/import —— 直接正则抽文本，避免执行插件代码。
 * 只处理 `export const NAME = <literal>` 这种形态。
 */
export function extractFingerprint(schemaPath = path.join(P.pluginDir, 'lib', 'schema.js')) {
  if (!exists(schemaPath)) {
    return { ok: false, error: `找不到 ${schemaPath}`, values: {} };
  }

  let src;
  try { src = fs.readFileSync(schemaPath, 'utf8'); } catch (e) {
    return { ok: false, error: e.message, values: {} };
  }

  const values = {};
  for (const name of WATCHED) {
    const v = extractConst(src, name);
    if (v !== undefined) values[name] = v;
  }

  return {
    ok: true,
    path: schemaPath,
    bytes: Buffer.byteLength(src, 'utf8'),
    values,
    at: new Date().toISOString(),
  };
}

/**
 * 抽一个常量的值。
 * 支持：
 *   export const X = Object.freeze([...])
 *   export const X = [...]
 *   export const X = 40
 *   export const X = 'abc'
 *   export const X = true
 */
function extractConst(src, name) {
  // 数组形态
  const arrRe = new RegExp(`export\\s+const\\s+${name}\\s*=\\s*(?:Object\\.freeze\\()?\\s*\\[`, 'm');
  const am = arrRe.exec(src);
  if (am) {
    const start = src.indexOf('[', am.index);
    const end = matchBracket(src, start);
    if (end < 0) return undefined;
    const inner = src.slice(start + 1, end);
    const items = [];
    // 只抽字符串字面量（数组里可能夹注释）
    const itemRe = /(['"])((?:\\.|(?!\1)[^\\])*)\1/g;
    let m;
    while ((m = itemRe.exec(inner))) {
      items.push(m[2].replace(/\\(['"\\])/g, '$1'));
    }
    return items;
  }

  // 数字 / 字符串 / 布尔
  const litRe = new RegExp(`export\\s+const\\s+${name}\\s*=\\s*([^\\n;]+)`, 'm');
  const lm = litRe.exec(src);
  if (lm) {
    const raw = lm[1].trim().replace(/\/\/.*$/, '').trim();
    if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    const sm = /^(['"])((?:\\.|(?!\1)[^\\])*)\1$/.exec(raw);
    if (sm) return sm[2];
    return raw;    // 表达式，原样留
  }

  return undefined;
}

/** 找匹配的右方括号（跳过字符串和注释） */
function matchBracket(src, start) {
  let depth = 0, i = start, inStr = null, inLine = false, inBlock = false;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (inLine) { if (c === '\n') inLine = false; i++; continue; }
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i += 2; continue; } i++; continue; }
    if (inStr) {
      if (c === '\\') { i += 2; continue; }
      if (c === inStr) inStr = null;
      i++; continue;
    }
    if (c === '/' && n === '/') { inLine = true; i += 2; continue; }
    if (c === '/' && n === '*') { inBlock = true; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; i++; continue; }
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) return i; }
    i++;
  }
  return -1;
}

/* ══════════ 对比两版指纹 ══════════ */

/**
 * 对比新旧指纹。
 *
 * @returns {{
 *   changes: Array<{name, type, before, after, severity, message}>,
 *   verdict: 'same'|'additive'|'breaking'
 * }}
 *
 * severity:
 *   'info'     —— 加法，照常运行
 *   'warn'     —— 收紧/减少，拒绝增量，要求重导
 */
export function diffFingerprint(before, after) {
  const changes = [];
  if (!before || !before.values) {
    return { changes: [], verdict: 'same', note: '没有旧指纹，这是第一次' };
  }

  const b = before.values || {};
  const a = after.values || {};
  const names = new Set([...Object.keys(b), ...Object.keys(a)]);

  for (const name of names) {
    const hasB = Object.prototype.hasOwnProperty.call(b, name);
    const hasA = Object.prototype.hasOwnProperty.call(a, name);

    // 新增常量
    if (!hasB && hasA) {
      changes.push({
        name, type: 'added', after: a[name], severity: 'info',
        message: `新增常量 ${name} = ${fmt(a[name])}`,
      });
      continue;
    }

    // 删除常量
    if (hasB && !hasA) {
      changes.push({
        name, type: 'removed', before: b[name], severity: 'warn',
        message: `常量 ${name} 不见了（原来 = ${fmt(b[name])}）`,
      });
      continue;
    }

    // 值变了
    const vb = b[name], va = a[name];

    if (LIMIT_NAMES.has(name) && typeof vb === 'number' && typeof va === 'number') {
      if (va > vb) {
        changes.push({
          name, type: 'relaxed', before: vb, after: va, severity: 'info',
          message: `${name} 放宽：${vb} → ${va}`,
        });
      } else if (va < vb) {
        changes.push({
          name, type: 'tightened', before: vb, after: va, severity: 'warn',
          message: `${name} 收紧：${vb} → ${va}（已有数据可能被截断）`,
        });
      }
      continue;
    }

    if (ENUM_NAMES.has(name) && Array.isArray(vb) && Array.isArray(va)) {
      const added = va.filter(x => !vb.includes(x));
      const removed = vb.filter(x => !va.includes(x));
      if (added.length) {
        changes.push({
          name, type: 'enum-added', added, severity: 'info',
          message: `${name} 加了：${added.join(', ')}`,
        });
      }
      if (removed.length) {
        changes.push({
          name, type: 'enum-removed', removed, severity: 'warn',
          message: `${name} 去掉了：${removed.join(', ')}（旧数据里的这类会变成未知）`,
        });
      }
      continue;
    }

    // 其他值变化
    if (JSON.stringify(vb) !== JSON.stringify(va)) {
      changes.push({
        name, type: 'changed', before: vb, after: va, severity: 'info',
        message: `${name} 变了：${fmt(vb)} → ${fmt(va)}`,
      });
    }
  }

  const verdict = changes.some(c => c.severity === 'warn') ? 'breaking'
    : changes.length ? 'additive'
    : 'same';

  return { changes, verdict };
}

function fmt(v) {
  if (Array.isArray(v)) return `[${v.length} 项]`;
  return String(v);
}

/* ══════════ 第二层：字段清单 ══════════ */

/**
 * 扫一批事件，记录「每个 type 出现了哪些字段」。
 *
 * 这抓的是「代码没变但数据形状变了」——比如 who 这种先出现在事件里的字段。
 *
 * @param {object[]} events
 * @returns {{byType: Object<string,string[]>, all: string[], count: number}}
 */
export function fieldInventory(events) {
  const byType = {};
  const all = new Set();
  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
    const t = String(e.type || 'unknown');
    if (!byType[t]) byType[t] = new Set();
    for (const k of Object.keys(e)) {
      byType[t].add(k);
      all.add(k);
    }
  }
  const out = {};
  for (const t of Object.keys(byType).sort()) {
    out[t] = [...byType[t]].sort();
  }
  return { byType: out, all: [...all].sort(), count: events.length };
}

/**
 * 对比两次字段清单。
 *
 * @returns {{added: object, removed: object, changed: boolean}}
 */
export function diffInventory(before, after) {
  const added = {};     // type → 新字段
  const removed = {};

  if (!before || !before.byType) return { added, removed, changed: false, note: '没有旧清单' };

  const types = new Set([...Object.keys(before.byType || {}), ...Object.keys(after.byType || {})]);
  for (const t of types) {
    const b = new Set(before.byType[t] || []);
    const a = new Set(after.byType[t] || []);
    const add = [...a].filter(x => !b.has(x));
    const rem = [...b].filter(x => !a.has(x));
    if (add.length) added[t] = add;
    if (rem.length) removed[t] = rem;
  }

  return {
    added,
    removed,
    changed: Object.keys(added).length > 0 || Object.keys(removed).length > 0,
  };
}

/* ══════════ 持久化 ══════════ */

export function loadSaved() {
  try {
    return JSON.parse(fs.readFileSync(RUNTIME.schemaFingerprint, 'utf8'));
  } catch {
    return null;
  }
}

export function saveSnapshot(fp, inv) {
  try {
    ensureDir(RUNTIME.data);
    fs.writeFileSync(RUNTIME.schemaFingerprint, JSON.stringify({
      fingerprint: fp,
      inventory: inv,
      savedAt: new Date().toISOString(),
    }, null, 1), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/* ══════════ 一次完整检查 ══════════ */

/**
 * 跑一次完整的两层检查。
 *
 * @param {object[]} events  当前事件（用于字段清单）
 * @returns {{
 *   fingerprint: object, inventory: object,
 *   fpDiff: object, invDiff: object,
 *   verdict: 'same'|'additive'|'breaking',
 *   messages: string[]
 * }}
 */
export function check(events = []) {
  const fp = extractFingerprint();
  const inv = fieldInventory(events);
  const saved = loadSaved();

  const fpDiff = fp.ok
    ? diffFingerprint(saved?.fingerprint, fp)
    : { changes: [], verdict: 'same', error: fp.error };

  const invDiff = diffInventory(saved?.inventory, inv);

  // 汇总判断：任一层 breaking 就整体 breaking
  let verdict = fpDiff.verdict;
  if (verdict !== 'breaking' && invDiff.changed) {
    // 字段增减只算 additive（不阻止运行），但要提示
    if (verdict === 'same') verdict = 'additive';
  }

  // 消息分开写，不混成一条
  const messages = [];
  if (fpDiff.changes && fpDiff.changes.length) {
    messages.push('【定义层】' + fpDiff.changes.map(c => c.message).join('；'));
  }
  if (invDiff.changed) {
    const parts = [];
    for (const [t, fs_] of Object.entries(invDiff.added)) parts.push(`${t} 新增字段 ${fs_.join('/')}`);
    for (const [t, fs_] of Object.entries(invDiff.removed)) parts.push(`${t} 少了字段 ${fs_.join('/')}`);
    messages.push('【数据层】' + parts.join('；'));
  }
  if (!messages.length) messages.push('没有变化');

  return {
    fingerprint: fp,
    inventory: inv,
    fpDiff,
    invDiff,
    verdict,
    messages,
    firstRun: !saved,
  };
}
