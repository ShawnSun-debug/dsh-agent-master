/**
 * T13 指挥台 deck v2 验收：快照契约（cards 带 status/assignee/priority/rev、records 只投影摘要）。
 *
 * 客户端渲染在 test/client.test.mjs；这里只管**数据契约**。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Board } from '../lib/board.js'
import { Ledger } from '../lib/ledger.js'
import { DECK_STATE_VERSION, DECK_VERSION, DeckError, buildDeck, deckStateSchema } from '../lib/deck.js'

const MASTER = { sessionId: 'session-root', name: 'master', role: 'master' }
const CHILD = { sessionId: 'session-a', name: 'worker-a', role: 'child' }

/** 造一块有内容的看板。 */
async function makeBoard() {
  const dir = await mkdtemp(join(tmpdir(), 'deck-'))
  const board = new Board({ dir })
  const ledger = new Ledger({ dir })
  return { dir, board, ledger }
}

/** 一路完整流程：建卡 → 认领 → 开工 → 交 final。 */
async function runOneCard(board, { id, title, priority }) {
  const card = await board.createCard({ title, priority, actor: MASTER, ...(id === undefined ? {} : { id }) })
  let current = await board.updateCard({ cardId: card.id, rev: card.rev, status: 'assigned', actor: CHILD })
  current = await board.updateCard({ cardId: card.id, rev: current.card.rev, status: 'doing', actor: CHILD })
  await board.appendRecord({ cardId: card.id, kind: 'finding', title: '结论', body: '正文', tags: ['report'], actor: CHILD })
  current = await board.updateCard({ cardId: card.id, rev: current.card.rev, status: 'review', actor: CHILD })
  return current.card
}

test('deck：版本号是 2（v1 客户端必须被判定为不兼容）', async () => {
  assert.equal(DECK_VERSION, 2)
  assert.equal(DECK_STATE_VERSION, 2)
  const { board } = await makeBoard()
  const deck = await buildDeck({ board })
  assert.equal(deck.version, 2)
})

test('deck：cards 直接带 status / assignee / priority / rev', async () => {
  const { board } = await makeBoard()
  const card = await runOneCard(board, { title: '看板数据层', priority: 'P1' })
  const deck = await buildDeck({ board })

  assert.equal(deck.cards.length, 1)
  const row = deck.cards[0]
  assert.equal(row.id, card.id)
  assert.equal(row.label, '看板数据层')
  assert.equal(row.status, 'review')
  assert.equal(row.priority, 'P1')
  assert.equal(row.rev, card.rev)
  assert.equal(row.assignee.sessionId, CHILD.sessionId)
  assert.equal(row.assignee.name, 'worker-a')
  // 点卡开子对话 tab 用
  assert.equal(typeof row.sessionId, 'string')
})

test('deck：六种状态都能投影（计数按状态分开）', async () => {
  const { board } = await makeBoard()
  const statuses = ['todo', 'assigned', 'doing', 'review', 'done', 'blocked']
  for (const [index, status] of statuses.entries()) {
    const card = await board.createCard({ title: status, actor: MASTER, id: 't' + (index + 1) })
    if (status === 'todo') continue
    const claimed = await board.updateCard({ cardId: card.id, rev: card.rev, status: 'assigned', actor: CHILD })
    if (status === 'assigned') continue
    if (status === 'blocked') {
      await board.updateCard({ cardId: card.id, rev: claimed.card.rev, status: 'blocked', actor: CHILD, reason: '等' })
      continue
    }
    const doing = await board.updateCard({ cardId: card.id, rev: claimed.card.rev, status: 'doing', actor: CHILD })
    if (status === 'doing') continue
    const review = await board.updateCard({ cardId: card.id, rev: doing.card.rev, status: 'review', actor: CHILD })
    if (status === 'review') continue
    await board.updateCard({ cardId: card.id, rev: review.card.rev, status: 'done', actor: MASTER })
  }

  const deck = await buildDeck({ board })
  assert.equal(deck.cards.length, 6)
  for (const status of statuses) assert.equal(deck.counts[status], 1, '状态 ' + status + ' 应各一张')
  assert.equal(deck.counts.cards, 6)
})

