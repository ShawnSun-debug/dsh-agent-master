/**
 * lib/index.js 宿主接线验收。
 *
 * 核心手法：ctx 用**严格代理**——访问 inject 白名单之外的属性直接抛
 * cannot get property "X" without inject，复刻 cordis 的规则；apply 能跑通、
 * 且访问记录里没有白名单外的名字，才算接线干净。
 *
 * 注册面：TOOL_NAMES 个工具 + tools/pre-execute 审批门 + agent/created 限制器
 * + 1 段分角色提示词 + 1 个会话投影；disposer 逆序回卷、二次调用 no-op。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, inject, name, DECK_DIR_NAME, DECK_FILE_NAME } from '../lib/index.js'
import { AgentMasterConfigError, sanitizeRootId } from '../lib/config.js'
import { TOOL_NAMES } from '../lib/tools.js'
import { DECK_EVENT, DECK_STATE_VERSION, DECK_VERSION, deckStateSchema } from '../lib/deck.js'

/**
 * 严格 ctx：只有 cordis 核心方法与 inject 白名单里的服务可读，其余一律抛。
 * 同时记录每一次属性访问，供「不碰白名单外属性」的断言使用。
 */
function makeCtx(options = {}) {
  const calls = {
    tools: [],
    sections: [],
    projections: [],
    events: [],
    injects: [],
    effects: [],
    disposeOrder: [],
    accesses: [],
  }
  const services = {
    effect(execute, label) {
      const box = { dispose: null }
      const entry = { label, box, disposer: null }
      calls.effects.push(entry)
      const result = execute()
      if (result && typeof result.then === 'function') {
        result.then(
          (fn) => {
            box.dispose = typeof fn === 'function' ? fn : null
          },
          () => {},
        )
      } else {
        box.dispose = typeof result === 'function' ? result : null
      }
      entry.disposer = () => {
        if (typeof box.dispose === 'function') box.dispose()
      }
      return entry.disposer
    },
    tools: {
      register(definition) {
        calls.tools.push(definition)
        return () => calls.disposeOrder.push('tool:' + definition.name)
      },
    },
    on(event, handler) {
      calls.events.push({ event, handler })
      return () => calls.disposeOrder.push('on:' + event)
    },
    inject(deps, callback) {
      calls.injects.push([...deps])
      return () => {}
    },
    get(serviceName) {
      return services[serviceName]
    },
    systemPrompt: {
      getSectionOrder:
        options.sectionOrder === 'throw'
          ? () => {
              throw new Error('宿主没有这个位')
            }
          : options.sectionOrder === 'missing'
            ? undefined
            : () => (typeof options.sectionOrder === 'number' ? options.sectionOrder : 7000),
      section(section) {
        calls.sections.push(section)
        return () => calls.disposeOrder.push('section')
      },
    },
    subagents: {
      rootOf:
        options.rootOf === 'throws'
          ? () => {
              throw new Error('rootOf 不可用')
            }
          : options.rootOf || ((agent) => agent),
      namesOf: () => ['agent-1'],
      async startActivation() {
        throw new Error('装载期不该 spawn')
      },
    },
    sessionProjections: {
      async register(definition) {
        calls.projections.push(definition)
        return () => calls.disposeOrder.push('projection')
      },
    },
  }

  const CORE = ['effect', 'on', 'inject', 'get', 'tools', 'systemPrompt', 'subagents', 'sessionProjections']
  const allowed = new Set(CORE)
  const ctx = new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop === 'symbol') return undefined
        calls.accesses.push(prop)
        if (!allowed.has(prop)) {
          throw new TypeError('cannot get property "' + prop + '" without inject')
        }
        return services[prop]
      },
      set(_target, prop) {
        throw new TypeError('cannot set property "' + String(prop) + '" on ctx')
      },
    },
  )
  return { ctx, calls, services, allowed }
}

