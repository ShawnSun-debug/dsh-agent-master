/**
 * T09 看板数据层验收：七条 DoD 各一组用例。
 *
 * 约定：临时目录一律落在 os.tmpdir()（scripts/test.mjs 已把 TEMP 指到仓内 .test-tmp），
 * 不用 %TEMP% 的硬编码路径 —— 本机沙箱对系统临时目录不可写。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BOARD_FILE_NAME,
  Board,
  BoardConflictError,
  BoardCorruptError,
  BoardFullError,
  BoardRuleError,
  CARD_STATUSES,
  DEFAULT_PRIORITY,
  PRIORITIES,
} from '../lib/board.js'

const MASTER = { sessionId: 'session-root', name: 'master', role: 'master' }
const CHILD = { sessionId: 'session-a', name: 'worker-a', role: 'child' }
const OTHER = { sessionId: 'session-b', name: 'worker-b', role: 'child' }

/** 造一个空看板（测试库）。 */
async function makeBoard(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'board-'))
  const board = new Board({ dir, ...options })
  return { dir, board, file: join(dir, BOARD_FILE_NAME) }
}

/** 建卡并返回卡。 */
async function newCard(board, extra = {}) {
  return board.createCard({ title: '看板数据层', actor: MASTER, ...extra })
}

// ---------------------------------------------------------------------------
// 验收 1：无 rev 或 rev 过期的 updateCard 被拒，返回最新 rev
// ---------------------------------------------------------------------------

test('T09-1 不带 rev 的 updateCard 被拒，并回带最新 rev', async () => {
  const { board } = await makeBoard()
  const card = await newCard(board)

  await assert.rejects(
    () => board.updateCard({ cardId: card.id, status: 'assigned', actor: CHILD }),
    (error) => {
      assert.ok(error instanceof BoardConflictError)
      assert.equal(error.cardId, card.id)
      assert.equal(error.currentRev, card.rev)
      assert.match(error.message, /rev/)
      return true
    },
  )
  // 拒绝不留痕：卡还是原样
  const after = await board.getCard(card.id)
  assert.equal(after.card.rev, card.rev)
  assert.equal(after.card.status, 'todo')
})

test('T09-1 rev 过期（别处已改过）被拒，并回带**最新** rev', async () => {
  const { board } = await makeBoard()
  const card = await newCard(board)

  const claimed = await board.updateCard({ cardId: card.id, rev: card.rev, status: 'assigned', actor: CHILD })
  assert.equal(claimed.card.rev, card.rev + 1)

  await assert.rejects(
    () => board.updateCard({ cardId: card.id, rev: card.rev, status: 'doing', actor: CHILD }),
    (error) => {
      assert.ok(error instanceof BoardConflictError)
      assert.equal(error.currentRev, card.rev + 1)
      return true
    },
  )
})

test('T09-1 rev 匹配时改卡成功，rev 自增且不共用同一个 rev', async () => {
  const { board } = await makeBoard()
  const card = await newCard(board)
  const first = await board.updateCard({ cardId: card.id, rev: 1, status: 'assigned', actor: CHILD })
  const second = await board.updateCard({ cardId: card.id, rev: first.card.rev, status: 'doing', actor: CHILD })
  assert.equal(second.card.rev, 3)
  assert.equal(second.card.status, 'doing')
})

// ---------------------------------------------------------------------------
// 验收 2：todo 直接跳 done 被拒，错误里列出合法后继
// ---------------------------------------------------------------------------

test('T09-2 todo 直接跳 done 被拒，错误里列出合法后继', async () => {
  const { board } = await makeBoard()
  const card = await newCard(board)

  await assert.rejects(
    () => board.updateCard({ cardId: card.id, rev: card.rev, status: 'done', actor: MASTER }),
    (error) => {
      assert.ok(error instanceof BoardRuleError)
      assert.match(error.message, /非法状态转移/)
      assert.match(error.message, /todo/)
      assert.match(error.message, /done/)
      // 合法后继必须写进文案，模型才不用猜
      assert.match(error.message, /assigned/)
      assert.match(error.message, /blocked/)
      return true
    },
  )
})

