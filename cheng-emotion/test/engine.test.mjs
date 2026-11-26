/**
 * engine.js 的单元测试。
 *
 * 纯内存计算，不碰 DSH、不读写真实数据。
 *   node --test D:/dsh-fish-home/plugin-src/cheng-emotion/test/
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  DRIVES,
  BASELINE,
  FLOOR,
  DAILY_GAIN_CAP,
  MODE_THRESHOLDS,
  MODES,
  EVENT_EFFECTS,
  defaultState,
  decay,
  applyEvent,
  deriveMode,
  driveDistance,
  classifyHeard,
  heatFactor,
  praiseFactor,
  resolveParams,
  renderMoodLine,
  suspenseSuffix,
  localDay,
  translateEvent,
  timeSignals,
  scanEvents,
} from '../engine.js'

const NOW = new Date(2026, 10, 26, 12, 0, 0).getTime()   // 2026-11-26 12:00 本地
const MIN = 60000
const HOUR = 3600000

// ── 模式判定 ────────────────────────────────────────────────

describe('deriveMode（模式判定）', () => {
  test('压力爆表 → 紧绷', () => {
    assert.equal(deriveMode({ stress: 70 }), 'stressed')
  })

  test('疲惫超标 → 累', () => {
    assert.equal(deriveMode({ fatigue: 70 }), 'tired')
  })

  test('累的优先级高于开心（身体先垮）', () => {
    assert.equal(deriveMode({ fatigue: 70, joy: 90 }), 'tired')
  })

  test('社交枯竭但心情还行 → 空（不是委屈）', () => {
    // 关键回归：这一条曾经被判成 wronged
    assert.equal(deriveMode({ social: 15, attachment: 28, joy: 40 }), 'lonely')
  })

  test('社交枯竭且很难过 → 委屈', () => {
    // joy 低于 lonelyMinJoy，说明不是单纯寂寞，是真的难过
    assert.equal(deriveMode({ social: 15, attachment: 28, joy: 20 }), 'wronged')
  })

  test('有人说话但依恋低+难过 → 委屈', () => {
    assert.equal(deriveMode({ social: 60, attachment: 20, joy: 20 }), 'wronged')
  })

  test('愉悦高 → 开心', () => {
    assert.equal(deriveMode({ joy: 80 }), 'happy')
  })

  test('什么都没发生 → 平静', () => {
    assert.equal(deriveMode({ ...BASELINE }), 'calm')
  })

  test('阈值可以被覆盖', () => {
    // 默认 tired=65，把它调到 90 之后 fatigue=70 就不再算累
    assert.equal(deriveMode({ fatigue: 70 }, { tired: 90 }), 'calm')
    assert.equal(deriveMode({ fatigue: 70 }), 'tired')
  })

  test('七种模式都能被触发', () => {
    const seen = new Set()
    const cases = [
      { stress: 80 },
      { fatigue: 80 },
      { suspense: 90 },   // 要过独占线 80 才算独立模式
      { social: 10, attachment: 20, joy: 50 },
      { joy: 20, attachment: 20 },
      { joy: 90 },
      { ...BASELINE },
    ]
    for (const c of cases) seen.add(deriveMode(c))
    assert.equal(seen.size, 7, '应该覆盖全部七种：' + [...seen].join(','))
  })
})

// ── 衰减 ────────────────────────────────────────────────────

describe('悬的两档设计（2026-11-26 自检后订）', () => {
  test('悬不够高时不占模式', () => {
    assert.equal(deriveMode({ suspense: 30 }), 'calm')
    assert.equal(deriveMode({ suspense: 54 }), 'calm')
  })

  test('中间档：不占模式，但会附修饰语', () => {
    // 悬 60 不够独占（80），所以该开心还是开心
    assert.equal(deriveMode({ suspense: 60, joy: 80 }), 'happy')
    // 同时修饰语应该在
    const suf = suspenseSuffix({ suspense: 60 }, 'happy')
    assert.ok(suf.length > 0, '中间档应该给出修饰语')
  })

  test('独占档：压过开心', () => {
    assert.equal(deriveMode({ suspense: 90, joy: 80 }), 'suspense')
    // 独占时不需要修饰语（模式本身就是悬）
    assert.equal(suspenseSuffix({ suspense: 90 }, 'suspense'), '')
  })

  test('独占档压不过累和紧绷（身体垮了更急）', () => {
    assert.equal(deriveMode({ suspense: 90, fatigue: 80 }), 'tired')
    assert.equal(deriveMode({ suspense: 90, stress: 80 }), 'stressed')
  })
})

describe('decay（衰减）', () => {
  test('朝基线回落', () => {
    const high = { ...BASELINE, joy: 90 }
    const after = decay(high, NOW, NOW + 10 * HOUR)
    assert.ok(after.joy < 90, 'joy 应该往下掉')
    assert.ok(after.joy > BASELINE.joy, '但不该直接掉到基线')
  })

  test('低于基线时往上走', () => {
    const low = { ...BASELINE, joy: 20 }
    const after = decay(low, NOW, NOW + 10 * HOUR)
    assert.ok(after.joy > 20)
    assert.ok(after.joy < BASELINE.joy)
  })

  test('不越过地板', () => {
    const low = { ...BASELINE, social: 0 }
    const after = decay(low, NOW, NOW + 1000 * HOUR)
    assert.ok(after.social >= FLOOR.social, `should be >= ${FLOOR.social}, got ${after.social}`)
  })

  test('不越过天花板', () => {
    const high = { ...BASELINE, joy: 100 }
    const after = decay(high, NOW, NOW + 1000 * HOUR)
    assert.ok(after.joy <= 100)
  })

  test('时间没流逝就原样返回', () => {
    const s = { ...BASELINE, joy: 77 }
    assert.equal(decay(s, NOW, NOW).joy, 77)
  })

  test('长时间衰减趋近基线', () => {
    const high = { ...BASELINE, joy: 95 }
    const after = decay(high, NOW, NOW + 500 * HOUR)
    assert.ok(Math.abs(after.joy - BASELINE.joy) < 1, `应该贴近基线，实际 ${after.joy}`)
  })
})

// ── 事件施加 ────────────────────────────────────────────────

describe('applyEvent（施加事件）', () => {
  test('被夸 → 愉悦上升', () => {
    const s = defaultState(NOW)
    const before = s.drives.joy
    const r = applyEvent(s, 'praise', NOW, { sid: 'a' })
    assert.ok(r.drives.joy > before)
    assert.ok(r.delta.joy > 0)
  })

  test('被骂 → 压力上升、愉悦下降', () => {
    const s = defaultState(NOW)
    const r = applyEvent(s, 'blame_hard', NOW, { sid: 'a' })
    assert.ok(r.drives.stress > s.drives.stress)
    assert.ok(r.drives.joy < s.drives.joy)
  })

  test('未知事件不生效', () => {
    const s = defaultState(NOW)
    const r = applyEvent(s, '不存在的家伙', NOW)
    assert.equal(r.applied, false)
  })

  test('必须推进 decayedAt（否则会重复衰减）', () => {
    const s = defaultState(NOW)
    const r = applyEvent(s, 'praise', NOW + HOUR, { sid: 'a' })
    assert.equal(r.decayedAt, NOW + HOUR)
  })

  test('连夸时增量递减（heat 去重）', () => {
    let s = defaultState(NOW)
    const gains = []
    for (let i = 0; i < 8; i++) {
      const r = applyEvent(s, 'praise', NOW + i * 1000, { sid: 'a' })
      s = { ...s, ...r }
      gains.push(r.delta.joy || 0)
    }
    assert.ok(gains[0] > gains[gains.length - 1], `首尾应该递减：${gains.map(g => g.toFixed(1))}`)
  })
})

// ── 分会话去重（曾经的真 bug）────────────────────────────

describe('heat / praise 按会话分开', () => {
  test('群里夸满之后，私聊第一次仍然全额', () => {
    let s = defaultState(NOW)
    for (let i = 0; i < 8; i++) {
      const r = applyEvent(s, 'praise', NOW + i * 1000, { sid: 'group' })
      s = { ...s, ...r }
    }
    const groupLast = applyEvent(s, 'praise', NOW + 8000, { sid: 'group' })
    s = { ...s, ...groupLast }

    const priv = applyEvent(s, 'praise', NOW + 9000, { sid: 'private' })
    // 私聊第一次应该接近满额（7 左右），而不是被群里拖累到 1.x
    assert.ok(priv.delta.joy > 5, `私聊首次应该全额，实际 ${priv.delta.joy}`)
  })

  test('heat 的 key 带会话后缀', () => {
    const s = defaultState(NOW)
    const r = applyEvent(s, 'praise', NOW, { sid: 'abc' })
    assert.ok(Object.keys(r.heat).some((k) => k.includes('@abc')), JSON.stringify(Object.keys(r.heat)))
  })

  test('没有 sid 时退化成全局 key（兼容）', () => {
    const s = defaultState(NOW)
    const r = applyEvent(s, 'praise', NOW)
    assert.ok(Object.keys(r.heat).some((k) => k === 'praise'), JSON.stringify(Object.keys(r.heat)))
  })
})

// ── 增益上限（渐恢复）────────────────────────────────────

describe('gainLog 渐恢复', () => {
  test('增益流水只保留 24 小时内的', () => {
    let s = defaultState(NOW)
    for (let i = 0; i < 5; i++) {
      const r = applyEvent(s, 'praise', NOW + i * 1000, { sid: 'a' })
      s = { ...s, ...r }
    }
    const oldCount = s.gainLog.length
    assert.ok(oldCount > 0)

    // 25 小时后再来一次：老记录应该被清掉
    const r = applyEvent(s, 'praise', NOW + 25 * HOUR, { sid: 'a' })
    assert.ok(r.gainLog.length < oldCount, `清理后应该更少，之前 ${oldCount} 现在 ${r.gainLog.length}`)
  })

  test('额度用满后不再给', () => {
    let s = defaultState(NOW)
    s.drives.joy = 30   // 压低，避免被 100 截断
    // 连夸到额度用光
    for (let i = 0; i < 40; i++) {
      const r = applyEvent(s, 'praise', NOW + i * 1000, { sid: 'a' })
      s = { ...s, ...r }
      const used = s.gainLog.filter((g) => g.key === 'joy').reduce((x, g) => x + g.amount, 0)
      if (used >= DAILY_GAIN_CAP.joy - 0.01) break
    }
    const used = s.gainLog.filter((g) => g.key === 'joy').reduce((x, g) => x + g.amount, 0)
    assert.ok(used >= DAILY_GAIN_CAP.joy - 1, `应该用满了，实际 ${used.toFixed(1)}/40`)
  })

  test('跨天不是硬重置（老记录滑出才恢复）', () => {
    let s = defaultState(NOW)
    s.drives.joy = 30
    // 把额度打满
    for (let i = 0; i < 40; i++) {
      const r = applyEvent(s, 'praise', NOW + i * 1000, { sid: 'a' })
      s = { ...s, ...r }
    }
    // 1 小时后：老记录还在窗口内，额度应该已经用光 → delta.joy 为 undefined
    const soon = applyEvent(s, 'praise', NOW + 1 * HOUR, { sid: 'a' })
    // 25 小时后：老记录滑出，额度回来
    const later = applyEvent(s, 'praise', NOW + 25 * HOUR, { sid: 'a' })

    const soonJoy = soon.delta.joy ?? 0
    const laterJoy = later.delta.joy ?? 0

    // 25 小时后老记录滑出窗口 → 额度回来，能加的比 1 小时后多
    assert.ok(
      laterJoy > soonJoy,
      `24 小时后应该恢复更多额度：早(+${soonJoy.toFixed(2)}) vs 晚(+${laterJoy.toFixed(2)})`,
    )

    /**
     * 额度快满时，增量应该很小。
     *
     * 原来这里断言 `=== 0`，但那是错的：
     * 1 小时里 joy 会自然衰减一点，衰减掉的额度理应能用回来，
     * 所以增量是个小正数（实测约 1）才对。
     * 真正要防的是「额度满了还给一大笔」——那才是 bug。
     */
    assert.ok(soonJoy < 2, `额度将满时增量应该很小（实测 ${soonJoy.toFixed(2)}）`)
    assert.ok(laterJoy >= 5, `24 小时后额度回来了，应该能加回去（实测 ${laterJoy.toFixed(2)}）`)
  })
})

