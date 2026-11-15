/**
 * dsh-agent-master — 宿主接线单测（T5）。
 *
 * 全部用假 ctx：只记录 tools.register / systemPrompt.section / sessionProjections.register / effect 的调用，
 * 不发真 DSH。涉及黑板的行为用例用临时 dataDir 让真 Board/Ledger 落盘，
 * 这样 startActivation 的绑定、作者解析与 deck 事件都是可核对的真实证据，不是断言自证。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, inject, name } from '../lib/index.js'
import { AgentMasterConfigError } from '../lib/config.js'
import { TOOL_NAMES } from '../lib/tools.js'

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

/** 假 agent：只有接线用到的 id 与 session.append */
function makeAgent(id) {
  const appended = []
  return {
    id,
    appended,
    session: {
      append(type, data) {
        appended.push({ type, payload: data })
      },
    },
  }
}

/** 读黑板 JSONL（真落盘，用来核对 author 与记录类型） */
async function readBoardLines(dir, rootId) {
  const text = await readFile(join(dir, rootId, 'board.jsonl'), 'utf8')
  return text.split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line))
}

/** 按名取已注册的工具定义 */
function findTool(calls, toolName) {
  const definition = calls.tools.find((item) => item.name === toolName)
  assert.ok(definition, '没有注册工具 ' + toolName)
  return definition
}

test('wiring：inject 是契约里的四个服务，apply 返回 Promise', async () => {
  assert.deepEqual(inject, ['tools', 'systemPrompt', 'subagents', 'sessionProjections'])
  const { ctx } = fakeCtx()
  const pending = apply(ctx, {})
  assert.ok(pending instanceof Promise, 'apply 必须返回 Promise')
  const dispose = await pending
  assert.equal(typeof dispose, 'function')
})

test('wiring：注册 5 个契约工具名，每个都包在 ctx.effect 里且形状满足宿主校验', async () => {
  const { ctx, calls } = fakeCtx()
  await apply(ctx, {})

  assert.deepEqual(calls.tools.map((definition) => definition.name), [...TOOL_NAMES])
  // 5 工具 + 1 提示词 + 1 投影 + 1 按会话限制工具的监听，全部经 effect 注册（卸载才能回卷）
  assert.equal(calls.effects.length, 8)
  for (const label of calls.effects) assert.match(label, /^agent-master: /)
  for (const toolName of TOOL_NAMES) {
    assert.ok(calls.effects.some((label) => label.includes(toolName)), '工具 ' + toolName + ' 的注册没有走 effect')
  }
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
  assert.equal(definition.stateVersion, 1)
  assert.equal(definition.wire.summary, false)
  assert.equal(definition.wire.viewSchema, definition.stateSchema)
  assert.equal(typeof definition.stateSchema.parse, 'function')
  assert.equal(typeof definition.apply, 'function')
  // null = 尚无任何记录
  assert.equal(definition.init(), null)
  assert.equal(definition.stateSchema.parse(null), null)

  const state = {
    headSeq: 0,
    updatedAt: 1,
    children: [],
    counts: { tasks: 0, findings: 0, sources: 0, artifacts: 0, violations: 0 },
    recent: [],
  }
  assert.equal(definition.stateSchema.parse(state), state)
  assert.throws(() => definition.stateSchema.parse({ headSeq: 0 }), /updatedAt/)

  // 无关事件必须返回同一引用（否则下游白白重算）
  assert.equal(definition.apply(state, { type: 'agent/other' }), state)
  assert.equal(definition.apply(state, null), state)
  // deck 事件返回事件里的 deck 对象本身
  const deck = { ...state, headSeq: 3 }
  assert.equal(definition.apply(state, { type: 'agent-master/deck', data: { deck } }), deck)
  // 事件带 deck 事件名但没 data：保留原状态，不要塞 undefined
  assert.equal(definition.apply(state, { type: 'agent-master/deck', data: {} }), state)
  // wire.view 是恒等函数（客户端拿到的就是宿主状态）
  assert.equal(definition.wire.view(state), state)
})

