/**
 * dsh-agent-master — T11：派发前审批（fail-closed）。
 *
 * 机制（ADR-0002，含一处**已记录的偏差**）：
 * - 挂 tools/pre-execute 监听；命中 master_assign / master_dispatch 时先要审批，拿到批准才放行。
 * - 宿主 approval 服务没有超时参数，而票面要求 approvalWaitMs 默认 600000 ——
 *   所以这里**自己调** ctx.approval.request(...) 并挂一个 AbortSignal 计时器：
 *   到点 abort → 服务结算成 cancelled → 我们返回 deny（fail-closed）。
 * - 没有 approval 服务 / 没有 agent / 超时 / 被拒，一律不 spawn。
 *
 * 与宿主 {kind:'ask'} 的关系：两者都落在同一个审批服务与同一张审批卡上；
 * 区别只在于「谁来计时」。选自己计时是为了让 approvalWaitMs 真的生效。
 *
 * @module dsh-agent-master/approval
 */

/** 需要审批的工具（派发类）。 */
export const APPROVAL_REQUIRED_TOOLS = Object.freeze(['master_assign', 'master_dispatch'])

/** 审批结论 → 是否放行。宿主三种非批准结局都要能区分，模型才知道是人拒了还是没通道。 */
export const APPROVAL_OUTCOMES = Object.freeze(['allowed-once', 'rejected', 'cancelled', 'unavailable'])

/** 估算 token：粗粒度按 4 字节 1 token，只用于让人心里有数，不求精确。 */
const BYTES_PER_TOKEN = 4

/** 审批拒绝的默认原因前缀（与宿主 approvalDenial 的语义对齐）。 */
export const APPROVAL_CODES = Object.freeze({
  REJECTED: 'APPROVAL_REJECTED',
  CANCELLED: 'APPROVAL_CANCELLED',
  UNAVAILABLE: 'APPROVAL_UNAVAILABLE',
  TIMEOUT: 'APPROVAL_TIMEOUT',
})

/** 超时/取消/无通道的统一说明：告诉人怎么开审批。 */
const ENABLE_HINT = '请在会话里开启审批（approval policy）后重试；策略为 never 时任何需要审批的操作都会被自动拒绝'

/**
 * 估算一段 JSON 的 token 与字节。
 * @param {unknown} value
 * @returns {{bytes: number, tokens: number}}
 */
export function estimatePayload(value) {
  let text
  try {
    text = JSON.stringify(value)
  } catch {
    text = ''
  }
  const bytes = typeof text === 'string' ? Buffer.byteLength(text, 'utf8') : 0
  return { bytes, tokens: Math.max(1, Math.ceil(bytes / BYTES_PER_TOKEN)) }
}

/**
 * 数一份 brief 里的约束条数（四组加起来）。
 * @param {any} brief
 * @returns {number}
 */
export function countConstraints(brief) {
  if (!brief || typeof brief !== 'object') return 0
  let total = 0
  for (const key of ['constraints', 'acceptance', 'boundaries', 'forbidden']) {
    const value = brief[key]
    if (Array.isArray(value)) total += value.length
    else if (value !== undefined && value !== null && value !== '') total += 1
  }
  return total
}

/**
 * 把一次派发折算成审批计划：每路 label / goal / 约束条数 / P 级 / 预估 token。
 *
 * @param {string} toolName master_assign | master_dispatch
 * @param {any} args 工具参数
 * @returns {{routes: any[], totalTokens: number, totalConstraints: number}}
 */
export function buildApprovalPlan(toolName, args) {
  const raw = args && typeof args === 'object' ? args : {}
  const briefs = toolName === 'master_dispatch'
    ? (Array.isArray(raw.briefs) ? raw.briefs : [])
    : [raw]
  /** @type {any[]} */
  const routes = []
  for (const [index, item] of briefs.entries()) {
    const brief = item && typeof item.brief === 'object' && item.brief !== null ? item.brief : item
    const estimate = estimatePayload(item)
    routes.push({
      index: index + 1,
      label: String(item?.label ?? item?.name ?? '(未命名)'),
      goal: String(brief?.goal ?? ''),
      constraints: countConstraints(brief),
      priority: String(item?.priority ?? 'P2'),
      bytes: estimate.bytes,
      tokens: estimate.tokens,
    })
  }
  return {
    routes,
    totalTokens: routes.reduce((sum, route) => sum + route.tokens, 0),
    totalConstraints: routes.reduce((sum, route) => sum + route.constraints, 0),
  }
}

/**
 * 渲染审批卡正文（给人看的那张表）。纯文本：审批卡的展示能力取决于宿主答案器。
 * @param {string} toolName
 * @param {any} plan
 * @returns {string}
 */
export function renderApprovalReason(toolName, plan) {
  const head = toolName === 'master_dispatch'
    ? '批量派发 ' + plan.routes.length + ' 路子对话，需要你批准：'
    : '派发 1 路子对话，需要你批准：'
  const rows = plan.routes.map((route) =>
    '  ' + route.index + '. ' + route.label +
    ' · ' + route.priority +
    ' · 约束 ' + route.constraints + ' 条' +
    ' · 约 ' + route.tokens + ' tokens' +
    ' · ' + (route.goal === '' ? '(无 goal)' : route.goal),
  )
  return [
    head,
    ...rows,
    '合计：' + plan.routes.length + ' 路 / 约束 ' + plan.totalConstraints + ' 条 / 约 ' + plan.totalTokens + ' tokens',
    '拒绝就不会创建任何子对话，台账条目会保留以便重试。',
  ].join('\n')
}

