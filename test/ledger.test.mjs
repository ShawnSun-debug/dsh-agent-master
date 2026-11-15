import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LEDGER_SCHEMA_VERSION, Ledger, LedgerError } from '../lib/ledger.js'

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 每个用例一个 os.tmpdir() 下的临时目录，用完删掉，不碰真实 ~/.dsh。 */
async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-am-ledger-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** 读台账文件的有效行，用于断言"append-only"的物理形态。 */
async function ledgerLines(dir) {
  const text = await readFile(join(dir, 'ledger.jsonl'), 'utf8')
  return text.split('\n').filter((line) => line.length > 0)
}

/** 断言抛出的是 LedgerError 且文案匹配。 */
function ledgerError(pattern) {
  return (error) => {
    assert.ok(error instanceof LedgerError)
    assert.match(error.message, pattern)
    return true
  }
}

test('台账首版 version=1，内容变化后 version 自增且旧版本留在盘上', async (t) => {
  const dir = await tempDir(t)
  const ledger = new Ledger({ dir, now: () => 1700000000000 })

  const first = await ledger.append({
    taskId: 't-1',
    constraints: ['只用官方文档'],
    acceptance: ['给出链接'],
    boundaries: ['artifacts'],
    forbidden: ['内部机密'],
  })

  assert.equal(LEDGER_SCHEMA_VERSION, 1)
  assert.equal(first.taskId, 't-1')
  assert.equal(first.version, 1)
  assert.equal(first.ts, 1700000000000)
  assert.equal(first.schemaVersion, LEDGER_SCHEMA_VERSION)
  assert.deepEqual(first.constraints, [{ text: '只用官方文档', needsEvidence: false }])
  assert.deepEqual(Object.keys(first), [
    'taskId',
    'version',
    'ts',
    'schemaVersion',
    'constraints',
    'acceptance',
    'boundaries',
    'forbidden',
    'hash',
  ])

  const second = await ledger.append({ taskId: 't-1', constraints: ['只用官方文档'], acceptance: ['给出链接与原文'] })
  assert.equal(second.version, 2)

  const lines = await ledgerLines(dir)
  assert.equal(lines.length, 2)
  assert.equal(JSON.parse(lines[0]).version, 1)
  assert.equal(JSON.parse(lines[1]).version, 2)
  assert.deepEqual(await ledger.latest('t-1'), second)
})

test('同 taskId 同内容不追加新版本（顺序无关），返回既有 entry', async (t) => {
  const dir = await tempDir(t)
  const ledger = new Ledger({ dir })

  const first = await ledger.append({ taskId: 't-1', constraints: ['甲', '乙'], boundaries: ['artifacts'] })
  const again = await ledger.append({ taskId: 't-1', boundaries: ['artifacts'], constraints: ['乙', '甲'] })

  assert.deepEqual(again, first)
  assert.equal(again.version, 1)
  assert.equal((await ledgerLines(dir)).length, 1)
  assert.equal(await ledger.latest('t-2'), null)
})

test('hash 是四组数组稳定排序后的 sha256', async (t) => {
  const dir = await tempDir(t)
  const ledger = new Ledger({ dir })

  const entry = await ledger.append({
    taskId: 't-1',
    constraints: [{ text: '需要证据', needsEvidence: true }, '普通约束'],
    acceptance: ['b', 'a'],
    boundaries: ['z', 'a'],
    forbidden: ['x'],
  })

  const expected = sha256(
    JSON.stringify([
      [
        { text: '普通约束', needsEvidence: false },
        { text: '需要证据', needsEvidence: true },
      ],
      ['a', 'b'],
      ['a', 'z'],
      ['x'],
    ]),
  )
  assert.equal(entry.hash, expected)
})

test('用旧 version 覆盖既有版本（如 digest 摘要回写）抛 LedgerError 且盘上不变', async (t) => {
  const dir = await tempDir(t)
  const ledger = new Ledger({ dir })
  await ledger.append({ taskId: 't-1', constraints: ['原约束'] })
  await ledger.append({ taskId: 't-1', constraints: ['新约束'] })

  await assert.rejects(
    () => ledger.append({ taskId: 't-1', constraints: ['被摘要改写过的约束'], version: 1 }),
    ledgerError(/version 冲突/),
  )

  const lines = await ledgerLines(dir)
  assert.equal(lines.length, 2)
  assert.deepEqual((await ledger.latest('t-1')).constraints, [{ text: '新约束', needsEvidence: false }])

  // 带正确的下一个 version 仍可追加
  const third = await ledger.append({ taskId: 't-1', constraints: ['第三版'], version: 3 })
  assert.equal(third.version, 3)
})

