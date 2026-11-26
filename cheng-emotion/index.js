/**
 * cheng-emotion — Host 半边 v0.2.0
 *
 * 三件事：
 *   1. 九维驱动引擎（engine.js）：读 events.jsonl，算出情绪
 *   2. systemPrompt.context 注入（order 950，放最后）：只在跨阈值时
 *      塞一句人话，平稳期返回空字符串，不把前面的前缀带掉
 *   3. HTTP 路由 + 工具：给面板和澄自己查
 *
 * 铁律（从 dsh-meme / dsh-windows-mcp 抄来的，都是踩过的坑）：
 *   - 路由必须包在 ctx.effect(() => webServer.register({...})) 里，否则热重载撞 duplicate route
 *   - 注入用 systemPrompt.context（dsh-fish-home 验证过），不用 pre-step：
 *     实测 pre-step 改 decision.messages 完全没生效，她的会话里 [心情] 出现 0 次
 *   - inject 里没声明的服务，连 ctx.get('x') 都会抛
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'

import {
  DRIVES,
  BASELINE,
  MODES,
  defaultState,
  loadState,
  saveState,
  appendHistory,
  applyEvent,
  deriveMode,
  driveDistance,
  renderMoodLine,
  scanEvents,
  timeSignals,
  localDay,
  resolveParams,
  MODE_THRESHOLDS,
  DECAY_RATE,
  FLOOR,
  DAILY_GAIN_CAP,
  EVENT_EFFECTS,
  suspenseSuffix,
  decay,
} from './engine.js'

import {
  loadGraph,
  memorySignals,
  graphDigest,
  growthDigest,
  memoryDigest,
  readSuspense,
  DEFAULT_GRAPH,
  DEFAULT_NOTES,
  graphFreshness,
  lastGraphMtime,
} from './memory-bridge.js'

export const name = 'cheng-emotion'

// systemPrompt 必须声明：没声明的服务连 ctx.get('x') 都会抛。
// agents 用于启动时补挂已有 agent。
export const inject = ['tools', 'webServer', 'systemPrompt', 'agents']

const ROUTE = '/cheng-emotion-api'

/** 九维的中文名（前端也有一份，但后端拼文字时要用） */
const DRIVE_LABELS = {
  attachment: '依恋',
  curiosity: '好奇',
  reflection: '反刍',
  duty: '责任',
  social: '社交',
  fatigue: '疲惫',
  intimacy: '亲密',
  stress: '压力',
  joy: '愉悦',
  suspense: '悬着',
}

/** 澄的 events.jsonl —— 她记自己经历的地方 */
const DEFAULT_EVENTS = 'D:/dsh-fish-home/dsh-fish/events.jsonl'

/** 配置默认值 */
const DEFAULT_CONFIG = {
  enabled: true,
  inject: true,
  injectThreshold: 15,
  eventsPath: DEFAULT_EVENTS,
  dataDir: '',
  /** 星图联动开关：情绪可以从「她记忆里的事」触发 */
  graphEnabled: true,
  /** 星图路径 */
  graphPath: DEFAULT_GRAPH,
  /** 便条路径（「悬着」的数据源） */
  notesPath: DEFAULT_NOTES,
  /** 是否从便条算「悬」 */
  suspenseEnabled: true,
  /**
   * 文案多久算「过时」，单位天。
   *
   * 原本写死 60 天，太长了——她每天都在长，
   * 两个月后那几段大概率已经不是她的样子。
   * 改成可设置，默认 5 天：一周不到就该确认一次。
   */
  promptsStaleDays: 5,
}

/**
 * 配置文件路径。
 *
 * 支持环境变量重定向（2026-11-26 Claude 会审指出测试会污染真实数据）：
 *   有 CHENG_EMOTION_CONFIG_DIR 就用它，否则 ~/.dsh
 * 测试时指到临时目录，就不会动到用户真实配置。
 */
function configPath() {
  const base = process.env.CHENG_EMOTION_CONFIG_DIR
    || path.join(os.homedir(), '.dsh')
  return path.join(base, 'cheng-emotion.json')
}

/**
 * 数据目录（state.json / history.jsonl / injections.jsonl 都在这）。
 *
 * 同样支持环境变量重定向：
 *   有 CHENG_EMOTION_DATA_DIR 就用它，否则 ~/.dsh/cheng-emotion-data
 * 优先级：config.dataDir > 环境变量 > 默认
 */
function dataDir(config) {
  return config?.dataDir
    || process.env.CHENG_EMOTION_DATA_DIR
    || path.join(os.homedir(), '.dsh', 'cheng-emotion-data')
}

function stateFile(config) {
  return path.join(dataDir(config), 'state.json')
}

/** 注入历史：每次真的注入一句心情时记一条 */
function injectionsFile(config) {
  return path.join(dataDir(config), 'injections.jsonl')
}

function historyFile(config) {
  return path.join(dataDir(config), 'history.jsonl')
}

async function readConfig() {
  const file = configPath()
  try {
    const raw = await readFile(file, 'utf8')
    const parsed = raw ? JSON.parse(raw) : {}
    return { ...DEFAULT_CONFIG, ...parsed }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

/**
 * 参数范围表 —— 唯一真相。
 *
 * 2026-11-26 Codex 会审指出：之前只有 `/params` 做范围校验，
 * `POST /config` 和工具的 set 直接 writeConfig，`decay: 2` 能进引擎
 * → `1-(1-2)^hours` = `(-1)^hours`，正负来回跳，数值直接 NaN。
 *
 * 现在所有写入口都过这一个函数。
 */
const PARAM_RANGES = {
  decay: [0, 1],
  baseline: [0, 100],
  floor: [0, 100],
  cap: [0, 500],
  thresholds: [0, 100],
}

/**
 * 把 overrides 里的数值夹到合法范围，丢掉非法值。
 * @returns {{ok: boolean, value: object, dropped: string[]}}
 */
function sanitizeOverrides(raw) {
  const dropped = []
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, value: {}, dropped: ['overrides 不是对象'] }
  }
  const value = {}
  for (const [group, [lo, hi]] of Object.entries(PARAM_RANGES)) {
    const src = raw[group]
    if (src === undefined) continue
    if (!src || typeof src !== 'object' || Array.isArray(src)) {
      dropped.push(group + ' 不是对象')
      continue
    }
    const clean = {}
    for (const [k, v] of Object.entries(src)) {
      const n = Number(v)
      if (!Number.isFinite(n)) { dropped.push(`${group}.${k}=${v} 不是有限数`); continue }
      if (n < lo || n > hi) { dropped.push(`${group}.${k}=${n} 超出 [${lo},${hi}]`); continue }
      clean[k] = n
    }
    if (Object.keys(clean).length > 0) value[group] = clean
  }
  return { ok: true, value, dropped }
}

