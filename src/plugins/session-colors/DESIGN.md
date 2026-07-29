# session-colors：会话图钉插件

给会话行钉一个带颜色的图钉，钉在行上任意位置，跟着行走。图钉是纯视觉标记——不改变会话状态，不影响会话列表排序，不参与 pinned/archived 那套语义。它只干一件事：让用户一眼在列表里认出"这个会话我标过"。

## 1 问题与目标

### 1.1 场景

会话列表一长，找会话靠记忆和扫视。pinned 能把重要的拉到顶，但 pinned 是二值的——要么钉了要么没钉，不带颜色不带位置。用户要的不是"这个会话很重要"，而是"这个会话我今天下午在调试，标个红色""那个会话是临时问的，标个黄色"。这是一种比 pinned 更轻量、更直觉的视觉分类需求。

图钉要能钉在会话行的任意位置——不是固定在行首或行尾，而是用户点哪钉哪。这给了用户一种空间记忆：红色图钉在行的右上角，蓝色在中间偏左。位置由用户自己决定，不是程序排的。

### 1.2 为什么现有机制不够

pinned 和 archived 是会话头行里的布尔字段，通过 `updateHeader` 写入 JSONL。它们解决的是"这个会话重不重要""这个会话还要不要"——是状态管理，不是视觉标记。硬要往头行里塞颜色和坐标，是在拿会话文件的持久化格式干 UI 层的事。会话文件是 pi 底座的契约，桌面端往里塞自定义字段，将来底座改格式就有冲突风险。

更根本的问题是位置。pinned/archived 不携带位置信息——它们是行首固定位置的图标。图钉要钉在任意位置，这个"任意位置"是像素坐标，不属于会话文件的语义。把像素坐标存进 JSONL，窗口缩放、行宽变化时坐标就错了。

插件间也没有直接通信通道（CLAUDE.md §8.2）。session-colors 不能调 sessions-list 的接口说"帮我在你这行上画个图钉"。两个插件通过共享状态间接通信——session store、theme tokens、i18n resources。但图钉数据不是"会话状态"（它不影响会话行为），不该进 session store；不是"主题"（它是用户私有的标记），不该进 theme tokens。它是一种新的东西：插件私有的、按会话索引的视觉标注数据。

### 1.3 设计目标

session-colors 自管数据和渲染。数据存在插件自己的 config（`~/.pi-desktop/plugins-data/session-colors/config.json`），按会话文件路径索引。渲染由插件自己完成——一个 overlay 层覆盖在 sidebar 区域上，不侵入 sessions-list 的组件树。不碰内核：不改 `SessionInfo` 类型，不改 `HeaderPatch` 契约，不改 IPC 通道。

图钉跟着会话行走。会话行被重排、滚动、缩放时，图钉自动跟着。这要求 overlay 能追踪 sessions-list 渲染出的 DOM 元素位置，并在变化时重算图钉坐标。

## 2 数据模型

### 2.1 存储结构

图钉数据存在插件 config 里，经 `ctx.config.get/set` 读写，落盘到 `~/.pi-desktop/plugins-data/session-colors/config.json`。全量 pin 数据存在一个 key `"pins"` 下，`ctx.config.set("pins", allPinsData)` 一次写回整个对象。读取时 `ctx.config.all()` 拿到全量 config，取 `["pins"]` 字段。结构如下：

```
{
  "/Users/.../sessions/abc-123.jsonl": {
    "pins": [
      { "id": "pin-1", "color": "#f38ba8", "x": 85, "y": 30 },
      { "id": "pin-2", "color": "#89b4fa", "x": 50, "y": 60 }
    ]
  },
  "/Users/.../sessions/def-456.jsonl": {
    "pins": [
      { "id": "pin-3", "color": "#f9e2af", "x": 20, "y": 45 }
    ]
  }
}
```

key 是会话文件的绝对路径——这是 `ctx.sessions.list()` 返回的 `SessionInfo.path`，也是 `useUiStore.currentSessionPath` 持有的值。path 天然按项目隔离：不同项目目录下的会话，path 前缀不同，自动分桶。

`pins` 是数组，一个会话可以有多个图钉。每条 pin 的字段：

