# 005 右侧栏：sidePanel 槽、尺寸模型与风格系统

> ⚠ **历史稿**：本文是 pre-多内核 的 pi-only 旧术语稿（"底座"/旧"内核"=壳机制），术语与架构以 CLAUDE.md + kernel-design-spec.md + core-spec.md 为准，本文保留作历史参考。

## 1. sidePanel 是什么

sidePanel 是内核预定的右侧面板槽位。插件往这个槽里贡献"工具页"——会话树、Git review、文件树、Token 统计等——每一页都是一个自包含的 React 组件，由内核在右侧纵向堆叠渲染。

和左侧栏 sidebar 的差异根因是**内容控制权的分界线位置不同**：

- **左栏**：内核控制了大约 90% 的视觉结构——每一行都是 icon + label + actions 的相同布局，每个分组都是标题栏 + 折叠内容。内核定了"行是什么""组是什么"，插件只往里面灌数据。因此左栏可以做统一的 5 种风格切换（`data-sidebar-style`），所有列表行同步变化，插件不需要知道自己是什么风格。

- **右面板**：内核只控制了四个壳层部分——面板头（icon + label 的点击栏）、图标条（左侧竖排 icon 按钮）、内容容器（`overflow-y-auto` 的滚动区）、分隔线（PanelResizeHandle）。每个插件的面板内容区，内核只提供了一层 padding 容器。在这个容器里面，插件的草稿纸是空白的。11 个插件往这张草稿纸上画的内容完全不同——`git-review` 画的是文件列表 + diff 视图，`token-stats` 画的是统计卡片，`session-tree` 画的是树状节点——内核不可能像左栏那样用一个"行"的抽象覆盖所有。

这个差异不是架构缺陷，是右面板内容多样性的必然结果。弥合方向不是让内核变厚去覆盖所有插件的内部布局（那违反薄壳纪律），而是给插件提供一套"框架提供、插件消费"的基础组件和风格 token 系统——详见 `docs/design/panel-style-system.md`。

## 2. 贡献契约

### 2.1 类型定义

圆心 `src/core/domain/contributions.ts` 的 `SidePanelContribution`：

```typescript
export interface SidePanelContribution {
  id: string;        // 贡献 id（插件内唯一）
  label: string;     // 图标 tooltip 文字
  icon: string;      // lucide 图标名
  component: string; // renderer 侧组件 export 名
  order?: number;    // 图标条排序，小的在上（缺省 100）
  revealOn?: string; // 声明式揭示：该 channel 被 emit/invoke 时展开并激活此 tab
}
```

### 2.2 注册与优先级

注册表 `src/core/application/loader/registry.ts` 的 `sidePanel` 字段用 `ArraySlot<SidePanelContribution>` 管理。注册语义：

- **覆盖**：同 `contribution.id` 项后注册者覆盖先注册者（`removeById` 再 `push`）。
- **排序**：`sidePanelItems()` 方法按 `order` 升序返回；同 order 时按注册顺序（`builtin → installed → user → project`，后注册者排在后面）。
- **优先级**：bootstrap 注册序 `builtin → installed → user → project` 保证用户/项目级插件可覆盖内置同名贡献，满足无特权差异纪律。

### 2.3 组件自动匹配

插件不手写 `registerSidePanelComponent`。框架加载 renderer module 后，读 manifest 的 `contributes.sidePanel[].component` 字段，在 module 的 exports 里找同名组件，自动注册。插件只 export 组件即可——验证方式见 `right-panel.tsx` 第 443 行的 `getSidePanelComponent(item.component)`。

### 2.4 revealOn：声明式揭示

`revealOn` 字段实现了一种声明式路由：当某个事件 channel 被 emit 或 invoke 时，框架自动展开右面板并激活对应的 tab。触发方不认识贡献者，贡献者的代码不出现自己的 contribution id——框架居中撮合。

实现链路极短。`SidePanelStrip`（`right-panel.tsx` 第 114-125 行）在 mount 期读所有 sidePanel 贡献项的 `revealOn`，建一个 `channel → tabId` 的映射表，然后挂到事件总线的 `tap` 上：

