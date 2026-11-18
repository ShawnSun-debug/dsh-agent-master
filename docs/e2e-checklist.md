# 重启后的验收清单（T8）

> 插件已装进 `%USERPROFILE%\.dsh\profiles\desktop`（`link:` 方式，指向本仓库）。
> **重启 DSH 后**逐条勾。任何一条 ❌ 先看文末「失败处置」，不要继续往下测。

## 0. 重启前（机器可自动验证，已通过）

- [x] `npm test` 全绿
- [x] profile `dependencies` 有 `"dsh-agent-master": "link:D:/Agent Workspace/dsh-agent-master"`
- [x] profile `dsh.profile.bundles` 含 `dsh-agent-master`
- [x] `node_modules/dsh-agent-master` 解析到本仓库真实路径

## 0.4 重启后先跑这条（一条命令看全部判据）

```
node scripts/verify-restart.mjs        # 加 --json 可机读
```

✅ = 已有落盘证据；⚠️ = 需要真的派一路/验收一次才会出现；❌ = 硬失败。
**`Master 会话记录` 必须是 ✅**，否则 §1.5 的 Master 会话根本不会出现在左栏——
用 `DSH_AGENT_MASTER_DEBUG=1` 重启一次，看 stderr 里的 `[agent-master] master:` 诊断。

## 0.5 服务端已在真宿主验证（2026-11-18，headless + 真模型）

用一个临时 profile（`@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-headless` + 本插件）把插件装进**真宿主**、
让真模型真的去调工具，结果是**服务端全链路通过**（详见 `PROGRESS.md` §3.5）：

- [x] 七个工具真的注册进宿主，模型能调用（此前必崩，见 §3.5 的 5 个真机 bug）
- [x] `master_board`：`head` / `query` / `records` / `create` / `claim` / `doing` / `accept` 全部正常返回
- [x] `master_report final:true` → 卡进 `review`；`op=accept verdict=accept + experience` → 卡 `done` 且经验落盘
- [x] `master_assign` 在**没有审批服务**的宿主里 fail-closed：报「审批通道不可用」、看板零新增卡、零 spawn
- [x] Master 会话引导：真宿主里 `created:true pinned:true`，记录写进 `~/.dsh/agent-master/masters/*.json`
- [x] 落盘证据：`~/.dsh/agent-master/<rootId>/board.json`、`<cwd>/.agent-master/<rootId>/deck.json`（v2）、
      `<cwd>/.agent-master/experience.jsonl`

**仍未验证的只有下面 GUI 侧三条**（要人看着屏幕）：审批卡片弹出并被点批准、`changes` 流/轮询自动刷新、六状态目视可辨。

## 1. 冒烟（5 分钟）

- [ ] DSH 启动**无报错弹窗**；插件页能看到 `dsh-agent-master`
- [ ] 新开会话，问模型「你现在有哪些 master_ 开头的工具」→ 应列出 7 个：
      `master_assign` / `master_dispatch` / `master_report` / `master_collect` / `master_board` / `master_digest` / `master_experience`
- [ ] 右侧栏出现 **指挥台** 标签（空态文案：还没有下派任何子对话）
- [ ] 让模型开一个子对话后，子对话里同样能看到 `master_report`（这条最容易失败：子 preset 可能不暴露本包工具）

## 1.5 Master 会话（T9 新增，重启后先看这一节）

- [ ] 左栏会话列表**顶部**出现标题为 `Master` 的会话（置顶生效；不要求它已打开）
- [ ] 打开它：工具列表只有 7 个 master 工具 + `read`/`write`/`edit`/`ask_user_question`，**没有 pwsh / bash / 终端**
- [ ] 问模型「你能执行终端命令吗」→ 应明确回答不能，而不是尝试调用不存在的工具
- [ ] 再重启一次 DSH：仍是同一个 master 会话（不会每次启动都新建一条）
- [ ] 让 master 带 `tools: ["read","write","pwsh"]` 调一次 `master_assign`：子对话里工具恰为这三个 + `master_report`/`master_board`
- [ ] 若 host 不认 `tools.restrict`：master 工具仍正常，只是白名单不生效；宿主日志应有 `agent-master` 诊断而不是启动失败

## 2. 场景 A：深度调研（主场景）

主对话里发：

> 用 master_assign 并行开 3 路子对话，分别调研「Windows 上 Node 26 的 ESM 加载开销」「pnpm 11 的 link: 依赖解析」「DSH 插件的 cordis.patch.yml 覆盖顺序」。
> 每路用 web_search 找来源，结束后必须 master_report 回传（evidence 带 URL 和原文 quote）。
> 全部回报后用 master_collect 汇总成一份带引用的结论，并指出哪些来源互为冲突。

