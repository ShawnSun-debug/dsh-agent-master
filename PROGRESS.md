# PROGRESS — dsh-agent-master

> 给下一个接手的会话/agent 看。每验一票更新，不要攒到最后。

## 1. 现在在哪

- 计划已批准并落盘：`.scratch/plan.md`（决策表、接口、验收、票与阻塞边）。
- 模块契约：`.scratch/interfaces.md`（含 deck 契约 v1.1；v1.2 待 T5 落地：deck 事件改追加到 root 会话）。
- DSH API 查实笔记：`.scratch/api-notes.md`（含行号证据，改代码前先看它，别猜 API）。
- 测试：`npm test`（`scripts/test.mjs`；本机 `%TEMP%` 对沙箱进程不可写，脚本把 TEMP 指到 `.test-tmp`；且 `node --test` 在 confined 模式下会因管道 spawn 报 EPERM，已改成逐文件 `node <file>`）。
- 当前：**181 个测试全绿（14 个文件）**；插件已装进 desktop profile（link 指向本仓库，改代码即生效）。
- 2026-11-16 新增 **T9：Master 会话**（自动创建 / 工作区置顶 / 标题 / 工具白名单）+ `master_assign.tools` 子对话白名单。宿主 API 已在 asar 源码核对：`ctx.agents.create({ sessionId, meta, setup })`、`agentCtx.tools.restrict({ allow })`、`ctx.workspaceRegistry.pinSession()`、`ctx.sessionTitle.rename()`。

## 修复记录：真宿主首次加载 failed（2026-11-16）

- 现象：插件列表 `dsh-agent-master` 一行标红「异常」，诊断原文 `cannot get property "state" without inject`。
- 根因：`lib/index.js` 用 `ctx.state` 存诊断。cordis 的 ctx 是**服务代理**，访问 `inject` 之外的名字直接抛错。
- 为什么测试没挡住：假 ctx 里有 `state: {}` 这个属性，把真实宿主不放行的东西放行了。
- 修复：诊断改为闭包内变量，不再往 ctx 上挂任何自定义字段。
- 防回归：`test/wiring.test.mjs` 新增「严格 ctx」用例——用 Proxy 复刻 cordis 规则，访问白名单外属性即抛。
- 同时修掉的：三个旧用例把「往 ctx.state 写诊断」当契约，属于把 bug 写成断言，已改为断言注册面与回卷行为。

## 2. 已完成（含提交）

| 票 | 内容 | 提交 |
|---|---|---|
| T1 | 包骨架、config、测试脚手架 | `70d83d8` |
| T2 | 约束台账 + 黑板（CAS/去重/预算） | `70d83d8` |
| T3 | 交接契约渲染与校验 | `70d83d8` |
| T4 | 五个模型工具 + 分角色提示词 | `b19057e` |
| T5 | 宿主接线 + agentMaster 投影 + deck | `282b278` |
| T9 | Master 会话（创建/置顶/标题/工具白名单）+ `master_assign.tools` | 待提交 |

## 3. 进行中

- T5 v1.2 ✅ 已提交（\`2e04eb3\`）
- T8：装包完成（link + bundles），T7 成果接线中（\`impl-t8-wire\`）；重启验收清单见 \`docs/e2e-checklist.md\`
- T6：客户端指挥台（`client/client.js`），点击卡片打开对应子对话 tab。
- T7：**已交付** `lib/sources.js`（来源去重/冲突标记）+ `lib/dispatch.js`（派发五档阶梯），29 例单测全绿；**纯函数、未接线** `tools.js`/`index.js`（接线留待后续票）。

## 4. 下一步

1. 提交 T9 → 全量 `npm test` 全绿。
2. **重启 DSH**（会结束当前会话，必须由用户操作），然后按 `docs/e2e-checklist.md` 勾完三场景 + 新增的 master 段。
3. 三场景细节已在清单里：并行调研 / 并行改码 / 冷恢复接力。
4. 重启后重点确认：master 会话出现在左栏顶部、标题是 `Master`、工具列表里没有 pwsh/bash；`master_assign` 带 `tools` 的子对话工具被裁剪。

## 5. 雷区（踩过的）

- **不要用 `%TEMP%`**：沙箱进程 `mkdtemp` 报 EPERM，一律用仓内 `.test-tmp`（`scripts/test.mjs` 已处理）。
- **三方插件没有 `ctx.remote` 注册入口**，自定义 Typert Remote 需要代码生成器 → 客户端数据通道只走 **投影 + `session.append` 自定义事件**（见 api-notes §5/§6）。
- **`validateReport` 返回 `{ ok, report }` 包装**，不是裸 report；`bindReportToLedger` 要裸的（集成测试里踩过）。
- **`ctx.subagents.startActivation` 的 `parent` 必须是活 Agent 实例**（`exec.agent`），冷恢复后缓存的旧 Agent 会被判 UNAUTHORIZED → 工具集按 agent 实例 WeakMap 缓存。
- **PowerShell 单元素管道会退化成字符串**，`+= ` 变拼接 → 拼 PATH 之类必须 `@()` 强制数组。
- 子代理**不得自行 commit**；提交由 lead 做，提交前必须 `npm test` 全绿。
- **`tools.restrict()` 只能挂在 agent 作用域的 `agent.ctx` 上**：全局 ctx 调用直接抛错（dsh-tools `src/index.ts:162-165`，错误文案就是 "requires a scoped context"）。同一原因，`agent/created` 是 serial 事件，挂监听要赶在第一步之前。
- **子对话必须预分配 `childId`**：`startActivation` 的 `agent/created` 早于它返回，不预分配就赶不上第一步的工具声明（manager 用 `spec.childId ?? randomUUID()`，见 `src/manager.ts:335`）。
- **`node --test` 在本机沙箱下不可用**：它会为每个测试文件再 spawn 带管道 stdio 的子进程 → EPERM；`scripts/test.mjs` 已改成逐文件 `node <file>`（stdio: 'inherit' 允许）。
