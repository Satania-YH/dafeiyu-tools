/**
 * HTTP 接口的契约测试。
 *
 * 用假 ctx 把插件装起来，然后直接调 handler —— 不启动 DSH、不开端口。
 * 重点检查「前端依赖的字段名和结构」，改名会导致面板白屏。
 *
 *   node --test D:/dsh-fish-home/plugin-src/cheng-emotion/test/
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

/**
 * ⚠️ 必须先重定向，再 import index.js。
 *
 * 2026-11-26 Claude 会审指出：原来测试直接写 ~/.dsh/cheng-emotion-data/，
 * 跑一次 npm test 就会清掉用户在面板上拖的参数、覆盖真实 state.json。
 * 现在所有写操作指到一个临时目录，跑完删掉。
 *
 * index.js 里的 configPath()/dataDir() 会读这两个环境变量。
 */
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cheng-emotion-test-'))
process.env.CHENG_EMOTION_CONFIG_DIR = TMP_HOME
process.env.CHENG_EMOTION_DATA_DIR = path.join(TMP_HOME, 'data')

// 重定向之后再 import —— 这样模块里的路径解析会用到环境变量
const { apply, name, inject } = await import('../index.js')

// 全部跑完后清理
after(() => {
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }) } catch { /* 忽略 */ }
})

const ROUTE = '/cheng-emotion-api'

/** 测试用的 state.json 路径（临时目录下的） */
function stateFile() {
  return path.join(process.env.CHENG_EMOTION_DATA_DIR, 'state.json')
}

/** 用假 ctx 装插件，返回 { call, handlers, routes } */
function mountPlugin() {
  const routes = []
  const effects = []
  const handlers = {}
  const fakeAgent = {
    session: { header: { id: 'session-test' }, id: 'session-test' },
    ctx: { systemPrompt: { context: () => () => {} } },
  }
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    effect: (fn) => { effects.push(fn); return () => {} },
    on: (ev, fn) => { (handlers[ev] ||= []).push(fn); return () => {} },
    get: (k) => (k === 'agents' ? { get: () => fakeAgent } : undefined),
    agents: { get: () => fakeAgent },
    webServer: { register: (o) => { routes.push(o); return () => {} } },
    tools: { register: () => () => {} },
  }
  apply(ctx)
  for (const fn of effects) { try { fn() } catch { /* 跳过 */ } }

  const handler = routes[0]?.handler
  assert.ok(handler, '路由应该注册上了')

  /** 模拟一次 HTTP 调用 */
  function call(method, sub, body) {
    return new Promise((resolve, reject) => {
      const res = {
        _status: 0,
        _body: '',
        writeHead(s) { this._status = s },
        end(b) { this._body = b; resolve({ status: this._status, body: this._body }) },
      }
      const listeners = {}
      const req = {
        method,
        url: ROUTE + '/' + sub,
        on(ev, fn) { (listeners[ev] ||= []).push(fn) },
        destroy() {},
      }
      try {
        handler(req, res)
      } catch (e) { reject(e); return }
      if (body !== undefined) {
        const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
        for (const fn of (listeners.data || [])) fn(buf)
        for (const fn of (listeners.end || [])) fn()
      }
    })
  }

  return { call, handlers, routes, fakeAgent }
}

describe('插件元信息', () => {
  test('name 是 cheng-emotion', () => {
    assert.equal(name, 'cheng-emotion')
  })

  test('inject 声明了必需的四个服务', () => {
    for (const svc of ['tools', 'webServer', 'systemPrompt', 'agents']) {
      assert.ok(inject.includes(svc), `应该 inject ${svc}`)
    }
  })
})