- `id`：唯一标识，用于 React key 和删除操作。`crypto.randomUUID()` 生成。
- `color`：十六进制颜色值，从固定色板里取，不走主题 token（§1.2 机制与内容分离——颜色值是插件内容，不是内核契约）。
- `x`、`y`：位置坐标，百分比（0–100），相对于 session row 元素的宽高。不是像素——像素会随窗口缩放错位，百分比不会。

### 2.2 为什么用百分比不用像素

会话行宽度受两个因素影响：窗口整体大小、用户拖拽侧栏分割线改变侧栏宽度。像素坐标存进去了，用户一拖侧栏，所有图钉的位置就错。百分比是相对于行实际渲染宽高的，行变宽图钉跟着按比例右移，行变窄图钉按比例左移，始终在用户当初点击的相对位置。

y 轴同理：行高会因为标题长短、字体大小变化而变。百分比保证图钉始终在行的同一相对纵向位置。

### 2.3 同色替换规则

一个会话上同一个颜色只能有一个图钉。用户选了红色图钉，在一个行上点了位置 A，红色图钉钉在 A。用户在同一行上又点位置 B——旧的图钉弹飞消失，新的图钉在 B 钉入。不是叠加两个红色，也不是 toggle（toggle 是"有就删没有就加"）。替换的语义是：同色始终只保持一个，位置以最后一次点击为准。

不同颜色不受影响。一个行上可以同时有红、蓝、黄三个图钉，各自独立。替换只在同色同会话内发生。

实现上是"先删后增"：在 `addPin` 之前，先找到同 sessionPath 同 color 的旧 pin，从数组里移除，再 push 新的。旧的 DOM 元素走拔出动画（§4.4），新的走钉入动画（§4.1）。

### 2.4 项目隔离

切换项目（`currentCwd` 变化）时，sessions-list 重新拉取新项目的会话列表。旧项目的会话行从 DOM 中消失，新项目的会话行出现。图钉数据全量存在一个 config 文件里，但只有当前 DOM 中有对应行的 session path 才会渲染图钉。切项目时不需要清数据或重新加载——DOM 的自然增减就是过滤器。

旧项目的图钉数据留在 config 里，不丢失。下次切回那个项目，图钉自动出现。sidePanel 的图钉列表只展示当前 DOM 中有对应行的图钉——孤儿数据（会话文件被删除或不在当前项目）不展示，避免列表里一堆"(会话不可见)"的噪音。

## 3 渲染机制

### 3.1 Overlay 层设计

overlay 是一个 `position: fixed` 的 div，经 `createPortal` 渲染到 `document.body`。它不"覆盖 sidebar 区域"——它覆盖整个视口，但只有 pin 子元素可见且参与命中测试。overlay 本身 `pointer-events: none` 零面积覆盖，pin 元素 `pointer-events: auto` 各自可点击。不需要计算 sidebar 的 bounds，因为 pin 的绝对坐标由 `getBoundingClientRect()` 直接拿到——pin 的 `left/top` 就是 `rowRect.left + (pin.x / 100) * rowRect.width`，`fixed` 定位自然落在 sidebar 上方的正确位置。

overlay 不侵入 sessions-list 的 DOM 树——pin 元素是 overlay 的子元素，不是 session row 的子元素。

为什么不用 portal 注入到 session row 内部？因为 sessions-list 用 React 的 `AnimatePresence` + `motion.div` 管理行的增删动画，行被删除时 `exit` 动画跑完才移除 DOM。如果 pin 是行的子元素，行在退出动画期间 pin 还在，但 React 的 `motion.div` 已经准备卸载——portal 的 React 树和 sessions-list 的 React 树会打架，可能出现"pin 残留在正在消失的行上"的视觉 bug。overlay 在 `document.body` 上完全独立，sessions-list 怎么折腾行都不影响 pin 的生命周期。

### 3.2 DOM 追踪策略

overlay 需要知道每个有 pin 的 session row 在屏幕上的位置，才能把 pin 定位过去。追踪分两步：找到行元素，读它的 `getBoundingClientRect()`。

