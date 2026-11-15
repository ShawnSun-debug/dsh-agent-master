import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Board } from '../lib/board.js'
import { Ledger } from '../lib/ledger.js'
import { bindReportToLedger, renderBrief, validateReport } from '../lib/handoff.js'

test('端到端：建台账 → 渲染契约 → 真 board 记账 → 校验回报 → 违规可见', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'am-int-'))
  try {
    const ledger = new Ledger({ dir })
    const board = new Board({ dir, maxEntries: 10 })
    const entry = await ledger.append({
      taskId: 't1',
      constraints: ['不得引用未核实来源'],
      acceptance: ['结论至少带 2 条来源'],
      boundaries: [join(dir, 'artifacts')],
      forbidden: ['大概', '也许'],
    })

    // 1. 真台账条目能喂给真 renderBrief（跨票接缝）
    const prompt = renderBrief({ taskId: 't1', label: '调研 A', brief: { goal: '查清 X 是否成立', inputs: ['docs/x.md'] }, ledgerEntry: entry })
    assert.match(prompt, /t1/)
    assert.match(prompt, /不得引用未核实来源/)
    assert.match(prompt, /结论至少带 2 条来源/)
    assert.match(prompt, /大概/)   // forbidden 也要出现在契约里
    assert.ok(prompt.length > 200)

    // 2. 真 board 记 task
    const author = { sessionId: 's1', name: 'agent-1' }
    await board.append({ author, kind: 'task', title: '查清 X 是否成立', refs: ['t1'] })

    // 3. 合格回报：绑定台账后无违规
    const raw = {
      taskId: 't1',
      summary: 'X 成立，来源见 evidence',
      findings: [{ text: 'A 支持 X' }],
      evidence: [{ url: 'https://example.com/a', quote: '原文摘录' }],
      confidence: 'medium',
    }
    const { report } = validateReport(raw)
    const bound = bindReportToLedger({ ledger, entry, report })
    assert.deepEqual(bound.violations, [])

    await board.append({ author, kind: 'finding', title: '结论', body: report.summary, refs: ['t1'] })
    const found = await board.query({ kind: 'finding' })
    assert.equal(found.length, 1)
    assert.equal(found[0].author.name, 'agent-1')

    // 4. 违规回报：forbidden 命中必须被真实台账抓到
    const { report: bad } = validateReport({ ...raw, summary: '大概是 X，也许是 Y' })
    const verdict = ledger.verify(entry, bad)
    assert.equal(verdict.ok, false)
    assert.ok(verdict.violations.some((v) => v.kind === 'forbidden'))

    // 5. 越界产物也算违规
    const { report: escaped } = validateReport({ ...raw, artifacts: [{ path: join(dir, 'elsewhere', 'a.md') }] })
    const verdict2 = ledger.verify(entry, escaped)
    assert.ok(verdict2.violations.some((v) => v.kind === 'boundary'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
