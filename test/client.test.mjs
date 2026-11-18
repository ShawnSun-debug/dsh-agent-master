/**
 * client/client.js（deck v2）测试：纯函数 + 卡片渲染 + 旧快照占位 + 轮询兜底。
 *
 * client.js 是**经典脚本**（非 ESM），这里先用 new Function 在宿主 realm 里执行顶层脚本，
 * 捕获 window.__ModuleLoader__.load 的工厂，再以假 require（只用 'react'）materialize。
 * 不渲染真实 DOM，不依赖浏览器。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const CLIENT_FILE = join(ROOT, 'client', 'client.js')

/** 票面空态文案（v2 起同时提到批量派发）。 */
const EMPTY_TEXT = '还没有下派任何子对话 —— 在主对话里用 master_dispatch / master_assign 开一路'

/** 执行 client.js 顶层脚本并 materialize 工厂。 */
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
  new Function('window', source)(fakeWindow)
  assert.equal(entries.length, 1, '顶层必须恰好调用一次 window.__ModuleLoader__.load')
  const [entry] = entries
  const react = {
    createElement(type, props) {
      return { type, props: props ?? {}, children: Array.prototype.slice.call(arguments, 2) }
    },
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useEffect() {},
  }
  const requireStub = (id) => {
    if (id === 'react') return react
    throw new Error('测试未预期的模块：' + id)
  }
  return { entry, exported: entry.factory(requireStub) }
}

const { exported: client } = loadClient()

/** 造一份合法的 deck v2 快照。 */
function makeDeck(overrides = {}) {
  return {
    version: 2,
    revision: 7,
    updatedAt: 1_700_000_000_000,
    cards: [
      {
        id: 't1',
        label: '看板数据层',
        status: 'doing',
        priority: 'P1',
        rev: 3,
        assignee: { sessionId: 'session-a', name: 'worker-a' },
        sessionId: 'session-a',
        counts: { findings: 2, sources: 1, artifacts: 0, violations: 0 },
        updatedAt: 1_700_000_000_000,
      },
    ],
    counts: { cards: 1, records: 4, violations: 0, todo: 0, assigned: 0, doing: 1, review: 0, done: 0, blocked: 0 },
    recent: [{ seq: 4, kind: 'card_status', cardId: 't1', title: 'assigned → doing' }],
    ...overrides,
  }
}

/** 深度遍历 createElement 树。 */
function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit)
    return
  }
  visit(node)
  if (Array.isArray(node.children)) {
    for (const child of node.children) walk(child, visit)
  }
}

/** 渲染 DeckPanel 并返回 element 树。 */
function renderPanel(state, extraProps = {}) {
  const panel = findComponent('DeckPanel')
  const props = {
    sessionId: 's1',
    useProjection: () => state,
    ...extraProps,
  }
  return panel(props)
}

/** 按函数名找一个组件（createElement 的 type 就是组件函数本身）。 */
function findComponent(name) {
  // DeckPanel 没有导出，但通过 seat 注册能拿到它的引用
  const seats = []
  const ctx = makeClientCtx({ seats })
  client.apply(ctx)
  const panel = seats.find(
    (seat) => seat.options && seat.options.name === 'sidebar.right.pane.tab' && seat.options.key === 'agent-master:deck',
  )
  assert.ok(panel, '指挥台正文必须注册在 sidebar.right.pane.tab 座位')
  return panel.Component
}

