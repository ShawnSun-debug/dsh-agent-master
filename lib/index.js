/**
 * dsh-agent-master — 宿主侧入口（T5 接线）。
 *
 * 装载期：校验配置 → 注册 5 个工具、1 段分角色提示词、1 个会话投影。
 * 运行期：每个工具的 execute 都按**本次** exec.agent 解析 root 会话，
 * 再用 rootId 缓存 Board/Ledger（一个 root 只建一次），最后把黑板折算成 deck
 * 追加进会话事件 'agent-master/deck'，客户端投影据此折出 agentMaster 状态。
 *
 * 所有注册都包在 ctx.effect(() => …, 'label') 里：插件卸载时按逆序回卷，不留半初始化状态。
 * 本模块不 import @deepseek-ai/*：宿主 API 一律经 ctx 鸭子类型调用（api-notes §1/§2/§4/§5）。
 *
 * @module dsh-agent-master
 */

import { Board } from './board.js'
import { Ledger } from './ledger.js'
import { rootDir, validateConfig } from './config.js'
import { DECK_EVENT, DECK_STATE_VERSION, buildDeck, deckStateSchema } from './deck.js'
import { renderSection } from './sections.js'
import { createTools } from './tools.js'

export const name = 'dsh-agent-master'

/** 宿主服务：工具、提示词、子会话、会话投影（缺一个都会在装配期等待）。 */
export const inject = ['tools', 'systemPrompt', 'subagents', 'sessionProjections']

/** 执行成功后要刷新 deck 的工具：只有它们会改变黑板上可见的进度。 */
const DECK_TOOLS = Object.freeze(['master_assign', 'master_report', 'master_collect'])

/** 提示词 section 名（分角色：同一个 section 内按 agent 判 root/child）。 */
const SECTION_NAME = 'agent-master:master'

/** 宿主没给中央分配位时用的兜底 order（api-notes §2 的示例值）。 */
const SECTION_ORDER_FALLBACK = 9000

/** 诊断信息上限：ctx.state 是给人排查用的，不能无限长。 */
const DIAGNOSTIC_LIMIT = 20

/** 只为拿工具定义骨架而造的占位依赖：createTools 只做纯闭包，不会碰它们。 */
const STUB_BOARD = Object.freeze({
  async append() {},
  async query() {
    return []
  },
  async head() {
    return { seq: 0 }
  },
})
const STUB_LEDGER = Object.freeze({
  async append() {
    return {}
  },
})

/**
 * 把注册返回值收敛成 disposer：宿主不同版本可能给函数、给 { dispose }、或什么都不给。
 * @param {unknown} value
 * @returns {() => void}
 */
function toDisposer(value) {
  if (typeof value === 'function') return /** @type {() => void} */ (value)
  if (value && typeof value === 'object' && typeof (/** @type {any} */ (value).dispose) === 'function') {
    const disposable = /** @type {{dispose: () => unknown}} */ (value)
    return () => {
      disposable.dispose()
    }
  }
  return () => {}
}

/**
 * 装载插件。
 *
 * @param {any} ctx 宿主 Context（tools / systemPrompt / subagents / sessionProjections）
 * @param {Record<string, unknown>} [config]
 * @returns {Promise<() => void>} resolve 出可调用的 disposer（二次调用是 no-op）
 */
