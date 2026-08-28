# theme-manager：主题 / 字体 / 会话流 / 侧栏风格管理插件

## 1 定位与分层归属

theme-manager 是一个**壳插件**，物理上住在 `src/plugins/manager/theme-manager/`，是 50 个内置壳插件里按域分组落在 `manager` 组的一员。它做的事一句话：把「外观」相关的全部用户可操作入口收拢进设置页的「主题」页签——选主题、拖字号、选等宽/英文/中文三组字体、给会话流（mainView）开独立主题、给左栏（sidebar）与右面板（sidePanel）选风格预设与区域字号。

它在洋葱里的位置必须钉死，否则后面每一条都讲不清：

- **它不产出任何能力**。主题怎么合并、字号怎么缩放、字体栈怎么拼，这些是壳的机制，落在 `src/server/application/theme/merge.ts` 与 `src/server/application/theme/contrast.ts`。theme-manager 只是这些机制的**一个 UI 触发面**。
- **它不 import 壳内部实现**。整个插件目录里只有两种 import 来源：`@my-harness-desktop/react`（`usePluginContext`、`useUiStore`、`SettingsSection`、`ListItem`、`PanelTabs` 等受控 API 与框架组件）和 `@my-harness-desktop/shared`（纯类型 `FontPresetContribution`）。没有任何 `@/server/...`、`@/core/...`、`@/client/...` 的跨层 import——这正是 §6.3 依赖方向检验要求壳插件遵守的物理红线。
- **它消费两个槽、贡献两个槽**。消费 `themes` 槽（列主题）与 `fontPresets` 槽（列字体选项）；贡献 `settings` 槽（挂进设置页）与 `languages` 槽（挂自己的三套文案）。

一句话总结它的「身份」：它是**内容的消费者 + 内容的贡献者**，是「配色 → 主题插件、字体预设 → font-presets 插件、管理页 → 对应管理插件」这条内容外挂纪律的 UI 汇聚点，但自身不内嵌任何颜色值、任何字体栈字面值（唯一例外是 `font-tab.tsx` 里的 `PREVIEW_SUFFIX` 回落后缀与示例代码字符串，详见 §5.3）。

## 2 目录结构与文件清单

```
src/plugins/manager/theme-manager/
  plugin.json                    # 声明：settings 槽 1 项 + languages 槽 12 项（3 ns × 4 locale）
  locales/                       # i18n 文案，4 语言 × 3 命名空间
    zh-CN/{theme,settings,plugin}.json
    zh-TW/{theme,settings,plugin}.json
    en/{theme,settings,plugin}.json
    de/{theme,settings,plugin}.json
  renderer/                      # 壳插件 UI（Vite 按约定 glob 到 renderer/index.tsx）
    index.tsx                    # ThemeSettings 入口组件 + PanelTabs 五 tab 分发
    theme-preview.tsx            # 主题预览卡（ctx.themes.build 子树注入）
    sidebar-style-preview.tsx    # 左栏风格预览卡（data-sidebar-style 属性选择器）
    sidepanel-style-preview.tsx  # 右面板风格预览卡（data-sidepanel-style 属性选择器）
    tabs/
      font-tab.tsx               # 字号倍率 + 三组字体选择 + 实时示例 + showFontPreview
      theme-tab.tsx              # 全局主题选择（ThemePreviewCard 网格）
      timeline-tab.tsx           # 会话流独立主题 + 会话流字号
      sidebar-tab.tsx            # 左栏风格预设 + 左栏字号
      sidepanel-tab.tsx          # 右面板风格预设 + 右面板字号
```

要点：这个目录**没有** `pi-extension/`、`dsh-extension/` 子目录。§7.7 的「四件套」是「按需」，不是「必须四件全上」——theme-manager 纯粹出 UI、不补任何内核能力，所以只有 `locales/` + `renderer/` 两件。这正是「壳插件出 UI、内核出能力」的典型形态：它连 `plugin.json` 的 `permissions` 字段都没有，因为 `themes`/`fonts`/`prefs` 全在核心默认能力清单里，无需声明权限。

renderer 的加载不靠 manifest 里的 `renderer` 字段（`plugin.json` 里没有这个字段），而是 `src/web/app/plugins-host.ts` 第 4 行的 `import.meta.glob("../../plugins/*/*/renderer/index.{ts,tsx}")`：内置插件按 `<域>/<插件>/renderer/index.tsx` 约定路径被 Vite 静态收录。第三方插件的 renderer 才走 manifest 的 `renderer` 字段。这条差异是「内置与第三方无特权」的反面注脚——它说明内置插件走的是**约定发现**而非特殊注册路径，第三方走**显式声明**，两者最终都汇入同一套组件注册表（`packages/react/src/index.ts` 的 `registerPluginComponents`）。

## 3 接入点：plugin.json 的双槽声明

`plugin.json` 全文只有 82 行，贡献两个槽，零权限声明：

```json
{
  "id": "theme-manager",
  "version": "0.4.9",
  "tier": "official",
  "contributes": {
    "settings": [ { "id": "theme", "title": "主题", "icon": "palette",
                    "component": "ThemeSettings",
                    "configFile": "~/.my-harness-desktop/config/config.json",
                    "saveMode": "manual", "order": 2 } ],
    "languages": [ /* 12 条，见 §3.2 */ ]
  }
}
```

### 3.1 settings 槽：saveMode=manual 的语义

`SettingsContribution`（`packages/shared/src/domain/contributions.ts` 第 9 行）定义了这条贡献的契约，theme-manager 只用到其中五个字段：

- **`id: "theme"`**：设置页左列表的标识。注意它不等于 plugin id（`theme-manager`），这是 contribution 级 id——设置页左列表按 contribution 排序展示，`order: 2` 让它排在 Pi 管理（order 0）之后、语言（order 999）之前。
- **`component: "ThemeSettings"`**：renderer 侧组件名。框架不手动注册，而是 `registerPluginComponents`（`packages/react/src/index.ts` 第 510 行）读 manifest 的 `contributes.settings[].component`，到 module exports 里找同名导出自动注册——这正是 §7.4「组件自动匹配」。
- **`configFile: "~/.my-harness-desktop/config/config.json"`**：指向**桌面偏好文件**（electron-store 的落盘位置），不是插件私有的 `plugins-data/theme-manager/config.json`。
- **`saveMode: "manual"`**：这是这条贡献最关键的一个字段，直接改变了框架对待它的方式。

`saveMode: "manual"` 的精确语义在 `src/web/components/settings-page.tsx` 里落地（第 18 行注释 + 第 268–277 行逻辑）：

- **不传 config（null）**：`SettingsPane` 渲染组件时 `config={null}`，因为 theme-manager 的主题/字体偏好不走框架的 configFile 管线，走 `useUiStore` 的 setter。
- **无保存浮层 / 无 dirty / 无拦截**：`activeIsFramework = activeItem?.saveMode === "framework"`（第 277 行），manual 项全程不参与框架的「确定改动 → 写回 configFile → 弹浮层」生命周期。
- **仍显示「打开配置」按钮**：契约（contributions.ts 第 20 行）说 `configFile 非 null ⇒ 显示打开按钮`；第 270–273 行注释明确「manual 项用 manifest 声明的 configFile，只『打开』不『读/写』」。所以用户在主题页能打开 `~/.my-harness-desktop/config/config.json` 看原始偏好文件，但框架不会替它读写。

为什么是 manual？因为主题/字体是**全局 UI 偏好**，落盘走 electron-store 的 `prefs`（`useUiStore` 的 setter 内部 `window.kernel.prefs.set(...)`），跨重启保持、切项目不隔离——它和「项目级分层配置」是两回事，硬塞进 framework 的 configFile 分层管线反而错。theme-manager 只有一处「插件私有配置」：`showFontPreview` 开关，它**故意不**走 settings 的 configFile，而是走 `usePluginContext().config`（落 `plugins-data/theme-manager/config.json`），见 §5.3。

