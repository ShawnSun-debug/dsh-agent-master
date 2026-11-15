/**
 * client/client.js 的纯函数与座位注册测试。
 *
 * 该文件是**经典脚本**（非 ESM），不能被 import 直接读到导出；因此这里先用
 * new Function 在宿主 realm 里执行顶层脚本，捕获 window.__ModuleLoader__.load
 * 的工厂，再以假 require（只用 'react'）与假 ctx 走真实的 apply 路径。
 * 不渲染 React DOM，不依赖浏览器。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const CLIENT_FILE = join(ROOT, 'client', 'client.js')
const PACKAGE_NAME = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).name

/** 票面指定的空态文案，逐字比对。 */
const EMPTY_TEXT = '还没有下派任何子对话 —— 在主对话里用 master_assign 开一路'

/** 一页能显示的最大记录数（与 client.js 的 RECENT_LIMIT 一致）。 */
const RECENT_LIMIT = 12

/** 执行 client.js 顶层脚本并 materialize 工厂，返回 { entry, exported }。 */
function loadClient() {
  const source = readFileSync(CLIENT_FILE, 'utf8')
  const entries = []
  const fakeWindow = {
    __ModuleLoader__: {
      load(entry) {
        entries.push(entry)
      },
    },
  }
  // 顶层脚本只允许注册工厂；模块体（含 React 组件）都在 factory 内。
  new Function('window', source)(fakeWindow)
  assert.equal(entries.length, 1, '顶层必须恰好调用一次 window.__ModuleLoader__.load')
  const [entry] = entries
  const react = {
    createElement(type, props) {
      return { type, props: props ?? {}, children: Array.prototype.slice.call(arguments, 2) }
    },
  }
  const requireStub = (id) => {
    if (id === 'react') return react
    throw new Error('测试未预期的模块：' + id)
  }
  return { entry, exported: entry.factory(requireStub) }
}

/**
 * 假 client ctx：记录 stage1 的 tab 类型、stage2 的 seat 注册；
 * options.sidebarRight === false 表示右栏服务缺失；
 * options.catalog 模拟父会话的 subagentCatalog 投影（用来验 mode 解析）。
 */
function fakeCtx(options = {}) {
  const withSidebar = options.withSidebar !== false
  const withService = options.sidebarRight !== false
  const tabTypes = []
  const seats = []
  const effects = []
  const opened = []
  const parentSessionId = options.parentSessionId ?? 's1'
  const catalog = options.catalog ?? null
  const ctx = {
    slots: {
      register(seatOptions, Component) {
        seats.push({ options: seatOptions, Component })
        return () => {}
      },
      inject(_seat, factory) {
        return factory()
      },
    },
    sidebarRightTabs: withSidebar
      ? {
          register(definition) {
            tabTypes.push(definition)
            return () => {}
          },
        }
      : undefined,
    locale: { bind: () => (key) => key, register: () => () => {} },
    sessions: {
      list: {
        getSnapshot() {
          return catalog === null
            ? { projectionsBySession: {} }
            : {
                projectionsBySession: {
                  [parentSessionId]: { state: 'ready', values: { subagentCatalog: catalog } },
                },
              }
        },
      },
    },
    effect(fn, label) {
      effects.push(label)
      return fn()
    },
  }
  if (withService) {
    const service = {
      openResource(address, openOptions) {
        opened.push({ address, options: openOptions })
      },
    }
    // 官方客户端插件普遍用 ctx.get 取可选服务（dsh-client-ui-chat/src/client/apply.ts:284），
    // 这里同时给属性与 get() 两条路，覆盖两种解析方式。
    ctx.get = (name) => (name === 'sidebarRight' ? service : undefined)
    ctx.sidebarRight = service
  }
  return { ctx, tabTypes, seats, effects, opened }
}

