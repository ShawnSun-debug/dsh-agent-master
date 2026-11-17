/**
 * dsh-agent-master — 共享看板（ADR-0001：board.json = 可变卡 + 只追加证据流）。
 *
 * 看板是**唯一事实来源**：cards[] 承载状态（可变、带 rev），records[] 承载审计与证据
 * （只追加、以 cardId 外键挂卡）。写入路径只有一条：
 *   进程内 mutex 串行 → 校验（状态机 / 归属 / 配额）→ 在内存副本上改 → 原子 write+rename → 提交内存。
 * 任何一步失败，盘上与内存都停在上一份完整状态（不会留半截文件）。
 *
 * CAS 粒度为**单卡 rev**：改卡必须带客户端看到的 rev，不一致即拒并回带最新 rev，
 * 调用方重读卡片后重试。这样并行子对话不会互相覆盖对方的状态改动。
 *
 * @module dsh-agent-master/board
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 看板文件版本：结构变更时递增（T10 迁移与 deck 契约都看它）。 */
export const BOARD_VERSION = 1

/** 看板文件名：一个 root 会话一份，落在 rootDir 下。 */
export const BOARD_FILE_NAME = 'board.json'

/**
 * 卡片状态（契约固定，顺序即看板列顺序）。
 * todo → assigned → doing → review → done，另有 blocked。
 */
export const CARD_STATUSES = Object.freeze(['todo', 'assigned', 'doing', 'review', 'done', 'blocked'])

/** 证据流记录类型：finding/source/artifact/decision/open_question 由工具写入，card_status 由状态机写入。 */
export const RECORD_KINDS = Object.freeze([
  'finding',
  'source',
  'artifact',
  'decision',
  'open_question',
  'card_status',
  'migrated',
])

/** 系统内部写入的 kind：工具层不得伪造（appendRecord 会拒）。 */
const SYSTEM_RECORD_KINDS = Object.freeze(['card_status', 'migrated'])

/** 优先级（P0 最紧急）。 */
export const PRIORITIES = Object.freeze(['P0', 'P1', 'P2', 'P3'])

/** 默认优先级：没指定就是 P2（中间档，不抢占也不沉底）。 */
export const DEFAULT_PRIORITY = 'P2'

/** 角色：master 是主对话，child 是子对话。归属与终态规则按角色分。 */
export const ROLES = Object.freeze(['master', 'child'])

/**
 * 合法转移表：按「当前状态 → 角色 → 允许的后继」。
 *
 * 与地图的对应关系：
 * - todo → assigned（子对话认领自己）/ todo → doing（master 自领，不经 assigned）；
 * - assigned → doing（子对话开工）；
 * - doing → review（final 报告）；
 * - review → done（accept）/ review → doing（rework）/ review → todo（abort）；
 * - 任意非 done 状态 ↔ blocked，解除（blocked → todo）只由 master 定。
 */
const TRANSITIONS = Object.freeze({
  todo: Object.freeze({
    child: Object.freeze(['assigned', 'blocked']),
    master: Object.freeze(['assigned', 'doing', 'blocked']),
  }),
  assigned: Object.freeze({
    // assigned → review 允许：子对话认领后直接交 final 报告也算它的活
    child: Object.freeze(['doing', 'review', 'blocked']),
    master: Object.freeze(['doing', 'blocked', 'todo']),
  }),
  doing: Object.freeze({
    child: Object.freeze(['review', 'blocked']),
    master: Object.freeze(['review', 'blocked', 'done']),
  }),
  review: Object.freeze({
    child: Object.freeze([]),
    master: Object.freeze(['done', 'doing', 'todo', 'blocked']),
  }),
  blocked: Object.freeze({
    child: Object.freeze([]),
    master: Object.freeze(['todo']),
  }),
  done: Object.freeze({
    child: Object.freeze([]),
    master: Object.freeze([]),
  }),
})

