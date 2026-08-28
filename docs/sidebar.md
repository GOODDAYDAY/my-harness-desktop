# 左侧栏（sidebar）：槽契约、居民与渲染链路

## 1 左侧栏是什么

左侧栏是主界面三栏布局中最左的固定区域，物理上对应布局树里 `id="left"` 的那个 `LayoutGroup`。它的职责只有一句话：**承载"列表与树"**——让用户一眼看清当前工作目录下有哪些会话、哪些最近项目、哪些运行中的子 Agent，并从任意一行点下去切到对应上下文。这是"会话优先"信息架构的空间表达：左栏永远存在，切会话、切目录、进新会话都不改变它的排布。

- 左侧栏**不是一块写死的 UI**，而是壳（shell）预定的一个槽位 `sidebar` 的渲染宿主。壳只提供一个空容器 + 底部"设置"入口这两件 chrome，中间的全部内容由插件贡献。这条边界落在 `src/web/components/sidebar.tsx` 顶部注释里："对话/项目分组都是插件（sidebar 槽）；设置入口是壳的（设置框架是核心）"。
- 它和"布局树里的左组"是两回事：布局树的 `left` 组是一个 `LayoutGroup`，里面只有一个不可关闭的种子视图 `shell:sidebar`；`shell:sidebar` 这个 `ViewInstance` 又经壳组件表解析到 `Sidebar` 组件。真正的 sidebar 槽内容（哪些分组、每个分组画什么）是 `Sidebar` 组件内部再去查 `slots:sidebar` 拉出来的。两层概念，一个在布局层、一个在槽位层。
- 左侧栏的宽度、字体倍率、风格（style）都是壳的 chrome 偏好，不属于任何插件贡献。它们存在 `useUiStore` 里（`sidebarWidth` / `sidebarFontScale` / `sidebarStyle`），落盘到 electron-store prefs（键 `sidebarWidth` / `sidebarFontScale` / `sidebarStyle`）。插件只认内容，不认宽度。

```
主界面布局树（buildDefaultTree，packages/shared/src/domain/layout.ts）
split "root"  direction=horizontal
├─ group "left"   → view "shell:sidebar"      ← 本文主角：Sidebar 组件在此渲染
├─ group "main"   → view "slot:mainView"      ← timeline 插件贡献
└─ group "right"  → view "shell:sidePanel"    ← 右面板（sidePanel 槽的宿主）
```

## 2 槽位契约：SidebarContribution

sidebar 是**数组类槽**——允许多个插件各自贡献一项，壳把它们纵向堆在同一侧栏里。契约定义在圆心 `packages/shared/src/domain/contributions.ts`（110–121 行），这是唯一源，壳加载器按它校验、渲染层按它消费：

```ts
export interface SidebarContribution {
  id: string;        // 贡献项标识，注册表去重靠它
  title: string;     // 分组标题（如 "对话"/"项目"）
  component: string; // renderer 侧组件名，经 registerSidebarComponent 注册后按名查
  order?: number;    // 排序，小的在上；缺省 100
  group?: string;    // 同 group 的贡献项共享一个 Panel；不同 group 各占独立 Panel
}
```

五个字段各自钉死一个语义：

