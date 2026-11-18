#!/usr/bin/env node
/**
 * 独立 profile 端到端验收（指挥台真渲染）。
 *
 * 为什么需要它：单测只能证明「纯函数 + 假 ctx」对，证明不了客户端在**真宿主**里
 * 能不能挂上座位、能不能读快照。真实踩过的两个故障（"without inject" 空白、
 * inject 写成对象形态导致插件永远 pending）单测全拦不住，是这里抓到的。
 *
 * 流程：建临时 profile（base + web-app + 本仓库）→ 起 dsh web（随机端口，取打印的
 * token URL）→ 用系统 Chrome/Edge 无头打开 → 点「指挥台」→ 断言面板真渲染、控制台无错。
 *
 * 用法：node scripts/e2e-probe.mjs [--keep]
 *   --keep  保留临时 profile 与浏览器目录（排障用）
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { dshHome } from '../lib/config.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TMP = join(ROOT, '.test-tmp')
// 隔离 DSH_HOME：这场 E2E 建的会话、写的配置全落在仓内临时目录，
// 绝不碰用户 ~/.dsh（否则会在他的桌面端会话列表里冒出测试会话）。
// 想复用真环境排障时设 DSH_E2E_SHARED_HOME=1。
const SHARED_HOME = process.env.DSH_E2E_SHARED_HOME === '1'
const ISOLATED_HOME = join(TMP, 'dsh-home-e2e')
if (!SHARED_HOME) process.env.DSH_HOME = ISOLATED_HOME

const PROFILE_NAME = 'probe-e2e'
const PROFILE_DIR = join(dshHome(), 'profiles', PROFILE_NAME)
const BROWSER_DIR = join(TMP, 'e2e-browser')
const SHOT_FILE = join(TMP, 'deck-panel.png')
const KEEP = process.argv.includes('--keep')
/** --with-data：建真会话 + 写真 deck 快照，验收「有卡片时的渲染与读数」。 */
const WITH_DATA = process.argv.includes('--with-data')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const log = (message) => console.log(message)

/** 杀掉整棵进程树：.cmd 包装层会留下子进程，只 kill 包装层会漏。 */
function killTree(child) {
  if (!child || typeof child.pid !== 'number') return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', shell: false })
      return
    } catch {
      // 退回普通 kill
    }
  }
  try { child.kill() } catch {}
}

/** 尽力删目录：Windows 上浏览器刚退出时句柄还没释放，重试几次。 */
function removeBestEffort(dir) {
  for (let i = 0; i < 6; i += 1) {
    if (!existsSync(dir)) return true
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 2 })
      return true
    } catch {
      // 句柄未释放，稍后再试
    }
  }
  return false
}

/** 收集断言结果，最后统一汇总。 */
const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail })
  log((ok ? '  ok   ' : '  FAIL ') + name + (detail === '' ? '' : ' :: ' + detail))
}

/** 找 dsh CLI：优先环境变量，其次桌面安装目录，最后退回 bin.js。 */
function resolveLauncher() {
  if (typeof process.env.DSH_CLI === 'string' && process.env.DSH_CLI !== '') {
    return { command: process.env.DSH_CLI, args: [], shell: true }
  }
  const exe = process.env.DSH_NODE_EXECUTABLE
  if (typeof exe === 'string' && exe !== '') {
    for (const segment of ['runtime', '']) {
      const cli = join(dirname(exe), 'resources', segment, 'cli', 'bin', 'dsh.cmd')
      if (existsSync(cli)) return { command: cli, args: [], shell: true }
    }
    const install = process.env.DSH_INSTALL_DIR
    if (typeof install === 'string' && existsSync(join(install, 'lib', 'bin.js'))) {
      return { command: exe, args: [join(install, 'lib', 'bin.js')], shell: false }
    }
  }
  throw new Error('找不到 dsh CLI：请设置 DSH_CLI 或 DSH_NODE_EXECUTABLE')
}

