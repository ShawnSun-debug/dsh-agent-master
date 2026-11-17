# T09 看板数据层：board.json（可变卡 + 证据流）

- **wayfinder:task** · **阻塞边**：无（前沿）

## 票面问题

把 append-only 黑板换成以卡片为事实来源的看板，需要哪些数据契约，才能同时支撑状态机、审计、并发与迁移？

## 交付

- 重写 lib/board.js：单文件 board.json = { cards, records }；卡带 rev / status / priority / assignee；records 只追加并以 cardId 外键挂卡。
- 写入：进程内 mutex 串行化 + rev CAS（rev 不符即拒并回带最新 rev）+ 临时文件原子 rename。
- 状态机：合法转移表 todo→assigned→doing→review→done，任意态↔blocked（解除回 todo 仅 master）；非法转移拒并列出合法后继。
- 归属规则：done 只能 master 置；子对话只能翻自己名下的卡。
- 审计：每次状态变更追加一条 card_status 记录（from / to / actor / reason / ts）。
- 读视图：cards 摘要视图（默认）+ 单卡明细（卡 + 其 records）。
- 配置：maxCards（卡片配额，与 maxChildren 同量级）与 boardMaxEntries（records 配额，沿用旧名）。
- 保留 kind 语义：finding / source / artifact / decision / open_question 全部进 records。

## 验收（先写再动手，逐条勾）

- [ ] 无 rev 或 rev 过期的 updateCard 被拒，返回最新 rev
- [ ] todo 直接跳 done 被拒，错误里列出合法后继
- [ ] 子对话把卡翻成 done 被拒；master 翻成功
- [ ] 每次状态变更后 records 里能查到对应事件，from/to/actor 齐全
- [ ] 写入中途被中断，board.json 仍是上一份完整内容（无半截文件）
- [ ] cards 与 records 配额互不挤占（各自到顶各自报错）
- [ ] 摘要视图不返回 records 正文；单卡视图返回