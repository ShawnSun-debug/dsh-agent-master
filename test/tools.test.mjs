// test/tools.test.mjs —— 五个模型工具的单元测试。
// 纪律：黑板/台账/spawn 全部换成假实现（只记录调用参数），除 master_digest 外不碰磁盘；
// digest 用 os.tmpdir() 临时目录，测试结束即清理。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'

import { DEFAULTS, validateConfig } from '../lib/config.js'
import { ReportValidationError } from '../lib/handoff.js'
import { ToolsError, createTools } from '../lib/tools.js'

const ROOT_ID = 'root-t4'
const TOOL_NAMES = ['master_assign', 'master_report', 'master_collect', 'master_board', 'master_digest']

// ---------------------------------------------------------------------------
// 假依赖：只实现契约里的方法，并把入参留在 calls 里供断言
// ---------------------------------------------------------------------------

/** 假黑板（契约：head/append/query/get） */
function createFakeBoard() {
  /** @type {any[]} */
  const records = []
  const calls = { append: [], query: [] }
  /** 去重键照契约算 sha256(title + 分隔符 + body)：重复内容不占 seq（用 | 代替 NUL 免得源码里出现裸字节） */
  const deduped = new Map()
  let seq = 0
  return {
    records,
    calls,
    async head() {
      return { seq }
    },
    async append(input) {
      calls.append.push(input)
      const key = createHash('sha256')
        .update(String(input.title) + '|' + String(input.body ?? ''))
        .digest('hex')
      const existing = deduped.get(key)
      if (existing) return { record: existing, headSeq: seq, deduped: true }
      seq += 1
      const record = {
        id: 'b' + seq,
        seq,
        ts: 0,
        scope: input.scope ?? 'root',
        author: input.author,
        kind: input.kind,
        title: input.title,
        body: input.body ?? '',
        refs: input.refs ?? [],
        artifact: input.artifact ?? null,
        tags: input.tags ?? [],
      }
      records.push(record)
      deduped.set(key, record)
      return { record, headSeq: seq, deduped: false }
    },
    async query(filter = {}) {
      calls.query.push(filter)
      let out = records.slice()
      if (filter.kind !== undefined) out = out.filter((r) => r.kind === filter.kind)
      if (filter.tag !== undefined) out = out.filter((r) => r.tags.includes(filter.tag))
      out = out.filter((r) => r.seq > (filter.sinceSeq ?? 0))
      return out.slice(0, filter.limit ?? 100)
    },
    async get(id) {
      return records.find((r) => r.id === id) ?? null
    },
  }
}

/** 假台账（契约：append/latest/list/verify） */
function createFakeLedger({ violations = [] } = {}) {
  /** @type {any[]} */
  const entries = []
  const calls = { append: [], verify: [] }
  return {
    entries,
    calls,
    setViolations(next) {
      violations.splice(0, violations.length, ...next)
    },
    async append(input) {
      calls.append.push(input)
      const version = entries.filter((e) => e.taskId === input.taskId).length + 1
      const entry = {
        taskId: input.taskId,
        version,
        ts: 0,
        schemaVersion: 1,
        constraints: input.constraints ?? [],
        acceptance: input.acceptance ?? [],
        boundaries: input.boundaries ?? [],
        forbidden: input.forbidden ?? [],
        hash: 'hash-' + input.taskId,
      }
      entries.push(entry)
      return entry
    },
    async latest(taskId) {
      const found = entries.filter((e) => e.taskId === taskId)
      return found.length === 0 ? null : found[found.length - 1]
    },
    async list() {
      return entries.slice()
    },
    verify(entry, report) {
      calls.verify.push({ entry, report })
      return { violations: violations.slice(), ok: violations.length === 0 }
    },
  }
}

/** 假 spawnActivation：记录入参，可配置为抛错 */
function createFakeSpawn({ fail = null } = {}) {
  const calls = []
  return {
    calls,
    async spawn(input) {
      calls.push(input)
      if (fail) throw fail
      return { sessionId: 'child-' + calls.length, label: input.label }
    },
  }
}

