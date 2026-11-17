/**
 * T11 / T12 工具层验收：门禁、final 语义、派发审批、批量回滚、验收沉淀。
 *
 * 用真 Board + 真 Ledger（临时目录），只把 spawnActivation 换成替身 ——
 * 这样门禁与看板行为都是真的，测的不是假实现。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Board } from '../lib/board.js'
import { Ledger } from '../lib/ledger.js'
import { ExperienceStore } from '../lib/experience.js'
import { createTools } from '../lib/tools.js'
import { GateError } from '../lib/gate.js'
import { createPreExecuteGate } from '../lib/approval.js'

const ROOT = 'session-root'
const CHILD_A = { author: { sessionId: 'session-a', name: 'worker-a' } }
const CHILD_B = { author: { sessionId: 'session-b', name: 'worker-b' } }
const AGENT = { id: ROOT }

/** 造一套环境：真看板 + 真台账 + 可编程 spawn。 */
async function makeEnv(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'tools-'))
  const board = new Board({ dir, maxCards: options.maxCards ?? 32, maxRecords: options.maxRecords ?? 256 })
  const ledger = new Ledger({ dir })
  const experience = new ExperienceStore({
    projectDir: join(dir, 'project'),
    globalDir: join(dir, 'global'),
  })
  /** @type {any[]} */
  const spawned = []
  let spawnCalls = 0
  const spawnActivation = options.spawn ?? (async (spec) => {
    spawnCalls += 1
    if (options.failAt !== undefined && spawnCalls === options.failAt) {
      throw new Error('第 ' + spawnCalls + ' 路 spawn 失败（模拟）')
    }
    const child = { childId: 'session-child-' + spawnCalls, label: spec.label }
    spawned.push(child)
    return child
  })
  const tools = createTools({
    config: { maxChildren: options.maxChildren ?? 4 },
    board,
    ledger,
    spawnActivation,
    rootId: ROOT,
    now: () => Date.now(),
    experience,
  })
  return { dir, board, ledger, experience, tools, spawned, spawnCount: () => spawnCalls }
}

/** 一份能通过 validateReport 的报告。 */
function reportPayload(taskId, extra = {}) {
  return {
    taskId,
    summary: '已完成看板改造',
    findings: [{ text: '发现一：卡状态机可用' }],
    evidence: [{ path: 'lib/board.js', quote: 'const TRANSITIONS' }],
    open_questions: [],
    artifacts: [],
    confidence: 'high',
    schemaVersion: 1,
    ...extra,
  }
}

const BRIEF = {
  goal: '实现看板',
  constraints: ['不改 lib/ledger.js'],
  acceptance: ['测试全绿'],
}

/** 认领并开工一路。 */
async function claimAndStart(tools, taskId, runtime) {
  await tools.boardTool({ op: 'claim', cardId: taskId }, runtime)
  await tools.boardTool({ op: 'doing', cardId: taskId }, runtime)
}

// ---------------------------------------------------------------------------
// 验收 1：没认领就 report → 拒收，且板上零新增记录
// ---------------------------------------------------------------------------

test('T11-1 没认领就 report → 拒收，看板上零新增记录', async () => {
  const { board, tools } = await makeEnv()
  const assigned = await tools.assign({ label: '看板', brief: BRIEF })
  assert.equal(assigned.taskId, 't1')

  await assert.rejects(
    () => tools.report(reportPayload('t1'), CHILD_A),
    (error) => {
      assert.ok(error instanceof GateError)
      assert.match(error.message, /还没被认领/)
      return true
    },
  )
  // 一个字节都没写
  assert.deepEqual(await board.queryRecords({}), [])
  const detail = await board.getCard('t1')
  assert.equal(detail.card.status, 'todo')
})