/**
 * 请求审批并按结论给出 PreToolDecision。
 *
 * @param {{
 *   approval: {request: Function},
 *   agent: any,
 *   toolName: string,
 *   callId?: string,
 *   reason: string,
 *   displayReason?: {en: string, [locale: string]: string},
 *   waitMs?: number,
 *   signal?: AbortSignal,
 *   now?: () => number,
 * }} input
 * @returns {Promise<{decision: {kind: 'allow'}|{kind: 'deny', reason: string, info?: any}, outcome: string, waitedMs: number}>}
 */
export async function requestApproval(input) {
  const {
    approval,
    agent,
    toolName,
    callId,
    reason,
    displayReason,
    waitMs = 0,
    signal,
    now = () => Date.now(),
  } = input ?? {}

  if (!approval || typeof approval.request !== 'function') {
    return {
      decision: { kind: 'deny', reason: '需要审批，但宿主没有 approval 服务；' + ENABLE_HINT },
      outcome: 'unavailable',
      waitedMs: 0,
    }
  }
  if (!agent || typeof agent !== 'object') {
    return {
      decision: { kind: 'deny', reason: '需要审批，但这次调用没有 agent（无处路由审批卡）；' + ENABLE_HINT },
      outcome: 'unavailable',
      waitedMs: 0,
    }
  }

  const started = now()
  // 计时器：waitMs>0 才计时；到点 abort，让审批服务把请求结算成 cancelled
  const controller = new AbortController()
  let timer = null
  let timedOut = false
  if (Number.isSafeInteger(waitMs) && waitMs > 0) {
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, waitMs)
    if (typeof timer.unref === 'function') timer.unref()
  }
  const combined = typeof AbortSignal.any === 'function' && signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal
  if (signal && typeof AbortSignal.any !== 'function' && signal.aborted) controller.abort()

  /** @type {string} */
  let outcome
  /** @type {string} */
  let serviceError = ''
  try {
    outcome = await approval.request({
      agent,
      toolName,
      ...(callId === undefined ? {} : { callId }),
      reason,
      ...(displayReason === undefined ? {} : { displayReason }),
      signal: combined,
    })
  } catch (error) {
    outcome = 'unavailable'
    serviceError = String((error && error.message) || error)
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
  const waitedMs = Math.max(0, now() - started)

  if (outcome === 'allowed-once') {
    return { decision: { kind: 'allow' }, outcome, waitedMs }
  }
  if (timedOut) {
    return {
      decision: {
        kind: 'deny',
        reason: '审批等待超过 ' + waitMs + ' 毫秒仍未有人应答：按失败处理，没有派发任何子对话。' + ENABLE_HINT,
      },
      outcome: 'cancelled',
      waitedMs,
    }
  }
  if (outcome === 'rejected') {
    return {
      decision: {
        kind: 'deny',
        reason: '审批被拒绝：没有派发任何子对话，台账条目保留可重试。' +
          '（若本会话审批策略为 never，任何审批都会被自动拒绝；' + ENABLE_HINT + '）',
      },
      outcome: 'rejected',
      waitedMs,
    }
  }
  if (outcome === 'cancelled') {
    return {
      decision: { kind: 'deny', reason: '审批被取消：没有派发任何子对话。' + ENABLE_HINT },
      outcome: 'cancelled',
      waitedMs,
    }
  }
  return {
    decision: {
      kind: 'deny',
      reason: '审批通道不可用（outcome=' + String(outcome) + (serviceError === '' ? '' : '，审批服务报错：' + serviceError) +
        '）：没有派发任何子对话。' + ENABLE_HINT,
    },
    outcome: 'unavailable',
    waitedMs,
  }
}

/**
 * 造一个 tools/pre-execute 监听器。宿主按 waterfall 调用：返回 {kind:'allow'|'deny'}。
 *
 * @param {{
 *   config: {approvalWaitMs?: number},
 *   approvalOf: (ctx?: any) => any,
 *   log?: (message: string) => void,
 *   now?: () => number,
 * }} options
 * @returns {(exec: any, next: () => Promise<any>) => Promise<any>}
 */
export function createPreExecuteGate(options = {}) {
  const { config = {}, approvalOf, log = () => {}, now = () => Date.now() } = options
  const waitMs = Number.isSafeInteger(config.approvalWaitMs) ? config.approvalWaitMs : 0

  return async function preExecuteGate(exec, next) {
    if (!exec || !APPROVAL_REQUIRED_TOOLS.includes(exec.name)) return next()
    const plan = buildApprovalPlan(exec.name, exec.arguments)
    const reason = renderApprovalReason(exec.name, plan)
    const displayReason = {
      en: 'Approve dispatch of ' + plan.routes.length + ' sub-conversation(s)?',
      zh: '批准派发 ' + plan.routes.length + ' 路子对话？',
    }
    const result = await requestApproval({
      approval: approvalOf(exec),
      agent: exec.agent,
      toolName: exec.name,
      callId: exec.callId,
      reason,
      displayReason,
      waitMs,
      signal: exec.signal,
      now,
    })
    log('审批 ' + exec.name + '：' + result.outcome + '（' + result.waitedMs + 'ms）')
    return result.decision
  }
}
