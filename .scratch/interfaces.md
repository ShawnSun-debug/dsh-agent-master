# dsh-agent-master 模块接口契约 v1

所有模块只用 Node 内置模块 + 本仓文件，**禁止 import `@deepseek-ai/*`**（三方插件无法保证解析）。
错误类型用普通 class，`name` 字段固定；文案用中文，代码注释用中文，导出带 JSDoc 类型。

## lib/board.js（T2）

```js
export class BoardConflictError extends Error { constructor(message, currentSeq) } // name='BoardConflictError'
export class BoardFullError extends Error {}                                        // name='BoardFullError'
export const KINDS = ['task','finding','source','artifact','decision','open_question']

export class Board {
  constructor({ dir, maxEntries = 256, now = () => Date.now() })
  async head()                                   // -> { seq }  空板 seq=0
  async append({ scope='root', author, kind, title, body, refs=[], artifact=null, tags=[], expectedSeq=null })
        // -> { record, headSeq, deduped }
  async query({ kind, tag, sinceSeq=0, limit=100 })   // -> record[]
  async get(id)                                  // -> record|null
}

// record 形状（字段顺序固定，写盘即此形状）：
// { id, seq, ts, scope, author:{sessionId,name}, kind, title, body, refs, artifact, tags }
// id = 'b' + seq（seq 从 1 递增）
```

规则：
- 落盘 `<dir>/board.jsonl`，一行一条 JSON；启动时按行重建内存索引，坏行跳过并在 `this.skipped` 计数。
- `expectedSeq` 非 null 时 !== 当前 seq → 抛 `BoardConflictError`，`error.currentSeq` 带最新值，**不写盘**。
- 去重键 = `sha256(title + '\u0000' + (body ?? ''))`；重复时**不追加**，返回既有 record 且 `deduped:true`。
- 追加后 seq > maxEntries → 抛 `BoardFullError`，**不写盘**（不静默丢弃）。
- 进程内写入串行化（一个 promise 队列），避免同一进程并发 append 抢 seq。

## lib/ledger.js（T2）

```js
export const LEDGER_SCHEMA_VERSION = 1
export class LedgerError extends Error {}

export class Ledger {
  constructor({ dir, now = () => Date.now() })
  async append({ taskId, constraints=[], acceptance=[], boundaries=[], forbidden=[] })
        // -> entry（version 自动 +1）
  async latest(taskId)   // -> entry|null
  async list()           // -> entry[]（按 taskId 分组取最新）
  verify(entry, report)  // -> { violations: [{kind, text, reason}], ok: boolean }
}

// entry = { taskId, version, ts, schemaVersion, constraints, acceptance, boundaries, forbidden, hash }
// constraints 元素支持两种写法：字符串，或 { text, needsEvidence?:boolean }
```

规则：
- 落盘 `<dir>/ledger.jsonl`，append-only；**任何覆盖/删除既有版本的尝试都必须抛 LedgerError**。
- 同一 taskId 内容完全相同（hash 相等）→ 不追加新版本，返回既有 entry。
- `verify` 只做三类可离线判定的检查：
  1. `forbidden` 中任一文本出现在 `report.summary` 或 `report.findings[].text` → violation(kind='forbidden')；
  2. `boundaries` 是路径前缀白名单；`report.artifacts[].path` 不在任一前缀下 → violation(kind='boundary')；boundaries 为空则不检查；
  3. `constraints` 里 `needsEvidence:true` 且 `report.evidence` 为空 → violation(kind='constraint')。
- `entry.hash` = `sha256(JSON.stringify(规范化后的四组数组))`，稳定排序。

## lib/handoff.js（T3）

```js
export const REPORT_SCHEMA_VERSION = 1
export const KINDS = ['finding','source','artifact']
export class HandoffError extends Error {}
export class ReportValidationError extends HandoffError { constructor(message, errors) } // errors: [{path, message}]

export function renderBrief({ taskId, label, brief, ledgerEntry })
// brief = { goal, inputs?, constraints?, acceptance?, boundaries?, budget? }
// -> string：含任务号、目标、输入、约束台账编号与条目、交付 schema、报告纪律（禁止散文全文、必须引用）

export function validateReport(raw, { maxBytes = 8192 } = {})
// -> { ok:true, report } | 抛 ReportValidationError（errors 逐条可修正）

export function bindReportToLedger({ ledger, entry, report })
// -> { violations }：内部调用 ledger.verify，并额外检查 report.taskId 与 entry.taskId 一致
```

report 形状（`validateReport` 归一化后返回）：
```js
{ taskId, summary, findings:[{ text, refs? }], evidence:[{ url?, path?, quote }],
  open_questions:[], artifacts:[{ path, bytes?, sha256? }], confidence:'low'|'medium'|'high',
  schemaVersion: 1 }
```

校验规则（**失败一律不落盘、不写黑板**）：
- `taskId` 非空字符串；`summary` 非空且 ≤ maxReportBytes 字节（UTF-8）。
- `findings` 必须是非空数组，每项 `text` 非空。
- `evidence` 每项必须**至少**有 `url` 或 `path`，且有非空 `quote`；`url` 只接受 http/https。
- `confidence` 必须是三档之一；`schemaVersion` 缺省补 1，不等于 1 → 抛错（说明版本不支持）。
- 未知字段忽略，但不得静默丢弃 `findings`/`evidence` 之外的必填项。
