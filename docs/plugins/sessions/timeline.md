# timeline

## 1 定位与职责

- timeline 是会话流中区的唯一渲染者：它通过 `mainView` 槽贡献 `TimelineView`（`src/plugins/sessions/timeline/renderer/index.tsx`），把 `useSessionStore` 里的中性消息流画成 ChatGPT 式会话流——用户气泡、AI 消息、思考链、工具卡、分隔线、图片、排队篮、输入框。`plugin.json` 的 `description` 自述为「中区会话消息流渲染:消息气泡、思考块、工具调用、分隔线(消费 session-store 中性消息)」，这正是它的职责边界。

- 它的机制定位是「块分解 + 槽分派」两层：`renderer/blocks.ts` 的 `decomposeMessage` 把一条 `NeutralMessage` 拆成有序块序列（纯函数，无 React 无 IO），`renderer/block-renderer.tsx` 的 `BlockRenderer` 查 `blockRenderers` 槽把每个块分派给贡献方组件。timeline 自己**不持有任何一个渲染组件**——`block-renderer.tsx` 顶部注释写死「timeline 不持有一个渲染组件，也不认识任何贡献方」。它只负责「怎么拆」和「往哪派」，不负责「怎么画」。

- 它的内容定位是「会话流内建能力 + 槽位挂载点」的混合体：时间/指标徽标（`MessageMeta`）、图片展示（`ImageBlock`）、待发送文件/图条、重试折叠、工具结果折叠、回退（rewind）内联框、排队发送都是 timeline 自建内容；而输入框上方的目标条、中段上下文占用、底部工具栏表情包入口、右下角语音按钮、附件篮子渲染、消息块渲染、消息行动作按钮，全是「查槽 + 挂组件」的机制点。这条边界由 `index.tsx` 里 `useComposerStats`/`useComposerTop`/`useComposerActions`/`useComposerVoice`/`useComposerAttachments`/`useBlockRenderers`/`useMessageActions` 七个查槽 hook 显式划出。

- 它是纯壳插件：`plugin.json` 没有 `piExtension` 也没有 `dshExtension` 字段，目录里也没有 `pi-extension/`、`dsh-extension/` 子目录。它不进任何内核进程，不 import `src/core/`、`src/server/`、`src/web/` 的任何实现——只从 `@my-harness-desktop/shared` 引用类型与纯函数、从 `@my-harness-desktop/react` 引用 hook/组件/事件总线，遵守壳插件依赖纪律。

- 它的内核无关性由三层保证：读的是中性事件（`ctx.sessions.onEvent` 的 `SessionEvent`），渲染的是中性消息（`NeutralMessage`），内核身份只以数据出现（`ModelInfo.kernel`、`capabilities.kernel`）驱动内核标与思考档位降级，从不在渲染链上写 `if (kernel === "pi")` 的分支。文件里出现的 `capabilities.piExtension` 是能力探测（有则用、无则降级），不是内核身份分支。

## 2 目录结构

- `plugin.json`：唯一声明面。`renderer` 指向 `./renderer/index.tsx`，`contributes` 声明 `mainView`/`settingsGroups`/`messageActions`/`languages` 四槽，`dependsOn` 声明 `pi-manager`/`message-blocks`/`stickers`/`goal` 四依赖，`protected: true` 标不可卸载。

- `renderer/`：React 组件与 hook，全部是槽组件与纯 UI。文件清单与职责如下：

  - `index.tsx`：`TimelineView` 主组件（1549 行）+ `MessageRow`（memo 化的单行渲染）+ `MessageActions`（消息动作行）+ `ComposerDock`（输入框停靠区）+ `PendingImageBar`/`PendingFileBar`（待发送图/文件条）+ `SlotRenderedRow`（整消息渲染器流式壳）+ `PendingTimer`（首 token 前走表）+ `channels`/`channelMeta` 导出。这是插件的心脏，数据装载、发送序列、事件订阅、槽解析全在此。

  - `blocks.ts`：`decomposeMessage` 块分解器，纯函数，把 `NeutralMessage` 拆成 `TimelineBlock[]`。`TimelineBlock` 联合是七种词汇——`thinking`/`toolCall`/`text`/`userText`/`userIntent`/`divider`/`auxBlock`。

  - `block-renderer.tsx`：`BlockRenderer` 块分派器，查 `blockRenderers` 槽按 `(block, name?)` 二键解析贡献组件，按块类型拼标准 props 渲染，解析不到落 `PlainBlockFallback` 纯文本兜底。

  - `composer.tsx`：`Composer` 输入组件（573 行）+ `SlashPopup`（斜杠弹窗）+ `ThinkingToggle`（思考开关）+ `groupByKernel`（模型按内核再按 provider 分组）。`ComposerProps` 是输入组件的完整契约。

  - `message-actions.tsx`：`CopyAction`（复制到剪贴板）、`RewindAction`（emit `timeline:rewindRequested`）。入口 `index.tsx` 必须 re-export 这两个（第 56 行），否则 `resolveMessageActionComponent` 按 manifest component 名匹配时拿不到。

  - `message-meta.ts`：`buildMessageMeta`/`formatClockTime`/`formatDurationBrief`/`formatTokens` 纯函数，把消息投影成一行「时间 + 时长 + token」元信息。

  - `MessageMeta.tsx`：消费 `buildMessageMeta` 渲染 hover 淡入的元信息徽标。

  - `queue-basket.tsx`：`QueueBasket` 排队篮，streaming 时暂存的消息队列的展示与操作（编辑/移除/立即发送/重试/清空）。

  - `timeline-scroll-bridge.tsx`：`JumpToBottomButton` 贴底跳转按钮。

  - `use-session-draft.ts`：`useSessionDraft` hook，输入框草稿按会话 key 隔离存/取 `composerDrafts`。

  - `image-block.tsx`：`ImageBlock` 会话流内置图片展示，`ctx.configFile.readBinary` 读白名单内文件为 base64 → data URI。

  - 测试文件：`blocks.test.ts`、`composer.test.tsx`、`message-meta.test.ts`、`MessageMeta.test.tsx`、`use-session-draft.test.tsx`，覆盖纯函数层与可 DOM 的 hook 层。

