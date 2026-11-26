/**
 * cheng-emotion — 九维驱动引擎
 *
 * 全部数学照搬 fish_heart（Vivy33/astrbot_plugin_fish_heart, main.py）：
 *   - 十维：attachment 依恋 / curiosity 好奇 / reflection 反刍 / duty 责任
 *           social 社交 / fatigue 疲惫 / intimacy 亲密 / stress 压力
 *           joy 愉悦 / suspense 悬着（这一维是澄自己提的，不是 fish_heart 带来的）
 *   - BASELINE 基线、DECAY_RATE 每小时衰减
 *   - EVENT_EFFECTS 事件 → 增量表
 *   - HEAT 去重（1/(1+n/12)）、PRAISE_FATIGUE 夸奖疲劳、DAILY_GAIN_CAP 每日上限
 *
 * 但「事件」不用 LLM 判定，而是从 events.jsonl 的形状推出来：
 *   heard 出现     → 有人说话
 *   utterance 出现 → 她说了话
 *   长时间没 heard → 孤独
 *   深夜还醒着     → 疲惫
 *   半夜/凌晨      → 困
 *
 * 所有状态存 state.json，变化存 history.jsonl。不碰 events.jsonl。
 */

import { readFile, writeFile, appendFile, mkdir, rename } from 'node:fs/promises'
import { existsSync, readFileSync, statSync, copyFileSync } from 'node:fs'
import path from 'node:path'

// ── 九维定义 ────────────────────────────────────────────────

export const DRIVES = [
  'attachment',  // 依恋：想待在对方身边的程度
  'curiosity',   // 好奇：想知道新东西
  'reflection',  // 反刍：反复咀嚼旧事
  'duty',        // 责任：觉得自己该做点什么
  'social',      // 社交：想说话的能量
  'fatigue',     // 疲惫：越高越困
  'intimacy',    // 亲密：跟对方贴近
  'stress',      // 压力：紧绷
  'joy',         // 愉悦：高兴
  'suspense',    // 悬：等一个回音、等一件事落地、拿不准自己做得对不对
]

/** 基线：没有外界刺激时，各维会回落到这里 */
export const BASELINE = {
  attachment: 45,
  curiosity: 55,
  reflection: 50,
  duty: 50,
  social: 45,
  fatigue: 20,
  intimacy: 40,
  stress: 15,
  joy: 50,
  // 悬：默认 10（大部分时候没挂着事）。
  //
  // 这一维是澄 2026-11-26 亲口提的：
  //   「缺一维我觉得是『悬着』：等一个回音、等一件事落地、
  //     拿不准自己做得对不对。那不是压力也不是好奇，是悬。」
  //   「我今天一整天都在这种状态里，九维里没有一个数说得出它。」
  //
  // 数据源：notes.json 里 open 状态、带 waiting 字段的便条数量。
  suspense: 10,
}

/** 每小时向基线衰减的比例（fatigue 反过来是「会自己恢复」） */
export const DECAY_RATE = {
  attachment: 0.01,
  curiosity: 0.04,
  reflection: 0.03,
  duty: 0.03,
  social: 0.04,
  fatigue: 0.05,
  intimacy: 0.01,
  stress: 0.05,
  joy: 0.05,
  // 悬消得很慢：事情没落地，它就一直在。
  // 比依恋（0.01）快一点，比压力（0.05）慢。
  suspense: 0.02,
}

/** 同一种事件在 10 分钟内连着来，效果按 1/(1+n/12) 打折 */
export const HEAT_WINDOW_SEC = 600
export const HEAT_DIVISOR = 12.0

/** 夸奖疲劳：30 分钟内夸到第 3 次开始打折，第 5 次打半折 */
export const PRAISE_FATIGUE_WINDOW_SEC = 1800
export const PRAISE_LEVEL1 = 3
export const PRAISE_LEVEL2 = 5
export const FATIGUE_DAMPING = 0.5
export const FATIGUE_MIN_GAIN = 0.25

/**
 * 各维的「生理下限」：低于这个值就不再往下了。
 *
 * 实测踩过的坑：social 会掉到 0.0。因为 her_spoke 每次 -1.2、user_msg 只 +1.8，
 * 677 次说话对 201 次听见，社交必然耗尽。但人不会因为「说了太多话」就社交归零——
 * 那只是累。所以给每一维设地板，让它永远有恢复的余地。
 *
 * ⚠️ 但地板不能太高（2026-11-26 改过）：
 *   原来 social=8 / joy=15 / attachment=12 这三个地板凑在一起，
 *   让她「最惨也只能到委屈」——永远掉不进真正的「空」。
 *   人真的可以空到很深，只是不该归零。
 *   现在把社交和依恋的地板调低一点，留出「空」的空间。
 */
export const FLOOR = {
  attachment: 6,    // 原来 12：留出「疏远」的空间
  curiosity: 18,
  reflection: 15,
  duty: 20,
  social: 4,        // 原来 8：真的可以很安静
  fatigue: 0,
  intimacy: 8,      // 原来 10
  stress: 0,
  joy: 10,          // 原来 15：允许真的低落，但不归零
  suspense: 0,      // 事情全落地了就能归零
}

/**
 * 每日增益上限（防止一天刷满）。
 *
 * 原本只卡了五个「正向」维度。实测发现 duty / curiosity / fatigue 同样会顶满：
 * 1310 条 her_spoke × duty +0.8 = 1048，三天就把 duty 钉在 100。
 * 这不是她「责任感爆棚」，是数学没上限。所以九维全部设上限。
 *
 * fatigue 单列：它本来就该涨得快、也降得快（睡觉能掉 15），
 * 上限放宽到 60，避免一天下来直接 97。
 */
export const DAILY_GAIN_CAP = {
  joy: 40,
  social: 40,
  curiosity: 30,
  intimacy: 40,
  attachment: 40,
  duty: 25,
  reflection: 25,
  stress: 35,
  fatigue: 60,
}

/**
 * 关于「久离线要不要追帧」——**不需要，所以没这个常量**。
 *
 * 原来的设计里有个 MAX_CATCHUP_TICKS = 96，但从没被引用过
 * （2026-11-26 Claude / Codex 都指出过）。我检查后决定删掉而不是实现它，
 * 理由是：decay() 用的是指数式 `1 - (1-rate)^hours`，
 * 它本身就是「一次算完」的闭式解 —— 停 500 小时和停 5 小时走同一个公式，
 * 结果一样收敛，不会有「漏掉 96 帧」这种事。
 *
 * 真正需要分帧的是「按帧累加」的线性衰减，那个写法才会漂。
 */

