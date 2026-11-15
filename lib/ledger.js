/**
 * dsh-agent-master — 约束台账（append-only、版本化、可离线校验）。
 *
 * 台账是唯一事实来源：摘要与 digest 可以压缩正文，但不能改写约束 —— 新内容只能
 * 往 ledger.jsonl 追加新版本，旧版本永远留在盘上。同 taskId 内容相同（hash 相等）
 * 不追加；每次写入前确认磁盘仍是"内存中已确认行的前缀"，因此覆盖、删行、删文件
 * 都会立刻变成 LedgerError，而不是被静默重建。
 *
 * @module dsh-agent-master/ledger
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

/** 台账记录结构版本：冷恢复时按记录上的版本决定能否继续校验。 */
export const LEDGER_SCHEMA_VERSION = 1

/**
 * 台账条目：一个 taskId 一版，version 从 1 递增。
 *
 * @typedef {object} LedgerEntry
 * @property {string} taskId
 * @property {number} version
 * @property {number} ts
 * @property {number} schemaVersion
 * @property {{ text: string, needsEvidence: boolean }[]} constraints
 * @property {string[]} acceptance
 * @property {string[]} boundaries
 * @property {string[]} forbidden
 * @property {string} hash
 */

/**
 * 一条违反台账的记录。
 *
 * @typedef {object} LedgerViolation
 * @property {'forbidden'|'boundary'|'constraint'} kind
 * @property {string} text 命中的禁止项 / 越界的产物路径 / 缺证据的约束
 * @property {string} reason 中文可读原因
 */

/** 台账被覆盖、删除或内容不可解析时抛出。 */
export class LedgerError extends Error {
  /** @param {string} message 可读中文文案 */
  constructor(message) {
    super(message)
    this.name = 'LedgerError'
  }
}

/**
 * @param {string} text
 * @returns {string}
 */
function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * 规范化 constraints：字符串与 { text, needsEvidence? } 两种写法统一成对象，并按 text 稳定排序。
 *
 * @param {unknown} input
 * @returns {{ text: string, needsEvidence: boolean }[]}
 */
function normalizeConstraints(input) {
  if (!Array.isArray(input)) throw new LedgerError('constraints 必须是数组')
  const out = input.map((item, index) => {
    if (typeof item === 'string') {
      if (item.length === 0) throw new LedgerError('constraints[' + index + '] 不能为空字符串')
      return { text: item, needsEvidence: false }
    }
    if (item !== null && typeof item === 'object' && typeof item.text === 'string' && item.text.length > 0) {
      return { text: item.text, needsEvidence: item.needsEvidence === true }
    }
    throw new LedgerError('constraints[' + index + '] 必须是字符串或 { text, needsEvidence? }')
  })
  return out.sort((a, b) => {
    if (a.text === b.text) return Number(a.needsEvidence) - Number(b.needsEvidence)
    return a.text < b.text ? -1 : 1
  })
}

/**
 * 规范化 acceptance / boundaries / forbidden：只接受非空字符串，稳定排序。
 *
 * @param {string} field 字段名，用于可修正的错误文案
 * @param {unknown} input
 * @returns {string[]}
 */
function normalizeTextList(field, input) {
  if (!Array.isArray(input)) throw new LedgerError(field + ' 必须是字符串数组')
  return input
    .map((item, index) => {
      if (typeof item !== 'string' || item.length === 0) {
        throw new LedgerError(field + '[' + index + '] 必须是非空字符串')
      }
      return item
    })
    .sort()
}

/**
 * 四组数组的规范形与 hash：hash 只依赖规范形，所以元素顺序不同但内容相同视为同一版本。
 *
 * @param {{ constraints: unknown, acceptance: unknown, boundaries: unknown, forbidden: unknown }} input
 * @returns {{ constraints: { text: string, needsEvidence: boolean }[], acceptance: string[], boundaries: string[], forbidden: string[], hash: string }}
 */
