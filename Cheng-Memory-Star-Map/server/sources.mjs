'use strict';
/**
 * 数据源读取 —— events.jsonl 之外的四处内容。
 *
 * 澄确认过的字段（不要猜）：
 *
 *   works.json（{version, items}）
 *     顶层：id,title,intent,state,day,createdAt,updatedAt,finishedAt,basedOn,line,refs,versions,kind
 *     state: done（finishedAt 有值）/ wip（finishedAt=0）
 *     **用 `line` 不用 `caption`** —— line 是画完自己写的判断，caption 是画面说明
 *
 *   notes.json（裸数组，48 条）
 *     id,text,due,waiting,doneNote,created,status,reason,closedAt,revisedAt,progress
 *     status: done 16 / open 32
 *     text 平均 131 字，最长 197（工具上限 200，天生是摘要不是原话）
 *
 *   appointments.json（裸数组，1 条）
 *     id,due,time,what,created,status,notifiedAt,lateMinutes,...
 *
 *   diary/YYYY-MM-DD.md（四篇）
 *     纯段落，**没有 ## 标题**，第一行各不相同，日期只能从文件名拿
 *     home/diary-YYYY-MM-DD-夜里补记.md 是对某天的改口，不是独立一天
 *
 * 只读：这里不写任何记忆文件。
 */

import fs from 'node:fs';
import path from 'node:path';
import { P, exists } from './paths.mjs';

/* ══════════ 通用 ══════════ */

function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

/** 裸数组 or {items:[...]} 都能吃 */
function asArray(j) {
  if (Array.isArray(j)) return j;
  if (j && Array.isArray(j.items)) return j.items;
  if (j && Array.isArray(j.entries)) return j.entries;
  return [];
}

/* ══════════ works ══════════ */

/**
 * 读作品。**只取 line，不取 caption。**
 *
 * 澄的原话：
 *   「两件作品都带 line——「第二版我把她缩回自己身上」「她不是在捞什么，是在看」。
 *     那是我画完自己写的，是判断，不是描述画面；caption 才是给画面配的说明。」
 */
export function readWorks() {
  const j = readJSON(P.works);
  if (!j) return { items: [], error: '读不到 works.json' };

  const items = asArray(j).map(w => {
    const line = String(w.line || '').trim();
    if (!line) return null;
    return {
      id: String(w.id || ''),
      kind: 'work',
      text: line,                      // ← 用 line
      title: String(w.title || ''),
      intent: String(w.intent || ''),
      state: String(w.state || (w.finishedAt ? 'done' : 'wip')),
      day: String(w.day || ''),
      ts: w.finishedAt ? new Date(w.finishedAt).toISOString() : (w.createdAt ? new Date(w.createdAt).toISOString() : ''),
      date: String(w.day || ''),
      createdAt: Number(w.createdAt) || 0,
      finishedAt: Number(w.finishedAt) || 0,
      // 版本列表只留元信息，不读图片
      versions: (w.versions || []).map(v => ({
        v: Number(v.v) || 0,
        file: String(v.file || ''),
        title: String(v.title || ''),
        at: Number(v.at) || 0,
      })),
      layer: 'core',                   // 进图
      inGraph: true,
    };
  }).filter(Boolean);

  return { items, total: items.length };
}

/* ══════════ notes ══════════ */

/**
 * 读便条。**只进时间轴，不进图。**
 *
 * 澄给的四条理由：
 *   1. 便条是压缩过的摘要（text 上限 200 字），不是原话
 *   2. 文本会变（her_note update 会改），向量跟着变，节点会跳位置
 *   3. 边会全是关键词重合，不是意思相近
 *   4. 做完的便条会死（16 条已划掉），星还挂着看的人分不清
 */
export function readNotes() {
  const j = readJSON(P.notes);
  if (!j) return { items: [], error: '读不到 notes.json' };

  const items = asArray(j).map(n => {
    const text = String(n.text || '').trim();
    if (!text) return null;
    return {
      id: String(n.id || ''),
      kind: 'note',
      text,
      status: String(n.status || 'open'),        // done / open
      due: String(n.due || ''),
      waiting: String(n.waiting || ''),
      doneNote: String(n.doneNote || ''),
      reason: String(n.reason || ''),
      progress: String(n.progress || ''),
      created: Number(n.created) || 0,
      closedAt: Number(n.closedAt) || 0,
      revisedAt: Number(n.revisedAt) || 0,
      ts: n.created ? new Date(n.created).toISOString() : '',
      date: n.created ? localDateOf(n.created) : '',
      layer: 'content',                          // 只进时间轴
      inGraph: false,
    };
  }).filter(Boolean);

  const done = items.filter(x => x.status === 'done').length;
  return { items, total: items.length, done, open: items.length - done };
}

/* ══════════ appointments ══════════ */

/**
 * 读约定。**只进时间轴，不进图。**
 *
 * 澄的原话：
 *   「只有 1 条，而且它是一条时间，不是内容。
 *     它真正的价值是 status/agreed/outcome 那几个字段——「这件事我做到了没有」。"
 */