- **`id`**：贡献项在 `ArraySlot` 里的去重键。覆盖语义是 `removeById`——后注册的高优先级 source 清掉同 id 旧项再 push。这意味着把内置居民复制到 `~/.my-harness-desktop/plugins/`（user 级）并保持 `id` 不变，就覆盖内置版；删掉内置居民，壳照常启动，只是少了那块内容。这是"壳插件无特权"纪律在 sidebar 槽上的直接表达。
- **`title`**：分组标题，是**写死的值而非 i18n key**。注意它和 `sidePanel` 槽的 `label`、`fileActions` 槽的 `labelKey` 不同——sidebar 的 `title` 直接进渲染，不经过 `t()`。当前三个内置居民的 title 都是中文原文（"对话"/"项目"/"子 Agent"），这是契约的历史形状，不属于本文要收敛的内容但值得指出。
- **`component`**：renderer 模块里的导出名。框架加载插件 renderer module 后，在 `contributes.sidebar[].component` 里读这个名字，去 module 的 exports 里找同名组件自动注册。插件**不手动调**任何 `registerSidebarComponent` 函数——这是 `plugins-host.ts` → `registerPluginComponents()` 的自动流程。找不到同名导出时 `console.warn` 告警但不崩；壳渲染时 `getSidebarComponent()` 查不到则显示 i18n key `shell.componentNotRegistered` 的兜底文案。
- **`order`**：决定垂直顺序。`sidebarItems()` 按 order 升序排序（缺省 100）。内置居民 projects(5) → sessions-list(10) → sub-agents(20)，就是数字大小，没有别的规则。order 是纯排序契约，不参与 Panel 归并。
- **`group`**：sidebar 槽区别于其它数组类槽的独有字段，见 §5 详述。同 `group` 值的多个贡献项共享同一个 `react-resizable-panels` 的 `Panel`，不同 group 各占独立 Panel；未声明 `group` 时默认按 `id` 各自独立。

契约的挂载点在 `PluginContributes`（`contributions.ts` 413 行）：`sidebar?: SidebarContribution[]`。`SlotName` 联合里 `"sidebar"` 是其中之一（383 行），而 `derivePluginTags`（554–560 行）明确把 sidebar 列为"无语义槽"——不推导 tag（不像 themes→"theme"、languages→"i18n"、settings→"management"），需插件在 `manifest.tags` 显式声明。这条注释直接点明：sidebar 是纯机制挂载点，框架不猜它"属于什么域"。

## 3 谁贡献、谁消费

### 3.1 贡献方：三个 sidebar 居民 + 一个 sessionGroupings 策略方

当前内置有三个插件往 `sidebar` 槽贡献内容（旧文档只记了两个，`sub-agent` 是后来加入的第三个）：

- **`projects`**（`src/plugins/project/projects/plugin.json`）：贡献 `id:"projects"` / `title:"项目"` / `component:"ProjectsSection"` / `order:5` / `group:"main"`。renderer 是 `ProjectsSection`（`src/plugins/project/projects/renderer/index.tsx`），维护最近工作目录清单（存 `ctx.config` 的 `recentCwds`，上限 10 个，dnd-kit 拖拽排序），点项目切目录。
- **`sessions-list`**（`src/plugins/sessions/sessions-list/plugin.json`）：贡献 `id:"sessions"` / `title:"对话"` / `component:"SessionsSection"` / `order:10` / `group:"main"`。renderer 是 `SessionsSection`（`src/plugins/sessions/sessions-list/renderer/index.tsx`），当前工作目录下全部会话的列表：搜索、新建、分组、置顶、归档、运行态/未读标识、子会话嵌套。
- **`sub-agent`**（`src/plugins/sessions/sub-agent/plugin.json`）：贡献 `id:"sub-agents"` / `title:"子 Agent"` / `component:"SubAgentSection"` / `order:20` / `group:"main"`。这个插件同时是 **`sessionGroupings` 槽的贡献方**——它贡献的策略（`parentPathKey:"subagent.parent_session"`）让 sessions-list 把子 Agent 会话嵌套到父会话下。一个插件同时填 sidebar 槽和 sessionGroupings 槽，两个槽的消费方（Sidebar 组件 / sessions-list）分别不认识它，这是双向解耦的样板。

三个居民都声明 `group:"main"`，因此共享同一个 Panel——这正是 §5 要讲的 group 归并语义。sidebar 槽本身**没有**内置的"第零项"或占位内容：壳不贡献任何 sidebar 内容，全由插件填。

### 3.2 消费方：Sidebar 组件（壳）+ sessions-list（插件间）

消费链路是两段的：

