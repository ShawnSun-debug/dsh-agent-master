# DSH 宿主/客户端扩展 API 探测笔记

探测对象：DSH 0.2.2-rc.3（本机 asar）。
路径前缀：ASAR = `D:/Deepseek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai`。
下文证据均写作 `<包>/<相对路径>:<行号>`；行号以该文件 LF 行计。凡未亲眼读到的一律标 UNVERIFIED。

---

## 1. ctx.tools.register(definition) 与 defineTool

结论：`register` 只做形状校验——必须给 `output { schema, render, presentationMeta? }`，`render` 必须是函数；index.ts:130-135。除此之外不检查来源，所以第三方**不必 import @deepseek-ai/dsh-tools**，传普通对象即可（`projectToolSchema` 直接取用 `definition.parameters` 原对象，schema.ts:641-646）。`defineTool` 只做三件事：把参数规格编译成 JSON Schema（schema.ts:578-579）、把 `required: true` 这种规格写法转成标准 JSON Schema、包一层 `validate → ToolArgsError`（schema.ts:598-602），并把 presenters 做"软失败"包装（614-631）。
证据：ASAR/dsh-tools/src/index.ts:128-153；contracts.ts:27-40（ToolDefinition）、245-252（ToolRunContext + deferContext）；schema.ts:555-577、641-646。TextToolSchema 的 `parameters` 只要求可无损 JSON（schema.ts:643-645）。

定义形状与 execute 第二参 `exec`：

    ctx.tools.register({
      name: 'my_tool',
      description: '…给模型看的一句话…',
      // 标准 JSON Schema（普通对象路径必须自己写完整 schema，不能用 defineTool 的 required:true 规格）
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { path: { type: 'string', description: '…' } },
        required: ['path'],
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } }, required: ['ok'] },
        render: (_args, value) => [{ type: 'text', text: value.ok ? 'ok' : 'failed' }],
      },
      async execute(args, exec) {
        // exec: ToolExecution + deferContext() + concludeTurn 标记（contracts.ts:245-252）
        exec.signal.throwIfAborted()
        exec.agent?.session            // 调用方 agent（可能存在）
        exec.callId; exec.rootCallId   // 调用身份
        return { ok: true }
      },
    })

官方实际用法：ASAR/dsh-tool-todo/src/index.ts:136-205（`parameters` 用 defineTool 规格写法 `required: true`；`execute(args, exec)` 里读 `exec.agent`，无 agent 直接 throw）。
exec 里可用字段：contracts.ts:175-203（callId/rootCallId/name/arguments/agent/toolSet/parent/signal）、220-225（+ token）、245-252（deferContext/concludesTurn）。
注意：`run_code` 名字被保留，注册即抛（index.ts:145-147）；`output.schema` 走受限 JSON Schema 子集（json-schema.ts:1-12），不支持 `anyOf`/`$ref`。

## 2. ctx.systemPrompt：section 注册与"按 agent 生效"

结论：方法名 `section({ name, order, text })`，返回精确 disposer；`order` 建议用 `getSectionOrder('TOOL_SUBAGENT' | 'TOOL_GOAL' | …)` 取中央分配位（index.ts:501-503）。**没有 per-agent 谓词参数**，两种等价做法：(a) 在 `agent.ctx` 上注册（ScopedLayers 按 scope 生效，同名 scoped 覆盖 global，index.ts:485-494）；(b) 全局注册、在 `text(context)` 里读 `context.agent` 返回 `''` 或正文——这才是"按 agent 条件生效"的主流写法（dsh-agent 把 `agent`/`modelSelection` 合并进 AssembleContext，runtime-types.ts:18-25；装配时由 dispatch.ts:174-176 一起塞进去）。
证据：ASAR/dsh-system-prompt/src/index.ts:42-50（AssembleContext）、53-76（PromptSection）、485-494（section）、501-503（getSectionOrder）、520-529（context）、552（tools）、568（variable）、621（assemble）。
官方举例：ASAR/dsh-plan-mode/src/index.ts:197-204（按 session 状态开关的 section）、ASAR/dsh-tool-subagent/src/index.ts:365-392（`text` 里读 `context.agent`/`context.scope` 与 `ctx.tools.get(name, context.scope)`）。

    ctx.systemPrompt.section({
      name: 'agent-master:policy',
      order: ctx.systemPrompt.getSectionOrder('TOOL_GOAL'),   // 任选一个既有位；也可写数字
      text: (context) => {
        const agent = context.agent                 // 需要 dsh-agent 已装配
        if (agent === undefined) return ''          // 诊断性装配时无 agent
        if (context.scope !== agent) return ''      // 同一次装配里 scope 与 agent 必须一致
        return '只在目标 agent 的装配里出现的一段话'
      },
    })

