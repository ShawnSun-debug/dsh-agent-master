/**
 * dsh-agent-master — 宿主接线单测（T5 → v2 契约）。
 *
 * 全部用假 ctx：只记录 tools.register / systemPrompt.section / sessionProjections.register / effect 的调用，
 * 不发真 DSH。涉及黑板与指挥台的行为用例用临时 dataDir 让真 Board/Ledger 落盘，
 * 这样 startActivation 的绑定、作者解析、board.json 记录与 deck.json 快照都是可核对的真实证据。
 *
 * v2 契约要点（与 lib/ 实现对齐，断言一律读盘上真实文件）：
 * - 7 个工具（TOOL_NAMES），每个都经 ctx.effect 注册；
 * - deck 不再写会话事件，改为原子写 <root 会话 cwd>/.agent-master/<rootId>/deck.json（deck v2）；
 * - 看板是 board.json = { version, headSeq, cards[], records[] }，旧的 board.jsonl 只做一次性迁移；
 * - 只有 DECK_TOOLS（assign/report/collect/board）刷新快照，digest/experience 不写；
 * - 子对话必须先认领（master_board op=claim）才能 master_report（gate 硬门禁）。
 *
 * 临时目录一律落在仓库内 .test-tmp/：本机把 TEMP/TMP 指到了仓库内，禁止用 os.tmpdir()。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply, inject, name } from '../lib/index.js'
import { BOARD_VERSION } from '../lib/board.js'
import { AgentMasterConfigError } from '../lib/config.js'
import { DECK_EVENT, DECK_STATE_VERSION, DECK_VERSION } from '../lib/deck.js'
import { TOOL_NAMES } from '../lib/tools.js'

/** 仓库根（本文件在 test/ 下）：临时目录必须落在仓库内。 */
const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 临时目录父级（已被环境指为 TEMP/TMP，这里显式用仓库内路径，避免依赖环境）。 */
const TEMP_ROOT = join(ROOT, '.test-tmp')

/** 建一个用例专用的临时目录：父目录先建，mkdtemp 再加唯一后缀。 */
async function makeTempDir() {
  await mkdir(TEMP_ROOT, { recursive: true })
  return mkdtemp(join(TEMP_ROOT, 'wiring-'))
}

/**
 * 假宿主 ctx：四个服务 + effect 都是记录器。
 * effect 的 execute 返回值可能是 disposer，也可能是 Promise<disposer>（投影注册就是后者）。
 */
function fakeCtx(options = {}) {
  const calls = {
    tools: [],
    sections: [],
    projections: [],
    effects: [],
    activations: [],
    disposals: [],
    listeners: new Map(),
    injects: [],
  }
  const ctx = {
    effect(execute, label) {
      calls.effects.push(label)
      const result = execute()
      const run = (disposer) => {
        calls.disposals.push(label)
        if (typeof disposer === 'function') disposer()
      }
      if (result && typeof result.then === 'function') {
        return () => {
          result.then(run, () => {})
        }
      }
      return () => run(result)
    },
    tools: {
      register(definition) {
        calls.tools.push(definition)
        return () => {}
      },
    },
    systemPrompt: {
      getSectionOrder: () => 7000,
      section(section) {
        calls.sections.push(section)
        return () => {}
      },
    },
    sessionProjections: {
      async register(definition) {
        calls.projections.push(definition)
        return () => {}
      },
    },
    subagents: {
      rootOf: options.rootOf ?? ((agent) => agent),
      namesOf: options.namesOf ?? (() => ['agent-1']),
      async startActivation(spec) {
        calls.activations.push(spec)
        return { childId: 'child-' + calls.activations.length, name: spec.name ?? 'child' }
      },
    },
    on(event, listener) {
      const list = calls.listeners.get(event) ?? []
      list.push(listener)
      calls.listeners.set(event, list)
      return () => {
        calls.listeners.set(event, (calls.listeners.get(event) ?? []).filter((item) => item !== listener))
      }
    },
    emit(event, payload) {
      for (const listener of calls.listeners.get(event) ?? []) listener(payload)
    },
    inject(names, callback) {
      calls.injects.push({ names, callback })
    },
  }
  return { ctx, calls }
}

/**
 * 假 agent：接线用到的 id、工作区 cwd，以及「有没有被写会话事件」的探针。
 * v2 不再写会话事件，所以 appended 必须在所有 deck 用例里保持为空。
 */
function makeAgent(id, cwd = '') {
  const appended = []
  return {
    id,
    appended,
    session: {
      header: { cwd },
      append(type, data) {
        appended.push({ type, payload: data })
      },
    },
  }
}

/** deck 快照路径（与客户端 deckRelativePath 的路径约定一致）。 */
function deckPathOf(workspaceDir, rootId) {
  return join(workspaceDir, '.agent-master', rootId, 'deck.json')
}

/** 读指挥台快照（真落盘 v2：version/revision/cards/counts/recent）。 */
async function readDeck(workspaceDir, rootId) {
  return JSON.parse(await readFile(deckPathOf(workspaceDir, rootId), 'utf8'))
}

/** 读看板（真落盘 v2：{ version, headSeq, cards[], records[] }）。 */
async function readBoard(dir, rootId) {
  return JSON.parse(await readFile(join(dir, rootId, 'board.json'), 'utf8'))
}

/** 按名取已注册的工具定义 */
function findTool(calls, toolName) {
  const definition = calls.tools.find((item) => item.name === toolName)
  assert.ok(definition, '没有注册工具 ' + toolName)
  return definition
}

/** 一份最小的合法报告（子会话回传用）。 */
function reportOf(taskId, extra = {}) {
  return {
    taskId,
    summary: '做完了',
    findings: [{ text: '发现' }],
    confidence: 'high',
    ...extra,
  }
}

