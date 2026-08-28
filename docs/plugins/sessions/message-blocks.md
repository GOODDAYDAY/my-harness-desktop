# message-blocks：会话流块级渲染件插件技术文档

## 1 定位：会话流的「内容层」，不是「机制层」

- message-blocks 是 my-harness-desktop 的**内置壳插件**，`src/plugins/sessions/message-blocks/plugin.json` 里 `id: "message-blocks"`、`tier: "official"`、`protected: true`，它只 import `@my-harness-desktop/react` 和 `@my-harness-desktop/shared` 两个发布面，是洋葱最外层的内容插件。
- 它回答的问题只有一个：**会话流里「这一块画成什么样」**——Bash 卡长什么样、思考链怎么折叠、用户气泡怎么收起、分隔线配什么图标。
- 它不回答「消息怎么滚、怎么发、怎么进来」——那是 `src/plugins/sessions/timeline/` 的机制职责。这条分界就是 CLAUDE.md §1.2「机制与内容分离」在插件层的落点：timeline 是机制（Virtuoso 滚动、块分解、查槽分派），message-blocks 是内容（往 `blockRenderers` 槽挂渲染组件）。
- 这个插件的存在形态是「一个插件装全部内置渲染件」，而不是按块族拆五个插件。`docs/design/timeline-block-renderers.md` §4.2 记录了否决拆分的三条理由：共享件（`CardHeader`、`StreamingCaret`、`fmtArgs`）无处可去、拆细买不到东西（第三方覆盖粒度是 `names` 级，不需禁用整族）、无特权差异不受损（一个插件还是五个插件走同一槽、同一解析规则）。

### 1.1 它贡献了什么

- `plugin.json` 的 `contributes.blockRenderers` 挂 8 条贡献项，覆盖四种内置块词汇 + 一个开放字符串扩展：
  - `{id:"bash", block:"toolCall", names:["bash","execute_bash","run_tests"], component:"BashCard"}`；
  - `{id:"edit", block:"toolCall", names:["edit","write","multi_edit","edit_file","write_file"], component:"EditCard"}`；
  - `{id:"read", block:"toolCall", names:["read","read_file","grep","find","ls","glob"], component:"ReadCard"}`；
  - `{id:"default", block:"toolCall", component:"DefaultCard", order:100}`——没有 `names`，是 toolCall 块的**通用兜底项**；
  - `{id:"thinking", block:"thinking", component:"ThinkingChainBlock"}`；
  - `{id:"userText", block:"userText", component:"UserBubble"}`；
  - `{id:"userIntent", block:"userIntent", component:"CommentsOnlyBubble", order:100}`——`userIntent` 不在五种内置词汇里，是开放字符串扩展；
  - `{id:"divider", block:"divider", component:"EntryDivider"}`。
- 它**不再贡献 text 块**。`renderer/index.tsx` 第 4 行注释写明「文本块渲染(MarkdownText)已迁出为独立 markdown 插件」，text 块的通用渲染器现在挂在 `src/plugins/sessions/markdown/plugin.json` 的 `{id:"text", block:"text", component:"MarkdownText"}`。这一点对理解「五种内置词汇」很关键：契约有五种，但 message-blocks 只认领了其中四种，text 是别人认领的。
- 它同时贡献 `languages` 槽：12 条语言资源项，`message-blocks.shell` / `message-blocks.timeline` / `message-blocks.plugin` 三个命名空间 × zh-CN / zh-TW / en / de 四语言。文案归属尺子只有一把——key 的消费者在哪个插件，key 就在哪个插件的 `locales/` 里。

### 1.2 renderer 入口：零注册、零字符串

- `renderer/index.tsx` 全文件只有 9 行，全部是 `export` 语句：`export { BashCard, EditCard, ReadCard, DefaultCard } from "./tool-cards"`、`export { ThinkingChainBlock } from "./thinking-chain-block"`、`export { UserBubble } from "./user-bubble"`、`export { CommentsOnlyBubble } from "./comments-only-bubble"`、`export { EntryDivider } from "./entry-divider"`。
- 组件名由框架自动匹配：加载器读 manifest 的 `component` 字段，在 module exports 里找同名导出。插件代码里没有一个 `registerXxx` 调用、没有一个写死的贡献 id 字符串字面量——这是 CLAUDE.md §7.4「组件自动匹配」和 §8.3「零硬编码」的兑现。
- 需要注意：blockRenderers 组件的自动匹配走的是 `packages/react/src/plugin-modules.ts` 的 `getPluginComponent(pluginId, component)`（渲染期同步查 `pluginModules` Map），**不是** `registerPluginComponents` 那套 `componentRegistries`（后者只覆盖 settings/sidePanel/sidebar/mainView/titlebar 五个槽）。所以 message-blocks 的组件只要在 module 顶层 export 即可，不经过任何注册函数。

## 2 契约层：`BlockRendererContribution` 与五种内置词汇