test('T09-2 状态链 todo→assigned→doing→review→done 全程可走（master 收尾）', async () => {
  const { board } = await makeBoard()
  const card = await newCard(board)

  let current = await board.updateCard({ cardId: card.id, rev: 1, status: 'assigned', actor: CHILD })
  assert.equal(current.card.assignee.sessionId, CHILD.sessionId)

  current = await board.updateCard({ cardId: card.id, rev: current.card.rev, status: 'doing', actor: CHILD })
  current = await board.updateCard({ cardId: card.id, rev: current.card.rev, status: 'review', actor: CHILD })
  current = await board.updateCard({ cardId: card.id, rev: current.card.rev, status: 'done', actor: MASTER })

  assert.equal(current.card.status, 'done')
  assert.equal(CARD_STATUSES.includes(current.card.status), true)
})

test('T09-2 master 自领 todo→doing 可直接走，且 assignee 变成 master', async () => {
  const { board } = await makeBoard()
  const card = await newCard(board)
  const current = await board.updateCard({ cardId: card.id, rev: 1, status: 'doing', actor: MASTER })
  assert.equal(current.card.status, 'doing')
  assert.equal(current.card.assignee.sessionId, MASTER.sessionId)
  assert.equal(current.card.assignee.name, 'master')
})

test('T09-2 子对话试图 todo→doing 被拒（不认领不开工）', async () => {
  const { board } = await makeBoard()
  const card = await newCard(board)
  await assert.rejects(
    () => board.updateCard({ cardId: card.id, rev: 1, status: 'doing', actor: CHILD }),
    (error) => {
      assert.ok(error instanceof BoardRuleError)
      assert.match(error.message, /认领/)
      return true
    },
  )
})

test('T09-2 blocked 可从 doing 进入，解除回 todo 只允许 master', async () => {
  const { board } = await makeBoard()
  const card = await newCard(board)
  let current = await board.updateCard({ cardId: card.id, rev: 1, status: 'assigned', actor: CHILD })
  current = await board.updateCard({ cardId: card.id, rev: current.card.rev, status: 'doing', actor: CHILD })
  current = await board.updateCard({ cardId: card.id, rev: current.card.rev, status: 'blocked', actor: CHILD, reason: '等上游' })
  assert.equal(current.card.status, 'blocked')

  // 子对话不能自己解除
  await assert.rejects(
    () => board.updateCard({ cardId: card.id, rev: current.card.rev, status: 'todo', actor: CHILD }),
    (error) => error instanceof BoardRuleError,
  )
  // master 可以
  const released = await board.updateCard({ cardId: card.id, rev: current.card.rev, status: 'todo', actor: MASTER })
  assert.equal(released.card.status, 'todo')
})

// ---------------------------------------------------------------------------
// 验收 3：子对话把卡翻成 done 被拒；master 翻成功
// ---------------------------------------------------------------------------

test('T09-3 子对话翻 done 被拒，master 翻成功', async () => {
  const { board } = await makeBoard()
  const card = await newCard(board)
  let current = await board.updateCard({ cardId: card.id, rev: 1, status: 'assigned', actor: CHILD })
  current = await board.updateCard({ cardId: card.id, rev: current.card.rev, status: 'doing', actor: CHILD })
  current = await board.updateCard({ cardId: card.id, rev: current.card.rev, status: 'review', actor: CHILD })

  await assert.rejects(
    () => board.updateCard({ cardId: card.id, rev: current.card.rev, status: 'done', actor: CHILD }),
    (error) => {
      assert.ok(error instanceof BoardRuleError)
      assert.match(error.message, /done 只能由 master 置/)
      return true
    },
  )
  const done = await board.updateCard({ cardId: card.id, rev: current.card.rev, status: 'done', actor: MASTER })
  assert.equal(done.card.status, 'done')
})

