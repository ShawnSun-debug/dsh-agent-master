// lib/handoff.js —— 交接契约（T03）
// 职责：把 brief + 约束台账渲染成子对话的 prompt；校验子对话回传的 report。
// 纪律：只依赖 Node 内置模块；校验是纯函数，失败不落盘、不产生任何文件副作用。
import { Buffer } from 'node:buffer'

/** 报告 schema 版本（子对话回传时必填，缺省按此版本校验） @type {number} */
export const REPORT_SCHEMA_VERSION = 1

/** 一次报告可以回传的载荷类型（与黑板记录 kind 对齐） @type {string[]} */
export const KINDS = ['finding', 'source', 'artifact']

/** 默认报告字节预算（UTF-8），与 lib/config.js 的 maxReportBytes 默认值一致 */
const DEFAULT_MAX_REPORT_BYTES = 8192

/** 交付 schema 的三连反引号围栏（用字符码拼接，避免源码里出现围栏本身） */
const CODE_FENCE = String.fromCharCode(96).repeat(3)

/** confidence 三档 */
const CONFIDENCE_LEVELS = ['low', 'medium', 'high']

/** evidence.url 只接受的协议 */
const URL_PROTOCOLS = new Set(['http:', 'https:'])

/** artifact.sha256 形状 */
const SHA256_PATTERN = /^[0-9a-f]{64}$/i

/** 根对象错误的路径占位（其余错误一律指向具体字段，便于逐条修正） */
const ROOT_PATH = '(root)'

/** 交接契约相关错误的基类 */
export class HandoffError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message)
    this.name = 'HandoffError'
  }
}

/** 报告校验失败：errors 逐条指向具体字段路径，子对话可据此修正后重发 */
export class ReportValidationError extends HandoffError {
  /**
   * @param {string} message
   * @param {{path: string, message: string}[]} errors
   */
  constructor(message, errors = []) {
    super(message)
    this.name = 'ReportValidationError'
    /** @type {{path: string, message: string}[]} */
    this.errors = errors
  }
}

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

/**
 * 取非空字符串，否则抛 HandoffError
 * @param {unknown} value
 * @param {string} name
 * @returns {string}
 */
function requireText(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HandoffError(name + ' 必须是非空字符串，实际收到 ' + JSON.stringify(value))
  }
  return value.trim()
}

/**
 * 校验正的安全整数
 * @param {unknown} value
 * @param {string} name
 * @returns {number}
 */
function assertPositiveInt(value, name) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new HandoffError(name + ' 必须是正的安全整数，实际收到 ' + JSON.stringify(value))
  }
  return value
}

/**
 * 解析 brief.budget：支持正整数字节数或 { maxReportBytes }
 * @param {unknown} budget
 * @returns {number}
 */
function resolveMaxReportBytes(budget) {
  if (budget === undefined || budget === null) return DEFAULT_MAX_REPORT_BYTES
  if (typeof budget === 'number') return assertPositiveInt(budget, 'brief.budget')
  if (typeof budget === 'object' && !Array.isArray(budget)) {
    return assertPositiveInt(budget.maxReportBytes, 'brief.budget.maxReportBytes')
  }
  throw new HandoffError('brief.budget 必须是正整数字节数或 { maxReportBytes: 正整数 }')
}

/**
 * 取条目文本（字符串或 { text, needsEvidence? }）
 * @param {unknown} item
 * @returns {string}
 */
function itemText(item) {
  if (typeof item === 'string') return item.trim()
  if (item && typeof item === 'object' && typeof item.text === 'string') return item.text.trim()
  return ''
}

/**
 * 取条目是否要求证据
 * @param {unknown} item
 * @returns {boolean}
 */
function itemNeedsEvidence(item) {
  return Boolean(item && typeof item === 'object' && item.needsEvidence)
}

/**
 * 合并台账与 brief 的条目：台账在前（权威），brief 独有条目补在后面，按文本去重。
 * 约束一条都不能在渲染时消失，因此这里不做「台账覆盖一切」的取舍。
 * @param {...unknown} lists
 * @returns {{text: string, needsEvidence: boolean}[]}
 */
