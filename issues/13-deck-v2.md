# T13 指挥台 deck v2

- **wayfinder:task** · **阻塞边**：09

## 票面问题

看板成了核心之后，指挥台要显示到什么程度，才让人一眼看出「哪张卡卡住了、谁在做、下一步该谁动」？

## 交付

- deck 快照契约升 v2：cards 带 status / assignee / priority / rev；records 只投影摘要字段。
- client/client.js 按 v2 渲染：状态列（todo/assigned/doing/blocked/review/done）+ 认领者 + P 级；点击卡打开对应子对话标签页（沿用现有能力）。
- 契约版本不匹配（v1 旧快照）→ 显示占位提示，不抛错（旧会话可白屏，数据仍在）。
- 保留 2s 轮询兜底与 workspaceFiles 快照读取。

## 验收（先写再动手，逐条勾）

- [ ] 六种状态在指挥台各有可见且可区分的样式
- [ ] 认领者与 P 级可见
- [ ] v1 旧快照 → 占位提示，无异常抛出
- [ ] 流断开时轮询仍能刷新状态变化
- [ ] 不写任何自定义会话事件（踩过的雷，见 PROGRESS 修复记录）