/** 建（或刷新）临时 profile：bundle 只留 base + web-app + 本仓库。 */
function prepareProfile() {
  mkdirSync(TMP, { recursive: true })
  mkdirSync(PROFILE_DIR, { recursive: true })
  const pkg = {
    name: 'dsh-profile-' + PROFILE_NAME,
    private: true,
    dependencies: { 'dsh-agent-master': 'link:' + ROOT.replace(/\\/g, '/') },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-agent-master'] } },
  }
  writeFileSync(join(PROFILE_DIR, 'package.json'), JSON.stringify(pkg, null, 2) + '\n', 'utf8')
  writeFileSync(join(PROFILE_DIR, 'cordis.yml'), '[]\n', 'utf8')
  // node_modules 用 junction 指向当前正在用的 profile：@deepseek-ai/* 与依赖一次到位。
  const link = join(PROFILE_DIR, 'node_modules')
  if (existsSync(link)) rmSync(link, { recursive: true, force: true })
  const source = typeof process.env.DSH_PROFILE_DIR === 'string' && process.env.DSH_PROFILE_DIR !== ''
    ? process.env.DSH_PROFILE_DIR
    : join(dshHome(), 'profiles', 'desktop')
  const target = join(source, 'node_modules')
  if (!existsSync(target)) throw new Error('没有可链接的 node_modules：' + target)
  symlinkSync(target, link, 'junction')
}

/** 起 web 宿主，返回 { child, url }；url 里带 token。 */
async function startHost() {
  const launcher = resolveLauncher()
  const env = { ...process.env }
  if (launcher.command.endsWith('.exe')) env.ELECTRON_RUN_AS_NODE = '1'
  // .cmd 走 shell 时不能再给 args 数组（带空格的路径会被拆断，Node 也会弃用告警），
  // 整条命令行交出去，路径自己加引号。
  const rest = ' --profile ' + PROFILE_NAME + ' --no-open --port 0'
  const child = launcher.shell === true
    ? spawn('"' + launcher.command + '"' + rest, { cwd: ROOT, env, shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(launcher.command, [...launcher.args, '--profile', PROFILE_NAME, '--no-open', '--port', '0'], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  let output = ''
  const onData = (chunk) => {
    output += String(chunk)
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)
  for (let i = 0; i < 240; i += 1) {
    const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/)
    if (match) return { child, url: match[0], output }
    if (child.exitCode !== null) break
    await sleep(500)
  }
  throw new Error('宿主没有打印带 token 的 URL：\n' + output.slice(0, 2000))
}

/** 找可驱动的 Chromium（Chrome / Edge）。 */
function resolveBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ].filter((item) => typeof item === 'string' && item !== '')
  for (const item of candidates) if (existsSync(item)) return item
  throw new Error('找不到 Chrome/Edge：请设置 CHROME_PATH')
}

/** 最小 CDP 客户端：够用就好，不引第三方依赖。 */
async function openPage(browserPath, url) {
  mkdirSync(BROWSER_DIR, { recursive: true })
  const port = 9400 + Math.floor(Math.random() * 200)
  const child = spawn(browserPath, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + BROWSER_DIR,
    'about:blank',
  ], { stdio: 'ignore' })

  let target = null
  for (let i = 0; i < 80 && target === null; i += 1) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()
      target = list.find((item) => item.type === 'page') ?? null
    } catch {
      // 浏览器还没起
    }
    if (target === null) await sleep(300)
  }
  if (target === null) throw new Error('CDP target 未就绪')

  const ws = new WebSocket(target.webSocketDebuggerUrl)
  const pending = new Map()
  const logs = []
  const warnings = []
  let nextId = 1
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      const entry = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
      else entry.resolve(message.result)
      return
    }
    if (message.method === 'Runtime.consoleAPICalled') {
      const line = '[console.' + message.params.type + '] ' + message.params.args.map((arg) => arg.value ?? arg.description ?? arg.type).join(' ')
      if (message.params.type === 'error') logs.push(line)
      else warnings.push(line)
    } else if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails
      logs.push('[exception] ' + (details.exception?.description ?? details.text))
    }
  })
  const send = (method, params = {}) => {
    const id = nextId++
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })
  }
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }))
  await send('Page.enable')
  await send('Runtime.enable')
  // 固定一个足够宽的视口：右栏 + 主对话并排时才看得清面板（默认 800x600 会裁字）。
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url })
  await sleep(6000)
  // 首次运行会弹「预览版说明」，它会盖住一切；有就点继续。
  await send('Runtime.evaluate', {
    expression: "(function(){ var b = Array.from(document.querySelectorAll('button')).find(function(e){ return (e.textContent||'').trim() === '继续' }); if (b) { b.click(); return 'DISMISSED' } return 'NONE' })()",
    returnByValue: true,
  })
  await sleep(800)
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    return result.result?.value
  }
  return { child, ws, logs, warnings, evaluate, send }
}

