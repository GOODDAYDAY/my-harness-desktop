# graphviz

## 1 定位与职责

- graphviz 是 `codeBlockRenderers` 槽的一个贡献方：把会话流里 ` ```dot `、` ```graphviz `、` ```gv ` 围栏代码块渲染成 Graphviz 图。它的 `plugin.json` 声明一条贡献 `{ "id": "graphviz", "languages": ["dot", "graphviz", "gv"], "fileExtensions": ["dot", "gv"], "component": "GraphvizCodeBlock" }`，无 `order`（缺省 100）。结构与 mermaid/puml 兄弟插件一致：`locales/`（4 locale × `plugin.json`）+ `renderer/index.tsx`（61 行）+ `plugin.json`，无 `core/`/`client/`/`pi-extension/`/`dsh-extension/`。

- 它的渲染路径是**本地 WASM 渲染**：动态 import `@viz-js/viz`（viz.js 的 WASM 内联单文件构建，约 1.1MB），`m.instance()` 实例化一个 Viz 单例，`viz.renderString(code, { format: "svg" })` 把 DOT 源码渲染成 SVG。`plugin.json` 的 `description` 写「本地 WASM 渲染,动态加载」，精确对应——「本地」区别于 puml 的服务端渲染，「WASM」区别于 mermaid 的 JS 渲染，「动态加载」指 1.1MB 不进首屏。

- 它与 mermaid 同属「本地渲染」但引擎不同：mermaid 是纯 JS 库（动态 import mermaid 包），graphviz 是 WASM（viz.js 把 Graphviz 的 C 引擎编译成 WebAssembly 内联进单文件）。WASM 意味着 graphviz 在浏览器里跑的是接近原生的图布局算法，无网络、无服务器、源码不出本机——这是它与 puml 的关键差异，与 mermaid 的共同点。

- 它的降级策略与 mermaid 逐字同构：`svg: string | null` + `failed: boolean` 两态，流式期间（`streaming`）跳过渲染、解析失败（`viz.renderString` 抛错）置 failed，两者都回落 `SourceFallback` 源码呈现，消费方不感知。`renderer/index.tsx` 第 23-24 行注释写「流式期间(围栏未闭合必失败)与解析失败都自降级为源码呈现」。

- 它有一个兄弟插件都没有的**明暗主题处理**：graphviz 默认输出透明底黑线的 SVG，暗色主题下黑线不可读，所以容器强制 `bg-white` 白底（`renderer/index.tsx` 第 56 行）。这是「内容写死一个颜色值」与「机制兜底可读性」之间的一次务实取舍——它写死的是容器底色（`bg-white`），不是图本身的颜色，且注释（第 24 行）写「graphviz 输出透明底黑线,容器给白底,保证暗色主题下可读」。

- 它是纯壳插件：只 import `react` 和 `@viz-js/viz` 的**类型**（`import type { Viz }`，第 4 行），无内核身份分支、无写死用户可见文案。`dangerouslySetInnerHTML` 注入的是 graphviz 引擎生成的纯图形 SVG，注释（第 57 行）写「不含 script,innerHTML 注入的 script 按浏览器规范不执行」——安全论证走「graphviz 不产 script」这条路，区别于 mermaid 的「strict 消毒」。

## 2 目录结构

- `plugin.json`：唯一声明面。`renderer` 指向 `./renderer/index.tsx`，`contributes` 声明 `codeBlockRenderers`（一条）+ `languages`（4 locale × `graphviz.plugin`）两槽，无 `permissions`、无 `dependsOn`、无 `protected`。graphviz 纯本地渲染，不需要任何声明能力。

- `renderer/index.tsx`：全部渲染逻辑，一个文件四样东西——`import type { Viz }`（类型导入）、`SourceFallback` 降级组件、`getViz()` 单例工厂、`GraphvizCodeBlock` 主组件。无 `isDarkMode()`（graphviz 不跟随明暗主题，固定白底），无测试文件。

- `locales/`：`de`/`en`/`zh-CN`/`zh-TW` 四个 locale，每个含一个 `plugin.json`，两个 key——`plugin.graphviz.displayName`（「Graphviz 图」）与 `plugin.graphviz.description`（「会话流 dot/graphviz 围栏代码块渲染成图(本地 WASM 渲染,动态加载)」）。渲染期零文案，语言包只有元信息。

- 依赖 `@viz-js/viz: "^3.29.0"` 声明在根 `package.json`，与 `mermaid`、`plantuml-encoder` 并列。与 mermaid 一样走动态 import（`await import("@viz-js/viz")`），但比 mermaid 多一层**单例缓存**（`vizPromise` 模块级变量），因为 WASM 实例化（`m.instance()`）比纯 JS 库 import 贵得多，必须只实例化一次、跨组件复用。

## 3 plugin.json 逐字段：围栏语言契约

- `id: "graphviz"`、`version: "0.4.9"`、`tier: "official"`、`displayName: "Graphviz 图"`、`description: "会话流 dot/graphviz 围栏代码块渲染成图(本地 WASM 渲染,动态加载)"`：与 mermaid/puml 同版本、同 tier。

- `tags: ["conversation"]`：显式声明（`codeBlockRenderers` 无语义，`derivePluginTags` 不推导）。

- `contributes.codeBlockRenderers[0]` 逐字段，对应圆心契约 `CodeBlockRendererContribution`（`packages/shared/src/domain/contributions.ts` 第 307-320 行）：

  - `id: "graphviz"`：贡献 id，插件内唯一。「同 id 被后注册插件整项替换」。

  - `languages: ["dot", "graphviz", "gv"]`：**三个围栏语言别名**。`dot` 是 DOT 语言的正式名（Graphviz 的主图描述语言），`graphviz` 是工具名的惯用围栏别名，`gv` 是 DOT 文件的官方扩展名兼短别名。消费方 `resolveCodeBlockRenderer` 按 `language.toLowerCase()` 严格相等命中，所以 ` ```dot `、` ```graphviz `、` ```gv ` 都派到 `GraphvizCodeBlock`。

  - `fileExtensions: ["dot", "gv"]`：两个文件扩展名。`.dot` 和 `.gv` 都是 DOT 源码文件的惯用扩展名。注意 `languages`（3 项）与 `fileExtensions`（2 项）不对称——`graphviz` 只出现在围栏语言、不出现在文件扩展名（没有 `.graphviz` 这种文件扩展名），这是「围栏语言名」与「文件扩展名」两个命名空间天然不同的体现。

  - `component: "GraphvizCodeBlock"`：renderer 侧组件名，框架按名自动匹配 exports。`renderer/index.tsx` 具名 export 了 `GraphvizCodeBlock`。

  - 无 `order`：缺省 100。

