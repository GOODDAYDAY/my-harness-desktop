# 右面板风格系统

## 1. 问题：右面板的视觉一致性缺口

### 1.1 左栏能统一、右面板不能——根因是内容控制权不同

左栏的风格系统已经完整落地。`shell/renderer/components/sidebar.tsx` 在容器元素上挂 `data-sidebar-style` 属性，`index.css` 按 `:root` 和 `[data-sidebar-style="card"]` / `[data-sidebar-style="minimal"]` / `[data-sidebar-style="outline"]` / `[data-sidebar-style="glass"]` 四个选择器注入五组 CSS 变量。`ListItem` 组件消费 `--sidebar-row-py`、`--sidebar-row-radius`、`--sidebar-row-bg-hover` 等变量，`Section` 组件消费 `--sidebar-section-fs`、`--sidebar-section-pt`。插件（`sessions-list`、`projects`）只负责填充数据——icon、title、subtitle——视觉形态由框架统一控制。5 种风格切换时所有列表行同步变化，没有哪个插件需要知道自己是什么风格。

左栏能做到这一点，是因为壳控制了约 90% 的视觉结构：每一行都是相同的 icon-box + label + actions 布局，每个分组都是标题栏 + 折叠内容。壳定了"行是什么""组是什么"，插件只是往里面灌数据。

右面板的情况完全不同。`shell/renderer/components/right-panel.tsx` 只控制了四个壳层部分：面板头（icon + label 的点击栏）、图标条（左侧竖排 icon 按钮）、内容容器（px-2.5 py-2 的滚动区）、分隔线（PanelResizeHandle）。每个插件的面板内容区，壳只提供了一层 `<div className="flex-1 overflow-y-auto min-h-0 px-2.5 py-2">` 的容器。在这个容器里面，插件的草稿纸是空白的。

9 个插件往这个草稿纸上画的东西完全不同：`git-review` 画的是文件列表 + diff 视图，`context-files` 画的是文件树，`token-stats` 画的是统计卡片和数字，`session-tree` 画的是树状节点，`tool-manager` 画的是工具列表 + 编辑面板，`blind-review` 画的是双栏 diff 对比，`run-panel` 是空态占位（现在只有文字），`session-colors` 是颜色选择器。每个插件的布局结构、交互模式、视觉密度都不同——壳不可能像左栏那样用一个"行"的抽象覆盖所有。

所以右面板没有视觉一致性，不是因为壳没做好，而是因为壳的`控制范围`和插件的`自由范围`之间的分界线划在了不同的位置。左栏的分界线在"行内部结构"——壳管行，插件管数据。右面板的分界线在"面板整体"——壳管面板头 + 图标条 + 容器，插件管容器里的所有内容。

这个差异不是 bug，是右面板内容多样性的必然结果。不能通过"让壳更厚"来弥合——把壳砌到能覆盖所有 9 个插件的内部布局，壳就变成了一堵厚墙，违反了"薄壳"纪律（`CLAUDE.md` §7.1：内核的功能含量趋近于零）。

正确的弥合方向不是让壳变厚，而是给插件提供一套它们自愿消费的基础组件。壳提供机制（token 注入 + 组件库），插件选择要不要用、用哪些。这是"框架提供、插件消费"的范式，和左栏的"框架控制、插件填充"不同，但同样能实现视觉一致性——只要大部分插件因为"方便"而选择了基础组件。

### 1.2 现有插件各自手写 UI 模式——5 处重复的 iconBtnStyle 是症状

搜 `src/plugins/` 下 `iconBtnStyle` 这个常量，出来 5 个定义：

- `git-review/renderer/index.tsx` 第 180 行：`width: 22px, height: 22px, borderRadius: var(--radius-sm), background: transparent, color: var(--color-muted), cursor: pointer`
- `token-stats/renderer/index.tsx` 第 137 行：完全相同的定义
- `blind-review/renderer/index.tsx` 第 345 行：完全相同的定义（额外还有一个 `textBtnStyle` 是它的变体）
- `tool-manager/renderer/index.tsx` 第 597 行：基本相同的定义（加了个 `padding: 0 var(--spacing-xs)`）
- `projects/renderer/index.tsx` 第 155 行：完全相同的定义（但 projects 是左栏插件，不在右面板范围内，不过同样的问题）

5 份一模一样的代码，改了其中一个的大小（比如从 22px 改成 24px），另外 4 个不会跟着变。这就是"重复手写"的直观危害：不是写的时候慢，是改的时候漏。

重复的不只是 icon button。`git-review` 的 `subTabStyle`（第 172 行）定义了一组 tab 按钮样式——padding、border、borderRadius、background、color、fontFamily、fontSize、cursor——这本质上是一个 `PanelTabs` 组件的雏形。`token-stats` 里的 stat 行（每个统计数字一行，label 在左、value 在右）是 `PanelStatRow` 的雏形。`blind-review` 的 `textBtnStyle`（第 358 行）是 `PanelIconButton` 的文字变体。

这些手写样式每一个都是用 `style={{ ... }}` 内联在 JSX 上的，不经过 CSS 变量层。这意味着：选择器改不了它们，主题只能控制它们引用的 `var(--color-*)` 部分，但不能控制它们的尺寸、圆角、间距——而这些恰恰是"风格"要变的东西。

注意一个微妙的地方：这些手写样式已经消费了主题 token（`var(--color-muted)`、`var(--radius-sm)` 等），所以主题切换时颜色、圆角跟着变。但它们不能消费"面板风格"的 token——因为右面板还没有风格 token 这个概念，也没有 `--panel-icon-btn-size`、`--panel-row-radius` 这样的变量可以引用。所以现状是：颜色跟主题走，形态各写各的。

### 1.3 不是缺 CSS 变量，是缺契约

有人可能会说：那就加 CSS 变量嘛，加一堆 `--panel-row-py`、`--panel-icon-btn-size` 之类的变量，让插件引用就行。问题是——变量加在哪里、谁负责定义、谁保证消费方一定会用？

CSS 变量的本质是"隐式契约"：变量名就是接口，命名约定就是类型系统，消费方"自觉引用"就是合规检查。隐式契约在一个插件里工作得很好（自己定义、自己消费），但在 9 个插件之间是失效的——没有编译器帮你检查"你是不是引对了变量名"，没有类型系统帮你提示"这个变量当前值是什么"，没有契约告诉你"哪些变量必须填、哪些可选"。

所以问题不是缺 CSS 变量，是缺一套显式的、类型安全的、有物理约束的契约体系。这套体系需要：

- 一个**类型定义**，编译器能检查"这个 token 是否存在"——这是 `domain/` 层的职责
- 一组**预设数据**，每种风格填满全部 token，不靠"默认值兜底"——这是 `packages/react/` 层的职责
- 一套**基础组件**，组件内部引用 token，插件的代码里不再出现 `style={{ width: 22, height: 22 }}`——这也是 `packages/react/` 层的职责
- 一个**注入机制**，壳把当前选中的风格的 token 值写到 CSS 变量里——这是 `shell/` 层的职责

