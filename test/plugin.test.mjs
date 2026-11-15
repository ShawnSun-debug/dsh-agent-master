import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply, inject, name } from '../lib/index.js'
import { AgentMasterConfigError } from '../lib/config.js'

test('插件导出名与注入契约存在', () => {
  assert.equal(name, 'dsh-agent-master')
  assert.ok(Array.isArray(inject))
})

test('apply 校验配置、写入 ctx.state，disposer 清理干净', () => {
  const ctx = {}
  const dispose = apply(ctx, { maxChildren: 2 })
  assert.equal(ctx.state.agentMaster.config.maxChildren, 2)
  assert.ok(Object.isFrozen(ctx.state.agentMaster.config))
  dispose()
  assert.equal(ctx.state.agentMaster, undefined)
})

test('非法配置在装载期就抛错，不留下半初始化状态', () => {
  const ctx = {}
  assert.throws(() => apply(ctx, { maxChildren: 0 }), AgentMasterConfigError)
  assert.equal(ctx.state, undefined)
})
