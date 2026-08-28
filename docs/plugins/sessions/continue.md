# continue 插件技术文档

continue 是会话域里最小、也最"薄"的一个插件：它只往消息行贡献一个"继续"按钮，点下去经中立第八意图 `BaseBackend.continue?` 让内核在异常停机后原地续跑。它不做任何分叉、不重发任何旧消息、不碰任何内核存储格式——它的全部业务价值浓缩在"原地续跑 vs 重试分叉"这一条语义分界上，而这条分界正是多内核架构里"续跑"被抬进中立契约（而不是留在 pi 扩展面）的原因。pi 内核没有语义化的 continue，适配器把它翻译成 `followUp` 一条"继续"提示；dsh 内核有原生 `session/continue` RPC，服务端按 turn/end reason 语义分发。两边在 `PiBackend.continue` / `DshBackend.continue` 里各自实现，renderer 的 `ContinueAction` 只调 `ctx.messaging.continue()` 一行，零内核身份分支。

## 1 职责与边界

- continue 的职责只有一个动作：在**异常停机的 assistant 消息**上显示按钮，点击后调 `ctx.messaging.continue()`。异常停机的判据是 `NeutralMessage` 的两个标记——`error === true`（生成失败：进程 crash / RPC reject / toolCall isError）或 `stopped === true`（用户点停止或生成失败后保留部分内容），两个字段定义在 `packages/shared/src/domain/events/session-state.ts` 第 189 / 191 行，注释分别写明"用户点停止或生成失败后=true"与"生成失败= true，驱动 inline 红条"。
- 语义边界是它的命根：continue 是"**原地续跑，不 fork、不重发旧消息**"（plugin.json 的 description 原文），与 retry 的"从任意 assistant/tool 节点 fork 并重新生成"严格区分。这条边界直接对应两套不同的内核意图——continue 走第八意图 `continue?`，retry 走 `fork` + `prompt`，前者不改变 lineage 拓扑、后者开新 lineage。
- 依赖严格向内：`renderer/index.tsx` 从 `@my-harness-desktop/react` 取 `usePluginContext` / `useSessionStore` / `MessageActionProps`，从 `react-i18next` 取 `useTranslation`，从 `lucide-react` 取 `Play` 图标——无任何壳后端、内核实现 import。文案走 `locales/zh-CN/shell.json` 与 `locales/en/shell.json` 两个 locale（仅 zh-CN 与 en，比 retry 的四个 locale 少），这反映了插件的极简定位：三条文案键，两门语言。
- 插件目录是单文件 renderer 形态：`plugin.json` + `renderer/index.tsx`（58 行）+ `locales/{zh-CN,en}/shell.json`，没有 `core/`、没有 `pi-extension/`、没有 `dsh-extension/`。continue 不补任何内核能力——它消费的第八意图两个内核都已兑现（pi 翻译、dsh 原生），无需插件侧补面。

## 2 plugin.json 与贡献的槽

- `plugin.json` 的完整声明：`id: "continue"`、`version: "0.1.0"`、`tier: "official"`、`dependsOn: ["timeline"]`，`contributes.messageActions` 一项 `{ id: "continue", component: "ContinueAction", placement: "left", when: { role: ["assistant"] }, order: 40 }`，`contributes.languages` 两项（zh-CN / en 的 `continue.shell` 命名空间）。
- `dependsOn: ["timeline"]` 是生命周期护栏而非加载顺序控制（CLAUDE.md §8.2）：continue 贡献的 `messageActions` 按钮由 timeline 查槽渲染（timeline 是 `messageActions` 的消费方），按"凡消费别人槽位就声明 dependsOn"的纪律声明它。若 timeline 被删，`ContinueAction` 无人挂载，但插件照常加载、不崩。
- `messageActions` 槽位契约是 `MessageActionContribution`（`packages/shared/src/domain/contributions.ts` 第 170 行）：`{ id, component, placement?, when?, order? }`。continue 用 `placement: "left"`（按钮在消息内容侧）、`when: { role: ["assistant"] }`（只对 assistant 角色消息显示）、`order: 40`（在消息动作里排第 40，与 retry 的 `order: 50` 相邻，两者在 assistant 消息上按 order 从小到大排列，continue 在 retry 左侧）。
- `component: "ContinueAction"` 走 §7.4 组件自动匹配：框架加载 `renderer/index.tsx` 后，读 manifest 的 `contributes.messageActions[].component`，在 module exports 里找同名 `ContinueAction` 自动注册，插件不手动调任何 register 函数。
- `MessageActionProps`（`packages/react/src/message-actions.ts` 第 8 行）是消息动作组件的 props 契约：`{ message: NeutralMessage; text: string }`——`ContinueAction({ message }: MessageActionProps)` 只解构 `message`，用它的 `role` / `id` / `error` / `stopped` 四字段，`text` 用不到。