补充：`systemPrompt.context({name, order, text})` 产出用户角色快照（每步刷新，比 section 更适合"当前状态"）；`system-prompt/assemble` 是 waterfall，可整体改写（index.ts:27-31）。

## 3. agent/* 钩子、pre-step 注入、当前 agent 的 root/parent

结论：事件全集 9 个（见证据）。`agent/pre-step` 是 **waterfall**，签名为 `(payload, next) => Promise<PreStepDecision>`，payload 直接带 `agent`；返回 `{ kind:'enter', messages: [...] }` 即可注入内容，`{ kind:'reject' }` 拒绝本步。payload 里没有 root/parent——父子关系只在 `ctx.subagents`（`rootOf(agent)`）与 session 血缘里，Agent 本身只有 `id/session/ctx/…`。
证据：ASAR/dsh-agent/src/runtime-types.ts:291-430（agent/created、disposed、status、inbox/inserted·claimed·discarded、pre-step、request、request-error、assistant-stream、turn-stopping、error）；139-146（PreStepDecision）；190-272（Agent 运行时面：options/session/model/inbox/status/ctx/cancel/whenIdle/runMaintenance/send/followup/steer/inject）。
官方注入举例：ASAR/dsh-plan-mode/src/index.ts:211-228（先 `await next()`，再 `{...decision, messages:[...decision.messages, narration]}`）；ASAR/dsh-repeat-tool-reminder/src/index.ts:230-233（只在 pre-step 里重置状态、始终 `next()`）。

    ctx.on('agent/pre-step', async ({ agent, messages, turn, step, signal }, next) => {
      const decision = await next()                       // 先让下游决定：可能已被 reject
      if (decision.kind === 'reject' || signal.aborted) return decision
      const note = createUserMessage({                    // dsh-llm 的工厂：自动补 id/role
        content: [{ type: 'text', text: '本步追加的上下文' }],
        source: { kind: 'my-plugin' },                    // 先在 @deepseek-ai/dsh-llm 里 declare module 扩 MessageSourceMap
      })
      return { ...decision, messages: [...decision.messages, note] }
    })

说明：`source.kind` 必须先在 `MessageSourceMap` 里声明（llm/src/message.ts:110-115 是可合并扩展的；样例 repeat-tool-reminder:14-18）。若不想走 pre-step，也可 `agent.inject(message)`（下一步边界取用，见 runtime-types.ts:263-271）。
官方用法：ASAR/dsh-repeat-tool-reminder/src/index.ts:210-225（`createUserMessage` + 自定义 source + `form:'notice'`）。

## 4. ctx.sessionProjections：定义与读取

结论：`register(definition)` 返回 **Promise<ProjectionHandle<S>>**（必须 await 后再对外暴露，definition 只允许同步纯函数）；读状态用 `handle.stateOf(session)` / `handle.readerFor(session)`；被弃用的是 `registry.stateOf(session, key)`（首次调用打 deprecation）。`stateSchema` 只需要一个带 `.parse(value)` 的对象（源码内部按 `{ parse(value: unknown): unknown }` 使用，index.ts:216），所以 zod 之外的鸭子类型也成立。`wire` 决定是否出现在 client 快照里；`apply` 不插件的事件必须**返回同一引用**，否则下游产生工作。
证据：ASAR/dsh-session-projection/src/index.ts:83-133（ProjectionDefinition）、51-73（ProjectionHandle）、322-340（register 重载）、446-465（deprecated stateOf）、216（stateSchema 鸭子类型）。
官方用法：ASAR/dsh-tool-todo/src/index.ts:124-135（todos 投影，wire + stateVersion:2）、ASAR/dsh-plan-mode/src/index.ts:205。

    const handle = await ctx.sessionProjections.register<'myState', MyState>({
      key: 'myState',
      stateSchema: { parse: (value: unknown) => value as MyState },   // 或 z.object({...})
      init: () => ({ items: [] }),
      apply: (state, event) => {
        if (event.type !== 'my/event') return state      // 必须返回同一引用
        return { items: [...state.items, event.data] }
      },
      wire: { viewSchema: { parse: v => v }, view: s => s, summary: false },
      stateVersion: 1,
    })
    const now = handle.stateOf(agent.session)

