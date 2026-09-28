# retry 插件技术文档

retry 是会话域里"重试"语义的壳插件承载者，但它实际牵涉**两个不同概念**，必须先分清再往下读：其一是 retry 插件自己贡献的 `RetryAction` 按钮——从任意 assistant/tool 节点分叉并重新生成，走 `ctx.tree.fork` + `ctx.messaging.prompt`，是"回退重跑"；其二是 `abortRetry`——**重试能力轴**（`ctx.messaging.abortRetry`，可用性看 `capabilities.faces.retry`；此前挂在已退役的内核名袋子 `PiExtensions` 下）里"中止正在进行的自动重试"的方法，它**不是** retry 插件的代码，而是被 timeline 插件在"停止按钮"里消费（`ctx.pi.abortRetry()`）。两个概念共享"retry"这个词但语义相反：一个发起重试，一个终止重试。retry 插件的 `plugin.json` 只有 `messageActions` 一个槽位贡献，`abortRetry` 则是 pi 扩展面的投影，两者唯一的物理交集是 `session:abortRetry` 这个线通道名与 pi 31 命令里的 `abort_retry` 命令。

## 1 职责与边界

- retry 插件的职责一句话：**在 assistant 消息上提供"回退重跑"按钮**。它不拥有会话状态，不读内核存储，`handleRetry` 的整个业务就是"找到这条 assistant 消息之前最近的一条 user 消息 → 在那个 user 消息处 fork → 用那条 user 消息的文本重新 prompt"。
- 与 continue 的语义分界（已在 continue.md §7 详述）是它的命根：continue 是"原地续跑、不 fork、不重发旧消息"，retry 是"回退 fork、重发那条 user 消息"。retry 会改变 lineage 拓扑（开一条新 lineage），continue 不改变——这是 retry 需要 `useArmConfirm` 两步武装确认、continue 不需要的根本原因。
- 依赖严格向内：`renderer/index.tsx` 从 `@my-harness-desktop/react` 取 `usePluginContext` / `useSessionStore` / `useArmConfirm` / `MessageActionProps` / `NeutralMessage`，从 `react-i18next` 取 `useTranslation`，从 `lucide-react` 取 `RotateCcw` 图标。文案走 `locales/{zh-CN,zh-TW,en,de}/shell.json` 四个 locale（比 continue 多 zh-TW 与 de），六条文案键、四门语言——retry 的覆盖比 continue 完整。
- 目录形态：`plugin.json` + `renderer/index.tsx`（77 行）+ 四个 locale 文件，无 `core/`、无 `pi-extension/`、无 `dsh-extension/`。retry 消费的 `fork`（分叉归壳）与 `prompt`（消息意图）两个能力都是壳/契约层已有的通用能力，无需内核侧补面；`abortRetry` 则是 pi 已有的命令，直接投影，也无需补面。

## 2 plugin.json 与贡献的槽

- `plugin.json`：`id: "retry"`、`version: "0.4.9"`、`tier: "official"`、`dependsOn: ["timeline"]`，`contributes.messageActions` 一项 `{ id: "retry", component: "RetryAction", placement: "left", when: { role: ["assistant"] }, order: 50 }`，`contributes.languages` 四项（zh-CN / zh-TW / en / de 的 `retry.shell` 命名空间）。
- `version: "0.4.9"` 是五个插件里最高的版本号（continue 是 0.1.0、ask 是 0.1.0、voice-input 是 0.1.0、session-colors 是 0.6.0），反映 retry 是较早落地且经过多轮迭代的插件——它的 `useArmConfirm` 武装确认、错误正则解析都是迭代痕迹。
- `dependsOn: ["timeline"]` 同 continue：retry 的 `messageActions` 按钮由 timeline 查槽渲染。`when: { role: ["assistant"] }` 同 continue，`placement: "left"` 同 continue，`order: 50` 比 continue 的 `order: 40` 大——两个按钮相邻，continue 在左、retry 在右。
- `MessageActionProps`（`packages/react/src/message-actions.ts` 第 8 行）`{ message: NeutralMessage; text: string }` 是 props 契约，`RetryAction({ message })` 用 `message.id` / `message.role` 做守卫与锚点，用 `message.id` 在消息序列里定位。

