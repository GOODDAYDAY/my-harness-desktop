# session-colors 插件技术文档

session-colors（会话图钉）是会话域里唯一一个"纯视觉标记"插件：它给会话行和会话流消息钉带颜色的图钉，钉在用户点击的任意位置，跟着宿主元素走。它不改变会话状态、不影响会话列表排序、不参与 pinned/archived 那套语义、不写任何内核存储——它只干一件事：让用户一眼认出"这个会话/这条消息我标过"，并且随时回得去。两个挂载面共用同一个抽象：会话行钉（`Pin`）标"哪个会话值得回"，消息内容钉（`ContentPin`）标"会话里哪条内容值得回"，色板同组、钉入同模态、动画同参数、同色替换同规则，差异只在落点与锚点 key（`sessionPath` vs `messageId`）。它是五个插件里代码量最大、机制最深的一个（783 行 renderer + 纯逻辑层 + 完整 DESIGN.md），也是"插件自管数据与渲染、经 portal 钉进别的插件的 DOM"这一手法的示范样本。

## 1 职责与边界

- 职责一句话：**纯视觉的位置标记**。图钉是"只给自己看"的标注，与 pinned（二值、会话级、走会话头）不同，图钉带颜色、带位置、带预览；与书签（完整 JSONL 拷贝 + fork 语义）不同，图钉是轻量视觉标记，不保存节点、不重启；与 review（给模型的输入通道）不同，图钉不进模型上下文。
- 自管数据和渲染：数据走插件统一 config 通道（`ctx.config.get/set/all`），按会话路径索引；渲染经 `createPortal` 钉进宿主元素，不侵入 sessions-list / timeline 的组件树。不碰内核：不改 `SessionInfo`、不加 IPC 通道、不加槽位（DESIGN.md §1.3）。
- 依赖严格向内：`renderer/index.tsx` 从 `@my-harness-desktop/react` 取 `useUiStore` / `usePluginContext` / `useSessionStore` / `PluginContext` / `SessionInfo` / `MessageActionProps`，从 `@my-harness-desktop/shared` 取 `deriveSessionTitle` 与 `messageContentText`（后者在 `core/pin.ts` 里 import），`core/pin.ts` 只 import `messageContentText` / `NeutralMessage` 类型——无任何壳后端、内核实现 import。
- `core/` 纯 TS 层（不 import react、不碰 ctx、可裸单测）是它的架构亮点：聚合口径、补填规则、预览语义这些业务判定全收在 `core/pin.ts`，renderer 只渲染。这是 §3.3"框架管通用、特化归外层"在插件内部的一次自我复制——把会变的推导收成纯函数，渲染层只剩画。
- 无 `pi-extension/`、无 `dsh-extension/`：图钉是壳层 UI 能力，不补任何内核能力，不向内核索要任何新操作，只需核心默认能力（config / sessions.list / events）。

## 2 目录与文件清单

```
src/plugins/sessions/session-colors/
├── plugin.json
├── DESIGN.md            # 完整设计文档（289 行，本文的参照真相源）
├── core/
│   ├── pin.ts           # 纯 TS：Pin/ContentPin 类型、PALETTE、messagePreview、
│   │                    #   groupContentPins（面板聚合口径）、backfillPreviews（旧数据补填）
│   └── pin.test.ts      # 裸单测（vitest，覆盖 messagePreview/groupContentPins/backfillPreviews）
├── renderer/
│   ├── index.tsx        # SessionColorsPanel + Overlay + ContentPinAction + 钉组件（783 行）
│   ├── pin-svg.tsx      # 图钉 SVG（PinSVG，面板/鼠标跟随/钉入渲染三处共用）
│   └── pin-store.ts     # zustand store（PinStoreState）
└── locales/{zh-CN,zh-TW,en,de}/pinColors.json
```