- `core/`：无 React 无 IO 的纯逻辑层，与 `renderer/blocks.ts` 同级的「渲染管线只消费、不推导」部分：

  - `retry-collapse.ts`：`collapseRetryFailures(messages, maxRetries)`，把内核自动重试产生的连续空 error assistant 折叠成一条 `divider`（kind `retry`）。

  - `tool-result-fold.ts`：`foldToolResults(messages)`，按 `toolCallId → toolCall block.id` 把工具结果折回工具块、摘除独立 `toolResult` 消息。

  - `attach-images.ts`：`parseImageContent(content)`，解析 `role:"image"` 消息的 content → `{src,title}`。

  - 测试文件：`retry-collapse.test.ts`、`tool-result-fold.test.ts`。

- `locales/`：`de`/`en`/`zh-CN`/`zh-TW` 四个 locale，每个含 `plugin.json`（插件元信息文案）、`settings.json`（`settingsGroups` 的字段标题/说明）、`shell.json`（`shell.*` 通用文案）、`timeline.json`（`timeline.*` 会话流文案）四个命名空间。对应 `plugin.json` 里 `languages` 槽的 16 条贡献（4 命名空间 × 4 locale）。

## 3 plugin.json 逐字段

- `id: "timeline"`、`version: "0.4.9"`、`tier: "official"`、`protected: true`：受保护插件，可禁用不可卸载。`protected` 字段在圆心 `PluginManifest`（`packages/shared/src/domain/contributions.ts` 第 501 行）有定义——「protected 插件可禁用但不能从注册表移除」。

- `renderer: "./renderer/index.tsx"`：框架加载该 module 后读 `module.channels` 自动注册事件通道、读 `contributes.*[].component` 在 exports 里自动匹配组件（§7.4 自动匹配机制）。timeline 依赖的自动匹配有两处硬性要求：`mainView` 的 `TimelineView` 和 `messageActions` 的 `CopyAction`/`RewindAction` 必须作为 `index.tsx` 的具名 export 存在，缺一个对应按钮/视图静默不渲。

- `dependsOn: ["pi-manager", "message-blocks", "stickers", "goal"]`：生命周期护栏，不是加载顺序。逐项依据：

  - `pi-manager`：timeline `ctx.events.on("pi-manager:defaultChanged")` 消费 pi-manager 的状态广播（`index.tsx` 第 423 行），据此刷新默认模型配置层镜像。

  - `message-blocks`：timeline 渲染块依赖 message-blocks 贡献的 `blockRenderers` 槽（`BashCard`/`EditCard`/`ReadCard`/`DefaultCard`/`ThinkingChainBlock`/`UserBubble`/`CommentsOnlyBubble`/`EntryDivider` 八个组件）。这是**槽依赖而非 channel 依赖**——message-blocks 不发布任何 channel，但缺了它 timeline 的每个块都落 `PlainBlockFallback`，整条流退化纯文本。dependsOn 在此表达的是「渲染真身依赖」。

  - `stickers`：timeline `on("stickers:fillComposer")`（追加文本/图）和 `on("stickers:send")`（等效点击发送）消费 stickers 的两个 channel。

  - `goal`：timeline `on("goal:state", {replayLast:true})` 消费 goal 的状态广播，active 时给输入框药丸挂绿晕；goal 同时贡献 `composerTop` 槽的 `GoalBar` 与 `blockRenderers` 槽的 `GoalCard`。

- `contributes.mainView`：单条 `{id:"timeline", component:"TimelineView", order:100}`。`MainViewContribution` 契约（`contributions.ts` 第 100 行）只三个字段；壳中区留空容器按槽查组件渲染。`order:100` 是缺省值，若未来有第二个 mainView 贡献方按 order 小者胜。

- `contributes.settingsGroups`：`id:"sessionFlow"` 一组六个字段，全部落通用页 `general.json`（`SettingsGroupContribution`/`SettingsFieldDecl` 契约，`contributions.ts` 第 45/57 行）。字段逐项：

  - `defaultThinkingLevel`（enum，default `high`）：新会话默认思考档位，选项 `off/minimal/low/medium/high/xhigh`，label 走 `shell.level*` i18n key。

  - `composerApplyTiming`（enum，default `onSend`）：模型/思考强度点选的生效时机——`onSend` 记内存 pending、发送时回灌；`immediate` 点选即 RPC 到内核。timeline 在 `index.tsx` 第 578 行 `composerApplyTiming` 读它分派 `pickModel`/`pickLevel` 两条路径。

  - `composerMaxLines`（int，default 10）：输入框自动撑高行数上限，选项 `[5,10,15,20,30]`。timeline 经 `lineCountOr(generalConfig["composerMaxLines"], 10)` 取整兜底（`index.tsx` 第 462 行）。

  - `userBubbleMaxLines`（int，default 10）：用户气泡行数上限，同样经 `lineCountOr` 兜底（第 463 行），传给 `BlockRenderer` 的 `bubbleMaxLines`、最终进 `userText` 块的 `maxLines` prop。

  - `showHiddenMessages`（boolean，default false）：`display===false` 的隐藏条目是否显示。timeline 第 460 行 `showHiddenMessages === true` 时才不过滤。

  - `timelineCollapseDefault`（boolean，default true）：块折叠的默认态。timeline 第 458 行 `collapseDefault = generalConfig["timelineCollapseDefault"] !== false`，透传给 `MessageRow` → `BlockRenderer` → 各块的 `collapseDefault` prop。

