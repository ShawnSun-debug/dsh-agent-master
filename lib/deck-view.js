/**
 * dsh-agent-master — 指挥台的 dsh-Go 原生面板视图（T14，方案 B·起草版）。
 *
 * 纯函数：deck v2 快照（lib/deck.js buildDeck 的产物）→ dsh-Go v2 view DSL。
 * 组件只用官方示例实证过的：stack / row / text / metric / emptyState / actions
 * （dsh-go-example-album/lib/view.js、actions-chain.md §2）；tone 只用实证值 'good'。
 * 交互语义=起草版：按钮不直接改看板，handler 把对应指令 insert 进输入框（不发送），
 * 审批/经验/审计全链路保留 —— handler 在 lib/index.js，本文件只产视图与文案。
 * 预算：面板 ≤32 KiB / ≤120 节点 / 深 ≤8 / 每节点子 ≤32（actions-chain.md §1/§4），
 * 卡片超出 DECK_VIEW_MAX_CARDS 就截断成一条提示，计数行始终反映整块看板。
 *
 * @module dsh-agent-master/deck-view
 */

/** 六种卡片状态 → 徽标文案（与 client/client.js 的 STATUS_LABELS 同源同序）。 */
export const STATUS_LABELS = {
  todo: '待认领',
  assigned: '已认领',
  doing: '开工中',
  review: '待验收',
  done: '已完成',
  blocked: '阻塞',
}

/** 可操作状态 → 起草动作（done/blocked 不给按钮）。 */
export const CARD_ACTIONS = {
  todo: [{ verb: 'claim', label: '认领' }],
  assigned: [{ verb: 'doing', label: '开工' }],
  review: [
    { verb: 'accept', label: '验收' },
    { verb: 'rework', label: '打回' },
  ],
}

/** 顶部计数行的字段与标签（与 client/client.js 的 COUNT_FIELDS 对齐）。 */
export const COUNT_FIELDS = [
  ['cards', '卡片'],
  ['doing', '在做'],
  ['review', '待验收'],
  ['violations', '违规'],
  ['records', '记录'],
]

/** dsh-Go 面板视图硬预算（actions-chain.md §1/§4：panel 32768B/120 节点/深 8/子 32）。 */
export const DECK_VIEW_BUDGET = Object.freeze({ bytes: 32 * 1024, nodes: 120, depth: 8, children: 32 })

/** 最多渲染多少张卡；超出截断为提示行（预算内优先保头部计数与结构）。 */
export const DECK_VIEW_MAX_CARDS = 24

/** 每组最多几张卡（组内 text+actions 交替，8×2=16 子 ≤32）。 */
const GROUP_SIZE = 8

/** 单卡标题截断长度（防止长 goal 撑爆 32KiB）。 */
const LABEL_MAX = 40

const EMPTY_TITLE = '还没有下派任何子对话'
const EMPTY_MESSAGE = '在主对话里用 master_dispatch / master_assign 开一路'

/** @param {unknown} value @returns {number} */
function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

/** @param {string} text @returns {string} */
function truncate(text) {
  return text.length > LABEL_MAX ? text.slice(0, LABEL_MAX - 1) + '…' : text
}

/** @param {string} label @param {unknown} value @param {string=} tone */
function metric(label, value, tone) {
  const node = { type: 'metric', label, value: count(value) }
  if (tone !== undefined) node.tone = tone
  return node
}

/** 顶部计数行：五格 metric，数组顺序即 UI 顺序。 */
export function headerRow(counts) {
  return {
    type: 'row',
    children: COUNT_FIELDS.map(([key, label]) =>
      // 实证过的 tone 只有 'good'：违规归零时给正向反馈，其余等 tone 枚举全量确认再补。
      key === 'violations' && count(counts?.[key]) === 0 ? metric(label, counts?.[key], 'good') : metric(label, counts?.[key])
    ),
  }
}

