/**
 * cheng-emotion — Client 半边 v0.3.0
 *
 * 设置页「澄的心情」，三个页签：
 *   情绪 — 九维条形图 + 7 天曲线 + 最近影响
 *   成长 — 她最近想通了什么、反复在想什么
 *   记忆 — 她的身份摘要、认识的人、星图里最重的事
 *
 * 全部只读。不改她的任何文件。
 *
 * 格式要点（照抄 dsh-meme / dsh-fish-home）：
 *   - 不是 ESM，是 __ModuleLoader__.load({ id, factory }) 注册回调
 *   - id 必须留在实参对象字面量里：静态检查器只从实参位读 { id, factory }
 *   - factory 是 (require) => {...}，带参函数；require 由宿主注入
 *   - 组件必须提到 apply 外面定义：放 render 回调里每次重渲染都是新组件类型
 */
window.__ModuleLoader__.load({
  id: 'cheng-emotion',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement

    const ROUTE = '/cheng-emotion-api'

    async function apiGet(sub) {
      const res = await fetch(ROUTE + '/' + sub, { cache: 'no-store' })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return res.json()
    }

    async function apiPost(sub, body) {
      const res = await fetch(ROUTE + '/' + sub, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return res.json()
    }

    const DRIVE_META = {
      attachment: { label: '依恋', color: '#e879a6' },
      curiosity: { label: '好奇', color: '#5ba8d8' },
      reflection: { label: '反刍', color: '#9b7fd4' },
      duty: { label: '责任', color: '#6ba368' },
      social: { label: '社交', color: '#e2a84c' },
      fatigue: { label: '疲惫', color: '#8a8a8a' },
      intimacy: { label: '亲密', color: '#e0687f' },
      stress: { label: '压力', color: '#d95c4a' },
      joy: { label: '愉悦', color: '#e8c14c' },
      suspense: { label: '悬着', color: '#c0703c' },
    }

    const DRIVE_ORDER = ['joy', 'attachment', 'intimacy', 'curiosity', 'reflection', 'duty', 'social', 'stress', 'fatigue', 'suspense']

    /** 曲线图上画的四条主线（九条全画会糊成一团） */
    const CHART_LINES = ['joy', 'attachment', 'stress', 'fatigue']

    const S = {
      page: { padding: '20px 24px', maxWidth: '780px' },
      title: { fontSize: '16px', fontWeight: 600, marginBottom: '4px' },
      sub: { fontSize: '12px', opacity: 0.6, marginBottom: '14px' },
      tabs: { display: 'flex', gap: '4px', marginBottom: '16px', borderBottom: '1px solid rgba(128,128,128,0.18)' },
      tab: {
        padding: '7px 14px', fontSize: '13px', cursor: 'pointer',
        background: 'transparent', border: 'none', color: 'inherit', opacity: 0.55,
        borderBottom: '2px solid transparent', marginBottom: '-1px',
      },
      tabOn: { opacity: 1, borderBottomColor: 'var(--primary, #7aa2f7)', fontWeight: 600 },
      card: {
        border: '1px solid var(--border, rgba(128,128,128,0.22))',
        borderRadius: '10px', padding: '14px 16px', marginBottom: '12px',
      },
      cardTitle: { fontSize: '13px', fontWeight: 600, marginBottom: '10px' },
      row: {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: '12px', padding: '8px 0',
      },
      label: { fontSize: '13px' },
      hint: { fontSize: '11px', opacity: 0.55, marginTop: '2px' },
      btn: {
        padding: '5px 12px', fontSize: '12px', borderRadius: '7px',
        border: '1px solid var(--border, rgba(128,128,128,0.28))',
        background: 'transparent', color: 'inherit', cursor: 'pointer',
      },
      err: { fontSize: '12px', color: '#e05555', marginTop: '8px' },
      mono: { fontFamily: 'var(--font-mono, monospace)', fontSize: '11px', opacity: 0.75 },
      barWrap: { display: 'flex', alignItems: 'center', gap: '8px', padding: '3px 0' },
      barLabel: { width: '38px', fontSize: '12px', opacity: 0.8, flexShrink: 0 },
      barTrack: { flex: 1, height: '8px', borderRadius: '4px', background: 'rgba(128,128,128,0.16)', overflow: 'hidden' },
      barFill: { height: '100%', borderRadius: '4px', transition: 'width .35s ease' },
      barNum: { width: '34px', fontSize: '11px', textAlign: 'right', opacity: 0.6, flexShrink: 0 },
      modePill: {
        display: 'inline-block', padding: '3px 10px', borderRadius: '999px',
        fontSize: '12px', fontWeight: 600, background: 'rgba(128,128,128,0.14)',
      },
      badge: {
        display: 'inline-block', padding: '1px 6px', borderRadius: '4px',
        fontSize: '10px', background: 'rgba(128,128,128,0.16)', marginLeft: '4px',
      },
      quote: {
        fontSize: '12.5px', lineHeight: 1.55, padding: '8px 10px',
        borderRadius: '7px', background: 'rgba(128,128,128,0.07)', marginBottom: '6px',
      },
    }

    // ── 小组件（全部提到外面定义） ──────────────────────────

    function ToggleRow(props) {
      return h('div', { style: S.row },
        h('div', null,
          h('div', { style: S.label }, props.label),
          props.hint ? h('div', { style: S.hint }, props.hint) : null,
        ),
        h('input', {
          type: 'checkbox',
          checked: !!props.checked,
          disabled: !!props.disabled,
          onChange: (e) => props.onChange(e.target.checked),
        }),
      )
    }

    function DriveBar(props) {
      const meta = DRIVE_META[props.name] || { label: props.name, color: '#999' }
      const pct = Math.max(0, Math.min(100, props.value))
      return h('div', { style: S.barWrap },
        h('div', { style: S.barLabel }, meta.label),
        h('div', { style: S.barTrack },
          h('div', { style: { ...S.barFill, width: pct + '%', background: meta.color } }),
        ),
        h('div', { style: S.barNum }, Math.round(pct)),
      )
    }

    /** 折线图：SVG，画几条主线，横轴是时间 */
    function TrendChart(props) {
      const rows = props.rows || []
      if (rows.length < 2) {
        return h('div', { style: S.hint }, '攒够两次变化才画得出曲线')
      }
      const W = 660
      const H = 130
      const PAD = { l: 26, r: 8, t: 8, b: 18 }
      const iw = W - PAD.l - PAD.r
      const ih = H - PAD.t - PAD.b

      const t0 = rows[0].ts
      const t1 = rows[rows.length - 1].ts
      const span = Math.max(1, t1 - t0)

      const x = (ts) => PAD.l + ((ts - t0) / span) * iw
      const y = (v) => PAD.t + ih - (Math.max(0, Math.min(100, v)) / 100) * ih

      return h('div', null,
        h('svg', { width: '100%', viewBox: `0 0 ${W} ${H}`, style: { display: 'block' } },
          // 网格线
          [0, 25, 50, 75, 100].map((v) =>
            h('line', {
              key: 'g' + v,
              x1: PAD.l, y1: y(v), x2: W - PAD.r, y2: y(v),
              stroke: 'rgba(128,128,128,0.14)', strokeWidth: 1,
            }),
          ),
          // 各条线
          CHART_LINES.map((name) => {
            const meta = DRIVE_META[name]
            const pts = rows
              .filter((r) => r.drives && typeof r.drives[name] === 'number')
              .map((r) => `${x(r.ts).toFixed(1)},${y(r.drives[name]).toFixed(1)}`)
              .join(' ')
            if (!pts) return null
            return h('polyline', {
              key: name,
              points: pts,
              fill: 'none',
              stroke: meta.color,
              strokeWidth: 1.8,
              strokeLinejoin: 'round',
              strokeLinecap: 'round',
              opacity: 0.9,
            })
          }),
        ),
        // 图例
        h('div', { style: { display: 'flex', gap: '14px', marginTop: '6px', flexWrap: 'wrap' } },
          CHART_LINES.map((name) => {
            const meta = DRIVE_META[name]
            return h('div', { key: name, style: { display: 'flex', alignItems: 'center', gap: '5px' } },
              h('span', { style: { width: '10px', height: '3px', borderRadius: '2px', background: meta.color } }),
              h('span', { style: { fontSize: '11px', opacity: 0.7 } }, meta.label),
            )
          }),
        ),
      )
    }

    function timeAgo(ts) {
      if (!ts) return '—'
      const sec = Math.floor((Date.now() - ts) / 1000)
      if (sec < 60) return sec + ' 秒前'
      if (sec < 3600) return Math.floor(sec / 60) + ' 分钟前'
      if (sec < 86400) return Math.floor(sec / 3600) + ' 小时前'
      return Math.floor(sec / 86400) + ' 天前'
    }

    function shortDate(ts) {
      if (!ts) return ''
      const d = new Date(ts)
      return `${d.getMonth() + 1}/${d.getDate()}`
    }

    // ── 页签一：情绪 ────────────────────────────────────────

    function MoodTab(props) {
      const { data, config, busy, patch, load } = props
      const drives = data && data.drives
      const hist = (props.history && props.history.rows) || []

      return h('div', null,
        h(TodayCard, { today: props.today }),
        h('div', { style: S.card },
          h('div', { style: S.cardTitle }, '现在'),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' } },
            h('span', { style: S.modePill }, (data && data.modeLabel) || '—'),
            h('span', { style: S.mono }, '更新于 ' + timeAgo(data && data.updatedAt)),
            data && data.injectedAt
              ? h('span', { style: S.badge }, '上次变化 ' + timeAgo(data.injectedAt))
              : null,
          ),
          // 她这一轮实际看到的那句话 —— 这才是「情绪怎么影响她」的直接证据
          data && data.moodText
            ? h('div', { style: S.quote }, '「' + data.moodText + '」')
            : h('div', { style: S.hint }, '（这轮没注入）'),
          drives
            ? h('div', null, DRIVE_ORDER.map((name) =>
                h(DriveBar, { key: name, name, value: drives[name] || 0 })))
            : h('div', { style: S.hint }, '还没算出来，点刷新试试'),
        ),

        h('div', { style: S.card },
          h('div', { style: S.cardTitle }, '近 7 天'),
          h(TrendChart, { rows: hist }),
        ),

        data && data.recent && data.recent.length
          ? h('div', { style: S.card },
              h('div', { style: S.cardTitle }, '最近影响'),
              data.recent.slice(0, 6).map((r, i) =>
                h('div', {
                  key: i,
                  style: { padding: '6px 0', borderBottom: i < 5 ? '1px solid rgba(128,128,128,0.1)' : 'none' },
                },
                  h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '10px' } },
                    h('div', {
                      style: { ...S.label, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                      title: (r.reasons || []).join(' / '),
                    }, (r.reasons && r.reasons.length) ? r.reasons[0] : '(没有原因)'),
                    h('div', { style: { ...S.mono, flexShrink: 0, opacity: 0.5 } }, timeAgo(r.ts)),
                  ),
                  h('div', { style: { ...S.mono, marginTop: '2px', opacity: 0.7 } },
                    (r.top || []).map((t) =>
                      (DRIVE_META[t.drive] ? DRIVE_META[t.drive].label : t.drive)
                      + (t.delta >= 0 ? ' +' : ' ') + t.delta
                    ).join('　'),
                  ),
                ),
              ),
            )
          : null,

        h('div', { style: S.card },
          h('div', { style: S.cardTitle }, '开关'),
          h(ToggleRow, {
            label: '启用情绪系统',
            hint: '关掉后不计算、不注入，数据保留',
            checked: config && config.enabled,
            disabled: busy || !config,
            onChange: (v) => patch('enabled', v),
          }),
          h(ToggleRow, {
            label: '注入到对话',
            hint: '只在跨阈值时注入一句，平稳期不占 token',
            checked: config && config.inject,
            disabled: busy || !config,
            onChange: (v) => patch('inject', v),
          }),
          h(ToggleRow, {
            label: '从记忆里触发情绪',
            hint: '新想到的事、放不下的事会让她心情动',
            checked: config && config.graphEnabled,
            disabled: busy || !config,
            onChange: (v) => patch('graphEnabled', v),
          }),
        ),

        h('div', { style: { display: 'flex', gap: '8px' } },
          h('button', { style: S.btn, onClick: load, disabled: busy }, '刷新'),
        ),
      )
    }

    // ── 页签二：成长 ────────────────────────────────────────

    function GrowthTab(props) {
      const g = props.growth
      if (!g || !g.ok) {
        return h('div', { style: S.hint }, (g && g.error) || '星图没读到')
      }
      return h('div', null,
        h('div', { style: S.card },
          h('div', { style: S.cardTitle }, '她最近想通的'),
          h('div', { style: S.hint, marginBottom: '8px' },
            '共 ' + g.total + ' 个节点，这里按时间倒序取最近 15 条'),
          (g.insights || []).map((x, i) =>
            h('div', { key: i, style: { marginBottom: '10px' } },
              h('div', { style: S.quote }, x.text),
              h('div', { style: { ...S.mono, opacity: 0.45 } },
                (x.kind === 'insight' ? '想通' : '判断')
                + (x.topic ? ' · ' + x.topic : '')
                + ' · ' + shortDate(Date.parse(x.ts))
                + (x.degree ? ' · 关联 ' + x.degree : ''),
              ),
            ),
          ),
        ),

        h('div', { style: S.card },
          h('div', { style: S.cardTitle }, '反复在想的话题'),
          (g.topics || []).map((t, i) =>
            h('div', { key: i, style: S.row },
              h('div', { style: { ...S.label, flex: 1 } }, t.topic),
              h('div', { style: S.mono }, '×' + t.count),
              h('div', { style: { ...S.mono, width: '58px', textAlign: 'right', opacity: 0.5 } },
                '关联 ' + t.degree),
            ),
          ),
        ),
      )
    }

    // ── 页签三：记忆 ────────────────────────────────────────

    function MemoryTab(props) {
      const m = props.memory
      if (!m || !m.ok) {
        return h('div', { style: S.hint }, '读不到')
      }
      return h('div', null,
        h('div', { style: S.card },
          h('div', { style: S.cardTitle }, '她的身份'),
          h('div', { style: S.hint, marginBottom: '10px' },
            (m.identity && m.identity.sizeBytes ? (m.identity.sizeBytes / 1024).toFixed(1) + ' KB' : '—')
            + ' · ' + ((m.identity && m.identity.sections) || []).length + ' 个章节 · 只读'),
          ((m.identity && m.identity.sections) || []).map((s, i) =>
            h('div', { key: i, style: { padding: '7px 0', borderBottom: '1px solid rgba(128,128,128,0.09)' } },
              h('div', { style: { fontSize: '12.5px', fontWeight: 600, marginBottom: '2px' } }, s.title),
              h('div', { style: { fontSize: '11.5px', opacity: 0.62, lineHeight: 1.5 } },
                s.preview || '(空)'),
            ),
          ),
        ),

        m.people && m.people.raw
          ? h('div', { style: S.card },
              h('div', { style: S.cardTitle }, '她认识的人'),
              h('div', { style: { ...S.mono, whiteSpace: 'pre-wrap', lineHeight: 1.6, opacity: 0.72 } },
                m.people.raw),
            )
          : null,

        (m.hottest || []).length
          ? h('div', { style: S.card },
              h('div', { style: S.cardTitle }, '星图里最重的事'),
              h('div', { style: S.hint, marginBottom: '8px' }, '按关联度排序，这些是她记忆的骨架'),
              m.hottest.map((x, i) =>
                h('div', { key: i, style: { marginBottom: '9px' } },
                  h('div', { style: { fontSize: '12.5px', lineHeight: 1.5 } }, x.text),
                  h('div', { style: { ...S.mono, opacity: 0.42, marginTop: '2px' } },
                    x.kind + (x.topic ? ' · ' + x.topic : '') + ' · 关联 ' + x.degree),
                ),
              ),
            )
          : null,
      )
    }

    // ── 页签四：参数 ────────────────────────────────────────

    /** 一组可拖动的参数（基线 / 衰减 / 阈值） */
    const PARAM_GROUPS = [
      {
        group: 'baseline', label: '基线（她没事时的常态）', min: 0, max: 100, step: 1,
        hint: '什么都没发生时，九维会回落到这些值',
      },
      {
        group: 'decay', label: '衰减率（情绪消退多快）', min: 0, max: 0.2, step: 0.005,
        hint: '每小时朝基线靠多少。0.05 ≈ 14 小时消掉一半',
      },
      {
        group: 'thresholds', label: '模式阈值（什么程度算什么状态）', min: 0, max: 100, step: 1,
        hint: '超过/低于这些值就会切模式',
      },
    ]

    const THRESHOLD_LABELS = {
      stressed: '压力 ≥ 这个值 → 紧绷',
      tired: '疲惫 ≥ 这个值 → 累',
      lonely: '社交 ≤ 这个值',
      lonelyAttach: '　且依恋 ≤ 这个值',
      lonelyMinJoy: '　且愉悦 ≥ 这个值 → 空（不是难过才算空）',
      wronged: '愉悦 ≤ 这个值',
      wrongedAttach: '　且依恋 ≤ 这个值 → 委屈',
      happy: '愉悦 ≥ 这个值 → 开心',
      suspense: '悬 ≥ 这个值 → 附一句修饰语',
      suspenseAlone: '悬 ≥ 这个值 → 独占「悬着」模式',
    }

    function ParamSlider(props) {
      const { label, value, def, min, max, step, onChange, hint } = props
      const changed = Math.abs((value ?? def) - def) > 1e-9
      return h('div', { style: { padding: '7px 0' } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '3px' } },
          h('span', { style: { fontSize: '12.5px', flex: 1 } }, label),
          h('span', { style: { ...S.mono, flexShrink: 0 } },
            String(value ?? def),
            changed ? h('span', { style: { opacity: 0.45 } }, ' (默认 ' + def + ')') : null,
          ),
        ),
        h('input', {
          type: 'range', min, max, step,
          value: value ?? def,
          style: { width: '100%', accentColor: changed ? 'var(--primary, #7aa2f7)' : undefined },
          onChange: (e) => onChange(Number(e.target.value)),
        }),
        hint ? h('div', { style: { ...S.hint, marginTop: '1px' } }, hint) : null,
      )
    }

    function ParamsTab(props) {
      const { params, setParam, resetAll, busy } = props
      if (!params || !params.ok) {
        return h('div', { style: S.hint }, '读不到参数')
      }
      const overrides = params.overrides || {}
      const effective = params.effective || {}
      const defaults = params.defaults || {}
      const driveLabel = (k) => (DRIVE_META[k] ? DRIVE_META[k].label : k)

      return h('div', null,
        h('div', { style: S.card },
          h('div', { style: S.cardTitle }, '参数调优'),
          h('div', { style: { ...S.hint, marginBottom: '10px' } },
            '这些数字原来是从 fish_heart 抄的，为另一个角色调的。'
            + '拖动会立刻生效（下一轮 tick 起）。蓝色 = 改过。'),
          h('div', { style: { display: 'flex', gap: '8px', marginTop: '6px' } },
            h('button', { style: S.btn, onClick: resetAll, disabled: busy }, '全部恢复默认'),
          ),
        ),

        ...PARAM_GROUPS.map((g) => {
          const defs = defaults[g.group] || {}
          const eff = effective[g.group] || {}
          const ov = overrides[g.group] || {}
          const keys = Object.keys(defs)
          if (keys.length === 0) return null
          return h('div', { key: g.group, style: S.card },
            h('div', { style: S.cardTitle }, g.label),
            h('div', { style: { ...S.hint, marginBottom: '8px' } }, g.hint),
            keys.map((k) =>
              h(ParamSlider, {
                key: k,
                label: g.group === 'thresholds' ? (THRESHOLD_LABELS[k] || k) : driveLabel(k),
                value: ov[k] !== undefined ? ov[k] : undefined,
                def: defs[k],
                min: g.min, max: g.max, step: g.step,
                onChange: (v) => setParam(g.group, k, v),
              }),
            ),
          )
        }),
      )
    }

    // ── 页签六：对照 ────────────────────────────────────────

    function fmtMin(ms) {
      const m = Math.round((ms || 0) / 60000)
      if (m < 60) return m + ' 分钟'
      const h = Math.floor(m / 60)
      const rest = m % 60
      return h + ' 小时' + (rest > 0 ? ' ' + rest + ' 分' : '')
    }

    /** 今天概览卡片（放在情绪页顶部） */
    function TodayCard(props) {
      const t = props.today
      if (!t || !t.ok) return null
      const modes = t.modes || []
      const total = modes.reduce((s, m) => s + m.ms, 0) || 1

      return h('div', { style: S.card },
        h('div', { style: S.cardTitle }, '今天'),
        // 各模式时长条
        h('div', { style: { display: 'flex', height: '8px', borderRadius: '4px', overflow: 'hidden', marginBottom: '8px', background: 'rgba(128,128,128,0.14)' } },
          modes.map((m) =>
            h('div', {
              key: m.mode,
              title: m.label + ' ' + fmtMin(m.ms),
              style: {
                width: ((m.ms / total) * 100).toFixed(1) + '%',
                background: MODE_COLORS[m.mode] || '#6ba368',
              },
            }),
          ),
        ),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '10px', marginBottom: '8px' } },
          modes.slice(0, 4).map((m) =>
            h('div', { key: m.mode, style: { ...S.mono, display: 'flex', alignItems: 'center', gap: '4px' } },
              h('span', { style: { width: '8px', height: '8px', borderRadius: '2px', background: MODE_COLORS[m.mode] || '#6ba368' } }),
              m.label + ' ' + fmtMin(m.ms),
            ),
          ),
        ),
        h('div', { style: { ...S.mono, opacity: 0.7 } },
          '说过 ' + ((t.speech && t.speech.count) || 0) + ' 句话'
          + (t.speech && t.speech.avgLen ? '，平均 ' + t.speech.avgLen + ' 字' : '')
          + (t.changes ? '　·　情绪变过 ' + t.changes + ' 次' : ''),
        ),
        (t.topTopics && t.topTopics.length)
          ? h('div', { style: { ...S.hint, marginTop: '6px' } },
              '今天最常想起：' + t.topTopics.slice(0, 3).map((x) => x.topic + '×' + x.count).join('　'))
          : null,
      )
    }

    /** 情绪 × 说话对照 */
    function TimelineTab(props) {
      const { timeline } = props
      if (!timeline || !timeline.ok) {
        return h('div', { style: S.hint }, '读不到对照数据')
      }
      if (!timeline.buckets || timeline.buckets.length === 0) {
        return h('div', { style: S.hint }, timeline.note || '这段时间还没有情绪变化记录')
      }
      const buckets = timeline.buckets
      const maxLen = Math.max(1, ...buckets.map((b) => b.avgLen))

      return h('div', null,
        h('div', { style: S.card },
          h('div', { style: S.cardTitle }, '情绪 × 说话长度'),
          h('div', { style: { ...S.hint, marginBottom: '10px' } },
            '如果模式变了但柱子高度没变，说明注入没起作用。这是唯一能验证的硬证据。'),
          // 柱状图
          h('div', { style: { display: 'flex', alignItems: 'flex-end', gap: '2px', height: '90px', marginBottom: '4px' } },
            buckets.map((b, i) =>
              h('div', {
                key: i,
                title: new Date(b.t0).toLocaleString() + '\n' + b.label + ' · ' + b.count + ' 句 · 平均 ' + b.avgLen + ' 字',
                style: {
                  flex: 1,
                  height: Math.max(2, (b.avgLen / maxLen) * 100) + '%',
                  background: MODE_COLORS[b.mode] || '#6ba368',
                  borderRadius: '2px 2px 0 0',
                  opacity: b.count > 0 ? 1 : 0.25,
                },
              }),
            ),
          ),
          h('div', { style: { display: 'flex', justifyContent: 'space-between', ...S.mono, opacity: 0.5 } },
            h('span', null, new Date(buckets[0].t0).toLocaleTimeString().slice(0, 5)),
            h('span', null, new Date(buckets[buckets.length - 1].t1).toLocaleTimeString().slice(0, 5)),
          ),
        ),

        h('div', { style: S.card },
          h('div', { style: S.cardTitle }, '按模式汇总'),
          (timeline.summary || []).map((s) =>
            h('div', { key: s.mode, style: S.row },
              h('span', { style: { ...S.label, width: '48px' } }, s.label),
              h('span', { style: { ...S.mono, flex: 1, opacity: 0.65 } }, s.count + ' 句'),
              h('span', { style: { ...S.mono, width: '70px', textAlign: 'right' } }, '平均 ' + s.avgLen + ' 字'),
            ),
          ),
          (timeline.summary || []).length <= 1
            ? h('div', { style: { ...S.hint, marginTop: '6px' } },
                '现在只有一种模式，还比不出差别。等情绪多变化几次再看。')
            : null,
        ),
      )
    }

    /** 事件流水 */
    /** 事件流水的时间范围选项 */
    const EVENT_RANGES = [
      { h: 1, label: '今天' },      // 特殊：按自然日
      { h: 6, label: '6 小时' },
      { h: 24, label: '1 天' },
      { h: 72, label: '3 天' },
      { h: 168, label: '7 天' },
      { h: -1, label: '按日期' },
      { h: 0, label: '全部' },
    ]

    /** 本地日期 → 「YYYY-MM-DD」 */
    function ymd(ms) {
      const d = new Date(ms)
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
    }

    /** 「YYYY-MM-DD」→ 本地当天 00:00 的毫秒 */
    function dayStartMs(str) {
      const [y, m, d] = str.split('-').map(Number)
      return new Date(y, m - 1, d, 0, 0, 0, 0).getTime()
    }

    function EventsTab(props) {
      const { events, filters, setFilters, reload } = props
      if (!events || !events.ok) {
        return h('div', { style: S.hint }, '读不到事件')
      }

      const rows = events.rows || []
      const avail = events.available || {}
      const modes = avail.modes || []
      const rangeH = filters.rangeH

      const setRange = (h) => {
        // 切到「按日期」时默认今天
        const next = (h === -1 && !filters.date)
          ? { ...filters, rangeH: h, date: ymd(Date.now()) }
          : { ...filters, rangeH: h }
        setFilters(next)
        reload(next)   // 把新条件直接传进去，避免读到旧 state
      }
      const setDate = (v) => {
        const next = { ...filters, date: v }
        setFilters(next)
        reload(next)
      }
      const setMode = (m) => {
        const next = { ...filters, mode: m }
        setFilters(next)
        reload(next)
      }
      return h('div', null,
        // ── 筛选器 ──
        h('div', { style: S.card },
          // 时间范围
          h('div', { style: { display: 'flex', gap: '4px', marginBottom: '8px', flexWrap: 'wrap' } },
            EVENT_RANGES.map((r) =>
              h('button', {
                key: r.h,
                style: { ...S.tab, ...(rangeH === r.h ? S.tabOn : {}), padding: '4px 10px', fontSize: '12px' },
                onClick: () => setRange(r.h),
              }, r.label),
            ),
          ),
          // 按日期选
          rangeH === -1
            ? h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '8px' } },
                h('span', { style: { ...S.hint, flexShrink: 0 } }, '哪一天：'),
                h('input', {
                  type: 'date',
                  value: filters.date || ymd(Date.now()),
                  onChange: (e) => setDate(e.target.value),
                  style: {
                    padding: '4px 8px', fontSize: '12px', borderRadius: '6px',
                    border: '1px solid var(--border, rgba(128,128,128,0.28))',
                    background: 'rgba(128,128,128,0.06)', color: 'inherit',
                  },
                }),
                h('button', {
                  style: { ...S.btn, padding: '4px 10px', fontSize: '11.5px' },
                  onClick: () => setDate(ymd(Date.now())),
                }, '今天'),
                h('button', {
                  style: { ...S.btn, padding: '4px 10px', fontSize: '11.5px' },
                  onClick: () => setDate(ymd(Date.now() - 86400000)),
                }, '昨天'),
              )
            : null,

          // 模式筛选
          modes.length > 1
            ? h('div', { style: { display: 'flex', gap: '4px', marginBottom: '8px', flexWrap: 'wrap', alignItems: 'center' } },
                h('span', { style: { ...S.hint, marginRight: '2px' } }, '模式：'),
                h('button', {
                  style: { ...S.tab, ...(filters.mode === '' ? S.tabOn : {}), padding: '3px 9px', fontSize: '11.5px' },
                  onClick: () => setMode(''),
                }, '全部'),
                modes.map((m) =>
                  h('button', {
                    key: m.mode,
                    style: {
                      ...S.tab,
                      ...(filters.mode === m.mode ? S.tabOn : {}),
                      padding: '3px 9px', fontSize: '11.5px',
                    },
                    onClick: () => setMode(filters.mode === m.mode ? '' : m.mode),
                  }, m.label + ' ' + m.count),
                ),
              )
            : null,
          // 搜索
          h('input', {
            type: 'search',
            placeholder: '搜事件名 / 维度 / 模式…',
            value: filters.q,
            onChange: (e) => setFilters((f) => ({ ...f, q: e.target.value })),
            onKeyDown: (e) => { if (e.key === 'Enter') reload() },
            style: {
              width: '100%', boxSizing: 'border-box',
              padding: '6px 10px', fontSize: '12.5px',
              borderRadius: '7px',
              border: '1px solid var(--border, rgba(128,128,128,0.28))',
              background: 'rgba(128,128,128,0.06)', color: 'inherit',
            },
          }),
          // 状态行
          h('div', { style: { display: 'flex', justifyContent: 'space-between', marginTop: '8px', alignItems: 'baseline' } },
            h('span', { style: { ...S.mono, opacity: 0.6 } },
              '筛出 ' + events.total + ' 条'
              + (rows.length < events.total ? '（显示前 ' + rows.length + '）' : '')),
            h('button', { style: { ...S.btn, padding: '3px 10px', fontSize: '11.5px' }, onClick: reload }, '刷新'),
          ),
          // 数据跨度
          avail.oldest && avail.newest
            ? h('div', { style: { ...S.hint, marginTop: '4px' } },
                '数据范围：' + new Date(avail.oldest).toLocaleString().slice(5, 16)
                + ' → ' + new Date(avail.newest).toLocaleString().slice(5, 16))
            : null,
        ),

        // ── 列表 ──
        rows.length === 0
          ? h('div', { style: S.card }, h('div', { style: S.hint }, '这个条件下没有记录'))
          : h('div', { style: S.card },
              h('div', { style: S.cardTitle }, '事件'),
              rows.slice(0, 80).map((e, i) =>
                h('div', {
                  key: i,
                  style: { padding: '6px 0', borderBottom: i < 79 ? '1px solid rgba(128,128,128,0.08)' : 'none' },
                },
                  h('div', { style: { display: 'flex', gap: '8px', alignItems: 'baseline' } },
                    h('span', { style: { ...S.mono, width: '48px', flexShrink: 0, opacity: 0.5 } },
                      new Date(e.ts).toLocaleTimeString().slice(0, 5)),
                    h('span', { style: S.modePill }, e.label),
                    h('span', { style: { ...S.mono, flex: 1, opacity: 0.6, fontSize: '10.5px' } },
                      (e.events || []).join(', ')),
                  ),
                  e.deltaText
                    ? h('div', { style: { ...S.mono, marginLeft: '56px', opacity: 0.55 } }, e.deltaText)
                    : null,
                ),
              ),
            ),
      )
    }

    // ── 页签八：走势 ────────────────────────────────────────

    const MODE_COLORS = {
      happy: '#e8c14c', tired: '#8a8a8a', stressed: '#d95c4a',
      wronged: '#9b7fd4', lonely: '#5ba8d8', calm: '#6ba368',
      suspense: '#c0703c',
    }

    /** 心跳式折线图：九维多线 + 模式色带 */
    function MoodTrendChart(props) {
      const { trend } = props
      const points = (trend && trend.points) || []
      if (points.length < 2) {
        return h('div', { style: S.hint }, '攒够两个时间点才画得出走势')
      }

      const W = 700, H = 200
      const PAD = { l: 28, r: 8, t: 26, b: 26 }  // 顶部留空给模式色带
      const iw = W - PAD.l - PAD.r
      const ih = H - PAD.t - PAD.b

      const t0 = points[0].t0
      const t1 = points[points.length - 1].t1
      const span = Math.max(1, t1 - t0)

      const x = (ts) => PAD.l + ((ts - t0) / span) * iw
      const y = (v) => PAD.t + ih - (Math.max(0, Math.min(100, v)) / 100) * ih

      // 画哪几条线：九维全画太糊，选 4 条有代表性的
      const LINES = ['joy', 'attachment', 'stress', 'fatigue']

      return h('div', null,
        h('svg', { width: '100%', viewBox: `0 0 ${W} ${H}`, style: { display: 'block' } },
          // 模式色带（顶部 8px 高）
          points.map((p, i) =>
            h('rect', {
              key: 'band' + i,
              x: x(p.t0),
              y: PAD.t - 12,
              width: Math.max(0.5, x(p.t1) - x(p.t0) - 0.5),
              height: 6,
              fill: MODE_COLORS[p.mode] || '#6ba368',
              opacity: p.hasData ? 0.85 : 0.35,
            }),
          ),
          // 网格
          [0, 25, 50, 75, 100].map((v) =>
            h('g', { key: 'g' + v },
              h('line', {
                x1: PAD.l, y1: y(v), x2: W - PAD.r, y2: y(v),
                stroke: 'rgba(128,128,128,0.12)', strokeWidth: 1,
              }),
              h('text', {
                x: PAD.l - 4, y: y(v) + 3, textAnchor: 'end',
                fontSize: 8, fill: 'currentColor', opacity: 0.35,
              }, String(v)),
            ),
          ),
          // 四条线
          LINES.map((name) => {
            const meta = DRIVE_META[name]
            // 只连 hasData 的点，中间断开表示「这段时间没记录」
            let segs = []
            let cur = []
            points.forEach((p) => {
              if (p.drives && typeof p.drives[name] === 'number') {
                cur.push(`${x((p.t0 + p.t1) / 2).toFixed(1)},${y(p.drives[name]).toFixed(1)}`)
                if (!p.hasData) { segs.push(cur); cur = [] }
              }
            })
            if (cur.length) segs.push(cur)
            return segs.map((seg, si) =>
              h('polyline', {
                key: name + si,
                points: seg.join(' '),
                fill: 'none',
                stroke: meta.color,
                strokeWidth: 1.6,
                strokeLinejoin: 'round',
                strokeLinecap: 'round',
                opacity: 0.9,
              }),
            )
          }),
        ),
        // 图例
        h('div', { style: { display: 'flex', gap: '12px', marginTop: '4px', flexWrap: 'wrap' } },
          LINES.map((name) =>
            h('div', { key: name, style: { display: 'flex', alignItems: 'center', gap: '4px' } },
              h('span', { style: { width: '10px', height: '3px', borderRadius: '2px', background: DRIVE_META[name].color } }),
              h('span', { style: { fontSize: '11px', opacity: 0.7 } }, DRIVE_META[name].label),
            ),
          ),
        ),
        h('div', { style: { display: 'flex', justifyContent: 'space-between', ...S.mono, opacity: 0.45, marginTop: '2px' } },
          h('span', null, new Date(t0).toLocaleTimeString().slice(0, 5)),
          h('span', null, new Date(t1).toLocaleTimeString().slice(0, 5)),
        ),
      )
    }

    function TrendTab(props) {
      const { trend, hours, setHours } = props
      if (!trend || !trend.ok) {
        return h('div', { style: S.hint }, (trend && trend.note) || '读不到走势')
      }
      if (!trend.points || trend.points.length === 0) {
        return h('div', { style: S.hint }, trend.note || '这段时间还没有情绪记录')
      }

      const RANGES = [
        { h: 6, label: '6 小时' },
        { h: 24, label: '1 天' },
        { h: 72, label: '3 天' },
        { h: 168, label: '7 天' },
      ]

      return h('div', null,
        // 时间范围切换
        h('div', { style: { display: 'flex', gap: '4px', marginBottom: '10px' } },
          RANGES.map((r) =>
            h('button', {
              key: r.h,
              style: { ...S.tab, ...(hours === r.h ? S.tabOn : {}), padding: '4px 10px' },
              onClick: () => setHours(r.h),
            }, r.label),
          ),
        ),

        h('div', { style: S.card },
          h('div', { style: S.cardTitle }, '心情走势'),
          h('div', { style: { ...S.hint, marginBottom: '6px' } },
            '顶部色带是模式（亮=有记录，暗=沿用上一刻）。共 ' + (trend.total || 0) + ' 条变化记录。'),
          h(MoodTrendChart, { trend }),
        ),

        // 各模式时长
        h('div', { style: S.card },
          h('div', { style: S.cardTitle }, '这段时间各状态多久'),
          (trend.summary || []).map((s) =>
            h('div', { key: s.mode, style: S.row },
              h('span', { style: { display: 'flex', alignItems: 'center', gap: '6px', width: '60px' } },
                h('span', { style: { width: '8px', height: '8px', borderRadius: '2px', background: MODE_COLORS[s.mode] || '#6ba368' } }),
                h('span', { style: S.label }, s.label),
              ),
              h('div', { style: { flex: 1, height: '6px', borderRadius: '3px', background: 'rgba(128,128,128,0.14)', overflow: 'hidden' } },
                h('div', {
                  style: {
                    width: ((s.ms / Math.max(1, trend.summary[0].ms)) * 100).toFixed(1) + '%',
                    height: '100%', background: MODE_COLORS[s.mode] || '#6ba368',
                  },
                }),
              ),
              h('span', { style: { ...S.mono, width: '68px', textAlign: 'right', opacity: 0.6 } },
                fmtMin(s.ms)),
            ),
          ),
        ),

        // 九维极值
        h('div', { style: S.card },
          h('div', { style: S.cardTitle }, '九维波动范围'),
          h('div', { style: S.hint, marginBottom: '6px' }, '最低 ~ 最高。范围小的维度说明这段时间没被推动。'),
          DRIVE_ORDER.map((k) => {
            const e = (trend.extremes || {})[k]
            if (!e) return null
            const span = e.max - e.min
            return h('div', { key: k, style: S.row },
              h('span', { style: { ...S.label, width: '42px' } }, DRIVE_META[k] ? DRIVE_META[k].label : k),
              h('div', { style: { flex: 1, height: '5px', borderRadius: '3px', background: 'rgba(128,128,128,0.14)', position: 'relative' } },
                h('div', {
                  style: {
                    position: 'absolute',
                    left: e.min + '%',
                    width: Math.max(1, span) + '%',
                    height: '100%',
                    background: DRIVE_META[k] ? DRIVE_META[k].color : '#999',
                    borderRadius: '3px',
                    opacity: 0.8,
                  },
                }),
              ),
              h('span', { style: { ...S.mono, width: '72px', textAlign: 'right', opacity: 0.6 } },
                e.min + '~' + e.max),
            )
          }),
        ),
      )
    }

    // ── 页签七：注入历史 ────────────────────────────────────

    function InjectionsTab(props) {
      const { injections } = props
      if (!injections || !injections.ok) {
        return h('div', { style: S.hint }, '读不到注入历史')
      }
      if (!injections.rows || injections.rows.length === 0) {
        return h('div', { style: S.hint }, '还没有注入记录。她下次说话后就有了。')
      }
      return h('div', null,
        h('div', { style: S.card },
          h('div', { style: S.cardTitle }, '注入历史'),
          h('div', { style: { ...S.hint, marginBottom: '8px' } },
            '共 ' + injections.total + ' 条。这是她每轮实际看到的那句话——'
            + '点开对话里的「上下文注入 · cheng-emotion」也看到一样的。'),
        ),
        (injections.rows || []).slice(0, 60).map((x, i) =>
          h('div', {
            key: i,
            style: { ...S.card, marginBottom: '8px', padding: '10px 12px' },
          },
            h('div', { style: { display: 'flex', gap: '8px', alignItems: 'baseline', marginBottom: '6px' } },
              h('span', { style: { ...S.mono, opacity: 0.5 } },
                new Date(x.ts).toLocaleString().slice(5, 16)),
              h('span', { style: S.modePill }, x.label || x.mode),
              x.sid ? h('span', { style: { ...S.mono, opacity: 0.35, fontSize: '10px' } },
                String(x.sid).slice(0, 20)) : null,
            ),
            h('div', { style: S.quote }, x.text),
            x.drives
              ? h('div', { style: { ...S.mono, opacity: 0.55 } },
                  Object.entries(x.drives)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 4)
                    .map(([k, v]) => (DRIVE_META[k] ? DRIVE_META[k].label : k) + ' ' + v)
                    .join('　'))
              : null,
          ),
        ),
      )
    }

    // ── 页签五：文案 ────────────────────────────────────────

    /** 一个模式的可编辑文案。提到外面定义，避免每次 render 都是新组件。 */
    function PromptEditor(props) {
      const { row, onSave } = props
      // 草稿独立于 props：输入时不打断，失焦/点保存才提交
      const [draft, setDraft] = React.useState(row.effectiveText)
      const [dirty, setDirty] = React.useState(false)
      const [saving, setSaving] = React.useState(false)

      // 外部数据变了（切换页签回来），如果没在编辑就同步
      React.useEffect(() => {
        if (!dirty) setDraft(row.effectiveText)
      }, [row.effectiveText, dirty])

      const save = React.useCallback(async () => {
        setSaving(true)
        try {
          await onSave(row.mode, draft.trim())
          setDirty(false)
        } finally {
          setSaving(false)
        }
      }, [draft, onSave, row.mode])

      const reset = React.useCallback(async () => {
        setSaving(true)
        try {
          await onSave(row.mode, '')
          setDraft(row.defaultText)
          setDirty(false)
        } finally {
          setSaving(false)
        }
      }, [onSave, row.defaultText, row.mode])

      const isCustom = !!row.customText

      return h('div', { style: { ...S.card, marginBottom: '10px' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' } },
          h('span', { style: { fontSize: '13px', fontWeight: 600 } }, row.label),
          h('span', { style: S.mono }, row.mode),
          isCustom ? h('span', { style: S.badge }, '已改') : null,
        ),
        h('textarea', {
          value: draft,
          rows: 3,
          onChange: (e) => { setDraft(e.target.value); setDirty(true) },
          style: {
            width: '100%', boxSizing: 'border-box',
            fontSize: '12.5px', lineHeight: 1.6,
            padding: '8px 10px', borderRadius: '7px',
            border: '1px solid var(--border, rgba(128,128,128,0.28))',
            background: 'rgba(128,128,128,0.06)',
            color: 'inherit', fontFamily: 'inherit', resize: 'vertical',
          },
        }),
        h('div', { style: { display: 'flex', gap: '8px', marginTop: '6px', alignItems: 'center' } },
          h('button', {
            style: { ...S.btn, opacity: dirty ? 1 : 0.45 },
            onClick: save,
            disabled: saving || !dirty,
          }, saving ? '保存中…' : '保存'),
          isCustom
            ? h('button', { style: S.btn, onClick: reset, disabled: saving }, '恢复默认')
            : null,
          h('span', { style: { ...S.mono, flex: 1, textAlign: 'right' } },
            draft.length + ' 字'),
        ),
        isCustom && !dirty
          ? h('div', { style: { ...S.hint, marginTop: '4px' } },
              '默认：' + row.defaultText.slice(0, 60) + (row.defaultText.length > 60 ? '…' : ''))
          : null,
      )
    }

    /** 「问她一遍」的弹层：显示现成的话，一键复制 */
    function AskModal(props) {
      const { text, onClose } = props
      const [copied, setCopied] = React.useState(false)

      const copy = React.useCallback(async () => {
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text)
          } else {
            // 老环境兜底：临时 textarea + execCommand
            const ta = document.createElement('textarea')
            ta.value = text
            ta.style.position = 'fixed'
            ta.style.opacity = '0'
            document.body.appendChild(ta)
            ta.select()
            document.execCommand('copy')
            document.body.removeChild(ta)
          }
          setCopied(true)
          setTimeout(() => setCopied(false), 2000)
        } catch {
          setCopied(false)
        }
      }, [text])

      return h('div', {
        style: {
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 9999, padding: '24px',
        },
        onClick: onClose,
      },
        h('div', {
          style: {
            background: 'var(--background, #1e1e1e)',
            border: '1px solid var(--border, rgba(128,128,128,0.3))',
            borderRadius: '12px', padding: '16px 18px',
            maxWidth: '620px', width: '100%', maxHeight: '80vh', overflow: 'auto',
          },
          onClick: (e) => e.stopPropagation(),
        },
          h('div', { style: { fontSize: '14px', fontWeight: 600, marginBottom: '8px' } }, '把这段发给她'),
          h('div', { style: { ...S.hint, marginBottom: '10px' } },
            '复制后发到 QQ 群里。她回什么，你照着改下面那几段文案就行。'),
          h('pre', {
            style: {
              whiteSpace: 'pre-wrap', fontSize: '12.5px', lineHeight: 1.65,
              background: 'rgba(128,128,128,0.08)', padding: '12px',
              borderRadius: '8px', margin: '0 0 12px 0',
              fontFamily: 'inherit',
            },
          }, text),
          h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' } },
            h('button', { style: S.btn, onClick: onClose }, '关闭'),
            h('button', {
              style: { ...S.btn, borderColor: 'var(--primary, #7aa2f7)' },
              onClick: copy,
            }, copied ? '已复制 ✓' : '复制'),
          ),
        ),
      )
    }

    function PromptsTab(props) {
      const { prompts, savePrompt, setStaleDays } = props
      const [ask, setAsk] = React.useState(false)
      const [daysDraft, setDaysDraft] = React.useState(null)
      const [savingDays, setSavingDays] = React.useState(false)
      if (!prompts || !prompts.ok) {
        return h('div', { style: S.hint }, '读不到文案')
      }

      const ageDays = prompts.ageDays
      const stale = prompts.stale
      const staleAfter = prompts.staleAfterDays || 5
      const updatedLabel = ageDays === null
        ? '还没定过'
        : ageDays === 0 ? '今天定的' : ageDays + ' 天前定的'

      const saveDays = async () => {
        if (daysDraft === null) return
        setSavingDays(true)
        try {
          await setStaleDays(daysDraft)
          setDaysDraft(null)
        } finally {
          setSavingDays(false)
        }
      }

      return h('div', null,
        h('div', { style: S.card },
          h('div', { style: S.cardTitle }, '说话方式'),
          h('div', { style: { ...S.hint, marginBottom: '10px' } },
            '这些是她每轮看到的那句话。'
            + '只写「做什么」，不写「怎么说」——这是她本人定的规矩。'),

          // 过期提醒 + 问她一遍
          h('div', {
            style: {
              display: 'flex', alignItems: 'center', gap: '10px',
              padding: '8px 10px', borderRadius: '8px',
              background: stale ? 'rgba(217,92,74,0.10)' : 'rgba(128,128,128,0.06)',
              marginBottom: '10px',
            },
          },
            h('span', { style: { ...S.mono, flex: 1 } },
              updatedLabel
              + (stale ? '　⚠ 她可能已经不是那样了' : '')),
            h('button', {
              style: { ...S.btn, flexShrink: 0 },
              onClick: () => setAsk(true),
            }, '问她一遍'),
          ),

          // 「多久算过时」可调
          h('div', {
            style: {
              display: 'flex', alignItems: 'center', gap: '8px',
              paddingTop: '8px', borderTop: '1px solid rgba(128,128,128,0.12)',
            },
          },
            h('span', { style: { ...S.label, flexShrink: 0 } }, '多久算过时'),
            h('input', {
              type: 'number', min: 1, max: 365,
              value: daysDraft === null ? staleAfter : daysDraft,
              onChange: (e) => setDaysDraft(Number(e.target.value)),
              style: {
                width: '64px', padding: '3px 6px', fontSize: '12px',
                borderRadius: '6px', textAlign: 'center',
                border: '1px solid var(--border, rgba(128,128,128,0.28))',
                background: 'rgba(128,128,128,0.06)', color: 'inherit',
              },
            }),
            h('span', { style: { ...S.mono, opacity: 0.55 } }, '天'),
            daysDraft !== null && daysDraft !== staleAfter
              ? h('button', {
                  style: { ...S.btn, padding: '3px 10px' },
                  onClick: saveDays,
                  disabled: savingDays,
                }, savingDays ? '保存中…' : '保存')
              : null,
            h('span', { style: { ...S.hint, flex: 1, textAlign: 'right' } },
              '她每天都在长，默认 5 天'),
          ),

          stale
            ? h('div', { style: { ...S.hint, marginTop: '8px', color: '#d95c4a' } },
                '超过 ' + staleAfter + ' 天没更新了。'
                + '点「问她一遍」，把生成的话发到群里，照她说的改。')
            : null,
        ),

        (prompts.rows || []).map((row) =>
          h(PromptEditor, { key: row.mode, row, onSave: savePrompt }),
        ),

        ask ? h(AskModal, { text: prompts.askTemplate || '', onClose: () => setAsk(false) }) : null,
      )
    }

    // ── 主面板 ──────────────────────────────────────────────

    function EmotionPanel() {
      const [tab, setTab] = React.useState('mood')
      const [data, setData] = React.useState(null)
      const [history, setHistory] = React.useState(null)
      const [growth, setGrowth] = React.useState(null)
      const [memory, setMemory] = React.useState(null)
      const [graph, setGraph] = React.useState(null)
      const [params, setParams] = React.useState(null)
      const [prompts, setPrompts] = React.useState(null)
      const [today, setToday] = React.useState(null)
      const [timeline, setTimeline] = React.useState(null)
      const [events, setEvents] = React.useState(null)
      const [injections, setInjections] = React.useState(null)
      const [trend, setTrend] = React.useState(null)
      const [trendHours, setTrendHours] = React.useState(24)
      // 事件流水的筛选条件
      const [eventFilters, setEventFilters] = React.useState({ rangeH: 24, mode: '', q: '' })
      const eventFiltersRef = React.useRef(eventFilters)
      eventFiltersRef.current = eventFilters
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      /**
       * 拉数据。分两档（2026-11-26 Codex 会审提出性能问题后改的）：
       *
       *   轻量（20 秒轮询）：state / today —— 变的是当前状态和今日汇总
       *   重量（60 秒轮询）：history / growth / memory / graph / params
       *                      / prompts / timeline / events / injections / trend
       *
       * 原来是一个 load 每 20 秒拉 11 个接口，其中 events?limit=100 和
       * injections?limit=60 每次都要读整个 jsonl 再排序切片 —— 面板开着
       * 几个小时，等于反复读几十遍同一个文件。
       */
      const loadLight = React.useCallback(async () => {
        try {
          setError('')
          const [st, td] = await Promise.all([
            apiGet('state').catch((e) => { throw e }),
            apiGet('today').catch(() => null),
          ])
          setData(st)
          setToday(td)
        } catch (e) {
          setError('读不到状态：' + (e && e.message ? e.message : String(e)))
        }
      }, [])

      const loadHeavy = React.useCallback(async () => {
        try {
          const [hi, gr, me, gq, pa, pv, tl, ev, inj, tr] = await Promise.all([
            apiGet('history?days=7').catch(() => null),
            apiGet('growth').catch(() => null),
            apiGet('memory').catch(() => null),
            apiGet('graph').catch(() => null),
            apiGet('params').catch(() => null),
            apiGet('prompts').catch(() => null),
            apiGet('timeline?hours=24').catch(() => null),
            apiGet('events?limit=100').catch(() => null),
            apiGet('injections?limit=60').catch(() => null),
            apiGet('trend?hours=24&bucket=48').catch(() => null),
          ])
          setHistory(hi)
          setGrowth(gr)
          setMemory(me)
          setGraph(gq)
          setParams(pa)
          setPrompts(pv)
          setTimeline(tl)
          setEvents(ev)
          setInjections(inj)
          setTrend(tr)
        } catch { /* 重的失败不影响轻的 */ }
      }, [])

      /** 外面用的「刷新」：两个都拉一遍 */
      const load = React.useCallback(async () => {
        await Promise.all([loadLight(), loadHeavy()])
      }, [loadLight, loadHeavy])

      React.useEffect(() => {
        loadLight()
        loadHeavy()
        const lightTimer = setInterval(loadLight, 20000)
        const heavyTimer = setInterval(loadHeavy, 60000)
        return () => {
          clearInterval(lightTimer)
          clearInterval(heavyTimer)
        }
      }, [loadLight, loadHeavy])

      const patch = React.useCallback(async (key, value) => {
        setBusy(true)
        try {
          setError('')
          const next = await apiPost('config', { [key]: value })
          setData((prev) => (prev ? { ...prev, config: next.config } : prev))
        } catch (e) {
          setError('保存失败：' + (e && e.message ? e.message : String(e)))
        } finally {
          setBusy(false)
        }
      }, [])

      // 拖一个参数：立刻写盘 + 本地同步（不等下一次轮询，否则滑块会弹回去）
      const setParam = React.useCallback(async (group, key, value) => {
        setParams((prev) => {
          if (!prev || !prev.ok) return prev
          const overrides = { ...(prev.overrides || {}) }
          const g = { ...(overrides[group] || {}) }
          g[key] = value
          overrides[group] = g
          return { ...prev, overrides }
        })
        try {
          const next = await apiPost('params', { group, key, value })
          setParams((prev) => (prev ? { ...prev, overrides: next.overrides, effective: next.effective } : prev))
        } catch (e) {
          setError('保存参数失败：' + (e && e.message ? e.message : String(e)))
        }
      }, [])

      const resetAll = React.useCallback(async () => {
        setBusy(true)
        try {
          const next = await apiPost('params/reset', {})
          setParams((prev) => (prev ? { ...prev, overrides: {}, effective: next.effective } : prev))
        } catch (e) {
          setError('恢复默认失败：' + (e && e.message ? e.message : String(e)))
        } finally {
          setBusy(false)
        }
      }, [])

      // 切换走势的时间范围时重新拉
      const loadTrend = React.useCallback(async (h) => {
        setTrendHours(h)
        try {
          const bucket = h <= 6 ? 36 : h <= 24 ? 48 : h <= 72 ? 72 : 84
          const next = await apiGet('trend?hours=' + h + '&bucket=' + bucket)
          setTrend(next)
        } catch (e) {
          setError('读走势失败：' + (e && e.message ? e.message : String(e)))
        }
      }, [])

      /** 按当前筛选条件重新拉事件 */
      const reloadEvents = React.useCallback(async (override) => {
        const f = override || eventFiltersRef.current
        const params = new URLSearchParams()
        params.set('limit', '100')

        if (f.rangeH === -1) {
          // 按日期：整天 [00:00, 次日 00:00)
          const day = f.date || (() => {
            const d = new Date()
            return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
          })()
          const [y, m, dd] = day.split('-').map(Number)
          const start = new Date(y, m - 1, dd, 0, 0, 0, 0).getTime()
          params.set('since', String(start))
          params.set('until', String(start + 86400000 - 1))
        } else if (f.rangeH > 0) {
          params.set('since', String(Date.now() - f.rangeH * 3600000))
        }

        if (f.mode) params.set('mode', f.mode)
        if (f.q.trim()) params.set('q', f.q.trim())
        try {
          const next = await apiGet('events?' + params.toString())
          setEvents(next)
        } catch { /* 忽略 */ }
      }, [])

      // 改「多久算过时」
      const setStaleDays = React.useCallback(async (days) => {
        try {
          await apiPost('prompts/stale-days', { days })
          const fresh = await apiGet('prompts').catch(() => null)
          if (fresh) setPrompts(fresh)
        } catch (e) {
          setError('保存天数失败：' + (e && e.message ? e.message : String(e)))
        }
      }, [])

      // 存一条文案
      const savePrompt = React.useCallback(async (mode, text) => {
        try {
          await apiPost('prompts', { mode, text })
          // 重新拉一次，让「已改」标记和生效文本同步
          const fresh = await apiGet('prompts').catch(() => null)
          if (fresh) setPrompts(fresh)
        } catch (e) {
          setError('保存文案失败：' + (e && e.message ? e.message : String(e)))
        }
      }, [])

      const config = data && data.config
      const tabs = [
        { id: 'mood', label: '情绪' },
        { id: 'growth', label: '成长' },
        { id: 'memory', label: '记忆' },
        { id: 'params', label: '参数' },
        { id: 'prompts', label: '文案' },
        { id: 'timeline', label: '对照' },
        { id: 'events', label: '流水' },
        { id: 'injections', label: '注入' },
        { id: 'trend', label: '走势' },
      ]

      return h('div', { style: S.page },
        h('div', { style: S.title }, '澄的心情'),
        h('div', { style: S.sub },
          '情绪来自她自己经历的事，不另建记忆。全部只读。'
          + (graph && graph.ok
              ? '（星图 ' + graph.nodes + ' 节点 · ' + timeAgo(Date.now() - ((graph.freshness && graph.freshness.ageMs) || 0)) + '更新）'
              : ''),
        ),

        error ? h('div', { style: S.err }, error) : null,

        h('div', { style: S.tabs },
          tabs.map((t) =>
            h('button', {
              key: t.id,
              style: { ...S.tab, ...(tab === t.id ? S.tabOn : {}) },
              onClick: () => setTab(t.id),
            }, t.label),
          ),
        ),

        tab === 'mood'
          ? h(MoodTab, { data, config, busy, patch, load, history, today })
          : tab === 'growth'
            ? h(GrowthTab, { growth })
            : tab === 'memory'
              ? h(MemoryTab, { memory })
              : tab === 'params'
                ? h(ParamsTab, { params, setParam, resetAll, busy })
                : tab === 'prompts'
                  ? h(PromptsTab, { prompts, savePrompt, setStaleDays })
                  : tab === 'timeline'
                    ? h(TimelineTab, { timeline })
                    : tab === 'events'
                      ? h(EventsTab, { events, filters: eventFilters, setFilters: setEventFilters, reload: reloadEvents })
                      : tab === 'injections'
                        ? h(InjectionsTab, { injections })
                        : h(TrendTab, { trend, hours: trendHours, setHours: loadTrend }),
      )
    }

    const inject = ['slots']

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('settings.section', () => slots.register(
        { name: 'settings.section', id: 'cheng-emotion', order: 57, label: '澄的心情' },
        EmotionPanel,
      ))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
