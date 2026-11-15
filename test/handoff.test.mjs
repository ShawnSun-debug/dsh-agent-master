// T03 交接契约与渲染：renderBrief / validateReport / bindReportToLedger
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  HandoffError,
  KINDS,
  REPORT_SCHEMA_VERSION,
  ReportValidationError,
  bindReportToLedger,
  renderBrief,
  validateReport,
} from '../lib/handoff.js'

/** 假台账条目（形状与 lib/ledger.js 契约一致，测试不依赖 T2 实现） */
function ledgerEntry(over = {}) {
  return {
    taskId: 't-1',
    version: 2,
    ts: 0,
    schemaVersion: 1,
    constraints: ['只用 Node 内置模块'],
    acceptance: ['至少 3 条带 url 的 evidence'],
    boundaries: ['D:/work/out'],
    forbidden: ['不得改动 package.json'],
    hash: 'ab12cd34ef56',
    ...over,
  }
}

function baseBrief(over = {}) {
  return {
    goal: '调研 DSH 插件市场现状',
    inputs: ['用户原始问题：插件市场有哪些竞品'],
    constraints: ['只用 Node 内置模块'],
    acceptance: ['至少 3 条带 url 的 evidence'],
    boundaries: ['D:/work/out'],
    ...over,
  }
}

function baseReport(over = {}) {
  return {
    taskId: 't-1',
    summary: '插件市场以官方插件为主，社区插件稀少。',
    findings: [{ text: '官方文档列出 12 个扩展点', refs: ['docs'] }],
    evidence: [{ url: 'https://example.com/docs', quote: '扩展点共 12 个' }],
    open_questions: ['是否还有私有市场？'],
    artifacts: [{ path: 'D:/work/out/summary.md', bytes: 128, sha256: 'a'.repeat(64) }],
    confidence: 'medium',
    ...over,
  }
}

/** 捕获同步抛出的错误；没抛就判失败 */
function catchError(fn) {
  try {
    fn()
  } catch (error) {
    return error
  }
  assert.fail('预期抛出错误，但调用成功了')
}

const errorPaths = (error) => error.errors.map((item) => item.path)

test('错误类与常量符合契约', () => {
  assert.equal(REPORT_SCHEMA_VERSION, 1)
  assert.deepEqual(KINDS, ['finding', 'source', 'artifact'])
  const error = new ReportValidationError('坏了', [{ path: 'findings', message: '缺 findings' }])
  assert.ok(error instanceof HandoffError)
  assert.equal(error.name, 'ReportValidationError')
  assert.deepEqual(error.errors, [{ path: 'findings', message: '缺 findings' }])
  assert.equal(new HandoffError('x').name, 'HandoffError')
})

test('renderBrief：prompt 含任务号、目标与输入', () => {
  const prompt = renderBrief({ taskId: 't-1', label: 'child-alpha', brief: baseBrief(), ledgerEntry: ledgerEntry() })
  assert.match(prompt, /t-1/)
  assert.match(prompt, /调研 DSH 插件市场现状/)
  assert.match(prompt, /用户原始问题：插件市场有哪些竞品/)
  assert.match(prompt, /child-alpha/)

  // inputs 既支持数组也支持单条字符串；非字符串项按 JSON 序列化，避免静默丢输入
  const single = renderBrief({
    taskId: 't-2',
    brief: baseBrief({ inputs: '单条输入' }),
    ledgerEntry: ledgerEntry({ taskId: 't-2' }),
  })
  assert.match(single, /单条输入/)
  const structured = renderBrief({
    taskId: 't-3',
    brief: baseBrief({ inputs: [{ 黑板: 'seq=3' }] }),
    ledgerEntry: ledgerEntry({ taskId: 't-3' }),
  })
  assert.match(structured, /"黑板":"seq=3"/)

  // 没给 label 时也有占位，不会渲染出「执行者：undefined」
  const noLabel = renderBrief({ taskId: 't-4', brief: baseBrief(), ledgerEntry: ledgerEntry({ taskId: 't-4' }) })
  assert.match(noLabel, /未指定/)
})

