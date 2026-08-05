# 004 左侧栏：sidebar 槽与它的住户

## 1 问题与目标

pi-desktop 的左侧栏是主界面的第一个固定区域。它的职责是承载"列表和树"——用户一眼看清当前工作目录下有哪些会话、有哪些项目，从一个列表项上点下去就切到对应上下文。这是"会话优先"（conversation-first）信息架构的物理表达：左侧栏永远存在、进入新会话不改变它的排布。

实现上，左侧栏不做任何硬编码的业务内容——它是内核预定的一个槽位（slot），壳只提供一个空的纵向面板组容器，具体内容由插件贡献。这意味着换掉所有插件（或加一个第三方插件），壳一行不动；删掉某个居民插件，槽位空着但不崩。

本文回答三个问题：sidebar 槽的契约长什么样、壳怎么把它渲染成可用的左侧栏、以及目前哪些插件住在这个槽里、它们怎么共处一栏。

## 2 契约：SidebarContribution

sidebar 是数组类槽——允许多个插件各自贡献一项，壳把它们堆在同一侧栏里。契约定义在圆心 `src/core/domain/contributions.ts`（第 65 行）：

```ts
interface SidebarContribution {
  id: string;       // 贡献项标识,注册表去重靠它
  title: string;    // 分组标题(如 "对话"/"项目")
  component: string;// renderer 侧组件名,框架从 module exports 自动匹配
  order?: number;   // 排序,小的在上;缺省 100
  group?: string;   // 同 group 的项共享一个 Panel,不同 group 各占独立 Panel
}
```

四个要点：

**component 自动匹配**。插件在 `plugin.json` 的 `contributes.sidebar[]` 里声明 `component` 字段，框架加载插件 renderer module 后在 exports 里找同名组件，自动注册。插件不手动调任何 `registerSidebarComponent` 函数——这是 `plugins-host.ts` → `registerPluginComponents()` 的自动流程。如果 module exports 找不到同名组件，框架 console.warn 告警但不崩溃；壳渲染时如果 `getSidebarComponent()` 查不到，显示 i18n key `shell.componentNotRegistered` 的兜底文案。

**order 决定垂直顺序**。壳把 registry 返回的贡献项按 `order` 升序排列（缺省 100）。内置居民 projects（order: 5）在 sessions-list（order: 10）上面——没有其它规则，就是数字大小。

**group 决定 Panel 归并**。这是 sidebar 槽区别于其它数组类槽的独有字段。同 `group` 值（或同 `id`，当 `group` 未声明时默认按 `id` 分组）的多个贡献项共享同一个 react-resizable-panels 的 Panel，垂直堆叠在同一折叠区域内。没有 `group` 字段的项各占独立 Panel。默认内置的两个居民都声明 `group: "main"`，所以它们塞在同一个 Panel 里——projects 在上（非末项 `shrink-0`）、sessions-list 在下（末项 `flex-1 min-h-0 overflow-y-auto` 填满剩余空间）。如果再加一个第三方贡献项且也声明 `group: "main"`，它夹在中间（也是 `shrink-0`），sessions-list 始终是末项独占可用空间。

**无特权差异**。`ArraySlot` 容器的注册逻辑是：bootstrap 按 `builtin → installed → user → project` 的顺序注册插件，每次 `push` 前先 `removeById`（按 `contribution.id` 去重），后注册的高优先级 source 覆盖低优先级同名贡献项（`src/core/application/loader/registry.ts` 第 46–63 行）。这意味着一件事：把一个和内置插件同 `id` 的贡献项丢到 `~/.pi-desktop/plugins/` 目录下，它覆盖内置版。删掉内置居民，壳照常启动——侧栏剩下空 Panel 或只剩另一个居民。

## 3 壳：Sidebar 组件

壳组件 `src/api/renderer/components/sidebar.tsx`（第 46 行的 `Sidebar` 函数）是纯机制，不包含任何写死的文案或业务逻辑。它的工作可以拆成四步：

### 3.1 拉贡献项