- **第一段（壳 → 槽）**：壳的 `Sidebar` 组件（`src/web/components/sidebar.tsx`）是 sidebar 槽的唯一宿主。它调 `window.kernel.slots.sidebar()` 拉贡献项清单，按 `group` 归并、按 `order` 排序，再把每个贡献项解析成插件组件挂进去。它不认识任何具体插件——只认识 `{id,title,component,pluginId,group}` 这个运行时形状。
- **第二段（插件 → 插件）**：sessions-list 是 **`sessionGroupings` 槽的消费方**。它调 `useSessionGroupings()`（`packages/react/src/session-groupings.ts`）拉策略清单，在自己的 `buildGroups` 消费它做父子嵌套。sessions-list 不认识 sub-agent，sub-agent 也不认识 sessions-list——它们的耦合点只有圆心契约 `SessionGroupingContribution` 和会话 `custom` 域里的一个约定 key。

"谁消费"的完整回答是：**shell 的 Sidebar 组件消费 sidebar 槽；sessions-list 插件消费 sessionGroupings 槽**。前者是壳-插件机制面，后者是插件-插件数据面，两者正交。

## 4 渲染链路

从"插件在 manifest 里声明贡献"到"组件画在左栏里"，中间穿过四条链路。下面按数据流顺序拆开。

### 4.1 注册链路（main 进程：manifest → 注册表）

- 加载器发现插件后，`PluginRegistry.registerOne()`（`src/server/application/loader/registry.ts` 136–163 行）把 `manifest.contributes.sidebar[]` 逐项 push 进 `this.sidebar`（一个 `ArraySlot<SidebarContribution>`，85 行）。push 前先 `removeById(item.id)`（156 行）实现覆盖语义；`ArraySlot`（55–72 行）只提供 `push / removeByPlugin / removeById / all` 四个原语，覆盖与卸载都走它。
- 注册序是 `builtin → installed → user → project`（由 bootstrap 决定），后注册者优先级高——同 id 的贡献项，project 级覆盖 user 级、user 覆盖 builtin。这一条是"壳插件无特权"纪律的落地，sidebar 槽不享受任何特殊路径。
- `sessionGroupings` 走同一条通用遍历（`arraySlots` 映射表 107–128 行把 20 个数组类槽列全），`sessionGroupings` 的 `ArraySlot` 字段在 92 行。加一个数组类槽只需在映射表加一行，注册/注销不用逐槽写 for。

### 4.2 IPC 链路（main ↔ renderer：注册表 → 排序清单）

- `src/server/controllers/slots-dialog.ts` 13 行：`gateway.register(IPC.slots.sidebar, () => registry.sidebarItems())`。这是 renderer 能拿到 sidebar 贡献项清单的唯一出口。
- `sidebarItems()`（`registry.ts` 236–248 行）做三件事：map 成 `{id,title,component,pluginId,group?}`（把 pluginId 从 `ArraySlot` 的存储结构里提出来）；按 `order` 升序排；strip 掉 `order` 临时字段（`order` 是排序用，不进最终返回）。
- 通道名契约在 `packages/shared/src/channel/channel-contract.ts` 264 行：`sidebar: "slots:sidebar"`；`sessionGroupings: "slots:sessionGroupings"`（271 行）。renderer 侧 `build-kernel.ts` 102–103 行把 `window.kernel.slots.sidebar()` 桥接到 `transport.invoke(IPC.slots.sidebar)`。
- `sessionGroupingItems()`（`registry.ts` 309–314 行）返回 `SessionGroupingContribution & {pluginId}` 的排序数组，同样按 order 升序。

### 4.3 组件注册链路（renderer：module exports → 组件 Map）

- `plugins-host.ts` 用 `import.meta.glob("../../plugins/*/*/renderer/index.{ts,tsx}")`（4 行）静态发现内置插件的 renderer chunk。`loadBuiltin` / `loadThirdParty` 拿到 module 后调 `registerPluginComponents(mod, manifest.contributes)`（33 / 59 行）。
- `registerPluginComponents`（`packages/react/src/index.ts` 510–530 行）遍历 `["settings","sidePanel","sidebar","mainView","titlebar"]` 五个槽，对 sidebar 读 `contributes.sidebar[].component`，用 `asReactComponent(module[item.component])` 找同名导出，找到就 `registry.set(item.component, comp)` 写进 `sidebarComponents` 这个 `Map<string, ComponentType>`（456 行）。
- 插件只 export 组件、不调任何 register 函数——这就是 CLAUDE.md §7.4"组件自动匹配"。`getSidebarComponent(name)`（466–468 行）是壳渲染时的查询入口。
- 卸载方向对称：`plugins-host.ts` 的 `onUnloaded` 回调调 `unregisterPluginComponents(manifest.contributes)`（132 行），`unregisterPluginComponents`（`index.ts` 532–544 行）把对应 component 名从 Map 里删掉。组件 Map 和贡献项清单是两套注册表——前者在 renderer 内存（`sidebarComponents`），后者在 main 的 `PluginRegistry`，卸载时两边同时清。

