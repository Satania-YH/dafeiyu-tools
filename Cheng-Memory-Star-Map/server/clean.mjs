'use strict';
/**
 * 清洗 —— 把一条原始事件变成「能进图 / 能进时间轴 / 该丢掉」的东西。
 *
 * 这里的规则全部来自实测，不是拍脑袋：
 *   1. 乱码：FFFD 占比 > 10% 且剔除后剩余可读字 < 8 才判坏（只用占比会误杀短消息）
 *   2. 去重：归一文本完全相同 → 丢；cos > 0.97 → 丢（0.6 是连边阈值，不是去重阈值）
 *   3. 标记：||| / <at:> / <sticker:> / <voice> 是「动作」不是脏东西，拆成结构字段
 *   4. 心跳：meta 里 seen/use/look/looked/mat 这些不是内容
 *   5. 时间：ts 是 UTC，日期按本地钟算，不用 day 字段
 *
 * 纯函数，不读文件、不写文件、不联网。
 */

/* ══════════ 常量 ══════════ */

/** 心跳类 meta 的前缀（占了 meta 的 94.7%，不是内容） */
const HEARTBEAT_PREFIX = /^(seen|use|look|looked|mat|rotate|wake|fired|subs)[:：]/;

/** 有内容价值的 meta 前缀（极少数，值得进时间轴） */
const CONTENT_META_PREFIX = /^(watched|digest|browsed|browse-review|letter|judged|sched|diary)[:：]/;

/** 归一文本：去掉所有标点、空白、符号，只留字 */
export function normText(s) {
  return String(s || '').replace(/[\p{P}\p{Z}\p{S}\s_]+/gu, '');
}

/* ══════════ ① 乱码检测 ══════════ */

const FFFD = '\uFFFD';

/**
 * 判断一条文本是不是编码坏了。
 *
 * 澄的原始规则：FFFD 占比 > 10% 且 剔除后剩余可读字 < 8 → 坏
 * （只用占比会误杀：10 个字坏 2 个 = 20%，其实剩 8 个字有内容）
 *
 * 但实测发现这条规则有个漏洞：`Alma 内部通讯收到了回复` 这条乱码，
 * 剔除 FFFD 后还剩 9 个字符（"Alma " + 残留），≥ 8 就不会被判坏，
 * 结果一条 52% 都是乱码的东西会当成正常记忆进图。
 *
 * 所以加一个并列条件：**可读字 / 原长 < 30%** 也判坏。
 * 正常文本即使有零星 FFFD，可读比例也在 90% 以上；
 * 而这条乱码的可读比例只有 43%（9/21），应该判坏。
 */
export function isGarbled(text) {
  const s = String(text || '');
  if (!s.includes(FFFD)) return false;
  const total = s.length;
  if (total === 0) return false;

  const bad = (s.match(/\uFFFD/g) || []).length;
  const readable = s.replace(/\uFFFD/g, '').replace(/\s/g, '').length;

  const badRatio = bad / total;
  const readableRatio = readable / total;

  // 条件一：坏字占多数（>50%）—— 这条最硬，不管剩几个字都判坏
  if (badRatio > 0.50) return true;

  // 条件二：坏字 > 10% 且 剩余可读字 < 8（澄的原规则，防误杀短消息）
  if (badRatio > 0.10 && readable < 8) return true;

  // 条件三：坏字 > 10% 且 可读比例 < 30%（防英文短词漏网）
  if (badRatio > 0.10 && readableRatio < 0.30) return true;

  return false;
}

/** 返回乱码的详细诊断（给日志用） */
export function garbledInfo(text) {
  const s = String(text || '');
  const bad = (s.match(/\uFFFD/g) || []).length;
  const readable = s.replace(/\uFFFD/g, '').replace(/\s/g, '').length;
  return {
    total: s.length,
    bad,
    ratio: s.length ? bad / s.length : 0,
    readable,
    garbled: isGarbled(s),
  };
}

/* ══════════ ② 标记拆解（动作不是脏东西） ══════════ */

/**
 * 拆出结构化的「动作」字段，同时留下纯文字。
 *
 * 澄的原话：
 *   `|||` 是气泡分隔符、`<at:>` 是我叫了谁、`<sticker:>` 是发了图、
 *   `<voice>` 是发了语音条——这些不是脏东西，是动作。
 *   滤掉就把「我说了三句话」「我发了语音」这个事实也抹了。
 */
