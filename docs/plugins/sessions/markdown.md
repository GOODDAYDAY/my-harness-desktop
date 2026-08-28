# markdown：会话流文本块的 Markdown 渲染插件技术文档

## 1 定位：text 块的唯一渲染器，围栏语言的「分发者」而非「翻译者」

- markdown 是 my-harness-desktop 的**内置壳插件**，`src/plugins/sessions/markdown/plugin.json` 里 `id: "markdown"`、`tier: "official"`，`renderer: "./renderer/index.tsx"`。它只 import `@my-harness-desktop/react`、`@my-harness-desktop/shared` 两个发布面，外加 `react`/`react-i18next`/`react-markdown` 三个内容依赖，是洋葱最外层的内容插件。
- 它回答两个问题，两个问题的性质完全不同，要分清：
  - 第一问「assistant 消息的正文文本画成什么样」——GFM 表格、标题层级、行内代码、引用块、列表、链接，这是 text 块渲染器的本职。
  - 第二问「正文里的围栏代码块交给谁画」——它**不自己画** mermaid/puml/graphviz，而是按围栏语言名去 `codeBlockRenderers` 槽查一个渲染器，查到就把源码甩给对方、查不到就落高亮 `<pre>`。这正是 CLAUDE.md §3.1「消费而非翻译」的插件层兑现：markdown 是消费方，主动消费贡献方（mermaid/puml/graphviz）吐出的结构化能力，自己决定「这块归不归我、不归我就转交」，绝不把对方语言翻译成自己理解的形状。
- 与 timeline / message-blocks 的分工边界一句话：timeline 管「消息怎么滚、怎么分解、怎么分派」（机制），message-blocks 管「思考链/工具卡/气泡/分隔线画成什么样」（内容），markdown 管「文本块画成什么样 + 围栏语言转交给谁」（内容）。这条分界是 CLAUDE.md §1.2「机制与内容分离」在插件层的落点。
- `plugin.json` 的 `description` 字段自己把这个定位写死了：「会话流文本块的 Markdown 渲染:GFM、代码块卡、围栏语言经 codeBlockRenderers 槽分发」。

### 1.1 它贡献了什么

- `contributes.blockRenderers` 只有一条：`{ "id": "text", "block": "text", "component": "MarkdownText" }`——认领 `block === "text"` 这个块词汇的**通用项**（没有 `names`，`text` 块本就没有名字可匹配，见 §2.1）。
- `contributes.languages` 有 8 条语言资源项，两个命名空间 × 四语言：
  - `markdown.shell`（`shell.json`）：两个 key，`shell.copy`（复制）/ `shell.copied`（已复制），是 `CodeBlock` 卡片头部复制按钮的文案；
  - `markdown.plugin`（`plugin.json`）：`plugin.markdown.displayName` / `plugin.markdown.description`，插件在管理器里的显示名与描述。
  - 四语言是 zh-CN / zh-TW / en / de，与仓库其余内置插件（message-blocks/timeline/mermaid/puml/graphviz）同一套 locale 集合。
- 它**不声明** `permissions`、**不声明** `dependsOn`、**不声明** `protected`——这一点和 message-blocks 的 `protected: true` + timeline 的 `dependsOn: ["message-blocks"]` 形成鲜明对比（详见 §6.3、§8），是理解 markdown「缺席会怎样」的关键。

### 1.2 renderer 入口：零注册、别名导出

- `renderer/index.tsx` 全文件只有 4 行，核心一行 `export { Markdown as MarkdownText } from "./markdown"`——把 `markdown.tsx` 里导出的 `Markdown` 组件**别名**成 `MarkdownText`。
- 这个别名是必须的：manifest 里 `component: "MarkdownText"`，框架按这个字符串去 module exports 里找同名导出（CLAUDE.md §7.4「组件自动匹配」），而 `markdown.tsx` 里组件本名叫 `Markdown`，别名把「导出名」和「组件内部名」解耦。
- 组件名匹配走 `packages/react/src/plugin-modules.ts` 的 `getPluginComponent(pluginId, component)`（渲染期同步查 `pluginModules` Map），**不是** `registerPluginComponents` 的 `componentRegistries`（后者只覆盖 settings/sidePanel/sidebar/mainView/titlebar 五个槽）。所以 markdown 只要在 module 顶层 export，不经过任何注册函数、没有任何注册调用、没有写死的贡献 id 字符串——CLAUDE.md §8.3「零硬编码」的兑现。

## 2 契约层：`BlockRendererContribution` 的 text 块 + `CodeBlockRendererContribution`

### 2.1 markdown 认领的是 `BlockRendererContribution`

