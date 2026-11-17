# 术语表（GLOSSARY）

本项目里这些词是**有定义的**，对话与代码必须同义。新增术语先加这里再动手。

| 术语 | 定义 | 反例（不要这样说） |
|---|---|---|
| 看板（board） | board.json：cards[] + records[] 的唯一事实来源 | 「黑板」（旧形态，append-only） |
| 卡片（card） | 一路子对话对应的一张卡，id 即 taskId（t1..tN），带 status / priority / assignee / rev | 「任务条目」 |
| 证据流（records） | 只追加的记录：finding / source / artifact / decision / open_question / card_status | 「卡片的字段」 |
| 认领（assigned） | 子对话把卡从 todo 翻成 assigned，并把自己写进 assignee；门禁凭证由此产生 | 「接手」「领取」混用 |
| 开工（doing） | 卡进入执行中；assignee=子对话 表示子对话在做，assignee=master 表示主对话自己做 | 「进行中」（未区分谁在做） |
| 待验收（review） | 子对话交了 final 报告，等 master 判定 | 「已完成」 |
| 验收（accept） | master_board op=accept，verdict 三选一，是唯一的结案入口 | 「看一下」「确认下」 |
| 返工（rework） | 验收不通过，卡回 doing 并附 note，由同一子对话续做 | 「打回」「重做」（不说谁做） |
| 作废重派（abort） | 验收不成，卡回 todo，可重新派发（可能换人） | 「取消」（卡不留痕） |
| 阻塞（blocked） | 卡被任一方置为 blocked 并写原因；解除后回 todo 由 master 决定 | 「卡住了」（状态不明） |
| 优先级（P0-P3） | 卡上的 P 级；另有硬规则「开工先读板」不依赖优先级 | 「重要程度」 |
| 门禁（gate） | 工具层的硬拦截：不满足条件直接拒，并给出下一步动作 | 「提示」「提醒」 |
| 前置硬检查 | 进五档阶梯之前必须通过的条件（本批卡已在板上） | 「预处理」 |
| 派发（dispatch） | master 把任务下派成子对话；批量派发是 master_dispatch | 「分配」「下发」 |
| 审批（approval） | 派发前经宿主 approval 服务向人要批准；fail-closed | 「确认一下」（无失败语义） |
| 经验（experience） | 验收时沉淀的可复用教训：title / lesson / root_cause / fix / tags / scope / sourceCardId | 「记忆」（那是外部插件，本项目不引用） |
| 二次蒸馏 | master 把子对话报告压成经验正文，原报告只留指针 | 「摘要」（谁摘的、摘到哪没说清） |
| 验收欠账 | 卡停在 review 的时间，即 master 的未结事项 | 「待办」 |
| 交接契约 | 由约束台账渲染、写进子对话 prompt 的开工说明（含开局四步） | 「提示词」 |
| 约束台账（ledger） | append-only 的约束/验收/边界/禁止项，报告逐条核对 | 「规则表」 |