describe('HTTP 接口契约', () => {
  let M
  before(() => { M = mountPlugin() })

  /** 通用：返回 200 且 ok:true */
  async function expectOk(sub) {
    const r = await M.call('GET', sub)
    assert.equal(r.status, 200, `${sub} 应该 200，实际 ${r.status}：${r.body}`)
    const d = JSON.parse(r.body)
    assert.equal(d.ok, true, `${sub} 应该 ok:true`)
    return d
  }

  test('GET /health', async () => {
    const d = await expectOk('health')
    assert.equal(d.plugin, 'cheng-emotion')
    assert.ok(typeof d.version === 'string')
  })

  test('GET /state 有面板依赖的全部字段', async () => {
    const d = await expectOk('state')
    // 前端 MoodTab 用到这些
    assert.ok(typeof d.mode === 'string', 'mode')
    assert.ok(typeof d.modeLabel === 'string', 'modeLabel')
    assert.ok(d.drives && typeof d.drives === 'object', 'drives')
    assert.ok(Array.isArray(d.recent), 'recent 应该是数组')
    assert.ok(d.config && typeof d.config === 'object', 'config')
    // 九维都得在
    for (const k of ['joy', 'attachment', 'intimacy', 'curiosity', 'reflection', 'duty', 'social', 'stress', 'fatigue']) {
      assert.ok(typeof d.drives[k] === 'number', `drives.${k} 应该是数字`)
    }
  })

  test('GET /growth 有 insights 和 topics', async () => {
    const d = await expectOk('growth')
    // 星图可能在也可能不在，但字段结构要稳定
    assert.ok(Array.isArray(d.insights), 'insights')
    assert.ok(Array.isArray(d.topics), 'topics')
  })

  test('GET /memory 有 identity 结构', async () => {
    const d = await expectOk('memory')
    assert.ok(d.identity, 'identity')
    assert.ok(Array.isArray(d.identity.sections), 'identity.sections')
    assert.ok(Array.isArray(d.hottest), 'hottest')
  })

  test('GET /graph 有新鲜度字段', async () => {
    const d = await expectOk('graph')
    assert.ok('freshness' in d, '应该有 freshness 字段')
  })

  test('GET /trend 有 points / summary / extremes', async () => {
    const d = await expectOk('trend?hours=24&bucket=24')
    assert.ok(Array.isArray(d.points), 'points')
    assert.ok(Array.isArray(d.summary), 'summary')
    assert.ok(d.extremes && typeof d.extremes === 'object', 'extremes')
    for (const p of d.points) {
      assert.ok(typeof p.t0 === 'number' && typeof p.t1 === 'number', 'bucket 时间')
      assert.ok('hasData' in p, 'hasData 标记')
      assert.ok(typeof p.mode === 'string', 'mode')
    }
  })

  test('GET /events 有 rows 和 total', async () => {
    const d = await expectOk('events?limit=10')
    assert.ok(Array.isArray(d.rows), 'rows')
    assert.ok(typeof d.total === 'number', 'total')
    for (const r of d.rows) {
      assert.ok(typeof r.ts === 'number')
      assert.ok(Array.isArray(r.events))
      assert.ok(typeof r.deltaText === 'string')
    }
  })

  test('GET /injections 有 rows 和 total', async () => {
    const d = await expectOk('injections?limit=10')
    assert.ok(Array.isArray(d.rows), 'rows')
    assert.ok(typeof d.total === 'number', 'total')
  })

  test('GET /today 有 modes 和 speech', async () => {
    const d = await expectOk('today')
    assert.ok(Array.isArray(d.modes), 'modes')
    assert.ok(d.speech && typeof d.speech.count === 'number', 'speech.count')
  })

  test('GET /params 有 defaults / overrides / effective', async () => {
    const d = await expectOk('params')
    assert.ok(d.defaults?.baseline, 'defaults.baseline')
    assert.ok(d.defaults?.thresholds, 'defaults.thresholds')
    assert.ok('lonelyMinJoy' in d.defaults.thresholds, '应该有新增的 lonelyMinJoy')
    assert.ok(d.effective?.thresholds, 'effective.thresholds')
    assert.ok(d.effects && typeof d.effects === 'object', 'effects')
  })

  test('GET /prompts 七种模式全有', async () => {
    const d = await expectOk('prompts')
    assert.equal(d.rows.length, 7)
    for (const r of d.rows) {
      assert.ok(typeof r.mode === 'string')
      assert.ok(typeof r.label === 'string')
      assert.ok(typeof r.defaultText === 'string' && r.defaultText.length > 0)
      assert.ok(typeof r.effectiveText === 'string' && r.effectiveText.length > 0)
    }
  })

  test('未知路由返回 404', async () => {
    const r = await M.call('GET', '不存在的路由')
    assert.equal(r.status, 404)
    const d = JSON.parse(r.body)
    assert.equal(d.ok, false)
  })
})

