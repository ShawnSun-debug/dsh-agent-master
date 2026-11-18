/**
 * dsh-agent-master — Master 会话：自动创建、工作区置顶、按会话限制工具。
 *
 * 这个模块只做三件事，且全部通过注入的依赖完成，不 import @deepseek-ai/*：
 * 1. 每个工作区一个 master 会话（cwd = 工作区根），创建后交给 workspaceRegistry 置顶；
 * 2. master 会话 (以及 master_assign 指定的子对话) 的工具白名单；
 * 3. masterSessionId 的落盘与复用（重启后不会重复建）。
 *
 * 为什么用 tools.restrict 而不是 agentPreset：restrict 是「本 agent 可见的工具集」，
 * 创建、冷恢复两条路径都能在 agent/created 时统一挂上；preset 是插件集合，
 * 改的是「挂哪些插件」，压不住全局已注册的终端工具。
 *
 * @module dsh-agent-master/master
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** master 会话默认可用的工具（7 个 master 工具 + read/write/edit + ask_user_question，不给终端） */
export const DEFAULT_MASTER_TOOLS = Object.freeze([
  'master_assign',
  'master_dispatch',
  'master_report',
  'master_collect',
  'master_board',
  'master_digest',
  'master_experience',
  'read',
  'write',
  'edit',
  'ask_user_question',
])

/** 子对话在 master 指定白名单之外自动补上的工具（交接契约要用 master_report，查黑板要用 master_board） */
export const DEFAULT_CHILD_TOOL_EXTRAS = Object.freeze(['master_report', 'master_board'])

/** master 会话在左栏的默认标题 */
export const DEFAULT_MASTER_TITLE = 'Master'

/** 工具白名单上限：再长就没有「省 token」的意义了 */
const MAX_TOOLS = 32

/** 建 master 会话时等宿主 agent 工厂就绪的重试次数与间隔（40 × 250ms ≈ 10 秒，覆盖慢启动） */
const CREATE_RETRY_TIMES = 40
const CREATE_RETRY_DELAY_MS = 250

/**
 * 单次 agents.create 的等待上限：真机上它可能**既不返回也不抛错**（宿主 agent 工厂
 * 还没就绪时表现为永久挂起），没有超时就会静默卡死、连诊断都留不下来。
 */
const CREATE_TIMEOUT_MS = 20000

export class MasterError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message)
    this.name = 'MasterError'
  }
}

/**
 * 规范化一份工具名白名单：去空白、去重、保序；非法输入直接抛错，不静默吞。
 *
 * @param {unknown} value 原始值（来自配置或工具参数）
 * @param {string} name 字段名（错误文案用）
 * @returns {string[] | null} 规范后的数组；null/undefined 表示「不限制」
 */
export function normalizeTools(value, name = 'tools') {
  if (value === undefined || value === null) return null
  if (!Array.isArray(value)) {
    throw new MasterError(name + ' 必须是字符串数组，实际收到 ' + JSON.stringify(value))
  }
  /** @type {string[]} */
  const out = []
  const seen = new Set()
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new MasterError(name + ' 的每一项都必须是非空字符串，实际收到 ' + JSON.stringify(item))
    }
    const tool = item.trim()
    if (seen.has(tool)) continue
    seen.add(tool)
    out.push(tool)
  }
  if (out.length > MAX_TOOLS) {
    throw new MasterError(name + ' 最多 ' + MAX_TOOLS + ' 个工具，实际收到 ' + out.length + ' 个')
  }
  return out
}

/**
 * 子对话最终的可见工具集：master 指定的 + 自动补的交接工具。
 *
 * @param {string[] | null} requested master_assign 传入的 tools（null = 不限制）
 * @param {readonly string[]} [extras] 自动补充的工具
 * @returns {string[] | null} null 表示不限制（交回宿主默认）
 */
export function childAllowList(requested, extras = DEFAULT_CHILD_TOOL_EXTRAS) {
  if (requested === null) return null
  const out = [...requested]
  for (const tool of extras) {
    if (!out.includes(tool)) out.push(tool)
  }
  return out
}

