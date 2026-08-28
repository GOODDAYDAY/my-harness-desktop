# mermaid

## 1 定位与职责

- mermaid 是 `codeBlockRenderers` 槽的一个贡献方：它把会话流里 ` ```mermaid ` 围栏代码块渲染成图。它的 `plugin.json` 只声明一条贡献——`{ "id": "mermaid", "languages": ["mermaid"], "fileExtensions": ["mmd", "mermaid"], "component": "MermaidCodeBlock" }`，没有任何 `order` 字段（缺省 100）。它是四个图插件里结构最薄的一个：`locales/`（四个 locale 的 `plugin.json`）+ `renderer/index.tsx`（68 行）+ `plugin.json`，没有 `core/`、没有 `client/`、没有 `pi-extension/`、没有 `dsh-extension/`。

- 它做的只有一件事：收到契约 props `{ code: string; streaming?: boolean }`，动态 import mermaid 库渲染成 SVG，把 SVG 注入 DOM。渲染失败或流式未闭合时自降级为源码呈现，消费方（markdown 插件、file-preview 插件）完全不感知失败细节。`renderer/index.tsx` 顶部注释写死「解析失败/流式未闭合时组件内部自降级为源码呈现,消费方不感知」。

- 它是纯壳插件：不 import `src/server/`、`src/web/`、`src/core/` 的任何实现，只 import `react` 和 `mermaid`（第三方库），无任何内核身份分支、无任何写死的用户可见文案、无任何写死的颜色值（主题明暗通过 `isDarkMode()` 运行时读 body 背景亮度判定，不硬编码）。`dangerouslySetInnerHTML` 注入的是 mermaid `securityLevel: "strict"` 模式下的消毒输出。

- 它在「文本块内部的围栏语言」这一层与 `blockRenderers` 槽分工：`blockRenderers` 管「整块类型」（`text`/`toolCall`/`thinking`…，见 `packages/shared/src/domain/contributions.ts` 的 `BlockRendererContribution`），`codeBlockRenderers` 管「文本块内部的一段围栏代码」——mermaid 只是这一层的众多语言之一。这条分工在 `contributions.ts` 第 302-305 行注释里写死，是 mermaid 这类插件存在的契约依据。

- 它的内核无关性由「围栏语言」这个中性钥匙保证：mermaid 不认识 pi 也不认识 dsh，它只认「language 字符串命中 `mermaid`」。无论内核是 pi 还是 dsh，只要吐出的中性文本里带 ` ```mermaid ` 围栏，markdown 插件都会按同一把钥匙把代码派给它。渲染是纯函数——同一段 mermaid 源码在任何内核下画的图一样。

## 2 目录结构

- `plugin.json`：唯一声明面。`renderer` 指向 `./renderer/index.tsx`，`contributes` 声明 `codeBlockRenderers`（一条）+ `languages`（4 locale × `mermaid.plugin` 命名空间）两槽，无 `permissions`、无 `dependsOn`、无 `protected`。它不需要任何声明能力——mermaid 库由壳打包进 renderer bundle，不经 IPC 也不经事件总线。

- `renderer/index.tsx`：全部渲染逻辑，一个文件三样东西——`isDarkMode()` 主题判定纯函数、`SourceFallback` 降级组件、`MermaidCodeBlock` 主组件（manifest 的 `component` 名指向它）。无测试文件。

- `locales/`：`de`/`en`/`zh-CN`/`zh-TW` 四个 locale，每个含一个 `plugin.json`，只有两个 key——`plugin.mermaid.displayName` 与 `plugin.mermaid.description`。这两个 key 是插件管理器列表页（`PluginListItem.displayName`/`description`）的文案来源，对应 `plugin.json` 里 `languages` 槽的 4 条贡献。

- 依赖声明在根 `package.json` 而非插件目录：`mermaid: "^11.16.1"` 与 `@viz-js/viz`、`plantuml-encoder` 并列。这意味着 mermaid 库是壳主包的一部分，插件只是 import 它——插件自己不带 `package.json`，不声明自己的依赖，依赖由壳统一打包。这也是为什么 mermaid 能做动态 import：`await import("mermaid")` 把 500KB+ 的库拆到独立 chunk，不进首屏。