```tsx
const pluginsNonce = useUiStore((s) => s.pluginsNonce);
const [items, setItems] = useState<SidebarItem[]>([]);

useEffect(() => {
  void window.pi.slots.sidebar().then(setItems);
}, [pluginsNonce]);
```

IPC 通道是 `slots:sidebar`（`src/api/preload/ipc-channels.ts` 第 194 行），背后是 main 进程 `PluginRegistry.sidebarItems()` 按 order 排序后的数组返回。`pluginsNonce` 是 ui-store 里的一个变更计数器——插件启用、停用、安装、卸载都会 bump——组件只在 nonce 变化时重拉，不轮询。

### 3.2 分组映射

`groupItems()` 函数（第 30 行）把贡献项按 `group` 字段（fallback 到 `item.id`）归并成 `PanelGroup_[]`——每个 group 是一个带 `key` 和 `items[]` 的结构。

### 3.3 纵向 PanelGroup 渲染

壳用 `react-resizable-panels` 的 `PanelGroup direction="vertical"` 纵向堆叠每个 group（第 76 行）。每个 group 是一个 `Panel`，内部垂直排列该组的贡献项组件（第 86–106 行）：

- 同组内**非末项**：容器 `shrink-0`，高度由内容撑开，内部自带滚动（插件自己的 overflow-y 属性）。
- 同组内**末项**：容器 `flex-1 min-h-0 overflow-y-auto`，填满 Panel 剩余空间——sessions-list 长列表靠这个拿到最大可用高度。
- 组件来自 `getSidebarComponent(item.component)`（`packages/react/src/index.ts` 第 367 行），从一个 `Map<string, ComponentType>` 的 `sidebarComponents` 注册表中按组件名查找。
- 每个组件用 `<PluginIdContext.Provider value={item.pluginId}>` 包裹——pluginId 由此注入，`usePluginContext()` 无参调用就能拿到绑定后的上下文。

**两个 group 之间**有一条 `PanelResizeHandle`（第 108–133 行），高 8px，拖拽时变色到 primary——用户可以调整各组的高度比例，和整个布局引擎的拖拽行为一致。`autoSaveId="sidebar-v"` 让 react-resizable-panels 记住比例。

### 3.4 底部设置入口

PanelGroup 下方是一个固定的底部条（第 140 行）：一个 `ChatRow` 组件带 `Settings` 图标，配 i18n key `shell.settings`（中文"设置"），点击调 `useUiStore` 的 `setActiveView("settings")` 切换到设置页。

这个入口是壳的固定 chrome——不属于任何插件的贡献。它和 settings 槽的覆盖层是同一套机制的上下两级：底部的齿轮是入口，点击后 `App` 里 `activeView === "settings"` 让 settings 覆盖层 `visibility: visible` 盖住整个 `ChatView`（`src/api/renderer/index.tsx` 第 133 行注释："保住 ChatView 布局与 virtuoso 滚动位置，切回零重排"）。

### 3.5 空态与边界

sidebar 槽没有贡献项时，壳照样渲染——`items` 是空数组，`panelGroups` 也是空，PanelGroup 里什么也没有，只剩底部的设置入口。不会崩溃、不会占位错误，`pluginsNonce` 变化时下次重拉可能就有新贡献项了。

贡献项的组件在注册表中查不到时（`Comp` 为 undefined），显示兜底文本：`shell.componentNotRegistered`（中文类似"组件 XXX（插件 YYY）未注册"）。这个 i18n key 是壳的，不是插件的——壳负责告知用户"这里缺了什么"。

### 3.6 主题与样式

壳读取 `useUiStore` 的 `sidebarStyle` 并在容器上设 `data-sidebar-style` 属性——主题组件可以通过 CSS 属性选择器 `[data-sidebar-style="..."]` 切换不同的侧栏视觉风格。字体尺寸通过 CSS 变量 `--sidebar-font-scale` 缩放：基础字体大小 `--font-size-{xs,sm,base,lg}-raw` 乘以 scale 因子生成渲染值。这允许用户在设置页独立调节左侧栏的字号大小（`src/api/ipc/main-context.ts` 第 25 行的 `sidebarFontScale`，默认 1.0）。

