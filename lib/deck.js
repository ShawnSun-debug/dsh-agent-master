/**
 * dsh-agent-master — 指挥台数据（deck v2，ADR-0004）。
 *
 * 把看板折算成给客户端看的一份纯数据快照：每张卡的状态 / 认领者 / P 级 / 计数，
 * 加一条最近时间线。**纯读**：只调用 board.head / listCards / queryRecords，
 * 不写盘、不改看板、不碰台账正文。
 *
 * v2 相对 v1 的变化（不兼容，ADR-0004）：
 * - 顶层带 version=2；客户端只认 2，读到别的就当占位（旧会话的白屏是可接受代价）。
 * - children → cards，每张卡直接带 status / assignee / priority / rev（v1 要从记录反推）。
 * - records 只投影摘要字段（seq / kind / cardId / title），正文不进快照。
 *
 * @module dsh-agent-master/deck
 */

import { CARD_STATUSES, PRIORITIES } from './board.js'

/** deck 契约版本：客户端按它判兼容。 */
export const DECK_VERSION = 2

/** 投影状态版本（wire 的 stateVersion 必须与这里一致）。 */
export const DECK_STATE_VERSION = 2

/** 会话事件名：v1 时代写过；v2 不再写（自定义事件会让会话读不回来），保留常量给旧投影回退。 */
export const DECK_EVENT = 'agent-master/deck'

/** 默认最近条目数：够看清发生了什么，又不至于把状态撑大。 */
export const DEFAULT_RECENT_LIMIT = 12

/** 违规标记的 tag 前缀（与 lib/tools.js 写记录时一致）。 */
const VIOLATION_TAG_PREFIX = 'violation:'

/** queryRecords 的单次上界：看板本身有 boardMaxEntries 硬上限。 */
const QUERY_LIMIT = 100_000

/** deck 数据错误（形状不对、缺依赖等「调用方必须改」的失败）。 */
export class DeckError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message)
    this.name = 'DeckError'
  }
}

/** deck 状态校验错误：stateSchema.parse 用它（文案中文，带字段路径）。 */
export class DeckStateError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message)
    this.name = 'DeckStateError'
  }
}

/** @param {unknown} value @returns {boolean} */
function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0
}

/** @param {unknown} value @returns {string} */
function asText(value) {
  return typeof value === 'string' ? value : ''
}

/** 卡号排序键：t1 < t2 < t10；非 tN 排最后。 */
function cardOrder(cardId) {
  const match = /^t([0-9]+)$/.exec(asText(cardId))
  return match === null ? Number.MAX_SAFE_INTEGER : Number(asText(cardId).slice(1))
}

/** 一条记录里的违规 tag 数。 */
function countViolationTags(tags) {
  if (!Array.isArray(tags)) return 0
  let total = 0
  for (const tag of tags) {
    if (typeof tag === 'string' && tag.startsWith(VIOLATION_TAG_PREFIX)) total += 1
  }
  return total
}

/**
 * 从看板算出指挥台快照（纯读）。
 *
 * @param {{board: {head: Function, listCards: Function, queryRecords: Function}, recentLimit?: number, names?: string[]}} input
 * @returns {Promise<any>}
 * @throws {DeckError} board 缺失或形状不对
 */
export async function buildDeck(input = {}) {
  const { board, recentLimit = DEFAULT_RECENT_LIMIT, names } = input ?? {}
  if (
    !board ||
    typeof board.head !== 'function' ||
    typeof board.listCards !== 'function' ||
    typeof board.queryRecords !== 'function'
  ) {
    throw new DeckError('buildDeck 需要 board（必须提供 head / listCards / queryRecords）')
  }

  const limit = isCount(recentLimit) ? recentLimit : DEFAULT_RECENT_LIMIT
  const head = await board.head()
  const cards = (await board.listCards({ limit: head.cards > 0 ? head.cards : 1 })) ?? []
  const records = (await board.queryRecords({ limit: QUERY_LIMIT })) ?? []

  // 1. 按卡统计证据：finding / source / artifact / 违规
  /** @type {Map<string, {findings: number, sources: number, artifacts: number, violations: number}>} */
  const perCard = new Map()
  for (const card of cards) perCard.set(card.id, { findings: 0, sources: 0, artifacts: 0, violations: 0 })
  for (const record of records) {
    const bucket = perCard.get(record.cardId)
    if (bucket === undefined) continue
    bucket.violations += countViolationTags(record.tags)
    if (record.kind === 'finding') bucket.findings += 1
    else if (record.kind === 'source') bucket.sources += 1
    else if (record.kind === 'artifact') bucket.artifacts += 1
  }

  // 2. 卡片行：客户端拿到的就是这些字段（不自己推导状态）
  /** @type {any[]} */
  const rows = cards.map((card) => {
    const bucket = perCard.get(card.id) ?? { findings: 0, sources: 0, artifacts: 0, violations: 0 }
    return {
      id: card.id,
      label: asText(card.title),
      status: card.status,
      priority: card.priority,
      rev: isCount(card.rev) ? card.rev : 0,
      assignee: card.assignee === null || card.assignee === undefined
        ? null
        : { sessionId: asText(card.assignee.sessionId), name: asText(card.assignee.name) },
      // 点卡片要开子对话 tab：优先派发时登记的 childSessionId，再退到认领者
      sessionId: asText(card.childSessionId) !== ''
        ? asText(card.childSessionId)
        : card.assignee === null || card.assignee === undefined ? '' : asText(card.assignee.sessionId),
      counts: { ...bucket },
      updatedAt: isCount(card.updatedAt) ? card.updatedAt : 0,
    }
  })
  rows.sort((left, right) => cardOrder(left.id) - cardOrder(right.id))

  // 3. 看板计数：各状态各几张 + 记录总数 + 违规总数
  /** @type {Record<string, number>} */
  const counts = { cards: rows.length, records: records.length, violations: 0 }
  for (const status of CARD_STATUSES) counts[status] = 0
  for (const row of rows) counts[row.status] += 1
  for (const record of records) counts.violations += countViolationTags(record.tags)

  // 4. 最近时间线：只投影摘要字段，正文不进快照
  const recent = limit === 0
    ? []
    : records.slice(Math.max(0, records.length - limit)).map((record) => ({
        seq: isCount(record.seq) ? record.seq : 0,
        kind: asText(record.kind),
        cardId: asText(record.cardId),
        title: asText(record.title),
      }))

  // 5. 可选按卡号/标题过滤：只缩 cards，counts/recent 仍描述整块看板
  const filtered = Array.isArray(names) && names.length > 0
    ? rows.filter((row) => names.includes(row.id) || names.includes(row.label))
    : rows

  return {
    version: DECK_VERSION,
    revision: isCount(head.revision) ? head.revision : 0,
    updatedAt: Date.now(),
    cards: filtered.map((row) => ({ ...row })),
    counts,
    recent,
  }
}

