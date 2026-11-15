/**
 * dsh-agent-master — 来源聚合（去重 + 潜在冲突标记）。
 *
 * 输入是黑板上 kind='source' 的记录：lib/tools.js 的 master_report 写入时
 * refs[0] 是 url 或 path、body 是 quote、author.name 是子对话名。
 * 输出一份 master 可以直接引用的来源清单：同一来源合并、同样引文去重、
 * 同一来源出现不同引文就标记为潜在冲突。
 *
 * **只标记不裁判**：本模块不判断哪段引文准确 —— 判准要读原文，那是 master 的
 * 下一步；这里只保证「同一个来源被两路子对话说成两个样」不会被摘要抹平。
 *
 * @module dsh-agent-master/sources
 */

/** 来源聚合错误（输入形状不对等「调用方必须改」的失败）。 */
export class SourcesError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message)
    this.name = 'SourcesError'
  }
}

/** 未命名作者的占位（与 lib/deck.js 同口径）。 */
const UNNAMED = '（未命名）'

/** 参与归并的协议：http 与 https 视为同一来源。 */
const HTTP_PROTOCOLS = new Set(['http:', 'https:'])

/** 值类型的简短描述（拼进错误/说明文案） */
function describe(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/** 稳定的字典序比较（不依赖 locale，保证不同机器排序一致） */
function compareText(left, right) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

/**
 * 归一化一条 ref：返回分组键与展示文本。
 *
 * - http/https 同键（scheme 不参与键）；域名大小写由 URL 解析统一小写；
 * - 末尾斜杠与 hash 片段去掉；查询串保留（不同查询=不同来源）；
 * - 非 http(s) 的 ref（落盘路径等）只去末尾斜杠与 hash，大小写原样保留；
 * - 此外沿用 WHATWG URL 解析自带的规范化（默认端口、点段折叠、百分号编码），
 *   这些都指向同一个资源，归并比不归并更安全。
 *
 * @param {string} text 已 trim 的 ref
 * @returns {{ key: string, url: string }}
 */
function normalizeRef(text) {
  /** @type {URL | null} */
  let parsed = null
  try {
    parsed = new URL(text)
  } catch {
    parsed = null
  }
  if (parsed !== null && HTTP_PROTOCOLS.has(parsed.protocol)) {
    const pathname = parsed.pathname.replace(/\/+$/, '')
    const authority = parsed.host
    const search = parsed.search
    return {
      key: 'http|' + authority + pathname + search,
      // 展示文本沿用首次出现的那条记录的大小写 scheme（不擅自把 http 改成 https）
      url: parsed.protocol + '//' + authority + pathname + search,
    }
  }
  const withoutFragment = text.split('#')[0]
  const withoutSlash = withoutFragment.replace(/\/+$/, '')
  return { key: 'other|' + withoutSlash, url: withoutSlash }
}

/**
 * 从一条黑板 source 记录里取出聚合需要的字段。
 * 形状不可用的记录返回 null（跳过，不让一条坏记录带崩整批聚合）。
 *
 * @param {unknown} record
 * @returns {{ ref: string, quote: string, by: string, seq: number | null } | null}
 */
function readRecord(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return null
  const raw = /** @type {any} */ (record)
  const refs = Array.isArray(raw.refs) ? raw.refs : []
  const ref = typeof refs[0] === 'string' ? refs[0].trim() : ''
  if (ref === '') return null
  const quote = typeof raw.body === 'string' ? raw.body.trim() : ''
  if (quote === '') return null
  const author = raw.author
  const by = author && typeof author.name === 'string' && author.name !== '' ? author.name : UNNAMED
  const seq = Number.isSafeInteger(raw.seq) && raw.seq >= 0 ? raw.seq : null
  return { ref, quote, by, seq }
}

/**
 * 冲突说明：写清「几段不同引文、来自几路子对话」，并声明不裁判。
 * @param {{ by: string }[]} quotes
 * @returns {string}
 */
function conflictReason(quotes) {
  /** @type {string[]} */
  const names = []
  for (const item of quotes) {
    if (!names.includes(item.by)) names.push(item.by)
  }
  return '同一来源出现 ' + quotes.length + ' 段不同引文（来自 ' + names.length +
    ' 路子对话：' + names.join('、') + '），语义可能不同，需人工核对；本函数只标记不判断哪段准确。'
}

/**
 * @typedef {object} SourceQuote
 * @property {string} quote 引文（已 trim）
 * @property {string} by 写这条引文的子对话名（缺失时是「（未命名）」）
 * @property {number | null} seq 黑板序号（记录没有合法 seq 时为 null）
 */

/**
 * @typedef {object} AggregatedSource
 * @property {string} url 归一化后的展示地址（沿用首次出现记录的 scheme 大小写）
 * @property {SourceQuote[]} quotes 该来源下的引文，保持输入顺序（板内即 seq 升序）
 * @property {boolean} conflict 是否出现 2 段以上不同引文
 * @property {string} [conflictReason] 仅 conflict=true 时出现
 */

/**
 * 聚合来源记录：同一来源合并、同样引文去重、不同引文标潜在冲突。
 *
 * 排序：quotes 数量降序，再按 url 字典序 —— 同一份输入永远得到同样顺序。
 * 跳过：refs[0] 不是非空字符串、body 不是非空字符串、记录不是对象的条目
 * （黑板上这类记录本不该出现，但聚合器不能因一条坏记录整批失败）。
 *
 * @param {unknown[]} records 黑板 source 记录数组
 * @returns {{ sources: AggregatedSource[], duplicates: number }} duplicates = 被合并掉的重复引文数
 * @throws {SourcesError} records 不是数组
 */
export function aggregateSources(records) {
  if (!Array.isArray(records)) {
    throw new SourcesError('aggregateSources 需要 source 记录数组，实际收到 ' + describe(records))
  }

  /** @type {Map<string, { url: string, quotes: SourceQuote[], seen: Set<string> }>} */
  const groups = new Map()
  let duplicates = 0

  for (const record of records) {
    const item = readRecord(record)
    if (item === null) continue
    const { key, url } = normalizeRef(item.ref)
    let group = groups.get(key)
    if (group === undefined) {
      group = { url, quotes: [], seen: new Set() }
      groups.set(key, group)
    }
    if (group.seen.has(item.quote)) {
      duplicates += 1
      continue
    }
    group.seen.add(item.quote)
    group.quotes.push({ quote: item.quote, by: item.by, seq: item.seq })
  }

  /** @type {AggregatedSource[]} */
  const sources = []
  for (const group of groups.values()) {
    const conflict = group.quotes.length > 1
    /** @type {AggregatedSource} */
    const entry = { url: group.url, quotes: group.quotes, conflict }
    if (conflict) entry.conflictReason = conflictReason(group.quotes)
    sources.push(entry)
  }

  sources.sort((left, right) => right.quotes.length - left.quotes.length || compareText(left.url, right.url))
  return { sources, duplicates }
}