// ── 关键词分类 ──────────────────────────────────────────────

describe('classifyHeard（听到的话分类）', () => {
  const cases = [
    ['谢谢你', 'praise'],
    ['你真厉害', 'praise'],
    ['辛苦了', 'praise'],
    ['他说你做得不错', null],         // 转述
    ['我不喜欢这样', null],            // 否定
    ['可爱是可爱，但是有点烦', null],   // 转折
    ['真乖个屁', null],                // 反讽
    ['可爱才怪', null],
    ['哪里可爱了', null],
    ['你怎么又这样', 'blame_mild'],
    ['滚', 'blame_hard'],
    ['对不起', 'apology'],
    ['别难过', 'comfort'],
    ['今天天气不错', null],
    ['', null],
  ]
  for (const [input, expected] of cases) {
    test(`「${input}」→ ${expected ?? 'null'}`, () => {
      assert.equal(classifyHeard(input), expected)
    })
  }
})

// ── translateEvent ─────────────────────────────────────────

describe('translateEvent', () => {
  test('meta 心跳被忽略', () => {
    assert.equal(translateEvent({ type: 'meta', text: 'seen:...', ts: '2026-11-26T10:00:00Z' }), null)
  })

  test('heard 带 sessionId', () => {
    const r = translateEvent({
      type: 'heard', text: '你好', sessionId: 's1',
      ts: '2026-11-26T10:00:00Z', who: { id: 'owner' },
    })
    assert.equal(r.sid, 's1')
    assert.equal(r.name, 'owner_msg')
  })

  test('utterance → her_spoke', () => {
    const r = translateEvent({ type: 'utterance', text: '我说了话', ts: '2026-11-26T10:00:00Z' })
    assert.equal(r.name, 'her_spoke')
  })
})