- 契约的唯一源在 `packages/shared/src/domain/contributions.ts` 第 465–477 行的 `BlockRendererContribution` 接口，字段只有五个：`id`、`block`、`names?`、`component`、`order?`。
- `id` 是插件内唯一标识，同 id 被后注册插件整项替换（registry `removeById` 通用语义，注释里写明）。
- `block` 字段类型是 `"thinking" | "toolCall" | "text" | "userText" | "divider" | (string & {})`——五种内置词汇 + 开放字符串。开放字符串让未来块类型不挡，`userIntent` 和 `auxBlock`（skill/review 插件用）就是踩着这个开放后缀进来的。
- `names?` 只在 `toolCall` 和 `divider` 两个块类型上有意义：toolCall 比工具名（小写比较），divider 比 `kind`。缺省 = 该块类型的通用兜底项；声明 = 只在名字命中时生效。契约注释明确「无名字的块类型声明 names 是死贡献，静默跳过」——`thinking`/`text`/`userText` 没有名字可匹配，给它们声明 `names` 的项永远不会命中。
- `component` 是 renderer 侧组件名，框架从插件 exports 自动匹配；组件收到块类型对应的标准 props。
- `order` 是同层多项的胜负键，小者胜，缺省 100。
- 契约注释（第 457–464 行）把解析规则压缩成一句话：**「names 精确命中的特化层优先于未声明 names 的通用层；层内 order 小者胜，同 order 注册序后者胜；无名字的块类型声明 names 是死贡献，静默跳过。」** 这条是理解后面 `resolveBlockRenderer` 的钥匙。
- `SlotName` 联合（第 377–404 行）里有 `"blockRenderers"` 一项，`PluginContributes`（第 427 行）里有 `blockRenderers?: BlockRendererContribution[]`——槽的契约面与 message-blocks 的 manifest 声明是同一份类型的两端。

## 3 槽的查询与解析：二键解析 + 特化/通用分层

- 槽的 renderer 侧机制全部在 `packages/react/src/block-renderers.ts`，三段式落地：声明（plugin.json）→ 查询（`useBlockRenderers`）→ 解析渲染（`resolveBlockRenderer` + `resolveBlockRendererComponent`）。
- `BlockRendererItem` 是 `BlockRendererContribution & { pluginId: string }`——贡献声明再加一个来源 pluginId，是 registry 的运行时形态。
- `useBlockRenderers()`（第 19–33 行）镜像 `useMessageActions` 的 hook：读 `useUiStore((s) => s.pluginsNonce)` 做失效键，`pluginsNonce` 不变时命中模块级 `cache` 单发，变了才 `window.kernel.slots.blockRenderers()` 重拉。`pluginsNonce` 是插件集合版本号，插件增删启停时自增，槽清单随之失效重拉。

### 3.1 `resolveBlockRenderer`：四步确定论解析

- `resolveBlockRenderer(items, block, name?)`（第 39–54 行）输入 `(block, name?)` 二元组，`name` 只在 toolCall（工具名）和 divider（kind）时有值，`text`/`userText`/`thinking` 传 `undefined`。
- 第一步把 `name` 转小写（`name?.toLowerCase()`），`hits` 判定 `i.names` 里有没有和它相等的项（`n.toLowerCase() === lower`）。
- 第二步把候选分两池：`specialized = items.filter(i => i.block === block && hits(i))`（names 精确命中的特化层）、`generic = items.filter(i => i.block === block && i.names === undefined)`（未声明 names 的通用层）。
- 第三步定池：`const pool = specialized.length > 0 ? specialized : generic`——**特化层只要有一个候选就整体压过通用层**，这正是「兜底项不吞精确认领」的保证。
- 第四步池内 reduce 定胜负：`cur.order <= best.order ? cur : best`，从 `undefined` 起步。由于 `<=`（不是 `<`），**同 order 时后者胜**；而 items 数组按 source 升序（builtin → installed → user → project）注册，同 order 下「后注册者 = 高优先级 source」，所以同 order 时高优先级 source 胜出。规则链到此闭合，全程确定论、无随机分支。
- `resolveBlockRendererComponent(item)`（第 57–59 行）调 `getPluginComponent(item.pluginId, item.component)` 再经 `asReactComponent` 判定，拿不到组件视为无此候选（贡献声明了 component 但 exports 里没有），消费方落兜底。
- 这条解析规则与设计文档 §3.2 的 mermaid 流程图一一对应：过滤 → 有 names 命中进特化层 / 无进通用层 → 层内 order 小者胜 → 同 order 注册序后者胜 → `getPluginComponent` 匹配。

## 4 五种内置块类型的渲染（message-blocks 认领的四种 + text 归属说明）

### 4.1 `thinking` → `ThinkingChainBlock`

