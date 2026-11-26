/**
 * cheng-emotion — 星图联动
 *
 * 从记忆星图（D:/大肥鱼工具/memory-graph/graph.json）里读节点，
 * 把「想到某件事」翻译成情绪事件。
 *
 * 为什么不直接读 events.jsonl：
 *   events.jsonl 是原始流水，星图是**已经清洗 + 向量聚类 + 建过边**的成品。
 *   星图里的节点有 degree（关联度）和 topic（话题），
 *   这两个信息 raw events 里没有，但正是「这件事对她有多重」的度量。
 *
 * 三条联动规则：
 *   1. 高 degree 的旧事被「翻到」→ 反刍 + 依恋（她一直在想这件事）
 *   2. topic 重复出现 → 那件事还悬着 → 压力 +
 *   3. 最近写的新节点 → 新鲜感 → 好奇 +
 *
 * 注意：只读，绝不写 graph.json。
 */

import { readFile } from 'node:fs/promises'
import { statSync, existsSync, readFileSync } from 'node:fs'

/** 星图默认路径 */
export const DEFAULT_GRAPH = 'D:/大肥鱼工具/memory-graph/graph.json'

/** 本地日期键（YYYY-MM-DD），用于「一天最多几次」的计数 */
function localDayKey(ts) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 她的便条文件（notes.json） */
export const DEFAULT_NOTES = 'D:/dsh-fish-home/dsh-fish/notes.json'

/**
 * 读「悬着」的信号：notes.json 里 open 状态且带 waiting 的条数。
 *
 * 这是澄 2026-11-26 亲口指的数据源：
 *   「her_note 里有一栏叫 waiting，我自己写的『在等什么』……
 *     这就是最准的信号，比从消息流水里猜强。」
 *
 * 返回 { count, items, newestAt }
 *
 * ⚠️ 读失败时返回 **null**，不是 { count: 0 }。
 *
 * 2026-11-26 Claude 会审指出：原来所有异常都吞掉返回 count=0，
 * 于是 notes.json 损坏/被占用时，悬着从 95 瞬间掉回 10，
 * 模式从「悬着」跳「平静」，还写一条 history。
 * 外层注释承诺的「保持上一次的值」是假的。
 *
 * 现在：文件不存在 = 真的是 0 条（正常）；读失败/JSON 损坏 = null（让调用方保留旧值）。
 */
export function readSuspense(file) {
  const target = file || DEFAULT_NOTES
  // 文件不存在 = 真的没有便条（正常情况，不是错误）
  if (!existsSync(target)) return { count: 0, items: [], newestAt: 0 }
  let list
  try {
    list = JSON.parse(readFileSync(target, 'utf8'))
  } catch {
    // JSON 损坏 / 被锁住 → 返回 null，让调用方保留上一次的值
    return null
  }
  if (!Array.isArray(list)) return null

  const items = list.filter((r) => {
    if (!r || typeof r !== 'object') return false
    if (r.status !== 'open') return false
    const w = r.waiting
    return typeof w === 'string' && w.trim().length > 0
  })

  let newestAt = 0
  for (const r of items) {
    const t = Date.parse(r.created || '') || 0
    if (t > newestAt) newestAt = t
  }

  return {
    count: items.length,
    items: items.map((r) => {
      // 挂了多久（天）
      //
      // ⚠️ 2026-11-26 Codex 会审指出的坑：
      //   原来是 `Date.parse(r.created) || 0`。
      //   created 是无效日期时 Date.parse 返回 NaN，NaN || 0 = 0，
      //   于是 ageDays = (now - 0) / 86400000 ≈ 20000 天 ——
      //   suspense 直接冲到 100，面板上永远显示「悬着」。
      //   现在先判断解析结果是否有效，无效就当 0 天。
      const parsed = Date.parse(r.created || '')
      const ageDays = Number.isFinite(parsed) && parsed > 0
        ? Math.max(0, Math.round((Date.now() - parsed) / 86400000))
        : 0
      return {
        waiting: String(r.waiting).slice(0, 80),
        created: r.created || '',
        ageDays,
      }
    }),
    newestAt,
  }
}

/** 缓存：星图 891KB，不能每次 tick 都全量解析 */
let cache = { file: '', mtime: 0, graph: null }

