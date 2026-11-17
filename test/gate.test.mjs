/**
 * T11 门禁（lib/gate.js）单测：纯函数，覆盖三类拒收与放行。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { GateError, REPORT_ALLOWED_STATUSES, assertReportAllowed } from '../lib/gate.js'

const CHILD = 'session-a'
const OTHER = 'session-b'

/** 造一张卡。 */
function card(overrides = {}) {
  return {
    id: 't1',
    status: 'assigned',
    assignee: { sessionId: CHILD, name: 'worker-a' },
    ...overrides,
  }
}

test('gate：认领后（assigned/doing/review）都允许交报告', async () => {
  for (const status of REPORT_ALLOWED_STATUSES) {
    assert.equal(assertReportAllowed({ card: card({ status }), sessionId: CHILD, taskId: 't1' }), true)
  }
})

test('gate：还没认领（todo 且无 assignee）→ 拒收，并指向「先认领」', async () => {
  assert.throws(
    () => assertReportAllowed({ card: card({ status: 'todo', assignee: null }), sessionId: CHILD, taskId: 't1' }),
    (error) => {
      assert.ok(error instanceof GateError)
      assert.match(error.message, /还没被认领/)
      assert.match(error.action, /claim/)
      return true
    },
  )
})

test('gate：卡在别人名下 → 拒收（改派后旧会话立刻失去资格）', async () => {
  assert.throws(
    () => assertReportAllowed({ card: card({ status: 'doing' }), sessionId: OTHER, taskId: 't1' }),
    (error) => {
      assert.ok(error instanceof GateError)
      assert.match(error.message, /worker-a/)
      assert.match(error.action, /改派/)
      return true
    },
  )
})

test('gate：blocked / done 状态不收报告', async () => {
  for (const status of ['blocked', 'done']) {
    assert.throws(
      () => assertReportAllowed({ card: card({ status }), sessionId: CHILD, taskId: 't1' }),
      (error) => {
        assert.ok(error instanceof GateError)
        assert.match(error.message, new RegExp(status))
        return true
      },
    )
  }
})

test('gate：blocked 的下一步是让 master 解除，done 的下一步是 rework', async () => {
  assert.throws(
    () => assertReportAllowed({ card: card({ status: 'blocked' }), sessionId: CHILD }),
    (error) => /解除/.test(error.action),
  )
  assert.throws(
    () => assertReportAllowed({ card: card({ status: 'done' }), sessionId: CHILD }),
    (error) => /rework/.test(error.action),
  )
})

test('gate：sessionId 为空时拒绝（身份不明不写看板）', async () => {
  assert.throws(
    () => assertReportAllowed({ card: card(), sessionId: '' }),
    (error) => {
      assert.ok(error instanceof GateError)
      assert.match(error.message, /sessionId/)
      return true
    },
  )
})

test('gate：缺 card 时抛错而不是放行', async () => {
  assert.throws(() => assertReportAllowed({ sessionId: CHILD }), GateError)
})