export async function apply(ctx, config) {
  // 1. 配置先行：非法配置必须在任何注册之前抛错，ctx 上不留半初始化状态
  const cfg = validateConfig(config)

  ctx.state ??= {}
  const diagnostics = { config: cfg, rootFallbacks: [], deckErrors: [] }
  ctx.state.agentMaster = diagnostics

  /** rootId → { dir, board, ledger, byAgent }，惰性建、按 root 只建一次 @type {Map<string, any>} */
  const roots = new Map()
  /** 所有 effect 的 disposer：手动 dispose 时逆序回卷 @type {(() => void)[]} */
  const disposers = []
  let disposed = false

  /** @param {string} bucket @param {Record<string, unknown>} entry */
  function note(bucket, entry) {
    const list = diagnostics[bucket]
    list.push({ ...entry, at: Date.now() })
    if (list.length > DIAGNOSTIC_LIMIT) list.shift()
  }

  /**
   * 解析本次调用的 root 会话 id：rootOf 拿不到就退回 agent 自己的 id，并记进 ctx.state。
   * @param {any} agent
   * @param {string} toolName
   * @returns {string}
   */
  function resolveRoot(agent, toolName) {
    const sessionId = typeof agent.id === 'string' && agent.id !== '' ? agent.id : null
    try {
      const root = ctx.subagents.rootOf(agent)
      if (root && typeof root.id === 'string' && root.id !== '') return root.id
      note('rootFallbacks', { tool: toolName, sessionId, reason: 'rootOf 没有返回带 id 的 root Agent' })
    } catch (error) {
      note('rootFallbacks', {
        tool: toolName,
        sessionId,
        reason: 'rootOf 抛错：' + String((error && error.message) || error),
      })
    }
    if (sessionId !== null) return sessionId
    throw new Error(toolName + ' 必须由会话内调用：拿不到调用方 agent 的 id')
  }

  /** 按 rootId 惰性建黑板/台账（目录用 rootDir(cfg, rootId)，Board 传 maxEntries）。 */
  function rootEntry(rootId) {
    let entry = roots.get(rootId)
    if (entry === undefined) {
      const dir = rootDir(cfg, rootId)
      entry = {
        dir,
        board: new Board({ dir, maxEntries: cfg.boardMaxEntries }),
        ledger: new Ledger({ dir }),
        byAgent: new WeakMap(),
      }
      roots.set(rootId, entry)
    }
    return entry
  }

  /**
   * spawnActivation 必须在调用期绑定**本次**的 exec.agent：
   * lib/tools.js 的 assign 只把 { label, name, prompt } 交进来，parent 由这里补。
   * @param {any} parent 活的 Agent 实例（api-notes §7：不能自己拼 { id }）
   */
  function spawnActivationFor(parent) {
    return async function spawnActivation(spec = {}) {
      /** @type {Record<string, unknown>} */
      const payload = {
        provider: 'spawn',
        label: spec.label,
        prompt: [{ type: 'text', text: String(spec.prompt ?? '') }],
        parent,
        delivery: 'parent',
      }
      if (typeof spec.name === 'string' && spec.name !== '') payload.name = spec.name
      return ctx.subagents.startActivation(payload)
    }
  }

  /**
   * 取（或建）某个 root + agent 的工具集。
   * Board/Ledger 严格按 rootId 只建一次；工具集按 agent 实例缓存（WeakMap，冷恢复后是新实例、不会拿旧 Agent 去 spawn）。
   * @param {string} rootId
   * @param {any} agent
   */
  function toolsFor(rootId, agent) {
    const entry = rootEntry(rootId)
    let tools = entry.byAgent.get(agent)
    if (tools === undefined) {
      tools = createTools({
        config: cfg,
        board: entry.board,
        ledger: entry.ledger,
        rootId,
        spawnActivation: spawnActivationFor(agent),
      })
      entry.byAgent.set(agent, tools)
    }
    return { entry, tools }
  }

  /** 子对话名：namesOf 拿不到就退回 'child'（归组会退化，但不丢记录）。 */
  function agentName(agent) {
    try {
      const names = ctx.subagents.namesOf(agent)
      if (Array.isArray(names)) {
        for (const item of names) {
          if (typeof item === 'string' && item !== '') return item
        }
      } else if (typeof names === 'string' && names !== '') {
        return names
      }
    } catch {
      // namesOf 失败不该让回报失败：作者退化成 child
    }
    return 'child'
  }

  /**
   * 把当前黑板折算成 deck 并追加会话事件。deck 是旁路：失败只记诊断，不影响工具结果。
   * @param {any} entry
   * @param {any} agent
   * @param {string} rootId
   */
  async function appendDeck(entry, agent, rootId) {
    const session = agent && agent.session
    if (!session || typeof session.append !== 'function') return
    try {
      const deck = await buildDeck({ board: entry.board, ledger: entry.ledger, rootId })
      await session.append(DECK_EVENT, { deck })
    } catch (error) {
      note('deckErrors', { message: String((error && error.message) || error) })
    }
  }

  /**
   * 一次工具执行的完整流程：解析 root → 取工具集 → 执行 → 成功后刷新 deck。
   * @param {string} toolName
   * @param {unknown} args
   * @param {any} exec
   */
  async function dispatch(toolName, args, exec) {
    const agent = exec ? exec.agent : undefined
    if (!agent || typeof agent !== 'object') {
      throw new Error(toolName + ' 必须由会话内的 agent 调用：exec.agent 缺失')
    }
    const rootId = resolveRoot(agent, toolName)
    const { entry, tools } = toolsFor(rootId, agent)
    const definition = tools.definitions.find((item) => item.name === toolName)
    if (definition === undefined) throw new Error('agent-master 没有这个工具：' + toolName)

    // master_report 的 author 必须按本次子会话解析，否则所有子对话会被归成同一个 child 组；
    // sessionId 拿不到就给空串，绝不把 'undefined' 写进黑板（客户端要拿它开子对话 tab）
    const runtime = toolName === 'master_report'
      ? {
          author: {
            sessionId: typeof agent.id === 'string' && agent.id !== '' ? agent.id : '',
            name: agentName(agent),
          },
        }
      : undefined

    const result = await definition.execute(args, runtime)
    if (DECK_TOOLS.includes(toolName)) await appendDeck(entry, agent, rootId)
    return result
  }

  /** 卸载：逆序回卷所有注册、清缓存、撤掉 ctx.state。二次调用是 no-op。 */
  function dispose() {
    if (disposed) return
    disposed = true
    for (let index = disposers.length - 1; index >= 0; index -= 1) {
      try {
        disposers[index]()
      } catch {
        // 单条回卷失败不该挡住其余回卷
      }
    }
    disposers.length = 0
    roots.clear()
    if (ctx.state && ctx.state.agentMaster === diagnostics) delete ctx.state.agentMaster
  }

  try {
    // 1) 五个工具。定义骨架来自 createTools（纯闭包，只为拿 name/description/parameters/output），
    //    execute 一律替换成按本次 exec.agent 解析的 dispatch。
    const skeleton = createTools({
      config: cfg,
      board: STUB_BOARD,
      ledger: STUB_LEDGER,
      spawnActivation: async () => {
        throw new Error('占位工具集不应被调用')
      },
      rootId: 'agent-master',
    })
    for (const definition of skeleton.definitions) {
      disposers.push(
        ctx.effect(
          () => toDisposer(ctx.tools.register({ ...definition, execute: (args, exec) => dispatch(definition.name, args, exec) })),
          'agent-master: 工具 ' + definition.name,
        ),
      )
    }

    // 2) 分角色提示词：同一个 section 按 context.agent 判 root/child；判不出来就给 master 段
    const masterText = renderSection({ role: 'master', config: cfg })
    const childText = renderSection({ role: 'child', config: cfg })
    let sectionOrder = SECTION_ORDER_FALLBACK
    if (typeof ctx.systemPrompt.getSectionOrder === 'function') {
      try {
        const assigned = ctx.systemPrompt.getSectionOrder('TOOL_GOAL')
        if (Number.isSafeInteger(assigned)) sectionOrder = assigned
      } catch {
        // 宿主没有这个位就退回常量
      }
    }
    disposers.push(
      ctx.effect(
        () => toDisposer(ctx.systemPrompt.section({
          name: SECTION_NAME,
          order: sectionOrder,
          text(context) {
            const agent = context ? context.agent : undefined
            if (!agent) return masterText
            try {
              const root = ctx.subagents.rootOf(agent)
              return root && root.id === agent.id ? masterText : childText
            } catch {
              // 判不出是不是 root 时给 master 段：宁可多给纪律，不静默丢
              return masterText
            }
          },
        })),
        'agent-master: 分角色提示词',
      ),
    )

    // 3) 会话投影：状态就是 deck 本身；无关事件必须返回同一引用（api-notes §4）
    const registration = {}
    disposers.push(
      ctx.effect(() => {
        const pending = ctx.sessionProjections.register({
          key: 'agentMaster',
          stateSchema: deckStateSchema,
          init: () => null,
          apply(current, event) {
            if (!event || event.type !== DECK_EVENT) return current
            const deck = event.data ? event.data.deck : undefined
            return deck === undefined ? current : deck
          },
          wire: { viewSchema: deckStateSchema, view: (state) => state, summary: false },
          stateVersion: DECK_STATE_VERSION,
        })
        registration.promise = pending
        // Cordis 允许 effect 的 execute 返回 Promise<disposer>；失败时给空 disposer，错误由下面 await 抛出
        return Promise.resolve(pending).then((handle) => toDisposer(handle), () => () => {})
      }, 'agent-master: 会话投影'),
    )
    // 注册真正完成后再把 apply 交出去（契约要求 await register）
    if (registration.promise !== undefined) await registration.promise
  } catch (error) {
    // 任一步注册失败：把已注册的回卷干净，再把原错误抛出去
    dispose()
    throw error
  }

  return dispose
}