**找到行元素**：sessions-list 的 `SessionRow` 组件（`src/plugins/sessions-list/renderer/index.tsx:347`）目前不在 DOM 上暴露 session path。需要给它最外层 div 加一个 `data-session-path` 属性——这是对 sessions-list 的唯一改动，1 行代码：

```tsx
<div
  data-session-path={session.path}
  onClick={onClick}
  ...
>
```

这个属性不改变 sessions-list 的任何行为，不耦合 session-colors——它是标准 DOM 属性，任何需要按 session path 定位行元素的代码都能用。和 CSS class 选择器一个性质：DOM 是公开的，属性是给外部消费的。

**读位置**：对 config 里每个有 pin 的 session path，用 `document.querySelector('[data-session-path="<path>"]')` 找到行元素，调 `getBoundingClientRect()` 拿到 `left/top/width/height`，再按 `x%/y%` 算出 pin 的绝对坐标。pin 的 `left = rowRect.left + (pin.x / 100) * rowRect.width`，`top` 同理。

**什么时候重算**：三种触发源，都挂在一个容器上——sidebar 的滚动容器。这个容器在 shell 的 `Sidebar` 组件（`src/shell/renderer/components/sidebar.tsx:61`）里，是 `<div className="h-full overflow-y-auto ...">`。session-colors 通过 `document.querySelector` 找到它：sidebar 壳的外层 div 有 `border-r` class 且包含 `[data-session-path]` 元素，用 `document.querySelector('.border-r [data-session-path]')?.closest('.overflow-y-auto')` 定位滚动容器。找不到时不崩——等 MutationObserver 下一轮触发。

三种触发源都走同一个 `scheduleReposition()` 函数——用 RAF 合并到一帧，避免一帧内多次 layout 读取造成强制重排（layout thrashing）。

- **scroll**：scroll 容器滚动时，行的 `getBoundingClientRect()` 变化。overlay 监听 scroll 事件，用 `requestAnimationFrame` 节流重算。
- **DOM 变化**：sessions-list 增删行、重排行。`MutationObserver` 监听 scroll 容器的 `childList` 变化（`subtree: true`），检测到 `[data-session-path]` 元素增删后重算。
- **resize**：窗口缩放或侧栏宽度变化。`ResizeObserver` 监听 scroll 容器尺寸变化。

### 3.3 性能边界

只追踪有 pin 的 session path，不遍历全部行。config 里记录了哪些 session path 有 pin，`querySelector` 只查这些 path 对应的行。100 个会话只有 3 个有 pin，就只查 3 次 `querySelector`，不查 100 次。

`scheduleReposition` 用 RAF 合并：scroll 事件可能一帧内触发多次，但只有帧末才真正执行一次 `getBoundingClientRect` 读取。这保证 60fps 下每帧最多一次 layout 读取。

pin 数量上限不做硬限制——图钉本身是轻量 DOM 元素（一个 SVG + 一个 div），100 个 pin 也不构成性能压力。但 sidePanel 的 pin 列表做虚拟滚动（如果将来 pin 数量真的很大）。

### 3.4 图钉组件

图钉是一个 SVG，形状和低保真原型一致：

- 椭圆头部（`rx=6.5, ry=4.5`），填色为 pin 的 color
- 高光椭圆（`rx=2.8, ry=1.6`），白色 35% 不透明度，偏左上
- 针杆（垂直线，`stroke-width=1.6`）
- 针尖分叉（两条对角线）

pin 元素的锚点（tip 的位置）对齐到记录的 `x%/y%` 坐标。SVG 的 viewBox 是 `0 0 22 26`，针尖大约在 `(11, 24)`，所以 pin 的 `transform` 需要偏移 `-11px, -22px` 使针尖落在目标点。

钉入动画用 framer-motion 的 spring：从上方落下、弹跳、定形，总时长约 500ms。具体参数：`stiffness: 500, damping: 12, mass: 0.6`，初始状态 `opacity: 0, translateY: -30px, scale: 0.3, rotate: -25deg`，目标状态 `opacity: 1, translateY: 0, scale: 1, rotate: 0`。拔出动画用 CSS keyframes：放大旋转后弹飞消失，约 350ms。

固定色板，不查主题 token：

