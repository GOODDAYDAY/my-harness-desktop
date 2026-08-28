# 文件预览插件（file-preview）

## 职责边界

file-preview 是 `src/plugins/project/` 域下的壳插件，plugin id 为 `file-preview`，版本 `0.4.9`，tier `official`，tags 含 `"project"`。它做一件事：**把项目里的一个文件在主区域打开并呈现**。呈现分两条路——要么用富渲染器（markdown 文本、mermaid/puml/graphviz 图文件），要么回落行号文本视图（纯文本、二进制提示、图片、PDF）。它不拥有任何渲染引擎：markdown 渲染来自 blockRenderers 槽的 `text` 赢家（markdown 插件），图渲染来自 codeBlockRenderers 槽的按扩展名命中（mermaid/puml/graphviz 插件）。它也不拥有文件树的上下文菜单——它只贡献一个 `fileActions` 动作，菜单本身由共享 React widget `packages/react/src/widgets/file-tree.tsx` 渲染。

这个"渲染全部走槽消费、自己不 import 任何渲染引擎"的边界是它最核心的设计点，直接写在 `renderer/index.tsx` 第 90-94 行注释里：富文本渲染全部走槽消费，本插件不 import 任何渲染引擎；markdown 路由 = blockRenderers 槽的 text 赢家；图路由 = text 文件的扩展名命中 codeBlockRenderers 槽的 `fileExtensions` 声明——映射知识归贡献方（与 fileIcons 槽同构），新增图语言不动本插件；槽中无渲染器（插件被禁用）即回落行号文本视图——能力随插件装卸，不炸。

依赖形状：`renderer/index.tsx` 只 import `react`、`react-i18next`、`lucide-react`、`@my-harness-desktop/react`（`usePluginContext`、`Button`、`useBlockRenderers`、`resolveBlockRenderer`、`resolveBlockRendererComponent`、`useCodeBlockRenderers`、`resolveCodeBlockRendererByExtension`、`resolveCodeBlockRendererComponent`、`FileActionInvokePayload` 类型）和 `@my-harness-desktop/shared`（`pathBasename` 纯函数）。没有跨层 import。它声明了 `permissions: ["fs:project"]`——因为它要读项目文件（`ctx.fs.readFile` / `ctx.fs.readFileBase64`），这是壳网关边界（`src/server/controllers/` 的 handler）检查的声明能力。

## 目录结构

插件是纯 desktop 壳插件，四件套里只有 `locales/` + `renderer/` 两件，无 `pi-extension/`、`dsh-extension/`（它不需要给内核补能力）。文件清单：

- `plugin.json`：manifest。声明 id/version/tier/displayName/description/tags/renderer/permissions，以及 `contributes.fileActions`、`contributes.titlebar`、`contributes.languages`。
- `renderer/index.tsx`（326 行）：唯一 renderer 入口。顶部 `export const channels = ["file-preview:fileActionInvoke"] as const` 声明插件拥有的 channel；导出两个组件 `PreviewOpener`（titlebar 槽）和 `FilePreviewView`（由 `layout.openView` 按名打开）；模块级常量 `IMAGE_MIME`、`BINARY_EXTENSIONS`、`MARKDOWN_EXTENSIONS`、`HTML_EXTENSIONS`；纯函数 `getExtension`、`routeOf`；类型 `Route = "image" | "pdf" | "text" | "binary" | "markdown" | "diagram"`。
- `locales/{zh-CN,zh-TW,en,de}/preview.json`：单命名空间 `file-preview.preview`，九个文案 key（`fileAction`、`openInBrowser`、`loading`、`openWithSystemApp`、`tooLargeOrBinary`、`refresh`、`viewSource`、`viewRendered`、`loadFailed`）。

对比 tool-manager，file-preview 没有独立的 `core/` 纯函数层——它的业务逻辑（扩展名→路由、mime 映射、二进制/富文本分类）是简单的查表 + 字符串变换，直接内联在 renderer 顶部的模块级常量和纯函数里，量级不足以独立成层。`getExtension`（第 21-25 行）取 basename 后最后一个点之后的小写串；`routeOf`（第 47-54 行）按 `IMAGE_MIME` → `pdf` → `BINARY_EXTENSIONS` → `MARKDOWN_EXTENSIONS` → 默认 `text` 的顺序判定路由。