- `contributes.messageActions`：两条。`copy`（`CopyAction`，`placement:"left"`，order 10）与 `rewind`（`RewindAction`，`placement:"right"`，`when:{role:["user"]}`，order 10）。`MessageActionContribution` 契约（`contributions.ts` 第 170 行）规定组件收 `{message, text}` props 自己渲染按钮。`RewindAction` 的 `when.role:["user"]` 让回退按钮只在用户消息行出现；`CopyAction` 无 `when` 即全角色。

- `contributes.languages`：16 条，`id` 分四命名空间（`timeline.timeline`/`timeline.shell`/`timeline.settings`/`timeline.plugin`）× 四 locale（`zh-CN`/`zh-TW`/`en`/`de`）。`LanguageContribution` 契约（第 130 行）规定 `resources` 是 key→文案字典或外部 JSON 相对路径，timeline 用后者指向 `locales/<locale>/<ns>.json`。`timeline.shell` 命名空间提供 `shell.*` 键（`shell.thinking`/`shell.send`/`shell.rewind` 等），这是 timeline 复用壳通用文案的通道；`timeline.timeline` 提供会话流专属文案（`timeline.divider`/`timeline.autoRetryInProgress`/`timeline.queue.*` 等）。

## 4 渲染组件树与数据流

- `TimelineView`（`index.tsx` 第 103 行）是整棵树的根，挂在 mainView 槽。它从 `useSessionStore` 解构 `snapshot/messages/streaming/switching/thinkingLevels/capabilities/syncNonce/openNonce/lastSendNonce`，从 `useUiStore` 解构 `currentCwd/currentNeutralSessionId/sessionModelPending/setSessionModelPending/pendingQueue/enqueueMessage/removeFromQueue/clearQueue/markQueueFailed/markQueueItemFailed/clearQueueFailed`，再用 `useSessionDraft(draftKey)` 拿输入框草稿。数据全部来自共享 store，零拉取。

- 可见消息序列是三次纯变换的复合（`index.tsx` 第 465–471 行）：`foldToolResults(collapseRetryFailures(showHiddenMessages ? messages : messages.filter(m => m.display !== false), retryMax))`。先按 `display!==false` 过滤隐藏条目，再折叠重试失败，再折工具结果。`foldToolResults` 只对「被折入的 assistant 换新引用」、其余消息原引用透传（`core/tool-result-fold.ts` 第 17 行），保证 `MessageRow` 的 memo 依赖引用相等不失效。

- 虚拟滚动用 `react-virtuoso` 的 `Virtuoso`（第 1145 行）。关键参数：`key={`${openNonce}:${syncNonce}`}` 让全量消息替换（openSession/resync）重挂列表、由官方 `initialTopMostItemIndex` 置底；`followOutput={followWhenAtBottom}` 只在贴底时自动跟随；`alignToBottom` + 末条 `pb-28` 预留 + `atBottomThreshold:40` 处理置底判定与 ComposerDock 装饰渐变罩的关系；`rangeChanged` 记录当前可见范围 `visibleRangeRef` 供 `scrollToMessageId` 判断「目标已在视口就不滚」。

- 每行渲染进 `MessageRow`（第 1316 行，`memo` 包裹）。`MessageRow` 的分派优先级：① `getMessageRenderer(message.role)` 命中 `messageRenderers` 槽 → `SlotRenderedRow` 整条交给贡献方（如 sub-agent 的 `SpawnCard`），不进块管线；② `message.role === "image"` → `ImageBlock` 直渲；③ 其余 role 走 `decomposeMessage(message, getAuxParsers())` 得块序列，逐块 `BlockRenderer`。`getAuxParsers()` 来自 `packages/react/src/aux-block-parsers.ts`，是插件 module 加载期填充的解析器注册表，timeline 只喂给 `decomposeMessage` 不自己持有。

- `BlockRenderer`（`block-renderer.tsx` 第 14 行）是块分派的关键。`name` 的取值：`toolCall` 块取 `toolCall.name`、`divider` 块取 `kind`、`auxBlock` 块取 `aux.type`，其余块无 name。`resolveBlockRenderer(items, block.type, name)` 按「特化层（names 精确命中）优先于通用层（未声明 names）」+「层内 order 小者胜」选贡献项，`resolveBlockRendererComponent` 经 `getPluginComponent` 匹配组件 exports。命中后按块类型拼标准 props——`thinking` 传 `{content, streaming, startedAt, completedAt, collapseDefault}`、`toolCall` 传 `{toolCall, collapseDefault}`、`text` 传 `{text, streaming}`、`userText` 传 `{text, maxLines}`、`userIntent` 传 `{}`、`divider` 传 `{kind, i18nKey, i18nArgs, detail, tone}`、`auxBlock` 传 `{aux}`。解析不到组件落 `PlainBlockFallback`。

- `streaming` 语义按消息自持、不读全局（`block-renderer.tsx` 第 26 行 `const pending = message.pending === true`）。这是 `index.tsx` 第 1312 行注释标出的根因修复：流式起止翻转曾使全部行 memo 失效、用户文本选区被物理摧毁，故只有走 `messageRenderers` 槽的整消息行（`SlotRenderedRow`）才单独订阅全局 `streaming`，常规行不进这个分支。

- `MessageMeta` + `MessageActions` 是每条 user/assistant 行的行级附加。`MessageMeta` 消费 `buildMessageMeta`（纯函数，`message-meta.ts`），投影 `clock`（user=发送时间、assistant=完成时间）+ `duration`（`timestamp - startedAt`）+ `tokens`（`messageUsageOf` 提取的 input/output）。`MessageActions`（`index.tsx` 第 1425 行）查 `useMessageActions()` 槽，按 `when.role` 过滤、按 `placement` 分左右，`resolveMessageActionComponent(action.pluginId, action.component)` 匹配组件，传 `{message, text}`。`rowText` 来自块序列里第一条 `text`/`userText` 块原文（第 1353 行），动作组件不回读消息。

