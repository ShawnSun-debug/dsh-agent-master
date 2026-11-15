/**
 * dsh-agent-master — 五个模型工具（T04）。
 *
 * 设计约束：本模块不认识黑板/台账的具体实现，只认 .scratch/interfaces.md 里声明的契约方法
 * （board.query / board.append / board.head、ledger.append / ledger.latest / ledger.list / ledger.verify），
 * 全部由 createTools(deps) 注入 —— 这样测试可以全假，T2 还没写完也能开工，
 * 宿主侧也能把同一批函数注册成 ctx.tools.register 的 defineTool。
 *
 * definitions 里每项是 { name, description, parameters, output: { schema, render }, execute }：
 * 普通对象，不依赖 cordis 类型，宿主按需包一层即可。
 *
 * @module dsh-agent-master/tools
 */

import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { DEFAULTS, artifactsDir } from './config.js'
import { bindReportToLedger, renderBrief, validateReport } from './handoff.js'

/** 工具错误：参数不对、依赖缺失、台账没有条目等「调用方必须改」的失败都用它（文案中文） */
export class ToolsError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message)
    this.name = 'ToolsError'
  }
}

/** 模型可见的工具名（顺序即注册顺序） @type {ReadonlyArray<string>} */
export const TOOL_NAMES = Object.freeze([
  'master_assign',
  'master_report',
  'master_collect',
  'master_board',
  'master_digest',
])

/** 任务号形状：t1、t2 ……（板上的 task 记录用 refs 指向它） */
const TASK_ID_PATTERN = /^t\d+$/

/** 黑板记录里用来携带台账违规的 tag 前缀：violation:<kind>:<短文本> */
const VIOLATION_TAG_PREFIX = 'violation:'

/** collect 一次读取的黑板记录类型（task 只用来核对谁还没回报，不参与按 name 归组） */
const COLLECT_KINDS = Object.freeze(['task', 'finding', 'source', 'artifact', 'open_question'])

/** collect 等待子对话回报时的轮询间隔（毫秒） */
const POLL_INTERVAL_MS = 10

/** 黑板记录里违规 tag 的文本上限（避免把长报文塞进 tag） */
const VIOLATION_TEXT_LIMIT = 200

// ---------------------------------------------------------------------------
// 依赖与参数小工具
// ---------------------------------------------------------------------------

/**
 * 校验并补齐依赖：缺什么就一次性说清，不要等到某个工具被调用才炸。
 * @param {{config?: object, board?: object, ledger?: object, spawnActivation?: Function, rootId?: string, now?: Function}} deps
 * @returns {{cfg: Record<string, any>, board: any, ledger: any, spawnActivation: Function, rootId: string, now: () => number}}
 */
function resolveDeps(deps) {
  if (!deps || typeof deps !== 'object') {
    throw new ToolsError('createTools 需要依赖对象 deps（config/board/ledger/spawnActivation/rootId）')
  }
  const missing = []
  if (!deps.config || typeof deps.config !== 'object') missing.push('config')
  if (!deps.board || typeof deps.board.append !== 'function' || typeof deps.board.query !== 'function') {
    missing.push('board（需提供 append/query）')
  }
  if (!deps.ledger || typeof deps.ledger.append !== 'function') {
    missing.push('ledger（需提供 append）')
  }
  if (typeof deps.spawnActivation !== 'function') missing.push('spawnActivation')
  if (typeof deps.rootId !== 'string' || deps.rootId.trim() === '') missing.push('rootId')
  if (missing.length > 0) {
    throw new ToolsError('createTools 缺少必需依赖：' + missing.join('、'))
  }
  return {
    cfg: { ...DEFAULTS, ...deps.config },
    board: deps.board,
    ledger: deps.ledger,
    spawnActivation: deps.spawnActivation,
    rootId: deps.rootId.trim(),
    now: typeof deps.now === 'function' ? deps.now : () => Date.now(),
  }
}

/**
 * 取非空字符串，失败抛 ToolsError（文案带字段名，模型能照着改）
 * @param {unknown} value
 * @param {string} name
 * @returns {string}
 */
function requireText(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ToolsError(name + ' 必须是非空字符串，实际收到 ' + JSON.stringify(value))
  }
  return value.trim()
}

