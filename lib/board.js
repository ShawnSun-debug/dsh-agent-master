/**
 * dsh-agent-master — 共享黑板（append-only JSONL）。
 *
 * 一个 root 会话一块黑板：进程内写入用 promise 队列串行化，跨进程只靠 expectedSeq
 * CAS 兜底（冲突时带最新 seq 抛出，调用方重读后重试）。去重键 = sha256(title + NUL + body)，
 * 重复内容不占 seq，避免并行子对话刷爆条目预算。
 *
 * @module dsh-agent-master/board
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

/**
 * 黑板记录种类：契约固定，新增种类需同步 projections 与 UI。
 */
export const KINDS = Object.freeze(['task', 'finding', 'source', 'artifact', 'decision', 'open_question'])

/**
 * 记录作者：会话 id 与可读名（子对话的名字用于 UI 与审计）。
 *
 * @typedef {object} BoardAuthor
 * @property {string|null} sessionId
 * @property {string|null} name
 */

/**
 * 落盘产物引用：路径 + 校验信息 + 版本，正文不进黑板。
 *
 * @typedef {object} BoardArtifact
 * @property {string} path
 * @property {number} [bytes]
 * @property {string} [sha256]
 * @property {number} [version]
 */

/**
 * 黑板记录（字段顺序即写盘顺序）。
 *
 * @typedef {object} BoardRecord
 * @property {string} id 形如 'b1'
 * @property {number} seq 从 1 递增
 * @property {number} ts 毫秒时间戳
 * @property {string} scope session | root | user | temp
 * @property {BoardAuthor} author
 * @property {'task'|'finding'|'source'|'artifact'|'decision'|'open_question'} kind
 * @property {string} title
 * @property {string|null} body
 * @property {string[]} refs
 * @property {BoardArtifact|null} artifact
 * @property {string[]} tags
 */

/** title 与 body 之间的分隔符：避免 '结'+'论内容' 与 '结论'+'内容' 撞去重键。 */
const DEDUPE_SEPARATOR = '\u0000'

/**
 * @param {string} title
 * @param {string|null} body
 * @returns {string}
 */
function dedupeKey(title, body) {
  return createHash('sha256')
    .update(String(title) + DEDUPE_SEPARATOR + String(body ?? ''), 'utf8')
    .digest('hex')
}

/**
 * 返回给调用方的记录一律深拷贝：外部改字段不会污染内存索引。
 *
 * @param {BoardRecord} record
 * @returns {BoardRecord}
 */
function cloneRecord(record) {
  return structuredClone(record)
}

/**
 * CAS 冲突：expectedSeq 与当前 head.seq 不一致。
 * 冲突不写盘；调用方按 error.currentSeq 重读后重试。
 */
export class BoardConflictError extends Error {
  /**
   * @param {string} message 可读中文文案
   * @param {number} currentSeq 冲突时的最新 seq
   */
  constructor(message, currentSeq) {
    super(message)
    this.name = 'BoardConflictError'
    /** @type {number} 重试时作为 expectedSeq 使用 */
    this.currentSeq = currentSeq
  }
}

/**
 * 条目预算耗尽：抛错而不是静默丢弃，逼调用方先查询或归档。
 */
export class BoardFullError extends Error {
  /** @param {string} message 可读中文文案 */
  constructor(message) {
    super(message)
    this.name = 'BoardFullError'
  }
}

/**
 * 共享黑板：`<dir>/board.jsonl`，一行一条 JSON 记录。
 *
 * 构造时不读盘；首次操作才懒加载并把整块黑板重建进内存索引，
 * 坏行跳过并计入 `skipped`（不因一行损坏让整块黑板不可用）。
 */
export class Board {
  /** @type {string} */
  #dir
  /** @type {string} */
  #path
  /** @type {number} */
  #maxEntries
  /** @type {() => number} */
  #now
  /** @type {Promise<void>|null} */
  #loaded = null
  /** @type {Promise<unknown>} */
  #queue = Promise.resolve()
  /** @type {BoardRecord[]} 按写盘顺序保存，seq 升序 */
  #records = []
  /** @type {Map<string, BoardRecord>} */
  #byId = new Map()
  /** @type {Map<string, BoardRecord>} */
  #byDedupe = new Map()
  /** @type {number} */
  #headSeq = 0

  /**
   * @param {{ dir: string, maxEntries?: number, now?: () => number }} options
   *   dir 是 root 目录（由 config.rootDir 推导），board.jsonl 固定落在其下；
   *   maxEntries 是条目预算；now 仅供测试注入时间。
   */
  constructor({ dir, maxEntries = 256, now = () => Date.now() }) {
    this.#dir = dir
    this.#path = join(dir, 'board.jsonl')
    this.#maxEntries = maxEntries
    this.#now = now
    /** 启动重建时跳过的坏行数量。 @type {number} */
    this.skipped = 0
  }