### 4.4 挂载链路（布局树 → shell:sidebar → Sidebar 组件）

- `layout-store.ts` 的 `createShellSidebarView()`（185–193 行）造出 `viewId:"shell:sidebar"` / `pluginId:"shell"` / `component:"Sidebar"` / `closable:false` 的 `ViewInstance`，由 `registerShellViews()`（449 行）幂等注册进 `views` 注册表。
- `buildDefaultTree()`（`layout.ts` 294–330 行）把 `shell:sidebar` 放进 `left` 组的 `viewIds`。`LayoutEngine` 递归渲染时，`KeepAliveView`（`layout-engine.tsx` 84–125 行）发现 `pluginId==="shell"`，就查 `shellComponentTable`（67–70 行）——`Sidebar` 映射到 `src/web/components/sidebar.tsx` 导出的 `Sidebar` 组件。
- 关键区别：`shell:sidebar` 是**布局层的壳视图**，它渲染出的是 `Sidebar` 这个**槽宿主**；而 sidebar 槽里的每个居民组件，是 `Sidebar` 组件内部再经 `getSidebarComponent` 查出来的。布局引擎不认识 sidebar 槽，Sidebar 组件不认识布局引擎——两层之间只通过"shell 视图名"这个约定连接。

### 4.5 数据流总图

```
manifest(contributes.sidebar)                     module exports(同名组件)
        │ registerOne                                   │ registerPluginComponents
        ▼                                               ▼
PluginRegistry.sidebar(ArraySlot)   renderer 内存 sidebarComponents(Map)
        │ sidebarItems() 排序                            │ getSidebarComponent
        ▼ (IPC slots:sidebar)                           ▼
window.kernel.slots.sidebar() ◄───── Sidebar 组件 ─────► 居民组件(ProjectsSection/...)
```

```
布局树 left 组 ──► shell:sidebar(ViewInstance) ──► shellComponentTable["Sidebar"] ──► <Sidebar/>
<Sidebar/> 内：window.kernel.slots.sidebar() → items → groupItems → PanelGroup → 每项 getSidebarComponent(component) → 包 PluginIdContext 渲染
```

## 5 分组：group 字段的多贡献共享 Panel

`group` 是 sidebar 槽独有的、区别于其它数组类槽的字段。它的语义在契约注释里一句话钉死："同 group 的贡献项共享一个 Panel（非末项 shrink-0、末项 flex-1 填满剩余空间）；不同 group 或无 group 各占独立 Panel（向后兼容）。"

### 5.1 归并算法（groupItems）

`src/web/components/sidebar.tsx` 38–52 行的 `groupItems(items)` 是归并的唯一实现：

- 遍历已按 order 排好序的贡献项，键取 `item.group ?? item.id`。
- 首次见到某键就建一个 `PanelGroup_`（`{key, items:[]}`）并 push 进结果数组，后续同键项 append 进该组的 `items`。
- 未声明 `group` 的项键退化为自己的 `id`——即**每个无 group 项独占一个 Panel**，这就是"向后兼容"的确切含义。

关键点：归并**不改变组内顺序**。`groupItems` 保持 `items` 的传入序（即 order 升序），所以同 group 内 projects(5) 在 sessions-list(10) 之上、sub-agents(20) 在 sessions-list 之下。group 只决定"谁和谁挤进同一个 Panel"，order 决定"这个 Panel 内部谁上谁下"。