- `ComposerDock`（第 1447 行）是输入区停靠容器，在流布局占 flex 列尾部。内容自上而下：`composerTopNodes`（composerTop 槽）→ `QueueBasket`（排队篮）→ `AttachmentRenderer`（composerAttachments 槽，`matched` 非空才渲）→ `PendingImageBar` → `PendingFileBar` → `toast` → `JumpToBottomButton`（`!isAtBottom` 才显）→ `composer`。附件渲染组件只在「数据到达」时出现——`AttachmentRenderer` 第 1256 行 `matched?.items?.length && AttachmentRenderer`，与 composerTop 的「常驻状态」分工（`ComposerTopContribution` 契约第 272 行注释）。

- 空态是早退分支（第 1095 行）：`!currentCwd || (!switching && !messages.some(m => m.role === "user"))` 时渲染大 logo + 随机欢迎语 + `ComposerDock`，不渲染 `Virtuoso`。空态 logo 的内核归属 `emptyKernel = currentModel?.kernel ?? capabilities.kernel ?? null`（第 1094 行），经 `PluginIcon` 随内核切换交叉淡入淡出（`AnimatePresence mode="wait"`）。内核 = 模型的派生量，没有模型就没有内核，不回落 pi。

## 5 贡献与消费的槽位

- **timeline 自己贡献的槽**（`plugin.json` `contributes`）：`mainView`（`TimelineView`）、`settingsGroups`（`sessionFlow` 六字段）、`messageActions`（`copy`/`rewind`）、`languages`（16 条）。其中 `messageActions` 是「既消费又贡献」——timeline 消费 `useMessageActions()` 渲染按钮，同时自己的 `CopyAction`/`RewindAction` 作为槽贡献被自己消费（与其他插件经同一条查槽路径拿到的按钮同框）。这是与 file-tree 自贡献 fileIcons 首批又自消费完全同构的模式（`docs/design/timeline-block-renderers.md` 第 249 行有述）。

- **timeline 消费的槽，逐个查槽 hook 与贡献方**：

  - `blockRenderers`：`useBlockRenderers()` → `resolveBlockRenderer` → `resolveBlockRendererComponent`。贡献方：message-blocks（`toolCall` 特化 `bash/edit/read` 三卡 + `toolCall` 通用 `DefaultCard` + `thinking` 的 `ThinkingChainBlock` + `userText` 的 `UserBubble` + `userIntent` 的 `CommentsOnlyBubble` + `divider` 的 `EntryDivider`）、goal（`toolCall` 特化 `set_goal/achieve_goal` 的 `GoalCard`）、review（`auxBlock` 特化 `review` 的 `ReviewAuxBlock`）。`auxBlock` 块类型不在 `BlockRendererContribution` 的五个内置词里（`contributions.ts` 第 469 行），但 `block` 字段是 `"thinking" | "toolCall" | "text" | "userText" | "divider" | (string & {})` 开放字符串，review 声明 `block:"auxBlock"` 合法。

  - `messageRenderers`：`getMessageRenderer(message.role)`。贡献方 sub-agent（`SpawnCard`/`SpawnDoneCard`）。这是整消息级的渲染替换，比块级更粗粒度，命中即整条消息不进块管线。

  - `messageActions`：`useMessageActions()` + `resolveMessageActionComponent`。贡献方：timeline 自身（`copy`/`rewind`）、session-bookmarks（`fork`/`bookmark`）、session-colors（`contentPin`）。全部经同一条查槽路径渲染到消息行的 hover 动作区。

  - `composerPolicies`：`useComposerPolicies()`。贡献方 sub-agent（`customKey:"subagent"`）。timeline 第 451 行 `composerPolicies.find(p => sessionCustom[p.customKey] !== undefined && sessionCustom[p.customKey] !== null)` 找到命中策略，命中即把整个输入框换成 `readonlyBar`（只读提示条），提示文案取 `matchedPolicy.readonlyMessageKey` 的 i18n 或默认 `shell.composerReadonly`。

  - `composerAttachments`：`useComposerAttachments()`。贡献方 review（`ReviewBasketBar`）。timeline 第 708–715 行查槽取首个贡献组件（`getPluginComponent(c.pluginId, c.component)`），第 1256 行 `matched?.items?.length && AttachmentRenderer` 时渲 `<AttachmentRenderer payload={matched} />`。数据（`ComposerAttachmentPayload`）经 `timeline:composerAttachments` channel 挂载，渲染由槽贡献方承担——谁的数据谁画。

  - `composerActions`：`useComposerActions()`。贡献方 stickers（`StickerComposerButton`）。渲染进 `Composer` 的 children（底部工具栏左段「+」按钮右侧），每个组件用 `PluginIdContext.Provider` 包成贡献方自己的 pluginId（第 720–728 行），否则组件落 timeline 上下文、`emit`/`config` 的 pluginId 绑定面错认。

  - `composerStats`：`useComposerStats()`。贡献方 token-stats（`ContextUsageBar`）。渲染进 `Composer` 中段思考控件右侧（第 443 行 `ml-auto` 推右），同样逐个包 `PluginIdContext.Provider`。

  - `composerTop`：`useComposerTop()`。贡献方 goal（`GoalBar`）。渲染进 `ComposerDock` 顶部（第 1232 行），是常驻状态横幅，与 composerAttachments 的「待发送内容」分工。

  - `composerVoice`：`useComposerVoice()`。当前无贡献方（全仓 grep 无插件贡献此槽）。timeline 第 761–781 行查槽，命中即渲 `<Comp onTranscribed={...} />`，`onTranscribed` 回调把语音转文字追加进输入框；无贡献时 `Composer` 渲染禁用态占位麦克风（`composer.tsx` 第 449–453 行），`title` 走 `shell.voice`，不静默不伪造。

