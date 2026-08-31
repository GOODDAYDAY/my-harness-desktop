# ask 插件技术文档

> **修订（提问进 timeline）**：提问交互已从「sidebar 常驻模态对话框（AskHost）→ composerTop 常驻卡片（AskComposer）」收敛为**时间线内联渲染（AskQuestionCard：问题气泡 + 选项 chips + 自定义输入）**。`plugin.json` 现只贡献 `blockRenderers` 一个槽，`AskHost`/`AskComposer` 已移除，`ask-host.tsx` 仅留档。下面的历史段落里对「AskHost 挂在 sidebar」「AskComposer」的描述已过时，以本节修订为准。

ask 是五个会话域插件里唯一一个"双向"插件：其余四个都是把用户意图往下游推（续跑、重试、标钉、录音转字），ask 则是把**内核的意图往上推**——内核在生成中途挂起、向用户要一个确认/一个选择/一段补充信息，ask 把这个请求渲染成**会话流里的一条问题气泡（含选项 chips + 自定义输入）**，再把用户答案回填给内核，让生成继续。它横跨三条边界：壳插件 `renderer/`（`AskQuestionCard` 一个组件）、pi 内核插件 `pi-extension/`（给 pi 内核补 `ask_user_question` 工具）、以及圆心中立契约（`Question` / `QuestionAnswer` / `QuestionRequestEvent` 三种中性类型 + `BaseBackend.answerQuestion?` 一条可缺面意图）。pi 内核走 `extension_ui_request` / `extension_ui_response` 帧，dsh 内核走文件侧车桥，两边在适配器层都被投成同一条中性提问事件，ask 的渲染代码不出现任何内核身份分支——这是 §7.5"壳只认中性事件"在插件层的一次完整落地。

## 1 职责与边界

- ask 的职责只有一句：**把内核铸造的提问转成可交互 UI，把用户答案原样带回**。它不发起任何会话操作（不 prompt、不 fork、不 continue），不读任何内核存储格式，不拥有任何会话状态——`AskQuestionCard` 运行中态里的 `pending` 只是当前待答的那道题的临时内存态，答案一回填立刻清空。
- 高内聚四件套在这里只落了两件半：`renderer/`（桌面 UI）是壳插件本体，`pi-extension/` 是给 pi 补 `ask_user_question` 工具的 TS 扩展；dsh 侧**没有**独立的 `dsh-extension/` 目录——dsh 的 `ask_user_question` 工具实现收编在壳后端的内核适配目录 `src/server/kernel/dsh/extension/dsh-extension/index.mjs`（注释明确写"合并原 ask/goal/read-claude-md/skill-manager 四个 dsh 扩展"），这是 ask 与 goal 插件在四件套布局上的一个已知不对称，理由见 §9。
- 依赖严格向内：`renderer/index.tsx` 只 `export` 组件、`renderer/ask-host.tsx` 从 `@my-harness-desktop/react` 取 `usePluginContext`、从 `@my-harness-desktop/shared` 取 `Question` / `QuestionRequestEvent` 类型，`renderer/ask-question-card.tsx` 从 `@my-harness-desktop/react` 取 `ToolCallBlock` 类型——没有任何一处 import 壳后端、内核实现或具体内核的线协议。
- `pi-extension/index.ts` 顶部注释写明一条纪律：**类型不 import 官方 `@earendil-works/pi-coding-agent`**（内核 node_modules 里的类型仓库 tsconfig 够不到），而是手写窄结构 `AskOption` / `AskQuestion` / `AskParams` / `AskAnswer` / `AskUi` / `AskExecuteContext` / `AskToolDefinition` / `AskApi`，与 toolgate / subagent-extension / llm-recorder 同纪律。这些手写类型是对 pi 内核线协议的本地窄化，不是对圆心契约的复制——圆心契约（`Question` / `QuestionAnswer`）仍是单源，pi 扩展只在 `execute` 内部消费 `ctx.ui.select/input`。

## 2 目录与文件清单

```
src/plugins/sessions/ask/
├── plugin.json
├── renderer/
│   ├── index.tsx          # 只 re-export AskQuestionCard（框架按 component 名自动匹配）
│   ├── ask-question-card.tsx  # AskQuestionCard：时间线内联「问题气泡 + 选项 chips + 输入」（运行中）+ 摘要（结算后）
│   └── ask-host.tsx       # 留档（AskHost/AskComposer 已并入 ask-question-card，无导出、不被引用）
└── pi-extension/
    └── index.ts           # pi 内核扩展：registerTool("ask_user_question", …)
```