## plugin.json 与贡献的槽位

`contributes` 三组贡献，对应圆心 `contributions.ts` 的三个接口：

- `fileActions` 数组（对应 `FileActionContribution`）：一条 `{ id:"previewFile", labelKey:"preview.fileAction", icon:"eye", when:{ target:"file" } }`。`labelKey` 是 i18n key，消费方（文件树 widget）渲染菜单时 `t(labelKey)` 解出文案（`preview.fileAction` = "预览"），菜单文案不进 manifest。`when.target:"file"` 声明这个动作只对文件项生效，对目录不显示。`id` 会在 invoke 的 payload 里原样回传。
- `titlebar` 数组（对应 `TitlebarContribution`）：一条 `{ id:"preview-opener", component:"PreviewOpener", order:90 }`。**这个贡献很特殊**：`PreviewOpener` 组件渲染 `null`（第 76 行 `return null`），它挂到标题栏槽的真实目的是借标题栏这个**常驻挂载点**让它的 `useEffect` 订阅监听器从 app 启动起就存活——详见"fileActions 槽与 invoke 频道"一节。
- `languages` 数组（对应 `LanguageContribution`）：4 条，`file-preview.preview` × 四 locale。

`permissions: ["fs:project"]` 是必需声明：`ctx.fs.readFile`（1MB 上限）和 `ctx.fs.readFileBase64`（25MB 上限）都在 `FsApi`（`sessions.ts` 第 399-419 行）里，属声明能力，网关按 pluginId 检查。`ctx.openFile`（`DialogApi` 第 503-504 行，`shell.openPath`）是用户手势驱动默认放行，但它在 `plugin-context.ts` 第 162 行绑定到 `window.kernel.openFile(path)`——不带 pluginId，是系统级 dialog API。

## 圆心契约：CodeBlockRendererContribution.fileExtensions 与 BlockRendererContribution

file-preview 富渲染的两个槽位契约都在 `packages/shared/src/domain/contributions.ts`。

**`CodeBlockRendererContribution`**（第 307-320 行）是 codeBlockRenderers 槽的贡献项：

```ts
export interface CodeBlockRendererContribution {
  id: string;                    // 同 id 被后注册插件整项替换
  languages: string[];           // 围栏语言名清单(小写比较),如 ["mermaid"]
  fileExtensions?: string[];     // 可被本渲染器预览的文件扩展名(小写,不带点)
  component: string;             // 框架从插件 exports 自动匹配
  order?: number;                // 同语言多项时小者胜;缺省 100
}
```