/** 递归收集假 React 树里的文本；函数组件按 props 展开（本文件的子组件都无 hooks）。 */
function collectText(node, out = [], depth = 0) {
  if (depth > 20 || node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out, depth + 1)
    return out
  }
  if (typeof node === 'object') {
    if (typeof node.type === 'function') {
      collectText(node.type(node.props), out, depth + 1)
      return out
    }
    for (const child of node.children) collectText(child, out, depth + 1)
  }
  return out
}

/** 找到子树里含 needle 文本、且挂了 onClick 的那个元素，返回它的 onClick。 */
function findClickable(node, needle, depth = 0) {
  if (depth > 20 || node === null || node === undefined || node === false) return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findClickable(child, needle, depth + 1)
      if (found) return found
    }
    return null
  }
  if (typeof node !== 'object') return null
  if (typeof node.type === 'function') return findClickable(node.type(node.props), needle, depth + 1)
  const handler = node.props ? node.props.onClick : undefined
  if (typeof handler === 'function' && collectText(node).join(' ').includes(needle)) return handler
  for (const child of node.children || []) {
    const found = findClickable(child, needle, depth + 1)
    if (found) return found
  }
  return null
}

/** 注册真实座位后取出 sidebar.right.pane.tab 的组件与合并了 inject 的 props。 */
function mountPanel(exported, options = {}) {
  const { ctx, seats, opened } = fakeCtx(options.ctx)
  exported.apply(ctx)
  const body = seats.find((entry) => entry.options.name === 'sidebar.right.pane.tab')
  assert.ok(body, '必须注册 sidebar.right.pane.tab 的正文')
  const baseProps = options.props ?? { sessionId: 's1' }
  // 宿主渲染时把 entry.inject 的返回值并进组件 props（scoped-slots.tsx:672）。
  const injected = typeof body.options.inject === 'function' ? body.options.inject(baseProps) : {}
  return { Component: body.Component, props: { ...baseProps, ...injected }, options: body.options, ctx, opened }
}

/** 一条合法子对话卡片状态。 */
function child(overrides) {
  return {
    name: 'worker-1',
    label: '调研 A',
    taskId: 't1',
    sessionId: '',
    status: 'assigned',
    findings: 0,
    evidence: 0,
    artifacts: 0,
    violations: 0,
    ...overrides,
  }
}

test('顶层经典脚本注册工厂，id 等于 package.json name，导出 name/inject', () => {
  const { entry, exported } = loadClient()
  assert.equal(entry.id, PACKAGE_NAME)
  assert.equal(entry.id, 'dsh-agent-master')
  assert.equal(exported.name, 'agent-master-client')
  assert.deepEqual(exported.inject, ['slots', 'sidebarRightTabs', 'locale', 'sessions'])
  assert.equal(typeof exported.apply, 'function')
  assert.equal(typeof exported.chatAddress, 'function')
})

test('两段式注册：stage1 声明 tab 类型，stage2 用同一个 id 当 key', () => {
  const { exported } = loadClient()
  const { ctx, tabTypes, seats } = fakeCtx()
  exported.apply(ctx)

  assert.equal(tabTypes.length, 1)
  const definition = tabTypes[0]
  assert.equal(definition.id, 'agent-master:deck')
  assert.equal(definition.kind, 'agent-master.deck')
  assert.equal(definition.keepMounted, true)
  assert.equal(definition.title(), '指挥台')

  const body = seats.find((entry) => entry.options.name === 'sidebar.right.pane.tab')
  assert.ok(body)
  assert.equal(body.options.key, definition.id, 'stage2 的 key 必须等于 stage1 的 id')
  assert.equal(typeof body.Component, 'function')
})

test('sidebarRightTabs 缺失时退回 shell.overlay', () => {
  const { exported } = loadClient()
  const { ctx, tabTypes, seats } = fakeCtx({ withSidebar: false })
  const originalWarn = console.warn
  console.warn = () => {}
  try {
    exported.apply(ctx)
  } finally {
    console.warn = originalWarn
  }
  assert.equal(tabTypes.length, 0, '没有右栏服务就不该声明 tab 类型')
  assert.ok(
    seats.some((entry) => entry.options.name === 'shell.overlay'),
    '必须退回 shell.overlay 座位',
  )
  assert.ok(!seats.some((entry) => entry.options.name === 'sidebar.right.pane.tab'))
})

