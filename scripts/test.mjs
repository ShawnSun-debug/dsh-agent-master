#!/usr/bin/env node
/**
 * 测试入口。
 *
 * 这台机器上沙箱进程对 %TEMP% 不可写（mkdtemp 报 EPERM），
 * 而所有测试都用 os.tmpdir() 建临时目录，所以统一把 TEMP/TMP 指到仓内
 * .test-tmp 再跑，避免每条命令手写环境变量。
 */

import { spawn } from 'node:child_process'
import { mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(here)
const tmp = join(root, '.test-tmp')
mkdirSync(tmp, { recursive: true })

const files = readdirSync(join(root, 'test'))
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => join('test', name))

if (files.length === 0) {
  console.error('没有找到任何 test/*.test.mjs')
  process.exit(1)
}

const child = spawn(process.execPath, ['--test', ...files], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, TEMP: tmp, TMP: tmp },
})
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  process.exit(code ?? 1)
})
