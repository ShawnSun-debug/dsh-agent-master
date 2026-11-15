/**
 * dsh-agent-master — 指挥台数据（deck）单测（T5）。
 *
 * 全部用假 board：deck 必须是纯读，测试里 append/get 一被调用就算失败。
 * 假 board 的 query/head 语义照抄 lib/board.js（seq 升序、sinceSeq/kind/tag 过滤、返回克隆）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DECK_EVENT, DECK_STATE_VERSION, buildDeck, deckStateSchema } from '../lib/deck.js'

/**
 * 造一条黑板记录（字段与 lib/board.js 的 BoardRecord 一致）
 * @param {number} seq
 * @param {string} kind
 * @param {string | null} name 作者名；null 表示 master
 * @param {object} [extra]
 */
function rec(seq, kind, name, extra = {}) {
  const sessionId = extra.sessionId ?? (name === null ? 'root-1' : 'sess-' + name)
  const author = { sessionId, name: name === null ? 'master' : name }
  return {
    id: 'b' + seq,
    seq,
    ts: 1_700_000_000_000 + seq,
    scope: 'root',
    author,
    kind,
    title: extra.title ?? kind + ' ' + seq,
    body: extra.body ?? '',
    refs: extra.refs ?? [],
    artifact: extra.artifact ?? null,
    tags: extra.tags ?? [],
  }
}

/**
 * 假 board：只读接口齐全，写入接口一律炸掉（用来证明 deck 纯读）。
 * @param {object[]} records
 */
function fakeBoard(records = []) {
  const calls = []
  return {
    calls,
    async head() {
      calls.push('head')
      return { seq: records.reduce((max, record) => Math.max(max, record.seq), 0) }
    },
    async query(filter = {}) {
      calls.push('query')
      const { kind, tag, sinceSeq = 0, limit = 100 } = filter
      return records
        .filter((record) => record.seq > sinceSeq)
        .filter((record) => kind === undefined || record.kind === kind)
        .filter((record) => tag === undefined || record.tags.includes(tag))
        .sort((a, b) => a.seq - b.seq)
        .slice(0, limit)
        .map((record) => structuredClone(record))
    },
    async append() {
      throw new Error('deck 不许写黑板：append 被调用了')
    },
    async get() {
      throw new Error('deck 不许按 id 读：get 被调用了')
    },
  }
}

test('deck：空板返回 0 头指针、空 children、全 0 counts 与空 recent', async () => {
  const deck = await buildDeck({ board: fakeBoard(), rootId: 'root-1' })
  assert.equal(deck.headSeq, 0)
  assert.deepEqual(deck.children, [])
  assert.deepEqual(deck.recent, [])
  assert.deepEqual(deck.counts, { tasks: 0, findings: 0, sources: 0, artifacts: 0, violations: 0 })
  assert.equal(typeof deck.updatedAt, 'number')
  assert.ok(deck.updatedAt > 0)
})

test('deck：三路归组——只下派 assigned、已回报 reported、带违规 violated', async () => {
  const board = fakeBoard([
    rec(1, 'task', null, { title: '查清 X 是否成立', refs: ['t1'], tags: ['assign'] }),
    rec(2, 'task', null, { title: '梳理 Y 的调用链', refs: ['t2'], tags: ['assign'] }),
    rec(3, 'task', null, { title: '改 Z 的边界条件', refs: ['t3'], tags: ['assign'] }),
    // t2 已回报：1 条 finding + 1 条 source + 1 条 artifact
    rec(4, 'finding', 'agent-1', { title: 'finding · t2 · 台账v1', body: '梳理完成', refs: ['t2'], tags: ['report'] }),
    rec(5, 'source', 'agent-1', { title: 'https://example.com/a', refs: ['https://example.com/a'], tags: ['evidence'] }),
    rec(6, 'artifact', 'agent-1', { title: 'src/z.js', refs: ['src/z.js'], artifact: { path: 'src/z.js' }, tags: ['report'] }),
    // t3 回报但踩了台账 forbidden
    rec(7, 'finding', 'agent-2', {
      title: 'finding · t3 · 台账v1',
      body: '大概是 Z',
      refs: ['t3'],
      tags: ['report', 'violation:forbidden:大概'],
    }),
  ])

  const deck = await buildDeck({ board, rootId: 'root-1' })
  assert.equal(deck.headSeq, 7)
  assert.deepEqual(
    deck.children.map((child) => [child.taskId, child.name, child.status]),
    [
      ['t1', 't1', 'assigned'],
      ['t2', 'agent-1', 'reported'],
      ['t3', 'agent-2', 'violated'],
    ],
  )
  // 只下派没回报：label 用 task 记录的 goal（黑板上唯一的信息），计数全 0
  assert.equal(deck.children[0].label, '查清 X 是否成立')
  assert.equal(deck.children[0].findings, 0)
  assert.equal(deck.children[0].violations, 0)
  // 已回报：label 用子对话名，计数逐个对上
  assert.equal(deck.children[1].label, 'agent-1')
  assert.equal(deck.children[1].findings, 1)
  assert.equal(deck.children[1].evidence, 1)
  assert.equal(deck.children[1].artifacts, 1)
  assert.equal(deck.children[1].violations, 0)
  // 违规：status 让位于 violated，violations 计数 1
  assert.equal(deck.children[2].violations, 1)
})