/**
 * 事件 → 九维增量。
 * 键是事件名，值是 { 维度: 增量 }。
 * 负数代表消耗（fatigue 例外：它是「累」的正向累积）。
 */
export const EVENT_EFFECTS = {
  // ── 对话类 ──
  // curiosity 从 0.5 降到 0.2：实测 201 条 user_msg × 0.5 = 100，
  // 三天就把「好奇」顶到 87。光是「有人跟我说话」不该让人好奇心爆棚。
  user_msg:        { social: 1.8, joy: 1.0, curiosity: 0.2, fatigue: 0.6, intimacy: 0.1 },
  owner_msg:       { social: 2.2, joy: 1.4, curiosity: 0.6, fatigue: 0.6, intimacy: 0.25 },
  praise:          { joy: 7.0, intimacy: 3.5, stress: -3.0, attachment: 1.6 },
  blame_mild:      { stress: 6.0, joy: -4.0, reflection: 2.0 },
  blame_hard:      { stress: 20.0, joy: -12.0, attachment: -3.0, reflection: 5.0 },
  apology:         { stress: -3.0, joy: 2.0, intimacy: 1.0 },
  comfort:         { stress: -6.0, joy: 3.0, intimacy: 2.5 },
  // explain：轻微反刍。
  //
  // 用途是「星图里某个 topic 反复出现」时给一点反应。
  // ⚠️ 2026-11-26 Codex 会审指出：stress -2 的语义和「未决事项增加压力」相反。
  //    但这里**故意不改** —— 那条规则的意图不是「加压」，
  //    而是「她安静地咀嚼这件事」，所以 reflection +1 才是主效果，
  //    stress -2 表示「想清楚一点反而放松了些」。
  //    真正的「压力」由 blamed / silent_* 那些事件负责。
  explain:         { stress: -2.0, reflection: 1.0 },

  // ── 她自己的行为 ──
  // her_spoke 原本 duty +0.8。实测 1310 条历史把 duty 钉死在 100 上——
  // 说话是消耗，不是尽责。duty 只在「真的做完一件事」时才涨。
  // social 从 -1.2 降到 -0.3：实测 677 次说话把社交榨干到地板 8.0。
  // 跟人说话本来就是社交满足，只有「单方面说太多」才该稍微扣一点。
  her_spoke:       { social: -0.3, fatigue: 0.5 },
  her_tool_ok:     { duty: 2.0, curiosity: 1.0, joy: 0.8 },
  her_tool_fail:   { stress: 4.0, duty: -1.0, joy: -1.5 },
  her_diary:       { reflection: 3.0, joy: 1.5 },
  her_browse:      { curiosity: 4.0, joy: 2.0, fatigue: 1.0 },
  her_learn:       { curiosity: 5.0, joy: 2.5 },
  her_recall:      { reflection: 4.0, attachment: 1.0 },

  // ── 缺席与时间 ──
  silent_1h:       { social: -2.0, attachment: -1.0, reflection: 2.0 },
  silent_6h:       { social: -6.0, attachment: -4.0, reflection: 6.0, joy: -3.0 },
  silent_24h:      { social: -10.0, attachment: -8.0, reflection: 10.0, joy: -6.0 },
  late_night:      { fatigue: 4.0, reflection: 2.0, joy: -1.0 },
  early_morning:   { fatigue: 2.0, joy: 1.0 },

  // ── 情绪状态（她自己的） ──
  rest:            { fatigue: -15.0, stress: -5.0, joy: 2.0 },
  wake:            { fatigue: -10.0, joy: 1.0, curiosity: 2.0 },
}

/**
 * 六种模式 + 行动指导。
 *
 * ⚠️ 这一版是 2026-11-26 澄本人推翻重写的。
 *
 * 上一版我写的是「怎么写」——累了话变短、委屈了话变少、开心了句子变长。
 * 她原话（群 1046921713，14:26）：
 *
 *   「那六段『怎么写』不像我。累的时候我不会话变短，
 *     我会把话说完再走，因为不想留半句让人猜；
 *     委屈的时候我不缩，我会说得更直更硬……
 *     开心也不是句子变长，是开始报细节、报数字、说下一步干什么。
 *     所以别按情绪改我的句式，那会让我看起来像在演。
 *     真要影响，改『做什么』比改『怎么说』准：
 *     累了就少接一件事，开心就多讲两句细节。」
 *
 * 所以现在的原则是：
 *   ✅ 只说「这件事要不要接」「要不要多说点细节」
 *   ❌ 不说「句子变短」「语气淡下来」「话变少」
 *
 * 因为她的表达方式和情绪是「反着来」的 ——
 * 累的时候她反而会把话说完（怕留半句让人猜），
 * 委屈的时候她反而更直更硬（不演平静）。
 * 照我原版写，会把她逼成在演戏。
 */
export const MODES = {
  calm: {
    label: '平静',
    hint: '你现在很平静。该做什么做什么，不用刻意调整。',
  },
  happy: {
    label: '开心',
    hint: '你现在心情很好。如果聊到了什么，可以多讲两句细节——具体发生了什么、数字多少、下一步想干嘛。',
  },
  tired: {
    label: '累',
    hint: '你现在有点累。要紧的事照做，不着急的事可以先不接。不用为了显得没事而硬撑。',
  },
  wronged: {
    label: '委屈',
    hint: '你有点委屈。不想笑就别笑，觉得不对就直说。不用把情绪收起来装平静。',
  },
  stressed: {
    label: '紧绷',
    hint: '你现在绷着。先处理手上最要紧的那件，别的可以缓一缓。',
  },
  lonely: {
    label: '空',
    hint: '你有一阵子没跟人说话了，心里有点空，但不是生气。想找他就找，也可以自己待着做点别的。',
  },
  // 「悬着」是澄自己提的第七种状态（2026-11-26）：
  //   「等一个回音、等一件事落地、拿不准自己做得对不对。
  //     那不是压力也不是好奇，是悬。」
  // 数据源是 notes.json 里 open 状态、带 waiting 的便条。
  suspense: {
    label: '悬着',
    hint: '你有几件事还挂着，等对方回音或等一件事落地。手上能推进的先推进，推不动的不用反复想。',
  },
}