function canonicalize(input) {
  const constraints = normalizeConstraints(input.constraints ?? [])
  const acceptance = normalizeTextList('acceptance', input.acceptance ?? [])
  const boundaries = normalizeTextList('boundaries', input.boundaries ?? [])
  const forbidden = normalizeTextList('forbidden', input.forbidden ?? [])
  const hash = sha256(JSON.stringify([constraints, acceptance, boundaries, forbidden]))
  return { constraints, acceptance, boundaries, forbidden, hash }
}

/**
 * 解析台账里的一行；格式不对说明文件被外部改坏，直接抛错而不是跳过。
 *
 * @param {string} line
 * @param {number} lineNumber 从 1 起
 * @returns {LedgerEntry}
 */
function parseEntry(line, lineNumber) {
  let entry
  try {
    entry = JSON.parse(line)
  } catch {
    throw new LedgerError('台账第 ' + lineNumber + ' 行不是合法 JSON；台账文件已损坏')
  }
  if (
    entry === null ||
    typeof entry !== 'object' ||
    typeof entry.taskId !== 'string' ||
    !Number.isSafeInteger(entry.version) ||
    entry.version < 1 ||
    typeof entry.hash !== 'string'
  ) {
    throw new LedgerError('台账第 ' + lineNumber + ' 行缺少 taskId/version/hash；台账文件已损坏')
  }
  return entry
}

/**
 * 边界前缀归一化：Windows 反斜杠统一成 '/'（黑板与产物路径可能来自不同平台），去掉尾部斜杠。
 *
 * @param {string} value
 * @returns {string}
 */
function normalizePathPrefix(value) {
  const text = String(value).replace(/\\/g, '/')
  let end = text.length
  while (end > 1 && text[end - 1] === '/') end -= 1
  return text.slice(0, end)
}

/**
 * 路径前缀白名单判定：'/a/b' 覆盖 '/a/b' 与 '/a/b/c'，但不覆盖 '/a/bc'。
 *
 * @param {string} path 已归一化
 * @param {string} prefix 已归一化
 * @returns {boolean}
 */
function isUnderPrefix(path, prefix) {
  return path === prefix || path.startsWith(prefix + '/')
}

/**
 * 约束条目可能是未归一化的字符串，也可能是 { text, needsEvidence }。
 *
 * @param {string | { text?: string, needsEvidence?: boolean }} item
 * @returns {{ text: string, needsEvidence: boolean }}
 */
function constraintView(item) {
  if (typeof item === 'string') return { text: item, needsEvidence: false }
  return {
    text: typeof item?.text === 'string' ? item.text : '',
    needsEvidence: item?.needsEvidence === true,
  }
}

/**
 * 返回给调用方的条目一律深拷贝：外部改数组不会污染内存索引。
 *
 * @param {LedgerEntry} entry
 * @returns {LedgerEntry}
 */
function cloneEntry(entry) {
  return structuredClone(entry)
}

/**
 * 约束台账：`<dir>/ledger.jsonl`，一行一个版本。
 *
 * 构造时不读盘；首次操作才懒加载并重建索引。`verify` 是纯函数，不读写盘。
 */
export class Ledger {
  /** @type {string} */
  #dir
  /** @type {string} */
  #path
  /** @type {() => number} */
  #now
  /** @type {Promise<void>|null} */
  #loaded = null
  /** @type {Promise<unknown>} */
  #queue = Promise.resolve()
  /** @type {string[]} 已确认落盘的原始行，用于写入前的前缀校验 */
  #committed = []
  /** @type {Map<string, LedgerEntry>} taskId -> 最新版本 */
  #latest = new Map()

  /**
   * @param {{ dir: string, now?: () => number }} options
   *   dir 是 root 目录（由 config.rootDir 推导），ledger.jsonl 固定落在其下；now 仅供测试注入时间。
   */
  constructor({ dir, now = () => Date.now() }) {
    this.#dir = dir
    this.#path = join(dir, 'ledger.jsonl')
    this.#now = now
  }