test('chatAddress 与官方 subagentChatAddress 同形（sidebar-chat/index.tsx:51-57）', () => {
  const { exported } = loadClient()
  // 官方拼装：前缀 + encodeURIComponent(childSessionId) + '?' + URLSearchParams({parent, mode})
  assert.equal(
    exported.chatAddress({ sessionId: 'child-1', parent: 'master-1', mode: 'continuable' }),
    'dsh-resource://subagentchat/session/child-1?parent=master-1&mode=continuable',
  )
  // 路径段用 encodeURIComponent（空格 %20、斜杠 %2F），查询值走 URLSearchParams（空格变 +）
  assert.equal(
    exported.chatAddress({ sessionId: 'a/b c', parent: 'p 1', mode: 'one-shot' }),
    'dsh-resource://subagentchat/session/a%2Fb%20c?parent=p+1&mode=one-shot',
  )
  // 缺子会话号或父会话号 -> null（渲染层据此不挂点击）
  assert.equal(exported.chatAddress({ sessionId: '', parent: 'master-1', mode: 'continuable' }), null)
  assert.equal(exported.chatAddress({ parent: 'master-1', mode: 'continuable' }), null)
  assert.equal(exported.chatAddress({ sessionId: 'child-1', mode: 'continuable' }), null)
  // mode 缺失或非法 -> 官方默认 continuable（startActivation 子会话，manager.ts:344-346）
  assert.equal(
    exported.chatAddress({ sessionId: 'c', parent: 'p' }),
    'dsh-resource://subagentchat/session/c?parent=p&mode=continuable',
  )
  assert.equal(
    exported.chatAddress({ sessionId: 'c', parent: 'p', mode: 'bogus' }),
    'dsh-resource://subagentchat/session/c?parent=p&mode=continuable',
  )
  // 产物必须能被官方解析器还原（sidebar-chat/index.tsx:64-88）
  const url = new URL(exported.chatAddress({ sessionId: 'child-1', parent: 'master-1', mode: 'continuable' }))
  assert.equal(url.protocol, 'dsh-resource:')
  assert.equal(url.hostname, 'subagentchat')
  assert.deepEqual(url.pathname.split('/').filter(Boolean), ['session', 'child-1'])
  assert.equal(url.searchParams.get('parent'), 'master-1')
  assert.equal(url.searchParams.get('mode'), 'continuable')
})

test('viewModel(null) 返回空态与空态文案', () => {
  const { exported } = loadClient()
  const model = exported.viewModel(null)
  assert.equal(model.empty, true)
  assert.equal(model.emptyText, EMPTY_TEXT)
  assert.equal(model.headSeq, 0)
  assert.equal(model.updatedAt, 0)
  assert.deepEqual(model.counts, { tasks: 0, findings: 0, sources: 0, artifacts: 0, violations: 0 })
  assert.deepEqual(model.children, [])
  assert.deepEqual(model.recent, [])
  assert.equal(model.alert, null)
})

test('status 徽标映射：assigned 灰 / reported 绿 / violated 红，未知状态兜底', () => {
  const { exported } = loadClient()
  assert.equal(exported.statusLabel('assigned'), '已下派')
  assert.equal(exported.statusLabel('reported'), '已回报')
  assert.equal(exported.statusLabel('violated'), '违规')
  assert.equal(exported.statusTone('assigned'), 'muted')
  assert.equal(exported.statusTone('reported'), 'success')
  assert.equal(exported.statusTone('violated'), 'danger')
  // 未知状态不抛错：标签原样透出，色调退回中性。
  assert.equal(exported.statusLabel('paused'), 'paused')
  assert.equal(exported.statusTone('paused'), 'muted')
  assert.equal(exported.statusLabel(undefined), '未知')
})