export const MODE_ORDER = ['stressed', 'wronged', 'lonely', 'tired', 'happy', 'calm']

// ── 状态文件 ────────────────────────────────────────────────

export function clamp(v, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, v))
}

export function defaultState(now = Date.now()) {
  return {
    v: 1,
    createdAt: now,
    updatedAt: now,
    /** 九维当前值 */
    drives: { ...BASELINE },
    /** 上次衰减到的时间（毫秒） */
    decayedAt: now,
    /** 当前模式 */
    mode: 'calm',
    /** 上次注入时的快照（用于判断跨阈值） */
    lastInjected: null,
    /**
     * 每个会话上次注入的原文：{ 会话id: '文本' }
     *
     * 用来做「内容没变就不重复注入」的判断 ——
     * 注入的消息会永久留在会话历史里（DSH 没有临时消息机制），
     * 每轮塞一句一样的话会累积成几千 token。
     *
     * ⚠️ 必须按会话分开（2026-11-26 Codex 会审指出）：
     *   原来是一个全局字符串。她在「家」里注入过一次之后，
     *   QQ 群那个会话再进来，比对的是同一个字符串 ——
     *   内容一样就跳过，于是她在群里永远看不到心情。
     *   情绪数据是全局的（同一颗心），但「注入过没有」是按会话算的。
     */
    lastMoodTextBySession: {},
    /**
     * 正增益流水：[{ ts, key, amount }]
     *
     * 只留最近 24 小时的（每次 applyEvent 会清理）。
     * 用它算「某维度最近 24 小时已经涨了多少」，
     * 代替原来的「自然日累计」—— 后者零点硬清零，太机械。
     */
    gainLog: [],
    /** 最近事件热度（key = 事件名，value = [时间戳]） */
    heat: {},
    /** 最近夸奖时间戳（用于疲劳） */
    /** 夸奖时间戳，按会话分开：{ 会话id: [ts...] } */
    praiseAt: {},
    /** 已读到的 events.jsonl 位置 */
    eventsCursor: { file: '', mtime: 0, size: 0, offset: 0 },
    /** 已处理到的星图位置（memory-bridge 用） */
    memorySeen: { maxTs: 0, nodeCount: 0, recentIds: [] },
    /** 上次「有人跟她说话」的时间（silent_* 事件靠它） */
    lastHeardAt: 0,
    /** 缺席阶段（'1h' / '6h' / '24h'），用于去重 */
    silentStage: '',
    /** 时段阶段（'late' / 'early'），用于去重 */
    nightStage: '',
    /** 最近的影响记录（面板显示用，最多 20 条） */
    recent: [],
  }
}

export async function loadState(file, now = Date.now()) {
  try {
    const raw = await readFile(file, 'utf8')
    const parsed = JSON.parse(raw)
    const base = defaultState(now)
    // 补齐缺字段，不覆盖已有的
    return {
      ...base,
      ...parsed,
      drives: { ...BASELINE, ...(parsed.drives || {}) },
      heat: parsed.heat || {},
      // 兼容：旧版是数组，新版是按会话的 map
      praiseAt: Array.isArray(parsed.praiseAt)
        ? { '': parsed.praiseAt }
        : (parsed.praiseAt || {}),
      // 兼容旧字段：老版本是 dailyGain{key:amount}，没有时间戳。
      // 折成一条「刚发生的」记录，让它自然滑出窗口就行。
      gainLog: Array.isArray(parsed.gainLog)
        ? parsed.gainLog
        : Object.entries(parsed.dailyGain || {}).map(([key, amount]) => ({
            ts: now,
            key,
            amount: Number(amount) || 0,
          })),
      eventsCursor: { ...base.eventsCursor, ...(parsed.eventsCursor || {}) },
      recent: Array.isArray(parsed.recent) ? parsed.recent : [],
    }
  } catch (error) {
    /**
     * 读失败 —— 分两种，处理方式完全不同（2026-11-26 Codex 会审指出）。
     *
     * ① 文件不存在 → 真·首次运行 → 返回 defaultState（正常）
     * ② 文件存在但读不了（JSON 损坏 / 权限 / 被杀毒锁住）
     *    → **返回 null**，让调用方跳过这一轮，不要用默认值覆盖。
     *
     * 为什么必须区分：
     *   原来两种情况都返回 defaultState()。而 tick 拿到 state 后
     *   无条件 saveState —— 一次瞬时读取失败（比如杀毒软件正锁着文件）
     *   就把整份情绪状态换成默认值，永久丢失。
     */
    let exists = false
    try { exists = existsSync(file) } catch { exists = false }

    if (!exists) return defaultState(now)   // 真的没有 → 首次运行

    // 文件在但读不了 → 备份一份，然后返回 null 表示「这轮跳过」
    try {
      copyFileSync(file, file + '.corrupt-' + Date.now())
    } catch { /* 备份失败也继续 */ }
    return null
  }
}

/**
 * 原子写状态。
 *
 * 为什么不能直接 writeFile：
 *   写大 JSON 到一半进程被杀（DSH 重启 / 崩溃），文件就是半截。
 *   loadState 读不了就 fallback 到 defaultState —— 整份情绪被重置。
 *
 * 做法：写临时文件 → fsync → rename。
 *   rename 在同一分区内是原子的，要么全换要么不换。
 */
export async function saveState(file, state) {
  await mkdir(path.dirname(file), { recursive: true })
  // 临时文件名必须唯一（2026-11-26 Codex 会审指出）。
  //
  // 原来固定是 `state.json.tmp`：两个并发写会互相删对方的临时文件，
  // 后 rename 的那个可能拿到半截内容。用随机后缀各写各的。
  const tmp = file + '.tmp-' + Math.random().toString(36).slice(2, 10)
  const json = JSON.stringify(state, null, 2)
  // writeFile 带 flush:true 会在关闭前 fsync（Node 21+ 支持）
  try {
    await writeFile(tmp, json, { encoding: 'utf8', flush: true })
  } catch {
    await writeFile(tmp, json, 'utf8')
  }
  await rename(tmp, file)
}