- `plugin.json` 只贡献 `blockRenderers` 一个槽：`{ id: "ask", block: "toolCall", names: ["ask_user_question"], component: "AskQuestionCard" }`；另声明 `piExtension: "./pi-extension"`，这是框架读 manifest 后把本目录同步进 pi 内核扩展目录的标记（`src/server/kernel/pi/extension/pi-extension-installer.ts` 的 `piExtensionEnsure` 语义）。
- `renderer/index.tsx` 只有一行 re-export（`export { AskQuestionCard } from "./ask-question-card"`），不 export `channels`——ask 不声明任何事件总线 channel，它消费的是 `ctx.sessions.onQuestion` / `ctx.sessions.answerQuestion` 这套**内核会话 API**，不是插件间事件通道（这两者的区分见 §10）。
- `ask-question-card.tsx` 是唯一渲染件：运行中（`toolCall.state` 为 pending/running）内联渲染「问题气泡 + 选项 chips + 自定义输入 + 分页 + 跳过/放弃」，订阅 `ctx.sessions.onQuestion` 拿 `requestId + questions`、作答经 `ctx.sessions.answerQuestion` 回填；结算后按 `toolCall.result.answers` 出摘要（`N/M answered`），可折叠展开看逐条答案。
- `pi-extension/index.ts` 是 pi 内核扩展（167 行），`export default function ask(pi: AskApi)` 里 `pi.registerTool({...})`，`execute` 逐题调 `ctx.ui.select` / `ctx.ui.input`，自定义答案经哨兵选项 `CUSTOM_SENTINEL = "Type something."` 转入 `ctx.ui.input`。

## 3 中立契约：提问的形状（圆心单源）

- 提问的中性形状全部定义在 `packages/shared/src/domain/events/kernel-event.ts`，这是圆心唯一源，pi 的 `extension_ui` 帧和 dsh 的文件侧车桥都往这里投。三个类型：
  - `Question`（第 29 行）：`{ id: string; question: string; header?: string; options?: { label: string; description?: string }[]; multi_select?: boolean }`。`id` 是"稳定 id，答案里原样回显"，`question` 是问句正文，`options` 缺省/空数组 = 自由输入，`multi_select` 默认 false。
  - `QuestionAnswer`（第 43 行）：`{ id: string; selected: string[]; custom?: string }`。`id` 对应 `Question.id`，`selected` 是选中的选项 label（自由输入/跳过时为空），`custom` 是自定义输入（哨兵选项进入时）。
  - `QuestionRequestEvent`（第 53 行）：`{ kind: "question"; requestId: string; sessionKey: string; questions: Question[] }`。`requestId` 是内核铸造的提问 id，`answerQuestion` 回填时原样带回；`sessionKey` 是请求来源会话（`procs` Map 的 key）；`questions` 是中性问题数组（一次可多题）。
- `QuestionRequestEvent` 是 `KernelEvent` 联合（第 131 行）的成员之一，与 `SessionMessageEvent` / `ProcessExitEvent` / `RpcErrorEvent` / `KernelChangedEvent` / `CapabilityDegradedEvent` 并列。注意它**不是** `SessionEvent` 的成员——`SessionEvent` 是"激活会话视图流"，`KernelEvent` 是"全量信息流"，提问走的是后者（`onQuestion` 是独立于 `onEvent` / `onKernelEvent` 的第三条订阅口，见 §7）。
- 回填入口是 `BaseBackend.answerQuestion?`（`packages/shared/src/domain/backend.ts` 第 139 行）：`answerQuestion?(questionId: string, answers: QuestionAnswer[]): Promise<void>`，注释写明"pi=extension_ui_response 帧翻译，dsh=文件侧车（阶段一）/session/answer（阶段二）"。它是可缺面意图（带 `?`），`AbstractBackend` 的缺面默认是抛错（CLAUDE.md §9.4 的 4 条缺面默认之一）——内核不支持提问时壳显式报"当前内核不支持交互式提问"，不静默、不伪造。
- `ExtensionUIResponse`（kernel-event.ts 第 142 行）是 pi 适配器内部的回复形状（`{ type: "extension_ui_response"; id; value?; confirmed?; cancelled? }`），标注"pi 适配器内部，不属中性事件"——它是 `QuestionAnswer[]` 在 pi 侧落地成线协议帧的翻译产物，不出圆心。