function mergeItems(...lists) {
  /** @type {{text: string, needsEvidence: boolean}[]} */
  const out = []
  /** @type {Map<string, {text: string, needsEvidence: boolean}>} */
  const seen = new Map()
  for (const list of lists) {
    if (!Array.isArray(list)) continue
    for (const item of list) {
      const text = itemText(item)
      if (text === '') continue
      const previous = seen.get(text)
      if (previous) {
        previous.needsEvidence = previous.needsEvidence || itemNeedsEvidence(item)
        continue
      }
      const entry = { text, needsEvidence: itemNeedsEvidence(item) }
      seen.set(text, entry)
      out.push(entry)
    }
  }
  return out
}

/**
 * 渲染编号条目，空组用占位符（不留空 section）
 * @param {{text: string, needsEvidence: boolean}[]} items
 * @param {string} [empty]
 * @returns {string}
 */
function renderItems(items, empty = '（无）') {
  if (items.length === 0) return empty
  return items
    .map((item, index) => index + 1 + '. ' + item.text + (item.needsEvidence ? '（需 evidence）' : ''))
    .join('\n')
}

/**
 * 把 inputs 归一化成列表：字符串 / 数组（非字符串项按 JSON 序列化，避免静默丢输入）
 * @param {unknown} value
 * @returns {string[]}
 */
function toBullets(value) {
  if (value === undefined || value === null || value === '') return []
  const list = Array.isArray(value) ? value : [value]
  return list
    .map((item) => (typeof item === 'string' ? item : JSON.stringify(item)))
    .filter((item) => typeof item === 'string' && item.trim() !== '')
}

// ---------------------------------------------------------------------------
// brief → prompt
// ---------------------------------------------------------------------------

/**
 * 渲染交接契约 prompt。产出必须同时含：任务号、goal、inputs、台账版本与四组条目、
 * 交付 JSON schema（字段名与类型）、报告纪律（禁散文全文、evidence 规则、字节预算）。
 * @param {object} input
 * @param {string} input.taskId 任务号
 * @param {string} [input.label] 子对话名称（用于 prompt 自我识别）
 * @param {{goal: string, inputs?: unknown, constraints?: unknown[], acceptance?: unknown[], boundaries?: unknown[], forbidden?: unknown[], budget?: unknown}} input.brief 任务简报
 * @param {{taskId: string, version?: number, schemaVersion?: number, hash?: string, constraints?: unknown[], acceptance?: unknown[], boundaries?: unknown[], forbidden?: unknown[]}} input.ledgerEntry 约束台账条目（唯一权威来源）
 * @returns {string}
 */