```typescript
const PALETTE = [
  "#f38ba8", "#fab387", "#f9e2af", "#a6e3a1",
  "#89b4fa", "#cba6f7", "#f5c2e7",
];
```

7 个颜色够日常分类用。色板选择参考 Catppuccin Mocha 调色板——但颜色值写死在插件代码里，不查主题 token。换主题不改图钉颜色，因为图钉是用户的私有标注，不是界面配色。色板选型的审美取向和当前默认主题一致，但这不是架构约束——色板是硬编码常量，不受主题系统管理。

## 4 交互流程

### 4.1 选色 → pin 模式 → 钉入

交互入口在 sidePanel。session-colors 贡献一个 sidePanel Tab，里面放一排图钉形状的色板——不是圆点，是图钉形状的 SVG，让用户一看就知道这是"钉"而不是"涂色"。

点击一个颜色的图钉 → 进入 pin 模式。进入 pin 模式的信号：

- `selectedColor` 设为该颜色
- 鼠标光标变成跟随的图钉 SVG（一个 `position: fixed` 的 div，`pointer-events: none`，跟着 `mousemove` 走）
- sidebar 区域的 session row 变成"可钉入"视觉态：pin 模式下给 sidebar 容器加一个 `data-pin-mode="true"` 属性，CSS 用 `[data-pin-mode="true"] [data-session-path]:hover { outline: 1px dashed rgba(137,180,250,0.3); outline-offset: 2px; }` 实现行 hover 虚线轮廓。属性是加在 sidebar 容器上（通过 `querySelector` 找到），不是侵入 session row 组件。
- click-catcher 同样是 `position: fixed` 覆盖整个视口的透明 div，但只在 sidebar 区域（通过 `elementFromPoint` 找到 `data-session-path` 祖先）拦截点击。click-catcher 的 `pointer-events: auto` 拦截整个视口的点击，但只有点击落在 session row 上时才执行钉入；点在别处什么都不做。

用户在 sidebar 上点击某个 session row 的任意位置 → click-catcher 拦截到点击事件，执行钉入流程：

1. 临时将 click-catcher 设为 `pointer-events: none`
2. `document.elementFromPoint(e.clientX, e.clientY)` 找到下方的行元素
3. 沿 DOM 树向上找到带 `data-session-path` 的祖先元素
4. 恢复 click-catcher 的 `pointer-events: auto`
5. 读 `data-session-path` 属性拿到 session path
6. 用行的 `getBoundingClientRect()` 算出点击位置相对行的百分比 `x%/y%`
7. 执行同色替换（§2.3）：先删同色旧 pin，再写新 pin 到 config
8. overlay 渲染新 pin，走钉入动画

### 4.2 同色替换

同 session path 同 color 的旧 pin 如果存在，先从 config 的 `pins` 数组里移除。旧 pin 的 DOM 元素走拔出动画（`popping` class），动画结束后移除 DOM。新 pin 钉入，走钉入动画。

两次动画有 350ms 的重叠期——旧的在弹飞，新的在落下，视觉上是"旧的被顶掉、新的钉进来"。不需要等旧的完全消失再钉新的，那会显得卡顿。

### 4.3 退出模式

三种退出方式：

- **Esc 键**：监听 `keydown`，pin 模式下按 Esc 退出
- **右键**：pin 模式下右键任意位置退出（click-catcher 拦截 `contextmenu` 事件）
- **再次点击选中色**：在 sidePanel 色板里再次点击当前选中的颜色图钉，toggle 退出
- **视图切换**：监听 `useUiStore` 的 `activeView`，从 `"chat"` 切到 `"settings"` 时自动退出 pin 模式。sidebar 只在 chat 视图中可见，pin 模式在 settings 视图下没有意义——click-catcher 会残留在不可见的区域上，鼠标跟随光标也会困惑用户。`useEffect` 依赖 `activeView`，切换时调用 `exitPinMode()`。

退出时清除：`selectedColor` 置 null，移除鼠标跟随光标，移除 click-catcher 层，清除 session row 的"可钉入"视觉态。

### 4.4 拔出图钉

已存在的 pin 可以被点击拔出。pin 元素自身有 `pointer-events: auto`，overlay 有 `pointer-events: none`，所以只有 pin 本身能接收点击。

