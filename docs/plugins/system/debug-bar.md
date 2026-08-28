# debug-bar：标题栏 Debug 按钮与元素审查

debug-bar 是一个只出 UI、不碰任何内核能力的壳插件，全部家当是 `src/plugins/system/debug-bar/` 下一个 `plugin.json`、一个 `renderer/index.tsx`、四份 locale JSON。它往标题栏槽挂一个虫子图标按钮，点开进入"元素审查模式"：全屏 overlay 给每个可见元素画框并标注序号，点某个元素就把它的 `outerHTML` 复制进剪贴板。这个功能的存在理由只有一个——用户跟 AI 说"页面上 #7 那个元素有问题"时，能先自己指认出是哪一个。它自身不声明任何 channel，不贡献任何能力，只消费两样东西：general-config 写进 `general.json` 的 `debugMode` 开关，和 i18n 的语言字典。

## 职责边界

这个插件的职责窄而明确：**标题栏按钮 + 元素审查交互**。它不做的事同样值得写清楚——它不是 DOM 序列化工具，不产出可持久化的诊断报告，不触碰会话数据、文件系统、git，也不订阅任何内核事件流。它唯一读写的数据是剪贴板（`navigator.clipboard.writeText`）和 general-config 的配置项（只读）。因此它的 `plugin.json` 里没有 `permissions` 字段，也不需要——它调用的 `ctx.configFile.get`、`ctx.events.on`、`useTranslation` 全在核心默认能力范围内。

- **开关语义与 general-config 单源**。debug-bar 自己不拥有 `debugMode` 这个键，它只是消费者。`debugMode` 的拥有方是 general-config（其 renderer 里的 bespoke「调试」组写这个键，见 `src/plugins/system/general-config/renderer/index.tsx` 第 95 行 `const debugMode = (config?.["debugMode"] ?? isDev) === true`）。debug-bar 读的是同一份文件 `~/.my-harness-desktop/config/general.json`，经 `GENERAL_CONFIG_PATH` 常量（`packages/shared/src/contract/paths.ts` 第 5 行 `export const GENERAL_CONFIG_PATH = "~/.my-harness-desktop/config/general.json"`）拿到路径。契约单源在这里体现为：键的语义只有一份定义（general-config 的声明），debug-bar 不复制这份定义，只按"显式 boolean 优先、未设置回退 dev 默认"读它。

- **dev 默认不是锁死**。`readDebugMode`（`renderer/index.tsx` 第 76–84 行）的判定是 `typeof c["debugMode"] === "boolean" ? c["debugMode"] : import.meta.env.DEV`。这里有一个被注释点破的历史 bug 修复：早前写法是 `=== true || DEV`，导致 dev 环境下用户显式写 `false` 也压不住，开关形同虚设。现在的写法把"开发环境默认开启"当作默认值而不是强制开关——用户只要在 general-config 里显式关掉 `debugMode`，dev 下按钮也会消失。

- **自我保护与性能上限**。审查模式扫的是 `document.getElementById("root")` 下所有元素（第 98 行），长会话页面 DOM 可能上千节点，全画框会卡死渲染，所以截断在 `MAX_INSPECT_ELEMENTS = 500`（第 21 行）。标注时跳过插件自身，靠 `SELF_ATTR = "data-debug-bar-root"`（第 19 行）这个属性标记——按钮、菜单、overlay 都套上这个属性，扫描时 `el.closest(\`[${SELF_ATTR}]\`)` 直接排除（第 105 行），避免把自己的框也标进审查对象里。

## 目录结构

```
src/plugins/system/debug-bar/
  plugin.json            manifest：titlebar 槽 + languages 槽
  renderer/
    index.tsx            唯一的组件 DebugBar + 全部审查逻辑
  locales/
    zh-CN/debug.json     简体文案
    zh-TW/debug.json     繁体文案
    en/debug.json        英文文案
    de/debug.json        德文文案
```

没有 `core/`、没有 `client/`、没有 `pi-extension/`、没有 `dsh-extension/`。这是一个最典型的"纯 renderer 壳插件"形态：逻辑简单到不需要拆纯函数层，也没有任何内核侧适配需求。四件套（§7.7 的 locales/renderer/pi-extension/dsh-extension）里它只用到前两件，且 locales 只有文案、没有 settings 页面的 i18n key（它自己没有设置页）。