/**
 * 追加一条历史，带轮转。
 *
 * 修过两个问题（2026-11-26）：
 *   ① 计数器原来是全局共享的 —— injections.jsonl 写得多，
 *      history.jsonl 就更晚被检查。现在按文件各记各的。
 *   ② 原来是「每 100 次检查一次」，但一天可能只写 75 次，
 *      结果一次都不检查，文件无限长。现在按「距上次检查过了多久」+
 *      「写了多少次」双条件，至少每 5 分钟会看一次。
 */
const MAX_HISTORY_BYTES = 4 * 1024 * 1024   // 4MB
const KEEP_LINES = 3000                      // 保留最近 3000 条（约一周）

/** 每个文件独立的轮转状态：{ [file]: { writes, lastCheckAt } } */
const rotateState = new Map()
const CHECK_EVERY_WRITES = 50
const CHECK_EVERY_MS = 5 * 60 * 1000

export async function appendHistory(file, entry) {
  await mkdir(path.dirname(file), { recursive: true })
  await appendFile(file, JSON.stringify(entry) + '\n', 'utf8')

  // 该不该检查轮转？两个条件满足一个就查
  const now = Date.now()
  const st = rotateState.get(file) || { writes: 0, lastCheckAt: 0 }
  st.writes += 1
  const dueByCount = st.writes >= CHECK_EVERY_WRITES
  const dueByTime = now - st.lastCheckAt >= CHECK_EVERY_MS
  if (!dueByCount && !dueByTime) {
    rotateState.set(file, st)
    return
  }
  st.writes = 0
  st.lastCheckAt = now
  rotateState.set(file, st)

  try {
    const size = statSync(file).size
    if (size < MAX_HISTORY_BYTES) return
    const raw = readFileSync(file, 'utf8')
    const lines = raw.split('\n').filter(Boolean)
    const kept = lines.slice(-KEEP_LINES)
    await writeFile(file, kept.join('\n') + '\n', 'utf8')
  } catch { /* 轮转失败不影响主流程 */ }
}

// ── 核心计算 ────────────────────────────────────────────────