```typescript
const byChannel = new Map<string, string>();
for (const item of items) {
  if (item.revealOn) byChannel.set(item.revealOn, item.id);
}
return eventBus.tap((channel) => {
  const tabId = byChannel.get(channel);
  if (tabId) activateSidePanelTab(tabId);
});
```

`eventBus.tap`（`packages/react/src/event-bus.ts` 第 34-37 行）是一个框架内部的观察者钩子：任何 `emit` / `invoke` / `emitSystem` 派发前同步触发 tap 回调，无需插件注册 channel。它不参与 pub/sub——只是旁听。

`activateSidePanelTab`（`src/api/renderer/stores/ui-store.ts` 第 257-262 行）是"揭示语义"的 setter——与 `toggleSidePanelTab` 的差异是它不做反向关闭：tab 不在活跃集则补入，已在则无事；同时确保 layout store 的 right 组展开（`setGroupHidden("right", false)`）。

当前唯一消费者：`session-bookmarks` 插件声明 `revealOn: "timeline:bookmarkRequested"`——timeline 插件在右键菜单点击"收藏"时 `emit("timeline:bookmarkRequested", {...})`，session-bookmarks 不用知道 timeline 的存在，也不用在代码里出现自己的 contribution id，只需在 manifest 声明一行 `revealOn`。

## 3. 壳层机制

### 3.1 物理结构：两层独立组件

右面板由两个独立组件组成，它们的物理位置和生命周期独立：

- **`SidePanelStrip`**（`right-panel.tsx` 第 84-156 行）：右侧 48px 宽的竖排图标条，**不在 PanelGroup 内**——它是 `ChatView`（`src/api/renderer/index.tsx` 第 30 行）的 `LayoutEngine` 兄弟节点。这样做的原因是：right 组 `hidden` 时内容区折叠为 0，但图标条必须永远可见——它是重新展开右面板的入口。放进树里会随组一起折叠。

- **`RightPanelContent`**（`right-panel.tsx` 第 249-522 行）：右面板内容区，由布局引擎在 right 组中渲染（经动态布局树的 `shell:sidePanel` 内建视图）。内部是一个纵向 `PanelGroup`（`react-resizable-panels`），每个活跃 tab 是一个可缩放 Panel，面板间有 `PanelResizeHandle` 分隔。

### 3.2 交互模型

点击图标时有两种行为：

- 该图标对应的 tab **不在** `activeSidePanelTabs` 中 → 补入并展开 right 组（`toggleSidePanelTab` 的"加入"分支）。
- 该图标对应的 tab **已在** `activeSidePanelTabs` 中 → 移除并折叠 right 组（`toggleSidePanelTab` 的"移除"分支）。

`rightPanelOpen`（旧 ui-store 字段）的语义已迁移进 layout store 的 `setGroupHidden("right", ...)`——`activeSidePanelTabs` 为空是折叠的唯一条件（见 `ui-store.ts` 第 250-255 行的 `toggleSidePanelTab`）。图标条永远可见，内容区才受 hidden 控制。

图标条支持拖拽排序（`@dnd-kit/core` + `@dnd-kit/sortable`），拖动结束写 `general-config.json` 的 `sidePanelOrder` 键持久化。排序影响图标条的视觉顺序，不影响面板的注册优先级。

### 3.3 keep-alive 策略

`RightPanelContent` 内部渲染**所有**活跃 tab 的组件，非活跃的用 CSS `display: none` 隐藏（第 461 行 `opacity` + 内容区 `overflow-y-auto`），不卸载。这保证了 `token-stats` 的事件流订阅、`session-tree` 的 store 订阅在切 tab 时不丢失。面板收起（right 组折叠为 0）时 `react-resizable-panels` 的 `collapsedSize={0}` 不卸载子树——内容区组件保持挂载，流式会话在折叠的右面板里照样运行。

### 3.4 空态与无贡献行为

两个空态场景：

- **图标条无任何贡献插件**（`items.length === 0`）：`SidePanelStrip` 返回 `null`，右侧无图标条。
- **活跃 tab 列表为空**（`renderIds.length === 0`）：`RightPanelContent` 返回一个占满高度的 `bg-[var(--color-chrome)]` 空白 div（第 423-425 行）。

无"首次点击自动激活第一个 tab"的逻辑——`toggleSidePanelTab` 的行为是严格的 toggle，首次使用需用户主动点击图标。

