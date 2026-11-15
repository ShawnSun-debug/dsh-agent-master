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

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import { Board } from './board.js'
import { Ledger } from './ledger.js'
import { dataRoot, rootDir, validateConfig } from './config.js'
import {
  DEFAULT_MASTER_TITLE,
  DEFAULT_MASTER_TOOLS,
  createMasterStore,
  ensureMasterSession,
} from './master.js'
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

/** 诊断信息上限：只为排查用，不能无限长。 */
const DIAGNOSTIC_LIMIT = 20

/** 受限会话登记上限：超过就丢最早的一条，避免长进程无限增长。 */
const RESTRICTED_SESSION_LIMIT = 128

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

  // 诊断只留在闭包里：cordis 的 ctx 是服务代理，访问 inject 之外的名字会抛
  // `cannot get property "X" without inject`，所以**不能**往 ctx 上挂自定义字段。
  const diagnostics = { config: cfg, rootFallbacks: [], deckErrors: [], restrictErrors: [], master: [] }

  /** rootId → { dir, board, ledger, byAgent }，惰性建、按 root 只建一次 @type {Map<string, any>} */
  const roots = new Map()
  /** sessionId → 工具白名单：agent/created 时据此挂 tools.restrict（master 与受控子对话共用） @type {Map<string, string[]>} */
  const restrictedSessions = new Map()
  /** 已登记但还没 created 的子对话（childId → 白名单）：startActivation 前写入，agent/created 时读取 @type {Map<string, string[]>} */
  const pendingChildAllow = new Map()
  /** master 会话的引导结果（bootstrap 成功后填），只用于诊断 @type {any} */
  let masterState = null
  /** 引导只跑一次 @type {Promise<void> | null} */
  let masterBootstrap = null
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
   * 解析本次调用的 root 会话：rootOf 拿不到就退回 agent 自己的 id，并记进闭包诊断。
   *
   * 同时带回**活的 root Agent**（deck 事件要追加到它的 session，v1.2）；
   * 降级时 root 为 null，调用方据此退回本次 exec.agent 的 session。
   *
   * @param {any} agent
   * @param {string} toolName
   * @returns {{rootId: string, root: any | null}}
   */
  function resolveRoot(agent, toolName) {
    const sessionId = typeof agent.id === 'string' && agent.id !== '' ? agent.id : null
    try {
      const root = ctx.subagents.rootOf(agent)
      if (root && typeof root.id === 'string' && root.id !== '') return { rootId: root.id, root }
      note('rootFallbacks', { tool: toolName, sessionId, reason: 'rootOf 没有返回带 id 的 root Agent' })
    } catch (error) {
      note('rootFallbacks', {
        tool: toolName,
        sessionId,
        reason: 'rootOf 抛错：' + String((error && error.message) || error),
      })
    }
    if (sessionId !== null) return { rootId: sessionId, root: null }
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
   * 记住一个受限会话的白名单；超过上限丢掉最早的一条（master 早期派发的会话 resume 时仍要能恢复限制）。
   * @param {string} sessionId
   * @param {readonly string[]} allow
   */
  function rememberRestricted(sessionId, allow) {
    if (typeof sessionId !== 'string' || sessionId === '' || !Array.isArray(allow) || allow.length === 0) return
    restrictedSessions.set(sessionId, [...allow])
    while (restrictedSessions.size > RESTRICTED_SESSION_LIMIT) {
      const oldest = restrictedSessions.keys().next().value
      restrictedSessions.delete(oldest)
    }
  }

  /**
   * agent/created 是 serial 事件：新建与冷恢复都会触发，正好赶在第一步之前把工具白名单钉死。
   * @param {any} agent
   */
  function restrictAgent(agent) {
    if (!agent || typeof agent !== 'object' || typeof agent.id !== 'string') return
    const allow = restrictedSessions.get(agent.id) ?? pendingChildAllow.get(agent.id)
    if (!allow) return
    pendingChildAllow.delete(agent.id)
    try {
      // agent.ctx 是 scoped context：tools.restrict 只允许挂在这里（全局调用会抛）
      agent.ctx.tools.restrict({ allow: [...allow] })
    } catch (error) {
      note('restrictErrors', {
        sessionId: agent.id,
        message: String((error && error.message) || error),
      })
    }
  }

  /**
   * spawnActivation 必须在调用期绑定**本次**的 exec.agent：
   * lib/tools.js 的 assign 只把 { label, name, prompt, tools } 交进来，parent 与 childId 由这里补。
   *
   * 预先分配 childId 是关键：agent/created 靠它认出「这一路是我登记过白名单的子对话」，
   * 不用等 startActivation 返回（那时子对话可能已经跑完第一步、工具声明已经全量下发）。
   *
   * @param {any} parent 活的 Agent 实例（api-notes §7：不能自己拼 { id }）
   */
  function spawnActivationFor(parent) {
    return async function spawnActivation(spec = {}) {
      const childId = 'session-' + randomUUID()
      /** @type {Record<string, unknown>} */
      const payload = {
        provider: 'spawn',
        label: spec.label,
        prompt: [{ type: 'text', text: String(spec.prompt ?? '') }],
        parent,
        delivery: 'parent',
        childId,
      }
      if (typeof spec.name === 'string' && spec.name !== '') payload.name = spec.name
      const allow = Array.isArray(spec.tools) && spec.tools.length > 0 ? spec.tools : null
      if (allow !== null) pendingChildAllow.set(childId, [...allow])
      try {
        const activation = await ctx.subagents.startActivation(payload)
        if (allow !== null) rememberRestricted(childId, allow)
        return activation
      } catch (error) {
        pendingChildAllow.delete(childId)
        throw error
      }
    }
  }

  /** master 会话的 cwd：宿主有工作区服务就用它的默认目录，否则退回进程 cwd。 */
  function masterCwd() {
    try {
      const wd = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : undefined
      const dir = wd && typeof wd.defaultDirectory === 'string' ? wd.defaultDirectory : ''
      if (dir !== '') return dir
    } catch {
      // 工作区服务不可用不该挡住 master：退回进程 cwd
    }
    return process.cwd()
  }

  /**
   * 引导 master 会话：每工作区一个、置顶、工具白名单。失败只记诊断，绝不影响工具注册。
   * @param {any} scoped 已注入 agents/workspaceRegistry 的 scoped ctx
   */
  function bootstrapMaster(scoped) {
    if (masterBootstrap !== null) return masterBootstrap
    if (cfg.masterEnabled === false) {
      masterBootstrap = Promise.resolve()
      return masterBootstrap
    }
    masterBootstrap = (async () => {
      try {
        const cwd = masterCwd()
        const allow = cfg.masterTools ?? [...DEFAULT_MASTER_TOOLS]
        const store = createMasterStore({ dir: join(dataRoot(cfg), 'masters') })
        // 先登记记录里的 sessionId：用户抢在 bootstrap 之前点开旧 master 会话时，resume 也能被限制
        try {
          const saved = await store.read(cwd)
          if (saved && typeof saved.sessionId === 'string') rememberRestricted(saved.sessionId, allow)
        } catch (error) {
          note('master', { message: '读 master 记录失败：' + String((error && error.message) || error) })
        }
        const result = await ensureMasterSession({
          ctx: scoped,
          allow,
          cwd,
          title: cfg.masterTitle ?? DEFAULT_MASTER_TITLE,
          store,
          log: (message) => note('master', { message }),
        })
        rememberRestricted(result.sessionId, allow)
        masterState = result
        if (!result.created && !result.pinned) note('master', { message: '复用 master 会话但置顶失败：' + result.sessionId })
      } catch (error) {
        note('master', { message: '引导 master 会话失败：' + String((error && error.message) || error) })
      }
    })()
    return masterBootstrap
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
   *
   * v1.2：事件一律追加到 **root 会话** —— master_report 跑在子会话里，
   * 若写进子会话，master 的指挥台要等下一次 assign/collect 才看得到回报。
   * rootOf 降级（root 为 null）或 root 没有可写 session 时退回本次调用方会话，
   * 保证事件不丢、工具也不因此失败。deck 始终基于 rootId 的 Board 计算（与工具同一份黑板）。
   *
   * @param {any} entry
   * @param {any | null} root rootOf 解析出的活 Agent（降级时为 null）
   * @param {any} agent 本次调用的 exec.agent
   * @param {string} rootId
   */
  async function appendDeck(entry, root, agent, rootId) {
    const rootUsable = Boolean(root && root.session && typeof root.session.append === 'function')
    const session = rootUsable ? root.session : agent && agent.session
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
    const { rootId, root } = resolveRoot(agent, toolName)
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
    if (DECK_TOOLS.includes(toolName)) await appendDeck(entry, root, agent, rootId)
    return result
  }

  /** 卸载：逆序回卷所有注册、清缓存。二次调用是 no-op。 */
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
    restrictedSessions.clear()
    pendingChildAllow.clear()
    masterState = null
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

    // 2) 按会话限制工具：master 与 master_assign 指定的子对话都在 agent/created 时钉白名单。
    //    监听器放在最前面：它不依赖其它注册，越早挂上，越不会漏掉插件加载期创建的会话。
    if (typeof ctx.on === 'function') {
      disposers.push(
        ctx.effect(() => {
          const off = ctx.on('agent/created', (payload) => {
            restrictAgent(payload && payload.agent)
          })
          return toDisposer(off)
        }, 'agent-master: 按会话限制工具'),
      )
    }

    // 3) 分角色提示词：同一个 section 按 context.agent 判 root/child；判不出来就给 master 段
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

    // 4) 会话投影：状态就是 deck 本身；无关事件必须返回同一引用（api-notes §4）
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

    // 5) master 会话引导：每工作区一个、置顶、工具白名单。
    //    异步进行（可能要等宿主 agent 工厂就绪），失败只记诊断，不影响工具可用性。
    if (cfg.masterEnabled !== false && typeof ctx.inject === 'function') {
      try {
        ctx.inject(['agents', 'workspaceRegistry'], (scoped) => {
          if (disposed) return
          void bootstrapMaster(scoped)
        })
      } catch (error) {
        note('master', { message: '注入 agents/workspaceRegistry 失败：' + String((error && error.message) || error) })
      }
    }
  } catch (error) {
    // 任一步注册失败：把已注册的回卷干净，再把原错误抛出去
    dispose()
    throw error
  }

  return dispose
}