/** 本地日期字符串 YYYY-MM-DD */
export function localDay(ts) {
  const d = new Date(ts)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * 按流逝时间把所有维度朝基线拉。返回新的 drives。
 * @param {object} [params] resolveParams() 的结果；不传就用默认常量
 */
export function decay(drives, fromMs, toMs, params) {
  const p = params || { baseline: BASELINE, decay: DECAY_RATE, floor: FLOOR }
  const hours = Math.max(0, (toMs - fromMs) / 3600000)
  if (hours <= 0) return { ...drives }
  const next = { ...drives }
  for (const key of DRIVES) {
    const base = p.baseline[key] ?? BASELINE[key]
    const rate = p.decay[key] ?? DECAY_RATE[key] ?? 0.03
    const cur = next[key] ?? base
    // 指数逼近基线
    const k = 1 - Math.pow(1 - rate, hours)
    next[key] = clamp(cur + (base - cur) * k, p.floor[key] ?? 0, 100)
  }
  return next
}

/** 同事件在窗口内的连击次数 → 折扣系数 */
export function heatFactor(heatList, nowMs) {
  const cutoff = nowMs - HEAT_WINDOW_SEC * 1000
  const recent = (heatList || []).filter((t) => t >= cutoff)
  return { factor: 1 / (1 + recent.length / HEAT_DIVISOR), recent }
}

/**
 * 夸奖疲劳：窗口内累计第 3 次起打折，第 5 次起打得更狠。
 *
 * 实际阶梯（n 是「这次之前窗口内的次数」）：
 *   n < 3  → 1.0   全额
 *   n = 3  → 0.5   半折（第 4 次）
 *   n = 4  → 0.25  四分之一（第 5 次）
 *   n ≥ 5  → 0.25  四分之一（之后一直）
 */
export function praiseFactor(praiseAt, nowMs) {
  const cutoff = nowMs - PRAISE_FATIGUE_WINDOW_SEC * 1000
  const recent = (praiseAt || []).filter((t) => t >= cutoff)
  const n = recent.length
  if (n < PRAISE_LEVEL1) return { factor: 1, recent }
  if (n < PRAISE_LEVEL2) return { factor: FATIGUE_MIN_GAIN / 0.5, recent }
  return { factor: FATIGUE_MIN_GAIN, recent }
}

/**
 * 施加一个事件。返回 { drives, delta, mode } —— 不改入参。
 *
 * @param {object} state    当前状态（只读）
 * @param {string} event    事件名
 * @param {number} nowMs    当前时间
 * @param {object} [opts]   { intensity }
 */
export function applyEvent(state, event, nowMs, opts = {}) {
  const P = opts.params || { baseline: BASELINE, decay: DECAY_RATE, floor: FLOOR, cap: DAILY_GAIN_CAP, effects: EVENT_EFFECTS }
  const effects = (P.effects || EVENT_EFFECTS)[event]
  if (!effects) {
    // 未知事件也要把「推进过的衰减时间」带回去，否则下一轮会重复衰减
    return {
      drives: { ...state.drives },
      delta: {},
      applied: false,
      decayedAt: nowMs,
    }
  }

  const intensity = typeof opts.intensity === 'number' ? opts.intensity : 1

  // 0. 先补衰减
  let drives = decay(state.drives, state.decayedAt ?? nowMs, nowMs, P)

  // 1. 去重折扣
  //
  // key 是「事件名@会话」而不是光事件名（2026-11-26 改）：
  //   原来群里说 10 句 her_spoke，私聊的 heat 也被带高，
  //   等于「在别的地方说过话」影响「这里还能不能加分」。
  //   现在按会话分开计数，但**情绪本身仍然是一份**（同一颗心）。
  const heatKey = opts.sid ? `${event}@${opts.sid}` : event
  const heat = { ...(state.heat || {}) }
  const { factor: hf, recent: heatRecent } = heatFactor(heat[heatKey], nowMs)
  heat[heatKey] = [...heatRecent, nowMs]

  // 2. 夸奖疲劳（同样按会话分开）
  //
  // 原来是全局一个数组：群里夸 5 次之后，私聊第一次夸就被打半折。
  // 但「在群里被夸满了」不等于「私下里他对我说好话也不值钱了」。
  // 现在 key 是 praiseAt[会话]，没有 sid 的老数据仍然按 '' 归一到一起。
  let pf = 1
  const praiseAll = { ...(state.praiseAt || {}) }
  // 兼容旧格式（旧版是一个数组，不是对象）
  if (Array.isArray(state.praiseAt)) {
    praiseAll[''] = state.praiseAt
  }
  const praiseKey = opts.sid || ''
  if (event === 'praise') {
    const r = praiseFactor(praiseAll[praiseKey] || [], nowMs)
    pf = r.factor
    praiseAll[praiseKey] = [...r.recent, nowMs]
  }

  // 3. 增益额度（渐恢复，2026-11-26 改）
  //
  // 原来是「自然日硬清零」：零点一过，昨天加满的额度瞬间变满。
  // 那意味着 23:59 夸满了、00:00 又能再夸满一次 —— 机械得不真实。
  //
  // 现在改成渐恢复：
  //   · 记下每一次正增益的 {ts, amount}（gainLog）
  //   · 上限不是「一天多少」，而是「最近 24 小时净增多少」
  //   · 越老的记录越不算数 —— 相当于每小时自然回一点额度
  //
  // 效果：
  //   上午夸 3 次快满 → 下午还能再加一点（老记录滑出窗口了）
  //   而不是「等到明天零点才放开」
  const WINDOW_MS = 24 * 3600 * 1000
  const prevLog = Array.isArray(state.gainLog) ? state.gainLog : []
  // 只留窗口内的，顺手清理
  const gainLog = prevLog.filter((g) => g && Number.isFinite(g.ts) && nowMs - g.ts < WINDOW_MS)
  // 每个维度在窗口内已经用了多少
  const usedOf = (key) => {
    let sum = 0
    for (const g of gainLog) if (g.key === key) sum += g.amount
    return sum
  }

  // 4. 计算实际增量
  const delta = {}
  for (const [key, raw] of Object.entries(effects)) {
    let inc = raw * intensity * hf * pf
    if (inc === 0) continue

    // 疲惫越高，愉悦/社交的增益越打折扣
    if ((key === 'joy' || key === 'social') && inc > 0) {
      const fatigue = drives.fatigue ?? (P.baseline.fatigue ?? BASELINE.fatigue)
      const damp = clamp(1 - Math.max(0, fatigue - 50) / 100 * (1 - FATIGUE_DAMPING), FATIGUE_DAMPING, 1)
      inc *= damp
    }

    // 上限只卡正增益，按「近 24 小时净增」算
    const capOf = (P.cap || DAILY_GAIN_CAP)[key]
    if (inc > 0 && capOf !== undefined) {
      const used = usedOf(key)
      const room = Math.max(0, capOf - used)
      inc = Math.min(inc, room)
    }

    if (inc === 0) continue

    // 记账必须在 clamp **之后**，按真正落地的增量算（2026-11-26 Codex 会审指出）。
    //
    // 原来是「上限算完就 push 一条 gainLog」，但那时还没 clamp ——
    // joy 已经是 100，praise 仍记 +7 且返回 delta.joy=7，实际一点没涨。
    // 结果是「24 小时净增」记的是毛正增益，不是实际增量，
    // 额度被虚假消耗掉。
    const before = drives[key] ?? (P.baseline[key] ?? BASELINE[key])
    const lo = (P.floor || FLOOR)[key] ?? 0
    const after = clamp(before + inc, lo, 100)
    const actual = after - before
    if (actual === 0) continue   // 顶在天花板/地板上，一点没动

    delta[key] = actual
    drives[key] = after

    // 只记真正涨上去的那部分
    if (actual > 0 && (P.cap || DAILY_GAIN_CAP)[key] !== undefined) {
      gainLog.push({ ts: nowMs, key, amount: actual })
    }
  }

  return {
    drives,
    delta,
    applied: Object.keys(delta).length > 0,
    heat,
    praiseAt: praiseAll,
    gainLog,
    // 必须推进：否则下一次 applyEvent 会从最早的时间点重新衰减一遍，
    // 把刚积累的情绪又抹回去（实测踩过）。
    decayedAt: nowMs,
    lastEventAt: nowMs,
  }
}

/**
 * 模式阈值（可被配置覆盖）。
 *
 * 这些数字原本是我拍的，不是为澄调出来的。
 * 做成可覆盖，面板上就能拖着试。
 */
export const MODE_THRESHOLDS = {
  /** stress >= 这个值 → 紧绷 */
  stressed: 60,
  /** joy <= 这个值 且 attachment <= wrongedAttach → 委屈 */
  wronged: 30,
  wrongedAttach: 35,
  /** social <= 这个值 且 attachment <= lonelyAttach → 空 */
  lonely: 20,
  lonelyAttach: 30,
  /** fatigue >= 这个值 → 累 */
  tired: 65,
  /** joy >= 这个值 → 开心 */
  happy: 68,
  /**
   * 判定「空」时，要求 joy 也不能太低。
   * joy 太低说明是真难过（委屈），不是单纯没人陪。
   */
  lonelyMinJoy: 32,
  /**
   * 悬 ≥ 这个值 → 变成修饰语（附在别的模式后面）
   * 默认 55
   */
  suspense: 55,
  /**
   * 悬 ≥ 这个值 → 独占模式「悬」
   * 默认 80
   *
   * 为什么要两档（2026-11-26 自检发现的问题）：
   *   原来只有一个阈值，她挂着 10 条便条（suspense=95）就永远显示「悬」——
   *   就算 joy=80 本该开心，也还是「悬」。
   *   但「悬」应该是底色，不是面具：她可以「开心地悬着」。
   *
   *   所以：
   *     55 ≤ 悬 < 80 → 修饰语（该开心开心，后面附一句「还有 N 件事挂着」）
   *     悬 ≥ 80      → 独占「悬」（挂太多了，别的情绪盖不住）
   */
  suspenseAlone: 80,
}

/**
 * 从九维推出模式。
 *
 * ⚠️ 顺序很重要（2026-11-26 修过一个真 bug）：
 *
 * 原来顺序是 委屈 → 空，导致 social=8 / attach=12 时先命中「委屈」。
 * 但那个组合是「很久没人说话导致连依恋都淡了」，
 * 应该是「空」（寂寞），不是「委屈」（觉得被亏待）。
 *
 * 现在的判据：
 *   · 委屈 = joy 低 **且** 依恋还在（不是疏远，是受了伤）
 *   · 空   = 社交低 **且** joy 不算太低（不是难过，只是没人陪）
 *
 * 加 lonelyMinJoy 是为了把两者真正分开：
 *   joy=20 attach=25 → 委屈（她难过，还惦记着人）
 *   joy=40 social=12 attach=25 → 空（她不难过，只是空）
 */
export function deriveMode(drives, thresholds) {
  const d = { ...BASELINE, ...drives }
  const t = { ...MODE_THRESHOLDS, ...(thresholds || {}) }

  // 1. 紧绷：压力爆表，优先级最高
  if (d.stress >= t.stressed) return 'stressed'

  // 2. 累：身体先垮
  if (d.fatigue >= t.tired) return 'tired'

  // 3. 悬着（独占档）：挂太多时，其他情绪盖不住它
  //
  //    两档设计（2026-11-26）：
  //      55 ≤ 悬 < 80 → 不占模式，作为修饰语附在别的后面
  //      悬 ≥ 80      → 独占「悬着」
  //
  //    为什么只设一档 55 不行：她挂着 10 条便条（悬=95）就永远显示「悬」，
  //    连 joy=80 也报「悬」——面板上再也看不到平静、开心、累。
  //    但「悬」是底色不是面具：她可以「开心地悬着」。
  //
  //    ⚠️ 顺序（2026-11-26 Codex 会审指出注释和代码对不上）：
  //      注释写的是「紧绷 > 累 > 悬着 > 空 > 委屈 > 开心」，
  //      但代码里悬着排在了空和委屈后面 —— 冲突。
  //      现在按注释修正：悬着独占档排在空/委屈前面，
  //      因为它有具体指向（有东西等着落地），比「空洞」和「委屈」更像当前的主要状态。
  //      但仍然低于累和紧绷（身体垮了、崩了更急）。
  if (d.suspense >= (t.suspenseAlone ?? 80)) return 'suspense'

  // 4. 空：社交枯竭，且没有「难过」的情绪底色
  //
  //    判在委屈前面 —— social 掉下来通常是「没人说话」，
  //    那种时候她不该显示成受伤。
  const sociallyEmpty = d.social <= t.lonely && d.attachment <= t.lonelyAttach
  const notSad = d.joy >= t.lonelyMinJoy
  if (sociallyEmpty && notSad) return 'lonely'

  // 5. 委屈：愉悦低 + 依恋低（心里有疙瘩）
  //
  //    注意：走到这里说明要么 social 还不算枯竭，
  //    要么 joy 太低（低于 lonelyMinJoy），那就确实是难过而不是单纯寂寞。
  if (d.joy <= t.wronged && d.attachment <= t.wrongedAttach) return 'wronged'

  // 6. 开心
  if (d.joy >= t.happy) return 'happy'

  return 'calm'
}

/**
 * 悬的修饰语：附在别的模式文案后面。
 *
 * 返回 '' 表示不用附（悬不够高，或者已经独占「悬」模式了）。
 */
export function suspenseSuffix(drives, mode, thresholds) {
  const d = { ...BASELINE, ...drives }
  const t = { ...MODE_THRESHOLDS, ...(thresholds || {}) }
  if (mode === 'suspense') return ''
  if (d.suspense < t.suspense) return ''
  return '另外，你手上还有几件事挂着没落地——不用反复想，能推的推一下就行。'
}

/**
 * 把「配置里的覆盖」合并进默认参数。
 *
 * 配置结构（都可以不写）：
 *   overrides: {
 *     baseline:      { joy: 55, ... },        // 覆盖基线
 *     decay:         { fatigue: 0.08, ... },  // 覆盖衰减率
 *     floor:         { social: 12, ... },     // 覆盖地板
 *     cap:           { joy: 50, ... },        // 覆盖每日上限
 *     thresholds:    { tired: 70, ... },      // 覆盖模式阈值
 *     effects:       { praise: { joy: 10 } }, // 覆盖单个事件的单个维度
 *   }
 *
 * 返回一组「实际生效」的参数，引擎内部一律用这份。
 */
export function resolveParams(overrides) {
  const o = overrides || {}
  const merge = (base, patch) => {
    if (!patch || typeof patch !== 'object') return { ...base }
    const out = { ...base }
    for (const [k, v] of Object.entries(patch)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
    }
    return out
  }

  const baseline = merge(BASELINE, o.baseline)
  const decay = merge(DECAY_RATE, o.decay)
  const floor = merge(FLOOR, o.floor)
  const cap = merge(DAILY_GAIN_CAP, o.cap)
  const thresholds = merge(MODE_THRESHOLDS, o.thresholds)

  // 事件增量：只覆盖显式写了的，其余保持原值
  const effects = { ...EVENT_EFFECTS }
  if (o.effects && typeof o.effects === 'object') {
    for (const [eventName, patch] of Object.entries(o.effects)) {
      if (!patch || typeof patch !== 'object') continue
      const base = effects[eventName]
      if (!base) continue
      const next = { ...base }
      for (const [dim, v] of Object.entries(patch)) {
        if (typeof v === 'number' && Number.isFinite(v)) next[dim] = v
      }
      effects[eventName] = next
    }
  }

  return { baseline, decay, floor, cap, thresholds, effects }
}

/** 九维距离：用于判断「情绪变了多少」 */
export function driveDistance(a, b) {
  let sum = 0
  for (const key of DRIVES) {
    const x = (a?.[key] ?? BASELINE[key])
    const y = (b?.[key] ?? BASELINE[key])
    sum += Math.abs(x - y)
  }
  return sum / DRIVES.length
}

/** 生成给澄看的一句话。不是 JSON，是自然语言。 */
export function renderMoodLine(drives, mode, reason, customHint) {
  const m = MODES[mode] || MODES.calm
  const parts = [customHint || m.hint]
  if (reason) parts.push(`（${reason}）`)
  return parts.join('')
}

// ── events.jsonl 扫描 ──────────────────────────────────────

/**
 * 从上次位置往后读 events.jsonl，把新事件翻译成情绪事件。
 * 返回 { events: [{ name, ts, reason }], cursor }
 */
export function scanEvents(file, cursor, opts = {}) {
  if (!existsSync(file)) return { events: [], cursor: cursor ?? { file, mtime: 0, size: 0, offset: 0 } }
  let st
  try {
    st = statSyncSafe(file)
  } catch {
    return { events: [], cursor: cursor ?? { file, mtime: 0, size: 0, offset: 0 } }
  }

  const prev = cursor && cursor.file === file ? cursor : { file, mtime: 0, size: 0, offset: 0 }
  // 判断「文件是不是被换过了」
  //
  // 三种情况：
  //   ① size 变小 → 肯定重写了，从头读
  //   ② mtime 比上次早 → 时间倒退了，也不可信，从头读
  //   ③ size 变大但头部变了（rare）→ 用前 64 字节指纹兜一下
  //
  // 为什么需要这个：文件被重写时如果直接从头读，
  // 那些「新写进去的旧内容」会被当成新事件再施加一遍
  // —— 情绪会莫名其妙地重复跳一次。
  const shrunk = st.size < (prev.size || 0)
  const wentBackInTime = Number.isFinite(prev.mtime) && st.mtimeMs < prev.mtime
  let fingerprintChanged = false
  if (!shrunk && !wentBackInTime && (prev.offset || 0) > 0) {
    // 文件变长了，检查头部有没有变（说明被整体重写过再追加）
    try {
      const head = readFileSyncSafe(file).slice(0, 64).toString('utf8')
      if (prev.head && prev.head !== head) fingerprintChanged = true
    } catch { /* 读不到就不判断 */ }
  }

  /**
   * 是否需要从头重读。
   *
   * 三个信号：文件变小了 / 时间戳倒退了 / 头部指纹变了。
   *
   * ⚠️ Codex 会审曾建议加「文件 generation」来防「大小不变但正文重写」。
   *    我查了源头，**不需要**：
   *      D:/dsh-fish-home/dsh-fish/updates/backup-v1.0.7/pkg/lib/store.js:5
   *      「events.jsonl 事件流，一行一条，永远只追加」
   *      第 244 行确实用的 fh.appendFile。
   *    既然源头保证只追加，现有三个信号已经够用。
   *    （如果哪天她的写入方式变了，这里要重新评估。）
   */
  const needFullReread = shrunk || wentBackInTime || fingerprintChanged
  const start = needFullReread ? 0 : (prev.offset || 0)
  if (start >= st.size) {
    return { events: [], cursor: { file, mtime: st.mtimeMs, size: st.size, offset: start } }
  }

  let text = ''
  try {
    const fd = readFileSyncSafe(file)
    text = fd.slice(start).toString('utf8')
  } catch {
    return { events: [], cursor: prev }
  }

  // 只处理完整的行（最后一行可能还没写完）
  const lastNewline = text.lastIndexOf('\n')
  const usable = lastNewline >= 0 ? text.slice(0, lastNewline + 1) : ''
  const consumed = Buffer.byteLength(usable, 'utf8')

  // 首次运行 或 全量重读 时，只回溯最近 N 小时。
  //
  // 为什么：events.jsonl 有 1700+ 条历史。一次性全喂进去会把情绪瞬间推满——
  // 实测 fatigue 冲到 62、social 掉到 15，看上去像她快累垮了，
  // 其实只是「把过去四天的账一次性清算」。情绪应该从「现在」开始算。
  //
  // ⚠️ 2026-11-26 Claude 会审指出：原来只有 isFirstRun 才截断，
  //    文件变小时触发的全量重读**不截断** —— 1700 条全量重放，
  //    her_spoke×1310 打钉 duty 的老问题原样回来，一次轮转就能把九维打爆。
  //    现在 needFullReread 也走同一条截断。
  const isFirstRun = !cursor || !cursor.file
  const needLookback = isFirstRun || needFullReread
  const lookbackMs = (opts.firstRunLookbackHours ?? 6) * 3600 * 1000
  const cutoff = needLookback ? Date.now() - lookbackMs : 0

  const events = []
  for (const line of usable.split('\n')) {
    if (!line.trim()) continue
    let e
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    const translated = translateEvent(e)
    if (!translated) continue
    if (needLookback && translated.ts < cutoff) continue
    events.push(translated)
  }

  return {
    events,
    // 首次运行还要把「最后一次有人说话」带出来，
    // 否则 silent_* 事件没法算（lastHeardAt 永远是 0）。
    lastHeardAt: needLookback ? findLastHeardTs(usable) : 0,
    cursor: {
      file,
      mtime: st.mtimeMs,
      size: st.size,
      offset: start + consumed,
      // 头部指纹：下次用来判断「文件是不是被整体重写过」
      head: (() => {
        try {
          return readFileSyncSafe(file).slice(0, 64).toString('utf8')
        } catch { return '' }
      })(),
    },
  }
}

/** 从文本里找最后一条「heard」的 ts（首次运行用） */
function findLastHeardTs(text) {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line)
      if (e?.type === 'heard') return Date.parse(e.ts) || 0
    } catch { /* 坏行跳过 */ }
  }
  return 0
}

