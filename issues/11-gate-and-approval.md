# T11 门禁与派发审批

- **wayfinder:task** · **阻塞边**：09

## 票面问题

「子对话第一件事更新看板」与「派发前必须审批」这两条规则，靠什么机制才真的拦得住，而不是写在提示词里没人执行？

## 交付

- 新增 lib/gate.js：assertReportAllowed({ card, sessionId, taskId })——卡须在该会话名下，且状态属于 assigned / doing / review；不满足抛 GateError（文案带下一步动作）。
- master_report 接入门禁；新增 final:true 语义（仅 final 把卡推到 review）；回执带 cardId；可带 experience 候选（由 master 决定是否采纳）。
- 交接契约（lib/handoff.js 渲染）写入开局四步：读整块板 → 认领本卡(assigned) → 读约束台账 → 开工翻 doing。
- 新增 lib/approval.js：注册 tools/pre-execute，对 master_assign / master_dispatch 返回 {kind:'ask', reason}；reason 内含计划表（每路 label / goal / 约束条数 / P 级 / 预估 token）。
- 新增工具 master_dispatch(briefs[])：预检（配额、约束齐备）→ 一次审批 → 批量 spawn → 批量建 todo 卡；任一 spawn 失败整体回滚已建卡。
- master_assign 保留单路，走同一审批路径。
- 策略处理：policy=never 或审批不可用 → 报错并给出开启方法；rejected → 失败返回且台账条目保留可重试；等待窗口 approvalWaitMs 默认 600000。
- 前置硬检查：未先更新看板（本批卡不存在）不进五档阶梯；lib/dispatch.js 保持纯函数，不引入板依赖。

## 验收（先写再动手，逐条勾）

- [ ] 没认领就 report → 拒收，且板上零新增记录
- [ ] 认领了别人卡号 report → 拒收
- [ ] 卡被改派后旧会话再 report → 拒收
- [ ] 非 final 报告不改卡状态；final 推 review
- [ ] 拒批 → 不 spawn、板上无新卡、台账条目保留
- [ ] never 策略 → 明确报错且不 spawn
- [ ] 批量 3 路只弹一次审批；第 3 路 spawn 失败时前两路卡被回滚
- [ ] dispatch 纯函数仍无板依赖（import 断言）