export function renderBrief({ taskId, label, brief, ledgerEntry } = {}) {
  const id = requireText(taskId, 'taskId')
  if (!brief || typeof brief !== 'object' || Array.isArray(brief)) {
    throw new HandoffError('renderBrief 需要 brief 对象（至少含 goal）')
  }
  const goal = requireText(brief.goal, 'brief.goal')
  if (!ledgerEntry || typeof ledgerEntry !== 'object' || Array.isArray(ledgerEntry)) {
    throw new HandoffError('renderBrief 需要 ledgerEntry：交接契约必须绑定约束台账条目，不允许只发摘要')
  }
  const entryTaskId = requireText(ledgerEntry.taskId, 'ledgerEntry.taskId')
  if (entryTaskId !== id) {
    throw new HandoffError('台账条目 taskId(' + entryTaskId + ') 与任务号(' + id + ') 不一致，拒绝渲染张冠李戴的契约')
  }

  const ledgerVersion = Number.isSafeInteger(ledgerEntry.version) ? ledgerEntry.version : 1
  const ledgerSchemaVersion = Number.isSafeInteger(ledgerEntry.schemaVersion)
    ? ledgerEntry.schemaVersion
    : REPORT_SCHEMA_VERSION
  const entryHash = typeof ledgerEntry.hash === 'string' && ledgerEntry.hash !== '' ? ledgerEntry.hash : '（无）'
  const maxBytes = resolveMaxReportBytes(brief.budget)
  const owner = typeof label === 'string' && label.trim() !== '' ? label.trim() : '（未指定）'

  const constraints = mergeItems(ledgerEntry.constraints, brief.constraints)
  const acceptance = mergeItems(ledgerEntry.acceptance, brief.acceptance)
  const boundaries = mergeItems(ledgerEntry.boundaries, brief.boundaries)
  const forbidden = mergeItems(ledgerEntry.forbidden, brief.forbidden)
  const inputs = toBullets(brief.inputs)
  const budgetHint = Math.floor(maxBytes / 3)

  const schema = [
    '{',
    '  "taskId": "string，必须等于 ' + id + '",',
    '  "summary": "string，非空，≤ ' + maxBytes + ' 字节（UTF-8）",',
    '  "findings": "array[{ text: string, refs?: string[] }]，至少 1 条",',
    '  "evidence": "array[{ url?: string（http/https）, path?: string, quote: string }]，url 与 path 至少一个",',
    '  "open_questions": "string[]，可为空",',
    '  "artifacts": "array[{ path: string, bytes?: integer, sha256?: string }]，可为空",',
    '  "confidence": "low | medium | high（三档之一）",',
    '  "schemaVersion": ' + REPORT_SCHEMA_VERSION,
    '}',
  ]

  const lines = [
    '# 交接契约 v' + REPORT_SCHEMA_VERSION + ' · taskId=' + id,
    '',
    '执行者：' + owner,
    '本契约由 master 下发；约束台账是唯一权威来源，摘要与 digest 不覆盖它。',
    '结束前不得自行改写 constraints / acceptance / boundaries / forbidden。',
    '',
    '## 1. 目标',
    goal,
    '',
    '## 2. 输入',
    inputs.length === 0 ? '（无）' : inputs.map((item, index) => index + 1 + '. ' + item).join('\n'),
    '',
    '## 3. 约束台账（逐条遵守）',
    '台账版本：v' + ledgerVersion,
    '台账 taskId=' + entryTaskId + ' · schemaVersion=' + ledgerSchemaVersion + ' · hash=' + entryHash,
    '',
    '### constraints（硬约束）',
    renderItems(constraints),
    '',
    '### acceptance（验收标准，全部满足才算完成）',
    renderItems(acceptance),
    '',
    '### boundaries（产物路径白名单，artifact.path 必须落在其中之一）',
    renderItems(boundaries),
    '',
    '### forbidden（禁止项，不得出现在 summary 或 findings 中）',
    renderItems(forbidden),
    '',
    '## 4. 交付 JSON schema（master_report 参数，字段名与类型不可改）',
    CODE_FENCE + 'json',
    ...schema,
    CODE_FENCE,
    '',
    '## 5. 报告纪律',
    '1. 禁止回传散文全文：不要贴长文、整段原文或整篇文件；一条发现写成一句，引用只放短摘句。',
    '2. 每条 evidence 必须同时具备 url（http/https）或 path 之一，以及非空 quote（原文关键句）。',
    '3. 字节预算：summary ≤ ' + maxBytes + ' 字节（UTF-8，约 ' + budgetHint + ' 个汉字）；超出即整份拒收，不会进黑板。',
    '4. 可回传载荷类型：' + KINDS.join(' / ') + '（写入黑板时用这些 kind）。',
    '5. 校验失败不会被静默忽略：按错误里的 path 逐条修正后重新调用 master_report。',
    '6. 拿不准的事写进 open_questions，不要自行放宽 constraints 或 boundaries。',
    '7. 结束前必须调用 master_report 回传本报告；散文终答不计为交付。',
    '',
  ]
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// report 校验（schemaVersion 分派 → v1 字段校验）
// ---------------------------------------------------------------------------

/**
 * 取非空字符串字段，失败记一条带路径的错误
 * @param {unknown} value
 * @param {string} path
 * @param {string} message
 * @param {{path: string, message: string}[]} errors
 * @returns {string}
 */
function readText(value, path, message, errors) {
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push({ path, message })
    return ''
  }
  return value.trim()
}