## 3 RetryAction：渲染与守卫

- 显示条件（`renderer/index.tsx` 第 57 行）：`if (!message.id || message.role !== "assistant") return null;`——只要 assistant 且有 id 就显示，**不**像 continue 那样再判 `error` / `stopped`。这是两者的关键差异：continue 只在异常停机时出现，retry 在**每一条** assistant 消息上都出现（因为任何一条 assistant 回复都可能让人不满意、想重跑）。
- `useArmConfirm`（`packages/react/src/inline-confirm.tsx` 第 88 行）是两步武装确认原语：`const { armed, arm, disarm } = useArmConfirm()`，点击按钮时 `if (armed) { disarm(); void handleRetry(); return; } arm(true);`（第 62–64 行）——第一次点击把按钮文案从"重试"换成"确认重试?"并变红（`ARMED_STYLE`，第 7 行），第二次点击才真正执行。超时 6 秒（`useArmConfirm` 默认 `timeoutMs = 6000`）或 Esc 自动复位。
- `handleRetry` 用 `useCallback` 包裹，依赖 `[ctx, t, snapshot, message.id]`，四步：
  - 第 1 步：`if (!message.id) return;`——无 id 无法定位，静默返回。
    （旧版这里的第 1 步是 `if (streaming) { setToast(...); return; }`——**已删**。流式中照样能重试：拦的粒度是「在飞的那一行」而非整个会话，由 manifest 的 `when.settled` 在渲染层挡住 pending 行，`handleRetry` 里不再有全局 `streaming` 判断。详见 §4 与 `docs/design/bookmark-snapshot-fork-unify.md` §7.1/§10.1。）
  - 第 3 步（第 29–39 行）：在 `snapshot?.messages` 里 `findIndex(m => m.id === message.id)` 找到目标消息，再**向前扫描**找最近一条 `role === "user"` 的消息（第 33–35 行 `for (let i = idx; i >= 0; i--) if (msgs[i].role === "user") { userMsg = msgs[i]; break; }`）。找不到 user 消息则 `setToast(t("shell.retryNoUserMessage"))` 返回——重试的本质是"重发那条提问"，没有提问就没有重试对象。
  - 第 4 步：`await ctx.tree.fork(currentNeutralSessionId ?? "", userMsg.id, "before", { abortSource: true })`——在那条 user 消息处派生新会话（`"before"` 排除锚点本身，否则同一条 user 在派生前缀与第 5 步的重发里各出现一次）。第 1 参用**中立主键** `currentNeutralSessionId`（`useUiStore`），与另两个分叉入口（timeline rewind / session-tree）一致；`abortSource: true` 是「回退重跑」的语义前提：这条不要了，所以壳侧先中断源会话、等它落定，再派生。
  - 第 5 步（第 41–49 行）：把 `userMsg.content` 转成纯文本（string 直接用；数组则过滤 `type === "text"` 的块并 join），`await ctx.messaging.prompt(text)` 重发。
- 文本提取（第 41–48 行）是"内容块数组 → 纯文本"的一次本地解包：`typeof userMsg.content === "string"` 直接取，否则 `Array.isArray` 时 `filter(c => typeof c === "object" && c !== null && c.type === "text").map(c => String(c.text ?? "")).join("")`。这与圆心 `messageContentText`（`packages/shared/src/domain/...`）是同一语义的重复实现——retry 插件自己写了一遍，而不是 import `messageContentText`，这是已知的轻微偏离（session-colors 的 `core/pin.ts` 就 import 了 `messageContentText` 单源，retry 没有）。
- 错误呈现（第 50–53 行）：catch 后 `const m = /Error invoking remote method '[^']+': (?:Error: )?([\s\S]*)$/.exec(msg); setToast(t("shell.retryFailed", { error: m?.[1] ?? msg }))`——正则剥掉 IPC 包装（`Error invoking remote method 'xxx': ...`），只显示内核真实错误。这是"壳插件收到 handler 拒绝后自己决定怎么呈现"（§8.1 权限边界）的落地：IPC 错误是壳后端的包装，内核错误才是用户该看的。

## 4 重试的 fork 语义：派生新会话 + 中断源会话