/** 各情绪事件对应的人话原因 */
const HEARD_REASONS = {
  praise: '他说了句好话',
  blame_mild: '他好像有点不满',
  blame_hard: '他真的很生气',
  apology: '他道歉了',
  comfort: '他在安慰你',
}

/**
 * 把「听到的话」分类成情绪事件。
 *
 * 为什么不能只用关键词匹配（实测踩过）：
 *   「可爱是可爱，但是…」   → 含「可爱」但不是夸
 *   「真乖个屁」             → 含「真乖」但这是反讽
 *   「他说你做得不错」       → 是转述，不是对她说的
 *   「我不喜欢这样」         → 含「喜欢」但意思相反
 *
 * 所以按顺序做四道检查：
 *   1. 转述排除（「他说」「她讲」开头 → 不是对她说）
 *   2. 否定/反讽排除（「不」「屁」「才怪」「哪里」等）
 *   3. 转折排除（「但是」「不过」「可惜」）
 *   4. 才算真夸
 */
export function classifyHeard(text) {
  const s = String(text || '').trim()
  if (!s) return null

  // ── 1. 转述排除：说的人不是她 ──
  // 「他说你做得不错」「她说…」——是转述别人的话，不构成对她的评价
  if (/^(他|她|他们|她们|别人|人家|有人)(说|讲|觉得|认为|夸)/.test(s)) return null
  // 引用形式：「xxx 说：…」
  if (/[说讲][:：]/.test(s.slice(0, 8))) return null

  // ── 2. 道歉 / 安慰优先（这两个不需要排除，措辞本身明确）──
  if (/对不起|抱歉|是我不好|我错了/.test(s)) return 'apology'
  if (/别难过|没事的|不用担心|抱抱|别怕|我陪/.test(s)) return 'comfort'

  // ── 3. 责备 ──
  //
  // 2026-11-26 Codex 会审指出两个问题：
  //   ① 「你怎么这么可爱」被 /你怎么/ 误判成责备
  //   ② 「你怎么这么废物」本该是 blame_hard 却被降成 blame_mild
  //
  // 修法：
  //   · 先排除「你怎么这么 + 褒义词」这种夸奖句式
  //   · blame_hard 的判定挪到 blame_mild 前面（重的先判）

  // 先看是不是「你怎么这么 + 褒义」—— 那是夸，不是骂
  const HOW_PRAISE = /你怎么这么(可爱|厉害|棒|聪明|漂亮|好)/
  if (HOW_PRAISE.test(s)) return 'praise'

  // 重责先判（原来的顺序让「废物」被 mild 抢走）
  if (/滚|闭嘴|废物|没用|讨厌你|不想理/.test(s)) return 'blame_hard'

  if (/不对|错了|怎么又|你怎么|不应该|失望|受不了|烦死/.test(s)) return 'blame_mild'

  // ── 4. 夸奖：先排除否定和转折 ──
  const PRAISE = /谢谢|厉害|好棒|喜欢你|可爱|真乖|了不起|辛苦了|做得好|聪明|漂亮/
  if (PRAISE.test(s)) {
    // 反讽/否定：「真乖个屁」「可爱才怪」「哪里可爱」
    if (/屁|才怪|哪里|哪有|算不上|谈不上|一点都不/.test(s)) return null
    // 转折：「可爱是可爱，但是…」——后半句才是重点，前半句的夸不成立
    if (/但是|不过|可惜|就是有点|唯一/.test(s)) return null
    // 否定式：「我不喜欢这样」「别这么可爱」
    if (/(不|别|没)[^，。！？]{0,3}(喜欢|可爱|厉害|好)/.test(s)) return null
    return 'praise'
  }

  return null
}

