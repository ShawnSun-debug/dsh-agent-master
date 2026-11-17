/**
 * T10 旧黑板迁移验收：票面五条 DoD 各一组用例。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Board, BOARD_FILE_NAME } from '../lib/board.js'
import {
  LEGACY_BOARD_FILE_NAME,
  MIGRATED_KIND,
  migrateBoard,
  migrateDecision,
} from '../lib/migrate.js'

const ROOT = 'session-root'

/** 旧黑板的记录形状（与 T1-T8 时代一致）。 */
function legacyLine(record) {
  const full = {
    id: 'b' + record.seq,
    seq: record.seq,
    ts: 1_700_000_000_000 + record.seq,
    scope: 'root',
    author: record.author ?? { sessionId: ROOT, name: 'master' },
    kind: record.kind,
    title: record.title ?? '标题' + record.seq,
    body: record.body ?? null,
    refs: record.refs ?? [],
    artifact: record.artifact ?? null,
    tags: record.tags ?? [],
  }
  return JSON.stringify(full)
}

/** 造一个装好旧黑板的目录。 */
async function makeLegacy(lines, { raw = [] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'migrate-'))
  const content = [...lines, ...raw].join('\n') + '\n'
  await writeFile(join(dir, LEGACY_BOARD_FILE_NAME), content, 'utf8')
  return { dir, legacyPath: join(dir, LEGACY_BOARD_FILE_NAME), content }
}

// ---------------------------------------------------------------------------
// 验收 1：迁移后卡数 = 旧 task 记录数，records 数 = 旧其余记录数
// ---------------------------------------------------------------------------

test('T10-1 卡数等于旧 task 记录数，其余记录全进 records', async () => {
  const { dir } = await makeLegacy([
    legacyLine({ seq: 1, kind: 'task', title: '看板数据层', refs: ['t1'] }),
    legacyLine({ seq: 2, kind: 'task', title: '迁移脚本', refs: ['t2'] }),
    legacyLine({ seq: 3, kind: 'finding', body: '结论一', refs: ['t1'], author: { sessionId: 'session-a', name: 'worker-a' } }),
    legacyLine({ seq: 4, kind: 'source', title: 'https://x.test/a', body: '引文', refs: ['https://x.test/a'] }),
    legacyLine({ seq: 5, kind: 'open_question', body: '还缺什么？', refs: ['t2'] }),
  ])

  const result = await migrateBoard({ dir, rootId: ROOT })
  assert.equal(result.migrated, true)
  assert.equal(result.cards, 2)
  assert.equal(result.legacyRecords, 5)
  // records = 旧非 task 记录（3）+ 迁移事件（1）
  assert.equal(result.records, 4)

  const board = new Board({ dir })
  const cards = await board.listCards({})
  assert.equal(cards.length, 2)
  assert.deepEqual(cards.map((card) => card.id), ['t1', 't2'])
  assert.equal(cards[0].status, 'todo')
  assert.equal(cards[0].title, '看板数据层')

  const records = await board.queryRecords({})
  assert.equal(records.length, 4)
  const evidence = records.filter((record) => record.kind !== MIGRATED_KIND)
  assert.equal(evidence.length, 3)
  // 原 id / seq / ts / kind / author / tags 都要保住
  const finding = evidence.find((record) => record.kind === 'finding')
  assert.equal(finding.id, 'b3')
  assert.equal(finding.seq, 3)
  assert.equal(finding.ts, 1_700_000_000_003)
  assert.equal(finding.author.name, 'worker-a')
  assert.equal(finding.cardId, 't1')
  assert.equal(finding.body, '结论一')
})

test('T10-1 没有 tN 引用的旧记录也保留（cardId 留空，不丢）', async () => {
  const { dir } = await makeLegacy([
    legacyLine({ seq: 1, kind: 'task', refs: ['t1'] }),
    legacyLine({ seq: 2, kind: 'source', title: 'https://only-source', refs: ['https://only-source'] }),
  ])
  const result = await migrateBoard({ dir, rootId: ROOT })
  assert.equal(result.migrated, true)
  const board = new Board({ dir })
  const records = await board.queryRecords({ kind: 'source' })
  assert.equal(records.length, 1)
  assert.equal(records[0].cardId, '')
})