describe('POST 接口', () => {
  let M
  before(() => { M = mountPlugin() })

  test('POST /params 改阈值能生效', async () => {
    const r = await M.call('POST', 'params', { group: 'thresholds', key: 'tired', value: 88 })
    assert.equal(r.status, 200, r.body)
    const d = JSON.parse(r.body)
    assert.equal(d.ok, true)
    assert.equal(d.effective.thresholds.tired, 88)

    // 改回去
    await M.call('POST', 'params', { group: 'thresholds', key: 'tired', value: null })
  })

  test('POST /params 拒绝非法 group', async () => {
    const r = await M.call('POST', 'params', { group: '胡来', key: 'x', value: 1 })
    assert.equal(r.status, 400)
  })

  test('POST /params 拒绝非数字 value', async () => {
    const r = await M.call('POST', 'params', { group: 'baseline', key: 'joy', value: 'abc' })
    assert.equal(r.status, 400)
  })

  test('POST /prompts 能存自定义文案', async () => {
    const r = await M.call('POST', 'prompts', { mode: 'happy', text: '测试用的开心文案' })
    assert.equal(r.status, 200, r.body)
    const d = JSON.parse(r.body)
    assert.equal(d.prompts.happy, '测试用的开心文案')

    // 恢复
    await M.call('POST', 'prompts', { mode: 'happy', text: '' })
  })

  test('POST /prompts 拒绝未知模式', async () => {
    const r = await M.call('POST', 'prompts', { mode: '不存在的模式', text: 'x' })
    assert.equal(r.status, 400)
  })

  test('POST /params/reset 清空覆盖', async () => {
    await M.call('POST', 'params', { group: 'thresholds', key: 'tired', value: 90 })
    const r = await M.call('POST', 'params/reset')
    assert.equal(r.status, 200, r.body)
    const d = JSON.parse(r.body)
    assert.deepEqual(d.overrides, {})
  })
})

describe('pre-step 注入', () => {
  let M
  before(() => { M = mountPlugin() })

  /**
   * 清掉上次注入的记录，让「内容没变就不重复注入」的逻辑不生效。
   * 这些测试要验证的是「注入机制本身」，不是「去重逻辑」。
   */
  /** 清掉上次注入的记录（已经指向临时目录，不会碰真实数据） */
  async function resetDedup() {
    const st = stateFile()
    try {
      const s = JSON.parse(fs.readFileSync(st, 'utf8'))
      s.lastMoodTextBySession = {}
      s.lastMoodInjectAt = {}    // 频率闸按会话之后新增的字段，也要清
      s.lastInjected = null
      fs.writeFileSync(st, JSON.stringify(s, null, 2))
    } catch { /* 还没有状态文件，无所谓 */ }
  }

  test('返回新的 decision，不原地改 messages', async () => {
    await resetDedup()
    const fn = M.handlers['agent/pre-step']?.[0]
    assert.ok(fn, '应该注册了 pre-step')

    const original = { kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }] }
    const originalLen = original.messages.length
    const out = await fn({ agent: M.fakeAgent, step: 1 }, async () => original)

    assert.equal(original.messages.length, originalLen, '原始 messages 不该被改')
    assert.ok(out.messages.length > originalLen, '应该追加了一条')
  })

  test('追加的消息 source.kind 是 cheng-emotion', async () => {
    await resetDedup()
    const fn = M.handlers['agent/pre-step']?.[0]
    const out = await fn(
      { agent: M.fakeAgent, step: 1 },
      async () => ({ kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }),
    )
    const added = out.messages[out.messages.length - 1]
    assert.equal(added.source.kind, 'cheng-emotion', '界面按 source.kind 渲染标题')
    assert.equal(added.role, 'user')
    assert.ok(Array.isArray(added.content))
    assert.ok(typeof added.content[0].text === 'string')
    assert.ok(added.content[0].text.startsWith('[心情]'), '应该有 [心情] 前缀')
  })

  test('内容没变时不重复注入（防历史累积）', async () => {
    await resetDedup()
    const fn = M.handlers['agent/pre-step']?.[0]
    const mk = async () => ({ kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] })

    // 第一次：应该注入
    const first = await fn({ agent: M.fakeAgent, step: 1 }, mk)
    assert.equal(first.messages.length, 2, '第一次应该注入')

    // 第二次：内容一模一样 → 不该再塞
    const second = await fn({ agent: M.fakeAgent, step: 1 }, mk)
    assert.equal(second.messages.length, 1, '内容没变时不该重复注入')
  })

  test('宿主 reject 时原样返回', async () => {
    const fn = M.handlers['agent/pre-step']?.[0]
    const reject = { kind: 'reject', reason: 'test' }
    const out = await fn({ agent: M.fakeAgent, step: 1 }, async () => reject)
    assert.deepEqual(out, reject)
  })
})
describe('多会话隔离（Codex 会审指出）', () => {
  let M
  before(() => { M = mountPlugin() })

  test('两个会话各自独立判断「注入过没有」', async () => {
    // 清空
    try {
      const st = JSON.parse(fs.readFileSync(stateFile(), 'utf8'))
      st.lastMoodTextBySession = {}
      st.lastInjected = null
      fs.writeFileSync(stateFile(), JSON.stringify(st, null, 2))
    } catch { /* 忽略 */ }

    const fn = M.handlers['agent/pre-step']?.[0]
    const mk = async () => ({ kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] })

    const agentA = { session: { header: { id: 'session-A' }, id: 'session-A' }, ctx: {} }
    const agentB = { session: { header: { id: 'session-B' }, id: 'session-B' }, ctx: {} }

    // A 注入一次
    const a1 = await fn({ agent: agentA, step: 1 }, mk)
    assert.equal(a1.messages.length, 2, 'A 第一次应该注入')

    // B 第一次也要注入（不能因为 A 注入过就跳过）
    const b1 = await fn({ agent: agentB, step: 1 }, mk)
    assert.equal(b1.messages.length, 2, 'B 第一次也该注入，不该被 A 挡住')

    // A 第二次（内容没变）→ 跳过
    const a2 = await fn({ agent: agentA, step: 1 }, mk)
    assert.equal(a2.messages.length, 1, 'A 内容没变时不该重复')
  })
})