这套契约体系在左栏已经存在了：`sidebar-styles.ts` 定义了 `SidebarStylePreset` 类型和 5 种预设，`ui-store.ts` 持久化了 `sidebarStyle` 偏好，`sidebar.tsx` 注入 `data-sidebar-style` 属性，`index.css` 把属性值映射为 CSS 变量组，`list-item.tsx` 和 `section.tsx` 消费这些变量。右面板要做的事情是同构的——只是 token 集合更大（因为右面板的视觉维度更多）、基础组件更多（因为右面板的 UI 模式更分散）。

## 2. 核心抽象：面板风格系统

### 2.1 三层串联：一个偏好 → 一组 token → 一套基础组件

整个系统是三条线串起来的：

第一层：偏好（preference）。用户通过 theme-manager 设置页选择一种风格——default、card、minimal、outline、glass 中的一个。这个选择持久化到 electron-store（经 `window.pi.prefs.set`），跨重启保持。和左栏的 `sidebarStyle` 偏好完全平行，独立存储。

第二层：token（CSS 变量）。选中的风格对应一组完整的 CSS 变量值。和左栏的机制一样：`index.css` 定义 `:root { --panel-*-*: ... }` 作为默认值（对应 default 风格），`[data-sidepanel-style="card"] { --panel-*-*: ... }` 覆盖为 card 风格的 token 值。`right-panel.tsx` 在容器根元素上挂 `data-sidepanel-style` 属性，CSS 选择器自动激活对应的变量组。

第三层：基础组件（React 组件）。`packages/react/panel/` 下的 8 个组件——`PanelRow`、`PanelToolbar`、`PanelIconButton`、`PanelSearchInput`、`PanelStatRow`、`PanelCard`、`PanelSectionTitle`、`PanelTabs`——每个组件通过 `style` prop 引用 `var(--panel-*-*)` 变量。这和 `ListItem` 引用 `var(--sidebar-row-py)` 是同一种模式：组件只管引变量，值由 CSS 层注入。

三层之间的依赖方向严格向内：偏好是最外层（shell + 用户交互），token 值在中层（CSS 层），基础组件在最内层（packages/react，不依赖 shell 和偏好）。偏好变化 → CSS 变量覆盖 → 组件自动重渲染——和左栏一模一样的机制，零学习成本。

### 2.2 和左栏风格系统的关系——独立偏好、平行架构、共享设计纪律

两个系统在架构上是平行的，不是包含关系：

- `sidebarStyle` 和 `sidepanelStyle` 是两个独立的 preference key，分别存储。用户可以左栏选 card、右面板选 minimal——这是两个独立的选择，不应该绑在一起。如果把右面板风格合并到左栏风格里（"一个全局风格控制所有"），就丢失了这种自由度——而左栏和右面板的视觉角色不同（左栏是高频导航，右面板是低频工具），用户完全有理由给它们不同的风格。
- token 命名空间独立：左栏用 `--sidebar-*` 前缀，右面板用 `--panel-*` 前缀。命名空间分离意味着两套变量不会互相覆盖，可以并存于同一棵 DOM 树上。
- 预设数据共享设计纪律：5 种风格的视觉语言概念（default/card/minimal/outline/glass）在两个系统中是一致的——这是设计系统的统一性。card 风格在左栏是"有边框 + 阴影"的列表行，在右面板也应该是"有边框 + 阴影"的 UI 元素。但具体的 token 值可以不同——左栏的行间距 8px，右面板的工具栏间距可能是 6px，因为两边的内容密度不同。
- 预览卡共享组件模式：`sidebar-style-preview.tsx` 是一个迷你左栏的预览。右面板的预览卡会是一个迷你右面板的预览——同样的架构范式：一个 `<div>` 容器挂上 `{...presetVars}` 作为 CSS 变量覆盖，里面放几个基础组件的静态实例。

### 2.3 和主题系统的关系——主题管色彩/字族，面板风格管形态/边框/阴影/圆角

这是一条关键边界。主题系统（`domain/slots/theme-tokens.ts`）定义了 `--color-*`、`--font-*`、`--radius-*`、`--shadow-*`、`--spacing-*`、`--motion-*` 等 token——这些是"视觉常量"，对所有插件全局生效。面板风格系统定义了 `--panel-row-bg`、`--panel-row-border`、`--panel-icon-btn-size` 等 token——这些是"形态决策"：用什么背景色、有没有边框、边框是实线还是虚线、圆角多大、阴影多重。

两者的引用关系是：面板 token 可以引用主题 token，但反过来不行。举例：`--panel-row-bg: var(--color-surface)` 是合法的——面板风格引用主题颜色，用户切主题时面板跟着变。但 `--color-surface: var(--panel-row-bg)` 是非法的——主题不能依赖面板风格。这种单向引用关系保证了依赖方向正确：面板风格在概念上是主题的"消费方"，不是主题的"定义方"。

一个具体的例子说明为什么要区分：glass 风格的面板 token 值是这样的：`--panel-row-bg: color-mix(in srgb, var(--color-surface) 50%, transparent)`。这个 token 消费了主题的 `--color-surface`，但它自己不是主题的一部分——它是在主题基础上叠加了一层"玻璃效果"的形态决策。如果换一个主题（比如从 dark 换到 light），`--color-surface` 会变成浅色，glass 风格的透明叠加仍然有效——这就是"消费主题但不属于主题"的设计意图。

## 3. Token 契约（domain 层）

### 3.1 为什么放 domain——稳定契约，加风格不改这里

面板 token 的 key 清单放在 `domain/panel-tokens.ts`，和 `domain/slots/theme-tokens.ts` 同层。圆心只放类型定义和纯数据清单——不 import 任何东西，不碰 React、不碰 CSS、不碰 Electron。

这些 token key 是"右面板有哪些可配置的视觉维度"的声明。它们一旦定义，后续增加一种新风格（比如加一个"neon"风格）不需要改这里的 token 清单——只需要在预设数据里填一组新值，在 CSS 里加一个 `[data-sidepanel-style="neon"]` 选择器。token key 是稳定的，token 值是会变的——这正是"契约放圆心、实现放外层"的意图。

和 `THEME_TOKEN_KEYS` 的结构一致：`PANEL_TOKEN_KEYS` 是一个 `as const` 数组，列出所有合法的 token 名称，用于编译期检查。"as const" 保证了 TypeScript 能推导出精确的字面量联合类型，任何地方写错了 token name 都会当场报错。

### 3.2 token 分三组：chrome（壳控）/ content（基础组件消费）/ stat（特化消费）

token 按"谁消费"分为三组。这不是类型层面的区分（都是 `string` 值），是语义层面的归属——帮助开发者理解每个 token 该在哪里被引用。

**Chrome 组**（壳控，`right-panel.tsx` 消费）：