## 5. Typert Remote：三方插件注册命名空间

结论：**不存在 `ctx.remote.*` 的注册入口**；正确做法是让服务继承 `TypertRemoteService`（构造时 `super(ctx, 'serviceKey')` 即把 Cordis key 绑成同名 wire namespace，可用 `options.namespace` 改），再用 `@Remote('endpoint')` / `@Remote({ name, resources, mode:'stream' })` 标记要暴露的 public 实例方法；Gateway 依据类原型上的 marker 发现（protocol/src/index.ts:250-264、282-320、404）。client 侧的调用描述是生成物 `typert.remote-client.js`（`createTypertRemoteInfo({package, methods})`，其中每个方法的 `service` 字段就是 host 的 service key），package.json 用 `"./remote"` 导出；调用本身经 api-gateway 的 `invoke`（registry 只负责 schema/descriptor 登记，不负责调用）。
证据：ASAR/dsh-typert-protocol/src/index.ts:111-121（binding）、236-247（bindTypertRemote）、250-264（TypertRemoteService）、282-320（Remote 重载）、369-404（RemoteScope/remoteMethods）；ASAR/dsh-typert-registry/src/index.ts:13-23（契约面）、src/client/index.ts:1-12；调用面 ASAR/dsh-api-gateway/src/index.ts:424、types.ts:184。
官方实例：ASAR/dsh-subagent/src/index.ts:194（`extends TypertRemoteService`，210 行 `super(ctx,'subagents')`）、450（`@Remote({ name:'prompt', resources:{ session: request => request.childSessionId } })`）、392（`@Remote` 系列）；生成物 ASAR/dsh-subagent/lib/typert.remote-client.js:51-60；导出 ASAR/dsh-subagent/package.json `"./typert"` / `"./remote"`。

    export class MyRemote extends TypertRemoteService {
      static inject = ['sessionProjections']
      constructor(ctx: Context) { super(ctx, 'myFeature') }   // wire namespace = myFeature
      @Remote('snapshot')                                     // client 看到 myFeature/snapshot
      snapshot(sessionId: SessionId): Promise<Wire> { … }
    }

UNVERIFIED：第三方**手写** client 侧 descriptor 而不经 `@deepseek-ai/dsh-typert-generator` 的完整路径——已确认生成物形状（`TYPERT_REMOTE = createTypertRemoteInfo(...)`）与 gateway `invoke` 入口，但没找到任何非生成器产物调用它的示例代码；若要给 client 用，建议走 api-gateway 现有 Remote（如 `ctx.remote.commands`）或让 host 端把结果写进第 4 条的 projection wire。

## 6. client 侧：seat 清单、sidebar 两段式、ModuleLoader