- 组件在 `renderer/thinking-chain-block.tsx`，props 契约 `ThinkingChainBlockProps`（第 9–16 行）：`content: ThinkingContent`、`streaming: boolean`、`startedAt?`、`completedAt?`、`collapseDefault?`。
- `ThinkingContent` 的唯一定义在 `packages/shared/src/domain/events/session-state.ts` 第 390–395 行：`{ type: "thinking"; thinking: string; redacted?: boolean; thinkingSignature?: string }`。`thinking` 是思考正文，`redacted` 标记模型提供方是否过滤了思考内容。
- 折叠语义：`useState(!collapseDefault)` 初始化折叠态，`useEffect`（第 38 行）在 `streaming` 时强制展开、非流式回落 `!collapseDefault`。注释写明「流式中强制展开：思考过程要『一点一点可见』，不能藏在折叠头后只露计时」——这是用户诉求驱动的行为。
- 计时语义：`startedAt`/`completedAt` 两个时间戳，流式中用 100ms 心跳 `setInterval` 实时刷新 `elapsed`（`formatDuration` 把毫秒格式化成人读的 `3.x s` / `2m3s`），非流式用 `completedAt - startedAt` 一次性结算。`useEffect` 依赖数组 `[streaming, startedAt, completedAt]`，清理函数 `clearInterval` 防止计时器泄漏。
- 停顿提示：`useStalledHint(streaming, content.thinking.length)` 复用流式件（§5）——思考文本 800ms 不增长时显示「思考时间较长…」。
- 标签三段式（第 76–81 行）：流式期 `stalled ? shell.thinkingStalled : shell.thinkingInProgress` 并拼 `elapsed` 实时计时；非流式 `shell.thinkingDone`（带 `{{duration}}`）或 `shell.thinkingProcess`。
- `content.redacted` 分支（第 61–72 行）：只渲染一个带 `Brain` 图标的 `shell.thinkingFiltered` 按钮，不渲染正文——思考被模型方过滤时不假装有内容。
- 正文渲染：展开时 `<StreamTextReveal text={content.thinking} streaming={streaming} />`，流式中防抖 + 光标 + 停顿提示，非流式直接渲染原文。`renderer/thinking-chain-block.test.tsx` 用 `vi.useFakeTimers` 锁了两条回归：流式期 label 必须露出实时计时（不是只显示静态「思考中…」）、非流式期保持「思考已完成」语义。

### 4.2 `toolCall` → 四张卡（Bash/Edit/Read/Default）

- 四张卡全在 `renderer/tool-cards.tsx`，`type ToolCallItem = ToolCallBlock` 标注「toolCall 块形状以 domain ToolCallBlock 为唯一源（曾本地各写一份，已收敛）」。
- `ToolCallBlock` 定义在 `session-state.ts` 第 361–368 行：`{ id?; name; args?; state?; result?; isError? }` 六个字段，`toolCallsOf(content)` 是唯一提取器（第 372–387 行），字段名 `name`/`args` 只有这一份解析。
- 共享口径 `wrapAnywhere`（第 15 行）：`{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }`——pre-wrap 只在空白符处断行，无空格长串（base64/单行 JSON/长路径）会横向溢出，`overflowWrap: anywhere` 补任意处断行。五个输出容器（Bash/Read grep/diff/Default）共用这一处。
- `toolIcon(name)`（第 17–25 行）按工具名映射 lucide 图标：bash 三兄弟 → `Terminal`、edit 五兄弟 → `FileEdit`、read 六兄弟 → `FileSearch`、`toolresult` → `Check`、`custom_message` → `FileText`、未知 → `Wrench`。
- `toolSummary(args)`（第 27–32 行）从 args 里取 `path ?? file_path ?? command ?? pattern ?? cwd` 做摘要；`fmtArgs`/`fmtResult`/`contentBlocksText`（第 34–57 行）是 DefaultCard 的参数/结果格式化三件套，其中 `contentBlocksText` 处理「结果折回内核 content 块数组」（如 `bus_status`）时取 text 块拼文本。
- `CardHeader`（第 59–125 行）是四张卡共享的头部：左 3px 边框着色（错误 `--color-accent-error`、流式 `--color-accent-success`、toolResult/custom_message `--color-primary`）、图标 + 摘要 truncate、流式时 `running` shimmer + 左侧 `tool-live-pulse` 动画竖线、完成态 `Check`/`X`、折叠 `ChevronRight`/`ChevronDown`，`role="button"` + `tabIndex=0` + `Enter`/`Space` 键盘触发。
- **BashCard**（第 138–195 行）：`BashArgs = { command?, cwd? }`、`BashResult = { output?, exitCode?, truncated?, fullOutputPath? }`。`output` 优先取 `result.output`，否则 `result` 是 string 就取 string，否则 `contentBlocksText(result)`。`isError = toolCall.isError || (exitCode !== undefined && exitCode !== 0)`。`isStreaming = state === "pending" || state === "running"`。展开态：第一行 `$ command`、正文 `lines.slice(0, 200)` 截断（超出补 `...N lines collapsed`）、流式挂 `StreamingCaret`、非流式且 `exitCode !== undefined` 显示 `exit N`、`truncated && fullOutputPath` 时显示完整输出路径。
- **EditCard**（第 222–284 行）：三态分派。`a.edits?.length > 0` 走 diff 态——每个 edit 用 `FallbackDiff`（第 204–220 行）逐行渲染 `-` 旧行（error 色）/`+` 新行（success 色），并标 `edit i+1/N`；`a.content != null` 走整文件写入态，渲染 `<pre>` 原文；两者都不满足回落 `<DefaultCard>`。`path = a.path ?? a.file_path`。
- **ReadCard**（第 355–428 行）：`usePluginContext()` 拿 `ctx.dialog.openFile` 做文件跳转。`read`/`read_file` 分支解析 `ReadResult.content` 块数组，`type === "image"` 的块用 `<img src={data:${mimeType};base64,${data}}>` 直接内联渲染（read 工具可能读图片），否则 text 块拼成 `<pre>`；`grep`/`find`/`ls`/`glob` 分支用 `CollapsibleOutput`（第 308–353 行）——`parseFileLine` 正则 `^([^:\s]+):(\d+):` 解析 `file:line`，命中行的行可点击、`onOpen(file, line)` 调 `ctx.dialog.openFile`，`truncated`/`matchLimitReached` 时显示 truncated 提示。
- **DefaultCard**（第 430–506 行）：兜底卡，承载 `custom_message`/未知工具（如 `claude-md-context` 注入）。默认收起（注释：args/result 动辄长文，铺开会刷屏），展开显示「参数」+「结果」两段，`fmtArgs` 出 key/value 行（key 用 `--color-primary`、value `break-all`）、`fmtResult` 出结果 `<pre>`。`borderColor` 逻辑与 CardHeader 同款。
- 最后一行 `ToolCardRenderer`（第 508–514 行）是迁移前的那串工具名 if-else 分派函数，**当前已无任何调用点**（grep 全仓只在 tool-cards.tsx 自身出现），是搬家后留在文件里的遗留代码——槽路径的分派已经改由 `resolveBlockRenderer` 的 names 机制承担，这个函数不再在渲染链上。

