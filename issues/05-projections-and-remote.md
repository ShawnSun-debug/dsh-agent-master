# T05 投影 + masterDeck Remote

- **阻塞边**：02

## 交付
lib/projections.js（agentMasterBoard / agentMasterRuns）+ lib/remote.js（snapshot/board/openChild/setMode）

## 验收（先写再动手，逐条勾）
- [ ] snapshot 返回 children 状态与 boardHeadSeq
- [ ] ledgerViolations 计算正确
- [ ] Remote 在 client 可调用