- 契约唯一源在 `packages/shared/src/domain/contributions.ts` 第 465–477 行的 `BlockRendererContribution` 接口：`id`、`block`、`names?`、`component`、`order?` 五个字段。
- `block` 字段类型是 `"thinking" | "toolCall" | "text" | "userText" | "divider" | (string & {})`——五种内置词汇 + 开放字符串。markdown 认领的 `text` 是五种内置词汇之一。
- 关键契约语义（接口上方第 457–464 行注释）：`text` 块**没有 name**，`names` 字段对 `text` 是死贡献——契约注释原文「无名字的块类型声明 names 是死贡献，静默跳过」。所以 markdown 这条贡献不带 `names`，是 text 块的通用兜底项。
- text 块的标准 props 契约是 `{ text: string; streaming: boolean }`（设计文档 `docs/design/timeline-block-renderers.md` §3.1 的表里明确），`text` 是块正文、`streaming` 是流式标记。markdown 的 `Markdown` 组件签名 `{ text, streaming = false }` 与此一一对齐，`streaming` 有默认值 `false` 使它也能被 file-preview 这类非流式消费方以 `streaming={false}` 复用（§6.4）。
- 这条贡献在 registry 里的落地和 message-blocks 的 8 条贡献走的是**同一个** `ArraySlot<BlockRendererContribution>`，`blockRenderers` 槽的解析规则（特化层优先于通用层、层内 order 小者胜）对 markdown 同样生效——只是 `text` 块没有特化层，永远只有通用项互搏（§8）。

### 2.2 markdown 消费的契约是 `CodeBlockRendererContribution`

- 契约定义在 `packages/shared/src/domain/contributions.ts` 第 307–320 行的 `CodeBlockRendererContribution` 接口：`id`、`languages: string[]`、`fileExtensions?: string[]`、`component`、`order?`。
- 契约注释（第 301–306 行）把分工讲死了：**「blockRenderers 管『整块类型』(text/toolCall/thinking…)，本槽管『文本块内部的围栏语言』」**——这是理解 markdown 的双重身份的关键：它同时是 blockRenderers 槽的**贡献方**（认领 text 块）和 codeBlockRenderers 槽的**消费方**（分发围栏语言）。
- `languages` 是围栏语言名清单，小写比较；`fileExtensions?` 是可预览的文件扩展名清单（不带点、小写比较），**markdown 不消费这个字段**，它只按 `languages` 分发（§4.3），`fileExtensions` 是 file-preview 消费的（§6.4）。
- 组件 props 契约是 `{ code: string; streaming?: boolean }`——契约注释原文「解析失败/流式未闭合时组件内部自降级为源码呈现，消费方不感知」。这条降级约定是 markdown 与 mermaid/puml/graphviz 之间「谁兜底」的分界：**兜底在贡献方组件内部，不在 markdown**。
- 契约在 `SlotName` 联合里有 `"codeBlockRenderers"`（第 398 行），`PluginContributes` 里有 `codeBlockRenderers?: CodeBlockRendererContribution[]`（第 429 行）——槽的契约面与 mermaid/puml/graphviz 的 manifest 声明是同一份类型的两端。

## 3 renderer 源码逐文件拆解

### 3.1 `markdown.tsx`：流式特化壳（50ms 防抖 + 静态光标）

- `renderer/markdown.tsx` 只有 18 行，导出 `Markdown = memo(function Markdown({ text, streaming = false }) {...})`。
- `memo` 包裹的根因（对照 `packages/react/src/plugin-modules.ts` 第 12–16 行 `asReactComponent` 的注释）：`memo()` 返回的是带 `$$typeof` 的 exotic 对象，不是普通函数——旧码只认 `typeof function`，`memo` 包装的导出会被静默丢弃、消费方落兜底，这曾是「会话流 markdown 长期退化为纯文本的根因」。`asReactComponent` 现已同时认 `function` 和 `$$typeof`，`Markdown` 的 `memo` 包装才不再被吞。
- 流式特化的核心是 `useDebouncedValue(text, 50)`（§3.2）：`streaming === true` 时渲染防抖后的 `debouncedText`，`false` 时直接渲染原始 `text`——非流式不防抖（防抖会延迟最终快照的落地）。
- 组件把 `text`（防抖后的 content）和 `streaming` 原样透传给 `<MarkdownBody text={content} streaming={streaming} />`，并在 `streaming` 时末尾追加 `<StreamingCaret />`。
- 头注一句话交代职责边界：「渲染配置在 markdown-body(槽分发)，本壳只做流式特化——50ms 防抖攒批 + 末尾静态光标」——把「画什么」全部下沉到 markdown-body，「流式怎么稳」留在本壳。

### 3.2 `stream-utils.tsx`：`StreamingCaret` + `useDebouncedValue`

- `renderer/stream-utils.tsx` 只有 31 行，两个导出件：
  - `StreamingCaret()`（第 4–21 行）：`<span class="stream-caret" aria-hidden>`，内联样式写死 `width: 1.5px`、`height: 1.05em`、`background: color-mix(in srgb, var(--color-fg) 50%, transparent)`、`borderRadius: 1px`、`transform: translateY(2px)`——**静态竖线，不闪烁**（头注「与 message-blocks 同规格」）。
  - `useDebouncedValue<T>(value, delayMs = 50)`（第 24–31 行）：`useState` 存 debounced 值 + `useEffect` 里 `setTimeout(setDebounced, delayMs)`，清理函数 `clearTimeout` 防泄漏，依赖 `[value, delayMs]`。