## plugin.json 逐字段

```json
{
  "id": "debug-bar",
  "version": "0.4.9",
  "tier": "official",
  "displayName": "Debug Bar",
  "description": "标题栏 Debug 按钮:复制页面 DOM 到剪贴板,受 general-config 的 debugMode 开关控制",
  "tags": ["dev"],
  "renderer": "./renderer/index.tsx",
  "contributes": {
    "titlebar": [{ "id": "debug-bar", "component": "DebugBar", "order": 100 }],
    "languages": [
      { "id": "debug-bar.debug", "locale": "zh-CN", "resources": "./locales/zh-CN/debug.json" },
      { "id": "debug-bar.debug", "locale": "zh-TW", "resources": "./locales/zh-TW/debug.json" },
      { "id": "debug-bar.debug", "locale": "en", "resources": "./locales/en/debug.json" },
      { "id": "debug-bar.debug", "locale": "de", "resources": "./locales/de/debug.json" }
    ]
  }
}
```

- **`titlebar` 贡献**。`component: "DebugBar"` 是框架按名匹配的组件名——`renderer/index.tsx` 里 `export function DebugBar()`（第 54 行），框架加载 module 后读 manifest 的 `component` 字段去 exports 里找同名组件自动注册，插件不调任何 `registerXxx` 函数（§7.4 组件自动匹配）。`order: 100` 是缺省值，标题栏槽按 order 升序排，100 意味着它排在 titlebar 里靠后（右面板开关的左侧更靠右，见 `contributions.ts` 第 145 行注释）。

- **`languages` 贡献**。四份 locale 各声明一个 `debug-bar.debug` 命名空间资源，`id` 带 `.debug` 子命名空间，与 i18n 插件的主命名空间（`common`/`shell` 等）不撞。这些 key 前缀是 `debug.*`（如 `debug.inspectTitle`、`debug.density.smart`），渲染时 `t("debug.inspectTitle")` 直接可解。

- **`description` 里的偏差**。描述写"复制页面 DOM 到剪贴板"，但当前实现已经演化成"元素审查：点击复制单个元素的 outerHTML"，且 locale 里仍残留 `debug.copyDomTitle`、`debug.area.page`、`debug.simplify`、`debug.areaNotFound`、`debug.copied` 等一批旧功能（"按区域复制 DOM"）的 key，而 renderer 一行都没引用。这是 stale 文案残留，不是功能 bug——描述与现状不一致，收进 QA。

## 渲染与事件流

`DebugBar` 组件的状态机很小，核心是 `debugMode`（是否渲染按钮）、`inspecting`（是否进入审查模式）、`density`（审查粒度）、`boxes`（当前标注的元素框列表）、`hoveredN`（当前悬停元素序号）、`inspectNote`（复制结果提示）这几个 `useState`，外加两个 `useRef`：`elsRef` 存"序号 → Element"映射，`timersRef` 存所有延时器句柄以便卸载统一清理。

- **开关读取链**。`readDebugMode` 是 `useCallback`，`useEffect(() => readDebugMode(), [readDebugMode])`（第 86 行）在挂载时读一次，再 `ctx.events.on("system:settingsChanged", readDebugMode)`（第 89 行）订阅框架系统事件——用户在 general-config 改了 `debugMode` 并保存后，框架广播 `system:settingsChanged`，debug-bar 收到后重读，按钮即时出现或消失。这里不读 `system:configFileSaved` 而读 `system:settingsChanged`，是因为 general-config 的 save 链路广播的是 settings 变更信号（语义是"设置值变了"，比"某个文件落盘了"更贴近"要不要重读开关"）。

