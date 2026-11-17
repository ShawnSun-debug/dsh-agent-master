/**
 * 跨层集成：台账 → 交接契约 → 真看板 → 回报门禁 → 验收入账 → deck v2 快照落盘。
 *
 * 这条链路是 T09–T13 的接缝：每一环都用真实实现（真 Board / 真 Ledger / 真 handoff /
 * 真 gate），只把「开子会话」换成替身 —— 否则测的是假实现，接缝处的问题永远抓不到。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Board } from '../lib/board.js'
import { Ledger } from '../lib/ledger.js'
import { ExperienceStore } from '../lib/experience.js'
import { createTools } from '../lib/tools.js'
import { buildDeck } from '../lib/deck.js'
import { bindReportToLedger, renderBrief, validateReport } from '../lib/handoff.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const TMP_ROOT = join(ROOT, '.test-tmp')

const ROOT_ID = 'session-root'
const MASTER = { author: { sessionId: ROOT_ID, name: 'master' } }
const CHILD = { author: { sessionId: 'session-child-1', name: 'worker-a' } }

/** 造一套真实环境：真看板 + 真台账 + 真经验库，只有 spawn 是替身。 */
async function makeEnv() {
  await mkdir(TMP_ROOT, { recursive: true })
  const dir = await mkdtemp(join(TMP_ROOT, 'integration-'))
  const board = new Board({ dir, maxCards: 32, maxRecords: 256 })
  const ledger = new Ledger({ dir })
  const experience = new ExperienceStore({ projectDir: join(dir, 'project'), globalDir: join(dir, 'global') })
  const spawned = []
  const tools = createTools({
    config: { maxChildren: 4, digestBudgetBytes: 4096, maxReportBytes: 8192 },
    board,
    ledger,
    spawnActivation: async (spec) => {
      const child = { childId: 'session-child-' + (spawned.length + 1), label: spec.label }
      spawned.push({ spec, child })
      return child
    },
    rootId: ROOT_ID,
    now: () => Date.now(),
    experience,
  })
  return { dir, board, ledger, experience, tools, spawned }
}

