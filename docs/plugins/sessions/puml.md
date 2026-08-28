# puml

## 1 定位与职责

- puml 是 `codeBlockRenderers` 槽的一个贡献方：把会话流里 ` ```puml ` 或 ` ```plantuml ` 围栏代码块渲染成 PlantUML 图。它的 `plugin.json` 声明一条贡献 `{ "id": "puml", "languages": ["puml", "plantuml"], "fileExtensions": ["puml", "plantuml", "iuml"], "component": "PumlCodeBlock" }`，无 `order`（缺省 100）。结构与 mermaid/graphviz 兄弟插件完全一致：`locales/`（4 locale × `plugin.json`）+ `renderer/index.tsx`（48 行）+ `plugin.json`，无 `core/`/`client/`/`pi-extension/`/`dsh-extension/`。

- 它与 mermaid/graphviz 的本质差异在渲染路径：mermaid 本地渲染（动态 import mermaid 库）、graphviz 本地 WASM 渲染（`@viz-js/viz`），而 puml 是**服务端渲染**——`plantuml-encoder` 把源码编码成一段 deflate+base64 的字符串，拼到公共 PlantUML 服务器 `https://www.plantuml.com/plantuml/svg/<encoded>` 的 URL，用一个 `<img>` 标签去拉图。`plugin.json` 的 `description` 写「plantuml-encoder + server 端点」，精确对应这条路径。

- 它的降级策略与兄弟插件同构但触发条件更多：流式期间（`streaming`）、编码失败（`plantumlEncoder.encode` 抛错 → `url` 为 null）、图片加载失败（`<img>` 的 `onError` → `status === "error"`）三种情况都回落 `SourceFallback` 源码呈现，消费方不感知。`renderer/index.tsx` 第 17-18 行注释写「编码/加载失败与流式期间都自降级为源码呈现」。

- 它引入了一个兄弟插件没有的**外部依赖面**：PlantUML 源码文本会被编码后发到 `plantuml.com` 第三方服务器换取 SVG。这是隐私/网络层面的一个真实代价——离线环境图渲染不出（`onError` 降级源码），且围栏内的图源码会离开本机。文档在 QA 里把它作为真问题展开，不回避。

- 它是纯壳插件：只 import `react` 和 `plantuml-encoder`（后者是纯编码函数库，零 DOM、零网络），无内核身份分支、无写死用户可见文案、无写死颜色值（容器背景 `bg-[var(--color-surface)]` 走主题 token）。渲染是纯函数——同一段 PlantUML 源码在任何内核下、任何主题下（明暗由服务器端默认主题决定，见 §5）产出的图一致。

## 2 目录结构

- `plugin.json`：唯一声明面。`renderer` 指向 `./renderer/index.tsx`，`contributes` 声明 `codeBlockRenderers`（一条）+ `languages`（4 locale × `puml.plugin`）两槽，无 `permissions`、无 `dependsOn`、无 `protected`。发往 plantuml.com 的请求是 `<img>` 的普通资源加载，不经过壳的权限沙箱（沙箱管的是 `window.kernel` 上的声明能力，如 `sessions:bus`），所以 puml 不需要也不声明任何 permission。

- `renderer/index.tsx`：全部渲染逻辑，一个文件三样东西——`DEFAULT_SERVER` 常量、`SourceFallback` 降级组件、`PumlCodeBlock` 主组件。与 mermaid 不同的是它没有 `isDarkMode()` 之类的主题判定函数，因为主题由服务器端 PlantUML 决定，插件不参与明暗。

- `locales/`：`de`/`en`/`zh-CN`/`zh-TW` 四个 locale，每个含一个 `plugin.json`，只有两个 key——`plugin.puml.displayName` 与 `plugin.puml.description`（英文版是「PlantUML Diagrams」/「Renders puml/plantuml fenced code blocks in the session stream as diagrams (server endpoint)」）。注意 `zh-CN` 的 description 写「server 端点」而英文写「server endpoint」，两者语义一致，是插件管理器列表页的元信息文案。

- 依赖 `plantuml-encoder: "^1.4.0"` 声明在根 `package.json`，与 `mermaid`、`@viz-js/viz` 并列。与 mermaid 的动态 import 不同，puml 是**静态 import**（`renderer/index.tsx` 第 4 行 `import plantumlEncoder from "plantuml-encoder"`）——因为这个库极小（纯编码函数，无 DOM/网络依赖），不值得动态拆 chunk；它进首屏 bundle 的代价可忽略，换来的是「首帧同步可用」。