- 槽组件的 `PluginIdContext` 包裹是本插件的硬要求（`index.tsx` 第 720/737/753/767 行四处）。`docs/design/kernel-agnostic-goal.md` 第 20 行记了这个机制缺口：composerStats/composerActions/composerTop 原本不包 Provider，组件错认 timeline 的 pluginId，`events.emit` 所有权校验必炸（goal:state 首次触发即暴露）。这是「槽消费者必须按贡献方 pluginId 包裹」的通用纪律。

## 6 事件通道与状态

- **`channels` 导出**（`index.tsx` 第 20 行）：`["timeline:scrollTo", "timeline:rewindRequested", "timeline:composerAttachments", "timeline:focusComposer", "timeline:cycleModel", "timeline:cycleThinking"]`。框架 import module 后读 `module.channels` 注册到事件总线（`event-bus.ts` 第 55 行 `registerChannels`），并记录归属 pluginId。`emit` 只能发自己声明的 channel（越权抛错），`on` 校验 channel 来自某已加载插件或 `system:*`。

- **`channelMeta` 导出**（第 23–51 行）：六个 channel 的可读描述，含 `label`/`description`/`payloadExample`。`ChannelInfo`/`ChannelMeta` 类型在 `packages/shared/src/channel/channel-meta.ts`；事件总线 `registerChannels` 时把 meta 挂到 channel state（第 68 行），快捷键/命令面板类插件经 `listChannels()` 枚举时读到它，无描述则回退显示 channel 名。

- **timeline 作为订阅方的 channel（`on`）**：

  - `timeline:composerAttachments`（第 181 行）：payload `ComposerAttachmentPayload`（圆心契约，`contributions.ts` 第 234 行）。review invoke 它挂载评论篮子数据，timeline 缓存进 `attachments` state。这是 invoke 语义的通道（携带参数的命令，`docs/design/plugin-decoupling.md` 第 61 行）。

  - `timeline:rewindRequested`（第 314 行）：payload `{message, text}`。`RewindAction` 自己 emit 它，timeline 订阅它调 `openRewind` 打开内联回退框。self-emit/self-on 的闭环——按钮组件是槽贡献、无 pluginId 感知，经通道回到宿主组件处理。

  - `timeline:scrollTo`（第 492 行）：payload `{messageId?, position?:"top"|"bottom"}`。`position:"top"` 滚 index 0、`position:"bottom"` 滚 `"LAST"` align end、`messageId` 走 `scrollToMessageId`。外部（session-tree/session-bookmarks/session-colors/review）invoke 它。

  - `timeline:focusComposer`（第 1023 行）：无 payload。`document.querySelectorAll("[data-timeline-composer]")` 取最后一个聚焦。review 浮层编辑器确认入篮后 invoke 它移交焦点。

  - `timeline:cycleModel`（第 635 行）：payload `{direction?:1|-1}`。在 `models` 清单找当前模型的下一个/上一个，走 `pickModel`。keybindings invoke 它。

  - `timeline:cycleThinking`（第 649 行）：payload `{direction?:1|-1}`。在 `levels` 清单找下一个/上一个，走 `pickLevel`。keybindings invoke 它。

  - `stickers:fillComposer`（第 357 行）：payload `{text?, image?:{src?,title?,dataUri?}}`。text 追加进输入框（`\n\n` 衔接），image 挂 `PendingImageBar`。try/catch 包裹——stickers 是可选插件，channel 未注册时 `on()` 抛错被吞，绝不影响 timeline 自身。

  - `stickers:send`（第 1008 行）：payload `{text?, image?:{src?,title?}}`。调 `sendTextRef.current(p.text, ...)`，与点击发送按钮同一条发送动作。

  - `pi-manager:defaultChanged`（第 423 行）：payload `{provider, modelId}`。刷新 `defaults` 镜像（新会话壳的显示与 pending 种子），只刷新内存不写持久状态。

  - `goal:state`（第 791 行，`{replayLast:true}`）：payload `{active?}`。active 置 `goalActive`，输入框挂 `.pi-composer-goal` 绿晕。`replayLast` 补回订阅前已发出的状态；订阅 effect 以 `pluginsNonce` 键控重试——插件并行加载时 timeline 可能先挂载而 goal 的 channel 尚未注册，每次插件集合变化重试订阅，goal 后到也能接上。

  - `system:refreshRequested`（第 286 行）：框架系统事件，操作完成方（main 侧 kernel:install/setCustomCliDir）广播后 plugins-host 桥接，timeline 收到重探 `refreshExternals`。

  - `system:configFileSaved`（第 294 行）：框架系统事件，payload `{path?}`，`path === MODELS_CONFIG_PATH`（`~/.pi/agent/models.json`）时重探 `refreshExternals`。

- **timeline 作为发布方的 channel（`emit`）**：只有 `timeline:rewindRequested`（`message-actions.tsx` 第 34 行，`RewindAction` 点击时 emit）。timeline 不 invoke 任何别的插件的 channel——解耦后（`docs/design/plugin-decoupling.md` 第 165 行）原来 emit 给 review 的六个 `review:*` 通道全部消失，编辑/删除动作归位到 review 自己的组件内直调状态，timeline 只留这一个自闭环 emit。

- **`ctx.sessions.onEvent` 订阅**（非事件总线，是内核中性事件流）：第 390 行订阅 `autoRetryStart`/`autoRetryEnd` 维护 `retrying` 状态（attempt/maxAttempts/errorMessage），第 408 行订阅 `compactionStart`/`compactionEnd` 维护 `compacting`。两者都是 `phaseFromView` 的覆盖态输入。第 402/415 行在 `currentNeutralSessionId`/`syncNonce` 变化时清残留，上一会话的重试/压缩状态不带进新会话。

