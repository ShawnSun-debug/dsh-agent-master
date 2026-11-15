/**
 * dsh-agent-master — 客户端「指挥台」面板。
 *
 * 本文件是**经典脚本**（不是 ESM）：DSH Web 壳以 <script> 载入，顶层只做一件事
 * —— 调用 window.__ModuleLoader__.load({ id, factory }) 注册工厂；模块体
 * （React 组件、座位注册）全部在 factory 内，首次 materialize 才执行。
 * 见 dsh-client-modules/src/client/manifest.ts:9-16。
 *
 * id 必须等于 package.json 的 name（= 'dsh-agent-master'），见同文件 manifest.ts:54。
 *
 * 座位两段式（api-notes §6 / §8.4）：
 *   1) sidebarRightTabs.register 声明一种 tab 类型，其 id 就是第二段的 key；
 *   2) slots.inject('sidebar.right.pane.tab') 里按同一个 key 挂正文；
 *      标题挂 'sidebar.right.pane.tab.title' 的同一 key。
 *
 * 数据只有一个来源：宿主侧 sessionProjections 投影 key = 'agentMaster'
 * （api-notes §8.1）。本文件不 fold 状态、不缓存、不自行推导领域数据。
 *
 * 渲染逻辑（viewModel / statusLabel / statusTone / kindLabel / countItems）
 * 是纯函数，并通过 module.exports 暴露，供 test/client.test.mjs 直接覆盖。
 */