结论 A：`ctx.slots.register(options[, Component])`，`options.name` 是 seat，另有 `id`/`key`/`order`/`priority`/`locale`/`store`/`inject`/`select`/`children`。全仓可直接使用的 seat 共 **93** 个（从所有 dsh-* 的 `slots.register|inject` 字面量去重抽取；权威目录见 ASAR/dsh-cordis-client-runner/src/client/slot-catalog.ts）：
    conversation.* (37): approval.detail, chat.assistant-actions, chat.commandview, chat.flow, chat.markdown.fence, chat.message.images, chat.node, chat.reasoning.body, chat.text-interaction, chat.turnTail, chat.user.before, chat.user.images, composer, composer.dock, hero.frame, hero.options, hero.workspace, hero.workspace.directoryFlow, input.activity, input.attachments, input.dock, input.model, input.model.label, input.model.options, input.overlay, input.permission, input.plan, plan-review.actions, session.header.actions, session.header.actions.subagent.footer, session.header.corner, session.header.lineage, session.header.utilities, session.header.views.actions, trajectory.images, user.text.node, view
    shell.* (3): leading, overlay, quota-notice
    sidebar.* (26): sidebar(根), brand.mark, brand.name, footer.action, panellist, panellist.actions, right.pane.tab, right.pane.tab.title, right.tab.document, right.tab.document.action, right.tab.document.actions, right.tab.document.office.pdf, right.tab.document.unpreviewable, right.tab.files.actions, right.tab.guide.actions, right.tab.guide.entry, session.action, session.row.hover, session.row.leading, session.row.trailing, settings, toggle.badge, workspaces, workspaces.directoryFlow, workspaces.session.menu.item, workspaces.session.row.action
    main (1): main；rightbar (1): rightbar
    settings.* (11): action, close, general.item, header, launcher, launcher.notifications, models.sign-in, onboarding, plugins.tab, section, trigger
    plugins.* (6): add.actions, bundle.activation, bundle.config, item, row.config, tab
    tool.* (2): call.images, call.toolview；contextMenu.* (2): content, icon
    deliverables.* (2): file.actions, review.file.actions；workspace.* (2): picker.directoryFlow, toast
    仅出现在 lib 产物、src 未使用的：shell.bottom（dsh-experimental-inspector/lib/client.page.js:2）、main.conversation、sidebar.chat.conversation、settings.section.icon（dsh-cordis-client-runner/lib/client.js）——可用性未在 src 侧验证。
结论 B：`ctx.sidebarRightTabs.register(def)` 是**第一段=声明类型**（静态：id/kind/multiple/keepMounted/patterns/priority/canOpen/title/guide）；**第二段=按 `id` 挂 body**：`slots.inject('sidebar.right.pane.tab')` 里 `register({ name, key: def.id }, Body)`，标题再挂 `sidebar.right.pane.tab.title` 同一 key。源码注释把这条规则写死了（tab-registry.ts:4-9、94-102）。
结论 C：`window.__ModuleLoader__.load({ id, factory })` 只**注册**工厂，materialize 在首次 require；`id` 就是 **package.json 的 `name`**（如 `@deepseek-ai/dsh-client-ui-plan`），与 `dsh.client` 无关；`dsh.client = { platform: 'web', inject: [...] }` 是**装配顺序/依赖**声明，入口走 `exports['./client']`。
证据：ASAR/dsh-client-ui-sidebar-right/src/client/tab-registry.ts:4-25、94-139（definition 全字段）；ASAR/dsh-client-ui-sidebar-files/src/client/index.ts:64-77（inject 含 sidebarRightTabs + 同文件 body）；ASAR/dsh-client-ui-plan/src/client/index.ts:65-116（两段式）；ASAR/dsh-client-modules/src/client/manifest.ts:9-24（load 语义）、ASAR/dsh-client-ui-open-in-app/lib/client.js:2（`load({id:'@deepseek-ai/dsh-client-ui-open-in-app',factory})`）；package.json `dsh.client` 实例：ASAR/dsh-client-ui-plan/package.json。

    // stage 1 —— 声明一种 tab 类型（静态）
    ctx.effect(() => ctx.sidebarRightTabs.register({
      id: 'agent-master:board',            // 唯一实现 id，也是第二段的 key
      kind: 'agent-master.board',
      priority: 'extension',
      title: () => 'Agent Board',
      guide: [{ id: 'board', order: 100, title: () => 'Agent Board' }],
    }), 'agent-master: tab type')

    // stage 2 —— 内容按 id 挂到 keyed seat
    ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
      { name: 'sidebar.right.pane.tab', key: 'agent-master:board', locale: 'agentMaster' },
      () => React.createElement(BoardPanel),
    ))
    ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
      { name: 'sidebar.right.pane.tab.title', key: 'agent-master:board' },
      () => React.createElement(TitleRow),
    ))

## 7. ctx.subagents：inject ['subagents'] 能拿到什么