点击 pin → 触发拔出动画（`popping` class）→ 动画结束（350ms）后从 config 的 `pins` 数组里移除该 pin → 移除 DOM 元素 → 更新 sidePanel 列表。

拔出不退出 pin 模式——用户拔了一个还能继续钉别的。只有在 pin 模式下点击空白处（非 session row）不做任何操作，不退出也不钉入。

## 5 生命周期与时序

### 5.1 冷启动

renderer 启动时序（`src/shell/renderer/index.tsx`）：

1. `hydrateFromPrefs()` — 从 electron-store 读偏好，设 `currentCwd`、`currentSessionPath`
2. `initI18n()` — 初始化 i18next
3. `initSessionStore()` — 挂上 main→renderer 的事件通道（`onSnapshot`、`onEvent`）
4. React 首帧挂载（`<App />`）：Titlebar + ChatView（空壳，槽壳渲染但组件未注册）
5. `ensurePlugins()` — 异步 import `plugins-host.ts`
6. `plugins-host.ts` 用 `import.meta.glob` 加载所有内置插件 renderer 模块
7. session-colors 的 `renderer/index.tsx` 执行：`registerSidePanelComponent("SessionColorsPanel", SessionColorsPanel)` 注册组件
8. 所有插件加载完 → `bumpPlugins()` → `pluginsNonce` +1
9. 槽壳（sidebar / sidePanel）订阅 `pluginsNonce`，重渲染，查到已注册的组件
10. **Sidebar 渲染** → sessions-list 组件挂载 → `ctx.sessions.list(currentCwd)` 拉会话列表 → session row 渲染到 DOM
11. **sidePanel 渲染** → session-colors 的 `SessionColorsPanel` 挂载

session-colors 的 `SessionColorsPanel` 挂载后做三件事：

- `ctx.config.all()` 读 config，取 `["pins"]` 字段存入插件内部的 zustand store
- `MutationObserver` 挂到 sidebar 的 scroll 容器上（§3.2 描述的 `querySelector` 定位方式），监听 `[data-session-path]` 元素的增删
- 首次 `scheduleReposition()` 尝试定位 pin——此时 sessions-list 可能还没渲染完行（它也在异步拉数据），`querySelector` 返回 null 是正常的。MutationObserver 会在行出现时触发，自动补上

关键时序风险：session-colors 和 sessions-list 是两个独立插件，挂载顺序不保证。sessions-list 先挂载、行已渲染到 DOM 时 session-colors 才挂载——没问题，`querySelector` 找得到行。session-colors 先挂载、sessions-list 还没渲染行——也没问题，MutationObserver 在 sessions-list 后续渲染行时触发。两种顺序都 safe。

### 5.2 会话列表刷新

sessions-list 在以下场景重新拉取会话列表并重渲染行：

- `currentCwd` 变化（切换项目）
- `sessionNonce` 变化（新建/切换会话后 bump）
- session event 到达（`sessionStart`、`messageStart`、`messageEnd`、`agentSettled`）

刷新时 React 会 diff 新旧列表，增删/重排行 DOM。session-colors 的 MutationObserver 捕获这些 DOM 变化：

- **行新增**（新会话）：新行的 `data-session-path` 出现在 DOM 中。如果 config 里有该 path 的 pin 数据，overlay 渲染 pin；没有则什么都不做。不需要显式触发——MutationObserver 自动处理。
- **行删除**（会话被删）：行的 DOM 元素移除。该行上的 pin 元素也跟着移除（pin 是 overlay 的子元素，不是行的子元素，所以需要显式移除）。config 里的 pin 数据保留——行可能只是暂时不在视图里（比如切了项目），不是永久删除。
- **行重排**（排序变化）：行的 DOM 位置变化。`scheduleReposition()` 被 MutationObserver 触发，重算所有 pin 的绝对坐标。pin 自动出现在新位置。

### 5.3 切换项目

`currentCwd` 变化是切换项目的信号。此时发生连锁反应：