## 3 plugin.json 逐字段：围栏语言契约

- `id: "puml"`、`version: "0.4.9"`、`tier: "official"`、`displayName: "PlantUML 图"`、`description: "会话流 puml/plantuml 围栏代码块渲染成图(plantuml-encoder + server 端点)"`：`tier: "official"` 是信任级别（`PluginTier = "official" | "verified" | "community"`，`contributions.ts` 第 523 行），与内置身份无特权挂钩——官方插件与第三方插件走同一加载器、同一槽竞争。

- `tags: ["conversation"]`：显式声明（`codeBlockRenderers` 是「无语义槽」，`derivePluginTags` 不推导它）。与 mermaid/graphviz 一致。

- `contributes.codeBlockRenderers[0]` 逐字段，对应圆心契约 `CodeBlockRendererContribution`（`packages/shared/src/domain/contributions.ts` 第 307-320 行）：

  - `id: "puml"`：贡献 id，插件内唯一。「同 id 被后注册插件整项替换」——第三方若声明同 id 的项（高优先级 source）整项替换内置 puml。

  - `languages: ["puml", "plantuml"]`：**两个围栏语言别名**。这是 puml 与 mermaid 的第一处差异——mermaid 只认一个 `mermaid`，puml 认 `puml` 与 `plantuml` 两个别名，因为 PlantUML 生态里 ` ```plantuml ` 是惯用名、` ```puml ` 是短名，两者都常见。消费方 `resolveCodeBlockRenderer` 按 `language.toLowerCase()` 与清单每项 `l.toLowerCase()` 严格相等命中，所以 ` ```puml ` 和 ` ```plantuml ` 都派到 `PumlCodeBlock`，` ```iuml ` 不命中（`iuml` 是文件扩展名，不是围栏语言）。

  - `fileExtensions: ["puml", "plantuml", "iuml"]`：三个文件扩展名。`.puml`/`.plantuml` 是 PlantUML 源码惯用扩展名，`.iuml` 是 PlantUML 官方文档用的「include 片段」扩展名（`!include` 引用的子图文件）。三者在文件预览里都命中此条，升级为 diagram 富路由。注意 `languages`（2 项）与 `fileExtensions`（3 项）不对称——`iuml` 只出现在文件预览，不出现在围栏语言，与 mermaid 的 `mmd` 同理。

  - `component: "PumlCodeBlock"`：renderer 侧组件名，框架按名自动匹配 exports。`renderer/index.tsx` 具名 export 了 `PumlCodeBlock`。

  - 无 `order`：缺省 100。

- `contributes.languages`：4 条 `LanguageContribution`（`contributions.ts` 第 130-137 行），id 都是 `puml.plugin`，locale `zh-CN`/`zh-TW`/`en`/`de`，resources 指向各 locale `plugin.json`。渲染期零文案（图内容由 PlantUML 源码自解释），语言包只有元信息两条 key。

## 4 圆心契约与槽分发机制

- 圆心 `CodeBlockRendererContribution` 给 puml 的 props 契约是 `{ code: string; streaming?: boolean }`，`PumlCodeBlock` 的函数签名 `({ code, streaming = false }: { code: string; streaming?: boolean })` 逐字对齐。契约注释（`contributions.ts` 第 305-306 行）写「解析失败/流式未闭合时组件内部自降级为源码呈现,消费方不感知」——puml 的「加载失败」比「解析失败」多一层（服务端图加载失败也算），但契约只要求「组件内部自降级」，puml 把两类失败都收进 `status === "error"` 一个出口，仍然满足契约。

- 槽分发机制在 `packages/react/src/code-block-renderers.ts`，三段式（镜像 `block-renderers.ts`）：① 贡献方 `plugin.json` 写 `contributes.codeBlockRenderers`；② 消费方 `useCodeBlockRenderers()` 查槽（`pluginsNonce` 失效重拉）；③ `resolveCodeBlockRenderer` 按语言定项、`resolveCodeBlockRendererComponent` 匹配 exports。

- `useCodeBlockRenderers()` 返回 `CodeBlockRendererItem[]`（`CodeBlockRendererContribution & { pluginId }`），从 `window.kernel.slots.codeBlockRenderers()` 拉全量贡献，模块级 `cache` 缓存 + `pluginsNonce` 失效。puml 的贡献项是数组里 `pluginId === "puml"` 那一条，它同时带 `languages: ["puml","plantuml"]` 和 `fileExtensions: ["puml","plantuml","iuml"]` 两个清单。

- `resolveCodeBlockRenderer(items, "plantuml")`（`code-block-renderers.ts` 第 37-46 行）：`language.toLowerCase()` 后 filter 出 `i.languages` 有一项 `l.toLowerCase() === lower` 的项，交 `pickBest`。`pickBest`（第 61-66 行）`reduce` 实现「order 小者胜、同 order 取数组后者」——`(cur.order ?? 100) <= (best?.order ?? 100) ? cur : best`。items 保注册序（`builtin→installed→user→project`），数组后者 = 高优先级 source。

- `resolveCodeBlockRendererByExtension(items, "iuml")`（第 50-59 行）：与按语言同构，但查的是 `fileExtensions` 清单。`.iuml` 文件在 file-preview 里命中 puml 这条贡献。两个 resolver 共用 `pickBest`，所以覆盖语义一致。

- `resolveCodeBlockRendererComponent(item)`（第 70-74 行）：`asReactComponent(getPluginComponent(item.pluginId, item.component))` 投影成 `ComponentType<{ code: string; streaming?: boolean }>`。puml 组件被 markdown 和 file-preview 两个消费方共用，同一个组件、同一套降级。

- puml 在这个机制里是纯「内容」：它不认识 `useCodeBlockRenderers`、不认识任何消费方，只 export 一个符合 props 契约的组件。加 puml 这个语言 = 加这个插件，槽机制一行不动；换 PlantUML 服务器（`DEFAULT_SERVER` 常量）只改 puml 一个文件，markdown/file-preview/timeline 全不感知。

## 5 渲染器实现（renderer/index.tsx 逐函数）

- `const DEFAULT_SERVER = "https://www.plantuml.com/plantuml";`（第 6 行）：PlantUML 服务器基址常量。它是 puml 唯一的「外部端点」写死点。插件不提供配置项让用户改服务器——这是「服务端渲染」这个选型的固有属性：要么用公共服务器，要么自建服务器（改这个常量 + 重新打包）。它没有走 `ctx.prefs`/`configFile` 的配置通道，因为 PlantUML 服务器是技术细节而非用户偏好。

- `SourceFallback({ code })`（第 8-14 行）：与 mermaid/graphviz 的 `SourceFallback` 逐字同构——`<pre className="p-3 overflow-x-auto text-[length:var(--font-size-base)] leading-6 font-[var(--font-family-mono)] !bg-transparent">`。三个插件各写一份而非收敛到框架，这是「参数级 vs 行为级」判断的边界：降级 `<pre>` 只有一行 JSX，收敛到一个共享组件的收益低于「让每个插件零依赖自持」的收益，且三个插件有意保持「兄弟插件同结构」的物理一致性。

- `PumlCodeBlock({ code, streaming = false })`（第 19-48 行）主体，与 mermaid 的 `svg + failed` 两态不同，puml 用单一 `status: "loading" | "ok" | "error"` 三态状态机：

  - `const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");`

  - `url = useMemo(() => { try { return `${DEFAULT_SERVER}/svg/${plantumlEncoder.encode(code)}`; } catch { return null; } }, [code]);`：URL 是 `code` 的派生值，用 `useMemo` 缓存避免每次渲染重编码。`plantumlEncoder.encode(code)` 是 PlantUML 的 deflate + 自定义 base64 编码（URL-safe，不含 `+/`），编码失败（理论上 encode 对任意字符串都成功，但契约仍防御性 try/catch）返回 null。

  - `useEffect(() => { setStatus("loading"); }, [url]);`：URL 变化时重置为 loading。这里依赖 `[url]` 而非 `[code]` 是精确的——只要编码结果变（=code 变）就重开加载态，编码失败（url 从字符串变 null）也触发。

  - 渲染分支（第 32-47 行）：`if (streaming || !url || status === "error") return <SourceFallback code={code} />`——流式、编码失败、加载失败三路都降级源码。否则渲染 `<div className="overflow-x-auto p-3 flex justify-center bg-[var(--color-surface)]">`，内含：loading 时一个 spinner（`<span className="size-4 rounded-full border-2 border-[var(--color-muted)] border-t-transparent animate-spin" />`），和一个 `<img>`。

  - `<img src={url} alt="" onLoad={() => setStatus("ok")} onError={() => setStatus("error")} style={{ display: status === "ok" ? "block" : "none", maxWidth: "100%" }} />`：图片加载成功 `onLoad` 置 ok（显示），失败 `onError` 置 error（触发降级）。`alt=""` 表示图是装饰性内容（PlantUML 源码已在降级路径可读）。`style` 里 `display` 用内联而非 className 是因为「ok 才显示」是状态相关、非静态样式；`maxWidth: "100%"` 保证超宽图在容器内缩放。