- 面板头：`panel.header.py`、`panel.header.px`、`panel.header.border`（底部边框样式，如 `1px solid var(--color-border)` 或 `none`）、`panel.header.bg`（常态背景色）、`panel.header.bg.hover`（hover 态）、`panel.header.fs`（字号）、`panel.header.fw`（字重）
- 内容容器：`panel.content.py`、`panel.content.px`——这是壳给每个面板的内容区加的 padding。插件的内容区是独立的草稿纸，它的留白由壳统一控制比由各个插件自己写 padding 更一致
- 图标条：`panel.icon.btn.size`（宽高，默认 36px 即 w-9 h-9）、`panel.icon.btn.radius`（圆角）、`panel.icon.btn.bg`、`panel.icon.btn.bg.hover`、`panel.icon.btn.bg.active`、`panel.icon.btn.border`（边框样式）、`panel.icon.active.indicator`（左侧激活指示条样式，如 `3px solid var(--color-primary)` 或 `none`）、`panel.icon.gap`（按钮间距）、`panel.icon.size`（图标尺寸）
- 分隔线：`panel.divider.display`（`flex` 或 `none`）、`panel.divider.color`（引用主题的 `var(--divider-color)` 或自定义）

这些 token 消费在 `right-panel.tsx` 的几个关键位置：`SortableIcon` 里的 `<button>` 消费 `icon.btn.*`，面板头 `<div>` 消费 `header.*`，内容容器消费 `content.*`，PanelResizeHandle 里的分割线消费 `divider.*`。当前的实现里这些值都是硬编码的——`w-9 h-9`、`rounded-[var(--radius-sm)]`、`bg-[var(--color-surface)]`、`border-b border-[var(--color-border)]` 等——迁移后变成 `var(--panel-icon-btn-size)`、`var(--panel-icon-btn-radius)`、`var(--panel-icon-btn-bg-active)` 等。

**Content 组**（基础组件消费，插件不直接引用）：

- 行：`panel.row.py`、`panel.row.px`、`panel.row.gap`、`panel.row.bg`、`panel.row.bg.hover`、`panel.row.bg.active`、`panel.row.border`、`panel.row.border.hover`、`panel.row.border.active`、`panel.row.radius`、`panel.row.shadow`、`panel.row.shadow.active`——这些和左栏的 `--sidebar-row-*` 同构，语义完全相同，只是前缀从 sidebar 变成 panel
- 工具栏：`panel.toolbar.py`、`panel.toolbar.px`、`panel.toolbar.gap`、`panel.toolbar.border`、`panel.toolbar.bg`
- 图标按钮：`panel.iconbtn.size`、`panel.iconbtn.radius`、`panel.iconbtn.border`、`panel.iconbtn.bg`、`panel.iconbtn.bg.hover`、`panel.iconbtn.icon.size`——注意：icon 组的 icon.btn.* 是图标条的大按钮，content 组的 iconbtn.* 是内容区的小图标按钮（如刷新、清除、编辑）。两组的 token 命名不一样以避免混淆
- 搜索输入：`panel.input.py`、`panel.input.px`、`panel.input.border`、`panel.input.border.focus`、`panel.input.radius`、`panel.input.bg`
- 卡片：`panel.card.py`、`panel.card.px`、`panel.card.border`、`panel.card.radius`、`panel.card.shadow`、`panel.card.bg`
- 区域标题：`panel.section.fs`、`panel.section.py`、`panel.section.px`、`panel.section.weight`

**Stat 组**（`PanelStatRow` 专用）：

- `panel.stat.py`——统计行的垂直 padding，不同风格下行间距不同。

### 3.3 和主题 token 的边界——不重叠，各自管不同维度

两套 token 系统在物理上是两个文件（`domain/slots/theme-tokens.ts` 和 `domain/panel-tokens.ts`），在语义上各自管理不同的视觉维度：

- 主题 token 管的是"材料属性"：用什么颜色、什么字体、多大间距、多圆角、多重的阴影。这些是全局的、所有 UI 元素共享的基础值。
- 面板 token 管的是"形态决策"：行有没有背景色（有/无/透明叠加）、行有没有边框（有/无/实线/虚线）、边框在 normal/hover/active 三种状态下各是什么值、圆角多大、有没有阴影、按钮多大。

一个 panel token 的典型值是 `var(--color-surface)` 或 `1px solid var(--color-border)` 或 `none`——它消费主题 token 来表达形态决策。但一个主题 token 绝不会是 `var(--panel-row-bg)`——主题不能依赖面板风格。

这种边界划分的价值体现在：新增一种面板风格，不需要碰主题系统；新增一种主题，不需要碰面板风格系统。两个系统的变化是正交的。

## 4. 预设数据（packages/react 层）

### 4.1 5 种风格的视觉语言

文件：`packages/react/src/panel-styles.ts`。结构和 `sidebar-styles.ts` 完全同构：

```typescript
export type SidepanelStyle = "default" | "card" | "minimal" | "outline" | "glass";

export interface SidepanelStylePreset {
  id: SidepanelStyle;
  label: string;
  vars: Record<string, string>;
}

export const SIDEPANEL_STYLES: SidepanelStylePreset[] = [ /* ... */ ];
export const SIDEPANEL_STYLE_MAP: Record<string, SidepanelStylePreset> =
  Object.fromEntries(SIDEPANEL_STYLES.map((s) => [s.id, s]));
```

5 种风格，每一种填满全部 token（约 54 个变量）。下面是每种风格的视觉语言描述和关键 token 值示例：

**default（默认）**：平铺、表面色区分层次、零阴影。

- 面板头底部有 `1px solid var(--color-border)` 边框
- 图标条按钮：常态透明，激活态 `var(--color-surface)` 底色 + 左侧 3px primary 色指示条
- 内容区行：常态透明，hover 时 `var(--color-surface)` 底色，无边框、无阴影
- 图标按钮（小）：22px 方块、圆角 `var(--radius-sm)`、透明底、muted 色 icon
- 统计行：紧凑间距（`panel.stat.py: 4px`）
- 分隔线可见

**card（卡片）**：全面框、阴影层次、大圆角。

- 面板头底部边框消失（或改为 `none`），头本身可有微妙的底色或底部分隔
- 图标条按钮：常态透明，激活态 `var(--color-surface)` 底色 + 全边框 `1px solid var(--color-border)` + `shadow-sm` + `radius-lg`
- 内容区行：常态透明 + `1px solid var(--color-border)` 边框 + `shadow-sm`，hover 时 border 不变，激活态 `1px solid var(--color-primary)` + `shadow-md`
- 图标按钮（小）：28px 方块、`radius-md`、hover 时 surface 底色 + border
- 统计行：宽松间距（`panel.stat.py: 8px`）
- 分隔线隐藏

**minimal（极简）**：无线条、圆角归零、只用表面色区分层次。

- 面板头底部无边框
- 图标条按钮：常态透明，激活态 `var(--color-surface)` 底色 + 左侧 3px primary 指示条（和 default 一样）
- 内容区行：常态透明，hover 透明（零反馈），激活态 `var(--color-surface)` 底色，圆角 0
- 图标按钮（小）：20px 方块、`radius-sm`、干净到只有 icon
- 统计行：最紧凑（`panel.stat.py: 2px`）
- 分隔线隐藏

**outline（描边）**：虚线边框、hover 变 primary 虚线、激活变实线。