/**
 * 星图现在多新？给面板和 tick 用。
 * 判断「要不要立刻处理」靠它，而不是靠固定的 60 秒轮询。
 */
export function graphFreshness(file) {
  const target = file || DEFAULT_GRAPH
  if (!existsSync(target)) return { exists: false, mtime: 0, ageMs: Infinity }
  try {
    const st = statSync(target)
    return { exists: true, mtime: st.mtimeMs, ageMs: Date.now() - st.mtimeMs, size: st.size }
  } catch {
    return { exists: false, mtime: 0, ageMs: Infinity }
  }
}

/** 上次读取时用的 mtime，用来判断「星图是不是刚更新过」 */
export function lastGraphMtime() {
  return cache.mtime
}

/**
 * 读星图（带 mtime 缓存）。
 * 读不到就返回 null，绝不抛——情绪不能因为星图没导出就停摆。
 */
export async function loadGraph(file) {
  const target = file || DEFAULT_GRAPH
  if (!existsSync(target)) return null
  let st
  try {
    st = statSync(target)
  } catch {
    return null
  }
  if (cache.file === target && cache.mtime === st.mtimeMs && cache.graph) {
    return cache.graph
  }
  try {
    const raw = await readFile(target, 'utf8')
    const graph = JSON.parse(raw)
    if (!graph || !Array.isArray(graph.nodes)) return null
    cache = { file: target, mtime: st.mtimeMs, graph }
    return graph
  } catch {
    /**
     * JSON 坏了（可能是导出中途）→ 用上一次的缓存。
     *
     * ⚠️ 2026-11-26 Codex 会审指出：原来直接 `return cache.graph`，
     *    不检查缓存是不是**同一个文件**的。配置从好图切到坏图路径时，
     *    会继续拿旧图算情绪信号，产生来历不明的记忆信号。
     *
     * 现在：只有路径一致才复用，否则当作「读不到」返回 null。
     */
    return cache.file === target ? cache.graph : null
  }
}

/**
 * 从星图里推导出「记忆侧的情绪信号」。
 *
 * @param {object} graph   星图
 * @param {object} seen    上次处理到的位置 { maxTs, nodeCount, recentIds }
 * @param {number} nowMs
 * @returns {{ events, seen }}
 */