test('viewModel 透传 counts 与 headSeq', () => {
  const { exported } = loadClient()
  const model = exported.viewModel({
    headSeq: 42,
    updatedAt: 1700000000000,
    counts: { tasks: 3, findings: 5, sources: 2, artifacts: 1, violations: 0 },
    children: [],
    recent: [],
  })
  assert.equal(model.empty, false)
  assert.equal(model.headSeq, 42)
  assert.equal(model.updatedAt, 1700000000000)
  assert.deepEqual(model.counts, { tasks: 3, findings: 5, sources: 2, artifacts: 1, violations: 0 })
  assert.deepEqual(model.countItems.map((item) => item.label), ['任务', '发现', '来源', '产物', '违规'])
  assert.deepEqual(model.countItems.map((item) => item.value), [3, 5, 2, 1, 0])
  assert.equal(model.alert, null, '违规为 0 时不提示')
})

test('recent 超过 12 条时截断，保留最新 12 条（新的在前）', () => {
  const { exported } = loadClient()
  const recent = Array.from({ length: 15 }, (_, index) => ({
    seq: index + 1,
    kind: index % 2 === 0 ? 'finding' : 'source',
    title: '记录' + (index + 1),
  }))
  const model = exported.viewModel({ headSeq: 15, counts: {}, children: [], recent })
  assert.equal(model.recent.length, RECENT_LIMIT)
  assert.deepEqual(
    model.recent.map((item) => item.seq),
    [15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4],
  )
  assert.equal(model.recent[0].title, '记录15')
  assert.equal(model.recent[0].kindLabel, '发现')
  assert.equal(model.recent[11].kindLabel, '来源')
})

test('viewModel 汇总子对话卡片：状态徽标、计数与 sessionId 透传', () => {
  const { exported } = loadClient()
  const model = exported.viewModel({
    headSeq: 7,
    updatedAt: 1,
    counts: { tasks: 1, findings: 2, sources: 0, artifacts: 0, violations: 1 },
    children: [child({ sessionId: 'child-1', status: 'violated', findings: 2, evidence: 1, violations: 1 })],
    recent: [],
  })
  assert.equal(model.children.length, 1)
  const card = model.children[0]
  assert.equal(card.name, 'worker-1')
  assert.equal(card.label, '调研 A')
  assert.equal(card.taskId, 't1')
  assert.equal(card.sessionId, 'child-1', '点击打开子对话要用它')
  assert.equal(card.status, 'violated')
  assert.equal(card.statusText, '违规')
  assert.equal(card.tone, 'danger')
  assert.equal(card.findings, 2)
  assert.equal(card.evidence, 1)
  assert.equal(card.artifacts, 0)
  assert.ok(model.alert !== null, '违规数 > 0 必须在顶部提示')
  assert.match(model.alert.text, /1/)
  // 旧数据没有 sessionId 时归一成空串，渲染层据此不挂点击。
  const legacy = exported.viewModel({ counts: {}, children: [child({})], recent: [] }).children[0]
  assert.equal(legacy.sessionId, '')
})

test('面板组件读 agentMaster 投影，空态渲染空态文案', () => {
  const { exported } = loadClient()
  const { Component, props } = mountPanel(exported)
  const keys = []
  const tree = Component({
    ...props,
    useProjection(key) {
      keys.push(key)
      return null
    },
  })
  assert.deepEqual(keys, ['agentMaster'])
  const text = collectText(tree).join('\n')
  assert.ok(text.includes(EMPTY_TEXT), '空态必须渲染空态文案')
})