### 3.5 面板头与空组件回退

每个 panel 渲染时，顶部有一个统一的"面板头"（第 463-478 行）：icon + label + 点击收起。样式全部经 CSS 变量，不硬编码。面板头下方是内容区，面板头点击同样走 `toggleSidePanelTab`——在面板头点击当前活跃 tab 的头同样会收起该 tab。

如果组件在注册表中找不到（`getSidePanelComponent` 返回 null），渲染一段 i18n 回退文案："组件未注册"（第 485-487 行）。

## 4. 尺寸模型：id 键控权重（v2）

### 4.1 v2 vs v1 的核心差异

v1 用的是 `react-resizable-panels` 的 `autoSaveId`（按位置存档到 localStorage）。问题：

1. **存档键不含板块身份**——只按位置恢复。板块顺序/构成一变（开关、拖拽 reorder），位置序和板块身份错位，旧布局被恢复到错误的 panel 上。
2. **窗口遮挡时节流会让动画中途布局落盘**——关闭动画中间帧的尺寸被持久化，重开后某 panel 吃到近 0 尺寸。
3. 为此叠了 `lastSizesRef` + "重开近 0 修复"两级补丁——但补丁的对象（位置键控存档）本身就是错的。

v2（当前实现）用一个 `Map<string, number>` 的 `weightsRef`（id 键控）取代位置存档：

```
weightsRef: Map<panelId, weight>     // 唯一数据源
渲染: Panel.defaultSize = weight(id) / Σweight(全部 renderIds) × 100
回写: PanelGroup onLayout(sizes) → 按 renderIds 序写回 weightsRef
```

核心原则：**id 键控，不键位**。板块怎么重排/增删，权重始终跟着板块走。

### 4.2 三种操作的确定规则

| 操作 | 规则 |
|------|------|
| 加板块 | 新权重 = 现存均权（Σw/n）。未拖过：精确 1/(n+1)；拖过后：新块拿平均份，旧块间比例不动 |
| 删板块 | 摘除其权重，剩余按各自权重归一等比放大——比例守恒 |
| 拖拽 | `onLayout` 把新布局按 `renderIds` 序回写成 id 权重 |

重开同板块：权重已摘除，视为新加入，拿均权（不记忆上次关闭时尺寸）。冷启动：权重表空，全部均权，恒平分。**尺寸不跨会话持久化**——重启恢复平分，避免 v1 的持久化复杂度黑洞。

### 4.3 实现面

`sizeFor(id)`（第 295-303 行）遍历本批 `renderIds`，缺权重的 id 以均权幂等填充，返回归一百分比。`syncWeights(sizes)`（第 307-313 行）是 `onLayout` 的唯一回写点——初始化、拖拽、关闭动画中间帧都经它。

## 5. 收起动画

### 5.1 设计决策

收起动画做了一个关键选择：**高度动画交给 PanelGroup 布局引擎做，不自造 CSS 高度动画**。

`react-resizable-panels` 的尺寸分配本质是 flex-grow 百分比。用 CSS 高度动画会和 PanelGroup 的布局计算打架。正确做法是用 `ImperativePanelHandle.resize(percentage)` 每帧设置 panel 百分比尺寸，PanelGroup 布局引擎自动把腾出的空间分给相邻 panel。

动画时序用 **rAF 驱动**，不用 `panel.collapse()`（collapse 动画完成没有回调，靠它就要用 setTimeout 赌时长），也不用 CSS keyframes。rAF 链的结束帧是确定性完成信号——不赌库实现，不赌 CSS 时长。

### 5.2 状态机

`renderIds` 维护 PanelGroup 渲染的 panel id 顺序（活跃 ∪ closing），`closingIds` 记录正在收起的 id，关闭动画期间 closing panel 保持**原位**（reconcile 算法插回上帧位置）。

主 effect（第 353-405 行）检测 `orderedItems` 变化：
- **移除 tab**：消失的 id 进入 `closingIds`，开始 rAF 动画。若 `panelRefs.size <= 1`（单个 panel 关闭自己），走 instant 路径——直接移除，不进 closing/rAF 流程。原因是单 panel 组 `resize()` 会触发库的 pivot 断言错误（`panelDataHelper:isLastPanel → [-1, 0]`）。
- **新增 tab**：reconcile 插入 `renderIds`。
- **closing 期间重新激活同一 tab**：从 `closingIds` 移除 → cancel effect 停 rAF → `resize` 回 `startSizes` 记录的起始尺寸。

