/**
 * lib/master.js 验收：工具白名单规范化、master 记录落盘、ensureMasterSession 的
 * 复用 / 重建 / 重试三条主路径。
 *
 * 纪律：不碰真宿主。ctx 用带调用记录的假对象；临时目录落在 os.tmpdir()
 * （运行前已把 TEMP 指到仓内 .test-tmp），不硬编码系统临时路径。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_CHILD_TOOL_EXTRAS,
  DEFAULT_MASTER_TITLE,
  DEFAULT_MASTER_TOOLS,
  MasterError,
  canonicalDir,
  childAllowList,
  createMasterStore,
  ensureMasterSession,
  isFactoryNotReady,
  parseUnknownTools,
  restrictTools,
  isMissingSessionError,
  normalizeTools,
} from '../lib/master.js'

/** 造临时目录并在最后统一清理（Windows 上 rm 要 force，避免只读残留）。 */
async function withDirs(tag, names, body) {
  const dirs = []
  try {
    const made = {}
    for (const name of names) {
      const dir = await mkdtemp(join(tmpdir(), 'am-' + tag + '-' + name + '-'))
      dirs.push(dir)
      made[name] = dir
    }
    return await body(made)
  } finally {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true })
  }
}

/**
 * 假宿主：记录 agents.create / pinSession / attachSession / rename / restrict 的调用。
 * setup 在 create 内部同步执行，复刻宿主「发布前组合」的时序。
 */