function createDeps({ config = {}, board, ledger, spawn } = {}) {
  const fakeBoard = board ?? createFakeBoard()
  const fakeLedger = ledger ?? createFakeLedger()
  const fakeSpawn = spawn ?? createFakeSpawn()
  const resolved = validateConfig(config)
  const tools = createTools({
    config: resolved,
    board: fakeBoard,
    ledger: fakeLedger,
    spawnActivation: (input) => fakeSpawn.spawn(input),
    rootId: ROOT_ID,
    now: () => 1000,
  })
  return { tools, board: fakeBoard, ledger: fakeLedger, spawn: fakeSpawn, config: resolved }
}

// ---------------------------------------------------------------------------
// definitions 形状
// ---------------------------------------------------------------------------

test('definitions 暴露五个固定工具名，且每个都有对象 parameters 与 output.schema', () => {
  const { tools } = createDeps()
  assert.equal(Array.isArray(tools.definitions), true)
  assert.deepEqual(tools.definitions.map((def) => def.name), TOOL_NAMES)
  for (const def of tools.definitions) {
    assert.equal(typeof def.name, 'string')
    assert.ok(def.description.length > 0, def.name + ' 缺少 description')
    assert.equal(typeof def.parameters, 'object')
    assert.ok(def.parameters !== null && !Array.isArray(def.parameters))
    assert.equal(def.parameters.type, 'object')
    assert.equal(typeof def.parameters.properties, 'object')
    assert.equal(typeof def.output, 'object')
    assert.equal(typeof def.output.schema, 'object')
    assert.equal(typeof def.output.render, 'function')
    const rendered = def.output.render({ taskId: 't1', ok: true, truncated: false })
    assert.equal(typeof rendered, 'string')
    assert.ok(rendered.length > 0, def.name + ' 的 render 输出了空串')
  }
  for (const key of ['assign', 'collect', 'report', 'boardTool', 'digest']) {
    assert.equal(typeof tools[key], 'function', key + ' 应该是函数')
  }
})

test('缺少必需依赖时 createTools 报中文错误', () => {
  assert.throws(() => createTools(), ToolsError)
  assert.throws(() => createTools({}), ToolsError)
  assert.throws(() => createTools({ config: DEFAULTS }), /缺少|需要|board/)
  assert.throws(
    () => createTools({ config: DEFAULTS, board: {}, ledger: {}, spawnActivation: () => {}, rootId: '' }),
    ToolsError,
  )
})

// ---------------------------------------------------------------------------
// master_assign
// ---------------------------------------------------------------------------

