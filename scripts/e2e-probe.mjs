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
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { dshHome } from '../lib/config.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TMP = join(ROOT, '.test-tmp')
const PROFILE_NAME = 'probe-e2e'
const PROFILE_DIR = join(dshHome(), 'profiles', PROFILE_NAME)
const BROWSER_DIR = join(TMP, 'e2e-browser')
const KEEP = process.argv.includes('--keep')

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
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      logs.push('[console.error] ' + message.params.args.map((arg) => arg.value ?? arg.description ?? arg.type).join(' '))
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
  await send('Page.navigate', { url })
  await sleep(6000)
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    return result.result?.value
  }
  return { child, ws, logs, evaluate }
}

async function main() {
  log('== 独立 profile E2E：指挥台 ==')
  prepareProfile()
  log('  临时 profile：' + PROFILE_DIR)

  let host = null
  let page = null
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
    const parsed = JSON.parse(panel || '{}')
    const text = (parsed.nodes && parsed.nodes[0]) || ''
    check('面板真渲染出正文（不再空白）', text.length > 0, JSON.stringify(text).slice(0, 200))
    check('面板有可读空状态文案', text.includes('指挥台') && (text.includes('还没有下派') || text.includes('看板')), JSON.stringify(text).slice(0, 200))
    check('控制台没有错误', page.logs.length === 0, page.logs.slice(0, 3).join(' | '))
  } finally {
    try { page?.ws?.close() } catch {}
    killTree(page?.child)
    killTree(host?.child)
    if (!KEEP) {
      // 清理失败不算验收失败（进程句柄回收慢），但要如实打出来。
      if (!removeBestEffort(BROWSER_DIR)) log('  注意：浏览器目录没能删干净，可手动删 ' + BROWSER_DIR)
      if (!removeBestEffort(PROFILE_DIR)) log('  注意：临时 profile 没能删干净，可手动删 ' + PROFILE_DIR)
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