- **状态合成**：`phase = phaseFromView(messages, streaming, {retrying: retrying !== null, compacting})`（第 418 行）。`phaseFromView` 在圆心 `working-phase.ts`，覆盖态优先 → 不流式 idle → 末条 pending 消息定阶段 → requesting。`PHASE_META`（第 91 行）映射五阶段到 i18n key + 颜色 + pulse（requesting 灰不 pulse、thinking 蓝紫 pulse、toolExecuting 绿 pulse、outputting 蓝 pulse、compacting 灰不 pulse）。retrying 不在此表，由重试横幅 `timeline.autoRetryInProgress` 承担（第 1211 行）。

## 7 本插件如何与其他插件交互

- **谁往 timeline 的槽位填**：message-blocks/goal/review 填 `blockRenderers`；sub-agent 填 `messageRenderers` 和 `composerPolicies`；review 填 `composerAttachments`；stickers 填 `composerActions`；token-stats 填 `composerStats`；goal 填 `composerTop`；session-bookmarks/session-colors/timeline 自身填 `messageActions`。这些贡献方全都不 import timeline，只贡献静态 manifest + export 组件，timeline 经查槽 hook 拿到，双向解耦（`block-renderers.ts` 第 7 行注释「timeline 不认识贡献方，贡献方不认识 timeline」）。

- **谁 invoke timeline 的 channel（timeline 是被调方）**：

  - `timeline:scrollTo`：session-tree（`renderer/index.tsx` 第 141/186 行，单击节点/当前叶子定位）、session-bookmarks（第 219 行，收藏 fork 后定位锚点）、session-colors（第 203 行，内容钉定位）、review（`basket-bar.tsx` 第 36 行，点击引文跳原文）。payload 都是 `{messageId}`。这是 invoke 语义的既有先例（`docs/DESIGN.md` 第 502 行点名 `timeline:scrollTo` 是 invoke 范本）。

  - `timeline:focusComposer`：review（`renderer/index.tsx` 第 229 行，评论确认入篮后移交焦点）、keybindings（`core/bindings.ts` 第 19 行 `mod+k`）。

  - `timeline:cycleModel`：keybindings（第 23–24 行 `mod+shift+]`/`mod+shift+[`，payload `{direction:1|-1}`）。

  - `timeline:cycleThinking`：keybindings（第 25–26 行 `mod+alt+]`/`mod+alt+[`）。

  - `timeline:composerAttachments`：review（`renderer/index.tsx` 第 149 行，挂评论篮子）。

- **谁向 timeline 的 channel 发（timeline 是订阅方）**：stickers emit `stickers:fillComposer`/`stickers:send`（`sticker-composer-button.tsx` 第 93/102 行）；goal emit `goal:state`（`goal-controller.ts` 第 60 行 `setGoal` 单一写入口）；pi-manager emit `pi-manager:defaultChanged`（`models.tsx` 第 9 行）。

- **dependsOn 关系矩阵（谁声明依赖谁）**：timeline `dependsOn:["pi-manager","message-blocks","stickers","goal"]`；review `dependsOn:["timeline"]`；session-tree `dependsOn:["timeline"]`；session-bookmarks `dependsOn:["timeline","session-tree"]`。方向可读：凡 invoke/on 别人 channel 的插件声明依赖被依赖方。review/session-tree/session-bookmarks 依赖 timeline（因为它们 invoke `timeline:*`），timeline 依赖 pi-manager/stickers/goal（因为 on 它们的 channel）。message-blocks 是唯一「槽依赖」进 dependsOn 的特例（无 channel，渲染真身依赖）。keybindings 没声明 `dependsOn:["timeline"]`（`docs/design/content-pins.md` 第 282 行有同类论证：dependsOn 语义是「依赖方在线时被依赖方不可停用」，timeline 停用时中区本就是空壳，绑死生命周期无意义）。

- **与 review 的解耦史**：review 是 timeline 交互最深的一方。`docs/design/plugin-decoupling.md` 记录了从「timeline 代劳渲染评论篮子」到「review 贡献 composerAttachments 槽组件、timeline 只挂槽」的归位——数据仍经 `timeline:composerAttachments` 通道送达（review invoke），但「谁画」从 timeline 挪回 review。timeline 侧 `ComposerAttachmentPayload` 不再本地定义，引用圆心 `contributions.ts` 第 234 行的契约单源（`index.tsx` 第 99 行注释）。

- **与 sub-agent 的输入框只读**：sub-agent 贡献 `composerPolicies`（`customKey:"subagent"`）。timeline 从 `sessionInfos[currentNeutralSessionId].custom` 读 `sessionCustom`，若 `sessionCustom["subagent"]` 有值，输入框整个换成只读条——这是「会话是 sub-agent 的产物、不应在主输入框续写」的数据驱动策略，条件是 custom 域 key 的存在性，无需函数（`ComposerPolicyContribution` 契约第 205 行）。

- **与 stickers 的发送等效**：stickers 的两条 channel 都指向 timeline 的 `sendText`（`index.tsx` 第 933 行注释「发送动作——发送按钮与表情包(stickers:send 事件)共用的唯一入口」）。表情包「直接发送」与「加入输入框」分别走 `stickers:send`（等效点击发送按钮）和 `stickers:fillComposer`（追加进草稿），图以 dataUri 由 stickers 读文件提供，timeline 只挂载渲染不碰文件读取。

## 8 发送序列与状态机