- **已知重复**：这两个件是 `src/plugins/sessions/message-blocks/renderer/stream-text-reveal.tsx` 里 `StreamingCaret`（第 19–36 行）和 `useDebouncedValue`（第 87–96 行）的**逐字节拷贝**——`stream-text-reveal.tsx` 的头注第 14 行还写着「markdown 富文本由 markdown.tsx 处理」，但 markdown 迁出时把流式件自持了一份，没有从 message-blocks import。这是「同一逻辑多处各写」的既有重复，写新代码时不应再复制第三份；严格看应把这两个流式件上提到 `packages/react` 让两边共用，但当前仓库里它们是两份平行实现。
- 防抖根因（抄自 stream-text-reveal.tsx 第 83–85 行注释）：高频 `message_update` 每 token 触发一次，防抖到 50ms 攒批后重渲染，避免每个 token 都跑一次 markdown 解析 + highlight。50ms 是设计锚定值（`docs/design-style-guide.md` §2.3.4）。

### 3.3 `markdown-body.tsx`：GFM 渲染 + 代码块卡 + 围栏分发

- 这是插件真正的「内容体」，134 行，结构四层：
  - `rawText(node)`（第 15–21 行）：从 ReactNode 递归还原纯文本，处理 `null`/`boolean`/`string`/`number`/`Array`/`isValidElement`（递归取 `node.props.children`）。它的存在是因为 rehype-highlight 会把代码高亮成 span 节点树，需要反向剥出纯源码（§4.2）。
  - `CodeBlock`（第 23–70 行）：不导出的内部组件，负责代码块卡片 + 围栏分发（§4 专述）。
  - `MarkdownBodyProps`（第 72–76 行）：`{ text: string; streaming?: boolean }`，`streaming` 注释写明「流式标记传给图块(流式期间不渲染,结束后成图)；文本本身的防抖由 Markdown 壳负责」——分工再次钉死。
  - `MarkdownBody({ text, streaming = false })`（第 78–134 行）：组件本体。
- `MarkdownBody` 先 `const codeBlockItems = useCodeBlockRenderers()` 拉一次 codeBlockRenderers 槽清单（§5.2），然后渲染外层 `<div className="markdown-body ...">`，内部 `<ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={{...}}>`。
- 两个插件决定了渲染能力：
  - `remarkGfm`（`remark-gfm` 包）启用 GFM 扩展——表格、删除线、任务列表、自动链接。这是 `plugin.json` description 里「GFM」三个字的来源。
  - `rehypeHighlight`（`rehype-highlight` 包）用 highlight.js 对**所有**围栏代码块做语法高亮——包括不路由到 codeBlockRenderers 槽的普通语言（js/ts/python/bash…）和会路由的 mermaid/puml/dot。
- 文件第 7 行 `import "highlight.js/styles/github-dark.css"` 写死了一个高亮主题——这是插件内部的**内容选择**（合法内容，对照 timeline-block-renderers.md §4.1「写死一张表在内容插件里是合法内容」同理），但要注意它是**恒 github-dark**，不随 app 主题明暗切换，与 mermaid 的 `isDarkMode()` 跟随主题不同（§6.2）。
- `components` 映射表（第 85–128 行）逐标签定制样式，全用主题 token var（`var(--color-fg)`/`var(--color-surface)`/`var(--color-border)`/`var(--color-muted)`/`var(--font-family-mono)`）而非写死色值，符合 CLAUDE.md §1.2「token key 合规、token 值违规」：`pre`（交给 CodeBlock）、`code`（分 inline/block 两态）、`p`、`h1`–`h4`（阶梯字号）、`ul`/`ol`/`li`、`blockquote`、`a`（`target="_blank" rel="noreferrer"`）、`table`（外层包横向滚动 div）、`th`/`td`、`hr`。

## 4 代码块卡与围栏语言分发：`CodeBlock` 组件的三段逻辑

### 4.1 lang 提取：`/language-(\w+)/` 正则

- `CodeBlock` 拿到 `children`（这是 react-markdown 渲染出的 `<code>` 元素），第 30 行 `const codeEl = children as ReactElement<{ className?: string; children?: ReactNode }>` 断言类型，第 31 行 `const className = codeEl?.props?.className ?? ""`。
- 第 32 行 `const lang = /language-(\w+)/.exec(className)?.[1] ?? ""`——react-markdown 给围栏代码块的 `<code>` 加 `language-<lang>` class，正则从里面抠出语言名。
- **一个边界要认账**：`\w+` 只匹配 `[A-Za-z0-9_]`，遇 `c++`、`c#`、`objective-c` 这类带符号的语言会截断成 `c`/`c`/`objective`。对 markdown 当前实际分发的四种语言（mermaid / puml / plantuml / dot / graphviz / gv）都是纯单词，不受影响；但写新代码不能假设 `lang` 是完整语言名，这是正则的固有截断。

### 4.2 rawText：从高亮节点树还原源码

- 第 33 行 `const text = rawText(codeEl?.props?.children)`——因为 `rehypeHighlight` 已把代码内容拆成一棵 `<span class="hljs-keyword">`/`<span class="hljs-string">` 的节点树，`rawText` 递归把它还原成**纯源码字符串**。
- 这个 `text` 有两个用途：
  - 复制按钮的载荷（§4.3），复制的是纯源码，不带任何高亮标记；
  - 传给 codeBlockRenderers 槽组件的 `code` prop——mermaid/puml/graphviz 拿到的是**干净的源码**，不含 hljs span 污染，这是它们能直接 `mermaid.render(id, code)` / `plantumlEncoder.encode(code)` / `viz.renderString(code, ...)` 的前提。

