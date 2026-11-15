/**
 * dsh-agent-master — 宿主侧入口。
 *
 * T1 只做两件事：加载期校验配置（失败即拒绝装载），并导出后续票要用的契约。
 * 工具、投影、Remote、提示词在 T4/T5 追加到 apply()。
 *
 * @module dsh-agent-master
 */

import { DEFAULTS, validateConfig } from './config.js'

export const name = 'dsh-agent-master'

/** 需要的服务在后续票里追加（tools / subagents / systemPrompt / sessionProjections）。 */
export const inject = []

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [config]
 */
export function apply(ctx, config) {
  const resolved = validateConfig(config)
  ctx.state ??= {}
  ctx.state.agentMaster = { config: resolved }
  return () => {
    if (ctx.state) delete ctx.state.agentMaster
  }
}

export { DEFAULTS, validateConfig }
