# 重启后的验收清单（T8）

> 插件已装进 `%USERPROFILE%\.dsh\profiles\desktop`（`link:` 方式，指向本仓库）。
> **重启 DSH 后**逐条勾。任何一条 ❌ 先看文末「失败处置」，不要继续往下测。

## 0. 重启前（机器可自动验证，已通过）

- [x] `npm test` 全绿
- [x] profile `dependencies` 有 `"dsh-agent-master": "link:D:/Agent Workspace/dsh-agent-master"`
- [x] profile `dsh.profile.bundles` 含 `dsh-agent-master`
- [x] `node_modules/dsh-agent-master` 解析到本仓库真实路径

## 1. 冒烟（5 分钟）

- [ ] DSH 启动**无报错弹窗**；插件页能看到 `dsh-agent-master`
- [ ] 新开会话，问模型「你现在有哪些 master_ 开头的工具」→ 应列出 5 个：
      `master_assign` / `master_report` / `master_collect` / `master_board` / `master_digest`
- [ ] 右侧栏出现 **指挥台** 标签（空态文案：还没有下派任何子对话）
- [ ] 让模型开一个子对话后，子对话里同样能看到 `master_report`（这条最容易失败：子 preset 可能不暴露本包工具）

## 1.5 Master 会话（T9 新增，重启后先看这一节）

- [ ] 左栏会话列表**顶部**出现标题为 `Master` 的会话（置顶生效；不要求它已打开）
- [ ] 打开它：工具列表只有 5 个 master 工具 + `read`/`write`/`edit`/`ask_user_question`，**没有 pwsh / bash / 终端**
- [ ] 问模型「你能执行终端命令吗」→ 应明确回答不能，而不是尝试调用不存在的工具
- [ ] 再重启一次 DSH：仍是同一个 master 会话（不会每次启动都新建一条）
- [ ] 让 master 带 `tools: ["read","write","pwsh"]` 调一次 `master_assign`：子对话里工具恰为这三个 + `master_report`/`master_board`
- [ ] 若 host 不认 `tools.restrict`：master 工具仍正常，只是白名单不生效；宿主日志应有 `agent-master` 诊断而不是启动失败

## 2. 场景 A：深度调研（主场景）

主对话里发：

> 用 master_assign 并行开 3 路子对话，分别调研「Windows 上 Node 26 的 ESM 加载开销」「pnpm 11 的 link: 依赖解析」「DSH 插件的 cordis.patch.yml 覆盖顺序」。
> 每路用 web_search 找来源，结束后必须 master_report 回传（evidence 带 URL 和原文 quote）。
> 全部回报后用 master_collect 汇总成一份带引用的结论，并指出哪些来源互为冲突。

- [ ] 三路子对话并行跑起来，指挥台上出现 3 张卡片
- [ ] 卡片状态从 `assigned`（灰）变 `reported`（绿）
- [ ] 点卡片能打开对应子对话 tab 并插话
- [ ] 汇总里有引用；同一 URL 的多段引文被标为**冲突待核**而不是被悄悄合并
- [ ] 黑板目录出现：`<DSH_HOME>/agent-master/<rootSessionId>/{board.jsonl,ledger.jsonl}`

## 3. 场景 B：并行改码

> 用 master_assign 开 2 路子对话，分别修改本仓库的两个不同文件（一个改 README 的已知限制段，一个给某个 lib 模块补一行 JSDoc）。要求各自把改动文件路径写进 report 的 artifacts。

- [ ] 两路各改各的，没有互相覆盖
- [ ] `master_collect` 能列出两路各自触碰的 artifact 路径
- [ ] 若某一路越界（改了台账 `boundaries` 之外的路径），collect 里能看到 `boundary` 违规

## 4. 场景 C：冷恢复接力

- [ ] 关掉 DSH，重开，回到同一个 root 会话
- [ ] 指挥台仍显示之前的子对话卡片（黑板持久化生效）
- [ ] 对某个子对话 `send_message` 继续追问，能收到回复（冷恢复生效）
- [ ] 该子对话再 `master_report` 一次，master 侧 `collect` 能看到新记录

## 5. 三条兼容性探针（真宿主才知道）

这三条是代码里唯一无法离线证实的假设，专门验：

- [ ] **`ctx.tools.register` 接受普通对象定义**（不是只能接 `defineTool` 的结果）—— 冒烟里 5 个工具能出现即证明
- [ ] **`session.append` 接受第三方自定义事件 `agent-master/deck`** —— 指挥台卡片状态能实时变色即证明
- [ ] **投影能推到浏览器**（`useProjection('agentMaster')` 拿得到 state）—— 面板不是一直空态即证明

## 6. 失败处置

| 现象 | 先查 |
|---|---|
| 启动报错 / 插件未加载 | `%USERPROFILE%\.dsh\profiles\desktop\cordis.yml` 是否含 `agent-master`；宿主日志里的 cordis 装载错误 |
| 工具没出现 | 会话 preset 是否禁用了该包的工具；子对话场景还要看子 preset |
| 指挥台空态不更新 | 自定义事件是否被拒（看宿主日志有无 `session.append` 相关错误）；投影 key 是否注册成功 |
| 点卡片打不开 | 子会话是否已挂载在屏幕上（`openResource` 对未挂载会话会抛，已被 catch 成 false） |

**回滚**：从 profile `package.json` 的 `dsh.profile.bundles` 删掉 `dsh-agent-master`（依赖可留），重启即停用；
彻底还原用同目录的 `package.json.bak-*`（安装前自动备份）。