test('deck：records 只投影摘要字段，正文不进快照', async () => {
  const { board } = await makeBoard()
  await runOneCard(board, { title: '看板数据层' })
  const deck = await buildDeck({ board })
  const kinds = deck.recent.map((item) => item.kind)
  assert.ok(kinds.includes('finding'))
  for (const item of deck.recent) {
    assert.deepEqual(Object.keys(item).sort(), ['cardId', 'kind', 'seq', 'title'])
  }
  assert.equal(JSON.stringify(deck).includes('"body"'), false)
})

test('deck：最近时间线受 recentLimit 限制且按 seq 升序', async () => {
  const { board } = await makeBoard()
  await runOneCard(board, { title: 'A' })
  const deck = await buildDeck({ board, recentLimit: 2 })
  assert.equal(deck.recent.length, 2)
  assert.ok(deck.recent[0].seq < deck.recent[1].seq)
})

test('deck：按卡统计 findings/sources/artifacts/violations', async () => {
  const { board } = await makeBoard()
  const card = await board.createCard({ title: 'A', actor: MASTER })
  await board.appendRecord({ cardId: card.id, kind: 'finding', title: 'f', body: '', tags: ['violation:forbidden:别用 X'], actor: CHILD })
  await board.appendRecord({ cardId: card.id, kind: 'source', title: 'u', body: 'q', actor: CHILD })
  await board.appendRecord({ cardId: card.id, kind: 'artifact', title: 'p', body: '', actor: CHILD })

  const deck = await buildDeck({ board })
  const row = deck.cards[0]
  assert.deepEqual(row.counts, { findings: 1, sources: 1, artifacts: 1, violations: 1 })
  assert.equal(deck.counts.violations, 1)
})

test('deck：names 过滤只缩 cards，counts 仍描述整块看板', async () => {
  const { board } = await makeBoard()
  await runOneCard(board, { title: 'A', id: 't1' })
  await runOneCard(board, { title: 'B', id: 't2' })
  const deck = await buildDeck({ board, names: ['t1'] })
  assert.equal(deck.cards.length, 1)
  assert.equal(deck.cards[0].id, 't1')
  assert.equal(deck.counts.cards, 2)
})

test('deck：空看板也能出合法快照', async () => {
  const { board } = await makeBoard()
  const deck = await buildDeck({ board })
  assert.equal(deck.cards.length, 0)
  assert.equal(deck.counts.cards, 0)
  assert.deepEqual(deck.recent, [])
  assert.doesNotThrow(() => deckStateSchema.parse(deck))
})

test('deck：buildDeck 缺少 board 依赖时抛 DeckError', async () => {
  await assert.rejects(() => buildDeck({}), DeckError)
  await assert.rejects(() => buildDeck({ board: { head: () => ({}) } }), DeckError)
})

// ---------------------------------------------------------------------------
// 契约校验：v1 旧快照 → null（占位），坏 v2 → 抛错
// ---------------------------------------------------------------------------

test('deck：v1 旧快照（没有 version 或 version=1）返回 null 而不是抛错', async () => {
  assert.equal(deckStateSchema.parse({ headSeq: 3, children: [] }), null)
  assert.equal(deckStateSchema.parse({ version: 1, children: [] }), null)
  assert.equal(deckStateSchema.parse(null), null)
})

test('deck：合法的 v2 快照通过校验', async () => {
  const { board } = await makeBoard()
  await runOneCard(board, { title: 'A' })
  const deck = await buildDeck({ board })
  assert.equal(deckStateSchema.parse(deck), deck)
})

test('deck：坏 v2（状态/优先级/rev 非法）抛 DeckStateError', async () => {
  const { board } = await makeBoard()
  await runOneCard(board, { title: 'A' })
  const deck = await buildDeck({ board })

  const badStatus = structuredClone(deck)
  badStatus.cards[0].status = 'finished'
  assert.throws(() => deckStateSchema.parse(badStatus), /status/)

  const badPriority = structuredClone(deck)
  badPriority.cards[0].priority = 'P9'
  assert.throws(() => deckStateSchema.parse(badPriority), /priority/)

  const badRev = structuredClone(deck)
  badRev.cards[0].rev = -1
  assert.throws(() => deckStateSchema.parse(badRev), /rev/)
})
