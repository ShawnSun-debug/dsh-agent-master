# PROGRESS — dsh-agent-master

> 给下一个接手的会话/agent 看。每验一票更新，不要攒到最后。
>
> **索引见 `HANDOFF.md`**（读取顺序 / 文件索引 / 已锁决策 / 雷区 / 下一个动作）。

## 1. 现在在哪

- **T09–T13 五票全部落地**（看板为核心的重定向）：看板数据层、旧看板迁移、门禁与派发审批、经验沉淀、指挥台 deck v2。
- 测试：19 个文件 / **272 例全绿**。入口 `node scripts/test.mjs`（本机 `%TEMP%` 对沙箱进程不可写，脚本把 TEMP 指到仓内 `.test-tmp`；`node --test` 在 confined 模式下会因管道 spawn 报 EPERM，故改成逐文件 `node <file>`）。
- 源码：`lib/{config,board,migrate,ledger,handoff,gate,approval,experience,tools,sections,deck,sources,dispatch,master,index}.js` + `client/client.js`。
- 契约：`docs/GLOSSARY.md`（术语）、`docs/adr/0001–0004`（不可逆决策）、`.scratch/api-notes.md`（宿主 API 行号证据）、`issues/00-wayfinder-map.md`（地图）。
- 落盘：`<dataDir>/<rootId>/{board.json,ledger.jsonl,artifacts/}`；指挥台 `<root cwd>/.agent-master/<rootId>/deck.json`；经验 `<root cwd>/.agent-master/experience.jsonl` + `~/.dsh/agent-master/experience.jsonl`。

### 看板模型（一句话）

`board.json` = `{version:1, headSeq, cards[], records[]}`。**卡可改**（每次改 rev+1，写时必带 rev 做 CAS），**记录只追加**（带 `cardId` 外键，永不改）。状态机 `todo → assigned → doing → review → done`，另有 `blocked`（任何非 done 卡 ↔ blocked，解除只能 master 做）；`assignee=master` 可 `todo → doing` 直达；`done` 只有 master 能写。

## 2. 决策偏差（ADR 之外，接手必须知道）

- **派发审批不走宿主 `{kind:'ask'}`**：ADR-0002 原写让 `tools/pre-execute` 返回 `{kind:'ask'}` 交给宿主管线弹审批。实做改为门禁**自己调 `ctx.get('approval').request(...)`** 并自带 `AbortSignal` 计时。原因：宿主 `ApprovalRequest` 只有 `{agent,toolName,callId,reason,displayReason,signal}`，**没有超时字段**，而票面要求 `approvalWaitMs`（默认 600000）到点失败。行为等价点：仍是同一个 approval 服务与审计卡；仍 fail-closed（`rejected`/`cancelled`/`unavailable` 一律不派发）；`policy=never` 会得到 `rejected`，拒绝文案里点名 `never`。
- **经验库两级**：项目级 `<root cwd>/.agent-master/experience.jsonl` 优先，用户级 `~/.dsh/agent-master/experience.jsonl`（`scope:global`）兜底；同 title 二次 save 只抬 `verified_count` 并追加来源卡，不新增条目。
- **deck 契约 v2 不保留 v1 适配层**：旧快照（`version !== 2`）在客户端显示占位提示，不做半截渲染（票面验收要求"无异常抛出"）。
- **投影 `agentMaster` 实际只剩「历史会话回退」这一用途，而且回退也不出数据**：v1 时代的 deck 事件会被 `deckStateSchema.parse` 判成 `null`（不抛错），客户端因此显示占位。保留注册是为了不改动客户端回退路径，不是因为它还能还原旧数据。
- **`label` 一词两义**：`master_assign(label)` 是子会话名；看板卡与 deck 的 `label` 是卡标题（= `brief.goal`）。写断言时最容易错的就是这里（`test/wiring.test.mjs` 第 7 条踩过）。
- **`board.json` 的真实形状比票面多两个字段**：`{version, headSeq, cards[], records[]}`（`headSeq` 是记录序号水位，不是 deck 的 revision）。

