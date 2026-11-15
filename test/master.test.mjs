// test/master.test.mjs —— Master 会话：创建、复用、置顶、标题、工具白名单。
// 纪律：不碰真宿主；ctx 用假对象（记录调用参数），只把 master 记录写进临时目录。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_CHILD_TOOL_EXTRAS,
  DEFAULT_MASTER_TOOLS,
  MasterError,
  canonicalDir,
  childAllowList,
  createMasterStore,
  ensureMasterSession,
  isFactoryNotReady,
  isMissingSessionError,
  normalizeTools,
} from '../lib/master.js'

// ---------------------------------------------------------------------------
// 常量与纯函数
// ---------------------------------------------------------------------------

test('master 默认工具集：5 个 master 工具 + read/write/edit/ask_user_question，且没有终端', () => {
  assert.deepEqual(DEFAULT_MASTER_TOOLS, [
    'master_assign',
    'master_report',
    'master_collect',
    'master_board',
    'master_digest',
    'read',
    'write',
    'edit',
    'ask_user_question',
  ])
  for (const forbidden of ['pwsh', 'bash', 'run_code', 'terminal', 'glob', 'grep']) {
    assert.equal(DEFAULT_MASTER_TOOLS.includes(forbidden), false, 'master 不该有 ' + forbidden)
  }
  assert.deepEqual(DEFAULT_CHILD_TOOL_EXTRAS, ['master_report', 'master_board'])
})

test('normalizeTools：null 表示不限制；去空白去重保序；非法输入抛中文错误', () => {
  assert.equal(normalizeTools(undefined), null)
  assert.equal(normalizeTools(null), null)
  assert.deepEqual(normalizeTools(['read', ' read ', 'write', 'read']), ['read', 'write'])
  assert.throws(() => normalizeTools('read'), /tools 必须是字符串数组/)
  assert.throws(() => normalizeTools([1]), /每一项都必须是非空字符串/)
  assert.throws(() => normalizeTools(['  ']), /每一项都必须是非空字符串/)
  const tooMany = Array.from({ length: 33 }, (_, i) => 't' + i)
  assert.throws(() => normalizeTools(tooMany), /最多 32 个工具/)
})

test('childAllowList：null 不限制；指定白名单时自动补交接工具且不重复', () => {
  assert.equal(childAllowList(null), null)
  assert.deepEqual(childAllowList(['read', 'write', 'pwsh']), [
    'read',
    'write',
    'pwsh',
    'master_report',
    'master_board',
  ])
  // 已经点名的交接工具不会再被追加一遍
  assert.deepEqual(childAllowList(['master_report', 'read']), ['master_report', 'read', 'master_board'])
  assert.deepEqual(childAllowList(['read'], ['master_report']), ['read', 'master_report'])
  assert.deepEqual(childAllowList(['read'], []), ['read'])
})

test('isMissingSessionError / isFactoryNotReady 只认该认的形状', () => {
  const unknown = new Error('nope')
  unknown.name = 'WorkspaceUnknownSessionError'
  const archived = new Error('nope')
  archived.name = 'WorkspaceArchivedSessionPinError'
  assert.equal(isMissingSessionError(unknown), true)
  assert.equal(isMissingSessionError(archived), true)
  assert.equal(isMissingSessionError(new Error('disk full')), false)
  assert.equal(isMissingSessionError(null), false)

  assert.equal(isFactoryNotReady(new Error('no agent factory is registered')), true)
  assert.equal(isFactoryNotReady(new Error('NO_FACTORY')), true)
  assert.equal(isFactoryNotReady(new Error('boom')), false)
})

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

