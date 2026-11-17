/**
 * T12 经验沉淀（lib/experience.js）验收 + 「仓内不再引用外部记忆插件」的守门测试。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  EXPERIENCE_FILE,
  ExperienceError,
  ExperienceStore,
  globalExperienceDir,
  normalizeTitle,
} from '../lib/experience.js'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))

/** 造一个两级经验库（临时目录）。 */
async function makeStore() {
  const dir = await mkdtemp(join(tmpdir(), 'experience-'))
  const projectDir = join(dir, 'project')
  const globalDir = join(dir, 'global')
  let clock = 1_700_000_000_000
  const store = new ExperienceStore({ projectDir, globalDir, now: () => (clock += 1000) })
  return { dir, store, projectDir, globalDir }
}

const SAMPLE = {
  title: '看板改卡要先读 rev',
  lesson: 'CAS 粒度是单卡 rev，改卡前必须先读卡',
  root_cause: '并行子对话会互相覆盖',
  fix: '先 master_board op=get 拿 rev 再 update',
  tags: ['board', 'cas'],
}

// ---------------------------------------------------------------------------
// 基础 save / 去重 / verified_count
// ---------------------------------------------------------------------------

test('experience：首次 save 建档，verified_count=1，写进项目库', async () => {
  const { store, projectDir } = await makeStore()
  const result = await store.save(SAMPLE)
  assert.equal(result.action, 'created')
  assert.equal(result.entry.verified_count, 1)
  assert.equal(result.entry.scope, 'project')
  assert.deepEqual(result.entry.tags, ['board', 'cas'])
  const raw = await readFile(join(projectDir, EXPERIENCE_FILE), 'utf8')
  assert.equal(raw.trim().split('\n').length, 1)
})

test('experience：同 title 二次 save → verified_count+1、来源卡追加、不新增条目', async () => {
  const { store } = await makeStore()
  await store.save({ ...SAMPLE, sourceCardId: 't1' })
  const second = await store.save({ ...SAMPLE, sourceCardId: 't2' })
  assert.equal(second.action, 'verified')
  assert.equal(second.entry.verified_count, 2)
  assert.deepEqual(second.entry.sources, ['t1', 't2'])
  assert.equal((await store.all()).length, 1)
})

test('experience：title 归一去重（大小写与空白不产生第二条）', async () => {
  const { store } = await makeStore()
  await store.save(SAMPLE)
  const result = await store.save({ ...SAMPLE, title: '  看板改卡要先读   REV  ' })
  assert.equal(result.action, 'verified')
  assert.equal((await store.all()).length, 1)
  assert.equal(normalizeTitle('  A   b  '), 'a b')
})

test('experience：同一来源卡重复出现不重复计入 sources', async () => {
  const { store } = await makeStore()
  await store.save({ ...SAMPLE, sourceCardId: 't1' })
  const second = await store.save({ ...SAMPLE, sourceCardId: 't1' })
  assert.deepEqual(second.entry.sources, ['t1'])
  assert.equal(second.entry.verified_count, 2)
})

// ---------------------------------------------------------------------------
// 两级存储：默认项目级，scope=global 才写用户级；读取合并、项目优先
// ---------------------------------------------------------------------------

test('experience：默认写项目库，scope=global 写用户库', async () => {
  const { store, projectDir, globalDir } = await makeStore()
  await store.save(SAMPLE)
  await store.save({ ...SAMPLE, title: '跨项目通用教训', scope: 'global' })

  const projectRaw = await readFile(join(projectDir, EXPERIENCE_FILE), 'utf8')
  const globalRaw = await readFile(join(globalDir, EXPERIENCE_FILE), 'utf8')
  assert.match(projectRaw, /看板改卡要先读 rev/)
  assert.equal(projectRaw.includes('跨项目通用教训'), false)
  assert.match(globalRaw, /跨项目通用教训/)
  assert.equal(globalRaw.includes('看板改卡要先读 rev'), false)
})

test('experience：读取时两级合并，同 title 项目级内容优先', async () => {
  const { dir, store, projectDir, globalDir } = await makeStore()
  await store.save({ ...SAMPLE, title: '同名教训', lesson: '全局版教训', scope: 'global', sourceCardId: 'g1' })
  await store.save({ ...SAMPLE, title: '同名教训', lesson: '项目版教训', scope: 'project', sourceCardId: 'p1' })

  const entries = await store.all()
  assert.equal(entries.length, 1)
  assert.equal(entries[0].lesson, '项目版教训')
  assert.equal(entries[0].level, 'project')
  // 合并顺序是「项目级先、用户级后」，sources 也按这个顺序累积
  assert.deepEqual(entries[0].sources, ['p1', 'g1'])
  assert.equal(entries[0].verified_count, 2)
  void dir
})