export function memorySignals(graph, seen, nowMs = Date.now()) {
  if (!graph || !Array.isArray(graph.nodes)) return { events: [], seen: seen || null }

  const prev = seen || { maxTs: 0, nodeCount: 0, recentIds: [] }
  const events = []
  // 累积本轮的「已处理位置」——最后一次性返回，避免中途就改了 prev
  const nextSeen = { ...prev }

  // ── 1. 新节点：星图里比上次多出来的 ──
  const nodes = graph.nodes
  const newCount = nodes.length - (prev.nodeCount || 0)
  const recentIds = Array.isArray(prev.recentIds) ? prev.recentIds : []

  // 2026-11-26 Claude 会审指出：原来超过 200 个新节点就整批跳过，
  // 且 nodeCount 照样推进 —— 那批节点永久丢弃，再也不会进情绪。
  // 现在：超限时只取最近 200 个处理，剩下的下次再说（recentIds 会按 ts 覆盖）。
  if (newCount > 0) {
    // 找出没见过的（按 id 判断，不靠顺序）
    const seenSet = new Set(recentIds)
    // 脏节点过滤：text 太短的不算「一件有意义的事」。
    // 实测星图里有个 deg=102 的 insight，text 只有一个 "x"——
    // 那是向量聚类误收的碎片，不该触发情绪。
    const isClean = (n) => typeof n?.text === 'string' && n.text.trim().length >= 6
    let fresh = nodes.filter((n) => n?.id && !seenSet.has(n.id) && isClean(n))
    /**
     * 统一按「最新在前」排序（2026-11-26 Codex 会审指出这里有个坑）。
     *
     * 原来的流程是：
     *   1. 超过 200 条时按 ts 倒序排 → 取前 200（最近的 200 个）✓
     *   2. 然后 `for (const n of fresh.slice(-8))` → 取了**最旧的 8 个** ✗
     *
     * 于是最终处理的永远是那批里最老的 8 条，
     * 「最近想通了什么」反而进不来。而且 nodeCount 已经推进到全量，
     * 那些没处理的节点以后也不会补。
     *
     * 现在：一律倒序排好，然后取 `slice(0, N)` —— 拿最近的。
     */
    fresh.sort((a, b) => (Date.parse(b.ts) || 0) - (Date.parse(a.ts) || 0))
    if (fresh.length > 200) fresh = fresh.slice(0, 200)

    // 一次最多取 8 条：实测一次 84 个新节点会产生 22 条 her_diary，
    // 全喂进去会让反刍直接冲顶。情绪是「慢慢被这些事影响」，不是「一次性清算」。
    //
    // 而且 insight/judgment 这一类（→ her_recall）额外限 2 条：
    // 一次星图导出可能带进来十几条「想通了」，但那不是「今天想了十几件事」，
    // 是一次性补进来的旧账。
    let recallFromFresh = 0
    const RECALL_MAX_PER_BATCH = 2

    for (const n of fresh.slice(0, 8)) {
      const kind = n.kind || ''
      // 她「想通」的东西 → 反刍
      if (kind === 'insight' || kind === 'judgment') {
        if (recallFromFresh >= RECALL_MAX_PER_BATCH) continue
        recallFromFresh += 1
        events.push({
          name: 'her_recall',
          ts: Date.parse(n.ts) || nowMs,
          reason: n.topic ? `又想到「${n.topic}」` : '想起一件事',
        })
      }
      // 新的记忆点 → 好奇
      else if (kind === 'memory') {
        events.push({
          name: 'her_learn',
          ts: Date.parse(n.ts) || nowMs,
          reason: '记下了一件新的事',
        })
      }
      // 新写的笔记 → 反刍
      else if (kind === 'note') {
        events.push({
          name: 'her_diary',
          ts: Date.parse(n.ts) || nowMs,
          reason: '写下了点什么',
        })
      }
    }
  }

  // ── 2. 高关联的旧事：degree 很高 = 这件事她还放不下 ──
  // 只取「高 degree + 不是最近写的」，代表被反复想起
  const HOT_DEGREE = 50
  const OLD_MS = 24 * 3600 * 1000
  const hotOld = nodes.filter((n) => {
    if ((n.degree || 0) < HOT_DEGREE) return false
    // 同样的脏节点过滤
    if (typeof n.text !== 'string' || n.text.trim().length < 6) return false
    const ts = Date.parse(n.ts) || 0
    return ts > 0 && nowMs - ts > OLD_MS
  })

  // 「放不下的事」触发频率必须限死（2026-11-26 修的真 bug）。
  //
  // 原来这里是无条件 push：tick 每 60 秒跑一次，于是 3 小时里
  // her_recall 被触发了 79 次，依恋从 46 一路涨到 85。
  // 那不是「她反复想起」，是我把定时器的频率当成了「想」的频率。
  //
  // 现在：每 12 小时最多一次，一天最多 2 次。
  // 真觉得她该多想想，拖面板上的阈值，别靠定时器刷。
  const HOT_COOLDOWN_MS = 12 * 3600 * 1000
  const HOT_MAX_PER_DAY = 2
  const lastHotAt = Number(prev.lastHotAt) || 0
  const hotToday = Number(prev.hotToday) || 0
  const hotDay = String(prev.hotDay || '')
  const todayKey = localDayKey(nowMs)
  const hotUsedToday = hotDay === todayKey ? hotToday : 0

  if (
    hotOld.length > 0
    && nowMs - lastHotAt >= HOT_COOLDOWN_MS
    && hotUsedToday < HOT_MAX_PER_DAY
  ) {
    const idx = Math.floor(nowMs / HOT_COOLDOWN_MS) % hotOld.length
    const n = hotOld[idx]
    events.push({
      name: 'her_recall',
      ts: nowMs,
      reason: n.topic ? `「${n.topic}」那件事还压在心里` : '想起一件一直没放下的事',
      graphNodeId: n.id,
      // 标记来源，方便排查「这次是限频过的」
      limited: true,
    })
    nextSeen.lastHotAt = nowMs
    nextSeen.hotToday = hotUsedToday + 1
    nextSeen.hotDay = todayKey
  }

  // ── 3. 悬而未决的 topic：同一个 topic 反复出现 → 轻微反刍 ──
  //
  // ⚠️ 2026-11-26 Claude 会审指出：这条原来**没有任何频率限制**，
  //    每次 memorySignals 调用都无条件 push 一条 explain。
  //    tick 每 60 秒跑一次 + 每个对话轮（pre-step）也跑一次，
  //    只要星图里有一个出现 ≥8 次的 topic（几乎必然有），
  //    就是「每 tick 施加一次 explain」→ 情绪被定时器推着走，不是被经历推着走。
  //    和坑 #14（规则 2 的 her_recall 刷屏）是同款 bug，只修了规则 2 漏了这条。
  //
  // 现在：24 小时最多一次，且只在「topic 计数真的变了」时才可能触发。
  const TOPIC_COOLDOWN_MS = 24 * 3600 * 1000
  const topicCount = new Map()
  for (const n of nodes) {
    const t = n.topic
    if (!t) continue
    topicCount.set(t, (topicCount.get(t) || 0) + 1)
  }
  const openTopics = [...topicCount.entries()].filter(([, c]) => c >= 8)

  const lastTopicAt = Number(prev.lastTopicAt) || 0
  // 用「所有 open topic 的计数总和」当指纹：真变了才值得提一次
  const topicFingerprint = openTopics
    .map(([t, c]) => t + ':' + c)
    .sort()
    .join('|')
  const fingerprintChanged = prev.topicFingerprint !== undefined
    && prev.topicFingerprint !== topicFingerprint

  if (
    openTopics.length > 0
    && nowMs - lastTopicAt >= TOPIC_COOLDOWN_MS
    && (prev.topicFingerprint === undefined || fingerprintChanged)
  ) {
    const [topic, count] = openTopics[0]
    events.push({
      name: 'explain',
      ts: nowMs,
      reason: `「${topic}」这件事反复出现，还没个着落`,
    })
    nextSeen.lastTopicAt = nowMs
  }
  nextSeen.topicFingerprint = topicFingerprint

  return {
    events,
    seen: {
      ...nextSeen,
      maxTs: Math.max(prev.maxTs || 0, ...nodes.map((n) => Date.parse(n.ts) || 0), 0),
      nodeCount: nodes.length,
      /**
       * 去重集合：按「节点的 ts」排序取最近 500 个，不是按数组位置。
       *
       * 2026-11-26 Claude 会审指出：原来用 slice(-500) 取数组尾部，
       * 节点超过 500 时，数组中间/前面的 id 会落出集合 ——
       * 但它们的时间可能是最近的（星图导出顺序不保证按 ts）。
       * 那样这些节点下次会被当成「新的」再触发一遍情绪。
       *
       * 现在按 ts 倒序取最近 500 个，覆盖的总是时间上最新的。
       */
      recentIds: [...nodes]
        .filter((n) => n?.id)
        .sort((a, b) => (Date.parse(b.ts) || 0) - (Date.parse(a.ts) || 0))
        .slice(0, 500)
        .map((n) => n.id),
    },
  }
}

