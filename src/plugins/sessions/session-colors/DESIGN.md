# session-colors：会话图钉插件

给会话行和会话流消息钉带颜色的图钉，钉在任意位置，跟着宿主走。图钉是纯视觉标记——不改变会话状态，不影响会话列表排序，不参与 pinned/archived 那套语义。它只干一件事：让用户一眼认出"这个会话/这条消息我标过"，并且随时回得去。

两个挂载面同一个抽象：会话行钉（`Pin`）标"哪个会话值得回"，消息内容钉（`ContentPin`）标"会话里哪条内容值得回"。色板同组、钉入同模态、动画同参数、同色替换同规则，差异只在落点与锚点 key（sessionPath vs messageId）。内容钉的完整设计（锚点选型、虚拟滚动挂载、面板跨会话索引、预览快照）见 `docs/design/content-pins.md`，本文不重复，只讲插件整体的机制与结构。

## 1 问题与目标

### 1.1 场景

会话列表一长，找会话靠记忆和扫视。pinned 能把重要的拉到顶，但 pinned 是二值的——要么钉了要么没钉，不带颜色不带位置。用户要的不是"这个会话很重要"，而是"这个会话我今天下午在调试，标个红色""那个会话是临时问的，标个黄色"。这是一种比 pinned 更轻量、更直觉的视觉分类需求。

会话流里的需求同族但更尖锐：几千行混排的气泡、代码块、工具卡，同质度极高，滚动十屏之后"刚才那条在哪"完全是体力活。"那段代码方案我验证过""这个工具输出待会要查"——这些位置需要标记，但不需要 fork（书签太重）、不需要评论（review 是给模型的通道），只要一个纯视觉的位置标记。

图钉要能钉在宿主的任意位置——不是固定在行首行尾或消息边角，而是用户点哪钉哪。这给了用户空间记忆：红色图钉在行的右上角，蓝色钉在那条消息的中部。位置由用户决定，不是程序排的。

### 1.2 为什么现有机制不够

pinned 和 archived 是会话头行 `custom-my-harness-desktop` 命名空间里的保留键，经 `updateSessionHeader` 写入 JSONL。它们解决"这个会话重不重要""还要不要"——是状态管理，不是视觉标记。硬往头行塞颜色和坐标，是拿会话文件的持久化格式干 UI 层的事；会话文件是底座的契约，桌面端私有数据该走插件自己的存储。

更根本的是位置。pinned/archived 不携带位置信息，而图钉的"任意位置"是相对坐标，不属于会话文件的语义。

书签做"保存节点、以后重启"——完整 JSONL 拷贝加 fork 语义，拿它当位置标记是重量和语义的双重错配。review 是给模型的输入通道。两者都不做"纯视觉、只给自己看"的标记。

### 1.3 设计目标

- 自管数据和渲染。数据走插件统一 config 通道，按会话路径索引。渲染经 portal 钉进宿主元素，不侵入 sessions-list / timeline 的组件树。不碰内核：不改 `SessionInfo`，不改 IPC 通道，不加槽位。
- 点哪钉哪。位置是宿主内的百分比坐标，宿主尺寸变化时相对位置不变。
- 图钉跟着宿主走。行重排、滚动、虚拟滚动卸载重建、流式撑高，图钉始终在宿主的同一相对位置，零坐标重算。
- 钉进去还能回得来。面板是回航索引：行钉列会话卡片，内容钉按会话聚合成跨会话索引（含其他会话的钉），点击即导航。

## 2 数据模型

### 2.1 存储结构

图钉数据走插件统一 config 通道（`ctx.config.get/set/all`）：项目级 `<cwd>/.my-harness-desktop/config/session-colors.json`，全局 `~/.my-harness-desktop/config/session-colors.json` 自动兜底，插件不碰路径、不感知 cwd。三个 key：

- `"pins"`：行钉，`Record<sessionPath, Pin[]>`。
- `"contentPins"`：内容钉，`Record<sessionPath, ContentPin[]>`（形状与字段语义见 content-pins.md §3.2，含 `preview` 快照字段）。
- `"pinsVisible"`：全局显隐开关，唯一写全局层的键（`set` 的 `scope: "global"`）——显隐是跨项目的个人偏好，不随项目走。