- `plugin.json` 贡献三个槽：`sidePanel` 一项 `{ id: "session-colors", label: "图钉", icon: "pin", component: "SessionColorsPanel", order: 80 }`，`messageActions` 一项 `{ id: "contentPin", component: "ContentPinAction", placement: "left", when: { role: ["user", "assistant"] }, order: 30 }`，`languages` 四项（四 locale 的 `session-colors.pinColors` 命名空间）。
- `renderer/index.tsx` 一个文件装了六个导出物：`SessionColorsPanel`（sidePanel 面板）、`Overlay`（框架常驻挂载点，见 §7）、`ContentPinAction`（messageActions 快捷入口）、以及三个内部组件 `PinnedSessionRow` / `ContentPinRow` / `RowPins` / `PinElement`（内部用，不 export 给框架）。
- `core/pin.test.ts`（108 行）是纯逻辑层的裸单测，`groupContentPins` 的五个断言（孤儿钉不列、display=false 不列、其他会话按 projectPaths 序、当前会话恒在最前、颜色过滤）与 `backfillPreviews` 的三个断言（补填/不触发写盘/孤儿返回 null）把聚合口径的语义钉死在测试里——这是"业务判定收进纯函数层"的配套验证。

## 3 plugin.json 与贡献的槽

- `sidePanel` 槽：`SidePanelContribution`（`packages/shared/src/domain/contributions.ts` 第 81 行）`{ id, label, icon, component, order?, revealOn? }`。session-colors 贡献 `SessionColorsPanel`，`order: 80` 排在会话树（order 40）之后。不声明 `revealOn`——面板是用户主动切 Tab 打开，不是被事件触发揭示的。
- `messageActions` 槽：`MessageActionContribution`（第 170 行），`{ id: "contentPin", component: "ContentPinAction", placement: "left", when: { role: ["user", "assistant"] }, order: 30 }`。`when.role` 是 `["user", "assistant"]`（比 continue/retry 的只 assistant 更宽——用户消息也能钉），`order: 30` 比 continue 的 40、retry 的 50 更靠左，是消息行上最左的动作按钮。
- 不声明 `permissions`（只用核心默认能力 config / sessions.list / events），不声明 `dependsOn: ["timeline"]`——DESIGN.md §7.1 有完整论证："内容钉对 timeline 缺席静默降级（锚点落空不渲染、scrollTo 入队不投递、messageActions 无人消费），把生命周期绑死换来的只是钉还在但没地方显示，无意义"。这是"dependsOn 按需声明、不滥用"的示范：只有真正消费对方 channel（on/invoke）才声明，只是渲染产物落空不声明。

## 4 数据模型：Pin / ContentPin / 配置键

- 两种钉的纯类型定义在 `core/pin.ts`：`Pin`（第 6 行）`{ id, color, x, y }` 是会话行钉，`ContentPin`（第 15 行）`{ id, messageId, color, x, y, preview? }` 是消息内容钉——两者同族不同挂载面，`ContentPin` 多了 `messageId`（锚点 = JSONL 行级 id）与 `preview`（钉入时刻的消息文本快照，前 30 字）。
- `preview` 字段（第 21 行注释）是跨会话面板"零读取通道"的关键：面板跨会话列出内容钉时，若没有 preview 就得去读别的会话的消息，有了 preview 就能直接显示。旧数据无此字段时，回到该会话由 `backfillPreviews` 惰性补填。
- `CONTENT_PIN_DEFAULT = { x: 97, y: 6 }`（第 26 行）是快捷入口（`ContentPinAction`）钉入的默认位置——右上角固定常量，因为快捷入口要的是"快"（一拍完成），不要位置自由（位置自由走主入口）。
- `PALETTE`（第 28–31 行）是 7 色固定色板：`["#f38ba8", "#fab387", "#f9e2af", "#a6e3a1", "#89b4fa", "#cba6f7", "#f5c2e7"]`，选型取向与 Catppuccin Mocha 一致。**不走主题 token**（DESIGN.md §3.4）：主题 token 管界面配色（会变的、全局的），图钉颜色是用户私有标注（跨主题稳定的、个人的），换主题不该让"红色=我在调试"的个人语义变色。色板是插件内容，写死在插件里合规。
- 三个 config 键（DESIGN.md §2.1）：`"pins"`（行钉，`Record<sessionPath, Pin[]>`）、`"contentPins"`（内容钉，`Record<sessionPath, ContentPin[]>`）、`"pinsVisible"`（全局显隐开关，唯一写全局层的键，`set` 的 `scope: "global"`）。key 是会话文件绝对路径（`SessionInfo.path` / `useUiStore.currentSessionPath`），path 天然按项目隔离（不同项目前缀不同，自动分桶）。
- 百分比坐标而非像素（DESIGN.md §2.2）：会话行宽受窗口/侧栏拖宽影响，消息高受流式/折叠/字号影响，像素坐标一变形就错位；百分比相对宿主渲染尺寸，宿主变宽变窄变高图钉按比例跟随，零 JS 参与。
- 同色替换规则（DESIGN.md §2.3）：同一宿主同一颜色只保留一个图钉，再点同色新位置旧钉弹飞新钉落下，不是叠加也不是 toggle。行钉按"同 sessionPath 同 color"替换，内容钉按"同 messageId 同 color"替换。实现是 store 里先过滤同色再 push（`addPin` / `addContentPin`，pin-store.ts 第 42–45 / 57–63 行）。