## 3 渲染逻辑：ContinueAction

- 显示条件（`renderer/index.tsx` 第 38–40 行）是两段式守卫：`if (!message.id || message.role !== "assistant") return null; if (message.error !== true && message.stopped !== true) return null;`——只有 assistant 角色、且有 `error` 或 `stopped` 标记的消息才渲染按钮。这条守卫把按钮的可见性完全交给 `NeutralMessage` 的状态标记，不引入任何插件自身的业务状态。
- `handleContinue`（第 25–36 行）用 `useCallback` 包裹，依赖 `[ctx, t, streaming]`：先查 `streaming`（来自 `useSessionStore` 的 `streaming` 字段，第 16 行 `const { streaming } = useSessionStore()`），生成进行中直接 `setToast(t("shell.continueStreamingBlocked"))` 并 return——续跑的前提是当前没有正在进行的生成，否则两条生成会并发抢占内核。
- 正常路径是 `await ctx.messaging.continue()`（第 31 行），异常 catch 后 `const msg = err instanceof Error ? err.message : String(err)`，`setToast(t("shell.continueFailed", { error: msg }))`。错误经 i18n 插值呈现（`{{error}}` 占位），不写死错误文案。
- toast 是插件内 `useState<string | null>` 的临时态（第 17 行），配 `useEffect` 3 秒自动清除（第 19–23 行 `setTimeout(() => setToast(null), 3000)`，返回 `clearTimeout` 清理）。toast 渲染为按钮右侧的 `<span className="text-xs text-[var(--color-accent-error)]">`（第 53–55 行），用主题 token 的 error 色。
- 按钮视觉（第 6 行 `STYLE` 常量 + 第 44–52 行）：`Play` 图标 + `t("shell.continue")` 文案，hover 从 muted 变 fg、背景变 surface，全走 CSS token 变量。这是极简的消息行内联按钮，与 retry 的 `RotateCcw` 图标 + 武装确认形成对比——continue 是**幂等、低风险**动作（原地续跑不改变历史），不需要 retry 那种两步确认。

## 4 第八意图：BaseBackend.continue?（圆心契约）

- 第八意图的契约落点在 `packages/shared/src/domain/backend.ts` 第 106 行：`continue?(): Promise<void>`，注释原文"继续当前会话执行（第八意图，§2.4 之外的会话级意图）：异常停机（工具失败/LLM 失败/max-tokens/崩溃/取消）后原地续跑，不 fork、不重发旧消息。可缺面：内核不支持则壳显式降级。dsh=session/continue RPC（服务端按 turn/end reason 语义分发）；pi=followUp 一条「继续」提示（适配器翻译）"。
- 它是可缺面意图（带 `?`），与 `listTools?` / `answerQuestion?` / `setThinkingLevel` 并列在 `AbstractBackend` 的四条缺面默认里（CLAUDE.md §9.4）——`AbstractBackend.continue` 缺省抛错。这意味着"续跑"是壳**向每一个内核索要**的能力：能兑现则给、不能兑现则显式降级（`session-store.continue` 第 1510 行抛"当前内核不支持继续执行"），不静默、不伪造成功。
- 第八意图的语义锚点是"**异常停机**"这个状态，而不是"任何想继续"的泛化动作。它和第六条核心意图 `abort()`（中断当前生成）是一对：abort 产生停机，continue 从停机恢复。正常完成的 assistant 消息不显示 continue 按钮（`error` / `stopped` 都是 false），因为正常完成没有"未完成的工作"可续。
- 与 `seed` / `setSessionName` / `answerQuestion` 的关系：continue 是"会话级意图"之一，与命名（第七意图）、提问（`answerQuestion?`）同属核心六条之外的叠加面。这些叠加面都是"壳需要内核提供的操作"，但比六条核心更轻、更可缺面——核心六条（消息/中断/模型/分支/会话标识/流式事件）是任何内核接入的硬门槛，叠加面是能力分档。

