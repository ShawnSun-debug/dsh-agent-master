/**
 * dsh-agent-master — 来源聚合（sources）单测（T7）。
 *
 * 记录形状照抄 lib/board.js 的 BoardRecord；lib/tools.js 的 master_report
 * 写 source 时 refs[0]=url|path、body=quote、author.name=子对话名。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { SourcesError, aggregateSources } from '../lib/sources.js'

/**
 * 造一条黑板 source 记录
 * @param {number} seq
 * @param {string} name 作者（子对话）名
 * @param {string} ref url 或 path
 * @param {string} quote 引文
 */
function src(seq, name, ref, quote) {
  return {
    id: 'b' + seq,
    seq,
    ts: 1_700_000_000_000 + seq,
    scope: 'root',
    author: { sessionId: 'sess-' + name, name },
    kind: 'source',
    title: ref,
    body: quote,
    refs: [ref],
    artifact: null,
    tags: ['evidence'],
  }
}

test('sources：空数组返回空清单，不抛错', () => {
  assert.deepEqual(aggregateSources([]), { sources: [], duplicates: 0 })
})

test('sources：同一 url 合并成一条，quotes 记录 quote/by/seq 且字段齐全', () => {
  const out = aggregateSources([
    src(1, 'researcher-a', 'https://example.com/doc', '延迟约 120ms'),
    src(4, 'researcher-b', 'https://example.com/doc', '延迟约 250ms'),
  ])
  assert.equal(out.sources.length, 1)
  assert.equal(out.duplicates, 0)
  const source = out.sources[0]
  assert.deepEqual(Object.keys(source), ['url', 'quotes', 'conflict', 'conflictReason'])
  assert.equal(source.url, 'https://example.com/doc')
  assert.deepEqual(source.quotes, [
    { quote: '延迟约 120ms', by: 'researcher-a', seq: 1 },
    { quote: '延迟约 250ms', by: 'researcher-b', seq: 4 },
  ])
})

test('sources：末尾斜杠、大小写域名、hash 片段与 http/https 归并到同一来源', () => {
  const out = aggregateSources([
    src(1, 'a', 'https://Example.COM/doc/', '同一段引文'),
    src(2, 'b', 'http://example.com/doc', '同一段引文'),
    src(3, 'c', 'HTTP://example.com/doc#section-2', '同一段引文'),
    src(4, 'd', 'https://example.com/doc/#', '同一段引文'),
  ])
  assert.equal(out.sources.length, 1, '四种写法必须归并成一条来源')
  assert.equal(out.sources[0].url, 'https://example.com/doc')
  assert.equal(out.sources[0].quotes.length, 1)
  assert.equal(out.sources[0].conflict, false)
  assert.equal(out.duplicates, 3, '三条重复引文全部计入 duplicates')
})

test('sources：查询串保留——不同查询是不同来源', () => {
  const out = aggregateSources([
    src(1, 'a', 'https://example.com/search?q=one', '甲'),
    src(2, 'b', 'https://example.com/search?q=two', '乙'),
    src(3, 'c', 'https://example.com/search?q=one&page=2', '丙'),
  ])
  assert.equal(out.sources.length, 3)
  assert.deepEqual(
    out.sources.map((source) => source.url),
    [
      'https://example.com/search?q=one',
      'https://example.com/search?q=one&page=2',
      'https://example.com/search?q=two',
    ],
  )
})

test('sources：同一来源不同引文判潜在冲突，并说明只标记不裁判', () => {
  const out = aggregateSources([
    src(1, 'researcher-a', 'https://example.com/doc', '峰值吞吐 1200 rps'),
    src(2, 'researcher-b', 'https://example.com/doc/', '峰值吞吐 900 rps'),
  ])
  const source = out.sources[0]
  assert.equal(source.conflict, true)
  assert.match(source.conflictReason, /2 段不同引文/)
  assert.match(source.conflictReason, /2 路子对话/)
  assert.match(source.conflictReason, /researcher-a、researcher-b/)
  assert.match(source.conflictReason, /不判断哪段准确/)
  // 不裁判：两条引文原样保留，没有谁被挑成「正确」
  assert.deepEqual(source.quotes.map((item) => item.by), ['researcher-a', 'researcher-b'])
})