test('面板渲染子对话卡片、违规提示与时间线', () => {
  const { exported } = loadClient()
  const { Component, props } = mountPanel(exported)
  const state = {
    headSeq: 9,
    updatedAt: 1,
    counts: { tasks: 1, findings: 1, sources: 1, artifacts: 0, violations: 1 },
    children: [child({ sessionId: 'child-1', status: 'violated', findings: 1, evidence: 1, violations: 1 })],
    recent: [{ seq: 9, kind: 'source', title: '来源：example.com' }],
  }
  const text = collectText(Component({ ...props, useProjection: () => state })).join('\n')
  assert.ok(text.includes('指挥台'), '必须有标题')
  assert.ok(text.includes('worker-1'), '必须列出子对话名')
  assert.ok(text.includes('调研 A'), '必须列出标签')
  assert.ok(text.includes('违规'), '必须出现违规徽标/提示')
  assert.ok(text.includes('来源：example.com'), '必须出现最近记录')
})

test('点击子对话卡片用官方寻址打开 subagentchat tab', () => {
  const { exported } = loadClient()
  const { Component, props, opened } = mountPanel(exported, {
    props: { sessionId: 'master-1' },
    ctx: {
      parentSessionId: 'master-1',
      catalog: [
        { id: 'child-1', mode: 'continuable' },
        { id: 'child-2', mode: 'one-shot' },
      ],
    },
  })
  const state = {
    headSeq: 3,
    updatedAt: 1,
    counts: { tasks: 2, findings: 0, sources: 0, artifacts: 0, violations: 0 },
    children: [
      child({ name: 'worker-1', sessionId: 'child-1', taskId: 't1' }),
      child({ name: 'worker-2', label: '调研 B', sessionId: 'child-2', taskId: 't2' }),
    ],
    recent: [],
  }
  const tree = Component({ ...props, useProjection: () => state })

  const clickFirst = findClickable(tree, 'worker-1')
  assert.equal(typeof clickFirst, 'function', '卡片必须可点击')
  assert.equal(clickFirst(), true)
  // 官方调用形状：openResource(subagentChatAddress(address), { kind:'subagentchat', preferNewPane:true })
  assert.deepEqual(opened[0], {
    address: 'dsh-resource://subagentchat/session/child-1?parent=master-1&mode=continuable',
    options: { kind: 'subagentchat', preferNewPane: true },
  })

  const clickSecond = findClickable(tree, 'worker-2')
  assert.equal(clickSecond(), true)
  // mode 优先取父会话 subagentCatalog 里该子会话的真实模式
  assert.equal(
    opened[1].address,
    'dsh-resource://subagentchat/session/child-2?parent=master-1&mode=one-shot',
  )
})

test('缺 sessionId 或右栏服务时卡片不挂点击、点击也不抛错', () => {
  const { exported } = loadClient()
  const state = {
    headSeq: 1,
    updatedAt: 1,
    counts: {},
    children: [child({ sessionId: 'child-1' })],
    recent: [],
  }

  // (a) 旧数据没有 sessionId：卡片不可点
  const legacy = mountPanel(exported, { props: { sessionId: 'master-1' } })
  const legacyTree = legacy.Component({
    ...legacy.props,
    useProjection: () => ({ ...state, children: [child({ sessionId: '' })] }),
  })
  assert.equal(findClickable(legacyTree, 'worker-1'), null, '没有子会话号就不该挂点击')

  // (b) 有 sessionId 但没有 sidebarRight 服务：点击返回 false，不抛错
  const noService = mountPanel(exported, { props: { sessionId: 'master-1' }, ctx: { sidebarRight: false } })
  const handler = findClickable(
    noService.Component({ ...noService.props, useProjection: () => state }),
    'worker-1',
  )
  assert.equal(typeof handler, 'function')
  const originalWarn = console.warn
  console.warn = () => {}
  try {
    assert.equal(handler(), false)
  } finally {
    console.warn = originalWarn
  }
})