- **审查模式生命周期**（第 94–142 行的 `useEffect`，依赖 `[inspecting, density]`）。`inspecting` 变 true 时进入：`collectElements` 从 `#root` 起 `querySelectorAll("*")`，对每个元素做四重过滤——`closest(SELF_ATTR)` 排除自身、`getBoundingClientRect()` 尺寸小于 `MIN_BOX_PX=4` 排除、完全在视口外（`r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth`）排除、`matchesDensity` 按粒度过滤。`matchesDensity`（第 36–42 行）是粒度策略：`all` 全量；`INTERACTIVE_TAGS`（`A/BUTTON/INPUT/TEXTAREA/SELECT/LABEL/H1..H6/IMG/SUMMARY`）或有 `id`/`role`/`aria-label` 的语义元素直接入选；`structure` 额外收 `>= 24px`（`STRUCTURE_MIN_PX`）的大容器。位置用 viewport 坐标（`getBoundingClientRect`），所以滚动/缩放后要重算。

- **滚动/缩放的 rAF 节流重算**。`schedule` 里 `cancelAnimationFrame` + `requestAnimationFrame(recollect)`（第 123–126 行），`window.addEventListener("scroll", schedule, true)` 和 `resize` 都走这个节流——不是逐帧重算，也不是固定 delay，而是下一帧只算一次（§3.6 事件驱动、不 sleep 的具体落地：用 rAF 对齐渲染帧，不用 `setTimeout` 猜时机）。`onKey` 监听 `Escape` 退出（第 127–129 行）。cleanup 移除所有监听、清空 `boxes`/`hoveredN`/`inspectNote`。

- **命中测试与复制**。overlay 的 `onMouseMove` 调 `pickBox(e.clientX, e.clientY)`（第 149–162 行）：遍历 `boxes`，找包含该点且**面积最小**的那个——面积最小即最内层的可标注元素，排除祖先容器干扰。`onOverlayClick`（第 171–193 行）拿 `best.n` 去 `elsRef` 查元素，`navigator.clipboard.writeText(el.outerHTML)` 成功则 `setInspectNote(t("debug.copiedElement", { n }))` 并 `later(exitInspect, 900)` 延时退出；失败则 `t("debug.copyFailed")` + 1500ms 退出。点不到任何元素（落在自身按钮上，已排除标注）或 `elsRef` 查不到时直接退出。

- **定时器统一登记**。`later(fn, ms)` 把 `window.setTimeout` 的句柄 push 进 `timersRef.current`，第 71–74 行的 `useEffect` 在卸载时 `timers.forEach(clearTimeout)`——这是针对 `setState-after-unmount` 泄漏的根因修复，注释里明确写"定时器统一登记,卸载时全部清理"。

## 贡献的槽

- **`titlebar`**（`TitlebarContribution`，`packages/shared/src/domain/contributions.ts` 第 141–147 行）：字段 `id`/`component`/`order`。这是 debug-bar 唯一的"可见挂载点"。壳在右面板开关左侧渲染 titlebar 贡献项，按 order 升序；debug-bar 的 order 100 是缺省，位于更靠右的位置。

- **`languages`**（`LanguageContribution`，第 130–137 行）：字段 `id`/`locale`/`resources`。四份资源各指一个 JSON 文件，`resources` 是相对路径字符串，不是内联对象。

它不贡献 `settings`（没有自己的设置页）、不贡献 `settingsGroups`（`debugMode` 归 general-config 拥有）、不声明 `channels`（`export const channels` 不存在于这个 module）。

## 与其他插件交互

debug-bar 是系统域里依赖最浅的一个，只有两个交互对象，且都是单向消费。

- **依赖 general-config 的 `debugMode` 键**。这是 debug-bar 与另一个插件唯一的"数据依赖"。方向上：general-config 拥有并写 `debugMode`（在 `general.json`），debug-bar 只读。通信介质不是事件（没有自定义 channel），而是**共享配置文件的读** + **框架系统事件 `system:settingsChanged` 的通知**——general-config 保存触发框架广播，debug-bar 订阅重读。这符合"共享 store 只读、要改走框架"的纪律：debug-bar 不改 general-config 的任何东西，它只是跟着开关显隐。

- **依赖 i18n 插件合并的语言字典**。`useTranslation()` 的 `t("debug.*")` 能解析，是因为 i18n 插件在启动时把各插件 `languages` 资源合并进 i18next resources（`src/server/application/i18n/merge.ts`）。debug-bar 不感知合并机制，只调 `t`。语言切换时 `useTranslation` 自动重渲染，无需 debug-bar 订阅任何语言事件。