test('assign：写台账 → 用 renderBrief 渲染契约 → 开子会话 → 写 task 记录', async () => {
  const { tools, board, ledger, spawn } = createDeps()
  const brief = {
    goal: '调研 A2A 任务生命周期',
    inputs: ['a2a README'],
    constraints: ['只读，不得修改仓库文件', { text: '必须给出原文摘句', needsEvidence: true }],
    acceptance: ['每条发现至少 1 条 evidence'],
    boundaries: ['artifacts/'],
    forbidden: ['不得伪造 URL'],
    budget: 4096,
  }
  const result = await tools.assign({ label: 'researcher-a', name: 'alpha', brief })

  assert.equal(result.taskId, 't1')
  assert.notEqual(result.ok, false)

  // 1) 台账按 brief 的四组条目落条目
  assert.equal(ledger.calls.append.length, 1)
  const appended = ledger.calls.append[0]
  assert.equal(appended.taskId, 't1')
  assert.deepEqual(appended.constraints, brief.constraints)
  assert.deepEqual(appended.acceptance, brief.acceptance)
  assert.deepEqual(appended.boundaries, brief.boundaries)
  assert.deepEqual(appended.forbidden, brief.forbidden)

  // 2) 子会话被开出来，prompt 复用 lib/handoff.js 的 renderBrief
  assert.equal(spawn.calls.length, 1)
  assert.equal(spawn.calls[0].label, 'researcher-a')
  assert.equal(spawn.calls[0].name, 'alpha')
  const prompt = spawn.calls[0].prompt
  assert.ok(prompt.includes('taskId=t1'), 'prompt 缺任务号')
  assert.ok(prompt.includes('台账版本：v1'), 'prompt 缺台账版本')
  assert.ok(prompt.includes('## 3. 约束台账（逐条遵守）'), 'prompt 缺约束台账段')
  assert.ok(prompt.includes('只读，不得修改仓库文件'), 'prompt 缺 constraint 原文')
  assert.ok(prompt.includes('必须给出原文摘句（需 evidence）'), 'prompt 缺 needsEvidence 标记')
  assert.ok(prompt.includes('每条发现至少 1 条 evidence'), 'prompt 缺 acceptance')
  assert.ok(prompt.includes('artifacts/'), 'prompt 缺 boundaries')
  assert.ok(prompt.includes('不得伪造 URL'), 'prompt 缺 forbidden')
  // 交付 schema
  assert.ok(prompt.includes('"taskId": "string，必须等于 t1"'), 'prompt 缺交付 schema 的 taskId 说明')
  assert.ok(prompt.includes('"findings"'), 'prompt 缺 findings 字段')
  assert.ok(prompt.includes('"confidence": "low | medium | high'), 'prompt 缺 confidence 三档')
  assert.ok(prompt.includes('字节预算：summary ≤ 4096 字节'), 'prompt 缺字节预算')
  // 报告纪律
  assert.ok(prompt.includes('结束前必须调用 master_report'), 'prompt 缺报告纪律')

  assert.equal(result.promptBytes, Buffer.byteLength(prompt, 'utf8'))

  // 3) 板上 1 条 task 记录，指针指向 taskId
  assert.equal(board.records.length, 1)
  const task = board.records[0]
  assert.equal(task.kind, 'task')
  assert.equal(task.title, brief.goal)
  assert.equal(task.body, '')
  assert.deepEqual(task.refs, ['t1'])
  assert.deepEqual(task.tags, ['assign'])
  assert.equal(task.author.name, 'master')

  assert.equal(result.child.sessionId, 'child-1')
})

test('assign：按 root 板上 task 数量递增生成 t1/t2', async () => {
  const { tools, spawn, ledger } = createDeps()
  const first = await tools.assign({ label: 'a', brief: { goal: '目标一' } })
  const second = await tools.assign({ label: 'b', brief: { goal: '目标二' } })
  assert.equal(first.taskId, 't1')
  assert.equal(second.taskId, 't2')
  assert.ok(spawn.calls[1].prompt.includes('taskId=t2'))
  assert.deepEqual(ledger.entries.map((entry) => entry.taskId), ['t1', 't2'])
})

test('assign：spawn 抛错时板上不留 task 记录，并带回 ledgerVersion 以便用同一 taskId 重试', async () => {
  const spawn = createFakeSpawn({ fail: new Error('provider 不可用') })
  const { tools, board, ledger } = createDeps({ spawn })
  const result = await tools.assign({ label: 'alpha', brief: { goal: '目标' } })

  assert.equal(result.ok, false)
  assert.equal(result.taskId, 't1')
  assert.equal(result.ledgerVersion, 1)
  assert.ok(String(result.error.message).includes('provider 不可用'))

  // 板上不留 task 记录：连 append 都没发生（先开子会话、成功后才写板）
  assert.equal(board.calls.append.length, 0)
  assert.equal(board.records.length, 0)
  // 台账 append-only，条目保留（重试时同一 taskId 会得到 v2）
  assert.equal(ledger.entries.length, 1)
})

