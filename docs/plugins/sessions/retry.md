# retry 插件技术文档

retry 是会话域里"重试"语义的壳插件承载者，但它实际牵涉**两个不同概念**，必须先分清再往下读：其一是 retry 插件自己贡献的 `RetryAction` 按钮——从任意 assistant/tool 节点分叉并重新生成，走 `ctx.tree.fork` + `ctx.messaging.prompt`，是"回退重跑"；其二是 `abortRetry`——pi 内核专属扩展面（`PiExtensions.abortRetry`）里"中止正在进行的自动重试"的方法，它**不是** retry 插件的代码，而是被 timeline 插件在"停止按钮"里消费（`ctx.pi.abortRetry()`）。两个概念共享"retry"这个词但语义相反：一个发起重试，一个终止重试。retry 插件的 `plugin.json` 只有 `messageActions` 一个槽位贡献，`abortRetry` 则是 pi 扩展面的投影，两者唯一的物理交集是 `session:abortRetry` 这个线通道名与 pi 31 命令里的 `abort_retry` 命令。

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
- `handleRetry`（第 22–55 行）用 `useCallback` 包裹，依赖 `[ctx, t, streaming, snapshot, message.id]`，五步：
  - 第 1 步（第 23–26 行）：`if (streaming) { setToast(t("shell.retryStreamingBlocked")); return; }`——生成中不能重试，与 continue 同款防并发。
  - 第 2 步（第 27 行）：`if (!message.id) return;`——无 id 无法定位，静默返回。
  - 第 3 步（第 29–39 行）：在 `snapshot?.messages` 里 `findIndex(m => m.id === message.id)` 找到目标消息，再**向前扫描**找最近一条 `role === "user"` 的消息（第 33–35 行 `for (let i = idx; i >= 0; i--) if (msgs[i].role === "user") { userMsg = msgs[i]; break; }`）。找不到 user 消息则 `setToast(t("shell.retryNoUserMessage"))` 返回——重试的本质是"重发那条提问"，没有提问就没有重试对象。
  - 第 4 步（第 40 行）：`await ctx.tree.fork(snapshot?.state.sessionFile ?? "", userMsg.id)`——在 user 消息的 entry id 处 fork。
  - 第 5 步（第 41–49 行）：把 `userMsg.content` 转成纯文本（string 直接用；数组则过滤 `type === "text"` 的块并 join），`await ctx.messaging.prompt(text)` 重发。
- 文本提取（第 41–48 行）是"内容块数组 → 纯文本"的一次本地解包：`typeof userMsg.content === "string"` 直接取，否则 `Array.isArray` 时 `filter(c => typeof c === "object" && c !== null && c.type === "text").map(c => String(c.text ?? "")).join("")`。这与圆心 `messageContentText`（`packages/shared/src/domain/...`）是同一语义的重复实现——retry 插件自己写了一遍，而不是 import `messageContentText`，这是已知的轻微偏离（session-colors 的 `core/pin.ts` 就 import 了 `messageContentText` 单源，retry 没有）。
- 错误呈现（第 50–53 行）：catch 后 `const m = /Error invoking remote method '[^']+': (?:Error: )?([\s\S]*)$/.exec(msg); setToast(t("shell.retryFailed", { error: m?.[1] ?? msg }))`——正则剥掉 IPC 包装（`Error invoking remote method 'xxx': ...`），只显示内核真实错误。这是"壳插件收到 handler 拒绝后自己决定怎么呈现"（§8.1 权限边界）的落地：IPC 错误是壳后端的包装，内核错误才是用户该看的。

## 4 重试的 fork 语义：分叉归壳（kernel-forkless）