- `plantumlEncoder.encode(code)` 的编码语义：PlantUML 文本编码是「deflate 压缩 + URL-safe base64 变体」的编码，产出不含 `+/=` 的字符串，可直接拼进 URL path 段。PlantUML 服务器约定 `/svg/<encoded>` 端点接受这段编码文本、返回 SVG 图；同族的还有 `/png/`（位图）、`/txt/`（ASCII art）、`/map/`（图片热区 map）等格式端点。插件只选 `/svg/`——与 mermaid/graphviz 的渲染出口一致（三者都产矢量图，消费方统一按「图」呈现，不区分位图/矢量）。

- `useMemo` 与 `useEffect` 的分工时序：`url` 是 `code` 的 `useMemo` 派生值（同步、可缓存、可判 null），`status` 的重置是 `useEffect`（`[url]` 变化后异步置 loading）。这两个 hook 精确对应「编码」与「加载」两个阶段——编码是纯函数同步算（`useMemo` 合适），加载是异步网络事件（`useEffect` 只负责在 URL 变化时把状态机打回 loading，真正的 ok/error 由 `<img>` 的 `onLoad`/`onError` 回填）。`useMemo` 的 try/catch 防御性兜住「encode 抛错」这个理论分支，产出 null → 走 SourceFallback。

