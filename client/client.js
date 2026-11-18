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
 * 数据来源：宿主把 deck 快照写到会话工作区的 `.agent-master/<rootId>/deck.json`，
 * 客户端用官方 workspaceFiles Remote（read + changes）按会话读取/监听；
 * 老会话没有快照文件时回退到会话投影 key = 'agentMaster'（历史 deck 事件仍在日志里）。
 * 本文件不 fold 状态、不缓存、不自行推导领域数据。
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
    /** 宿主投影 key；旧会话的 deck 事件仍折在这里，作为快照缺失时的回退。 */
    var PROJECTION_KEY = 'agentMaster'
    /** 指挥台快照的工作区相对目录（宿主 DECK_DIR_NAME 同一约定）。 */
    var DECK_DIR_NAME = '.agent-master'
    /** 每个 root 会话一份快照。 */
    var DECK_FILE_NAME = 'deck.json'
    /** changes 流不可用、或文件还没出现时的兜底轮询间隔（毫秒）。 */
    var DECK_POLL_MS = 2000
    /** 面板文案的 locale 命名空间；没有字典时用中文兜底。 */
    var LOCALE_NS = 'agentMaster'
    /** 面板标题。 */
    var DECK_TITLE = '指挥台'
    /** 空态文案（票面逐字要求）。 */
    var EMPTY_TEXT = '还没有下派任何子对话 —— 在主对话里用 master_dispatch / master_assign 开一路'
    // 从左栏入口打开的是 root 作用域页签，拿不到会话号：这时候说「没有记录」等于没说，
    // 得告诉用户下一步点哪儿（真机反馈：打开一片空白，不知道这面板是干什么的）。
    var UNBOUND_TEXT = '这个页签还没绑定会话 —— 在会话里点输入框左侧的「指挥台 N/M」看那个会话的看板'
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

    /** deck 契约版本：只认 2（ADR-0004，不保留 v1 适配层）。 */
    var DECK_VERSION = 2

    /** 顶部计数的字段与中文标签，数组顺序即 UI 顺序。 */
    var COUNT_FIELDS = [
      ['cards', '卡片'],
      ['doing', '在做'],
      ['review', '待验收'],
      ['violations', '违规'],
      ['records', '记录'],
    ]

    /** 每个计数的含义：光看「卡片 3」没人知道含不含已结案，悬停补一句。 */
    var COUNT_HINTS = {
      cards: '卡片总数（含已结案的）',
      doing: '正在跑的卡（未结案，含阻塞待处理）',
      review: '子对话已回报、等你验收的卡',
      violations: '回报与约束台账不符的条数',
      records: '证据流条数（发现/来源/产物/待答问题）',
    }

    /** 六种卡片状态 -> 徽标文案（顺序即看板列顺序：todo/assigned/doing/review/done/blocked）。 */
    var STATUS_LABELS = {
      todo: '待认领',
      assigned: '已认领',
      doing: '开工中',
      review: '待验收',
      done: '已完成',
      blocked: '阻塞',
    }
    /** 六种状态 -> 色调：六种必须肉眼可分（票面验收第 1 条）。 */
    var STATUS_TONES = {
      todo: 'muted',
      assigned: 'info',
      doing: 'progress',
      review: 'warn',
      done: 'success',
      blocked: 'danger',
    }
    /** 证据流 kind -> 时间线标签。 */
    var KIND_LABELS = {
      finding: '发现',
      source: '来源',
      artifact: '产物',
      decision: '决策',
      open_question: '待确认',
      card_status: '状态变更',
      migrated: '迁移',
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
        return { key: field[0], label: field[1], value: num(source[field[0]]), hint: COUNT_HINTS[field[0]] || '' }
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

    /** 计数归一化：v2 的计数都补齐、不为 NaN（缺字段一律 0）。 */
    function normalizeCounts(source) {
      var value = source && typeof source === 'object' ? source : {}
      return {
        cards: num(value.cards),
        records: num(value.records),
        violations: num(value.violations),
        todo: num(value.todo),
        assigned: num(value.assigned),
        doing: num(value.doing),
        review: num(value.review),
        done: num(value.done),
        blocked: num(value.blocked),
      }
    }

    /** 一张看板卡 -> 卡片视角（状态/认领者/P 级/rev 都直接来自快照，不自己推导）。 */
    function toCard(card) {
      var source = card && typeof card === 'object' ? card : {}
      var status = text(source.status)
      var assignee = source.assignee && typeof source.assignee === 'object' ? source.assignee : null
      var counts = source.counts && typeof source.counts === 'object' ? source.counts : {}
      var assigneeName = ''
      if (assignee !== null) {
        assigneeName = text(assignee.name) || text(assignee.sessionId)
      }
      return {
        id: text(source.id),
        label: text(source.label),
        // 点击卡片要用它打开子会话 tab（没有子会话号时归一成空串）。
        sessionId: text(source.sessionId),
        status: status,
        statusText: statusLabel(status),
        tone: statusTone(status),
        priority: text(source.priority),
        rev: num(source.rev),
        assigneeName: assigneeName,
        findings: num(counts.findings),
        sources: num(counts.sources),
        artifacts: num(counts.artifacts),
        violations: num(counts.violations),
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
    /** 左栏底部入口 id（root 作用域）。 */
    var FOOTER_ACTION_ID = 'agent-master:deck-entry'

    /** 会话头计数 id（session 作用域）。 */
    var HEADER_UTILITY_ID = 'agent-master:deck-count'

    /**
     * 从投影折出「一眼可见」的徽标。
     * root 作用域（左栏）拿不到投影，所以数字只放在 session 作用域的会话头。
     *
     * @returns {{ text: string, total: number, running: number, violated: boolean, tone: string }}
     */
    /**
     * 胶囊的 tooltip：把 2/3 说清楚（光看数字猜不出是「未结案/总数」）。
     * @param {{ total: number, running: number, violated: boolean }} badge
     */
    function deckBadgeTitle(badge) {
      if (!badge || !badge.total) return DECK_TITLE
      var base = DECK_TITLE + '：' + badge.running + ' 张未结案 / 共 ' + badge.total + ' 张'
      return badge.violated ? base + '（有违规待处理）' : base
    }

    function deckBadge(state) {
      var model = viewModel(state)
      if (model.empty) {
        return { text: DECK_TITLE, total: 0, running: 0, violated: false, tone: 'muted' }
      }
      var running = 0
      var violated = false
      for (var index = 0; index < model.cards.length; index += 1) {
        var card = model.cards[index]
        // 「在动」= 还没结案：done 之外都算（blocked 也要人管）
        if (card.status === 'done') continue
        if (card.status === 'blocked') violated = true
        running += 1
      }
      if (model.counts.violations > 0) violated = true
      var total = model.cards.length
      var shown = running > 0 ? running : total
      return {
        text: total === 0 ? DECK_TITLE : DECK_TITLE + ' ' + shown + '/' + total,
        total: total,
        running: running,
        violated: violated,
        tone: violated ? 'danger' : running > 0 ? 'muted' : 'success',
      }
    }

    /**
     * 打开右栏指挥台 tab：官方服务是 sidebarRight，方法 openTab(kind, options)
     * （dsh-client-ui-sidebar-right/src/client/index.ts 的 controller.openTab）。
     *
     * @returns {boolean} 服务缺失或抛错时 false，调用方无需处理
     */
    function openDeckTab(ctx) {
      var service = resolveSidebarRight(ctx)
      if (service === null || typeof service.openTab !== 'function') {
        warn('agent-master 客户端：sidebarRight.openTab 不可用，无法打开指挥台。')
        return false
      }
      try {
        service.openTab(TAB_KIND, {})
        return true
      } catch (error) {
        warn('agent-master 客户端：打开指挥台标签失败。', error)
        return false
      }
    }

    /**
     * 契约不匹配时的占位文案：旧快照（v1）或没有 version 的历史数据都会走到这里。
     * 数据还在盘上，只是这份客户端不再假装能读懂它 —— 显示占位而不是抛错（票面验收第 3 条）。
     */
    var INCOMPATIBLE_TEXT =
      '这份指挥台快照是旧契约（v1）留下的：卡片状态、认领者、P 级都读不出来。' +
      '数据没有丢，重新派发一次任务就会写出 v2 快照。'

    function viewModel(state) {
      if (state === null || state === undefined) {
        var emptyCounts = normalizeCounts(null)
        return {
          empty: true,
          incompatible: false,
          placeholderText: '',
          emptyText: EMPTY_TEXT,
          revision: 0,
          updatedAt: 0,
          counts: emptyCounts,
          countItems: countItems(emptyCounts),
          cards: [],
          recent: [],
          alert: null,
        }
      }
      var source = state && typeof state === 'object' ? state : {}

      // 契约版本不匹配：不猜字段、不抛错，只给占位
      if (num(source.version) !== DECK_VERSION) {
        return {
          empty: false,
          incompatible: true,
          placeholderText: INCOMPATIBLE_TEXT,
          emptyText: EMPTY_TEXT,
          revision: 0,
          updatedAt: num(source.updatedAt),
          counts: normalizeCounts(null),
          countItems: countItems(normalizeCounts(null)),
          cards: [],
          recent: [],
          alert: null,
        }
      }

      var counts = normalizeCounts(source.counts)
      return {
        empty: false,
        incompatible: false,
        placeholderText: '',
        emptyText: EMPTY_TEXT,
        revision: num(source.revision),
        updatedAt: num(source.updatedAt),
        counts: counts,
        countItems: countItems(counts),
        cards: list(source.cards).map(toCard),
        // 时间线只留最新 RECENT_LIMIT 条（新的在前）。
        recent: sortRecentDesc(list(source.recent)).slice(0, RECENT_LIMIT),
        alert: buildAlert(counts),
      }
    }

    // ---------------------------------------------------------------------
    // 渲染层：只用 react 的 createElement，不引第三方组件库
    // ---------------------------------------------------------------------

    /** 徽标、提示条用到的色调（六种状态复用这六种颜色，保证肉眼可分）。 */
    var TONE_COLORS = {
      muted: '#6b7280',
      info: '#2563eb',
      progress: '#7c3aed',
      warn: '#b45309',
      success: '#15803d',
      danger: '#b91c1c',
    }

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
      footerButton: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: '4px 8px',
        borderRadius: '6px',
        border: '1px solid var(--dsh-border, #e5e7eb)',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        fontSize: '12px',
      },
      pill: {
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px 8px',
        borderRadius: '999px',
        border: '1px solid var(--dsh-border, #e5e7eb)',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        fontSize: '11px',
        whiteSpace: 'nowrap',
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

    /**
     * 时间戳 -> `YYYY-MM-DD HH:mm`（本地时区，补零）；非法值返回空串（不抛错）。
     *
     * 不用 toLocaleString：它跟着宿主 locale 变（真机截到 "19/11/2026 上午12:45:08"），
     * 同一份快照在不同机器上显示不同、也没法一眼比先后。
     */
    function formatTime(timestamp) {
      try {
        var value = Number(timestamp)
        if (!Number.isFinite(value) || value <= 0) return ''
        var date = new Date(value)
        if (Number.isNaN(date.getTime())) return ''
        var pad = function (n) {
          return n < 10 ? '0' + n : String(n)
        }
        return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
          + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
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
        h('span', { style: STYLES.seq }, model.revision > 0 ? '看板 rev ' + model.revision : '看板尚无记录'),
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
          return h('span', { key: item.key, style: style, title: item.hint || null }, item.label + ' ' + item.value)
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

    /**
     * 一张看板卡。状态徽标 + 认领者 + P 级一眼可见；有子会话号且拿到 opener 时，
     * 点击按官方寻址打开右侧栏 chat tab（沿用既有能力）。
     */
    function CardRow(props) {
      var card = props.card
      var tone = TONE_COLORS[card.tone] || TONE_COLORS.muted
      var badgeStyle = {
        padding: STYLES.badge.padding,
        borderRadius: STYLES.badge.borderRadius,
        border: STYLES.badge.border,
        fontSize: STYLES.badge.fontSize,
        whiteSpace: STYLES.badge.whiteSpace,
        color: tone,
        // 左侧色条也用同一色调，六种状态在列里更快分辨
        borderLeftWidth: '3px',
        borderLeftStyle: 'solid',
        borderLeftColor: tone,
      }
      var meta = []
      if (card.priority !== '') meta.push('优先级 ' + card.priority)
      meta.push(card.assigneeName === '' ? '未认领' : '认领者 ' + card.assigneeName)
      meta.push('rev ' + card.rev)

      var stats = '发现 ' + card.findings + ' · 证据 ' + card.sources + ' · 产物 ' + card.artifacts
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
            'data-status': card.status,
            'data-card-id': card.id,
            title: '打开子对话（右侧栏）',
            onClick: openCard,
            onKeyDown: function (event) {
              if (event.key !== 'Enter' && event.key !== ' ') return
              if (typeof event.preventDefault === 'function') event.preventDefault()
              openCard()
            },
          }
        : {
            style: STYLES.card,
            'data-status': card.status,
            'data-card-id': card.id,
            title: card.sessionId === '' ? '这张卡还没有子会话号，无法打开子对话' : '打开子对话（右侧栏）',
          }
      return h(
        'div',
        cardProps,
        h(
          'div',
          { style: STYLES.cardTop },
          h('span', { style: STYLES.cardName }, (card.id ? card.id + ' · ' : '') + (card.label || '（无标题）')),
          // data-tone 给测试与排障用：六种状态必须落在六种色调上（人工勾选已机器化）
          h('span', { style: badgeStyle, 'data-tone': card.tone }, card.statusText),
        ),
        h('div', { style: STYLES.muted }, meta.join(' · ')),
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

    /** 会话 id 与宿主 sanitizeRootId 同规则净化，避免两半拼出不同路径。 */
    function sanitizeSessionId(sessionId) {
      return String(sessionId === null || sessionId === undefined ? '' : sessionId).replace(/[^A-Za-z0-9_-]/g, '-')
    }

    /** 宿主 publishDeck 写出的工作区相对路径（workspaceFiles 按会话工作区根解析）。 */
    function deckRelativePath(sessionId) {
      return DECK_DIR_NAME + '/' + sanitizeSessionId(sessionId) + '/' + DECK_FILE_NAME
    }

    /** 解析快照 JSON：接受 deck 本体或 { deck } 两种形状；坏数据返回 null。 */
    function parseDeckText(raw) {
      if (typeof raw !== 'string' || raw === '') return null
      try {
        var parsed = JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object') return null
        if (parsed.deck !== null && typeof parsed.deck === 'object') return parsed.deck
        return parsed
      } catch (error) {
        return null
      }
    }

    /** 懒取客户端 remote 服务：缺了也不阻塞装配（老宿主没有这个 Remote 时回退投影）。 */
    function resolveRemote(ctx) {
      try {
        if (ctx && typeof ctx.get === 'function') return ctx.get('remote') || null
        return ctx && ctx.remote ? ctx.remote : null
      } catch (error) {
        return null
      }
    }

    /**
     * 取 `remote.workspaceFiles` 命名空间；取不到返回 null。
     *
     * 真机踩过（指挥台一开就是空白）：宿主 ctx 是**服务代理**，没在 inject 里
     * 声明的服务一碰就抛 `cannot get property "remote.workspaceFiles" without inject`。
     * 这个抛错发生在 effect 里会直接把面板打成空白，所以这里一律收敛成 null 走回退。
     */
    function workspaceFilesOf(remote) {
      if (!remote) return null
      try {
        var files = remote.workspaceFiles
        return files && typeof files === 'object' ? files : null
      } catch (error) {
        return null
      }
    }

    /**
     * 读一次快照：官方 workspaceFiles.read（路径相对会话工作区根）。
     * 读不到（还没有文件 / 老宿主没有 Remote）返回 null，由调用方回退投影。
     */
    function readDeckFile(remote, sessionId, signal) {
      var files = workspaceFilesOf(remote)
      if (files === null || typeof files.read !== 'function') {
        return Promise.resolve(null)
      }
      var id = sanitizeSessionId(sessionId)
      if (id === '') return Promise.resolve(null)
      var pending
      try {
        pending = files.read(id, deckRelativePath(id), {}, signal)
      } catch (error) {
        return Promise.resolve(null)
      }
      return Promise.resolve(pending).then(function (result) {
        if (result && result.ok === false) return null
        var payload = result && result.ok === true ? result.value : result
        var raw = payload && typeof payload.text === 'string' ? payload.text : ''
        return parseDeckText(raw)
      }, function () {
        return null
      })
    }

    /**
     * 订阅快照变化：优先官方 workspaceFiles.changes 的文件级 watch，
     * 流打不开（还没有文件 / 老宿主）就退回 DECK_POLL_MS 轮询。返回同步 disposer。
     */
    function subscribeDeckFile(remote, sessionId, onData) {
      var stopped = false
      var handle = null
      var timer = null
      var id = sanitizeSessionId(sessionId)

      function emit(value) {
        if (stopped || value === null || value === undefined) return
        try {
          onData(value)
        } catch (error) {
          // 渲染回调抛错不该打断订阅
        }
      }
      function readOnce() {
        readDeckFile(remote, id).then(emit, function () {})
      }
      function startPolling() {
        if (timer !== null || stopped) return
        timer = setInterval(readOnce, DECK_POLL_MS)
      }
      function consume(stream) {
        var iterator
        try {
          iterator = stream[Symbol.asyncIterator]()
        } catch (error) {
          startPolling()
          return
        }
        function next() {
          if (stopped) return
          var step
          try {
            step = iterator.next()
          } catch (error) {
            startPolling()
            return
          }
          Promise.resolve(step).then(function (result) {
            if (stopped) return
            if (result.done) {
              startPolling()
              return
            }
            var item = result.value
            try {
              if (item && typeof item.accept === 'function') item.accept()
            } catch (error) {
              // accept 失败不影响再读一次
            }
            readOnce()
            next()
          }, function () {
            startPolling()
          })
        }
        next()
      }

      readOnce()
      var files = workspaceFilesOf(remote)
      var streamFactory = null
      try {
        streamFactory = remote && typeof remote.$stream === 'function' ? remote.$stream : null
      } catch (error) {
        streamFactory = null
      }
      if (id !== '' && streamFactory !== null && files !== null && typeof files.changes === 'function') {
        try {
          var stream = streamFactory({
            name: 'agent-master deck ' + id,
            open: function (lifetime) {
              return files.changes(id, deckRelativePath(id), lifetime)
            },
            ended: function () {
              return new Error('agent-master deck watch ended')
            },
          })
          if (stream && typeof stream[Symbol.asyncIterator] === 'function') {
            handle = stream
            consume(stream)
          } else {
            startPolling()
          }
        } catch (error) {
          startPolling()
        }
      } else {
        startPolling()
      }

      return function () {
        stopped = true
        if (timer !== null) clearInterval(timer)
        timer = null
        if (handle && typeof handle.dispose === 'function') {
          try {
            handle.dispose()
          } catch (error) {
            // 已断开的流 dispose 抛错无所谓
          }
        }
        handle = null
      }
    }

    /**
     * 指挥台状态：快照优先，老会话（没有快照文件）回退到投影。
     * 订阅跟着 sessionId 走；组件卸载时由 effect 的返回值断开。
     */
    function useDeckState(props) {
      var fallback = readProjection(props)
      var pair = React.useState(null)
      var current = pair[0]
      var setCurrent = pair[1]
      var sessionId = props ? props.sessionId : undefined
      React.useEffect(function () {
        if (!props || typeof props.subscribeDeck !== 'function' || !sessionId) return undefined
        return props.subscribeDeck(sessionId, function (value) {
          if (value !== null && value !== undefined) setCurrent(value)
        })
      }, [sessionId])
      return current !== null && current !== undefined ? current : fallback
    }

    /**
     * 指挥台正文。
     * props 来自 session 作用域 seat：sessionId 与 useProjection；openChild 由本插件在
     * stage2 的 inject 里注入（点击卡片时用它按官方寻址打开子会话 tab）。
     */
    /** 左栏底部入口：root 作用域没有投影，所以只负责「进得去」。 */
    function SidebarDeckEntry(props) {
      return h(
        'button',
        {
          type: 'button',
          title: DECK_TITLE,
          'data-agent-master': 'deck-entry',
          style: STYLES.footerButton,
          onClick: function () {
            if (props && typeof props.openDeck === 'function') props.openDeck()
          },
        },
        DECK_TITLE,
      )
    }

    /** 会话头胶囊：session 作用域，能显示「还没回报/总数」（快照优先，投影回退）。 */
    function HeaderDeckPill(props) {
      var badge = deckBadge(useDeckState(props))
      var style = STYLES.pill
      if (badge.tone === 'danger' || badge.tone === 'success') {
        style = Object.assign({}, style, { color: TONE_COLORS[badge.tone] })
      }
      return h(
        'button',
        {
          type: 'button',
          title: deckBadgeTitle(badge),
          'data-agent-master': 'deck-pill',
          style: style,
          onClick: function () {
            if (props && typeof props.openDeck === 'function') props.openDeck()
          },
        },
        badge.text,
      )
    }

    function DeckPanel(props) {
      // hooks 规则：useDeckState（内部含 useState/useEffect/useProjection）必须无条件调用。
      var state = useDeckState(props)
      var model = viewModel(state)

      if (model.empty) {
        // 绑了会话才谈得上「下派」；没绑会话先指路，否则用户只看到一句无从下手的话。
        var bound = props && typeof props.sessionId === 'string' && props.sessionId !== ''
        return h(
          'div',
          { style: STYLES.root, 'data-agent-master': 'deck', 'data-deck-bound': bound ? 'yes' : 'no' },
          h(DeckHeader, { model: model }),
          h('div', { style: STYLES.empty }, bound ? model.emptyText : UNBOUND_TEXT),
        )
      }

      // 旧契约快照：只给占位提示，不渲染半截数据、也不抛错
      if (model.incompatible) {
        return h(
          'div',
          { style: STYLES.root, 'data-agent-master': 'deck', 'data-deck-version': 'incompatible' },
          h(DeckHeader, { model: model }),
          h('div', { style: STYLES.empty }, model.placeholderText),
        )
      }

      return h(
        'div',
        { style: STYLES.root, 'data-agent-master': 'deck' },
        h(DeckHeader, { model: model }),
        model.alert ? h(AlertRow, { alert: model.alert }) : null,
        h(CountsRow, { items: model.countItems }),
        h(SectionTitle, { text: '看板' }),
        model.cards.length > 0
          ? h(
              'div',
              { style: STYLES.cards },
              model.cards.map(function (card, index) {
                return h(CardRow, {
                  key: card.id || String(index),
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
          : h('div', { style: STYLES.muted }, '看板上还没有卡 —— 用 master_dispatch 或 master_assign 派一路'),
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
    function installSidebarSeats(ctx, translate, openChild, openDeck, subscribeDeck) {
      // 闭包在 apply 里只造一次，注入的 props 也保持同一引用，避免每次渲染都换新对象。
      var injectedProps = { openChild: openChild, openDeck: openDeck, subscribeDeck: subscribeDeck }

      /**
       * 挂一个座位：单个座位失败只记警告，绝不牵连其它座位。
       *
       * 真机踩过两次：① 单占位 slot（如 conversation.session.header.corner）已有宿主
       * 注册时 ctx.slots.register 抛 "single slot ... already has a registration"；
       * ② 这个抛错发生在 installSidebarSeats 里，被外层 catch 当成「整组座位不可用」，
       * 于是右栏指挥台、左栏入口全都不见了，只剩 overlay 降级 —— 一个座位废掉全部。
       */
      function seat(slotName, label, register) {
        effect(ctx, function () {
          return ctx.slots.inject(slotName, function () {
            try {
              return register()
            } catch (error) {
              warn('agent-master 客户端：座位注册失败（' + label + ' / ' + slotName + '），只跳过这个座位。', error)
              return null
            }
          })
        }, 'agent-master: ' + label)
      }
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

      seat('sidebar.right.pane.tab', '指挥台面板', function () {
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

      seat('sidebar.right.pane.tab.title', '指挥台标签标题', function () {
        return ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID }, DeckTabTitle)
      })

      // 会话头胶囊：session 作用域，能读投影，所以「还没回报/总数」放这里。
      // 槽位名是从真宿主页面实测来的（0.2.2-rc.5 只渲染
      // conversation.session.header / .corner 等；早先猜的 .utilities 这版不存在，
      // 注册了也永远不触发 —— 真机踩过：胶囊一直不出现）。
      seat('conversation.input.left', '会话头计数', function () {
        return ctx.slots.register(
          {
            name: 'conversation.input.left',
            id: HEADER_UTILITY_ID,
            order: 100,
            inject: function () {
              return injectedProps
            },
          },
          HeaderDeckPill,
        )
      })

      // 左栏底部入口：root 作用域，点了直接把右栏指挥台打开。
      seat('sidebar.footer.action', '左栏入口', function () {
        return ctx.slots.register(
          {
            name: 'sidebar.footer.action',
            id: FOOTER_ACTION_ID,
            order: 100,
            inject: function () {
              return injectedProps
            },
          },
          SidebarDeckEntry,
        )
      })
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
      var openDeck = function () {
        return openDeckTab(ctx)
      }
      var remote = resolveRemote(ctx)
      var subscribeDeck = function (sessionId, onData) {
        return subscribeDeckFile(remote, sessionId, onData)
      }
      if (ctx.sidebarRightTabs && typeof ctx.sidebarRightTabs.register === 'function') {
        try {
          installSidebarSeats(ctx, translate, openChild, openDeck, subscribeDeck)
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
    // remote / remote.workspaceFiles 必须声明：宿主 ctx 是服务代理，未注入的服务
    // 一访问就抛 `without inject`（真机踩过，面板因此整片空白）。
    // 只能写**纯数组**：这套宿主的 Loader 把对象形态的键当成服务名逐个等待
    // （实测 inject={required,optional} 会让插件永远 pending）。
    exports.inject = ['slots', 'sidebarRightTabs', 'locale', 'sessions', 'remote', 'remote.workspaceFiles']
    exports.apply = apply
    // 纯函数导出：test/client.test.mjs 通过经典脚本路径读到同一份实现。
    exports.viewModel = viewModel
    exports.statusLabel = statusLabel
    exports.statusTone = statusTone
    exports.kindLabel = kindLabel
    exports.countItems = countItems
    exports.chatAddress = chatAddress
    exports.toneColors = TONE_COLORS
    exports.deckBadge = deckBadge
    exports.deckBadgeTitle = deckBadgeTitle
    exports.formatTime = formatTime
    exports.openDeckTab = openDeckTab
    exports.deckRelativePath = deckRelativePath
    exports.parseDeckText = parseDeckText
    exports.subscribeDeck = subscribeDeckFile
    exports.constants = Object.freeze({
      PACKAGE_ID: PACKAGE_ID,
      TAB_ID: TAB_ID,
      TAB_KIND: TAB_KIND,
      PROJECTION_KEY: PROJECTION_KEY,
      DECK_DIR_NAME: DECK_DIR_NAME,
      DECK_FILE_NAME: DECK_FILE_NAME,
      EMPTY_TEXT: EMPTY_TEXT,
      UNBOUND_TEXT: UNBOUND_TEXT,
      RECENT_LIMIT: RECENT_LIMIT,
      DECK_VERSION: DECK_VERSION,
      DECK_TITLE: DECK_TITLE,
      CHAT_ADDRESS_PREFIX: CHAT_ADDRESS_PREFIX,
      DEFAULT_CHAT_MODE: DEFAULT_CHAT_MODE,
      FOOTER_ACTION_ID: FOOTER_ACTION_ID,
      HEADER_UTILITY_ID: HEADER_UTILITY_ID,
    })
    return module.exports
  },
})