### 3.2 languages 槽：三个命名空间 × 四个语言

`contributes.languages` 共 12 条：3 个 `id`（`theme-manager.theme` / `theme-manager.settings` / `theme-manager.plugin`）× 4 个 `locale`（`zh-CN` / `zh-TW` / `en` / `de`），`resources` 字段指向 `./locales/<locale>/<ns>.json`。

- `theme-manager.settings` → `settings.json`：设置页全部文案，键已自带 `settings.` 前缀（如 `settings.theme`、`settings.fontScale`、`settings.previewUserBubble`）。
- `theme-manager.plugin` → `plugin.json`：插件元数据文案，键为 `plugin.theme-manager.displayName` / `plugin.theme-manager.description`。
- `theme-manager.theme` → `theme.json`：内置主题的展示名，键为 `dark` / `light` / `auto`（如 `{"dark": "深色", "light": "浅色", "auto": "跟随系统"}`）。

关于 `id` 与 i18next namespace 的关系，一个必须澄清的机制点（否则读 §9.3 会糊涂）：**`languages` 贡献项的 `id` 不参与 namespace 推导**。真正决定 i18next namespace 的是 `src/server/application/i18n/merge.ts` 第 92–94 行的 dot 解析——`key.indexOf(".")` 之前是 namespace，无点号走 `defaultNS`（`translator.ts` 第 60 行钉死 `defaultNS: "common"`）。所以：

- `settings.json` 的 `settings.theme` → namespace `settings`，key `theme`。
- `plugin.json` 的 `plugin.theme-manager.displayName` → namespace `plugin`，key `theme-manager.displayName`。
- `theme.json` 的 `dark` → namespace `common`，key `dark`。

这个细节直接连到 §5.2 的主题名渲染分流逻辑，后文会再回来。

## 4 settings 槽消费：框架驱动的渲染契约

theme-manager 的组件不是被硬编码进设置页的，而是设置页读 `settings` 槽清单后按 `component` 名查注册表渲染。完整链路：

- 壳后端 `src/server/controllers/appearance.ts` 第 52 行 `gateway.register(IPC.settings.list, () => registry.settingsItems())`。
- `PluginRegistry.settingsItems()`（`registry.ts` 第 199 行）把 `ArraySlot<SettingsContribution>` 里的贡献项投影成 `SettingsItem`，按 `order` 升序、缺省 100，返回 `{ id, title, icon, component, pluginId, configFile, configMerge, saveMode, ... }`。
- 前端 `settings-page.tsx` 第 184 行 `window.kernel.settings.list()` 拉清单，第 97 行把组件包进 `PluginIdContext.Provider`（注入 `pluginId`，让 `usePluginContext()` 知道自己的 pluginId），再以 `SettingsComponentProps` 调用。

`SettingsComponentProps`（`packages/react/src/index.ts` 第 403 行）是 theme-manager 组件签名的契约：

```ts
interface SettingsComponentProps {
  refreshSignal: number;              // 框架刷新按钮点击 +1
  config: Record<string, unknown> | null;  // manual 项恒为 null
  dirty?: boolean;                    // 框架 dirty 透传
  onChange: (config) => void;         // framework 项才用
}
```

theme-manager 的 `ThemeSettings` 只消费 `refreshSignal`（`index.tsx` 第 25 行 `ThemeSettings({ refreshSignal }: SettingsComponentProps)`），把它透传给 `FontTab`——因为字体选项随插件增删会变，刷新时重查 `fontPresets` 槽（见 §5.3）。`config`、`dirty`、`onChange` 三项因为 `saveMode=manual` 全部失效，组件签名里直接忽略。

`PanelTabs`（`packages/react/src/panel.ts`）是五 tab 的壳：`index.tsx` 第 17–23 行声明 `TABS`，每项 `{ id, labelKey }`，`labelKey` 复用 `settings.font` / `settings.theme` / `settings.timelineTheme` / `settings.sidebarStyle` / `settings.sidepanelStyle` 五个 section 标题 key，`activeTab` 用本地 `useState("font")` 管理——注意默认落在 `font`，不是 `theme`，这是产品决策（字号/字体是最高频操作）。

## 5 renderer 结构：五 tab 与三种预览卡

### 5.1 index.tsx —— ThemeSettings 入口

`ThemeSettings` 是唯一被 settings 槽 `component` 字段指向的导出（`renderer/index.tsx` 第 25 行）。它本身极薄：一个 `PanelTabs` 加一个 `activeTab` 条件渲染，把五个 tab 组件（`FontTab`/`ThemeTab`/`TimelineTab`/`SidebarTab`/`SidepanelTab`）按 active 分发。没有业务逻辑，纯粹是 tab 路由。这符合「壳插件管两件事：渲染 UI + 报告改动」里的渲染 UI 职责——它连「报告改动」都几乎不做（因为偏好走 `useUiStore` 实时生效，不走 `onChange` 框架管线）。

### 5.2 theme-tab.tsx —— 查 themes 槽渲染

`ThemeTab`（`tabs/theme-tab.tsx`）是查 `themes` 槽的标准范式：

- 第 14 行 `const ctx = usePluginContext()` 拿受控 API。
- 第 17–19 行 `useEffect(() => { void ctx.themes.list().then(setThemeOptions) }, [ctx])`：一次拉取全部可选主题 `{ id, name }[]`，存本地 state。
- 第 24–32 行 map 到 `ThemePreviewCard`，`active={currentThemeId === opt.id}`（`useUiStore` 的当前主题 id），`onSelect={() => setCurrentThemeId(opt.id)}`。

**主题名渲染的分流逻辑是这条的关键**（第 28 行）：

```ts
label={opt.name.includes(".") ? t(opt.name, { defaultValue: opt.name }) : opt.name}
```

- name 含点号 → 当成 i18n key，走 `t(key, { defaultValue: key })`，缺失时回落原始字面值。
- name 不含点号 → 原样渲染（英文主题名如 `ChatGPT Dark`、`Everforest Dark` 是纯字面值，不译）。

这条分流对应两组主题插件的事实：只有 base 主题插件（`src/plugins/themes/theme/plugin.json`）的 `name` 是 `theme.dark` / `theme.light` / `theme.auto` 这种点号 i18n-key 形态，其余 7 个主题插件的 `name` 全是 `ChatGPT Dark` / `Everforest Dark` / `Midnight Dark` / `Mocha Dark` / `New York Dark` / `Stone Dark` / `Terminal Dark` 这种裸英文。所以「内置 dark/light/auto 走 i18n、第三方风格主题走原样」的分工，是被这一行 `includes(".")` 代码固化的。它的翻译来源正是 theme-manager 自己的 `theme.json`（keys `dark`/`light`/`auto`），而后者按 §3.2 的 dot 规则落进 `common` namespace——这里存在一个「键名 `theme.dark`（ns=theme）与资源键 `dark`（ns=common）namespace 不对齐」的潜在漂移点，实际渲染靠 `defaultValue` 回落保证不空白屏，但它是一个值得在维护时确认的边界（详见 §9.3 与 §11 QA）。

### 5.3 font-tab.tsx —— 查 fontPresets 槽渲染 + 自身 config

`FontTab`（`tabs/font-tab.tsx`，全文 203 行）是五个 tab 里最复杂、也是最能体现「查槽不查常量」纪律的一个：

**查 fontPresets 槽**（第 64–66 行）：

```ts
useEffect(() => { void ctx.fonts.list().then(setFontItems); }, [ctx, refreshSignal]);
```