/** 建两个临时目录（工作区 + DSH_HOME），并在 finally 里恢复环境变量、删目录。 */
async function withWorkspace(body) {
  const home = await mkdtemp(join(tmpdir(), 'am-plugin-home-'))
  const workspace = await mkdtemp(join(tmpdir(), 'am-plugin-ws-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return await body({ home, workspace })
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
}

/** 工具体：按名字从注册列表里取。 */
function toolOf(calls, toolName) {
  const definition = calls.tools.find((item) => item.name === toolName)
  assert.ok(definition, '没有注册工具 ' + toolName)
  return definition
}

// ---------------------------------------------------------------------------
// 导出面与装载期
// ---------------------------------------------------------------------------

test('插件：导出 name / inject / 指挥台快照路径常量', () => {
  assert.equal(name, 'dsh-agent-master')
  assert.deepEqual(inject, ['tools', 'systemPrompt', 'subagents', 'sessionProjections'])
  assert.equal(DECK_DIR_NAME, '.agent-master')
  assert.equal(DECK_FILE_NAME, 'deck.json')
})

test('插件：非法配置在装载期抛错，ctx 上零访问零注册', async () => {
  const { ctx, calls } = makeCtx()
  await assert.rejects(
    () => apply(ctx, { maxCards: 0 }),
    (error) => {
      assert.ok(error instanceof AgentMasterConfigError)
      assert.match(error.message, /maxCards must be a safe integer >= 1/)
      return true
    },
  )
  // 配置先行：连 ctx 的属性都不该被摸到
  assert.deepEqual(calls.accesses, [])
  assert.deepEqual(calls.tools, [])
  assert.deepEqual(calls.sections, [])
  assert.deepEqual(calls.projections, [])
  assert.deepEqual(calls.effects, [])
})

test('插件：严格 ctx 下 apply 能完成，并返回可调用的 disposer', async () => {
  const { ctx, calls } = makeCtx()
  const dispose = await apply(ctx, {})
  assert.equal(typeof dispose, 'function')
  // 工具 + 审批门 + 会话限制器 + 提示词 + 投影，一个都不能少
  assert.equal(calls.effects.length, TOOL_NAMES.length + 4)
  assert.equal(calls.sections.length, 1)
  assert.equal(calls.projections.length, 1)
  dispose()
})

test('插件：注册的工具名齐全且顺序与 TOOL_NAMES 一致，每个都带 execute', async () => {
  const { ctx, calls } = makeCtx()
  const dispose = await apply(ctx, {})
  try {
    assert.deepEqual(calls.tools.map((item) => item.name), [...TOOL_NAMES])
    for (const definition of calls.tools) {
      assert.equal(typeof definition.description, 'string')
      assert.ok(definition.description.length > 0, definition.name + ' 缺 description')
      assert.equal(definition.parameters.type, 'object')
      assert.equal(typeof definition.execute, 'function')
      assert.ok(definition.output && typeof definition.output.render === 'function')
    }
  } finally {
    dispose()
  }
})

test('插件：apply 全程只访问 inject 白名单内的 ctx 属性（严格代理不抛）', async () => {
  const { ctx, calls } = makeCtx()
  const dispose = await apply(ctx, {})
  dispose()

  const touched = new Set(calls.accesses)
  for (const prop of touched) {
    assert.equal(
      ['effect', 'on', 'inject', 'get', 'tools', 'systemPrompt', 'subagents', 'sessionProjections'].includes(prop),
      true,
      '访问了 inject 之外的 ctx 属性：' + prop,
    )
  }
  // agents / workspaceRegistry 只能经 ctx.inject 拿 scoped ctx，不能直接摸全局
  for (const forbidden of ['agents', 'workspaceRegistry', 'approval', 'workingDirectory']) {
    assert.equal(touched.has(forbidden), false, '不该直接访问 ctx.' + forbidden)
  }
})

test('插件：装载期挂上 tools/pre-execute 审批门与 agent/created 限制器', async () => {
  const { ctx, calls } = makeCtx()
  const dispose = await apply(ctx, {})
  try {
    assert.deepEqual(calls.events.map((item) => item.event), ['tools/pre-execute', 'agent/created'])
    for (const item of calls.events) assert.equal(typeof item.handler, 'function')

    // agent/created 收到没有白名单的会话时：什么都不做，也不该抛
    let restrictCalls = 0
    assert.doesNotThrow(() =>
      calls.events[1].handler({
        agent: { id: 'session-unknown', ctx: { tools: { restrict: () => (restrictCalls += 1) } } },
      }),
    )
    assert.equal(restrictCalls, 0)
    // 空负载也不该炸（宿主字段可能缺）
    assert.doesNotThrow(() => calls.events[1].handler(undefined))
  } finally {
    dispose()
  }
})

// ---------------------------------------------------------------------------
// 提示词 section
// ---------------------------------------------------------------------------

test('插件：分角色提示词按 context.agent 判 root/child，判不出时给 master 段', async () => {
  const rootAgent = { id: 'session-root' }
  const childAgent = { id: 'session-child' }
  const { ctx, calls } = makeCtx({ rootOf: (agent) => rootAgent })
  const dispose = await apply(ctx, {})
  try {
    const section = calls.sections[0]
    assert.equal(section.name, 'agent-master:master')
    assert.equal(section.order, 7000)

    // root（rootOf 返回自己）→ master 段
    assert.match(section.text({ agent: rootAgent }), /^# 你是 master 会话/)
    // 子对话（rootOf 返回别人）→ child 段
    assert.match(section.text({ agent: childAgent }), /^# 你是子对话/)
    // 没有 agent、或 rootOf 抛错 → 都给 master 段，宁可多给纪律也不静默丢
    assert.match(section.text(undefined), /^# 你是 master 会话/)
  } finally {
    dispose()
  }

  const throwing = makeCtx({ rootOf: 'throws' })
  const dispose2 = await apply(throwing.ctx, {})
  try {
    assert.match(throwing.calls.sections[0].text({ agent: { id: 'session-x' } }), /^# 你是 master 会话/)
  } finally {
    dispose2()
  }
})

test('插件：getSectionOrder 缺失或抛错时 order 退回 9000 兜底值', async () => {
  for (const sectionOrder of ['missing', 'throw']) {
    const { ctx, calls } = makeCtx({ sectionOrder })
    const dispose = await apply(ctx, {})
    try {
      assert.equal(calls.sections[0].order, 9000, 'sectionOrder=' + sectionOrder + ' 时必须兜底')
    } finally {
      dispose()
    }
  }
  // 宿主给了就用宿主的
  const { ctx, calls } = makeCtx({ sectionOrder: 8123 })
  const dispose = await apply(ctx, {})
  try {
    assert.equal(calls.sections[0].order, 8123)
  } finally {
    dispose()
  }
})

// ---------------------------------------------------------------------------
// 会话投影
// ---------------------------------------------------------------------------

test('插件：会话投影 key/stateSchema/stateVersion 正确，无关事件必须返回同一引用', async () => {
  const { ctx, calls } = makeCtx()
  const dispose = await apply(ctx, {})
  try {
    const projection = calls.projections[0]
    assert.equal(projection.key, 'agentMaster')
    assert.equal(projection.stateVersion, DECK_STATE_VERSION)
    assert.equal(DECK_STATE_VERSION, 2, 'deck 已升 v2')
    assert.equal(projection.stateSchema, deckStateSchema)
    assert.equal(projection.wire.summary, false)
    assert.equal(typeof projection.apply, 'function')
    assert.equal(projection.init(), null)

    // 无关事件：必须返回**同一引用**（api-notes §4），不能让宿主误以为状态变了
    const current = { version: DECK_VERSION, revision: 1 }
    assert.equal(projection.apply(current, { type: 'message/user' }), current)
    assert.equal(projection.apply(current, null), current)
    // 本插件事件：data.deck 有值才替换，缺 data 保持原引用
    const deck = { version: DECK_VERSION, revision: 2, updatedAt: 1, cards: [], counts: {}, recent: [] }
    assert.equal(projection.apply(current, { type: DECK_EVENT, data: { deck } }), deck)
    assert.equal(projection.apply(current, { type: DECK_EVENT }), current)
  } finally {
    dispose()
  }
})

// ---------------------------------------------------------------------------
// disposer
// ---------------------------------------------------------------------------

test('插件：disposer 逆序回卷全部注册，二次调用是 no-op', async () => {
  const { ctx, calls } = makeCtx()
  const dispose = await apply(ctx, {})
  // 投影的 disposer 是异步拿到的：等一个 tick 再回卷
  await new Promise((resolve) => setImmediate(resolve))
  dispose()

  const expected = [
    'projection',
    'section',
    'on:agent/created',
    'on:tools/pre-execute',
    ...[...TOOL_NAMES].reverse().map((toolName) => 'tool:' + toolName),
  ]
  assert.deepEqual(calls.disposeOrder, expected)

  // 二次调用：不能再回卷一遍
  const snapshot = [...calls.disposeOrder]
  dispose()
  assert.deepEqual(calls.disposeOrder, snapshot)
})

test('插件：注册中途失败时先回卷已注册项，再把原错误抛出去', async () => {
  const { ctx, calls } = makeCtx()
  ctx.systemPrompt.section = () => {
    throw new Error('section 挂了')
  }
  await assert.rejects(() => apply(ctx, {}), /section 挂了/)
  // 工具 + 两个监听都已回卷干净，且严格逆序
  assert.deepEqual(calls.disposeOrder, [
    'on:agent/created',
    'on:tools/pre-execute',
    ...[...TOOL_NAMES].reverse().map((toolName) => 'tool:' + toolName),
  ])
  assert.deepEqual(calls.projections, [])
})

// ---------------------------------------------------------------------------
// master 引导注入
// ---------------------------------------------------------------------------

test('插件：masterEnabled 缺省时请求 agents/workspaceRegistry 注入，关掉后不请求', async () => {
  const on = makeCtx()
  const disposeOn = await apply(on.ctx, {})
  try {
    // 两条注入：契约引导（agents/workspaceRegistry）+ T14 的 dsh-Go 面板。
    assert.deepEqual(on.calls.injects, [['agents', 'workspaceRegistry'], ['dshGo']])
  } finally {
    disposeOn()
  }

  const off = makeCtx()
  const disposeOff = await apply(off.ctx, { masterEnabled: false })
  try {
    // 引导关掉只影响 master 会话自动创建；指挥台面板独立存在。
    assert.deepEqual(off.calls.injects, [['dshGo']])
  } finally {
    disposeOff()
  }
})

// ---------------------------------------------------------------------------
// 工具执行：root 解析 + deck 快照
// ---------------------------------------------------------------------------

test('插件：工具 execute 按本次 exec.agent 解析 root，成功后写 v2 deck 快照', async () => {
  await withWorkspace(async ({ workspace }) => {
    const { ctx, calls } = makeCtx()
    const dispose = await apply(ctx, {})
    try {
      const agent = { id: 'session-root', session: { header: { cwd: workspace } } }
      const result = await toolOf(calls, 'master_board').execute({ op: 'head' }, { agent })
      assert.equal(result.head.cards, 0)
      assert.equal(result.head.records, 0)

      const deckPath = join(workspace, DECK_DIR_NAME, sanitizeRootId('session-root'), DECK_FILE_NAME)
      const deck = JSON.parse(await readFile(deckPath, 'utf8'))
      assert.equal(deck.version, DECK_VERSION)
      assert.equal(DECK_VERSION, 2)
      assert.equal(deck.counts.cards, 0)
      assert.equal(deck.counts.records, 0)
      assert.deepEqual(deck.cards, [])
    } finally {
      dispose()
    }
  })
})

test('插件：exec.agent 缺失时报明确错误，且不落半份快照', async () => {
  await withWorkspace(async ({ workspace }) => {
    const { ctx, calls } = makeCtx()
    const dispose = await apply(ctx, {})
    try {
      await assert.rejects(
        () => toolOf(calls, 'master_board').execute({ op: 'head' }),
        (error) => {
          assert.match(error.message, /exec\.agent 缺失/)
          return true
        },
      )
      await assert.rejects(() => toolOf(calls, 'master_digest').execute({}, {}), /exec\.agent 缺失/)
      // 没走通 dispatch 就不该写快照目录
      await assert.rejects(access(join(workspace, DECK_DIR_NAME)), /ENOENT/)
    } finally {
      dispose()
    }
  })
})

test('插件：rootOf 抛错时退回本次调用方会话 id，仍能算出并写出快照', async () => {
  await withWorkspace(async ({ workspace }) => {
    const { ctx, calls } = makeCtx({ rootOf: 'throws' })
    const dispose = await apply(ctx, {})
    try {
      const agent = { id: 'session-child', session: { header: { cwd: workspace } } }
      const result = await toolOf(calls, 'master_board').execute({ op: 'head' }, { agent })
      assert.equal(result.head.cards, 0)

      const deckPath = join(workspace, DECK_DIR_NAME, sanitizeRootId('session-child'), DECK_FILE_NAME)
      const deck = JSON.parse(await readFile(deckPath, 'utf8'))
      assert.equal(deck.version, DECK_VERSION)
    } finally {
      dispose()
    }
  })
})