- 面板头底部 `1px dashed var(--color-border)`
- 图标条按钮：常态透明，激活态 `var(--color-surface)` 底色 + `1px dashed var(--color-primary)` 边框
- 内容区行：常态 `1px dashed var(--color-border)`，hover 时 `1px dashed var(--color-primary)`，激活态 `1px solid var(--color-primary)` + surface 底色
- 图标按钮（小）：`1px dashed var(--color-border)`，hover 时 dashed primary
- 分隔线可见（也是虚线）

**glass（玻璃）**：半透明叠加、毛玻璃、柔影。

- 面板头底部 `1px solid color-mix(in srgb, var(--color-border) 60%, transparent)`
- 图标条按钮：常态 `color-mix(in srgb, var(--color-surface) 50%, transparent)`，激活态 `color-mix(in srgb, var(--color-primary) 15%, transparent)` + 半透明边框
- 内容区行：同上，叠加 `shadow-sm`（`0 2px 8px rgba(0,0,0,0.15)`），激活态 `shadow-md`
- 图标按钮（小）：和其他 glass 元素一致的半透明叠加
- 关键：使用 `color-mix(in srgb, ...)` 实现透明叠加，而非不透明度（opacity 会让子元素一起变透）

### 4.2 每种风格填全部 token——没有半填

"默认值兜底"是一个陷阱。左栏风格的 `:root` 默认值恰好等于 default 风格的值，所以即使不显式声明 `[data-sidebar-style="default"]` 选择器也能工作——但这只是因为 CSS 层刚好把 default 的值写在了 `:root` 下。如果在预设数据里 default 只填了部分 token、靠 `:root` 的剩余值兜底，那就不是真正的"全填"——新增一个 token 时，default 预设里没有它，`:root` 里也没有它，值就是 `undefined`，CSS 变量不会报错，渲染结果变成了"无值"，视觉上是一个空白区域。

所以每种风格预设都要显式填满全部 token，一个不漏。这不是"多写了几十个 key-value"，是保证了任何 token 在任何风格下都有确定的值。加新 token 时，改 5 个预设对象 + 加一个 CSS 选择器——没有隐式的兜底渠道可以漏过去。

### 4.3 预设是纯数据——加风格只加一个对象 + 一个 CSS 选择器

`SIDEPANEL_STYLES` 数组的长度就是支持风格的数量。加一种新风格（比如"neon"）只需要做三件事：

1. 在 `SidepanelStyle` 联合类型里加 `"neon"`
2. 在 `SIDEPANEL_STYLES` 数组里加一个 `SidepanelStylePreset` 对象，填满全部 54 个 token
3. 在 `index.css` 里加一个 `[data-sidepanel-style="neon"] { ... }` 选择器

不改任何基础组件、不改 shell、不改 ui-store（偏好 setter 读 `SidepanelStyle` 类型，自动接受新值）。这是开闭原则的标准形态：对扩展开放（加预设），对修改封闭（不动已有代码）。

## 5. 基础组件库（packages/react/panel/）

### 5.1 设计原则：一组件一模式，三态内聚，props 最小

8 个组件，每个只封装一种 UI 模式。模式选择和"高内聚"纪律直接相关：

**一组件一模式**：`PanelRow` 就是列表行，不做工具栏的事；`PanelIconButton` 就是方块图标按钮，不做文字按钮的事。如果插件需要一个带文字的按钮，那不是 `PanelIconButton` 的变体——插件应该自己写，或者后面加一个 `PanelTextButton` 组件（但文字按钮在右面板的当前使用场景太少见，不需要进入基础组件库）。8 个组件对应 8 种在当前 9 个插件里反复出现的 UI 模式，没有"通用到覆盖一切"的野心。

**三态内聚**：一个组件的 normal、hover、active 三种视觉状态在处理，三种状态的 token 在定义——`panel.row.bg`、`panel.row.bg.hover`、`panel.row.bg.active`。组件内部用 `useState` 管 hover 态（和 `ListItem` 一样），props 里的 `active` 管激活态。样式逻辑全部在组件内部，外部不传 `style` prop 来控制"这个状态的背景色是什么"——那是 token 的事。

**props 最小**：

- `PanelRow` 的 props：`active`（boolean）、`onClick`、`children`、`actions`（hover 时才显示的右侧操作区）。没有 `style` prop——如果插件需要覆盖样式，说明这个 UI 模式不适合用 `PanelRow`，应该自己写。
- `PanelIconButton` 的 props：`onClick`、`title`、`children`（icon）、`active`、`danger`（危险操作红色）。大小、圆角、背景色全部来自 token，不出现在 props 里。
- `PanelTabs` 的 props：`tabs`（`{label: string, value: string}[]`）、`activeValue`、`onChange`。tab 的 padding、字号、圆角来自 token，插件只传数据和回调。

这种 props 设计遵循一个原则：插件只管"是什么"（数据、回调），框架（经 token）管"长什么样"。这和左栏的 `Section` 组件设计一致——`Section` 的 props 是 `title`、`actions`、`defaultOpen`，padding、字号、颜色全来自 `--sidebar-section-*` token。

### 5.2 八个组件的 API 与消费的 token

**PanelRow** —— 列表行。对应 `git-review` 的文件列表行、`session-tree` 的树节点行、`blind-review` 的结果行、`tool-manager` 的工具行。

```typescript
interface PanelRowProps {
  active?: boolean;
  onClick?: () => void;
  /** 左侧图标区（可选）。通常是一个 `<span>` 包装的 lucide icon 或颜色圆点。 */
  icon?: ReactNode;
  /** 行内容（flex-1，通常是一行或两行文字）。 */
  children: ReactNode;
  /** 右侧操作区，仅 hover 时显示（如删除按钮、更多菜单）。 */
  actions?: ReactNode;
}
```

消费 token：`panel.row.py`、`panel.row.px`、`panel.row.gap`、`panel.row.bg`、`panel.row.bg.hover`、`panel.row.bg.active`、`panel.row.border`、`panel.row.border.hover`、`panel.row.border.active`、`panel.row.radius`、`panel.row.shadow`、`panel.row.shadow.active`。

内部实现要点：使用 `useState` 管 hover 态，`onMouseEnter`/`onMouseLeave` 切换。激活态判断 `props.active`。三态合并成最终的 background、border、boxShadow 值，通过 inline style 注入。过渡动画统一 `transition: background 0.15s, border-color 0.15s, box-shadow 0.15s`——和 `ListItem` 保持一致。

**PanelToolbar** —— 操作栏。对应 `token-stats` 顶栏的"累计统计 + 重置按钮"、`tool-manager` 的"工具列表 + 添加按钮"、`git-review` 的"文件数 + 刷新按钮"。

```typescript
interface PanelToolbarProps {
  /** 左侧标题/图标（可选）。 */
  title?: ReactNode;
  /** 右侧操作区（一组 PanelIconButton 或其他元素）。 */
  children?: ReactNode;
}
```

消费 token：`panel.toolbar.py`、`panel.toolbar.px`、`panel.toolbar.gap`、`panel.toolbar.border`（底部边框，card 风格可能不需要）、`panel.toolbar.bg`。