结论：`ctx.subagents` 是 `SubagentRuntime`（构造时 `super(ctx,'subagents')`）。可用方法：`startActivation(spec)`、`sendMessage(sender, targetId, content, {signal})`、`listDescendants(rootSessionId, signal?)`、`rootOf(agent)`、`namesOf(agent)`、`resolveName(caller, name, signal)`、`waitForTreeWork(root)`、`drainDescendants(parents)`、`interrupt(targetSessionId, authority)`、`resolveMaxDepth(configured?)`、`registerProvider/getProvider`。
`startActivation` 参数 = provider + label + name? + childId? + signal + delivery('parent'|'caller') + prompt:ContentBlock[] + parent:Agent + cwd?/agentPreset?/agentOptions?/outputSchema?/maxDepth?；返回 `{ childId, name, messageId?, result:Promise<SubagentResult>, dispose() }`（保留 childId 的重载保证有 messageId）。
**parent 必须传活的 Agent 实例**：源码校验 `ctx.get('agents').get(spec.parent.id) !== spec.parent` 即抛 UNAUTHORIZED（index.ts:275-277）——工具里就是 `exec.agent`，不要在插件里自己拼 `{ id }`。
证据：ASAR/dsh-subagent/src/index.ts:131-168（Context + subagent/start·end 事件）、252-292（startActivation 重载与校验）、300-343（rootOf/namesOf/resolveName）、368-375（sendMessage）、392-394（interrupt）、427-429（listDescendants）；types.ts:29-46（SubagentActivationSpec）、49-66（SubagentActivation）、68-74（成员名）、86-89（SendMessageOptions）、144-191（SubagentStartRequest）。

    const activation = await ctx.subagents.startActivation({
      provider: 'in-process',          // 已注册的 provider 名（getProvider 可枚举）
      label: 'board-worker',
      name: 'panel-worker',            // 可选，1-32 小写/数字/连字符
      delivery: 'caller',              // caller=只回结果；parent=通知模型
      prompt: [{ type: 'text', text: '做什么' }],
      parent: exec.agent!,             // 必须是活的 Agent
      signal: exec.signal,
    })
    const children = await ctx.subagents.listDescendants(agent.id, signal)

---

## 对 dsh-agent-master 的直接建议

T4（接线）最小骨架：一个 host 插件，`inject: ['tools','systemPrompt','sessionProjections','agents']`；用第 1 条注册 1-2 个普通对象工具（不 import dsh-tools，避免 peer 依赖），用第 2 条在 `text(context)` 里按 `context.agent` 出提示词，用第 3 条 pre-step 注入本步需要的状态；所有注册都放进 `ctx.effect(...)` 以便 HMR/卸载干净回卷（官方写法见 plan-mode:195-229）。

    export const name = 'agent-master'
    export const inject = ['tools', 'systemPrompt', 'sessionProjections']
    export function apply(ctx: Context): void {
      ctx.effect(() => ctx.systemPrompt.section({ name: 'agent-master:brief', order: 9000, text: () => '…' }), 'brief')
      ctx.effect(() => ctx.tools.register({ name: 'agent_master_status', description: '…', parameters: {…}, output: {…}, execute: async (_a, exec) => ({ ok: true }) }), 'status tool')
    }

T5（投影 + Remote）：先落 projection 作为单一事实源（第 4 条，`wire` 打开后 client 快照自带），**远程调用优先复用官方 Remote 命名空间**；只有确实需要新命名空间时才建 `TypertRemoteService` 子类（第 5 条骨架），并接受"client 侧需 generator 产物或手写 descriptor"这一未验证边界——不要在没有样例的前提下承诺 client 能直接调。

    const handle = await ctx.sessionProjections.register({ key: 'agentMaster', stateSchema: { parse: v => v }, init: () => ({ runs: [] }), apply: (s, e) => e.type === 'agent-master/run' ? { runs: [...s.runs, e.data] } : s, wire: { viewSchema: { parse: v => v }, view: s => s }, stateVersion: 1 })

T6（面板）：`sidebarRightTabs.register`（stage 1，id/kind/title/guide）+ `slots.inject('sidebar.right.pane.tab')` 按同一 `key = id` 挂 body（stage 2），标题挂 `...tab.title`；package.json 补 `dsh.client = { platform:'web', inject:['@deepseek-ai/dsh-client-ui-sidebar-right', …] }` 与 `exports['./client']`，构建产物用 `window.__ModuleLoader__.load({ id: '<package.json name>', factory })` 注册。面板数据只读 projection/Remote，不在 client 里重新推导状态。

---

