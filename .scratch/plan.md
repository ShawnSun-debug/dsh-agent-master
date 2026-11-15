# dsh-agent-master：Master 对话指挥多子对话

> 状态：**已批准**（2026-11-15）。本文件是执行期唯一事实来源；票在 `issues/`。

## 1. 目标与非目标

**目标**：DSH 插件包 `dsh-agent-master`：一条 master 会话「下派 → 多路并行子对话 → 回收结构化结果 → 汇总」，把 agent 间信息磨损压到最低（**约束台账 + 共享黑板 + artifact 引用 + 摘要指针**），并把现成 `web_search`/`web_fetch` 纳入协作流。

**非目标**：不新造会话运行时/流式层；不 fork DSH 本体；不做像素级复刻；不替换官方 subagent/team；不自建搜索 provider。

**成功判据**：一条 master 会话并行指挥 ≥3 个子对话完成调研或改码，产物可回查、可冷恢复，用户可随时打开任一子对话亲手插话。

## 2. 现状证据（已核实）

- 子 agent 本来就是**持久 Session**：local spawn/fork children retain durable sessions；`startActivation({provider,label,name,prompt,parent,signal,delivery})`、`sendMessage`、`listDescendants`、cold resume、`maxActiveSubagents` 默认 8 —— `@deepseek-ai/dsh-subagent/README.md`。
- 子对话**已能开成会话 tab**：`dsh-resource://subagentchat/session/<child>?parent=<parent>&mode=<mode>` + builtin sidebar tab；普通侧栏不显示子 agent 会话 —— `@deepseek-ai/dsh-client-ui-subagent/README.md`。
- 已有共享任务板（CAS/依赖/文件提示，默认关）—— `dsh-agent-team`；跨会话引用快照（有界+不可信告警）—— `dsh-session-reference`；脚本化 fan-out —— `dsh-workflow`。
- API 形态：客户端 `window.__ModuleLoader__` + `ctx.slots.register`（`dsh-better-plan-mode/client/client.js:10,595-613`）；宿主 `defineTool` + `inject ['tools','subagents','systemPrompt','sessionProjections']`（`dsh-tool-subagent/src/index.ts:9-38`）；右侧栏 `ctx.sidebarRightTabs.register({id,kind,patterns,priority,canOpen,title,guide,keepMounted})`（`dsh-client-ui-sidebar-right/README.md` §Extension seats）。
- 目标目录原为空（greenfield）。

**结论**：「子对话」= 带持久 Session 的 subagent 子会话，无需新造；本项目增量是 **台账 + 黑板 + 契约 + 指挥台**。

## 3. 决策表

| 决策 | 结论 | 为什么 |
|---|---|---|
| 子对话运行时 | 复用 `ctx.subagents`（provider=`spawn`） | 新造要重做持久化/流式/权限/冷恢复 |
| 交接 | 子对话侧强制 `master_report` + schema 校验 | 散文终答是最大损耗源 |
| **约束台账（新增）** | 每条 task 的 `constraints/acceptance/boundaries` 存**独立 ledger**，永不进摘要、master 发送前逐条校验 | ACL REALM `Lost in the Handoff`：抽象压缩系统性软化硬指令，每轮重申仍只保留 **53%** 路由标记；外置 ledger 校验是其对策 |
| 共享状态 | JSONL 黑板 + CAS `expectedSeq`，`$DSH_HOME/agent-master/<rootId>/board.jsonl` | SQLite 增依赖；team 板只覆盖任务不覆盖结论/来源/产物 |
| 作用域 | 条目带 `scope: session\|root\|user\|temp`（借 ADK 分层） | 回答「子对话之间到底共享什么」，误放即泄漏 |
| 大结果 | artifact 落盘（版本化）+ digest + locator | 全文回传打爆上下文 |
| 联网 | 复用 `web_search`/`web_fetch`，master 聚合/去重/冲突 | 自建 provider 重复造轮子 |
| **派发策略阶梯（新增）** | 发摘要 / 发原文 / **不发**（跳过通信）/ 换更强子会话 / 只更新黑板 | NeurIPS'26：通信有 protocol tax，同一配置一处 +14.2pp、另一处 **−23.6pp**；「更充分」≠「更好用」 |
| UI | 右侧栏 tab 类型 `master-deck` + 会话头部按钮 | 改左侧栏要动官方导航 |
| 纪律 | 系统提示 section 分角色注入 | 口述纪律不可复现 |
| 工具 | 首版 5 个 | token 与选择成本 |

**预算依据**：agent 交互 ≈ chat 的 **4×** token、多智能体 ≈ **15×**（Anthropic）；子 agent 只回 **1–2k** token 蒸馏摘要。

## 4. 改动清单

```
package.json  cordis.patch.yml
lib/index.js  lib/config.js  lib/ledger.js  lib/board.js
lib/handoff.js  lib/digest.js  lib/tools.js  lib/sections.js
lib/projections.js  lib/remote.js
client/client.js
test/*.test.mjs  README.md  CHANGELOG.md
```

（`lib/ledger.js` 为本次调研后新增：约束台账独立于摘要与黑板正文。）

## 5. 接口与数据流