## 3. 已完成（含提交）

| 票 | 内容 | 落点 | 提交 |
|---|---|---|---|
| T1–T8 | 骨架/config/台账/五工具/分层提示词/宿主接线/指挥台/来源聚合/派发阶梯 | 见 `git log` | `282b278` 及更早 |
| T9 | 看板数据层：`board.json` = cards + records，rev 乐观锁，状态机，原子 rename | `lib/board.js`、`test/board.test.mjs`（33 例） | `c0a1fce` |
| T10 | 旧 `board.jsonl` 自动迁移：幂等、坏行跳过计数、逐字节备份、原文件保留 | `lib/migrate.js`、`test/migrate.test.mjs`（13 例） | `195538a` |
| T11 | 回报门禁 + 派发审批：`final:true`、`master_dispatch` 整批一次审批、`never` 报错、批量回滚 | `lib/gate.js`、`lib/approval.js`、`test/gate`（7）、`test/approval`（15）、`test/tools`（24） | `352e217` |
| T12 | 经验沉淀：`master_experience`、`op=accept` 必须给经验或显式 `experienceNone`、rework/abort | `lib/experience.js`、`test/experience`（14） | `1d16682` |
| T13 | 指挥台 deck v2：六状态/认领者/P 级、v1 占位、轮询兜底、不写会话事件 | `lib/deck.js`、`client/client.js`、`test/deck`（12）、`test/client`（17） | `776e582` |
| 接线 | 七工具注册、迁移前置、审批门禁、经验库注入、deck 落盘 | `lib/index.js`、`test/wiring`（17）、`test/integration`（1）、`test/plugin`（15） | `21fe0ac` |

## 3.5 真机验证记录（2026-11-18，headless 真宿主 + 真模型）

用一个临时 profile（`@deepseek-ai/dsh-base` + `dsh-headless` + 本插件，`node_modules` junction 指回 desktop）
把插件装进**真宿主**跑真模型，让模型真的去调工具。这一步抓到了 5 个离线测试看不见的 bug——共同根因：
**假 ctx 测试同时绕过了宿主的入参校验和输出校验**。

| # | 现象（真机原文） | 根因 | 修复 / 防回归 |
|---|---|---|---|
| 1 | `Error: content.some is not a function` | `output.render` 返回字符串；宿主契约是 `ContentBlock[]`（`dsh-tools/src/contracts.ts`） | 七个 render 改 `textBlock()`；`test/tools.test.mjs` 断言每个 render 返回非空 text 块 |
| 2 | `op=head` 只回「看板操作完成」 | 宿主签名是 `render(args, value)`，我们写成单参数，渲染到的是**参数**不是结果 | 七个签名改 `(args, value)`；测试断言 `render.length === 2` 且 head 文案带真实数字 |
| 3 | 建卡报 `value.card.assignee must be an object`（卡其实已建好） | 输出 schema 把 `assignee/childSessionId/tools/locator` 的 `null` 声明成非空；宿主 schema 子集不支持 `type: [..]`，要用 `oneOf` | 加 `NULLABLE_*` 片段；新增 `test/schema.test.mjs` 按宿主规则校验真实返回值 |
| 4 | `assign` 报 `value.tools: must be array` | 未指定白名单时 `childAllowList` 返回 `null` | `NULLABLE_STRING_ARRAY`；同由 `schema.test.mjs` 覆盖 |
| 5 | `op=accept` 永远报「必须带 experience」 | 工具**入参 schema** 没声明 `verdict/experience/experienceNone`，真模型传了也被丢掉（假 ctx 直接注入 args 才没暴露） | 补三个参数；`schema.test.mjs` 逐工具断言「实现会读的键都在 parameters 里」 |

**真机已跑通的完整链路**（每次都是真宿主 + 真模型，产物在盘上）：