## 3 plugin.json 逐字段：围栏语言契约

- `id: "mermaid"`、`version: "0.4.9"`、`tier: "official"`、`displayName: "Mermaid 图"`、`description: "会话流 mermaid 围栏代码块渲染成图(本地渲染,动态加载)"`：与兄弟插件 puml/graphviz 同版本号、同 tier。`description` 里的「本地渲染」与「动态加载」两个词精确对应实现——`mermaid.render()` 在浏览器本地跑（不经服务器），`await import("mermaid")` 延迟到真遇到图才加载。

- `tags: ["conversation"]`：会话域标签。`contributes.codeBlockRenderers` 是「无语义槽」（`derivePluginTags` 只推导 `themes`→`theme`、`languages`→`i18n`、`settings`→`management`），所以 `conversation` 是显式声明而非框架推导。

- `contributes.codeBlockRenderers[0]` 逐字段，对应圆心契约 `CodeBlockRendererContribution`（`packages/shared/src/domain/contributions.ts` 第 307-320 行）：

  - `id: "mermaid"`：贡献 id，插件内唯一。契约注释写「同 id 被后注册插件整项替换」——registry 的 `removeById` 通用语义，第三方插件若声明同 id 的 codeBlockRenderers 项（高优先级 source）会整项替换内置这条，而非按语言合并。

  - `languages: ["mermaid"]`：围栏语言名清单，这是**围栏语言契约的唯一真源**。消费方（markdown 的 `resolveCodeBlockRenderer`）按 `language.toLowerCase()` 与清单里每一项 `l.toLowerCase()` 严格相等来命中。mermaid 只认一个语言 `mermaid`——` ```mermaid ` 命中，` ```mmd ` 不命中（mmd 是文件扩展名，不是围栏语言）。

  - `fileExtensions: ["mmd", "mermaid"]`：可被本渲染器预览的文件扩展名清单（小写比较、不带点）。契约注释写「命中即图路由;不声明则该语言不参与文件预览」。消费方是 file-preview 的 `resolveCodeBlockRendererByExtension`。`.mmd` 和 `.mermaid` 文件在文件预览里命中此条，升级为 diagram 富路由。

  - `component: "MermaidCodeBlock"`：renderer 侧组件名，框架从插件 module 的 exports 里按名自动匹配（§7.4 自动匹配）。`renderer/index.tsx` 具名 export 了 `MermaidCodeBlock`，两者一致；若改名而 manifest 不跟，组件静默不渲（消费方落普通高亮代码体）。

  - 无 `order`：缺省 100。当前只有一个 mermaid 贡献方，order 无实际作用；若将来第三方插件也贡献 `languages: ["mermaid"]`，按 `pickBest` 的 `order 小者胜、同 order 取数组后者`（`packages/react/src/code-block-renderers.ts` 第 61-66 行）决胜，第三方可单语言覆盖内置。

- `contributes.languages`：4 条 `LanguageContribution`（`contributions.ts` 第 130-137 行），id 都是 `mermaid.plugin`，locale 分别是 `zh-CN`/`zh-TW`/`en`/`de`，resources 指向各 locale 的 `plugin.json`。这是「插件元信息文案」的语言包——i18n 框架合并后，插件管理器按当前语言查 `plugin.mermaid.displayName`。围栏渲染本身零文案，所以 mermaid 的语言包只有元信息两条 key，没有渲染期文案。

## 4 圆心契约与槽分发机制

- 圆心 `CodeBlockRendererContribution` 是 mermaid 这类插件的「存在许可证」。它定义了四个字段（`id`/`languages`/`component`/`order?` 外加 `fileExtensions?`）和一个 props 契约 `{ code: string; streaming?: boolean }`。mermaid 的 `MermaidCodeBlock` 函数签名 `({ code, streaming = false }: { code: string; streaming?: boolean })` 与这个 props 契约逐字对齐——不是巧合，是契约单源的体现：组件 props 形状由圆心定，组件实现由插件定。