test('renderBrief：prompt 含台账版本与 constraints/acceptance/boundaries/forbidden 逐条', () => {
  const entry = ledgerEntry({
    constraints: ['只用 Node 内置模块', { text: '结论须有来源', needsEvidence: true }],
  })
  const prompt = renderBrief({ taskId: 't-1', label: 'child-alpha', brief: baseBrief(), ledgerEntry: entry })
  assert.match(prompt, /台账版本：v2/)
  assert.match(prompt, /schemaVersion=1/)
  assert.match(prompt, /hash=ab12cd34ef56/)
  assert.match(prompt, /constraints/)
  assert.match(prompt, /acceptance/)
  assert.match(prompt, /boundaries/)
  assert.match(prompt, /forbidden/)
  assert.match(prompt, /1\. 只用 Node 内置模块/)
  assert.match(prompt, /2\. 结论须有来源（需 evidence）/)
  assert.match(prompt, /至少 3 条带 url 的 evidence/)
  assert.match(prompt, /D:\/work\/out/)
  assert.match(prompt, /不得改动 package.json/)
})

test('renderBrief：prompt 含交付 JSON schema（字段名与类型）与报告纪律', () => {
  const prompt = renderBrief({ taskId: 't-1', label: 'child-alpha', brief: baseBrief(), ledgerEntry: ledgerEntry() })
  for (const field of ['taskId', 'summary', 'findings', 'evidence', 'open_questions', 'artifacts', 'confidence', 'schemaVersion']) {
    assert.ok(prompt.includes('"' + field + '"'), '交付 schema 缺少字段 ' + field)
  }
  assert.match(prompt, /string/)
  assert.match(prompt, /array/)
  assert.match(prompt, /禁止回传散文全文/)
  assert.match(prompt, /quote/)
  assert.match(prompt, /url（http\/https）或 path/)
  assert.match(prompt, /字节预算/)
  assert.match(prompt, /8192/)
  assert.match(prompt, /master_report/)
  // 回传载荷类型来自 KINDS
  assert.match(prompt, /finding \/ source \/ artifact/)
})

test('renderBrief：预算支持数字与 { maxReportBytes } 两种写法', () => {
  const asNumber = renderBrief({
    taskId: 't-1',
    brief: baseBrief({ budget: 4096 }),
    ledgerEntry: ledgerEntry(),
  })
  assert.match(asNumber, /4096/)
  const asObject = renderBrief({
    taskId: 't-1',
    brief: baseBrief({ budget: { maxReportBytes: 2048 } }),
    ledgerEntry: ledgerEntry(),
  })
  assert.match(asObject, /2048/)
  assert.throws(
    () => renderBrief({ taskId: 't-1', brief: baseBrief({ budget: -1 }), ledgerEntry: ledgerEntry() }),
    HandoffError,
  )
})

test('renderBrief：缺上下文时拒绝渲染，而不是渲染残缺契约', () => {
  assert.throws(() => renderBrief({ brief: baseBrief(), ledgerEntry: ledgerEntry() }), HandoffError)
  assert.throws(() => renderBrief({ taskId: 't-1', ledgerEntry: ledgerEntry() }), HandoffError)
  assert.throws(() => renderBrief({ taskId: 't-1', brief: baseBrief() }), /ledgerEntry/)
  // 台账与任务号不一致时不能拼出一份张冠李戴的契约
  assert.throws(
    () => renderBrief({ taskId: 't-9', brief: baseBrief(), ledgerEntry: ledgerEntry() }),
    /不一致/,
  )
})

