# ADR-0003 经验沉淀做成独立工具，不依赖外部记忆插件

- 状态：已接受（2026-11-18）

## 背景

用户已更换记忆插件，明确要求「这几个 memory 的可以废掉了」，经验必须由项目自己掌控。
查实：dsh-mneme 0.16.0 并未暴露 cordis memory service，只有 memory_* 工具与本地 HTTP 路由；依赖它等于绑定私有实现。

## 决策

新增 master_experience(op=save/query/list) 与 lib/experience.js：项目内 .agent-master/experience.jsonl 为默认，scope=global 才写用户级 ~/.dsh/agent-master/；读取两级合并。
只有 master 在验收时写入；正文为二次蒸馏，原报告靠 sourceCardId 回查；按 title 归一，重复累加 verified_count。
项目内不再引用任何 memory_* 工具。

## 后果
正面：换插件不影响本项目；经验与卡片、验收强绑定（可见、可追溯）；去重靠归一而非外部语义搜索。
负面：没有向量召回，检索靠标签与关键词；跨项目经验需要人显式标 global；两级合并规则要长期维护。
被放弃的方案：插件自动打 mneme 本地 HTTP（绑私有路由）；只留项目内单级（换项目等于从零）。