### 4.3 `text` → 已迁出，归属 markdown 插件

- message-blocks 不再渲染 text 块。`src/plugins/sessions/markdown/plugin.json` 贡献 `{id:"text", block:"text", component:"MarkdownText"}`，`MarkdownText` 收 `{ text: string; streaming: boolean }` props，做 GFM、代码块卡、围栏语言经 `codeBlockRenderers` 槽分发。
- text 块在块词汇里的角色是「assistant 消息的正文文本」，由 `blocks.ts` 分解器产出，`messageContentText(content)` 是唯一文本提取器（`packages/shared/src/domain/text.ts` 第 36–45 行，数组 content 只拼 `type === "text"` 的块）。
- 文档收录 text 是「五种内置词汇」完整性的要求，但它不是 message-blocks 的组件——写覆盖类文档时要分清「契约词汇有 text」和「text 的渲染器在 markdown 插件」两件事。

### 4.4 `userText` → `UserBubble`

- 组件在 `renderer/user-bubble.tsx`，props `{ text: string; maxLines = DEFAULT_MAX_LINES }`，`DEFAULT_MAX_LINES = 10`。
- 收起用 CSS `-webkit-line-clamp: maxLines`（Chromium 原生），注释写明「手数 `\n` 会在『一行很长但没换行符』时漏判，不造轮子」——软换行/断词/全角都算行。
- 溢出测量用 `useLayoutEffect`（第 36–40 行）：`el.scrollHeight > el.clientHeight + 1` 判 `clamped`。关键根因注释（第 34–36 行）：「能量出真实裁切的前提是收起态默认挂着 clamp——若反过来『先证明溢出才挂 clamp』，无高度约束时 scrollHeight 恒等于 clientHeight，永远量不出溢出，收起从不生效（鸡生蛋）」。
- 点外收回：`document mousedown` 监听只在 `expanded` 期间挂载（第 43–50 行），`bodyRef.current.contains(e.target)` 判断，展开态点了气泡外（tab 切走/点别条消息/点输入框）即收回，清理函数 `removeEventListener`。
- `toggle`（第 52–56 行）：不超行且无展开态时是纯文本气泡，不响应点击（保持选择文本的手感）；超行才挂展开/收起交互。`interactive = clamped || expanded` 门控 `title` 和 `cursor`。
- 视觉：右对齐 `flex justify-end`、`max-w-[65%]`、surface 底、细投影，收起态底部渐隐（`linear-gradient` 到 surface 色）+ `ChevronDown`，展开态 `ChevronUp`。

### 4.5 `divider` → `EntryDivider`

- 组件在 `renderer/entry-divider.tsx`，props `{ kind; i18nKey; i18nArgs?; detail?; tone? }`。
- `DIVIDER_ICONS`（第 9–18 行）是本插件内部的兜底呈现表：`model → Cpu`、`thinking → Brain`、`compaction → Archive`、`branch → GitBranch`、`info → Pencil`、`label → Bookmark`、`entry → FileQuestion`、`retry → RotateCcw`，表里没有的 kind 回退 `DIVIDER_ICONS.info`（Pencil）。
- 注释明确这张表的性质：「本插件内部的兜底呈现表，表里没有的 kind 无图标（与搬家前行为一致），任何插件可声明 names 精确接管」——它已经从 timeline 里的唯一写死分支，降级为内容插件内部的合法内容。
- 文案：`t(i18nKey, i18nArgs)`，`i18nKey` 是契约 key（如 `timeline.modelChange`、`timeline.compaction`），值由语言插件/本插件的 `locales` 供给。`tone === "error"` 时文字用 `--color-accent-error`。
- `detail` 非空时头部可点击展开（`open` state + `ChevronDown`/`ChevronRight`），展开一个 `max-w-[85%]` 的灰字面板显示 `detail`（`whitespace-pre-wrap`），用于 compaction 摘要、branch 摘要、未知条目的原始 JSON 兜底。
- divider 的 `kind` 来源是 `packages/shared/src/domain/events/session-state.ts` 的 `sessionEntryToNeutral`（第 526–577 行）：`model_change → "model"`、`thinking_level_change → "thinking"`、`compaction → "compaction"`、`branch_summary → "branch"`、`session_info → "info"`、`label → "label"`、未知类型 → `"entry"`；`"retry"` 来自 timeline 的 `core/retry-collapse.ts`。所以 `DIVIDER_ICONS` 八个键正好覆盖当前协议产出的全部 kind。

### 4.6 `userIntent` → `CommentsOnlyBubble`（开放字符串扩展）