/** 假 client ctx：记录座位注册、装配阶段的两段式注册。 */
function makeClientCtx({ seats = [] } = {}) {
  const effects = []
  const tabs = []
  const names = []
  const ctx = {
    slots: {
      register(options, Component) {
        seats.push({ options, Component })
        return () => {}
      },
      // 官方语义：slot 出现时才执行回调，回调里再做 register
      inject(_name, fn) {
        return typeof fn === 'function' ? fn() : {}
      },
    },
    sidebarRightTabs: {
      register(options) {
        tabs.push(options)
        return () => {}
      },
    },
    locale: {
      register(ns, dict) {
        names.push({ ns, dict })
        return () => {}
      },
    },
    sessions: {
      current() {
        return null
      },
    },
    effect(fn) {
      effects.push(fn)
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    get(name) {
      if (name === 'sidebarRightTabs') return ctx.sidebarRightTabs
      if (name === 'remote') return null
      if (name === 'sessions') return ctx.sessions
      return undefined
    },
    on() {
      return () => {}
    },
  }
  return ctx
}

// ---------------------------------------------------------------------------
// 六种状态：文案与色调都各不相同（可区分）
// ---------------------------------------------------------------------------

test('client：六种状态各有中文徽标，且文案互不相同', async () => {
  const statuses = ['todo', 'assigned', 'doing', 'review', 'done', 'blocked']
  const labels = statuses.map((status) => client.statusLabel(status))
  assert.deepEqual(labels, ['待认领', '已认领', '开工中', '待验收', '已完成', '阻塞'])
  assert.equal(new Set(labels).size, 6)
})

test('client：六种状态的色调互不相同（样式可区分）', async () => {
  const statuses = ['todo', 'assigned', 'doing', 'review', 'done', 'blocked']
  const tones = statuses.map((status) => client.statusTone(status))
  assert.equal(new Set(tones).size, 6, '六种状态必须落在六种色调上')
  const colors = tones.map((tone) => client.toneColors[tone])
  assert.equal(new Set(colors).size, 6, '六种色调必须映射到六种颜色')
  for (const color of colors) assert.match(color, /^#[0-9a-f]{6}$/i)
})

test('client：未知状态不抛错，退化成中性色调与原样文案', async () => {
  assert.equal(client.statusLabel('正在思考'), '正在思考')
  assert.equal(client.statusTone('正在思考'), 'muted')
  assert.equal(client.statusLabel(''), '未知')
  assert.equal(client.statusTone(undefined), 'muted')
})

// ---------------------------------------------------------------------------
// 认领者与 P 级可见
// ---------------------------------------------------------------------------

test('client：viewModel 暴露认领者、P 级、rev 与计数', async () => {
  const model = client.viewModel(makeDeck())
  assert.equal(model.empty, false)
  assert.equal(model.incompatible, false)
  assert.equal(model.revision, 7)
  assert.equal(model.cards.length, 1)
  const card = model.cards[0]
  assert.equal(card.id, 't1')
  assert.equal(card.label, '看板数据层')
  assert.equal(card.status, 'doing')
  assert.equal(card.statusText, '开工中')
  assert.equal(card.priority, 'P1')
  assert.equal(card.rev, 3)
  assert.equal(card.assigneeName, 'worker-a')
  assert.equal(card.findings, 2)
  assert.equal(card.violations, 0)
})

test('client：未认领的卡显示为空认领者（不显示 undefined）', async () => {
  const deck = makeDeck()
  deck.cards[0].assignee = null
  const card = client.viewModel(deck).cards[0]
  assert.equal(card.assigneeName, '')
})

test('client：渲染出的卡片行带 data-status，并显示 P 级与认领者', async () => {
  const tree = renderPanel(makeDeck())
  const rows = []
  walk(tree, (node) => {
    if (typeof node.type === 'function' && node.type.name === 'CardRow') rows.push(node)
  })
  assert.equal(rows.length, 1)
  const rendered = rows[0].type(rows[0].props)
  assert.equal(rendered.props['data-status'], 'doing')
  const flat = JSON.stringify(rendered)
  assert.match(flat, /优先级 P1/)
  assert.match(flat, /认领者 worker-a/)
  assert.match(flat, /rev 3/)
})

// ---------------------------------------------------------------------------
// 旧契约（v1）→ 占位，不抛错
// ---------------------------------------------------------------------------

test('client：v1 旧快照 → 占位提示，不抛错也不渲染半截数据', async () => {
  const v1 = { headSeq: 3, children: [{ name: 'a', status: 'assigned' }], counts: { tasks: 1 } }
  const model = client.viewModel(v1)
  assert.equal(model.incompatible, true)
  assert.equal(model.empty, false)
  assert.deepEqual(model.cards, [])
  assert.match(model.placeholderText, /旧契约|v1/)

  // 渲染也不抛错，并且给出占位区块
  const tree = renderPanel(v1)
  const flat = JSON.stringify(tree)
  assert.match(flat, /incompatible/)
  assert.match(flat, /旧契约/)
})

test('client：没有 version 的历史对象同样按不兼容处理', async () => {
  assert.equal(client.viewModel({ children: [] }).incompatible, true)
  assert.equal(client.viewModel({ version: 3, cards: [] }).incompatible, true)
})

// ---------------------------------------------------------------------------
// 空态 / 计数 / 时间线
// ---------------------------------------------------------------------------

test('client：null 状态 → 空态文案（票面逐字）', async () => {
  const model = client.viewModel(null)
  assert.equal(model.empty, true)
  assert.equal(model.emptyText, EMPTY_TEXT)
  assert.equal(client.constants.EMPTY_TEXT, EMPTY_TEXT)
})

test('client：顶部计数来自 v2 counts（卡片/在做/待验收/违规/记录）', async () => {
  const deck = makeDeck({ counts: { cards: 3, records: 9, violations: 2, doing: 1, review: 1 } })
  const items = client.countItems(deck.counts)
  assert.deepEqual(items.map((item) => item.key), ['cards', 'doing', 'review', 'violations', 'records'])
  assert.equal(items.find((item) => item.key === 'cards').value, 3)
  assert.equal(items.find((item) => item.key === 'violations').value, 2)
})

test('client：违规 > 0 时给出提示条', async () => {
  const model = client.viewModel(makeDeck({ counts: { cards: 1, records: 1, violations: 3 } }))
  assert.equal(model.alert.level, 'danger')
  assert.match(model.alert.text, /3 处违规/)
})

test('client：时间线只留最新 RECENT_LIMIT 条并按 seq 倒序', async () => {
  const recent = []
  for (let index = 1; index <= 20; index += 1) {
    recent.push({ seq: index, kind: 'finding', cardId: 't1', title: '第' + index + '条' })
  }
  const model = client.viewModel(makeDeck({ recent }))
  assert.equal(model.recent.length, client.constants.RECENT_LIMIT)
  assert.equal(model.recent[0].seq, 20)
  assert.equal(model.recent[model.recent.length - 1].seq, 9)
})

test('client：kind 标签覆盖 v2 新增的 card_status / migrated', async () => {
  assert.equal(client.kindLabel('card_status'), '状态变更')
  assert.equal(client.kindLabel('migrated'), '迁移')
  assert.equal(client.kindLabel('自定义'), '自定义')
})

// ---------------------------------------------------------------------------
// 快照读取：路径、包装形状、坏数据
// ---------------------------------------------------------------------------

test('client：快照路径与宿主约定一致（.agent-master/<rootId>/deck.json）', async () => {
  assert.equal(client.deckRelativePath('session-root'), '.agent-master/session-root/deck.json')
  // 非法字符按宿主 sanitizeRootId 同规则替换
  assert.equal(client.deckRelativePath('a/b c'), '.agent-master/a-b-c/deck.json')
  assert.equal(client.constants.DECK_VERSION, 2)
})

test('client：parseDeckText 接受本体与 { deck } 两种形状，坏 JSON 返回 null', async () => {
  const deck = makeDeck()
  assert.equal(client.parseDeckText(JSON.stringify(deck)).version, 2)
  assert.equal(client.parseDeckText(JSON.stringify({ deck })).version, 2)
  assert.equal(client.parseDeckText('{ 坏'), null)
  assert.equal(client.parseDeckText(''), null)
  assert.equal(client.parseDeckText(null), null)
})

// ---------------------------------------------------------------------------
// 轮询兜底：changes 流不可用时仍能刷新
// ---------------------------------------------------------------------------

test('client：changes 流开不起来时退回轮询，仍能刷新到状态变化', async () => {
  let reads = 0
  const remote = {
    workspaceFiles: {
      read() {
        reads += 1
        // 第一次读到 todo，之后读到 doing —— 证明轮询确实把新状态刷进来了
        const deck = makeDeck()
        deck.cards[0].status = reads > 1 ? 'doing' : 'todo'
        return { ok: true, value: { text: JSON.stringify(deck) } }
      },
      changes() {
        throw new Error('这个宿主没有 changes 流')
      },
    },
  }
  const seen = []
  const dispose = client.subscribeDeck(remote, 's1', (value) => seen.push(value))
  assert.equal(typeof dispose, 'function')
  await delay(2400)
  dispose()
  assert.ok(seen.length >= 2, '轮询必须至少刷新一次（间隔 2s）')
  const statuses = seen.map((deck) => deck.cards[0].status)
  assert.ok(statuses.includes('doing'), '轮询必须把状态变化刷进来')
})

// ---------------------------------------------------------------------------
// 铁律：客户端绝不写自定义会话事件（PROGRESS 记过的事故）
// ---------------------------------------------------------------------------

test('client：不写任何自定义会话事件（只读快照 + workspaceFiles）', async () => {
  const source = readFileSync(CLIENT_FILE, 'utf8')
  assert.equal(/session\s*\.\s*append\s*\(/.test(source), false, '不允许调用 session.append')
  assert.equal(/append\(\s*['"]agent-master\//.test(source), false, '不允许追加 agent-master/* 自定义事件')
  // 数据来源只有两条：工作区文件快照 + 官方 workspaceFiles Remote
  assert.match(source, /workspaceFiles/)
  assert.match(source, /deck\.json/)
})

test('client：inject 必须声明 remote / remote.workspaceFiles（真机回归：不声明则面板整片空白）', () => {
  // 宿主 ctx 是服务代理，未声明的服务一访问就抛 without inject；
  // 而且这套 Loader 只认**纯数组**（对象形态会被当成服务名逐个等待，插件永远 pending）。
  assert.ok(Array.isArray(client.inject), 'inject 必须是纯数组')
  for (const name of ['slots', 'sidebarRightTabs', 'locale', 'sessions', 'remote', 'remote.workspaceFiles']) {
    assert.ok(client.inject.includes(name), 'inject 缺 ' + name)
  }
})

test('client：remote.workspaceFiles 访问抛错时不打断面板（真机回归：空白页）', async () => {
  const hostile = {
    get workspaceFiles() {
      throw new Error('cannot get property "remote.workspaceFiles" without inject')
    },
  }
  // 订阅：不许抛到调用方（组件 effect 里抛错会整片空白），并且立刻能 dispose
  const seen = []
  const dispose = client.subscribeDeck(hostile, 'session-a', (value) => seen.push(value))
  assert.equal(typeof dispose, 'function', '订阅必须返回 disposer')
  await delay(20)
  dispose()
  assert.deepEqual(seen, [], '拿不到 Remote 时不该收到数据（靠轮询回退，不伪造数据）')
})