function fakeHost({ failCreate = null, pinFailures = [], registryThrows = null } = {}) {
  const calls = { create: [], pin: [], attach: [], rename: [], restrict: [], workspace: [] }
  let createFailures = 0
  const agents = {
    async create(options) {
      calls.create.push({ sessionId: options.sessionId, meta: options.meta })
      if (failCreate && createFailures < failCreate.times) {
        createFailures += 1
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
      if (registryThrows) throw registryThrows
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

// ---------------------------------------------------------------------------
// 常量与纯函数
// ---------------------------------------------------------------------------

test('master：默认工具集覆盖 master 工具与 read/write/edit/ask_user_question，且不含终端', () => {
  // 只锁「必须在 / 必须不在」：默认集可以继续加 master_* 工具，但绝不能悄悄放进终端
  for (const required of [
    'master_assign',
    'master_report',
    'master_collect',
    'master_board',
    'master_digest',
    'read',
    'write',
    'edit',
    'ask_user_question',
  ]) {
    assert.equal(DEFAULT_MASTER_TOOLS.includes(required), true, '默认集缺 ' + required)
  }
  for (const forbidden of ['pwsh', 'bash', 'run_code', 'terminal', 'glob', 'grep']) {
    assert.equal(DEFAULT_MASTER_TOOLS.includes(forbidden), false, 'master 不该有 ' + forbidden)
  }
  assert.equal(Object.isFrozen(DEFAULT_MASTER_TOOLS), true)
  assert.deepEqual(DEFAULT_CHILD_TOOL_EXTRAS, ['master_report', 'master_board'])
  assert.equal(DEFAULT_MASTER_TITLE, 'Master')
})

test('master：normalizeTools 去空白 / 去重 / 保序，null 表示不限制、空数组表示全限制', () => {
  assert.equal(normalizeTools(undefined), null)
  assert.equal(normalizeTools(null), null)
  assert.deepEqual(normalizeTools([]), [])
  assert.deepEqual(normalizeTools(['read', ' read ', 'write', 'read']), ['read', 'write'])
  // 顺序按首次出现，不做排序
  assert.deepEqual(normalizeTools(['write', 'read']), ['write', 'read'])
})

test('master：normalizeTools 非法输入逐项报错（非数组 / 非字符串 / 空串），文案点名字段', () => {
  assert.throws(
    () => normalizeTools('read'),
    (error) => {
      assert.ok(error instanceof MasterError)
      assert.equal(error.name, 'MasterError')
      assert.match(error.message, /tools 必须是字符串数组，实际收到 "read"/)
      return true
    },
  )
  assert.throws(() => normalizeTools({ length: 1 }), /必须是字符串数组/)
  assert.throws(() => normalizeTools([1]), /每一项都必须是非空字符串，实际收到 1/)
  assert.throws(() => normalizeTools(['  ']), /每一项都必须是非空字符串/)
  // 字段名参数要出现在文案里，方便定位是 assign.tools 还是别的
  assert.throws(() => normalizeTools([''], 'assign.tools'), /assign\.tools 的每一项都必须是非空字符串/)
})

test('master：normalizeTools 上限 32 个，且去重先于计数', () => {
  const exactly = Array.from({ length: 32 }, (_, index) => 'tool-' + index)
  assert.deepEqual(normalizeTools(exactly), exactly)

  const tooMany = [...exactly, 'tool-32']
  assert.throws(
    () => normalizeTools(tooMany),
    (error) => {
      assert.match(error.message, /最多 32 个工具，实际收到 33 个/)
      return true
    },
  )
  // 40 个重复名去重后只剩一个，不该被当成超限
  assert.deepEqual(normalizeTools(Array.from({ length: 40 }, () => 'read')), ['read'])
})

test('master：childAllowList 自动补交接工具、不重复、不改调用方数组，null 透传', () => {
  assert.equal(childAllowList(null), null)
  // 即使 master 想全限制，也要留下能回报、能查黑板的两个工具
  assert.deepEqual(childAllowList([]), ['master_report', 'master_board'])
  assert.deepEqual(childAllowList(['read', 'write', 'pwsh']), [
    'read',
    'write',
    'pwsh',
    'master_report',
    'master_board',
  ])
  // 已经点名的交接工具不再追加一遍
  assert.deepEqual(childAllowList(['master_report', 'read']), ['master_report', 'read', 'master_board'])
  // extras 可替换 / 可清空
  assert.deepEqual(childAllowList(['read'], ['master_report']), ['read', 'master_report'])
  assert.deepEqual(childAllowList(['read'], []), ['read'])

  const requested = ['read']
  const result = childAllowList(requested)
  assert.deepEqual(requested, ['read'], '不得往调用方的数组里追加')
  assert.notEqual(result, requested, '必须返回新数组')
})

test('master：isMissingSessionError / isFactoryNotReady 只认该认的形状', () => {
  const unknown = new Error('no such session')
  unknown.name = 'WorkspaceUnknownSessionError'
  const archived = new Error('archived')
  archived.name = 'WorkspaceArchivedSessionPinError'
  assert.equal(isMissingSessionError(unknown), true)
  assert.equal(isMissingSessionError(archived), true)
  assert.equal(isMissingSessionError({ name: 'WorkspaceUnknownSessionError' }), true)
  // 只看 name，不看 message
  assert.equal(isMissingSessionError(new Error('WorkspaceUnknownSessionError')), false)
  assert.equal(isMissingSessionError(new Error('disk full')), false)
  assert.equal(isMissingSessionError(null), false)
  assert.equal(isMissingSessionError(undefined), false)

  assert.equal(isFactoryNotReady(new Error('no agent factory is registered')), true)
  assert.equal(isFactoryNotReady(new Error('NO_FACTORY')), true)
  assert.equal(isFactoryNotReady('NO_FACTORY'), true)
  assert.equal(isFactoryNotReady({ message: 'agent factory missing' }), true)
  assert.equal(isFactoryNotReady(new Error('boom')), false)
  assert.equal(isFactoryNotReady(null), false)
})

// ---------------------------------------------------------------------------
// 记录落盘
// ---------------------------------------------------------------------------

test('master：createMasterStore 按工作区落独立文件，读写往返且是可读 JSON', async () => {
  await withDirs('store', ['store'], async ({ store }) => {
    const storeApi = createMasterStore({ dir: store })
    const a = 'D:/workspace/a'
    const b = 'D:/workspace/b'

    assert.match(storeApi.file(a), /master-[0-9a-f]{16}\.json$/)
    assert.notEqual(storeApi.file(a), storeApi.file(b))
    assert.equal(await storeApi.read(a), null, '没有记录时必须返回 null，不能抛')

    await storeApi.write(a, { sessionId: 'session-1', cwd: a, title: 'Master', at: 1 })
    await storeApi.write(b, { sessionId: 'session-2', cwd: b, title: 'Master', at: 2 })
    assert.equal((await storeApi.read(a)).sessionId, 'session-1')
    assert.equal((await storeApi.read(b)).sessionId, 'session-2')

    // 落盘要格式化过，方便人工排查
    assert.match(await readFile(storeApi.file(a), 'utf8'), /\n  "sessionId": "session-1"/)
  })
})

test('master：createMasterStore 坏 JSON / 缺 sessionId 降级为 null，非法 dir 抛错', async () => {
  await withDirs('store-bad', ['store'], async ({ store }) => {
    const storeApi = createMasterStore({ dir: store })
    const a = 'D:/workspace/a'

    await writeFile(storeApi.file(a), '{ 这不是 JSON', 'utf8')
    assert.equal(await storeApi.read(a), null, '坏 JSON 当作没有记录，别让 master 起不来')

    await writeFile(storeApi.file(a), JSON.stringify({ cwd: a, title: 'Master' }), 'utf8')
    assert.equal(await storeApi.read(a), null, '缺 sessionId 的 JSON 不是有效记录')

    await writeFile(storeApi.file(a), JSON.stringify(['session-x']), 'utf8')
    assert.equal(await storeApi.read(a), null, '数组不是记录')

    await writeFile(storeApi.file(a), JSON.stringify({ sessionId: '' }), 'utf8')
    assert.equal((await storeApi.read(a)).sessionId, '', '形状对就返回：空 sessionId 由调用方决定怎么办')

    // 无参调用时源码先解构参数（当前抛 TypeError，不是 MasterError）：这里只要求「必须报错且提示与 dir 有关」
    assert.throws(() => createMasterStore(), /dir/)
    assert.throws(() => createMasterStore({ dir: '   ' }), MasterError)
    assert.throws(() => createMasterStore({ dir: 5 }), MasterError)
  })
})

// ---------------------------------------------------------------------------
// ensureMasterSession
// ---------------------------------------------------------------------------

test('master：ensureMasterSession 新建时在 setup 里钉白名单、置顶、挂工作区、命名并落盘', async () => {
  await withDirs('ensure-new', ['store', 'ws'], async ({ store, ws }) => {
    const storeApi = createMasterStore({ dir: store })
    const { ctx, calls } = fakeHost()
    const allow = ['master_assign', 'read', 'write']

    const result = await ensureMasterSession({
      ctx,
      allow,
      cwd: ws,
      title: '  指挥官  ',
      store: storeApi,
      retryDelayMs: 0,
    })

    const cwd = await realpath(ws)
    assert.equal(result.created, true)
    assert.equal(result.pinned, true)
    assert.equal(result.cwd, cwd, 'cwd 必须是 realpath，才能和 workspaceRegistry 的比较方式一致')
    assert.equal(await canonicalDir(ws), cwd)
    assert.match(result.sessionId, /^session-[0-9a-f-]{36}$/)

    // create 用 realpath 的 cwd；白名单在 setup（发布前）就挂好
    assert.equal(calls.create.length, 1)
    assert.equal(calls.create[0].sessionId, result.sessionId)
    assert.equal(calls.create[0].meta.cwd, cwd)
    assert.equal(calls.restrict.length, 1)
    assert.equal(calls.restrict[0].sessionId, result.sessionId)
    assert.deepEqual(calls.restrict[0].filter, { allow })
    assert.notEqual(calls.restrict[0].filter.allow, allow, 'setup 里要传副本，后续改 allow 不能影响已发布的会话')

    // 置顶 / 挂工作区 / 命名（标题去空白）
    assert.deepEqual(calls.pin, [result.sessionId])
    assert.deepEqual(calls.attach, [result.sessionId])
    assert.deepEqual(calls.workspace, [cwd])
    assert.deepEqual(calls.rename, [{ sessionId: result.sessionId, title: '指挥官' }])

    // 落盘能读回同一记录
    const saved = await storeApi.read(cwd)
    assert.equal(saved.sessionId, result.sessionId)
    assert.equal(saved.cwd, cwd)
    assert.equal(saved.title, '指挥官')
    assert.equal(typeof saved.at, 'number')
  })
})

test('master：ensureMasterSession 记录可用时复用（经 ctx.get 取服务），不新建第二个会话', async () => {
  await withDirs('ensure-reuse', ['store', 'ws'], async ({ store, ws }) => {
    const cwd = await realpath(ws)
    const storeApi = createMasterStore({ dir: store })
    await storeApi.write(cwd, { sessionId: 'session-existing', cwd, title: 'Master', at: 1 })

    const { ctx, calls } = fakeHost()
    // 真 cordis 的 ctx 用 ctx.get(name) 取服务：service() 必须走这条路
    const viaGet = { get: (name) => ctx[name] }
    const result = await ensureMasterSession({ ctx: viaGet, allow: ['read'], cwd: ws, store: storeApi })

    assert.equal(result.created, false)
    assert.equal(result.sessionId, 'session-existing')
    assert.equal(result.pinned, true)
    assert.deepEqual(calls.pin, ['session-existing'])
    assert.equal(calls.create.length, 0, '复用路径不得再建会话')
    assert.equal(calls.restrict.length, 0, '没有新建 agent 就不该再 restrict')
  })
})

test('master：ensureMasterSession 会话已不在（pin 抛 unknown）时重建并覆盖记录', async () => {
  await withDirs('ensure-missing', ['store', 'ws'], async ({ store, ws }) => {
    const cwd = await realpath(ws)
    const storeApi = createMasterStore({ dir: store })
    await storeApi.write(cwd, { sessionId: 'session-gone', cwd, title: 'Master', at: 1 })

    const missing = new Error('no such session')
    missing.name = 'WorkspaceUnknownSessionError'
    const { ctx, calls } = fakeHost({ pinFailures: [missing] })
    const logs = []

    const result = await ensureMasterSession({
      ctx,
      allow: ['read'],
      cwd: ws,
      store: storeApi,
      log: (message) => logs.push(message),
      retryDelayMs: 0,
    })

    assert.equal(result.created, true)
    assert.notEqual(result.sessionId, 'session-gone')
    assert.equal(result.pinned, true)
    assert.equal(calls.create.length, 1)
    assert.deepEqual(calls.pin, ['session-gone', result.sessionId])
    assert.equal((await storeApi.read(cwd)).sessionId, result.sessionId, '记录要被新会话覆盖')
    assert.deepEqual(logs, [], '会话已不在是正常路径，不该记警告')
  })
})

test('master：ensureMasterSession pin 因非会话缺失失败时记一条日志，仍然重建', async () => {
  await withDirs('ensure-pin-flaky', ['store', 'ws'], async ({ store, ws }) => {
    const cwd = await realpath(ws)
    const storeApi = createMasterStore({ dir: store })
    await storeApi.write(cwd, { sessionId: 'session-old', cwd, title: 'Master', at: 1 })

    const { ctx, calls } = fakeHost({ pinFailures: [new Error('工作区服务抽风')] })
    const logs = []

    const result = await ensureMasterSession({
      ctx,
      allow: ['read'],
      cwd: ws,
      store: storeApi,
      log: (message) => logs.push(message),
      retryDelayMs: 0,
    })

    assert.equal(result.created, true)
    assert.notEqual(result.sessionId, 'session-old')
    assert.equal(calls.create.length, 1)
    assert.equal(logs.length, 1)
    assert.match(logs[0], /复用已有 master 会话时 pin 失败/)
  })
})

test('master：ensureMasterSession 工厂未就绪按 retryTimes 重试；其他错误与重试耗尽都直接抛', async () => {
  // 1) 重试两次后成功
  await withDirs('ensure-retry', ['ws', 'store-ok', 'store-dead', 'store-hard'], async ({ ws, 'store-ok': storeOk, 'store-dead': storeDead, 'store-hard': storeHard }) => {
    const flaky = fakeHost({ failCreate: { times: 2, error: new Error('no agent factory is registered') } })
    const ok = await ensureMasterSession({
      ctx: flaky.ctx,
      allow: ['read'],
      cwd: ws,
      store: createMasterStore({ dir: storeOk }),
      retryTimes: 4,
      retryDelayMs: 0,
    })
    assert.equal(ok.created, true)
    assert.equal(flaky.calls.create.length, 3)
    // 没传 title 时用默认标题
    assert.deepEqual(flaky.calls.rename, [{ sessionId: ok.sessionId, title: DEFAULT_MASTER_TITLE }])

    // 2) 重试耗尽：把最后一次的原错误抛出去
    const dead = fakeHost({ failCreate: { times: 99, error: new Error('NO_FACTORY') } })
    await assert.rejects(
      () => ensureMasterSession({
        ctx: dead.ctx,
        allow: ['read'],
        cwd: ws,
        store: createMasterStore({ dir: storeDead }),
        retryTimes: 3,
        retryDelayMs: 0,
      }),
      /NO_FACTORY/,
    )
    assert.equal(dead.calls.create.length, 3)

    // 3) 非工厂错误一次就抛，不浪费时间重试
    const hard = fakeHost({ failCreate: { times: 99, error: new Error('磁盘满了') } })
    await assert.rejects(
      () => ensureMasterSession({
        ctx: hard.ctx,
        allow: ['read'],
        cwd: ws,
        store: createMasterStore({ dir: storeHard }),
        retryTimes: 5,
        retryDelayMs: 0,
      }),
      /磁盘满了/,
    )
    assert.equal(hard.calls.create.length, 1)
  })
})

test('master：ensureMasterSession 参数缺失给出明确中文错误，不静默降级', async () => {
  await withDirs('ensure-args', ['ws', 'store'], async ({ ws, store }) => {
    const storeApi = createMasterStore({ dir: store })

    await assert.rejects(() => ensureMasterSession(), /ensureMasterSession 需要 ctx/)
    await assert.rejects(
      () => ensureMasterSession({ ctx: {}, allow: ['read'], cwd: ws, store: storeApi }),
      /agents\.create/,
    )
    await assert.rejects(
      () => ensureMasterSession({ ctx: { agents: { create() {} } }, allow: ['read'], cwd: ws, store: storeApi }),
      /workspaceRegistry/,
    )
    await assert.rejects(
      () => ensureMasterSession({ ctx: fakeHost().ctx, allow: [], cwd: ws, store: storeApi }),
      /非空的工具白名单/,
    )
    await assert.rejects(
      () => ensureMasterSession({ ctx: fakeHost().ctx, allow: ['read'], cwd: ws }),
      /需要 store/,
    )
  })
})

test('master：ensureMasterSession 工作区登记失败不阻断会话本身（只记日志）', async () => {
  await withDirs('ensure-registry', ['store', 'ws'], async ({ store, ws }) => {
    const storeApi = createMasterStore({ dir: store })
    const { ctx, calls } = fakeHost({ registryThrows: new Error('工作区服务未就绪') })
    const logs = []

    const result = await ensureMasterSession({
      ctx,
      allow: ['read'],
      cwd: ws,
      store: storeApi,
      log: (message) => logs.push(message),
      retryDelayMs: 0,
    })

    assert.equal(result.created, true)
    assert.equal(result.pinned, true, '归属失败不影响全局置顶')
    assert.equal(calls.attach.length, 0, '没有 workspace 就没得 attach')
    assert.equal(logs.length, 1)
    assert.match(logs[0], /登记 master 工作区失败/)
    assert.equal((await storeApi.read(await realpath(ws))).sessionId, result.sessionId)
  })
})

test('master：agents.create 永久挂起时按超时报错（真机表现为静默卡死）', async () => {
  await withDirs('master', ['ws'], async (dirs) => {
    const store = createMasterStore({ dir: join(dirs.ws, 'masters') })
    const ctx = {
      agents: { create: () => new Promise(() => {}) },
      workspaceRegistry: { async create() { return {} }, async pinSession() {} },
    }
    const startedAt = Date.now()
    await assert.rejects(
      () => ensureMasterSession({ ctx, allow: ['read'], store, cwd: dirs.ws, createTimeoutMs: 40, retryTimes: 1 }),
      (error) => {
        assert.ok(error instanceof MasterError)
        assert.match(error.message, /创建 master 会话超时（40ms 无返回）/)
        return true
      },
    )
    // 不能真的挂住：超时后必须很快返回
    assert.ok(Date.now() - startedAt < 5000)
  })
})

test('master：parseUnknownTools 解析宿主 restrict 报错里的未知工具名', () => {
  const message = 'tools.restrict() names unknown global tools "read", "write"; known global tools: master_board, master_assign'
  assert.deepEqual(parseUnknownTools(message), ['read', 'write'])
  assert.deepEqual(parseUnknownTools('tools.restrict() names unknown global tool "edit"; known global tools: x'), ['edit'])
  assert.deepEqual(parseUnknownTools('some other error'), [])
  assert.deepEqual(parseUnknownTools(undefined), [])
})

test('master：restrictTools 按宿主真实工具表收敛，缺名字不抛错', () => {
  const calls = []
  const logs = []
  const tools = {
    restrict(filter) {
      calls.push([...filter.allow])
      const unknown = filter.allow.filter((name) => !['master_assign', 'master_board'].includes(name))
      if (unknown.length > 0) {
        throw new Error('tools.restrict() names unknown global tools ' + unknown.map((n) => '"' + n + '"').join(', '))
      }
    },
  }
  const applied = restrictTools(tools, ['master_assign', 'master_board', 'read', 'pwsh'], (message) => logs.push(message))
  assert.deepEqual(applied, ['master_assign', 'master_board'])
  assert.deepEqual(calls, [['master_assign', 'master_board', 'read', 'pwsh'], ['master_assign', 'master_board']])
  assert.equal(logs.length, 1)
  assert.match(logs[0], /宿主没有这些全局工具/)
})

test('master：restrictTools 遇到非「未知工具」错误照原样抛，不吞掉', () => {
  const tools = { restrict() { throw new Error('boom') } }
  assert.throws(() => restrictTools(tools, ['read']), /boom/)
})