/** 造一份和真快照同形状的 deck v2（字段与 client/client.js viewModel 对齐）。 */
function deckFixture() {
  const now = Date.now()
  return {
    version: 2,
    revision: 42,
    updatedAt: now,
    cards: [
      {
        id: 't1',
        label: '修指挥台空白',
        status: 'done',
        priority: 'P0',
        rev: 3,
        assignee: { sessionId: 'session-aaaa1111', name: 'worker-a' },
        sessionId: 'session-aaaa1111',
        counts: { findings: 3, sources: 2, artifacts: 1, violations: 0 },
        updatedAt: now,
      },
      {
        id: 't2',
        label: '看板数据层',
        status: 'doing',
        priority: 'P1',
        rev: 2,
        assignee: { sessionId: 'session-bbbb2222', name: 'worker-b' },
        sessionId: 'session-bbbb2222',
        counts: { findings: 1, sources: 0, artifacts: 0, violations: 1 },
        updatedAt: now,
      },
      {
        id: 't3',
        label: '文档收尾',
        status: 'review',
        priority: 'P2',
        rev: 5,
        assignee: null,
        sessionId: '',
        counts: { findings: 2, sources: 1, artifacts: 0, violations: 0 },
        updatedAt: now,
      },
    ],
    counts: { cards: 3, records: 9, violations: 1, todo: 0, assigned: 0, doing: 1, review: 1, done: 1, blocked: 0 },
    recent: [{ seq: 9, kind: 'card_status', cardId: 't1', title: 'review → done' }],
  }
}

/**
 * 数据场景：建会话 → 按会话 cwd 写真 deck → 用会话头胶囊打开面板 → 断言卡片渲染。
 * 返回建立的 deck 目录（供清理）；失败时抛错由 main 汇总。
 */