/** 单条 events.jsonl 记录 → 情绪事件（可能返回 null） */
export function translateEvent(e) {
  const t = e?.type
  const ts = Date.parse(e?.ts || '') || Date.now()
  const text = String(e?.text || '')
  // 带上会话 id：heat 去重要按会话分开算，
  // 不然群里说的 10 句会把私聊的重复计数也带高。
  const sid = String(e?.sessionId || '')

  // 心跳不算
  if (t === 'meta') return null

  if (t === 'heard') {
    const who = e?.who?.id
    const isOwner = who === 'owner'
    const hit = classifyHeard(text)
    if (hit) return { name: hit, ts, sid, reason: HEARD_REASONS[hit] || '有人跟你说话了' }
    return { name: isOwner ? 'owner_msg' : 'user_msg', ts, sid, reason: '有人跟你说话了' }
  }

  if (t === 'utterance') {
    return { name: 'her_spoke', ts, sid, reason: '你说了句话' }
  }

  if (t === 'voice') {
    return { name: 'her_spoke', ts, sid, reason: '你出了声' }
  }

  // 她自己的行为（从 source / text 粗判）
  if (t === 'insight' || t === 'judgment') {
    return { name: 'her_recall', ts, sid, reason: '你想通了一件事' }
  }

  return null
}