- `userIntent` 不在五种内置词汇里，是 `BlockRendererContribution.block` 开放字符串 `(string & {})` 的实践。message-blocks 贡献 `{id:"userIntent", block:"userIntent", component:"CommentsOnlyBubble", order:100}`。
- 语义：用户发了纯评论消息（正文留空），消息行需要一个真实用户气泡做「这是一条用户消息」的锚点，引用条（review 块）不悬空。
- 组件在 `renderer/comments-only-bubble.tsx`，无 props，渲染 `MessageSquarePlus` 图标 + `t("shell.commentsOnly")`（「仅评论」），视觉与 `UserBubble` 同形态（右对齐、surface 底、圆角、细投影）。
- 这个块的产生在 timeline 的 `blocks.ts`（第 34–37 行）：`parseUserBlocks` 剥离后 `main` 为空但 `blocks.length > 0` 时，push 一个 `{ type: "userIntent" }`——纯评论消息只有引用条、没有空气泡。

## 5 公共流式渲染件：`stream-text-reveal.tsx`

- 这个文件是 message-blocks 内部的内容件内聚依赖，四个导出件被思考链和工具卡共用，不是机制。
- `StreamingCaret`（第 19–36 行）：1.5px 静态竖线，颜色 `color-mix(in srgb, var(--color-fg) 50%, transparent)`，**不闪烁**（设计 §4.5.1 明确「静态竖线，不闪烁」），`aria-hidden` 藏起。
- `useStalledHint(streaming, deltaKey, stallMs = 800)`（第 46–79 行）：停顿提示 hook。流式中 `setInterval(stallMs / 2)` 轮询，`Date.now() - lastChangeRef.current > stallMs` 时置 `stalled = true`；`deltaKey`（通常是文本长度）变化时刷新 `lastChangeRef` 并清 stalled。非流式清 stalled 并提前 return。
- `useDebouncedValue(value, delayMs = 50)`（第 87–96 行）：50ms 防抖值。注释解释根因——高频 `message_update` 每 token 触发一次，防抖到 50ms 攒批后重渲染，避免每个 token 都跑一次 markdown 解析 + highlight。
- `StreamTextReveal({ text, streaming, children })`（第 106–147 行）：流式期间用 `debouncedText` + `StreamingCaret` 渲染，`stalled` 时追加 shimmer 渐变的 `...` 提示（`backgroundSize: "200% 100%"` + `animation: shimmer 2s linear infinite`）；非流式直接渲染 `children(text)` 或原文，不防抖、不加光标。
- 这个文件的头注（第 1–15 行）把它锚定到 `docs/plugins/08-plugin-timeline.md` 和 `docs/design-style-guide.md`，并声明职责边界：「本组件只负责『流式文本』这一种内容块——markdown 富文本由 markdown 插件处理，工具卡片由 tool-cards.tsx 处理，thinking 块由 thinking-chain-block.tsx 处理」。

## 6 aux 块合成：结构化块的识别、剥离与派发

- aux 块是「用户消息 content 里混入的机器可识别、对用户是噪声的结构化块」（skill 展开块、review 评论块）。机制与内容分离：机制在圆心和 timeline，内容在 skill-manager 和 review 插件，message-blocks 完全不感知 aux 块。
- 圆心契约在 `packages/shared/src/domain/aux-blocks.ts`，零依赖。`AuxBlock`（第 10–18 行）四个字段：`type`（`"skill" | "review" | 未来任意`）、`data`（载荷，形状由贡献方定义）、`start`/`end`（块在原文中的起止位置，start inclusive、end exclusive，由 parser 精确给出）。
- `AuxBlockParser`（第 22–26 行）契约：`{ id: string; parse(text): { blocks: AuxBlock[] } | null }`——基于原文扫描，提取所有本类型完整块，无匹配返回 null，解析器互不干扰（各扫各的类型）。
- `parseUserBlocks(text, parsers)`（第 32–52 行）是汇总纯函数：收集所有 parser 的结果、按 `start` 升序排序、按 `[start, end)` 区间切片剥离全部块得 `main`（`replace(/\n{3,}/g, "\n\n")` 压缩连续空行再 `trim`）。注释强调「按 start/end 切片、区间不重叠」是契约硬化——此前 `indexOf(raw)` 猜边界在重复块上会剥离错乱，改 start/end 后两条内容完全相同的块各有唯一区间，切片互不干扰。
- 注册表在 `packages/react/src/aux-block-parsers.ts`：模块级 `parsers` 数组 + `registerAuxParsers`（按 id 覆盖/追加）+ `unregisterAuxParsers(ids)` + `getAuxParsers()`。
- 收集在 `src/web/app/plugins-host.ts`：`loadBuiltin`/`loadThirdParty` 里与 `mod.channels` 同批收集 `mod.auxParsers` → `registerAuxParsers`，`pluginAuxParserIds` Map 记录「插件 → parser id 清单」；`onUnloaded` 里 `unregisterAuxParsers(parserIds)` 摘除。
- 两个内容实例：`src/plugins/manager/skill-manager/renderer/skill-aux.tsx` 导出 `auxParsers`（`id: "skill"`，正则 `SKILL_BLOCK_RE` 去锚定 + `matchAll`，`start/end` 用 `m.index` / `m.index + m[0].length`）和 `SkillAuxBlock`；`src/plugins/sessions/review/renderer/index.tsx` 导出 `auxParsers`（`id: "review"`，`<pi-review>` 正则 + `itemRe` 条目正则 + `escapeAttr`/`unescape` 对称转义）和 `ReviewAuxBlock`。
- aux 块的派发**复用 blockRenderers 槽**：skill-manager 贡献 `{id:"skill-aux", block:"auxBlock", names:["skill"], component:"SkillAuxBlock", order:100}`，review 贡献 `{id:"review-aux", block:"auxBlock", names:["review"], component:"ReviewAuxBlock", order:100}`。`auxBlock` 是开放字符串 block 类型，`names` 匹配块 `type`——查槽、order、覆盖语义全部复用既有机制，机制侧零新增。
- 渲染器 props 契约 `{ aux: AuxBlock }`：`SkillAuxBlock` 渲染一行「🧠 skill-name · args首行」、点击展开 SKILL.md 正文（`max-h-64` 滚动，`location` 不渲染）；`ReviewAuxBlock` 渲染引用条（`seq` accent 色 + `❝quote` 斜体截断 + `→` + comment，靠右对齐、逐条可见、无展开无跳转）。