test('assign：子会话已开出但写板失败时如实报告，且不引导重复下派', async () => {
  const board = createFakeBoard()
  board.append = async () => {
    throw new Error('黑板已满')
  }
  const { tools } = createDeps({ board })
  const result = await tools.assign({ label: 'alpha', brief: { goal: '目标' } })

  assert.equal(result.ok, false)
  assert.equal(result.started, true)
  assert.equal(result.taskId, 't1')
  assert.equal(result.child.sessionId, 'child-1')
  assert.ok(result.error.message.includes('黑板已满'))
  assert.ok(result.error.message.includes('不要重复下派'))
})

test('assign：超过 maxChildren 上限直接拒绝，不开子会话也不写板', async () => {
  const { tools, board, spawn } = createDeps({ config: { maxChildren: 1 } })
  await tools.assign({ label: 'a', brief: { goal: '一' } })
  await assert.rejects(() => tools.assign({ label: 'b', brief: { goal: '二' } }), ToolsError)
  await assert.rejects(() => tools.assign({ label: 'b', brief: { goal: '二' } }), /maxChildren|上限/)
  assert.equal(spawn.calls.length, 1)
  assert.equal(board.records.length, 1)
})

test('assign：brief 缺 goal 时报中文错误，不写台账也不开子会话', async () => {
  const { tools, ledger, spawn, board } = createDeps()
  await assert.rejects(() => tools.assign({ label: 'a', brief: {} }), /goal/)
  assert.equal(ledger.calls.append.length, 0)
  assert.equal(spawn.calls.length, 0)
  assert.equal(board.records.length, 0)
})

// ---------------------------------------------------------------------------
// master_report
// ---------------------------------------------------------------------------

test('report：校验失败直接抛出且不写黑板', async () => {
  const { tools, board, ledger } = createDeps()
  await assert.rejects(
    () => tools.report({ taskId: 't1', summary: '', findings: [{ text: 'x' }], confidence: 'low' }),
    ReportValidationError,
  )
  assert.equal(board.calls.append.length, 0)
  assert.equal(ledger.calls.verify.length, 0)
})

test('report：summary 超字节预算也直接抛出，不写黑板', async () => {
  const { tools, board } = createDeps({ config: { maxReportBytes: 512 } })
  await assert.rejects(
    () =>
      tools.report({
        taskId: 't1',
        summary: '长'.repeat(400),
        findings: [{ text: 'x' }],
        confidence: 'low',
      }),
    ReportValidationError,
  )
  assert.equal(board.calls.append.length, 0)
})

test('report：成功写 finding/source/artifact 三类记录，并把 violations 透传出去', async () => {
  const violation = { kind: 'boundary', text: 'artifacts/x.md', reason: '不在 boundaries 白名单内' }
  const ledger = createFakeLedger()
  const { tools, board } = createDeps({ ledger })
  await ledger.append({ taskId: 't1', constraints: ['只读'], boundaries: ['artifacts/'] })
  ledger.setViolations([violation])

  const raw = {
    taskId: 't1',
    summary: 'A2A 用 taskId 归组产物',
    findings: [{ text: '产物按上下文归组' }],
    evidence: [{ url: 'https://example.com/a2a', quote: 'artifact is bound to contextId' }],
    open_questions: [],
    artifacts: [{ path: 'artifacts/report.md', bytes: 12, sha256: 'a'.repeat(64) }],
    confidence: 'medium',
  }
  const result = await tools.report(raw)

  // 有 violations 仍然写盘，但 ok=false 且逐条列出
  assert.equal(result.ok, false)
  assert.deepEqual(result.violations, [violation])
  assert.equal(ledger.calls.verify.length, 1)
  assert.equal(ledger.calls.verify[0].entry.taskId, 't1')

  assert.deepEqual(
    board.records.map((r) => r.kind),
    ['finding', 'source', 'artifact'],
  )
  const [finding, source, artifact] = board.records
  assert.equal(finding.body, raw.summary)
  assert.deepEqual(finding.refs, ['t1'])
  assert.ok(finding.tags.includes('report'))
  assert.ok(
    finding.tags.some((tag) => tag.startsWith('violation:boundary:')),
    'finding 记录应带 violation 标记：' + JSON.stringify(finding.tags),
  )
  assert.deepEqual(source.refs, ['https://example.com/a2a'])
  assert.equal(source.body, raw.evidence[0].quote)
  assert.deepEqual(artifact.refs, ['artifacts/report.md'])
  assert.deepEqual(artifact.artifact, { path: 'artifacts/report.md', bytes: 12, sha256: 'a'.repeat(64) })
  assert.deepEqual(result.recordIds, board.records.map((r) => r.id))
})

