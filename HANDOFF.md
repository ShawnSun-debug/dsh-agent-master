# HANDOFF — dsh-agent-master

> 一条 master 对话指挥 N 路子对话；共享看板（`board.json`）是唯一事实来源。
> **T09–T13 五票已全部落地，280 例测试全绿；工具层已在真宿主（headless + 真模型）跑通全链路。**
> **2026-11-18 修了五个真机故障（数据根少 `.dsh`、经验库目录钉死、`startActivation` 缺 `signal`、`assign` 返回宿主句柄、指挥台空白=缺 `remote.workspaceFiles` 注入）——见 `PROGRESS.md` §5.3–5.7，都要重新加载插件才生效。**
> **指挥台空白已用真浏览器锁定并修好**：新增 `npm run test:e2e`（`scripts/e2e-probe.mjs`），在独立 profile 里起宿主 + 无头 Edge，断言入口出现／点击／面板渲染正文／控制台零错误。**改客户端不用重启桌面端，刷新页面即可（2026-11-19 实测：改 client.js → 仅 `Page.reload` → 新文案出现）；改服务端（lib/）才要重启。**
> 重启后已验证：经验库 2→3 条可读、产物落 `~/.dsh/agent-master`、`master_assign` 真 spawn 出 `smoke-a` 并回报（`name=dsh-agent-master`/`version=0.1.0`）、`op=accept` 把 `t1` 置 done(rev 6)。
> 剩下只有 GUI 侧三条人工勾选，不是写码。

## 0. 60 秒上手（按顺序读）

1. `PROGRESS.md` §1「现在在哪」+ §2「决策偏差」+ §6「雷区」——只读这三节也够开工。
2. `docs/GLOSSARY.md`——卡（card）/ 记录（record）/ 看板（board）/ 证据流 / 认领 / 验收，术语别自造。
3. `docs/adr/0001–0004`——不可逆决策（看板为核、卡与记录分离、审批门禁、deck v2）。**要改先写新 ADR**。
4. 动宿主 API 之前读 `.scratch/api-notes.md`——里面是 asar 源码行号证据（`ctx.waterfall`、`approval.request`、`workspaceFiles`、`tools.restrict`）。**别猜 API**。
5. `issues/00-wayfinder-map.md`——地图；五张票全关，只剩 `docs/e2e-checklist.md` 的人工勾选。

## 1. 状态

| 项 | 值 |
|---|---|
| 票 | T09 / T10 / T11 / T12 / T13 **全部完成** |
| 测试 | 19 个文件 / 291 例，全绿（`node scripts/test.mjs`）+ 独立 profile 真浏览器 E2E（`npm run test:e2e`：5 项；`--with-data` 18 项，含真会话 + 真快照 + 实时刷新 + 六状态配色 + 计数筛选 + 窄面板不溢出 + 截图） |
| 真机 | 工具层全链路 + Master 会话引导（真宿主建会话、置顶、`masters/*.json` 落盘）已验证；审批 fail-closed 已验证（`PROGRESS.md` §3.5） |
| 未验证 | 3 条 **GUI 侧**，见 `PROGRESS.md` §4 与 `docs/e2e-checklist.md` |
| 插件 | 已装进 desktop profile（`link:` 指向本仓库，改代码重启即生效） |

## 2. 文件索引

**核心（按依赖顺序读）**

| 文件 | 职责 |
|---|---|
| `lib/config.js` | 配置默认值/校验（`maxCards` 32、`approvalWaitMs` 600000）、路径布局、`sanitizeRootId` |
| `lib/board.js` | **看板**：`board.json` = cards + records；卡 rev CAS、状态机、原子 temp+rename、进程内串行队列 |
| `lib/migrate.js` | 旧 `board.jsonl` → `board.json`：幂等、坏行计数、逐字节 `.bak`、原文件保留 |
| `lib/ledger.js` | 约束台账（append-only，版本递增，改旧版报错） |
| `lib/handoff.js` | 交接契约渲染（含开局四步）与回报校验 |
| `lib/gate.js` | 回报门禁：没认领/不是自己的卡/blocked/done → 拒收并给可执行下一步 |
| `lib/approval.js` | 派发审批：`buildApprovalPlan`、`renderApprovalReason`、`requestApproval`（自驱动超时）、`createPreExecuteGate` |
| `lib/experience.js` | 经验库两级（项目优先/全局兜底），同 title 合并抬 `verified_count` |
| `lib/tools.js` | 七个工具的实现 + `definitions`（含审批、批量派发、验收） |
| `lib/sections.js` | 分角色提示词：master 段（看板优先/审批/验收）与 child 段（认领/最终回报/阻塞） |
| `lib/deck.js` | **deck v2** 构建与 `deckStateSchema`（v1 → `null`，不抛错） |
| `lib/sources.js` | 来源聚合去重与冲突标记（不替人裁决） |
| `lib/dispatch.js` | 派发五档阶梯，**纯函数零 import**（`tools.test.mjs` 有断言） |
| `lib/master.js` | master 会话引导：创建/置顶/标题/工具白名单/冷恢复重挂 |
| `lib/index.js` | 宿主接线：七工具、迁移前置、审批门禁、投影、分角色 section、deck 落盘 |
| `client/client.js` | 指挥台（经典脚本，`__ModuleLoader__`）：六状态/认领者/P 级/v1 占位/轮询兜底/点卡开子对话 |

**测试（19 个文件，按票对号）**