- `ctx.tree.fork` 的类型是 `SessionTreeApi.fork`（`packages/shared/src/domain/sessions.ts` 第 280 行）："回退重跑（§2.4.1 中性 fork）：从指定 lineage 的 boundary 分叉出新 lineage。pi 后端 = 在 boundary 条目处 fork + 框架对账，返回分叉产物路径；position 语义收进后端（默认 at）"。注意 `SessionTreeApi` 继承 `RpcOps`，`fork` 与 `getStats` 并列——它是壳的会话树操作，**不是** `BaseBackend` 的方法。
- 壳后端实现是 `session-store.fork`（第 1531–1547 行），它的注释揭示了关键架构事实："fork = 壳切中立树（§kernel-forkless §14）：分叉是壳的纯操作，内核不 fork、不物化。惰性物化：分支只在下次 send 时经 materializeActiveLineage seed 投影。"——**分叉不再是 pi 命令，而是壳在中立树上的纯操作**：`const newLineageId = randomUUID()`，`this.neutralStore.put(upsertNeutralLineage(cur, { lineageId: newLineageId, fork: { parentLineageId: proc.activeLineageId, boundaryEntryId: boundary ?? "" }, entries: [] }))`，`proc.activeLineageId = newLineageId`，返回 `newLineageId`。
- 这解释了为什么 retry 的 `fork(sessionFile, userMsg.id)` 里 `userMsg.id` 是 boundary（分叉点）、且 fork 本身**不重发消息**——它只在中立树里挂一条空的 `entries: []` 新 lineage，把活跃 lineage 指针切过去。真正的重跑发生在第 5 步的 `prompt`。
- `upsertNeutralLineage` 与中立树 `NeutralSession`（`packages/shared/src/domain/session-neutral.ts`）是 fork 的真相源：`NeutralLineage`（第 54 行）= `{ lineageId, fork: { parentLineageId, boundaryEntryId } | null, entries: NeutralEntry[] }`。`boundaryEntryId` 是中立 entry id 坐标系（不是内核私有 boundary），`resolveForkBoundaries`（第 133 行）负责把内核私有 boundary 归一到中立坐标系。retry 传的 `userMsg.id` 是 JSONL 行级 entryId，恰是中立 entry id 的来源。
- `materializeActiveLineage`（session-store.ts 第 1552 行）是惰性物化的落点：当 `proc.materializedLineageId !== proc.activeLineageId`（fork 后不一致）时，`lineageContent(session, proc.activeLineageId)` 算出新分支的完整线性内容，`proc.backend.stop()` 后经 `seed` 投影进内核、换绑 `proc.backend` 到新会话。这条路径是"内核是单线执行器，只物化当前活跃 lineage，分叉是壳的纯操作"（backend.ts 第 67 行注释）的运行时落地。
- 所以 retry 的完整时序是：点确认 → `fork` 切中立树（瞬时、无内核命令）→ `prompt` → `ensureForSend` → `materializeActiveLineage`（惰性 seed 投影新分支）→ 内核在新分支上生成。用户看到的是"历史里多出一条从那条 user 消息长出来的新分支"。

## 5 abortRetry：pi 扩展面，不是 retry 插件

- `abortRetry` 的契约是 `PiExtensions.abortRetry`（`packages/shared/src/domain/sessions.ts` 第 292 行）："中止正在进行的自动重试"。它属于 `PiExtensions`（第 286 行）——pi 内核专属扩展面（§7.6），dsh 无此面，壳插件经 `capabilities.piExtension` 探测"有则用、无则降级"。
- `PiExtensions` 是 pi 命令的中性投影（`sessions.ts` 第 283 行注释），`abortRetry` 与 `steer` / `followUp` / `cycleModel` / `clone` / `compact` / `setAutoRetry` 等并列。它的语义对象是 pi 内核的**自动重试机制**：pi 模型失败时会按 `set_auto_retry` 开关自动重试，`abortRetry` 就是在自动重试进行中把它中止掉。
- `usePluginContext` 里 `pi` 的绑定（`packages/react/src/plugin-context.ts` 第 42 行）：`abortRetry: () => window.kernel.sessions.pi.abortRetry()`——`ctx.pi.abortRetry()` 是壳插件可调用的投影，底层走 `window.kernel.sessions.pi.abortRetry` RPC。
- 壳后端实现 `session-store.abortRetry`（第 1499–1503 行）：`const proc = this.activeProc(); if (!proc || !proc.backend.alive) return; await this.asPi(proc).abortRetry();`。注意它**不抛错**（进程不活直接 return），与 `steer` / `followUp` 的"抛错"不同——abortRetry 是"能停就停，停不了就算了"的宽松语义。
- `asPi(proc)`（第 1703 行）是类型守卫：`const pi = proc.backend.capabilities.pi; if (!pi) throw new Error("当前后端不支持 pi 专属命令"); return pi as PiBackendExtensions;`——dsh 下 `capabilities.pi` 是 undefined，`asPi` 抛错，`abortRetry` 显式降级。这是 §7.6"能力接口探测（backend.capabilities.pi）"的落地，不是 `if (kernel === "pi")` 硬分支。
- `PiBackend.abortRetry`（`src/server/kernel/pi/backend/pi-backend.ts` 第 205 行）：`await this.adapter.send(buildAbortRetryCommand())`——发 pi 31 命令里的 `abort_retry`。线通道名是 `session:abortRetry`（`packages/shared/src/channel/channel-contract.ts` 第 190 行），它是 `window.kernel.sessions.pi.abortRetry` RPC 的线通道，**不是**事件总线 channel。
- **消费方是 timeline 插件，不是 retry 插件**：`src/plugins/sessions/timeline/renderer/index.tsx` 第 692–698 行 `handleRewindStop` 里 `if (retrying && capabilities.piExtension) { void ctx.pi.abortRetry(); } else { void ctx.messaging.abort(); }`——timeline 的停止按钮在"正在自动重试且 pi 扩展面可用"时调 `abortRetry` 中止自动重试，否则调 `messaging.abort` 中断普通生成。第 1065 行是另一处同样的调用。这就是"retry 插件不管 abortRetry、timeline 管 abortRetry"的边界：`abortRetry` 是停止按钮的语义分支，不是消息重试按钮的语义分支。
- 这个分工值得强调：retry 插件的 `RetryAction` 从不调 `abortRetry`。任务名"重试/abortRetry"里的 `abortRetry` 是 pi 扩展面能力，它的壳侧入口在 timeline 的停止按钮，它的契约在 `PiExtensions`，它的命令在 pi 31 命令。retry 插件只与它共享"retry"这个词，物理上没有代码交集。

