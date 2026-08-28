# theme（基础主题）

theme 是 themes 域的**根插件**，也是唯一的**数据型 + 多贡献项**主题插件：一个 `plugin.json` 里挂三条 `themes` 槽贡献（`dark` / `light` / `auto`），没有任何 renderer 代码。它的 `dark` 和 `light` 是其余七个配色方案插件（theme-chatgpt / theme-everforest / theme-midnight / theme-mocha / theme-new-york / theme-stone / theme-terminal）共同声明的 `base`——所有配色方案都在 `"base": "dark"` 或 `"base": "light"` 处指回本插件，再由 merge 管线递归解析出完整 token 集。删掉它，七个配色方案全部解析失败、回退 `THEME_TOKEN_DEFAULTS`，所以 manifest 里标了 `"protected": true`（不可卸载，只能禁用）。

## 结构

plugin.json 顶层字段：`id` / `version` / `tier` / `displayName` / `description` / `tokenSchemaVersion` / `protected` / `contributes`。

- **`tokenSchemaVersion: "^1.0"`**：声明本插件 themes 贡献与圆心 token 清单兼容。加载器注册 themes 前用 `semver.satisfies(coerce("1.0"), "^1.0")` 判定（`registry.ts` 的 `isTokenSchemaCompatible`），圆心清单版本来自 `THEME_TOKEN_SCHEMA_VERSION = "1.0"`。不兼容则**只跳过本插件的 themes 注册、不拒整个插件**，告警后主题回退默认值不白屏。未声明视为兼容（向后兼容存量插件）。
- **`protected: true`**：可从设置页禁用，但不能从注册表卸载——它是七个配色方案的继承根。

`contributes.themes` 三条，逐条是 `ThemeContribution = { id, name, tokens, base? }`：

- `dark`：`name: "theme.dark"`，无 `base`，`tokens` 是**全套视觉常量**（36 个 key，见下）。
- `light`：`name: "theme.light"`，无 `base`，`tokens` 是**精简子集**（颜色 + 阴影 + 滚动条 + 分割线，26 个 key），间距/圆角/字族/边框宽度靠圆心兜底。
- `auto`：`name: "theme.auto"`，`tokens: {}`（空），`base: "__auto__"`——一个**动态别名**，自身不携带任何值。

关键点：`dark` 和 `light` 是唯二没有 `base` 的主题，因此它们在 merge 里是**继承树的叶子根**，resolve 到自身后就落到 `THEME_TOKEN_DEFAULTS` 兜底。`auto` 则把继承指向一个 merge 层特判的哨兵 id。

## 声明了什么 tokens

`dark` 声明的是「一套暗色主题的完整骨架」，覆盖圆心 `THEME_TOKEN_KEYS` 七维度的绝大部分：

- **颜色（15 个）**：`color.bg` `color.fg` `color.surface` `color.surface-fg` `color.primary` `color.primary-fg` `color.accent.success` `color.accent.warning` `color.accent.error` `color.accent.danger` `color.border` `color.muted` `color.chrome` `color.list.selected.bg` `color.list.selected.border`。未声明 `color.disabled` / `color.disabled-fg`（禁用态控件对，落圆心兜底的 `color-mix(...)` / `var(--color-muted)` 相对值，明暗都协调）。
- **字号字族（2 个）**：只声明 `font.family.mono` / `font.family.sans`，**不声明 `font.size.*`**——字号是派生 token（`DERIVED_TOKENS`），主题不可设，只能由用户 fontScale 缩放，这是硬规则。
- **间距（5 个）**：`spacing.xs/sm/md/lg/xl` = 8/12/16/24/32px。
- **圆角（3 个）**：`radius.sm/md/lg` = 4/8/12px。
- **边框（1 个）**：`border.width.thin` = 1px。`border.color` 是派生 token，不显式赋值。
- **阴影（3 个）**：`shadow.sm/md/lg`，近黑底上靠更长扩散制造层次而非加深。
- **滚动条（4 个）**：`scrollbar.width/radius/thumb/thumb.hover`，细条悬浮风。
- **分割线（3 个）**：`divider.color/width/inset`，从 `color.border` 派生出的低对比细线。
- **运动（0 个）**：未声明 `motion.*`，暗色主题沿用圆心默认节奏。

`light` 声明的是「浅色主题的差异层」：15 个颜色（干净的浅灰 chrome、蓝 primary、语义色转深色系以保浅底对比）+ 3 阴影（黑底换低透明浅阴影）+ 4 滚动条 + 3 分割线。**间距、圆角、字族、边框宽度一概不声明**——它们直接落到 `THEME_TOKEN_DEFAULTS`（`spacing.xs=8px` 等），而不是从 `dark` 继承（`light` 没有 `base`）。这是刻意的：浅色主题只表达「颜色与层级」，几何常量与暗色共享同一套圆心默认。

`auto` 声明零 token：它把「跟随系统」的语义完全交给 merge 层的 `__auto__` 哨兵。

## 经 merge 管线如何生效

调用链：`theme-manager` 设置页选中主题 id → `useUiStore.setCurrentThemeId` → 前端 `ThemeProvider` 读偏好 → `window.kernel.themes.build(themeId, fontScale, ...)` → 后端 `appearance.ts` 的 `IPC.themes.build` handler → `buildCurrentTheme(themeId, registry.themesRegistry(), ...)`。`buildCurrentTheme` 分三步：