test('wiring：inject 是契约里的四个服务，apply 返回 Promise', async () => {
  assert.equal(name, 'dsh-agent-master')
  assert.deepEqual(inject, ['tools', 'systemPrompt', 'subagents', 'sessionProjections'])
  const { ctx } = fakeCtx()
  const pending = apply(ctx, {})
  assert.ok(pending instanceof Promise, 'apply 必须返回 Promise')
  const dispose = await pending
  assert.equal(typeof dispose, 'function')
})

test('wiring：注册 7 个契约工具名，每个都包在 ctx.effect 里且形状满足宿主校验', async () => {
  const { ctx, calls } = fakeCtx()
  await apply(ctx, {})

  // 工具清单以 lib/tools.js 的 TOOL_NAMES 为准，同时把名字集合钉死：数量变了必须先改契约
  assert.equal(TOOL_NAMES.length, 7)
  assert.deepEqual([...TOOL_NAMES].sort(), [
    'master_assign',
    'master_board',
    'master_collect',
    'master_digest',
    'master_dispatch',
    'master_experience',
    'master_report',
  ])
  assert.deepEqual(calls.tools.map((definition) => definition.name), [...TOOL_NAMES])

  // 7 个工具 + 派发审批门禁 + 按会话限制工具 + 分角色提示词 + 会话投影 = 11 条 effect，全部经 effect 注册
  assert.deepEqual(
    calls.effects.slice(0, TOOL_NAMES.length),
    TOOL_NAMES.map((toolName) => 'agent-master: 工具 ' + toolName),
  )
  assert.deepEqual(calls.effects.slice(TOOL_NAMES.length), [
    'agent-master: 派发审批门禁',
    'agent-master: 按会话限制工具',
    'agent-master: 分角色提示词',
    'agent-master: 会话投影',
  ])
  for (const label of calls.effects) assert.match(label, /^agent-master: /)

  // 宿主 register 只校验这些字段（api-notes §1）
  for (const definition of calls.tools) {
    assert.equal(typeof definition.description, 'string')
    assert.equal(typeof definition.parameters, 'object')
    assert.equal(typeof definition.output, 'object')
    assert.equal(typeof definition.output.schema, 'object')
    assert.equal(typeof definition.output.render, 'function')
    assert.equal(typeof definition.execute, 'function')
  }
})

test('wiring：section 的 text(context) 在 root 与子对话下返回两段不同提示词', async () => {
  const root = makeAgent('root-1')
  const child = makeAgent('sess-a')
  const weird = makeAgent('sess-b')
  const { ctx, calls } = fakeCtx({
    rootOf(agent) {
      if (agent === weird) throw new Error('rootOf 炸了')
      return root
    },
  })
  await apply(ctx, { maxChildren: 2 })

  assert.equal(calls.sections.length, 1)
  const section = calls.sections[0]
  assert.equal(section.name, 'agent-master:master')
  assert.equal(section.order, 7000)
  assert.equal(typeof section.text, 'function')

  const masterText = section.text({ agent: root })
  const childText = section.text({ agent: child })
  assert.match(masterText, /你是 master 会话/)
  assert.match(masterText, /最多 2 个子对话/) // 配置数字真的注入了模板
  assert.match(childText, /你是子对话/)
  assert.notEqual(masterText, childText)
  // 拿不到 agent 或 rootOf 抛错时一律回退 master 段（宁可多给纪律，不静默丢）
  assert.match(section.text({}), /你是 master 会话/)
  assert.match(section.text({ agent: weird }), /你是 master 会话/)
  assert.match(section.text(undefined), /你是 master 会话/)
})

test('wiring：投影 key/stateVersion/wire 符合契约，apply 只认 deck 事件', async () => {
  const { ctx, calls } = fakeCtx()
  await apply(ctx, {})

  assert.equal(calls.projections.length, 1)
  const definition = calls.projections[0]
  assert.equal(definition.key, 'agentMaster')
  // v2：stateVersion 必须跟 deck 契约版本一起走，不再是 1
  assert.equal(definition.stateVersion, DECK_STATE_VERSION)
  assert.equal(definition.wire.summary, false)
  assert.equal(definition.wire.viewSchema, definition.stateSchema)
  assert.equal(typeof definition.stateSchema.parse, 'function')
  assert.equal(typeof definition.apply, 'function')
  // null = 尚无任何记录
  assert.equal(definition.init(), null)
  assert.equal(definition.stateSchema.parse(null), null)

  // v2 状态就是 deck.json 的内容：version + revision + cards + counts + recent
  const state = {
    version: DECK_VERSION,
    revision: 3,
    updatedAt: 1,
    cards: [
      {
        id: 't1',
        label: '调研A',
        status: 'assigned',
        priority: 'P2',
        rev: 2,
        assignee: { sessionId: 'sess-a', name: 'agent-1' },
        sessionId: 'sess-a',
        counts: { findings: 1, sources: 0, artifacts: 0, violations: 0 },
        updatedAt: 1,
      },
    ],
    counts: { cards: 1, records: 1, violations: 0, todo: 0, assigned: 1, doing: 0, review: 0, done: 0, blocked: 0 },
    recent: [{ seq: 1, kind: 'finding', cardId: 't1', title: 'finding' }],
  }
  assert.equal(definition.stateSchema.parse(state), state)
  // 旧 v1 状态（无 version、children/counts.tasks）不再接受：返回 null 交给客户端占位，而不是抛错
  assert.equal(
    definition.stateSchema.parse({
      headSeq: 0,
      updatedAt: 1,
      children: [],
      counts: { tasks: 0, findings: 0, sources: 0, artifacts: 0, violations: 0 },
      recent: [],
    }),
    null,
  )
  assert.equal(definition.stateSchema.parse({ ...state, version: 1 }), null)
  // v2 但字段缺失：明确抛错（带字段名），不要悄悄放行
  assert.throws(() => definition.stateSchema.parse({ ...state, revision: undefined }), /revision/)

  // 无关事件必须返回同一引用（否则下游白白重算）
  assert.equal(definition.apply(state, { type: 'agent/other' }), state)
  assert.equal(definition.apply(state, null), state)
  // deck 事件返回事件里的 deck 对象本身
  const deck = { ...state, revision: 4 }
  assert.equal(definition.apply(state, { type: DECK_EVENT, data: { deck } }), deck)
  // 事件带 deck 事件名但没 data：保留原状态，不要塞 undefined
  assert.equal(definition.apply(state, { type: DECK_EVENT, data: {} }), state)
  // wire.view 是恒等函数（客户端拿到的就是宿主状态）
  assert.equal(definition.wire.view(state), state)
})

