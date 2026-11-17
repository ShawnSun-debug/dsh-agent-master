#!/usr/bin/env node
/**
 * 重启后体检：把「插件到底有没有在真宿主里跑起来」压缩成一条命令。
 *
 * 只读：不改任何文件、不启动会话。检查的都是**重启后才会产生**的落盘证据，
 * 因此它同时也是「插件是否真的被加载」的判据。
 *
 * 用法：
 *   node scripts/verify-restart.mjs            # 用当前目录当工作区
 *   node scripts/verify-restart.mjs --cwd D:\some\workspace
 *   node scripts/verify-restart.mjs --json     # 机器可读
 */

import { readFile, readdir, stat, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const jsonOut = args.includes('--json')
const cwdArgIndex = args.indexOf('--cwd')
const cwd = cwdArgIndex >= 0 && args[cwdArgIndex + 1] ? resolve(args[cwdArgIndex + 1]) : process.cwd()
const home = homedir()
const dshHome = process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(home, '.dsh')
const profileName = process.env.DSH_PROFILE ?? 'desktop'
const profileDir = join(dshHome, 'profiles', profileName)
const dataDir = join(dshHome, 'agent-master')

const checks = []
function record(id, title, status, detail) {
  checks.push({ id, title, status, detail })
}

async function readText(path) {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function checkProfileWiring() {
  const raw = await readText(join(profileDir, 'package.json'))
  if (raw === null) {
    record('profile', 'profile 存在', 'fail', '找不到 ' + join(profileDir, 'package.json'))
    return
  }
  let pkg
  try {
    pkg = JSON.parse(raw)
  } catch (error) {
    record('profile', 'profile 可解析', 'fail', String(error && error.message))
    return
  }
  const bundles = pkg.dsh?.profile?.bundles ?? []
  record(
    'bundles',
    'dsh.profile.bundles 含 dsh-agent-master',
    bundles.includes('dsh-agent-master') ? 'pass' : 'fail',
    bundles.length + ' 个 bundle',
  )
  const link = pkg.dependencies?.['dsh-agent-master']
  const modulePath = join(profileDir, 'node_modules', 'dsh-agent-master')
  let resolved = null
  try {
    resolved = await realpath(modulePath)
  } catch {
    resolved = null
  }
  record(
    'link',
    'node_modules/dsh-agent-master 指向本仓库',
    resolved ? 'pass' : 'fail',
    resolved ?? ('解析失败：' + (link ?? '(没有依赖项)')),
  )
  // 插件是否被应用侧关过：plugin-operations 是应用自己的开关流水。
  // 桌面应用把它放在 userData 下（%APPDATA%\@deepseek-ai\dsh-desktop\plugin-operations\），
  // 部分安装形态则放在 DSH_HOME 下，两处都探。
  const opsCandidates = [
    process.env.APPDATA ? join(process.env.APPDATA, '@deepseek-ai', 'dsh-desktop', 'plugin-operations', 'operations.jsonl') : null,
    join(dshHome, 'plugin-operations', 'operations.jsonl'),
  ].filter((path) => typeof path === 'string')
  let opsRaw = null
  for (const candidate of opsCandidates) {
    opsRaw = await readText(candidate)
    if (opsRaw !== null) break
  }
  const profileStat = await stat(join(profileDir, 'package.json')).catch(() => null)
  if (opsRaw === null) {
    record('operations', '插件开关流水可读', 'warn', '没有 plugin-operations/operations.jsonl（可能是首次启动）')
    return
  }
  // 桌面应用把记录包在 { runId, operation } 里，target 才是包名
  const entries = opsRaw
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .map((entry) => (entry && entry.operation ? entry.operation : entry))
    .filter((entry) => entry && entry.target === 'dsh-agent-master' && entry.phase !== 'started')
  const last = entries[entries.length - 1]
  if (!last) {
    record('operations', '插件开关流水', 'warn', '还没有针对 dsh-agent-master 的操作记录')
    return
  }
  const when = new Date(last.time ?? Date.now())
  const disabled = last.stage === 'enable' && last.enabled === false
  const profileNewer = profileStat !== null && profileStat.mtimeMs > when.getTime()
  if (!disabled) {
    record('operations', '应用没有禁用插件', 'pass', when.toISOString() + ' ' + String(last.stage) + ' enabled=' + String(last.enabled))
  } else if (profileNewer) {
    record(
      'operations',
      '应用曾禁用插件（已过时）',
      'warn',
      when.toISOString() + ' 被应用关掉过，但 profile/package.json 之后又被改回来了；重启后会以 package.json 为准',
    )
  } else {
    record('operations', '应用没有禁用插件', 'fail', when.toISOString() + ' 应用把插件关掉了（enabled=false）')
  }
}

async function checkMasterRecord() {
  const dir = join(dataDir, 'masters')
  let files = []
  try {
    files = (await readdir(dir)).filter((name) => name.endsWith('.json'))
  } catch {
    files = []
  }
  if (files.length === 0) {
    record('master', 'Master 会话记录', 'fail', '还没有 ' + dir + '/*.json —— 引导没成功（重启后设 DSH_AGENT_MASTER_DEBUG=1 看 stderr）')
    return
  }
  const details = []
  for (const file of files) {
    const raw = await readText(join(dir, file))
    if (raw === null) continue
    try {
      const parsed = JSON.parse(raw)
      details.push(parsed.sessionId + ' @ ' + parsed.cwd)
    } catch {
      details.push(file + '（坏 JSON）')
    }
  }
  record('master', 'Master 会话记录', 'pass', details.join(' | '))
}

async function checkRuntimeArtifacts() {
  const agentMasterDir = join(cwd, '.agent-master')
  let roots = []
  try {
    roots = (await readdir(agentMasterDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    roots = []
  }
  record(
    'deck',
    '指挥台快照（<cwd>/.agent-master/<rootId>/deck.json）',
    roots.length > 0 ? 'pass' : 'warn',
    roots.length > 0
      ? roots.length + ' 个 root：' + roots.slice(0, 3).join(', ') + (roots.length > 3 ? ' …' : '')
      : '还没有：先开一路（master_assign / master_dispatch 或 op=create）',
  )
  const dataDirs = await readdir(dataDir).catch(() => [])
  const withBoard = []
  for (const name of dataDirs) {
    if (!name.startsWith('session-')) continue
    if (await exists(join(dataDir, name, 'board.json'))) withBoard.push(name)
  }
  record(
    'board',
    '看板（<dataDir>/<rootId>/board.json）',
    withBoard.length > 0 ? 'pass' : 'warn',
    withBoard.length > 0 ? withBoard.length + ' 个 root 有 board.json' : '还没有：看板是首次写操作才落盘',
  )
  const experience = await exists(join(agentMasterDir, 'experience.jsonl'))
  record(
    'experience',
    '经验库（<cwd>/.agent-master/experience.jsonl）',
    experience ? 'pass' : 'warn',
    experience ? '已存在' : '还没有：验收（op=accept）时才会写',
  )
}

await checkProfileWiring()
await checkMasterRecord()
await checkRuntimeArtifacts()

if (jsonOut) {
  console.log(JSON.stringify({ cwd, profileDir, dataDir, checks }, null, 2))
} else {
  const icon = { pass: '✅', warn: '⚠️', fail: '❌' }
  console.log('工作区：' + cwd)
  console.log('profile：' + profileDir)
  for (const item of checks) {
    console.log(icon[item.status] + ' ' + item.title + (item.detail ? ' —— ' + item.detail : ''))
  }
  const failed = checks.filter((item) => item.status === 'fail').length
  console.log('')
  console.log(failed === 0 ? '没有硬失败；⚠️ 项按需触发（要真的派一路/验收一次才会出现）。' : failed + ' 项硬失败，先修这些。')
}

process.exitCode = checks.some((item) => item.status === 'fail') ? 1 : 0