test('experience：globalExperienceDir 跟随 USERPROFILE / DSH_HOME', async () => {
  assert.equal(globalExperienceDir({ USERPROFILE: 'C:\\Users\\x' }).endsWith(join('.dsh', 'agent-master')), true)
  assert.equal(globalExperienceDir({ USERPROFILE: 'C:\\Users\\x', DSH_HOME: 'D:\\home' }).startsWith('D:\\home'), true)
})

// ---------------------------------------------------------------------------
// query / list
// ---------------------------------------------------------------------------

test('experience：query 支持按 tag 与 scope 过滤', async () => {
  const { store } = await makeStore()
  await store.save({ ...SAMPLE, tags: ['board'] })
  await store.save({ ...SAMPLE, title: '另一条', tags: ['tests'], scope: 'global' })

  assert.equal((await store.query({ tag: 'board' })).length, 1)
  assert.equal((await store.query({ tag: 'tests' })).length, 1)
  assert.equal((await store.query({ scope: 'global' })).length, 1)
  assert.equal((await store.query({ scope: 'project' })).length, 1)
  assert.equal((await store.query({})).length, 2)
})

test('experience：query 的关键词覆盖标题/教训/根因/修法', async () => {
  const { store } = await makeStore()
  await store.save(SAMPLE)
  assert.equal((await store.query({ q: 'rev' })).length, 1)
  assert.equal((await store.query({ q: '并行' })).length, 1)
  assert.equal((await store.query({ q: '不存在的词' })).length, 0)
})

test('experience：list 分页并按最近更新倒序', async () => {
  const { store } = await makeStore()
  for (const title of ['一', '二', '三', '四', '五']) {
    await store.save({ ...SAMPLE, title })
  }
  const page1 = await store.list({ limit: 2, offset: 0 })
  const page2 = await store.list({ limit: 2, offset: 2 })
  assert.equal(page1.total, 5)
  assert.equal(page1.items.length, 2)
  assert.equal(page2.items.length, 2)
  assert.deepEqual(page1.items.map((item) => item.title), ['五', '四'])
  assert.deepEqual(page2.items.map((item) => item.title), ['三', '二'])
})

// ---------------------------------------------------------------------------
// 健壮性
// ---------------------------------------------------------------------------

test('experience：坏行被跳过，不影响其余条目', async () => {
  const { store, projectDir } = await makeStore()
  await store.save(SAMPLE)
  const file = join(projectDir, EXPERIENCE_FILE)
  await writeFile(file, (await readFile(file, 'utf8')) + '{ 坏行\n', 'utf8')
  assert.equal((await store.all()).length, 1)
})

test('experience：空 title / 空 lesson / 非法 scope 都报错且不写盘', async () => {
  const { store, projectDir } = await makeStore()
  await assert.rejects(() => store.save({ ...SAMPLE, title: '   ' }), ExperienceError)
  await assert.rejects(() => store.save({ ...SAMPLE, lesson: '' }), ExperienceError)
  await assert.rejects(() => store.save({ ...SAMPLE, scope: 'team' }), /scope 只能是/)
  await assert.rejects(() => stat(join(projectDir, EXPERIENCE_FILE)), /ENOENT/)
})

// ---------------------------------------------------------------------------
// 守门：仓内不再引用任何外部记忆插件
// ---------------------------------------------------------------------------

/** 拼出来写，避免这个测试文件自己命中。 */
const FORBIDDEN = ['memory' + '_save', 'memory' + '_search', 'memory' + '_get', 'memory' + '_list']

/** 递归收集仓内需要检查的文本文件（跳过票据与运行时目录）。 */
async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === '.test-tmp' || entry.name === 'node_modules') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(path)
    else if (/\.(mjs|js|json|md|yml|yaml)$/.test(entry.name)) yield path
  }
}

test('T12 仓内没有任何外部记忆插件的工具引用（票据里的验收文字除外）', async () => {
  const offenders = []
  for await (const file of walk(REPO)) {
    // 票据/地图是规划文档，允许出现「要求 grep 不到 X」这句话本身
    if (file.includes(join(REPO, 'issues'))) continue
    const text = await readFile(file, 'utf8')
    for (const needle of FORBIDDEN) {
      if (text.includes(needle)) offenders.push(file.replace(REPO, '') + ' → ' + needle)
    }
  }
  assert.deepEqual(offenders, [])
})

test('T12 经验库落在 .agent-master/ 下（与指挥台快照同一处约定）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'exp-path-'))
  const store = new ExperienceStore({ projectDir: join(dir, '.agent-master') })
  await store.save(SAMPLE)
  const raw = await readFile(join(dir, '.agent-master', EXPERIENCE_FILE), 'utf8')
  assert.match(raw, /看板改卡要先读 rev/)
  void mkdir
})