test('renderBrief：空组渲染占位，brief 独有条目不被丢弃', () => {
  const emptyPrompt = renderBrief({
    taskId: 't-1',
    brief: baseBrief({ acceptance: [], boundaries: [], constraints: [] }),
    ledgerEntry: ledgerEntry({ acceptance: [], boundaries: [], forbidden: [] }),
  })
  assert.match(emptyPrompt, /（无）/)

  const prompt = renderBrief({
    taskId: 't-1',
    brief: baseBrief({ constraints: ['只用 Node 内置模块', '额外：结论用中文'] }),
    ledgerEntry: ledgerEntry(),
  })
  assert.match(prompt, /额外：结论用中文/)
  // 台账条目在前，brief 重复项不重复渲染
  assert.equal(prompt.match(/只用 Node 内置模块/g).length, 1)
})

test('validateReport：缺 findings 被拒，错误逐条带字段路径（可修正）', () => {
  const missing = catchError(() => validateReport(baseReport({ findings: undefined })))
  assert.ok(missing instanceof ReportValidationError)
  assert.deepEqual(errorPaths(missing), ['findings'])
  for (const item of missing.errors) {
    assert.equal(typeof item.path, 'string')
    assert.ok(item.path.length > 0, '每条错误都必须带字段路径')
    assert.equal(typeof item.message, 'string')
    assert.ok(item.message.length > 0)
  }

  // 空数组同样被拒
  const empty = catchError(() => validateReport(baseReport({ findings: [] })))
  assert.deepEqual(errorPaths(empty), ['findings'])

  // 多处问题一次性汇总，避免子对话改一处跑一趟
  const multi = catchError(() => validateReport(baseReport({ findings: undefined, summary: '  ' })))
  assert.deepEqual(errorPaths(multi).sort(), ['findings', 'summary'])

  // 字段级：findings 项缺 text
  const noText = catchError(() => validateReport(baseReport({ findings: [{ refs: [] }] })))
  assert.deepEqual(errorPaths(noText), ['findings[0].text'])
})

test('validateReport：evidence 必带 url 或 path 且 quote 非空，路径精确到元素', () => {
  const error = catchError(() =>
    validateReport(
      baseReport({
        evidence: [
          { quote: '只有 quote' },
          { url: 'ftp://example.com/x', quote: 'q' },
          { url: 'https://example.com/y', quote: '' },
          { path: 'D:/work/out/a.md', quote: '本地摘句' },
        ],
      }),
    ),
  )
  assert.ok(error instanceof ReportValidationError)
  assert.deepEqual(errorPaths(error).sort(), ['evidence[0]', 'evidence[1].url', 'evidence[2].quote'])

  // path 也可以单独成立；http 与 https 都接受
  const withPath = validateReport(baseReport({ evidence: [{ path: 'D:/work/out/a.md', quote: '本地摘句' }] }))
  assert.deepEqual(withPath.report.evidence, [{ path: 'D:/work/out/a.md', quote: '本地摘句' }])
  const withHttp = validateReport(baseReport({ evidence: [{ url: 'http://example.com/z', quote: 'q' }] }))
  assert.deepEqual(withHttp.report.evidence, [{ url: 'http://example.com/z', quote: 'q' }])
})

test('validateReport：字节预算按 UTF-8 计算，超限文案带实际字节数与上限', () => {
  const over = '研'.repeat(3000) // 9000 字节
  const error = catchError(() => validateReport(baseReport({ summary: over })))
  assert.deepEqual(errorPaths(error), ['summary'])
  assert.match(error.errors[0].message, /9000/)
  assert.match(error.errors[0].message, /8192/)

  // 恰好等于上限不报错（UTF-8 3000 字节）
  const exact = validateReport(baseReport({ summary: '研'.repeat(1000) }), { maxBytes: 3000 })
  assert.equal(exact.ok, true)

  const overCustom = catchError(() => validateReport(baseReport({ summary: '研'.repeat(1001) }), { maxBytes: 3000 }))
  assert.match(overCustom.errors[0].message, /3003/)
  assert.match(overCustom.errors[0].message, /3000/)

  const badLimit = catchError(() => validateReport(baseReport(), { maxBytes: 0 }))
  assert.equal(badLimit.name, 'HandoffError')
  assert.match(badLimit.message, /maxBytes/)
})