key 是会话文件的绝对路径——`ctx.sessions.list()` 返回的 `SessionInfo.path`，也是 `useUiStore.currentSessionPath` 持有的值。path 天然按项目隔离：不同项目的会话 path 前缀不同，自动分桶。

每条 `Pin` 的字段：

- `id`：`crypto.randomUUID()`，React key、删除、`attachedOnce` 动画登记用。
- `color`：十六进制色值，从固定色板取（§3.4），不走主题 token。
- `x`、`y`：宿主元素渲染框内的百分比坐标（0–100）。

### 2.2 为什么用百分比不用像素

会话行宽度受窗口大小和侧栏拖宽影响，消息高度受流式增长、折叠展开、字号调整影响。像素坐标存进去，宿主一变形所有图钉就错位。百分比相对宿主实际渲染尺寸：宿主变宽图钉按比例右移，变窄按比例左移，撑高时纵向相对位置不变——始终停在用户当初点击的相对位置，零 JS 参与。

### 2.3 同色替换规则

同一宿主上同一颜色只保留一个图钉。选了红色在位置 A 钉入，再在同一宿主点位置 B——旧钉弹飞、新钉落下（350ms 动画重叠期），不是叠加也不是 toggle。替换语义：同色始终只有一个，位置以最后一次点击为准。不同颜色随意共存。行钉按"同 sessionPath 同 color"替换，内容钉按"同 messageId 同 color"替换，规则逐字通用。实现是 store 里先过滤同色再 push（`addPin` / `addContentPin`）。

### 2.4 项目隔离与孤儿数据

切换项目时旧项目的图钉数据留在 config 里不清理：行钉靠"行不在侧栏 DOM 不渲染不列出"天然过滤，内容钉靠"会话不在当前项目会话列表不列出"过滤（content-pins.md §6.1）。切回项目，图钉自动回来。会话文件被删/重命名（path 变化）的孤儿数据不主动清——行钉静默不显示，内容钉的孤儿处置按可判定性分两种（当前会话可判定不列，其他会话不可判定保留列出），见 content-pins.md §3.3。

## 3 渲染机制

### 3.1 portal 钉进宿主元素

图钉不是画在 viewport 上的浮层——经 `createPortal` 渲染为宿主元素的**子元素**：每个宿主挂一个 `RowPins` 容器（`position: absolute; inset: 0`，宿主是 `position: static` 时先补 `relative`），图钉用 `left: x%; top: y%` 相对宿主定位。

为什么不用 viewport overlay？早期实现是采样模型：`getBoundingClientRect()` 采样宿主位置，scroll / observer / resize 触发坐标重算。死穴在 framer-motion 的 transform 补间动画（sessions-list 行重排是 `motion.div layout` 补间）：补间期间 `childList` 和属性都不变，observer 完全无感，图钉冻结在旧坐标，动画结束才跳——"宿主走了，图钉没跟"。钉进宿主后这一切消失：行重排、滚动、虚拟滚动重建、流式撑高，图钉由浏览器原生跟随（它是宿主子元素），零坐标重算；宿主卸载图钉随之消失，重挂自动回来。

### 3.2 挂载追踪：只维护挂载关系，不算坐标

JS 只维护两张映射：`sessionPath → 行元素`、`messageId → 消息元素`。扫描有两个触发源：

- **数据触发**：store 的钉数据变化（钉入/拔出/清空）时 effect 重跑立即重扫——钉入瞬间的反馈走这条路，不等 DOM 事件。
- **DOM 触发**：`MutationObserver` 以 `childList + subtree` 观察宿主容器，捕获宿主元素增删（行增删、Virtuoso 滚动重建、折叠展开、切会话/切项目），RAF 合并到一帧后重扫。scroll、resize、transform 补间一律不观察——那些运动图钉作为子元素由浏览器原生跟随。

**容器重锚**：宿主容器可能晚出现（会话列表异步拉取）或整体迁移（切项目/切视图）。每轮扫描后按当前实际宿主反查容器：行容器 = `document.querySelector("[data-session-path]")?.closest(".overflow-y-auto")`，消息容器 = `document.querySelector("[data-message-id]")?.closest("[data-virtuoso-scroller]")`——拿现有宿主元素反查，不假设容器 class（业务 class 不作契约）；找不到时兜底观察 `document.body`；容器身份变化时断开旧 observer 重建。不能直接 `querySelector(".overflow-y-auto")` 取首个匹配——文档里有多个同名滚动容器，DOM 序是运气不是契约。