test('T09-3 子对话不能翻别人名下的卡', async () => {
  const { board } = await makeBoard()
  const card = await newCard(board)
  let current = await board.updateCard({ cardId: card.id, rev: 1, status: 'assigned', actor: CHILD })
  current = await board.updateCard({ cardId: card.id, rev: current.card.rev, status: 'doing', actor: CHILD })

  await assert.rejects(
    () => board.updateCard({ cardId: card.id, rev: current.card.rev, status: 'review', actor: OTHER }),
    (error) => {
      assert.ok(error instanceof BoardRuleError)
      assert.match(error.message, /不在你名下/)
      return true
    },
  )
})

test('T09-3 状态不变地重发 assigned 也不能绕过归属检查（回归：曾被 rev 自增绕过）', async () => {
  const { board } = await makeBoard()
  const card = await newCard(board)
  const claimed = await board.updateCard({ cardId: card.id, rev: 1, status: 'assigned', actor: CHILD })
  // OTHER 发一个「状态与当前相同」的 update：没有转移，但也不该被允许
  await assert.rejects(
    () => board.updateCard({ cardId: card.id, rev: claimed.card.rev, status: 'assigned', actor: OTHER }),
    (error) => {
      assert.ok(error instanceof BoardRuleError)
      assert.match(error.message, /不在你名下/)
      return true
    },
  )
  // 卡的 rev 没有被这次被拒的调用推进
  const after = await board.getCard(card.id)
  assert.equal(after.card.rev, claimed.card.rev)
})

test('T09-3 已被认领（todo 但已挂人）的卡不能被别人认领', async () => {
  const { board } = await makeBoard()
  // master 预先把 todo 卡挂给 worker-a：此时状态仍是 todo，但归属已定
  const card = await newCard(board, { assignee: { sessionId: CHILD.sessionId, name: 'worker-a' } })
  assert.equal(card.status, 'todo')
  await assert.rejects(
    () => board.updateCard({ cardId: card.id, rev: 1, status: 'assigned', actor: OTHER }),
    (error) => {
      assert.ok(error instanceof BoardRuleError)
      assert.match(error.message, /已被 worker-a 认领/)
      return true
    },
  )
  // 本人认领则成功，assignee 保持是自己
  const claimed = await board.updateCard({ cardId: card.id, rev: 1, status: 'assigned', actor: CHILD })
  assert.equal(claimed.card.assignee.sessionId, CHILD.sessionId)
})

// ---------------------------------------------------------------------------
// 验收 4：每次状态变更后 records 里能查到对应事件，from/to/actor 齐全
// ---------------------------------------------------------------------------

test('T09-4 每次状态变更都追加一条 card_status，from/to/actor/reason/ts 齐全', async () => {
  const { board } = await makeBoard()
  const card = await newCard(board)
  let current = await board.updateCard({ cardId: card.id, rev: 1, status: 'assigned', actor: CHILD, reason: '认领' })
  current = await board.updateCard({ cardId: card.id, rev: current.card.rev, status: 'doing', actor: CHILD, reason: '开工' })

  const records = await board.queryRecords({ cardId: card.id, kind: 'card_status' })
  assert.equal(records.length, 2)

  const [claim, start] = records
  assert.equal(claim.kind, 'card_status')
  assert.equal(claim.cardId, card.id)
  assert.equal(claim.from, 'todo')
  assert.equal(claim.to, 'assigned')
  assert.equal(claim.reason, '认领')
  assert.equal(claim.actor.sessionId, CHILD.sessionId)
  assert.equal(claim.actor.role, 'child')
  assert.equal(typeof claim.ts, 'number')
  assert.ok(Number.isSafeInteger(claim.seq) && claim.seq > 0)

  assert.equal(start.from, 'assigned')
  assert.equal(start.to, 'doing')
  assert.equal(start.seq, claim.seq + 1)
})

test('T09-4 只改字段（不改状态）不写 card_status', async () => {
  const { board } = await makeBoard()
  const card = await newCard(board)
  const updated = await board.updateCard({ cardId: card.id, rev: 1, priority: 'P0', actor: MASTER })
  assert.equal(updated.record, null)
  const records = await board.queryRecords({ kind: 'card_status' })
  assert.deepEqual(records, [])
})