/**
 * summary：非空 + UTF-8 字节预算
 * @param {unknown} value
 * @param {number} limit
 * @param {{path: string, message: string}[]} errors
 * @returns {string}
 */
function readSummary(value, limit, errors) {
  const summary = readText(value, 'summary', 'summary 必须是非空字符串', errors)
  if (summary === '') return ''
  const bytes = Buffer.byteLength(summary, 'utf8')
  if (bytes > limit) {
    errors.push({
      path: 'summary',
      message: 'summary 超出字节预算：' + bytes + ' 字节（UTF-8）> 上限 ' + limit + ' 字节，请压缩后重发',
    })
  }
  return summary
}

/**
 * 取字符串数组（open_questions / refs）
 * @param {unknown} value
 * @param {string} path
 * @param {string} listMessage
 * @param {string} itemMessage
 * @param {{path: string, message: string}[]} errors
 * @returns {string[]}
 */
function readStrings(value, path, listMessage, itemMessage, errors) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    errors.push({ path, message: listMessage })
    return []
  }
  const out = []
  value.forEach((item, index) => {
    if (typeof item === 'string' && item.trim() !== '') out.push(item.trim())
    else errors.push({ path: path + '[' + index + ']', message: itemMessage })
  })
  return out
}

/**
 * findings：非空数组，每项 { text, refs? }（容忍纯字符串项）
 * @param {unknown} value
 * @param {{path: string, message: string}[]} errors
 * @returns {{text: string, refs?: string[]}[]}
 */
function readFindings(value, errors) {
  if (value === undefined || value === null) {
    errors.push({ path: 'findings', message: 'findings 必须是非空数组，至少回传 1 条发现' })
    return []
  }
  if (!Array.isArray(value)) {
    errors.push({ path: 'findings', message: 'findings 必须是数组（[{ text, refs? }]）' })
    return []
  }
  if (value.length === 0) {
    errors.push({ path: 'findings', message: 'findings 不能是空数组，至少回传 1 条发现' })
    return []
  }
  const out = []
  value.forEach((item, index) => {
    const path = 'findings[' + index + ']'
    if (typeof item === 'string') {
      const text = item.trim()
      if (text === '') {
        errors.push({ path: path + '.text', message: 'findings 项的 text 必须是非空字符串' })
        return
      }
      out.push({ text })
      return
    }
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push({ path, message: 'findings 项必须是 { text, refs? } 对象或字符串' })
      return
    }
    const text = typeof item.text === 'string' ? item.text.trim() : ''
    if (text === '') errors.push({ path: path + '.text', message: 'findings 项的 text 必须是非空字符串' })
    const refs = readStrings(
      item.refs,
      path + '.refs',
      'findings 项的 refs 必须是字符串数组',
      'findings 项的 refs 每项必须是非空字符串',
      errors,
    )
    if (text !== '') out.push(refs.length > 0 ? { text, refs } : { text })
  })
  return out
}

/**
 * evidence：每项必须有 url（http/https）或 path 之一 + 非空 quote
 * @param {unknown} value
 * @param {{path: string, message: string}[]} errors
 * @returns {{url?: string, path?: string, quote: string}[]}
 */