- 槽分发机制在 `packages/react/src/code-block-renderers.ts`，三段式（镜像 `block-renderers.ts`）：① 贡献方在 `plugin.json` 写 `contributes.codeBlockRenderers`（声明）；② 消费方经 `useCodeBlockRenderers()` 查槽（`pluginsNonce` 失效重拉，同 nonce 单发，见 `code-block-renderers.ts` 第 19-33 行）；③ `resolveCodeBlockRenderer` 按语言定贡献项、`resolveCodeBlockRendererComponent` 匹配插件 exports。

- `useCodeBlockRenderers()` 返回 `CodeBlockRendererItem[]`（`CodeBlockRendererContribution & { pluginId }`）。它从 `window.kernel.slots.codeBlockRenderers()` 拉取全部贡献，带模块级 `cache` 缓存（`{ nonce, data }`），`pluginsNonce` 变化才重拉。mermaid 的贡献项就是这条数组里 `pluginId === "mermaid"` 的那一条。

- `resolveCodeBlockRenderer(items, "mermaid")` 的命中逻辑（`code-block-renderers.ts` 第 37-46 行）：把入参 `language.toLowerCase()`，filter 出 `i.languages` 里有一项 `l.toLowerCase() === lower` 的项，交给 `pickBest`。`pickBest` 用 `reduce` 实现「order 小者胜、同 order 取数组后者」——`(cur.order ?? 100) <= (best?.order ?? 100) ? cur : best`，`<=` 保证同 order 时后者覆盖前者。items 保注册序（`builtin→installed→user→project`），所以「数组后者」就是「高优先级 source」。

- `resolveCodeBlockRendererComponent(item)`（`code-block-renderers.ts` 第 70-74 行）：`asReactComponent(getPluginComponent(item.pluginId, item.component))`，把贡献项投影成 `ComponentType<{ code: string; streaming?: boolean }>`。`getPluginComponent` 读插件 renderer module 的 exports 按名取组件，拿不到返回 undefined，消费方落兜底。

- mermaid 在这个机制里的角色是纯「内容」：它不认识 `useCodeBlockRenderers`、不认识任何消费方，只 export 一个符合 props 契约的组件。它被谁查、被谁渲、优先级怎么定，全是框架机制的事。这正是「机制与内容分离」在代码块渲染这一层的落地——加一个新图语言 = 加一个这样的插件，槽机制一行不动。

## 5 渲染器实现（renderer/index.tsx 逐函数）

- `let mermaidCounter = 0;`（模块级，第 5 行）：SVG 容器 id 的递增计数器。mermaid 的 `render(id, code)` 要求每个 id 在 DOM 里唯一，计数器保证多次渲染（多条消息里多个 mermaid 块、同一块 code 变化重渲）的 id 不撞车。计数器是模块级而非组件级 state，因为 id 只需全局唯一、不需要触发重渲染。

- `isDarkMode(): boolean`（第 8-14 行）：读 `getComputedStyle(document.body).backgroundColor`，用正则 `/rgba?\((\d+),\s*(\d+),\s*(\d+)/` 抓 RGB 三元组，按感知亮度公式 `(0.2126*R + 0.7152*G + 0.0722*B) / 255` 算亮度，`< 0.5` 判为暗色。为什么这样写：mermaid 的主题是渲染期全局配置（`mermaid.initialize({ theme })`），不是 CSS 变量，它不吃 `var(--color-bg)`，只能传 `"dark"`/`"default"` 字符串。而 mermaid 不能依赖 app 主题状态（它不认识 `useTheme`），所以反过来运行时读 body 实际背景亮度判定明暗，跟 app 主题明暗走。这是「零硬编码颜色值」纪律下的一个务实解法：颜色不写死，从 DOM 运行时读。

- `SourceFallback({ code })`（第 16-22 行）：一个 `<pre>`，类名 `p-3 overflow-x-auto text-[length:var(--font-size-base)] leading-6 font-[var(--font-family-mono)] !bg-transparent`。它是 mermaid 的降级出口，样式与 markdown 插件的普通代码体 `<pre>`（`markdown-body.tsx` 第 64 行）同构——都走主题 token（`--font-size-base`/`--font-family-mono`）、透明背景，视觉上「图渲染失败就退化成和普通代码块一样」。

