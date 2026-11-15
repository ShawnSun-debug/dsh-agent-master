import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Board, BoardConflictError, BoardFullError, KINDS } from '../lib/board.js'

const AUTHOR = { sessionId: 'sess-master', name: 'master' }

/** 每个用例一个 os.tmpdir() 下的临时目录，用完删掉，不碰真实 ~/.dsh。 */
async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-am-board-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** 读黑板文件的有效行，用于断言"写盘条数"。 */
async function boardLines(dir) {
  const text = await readFile(join(dir, 'board.jsonl'), 'utf8')
  return text.split('\n').filter((line) => line.length > 0)
}

test('KINDS 是固定的六种记录种类', () => {
  assert.deepEqual(KINDS, ['task', 'finding', 'source', 'artifact', 'decision', 'open_question'])
})

test('空板 head.seq 为 0，首条记录 seq=1、字段顺序固定且写盘形状一致', async (t) => {
  const dir = await tempDir(t)
  const board = new Board({ dir, now: () => 1700000000000 })

  assert.deepEqual(await board.head(), { seq: 0 })

  const { record, headSeq, deduped } = await board.append({
    author: AUTHOR,
    kind: 'task',
    title: '派发任务',
    body: '正文',
    refs: ['issue#1'],
    tags: ['t1'],
  })

  assert.equal(deduped, false)
  assert.equal(headSeq, 1)
  assert.equal(record.id, 'b1')
  assert.equal(record.seq, 1)
  assert.equal(record.ts, 1700000000000)
  assert.equal(record.scope, 'root')
  assert.deepEqual(record.author, AUTHOR)
  assert.deepEqual(Object.keys(record), [
    'id',
    'seq',
    'ts',
    'scope',
    'author',
    'kind',
    'title',
    'body',
    'refs',
    'artifact',
    'tags',
  ])
  assert.deepEqual(await board.head(), { seq: 1 })

  const lines = await boardLines(dir)
  assert.equal(lines.length, 1)
  assert.deepEqual(JSON.parse(lines[0]), record)
})

test('同 title+body 按 sha256 去重：返回既有记录、不追加、不占 seq', async (t) => {
  const dir = await tempDir(t)
  const board = new Board({ dir })

  const first = await board.append({ author: AUTHOR, kind: 'finding', title: '结论', body: '内容' })
  const again = await board.append({
    author: { sessionId: 'sess-child', name: 'child' },
    kind: 'decision',
    title: '结论',
    body: '内容',
  })

  assert.equal(again.deduped, true)
  assert.deepEqual(again.record, first.record)
  assert.equal(again.headSeq, 1)
  assert.equal((await boardLines(dir)).length, 1)
  assert.deepEqual(await board.head(), { seq: 1 })

  // title 与 body 之间的 \u0000 分隔符避免拼接歧义：'结'+'论内容' 不等于 '结论'+'内容'
  const shifted = await board.append({ author: AUTHOR, kind: 'finding', title: '结', body: '论内容' })
  assert.equal(shifted.deduped, false)
  assert.equal(shifted.headSeq, 2)
})

test('CAS 冲突：expectedSeq 过期抛 BoardConflictError，currentSeq 是最新 seq 且不写盘', async (t) => {
  const dir = await tempDir(t)
  const board = new Board({ dir })
  await board.append({ author: AUTHOR, kind: 'task', title: '第一条', expectedSeq: 0 })

  const [first, conflict] = await Promise.allSettled([
    board.append({ author: AUTHOR, kind: 'task', title: '并发 A', expectedSeq: 1 }),
    board.append({ author: AUTHOR, kind: 'task', title: '并发 B', expectedSeq: 1 }),
  ])

  assert.equal(first.status, 'fulfilled')
  assert.equal(first.value.headSeq, 2)
  assert.equal(conflict.status, 'rejected')

  const error = conflict.reason
  assert.ok(error instanceof BoardConflictError)
  assert.equal(error.name, 'BoardConflictError')
  assert.equal(error.currentSeq, 2)
  assert.match(error.message, /expectedSeq/)
  assert.equal((await boardLines(dir)).length, 2)
  assert.deepEqual(await board.head(), { seq: 2 })

  // 按返回的最新 seq 重试即可继续，不丢数据
  const retry = await board.append({ author: AUTHOR, kind: 'task', title: '并发 B', expectedSeq: error.currentSeq })
  assert.equal(retry.record.seq, 3)
  assert.equal((await boardLines(dir)).length, 3)
})

test('并发追加被进程内 promise 队列串行化：seq 连续、一条不少', async (t) => {
  const dir = await tempDir(t)
  const board = new Board({ dir })

  const results = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      board.append({ author: AUTHOR, kind: 'finding', title: '发现 ' + index, body: null }),
    ),
  )

  assert.deepEqual(results.map((item) => item.record.seq), [1, 2, 3, 4, 5, 6, 7, 8])
  assert.equal((await boardLines(dir)).length, 8)

  const reopened = new Board({ dir })
  assert.deepEqual((await reopened.query({ limit: 100 })).map((record) => record.seq), [1, 2, 3, 4, 5, 6, 7, 8])
})