1. sessions-list 的 `useEffect` 依赖 `currentCwd`，触发重新拉取 `ctx.sessions.list(newCwd)`
2. React diff：旧项目的会话行全部移除，新项目的会话行添加
3. MutationObserver 触发：检测到一批 `[data-session-path]` 元素被移除、一批被添加
4. overlay 的 `scheduleReposition()` 执行：遍历 config 里的 pin 数据，对每个 session path 做 `querySelector`——旧项目的 path 查不到了（DOM 里没有），跳过；新项目的 path 查到了，渲染 pin

session-colors 不需要知道"项目切换了"这件事——它只关心"DOM 里有哪些 `[data-session-path]` 元素"。项目切换在 session-colors 看来就是一批行被删、一批行被加，和会话列表刷新里的增删完全一样。没有特殊处理路径。

config 不需要清空或重新加载。全量数据始终在一个文件里，DOM 是天然过滤器——只有当前可见的行才会被 `querySelector` 找到，才会渲染 pin。旧项目的 pin 数据安静地待在 config 里，下次切回来自动出现。

### 5.4 会话新增与删除

**新增**：用户点"+"新建会话，sessions-list 调 `startNewChat` → `sessionStart` event → sessions-list `reload()` → 新行渲染到 DOM。新会话没有 pin 数据（config 里没有该 path 的 key），不渲染 pin。用户可以随后在 pin 模式下给它钉一个。

**删除**：用户删除会话，sessions-list 移除该行的 DOM。MutationObserver 触发，overlay 移除该行上所有 pin 元素。config 里的 pin 数据保留——但 sidePanel 的 pin 列表不展示孤儿项（`querySelector` 查不到对应行的 pin 不进列表），所以用户看不到。如果会话文件只是被移动而非删除（比如重命名），下次 sessions.list 返回新 path，config 里旧 path 的数据变孤儿，新 path 没有数据——pin 丢失。这是已知限制（见 QA）。

### 5.5 窗口缩放

窗口缩放改变 sidebar 宽度和行高。`ResizeObserver` 监听 sidebar 容器的尺寸变化，触发 `scheduleReposition()`。因为 pin 位置是百分比，重算后 pin 自动落在新的绝对坐标上——行变宽了，pin 按比例右移；行变高了，pin 按比例下移。视觉上 pin 始终在行的同一相对位置，不会因为缩放而错位。

侧栏宽度变化（拖拽分割线）同理——sessions-list 的行宽跟着 sidebar 宽度变，`ResizeObserver` 触发重算。

## 6 插件结构

### 6.1 plugin.json

```json
{
  "id": "session-colors",
  "version": "0.1.0",
  "displayName": "会话图钉",
  "description": "给会话行钉带颜色的图钉，任意位置，跟随行移动",
  "renderer": "./renderer/index.tsx",
  "contributes": {
    "sidePanel": [
      {
        "id": "session-colors",
        "label": "图钉",
        "icon": "pin",
        "component": "SessionColorsPanel",
        "order": 80
      }
    ]
  }
}
```

不声明 `permissions`——插件只用自己的 config（`ctx.config`）和读 `useUiStore`（当前 cwd、session path），不需要 fs/git/bash 能力。config 读写是核心默认能力，不声明权限。

### 6.2 renderer 模块划分

```
src/plugins/session-colors/
├── plugin.json
└── renderer/
    ├── index.tsx       # 入口：注册 sidePanel 组件 + overlay 逻辑
    ├── pin-svg.tsx     # 图钉 SVG 组件（panel 色板和 overlay 共用）
    └── pin-store.ts    # zustand store：selectedColor / pins / pinMode
```

**`index.tsx`** 是入口，做三件事：

- `registerSidePanelComponent("SessionColorsPanel", SessionColorsPanel)` 注册 sidePanel 组件
- `SessionColorsPanel` 组件包含三部分：色板选色区（7 个图钉形状按钮，点击进入 pin 模式）、pin 列表（展示当前 DOM 中有对应行的 pin，每条显示颜色圆点 + 会话标题 + 删除按钮，按会话分组；点击标题高亮对应行）、pin 模式状态管理
- overlay 逻辑：`SessionColorsPanel` 内部用 `createPortal` 把 overlay 渲染到 `document.body`。overlay 的生命周期绑定到 `SessionColorsPanel`——sidePanel Tab 关闭时 overlay 卸载，Tab 打开时 overlay 挂载。pin 数据在 store 里，不受组件卸载影响。