- T09 `board.test.mjs`(33)｜T10 `migrate.test.mjs`(13)｜T11 `gate`(7)/`approval`(15)/`tools`(25)｜T12 `experience`(14)｜T13 `deck`(12)/`client`(17)
- 宿主契约：`schema.test.mjs`(4)——按宿主 json-schema 子集校验真实输出、检查入参声明齐全
- 接线与回归：`wiring`(18)、`plugin`(15)、`integration`(1)、`config`(13)、`master`(15)、`ledger`(15)、`sources`(13)、`dispatch`(15)、`handoff`(19)、`sections`(8)

**文档与证据**

- `PROGRESS.md`（状态/偏差/雷区/修复记录）、`docs/e2e-checklist.md`（真机验收）、`docs/GLOSSARY.md`（术语）、`docs/adr/`（决策）
- `issues/00-wayfinder-map.md` + `issues/09..13-*.md`（票面与验收逐条）
- `.scratch/api-notes.md`（宿主 API 行号）、`.scratch/plan.md`、`.scratch/interfaces.md`

## 3. 三条铁律

1. **看板是唯一事实来源**：子对话开工第一件事是认领卡片（`master_board op=claim`），不是直接干活。
2. **派发前必须拿到人批准**：`master_assign`/`master_dispatch` 走 `tools/pre-execute` 门禁；拿不到批准（拒绝/取消/服务缺失/超时）一律**不派**。
3. **回收后由 master 验收并把教训写进经验库**：`op=accept` 不带经验也不带 `experienceNone` 会被当场拒绝。

## 4. 已锁决策（不要重新讨论，除非写新 ADR）

- 卡**可改**（rev 乐观锁），记录**只追加**（`cardId` 外键）；旧 `board.jsonl` 只读迁移。
- 状态机六态，`done` 只有 master 能写；`blocked` 解除只能 master 做；`assignee=master` 可 `todo→doing` 直达。
- 审批**自驱动**（`ctx.get('approval').request` + `AbortSignal` 计时），因为宿主 `ApprovalRequest` 没有超时字段；仍 fail-closed。
- deck **v2 无 v1 适配层**：旧快照显示占位。
- 客户端**只读工作区文件快照**，绝不写自定义会话事件（5.2 事故）。
- 本项目**不再引用任何 `memory_*` 工具**。

## 5. 雷区（最贵的五条）

1. **不要用 `%TEMP%`**：沙箱进程 `mkdtemp` 报 EPERM，一律仓内 `.test-tmp`。
2. **不要写自定义会话事件**：写入不校验、读档整份拒读，会让会话打不开。
3. **`board.getCard()` 返回 `{card, records}`**；卡标题字段是 `title`（`label` 只是 deck 展示字段）。
4. **`op=accept` 要 `verdict` + 经验（或 `experienceNone:true`）**；`validateReport` 返回包装。
5. **客户端测试的假 ctx**：`slots.inject(name, fn)` 必须真的执行 `fn`，否则座位注册不上。
6. **工具定义有宿主契约，假 ctx 测不到**（真机踩了 5 次，详见 `PROGRESS.md` §3.5）：
   - `output.render(args, value)` 必须返回 `ContentBlock[]`，**不是字符串**；签名是**两个参数**，少写一个会渲染到参数而不是结果。
   - 输出 value 会被宿主按 `output.schema` 严格校验，**副作用先发生、校验后失败**；可空字段必须用 `oneOf:[{type:'object'},{type:'null'}]`（宿主不支持 `type:[...]`）。
   - 实现会读的每个入参都必须写进 `parameters.properties`，否则真模型传了也会被丢掉。

## 6. 怎么跑

    # 全量（Windows；node 不在 PATH）
    $env:TEMP = "D:\Agent Workspace\dsh-agent-master\.test-tmp"; $env:TMP = $env:TEMP
    & "C:\Users\charl\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" scripts/test.mjs

    # 单个文件
    & "<同一个 node>" test/board.test.mjs

## 7. 下一个动作

0. **（2026-11-18 遗留）重启后先验这三条**：① `master_experience op=list` 能看到 `<工作区>/.agent-master/experience.jsonl` 里的条目（>=1）；② `master_digest` 的 locator 落在 `~/.dsh/agent-master/…` 而不是 `~/agent-master/…`；③ 派发时点批准后**真的起得来子对话**（此前必报 `throwIfAborted`）。三条都对上才算这次修完。
   修复前误写到 `C:\Users\charl\agent-master` 的 11 个文件已**逐字节核对后合并**进 `~/.dsh/agent-master`（0 冲突），源目录改名为 `agent-master.migrated-2026-11-18T23-58` 留作备份。插件本身不自动迁移，以后换机器要手工搬。

1. **重启 DSH**（会结束当前会话，必须由用户操作；新代码只在重启后生效）。
2. 重启后先跑 `node scripts/verify-restart.mjs`：`masters/*.json` 出现 = Master 会话引导成功；若仍是 ❌，用 `DSH_AGENT_MASTER_DEBUG=1` 重启一次看 stderr 里的 `[agent-master] master:` 诊断。
3. 再在桌面应用里从固定 Master 会话派一路，勾 `docs/e2e-checklist.md` **GUI 三条**：审批卡片真的弹且批准能 spawn / 拒绝零副作用、`changes` 流或 2s 轮询能自动刷新、六状态目视可辨。
2. 任何一条 ❌：先看 PROGRESS §5 的两条修复记录 —— 大概率是宿主 API 行为与 asar 证据不符，**回去读 `.scratch/api-notes.md` 再改**。
3. 可选后续（未开工，也没有票）：`chooseDispatch` 从「提示词纪律」升级成硬闸门；客户端改成构建产物（现在是手写经典脚本）。