## 5 壳后端编排：session-store.continue

- `ctx.messaging.continue` 的类型是 `MessagingApi.continue`（`packages/shared/src/domain/sessions.ts` 第 253 行）："继续执行（第八意图）：异常停机后原地续跑，不 fork、不重发旧消息。经中立 backend.continue?（pi=followUp 翻译，dsh=session/continue RPC），缺面内核抛错"。`MessagingApi` 继承 `RpcOps`（第 242 行），`continue` 与 `prompt` / `abort` 并列在"对激活会话发消息的各种变体"里。
- 壳后端实现是 `src/server/application/sessions/session-store.ts` 第 1507–1513 行的 `continue()`：`const proc = this.activeProc(); if (!proc || !proc.backend.alive) throw new Error("会话未启动，请先选择模型"); if (!proc.backend.continue) throw new Error("当前内核不支持继续执行"); await proc.backend.continue(); proc.touched = true;`。三段守卫：无活跃进程抛"会话未启动"、进程不活抛同错、后端无 `continue` 抛"不支持"——最后调 `proc.backend.continue()` 并置 `proc.touched = true`。
- `proc.touched = true` 是会话活跃标记（与 `followUp` / `abortRetry` 同款），用于会话列表的"最近活跃"排序与生命周期管理——continue 也是一次"动过这个会话"的操作。
- `activeProc()` 与 `proc.backend` 是依赖倒置的落点：`session-store` 不 `new PiBackend()`，`proc.backend` 是 `BaseBackend` 接口实例（`BackendFactory.create` 产出），continue 调用只面向接口，不感知具体内核。这是 §9.3"内核后端（新增，最核心）"的现场。

## 6 两个内核的实现：适配器翻译 vs 原生 RPC

- **pi = 适配器翻译**（`src/server/kernel/pi/backend/pi-backend.ts` 第 169–171 行）：`async continue(): Promise<void> { await this.followUp("继续未完成的工作。请根据会话历史与 todo 清单判断当前进度，从上次中断处继续。"); }`。pi 内核没有语义化的 continue 命令，适配器把它翻译成 `followUp` 一条固定中文提示——这条提示作为 follow_up 消息排队进内核，模型读到后从上一段输出接着跑。这是 §7.6 三分法里的"适配器翻译"：内核有"同语义、只是形状不同"的对应物（followUp），就在适配器里翻译。
- pi 的 `followUp`（pi-backend.ts 第 201 行）发 `buildFollowUpCommand({ message })`，走 pi 31 命令契约（`src/server/kernel/pi/protocol/commands.ts` 的 `buildFollowUpCommand`）。`continue` 复用它，只是把提示文本固定为"继续未完成的工作…"——这条提示文本是适配器层的业务内容，写死在 `PiBackend` 里，属"适配器翻译"的固有成本（翻译需要源语和目标语的对应关系）。
- **dsh = 原生 RPC**（`src/server/kernel/dsh/backend/dsh-backend.ts` 第 207–211 行）：`async continue(): Promise<void> { await this.requestSession(DSH_METHODS.sessionContinue, { sessionId: this.sessionId }); }`。dsh 内核有原生的 `session/continue` 方法（`DSH_METHODS.sessionContinue = "session/continue"`，`src/server/kernel/dsh/protocol/dsh-methods.ts` 第 22 行），服务端按 turn/end reason 语义分发——重挂 goal 或注入续跑提示。
- dsh 的懒探测缺面（dsh-backend.ts 第 208 行注释 + `requestSession` 的 `recordMissing` 机制）：旧 dsh 内核若缺 `session/continue` 方法，首次调用失败（unknown method）时记进 `capabilities.dsh.missing` 并抛清晰错误（`dsh-backend.test.ts` 第 91–95 行断言"continue 未知方法（旧 dsh 内核）：记缺面 + 抛清晰错误"）。这是 `DshCapabilities`（backend.ts 第 164 行）懒探测面的落地，与 `continue` 的"可缺面"语义闭环：内核缺面 → 记缺面 → 抛错 → 壳显式降级。
- 两边的差异本质：pi 把 continue 降级成"再喂一条提示"，dsh 把 continue 交给服务端语义化处理。前者是翻译（无语义命令时的适配器补面），后者是原生（有语义命令时的直接映射）——同一个第八意图，两种实现形态，renderer 无感。这正是 §1.5"内核先抽象、后实现"的示范：抽象是 `continue?`，pi 的实现是 followUp 翻译，dsh 的实现是 session/continue RPC。