- `sendText`（`index.tsx` 第 933 行）是所有发送入口的唯一汇聚点——发送按钮的 `send`、`stickers:send` 订阅、rewind 的 `handleRewindSend`（经 `useSessionStore.getState().sendMessage` 但同样的 doSend 前序）都收敛到同一条路径。序列：① 取 `trimmed` 与 `fromComposer`（判断「发的是不是输入框内容」决定是否清输入框）；② 把 `pendingFilesRef` 折成 `filesSection`（绝对路径引用，`timeline.attachedFilesLabel` 前缀）；③ 斜杠命令拦截——`trimmed.startsWith("/")` 时 `runComposerCommandIfMatch` 命中且返回 true 就吞掉发送；④ 空内容校验（有附件/文件/图时允许空正文）；⑤ `currentCwd` 缺失 toast `shell.openFolderFirst`；⑥ `kernelAvailable === false` 时 `refreshKernelStatus(currentModel?.kernel)` 复查自愈，仍不可用 toast `shell.kernelRequired`；⑦ `streaming && queueKey` 入队 `enqueueMessage`，否则 `doSend`。

- `doSend`（第 821 行）是真正走 RPC 的序列：取附件快照（活篮子 `matched` 优先，空则回落入队快照 `attSnapshot`）、取图（外部传入优先，否则消费 `composerImageRef`）、调 `useSessionStore.getState().sendMessage(currentCwd, text, {sendSuffix: src?.promptFragment, image: img})`。`sendMessage` 返回 `{ok, error, toolFilterFlushed}`——`ok:false` 时 toast `timeline.modelApplyFailed`；`toolFilterFlushed` 时 toast「工具过滤已应用/已清除」。发送成功才清挂图与附件。

- 排队机制：streaming 中按发送不入队就 `enqueueMessage(queueKey, fullText, snapshot, displayText)`，`displayText` 用 `timeline.queue.commentsOnly`/`timeline.queue.filesOnly` 给纯附件/纯文件项一个篮内文案。`flushQueue`（第 867 行）在 streaming 边沿 `true→false` 时触发（第 923 行 effect），把整队合并成一条 `q.map(x=>x.text).filter(非空).join("\n\n")` 发出，取队里最近一份附件快照。失败 `markQueueFailed` 整队标失败保留。`handleSendNow`（第 896 行）是「立即发送」：`ctx.messaging.abort()` 打断当前生成，只发队列这一条，其余条目等轮末 flush；`sendingRef` 互斥 + `pendingFlushRef` 挂起补 flush，防 abort 触发 streaming 边沿时与 `doSend` 并发把同一条发两次。

- 模型/思考强度点选的 `composerApplyTiming` 分派：`onSend`（默认）点选只写 `sessionModelPending[pendingKey]`（含 `kernel` 标，`pickModel` 第 597 行 / `pickLevel` 第 619 行），`sendMessage` 内部按「pending > 头 > fallback」三级拼 `SessionModelPrefs` 一次传 main；`immediate` 点选即 `ctx.models.setModel/setThinkingLevel` + `ctx.sessions.sync()`，失败 toast 后 `sync()` 取真值回落。`pickLevel` 换档必须随 pending 一起带 `kernel`，否则 send 回灌 `prefs.kernel` 缺失报「模型未携带内核归属」（第 618 行注释）。

- `currentModel` 展示链（第 547–554 行）五级：显式意图 pending → 活会话快照 `snapshot.state.model` → 会话头 `headerPrefs`（`parseSessionModelPrefs`）→ 应用级 `fallbackModel`（`modelsConfig.getFallbackModel`）→ pi settings 默认（`defaults`，仅 pi 语义）→ `models[0]`。每一级都过 `toModelInfoFallback(provider, modelId, kernel)` 按 `(kernel, provider, id)` 三字段全匹配查 `models` 配置清单，查不到返回 null 不合成兜底对象——防内核 `get_state` 内置回落模型（如 anthropic/claude-opus-4-8）在没配模型时露出来。

- `levels` 思考档位（第 344 行）：`capabilities.piExtension ? (thinkingLevels.length > 0 ? thinkingLevels : DEFAULT_LEVELS) : []`。pi 扩展面才有档位清单，dsh 下 `levels` 置空、`composer.tsx` 不画档位 dropdown + `cycleThinking` 落空——显式降级。`DEFAULT_LEVELS = ["off","minimal","low","medium","high","xhigh"]` 是档位清单的兜底常量。

- rewind（回退）序列：`RewindAction` emit `timeline:rewindRequested` → `openRewind` 置 `rewindTarget`（`streaming` 时 toast `shell.rewindStreamingBlocked`，无 `message.id` 直接 return）→ 内联 `Composer` 渲染在目标 user 消息下方（`data-rewind-inline`）→ `handleRewindSend` 先 `ctx.tree.fork(currentNeutralSessionId ?? "", rewindTarget.message.id)` 分叉换绑新会话，再 `useSessionStore.getState().sendMessage(currentCwd, text)`。`handleRewindStop`（第 692 行）按 `retrying && capabilities.piExtension` 分派 `ctx.pi.abortRetry()` 或 `ctx.messaging.abort()`。

- `refreshExternals`（第 249 行）是会话流外部资源的统一装载入口：`void refreshKernelStatus()`（探测当前模型归属内核可用性）+ `Promise.allSettled([ctx.piSettings.get(), ctx.modelsConfig.list(), ctx.modelsConfig.getFallbackModel()])` 并行装载。三个触发点：挂载时（第 279 行 effect）、`system:refreshRequested`（第 284 行）、`system:configFileSaved` 按 path 匹配 `MODELS_CONFIG_PATH`（第 293 行）。根因收敛：内核状态与模型清单不再各自挂载探测一次，新资源加在这里不逐资源加订阅。

## 9 QA

**Q：message-blocks 插件被禁用后，timeline 的会话流会发生什么？**

- timeline 不崩，但每个块都落 `PlainBlockFallback`（`block-renderer.tsx` 第 51 行）：`text`/`userText` 退化为 `whitespace-pre-wrap` 纯文本、`toolCall` 只显示工具名、`divider` 只显示 kind、`thinking`/`auxBlock`/`userIntent` 不渲。工具卡的参数/结果、思考链的折叠、气泡样式全部消失，只剩可读可滚的纯文本。这是 `PlainBlockFallback` 注释写明的设计——「只保证不崩、可读、可滚，不试图画得还行」。因为 timeline 声明了 `dependsOn:["message-blocks"]`，message-blocks 被禁时 timeline 也一并停用，所以这条路径实际发生在「message-blocks 模块损坏/组件 export 缺失」而非「被禁用」的极端情形。