/**
 * 投影状态形状（契约里 stateSchema / wire.viewSchema 用同一个）。
 *
 * 宿主的 sessionProjections 只要求一个带 .parse 的对象（api-notes §4），不依赖 zod。
 * 旧会话里的 v1 deck 事件也会走到这里：**不是 v2 就返回 null**（客户端显示占位），
 * 而不是抛错 —— 抛错会让整个会话装配失败。
 *
 * @type {{parse: (value: unknown) => any}}
 */
export const deckStateSchema = {
  /**
   * @param {unknown} value
   * @returns {any} null 表示「没有可用的 v2 快照」
   * @throws {DeckStateError} v2 形状不合法
   */
  parse(value) {
    if (value === null || value === undefined) return null
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new DeckStateError('deck 状态必须是对象或 null，实际收到 ' + JSON.stringify(value))
    }
    const state = /** @type {any} */ (value)
    // 旧格式（v1 或历史事件里的无版本对象）：放弃，交给客户端占位
    if (state.version !== DECK_VERSION) return null
    if (!isCount(state.revision)) throw new DeckStateError('deck.revision 必须是非负整数')
    if (typeof state.updatedAt !== 'number' || !Number.isFinite(state.updatedAt)) {
      throw new DeckStateError('deck.updatedAt 必须是有限数字')
    }
    if (!Array.isArray(state.cards)) throw new DeckStateError('deck.cards 必须是数组')
    for (const [index, card] of state.cards.entries()) {
      const path = 'deck.cards[' + index + ']'
      if (!card || typeof card !== 'object') throw new DeckStateError(path + ' 必须是对象')
      if (typeof card.id !== 'string') throw new DeckStateError(path + '.id 必须是字符串')
      if (typeof card.label !== 'string') throw new DeckStateError(path + '.label 必须是字符串')
      if (!CARD_STATUSES.includes(card.status)) {
        throw new DeckStateError(path + '.status 只能是 ' + CARD_STATUSES.join(' / ') + '，实际收到 ' + JSON.stringify(card.status))
      }
      if (!PRIORITIES.includes(card.priority)) {
        throw new DeckStateError(path + '.priority 只能是 ' + PRIORITIES.join(' / ') + '，实际收到 ' + JSON.stringify(card.priority))
      }
      if (!isCount(card.rev)) throw new DeckStateError(path + '.rev 必须是非负整数')
      if (card.assignee !== null && (typeof card.assignee !== 'object' || typeof card.assignee.sessionId !== 'string')) {
        throw new DeckStateError(path + '.assignee 必须是 null 或 { sessionId, name }')
      }
      if (typeof card.sessionId !== 'string') throw new DeckStateError(path + '.sessionId 必须是字符串')
      if (!card.counts || typeof card.counts !== 'object') throw new DeckStateError(path + '.counts 必须是对象')
      for (const key of ['findings', 'sources', 'artifacts', 'violations']) {
        if (!isCount(card.counts[key])) throw new DeckStateError(path + '.counts.' + key + ' 必须是非负整数')
      }
    }
    if (!state.counts || typeof state.counts !== 'object') throw new DeckStateError('deck.counts 必须是对象')
    if (!isCount(state.counts.cards)) throw new DeckStateError('deck.counts.cards 必须是非负整数')
    if (!isCount(state.counts.records)) throw new DeckStateError('deck.counts.records 必须是非负整数')
    if (!Array.isArray(state.recent)) throw new DeckStateError('deck.recent 必须是数组')
    for (const [index, item] of state.recent.entries()) {
      const path = 'deck.recent[' + index + ']'
      if (!item || typeof item !== 'object') throw new DeckStateError(path + ' 必须是对象')
      if (!isCount(item.seq)) throw new DeckStateError(path + '.seq 必须是非负整数')
      if (typeof item.kind !== 'string') throw new DeckStateError(path + '.kind 必须是字符串')
      if (typeof item.cardId !== 'string') throw new DeckStateError(path + '.cardId 必须是字符串')
      if (typeof item.title !== 'string') throw new DeckStateError(path + '.title 必须是字符串')
    }
    return state
  },
}