function readEvidence(value, errors) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    errors.push({ path: 'evidence', message: 'evidence 必须是数组（[{ url?, path?, quote }]）' })
    return []
  }
  const out = []
  value.forEach((item, index) => {
    const path = 'evidence[' + index + ']'
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push({ path, message: 'evidence 项必须是 { url?, path?, quote } 对象' })
      return
    }
    const url = typeof item.url === 'string' ? item.url.trim() : ''
    const filePath = typeof item.path === 'string' ? item.path.trim() : ''
    if (url === '' && filePath === '') {
      errors.push({ path, message: 'evidence 项必须至少提供 url 或 path（二者取一）' })
    } else if (url !== '' && !isHttpUrl(url)) {
      errors.push({ path: path + '.url', message: 'evidence.url 只接受 http/https：' + url })
    }
    const quote = typeof item.quote === 'string' ? item.quote.trim() : ''
    if (quote === '') {
      errors.push({ path: path + '.quote', message: 'evidence.quote 必须是非空字符串（摘录原文关键句）' })
    }
    /** @type {{url?: string, path?: string, quote: string}} */
    const normalized = {}
    if (url !== '') normalized.url = url
    if (filePath !== '') normalized.path = filePath
    normalized.quote = quote
    out.push(normalized)
  })
  return out
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isHttpUrl(value) {
  try {
    return URL_PROTOCOLS.has(new URL(value).protocol)
  } catch {
    return false
  }
}

/**
 * artifacts：path 必填，bytes/sha256 可选但类型受校验
 * @param {unknown} value
 * @param {{path: string, message: string}[]} errors
 * @returns {{path: string, bytes?: number, sha256?: string}[]}
 */
function readArtifacts(value, errors) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    errors.push({ path: 'artifacts', message: 'artifacts 必须是数组（[{ path, bytes?, sha256? }]）' })
    return []
  }
  const out = []
  value.forEach((item, index) => {
    const path = 'artifacts[' + index + ']'
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push({ path, message: 'artifacts 项必须是 { path, bytes?, sha256? } 对象' })
      return
    }
    /** @type {{path: string, bytes?: number, sha256?: string}} */
    const normalized = { path: '' }
    const filePath = typeof item.path === 'string' ? item.path.trim() : ''
    if (filePath === '') {
      errors.push({ path: path + '.path', message: 'artifacts 项的 path 必须是非空字符串（产物落盘路径）' })
    } else {
      normalized.path = filePath
    }
    if (item.bytes !== undefined && item.bytes !== null) {
      if (typeof item.bytes !== 'number' || !Number.isSafeInteger(item.bytes) || item.bytes < 0) {
        errors.push({ path: path + '.bytes', message: 'artifacts 项的 bytes 必须是非负安全整数' })
      } else {
        normalized.bytes = item.bytes
      }
    }
    if (item.sha256 !== undefined && item.sha256 !== null) {
      if (typeof item.sha256 !== 'string' || !SHA256_PATTERN.test(item.sha256)) {
        errors.push({ path: path + '.sha256', message: 'artifacts 项的 sha256 必须是 64 位十六进制字符串' })
      } else {
        normalized.sha256 = item.sha256.toLowerCase()
      }
    }
    out.push(normalized)
  })
  return out
}

/**
 * confidence：必须是 low / medium / high
 * @param {unknown} value
 * @param {{path: string, message: string}[]} errors
 * @returns {string}
 */
function readConfidence(value, errors) {
  if (typeof value === 'string' && CONFIDENCE_LEVELS.includes(value.trim())) return value.trim()
  errors.push({
    path: 'confidence',
    message: 'confidence 必须是 ' + CONFIDENCE_LEVELS.join(' / ') + ' 之一，收到 ' + JSON.stringify(value),
  })
  return ''
}

/**
 * v1 报告校验 + 归一化（未知字段忽略，入参不被修改）
 * @param {Record<string, any>} raw
 * @param {number} limit
 * @param {{path: string, message: string}[]} errors
 * @returns {object}
 */
function validateReportV1(raw, limit, errors) {
  const taskId = readText(
    raw.taskId,
    'taskId',
    'taskId 必须是非空字符串（与交接契约中的任务号一致）',
    errors,
  )
  const summary = readSummary(raw.summary, limit, errors)
  const findings = readFindings(raw.findings, errors)
  const evidence = readEvidence(raw.evidence, errors)
  const openQuestions = readStrings(
    raw.open_questions,
    'open_questions',
    'open_questions 必须是字符串数组',
    'open_questions 每项必须是非空字符串',
    errors,
  )
  const artifacts = readArtifacts(raw.artifacts, errors)
  const confidence = readConfidence(raw.confidence, errors)
  return {
    taskId,
    summary,
    findings,
    evidence,
    open_questions: openQuestions,
    artifacts,
    confidence,
    schemaVersion: REPORT_SCHEMA_VERSION,
  }
}

