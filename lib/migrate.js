/**
 * dsh-agent-master — T10：旧黑板 board.jsonl 迁移到看板 board.json。
 *
 * 背景：旧形态是 append-only JSONL（一行一条记录），新形态是 { cards, records }。
 * 迁移要满足四件事，缺一个就会在真机上出事故：
 *   1. 无损：task 记录变卡，其余记录原样进 records（保留 id/seq/ts/kind/author/tags）；
 *   2. 幂等：board.json 已存在就跳过（force 仅供测试重跑）；
 *   3. 可回滚：迁移前逐字节备份 board.jsonl，原文件保留不删；
 *   4. 不因坏行中断：坏行跳过并计数，其余照常迁。
 *
 * 迁移**自己写盘**（不经 Board API）：这一步就是在造 board.json，用不上去重/配额校验；
 * 写盘仍是临时文件 + 原子 rename。
 *
 * @module dsh-agent-master/migrate
 */

import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { BOARD_FILE_NAME, BOARD_VERSION, DEFAULT_PRIORITY } from './board.js'

/** 旧黑板文件名。 */
export const LEGACY_BOARD_FILE_NAME = 'board.jsonl'

/** 迁移事件在 records 里的 kind：审计里能看出「这块板是迁过来的」。 */
export const MIGRATED_KIND = 'migrated'

/** 卡号形状：t1、t2 …… */
const TASK_ID_PATTERN = /^t\d+$/

export class MigrateError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message)
    this.name = 'MigrateError'
  }
}

/**
 * 迁移原因：只有「有旧文件 + 没有新文件」才真跑。
 * @param {{dir: string, force?: boolean, io?: any}} options
 * @returns {Promise<{shouldMigrate: boolean, reason: string, legacyPath: string, targetPath: string}>}
 */
export async function migrateDecision({ dir, force = false, io = {} } = {}) {
  const fs = { readFile, mkdir, ...io }
  const legacyPath = join(dir, LEGACY_BOARD_FILE_NAME)
  const targetPath = join(dir, BOARD_FILE_NAME)
  if (force) return { shouldMigrate: true, reason: 'force', legacyPath, targetPath }
  let hasTarget = false
  try {
    await fs.readFile(targetPath, 'utf8')
    hasTarget = true
  } catch (error) {
    if (/** @type {{code?: string}} */ (error).code !== 'ENOENT') throw error
  }
  if (hasTarget) return { shouldMigrate: false, reason: 'board.json 已存在（幂等跳过）', legacyPath, targetPath }
  let hasLegacy = false
  try {
    await fs.readFile(legacyPath, 'utf8')
    hasLegacy = true
  } catch (error) {
    if (/** @type {{code?: string}} */ (error).code !== 'ENOENT') throw error
  }
  if (!hasLegacy) return { shouldMigrate: false, reason: '没有旧 board.jsonl，无需迁移', legacyPath, targetPath }
  return { shouldMigrate: true, reason: '首次加载：board.json 缺失且 board.jsonl 存在', legacyPath, targetPath }
}

/**
 * 备份文件名：board.jsonl.bak-<时间戳>（时间戳里冒号换成连字符，Windows 文件名才合法）。
 * @param {string} legacyPath
 * @param {number} ts
 * @returns {string}
 */
export function backupPathFor(legacyPath, ts) {
  const stamp = new Date(ts).toISOString().replace(/:/g, '-')
  return legacyPath + '.bak-' + stamp
}

/**
 * 把一条旧记录折算成新 records[] 里的一条。
 * @param {any} record
 * @param {Map<string, string>} cardIds 卡号 → 卡 id（迁移后一一对应）
 * @param {string} rootId
 * @param {number} now
 * @returns {any}
 */
function toRecord(record, cardIds, rootId, now) {
  const refs = Array.isArray(record.refs) ? record.refs.map(String) : []
  // 外键：refs 里第一个形如 tN 且在板上真有卡的号；没有就留空串（旧记录同样保留，不丢）
  let cardId = ''
  for (const ref of refs) {
    if (TASK_ID_PATTERN.test(ref) && cardIds.has(ref)) {
      cardId = ref
      break
    }
  }
  const author = record.author && typeof record.author === 'object'
    ? { sessionId: String(record.author.sessionId ?? ''), name: String(record.author.name ?? '') }
    : { sessionId: '', name: '' }
  return {
    id: String(record.id ?? ''),
    seq: Number.isSafeInteger(record.seq) ? record.seq : 0,
    ts: Number.isSafeInteger(record.ts) ? record.ts : now,
    cardId,
    kind: String(record.kind ?? 'finding'),
    author,
    actor: { sessionId: author.sessionId, name: author.name, role: author.sessionId === rootId ? 'master' : 'child' },
    title: String(record.title ?? ''),
    body: typeof record.body === 'string' ? record.body : '',
    refs,
    artifact: record.artifact ?? null,
    tags: Array.isArray(record.tags) ? record.tags.map(String) : [],
    migrated: true,
  }
}

/**
 * 读旧黑板、造新看板、备份、原子落盘。
 *
 * @param {{
 *   dir: string,
 *   rootId?: string,
 *   force?: boolean,
 *   now?: () => number,
 *   io?: Record<string, Function>,
 * }} [options]
 * @returns {Promise<{
 *   migrated: boolean, reason: string, cards: number, records: number, legacyRecords: number,
 *   skipped: number, durationMs: number, backupPath: string|null, targetPath: string,
 * }>}
 */