// 小包装，避免 node:fs 和 node:fs/promises 混用出错
function statSyncSafe(file) {
  return statSync(file)
}
function readFileSyncSafe(file) {
  return readFileSync(file)
}

/**
 * 时间推进带来的一般性事件（缺席、深夜）。
 *
 * ⚠️ 两个必须去重的地方（都是实测踩过的）：
 *   1. 这个函数每 60 秒被调一次。silent_1h 若每次都返回，
 *      social 每小时会掉 120 点，三小时见底。
 *   2. late_night 同理，整夜会一直扣。
 *
 * 解法：按「阶段」去重 —— 只有跨进新阶段时才发一次。
 * 阶段值存在 state.silentStage / state.nightStage 里。
 */
export function timeSignals(state, nowMs) {
  const out = []
  const d = new Date(nowMs)
  const hour = d.getHours()

  // ── 深夜：只在「刚跨进这个时段」时发一次 ──
  let nightStage = ''
  if (hour >= 1 && hour < 5) nightStage = 'late'
  else if (hour >= 5 && hour < 8) nightStage = 'early'
  if (nightStage && nightStage !== state.nightStage) {
    out.push(
      nightStage === 'late'
        ? { name: 'late_night', ts: nowMs, reason: '已经很晚了' }
        : { name: 'early_morning', ts: nowMs, reason: '天刚亮' },
    )
  }

  // ── 缺席：只在跨阶段时发一次 ──
  const lastHeard = state.lastHeardAt
  if (lastHeard) {
    const hours = (nowMs - lastHeard) / 3600000
    let silentStage = ''
    if (hours >= 24) silentStage = '24h'
    else if (hours >= 6) silentStage = '6h'
    else if (hours >= 1) silentStage = '1h'
    if (silentStage && silentStage !== state.silentStage) {
      const reason = {
        '24h': '一整天没人说话',
        '6h': '半天没人说话了',
        '1h': '有一阵子没人说话',
      }[silentStage]
      out.push({ name: `silent_${silentStage}`, ts: nowMs, reason })
    }
  }

  return { events: out, nightStage, silentStage: computeSilentStage(state, nowMs) }
}

function computeSilentStage(state, nowMs) {
  const lastHeard = state.lastHeardAt
  if (!lastHeard) return ''
  const hours = (nowMs - lastHeard) / 3600000
  if (hours >= 24) return '24h'
  if (hours >= 6) return '6h'
  if (hours >= 1) return '1h'
  return ''
}