- `master_board op=head/query/records` → 正常返回（此前必崩）。
- `op=create` → `卡 t1（todo，rev 1）`；`~/.dsh/agent-master/<rootId>/board.json` 落盘。
- `op=claim` → `assigned`；`op=doing` → `doing`；`master_report final:true` → 卡进 `review`（手工建卡会带 1 处台账违规，属设计内）。
- `op=accept verdict=accept + experience` → `卡 t1（done，rev 5）`，卡置 done，经验写进 `<cwd>/.agent-master/experience.jsonl`（`sourceCardId: t1`）。
- `master_assign` → **fail-closed 生效**：`Error: 审批通道不可用（outcome=unavailable）`，看板零新增卡、零 spawn。
- 指挥台数据源：`.agent-master/<rootId>/deck.json` 为 v2 快照，含真实卡（`label/status/rev/assignee/counts`）。


**master 引导专项（同一天追加，3 个问题）**：

| # | 现象 | 根因 | 修复 |
|---|---|---|---|
| 6 | `ensureMasterSession 拿不到 agents.create`：`ctx.get("agents") = undefined` | 注入回调 `ctx.inject(['agents','workspaceRegistry'], scoped => …)` 里**异步**再去 `scoped.get(name)` 拿不到服务（回调返回后作用域失效） | 回调内**同步捕获**服务实例并显式传给 `ensureMasterSession({ agents, workspaceRegistry })` |
| 7 | 引导静默卡死：既没报错也没有 `masters/` 记录 | 宿主 `agents.create` 可能**既不返回也不抛错**（agent 工厂未就绪时），没有超时就会永远挂着 | `withTimeout` 20s 上限，超时抛 `MasterError`，`note('master', …)` 留诊断 |
| 8 | 真机失败后完全没线索 | 诊断只存在内存（`note()` 进数组），进程一关就没了 | `DSH_AGENT_MASTER_DEBUG=1` 时同时打到 stderr；服务形状不对时把实际拿到的对象（类型/构造名/键）写进错误 |

**重启后一键体检**：`node scripts/verify-restart.mjs`（只读，`--json` 可机读）。它检查 profile 接线、
`plugin-operations` 里应用是否关过插件、`~/.dsh/agent-master/masters/*.json`（= Master 会话引导成功）、
以及 deck/board/experience 三类落盘证据。当前唯一硬失败就是 `masters/` —— 必须重启后才可能出现。

**怎么复现这套真机验证**（约 10 分钟，不需要 GUI）：