这个组件很简单——就是一个 flex 容器，左右分布，底部可选边框。它的存在价值不是复用"flex + space-between"（那太简单了），而是统一所有面板的工具条 padding 和间距——当风格从 default 切换到 card 时，每个面板的工具条间距同步变化。

**PanelIconButton** —— 方块图标按钮。替代所有手写的 `iconBtnStyle`。

```typescript
interface PanelIconButtonProps {
  onClick?: () => void;
  title?: string;
  children: ReactNode; // icon
  active?: boolean;
  disabled?: boolean;
  /** 危险操作（红色 accent）。 */
  danger?: boolean;
}
```

消费 token：`panel.iconbtn.size`、`panel.iconbtn.radius`、`panel.iconbtn.border`、`panel.iconbtn.bg`、`panel.iconbtn.bg.hover`、`panel.iconbtn.icon.size`。

内部实现要点：danger 模式下，color 切换为 `var(--color-accent-error)`，`bg.hover` 切换为 `var(--color-accent-error)` 的透明版本（`color-mix(in srgb, var(--color-accent-error) 10%, transparent)`）。这比在每个插件里手写 `iconBtnDangerStyle` 更一致。

**PanelSearchInput** —— 搜索输入框。当前插件还没有用搜索框的地方，但 `session-tree` 的树节点搜索、`tool-manager` 的工具搜索是合理未来需求。放在基础组件里是"提供机制，不强制使用"。

```typescript
interface PanelSearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}
```

消费 token：`panel.input.py`、`panel.input.px`、`panel.input.border`、`panel.input.border.focus`、`panel.input.radius`、`panel.input.bg`。

**PanelStatRow** —— 统计行。`token-stats` 的每个统计指标（input tokens / output tokens / turns）都是 label 在左、value 在右的行。

```typescript
interface PanelStatRowProps {
  label: string;
  value: string | number;
}
```

消费 token：`panel.stat.py` + 主题的 `var(--color-muted)`（label 色）和 `var(--color-fg)`（value 色）。

这个组件替代 `token-stats` 里手写的 stat 行——当前每个 stat 行都是一个手写的 `<div>` 结构，包含 label span 和 value span。收敛到 `PanelStatRow` 后，padding 随风格变化，label 的字号和颜色统一。

**PanelCard** —— 带边框/阴影的容器。`token-stats` 里的每个统计卡片、`blind-review` 的结果摘要区都可以用它包装。

```typescript
interface PanelCardProps {
  children: ReactNode;
}
```

消费 token：`panel.card.py`、`panel.card.px`、`panel.card.border`、`panel.card.radius`、`panel.card.shadow`、`panel.card.bg`。

**PanelSectionTitle** —— 区域标题。对应 `tool-manager` 里的"内置工具"/"自定义工具"分组标签、`token-stats` 里的"本轮"/"累计"分组标签。

```typescript
interface PanelSectionTitleProps {
  children: ReactNode;
}
```

消费 token：`panel.section.fs`、`panel.section.py`、`panel.section.px`、`panel.section.weight` + 主题的 `var(--color-muted)`。

**PanelTabs** —— 子标签栏。直接对应 `git-review` 里的"本轮/本对话/Git 工作区"三个 tab。

```typescript
interface PanelTabsProps {
  tabs: { label: string; value: string }[];
  activeValue: string;
  onChange: (value: string) => void;
}
```

消费 token：`panel.iconbtn.size`（tab 高度对齐图标按钮）、`panel.iconbtn.radius`、`panel.iconbtn.bg`、`panel.iconbtn.bg.hover` + 主题的字号/字族。

内部实现要点：不使用 Radix Tabs（太重），直接用一组 `<button>` 元素。激活态 tab 的视觉由 token 控制——在 default 风格下可能是 bottom border 指示，在 card 风格下可能是背景色 + 圆角框。组件内部根据 `activeValue` 判断哪个 tab 是激活态，应用对应的 token。

### 5.3 组件消费 token 的方式——inline style + CSS 变量，和左栏组件同构

所有基础组件通过 `style={{ padding: "var(--panel-row-py) var(--panel-row-px)", ... }}` 的方式消费 CSS 变量。不经过 Tailwind 类、不经过 CSS Module、不经过 styled-components。

为什么用 inline style 而不是 CSS class？因为要和左栏的 `ListItem`/`Section` 保持一致——它们都用 inline style 引用 `var(--sidebar-*)`。同一个项目里两种 token 消费方式会造成困惑：什么时候用 class、什么时候用 inline style？统一用 inline style 避开了这个决策。

inline style 也不影响性能。CSS 变量变化时，浏览器只重绘受影响元素的样式计算，不重建 layout tree（除非变化的是布局属性）。面板风格切换的频率极低（用户手动切换），性能完全不是瓶颈。

一个组件文件的结构示例（`PanelRow.tsx`）：

```typescript
import { useState, type ReactNode } from "react";

export interface PanelRowProps {
  active?: boolean;
  onClick?: () => void;
  icon?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
}

export function PanelRow({ active, onClick, icon, children, actions }: PanelRowProps): ReactNode {
  const [hovered, setHovered] = useState(false);

  const bg = active
    ? "var(--panel-row-bg-active)"
    : hovered
      ? "var(--panel-row-bg-hover)"
      : "var(--panel-row-bg)";

  const border = active
    ? "var(--panel-row-border-active)"
    : hovered
      ? "var(--panel-row-border-hover)"
      : "var(--panel-row-border)";

  const shadow = active
    ? "var(--panel-row-shadow-active)"
    : "var(--panel-row-shadow)";

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--panel-row-gap)",
        padding: "var(--panel-row-py) var(--panel-row-px)",
        borderRadius: "var(--panel-row-radius)",
        border,
        background: bg,
        boxShadow: shadow,
        cursor: onClick ? "pointer" : "default",
        transition: "background 0.15s, border-color 0.15s, box-shadow 0.15s",
      }}
    >
      {icon}
      <span style={{ flex: 1, minWidth: 0 }}>{children}</span>
      {hovered && actions != null && (
        <span style={{ display: "flex", alignItems: "center", gap: "var(--spacing-xs)" }}>
          {actions}
        </span>
      )}
    </div>
  );
}
```

这个结构和 `ListItem` 几乎一样——说明设计一致性是真实的，不是凑出来的。

## 6. 壳控改造（shell 层）

### 6.1 right-panel.tsx 的四个壳控部分

当前 `right-panel.tsx` 里有四处硬编码的视觉常量需要替换为 CSS 变量引用：

**面板头**（第 197 行）：当前是 `className="flex items-center gap-2 px-3 py-2 shrink-0 border-b border-[var(--color-border)] text-[var(--font-size-sm)] font-medium text-[var(--color-fg)] select-none cursor-pointer hover:bg-[var(--color-surface)] transition-colors"`。改造后改为通过 inline style 引用 token：

```tsx
style={{
  padding: "var(--panel-header-py) var(--panel-header-px)",
  borderBottom: "var(--panel-header-border)",
  background: "var(--panel-header-bg)",
  fontSize: "var(--panel-header-fs)",
  fontWeight: "var(--panel-header-fw)",
  cursor: "pointer",
  transition: "background 0.15s, border-color 0.15s",
}}
// hover 态加 onMouseEnter/onMouseLeave 切换 background
```

