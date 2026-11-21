/**
 * T14 指挥台 dsh-Go 面板视图验收：纯函数 deckView 的结构、预算、动作与起草文本。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CARD_ACTIONS,
  DECK_VIEW_BUDGET,
  DECK_VIEW_MAX_CARDS,
  cardActions,
  cardText,
  deckView,
  draftText,
  headerRow,
  viewBytes,
  viewStats,
} from '../lib/deck-view.js'

/** 造一张卡行（形状与 buildDeck 的 rows 一致）。 */
function card(id, status, extra = {}) {
  return {
    id,
    label: extra.label ?? ('任务 ' + id),
    status,
    priority: extra.priority ?? 'P2',
    rev: 1,
    assignee: extra.assignee ?? null,
    sessionId: extra.sessionId ?? '',
    counts: { findings: 0, sources: 0, artifacts: 0, violations: extra.violations ?? 0 },
    updatedAt: 0,
  }
}

function snapshot(cards, countsExtra = {}) {
  const counts = { cards: cards.length, records: 0, violations: 0, todo: 0, assigned: 0, doing: 0, review: 0, done: 0, blocked: 0, ...countsExtra }
  return { version: 2, revision: 3, updatedAt: 0, cards, counts, recent: [] }
}

test('空看板：emptyState 指路，不出卡片文本', () => {
  const view = deckView(snapshot([]))
  assert.equal(view.v, 2)
  const empty = view.children.find((n) => n.type === 'emptyState')
  assert.ok(empty, '应有 emptyState')
  assert.equal(empty.title, '还没有下派任何子对话')
  assert.match(empty.message, /master_dispatch/)
  assert.ok(!JSON.stringify(view).includes('任务 '))
})

test('计数行五格：值来自 counts，违规为零时 tone=good', () => {
  const row = headerRow({ cards: 3, doing: 1, review: 1, violations: 0, records: 9 })
  const byLabel = Object.fromEntries(row.children.map((m) => [m.label, m]))
  assert.equal(byLabel['卡片'].value, 3)
  assert.equal(byLabel['在做'].value, 1)
  assert.equal(byLabel['待验收'].value, 1)
  assert.equal(byLabel['违规'].value, 0)
  assert.equal(byLabel['违规'].tone, 'good')
  assert.equal(byLabel['记录'].value, 9)
  assert.equal(byLabel['卡片'].tone, undefined, '未实证的 tone 不许乱用')
})

test('卡片行：id 状态 认领者 违规 标题都进文本', () => {
  const text = cardText(card('t1', 'doing', { assignee: { sessionId: 's', name: 'worker-a' }, violations: 2 }))
  assert.match(text, /^t1 开工中 · worker-a · ⚠违规2 /)
  assert.match(text, /任务 t1/)
  assert.equal(cardText(card('t2', 'review')), 't2 待验收 任务 t2')
})

test('起草文本：四动词齐全，未知动词与空卡号返回 null', () => {
  assert.equal(draftText('claim', 't1'), '认领 t1')
  assert.equal(draftText('doing', 't2'), '开工 t2')
  assert.equal(draftText('accept', 't3'), '验收 t3')
  assert.equal(draftText('rework', 't4'), '打回 t4：')
  assert.equal(draftText('explode', 't1'), null)
  assert.equal(draftText('accept', ''), null)
  assert.equal(draftText('accept', undefined), null)
})

test('动作映射：todo 认领 / assigned 开工 / review 验收+打回 / done 无按钮', () => {
  assert.deepEqual(CARD_ACTIONS.todo.map((a) => a.label), ['认领'])
  assert.deepEqual(CARD_ACTIONS.assigned.map((a) => a.label), ['开工'])
  assert.deepEqual(CARD_ACTIONS.review.map((a) => a.label), ['验收', '打回'])
  assert.ok(!('done' in CARD_ACTIONS))
  assert.ok(!('blocked' in CARD_ACTIONS))
  assert.equal(cardActions(card('t9', 'done')), null)
  const actions = cardActions(card('t3', 'review'))
  assert.equal(actions.type, 'actions')
  assert.ok(actions.items.length <= 4, '每卡动作 ≤4')
  for (const item of actions.items) {
    assert.equal(item.action.id, 'draft')
    assert.equal(item.action.args.cardId, 't3')
  }
  assert.deepEqual(actions.items.map((i) => i.action.args.verb), ['accept', 'rework'])
})

test('视图里动作只挂可操作卡，且 draft 动作带卡号与动词', () => {
  const view = deckView(snapshot([card('t1', 'todo'), card('t2', 'done'), card('t3', 'review')]))
  const raw = JSON.stringify(view)
  assert.ok(raw.includes('"verb":"claim"'))
  assert.ok(raw.includes('"verb":"accept"'))
  assert.ok(!raw.includes('"verb":"doing"'), '本例没有 assigned 卡')
  const actionsCount = (raw.match(/"type":"actions"/g) ?? []).length
  assert.equal(actionsCount, 2, 'done 卡无按钮')
})

test('超量卡片：截断到上限并给提示行，最坏预算仍全绿', () => {
  const cards = []
  for (let i = 1; i <= 30; i++) cards.push(card('t' + i, i % 2 ? 'review' : 'todo'))
  const view = deckView(snapshot(cards, { review: 15 }))
  const text = JSON.stringify(view)
  assert.ok(text.includes('t24 '), '第 24 张应渲染')
  assert.ok(!text.includes('t25 '), '第 25 张不应渲染')
  assert.ok(text.includes('还有 6 张未显示'))
  const stats = viewStats(view)
  assert.ok(stats.nodes <= DECK_VIEW_BUDGET.nodes, '节点 ' + stats.nodes)
  assert.ok(stats.depth <= DECK_VIEW_BUDGET.depth, '深度 ' + stats.depth)
  assert.ok(stats.maxChildren <= DECK_VIEW_BUDGET.children, '最大子数 ' + stats.maxChildren)
  assert.ok(viewBytes(view) <= DECK_VIEW_BUDGET.bytes, '字节 ' + viewBytes(view))
  assert.equal(view.children[0].children.find((m) => m.label === '待验收').value, 15, '计数是整板实况')
})

test('长标题截断到 40 字以内', () => {
  const long = '长'.repeat(80)
  const text = cardText(card('t1', 'todo', { label: long }))
  assert.ok(text.length < 60)
  assert.ok(text.endsWith('…'))
})

test('未知状态不抛错：原样透出且无按钮', () => {
  assert.match(cardText({ id: 't9', status: 'mystery', label: 'x' }), /t9 mystery/)
  assert.equal(cardActions({ id: 't9', status: 'mystery' }), null)
})

test('同输入同输出（纯函数）', () => {
  const snap = snapshot([card('t1', 'todo'), card('t2', 'blocked', { violations: 1 })])
  assert.deepEqual(deckView(snap), deckView({ ...snap, cards: snap.cards.map((c) => ({ ...c })) }))
})

test('预算常量自检：上限与官方口径一致', () => {
  assert.equal(DECK_VIEW_BUDGET.bytes, 32 * 1024)
  assert.equal(DECK_VIEW_BUDGET.nodes, 120)
  assert.equal(DECK_VIEW_BUDGET.depth, 8)
  assert.equal(DECK_VIEW_BUDGET.children, 32)
  assert.equal(DECK_VIEW_MAX_CARDS, 24)
})