/**
 * brief 里的四组条目：字符串、{ text } 对象、或它们的数组；空值归一成 []。
 * 归一只是收敛形状，条目文本一条都不丢（台账才是权威）。
 * @param {unknown} value
 * @returns {any[]}
 */
function toLedgerItems(value) {
  if (value === undefined || value === null || value === '') return []
  const list = Array.isArray(value) ? value : [value]
  return list.filter((item) => item !== undefined && item !== null && item !== '')
}

/**
 * 校验 taskId 形状（重试时要复用同一个号）
 * @param {unknown} value
 * @returns {string}
 */
function requireTaskId(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!TASK_ID_PATTERN.test(text)) {
    throw new ToolsError('taskId 必须形如 t1、t2，实际收到 ' + JSON.stringify(value))
  }
  return text
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isHttpUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * 把文本压成一行短 tag（黑板 tag 是字符串数组，放不下换行）
 * @param {unknown} value
 * @returns {string}
 */
function oneLine(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, VIOLATION_TEXT_LIMIT)
}

/**
 * 解析子对话传入的运行时上下文，决定黑板记录的 author。
 * 宿主接线时应把子会话的 sessionId/name 透传进来；拿不到就退化成 rootId/child，
 * 此时 collect 仍能工作，但只会归成一个叫 child 的组，所以接线时要传。
 * @param {unknown} runtime
 * @param {{sessionId: string, name: string}} fallback
 * @returns {{sessionId: string, name: string}}
 */
function resolveAuthor(runtime, fallback) {
  if (runtime && typeof runtime === 'object') {
    const author = runtime.author
    if (author && typeof author === 'object' && typeof author.sessionId === 'string' && author.sessionId !== '') {
      return {
        sessionId: author.sessionId,
        name: typeof author.name === 'string' && author.name !== '' ? author.name : fallback.name,
      }
    }
    if (typeof runtime.sessionId === 'string' && runtime.sessionId !== '') {
      return {
        sessionId: runtime.sessionId,
        name: typeof runtime.name === 'string' && runtime.name !== '' ? runtime.name : fallback.name,
      }
    }
  }
  return { ...fallback }
}

// ---------------------------------------------------------------------------
// createTools
// ---------------------------------------------------------------------------

/**
 * 造出五个模型工具。依赖全部注入，调用方（lib/index.js）负责接线，测试负责造假。
 *
 * @param {{config?: Record<string, any>, board?: any, ledger?: any, spawnActivation?: Function, rootId?: string, now?: () => number}} deps
 * @returns {{assign: Function, collect: Function, report: Function, boardTool: Function, digest: Function, definitions: object[]}}
 */