- `contributes.languages`：4 条 `LanguageContribution`（`contributions.ts` 第 130-137 行），id 都是 `graphviz.plugin`，locale `zh-CN`/`zh-TW`/`en`/`de`。

## 4 圆心契约与槽分发机制

- 圆心 `CodeBlockRendererContribution` 给 graphviz 的 props 契约是 `{ code: string; streaming?: boolean }`，`GraphvizCodeBlock` 函数签名 `({ code, streaming = false }: { code: string; streaming?: boolean })` 逐字对齐。契约注释（`contributions.ts` 第 305-306 行）「解析失败/流式未闭合时组件内部自降级为源码呈现,消费方不感知」——graphviz 的 `viz.renderString` 对非法 DOT 抛错，catch 置 failed，满足契约。

- 槽分发机制在 `packages/react/src/code-block-renderers.ts`，三段式：① `plugin.json` 写 `contributes.codeBlockRenderers`（声明）；② `useCodeBlockRenderers()` 查槽（`pluginsNonce` 失效重拉，同 nonce 单发）；③ `resolveCodeBlockRenderer` 按语言定项、`resolveCodeBlockRendererComponent` 匹配 exports。

- `useCodeBlockRenderers()` 返回 `CodeBlockRendererItem[]`（`CodeBlockRendererContribution & { pluginId }`），从 `window.kernel.slots.codeBlockRenderers()` 拉全量贡献，模块级 `cache` + `pluginsNonce` 失效。graphviz 的贡献项带 `languages: ["dot","graphviz","gv"]` 和 `fileExtensions: ["dot","gv"]` 两个清单。