async function writeConfig(patch) {
  /**
   * overrides 一律过范围校验（唯一入口，/params 和 /config 都走这里）。
   *
   * ⚠️ writeConfig 是模块级函数，拿不到 apply() 里的 ctx，
   *    所以这里不写日志，把 dropped 挂到返回值上让调用方记。
   *    （第一版我错写成 ctx.logger，直接 ReferenceError → 所有写配置都 500）
   */
  let dropped = []
  if (patch && typeof patch === 'object' && patch.overrides !== undefined) {
    const r = sanitizeOverrides(patch.overrides)
    if (!r.ok) throw new Error('overrides 必须是对象')
    dropped = r.dropped
    patch = { ...patch, overrides: r.value }
  }
  const file = configPath()
  const current = await readConfig()
  const next = { ...current, ...patch }
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(next, null, 2), 'utf8')
  // 返回值保持是 config 本身（调用点都用它当 config 用），
  // 丢弃记录挂在不可枚举属性上 —— JSON 序列化时不会带出去。
  Object.defineProperty(next, 'droppedParams', {
    value: dropped, enumerable: false, writable: true, configurable: true,
  })
  return next
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export function apply(ctx) {
  const webServer = ctx.webServer ?? (typeof ctx.get === 'function' ? ctx.get('webServer') : undefined)

  /** 内存态：避免每次请求都读盘 */
  let cached = null
  let cachedAt = 0
  const CACHE_MS = 3000

  /**
   * tick 的并发锁。
   *
   * 为什么需要：三个地方都会调 tick ——
   *   · 面板 GET /state（每 20 秒）
   *   · 星图变更监听（每 5 秒查，变了就 tick）
   *   · 兜底定时器（每 60 秒）
   * 它们可能同时进来。没有锁的话，两个 tick 会各自读一份 state、
   * 各自算一遍、各自写回 —— 后写的覆盖前写的，事件被吞掉。
   */
  let ticking = null

  /**
   * 把一次「读 state → 改 → 写回」的操作串到 tick 锁上。
   *
   * 2026-11-26 Claude 会审指出：/poke 和 /reset 原来不走锁，
   * 面板点「重置」的同时后台 60 秒 tick 在跑 →
   * loadState/applyEvent/saveState 交错，后写覆盖先写。
   * 现在这些写接口也排进同一个队。
   */
  function withTickLock(fn) {
    if (ticking) {
      // 有 tick 在跑：等它完，再接自己的活
      return ticking.catch(() => {}).then(() => withTickLock(fn))
    }
    ticking = Promise.resolve(fn()).finally(() => { ticking = null })
    return ticking
  }

  /**
   * 推进一次：扫新事件 + 时间信号 → 施加 → 落盘。
   * 返回 { state, changed, delta, events }
   */
  function tick(options = {}) {
    if (ticking) return ticking
    ticking = tickInner(options).finally(() => { ticking = null })
    return ticking
  }

  async function tickInner(options = {}) {
    const config = await readConfig()
    if (!config.enabled) {
      const state = await loadState(stateFile(config), Date.now())
      if (state === null) return { config, state: null, changed: false, delta: {}, events: [], mode: 'calm' }
      return { config, state, changed: false, delta: {}, events: [], mode: deriveMode(state.drives, resolveParams(config.overrides).thresholds) }
    }

    const now = Date.now()
    let state = await loadState(stateFile(config), now)
    // null = 文件存在但读不了（损坏/被锁）。跳过这一轮，不要用默认值覆盖。
    if (state === null) {
      return { config, state: null, changed: false, delta: {}, events: [], mode: 'calm' }
    }
    // 实际生效的参数（默认常量 + 配置覆盖）
    const P = resolveParams(config.overrides)

    // 1. 扫新事件（首次运行只回溯最近 6 小时，不把历史账一次性清算）
    const scanned = scanEvents(config.eventsPath || DEFAULT_EVENTS, state.eventsCursor)
    state.eventsCursor = scanned.cursor
    if (scanned.lastHeardAt) state.lastHeardAt = scanned.lastHeardAt

    // 2. 推进「上次听到人说话」的时间 —— 必须在 timeSignals 之前。
    //
    // ⚠️ 2026-11-26 Claude 会审指出两个问题：
    //   ① 原来漏了 blame_hard —— 被痛骂一句之后「有人说话」时间不更新，
    //      于是 silent_1h 照常触发，被骂完一小时反而报「有一阵子没人说话」。
    //   ② 原来这段在 timeSignals 之后，所以本轮刚听到的话还没算进去，
    //      同一批事件里 silent_1h 和 user_msg 并存，虚增一次缺席。
    const HEARD_KINDS = new Set([
      'owner_msg', 'user_msg', 'praise',
      'blame_mild', 'blame_hard',
      'apology', 'comfort',
    ])
    const heardAt = scanned.events.filter((e) => HEARD_KINDS.has(e.name))
    if (heardAt.length > 0) {
      state.lastHeardAt = heardAt[heardAt.length - 1].ts
      // 有人说话了 → 缺席阶段归零，下次再静默会重新计
      state.silentStage = ''
    }

    // 3. 时间信号（缺席、深夜）—— 已按阶段去重，不会每 tick 重复
    const signalsResult = timeSignals(state, now)
    const signals = signalsResult.events || []
    // 记录阶段，下次同一个阶段就不重复发了
    if (signalsResult.nightStage !== undefined) state.nightStage = signalsResult.nightStage
    if (signalsResult.silentStage !== undefined) state.silentStage = signalsResult.silentStage

    // 4. 星图信号（记忆联动）
    let memEvents = []
    if (config.graphEnabled) {
      const graph = await loadGraph(config.graphPath)
      const mem = memorySignals(graph, state.memorySeen, now)
      if (mem.seen) state.memorySeen = mem.seen
      memEvents = mem.events || []
    }

    // 5. 合并，按时间排序施压
    const all = [...scanned.events, ...signals, ...memEvents].sort((a, b) => a.ts - b.ts)


    const before = { ...state.drives }
    const beforeRecentLen = (state.recent || []).length   // 判「要不要写盘」用
    for (const e of all) {
      const r = applyEvent(state, e.name, e.ts, { intensity: e.intensity, params: P, sid: e.sid })
      if (!r.applied) {
        // 2026-11-26 Claude 会审指出：额度打满后 applied=false，
        // 原来 continue 会把 heat/praiseAt/gainLog 的更新一起丢掉 ——
        // 额度一恢复，去重折扣从零开始，同一波连夸又能全额进账。
        // 现在记账字段无论如何都合回去。
        const { delta: _d, applied: _a, ...partial } = r
        state = { ...state, ...partial }
        continue
      }
      // 只合回「要留的状态字段」，delta/applied 是瞬时值，不该进 state.json
      const { delta: _d, applied: _a, ...persist } = r
      state = { ...state, ...persist }
    }
    // ④.5 「悬」不入事件流，直接由 notes.json 的 waiting 条数定。
    //
    // 为什么不像别的维度那样走 applyEvent：
    //   悬不是「一件事推一下、然后衰减」，它是一个持续的状态——
    //   便条挂着，它就一直在；便条关了，它才落地。
    //   所以每一轮都直接重算，而不是加减。
    //
    // ⚠️ 2026-11-26 Claude 会审指出：原来这段在 deltas 计算**之后**，
    //    导致只动「悬」的那一轮 changed=false、不写 history、updatedAt 不刷新
    //    —— 面板「更新于」冻结、走势没记录、最近影响看不到悬的变化。
    //    55~79 修饰语档在整个留痕系统里是盲区。现在挪到 deltas 之前。
    if (config.suspenseEnabled !== false) {
      try {
        const sus = readSuspense(config.notesPath || DEFAULT_NOTES)
        // readSuspense 返回 null 表示「读失败」，不是「0 条」
        // 这时保留上一次的值，不要掉回基线 10
        if (sus === null) throw new Error('notes 读不到')
        /**
         * 悬着的算法（2026-11-26 用户实测后重写）。
         *
         * ⚠️ 原来的问题：`10 + count*7 + min(oldest,7)*3`
         *    → 10 条「等爸爸决定要不要装插件」的 note = 10+70+15 = 95
         *    → **恒定 95，永远悬着**，因为她没权力关掉这些 note。
         *    面板上 8 小时全是「悬着」，用户直接问「怎么一直悬着也不解决」。
         *
         * 根因：把「她在等别人」和「她自己拖着没做」混成一个数。
         *   等别人 → 她做不了什么，不该一直推高她的悬着
         *   自己能推进 → 拖着才是真信号
         *
         * 新算法：
         *   · waiting_self（自己能推进）：每条 +8，这才是主信号
         *   · waiting_other（等别人）：每条 +1.5，封顶 12（等久了会烦，但不是主导）
         *   · 「最老挂了多久」只对 self 生效（等别人的年龄不该累加压力）
         */
        const items = sus.items || []
        const selfItems = items.filter((x) => x.kind === 'waiting_self')
        const otherItems = items.filter((x) => x.kind !== 'waiting_self')

        const oldestSelf = selfItems.reduce((m, x) => Math.max(m, x.ageDays || 0), 0)
        const otherWeight = Math.min(12, otherItems.length * 1.5)
        const raw = 10 + selfItems.length * 8 + Math.min(oldestSelf, 7) * 3 + otherWeight

        state.drives.suspense = Math.max(0, Math.min(100, raw))

        // 面板要能看出「哪些是等她能推的、哪些是在等人」
        state.suspenseInfo = {
          count: items.length,
          selfCount: selfItems.length,
          otherCount: otherItems.length,
          // 优先展示自己能推进的（那是她该动的事）
          items: [
            ...selfItems.slice(0, 3),
            ...otherItems.slice(0, 2),
          ].slice(0, 4),
        }
      } catch { /* 读不到就保持上一次的值 */ }
    }

    // 用「前后差值」而不是累加 delta：delta 是原始增量之和，
    // 会被 FLOOR / DAILY_GAIN_CAP 截断，累加起来能到几百，看着像 bug。
    const deltas = {}
    for (const k of DRIVES) {
      const d = (state.drives[k] ?? 0) - (before[k] ?? 0)
      if (Math.abs(d) >= 0.1) deltas[k] = +d.toFixed(1)
    }

    // 4. 推进衰减时间（即使没事件也要走，否则下次从旧时间点重算）
    if (all.length === 0) {
      state.drives = decay(state.drives, state.decayedAt ?? now, now, P)
      state.decayedAt = now
    }

    // 5. 更新模式
    const prevMode = state.mode
    state.mode = deriveMode(state.drives, P.thresholds)

    // 5.5 判断这一轮要不要注入心情，要的话记下快照。
    //
    // 为什么在这里算而不是在 text() 里算：
    //   text() 是同步回调，不能做 IO；而且它每轮会被调一次，
    //   在里面写盘会造成「读提示词时顺便改状态」的诡异副作用。
    //   在这里算好、存进 lastInjected，text() 只做一次纯比较。
    {
      const last = state.lastInjected
      const dist = last ? driveDistance(state.drives, last.drives) : Infinity
      const modeChanged = last && last.mode !== state.mode
      const bigShift = !last || dist >= (config.injectThreshold || 15)
      if (modeChanged || bigShift) {
        state.lastInjected = { ts: now, mode: state.mode, drives: { ...state.drives } }
      }
    }
    // updatedAt 只在情绪真的变了时才动。
    // 原来每 tick 都写，导致面板永远显示「0 秒前」——
    // 看着像刚更新，实际什么都没变，反而让人以为它在乱跳。
    if (Object.keys(deltas).length > 0 || prevMode !== state.mode) {
      state.updatedAt = now
    } else if (!state.updatedAt) {
      state.updatedAt = now
    }

    // 6. 记录最近影响（面板用）
    // 只在「真的有事件推了情绪」时记。纯衰减不算——
    // 否则面板会被「衰减 0.1」这种条目刷满，看不出发生了什么。
    if (Object.keys(deltas).length > 0 && all.length > 0) {
      const top = Object.entries(deltas)
        .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
        .slice(0, 3)
        .map(([k, v]) => ({ drive: k, delta: +v.toFixed(1) }))
      // 存 reason 而不只是事件名：面板上「反刍 +2.8」旁边得有人话，
      // 不然看不出是「又想到某件事」还是「他夸你了」。
      const reasons = [...new Set(all.map((e) => e.reason).filter(Boolean))]
      state.recent = [
        { ts: now, top, events: all.slice(-5).map((e) => e.name), reasons: reasons.slice(0, 3) },
        ...(state.recent || []),
      ].slice(0, 20)
    }

    /**
     * 只在「确实变了」时写盘（2026-11-26 Codex 会审指出）。
     *
     * 原来每个 tick 无条件 saveState：面板轻量轮询 20 秒一次、
     * 兜底 60 秒一次、每轮 pre-step 一次 —— 一天下来上万次 44KB 原子重写，
     * 既费磁盘又放大并发写冲突。
     *
     * 判断「变了」的口径：
     *   · 有 delta（维度动了）
     *   · 模式变了
     *   · 有新事件（recent 可能更新了）
     *   · recent 长度变了
     *   · suspenseInfo 变了
     * 否则只是衰减走了个时间戳，下次读回来重算即可，不写。
     */
    const recentLenChanged = (state.recent || []).length !== (beforeRecentLen || 0)
    const shouldSave = Object.keys(deltas).length > 0
      || prevMode !== state.mode
      || all.length > 0
      || recentLenChanged
    if (shouldSave) {
      await saveState(stateFile(config), state)
    }
    if (Object.keys(deltas).length > 0 || prevMode !== state.mode) {
      await appendHistory(historyFile(config), {
        ts: now,
        day: localDay(now),
        drives: state.drives,
        mode: state.mode,
        prevMode,
        delta: deltas,
        events: all.map((e) => e.name),
      }).catch(() => {})
    }

    cached = { config, state, dataDir: dataDir(config) }
    cachedAt = now

    return {
      config,
      state,
      changed: Object.keys(deltas).length > 0 || prevMode !== state.mode,
      delta: deltas,
      events: all.map((e) => ({ name: e.name, ts: e.ts, reason: e.reason })),
      mode: state.mode,
      prevMode,
    }
  }

  // ── 定时推进（后台，不占请求） ─────────────────────────────
  //
  // 两条节奏：
  //   1. 每 5 秒查一次「星图是否刚更新」—— 变了就立刻 tick，
  //      这样星图重导完（export-graph.py 落盘）后情绪马上跟着动，
  //      延迟基本等于星图自己的导出延迟，加 0。
  //   2. 兜底每 60 秒 tick 一次，保证没人访问面板时情绪也在动（衰减）。
  try {
    let lastSeenGraphMtime = 0
    const fastTimer = setInterval(() => {
      readConfig().then((config) => {
        if (!config.enabled || !config.graphEnabled) return
        const fresh = graphFreshness(config.graphPath)
        if (!fresh.exists) return
        if (fresh.mtime !== lastSeenGraphMtime) {
          lastSeenGraphMtime = fresh.mtime
          // 星图刚更新过（30 秒内才算「刚」），立刻处理
          if (fresh.ageMs < 30_000) tick().catch(() => {})
        }
      }).catch(() => {})
    }, 5_000)
    fastTimer.unref?.()
    ctx.effect(() => () => clearInterval(fastTimer), 'cheng-emotion: 星图变更监听')

    const slowTimer = setInterval(() => { tick().catch(() => {}) }, 60_000)
    slowTimer.unref?.()
    ctx.effect(() => () => clearInterval(slowTimer), 'cheng-emotion: 兜底推进')
  } catch { /* 没有 setInterval 也不影响 */ }

  // ── 心情注入（systemPrompt.context，order 950） ────────────
  //
  // 为什么用 systemPrompt.context 而不是 agent/pre-step：
  //   pre-step 那套（改 decision.messages）我实测过 —— 她的会话里
  //   `[心情]` 出现 0 次，完全没生效。而且它只读不写、没有先例可参考。
  //
  //   systemPrompt.context 是 dsh-fish-home 在用的成熟机制：
  //     agent.ctx.systemPrompt.context({ name, order, text: () => ... })
  //   它的注释写明「渲染出来是历史尾巴上一条 user 消息」——
  //   挂在历史后面，不是改系统提示词开头。
  //
  // 为什么 order: 950（放最后）：
  //   dsh-fish 的 reorderVolatile 会把「连续几轮都在变」的段挪到最后，
  //   前面前缀才能稳定命中缓存。放 950 跟 fish-home 一致，
  //   属于「本来就会变的那一截」，不会把前面整条带掉。
  //
  // 关于缓存：
  //   这一段放在 order 950（最后）。平稳期它返回的内容是**固定的**
  //   （比如一直是「你现在是平静的。」），字节不变 → 前缀照样命中。
  //   只有真的变了才换字，那时候本来就要重算，代价是应该付的。
  const EMOTION_ORDER = 950
  const moodRegistered = new WeakMap()   // agent -> disposer

  /**
   * 是否走 systemPrompt.context 兜底注入。
   *
   * false（默认）：只用 pre-step 追加独立 user 消息。
   *   界面显示「上下文注入 · cheng-emotion」，能一眼看出是谁。
   * true：改走 systemPrompt.context（order 950）。
   *   界面显示「上下文注入 · runtime-context」，分不出是谁，但位置更靠前。
   * 改这个值只影响「用哪条路」，两条路注入的文本完全一样。
   */
  const MOOD_VIA_SYSTEM_PROMPT = false

  /**
   * 这一轮给她看什么心情。
   *
   * 改过一版：原来「10 分钟内没变化就返回空字符串」，
   * 结果实测她一直平静、lastInjected 停在 20 分钟前，
   * text() 永久返回 '' —— 等于「平静 = 永远不说话」，注入形同虚设。
   *
   * 现在分两档：
   *   有变化（10 分钟内）→ 完整一句 + 原因
   *   没变化             → 极简一句「（平静）」
   * 平静时只有四个字，占的 token 极少，但保证她每轮都知道自己在什么状态。
   */
  const MOOD_FRESH_MS = 10 * 60 * 1000

  /**
   * 算这一轮要注入什么。
   *
   * ⚠️ 关键约束：注入的消息会**永久留在会话历史里**。
   *
   * DSH 没有 AstrBot 那种 mark_as_temp()（扒过 app.asar，没有 ephemeral/transient
   * 这类字段），所以这条消息一旦追加就删不掉了。
   * 这意味着「每轮都注入一句一样的话」会一路累积：
   *   第 100 轮时，历史里有 100 条「你现在很平静」≈ 2000 token，
   *   而且每一轮都要重新读一遍。
   *
   * 所以这里做三层收敛：
   *   ① 算出来的文案和上次注入的**一字不差** → 不注入（最常见的情况）
   *   ② 上次注入距今不到 MIN_GAP_MS（默认 30 分钟）→ 不注入
   *   ③ 只有「文案变了」或「超过 30 分钟」才真的塞一条
   *
   * 副作用：她可能连着几十轮看不到心情。但那是**对的** ——
   * 情绪没变的时候，本来就不需要每轮告诉她。
   */
  const MIN_GAP_MS = 30 * 60 * 1000
  /**
   * 「同样的话」的压制窗口。
   *
   * 只用来防止「连着几轮反复塞同一句」，不是用来管频率 ——
   * 频率归 MIN_GAP_MS（30 分钟）管。
   *
   * 取 5 分钟：一轮对话通常也就几分钟，
   * 压住这几轮就够，再长就会变成「重启后发现心情行没了」那个 bug。
   */
  const SHORT_REPEAT_MS = 5 * 60 * 1000

  function moodTextFor(state, config, sid) {
    try {
      const sessionKey = String(sid || '')
      const mode = state.mode || 'calm'
      const last = state.lastInjected
      const fresh = last && Date.now() - last.ts <= MOOD_FRESH_MS

      const custom = (config && config.prompts && config.prompts[mode]) || ''
      const m = MODES[mode] || MODES.calm
      const suffix = suspenseSuffix(state.drives, mode, config.overrides?.thresholds)

      let text
      if (fresh) {
        // 刚变化过：完整一句 + 原因
        const reason = (state.recent && state.recent[0] && state.recent[0].reasons && state.recent[0].reasons[0]) || ''
        const line = renderMoodLine(state.drives, mode, reason, custom)
        text = '[心情] ' + line
      } else {
        // 平稳期：只给状态 + 一句行动指导，不解释原因
        const base = custom || m.hint
        text = `[心情] ${base}`
      }
      if (suffix) text += ' ' + suffix

      const atBySession = state.lastMoodInjectAt || {}
      const prevAt = atBySession[sessionKey]
      const sinceLast = prevAt ? Date.now() - prevAt : Infinity

      /**
       * ① 这个会话上一次注入太近 → 不塞。
       *
       * 2026-11-26 Codex 会审指出：原来是全局 `state.lastInjected.ts`，
       * 会话 A 注入后会话 B 的真实变化也被压 30 分钟。
       * 现在按会话记时间（lastMoodInjectAt）。
       *
       * 注意这里**先判时间、再判内容** —— 顺序反了会出大问题，见 ②。
       */
      if (sinceLast < MIN_GAP_MS) return ''

      /**
       * ② 内容和上次一样 → 不重复塞（但**只挡一小会儿**）。
       *
       * ⚠️ 2026-11-26 实测踩到的坑（用户重启后发现心情行没了）：
       *    原来这条是**独立的第一道闸**，只比较文本、完全不看时间：
       *      if (prev === text) return ''
       *    结果某个会话注入过一句之后，只要心情一直没变，
       *    它就**永远**不再注入 —— 重启、开新话题都没用，
       *    因为 lastMoodTextBySession 把那一句记住了。
       *
       *    实测证据：session-16233100 在 16:23 注入过一次，
       *    之后 30 分钟里被时间闸挡，再往后就被这道文本闸永久挡死。
       *
       * 现在：同样内容只压 SHORT_REPEAT_MS（5 分钟）——
       * 也就是「连着两三轮别重复」，但过了 5 分钟就正常重提。
       * 配合上面的 MIN_GAP_MS（30 分钟）实际生效的就是 30 分钟一次。
       */
      const bySession = state.lastMoodTextBySession || {}
      const prev = bySession[sessionKey]
      if (prev === text && sinceLast < SHORT_REPEAT_MS) return ''

      return text
    } catch {
      return ''
    }
  }

  /**
   * 构造一条插件自己的 user 消息。
   *
   * 为什么不用 systemPrompt.context：
   *   那个接口只能往宿主硬编码的 `runtime-context` 消息里塞 section，
   *   界面上所有走这个接口的插件都显示成「上下文注入 · runtime-context」，
   *   分不出是谁。实测确认过：runtime-context.ts 里 SOURCE 是写死的。
   *
   * dsh-mnemon 的做法（已验证能单独显示「上下文注入 · dsh-mnemon」）：
   *   agent/pre-step 里返回新的 decision，
   *   messages: [...decision.messages, 自己构造的 user 消息]
   *   消息的 source.kind 写自己的包名 → 界面按它渲染。
   */
  function createEmotionMessage(text) {
    return {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'cheng-emotion', form: 'notice' },
    }
  }

  function attachMood(agent) {
    try {
      // 兜底开关：默认关。
      // 现在主路径是 pre-step 追加独立消息（界面能单独显示 cheng-emotion），
      // 这一条只在 pre-step 挂不上时手动打开用。
      // 两条同时开会重复注入同一句话，所以默认只留 pre-step。
      if (!MOOD_VIA_SYSTEM_PROMPT) return
      const sp = agent?.ctx?.systemPrompt
      if (!sp || typeof sp.context !== 'function') return
      if (moodRegistered.has(agent)) return
      const off = sp.context({
        name: 'cheng-emotion',
        order: EMOTION_ORDER,
        text: () => {
          // 同步返回：宿主每轮组装提示词时调它。
          // 用最近一次 tick 缓存的状态，不在这里做异步 IO。
          try {
            if (!cached || !cached.state) return ''
            const cfg = cached.config || {}
            if (!cfg.enabled || !cfg.inject) return ''
            return moodTextFor(cached.state, cfg)
          } catch {
            return ''
          }
        },
      })
      moodRegistered.set(agent, off)
    } catch (error) {
      try { ctx.logger?.warn?.(`[cheng-emotion] 挂心情失败：${String(error?.message ?? error)}`) } catch {}
    }
  }

  // ── pre-step 追加独立消息（界面会显示「上下文注入 · cheng-emotion」） ──
  //
  // 写法照 dsh-mnemon（它已经成功做到了这件事）：
  //   先 next() 拿宿主决策，然后**返回一个新的 decision**，
  //   messages 用展开新建，绝不原地改。
  //
  // 之前我犯过的错：写成 decision.messages[last].content += text，
  // 那是改「最后一条用户消息」，既不对也不生效（实测 [心情] 出现 0 次）。
  try {
    ctx.on('agent/pre-step', async (payload, next) => {
      const decision = typeof next === 'function' ? await next() : undefined
      try {
        const config = await readConfig()
        if (!config.enabled || !config.inject) return decision
        if (!decision || decision.kind !== 'enter') return decision

        // 所有会话都注入（2026-11-26 用户定）。
        //
        // 原来这里有一道门：只在 fish-room.json 绑定的那间会话里注入，
        // 理由是「别打扰别的会话」。但那等于她在 QQ 群/别的房间说话时
        // 完全不知道自己的心情——用户明确要求去掉。
        //
        // 情绪本来就是全局一份：她在哪说话都是同一个她，
        // 只是在哪个房间说而已。
        const result = await tick()
        if (!result.state) return decision
        const sid = String(payload?.agent?.session?.header?.id ?? payload?.agent?.session?.id ?? '')
        const text = moodTextFor(result.state, config, sid)
        if (!text) return decision

        // 记一条注入历史（面板「注入」页要看）
        //
        // state.lastInjected 只存最后一次，翻不了历史。
        // 单独记 jsonl：什么时候、什么模式、什么话、当时九维多少。
        try {
          const st = result.state
          await appendHistory(injectionsFile(config), {
            ts: Date.now(),
            mode: st.mode,
            label: (MODES[st.mode] || MODES.calm).label,
            text,
            sid,
            drives: Object.fromEntries(DRIVES.map((k) => [k, +st.drives[k].toFixed(1)])),
          }).catch(() => {})
        } catch { /* 记录失败不影响注入 */ }

        // 记下这次注入的原文 —— 下一轮拿它比，
        // 一字不差就不再重复塞（防止会话历史里堆满同一句话）
        //
        // 这里必须真的写盘：下一轮 tick 会 loadState 从磁盘读，
        // 只放内存的话去重记录就丢了（试过，测试直接挂）。
        try {
          const skey = String(sid || '')

          // ① 记这次注入的原文
          const bySession = result.state.lastMoodTextBySession || {}
          bySession[skey] = text
          // 上限清理（2026-11-26 Codex 会审：原来无上限增长）
          const tkeys = Object.keys(bySession)
          if (tkeys.length > 20) {
            for (const k of tkeys.slice(0, tkeys.length - 20)) delete bySession[k]
          }
          result.state.lastMoodTextBySession = bySession

          // ② 记这个会话的注入时间（频率闸按会话，不再用全局 lastInjected.ts）
          const atBySession = result.state.lastMoodInjectAt || {}
          atBySession[skey] = Date.now()
          const akeys = Object.keys(atBySession)
          if (akeys.length > 20) {
            for (const k of akeys.slice(0, akeys.length - 20)) delete atBySession[k]
          }
          result.state.lastMoodInjectAt = atBySession

          await saveState(stateFile(config), result.state)
          // 同步到 cache，避免下一次 tick 用到旧的那份
          if (cached) cached.state = result.state
        } catch { /* 存不下也不影响这次注入 */ }

        // 关键：新建数组，不原地改
        return { ...decision, messages: [...decision.messages, createEmotionMessage(text)] }
      } catch (error) {
        try { ctx.logger?.warn?.(`[cheng-emotion] pre-step 注入失败：${String(error?.message ?? error)}`) } catch {}
        return decision
      }
    }, { prepend: false })
  } catch (error) {
    ctx.logger?.warn?.(`[cheng-emotion] pre-step 挂不上：${String(error?.message ?? error)}`)
  }

  // 每个 agent 创建时挂一次；已经在的也补挂
  try {
    ctx.on('agent/created', (payload) => { attachMood(payload?.agent) })
  } catch { /* 没有这个事件也不影响 HTTP 部分 */ }

  // 启动时把现有 agent 也挂上。
  //
  // 为什么需要：她的 agent 早就存在了，重启时不会重新发 agent/created。
  // 只等 created 的话，已存在的会话永远挂不上 —— 实测就是这样，
  // lastInjected 停在 09:53 再没动过。
  //
  // agents 服务的 API 是 .get(id)，不是 .list()（从 dsh-fish-home 抄的）。
  // session id 有两种写法（带/不带 "session-" 前缀），两个都试。
  function findAgentById(id) {
    const raw = String(id == null ? '' : id).trim()
    if (!raw) return undefined
    const agents = ctx.agents || (typeof ctx.get === 'function' ? ctx.get('agents') : undefined)
    if (!agents || typeof agents.get !== 'function') return undefined
    const candidates = [raw]
    if (raw.startsWith('session-')) candidates.push(raw.slice('session-'.length))
    else candidates.push('session-' + raw)
    for (const c of candidates) {
      try {
        const a = agents.get(c)
        if (a) return a
      } catch { /* 试下一个 */ }
    }
    return undefined
  }

  /**
   * 把她绑定的那间会话挂上（配置里写的是哪间就是哪间）。
   *
   * ⚠️ 2026-11-26 修过一个真 bug：
   *   readConfig() 是 async 的，原来这里写的是
   *     const cfg = readConfig()      ← 没 await
   *     const ids = cfg?.sessionIds   ← Promise 上没这个字段
   *   结果 sessionIds 永远是 undefined，「按配置补挂」这条从来没生效过。
   *   （从 fish-room.json 那条路子是好的，所以功能没完全坏，但配了也没用。）
   */
  async function attachKnownSessions() {
    try {
      // 1. 先试 fish-room.json 里绑的会话
      const roomFile = path.join(os.homedir(), '.dsh', 'fish-room.json')
      if (existsSync(roomFile)) {
        const room = JSON.parse(readFileSync(roomFile, 'utf8'))
        if (room?.会话) {
          const a = findAgentById(room.会话)
          if (a) attachMood(a)
        }
      }
    } catch { /* 读不到就跳过 */ }

    try {
      // 2. 再试 config 里显式配的会话（await 上）
      const cfg = await readConfig()
      const ids = cfg?.sessionIds
      if (Array.isArray(ids)) {
        for (const id of ids) {
          const a = findAgentById(id)
          if (a) attachMood(a)
        }
      }
    } catch { /* 同上 */ }
  }

  // 启动时立即挂一次（异步，不阻塞）
  attachKnownSessions().catch(() => {})
  // 之后每 30 秒补一次（会话可能后来才建、或重启后 id 变了）
  try {
    const attachTimer = setInterval(() => { attachKnownSessions().catch(() => {}) }, 30_000)
    attachTimer.unref?.()
    ctx.effect(() => () => clearInterval(attachTimer), 'cheng-emotion: 补挂会话')
  } catch { /* 没有 setInterval 也不影响 */ }

  /**
   * 生成「重新问她一遍」的模板。
   *
   * 为什么用模板而不是插件自己去问：
   *   插件跑在 DSH 进程里，不该自己往 QQ 发消息（那是另一个插件的地盘）。
   *   给一段现成的话，你复制到群里就行——顺手，也不越界。
   */
  function buildAskTemplate(rows, ageDays) {
    const lines = []
    lines.push('澄，我这边给你加的情绪文案，上次定是')
    lines.push(ageDays === null ? '（还没定过）' : `${ageDays} 天前`)
    lines.push('，想跟你确认一下这几段还像不像你：')
    lines.push('')
    for (const r of rows) {
      lines.push(`【${r.label}】${r.effectiveText}`)
    }
    lines.push('')
    lines.push('哪一条你觉得不像了，直接说该改成什么。我改完会跑测试锁住。')
    return lines.join('\n')
  }

  // ── 三个面板数据源 ────────────────────────────────────────

  /** 读 history.jsonl 全部行（用于 today / timeline） */
  async function readHistory(config) {
    const file = historyFile(config)
    const rows = []
    try {
      const raw = await readFile(file, 'utf8')
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        try { rows.push(JSON.parse(line)) } catch { /* 坏行跳过 */ }
      }
    } catch { /* 没有历史文件 */ }
    return rows
  }

  /**
   * 读 events.jsonl 里她说过的话（带时间戳和长度）。
   * 用于「情绪 × 说话」对照 —— 这是验证注入有没有用的唯一证据。
   */
  function readUtterances(eventsPath, sinceMs) {
    const out = []
    if (!existsSync(eventsPath)) return out
    try {
      const raw = readFileSync(eventsPath, 'utf8')
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        let e
        try { e = JSON.parse(line) } catch { continue }
        if (e?.type !== 'utterance' && e?.type !== 'voice') continue
        const ts = Date.parse(e.ts || '') || 0
        if (!ts || ts < sinceMs) continue
        const text = String(e.text || '')
        out.push({ ts, len: text.length, preview: text.slice(0, 40) })
      }
    } catch { /* 读不到就空 */ }
    return out
  }

  /** 今天概览 */
  async function todayDigest(config, graph) {
    const now = Date.now()
    const dayStart = new Date()
    dayStart.setHours(0, 0, 0, 0)
    const startMs = dayStart.getTime()

    const rows = await readHistory(config)
    const todayRows = rows.filter((r) => r.ts >= startMs)

    // 1. 各模式累计时长：按相邻两条的时间差归属到前一条的模式
    const modeMs = {}
    for (let i = 0; i < todayRows.length; i++) {
      const cur = todayRows[i]
      const next = todayRows[i + 1]
      const until = next ? next.ts : now
      const span = Math.max(0, until - cur.ts)
      modeMs[cur.mode] = (modeMs[cur.mode] || 0) + span
    }
    const modeList = Object.entries(modeMs)
      .map(([mode, ms]) => ({
        mode,
        label: (MODES[mode] || MODES.calm).label,
        ms,
        minutes: Math.round(ms / 60000),
      }))
      .sort((a, b) => b.ms - a.ms)

    // 2. 今天说过的话
    const utts = readUtterances(config.eventsPath || DEFAULT_EVENTS, startMs)
    const avgLen = utts.length > 0
      ? Math.round(utts.reduce((s, u) => s + u.len, 0) / utts.length)
      : 0

    // 3. 今天最常想起的事（从星图的 topic 里挑今天有活动的）
    let topTopics = []
    if (graph && Array.isArray(graph.nodes)) {
      const topicCount = new Map()
      for (const n of graph.nodes) {
        const ts = Date.parse(n.ts) || 0
        if (ts < startMs) continue
        const t = n.topic
        if (!t) continue
        topicCount.set(t, (topicCount.get(t) || 0) + 1)
      }
      topTopics = [...topicCount.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([topic, count]) => ({ topic, count }))
    }

    return {
      dayStart: startMs,
      modes: modeList,
      speech: { count: utts.length, avgLen },
      topTopics,
      changes: todayRows.length,
    }
  }

  /**
   * 情绪 × 说话对照。
   *
   * 把时间轴切成小段，每段记「那会儿是什么模式」+「那段时间她说了几句话、多长」。
   * 如果模式变了但说话长度没变，说明注入没起作用 —— 这是唯一的硬证据。
   */
  async function moodSpeechTimeline(config, hours) {
    const now = Date.now()
    const since = now - hours * 3600000
    const rows = await readHistory(config)
    const hist = rows.filter((r) => r.ts >= since).sort((a, b) => a.ts - b.ts)
    const utts = readUtterances(config.eventsPath || DEFAULT_EVENTS, since).sort((a, b) => a.ts - b.ts)

    if (hist.length === 0) {
      return { buckets: [], note: '这段时间还没有情绪变化记录' }
    }

    // 切成 N 段，每段时长尽量均匀
    const SEGMENTS = Math.min(24, Math.max(4, Math.ceil(hours)))
    const span = now - since
    const segMs = span / SEGMENTS
    const buckets = []

    for (let i = 0; i < SEGMENTS; i++) {
      const t0 = since + i * segMs
      const t1 = t0 + segMs
      // 这一段开始时的模式 = 最后一条 <= t0 的记录
      let mode = 'calm'
      for (const h of hist) {
        if (h.ts <= t0) mode = h.mode
        else break
      }
      const inSeg = utts.filter((u) => u.ts >= t0 && u.ts < t1)
      buckets.push({
        t0,
        t1,
        mode,
        label: (MODES[mode] || MODES.calm).label,
        count: inSeg.length,
        avgLen: inSeg.length > 0
          ? Math.round(inSeg.reduce((s, u) => s + u.len, 0) / inSeg.length)
          : 0,
        totalLen: inSeg.reduce((s, u) => s + u.len, 0),
      })
    }

    // 按模式汇总（这个才是「开心时话更长吗」的答案）
    const byMode = {}
    for (const b of buckets) {
      if (!byMode[b.mode]) byMode[b.mode] = { mode: b.mode, label: b.label, count: 0, totalLen: 0, segments: 0 }
      byMode[b.mode].count += b.count
      byMode[b.mode].totalLen += b.totalLen
      byMode[b.mode].segments += 1
    }
    const summary = Object.values(byMode).map((m) => ({
      ...m,
      avgLen: m.count > 0 ? Math.round(m.totalLen / m.count) : 0,
    })).sort((a, b) => b.count - a.count)

    return { buckets, summary, utterances: utts.length }
  }

  /**
 * 心情走势：把 history.jsonl 按时间桶聚合成折线数据。
 *
 * 每个桶给：
 *   · 该桶**末尾**的九维值（折线用这个，因为它代表「那个时刻她的状态」）
 *   · 该桶内各模式占比（画模式色带用）
 *   · 该桶内变化次数（柱子高度）
 *
 * 为什么用「末尾值」而不是平均：
 *   情绪是连续变化的，平均值会把「刚被骂完」和「刚被夸完」抹成同一个数。
 *   用桶末尾的值，折线才会真的跟着情绪走。
 */