## 7 continue 与 retry 的分界（语义对照）

- 两个按钮相邻挂在 assistant 消息上（continue `order: 40`、retry `order: 50`），但语义完全不同，必须分清：
  - **continue**：原地续跑。目标消息是"异常停机"（`error` / `stopped`），动作是 `ctx.messaging.continue()`，不 fork、不重发旧消息，lineage 拓扑不变。它适合"工具失败/LLM 失败/用户不小心停了，想让模型接着干"。
  - **retry**：回退重跑。目标消息是任意 assistant 节点，动作是 `ctx.tree.fork(sessionFile, userMsg.id)` 先分叉、再 `ctx.messaging.prompt(text)` 重发那条用户消息，开一条新 lineage。它适合"这条回复我不满意，换个分支重新生成"。
- 判据一句话：**要不要重发用户消息**。continue 不重发（模型从已生成的历史继续），retry 重发（找到最近一条 user 消息重新 prompt）。这条判据直接映射到两个内核意图——`continue?`（第八意图）vs `fork` + `prompt`（核心分支意图 + 消息意图）。
- 视觉上的差异也强化了这条分界：continue 是 `Play` 图标、单拍触发（低风险，幂等）；retry 是 `RotateCcw` 图标、`useArmConfirm` 两步武装确认（第 63–65 行"点一下变确认？再点执行"，高风险，改变 lineage 拓扑）。低风险动作单拍、高风险动作武装，这是 `packages/react/src/inline-confirm.tsx` 的 `useArmConfirm` 原语被 retry 采用、continue 不用的原因。
- 两个插件的 `dependsOn: ["timeline"]` 相同、`when: { role: ["assistant"] }` 相同、`placement: "left"` 相同，只有 `order` 和动作不同——这保证了它们在 assistant 消息上相邻但各司其职，用户一眼能区分"继续"和"重试"。

## 8 与其他插件/槽位交互（专节）

- **贡献的槽位名**：`messageActions`（`ContinueAction`，`id: "continue"`，`placement: "left"`，`when: { role: ["assistant"] }`，`order: 40`）。消费方是 timeline 插件（timeline 查 `messageActions` 槽渲染消息行动作按钮）。
- **dependsOn**：`["timeline"]`——continue 的按钮由 timeline 挂载，声明 dependsOn 是"凡消费别人的槽位就声明"的生命周期护栏（§8.2）。
- **不贡献、不消费的槽位**：continue 不贡献 `mainView` / `sidebar` / `sidePanel` / `blockRenderers` 等任何渲染槽，不 export `channels`，不在事件总线上 `emit` / `invoke` / `on` 任何插件 channel。它是"单槽、单动作"的极简插件，与其他壳插件之间唯一的耦合是 timeline 对 `messageActions` 的消费。
- **消费的框架 API**：`ctx.messaging.continue()`（`MessagingApi.continue`）+ `useSessionStore().streaming`（读框架 store 的流式状态，只读不写）+ `useTranslation().t`（i18n）。无权限声明（`plugin.json` 无 `permissions` 字段）——continue 只用核心默认能力。
- **与 retry 的槽位并列**：两个插件在同一槽位 `messageActions` 的同一 `placement` / 同一 `when` 下各贡献一项，靠 `order`（40 vs 50）排序。这是"多个插件往同一槽位挂同类项"的确定性排序案例：框架按 `order` 升序，同 order 按 source 优先级（builtin < installed < user < project），确定性不随机。

## 9 消息动作槽的消费链