// ── Codex 二轮会审的剩余条目（2026-11-26）───────────────

describe('参数范围校验是唯一入口（Codex 会审）', () => {
  let M
  before(() => { M = mountPlugin() })

  test('/config 拒绝非法 decay，保留合法值', async () => {
    const r = await M.call('POST', 'config', JSON.stringify({
      overrides: { decay: { joy: 2, attachment: 0.005 } },
    }))
    assert.equal(r.status, 200)
    const cfg = JSON.parse(r.body).config
    assert.equal(cfg?.overrides?.decay?.joy, undefined, 'decay=2 会让 (1-rate) 变负，必须拒绝')
    assert.equal(cfg?.overrides?.decay?.attachment, 0.005, '合法值应该保留')
  })

  test('/config 拒绝超范围 baseline', async () => {
    const r = await M.call('POST', 'config', JSON.stringify({
      overrides: { baseline: { joy: 500 } },
    }))
    assert.equal(r.status, 200)
    const cfg = JSON.parse(r.body).config
    assert.equal(cfg?.overrides?.baseline?.joy, undefined, '500 超出 [0,100]')
  })

  test('/params 超范围返回 400', async () => {
    const r = await M.call('POST', 'params', JSON.stringify({ group: 'decay', key: 'joy', value: 5 }))
    assert.equal(r.status, 400, 'decay=5 必须拒绝')
  })
})

describe('频率闸按会话（Codex 会审）', () => {
  let M
  before(() => { M = mountPlugin() })

  /** 清掉去重记录（含按会话的注入时间） */
  async function resetDedup() {
    const st = stateFile()
    try {
      const s2 = JSON.parse(fs.readFileSync(st, 'utf8'))
      s2.lastMoodTextBySession = {}
      s2.lastMoodInjectAt = {}
      s2.lastInjected = null
      fs.writeFileSync(st, JSON.stringify(s2, null, 2))
    } catch { /* 还没有状态文件 */ }
  }

  /**
   * 核心：会话 B 的第一句不该被「会话 A 刚注入过」压住。
   *
   * 只断言这一点，不去断言「A 第二次不注入」——
   * 那取决于 recent[0].reasons 会不会变，是另一个测试的事。
   * 之前我把两件事写在一条测试里，结果因为 reason 变了就挂。
   */
  test('另一个会话能拿到自己的第一句', async () => {
    await resetDedup()
    const fn = M.handlers['agent/pre-step']?.[0]
    const mk = async () => ({ kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] })

    // 会话 A 注入一次
    const a1 = await fn({ agent: M.fakeAgent, step: 1 }, mk)
    assert.ok(a1 && a1.messages.length > 0, '会话 A 第一次该注入')

    // 会话 B 紧接着来 —— 旧版会被全局 30 分钟闸压住，新版应该照常注入
    const other = { session: { header: { id: 'session-other' }, id: 'session-other' } }
    const b = await fn({ agent: other, step: 1 }, mk)
    assert.ok(b && b.messages.length > 0, '会话 B 不该被会话 A 的注入压住')

    // 磁盘上应该两个会话都留了记录
    const st = JSON.parse(fs.readFileSync(stateFile(), 'utf8'))
    assert.ok(st.lastMoodInjectAt?.['session-test'], 'A 的注入时间该记下来')
    assert.ok(st.lastMoodInjectAt?.['session-other'], 'B 的注入时间该记下来')
  })
})

