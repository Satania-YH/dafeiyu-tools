'use strict';
/**
 * 路径解析 —— 所有外部路径都从这里拿，不散落在各处。
 *
 * 澄的记忆根目录不是写死的：插件搬过家（C:\.dsh-fish → D:\dsh-fish-home），
 * 位置记在 ~/.dsh-fish-location.json 的 root 字段里。这里读那个文件，
 * 读不到才退回默认值。
 *
 * 只读：这里只做路径拼接和存在性检查，不写任何文件。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HOME = os.homedir();

/* ══════════ 澄的记忆根目录 ══════════ */

const LOCATION_FILE = path.join(HOME, '.dsh-fish-location.json');

/** 从 location 文件读 root；读不到返回 null */
function readRootFromLocation() {
  try {
    const j = JSON.parse(fs.readFileSync(LOCATION_FILE, 'utf8'));
    const root = String(j.root || '').trim();
    return root || null;
  } catch {
    return null;
  }
}

/** 记忆根目录（events.jsonl / notes.json / diary/ 都在它下面） */
export const FISH_ROOT = (() => {
  const fromFile = readRootFromLocation();
  if (fromFile && fs.existsSync(fromFile)) return fromFile;

  // 兜底：试几个常见位置
  const candidates = [
    path.join(HOME, '.dsh-fish'),
    'D:/dsh-fish-home/dsh-fish',
    path.join(HOME, '.dsh', 'fish-home'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'events.jsonl'))) return c;
  }
  // 都不在就返回第一个候选，让上层报错时能给出个具体路径
  return candidates[0];
})();

/* ══════════ 六个数据文件 ══════════ */

export const P = {
  /** 事件流（主数据，只追加） */
  events: path.join(FISH_ROOT, 'events.jsonl'),
  /** 便条（裸数组） */
  notes: path.join(FISH_ROOT, 'notes.json'),
  /** 作品（{version, items}） */
  works: path.join(FISH_ROOT, 'works.json'),
  /** 约定（裸数组） */
  appointments: path.join(FISH_ROOT, 'appointments.json'),
  /** 日记目录（2026-11-20.md 这种） */
  diaryDir: path.join(FISH_ROOT, 'diary'),
  /** 派生状态（每轮重写，不算记忆） */
  identity: path.join(FISH_ROOT, 'home', '她的身份.md'),
  /** 日记的补记（在 home/ 下，不是独立一天） */
  homeDir: path.join(FISH_ROOT, 'home'),

  /** Mnemon 长期记忆库 */
  mnemonDb: path.join(HOME, '.mnemon', 'data', 'default', 'mnemon.db'),
  /** Mnemon 常驻记忆 */
  memories: path.join(HOME, '.mnemon', 'runtime', 'memories.json'),

  /** 澄的插件目录（读 schema.js 做变化检测） */
  pluginDir: path.join(HOME, '.dsh', 'profiles', 'desktop', 'node_modules', '@ssamurias', 'dsh-fish'),
};

/* ══════════ 本项目的运行时目录 ══════════ */

export const RUNTIME = {
  // 用 fileURLToPath 而不是 new URL().pathname —— 后者会把中文编码成 %E5%A4%A7
  root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  get data() { return path.join(this.root, 'data'); },
  get dataSources() { return path.join(this.root, 'data-sources'); },
  get app() { return path.join(this.root, 'app'); },

  /** 时间轴存储（按天分文件） */
  get timelineDir() { return path.join(this.data, 'timeline'); },
  /** 向量缓存 */
  get vectorCache() { return path.join(this.data, 'vector-cache.json'); },
  /** schema 指纹 */
  get schemaFingerprint() { return path.join(this.data, 'schema-fingerprint.json'); },
  /** 增量状态（读到哪里了） */
  get watchState() { return path.join(this.data, 'watch-state.json'); },
};

/* ══════════ 工具 ══════════ */

/** 文件在不在 */
export function exists(p) {
  try { fs.accessSync(p, fs.constants.F_OK); return true; } catch { return false; }
}

/** 文件大小 + 修改时间；不存在返回 null */
export function statOf(p) {
  try {
    const s = fs.statSync(p);
    return { size: s.size, mtimeMs: s.mtimeMs, ino: s.ino, isFile: s.isFile() };
  } catch {
    return null;
  }
}

/** 确保目录存在（只用于我们自己的 data/，不碰记忆目录） */
export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** 本地日期字符串 YYYY-MM-DD（ts 是 UTC，这里转本地钟） */
export function localDateOf(ts) {
  const t = typeof ts === 'number' ? ts : Date.parse(ts);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t + 8 * 3600e3);   // 固定 +8，与澄的作息一致
  return d.toISOString().slice(0, 10);
}

/** 启动时打印一遍路径，方便排查「为什么读不到」 */
export function describePaths() {
  const lines = [];
  const mark = (ok) => (ok ? '✅' : '❌');
  lines.push(`记忆根目录：${FISH_ROOT}`);
  for (const [name, p] of Object.entries(P)) {
    if (name === 'diaryDir' || name === 'homeDir') continue;
    lines.push(`  ${mark(exists(p))} ${name.padEnd(12)} ${p}`);
  }
  // 日记目录单独列（看有几篇）
  try {
    const files = fs.readdirSync(P.diaryDir).filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f));
    lines.push(`  ✅ ${'diary'.padEnd(12)} ${P.diaryDir}  (${files.length} 篇)`);
  } catch {
    lines.push(`  ❌ ${'diary'.padEnd(12)} ${P.diaryDir}`);
  }
  return lines.join('\n');
}