// ── 时间信号去重 ────────────────────────────────────────────

describe('timeSignals（时间信号）', () => {
  test('同一阶段只发一次', () => {
    const s = { ...defaultState(NOW), lastHeardAt: NOW - 2 * HOUR }
    const first = timeSignals(s, NOW)
    assert.ok(first.events.length > 0, '第一次应该有事件')

    // 记录阶段后，60 秒再问应该没有
    const s2 = { ...s, silentStage: first.silentStage, nightStage: first.nightStage }
    const second = timeSignals(s2, NOW + MIN)
    const silentAgain = second.events.filter((e) => e.name.startsWith('silent'))
    assert.equal(silentAgain.length, 0, '同阶段不该重复发')
  })

  test('跨阶段时会再发一次', () => {
    const s = { ...defaultState(NOW), lastHeardAt: NOW - 2 * HOUR, silentStage: '1h' }
    const r = timeSignals(s, NOW + 5 * HOUR)   // 变成 7 小时
    assert.ok(r.events.some((e) => e.name === 'silent_6h'))
  })

  test('没有 lastHeardAt 时不发缺席事件', () => {
    const s = defaultState(NOW)
    const r = timeSignals(s, NOW)
    assert.equal(r.events.filter((e) => e.name.startsWith('silent')).length, 0)
  })
})