## 6 与其他插件/槽位交互（专节）

- **贡献的槽位名**：`messageActions`（`RetryAction`，`id: "retry"`，`placement: "left"`，`when: { role: ["assistant"] }`，`order: 50`）。消费方是 timeline 插件。
- **dependsOn**：`["timeline"]`——retry 的按钮由 timeline 挂载，同 continue 的生命周期护栏。
- **不贡献、不消费的槽位**：retry 不贡献任何渲染槽，不 export `channels`，不在事件总线上 `emit` / `invoke` / `on`。它是单槽插件，与其它壳插件唯一耦合是 timeline 对 `messageActions` 的消费。
- **消费的框架 API**：`ctx.tree.fork`（`SessionTreeApi.fork`，分叉意图）、`ctx.messaging.prompt`（`MessagingApi.prompt`，消息意图）、`ctx.pi.abortRetry`（`PiExtensions.abortRetry`，pi 扩展面——注意 retry 插件**不**消费它，是 timeline 消费）、`useSessionStore().snapshot` / `.streaming`（只读框架 store）、`useArmConfirm`（框架共享原语）、`useTranslation().t`。
- **`snapshot` 的两个字段**是 retry 的数据源：`snapshot.messages`（`SyncSnapshot.messages`，`packages/shared/src/domain/events/session-state.ts` 第 201 行，时间线消息序列）与 `snapshot.state.sessionFile`（`SessionState.sessionFile`，会话文件路径/中立会话主键）。retry 用前者定位 user 消息、用后者做 fork 的入参。
- **与 continue 的槽位并列**：两个插件在 `messageActions` 同一 `placement` / 同一 `when` 下各贡献一项，`order` 40 vs 50 排序，视觉上"继续"在左、"重试"在右。这是多插件同槽位确定性排序的现场（`order` 升序，同 order 按 source 优先级）。
- **`session:abortRetry` 线通道**：属于 `window.kernel` RPC 线通道（channel-contract.ts 第 190 行），不是事件总线 channel。retry 插件的 renderer 不直接触碰这个字符串，它经 `ctx.pi.abortRetry()` 类型化 API 间接触达（且实际触达方是 timeline）。

## 7 lineage 坐标系：fork 的 boundary 语义

- retry 传的 `userMsg.id` 是 fork 的 `boundary`，要理解它的语义，必须回到圆心契约的 lineage 坐标系。`BoundaryRef`（`packages/shared/src/domain/backend.ts` 第 25 行）定义：不透明字符串，pi 把它当 entryId、dsh 把它当 seq 的字符串化，"语义上它总指向父 lineage 里一个完整回合之后的位置"——桌面不解析内容，只当 token 在 fork/bookmark/resume 间回传。
- `LineageFork`（第 28 行）与 `Lineage`（第 36 行）与 `LineageTree`（第 44 行）三个类型构成 fork 的坐标骨架：`Lineage.fork: LineageFork | null`（根 lineage 为 null），`LineageFork = { parentLineageId, boundary }`。retry 的 fork 就是在这套坐标系里新增一条 `Lineage`，其 `fork.boundary` = `userMsg.id`。
- 但注意两个坐标系的区分（§4 已埋线）：`LineageTree` 里的 `fork.boundary` 是**内核私有 boundary**（pi=entryId、dsh=seq），而中立树 `NeutralLineage` 里的 `fork.boundaryEntryId` 是**中立 entry id**（`{lineageId}:{seq}`，`neutralEntryId` 函数，session-neutral.ts 第 91 行）。`session-store.fork` 把 retry 传的 `userMsg.id` 直接当作 `boundaryEntryId` 存进中立树，这里的 `userMsg.id` 是 JSONL 行级 entryId（`NeutralMessage.id` 的来源，session-state.ts 第 181 行注释"持久化条目 = JSONL 行级 entryId"）。
- `resolveForkBoundaries`（session-neutral.ts 第 133 行）负责把内核私有 boundary 归一到中立 `boundaryEntryId`——这是"壳不读内核存储、只经契约投影"的边界：retry 的 fork 只与中立树打交道，内核私有的 boundary 表示（pi 的 entryId、dsh 的 seq）在适配器层就已经被归一，retry 不感知。
- `lineageContent`（session-neutral.ts 第 277 行）是 retry 重跑后惰性物化的内容来源：给定 `(session, lineageId)`，沿 `fork` 链向上 walk，取父 lineage 到 `boundaryEntryId` 为止的前缀（含端点，之后的丢弃），再拼自身独有条目，返回一条 lineage 的完整线性内容。retry 的 fork 把 boundary 定在 user 消息上，`lineageContent` 就会截到"那条 user 消息为止"——新分支的种子内容恰好是"重发 user 消息之前的历史"，这正是"从那条 user 消息重新生成"的精确含义。
- `boundary` 落在"完整回合之后"的归一（backend.ts 第 11 行注释"fork 锚点必须是回合边界：pi 的只接受 user 锚点与 dsh 的 boundary 不落 open turn，在本契约归一为 boundary 指向父 lineage 里一个完整回合之后的位置"）解释了 retry 为什么**选 user 消息**作 boundary 而不是任意消息：user 消息是一个完整回合的起点，在它之前 fork 才能得到"从这个提问重新答"的干净语义。retry 的第 3 步"向前扫最近一条 user 消息"正是这条归一在插件层的具体化。

