/**
 * 插件导出面与装载期行为（T1 起，T5 按新契约更新）。
 *
 * T5 起 apply 是 async 且要真服务（tools/systemPrompt/subagents/sessionProjections），
 * 所以这里用最小假 ctx 只验「装载期契约」：非法配置先抛、注册齐、disposer 干净。
 * 工具/提示词/投影的内容细节在 test/wiring.test.mjs 里验。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply, inject, name } from '../lib/index.js'
import { AgentMasterConfigError } from '../lib/config.js'
import { TOOL_NAMES } from '../lib/tools.js'

/** 最小假 ctx：只记录注册，不执行任何工具 */
function fakeCtx() {
  const calls = { tools: [], sections: [], projections: [] }
  return {
    calls,
    ctx: {
      effect(execute) {
        const result = execute()
        return typeof result === 'function' ? result : () => {}
      },
      tools: {
        register(definition) {
          calls.tools.push(definition.name)
          return () => {}
        },
      },
      systemPrompt: {
        getSectionOrder: () => 7000,
        section(section) {
          calls.sections.push(section)
          return () => {}
        },
      },
      sessionProjections: {
        async register(definition) {
          calls.projections.push(definition)
          return () => {}
        },
      },
      subagents: {
        rootOf: (agent) => agent,
        namesOf: () => ['agent-1'],
        async startActivation() {
          throw new Error('装载期不该 spawn')
        },
      },
    },
  }
}

test('插件导出名与注入契约存在', () => {
  assert.equal(name, 'dsh-agent-master')
  assert.ok(Array.isArray(inject))
  assert.deepEqual(inject, ['tools', 'systemPrompt', 'subagents', 'sessionProjections'])
})

test('非法配置在装载期就抛错，且不留下半初始化状态', async () => {
  const { ctx, calls } = fakeCtx()
  await assert.rejects(apply(ctx, { maxChildren: 0 }), AgentMasterConfigError)
  // 半初始化状态：三个注册面一条都没留下
  assert.deepEqual(calls.tools, [])
  assert.deepEqual(calls.sections, [])
  assert.deepEqual(calls.projections, [])
})

test('apply 注册 5 工具 + 1 提示词 + 1 投影，并返回 disposer', async () => {
  const { ctx, calls } = fakeCtx()
  const dispose = await apply(ctx, { maxChildren: 2 })

  assert.deepEqual(calls.tools, [...TOOL_NAMES])
  assert.equal(calls.sections.length, 1)
  assert.equal(calls.sections[0].name, 'agent-master:master')
  assert.equal(calls.projections.length, 1)
  assert.equal(calls.projections[0].key, 'agentMaster')
  assert.equal(calls.projections[0].stateVersion, 1)
  // apply 返回 Promise，resolve 出的是可调用的 disposer
  assert.equal(typeof dispose, 'function')
})

test('disposer 可安全调用，二次调用是 no-op', async () => {
  const { ctx } = fakeCtx()
  const dispose = await apply(ctx, {})
  dispose()
  assert.doesNotThrow(() => dispose())
})