## 4 plugin.json 与贡献的槽

- 槽位契约 `SidebarContribution`（`packages/shared/src/domain/contributions.ts` 第 110 行）定义了 `sidebar` 贡献项：`{ id, title, component, order?, group? }`，`group: "main"` 使 `AskHost` 与 sub-agent 的 `SubAgentSection` 同组共享一个 Panel。ask 选 `order: 99` 排到 main 组末尾。
- `AskHost` 挂在 `sidebar` 槽的"常驻"手法（`ask-host.tsx` 第 4 行注释明说"挂在 sidebar 槽常驻（sub-agent 的 SubAgentSection 同款手法）：无请求时 return null，不占左栏"）是关键设计：组件永远挂载、`useEffect` 里的 `onQuestion` 订阅永远活着，但没有待答问题时渲染 `null`——提问是低频且异步到达的，若按需挂载，问题到达时组件可能还没起来，订阅就漏了。
- 槽位契约 `BlockRendererContribution`（contributions.ts 第 465 行）定义了 `blockRenderers` 贡献项：`{ id, block, names?, component, order? }`，`block: "toolCall"` + `names: ["ask_user_question"]` 表示"只认工具名为 `ask_user_question` 的工具卡"。这是特化层（声明 `names` 精确命中）优先于通用层的语义——`ask_user_question` 这个工具卡不再走 timeline 的通用工具卡渲染，改由 `AskQuestionCard` 呈现摘要。
- `AskQuestionCard` 与 DSH 的 `AskQuestionRow` 同语义（`ask-question-card.tsx` 第 2 行注释）：摘要展示交互结果而非 args 全文；运行中显示 `waiting`，结算后展示 `N/M answered` 或 `cancelled`。交互收集由 `AskHost` 承担，卡片只做时间线上的"事后可读摘要"，不做交互——交互发生在当下（模态框），摘要发生在回看（时间线），两条路径互补。

## 5 渲染/事件流：pi 路径（extension_ui 帧翻译）

- pi 侧的完整提问链路是六跳，每一跳都在特定文件落地，值得逐跳展开：
  - **第 1 跳**：pi 内核扩展 `execute` 调 `ctx.ui.select(title, options)` / `ctx.ui.input(title)`（`pi-extension/index.ts` 第 147 / 152 / 157 行）。`ctx.ui.select/input` 是 pi 内核暴露给扩展的 RPC 安全原语，内核据此向桌面端 stdin 写一个 `extension_ui_request` 帧并挂起等待回复。
  - **第 2 跳**：壳后端 `src/server/kernel/pi/backend/rpc-adapter.ts` 的 `handleLine`（第 224 行）解析 stdout 行，`if (data.type === "extension_ui_request")` 分支（第 233 行）先登记一个 **60 秒超时定时器**（`extUiTimeouts.set(req.id, timer)`，第 236–240 行，超时自动回 `{ cancelled: true }` 防止内核无限挂起），再遍历 `extUiListeners` 投递。
  - **第 3 跳**：`PiBackend.onQuestion`（`src/server/kernel/pi/backend/pi-backend.ts` 第 354 行）订阅 `adapter.onExtensionUI`，**只认 `select` 与 `input` 两种 method，其余显式降级不投**（第 356 行 `if (req.method !== "select" && req.method !== "input") return`），把 `req.payload.title` 当问句、`req.payload.options` 当选项，翻译成 `Question[]` 后 `cb({ requestId: req.id, questions: [{ id: `${req.id}-0`, question: title, options }] })`。
  - **第 4 跳**：`src/server/application/sessions/session-store.ts` 的装配段（第 459–470 行）在 `bindProcEvents` 里调 `pi.onQuestion((req) => {...})`，把 pi 的提问包成 `QuestionRequestEvent`（`kind: "question"`，`sessionKey: proc.key`），既 `this.dispatchKernel(questionEvent)` 汇入全量事件流，又遍历 `this.questionListeners` 逐个回调。
  - **第 5 跳**：renderer 侧 `AskHost` 的 `useEffect`（`ask-host.tsx` 第 15–23 行）`ctx.sessions.onQuestion((req) => {...})`，取 `req.questions?.[0]`，`setPending({ requestId: req.requestId, question: q })`。注意这里**只取第一题**（`questions?.[0]`）——pi 的 `extension_ui` 一帧一题，`questions` 数组长度恒为 1，`[0]` 是安全解包。
  - **第 6 跳**：用户点按钮/回车，`AskHost.reply`（第 32–40 行）构造 `QuestionAnswer[]` 后 `void ctx.sessions.answerQuestion(requestId, answers)`，经 `session-store.answerQuestion`（第 1104 行）→ `PiBackend.answerQuestion`（`pi-backend.ts` 第 365 行）→ `adapter.sendExtensionUIResponse`（`rpc-adapter.ts` 第 201 行，`fire-and-forget` 写 stdin 的 `extension_ui_response` 帧，不走 correlator）。