- **无反向依赖**。没有插件依赖 debug-bar。它不声明 channel，别的插件也就无从 invoke 它；它也不 emit 任何状态。删掉它，标题栏少一个按钮，其余插件无感——这正是"无特权差异"的检验：内置插件可删、可被用户目录同名覆盖。

## 设计取舍：为什么是 overlay + 画框 + 序号

debug-bar 要解决的问题可以拆成两半：**怎么让用户指认一个 DOM 元素**，和**怎么把这个指认变成 AI 能消费的信息**。两半都有更"重"或更"轻"的替代方案，最终落在现在这套 overlay 画框 + 序号 + 复制 outerHTML 上，每一处取舍都有理由。

- **为什么不用 Electron 自带的 DevTools 元素审查**。DevTools（`webContents.openDevTools`）当然能做元素审查，但它是"给开发者看的完整工具"，不是"给 AI 对话用的最小指认工具"。用户要的只是一个序号和一段 outerHTML，DevTools 要的是断点、网络、控制台一整套。更关键的是，DevTools 是壳的机制能力、不是内容——如果 debug-bar 只是个"打开 DevTools"的按钮，那它就没有存在的必要（壳直接给个快捷键就行）。这个插件要承载的是"跟 AI 说 #N"这个内容级交互，DevTools 给不了。所以审查交互作为插件内容存在，而不是壳的机制。

- **为什么点一下复制 outerHTML 而不是复制 selector 或路径**。可选的信息形态有 selector（`div.foo > span.bar`）、XPath、outerHTML 三种。selector/XPath 是"给程序用的定位符"，但用户要把元素描述给 AI 时，AI 最能直接理解的是**结构本身**——`<button class="...">发送</button>` 一粘贴，AI 立刻知道这是哪个按钮、有什么 class、什么文字。selector 反而要 AI 自己去脑补这个元素长什么样。所以复制 outerHTML 是"AI 消费视角"下的正确选择，不是技术便利。

- **为什么 overlay 画框而不是给元素加 inline outline**。两种标注方式：在元素上直接加 `outline`（像 key-hints 的 `.kh-target` 那样），或画一层 fixed overlay 的框。debug-bar 选 overlay 框，因为它要**同时显示序号徽标**且**要可点击命中**——序号要跟着元素定位，overlay 用一个绝对定位的 `<div>` 叠在元素左上角最直接；而点框命中元素又是另一层独立逻辑，不能靠元素自身的 outline 交互。key-hints 用 outline 是因为它只高亮不点击（点击由字母键触发），debug-bar 用 overlay 是因为它要点框本身，两者标注目的的差异决定了实现差异。这里也能看出两个插件没有互相抄袭对方的做法——各自按交互需求选机制。

- **为什么 `pickBox` 取面积最小者**。多个框嵌套时（`<div><button>` 里 button 在 div 内），鼠标点会同时落在两个框里。取"包含该点且面积最小"的框，语义是"最内层的可标注元素"——用户点按钮，要复制的是 button 的 outerHTML 而不是它父容器的。这是命中测试里最小面积启发式的标准做法，代价是内层元素若被 `matchesDensity` 过滤掉（比如 smart 粒度下无 id 无 role 的小 span），点它就会落到父容器——这解释了为什么 `structure` 粒度会多收大容器：给用户一个"点到容器级别"的选择。

- **`elLabel` 的短名约定**。`elLabel(el)`（第 45–52 行）拼 `tag#id.firstClass`（取 className 前两个词）。悬停时提示条显示 `#7 button#send.btn` 这种短名，让用户在点下去之前确认"我要复制的是不是这个"。这是把"序号"和"语义名"双层信息都交给用户：序号是给 AI 的（`#7`），短名是给人眼确认的（`button#send`）。若只有序号，用户点错元素的概率会高很多。

- **`WebkitAppRegion: "no-drag"`**。按钮的 `btnStyle` 里有一条 `// @ts-expect-error Electron 私有 CSS 属性` 注释和 `WebkitAppRegion: "no-drag"`（第 206–207 行）。标题栏在 macOS 是无边框窗口的拖拽区（`-webkit-app-region: drag`），标题栏里的按钮若不标 `no-drag`，点击会被窗口拖拽吃掉、点不中按钮。这是 Electron 无边框窗口的经典坑，debug-bar 作为第一个往 titlebar 挂按钮的插件，把这条经验写在了内联 style 里。它是"渲染层知道运行环境"的一个受控例外——插件不 import electron，但通过 CSS 私有属性声明自己"不可拖拽"，这不算依赖方向违规，因为 CSS 属性是声明不是 import。