## 8 QA

**Q：retry 插件和 abortRetry 到底是什么关系？**

没有代码关系，只有命名关系。retry 插件的 `RetryAction` 做"fork + prompt"回退重跑，从不调 `abortRetry`。`abortRetry` 是 pi 扩展面 `PiExtensions.abortRetry` 的方法，消费方是 timeline 插件的停止按钮（`handleRewindStop`，timeline/renderer/index.tsx 第 694 行），语义是"中止 pi 正在进行的自动重试"。任务名"重试/abortRetry"是把两个同主题概念并列，它们一个发起重试、一个终止重试，方向相反。

**Q：点重试后，旧的那条 assistant 消息去哪了？**

没删。`fork` 只是在中立树挂一条空的新 lineage、把活跃指针切过去，旧 lineage 及它的消息原样保留在历史里。用户点重试后看到的是"会话树里多了一条从那条 user 消息长出来的新分支"，旧分支和新分支并存，随时可以切回。这是"分叉归壳"的语义：fork 不销毁历史，只新增可能世界。

**Q：retry 为什么用 `snapshot.messages` 而不是 `useSessionStore().messages` 定位 user 消息？**

两者都是 `NeutralMessage[]`，retry 选了 `snapshot?.messages`。`snapshot` 是 `SyncSnapshot`（投影基线，来自内核快照），`useSessionStore().messages` 是框架 store 的实时消息（含乐观占位）。retry 需要的是"已落定的历史序列"来精确反查 user 消息的 entry id，用基线快照更稳定；且 `snapshot.state.sessionFile` 与 `snapshot.messages` 同源，一次取 `snapshot` 两个字段，避免跨字段竞态。这是实现选择，不是硬约束。

**Q：fork 的第一个参数 `sessionFile` 被 session-store.fork 用了吗？**

没有。`session-store.fork(parentLineageId, boundary)` 的实现（第 1536–1545 行）里 `parentLineageId` 参数是**死参数**——它用 `proc.activeLineageId` 作为父 lineage，只用 `boundary` 作 `boundaryEntryId`。retry 传的 `sessionFile` 实际被忽略，父 lineage 永远是"当前活跃 lineage"。这是 API 签名与实现的一个历史不一致，属于 stale 标注待收的范畴，不影响 retry 的正确性（retry 要的就是"在当前活跃分支上回退 fork"）。

**Q：dsh 下点重试会怎样？**

`fork` 是壳在中立树上的纯操作（§4），与内核无关，dsh 下照常执行；`prompt` 是消息意图，dsh 下照常执行。所以 retry 在 dsh 下**可用**。真正的差异在 `materializeActiveLineage`：它调 `backend.stop()` + `seed` 换绑后端，dsh 的 `seed` 是 `session/seed` RPC（依赖进程）、pi 的 `seed` 是纯文件写——两边都实现，只是惰性物化的底层形态不同。`abortRetry` 才是 dsh 下不可用的（`asPi` 抛错），但它不在 retry 插件里。

**Q：retry 的 `useArmConfirm` 为什么比 continue 多这一步？**

因为 retry 改变 lineage 拓扑（开新分支）、重发消息，是"改变历史结构"的高风险动作，误触成本高（多一条分支、多一次生成）。continue 是原地续跑，幂等、不改变结构。低风险单拍、高风险武装，是 `inline-confirm.tsx` 里"武装形态"与"直接执行"的设计分工。retry 用 `armed` 按钮变"确认重试?"红色提示 + 6 秒超时复位，把误触概率降到接近零。