test('wiring：master_assign 的 startActivation 绑定本次 exec.agent，并按 v2 落盘 deck.json', async () => {
  const dir = await makeTempDir()
  try {
    const { ctx, calls } = fakeCtx({ rootOf: (agent) => agent })
    const rootAgent = makeAgent('root-1', dir)
    await apply(ctx, { dataDir: dir })

    const assign = findTool(calls, 'master_assign')
    const result = await assign.execute(
      { label: '调研A', brief: { goal: '查清 X 是否成立' } },
      { agent: rootAgent },
    )
    assert.equal(result.ok, true)
    assert.equal(result.taskId, 't1')
    assert.equal(result.cardId, 't1')
    assert.equal(result.status, 'todo')
    assert.equal(result.priority, 'P2')
    assert.equal(result.childSessionId, 'child-1')
    assert.equal(result.tools, null, '没传 tools 就不该限制子对话工具集')
    assert.ok(result.promptBytes > 0, 'prompt 必须真的渲染过（字节数 > 0）')
    // 句柄是**投影**，不是宿主对象本身（原样返回会被宿主判成非 lossless JSON）
    assert.deepEqual(result.child, { childId: 'child-1', name: 'child', messageId: null })

    // 1. spawn 参数：provider/label/prompt/parent/delivery 全按契约
    assert.equal(calls.activations.length, 1)
    const spec = calls.activations[0]
    assert.equal(spec.provider, 'spawn')
    assert.equal(spec.delivery, 'parent')
    assert.equal(spec.label, '调研A')
    assert.equal(spec.parent, rootAgent, 'parent 必须是本次调用的 agent 实例本身')
    assert.deepEqual(spec.prompt.map((block) => block.type), ['text'])
    assert.match(spec.prompt[0].text, /t1/)
    assert.match(spec.prompt[0].text, /查清 X 是否成立/)
    assert.match(spec.prompt[0].text, /约束台账/)
    assert.equal('name' in spec, false, '没有传 name 就不该塞 undefined 进去')

    // 2. 真看板：board.json（v2）里一张 t1 的 todo 卡，已登记派发时预分配的子会话 id
    const board = await readBoard(dir, 'root-1')
    assert.equal(board.version, BOARD_VERSION)
    assert.equal(board.headSeq, 0, '只有建卡与改字段，还没有任何证据记录')
    assert.deepEqual(board.records, [])
    assert.deepEqual(
      board.cards.map((card) => [card.id, card.title, card.status, card.priority, card.assignee, card.childSessionId]),
      [['t1', '查清 X 是否成立', 'todo', 'P2', null, 'child-1']],
    )
    assert.deepEqual(board.cards[0].author, { sessionId: 'root-1', name: 'master' })
    assert.equal(existsSync(join(dir, 'root-1', 'board.jsonl')), false, '不再写旧 JSONL 黑板')

    // 3. deck 快照写在 root 会话的工作区；会话日志一个字节都不再写
    assert.equal(rootAgent.appended.length, 0, '不能再往会话日志写自定义事件')
    const deck = await readDeck(dir, 'root-1')
    assert.equal(deck.version, DECK_VERSION)
    assert.equal(deck.revision, 0, '没有记录时 revision 就是 0')
    assert.deepEqual(
      deck.cards.map((card) => [card.id, card.label, card.status, card.priority, card.rev, card.assignee, card.sessionId]),
      [['t1', '查清 X 是否成立', 'todo', 'P2', 2, null, 'child-1']],
    )
    assert.deepEqual(deck.cards[0].counts, { findings: 0, sources: 0, artifacts: 0, violations: 0 })
    assert.deepEqual(deck.counts, {
      cards: 1,
      records: 0,
      violations: 0,
      todo: 1,
      assigned: 0,
      doing: 0,
      review: 0,
      done: 0,
      blocked: 0,
    })
    assert.deepEqual(deck.recent, [])
    // 原子写（temp + rename）成功后不该留下临时文件
    assert.equal(
      existsSync(deckPathOf(dir, 'root-1') + '.tmp'),
      false,
      '原子写落盘后不该留下 deck.json.tmp',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('wiring：master_report 按 runtime.author 归组，不同子会话不会被并成同一路', async () => {
  const dir = await makeTempDir()
  try {
    const rootWs = join(dir, 'ws-root')
    const childWs = join(dir, 'ws-child')
    await mkdir(rootWs, { recursive: true })
    await mkdir(childWs, { recursive: true })
    const rootAgent = makeAgent('root-1', rootWs)
    const child = makeAgent('sess-child', childWs)
    const { ctx, calls } = fakeCtx({
      rootOf: (agent) => (agent === child ? rootAgent : agent),
      namesOf: (agent) => (agent === child ? ['agent-1'] : ['master']),
    })
    await apply(ctx, { dataDir: dir })

    const assigned = await findTool(calls, 'master_assign').execute(
      { label: '调研A', brief: { goal: '查清 X' } },
      { agent: rootAgent },
    )
    assert.equal(assigned.taskId, 't1')

    // 新契约：报告前必须由本会话先认领（gate 硬门禁），认领者即 runtime.author.sessionId
    const claimed = await findTool(calls, 'master_board').execute({ op: 'claim', cardId: 't1' }, { agent: child })
    assert.deepEqual([claimed.card.status, claimed.card.assignee.sessionId], ['assigned', 'sess-child'])

    const result = await findTool(calls, 'master_report').execute(
      {
        taskId: 't1',
        summary: 'X 成立',
        findings: [{ text: 'A 支持 X' }],
        evidence: [{ url: 'https://example.com/a', quote: '原文摘录' }],
        confidence: 'medium',
        final: true,
      },
      { agent: child },
    )
    assert.equal(result.ok, true)
    assert.deepEqual(result.violations, [])
    assert.equal(result.status, 'review')
    assert.equal(result.final, true)
    assert.deepEqual(result.recordIds, ['r2', 'r3'], 'finding + source 各一条记录')

    // 1. 看板记录里的 author 就是子对话名（不是共用的 child），两条记录都带 runtime.author
    const board = await readBoard(dir, 'root-1')
    assert.deepEqual(board.records.map((record) => record.kind), ['card_status', 'finding', 'source', 'card_status'])
    const finding = board.records.find((record) => record.kind === 'finding')
    const source = board.records.find((record) => record.kind === 'source')
    assert.deepEqual(finding.author, { sessionId: 'sess-child', name: 'agent-1' })
    assert.equal(finding.cardId, 't1', '记录必须挂卡（cardId 外键）')
    assert.equal(finding.seq, 2, '记录 append-only，seq 单调递增')
    assert.equal(finding.body, 'X 成立')
    assert.deepEqual(source.author, { sessionId: 'sess-child', name: 'agent-1' })
    assert.deepEqual(source.refs, ['https://example.com/a'])
    assert.equal(source.body, '原文摘录')
    assert.deepEqual([board.cards[0].status, board.cards[0].assignee.sessionId], ['review', 'sess-child'])

    // 2. deck 把这一路算成 review；快照落在 root 工作区，子会话工作区保持干净
    assert.equal(child.appended.length, 0, '子会话不该收到 deck 事件')
    const deck = await readDeck(rootWs, 'root-1')
    assert.deepEqual(
      deck.cards.map((card) => [card.id, card.status, card.assignee.name, card.assignee.sessionId, card.sessionId]),
      [['t1', 'review', 'agent-1', 'sess-child', 'child-1']],
    )
    assert.equal(deck.revision, 4)
    assert.equal(deck.counts.review, 1)
    assert.equal(existsSync(join(childWs, '.agent-master')), false, '子会话工作区不该出现 deck 快照')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('wiring：两路不同子对话各自认领回报 → deck 两行，master_collect 拿到两路汇总', async () => {
  const dir = await makeTempDir()
  try {
    const rootWs = join(dir, 'ws-root')
    const childWsA = join(dir, 'ws-a')
    const childWsB = join(dir, 'ws-b')
    await mkdir(rootWs, { recursive: true })
    await mkdir(childWsA, { recursive: true })
    await mkdir(childWsB, { recursive: true })
    const rootAgent = makeAgent('root-1', rootWs)
    const childA = makeAgent('sess-a', childWsA)
    const childB = makeAgent('sess-b', childWsB)
    const { ctx, calls } = fakeCtx({
      rootOf: (agent) => (agent === childA || agent === childB ? rootAgent : agent),
      namesOf: (agent) => {
        if (agent === childA) return ['agent-1']
        if (agent === childB) return ['agent-2']
        return ['master']
      },
    })
    await apply(ctx, { dataDir: dir })

    const assign = findTool(calls, 'master_assign')
    const first = await assign.execute({ label: 'A', brief: { goal: '任务一' } }, { agent: rootAgent })
    const second = await assign.execute({ label: 'B', brief: { goal: '任务二' } }, { agent: rootAgent })
    assert.deepEqual([first.taskId, second.taskId], ['t1', 't2'])

    const board = findTool(calls, 'master_board')
    await board.execute({ op: 'claim', cardId: 't1' }, { agent: childA })
    await board.execute({ op: 'claim', cardId: 't2' }, { agent: childB })

    const report = findTool(calls, 'master_report')
    await report.execute(reportOf('t1', { final: true }), { agent: childA })
    await report.execute(reportOf('t2', { final: true }), { agent: childB })

    const collected = await findTool(calls, 'master_collect').execute({}, { agent: rootAgent })
    // 卡标题 = brief.goal（assign 的 label 只用于子会话名，不写进卡片标题）
    assert.deepEqual(
      collected.children.map((item) => [item.taskId, item.label, item.status, item.assignee.name]),
      [
        ['t1', '任务一', 'review', 'agent-1'],
        ['t2', '任务二', 'review', 'agent-2'],
      ],
    )
    assert.deepEqual(collected.missing, [])
    assert.deepEqual(collected.sources, { sources: [], duplicates: 0 })

    // collect 也属于 DECK_TOOLS：它写过的那份快照里两路各一行
    const deck = await readDeck(rootWs, 'root-1')
    assert.deepEqual(
      deck.cards.map((card) => [card.id, card.assignee.name, card.status, card.sessionId]),
      [
        ['t1', 'agent-1', 'review', 'child-1'],
        ['t2', 'agent-2', 'review', 'child-2'],
      ],
    )
    assert.deepEqual(deck.counts, {
      cards: 2,
      records: 6,
      violations: 0,
      todo: 0,
      assigned: 0,
      doing: 0,
      review: 2,
      done: 0,
      blocked: 0,
    })
    assert.equal(existsSync(join(childWsA, '.agent-master')), false)
    assert.equal(existsSync(join(childWsB, '.agent-master')), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('wiring：rootOf 抛错时兜底用 exec.agent.id，无 cwd 只记诊断，首次调用先把旧 jsonl 迁成 board.json', async () => {
  const dir = await makeTempDir()
  try {
    // 预置旧黑板：迁移必须在工具碰看板之前跑完，并且留下备份
    await mkdir(join(dir, 'sess-x'), { recursive: true })
    const legacy = {
      kind: 'task',
      refs: ['t1'],
      title: '旧任务',
      author: { sessionId: 'sess-x', name: 'master' },
      ts: 1,
    }
    await writeFile(
      join(dir, 'sess-x', 'board.jsonl'),
      JSON.stringify(legacy) + String.fromCharCode(10),
      'utf8',
    )

    const { ctx, calls } = fakeCtx({
      rootOf() {
        throw new Error('rootOf 不可用')
      },
    })
    const agent = makeAgent('sess-x') // 会话没有 cwd
    await apply(ctx, { dataDir: dir })

    const head = await findTool(calls, 'master_board').execute({ op: 'head' }, { agent })
    assert.deepEqual(head, {
      head: { version: BOARD_VERSION, revision: 1, headSeq: 1, cards: 1, records: 1 },
    })
    // 兜底之后目录按兜底 id 建（rootOf 不可用不该让工具失败）
    const files = await readdir(join(dir, 'sess-x'))
    assert.ok(files.includes('board.json'), '兜底 rootId 的看板应落在 sess-x 目录')
    assert.ok(
      files.some((file) => file.startsWith('board.jsonl.bak-')),
      '迁移必须逐字节备份旧 board.jsonl',
    )
    assert.equal((await readBoard(dir, 'sess-x')).cards[0].title, '旧任务')

    // 没有 cwd → deck 写不出来，但工具照样成功，也不该凭空猜一个目录写快照
    assert.equal(existsSync(join(dir, '.agent-master')), false, '没有 cwd 时不该猜目录写 deck')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('wiring：只有 assign/dispatch/report/collect/board 刷新 deck，digest/experience 不写', async () => {
  const dir = await makeTempDir()
  try {
    const { ctx, calls } = fakeCtx({ rootOf: (agent) => agent })
    const agent = makeAgent('root-1', dir)
    await apply(ctx, { dataDir: dir })
    const deckPath = deckPathOf(dir, 'root-1')

    const digest = findTool(calls, 'master_digest')
    const experience = findTool(calls, 'master_experience')
    const board = findTool(calls, 'master_board')

    // 1. digest / experience 都是旁路：一次都不该刷新快照
    const short = await digest.execute({ text: '短文本' }, { agent })
    assert.equal(short.locator, null, '没超出预算就不落盘，只回摘要')
    assert.equal(short.bytes, Buffer.byteLength('短文本', 'utf8'))
    assert.equal(short.summary, '短文本')
    assert.equal(existsSync(deckPath), false, 'digest 不该写 deck 快照')

    const queried = await experience.execute({ op: 'query', q: '不可能命中的关键词zzz' }, { agent })
    assert.deepEqual(queried, { entries: [] })
    assert.equal(existsSync(deckPath), false, 'experience 查询不该写 deck 快照')

    // 2. master_board 属于 DECK_TOOLS：连只读的 op=query 也刷新
    assert.deepEqual(await board.execute({ op: 'query' }, { agent }), { cards: [] })
    assert.equal(existsSync(deckPath), true, 'master_board 属于 DECK_TOOLS，必须刷新')
    assert.equal((await readDeck(dir, 'root-1')).revision, 0)
    await rm(deckPath)

    // 3. assign / report / collect 三个写工具依次刷新
    const assigned = await findTool(calls, 'master_assign').execute(
      { label: 'A', brief: { goal: '任务一' } },
      { agent },
    )
    assert.equal(assigned.taskId, 't1')
    assert.equal(existsSync(deckPath), true, 'assign 必须刷新')
    await rm(deckPath)

    await board.execute({ op: 'claim', cardId: 't1' }, { agent })
    assert.equal(existsSync(deckPath), true, 'board 的写操作也要刷新')
    await rm(deckPath)

    const reported = await findTool(calls, 'master_report').execute(reportOf('t1'), { agent })
    assert.equal(reported.ok, true)
    assert.equal(existsSync(deckPath), true, 'report 必须刷新')
    await rm(deckPath)

    // 4. 再确认旁路工具反复调用也不会把快照写回来
    await digest.execute({ text: '短文本' }, { agent })
    await experience.execute({ op: 'query', q: '不可能命中的关键词zzz' }, { agent })
    assert.equal(existsSync(deckPath), false, 'digest/experience 反复调用也不该写 deck')

    await findTool(calls, 'master_collect').execute({}, { agent })
    assert.equal(existsSync(deckPath), true, 'collect 必须刷新')
    const deck = await readDeck(dir, 'root-1')
    assert.equal(deck.counts.cards, 1)
    assert.equal(deck.cards[0].status, 'assigned')
    assert.equal(deck.revision, 2)
    await rm(deckPath)

    // 5. 批量派发也会建卡：必须和单路 assign 一样刷新快照
    const dispatched = await findTool(calls, 'master_dispatch').execute(
      { briefs: [{ label: 'B', brief: { goal: '任务二', constraints: ['只读'] } }] },
      { agent },
    )
    assert.equal(dispatched.dispatched, 1, '批量派发应成功一路')
    assert.equal(existsSync(deckPath), true, 'master_dispatch 必须刷新快照')
    const afterDispatch = await readDeck(dir, 'root-1')
    assert.equal(afterDispatch.counts.cards, 2, '批量建的第二张卡要立刻出现在快照里')
    assert.deepEqual(
      afterDispatch.cards.map((card) => card.label),
      ['任务一', '任务二'],
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('wiring：disposer 逆序回卷全部注册，二次调用是 no-op', async () => {
  const { ctx, calls } = fakeCtx()
  const dispose = await apply(ctx, {})

  // 7 工具 + 审批门禁 + 按会话限制工具 + 提示词 + 投影
  assert.equal(calls.effects.length, TOOL_NAMES.length + 4)

  dispose()
  // 投影的 effect 返回 Promise<disposer>，回卷要等一个 tick 才落地
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(calls.disposals.length, calls.effects.length, '每个 effect 都要回卷一次')
  // 每个 effect 正好回卷一次（不重复、不遗漏）
  assert.deepEqual([...calls.disposals].sort(), [...calls.effects].sort())
  // 同步注册的 effect 必须逆序回卷：提示词在第 4 条，工具 master_assign 在第 1 条
  const order = (label) => calls.disposals.indexOf(label)
  assert.ok(
    order('agent-master: 分角色提示词') < order('agent-master: 工具 master_assign'),
    '同步注册的 effect 必须逆序回卷',
  )

  const before = calls.disposals.length
  dispose()
  assert.equal(calls.disposals.length, before, '二次调用不该再回卷一次')
})

test('wiring：非法配置让 apply 拒绝，且不在 ctx 上留下任何注册', async () => {
  const { ctx, calls } = fakeCtx()
  await assert.rejects(apply(ctx, { maxChildren: 0 }), AgentMasterConfigError)
  // 未知配置键同样是加载期错误，不能被静默忽略
  await assert.rejects(apply(ctx, { notAConfigKey: true }), AgentMasterConfigError)
  assert.deepEqual(calls.tools, [])
  assert.deepEqual(calls.sections, [])
  assert.deepEqual(calls.projections, [])
  assert.deepEqual(calls.effects, [])
})

test('wiring：deck 快照落在 root 会话的工作区，不是发起调用的子会话', async () => {
  const dir = await makeTempDir()
  try {
    const rootWs = join(dir, 'ws-root')
    const childWs = join(dir, 'ws-child')
    await mkdir(rootWs, { recursive: true })
    await mkdir(childWs, { recursive: true })
    const rootAgent = makeAgent('root-1', rootWs)
    const child = makeAgent('sess-child', childWs)
    const { ctx, calls } = fakeCtx({
      rootOf: (agent) => (agent === child ? rootAgent : agent),
      namesOf: (agent) => (agent === child ? ['agent-1'] : ['master']),
    })
    await apply(ctx, { dataDir: dir })

    await findTool(calls, 'master_assign').execute(
      { label: 'A', brief: { goal: '查清 X' } },
      { agent: rootAgent },
    )
    assert.equal(child.appended.length, 0)
    assert.equal(existsSync(join(childWs, '.agent-master')), false)
    assert.deepEqual(
      (await readDeck(rootWs, 'root-1')).cards.map((card) => [card.status, card.assignee]),
      [['todo', null]],
    )

    // 认领由子会话发起，但 rootOf 仍解析到 root → 快照继续写 root 工作区
    const claimed = await findTool(calls, 'master_board').execute({ op: 'claim', cardId: 't1' }, { agent: child })
    assert.equal(claimed.card.assignee.sessionId, 'sess-child')
    assert.equal(existsSync(join(childWs, '.agent-master')), false)
    let deck = await readDeck(rootWs, 'root-1')
    assert.deepEqual(deck.cards.map((card) => [card.status, card.assignee.sessionId]), [['assigned', 'sess-child']])

    await findTool(calls, 'master_report').execute(
      { taskId: 't1', summary: 'X 成立', findings: [{ text: 'A' }], confidence: 'low', final: true },
      { agent: child },
    )

    // 子会话的 session 一个字节都没收到 deck，工作区也没有快照
    assert.equal(child.appended.length, 0)
    assert.equal(existsSync(join(childWs, '.agent-master')), false)
    // root 工作区里的最后一份快照已把子对话算成 review
    deck = await readDeck(rootWs, 'root-1')
    assert.deepEqual(
      deck.cards.map((card) => [card.status, card.assignee.name, card.sessionId]),
      [['review', 'agent-1', 'child-1']],
    )
    // deck 基于 rootId 的 Board（与工具同一份黑板）：认领 + finding + final 共 3 条记录
    assert.equal(deck.revision, 3)
    assert.equal(deck.counts.records, 3)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('wiring：root 会话没有 cwd 时 deck 退回调用方工作区（不静默丢快照）', async () => {
  const dir = await makeTempDir()
  const callerDir = await makeTempDir()
  try {
    const { ctx, calls } = fakeCtx()
    // root 活着但 cwd 为空：必须退到调用方会话，而不是只记诊断
    const root = makeAgent('root-1', '')
    const caller = makeAgent('sess-caller', callerDir)
    ctx.subagents.rootOf = () => root
    await apply(ctx, { dataDir: dir })

    const assigned = await findTool(calls, 'master_assign').execute(
      { label: 'A', brief: { goal: '任务一' } },
      { agent: caller },
    )
    assert.equal(assigned.ok, true)
    assert.equal(assigned.taskId, 't1')
    assert.equal(existsSync(deckPathOf(callerDir, 'root-1')), true, '应退回到有 cwd 的调用方工作区')
    assert.equal(existsSync(join(dir, '.agent-master')), false, 'dataDir 下不该出现快照')
    assert.equal(root.appended.length, 0)
    assert.equal(caller.appended.length, 0, '仍然不写任何会话事件')
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(callerDir, { recursive: true, force: true })
  }
})

test('wiring：rootOf 抛错时 deck 降级写调用方会话的工作区，工具仍成功', async () => {
  const dir = await makeTempDir()
  try {
    const { ctx, calls } = fakeCtx({
      rootOf() {
        throw new Error('rootOf 不可用')
      },
      namesOf: () => ['agent-x'],
    })
    const agent = makeAgent('sess-x', dir)
    await apply(ctx, { dataDir: dir })

    const collected = await findTool(calls, 'master_collect').execute({}, { agent })
    // collect 返回形状是公共契约（宿主/客户端/下游都按它读）：新增字段必须同步更新这里，防止下游漏字段。
    assert.deepEqual(collected, { children: [], missing: [], sources: { sources: [], duplicates: 0 } })

    // 降级：快照仍落在本次调用方会话的工作区，没有丢，会话日志与工具结果都不受影响
    assert.equal(agent.appended.length, 0)
    const deck = await readDeck(dir, 'sess-x')
    assert.equal(deck.version, DECK_VERSION)
    assert.equal(deck.revision, 0)
    assert.deepEqual(deck.cards, [])
    assert.deepEqual(deck.counts, {
      cards: 0,
      records: 0,
      violations: 0,
      todo: 0,
      assigned: 0,
      doing: 0,
      review: 0,
      done: 0,
      blocked: 0,
    })
    assert.deepEqual(deck.recent, [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/**
 * 严格 ctx：模拟真 cordis 的 context 代理 —— 访问 inject 之外、又不是核心成员或服务的属性，
 * 会抛 `cannot get property "X" without inject`。
 * 这条用例存在的理由：宽容的假 ctx 把 ctx.state 当普通属性放过了，
 * 结果 157 个测试全绿、真宿主一启动就 failed（2026-11-16 实测诊断原文）。
 */
test('wiring：严格 ctx（访问未注入属性即抛）下 apply 仍能完成', async () => {
  const { ctx: inner, calls } = fakeCtx()
  // inject 是 cordis Context 的方法（不是服务）：真宿主上可访问，这里一并放行。
  // 访问「没注入的服务」仍然抛错，保护目的不变。
  const ALLOWED = new Set(['effect', 'on', 'emit', 'get', 'logger', 'then', 'constructor', 'inject', ...inject])
  const strict = new Proxy(inner, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol') return Reflect.get(target, prop, receiver)
      if (ALLOWED.has(prop)) return Reflect.get(target, prop, receiver)
      throw new Error('cannot get property "' + String(prop) + '" without inject')
    },
  })

  const dispose = await apply(strict, {})
  assert.equal(typeof dispose, 'function')
  assert.equal(calls.tools.length, TOOL_NAMES.length)
  dispose()
})

test('wiring：assign 带 tools 时预分配 childId，子对话 created 后白名单生效（含自动补）', async () => {
  const dir = await makeTempDir()
  try {
    const { ctx, calls } = fakeCtx()
    await apply(ctx, { dataDir: dir })
    const assign = findTool(calls, 'master_assign')
    const root = makeAgent('root-1', dir)
    await assign.execute(
      { label: 'ticket-1', brief: { goal: '完成票 1' }, tools: ['read', 'pwsh'] },
      { agent: root },
    )

    assert.equal(calls.activations.length, 1)
    const childId = calls.activations[0].childId
    assert.match(childId, /^session-[0-9a-f-]{36}$/, '子对话必须预先拿到 childId，agent/created 才认得出它')

    const restricted = []
    const child = {
      id: childId,
      session: { append() {} },
      ctx: { tools: { restrict: (filter) => restricted.push(filter) } },
    }
    ctx.emit('agent/created', { agent: child, source: 'fresh' })

    assert.equal(restricted.length, 1, '子对话 created 时应该被限制一次')
    assert.deepEqual(restricted[0].allow, ['read', 'pwsh', 'master_report', 'master_board'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('wiring：未登记白名单的会话 created 时不被限制', async () => {
  const { ctx } = fakeCtx()
  await apply(ctx, { masterEnabled: false })
  const restricted = []
  const bystander = {
    id: 'session-unrelated',
    session: {},
    ctx: { tools: { restrict: (filter) => restricted.push(filter) } },
  }
  ctx.emit('agent/created', { agent: bystander })
  assert.equal(restricted.length, 0)
})

test('wiring：apply 登记 agents/workspaceRegistry 注入，引导出一个置顶的 master 会话', async () => {
  const dir = await makeTempDir()
  try {
    const { ctx, calls } = fakeCtx()
    await apply(ctx, { dataDir: dir })
    assert.equal(calls.injects.length, 1)
    assert.deepEqual(calls.injects[0].names, ['agents', 'workspaceRegistry'])

    const created = []
    const pinned = []
    const attached = []
    const scoped = {
      get(name) {
        if (name === 'agents') {
          return {
            async create(options) {
              created.push(options)
              options.setup({ tools: { restrict() {} } })
              return { agent: { session: { id: options.sessionId } } }
            },
          }
        }
        if (name === 'workspaceRegistry') {
          return {
            async create() {
              return {
                async attachSession(id) {
                  attached.push(id)
                },
              }
            },
            async pinSession(id) {
              pinned.push(id)
            },
          }
        }
        if (name === 'sessionTitle') return { rename() {} }
        return undefined
      },
    }
    calls.injects[0].callback(scoped)

    for (let i = 0; i < 200 && created.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(created.length, 1, 'apply 应该引导创建 1 个 master 会话')
    assert.equal(pinned.length, 1, 'master 会话应该被置顶')
    assert.equal(attached[0], created[0].sessionId)
    assert.deepEqual(created[0].meta.cwd, await realpath(process.cwd()))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('wiring：经验库按调用方会话的工作区解析，不在 apply() 时把目录钉死（真宿主回归）', async () => {
  const workspace = await makeTempDir()
  const stale = await makeTempDir()
  try {
    // 工作区里预置一条经验：它就是真机上 op=list 应该看得见的那条
    await mkdir(join(workspace, '.agent-master'), { recursive: true })
    await writeFile(
      join(workspace, '.agent-master', 'experience.jsonl'),
      JSON.stringify({
        op: 'save',
        titleKey: 'workspace-only',
        title: '工作区经验',
        lesson: '必须看得见',
        root_cause: '',
        fix: '',
        tags: [],
        scope: 'project',
        sourceCardId: '',
        ts: 1,
      }) + '\n',
      'utf8',
    )

    const { ctx, calls } = fakeCtx()
    // 真宿主里 apply() 执行时，工作区服务给出的还不是会话工作区（这里用 stale 复刻）。
    // 早算一次目录，之后所有读写就都落在 stale，且**不报错**——只表现为经验库永远是空的。
    ctx.get = (name) => (name === 'workingDirectory' ? { defaultDirectory: stale } : undefined)
    await apply(ctx, { dataDir: join(stale, 'data') })

    const agent = makeAgent('session-root', workspace)
    const listed = await findTool(calls, 'master_experience').execute({ op: 'list' }, { agent })
    assert.equal(listed.total, 1, '经验库必须按调用方会话的工作区解析，不能用 apply() 时的默认目录')
    assert.equal(listed.items[0].titleKey, 'workspace-only')

    // 写也必须落在同一个工作区：否则「验收写经验」会写进没人读的目录
    const saved = await findTool(calls, 'master_experience').execute(
      { op: 'save', title: '新的教训', lesson: '写也要落工作区' },
      { agent },
    )
    assert.equal(saved.action, 'created')
    const after = await findTool(calls, 'master_experience').execute({ op: 'list' }, { agent })
    assert.equal(after.total, 2, '写和读必须是同一个目录')
    assert.equal(existsSync(join(stale, '.agent-master', 'experience.jsonl')), false, '不该再往 apply() 时的目录写')
  } finally {
    await rm(workspace, { recursive: true, force: true })
    await rm(stale, { recursive: true, force: true })
  }
})

test('wiring：startActivation 必带 signal（真机回归：宿主对 undefined 调 throwIfAborted 直接炸）', async () => {
  const dir = await makeTempDir()
  try {
    const { ctx, calls } = fakeCtx({ rootOf: (agent) => agent })
    // 复刻宿主契约：signal 是必填参数，undefined 会在宿主第一行抛 TypeError
    // （真机原文：Cannot read properties of undefined (reading 'throwIfAborted')）
    ctx.subagents.startActivation = async (payload) => {
      payload.signal.throwIfAborted()
      calls.activations.push(payload)
      return { childId: payload.childId, name: payload.name ?? 'child' }
    }
    const agent = makeAgent('root-1', dir)
    await apply(ctx, { dataDir: dir })

    const assigned = await findTool(calls, 'master_assign').execute(
      { label: 'A', brief: { goal: '任务一' } },
      { agent },
    )
    assert.equal(assigned.taskId, 't1')
    assert.ok(calls.activations[0].signal instanceof AbortSignal, '必须把真实 AbortSignal 交给宿主')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('wiring：master_assign 的返回值必须是 lossless JSON（真机回归：宿主拒收含 Promise 的句柄）', async () => {
  const dir = await makeTempDir()
  try {
    const { ctx, calls } = fakeCtx({ rootOf: (agent) => agent })
    // 复刻宿主真实句柄：带 result(Promise) 与 dispose()，原样返回会被宿主判成非 lossless JSON
    ctx.subagents.startActivation = async (payload) => {
      calls.activations.push(payload)
      return {
        childId: payload.childId,
        name: payload.name ?? 'child',
        messageId: 'm-1',
        result: Promise.resolve('done'),
        dispose() {},
      }
    }
    const agent = makeAgent('root-1', dir)
    await apply(ctx, { dataDir: dir })

    const assigned = await findTool(calls, 'master_assign').execute(
      { label: 'A', brief: { goal: '任务一' } },
      { agent },
    )
    assert.equal(assigned.ok, true)
    assert.deepEqual(assigned.child, {
      childId: calls.activations[0].childId,
      name: 'child',
      messageId: 'm-1',
    })

    // 宿主就是这么校验的：整份返回值必须能无损往返，且不含函数/循环/Promise
    assert.deepEqual(JSON.parse(JSON.stringify(assigned)), assigned)
    const seen = new Set()
    const walk = (value, path) => {
      if (value === null) return
      if (typeof value === 'function') assert.fail('返回值里不能有函数：' + path)
      if (typeof value === 'undefined') assert.fail('返回值里不能有 undefined：' + path)
      if (typeof value !== 'object') return
      assert.equal(seen.has(value), false, '返回值里不能有循环引用：' + path)
      seen.add(value)
      for (const [key, item] of Object.entries(value)) walk(item, path + '.' + key)
    }
    walk(assigned, 'assign')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
