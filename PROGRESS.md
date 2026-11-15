# PROGRESS — dsh-agent-master

> 给下一个接手的会话/agent 看。每验一票更新，不要攒到最后。

## 1. 现在在哪

- 计划已批准并落盘：`.scratch/plan.md`（决策表、接口、验收、票与阻塞边）。
- 模块契约：`.scratch/interfaces.md`（含 deck 契约 v1.1；v1.2 待 T5 落地：deck 事件改追加到 root 会话）。
- DSH API 查实笔记：`.scratch/api-notes.md`（含行号证据，改代码前先看它，别猜 API）。
- 测试：`npm test`（`scripts/test.mjs`；本机 `%TEMP%` 对沙箱进程不可写，脚本把 TEMP 指到 `.test-tmp`）。
- 当前：**118 个测试全绿**，最新提交 `282b278`。

## 2. 已完成（含提交）

| 票 | 内容 | 提交 |
|---|---|---|
| T1 | 包骨架、config、测试脚手架 | `70d83d8` |
| T2 | 约束台账 + 黑板（CAS/去重/预算） | `70d83d8` |
| T3 | 交接契约渲染与校验 | `70d83d8` |
| T4 | 五个模型工具 + 分角色提示词 | `b19057e` |
| T5 | 宿主接线 + agentMaster 投影 + deck | `282b278` |

## 3. 进行中

- T5 返工：deck 事件追加目标改为 **root 会话**（v1.2），防止子对话回报不刷新面板。
- T6：客户端指挥台（`client/client.js`），点击卡片打开对应子对话 tab。
- T7：来源聚合（去重/冲突）与派发五档阶梯，纯函数，未接线。

## 4. 下一步

1. 收口 T5/T6/T7 → 全量 `npm test` → 提交。
2. T8：把包装进 `%USERPROFILE%\.dsh\profiles\desktop`（`dependencies` 用 `link:` + `dsh.profile.bundles` 追加），**重启 DSH 后**跑三场景 E2E。
   - 注意：重启 DSH 会结束当前会话，必须由用户操作或下次会话执行。
3. 三场景：并行调研（3 路 + web_search + 引用去重）、并行改码（2 路 + artifact）、冷恢复接力（重启后 send_message 续聊 + 黑板仍在）。
4. README/CHANGELOG 补完。

## 5. 雷区（踩过的）

- **不要用 `%TEMP%`**：沙箱进程 `mkdtemp` 报 EPERM，一律用仓内 `.test-tmp`（`scripts/test.mjs` 已处理）。
- **三方插件没有 `ctx.remote` 注册入口**，自定义 Typert Remote 需要代码生成器 → 客户端数据通道只走 **投影 + `session.append` 自定义事件**（见 api-notes §5/§6）。
- **`validateReport` 返回 `{ ok, report }` 包装**，不是裸 report；`bindReportToLedger` 要裸的（集成测试里踩过）。
- **`ctx.subagents.startActivation` 的 `parent` 必须是活 Agent 实例**（`exec.agent`），冷恢复后缓存的旧 Agent 会被判 UNAUTHORIZED → 工具集按 agent 实例 WeakMap 缓存。
- **PowerShell 单元素管道会退化成字符串**，`+= ` 变拼接 → 拼 PATH 之类必须 `@()` 强制数组。
- 子代理**不得自行 commit**；提交由 lead 做，提交前必须 `npm test` 全绿。