- `resolveCodeBlockRenderer(items, "dot")`（`code-block-renderers.ts` 第 37-46 行）：`language.toLowerCase()` 后 filter `i.languages` 有一项 `l.toLowerCase() === lower` 的项，交 `pickBest`（第 61-66 行）「order 小者胜、同 order 数组后者胜」。items 保注册序（`builtin→installed→user→project`），数组后者 = 高优先级 source。

- `resolveCodeBlockRendererByExtension(items, "gv")`（第 50-59 行）：查 `fileExtensions` 清单，与按语言同构。`.gv` 文件在 file-preview 里命中 graphviz 这条贡献。

- `resolveCodeBlockRendererComponent(item)`（第 70-74 行）：`asReactComponent(getPluginComponent(item.pluginId, item.component))` 投影成 `ComponentType<{ code: string; streaming?: boolean }>`。graphviz 组件被 markdown 和 file-preview 共用。

- graphviz 是纯「内容」：不认识 `useCodeBlockRenderers`、不认识任何消费方，只 export 一个符合 props 契约的组件。加 graphviz = 加这个插件，槽机制一行不动。

## 5 渲染器实现（renderer/index.tsx 逐函数）

- `import type { Viz } from "@viz-js/viz";`（第 4 行）：**type-only import**。这是「依赖只向内」纪律下的一个细节——`Viz` 类型用于 `vizPromise` 的变量类型标注，不引入运行时值。`@viz-js/viz` 的运行时值（`instance` 工厂）通过动态 `await import("@viz-js/viz")` 在 `getViz` 里取，type 与值两条 import 路径分开。

- `let vizPromise: Promise<Viz> | null = null;`（第 15 行）+ `getViz()`（第 16-19 行）：`vizPromise ??= import("@viz-js/viz").then((m) => m.instance()); return vizPromise;`。这是 Viz 实例的**模块级单例缓存**——`??=` 保证首次调用才 import + 实例化，后续调用直接复用同一个 Promise/实例。为什么必须单例：`m.instance()` 是 WASM 模块的初始化（编译后的 Graphviz C 引擎加载到 WebAssembly 内存），成本远高于纯 JS 库 import；多个 GraphvizCodeBlock 实例（多条消息里的多个图）若各自实例化，会重复加载 1.1MB WASM 并各占一份内存。模块级变量（而非 React state）是对的，因为单例是「全局唯一资源」，不需要触发重渲染。

- viz.js 与 WASM 的关系：`@viz-js/viz` 是 viz.js 的现代打包，Emscripten 把 Graphviz 的 C 引擎编译成 WebAssembly + JS 胶水，`m.instance()` 返回一个 `Viz` 实例，其 `renderString(src, options)` 方法接受 DOT 源码、返回 `{ format }` 指定的输出字符串。与 mermaid 的纯 JS 解析不同，graphviz 跑的是真实 Graphviz 布局算法（dot 的有向图分层、neato 的力导向等引擎），图的节点排布是编译后的 C 算法算出来的，不是 JS 复刻——这是「WASM 渲染」与「JS 渲染」的本质差异：WASM 保真 Graphviz 原版布局，mermaid 是 JS 重新实现的布局。插件不解析 DOT 语法，只「转发源码、收 SVG」。

