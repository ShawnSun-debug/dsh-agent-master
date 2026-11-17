/**
 * dsh-agent-master — 派发策略阶梯（dispatch）单测。
 *
 * 六条分支各有用例；四个「顺序优先」用例把阶梯优先级锁死
 * （summary 先于容量、original 先于容量、escalate 先于体积、board-only 先于 skip）；
 * 非法输入一律抛 DispatchError，且一次列全问题，不靠默认值猜。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { COST_HINTS, DispatchError, STRATEGIES, chooseDispatch } from '../lib/dispatch.js'

/** 一份合规输入，按用例覆盖字段 */
function input(overrides = {}) {
  return {
    payloadBytes: 4000,
    budgetBytes: 8000,
    childCapacity: 2,
    sameModelAvailability: false,
    priorAttemptFailed: false,
    sharedStateUpdated: true,
    ...overrides,
  }
}

test('dispatch：STRATEGIES 五档顺序固定、成本档齐全且都能被真实输入命中', () => {
  assert.deepEqual([...STRATEGIES], ['summary', 'original', 'skip', 'escalate', 'board-only'])
  assert.deepEqual(
    { ...COST_HINTS },
    { summary: 'medium', original: 'high', escalate: 'high', skip: 'low', 'board-only': 'low' },
  )

  // 没有不可达分支：五档各有一条真实输入
  const cases = [
    input({ payloadBytes: 2000 }),
    input({ payloadBytes: 6000, priorAttemptFailed: true }),
    input({ payloadBytes: 6000, childCapacity: 0 }),
    input({ payloadBytes: 12000, sharedStateUpdated: false }),
    input({ payloadBytes: 12000, sharedStateUpdated: true }),
  ]
  const seen = cases.map((item) => chooseDispatch(item).strategy)
  assert.deepEqual(new Set(seen), new Set(STRATEGIES))
})

test('dispatch：第1档——体积不超过四分之一预算 → summary', () => {
  const result = chooseDispatch(input({ payloadBytes: 2000, budgetBytes: 8000 }))
  assert.equal(result.strategy, 'summary')
  assert.equal(result.costHint, 'medium')
  assert.match(result.reason, /四分之一/)
  assert.deepEqual(Object.keys(result), ['strategy', 'reason', 'costHint'])
})

test('dispatch：第2档——预算内但摘要失败过 → original', () => {
  const result = chooseDispatch(input({ payloadBytes: 6000, budgetBytes: 8000, priorAttemptFailed: true }))
  assert.equal(result.strategy, 'original')
  assert.equal(result.costHint, 'high')
  assert.match(result.reason, /摘要已经失败过一次/)
  assert.match(result.reason, /原文/)
})

test('dispatch：第3档——没有空位 → escalate', () => {
  const result = chooseDispatch(input({ payloadBytes: 6000, childCapacity: 0, sameModelAvailability: true }))
  assert.equal(result.strategy, 'escalate')
  assert.equal(result.costHint, 'high')
  assert.match(result.reason, /没有空位/)
  assert.match(result.reason, /换更强的现有子会话或等位/)
  assert.match(result.reason, /同模型可用性：有/)
})

test('dispatch：第4档——超预算且共享状态未更新 → board-only', () => {
  const result = chooseDispatch(input({ payloadBytes: 12000, sharedStateUpdated: false }))
  assert.equal(result.strategy, 'board-only')
  assert.equal(result.costHint, 'low')
  assert.match(result.reason, /共享状态还没更新/)
  assert.match(result.reason, /黑板/)
})

test('dispatch：第5档——超预算且黑板已更新 → skip', () => {
  const result = chooseDispatch(input({ payloadBytes: 12000, sharedStateUpdated: true }))
  assert.equal(result.strategy, 'skip')
  assert.equal(result.costHint, 'low')
  assert.match(result.reason, /超出预算/)
  assert.match(result.reason, /本次不传/)
})

test('dispatch：第6档（余项）——预算内、摘要没失败过 → summary', () => {
  const result = chooseDispatch(input({ payloadBytes: 6000, budgetBytes: 8000 }))
  assert.equal(result.strategy, 'summary')
  assert.equal(result.costHint, 'medium')
  assert.match(result.reason, /摘要没失败过/)
})

test('dispatch：顺序优先——体积很小先于容量检查 → summary', () => {
  const result = chooseDispatch(input({ payloadBytes: 100, childCapacity: 0 }))
  assert.equal(result.strategy, 'summary', '第1档先于第3档：极小体积不看空位')
  assert.match(result.reason, /四分之一/)
})

