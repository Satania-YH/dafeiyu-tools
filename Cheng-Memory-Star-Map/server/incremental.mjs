'use strict';
/**
 * 增量引擎 —— 新记忆进来时，只算这一条，不重算全库。
 *
 * 实测：单条增量 35ms（算向量 22ms + 比 250 条余弦 12.6ms），
 * 对比全量重跑 6.8 秒，差 200 倍。
 *
 * 三个关键设计：
 *   1. 只跟已有节点比余弦，不动旧边
 *   2. 去重用归一文本 + cos>0.97（0.6 是连边阈值，不是去重阈值）
 *   3. 新节点的位置锚在「最强邻居」旁边，不随机扔
 *
 * 只读数据文件；只写我们自己的 data/ 目录。
 */

import { cleanEvent, Deduper, dot, normText } from './clean.mjs';
import { VectorStore, sha16 } from './vectors.mjs';

/* ══════════ 常量 ══════════ */

/** 连边阈值（和澄的导出脚本一致） */
export const LINK_THRESHOLD = 0.6;

/** 去重阈值（不是 0.6！） */
export const DEDUP_COS = 0.97;

/** 每个新节点最多连几条边（防止一次进来连上百条） */
export const MAX_EDGES_PER_NODE = 16;

/* ══════════ 图状态 ══════════ */

export class GraphState {
  constructor() {
    /** id → node */
    this.nodes = new Map();
    /** 邻接表：id → Set<id> */
    this.adj = new Map();
    /** 边列表 [{source, target, cos}] */
    this.edges = [];
    /** 边的索引：'a|b' → index */
    this.edgeIdx = new Map();
    /** 去重器 */
    this.deduper = new Deduper({ cosThreshold: DEDUP_COS });
    /** 向量库 */
    this.vectors = new VectorStore();
    /** 时间轴（内存里只留最近 N 天，更早的从文件读） */
    this.timeline = [];
    /** 统计 */
    this.stats = { added: 0, deduped: 0, garbled: 0, heartbeat: 0, edges: 0 };
  }

  /* ---------- 初始化 ---------- */

  /**
   * 从导出的 graph.json 载入初始状态。
   * @param {object} graph  graph.json 的内容
   * @param {object} opts   { vectorsJsonPath }
   */
  async loadFromGraph(graph, opts = {}) {
    const nodes = Array.isArray(graph) ? graph : (graph.nodes || []);
    const edges = Array.isArray(graph) ? [] : (graph.edges || []);

    /* 2026-11-24：保存导出时的 meta（含 generatedAt）。
       之前整个 meta 被丢掉，前端就不知道底图是什么时候导的，
       「底图快照 · 导出 10:00」那行提示显示不出来（澄建议要显示）。 */
    this.exportMeta = Array.isArray(graph) ? {} : (graph.meta || {});

    // 1. 载入向量
    if (opts.vectorsJsonPath) {
      this.vectors.loadAll(opts.vectorsJsonPath);
    }

    // 2. 载入节点
    const seedForDedup = [];
    for (const n of nodes) {
      const node = this._normalizeExportedNode(n);
      if (!node) continue;
      this.nodes.set(node.id, node);

      const vec = node.text ? this.vectors.get(node.text) : null;
      if (vec) seedForDedup.push({ id: node.id, text: node.text, vec });
      else if (node.text) seedForDedup.push({ id: node.id, text: node.text });

      if (!this.adj.has(node.id)) this.adj.set(node.id, new Set());
    }
    this.deduper.seed(seedForDedup);

    // 3. 载入边
    for (const e of edges) {
      this._addEdge(e.source, e.target, Number(e.cos) || 0);
    }

    return {
      nodes: this.nodes.size,
      edges: this.edges.length,
      vectors: this.vectors.size(),
    };
  }