test('台账文件被删除后追加抛 LedgerError，而不是静默重建', async (t) => {
  const dir = await tempDir(t)
  const ledger = new Ledger({ dir })
  await ledger.append({ taskId: 't-1', constraints: ['不可被摘要覆盖'] })
  await rm(join(dir, 'ledger.jsonl'))

  await assert.rejects(() => ledger.append({ taskId: 't-2', constraints: ['另一条'] }), ledgerError(/截断/))
})

test('既有版本的行被改写后追加抛 LedgerError', async (t) => {
  const dir = await tempDir(t)
  const ledger = new Ledger({ dir })
  await ledger.append({ taskId: 't-1', constraints: ['原约束'] })

  const file = join(dir, 'ledger.jsonl')
  const text = await readFile(file, 'utf8')
  await writeFile(file, text.replace('原约束', '被摘要改写的约束'), 'utf8')

  await assert.rejects(() => ledger.append({ taskId: 't-1', constraints: ['新约束'] }), ledgerError(/已被改写/))
})

test('台账文件出现非法 JSON 行时读取抛 LedgerError', async (t) => {
  const dir = await tempDir(t)
  const first = new Ledger({ dir })
  await first.append({ taskId: 't-1', constraints: ['甲'] })
  await appendFile(join(dir, 'ledger.jsonl'), '{这不是 JSON\n', 'utf8')

  const broken = new Ledger({ dir })
  await assert.rejects(() => broken.list(), ledgerError(/第 2 行/))
  await assert.rejects(() => broken.latest('t-1'), LedgerError)
})

test('多个 Ledger 实例顺序追加时版本继续递增，不误判为篡改', async (t) => {
  const dir = await tempDir(t)
  const a = new Ledger({ dir })
  const b = new Ledger({ dir })

  await a.append({ taskId: 't-1', constraints: ['第一版'] })
  await b.append({ taskId: 't-1', constraints: ['第二版'] })
  const third = await a.append({ taskId: 't-1', constraints: ['第三版'] })

  assert.equal(third.version, 3)
  assert.equal((await ledgerLines(dir)).length, 3)
})

test('list 按 taskId 分组只返回最新版本', async (t) => {
  const dir = await tempDir(t)
  const ledger = new Ledger({ dir })

  await ledger.append({ taskId: 't-2', constraints: ['B1'] })
  await ledger.append({ taskId: 't-1', constraints: ['A1'] })
  await ledger.append({ taskId: 't-1', constraints: ['A2'] })

  const all = await ledger.list()
  assert.deepEqual(
    all.map((entry) => [entry.taskId, entry.version]),
    [
      ['t-1', 2],
      ['t-2', 1],
    ],
  )
})

test('并发追加同一 taskId：版本连续、一条不少', async (t) => {
  const dir = await tempDir(t)
  const ledger = new Ledger({ dir })

  const entries = await Promise.all(
    Array.from({ length: 5 }, (_, index) => ledger.append({ taskId: 't-1', constraints: ['约束 ' + index] })),
  )

  assert.deepEqual(entries.map((entry) => entry.version), [1, 2, 3, 4, 5])
  assert.equal((await ledgerLines(dir)).length, 5)
})

test('非法输入抛 LedgerError', async (t) => {
  const dir = await tempDir(t)
  const ledger = new Ledger({ dir })

  await assert.rejects(() => ledger.append({ taskId: '', constraints: [] }), ledgerError(/taskId/))
  await assert.rejects(() => ledger.append({ taskId: 't-1', acceptance: [1] }), ledgerError(/acceptance\[0\]/))
  await assert.rejects(() => ledger.append({ taskId: 't-1', constraints: [{ text: '' }] }), ledgerError(/constraints\[0\]/))
})

