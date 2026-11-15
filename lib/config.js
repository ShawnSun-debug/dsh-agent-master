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
  boardMaxEntries: 256,
  digestBudgetBytes: 65536,
  maxReportBytes: 8192,
  defaultEnabled: false,
  dataDir: null,
})

const NUMERIC_MINIMUM = Object.freeze({
  maxChildren: 1,
  maxParallelSearch: 1,
  boardMaxEntries: 1,
  digestBudgetBytes: 1024,
  maxReportBytes: 512,
})

export class AgentMasterConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AgentMasterConfigError'
  }
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
  return Object.freeze(out)
}

/** @param {NodeJS.ProcessEnv} [env] */
export function dshHome(env = process.env) {
  const fromEnv = env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  const profile = env.USERPROFILE
  if (typeof profile === 'string' && profile.length > 0) return profile
  return homedir()
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

export function boardFile(config, rootId, env = process.env) {
  return join(rootDir(config, rootId, env), 'board.jsonl')
}

export function ledgerFile(config, rootId, env = process.env) {
  return join(rootDir(config, rootId, env), 'ledger.jsonl')
}

export function artifactsDir(config, rootId, env = process.env) {
  return join(rootDir(config, rootId, env), 'artifacts')
}