  /**
   * 把导出的节点（澄的格式）转成内部格式。
   *
   * 澄的 graph.json 节点字段：
   *   judgment: id, kind, text, topic, ts, day, vec_dim, degree
   *   said:     id, kind, text, ts, day, vec_dim, degree
   *   insight:  id, kind, text, category, importance, eff_importance, vec_dim, degree
   *   memory:   id, kind, text, target, importance, vec_dim, degree
   *   voice:    id, kind, text, ts, day, layer, vec_dim, degree
   *
   * 注意：judgment/said/rule/voice **没有 importance**，不要编。
   */
  _normalizeExportedNode(n) {
    if (!n || !n.id) return null;
    const text = String(n.text || '').trim();
    if (!text) return null;

    const kind = String(n.kind || '');
    const out = {
      id: String(n.id),
      kind,
      kindRaw: kind,
      text,
      ts: String(n.ts || ''),
      date: n.ts ? localDateOf(n.ts) : '',
      topic: String(n.topic || ''),
      degree: Number(n.degree) || 0,
      layer: 'core',          // core | voice | stream | content
    };

    // 只有 insight / memory 有 importance，别的没有就不放
    if (n.importance != null) out.importance = Number(n.importance);
    if (n.eff_importance != null) out.effImportance = Number(n.eff_importance);
    if (n.category) out.category = String(n.category);
    if (n.target) out.target = String(n.target);

    /* 「还在等的」三类（便条/约定/作品）的状态字段。
       之前这些全被这里吃掉，前端拿到 undefined，分不出开着的和了结的。 */
    if (n.open !== undefined) out.open = !!n.open;
    if (n.due) out.due = String(n.due);
    if (n.waiting) out.waiting = String(n.waiting);
    if (n.progress !== undefined) out.progress = Number(n.progress) || 0;
    if (n.status) out.status = String(n.status);
    if (n.agreed !== undefined) out.agreed = n.agreed;
    if (n.outcome) out.outcome = String(n.outcome);
    if (n.state) out.state = String(n.state);
    if (n.title) out.title = String(n.title);
    if (n.intent) out.intent = String(n.intent);
    if (n.doneNote) out.doneNote = String(n.doneNote);
    if (n.waitOutside !== undefined) out.waitOutside = !!n.waitOutside;
    if (n.waitSelf !== undefined) out.waitSelf = !!n.waitSelf;
    if (n.superseded) out.superseded = n.superseded;
    if (n.oneSided !== undefined) out.oneSided = !!n.oneSided;
    if (n.source) out.source = String(n.source);
    if (n.statedBy) out.statedBy = String(n.statedBy);
    if (n.channel) out.channel = String(n.channel);
    if (n.sourceFile) out.sourceFile = String(n.sourceFile);

    // voice 单独一层
    if (kind === 'voice') out.layer = 'voice';

    return out;
  }

  /* ---------- 边 ---------- */

  _edgeKey(a, b) {
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  }

  _addEdge(a, b, cos) {
    if (!a || !b || a === b) return false;
    const k = this._edgeKey(a, b);
    if (this.edgeIdx.has(k)) return false;    // 已有
    this.edgeIdx.set(k, this.edges.length);
    this.edges.push({ source: a, target: b, cos });
    if (!this.adj.has(a)) this.adj.set(a, new Set());
    if (!this.adj.has(b)) this.adj.set(b, new Set());
    this.adj.get(a).add(b);
    this.adj.get(b).add(a);
    this.stats.edges++;
    return true;
  }

  /* ---------- 处理一条新事件 ---------- */

  /**
   * 处理一条原始事件。
   *
   * @param {object} rawEvent  从 events.jsonl 读到的原始对象
   * @param {{inGraph?: boolean}} opts inGraph=true 时算余弦边
   * @returns {Promise<{
   *   action: 'skip'|'dedup'|'node'|'timeline',
   *   reason?: string,
   *   node?: object,
   *   edges?: object[],
   *   timeline?: object
   * }>}
   */
  async ingest(rawEvent, opts = {}) {
    // ① 清洗
    const c = cleanEvent(rawEvent);
    if (!c) {
      // 分清是心跳还是乱码，统计用
      if (rawEvent && rawEvent.type === 'meta') this.stats.heartbeat++;
      else this.stats.garbled++;
      return { action: 'skip', reason: rawEvent?.type === 'meta' ? 'heartbeat' : 'garbled' };
    }

    // ② 分派
    const kind = c.kind;

    // meta 的内容层 → 只进时间轴
    if (kind === 'meta') {
      const item = this._toTimelineItem(c, 'content');
      this.timeline.push(item);
      return { action: 'timeline', timeline: item };
    }

    // utterance：有 topic 才进图，没有就是流水
    if (kind === 'utterance') {
      const hasTopic = !!c.topic;
      if (!hasTopic) {
        const item = this._toTimelineItem(c, 'stream');
        this.timeline.push(item);
        return { action: 'timeline', timeline: item };
      }
      // 有 topic → 当 judgment 进图
      return await this._ingestNode(c, { ...opts, inGraph: true, kind: 'judgment' });
    }

    // heard → 清洗规则由导出脚本负责（这里只做基础），进图当 said
    if (kind === 'heard') {
      return await this._ingestNode(c, { ...opts, inGraph: true, kind: 'said' });
    }

    // voice → 单独一层，默认不进图
    if (kind === 'voice') {
      const node = this._toNode(c, 'voice', 'voice');
      this.nodes.set(node.id, node);
      return { action: 'node', node, edges: [] };
    }

    // 其他（ask/answer/seed/revise/...）→ 时间轴
    const item = this._toTimelineItem(c, 'content');
    this.timeline.push(item);
    return { action: 'timeline', timeline: item };
  }