**Q：review 插件不在场时，评论篮子的数据通道 `timeline:composerAttachments` 谁来填？**

- 没人填，`attachments` 恒为 null，`AttachmentRenderer` 永不渲染，`hasAttachments` 恒 false，`allowEmptySubmit` 退回只由 `pendingFiles`/`composerImage` 决定。数据通道 `timeline:composerAttachments` 是 timeline 自己声明的 channel，只有 review invoke 它（`review/renderer/index.tsx` 第 149 行）。review 被禁后 channel 仍在（timeline 还声明着），但无 invoke 方，timeline 的 `on` 订阅空转，零影响。

**Q：timeline 收到 `timeline:scrollTo` 但目标 messageId 还没渲染出来，会怎样？**

- 走 `scrollToMessageId` 的兜底（`index.tsx` 第 479 行）：先 `visibleMessages.findIndex` 找目标，命中且不在 `visibleRangeRef` 内就 `scrollToIndex` 平滑滚动；未命中登记 `pendingScrollRef.current = {messageId}`。第 508 行的 effect 监听 `visibleMessages` 变化，一旦目标出现就补滚（同样做可见性判断，目标已在视口则不滚）。评论锚的 entryId 失效（compaction、会话重载后 id 更替）时永远不命中，静默不跳——`docs/design/review-plugin.md` 第 70 行标为降级行为。

**Q：用户在 streaming 中连续发送多条消息，timeline 怎么处理它们的顺序与失败？**

- 每条在 `sendText` 第 964 行命中 `streaming && queueKey` 入队 `pendingQueue[queueKey]`，队列按入队序。streaming 边沿 `true→false` 触发 `flushQueue` 把整队 `join("\n\n")` 成一条发出。全空队列清空不发；失败 `markQueueFailed` 整队标 `failed:true` 保留，`QueueBasket` 显示重试/逐条编辑/整队重试。「立即发送」（`handleSendNow`）打断当前生成只发单条，失败 `markQueueItemFailed` 只标该条，`flushQueue` 的 `q.some(x => x.failed)` 会阻塞整队 flush，用户可编辑/移除/重试——不丢用户输入（`index.tsx` 第 862–895 行注释）。

**Q：为什么 `currentModel` 要五级兜底而不是直接读 `snapshot.state.model`？**

- 因为「当前模型」的真相随会话状态而变，单一来源会漏场景。活会话快照 `snapshot.state.model` 是实时真相，但历史会话（进程没起）没有快照，新会话壳（还没发过消息）进程没起，`snapshot` 为 null。五级链 `pending → 快照 → 头行 → fallback → pi默认 → 清单首项` 覆盖「已选未发/活会话/历史会话/新会话/全空」五种形态。每级都过 `toModelInfoFallback` 按 `(kernel,provider,id)` 三字段全匹配查 `models` 清单，防止内核 `get_state` 的内置回落模型在没配模型时露出来（第 536 行注释标了实证事故 anthropic/claude-opus-4-8）。

**Q：dsh 内核下 timeline 的思考档位 dropdown 和 `timeline:cycleThinking` 快捷键为什么失效？**

- `levels` 的计算（第 344 行）`capabilities.piExtension ? ... : []`：思考档位是 pi 扩展面，dsh 无此面，`capabilities.piExtension` 为 false 时 `levels` 置空。`composer.tsx` 的档位 dropdown 与 `ThinkingToggle` 只在 `levels.length > 0` 时渲（第 413/437 行），`timeline:cycleThinking` 的 handler 第 652 行 `if (!ls.length) return` 落空。这是 §7.6 显式降级——dsh 下档位入口整体隐藏，不静默发一个注定抛「不支持 pi 专属命令」的 RPC（`session-store.ts` 第 361 行 `refreshThinkingLevels` 也只在内核 piExtension 时拉取）。

**Q：timeline 挂了 `dependsOn:["pi-manager","message-blocks","stickers","goal"]`，但没挂 `dependsOn:["review"]`，为什么它能用 review 贡献的 composerAttachments 槽？**

- 槽依赖不进 dependsOn。dependsOn 的语义是「依赖方在线时被依赖方不可停用」的生命周期护栏，主要护 channel 消费（`on`/`invoke` 别人的 channel）。timeline 消费 review 的 `composerAttachments` **槽**（`useComposerAttachments()` 查 `window.kernel.slots.composerAttachments()`），不是 review 的 channel——槽查询按 `pluginsNonce` 失效重拉、拿不到组件就渲空，是声明式查表不是订阅。反过来的方向才需要 dependsOn：review `dependsOn:["timeline"]`，因为它 invoke `timeline:composerAttachments`/`timeline:focusComposer` 这些 timeline 的 channel。

**Q：timeline 自己 emit 的 `timeline:rewindRequested` 为什么还要自己 `on` 订阅，而不是 `RewindAction` 直接调 `openRewind`？**

- 因为 `RewindAction` 是 `messageActions` 槽贡献组件，它的 props 契约只有 `{message, text}`（`MessageActionContribution` 第 173 行 + `MessageActionProps` 第 8 行），不注入 timeline 的闭包/状态。按钮组件要触发宿主组件的动作，唯一合法通道是事件总线——emit 自己的 channel、宿主 `on` 订阅。这与 fileActions 的 `<pluginId>:fileActionInvoke` 约定频道同范式。直接调 `openRewind` 就得把 `openRewind` 塞进 props，破坏槽组件 props 契约的稳定性。