## 4 住户

当前有两个内置插件住在 sidebar 槽里：

### 4.1 projects（order: 5, group: "main"）

**manifest**：`src/plugins/project/projects/plugin.json`，contributions.sidebar 声明 `id: "projects"`, `title: "项目"`, `component: "ProjectsSection"`, `order: 5`, `group: "main"`。

**做什么**：维护一个最近打开的工作目录列表（最多 10 个），持久化在 `ctx.config.get/set("recentCwds")` 里。支持拖拽排序（@dnd-kit），点项目直接切目录。详见 `docs/plugins/projects.md`。

**和壳的关系**：projects 切目录时写 `useUiStore.setCurrentCwd(dir)`——这个广播被 sessions-list（同组内另一个组件）读走，触发会话列表重拉。两个同组插件不直接通信，通过共享 store 间接协作。

### 4.2 sessions-list（order: 10, group: "main"）

**manifest**：`src/plugins/sessions/sessions-list/plugin.json`，contributions.sidebar 声明 `id: "sessions"`, `title: "对话"`, `component: "SessionsSection"`, `order: 10`, `group: "main"`。

**做什么**：当前工作目录下所有 AI 会话的列表——分组（置顶/时间四档/归档）、搜索、新建、重命名、置顶/归档、运行中与未读状态标识。详见 `docs/plugins/sessions-list.md`。

**和壳的关系**：sessions-list 是 sidebar 槽里唯一需要"全部剩余空间"的居民——长列表必须能滚动。壳通过末项 `flex-1 min-h-0 overflow-y-auto` 给它这个能力，这是壳做出来的约定，不是 sessions-list 自己算出来的。

### 4.3 共处一栏

两个插件都声明 `group: "main"`，它们共享同一个 Panel。壳的渲染逻辑保证了三个行为：

- projects 在上（order 5）、sessions-list 在下（order 10），由 `sidebarItems()` 按 order 排序保证。
- projects 高度撑内容（`shrink-0`）、sessions-list 吃满剩余高度（`flex-1`），由壳的末项判定保证——不管加多少个同 group 贡献项，只要 sessions-list 的 order 最大，它永远是末项、永远吃满剩余高度。
- 两个组件的依赖隔离：各自的 `usePluginContext()` 拿到各自的 pluginId（"projects" / "sessions-list"），各自调 `ctx.config` 写各自的私有数据，壳没有共享状态交叉污染。

## 5 在布局树中的位置

动态布局引擎 `docs/design/dynamic-layout.md` 把主页面建模为一棵递归 split/group 树。sidebar 在这棵树里的位置是固定的：

```
split "root" horizontal
├─ group "left"  → view "shell:sidebar"
├─ group "main"  → view "slot:mainView"
└─ group "right" → view "shell:sidePanel"
```

`shell:sidebar` 是框架在启动时注册的内建视图（`ViewInstance`），`closable: false`，`pluginId: "shell"`。它在 `shellComponentTable` 里映射到实际的 `Sidebar` 组件（`src/api/renderer/components/layout-engine.tsx` 第 67–69 行）。

三个关键行为：

**折叠**：`⌘B`（macOS）切换 `left` 组的 `hidden` 标志。hidden 为 true 时，父 split 把 left 组的 Panel 尺寸归零——现有 react-resizable-panels 的 `collapsible` 模式下不会卸载子树，所以 Sidebar 组件保持挂载、内部状态不丢（`docs/design/dynamic-layout.md` §2.3）。

**宽度**：`sidebarWidth` 偏好（`src/api/ipc/main-context.ts` 第 24 行，默认 240px）从 `ui-store` 的 `sidebarWidth` 读取。设置页拖拽自己左侧栏时写 `setSidebarWidth`，引擎同步到 split 的 `sizes[0]`（第 520 行）——两页的左侧栏宽度共享同一偏好（`docs/design/dynamic-layout.md` §2.3"宽度"一节）。