/** 状态中文说明：错误文案与 UI 都读它，避免各处自己写一套。 */
export const STATUS_LABELS = Object.freeze({
  todo: '待认领',
  assigned: '已认领',
  doing: '开工中',
  review: '待验收',
  done: '已完成',
  blocked: '阻塞',
})

/** CAS 冲突：rev 缺失或过期。冲突不写盘，调用方按 currentRev 重读卡片后重试。 */
export class BoardConflictError extends Error {
  /**
   * @param {string} message 可读中文文案
   * @param {{cardId: string, currentRev: number}} details 最新 rev
   */
  constructor(message, details) {
    super(message)
    this.name = 'BoardConflictError'
    /** @type {string} */
    this.cardId = details.cardId
    /** @type {number} 重试时作为 rev 使用 */
    this.currentRev = details.currentRev
  }
}

/** 配额耗尽：抛错而不是静默丢弃，逼调用方先验收/归档。 */
export class BoardFullError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message)
    this.name = 'BoardFullError'
  }
}

/** 状态机 / 归属 / 卡不存在等「调用方必须改」的失败。 */
export class BoardRuleError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message)
    this.name = 'BoardRuleError'
  }
}

/** 盘上 board.json 无法解析：宁可报错也不要静默清空看板。 */
export class BoardCorruptError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message)
    this.name = 'BoardCorruptError'
  }
}

/** 默认 IO：测试可注入替身来模拟「写一半被打断」。 */
const DEFAULT_IO = Object.freeze({ readFile, writeFile, rename, mkdir })

/** @param {unknown} value @returns {boolean} */
function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0
}

/**
 * 校验并归一化 actor。
 * @param {unknown} actor
 * @param {string} where 出错位置（文案用）
 * @returns {{sessionId: string, name: string, role: 'master'|'child'}}
 */
function requireActor(actor, where) {
  if (!actor || typeof actor !== 'object' || Array.isArray(actor)) {
    throw new BoardRuleError(where + ' 需要 actor 对象（{ sessionId, name, role }）')
  }
  const raw = /** @type {any} */ (actor)
  if (typeof raw.sessionId !== 'string' || raw.sessionId === '') {
    throw new BoardRuleError(where + ' 的 actor.sessionId 必须是非空字符串')
  }
  if (!ROLES.includes(raw.role)) {
    throw new BoardRuleError(where + ' 的 actor.role 只能是 ' + ROLES.join(' / ') + '，实际收到 ' + JSON.stringify(raw.role))
  }
  return {
    sessionId: raw.sessionId,
    name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : raw.sessionId,
    role: raw.role,
  }
}

/** @param {unknown} value @returns {boolean} */
function isAssignee(value) {
  return value !== null && typeof value === 'object' && typeof (/** @type {any} */ (value).sessionId) === 'string'
}

/**
 * 合法后继的展示文案：错误里必须列出来（票面验收第 2 条）。
 * @param {string} status
 * @param {'master'|'child'} role
 * @returns {string[]}
 */
function successorsFor(status, role) {
  const row = TRANSITIONS[status]
  if (!row) return []
  /** @type {string[]} */
  const out = [...row[role]]
  if (!out.includes('blocked') && status !== 'blocked') out.push('blocked')
  return out
}

/** @param {string[]} list @returns {string} */
function joinList(list) {
  return list.length === 0 ? '（无）' : list.join(' / ')
}

/**
 * 共享看板：一个 root 会话一份 board.json。
 *
 * 构造时不读盘：首次操作才懒加载。读到的坏文件直接抛 BoardCorruptError，
 * **不会**静默重建 —— 看板是唯一事实来源，清空等于丢数据。
 */