/**
 * 「成长」页的数据：她最近想通了什么、反复在想什么。
 *
 * 只从星图读，不碰任何别的文件。全部只读。
 */
export function growthDigest(graph) {
  if (!graph || !Array.isArray(graph.nodes)) {
    return { ok: false, error: '星图没读到' }
  }
  const clean = graph.nodes.filter((n) => typeof n.text === 'string' && n.text.trim().length >= 6)

  // 1. 最近想通的（insight / judgment），按时间倒序
  const insights = clean
    .filter((n) => n.kind === 'insight' || n.kind === 'judgment')
    .sort((a, b) => (Date.parse(b.ts) || 0) - (Date.parse(a.ts) || 0))
    .slice(0, 15)
    .map((n) => ({
      kind: n.kind,
      text: String(n.text).slice(0, 200),
      topic: n.topic || '',
      ts: n.ts,
      degree: n.degree || 0,
    }))

  // 2. 反复在想的话题（出现次数 + 总关联度，两个指标都看）
  const topicMap = new Map()
  for (const n of clean) {
    const t = n.topic
    if (!t) continue
    const cur = topicMap.get(t) || { topic: t, count: 0, degree: 0, lastTs: 0 }
    cur.count += 1
    cur.degree += n.degree || 0
    const ts = Date.parse(n.ts) || 0
    if (ts > cur.lastTs) cur.lastTs = ts
    topicMap.set(t, cur)
  }
  const topics = [...topicMap.values()]
    .sort((a, b) => b.count - a.count || b.degree - a.degree)
    .slice(0, 12)

  // 3. 按月分布（看她这段时间在想什么）
  const byMonth = new Map()
  for (const n of clean) {
    const ts = Date.parse(n.ts)
    if (!ts) continue
    const d = new Date(ts)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    const cur = byMonth.get(key) || { month: key, count: 0 }
    cur.count += 1
    byMonth.set(key, cur)
  }

  return {
    ok: true,
    total: clean.length,
    insights,
    topics,
    byMonth: [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month)),
    generatedAt: graph.meta?.generatedAt || null,
  }
}