### 4.3 分发决策：`resolveCodeBlockRenderer` → `resolveCodeBlockRendererComponent` → 兜底 `<pre>`

- 第 43–44 行是分发的全部核心：
  - `const cbrItem = lang ? resolveCodeBlockRenderer(codeBlockItems, lang) : undefined`——有语言名才查槽，无语言名（纯文本块）不查；
  - `const CbrComp = cbrItem ? resolveCodeBlockRendererComponent(cbrItem) : undefined`——查到贡献项再匹配插件 exports 里的组件。
- 三段分支（第 61–67 行）：
  - `CbrComp` 有值 → `<CbrComp code={text} streaming={streaming} />`，把纯源码 + 流式标记甩给贡献方组件，markdown 从此不再管这块怎么画；
  - `CbrComp` 无值（槽中无此语言的渲染器）→ `<pre className="...!bg-transparent">{children}</pre>`，落 rehype-highlight 的高亮代码体——这是 markdown 的**自带兜底**，注释第 41–42 行写明「槽中无渲染器落普通高亮代码体——markdown 不认识任何具体语言」。
- 代码块卡片的外壳（第 46–60 行）两态共用：外层 `div` 圆角 + 边框 + `color-mix(in srgb, var(--color-bg) 55%, var(--color-border))` 半透明底；头部一条 `flex justify-between`：左 `lang || "text"` 语言标签（等宽字体、muted 色），右复制按钮。
- 复制按钮（第 35–39、53–59 行）：`copy()` 调 `navigator.clipboard.writeText(text)`，成功后 `setCopied(true)` + `setTimeout(() => setCopied(false), 1500)`，图标在 `copied` 时从 `<Copy>` 切到 `<Check>`，文案 `t("shell.copy")` / `t("shell.copied")`。注意 `navigator.clipboard` 需要安全上下文（localhost/https），这是浏览器能力不是插件能力。
- **兜底在谁**要分清：`CbrComp` 不存在时，markdown 落 `<pre>`（源码高亮）；`CbrComp` 存在但**它自己**解析失败/流式中，由贡献方组件内部落 `SourceFallback`（源码 `<pre>`）——两条降级路径互不重叠，markdown 只兜「查不到渲染器」这一层，不兜「渲染器渲染失败」那一层（§6.2）。

## 5 codeBlockRenderers 槽的机制链路（三段式）

- markdown 消费 codeBlockRenderers 槽，这条槽的机制链路和 blockRenderers 完全同构（`packages/react/src/code-block-renderers.ts` 头注「三段式机制(镜像 block-renderers.ts §3.3)」），四段：

### 5.1 注册：registry 的 `ArraySlot<CodeBlockRendererContribution>`

- `src/server/application/loader/registry.ts` 第 99 行 `private codeBlockRenderers = new ArraySlot<CodeBlockRendererContribution>()`，第 117 行把它挂进 `arraySlots` 映射，`registerOne`/`unregister` 经通用遍历（第 149–159、176 行）自动收编，一行循环不改——`ArraySlot`（第 55–72 行）注释「加新数组类槽只需加字段 + SlotName + 查询方法」的开闭承诺，codeBlockRenderers 是它的第二个兑现（第一个是 blockRenderers）。
- 覆盖语义同 blockRenderers：`registerOne` 里 push 前 `reg.removeById(id)`（第 156 行）清同 id 旧项，bootstrap 注册序 builtin → installed → user → project 保证后注册者高优先级。
- 查询方法 `codeBlockRendererItems()`（第 362–367 行）：`this.codeBlockRenderers.all()` 映射成 `{...contribution, pluginId, order: contribution.order ?? 100}` 再按 order 升序 sort、剥掉 order 字段返回。

### 5.2 查询：`useCodeBlockRenderers`

- `packages/react/src/code-block-renderers.ts` 第 14 行 `CodeBlockRendererItem = CodeBlockRendererContribution & { pluginId: string }`——贡献声明 + 来源 pluginId，registry 的运行时形态。
- `useCodeBlockRenderers()`（第 19–33 行）：读 `useUiStore((s) => s.pluginsNonce)` 做失效键，模块级 `cache = { nonce, data }` 同 nonce 单发（插件集合版本号不变不重拉），变了才 `window.kernel.slots.codeBlockRenderers()` 重拉，`alive` 标志防竞态。
- 链路到后端：`window.kernel.slots.codeBlockRenderers()`（`src/web/kernel/build-kernel.ts` 第 116–117 行）→ `transport.invoke(IPC.slots.codeBlockRenderers)` → `src/server/controllers/slots-dialog.ts` 第 20 行 `gateway.register(IPC.slots.codeBlockRenderers, () => registry.codeBlockRendererItems())`。
- **热加载二次 bump 的根因**（`src/web/app/plugins-host.ts` 第 165–169 行注释）：组件解析类消费方（blockRenderers/codeBlockRenderers）经 `getPluginComponent` **同步**解析，首 bump 时槽清单已含新插件但模块未注册，解析落空；模块注册完再不 bump，解析结果永久停在兜底态。所以热加载要「先 bump 拉清单 → 等模块注册完 → 再 bump 触发重解析」。