## 7 与 timeline 的交互：分解 → 查槽 → 分派

- timeline 是消费方，message-blocks 是贡献方，双方互不认识，只靠 `blockRenderers` 槽契约通话。整条链路分四步：`decomposeMessage` 分解 → `BlockRenderer` 查槽解析 → 组件渲染 → 解析不到落兜底。

### 7.1 分解：`blocks.ts` 的 `decomposeMessage`

- `src/plugins/sessions/timeline/renderer/blocks.ts` 的 `decomposeMessage(message, auxParsers = [])` 是纯函数（无 React/无 IO，可裸单测），输出 `TimelineBlock[] | null`。
- `TimelineBlock` 联合（第 14–21 行）七种形状：`thinking` / `toolCall` / `text` / `userText` / `userIntent` / `divider` / `auxBlock`。五种内置词汇 + `userIntent`（纯评论占位）+ `auxBlock`（结构化块）。
- user 分支（第 28–40 行）：`stripToolLimitNote(messageContentText(content))` 剥工具限制前缀 → `parseUserBlocks` 得 `{main, blocks}` → `main` 非空 push `userText`，否则若 `blocks.length > 0` push `userIntent` → 逐个 push `auxBlock`。注释写明 `auxParsers` 由调用方注入、注册表在模块加载期填充，保持本函数纯。
- assistant 分支（第 42–49 行）：`thinkingBlocksOf` 出 thinking 块 × N、`toolCallsOf` 出 toolCall 块 × N、`messageContentText` 出 text 块 × 0..1——组序保持现行「思考 → 工具 → 文本」。
- divider 分支（第 51–60 行）：一个 divider 块，`kind`/`i18nKey`/`i18nArgs`/`detail`/`tone` 直取直传，不加工。
- bashExecution 分支（第 62–73 行）：合成一个 toolCall 块，`name: "bash"`，`args` 由 `command`/`cwd` 拼出，`isError` 由 `exitCode` 推——这是**归一**不是特殊分支，渲染侧完全不感知它与普通工具调用的差别。
- `display === false` 返回 null（第 78 行），未知 role 合成一个 toolCall 块（第 80–90 行，`name` 取 `toolName ?? name ?? role`，保留 `toolCallId → id` 供折叠函数补折）。

### 7.2 分派：`block-renderer.tsx` 的 `BlockRenderer`

- `src/plugins/sessions/timeline/renderer/block-renderer.tsx` 是「本文唯一新写的机制代码」（文件头注），职责一句话：拿到块 → 查 `blockRenderers` 槽 → 按 `(block, name?)` 解析出贡献组件 → 按块类型拼标准 props 渲染。
- `name` 计算（第 21 行）：`block.type === "toolCall" ? block.toolCall.name : block.type === "divider" ? block.kind : block.type === "auxBlock" ? block.aux.type : undefined`——toolCall 比工具名、divider 比 kind、auxBlock 比块 type、其余无 name。
- 解析与组件匹配（第 22–23 行）：`resolveBlockRenderer(items, block.type, name)` → `resolveBlockRendererComponent(item)`，`Comp` 拿不到就 `<PlainBlockFallback block={block} />`。
- 流式语义按消息自持（第 25–26 行）：`pending = message.pending === true`，**不读全局 streaming**——这是根因修复，流式起止翻转不该让完成态消息 DOM 整体替换。
- props 拼装 switch（第 27–47 行）：thinking 传 `{content, streaming, startedAt, completedAt, collapseDefault}`（`completedAt` 流式中为 `undefined`，块内以 `Date.now()` 累计）；toolCall 传 `{toolCall, collapseDefault}`；text 传 `{text, streaming}`；userText 传 `{text, maxLines}`；userIntent 传无 props；divider 传 `{kind, i18nKey, i18nArgs, detail, tone}`；auxBlock 传 `{aux}`。
- `PlainBlockFallback`（第 51–62 行）：槽中无渲染器时的极简纯文本兜底——text/userText 显原文、toolCall 显工具名、divider 显 kind，thinking/auxBlock/userIntent 无短文本可显示直接 `return null`。头注强调「零依赖、无样式追求、不碰 i18n，只保证不崩、可读、可滚，不试图画得还行」。

### 7.3 消息行：`index.tsx` 的 `MessageRow`

