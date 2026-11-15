/**
 * dsh-agent-master — 指挥台数据（deck）。
 *
 * 把黑板折算成给客户端看的一份纯数据快照：每路子对话的状态、计数与最近时间线。
 * **纯读**：只调用 board.head() / board.query()，不写盘、不改黑板、不碰台账正文，
 * 因此宿主可以每次工具执行后随手算一份追加进会话事件（'agent-master/deck'），
 * 客户端投影再把它折成 agentMaster 状态。
 *
 * 归组依据是作者的 name（lib/tools.js 的 master_report 会按子会话名写 author）；
 * 已下派但还没回报的任务在黑板上只有一条 author=master 的 task 记录，
 * 因此按 taskId 补一条 assigned 行 —— 这是契约里 assigned 唯一可推导的来源。
 *
 * @module dsh-agent-master/deck
 */

/** 投影状态版本（wire 的 stateVersion 必须与这里一致）。 */
export const DECK_STATE_VERSION = 1

/** 会话事件名：master 工具执行成功后追加，投影按此 fold。 */
export const DECK_EVENT = 'agent-master/deck'

/** 参与 deck 的黑板记录类型（decision 不算进度，只进 recent 时间线）。 */
const DECK_KINDS = Object.freeze(['task', 'finding', 'source', 'artifact', 'open_question'])

/** 违规标记的 tag 前缀（与 lib/tools.js 写板时保持一致）。 */
const VIOLATION_TAG_PREFIX = 'violation:'

/** 任务号形状：t1、t2 ……（与 lib/tools.js 一致） */
const TASK_ID_PATTERN = /^t\d+$/

/**
 * board.query 的单次上界。黑板本身有 config.boardMaxEntries 硬上限，
 * 这里取一个远大于上限的安全整数，避免用默认 limit=100 漏掉记录。
 */
const QUERY_LIMIT = 100_000

/** 默认最近条目数：够看清发生了什么，又不至于把状态撑大。 */
export const DEFAULT_RECENT_LIMIT = 12

/** 三类状态（契约固定，不要加值）。 */
const STATUSES = Object.freeze(['assigned', 'reported', 'violated'])

/** 计数对象的键（契约固定）。 */
const COUNT_KEYS = Object.freeze(['tasks', 'findings', 'sources', 'artifacts', 'violations'])

/** deck 数据错误（形状不对、缺依赖等「调用方必须改」的失败） */
export class DeckError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message)
    this.name = 'DeckError'
  }
}

/** deck 状态校验错误：stateSchema.parse 用它（文案中文，带字段路径） */
export class DeckStateError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message)
    this.name = 'DeckStateError'
  }
}

/** 非负整数（计数与 seq 只允许它） */
function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0
}

/** 字符串（缺失时归一成空串，投影状态里不留 undefined） */
function asText(value) {
  return typeof value === 'string' ? value : ''
}

/** 任务的排序键：t1 < t2 < t10；没有任务号的排最后 */
function taskOrder(taskId) {
  const match = TASK_ID_PATTERN.exec(asText(taskId))
  return match === null ? Number.MAX_SAFE_INTEGER : Number(asText(taskId).slice(1))
}

/** 一条记录里的违规 tag 数 */
function countViolationTags(tags) {
  if (!Array.isArray(tags)) return 0
  let total = 0
  for (const tag of tags) {
    if (typeof tag === 'string' && tag.startsWith(VIOLATION_TAG_PREFIX)) total += 1
  }
  return total
}

/** 记录作者名（黑板上可能没有 name：退化成「（未命名）」，与 collect 的归组口径一致） */
function authorName(record) {
  const name = record && record.author ? record.author.name : null
  return typeof name === 'string' && name !== '' ? name : '（未命名）'
}

/** 记录 refs 里第一个形如 t1 的任务号 */
function taskIdOf(record) {
  const refs = Array.isArray(record && record.refs) ? record.refs : []
  for (const ref of refs) {
    if (typeof ref === 'string' && TASK_ID_PATTERN.test(ref)) return ref
  }
  return null
}

/** 空计数 */
function zeroCounts() {
  /** @type {Record<string, number>} */
  const counts = {}
  for (const key of COUNT_KEYS) counts[key] = 0
  return counts
}

/**
 * 按 kind 分别读黑板（契约里 kind 过滤最稳），合并后按 seq 升序。
 * @param {{query: Function}} board
 * @returns {Promise<any[]>}
 */
async function readRecords(board) {
  /** @type {any[]} */
  const records = []
  for (const kind of DECK_KINDS) {
    const found = await board.query({ kind, sinceSeq: 0, limit: QUERY_LIMIT })
    if (Array.isArray(found)) records.push(...found)
  }
  return records.sort((a, b) => (a && a.seq ? a.seq : 0) - (b && b.seq ? b.seq : 0))
}