test('report：干净报告 ok=true，且 open_questions 也落成记录', async () => {
  const ledger = createFakeLedger()
  const { tools, board } = createDeps({ ledger })
  await ledger.append({ taskId: 't2', constraints: ['只读'] })

  const result = await tools.report({
    taskId: 't2',
    summary: '摘要',
    findings: [{ text: '发现一' }],
    open_questions: ['A2A 版本是 1.0 还是 0.3？'],
    confidence: 'high',
  })

  assert.equal(result.ok, true)
  assert.deepEqual(result.violations, [])
  assert.deepEqual(
    board.records.map((r) => r.kind),
    ['finding', 'open_question'],
  )
  assert.equal(board.records[1].body, 'A2A 版本是 1.0 还是 0.3？')
  assert.deepEqual(result.recordIds, board.records.map((r) => r.id))
})

test('report：台账升版后同一份摘要再报，新违规仍留痕（不被黑板去重吃掉）', async () => {
  const ledger = createFakeLedger()
  const { tools, board } = createDeps({ ledger })
  await ledger.append({ taskId: 't1', constraints: ['只读'] })
  await tools.report({ taskId: 't1', summary: '同一份摘要', findings: [{ text: '发现' }], confidence: 'low' })

  // master 改写台账（append-only 升到 v2），再报同一份摘要
  await ledger.append({ taskId: 't1', constraints: ['只读'], forbidden: ['不得引用 A'] })
  ledger.setViolations([{ kind: 'forbidden', text: 'A', reason: '出现在 findings 中' }])
  const second = await tools.report({ taskId: 't1', summary: '同一份摘要', findings: [{ text: '发现' }], confidence: 'low' })

  assert.equal(second.ok, false)
  const findings = board.records.filter((record) => record.kind === 'finding')
  assert.equal(findings.length, 2, '台账升版后的报告不能被去重吃掉')
  assert.ok(
    findings[1].tags.some((tag) => tag.startsWith('violation:forbidden:')),
    '第二条 finding 应带 forbidden 违规标记：' + JSON.stringify(findings[1].tags),
  )
})

test('report：台账里没有该任务时仍写盘，但记一条 ledger violation', async () => {
  const { tools, board } = createDeps()
  const result = await tools.report({
    taskId: 't9',
    summary: '摘要',
    findings: [{ text: '发现' }],
    confidence: 'low',
  })
  assert.equal(result.ok, false)
  assert.equal(result.violations.length, 1)
  assert.equal(result.violations[0].kind, 'ledger')
  assert.ok(board.records.length >= 1)
})

// ---------------------------------------------------------------------------
// master_collect
// ---------------------------------------------------------------------------