- `PiBackend.answerQuestion` 的翻译语义（第 365–372 行）是关键：它只取 `answers[0]`，`value = first?.custom ?? first?.selected[0]`，`value` 为空/undefined 时发 `{ cancelled: true }`，否则发 `{ value }`——即"单选值 + 可空取消"的二元语义。pi 的 `extension_ui_response` 帧是单值帧，装不下 `multi_select` 的多选数组，这正是 §9 里 pi 扩展把 `multi_select` 降级为单选的原因，两边在语义上对齐。
- 60 秒超时（`rpc-adapter.ts` 第 236–240 行）是"事件驱动不 sleep"的反面补强：正常流程是用户回填触发取消超时（`sendExtensionUIResponse` 里 `clearTimeout`，第 205–206 行），只有用户一直不回、内核挂起时才由超时兜底回 `cancelled`——超时是兜底护栏不是主路径。

## 6 渲染/事件流：dsh 路径（文件侧车桥）

- dsh 内核的提问不走帧，走**文件侧车桥**：dsh 的 `ask_user_question` 工具（`src/server/kernel/dsh/extension/dsh-extension/index.mjs` 第 74 行起）在 `execute` 里把问句写到 `~/.pi/agent/.my-harness-desktop-questions/<requestId>.json`，然后**轮询** `<requestId>.answer.json`（第 77 行注释 + 第 455 行写文件、第 96/102 行 `rmSync` 清理）。
- 这个文件侧车桥在适配器层被收编为事件驱动，收编点在 `src/server/kernel/dsh/manager/dsh-question-bridge.ts` 的 `DshQuestionBridge` 类：`start()`（第 45 行）先 `mkdirSync` 确保目录、全量 `scan()`，再 `watch(DSH_QUESTIONS_DIR, { persistent: false }, () => this.scan())`——**用 `fs.watch` 把 dsh 的文件落盘变成事件，renderer 不再轮询**（第 3 行注释"事件驱动，不再 renderer 轮询"）。
- `scan()`（第 56 行）读目录里每个非 `.answer.json` 的 `.json`，按 `requestId` 去重（`this.emitted.has(requestId)`，第 66 行），`JSON.parse` 成 `DshQuestionRequest` 后回调订阅方。全局单例（非 per-session）：dsh 的 `sessionId` 由服务端惰性创建，per-backend 无法可靠过滤问句归属，故桥对目录全量扫描（第 8 行注释）。
- 桥的投递经 `session-store.injectQuestion`（第 1120 行）汇入统一中性通道：`injectQuestion(req)` 只遍历 `this.questionListeners`，**不进** `dispatchKernel`——与 pi 路径（既进 `dispatchKernel` 又进 `questionListeners`）的差异是历史形态差异，两个内核的提问最终都命中同一组 `questionListeners`，renderer 的 `AskHost` 无感。
- 答案回填走 `DshBackend.answerQuestion`（`src/server/kernel/dsh/backend/dsh-backend.ts` 第 214 行）→ `writeDshAnswer(questionId, answers)`（`dsh-question-bridge.ts` 第 31 行），`writeFileSync(answerPath, JSON.stringify({ requestId, answers }))`——dsh 扩展轮询到答案文件后读走回灌模型。这是"文件侧车桥被封装进适配器，替换时桌面无感"的边界：桌面 renderer 只调 `ctx.sessions.answerQuestion`，写文件还是写帧由适配器决定。
- 阶段演进标注在契约里（backend.ts 第 138 行注释"dsh=文件侧车（阶段一）/session/answer（阶段二）"）：当前是阶段一的文件侧车，终态是 dsh 提供 `session/answer` RPC 后由 `DshBackend.answerQuestion` 改走 RPC，桥退场——renderer 与圆心契约零改动，只换适配器实现。

