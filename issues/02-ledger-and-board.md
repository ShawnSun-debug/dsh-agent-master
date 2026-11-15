# T02 约束台账 + 黑板存储

- **阻塞边**：01

## 交付
lib/ledger.js（append-only、version、schemaVersion）+ lib/board.js（CAS expectedSeq、scope、去重、条目预算）+ 单测

## 验收（先写再动手，逐条勾）
- [ ] 台账被 digest 覆盖的尝试必须失败
- [ ] 并发 CAS 冲突返回最新 seq 不丢数据
- [ ] 重复内容按 sha256 去重
- [ ] 超 maxEntries 拒绝并给可用查询建议