test('T09-4 card_status 不能被 appendRecord 伪造成普通记录', async () => {
  const { board } = await makeBoard()
  const card = await newCard(board)
  await assert.rejects(
    () => board.appendRecord({ cardId: card.id, kind: 'card_status', title: '假审计', actor: MASTER }),
    (error) => {
      assert.ok(error instanceof BoardRuleError)
      assert.match(error.message, /kind/)
      return true
    },
  )
})

// ---------------------------------------------------------------------------
// 验收 5：写入中途被中断，board.json 仍是上一份完整内容（无半截文件）
// ---------------------------------------------------------------------------

test('T09-5 写盘失败时 board.json 保持上一份完整内容', async () => {
  const { dir, board, file } = await makeBoard()
  const card = await newCard(board)
  const before = await readFile(file, 'utf8')
  const parsedBefore = JSON.parse(before)
  assert.equal(parsedBefore.cards.length, 1)

  // 注入一个「写到一半就失败」的写入器
  const broken = new Board({
    dir,
    io: {
      writeFile: async () => {
        throw new Error('磁盘写满（模拟中断）')
      },
    },
  })
  await assert.rejects(
    () => broken.updateCard({ cardId: card.id, rev: 1, status: 'assigned', actor: CHILD }),
    /磁盘写满/,
  )

  // 盘上必须还是上一份完整 JSON，没有半截
  const after = await readFile(file, 'utf8')
  assert.equal(after, before)
  const parsedAfter = JSON.parse(after)
  assert.equal(parsedAfter.cards[0].status, 'todo')
  assert.equal(parsedAfter.cards[0].rev, 1)
})

test('T09-5 rename 失败时旧文件不被覆盖', async () => {
  const { dir, board, file } = await makeBoard()
  await newCard(board)
  const before = await readFile(file, 'utf8')

  const broken = new Board({
    dir,
    io: {
      rename: async () => {
        throw new Error('rename 被拒绝')
      },
    },
  })
  await assert.rejects(() => broken.createCard({ title: '第二张', actor: MASTER }), /rename 被拒绝/)
  assert.equal(await readFile(file, 'utf8'), before)
})

test('T09-5 内存状态在写盘失败后不前进（重试还能用同一个 rev）', async () => {
  const { dir, board } = await makeBoard()
  const card = await newCard(board)

  let fail = true
  const flaky = new Board({
    dir,
    io: {
      rename: async (...args) => {
        if (fail) {
          fail = false
          throw new Error('第一次 rename 失败')
        }
        const { rename } = await import('node:fs/promises')
        return rename(...args)
      },
    },
  })
  await assert.rejects(() => flaky.updateCard({ cardId: card.id, rev: 1, status: 'assigned', actor: CHILD }), /第一次 rename 失败/)
  const retried = await flaky.updateCard({ cardId: card.id, rev: 1, status: 'assigned', actor: CHILD })
  assert.equal(retried.card.rev, 2)
})

// ---------------------------------------------------------------------------
// 验收 6：cards 与 records 配额互不挤占（各自到顶各自报错）
// ---------------------------------------------------------------------------

test('T09-6 卡片配额到顶只挡建卡，不挡写证据流', async () => {
  const { board } = await makeBoard({ maxCards: 1, maxRecords: 10 })
  const card = await newCard(board)

  await assert.rejects(
    () => newCard(board, { title: '第二张' }),
    (error) => {
      assert.ok(error instanceof BoardFullError)
      assert.match(error.message, /看板卡已达上限 1/)
      return true
    },
  )
  // 证据流还能写
  const record = await board.appendRecord({ cardId: card.id, kind: 'finding', title: '证据一条', body: '正文', actor: MASTER })
  assert.equal(record.kind, 'finding')
})