test('T11-1 被拒后照四步做完再报，就通过了', async () => {
  const { board, tools } = await makeEnv()
  await tools.assign({ label: '看板', brief: BRIEF })
  await claimAndStart(tools, 't1', CHILD_A)
  const result = await tools.report(reportPayload('t1'), CHILD_A)
  assert.equal(result.ok, true)
  assert.equal(result.cardId, 't1')
  assert.ok(result.recordIds.length >= 2)
  assert.equal((await board.getCard('t1')).card.status, 'doing')
})

// ---------------------------------------------------------------------------
// 验收 2：认领了别人卡号 report → 拒收
// ---------------------------------------------------------------------------

test('T11-2 拿别人的卡号 report → 拒收', async () => {
  const { board, tools } = await makeEnv()
  await tools.assign({ label: '看板', brief: BRIEF })
  await claimAndStart(tools, 't1', CHILD_A)
  const before = (await board.queryRecords({})).length

  await assert.rejects(
    () => tools.report(reportPayload('t1'), CHILD_B),
    (error) => {
      assert.ok(error instanceof GateError)
      assert.match(error.message, /不在|名下/)
      return true
    },
  )
  // 被拒的报告不能新增任何记录（认领时写的那两条审计还在）
  assert.equal((await board.queryRecords({})).length, before)
})

// ---------------------------------------------------------------------------
// 验收 3：卡被改派后旧会话再 report → 拒收
// ---------------------------------------------------------------------------

test('T11-3 卡被改派后，旧会话再 report 被拒；新会话可以', async () => {
  const { board, tools } = await makeEnv()
  await tools.assign({ label: '看板', brief: BRIEF })
  await claimAndStart(tools, 't1', CHILD_A)

  // master 把卡改派给 worker-b
  const detail = await board.getCard('t1')
  await board.updateCard({
    cardId: 't1',
    rev: detail.card.rev,
    assignee: { sessionId: 'session-b', name: 'worker-b' },
    actor: { sessionId: ROOT, name: 'master', role: 'master' },
  })

  await assert.rejects(() => tools.report(reportPayload('t1'), CHILD_A), GateError)
  // 新认领者可以（状态仍是 doing）
  const result = await tools.report(reportPayload('t1'), CHILD_B)
  assert.equal(result.ok, true)
})

// ---------------------------------------------------------------------------
// 验收 4：非 final 报告不改卡状态；final 推 review
// ---------------------------------------------------------------------------

test('T11-4 非 final 报告不改卡状态，final 把卡推到 review', async () => {
  const { board, tools } = await makeEnv()
  await tools.assign({ label: '看板', brief: BRIEF })
  await claimAndStart(tools, 't1', CHILD_A)

  const incremental = await tools.report(reportPayload('t1'), CHILD_A)
  assert.equal(incremental.final, false)
  assert.equal((await board.getCard('t1')).card.status, 'doing')

  const final = await tools.report(reportPayload('t1', { final: true }), CHILD_A)
  assert.equal(final.final, true)
  assert.equal(final.status, 'review')
  assert.equal((await board.getCard('t1')).card.status, 'review')

  // review 之后还能补增量，但状态不动
  const again = await tools.report(reportPayload('t1'), CHILD_A)
  assert.equal(again.status, 'review')
})

// ---------------------------------------------------------------------------
// 验收 5：拒批 → 不 spawn、板上无新卡、台账条目保留
// ---------------------------------------------------------------------------

test('T11-5 审批被拒 → 不 spawn、板上无新卡', async () => {
  const { board, tools, spawnCount } = await makeEnv()
  const gate = createPreExecuteGate({
    config: { approvalWaitMs: 1000 },
    approvalOf: () => ({ async request() { return 'rejected' } }),
  })
  const args = { label: '看板', brief: BRIEF }
  const decision = await gate({ name: 'master_assign', arguments: args, agent: AGENT, callId: 'c1' }, async () => ({ kind: 'allow' }))
  assert.equal(decision.kind, 'deny')

  // 宿主在 deny 时不执行工具体
  assert.equal(spawnCount(), 0)
  assert.deepEqual(await board.listCards({}), [])
})