test('deck：status 优先级 violated > reported > assigned', async () => {
  const board = fakeBoard([
    rec(1, 'task', null, { title: 'A', refs: ['t1'] }),
    // 同一条 finding 既算回报又带违规：两个计数都在，status 必须是 violated
    rec(2, 'finding', 'agent-1', {
      refs: ['t1'],
      body: 'X',
      tags: ['report', 'violation:boundary:a.md', 'violation:forbidden:也许'],
    }),
  ])
  const deck = await buildDeck({ board, rootId: 'root-1' })
  assert.equal(deck.children.length, 1)
  assert.equal(deck.children[0].status, 'violated')
  assert.equal(deck.children[0].findings, 1)
  assert.equal(deck.children[0].violations, 2)
})

test('deck：counts 统计五类记录与违规总数', async () => {
  const board = fakeBoard([
    rec(1, 'task', null, { title: 'A', refs: ['t1'] }),
    rec(2, 'task', null, { title: 'B', refs: ['t2'] }),
    rec(3, 'finding', 'agent-1', { refs: ['t1'], tags: ['report', 'violation:forbidden:大概'] }),
    rec(4, 'finding', 'agent-2', { refs: ['t2'], tags: ['report'] }),
    rec(5, 'source', 'agent-1', { refs: ['https://a.example/1'] }),
    rec(6, 'source', 'agent-2', { refs: ['https://b.example/2'] }),
    rec(7, 'artifact', 'agent-2', { refs: ['out.md'], artifact: { path: 'out.md' } }),
    rec(8, 'open_question', 'agent-2', { refs: ['t2'] }),
    rec(9, 'decision', null, { title: '先做 A' }),
  ])
  const deck = await buildDeck({ board, rootId: 'root-1' })
  assert.deepEqual(deck.counts, { tasks: 2, findings: 2, sources: 2, artifacts: 1, violations: 1 })
})

test('deck：recent 取最后 recentLimit 条（按 seq 升序，只留 seq/kind/title）', async () => {
  const records = []
  for (let seq = 1; seq <= 15; seq += 1) {
    records.push(rec(seq, seq % 2 === 0 ? 'finding' : 'source', 'agent-1', { title: '标题 ' + seq }))
  }
  const board = fakeBoard(records)

  const full = await buildDeck({ board, rootId: 'root-1' })
  assert.equal(full.recent.length, 12)
  assert.deepEqual(full.recent.at(-1), { seq: 15, kind: 'source', title: '标题 15' })
  assert.equal(full.recent[0].seq, 4)

  const tail = await buildDeck({ board, rootId: 'root-1', recentLimit: 3 })
  assert.deepEqual(tail.recent.map((item) => item.seq), [13, 14, 15])
  assert.deepEqual(Object.keys(tail.recent[0]).sort(), ['kind', 'seq', 'title'])

  const none = await buildDeck({ board, rootId: 'root-1', recentLimit: 0 })
  assert.deepEqual(none.recent, [])
})

test('deck：names 过滤只保留点名的子对话（任务号也能点名）', async () => {
  const board = fakeBoard([
    rec(1, 'task', null, { title: 'A', refs: ['t1'] }),
    rec(2, 'task', null, { title: 'B', refs: ['t2'] }),
    rec(3, 'finding', 'agent-1', { refs: ['t1'], tags: ['report'] }),
    rec(4, 'finding', 'agent-2', { refs: ['t2'], tags: ['report'] }),
  ])
  const byName = await buildDeck({ board, rootId: 'root-1', names: ['agent-2'] })
  assert.deepEqual(byName.children.map((child) => child.name), ['agent-2'])
  // counts 与 recent 仍描述整块黑板，不随过滤缩水
  assert.deepEqual(byName.counts, { tasks: 2, findings: 2, sources: 0, artifacts: 0, violations: 0 })
  assert.equal(byName.recent.length, 4)

  const byTask = await buildDeck({ board, rootId: 'root-1', names: ['t2'] })
  assert.deepEqual(byTask.children.map((child) => child.name), ['agent-2'])
})