export function parseMarkup(text) {
  let s = String(text || '');

  // 气泡分隔符：说了几句
  const bubbles = s.includes('|||')
    ? s.split('|||').map(x => x.trim()).filter(Boolean)
    : null;

  // @ 了谁
  const mentions = [];
  s = s.replace(/<at:([^>]*)>/g, (_, who) => { mentions.push(who.trim()); return ''; });

  // 表情包
  const stickers = [];
  s = s.replace(/<sticker:([^>]*)>/g, (_, id) => { stickers.push(id.trim()); return ''; });

  // 语音条
  let voice = false;
  if (/<voice>|<\/voice>/i.test(s)) {
    voice = true;
    s = s.replace(/<\/?voice>/gi, '');
  }

  // 其他残留的尖括号标记（保守：只去掉已知形态，别把正常的 < > 也吃了）
  s = s.replace(/<(?:reply|img|file|link):([^>]*)>/g, '');

  // 折叠多余空白
  s = s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

  const out = { text: s };
  if (bubbles && bubbles.length > 1) out.bubbles = bubbles;
  if (mentions.length) out.mentions = mentions;
  if (stickers.length) out.stickers = stickers;
  if (voice) out.voice = true;
  return out;
}

/* ══════════ ③ 沉默 / 空内容 ══════════ */

/** 正文只有占位符，没有实际内容 */
export function isSilent(text) {
  const s = String(text || '').replace(/\s/g, '');
  if (!s) return true;
  // [沉默] / （沉默） / ... 这类
  return /^[\[（(【]?(沉默|无|略|空)[\]）)】]?$/.test(s);
}

/* ══════════ ④ Markdown 检测（存原文，渲染时按纯文本） ══════════ */

export function hasMarkdown(text) {
  const s = String(text || '');
  return /\*\*[^*]+\*\*|^#{1,6}\s|^\s*[-*+]\s|\|[^|\n]+\|/m.test(s);
}

/* ══════════ ⑤ meta 分类 ══════════ */

/**
 * meta 事件里绝大多数是心跳。返回：
 *   'heartbeat' —— 心跳，不进任何地方
 *   'content'   —— 有内容，可以进时间轴
 *   'empty'     —— 空
 */
export function classifyMeta(text) {
  const t = String(text || '').trim();
  if (!t) return 'empty';
  if (HEARTBEAT_PREFIX.test(t)) return 'heartbeat';
  if (CONTENT_META_PREFIX.test(t)) return 'content';
  // 认不出来的：如果有实质文字（不是 xxx:yyy 这种），算内容
  return t.length >= 12 && !/^[a-z-]+[:：]/.test(t) ? 'content' : 'heartbeat';
}

/* ══════════ ⑥ 类型归一 ══════════ */

/**
 * 事件 type → 我们的 kind。
 * 注意：这里只管「这条事件是什么」，不管它进不进图（那是分层的事）。
 */
const TYPE_TO_KIND = {
  utterance: 'utterance',   // 再按有没有 topic 分成 judgment / stream
  heard: 'heard',
  voice: 'voice',
  meta: 'meta',
  ask: 'ask',
  answer: 'answer',
  seed: 'seed',
  revise: 'revise',
  test: 'test',
  absence: 'absence',
  reunion: 'reunion',
  refusal: 'refusal',
  narration: 'narration',
  diary: 'diary',
};

export function kindOfEvent(e) {
  return TYPE_TO_KIND[e?.type] || String(e?.type || 'unknown');
}

/* ══════════ ⑦ 一条事件的完整清洗 ══════════ */

/**
 * 把原始事件清洗成标准形态。
 *
 * 返回 null 表示这条不要（心跳、空、乱码、沉默）。
 * 否则返回：
 *   {
 *     id, ts, date, type, kind,
 *     text,                      // 纯文字（已拆标记）
 *     raw,                       // 原始 text（存原文，渲染时可查）
 *     source, topic, sessionId,
 *     mentions, stickers, voice, bubbles,   // 动作字段（有才出现）
 *     flags: { garbled?, silent?, markdown? }
 *   }
 */