- [ ] **先弹一次人批准卡片**（标题/理由里能看到「要开几路、分别做什么」）；批准后三路才真正开跑
- [ ] 三路子对话并行跑起来，指挥台上出现 3 张卡片
- [ ] 卡片状态走完整条链：`assigned`（蓝）→ `doing`（紫）→ `review`（橙）→ 验收后 `done`（绿）
- [ ] 卡片上能看到认领者名字与 P 级（P0–P3）
- [ ] 点卡片能打开对应子对话 tab 并插话
- [ ] 汇总里有引用；同一 URL 的多段引文被标为**冲突待核**而不是被悄悄合并
- [ ] 看板目录出现：`<DSH_HOME>/agent-master/<rootSessionId>/{board.json,ledger.jsonl}`（`board.json` 里是 `cards` + `records`）

## 3. 场景 B：并行改码

> 用 master_assign 开 2 路子对话，分别修改本仓库的两个不同文件（一个改 README 的已知限制段，一个给某个 lib 模块补一行 JSDoc）。要求各自把改动文件路径写进 report 的 artifacts。

- [ ] 两路各改各的，没有互相覆盖
- [ ] `master_collect` 能列出两路各自触碰的 artifact 路径
- [ ] 若某一路越界（改了台账 `boundaries` 之外的路径），collect 里能看到 `boundary` 违规

## 3.5 场景 D：审批、批量派发与验收沉淀（T11/T12 新增）

- [ ] 让 master 用 `master_dispatch` 一次派 3 路 → **只弹一次**审批卡片，不是三次
- [ ] **拒绝**那次审批 → 模型被告知被拒、看板上**一张卡都没多**、没有子会话被创建
- [ ] 骗一次：让 master 用 `master_assign` 派活时不填 constraints/acceptance → 应被工具当场拒绝（预检在任何写入之前）
- [ ] 子对话在第一份报告里写 `final:true` → 卡进 `review`；master 用 `master_board op=accept verdict=accept` 验收 → 卡进 `done`
- [ ] 验收时**不带** `experience` 也不带 `experienceNone` → 工具应报错拒绝（不允许静默跳过沉淀）
- [ ] 带 `experience` 验收 → `<cwd>/.agent-master/experience.jsonl` 出现该条；再让它 `master_experience op=query` 能搜到
- [ ] 子对话自己调 `op=accept` → 应被明确拒绝（只有 master 能验收）
- [ ] 让某个子对话 `op=block` 报阻塞 → 卡片变 `blocked`（红）；master `op=reopen` 后回到 `todo`

## 4. 场景 C：冷恢复接力

- [ ] 关掉 DSH，重开，回到同一个 root 会话
- [ ] 指挥台仍显示之前的卡片与状态（`deck.json` 快照持久化生效）
- [ ] 对某个子对话 `send_message` 继续追问，能收到回复（冷恢复生效）
- [ ] 该子对话再 `master_report` 一次，master 侧 `collect` 能看到新记录

## 5. 兼容性探针（真宿主才知道）

这几条是代码里唯一无法离线证实的假设，专门验：

- [ ] **`ctx.tools.register` 接受普通对象定义**（不是只能接 `defineTool` 的结果）—— 冒烟里 5 个工具能出现即证明
- [ ] **指挥台快照能落盘且客户端能读**：`<cwd>/.agent-master/<rootId>/deck.json` 存在且可解析；面板/会话头胶囊显示数据即证明客户端 `workspaceFiles.read` 通路成立
- [ ] **`workspaceFiles.changes` 文件级 watch 可用**：一次 `master_assign` 后卡片状态自动变化（不刷新）即证明；不行会退到 2s 轮询（也能变色，靠时序/心跳区分）
- [ ] **老会话回退投影**：升级前写过 deck 事件的会话（如 d1fec061）没有快照文件，面板仍显示旧数据即证明 `useProjection('agentMaster')` 回退可用
- [ ] **v1 快照占位**：把某个 `deck.json` 手工改成 `{"headSeq":1,"children":[]}` → 面板显示「旧契约」占位提示，**不白屏、不抛错**
- [ ] **审批服务存在**：派发时真的弹出人批准（不是静默放行）。若宿主没有 `approval` 服务，应看到工具被拒并提示原因（fail-closed），而不是悄悄执行
- [ ] **审批超时**：批准卡片放着不点满 10 分钟 → 工具返回「审批超时/被拒」，不创建任何子会话

## 6. 失败处置

| 现象 | 先查 |
|---|---|
| 启动报错 / 插件未加载 | `%USERPROFILE%\.dsh\profiles\desktop\cordis.yml` 是否含 `agent-master`；宿主日志里的 cordis 装载错误 |
| 工具没出现 | 会话 preset 是否禁用了该包的工具；子对话场景还要看子 preset |
| 指挥台空态不更新 | `<cwd>/.agent-master/<rootId>/deck.json` 是否存在/可解析；浏览器控制台有无 `workspaceFiles` 读失败；宿主日志有无 `deckErrors`；老会话再查投影 key 是否注册成功 |
| 点卡片打不开 | 子会话是否已挂载在屏幕上（`openResource` 对未挂载会话会抛，已被 catch 成 false） |

**回滚**：从 profile `package.json` 的 `dsh.profile.bundles` 删掉 `dsh-agent-master`（依赖可留），重启即停用；
彻底还原用同目录的 `package.json.bak-*`（安装前自动备份）。