- `src/plugins/sessions/timeline/renderer/index.tsx` 第 1316 行的 `MessageRow`（`memo` 包装）是分派链的最外层。
- 整消息渲染器优先（第 1322–1325 行）：`getMessageRenderer(message.role)` 命中即整条交给插件（`SlotRenderedRow`），不进块管线——`messageRenderers` 槽与 `blockRenderers` 槽是两级粒度，整消息覆盖先于块管线。
- 图片消息分支（第 1330–1338 行）：`role === "image"` 走 `parseImageContent` + `ImageBlock`，不进块管线。
- 常规路径（第 1340–1351 行）：`decomposeMessage(message, getAuxParsers())` → `blocks.map` 逐个 `<BlockRenderer>`，key 用 `toolCall.id ?? index`。
- user 分支（第 1355–1369 行）：图在气泡上方（`__image`）、`renderBlocks()`、`MessageMeta` + `MessageActions` 动作行，右对齐。
- assistant 分支（第 1371–1408 行）：行级内核标 + 模型名（`currentModel`）、`renderBlocks()`、空态 `PendingTimer`（blocks 空且 pending）、`(空消息)`（blocks 空且非 pending）、`stopped`/`error` 提示。
- divider/bashExecution/未知 role 分支（第 1410–1415 行）：无行 chrome，逐块渲染。
- `MessageRow` 的 `memo` 面不含 streaming（第 1312–1315 行注释）：流式起止翻转曾使全部行 memo 失效、完成态 DOM 整体替换、用户文本选区被物理摧毁——常规块管线的流式语义由 `message.pending` 自持（`BlockRenderer` 内），全局 streaming 只有 `messageRenderers` 的整消息渲染器需要。

### 7.4 依赖护栏与生命周期

- timeline 的 `plugin.json` 声明 `dependsOn: ["pi-manager", "message-blocks", "stickers", "goal"]`（第 12–17 行）——timeline 在线时 message-blocks 不能被停用/卸载。
- message-blocks 自身 `protected: true` 挡卸载（`protected` 插件可禁用但不能从注册表移除）。
- 两道合起来挡住「会话流裸奔」：`protected` 挡卸载、`dependsOn` 挡停用。代价是「想整体废掉内置渲染件只能连 timeline 一起停」，设计路径是逐块覆盖而非整体禁用（设计文档 §4.5、§7 QA）。
- 极端路径（message-blocks 被物理移出）系统照常启动，会话流退化为 `PlainBlockFallback` 纯文本——这是无特权差异铁律二「删掉内置件系统照常启动」的兑现（设计文档 §5.3、§6.1）。

## 8 i18n：三个命名空间、四语言、归属尺子

- `locales/` 下每语言三个文件：`shell.json`（组件自身文案）、`timeline.json`（divider 的 `i18nKey` 目标）、`plugin.json`（插件 displayName/description）。
- `shell.json` 承载 `ThinkingChainBlock`/`DefaultCard`/`UserBubble`/`CommentsOnlyBubble` 消费的 key：`shell.toolParams`、`shell.toolResult`、`shell.thinkingFiltered`、`shell.thinkingStalled`、`shell.thinkingProcess`、`shell.thinkingDone`、`shell.thinkingInProgress`、`shell.emptyMessage`、`shell.commentsOnly` 等。
- `timeline.json` 承载 divider 的 `i18nKey`：`timeline.modelChange`、`timeline.thinkingLevel`、`timeline.compaction`、`timeline.branchSummary`、`timeline.sessionRenamed`、`timeline.bookmark`、`timeline.unknownEntry`、`timeline.entry`、`timeline.divider`。这些 key 是 `sessionEntryToNeutral` 产出的契约 key，值是 message-blocks 供给的文案。
- 归属尺子（设计文档 §4.4）：key 的消费者在哪个插件，key 就在哪个插件的 locales 里。divider 相关 key 随 `EntryDivider` 搬来 message-blocks；`shell.emptyMessage`/`shell.stopped`/`shell.error` 等消息行 chrome 文案留在 timeline（消费者是 `MessageRow`）。
- 文案值全是主题 token 的消费者（`t("key")` 查 i18next），组件里没有一个写死的中文/英文文案——token key 是契约、值是内容，值与文案都外挂。

## 9 无特权差异与覆盖语义

- message-blocks 与任何第三方块渲染插件走同一条加载器、同一套契约、同一套权限，没有任何「识别内置件并特殊对待」的代码路径。
- 覆盖粒度是 `names` 级：第三方想在 `~/.my-harness-desktop/plugins/<插件名>/` 或 `<cwd>/.my-harness-desktop/plugins/<插件名>/` 里换掉 Bash 卡，只需声明一条 `{id:"my-bash", block:"toolCall", names:["bash"], component:"MyBashCard"}`——timeline 零改动、message-blocks 零改动、不等发版。
- 两条覆盖路径（设计文档 §7 QA）：**新 id 共存**是零售，只赢自己声明的 names，内置贡献继续演进（内置给 BashCard 的 names 清单加新工具名时，没声明的名字仍被内置接住）；**同 id 替换**是批发，`removeById` 整项顶替，内置该贡献未来的更新与你无关。默认选新 id。
- divider 同理：协议新增 kind `checkpoint` 后，任何插件声明 `{id:"cp", block:"divider", names:["checkpoint"], component:"..."}` 立即补上专属呈现，内置 `EntryDivider` 继续兜底其余 kind。
- 无名字的块类型（thinking/text/userText）没有「部分覆盖」语义——一种消息只有一种思考链/文本/气泡呈现，直接贡献不带 names 的通用项、高优先级 source 胜出即整类型替换。
- 第三方不能从外部发明新块类型：分解器输出的块类型是封闭的（五内置 + userIntent + auxBlock），`block` 字段开放字符串只是为「分解器未来认领新 content 形状时契约不用改」和「messageRenderers 插件内部表达自有结构」留空间。