/** 各版本校验器：版本号 → 校验函数（新增版本时在此登记） */
const REPORT_VALIDATORS = {
  1: validateReportV1,
}

/**
 * 校验并归一化子对话回传的 report。成功返回 { ok: true, report }；
 * 失败抛 ReportValidationError，errors 逐条指向具体字段路径（可修正），且不产生任何文件副作用。
 * @param {unknown} raw 子对话回传的原始报告
 * @param {{maxBytes?: number}} [options] 字节预算（UTF-8），默认 8192
 * @returns {{ok: true, report: object}}
 */
export function validateReport(raw, options = {}) {
  const { maxBytes = DEFAULT_MAX_REPORT_BYTES } = options ?? {}
  const limit = assertPositiveInt(maxBytes, 'maxBytes')

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ReportValidationError('报告校验失败：报告必须是 JSON 对象', [
      {
        path: ROOT_PATH,
        message: '报告必须是 JSON 对象，实际收到 ' + (Array.isArray(raw) ? 'array' : typeof raw),
      },
    ])
  }

  const version =
    raw.schemaVersion === undefined || raw.schemaVersion === null
      ? REPORT_SCHEMA_VERSION
      : raw.schemaVersion
  const validator = Number.isSafeInteger(version) ? REPORT_VALIDATORS[version] : undefined
  if (!validator) {
    // 版本不认识就不猜字段：只报版本一条，避免给出误导性的字段错误
    throw new ReportValidationError('报告校验失败：不支持的 schemaVersion', [
      {
        path: 'schemaVersion',
        message:
          '不支持的 schemaVersion：' +
          JSON.stringify(raw.schemaVersion) +
          '（当前仅支持 ' +
          REPORT_SCHEMA_VERSION +
          '），请按 schemaVersion=' +
          REPORT_SCHEMA_VERSION +
          ' 重新回传',
      },
    ])
  }

  const errors = []
  const report = validator(raw, limit, errors)
  if (errors.length > 0) {
    throw new ReportValidationError(
      '报告校验失败：' + errors.length + ' 处不符合交接契约，请按 path 逐条修正后重发',
      errors,
    )
  }
  return { ok: true, report }
}

// ---------------------------------------------------------------------------
// 台账绑定
// ---------------------------------------------------------------------------

/**
 * 把已校验的 report 绑定到台账条目：调用 ledger.verify 并检查 taskId 一致。
 * 返回 { violations, ok }；violations 非空时调用方不得写黑板。
 * @param {{ledger: {verify: (entry: object, report: object) => {violations?: object[]}}, entry: object, report: object}} input
 * @returns {{violations: object[], ok: boolean}}
 */
export function bindReportToLedger({ ledger, entry, report } = {}) {
  if (!ledger || typeof ledger.verify !== 'function') {
    throw new HandoffError('bindReportToLedger 需要 ledger（需提供 verify 方法）')
  }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new HandoffError('bindReportToLedger 需要台账条目 entry')
  }
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    throw new HandoffError('bindReportToLedger 需要已通过 validateReport 的 report')
  }
  const expected = requireText(entry.taskId, 'entry.taskId')

  const violations = []
  const verification = ledger.verify(entry, report)
  if (verification && Array.isArray(verification.violations)) {
    violations.push(...verification.violations)
  }
  if (report.taskId !== expected) {
    violations.push({
      kind: 'taskId',
      text: typeof report.taskId === 'string' ? report.taskId : JSON.stringify(report.taskId),
      reason: '报告 taskId(' + JSON.stringify(report.taskId) + ') 与台账条目 taskId(' + expected + ') 不一致',
    })
  }
  return { violations, ok: violations.length === 0 }
}