### 5.3 解析：`resolveCodeBlockRenderer` / `resolveCodeBlockRendererComponent`

- `resolveCodeBlockRenderer(items, language)`（第 37–46 行）：`language.toLowerCase()` 转小写，`matched = items.filter(i => (i.languages ?? []).some(l => l.toLowerCase() === lower))` 精确命中，再 `pickBest(matched)`。
- `resolveCodeBlockRendererByExtension(items, extension)`（第 50–59 行）：同规则但比 `fileExtensions`，**markdown 不用它**，file-preview 用（§6.4）。
- `pickBest(matched)`（第 61–66 行）：`reduce` 从 `undefined` 起步，`(cur.order ?? 100) <= (best?.order ?? 100) ? cur : best`——**`<=` 保证同 order 后者胜**，而 items 数组按 source 升序（builtin → installed → user → project）注册，同 order 下「后注册者 = 高优先级 source」。注释第 35–36 行写明「第三方可单语言覆盖内置」。
- `resolveCodeBlockRendererComponent(item)`（第 70–74 行）：`asReactComponent(getPluginComponent(item.pluginId, item.component))`，类型断言成 `ComponentType<{ code: string; streaming?: boolean }>`，拿不到组件视为无此候选，消费方落兜底。
- 与 blockRenderers 的解析规则对比：blockRenderers 有「特化层（names 命中）优先于通用层（无 names）」的两层结构（`resolveBlockRenderer` 第 39–54 行），codeBlockRenderers **没有** names 概念、只有单层 order 竞争——因为围栏语言本身就是键，`languages` 数组即「名字」，精确匹配已经完成分层，不需要再叠一层通用/特化。

## 6 与其他插件交互

### 6.1 与 timeline：blockRenderers 槽的 text 消费关系

- markdown 是**贡献方**，timeline 是**消费方**，双方互不认识，只靠 `blockRenderers` 槽契约 + text 块 props 契约通话。整条链路：
  - **分解**（`src/plugins/sessions/timeline/renderer/blocks.ts` 第 42–49 行）：`decomposeMessage` 的 assistant 分支用 `messageContentText(message.content)` 提取正文文本，非空则 push 一个 `{ type: "text", text }` 块。`messageContentText` 的唯一实现是 `packages/shared/src/domain/text.ts`（数组 content 只拼 `type === "text"` 的块），timeline 不各写一份本地版——契约单源。
  - **分派**（`src/plugins/sessions/timeline/renderer/block-renderer.tsx` 第 20–24 行）：`BlockRenderer` 里 `name` 对 text 块是 `undefined`（第 21 行只有 toolCall/divider/auxBlock 三种取 name），`resolveBlockRenderer(items, "text", undefined)` → `resolveBlockRendererComponent(item)` 解析出 `MarkdownText`。
  - **渲染**（第 35–36 行）：`case "text": return <Comp text={block.text} streaming={pending} />`——`pending = message.pending === true`（第 26 行，**不读全局 streaming**，流式语义按消息自持，这是根因修复）。
  - 所以 timeline 拿到的就是 markdown 贡献的 `MarkdownText`，props 恰好 `{ text, streaming }`，与 markdown 组件签名严丝合缝。
- **markdown 缺席时**：timeline 的 `BlockRenderer` 里 `resolveBlockRendererComponent` 拿不到组件，落 `PlainBlockFallback`（第 51–62 行），text 块显 `whitespace-pre-wrap break-words` 的纯文本原文——「不崩、可读、可滚，不试图画得还行」。这是 markdown 和 message-blocks 的关键差异：timeline 的 `dependsOn` 是 `["pi-manager", "message-blocks", "stickers", "goal"]`（`timeline/plugin.json` 第 12–17 行），**不含 markdown**；markdown 也不是 `protected`。所以停用/移除 markdown 是合法的、会被放行的，代价是会话流文本退化为纯文本，而停用 message-blocks 会被 dependsOn 拦下（§8）。

### 6.2 与 mermaid/puml/graphviz：codeBlockRenderers 槽的消费关系