**命中比对防重渲染**：扫描结果与现存映射逐键比对元素身份，没变不 setState。虚拟滚动下大多数扫描的结果与上轮相同，这条路把重渲染压到接近零。

**DOM 锚点是唯一的插件间接口**：`data-session-path`（sessions-list 行）和 `data-message-id`（timeline MessageRow）是标准 DOM 属性，任何需要按 path/messageId 定位元素的代码都能用。session-colors 不调任何插件的接口，两个宿主插件也不知道谁在消费这些属性——DOM 是公开的渲染产物，和 CSS class 一个性质。

### 3.3 性能边界

只查有钉的宿主，不遍历行和消息：每轮扫描对每颗钉做一次属性选择器 `querySelector`。一个会话钉十几颗已是重度使用，每帧十几次选择器成本可忽略。observer 回调一律 RAF 合并。图钉数量不做硬限制：单钉是一个 SVG 加两层 div，且只在宿主可见时存在 DOM。

### 3.4 图钉组件

图钉是一个 SVG（`PinSVG`，面板色板、鼠标跟随预览、钉入渲染三处共用）：

- 椭圆头部（`cx=11, cy=5.5, rx=6.5, ry=4.5`），填色为 pin 的 color
- 高光椭圆（`rx=2.8, ry=1.6`），白色 35% 不透明度，偏左上
- 针杆（`M11 10 L11 20`，`stroke-width 1.6`）+ 针尖分叉两条对角线

viewBox `0 0 22 26`，针尖约在 `(11, 24)`，钉入时 `transform: translate(-11px, -22px)` 使针尖对齐记录的坐标点。

钉入动画 framer-motion spring：从上方落下、弹跳、定形，`stiffness: 500, damping: 12, mass: 0.6`，初始 `{opacity: 0, y: -30, scale: 0.3, rotate: -25}`。拔出动画 350ms easeIn 弹飞（放大旋转上升消失）。**动画只播一次**：`attachedOnce: Set<pinId>` 模块级登记簿记录播过钉入动画的钉——行重排、虚拟滚动重建导致的重挂载 `initial: false` 静息出现，不再弹跳。没有它，每次滚过钉位都会看到图钉弹跳一次。

固定色板，不查主题 token：

```typescript
const PALETTE = [
  "#f38ba8", "#fab387", "#f9e2af", "#a6e3a1",
  "#89b4fa", "#cba6f7", "#f5c2e7",
];
```

7 色够日常分类，选型取向与 Catppuccin Mocha 一致，但色值是插件内容不是界面配色——换主题不改图钉颜色，因为图钉是用户的私有标注。

## 4 Overlay 挂载结构：框架常驻挂载点

### 4.1 为什么常驻

图钉的渲染和持久化不能绑在 sidePanel 面板的生命周期上：面板 Tab 一关，钉在行上的图钉不能跟着消失（宿主还在，钉就该在），config 的读写也不能停。所以插件除面板组件外再 export 一个命名组件 `Overlay`，由框架的 `PluginOverlays`（`packages/react/plugin-overlays.tsx`，经 `api/renderer/index.tsx` 挂进主 React 树）统一挂载：遍历已加载插件，凡 module 有 `Overlay` 导出就渲染，每个 overlay 包一层 `PluginIdContext.Provider`（注入 pluginId）加独立 `ErrorBoundary`（单个插件悬浮层崩溃只摘除自己）。插件不声明、不注册——有 export 就挂，没有就不挂，机制对所有插件平等。

### 4.2 Overlay 承担什么

`Overlay` 是图钉子系统的常驻根，承担三件事：