- `MermaidCodeBlock`（第 27-68 行）主体，状态机三态：`svg: string | null`（渲染结果）、`failed: boolean`（失败标记），加 props 里的 `streaming`。渲染分支顺序：

  - `if (streaming || failed) return <SourceFallback code={code} />`：流式期间（围栏未闭合，mermaid 语法必不完整）与解析失败都降级源码。这是「组件内部自降级」的具体兑现——消费方（markdown 的 `CodeBlock`）只判断「有没有 CbrComp」，不判断「渲染成没成」。

  - `if (!svg)`：渲染中态，返回一个 spinner（`<span className="size-4 rounded-full border-2 border-[var(--color-muted)] border-t-transparent animate-spin" />`），背景色、边框色全走 token。

  - 有 svg：`<div className="overflow-x-auto p-3 flex justify-center" dangerouslySetInnerHTML={{ __html: svg }} />`，横向可滚、居中。

- useEffect 内的异步渲染序列（第 31-51 行），关键细节：

  - `if (streaming) return;`：流式期间直接跳过 effect 主体，不 import 库、不渲染。这是性能与正确性双赢——流式时每一 token 都触发 code 变化，若不跳过，mermaid 会对每个半成品语法反复 import + render 抛错。

  - `let alive = true;` + cleanup `return () => { alive = false; }`：防竞态。`code` 快速变化时，旧 effect 的 async 完成回调在组件已进入新 effect 后仍可能触发，`alive` 守卫确保过期结果不 `setSvg`。这是 useEffect 异步清理的标准范式，也是「每个 fix 标注根因」的体现——alive 标志就是专门防「旧闭包 setState 覆盖新状态」这个根因。

  - `await import("mermaid")`：动态 import，把 500KB+ 的 mermaid 拆出首屏。真遇到 mermaid 围栏才拉 chunk，普通会话（无图）永不加载这个库。

  - `mermaid.initialize({ startOnLoad: false, theme: isDarkMode() ? "dark" : "default", securityLevel: "strict" })`：`startOnLoad: false` 不让 mermaid 自动扫 DOM；`theme` 按明暗选；`securityLevel: "strict"` 是安全关键——strict 模式下 mermaid 会对节点标签做 HTML 消毒，`dangerouslySetInnerHTML` 注入的 SVG 不含可执行脚本，mermaid 官方推荐的 CSP 兼容级别。

  - `mermaid.render(\`mermaid-diagram-${++mermaidCounter}\`, code)`：渲染并返回 `{ svg }`。id 用计数器保证唯一；code 是围栏内的源码原文。

  - `catch { if (alive) setFailed(true); }`：任何 mermaid 抛错（语法错误、不支持的类型）都吞掉，置 failed 降级源码。不把错误抛给消费方。

- 主题的暗色判定在每次 `code`/`streaming` 变化时重跑（effect 依赖 `[code, streaming]`），但 `isDarkMode()` 不参与依赖数组——它读的是 DOM 实况，不是 React state，改主题时 mermaid 不会因 theme 变化自动重渲（除非 code 也变）。这是已知的轻微不一致：切换明暗主题后，已渲染的 mermaid 图不重画，直到该块 code 再次变化。它是「mermaid 主题是全局初始化、非响应式」这个库特性的直接后果，不是 bug 而是降级接受。

## 6 与 markdown 插件（消费方）的交互

- markdown 插件是 mermaid 的**唯一会话流消费方**。调用链：`markdown-body.tsx` 的 `MarkdownBody` 调 `useCodeBlockRenderers()` 拿到全部贡献项（含 mermaid 那条），把 `codeBlockItems` 传给 `CodeBlock`；`ReactMarkdown` 的 `components.pre` 覆盖把每个 `<pre>` 交给 `CodeBlock`。