test('validateReport：schemaVersion 缺省补 1，不支持的版本由版本分派拒收', () => {
  assert.equal(validateReport(baseReport()).report.schemaVersion, 1)
  assert.equal(validateReport(baseReport({ schemaVersion: 1 })).report.schemaVersion, 1)
  assert.equal(validateReport(baseReport({ schemaVersion: null })).report.schemaVersion, 1)

  const unsupported = catchError(() => validateReport(baseReport({ schemaVersion: 2 })))
  assert.ok(unsupported instanceof ReportValidationError)
  assert.deepEqual(errorPaths(unsupported), ['schemaVersion'])
  assert.match(unsupported.errors[0].message, /不支持/)
  assert.match(unsupported.errors[0].message, /2/)

  // 版本号类型不对也不猜字段
  const wrongType = catchError(() => validateReport(baseReport({ schemaVersion: '1' })))
  assert.deepEqual(errorPaths(wrongType), ['schemaVersion'])
  assert.equal(wrongType.errors.length, 1)
})

test('validateReport：confidence 三档、未知字段忽略、结构归一化', () => {
  const bad = catchError(() => validateReport(baseReport({ confidence: 'very-high' })))
  assert.deepEqual(errorPaths(bad), ['confidence'])
  const missing = catchError(() => validateReport(baseReport({ confidence: undefined })))
  assert.deepEqual(errorPaths(missing), ['confidence'])

  const { ok, report } = validateReport(
    baseReport({
      findings: ['纯字符串发现', { text: ' 带 refs 的发现 ', refs: ['doc-1'] }],
      artifacts: [{ path: 'D:/work/out/a.md' }],
      extra: '忽略我',
    }),
  )
  assert.equal(ok, true)
  assert.deepEqual(report.findings, [{ text: '纯字符串发现' }, { text: '带 refs 的发现', refs: ['doc-1'] }])
  assert.deepEqual(report.artifacts, [{ path: 'D:/work/out/a.md' }])
  assert.equal('extra' in report, false)
  assert.deepEqual(Object.keys(report).sort(), [
    'artifacts',
    'confidence',
    'evidence',
    'findings',
    'open_questions',
    'schemaVersion',
    'summary',
    'taskId',
  ])
})

test('validateReport：artifacts 与 open_questions 字段级校验', () => {
  const artifacts = catchError(() =>
    validateReport(
      baseReport({
        artifacts: [{ path: '' }, { path: 'a.md', bytes: -1, sha256: 'zz' }],
      }),
    ),
  )
  assert.deepEqual(errorPaths(artifacts).sort(), ['artifacts[0].path', 'artifacts[1].bytes', 'artifacts[1].sha256'])

  const questions = catchError(() => validateReport(baseReport({ open_questions: ['', 42] })))
  assert.deepEqual(errorPaths(questions), ['open_questions[0]', 'open_questions[1]'])

  const notArray = catchError(() => validateReport(baseReport({ findings: '一条发现' })))
  assert.deepEqual(errorPaths(notArray), ['findings'])
})

test('validateReport：失败与成功都不产生文件副作用', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-handoff-'))
  const cwd = process.cwd()
  try {
    process.chdir(dir)
    const before = await readdir(dir)
    catchError(() => validateReport(baseReport({ findings: [], confidence: 'x' })))
    validateReport(baseReport())
    const after = await readdir(dir)
    assert.deepEqual(after, before)
    assert.deepEqual(after, [], '校验是纯函数，失败不落盘')
  } finally {
    process.chdir(cwd)
    await rm(dir, { recursive: true, force: true })
  }
})

test('validateReport：归一化返回新对象，不修改入参', () => {
  const raw = baseReport()
  const frozen = Object.freeze({
    ...raw,
    findings: Object.freeze([Object.freeze({ text: '发现' })]),
    evidence: Object.freeze([Object.freeze({ url: 'https://example.com/a', quote: 'q' })]),
  })
  const { report } = validateReport(frozen)
  assert.notEqual(report, frozen)
  assert.notEqual(report.findings, frozen.findings)
  assert.notEqual(report.evidence, frozen.evidence)
  assert.deepEqual(raw.findings, [{ text: '官方文档列出 12 个扩展点', refs: ['docs'] }])
})