- 角色反转：这里 markdown 是**消费方**，mermaid/puml/graphviz 三个插件是**贡献方**，双方互不认识，只靠 `codeBlockRenderers` 槽 + `{ code, streaming }` props 契约通话。markdown 的 `CodeBlock` 按语言名分发，贡献方按语言名认领：
  - **mermaid**（`src/plugins/sessions/mermaid/plugin.json`）：`{ id:"mermaid", languages:["mermaid"], fileExtensions:["mmd","mermaid"], component:"MermaidCodeBlock" }`。组件 `MermaidCodeBlock`（`renderer/index.tsx` 第 27–67 行）动态 `import("mermaid")`（500KB+ 不进首屏），`mermaid.initialize({ startOnLoad:false, theme: isDarkMode() ? "dark" : "default", securityLevel:"strict" })`，`isDarkMode()`（第 8–14 行）读 `getComputedStyle(document.body).backgroundColor` 算亮度判明暗、跟 app 主题走，`mermaid.render(...)` 出 SVG 后 `dangerouslySetInnerHTML` 注入（strict 模式已消毒）。
  - **puml**（`src/plugins/sessions/puml/plugin.json`）：`{ id:"puml", languages:["puml","plantuml"], fileExtensions:["puml","plantuml","iuml"], component:"PumlCodeBlock" }`。组件 `PumlCodeBlock`（`renderer/index.tsx` 第 19–48 行）用 `plantuml-encoder.encode(code)` 编码源码 → 拼 `https://www.plantuml.com/plantuml/svg/<encoded>` → `<img>` 远程渲染（不引本地 JAR/WASM），`onError` 置 `error` 落 `SourceFallback`。
  - **graphviz**（`src/plugins/sessions/graphviz/plugin.json`）：`{ id:"graphviz", languages:["dot","graphviz","gv"], fileExtensions:["dot","gv"], component:"GraphvizCodeBlock" }`。组件 `GraphvizCodeBlock`（`renderer/index.tsx` 第 25–61 行）动态 `import("@viz-js/viz")`（~1.1MB WASM 单文件不进首屏），`getViz()` 单例（`vizPromise ??=` 只实例化一次），`viz.renderString(code, { format:"svg" })`，容器 `bg-white` 兜透明底黑线在暗色主题下可读。
- **分发契约的四个对齐点**，缺一个都会断：
  - 语言名对齐：markdown 抠出的 `lang`（`mermaid`/`puml`/`plantuml`/`dot`/`graphviz`/`gv`）必须精确命中三个插件 `languages` 数组里的项，`resolveCodeBlockRenderer` 小写比较保证 `Mermaid`/`MERMAID` 这类大小写变体也能命中；
  - props 对齐：三个组件签名都是 `{ code, streaming = false }`，markdown 传 `{ code: text, streaming }`——`code` 是 `rawText` 剥出的纯源码，`streaming` 是透传自 timeline 的 `pending`；
  - 流式对齐：三个组件 `useEffect` 里 `if (streaming) return` 提前退出，`streaming || failed` 时渲染 `SourceFallback`（源码 `<pre>`），所以**流式期间围栏块显示源码、流式结束才成图**——这正是 markdown-body.tsx 第 74 行注释「流式标记传给图块(流式期间不渲染,结束后成图)」的含义；
  - 降级对齐：贡献方组件内部各有一个 `SourceFallback`，解析失败/流式中自降级为源码，markdown **不感知**——markdown 只兜「查不到渲染器」这层，渲染器自身的失败由渲染器兜。