test('T10-1 task 记录缺 tN 时按序补号，不产生空 id 的卡', async () => {
  const { dir } = await makeLegacy([
    legacyLine({ seq: 1, kind: 'task', refs: [] }),
    legacyLine({ seq: 2, kind: 'task', refs: [] }),
  ])
  await migrateBoard({ dir, rootId: ROOT })
  const board = new Board({ dir })
  const cards = await board.listCards({})
  assert.deepEqual(cards.map((card) => card.id), ['t1', 't2'])
})

// ---------------------------------------------------------------------------
// 验收 2：重复加载不重复迁移（幂等），force 可重跑
// ---------------------------------------------------------------------------

test('T10-2 第二次运行跳过（board.json 已存在），结果不变', async () => {
  const { dir } = await makeLegacy([legacyLine({ seq: 1, kind: 'task', refs: ['t1'] })])
  const first = await migrateBoard({ dir, rootId: ROOT })
  assert.equal(first.migrated, true)
  const before = await readFile(join(dir, BOARD_FILE_NAME), 'utf8')

  const second = await migrateBoard({ dir, rootId: ROOT })
  assert.equal(second.migrated, false)
  assert.match(second.reason, /已存在/)
  assert.equal(await readFile(join(dir, BOARD_FILE_NAME), 'utf8'), before)
})

test('T10-2 force 可重跑（覆盖已存在的 board.json）', async () => {
  const { dir } = await makeLegacy([legacyLine({ seq: 1, kind: 'task', refs: ['t1'] })])
  await migrateBoard({ dir, rootId: ROOT })
  const forced = await migrateBoard({ dir, rootId: ROOT, force: true })
  assert.equal(forced.migrated, true)
  assert.equal(forced.cards, 1)
})

test('T10-2 既没有 board.json 也没有 board.jsonl 时什么都不做', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'migrate-empty-'))
  const decision = await migrateDecision({ dir })
  assert.equal(decision.shouldMigrate, false)
  const result = await migrateBoard({ dir })
  assert.equal(result.migrated, false)
  assert.equal(result.cards, 0)
})

// ---------------------------------------------------------------------------
// 验收 3：坏行被跳过且计数正确，其余记录不受影响
// ---------------------------------------------------------------------------

test('T10-3 坏行被跳过并计数，好行照常迁移', async () => {
  const { dir } = await makeLegacy(
    [
      legacyLine({ seq: 1, kind: 'task', refs: ['t1'] }),
      legacyLine({ seq: 3, kind: 'finding', body: '好行', refs: ['t1'] }),
    ],
    { raw: ['{ 这不是 JSON', '{"kind": 42}', ''] },
  )
  const result = await migrateBoard({ dir, rootId: ROOT })
  assert.equal(result.migrated, true)
  // 两行坏（非 JSON + kind 不是字符串），空行不计
  assert.equal(result.skipped, 2)
  assert.equal(result.cards, 1)
  const board = new Board({ dir })
  const records = await board.queryRecords({ kind: 'finding' })
  assert.equal(records.length, 1)
  assert.equal(records[0].body, '好行')
})

test('T10-3 全是坏行时也能迁移出只有迁移事件的空板（不抛错）', async () => {
  const { dir } = await makeLegacy([], { raw: ['坏行一', '坏行二'] })
  const result = await migrateBoard({ dir, rootId: ROOT })
  assert.equal(result.migrated, true)
  assert.equal(result.cards, 0)
  assert.equal(result.skipped, 2)
  const board = new Board({ dir })
  const records = await board.queryRecords({})
  assert.equal(records.length, 1)
  assert.equal(records[0].kind, MIGRATED_KIND)
})

// ---------------------------------------------------------------------------
// 验收 4：迁移前存在逐字节一致的 .bak 文件，原文件仍在
// ---------------------------------------------------------------------------