- DOT 语言契约：` ```dot ` 围栏内容是 DOT 语言源码（`digraph G { a -> b; }` 有向图或 `graph G { a -- b; }` 无向图），`viz.renderString` 把它交给 Graphviz 引擎解释。DOT 的 `digraph` 产出箭头边、`graph` 产出直线边、`node`/`edge` 属性（`[label=..., color=...]`）控制节点/边样式——这些语义全部由 Graphviz 引擎解释，graphviz 插件不解析 DOT 语法。所以插件的「围栏语言契约」实质是「`dot`/`graphviz`/`gv` 三个别名 → 一段 DOT 源码」，语法的正确性（括号配对、属性合法、图类型）完全交给引擎，引擎抛错则 catch 降级源码。

- `SourceFallback({ code })`（第 6-12 行）：与 mermaid/puml 逐字同构的降级 `<pre>`。

- `GraphvizCodeBlock({ code, streaming = false })`（第 25-61 行）主体，与 mermaid 的 `svg + failed` 两态同构：

  - `const [svg, setSvg] = useState<string | null>(null); const [failed, setFailed] = useState(false);`

  - useEffect（第 29-44 行）：`if (streaming) return;` 跳过流式；`let alive = true;` + cleanup 防竞态；`setSvg(null); setFailed(false);` 重置；async 体 `const viz = await getViz(); const rendered = viz.renderString(code, { format: "svg" }); if (alive) setSvg(rendered);`；`catch { if (alive) setFailed(true); }`。

  - 渲染分支（第 46-60 行）：`if (streaming || failed) return <SourceFallback code={code} />`；`if (!svg)` 返回 spinner；有 svg 返回 `<div className="overflow-x-auto p-3 flex justify-center bg-white" dangerouslySetInnerHTML={{ __html: svg }} />`。

- `viz.renderString(code, { format: "svg" })` 是 graphviz 与 mermaid 的核心差异点：它接受 DOT 源码、产出 SVG 字符串，格式参数显式 `format: "svg"`（viz.js 也支持 `dot`/`json`/`xdot` 等，这里选 SVG 与 mermaid 的渲染出口一致）。DOT 语法错误（如括号不配、非法属性）会让 `renderString` 抛错，进入 catch 降级。

- `format: "svg"` 与引擎默认值：`renderString(src, { format })` 只传了 format，没传 `engine` 选项，所以 viz.js 用默认 `dot` 引擎（Graphviz 的有向图分层布局引擎）。viz.js 的 `renderString` 完整 options 还支持 `engine: "neato" | "fdp" | "sfdp" | "circo" | "twopi" | "dot"` 等，插件不传就是 `dot`。这意味着 ` ```dot ` 围栏里的 DOT 源码若要用力导向布局（neato）或圆形布局（circo），不能靠插件参数选择，只能靠源码内嵌 `layout=neato` 属性或 `engine` 指令——引擎选择知识在 DOT 源码里，插件保持「不替用户选引擎」的薄语义。

- 输出尺寸与缩放：`renderString` 产出的 SVG 带 `width`/`height` 属性（由 Graphviz 引擎按图内容算出），插件不覆盖尺寸，只在容器层 `overflow-x-auto` 横向滚动 + `flex justify-center` 居中。超宽图（节点多的大图）不会被缩到容器宽度内，而是横向滚动查看——这与 puml 的 `maxWidth: "100%"`（`<img>` 自动缩到容器宽）不同。graphviz 的 SVG 是内联注入（`dangerouslySetInnerHTML`），没有 `<img>` 的天然 `maxWidth` 缩放，所以用横向滚动替代。

- `bg-white` 容器底色（第 56 行）：graphviz 的 SVG 输出是透明底 + 黑线，暗色主题下黑线贴在暗底上不可读，所以容器强制白底。这是三个图插件里唯一「写死一个颜色值」的地方，但它写死的是容器底色而非图内容，且注释明确这是「保证暗色主题下可读」的机制兜底。对比 mermaid 的 `isDarkMode()` 主动跟随主题、puml 的服务器默认浅色——三者对明暗的处理策略各不相同，反映三种渲染引擎的主题能力差异：mermaid 支持运行时主题切换、graphviz 不支持（只能白底兜底）、puml 主题由源码 `!theme` 指令决定（插件不参与）。