- continue 的按钮不是自己挂到 DOM 上的，而是经 `messageActions` 槽的三段式消费链：圆心契约定义形状 → registry 注册 → renderer hook 查询 → timeline 渲染。这条链的每一环都值得单独看清楚，因为它决定了"为什么 continue 插件只需 export 一个组件、不用管挂载"。
- 契约单源是 `MessageActionContribution`（`packages/shared/src/domain/contributions.ts` 第 170 行）：`{ id, component, placement?, when?, order? }`。continue 的 manifest 贡献 `{ id: "continue", component: "ContinueAction", placement: "left", when: { role: ["assistant"] }, order: 40 }` 就是往这个形状里填值，插件代码里不再出现 `"continue"` / `"ContinueAction"` 这些字符串（§8.3 零硬编码——它们只住在 manifest 与 export 名里，由框架自动匹配）。
- renderer 侧查询 hook 是 `useMessageActions`（`packages/react/src/message-actions.ts` 第 15 行）：`const pluginsNonce = useUiStore((s) => s.pluginsNonce)`，`window.kernel.slots.messageActions()` 拉全部贡献项，缓存 `{ nonce, data }`，`nonce` 变化（插件增删）时失效重拉。这是所有 `*` 槽的通用"同 nonce 单发、失效重拉"范式——continue 不感知这个 hook，但它决定了按钮何时出现。
- 组件解析是 `resolveMessageActionComponent(pluginId, component)`（`message-actions.ts` 第 31 行）：`asReactComponent(getPluginComponent(pluginId, component))`，`getPluginComponent` 从插件 module exports 里按名取组件（§7.4 组件自动匹配）。timeline 查槽后调它把 `ContinueAction` 从 continue 插件的 exports 里取出来，`as React.ComponentType<MessageActionProps>` 收窄类型。
- `when: { role: ["assistant"] }` 是消费方（timeline）在渲染前的过滤条件：timeline 遍历消息行的 `messageActions` 贡献，按 `when.role` 判断该消息是否显示此按钮。continue 声明只对 assistant 角色显示，user / toolResult 消息上不出按钮——这与 `ContinueAction` 内部的 `message.role !== "assistant"` 守卫（第 39 行）是**双重过滤**：manifest 层粗筛（消费方不渲染），组件层精筛（渲染了也 return null）。双保险是因为 `when` 是可选字段（缺省=所有角色），组件自身必须自证。

## 10 状态标记来源：error / stopped 是怎么被置上的

- continue 按钮的可见性完全取决于 `NeutralMessage.error` / `NeutralMessage.stopped` 两个标记（第 40 行守卫），这两个标记不是插件写的，是框架在事件增量里按 `SessionEvent` 置上的——理解它们的来源才能理解 continue 何时出现。
- 两个标记的定义在 `packages/shared/src/domain/events/session-state.ts`：`stopped?`（第 189 行）"用户点停止或生成失败后=true，保留已收到的部分内容，标已停止提示"；`error?`（第 191 行）"生成失败（进程 crash/RPC reject/toolCall isError）=true，驱动 inline 红条"。`NeutralMessage`（第 169 行）注释明说"有状态对象（非纯投影）：pending/stopped/error 标记驱动渲染层视觉态"。
- 置位逻辑在 renderer 侧的 `applyEvent`（`src/web/stores/session-store.ts` 第 195 行）：`messageStart` 事件把新 assistant 消息置 `pending: true`；`messageEnd` 把 `pending: false, stopped: false`（第 237 行 `...msg, startedAt: ..., pending: false, stopped: false`）；生成失败（工具失败/进程 crash）的对应事件把 `error` / `stopped` 置 true。这是一条"事件增量 → 消息标记"的纯函数链，continue 只是这条链的下游消费者。
- 与 `stopped` 语义的边界：`stopped` 是"生成被中断（用户点停止或失败），但已有部分内容保留"；`error` 是"生成失败"的更尖锐信号（进程 crash / RPC reject / toolCall isError）。两者是或关系（`message.error !== true && message.stopped !== true` 都 false 才不显示），因为"用户点停止"（stopped，无 error）和"工具执行失败"（error + 可能 stopped）都代表"有未完成的工作可续"。
- 这也解释了 continue 与 retry 的可见性差异：retry 不判这两个标记（每条 assistant 都显示），continue 只在这两个标记至少一个为 true 时显示。continue 是"续上被打断的工作"，retry 是"重跑不满意的结果"，一个面向中断态、一个面向不满态。

## 11 QA

**Q：continue 为什么是第八意图、要抬进中立契约，而不是留在 pi 扩展面？**