test('dispatch：顺序优先——摘要失败先于容量检查 → original（不被空位截胡）', () => {
  const result = chooseDispatch(
    input({ payloadBytes: 6000, budgetBytes: 8000, priorAttemptFailed: true, childCapacity: 0 }),
  )
  assert.equal(result.strategy, 'original', '第2档先于第3档：预算内且摘要失败过就直接发原文')
  assert.match(result.reason, /摘要已经失败过一次/)
})

test('dispatch：顺序优先——容量检查先于体积规则 → escalate', () => {
  const result = chooseDispatch(
    input({ payloadBytes: 12000, budgetBytes: 8000, childCapacity: 0, sharedStateUpdated: false }),
  )
  assert.equal(result.strategy, 'escalate', '第3档先于第4/5档：空位检查优先于体积规则')
  assert.match(result.reason, /容量检查优先于体积规则/)
})

test('dispatch：顺序优先——board-only 先于 skip（先写黑板再决定不传）', () => {
  const stale = chooseDispatch(input({ payloadBytes: 12000, sharedStateUpdated: false }))
  const fresh = chooseDispatch(input({ payloadBytes: 12000, sharedStateUpdated: true }))
  assert.equal(stale.strategy, 'board-only', '黑板未更新时先补共享状态')
  assert.equal(fresh.strategy, 'skip', '黑板已更新才是本次不传')
  assert.match(stale.reason, /先把结论写进黑板/)
})

test('dispatch：边界——正好四分之一走第1档，多 1 字节落到第6档，正好等于预算不算超限', () => {
  const quarter = chooseDispatch(input({ payloadBytes: 2000, budgetBytes: 8000 }))
  assert.equal(quarter.strategy, 'summary')
  assert.match(quarter.reason, /四分之一/)

  const justOver = chooseDispatch(input({ payloadBytes: 2001, budgetBytes: 8000 }))
  assert.equal(justOver.strategy, 'summary')
  assert.match(justOver.reason, /摘要没失败过/, '2001B 走的是第6档而不是第1档')

  const exactlyBudget = chooseDispatch(input({ payloadBytes: 8000, budgetBytes: 8000, sharedStateUpdated: false }))
  assert.equal(exactlyBudget.strategy, 'summary', '正好等于预算不算超出，所以不是 board-only')
  assert.match(exactlyBudget.reason, /摘要没失败过/)
})

test('dispatch：非法输入——字段类型/范围不对都抛 DispatchError', () => {
  const bad = [
    input({ payloadBytes: -1 }),
    input({ payloadBytes: Number.NaN }),
    input({ payloadBytes: Number.POSITIVE_INFINITY }),
    input({ payloadBytes: '4000' }),
    input({ budgetBytes: 0 }),
    input({ budgetBytes: -100 }),
    input({ budgetBytes: Number.NaN }),
    input({ childCapacity: -1 }),
    input({ childCapacity: 1.5 }),
    input({ childCapacity: Number.POSITIVE_INFINITY }),
    input({ priorAttemptFailed: 'yes' }),
    input({ sharedStateUpdated: undefined }),
    input({ sameModelAvailability: null }),
  ]
  for (const item of bad) {
    assert.throws(
      () => chooseDispatch(item),
      (error) => error instanceof DispatchError && error.name === 'DispatchError',
      '必须抛 DispatchError：' + JSON.stringify(item),
    )
  }
})

test('dispatch：非法输入——一次列出全部问题，文案指名字段', () => {
  assert.throws(
    () => chooseDispatch({}),
    (error) => {
      assert.equal(error.name, 'DispatchError')
      assert.match(error.message, /输入不合法/)
      for (const field of ['payloadBytes', 'budgetBytes', 'childCapacity', 'sameModelAvailability', 'priorAttemptFailed', 'sharedStateUpdated']) {
        assert.match(error.message, new RegExp(field), '错误文案必须点名 ' + field)
      }
      return true
    },
  )

  // 一次列出多个问题，而不是修一个报一个
  assert.throws(
    () => chooseDispatch(input({ payloadBytes: -1, childCapacity: 0.5, priorAttemptFailed: 'no' })),
    (error) => {
      assert.match(error.message, /payloadBytes/)
      assert.match(error.message, /childCapacity/)
      assert.match(error.message, /priorAttemptFailed/)
      return true
    },
  )
})

test('dispatch：非法输入——输入不是对象时抛 DispatchError', () => {
  for (const bad of [null, undefined, 42, 'payloadBytes', []]) {
    assert.throws(
      () => chooseDispatch(bad),
      (error) => {
        assert.ok(error instanceof DispatchError)
        assert.match(error.message, /需要对象输入/)
        assert.match(error.message, /实际收到/)
        return true
      },
      '输入 ' + String(bad) + ' 必须抛 DispatchError',
    )
  }
})