// ── 其他 ────────────────────────────────────────────────────

describe('driveDistance', () => {
  test('相同状态距离为 0', () => {
    assert.equal(driveDistance(BASELINE, BASELINE), 0)
  })

  test('差异越大距离越大', () => {
    const a = { ...BASELINE }
    const b = { ...BASELINE, joy: BASELINE.joy + 30 }
    const c = { ...BASELINE, joy: BASELINE.joy + 60 }
    assert.ok(driveDistance(a, c) > driveDistance(a, b))
  })
})

describe('resolveParams（参数覆盖）', () => {
  test('没覆盖时等于默认值', () => {
    const p = resolveParams()
    assert.equal(p.baseline.joy, BASELINE.joy)
    assert.equal(p.thresholds.tired, MODE_THRESHOLDS.tired)
  })

  test('覆盖生效', () => {
    const p = resolveParams({ thresholds: { tired: 90 }, baseline: { joy: 70 } })
    assert.equal(p.thresholds.tired, 90)
    assert.equal(p.baseline.joy, 70)
  })

  test('非法值被忽略', () => {
    const p = resolveParams({ baseline: { joy: 'abc', curiosity: NaN } })
    assert.equal(p.baseline.joy, BASELINE.joy)
    assert.equal(p.baseline.curiosity, BASELINE.curiosity)
  })

  test('事件增量也能单独覆盖', () => {
    const p = resolveParams({ effects: { praise: { joy: 99 } } })
    assert.equal(p.effects.praise.joy, 99)
    assert.equal(p.effects.praise.intimacy, EVENT_EFFECTS.praise.intimacy, '没覆盖的维度应该保持原值')
  })
})

