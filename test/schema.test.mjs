/**
 * 真机事故回归：宿主会把每个工具返回的 value 按 `output.schema` 严格校验
 * （dsh-tools pipeline.js 的 createSuccessResult → validateJsonSchemaValue），
 * 校验失败时整次调用变错误，但**副作用已经发生**（卡已经建好了）。
 *
 * 2026-11-18 真机踩到：`master_board op=create` 建卡成功，却因
 * `value.card.assignee` 是 null、`childSessionId` 是 null 被拒。
 * 假 ctx 的测试不会跑宿主校验，所以这里照宿主的子集自己校验一遍真实输出。
 *
 * 校验器实现的是宿主支持的关键字子集（type / oneOf / properties / required /
 * additionalProperties / items / enum / const），规则与
 * dsh-tools/src/json-schema.ts 一致：不支持 type 数组，可空用 oneOf。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Board } from '../lib/board.js'
import { Ledger } from '../lib/ledger.js'
import { ExperienceStore } from '../lib/experience.js'
import { createTools } from '../lib/tools.js'

const ROOT = 'session-root'
const CHILD_A = { author: { sessionId: 'session-a', name: 'worker-a' } }
const BRIEF = { goal: '实现看板', constraints: ['不改 lib/ledger.js'], acceptance: ['测试全绿'] }

/** 宿主 json-schema 子集的校验器；返回违规列表（空数组=通过）。 */
function validate(schema, value, path = 'value') {
  const violations = []
  if (Array.isArray(schema.oneOf)) {
    const passing = schema.oneOf.filter((branch) => validate(branch, value, path).length === 0)
    if (passing.length !== 1) violations.push(path + ': must match exactly one oneOf branch')
    return violations
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    violations.push(path + ': must be one of ' + JSON.stringify(schema.enum))
  }
  if (schema.const !== undefined && value !== schema.const) {
    violations.push(path + ': must equal ' + JSON.stringify(schema.const))
  }
  if (schema.type === undefined) return violations

  const matches = {
    object: typeof value === 'object' && value !== null && !Array.isArray(value),
    array: Array.isArray(value),
    string: typeof value === 'string',
    number: typeof value === 'number',
    integer: Number.isInteger(value),
    boolean: typeof value === 'boolean',
    null: value === null,
  }[schema.type]

  if (!matches) {
    violations.push(path + ': must be ' + schema.type)
    return violations
  }
  if (schema.type === 'array' && schema.items !== undefined) {
    value.forEach((item, index) => violations.push(...validate(schema.items, item, path + '[' + index + ']')))
  }
  if (schema.type === 'object') {
    const properties = schema.properties ?? {}
    for (const [key, child] of Object.entries(properties)) {
      if (value[key] !== undefined) violations.push(...validate(child, value[key], path + '.' + key))
    }
    for (const key of schema.required ?? []) {
      if (value[key] === undefined) violations.push(path + '.' + key + ': required')
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) violations.push(path + '.' + key + ': undeclared property')
      }
    }
  }
  return violations
}

async function makeEnv() {
  const dir = await mkdtemp(join(tmpdir(), 'schema-'))
  const board = new Board({ dir, maxCards: 32, maxRecords: 256 })
  const ledger = new Ledger({ dir })
  const experience = new ExperienceStore({
    projectDir: join(dir, 'project'),
    globalDir: join(dir, 'global'),
  })
  let spawned = 0
  const tools = createTools({
    config: { maxChildren: 4 },
    board,
    ledger,
    experience,
    rootId: ROOT,
    now: () => Date.now(),
    spawnActivation: async (spec) => {
      spawned += 1
      return { childId: 'session-child-' + spawned, label: spec.label }
    },
  })
  return { board, tools }
}

/** 取某个工具的 output schema。 */
function outputSchema(tools, name) {
  const definition = tools.definitions.find((item) => item.name === name)
  assert.ok(definition, '缺少工具定义：' + name)
  return definition.output.schema
}

test('宿主级输出校验：空看板下 head/query/records/get 都过 schema', async () => {
  const { tools } = await makeEnv()
  const cases = [
    ['master_board', await tools.boardTool({ op: 'head' })],
    ['master_board', await tools.boardTool({ op: 'query' })],
    ['master_board', await tools.boardTool({ op: 'records' })],
  ]
  for (const [name, value] of cases) {
    assert.deepEqual(validate(outputSchema(tools, name), value), [], name + ' 输出违规：' + JSON.stringify(value))
  }
})

test('宿主级输出校验：建卡（assignee 为 null）必须过 schema', async () => {
  const { tools } = await makeEnv()
  const created = await tools.boardTool({ op: 'create', title: '真机验证', body: 'probe' })
  assert.equal(created.card.assignee, null)
  assert.equal(created.card.childSessionId, null)
  assert.deepEqual(validate(outputSchema(tools, 'master_board'), created), [])

  const got = await tools.boardTool({ op: 'get', cardId: created.card.id })
  assert.deepEqual(validate(outputSchema(tools, 'master_board'), got), [])

  const queried = await tools.boardTool({ op: 'query' })
  assert.deepEqual(validate(outputSchema(tools, 'master_board'), queried), [])
})

test('宿主级输出校验：assign / dispatch / report / collect / digest / experience', async () => {
  const { tools } = await makeEnv()
  const assigned = await tools.assign({ label: '看板', brief: BRIEF })
  assert.deepEqual(validate(outputSchema(tools, 'master_assign'), assigned), [])

  const dispatched = await tools.dispatch({
    briefs: [
      { label: '一路', brief: BRIEF },
      { label: '二路', brief: BRIEF },
    ],
  })
  assert.deepEqual(validate(outputSchema(tools, 'master_dispatch'), dispatched), [])

  await tools.boardTool({ op: 'claim', cardId: 't1' }, CHILD_A)
  await tools.boardTool({ op: 'doing', cardId: 't1' }, CHILD_A)
  const reported = await tools.report({
    taskId: 't1',
    summary: '已改好看板',
    findings: [{ text: '状态机可用' }],
    evidence: [{ path: 'lib/board.js', quote: 'const TRANSITIONS' }],
    confidence: 'high',
    schemaVersion: 1,
    final: true,
  }, CHILD_A)
  assert.deepEqual(validate(outputSchema(tools, 'master_report'), reported), [])

  const collected = await tools.collect({})
  assert.deepEqual(validate(outputSchema(tools, 'master_collect'), collected), [])

  // 未超预算：locator 是 null，曾经被声明成 string
  const digest = await tools.digest({ text: '很短的一段正文' })
  assert.equal(digest.locator, null)
  assert.deepEqual(validate(outputSchema(tools, 'master_digest'), digest), [])

  const saved = await tools.experience({ op: 'save', title: '真机验证探针', lesson: '输出要过宿主校验' })
  assert.deepEqual(validate(outputSchema(tools, 'master_experience'), saved), [])
})