export class Board {
  /** @type {string} */
  #dir
  /** @type {string} */
  #path
  /** @type {number} */
  #maxCards
  /** @type {number} */
  #maxRecords
  /** @type {() => number} */
  #now
  /** @type {typeof DEFAULT_IO} 可注入 IO（模拟写入中断） */
  #io
  /** @type {Promise<void>|null} */
  #loaded = null
  /** @type {Promise<unknown>} */
  #queue = Promise.resolve()
  /** @type {number} 临时文件序号（同进程内唯一） */
  #tempSeq = 0
  /** @type {{version: number, headSeq: number, cards: any[], records: any[]}} 内存中的已提交状态 */
  #state = { version: BOARD_VERSION, headSeq: 0, cards: [], records: [] }
  /** @type {Map<string, any>} */
  #byId = new Map()

  /**
   * @param {{
   *   dir: string,
   *   maxCards?: number,
   *   maxRecords?: number,
   *   now?: () => number,
   *   io?: Partial<typeof DEFAULT_IO>,
   * }} options
   */
  constructor({ dir, maxCards = 32, maxRecords = 256, now = () => Date.now(), io = {} } = {}) {
    if (typeof dir !== 'string' || dir.trim() === '') {
      throw new TypeError('Board 需要一个非空的 dir')
    }
    if (!isNonNegativeInteger(maxCards) || maxCards < 1) throw new TypeError('maxCards 必须是 >= 1 的安全整数')
    if (!isNonNegativeInteger(maxRecords) || maxRecords < 1) throw new TypeError('maxRecords 必须是 >= 1 的安全整数')
    this.#dir = dir
    this.#path = join(dir, BOARD_FILE_NAME)
    this.#maxCards = maxCards
    this.#maxRecords = maxRecords
    this.#now = now
    this.#io = { ...DEFAULT_IO, ...io }
    /** 首次加载时读到的坏数据说明（诊断用）。 @type {string|null} */
    this.skipped = null
  }

  /** 看板文件绝对路径（迁移脚本与诊断用）。 @returns {string} */
  get file() {
    return this.#path
  }

  /**
   * 看板头：卡数、记录数、单调递增的 revision。
   * @returns {Promise<{version: number, revision: number, headSeq: number, cards: number, records: number}>}
   */
  async head() {
    await this.#load()
    return {
      version: this.#state.version,
      revision: this.#state.headSeq,
      headSeq: this.#state.headSeq,
      cards: this.#state.cards.length,
      records: this.#state.records.length,
    }
  }