test('sources：相同引文只留一条并计入 duplicates，引文首尾空白视为同一段', () => {
  const out = aggregateSources([
    src(1, 'a', 'https://example.com/doc', '同一句话'),
    src(2, 'b', 'https://example.com/doc', '同一句话'),
    src(3, 'c', 'https://example.com/doc', '  同一句话  '),
  ])
  const source = out.sources[0]
  assert.equal(source.quotes.length, 1)
  assert.deepEqual(source.quotes[0], { quote: '同一句话', by: 'a', seq: 1 })
  assert.equal(source.conflict, false)
  assert.equal(out.duplicates, 2)
})

test('sources：不同 url 的相同引文不算冲突', () => {
  const out = aggregateSources([
    src(1, 'a', 'https://one.example/doc', '同样的话'),
    src(2, 'b', 'https://two.example/doc', '同样的话'),
  ])
  assert.equal(out.sources.length, 2)
  assert.equal(out.sources.every((source) => source.conflict === false), true)
  assert.equal(out.duplicates, 0, 'duplicates 只统计同一来源内的重复引文')
})

test('sources：排序——引文多的在前，同样多按 url 字典序，且同输入幂等', () => {
  const records = [
    src(1, 'b1', 'https://b.example/1', '乙一'),
    src(2, 'b2', 'https://b.example/1', '乙二'),
    src(3, 'a1', 'https://a.example/2', '甲一'),
    src(4, 'a2', 'https://a.example/2', '甲二'),
    src(5, 'c1', 'https://c.example/3', '丙一'),
  ]
  const out = aggregateSources(records)
  assert.deepEqual(out.sources.map((source) => source.url), [
    'https://a.example/2',
    'https://b.example/1',
    'https://c.example/3',
  ])
  assert.deepEqual(aggregateSources(structuredClone(records)), out, '同一输入必须得到同一输出')
  assert.deepEqual(aggregateSources([...records].reverse()).sources.map((s) => s.url), [
    'https://a.example/2',
    'https://b.example/1',
    'https://c.example/3',
  ], '打乱输入顺序后排序仍由排序规则决定（展示文本可能不同，这里只校验顺序）')
})

test('sources：非 http 的 ref（落盘路径）按路径合并，只去末尾斜杠与 hash', () => {
  const out = aggregateSources([
    src(1, 'a', 'artifacts/notes.md', '同一段引文'),
    src(2, 'b', 'artifacts/notes.md#L3', '同一段引文'),
    src(3, 'c', 'artifacts/notes.md/', '同一段引文'),
  ])
  assert.equal(out.sources.length, 1)
  assert.equal(out.sources[0].url, 'artifacts/notes.md')
  assert.equal(out.duplicates, 2)
})

test('sources：路径大小写不同视为不同来源（只有域名不区分大小写）', () => {
  const out = aggregateSources([
    src(1, 'a', 'Docs/Notes.md', '甲'),
    src(2, 'b', 'docs/notes.md', '乙'),
  ])
  assert.equal(out.sources.length, 2)
})

test('sources：quotes 保持输入顺序；缺作者与缺 seq 时给出占位而非崩溃', () => {
  const anonymous = src(1, 'a', 'https://example.com/doc', '甲')
  anonymous.author = {}
  delete anonymous.seq
  const out = aggregateSources([anonymous, src(2, 'b', 'https://example.com/doc', '乙')])
  assert.deepEqual(out.sources[0].quotes[0], { quote: '甲', by: '（未命名）', seq: null })
  assert.deepEqual(out.sources[0].quotes[1], { quote: '乙', by: 'b', seq: 2 })
})

test('sources：坏记录被跳过，不影响同一批里的有效记录', () => {
  const out = aggregateSources([
    null,
    42,
    { kind: 'source' },
    { kind: 'source', refs: [], body: '有引文没地址' },
    { kind: 'source', refs: ['   '], body: '地址是空白' },
    { kind: 'source', refs: ['https://example.com/doc'], body: '   ' },
    src(1, 'a', 'https://example.com/doc', '有效引文'),
  ])
  assert.deepEqual(out, {
    sources: [{ url: 'https://example.com/doc', quotes: [{ quote: '有效引文', by: 'a', seq: 1 }], conflict: false }],
    duplicates: 0,
  })
})

test('sources：输入不是数组时抛 SourcesError（不静默返回空清单）', () => {
  for (const bad of [null, undefined, {}, 'https://example.com']) {
    assert.throws(
      () => aggregateSources(bad),
      (error) => error instanceof SourcesError && error.name === 'SourcesError' && /需要 source 记录数组/.test(error.message),
      '输入 ' + String(bad) + ' 必须抛 SourcesError',
    )
  }
})