/**
 * 一个工作区一份 master 会话记录的落盘 store。
 * 文件按「工作区绝对路径的 sha256 前 16 位」命名，删文件即重置该工作区的 master。
 *
 * @param {{dir: string}} options
 * @returns {{read: (workspacePath: string) => Promise<any | null>, write: (workspacePath: string, record: any) => Promise<void>, file: (workspacePath: string) => string}}
 */
export function createMasterStore({ dir } = {}) {
  if (typeof dir !== 'string' || dir.trim() === '') {
    throw new MasterError('createMasterStore 需要一个非空的 dir')
  }
  /** @param {string} workspacePath */
  const file = (workspacePath) => {
    const digest = createHash('sha256').update(workspacePath).digest('hex').slice(0, 16)
    return join(dir, 'master-' + digest + '.json')
  }
  return {
    file,
    /**
     * @param {string} workspacePath
     * @returns {Promise<any | null>}
     */
    async read(workspacePath) {
      try {
        const raw = await readFile(file(workspacePath), 'utf8')
        /** @type {any} */
        let parsed
        try {
          parsed = JSON.parse(raw)
        } catch {
          // 坏 JSON 当作没有记录：一个损坏文件不该让 master 起不来
          return null
        }
        if (!parsed || typeof parsed !== 'object' || typeof parsed.sessionId !== 'string') return null
        return parsed
      } catch (error) {
        if (error && error.code === 'ENOENT') return null
        throw error
      }
    },
    /**
     * @param {string} workspacePath
     * @param {any} record
     */
    async write(workspacePath, record) {
      const target = file(workspacePath)
      await mkdir(dir, { recursive: true })
      await writeFile(target, JSON.stringify(record, null, 2), 'utf8')
    },
  }
}

/**
 * 把工作区路径归一化成 realpath：workspaceRegistry.create 与 attachSession 都用它比较。
 *
 * @param {string} path
 * @returns {Promise<string>}
 */
export async function canonicalDir(path) {
  return realpath(path)
}

/**
 * 判断 pinSession 的失败是不是「这个会话不在了」，只有这类失败才允许重建。
 *
 * @param {any} error
 * @returns {boolean}
 */
export function isMissingSessionError(error) {
  const name = error && error.name
  return name === 'WorkspaceUnknownSessionError' || name === 'WorkspaceArchivedSessionPinError'
}

/**
 * 判断 create 失败的常见原因是不是「宿主的 agent 工厂还没就绪」（插件先于 loop 加载）。
 *
 * @param {any} error
 * @returns {boolean}
 */
export function isFactoryNotReady(error) {
  const message = String((error && error.message) || error)
  return message.includes('agent factory') || message.includes('NO_FACTORY')
}

/** @param {number} ms */
/**
 * 给可能永久挂起的宿主调用加一个上限：超时用自己的错误 reject，并清掉计时器。
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {() => Error} makeError
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms, makeError) {
  /** @type {any} */
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(makeError()), ms)
    if (timer && typeof timer.unref === 'function') timer.unref()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 取宿主服务：真 cordis 用 ctx.get(name)（未 inject 也不会抛），测试里的假 ctx 直接读属性。
 *
 * @param {any} ctx
 * @param {string} name
 * @returns {any}
 */
function service(ctx, name) {
  if (typeof ctx.get === 'function') return ctx.get(name)
  return ctx[name]
}

/**
 * 失败时把「实际拿到的是什么」写进错误里：真宿主里服务未就绪时 ctx.get 可能是
 * undefined、空对象或只有部分方法的实例，只报「拿不到 X」根本没法判断。
 *
 * @param {any} value
 * @returns {string}
 */
function describeService(value) {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  const type = typeof value
  if (type !== 'object' && type !== 'function') return type + ' ' + String(value)
  const name = value.constructor && value.constructor.name ? value.constructor.name : '(anonymous)'
  let own = []
  let proto = []
  try { own = Object.keys(value) } catch { own = [] }
  try { proto = Object.getOwnPropertyNames(Object.getPrototypeOf(value) ?? {}) } catch { proto = [] }
  const pick = (list) => list.filter((key) => key !== 'constructor').slice(0, 12).join(',') || '（无）'
  return type + ' ' + name + ' [own: ' + pick(own) + '] [proto: ' + pick(proto) + ']'
}