## 补充：客户端读投影（T5 只注册投影、不注册自定义 Remote 的可行性）

### 8.1 完整链路：宿主注册投影 → 客户端读到（以 `todos` 为例）

结论：**通**。宿主是唯一计算点，客户端零领域代码即可读到任意第三方投影 key。链路六段，逐段给证据：

1. 宿主注册（域插件）：`dsh-tool-todo/src/index.ts:124-135` — `register({ key:'todos', stateSchema, init, apply, wire:{ viewSchema, view, summary:false }, stateVersion:2 })`。
2. 宿主算全量快照：`dsh-api-session-controller/src/history/controller.ts:69-91` — live 会话走 `this.ctx.sessionProjections.snapshot(live)`（`:78`，**不传 keys**），返回 `{ kind:'sequenced', asOfSeq, values }`；非 live 走持久化观察（`:87-90`）。`snapshot` 的过滤规则在 `dsh-session-projection/src/index.ts:514-528`：只保留 `refs !== 0` 且 `def.wire !== undefined` 的注册，**仅当调用方传 keys 时才按 key 过滤**（`:523`）。
3. 宿主推增量帧：`dsh-api-session-controller/src/control.ts:22-30` — `ctx.sessionProjections.onEventChanged((session, changes, seq) => broadcast({type:'projection', sessionId, seq, changes}))`；基线 `control.ts:55-75` 同样逐 session `snapshot(session)`（`:67`）。
4. 传输到浏览器：客户端 `dsh-api-session-controller/src/client/transport.ts:201`（`projections: frame.projections`）；补齐读 `client/sessions/manager.ts:351` `this.remote.session.projections({sessionId}, signal)`（Remote 端点 `session/projections`）。
5. 客户端存值：`dsh-api-session-controller/src/client/sessions/projection-store.ts:1-13` 的文件头明确写：host 是唯一计算点、client 不做领域 fold、"a domain ships projection support with zero client code"；`faceOf(key)` `:106-108` 返回 per-key 稳定 observable。
6. 组件读：session 标准套件把 keyed hook 命名为 `useProjection` —— `dsh-client-ui-session/src/client/index.ts:266-279`（`BUILTIN_SOURCE = { hooks:['session'], keyedHooks:['projection'], props:['sessionId'], resolve: … projection: key => binding.session.projections.faceOf(key), props:{ sessionId } }`），绑定逻辑 `dsh-client-ui-renderer/src/client/scoped-slots.tsx:496-518`（`standardHookPropName`）。消费样例：`dsh-client-ui-conversation/src/client/skeleton/TodoPanel.tsx:106-107`（`export function TodoDock({ useProjection, t }) … const todos = useProjection('todos')`）。
   类型面：`UseProjection` 定义为 `ProjectionValueStore.ts:38-45` 的泛型（`(key) => SessionProjectionMap[K] | undefined`，支持 selector 重载）。

### 8.2 第三方投影是否自动对客户端可见？

结论：**是，无 host 白名单/登记**。`snapshot()` 不带 keys 即遍历全部注册（`index.ts:514-528`），推送走 `onEventChanged`（`control.ts:22`）。两个"看似门槛"的点都不是运行时门槛：
- `SessionProjectionMap` 的 `declare module` 合并只是**编译期**类型（`dsh-session-projection/src/types.ts`；样例 `dsh-client-ui-chat/src/client/chat/StatsPills.tsx:12`、`dsh-client-ui-goal/src/client/index.ts:26` 的注释都写明"pulls the … SessionProjectionMap merge for useProjection"）。
- `wire.summary:false` 只影响 **session 列表行的 summary**（装配时归一化 `summary: wire.summary !== false`，即省略=true，`index.ts:397-399`；`deriveSummaryKeys` `index.ts:576-584`；`list.ts:313-323` 用 `summaryKeys()`），会话打开后的 baseline/frame 仍然带它。`todos` 就是 `summary:false` 却能在 UI 显示的现成反例（`dsh-tool-todo:133`）。

### 8.3 不注册自定义 Remote 时，客户端拿"黑板/台账"数据的四条路