/** 直接往假黑板上摆一组记录，模拟两个孩子已经回报 */
async function seedBoard(board) {
  await board.append({
    author: { sessionId: ROOT_ID, name: 'master' },
    kind: 'task',
    title: '调研 A2A',
    body: '',
    refs: ['t1'],
    tags: ['assign'],
  })
  await board.append({
    author: { sessionId: 's-alpha', name: 'alpha' },
    kind: 'finding',
    title: 'finding · t1',
    body: 'alpha 摘要',
    refs: ['t1'],
    tags: ['report', 'violation:boundary:不在 boundaries 白名单内'],
  })
  await board.append({
    author: { sessionId: 's-alpha', name: 'alpha' },
    kind: 'source',
    title: 'https://example.com/a2a',
    body: '关键摘句',
    refs: ['https://example.com/a2a'],
    tags: ['evidence'],
  })
  await board.append({
    author: { sessionId: 's-alpha', name: 'alpha' },
    kind: 'artifact',
    title: 'artifacts/a.md',
    body: '',
    refs: ['artifacts/a.md'],
    artifact: { path: 'artifacts/a.md', bytes: 7, sha256: 'b'.repeat(64) },
    tags: ['report'],
  })
  await board.append({
    author: { sessionId: 's-alpha', name: 'alpha' },
    kind: 'open_question',
    title: 'open_question · t1',
    body: '版本号未确认',
    refs: ['t1'],
    tags: ['report'],
  })
}

test('collect：按 author.name 分组，带 findings/evidence/artifacts/open_questions/violations，并列出 missing', async () => {
  const { tools, board } = createDeps()
  await seedBoard(board)

  const result = await tools.collect({ names: ['alpha', 'beta'] })
  assert.equal(result.children.length, 1)
  const child = result.children[0]
  assert.equal(child.name, 'alpha')
  assert.equal(child.sessionId, 's-alpha')
  assert.equal(child.taskId, 't1')
  assert.equal(child.summary, 'alpha 摘要')
  assert.deepEqual(child.findings, ['alpha 摘要'])
  assert.deepEqual(child.evidence, [{ url: 'https://example.com/a2a', quote: '关键摘句' }])
  assert.deepEqual(child.artifacts, [{ path: 'artifacts/a.md', bytes: 7, sha256: 'b'.repeat(64) }])
  assert.deepEqual(child.open_questions, ['版本号未确认'])
  assert.deepEqual(child.violations, [{ kind: 'boundary', text: '不在 boundaries 白名单内' }])
  assert.deepEqual(result.missing, ['beta'])
  // master 自己的 task 记录不得被当成一个子对话
  assert.equal(result.children.some((c) => c.name === 'master'), false)
})

test('collect：names 缺省时不过滤，missing 为空数组', async () => {
  const { tools, board } = createDeps()
  await seedBoard(board)
  const result = await tools.collect()
  assert.deepEqual(result.children.map((c) => c.name), ['alpha'])
  assert.deepEqual(result.missing, [])
})

test('collect：waitMs 内等到迟到的孩子回报', async () => {
  const board = createFakeBoard()
  const { tools } = createDeps({ board })
  let queries = 0
  const originalQuery = board.query
  board.query = async (filter) => {
    queries += 1
    // 第二轮查询时才让 beta 的记录出现，模拟「等等再来」
    if (queries > 5) {
      await board.append({
        author: { sessionId: 's-beta', name: 'beta' },
        kind: 'finding',
        title: 'finding · t2',
        body: 'beta 摘要',
        refs: ['t2'],
        tags: ['report'],
      })
      board.query = originalQuery
    }
    return originalQuery(filter)
  }
  const result = await tools.collect({ names: ['beta'], waitMs: 500 })
  assert.deepEqual(result.children.map((c) => c.name), ['beta'])
  assert.deepEqual(result.missing, [])
})

// ---------------------------------------------------------------------------
// master_collect 的 sources 字段（T8 接线：消费 lib/sources.js 的来源聚合）
// ---------------------------------------------------------------------------

