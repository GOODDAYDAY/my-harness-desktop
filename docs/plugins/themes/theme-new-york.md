# theme-new-york（New York 主题）

theme-new-york 是**纯数据型**配色方案插件：一个 `plugin.json` 挂两条 `themes` 槽贡献（`new-york-dark` / `new-york-light`），无 renderer、无 locales。它是 shadcn/ui 的 New York 风格——近黑/近白极简底、天蓝 primary、较大圆角、克制阴影，明暗双版。它与 theme-everforest、theme-stone 并列为七个配色方案里贡献明暗双版的三个插件。

## 结构

plugin.json 顶层：`id` / `version` / `tier` / `displayName` / `description` / `tokenSchemaVersion: "^1.0"` / `contributes`。`contributes.themes` 两条 `ThemeContribution`：

- `new-york-dark`：`name: "New York Dark"`（字面量，不走 i18n），`base: "dark"`，tokens 覆盖颜色 15 + 圆角 3 + 阴影 3 + 分割线 3。
- `new-york-light`：`name: "New York Light"`，`base: "light"`，tokens 覆盖颜色 15 + 圆角 3 + 阴影 3 + 分割线 3。

两条结构对称：同色相（天蓝 primary）、同圆角（8/12/16px）、同分割线 inset（12px），只明暗色值相反。

## 声明了什么 tokens

`new-york-dark`（base dark）：

- **颜色（15 个）**：`color.bg #0b0b0c`（近黑）、`color.fg #fafafa`、`color.surface #171717`（zinc-900）、`color.surface-fg #fafafa`、`color.primary #38bdf8`（sky-400 天蓝）、`color.primary-fg #0a0a0a`、`color.accent.success #4ade80`、`color.accent.warning #facc15`、`color.accent.error #f87171`、`color.accent.danger #ef4444`（error 与 danger 首次分色——danger 用红-500 更艳）、`color.border rgba(255,255,255,0.08)`、`color.muted #9a9a9a`、`color.chrome #080808`、`color.list.selected.bg #1a1a1a`、`color.list.selected.border transparent`。
- **圆角（3 个）**：`radius.sm/md/lg` = 8/12/16px，比 dark 的 4/8/12 明显更圆，New York 的圆润气质。
- **阴影（3 个）**：`shadow.sm/md/lg` 低透明柔阴影。
- **分割线（3 个）**：`divider.color rgba(255,255,255,0.10)`、`divider.width 1px`、`divider.inset 12px`。

`new-york-light`（base light）：

- **颜色（15 个）**：`color.bg #ffffff`、`color.fg #09090b`（zinc-950）、`color.surface #f6f6f6`、`color.surface-fg #09090b`、`color.primary #0ea5e9`（sky-500，浅色用更深的蓝保对比）、`color.primary-fg #0a0a0a`、`color.accent.success #166534`、`color.accent.warning #92400e`、`color.accent.error #b91c1c`、`color.accent.danger #991b1b`、`color.border rgba(0,0,0,0.06)`、`color.muted #6b6b6b`、`color.chrome #f7f8f9`、`color.list.selected.bg #eceef0`、`color.list.selected.border transparent`。
- **圆角/阴影/分割线**：与暗色同结构（8/12/16px 圆角、低透明阴影、`divider.inset 12px`）。

**未声明、靠继承的**：间距、运动、字族、滚动条、边框宽度全部沿用各自 base。`font.size.*` / `border.color` 派生不赋值。

## 经 merge 管线如何生效

`resolveTheme("new-york-dark")` 先 `resolveTheme("dark")`，再覆自身 24 token；`new-york-light` 先 `resolveTheme("light")` 再覆自身 24 token。两条 base 链最终都落到 `THEME_TOKEN_DEFAULTS` 兜底。合并后 `injectThemeCssVars` 写变量生效。

## 与其它插件的交互

- **依赖 theme 插件**：两条 base 硬引用，theme 缺失则回退默认。
- **与 theme-manager**：`ctx.themes.list()` 渲染「New York Dark」「New York Light」两张卡，选中回写 `setCurrentThemeId`。
- **与 i18n**：token 值与 `name` 均不走 i18n。
- **与 font-presets**：不声明字族，字形由用户偏好决定。
- **与对比度审计**：十六进制色进 `auditThemeContrast`；`error #f87171` 与 `danger #ef4444` 分色后分别审计，浅色的语义色转深色系保对比。

## QA

**Q：New York 和 theme-stone 的 token 结构几乎一样，区别在哪？**

圆角（8/12/16 vs 8/12/16 相同）、primary（都天蓝）、但**色板基调**不同：New York 走 zinc 中性灰（`#171717`/`#09090b`），theme-stone 走 stone 暖灰（`#292524`/`#1c1917`）。两者都源自 shadcn/ui 的 palette，一个冷一个暖。token key 全同，值不同——这正是「key 是契约、值是内容」的最直观例证。

**Q：为什么 dark 的 error 和 danger 分色，light 也分？**

New York 严格区分「错误」（error，红-400 `#f87171`）与「危险/破坏性动作」（danger，红-500 `#ef4444`）。多数主题（chatgpt/mocha/everforest/midnight）让两者同值，但契约提供了两个独立 key，主题可以选择分色。分不分色是主题内容，机制不强制。

**Q：浅色版 primary 为什么比暗色版更深？**

浅色底上浅蓝 `#38bdf8` 对比度不足，所以 light 用 `#0ea5e9`（sky-500）。这是「同一语义色在不同明暗下取不同亮度」的标准做法——语义不变（都是 primary 蓝），值随明暗调，保证 `color.primary` on 各底色的 WCAG 对比。

**Q：`color.chrome #080808` 比 `color.bg #0b0b0c` 还黑，为什么？**

chrome 是外壳面（左栏/右面板），比主区沉一层是三层背景语义（bg → chrome → surface 逐层抬亮）。New York 的 chrome 取比 bg 更黑的值，让侧栏视觉上「退后」，主区内容「前凸」。这正是 `color.chrome` 这个 token 存在的意义——外壳面背景独立可控。

**Q：New York 的圆角为什么比 dark 大这么多？**

New York 是 shadcn/ui 的「圆润极简」风格，8/12/16px 圆角是它的视觉指纹。`radius.*` 是主题可覆的几何 token，所有消费 `var(--radius-md)` 的组件（卡片、按钮、输入框）自动同步变圆，无需改任何组件代码。