/** 单卡一行文本：id 状态 认领者 违规 标题。 */
export function cardText(card) {
  const status = STATUS_LABELS[card?.status] ?? String(card?.status ?? '')
  const who = card?.assignee && card.assignee.name ? ' · ' + card.assignee.name : ''
  const warn = count(card?.counts?.violations) > 0 ? ' · ⚠违规' + count(card.counts.violations) : ''
  return String(card?.id ?? '') + ' ' + status + who + warn + ' ' + truncate(String(card?.label ?? ''))
}

/**
 * 起草文本：按钮动作 → 发给 master 会话的自然语言指令（human 确认后才执行）。
 *
 * @param {string} verb claim / doing / accept / rework
 * @param {string} cardId 卡号
 * @returns {string|null} 不认识的动词返回 null（handler 据此返回 []，不报错）
 */
export function draftText(verb, cardId) {
  const id = String(cardId ?? '').trim()
  if (id === '') return null
  switch (verb) {
    case 'claim': return '认领 ' + id
    case 'doing': return '开工 ' + id
    case 'accept': return '验收 ' + id
    case 'rework': return '打回 ' + id + '：'
    default: return null
  }
}

/** 单卡的动作组件（没有可操作动作时返回 null，调用方不渲染）。 */
export function cardActions(card) {
  const verbs = CARD_ACTIONS[card?.status]
  if (!verbs || verbs.length === 0) return null
  return {
    type: 'actions',
    items: verbs.map(({ verb, label }) => ({
      label,
      action: { id: 'draft', args: { cardId: String(card?.id ?? ''), verb } },
    })),
  }
}

/**
 * deck v2 快照 → dsh-Go v2 视图。纯函数，不碰盘、不发请求。
 *
 * @param {any} snapshot buildDeck 的产物（或同形状对象；null/缺字段按空看板渲染）
 * @returns {any} v2 view DSL JSON（可直接作为 ctx.dshGo.panel 的 view）
 */
export function deckView(snapshot) {
  const cards = Array.isArray(snapshot?.cards) ? snapshot.cards : []
  const counts = snapshot?.counts ?? {}
  const children = [headerRow(counts)]

  if (cards.length === 0) {
    children.push({ type: 'emptyState', title: EMPTY_TITLE, message: EMPTY_MESSAGE })
  } else {
    const shown = cards.slice(0, DECK_VIEW_MAX_CARDS)
    for (let i = 0; i < shown.length; i += GROUP_SIZE) {
      const group = []
      for (const card of shown.slice(i, i + GROUP_SIZE)) {
        group.push({ type: 'text', text: cardText(card) })
        const actions = cardActions(card)
        if (actions) group.push(actions)
      }
      children.push({ type: 'stack', style: { gap: 'S' }, children: group })
    }
    if (cards.length > shown.length) {
      children.push({ type: 'text', text: '还有 ' + (cards.length - shown.length) + ' 张未显示 —— 计数行是整板实况' })
    }
  }

  return { v: 2, accent: 'app', type: 'stack', style: { gap: 'L' }, children }
}

/** 遍历视图统计节点数 / 最大深度 / 单节点最大子数（含 items 数组）。 */
export function viewStats(view) {
  const acc = { nodes: 0, depth: 0, maxChildren: 0 }
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object') return
    acc.nodes += 1
    if (depth > acc.depth) acc.depth = depth
    const groups = []
    if (Array.isArray(node.children)) groups.push(node.children)
    if (Array.isArray(node.items)) groups.push(node.items)
    for (const group of groups) {
      if (group.length > acc.maxChildren) acc.maxChildren = group.length
      for (const child of group) walk(child, depth + 1)
    }
  }
  walk(view, 1)
  return acc
}

/** 视图序列化字节数（预算口径：JSON 序列化后的 UTF-8 字节）。 */
export function viewBytes(view) {
  return Buffer.byteLength(JSON.stringify(view), 'utf8')
}
