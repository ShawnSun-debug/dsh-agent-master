# T12 经验沉淀（master_experience）

- **wayfinder:task** · **阻塞边**：11

## 票面问题

子对话的结果如何变成下次能直接用的经验，而不是散落在对话里的感想？记忆插件已更换，本项目要自给自足。

## 交付

- 新增 lib/experience.js：两级存储——项目内 .agent-master/experience.jsonl（默认）、用户级 ~/.dsh/agent-master/experience.jsonl（scope=global 才写）；读取时合并，项目优先。
- 工具 master_experience(op=save/query/list)：字段 title / lesson / root_cause / fix / tags / scope / sourceCardId；title 归一，重复则 verified_count+1 并把来源卡追加进 sources。
- master_board 增加 op=accept(cardId, verdict, experience?)：accept → done 且必须带经验或显式 none；rework → 回 doing 并写 note 进 records；abort → 回 todo 可重新派发。
- master 侧 systemPrompt 注入一条短规则：验收时必须给出经验或显式声明本次无经验。
- 项目内不再引用任何 memory_* 工具（文档同时标注弃用）。

## 验收（先写再动手，逐条勾）

- [ ] accept 不带经验也不带 none → 报错，卡不落 done
- [ ] 同 title 二次 save → verified_count+1、来源卡追加、不新增条目
- [ ] scope=global 写全局库，默认写项目库，读取时两级合并
- [ ] rework 后卡回 doing，note 进 records 可回查
- [ ] abort 后卡回 todo，可被重新派发
- [ ] query 支持按 tag / scope 过滤，list 分页
- [ ] 仓内 grep 不到 memory_save / memory_search 的引用