test('端到端：台账 → 契约 → 派发 → 认领开工 → 违规回报 → 干净回报 → 验收 → deck v2 落盘', async () => {
  const env = await makeEnv()
  try {
    const { board, ledger, tools, spawned, dir } = env

    // ---- 1. 真台账条目直接喂给真 renderBrief（跨票接缝）
    const entry = await ledger.append({
      taskId: 't1',
      constraints: ['不得引用未核实来源'],
      acceptance: ['结论至少带 2 条来源'],
      boundaries: [join(dir, 'artifacts')],
      forbidden: ['大概', '也许'],
    })
    const prompt = renderBrief({
      taskId: 't1',
      label: '调研 A',
      brief: { goal: '查清 X 是否成立', inputs: ['docs/x.md'] },
      ledgerEntry: entry,
    })
    assert.match(prompt, /t1/)
    assert.match(prompt, /不得引用未核实来源/)
    assert.match(prompt, /结论至少带 2 条来源/)
    assert.match(prompt, /大概/, 'forbidden 必须出现在契约里')
    assert.ok(prompt.length > 200)
    assert.match(prompt, /master_report/, '契约要教子对话怎么回报')

    // ---- 2. master_assign：建卡 + 写台账 + 开子会话（spawn 是替身）
    const assigned = await tools.assign(
      {
        label: '调研 A',
        taskId: 't1',
        priority: 'P1',
        brief: {
          goal: '查清 X 是否成立',
          constraints: ['不得引用未核实来源'],
          acceptance: ['结论至少带 2 条来源'],
          boundaries: [join(dir, 'artifacts')],
          forbidden: ['大概', '也许'],
        },
      },
      MASTER,
    )
    assert.equal(assigned.ok, true)
    assert.equal(assigned.taskId, 't1')
    assert.equal(spawned.length, 1, '必须真的调用一次 spawnActivation')

    // 卡必须在板上，且 P 级来自入参（getCard 返回 { card, records }，卡片用 title 存标题）
    const { card } = await board.getCard('t1')
    assert.equal(card.id, 't1')
    assert.equal(card.priority, 'P1')
    assert.equal(card.title, '查清 X 是否成立')
    assert.equal(card.childSessionId, assigned.childSessionId, '派发时就要把子会话号记在卡上（指挥台开 tab 用）')
    assert.ok(['assigned', 'todo'].includes(card.status), '下派后卡应处于可认领状态，实为 ' + card.status)

    // 台账文件真实落盘
    const ledgerRaw = await readFile(join(dir, 'ledger.jsonl'), 'utf8')
    assert.match(ledgerRaw, /t1/)

    // ---- 3. 子对话四步开局：认领 → 开工（经真门禁）
    const claimed = await tools.boardTool({ op: 'claim', cardId: 't1' }, CHILD)
    assert.equal(claimed.card.status, 'assigned')
    assert.equal(claimed.card.assignee.sessionId, CHILD.author.sessionId)

    const doing = await tools.boardTool({ op: 'doing', cardId: 't1' }, CHILD)
    assert.equal(doing.card.status, 'doing')

    // ---- 4. 违规回报：forbidden 命中必须被真实台账抓到并记进看板
    const bad = await tools.report(
      {
        taskId: 't1',
        summary: '大概是 X，也许是 Y',
        findings: [{ text: 'A 说不清' }],
        evidence: [{ url: 'https://example.com/a', quote: '原文摘录' }],
        confidence: 'low',
      },
      CHILD,
    )
    assert.equal(bad.ok, false, '台账违规时 ok 必须为 false（但记录照样落板）')
    assert.ok(bad.violations.some((violation) => violation.kind === 'forbidden'), '违规类型必须是 forbidden')

    const { card: afterBad, records: badRecords } = await board.getCard('t1')
    assert.equal(afterBad.status, 'doing', '增量报告不动卡状态')
    assert.ok(
      badRecords.some((record) => Array.isArray(record.tags) && record.tags.some((tag) => /violat/i.test(tag))),
      '违规必须作为记录落板（deck 的 violations 计数就是从这些 tag 算的）',
    )

    // ---- 5. 干净回报 + final：卡推到 review
    const good = await tools.report(
      {
        taskId: 't1',
        summary: 'X 成立，来源见 evidence',
        findings: [{ text: 'A 支持 X' }],
        evidence: [
          { url: 'https://example.com/a', quote: '原文摘录' },
          { url: 'https://example.com/b', quote: '第二处原文' },
        ],
        confidence: 'medium',
        final: true,
      },
      CHILD,
    )
    assert.equal(good.ok, true)
    assert.deepEqual(good.violations, [])
    assert.equal(good.status, 'review')

    const { card: reviewed, records: reviewedRecords } = await board.getCard('t1')
    assert.equal(reviewed.status, 'review')
    assert.ok(reviewedRecords.filter((record) => record.kind === 'finding').length >= 2, '两次报告的发现都要在板上')

    // ---- 6. deck v2：真 buildDeck 反映「待验收」与违规
    const deck = await buildDeck({ board, ledger, rootId: ROOT_ID })
    assert.equal(deck.version, 2)
    assert.equal(deck.cards.length, 1)
    assert.equal(deck.cards[0].id, 't1')
    assert.equal(deck.cards[0].status, 'review')
    assert.equal(deck.cards[0].priority, 'P1')
    assert.equal(deck.cards[0].assignee.name, 'worker-a')
    assert.equal(deck.counts.review, 1)
    assert.ok(deck.counts.violations > 0, '违规计数必须进 deck')
    assert.ok(deck.cards[0].counts.violations > 0, '违规也要按卡计数')
    assert.ok(deck.recent.length > 0, 'deck 必须带最近记录')

    // 快照按宿主约定落盘（同步路径：<cwd>/.agent-master/<rootId>/deck.json）
    const deckDir = join(dir, '.agent-master', ROOT_ID)
    await mkdir(deckDir, { recursive: true })
    const deckFile = join(deckDir, 'deck.json')
    await writeFile(deckFile, JSON.stringify(deck), 'utf8')
    const roundTrip = JSON.parse(await readFile(deckFile, 'utf8'))
    assert.equal(roundTrip.version, 2)
    assert.equal(roundTrip.cards[0].status, 'review')

    // ---- 7. master 验收：review → done（master 才能做）
    await assert.rejects(
      () =>
        tools.boardTool(
          { op: 'accept', cardId: 't1', verdict: 'accept', experienceNone: true, reason: '子对话不能自己验收' },
          CHILD,
        ),
      /只有 master|master 会话/,
      '子对话不得自己验收（大师兄也不行）',
    )
    const accepted = await tools.boardTool(
      {
        op: 'accept',
        cardId: 't1',
        verdict: 'accept',
        reason: '来源齐、结论可复核',
        experience: {
          title: '通报类任务必须给两条以上可核对来源',
          lesson: '一条来源撑不住结论，子对话自己就能发现证据不足并补第二条',
          root_cause: '契约里只写了「带来源」，没写条数下限',
          fix: 'acceptance 里直接写「至少 2 条来源」',
          tags: ['handoff'],
        },
      },
      MASTER,
    )
    assert.equal(accepted.verdict, 'accept')
    assert.equal(accepted.card.status, 'done')

    // 验收必须沉淀经验（T12 第 1 条），且真的写进了经验库
    assert.ok(accepted.experience && accepted.experience.entry, 'accept 必须返回落盘的经验条目')
    const hits = await env.experience.query({ q: '可核对来源' })
    assert.equal(hits.length, 1, '经验必须能被检索到')
    assert.match(hits[0].lesson, /一条来源撑不住结论/)

    const finalDeck = await buildDeck({ board, ledger, rootId: ROOT_ID })
    assert.equal(finalDeck.counts.done, 1)
    assert.equal(finalDeck.counts.review, 0)

    // ---- 8. 门禁：无关的旧工具/handoff 纯函数仍然认得这份回报
    const { report } = validateReport({
      taskId: 't1',
      summary: 'X 成立',
      findings: [{ text: 'A 支持 X' }],
      evidence: [{ url: 'https://example.com/a', quote: '原文摘录' }],
      confidence: 'high',
    })
    const bound = bindReportToLedger({ ledger, entry, report })
    assert.deepEqual(bound.violations, [])

    // ---- 9. 回收：master_collect 能按卡分组看到结果（真实数据）
    const collected = await tools.collect({ waitMs: 0 }, MASTER)
    assert.equal(collected.children.length, 1)
    assert.equal(collected.children[0].cardId, 't1')
    assert.equal(collected.children[0].status, 'done')
    assert.match(collected.children[0].summary, /X 成立/)
  } finally {
    await rm(env.dir, { recursive: true, force: true })
  }
})