`ctx.fonts.list()` 对应 `window.kernel.fonts.list`（`build-kernel.ts` 第 96 行 → `IPC.fonts.list` → `registry.fontPresetsItems()`）。依赖数组里带 `refreshSignal`——刷新按钮点了就重查，因为字体选项集合是内容，随 font-presets 插件增删会变。`setFontItems` 得到的是 `FontPresetContribution[]`（保注册序），第 84–88 行按 `category` 分成 `mono`/`english`/`chinese` 三组渲染，`声明序即展示序`。第 138 行 `{t(p.labelKey)}` 把每个选项的展示名交给 i18n——`labelKey` 由 font-presets 插件自己的 `languages` 槽供给（`fontPresets.mono.jetbrains` 这类 key），**theme-manager 不持有这些文案**，它只调 `t()`。

**字体偏好读写在 useUiStore**（第 58 行解构 `fontScale`/`fontMonoChoice`/`fontEnglishChoice`/`fontChineseChoice` + 四个 setter）。setter 内部 `window.kernel.prefs.set(...)` 落 electron-store，跨重启保持。字号滑块（第 113–116 行）`min=0.5 max=2 step=0.05`，`onPointerDown/Up` 调 `setFontPreviewDragging`（第 115–116 行）——这是设置页「拖动时半透明、露出会话页实时预览」的联动开关，state 在 `useUiStore.fontPreviewDragging`。

**预览栈的同构拼接**（第 96–103 行）是本组件与 `merge.ts` 的关键一致性保证：`sansStack` 只在英文项与中文项**都命中**时才做 `[english.stack, chinese.stack, chinese.generic ?? "sans-serif"].join(", ")` 三段拼接，否则回落 `var(--font-family-sans)`——这与 `applyFontChoice`（`merge.ts` 第 88–91 行）的三段拼接 + 无效 id 回落语义逐字一致。`monoStack` 同理（第 96 行，取不到回落 `var(--font-family-mono)`）。这不是巧合，是「预览必须等于应用后」的硬约束：如果预览拼接逻辑和合并逻辑漂移，用户在设置页看到的字体就不是真正生效的字体。

**自身 config（showFontPreview）**（第 68–81 行）：这是 theme-manager 唯一的「插件私有偏好」，走 `usePluginContext().config.get/set("showFontPreview", on, { scope: "global" })`，落 `~/.my-harness-desktop/config/plugins-data/theme-manager/config.json`（`settings.json` 的 `settings.pluginOwnDesc` 文案明确写这个路径）。第 74–80 行 `toggleFontPreview` 有 `try/catch` 回滚（写失败 console.error 并回滚 state）。为什么它不走 settings 的 configFile？因为 settings 槽的 configFile 是 `config.json`（桌面偏好文件），而 showFontPreview 是插件私有 UI 开关，两者落盘位置与语义都不同——框架 configFile 管线会把它误写进全局偏好文件。

**两个「不是内容的例外」要如实指出**：第 43–47 行 `PREVIEW_SUFFIX`（mono→`monospace`、english→`sans-serif`、chinese→`serif`）和第 171–172 行的示例代码字符串（`const sessions = await pi.sessions.list(...)`）。前者是「按钮独立预览的回落后缀」，后者是「字体示例区的示例代码」，都是硬编码在 renderer 里的字面值。严格按 §1.2「壳不内嵌内容」的铁律，示例代码属于内容、理想该走 i18n 或配置，但它是**插件内**（不是壳内）的演示文案，危害等级远低于「壳里写死颜色值」，属可接受的插件自留地。

### 5.4 timeline-tab.tsx —— 会话流独立主题 + `__inherit__`

`TimelineTab`（`tabs/timeline-tab.tsx`）操作两个 `useUiStore` 字段：`timelineThemeId` 与 `timelineFontScale`。它的特殊之处在**「跟随全局」哨兵值 `__inherit__`**（第 47 行）：

- 第一个 `ListItem` 是固定卡片，`active={timelineThemeId === "__inherit__"}`，`onClick={() => setTimelineThemeId("__inherit__")}`，文案 `settings.timelineThemeInherit`（「跟随全局」）。
- 其余卡片与 ThemeTab 完全同构，`ThemePreviewCard` 复用同一套预览逻辑，`active={timelineThemeId === opt.id}`。

`__inherit__` 是渲染层契约（不是圆心 token，也不是 manifest 字段），它的消费方是 `src/web/app/theme-context.tsx` 的 `TimelineThemeScope`（第 124 行：`if (!timelineThemeId || timelineThemeId === "__inherit__")` 清理 scoped 注入、子树级联回全局）。会话流独立主题的存在本身是「中区 mainView 与左右栏不同皮肤」的机制，`timelineThemeId` 默认 `"__inherit__"`（`ui-store.ts` 第 205 行）。`timelineFontScale` 走 `AREA_FONT_SCALE_MIN/MAX`（0.5–2.0，`ui-store.ts` 第 47–48 行导出，`packages/react/src/index.ts` 第 326 行再导出），与全局 `fontScale` 是两套独立状态——区域字号不影响其他区域。

### 5.5 sidebar-tab / sidepanel-tab —— 风格预设

`SidebarTab` 与 `SidepanelTab`（`tabs/sidebar-tab.tsx` / `sidepanel-tab.tsx`）结构几乎镜像：各有一个区域字号滑块（`sidebarFontScale` / `sidepanelFontScale`）+ 一个风格预设网格。它们不查任何槽，而是直接 import `SIDEBAR_STYLE_PRESETS` / `SIDEPANEL_STYLE_PRESETS`（`packages/react/src/index.ts` 第 326–327 行再导出，圆心单源在 `packages/shared/src/contract/style-presets.ts`）。

为什么风格预设不查槽、而是圆心常量？因为**风格预设是「样式内容」，但「预设清单」被有意收进了契约层**——`style-presets.ts` 的注释（第 1–11 行）把原因讲死了：历史上 `sidebar-styles.ts` / `panel-styles.ts` / `domain/panel-tokens.ts` 三份 vars map 与 `index.css` 的属性选择器块是同一概念的四处，已开始漂移（`sidepanel.card.shadow: "none"` vs `var(--shadow-sm)`）。收敛后的纪律是：

- **清单契约**（id + labelKey）唯一真源 = `style-presets.ts`，只持有 `{ id: "default"|"card"|"minimal"|"outline"|"glass", labelKey }`。
- **样式内容**（CSS 变量值）唯一真源 = `src/web/index.css` 的 `[data-sidebar-style|data-sidepanel-style="<id>"]` 属性选择器块。
- 新增一个风格 = ① `index.css` 加 `[data-*-style="<id>"]` 块 + ② `style-presets.ts` 加 id + ③ i18n 加 `labelKey`。

`StylePreset.id` 是 `StylePresetId = "default" | "card" | "minimal" | "outline" | "glass"` 五值联合，左栏右面板共用同一族值。`useUiStore` 里 `sidebarStyle`/`sidepanelStyle` 默认 `"default"`，setter 落 prefs。

### 5.6 theme-preview.tsx —— 子树注入预览

`ThemePreviewCard`（`renderer/theme-preview.tsx`）是主题选择的核心视觉载体，它的技术要点是**「预览不换全局」**：

