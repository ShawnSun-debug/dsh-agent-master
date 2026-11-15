import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'

import {
  AgentMasterConfigError,
  DEFAULTS,
  boardFile,
  dataRoot,
  ledgerFile,
  rootDir,
  sanitizeRootId,
  validateConfig,
} from '../lib/config.js'

test('默认配置可校验且被冻结', () => {
  const config = validateConfig()
  assert.deepEqual({ ...config }, { ...DEFAULTS })
  assert.ok(Object.isFrozen(config))
  assert.equal(config.maxChildren, 4)
  assert.equal(config.defaultEnabled, false)
})

test('未知键在加载期报错，而不是静默忽略', () => {
  assert.throws(() => validateConfig({ maxChildern: 2 }), AgentMasterConfigError)
  assert.throws(() => validateConfig({ maxChildern: 2 }), /unknown config key: maxChildern/)
})

test('数值必须是正的安全整数', () => {
  assert.throws(() => validateConfig({ maxChildren: 0 }), /maxChildren must be a safe integer/)
  assert.throws(() => validateConfig({ maxChildren: 1.5 }), /maxChildren/)
  assert.throws(() => validateConfig({ maxReportBytes: 'big' }), /maxReportBytes/)
  assert.equal(validateConfig({ maxChildren: 8 }).maxChildren, 8)
})

test('布尔与 dataDir 类型受校验', () => {
  assert.throws(() => validateConfig({ defaultEnabled: 'yes' }), /defaultEnabled must be a boolean/)
  assert.throws(() => validateConfig({ dataDir: '' }), /dataDir must be null or a non-empty string/)
  assert.equal(validateConfig({ dataDir: 'D:/tmp/am' }).dataDir, 'D:/tmp/am')
})

test('dataRoot 默认落在 DSH_HOME/agent-master', () => {
  const env = { DSH_HOME: 'D:/dsh-home' }
  assert.equal(dataRoot(validateConfig(), env), resolve(join('D:/dsh-home', 'agent-master')))
})

test('dataDir 覆盖默认位置', () => {
  const env = { DSH_HOME: 'D:/dsh-home' }
  assert.equal(dataRoot(validateConfig({ dataDir: 'D:/custom' }), env), resolve('D:/custom'))
})

test('rootId 净化防止路径穿越', () => {
  assert.equal(sanitizeRootId('abc-123_X'), 'abc-123_X')
  assert.equal(sanitizeRootId('../../etc/passwd'), '------etc-passwd')
  assert.throws(() => sanitizeRootId(''), AgentMasterConfigError)
})

test('board/ledger 落在 root 目录内', () => {
  const env = { DSH_HOME: 'D:/dsh-home' }
  const config = validateConfig()
  const dir = rootDir(config, 'root-1', env)
  assert.equal(dir, resolve(join('D:/dsh-home', 'agent-master', 'root-1')))
  assert.equal(boardFile(config, 'root-1', env), join(dir, 'board.jsonl'))
  assert.equal(ledgerFile(config, 'root-1', env), join(dir, 'ledger.jsonl'))
})

test('master 配置：默认值、标题非空、工具列表校验', () => {
  const defaults = validateConfig({})
  assert.equal(defaults.masterEnabled, true)
  assert.equal(defaults.masterTitle, 'Master')
  assert.equal(defaults.masterTools, null)
  assert.equal(defaults.childToolExtras, null)

  assert.throws(() => validateConfig({ masterTitle: '   ' }), /masterTitle/)
  assert.throws(() => validateConfig({ masterEnabled: 'yes' }), /masterEnabled/)
  assert.throws(() => validateConfig({ masterTools: 'read' }), /masterTools/)
  assert.throws(() => validateConfig({ masterTools: [] }), /masterTools/)
  assert.throws(() => validateConfig({ masterTools: ['read', ' '] }), /masterTools/)
  assert.throws(() => validateConfig({ childToolExtras: ['read', 1] }), /childToolExtras/)

  assert.deepEqual(validateConfig({ masterTools: [' read ', 'read', 'write'] }).masterTools, ['read', 'write'])
  assert.deepEqual(validateConfig({ childToolExtras: [] }).childToolExtras, [])
})