test('T09-6 证据流配额到顶只挡记录，不挡建卡', async () => {
  const { board } = await makeBoard({ maxCards: 10, maxRecords: 1 })
  const card = await newCard(board)
  await board.appendRecord({ cardId: card.id, kind: 'finding', title: '第一条', actor: MASTER })

  await assert.rejects(
    () => board.appendRecord({ cardId: card.id, kind: 'finding', title: '第二条', actor: MASTER }),
    (error) => {
      assert.ok(error instanceof BoardFullError)
      assert.match(error.message, /证据流已达上限 1/)
      return true
    },
  )
  // 还能建卡
  const second = await newCard(board, { title: '第二张' })
  assert.equal(second.id, 't2')
})

test('T09-6 状态变更被记录配额挡住时，卡不会被改（原子性）', async () => {
  const { board } = await makeBoard({ maxCards: 10, maxRecords: 1 })
  const card = await newCard(board)
  // 先把唯一的记录名额占满
  await board.appendRecord({ cardId: card.id, kind: 'finding', title: '占满名额', actor: MASTER })
  await assert.rejects(
    () => board.updateCard({ cardId: card.id, rev: 1, status: 'assigned', actor: CHILD }),
    /证据流已达上限/,
  )
  const after = await board.getCard(card.id)
  assert.equal(after.card.status, 'todo')
  assert.equal(after.card.rev, 1)
})

// ---------------------------------------------------------------------------
// 验收 7：摘要视图不返回 records 正文；单卡视图返回
// ---------------------------------------------------------------------------

test('T09-7 摘要视图只有卡字段，不带 records', async () => {
  const { board } = await makeBoard()
  const card = await newCard(board)
  await board.appendRecord({ cardId: card.id, kind: 'finding', title: '结论', body: '很长很长的正文', actor: MASTER })

  const summary = await board.listCards({})
  assert.equal(summary.length, 1)
  assert.equal(summary[0].id, card.id)
  assert.equal(Object.prototype.hasOwnProperty.call(summary[0], 'records'), false)
  // 正文不能出现在摘要里
  assert.equal(JSON.stringify(summary).includes('很长很长的正文'), false)
})

test('T09-7 单卡视图返回卡 + 它名下的 records（别的卡的记录不串）', async () => {
  const { board } = await makeBoard()
  const card = await newCard(board)
  const other = await newCard(board, { title: '第二张' })
  await board.appendRecord({ cardId: card.id, kind: 'finding', title: '卡一结论', body: '甲的正文', actor: MASTER })
  await board.appendRecord({ cardId: other.id, kind: 'finding', title: '卡二结论', body: '乙的正文', actor: MASTER })

  const detail = await board.getCard(card.id)
  assert.equal(detail.card.id, card.id)
  assert.equal(detail.records.length, 1)
  assert.equal(detail.records[0].body, '甲的正文')
})

test('T09-7 listCards 支持按状态 / 认领者 / 优先级过滤', async () => {
  const { board } = await makeBoard()
  const a = await newCard(board, { title: 'A', priority: 'P0' })
  await newCard(board, { title: 'B', priority: 'P2' })
  await board.updateCard({ cardId: a.id, rev: 1, status: 'assigned', actor: CHILD })

  assert.equal((await board.listCards({ status: 'todo' })).length, 1)
  assert.equal((await board.listCards({ assignee: CHILD.sessionId })).length, 1)
  assert.equal((await board.listCards({ priority: 'P0' })).length, 1)
  assert.equal((await board.listCards({ status: ['todo', 'assigned'] })).length, 2)
})

// ---------------------------------------------------------------------------
// 其他契约：id/rev/priority/持久化/并发/外键/坏文件
// ---------------------------------------------------------------------------

test('T09 卡 id 是 t1..tN，被删的号不被复用（避免历史记录串卡）', async () => {
  const { board } = await makeBoard()
  const first = await newCard(board)
  const second = await newCard(board, { title: '第二张' })
  assert.equal(first.id, 't1')
  assert.equal(second.id, 't2')
  // 显式指定 id 也不允许覆盖已有卡
  await assert.rejects(() => board.createCard({ id: 't1', title: '撞号', actor: MASTER }), /卡 id 不可复用/)
})