test('T11-5 spawn 失败后台账条目保留，可用同一个 taskId 重试', async () => {
  const { board, ledger, tools } = await makeEnv({ failAt: 1 })
  const failed = await tools.assign({ label: '看板', brief: BRIEF, taskId: 't1' })
  assert.equal(failed.ok, false)
  assert.equal(failed.taskId, 't1')
  // 卡被回滚，台账还在
  assert.deepEqual(await board.listCards({}), [])
  const entry = await ledger.latest('t1')
  assert.equal(entry.taskId, 't1')

  // 换个能成功的 spawn 重试同一个号
  const retryEnv = await makeEnv()
  const retried = await retryEnv.tools.assign({ label: '看板', brief: BRIEF, taskId: 't1' })
  assert.equal(retried.ok, true)
  assert.equal(retried.taskId, 't1')
  assert.equal((await retryEnv.board.listCards({})).length, 1)
})

test('T11-5 审批策略 never（一律 rejected）→ 明确报错且不 spawn', async () => {
  const gate = createPreExecuteGate({
    config: { approvalWaitMs: 1000 },
    approvalOf: () => ({ async request() { return 'rejected' } }),
  })
  const decision = await gate(
    { name: 'master_dispatch', arguments: { briefs: [{ label: 'a', brief: BRIEF }, { label: 'b', brief: BRIEF }] }, agent: AGENT },
    async () => ({ kind: 'allow' }),
  )
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /never/)
  assert.match(decision.reason, /没有派发任何子对话/)
})

// ---------------------------------------------------------------------------
// 验收 6：批量 3 路只弹一次审批；第 3 路失败回滚前两路卡
// ---------------------------------------------------------------------------

test('T11-6 批量 3 路：只弹一次审批，成功时建 3 张卡', async () => {
  const { board, tools, spawnCount } = await makeEnv()
  let approvals = 0
  const gate = createPreExecuteGate({
    config: { approvalWaitMs: 1000 },
    approvalOf: () => ({ async request() { approvals += 1; return 'allowed-once' } }),
  })
  const briefs = [1, 2, 3].map((index) => ({
    label: '路' + index,
    brief: { goal: '目标' + index, constraints: ['约束'], acceptance: ['验收'] },
  }))
  const decision = await gate({ name: 'master_dispatch', arguments: { briefs }, agent: AGENT }, async () => ({ kind: 'allow' }))
  assert.equal(decision.kind, 'allow')
  assert.equal(approvals, 1)

  const result = await tools.dispatch({ briefs })
  assert.equal(result.ok, true)
  assert.equal(result.dispatched, 3)
  assert.equal(spawnCount(), 3)
  const cards = await board.listCards({})
  assert.equal(cards.length, 3)
  assert.deepEqual(cards.map((card) => card.id), ['t1', 't2', 't3'])
  // 五档阶梯的判定结果随回执返回（纯函数，不改决定权）
  for (const route of result.routes) assert.ok(typeof route.strategy === 'string')
})

test('T11-6 第 3 路 spawn 失败 → 前两路的卡被回滚，看板不留残卡', async () => {
  const { board, tools } = await makeEnv({ failAt: 3 })
  const briefs = [1, 2, 3].map((index) => ({
    label: '路' + index,
    brief: { goal: '目标' + index, constraints: ['约束'], acceptance: ['验收'] },
  }))
  const result = await tools.dispatch({ briefs })
  assert.equal(result.ok, false)
  assert.equal(result.failedAt, 3)
  assert.equal(result.started, 2)
  assert.deepEqual(result.rolledBack.sort(), ['t1', 't2', 't3'])
  assert.deepEqual(await board.listCards({}), [])
})