## 相关契约与类型落点

- `TitlebarContribution`：`packages/shared/src/domain/contributions.ts:141`
- `LanguageContribution`：`packages/shared/src/domain/contributions.ts:130`
- `GENERAL_CONFIG_PATH`：`packages/shared/src/contract/paths.ts:5`
- `PluginConfigApi`（`ctx.configFile.get` 的形状源头）：`packages/shared/src/domain/context.ts:324`（`configFile` 子对象含 `get`/`append`/`readBinary`/`writeBinary`）
- `PluginEventsApi`（`ctx.events.on` 的形状源头）：`packages/shared/src/domain/context.ts:229`
- 组件自动匹配的框架侧消费：`packages/react/src/plugin-modules.ts`（`getPluginOverlay`/按名匹配 export）

## QA

**Q：dev 环境下我在 general-config 里关掉了 debugMode，为什么重启后 Debug 按钮又回来了？**

A：不是 debug-bar 的 bug，是读链语义——`readDebugMode` 只在 `configFile.get` 读到 `debugMode` 是**显式 boolean** 时才信它，否则回退 `import.meta.env.DEV`。如果你在 general.json 里写的是字符串 `"false"`（手改 JSON 常见错误），`typeof "false" === "boolean"` 为假，会落入 dev 回退分支。解法是写布尔字面量 `false` 而不是字符串。这是"显式 boolean 优先"设计的代价：它治好了"dev 下显式 false 压不住"的旧 bug，但对手改出的类型脏值不免疫。

**Q：审查模式点某个元素没复制成功，提示复制失败，可能是什么原因？**

A：`navigator.clipboard.writeText` 需要安全上下文和剪贴板写入权限。在 Electron renderer 里走的是 Chromium 的 Clipboard API，正常场景（有用户手势触发点击）应该可用；失败常见于无手势上下文、剪贴板被占用、或某些 Linux 环境缺剪贴板服务。代码对失败是有兜底的——`catch` 里 `setInspectNote(t("debug.copyFailed"))` 并 1500ms 退出，不会卡在审查模式。

**Q：为什么长会话页面审查模式里标注的元素编号到 500 就停了？**

A：`MAX_INSPECT_ELEMENTS = 500` 是性能保护。`querySelectorAll("*")` 对上千节点的 DOM 逐个 `getBoundingClientRect` 并画 fixed overlay 框，会把渲染卡死。截断后提示条显示 `debug.inspectTruncated`（"元素过多,仅标注前 {{count}} 个"）。500 是经验值，不是精确上限——真要改，动的是这一行常量，不是渲染逻辑。

**Q：plugin.json 的 description 说"复制页面 DOM 到剪贴板"，但代码是逐个元素审查，locale 里还有 `debug.area.*` 和 `debug.simplify`，这些是什么？**

A：是旧功能的残留。早期 debug-bar 是"按区域（整页/主视图/右面板/左栏）复制 DOM + 可选简化去除 inline style"的形态，后来演化成"元素审查：标注序号、点击复制单个元素 outerHTML"。renderer 已不再引用 `debug.copyDomTitle`/`debug.area.*`/`debug.simplify`/`debug.copied`/`debug.areaNotFound` 这些 key，但 locale 文件和 description 没跟着清理。这是 stale 标注（M 级），不影响运行，下次熵增清理该删掉或更新 description。

**Q：审查模式的 overlay 会不会把自己（按钮、提示条、框）也标进去？**

A：不会，三层防护。扫描时 `closest(\`[${SELF_ATTR}]\`)` 排除所有套 `data-debug-bar-root` 的元素（按钮根、overlay 内提示条）；overlay 的 `pointer-events: none`（框和徽标不拦截鼠标）；提示条自身 `onClick/onMouseMove` 里 `stopPropagation` 防止点提示条触发复制。只有真正命中不到任何目标时（比如点在 overlay 空白处）才退出。