- **markdown 不声明 `dependsOn` 依赖这三个插件**：因为它消费的是槽、不是 channel。CLAUDE.md §8.2 的 dependsOn 要求针对「消费别人的 channel（on 或 invoke）」，槽消费是「查 registry + 查组件」，槽中无贡献项时 markdown 的 `CbrComp ? ... : <pre>` 兜底天然接管，不存在「订阅失败抛错」的问题。所以 mermaid/puml/graphviz 任一缺席，```mermaid 这类围栏块只是退回高亮源码，markdown 与三个插件之间零生命周期耦合。

### 6.3 与 message-blocks：text 块的迁出关系

- markdown 是从 message-blocks 里**迁出**的。`message-blocks/renderer/index.tsx` 第 4 行注释「文本块渲染(MarkdownText)已迁出为独立 markdown 插件——本插件只管工具卡/思考链/气泡/分隔线」，message-blocks 的 `plugin.json` 贡献清单里**没有** text 项。
- 所以「五种内置块词汇」的认领是**分散**的：message-blocks 认领 thinking/toolCall/userText/divider（+ userIntent 开放扩展），markdown 认领 text。契约词汇是五种，但渲染器分布两个插件——读覆盖类文档时要分清「契约词汇有 text」和「text 的渲染器在 markdown 插件」两件事（`docs/plugins/sessions/message-blocks.md` §4.3 同款表述）。
- 两个插件之间没有依赖关系，都是独立的 `official` 内置件，只是 message-blocks 额外有 `protected: true`、且被 timeline `dependsOn` 点名，markdown 两者皆无（§6.1）。

### 6.4 与 file-preview：同一 codeBlockRenderers 槽的第二消费方（`fileExtensions`）

- codeBlockRenderers 槽有**两个消费方**，markdown 只是其一：
  - markdown 用 `resolveCodeBlockRenderer`（按 `languages`），消费场景是「会话流文本块里的围栏代码块」；
  - file-preview 用 `resolveCodeBlockRendererByExtension`（按 `fileExtensions`），消费场景是「文件预览里 `.mmd`/`.dot`/`.puml` 这类图文件的路由」。
- `src/plugins/project/file-preview/renderer/index.tsx` 第 101–110 行：`resolveCodeBlockRendererByExtension(codeBlockRenderers, getExtension(path))` 查出 `diagramItem` → `resolveCodeBlockRendererComponent(diagramItem)` 得 `DiagramComp` → `richRoute = route === "text" && diagramItem ? "diagram" : route`，第 290–299 行 `<DiagramComp code={content} streaming={false} />`。
- **markdown 还间接被 file-preview 复用**：file-preview 第 97–100 行 `resolveBlockRenderer(blockRenderers, "text")` 解析出 `MarkdownComp`（即 markdown 的 `MarkdownText`），第 277–288 行 `effectiveRoute === "markdown" && MarkdownComp` 时 `<MarkdownComp text={content} streaming={false} />` 渲染 `.md` 文件。所以 markdown 的 `MarkdownText` 是**两个消费方共享**的通用 Markdown 渲染器——timeline 用流式路径（`streaming={pending}`），file-preview 用非流式路径（`streaming={false}`），`streaming` 默认值 `false` 让后者可以省略这个 prop。
- 这里「映射知识归贡献方」是槽设计的核心（对照 `CodeBlockRendererContribution` 第 312–314 行注释）：新增一种图语言，只需图插件在自己 manifest 的 `fileExtensions` 里加扩展名，file-preview 和 markdown 一行不改——markdown 靠 `languages`、file-preview 靠 `fileExtensions`，两条查询路径共享同一个 `ArraySlot`，贡献方只声明一次。

## 7 i18n：两个命名空间、四语言

- `locales/` 下每语言两个文件，命名空间按「key 的消费者」划分：
  - `shell.json`：`CodeBlock` 卡片头部复制按钮的两个 key `shell.copy`（复制）/ `shell.copied`（已复制）。消费者是 markdown-body.tsx 的 `CodeBlock`，所以 key 在 markdown 自己的 locales。
  - `plugin.json`：`plugin.markdown.displayName` / `plugin.markdown.description`。这是插件管理器里显示名和描述，值随语言变（如 de 是「Markdown-Renderer」、zh-TW 是「Markdown 渲染」、description 里 zh-CN 写「…图围栏分发」）。
- 四语言 zh-CN / zh-TW / en / de 各两份，共 8 条 `languages` 贡献项，`id` 是 `markdown.shell` / `markdown.plugin`，`resources` 指向相对路径 JSON。
- 组件里所有用户可见文案都走 `t("key")` 查 i18next（`useTranslation` 在 `CodeBlock` 内），没有一个写死的中文/英文——token key 是契约、值是内容，值外挂（CLAUDE.md §1.2）。

## 8 无特权差异、覆盖语义与降级路径

- markdown 与任何第三方文本块渲染插件走同一条加载器、同一套契约、同一套权限，没有任何「识别内置件并特殊对待」的代码路径。
- 覆盖 text 块渲染器：第三方想整体换掉 Markdown 渲染，在 `~/.my-harness-desktop/plugins/<插件名>/` 或 `<cwd>/.my-harness-desktop/plugins/<插件名>/` 里贡献 `{ id:"my-text", block:"text", component:"MyText" }`（不带 names），高优先级 source 胜出即整类型替换——timeline 零改动、markdown 零改动、不等发版。text 块没有 `names`，所以没有「部分覆盖」语义（对照 message-blocks.md §9 同款表述），整换就是正确粒度。
- 两条覆盖路径（`ArraySlot.removeById` 的注册期语义 vs `resolveBlockRenderer` 的查询期语义）：**新 id 共存**是零售，只赢自己声明的通用项，markdown 的贡献继续存在；**同 id（`text`）替换**是批发，`removeById` 整项顶替，markdown 将来对这条贡献的更新与你无关。默认选新 id。
- codeBlockRenderers 侧的覆盖同理：第三方想覆盖 ```mermaid 的渲染，贡献 `{ id:"my-mermaid", languages:["mermaid"], component:"MyMermaid" }`，`resolveCodeBlockRenderer` 按 order 小者胜、同 order 高优先级 source 胜。mermaid/puml/graphviz 的三条贡献都没有写死 `order`（缺省 100），所以第三方默认同 order 即胜出（高优先级 source 后注册）。
- **markdown 的降级路径有且只有一条**：`CbrComp` 不存在时落高亮 `<pre>`。它不兜「渲染器渲染失败」——那是贡献方组件内部 `SourceFallback` 的职责。markdown 也不兜「text 块渲染器缺失」——那是 timeline 的 `PlainBlockFallback` 职责。三层兜底各管一层，层层隔离，这是无特权差异「删掉内置件系统照常启动」的三重兑现：删 mermaid → 围栏退回高亮源码；删 markdown → text 块退回纯文本；删 message-blocks → 全块退回纯文本。

## 9 QA

**Q：markdown 明明叫「Markdown 渲染」，为什么它自己不画 mermaid/puml/graphviz，反而转交给别的插件？**

因为「Markdown 渲染」和「图渲染」是两个正交的能力。markdown 的职责边界是 GFM 文本 + 代码块卡 + 围栏语言分发，它不认识也不该认识任何具体图语言——`markdown-body.tsx` 第 41–42 行注释写死「markdown 不认识任何具体语言」。图渲染是 mermaid/puml/graphviz 各自的内容，markdown 只按语言名查 `codeBlockRenderers` 槽，查到就甩 `{code, streaming}`、查不到就落高亮 `<pre>`。这是 CLAUDE.md §3.1「消费而非翻译」的兑现：markdown 是主动消费方，不把自己做成三种图语言的翻译层。

