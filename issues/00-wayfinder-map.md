# 看板为核心：master/子对话协作契约改造

- **wayfinder:map** · 状态：路线已定、票已切（2026-11-18）

## 终点（Destination）

把 dsh-agent-master 从「黑板 + 交接契约」升级成「共享看板为核心」的协作协议：
看板是唯一事实来源；子对话开工第一件事是认领看板卡；派发前必须拿到人的审批；回收后由 master 验收并把教训沉淀进独立经验库。

本轮只交付**规格与决策票**，不动代码。

## 说明（Notes）

- 仓库：D:\Agent Workspace\dsh-agent-master；测试用 npm test；已有票 issues/01-08。
- 本 effort 允许执行型票（wayfinder:task）：票按「层」切，每张票是一批可独立验收的改造。
- 阻塞关系写在票内「阻塞边」（沿用 01-08 约定）。
- 必读：docs/GLOSSARY.md（术语）、docs/adr/（不可逆决策）、.scratch/api-notes.md（宿主 API 证据）。
- **本项目不再引用任何 memory_* 工具**（记忆插件已更换）：经验一律走 master_experience。

## 已定决策（索引）

一行一条；细节在票与 ADR 里，地图不重述。

### 看板

- 存储：单文件 board.json + rev 乐观锁 + 原子 rename（ADR-0001）
- 结构：cards[] 可变、records[] 只追加，外键 cardId（ADR-0001）
- 状态：todo → assigned → doing → review → done，另设 blocked
- assigned 是**状态**，assignee 是**字段**；「doing 且 assignee=子对话」才是子对话在做
- 主对话自领：assignee=master，直接 doing（不经 assigned）
- 优先级：P0-P3 字段 + 硬规则「开工先读板」
- 卡身份：一路子对话一张卡，taskId 即 cardId，沿用 t1..tN，卡带 rev
- 认领：子对话自己把 todo 翻成 assigned
- 开工：子对话自己翻 doing
- 交付：report(final:true) 置 review；master 验收置 done
- 阻塞：任何一方可置 blocked 并写原因；解除回 todo 只由 master 决定
- 审计：每次状态变更追加一条 records 事件
- 读板：子对话整块板只读 + 本卡可写；默认返回卡片摘要视图

### 门禁

- 「子对话第一件事更新看板」= 交接 prompt 四步 + 工具门禁，双保险
- 四步：读整块板 → 认领本卡(assigned) → 读约束台账 → 开工翻 doing
- 门禁判据：report 时卡须在该会话名下，且状态属于 assigned / doing / review
- 认领失败（卡不存在或被占）：立刻停手报错，不自行造卡
- 增量报告：可多次；只有 final:true 推 review
- 卡住时：翻卡写原因 或 出报告，至少一件

### 审批

- 派发前必须拿到人的批准：宿主 tools/pre-execute 返回 {kind:'ask'} → ctx.approval.request，fail-closed（ADR-0002）
- 批量：新增 master_dispatch(briefs[])，整批一次审批；master_assign 保留单路
- 审批卡内容：每路 label / goal / 约束条数 / P 级 / 预估 token
- 被拒（rejected）：失败返回，台账保留可重试，不擅自改道
- 无人应答：挂起等待，默认 10 分钟超时（approvalWaitMs）
- 会话策略 never：直接报错并提示先开启审批
- 五档阶梯保留，「看板已更新」提为工具层前置硬检查；dispatch 仍是纯函数

### 经验

- 独立工具 master_experience(op=save/query/list)，零外部依赖（ADR-0003）
- 字段：title / lesson / root_cause / fix / tags / scope / sourceCardId（+ verified_count）
- 只有 master 能写，时机是验收（master_board op=accept）
- 内容为二次蒸馏，原报告只留指针（sourceCardId）
- 可「显式无经验」，不可静默跳过
- 去重：按 title 归一，累加 verified_count 与来源卡
- 两级：项目内 .agent-master/ 默认；scope=global 写用户级 ~/.dsh/agent-master/

### 验收与工具面

- master_board op=accept(cardId, verdict, experience?)；verdict 取 accept / rework / abort
- accept → done + 写经验；rework → 回 doing + note（同一子对话续做）；abort → 回 todo（重新派发）
- master_collect 按卡分组：状态 / 认领者 / 摘要 / 违规 / 证据
- 工具面 7 个：dispatch / assign / report / collect / board(+accept) / digest / experience

### 工程

- 旧 board.jsonl → board.json：首次加载自动迁移，脚本幂等
- 测试整体推倒重写（旧断言围绕 append-only，价值让位于新契约）
- 回滚：按提交回滚；数据格式保留向下兼容读取
- deck 契约升 v2（卡片带 status/assignee/priority），不兼容 v1（ADR-0004）
- config 大版本升级，清理旧字段
- master 侧注入一条「开工先读板」短规则 + 工具描述强调

## 尚未细化（Not yet specified）

- cards 配额与归档：活跃卡上限与 done 卡是否计入同一配额、是否需要归档命令
- sources 去重与五档阶梯阈值调参：范围内但本轮未定参数
- deck 以外的客户端交互：本轮只改 deck 快照契约，其它前端能力是否跟进未定
- 并发验收阈值：并行 N 路同时翻卡的实测指标（机制已定，阈值未定）
- 经验检索质量：title 归一后如何衡量召回，未设计

## 范围外（Out of scope）

- 冷恢复与右侧栏打开子对话：保持现状，本轮不改会话生命周期机制

## 票（子问题）

按层切五张，阻塞边见各票：

- T09 看板数据层（前沿）
- T10 迁移（阻塞于 T09）
- T11 门禁与派发审批（阻塞于 T09）
- T12 经验沉淀（阻塞于 T11）
- T13 指挥台 deck v2（阻塞于 T09）