### 5.2 滚动容器的"末项"判定（contentMap + lastVisibleIndex）

`group:"main"` 的三居民共处一个 Panel 后，壳要保证"长列表能吃满剩余高度、短列表只占内容高度"。这不是插件自己算的，是壳的机制：

- `SidebarItemSlot`（58–111 行）给每个居民包一个 div，用 `MutationObserver` 观察它内部有没有真实元素子节点（`el.firstElementChild != null`），把结果写回父组件的 `contentMap`（124 行，`item.id → hasContent`）。渲染 `null` 的项（如没有运行中子 Agent 时的 `SubAgentSection`）被判为"无内容"。
- `Sidebar()` 渲染每个 Panel 时算 `lastVisibleIndex`（155–158 行）：组内最后一个 `contentMap[id] !== false` 的项。这个项拿 `flex-1 min-h-0 overflow-y-auto` 吃满剩余空间当滚动容器，其余项拿 `shrink-0 max-h-[50%] overflow-y-auto` 固定内容高度、超高限一半自己滚。
- 为什么是"最后可见项"而不是"数组末项"：`sidebar.tsx` 顶部注释记录了两次踩坑——sub-agents 曾是末项但渲染 null 时，它占着"末项"名分把滚动容器藏了，导致会话列表被 `max-h` 限一半、下方留白。改成"最后**有内容**的项"后，滚动能力不随贡献项是否为空漂移。MutationObserver 是持续观察的，插件内容从 null 变有（子 Agent 出现）或有变 null（全部结束），滚动容器归属随之移交，不依赖父组件恰好重渲染。

### 5.3 Panel 之间的可拖拽分隔

`PanelGroup direction="vertical"` 把每个 group 渲成一个 `Panel`（161–164 行），相邻 group 之间一条 `PanelResizeHandle`（180–205 行），高 8px、拖拽时变色到 `--color-primary`、`autoSaveId="sidebar-v"` 让 react-resizable-panels 记住比例。三个内置居民都在 `group:"main"`，所以默认只有**一个** Panel、零条分隔线；一旦有人把 group 改成别的值或去掉 group，就会多出一个 Panel 和一条可拖的分隔线。这条 chrome 也是壳的机制，插件不感知。

## 6 sessionGroupings：会话分组策略

`sessionGroupings` 是独立的槽，但它的**唯一消费方是 sidebar 的居民 sessions-list**，所以它和左栏强相关。它的职责是让"子会话"（典型是子 Agent 会话）在会话列表里**嵌套到父会话之下**，而不是平铺成一条独立行。

### 6.1 契约：SessionGroupingContribution

定义在 `packages/shared/src/domain/contributions.ts` 188–199 行：

```ts
export interface SessionGroupingContribution {
  id: string;            // 分组策略 id（插件内唯一）
  parentPathKey: string; // custom 域 key，值=父会话路径（匹配 SessionInfo.path）
  childLabelKey?: string;// 子行 i18n label key（缩进行标题）
  childIcon?: string;    // 子行 lucide 图标名
  order?: number;        // 排序，小的优先；多策略时先匹配 order 小的
}
```

核心是 `parentPathKey`：它是一把**约定 key**，指向会话 `custom` 域里的一个字段。sessions-list 遍历每个会话，如果 `session.custom[parentPathKey]` 是一个非空字符串（父会话路径），就把这个会话归为"子会话"，嵌套到 `parentPathKey` 值对应的父会话下。策略是**纯数据驱动**的——不需要任何函数，条件就是"custom 域里有没有这个 key 且有值"。

### 6.2 贡献方：sub-agent 插件

`src/plugins/sessions/sub-agent/plugin.json` 51–58 行贡献了唯一一条策略：

```json
"sessionGroupings": [
  { "id": "subagent", "parentPathKey": "subagent.parent_session",
    "childLabelKey": "sub-agent.childLabel", "childIcon": "git-fork" }
]
```