**动画**：折叠/展开时挂 transition，拖拽分屏 handle 时不挂——和原 `ChatView` 行为一致（1:1 跟手），`hidden` 变化路径和 `onLayout` 拖拽路径按组分开处理。

## 6 第三方插件接入

给侧栏加自己的分组只需要两步：

**第一步：写 manifest**。在自己的 `plugin.json` 里加 contributes.sidebar：

```json
{
  "id": "my-sidebar-plugin",
  "contributes": {
    "sidebar": [
      {
        "id": "my-section",
        "title": "我的分组",
        "component": "MySection",
        "order": 20,
        "group": "main"
      }
    ]
  }
}
```

- `id` 用于注册表去重——和已有居民同名则覆盖。
- `component` 是 renderer module 的 export 名，框架自动匹配。
- `group` 选 `"main"` 表示和 projects / sessions-list 同 Panel；不声明则独占一个 Panel。

**第二步：写 renderer**。export 同名组件：

```tsx
import { usePluginContext } from "@pi-desktop/react";

export function MySection() {
  const ctx = usePluginContext();
  // ctx.config、ctx.sessions、ctx.events 等能力全部可用
  return <div>我的侧栏内容</div>;
}
```

不需要手动注册、不需要传 pluginId——框架全自动。`order: 20` 意味着它排在 projects (5) 和 sessions-list (10) 之后——在同 group 的 Panel 里，它是第三项（`shrink-0`），不会抢占 sessions-list 的剩余空间。

## 7 QA

**Q：如果把 sessions-list 的 group 去掉了（或改成别的值），侧栏会变成什么样？**

projects 独占自己的 Panel，sessions-list 独占另一个 Panel，中间多一条可拖拽的分隔线。两个 Panel 各 50% 高度（react-resizable-panels 的 `autoSaveId="sidebar-v"` 初始缺省均分）。用户可以把分隔线拖到任意比例——但 sessions-list 不再自动吃满剩余空间，它和 projects 是平权的两个面板。

**Q：内置居民被第三方覆盖后，被覆盖的组件是不是还在内存里？**

不在。覆盖语义是 `removeById`（注册表清掉同 id 旧项）+ `push`（新项入队），旧贡献项的组件引用已被移出注册表——即使插件模块仍在 renderer 中（`registerPluginModule` 留存了），`getSidebarComponent` 也查不到它，因为注册表里只有新贡献项的 component 名。

**Q：怎么验证一个贡献项真的会被覆盖？**

把目标插件的目录拷贝到 `~/.pi-desktop/plugins/`（用户级），保持 `id` 一样、改 `component` 名指向另一个组件。启动应用，打开 DevTools → `window.pi.slots.sidebar()` 在 console 执行——返回的数组里该 `id` 的 `component` 已经是覆盖后的值。同时侧栏渲染的是覆盖后的组件。

**Q：侧栏的宽度偏好为什么跨页面共享？**

是产品行为：设置页有它自己的左侧栏（`src/api/renderer/components/settings-page.tsx` 第 94 行的 `setSidebarWidth`），用户在该页拖拽左栏宽度后切回对话页，宽度应保持一致。实现上两边读同一个 `ui-store.sidebarWidth`，布局引擎在 `onLayout` 回写值（等值守卫防回环）。这不是 sidebar 槽的本职——槽只管内容贡献，宽度是壳的 chrome 偏好，不属于任何插件的贡献。

**Q：settings 覆盖层盖在 ChatView 上面，那侧栏还在挂载吗？**

在。`App` 组件用 `visibility` 切换 ChatView 和 SettingsPage（第 133 行注释），不卸载子树。Sidebar 组件因此始终挂载——折叠（`⌘B`）和 settings 切入是两个独立的隐藏机制，互不抵消。`collapsible` 折叠为 0 宽和 `visibility: hidden` 是两层独立的 CSS 状态，都保持 DOM 不卸载。