**内容容器**（第 203 行）：`className="flex-1 overflow-y-auto min-h-0 px-2.5 py-2"` 改为 `style={{ padding: "var(--panel-content-py) var(--panel-content-px)" }}`。

**图标条按钮**（`SortableIcon`，第 128-157 行）：当前是 `className="relative flex items-center justify-center w-9 h-9 rounded-[var(--radius-sm)] cursor-pointer border-none transition-colors touch-none"` + 三元表达式判断 active/hover 样式。改造后全部走 token：

```tsx
style={{
  width: "var(--panel-icon-btn-size)",
  height: "var(--panel-icon-btn-size)",
  borderRadius: "var(--panel-icon-btn-radius)",
  border: "var(--panel-icon-btn-border)",
  background: isActive
    ? "var(--panel-icon-btn-bg-active)"
    : hovered
      ? "var(--panel-icon-btn-bg-hover)"
      : "var(--panel-icon-btn-bg)",
  color: isActive ? "var(--color-fg)" : "var(--color-muted)",
  cursor: "pointer",
  transition: "background 0.15s, color 0.15s",
}}
```

图标尺寸从 `className="size-5"` 改为 `style={{ width: "var(--panel-icon-size)", height: "var(--panel-icon-size)" }}`。

激活指示条（第 140 行）：当前是 `<span className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 rounded-r-full bg-[var(--color-primary)]" />`——一个硬编码的 3px 宽 primary 色竖条。改为：

```tsx
{isActive && (
  <span style={{
    position: "absolute",
    left: 0,
    top: "50%",
    transform: "translateY(-50%)",
    // 整个指示条的样式走一个 token：可以是 "3px solid var(--color-primary)" 也可以是 "none"
    borderLeft: "var(--panel-icon-active-indicator)",
    height: "var(--panel-icon-active-indicator-height, 20px)",
    borderRadius: "0 2px 2px 0",
  }} />
)}
```

`panel-icon-active-indicator` 的不同风格值：default/minimal → `3px solid var(--color-primary)`；card → `none`（card 风格用全边框 + 阴影区分激活态）；outline → `3px solid var(--color-primary)`；glass → `3px solid var(--color-primary)`。

**分隔线**（`PanelResizeHandle` 里的 `<div>`，第 224-233 行）：`display` 从硬编码的 `flex` 改为 `var(--panel-divider-display)`，color 从 `var(--divider-color)` 改为 `var(--panel-divider-color)`（可引用 `var(--divider-color)` 或自定义）。

### 6.2 data-sidepanel-style 属性注入

和 `sidebar.tsx` 第 40 行的 `data-sidebar-style={sidebarStyle}` 同构。在 `RightPanelContent` 的最外层容器（或 `SidePanelStrip` 和 `RightPanelContent` 的共同祖先）上挂 `data-sidepanel-style={sidepanelStyle}` 属性：

```tsx
// 在 RightPanelContent 的根 div 上
<div
  className="h-full flex flex-col bg-[var(--color-chrome)]"
  data-sidepanel-style={sidepanelStyle}
>
```

考虑一个细节：`SidePanelStrip`（图标条）和 `RightPanelContent`（内容区）是两个独立的组件，在 `shell/renderer/index.tsx` 里被并排渲染。`data-sidepanel-style` 属性需要挂在它们的共同容器上，或者各自挂一份。最简单的做法是两个组件都从 `useUiStore` 读 `sidepanelStyle` 并各自挂上——两个独立组件各自读 store 并各自挂在根元素上，没有性能问题。

### 6.3 sidepanelStyle 偏好的持久化——新 ui-store 字段 + prefs + main 进程

三处改动，和 `sidebarStyle` 完全平行：

**`packages/react/src/ui-store.ts`**：

```typescript
import type { SidepanelStyle } from "./panel-styles";

// PREF_KEYS 加一条
const PREF_KEYS = {
  // ...existing
  sidepanelStyle: "sidepanelStyle",
} as const;

// UiState 加字段和 setter
export interface UiState {
  // ...existing
  sidepanelStyle: SidepanelStyle;
  setSidepanelStyle: (style: SidepanelStyle) => void;
}

// create 初始值加
sidepanelStyle: "default",
setSidepanelStyle: (style) => {
  set({ sidepanelStyle: style });
  void window.pi.prefs.set(PREF_KEYS.sidepanelStyle, style);
},

// hydrateFromPrefs 加
const [..., sidepanelStyle] = await Promise.all([
  // ...existing
  window.pi.prefs.get<string>(PREF_KEYS.sidepanelStyle),
]);
set({
  // ...existing
  sidepanelStyle: (sidepanelStyle ?? "default") as SidepanelStyle,
});
```

**`src/shell/electron-main/index.ts`** 的 `Prefs` 接口和 `DEFAULT_PREFS`：

```typescript
interface Prefs {
  // ...existing
  sidepanelStyle: string;
}
const DEFAULT_PREFS: Prefs = {
  // ...existing
  sidepanelStyle: "default",
};
```

**`index.css`** 的 `:root` 默认值 + 四个 `[data-sidepanel-style="..."]` 选择器：

```css
:root {
  /* default 风格的 panel token 值 */
  --panel-header-py: 8px;
  --panel-header-px: 12px;
  --panel-header-border: 1px solid var(--color-border);
  --panel-header-bg: transparent;
  --panel-header-fs: var(--font-size-sm);
  --panel-header-fw: 500;
  --panel-content-py: 8px;
  --panel-content-px: 10px;
  --panel-icon-btn-size: 36px;
  --panel-icon-btn-radius: var(--radius-sm);
  --panel-icon-btn-bg: transparent;
  --panel-icon-btn-bg-hover: var(--color-surface);
  --panel-icon-btn-bg-active: var(--color-surface);
  --panel-icon-btn-border: none;
  --panel-icon-active-indicator: 3px solid var(--color-primary);
  --panel-icon-gap: 6px;
  --panel-icon-size: 20px;
  --panel-divider-display: flex;
  --panel-divider-color: var(--divider-color);
  /* content tokens */
  --panel-row-py: 4px;
  --panel-row-px: 8px;
  --panel-row-gap: 6px;
  --panel-row-bg: transparent;
  --panel-row-bg-hover: var(--color-surface);
  --panel-row-bg-active: var(--color-surface);
  --panel-row-border: none;
  --panel-row-border-hover: none;
  --panel-row-border-active: none;
  --panel-row-radius: var(--radius-sm);
  --panel-row-shadow: none;
  --panel-row-shadow-active: none;
  --panel-toolbar-py: 4px;
  --panel-toolbar-px: 8px;
  --panel-toolbar-gap: 6px;
  --panel-toolbar-border: none;
  --panel-toolbar-bg: transparent;
  --panel-iconbtn-size: 22px;
  --panel-iconbtn-radius: var(--radius-sm);
  --panel-iconbtn-border: none;
  --panel-iconbtn-bg: transparent;
  --panel-iconbtn-bg-hover: var(--color-surface);
  --panel-iconbtn-icon-size: 14px;
  --panel-input-py: 4px;
  --panel-input-px: 8px;
  --panel-input-border: 1px solid var(--color-border);
  --panel-input-border-focus: 1px solid var(--color-primary);
  --panel-input-radius: var(--radius-sm);
  --panel-input-bg: var(--color-bg);
  --panel-card-py: 12px;
  --panel-card-px: 12px;
  --panel-card-border: 1px solid var(--color-border);
  --panel-card-radius: var(--radius-md);
  --panel-card-shadow: var(--shadow-sm);
  --panel-card-bg: var(--color-surface);
  --panel-section-fs: var(--font-size-sm);
  --panel-section-py: 6px;
  --panel-section-px: 8px;
  --panel-section-weight: 600;
  /* stat */
  --panel-stat-py: 4px;
}

[data-sidepanel-style="card"] {
  --panel-header-border: none;
  /* ... 54 个 token 全部重写 */
}

[data-sidepanel-style="minimal"] {
  --panel-header-border: none;
  /* ... */
}

[data-sidepanel-style="outline"] {
  --panel-header-border: 1px dashed var(--color-border);
  /* ... */
}

[data-sidepanel-style="glass"] {
  --panel-header-border: 1px solid color-mix(in srgb, var(--color-border) 60%, transparent);
  /* ... */
}
```