export function readAppointments() {
  const j = readJSON(P.appointments);
  if (!j) return { items: [], error: '读不到 appointments.json' };

  const items = asArray(j).map(a => {
    const what = String(a.what || a.text || '').trim();
    if (!what) return null;
    return {
      id: String(a.id || ''),
      kind: 'appointment',
      text: what,
      status: String(a.status || ''),
      agreed: a.agreed,
      outcome: String(a.outcome || ''),
      due: String(a.due || a.time || ''),
      created: Number(a.created) || 0,
      notifiedAt: Number(a.notifiedAt) || 0,
      lateMinutes: Number(a.lateMinutes) || 0,
      ts: a.created ? new Date(a.created).toISOString() : '',
      date: String(a.due || '').slice(0, 10) || (a.created ? localDateOf(a.created) : ''),
      layer: 'content',
      inGraph: false,
    };
  }).filter(Boolean);

  return { items, total: items.length };
}

/* ══════════ diary ══════════ */

/**
 * 读日记。
 *
 * 澄确认的三个事实：
 *   1. 和 utterance 零重合（728 条逐条比对，前 30 字命中 0），不需要去重
 *   2. **没有 ## 标题**，纯段落，第一行各不相同，不能当标题用
 *   3. 日期只能从文件名拿
 *
 * 还有一篇在 home/ 下：`diary-YYYY-MM-DD-夜里补记.md`，
 * 那是**对某天的改口**，不是独立的一天。挂在对应日期下面当修正。
 */
export function readDiary() {
  const entries = [];

  // ① 正常日记：diary/YYYY-MM-DD.md
  try {
    const files = fs.readdirSync(P.diaryDir).filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f));
    for (const f of files) {
      const date = f.replace(/\.md$/, '');
      const file = path.join(P.diaryDir, f);
      let text = '';
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      const clean = text.trim();
      if (!clean) continue;
      entries.push({
        id: 'diary:' + date,
        kind: 'diary',
        date,
        ts: date + 'T00:00:00.000Z',
        text: clean,
        chars: clean.length,
        bytes: Buffer.byteLength(clean, 'utf8'),
        file,
        revision: false,
        layer: 'content',
        inGraph: false,
      });
    }
  } catch {}

  // ② 补记：home/diary-YYYY-MM-DD-*.md（对某天的改口）
  try {
    const files = fs.readdirSync(P.homeDir).filter(f => /^diary-\d{4}-\d{2}-\d{2}.*\.md$/.test(f));
    for (const f of files) {
      const m = /^diary-(\d{4}-\d{2}-\d{2})/.exec(f);
      if (!m) continue;
      const date = m[1];
      const file = path.join(P.homeDir, f);
      let text = '';
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      const clean = text.trim();
      if (!clean) continue;
      entries.push({
        id: 'diary-rev:' + f.replace(/\.md$/, ''),
        kind: 'diary-revision',
        date,
        ts: date + 'T23:59:00.000Z',      // 挂在当天末尾，表示「后来补的」
        text: clean,
        chars: clean.length,
        bytes: Buffer.byteLength(clean, 'utf8'),
        file,
        revision: true,                    // ← 标记：这是改口不是新的一天
        layer: 'content',
        inGraph: false,
      });
    }
  } catch {}

  // 按日期分组，同一天的正文 + 补记放一起
  const byDate = new Map();
  for (const e of entries) {
    if (!byDate.has(e.date)) byDate.set(e.date, { date: e.date, main: null, revisions: [] });
    const slot = byDate.get(e.date);
    if (e.revision) slot.revisions.push(e);
    else slot.main = e;
  }

  const days = [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));

  return { entries, days, total: entries.length, revisionCount: entries.filter(e => e.revision).length };
}

/* ══════════ 派生状态（不算记忆） ══════════ */

/**
 * 读「她的身份.md」—— 这是 deriveSelf() 每轮重算出来的**派生状态**，
 * 不是记忆，不该进图。但可以作为「当前状态」单独展示。
 */
export function readIdentity() {
  try {
    const text = fs.readFileSync(P.identity, 'utf8');
    const stat = fs.statSync(P.identity);
    return {
      text: text.trim(),
      chars: text.length,
      bytes: stat.size,
      mtime: new Date(stat.mtimeMs).toISOString(),
      note: '派生状态，每轮重算，不是记忆',
    };
  } catch {
    return null;
  }
}

/* ══════════ 汇总 ══════════ */

/**
 * 读全部四处内容源。
 * @returns {{works, notes, appointments, diary, identity, totals}}
 */
export function readAllContent() {
  const works = readWorks();
  const notes = readNotes();
  const appointments = readAppointments();
  const diary = readDiary();
  const identity = readIdentity();

  return {
    works,
    notes,
    appointments,
    diary,
    identity,
    totals: {
      works: works.total || 0,
      notes: notes.total || 0,
      appointments: appointments.total || 0,
      diary: diary.total || 0,
      diaryDays: diary.days ? diary.days.length : 0,
    },
  };
}

/* ══════════ 工具 ══════════ */

function localDateOf(ms) {
  const t = typeof ms === 'number' ? ms : Date.parse(ms);
  if (!Number.isFinite(t)) return '';
  return new Date(t + 8 * 3600e3).toISOString().slice(0, 10);
}
