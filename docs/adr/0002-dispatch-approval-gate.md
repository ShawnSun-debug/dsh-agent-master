# ADR-0002 派发前审批走宿主 approval 服务，fail-closed

- 状态：已接受（2026-11-18）

## 背景

「派发子对话前必须主动要求审批」如果只写进提示词，模型可以绕过；本项目要的是拦得住。
查实：宿主提供 ctx.approval.request(...)，插件可在 tools/pre-execute 返回 {kind:'ask'} 触发审批卡；无应答者时 return unavailable，即 fail-closed。审批策略 ask / never 由会话决定。

## 决策

master_assign 与 master_dispatch 一律经 tools/pre-execute 请求审批；批量派发只弹一次，审批卡内含计划表（每路 label / goal / 约束条数 / P 级 / 预估 token）。
rejected → 失败返回、不 spawn、台账保留可重试；无人应答 → 挂起等待，默认 10 分钟（approvalWaitMs）后按失败；会话策略为 never → 直接报错并提示先开启审批。

## 后果
正面：规则变成硬门禁，模型无法自行放行；批量审批把点击成本压到一次。
负面：依赖宿主 approval 服务的形状；never 会话里该功能不可用（这是有意为之）；审批卡内容质量决定了人能不能有效判断。
被放弃的方案：master 在对话里贴计划等人回「批准」（君子协定）；派一个 reviewer agent 审（人失去否决权）。

## 实做偏差（2026-11-18，T11 落地时核对宿主源码后）

宿主 `ApprovalRequest` 只有 `{agent, toolName, callId, reason, displayReason, signal}`，**没有超时字段**；管线收到 `{kind:'ask'}` 后调 `serviceAsk`，挂起多久由调用方 `signal` 决定。为了真能让 `approvalWaitMs` 到点失败，实现改为：

- 门禁**自己调** `ctx.get('approval').request(...)`，源头上仍是同一个 approval 服务、同一张审计卡；
- 自带 `AbortController` 计时（`approvalWaitMs`，默认 600000），到点 abort 请求并按 `rejected` 处理；
- fail-closed 不变：`rejected` / `cancelled` / `unavailable` / 超时一律不派发、不建卡、不 spawn；
- `policy=never` 时服务返回 `rejected`，拒绝文案点名 `never` 并提示先开启审批。

若宿主未来给 `request` 增加 timeout 参数，这一层可退化为纯透传（门禁只渲染计划与返回 decision）。