(a) **投影同步**（推荐其一）：把黑板摘要做成投影，`apply` 从会话事件 fold。代价最低、零 client 代码；限制：状态必须 plain JSON、必须由事件驱动（无事件就没有更新），大文件内容不适合放进 state（每事件都 fold + 每次进 baseline）。
(b) **复用官方 Remote**（推荐其二，读宿主文件最直接）：`ctx.remote.workspaceFiles` —— 宿主签名 `read(workspaceFileScope, path, range, signal)`（`dsh-api-workspace-files/src/index.ts:246-252`）、`list(scope, path, signal)`（`:316-317`）、`stat`（`:303-304`）、`search`（`:358-360`）、`changes`（watch 帧，`types.ts:202`）。首个参数就是 **sessionId**（`workspaceFileScope`，lookup 派生），client 调用实证 `dsh-client-ui-sidebar-files/src/client/face.ts:64`（`remote.workspaceFiles.changes(sessionId, path, lifetime)`）、`:110`（`remote.workspaceFiles.list(sessionId, path, signal)`）。
    其余可直接复用的只读命名空间（36 个，从各包 `lib/typert.remote-client.js` 的 `service` 字段抽取）：`sessionController`(session/list,page,state,projections,events,history 读面)、`subagents`(prompt, interruptByUser)、`jobController`(job/list,follow)、`goals`、`agentTeams`、`commands`、`settingsController`、`pluginInventory`、`llm`、`workspaceFiles`、`workspaceController`、`messageFeedback`、`schedule`、`terminal`、`skills`(sessionSkillCatalog)、`fileReferences` 等（完整清单见第 6 节末尾抽取结果/本节末）。**没有通用文件读写之外的"任意宿主 RPC"**，所以要读黑板文件只能走 `workspaceFiles`。
(c) **会话日志注入消息**：`agent.inject(createUserMessage(...))`（`dsh-agent/src/runtime-types.ts:263-271`）或 pre-step 返回 messages（第 3 条）。能到达浏览器（transcript 本来就会同步），但语义是把数据当对话内容：污染上下文、有 token 成本、客户端要解析文本，**不推荐作为数据通道**。
(d) **官方 resources**：`dsh-client-resources` 按 `dsh-resource://file/session/<id>/<path>` 地址读文件，sidebar 文件/文档预览用的就是它（`dsh-client-ui-sidebar-files/src/client/face.ts:605-703` 的 open 路径）。比 `workspaceFiles` 多一层地址抽象，若面板要"像文件预览"则更贴合。

推荐：**面板只读数据用 (a)**（结构化摘要、随会话实时），**需要读完整文件时用 (b)**（`remote.workspaceFiles.read/list`），两者都可不动 host 的 Typert 注册。代价：要新增 client 代码，但不需要 generator，也不需要 host 白名单。

### 8.4 sidebarRightTabs 两段式完整骨架（含 sessionId 获取）

关键对应关系：**stage1 的 `id` = stage2 的 `key`**（`dsh-client-ui-sidebar-right/src/client/tab-registry.ts:94-102` 明写"it is the key its body and title register under in the `sidebar.right.pane.tab` and `sidebar.right.pane.tab.title` seats"）。该 seat 声明为 `{kind:'keyed', scope:'session'}`（`src/client/index.ts:246-247`），因此组件拿到的标准套件是 **session 作用域**：`sessionId` 普通 prop + `useSession` + `useProjection`（`dsh-client-ui-session/src/client/index.ts:266-279`），另有该槽注入的 `tabInfo` hook（`tab-info.ts:29-55`，内部用 `standard.sessionId`）。

    // package.json
    // "dsh": { "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-sidebar-right", "@deepseek-ai/dsh-api-session-controller"] } }
    // "exports": { ".": …, "./client": { "default": "./lib/client.js" } }

    // lib/client.js 产物入口（id 必须等于 package.json 的 name）
    window.__ModuleLoader__.load({ id: 'dsh-agent-master', factory: require => { /* … */ } })

    // client/index.ts —— 插件必须 inject 的是 Cordis 服务名（见 8.6）
    export const inject = ['slots', 'locale', 'sidebarRightTabs', 'sessions']
    const NS = 'agentMaster'

    export function apply(ctx: Context): void {
      const t = ctx.locale.bind(NS)

      // stage 1：声明 tab 类型（静态；id 就是第二段的 key）
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: 'agent-master:board',          // ← 与 stage 2 的 key 完全一致
        kind: 'agent-master.board',
        priority: 'extension',             // 不写默认就是 extension（tab-registry.ts:120）
        multiple: false,
        keepMounted: true,
        title: () => t('board.title'),
        guide: [{ id: 'board', order: 100, title: () => t('board.title') }],
      }), 'agent-master: tab type')

      // stage 2：正文按 id 挂到 keyed seat
      ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
        { name: 'sidebar.right.pane.tab', key: 'agent-master:board', locale: NS },
        BoardPanel,                       // props: { sessionId, useProjection, useSession, tabInfo, t }
      ))

      // stage 2b：tab 标题（同一 key）
      ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
        { name: 'sidebar.right.pane.tab.title', key: 'agent-master:board' },
        () => React.createElement('span', null, t('board.title')),
      ))
    }

    // 面板组件：sessionId 与 useProjection 都是 seat 注入的 props，不要自己从 ctx 取
    function BoardPanel({ sessionId, useProjection }: {
      sessionId: SessionId
      useProjection: UseProjection
    }) {
      const board = useProjection('agentMaster')     // 第 4 条注册的投影 key
      return React.createElement(Board, { sessionId, board })
    }

    注意：只有 **session 作用域**的 seat 才有 `useProjection`/`sessionId`；挂在 root 作用域（如 `shell.overlay`）的组件没有这两项，必须自行从 `ctx.sessions` 选当前会话。