test('collect：同一 url 两段不同引文 → sources 里该来源 conflict=true 且 quotes 长度 2', async () => {
  const { tools, board } = createDeps()
  await board.append({
    author: { sessionId: 's-alpha', name: 'alpha' },
    kind: 'source',
    title: 'https://example.com/a2a',
    body: 'artifact 绑定 contextId',
    refs: ['https://example.com/a2a'],
    tags: ['evidence'],
  })
  // 末尾斜杠：黑板去重键不同，但 lib/sources.js 会归成同一来源
  await board.append({
    author: { sessionId: 's-beta', name: 'beta' },
    kind: 'source',
    title: 'https://example.com/a2a/',
    body: 'artifact 绑定 taskId',
    refs: ['https://example.com/a2a/'],
    tags: ['evidence'],
  })

  const result = await tools.collect()
  assert.equal(result.sources.sources.length, 1)
  const [source] = result.sources.sources
  assert.equal(source.conflict, true)
  assert.equal(source.quotes.length, 2)
  assert.deepEqual(source.quotes.map((item) => item.by), ['alpha', 'beta'])
  assert.deepEqual(source.quotes.map((item) => item.quote), ['artifact 绑定 contextId', 'artifact 绑定 taskId'])
  assert.equal(result.sources.duplicates, 0)
  assert.equal(typeof source.conflictReason, 'string')
})

test('collect：同一 url 同一 quote 两条 → quotes 只留 1 条且 duplicates≥1', async () => {
  const { tools, board } = createDeps()
  await board.append({
    author: { sessionId: 's-alpha', name: 'alpha' },
    kind: 'source',
    title: 'https://example.com/a2a',
    body: '同一段引文',
    refs: ['https://example.com/a2a'],
    tags: ['evidence'],
  })
  // 末尾斜杠让黑板去重键不同（黑板不会吞掉第二条），但聚合器按同一来源去重
  await board.append({
    author: { sessionId: 's-beta', name: 'beta' },
    kind: 'source',
    title: 'https://example.com/a2a/',
    body: '同一段引文',
    refs: ['https://example.com/a2a/'],
    tags: ['evidence'],
  })

  const result = await tools.collect()
  assert.equal(result.sources.sources.length, 1)
  const [source] = result.sources.sources
  assert.equal(source.quotes.length, 1)
  assert.equal(source.quotes[0].quote, '同一段引文')
  assert.equal(source.conflict, false)
  assert.ok(result.sources.duplicates >= 1, '重复引文应计入 duplicates：' + JSON.stringify(result.sources))
})

test('collect：names 过滤后只聚合被点名子对话的来源（另一个子对话的来源不出现）', async () => {
  const { tools, board } = createDeps()
  await board.append({
    author: { sessionId: 's-alpha', name: 'alpha' },
    kind: 'source',
    title: 'https://example.com/a2a',
    body: 'alpha 的引文',
    refs: ['https://example.com/a2a'],
    tags: ['evidence'],
  })
  await board.append({
    author: { sessionId: 's-beta', name: 'beta' },
    kind: 'source',
    title: 'https://example.com/beta',
    body: 'beta 的引文',
    refs: ['https://example.com/beta'],
    tags: ['evidence'],
  })

  const all = await tools.collect()
  assert.deepEqual(all.sources.sources.map((item) => item.url).sort(), [
    'https://example.com/a2a',
    'https://example.com/beta',
  ])

  const filtered = await tools.collect({ names: ['alpha'] })
  assert.equal(filtered.children.length, 1)
  assert.deepEqual(filtered.sources.sources.map((item) => item.url), ['https://example.com/a2a'])
  assert.equal(
    filtered.sources.sources.some((item) => item.url === 'https://example.com/beta'),
    false,
    '未被点名的子对话来源不得混进来',
  )
})

test('collect：板上没有 source 记录时 sources 为 { sources: [], duplicates: 0 } 且不抛', async () => {
  const { tools, board } = createDeps()
  await board.append({
    author: { sessionId: 's-alpha', name: 'alpha' },
    kind: 'finding',
    title: 'finding · t1',
    body: '摘要',
    refs: ['t1'],
    tags: ['report'],
  })

  const result = await tools.collect()
  assert.deepEqual(result.sources, { sources: [], duplicates: 0 })
  // 其余字段照旧
  assert.deepEqual(result.children.map((child) => child.name), ['alpha'])
  assert.deepEqual(result.missing, [])
})

// ---------------------------------------------------------------------------
// master_board
// ---------------------------------------------------------------------------