## 10 QA

**Q：message-blocks 明明叫「消息块」，为什么 text 块（MarkdownText）不在它的贡献清单里？**

因为 text 块的渲染器已经迁出为独立的 `src/plugins/sessions/markdown/` 插件。`renderer/index.tsx` 第 4 行注释写明「文本块渲染(MarkdownText)已迁出为独立 markdown 插件」，markdown 插件的 `plugin.json` 贡献 `{id:"text", block:"text", component:"MarkdownText"}`。契约词汇有五种，但认领是分散的：message-blocks 认领 thinking/toolCall/userText/divider，markdown 认领 text。这是「内容按域内聚」的结果，不是遗漏。

**Q：`resolveBlockRenderer` 里 `specialized` 和 `generic` 是怎么分池的？为什么特化层能压过通用层？**

`specialized` 是 `block === block && names 含小写 name` 的项，`generic` 是 `block === block && names === undefined` 的项。`pool = specialized.length > 0 ? specialized : generic`——只要特化层有一个候选就整体选特化层，通用层（如 DefaultCard）完全不参与。这是「兜底项不吞精确认领」的保证：`{names:["bash"]}` 的 BashCard 永远赢不带 names 的 DefaultCard。层内再按 `order` 小者胜、同 order 后者（高优先级 source）胜。

**Q：message-blocks 被物理删掉后，会话流还能显示吗？**

能，退化为纯文本。timeline 的 `BlockRenderer` 里 `resolveBlockRendererComponent` 拿不到组件时落 `PlainBlockFallback`：text/userText 显原文、toolCall 显工具名、divider 显 kind，thinking/auxBlock/userIntent 不渲。这只保证「不崩、可读、可滚」，不试图画得还行。这正是无特权差异铁律二的检验方式——删掉内置件系统照常启动，只是少了那块功能。正常运维里 `protected: true` + timeline 的 `dependsOn: ["message-blocks"]` 会挡住卸载和停用，只有物理移出才走到这条降级路径。

**Q：`ToolCardRenderer`（tool-cards.tsx 末尾那串 if-else）还在用吗？**

不用了。它是搬家前写死的工具名分派函数，当前全仓没有任何调用点（grep 只在 tool-cards.tsx 自身出现）。槽路径的分派已改由 `resolveBlockRenderer` 的 names 机制承担，这个函数是留在文件里的遗留代码。写新代码不要参考它——正确的扩展姿势是贡献一条带 `names` 的 blockRenderers 项，而不是在这个 if-else 里加分支。

**Q：第三方能贡献一个新的 aux 块类型吗（比如自己的 `<foo>` 块）？**

能。机制侧已就绪：圆心 `parseUserBlocks` 汇总所有 parser、`aux-block-parsers.ts` 注册表收集 `mod.auxParsers`、blockRenderers 槽的 `auxBlock` 开放类型 + `names` 匹配块 type。内容侧只需两样：export 一个 `auxParsers: AuxBlockParser[]`（parse 里 `matchAll` 扫描自己的标签、填 `start/end`）、贡献一条 `{block:"auxBlock", names:["foo"], component:"FooAuxBlock"}`。skill 和 review 是现成样板，机制零改动。

**Q：divider 的图标表 `DIVIDER_ICONS` 里没有新 kind 时会怎样？**

落到 `DIVIDER_ICONS.info`（Pencil 图标）兜底，分隔线本体照出、文案照翻，只是图标不专属。这张表是 message-blocks 内部的兜底呈现，不是机制——协议加新 kind 后，任何插件声明 `{block:"divider", names:["新kind"]}` 就能立即补专属呈现，不用等内置发版；内置表也随 message-blocks 发版继续维护。两条路不互斥。

**Q：思考链的「思考时间较长…」提示和流式光标是从哪来的？为什么思考块和工具卡共享它们？**

都来自 `renderer/stream-text-reveal.tsx` 的四个公共件：`StreamingCaret`（1.5px 静态竖线，不闪烁）、`useStalledHint`（800ms 停顿判定）、`useDebouncedValue`（50ms 防抖）、`StreamTextReveal`（流式文本组件）。它们是内容件的内聚依赖——思考链用 `StreamTextReveal` 渲染思考正文、用 `useStalledHint` 判停顿，工具卡用 `StreamingCaret` 挂流式光标。设计文档 §4.1 把它们列为「共享渲染件随行」，只被这些卡消费，是内容不是机制，所以跟着搬进 message-blocks 而不是留在 timeline。

**Q：覆盖内置卡时，同 id 替换和新 id 覆盖怎么选？**

默认选**新 id**。新 id 是零售：只赢自己声明的 `names`，内置贡献继续存在、继续演进（内置将来给 BashCard 的 names 清单加新工具名时，你没声明的名字仍被内置接住）。同 id 是批发：`removeById` 整项顶替，内置那条贡献未来的更新与你无关，相当于冻结了它的演进。只有明确要「这条贡献从此归我管」时才用同 id。这是 `resolveBlockRenderer` 之外、发生在注册期的另一条覆盖语义，两者正交。