describe('无变化时不写盘（Codex 会审）', () => {
  let M
  before(() => { M = mountPlugin() })

  test('连续 tick 不改变 mtime', async () => {
    await M.call('GET', 'state')
    await new Promise((r) => setTimeout(r, 150))
    const m0 = fs.statSync(stateFile()).mtimeMs

    for (let i = 0; i < 3; i++) {
      await M.call('GET', 'state')
      await new Promise((r) => setTimeout(r, 80))
    }
    const m1 = fs.statSync(stateFile()).mtimeMs
    assert.equal(m1, m0, '没有事件、没有模式变化时不该重写 44KB')
  })
})

describe('去重不能永久锁死（2026-11-26 实测 bug）', () => {
  let M
  before(() => { M = mountPlugin() })

  async function resetDedup() {
    const st = stateFile()
    try {
      const s2 = JSON.parse(fs.readFileSync(st, 'utf8'))
      s2.lastMoodTextBySession = {}
      s2.lastMoodInjectAt = {}
      s2.lastInjected = null
      fs.writeFileSync(st, JSON.stringify(s2, null, 2))
    } catch { /* 还没有状态文件 */ }
  }

  /** 把某会话的「上次注入时间」拨回去 */
  function shiftLastInject(sid, msAgo) {
    const st = stateFile()
    const s2 = JSON.parse(fs.readFileSync(st, 'utf8'))
    s2.lastMoodInjectAt = s2.lastMoodInjectAt || {}
    s2.lastMoodInjectAt[sid] = Date.now() - msAgo
    fs.writeFileSync(st, JSON.stringify(s2, null, 2))
  }

  test('心情没变、但已经很久没提过 → 应该重新提一次', async () => {
    await resetDedup()
    const fn = M.handlers['agent/pre-step']?.[0]
    const mk = async () => ({ kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] })

    const first = await fn({ agent: M.fakeAgent, step: 1 }, mk)
    assert.ok(first.messages.length > 0, '第一次该注入')

    // 模拟 35 分钟过去（超过 MIN_GAP_MS 30 分钟，心情没变）
    shiftLastInject('session-test', 35 * 60 * 1000)

    const again = await fn({ agent: M.fakeAgent, step: 2 }, mk)
    assert.ok(
      again.messages.length > 0,
      '心情没变但过了 30 分钟应该重提 —— 否则她永远不知道自己现在什么状态',
    )
  })

  test('刚说过同样的话 → 不重复（防止历史里堆满同一句）', async () => {
    await resetDedup()
    const fn = M.handlers['agent/pre-step']?.[0]
    const mk = async () => ({ kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] })

    const first = await fn({ agent: M.fakeAgent, step: 1 }, mk)
    assert.ok(first.messages.length > 0, '第一次该注入')

    // 立刻再来一次。mk 本身带 1 条消息，所以「没追加」= length 仍是 1
    const second = await fn({ agent: M.fakeAgent, step: 2 }, mk)
    assert.equal(second.messages.length, 1, '刚说过就该跳过（只留原始那 1 条）')
  })

  test('旧状态只有 lastMoodTextBySession、没有 lastMoodInjectAt 时不锁死', async () => {
    // 模拟升级前留下的状态：只记了文本，没记时间
    await resetDedup()
    const fn = M.handlers['agent/pre-step']?.[0]
    const mk = async () => ({ kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] })

    const first = await fn({ agent: M.fakeAgent, step: 1 }, mk)
    assert.ok(first.messages.length > 0, '第一次该注入')

    // 手动删掉时间记录，只留文本（模拟旧版状态）
    const st = stateFile()
    const s2 = JSON.parse(fs.readFileSync(st, 'utf8'))
    delete s2.lastMoodInjectAt
    fs.writeFileSync(st, JSON.stringify(s2, null, 2))

    const again = await fn({ agent: M.fakeAgent, step: 2 }, mk)
    assert.ok(again.messages.length > 0, '没有时间记录时不该被文本去重挡住')
  })
})