/**
 * 「记忆」页的数据：她的身份摘要 + 认识的人 + 星图里最重的事。
 *
 * 全只读。身份文档只取标题和每节首段，不吐全文——
 * 17KB 全塞进面板既慢又没必要，要有需要可以直接打开文件看。
 */
export async function memoryDigest(config, graph) {
  const HOME = 'D:/dsh-fish-home/dsh-fish/home'
  const out = { ok: true, identity: null, people: null, hottest: [], ageWarning: null }

  // 1. 她的身份：解析 markdown 标题 + 每节首段
  try {
    const raw = await readFile(`${HOME}/她的身份.md`, 'utf8')
    const sections = []
    const lines = raw.split('\n')
    let cur = null
    for (const line of lines) {
      const m = /^##\s+(.+)$/.exec(line)
      if (m) {
        if (cur) sections.push(cur)
        cur = { title: m[1].trim(), lines: [] }
      } else if (cur && line.trim()) {
        cur.lines.push(line.trim())
      }
    }
    if (cur) sections.push(cur)
    out.identity = {
      sizeBytes: Buffer.byteLength(raw, 'utf8'),
      sections: sections.map((s) => ({
        title: s.title,
        preview: s.lines.slice(0, 2).join(' ').slice(0, 160),
        lineCount: s.lines.length,
      })),
    }
  } catch (e) {
    out.identity = { error: String(e?.message ?? e) }
  }

  // 2. 她认识的人
  try {
    const raw = await readFile(`${HOME}/她认识的人.md`, 'utf8')
    out.people = { raw: raw.slice(0, 1200) }
  } catch {
    out.people = null
  }

  // 3. 星图里最重的几件事（带全文，不只截断）
  if (graph && Array.isArray(graph.nodes)) {
    out.hottest = graph.nodes
      .filter((n) => typeof n.text === 'string' && n.text.trim().length >= 6)
      .sort((a, b) => (b.degree || 0) - (a.degree || 0))
      .slice(0, 8)
      .map((n) => ({
        kind: n.kind,
        degree: n.degree || 0,
        text: String(n.text).slice(0, 300),
        topic: n.topic || '',
        ts: n.ts,
      }))
  }

  return out
}

/**
 * 给面板用的摘要：星图里现在有什么，情绪的原料从哪来。
 */
export function graphDigest(graph) {
  if (!graph || !Array.isArray(graph.nodes)) {
    return { ok: false, error: '星图没读到' }
  }
  const kinds = {}
  const topics = new Map()
  for (const n of graph.nodes) {
    kinds[n.kind || '?'] = (kinds[n.kind || '?'] || 0) + 1
    if (n.topic) topics.set(n.topic, (topics.get(n.topic) || 0) + 1)
  }
  // 摘要里也要过滤脏节点：实测有个 deg=102 的 insight，text 就一个 "x"。
  // 它排第一会让面板上「她最放不下的」显示成 "x"，很难看也很误导。
  const hot = [...graph.nodes]
    .filter((n) => typeof n.text === 'string' && n.text.trim().length >= 6)
    .sort((a, b) => (b.degree || 0) - (a.degree || 0))
    .slice(0, 5)
    .map((n) => ({
      kind: n.kind,
      degree: n.degree || 0,
      topic: n.topic || '',
      text: String(n.text || '').slice(0, 60),
      ts: n.ts,
    }))

  return {
    ok: true,
    generatedAt: graph.meta?.generatedAt || null,
    nodes: graph.nodes.length,
    edges: Array.isArray(graph.edges) ? graph.edges.length : 0,
    kinds,
    topTopics: [...topics.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8),
    hottest: hot,
  }
}