  /**
   * 追加一个版本；内容与上一版相同则不追加，直接返回既有 entry。
   *
   * @param {{
   *   taskId: string,
   *   constraints?: (string | { text: string, needsEvidence?: boolean })[],
   *   acceptance?: string[],
   *   boundaries?: string[],
   *   forbidden?: string[],
   *   version?: number,
   * }} input
   *   version 是可选的乐观并发校验：必须等于下一个版本号，用于挡住"用旧版本回写覆盖"的写入。
   * @returns {Promise<LedgerEntry>}
   */
  async append(input = {}) {
    const { taskId, constraints = [], acceptance = [], boundaries = [], forbidden = [], version } = input

    // 参数错误在入队前抛出：坏参数不该占用队列。
    if (typeof taskId !== 'string' || taskId.length === 0) throw new LedgerError('台账条目需要非空 taskId')
    const canonical = canonicalize({ constraints, acceptance, boundaries, forbidden })

    return this.#enqueue(async () => {
      await this.#load()
      await this.#ensureIntact()

      const current = this.#latest.get(taskId) ?? null
      const expectedVersion = (current === null ? 0 : current.version) + 1
      if (version !== undefined && version !== expectedVersion) {
        throw new LedgerError(
          '台账 version 冲突：taskId=' + taskId + ' 的下一个版本应为 ' + expectedVersion +
            '，收到 ' + version + '；台账只能按版本递增追加，不能覆盖既有版本',
        )
      }
      if (current !== null && current.hash === canonical.hash) return cloneEntry(current)

      /** @type {LedgerEntry} */
      const entry = {
        taskId,
        version: expectedVersion,
        ts: this.#now(),
        schemaVersion: LEDGER_SCHEMA_VERSION,
        constraints: canonical.constraints,
        acceptance: canonical.acceptance,
        boundaries: canonical.boundaries,
        forbidden: canonical.forbidden,
        hash: canonical.hash,
      }
      const line = JSON.stringify(entry)
      await appendFile(this.#path, line + '\n', 'utf8')
      this.#committed.push(line)
      this.#latest.set(taskId, entry)
      return cloneEntry(entry)
    })
  }

  /**
   * @param {string} taskId
   * @returns {Promise<LedgerEntry|null>}
   */
  async latest(taskId) {
    await this.#load()
    const entry = this.#latest.get(taskId)
    return entry === undefined ? null : cloneEntry(entry)
  }

  /**
   * 按 taskId 分组，每个 taskId 只给最新版本。
   *
   * @returns {Promise<LedgerEntry[]>} 按 taskId 升序
   */
  async list() {
    await this.#load()
    return [...this.#latest.values()]
      .sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0))
      .map((entry) => cloneEntry(entry))
  }

  /**
   * 三类可离线判定的校验：禁止项、产物边界、需要证据的约束。
   *
   * @param {LedgerEntry | { constraints?: unknown[], boundaries?: unknown[], forbidden?: unknown[] }} entry
   * @param {{ summary?: string, findings?: { text?: string }[], evidence?: unknown[], artifacts?: { path?: string }[] }} report
   * @returns {{ violations: LedgerViolation[], ok: boolean }}
   */
  verify(entry, report) {
    /** @type {LedgerViolation[]} */
    const violations = []
    const summary = typeof report?.summary === 'string' ? report.summary : ''
    const findings = Array.isArray(report?.findings) ? report.findings : []
    const evidence = Array.isArray(report?.evidence) ? report.evidence : []
    const artifacts = Array.isArray(report?.artifacts) ? report.artifacts : []

    // 1) 禁止项不得出现在摘要或发现正文里。
    for (const item of Array.isArray(entry?.forbidden) ? entry.forbidden : []) {
      const text = typeof item === 'string' ? item : ''
      if (text.length === 0) continue
      /** @type {string[]} */
      const where = []
      if (summary.includes(text)) where.push('摘要')
      findings.forEach((finding, index) => {
        if (typeof finding?.text === 'string' && finding.text.includes(text)) where.push('发现 #' + (index + 1))
      })
      if (where.length > 0) {
        violations.push({ kind: 'forbidden', text, reason: '禁止项「' + text + '」出现在报告的' + where.join('、') })
      }
    }

    // 2) 产物路径必须落在边界白名单前缀下；boundaries 为空表示不限制。
    const boundaries = (Array.isArray(entry?.boundaries) ? entry.boundaries : [])
      .map((item) => normalizePathPrefix(item))
      .filter((prefix) => prefix.length > 0)
    if (boundaries.length > 0) {
      for (const artifact of artifacts) {
        const path = typeof artifact?.path === 'string' ? artifact.path : ''
        const normalized = normalizePathPrefix(path)
        if (normalized.length === 0 || !boundaries.some((prefix) => isUnderPrefix(normalized, prefix))) {
          violations.push({
            kind: 'boundary',
            text: path,
            reason: '产物路径「' + (path.length > 0 ? path : '(空)') + '」不在边界白名单内：' + boundaries.join('、'),
          })
        }
      }
    }

    // 3) 需要证据的约束：报告里没有 evidence 时视为未满足。
    if (evidence.length === 0) {
      for (const item of Array.isArray(entry?.constraints) ? entry.constraints : []) {
        const view = constraintView(item)
        if (!view.needsEvidence) continue
        violations.push({
          kind: 'constraint',
          text: view.text,
          reason: '约束「' + view.text + '」需要证据，但报告里没有 evidence',
        })
      }
    }

    return { violations, ok: violations.length === 0 }
  }

  /**
   * 懒加载：首次操作把 ledger.jsonl 重建进内存索引。
   *
   * @returns {Promise<void>}
   */
  async #load() {
    this.#loaded ??= this.#readIndex()
    return this.#loaded
  }

  /** @returns {Promise<void>} */
  async #readIndex() {
    let text
    try {
      text = await readFile(this.#path, 'utf8')
    } catch (error) {
      if (/** @type {{ code?: string }} */ (error).code === 'ENOENT') return
      throw error
    }
    const lines = text.split('\n').filter((line) => line.length > 0)
    for (let index = 0; index < lines.length; index += 1) {
      const entry = parseEntry(lines[index], index + 1)
      this.#committed.push(lines[index])
      this.#latest.set(entry.taskId, entry)
    }
  }

  /**
   * 写入前确认磁盘仍是内存中已确认行的前缀：
   * 变短说明既有版本被删，行内容变了说明被覆盖，都是 LedgerError；
   * 变长说明另一个 Ledger 实例追加过，把新增行并入索引后继续（版本号不回退）。
   *
   * @returns {Promise<void>}
   */
  async #ensureIntact() {
    await mkdir(this.#dir, { recursive: true })
    let text
    try {
      text = await readFile(this.#path, 'utf8')
    } catch (error) {
      if (/** @type {{ code?: string }} */ (error).code !== 'ENOENT') throw error
      text = ''
    }
    const lines = text.split('\n').filter((line) => line.length > 0)

    if (lines.length < this.#committed.length) {
      throw new LedgerError(
        '台账被截断：磁盘上只剩 ' + lines.length + ' 条，内存中已确认 ' + this.#committed.length +
          ' 条；台账只能追加，不能删除既有版本',
      )
    }
    for (let index = 0; index < this.#committed.length; index += 1) {
      if (lines[index] !== this.#committed[index]) {
        throw new LedgerError('台账第 ' + (index + 1) + ' 条已被改写；台账只能追加，不能覆盖既有版本')
      }
    }
    for (let index = this.#committed.length; index < lines.length; index += 1) {
      const entry = parseEntry(lines[index], index + 1)
      this.#committed.push(lines[index])
      this.#latest.set(entry.taskId, entry)
    }
  }

  /**
   * 进程内写入串行化：同一 Ledger 实例的 append 排队执行，避免并发抢同一个版本号。
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