> ⚠️ 本节旧版描述的是「fork = 在中立树里切一条会话内空分支 lineage」（`upsertNeutralLineage` + 切 `activeLineageId`）。那个语义已被 `docs/design/bookmark-snapshot-fork-unify.md` §2.1/§11.1 **推翻**：fork 的产物是**全新会话**，不是原会话内部的一条分支。以下按当前实现重写。

- **契约**：`ctx.tree.fork` 的类型是 `SessionTreeApi.fork`（`packages/shared/src/domain/sessions.ts`，`SessionTreeApi` 接口内）。签名 `fork(parentLineageId, boundary?, position?, opts?)`——它是壳的会话树操作，**不是** `BaseBackend` 的方法（分叉归壳，内核不 fork）。`opts` 是 `ForkOptions`（同文件），本轮新增的唯一字段是 `abortSource`。

- **壳后端实现**：`session-store.fork` → `deriveFromAnchor` → `deriveSession`（三个方法同文件，`fork/forkFromSession/resume` 三个入口共用这一个派生核）。`fork` 本身**零内核交互**：它把「锚点所在 lineage 的前缀」物化成一个全新的中立会话（新 `neutralSessionId`，根 `lineageId ≡ ns`，`header.derivedFrom = { kind: "fork", ... }`），置 `pendingSeed: true`，然后切激活、广播基线。真正的重跑发生在 §3 第 5 步的 `prompt`；内核侧的物化再推迟到首发时（`materializeActiveLineage` 惰性 seed）。

- **`abortSource` 是本轮新增的中断语义**：`fork` 在算前缀之前先走 `settleSourceForFork(srcNs, opts)`——`abortSource: true` 且源会话正在生成（`isBusy`）时，`await backend.abort()` → `await waitSettled(...)`（事件驱动等 `agentSettled`/终态 `messageEnd`，不 sleep 猜时长）→ 再派生。**顺序不可拆**，两个原因：① `abort()` 打的是激活会话的进程，而派生会把激活切走，先派生后 abort 就打到新会话上了；② 在飞那条的写穿触发是 `messageEnd`，不等它落定，派生前缀读到的是写了一半的中立层，缺的正是「刚答完的那条」。retry / rewind 传 `true`（隐含「这条不要了」）；「从此开新分支」/ 收藏不传（「两边都要」，源会话继续后台跑完）。

- **流式中可重试的粒度是「行」不是「会话」**：retry 按钮在 manifest 里声明 `when.settled: true`（`src/plugins/sessions/retry/plugin.json`），框架消费方（timeline 的 `message-actions-host.tsx`）经圆心谓词 `messageActionApplies`（`packages/shared/src/domain/contributions.ts`）统一筛——`message.pending === true` 的在飞行不渲染按钮，已落定的历史行照常。所以流式生成中你依然能从上一条回答重试，只是不能拿正在生成的那条当锚点。`handleRetry` 里因此不再有 `if (streaming) return` 的全局判断。

- **契约漂移已修（H1）**：第 4 步的第 1 参此前传 `snapshot?.state.sessionFile`（pi 投影路径），而契约 `SessionTreeApi.fork` 要的是 `parentLineageId`。壳侧靠 `deriveFromAnchor` 的两层兜底救回结果——先 `console.warn` 回落活跃 lineage，再靠「锚点归属纠偏」按 `boundary` 反查真正的父——所以功能正确，但代价是每次重试一条 warn，且把「挂到活跃 lineage」这条**已修过的根因**重新变成活路径（纠偏的前置条件一变就退化）。现已改传 `currentNeutralSessionId`，与另两个入口对齐；`renderer/index.test.tsx` 补了一条显式守卫（`sessionFile` 明明在场也断言第 1 参是 ns、且不含 `.jsonl`），守住不让它漂回投影路径。这是 §1.3 契约单源的收口：**签名要什么坐标系，调用方就给什么坐标系，不靠被调方兜底**。

## 5 abortRetry：pi 扩展面，不是 retry 插件