test('client：deckBadge 折出「还没回报/总数」，违规则转危险色', () => {
  const { exported } = loadClient()
  assert.equal(exported.deckBadge(null).text, exported.constants.DECK_TITLE)

  const badge = exported.deckBadge({
    counts: { tasks: 3, findings: 1, sources: 0, artifacts: 0, violations: 0 },
    children: [{ status: 'assigned' }, { status: 'reported' }, { status: 'violated' }],
  })
  assert.equal(badge.total, 3)
  assert.equal(badge.running, 2, 'assigned 与 violated 都算还没回报')
  assert.equal(badge.violated, true)
  assert.equal(badge.tone, 'danger')
  assert.match(badge.text, /2\/3/)

  const allDone = exported.deckBadge({
    counts: { tasks: 1, findings: 1, sources: 0, artifacts: 0, violations: 0 },
    children: [{ status: 'reported' }],
  })
  assert.equal(allDone.running, 0)
  assert.equal(allDone.tone, 'success')
})

test('client：openDeckTab 调 sidebarRight.openTab(TAB_KIND)；服务缺失时返回 false 不抛', () => {
  const { exported } = loadClient()
  const calls = []
  const ctx = {
    get: (name) =>
      name === 'sidebarRight'
        ? {
            openResource() {},
            openTab(kind, options) {
              calls.push({ kind, options })
            },
          }
        : undefined,
  }
  assert.equal(exported.openDeckTab(ctx), true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].kind, exported.constants.TAB_KIND)

  assert.equal(exported.openDeckTab({}), false, '没有服务时优雅降级')

  const thrower = { get: () => ({ openResource() {}, openTab() { throw new Error('boom') } }) }
  assert.equal(exported.openDeckTab(thrower), false, 'openTab 抛错也不能打断渲染')
})

test('client：apply 注册左栏入口与会话头计数两个座位，注入 openDeck', () => {
  const { exported } = loadClient()
  const { ctx, seats } = fakeCtx()
  exported.apply(ctx)

  const entry = seats.find((seat) => seat.options.name === 'sidebar.footer.action')
  assert.ok(entry, '必须注册 sidebar.footer.action（左栏入口）')
  assert.equal(entry.options.id, exported.constants.FOOTER_ACTION_ID)

  const pill = seats.find((seat) => seat.options.name === 'conversation.session.header.utilities')
  assert.ok(pill, '必须注册 conversation.session.header.utilities（会话头计数）')
  assert.equal(pill.options.id, exported.constants.HEADER_UTILITY_ID)

  // 两个座位都要拿到 openDeck 闭包
  for (const seat of [entry, pill]) {
    const injected = seat.options.inject()
    assert.equal(typeof injected.openDeck, 'function')
  }
})

test('client：会话头胶囊渲染出「1/2」并绑定点击；左栏入口点了会调 openTab', () => {
  const { exported } = loadClient()
  const { ctx, seats } = fakeCtx()
  let deckOpened = 0
  // 用真实座位注册，但把 openDeck 计数替换掉，验证点击链路
  const originalApply = exported.apply
  exported.apply(ctx)
  const pillSeat = seats.find((seat) => seat.options.name === 'conversation.session.header.utilities')
  const injected = pillSeat.options.inject({})
  const state = {
    counts: { tasks: 2, findings: 1, sources: 0, artifacts: 0, violations: 0 },
    children: [{ status: 'assigned' }, { status: 'reported' }],
  }
  const pillProps = { ...injected, sessionId: 's1', useProjection: () => state, openDeck: () => { deckOpened += 1 } }
  const pillNode = pillSeat.Component(pillProps)
  const pillText = collectText(pillNode).join(' ')
  assert.match(pillText, /1\/2/, '胶囊应显示 还没回报/总数')

  const pillClick = findClickable(pillNode, '指挥台')
  assert.equal(typeof pillClick, 'function')
  pillClick()
  assert.equal(deckOpened, 1)

  // 左栏入口：纯按钮 + openDeck
  const entrySeat = seats.find((seat) => seat.options.name === 'sidebar.footer.action')
  const entryNode = entrySeat.Component({ ...entrySeat.options.inject({}), openDeck: () => { deckOpened += 1 } })
  assert.equal(collectText(entryNode).join(' '), exported.constants.DECK_TITLE)
  const entryClick = findClickable(entryNode, exported.constants.DECK_TITLE)
  entryClick()
  assert.equal(deckOpened, 2)
})