动画参数：240ms，`easeInOutCubic` 缓动。rAF 结束帧 `finishClose`（第 317-321 行）摘除权重——onLayout 每帧已把幸存者吸收后的尺寸写回权重，移除后 re-render 按剩余权重归一，移除瞬间零跳变。

### 5.3 幂等守卫

`setClosingIds` 和 `setRenderIds` 的全部调用都有幂等守卫——内容无变化时返回原引用（`sameIds` 浅比较）。不这样做的话，closingIds 作为 effect 依赖，内容没变却返回新数组会让 effect 自触发，动画全程每秒数百次空转（详见 `sidepanel-close-animation.md` §3.3 的 G-20260802-01 记录）。

## 6. 风格系统

### 6.1 壳控 token

右面板的壳控视觉全部经 CSS 变量，不硬编码。变量由 `data-sidepanel-style` 属性选择器分派，和左栏的 `data-sidebar-style` 完全同构。当前支持 5 种风格：default、card、minimal、outline、glass。

`SidePanelStrip` 和 `RightPanelContent` 各自在根元素上挂 `data-sidepanel-style={sidepanelStyle}`（从 `useUiStore` 读，持久化到 electron-store 的 `sidepanelStyle` 偏好键）。

壳控部分的 token 清单（`src/api/renderer/index.css`）：

- **面板头**：`--sidepanel-header-py`、`--sidepanel-header-px`、`--sidepanel-header-border`、`--sidepanel-header-bg`、`--sidepanel-header-bg-hover`、`--sidepanel-header-fs`、`--sidepanel-header-fw`
- **内容容器**：`--sidepanel-content-py`、`--sidepanel-content-px`
- **图标条按钮**：`--sidepanel-icon-btn-size`、`--sidepanel-icon-btn-radius`、`--sidepanel-icon-btn-bg`、`--sidepanel-icon-btn-bg-hover`、`--sidepanel-icon-btn-bg-active`、`--sidepanel-icon-btn-border`
- **激活指示条**：`--sidepanel-icon-active-indicator`、`--sidepanel-icon-active-indicator-height`
- **图标尺寸/间距**：`--sidepanel-icon-gap`、`--sidepanel-icon-size`
- **分隔线**：`--sidepanel-divider-display`、`--sidepanel-divider-color`
- **glass 特效**：`--sidepanel-glass-blur`（`backdrop-filter` 用，非 glass 风格为 `none`）

字体缩放独立于风格：`right-panel.tsx` 第 428-436 行通过 CSS 变量计算注入 `--sidepanel-font-scale`，覆盖 `--font-size-{xs,sm,base,lg}`、`--sidepanel-header-fs`、`--sidepanel-section-fs`。偏好键 `sidepanelFontScale`，在 `theme-manager` 设置页的"字号"区独立调节。

### 6.2 和左栏风格系统的关系

- 两个独立偏好（`sidebarStyle` / `sidepanelStyle`），分别存储。用户可以左栏 card、右面板 minimal。
- token 命名空间独立（`--sidebar-*` vs `--sidepanel-*`），同处一棵 DOM 树互不覆盖。
- 5 种风格的视觉语言概念一致（default/card/minimal/outline/glass），但具体 token 值独立。

### 6.3 插件内容区的风格消费

壳不强制插件内容区的视觉一致性——那是右面板内容多样性的必然结果。弥合方向是给插件提供基础组件（`PanelRow`、`PanelIconButton`、`PanelToolbar` 等），让它们在 `packages/react` 层级消费面板 token。当前状态：这些基础组件的契约已定义在 `panel-style-system.md`，`right-panel.tsx` 第 428 行的 `--sidepanel-font-scale` 注入是这套系统的前置铺设，但基础组件库本身尚未全面接入插件代码——现有 5 处手写 `iconBtnStyle` 常量是症状。迁移策略是"不改也不坏"——插件已消费主题 token，颜色跟随主题切换；切换到基础组件后可免费获得面板风格切换能力。