每个选择器重写全部 54 个 token。CSS 选择器的优先级一致（都是属性选择器），不存在覆盖顺序问题。

## 7. 预览与选择（theme-manager 层）

### 7.1 设置页加侧面板风格区块（左栏风格下面）

在 `theme-manager/renderer/index.tsx` 第 154 行的左栏风格 `SettingsSection` 下面，追加一个完全同构的 `SettingsSection`：

```tsx
<SettingsSection title={t("settings.sidepanelStyle")} description={t("settings.sidepanelStyleDesc")}>
  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: "var(--spacing-md)" }}>
    {SIDEPANEL_STYLES.map((preset) => (
      <SidepanelStylePreviewCard
        key={preset.id}
        preset={preset}
        active={sidepanelStyle === preset.id}
        onSelect={() => setSidepanelStyle(preset.id)}
      />
    ))}
  </div>
</SettingsSection>
```

需要从 `useUiStore` 解构 `sidepanelStyle` 和 `setSidepanelStyle`，从 `@pi-desktop/react` 导入 `SIDEPANEL_STYLES` 和 `SidepanelStylePreviewCard`。

### 7.2 预览卡——迷你右面板展示壳控 + 基础组件差异

新文件：`src/plugins/theme-manager/renderer/sidepanel-style-preview.tsx`。

预览卡的设计思路和 `sidebar-style-preview.tsx` 一样：一个缩小版的 UI 区域，应用了选中风格的 CSS 变量，展示几种关键视觉元素的差异。

但右面板的预览比左栏复杂——左栏预览只需要展示"行"这一个元素类型（亮色行、暗色行、分组标题），右面板需要展示壳控和内容的组合：

```
┌─────────────────────────┐
│  📁 文件变更    [×]     │  ← 面板头 (header token)
├─────────────────────────┤
│ [📄] [🔍] [📊] [🐛]    │  ← 图标条 (icon.btn token) —— 竖排改成横排节省空间
├─────────────────────────┤
│ 改动文件        5 个 🔄 │  ← 工具栏 (toolbar token)
│ ┌─────────────────────┐ │
│ │ 📄 src/main.ts    M │ │  ← 行、激活态 (row token active)
│ │ 📄 src/utils.ts   A │ │  ← 行、普通态 (row token)
│ │ 📄 src/old.ts     D │ │  ← 行 (row token)
│ └─────────────────────┘ │
│ 统计                    │  ← 区域标题 (section token)
│ 输入 tokens    12,345   │  ← 统计行 (stat token)
│ 输出 tokens     5,678   │  ← 统计行 (stat token)
└─────────────────────────┘
```

关键实现：和 `sidebar-style-preview.tsx` 一样，顶层容器 `style={{ ...preset.vars as CSSProperties }}` 把该风格的 token 注入为 CSS 变量。内部的迷你面板头、图标条、工具栏、行、统计行都用的是基础组件（`PanelRow`、`PanelToolbar`、`PanelIconButton`、`PanelStatRow`、`PanelSectionTitle`）——它们自然消费这些 CSS 变量，预览卡零额外代码就能展示风格差异。

### 7.3 偏好独立于左栏——两套选择器，两个预览卡

左栏风格选择器和右面板风格选择器在设置页上垂直排列，各自独立。用户选左栏 card 不会影响右面板——两个 `useUiStore` 字段，两个 `prefs.set` 调用，两组 `data-*` 属性，互不干扰。

唯一的设计决策是：右面板风格选择器放在左栏风格选择器的上面还是下面？建议放在下面——左栏风格系统更成熟、用户更熟悉，把它放在上面作为"锚点"，右面板作为"新增功能"顺延在下面。一页设置页从上到下：主题 → 字体 → 左栏风格 → 右面板风格。

## 8. 插件迁移

### 8.1 不改也不坏——现有插件已消费主题 token，颜色跟着主题走

迁移策略的核心原则是渐进式、零破坏。现有 9 个插件的代码不强制迁移——它们已经消费了主题 token（`var(--color-muted)`、`var(--color-surface)`、`var(--color-border)` 等），颜色和圆角跟着主题变化。切换面板风格时，这些手写样式不会响应面板 token 的变化（因为它们引用的是主题 token 而非面板 token），但也不会崩溃——它们保持了主题级的视觉一致性。

迁移是"改得更好"，不是"修 bug"。这降低了迁移的心理门槛：可以逐个插件迁移，不需要一个巨型 PR 改 9 个文件。

迁移的路径是：插件开发者发现"这个基础组件比我手写的更好，还免费获得风格切换能力"，于是主动切过去。这是 pull 模式而非 push 模式——框架提供吸引力，插件自愿迁移。

### 8.2 各插件迁移映射表