- `dangerouslySetInnerHTML` 的安全论证（第 57 行注释）：「viz.js 输出是 graphviz 引擎生成的纯图形 SVG(不含 script),innerHTML 注入的 script 按浏览器规范不执行」。两层论证：其一，graphviz 引擎渲染 DOT 时只产图形元素（path/polygon/text），不产 `<script>`；其二，即使 SVG 里混入 script，`innerHTML` 注入的 script 标签按 HTML 规范也不执行（这是浏览器行为，不是 graphviz 的保证）。这与 mermaid 的「strict 模式消毒」是两条不同的安全路径——graphviz 靠「源头不产 script」+「innerHTML 不执行 script」，mermaid 靠「库主动消毒」。

## 6 与 markdown 插件（消费方）的交互

- markdown 插件是 graphviz 的**唯一会话流消费方**。调用链：`markdown-body.tsx` 的 `MarkdownBody` 调 `useCodeBlockRenderers()` 拿全量贡献（含 graphviz 那条），传 `codeBlockItems` 给 `CodeBlock`；`ReactMarkdown` 的 `components.pre` 覆盖把每个 `<pre>` 交 `CodeBlock`。

- `CodeBlock` 围栏语言提取：`const lang = /language-(\w+)/.exec(className)?.[1] ?? ""`。` ```dot ` 产出 `language-dot`，`lang` 得 `dot`。分发：`resolveCodeBlockRenderer(codeBlockItems, "dot")` 命中 graphviz 那条贡献（`languages` 含 `dot`），`resolveCodeBlockRendererComponent` 拿 `GraphvizCodeBlock`。

- 渲染：`<CbrComp code={text} streaming={streaming} />`。`text = rawText(...)` 是 DOT 源码原文（`digraph G { ... }`），`streaming` 从 `MarkdownBody` 透传。

- 「markdown 不认识任何具体语言」对 graphviz 同样成立：markdown 只知道「围栏语言命中槽就派、不命中就高亮」。graphviz 被禁用时 ` ```dot ` 块退化为 `rehype-highlight` 高亮代码体。

- 流式语义配合：markdown 的 `Markdown` 壳对流式文本 50ms 防抖，`MarkdownBody` 把「流式标记传给图块」与「文本防抖由 Markdown 壳负责」分工。graphviz 收到的 `streaming` 是消息级总开关——整条消息流式期间 graphviz 块降级源码，落定后统一成图。

- 一个 graphviz 特有的交互细节：与 mermaid 一样，`if (streaming) return;` 在 useEffect 里短路，流式期间不调用 `getViz()`、不 import `@viz-js/viz`、不实例化 WASM。这意味着一个纯文本会话（无图）永不加载 1.1MB 的 viz.js——动态 import 的收益在此兑现：WASM 只在「真遇到图且消息落定」时才加载。

## 7 与 timeline（blockRenderers 上层）的交互

- timeline 不认识 graphviz。timeline 的 `BlockRenderer`（`src/plugins/sessions/timeline/renderer/block-renderer.tsx`）只查 `blockRenderers` 槽，`text` 块经 `resolveBlockRenderer(items, "text")` 命中 markdown 的 `MarkdownText`（`block: "text"`）。

- 调用链全景：`timeline` 的 `BlockRenderer` → `text` 块 → markdown 的 `Markdown` → `MarkdownBody` → `CodeBlock` → graphviz 的 `GraphvizCodeBlock`。timeline 与 graphviz 之间隔着 markdown 一整层。

- timeline 传 text 块的 props 是 `text` + `streaming`（`block-renderer.tsx` 第 35-36 行），`pending = message.pending === true`。这个 `streaming` 一路透传到 graphviz，是降级判据的最终来源。

