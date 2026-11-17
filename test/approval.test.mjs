/**
 * T11 派发审批（lib/approval.js）单测。
 *
 * 重点：fail-closed 的四种结局、approvalWaitMs 到点 abort、审批卡内容（每路 label/goal/约束条数/P 级/预估 token）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  APPROVAL_REQUIRED_TOOLS,
  buildApprovalPlan,
  countConstraints,
  createPreExecuteGate,
  estimatePayload,
  renderApprovalReason,
  requestApproval,
} from '../lib/approval.js'

const AGENT = { id: 'session-root' }

/** 造一个审批服务替身：记录调用参数并返回预设结局。 */
function fakeApproval(outcome, { delayMs = 0, onRequest } = {}) {
  /** @type {any[]} */
  const calls = []
  return {
    calls,
    async request(request) {
      calls.push(request)
      if (onRequest) await onRequest(request)
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
      return outcome
    },
  }
}

const BRIEF = {
  label: '调研',
  priority: 'P1',
  brief: { goal: '找出三个方案', constraints: ['只读', '不装包'], acceptance: ['给出对比'] },
}

// ---------------------------------------------------------------------------
// 审批卡内容：每路 label / goal / 约束条数 / P 级 / 预估 token
// ---------------------------------------------------------------------------

test('approval：单路计划带 label/goal/约束条数/P 级/预估 token', async () => {
  const plan = buildApprovalPlan('master_assign', BRIEF)
  assert.equal(plan.routes.length, 1)
  const route = plan.routes[0]
  assert.equal(route.label, '调研')
  assert.equal(route.goal, '找出三个方案')
  assert.equal(route.constraints, 3) // 2 constraints + 1 acceptance
  assert.equal(route.priority, 'P1')
  assert.ok(route.tokens >= 1)
  assert.ok(route.bytes > 0)
  assert.equal(plan.totalTokens, route.tokens)
})

test('approval：批量计划按路展开，合计 tokens 与约束数', async () => {
  const plan = buildApprovalPlan('master_dispatch', { briefs: [BRIEF, BRIEF, BRIEF] })
  assert.equal(plan.routes.length, 3)
  assert.equal(plan.totalConstraints, 9)
  assert.equal(plan.totalTokens, plan.routes.reduce((sum, route) => sum + route.tokens, 0))
})

test('approval：countConstraints 兼容字符串与数组两种写法', async () => {
  assert.equal(countConstraints({ constraints: '一条', acceptance: ['a', 'b'] }), 3)
  assert.equal(countConstraints({}), 0)
  assert.equal(countConstraints(null), 0)
})

test('approval：审批卡正文包含每一路与合计', async () => {
  const text = renderApprovalReason('master_dispatch', buildApprovalPlan('master_dispatch', { briefs: [BRIEF, BRIEF] }))
  assert.match(text, /批量派发 2 路/)
  assert.match(text, /1\. 调研/)
  assert.match(text, /2\. 调研/)
  assert.match(text, /合计：2 路/)
  assert.match(text, /约束 6 条/)
})

test('approval：estimatePayload 对不可序列化输入也不抛', async () => {
  const circular = {}
  circular.self = circular
  const result = estimatePayload(circular)
  assert.equal(result.bytes, 0)
  assert.equal(result.tokens, 1)
})

// ---------------------------------------------------------------------------
// 四种结局：fail-closed
// ---------------------------------------------------------------------------

test('approval：allowed-once 放行', async () => {
  const result = await requestApproval({ approval: fakeApproval('allowed-once'), agent: AGENT, toolName: 'master_assign', reason: 'x' })
  assert.equal(result.decision.kind, 'allow')
  assert.equal(result.outcome, 'allowed-once')
})

test('approval：rejected → deny，且文案说明台账可重试 + never 策略', async () => {
  const result = await requestApproval({ approval: fakeApproval('rejected'), agent: AGENT, toolName: 'master_assign', reason: 'x' })
  assert.equal(result.decision.kind, 'deny')
  assert.equal(result.outcome, 'rejected')
  assert.match(result.decision.reason, /被拒绝/)
  assert.match(result.decision.reason, /可重试/)
  assert.match(result.decision.reason, /never/)
})

test('approval：没有 approval 服务 → deny（不静默放行）', async () => {
  const result = await requestApproval({ approval: undefined, agent: AGENT, toolName: 'master_assign', reason: 'x' })
  assert.equal(result.decision.kind, 'deny')
  assert.equal(result.outcome, 'unavailable')
  assert.match(result.decision.reason, /没有 approval 服务/)
})