1. **config 读**：首次挂载时 `loadPins` / `loadContentPins` / `loadVisibility` 读入 store，`loaded` 标记防重读。
2. **store → config 投影写盘**：`usePinStore.subscribe` 比对前后状态，`pins` / `contentPins` 变化写项目级，`pinsVisible` 变化写全局层。跳过订阅首次触发，避免刚读出的内容原样写回。面板、钉入模态、快捷入口都只动 store，谁也不直接碰 ctx.config——写盘出口唯一。
3. **图钉渲染与钉入模态**：挂载追踪（§3.2）、portal 渲染、钉入模式的 window 监听，全在 Overlay 里。面板只是 store 的视图。

### 4.3 历史教训：为什么不用独立 React root

早期 Overlay 是插件模块加载时自己 `createRoot` 挂到 `document.body`。独立 root 拿不到框架经 React Context 注入的 `PluginIdContext`——`usePluginContext()` 在里面得到默认空 pluginId，main 侧 config 白名单校验直接拒绝，写盘被 fire-and-forget 吞掉，表现为静默丢数据（真实发生过的 bug）。框架 Overlay 挂载点就是这次事故的制度化修复：pluginId 由框架注入，插件不需要也无法绕过。红线从此是：**config 读写只发生在框架注入 pluginId 的组件树内**（本插件里就是 Overlay），任何自建 root 都不许碰 ctx。

## 5 交互流程

### 5.1 选色 → 钉入模式 → 落点决定类型

面板选一个颜色的图钉 → 进入钉入模式（`selectedColor` 非 null 即 `pinMode`）。模式信号：鼠标带着图钉预览（`position: fixed` 跟随 div，`pointer-events: none`）；可钉宿主 hover 显虚线轮廓（注入的 style 标签对 `[data-session-path]:hover` / `[data-message-id]:hover` 生效）。

钉入模式 = **指针模态**：window 捕获相监听 `pointerdown` / `click` / `contextmenu`，`document.elementFromPoint` 判落点，落在宿主上的交互整体截停——行的 onClick（切换会话）、SortableList 拖拽手势、Radix 右键菜单一律不触发。不逐个事件堵、不依赖宿主实现，模态语义一处收编。监听 pointerdown 而非 mousedown：SortableList 已在 pointerdown preventDefault 压选区，平台语义连带抑制兼容性鼠标事件，window 级 mousedown 永远收不到。

落点分派（两个锚点在 DOM 上分属 sidebar / mainView 两个槽壳子树，不互为祖先，分支天然互斥）：

- 命中已有图钉（`data-session-colors-pin`）→ 只防拖拽手势，click 放行给拔出。
- 命中 `[data-message-id]` 祖先 → 算消息内百分比坐标，`addContentPin`（含预览快照，content-pins.md §6.2）。
- 命中 `[data-session-path]` 祖先 → 算行内百分比坐标，`addPin`。
- 都不命中 → 不拦，面板/输入框交互照常。

兜底：click 由 pointerup 独立派生不受 pointerdown 拦截影响，捕获相 click 监听二次截停宿主的点击。

钉入**不触发**宿主的原有交互（不切会话、不选中文本）——这是模态的固有代价：钉入模式下消息区不能划选复制、不能点链接。模式是短暂的，退出后一切恢复。wheel 滚动不拦截，钉入模式下翻找消息正常。

### 5.2 退出模式

四条路径：Esc 键、右键（捕获相截停并退出，行上的 Radix 菜单不弹）、再点选中色（toggle）、切出 chat 视图（`activeView` 离开 `"chat"` 时 effect 自动退——sidebar 和会话流只在 chat 视图可见，模态残留无意义）。

### 5.3 拔出

点击已钉的图钉 → 弹飞动画 350ms → 从 store 移除。图钉自身 `pointer-events: auto`，钉层容器 `pointer-events: none`，只有钉本身接收点击。拔出不退出钉入模式。

### 5.4 快捷入口（messageActions 槽）

主入口（色板→模态→点位置）价值在位置自由，代价是三拍。经 `messageActions` 槽往 user/assistant 消息行贡献 `ContentPinAction` 钉按钮（manifest 声明 `when.role`，框架自动匹配 export 挂上），一拍完成：显式 toggle——该消息已有 `lastUsedColor` 颜色的钉则拔出，否则钉入默认位置（右上角 `x=97, y=6` 固定常量）。`lastUsedColor` 是内存态（色板每次选色更新，不持久化，冷启动回色板首色）——只是快捷入口的便利性记忆，不值得加 config key。快捷入口要的是快，要位置精确走主入口；两个入口产出同一种数据，面板和渲染不感知来源。