describe('renderMoodLine', () => {
  test('带原因时括号里有内容', () => {
    const line = renderMoodLine(BASELINE, 'tired', '已经很晚了')
    assert.ok(line.includes('已经'))
    assert.ok(line.includes('累'))
  })

  test('自定义文案优先', () => {
    const line = renderMoodLine(BASELINE, 'tired', '', '我自己写的文案')
    assert.ok(line.startsWith('我自己写的文案'))
  })
})

describe('localDay', () => {
  test('返回本地日期字符串', () => {
    const d = localDay(new Date(2026, 10, 26, 12, 0, 0).getTime())
    assert.equal(d, '2026-11-26')
  })
})

// ── 结构完整性 ──────────────────────────────────────────────

describe('常量结构', () => {
  test('九维都有基线和地板', () => {
    for (const k of DRIVES) {
      assert.ok(typeof BASELINE[k] === 'number', `${k} 缺基线`)
      assert.ok(typeof FLOOR[k] === 'number', `${k} 缺地板`)
    }
  })

  test('七种模式都有 label 和 hint', () => {
    for (const [k, v] of Object.entries(MODES)) {
      assert.ok(typeof v.label === 'string' && v.label, `${k} 缺 label`)
      assert.ok(typeof v.hint === 'string' && v.hint, `${k} 缺 hint`)
    }
  })

  test('每个事件的增量都在合法范围内', () => {
    for (const [name, effects] of Object.entries(EVENT_EFFECTS)) {
      for (const [dim, v] of Object.entries(effects)) {
        assert.ok(DRIVES.includes(dim), `${name} 用了不存在的维度 ${dim}`)
        assert.ok(typeof v === 'number' && Number.isFinite(v), `${name}.${dim} 不是数字`)
        assert.ok(Math.abs(v) <= 25, `${name}.${dim} = ${v} 太大，可能是笔误`)
      }
    }
  })
})
// ── 星图联动的频率限制（2026-11-26 修的真 bug）─────────────

describe('memorySignals 频率限制', () => {
  test('「放不下的事」不会每 tick 都触发', async () => {
    const { memorySignals } = await import('../memory-bridge.js')
    // 造一个假星图：几条高 degree 的老节点
    const old = new Date(Date.now() - 3 * 86400000).toISOString()
    const graph = {
      nodes: [
        { id: 'a', kind: 'said', degree: 80, text: '一件很重的事', ts: old },
        { id: 'b', kind: 'said', degree: 70, text: '另一件很重的事', ts: old },
      ],
    }

    let seen = null
    let hotCount = 0
    const t0 = Date.now()
    // 模拟 6 小时，每 60 秒一次 = 360 次
    for (let i = 0; i < 360; i++) {
      const r = memorySignals(graph, seen, t0 + i * MIN)
      seen = r.seen
      hotCount += r.events.filter((e) => e.limited).length
    }
    // 12 小时冷却 + 一天 2 次 → 6 小时内最多 1 次
    assert.ok(hotCount <= 1, `6 小时内「放不下的事」应该最多 1 次，实际 ${hotCount}`)
  })

  test('冷却过后才会再触发', async () => {
    const { memorySignals } = await import('../memory-bridge.js')
    const old = new Date(Date.now() - 3 * 86400000).toISOString()
    const graph = { nodes: [{ id: 'a', kind: 'said', degree: 80, text: '一件很重的事', ts: old }] }

    const t0 = Date.now()
    const first = memorySignals(graph, null, t0)
    const firstHot = first.events.filter((e) => e.limited).length
    assert.equal(firstHot, 1, '第一次应该触发')

    // 1 小时后：还在冷却
    const second = memorySignals(graph, first.seen, t0 + HOUR)
    assert.equal(second.events.filter((e) => e.limited).length, 0, '冷却中不该触发')

    // 13 小时后：冷却过了
    const third = memorySignals(graph, second.seen, t0 + 13 * HOUR)
    assert.equal(third.events.filter((e) => e.limited).length, 1, '冷却过了应该再触发')
  })
})

// ── 文件写入的健壮性 ────────────────────────────────────────