export async function migrateBoard(options = {}) {
  const { dir, rootId = 'legacy', force = false, now = () => Date.now(), io = {} } = options
  if (typeof dir !== 'string' || dir.trim() === '') throw new MigrateError('migrateBoard 需要一个非空的 dir')
  const fs = { readFile, writeFile, rename, mkdir, copyFile, ...io }

  const started = now()
  const decision = await migrateDecision({ dir, force, io: fs })
  if (!decision.shouldMigrate) {
    return {
      migrated: false,
      reason: decision.reason,
      cards: 0,
      records: 0,
      legacyRecords: 0,
      skipped: 0,
      durationMs: 0,
      backupPath: null,
      targetPath: decision.targetPath,
    }
  }

  let text
  try {
    text = await fs.readFile(decision.legacyPath, 'utf8')
  } catch (error) {
    if (/** @type {{code?: string}} */ (error).code === 'ENOENT') {
      return {
        migrated: false,
        reason: '没有旧 board.jsonl，无需迁移',
        cards: 0,
        records: 0,
        legacyRecords: 0,
        skipped: 0,
        durationMs: 0,
        backupPath: null,
        targetPath: decision.targetPath,
      }
    }
    throw error
  }

  // 1. 逐行解析：坏行跳过并计数，绝不让一行坏数据带走整块板
  /** @type {any[]} */
  const legacy = []
  let skipped = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    /** @type {any} */
    let record
    try {
      record = JSON.parse(line)
    } catch {
      skipped += 1
      continue
    }
    if (record === null || typeof record !== 'object' || typeof record.kind !== 'string') {
      skipped += 1
      continue
    }
    legacy.push(record)
  }

  // 2. task 记录 → 卡（保持旧顺序，缺 tN 的按序补号）
  /** @type {any[]} */
  const cards = []
  /** @type {Map<string, string>} */
  const cardIds = new Map()
  let fallback = 0
  for (const record of legacy) {
    if (record.kind !== 'task') continue
    const refs = Array.isArray(record.refs) ? record.refs.map(String) : []
    let taskId = refs.find((ref) => TASK_ID_PATTERN.test(ref)) ?? null
    if (taskId === null) {
      do {
        fallback += 1
        taskId = 't' + fallback
      } while (cardIds.has(taskId))
    }
    if (cardIds.has(taskId)) {
      // 同一个号出现两次（旧板理论上允许）：第二张顺延，避免覆盖
      do {
        fallback += 1
        taskId = 't' + fallback
      } while (cardIds.has(taskId))
    }
    cardIds.set(taskId, taskId)
    const ts = Number.isSafeInteger(record.ts) ? record.ts : now()
    const author = record.author && typeof record.author === 'object'
      ? { sessionId: String(record.author.sessionId ?? ''), name: String(record.author.name ?? '') }
      : { sessionId: '', name: '' }
    cards.push({
      id: taskId,
      rev: 1,
      status: 'todo',
      priority: DEFAULT_PRIORITY,
      assignee: null,
      title: String(record.title ?? taskId),
      body: typeof record.body === 'string' ? record.body : '',
      tags: Array.isArray(record.tags) ? record.tags.map(String) : [],
      refs,
      author,
      childSessionId: null,
      createdAt: ts,
      updatedAt: ts,
      migrated: true,
    })
  }

  // 3. 其余记录 → records[]（保留原 id/seq/ts/kind/author/tags）
  /** @type {any[]} */
  let records = []
  let nextSeq = 0
  for (const record of legacy) {
    if (record.kind === 'task') continue
    const converted = toRecord(record, cardIds, rootId, now())
    nextSeq += 1
    if (!Number.isSafeInteger(converted.seq) || converted.seq <= 0) converted.seq = nextSeq
    if (converted.id === '') converted.id = 'r' + converted.seq
    records.push(converted)
    nextSeq = Math.max(nextSeq, converted.seq)
  }

  // 4. 迁移事件：计数与用时写进一条记录，事后能查「这块板是哪次迁移来的」
  const durationMs = Math.max(0, now() - started)
  const migratedSeq = nextSeq + 1
  records.push({
    id: 'r' + migratedSeq,
    seq: migratedSeq,
    ts: now(),
    cardId: cards.length > 0 ? cards[0].id : '',
    kind: MIGRATED_KIND,
    author: { sessionId: rootId, name: 'master' },
    actor: { sessionId: rootId, name: 'master', role: 'master' },
    title: 'migrated · board.jsonl → board.json',
    body: '',
    refs: [],
    artifact: null,
    tags: ['migrated'],
    // migrated 事件的载荷：迁移前后的条数（验收第 5 条要能从记录里读出来）
    migration: {
      from: LEGACY_BOARD_FILE_NAME,
      legacyRecords: legacy.length,
      badLines: skipped,
      cards: cards.length,
      // 迁移**之后**的 records 条数（含这条迁移事件本身），调用方不用自己 +1
      records: records.length + 1,
      durationMs,
      at: now(),
    },
  })

  const state = { version: BOARD_VERSION, headSeq: migratedSeq, cards, records }

  // 5. 备份（逐字节复制）→ 原子写 board.json
  const backupPath = backupPathFor(decision.legacyPath, now())
  await fs.copyFile(decision.legacyPath, backupPath)
  await fs.mkdir(dir, { recursive: true })
  const temp = decision.targetPath + '.tmp-' + process.pid
  await fs.writeFile(temp, JSON.stringify(state, null, 2) + String.fromCharCode(10), 'utf8')
  await fs.rename(temp, decision.targetPath)

  return {
    migrated: true,
    reason: decision.reason,
    cards: cards.length,
    // records 里除迁移事件外的条数 = 旧非 task 记录数（票面验收第 1 条）
    records: records.length,
    legacyRecords: legacy.length,
    skipped,
    durationMs,
    backupPath,
    targetPath: decision.targetPath,
  }
}