window.__ModuleLoader__.load({
  id: 'dsh-agent-master',
  factory: function (require) {
    'use strict'

    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')

    /** 与 package.json name 一致，DSH 用它对账入口。 */
    var PACKAGE_ID = 'dsh-agent-master'
    /** Cordis 插件名（诊断用）。 */
    var PLUGIN_NAME = 'agent-master-client'
    /** 座位 id：stage1 的 id 与 stage2 的 key 必须是同一个字符串。 */
    var TAB_ID = 'agent-master:deck'
    /** tab 类型判别符。 */
    var TAB_KIND = 'agent-master.deck'
    /** 宿主投影 key（lead 定的契约，不得改动）。 */
    var PROJECTION_KEY = 'agentMaster'
    /** 面板文案的 locale 命名空间；没有字典时用中文兜底。 */
    var LOCALE_NS = 'agentMaster'
    /** 面板标题。 */
    var DECK_TITLE = '指挥台'
    /** 空态文案（票面逐字要求）。 */
    var EMPTY_TEXT = '还没有下派任何子对话 —— 在主对话里用 master_assign 开一路'
    /** 最近记录最多显示的条数。 */
    var RECENT_LIMIT = 12
    /** 官方子对话 tab 的地址前缀（dsh-client-ui-subagent/src/client/sidebar-chat/index.tsx:21）。 */
    var CHAT_ADDRESS_PREFIX = 'dsh-resource://subagentchat/session/'
    /** 官方允许的三种子会话模式（dsh-subagent/src/control-types.ts:62-71）。 */
    var CHAT_MODES = ['one-shot', 'continuable', 'unknown']
    /** 取不到模式时的官方默认：startActivation 创建的子会话恒为 continuable（dsh-subagent/src/manager.ts:344-346）。 */
    var DEFAULT_CHAT_MODE = 'continuable'

    // ---------------------------------------------------------------------
    // 纯函数：把投影状态转成渲染用的视图模型（无 React、无副作用）
    // ---------------------------------------------------------------------

    /** 顶部计数的字段与中文标签，数组顺序即 UI 顺序。 */
    var COUNT_FIELDS = [
      ['tasks', '任务'],
      ['findings', '发现'],
      ['sources', '来源'],
      ['artifacts', '产物'],
      ['violations', '违规'],
    ]

    /** 子对话状态 -> 徽标文案。 */
    var STATUS_LABELS = { assigned: '已下派', reported: '已回报', violated: '违规' }
    /** 子对话状态 -> 色调（muted 灰 / success 绿 / danger 红）。 */
    var STATUS_TONES = { assigned: 'muted', reported: 'success', violated: 'danger' }
    /** 黑板 kind -> 时间线标签。 */
    var KIND_LABELS = {
      task: '任务',
      finding: '发现',
      source: '来源',
      artifact: '产物',
      decision: '决策',
      open_question: '待确认',
    }

    /** 数值兜底：非有限数一律当 0，避免 NaN 渲染成 'NaN'。 */
    function num(value) {
      var parsed = typeof value === 'number' ? value : Number(value)
      return Number.isFinite(parsed) ? parsed : 0
    }

    /** 字符串兜底。 */
    function text(value) {
      return typeof value === 'string' ? value : ''
    }

    /** 数组兜底：投影来自 wire，任何字段都可能缺失。 */
    function list(value) {
      return Array.isArray(value) ? value : []
    }

    /** @returns {{ key: string, label: string, value: number }[]} 顶部计数条目（顺序固定）。 */
    function countItems(counts) {
      var source = counts && typeof counts === 'object' ? counts : {}
      return COUNT_FIELDS.map(function (field) {
        return { key: field[0], label: field[1], value: num(source[field[0]]) }
      })
    }

    /** 子对话状态 -> 中文徽标；未知状态原样透出，缺省为「未知」。 */
    function statusLabel(status) {
      if (typeof status === 'string' && status.length > 0) {
        return STATUS_LABELS[status] || status
      }
      return '未知'
    }

    /** 子对话状态 -> 色调；未知状态一律中性。 */
    function statusTone(status) {
      return STATUS_TONES[status] || 'muted'
    }

    /** 黑板 kind -> 中文标签；未知 kind 原样透出，缺省为「记录」。 */
    function kindLabel(kind) {
      if (typeof kind === 'string' && kind.length > 0) {
        return KIND_LABELS[kind] || kind
      }
      return '记录'
    }

    /**
     * 拼出官方子对话 tab 的地址，逐字符对齐 dsh-client-ui-subagent 的实现：
     * `前缀 + encodeURIComponent(childSessionId) + '?' + URLSearchParams({ parent, mode })`
     * （src/client/sidebar-chat/index.tsx:51-57）。
     *
     * @param {{ sessionId?: string, parent?: string, mode?: string } | null} input
     *   sessionId = 子会话 id（deck children[].sessionId），parent = 当前 master 会话 id，
     *   mode 取 'one-shot' | 'continuable' | 'unknown'，缺省/非法时按官方默认 continuable。
     * @returns {string | null} 缺子会话号或父会话号时返回 null（渲染层据此不挂点击）
     */
    function chatAddress(input) {
      var source = input && typeof input === 'object' ? input : {}
      var sessionId = text(source.sessionId)
      var parent = text(source.parent)
      if (sessionId === '' || parent === '') return null
      var mode = CHAT_MODES.indexOf(source.mode) >= 0 ? source.mode : DEFAULT_CHAT_MODE
      var query = new URLSearchParams({ parent: parent, mode: mode })
      return CHAT_ADDRESS_PREFIX + encodeURIComponent(sessionId) + '?' + query
    }

    /** 计数归一化：五组数字都不缺、不为 NaN。 */
    function normalizeCounts(source) {
      var value = source && typeof source === 'object' ? source : {}
      return {
        tasks: num(value.tasks),
        findings: num(value.findings),
        sources: num(value.sources),
        artifacts: num(value.artifacts),
        violations: num(value.violations),
      }
    }

    /** 一条子对话 -> 卡片视角（带徽标文案与色调）。 */
    function toCard(child) {
      var source = child && typeof child === 'object' ? child : {}
      var status = text(source.status)
      return {
        name: text(source.name),
        label: text(source.label),
        taskId: text(source.taskId),
        // 点击卡片要用它打开子会话 tab（旧数据没有该字段时归一成空串）。
        sessionId: text(source.sessionId),
        status: status,
        statusText: statusLabel(status),
        tone: statusTone(status),
        findings: num(source.findings),
        evidence: num(source.evidence),
        artifacts: num(source.artifacts),
        violations: num(source.violations),
      }
    }

    /** 一条黑板记录 -> 时间线视角。 */
    function toRecent(item) {
      var source = item && typeof item === 'object' ? item : {}
      var kind = text(source.kind)
      return { seq: num(source.seq), kind: kind, kindLabel: kindLabel(kind), title: text(source.title) }
    }

    /** recent 按 seq 降序（新的在前）；seq 相同则保持入参顺序。 */
    function sortRecentDesc(items) {
      return items
        .map(function (item, index) {
          return { item: toRecent(item), index: index }
        })
        .sort(function (left, right) {
          return right.item.seq - left.item.seq || left.index - right.index
        })
        .map(function (entry) {
          return entry.item
        })
    }

    /** 违规数 > 0 时给出顶部提示，否则 null。 */
    function buildAlert(counts) {
      if (counts.violations <= 0) return null
      return {
        level: 'danger',
        text: '有 ' + counts.violations + ' 处违规：子对话回报与约束台账不符，请先核对再继续。',
      }
    }

    /**
     * 投影状态 -> 视图模型。
     * state 为 null（宿主尚无任何记录）时返回空态，其余字段照样有值，渲染层不需要判空。
     * @param {unknown} state 投影 key = 'agentMaster' 的值
     */
    function viewModel(state) {
      if (state === null || state === undefined) {
        var emptyCounts = normalizeCounts(null)
        return {
          empty: true,
          emptyText: EMPTY_TEXT,
          headSeq: 0,
          updatedAt: 0,
          counts: emptyCounts,
          countItems: countItems(emptyCounts),
          children: [],
          recent: [],
          alert: null,
        }
      }
      var source = state && typeof state === 'object' ? state : {}
      var counts = normalizeCounts(source.counts)
      return {
        empty: false,
        emptyText: EMPTY_TEXT,
        headSeq: num(source.headSeq),
        updatedAt: num(source.updatedAt),
        counts: counts,
        countItems: countItems(counts),
        children: list(source.children).map(toCard),
        // 时间线只留最新 RECENT_LIMIT 条（新的在前）。
        recent: sortRecentDesc(list(source.recent)).slice(0, RECENT_LIMIT),
        alert: buildAlert(counts),
      }
    }

    // ---------------------------------------------------------------------
    // 渲染层：只用 react 的 createElement，不引第三方组件库
    // ---------------------------------------------------------------------

    /** 徽标、提示条用到的三种色调。 */
    var TONE_COLORS = { muted: '#6b7280', success: '#15803d', danger: '#b91c1c' }

    /** 面板样式：内联对象，跟随主题变量并带浅色兜底。 */
    var STYLES = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        height: '100%',
        padding: '12px',
        overflowY: 'auto',
        fontSize: '12px',
        lineHeight: '1.6',
        color: 'var(--dsh-text-primary, #111827)',
      },
      header: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' },
      title: { fontSize: '13px', fontWeight: 600 },
      seq: { color: 'var(--dsh-text-secondary, #6b7280)', fontSize: '11px' },
      counts: { display: 'flex', gap: '10px', flexWrap: 'wrap' },
      count: { color: 'var(--dsh-text-secondary, #6b7280)' },
      countDanger: { color: TONE_COLORS.danger, fontWeight: 600 },
      alert: {
        padding: '8px 10px',
        borderRadius: '6px',
        background: 'rgba(220, 38, 38, 0.10)',
        border: '1px solid ' + TONE_COLORS.danger,
        color: TONE_COLORS.danger,
      },
      cards: { display: 'flex', flexDirection: 'column', gap: '8px' },
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
        padding: '8px 10px',
        borderRadius: '6px',
        border: '1px solid var(--dsh-border, #e5e7eb)',
      },
      cardClickable: { cursor: 'pointer' },
      cardTop: { display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'space-between' },
      cardName: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontWeight: 600 },
      cardLabel: { color: 'var(--dsh-text-secondary, #6b7280)' },
      badge: {
        padding: '0 6px',
        borderRadius: '999px',
        border: '1px solid currentColor',
        fontSize: '11px',
        whiteSpace: 'nowrap',
      },
      sectionTitle: { fontSize: '11px', fontWeight: 600, letterSpacing: '0.08em', opacity: 0.75 },
      timeline: { display: 'flex', flexDirection: 'column', gap: '4px' },
      timelineRow: { display: 'flex', gap: '8px', alignItems: 'baseline' },
      kind: { color: 'var(--dsh-text-secondary, #6b7280)', whiteSpace: 'nowrap' },
      timelineTitle: { overflow: 'hidden', textOverflow: 'ellipsis' },
      muted: { color: 'var(--dsh-text-secondary, #6b7280)' },
      empty: {
        padding: '10px',
        borderRadius: '6px',
        border: '1px dashed var(--dsh-border, #d1d5db)',
        color: 'var(--dsh-text-secondary, #6b7280)',
      },
    }

    /** createElement 的薄包装：子节点走可变参数，读起来比嵌套数组清楚。 */
    function h(type, props) {
      var children = Array.prototype.slice.call(arguments, 2)
      return React.createElement.apply(React, [type, props].concat(children))
    }

    /** 时间戳 -> 本地时间文本；非法值返回空串（不抛错）。 */
    function formatTime(timestamp) {
      try {
        return new Date(timestamp).toLocaleString()
      } catch (error) {
        return ''
      }
    }

    /** 顶部：标题 + 黑板 seq + 更新时间。 */
    function DeckHeader(props) {
      var model = props.model
      return h(
        'div',
        { style: STYLES.header },
        h('span', { style: STYLES.title }, DECK_TITLE),
        h('span', { style: STYLES.seq }, model.headSeq > 0 ? '黑板 #' + model.headSeq : '黑板尚无记录'),
        model.updatedAt > 0 ? h('span', { style: STYLES.seq }, '更新于 ' + formatTime(model.updatedAt)) : null,
      )
    }

    /** 顶部：五项计数。 */
    function CountsRow(props) {
      return h(
        'div',
        { style: STYLES.counts },
        props.items.map(function (item) {
          var style = item.key === 'violations' && item.value > 0 ? STYLES.countDanger : STYLES.count
          return h('span', { key: item.key, style: style }, item.label + ' ' + item.value)
        }),
      )
    }

    /** 顶部：违规提示条。 */
    function AlertRow(props) {
      return h('div', { style: STYLES.alert }, props.alert.text)
    }

    /** 小标题。 */
    function SectionTitle(props) {
      return h('div', { style: STYLES.sectionTitle }, props.text)
    }

    /** 一张子对话卡片；有子会话号且拿到 opener 时可按官方寻址打开右侧栏 chat tab。 */
    function ChildCard(props) {
      var card = props.card
      var badgeStyle = {
        padding: STYLES.badge.padding,
        borderRadius: STYLES.badge.borderRadius,
        border: STYLES.badge.border,
        fontSize: STYLES.badge.fontSize,
        whiteSpace: STYLES.badge.whiteSpace,
        color: TONE_COLORS[card.tone] || TONE_COLORS.muted,
      }
      var stats = '发现 ' + card.findings + ' · 证据 ' + card.evidence + ' · 产物 ' + card.artifacts
      if (card.violations > 0) stats += ' · 违规 ' + card.violations

      var open = props.onOpen
      var clickable = card.sessionId !== '' && typeof open === 'function'
      var openCard = function () {
        return clickable ? open(card) : false
      }
      var cardProps = clickable
        ? {
            style: Object.assign({}, STYLES.card, STYLES.cardClickable),
            role: 'button',
            tabIndex: 0,
            title: '打开子对话（右侧栏）',
            onClick: openCard,
            onKeyDown: function (event) {
              if (event.key !== 'Enter' && event.key !== ' ') return
              if (typeof event.preventDefault === 'function') event.preventDefault()
              openCard()
            },
          }
        : { style: STYLES.card, title: '这条记录没有子会话号，无法打开子对话' }
      return h(
        'div',
        cardProps,
        h(
          'div',
          { style: STYLES.cardTop },
          h('span', { style: STYLES.cardName }, card.name || '（未命名）'),
          h('span', { style: badgeStyle }, card.statusText),
        ),
        card.label ? h('div', { style: STYLES.cardLabel }, card.label) : null,
        card.taskId ? h('div', { style: STYLES.muted }, '任务 ' + card.taskId) : null,
        h('div', { style: STYLES.muted }, stats),
      )
    }

    /** 时间线一行。 */
    function TimelineRow(props) {
      var item = props.item
      return h(
        'div',
        { style: STYLES.timelineRow },
        h('span', { style: STYLES.seq }, '#' + item.seq),
        h('span', { style: STYLES.kind }, item.kindLabel),
        h('span', { style: STYLES.timelineTitle }, item.title || '（无标题）'),
      )
    }

    /** 读投影：座位在 session 作用域注入 useProjection；异常情况退化成空态而不是白屏。 */
    function readProjection(props) {
      var read = props && props.useProjection
      if (typeof read !== 'function') return null
      var value = read(PROJECTION_KEY)
      return value === undefined ? null : value
    }

    /**
     * 指挥台正文。
     * props 来自 session 作用域 seat：sessionId 与 useProjection；openChild 由本插件在
     * stage2 的 inject 里注入（点击卡片时用它按官方寻址打开子会话 tab）。
     */
    function DeckPanel(props) {
      // hooks 规则：useProjection 必须无条件调用，所以放在所有分支之前。
      var state = readProjection(props)
      var model = viewModel(state)

      if (model.empty) {
        return h(
          'div',
          { style: STYLES.root, 'data-agent-master': 'deck' },
          h(DeckHeader, { model: model }),
          h('div', { style: STYLES.empty }, model.emptyText),
        )
      }

      return h(
        'div',
        { style: STYLES.root, 'data-agent-master': 'deck' },
        h(DeckHeader, { model: model }),
        model.alert ? h(AlertRow, { alert: model.alert }) : null,
        h(CountsRow, { items: model.countItems }),
        h(SectionTitle, { text: '子对话' }),
        model.children.length > 0
          ? h(
              'div',
              { style: STYLES.cards },
              model.children.map(function (card, index) {
                return h(ChildCard, {
                  key: card.taskId || card.name || String(index),
                  card: card,
                  // 父会话号就是面板自己的 sessionId（seat 注入），在这里绑好再交给卡片。
                  onOpen:
                    typeof props.openChild === 'function'
                      ? function (target) {
                          return props.openChild(target, props.sessionId)
                        }
                      : undefined,
                })
              }),
            )
          : h('div', { style: STYLES.muted }, '还没有记录到子对话 —— 已下派的子对话会出现在这里'),
        h(SectionTitle, { text: '最近记录' }),
        model.recent.length > 0
          ? h(
              'div',
              { style: STYLES.timeline },
              model.recent.map(function (item) {
                return h(TimelineRow, { key: String(item.seq), item: item })
              }),
            )
          : h('div', { style: STYLES.muted }, '暂无黑板记录'),
      )
    }

    /** tab 标题（sidebar.right.pane.tab.title 座位）。 */
    function DeckTabTitle() {
      return h('span', { style: STYLES.title }, DECK_TITLE)
    }

    /** 降级提示（sidebarRightTabs 不可用时挂到 shell.overlay，见 issues/06 验收第 2 条）。 */
    function DeckUnavailable() {
      return h(
        'div',
        { style: STYLES.root, 'data-agent-master': 'deck-unavailable' },
        h('div', { style: STYLES.alert }, '右侧栏不可用：指挥台已降级为提示卡片。'),
        h(
          'div',
          { style: STYLES.muted },
          '当前 DSH 版本没有 sidebarRightTabs 座位。可以用 master_board 查看黑板、用 master_collect 查看子对话结果。',
        ),
      )
    }

    // ---------------------------------------------------------------------
    // 座位注册
    // ---------------------------------------------------------------------

    /** 打一条 warn，绝不因为日志失败影响注册。 */
    function warn(message, error) {
      try {
        if (typeof console !== 'undefined' && typeof console.warn === 'function') console.warn(message, error || '')
      } catch (ignored) {
        // 日志失败忽略
      }
    }

    /** 有 ctx.effect 就用它（卸载自动回卷），没有就直接执行。 */
    function effect(ctx, fn, label) {
      if (typeof ctx.effect === 'function') return ctx.effect(fn, label)
      return fn()
    }

    /** 把面板文案翻成当前语言；没有字典/取不到值时用中文兜底。 */
    function makeTranslator(ctx) {
      var bound = null
      try {
        if (ctx.locale && typeof ctx.locale.bind === 'function') bound = ctx.locale.bind(LOCALE_NS)
      } catch (error) {
        bound = null
      }
      if (typeof bound !== 'function') {
        return function (_key, fallback) {
          return fallback
        }
      }
      return function (key, fallback) {
        try {
          var value = bound(key)
          return typeof value === 'string' && value.length > 0 && value !== key ? value : fallback
        } catch (error) {
          return fallback
        }
      }
    }

    /**
     * 取右侧栏服务。官方服务键是 'sidebarRight'
     * （dsh-client-ui-sidebar-right/src/client/index.ts:183 `ctx.reflect.provide('sidebarRight', controller)`）。
     * 本插件没把 sidebarRight 写进 inject（否则服务缺失时会一直等待、降级路径也走不到），
     * 所以在调用点按官方惯例用 ctx.get 取可选服务（客户端同类用法见
     * dsh-client-ui-chat/src/client/apply.ts:284）。
     *
     * @returns {{ openResource: Function } | null} 服务缺失时 null，调用方降级
     */
    function resolveSidebarRight(ctx) {
      try {
        if (ctx.sidebarRight && typeof ctx.sidebarRight.openResource === 'function') return ctx.sidebarRight
      } catch (error) {
        // 服务不可读：落到 ctx.get
      }
      try {
        if (typeof ctx.get === 'function') {
          var service = ctx.get('sidebarRight')
          if (service && typeof service.openResource === 'function') return service
        }
      } catch (error) {
        // 服务缺失：调用方降级
      }
      return null
    }

    /**
     * 取子会话的真实模式：父会话的 subagentCatalog 投影里有 id 与 mode
     * （dsh-client-ui-subagent/src/client/index.ts:67-70 的读法：
     * ctx.sessions.list.getSnapshot().projectionsBySession[父].values.subagentCatalog）。
     * 读不到就按官方默认 continuable（我们下派的子会话都走 startActivation）。
     *
     * @returns {'one-shot' | 'continuable' | 'unknown'}
     */
    function resolveChildMode(ctx, parentSessionId, childSessionId) {
      try {
        var sessions = ctx.sessions || (typeof ctx.get === 'function' ? ctx.get('sessions') : null)
        var snapshot =
          sessions && sessions.list && typeof sessions.list.getSnapshot === 'function'
            ? sessions.list.getSnapshot()
            : null
        var parent = snapshot && snapshot.projectionsBySession ? snapshot.projectionsBySession[parentSessionId] : null
        var catalog = parent && parent.values && Array.isArray(parent.values.subagentCatalog) ? parent.values.subagentCatalog : []
        for (var index = 0; index < catalog.length; index += 1) {
          var entry = catalog[index]
          if (entry && entry.id === childSessionId && CHAT_MODES.indexOf(entry.mode) >= 0) return entry.mode
        }
      } catch (error) {
        // 目录读不到就按官方默认
      }
      return DEFAULT_CHAT_MODE
    }

    /**
     * 造「点卡片打开子对话」的闭包：按官方寻址调用
     * `ctx.sidebarRight.openResource(address, { kind: 'subagentchat', preferNewPane: true })`
     * （dsh-client-ui-subagent/src/client/index.ts:59-64 + 服务签名 service.ts:179-195/243）。
     *
     * @returns {(card: { sessionId?: string }, parentSessionId?: string) => boolean}
     */
    function makeChildOpener(ctx) {
      return function openChild(card, parentSessionId) {
        var childSessionId = text(card && card.sessionId)
        var parent = text(parentSessionId)
        var address = chatAddress({ sessionId: childSessionId, parent: parent, mode: resolveChildMode(ctx, parent, childSessionId) })
        if (address === null) {
          warn('agent-master 客户端：缺少子会话号或父会话号，无法打开子对话。')
          return false
        }
        var service = resolveSidebarRight(ctx)
        if (service === null) {
          warn('agent-master 客户端：右侧栏服务（sidebarRight）不可用，无法打开子对话。')
          return false
        }
        try {
          service.openResource(address, { kind: 'subagentchat', preferNewPane: true })
          return true
        } catch (error) {
          // openResource 对「没有类型认领该地址」等接线错误是抛错的（service.ts:233-236），不能打断渲染。
          warn('agent-master 客户端：打开子对话失败。', error)
          return false
        }
      }
    }

    /** 正常路径：stage1 声明 tab 类型，stage2 按同一个 id 挂正文与标题。 */
    function installSidebarSeats(ctx, translate, openChild) {
      // openChild 在 apply 里只造一次，注入的 props 也保持同一引用，避免每次渲染都换新对象。
      var injectedProps = { openChild: openChild }
      effect(ctx, function () {
        return ctx.sidebarRightTabs.register({
          id: TAB_ID,
          kind: TAB_KIND,
          keepMounted: true,
          title: function () {
            return translate('deck.title', DECK_TITLE)
          },
        })
      }, 'agent-master: 指挥台 tab 类型')

      effect(ctx, function () {
        return ctx.slots.inject('sidebar.right.pane.tab', function () {
          return ctx.slots.register(
            {
              name: 'sidebar.right.pane.tab',
              key: TAB_ID,
              // 宿主渲染时把 entry.inject 的返回值并进组件 props（scoped-slots.tsx:672），
              // 面板因此拿到打开子对话的闭包，不必自己去摸 ctx。
              inject: function () {
                return injectedProps
              },
            },
            DeckPanel,
          )
        })
      }, 'agent-master: 指挥台面板')

      effect(ctx, function () {
        return ctx.slots.inject('sidebar.right.pane.tab.title', function () {
          return ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID }, DeckTabTitle)
        })
      }, 'agent-master: 指挥台标签标题')
    }

    /** 降级路径：右栏不可用时挂到 shell.overlay（root 作用域，没有 useProjection）。 */
    function installOverlayFallback(ctx) {
      effect(ctx, function () {
        return ctx.slots.register({ name: 'shell.overlay', id: 'agent-master:deck-unavailable' }, DeckUnavailable)
      }, 'agent-master: 指挥台降级提示')
    }

    /** Cordis 插件入口。 */
    function apply(ctx) {
      if (!ctx || !ctx.slots || typeof ctx.slots.register !== 'function') {
        throw new Error('agent-master 客户端：缺少 slots 服务，无法挂载指挥台')
      }
      var translate = makeTranslator(ctx)
      var openChild = makeChildOpener(ctx)
      if (ctx.sidebarRightTabs && typeof ctx.sidebarRightTabs.register === 'function') {
        try {
          installSidebarSeats(ctx, translate, openChild)
          return
        } catch (error) {
          warn('agent-master 客户端：右侧栏座位注册失败，退回 shell.overlay。', error)
        }
      } else {
        warn('agent-master 客户端：缺少 sidebarRightTabs 服务，退回 shell.overlay。')
      }
      installOverlayFallback(ctx)
    }

    exports.name = PLUGIN_NAME
    exports.inject = ['slots', 'sidebarRightTabs', 'locale', 'sessions']
    exports.apply = apply
    // 纯函数导出：test/client.test.mjs 通过经典脚本路径读到同一份实现。
    exports.viewModel = viewModel
    exports.statusLabel = statusLabel
    exports.statusTone = statusTone
    exports.kindLabel = kindLabel
    exports.countItems = countItems
    exports.chatAddress = chatAddress
    exports.constants = Object.freeze({
      PACKAGE_ID: PACKAGE_ID,
      TAB_ID: TAB_ID,
      TAB_KIND: TAB_KIND,
      PROJECTION_KEY: PROJECTION_KEY,
      EMPTY_TEXT: EMPTY_TEXT,
      RECENT_LIMIT: RECENT_LIMIT,
      DECK_TITLE: DECK_TITLE,
      CHAT_ADDRESS_PREFIX: CHAT_ADDRESS_PREFIX,
      DEFAULT_CHAT_MODE: DEFAULT_CHAT_MODE,
    })
    return module.exports
  },
})
