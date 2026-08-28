# theme-mocha（Mocha 暖色主题）

theme-mocha 是**纯数据型**配色方案插件：一个 `plugin.json` 挂一条 `themes` 槽贡献（`mocha-dark`），无 renderer、无 locales。它是 Catppuccin Mocha 调色板的落地——薰衣草蓝 primary、奶油白前景、柔粉 error、更圆的圆角。它也是七个配色方案里声明最精简的之一：只覆盖颜色 + 圆角 + 分割线，其余全从 `base: "dark"` 继承。

## 结构

plugin.json 顶层：`id` / `version` / `tier` / `displayName` / `description` / `tokenSchemaVersion: "^1.0"` / `contributes`。`contributes.themes` 一条 `ThemeContribution`：

- `id: "mocha-dark"`：注册表唯一键 + 偏好 id。
- `name: "Mocha Dark"`：字面量，直显不走 i18n。
- `base: "dark"`：跨插件指向 theme 插件的 `dark`。
- `tokens`：覆盖颜色 15 + 圆角 3 + 分割线 3，共 21 个。

## 声明了什么 tokens

- **颜色（15 个）**：`color.bg #1e1e2e`（Catppuccin base 深蓝紫）、`color.fg #cdd6f4`（奶油白 text）、`color.surface #313244`（surface0）、`color.surface-fg #cdd6f4`、`color.primary #89b4fa`（薰衣草蓝，Catppuccin 标志蓝）、`color.primary-fg #1e1e2e`、`color.accent.success #a6e3a1`（绿）、`color.accent.warning #f9e2af`（黄）、`color.accent.error #f38ba8`（红粉）、`color.accent.danger #f38ba8`、`color.border #45475a`（surface1 边框）、`color.muted #7f849c`（overlay0）、`color.chrome #151520`、`color.list.selected.bg #313244`、`color.list.selected.border transparent`。整套是 Catppuccin Mocha 的完整映射。
- **圆角（3 个）**：`radius.sm/md/lg` = 6/10/14px，比 dark 的 4/8/12 略圆，呼应 Catppuccin 的柔和感。
- **分割线（3 个）**：`divider.color rgba(205,214,244,0.08)`（前景色的低透明）、`divider.width 1px`、`divider.inset 12px`。

**未声明、靠继承的**：间距、阴影、运动、字族、滚动条、边框宽度全部沿用 dark。`font.size.*` / `border.color` 派生不赋值。

## 经 merge 管线如何生效

`resolveTheme("mocha-dark")` 先 `resolveTheme("dark")` 得 `{DEFAULTS, ...dark}`，再覆自身 21 token。颜色/圆角/分割线被覆盖，间距/阴影/运动/字族/滚动条沿用 dark，字号走圆心默认 × fontScale，字体再被 `applyFontChoice` 覆盖。合并后 `injectThemeCssVars` 写变量生效。

## 与其它插件的交互

- **依赖 theme 插件**：`base: "dark"` 硬引用，theme 缺失则回退默认。
- **与 theme-manager**：`ctx.themes.list()` 渲染「Mocha Dark」选择卡，选中回写 `setCurrentThemeId`。
- **与 i18n**：token 值与 `name` 均不走 i18n。
- **与 font-presets**：不声明字族，字形由用户偏好决定。
- **与对比度审计**：`#cdd6f4` on `#1e1e2e` 等高对比十六进制进 `auditThemeContrast` 静态校验，Catppuccin 的对比度设计良好，通常不告警。

## QA

**Q：Mocha 和 ChatGPT 的 primary 差异体现了什么？**

Mocha 的 `primary #89b4fa` 是彩色品牌蓝（Catppuccin 蓝），ChatGPT 的 `primary #ececec` 是反向白。两者都合法地落在 `color.primary` 这一个 key 上，但气质完全不同：一个是「彩色强调」，一个是「中性反白」。primary 的彩不彩是配色方案的第一视觉指纹，机制不做任何约束。

**Q：为什么这个主题只覆盖颜色 + 圆角 + 分割线，其它都继承？**

因为它只想换「Catppuccin 的色相」和「更柔的圆角」，间距/阴影/运动/字族与 dark 的默认无差异，没必要重声明。这是 base 继承的核心价值：主题作者只需写「与 base 不同的 key」，逐 key 覆盖、缺省继承，declaration 量即差异量。

**Q：分割线颜色为什么用前景色 `#cdd6f4` 的低透明而不是 border 色？**

`divider.color` 的值可以是任意 CSS 颜色。Mocha 选前景色的 `rgba(205,214,244,0.08)`，让分割线「若有若无地随前景色」，而非随 border 的灰紫。对比 dark 的 `rgba(255,255,255,0.06)`（白低透明）就看出：分割线取色也是主题内容，落在 `divider.color` key 上。

**Q：Catppuccin 色板哪来的？**

这是外部配色方案的移植，作者直接把 Catppuccin Mocha 的 base/surface/text/blue/green/yellow/red 映射到圆心的 `color.*` key 上。这正是「内容外挂」的意义：任何现成配色方案（Catppuccin、Everforest、Solarized…）都能映射成一套 token 值，机制不感知来源。

**Q：`color.list.selected.bg` 为什么和 `color.surface` 同值？**

选中态底色 = 卡片底色，靠透明边框（`border transparent`）+ 位置区分选中，是一种「去边框选中」风格。对比 dark 用 `#232328`（独立选中色）就看出差异。选中态视觉是主题内容，落在 `color.list.selected.bg/border` 两个 key 上。