1. **`buildTheme` → `resolveTheme`**：递归解析 base。`dark`/`light` 无 base，直接 `{ ...THEME_TOKEN_DEFAULTS, ...own }`（own 里被 `DERIVED_TOKENS` 过滤后的 token 覆盖默认）。`auto` 的 base 是 `"__auto__"`，`resolveTheme` 在入口特判：`themeId === "__auto__"` 时按注入的 `systemDark`（来自 `host.theme.shouldUseDarkColors()`）改写为 `"dark"` 或 `"light"`，再走正常递归——所以 `auto` 最终等价于「系统暗则 dark、亮则 light」。`seen` 集合做环检测，`dark → ... → dark` 这种循环继承直接抛错、由 `buildTheme` 捕获回退默认值。
2. **`applyFontScale`**：只对 `font.size.*` 开头且形如 `Npx` 的值乘倍率。本插件不设字号，所以这一步操作的是圆心默认值；倍率=1.0 时短路返回原对象。
3. **`applyFontChoice`**：按用户在字体 tab 的选择覆盖 `font.family.mono`（整体替换）和 `font.family.sans`（英文段 + 中文段 + generic 三段拼接），数据源来自 `fontPresets` 注册表（本插件不参与）。

合并后产出扁平 `Theme`（`Record<string, string>`），由前端 `injectThemeCssVars` 把每个 `color.bg → --color-bg` 写进 `documentElement`。`font.size.*` 额外注入一份 `-raw` 基值，避免区域字号倍率的 `calc()` 自引用循环。

## 与其它插件的交互

- **作为七个配色方案的 base**：theme-chatgpt 等的 `base` 字段值是 `"dark"`/`"light"`——这是**跨插件按主题 id 解析**的引用（不是按插件 id）。merge 的 `registry` 是「主题 id → ThemeContribution」的扁平 Map，所以 base 字符串 `"dark"` 被 `resolveTheme` 从本插件注册的 `dark` 条目里取到。本插件是继承图的唯一根，其它主题只有覆盖层语义。
- **与 theme-manager**：theme-manager 不 import 本插件，只经 `ctx.themes.list()`（→ `registry.themeOptions()`）查槽渲染选择卡；`name` 字段含 `.` 时走 `t(name)` 解析（`theme.dark`/`theme.light`/`theme.auto`），文案由 theme-manager 自己的 languages 槽（`locales/*/theme.json` 的 `dark`/`light`/`auto`）供给，随语言切换显示「深色/浅色/跟随系统」。
- **与 i18n**：token **值**（色值、px、字体栈字符串）不进 i18n——它们是 CSS 字面量，语言切换不触碰；只有 `name` 这个**展示文案**走 i18n。颜色不翻译、只替换。
- **与对比度审计**：`IPC.themes.build` 在 build 后对合并 Theme 跑 `auditThemeContrast`（`CONTRAST_PAIRS` 逐对算 WCAG 比值）。`dark`/`light` 的十六进制色值可被静态解析，低于 AA 阈值会在主进程告警（诊断不阻断渲染）。
- **与 theme-context 的会话流独立主题**：`TimelineThemeScope` 可给中区挂一个独立主题实例，`__inherit__` 表示级联回全局。本插件的 `auto` 是唯一消费 `systemThemeTick`（`system:systemThemeChanged` 事件）触发重 build 的主题。

## QA

**Q：为什么 `dark` 和 `light` 不声明 `color.disabled` / `color.disabled-fg`？**

禁用态是低强调控件态，WCAG 豁免非激活组件，不进 `CONTRAST_PAIRS`。圆心兜底用 `color-mix(in srgb, var(--color-fg) 10%, transparent)` + `var(--color-muted)` 的相对值，明暗主题都协调。主题显式设反而会把禁用态焊死成某个具体色。

**Q：`auto` 为什么是空 tokens + `base: "__auto__"`，而不是直接把 tokens 指向 dark？**

因为「跟随系统」是运行时条件（OS 明暗会翻转），不是静态继承。把判断放 `resolveTheme` 入口（`systemDark` 由 `nativeTheme.shouldUseDarkColors()` 注入，不 import electron 的 node 服务器也能用 Host 抽象），系统翻转时 `system:systemThemeChanged` 事件触发重 build，`__auto__` 重新分流。空 tokens 保证了它自己不污染结果。

**Q：删掉 theme 插件会发生什么？**

七个配色方案 `base` 解析抛「主题不存在: dark/light」，`buildTheme` catch 后整体回退 `THEME_TOKEN_DEFAULTS`（低保真兜底，防白屏）。所以它 `protected: true`，且 `dark` 的 tokens 与圆心默认值高度重合——默认值本来就是按暗色主题抄的（历史漂移点：`list.selected.bg`/`divider.color`/`divider.inset` 与 dark 已漂移 3 处，语义上「兜底」≠「dark 的复制」）。

**Q：为什么浅色主题不声明间距/圆角，暗色却声明全套？**

几何常量（间距/圆角/边框宽度/字族）是「主题气质」的一部分但通常明暗共享。`light` 选择只表达颜色与阴影层级、几何交给圆心默认，减少重复声明；`dark` 作为其它暗色主题的 base，需要显式铺开全套骨架供子主题继承。两者最终落到同一个圆心默认几何值，视觉一致，只是「显式声明」与「继承默认」两条路径。

**Q：`tokenSchemaVersion` 不兼容时插件会被卸载吗？**

不会。加载器只跳过该插件的 **themes** 贡献项（其余槽位照注册），告警后主题回退默认值，插件本身仍 active。这是「不因一个主题版本不合就废掉整个插件」的降级策略。