- `CodeBlock`（`markdown-body.tsx` 第 23-70 行）的围栏语言提取：`const className = codeEl?.props?.className ?? ""; const lang = /language-(\w+)/.exec(className)?.[1] ?? "";`。这是 mermaid 命中与否的第一道门——`rehype-highlight` 给围栏代码块生成的 `<code>` 元素带 `language-<lang>` className，正则从中抠出语言名。` ```mermaid ` 产出 `language-mermaid`，`lang` 得 `mermaid`。

- 分发：`const cbrItem = lang ? resolveCodeBlockRenderer(codeBlockItems, lang) : undefined; const CbrComp = cbrItem ? resolveCodeBlockRendererComponent(cbrItem) : undefined;`。`lang === "mermaid"` 命中 mermaid 那条贡献，`CbrComp` 就是 `MermaidCodeBlock`。`lang` 为空（无语言围栏）时不查槽，直接落普通代码体。

- 渲染：`CbrComp ? <CbrComp code={text} streaming={streaming} /> : <pre>{children}</pre>`。`text = rawText(codeEl?.props?.children)`——把 ReactNode 递归压平成纯字符串（`rawText` 函数第 15-21 行），mermaid 拿到的 `code` 是围栏内源码的纯文本，不含任何 React 元素。`streaming` 从 `MarkdownBody` 透传到 `CodeBlock` 再透传到 `CbrComp`，是 mermaid 判断「流式未闭合」的依据。

- 「markdown 不认识任何具体语言」这条边界在 `markdown-body.tsx` 第 42 行注释写死：markdown 只知道「围栏语言命中槽就派给渲染器、不命中就高亮」，它不认识 mermaid/puml/dot 任何一个。所以 mermaid 与 markdown 是「槽贡献方 ↔ 槽消费方」的纯解耦关系——markdown 删了 mermaid 照常跑（只是 mermaid 块退化高亮代码体），mermaid 删了 markdown 也不影响（只是没人消费它）。

- 槽中无渲染器时（mermaid 插件被禁用）的回落：`CodeBlock` 走 `else` 分支渲染 `<pre>`，此时围栏代码块由 `rehype-highlight` 按 `language-mermaid` 高亮为普通代码体。注意 `markdown-body.tsx` 还 import 了 `highlight.js/styles/github-dark.css`——高亮样式是写死的 github-dark，与 mermaid 的运行时明暗判定是两套机制，mermaid 块被禁用时的高亮体不跟随 app 主题（这是一个「内容泄漏」的小残留，但不属于 mermaid 的职责范围）。

- 流式语义的配合：markdown 的 `Markdown` 壳（`markdown.tsx`）对流式文本做 50ms 防抖攒批（`useDebouncedValue(text, 50)`），`MarkdownBody` 只在「文本自身防抖」与「图块流式标记」之间分工——注释（第 74 行）写「流式标记传给图块(流式期间不渲染,结束后成图);文本本身的防抖由 Markdown 壳负责」。所以 mermaid 收到的 `streaming` 是「这条消息还在流式」的总开关，而非「围栏是否闭合」的精确信号：整条消息流式期间，所有 mermaid 块都走源码降级，消息落定（`message.pending === false`）后才统一成图。这是「粗粒度流式闸门」——mermaid 不自己解析围栏闭合，只信任消费方给的 streaming 标记。

## 7 与 timeline（blockRenderers 上层）的交互

- timeline 是更上一层的块分派器，它不认识 mermaid。timeline 的 `BlockRenderer`（`src/plugins/sessions/timeline/renderer/block-renderer.tsx`）只查 `blockRenderers` 槽，按 `(block, name?)` 二键解析贡献组件；对 `text` 块，`resolveBlockRenderer(items, "text")` 命中 markdown 插件贡献的 `MarkdownText`（markdown 的 `plugin.json` 里 `contributes.blockRenderers: [{ id: "text", block: "text", component: "MarkdownText" }]`）。

- 调用链全景：`timeline` 的 `BlockRenderer` → `text` 块 → markdown 的 `Markdown`（`MarkdownText` re-export）→ `MarkdownBody` → `CodeBlock` → mermaid 的 `MermaidCodeBlock`。timeline 与 mermaid 之间隔着 markdown 插件这一整层，timeline 从头到尾不知道 mermaid 存在——它只知道「text 块派给 markdown」。

- timeline 传给 text 块的 props 是 `text` + `streaming`（`block-renderer.tsx` 第 35-36 行 `case "text": return <Comp text={block.text} streaming={pending} />`），`pending = message.pending === true`。这个 `streaming` 一路透传到 mermaid，是 mermaid 判断降级源码的最终来源。timeline 的 `pending` 语义是「消息流式中」，与围栏闭合无关，再次印证 mermaid 的流式闸门是粗粒度的。

- timeline 的 `PlainBlockFallback`（`block-renderer.tsx` 第 51-63 行）只兜 `blockRenderers` 槽解析失败（markdown 插件缺席）的极端路径，与 mermaid 无关。mermaid 的降级是「markdown 已成功接住、但 mermaid 自己渲染失败」这一层，两层兜底互不重叠：timeline 兜「text 块没人画」，markdown 兜「围栏语言没人认」，mermaid 兜「认了但画不出」。

- mermaid 与 timeline 的耦合点是「间接的、单向的、经槽的」：mermaid 不 `dependsOn` timeline，也不 `dependsOn` markdown（mermaid 的 `plugin.json` 无 `dependsOn` 字段）。这是符合纪律的——mermaid 是纯贡献方，它不消费任何人的 channel、不查任何人的槽，自然不需要声明依赖。反过来 markdown 也不 `dependsOn` mermaid（槽消费不是 channel 依赖，markdown 的 `plugin.json` 无 `dependsOn` 指向 mermaid），markdown 对 mermaid 缺席的处理是「回升高亮代码体」而非报错。

## 8 fileExtensions 文件预览映射（file-preview 消费方）

- mermaid 的第二个消费方是 file-preview 插件（`src/plugins/project/file-preview/renderer/index.tsx`），消费的是 `fileExtensions: ["mmd", "mermaid"]` 而非 `languages`。file-preview 不认识围栏语言，它按文件扩展名查槽：`resolveCodeBlockRendererByExtension(codeBlockRenderers, getExtension(path))`（`index.tsx` 第 102 行）。

- 触发条件：`route === "text"` 时才查槽。file-preview 的 `routeOf(path)`（第 47-54 行）先按扩展名分流 image/pdf/binary/markdown，剩下的落 `text`；`.mmd`/`.mermaid` 不在任何特殊集合里，所以落 `text` 路由，然后 `resolveCodeBlockRendererByExtension` 用 `getExtension(path)`（第 21-25 行，取 basename 最后一个点后的小写）去匹配 `fileExtensions`。

- 命中后升级路由：`richRoute = route === "text" && diagramItem ? "diagram" : route`（第 110 行），`diagramItem` 是 mermaid 那条贡献。`canRenderRich`（第 112 行）要求 `DiagramComp != null`。最终 `effectiveRoute === "diagram"` 时渲染 `<DiagramComp code={content} streaming={false} />`（第 290-298 行）——`content` 是 `ctx.fs.readFile(path)` 读出的文件全文，`streaming` 恒 false（文件预览无流式）。

- 文件预览与围栏渲染共用同一个组件、同一套降级：`.mmd` 文件内容若语法错误，`MermaidCodeBlock` 同样 `catch` 置 failed 走 `SourceFallback`。file-preview 还提供「看源码」切换（第 194-203 行，`viewMode` 在 `rendered`/`source` 之间切），`effectiveRoute` 在 `source` 时落 `text` 行号视图——所以即使用户想看 mermaid 源文件，也能切回带行号的纯文本。

- 「映射知识归贡献方」这条契约在此兑现：file-preview 的第 90-93 行注释写「图路由 = text 文件的扩展名命中 codeBlockRenderers 槽的 fileExtensions 声明——映射知识归贡献方(与 fileIcons 槽同构),新增图语言不动本插件」。mermaid 声明 `fileExtensions: ["mmd","mermaid"]`，就是把自己「能预览哪些扩展名」的知识放在自己 manifest 里，file-preview 不硬编码任何图语言的扩展名——加 graphviz 时 file-preview 一行不动，因为 graphviz 自己在 `plugin.json` 声明了 `["dot","gv"]`。

- 边界：`fileExtensions` 与 `languages` 是两个独立清单，互不推导。mermaid 的 `languages: ["mermaid"]` 管围栏语言，`fileExtensions: ["mmd","mermaid"]` 管文件预览，两者恰好都含 `mermaid` 但不是同一语义——`mmd` 只在 `fileExtensions`（`.mmd` 文件能预览成图），而 ` ```mmd ` 围栏不命中（`languages` 里没有）。这个不对称是刻意的：围栏语言是 markdown 惯用名，文件扩展名是文件系统惯用名，两者正交。