- `abortRetry` 的契约是 `PiExtensions.abortRetry`（`packages/shared/src/domain/sessions.ts` 第 292 行）："中止正在进行的自动重试"。它属于 `PiExtensions`（第 286 行）——pi 内核专属扩展面（§7.6），dsh 无此面，壳插件经 `capabilities.piExtension` 探测"有则用、无则降级"。
- `PiExtensions` 是 pi 命令的中性投影（`sessions.ts` 第 283 行注释），`abortRetry` 与 `steer` / `followUp` / `cycleModel` / `clone` / `compact` / `setAutoRetry` 等并列。它的语义对象是 pi 内核的**自动重试机制**：pi 模型失败时会按 `set_auto_retry` 开关自动重试，`abortRetry` 就是在自动重试进行中把它中止掉。
- `usePluginContext` 里 `pi` 的绑定（`packages/react/src/plugin-context.ts` 第 42 行）：`abortRetry: () => window.kernel.sessions.pi.abortRetry()`——`ctx.pi.abortRetry()` 是壳插件可调用的投影，底层走 `window.kernel.sessions.pi.abortRetry` RPC。
- 壳后端实现 `session-store.abortRetry`：`const proc = this.activeProc(); if (!proc || !proc.backend.alive) return; await this.asPi(proc).abortRetry();`。注意它**不抛错**（进程不活直接 return），与 `steer` / `followUp` 的"抛错"不同——abortRetry 是"能停就停，停不了就算了"的宽松语义。
- `asPi(proc)`（`session-store.ts` 私有方法）是类型守卫：`const pi = proc.backend.capabilities.extensions; if (!pi) throw new Error("当前后端不支持 pi 专属命令"); return pi as BackendExtensions;`——dsh 下 `capabilities.extensions` 是 undefined，`asPi` 抛错，`abortRetry` 显式降级。这是 §7.6"能力接口探测（`backend.capabilities.extensions`，中性能力名，不是 `capabilities.pi`）"的落地，不是 `if (kernel === "pi")` 硬分支。
- `PiBackend.abortRetry`（`src/server/kernel/pi/backend/pi-backend.ts` 第 205 行）：`await this.adapter.send(buildAbortRetryCommand())`——发 pi 31 命令里的 `abort_retry`。线通道名是 `session:abortRetry`（`packages/shared/src/channel/channel-contract.ts` 第 190 行），它是 `window.kernel.sessions.pi.abortRetry` RPC 的线通道，**不是**事件总线 channel。
- **消费方是 timeline 插件，不是 retry 插件**：`src/plugins/sessions/timeline/renderer/index.tsx` `handleRewindStop` 里 `if (retrying && capabilities.extension) { void ctx.pi.abortRetry(); } else { void ctx.messaging.abort(); }`——timeline 的停止按钮在"正在自动重试且 pi 扩展面可用"时调 `abortRetry` 中止自动重试，否则调 `messaging.abort` 中断普通生成。输入框区的停止按钮是另一处同样的调用。这就是"retry 插件不管 abortRetry、timeline 管 abortRetry"的边界：`abortRetry` 是停止按钮的语义分支，不是消息重试按钮的语义分支。
- 这个分工值得强调：retry 插件的 `RetryAction` 从不调 `abortRetry`。任务名"重试/abortRetry"里的 `abortRetry` 是 pi 扩展面能力，它的壳侧入口在 timeline 的停止按钮，它的契约在 `PiExtensions`，它的命令在 pi 31 命令。retry 插件只与它共享"retry"这个词，物理上没有代码交集。

## 6 与其他插件/槽位交互（专节）