## 7. 当前居民

按图标条从上到下顺序（order 升序），共 11 个 sidePanel 贡献：

| 插件 | contribution id | icon | order | 权限 | revealOn |
|------|----------------|------|-------|------|----------|
| session-bookmarks | bookmarks | bookmark | 5 | fs:project | `timeline:bookmarkRequested` |
| git-review | review | git-branch | 10 | git:read, git:write, llm:oneshot | — |
| blind-review | blind-review | eye-off | 15 | fs:project | — |
| tool-manager | tools | sliders-horizontal | 15 | — | — |
| file-tree | files | folder-open | 30 | fs:project | — |
| im-graph | im-graph | network | 40 | sessions:bus | — |
| session-tree | tree | list-tree | 40 | — | — |
| token-stats | stats | bar-chart-3 | 50 | — | — |
| sub-agent | sub-agents-panel | git-fork | 60 | sessions:bus | — |
| notes | notes | sticky-note | 60 | — | — |
| session-colors | session-colors | pin | 80 | — | — |

各插件贡献内容（不做展开，详见各自文档）：

- **session-bookmarks**：收藏列表，支持增删改查和 fork。`revealOn` 的唯一当前消费者。
- **git-review**：Git 改动审查——轮次/会话/工作区三个视角的 diff，文件勾选 commit/push。
- **blind-review**：多蓝队独立会话审查 + 裁判汇总（借鉴 Anthropic blind auditing game）。
- **tool-manager**：会话级工具过滤与工具组管理。
- **file-tree**：项目目录树浏览，点击用系统默认应用打开文件，贡献内置 `fileIcons` 槽。
- **im-graph**：Session Bus 会话关系图——房间成员、spawn 父子关系可视化。
- **session-tree**：会话分支树，查看 fork 与消息历史，hover user 节点出 fork/收藏按钮。
- **token-stats**：Token 用量统计与上下文占比。
- **sub-agent**：子 agent 编排面板，同时贡献 sidebar、messageRenderers、sessionGroupings 等槽。
- **notes**：常用语文本片段，点击卡片一键发送进当前会话。
- **session-colors**：会话图钉——行钉会话卡片 + 内容钉跨会话索引（设计见插件 DESIGN.md 与 docs/design/content-pins.md）。

## 8. 数据流

sidePanel 贡献项的数据加载集中在 `useSidePanelData()` hook（`right-panel.tsx` 第 57-69 行）。两条数据源并行加载：

- `window.pi.slots.sidePanel()` — IPC 通道，返回 `SidePanelItem[]`（含 `revealOn`）。
- `readGeneralConfig()` — 读 `general-config.json` 的 `sidePanelOrder` 键（自定义图标条顺序）。

结果缓存以 `pluginsNonce` 为 key——插件启用/禁用/安装后 nonce 变化时重拉。缓存是模块级单例（`sidePanelCache`），`SidePanelStrip` 和 `RightPanelContent` 共享同一份数据，同 nonce 只发一次 IPC。

图标条的自定义排序由 `applyCustomOrder()` 处理（第 71-82 行）：有 `customOrder` 时按映射排序，无该 id 的项保持原顺序在末尾。拖拽时 `setCustomOrder` 同时写 `general-config.json` 持久化并更新模块缓存。

---
### 架构自检
- [x] 高内聚：`SidePanelStrip`（图标条 UI + 拖拽 + revealOn）、`RightPanelContent`（内容区 + 尺寸模型 + 动画）、`useSidePanelData`（数据加载）各司其职
- [x] 低耦合：SidePanelStrip 与 RightPanelContent 通过 `useSidePanelData` 共享数据，不互相引用
- [x] 开闭原则：新增 sidePanel 插件只需 manifest 声明 + export 组件，不改任何内核代码
- [x] 方案视角：尺寸模型 v2 用 id 键控权重根治 v1 位置存档的复杂度黑洞，而非叠补丁
- [x] 洋葱架构：贡献契约在 domain/，注册在 application/，渲染在 api/renderer/，依赖方向向内

### 修改文件清单
本次仅新增 `docs/desktop/005-sidepanel.md`，未改动任何源码文件。

未提交。