/**
 * @typedef {object} DeckChild
 * @property {string} name 子对话名（未回报的行用任务号）
 * @property {string} label 展示名（未回报的行用 task 记录的 goal）
 * @property {string} taskId 任务号（拿不到时是空串）
 * @property {string} sessionId 子会话 id（客户端据此开子对话 tab；拿不到时是空串）
 * @property {'assigned'|'reported'|'violated'} status
 * @property {number} findings
 * @property {number} evidence
 * @property {number} artifacts
 * @property {number} violations
 */

/**
 * @typedef {object} DeckState
 * @property {number} headSeq
 * @property {number} updatedAt
 * @property {DeckChild[]} children
 * @property {{tasks: number, findings: number, sources: number, artifacts: number, violations: number}} counts
 * @property {{seq: number, kind: string, title: string}[]} recent
 */

/**
 * 从黑板算出指挥台快照（纯读）。
 *
 * @param {{board: {head: Function, query: Function}, ledger?: any, rootId?: string, recentLimit?: number, names?: string[]}} input
 *   names 是可选过滤：只保留点名的子对话（名字或任务号都行）；counts/recent 仍描述整块黑板。
 *   ledger 目前只接收不读取：deck 只读黑板，台账正文留给 master_collect/违规明细（T7）。
 * @returns {Promise<DeckState>}
 * @throws {DeckError} board 缺失或形状不对
 */
export async function buildDeck(input = {}) {
  const { board, recentLimit = DEFAULT_RECENT_LIMIT, names } = input ?? {}
  if (!board || typeof board.query !== 'function' || typeof board.head !== 'function') {
    throw new DeckError('buildDeck 需要 board（必须提供 head 与 query）')
  }

  const limit = isCount(recentLimit) ? recentLimit : DEFAULT_RECENT_LIMIT
  const records = await readRecords(board)
  const taskRecords = records.filter((record) => record && record.kind === 'task')
  const reportRecords = records.filter((record) => record && record.kind !== 'task')

  // 1. 按作者名归组：finding/source/artifact/open_question 都是子对话写的
  /** @type {Map<string, DeckChild>} */
  const groups = new Map()
  /** 已经取过 sessionId 的组名（只需要第一条记录的值） @type {Set<string>} */
  const sessionSeen = new Set()
  for (const record of reportRecords) {
    const name = authorName(record)
    let child = groups.get(name)
    if (child === undefined) {
      child = {
        name,
        label: name,
        taskId: '',
        sessionId: '',
        status: 'assigned',
        findings: 0,
        evidence: 0,
        artifacts: 0,
        violations: 0,
      }
      groups.set(name, child)
    }
    if (child.taskId === '') {
      const taskId = taskIdOf(record)
      if (taskId !== null) child.taskId = taskId
    }
    // sessionId 取这个孩子**第一条**（seq 最小）记录的 author.sessionId：
    // 同一个名字理论上只对应一个子会话；真出现不一致时以最早那条为准，
    // 避免冷恢复后换了 session 却把旧记录挂到新会话上（客户端会拿它开 tab）。
    if (!sessionSeen.has(name)) {
      child.sessionId = asText(record.author ? record.author.sessionId : null)
      sessionSeen.add(name)
    }
    child.violations += countViolationTags(record.tags)
    if (record.kind === 'finding') child.findings += 1
    else if (record.kind === 'source') child.evidence += 1
    else if (record.kind === 'artifact') child.artifacts += 1
  }

  // 2. 已下派未回报：task 记录补一行 assigned（taskId 已被某个子对话认领就不重复补）
  const claimed = new Set()
  for (const child of groups.values()) {
    if (child.taskId !== '') claimed.add(child.taskId)
  }
  /** @type {DeckChild[]} */
  const children = []
  for (const record of taskRecords) {
    const taskId = taskIdOf(record)
    if (taskId !== null && claimed.has(taskId)) continue
    children.push({
      name: taskId ?? 'task:' + String(record.seq ?? ''),
      label: asText(record.title),
      taskId: taskId ?? '',
      // 未回报的行没有子会话记录；task 记录的 author 是 master，它的 sessionId 不能借给孩子
      sessionId: '',
      status: 'assigned',
      findings: 0,
      evidence: 0,
      artifacts: 0,
      violations: 0,
    })
  }
  children.push(...groups.values())

  // 3. 状态判定：violated > reported > assigned
  for (const child of children) {
    child.status = child.violations > 0 ? 'violated' : child.findings > 0 ? 'reported' : 'assigned'
  }

  // 4. 稳定排序：先按任务号，再按名字（客户端不需要自己排）
  children.sort((left, right) => taskOrder(left.taskId) - taskOrder(right.taskId) || left.name.localeCompare(right.name))

  // 5. 计数：五类记录全板统计，violations 统计所有违规 tag
  const counts = zeroCounts()
  for (const record of records) {
    if (record.kind === 'task') counts.tasks += 1
    else if (record.kind === 'finding') counts.findings += 1
    else if (record.kind === 'source') counts.sources += 1
    else if (record.kind === 'artifact') counts.artifacts += 1
    counts.violations += countViolationTags(record.tags)
  }

  // 6. 最近时间线：按 seq 升序取最后 limit 条
  const recent = limit === 0
    ? []
    : records.slice(Math.max(0, records.length - limit)).map((record) => ({
        seq: isCount(record.seq) ? record.seq : 0,
        kind: asText(record.kind),
        title: asText(record.title),
      }))

  // 7. 可选按名过滤：只缩 children，counts/recent 仍是整块黑板
  const filtered = Array.isArray(names) && names.length > 0
    ? children.filter((child) => names.includes(child.name) || (child.taskId !== '' && names.includes(child.taskId)))
    : children

  const head = await board.head()
  const headSeq = head && isCount(head.seq) ? head.seq : 0

  return {
    headSeq,
    updatedAt: Date.now(),
    children: filtered.map((child) => ({ ...child })),
    counts,
    recent,
  }
}