- **贡献的槽位名**：`messageActions`（`RetryAction`，`id: "retry"`，`placement: "left"`，`when: { role: ["assistant"] }`，`order: 50`）。消费方是 timeline 插件。
- **dependsOn**：`["timeline"]`——retry 的按钮由 timeline 挂载，同 continue 的生命周期护栏。
- **不贡献、不消费的槽位**：retry 不贡献任何渲染槽，不 export `channels`，不在事件总线上 `emit` / `invoke` / `on`。它是单槽插件，与其它壳插件唯一耦合是 timeline 对 `messageActions` 的消费。
- **消费的框架 API**：`ctx.tree.fork`（`SessionTreeApi.fork`，分叉意图）、`ctx.messaging.prompt`（`MessagingApi.prompt`，消息意图）、`ctx.pi.abortRetry`（`PiExtensions.abortRetry`，pi 扩展面——注意 retry 插件**不**消费它，是 timeline 消费）、`useSessionStore().snapshot` / `.streaming`（只读框架 store）、`useArmConfirm`（框架共享原语）、`useTranslation().t`。
- **retry 的两个数据源**：`useSessionStore().snapshot.messages`（`SyncSnapshot.messages`，时间线消息序列——用它定位那条 user 消息）与 `useUiStore().currentNeutralSessionId`（中立主键——用它做 fork 的第 1 参）。注意 `snapshot.state.sessionFile`（投影路径）**不再是 fork 的入参**：§32 主键迁移后 path 降级为「投影线索」（打开文件/调试用），中立主键才是坐标。
- **与 continue 的槽位并列**：两个插件在 `messageActions` 同一 `placement` / 同一 `when` 下各贡献一项，`order` 40 vs 50 排序，视觉上"继续"在左、"重试"在右。这是多插件同槽位确定性排序的现场（`order` 升序，同 order 按 source 优先级）。
- **`session:abortRetry` 线通道**：属于 `window.kernel` RPC 线通道（channel-contract.ts 第 190 行），不是事件总线 channel。retry 插件的 renderer 不直接触碰这个字符串，它经 `ctx.pi.abortRetry()` 类型化 API 间接触达（且实际触达方是 timeline）。

## 7 lineage 坐标系：fork 的 boundary 语义

> 本节讲的是 `boundary` 参数在 lineage 坐标系里的语义（这部分仍成立）。但「retry 的 fork 会新增一条 `Lineage`」这句是旧语义——当前实现下 fork 的产物是**派生新会话**（见 §4），`boundary` 只用来截前缀，不在原会话的中立树里插枝。

- retry 传的 `userMsg.id` 是 fork 的 `boundary`，要理解它的语义，必须回到圆心契约的 lineage 坐标系。`BoundaryRef`（`packages/shared/src/domain/backend.ts` 第 25 行）定义：不透明字符串，pi 把它当 entryId、dsh 把它当 seq 的字符串化，"语义上它总指向父 lineage 里一个完整回合之后的位置"——桌面不解析内容，只当 token 在 fork/bookmark/resume 间回传。
- `LineageFork` 与 `Lineage` 与 `LineageTree`（同文件）三个类型构成分叉的坐标骨架：`Lineage.fork: LineageFork | null`（根 lineage 为 null），`LineageFork = { parentLineageId, boundary }`。这套骨架现在有两个消费者：① 中立树的存量分支（`NeutralLineage.fork`，fork 改产新会话后壳侧不再自产，只由 `snapshotNeutralSession` 从内核 parentId 树反投影时产生）；② `getTree` 把中立树投成 `LineageTree` 给会话树面板。retry 传的 `userMsg.id` 不再变成一条新 `Lineage` 的 `fork.boundary`，而是作为 `deriveFromAnchor` 的截断锚点（`resolveForkBoundary` + `materializeLineagePrefix`），归一后的中立 id 落进派生会话的 `header.derivedFrom.boundaryEntryId`。
- 但注意两个坐标系的区分（§4 已埋线）：`LineageTree` 里的 `fork.boundary` 是**内核私有 boundary**（pi=entryId、dsh=seq），而中立树 `NeutralLineage` 里的 `fork.boundaryEntryId` 是**中立 entry id**（`{lineageId}:{seq}`，`neutralEntryId` 函数，session-neutral.ts 第 91 行）。`session-store.fork` 不直接把 `userMsg.id` 当 `boundaryEntryId` 用——先经 `resolveForkBoundary` 归一（它可能中立 entryId、也可能是内核行级 id），再截前缀；这里的 `userMsg.id` 是 JSONL 行级 entryId（`NeutralMessage.id` 的来源，session-state.ts 注释"持久化条目 = JSONL 行级 entryId"）。
- `resolveForkBoundaries`（session-neutral.ts 第 133 行）负责把内核私有 boundary 归一到中立 `boundaryEntryId`——这是"壳不读内核存储、只经契约投影"的边界：retry 的 fork 只与中立树打交道，内核私有的 boundary 表示（pi 的 entryId、dsh 的 seq）在适配器层就已经被归一，retry 不感知。
- `lineageContent`（session-neutral.ts）是 retry 重跑后惰性物化的内容来源：给定 `(session, lineageId)`，沿 `fork` 链向上 walk，取父 lineage 到 `boundaryEntryId` 为止的前缀（含端点，之后的丢弃），再拼自身独有条目，返回一条 lineage 的完整线性内容。retry 用 `position: "before"` 把边界定在那条 user 消息**之前**，所以派生会话的种子内容恰好是"重发 user 消息之前的历史"——不含那条 user 消息本身（否则它在派生前缀与第 5 步的重发里各出现一次），这正是"从那条 user 消息重新生成"的精确含义。
- `boundary` 落在"完整回合之后"的归一（backend.ts 第 11 行注释"fork 锚点必须是回合边界：pi 的只接受 user 锚点与 dsh 的 boundary 不落 open turn，在本契约归一为 boundary 指向父 lineage 里一个完整回合之后的位置"）解释了 retry 为什么**选 user 消息**作 boundary 而不是任意消息：user 消息是一个完整回合的起点，在它之前 fork 才能得到"从这个提问重新答"的干净语义。retry 的第 3 步"向前扫最近一条 user 消息"正是这条归一在插件层的具体化。

