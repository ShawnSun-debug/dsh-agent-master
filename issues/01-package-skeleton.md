# T01 包骨架 + config + 测试脚手架

- **阻塞边**：—

## 交付
package.json / cordis.patch.yml / lib/index.js（name、inject、apply 空实现）/ lib/config.js（未知键报错）/ test/ 跑通 node --test

## 验收（先写再动手，逐条勾）
- [ ] npm test 有输出且 0 失败
- [ ] 假配置缺字段时加载报错
- [ ] cordis.patch.yml 能被 profile 识别（干跑）