`fileExtensions` 是 file-preview 专门消费的字段。注释第 312-314 行精确说明了它与 `languages` 的分工："可被本渲染器预览的文件扩展名清单（小写比较，不带点），如 `["mmd","mermaid"]`。消费方（文件预览）按扩展名查槽：命中即图路由；不声明则该语言不参与文件预览。映射知识归贡献方（与 fileIcons 槽同构）——新增图语言不动文件预览。"这句话是整个 file-preview 设计哲学的单点浓缩：**扩展名 → 渲染器 的映射知识，住在贡献渲染器的插件里，不在消费方 file-preview 里**。`languages` 管"围栏代码块里的语言名"（会话流 markdown 里 ` ```mermaid ` 用），`fileExtensions` 管"磁盘上文件的扩展名"（文件预览用），两个字段服务于两个不同消费场景，贡献方各自声明。

**`BlockRendererContribution`**（第 465-477 行）是 blockRenderers 槽的贡献项，file-preview 用它消费 markdown 渲染器：`{ id, block, names?, component, order? }`。file-preview 只查 `block === "text"` 的通用项（`resolveBlockRenderer(blockRenderers, "text")`，不传 name），即 markdown 插件贡献的 `{ id:"text", block:"text", component:"MarkdownText" }`（见 `src/plugins/sessions/markdown/plugin.json`）。`MarkdownText` 组件的 props 契约是 `{ text: string; streaming?: boolean }`，file-preview 以 `streaming={false}` 调用。

两个槽位与 `blockRenderers`/`codeBlockRenderers` 的分工在 `CodeBlockRendererContribution` 注释第 302-304 行有明确定义：blockRenderers 管"整块类型"（text/toolCall/thinking…），codeBlockRenderers 管"文本块内部的围栏语言"（mermaid/puml…）。file-preview 恰好同时消费两者——markdown 是"整块 text"，图文件是"文本块内部的围栏语言"，两个槽各司其职。

## fileActions 槽与 invoke 频道

file-preview 打开预览的触发链路是一条**三段式 fileActions 机制 + 常驻 invoke 监听器**的组合。先看三段式（机制定义在 `packages/react/src/file-actions.ts`）：

1. **声明**：file-preview 在 plugin.json 写 `contributes.fileActions`（`previewFile` 项）。
2. **消费**：共享 widget `packages/react/src/widgets/file-tree.tsx` 第 149 行 `const fileActions = useFileActions()` 查槽，第 455-458 行按 `when.target` 过滤（`data.isDir ? target !== "file" : target !== "dir"`），第 507-515 行渲染进右键菜单，`onSelect` 调 `invokeFileAction(pluginId, a, { path, isDir, cwd })`。
3. **触发**：`invokeFileAction`（file-actions.ts 第 60-68 行）做两件事——先 `revealPluginSidePanel(action.pluginId)`（若有 sidePanel 贡献则浮出，file-preview 无 sidePanel 贡献所以是 no-op），再 `eventBus.invoke(callerId, fileActionInvokeChannel(action.pluginId), payload)`。

`fileActionInvokeChannel(pluginId)`（第 18-20 行）是约定频道生成器：返回 `${pluginId}:fileActionInvoke`。对 file-preview 来说就是 `"file-preview:fileActionInvoke"`。payload 形状 `FileActionInvokePayload`（第 22-27 行）= `{ actionId, path, isDir, cwd }`。

file-preview 侧，`renderer/index.tsx` 第 17 行 `export const channels = ["file-preview:fileActionInvoke"] as const` 声明它**拥有**这个 channel。`PreviewOpener`（第 56-77 行）在 `useEffect` 里 `ctx.events.on("file-preview:fileActionInvoke", handler)` 订阅，handler 读 payload 的 `path` 和 `isDir`，`isDir` 直接 return，否则 `ctx.layout.openView({ viewId: \`file:${p.path}\`, component: "FilePreviewView", title: basename, icon: "file-text", props: { path } })` 打开预览视图。

为什么 `PreviewOpener` 要挂在 `titlebar` 槽而不是做成一个独立的、只渲染一次的入口？因为事件总线的 `invoke` 语义是"无订阅者时入队，首个订阅者挂载时恰好一次投递"（event-bus.ts 第 26-29、131-152 行）——如果监听器只在预览视图打开时才挂载，第一次点击预览就会依赖"入队后等订阅"的兜底时序。把 `PreviewOpener` 挂在常驻的标题栏槽，保证监听器从 app 启动起就存活，invoke 到达时立即投递，不依赖懒挂载的队列冲刷。这是一个"用常驻挂载点保证监听器存活"的惯用法，`return null` 表示它不渲染任何可见 UI，纯作生命周期锚点。

`openView` 的落地在 `packages/react/src/plugin-context.ts` 第 171-178 行——`layout.openView(req)` 调 `useLayoutStore.getState().openView(pluginId, req)`，pluginId 由 PluginIdContext 自动注入，所以 `component: "FilePreviewView"` 会**在本插件自己的 exports 里**按名找组件，不会串到别的插件。这是 §7.4 组件自动匹配 + PluginIdContext 注入在布局系统里的延伸。

## 渲染流：FilePreviewView 的路由与富路由解析

`FilePreviewView`（第 79-326 行）是预览的主体，它的渲染决策分三层：**静态路由**、**槽消费升级为富路由**、**分支渲染**。

**静态路由**由 `routeOf(path)` 决定（第 47-54 行），按扩展名查三张模块级表：`IMAGE_MIME`（png/jpg/jpeg/gif/webp/bmp/avif/ico/svg → `image`）、`pdf` → `pdf`、`BINARY_EXTENSIONS`（zip/gz/tar/…/ttf/woff2 等 38 个 → `binary`）、`MARKDOWN_EXTENSIONS`（md/markdown/mdx → `markdown`）、其余 → `text`。`HTML_EXTENSIONS`（html/htm）单独一张表，不参与路由判定，只决定 header 里是否显示"浏览器打开"按钮——html 预览只有文本视图，不内嵌渲染（安全考量，见 QA）。

**富路由升级**在第 95-114 行的四个 `useMemo` 里完成：

- `MarkdownComp`（第 97-100 行）：`resolveBlockRenderer(blockRenderers, "text")` 拿 markdown 插件的 text 通用项，再 `resolveBlockRendererComponent(item)` 匹配组件。找不到（markdown 插件被禁用）则为 `undefined`。
- `diagramItem`（第 101-104 行）：**仅当 `route === "text"`** 时 `resolveCodeBlockRendererByExtension(codeBlockRenderers, getExtension(path))` 按扩展名查 codeBlockRenderers 槽。这是关键条件——只有被静态路由判定为"纯文本"的文件才尝试图渲染升级，图片/pdf/binary/markdown 不走这条。
- `DiagramComp`（第 105-108 行）：`resolveCodeBlockRendererComponent(diagramItem)` 匹配组件，找不到为 `undefined`。
- `richRoute`（第 110 行）：`route === "text" && diagramItem ? "diagram" : route`——文本文件命中图渲染器就升级为 diagram 路由。
- `isRich`（第 111 行）：`route === "markdown" || richRoute === "diagram"`。`canRenderRich`（第 112 行）：`(route === "markdown" && MarkdownComp != null) || DiagramComp != null`——markdown 路由还需要 MarkdownComp 真的在。
- `effectiveRoute`（第 114 行）：`isRich && (viewMode === "source" || !canRenderRich) ? "text" : richRoute`——"看源码"模式，或富路由但渲染器缺失，都回落到 text。

这四行 useMemo 把"映射知识归贡献方"落成了具体代码：file-preview 不知道 mermaid 是什么，它只知道"有个文本文件，扩展名是 `mmd`，去 codeBlockRenderers 槽问有没有人认领这个扩展名"，认领了就把 `code` 交给它渲染。

**数据读取**（第 116-164 行的 effect）：`route === "binary"` 直接 `setLoading(false)` 短路（不读文件）；text/markdown 走 `ctx.fs.readFile(path)` 读文本；image 走 `ctx.fs.readFileBase64(path)` 拼 data URI（`data:${IMAGE_MIME[ext]};base64,${b64}`）；pdf 走 base64 → `atob` → `Uint8Array` → `URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }))`。effect 用 `alive` 标志 + cleanup 里 `URL.revokeObjectURL` 处理异步竞态和 blob 泄漏。`tick` state 提供"刷新"能力，`setTick(t => t+1)` 触发 effect 重跑。

**分支渲染**（第 220-325 行）按优先级：loading → 二进制/error → image → pdf → `effectiveRoute === "markdown"`（`<MarkdownComp text={content} streaming={false} />`）→ `effectiveRoute === "diagram"`（`<DiagramComp code={content} streaming={false} />`）→ 兜底行号文本视图（`content.split(/\r?\n/)` 逐行渲染行号 + 文本，`contentVisibility: "auto"` 虚拟化，gutter 宽度按 `Math.max(lines.length, 1)` 的位数算）。

## code-block-renderers.ts：三段式机制

`packages/react/src/code-block-renderers.ts`（74 行）是 codeBlockRenderers 槽的 renderer 侧机制，file-preview 消费它的三个函数。文件头注释点明它是三段式（镜像 block-renderers.ts）：① 声明在 plugin.json；② 消费经 `useCodeBlockRenderers()` 查槽（pluginsNonce 失效重拉）；③ 渲染经 `resolveCodeBlockRenderer`（按语言）/`resolveCodeBlockRendererByExtension`（按扩展名）+ `resolveCodeBlockRendererComponent` 匹配插件 exports。

- `useCodeBlockRenderers()`（第 19-33 行）：读 `useUiStore` 的 `pluginsNonce`，同 nonce 单发缓存（模块级 `cache = { nonce, data }`），失效重拉 `window.kernel.slots.codeBlockRenderers()`。返回 `CodeBlockRendererItem[]`（= `CodeBlockRendererContribution & { pluginId }`）。
- `resolveCodeBlockRenderer(items, language)`（第 37-46 行）：按围栏语言解析，`language.toLowerCase()` 与各贡献项的 `languages` 逐一比对，命中项走 `pickBest`。
- `resolveCodeBlockRendererByExtension(items, extension)`（第 50-59 行）：file-preview 用的就是这个——`extension.toLowerCase()` 与各贡献项的 `fileExtensions` 比对，命中项走 `pickBest`。
- `pickBest(matched)`（第 61-66 行）：`order` 小者胜，同 order 取数组后者（items 保注册序，后注册 = 高优先级 source）——第三方插件可单语言/单扩展名覆盖内置。
- `resolveCodeBlockRendererComponent(item)`（第 70-74 行）：`asReactComponent(getPluginComponent(item.pluginId, item.component))`，拿不到返回 `undefined`——消费方落兜底（源码呈现）。

"同 order 后注册者胜"这条规则和 `resolveBlockRenderer`（block-renderers.ts 第 39-54 行）一致，是整个槽位优先级体系（§10 QA 的 builtin<installed<user<project 四级来源）在 renderer 侧的落点。

## 与其他插件的交互（专节）

file-preview 是一个**高协作度、零 `dependsOn`** 的插件。它协作的对象分三类，逐一钉死槽位名/channel 名/消费方向：

**作为 fileActions 贡献者，被共享 widget file-tree 消费**：

- file-preview **贡献** `fileActions` 槽（`previewFile` 项，`when.target: "file"`）。
- 消费方是 `packages/react/src/widgets/file-tree.tsx`（共享 React widget，被 `src/plugins/project/file-tree` 壳插件嵌入），它 `useFileActions()` 查槽、渲染右键菜单、`invokeFileAction` 触发。
- channel 名：`file-preview:fileActionInvoke`（由 `fileActionInvokeChannel("file-preview")` 生成，file-preview 在 `channels` export 里声明拥有它）。
- file-preview **不声明 `dependsOn`**——它不消费别人的 channel（file-tree 调它，不是它调 file-tree），它消费的两个槽位（blockRenderers、codeBlockRenderers）是框架槽位查询不是事件 channel，槽位查询走 `window.kernel.slots.*` IPC 而非事件总线，所以 dependsOn 的"生命周期护栏"对它不适用。这是正确用法：dependsOn 只管"我 on/invoke 了别人的 channel"这一种情况，查槽不算。

**作为 blockRenderers 槽消费者，消费 markdown 插件**：

- markdown 插件（`src/plugins/sessions/markdown/plugin.json`）贡献 `blockRenderers` 的 `{ id:"text", block:"text", component:"MarkdownText" }`。
- file-preview 经 `useBlockRenderers()` + `resolveBlockRenderer(blockRenderers, "text")` 拿到它，`resolveBlockRendererComponent` 匹配 `MarkdownText` 组件。
- 槽位名：`blockRenderers`。没有 channel。file-preview 不认识"markdown 插件"这个名字，它只认"text 块的赢家是谁"。

**作为 codeBlockRenderers 槽消费者，消费 mermaid/puml/graphviz 的 `fileExtensions`**：

这是文档重点要求展开的消费关系。三个图插件都在 `src/plugins/sessions/` 下，各自贡献一条 `codeBlockRenderers`：

- mermaid（`src/plugins/sessions/mermaid/plugin.json` 第 11 行）：`{ id:"mermaid", languages:["mermaid"], fileExtensions:["mmd","mermaid"], component:"MermaidCodeBlock" }`——本地渲染，动态 import mermaid。
- puml（`src/plugins/sessions/puml/plugin.json` 第 11 行）：`{ id:"puml", languages:["puml","plantuml"], fileExtensions:["puml","plantuml","iuml"], component:"PumlCodeBlock" }`——plantuml-encoder + server 端点。
- graphviz（`src/plugins/sessions/graphviz/plugin.json` 第 11 行）：`{ id:"graphviz", languages:["dot","graphviz","gv"], fileExtensions:["dot","gv"], component:"GraphvizCodeBlock" }`——本地 WASM 渲染。

file-preview 与它们的关系是**单向消费 + 完全解耦**：file-preview 经 `resolveCodeBlockRendererByExtension(codeBlockRenderers, getExtension(path))` 问"谁认领 `mmd` 这个扩展名"，mermaid 认领了就拿到 `MermaidCodeBlock`，把 `code` 传进去渲染。file-preview 的代码里**没有 mermaid/puml/graphviz 任何一个字符串字面量**（`renderer/index.tsx` 全文无 "mermaid"/"puml"/"graphviz" 字样），它连这三个插件存在都不知道。新增第四个图语言（比如 svgbob、ditaa）时，只需新插件贡献一条带 `fileExtensions` 的 `codeBlockRenderers`，file-preview 一行不改。

值得注意的是 file-tree 插件还有一条**平行的 fileIcons 贡献**（`src/plugins/project/file-tree/plugin.json` 第 39 行）：`{ id:"diagram", icon:"workflow", color:"#7c3aed", extensions:["puml","plantuml","iuml","mmd","mermaid"] }`。这是 fileIcons 槽的"扩展名→图标"映射，与 codeBlockRenderers 槽的"扩展名→渲染器"映射是**两个不同槽、两份独立知识**，file-preview 只消费后者。这印证了 `CodeBlockRendererContribution.fileExtensions` 注释里"映射知识归贡献方（与 fileIcons 槽同构）"的措辞——两个槽都采用"贡献方声明扩展名、消费方查槽"的同构模式，但互不依赖。

**与壳/内核的交互**（非插件间）：

- `ctx.fs.readFile` / `ctx.fs.readFileBase64`（声明能力 `fs:project`）读文件，圈禁在项目根（`assertProjectPath`）。
- `ctx.openFile`（用户手势驱动）用系统默认应用打开文件——二进制文件、"浏览器打开" html、"用系统应用打开"的兜底按钮都走它。
- `ctx.layout.openView` 打开预览视图（布局系统）。
- `ctx.events.on` 订阅自己的 invoke channel（事件总线）。

**槽位名清单**：贡献 `fileActions`、`titlebar`、`languages`；消费 `blockRenderers`（text）、`codeBlockRenderers`（fileExtensions）。**channel 清单**：拥有并订阅 `file-preview:fileActionInvoke`（invoke 目标）。**dependsOn 清单**：无（不消费任何人的 channel，只查框架槽位）。

## QA

**Q：为什么 `PreviewOpener` 挂在 titlebar 槽却 `return null`？**

因为 titlebar 是壳 chrome 的常驻挂载点，把订阅监听器放进一个常驻组件的 `useEffect`，能保证 `file-preview:fileActionInvoke` 的订阅从 app 启动起就存活。如果监听器只在预览视图打开时才挂载，第一次点击"预览"就依赖事件总线 invoke 的"无订阅者入队、首个订阅者挂载时投递"兜底时序（event-bus.ts 第 26-29 行）。常驻挂载消除了这个时序依赖。`return null` 表示它不渲染可见 UI，纯作生命周期锚点——titlebar 槽贡献一个"隐形按钮"是合法的，因为槽契约只要求"有一个 component 被挂载"，不要求它一定渲染可见内容。

**Q：为什么图文件走 `text` 路由再查 codeBlockRenderers，而不是直接写死 mermaid/puml？**

这是"映射知识归贡献方"的纪律。如果 file-preview 里写 `if (ext === "mmd") render Mermaid`，那新增一个图语言就要改 file-preview——违反"会变的内容推出去"。正确做法是 file-preview 只认一个稳定动作："文本文件 → 按扩展名问 codeBlockRenderers 槽谁认领"。扩展名→渲染器的映射住在贡献渲染器的插件 manifest 里，新增图语言 = 新插件贡献一条 `fileExtensions`，file-preview 零改动。`renderer/index.tsx` 全文无 mermaid/puml/graphviz 字面量，是这条纪律的实证。

**Q：`languages` 和 `fileExtensions` 两个字段有什么区别？**

它们服务于两个不同的消费场景。`languages` 是围栏语言名，给会话流 markdown 文本渲染器用——markdown 插件遇到 ` ```mermaid ` 围栏块时，经 `resolveCodeBlockRenderer(items, "mermaid")` 按语言查渲染器。`fileExtensions` 是磁盘文件扩展名，给文件预览用——file-preview 打开 `foo.mmd` 时，经 `resolveCodeBlockRendererByExtension(items, "mmd")` 按扩展名查渲染器。一个贡献方可以只声明 `languages`（只参与会话流围栏渲染，不参与文件预览），也可以两者都声明（mermaid/puml/graphviz 就是两者都声明，所以它们的图既能从会话流围栏渲染，也能从磁盘文件预览）。`fileExtensions` 不声明 = 该语言不参与文件预览。

**Q：渲染器插件被禁用时，预览会怎样？**

回落行号文本视图，不炸。`resolveCodeBlockRendererComponent` / `resolveBlockRendererComponent` 拿不到组件时返回 `undefined`，于是 `canRenderRich` 为 false，`effectiveRoute` 强制回落 `text`，走到第 301-325 行的行号文本兜底。markdown 路由同理——`MarkdownComp` 为 `undefined` 时，即使 `route === "markdown"` 也回落文本视图。这就是注释第 94 行说的"能力随插件装卸，不炸"：渲染器是可选增强，缺了它预览仍能给出原始内容，只是没有富渲染。

**Q：为什么 markdown 走 blockRenderers 的 `text`，而不是 codeBlockRenderers？**

因为两者管的是不同粒度的东西。`CodeBlockRendererContribution` 注释第 302-304 行定义的分工：blockRenderers 管"整块类型"（text/toolCall/thinking…），codeBlockRenderers 管"文本块内部的围栏语言"（mermaid/puml…）。markdown 是整个文件作为一个 `text` 块交给 markdown 渲染器（`MarkdownText` 组件把整个文件当 GFM 渲染，文件里的围栏代码块再由 markdown 组件内部经 codeBlockRenderers 二次分发），所以文件级的 markdown 走 blockRenderers；而一个 `.mmd` 文件是"整个文件就是一段 mermaid 源码"，没有 markdown 外壳，所以直接走 codeBlockRenderers 的 `fileExtensions` 查图渲染器。两条路不冲突、不重叠。

**Q：html/htm 文件为什么只给文本视图 + "浏览器打开"按钮，不内嵌渲染？**

安全 + 隔离。`HTML_EXTENSIONS`（第 43 行）的注释说明：html/htm 预览只有文本视图，浏览器打开按钮（`openPath` 按系统关联交给默认浏览器）走这里；链接点击类场景由内核 `setWindowOpenHandler` 统一拦截交系统（见 bootstrap/index.ts）。在内嵌 webview 里渲染任意 html 会引入脚本执行面（本地文件里的 script 可能访问 shell 能力），所以 file-preview 只把 html 当纯文本展示，需要真实渲染时交给系统默认浏览器——把会变的、有安全风险的内容渲染推到系统层，file-preview 只保留"读文本 + 打开系统应用"两个中性动作。