**Q：`resolveCodeBlockRenderer` 和 `resolveBlockRenderer` 都是查槽，为什么前者没有「特化层/通用层」的两层结构？**

因为键的形态不同。`resolveBlockRenderer` 的输入是 `(block, name?)`，`name` 只在 toolCall/divider 有意义，所以需要「names 精确命中的特化层」压过「无 names 的通用层」，否则 DefaultCard 会吞掉精确认领的工具卡。`resolveCodeBlockRenderer` 的输入只有一个 `language`，`languages` 数组本身就是键，精确匹配已经天然完成分层——`["bash"]` 和 `["mermaid"]` 互不干扰，不存在「兜底项吞精确认领」的问题，所以只需单层 order 竞争（`pickBest` 的 `<=` 同 order 后者胜）。

**Q：markdown 不声明 `dependsOn` 依赖 mermaid/puml/graphviz，停用后者会不会让 markdown 报错？**

不会。dependsOn（CLAUDE.md §8.2）约束的是「消费别人的 channel（on 或 invoke）」——订阅失败会抛错，所以需要生命周期护栏。markdown 消费的是 `codeBlockRenderers` 槽，不是 channel：`useCodeBlockRenderers()` 查 registry、`resolveCodeBlockRendererComponent` 查组件，查不到组件时 `CbrComp ? ... : <pre>` 兜底天然接管，没有「订阅失败抛错」的问题。停用 mermaid 的后果只是 ```mermaid 退回高亮源码，markdown 自身零感知、零耦合。

**Q：停用 markdown 和停用 message-blocks，会话流的降级行为一样吗？**

不一样，降级门槛不同。停用 message-blocks 会被 timeline 的 `dependsOn: ["message-blocks"]`（`timeline/plugin.json` 第 12–17 行）拦下，message-blocks 自己还 `protected: true`，正常运维根本停不掉，只有物理移出才走到 `PlainBlockFallback`。停用 markdown 则完全放行——timeline 的 dependsOn 不含 markdown，markdown 也不是 protected——后果是 text 块退回 `PlainBlockFallback` 的纯文本原文，但思考链/工具卡/气泡/分隔线照常。这是「text 渲染器」和「全块渲染器」的不同保护级别：前者可换、后者是会话流裸奔的底线。

**Q：`/language-(\w+)/` 这个正则有什么坑？影响 markdown 分发吗？**

`\w+` 只匹配 `[A-Za-z0-9_]`，带符号的语言名会被截断：`c++` → `c`、`c#` → `c`、`objective-c` → `objective`。对 markdown 当前分发的四种语言（mermaid / puml / plantuml / dot / graphviz / gv）全是纯单词，不影响。但如果将来有插件贡献一个 `["c++"]` 的 codeBlockRenderer，```c++ 围栏块会被截成 `c` 导致查不到。这是正则的固有截断，写新代码不能假设 `lang` 是完整语言名。

**Q：markdown 的代码高亮主题为什么是写死的 github-dark，不跟主题走？**

因为 `markdown-body.tsx` 第 7 行 `import "highlight.js/styles/github-dark.css"` 是静态 CSS 引入，highlight.js 的主题是编译期打包的全局样式，不是运行时 token。这是插件内部的内容选择（合法内容，对照 timeline-block-renderers.md §4.1「写死一张表在内容插件里是合法内容」），代价是恒 github-dark、不随 app 明暗切换。对比 mermaid 的 `isDarkMode()`（读 `document.body` 背景亮度判明暗）是运行时跟随主题的。若要让高亮跟主题走，需要把 highlight.js 主题换成 CSS 变量驱动，这是演进项不是 bug。

**Q：`stream-utils.tsx` 里的 `StreamingCaret` 和 `useDebouncedValue` 为什么和 message-blocks 的 `stream-text-reveal.tsx` 一模一样？**

这是 markdown 从 message-blocks 迁出时的**已知重复**：`stream-text-reveal.tsx` 第 19–36、87–96 行的两个件被逐字节拷到 markdown 的 `stream-utils.tsx`，两处是平行实现、互不 import。根因是迁出时为了「markdown 插件自持内聚」没有把这两个流式件上提到共享层（`packages/react`）。严格看这违反「同一逻辑多处各写」的反模式，正确的收敛方向是把 `StreamingCaret`/`useDebouncedValue` 上提到 `packages/react`，message-blocks 和 markdown 各自 import——但当前仓库里它们是两份拷贝，写新代码不要再复制第三份。

**Q：file-preview 和 markdown 都在用 markdown 的 `MarkdownText`，它们有什么区别？**

是同一组件、不同 props。timeline 走流式路径：`<Comp text={block.text} streaming={pending} />`（`block-renderer.tsx` 第 36 行），`pending = message.pending`，所以流式中有 50ms 防抖 + `StreamingCaret`。file-preview 走非流式路径：`<MarkdownComp text={content} streaming={false} />`（`file-preview/renderer/index.tsx` 第 283 行），因为文件预览是一次性读全文、没有流式，`streaming={false}` 直接渲染原文、不防抖不加光标。这是 `streaming` 默认值 `false` 让 markdown 能被非流式消费方复用——`MarkdownText` 本质是一个通用 Markdown 渲染器，流式只是它的一种模式。