async function runDataScenario(page) {
  await page.evaluate("(function(){ var b = Array.from(document.querySelectorAll('button')).find(function(e){ return (e.textContent||'').indexOf('新会话') >= 0 }); if (b) b.click(); return 'ok' })()")
  await sleep(5000)
  const sessionId = await page.evaluate("(function(){ var n = document.querySelector('[data-conversation-session]'); return n ? n.getAttribute('data-conversation-session') : '' })()")
  check('能建出真会话', typeof sessionId === 'string' && sessionId.startsWith('session-'), String(sessionId))
  if (!sessionId) return null

  const cacheFile = join(dshHome(), 'storages', 'session_projcache', 'sessions', sessionId + '.json')
  let cwd = ''
  try {
    cwd = JSON.parse(readFileSync(cacheFile, 'utf8')).record.identity.cwd
  } catch {
    // 读不到 cwd 就走下面的断言分支
  }
  check('读得到会话工作区', typeof cwd === 'string' && cwd !== '', String(cwd))
  if (!cwd) return null

  const deckDir = join(cwd, '.agent-master', sessionId)
  mkdirSync(deckDir, { recursive: true })
  writeFileSync(join(deckDir, 'deck.json'), JSON.stringify(deckFixture(), null, 2), 'utf8')

  const opened = await page.evaluate("(function(){ var b = document.querySelector('[data-agent-master=\"deck-pill\"]'); if (!b) return 'NO_PILL'; b.click(); return 'CLICKED' })()")
  // 找不到时把现场抖出来，别只报 NO_PILL（排障全靠这段）
  const pillDiag = opened === 'CLICKED'
    ? ''
    : await page.evaluate("JSON.stringify({ markers: Array.from(document.querySelectorAll('[data-agent-master]')).map(function(e){ return e.getAttribute('data-agent-master') }), slots: Array.from(new Set(Array.from(document.querySelectorAll('[data-slot]')).map(function(e){ return e.getAttribute('data-slot') }))).sort() })")
  check('会话头胶囊存在（点开指挥台）', opened === 'CLICKED', String(opened) + (pillDiag ? ' :: ' + pillDiag : ''))
  await sleep(3500)

  const text = await page.evaluate("(function(){ var n = document.querySelector('[data-agent-master=\"deck\"]'); return n ? (n.innerText||'') : '' })()")
  check('面板渲染出真实卡片', typeof text === 'string' && text.includes('修指挥台空白') && text.includes('看板数据层'), JSON.stringify(String(text).slice(0, 220)))
  check('面板显示状态与优先级', typeof text === 'string' && /P0|P1/.test(text) && /进行中|待验收|已完成/.test(text), JSON.stringify(String(text).slice(0, 220)))

  // 截图前按 Esc 关掉宿主自己的浮层（「开始使用」登录提示会正好压在面板中间）
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(600)
  const shotBefore = await screenshot(page)
  if (shotBefore !== null) log('  截图：' + shotBefore)

  // 快照写进去之后胶囊才有数字，tooltip 必须说清 2/3 是什么意思
  const pillTitle = await page.evaluate("(function(){ var b = document.querySelector('[data-agent-master=\"deck-pill\"]'); return b ? (b.getAttribute('title') || '') : '' })()")
  check('胶囊 tooltip 说清数字含义', typeof pillTitle === 'string' && pillTitle.includes('未结案'), String(pillTitle))

  // 实时性：改快照文件，面板必须自己跟上（订阅 changes 或轮询回退），不能要用户刷新页面
  const bumped = deckFixture()
  bumped.revision = 43
  bumped.cards.push({
    id: 't4',
    label: '实时刷新验证',
    status: 'todo',
    priority: 'P3',
    rev: 1,
    assignee: null,
    sessionId: '',
    counts: { findings: 0, sources: 0, artifacts: 0, violations: 0 },
    updatedAt: Date.now(),
  })
  writeFileSync(join(deckDir, 'deck.json'), JSON.stringify(bumped, null, 2), 'utf8')
  let refreshed = false
  let waitedMs = 0
  for (let round = 0; round < 14; round += 1) {
    await sleep(500)
    waitedMs += 500
    const live = await page.evaluate("(function(){ var n = document.querySelector('[data-agent-master=\"deck\"]'); return n ? (n.innerText||'') : '' })()")
    if (typeof live === 'string' && live.includes('实时刷新验证')) {
      refreshed = true
      break
    }
  }
  check('看板变化实时刷到面板（无需刷新页面）', refreshed, refreshed ? '约 ' + waitedMs + 'ms' : '等了 ' + waitedMs + 'ms 仍未更新')

  // 六种状态必须目视可辨（把「六状态配色互不相同」这条人工勾选变成机器判据）
  const six = deckFixture()
  six.revision = 44
  six.cards = ['todo', 'assigned', 'doing', 'review', 'done', 'blocked'].map((status, index) => ({
    id: 's' + (index + 1),
    label: '状态 ' + status,
    status,
    priority: 'P2',
    rev: 1,
    assignee: null,
    sessionId: '',
    counts: { findings: 0, sources: 0, artifacts: 0, violations: 0 },
    updatedAt: Date.now(),
  }))
  writeFileSync(join(deckDir, 'deck.json'), JSON.stringify(six, null, 2), 'utf8')
  await sleep(2500)
  // 色条在状态徽标上（data-tone），卡片容器只有灰底
  const colorsRaw = await page.evaluate("JSON.stringify(Array.from(document.querySelectorAll('[data-agent-master=\"deck\"] [data-card-id] [data-tone]')).map(function (e) { return e.getAttribute('data-tone') + '=' + getComputedStyle(e).color + '/' + getComputedStyle(e).borderLeftColor }))")
  const colors = JSON.parse(colorsRaw || '[]')
  const toneSet = new Set(colors.map((item) => item.split('=')[1]))
  check('六种状态颜色互不相同（目视可辨）', colors.length === 6 && toneSet.size === 6, JSON.stringify(colors).slice(0, 240))

  // 窄面板 + 超长标题：右栏本来就窄，不许横向溢出（溢出就是被裁字，等于看不见）
  const narrow = deckFixture()
  narrow.revision = 45
  narrow.cards = [{
    id: 't1',
    label: '把这一路的调研结论、证据链、还有那些互相冲突的来源全都写清楚再说一遍',
    status: 'doing',
    priority: 'P1',
    rev: 2,
    assignee: { sessionId: 'session-cccc3333', name: 'worker-with-a-really-long-name' },
    sessionId: 'session-cccc3333',
    counts: { findings: 12, sources: 9, artifacts: 3, violations: 0 },
    updatedAt: Date.now(),
  }]
  writeFileSync(join(deckDir, 'deck.json'), JSON.stringify(narrow, null, 2), 'utf8')
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 800, deviceScaleFactor: 1, mobile: false })
  await sleep(2500)
  const overflow = await page.evaluate("(function(){ var n = document.querySelector('[data-agent-master=\"deck\"]'); return n ? (n.scrollWidth - n.clientWidth) : -1 })()")
  check('窄面板 + 超长标题不横向溢出', typeof overflow === 'number' && overflow > -1 && overflow <= 1, 'overflow=' + String(overflow) + 'px')

  // 点卡片会尝试打开子会话；假会话号必然打不开，但**绝不能让面板崩掉**
  const clickedCard = await page.evaluate("(function(){ var c = document.querySelector('[data-agent-master=\"deck\"] [data-card-id]'); if (!c) return 'NO_CARD'; c.click(); return 'CLICKED' })()")
  await sleep(1200)
  const alive = await page.evaluate("(function(){ var n = document.querySelector('[data-agent-master=\"deck\"]'); return n ? (n.innerText||'').length : 0 })()")
  check('点卡片不会把面板点崩', clickedCard === 'CLICKED' && typeof alive === 'number' && alive > 20, String(clickedCard) + ' / 剩 ' + String(alive) + ' 字')
  return { deckDir, text }
}