- 第 37–43 行 `useEffect` 里 `ctx.themes.build(themeId, fontScale, fontMonoChoice, fontEnglishChoice, fontChineseChoice).then(setVars)`——用**当前字体偏好**合并预览主题，所以预览的是「应用后的样子」而非主题原始值。
- 第 14–18 行 `themeToCssVars` 把 `Theme`（`Record<string,string>`）转成 `--color-bg` 这种 CSS 变量 style 对象，`color.primary` → `--color-primary`（点号换连字符，与 `theme-context.tsx` 的 `tokenKeyToCssVar` 同一映射）。
- 第 51–65 行把这些变量 `...vars` 铺在预览卡子树根 div 上——CSS 变量就近解析，预览卡的 `var(--color-bg)` 吃的是子树注入值，`documentElement` 上的全局主题不受影响。注释明确「薄壳合规：插件不能 import shell 的 message-list/composer，故按其 var 消费模式逐一复刻」。

预览卡内部是**迷你会话窗口的复刻**：迷你页签条（第 68 行）、用户气泡（28px 药丸）、助手行内代码（surface 底 mono 片）、bash 卡片（`color-mix(in srgb, var(--color-bg) 55%, var(--color-border))` 压深 + `radius-lg`）、composer 药丸输入条（surface + shadow-md + 圆形发送键）。这些复刻精确到「和 message-list / markdown.tsx / bashExecution 用同一批 CSS 变量、同一 color-mix 压深手法」——因为预览必须等于真身，否则用户在设置页看到的和真会话里看到的会漂移。`fontScale` 也实时订阅（第 30 行），所以拖字号时预览卡同步变。

### 5.7 sidebar-style-preview / sidepanel-style-preview —— data attribute 同 CSS 路径

两个风格预览卡（`sidebar-style-preview.tsx` / `sidepanel-style-preview.tsx`）解决的是「风格预览与生产同一路径」问题，手段是**挂 data attribute 而非 TS vars map 注入**：

- 第 24 行 `data-sidebar-style={preset.id}`（右面板对应 `data-sidepanel-style`）。
- 预览子树直接吃 `index.css` 的 `[data-sidebar-style="<id>"]` 属性选择器块——注释第 20–23 行讲得直白：「预览与生产用同一条 CSS 路径，值漂移物理上不可能，不再从 TS vars map 注入副本」。

`PreviewRow`（sidebar 版第 82 行）消费 `var(--sidebar-row-py)`、`var(--sidebar-row-bg-active)`、`var(--sidebar-icon-size)` 等一整套侧栏专属 CSS 变量，这些变量从 `[data-sidebar-style]` 块经 CSS 变量继承进入子树。sidepanel 版则用框架组件 `PanelToolbar`/`PanelRow`/`PanelIconButton`/`PanelStatRow`/`PanelSectionTitle`（`packages/react/src/panel.ts`），消费 `var(--sidepanel-header-py)`、`var(--sidepanel-btn-icon-size)` 等变量。`StylePreset` 的 `labelKey` 渲染 `t(preset.labelKey)`（`settings.style.default` 等）。

## 6 偏好 → 合并 → CSS 变量的完整数据流

把前面散落的点串成一条完整链路，这是 theme-manager 之所以「改一行 UI 就全局生效」的根本：

1. **用户操作** → `useUiStore` setter（`setCurrentThemeId`/`setFontScale`/`setFontMonoChoice`/`setTimelineThemeId`/`setSidebarStyle`…）。每个 setter 做两件事：`set({...})` 更新内存 state + `window.kernel.prefs.set(PREF_KEYS.x, value)` 落 electron-store（`ui-store.ts` 第 233–289 行）。
2. **ThemeProvider 订阅** → `src/web/app/theme-context.tsx` 第 51–61 行从 `useUiStore` 读 `currentThemeId`/`fontScale`/`fontMonoChoice`/`fontEnglishChoice`/`fontChineseChoice` + `useSystemThemeTick()`。任一变化或系统明暗翻转（`system:systemThemeChanged` 事件）触发 `useEffect`（第 67–71 行）。
3. **跨进程合并** → `window.kernel.themes.build(...)`（`build-kernel.ts` 第 77 行 → `transport.invoke(IPC.themes.build, ...)` → `appearance.ts` 第 25 行的 handler）。
4. **合并 + 审计** → `appearance.ts` 第 28–37 行调 `buildCurrentTheme(themeId, registry.themesRegistry(), fontScale, fontMono, fontEnglish, fontChinese, registry.fontPresetsRegistry(), host.theme.shouldUseDarkColors())`，随后第 39–44 行 `auditThemeContrast(theme)` 对 `CONTRAST_PAIRS` 逐对算 WCAG AA，`failed` 项 `console.warn` 上报（不阻断）。
5. **注入 CSS 变量** → 前端拿到合并后的 `Theme`，`injectThemeCssVars`（第 30 行）把每个 token key 写成 `documentElement.style` 的 `--xxx` 变量；`font.size.*` 额外注入 `-raw` 基值（第 34–36 行），供区域根元素做 `calc(var(--font-size-*-raw) * scale)` 避免自引用循环。
6. **区域覆盖** → 第 82–87 行把 `--sidebar-font-scale`/`--sidepanel-font-scale`/`--timeline-font-scale` 三个倍率也写到 `documentElement`；`TimelineThemeScope`（第 108 行）再给 mainView 子树注入 `timelineThemeId` 的独立主题（`__inherit__` 则清理 scoped 注入）。
7. **注入完成信号** → 第 78 行 `window.dispatchEvent(new CustomEvent("mhd:themeInjected"))`——引导期挂载的组件（如 SortableList 读 `--color-surface`）在注入前读到空值，凭此事件复评，不轮询不猜时序（§3.6 事件驱动）。

关键结论：**theme-manager 不产生这条链路里的任何一环，它只是链路的第 1 步触发器**。合并（merge）、审计（contrast）、注入（theme-context）、持久化（electron-store）全是壳的机制。删掉 theme-manager，链路照样能跑（没有任何 UI 触发 `setCurrentThemeId` 而已），主题机制完好——这是「无特权差异」检验方式一的直接证明。

## 7 圆心契约：token 清单 / 主题 / 字体预设 / 风格预设

theme-manager 渲染的每一个东西背后都有一份圆心契约，它只消费、不定义。这一节把四份契约钉死。

### 7.1 ThemeContribution 与 tokenSchemaVersion

`ThemeContribution`（`packages/shared/src/domain/contributions.ts` 第 73 行）只有四个字段：

```ts
interface ThemeContribution {
  id: string;                       // 主题 id，也是 prefs 里 currentThemeId 存的取值
  name: string;                     // 展示名，i18n key 或裸字面值（§5.2 的分流依据）
  tokens: Record<string, string>;   // token key → CSS 值（THEME_TOKEN_KEYS 的子集）
  base?: string;                    // 继承的父主题 id（或 "__auto__"）
}
```

`tokens` 的 key 必须是 `THEME_TOKEN_KEYS` 的子集（`slots/theme-tokens.ts` 第 17 行定义的 48 个稳定 key），且**派生 key 不可显式赋值**（`DERIVED_TOKENS` 集合，第 99 行：`border.color`、`font.size.xs/base/sm/lg`——后四个是「用户偏好字号」，主题不可设）。

`tokenSchemaVersion`（`PluginManifest` 第 496 行）是**主题 token 清单的语义版本兼容声明**，仅贡献 themes 槽的插件需要声明。判定在 `registry.ts` 第 42–51 行的 `isTokenSchemaCompatible`：`satisfies(coerce(THEME_TOKEN_SCHEMA_VERSION), declared)`，`THEME_TOKEN_SCHEMA_VERSION = "1.0"`（`theme-tokens.ts` 第 10 行）。`registerOne`（第 139–147 行）在注册 themes 前校验，不兼容则**只跳过该插件的 themes 贡献、其余槽照注册**并 `console.warn`——不拒整个插件（主题回退默认值不白屏）。未声明 `tokenSchemaVersion` 视为兼容（向后兼容存量插件）。当前 8 个主题插件全部声明 `"^1.0"`，theme-manager 自身不贡献 themes、故不声明。