## 7 AskHost：常驻消费方与交互语义

- `AskHost` 的订阅生命周期（第 15–23 行）：`useEffect(() => { const off = ctx.sessions.onQuestion((req) => {...}); return off; }, [ctx])`，依赖数组是 `[ctx]`（`usePluginContext` 返回的稳定引用），订阅只建一次、卸载时取消——这是 §8.2"订阅返回清理函数"的规范写法，漏掉 `return off` 会在组件重挂时叠订阅、一道题弹两个框。
- `onQuestion` 回调里的防御（第 17–18 行）：`const q = req.questions?.[0]; if (!q || typeof q.question !== "string") return;` 双保险——没有题或问句非字符串直接忽略，不因坏数据弹空框。
- 模态框是**全屏遮罩 + 居中卡**（第 48–59 行）：`position: fixed; inset: 0; zIndex: 9999`，点遮罩 `onClick={() => reply(undefined, true)}` 即取消。遮罩与卡片是两段式：卡片 `onClick={(e) => e.stopPropagation()}` 阻断冒泡，点卡片内部不触发取消。配色全走主题 token（`var(--color-surface)` / `var(--radius-lg)` 等），零写死色值。
- `reply` 的答案构造三分（第 32–40 行）是核心业务逻辑：
  - `cancelled || value === undefined` → `[{ id: question.id, selected: [] }]`（取消/跳过，`selected` 空数组表示"没选"）。
  - `hasOptions`（有选项）→ `[{ id: question.id, selected: [value] }]`（单选，选中的 label 进 `selected` 数组）。
  - 无选项（自由输入）→ `[{ id: question.id, selected: [], custom: value }]`（自定义文本进 `custom`）。
  - 这条三分与 `PiBackend.answerQuestion` 的 `first?.custom ?? first?.selected[0]` 解码一一对应：有 `custom` 取 `custom`，否则取 `selected[0]`，都没有就 `cancelled`。
- `hasOptions` 的判定（第 28–29 行）：`const options = (question.options ?? []).map((o) => o.label ?? "").filter(Boolean); const hasOptions = options.length > 0;`——先把 `options` 压成 label 字符串数组并滤掉空 label，再判非空。选项渲染（第 78–99 行）是竖向按钮列，每个 option 一个 `button`，点击 `reply(opt)`。
- 自由输入分支（第 101–133 行）：`input` + `autoFocus`，`onKeyDown` 里 Enter 触发 `submitCustom`（`text.trim()` 非空才 `reply(text)`），配一个 `Submit` 按钮。右下角 `Cancel` 按钮（第 135–149 行）与遮罩点击同语义，都走 `reply(undefined, true)`。
- 无 i18n：`ask-host.tsx` 里 `placeholder="输入你的回答…"`、`Submit`、`Cancel` 是**写死的文案**——这是 ask 插件的一个已知偏离（其余四个插件都走 `locales/` + `useTranslation`），ask 目录没有 `locales/`，插件靠 `title = question.header ?? question.question` 直接把内核问句当标题，UI 自身的按钮文案是硬编码。这不影响机制正确性，但与 §1.2"文案外挂"的纪律有差距，属内容泄漏待收。

## 8 AskQuestionCard：时间线摘要卡