## 8 消息动作槽的消费链与武装确认原语

- retry 的按钮经 `messageActions` 槽的三段式链挂载，与 continue 完全相同：圆心契约 `MessageActionContribution`（contributions.ts 第 170 行）定义形状 → `useMessageActions`（`packages/react/src/message-actions.ts` 第 15 行）查槽 → `resolveMessageActionComponent`（第 31 行）按 `getPluginComponent` 匹配组件 → timeline 渲染。retry 的 manifest 贡献 `{ id: "retry", component: "RetryAction", placement: "left", when: { role: ["assistant"], settled: true }, order: 50 }`——`settled` 是本轮新增的谓词（§4）：在飞的 pending 行不渲染重试按钮，历史行照常，插件代码里不出现 `"retry"` / `"RetryAction"` 字符串（§8.3 零硬编码，只住在 manifest 与 export 名里）。
- `useArmConfirm`（`packages/react/src/inline-confirm.tsx` 第 88 行）是 retry 采用的"武装两步确认"原语，它的完整语义值得展开：`useArmConfirm<T = boolean>(timeoutMs = 6000)` 返回 `{ armed: T | null, arm, disarm }`；`arm(value)` 置位，`useEffect` 里 6 秒超时自动复位 + `document.addEventListener("keydown", Esc)` 复位（第 95–104 行）。retry 用 `useArmConfirm()` 的布尔形态（`armed` 为 true/false），单按钮场景"点一下变确认？再点执行"。
- inline-confirm.tsx 收敛了**两种**二次确认形态（第 6 行注释）：`InlineConfirmInput`（输入形态，原位输入框 Enter 确认，retry/fork/bookmark 的同构消费）与 `useArmConfirm`（武装形态，按钮原地变"确认?"）。retry 只用武装形态，因为重试不需要额外输入（重发的文本就是历史 user 消息），只要"你确定要开新分支吗"这个确认信号；fork/bookmark 用输入形态（需要输入新名字/新标签）。这是"框架管通用、特化归外层"（§3.3）的原语级落地：二次确认交互收成框架组件，retry 只传布尔。
- 错误呈现的 IPC 包装剥离（第 52 行）值得单独看：`window.kernel.sessions.fork` / `prompt` 走 HTTP/WS，内核错误经壳后端网关包装成 `Error invoking remote method 'session:xxx': Error: <内核错误>` 的形式。正则 `/Error invoking remote method '[^']+': (?:Error: )?([\s\S]*)$/` 剥掉 `Error invoking remote method '...': ` 前缀与可选的 `Error: ` 前缀，只留内核真实错误（`m?.[1]`），兜底 `msg`。这是"壳插件收到 handler 拒绝后自己决定怎么呈现"（§8.1）的落地——IPC 错误是壳的包装，内核错误才是用户该看的，剥离包装是插件对错误形状的一次消费而非翻译。