1. 建临时 profile：`%USERPROFILE%\.dsh\profiles\probe-amb\`，`package.json` 的 `dsh.profile.bundles` =
   `["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless", "dsh-agent-master"]`，
   `dependencies` 里 `"dsh-agent-master": "link:D:/Agent Workspace/dsh-agent-master"`；
   再 `New-Item -ItemType Junction -Path <probe>\node_modules -Target <desktop profile>\node_modules`。
2. 复制 desktop profile 的 `cordis.yml` 与 `cordis.patch.yml`（模型路由与开关都在 patch 里）。
3. 跑：`$env:ELECTRON_RUN_AS_NODE="1"; & "D:\Deepseek Harness\DeepSeek Harness.exe" "<asar>\...\@deepseek-ai\dsh\lib\bin.js" --profile probe-amb "<让模型调某个工具的提示词>"`；
   CLI 读不到凭据时，把 `~/.dsh/.credentials.yaml` 里 `refs` 的两把 key 作为环境变量传给子进程即可。
4. 产物看 `~/.dsh/agent-master/<rootId>/` 与 `<cwd>/.agent-master/`。

## 4. 未验证（真机，必须人工勾）

服务端（工具层）已在真宿主里跑通（见 §3.5）。**只剩 GUI 侧三条**，需要重启 DSH 后在桌面应用里勾：

1. 派发时**真的弹出人批准卡片**（标题/理由可读），点「批准」能 spawn、点「拒绝」零副作用；放置满 `approvalWaitMs` 按拒绝返回。
   （headless 里已验到另一极端：无审批服务时 fail-closed，见 §3.5。）
2. `workspaceFiles.changes` 文件级 watch 可用（卡片不刷新自动变色）；不可用时 2s 轮询仍能变。
3. 指挥台六种状态/认领者/P 级的**目视**可区分度（无 DOM 测试，只有纯函数与渲染树断言）。

另：`master_experience op=query` 的两级合并（项目优先、全局兜底）离线与真机写入都验过，检索边界仍有测试覆盖，不再单列。

## 5. 修复记录（保留，防复发）

### 5.1 真宿主首次加载 failed（2026-11-16）

- 现象：插件列表 `dsh-agent-master` 一行标红「异常」，诊断原文 `cannot get property "state" without inject`。
- 根因：`lib/index.js` 用 `ctx.state` 存诊断。cordis 的 ctx 是**服务代理**，访问 `inject` 之外的名字直接抛错。
- 为什么测试没挡住：假 ctx 里有 `state: {}` 这个属性，把真实宿主不放行的东西放行了。
- 修复：诊断改为闭包内变量，不再往 ctx 上挂任何自定义字段。
- 防回归：`test/wiring.test.mjs`「严格 ctx」用例用 Proxy 复刻 cordis 规则，访问白名单外属性即抛。

### 5.2 会话被指挥台自定义事件写坏（2026-11-17）

- 现象：打开某会话报 `contains event type "agent-master/deck" (seq 126) unknown to this harness and not marked ignorable; refusing to interpret the log`。
- 根因：`session.append('agent-master/deck', …)` 写出的记录不在 `KNOWN_SESSION_EVENT_TYPES`，也没有 `ignorable: true`；写入不校验白名单，**读档**却整份拒读（`dsh-session-persistence/src/storage-contract.ts:75`）。
- 数据修复：备份后仅给那 4 条事件补 `"ignorable":true`，其余 7850 条逐字节一致；`validateStoredEvents` 复验 `PASS events=7853`。
- 插件修复：数据通道改为**工作区文件快照 + 官方 `workspaceFiles` Remote**，一次都不再写自定义事件（`test/client.test.mjs` 有源码级断言防回归）。

## 6. 雷区（踩过的）

- **不要用 `%TEMP%`**：沙箱进程 `mkdtemp` 报 EPERM，一律用仓内 `.test-tmp`（`scripts/test.mjs` 已处理）。
- **三方插件不能写自定义会话事件**（见 5.2）。投影 `agentMaster` 只作为旧会话回退。
- **`board.getCard(id)` 返回 `{card, records}`**，不是卡本身；存储层卡片的标题字段是 `title`（`label` 是 deck 的展示字段）。
- **`master_board op=accept` 必须带 `verdict`（accept/rework/abort）**，且 `accept` 必须给 `experience` 或显式 `experienceNone:true` —— 静默跳过沉淀会被当场拒绝。
- **`validateReport` 返回 `{ ok, report }` 包装**，不是裸 report；`bindReportToLedger` 要裸的。
- **`ctx.subagents.startActivation` 的 `parent` 必须是活 Agent 实例**（`exec.agent`），冷恢复后缓存的旧 Agent 会被判 UNAUTHORIZED → 工具集按 agent 实例 WeakMap 缓存。
- **`tools.restrict()` 只能挂在 agent 作用域的 `agent.ctx` 上**：全局 ctx 调用直接抛错；`agent/created` 是 serial 事件，挂监听要赶在第一步之前。
- **子对话必须预分配 `childId`**：`startActivation` 的 `agent/created` 早于它返回。
- **客户端是经典脚本**：`test/client.test.mjs` 用 `new Function` 执行再取 `__ModuleLoader__.load` 的工厂；假 ctx 的 `slots.inject(name, fn)` **必须真的执行 `fn`**，否则座位永远注册不上（踩过）。
- **PowerShell 单元素管道会退化成字符串**，拼 PATH 之类必须 `@()` 强制数组。
- 子代理**不得自行 commit**；提交由 lead 做，提交前必须全量测试绿。