- `AskQuestionCard` 的 props 契约是 blockRenderers 的标准 props 之一（`{ toolCall: ToolCallBlock; collapseDefault?: boolean }`，第 12 行），`ToolCallBlock` 来自 `@my-harness-desktop/react`，含 `state`（`pending` / `running` / 结算态）、`result`、`isError` 字段。
- 摘要状态机（第 16–27 行）：`isStreaming = toolCall.state === "pending" || toolCall.state === "running"`；`result = toolCall.result?.answers`；`answeredCount` 数 `selected.length > 0 || custom.length > 0` 的答案，`totalCount = result.length`。`summary` 四态：`isStreaming` → `"waiting"`；`result === undefined` → `"answered"`；`totalCount > 0` → `` `${answeredCount}/${totalCount} answered` ``；否则 `"answered"`。这是把"运行中/已答/部分答"三种语义压缩进一行摘要，不展示 args 全文（与 DSH `AskQuestionRow` 同语义）。
- 左边框颜色（第 29–33 行）：`isError` → `var(--color-accent-error)`，`isStreaming` → `var(--color-accent-success)`，否则 `var(--color-primary)`——三态用三个主题 token，不写死色值。
- 可折叠展开（第 44–58 行）：整行 `role="button"` + `tabIndex={0}`，点击 `setCollapsed((c) => !c)`，键盘 Enter/Space 也可切换（第 47 行 `onKeyDown`）。`collapseDefault` 默认 `true`，`useEffect(() => setCollapsed(collapseDefault), [collapseDefault])` 让外部可覆盖默认折叠态。
- 展开体（第 59–71 行）逐条 `result.map` 渲染：每行左边 `a.id`（问题 id），右边 `a.custom ? "(wrote) ${a.custom}" : (a.selected?.join(", ") || "(skipped)")`——自定义答案标 `(wrote)`，有选项标选中的 label 列表，都没有标 `(skipped)`。这是时间线上"这次提问到底答了什么"的可读回溯，与 `AskHost` 的交互实时性形成互补。

## 9 pi 内核扩展：ask_user_question 工具

- `pi-extension/index.ts` 是 ask 给 pi 补能力的内核插件，`export default function ask(pi: AskApi)` 里 `pi.registerTool({...})`。它是 DSH `dsh-tool-ask-user` 的 pi 移植（第 2 行注释"设计 docs/design/goal-ask-pi-port.md §5"），语义对齐 DSH：**工具名 / 入参 / 出参一字不差**，只有 `execute` 内部把 DSH 的 `ctx.userQuestions.ask` 换成 pi 的 `ctx.ui.select/input`。
- 工具定义（第 94–131 行）：`name: "ask_user_question"`，`label: "Ask User"`，`executionMode: "sequential"`（逐题顺序问，一问一答），`description` 与 DSH 的 `ask_user_question` 描述逐字一致（"Ask the user a concise question when you need confirmation, a choice, or missing information before proceeding. Send one or more questions, each with a stable id that will be echoed in the answer."）。`parameters` 是 JSON Schema 对象，`questions` 数组必填，每题 `id` / `question` 必填，`header` / `options` / `multi_select` 可选。
- `execute` 的签名（第 132 行）：`async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx)`，先校验 `ctx.mode !== "tui" && ctx.mode !== "rpc"` 时返回 `error("Error: UI not available (non-interactive mode)")`（第 134 行）——非交互模式没有 UI 可问，显式报错不静默。`params.questions` 空数组时返回 `ok([], JSON.stringify({ answers: [] }))`（第 139 行）。
- 逐题循环（第 141–160 行）是核心：
  - 有选项（第 145–155 行）：`labels = q.options.map(o => o.label)`，`picked = await ctx.ui.select(q.question, [...labels, CUSTOM_SENTINEL])`——把自定义哨兵选项拼进选项末尾。`picked === undefined` → 用户取消，立即返回 `{ content: [{...}] , details: { answers } }`（第 149 行，已收集的答案保留，未答的丢弃）。`picked === CUSTOM_SENTINEL` → `custom = await ctx.ui.input(`${q.question} (custom answer)`)`。否则 `selected.push(picked)`。
  - 无选项（第 157 行）：直接 `custom = await ctx.ui.input(q.question)`。
  - 每题答案 push 进 `answers`（第 159 行）：有 custom 的 `{ id, selected, custom }`，无 custom 的 `{ id, selected }`。