## 5 core/pin.ts：纯逻辑层的三个业务判定

- `messagePreview(m)`（第 35 行）：`messageContentText(m.content).replace(/\s+/g, " ").trim().slice(0, 30)`，无文本时退 `i18nKey`，再退 `role`。它与 messageActions 的 rowText 同语义（`messageContentText` 单源），空白折叠后截前 30 字。测试覆盖"内容块数组只取 text 块"与"无文本退 i18nKey 再退 role"（pin.test.ts 第 22–34 行）。
- `groupContentPins(...)`（第 60 行）是面板跨会话聚合口径，输入 `(contentPins, currentSessionPath, currentMessages, projectPaths, colorFilter)`，输出 `ContentPinGroup[]`。当前会话口径 = 渲染口径（`messageId` 须在 `currentMessages` 里且 `display !== false`，孤儿钉不列，按消息序排序）；其他会话只保留在 `projectPaths` 里的，按 `projectPaths` 顺序，孤儿钉跨会话不可判定故保留列出；`colorFilter` 非 null 时按色过滤，空组不列；当前会话组恒在最前（即使不在 `projectPaths`，列表异步未达时）。
- `backfillPreviews(pins, messages)`（第 96 行）：旧数据缺 `preview` 的钉从当前 messages 解析写回，返回补填后的新数组；无可补（无缺 preview 的钉，或缺 preview 的钉在当前消息里都找不到）时返回 `null`，调用方据此跳过写盘（不触发无意义的投影落盘）。
- `ContentPinEntry` / `ContentPinGroup`（第 42 / 48 行）是聚合的输出类型：`ContentPinEntry = { pin, message? }`（`message` 仅当前会话分组解析，供实时预览与排序），`ContentPinGroup = { path, isCurrent, entries }`。
- 这三个纯函数是插件"渲染层只消费不推导"的载体：`SessionColorsPanel` 里 `contentGroups = useMemo(() => groupContentPins(...), [...])`（renderer/index.tsx 第 188 行）直接消费，不自己写聚合逻辑。`useMemo` 依赖 `[contentPins, currentSessionPath, messages, projectPaths, activeFilter]`，聚合只在输入变化时重算。

## 6 渲染机制：portal 钉进宿主元素