### 7.2 THEME_TOKEN_KEYS / DERIVED_TOKENS / THEME_TOKEN_DEFAULTS

`slots/theme-tokens.ts` 是「token key 清单」的圆心单源，共 48 个 key（`THEME_TOKEN_KEYS` 第 17 行，颜色 17 + 字号字族 6 + 间距 5 + 圆角 3 + 阴影 3 + 运动 5 + 滚动条 4 + 分割线 3 + 边框 2）：颜色（`color.bg`/`fg`/`surface`/`primary`/`accent.*`/`border`/`muted`/`disabled`/`disabled-fg`/`chrome`/`list.selected.*`）、字号字族（`font.size.*`/`font.family.mono`/`font.family.sans`）、间距（`spacing.*`）、圆角（`radius.*`）、边框（`border.width.thin` + 派生 `border.color`）、阴影（`shadow.*`）、运动（`motion.duration.*`/`motion.ease.*`）、滚动条（`scrollbar.*`）、分割线（`divider.*`）。

`THEME_TOKEN_DEFAULTS`（第 137 行）是**低保真兜底**——themeId 查无/主题插件损坏时防白屏用，不是 dark 主题的复制。注释（第 130–136 行）显式警告了一个历史漂移：`list.selected.bg`/`divider.color`/`divider.inset` 已漂移 3 处，根因是外层把「兜底」误读为「dark 复制」、每改 dark 顺手抄错这里。约定是「不加新 token 值、不追对齐具体主题；缺 key 才用这里补」。这也是 §7.1 铁律「token key 合规、token 值违规」的**已知偏离**（CLAUDE.md §7.1 明确标注 `THEME_TOKEN_DEFAULTS` 兜底色值是圆心内容泄漏的历史残留，演进待收）。

### 7.3 CONTRAST_PAIRS

`CONTRAST_PAIRS`（`theme-tokens.ts` 第 117 行）是 9 组必须校验 WCAG AA 的颜色对，`ContrastPair = { fg, bg, largeText? }`，`largeText` 时阈值 3:1、否则 4.5:1（第 67 行 `required = pair.largeText ? 3 : 4.5`）。9 组分别是 `color.fg on color.bg`、`color.fg on color.chrome`、`color.surface-fg on color.surface`、`color.primary-fg on color.primary`、`color.muted on color.surface`（largeText）、四个 accent（success/warning/error/danger）on `color.surface`。它此前定义后零消费，本轮由 `contrast.ts` 落地审计（见 §8.2）。禁用态对（`color.disabled`/`color.disabled-fg`）**刻意不进** `CONTRAST_PAIRS`——注释第 34 行：WCAG §1.4.3 豁免非激活组件，禁用态本来就低强调。

### 7.4 FontPresetContribution

`FontPresetContribution`（`contributions.ts` 第 361 行）是字体预设槽的契约，纯声明式（与 themes/settingsGroups 同构，零代码）：

```ts
interface FontPresetContribution {
  id: string;                        // 插件内唯一，也是偏好里存的取值；跨 category 全局唯一
  category: "mono" | "english" | "chinese";
  labelKey: string;                  // 展示名 i18n key（贡献方自己的 languages 供给）
  stack: string;                     // CSS font-family 值，直接注入主题变量
  generic?: "serif" | "sans-serif";  // 仅 chinese 消费：sans 栈末尾 generic 回落方向
}
```

注释把三段拼接的语义讲得很清楚：`mono` 整体替换 `--font-family-mono`；`english` 拼进 `--font-family-sans` 开头（决定拉丁字符）；`chinese` 拼进结尾（决定汉字与 generic 回落方向），`english` 永不落栈尾、不消费 `generic`。`generic` 跟随「实际显示中文的那款字体」——黑体 `sans-serif`、宋体/楷体/行楷/仿宋 `serif`。

### 7.5 StylePreset

`StylePreset`（`contract/style-presets.ts` 第 21 行）与 `StylePresetId`（第 14 行）已在 §5.5 交代：清单契约只持 `{ id, labelKey }`，样式值在 `index.css` 属性选择器块。圆心单源纪律：一个概念（某个风格的样式）只有一份定义（`index.css` 块），清单是「有哪些 id」的投影，不是样式值的副本。

## 8 壳后端：主题合并与对比度审计

theme-manager 不实现这两者，但它的每次 `ctx.themes.build` 都精确落到这两个文件。这是「UI 是内容、机制在壳」的分界线的另一侧。

### 8.1 merge.ts —— 合并的五个纯函数

`src/server/application/theme/merge.ts` 是从 shell/renderer/theme-context 搬来收敛的 application 层用例编排（注释第 1–6 行：「依赖 domain + gateway（无），不依赖 shell/electron/react」）。五个纯函数：

**`resolveTheme(themeId, registry, seen, systemDark)`**（第 21 行）：递归解析主题。

- `themeId === "__auto__"` → 按 `systemDark` 分流为 `"dark"` 或 `"light"`（第 27–29 行）。`systemDark` 由外层注入（application 不感知 OS），来自 `host.theme.shouldUseDarkColors()`（nativeTheme）。
- 环检测：`seen` 集合（第 31–32 行），`循环继承: a → b → a` 抛错。
- 递归取 base 打底：`theme.base ? resolveTheme(theme.base, ...) : {}`（第 35 行）。
- **剥离派生 token**：遍历自身 `tokens`，`if (!DERIVED_TOKENS.has(k)) own[k] = v`（第 37–39 行）——插件显式赋值的派生 token 一律忽略，字号只能来自圆心默认值 × fontScale，`border.color` 由 `color.border` 派生。
- 合并序：`{ ...THEME_TOKEN_DEFAULTS, ...base, ...own }`（第 40 行）——默认值垫底、父主题覆盖、自身 tokens 最高。

**`buildTheme(themeId, registry, systemDark)`**（第 44 行）：`try { resolveTheme } catch { return { ...THEME_TOKEN_DEFAULTS } }`——失败回退兜底，防白屏。

**`applyFontScale(theme, scale)`**（第 57 行）：`scale === 1.0` 直接返回原引用（第 58 行优化）；否则遍历 `font.size.*` 开头的 key，正则 `^([\d.]+)(px|rem|em)?$` 解析数值 × scale 再拼回单位（第 61–64 行）。注意它只作用于 `font.size.*`，`font.family.*` 不受字号倍率影响。

**`applyFontChoice(theme, monoChoice, englishChoice, chineseChoice, fontPresets)`**（第 76 行）：字体选择覆盖。

- `mono` 整体替换：`fontPresets[monoChoice]?.stack` → `font.family.mono`（第 84–85 行）。查不到（偏好里存了已卸载插件贡献的 id）保留主题默认值。
- `sans` 双段拼接：`english.stack ?? 回退系统栈` + `chinese.stack ?? 回退苹方/微软雅黑` + `chinese.generic ?? "sans-serif"`（第 88–91 行），三段用逗号拼进 `font.family.sans`。注释点出「拼接是构造，在 merge 层；按字符逐段回退是执行，交给 CSS 引擎」——构造在内、执行在外的落地。
- 依赖倒置：`fontPresets` 注册表由外层装配注入（`appearance.ts` 传 `registry.fontPresetsRegistry()`），merge 不 import 任何字体数据——字体栈是会变的内容，归插件贡献。

**`buildCurrentTheme(...)`**（第 101 行）：合并入口，`buildTheme → applyFontScale → applyFontChoice` 三段管道，对应 06 设计 §2.2.2。参数含 `fontScale` + 三个字体选择 id + `fontPresets` 注册表 + `systemDark`（默认 `true`）。

### 8.2 contrast.ts —— WCAG AA 审计