test('deck：纯读——不调 append/get，两次调用互不影响', async () => {
  const board = fakeBoard([
    rec(1, 'task', null, { title: 'A', refs: ['t1'] }),
    rec(2, 'finding', 'agent-1', { refs: ['t1'], tags: ['report'] }),
  ])
  const first = await buildDeck({ board, rootId: 'root-1' })
  const second = await buildDeck({ board, rootId: 'root-1' })
  assert.deepEqual(first, second)
  // 没有写路径
  assert.ok(!board.calls.includes('append'))
  // children 是独立对象：改第一份不影响第二份
  first.children[0].name = '被改坏了'
  assert.equal((await buildDeck({ board, rootId: 'root-1' })).children[0].name, 'agent-1')
})

test('deck：缺 board 时抛中文错误', async () => {
  await assert.rejects(buildDeck({ rootId: 'root-1' }), /board/)
  await assert.rejects(buildDeck({ board: { head: async () => ({ seq: 0 }) } }), /board/)
})

test('deck：契约常量与 stateSchema——真实产物必须能过宿主校验', async () => {
  assert.equal(DECK_STATE_VERSION, 1)
  assert.equal(DECK_EVENT, 'agent-master/deck')

  const board = fakeBoard([
    rec(1, 'task', null, { title: '查清 X', refs: ['t1'] }),
    rec(2, 'task', null, { title: '梳理 Y', refs: ['t2'] }),
    rec(3, 'finding', 'agent-1', { refs: ['t2'], body: '完成', tags: ['report', 'violation:forbidden:大概'] }),
    rec(4, 'source', 'agent-1', { refs: ['https://example.com/a'] }),
  ])
  const deck = await buildDeck({ board, rootId: 'root-1' })
  // 宿主会对 init 值与每个 deck 事件后的状态调 stateSchema.parse，形状必须一致
  assert.equal(deckStateSchema.parse(null), null)
  assert.equal(deckStateSchema.parse(deck), deck)
  for (const child of deck.children) {
    assert.equal(typeof child.name, 'string')
    assert.equal(typeof child.label, 'string')
    assert.equal(typeof child.taskId, 'string')
    assert.equal(typeof child.sessionId, 'string')
    assert.match(child.status, /^(assigned|reported|violated)$/)
  }
  // 坏形状必须报中文错误，而不是静默放行
  assert.throws(() => deckStateSchema.parse({ ...deck, children: [{ name: 'x' }] }), /label/)
  assert.throws(() => deckStateSchema.parse('不是对象'), /deck 状态/)
})

test('deck：children 带 sessionId（同一孩子取最早一条记录的 author.sessionId，assigned 行不借 master 的）', async () => {
  const board = fakeBoard([
    rec(1, 'task', null, { title: '查清 X', refs: ['t1'] }),
    rec(2, 'task', null, { title: '梳理 Y', refs: ['t2'] }),
    // agent-1 自己的两条记录 sessionId 不一致：seq 最小的那条是 sess-old
    rec(3, 'finding', 'agent-1', { refs: ['t1'], tags: ['report'], sessionId: 'sess-old' }),
    rec(4, 'source', 'agent-1', { refs: ['https://example.com/a'], sessionId: 'sess-new' }),
  ])
  const deck = await buildDeck({ board, rootId: 'root-1' })
  assert.deepEqual(
    deck.children.map((child) => [child.name, child.taskId, child.sessionId]),
    [
      ['agent-1', 't1', 'sess-old'],
      // t2 只有 task 记录，而 task 的 author 是 master：不能把 master 的 sessionId 当成孩子的
      ['t2', 't2', ''],
    ],
  )
  // schema 也要接受这个字段
  assert.equal(deckStateSchema.parse(deck), deck)
})

test('deck：author.sessionId 缺失时 sessionId 是空字符串', async () => {
  const board = fakeBoard([
    rec(1, 'task', null, { title: '查清 X', refs: ['t1'] }),
    { ...rec(2, 'finding', 'agent-9', { refs: ['t1'], tags: ['report'] }), author: { name: 'agent-9' } },
  ])
  const deck = await buildDeck({ board, rootId: 'root-1' })
  assert.equal(deck.children.length, 1)
  assert.equal(deck.children[0].name, 'agent-9')
  assert.equal(deck.children[0].sessionId, '')
  // 缺 sessionId 不影响状态判定
  assert.equal(deck.children[0].status, 'reported')
})