  /** 内部：把清洗后的东西变成节点并算边 */
  async _ingestNode(c, opts) {
    const kind = opts.kind || c.kind;

    // 空文本 / 沉默 不进图
    if (!c.text || c.flags?.silent) {
      return { action: 'skip', reason: 'empty' };
    }

    // 去重（先归一文本，再余弦）
    const vec = await this.vectors.embed(c.text);
    const dup = this.deduper.check({ id: c.id, text: c.text, vec: vec || undefined });
    if (dup.dup) {
      this.stats.deduped++;
      return { action: 'dedup', reason: dup.reason, of: dup.of, cos: dup.cos };
    }

    // 建节点
    const node = this._toNode(c, kind, 'core');
    this.nodes.set(node.id, node);
    this.adj.set(node.id, new Set());
    this.deduper.add({ id: node.id, text: node.text, vec: vec || undefined });
    this.stats.added++;

    // 算边：只跟已有节点比，不动旧边
    const newEdges = [];
    if (opts.inGraph && vec) {
      const cands = [];
      for (const [id, other] of this.nodes) {
        if (id === node.id) continue;
        if (other.layer === 'voice') continue;      // voice 不参与
        if (!other.text) continue;
        const ov = this.vectors.get(other.text);
        if (!ov) continue;
        const cos = dot(vec, ov);
        if (cos >= LINK_THRESHOLD) cands.push({ id, cos });
      }
      // 只留最强的 N 条
      cands.sort((a, b) => b.cos - a.cos);
      for (const { id, cos } of cands.slice(0, MAX_EDGES_PER_NODE)) {
        if (this._addEdge(node.id, id, cos)) {
          newEdges.push({ source: node.id, target: id, cos });
        }
      }
      node.degree = newEdges.length;
    }

    // 位置：锚在最强邻居旁边
    if (newEdges.length) {
      const best = newEdges[0];
      const anchor = this.nodes.get(best.target);
      if (anchor && anchor.pos) {
        const jitter = 0.05;
        node.pos = {
          x: anchor.pos.x + (Math.random() - 0.5) * jitter,
          y: anchor.pos.y + (Math.random() - 0.5) * jitter,
          z: anchor.pos.z + (Math.random() - 0.5) * jitter,
        };
        node.anchor = best.target;
      }
    }

    return { action: 'node', node, edges: newEdges };
  }

  _toNode(c, kind, layer) {
    return {
      id: c.id,
      kind,
      kindRaw: c.kind,
      text: c.text,
      raw: c.raw,
      ts: c.ts,
      date: c.date,
      topic: c.topic || '',
      source: c.source,
      layer,
      degree: 0,
      flags: c.flags || {},
      ...(c.who ? { who: c.who } : {}),
      ...(c.mentions ? { mentions: c.mentions } : {}),
      ...(c.stickers ? { stickers: c.stickers } : {}),
      ...(c.voice ? { voice: true } : {}),
      ...(c.bubbles ? { bubbles: c.bubbles } : {}),
    };
  }

  _toTimelineItem(c, layer) {
    return {
      id: c.id,
      ts: c.ts,
      date: c.date,
      kind: c.kind,
      ...(c.metaKind ? { metaKind: c.metaKind } : {}),
      text: c.text,
      raw: c.raw,
      source: c.source,
      topic: c.topic || '',
      layer,
      flags: c.flags || {},
      ...(c.who ? { who: c.who } : {}),
      ...(c.mentions ? { mentions: c.mentions } : {}),
      ...(c.stickers ? { stickers: c.stickers } : {}),
      ...(c.voice ? { voice: true } : {}),
      ...(c.bubbles ? { bubbles: c.bubbles } : {}),
    };
  }

  /* ---------- 导出给前端 ---------- */