test('wiring：master_assign 的 startActivation 绑定本次 exec.agent，并追加 deck 事件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'am-wire-'))
  try {
    const { ctx, calls } = fakeCtx({ rootOf: (agent) => agent })
    const rootAgent = makeAgent('root-1')
    await apply(ctx, { dataDir: dir })

    const assign = findTool(calls, 'master_assign')
    const result = await assign.execute(
      { label: '调研A', brief: { goal: '查清 X 是否成立' } },
      { agent: rootAgent },
    )
    assert.equal(result.ok, true)
    assert.equal(result.taskId, 't1')

    // 1. spawn 参数：provider/label/prompt/parent/delivery 全按契约
    assert.equal(calls.activations.length, 1)
    const spec = calls.activations[0]
    assert.equal(spec.provider, 'spawn')
    assert.equal(spec.delivery, 'parent')
    assert.equal(spec.label, '调研A')
    assert.equal(spec.parent, rootAgent, 'parent 必须是本次调用的 agent 实例本身')
    assert.deepEqual(spec.prompt.map((block) => block.type), ['text'])
    assert.match(spec.prompt[0].text, /t1/)
    assert.equal('name' in spec, false, '没有传 name 就不该塞 undefined 进去')

    // 2. 真黑板：一条 author=master 的 task 记录
    const lines = await readBoardLines(dir, 'root-1')
    assert.equal(lines.length, 1)
    assert.equal(lines[0].kind, 'task')
    assert.equal(lines[0].author.name, 'master')
    assert.deepEqual(lines[0].refs, ['t1'])

    // 3. deck 事件追加在本次调用的会话上
    assert.equal(rootAgent.appended.length, 1)
    const event = rootAgent.appended[0]
    assert.equal(event.type, 'agent-master/deck')
    assert.equal(event.payload.deck.headSeq, 1)
    assert.deepEqual(
      event.payload.deck.children.map((child) => [child.taskId, child.status]),
      [['t1', 'assigned']],
    )
    // 还没回报的孩子没有子会话记录：sessionId 必须是空串，不能借 master 的
    assert.equal(event.payload.deck.children[0].sessionId, '')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('wiring：master_report 按 namesOf 解析作者，子对话不会被归成同一个 child', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'am-wire-'))
  try {
    const rootAgent = makeAgent('root-1')
    const child = makeAgent('sess-child')
    const { ctx, calls } = fakeCtx({
      rootOf: (agent) => (agent === child ? rootAgent : agent),
      namesOf: (agent) => (agent === child ? ['agent-1'] : ['master']),
    })
    await apply(ctx, { dataDir: dir })

    await findTool(calls, 'master_assign').execute(
      { label: '调研A', brief: { goal: '查清 X' } },
      { agent: rootAgent },
    )
    const result = await findTool(calls, 'master_report').execute(
      {
        taskId: 't1',
        summary: 'X 成立',
        findings: [{ text: 'A 支持 X' }],
        evidence: [{ url: 'https://example.com/a', quote: '原文摘录' }],
        confidence: 'medium',
      },
      { agent: child },
    )
    assert.equal(result.ok, true)
    assert.deepEqual(result.violations, [])

    // 1. 黑板上的 author 就是子对话名（不是共用的 child）
    const lines = await readBoardLines(dir, 'root-1')
    const finding = lines.find((record) => record.kind === 'finding')
    assert.ok(finding)
    assert.equal(finding.author.name, 'agent-1')
    assert.equal(finding.author.sessionId, 'sess-child')

    // 2. deck 把这一路算成 reported，而不是留下一行 assigned；事件落在 root 会话（v1.2）
    const deckEvent = rootAgent.appended.filter((event) => event.type === 'agent-master/deck').at(-1)
    assert.ok(deckEvent)
    assert.deepEqual(
      deckEvent.payload.deck.children.map((item) => [item.name, item.status, item.sessionId]),
      [['agent-1', 'reported', 'sess-child']],
    )
    assert.equal(child.appended.length, 0, '子会话不该收到 deck 事件')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('wiring：两路不同子对话各自回报 → deck 两行，master_collect 后 master 会话拿到汇总', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'am-wire-'))
  try {
    const rootAgent = makeAgent('root-1')
    const childA = makeAgent('sess-a')
    const childB = makeAgent('sess-b')
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
    await assign.execute({ label: 'A', brief: { goal: '任务一' } }, { agent: rootAgent })
    await assign.execute({ label: 'B', brief: { goal: '任务二' } }, { agent: rootAgent })

    const report = findTool(calls, 'master_report')
    const base = { summary: '做完了', findings: [{ text: '发现' }], confidence: 'high' }
    await report.execute({ ...base, taskId: 't1' }, { agent: childA })
    await report.execute({ ...base, taskId: 't2' }, { agent: childB })

    const collected = await findTool(calls, 'master_collect').execute({}, { agent: rootAgent })
    assert.deepEqual(collected.children.map((item) => item.name).sort(), ['agent-1', 'agent-2'])

    // 前两次 assign 也各追加过一条，这里要的是 collect 之后那条（最后一条）
    const deckEvent = rootAgent.appended.filter((event) => event.type === 'agent-master/deck').at(-1)
    assert.ok(deckEvent)
    assert.deepEqual(
      deckEvent.payload.deck.children.map((item) => [item.name, item.taskId, item.status, item.sessionId]),
      [
        ['agent-1', 't1', 'reported', 'sess-a'],
        ['agent-2', 't2', 'reported', 'sess-b'],
      ],
    )
    assert.deepEqual(deckEvent.payload.deck.counts, { tasks: 2, findings: 2, sources: 0, artifacts: 0, violations: 0 })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('wiring：rootOf 抛错时兜底用 exec.agent.id，工具照常工作', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'am-wire-'))
  try {
    const { ctx, calls } = fakeCtx({
      rootOf() {
        throw new Error('rootOf 不可用')
      },
    })
    const agent = makeAgent('sess-x')
    await apply(ctx, { dataDir: dir })

    const head = await findTool(calls, 'master_board').execute({ op: 'head' }, { agent })
    assert.deepEqual(head, { seq: 0 })
    // 兜底之后目录按兜底 id 建（rootOf 不可用不该让工具失败）
    assert.ok(existsSync(join(dir, 'sess-x')), '兜底 rootId 应落在 sess-x 目录')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('wiring：只有 assign/report/collect 追加 deck 事件，只读工具不追加', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'am-wire-'))
  try {
    const { ctx, calls } = fakeCtx({ rootOf: (agent) => agent })
    const agent = makeAgent('root-1')
    await apply(ctx, { dataDir: dir })

    await findTool(calls, 'master_board').execute({ op: 'query', kind: 'task' }, { agent })
    await findTool(calls, 'master_digest').execute({ text: '短文本' }, { agent })
    assert.equal(agent.appended.length, 0)

    await findTool(calls, 'master_collect').execute({}, { agent })
    assert.equal(agent.appended.length, 1)
    assert.equal(agent.appended[0].type, 'agent-master/deck')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('wiring：disposer 逆序回卷全部注册，二次调用是 no-op', async () => {
  const { ctx, calls } = fakeCtx()
  const dispose = await apply(ctx, {})

  dispose()
  // 投影的 effect 返回 Promise<disposer>，回卷要等一个 tick 才落地
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(calls.disposals.length, calls.effects.length, '每个 effect 都要回卷一次')

  const before = calls.disposals.length
  dispose()
  assert.equal(calls.disposals.length, before, '二次调用不该再回卷一次')
})

test('wiring：非法配置让 apply 拒绝，且不在 ctx 上留下任何注册', async () => {
  const { ctx, calls } = fakeCtx()
  await assert.rejects(apply(ctx, { maxChildren: 0 }), AgentMasterConfigError)
  assert.deepEqual(calls.tools, [])
  assert.deepEqual(calls.sections, [])
  assert.deepEqual(calls.projections, [])
  assert.deepEqual(calls.effects, [])
})

test('wiring：deck 事件追加到 root 会话，不是发起调用的子会话', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'am-wire-'))
  try {
    const rootAgent = makeAgent('root-1')
    const child = makeAgent('sess-child')
    const { ctx, calls } = fakeCtx({
      rootOf: (agent) => (agent === child ? rootAgent : agent),
      namesOf: (agent) => (agent === child ? ['agent-1'] : ['master']),
    })
    await apply(ctx, { dataDir: dir })

    await findTool(calls, 'master_assign').execute(
      { label: 'A', brief: { goal: '查清 X' } },
      { agent: rootAgent },
    )
    const rootEventsBefore = rootAgent.appended.filter((event) => event.type === 'agent-master/deck').length
    assert.equal(child.appended.length, 0)

    await findTool(calls, 'master_report').execute(
      { taskId: 't1', summary: 'X 成立', findings: [{ text: 'A' }], confidence: 'low' },
      { agent: child },
    )

    // 子会话的 session 一个字节都没收到 deck
    assert.equal(child.appended.length, 0)
    // root 会话收到 assign + report 两条，最后一条已把子对话算成 reported
    const rootEvents = rootAgent.appended.filter((event) => event.type === 'agent-master/deck')
    assert.equal(rootEvents.length, rootEventsBefore + 1)
    const last = rootEvents.at(-1)
    assert.deepEqual(
      last.payload.deck.children.map((item) => [item.name, item.status, item.sessionId]),
      [['agent-1', 'reported', 'sess-child']],
    )
    // deck 基于 rootId 的 Board（与工具同一份黑板）：task + finding 共 2 条
    assert.equal(last.payload.deck.headSeq, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('wiring：rootOf 抛错时 deck 降级追加到调用方会话，工具仍成功', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'am-wire-'))
  try {
    const { ctx, calls } = fakeCtx({
      rootOf() {
        throw new Error('rootOf 不可用')
      },
      namesOf: () => ['agent-x'],
    })
    const agent = makeAgent('sess-x')
    await apply(ctx, { dataDir: dir })

    const collected = await findTool(calls, 'master_collect').execute({}, { agent })
    // collect 返回形状是公共契约（宿主/客户端/下游都按它读）：新增字段必须同步更新这里，防止下游漏字段。
    assert.deepEqual(collected, { children: [], missing: [], sources: { sources: [], duplicates: 0 } })
    // 降级：事件仍落在本次调用方会话上，没有丢，工具结果也不受影响
    const events = agent.appended.filter((event) => event.type === 'agent-master/deck')
    assert.equal(events.length, 1)
    assert.equal(events[0].payload.deck.headSeq, 0)
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
      throw new Error(`cannot get property "${String(prop)}" without inject`)
    },
  })

  const dispose = await apply(strict, {})
  assert.equal(typeof dispose, 'function')
  assert.equal(calls.tools.length, TOOL_NAMES.length)
  dispose()
})

test('wiring：assign 带 tools 时预分配 childId，子对话 created 后白名单生效（含自动补）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-master-wiring-tools-'))
  try {
    const { ctx, calls } = fakeCtx()
    await apply(ctx, { dataDir: dir })
    const assign = findTool(calls, 'master_assign')
    const root = makeAgent('root-1')
    await assign.execute({ label: 'ticket-1', brief: { goal: '完成票 1' }, tools: ['read', 'pwsh'] }, { agent: root })

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
  const dir = await mkdtemp(join(tmpdir(), 'agent-master-wiring-boot-'))
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
