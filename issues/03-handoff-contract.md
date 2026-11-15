# T03 交接契约与渲染

- **阻塞边**：01

## 交付
lib/handoff.js：report schema v1、brief→prompt 渲染、回传校验（含 evidence 必带 url 或 path）

## 验收（先写再动手，逐条勾）
- [ ] 缺 findings 的 report 被拒且错误可修正
- [ ] 渲染出的 prompt 含 goal/constraints/acceptance/交付 schema
- [ ] schemaVersion 不认识时只报一条 schemaVersion 错误，不猜字段（v1 是唯一版本，票面原措辞已裁定作废）