/** 截一张面板图，返回文件路径（给人工/模型看渲染效果）。 */
async function screenshot(page) {
  const shot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  if (!shot || typeof shot.data !== 'string') return null
  writeFileSync(SHOT_FILE, Buffer.from(shot.data, 'base64'))
  return SHOT_FILE
}

async function main() {
  log('== 独立 profile E2E：指挥台 ==')
  prepareProfile()
  log('  临时 profile：' + PROFILE_DIR)

  let host = null
  let page = null
  let scenario = null
  try {
    host = await startHost()
    log('  宿主：' + host.url)
    page = await openPage(resolveBrowser(), host.url)

    const buttons = await page.evaluate("Array.from(document.querySelectorAll('button')).map(function (e) { return (e.textContent || '').trim() })")
    check('客户端已加载（左栏出现指挥台入口）', Array.isArray(buttons) && buttons.includes('指挥台'), JSON.stringify(buttons).slice(0, 160))

    const clicked = await page.evaluate("(function () { var b = document.querySelector('[data-agent-master=\"deck-entry\"]'); if (!b) return 'NO_BUTTON'; b.click(); return 'CLICKED' })()")
    check('点击入口', clicked === 'CLICKED', String(clicked))

    await sleep(2500)
    const panel = await page.evaluate("JSON.stringify({ nodes: Array.from(document.querySelectorAll('[data-agent-master=\"deck\"]')).map(function (e) { return (e.innerText || '').slice(0, 300) }) })")
    if (page.warnings.length > 0) log('  控制台警告：' + page.warnings.slice(0, 4).join(' | '))
    const parsed = JSON.parse(panel || '{}')
    const text = (parsed.nodes && parsed.nodes[0]) || ''
    check('面板真渲染出正文（不再空白）', text.length > 0, JSON.stringify(text).slice(0, 200))
    // 空态必须是「可执行的下一步」：要么指路到会话里的入口（没绑会话），
    // 要么说清怎么开一路（已绑会话）。这正是「打开一片空白、不知道有什么意思」的来源。
    check('空态给出可执行的下一步', text.includes('还没绑定会话') || text.includes('还没有下派任何子对话'), JSON.stringify(text).slice(0, 220))
    check('面板有可读空状态文案', text.includes('指挥台') && (text.includes('还没有下派') || text.includes('看板')), JSON.stringify(text).slice(0, 200))
    check('控制台没有错误', page.logs.length === 0, page.logs.slice(0, 3).join(' | '))

    if (WITH_DATA) {
      scenario = await runDataScenario(page)
      check('数据场景没有新增控制台错误', page.logs.length === 0, page.logs.slice(0, 3).join(' | '))
    }
  } finally {
    try { page?.ws?.close() } catch {}
    killTree(page?.child)
    killTree(host?.child)
    // 只删本脚本造的那份 deck（不动用户真实数据）
    if (scenario && scenario.deckDir) removeBestEffort(scenario.deckDir)
    if (!KEEP) {
      // 清理失败不算验收失败（进程句柄回收慢），但要如实打出来。
      if (!removeBestEffort(BROWSER_DIR)) log('  注意：浏览器目录没能删干净，可手动删 ' + BROWSER_DIR)
      if (!removeBestEffort(PROFILE_DIR)) log('  注意：临时 profile 没能删干净，可手动删 ' + PROFILE_DIR)
      if (!SHARED_HOME) removeBestEffort(ISOLATED_HOME)
    }
  }

  const failed = checks.filter((item) => !item.ok)
  log('')
  log(failed.length === 0 ? '全部通过：' + checks.length + ' 项' : '失败 ' + failed.length + '/' + checks.length + ' 项')
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('E2E 运行失败：' + (error && error.message ? error.message : error))
  process.exit(2)
})