  /** 图数据（nodes + edges），前端直接吃 */
  toGraphJSON() {
    const nodes = [];
    const kept = new Set();
    for (const n of this.nodes.values()) {
      /* 2026-11-23：原来 voice 被排除在主图外（单独走 /api/voice），
         但那个接口前端没接，等于 voice 一直没显示。
         澄明确要求 voice 要单独可见，所以放进主图，
         由前端用空心六边形和无核效果跟"她说的"区分开。 */
      kept.add(n.id);
      nodes.push({
        id: n.id,
        kind: n.kind,
        text: n.text,
        ts: n.ts,
        date: n.date,
        topic: n.topic,
        degree: n.degree,
        ...(n.importance != null ? { importance: n.importance } : {}),
        ...(n.pos ? { pos: n.pos } : {}),
        /* 「还在等的」那几类要用的字段，之前没透传，
           前端拿不到 open/due/waiting/agreed，全成了 undefined。 */
        ...(n.open != null ? { open: n.open } : {}),
        ...(n.due ? { due: n.due } : {}),
        ...(n.waiting ? { waiting: n.waiting } : {}),
        ...(n.progress != null ? { progress: n.progress } : {}),
        ...(n.status ? { status: n.status } : {}),
        ...(n.agreed !== undefined ? { agreed: n.agreed } : {}),
        ...(n.outcome ? { outcome: n.outcome } : {}),
        ...(n.state ? { state: n.state } : {}),
        ...(n.title ? { title: n.title } : {}),
        ...(n.intent ? { intent: n.intent } : {}),
        ...(n.doneNote ? { doneNote: n.doneNote } : {}),
        ...(n.waitOutside !== undefined ? { waitOutside: !!n.waitOutside } : {}),
        ...(n.waitSelf !== undefined ? { waitSelf: !!n.waitSelf } : {}),
        ...(n.superseded ? { superseded: n.superseded } : {}),
        ...(n.oneSided !== undefined ? { oneSided: !!n.oneSided } : {}),
        ...(n.source ? { source: n.source } : {}),
        ...(n.statedBy ? { statedBy: n.statedBy } : {}),
        ...(n.channel ? { channel: n.channel } : {}),
        ...(n.sourceFile ? { sourceFile: n.sourceFile } : {}),
      });
    }
    // 边必须两端都在 nodes 里，否则前端按 id 找索引会落空
    const edges = this.edges.filter(e => kept.has(e.source) && kept.has(e.target));
    return {
      nodes, edges,
      droppedEdges: this.edges.length - edges.length,
      meta: this.exportMeta || null,      // 导出时的 meta（含 generatedAt）
    };
  }

  /** voice 层 */
  voiceLayer() {
    const nodes = [];
    for (const n of this.nodes.values()) {
      if (n.layer !== 'voice') continue;
      nodes.push({ id: n.id, text: n.text, ts: n.ts, date: n.date });
    }
    return nodes;
  }

  /** 时间轴（按日期倒序） */
  timelineJSON({ limit = 0, date = null } = {}) {
    let arr = this.timeline;
    if (date) arr = arr.filter(x => x.date === date);
    // 按 ts 倒序（时间轴要按时间排，和图的「按行序」不同）
    const sorted = [...arr].sort((a, b) => {
      const ta = Date.parse(a.ts) || 0;
      const tb = Date.parse(b.ts) || 0;
      return tb - ta;
    });
    return limit ? sorted.slice(0, limit) : sorted;
  }

  /** 时间轴按天分组 */
  timelineByDay() {
    const map = new Map();
    for (const x of this.timeline) {
      const d = x.date || '未知';
      if (!map.has(d)) map.set(d, []);
      map.get(d).push(x);
    }
    const out = [];
    for (const [date, items] of map) {
      items.sort((a, b) => (Date.parse(a.ts) || 0) - (Date.parse(b.ts) || 0));
      out.push({ date, count: items.length, items });
    }
    out.sort((a, b) => b.date.localeCompare(a.date));   // 新的在前
    return out;
  }

  /** 统计 */
  summary() {
    const byKind = {};
    let core = 0, voice = 0;
    for (const n of this.nodes.values()) {
      byKind[n.kind] = (byKind[n.kind] || 0) + 1;
      if (n.layer === 'voice') voice++; else core++;
    }
    const byDay = {};
    for (const x of this.timeline) {
      byDay[x.date] = (byDay[x.date] || 0) + 1;
    }
    return {
      core,
      voice,
      timeline: this.timeline.length,
      edges: this.edges.length,
      byKind,
      byDay,
      vectors: this.vectors.status(),
      stats: { ...this.stats },
    };
  }
}

/* ══════════ 工具 ══════════ */

function localDateOf(ts) {
  const t = typeof ts === 'number' ? ts : Date.parse(ts);
  if (!Number.isFinite(t)) return '';
  return new Date(t + 8 * 3600e3).toISOString().slice(0, 10);
}