**`pin-svg.tsx`** 是纯展示组件，接收 `color` prop，渲染图钉 SVG。色板里的图钉（缩小、半透明）和 overlay 里的图钉（全尺寸、带阴影）共用同一个 SVG，靠 CSS 控制大小和样式差异。

**`pin-store.ts`** 是插件内部状态：

```typescript
interface PinStoreState {
  selectedColor: string | null;     // null = 非 pin 模式
  pins: Record<string, Pin[]>;      // sessionPath → pins
  pinMode: boolean;
  setPins: (pins: Record<string, Pin[]>) => void;
  selectColor: (color: string | null) => void;
  addPin: (sessionPath: string, pin: Pin) => void;   // 含同色替换
  removePin: (sessionPath: string, pinId: string) => void;
}
```

store 在模块级创建，sidePanel 组件和 overlay 共用。store 和 config 的同步策略是乐观更新：`addPin` / `removePin` 先更新 zustand store（UI 立即响应），然后 `fire-and-forget` 调 `ctx.config.set("pins", allPinsData)` 写盘。不等 config 写完才更新 UI——pin 操作是低频的，写盘延迟可接受。如果 config 写失败（IPC 异常），store 里已经更新了，用户当前看到的是对的；下次重载（sidePanel 重新挂载）会从 config 读到旧数据，pin 回退。这是已知权衡：乐观更新换响应速度，代价是极端情况下重载后数据回退。当前不做 try-catch 回滚——pin 是视觉标注，不是关键数据，回退用户最多重新钉一次。

### 6.3 与 @pi-desktop/react 的依赖

session-colors 只从 `@pi-desktop/react` 引用，不直连 `src/` 内层（§6.3 依赖方向）：

- `usePluginContext("session-colors")` — 拿 `ctx.config` 读写 pin 数据
- `useUiStore` — 读 `currentCwd`（知道当前在哪个项目）、`currentSessionPath`（知道当前选中哪个会话）
- `registerSidePanelComponent` — 注册 sidePanel 组件

不依赖 `useSessionStore`——pin 数据不来自会话投影，来自插件自己的 config。不依赖 `ctx.sessions`——不需要调会话能力，只读 session path（从 DOM 属性拿）。

### 6.4 sessions-list 的改动

sessions-list 的 `SessionRow` 组件（`src/plugins/sessions-list/renderer/index.tsx:347`，最外层 div）加一个 `data-session-path` 属性：

```tsx
<div
  data-session-path={session.path}
  onClick={onClick}
  ...
>
```

1 行改动，不改变行为，不引入新依赖。这个属性是给外部消费者用的——session-colors 用 `querySelector('[data-session-path="<path>"]')` 定位行元素。任何需要按 session path 定位行 DOM 的代码都能用这个属性，不限于 session-colors。

这不违反"插件间不直接通信"（§8.2）——session-colors 不是调 sessions-list 的接口，而是读 DOM 属性。DOM 是公开的渲染产物，和 CSS class 一样属于公开接口。sessions-list 不知道也不关心谁在读它的 `data-session-path`。

## 7 QA

**Q：sessions-list 不加 `data-session-path` 行不行？用行的文本内容匹配 session 可以吗？**

可以跑，但不推荐。文本匹配在重名会话下会误定位——两个会话都叫"调试"时，`querySelector` 无法区分。`data-session-path` 是绝对路径，天然唯一。1 行改动换一个可靠的定位方式，值。

---

**Q：pin 模式下点击 session row，会触发 sessions-list 的 `select` 逻辑吗（切换到那个会话）？**

不会。pin 模式下 click-catcher 覆盖整个视口，`pointer-events: auto` 拦截了点击。sessions-list 的 onClick 收不到事件。click-catcher 用 `document.elementFromPoint` 临时穿透找到行元素，但不把事件传递下去。退出 pin 模式后 click-catcher 移除，sessions-list 的点击恢复正常。

---

**Q：用户在 pin 模式下切到设置页（activeView 变为 "settings"），pin 模式会清理吗？**