- PlantUML 源码的 `@startuml`/`@enduml` 包裹：PlantUML 允许省略这对标记（裸图源码也能渲染），所以 markdown 围栏里的 ` ```plantuml ` 内容可能是完整包裹或裸源码，puml 都原样 encode 交给服务器，不自己补 `@startuml`。补包裹是 PlantUML 服务端解析器的行为，插件保持「编码即转发」的薄语义，不掺和图源码的规范化。

- puml 的 `<img>` 与 mermaid/graphviz 的 `dangerouslySetInnerHTML` 是三种不同的渲染出口：mermaid/graphviz 拿 SVG 字符串注入 DOM（有 XSS 面，各自论证消毒），puml 拿图片 URL 交给 `<img>`（浏览器只渲图，不执行脚本，天然无 XSS 面）。这是「服务端渲染」附带的安全红利——SVG 由 PlantUML 服务器生成，本机只消费位图/矢量图，不执行任何 SVG 内嵌脚本。

- 主题明暗：puml 不处理明暗主题。PlantUML 服务器默认输出浅色图（白底黑线），容器 `bg-[var(--color-surface)]` 只是给加载中的空白区一个中性底色，与图本身底色无关。暗色主题下 PlantUML 默认图仍是浅色——这与 mermaid 的 `isDarkMode()` 主动跟随主题形成对比。要让 PlantUML 图随主题变暗，需要在源码里写 `!theme dark` 指令（属于 PlantUML 源码内容，不是插件职责），插件不注入这个指令。

## 6 与 markdown 插件（消费方）的交互

- markdown 插件是 puml 的**唯一会话流消费方**。调用链：`markdown-body.tsx` 的 `MarkdownBody` 调 `useCodeBlockRenderers()` 拿全量贡献（含 puml 那条），传 `codeBlockItems` 给 `CodeBlock`；`ReactMarkdown` 的 `components.pre` 覆盖把每个 `<pre>` 交 `CodeBlock`。

- `CodeBlock`（`markdown-body.tsx` 第 23-70 行）围栏语言提取：`const lang = /language-(\w+)/.exec(className)?.[1] ?? ""`。` ```plantuml ` 产出 `language-plantuml`，`lang` 得 `plantuml`。分发：`resolveCodeBlockRenderer(codeBlockItems, "plantuml")` 命中 puml 那条贡献（因为 `languages` 含 `plantuml`），`resolveCodeBlockRendererComponent` 拿 `PumlCodeBlock`。

- 渲染：`<CbrComp code={text} streaming={streaming} />`。`text = rawText(codeEl?.props?.children)` 把围栏内容压成纯字符串，puml 拿到的 `code` 是 PlantUML 源码原文（如 `@startuml ... @enduml` 或省略 `@startuml` 的简写）。`streaming` 从 `MarkdownBody` 透传，是 puml 判断「流式未闭合」的依据。