- 图钉不是画在 viewport 上的浮层，而是经 `createPortal` 渲染为宿主元素的**子元素**（DESIGN.md §3.1）：每个宿主挂一个 `RowPins` 容器（`position: absolute; inset: 0`，宿主是 `position: static` 时先补 `relative`），图钉用 `left: x%; top: y%` 相对宿主定位。`RowPins`（renderer/index.tsx 第 701 行）是 portal 到宿主 `el` 的容器，`PinElement`（第 722 行）是单颗钉。
- 为什么不用 viewport overlay（DESIGN.md §3.1 的历史教训）：早期实现是采样模型——`getBoundingClientRect()` 采样宿主位置，scroll/observer/resize 触发坐标重算。死穴在 framer-motion 的 transform 补间动画（sessions-list 行重排是 `motion.div layout` 补间）：补间期间 `childList` 和属性都不变，observer 无感，图钉冻结在旧坐标，动画结束才跳。钉进宿主后这一切消失：行重排、滚动、虚拟滚动重建、流式撑高，图钉由浏览器原生跟随（宿主子元素），零坐标重算；宿主卸载图钉随之消失，重挂自动回来。
- 挂载追踪只维护两张映射、不算坐标（DESIGN.md §3.2）：`sessionPath → 行元素`、`messageId → 消息元素`。扫描两个触发源：**数据触发**（store 钉数据变化 → effect 重跑立即重扫，钉入瞬间反馈走这条路）；**DOM 触发**（`MutationObserver` 以 `childList + subtree` 观察宿主容器，捕获宿主增删——Virtuoso 滚动重建、折叠展开、切会话/切项目，RAF 合并一帧后重扫）。scroll/resize/transform 补间一律不观察（那些运动图钉作为子元素由浏览器原生跟随）。
- 容器重锚（DESIGN.md §3.2）：每轮扫描后按当前实际宿主反查容器——行容器 = `document.querySelector("[data-session-path]")?.closest(".overflow-y-auto")`，消息容器 = `document.querySelector("[data-message-id]")?.closest("[data-virtuoso-scroller]")`，拿现有宿主元素反查，不假设容器 class（业务 class 不作契约）；找不到兜底观察 `document.body`；容器身份变化断开旧 observer 重建。不能直接 `querySelector(".overflow-y-auto")` 取首个（文档里多个同名滚动容器，DOM 序是运气不是契约）。
- 命中比对防重渲染（renderer/index.tsx 第 625–640 行）：扫描结果与现存映射逐键比对元素身份，没变不 setState——虚拟滚动下大多数扫描结果与上轮相同，这条路把重渲染压到接近零。
- **DOM 锚点是唯一的插件间接口**（DESIGN.md §3.2）：`data-session-path`（sessions-list 行）与 `data-message-id`（timeline MessageRow）是标准 DOM 属性，任何需要按 path/messageId 定位元素的代码都能用。session-colors 不调任何插件的接口，两个宿主插件也不知道谁在消费这些属性——DOM 是公开的渲染产物，和 CSS class 一个性质。
- 图钉组件 `PinSVG`（pin-svg.tsx）是 SVG：椭圆头部 + 高光椭圆 + 针杆 + 针尖分叉，viewBox `0 0 22 26`，针尖约 `(11, 24)`，钉入时 `transform: translate(-11px, -22px)` 使针尖对齐记录坐标。钉入动画 framer-motion spring（`stiffness: 500, damping: 12, mass: 0.6`），拔出 350ms easeIn。**动画只播一次**：模块级 `attachedOnce: Set<pinId>`（renderer/index.tsx 第 698 行）登记播过钉入动画的钉，重挂载 `initial: false` 静息出现，不再弹跳。

## 7 Overlay：框架常驻挂载点