test('approval：没有 agent → deny（无处路由审批卡）', async () => {
  const result = await requestApproval({ approval: fakeApproval('allowed-once'), agent: undefined, toolName: 'master_assign', reason: 'x' })
  assert.equal(result.decision.kind, 'deny')
  assert.match(result.decision.reason, /没有 agent/)
})

test('approval：审批服务抛错 → deny（不把异常当批准）', async () => {
  const approval = {
    async request() {
      throw new Error('服务炸了')
    },
  }
  const result = await requestApproval({ approval, agent: AGENT, toolName: 'master_assign', reason: 'x' })
  assert.equal(result.decision.kind, 'deny')
  assert.match(result.decision.reason, /服务炸了/)
})

// ---------------------------------------------------------------------------
// approvalWaitMs：宿主没有超时参数，我们自己计时
// ---------------------------------------------------------------------------

test('approval：等待超过 approvalWaitMs → abort → deny，且文案带毫秒数', async () => {
  let aborted = false
  const approval = {
    async request(request) {
      // 模拟宿主：signal abort 时结算成 cancelled
      return await new Promise((resolve) => {
        if (request.signal.aborted) {
          aborted = true
          resolve('cancelled')
          return
        }
        request.signal.addEventListener('abort', () => {
          aborted = true
          resolve('cancelled')
        })
      })
    },
  }
  const result = await requestApproval({
    approval,
    agent: AGENT,
    toolName: 'master_assign',
    reason: 'x',
    waitMs: 30,
  })
  assert.equal(aborted, true)
  assert.equal(result.decision.kind, 'deny')
  assert.match(result.decision.reason, /超过 30 毫秒/)
  assert.match(result.decision.reason, /没有派发任何子对话/)
})

test('approval：waitMs=0 表示不设超时（不在我们自己这一侧打断）', async () => {
  const approval = fakeApproval('allowed-once', { delayMs: 20 })
  const result = await requestApproval({ approval, agent: AGENT, toolName: 'master_assign', reason: 'x', waitMs: 0 })
  assert.equal(result.decision.kind, 'allow')
})

// ---------------------------------------------------------------------------
// pre-execute 监听器
// ---------------------------------------------------------------------------

test('approval：只有派发类工具要审批，其它工具直接 next()', async () => {
  const gate = createPreExecuteGate({ config: { approvalWaitMs: 1000 }, approvalOf: () => fakeApproval('rejected') })
  assert.deepEqual([...APPROVAL_REQUIRED_TOOLS], ['master_assign', 'master_dispatch'])
  const passthrough = await gate({ name: 'master_collect', arguments: {} }, async () => ({ kind: 'allow' }))
  assert.deepEqual(passthrough, { kind: 'allow' })
})

test('approval：master_assign 被拒 → 监听器返回 deny（工具体不会执行）', async () => {
  const approval = fakeApproval('rejected')
  const gate = createPreExecuteGate({ config: { approvalWaitMs: 1000 }, approvalOf: () => approval })
  const decision = await gate(
    { name: 'master_assign', arguments: BRIEF, agent: AGENT, callId: 'call-1' },
    async () => ({ kind: 'allow' }),
  )
  assert.equal(decision.kind, 'deny')
  // 审批参数齐全：agent / toolName / callId / reason 里含计划表
  assert.equal(approval.calls.length, 1)
  const call = approval.calls[0]
  assert.equal(call.toolName, 'master_assign')
  assert.equal(call.callId, 'call-1')
  assert.equal(call.agent, AGENT)
  assert.match(call.reason, /调研/)
  assert.match(call.reason, /约束 3 条/)
  assert.equal(typeof call.displayReason.zh, 'string')
})

test('approval：master_dispatch 只请求一次审批（整批一次）', async () => {
  const approval = fakeApproval('allowed-once')
  const gate = createPreExecuteGate({ config: { approvalWaitMs: 1000 }, approvalOf: () => approval })
  const decision = await gate(
    { name: 'master_dispatch', arguments: { briefs: [BRIEF, BRIEF, BRIEF] }, agent: AGENT, callId: 'call-2' },
    async () => ({ kind: 'allow' }),
  )
  assert.equal(decision.kind, 'allow')
  assert.equal(approval.calls.length, 1)
  assert.match(approval.calls[0].reason, /批量派发 3 路/)
})