## 9 QA

**Q：mermaid 渲染的 SVG 用 `dangerouslySetInnerHTML` 注入，有 XSS 风险吗？**

受 `securityLevel: "strict"` 约束。mermaid 的 strict 模式对节点 label 做 HTML 消毒，注入的 SVG 不含可执行脚本；mermaid 官方文档把 strict 列为 CSP 兼容、防 XSS 的推荐级别。`renderer/index.tsx` 第 64 行注释「mermaid strict 模式输出已消毒」即此意。对比 graphviz 插件的注释「innerHTML 注入的 script 按浏览器规范不执行」，两者安全论证路径不同——mermaid 靠 strict 消毒，graphviz 靠「graphviz 引擎不产 script」。

**Q：为什么 `streaming` 期间直接跳过渲染，而不是尝试解析半成品？**

因为围栏未闭合时 mermaid 语法必然不完整，`mermaid.render` 会抛错，而「每次 token 都 import + 抛错」是纯浪费。mermaid 选择「流式期整体降级源码、落定后一次性成图」，与 markdown 的 50ms 防抖配合，把流式期的图块渲染成本压到零。这也回答了「为什么降级是粗粒度消息级而非围栏级」——mermaid 不自己解析围栏闭合，它只信任消费方给的 `streaming` 标记。