因为"异常停机后原地续跑"是壳必须向**每一个**内核索要的通用操作，不是 pi 专属。pi 有 followUp 可以翻译、dsh 有 session/continue RPC 可以直连，两个内核都能兑现，符合 §1.5"答得上（每个内核都能兑现或显式不支持）→ 进中立契约"。留在 pi 扩展面会让 dsh 下续跑入口直接消失，而抬进契约后 dsh 也能续跑，只是实现形态不同（翻译 vs 原生）。

**Q：pi 的 continue 翻译成 followUp 一条中文提示，这算"壳写死内容"违规吗？**

不违规，但要分清边界。`PiBackend.continue` 里那条"继续未完成的工作…"提示是**适配器翻译**的固有内容（§7.6 三分法的"适配器翻译"），不是壳插件的内容泄漏——它住在 `src/server/kernel/pi/backend/pi-backend.ts`（内核适配层），不是 `packages/shared` 圆心、也不是 `src/plugins`。圆心只有 `continue?` 的接口形状，提示文本是 pi 适配器"没有语义命令时的翻译策略"，属内核专属内容，允许住在适配器。

**Q：生成进行中点继续，会怎样？**

`ContinueAction.handleContinue` 第 26–29 行先查 `streaming`，为 true 直接 toast "生成进行中，无法继续"并 return，不调 `ctx.messaging.continue()`。这是前端第一道防并发。后端 `session-store.continue` 不额外查 streaming（它查的是 `proc.backend.alive`），因为 renderer 的 streaming 态来自框架 store（`applySnapshot` 里 `streaming = snapshot.state?.isStreaming`），与后端进程态在绝大多数情况一致，前端拦截足够；即使前端漏了，两条 continue 也会被内核按自己的并发语义串行处理。

**Q：continue 按钮为什么不加 retry 那种两步确认？**

因为 continue 是低风险、幂等动作：它不 fork、不重发旧消息、不改变 lineage 拓扑，最坏结果是模型接着上一段输出继续（用户若不想要可再点停止）。retry 会开新 lineage、重发消息，属于"改变历史结构"的高风险动作，所以用 `useArmConfirm` 武装。低风险单拍、高风险武装，这是 inline-confirm.tsx 设计里"武装形态"与"直接执行"的分工。

**Q：dsh 旧内核缺 session/continue 时，用户点继续看到什么？**

`DshBackend.continue` 走 `requestSession(DSH_METHODS.sessionContinue, ...)`，旧内核 unknown method 会被 `requestSession` 记进 `capabilities.dsh.missing` 并抛清晰错误，`ContinueAction` catch 到后 toast "继续失败：缺少 session/continue（或类似错误）"。壳不伪造成功、不静默吞掉——这是 §7.6"显式降级"的完整链路：内核缺面 → 记缺面 → 抛错 → UI 呈现错误。

**Q：continue 只声明了 zh-CN 和 en 两个 locale，用户切到德文会怎样？**

`useTranslation` 的 `t("shell.continue")` 在德文下找不到 `continue.shell` 的 de 资源，会回退到 i18next 的 fallback 语言（通常 en）或直接显示 key。这是 continue 的语言覆盖缺口（retry 有 zh-CN/en/zh-TW/de 四个 locale，continue 只有两个）——功能不受影响，但德文用户看到的文案是英文或 key。补齐 de/zh-TW 是纯文案增量，无机制改动。

**Q：continue 的按钮显示条件为什么是 manifest `when` 和组件守卫双重的？**

因为 `when: { role: ["assistant"] }` 是可选字段（`MessageActionContribution.when?`，缺省=所有角色），且只按 role 过滤、不按 `error` / `stopped` 过滤——它回答不了"这条 assistant 消息是不是异常停机"。真正回答这个问题的是组件内部的 `message.error !== true && message.stopped !== true` 守卫（第 40 行）。所以两层各有分工：manifest 的 `when.role` 是消费方（timeline）的粗筛（user/toolResult 消息直接不渲染），组件的 `error`/`stopped` 是精筛（assistant 消息里只对异常停机的显示）。缺一层都会错：缺 manifest 层会在 user 消息上多渲一遍（组件再 return null，浪费）；缺组件层会让所有 assistant 消息都显示按钮（正常完成的也显示，语义就错了）。