test('T11-6 批量派发预检：约束不齐备直接拒绝（不进五档阶梯）', async () => {
  const { board, tools, spawnCount } = await makeEnv()
  await assert.rejects(
    () => tools.dispatch({ briefs: [{ label: 'a', brief: { goal: '没有约束' } }] }),
    /约束不齐备/,
  )
  assert.equal(spawnCount(), 0)
  assert.deepEqual(await board.listCards({}), [])
})

test('T11-6 批量派发预检：显式 taskId 必须已在板上', async () => {
  const { tools } = await makeEnv()
  await assert.rejects(
    () => tools.dispatch({ briefs: [{ label: 'a', taskId: 't9', brief: BRIEF }] }),
    /看板上没有卡 t9/,
  )
})

// ---------------------------------------------------------------------------
// 验收 7：dispatch 纯函数仍无板依赖
// ---------------------------------------------------------------------------

test('T11-7 lib/dispatch.js 仍然没有看板/台账依赖（纯函数）', async () => {
  const source = await readFile(new URL('../lib/dispatch.js', import.meta.url), 'utf8')
  const imports = source.split('\n').filter((line) => /^\s*import\s/.test(line))
  assert.deepEqual(imports, [])
  assert.equal(/from\s+['"]\.\/board\.js['"]/.test(source), false)
  assert.equal(/from\s+['"]\.\/ledger\.js['"]/.test(source), false)
})

// ---------------------------------------------------------------------------
// 验收 8（T12）：验收必须带经验或显式无经验
// ---------------------------------------------------------------------------

/** 把卡推到 review，准备验收。 */
async function readyForAccept(tools) {
  await tools.assign({ label: '看板', brief: BRIEF })
  await claimAndStart(tools, 't1', CHILD_A)
  await tools.report(reportPayload('t1', { final: true }), CHILD_A)
}

test('T12-1 accept 不带经验也不带 none → 报错，卡不落 done', async () => {
  const { board, tools } = await makeEnv()
  await readyForAccept(tools)
  await assert.rejects(
    () => tools.boardTool({ op: 'accept', cardId: 't1', verdict: 'accept', asMaster: true }),
    /要么带 experience|experienceNone/,
  )
  assert.equal((await board.getCard('t1')).card.status, 'review')
})

test('T12-1 accept 带经验 → 卡落 done + 写进经验库 + 留 decision 记录', async () => {
  const { board, experience, tools } = await makeEnv()
  await readyForAccept(tools)
  const result = await tools.boardTool({
    op: 'accept',
    cardId: 't1',
    verdict: 'accept',
    asMaster: true,
    experience: { title: '看板 CAS 要先读 rev', lesson: '改卡必须先读卡拿 rev', tags: ['board'] },
  })
  assert.equal(result.verdict, 'accept')
  assert.equal(result.card.status, 'done')
  const entries = await experience.all()
  assert.equal(entries.length, 1)
  assert.equal(entries[0].verified_count, 1)
  assert.deepEqual(entries[0].sources, ['t1'])

  const records = await board.queryRecords({ cardId: 't1', kind: 'decision' })
  assert.equal(records.length, 1)
  assert.match(records[0].title, /验收通过/)
})

test('T12-1 accept 显式无经验 → 卡落 done，并留「显式无经验」审计', async () => {
  const { board, experience, tools } = await makeEnv()
  await readyForAccept(tools)
  const result = await tools.boardTool({
    op: 'accept',
    cardId: 't1',
    verdict: 'accept',
    asMaster: true,
    experienceNone: true,
  })
  assert.equal(result.card.status, 'done')
  assert.deepEqual(await experience.all(), [])
  const records = await board.queryRecords({ cardId: 't1', kind: 'decision' })
  assert.match(records[0].title, /显式无经验/)
})

test('T12-1 experience 与 experienceNone 同时给 → 报错', async () => {
  const { tools } = await makeEnv()
  await readyForAccept(tools)
  await assert.rejects(
    () => tools.boardTool({
      op: 'accept',
      cardId: 't1',
      verdict: 'accept',
      asMaster: true,
      experienceNone: true,
      experience: { title: 'x', lesson: 'y' },
    }),
    /不能同时给/,
  )
})

test('T12-1 非法 verdict 被拒', async () => {
  const { tools } = await makeEnv()
  await readyForAccept(tools)
  await assert.rejects(
    () => tools.boardTool({ op: 'accept', cardId: 't1', verdict: 'looks-fine', asMaster: true }),
    /verdict/,
  )
})

// ---------------------------------------------------------------------------
// T12：rework / abort
// ---------------------------------------------------------------------------

test('T12 rework → 卡回 doing，note 进 records 可回查', async () => {
  const { board, tools } = await makeEnv()
  await readyForAccept(tools)
  const result = await tools.boardTool({
    op: 'accept',
    cardId: 't1',
    verdict: 'rework',
    asMaster: true,
    reason: '证据不足，补三条来源',
  })
  assert.equal(result.card.status, 'doing')
  const records = await board.queryRecords({ cardId: 't1', kind: 'card_status' })
  const last = records[records.length - 1]
  assert.equal(last.to, 'doing')
  assert.match(last.reason, /证据不足/)
})

test('T12 abort → 卡回 todo，可被重新认领派发', async () => {
  const { board, tools } = await makeEnv()
  await readyForAccept(tools)
  const result = await tools.boardTool({ op: 'accept', cardId: 't1', verdict: 'abort', asMaster: true, reason: '方向错了' })
  assert.equal(result.card.status, 'todo')
  const detail = await board.getCard('t1')
  // 回到 todo 且可以被新的子对话重新认领
  const reclaimed = await tools.boardTool({ op: 'claim', cardId: 't1' }, CHILD_B)
  assert.equal(reclaimed.card.status, 'assigned')
  assert.equal(reclaimed.card.assignee.sessionId, 'session-b')
  // detail 是 abort 之后读的：认领再推一格 rev（CAS 生效）
  assert.equal(detail.card.rev + 1, reclaimed.card.rev)
})

// ---------------------------------------------------------------------------
// collect：按卡分组
// ---------------------------------------------------------------------------

test('T11 collect 按卡分组：状态、认领者、摘要、违规都能读到', async () => {
  const { tools } = await makeEnv()
  await tools.assign({ label: '看板', brief: BRIEF })
  await claimAndStart(tools, 't1', CHILD_A)
  await tools.report(reportPayload('t1', { findings: [{ text: '结论一' }] }), CHILD_A)

  const collected = await tools.collect({})
  assert.equal(collected.children.length, 1)
  const child = collected.children[0]
  assert.equal(child.cardId, 't1')
  assert.equal(child.status, 'doing')
  assert.equal(child.assignee.name, 'worker-a')
  assert.equal(child.priority, 'P2')
  assert.match(child.summary, /已完成看板改造/)
  assert.equal(child.evidence.length, 1)
})

test('T11 collect missing：点名的卡没在板上就进 missing', async () => {
  const { tools } = await makeEnv()
  await tools.assign({ label: '看板', brief: BRIEF })
  const collected = await tools.collect({ names: ['t1', 't9'] })
  assert.equal(collected.children.length, 1)
  assert.deepEqual(collected.missing, ['t9'])
})

// ---------------------------------------------------------------------------
// master_board 读写入口
// ---------------------------------------------------------------------------

test('T11 master_board：query/get/head/records/create 都能用', async () => {
  const { tools } = await makeEnv()
  const created = await tools.boardTool({ op: 'create', title: '手工卡', priority: 'P0', asMaster: true })
  assert.equal(created.card.id, 't1')
  assert.equal(created.card.priority, 'P0')

  const queried = await tools.boardTool({ op: 'query', status: 'todo' })
  assert.equal(queried.cards.length, 1)

  const head = await tools.boardTool({ op: 'head' })
  assert.equal(head.head.cards, 1)

  const got = await tools.boardTool({ op: 'get', cardId: 't1' })
  assert.equal(got.card.id, 't1')
  assert.deepEqual(got.records, [])

  await tools.boardTool({ op: 'claim', cardId: 't1' }, CHILD_A)
  const records = await tools.boardTool({ op: 'records', cardId: 't1', kind: 'card_status' })
  assert.equal(records.records.length, 1)
  assert.equal(records.records[0].to, 'assigned')
})

test('T11 master_board op=block 写原因，op=reopen 只由 master 解除', async () => {
  const { board, tools } = await makeEnv()
  await tools.assign({ label: '看板', brief: BRIEF })
  await claimAndStart(tools, 't1', CHILD_A)
  const blocked = await tools.boardTool({ op: 'block', cardId: 't1', reason: '缺上游' }, CHILD_A)
  assert.equal(blocked.card.status, 'blocked')

  // 子对话不能自己解除
  await assert.rejects(() => tools.boardTool({ op: 'reopen', cardId: 't1' }, CHILD_A), /master/)
  const reopened = await tools.boardTool({ op: 'reopen', cardId: 't1', reason: '上游好了', asMaster: true })
  assert.equal(reopened.card.status, 'todo')
  assert.equal((await board.getCard('t1')).card.assignee.sessionId, 'session-a')
})

/**
 * 真机事故回归：宿主（dsh-tools/src/contracts.ts）规定
 * `ToolOutputDefinition.render(args, value): ContentBlock[]`。
 * 我们曾返回字符串，真宿主把它当 content 数组用，直接崩
 * `content.some is not a function` —— 假 ctx 测试全绿也照样炸。
 */
test('每个工具的 output.render 都返回内容块数组（宿主契约）', async () => {
  const { tools } = await makeEnv()
  assert.equal(tools.definitions.length, 7)

  const samples = new Map([
    ['master_assign', { taskId: 't1', cardId: 't1', status: 'todo', priority: 'P2', promptBytes: 120 }],
    ['master_dispatch', { ok: true, routes: [{ taskId: 't1', priority: 'P2' }] }],
    ['master_report', { cardId: 't1', recordIds: ['r1'], violations: [], ok: true, final: true }],
    ['master_collect', { children: [{ cardId: 't1', status: 'review' }], missing: [] }],
    ['master_board', { head: { cards: 1, records: 2, revision: 3 } }],
    ['master_digest', { locator: null, sha256: 'x', bytes: 10, summary: 's', truncated: false }],
    ['master_experience', { action: 'created', entry: { title: '经验' } }],
  ])

  for (const definition of tools.definitions) {
    const sample = samples.get(definition.name)
    assert.ok(sample, '测试漏了 ' + definition.name + ' 的样例值')
    // 宿主签名是 render(args, value)：写成单参数会把参数当结果渲染（真机踩过）
    assert.equal(definition.output.render.length, 2, definition.name + '.render 必须是 (args, value)')

    for (const args of [{}, { op: 'head' }]) {
      const content = definition.output.render(args, sample)
      assert.ok(Array.isArray(content), definition.name + '.render 必须返回数组')
      assert.ok(content.length > 0, definition.name + '.render 不能返回空数组')
      for (const block of content) {
        assert.equal(block.type, 'text', definition.name + '.render 的块必须是 text')
        assert.equal(typeof block.text, 'string', definition.name + '.render 的 text 必须是字符串')
      }
    }
  }

  // 渲染的必须是 value（结果），不是 args（参数）：op=head 要报出真实卡数/记录数
  const boardDefinition = tools.definitions.find((d) => d.name === 'master_board')
  const rendered = boardDefinition.output.render(
    { op: 'head' },
    { head: { version: 1, revision: 7, headSeq: 9, cards: 2, records: 5 } },
  )
  assert.equal(rendered[0].text, '看板头：卡 2 张、记录 5 条、revision 7、退役卡 0 张')
})