  /**
   * 新建一张卡（默认 todo）。卡 id 即 taskId（t1..tN），不复用已用过的号。
   *
   * @param {{
   *   title: string, body?: string, priority?: string, assignee?: any, tags?: string[],
   *   refs?: string[], id?: string, actor: any,
   * }} input
   * @returns {Promise<any>} 新卡（深拷贝）
   */
  async createCard(input = {}) {
    const actor = requireActor(input.actor, 'createCard')
    const title = typeof input.title === 'string' ? input.title.trim() : ''
    if (title === '') throw new BoardRuleError('createCard 需要非空 title')
    const priority = input.priority === undefined ? DEFAULT_PRIORITY : String(input.priority)
    if (!PRIORITIES.includes(priority)) {
      throw new BoardRuleError('priority 只能是 ' + PRIORITIES.join(' / ') + '，实际收到 ' + JSON.stringify(input.priority))
    }
    /** @type {any} */
    let assignee = null
    if (input.assignee !== undefined && input.assignee !== null) {
      if (!isAssignee(input.assignee)) throw new BoardRuleError('assignee 必须是 { sessionId, name } 或 null')
      assignee = {
        sessionId: String(input.assignee.sessionId),
        name: String(input.assignee.name ?? input.assignee.sessionId),
      }
    }

    return this.#enqueue(async () => {
      await this.#load()
      if (this.#state.cards.length >= this.#maxCards) {
        throw new BoardFullError(
          '看板卡已达上限 ' + this.#maxCards + '（当前 ' + this.#state.cards.length + ' 张）：先验收/归档既有卡再建新卡',
        )
      }
      const id = input.id === undefined ? this.#nextCardId() : String(input.id)
      if (this.#byId.has(id)) throw new BoardRuleError('看板已有卡 ' + id + '：卡 id 不可复用')
      const ts = this.#now()
      /** @type {any} */
      const card = {
        id,
        rev: 1,
        status: 'todo',
        priority,
        assignee,
        title,
        body: typeof input.body === 'string' ? input.body : '',
        tags: Array.isArray(input.tags) ? input.tags.map(String) : [],
        refs: Array.isArray(input.refs) ? input.refs.map(String) : [],
        author: { sessionId: actor.sessionId, name: actor.name },
        // 派发时预先知道的子会话 id：只给指挥台开 tab 用，**不是**归属（归属看 assignee）
        childSessionId: typeof input.childSessionId === 'string' ? input.childSessionId : null,
        createdAt: ts,
        updatedAt: ts,
      }
      await this.#commit((next) => {
        next.cards.push(card)
      })
      return structuredClone(card)
    })
  }

  /**
   * 单卡明细：卡 + 它名下的全部 records（按 seq 升序）。
   * @param {string} cardId
   * @returns {Promise<{card: any, records: any[]}>}
   */
  async getCard(cardId) {
    await this.#load()
    const card = this.#byId.get(String(cardId))
    if (card === undefined) throw new BoardRuleError('看板没有卡 ' + JSON.stringify(cardId))
    const records = this.#state.records.filter((record) => record.cardId === card.id)
    return { card: structuredClone(card), records: records.map((record) => structuredClone(record)) }
  }

  /**
   * 摘要视图（默认读法）：只返回卡字段，**不含** records 正文。
   *
   * @param {{status?: string|string[], assignee?: string, priority?: string, limit?: number}} [filter]
   * @returns {Promise<any[]>}
   */
  async listCards(filter = {}) {
    await this.#load()
    /** @type {string[]} */
    const statuses = filter.status === undefined
      ? []
      : Array.isArray(filter.status) ? filter.status.map(String) : [String(filter.status)]
    const limit = isNonNegativeInteger(filter.limit) && filter.limit > 0 ? filter.limit : this.#maxCards
    /** @type {any[]} */
    const out = []
    for (const card of this.#state.cards) {
      if (statuses.length > 0 && !statuses.includes(card.status)) continue
      if (filter.assignee !== undefined) {
        if (card.assignee === null || card.assignee.sessionId !== String(filter.assignee)) continue
      }
      if (filter.priority !== undefined && card.priority !== String(filter.priority)) continue
      out.push(structuredClone(card))
      if (out.length >= limit) break
    }
    return out
  }

  /**
   * 改卡（唯一写入口）。rev 必填且必须等于当前 rev，否则 CAS 拒绝并回带最新 rev。
   *
   * 一次调用可以同时改状态与字段；状态变更会额外追加一条 card_status 记录。
   *
   * @param {{
   *   cardId: string, rev: number, actor: any,
   *   status?: string, assignee?: any, priority?: string, title?: string, body?: string,
   *   tags?: string[], reason?: string,
   * }} input
   * @returns {Promise<{card: any, record: any|null}>}
   */
  async updateCard(input = {}) {
    const actor = requireActor(input.actor, 'updateCard')
    const cardId = String(input.cardId ?? '')
    if (cardId === '') throw new BoardRuleError('updateCard 需要 cardId')

    return this.#enqueue(async () => {
      await this.#load()
      const current = this.#byId.get(cardId)
      if (current === undefined) throw new BoardRuleError('看板没有卡 ' + JSON.stringify(cardId))

      // 1. CAS：无 rev 或 rev 过期一律拒，并且把最新 rev 带回（票面验收第 1 条）
      if (!Number.isSafeInteger(input.rev)) {
        throw new BoardConflictError(
          '改卡 ' + cardId + ' 必须带 rev（当前 rev=' + current.rev + '）；请重新读卡后重试',
          { cardId, currentRev: current.rev },
        )
      }
      if (input.rev !== current.rev) {
        throw new BoardConflictError(
          '看板 CAS 冲突：卡 ' + cardId + ' 的 rev=' + current.rev + '，请求用的是 ' + input.rev + '；请重读该卡后重试',
          { cardId, currentRev: current.rev },
        )
      }

      const target = this.#applyPatch(current, input, actor)
      const now = this.#now()
      /** @type {any} */
      let statusRecord = null
      if (target.status !== current.status) {
        if (this.#state.records.length >= this.#maxRecords) {
          throw new BoardFullError(
            '证据流已达上限 ' + this.#maxRecords + ' 条：状态变更必须留审计，先归档再改卡',
          )
        }
        statusRecord = this.#buildRecord({
          cardId,
          kind: 'card_status',
          title: current.status + ' → ' + target.status,
          body: typeof input.reason === 'string' ? input.reason : '',
          actor,
          from: current.status,
          to: target.status,
          reason: typeof input.reason === 'string' ? input.reason : '',
        })
      }
      target.rev = current.rev + 1
      target.updatedAt = now

      await this.#commit((next) => {
        const index = next.cards.findIndex((card) => card.id === cardId)
        next.cards[index] = target
        if (statusRecord !== null) {
          next.records.push(statusRecord)
          next.headSeq = statusRecord.seq
        }
      })
      return {
        card: structuredClone(target),
        record: statusRecord === null ? null : structuredClone(statusRecord),
      }
    })
  }

  /**
   * 追加一条证据记录（外键 cardId 必须存在）。
   *
   * @param {{
   *   cardId: string, kind: string, title: string, body?: string, refs?: string[],
   *   artifact?: any, tags?: string[], actor: any,
   * }} input
   * @returns {Promise<any>}
   */
  async appendRecord(input = {}) {
    const actor = requireActor(input.actor, 'appendRecord')
    const cardId = String(input.cardId ?? '')
    if (cardId === '') throw new BoardRuleError('appendRecord 需要 cardId')
    const kind = String(input.kind ?? '')
    if (!RECORD_KINDS.includes(kind) || SYSTEM_RECORD_KINDS.includes(kind)) {
      const allowed = RECORD_KINDS.filter((item) => !SYSTEM_RECORD_KINDS.includes(item))
      throw new BoardRuleError('记录 kind 只能是 ' + allowed.join(' / ') + '，实际收到 ' + JSON.stringify(input.kind))
    }
    const title = typeof input.title === 'string' ? input.title.trim() : ''
    if (title === '') throw new BoardRuleError('appendRecord 需要非空 title')

    return this.#enqueue(async () => {
      await this.#load()
      if (!this.#byId.has(cardId)) {
        throw new BoardRuleError('appendRecord 的 cardId 不存在：' + cardId + '（记录必须挂在已有卡上）')
      }
      if (this.#state.records.length >= this.#maxRecords) {
        throw new BoardFullError(
          '证据流已达上限 ' + this.#maxRecords + ' 条：先归档再追加（当前 ' + this.#state.records.length + ' 条）',
        )
      }
      const record = this.#buildRecord({
        cardId,
        kind,
        title,
        body: typeof input.body === 'string' ? input.body : '',
        refs: Array.isArray(input.refs) ? input.refs.map(String) : [],
        artifact: input.artifact ?? null,
        tags: Array.isArray(input.tags) ? input.tags.map(String) : [],
        actor,
      })
      await this.#commit((next) => {
        next.records.push(record)
        next.headSeq = record.seq
      })
      return structuredClone(record)
    })
  }

  /**
   * 丢弃一张**刚建、还没被碰过**的卡（派发失败回滚用）。
   *
   * 只用三个条件全满足才允许删：master 发起、卡还是 todo、卡名下没有任何记录。
   * 一旦子对话认领或写过证据，这张卡就有审计价值了，只能走 blocked / done，不能删。
   *
   * @param {string} cardId
   * @param {{actor: any, reason?: string}} options
   * @returns {Promise<{cardId: string, discarded: boolean}>}
   */
  async discardCard(cardId, { actor, reason = '' } = {}) {
    const who = requireActor(actor, 'discardCard')
    if (who.role !== 'master') throw new BoardRuleError('只有 master 能丢弃卡片')

    return this.#enqueue(async () => {
      await this.#load()
      const card = this.#byId.get(String(cardId))
      if (card === undefined) throw new BoardRuleError('看板没有卡 ' + JSON.stringify(cardId))
      if (card.status !== 'todo') {
        throw new BoardRuleError('卡 ' + card.id + ' 已是 ' + card.status + '：有审计价值的卡不能丢，请用 blocked / done')
      }
      if (this.#state.records.some((record) => record.cardId === card.id)) {
        throw new BoardRuleError('卡 ' + card.id + ' 名下已有记录：不能丢弃（回滚只针对刚建、没人碰过的卡）')
      }
      await this.#commit((next) => {
        next.cards = next.cards.filter((item) => item.id !== card.id)
      })
      return { cardId: card.id, discarded: true, reason }
    })
  }

  /**
   * 查证据流：可按卡、按 kind、按 tag、按 seq 游标过滤。
   *
   * @param {{cardId?: string, kind?: string, tag?: string, sinceSeq?: number, limit?: number}} [filter]
   * @returns {Promise<any[]>}
   */
  async queryRecords(filter = {}) {
    await this.#load()
    const sinceSeq = isNonNegativeInteger(filter.sinceSeq) ? filter.sinceSeq : 0
    const limit = isNonNegativeInteger(filter.limit) && filter.limit > 0 ? filter.limit : this.#maxRecords
    /** @type {any[]} */
    const out = []
    for (const record of this.#state.records) {
      if (record.seq <= sinceSeq) continue
      if (filter.cardId !== undefined && record.cardId !== String(filter.cardId)) continue
      if (filter.kind !== undefined && record.kind !== String(filter.kind)) continue
      if (filter.tag !== undefined && !record.tags.includes(String(filter.tag))) continue
      out.push(structuredClone(record))
      if (out.length >= limit) break
    }
    return out
  }

  // -------------------------------------------------------------------------
  // 内部：校验与落盘
  // -------------------------------------------------------------------------

  /**
   * 把 patch 应用到卡的副本上，并按状态机 / 归属规则校验。
   * @param {any} current
   * @param {any} input
   * @param {any} actor
   * @returns {any} 新卡（未提交）
   */
  #applyPatch(current, input, actor) {
    /** @type {any} */
    const next = structuredClone(current)

    // 1. 归属前置：子对话只能碰自己名下的卡（认领是唯一例外：todo 且尚未被认领）。
    //    这一条必须在状态机之前判，否则「状态没变地重发一次 assigned」就能绕过归属检查。
    if (actor.role === 'child') {
      const claiming = current.status === 'todo' && input.status === 'assigned'
      const mine = current.assignee !== null && current.assignee.sessionId === actor.sessionId
      if (claiming && current.assignee !== null && current.assignee.sessionId !== actor.sessionId) {
        throw new BoardRuleError(
          '卡 ' + current.id + ' 已被 ' + current.assignee.name +
            ' 认领，不能再认领；可用 master_board op=query 看板上还有哪些 todo',
        )
      }
      if (!claiming && !mine) {
        throw new BoardRuleError(
          '卡 ' + current.id + ' 不在你名下（当前认领者：' +
            (current.assignee === null ? '无' : current.assignee.name) + '），子对话只能翻自己名下的卡',
        )
      }
    }

    // 2. 终态只能 master 置（票面验收第 3 条）。先于转移表判，错误文案才指向正确动作
    if (input.status === 'done' && actor.role !== 'master') {
      throw new BoardRuleError('done 只能由 master 置：子对话交回结果请用 master_report(final:true) 推到 review')
    }

    // 3. 状态机：目标状态必须在该角色的合法后继里
    if (input.status !== undefined && input.status !== current.status) {
      const status = String(input.status)
      if (!CARD_STATUSES.includes(status)) {
        throw new BoardRuleError('未知状态 ' + JSON.stringify(input.status) + '；可选：' + CARD_STATUSES.join(' / '))
      }
      const legal = successorsFor(current.status, actor.role)
      if (!legal.includes(status)) {
        throw new BoardRuleError(
          '非法状态转移：' + current.status + '（' + STATUS_LABELS[current.status] + '）→ ' +
            status + '（' + STATUS_LABELS[status] + '）；' + current.status + ' 对 ' +
            actor.role + ' 的合法后继：' + joinList(legal),
        )
      }
      // 4. 认领：把认领者写进 assignee；todo → doing 只允许 master 自领
      if (status === 'assigned') {
        if (input.assignee !== undefined && input.assignee !== null) {
          if (!isAssignee(input.assignee)) throw new BoardRuleError('assignee 必须是 { sessionId, name } 或 null')
          next.assignee = {
            sessionId: String(input.assignee.sessionId),
            name: String(input.assignee.name ?? input.assignee.sessionId),
          }
        } else if (next.assignee === null) {
          next.assignee = { sessionId: actor.sessionId, name: actor.name }
        }
      }
      if (status === 'doing' && current.status === 'todo') {
        if (actor.role !== 'master') {
          throw new BoardRuleError('todo 直接进 doing 只有 master 自领才允许；子对话请先认领（todo → assigned）')
        }
        next.assignee = { sessionId: actor.sessionId, name: actor.name }
      }
      next.status = status
    } else if (input.status !== undefined) {
      // 状态没变但显式传了：不算转移，但要确认值合法
      if (!CARD_STATUSES.includes(String(input.status))) {
        throw new BoardRuleError('未知状态 ' + JSON.stringify(input.status))
      }
    }

    // 5. 其余字段
    if (input.priority !== undefined) {
      const priority = String(input.priority)
      if (!PRIORITIES.includes(priority)) {
        throw new BoardRuleError('priority 只能是 ' + PRIORITIES.join(' / ') + '，实际收到 ' + JSON.stringify(input.priority))
      }
      next.priority = priority
    }
    if (input.title !== undefined) {
      const title = typeof input.title === 'string' ? input.title.trim() : ''
      if (title === '') throw new BoardRuleError('title 不能改成空字符串')
      next.title = title
    }
    if (input.body !== undefined) next.body = String(input.body)
    if (input.childSessionId !== undefined) {
      if (actor.role !== 'master') throw new BoardRuleError('只有 master 能登记子会话 id')
      next.childSessionId = input.childSessionId === null ? null : String(input.childSessionId)
    }
    if (input.tags !== undefined) {
      if (!Array.isArray(input.tags)) throw new BoardRuleError('tags 必须是数组')
      next.tags = input.tags.map(String)
    }
    // 改派 / 清空认领者：只有 master 能做，且可以与状态变更同时发生
    // （accept 的 abort 要「回 todo + 摘掉认领者」，才能被重新派发）。
    // status=assigned 时上面的认领分支已经写过 assignee，这里跳过避免覆盖。
    if (input.assignee !== undefined && input.status !== 'assigned') {
      if (actor.role !== 'master') throw new BoardRuleError('只有 master 能改派卡片')
      if (input.assignee === null) {
        next.assignee = null
      } else {
        if (!isAssignee(input.assignee)) throw new BoardRuleError('assignee 必须是 { sessionId, name } 或 null')
        next.assignee = {
          sessionId: String(input.assignee.sessionId),
          name: String(input.assignee.name ?? input.assignee.sessionId),
        }
      }
    }
    return next
  }

  /**
   * 造一条记录（不入队；seq 用下一号）。
   * @param {Record<string, any>} fields
   * @returns {any}
   */
  #buildRecord(fields) {
    const seq = this.#state.headSeq + 1
    /** @type {any} */
    const record = {
      id: 'r' + seq,
      seq,
      ts: this.#now(),
      cardId: fields.cardId,
      kind: fields.kind,
      author: { sessionId: fields.actor.sessionId, name: fields.actor.name },
      actor: { sessionId: fields.actor.sessionId, name: fields.actor.name, role: fields.actor.role },
      title: fields.title,
      body: fields.body ?? '',
      refs: fields.refs ?? [],
      artifact: fields.artifact ?? null,
      tags: fields.tags ?? [],
    }
    // card_status 专用字段：from/to/actor/reason（审计要能直接查）
    if (fields.kind === 'card_status') {
      record.from = fields.from
      record.to = fields.to
      record.reason = fields.reason ?? ''
    }
    return record
  }

  /** 下一个可用卡号：t1..tN 里最大的 +1（不复用废号，避免历史记录串卡）。 */
  #nextCardId() {
    let max = 0
    for (const card of this.#state.cards) {
      const match = /^t([0-9]+)$/.exec(card.id)
      if (match !== null) max = Math.max(max, Number(match[1]))
    }
    return 't' + (max + 1)
  }

  /**
   * 提交一次变更：先在内存副本上改，写盘成功后才替换内存状态。
   * 写盘走「临时文件 + rename」：中途失败时 board.json 仍是上一份完整内容。
   *
   * @param {(next: {version: number, headSeq: number, cards: any[], records: any[]}) => void} mutate
   * @returns {Promise<void>}
   */
  async #commit(mutate) {
    /** @type {any} */
    const next = {
      version: this.#state.version,
      headSeq: this.#state.headSeq,
      cards: this.#state.cards.map((card) => structuredClone(card)),
      records: this.#state.records.map((record) => structuredClone(record)),
    }
    mutate(next)
    await this.#persist(next)
    this.#state = next
    this.#byId = new Map(next.cards.map((card) => [card.id, card]))
  }

  /**
   * 原子落盘：先写临时文件再 rename。rename 在 Windows 上是原子的覆盖。
   * @param {any} state
   */
  async #persist(state) {
    await this.#io.mkdir(this.#dir, { recursive: true })
    const text = JSON.stringify(state, null, 2) + String.fromCharCode(10)
    this.#tempSeq += 1
    const temp = this.#path + '.tmp-' + process.pid + '-' + this.#tempSeq
    await this.#io.writeFile(temp, text, 'utf8')
    await this.#io.rename(temp, this.#path)
  }

  /** 懒加载：首次操作把 board.json 读进内存索引。 */
  async #load() {
    this.#loaded ??= this.#read()
    return this.#loaded
  }

  /** @returns {Promise<void>} */
  async #read() {
    await this.#io.mkdir(this.#dir, { recursive: true })
    let text
    try {
      text = await this.#io.readFile(this.#path, 'utf8')
    } catch (error) {
      if (/** @type {{code?: string}} */ (error).code === 'ENOENT') return
      throw error
    }
    /** @type {any} */
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      throw new BoardCorruptError(
        '看板文件 ' + this.#path + ' 不是合法 JSON（' + String((error && error.message) || error) +
          '）：拒绝重建看板，请先修复或从备份恢复',
      )
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.cards) || !Array.isArray(parsed.records)) {
      throw new BoardCorruptError('看板文件 ' + this.#path + ' 结构不对（需要 { cards: [], records: [] }）')
    }
    this.#state = {
      version: isNonNegativeInteger(parsed.version) ? parsed.version : BOARD_VERSION,
      headSeq: isNonNegativeInteger(parsed.headSeq) ? parsed.headSeq : 0,
      cards: parsed.cards,
      records: parsed.records,
    }
    this.#byId = new Map(this.#state.cards.map((card) => [card.id, card]))
    if (this.#state.headSeq === 0 && this.#state.records.length > 0) {
      this.#state.headSeq = this.#state.records.reduce((max, record) => Math.max(max, record.seq ?? 0), 0)
    }
  }

  /**
   * 进程内写入串行化：同一 Board 实例的写操作排队执行，避免抢同一个 seq / rev。
   * @template T
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  #enqueue(task) {
    const run = this.#queue.then(task, task)
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}