test('verify：forbidden 命中摘要或发现 → violation(kind=forbidden)', async (t) => {
  const dir = await tempDir(t)
  const ledger = new Ledger({ dir })
  const entry = await ledger.append({ taskId: 't-1', forbidden: ['内部机密'] })

  const summaryHit = ledger.verify(entry, { summary: '这里提到内部机密两个字', findings: [{ text: '正常发现' }] })
  assert.equal(summaryHit.ok, false)
  assert.deepEqual(summaryHit.violations, [
    { kind: 'forbidden', text: '内部机密', reason: '禁止项「内部机密」出现在报告的摘要' },
  ])

  const findingHit = ledger.verify(entry, { summary: '正常摘要', findings: [{ text: '发现' }, { text: '顺带聊了内部机密' }] })
  assert.equal(findingHit.ok, false)
  assert.deepEqual(findingHit.violations.map((violation) => violation.kind), ['forbidden'])
  assert.match(findingHit.violations[0].reason, /发现 #2/)
})

test('verify：产物路径越界 → violation(kind=boundary)，边界为空则不检查', async (t) => {
  const dir = await tempDir(t)
  const ledger = new Ledger({ dir })
  const entry = await ledger.append({ taskId: 't-1', boundaries: ['artifacts'] })

  const passed = ledger.verify(entry, {
    summary: '摘要',
    findings: [{ text: '发现' }],
    artifacts: [{ path: 'artifacts/report.md' }, { path: 'artifacts\\sub\\a.txt' }],
  })
  assert.deepEqual(passed, { violations: [], ok: true })

  const bad = ledger.verify(entry, {
    summary: '摘要',
    findings: [{ text: '发现' }],
    artifacts: [{ path: 'artifacts-evil/x.md' }, { path: 'C:/tmp/out.md' }, {}],
  })
  assert.equal(bad.ok, false)
  assert.deepEqual(
    bad.violations.map((violation) => [violation.kind, violation.text]),
    [
      ['boundary', 'artifacts-evil/x.md'],
      ['boundary', 'C:/tmp/out.md'],
      ['boundary', ''],
    ],
  )
  assert.deepEqual(bad.violations[0], {
    kind: 'boundary',
    text: 'artifacts-evil/x.md',
    reason: '产物路径「artifacts-evil/x.md」不在边界白名单内：artifacts',
  })

  const noBoundary = await ledger.append({ taskId: 't-2', constraints: ['无边界'] })
  assert.deepEqual(
    ledger.verify(noBoundary, { summary: '摘要', findings: [], artifacts: [{ path: '任意/位置.md' }] }),
    { violations: [], ok: true },
  )
})

test('verify：needsEvidence 约束缺少 evidence → violation(kind=constraint)', async (t) => {
  const dir = await tempDir(t)
  const ledger = new Ledger({ dir })
  const entry = await ledger.append({
    taskId: 't-1',
    constraints: ['普通约束', { text: '必须给出官方原文', needsEvidence: true }],
  })

  const missing = ledger.verify(entry, { summary: '摘要', findings: [{ text: '发现' }], evidence: [] })
  assert.deepEqual(missing.violations, [
    { kind: 'constraint', text: '必须给出官方原文', reason: '约束「必须给出官方原文」需要证据，但报告里没有 evidence' },
  ])

  const present = ledger.verify(entry, {
    summary: '摘要',
    findings: [{ text: '发现' }],
    evidence: [{ url: 'https://example.com', quote: '原文' }],
  })
  assert.deepEqual(present, { violations: [], ok: true })
})

test('verify 兼容未归一化的字符串约束；全部通过时无 violation', async (t) => {
  const dir = await tempDir(t)
  const ledger = new Ledger({ dir })

  const result = ledger.verify(
    { constraints: ['需要证据但只是字符串'], forbidden: ['禁词'], boundaries: ['artifacts'] },
    { summary: '出现禁词', findings: [], evidence: [], artifacts: [{ path: 'artifacts/x.md' }] },
  )
  assert.deepEqual(result.violations.map((violation) => [violation.kind, violation.text]), [['forbidden', '禁词']])

  const clean = ledger.verify(
    { constraints: ['普通约束'], forbidden: ['禁词'], boundaries: ['artifacts'] },
    { summary: '干净摘要', findings: [{ text: '干净发现' }], evidence: [{ path: 'a.md', quote: '原文' }], artifacts: [{ path: 'artifacts/x.md' }] },
  )
  assert.deepEqual(clean, { violations: [], ok: true })
})