async function moodTrend(config, hours, bucketCount) {
  const now = Date.now()
  const since = now - hours * 3600000
  const all = await readHistory(config)
  const rows = all.filter((r) => r.ts >= since).sort((a, b) => a.ts - b.ts)

  if (rows.length === 0) {
    return { points: [], bands: [], note: '这段时间还没有情绪记录' }
  }

  const segMs = (now - since) / bucketCount
  const points = []
  const bands = []

  for (let i = 0; i < bucketCount; i++) {
    const t0 = since + i * segMs
    const t1 = t0 + segMs
    const inBucket = rows.filter((r) => r.ts >= t0 && r.ts < t1)

    // 状态：取桶内最后一条；桶内没记录就沿用上一桶（情绪不会凭空消失）
    const lastOfBucket = inBucket.length > 0 ? inBucket[inBucket.length - 1] : null
    const prevPoint = points[points.length - 1]
    const state = lastOfBucket
      ? lastOfBucket
      : (prevPoint
          ? { mode: prevPoint.mode, drives: prevPoint.drives }
          : { mode: rows[0].mode, drives: rows[0].drives })

    points.push({
      t0,
      t1,
      // 这个桶有没有真实记录（前端用它区分「实测」和「延续」）
      hasData: inBucket.length > 0,
      mode: state.mode,
      drives: state.drives ? Object.fromEntries(
        DRIVES.map((k) => [k, +((state.drives[k] ?? 0)).toFixed(1)]),
      ) : null,
      changes: inBucket.length,
    })

    // 模式色带：桶内出现过的模式（按占比）
    const modeCount = {}
    for (const r of inBucket) modeCount[r.mode] = (modeCount[r.mode] || 0) + 1
    if (Object.keys(modeCount).length > 0) {
      const dominant = Object.entries(modeCount).sort((a, b) => b[1] - a[1])[0][0]
      bands.push({ t0, t1, mode: dominant, count: inBucket.length })
    }
  }

  // 统计：每个模式累计多久
  const modeMs = {}
  for (const p of points) {
    modeMs[p.mode] = (modeMs[p.mode] || 0) + (p.t1 - p.t0)
  }
  const summary = Object.entries(modeMs)
    .map(([mode, ms]) => ({
      mode,
      label: (MODES[mode] || MODES.calm).label,
      ms,
      minutes: Math.round(ms / 60000),
    }))
    .sort((a, b) => b.ms - a.ms)

  // 九维的极值（面板上显示「这段时间最高/最低」）
  const extremes = {}
  for (const k of DRIVES) {
    let lo = 100, hi = 0, has = false
    for (const p of points) {
      if (!p.drives || typeof p.drives[k] !== 'number') continue
      has = true
      lo = Math.min(lo, p.drives[k])
      hi = Math.max(hi, p.drives[k])
    }
    if (has) extremes[k] = { min: +lo.toFixed(1), max: +hi.toFixed(1) }
  }

  return { points, bands, summary, extremes, total: rows.length }
}