- `CUSTOM_SENTINEL = "Type something."`（第 80 行）与 DSH `question.ts` 的哨兵同语义——自由文本入口伪装成一个选项，用户点它才转 `input`。这是 pi 的 `ctx.ui.select` 只有单选原语、没有"选其他并填文本"原语时的适配器翻译。
- **决策 1A**（第 8–10 行注释）：DSH 的 `multi_select` 本期降级为单选——每题一次 `ctx.ui.select`，自定义答案经哨兵选项转入 `ctx.ui.input`。`multi_select` 字段仍进 schema（对齐契约），但渲染层不呈现复选框。这是 §7.6"显式降级"的正面例子：pi 的 `extension_ui` 帧装不下多选数组（§5），不是补面而是明确降级，字段保留以对齐 DSH 契约，未来 pi 内核给多选原语时可无缝升级。
- `error` / `ok` 两个辅助函数（第 82–91 行）：`error(text)` 返回 `{ content: [{ type: "text", text }], isError: true, details: { answers: [] } }`；`ok(answers, text?)` 返回 `{ content: [{ type: "text", text: text ?? JSON.stringify({ answers }) }], details: { answers } }`——`details.answers` 是 `AskQuestionCard` 在时间线上读 `toolCall.result.answers` 的来源，`content.text` 是给模型看的纯文本（模型读不到 `details`，只读 `content`）。
- dsh 侧为何没有独立 `dsh-extension/` 目录：ask 的 dsh 工具实现合并进 `src/server/kernel/dsh/extension/dsh-extension/index.mjs`（第 388 行起 `// ---- ask:ask_user_question ----`），这是壳后端对 dsh 的**统一适配扩展**（`extension.json` 第 3 行"桌面壳对 dsh 内核的统一适配：ask_user_question 提问、goal 三工具、全局 CLAUDE.md 注入、技能启用/禁用轴"）。即 dsh 侧的"补面"不在插件目录里，而在壳后端的内核适配目录里——这是 ask / goal 这类横跨内核插件与 dsh 适配的插件，在四件套物理布局上的现实形态：pi 补面在插件自己的 `pi-extension/`，dsh 补面收在壳后端统一 dsh 扩展里，两者语义都是"给内核补能力"，物理位置随内核适配策略不同而不同。

## 10 与其他插件/槽位交互（专节）

- **贡献的槽位名**：`sidebar`（`AskHost`，`group: "main"`，`order: 99`）与 `blockRenderers`（`AskQuestionCard`，`block: "toolCall"`，`names: ["ask_user_question"]`）。两个槽都是"本插件供、别的插件消费"：`sidebar` 由壳前端左栏渲染（`AskHost` 常驻），`blockRenderers` 由 timeline 插件查槽后渲染（timeline 是 `blockRenderers` 的消费方）。
- **不贡献、但强依赖的槽位关系**：ask 不贡献 `mainView`，但它依赖 timeline 的 `blockRenderers` 消费链——若 timeline 被删，`ask_user_question` 工具卡会退回 timeline 缺省时的通用工具卡渲染（`blockRenderers` 无人查槽），但 `AskHost` 的提问模态框仍照常（它挂在 `sidebar`，不依赖 timeline）。所以 ask **不声明 `dependsOn: ["timeline"]`**：它对 timeline 的缺席是静默降级（摘要卡退化为通用卡），不是功能失效，把生命周期绑死换来的是"卡片更好看"这个非关键收益，不值得（与 session-colors 的 QA 论证同构）。
- **消费的框架 API（非事件总线 channel）**：`ctx.sessions.onQuestion` / `ctx.sessions.answerQuestion`。这两个是 `SessionsApi`（`packages/shared/src/domain/sessions.ts` 第 349 / 351 行）的成员，底层经 `window.kernel.sessions.onQuestion` / `answerQuestion` 走 HTTP/WS 到壳后端，**不是** `packages/react/src/event-bus.ts` 的插件间事件通道。容易混淆的是 `channel-contract.ts` 里的 `session.question: "session:question"` 与 `session.answerQuestion: "session:answerQuestion"`（`packages/shared/src/channel/channel-contract.ts` 第 200 / 218 行）——它们是 `window.kernel` RPC 的**线通道名**，不是插件间事件总线 channel，ask 的 renderer 不直接触碰这些字符串，它只调 `ctx.sessions.*` 类型化的 API。
- **事件总线上零交互**：ask 的 `renderer/index.tsx` 不 export `channels`，不 `emit` / `invoke` / `on` 任何插件 channel。它是纯"内核会话 API 消费方"，与其它壳插件之间没有事件耦合——这是它的隔离性来源，也是它能不声明 `dependsOn` 的根本原因。
- **与 sub-agent 的松散并列**：`AskHost` 挂在 `sidebar` 的 `group: "main"`，与 sub-agent 的 `SubAgentSection` 同组（`ask-host.tsx` 第 4 行注释明说"sub-agent 的 SubAgentSection 同款手法"）。这不是依赖，是同一槽位同一分组下两个常驻消费方的并列——两者都"无内容时 return null"，互不感知对方。