| 插件 | 当前手写模式 | 替换为基础组件 | 迁移收益 |
|------|------------|--------------|---------|
| `git-review` | `iconBtnStyle`（手动刷新按钮）+ 文件列表行（手写 `background`/`color` 判断）+ `subTabStyle`（手写 tab 按钮） | `PanelIconButton` + `PanelRow`（文件行）+ `PanelToolbar`（文件计数 + 刷新）+ `PanelTabs` | 3 个手写样式常量消失，tab 切换获风格适配 |
| `token-stats` | `iconBtnStyle`（重置按钮）+ 手写 stat 行（`flex` 容器 + label span + value span）+ 手写统计卡片 | `PanelIconButton` + `PanelStatRow`（4 个指标各一行）+ `PanelCard`（包统计区）+ `PanelToolbar`（标题 + 清空按钮） | 手写 stat 行收敛，间距随风格自适应 |
| `context-files` | 几乎没有手写样式（用 `FileTree` 共享部件 + `EmptyState`） | 不需要迁移 | — |
| `session-tree` | 树节点行（手写 `background` 判断） | `PanelRow`（树节点行）+ `PanelSectionTitle`（分组标签） | 树节点行获 hover/active 三态统一 |
| `tool-manager` | `iconBtnStyle` + `iconBtnDangerStyle` + 手写工具行 + 手写搜索区 + `textBtnStyle` | `PanelIconButton`（danger prop 替代 `iconBtnDangerStyle`）+ `PanelRow`（工具行）+ `PanelToolbar`（标题 + 操作）+ `PanelSearchInput`（未来需求） | 2 个手写样式常量消失 |
| `blind-review` | `iconBtnStyle` + `textBtnStyle` + 手写结果行 | `PanelIconButton` + `PanelRow`（结果行）+ `PanelCard`（摘要区） | 2 个手写样式常量消失 |
| `run-panel` | `EmptyState`（无手写样式） | 不需要迁移 | — |
| `session-bookmarks` | 手写书签行 | `PanelRow`（书签行）+ `PanelToolbar`（操作栏） | 书签行获三态统一 |
| `session-colors` | 手写颜色选择网格 | 不需要迁移（颜色选择器的布局太特殊，不适合基础组件） | — |

### 8.3 迁移完成判据——重复手写全部收敛到基础组件

迁移完成的标准不是"所有插件都用基础组件"——`session-colors` 的颜色选择器不应该强行塞进任何基础组件里。标准是两条：

**判据一**：`src/plugins/` 下的所有 `iconBtnStyle` 常量被删除，对 `PanelIconButton` 的引用取代了对 `<button style={iconBtnStyle}>` 的引用。搜索 `iconBtnStyle` 返回 0 个结果（在 `src/plugins/` 范围内）。

**判据二**：任何新加入的 sidePanel 插件，如果它需要列表行、图标按钮、工具栏、统计行——有对应的基础组件可用，不需要从零手写。基础组件的存在本身就是一个"机制就位"的信号。

迁移后的一个额外福利：当后续新增第 6 种面板风格时，只需要在 `panel-styles.ts` 加一个对象 + 在 `index.css` 加一个选择器。已经迁移到基础组件的插件自动获得新风格的视觉——零改动。这是开闭原则的终极验证：加新风格时，零行插件代码被修改。

## 9. QA

**Q：为什么不把面板 token 和侧栏 token 合并为一套"行 token"？左栏的 `--sidebar-row-py` 和右面板的 `--panel-row-py` 语义不是一样的吗？**

语义一样，但值不一定一样。左栏是高频导航区，行间距可以大一些（card 风格 8px gap）；右面板是工具区，信息密度更高，行间距可能需要小一些（4px）。如果把两者合并为一个 `--row-py`，就无法独立调整——要么左栏跟着变密，要么右面板跟着变松。

分开命名空间给了更精细的控制。如果某一天设计师决定"card 风格下左右统一"，那给 `--panel-row-*` 和 `--sidebar-row-*` 填相同的值就行。反之，如果合并了再想分开，就要拆 token——比一开始就分开更痛苦。

**Q：54 个 panel token 是不是太多了？边界在哪里？**

54 个 token 对应 8 个基础组件的全部可配置视觉属性——平均每个组件约 7 个 token。和一个完整的设计系统（如 Radix Themes 有数百个 token）相比，54 个是克制的。

边界的判据是：这个 token 在两个以上风格里有不同的值吗？如果有，它是必要的——因为不同风格确实需要不同的值。如果某个 token 在所有 5 种风格里都是同样的值（比如 `--panel-stat-py: 4px`），那么它在这个阶段用 CSS 常量也成立——但保留为 token 不增加成本（多一行键值对而已），反而在未来加第 6 种风格时不至于漏掉这个维度。

**Q：如果某个插件的 UI 模式不在 8 个基础组件的覆盖范围内怎么办？**

插件自己写。基础组件的目标是覆盖"反复出现的手写模式"——当前 9 个插件里反复出现的就是行、图标按钮、工具栏、tab、统计行、区域标题、卡片。如果某个插件有一个独特的 UI 模式（比如 `session-colors` 的颜色网格），它应该自己写——硬塞进一个通用组件只会让组件膨胀。

这也符合"薄壳"纪律：框架提供机制，不强制功能。插件有全部自由不使用任何基础组件——它只是放弃了免费获得风格切换的能力。

**Q：glass 风格用的 `color-mix()` 浏览器兼容性怎么样？**

`color-mix(in srgb, ...)` 在 Chromium 111+（2023 年 3 月）开始支持。Electron 28 对应 Chromium 120，完全支持。Firefox 113+ 也支持。Safari 16.2+ 支持。pi-desktop 的 Electron 版本远高于 Chromium 111，无兼容性问题。

**Q：为什么规定"迁移不强制"，但最终目标又是"判据一：iconBtnStyle 全部删除"？这不矛盾吗？**

不矛盾。"不强制"是指不设截止日期、不在一个 PR 里改完。"判据一"是指迁移完成时的状态——可以是 3 周后、3 个月后，甚至永远不完成（如果某个插件永远没人迁移，iconBtnStyle 就一直留着）。这两个表述描述的是"迁移的节奏"（渐进式）和"迁移的终点"（干净代码库），不是互相矛盾的约束。

**Q：theme-manager 的预览卡要不要和侧栏预览卡做组件复用？比如抽一个 `StylePreviewCard` 基类？**

不要。侧栏预览卡展示的是"几行列表项"，右面板预览卡展示的是"面板头 + 图标条 + 工具栏 + 行 + 统计"。两者的视觉结构完全不同，强行抽基类只会得到一个几乎没有公共逻辑的抽象壳——壳本身没有复用价值，反而增加了理解成本。

两个独立的预览组件（`sidebar-style-preview.tsx` 和 `sidepanel-style-preview.tsx`）各自约 100 行，清晰、独立、可分别演进。这是"关注点分离"胜过"DRY"的场景——复用的前提是"同一件事"，两边的预览不是同一件事。

**Q：后续加第 6 种风格除了改 CSS 和预设数据，还需要改什么？**

不需要改任何组件、壳、store、插件。这是开闭原则的完整验证：对扩展开放（新预设数据 + 新 CSS 选择器），对修改封闭（不动已有代码）。如果加第 6 种风格时还需要改 `PanelRow` 的逻辑（比如加一种新的状态判断），那就说明 token 抽象有漏洞——需要修复 token 设计，而不是在新风格里打补丁。

**Q：PanelRow 的 `actions` prop 只在 hover 时显示，如果某个插件需要在非 hover 状态也显示操作按钮怎么办？**

不在 `PanelRow` 的覆盖范围内。插件应该自己写行结构和操作按钮。`PanelRow` 的设计选择是"hover 显示操作区"——这是当前 git-review、session-tree、tool-manager 的共同行为。如果某个插件的需求不同，说明这个 UI 模式不适合用 `PanelRow`。

"基础组件"不是"万能组件"，清晰的边界比覆盖率高更重要。一个组件拒绝了一种使用场景，比它接受了一种不匹配的使用场景更健康。

---