## 9 QA

**Q：retry 插件和 abortRetry 到底是什么关系？**

没有代码关系，只有命名关系。retry 插件的 `RetryAction` 做"fork + prompt"回退重跑，从不调 `abortRetry`。`abortRetry` 是 pi 扩展面 `PiExtensions.abortRetry` 的方法，消费方是 timeline 插件的停止按钮（`handleRewindStop`，timeline/renderer/index.tsx 第 694 行），语义是"中止 pi 正在进行的自动重试"。任务名"重试/abortRetry"是把两个同主题概念并列，它们一个发起重试、一个终止重试，方向相反。

**Q：点重试后，旧的那条 assistant 消息去哪了？**

没删。`fork` 只是在中立树挂一条空的新 lineage、把活跃指针切过去，旧 lineage 及它的消息原样保留在历史里。用户点重试后看到的是"会话树里多了一条从那条 user 消息长出来的新分支"，旧分支和新分支并存，随时可以切回。这是"分叉归壳"的语义：fork 不销毁历史，只新增可能世界。

**Q：retry 为什么用 `snapshot.messages` 而不是 `useSessionStore().messages` 定位 user 消息？**

两者都是 `NeutralMessage[]`，retry 选了 `snapshot?.messages`。`snapshot` 是 `SyncSnapshot`（投影基线），`useSessionStore().messages` 是框架 store 的实时消息（含乐观占位与在飞的流式占位）。retry 需要的是"已落定的历史序列"来精确反查 user 消息的 entry id，用基线快照更稳定——这是实现选择，不是硬约束。（旧版这里还有一条「`sessionFile` 与 `messages` 同源、一次取 snapshot 两个字段避免跨字段竞态」的理由，随 H1 改用 `currentNeutralSessionId` 后不再成立，已删。）

**Q：fork 的第一个参数被 session-store.fork 用了吗？**

用了。这条 QA 的旧答案是**双重过期**的，两段都已不成立，逐段纠正：

- 旧答案说「`parentLineageId` 是死参数，父 lineage 永远取 `proc.activeLineageId`」——那是更早的实现。后来有过一次根因修复：会话树面板里点**非活跃分支**的节点分叉，会因硬取活跃 lineage 而静默挂错父（分叉关系整个错掉），于是改成尊重调用方指定的 `parentHint`，不在树里才 warn 回落。
- 旧答案说「retry 传 `sessionFile` 实际被忽略，不影响正确性」——H1 之后 retry 传的是 `currentNeutralSessionId`，与契约一致，不再依赖任何忽略/兜底。

现在 `deriveFromAnchor` 的父解析是三级：**调用方指定 → 锚点归属纠偏 → 回落活跃 lineage**。锚点归属纠偏是关键一层：条目属于且只属于一条 lineage，`boundary` 落在哪条 lineage，那条才是语义正确的父（会话树面板恒传会话主键＝根，节点却可能在分支上，靠这层纠偏）。

**Q：dsh 下点重试会怎样？**

`fork` 是壳在中立树上的纯操作（§4），与内核无关，dsh 下照常执行；`prompt` 是消息意图，dsh 下照常执行。所以 retry 在 dsh 下**可用**。真正的差异在 `materializeActiveLineage`：它调 `backend.stop()` + `seed` 换绑后端，dsh 的 `seed` 是 `session/seed` RPC（依赖进程）、pi 的 `seed` 是纯文件写——两边都实现，只是惰性物化的底层形态不同。`abortRetry` 才是 dsh 下不可用的（`asPi` 抛错），但它不在 retry 插件里。

**Q：retry 的 `useArmConfirm` 为什么比 continue 多这一步？**

因为 retry 改变 lineage 拓扑（开新分支）、重发消息，是"改变历史结构"的高风险动作，误触成本高（多一条分支、多一次生成）。continue 是原地续跑，幂等、不改变结构。低风险单拍、高风险武装，是 `inline-confirm.tsx` 里"武装形态"与"直接执行"的设计分工。retry 用 `armed` 按钮变"确认重试?"红色提示 + 6 秒超时复位，把误触概率降到接近零。
