# T10 旧 board.jsonl 迁移

- **wayfinder:task** · **阻塞边**：09

## 票面问题

已落盘的 append-only 记录如何无损转成 cards + records，并且不会因为「忘了跑脚本」而让看板看起来是空的？

## 交付

- 新增 lib/migrate.js：读 board.jsonl，task 记录转 todo 卡（taskId 取 refs 里的 tN），其余记录转 records[]（保留原 id / seq / ts / kind / author / tags）。
- 触发：首次加载时若 board.json 缺失且 board.jsonl 存在 → 自动迁移一次，并在 records 里写一条 migrated 事件（计数、用时、跳过的坏行数）。
- 幂等：board.json 已存在则跳过；提供 force 选项供测试重跑。
- 备份：迁移前把原文件复制为 board.jsonl.bak-<ts>；原 board.jsonl 保留不删。
- 坏行：跳过并计数，不阻断整体迁移。

## 验收（先写再动手，逐条勾）

- [ ] 迁移后卡数 = 旧 task 记录数，records 数 = 旧其余记录数
- [ ] 重复加载不重复迁移（幂等），force 可重跑
- [ ] 坏行被跳过且计数正确，其余记录不受影响
- [ ] 迁移前存在逐字节一致的 .bak 文件，原文件仍在
- [ ] migrated 事件里能读出迁移前后的条数