`src/server/application/theme/contrast.ts` 是纯函数对比度审计，不碰 IO：

- `parseColor`（第 32 行）：只认 `#rgb`/`#rrggbb` 与 `rgb()/rgba()`；解析不了的值（`var()`/`color-mix()`/`transparent`）返回 null → 记 `skipped` 不计 fail——因为它们引用其他 token，静态展开会重复实现合并逻辑，运行期由浏览器求解。
- `linearize`（第 26 行）+ `relativeLuminance`（第 46 行）+ `contrastRatio`（第 51 行）：WCAG 2.x 相对亮度公式，`(hi + 0.05) / (lo + 0.05)`。
- `auditThemeContrast(theme, pairs = CONTRAST_PAIRS)`（第 57 行）：逐对算比值，低于阈值（`largeText ? 3 : 4.5`）push 进 `failed`，返回 `{ failed: ContrastDiagnostic[], skipped: ContrastPair[] }`。

消费方在 `appearance.ts` 第 39–44 行：`for (const d of audit.failed) console.warn(...)`——诊断不阻断，主进程日志上报告警，主题开发者可见、终端用户不受损。这就是「机制不阻断内容」的落地：一个主题对比度不够，不拒绝应用，只告警。

### 8.3 appearance.ts 网关

`src/server/controllers/appearance.ts` 是外观三件套的 IPC 网关（i18n 资源/语言列表、主题构建 + 对比度审计、settings 槽清单），四个与 theme-manager 直接相关的注册：

- `IPC.themes.list`（第 24 行）→ `registry.themeOptions()`（`registry.ts` 第 192 行：`themes` Map 的 values 投影成 `{ id, name }`，含 auto）。
- `IPC.themes.build`（第 25 行）→ `buildCurrentTheme(...)` + `auditThemeContrast(...)`，第 6 个实参 `host.theme.shouldUseDarkColors()` 注入系统明暗。
- `IPC.settings.list`（第 52 行）→ `registry.settingsItems()`。
- `IPC.fonts.list`（第 55 行）→ `registry.fontPresetsItems()`。

第 49 行 `host.theme.onThemeChanged(() => gateway.broadcast(IPC.themes.systemChanged))`：OS 明暗翻转 → 广播 → 前端 `build-kernel.ts` 第 79–83 行 `onSystemChanged` 订阅 → `plugins-host.ts` 第 183 行转成 `system:systemThemeChanged` 事件 → `theme-context.tsx` 的 `useSystemThemeTick` +1 触发重 build（`__auto__` 动态 base 的消费方在 renderer）。

## 9 与其他插件交互（专节）

theme-manager 几乎不「依赖」任何具体插件——它查的是**槽**，不是插件 id。这一节把「它和谁、经什么槽、以什么契约交互」逐条钉死，重点是 themes 槽的 9 个插件、font-presets、i18n。

### 9.1 与 themes 槽的主题插件（themes 域共 9 个插件，其中 8 个贡献 themes）

`src/plugins/themes/` 域下共 9 个插件，**不是 9 个都贡献 themes 槽**：

- **贡献 `themes` 槽的 8 个**：`theme`（builtin，`dark`/`light`/`auto` 三个 + `protected: true`）、`theme-chatgpt`（`chatgpt-dark`）、`theme-everforest`（`everforest-dark`/`everforest-light`）、`theme-midnight`（`midnight-dark`）、`theme-mocha`（`mocha-dark`）、`theme-new-york`（`new-york-dark`/`new-york-light`）、`theme-stone`（`stone-dark`/`stone-light`）、`theme-terminal`（`terminal-dark`）。合计 13 个主题贡献项。
- **贡献 `fontPresets` 槽的 1 个**：`font-presets`（详见 §9.2）。

theme-manager 与这 8 个主题插件的交互**完全经 `themes` 槽 + 注册表**，没有任何硬编码 plugin id：

- **查**：`ThemeTab`/`TimelineTab` 调 `ctx.themes.list()` → `IPC.themes.list` → `registry.themeOptions()`。这个查询返回的是注册表里**所有**主题（builtin + 第三方 + 用户目录 + 项目目录），主题插件之间无特权差异（§1.4）——只要某插件往 `contributes.themes` 加一条 `{ id, name, tokens, base? }`，theme-manager 自动可见，无需改 theme-manager 一行代码。
- **注册**：`registry.ts` 第 138–147 行，`themes` 是 `Map<string, ThemeContribution>`（第 79 行，按 id 去重，语义与数组槽不同），注册前先过 `isTokenSchemaCompatible` 的 tokenSchemaVersion 校验（§7.1）。
- **选择**：用户点某个主题 → `setCurrentThemeId(opt.id)` → prefs 落盘 → `ThemeProvider` 重 build。theme-manager 不知道、也不关心 `theme.id` 对应的 tokens 内容是什么——tokens 的合并是 `merge.ts` 的事。
- **继承**：`resolveTheme` 递归 `base`。8 个主题插件里 7 个的 `base` 都是 `"dark"` 或 `"light"`（继承 base 主题插件的 `dark`/`light`），只有 base 主题插件自己定义了 `dark`/`light` 的完整 tokens（不设 base），以及 `auto`（`base: "__auto__"`，tokens 为空 `{}`）。这条继承链意味着：7 个第三方风格主题只填「差异 token」（比如 chatgpt 只覆盖颜色 + 间距 + 圆角 + 阴影 + 运动 + divider，不碰滚动条），其余 token 从 `dark` 继承——这就是「默认值 → base → own」三层合并的价值。

一个容易忽略的**间接依赖**：base 主题插件的 `name` 是 `theme.dark`/`theme.light`/`theme.auto`（点号 i18n key 形态），其翻译源在 theme-manager 自己的 `theme.json`（§3.2）。也就是说，**theme-manager 反过来「喂养」了 base 主题插件的展示名**——这是「管理插件为被管理的内容提供文案」的一个微妙耦合，两者通过 `languages` 槽 + `name` 字段的约定（点号 = i18n key）间接关联，而非代码 import。

### 9.2 与 font-presets 的交互

`font-presets`（`src/plugins/themes/font-presets/plugin.json`）是 `fontPresets` 槽的**唯一内置贡献者**，`protected: true`，贡献 17 个字体预设（`mono` 6：jetbrains/fira/cascadia/sfmono/menlo/system-mono；`english` 6：system/georgia/times/palatino/garamond/comic-sans；`chinese` 5：heiti/songti/kaiti/xingkai/fangsong），并自带 `languages` 槽贡献 `fontPresets.mono.jetbrains` 这类 labelKey 文案。

theme-manager 与它的交互分两路，都经「id」这一契约单源：

- **UI 侧**：`FontTab` 查 `ctx.fonts.list()` → `registry.fontPresetsItems()`（保注册序），按 category 分组渲染按钮，`t(p.labelKey)` 取文案。theme-manager 不 import font-presets 的任何常量——新增字体选项 = font-presets 往 manifest 加一条 + 加一条 labelKey 文案，theme-manager 自动可见（注释第 3–6 行明说：「新增字体选项 = 第三方插件往 manifest 加一条，本页自动可见，内核一行不动」）。
- **合并侧**：用户选中的 `fontMonoChoice`/`fontEnglishChoice`/`fontChineseChoice` 存的是**字体预设的 id**（`ui-store.ts` 第 92–95 行注释：「取值是 fontPresets 槽贡献项的 id，插件化后不再有固定枚举」），`merge.ts` 的 `applyFontChoice` 用这个 id 到 `fontPresets` 注册表查 `stack` 应用。所以 UI 的「选中 id」和合并的「查栈 id」是同一个 id——契约单源落点：字体栈唯一一份，住在 font-presets 的 manifest，注册表/合并/消费方都查它（`contributions.ts` 第 360 行）。