/**
 * 投影状态形状（契约里 stateSchema / wire.viewSchema 用同一个）。
 *
 * 宿主的 sessionProjections 只要求一个带 .parse 的对象（api-notes §4），
 * 不依赖 zod：本仓零依赖，装了 zod 也不能保证解析得到，所以用鸭子类型校验。
 *
 * @type {{parse: (value: unknown) => DeckState | null}}
 */
export const deckStateSchema = {
  /**
   * @param {unknown} value
   * @returns {DeckState | null} null 表示尚无任何记录（投影 init 的初值）
   * @throws {DeckStateError} 形状不合法
   */
  parse(value) {
    if (value === null) return null
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new DeckStateError('deck 状态必须是对象或 null，实际收到 ' + JSON.stringify(value))
    }
    const state = /** @type {any} */ (value)
    if (!isCount(state.headSeq)) throw new DeckStateError('deck.headSeq 必须是非负整数')
    if (typeof state.updatedAt !== 'number' || !Number.isFinite(state.updatedAt)) {
      throw new DeckStateError('deck.updatedAt 必须是有限数字')
    }
    if (!Array.isArray(state.children)) throw new DeckStateError('deck.children 必须是数组')
    for (const [index, child] of state.children.entries()) {
      const path = 'deck.children[' + index + ']'
      if (!child || typeof child !== 'object') throw new DeckStateError(path + ' 必须是对象')
      if (typeof child.name !== 'string') throw new DeckStateError(path + '.name 必须是字符串')
      if (typeof child.label !== 'string') throw new DeckStateError(path + '.label 必须是字符串')
      if (typeof child.taskId !== 'string') throw new DeckStateError(path + '.taskId 必须是字符串')
      if (typeof child.sessionId !== 'string') throw new DeckStateError(path + '.sessionId 必须是字符串')
      if (!STATUSES.includes(child.status)) {
        throw new DeckStateError(path + '.status 只能是 ' + STATUSES.join(' / ') + '，实际收到 ' + JSON.stringify(child.status))
      }
      for (const key of ['findings', 'evidence', 'artifacts', 'violations']) {
        if (!isCount(child[key])) throw new DeckStateError(path + '.' + key + ' 必须是非负整数')
      }
    }
    if (!state.counts || typeof state.counts !== 'object') throw new DeckStateError('deck.counts 必须是对象')
    for (const key of COUNT_KEYS) {
      if (!isCount(state.counts[key])) throw new DeckStateError('deck.counts.' + key + ' 必须是非负整数')
    }
    if (!Array.isArray(state.recent)) throw new DeckStateError('deck.recent 必须是数组')
    for (const [index, item] of state.recent.entries()) {
      const path = 'deck.recent[' + index + ']'
      if (!item || typeof item !== 'object') throw new DeckStateError(path + ' 必须是对象')
      if (!isCount(item.seq)) throw new DeckStateError(path + '.seq 必须是非负整数')
      if (typeof item.kind !== 'string') throw new DeckStateError(path + '.kind 必须是字符串')
      if (typeof item.title !== 'string') throw new DeckStateError(path + '.title 必须是字符串')
    }
    return /** @type {DeckState} */ (state)
  },
}