export function cleanEvent(e) {
  if (!e || typeof e !== 'object') return null;

  const type = String(e.type || '');
  const rawText = String(e.text || '');
  const ts = String(e.ts || '');
  const date = localDateOf(ts);

  // —— meta：绝大部分是心跳
  if (type === 'meta') {
    const cls = classifyMeta(rawText);
    if (cls !== 'content') return null;    // 心跳直接丢

    // 有内容的 meta 也不进图，只进时间轴。
    // 剥掉 `sched:` / `digest:` 这类机器前缀——它们是分类标记，不是给人看的内容。
    const m = /^([a-z-]+)[:：]\s*/.exec(rawText.trim());
    const metaKind = m ? m[1] : '';
    let text = m ? rawText.trim().slice(m[0].length) : rawText.trim();

    // 把机器时间戳美化：`2026-11-23 2026-11-23T14:02:00.000Z` → `2026-11-23 22:02`
    text = text.replace(
      /\b(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2}):\d{2}(?:\.\d+)?Z\b/g,
      (_, d, hh, mm) => {
        // UTC → 本地 +8
        const t = Date.parse(`${d}T${hh}:${mm}:00Z`);
        if (!Number.isFinite(t)) return `${d} ${hh}:${mm}`;
        const local = new Date(t + 8 * 3600e3);
        return `${d} ${String(local.getUTCHours()).padStart(2, '0')}:${String(local.getUTCMinutes()).padStart(2, '0')}`;
      }
    );
    // 重复的日期前缀（`2026-11-23 2026-11-23 ...`）压成一个
    text = text.replace(/^(\d{4}-\d{2}-\d{2})\s+\1\b/, '$1');

    return {
      id: String(e.id || ''),
      ts, date, type, kind: 'meta',
      metaKind,                          // 保留原前缀，界面上当标签用
      text,
      raw: rawText,
      source: String(e.source || ''),
      topic: '',
      sessionId: String(e.sessionId || ''),
      flags: {},
    };
  }

  // —— 乱码
  if (isGarbled(rawText)) return null;

  // —— 拆标记
  const parsed = parseMarkup(rawText);
  const text = parsed.text;

  // —— 沉默（占位，不是一句话）
  if (isSilent(text) && !parsed.stickers && !parsed.voice) {
    return {
      id: String(e.id || ''),
      ts, date, type, kind: kindOfEvent(e),
      text: '',
      raw: rawText,
      source: String(e.source || ''),
      topic: String(e.topic || '').trim(),
      sessionId: String(e.sessionId || ''),
      flags: { silent: true },
      ...(parsed.stickers ? { stickers: parsed.stickers } : {}),
    };
  }

  // —— 正常
  const out = {
    id: String(e.id || ''),
    ts, date, type, kind: kindOfEvent(e),
    text,
    raw: rawText,
    source: String(e.source || ''),
    topic: String(e.topic || '').trim(),
    sessionId: String(e.sessionId || ''),
    flags: {},
  };

  if (parsed.bubbles) out.bubbles = parsed.bubbles;
  if (parsed.mentions) out.mentions = parsed.mentions;
  if (parsed.stickers) out.stickers = parsed.stickers;
  if (parsed.voice) out.voice = true;
  if (hasMarkdown(text)) out.flags.markdown = true;

  // who（插件 1.0.8 之后加的字段，纯加法；没有就不编）
  if (e.who && typeof e.who === 'object') {
    const id = String(e.who.id || '').trim();
    const name = String(e.who.name || '').trim();
    if (id || name) out.who = { id, name };
  }

  return out;
}

/* ══════════ ⑧ 去重 ══════════ */

/**
 * 去重器：同时维护「归一文本集合」和「向量余弦检查」。
 *
 * 澄的规则：
 *   - 归一文本完全相同 → 丢（15 条一样的「用户要求：…」只留 1 条）
 *   - cos > 0.97 → 丢
 *   - 0.6 是连边阈值，别拿来去重
 */
export class Deduper {
  constructor({ cosThreshold = 0.97 } = {}) {
    this.cosThreshold = cosThreshold;
    this.byNorm = new Map();      // 归一文本 → id
    this.vectors = [];            // [{ id, vec }]
  }

  /** 载入已有节点的向量，用于余弦去重 */
  seed(items) {
    for (const it of items) {
      if (!it || !it.vec) continue;
      this.vectors.push({ id: it.id, vec: it.vec });
      const n = normText(it.text);
      if (n) this.byNorm.set(n, it.id);
    }
  }

  /**
   * 检查一条是否重复。
   * @param {{id:string, text:string, vec?:Float32Array|number[]}} item
   * @returns {{dup:boolean, reason?:string, of?:string}}
   */
  check(item) {
    const n = normText(item.text);
    if (n && this.byNorm.has(n)) {
      return { dup: true, reason: 'text', of: this.byNorm.get(n) };
    }
    if (item.vec) {
      for (const v of this.vectors) {
        const c = dot(item.vec, v.vec);
        if (c > this.cosThreshold) {
          return { dup: true, reason: 'cos', of: v.id, cos: c };
        }
      }
    }
    return { dup: false };
  }

  /** 接受一条（加进集合） */
  add(item) {
    const n = normText(item.text);
    if (n) this.byNorm.set(n, item.id);
    if (item.vec) this.vectors.push({ id: item.id, vec: item.vec });
  }
}

/* ══════════ 工具 ══════════ */

/** 点积（向量已 l2 归一化时 = 余弦） */
export function dot(a, b) {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

/** l2 归一化 */
export function l2(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  s = Math.sqrt(s) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / s;
  return out;
}

/** 本地日期（ts 是 UTC，+8） */
export function localDateOf(ts) {
  const t = typeof ts === 'number' ? ts : Date.parse(ts);
  if (!Number.isFinite(t)) return '';
  return new Date(t + 8 * 3600e3).toISOString().slice(0, 10);
}