- `Overlay`（renderer/index.tsx 第 484 行）是插件的**第二个框架挂载点**，与 `SessionColorsPanel`（sidePanel Tab）并列。为什么常驻（DESIGN.md §4.1）：图钉的渲染和持久化不能绑在面板生命周期上——面板 Tab 一关，钉在行上的图钉不能消失（宿主还在），config 读写也不能停。
- 框架的 `PluginOverlays`（`packages/react/plugin-overlays.tsx`）统一挂载：遍历已加载插件，凡 module 有 `Overlay` 导出就渲染，每个 overlay 包一层 `PluginIdContext.Provider`（注入 pluginId）加独立 `ErrorBoundary`（单插件悬浮层崩溃只摘除自己）。插件不声明、不注册——有 export 就挂，机制对所有插件平等。
- `Overlay` 承担三件事（DESIGN.md §4.2）：config 读（首次挂载 `loadPins`/`loadContentPins`/`loadVisibility` 进 store，`loaded` 标记防重读）；store → config 投影写盘（`usePinStore.subscribe` 比对前后状态，pins/contentPins 写项目级、pinsVisible 写全局层，跳过订阅首次触发避免刚读出的内容原样写回）；图钉渲染与钉入模态（挂载追踪、portal 渲染、window 监听全在 Overlay）。面板只是 store 的视图，写盘出口唯一。
- 历史教训（DESIGN.md §4.3）：早期 Overlay 是插件模块加载时自己 `createRoot` 挂到 `document.body`，独立 root 拿不到框架经 React Context 注入的 `PluginIdContext`，`usePluginContext()` 得到默认空 pluginId，main 侧 config 白名单校验直接拒绝，写盘被 fire-and-forget 吞掉，表现为静默丢数据（真实发生过的 bug）。框架 Overlay 挂载点就是这次事故的制度化修复：pluginId 由框架注入，插件无法绕过。红线是"config 读写只发生在框架注入 pluginId 的组件树内"。
- 写盘点（renderer/index.tsx 第 512–520 行）：`usePinStore.subscribe((state, prev) => { if (first) { first = false; return; } if (state.pins !== prev.pins) persistPins(...); ... })`——store 变化触发投影写盘，`first` 跳过首次。`persistPins` / `persistContentPins` 是 `void ctx.config.set("pins", pins)`（第 43–49 行），fire-and-forget。

## 8 交互流程：选色 → 钉入模式 → 落点分派

- 选色进入钉入模式（DESIGN.md §5.1）：面板选一个颜色 → `selectColor(color)` → `pinMode = color !== null`（pin-store.ts 第 35–40 行 `selectColor` 同时置 `selectedColor` 与 `pinMode`，并把 `lastUsedColor` 更新为当前色）。模式信号：鼠标带图钉预览（`position: fixed` 跟随 div，`pointer-events: none`），可钉宿主 hover 显虚线轮廓（注入 style 标签对 `[data-session-path]:hover` / `[data-message-id]:hover` 生效）。
- 钉入模式 = **指针模态**（DESIGN.md §5.1）：window 捕获相监听 `pointerdown` / `click` / `contextmenu`，`document.elementFromPoint` 判落点，落在宿主上的交互整体截停——行的 onClick（切会话）、SortableList 拖拽手势、Radix 右键菜单一律不触发。不逐个事件堵、不依赖宿主实现，模态语义一处收编。监听 `pointerdown` 而非 `mousedown`：SortableList 已 preventDefault pointerdown 压选区，平台语义连带抑制兼容性鼠标事件，window 级 mousedown 永远收不到。
- 落点分派（renderer/index.tsx 第 533–567 行 `onDown`）：命中已有图钉（`data-session-colors-pin`）→ 只防拖拽，click 放行给拔出；命中 `[data-message-id]` 祖先 → 算消息内百分比坐标，`addContentPin`（含 preview 快照）；命中 `[data-session-path]` 祖先 → 算行内百分比坐标，`addPin`；都不命中 → 不拦。兜底：click 由 pointerup 独立派生，捕获相 click 监听二次截停（第 569–576 行 `onClickCapture`）。
- 退出模式四条路径（DESIGN.md §5.2）：Esc 键、右键（捕获相截停并退出）、再点选中色（toggle）、切出 chat 视图（`activeView` 离开 `"chat"` 时 effect 自动退，renderer/index.tsx 第 91–93 行）。右键退出（第 578–582 行 `onContext`）里 `e.preventDefault(); e.stopPropagation(); exitPinMode();`。
- 拔出（DESIGN.md §5.3）：点击已钉图钉 → 弹飞动画 350ms → 从 store 移除。图钉自身 `pointer-events: auto`、钉层容器 `pointer-events: none`，只有钉本身接收点击。拔出不退出钉入模式（第 728–733 行 `handleClick` 里 `e.stopPropagation(); setPopping(true); setTimeout(onRemove, 350)`）。
- 快捷入口 `ContentPinAction`（renderer/index.tsx 第 762 行）：显式 toggle——该消息已有 `lastUsedColor` 颜色的钉则拔出，否则钉入默认位置（`CONTENT_PIN_DEFAULT`）。`lastUsedColor` 是内存态（不持久化，冷启动回色板首色），只是快捷入口的便利记忆。快捷入口要快、主入口要位置精确，两个入口产出同一种数据，面板和渲染不感知来源。