### 8.5 ctx.effect 的签名与返回

结论：`ctx.effect(execute: () => Effect, label?: string)`，`Effect` = 单个 disposer `() => T`、disposer 的 Iterable、或其 Promise/AsyncIterable（`cordis/src/fiber.ts:76-93`）。返回值是"卸载该 effect 的 disposer"，二次调用是 no-op，fiber 卸载时按**逆序**自动执行（`fiber.ts:70-74、411-424`）；fiber 已销毁时抛 `CordisError('INACTIVE_EFFECT')`（`:426-428`）。

    ctx.effect(() => ctx.systemPrompt.section({ name: 'x', order: 9000, text: () => '…' }), 'x: section')
    // section() 返回 disposer，被 effect 收集；插件卸载即自动注销

官方用法：`dsh-client-ui-sidebar-right/src/client/index.ts:290-306`（`ctx.slots.inject(...)` 包在 effect 里）、`dsh-client-ui-sidebar-files/src/client/index.ts:74-90`（effect + subscribe 清理）、`dsh-plan-mode/src/index.ts:229`（`ctx.effect(() => () => { disposed = true }, '…')`）。

### 8.6 dsh.client.inject 是否强制？必须 inject 哪些服务？

结论：**`package.json` 的 `dsh.client.inject` 不是 Cordis 服务注入**——`dsh-package-manifest/src/types.ts:90-91` 明写 "Informational package-name dependencies, **not** Cordis service injection"。它列的是**包名**，用于装配/构建顺序；真正决定能否用某个服务/seat 的是**插件模块自己导出的 `inject: string[]`（Cordis 服务名）**，缺了会在装配时等待或报错。
必须 inject 的服务名（client 侧 `Context` 合并实证）：
    slots                —— 任何 ctx.slots.register/inject（seat 的注册面）
    sessions             —— 读会话列表/当前会话（dsh-api-session-controller/src/client/index.ts:91-93）
    uiSession            —— session 作用域来源（dsh-client-ui-session/src/client/index.ts:196-198）
    sidebarRightTabs     —— tab 类型注册（dsh-client-ui-sidebar-right/src/client/index.ts:92-96）
    sidebarRight         —— 需要控制面板/标签（同上 :94）
    remote               —— 任意 Remote 命名空间根（dsh-api-remotes/src/client/index.ts:182-184）
    remote.<ns>          —— 具体命名空间，如 remote.workspaceFiles（实例见 dsh-client-ui-sidebar-files/src/client/index.ts:64）
    locale               —— 需要 t()（dsh-client-locale/src/client/index.ts:85-86）
注意：`useProjection`/`sessionId`/`useSession` 是 **slot 注入的 props**，不需要 inject；但组件必须注册在 session 作用域的 seat 上才拿得到（见 8.4 末尾）。
