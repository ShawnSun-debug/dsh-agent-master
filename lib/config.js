/**
 * dsh-agent-master — 配置与落盘路径。
 *
 * 未知键在加载期报错，而不是被静默忽略：用户改了拼写必须立刻知道。
 *
 * @module dsh-agent-master/config
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const DEFAULTS = Object.freeze({
  maxChildren: 4,
  maxParallelSearch: 4,
  // 卡片配额（张）与证据流配额（条）互不挤占（T09 验收第 6 条）
  maxCards: 32,
  boardMaxEntries: 256,
  digestBudgetBytes: 65536,
  maxReportBytes: 8192,
  // 派发审批的等待窗口（毫秒）。宿主 approval 服务没有超时参数，
  // 由 lib/approval.js 自己起 AbortSignal 计时；0 表示无限等（不设超时）
  approvalWaitMs: 600000,
  defaultEnabled: false,
  dataDir: null,
  masterEnabled: true,
  masterTitle: 'Master',
  masterTools: null,
  childToolExtras: null,
})

const NUMERIC_MINIMUM = Object.freeze({
  maxChildren: 1,
  maxParallelSearch: 1,
  maxCards: 1,
  boardMaxEntries: 1,
  digestBudgetBytes: 1024,
  maxReportBytes: 512,
  approvalWaitMs: 0,
})

export class AgentMasterConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AgentMasterConfigError'
  }
}

/**
 * 校验一份工具名列表：null 表示用默认；数组则去空白、去重、保序。
 *
 * @param {unknown} value
 * @param {string} key 配置键名（错误文案用）
 * @param {{allowEmpty: boolean}} options 是否允许空数组
 * @returns {string[] | null}
 */
function normalizeToolList(value, key, options) {
  if (value === null || value === undefined) return null
  if (!Array.isArray(value)) {
    throw new AgentMasterConfigError(key + ' must be null or an array of tool names')
  }
  /** @type {string[]} */
  const out = []
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new AgentMasterConfigError(key + ' must contain only non-empty tool names')
    }
    const tool = item.trim()
    if (!out.includes(tool)) out.push(tool)
  }
  if (out.length === 0 && !options.allowEmpty) {
    throw new AgentMasterConfigError(key + ' must not be empty')
  }
  return out
}

/**
 * @param {Record<string, unknown>} [raw]
 * @returns {Readonly<typeof DEFAULTS>}
 */
export function validateConfig(raw = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AgentMasterConfigError('config must be an object')
  }
  const out = { ...DEFAULTS }
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) {
      throw new AgentMasterConfigError(`unknown config key: ${key}`)
    }
    out[key] = value
  }
  for (const [key, minimum] of Object.entries(NUMERIC_MINIMUM)) {
    const value = out[key]
    if (!Number.isSafeInteger(value) || value < minimum) {
      throw new AgentMasterConfigError(`${key} must be a safe integer >= ${minimum}`)
    }
  }
  if (typeof out.defaultEnabled !== 'boolean') {
    throw new AgentMasterConfigError('defaultEnabled must be a boolean')
  }
  if (out.dataDir !== null && (typeof out.dataDir !== 'string' || out.dataDir.length === 0)) {
    throw new AgentMasterConfigError('dataDir must be null or a non-empty string')
  }
  if (typeof out.masterEnabled !== 'boolean') {
    throw new AgentMasterConfigError('masterEnabled must be a boolean')
  }
  if (typeof out.masterTitle !== 'string' || out.masterTitle.trim() === '') {
    throw new AgentMasterConfigError('masterTitle must be a non-empty string')
  }
  out.masterTitle = out.masterTitle.trim()
  out.masterTools = normalizeToolList(out.masterTools, 'masterTools', { allowEmpty: false })
  out.childToolExtras = normalizeToolList(out.childToolExtras, 'childToolExtras', { allowEmpty: true })
  return Object.freeze(out)
}

/** @param {NodeJS.ProcessEnv} [env] */
export function dshHome(env = process.env) {
  const fromEnv = env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  const profile = env.USERPROFILE
  // DSH_HOME 本身就是 .dsh 目录（宿主按这个约定给 profiles/ 等），
  // 所以退回 USERPROFILE / homedir() 时必须补一层 .dsh —— 真机踩过：
  // 桌面应用进程里没有 DSH_HOME（只有 shell 子进程有），旧实现直接返回 USERPROFILE，
  // 看板/台账/产物全写进 C:\Users\<me>\agent-master，而体检脚本查 ~/.dsh/agent-master，
  // 两边对不上、体检还一片 ✅。
  if (typeof profile === 'string' && profile.length > 0) return join(profile, '.dsh')
  return join(homedir(), '.dsh')
}

/**
 * 一个 root 会话一个目录，便于审计与回滚：删目录即彻底清理。
 *
 * @param {Readonly<typeof DEFAULTS>} config
 * @param {NodeJS.ProcessEnv} [env]
 */
export function dataRoot(config, env = process.env) {
  return resolve(config.dataDir ?? join(dshHome(env), 'agent-master'))
}

/** Session id 进路径前必须净化，避免路径穿越与非法字符。 */
export function sanitizeRootId(rootId) {
  const text = String(rootId ?? '')
  const safe = text.replace(/[^A-Za-z0-9_-]/g, '-')
  if (safe.length === 0) throw new AgentMasterConfigError('root session id is empty after sanitizing')
  return safe
}

/**
 * @param {Readonly<typeof DEFAULTS>} config
 * @param {string} rootId
 * @param {NodeJS.ProcessEnv} [env]
 */
export function rootDir(config, rootId, env = process.env) {
  return join(dataRoot(config, env), sanitizeRootId(rootId))
}

/** 看板（ADR-0001）：单文件 board.json = { cards, records }。 */
export function boardFile(config, rootId, env = process.env) {
  return join(rootDir(config, rootId, env), 'board.json')
}

/** 旧黑板（append-only JSONL）：只在 T10 迁移时读，迁移后保留不删。 */
export function boardJsonlFile(config, rootId, env = process.env) {
  return join(rootDir(config, rootId, env), 'board.jsonl')
}

export function ledgerFile(config, rootId, env = process.env) {
  return join(rootDir(config, rootId, env), 'ledger.jsonl')
}

export function artifactsDir(config, rootId, env = process.env) {
  return join(rootDir(config, rootId, env), 'artifacts')
}