sub-agent 编排器在派生子 Agent 时，往子会话的 custom 域**平铺写** `"subagent.parent_session" = <父会话路径>`（`src/plugins/sessions/sub-agent/core/orchestrator.ts` 15 行注释明确说"平铺 subagent.parent_session 键"）。贡献方只负责"写 key + 声明策略"，它完全不认识 sessions-list。

### 6.3 消费链路：hook → 查询 → buildGroups 消费

- `useSessionGroupings()`（`packages/react/src/session-groupings.ts` 9–23 行）是一个 hook：读 `pluginsNonce` 作依赖，`window.kernel.slots.sessionGroupings()` 拉策略清单，模块级 cache 按 nonce 缓存（nonce 变了才重拉）。返回 `SessionGroupingContribution & {pluginId}` 数组。
- sessions-list 在 `SessionsSection` 里调 `const groupings = useSessionGroupings()`（`renderer/index.tsx` 345 行），然后在 `topLevel, childrenByParent` 的 `useMemo`（347–371 行）里消费：

```
对每个 filtered 会话 s：
  若 s.custom 存在，遍历 groupings：
    parentPath = s.custom[g.parentPathKey]
    若 parentPath 是非空字符串 → 记为 ChildSession{session:s, parentPath}，break
```

- `break` 保证多策略时**先匹配 order 小者**（registr 已按 order 排序）。`childrenByParent` 是个 `Map<parentPath, ChildSession[]>`，`topLevel` 是"没被任何策略收编为子会话"的会话。
- 渲染时（547 行），`SessionRow` 收到 `children = childrenByParent.get(s.path)`——父会话行拿到自己的子会话清单，用 `ChildSessionRow`（995–1100 行）嵌套渲染，缩进 32px、带 `git-fork` 图标、可展开/折叠（`pi-collapsible`）。搜索平铺态（`query` 非空）不嵌套，子会话作为独立行出现，避免父子同命中时重复显示。

这条链路的对称性：**sessions-list 不认识 sub-agent（清单来自内核注册表），sub-agent 不认识 sessions-list（只写 custom 域 + 声明策略）**。两者唯一的耦合是圆心契约 `SessionGroupingContribution.parentPathKey` 这个字符串约定。这与 `fileActions`、`composerPolicies` 同属"声明式贡献 + 消费方查槽"的三段式范式（domain 契约 → registry 注册 → renderer hook 查询 → 消费方消费）。

## 7 与 timeline / 右侧栏 / 主题的交互

### 7.1 与 timeline（中区主视图）

sidebar 和 timeline 是布局树里 `left` / `main` 两个并列 group，组件层面零直接引用。它们的协作靠共享 store 的"变更计数器 + 派生状态"：

- **点会话**：sessions-list 的 `select()`（`renderer/index.tsx` 261–290 行）乐观写 `setCurrentSessionPath` / `setCurrentNeutralSessionId` / `setSessionTitle`，再 `openSession(...)`。权威层在 main 侧 `SessionStore.setContext` dispatch 一个 synthetic sessionStart 事件，水合同一字段。timeline 订阅 `useUiStore` 的 `sessionNonce`（`bumpSession`），收到自增后重 resync 会话流。乐观层管点击瞬间高亮，权威层管最终一致性。
- **切目录 / 新会话**：projects 的 `switchCwd`（`projects/renderer/index.tsx` 41–52 行）写 `setCurrentCwd` + 清会话上下文 + `startNewChat` + `bumpSession()`。sessions-list 的 `newSession`（`sessions-list/renderer/index.tsx` 227–232 行）同理。`⌘N`（`app-main.tsx` 145–151 行）也走 `startNewChat`。timeline 是这些变更的最终受益方，但它不 import 任何 sidebar 居民。
- **折叠**：`⌘B`（`app-main.tsx` 119–131 行）切 `left` 组的 `hidden` 标志，`LayoutEngine` 把左组 Panel 缩为 0 宽。折叠时子树不卸载（react-resizable-panels 的 `collapsible` 模式），Sidebar 组件保持挂载、内部状态（如搜索框内容、折叠态）不丢。这是左栏独有的、与 timeline 无涉的 chrome 行为。

### 7.2 与右侧栏（sidePanel）