**Q：切换明暗主题后，已渲染的 mermaid 图为什么不立即重画？**

因为 mermaid 的主题是 `initialize({ theme })` 的全局一次性配置，不是响应式 CSS。`isDarkMode()` 读 DOM 实况，但它不参与 `useEffect` 依赖数组（依赖是 `[code, streaming]`），主题切换不会触发 effect 重跑，已渲染的图保持旧主题直到该块 code 再次变化。这是「mermaid 库主题机制」与「app 运行时主题」之间的已知摩擦，被接受为降级而非 bug。

**Q：` ```MMD ` 或 ` ```Mermaid ` 这种大小写围栏能命中吗？**

能。`resolveCodeBlockRenderer` 做 `language.toLowerCase()` 与清单项 `l.toLowerCase()` 的严格比较，大小写不敏感。但语言提取的正则 `/language-(\w+)/` 只认 `\w`（字母数字下划线），所以语言名含连字符（如 `c++`）的围栏在提取阶段就会失败——不过 mermaid 的 `mermaid` 纯字母，不受此限。

**Q：第三方插件能覆盖内置 mermaid 吗？**

能，两条路。其一：声明同 `id: "mermaid"` 的 codeBlockRenderers 项，registry 按 `removeById` 整项替换（高优先级 source 覆盖）。其二：声明不同 id 但 `languages: ["mermaid"]` 的项，`pickBest` 按 `order 小者胜、同 order 数组后者胜` 决胜——`builtin < installed < user < project` 的 source 序保证 project 级插件排后面，同 order 时胜出。这是「壳插件无特权」在围栏语言层的形式：内置 mermaid 与第三方同槽竞争，无特殊照顾。

**Q：mermaid 插件为什么没有 `dependsOn`，它不依赖 markdown 或 timeline 吗？**

因为 dependsOn 表达的是「消费别人的 channel」（`ctx.events.on`/`invoke`）的生命周期护栏，而 mermaid 不消费任何 channel、不查任何槽——它是纯贡献方，只 export 一个组件等别人来查。markdown 也不 dependsOn mermaid（槽消费不是 channel 依赖）。mermaid 与 markdown/timeline 之间是「槽贡献方 ↔ 槽消费方」的声明式解耦，加载顺序由槽机制保证，不需要显式依赖声明。