  /** 当前黑板头：空板 seq=0。 @returns {Promise<{ seq: number }>} */
  async head() {
    await this.#load()
    return { seq: this.#headSeq }
  }

  /**
   * 追加一条记录。
   *
   * @param {{
   *   scope?: string,
   *   author?: BoardAuthor,
   *   kind: 'task'|'finding'|'source'|'artifact'|'decision'|'open_question',
   *   title: string,
   *   body?: string|null,
   *   refs?: string[],
   *   artifact?: BoardArtifact|null,
   *   tags?: string[],
   *   expectedSeq?: number|null,
   * }} input
   * @returns {Promise<{ record: BoardRecord, headSeq: number, deduped: boolean }>}
   */
  async append(input = {}) {
    const {
      scope = 'root',
      author,
      kind,
      title,
      body = null,
      refs = [],
      artifact = null,
      tags = [],
      expectedSeq = null,
    } = input

    // 参数错误在入队前抛出：坏参数不该占用队列，也不该等一次磁盘读。
    if (typeof title !== 'string' || title.length === 0) throw new TypeError('黑板记录需要非空 title')
    if (!KINDS.includes(kind)) {
      throw new TypeError('未知的黑板记录 kind：' + String(kind) + '；可选：' + KINDS.join(' / '))
    }
    if (body !== null && typeof body !== 'string') throw new TypeError('黑板记录 body 必须是字符串或 null')
    const recordAuthor = { sessionId: author?.sessionId ?? null, name: author?.name ?? null }

    return this.#enqueue(async () => {
      await this.#load()
      const currentSeq = this.#headSeq

      if (expectedSeq !== null && expectedSeq !== currentSeq) {
        throw new BoardConflictError(
          '黑板 CAS 冲突：expectedSeq=' + expectedSeq + '，当前 head.seq=' + currentSeq + '；请重新 head() 后按最新 seq 重试',
          currentSeq,
        )
      }

      const key = dedupeKey(title, body)
      const existing = this.#byDedupe.get(key)
      if (existing !== undefined) {
        return { record: cloneRecord(existing), headSeq: currentSeq, deduped: true }
      }

      const seq = currentSeq + 1
      if (seq > this.#maxEntries) {
        throw new BoardFullError(
          '黑板条目已达上限 ' + this.#maxEntries + '（当前 head.seq=' + currentSeq + '），拒绝追加；' +
            '请先用 query({ sinceSeq: 0, limit: ' + this.#maxEntries + ' }) 读取既有记录，或调大 boardMaxEntries 配置',
        )
      }

      const record = {
        id: 'b' + seq,
        seq,
        ts: this.#now(),
        scope,
        author: recordAuthor,
        kind,
        title,
        body,
        refs: [...refs],
        artifact,
        tags: [...tags],
      }

      await appendFile(this.#path, JSON.stringify(record) + '\n', 'utf8')
      this.#records.push(record)
      this.#byId.set(record.id, record)
      this.#byDedupe.set(key, record)
      this.#headSeq = seq

      return { record: cloneRecord(record), headSeq: seq, deduped: false }
    })
  }

  /**
   * 按 seq 升序查询；sinceSeq 用于 CAS 冲突后"从上次看到的地方继续读"。
   *
   * @param {{ kind?: string, tag?: string, sinceSeq?: number, limit?: number }} [filter]
   * @returns {Promise<BoardRecord[]>}
   */
  async query({ kind, tag, sinceSeq = 0, limit = 100 } = {}) {
    await this.#load()
    /** @type {BoardRecord[]} */
    const out = []
    for (const record of this.#records) {
      if (record.seq <= sinceSeq) continue
      if (kind !== undefined && record.kind !== kind) continue
      if (tag !== undefined && !record.tags.includes(tag)) continue
      out.push(cloneRecord(record))
      if (out.length >= limit) break
    }
    return out
  }

  /**
   * @param {string} id
   * @returns {Promise<BoardRecord|null>}
   */
  async get(id) {
    await this.#load()
    const record = this.#byId.get(id)
    return record === undefined ? null : cloneRecord(record)
  }

  /**
   * 懒加载：首次操作把 board.jsonl 重建进内存索引。
   *
   * @returns {Promise<void>}
   */
  async #load() {
    this.#loaded ??= this.#readIndex()
    return this.#loaded
  }

  /** @returns {Promise<void>} */
  async #readIndex() {
    await mkdir(this.#dir, { recursive: true })
    let text
    try {
      text = await readFile(this.#path, 'utf8')
    } catch (error) {
      if (/** @type {{ code?: string }} */ (error).code === 'ENOENT') return
      throw error
    }
    for (const line of text.split('\n')) {
      if (line.length === 0) continue
      /** @type {BoardRecord} */
      let record
      try {
        record = JSON.parse(line)
      } catch {
        this.skipped += 1
        continue
      }
      if (
        record === null ||
        typeof record !== 'object' ||
        typeof record.seq !== 'number' ||
        typeof record.id !== 'string' ||
        !Array.isArray(record.tags)
      ) {
        this.skipped += 1
        continue
      }
      this.#records.push(record)
      this.#byId.set(record.id, record)
      const key = dedupeKey(record.title, record.body ?? null)
      if (!this.#byDedupe.has(key)) this.#byDedupe.set(key, record)
      if (record.seq > this.#headSeq) this.#headSeq = record.seq
    }
  }

  /**
   * 进程内写入串行化：同一 Board 实例的 append 排队执行，避免并发抢同一个 seq。
   *
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