## 9 面板：回航索引

- `SessionColorsPanel`（renderer/index.tsx 第 69 行）骨架：标题行（含全局显隐眼睛开关 `togglePinsVisible`）、提示行（`pinMode` ? `hintActive` : `hintIdle`）、色板行（每色按钮带数量角标，点角标清该色全部钉，全清按钮）、颜色过滤 tab、列表区。
- 列表区两段（DESIGN.md §6）：**行钉段**列带行钉的会话卡片（会话名、最后消息、色点行 hover 显 × 移除、定位按钮滚到侧栏该行并高亮 600ms、点卡片打开会话），列出口径 = 行须在当前侧栏 DOM 可见（`visiblePaths`，折叠组内的行不列）；**内容钉段**跨会话索引按会话聚合（当前会话组恒在最前、渲染口径、按消息序，其他会话按项目顺序、组头显会话名），点击两段式导航（当前会话直接滚、其他会话先打开再滚）。
- 会话元数据收编框架 store（renderer/index.tsx 第 84–88 行注释）：数据源 = `useSessionStore.sessionInfos`（框架拉取 + 事件维护），不再自己 `ctx.sessions.list`——修掉"挂载拉一次即 stale"的老问题（会话改名后钉子名不更新，切走再切回才恢复）。
- 打开会话 `handleOpenSession`（第 123–137 行）：`useUiStore.getState().setCurrentSessionPath(path)` + `setSessionTitle(deriveSessionTitle(info))` + `await useSessionStore.getState().openSession(path)`，失败（文件已删/不可读）回滚选中态，不留指向失效会话的残局。
- 定位消息 `onLocateMessage`（第 202–204 行）：`ctx.events.invoke("timeline:scrollTo", { messageId })`，包 try/catch（timeline 未加载时 channel 未注册）。跨会话导航两段式 `handleOpenAndLocate`（第 208–212 行）：先打开会话（失败即止），再 scrollTo——timeline 的 `pendingScrollRef` 兜底接得住 messages 尚未渲染的时序。
- 旧数据预览惰性补填（第 195–200 行）：`backfillPreviews(contentPins[...], messages)` 返回非 null 时写回 store，Overlay 投影落盘——下次跨会话列出即有预览。

## 10 与其他插件/槽位交互（专节）