## 6 面板：回航索引

面板（sidePanel 槽，`SessionColorsPanel`）骨架：标题行（含全局显隐眼睛开关）、提示行、色板行（每色按钮带数量角标，点角标清该色全部钉；全清按钮）、颜色过滤 tab、列表区。列表区分两段：

- **行钉段**：带行钉的会话列成卡片——会话名、最后消息预览、色点行（hover 显 × 移除）、定位按钮（滚到侧栏该行并高亮 600ms）、点击卡片打开会话。列出口径：行须在当前侧栏 DOM 可见（`visiblePaths`，折叠组内的行不列）——与渲染口径一致。
- **内容钉段**：跨会话索引，按会话聚合——当前会话组恒在最前（渲染口径，孤儿不列，按消息序），其他会话组按项目会话顺序、组头显会话名，点击两段式导航（当前会话直接滚，其他会话先打开再滚）。完整口径、预览快照与导航时序见 content-pins.md §6。

色板过滤 tab 对两段同时生效；显隐开关（`pinsVisible`）对两种钉同时生效——它们是同一层视觉标注，没有分开隐藏的理由。面板还承担旧数据预览的惰性补填触发（backfill effect，content-pins.md §6.2）。

会话元数据（名称/最后消息）经 `ctx.sessions.list(currentCwd)` 拉取，与 sessions-list 同数据源；打开会话失败（文件已删）回滚选中态，不留指向失效会话的残局。

## 7 插件结构

### 7.1 plugin.json

```json
{
  "id": "session-colors",
  "version": "0.6.0",
  "tier": "official",
  "displayName": "会话图钉",
  "description": "给会话行与会话消息钉带颜色的图钉，任意位置，跟随宿主移动",
  "renderer": "./renderer/index.tsx",
  "contributes": {
    "sidePanel": [{ "id": "session-colors", "label": "图钉", "icon": "pin", "component": "SessionColorsPanel", "order": 80 }],
    "messageActions": [{ "id": "contentPin", "component": "ContentPinAction", "placement": "left", "when": { "role": ["user", "assistant"] }, "order": 30 }],
    "languages": [ ...四语言 pinColors 资源... ]
  }
}
```

不声明 `permissions`——只用核心默认能力（config、sessions.list、events）。不声明 `dependsOn: ["timeline"]`——内容钉对 timeline 缺席静默降级（锚点落空不渲染、scrollTo 入队不投递、messageActions 无人消费），把生命周期绑死换来的只是"钉还在但没地方显示"，无意义（content-pins.md QA 有完整论证）。

### 7.2 模块三分

```
src/plugins/sessions/session-colors/
├── plugin.json
├── DESIGN.md
├── core/
│   ├── pin.ts          # 纯 TS:Pin/ContentPin 类型、PALETTE、messagePreview、
│   │                   #   groupContentPins(面板聚合口径)、backfillPreviews(旧数据补填)
│   └── pin.test.ts     # 裸单测(vitest)
├── renderer/
│   ├── index.tsx       # SessionColorsPanel + Overlay + ContentPinAction + 钉组件
│   ├── pin-svg.tsx     # 图钉 SVG(三处共用)
│   └── pin-store.ts    # zustand store
└── locales/{zh-CN,zh-TW,en,de}/pinColors.json
```

core/ 纯 TS：不 import react、不碰 ctx，可裸单测——聚合口径、补填规则、预览语义这些业务判定全收在这里，renderer 只渲染。

### 7.3 store 形状

```typescript
interface PinStoreState {
  selectedColor: string | null;   // null = 非钉入模式
  pins: Record<string, Pin[]>;
  contentPins: Record<string, ContentPin[]>;
  pinMode: boolean;               // = selectedColor !== null
  pinsVisible: boolean;
  loaded: boolean;
  lastUsedColor: string;          // 快捷入口记忆,不持久化
  // setPins / setContentPins / selectColor / togglePinsVisible /
  // addPin / removePin / addContentPin / removeContentPin / toggleContentPin / setLoaded
}
```

store 是唯一的事实源：面板、Overlay、快捷入口都读写它；config 只是它的持久化投影（Overlay 单点写盘，§4.2）。