/**
 * 从宿主 tools.restrict() 的报错里解析出「不认识的名字」。
 *
 * 宿主文案（dsh-tools/src/index.ts）：
 *   tools.restrict() names unknown global tools "read", "write"; known global tools: master_board, …
 * 这层信息是我们唯一能拿到的「宿主真实工具表」，所以解析它来收敛白名单，
 * 而不是让整个 master 引导因为一个缺失的名字直接失败。
 *
 * @param {unknown} message
 * @returns {string[]}
 */
export function parseUnknownTools(message) {
  if (typeof message !== 'string') return []
  const match = /names unknown global tool(?:s)? ((?:"[^"]+"(?:,\s*)?)+)/.exec(message)
  if (match === null) return []
  const names = []
  const re = /"([^"]+)"/g
  let hit
  while ((hit = re.exec(match[1])) !== null) names.push(hit[1])
  return names
}

/**
 * 按宿主真实工具表收敛白名单后调用 tools.restrict()。
 *
 * 为什么需要收敛：默认 master 工具集里有 read/write/edit/ask_user_question，
 * 而某些宿主组合（例如没装 tool-fs 的纯 headless/web 组合）根本没有这些全局工具，
 * 此时 restrict() 会整条抛错 —— 真机上表现为「Master 会话根本不出现」。
 *
 * @param {any} tools 宿主 agent 的 tools 服务
 * @param {string[]} allow 期望的白名单
 * @param {(message: string) => void} log 诊断出口
 * @returns {string[]} 实际生效的白名单
 */
export function restrictTools(tools, allow, log = () => {}) {
  if (!tools || typeof tools.restrict !== 'function') return [...allow]
  let current = [...allow]
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (current.length === 0) {
      log('宿主的全局工具表里没有白名单中的任何一项，跳过 restrict（master 会看到全部工具）')
      return []
    }
    try {
      tools.restrict({ allow: current })
      return current
    } catch (error) {
      const unknown = parseUnknownTools(error && error.message)
      if (unknown.length === 0) throw error
      const filtered = current.filter((name) => !unknown.includes(name))
      log('宿主没有这些全局工具，已从 master 白名单里去掉：' + unknown.join('、'))
      current = filtered
    }
  }
  return current
}

/**
 * 确保当前工作区有一个置顶的 master 会话：能用记录里的就复用，不能就新建。
 *
 * 依赖（全部注入，便于单测）：
 * - agents.create({ sessionId, meta, setup }) → { agent: { session } }
 * - workspaceRegistry.create(path) → { attachSession(id) }
 * - workspaceRegistry.pinSession(id)
 * - sessionTitle.rename(session, title)（可选）
 *
 * @param {{
 *   ctx: any,
 *   allow: readonly string[],
 *   cwd: string,
 *   title?: string,
 *   store: {read: Function, write: Function},
 *   log?: (message: string) => void,
 *   retryTimes?: number,
 *   retryDelayMs?: number,
 * }} deps
 * @returns {Promise<{sessionId: string, created: boolean, pinned: boolean, cwd: string}>}
 */