- timeline 的 `PlainBlockFallback` 只兜 `blockRenderers` 槽解析失败（markdown 缺席），与 graphviz 无关。三层兜底互不重叠：timeline 兜「text 块没人画」，markdown 兜「围栏语言没人认」，graphviz 兜「认了但画不出（DOT 语法错误）」。

- graphviz 与 timeline 的耦合是「间接、单向、经槽」的：graphviz 无 `dependsOn`（纯贡献方，不消费 channel、不查槽）。markdown 也不 `dependsOn` graphviz。graphviz 对 timeline/markdown 缺席的处理是「回升高亮代码体」。

## 8 fileExtensions 文件预览映射（file-preview 消费方）

- graphviz 的第二个消费方是 file-preview 插件（`src/plugins/project/file-preview/renderer/index.tsx`），消费 `fileExtensions: ["dot", "gv"]`。file-preview 按扩展名查槽：`resolveCodeBlockRendererByExtension(codeBlockRenderers, getExtension(path))`（第 102 行）。

- 触发：`route === "text"` 才查槽。`.dot`/`.gv` 不在 image/pdf/binary/markdown 特殊集合里，落 `text` 路由，然后用 `getExtension(path)` 匹配 `fileExtensions`。

- 命中后：`richRoute = route === "text" && diagramItem ? "diagram" : route`（第 110 行），`DiagramComp != null` 才 `canRenderRich`。最终 `effectiveRoute === "diagram"` 渲染 `<DiagramComp code={content} streaming={false} />`（第 290-298 行），`content` 是 `ctx.fs.readFile(path)` 全文，`streaming` 恒 false。

- 文件预览与围栏渲染共用 `GraphvizCodeBlock`、共用降级：`.dot` 文件内容若 DOT 语法错误，`renderString` 抛错置 failed 走 `SourceFallback`。file-preview 的「看源码」切换让用户切回行号纯文本。

- 「映射知识归贡献方」在 graphviz 上兑现：file-preview 第 90-93 行注释写「图路由 = text 文件的扩展名命中 codeBlockRenderers 槽的 fileExtensions 声明——映射知识归贡献方」。graphviz 声明 `["dot","gv"]`，file-preview 不硬编码。

- 边界：`graphviz` 只参与围栏渲染、不参与文件预览（`fileExtensions` 无 `graphviz`，因为没有 `.graphviz` 扩展名）。`dot`/`gv` 同时出现在 `languages` 和 `fileExtensions`——`.dot` 文件既能作为文件预览图，也能作为 ` ```dot ` 围栏图，两者共用 `GraphvizCodeBlock`。

- `.gv` 与 `.dot` 的命名关系：两者都是 DOT 源码文件的惯用扩展名，内容格式完全一致（都是 `digraph`/`graph` 描述的图定义）。`.dot` 是 Graphviz 最老牌的扩展名（沿袭自 DOT 语言名），`.gv` 是 Graphviz 官方后来推广的短扩展名（因为 `.dot` 与微软 Word 模板文件 `.dot` 撞名）。graphviz 插件把两者都声明进 `fileExtensions`，是因为两个扩展名在生态里都常见——`resolveCodeBlockRendererByExtension` 对两者一视同仁（小写比较），都派到 `GraphvizCodeBlock`。这正是「映射知识归贡献方」的价值：文件预览不用区分「哪个 DOT 别名更正统」，graphviz 插件自己在 manifest 里说清「我能预览这两个扩展名」。

- 文件预览与「看源码」的配合细节：`.dot`/`.gv` 文件的「图渲染」与「源码视图」都走同一份内容（`ctx.fs.readFile` 读的全文），只是渲染出口不同——图路由走 `GraphvizCodeBlock`（WASM 渲染成 SVG），源码视图走行号文本（`effectiveRoute === "text"` 的分支）。两者切换零成本（内容已在内存），不重新读文件。这与其他「非图文本文件」（如 `.ts`）的区别在于：`.ts` 只有源码视图（`routeOf` 落 text 且 `diagramItem` 为 undefined），`.dot` 有图 + 源码双视图。

## 9 QA

**Q：graphviz 的 WASM 单例（`vizPromise`）为什么用模块级变量而不是 React state？**

因为 Viz 实例是「全局唯一资源」，不是「组件状态」。WASM 实例化（`m.instance()`）成本高，多个 GraphvizCodeBlock 实例（多条消息多个图）应共享同一个实例；模块级 `vizPromise` 恰好提供「进程生命周期内只实例化一次」的语义，且不需要触发任何重渲染——它不是 UI 状态，只是缓存。若放进 React state，反而会引入「状态提升到哪一层」的伪问题。这是「组件只读 store、零拉取」精神在单例缓存上的体现。

**Q：graphviz 的 `bg-white` 是不是违反了「零硬编码颜色值」纪律？**

是边界上的取舍，不是红线违规。它写死的是容器底色（`bg-white`），不是图内容，且注释明确「graphviz 输出透明底黑线,容器给白底,保证暗色主题下可读」——这是「机制兜底可读性」而非「内容配色」。真正的红线是「写死主题 token 背后的值」（如 `#89b4fa`）。`bg-white` 是 Tailwind 的语义类名（不是 hex 值），且是 graphviz 引擎「不支持运行时主题」这个客观约束下的最小兜底。若 graphviz 引擎将来支持深色配色，这条 `bg-white` 应随引擎能力演进为主题感知。