sidebar 与 sidePanel 是布局树里的对称兄弟（`left` / `right` 组），各自独立折叠（`⌘B` / `⌘J`）。组件层面无直接交互，但存在两个间接关系：

- **同一插件两边填槽**：`sub-agent` 同时往 sidebar（`SubAgentSection`）和 sidePanel（`SubAgentPanel` / `SubAgentDialog`）贡献。`SubAgentSection` 是左栏里"运行中子 Agent"的常驻列表，`SubAgentPanel` 是右面板的 Tab，两者共享同一份子 Agent 编排状态，但各画各的。这是"一个功能一个插件、多槽位铺开"的样板，不是两个插件互相调。
- **sidePanel 的 revealOn 与 sidebar 无关**：`sub-agent` 的 `SubAgentDialog` 贡献声明了 `revealOn:"subagent:dialog"`（`sub-agent/plugin.json` 37 行），该 channel 被 emit/invoke 时框架展开右面板并激活这个 Tab。这是 sidePanel 槽自己的机制，sidebar 不参与，但"子 Agent 对话"这个用户动作同时在左栏（列表高亮）和右栏（Dialog Tab 揭示）两边有反馈。

### 7.3 与主题 / 字体 / 风格的交互

左栏的视觉全走 token，壳不写死任何颜色值或文案值：

- **`data-sidebar-style` 属性 + CSS 选择器块**：`Sidebar` 组件根节点设 `data-sidebar-style={sidebarStyle}`（`sidebar.tsx` 139 行）。`sidebarStyle` 是 `SidebarStyle = StylePresetId`（`"default"|"card"|"minimal"|"outline"|"glass"`，`packages/shared/src/contract/style-presets.ts` 14/17 行）。真正的样式值是 `src/web/index.css` 里 `[data-sidebar-style="card"]` 等选择器块（293 行起）——契约清单（style-presets.ts）只存 id + labelKey，样式值唯一真源在 CSS。预览卡挂同一个 data attribute，与生产同一条 CSS 路径，漂移物理上不可能。
- **`--sidebar-row-*` token 族**：`--sidebar-row-py`、`--sidebar-row-px`、`--sidebar-row-radius`、`--sidebar-icon-size`、`--sidebar-divider-display` 等（`index.css` 273–369 行）由各风格块覆写。居民组件（projects / sessions-list）统一用这些 token 画行（如 `SessionRow` 的 `padding: "var(--sidebar-row-py) var(--sidebar-row-px)"`），换风格只改 CSS 块、插件零改动。
- **背景与边框**：容器 `background: "var(--color-chrome)"`、`border-right: 1px solid var(--color-border)"`（`sidebar.tsx` 140–142 行），`--color-chrome` / `--color-border` 由主题插件贡献（themes 槽），壳只查 token key 不写 token 值。
- **字体倍率**：`--sidebar-font-scale`（prefs 键 `sidebarFontScale`，默认 1.0）由 `theme-context.tsx` 84 行 `root.style.setProperty("--sidebar-font-scale", ...)` 注入根节点，`Sidebar` 容器内联把 `--font-size-{xs,sm,base,lg}-raw` 乘上它算出渲染字号（`sidebar.tsx` 143–147 行）。这是左栏独立的字号缩放，与右面板（`--sidepanel-*`）、timeline（`--timeline-*`）三区独立。
- **多端同步白名单**：`app-main.tsx` 223–228 行的 `SYNCED_PREF_KEYS` 里含 `sidebarStyle` / `sidebarFontScale`，但不含 `sidebarWidth`——左栏风格和字号多端同步，宽度各端独立导航。这是"操作独立、状态同步"边界的精确体现。

## 8 QA

**Q：如果把 sessions-list 的 `group:"main"` 去掉（或改成别的值），左栏会变成什么样？**

projects 和 sub-agents 仍在 `group:"main"` 共享一个 Panel，sessions-list 独占另一个 Panel，中间多一条可拖拽分隔线。两个 Panel 默认各 50% 高度（`autoSaveId="sidebar-v"` 初始均分），用户可拖到任意比例——但 sessions-list 不再自动吃满剩余空间，它和 projects 平权。这正是 `group` 字段"共享 Panel vs 独立 Panel"的语义边界。

