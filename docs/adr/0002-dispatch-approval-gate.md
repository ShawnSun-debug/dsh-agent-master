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