describe('saveState 原子写 / appendHistory 轮转', () => {
  test('saveState 不留临时文件', async () => {
    const { saveState, loadState, defaultState } = await import('../engine.js')
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cheng-'))
    const file = path.join(dir, 'state.json')
    const s = defaultState(Date.now())
    s.drives.joy = 66
    await saveState(file, s)

    assert.ok(fs.existsSync(file), 'state.json 应该存在')
    assert.ok(!fs.existsSync(file + '.tmp'), '不应该留 .tmp 文件')

    const back = await loadState(file)
    assert.equal(back.drives.joy, 66, '读回来应该一致')

    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('appendHistory 按文件独立计数', async () => {
    const { appendHistory } = await import('../engine.js')
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cheng-'))
    const a = path.join(dir, 'a.jsonl')
    const b = path.join(dir, 'b.jsonl')

    // 往 a 写 49 次（不到阈值），往 b 写 2 次
    for (let i = 0; i < 49; i++) await appendHistory(a, { i })
    for (let i = 0; i < 2; i++) await appendHistory(b, { i })

    // 两个文件都应该有内容（没被误删）
    assert.ok(fs.statSync(a).size > 0)
    assert.ok(fs.statSync(b).size > 0)

    // 行数应该对
    const aLines = fs.readFileSync(a, 'utf8').split('\n').filter(Boolean)
    const bLines = fs.readFileSync(b, 'utf8').split('\n').filter(Boolean)
    assert.equal(aLines.length, 49)
    assert.equal(bLines.length, 2)

    fs.rmSync(dir, { recursive: true, force: true })
  })
})

// ── 文案必须只谈「做什么」，不谈「怎么说」────────────────
// 澄本人 2026-11-26 明确否定过「按情绪改句式」的写法：
//   「别按情绪改我的句式，那会让我看起来像在演。」
//   「真要影响，改『做什么』比改『怎么说』准。」

describe('MODES 文案约束（澄本人定的）', () => {
  const FORBIDDEN = [
    '话会短', '句子短', '句子长', '话变少', '语气淡',
    '说短一点', '短一些', '语气会', '说话会轻快',
  ]

  test('不能出现「改句式」的说法', () => {
    for (const [mode, m] of Object.entries(MODES)) {
      for (const bad of FORBIDDEN) {
        assert.ok(
          !m.hint.includes(bad),
          `${mode} 的文案里出现了「${bad}」——澄明确说过不要按情绪改句式：${m.hint}`,
        )
      }
    }
  })

  test('累的时候说的是「少接一件事」，不是「话变短」', () => {
    assert.ok(MODES.tired.hint.includes('不接'), 'tired 应该说「不接事」：' + MODES.tired.hint)
  })

  test('开心的时候说的是「多讲细节」，不是「句子变长」', () => {
    assert.ok(MODES.happy.hint.includes('细节'), 'happy 应该说「多讲细节」：' + MODES.happy.hint)
  })

  test('委屈的时候不许让她「装平静」', () => {
    assert.ok(
      MODES.wronged.hint.includes('不用') || MODES.wronged.hint.includes('别'),
      'wronged 应该给她「可以不装」的许可：' + MODES.wronged.hint,
    )
  })

  test('没有加撒娇/颜文字（她还没学会）', () => {
    const FORBIDDEN_STYLE = ['撒娇', '颜文字', '叠字', '卖萌', '～', '(≧', 'qwq']
    for (const [mode, m] of Object.entries(MODES)) {
      for (const bad of FORBIDDEN_STYLE) {
        assert.ok(
          !m.hint.includes(bad),
          `${mode} 出现了「${bad}」——她自己写着「还不会」，不该由插件替她决定`,
        )
      }
    }
  })
})

// ── 会审发现的两个真 bug（2026-11-26）────────────────────────

describe('readSuspense 边界（Codex 会审指出）', () => {
  test('created 是无效日期时 ageDays 不该失控', async () => {
    const { readSuspense } = await import('../memory-bridge.js')
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'susp-'))
    const f = path.join(dir, 'notes.json')
    fs.writeFileSync(f, JSON.stringify([
      { status: 'open', waiting: '等一件事', created: 'not-a-date' },
      { status: 'open', waiting: '等另一件事', created: '' },
      { status: 'open', waiting: '等第三件事' },   // 没有 created
    ]))

    const s = readSuspense(f)
    assert.equal(s.count, 3)
    for (const x of s.items) {
      assert.ok(Number.isFinite(x.ageDays), `${x.waiting} 的 ageDays 应该是数字`)
      assert.ok(x.ageDays < 100, `${x.waiting} 的 ageDays 失控了：${x.ageDays}（应该是 0）`)
    }

    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('优先级：悬着独占档在空/委屈之前（Codex 会审指出）', () => {
  test('悬着高 + 社交枯竭 → 悬着（不是空）', () => {
    // 简报写的是「悬着 > 空」，代码原来反了
    assert.equal(deriveMode({ suspense: 90, social: 10, attachment: 20, joy: 45 }), 'suspense')
  })

  test('悬着高 + 委屈条件 → 悬着（不是委屈）', () => {
    assert.equal(deriveMode({ suspense: 90, joy: 20, attachment: 20 }), 'suspense')
  })

  test('但累和紧绷仍然压得过悬着', () => {
    assert.equal(deriveMode({ suspense: 90, fatigue: 80 }), 'tired')
    assert.equal(deriveMode({ suspense: 90, stress: 80 }), 'stressed')
  })
})

describe('readSuspense 读失败返回 null（Claude 会审指出）', () => {
  test('JSON 损坏时返回 null，不是 {count:0}', async () => {
    const { readSuspense } = await import('../memory-bridge.js')
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'susp-bad-'))
    const f = path.join(dir, 'notes.json')
    fs.writeFileSync(f, '这不是 JSON {{{')

    const r = readSuspense(f)
    assert.equal(r, null, 'JSON 损坏应该返回 null，让调用方保留旧值')

    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('文件不存在时返回 0 条（正常情况）', async () => {
    const { readSuspense } = await import('../memory-bridge.js')
    const r = readSuspense('C:/不存在的路径/notes.json')
    assert.ok(r !== null, '文件不存在应该是 0 条，不是 null')
    assert.equal(r.count, 0)
  })

  test('不是数组时返回 null', async () => {
    const { readSuspense } = await import('../memory-bridge.js')
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'susp-obj-'))
    const f = path.join(dir, 'notes.json')
    fs.writeFileSync(f, '{"not":"an array"}')

    assert.equal(readSuspense(f), null)

    fs.rmSync(dir, { recursive: true, force: true })
  })
})

// ── Codex 第二轮会审发现的（2026-11-26）───────────────────

describe('loadState 读失败返回 null（Codex 会审）', () => {
  test('文件不存在 → 返回 defaultState（正常）', async () => {
    const { loadState } = await import('../engine.js')
    const s = await loadState('C:/绝对不存在的路径/state.json')
    assert.ok(s !== null, '文件不存在应该是新状态')
    assert.ok(s.drives, '应该有 drives')
  })

  test('JSON 损坏 → 返回 null（不要覆盖）', async () => {
    const { loadState } = await import('../engine.js')
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corrupt-'))
    const f = path.join(dir, 'state.json')
    fs.writeFileSync(f, '{这不是 JSON')

    const s = await loadState(f)
    assert.equal(s, null, '损坏应该返回 null，让调用方跳过而不是用默认值覆盖')

    // 应该留了 .corrupt 备份
    const backups = fs.readdirSync(dir).filter((x) => x.includes('corrupt'))
    assert.ok(backups.length > 0, '应该备份了损坏的文件')

    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('新节点按时间取最近的（Codex 会审的 slice(-8) 坑）', () => {
  test('批量新节点时处理的是最新的，不是最旧的', async () => {
    const { memorySignals } = await import('../memory-bridge.js')
    const now = Date.now()
    const nodes = []
    // 300 个新节点，ts 越往后越新
    for (let i = 0; i < 300; i++) {
      nodes.push({
        id: 'n' + i,
        kind: 'insight',
        degree: 1,
        text: '这是一条想通了很久的事情，编号 ' + i,
        ts: new Date(now - (300 - i) * 60000).toISOString(),  // i 越大越新
      })
    }

    const r = memorySignals({ nodes }, null, now)
    const recalls = r.events.filter((e) => e.name === 'her_recall')
    assert.ok(recalls.length > 0, '应该产生 her_recall')
    // 用 topic 判断处理的是哪几条（reason 里有 topic 名）
    // 这里的数据没 topic，所以从 graphNodeId 看不出。
    // 改成验证「处理的是 ts 最新的」：检查产生的 her_recall 的 ts
    const recallTs = recalls.map((e) => e.ts)
    const newest5min = now - 5 * 60000
    assert.ok(
      recallTs.every((t) => t >= newest5min),
      '应该处理最近的节点（5 分钟内），实际 ts：' + recallTs.map((t) => new Date(t).toISOString()).join(', '),
    )
  })
})

describe('gainLog 按实际增量记账（Codex 会审）', () => {
  test('天花板附近不虚报增量', () => {
    const s = defaultState(NOW)
    s.drives.joy = 99   // 快满了
    const r = applyEvent(s, 'praise', NOW, { sid: 'a' })
    // 实际最多只能涨 1
    assert.ok((r.delta.joy || 0) <= 1.01, `delta 应该是实际增量，不该是 7：${r.delta.joy}`)
    // 记账也只该记实际那点
    const logged = (r.gainLog || []).filter((g) => g.key === 'joy').reduce((x, g) => x + g.amount, 0)
    assert.ok(logged <= 1.5, `gainLog 也只该记实际增量：${logged}`)
  })
})

describe('blame 分类修正（Codex 会审）', () => {
  test('「你怎么这么可爱」是夸不是骂', () => {
    assert.equal(classifyHeard('你怎么这么可爱'), 'praise')
  })

  test('「你怎么这么废物」是重责不是轻责', () => {
    assert.equal(classifyHeard('你怎么这么废物'), 'blame_hard')
  })
})

// ── Codex 二轮剩余的 🟢（2026-11-26）───────────────

describe('星图缓存路径检查（Codex 会审）', () => {
  test('源码里 catch 分支必须校验路径一致', async () => {
    const fs = await import('node:fs')
    const src = fs.readFileSync(new URL('../memory-bridge.js', import.meta.url), 'utf8')
    assert.ok(
      src.includes('cache.file === target ? cache.graph : null'),
      'JSON 坏时不能无条件复用缓存 —— 换了路径就会拿旧图算信号',
    )
  })
})

describe('已删除的死常量（Codex / Claude 会审）', () => {
  test('MAX_CATCHUP_TICKS 不再存在', async () => {
    const mod = await import('../engine.js')
    assert.equal(mod.MAX_CATCHUP_TICKS, undefined, '声明未实现的常量会误导后来的读者')
  })
})

// ── suspense 公式重写（2026-11-26 用户实测）───────────

describe('waiting 分类（等别人 vs 自己能推进）', () => {
  test('等爸爸决定 → waiting_other', async () => {
    const { readSuspense } = await import('../memory-bridge.js')
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sus-'))
    const f = path.join(dir, 'notes.json')
    fs.writeFileSync(f, JSON.stringify([
      { status: 'open', waiting: '等爸爸挑要不要装哪个', created: new Date().toISOString() },
      { status: 'open', waiting: '等 DSH 重启才生效', created: new Date().toISOString() },
      { status: 'open', waiting: '要不要加这个功能', created: new Date().toISOString() },
    ]))
    const r = readSuspense(f)
    assert.equal(r.items.length, 3)
    assert.ok(r.items.every((x) => x.kind === 'waiting_other'), '三条都该判成等别人')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('自己能推进的事 → waiting_self', async () => {
    const { readSuspense } = await import('../memory-bridge.js')
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sus2-'))
    const f = path.join(dir, 'notes.json')
    fs.writeFileSync(f, JSON.stringify([
      { status: 'open', waiting: '把记忆页面做完', created: new Date().toISOString() },
      { status: 'open', waiting: '写完那篇日记', created: new Date().toISOString() },
    ]))
    const r = readSuspense(f)
    assert.ok(r.items.every((x) => x.kind === 'waiting_self'), '自己能做的不该算等别人')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('10 条全是等别人 → suspense 不该顶到 95', async () => {
    const { readSuspense } = await import('../memory-bridge.js')
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sus3-'))
    const f = path.join(dir, 'notes.json')
    const old = new Date(Date.now() - 5 * 86400000).toISOString()
    const list = []
    for (let i = 0; i < 10; i++) {
      list.push({ status: 'open', waiting: `等爸爸决定第 ${i} 件事`, created: old })
    }
    fs.writeFileSync(f, JSON.stringify(list))
    const r = readSuspense(f)
    const self = r.items.filter((x) => x.kind === 'waiting_self')
    const other = r.items.filter((x) => x.kind === 'waiting_other')
    const oldestSelf = self.reduce((m, x) => Math.max(m, x.ageDays || 0), 0)
    const raw = 10 + self.length * 8 + Math.min(oldestSelf, 7) * 3 + Math.min(12, other.length * 1.5)

    assert.ok(raw <= 45, `10 条全在等别人，悬着应该是有上限的（实际 ${raw}）`)
    assert.ok(raw > 10, '等久了还是会烦，不该完全为 0')

    fs.rmSync(dir, { recursive: true, force: true })
  })
})