test('bindReportToLedger：组合 ledger.verify 并检查 taskId 一致', () => {
  const calls = []
  const ledger = {
    verify(entry, report) {
      calls.push({ entry, report })
      return { ok: false, violations: [{ kind: 'forbidden', text: '不得改动 package.json', reason: 'summary 命中禁止项' }] }
    },
  }
  const entry = ledgerEntry()
  const { report } = validateReport(baseReport())
  const result = bindReportToLedger({ ledger, entry, report })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].entry, entry)
  assert.equal(calls[0].report, report)
  assert.equal(result.violations.length, 1)
  assert.equal(result.violations[0].kind, 'forbidden')
  assert.equal(result.ok, false)

  // taskId 不一致：额外产生一条能定位到字段的 violation
  const mismatch = bindReportToLedger({
    ledger: { verify: () => ({ violations: [] }) },
    entry,
    report: { ...report, taskId: 't-9' },
  })
  assert.equal(mismatch.ok, false)
  assert.equal(mismatch.violations.length, 1)
  assert.equal(mismatch.violations[0].kind, 'taskId')
  assert.match(mismatch.violations[0].reason, /t-9/)
  assert.match(mismatch.violations[0].reason, /t-1/)

  // 全部命中时返回空 violations
  const clean = bindReportToLedger({ ledger: { verify: () => ({ ok: true, violations: [] }) }, entry, report })
  assert.deepEqual(clean, { violations: [], ok: true })
})

test('bindReportToLedger：参数缺失抛 HandoffError', () => {
  assert.throws(() => bindReportToLedger({ entry: ledgerEntry(), report: {} }), HandoffError)
  assert.throws(() => bindReportToLedger({ ledger: { verify() {} } }), HandoffError)
  assert.throws(() => bindReportToLedger({ ledger: { verify() {} }, entry: { taskId: 't-1' } }), HandoffError)
  assert.throws(
    () => bindReportToLedger({ ledger: {}, entry: ledgerEntry(), report: {} }),
    /verify/,
  )
})
test('validateReport：根对象与项类型错误同样带字段路径', () => {
  assert.deepEqual(errorPaths(catchError(() => validateReport(null))), ['(root)'])
  assert.deepEqual(errorPaths(catchError(() => validateReport([]))), ['(root)'])

  const items = catchError(() =>
    validateReport(baseReport({ findings: [42], evidence: [null], open_questions: 'x', artifacts: 'y' })),
  )
  assert.deepEqual(errorPaths(items).sort(), ['artifacts', 'evidence[0]', 'findings[0]', 'open_questions'])

  // 不是合法 URL 也走「只接受 http/https」这条分支
  const badUrl = catchError(() => validateReport(baseReport({ evidence: [{ url: '不是链接', quote: 'q' }] })))
  assert.deepEqual(errorPaths(badUrl), ['evidence[0].url'])
})

test('renderBrief：无 inputs 时渲染占位，不出现 undefined', () => {
  const brief = baseBrief()
  delete brief.inputs
  const prompt = renderBrief({ taskId: 't-1', brief, ledgerEntry: ledgerEntry() })
  assert.doesNotMatch(prompt, /undefined/)
  assert.match(prompt, /## 2\. 输入\n（无）/)

  // { maxReportBytes } 写法缺字段时报错，而不是静默回退默认预算
  const badBudget = catchError(() =>
    renderBrief({ taskId: 't-1', brief: baseBrief({ budget: { size: 1 } }), ledgerEntry: ledgerEntry() }),
  )
  assert.equal(badBudget.name, 'HandoffError')
  assert.match(badBudget.message, /maxReportBytes/)
})