export function createTools(deps = {}) {
  const { cfg, board, ledger, spawnActivation, rootId, now } = resolveDeps(deps)

  /** master 自己写黑板时的 author（task 记录） */
  const masterAuthor = { sessionId: rootId, name: 'master' }

  // -------------------------------------------------------------------------
  // taskId 分配
  // -------------------------------------------------------------------------

  /**
   * 按板上已有 task 数量生成下一个任务号（票面要求）；再排除台账里出现过的号，
   * 避免「spawn 失败只留台账」的那个号被下一个任务复用成同号不同任务。
   * @returns {Promise<string>}
   */
  async function generateTaskId() {
    const tasks = (await board.query({ kind: 'task', sinceSeq: 0, limit: cfg.boardMaxEntries })) ?? []
    /** @type {Set<string>} */
    const used = new Set()
    for (const record of tasks) {
      for (const ref of record.refs ?? []) {
        if (typeof ref === 'string' && TASK_ID_PATTERN.test(ref)) used.add(ref)
      }
    }
    if (typeof ledger.list === 'function') {
      try {
        const entries = await ledger.list()
        for (const entry of entries ?? []) {
          if (entry && typeof entry.taskId === 'string' && TASK_ID_PATTERN.test(entry.taskId)) {
            used.add(entry.taskId)
          }
        }
      } catch {
        // 台账只读失败不该挡住下派：板上的任务号已经足够生成不冲突的号
      }
    }
    let index = tasks.length + 1
    while (used.has('t' + index)) index += 1
    return 't' + index
  }

  // -------------------------------------------------------------------------
  // 1. master_assign
  // -------------------------------------------------------------------------

  /**
   * 下派一路任务给一个子对话：写约束台账 → 渲染交接契约 → 开子会话 → 板上记 1 条 task。
   *
   * 顺序是有意的：**先开子会话、成功后才写板**。spawnActivation 抛错时板上一片干净
   * （不存在「有 task 记录但没有子会话」的脏数据），返回值里带回 taskId 与 ledgerVersion，
   * 宿主用同一个 taskId 重试即可（台账是 append-only，同内容重试不会产生新版本）。
   *
   * @param {{label?: string, name?: string, taskId?: string, brief?: object}} [input]
   * @returns {Promise<{ok: boolean, taskId: string, promptBytes: number, child?: any, ledgerVersion?: number, error?: {name: string, message: string}}>}
   */
  async function assign(input = {}) {
    const label = requireText(input?.label, 'label')
    const name = typeof input?.name === 'string' && input.name.trim() !== '' ? input.name.trim() : null
    const brief = input?.brief
    if (!brief || typeof brief !== 'object' || Array.isArray(brief)) {
      throw new ToolsError('master_assign 需要 brief 对象（至少含 goal）')
    }
    const goal = requireText(brief.goal, 'brief.goal')

    // 上限闸门：先数板上的 task 记录（一个 task 一条），到顶就要求先回收
    const tasks = (await board.query({ kind: 'task', sinceSeq: 0, limit: cfg.boardMaxEntries })) ?? []
    if (tasks.length >= cfg.maxChildren) {
      throw new ToolsError(
        '已达 maxChildren 上限（' + cfg.maxChildren + '）：先 master_collect 回收子对话结果，再下派新任务',
      )
    }

    const taskId = input?.taskId === undefined || input.taskId === null
      ? await generateTaskId()
      : requireTaskId(input.taskId)

    // 约束台账：唯一权威来源，先落台账再渲染，渲染时只可能是台账里的条目
    const ledgerEntry = await ledger.append({
      taskId,
      constraints: toLedgerItems(brief.constraints),
      acceptance: toLedgerItems(brief.acceptance),
      boundaries: toLedgerItems(brief.boundaries),
      forbidden: toLedgerItems(brief.forbidden),
    })
    if (!ledgerEntry || typeof ledgerEntry !== 'object' || ledgerEntry.taskId !== taskId) {
      throw new ToolsError('台账没有为 ' + taskId + ' 返回条目：拒绝在没有台账绑定的情况下下派')
    }

    // 交接契约必须复用 lib/handoff.js 的渲染，不要在工具层自己拼 prompt
    const prompt = renderBrief({ taskId, label, brief, ledgerEntry })
    const promptBytes = Buffer.byteLength(prompt, 'utf8')

    let child
    try {
      child = await spawnActivation({
        label,
        ...(name === null ? {} : { name }),
        prompt,
      })
    } catch (error) {
      // 回滚：还没写板，所以板上不留 task 记录；台账 append-only，条目保留供同号重试
      return {
        ok: false,
        taskId,
        ledgerVersion: Number.isSafeInteger(ledgerEntry.version) ? ledgerEntry.version : 1,
        promptBytes,
        error: {
          name: String((error && error.name) || 'Error'),
          message: String((error && error.message) || error),
        },
      }
    }

    try {
      await board.append({
        kind: 'task',
        title: goal,
        body: '',
        refs: [taskId],
        tags: ['assign'],
        author: masterAuthor,
      })
    } catch (error) {
      // 子会话已经开出来了，删不掉：这里绝不能按「下派失败」处理，否则 master 会重复 spawn 一路。
      // 如实报告「已启动但没记上板」，让 master 用 collect 对账，而不是重试。
      return {
        ok: false,
        started: true,
        taskId,
        ledgerVersion: Number.isSafeInteger(ledgerEntry.version) ? ledgerEntry.version : 1,
        promptBytes,
        child,
        error: {
          name: String((error && error.name) || 'Error'),
          message:
            '子会话已启动，但黑板 task 记录写入失败：' + String((error && error.message) || error) +
            '；不要重复下派，先用 master_collect 核对',
        },
      }
    }

    return { ok: true, taskId, promptBytes, child }
  }

  // -------------------------------------------------------------------------
  // 2. master_report
  // -------------------------------------------------------------------------

  /**
   * 子对话回传结构化报告：先校验（失败直接抛、一个字节都不写），
   * 再把 finding / source / artifact（以及 open_question）写进黑板，
   * 最后按台账逐条核对 violations —— 有 violations 仍然写盘，但 ok=false 并逐条列出。
   *
   * @param {unknown} raw 子对话回传的原始报告
   * @param {{author?: {sessionId: string, name?: string}, sessionId?: string, name?: string}} [runtime]
   * @returns {Promise<{recordIds: string[], violations: object[], ok: boolean}>}
   */
  async function report(raw, runtime) {
    // 校验失败抛 ReportValidationError：这里之后才允许产生任何写入
    const { report: normalized } = validateReport(raw, { maxBytes: cfg.maxReportBytes })

    const author = resolveAuthor(runtime, { sessionId: rootId, name: 'child' })
    const entry = typeof ledger.latest === 'function' ? await ledger.latest(normalized.taskId) : null

    let violations
    if (entry) {
      violations = bindReportToLedger({ ledger, entry, report: normalized }).violations
    } else {
      violations = [
        {
          kind: 'ledger',
          text: normalized.taskId,
          reason:
            '台账里没有 ' + normalized.taskId + ' 的条目：无法逐条核对 constraints/acceptance/boundaries/forbidden',
        },
      ]
    }

    // 违规也要在板上留痕，否则 master 用 collect 时看不到（tag 是黑板上唯一能带附加信息的自由字段）
    const violationTags = violations.map(
      (violation) =>
        VIOLATION_TAG_PREFIX + String(violation && violation.kind ? violation.kind : 'unknown') + ':' + oneLine(
          violation && (violation.text ?? violation.reason),
        ),
    )

    /** @type {string[]} */
    const recordIds = []
    const ledgerVersion = entry && Number.isSafeInteger(entry.version) ? entry.version : 0

    // 1 条 finding：body = summary。
    // 标题里带台账版本是有意的：黑板去重键 = sha256(title + NUL + body)，
    // 若台账被改写（append-only 升版）后子对话用同一份摘要重报，标题不同才不会被去重吃掉，
    // 新产生的违规标记才留得下来（plan §8「改写 constraints 后 collect 必须报出 violation」）。
    const finding = await board.append({
      kind: 'finding',
      author,
      title: 'finding · ' + normalized.taskId + ' · 台账v' + ledgerVersion,
      body: normalized.summary,
      refs: [normalized.taskId],
      tags: ['report', ...violationTags],
    })
    recordIds.push(finding.record.id)

    // 每条 evidence → 1 条 source：refs = url 或 path，body = quote
    for (const item of normalized.evidence) {
      const ref = item.url ?? item.path
      const source = await board.append({
        kind: 'source',
        author,
        title: ref,
        body: item.quote,
        refs: [ref],
        tags: ['evidence'],
      })
      recordIds.push(source.record.id)
    }

    // 每个 artifact → 1 条 artifact：artifact 字段带 path/bytes/sha256
    for (const item of normalized.artifacts) {
      /** @type {{path: string, bytes?: number, sha256?: string}} */
      const artifact = { path: item.path }
      if (item.bytes !== undefined) artifact.bytes = item.bytes
      if (item.sha256 !== undefined) artifact.sha256 = item.sha256
      const record = await board.append({
        kind: 'artifact',
        author,
        title: item.path,
        body: '',
        refs: [item.path],
        artifact,
        tags: ['report'],
      })
      recordIds.push(record.record.id)
    }

    // open_questions 也要进板：它们不进报告摘要，却是 master 唯一能看到「哪里卡住」的渠道
    for (const question of normalized.open_questions) {
      const record = await board.append({
        kind: 'open_question',
        author,
        title: 'open_question · ' + normalized.taskId,
        body: question,
        refs: [normalized.taskId],
        tags: ['report'],
      })
      recordIds.push(record.record.id)
    }

    return { recordIds, violations, ok: violations.length === 0 }
  }

  // -------------------------------------------------------------------------
  // 3. master_collect
  // -------------------------------------------------------------------------

  /**
   * 一次读全黑板（按 kind 分别 query，契约里 kind 过滤最稳）
   * @returns {Promise<any[]>}
   */
  async function readBoard() {
    /** @type {any[]} */
    const out = []
    for (const kind of COLLECT_KINDS) {
      const records = (await board.query({ kind, sinceSeq: 0, limit: cfg.boardMaxEntries })) ?? []
      for (const record of records) out.push(record)
    }
    return out
  }

  /**
   * 从 finding 记录的 tag 里取回台账违规（report 时写进去的 violation:<kind>:<text>）
   * @param {unknown[]} tags
   * @returns {{kind: string, text: string}[]}
   */
  function readViolationTags(tags) {
    /** @type {{kind: string, text: string}[]} */
    const out = []
    for (const tag of tags ?? []) {
      if (typeof tag !== 'string' || !tag.startsWith(VIOLATION_TAG_PREFIX)) continue
      const rest = tag.slice(VIOLATION_TAG_PREFIX.length)
      const colon = rest.indexOf(':')
      if (colon === -1) {
        out.push({ kind: rest, text: '' })
        continue
      }
      out.push({ kind: rest.slice(0, colon), text: rest.slice(colon + 1) })
    }
    return out
  }

  /**
   * 按 author.name 归组（master 自己的 task 记录不参与归组）
   * @param {any[]} records
   * @returns {any[]}
   */
  function groupChildren(records) {
    /** @type {Map<string, any>} */
    const children = new Map()
    for (const record of records) {
      if (!record || record.kind === 'task') continue
      const author = record.author ?? {}
      const name = typeof author.name === 'string' && author.name !== '' ? author.name : '（未命名）'
      let child = children.get(name)
      if (!child) {
        child = {
          name,
          sessionId: author.sessionId ?? null,
          taskId: null,
          summary: '',
          findings: [],
          evidence: [],
          artifacts: [],
          open_questions: [],
          violations: [],
        }
        children.set(name, child)
      }
      if (child.taskId === null) {
        const taskRef = (record.refs ?? []).find((ref) => typeof ref === 'string' && TASK_ID_PATTERN.test(ref))
        if (taskRef !== undefined) child.taskId = taskRef
      }
      if (record.kind === 'finding') {
        child.summary = record.body ?? ''
        child.findings.push(record.body ?? '')
        child.violations.push(...readViolationTags(record.tags))
      } else if (record.kind === 'source') {
        const ref = (record.refs ?? [])[0]
        /** @type {{url?: string, path?: string, quote: string}} */
        const evidence = { quote: record.body ?? '' }
        if (typeof ref === 'string' && ref !== '') {
          if (isHttpUrl(ref)) evidence.url = ref
          else evidence.path = ref
        }
        child.evidence.push(evidence)
      } else if (record.kind === 'artifact') {
        child.artifacts.push(record.artifact ?? { path: (record.refs ?? [])[0] ?? '' })
      } else if (record.kind === 'open_question') {
        child.open_questions.push(record.body ?? '')
      }
    }
    return [...children.values()]
  }

  /**
   * 回收子对话结果：按 author.name 归组，返回 findings/evidence/artifacts/open_questions/violations。
   * names 用于过滤，同时也用于算 missing（点名要却没回报的孩子）。
   * waitMs > 0 时轮询等待，最多等到 waitMs 或点名全部到齐。
   *
   * @param {{names?: string[] | string, waitMs?: number}} [input]
   * @returns {Promise<{children: any[], missing: string[]}>}
   */
  async function collect(input = {}) {
    /** @type {string[]} */
    const names = (() => {
      const raw = input?.names
      if (raw === undefined || raw === null) return []
      const list = Array.isArray(raw) ? raw : [raw]
      return list.map((item) => String(item).trim()).filter((item) => item !== '')
    })()
    const waitMs = Number.isSafeInteger(input?.waitMs) && input.waitMs > 0 ? input.waitMs : 0
    const deadline = now() + waitMs
    // now() 在测试里可能是常量：再加一道轮次上限，保证 waitMs 分支不会死循环
    const maxAttempts = Math.max(1, Math.ceil(waitMs / POLL_INTERVAL_MS) + 1)

    /** @type {any[]} */
    let children = []
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      children = groupChildren(await readBoard())
      const present = new Set(children.map((child) => child.name))
      if (names.length === 0 || names.every((name) => present.has(name))) break
      if (attempt + 1 >= maxAttempts || now() >= deadline) break
      await delay(POLL_INTERVAL_MS)
    }

    if (names.length > 0) {
      children = children.filter((child) => names.includes(child.name))
    }
    const present = new Set(children.map((child) => child.name))
    return { children, missing: names.filter((name) => !present.has(name)) }
  }

  // -------------------------------------------------------------------------
  // 4. master_board
  // -------------------------------------------------------------------------

  /**
   * 读黑板：op='query' 转发 board.query（kind/tag/sinceSeq/limit），op='head' 返回头指针。
   * 黑板是 append-only 的，写入口只有 master_assign / master_report，这里只读。
   *
   * @param {{op?: 'query' | 'head', kind?: string, tag?: string, sinceSeq?: number, limit?: number}} [input]
   * @returns {Promise<any[] | {seq: number}>}
   */
  async function boardTool(input = {}) {
    const op = input?.op
    if (op === 'head') return board.head()
    if (op === 'query') {
      /** @type {Record<string, any>} */
      const filter = {
        sinceSeq: Number.isSafeInteger(input.sinceSeq) && input.sinceSeq > 0 ? input.sinceSeq : 0,
        limit: Number.isSafeInteger(input.limit) && input.limit > 0 ? input.limit : cfg.boardMaxEntries,
      }
      if (input.kind !== undefined && input.kind !== null) filter.kind = String(input.kind)
      if (input.tag !== undefined && input.tag !== null) filter.tag = String(input.tag)
      return board.query(filter)
    }
    throw new ToolsError('master_board 不支持的 op：' + JSON.stringify(op) + '（只支持 query / head）')
  }

  // -------------------------------------------------------------------------
  // 5. master_digest
  // -------------------------------------------------------------------------

  /**
   * 把长文本压成「落盘 + 摘要指针」：超过预算才落盘，文件名用内容 sha256，天然去重。
   *
   * @param {{text?: string, path?: string, budgetBytes?: number}} [input]
   * @returns {Promise<{locator: string | null, sha256: string, bytes: number, summary: string, truncated: boolean}>}
   */
  async function digest(input = {}) {
    const budget = (() => {
      const raw = input?.budgetBytes
      if (raw === undefined || raw === null) return cfg.digestBudgetBytes
      if (!Number.isSafeInteger(raw) || raw <= 0) {
        throw new ToolsError('budgetBytes 必须是正整数（字节），实际收到 ' + JSON.stringify(raw))
      }
      return raw
    })()

    /** @type {string | null} */
    let content = null
    if (typeof input?.text === 'string' && input.text !== '') {
      content = input.text
    } else if (typeof input?.path === 'string' && input.path.trim() !== '') {
      const filePath = input.path.trim()
      try {
        content = await readFile(filePath, 'utf8')
      } catch (error) {
        throw new ToolsError('master_digest 读不到 path：' + filePath + '（' + String((error && error.message) || error) + '）')
      }
    }
    if (content === null) {
      throw new ToolsError('master_digest 需要 text 或 path 之一（都不能为空）')
    }

    const bytes = Buffer.byteLength(content, 'utf8')
    const sha256 = createHash('sha256').update(content, 'utf8').digest('hex')
    if (bytes <= budget) {
      return { locator: null, sha256, bytes, summary: content, truncated: false }
    }

    const dir = artifactsDir(cfg, rootId)
    await mkdir(dir, { recursive: true })
    const locator = join(dir, sha256 + '.md')
    await writeFile(locator, content, 'utf8')
    const keep = Math.max(1, Math.floor(budget / 4))
    return { locator, sha256, bytes, summary: content.slice(0, keep), truncated: true }
  }

  // -------------------------------------------------------------------------
  // definitions：ctx.tools.register 可接受的普通对象形状
  // -------------------------------------------------------------------------

  /** @type {object[]} */
  const definitions = [
    {
      name: 'master_assign',
      description:
        '把一路任务下派给一个新子对话：先把 brief 的四组约束写进约束台账，再按台账渲染交接契约 prompt，然后开子会话，最后在黑板记 1 条 task。下派失败会回滚（板上不留 task 记录）并带回 taskId 与 ledgerVersion，可用同一个 taskId 重试。',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string', description: '子对话的展示名，也是 collect 归组的键' },
          name: { type: 'string', description: '可选：子会话短名（小写字母/数字/连字符）' },
          taskId: { type: 'string', description: '可选：复用已有任务号（下派失败后按返回的 taskId 重试）' },
          brief: {
            type: 'object',
            properties: {
              goal: { type: 'string', description: '一句话目标（必填）' },
              inputs: { description: '已知输入：字符串，或字符串/对象数组' },
              constraints: { type: 'array', description: '硬约束（进台账，逐条核对）', items: {} },
              acceptance: { type: 'array', description: '验收标准（全部满足才算完成）', items: {} },
              boundaries: { type: 'array', description: '产物路径前缀白名单', items: {} },
              forbidden: { type: 'array', description: '禁止项（不得出现在 summary/findings）', items: {} },
              budget: { description: '报告字节预算：正整数，或 { maxReportBytes: 正整数 }' },
            },
            required: ['goal'],
          },
        },
        required: ['label', 'brief'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            taskId: { type: 'string' },
            promptBytes: { type: 'integer' },
            child: { type: 'object', description: '宿主 spawnActivation 的返回句柄' },
            ledgerVersion: { type: 'integer', description: '仅失败时返回：重试用的台账版本' },
            started: { type: 'boolean', description: '仅写板失败时返回：子会话已启动，不要重复下派' },
            error: { type: 'object', properties: { name: { type: 'string' }, message: { type: 'string' } } },
          },
          required: ['taskId'],
        },
        render(value) {
          if (value && value.started === true) {
            const child = (value && value.child) || {}
            return (
              '子会话 ' + String(child.sessionId ?? '（未返回句柄）') + ' 已启动，但黑板记录没写成：' +
              String((value.error && value.error.message) || '未知错误')
            )
          }
          if (value && value.ok === false) {
            const message = value.error && value.error.message ? value.error.message : '未知错误'
            return (
              '下派失败：' + message + '；taskId=' + String(value.taskId) +
              '（台账 v' + String(value.ledgerVersion) + '，可用同一个 taskId 重试）'
            )
          }
          const child = (value && value.child) || {}
          return (
            '已下派 ' + String(value && value.taskId) + '：交接契约 ' +
            String((value && value.promptBytes) || 0) + ' 字节，子会话 ' +
            String(child.sessionId ?? '（宿主未返回句柄）')
          )
        },
      },
      execute: (args, runtime) => assign(args, runtime),
    },
    {
      name: 'master_report',
      description:
        '子对话回传结构化报告（结束前必须调用）。校验失败会直接报错、一个字节都不写；校验通过才写 finding/source/artifact 记录，并按约束台账逐条核对：有 violations 仍写盘，但 ok=false 且逐条列出原因。',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: '交接契约里的任务号，必须一致' },
          summary: { type: 'string', description: '非空蒸馏摘要，超 maxReportBytes 字节即整份拒收' },
          findings: {
            type: 'array',
            description: '至少 1 条发现',
            items: {
              type: 'object',
              properties: { text: { type: 'string' }, refs: { type: 'array', items: { type: 'string' } } },
              required: ['text'],
            },
          },
          evidence: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                url: { type: 'string', description: 'http/https' },
                path: { type: 'string' },
                quote: { type: 'string', description: '原文关键句（必填）' },
              },
              required: ['quote'],
            },
          },
          open_questions: { type: 'array', items: { type: 'string' } },
          artifacts: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                bytes: { type: 'integer' },
                sha256: { type: 'string' },
              },
              required: ['path'],
            },
          },
          confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
          schemaVersion: { type: 'integer', description: '当前只支持 1' },
        },
        required: ['taskId', 'summary', 'findings', 'confidence'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            recordIds: { type: 'array', items: { type: 'string' } },
            violations: {
              type: 'array',
              items: {
                type: 'object',
                properties: { kind: { type: 'string' }, text: { type: 'string' }, reason: { type: 'string' } },
              },
            },
            ok: { type: 'boolean' },
          },
          required: ['recordIds', 'violations', 'ok'],
        },
        render(value) {
          const count = Array.isArray(value && value.recordIds) ? value.recordIds.length : 0
          if (value && value.ok === true) return '已写入黑板 ' + count + ' 条记录；台账逐条校验通过'
          const violations = Array.isArray(value && value.violations) ? value.violations : []
          const first = violations[0]
          const detail = first
            ? '，首条：' + String(first.kind) + ' ' + String(first.reason ?? first.text ?? '')
            : ''
          return '已写入黑板 ' + count + ' 条记录；台账违规 ' + violations.length + ' 处' + detail
        },
      },
      execute: (args, runtime) => report(args, runtime),
    },
    {
      name: 'master_collect',
      description:
        '回收子对话结果：读黑板上 task/finding/source/artifact/open_question 记录，按 author.name 归组，返回每个子对话的摘要、发现、证据、产物、待答问题与台账违规；names 可只取点名的几路，未回报的进 missing。',
      parameters: {
        type: 'object',
        properties: {
          names: { type: 'array', items: { type: 'string' }, description: '只回收这些名字的子对话' },
          waitMs: { type: 'integer', description: '最多等多久（毫秒），0 表示立即返回当前黑板' },
        },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            children: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  sessionId: { type: 'string' },
                  taskId: { type: 'string' },
                  summary: { type: 'string' },
                  findings: { type: 'array', items: { type: 'string' } },
                  evidence: { type: 'array', items: { type: 'object' } },
                  artifacts: { type: 'array', items: { type: 'object' } },
                  open_questions: { type: 'array', items: { type: 'string' } },
                  violations: { type: 'array', items: { type: 'object' } },
                },
              },
            },
            missing: { type: 'array', items: { type: 'string' } },
          },
          required: ['children', 'missing'],
        },
        render(value) {
          const children = Array.isArray(value && value.children) ? value.children : []
          const missing = Array.isArray(value && value.missing) ? value.missing : []
          const names = children.map((child) => String(child && child.name)).join('、')
          return (
            '已回收 ' + children.length + ' 个子对话' + (names ? '（' + names + '）' : '') +
            (missing.length > 0 ? '；未回报：' + missing.join('、') : '')
          )
        },
      },
      execute: (args, runtime) => collect(args, runtime),
    },
    {
      name: 'master_board',
      description:
        '读共享黑板（append-only）：op=query 按 kind/tag/sinceSeq/limit 转发查询返回记录数组，op=head 返回头指针。写黑板只能通过 master_assign / master_report。',
      parameters: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['query', 'head'] },
          kind: { type: 'string', description: 'task/finding/source/artifact/open_question/decision' },
          tag: { type: 'string', description: '按 tag 精确过滤' },
          sinceSeq: { type: 'integer', description: '只取 seq 大于它的记录' },
          limit: { type: 'integer', description: '最多返回多少条' },
        },
        required: ['op'],
      },
      output: {
        schema: {
          description: 'op=query 时是黑板记录数组；op=head 时是 { seq }',
          oneOf: [
            { type: 'array', items: { type: 'object' } },
            { type: 'object', properties: { seq: { type: 'integer' } } },
          ],
        },
        render(value) {
          if (Array.isArray(value)) return '黑板返回 ' + value.length + ' 条记录'
          return '黑板头指针 seq=' + String(value && value.seq)
        },
      },
      execute: (args, runtime) => boardTool(args, runtime),
    },
    {
      name: 'master_digest',
      description:
        '把超长文本压成摘要指针：未超预算原样返回；超预算则按内容 sha256 落盘成 artifacts/<sha256>.md，只返回 locator、sha256、字节数与前 budget/4 个字符的摘要。用来避免把全文塞回上下文。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要处理的正文' },
          path: { type: 'string', description: '或者给一个本地文件路径（text 优先）' },
          budgetBytes: { type: 'integer', description: '字节预算，缺省取 config.digestBudgetBytes' },
        },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            locator: { type: 'string', description: '落盘路径；未超预算时为 null' },
            sha256: { type: 'string' },
            bytes: { type: 'integer' },
            summary: { type: 'string' },
            truncated: { type: 'boolean' },
          },
          required: ['sha256', 'bytes', 'summary', 'truncated'],
        },
        render(value) {
          const bytes = (value && value.bytes) || 0
          if (value && value.truncated) {
            return (
              '正文已落盘：' + String((value && value.locator) || '（无路径）') + '（' + bytes + ' 字节，摘要 ' +
              String((value && value.summary) || '').length + ' 字符）'
            )
          }
          return '正文未超预算，未落盘（' + bytes + ' 字节）'
        },
      },
      execute: (args, runtime) => digest(args, runtime),
    },
  ]

  return { assign, collect, report, boardTool, digest, definitions }
}