`FontPresetContribution.id` 跨 category 全局唯一（`contributions.ts` 第 362 行注释），`registry.fontPresetsRegistry()` 第 393–395 行按 id 扁平聚合成 `Record<string, FontPresetContribution>`。这意味着字体 id 的命名空间是全局的，font-presets 的 `jetbrains` 不会和第三方插件的 `jetbrains` 冲突（后者注册时会因同 id 被 `ArraySlot.removeById` 覆盖，见 §9.4 的优先级语义）。

### 9.3 与 i18n 的交互

theme-manager 与 i18n 的交互有两层：**它贡献文案** + **它消费文案**。

**贡献**：`languages` 槽 12 条贡献（3 ns × 4 locale），经 `src/server/application/i18n/merge.ts` 的 `mergeLanguageContributions`（第 77 行）合并进 i18next resources。合并规则是 key 级 union（第 6–7 行注释）：「不冲突 key 全保留，冲突 key 按 source priority 取高（高值胜），同优先级先处理者胜」。`SOURCE_PRIORITY`（第 21 行）`builtin:1 < installed:2 < user:3 < project:4`。namespace 推导规则见 §3.2（第一个 dot 前是 ns，无 dot 走 `defaultNS=common`）。`resolveLanguageResources`（第 46 行）把字符串路径读成 JSON 对象，解析失败（文件不存在/JSON 错/顶层非对象）记 error 返回 null 跳过——内容层笔误不炸应用启动。

**消费**：`useTranslation()`（react-i18next）在 `index.tsx` 及各 tab 里调 `t("settings.theme")`、`t("settings.fontScale")` 等。fallback 链（`translator.ts` 第 14–15 行 + 第 86–91 行）：当前 locale → `en`（`FALLBACK_LOCALE`）→ manifest 字面值（`defaultValue`）→ key 本身。所以 theme-manager 的 zh-CN 文案缺失某 key 时会回落到 en 再回落 key，不白屏。

**主题名渲染的 i18n 耦合**（§5.2 已提，这里再精确一次）：`ThemeTab` 第 28 行 `opt.name.includes(".") ? t(opt.name, { defaultValue: opt.name }) : opt.name` 是 theme-manager 与 base 主题插件 + i18n 三方约定的交汇点：

- base 主题插件 `name = "theme.dark"`（点号）→ 走 `t()`，key 是 `theme.dark`（ns=`theme`，key=`dark`）。
- theme-manager `theme.json` 的键是 `dark`（无点号）→ merge 后落 `common` namespace 的 `dark`。
- 二者 namespace 不对齐时，`t("theme.dark")` 找不到 `theme:dark`，回落 `defaultValue: "theme.dark"`（原始字面值）。

这是一个**值得在维护时确认的潜在漂移**：要么 base 主题插件的 `name` 应改为裸键（匹配 theme.json 的 `dark`/`light`/`auto`），要么 theme.json 的键应带 `theme.` 前缀。当前代码靠 defaultValue 兜底保证不崩、不空，但 base 主题的展示名实际上走的是「原始字面值」而非「翻译文案」。这条我在 §11 QA 里再点一次。

**语言切换的联动**：`useUiStore.currentLocale` + `setCurrentLocale`（`ui-store.ts` 第 162 行）落 prefs + 通知 i18next changeLanguage。theme-manager 的文案随语言包切换，主题名（点号 i18n key 的）也随之切换——只要 i18n resources 里有对应 key。

### 9.4 与框架 / 壳的交互

theme-manager 与壳（框架）的交互面最多，但全是「机制对内容」的契约，逐条：

- **settings 槽渲染**：§4 已详述。组件经 `getSettingsComponent(item.component)`（`packages/react/src/index.ts` 第 460 行）查注册表，`PluginIdContext.Provider` 注入 pluginId，`SettingsComponentProps` 调组件。
- **useUiStore（框架 store）**：theme-manager 读 11 个外观字段（`currentThemeId`/`timelineThemeId`/`fontScale`/`fontMonoChoice`/`fontEnglishChoice`/`fontChineseChoice`/`sidebarStyle`/`sidepanelStyle`/三个区域字号/`fontPreviewDragging`）并调 8 个 setter。这是「共享 store 只读」纪律的一个**授权例外**——`useUiStore` 是壳的桌面偏好 store，setter 就是壳公开的受控写入口（`setCurrentThemeId` 等），不是让插件直接 `useUiStore.setState(...)` 手搓。theme-manager 调的每个 setter 都内部做了「内存 set + prefs 落盘」两件事，等于走的是壳的受控 API。
- **usePluginContext**：`ctx.themes.list/build`、`ctx.fonts.list`、`ctx.config.get/set`、`ctx.prefs`（经 `useUiStore` 间接）。`plugin-context.ts` 第 184–185 行把 `window.kernel.themes`/`window.kernel.fonts` 直接挂进 context。
- **系统明暗事件**：`system:systemThemeChanged`（§8.3）。theme-manager 本身不订阅它——它只写 `currentThemeId`（可能是 `auto`），真正响应明暗翻转的是 `theme-context.tsx` 的 `useSystemThemeTick`。theme-manager 的 ThemeTab 里 `auto` 主题的预览也走 `ctx.themes.build("auto", ...)`，靠同一机制在 `__auto__` 里分流 dark/light。
- **组件注册**：`registerPluginComponents` 自动匹配 `ThemeSettings`（§3.1）。`getSettingsComponent` 的注册表 `settingsComponents`（`packages/react/src/index.ts` 第 454 行）是所有 settings 槽组件共享的 Map。
- **优先级 / 覆盖**：theme-manager 作为 builtin 插件，`tier: "official"`，优先级最低，可被复制到 user/project 目录以更高优先级覆盖（§1.4 无特权差异）。它的 settings 槽贡献 id 是 `theme`，如果第三方插件也贡献 id=`theme` 的 settings 项，会经 `ArraySlot.removeById`（`registry.ts` 第 66 行）整项替换——「后注册者（高优先级 source）胜」。
- **事件总线（负向结论）**：theme-manager **不 emit 也不 invoke 任何 channel**，`plugin.json` 无 `dependsOn`。它不依赖任何其他壳插件，只依赖「槽位契约 + 圆心 token + 框架 store」。这是它「自足」的体现——它是最不「面向其他插件」的插件，面向的是「槽」。

## 10 依赖方向与薄壳合规检查

用 §6.3 的检验逐条过 theme-manager：

- **不 import 壳内部实现**：整个 `renderer/` 目录 grep `@/server/`、`@/core/`、`@/client/` 均为零命中，只有 `@my-harness-desktop/shared`（类型）与 `@my-harness-desktop/react`（受控 API/组件）。合规。
- **不 import electron / react 之外的框架**：renderer 只 import `react`、`react-i18next`、`lucide-react`（图标）、`@my-harness-desktop/react`。这些是外层框架，壳插件可用。合规。
- **token key 合规、token 值违规**：theme-manager 代码里没有一处写死颜色十六进制、没有一处写死 `--color-*` 的字面值——预览卡全部消费 `var(--color-*)`、`var(--spacing-*)`、`var(--radius-*)`。它写死的只有「查询 key」（`settings.fontScale` 等 i18n key、`ctx.themes.build` 的调用），不含值。唯一的「值」是 §5.3 说的 `PREVIEW_SUFFIX` 回落后缀与示例代码，属插件内演示文案，非壳内容泄漏。
- **无内核身份分支**：theme-manager 全文没有 `if (kernel === "pi")`、没有 `asPi()`、没有任何内核专属概念。它不感知 pi/dsh——外观是壳的机制，与内核无关。这正是「壳的渲染是纯函数」的延伸：主题/字体/风格对 pi 会话和 dsh 会话一视同仁。
- **零硬编码 plugin id**：theme-manager 代码里没有出现 `theme-manager`、`font-presets`、任何主题插件的 id 字面量——它查槽不查插件。§8.3 的「零硬编码」纪律合规。