- **贡献的槽位名**：`sidePanel`（`SessionColorsPanel`，`id: "session-colors"`，`order: 80`）、`messageActions`（`ContentPinAction`，`id: "contentPin"`，`placement: "left"`，`when: { role: ["user", "assistant"] }`，`order: 30`）、`languages`（四 locale 的 `pinColors` 命名空间）。
- **dependsOn**：**无**。这是刻意的（DESIGN.md §7.1）：内容钉对 timeline 缺席是静默降级（DOM 锚点落空不渲染、`timeline:scrollTo` invoke 入队不投递、`messageActions` 无人消费），把生命周期绑死换来的只是"钉还在但没地方显示"。凡真正消费别人 channel（on/invoke）才声明 dependsOn，只是渲染产物落空不声明——这是 dependsOn 纪律的精准用法。
- **invoke 的 channel 名**：`timeline:scrollTo`（renderer/index.tsx 第 203 行 `ctx.events.invoke("timeline:scrollTo", { messageId })`）。这是 timeline 插件拥有的 channel，session-colors 经 `invoke` 定向分派（调用方不需要权属，§8.2）。timeline 缺席时 `invoke` 抛"channel 未被任何已加载插件注册"（event-bus.ts 第 140 行），被 try/catch 吞掉——这正是"不声明 dependsOn 也能安全降级"的原因。
- **消费的 DOM 锚点（插件间松耦合接口）**：`data-session-path`（sessions-list 行的公开渲染产物）与 `data-message-id`（timeline MessageRow 的公开渲染产物）。session-colors 经这两个属性定位宿主，不调 sessions-list / timeline 的任何函数，宿主插件也不知道谁在消费——DOM 是公开产物，与 CSS class 同性质（DESIGN.md §3.2）。
- **消费的框架 API 与 store**：`ctx.config.get/set/all`（统一配置通道）、`ctx.events.invoke`（事件总线）、`useUiStore`（currentSessionPath / currentNeutralSessionId / activeView / setCurrentSessionPath / setSessionTitle）、`useSessionStore`（messages / sessionInfos / openSession）、`deriveSessionTitle` / `messageContentText`（圆心纯函数）。
- **不贡献、不消费的能力**：无 `permissions` 声明、无 `pi-extension`/`dsh-extension`、不 export 自己的 `channels`（只 invoke 别人的）、不写任何内核存储。它是"消费型 UI 插件"的极致：全部输入来自框架 store + config + DOM + 圆心纯函数，全部输出是 portal 渲染 + config 投影 + invoke 命令。

## 11 QA

**Q：sidePanel Tab 关闭后，图钉会消失吗？**

不会。`Overlay` 由框架 `PluginOverlays` 常驻挂载（§7），与面板 Tab 生命周期无关——Tab 关闭只是 `SessionColorsPanel` 卸载，钉在宿主上的图钉、config 读写、钉入模式全部照常。这正是 Overlay 结构存在的理由：渲染和持久化不能绑在面板生命周期上。

**Q：钉入模式下点宿主，会触发宿主原来的交互（切会话/选文本）吗？**

不会。捕获相 `pointerdown` 整体截停并 `preventDefault`，宿主的 onClick / 拖拽手势 / 文本选择都收不到事件；捕获相 `click` 监听兜底二次截停。退出模式后一切恢复。代价是钉入模式下消息区不能划选复制、不能点链接——模态的固有代价，模式短暂。

**Q：会话文件重命名/移动后，钉数据怎么办？**

path 是唯一锚点，path 变了关联就断：旧 path 数据成孤儿（静默不显示），新 path 没有数据。不用会话 id 做 key——拿 id 要解析会话文件内容，插件不该碰会话文件（DESIGN.md QA）。已知限制。

**Q：为什么图钉颜色不走主题 token，写死 7 色？**

主题 token 管界面配色（会变的、全局的），图钉颜色是用户私有标注（跨主题稳定的、个人的），换主题不该让"红色=我在调试"的个人语义变色。7 色参考 Catppuccin Mocha 选取，硬编码是插件内容（机制与内容分离管的是壳，插件本来就是内容的家）。自定义拾色器与"钉一个图钉"的轻量定位不符，有需求时色板可从 config 读。

**Q：多个 Electron 窗口时，图钉会怎样？**

每个 renderer 有独立的 store 和 Overlay，config 文件共享但不实时同步。窗口 A 钉了，窗口 B 要重载才看到。pin 操作低频，不做多窗口同步（DESIGN.md QA）。

**Q：config 写盘失败，图钉数据会怎样？**

store 先更新（UI 立即响应），写盘是 fire-and-forget。pin 是视觉标注不是关键数据，不做回滚：当前看到的永远是对的，极端情况下次重载回退到上次成功写入的状态，用户最多重新钉一次。