## 11 QA

**Q：pi 和 dsh 的提问机制完全不同（帧 vs 文件），为什么 ask 的 renderer 一行内核分支都没有？**

因为"翻译归适配器、渲染归插件"的边界把差异封死在适配器层。pi 的 `extension_ui_request` 帧在 `PiBackend.onQuestion`（pi-backend.ts 第 354 行）翻译成 `Question[]`，dsh 的文件落盘在 `DshQuestionBridge.scan`（dsh-question-bridge.ts 第 56 行）翻译成同一 `DshQuestionRequest`，两者最终都经 `session-store` 的 `questionListeners` 投成 `QuestionRequestEvent`。renderer 的 `AskHost` 只认 `QuestionRequestEvent`，它根本不知道也不需要知道帧和文件的区别——§7.5 三条不变量的第二条"壳只认中性事件"。

**Q：用户点了遮罩取消，内核会怎样？**

`AskHost.reply(undefined, true)` 构造 `[{ id: question.id, selected: [] }]`，`selected` 空数组到 `PiBackend.answerQuestion`（pi-backend.ts 第 367–370 行）解码为 `value === undefined` → 发 `extension_ui_response { cancelled: true }`。pi 扩展 `execute` 里 `ctx.ui.select` 拿到 undefined 时立即返回 `"User cancelled the question"`（pi-extension/index.ts 第 148–150 行），已收集的答案保留、当前题丢弃，生成继续。dsh 侧同理：`writeDshAnswer` 写 `selected: []` 的答案文件，dsh 扩展读走回灌。

**Q：为什么 `AskHost` 只取 `questions?.[0]` 而不是渲染全部题目？**

pi 的 `extension_ui` 一帧一题（`PiBackend.onQuestion` 里 `questions: [{ id: `${req.id}-0`, ... }]` 恒单元素），dsh 的文件侧车桥虽然 `questions` 可以是数组，但桥注释明说"与文件侧车桥现状（取第一个问句）语义一致"。契约层 `QuestionRequestEvent.questions` 是数组（为未来多题预留），但两个内核当前都只产单题，`AskHost` 取 `[0]` 是"当前语义"的诚实实现，不是截断——多题支持要等内核侧先有多题原语，插件只是消费方。

**Q：ask 为什么没有 `locales/`，按钮文案写死在 `ask-host.tsx`？**

这是已知偏离。ask 的 UI 文案（`Submit` / `Cancel` / `placeholder="输入你的回答…"`）硬编码在组件里，没有走 `languages` 槽。机制上不影响正确性（问句本身来自内核、是动态内容，不归 i18n 管），但按钮文案是插件自己的静态内容，按 §1.2"文案外挂"纪律该收进 `locales/`。这是演进项，不是本插件的功能缺口。

**Q：pi 扩展的 `multi_select` 为什么进了 schema 却不渲染复选框？**

决策 1A 明确降级：DSH 契约有 `multi_select`，pi 的 `ctx.ui.select` 是单选原语，装不下多选数组（§5 的 `extension_ui_response` 也是单值帧）。字段保留在 schema 是为了**契约对齐**——同一套 `ask_user_question` 工具 schema 在 pi/dsh 两侧一致，模型看到的参数形状相同，pi 侧运行时按单选实现，dsh 侧可支持多选。这是"字段进契约、能力按内核降级"的典型：不因 pi 缺多选就删字段，也不伪造多选成功。

**Q：60 秒超时和 `fs.watch` 轮询是什么关系，为什么一个用超时一个用事件？**

两者是不同内核不同机制的两套兜底，不冲突。pi 的 60 秒超时（rpc-adapter.ts 第 236 行）是**挂起兜底**：帧已发出、用户一直不回，内核进程不能永远挂住，超时自动回 `cancelled` 释放。dsh 的 `fs.watch`（dsh-question-bridge.ts 第 49 行）是**把轮询换成事件**：dsh 扩展本来靠轮询答案文件，桥在适配器层把"文件落盘"变成 `fs.watch` 事件，renderer 侧零轮询。一个解决"等不到答案"，一个解决"怎么感知到答案"，都是 §3.6"事件驱动、不轮询不 sleep"的落地。