一句话：theme-manager 是「薄壳纪律」的模范生——它把「会变的内容」（配色、字体栈、文案）全部推给 themes/font-presets/languages 槽，自己只留「怎么把这些槽渲染成 UI」的渲染逻辑。删掉它，壳照常启动、主题机制完好，只是少了那页设置 UI；复制到用户目录覆盖它，走同一加载器、同一契约、同一优先级。

## 11 QA

**Q：theme-manager 为什么用 `saveMode: "manual"`，而不是 framework 的 configFile 管线？**

因为它的主题/字体/字号偏好是**全局桌面偏好**，落盘在 electron-store 的 `prefs`（`~/.my-harness-desktop/config/config.json`），跨重启保持、不按项目分层。framework 管线的 configFile 是「项目级分层配置」（global/project 两层 key 级合并），语义不对——把全局偏好塞进分层管线会把「切换项目该不该换主题」这类问题搞错。manual 模式让 framework 完全不插手（不传 config、不弹浮层、不拦截），偏好读写全走 `useUiStore` 的 setter（内部 `window.kernel.prefs.set`）。`configFile` 字段保留只为「打开配置」按钮能打开那个偏好文件。

**Q：主题预览卡怎么做到「预览不污染全局主题」？**

`ThemePreviewCard` 第 51–65 行把 `ctx.themes.build(...)` 合并出的 `Theme` 经 `themeToCssVars` 转成 CSS 变量，**只铺在预览卡子树根 div 的内联 style 上**（`...vars`），不写 `documentElement`。CSS 变量就近解析：预览卡内部的 `var(--color-bg)` 吃子树注入值，卡外（包括全局 documentElement）不受影响。`ThemePreviewCard` 还实时订阅 `fontScale` + 三个字体选择，所以预览的字体/字号也是「应用后」的样子，不是主题原始值。

**Q：theme-manager 查的主题/字体列表从哪来？谁负责去重和优先级？**

都从**槽注册表**来：`ctx.themes.list()` → `IPC.themes.list` → `registry.themeOptions()`（`themes` 是 `Map<string, ThemeContribution>`，按主题 id 去重）；`ctx.fonts.list()` → `IPC.fonts.list` → `registry.fontPresetsItems()`（`ArraySlot`，保注册序）。去重/覆盖由 `PluginRegistry.registerOne`（`registry.ts` 第 136 行）统一处理：themes 槽按 id 覆盖（Map.set），数组槽（含 fontPresets）push 前 `removeById` 清同 id 旧项——配合 bootstrap 注册序 `builtin → installed → user → project`，实现「后注册者（高优先级 source）胜」。theme-manager 不做任何去重，它拿到的就是最终注册表。

**Q：为什么 base 主题插件的 `name` 是 `theme.dark`，而 theme-manager 的 theme.json 键是 `dark`？这两者怎么对上？**

这是 §9.3 点名的潜在漂移。`ThemeTab` 第 28 行按 `name.includes(".")` 分流：`theme.dark` 含点号 → 走 `t("theme.dark")`；而 i18n merge 的 dot 规则把 `theme.dark` 拆成 ns=`theme`、key=`dark`，但 theme-manager 的 `theme.json` 键是裸 `dark`（无点号 → 落 `defaultNS=common`）。所以 `theme:dark` 这个 namespace 没有资源，`t("theme.dark")` 实际回落到 `defaultValue: "theme.dark"` 原始字面值。当前靠 defaultValue 兜底不崩、不空，但 base 主题的展示名实际上是原始字面值而非翻译文案。要修正，二选一：base 主题 `name` 改裸键 `dark`/`light`/`auto`，或 theme.json 键带 `theme.` 前缀。

**Q：字号倍率、区域字号、字体选择，三者怎么作用于最终 CSS？**

分层作用：全局 `fontScale` 在 `merge.ts` 的 `applyFontScale` 里对 `font.size.*` token 做 `数值 × scale` 的乘法（`14px → 21px`），这是「合并层」的缩放；区域字号（`sidebarFontScale`/`sidepanelFontScale`/`timelineFontScale`）不走合并层，而是 `theme-context.tsx` 第 82–87 行把 `--sidebar-font-scale` 等倍率写到 documentElement，由对应区域根元素的 `calc(var(--font-size-*-raw) * scale)` 做「渲染层」的子树缩放（`-raw` 基值在第 34–36 行额外注入，避免自引用循环）；字体选择在 `applyFontChoice` 里对 `font.family.mono`（整体替换）和 `font.family.sans`（英文段 + 中文段 + generic 三段拼接）做覆盖。三者互不干扰，都是「合并/注入」的纯函数叠加。

**Q：主题插件贡献的 `tokens` 里能不能写 `font.size.base` 或 `border.color`？**

不能，且写了也不生效。`DERIVED_TOKENS`（`theme-tokens.ts` 第 99 行）= `{ border.color, font.size.xs/base/sm/lg }`，`resolveTheme` 第 37–39 行 `if (!DERIVED_TOKENS.has(k)) own[k] = v` 把显式赋值一律剥离：字号是用户偏好（主题不可设，只能来自圆心默认值 × fontScale），`border.color` 由 `color.border` 派生。主题能定义的是 `font.family.*`（文字样式），不是 `font.size.*`（文字大小）。

**Q：对比度审计失败会怎样？主题会被拒绝吗？**

不会拒绝。`auditThemeContrast`（`contrast.ts` 第 57 行）是纯函数诊断，`appearance.ts` 第 39–44 行只对 `failed` 项 `console.warn`——主进程日志上报告警，主题开发者可见，终端用户不受损。9 组 `CONTRAST_PAIRS` 里 `largeText` 的阈值 3:1、其余 4.5:1；解析不了的颜色值（`var()`/`color-mix()`/`transparent`）记 `skipped` 不计 fail，因为这些值运行期由浏览器求解、静态展开会重复实现合并逻辑。禁用态对（`color.disabled`/`disabled-fg`）刻意不进审计，因 WCAG §1.4.3 豁免非激活组件。

**Q：theme-manager 的 `showFontPreview` 开关和主题偏好，为什么存两个不同的地方？**

因为语义不同：`showFontPreview` 是 theme-manager **自己的 UI 偏好**（「要不要显示字体预览区」），只影响它自己，走 `ctx.config` 落 `~/.my-harness-desktop/config/plugins-data/theme-manager/config.json`（按 pluginId 隔离）；主题/字体/字号是**全局桌面偏好**（所有插件、所有渲染都消费的 token），走 `useUiStore` 落 electron-store 的 prefs。把两者混在一个 configFile 里，会让「主题选择」这个全局状态被框架的分层管线当插件私货处理，语义就错了。theme-manager 的 `settings.pluginOwnDesc` 文案明确区分了这两个落盘位置。

**Q：theme-manager 为什么不声明任何 `permissions`、不 emit 任何事件、不 declare 任何 `dependsOn`？**

因为它只用「核心默认能力」（`themes`/`fonts`/`prefs`/`config`，§8.1 里核心默认清单），这些能力所有壳插件默认可用、不需声明权限；它也不消费其他插件的 channel（查槽不查插件），所以无需 `dependsOn`；它自己也不广播状态（它的产出就是 prefs 写入，`ThemeProvider` 订阅的是 prefs 变化而非 theme-manager 的事件），所以不 emit。这是「自足插件」的完整形态——面向槽位契约而非面向其他插件实例。
