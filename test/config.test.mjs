/**
 * lib/config.js 验收：默认值、未知键、数值下限、工具白名单归一化、路径与环境变量。
 *
 * 只调用纯函数 + 伪造 env 对象：本文件不写盘，也不依赖 TEMP 可写。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

import {
  AgentMasterConfigError,
  DEFAULTS,
  artifactsDir,
  boardFile,
  boardJsonlFile,
  dataRoot,
  dshHome,
  ledgerFile,
  rootDir,
  sanitizeRootId,
  validateConfig,
} from '../lib/config.js'

const ENV = Object.freeze({ DSH_HOME: 'D:/dsh-home' })

test('配置：默认值齐全且被冻结（含 maxCards 与 approvalWaitMs）', () => {
  const config = validateConfig()
  assert.deepEqual({ ...config }, { ...DEFAULTS })
  assert.ok(Object.isFrozen(config))

  assert.equal(config.maxChildren, 4)
  assert.equal(config.maxParallelSearch, 4)
  assert.equal(config.maxCards, 32)
  assert.equal(config.boardMaxEntries, 256)
  assert.equal(config.digestBudgetBytes, 65536)
  assert.equal(config.maxReportBytes, 8192)
  assert.equal(config.approvalWaitMs, 600000)
  assert.equal(config.defaultEnabled, false)
  assert.equal(config.masterEnabled, true)

  // 冻结不是摆设：严格模式下赋值必须抛错，不能悄悄改掉一份「配置」
  assert.throws(() => {
    config.maxChildren = 99
  }, TypeError)
})

test('配置：未知键在加载期报错并点名该键', () => {
  assert.throws(
    () => validateConfig({ maxChildern: 2 }),
    (error) => {
      assert.ok(error instanceof AgentMasterConfigError)
      assert.equal(error.name, 'AgentMasterConfigError')
      assert.match(error.message, /unknown config key: maxChildern/)
      return true
    },
  )
  // 合法键与非法键混在一起时也要报出来，不能被「先赋值」蒙混过去
  assert.throws(() => validateConfig({ maxCards: 8, nope: 1 }), /unknown config key: nope/)
})

test('配置：非对象输入被拒（null / 数组 / 字符串 / 数字）', () => {
  for (const bad of [null, [], 'config', 42]) {
    assert.throws(() => validateConfig(bad), /config must be an object/, JSON.stringify(bad) + ' 必须被拒')
  }
  assert.equal(validateConfig({}).maxCards, 32)
})

test('配置：数值下限逐项生效（maxCards>=1、approvalWaitMs>=0、预算键各有下限）', () => {
  const cases = [
    ['maxChildren', 0, 1],
    ['maxParallelSearch', 0, 1],
    ['maxCards', 0, 1],
    ['boardMaxEntries', 0, 1],
    ['digestBudgetBytes', 1023, 1024],
    ['maxReportBytes', 511, 512],
    ['approvalWaitMs', -1, 0],
  ]
  for (const [key, bad, minimum] of cases) {
    assert.throws(
      () => validateConfig({ [key]: bad }),
      new RegExp(key + ' must be a safe integer >= ' + minimum),
      key + ' 的下限必须生效',
    )
    // 正好等于下限是合法边界值
    assert.equal(validateConfig({ [key]: minimum })[key], minimum, key + ' 的边界值必须放行')
  }
})

test('配置：数值必须是安全整数（小数 / NaN / Infinity / 字符串 / 超界都拒）', () => {
  for (const bad of [1.5, NaN, Infinity, -Infinity, '5', 2 ** 53, true, null]) {
    assert.throws(
      () => validateConfig({ maxCards: bad }),
      /maxCards must be a safe integer >= 1/,
      JSON.stringify(bad) + ' 必须被拒',
    )
  }
  assert.equal(validateConfig({ maxCards: 1 }).maxCards, 1)
  assert.equal(validateConfig({ maxCards: Number.MAX_SAFE_INTEGER }).maxCards, Number.MAX_SAFE_INTEGER)
})

test('配置：布尔、dataDir 与 masterTitle 的类型校验，标题会去空白', () => {
  assert.throws(() => validateConfig({ defaultEnabled: 'yes' }), /defaultEnabled must be a boolean/)
  assert.throws(() => validateConfig({ masterEnabled: 1 }), /masterEnabled must be a boolean/)
  assert.throws(() => validateConfig({ dataDir: '' }), /dataDir must be null or a non-empty string/)
  assert.throws(() => validateConfig({ dataDir: 7 }), /dataDir must be null or a non-empty string/)
  assert.equal(validateConfig({ dataDir: 'D:/custom' }).dataDir, 'D:/custom')

  assert.throws(() => validateConfig({ masterTitle: '   ' }), /masterTitle must be a non-empty string/)
  assert.throws(() => validateConfig({ masterTitle: 3 }), /masterTitle must be a non-empty string/)
  assert.equal(validateConfig({ masterTitle: '  指挥官  ' }).masterTitle, '指挥官')
})

test('配置：masterTools 归一化（去空白 / 去重 / 保序），空数组与非法项报错', () => {
  assert.equal(validateConfig({}).masterTools, null)
  assert.equal(validateConfig({ masterTools: null }).masterTools, null)

  // 去空白 + 去重 + 保持首次出现的位置
  assert.deepEqual(validateConfig({ masterTools: [' read ', 'read', 'write', ' read '] }).masterTools, ['read', 'write'])
  assert.deepEqual(validateConfig({ masterTools: ['write', 'read'] }).masterTools, ['write', 'read'])

  assert.throws(() => validateConfig({ masterTools: [] }), /masterTools must not be empty/)
  assert.throws(() => validateConfig({ masterTools: 'read' }), /masterTools must be null or an array of tool names/)
  assert.throws(
    () => validateConfig({ masterTools: ['read', '  '] }),
    /masterTools must contain only non-empty tool names/,
  )
  assert.throws(
    () => validateConfig({ masterTools: ['read', 1] }),
    /masterTools must contain only non-empty tool names/,
  )
})

test('配置：childToolExtras 允许空数组（表示不补），null 仍表示用默认', () => {
  assert.equal(validateConfig({}).childToolExtras, null)
  assert.deepEqual(validateConfig({ childToolExtras: [] }).childToolExtras, [])
  assert.deepEqual(validateConfig({ childToolExtras: [' read ', 'read', 'pwsh'] }).childToolExtras, ['read', 'pwsh'])
  assert.throws(() => validateConfig({ childToolExtras: 'read' }), /childToolExtras must be null or an array/)
  assert.throws(() => validateConfig({ childToolExtras: [null] }), /childToolExtras must contain only non-empty/)
})

test('配置：dshHome 优先 DSH_HOME，其次 USERPROFILE，最后退 homedir()', () => {
  assert.equal(dshHome({ DSH_HOME: 'D:/dsh-home', USERPROFILE: 'C:/Users/me' }), 'D:/dsh-home')
  // 空串不算设置过
  // DSH_HOME 就是 .dsh 目录本身，退回 USERPROFILE/homedir 时必须补一层 .dsh
  assert.equal(dshHome({ DSH_HOME: '', USERPROFILE: 'C:/Users/me' }), join('C:/Users/me', '.dsh'))
  assert.equal(dshHome({ USERPROFILE: 'C:/Users/me' }), join('C:/Users/me', '.dsh'))
  assert.equal(dshHome({ USERPROFILE: '' }), join(homedir(), '.dsh'))
  assert.equal(dshHome({}), join(homedir(), '.dsh'))
  assert.equal(typeof dshHome(), 'string')
})

test('配置：dataRoot 默认落 DSH_HOME/agent-master，dataDir 覆盖并绝对化', () => {
  const config = validateConfig()
  assert.equal(dataRoot(config, ENV), resolve(join('D:/dsh-home', 'agent-master')))
  assert.equal(dataRoot(validateConfig({ dataDir: 'D:/custom' }), ENV), resolve('D:/custom'))

  // 相对 dataDir 按进程 cwd 绝对化：不会悄悄落在不可预期的位置
  const relativeRoot = dataRoot(validateConfig({ dataDir: 'rel-data' }), ENV)
  assert.equal(relativeRoot, resolve('rel-data'))
  assert.equal(isAbsolute(relativeRoot), true)

  // 没有 DSH_HOME 时 USERPROFILE/.dsh 决定默认位置（与 verify-restart.mjs 同一约定）
  assert.equal(dataRoot(config, { USERPROFILE: 'D:/users/me' }), resolve(join('D:/users/me', '.dsh', 'agent-master')))
})

test('配置：进程里没有 DSH_HOME 时（桌面应用真机形态）数据根仍落在 ~/.dsh/agent-master', () => {
  const config = validateConfig()
  // 桌面应用主进程只有 USERPROFILE（DSH_HOME 只给 shell 子进程），旧实现据此写出
  // C:\Users\charl\agent-master，与体检脚本查的 ~/.dsh/agent-master 分叉。
  const root = dataRoot(config, { USERPROFILE: 'C:\\Users\\charl' })
  assert.equal(root, resolve(join('C:\\Users\\charl', '.dsh', 'agent-master')))
  assert.notEqual(root, resolve(join('C:\\Users\\charl', 'agent-master')), '绝不能落到 USERPROFILE 下的裸 agent-master')
})

test('配置：sanitizeRootId 净化路径穿越与非法字符，空值报错', () => {
  assert.equal(sanitizeRootId('abc-123_X'), 'abc-123_X')
  assert.equal(sanitizeRootId('../../etc/passwd'), '------etc-passwd')
  assert.equal(sanitizeRootId('a/b\\c:d*e?f'), 'a-b-c-d-e-f')
  // 空白也会被净化成 '-'，不会被当成空串
  assert.equal(sanitizeRootId('   '), '---')
  assert.equal(sanitizeRootId(123), '123')

  for (const empty of ['', null, undefined]) {
    assert.throws(() => sanitizeRootId(empty), (error) => {
      assert.ok(error instanceof AgentMasterConfigError)
      assert.match(error.message, /root session id is empty after sanitizing/)
      return true
    })
  }
})

test('配置：穿越型 rootId 净化后仍落在 dataRoot 内（不逃逸）', () => {
  const config = validateConfig()
  const base = dataRoot(config, ENV)
  const dir = rootDir(config, '../../../evil', ENV)
  assert.equal(dir, join(base, sanitizeRootId('../../../evil')))

  const rel = relative(base, dir)
  assert.equal(rel.startsWith('..'), false, 'rootDir 不能逃出 dataRoot')
  assert.equal(isAbsolute(rel), false)
  assert.equal(rel.includes('/'), false)
  assert.equal(rel.includes('\\'), false)
})

test('配置：rootDir 下 board.json / board.jsonl / ledger.jsonl / artifacts 的布局', () => {
  const config = validateConfig()
  const dir = rootDir(config, 'root-1', ENV)
  assert.equal(dir, resolve(join('D:/dsh-home', 'agent-master', 'root-1')))

  // ADR-0001：单文件看板是 board.json；board.jsonl 只是旧黑板，留给迁移读
  assert.equal(boardFile(config, 'root-1', ENV), join(dir, 'board.json'))
  assert.equal(boardJsonlFile(config, 'root-1', ENV), join(dir, 'board.jsonl'))
  assert.equal(ledgerFile(config, 'root-1', ENV), join(dir, 'ledger.jsonl'))
  assert.equal(artifactsDir(config, 'root-1', ENV), join(dir, 'artifacts'))

  // 一个 root 一个目录：不同会话不共享文件
  assert.notEqual(rootDir(config, 'root-1', ENV), rootDir(config, 'root-2', ENV))
})