test('createMasterStore：按工作区落独立文件，读回记录；坏文件与缺文件都不抛', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-master-store-'))
  try {
    const store = createMasterStore({ dir })
    const a = 'D:/workspace/a'
    const b = 'D:/workspace/b'
    assert.notEqual(store.file(a), store.file(b))
    assert.equal(await store.read(a), null)

    await store.write(a, { sessionId: 'session-1', cwd: a, title: 'Master', at: 1 })
    const back = await store.read(a)
    assert.equal(back.sessionId, 'session-1')
    assert.equal(await store.read(b), null)

    // 坏 JSON 当作没有记录（不能因为一个损坏文件让 master 起不来）
    await writeFile(store.file(b), '{not json', 'utf8')
    assert.equal(await store.read(b), null)

    // 缺 sessionId 的合法 JSON 也当作没有记录
    await writeFile(store.file(b), JSON.stringify({ cwd: b }), 'utf8')
    assert.equal(await store.read(b), null)

    assert.throws(() => createMasterStore({}), MasterError)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// ensureMasterSession
// ---------------------------------------------------------------------------

/**
 * 假宿主：记录 agents.create / pinSession / attachSession / rename 的调用。
 * setup 在 create 里同步调用，模拟宿主「发布前组合」的时序。
 */
function fakeHost({ failCreate = null, pinFailures = [], registry = true } = {}) {
  const calls = { create: [], pin: [], attach: [], rename: [], restrict: [], workspace: [] }
  let createIndex = 0
  const agents = {
    async create(options) {
      calls.create.push(options)
      if (failCreate && createIndex < failCreate.times) {
        createIndex += 1
        throw failCreate.error
      }
      if (typeof options.setup === 'function') {
        options.setup({
          tools: {
            restrict(filter) {
              calls.restrict.push({ sessionId: options.sessionId, filter })
            },
          },
        })
      }
      return { agent: { session: { id: options.sessionId } } }
    },
  }
  const workspaceRegistry = {
    async create(path) {
      calls.workspace.push(path)
      if (!registry) throw new Error('workspace registry missing')
      return {
        async attachSession(id) {
          calls.attach.push(id)
        },
      }
    },
    async pinSession(id) {
      calls.pin.push(id)
      const failure = pinFailures.shift()
      if (failure) throw failure
    },
  }
  const sessionTitle = {
    rename(session, title) {
      calls.rename.push({ sessionId: session.id, title })
    },
  }
  return { ctx: { agents, workspaceRegistry, sessionTitle }, calls }
}

test('ensureMasterSession：新建 → 白名单钉进 setup → 置顶 → 挂工作区 → 命名 → 落盘', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-master-ensure-'))
  const workspace = await mkdtemp(join(tmpdir(), 'agent-master-ws-'))
  try {
    const store = createMasterStore({ dir })
    const { ctx, calls } = fakeHost()
    const allow = ['master_assign', 'read', 'write']
    const result = await ensureMasterSession({ ctx, allow, cwd: workspace, title: 'Master', store })

    assert.equal(result.created, true)
    assert.equal(result.pinned, true)
    assert.match(result.sessionId, /^session-[0-9a-f-]{36}$/)
    assert.equal(await canonicalDir(workspace), result.cwd)

    // 1) 创建时 cwd 用 realpath，白名单在 setup 里（发布前）就挂好
    assert.equal(calls.create.length, 1)
    assert.equal(calls.create[0].meta.cwd, await canonicalDir(workspace))
    assert.deepEqual(calls.restrict, [{ sessionId: result.sessionId, filter: { allow } }])

    // 2) 置顶 / 挂工作区 / 命名
    assert.deepEqual(calls.pin, [result.sessionId])
    assert.deepEqual(calls.attach, [result.sessionId])
    assert.deepEqual(calls.rename, [{ sessionId: result.sessionId, title: 'Master' }])

    // 3) 落盘可读回
    const saved = await store.read(await canonicalDir(workspace))
    assert.equal(saved.sessionId, result.sessionId)
    assert.equal(saved.cwd, await canonicalDir(workspace))
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})

test('ensureMasterSession：有记录且能置顶 → 复用，不新建第二个会话', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-master-reuse-'))
  const workspace = await mkdtemp(join(tmpdir(), 'agent-master-reuse-ws-'))
  try {
    const cwd = await canonicalDir(workspace)
    const store = createMasterStore({ dir })
    await store.write(cwd, { sessionId: 'session-existing', cwd, title: 'Master', at: 1 })
    const { ctx, calls } = fakeHost()
    const result = await ensureMasterSession({ ctx, allow: ['read'], cwd: workspace, store })

    assert.equal(result.created, false)
    assert.equal(result.sessionId, 'session-existing')
    assert.deepEqual(calls.pin, ['session-existing'])
    assert.equal(calls.create.length, 0)
    assert.equal(calls.restrict.length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})

test('ensureMasterSession：记录里的会话已不在（pin 抛 unknown）→ 重建并覆盖记录', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-master-missing-'))
  const workspace = await mkdtemp(join(tmpdir(), 'agent-master-missing-ws-'))
  try {
    const cwd = await canonicalDir(workspace)
    const store = createMasterStore({ dir })
    await store.write(cwd, { sessionId: 'session-gone', cwd, title: 'Master', at: 1 })
    const missing = new Error('no such session')
    missing.name = 'WorkspaceUnknownSessionError'
    const { ctx, calls } = fakeHost({ pinFailures: [missing] })
    const result = await ensureMasterSession({ ctx, allow: ['read'], cwd: workspace, store })

    assert.equal(result.created, true)
    assert.notEqual(result.sessionId, 'session-gone')
    assert.equal(calls.create.length, 1)
    const saved = await store.read(cwd)
    assert.equal(saved.sessionId, result.sessionId)
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})

test('ensureMasterSession：agent 工厂未就绪时按 retryTimes 重试，就绪后成功', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-master-retry-'))
  const workspace = await mkdtemp(join(tmpdir(), 'agent-master-retry-ws-'))
  try {
    const store = createMasterStore({ dir })
    const { ctx, calls } = fakeHost({
      failCreate: { times: 2, error: new Error('no agent factory is registered') },
    })
    const result = await ensureMasterSession({
      ctx,
      allow: ['read'],
      cwd: workspace,
      store,
      retryTimes: 4,
      retryDelayMs: 0,
    })
    assert.equal(result.created, true)
    assert.equal(calls.create.length, 3)
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})

test('ensureMasterSession：非「工厂未就绪」的错误直接抛，不重试', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-master-throw-'))
  const workspace = await mkdtemp(join(tmpdir(), 'agent-master-throw-ws-'))
  try {
    const store = createMasterStore({ dir })
    const { ctx, calls } = fakeHost({ failCreate: { times: 99, error: new Error('boom') } })
    await assert.rejects(
      () => ensureMasterSession({ ctx, allow: ['read'], cwd: workspace, store, retryTimes: 5, retryDelayMs: 0 }),
      /boom/,
    )
    assert.equal(calls.create.length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})

test('ensureMasterSession：缺 agents / workspaceRegistry / allow 时报明确的中文错误', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-master-args-'))
  try {
    const store = createMasterStore({ dir: await mkdtemp(join(tmpdir(), 'agent-master-args-dir-')) })
    await assert.rejects(() => ensureMasterSession({ store, allow: ['read'], cwd: workspace }), /ctx/)
    await assert.rejects(
      () => ensureMasterSession({ ctx: {}, allow: ['read'], cwd: workspace, store }),
      /agents.create/,
    )
    await assert.rejects(
      () => ensureMasterSession({ ctx: { agents: { create() {} } }, allow: ['read'], cwd: workspace, store }),
      /workspaceRegistry/,
    )
    await assert.rejects(
      () => ensureMasterSession({ ctx: fakeHost().ctx, allow: [], cwd: workspace, store }),
      /白名单/,
    )
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})