test('超过 maxEntries 抛 BoardFullError：不写盘、head 不变、错误给出可用查询建议', async (t) => {
  const dir = await tempDir(t)
  const board = new Board({ dir, maxEntries: 2 })
  await board.append({ author: AUTHOR, kind: 'finding', title: '一' })
  await board.append({ author: AUTHOR, kind: 'finding', title: '二' })

  await assert.rejects(
    () => board.append({ author: AUTHOR, kind: 'finding', title: '三' }),
    (error) => {
      assert.ok(error instanceof BoardFullError)
      assert.equal(error.name, 'BoardFullError')
      assert.match(error.message, /上限/)
      assert.match(error.message, /query\(\{ sinceSeq/)
      return true
    },
  )

  assert.deepEqual(await board.head(), { seq: 2 })
  assert.equal((await boardLines(dir)).length, 2)
})

test('满板时重复内容先命中缓存去重，不抛满板错误', async (t) => {
  const dir = await tempDir(t)
  const board = new Board({ dir, maxEntries: 1 })
  const first = await board.append({ author: AUTHOR, kind: 'finding', title: '唯一一条', body: '内容' })

  const again = await board.append({ author: AUTHOR, kind: 'finding', title: '唯一一条', body: '内容' })
  assert.equal(again.deduped, true)
  assert.deepEqual(again.record, first.record)
  assert.equal((await boardLines(dir)).length, 1)
})

test('query 支持 kind/tag/sinceSeq/limit 过滤且按 seq 升序返回', async (t) => {
  const dir = await tempDir(t)
  const board = new Board({ dir })

  await board.append({ author: AUTHOR, kind: 'finding', title: '发现', tags: ['search'] })
  await board.append({ author: AUTHOR, kind: 'source', title: '来源', tags: ['search', 'web'] })
  await board.append({ author: AUTHOR, kind: 'finding', title: '发现 2', tags: [] })
  await board.append({
    author: AUTHOR,
    kind: 'artifact',
    title: '产物',
    artifact: { path: 'artifacts/a.md', bytes: 12, sha256: 'abc', version: 1 },
  })

  assert.deepEqual((await board.query({ kind: 'finding' })).map((record) => record.id), ['b1', 'b3'])
  assert.deepEqual((await board.query({ tag: 'web' })).map((record) => record.id), ['b2'])
  assert.deepEqual((await board.query({ sinceSeq: 2 })).map((record) => record.id), ['b3', 'b4'])
  assert.deepEqual((await board.query({ limit: 2 })).map((record) => record.id), ['b1', 'b2'])
  assert.deepEqual(await board.query({ kind: 'decision' }), [])
  assert.equal((await board.query({ kind: 'artifact' }))[0].artifact.path, 'artifacts/a.md')
})

test('重新构造 Board 从 jsonl 重建索引，坏行跳过并计入 skipped', async (t) => {
  const dir = await tempDir(t)
  const board = new Board({ dir })
  await board.append({ author: AUTHOR, kind: 'finding', title: '一', body: '甲' })
  await board.append({ author: AUTHOR, kind: 'source', title: '二' })

  const file = join(dir, 'board.jsonl')
  const text = await readFile(file, 'utf8')
  await writeFile(
    file,
    text + '{这不是 JSON\n\n' + JSON.stringify({ hello: 'world' }) + '\n' + JSON.stringify({ id: 'b9', seq: 9 }) + '\n',
    'utf8',
  )

  const reopened = new Board({ dir })
  assert.deepEqual(await reopened.head(), { seq: 2 })
  assert.equal(reopened.skipped, 3)
  assert.deepEqual((await reopened.query({ limit: 10 })).map((record) => record.id), ['b1', 'b2'])
  assert.equal((await reopened.get('b2')).title, '二')
  assert.equal(await reopened.get('b9'), null)

  const appended = await reopened.append({ author: AUTHOR, kind: 'finding', title: '三' })
  assert.equal(appended.record.seq, 3)
})

test('非法 kind / 空 title / 非字符串 body 抛 TypeError', async (t) => {
  const dir = await tempDir(t)
  const board = new Board({ dir })

  await assert.rejects(() => board.append({ author: AUTHOR, kind: 'unknown', title: '标题' }), TypeError)
  await assert.rejects(() => board.append({ author: AUTHOR, kind: 'task', title: '' }), TypeError)
  await assert.rejects(() => board.append({ author: AUTHOR, kind: 'task', title: '标题', body: 42 }), TypeError)
  // 参数被拒时连文件都不该创建（没有任何成功的追加）
  await assert.rejects(() => boardLines(dir), { code: 'ENOENT' })
})