- 「markdown 不认识任何具体语言」（`markdown-body.tsx` 第 42 行注释）对 puml 同样成立：markdown 只知道「围栏语言命中槽就派、不命中就高亮」，它不认识 puml/plantuml。puml 与 markdown 是「槽贡献方 ↔ 槽消费方」纯解耦——puml 被禁用时，` ```plantuml ` 块退化为 `rehype-highlight` 高亮的普通代码体，markdown 不报错。

- 流式语义配合：markdown 的 `Markdown` 壳（`markdown.tsx`）对流式文本 50ms 防抖，`MarkdownBody` 把「流式标记传给图块」与「文本防抖由 Markdown 壳负责」分工（`markdown-body.tsx` 第 74 行注释）。puml 收到的 `streaming` 是消息级总开关，不是围栏闭合信号：整条消息流式期间 puml 块走源码降级，消息落定（`message.pending === false`）后统一发请求成图。这与 mermaid 一致——粗粒度流式闸门。

- 一个 puml 特有的交互细节：流式期间 puml 不发起任何网络请求（`if (streaming) return <SourceFallback />` 在 `useEffect` 之前就短路，甚至不构造 URL——实际上 `useMemo` 仍会构造 URL，但 `<img>` 不渲染，所以不触发加载）。这意味着流式期间不会对每个 token 的半成品 PlantUML 源码打服务器，避免了对公共服务器的请求风暴。

## 7 与 timeline（blockRenderers 上层）的交互

- timeline 不认识 puml。timeline 的 `BlockRenderer`（`src/plugins/sessions/timeline/renderer/block-renderer.tsx`）只查 `blockRenderers` 槽，`text` 块经 `resolveBlockRenderer(items, "text")` 命中 markdown 的 `MarkdownText`（markdown 的 `plugin.json` 里 `block: "text"`）。

- 调用链全景：`timeline` 的 `BlockRenderer` → `text` 块 → markdown 的 `Markdown` → `MarkdownBody` → `CodeBlock` → puml 的 `PumlCodeBlock`。timeline 与 puml 之间隔着 markdown 一整层，timeline 从头到尾不知道 puml 存在。

- timeline 传 text 块的 props 是 `text` + `streaming`（`block-renderer.tsx` 第 35-36 行 `case "text": return <Comp text={block.text} streaming={pending} />`），`pending = message.pending === true`。这个 `streaming` 一路透传到 puml，是 puml 判断降级的最终来源。

- timeline 的 `PlainBlockFallback` 只兜 `blockRenderers` 槽解析失败（markdown 缺席），与 puml 无关。三层兜底互不重叠：timeline 兜「text 块没人画」，markdown 兜「围栏语言没人认」，puml 兜「认了但画不出（编码失败/服务器失败）」。

- puml 与 timeline 的耦合是「间接、单向、经槽」的：puml 无 `dependsOn`（它不消费任何 channel、不查任何槽，是纯贡献方）。markdown 也不 `dependsOn` puml（槽消费不是 channel 依赖）。puml 对 timeline/markdown 缺席的处理是「回升高亮代码体」，不是报错。

## 8 fileExtensions 文件预览映射（file-preview 消费方）

- puml 的第二个消费方是 file-preview 插件（`src/plugins/project/file-preview/renderer/index.tsx`），消费 `fileExtensions: ["puml", "plantuml", "iuml"]`。file-preview 按扩展名查槽：`resolveCodeBlockRendererByExtension(codeBlockRenderers, getExtension(path))`（第 102 行）。

- 触发：`route === "text"` 才查槽。`.puml`/`.plantuml`/`.iuml` 不在 image/pdf/binary/markdown 任何特殊集合里，落 `text` 路由，然后用 `getExtension(path)`（第 21-25 行，basename 最后点后小写）匹配 `fileExtensions`。

- 命中后：`richRoute = route === "text" && diagramItem ? "diagram" : route`（第 110 行），`DiagramComp != null` 才 `canRenderRich`。最终 `effectiveRoute === "diagram"` 渲染 `<DiagramComp code={content} streaming={false} />`（第 290-298 行），`content` 是 `ctx.fs.readFile(path)` 的全文，`streaming` 恒 false。

- 文件预览与围栏渲染共用 `PumlCodeBlock`、共用降级：`.iuml` 文件内容若服务器渲染失败（离线），`onError` 置 error 走 `SourceFallback`。file-preview 的「看源码」切换（第 194-203 行）让用户能切回带行号的纯文本视图。

- 「映射知识归贡献方」在 puml 上兑现：file-preview 第 90-93 行注释写「图路由 = text 文件的扩展名命中 codeBlockRenderers 槽的 fileExtensions 声明——映射知识归贡献方(与 fileIcons 槽同构),新增图语言不动本插件」。puml 声明 `["puml","plantuml","iuml"]` 三个扩展名，file-preview 不硬编码任何一个。

- 边界：`.iuml` 只参与文件预览、不参与围栏渲染（`languages` 无 `iuml`）。这是刻意的——`iuml` 是 PlantUML 的 `!include` 片段文件惯用名，通常不含 `@startuml`/`@enduml` 包裹，作为文件预览图能渲（PlantUML 服务器接受裸图源码），但作为 markdown 围栏语言不常见，所以不进 `languages`。

## 9 QA

**Q：puml 把 PlantUML 源码发到 plantuml.com 第三方服务器，有隐私/安全风险吗？**

有，且是选型的固有代价。`DEFAULT_SERVER = "https://www.plantuml.com/plantuml"` 是公共服务器，围栏内的图源码会被 `plantumlEncoder.encode` 后拼进 URL 发出去，源码文本离开本机。敏感信息（如架构图里标注的内部系统名）会暴露给第三方。这与 mermaid/graphviz 的本地渲染形成对比——它们是「源码不出本机」，puml 是「源码换图」。离线环境 puml 图直接渲染不出（`onError` 降级源码）。若需自建，改 `DEFAULT_SERVER` 常量重新打包，插件当前不提供运行时配置。

**Q：为什么 puml 用 `<img>` 而不是 `dangerouslySetInnerHTML`？**

因为渲染发生在服务器端，本机只消费服务器返回的图片资源，不是 SVG 字符串。`<img>` 让浏览器只渲图、不执行任何内嵌脚本，天然无 XSS 面，这是「服务端渲染」附带的安全红利——mermaid/graphviz 需要各自论证 `dangerouslySetInnerHTML` 的消毒依据（strict 模式 / graphviz 不产 script），puml 不需要。

**Q：puml 的 `status` 状态机为什么是三态（loading/ok/error），而 mermaid 是两态（svg/failed）？**

因为 puml 多了一个「网络加载」环节。mermaid 的 `mermaid.render` 是同步-ish 的 Promise（本地渲染），结果要么有 SVG 要么抛错，两态够用。puml 的 `<img>` 加载是异步网络事件（`onLoad`/`onError`），需要 `loading` 表示「URL 已构造、图片还没回来」。`url` 为 null（编码失败）时没有 `loading` 的意义，直接降级。所以 puml 的三态精确对应它的三段管线：编码（url 是否 null）→ 加载（loading/ok）→ 失败（error）。

**Q：流式期间 puml 会不会对每个 token 的半成品源码打服务器？**

不会。`if (streaming) return <SourceFallback code={code} />` 在渲染分支里短路，`<img>` 不渲染，浏览器不发起请求。虽然 `useMemo` 仍会为每个 token 的半成品 code 构造 URL（编码成本极低），但不产生网络流量。消息落定后（`streaming` 变 false）才第一次渲染 `<img>` 发起请求，一次成图。这与 mermaid 的「流式期不 import 库」是同一个性能纪律的两个形态。

**Q：第三方插件能覆盖内置 puml 吗？**

能，两条路。其一：声明同 `id: "puml"` 的项，registry 按 `removeById` 整项替换。其二：声明不同 id 但 `languages: ["plantuml"]` 的项，`pickBest` 按「order 小者胜、同 order 数组后者胜」决胜——`builtin < installed < user < project` 的 source 序保证高优先级 source 排后面、同 order 胜出。注意「覆盖」是按 language 逐项竞争的，第三方可以只覆盖 `plantuml` 别名而保留 `puml` 别名归内置（只要第三方只声明 `["plantuml"]`），这是围栏语言级的细粒度覆盖。

**Q：puml 为什么不像 mermaid 那样动态 import？**

因为 `plantuml-encoder` 极小（纯编码函数，deflate + base64，无 DOM/网络依赖），动态 import 拆 chunk 的收益（延迟加载）低于成本（增加一个异步边界、一个 chunk 请求）。mermaid 500KB+、`@viz-js/viz` 1.1MB+（WASM 内联），才值得动态拆；puml 的编码库几 KB，静态 import 进首屏可忽略。这是「按体积决定加载策略」——不是所有兄弟插件都要机械一致，动态 import 是「真遇到图才加载」这个目标的实现手段，对轻依赖不必用。
