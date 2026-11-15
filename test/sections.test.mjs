// test/sections.test.mjs —— 分角色提示词（master playbook / child contract）。
// sections 只产出字符串，不碰 ctx：这里只断言内容纪律与配置数字注入。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULTS } from '../lib/config.js'
import { CHILD_SECTION, MASTER_SECTION, renderSection } from '../lib/sections.js'

test('两个 section 都是非空字符串模板', () => {
  assert.equal(typeof MASTER_SECTION, 'string')
  assert.equal(typeof CHILD_SECTION, 'string')
  assert.ok(MASTER_SECTION.length > 200)
  assert.ok(CHILD_SECTION.length > 200)
  // 模板保留占位符，由 renderSection 注入配置
  assert.ok(MASTER_SECTION.includes('{{maxChildren}}'))
  assert.ok(MASTER_SECTION.includes('{{maxReportBytes}}'))
  assert.ok(CHILD_SECTION.includes('{{maxReportBytes}}'))
})

test('renderSection 把配置数字注入 master section', () => {
  const text = renderSection({ role: 'master', config: { ...DEFAULTS, maxChildren: 7, maxReportBytes: 2048 } })
  assert.ok(text.includes('最多 7 个子对话'), 'master section 应写死 maxChildren 上限')
  assert.ok(text.includes('2048'), 'master section 应写 maxReportBytes')
  assert.equal(text.includes('{{'), false, '渲染后不应残留占位符')
})

test('renderSection 把配置数字注入 child section', () => {
  const text = renderSection({ role: 'child', config: { ...DEFAULTS, maxReportBytes: 4096 } })
  assert.ok(text.includes('4096'), 'child section 应写 maxReportBytes')
  assert.equal(text.includes('{{'), false)
})

test('master section 覆盖：何时拆、拆几个、brief 必填、不塞原文、先看黑板、汇总带引用', () => {
  const text = renderSection({ role: 'master' })
  assert.ok(text.includes('master_assign'))
  assert.ok(text.includes('master_collect'))
  assert.ok(text.includes('master_digest'))
  assert.ok(text.includes('何时拆') || text.includes('该拆'))
  assert.ok(text.includes('goal'), 'brief 必填项要列出 goal')
  assert.ok(text.includes('acceptance'), 'brief 必填项要列出 acceptance')
  assert.ok(text.includes('不得把子对话原文'), '要禁止把子对话原文塞回上下文')
  assert.ok(text.includes('先看黑板'), '要先看黑板再问')
  assert.ok(text.includes('引用'), '汇总必须带引用')
  assert.ok(text.includes(String(DEFAULTS.maxChildren)), '默认配置下也要出现数字')
})

test('master section 写进派发五档阶梯，并强调预算纪律与原文前提', () => {
  const text = renderSection({ role: 'master' })
  // 五档标识全部出现（防回归：漏一档就失败）
  for (const strategy of ['summary', 'original', 'skip', 'escalate', 'board-only']) {
    assert.ok(text.includes(strategy), 'master section 缺少派发档位：' + strategy)
  }
  assert.ok(text.includes('master_digest'), '要指向 master_digest 换成指针')
  assert.ok(text.includes('不要整段转发'), '体积接近预算时不得整段转发')
  assert.ok(text.includes('摘要已经失败过一次才允许发原文'), 'original 档必须有「摘要先失败过」这个前提')
})

test('child section 覆盖：必须 master_report、不得改台账、大结果走 artifacts、冲突写 open_questions', () => {
  const text = renderSection({ role: 'child' })
  assert.ok(text.includes('master_report'))
  assert.ok(text.includes('不得改写'), '子对话不得改写台账约束')
  assert.ok(text.includes('artifacts'), '大结果要走 artifacts')
  assert.ok(text.includes('open_questions'), '发现冲突先写 open_questions')
  assert.ok(text.includes(String(DEFAULTS.maxReportBytes)))
})

test('未知角色报中文错误', () => {
  assert.throws(() => renderSection({ role: 'judge' }), /未知角色/)
  assert.throws(() => renderSection({}), /未知角色/)
})

test('config 缺项时按 DEFAULTS 补齐，renderSection 不接受未知占位符', () => {
  const text = renderSection({ role: 'master', config: {} })
  assert.ok(text.includes(String(DEFAULTS.maxChildren)))
  assert.ok(text.includes(String(DEFAULTS.maxReportBytes)))
})