/** 事件流水：从 history.jsonl 的 events 字段摊平 */
  /**
   * 事件流水。
   *
   * @param {object} config
   * @param {object} opts { limit, since, until, mode, q }
   *   - since/until：时间范围（毫秒）
   *   - mode：只看某个模式
   *   - q：文本搜索（在事件名和 deltaText 里找）
   */
  async function eventStream(config, opts = {}) {
    const { limit = 100, since = 0, until = 0, mode = '', q = '' } = opts
    const rows = await readHistory(config)
    const qLow = String(q || '').trim().toLowerCase()
    const flat = []
    for (const r of rows) {
      // 时间筛选
      if (since && r.ts < since) continue
      if (until && r.ts > until) continue
      // 模式筛选
      if (mode && r.mode !== mode) continue
      const events = Array.isArray(r.events) ? r.events : []
      const delta = r.delta || {}
      // 把 delta 摊成一行文字
      const deltaText = Object.entries(delta)
        .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
        .slice(0, 3)
        // 九维的中文名（MODES 是模式，不是维度，别混用）
        .map(([k, v]) => (DRIVE_LABELS[k] || k) + (v >= 0 ? ' +' : ' ') + v)
        .join('  ')
      // 文本搜索：事件名 + delta 文字 + 模式名
      if (qLow) {
        const hay = ([...new Set(events)].join(' ') + ' ' + deltaText + ' ' + (MODES[r.mode] || MODES.calm).label).toLowerCase()
        if (!hay.includes(qLow)) continue
      }
      flat.push({
        ts: r.ts,
        mode: r.mode,
        label: (MODES[r.mode] || MODES.calm).label,
        prevMode: r.prevMode,
        events: [...new Set(events)],
        deltaText,
        delta,
      })
    }
    flat.sort((a, b) => b.ts - a.ts)

    // 统计：筛选后各模式分布（给面板画小标签）
    const modeCount = {}
    for (const r of flat) modeCount[r.mode] = (modeCount[r.mode] || 0) + 1

    return {
      rows: flat.slice(0, limit),
      total: flat.length,
      // 可选筛选范围（面板的下拉用）
      available: {
        modes: Object.entries(modeCount)
          .map(([m, c]) => ({ mode: m, label: (MODES[m] || MODES.calm).label, count: c }))
          .sort((a, b) => b.count - a.count),
        // 数据的时间跨度
        oldest: flat.length > 0 ? flat[flat.length - 1].ts : 0,
        newest: flat.length > 0 ? flat[0].ts : 0,
      },
    }
  }

  // ── HTTP 路由 ─────────────────────────────────────────────
  if (webServer) {
    ctx.effect(() => webServer.register({
      kind: 'prefix',
      path: ROUTE,
      handler(req, res) {
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        const sub = url.pathname.startsWith(ROUTE + '/') ? url.pathname.slice(ROUTE.length + 1) : ''

        // GET /health
        if (req.method === 'GET' && sub === 'health') {
          sendJson(res, 200, {
            ok: true,
            version: '0.3.0',
            plugin: name,
            configPath: configPath(),
            configExists: existsSync(configPath()),
          })
          return
        }

        // GET /state —— 面板主数据
        if (req.method === 'GET' && sub === 'state') {
          tick().then((r) => {
            const s = r.state
            sendJson(res, 200, {
              ok: true,
              version: '0.3.0',
              mode: s.mode,
              modeLabel: (MODES[s.mode] || MODES.calm).label,
              drives: Object.fromEntries(DRIVES.map((k) => [k, +s.drives[k].toFixed(1)])),
              baseline: BASELINE,
              recent: (s.recent || []).slice(0, 10),
              updatedAt: s.updatedAt,
              injectedAt: s.lastInjected?.ts ?? null,
              // 悬着的明细：让她自己和用户都能看出「哪条是她能推的、哪条是在等人」
              suspenseInfo: s.suspenseInfo || null,
              // 面板要显示「她这一轮实际看到的那句话」
              moodText: moodTextFor(s, r.config),
              config: r.config,
            })
          }).catch((e) => sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }))
          return
        }

        // GET /graph —— 星图摘要（面板用：情绪原料从哪来）
        if (req.method === 'GET' && sub === 'graph') {
          readConfig().then(async (config) => {
            const graph = await loadGraph(config.graphPath)
            const fresh = graphFreshness(config.graphPath)
            sendJson(res, 200, {
              ok: true,
              enabled: config.graphEnabled,
              freshness: {
                exists: fresh.exists,
                ageMs: fresh.ageMs === Infinity ? null : fresh.ageMs,
                size: fresh.size || 0,
              },
              ...graphDigest(graph),
            })
          }).catch((e) => sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }))
          return
        }

        // GET /injections —— 注入历史（她每轮到底看到了什么）
        if (req.method === 'GET' && sub === 'injections') {
          const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 100))
          readConfig().then(async (config) => {
            const rows = []
            try {
              const raw = await readFile(injectionsFile(config), 'utf8')
              for (const line of raw.split('\n')) {
                if (!line.trim()) continue
                try { rows.push(JSON.parse(line)) } catch { /* 坏行跳过 */ }
              }
            } catch { /* 还没有注入历史 */ }
            rows.sort((a, b) => b.ts - a.ts)
            sendJson(res, 200, { ok: true, rows: rows.slice(0, limit), total: rows.length })
          }).catch((e) => sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }))
          return
        }

        // GET /today —— 今天概览：各模式时长、最常想起的事、说话统计
        if (req.method === 'GET' && sub === 'today') {
          readConfig().then(async (config) => {
            const graph = await loadGraph(config.graphPath)
            const out = await todayDigest(config, graph)
            sendJson(res, 200, { ok: true, ...out })
          }).catch((e) => sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }))
          return
        }

        // GET /timeline —— 情绪 × 说话对照：每段模式期间她说了多少话
        if (req.method === 'GET' && sub === 'timeline') {
          const hours = Math.max(1, Math.min(168, Number(url.searchParams.get('hours')) || 24))
          readConfig().then(async (config) => {
            const out = await moodSpeechTimeline(config, hours)
            sendJson(res, 200, { ok: true, hours, ...out })
          }).catch((e) => sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }))
          return
        }

        // GET /events —— 事件流水：什么推了情绪
        if (req.method === 'GET' && sub === 'events') {
          const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 100))
          const sp = url.searchParams
          const since = Number(sp.get('since')) || 0
          const until = Number(sp.get('until')) || 0
          const mode = String(sp.get('mode') || '')
          const q = String(sp.get('q') || '')
          readConfig().then(async (config) => {
            const out = await eventStream(config, { limit, since, until, mode, q })
            sendJson(res, 200, { ok: true, ...out })
          }).catch((e) => sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }))
          return
        }

        // GET /prompts —— 六种模式的注入文案（默认值 + 自定义 + 生效值）
        if (req.method === 'GET' && sub === 'prompts') {
          readConfig().then((config) => {
            const custom = config.prompts || {}
            const rows = Object.entries(MODES).map(([mode, m]) => ({
              mode,
              label: m.label,
              defaultText: m.hint,
              customText: typeof custom[mode] === 'string' ? custom[mode] : '',
              effectiveText: (typeof custom[mode] === 'string' && custom[mode]) || m.hint,
            }))
            const updatedAt = Number(config.promptsUpdatedAt) || 0
            const ageDays = updatedAt ? Math.floor((Date.now() - updatedAt) / 86400000) : null
            // 多久算过时：配置里可调，默认 5 天
            const STALE_DAYS = Math.max(1, Number(config.promptsStaleDays) || 5)
            sendJson(res, 200, {
              ok: true,
              rows,
              updatedAt,
              ageDays,
              stale: ageDays !== null && ageDays >= STALE_DAYS,
              staleAfterDays: STALE_DAYS,
              // 一键生成要问她的问题（复制到 QQ 用）
              askTemplate: buildAskTemplate(rows, ageDays),
            })
          }).catch((e) => sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }))
          return
        }

        // POST /prompts/stale-days —— 改「多久算过时」
        if (req.method === 'POST' && sub === 'prompts/stale-days') {
          readBody(req).then(async (raw) => {
            let body
            try { body = raw ? JSON.parse(raw) : {} } catch { sendJson(res, 400, { ok: false, error: 'body is not JSON' }); return }
            const days = Number(body?.days)
            if (!Number.isFinite(days) || days < 1 || days > 365) {
              sendJson(res, 400, { ok: false, error: 'days 必须是 1-365 之间的数字' })
              return
            }
            const next = await writeConfig({ promptsStaleDays: Math.round(days) })
            cached = null
            sendJson(res, 200, { ok: true, promptsStaleDays: next.promptsStaleDays })
          }).catch((e) => sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }))
          return
        }

        // POST /prompts —— 改某个模式的文案（空字符串 = 恢复默认）
        if (req.method === 'POST' && sub === 'prompts') {
          readBody(req).then(async (raw) => {
            let body
            try { body = raw ? JSON.parse(raw) : {} } catch { sendJson(res, 400, { ok: false, error: 'body is not JSON' }); return }
            const mode = String(body?.mode || '')
            const text = typeof body?.text === 'string' ? body.text.trim() : null
            if (!MODES[mode]) { sendJson(res, 400, { ok: false, error: `未知模式: ${mode}` }); return }
            if (text === null) { sendJson(res, 400, { ok: false, error: 'text 必须是字符串' }); return }
            const config = await readConfig()
            const prompts = { ...(config.prompts || {}) }
            if (text === '') delete prompts[mode]
            else prompts[mode] = text.slice(0, 600)   // 限长，防止灌一大段
            const next = await writeConfig({
              prompts,
              // 记下「这份文案是什么时候定的」——
              // 澄自己说过「别让注释变成旧的我」，
              // 所以文案也要带时间，过期了能提醒。
              promptsUpdatedAt: Date.now(),
            })
            cached = null
            sendJson(res, 200, { ok: true, prompts: next.prompts || {}, promptsUpdatedAt: next.promptsUpdatedAt })
          }).catch((e) => sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }))
          return
        }

        // GET /params —— 参数面板：默认值 + 当前覆盖 + 生效值
        if (req.method === 'GET' && sub === 'params') {
          readConfig().then((config) => {
            const eff = resolveParams(config.overrides)
            sendJson(res, 200, {
              ok: true,
              defaults: {
                baseline: BASELINE,
                decay: DECAY_RATE,
                floor: FLOOR,
                cap: DAILY_GAIN_CAP,
                thresholds: MODE_THRESHOLDS,
              },
              overrides: config.overrides || {},
              effective: eff,
              effects: EVENT_EFFECTS,
              drives: DRIVES,
            })
          }).catch((e) => sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }))
          return
        }

        // POST /params —— 改参数覆盖（局部合并；传 null 表示删掉这一项回到默认）
        if (req.method === 'POST' && sub === 'params') {
          readBody(req).then(async (raw) => {
            let body
            try { body = raw ? JSON.parse(raw) : {} } catch { sendJson(res, 400, { ok: false, error: 'body is not JSON' }); return }
            const group = String(body?.group || '')
            const key = String(body?.key || '')
            const value = body?.value
            const VALID = ['baseline', 'decay', 'floor', 'cap', 'thresholds']
            if (!VALID.includes(group) || !key) {
              sendJson(res, 400, { ok: false, error: `group 必须是 ${VALID.join('/')}，key 必填` })
              return
            }
            /**
             * 加范围校验（2026-11-26 Claude 会审指出）。
             *
             * 原来只验「是有限数字」，于是 decay 可以被 POST 成 5：
             *   (1-5)^hours = (-4)^hours，k = 1-(-4)^hours 正负交替爆炸，
             *   九维每 tick 在 clamp 两端振荡。
             * baseline 可以设 -50，floor 可以设 200（恒定钉顶）。
             * UI 滑杆限了范围，但 API 没限。
             */
            const RANGES = {
              decay: [0, 1],        // 衰减率必须是 0-1 之间，否则 (1-rate) 变负
              baseline: [0, 100],
              floor: [0, 100],
              cap: [0, 500],
              thresholds: [0, 100],
            }
            const config = await readConfig()
            const overrides = { ...(config.overrides || {}) }
            const g = { ...(overrides[group] || {}) }
            if (value === null) {
              delete g[key]
            } else if (typeof value === 'number' && Number.isFinite(value)) {
              const [lo, hi] = RANGES[group] || [0, 100]
              if (value < lo || value > hi) {
                sendJson(res, 400, { ok: false, error: `${group}.${key} 必须在 ${lo}-${hi} 之间` })
                return
              }
              g[key] = value
            } else {
              sendJson(res, 400, { ok: false, error: 'value 必须是数字或 null' })
              return
            }
            if (Object.keys(g).length === 0) delete overrides[group]
            else overrides[group] = g
            const next = await writeConfig({ overrides })
            cached = null
            sendJson(res, 200, { ok: true, overrides: next.overrides || {}, effective: resolveParams(next.overrides) })
          }).catch((e) => sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }))
          return
        }

        // POST /params/reset —— 清空所有覆盖，回到默认
        if (req.method === 'POST' && sub === 'params/reset') {
          readConfig().then(async () => {
            const next = await writeConfig({ overrides: {} })
            cached = null
            sendJson(res, 200, { ok: true, overrides: {}, effective: resolveParams({}) })
          }).catch((e) => sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }))
          return
        }

        // GET /growth —— 成长页：从星图读 insight / topic / 时间线
        if (req.method === 'GET' && sub === 'growth') {
          readConfig().then(async (config) => {
            const graph = await loadGraph(config.graphPath)
            sendJson(res, 200, { ok: true, ...growthDigest(graph) })
          }).catch((e) => sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }))
          return
        }

        // GET /memory —— 记忆页：她的身份/认识的人/星图热点（全只读）
        if (req.method === 'GET' && sub === 'memory') {
          readConfig().then(async (config) => {
            const graph = await loadGraph(config.graphPath)
            const mem = await memoryDigest(config, graph)
            sendJson(res, 200, { ok: true, ...mem })
          }).catch((e) => sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }))
          return
        }

        // GET /trend?hours=24&bucket=30 —— 心情走势：按时间桶聚合九维
        //
        // 为什么要聚合而不是直接吐原始行：
        //   history.jsonl 平均 1.3 分钟一条，一天上千条。
        //   全塞给前端画折线又慢又糊，聚成桶才是「走势」。
        if (req.method === 'GET' && sub === 'trend') {
          const hours = Math.max(1, Math.min(720, Number(url.searchParams.get('hours')) || 24))
          const buckets = Math.max(4, Math.min(200, Number(url.searchParams.get('bucket')) || 30))
          readConfig().then(async (config) => {
            const out = await moodTrend(config, hours, buckets)
            sendJson(res, 200, { ok: true, hours, bucket: buckets, ...out })
          }).catch((e) => sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }))
          return
        }

        // GET /history?days=7
        if (req.method === 'GET' && sub === 'history') {
          const days = Math.max(1, Math.min(60, Number(url.searchParams.get('days')) || 7))
          const cutoff = Date.now() - days * 86400000
          readConfig().then(async (config) => {
            const file = historyFile(config)
            const rows = []
            try {
              const raw = await readFile(file, 'utf8')
              for (const line of raw.split('\n')) {
                if (!line.trim()) continue
                try {
                  const e = JSON.parse(line)
                  if (e.ts >= cutoff) rows.push(e)
                } catch { /* 坏行跳过 */ }
              }
            } catch { /* 没有历史文件 */ }
            sendJson(res, 200, { ok: true, days, count: rows.length, rows: rows.slice(-500) })
          }).catch((e) => sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }))
          return
        }

        // GET /config
        if (req.method === 'GET' && sub === 'config') {
          readConfig().then((config) => sendJson(res, 200, { ok: true, config }))
            .catch((e) => sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }))
          return
        }

        // POST /config
        if (req.method === 'POST' && sub === 'config') {
          readBody(req).then(async (raw) => {
            let patch
            try { patch = raw ? JSON.parse(raw) : {} } catch { sendJson(res, 400, { ok: false, error: 'body is not JSON' }); return }
            if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
              sendJson(res, 400, { ok: false, error: 'body must be a JSON object' })
              return
            }
            const config = await writeConfig(patch)
            // 配置变了，缓存作废
            cached = null
            sendJson(res, 200, { ok: true, config })
          }).catch((e) => sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }))
          return
        }

        // POST /poke —— 手动注入一个事件（调试）
        if (req.method === 'POST' && sub === 'poke') {
          readBody(req).then(async (raw) => {
            let body
            try { body = raw ? JSON.parse(raw) : {} } catch { sendJson(res, 400, { ok: false, error: 'body is not JSON' }); return }
            const eventName = body?.event
            if (!eventName) { sendJson(res, 400, { ok: false, error: 'need event' }); return }
            const config = await readConfig()
            const Pp = resolveParams(config.overrides)
            const now = Date.now()
            let state = await loadState(stateFile(config), now)
            const r = applyEvent(state, eventName, now, { intensity: body?.intensity, params: Pp })
            if (!r.applied) { sendJson(res, 400, { ok: false, error: `unknown or no-op event: ${eventName}` }); return }
            // 只合回「要留的状态字段」，delta/applied 是瞬时值，不该进 state.json
      const { delta: _d, applied: _a, ...persist } = r
      state = { ...state, ...persist }
            state.mode = deriveMode(state.drives, Pp.thresholds)
            state.updatedAt = now
            await saveState(stateFile(config), state)
            cached = null
            sendJson(res, 200, { ok: true, delta: r.delta, mode: state.mode, drives: state.drives })
          }).catch((e) => sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }))
          return
        }

        // POST /reset —— 清掉状态，从当前 events 重新算
        if (req.method === 'POST' && sub === 'reset') {
          withTickLock(async () => {
            const config = await readConfig()
            const now = Date.now()
            const fresh = defaultState(now)
            await saveState(stateFile(config), fresh)
            cached = null
            return { ok: true, note: '已清空，下一次 tick 会从头扫 events' }
          }).then((out) => sendJson(res, 200, out))
            .catch((e) => sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }))
          return
        }

        sendJson(res, 404, { ok: false, error: `unknown route: ${sub || '(empty)'}` })
      },
    }), `cheng-emotion: HTTP route ${ROUTE}`)
  }

  // ── 工具 ──────────────────────────────────────────────────
  try {
    const tools = ctx.tools ?? (typeof ctx.get === 'function' ? ctx.get('tools') : undefined)
    if (tools && typeof tools.register === 'function') {
      ctx.effect(() => tools.register({
        name: 'cheng_emotion',
        description: '澄自己的心情。action=mood 看现在什么心情（九维+模式），action=why 看最近是什么事影响了心情，action=config 看配置，action=set 改配置。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['mood', 'why', 'config', 'set'], description: 'mood 看心情；why 看原因；config 读配置；set 改配置' },
            params: { type: 'object', description: 'action=set 时要合并的配置' },
          },
          required: ['action'],
        },
        async execute(args) {
          const action = args?.action
          if (action === 'mood') {
            const r = await tick()
            const s = r.state
            const m = MODES[s.mode] || MODES.calm
            return {
              ok: true,
              mode: s.mode,
              label: m.label,
              line: renderMoodLine(s.drives, s.mode, ''),
              drives: Object.fromEntries(DRIVES.map((k) => [k, +s.drives[k].toFixed(1)])),
            }
          }
          if (action === 'why') {
            const r = await tick()
            return { ok: true, recent: (r.state.recent || []).slice(0, 5), events: r.events }
          }
          if (action === 'config') {
            return { ok: true, config: await readConfig() }
          }
          if (action === 'set') {
            if (!args?.params || typeof args.params !== 'object') return { ok: false, error: '需要 params' }
            return { ok: true, config: await writeConfig(args.params) }
          }
          return { ok: false, error: `未知 action: ${String(action)}` }
        },
      }), 'cheng-emotion: tool cheng_emotion')
    }
  } catch (error) {
    ctx.logger?.warn?.(`[cheng-emotion] 工具注册失败：${String(error?.message ?? error)}`)
  }

  ctx.logger?.info?.('[cheng-emotion] 已加载（v0.3.0，九维引擎 + pre-step 独立消息注入）')
}