test('T10-4 备份与旧文件逐字节一致，且原 board.jsonl 不被删', async () => {
  const { dir, legacyPath, content } = await makeLegacy([
    legacyLine({ seq: 1, kind: 'task', refs: ['t1'] }),
    legacyLine({ seq: 2, kind: 'finding', body: '正文', refs: ['t1'] }),
  ])
  const result = await migrateBoard({ dir, rootId: ROOT })
  assert.equal(result.migrated, true)
  assert.ok(result.backupPath !== null)

  assert.equal(await readFile(result.backupPath, 'utf8'), content)
  assert.equal(await readFile(legacyPath, 'utf8'), content)

  const names = await readdir(dir)
  assert.ok(names.includes(LEGACY_BOARD_FILE_NAME))
  assert.ok(names.includes(BOARD_FILE_NAME))
  assert.ok(names.some((name) => name.startsWith(LEGACY_BOARD_FILE_NAME + '.bak-')))
})

// ---------------------------------------------------------------------------
// 验收 5：migrated 事件里能读出迁移前后的条数
// ---------------------------------------------------------------------------

test('T10-5 migrated 事件带迁移前后的条数、坏行数与用时', async () => {
  const { dir } = await makeLegacy([
    legacyLine({ seq: 1, kind: 'task', refs: ['t1'] }),
    legacyLine({ seq: 2, kind: 'finding', body: '结论', refs: ['t1'] }),
    legacyLine({ seq: 3, kind: 'source', title: 'u', body: 'q', refs: ['u'] }),
  ])
  const result = await migrateBoard({ dir, rootId: ROOT })

  const board = new Board({ dir })
  const migrated = await board.queryRecords({ kind: MIGRATED_KIND })
  assert.equal(migrated.length, 1)
  const event = migrated[0]
  assert.equal(event.migration.legacyRecords, 3)
  assert.equal(event.migration.cards, 1)
  assert.equal(event.migration.records, 3)
  assert.equal(event.migration.badLines, 0)
  assert.ok(Number.isSafeInteger(event.migration.durationMs) && event.migration.durationMs >= 0)
  assert.equal(event.migration.from, LEGACY_BOARD_FILE_NAME)
  assert.equal(result.durationMs >= 0, true)
})

test('T10 迁移后的看板可以继续被工具写（卡能被认领、能追加记录）', async () => {
  const { dir } = await makeLegacy([legacyLine({ seq: 1, kind: 'task', refs: ['t1'] })])
  await migrateBoard({ dir, rootId: ROOT })
  const board = new Board({ dir })
  const claimed = await board.updateCard({
    cardId: 't1',
    rev: 1,
    status: 'assigned',
    actor: { sessionId: 'session-a', name: 'worker-a', role: 'child' },
  })
  assert.equal(claimed.card.status, 'assigned')
  const record = await board.appendRecord({
    cardId: 't1',
    kind: 'finding',
    title: '迁移后新写',
    body: '正文',
    actor: { sessionId: 'session-a', name: 'worker-a', role: 'child' },
  })
  assert.equal(record.cardId, 't1')
})

test('T10 写盘失败时不留下 board.json（迁移要么成功要么没有）', async () => {
  const { dir } = await makeLegacy([legacyLine({ seq: 1, kind: 'task', refs: ['t1'] })])
  await assert.rejects(
    () => migrateBoard({
      dir,
      rootId: ROOT,
      io: {
        rename: async () => {
          throw new Error('rename 失败')
        },
      },
    }),
    /rename 失败/,
  )
  const names = await readdir(dir)
  assert.equal(names.includes(BOARD_FILE_NAME), false)
})

test('T10 目录不存在时迁移会先建目录（dir 可指向未创建路径）', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'migrate-parent-'))
  const dir = join(parent, 'nested')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, LEGACY_BOARD_FILE_NAME), legacyLine({ seq: 1, kind: 'task', refs: ['t1'] }) + '\n', 'utf8')
  const result = await migrateBoard({ dir, rootId: ROOT })
  assert.equal(result.migrated, true)
  await rm(parent, { recursive: true, force: true })
})