**Q：graphviz 的 `dangerouslySetInnerHTML` 有 XSS 风险吗？**

依赖两层论证：其一，graphviz 引擎（viz.js）渲染 DOT 只产图形元素（path/polygon/text），不产 `<script>`——这是「源头干净」；其二，`innerHTML` 注入的 `<script>` 标签按 HTML 规范不执行——这是「浏览器兜底」。与 mermaid 的「strict 模式主动消毒」路径不同，graphviz 靠「不产 script」+「innerHTML 不执行 script」两条被动保证。两者的共同点是都注入了 SVG，但各自的安全论证独立、且都落在组件注释里。

**Q：第三方插件能覆盖内置 graphviz 吗？**

能，两条路。其一：声明同 `id: "graphviz"` 的项，registry 按 `removeById` 整项替换。其二：声明不同 id 但 `languages: ["dot"]` 的项，`pickBest` 按「order 小者胜、同 order 数组后者胜」决胜，`builtin < installed < user < project` 序保证高优先级 source 胜出。细粒度：第三方可只覆盖 `dot` 别名而保留 `graphviz`/`gv` 归内置。这是「壳插件无特权」在围栏语言层的体现——内置 graphviz 与第三方同槽竞争，无特殊照顾。

**Q：graphviz 为什么用 WASM 而不是 JS 复刻 Graphviz？**

因为 Graphviz 的布局算法（dot 的有向图分层、neato 的力导向等）是几十年锤炼的 C 实现，JS 复刻既保真度低又维护成本高。WASM 让浏览器直接跑编译后的 C 引擎，拿到「原版布局」的保真度，代价是 1.1MB 体积（用动态 import 拆出首屏抵消）。这是「手写收敛到成熟包」的极端形态——不是收敛到 JS 包，而是收敛到「编译成 WASM 的原版 C 引擎」，比 mermaid 的 JS 复刻更接近「用别人的实现」。mermaid 与 graphviz 的差异本质是「JS 重新实现布局」vs「WASM 跑原版 C 布局」。

**Q：graphviz 为什么动态 import 而 puml 静态 import？**

因为体积差异决定加载策略。`@viz-js/viz` 是 1.1MB+ 的 WASM 内联单文件，进首屏是纯负担，必须「真遇到图才加载」；`plantuml-encoder` 是几 KB 的纯编码函数，静态 import 的代价可忽略，动态拆 chunk 反而徒增异步边界。mermaid（500KB+）与 graphviz 同属「重依赖动态 import」，puml 属「轻依赖静态 import」。这是「按体积决定」——不是所有兄弟插件都要机械一致，动态 import 是手段不是目的。