test('master_board：query 转发过滤条件，head 返回 seq，未知 op 报错', async () => {
  const { tools, board } = createDeps()
  await board.append({
    author: { sessionId: 's-alpha', name: 'alpha' },
    kind: 'finding',
    title: 'f',
    body: 'b',
    refs: [],
    tags: [],
  })

  const queried = await tools.boardTool({ op: 'query', kind: 'finding', sinceSeq: 0, limit: 5 })
  assert.equal(Array.isArray(queried), true)
  assert.equal(queried.length, 1)
  assert.equal(queried[0].kind, 'finding')
  const forwarded = board.calls.query[board.calls.query.length - 1]
  assert.equal(forwarded.kind, 'finding')
  assert.equal(forwarded.sinceSeq, 0)
  assert.equal(forwarded.limit, 5)

  const head = await tools.boardTool({ op: 'head' })
  assert.deepEqual(head, { seq: 1 })

  await assert.rejects(() => tools.boardTool({ op: 'delete' }), ToolsError)
  await assert.rejects(() => tools.boardTool({ op: 'delete' }), /不支持|未知/)
})

// ---------------------------------------------------------------------------
// master_digest（唯一碰磁盘的工具，用临时目录）
// ---------------------------------------------------------------------------

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'am-t4-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('digest：未超预算时原样返回摘要、一个字节都不落盘', async () => {
  await withTempDir(async (dir) => {
    const { tools } = createDeps({ config: { dataDir: dir } })
    const text = '短文本'
    const result = await tools.digest({ text, budgetBytes: 1024 })
    assert.equal(result.truncated, false)
    assert.equal(result.summary, text)
    assert.equal(result.locator, null)
    assert.equal(result.bytes, Buffer.byteLength(text, 'utf8'))
    assert.equal(result.sha256, createHash('sha256').update(text, 'utf8').digest('hex'))
    // 连 root 目录都不应被创建
    assert.equal(existsSync(join(dir, ROOT_ID)), false)
  })
})

test('digest：超预算时落盘 artifacts/<sha256>.md 且只回摘要指针', async () => {
  await withTempDir(async (dir) => {
    const { tools } = createDeps({ config: { dataDir: dir } })
    const text = '长'.repeat(2000) // 6000 字节（UTF-8）
    const result = await tools.digest({ text, budgetBytes: 1024 })

    assert.equal(result.truncated, true)
    assert.equal(result.bytes, Buffer.byteLength(text, 'utf8'))
    assert.equal(result.summary.length, 256) // budget/4
    assert.equal(result.summary, text.slice(0, 256))
    assert.equal(basename(result.locator), result.sha256 + '.md')
    assert.ok(result.locator.split(/[\\/]/).includes('artifacts'), 'locator 应在 artifacts 目录下')
    assert.equal(await readFile(result.locator, 'utf8'), text)
  })
})

test('digest：支持从 path 读入，预算取 config.digestBudgetBytes', async () => {
  await withTempDir(async (dir) => {
    const { tools } = createDeps({ config: { dataDir: dir, digestBudgetBytes: 1024 } })
    const inputPath = join(dir, 'input.md')
    const text = '来自文件的正文'.repeat(300) // 2100 字节
    await writeFile(inputPath, text, 'utf8')

    const result = await tools.digest({ path: inputPath })
    assert.equal(result.truncated, true)
    assert.equal(result.bytes, Buffer.byteLength(text, 'utf8'))
    assert.equal(result.sha256, createHash('sha256').update(text, 'utf8').digest('hex'))
    assert.equal(await readFile(result.locator, 'utf8'), text)
  })
})

test('digest：既没有 text 也没有 path 时报中文错误', async () => {
  await withTempDir(async (dir) => {
    const { tools } = createDeps({ config: { dataDir: dir } })
    await assert.rejects(() => tools.digest({}), ToolsError)
    await assert.rejects(() => tools.digest({ text: '' }), /text|path/)
  })
})