test('T09 优先级默认 P2，非法 P 级被拒', async () => {
  const { board } = await makeBoard()
  const card = await newCard(board)
  assert.equal(card.priority, DEFAULT_PRIORITY)
  assert.deepEqual([...PRIORITIES], ['P0', 'P1', 'P2', 'P3'])
  await assert.rejects(() => newCard(board, { priority: 'P9' }), /priority 只能是/)
})

test('T09 新实例能读回盘上的看板（卡与记录都在）', async () => {
  const { dir, board } = await makeBoard()
  const card = await newCard(board)
  await board.updateCard({ cardId: card.id, rev: 1, status: 'assigned', actor: CHILD })
  await board.appendRecord({ cardId: card.id, kind: 'decision', title: '拍板', body: '用 board.json', actor: MASTER })

  const reopened = new Board({ dir })
  const detail = await reopened.getCard(card.id)
  assert.equal(detail.card.status, 'assigned')
  assert.equal(detail.records.length, 2) // card_status + decision
  const head = await reopened.head()
  assert.equal(head.cards, 1)
  assert.equal(head.records, 2)
})

test('T09 并发改同一张卡：CAS 让其中一个成功、另一个拿到冲突', async () => {
  const { board } = await makeBoard()
  const card = await newCard(board)
  const results = await Promise.allSettled([
    board.updateCard({ cardId: card.id, rev: 1, status: 'assigned', actor: CHILD }),
    board.updateCard({ cardId: card.id, rev: 1, status: 'assigned', actor: OTHER }),
  ])
  const ok = results.filter((item) => item.status === 'fulfilled')
  const failed = results.filter((item) => item.status === 'rejected')
  assert.equal(ok.length, 1)
  assert.equal(failed.length, 1)
  assert.ok(failed[0].reason instanceof BoardConflictError)
})

test('T09 appendRecord 必须挂在已有卡上（外键）', async () => {
  const { board } = await makeBoard()
  await assert.rejects(
    () => board.appendRecord({ cardId: 't99', kind: 'finding', title: '孤儿记录', actor: MASTER }),
    /cardId 不存在/,
  )
})

test('T09 证据流支持 finding/source/artifact/decision/open_question 五种 kind', async () => {
  const { board } = await makeBoard()
  const card = await newCard(board)
  const kinds = ['finding', 'source', 'artifact', 'decision', 'open_question']
  for (const [index, kind] of kinds.entries()) {
    const record = await board.appendRecord({ cardId: card.id, kind, title: kind + index, actor: MASTER })
    assert.equal(record.kind, kind)
    assert.equal(record.cardId, card.id)
  }
  const all = await board.queryRecords({ cardId: card.id })
  assert.equal(all.length, kinds.length)
  assert.equal((await board.queryRecords({ cardId: card.id, kind: 'decision' })).length, 1)
})

test('T09 非法状态值与未知状态被拒', async () => {
  const { board } = await makeBoard()
  const card = await newCard(board)
  await assert.rejects(
    () => board.updateCard({ cardId: card.id, rev: 1, status: 'doing-ish', actor: MASTER }),
    /未知状态/,
  )
})

test('T09 坏的 board.json 报错而不是静默清空看板', async () => {
  const { dir, file } = await makeBoard()
  const { writeFile, mkdir } = await import('node:fs/promises')
  await mkdir(dir, { recursive: true })
  await writeFile(file, '{ 这不是 JSON', 'utf8')
  const board = new Board({ dir })
  await assert.rejects(() => board.head(), (error) => {
    assert.ok(error instanceof BoardCorruptError)
    assert.match(error.message, /拒绝重建看板/)
    return true
  })
})

test('T09 actor 形状不合法时立刻报错（不猜角色）', async () => {
  const { board } = await makeBoard()
  await assert.rejects(() => board.createCard({ title: 'x', actor: { sessionId: 's' } }), /actor.role/)
  await assert.rejects(() => board.createCard({ title: 'x', actor: { role: 'master' } }), /actor.sessionId/)
})