**Q：三个居民都在 `group:"main"`，谁当滚动容器？**

按"最后**有内容**的项"判定（`lastVisibleIndex`），不是数组末项。sub-agents(order 20) 是数组末项，但它无运行中子 Agent 时渲染 null、被判"无内容"，滚动容器自动移交到它前面第一个有内容的项（通常是 sessions-list）。这就是 `sidebar.tsx` 里 `contentMap` + `MutationObserver` 存在的全部理由——滚动能力不随贡献项是否为空漂移。

**Q：内置居民被第三方覆盖后，被覆盖的组件还在内存里吗？**

不在。覆盖发生在 main 侧注册表：`registerOne` push 前 `removeById` 清掉同 id 旧项，新贡献项的 component 名进入 `sidebarItems()` 返回清单。renderer 侧 `sidebarComponents` Map 里虽然 `registerPluginModule` 留存了模块引用，但 `getSidebarComponent(旧 component 名)` 已经查不到被覆盖的那个名字——壳渲染的是新贡献项的 component 名。两套注册表（main 的贡献项清单 / renderer 的组件 Map）各自独立，但覆盖后它们指向的是同一个新贡献。

**Q：sidebar 槽没有贡献项时，壳会崩吗？**

不会。`window.kernel.slots.sidebar()` 返回空数组，`groupItems([])` 返回空，`PanelGroup` 里什么也没有，只剩底部"设置"入口。`pluginsNonce` 变化时重拉，可能就有新贡献项了。这是"删掉内置居民壳照常启动"的边界情况。

**Q：sessionGroupings 为什么是独立槽，而不是 sessions-list 自己硬编码"子 Agent 嵌套"？**

因为"子 Agent"是会变的内容，sessions-list 是会长期稳定的列表机制。把"哪类会话该嵌套到父会话下"的**映射知识**推给贡献方（sub-agent 声明 `parentPathKey`），sessions-list 只认"custom 域里有没有这个 key"这个数据驱动的通用规则。将来有第二个需要嵌套的会话类型（比如 goal 的子任务），它贡献一条自己的 sessionGroupings，sessions-list 一行不改。这是"内容外挂、机制留在壳"纪律在插件间协作上的复现。

**Q：projects 和 sessions-list 在同一个 Panel 里，它们怎么协作（比如切目录后刷新会话列表）？**

不直接通信。projects 切目录时写 `useUiStore.setCurrentCwd(dir)` + `startNewChat`，sessions-list 读同一个 `useUiStore` 的 `currentCwd` 和 `useSessionStore` 的 `sessionInfos`（框架统一拉取、事件增量维护）。两个居民各自订阅框架 store，不互读写对方的私有状态——插件间通信只走事件或共享 store 只读，这里走的是后者。同组共享 Panel 只是布局上的相邻，不是数据上的耦合。

**Q：sidebar 的 `title` 为什么是写死的中文原文，而不是 i18n key？**

这是 `SidebarContribution.title` 的历史形状——它直接进渲染，不经过 `t()`。对比 `sidePanel.label`（同样写死）、`fileActions.labelKey`（走 i18n），三者不一致。当前三个内置居民的 title 是中文原文，随语言不变。这是契约层的已知不一致，不属于本文要改的内容，但理解契约时要清楚：`title` 不是文案 key，改了它只改这一处。

**Q：左栏宽度为什么在会话页和设置页共享？**

是产品行为。设置页有它自己的左栏（`settings-page.tsx` 424 行起的 sidebar 预览/列表），用户在任一侧拖宽后切到另一侧应保持一致。实现上两边读同一个 `ui-store.sidebarWidth`，布局引擎在根 split 的 `onLayout` 回写（`layout-engine.tsx` 512–525 行，等值守卫防回环）。宽度是壳的 chrome 偏好，不属于 sidebar 槽——槽只管内容贡献，宽度不是任何插件的贡献。
