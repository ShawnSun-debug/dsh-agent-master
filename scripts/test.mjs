#!/usr/bin/env node
/**
 * 测试入口。
 *
 * 这台机器上有两层沙箱限制：
 * 1. 沙箱进程对 %TEMP% 不可写（mkdtemp 报 EPERM），所以统一把 TEMP/TMP 指到仓内
 *    .test-tmp，避免每条命令手写环境变量；
 * 2. `node --test` 会为每个文件再 spawn 带管道 stdio 的子进程，confined 模式下报 EPERM，
 *    所以这里改成逐文件 `node <file>`（stdio: 'inherit' 是允许的），自己汇总退出码。
 *
 * 测试文件顶层用 node:test 的 test()：直接运行时它同样会执行并输出汇总，
 * 失败时进程退出码非 0。
 */

import { spawnSync } from 'node:child_process'
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

if (files.length === 0) {
  console.error('没有找到任何 test/*.test.mjs')
  process.exit(1)
}

const env = { ...process.env, TEMP: tmp, TMP: tmp }
const failed = []

for (const name of files) {
  console.log('\n===== ' + name + ' =====')
  const child = spawnSync(process.execPath, [join('test', name)], {
    cwd: root,
    stdio: 'inherit',
    env,
  })
  if (child.error) {
    console.error(name + ' 启动失败：' + child.error.message)
    failed.push(name)
    continue
  }
  if (child.signal) {
    console.error(name + ' 被信号终止：' + child.signal)
    failed.push(name)
    continue
  }
  if (child.status !== 0) failed.push(name)
}

console.log('')
if (failed.length > 0) {
  console.error('失败 ' + failed.length + '/' + files.length + ' 个文件：' + failed.join('、'))
  process.exit(1)
}
console.log('全部通过：' + files.length + ' 个测试文件')
process.exit(0)