export async function ensureMasterSession(deps) {
  const { ctx, allow, store } = deps || {}
  if (!ctx || typeof ctx !== 'object') throw new MasterError('ensureMasterSession 需要 ctx')
  if (!Array.isArray(allow) || allow.length === 0) {
    throw new MasterError('ensureMasterSession 需要非空的工具白名单 allow')
  }
  if (typeof store?.read !== 'function' || typeof store?.write !== 'function') {
    throw new MasterError('ensureMasterSession 需要 store（read/write）')
  }
  const log = typeof deps.log === 'function' ? deps.log : () => {}
  const title = typeof deps.title === 'string' && deps.title.trim() !== '' ? deps.title.trim() : DEFAULT_MASTER_TITLE
  const retryTimes = Number.isSafeInteger(deps.retryTimes) && deps.retryTimes > 0 ? deps.retryTimes : CREATE_RETRY_TIMES
  const retryDelayMs = Number.isSafeInteger(deps.retryDelayMs) && deps.retryDelayMs >= 0 ? deps.retryDelayMs : CREATE_RETRY_DELAY_MS
  const createTimeoutMs = Number.isSafeInteger(deps.createTimeoutMs) && deps.createTimeoutMs > 0 ? deps.createTimeoutMs : CREATE_TIMEOUT_MS

  // 注入方可以直接把服务实例传进来（真宿主里 scoped ctx 的 .get 在回调后不可用）
  const agents = deps.agents !== undefined ? deps.agents : service(ctx, 'agents')
  const registry = deps.workspaceRegistry !== undefined ? deps.workspaceRegistry : service(ctx, 'workspaceRegistry')
  if (!agents || typeof agents.create !== 'function') {
    throw new MasterError(
      'ensureMasterSession 拿不到 agents.create（宿主 agent 服务未就绪）：ctx.get("agents") = ' + describeService(agents),
    )
  }
  if (!registry || typeof registry.pinSession !== 'function') {
    throw new MasterError(
      'ensureMasterSession 拿不到 workspaceRegistry（宿主工作区服务未就绪）：ctx.get("workspaceRegistry") = ' + describeService(registry),
    )
  }

  const cwd = await canonicalDir(deps.cwd)
  const saved = await store.read(cwd)

  if (saved && typeof saved.sessionId === 'string' && saved.sessionId !== '') {
    try {
      await registry.pinSession(saved.sessionId)
      return { sessionId: saved.sessionId, created: false, pinned: true, cwd }
    } catch (error) {
      if (!isMissingSessionError(error)) {
        log('复用已有 master 会话时 pin 失败：' + String((error && error.message) || error))
      }
      // 会话已不在（被删/归档）：落到下面重建
    }
  }

  const sessionId = 'session-' + randomUUID()
  /** @type {any} */
  let handle
  for (let attempt = 1; ; attempt += 1) {
    try {
      handle = await withTimeout(
        agents.create({
          sessionId,
          meta: { cwd },
          setup(agentCtx) {
            // 发布前就把白名单钉死：master 从第一步起就没有终端工具。
            // 用宿主真实工具表收敛，缺名字不该让整个引导失败。
            restrictTools(agentCtx && agentCtx.tools, allow, log)
          },
        }),
        createTimeoutMs,
        () => new MasterError(
          '创建 master 会话超时（' + createTimeoutMs + 'ms 无返回）：宿主 agents.create 既没返回也没抛错；' +
          '通常是宿主 agent 工厂未就绪。会话 id = ' + sessionId,
        ),
      )
      break
    } catch (error) {
      if (attempt >= retryTimes || !isFactoryNotReady(error)) throw error
      await delay(retryDelayMs)
    }
  }

  const sessionTitle = service(ctx, 'sessionTitle')
  if (sessionTitle && typeof sessionTitle.rename === 'function') {
    try {
      sessionTitle.rename(handle.agent.session, title)
    } catch (error) {
      log('设置 master 会话标题失败：' + String((error && error.message) || error))
    }
  }

  let pinned = false
  /** @type {any} */
  let workspace
  try {
    workspace = await registry.create(cwd)
  } catch (error) {
    log('登记 master 工作区失败：' + String((error && error.message) || error))
  }
  if (workspace && typeof workspace.attachSession === 'function') {
    // 刚创建的会话 header 可能还没落到持久化，attach 校验要用它，所以小幅重试
    let attached = false
    for (let attempt = 1; attempt <= 3 && !attached; attempt += 1) {
      try {
        await workspace.attachSession(sessionId)
        attached = true
      } catch (error) {
        if (attempt === 3) {
          // 归属失败不影响会话本身；置顶是全局的，仍然可见
          log('把 master 会话挂进工作区失败：' + String((error && error.message) || error))
        } else {
          await delay(100)
        }
      }
    }
  }
  try {
    await registry.pinSession(sessionId)
    pinned = true
  } catch (error) {
    log('置顶 master 会话失败：' + String((error && error.message) || error))
  }

  await store.write(cwd, { sessionId, cwd, title, at: Date.now() })
  return { sessionId, created: true, pinned, cwd }
}