- **黑板记录**：`{id, rootId, scope, seq, ts, author:{sessionId,name}, kind:'task'|'finding'|'source'|'artifact'|'decision'|'open_question', title, body?, refs:[], artifact?:{path,bytes,sha256,version}, tags:[]}`；`expectedSeq` CAS，`sha256(title+body)` 去重。
- **台账条目**：`{taskId, constraints[], acceptance[], boundaries[], forbidden[], schemaVersion}`，append-only，只能追加新版本，不允许被 digest 覆盖。
- `master_assign({label,name?,brief:{goal,inputs,constraints,acceptance,boundaries,budget?}})` → 写 ledger + task → 渲染契约 → `startActivation({provider,label,name,prompt,parent,delivery:'parent'})` → 返回子会话句柄。
- `master_report({summary,findings[],evidence[{url?,path?,quote}],open_questions[],artifacts[],confidence})`：校验失败**不写盘**并返回可修正错误；成功写 finding/evidence/artifact + 回填台账命中情况。
- `master_collect({names[],waitMs?})`：合并黑板结果 + 子会话状态，命中/未命中台账约束逐条列出。
- `master_board({op:'append'|'query'})`、`master_digest({text|path,budgetBytes})` → `artifacts/<sha256>.md` + 摘要 + locator。
- **UI**：`masterDeck.snapshot(rootId)` → `{mode, children[], boardHeadSeq, ledgerViolations}`；点卡片打开既有 subagentchat tab（不复制对话实现）。
- **角色注入**：`agent/pre-step` + `rootOf(agent)` 判 root → master playbook；子会话 → child contract（结束前必须 `master_report`，且不得改动台账约束）。

## 6. 借鉴（调研结论，含证据分级）

| 参考 | 机制 | 采纳 |
|---|---|---|
| Anthropic 多智能体研究系统【一手】 | 子 agent 独立上下文、只回蒸馏发现；plan 外置（>200k 截断） | 黑板 + 摘要上限 + 预算闸 |
| Claude Duet【一手】 | 主线程 + 多 channel，**会话层隔离、记忆层共享** | 子对话独立会话 + 黑板共享层 |
| Google ADK【一手】 | `state` 键前缀分层（`user:`/`app:`/`temp:`）、Artifacts 版本化、子 agent `output_schema` | scope 字段、artifact 版本、report schema |
| A2A【一手】 | Task 生命周期 + Artifact + `contextId` 归组 | 任务状态机 + artifact 引用 |
| OpenAI Swarm / Agents SDK【一手】 | handoff 的 `input_filter`、`input_type` 显式裁剪 | digest ≠ 原文，裁剪显式化 |
| ACL REALM / arXiv 2607.16133 / 2608.29028【一手】 | 压缩丢约束、中继有损则 MAS 增益反转、显式约束泄漏 <15% | **约束台账 + 派发阶梯** |
| Grok Bot / OpenAI Dots【二手】 | 常驻命名同事、@ 寻址、共享 Space/群聊 | 子对话具名 + 可寻址 + 共享面板 |

> 纠偏：**Swarm 是 OpenAI 的**（已被 Agents SDK 取代）；Google 侧是 ADK + A2A。Grok Bot / Dots 细节仅二手，不当一手依据。

## 7. 风险与回滚

| 风险 | 处理 |
|---|---|
| 子 preset 不暴露本包工具 | T4 preset composition 显式加；验收含子对话能调 `master_report` |
| client seat 跨版本变化 | 优先 `sidebarRightTabs`，失败退 `shell.overlay`；按钮缺失保留命令入口 |
| token 失控（15×） | `maxChildren:4`、`maxParallelSearch:4`、子回传 `maxReportBytes` |
| 黑板并发写 | CAS 冲突返回最新 seq，重读追加 |
| 断网 | `web_search` 结构化错误透传，汇总标「未取得来源」 |
| 冷恢复契约漂移 | 记录带 `schemaVersion`，按记录版本校验 |

**回滚**：纯插件，移除 `dsh.profile.bundles` 条目 + 重启；`$DSH_HOME/agent-master/` 留存不影响启动。

## 8. 验收标准

1. `npm test` 全绿：契约校验、台账不可被摘要覆盖、CAS 冲突、去重、预算、digest 回读、config 未知键报错。
2. 装包后启动无告警、插件页可见可开关。
3. master 见 5 工具；子会话见 `master_report`。
4. **场景 A 深度调研**：并行 3 路 → `web_search` → 带 URL/quote 回报 → sources 去重 → 汇总带引用，全程不打断用户。
5. **场景 B 并行改码**：2 路各改不同文件 → artifact 记路径 → master 汇总变更。
6. **场景 C 接力**：重启后冷恢复续聊，黑板与台账仍在。
7. **损耗专项**：改写一条 constraints 后，`master_collect` 必须报出 violation；超预算文本经 digest 落盘且 locator 可回读。

## 9. 票与阻塞边

见 `issues/`（01→08），执行顺序即编号，每票先写验收再动手。

## 10. 未决问题

1. 官方 Team 模式是否同时开、与本包黑板并存？
2. 子对话模型：全继承，还是调研便宜/改码强？
3. 指挥台首版是否显示 token 与耗时（+1 票）？
4. 发布：直接 npm，还是先本地 link？

## 11. 术语

子对话=持久 Session 的 subagent 子会话；黑板=root 作用域 append-only 记录；台账=不可被摘要改写的约束/验收集合；artifact=落盘产物（路径+sha256+版本）；冷恢复=重启后经 `send_message` 重新激活。