会。session-colors 监听 `useUiStore` 的 `activeView`，从 `"chat"` 切到 `"settings"` 时自动调用 `exitPinMode()`——清除 `selectedColor`、移除 click-catcher、移除鼠标跟随光标、清除 sidebar 的 `data-pin-mode` 属性。sidebar 只在 chat 视图中可见，pin 模式在 settings 视图下没有意义，不清理会导致 click-catcher 残留在不可见区域上。

---

**Q：如果 config 写盘失败（IPC 异常），pin 数据会怎样？**

store 先更新了（UI 立即响应），config 写失败。当前不做 try-catch 回滚——pin 是视觉标注，不是关键数据。用户当前看到的是对的；下次重载（sidePanel 重新挂载）从 config 读到旧数据，pin 回退到上次成功写入的状态。用户最多重新钉一次。

---

**Q：会话文件被重命名/移动后，pin 数据怎么办？**

pin 数据以 session path（文件绝对路径）为 key。文件移动后 path 变了，旧 path 的 pin 数据还在 config 里（变成孤儿），新 path 没有数据。sidePanel 列表不展示孤儿项。用户需要在新的 path 上重新钉。这是已知限制——path 是唯一可靠的会话标识，但 path 变了就断了关联。用会话 id 不行，因为 id 在 JSONL 头行里，`sessions.list` 不返回 id（只返回 path），拿 id 要解析文件，插件不该碰会话文件内容。

---

**Q：多个 Electron 窗口时，pin 会怎样？**

每个 renderer 进程有独立的 session-colors 组件实例和 overlay。config 文件是共享的（同一个 `~/.pi-desktop/plugins-data/session-colors/config.json`），但窗口间不实时同步。窗口 A 钉了 pin，窗口 B 需要重新 `ctx.config.all()` 才能看到。当前设计不处理多窗口实时同步——pin 操作频率低，手动刷新可接受。

---

**Q：pin 位置用百分比，那如果会话行高度变化（比如用户调了字号），pin 位置还对吗？**

对。y% 是相对于行实际渲染高度的百分比。行高变了——字号调大、标题换行——pin 的 y% 不变，绝对坐标自动按新行高重算。`ResizeObserver` 监听到变化后触发 `scheduleReposition()`，pin 出现在新的绝对位置，但相对位置（"行的中间偏下"）不变。

---

**Q：pin 模式下用户点了 sidebar 的空白区域（不是任何 session row），会发生什么？**

什么都不发生。click-catcher 拦截到点击，`document.elementFromPoint` 找不到带 `data-session-path` 的祖先元素，钉入流程中止。不退出 pin 模式，不钉入空 pin。用户需要点击具体的 session row 才能钉入。

---

**Q：sidePanel Tab 关闭后，已有的 pin 会消失吗？**

会。overlay 的生命周期绑定在 `SessionColorsPanel` 组件上——sidePanel Tab 关闭时组件卸载，`createPortal` 渲染的 overlay 随之移除。但 pin 数据还在 store 和 config 里，重新打开 Tab 后 overlay 重新挂载，pin 自动回来。这和 git-review Tab 关闭后 diff 消失再打开重新加载是同一个模式。

未来的演进方向：把 overlay 独立出来，不绑定 sidePanel 生命周期。但这需要插件能往 sidebar 槽贡献一个隐形组件（只管 overlay，不渲染可见 UI），当前 sidebar 槽的 Panel 会裁剪 overflow，`position: fixed` 在有 `transform` 的父容器里会变成相对定位——有技术风险，留作后续优化。

---

**Q：色板里为什么是 7 个颜色？能加自定义颜色吗？**

7 个颜色参考 Catppuccin Mocha 调色板选取，和项目的默认主题色调一致。但色板是硬编码常量，不走主题系统——换主题不改图钉颜色，因为图钉是用户的私有标注。当前不支持自定义颜色——颜色选择器会显著增加交互复杂度（拾色器、输入 hex、最近使用），和"钉一个图钉"的轻量定位不符。如果将来有需求，色板可以从 config 读（`ctx.config.get("customColors")`），用户在设置页里管理。但这是扩展，不是当前设计的一部分。