### 7.4 依赖面

只从 `@my-harness-desktop/react` 和 `@my-harness-desktop/contract` 引用，不直连 `src/` 内层：

- `usePluginContext()` — config 读写、sessions.list、events.invoke。
- `useUiStore` — currentCwd、currentSessionPath、activeView、setCurrentSessionPath/setSessionTitle（打开会话）。
- `useSessionStore` — messages（钉入快照解析、面板聚合、backfill）、openSession。
- DOM 锚点 `data-session-path` / `data-message-id` — 宿主插件的公开渲染产物（§3.2）。
- `timeline:scrollTo` — invoke 定向分派，调用方不需要 channel 权属。

## 8 生命周期与时序

**冷启动**：plugins-host 加载 renderer module → 框架按 manifest 自动匹配 `SessionColorsPanel` / `ContentPinAction` 注册进槽 → `PluginOverlays` 挂载 `Overlay` → Overlay 读 config 进 store。此时宿主行可能还没渲染（sessions-list 也在异步拉数据）——`querySelector` 落空是正常的，MutationObserver 在宿主出现时触发重扫自动补上。两个插件挂载顺序不保证，两种顺序都 safe。

**宿主增删**：行/消息的增删（新建会话、删除、Virtuoso 滚动重建、折叠展开）由 observer 捕获，重扫后钉随宿主出现/消失。config 数据不动——宿主可能只是暂时不在视图里。

**切项目**：`currentCwd` 变化 → 旧项目宿主全部移出 DOM、新项目宿主进入 → observer 触发重扫，旧项目的钉静默收起，新项目的钉出现。config 不清不重载，DOM 是天然过滤器。面板的会话元数据随 `currentCwd` 重拉。

**切会话**：内容钉的渲染目标随 `currentSessionPath` 换桶（contentPins 按 path 分桶），扫描目标自然换，不需要清数据。面板内容钉段的当前会话组随之切换，其他会话组不变。

## 9 QA

**Q：钉入模式下点宿主，会触发宿主原来的交互吗（切会话/选文本）？**

不会。捕获相 pointerdown 整体截停并 preventDefault，宿主的 onClick / 拖拽手势 / 文本选择都收不到事件；捕获相 click 监听兜底二次截停。退出模式后一切恢复。

---

**Q：config 写盘失败，图钉数据会怎样？**

store 先更新（UI 立即响应），写盘是 fire-and-forget。pin 是视觉标注不是关键数据，不做回滚：当前看到的永远是对的，极端情况下次重载回退到上次成功写入的状态，用户最多重新钉一次。

---

**Q：会话文件重命名/移动后，钉数据怎么办？**

path 是唯一锚点，path 变了关联就断：旧 path 数据成孤儿（静默不显示），新 path 没有数据。不用会话 id 做 key——拿 id 要解析会话文件内容，插件不该碰会话文件。已知限制。

---

**Q：多个 Electron 窗口时，图钉会怎样？**

每个 renderer 有独立的 store 和 Overlay，config 文件共享但不实时同步。窗口 A 钉了，窗口 B 要重载才看到。pin 操作低频，不做多窗口同步。

---

**Q：sidePanel Tab 关闭后，图钉会消失吗？**

不会。Overlay 由框架常驻挂载（§4.1），与面板 Tab 生命周期无关——Tab 关闭只是面板视图卸载，钉在宿主上的图钉、config 读写、钉入模式全部照常。这正是 Overlay 结构存在的理由。

---

**Q：色板为什么是 7 个颜色？能自定义吗？**

7 色参考 Catppuccin Mocha 选取，硬编码不走主题系统（图钉是私有标注不是界面配色）。当前不支持自定义——拾色器的交互复杂度与"钉一个图钉"的轻量定位不符。有需求时色板可以从 config 读，那是扩展不是当前设计。

---

**Q：为什么图钉颜色不走主题 token？**

主题 token 管界面配色（会变的、全局的），图钉颜色是用户私有标注（跨主题稳定的、个人的）。换主题不该让"红色=我在调试"的个人语义变色。色板是插件内容，写死在插件里合规——机制与内容分离管的是内核，插件本来就是内容的家。
