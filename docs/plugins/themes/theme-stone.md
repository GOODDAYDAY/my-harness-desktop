# theme-stone（Stone 石色主题）

theme-stone 是**纯数据型**配色方案插件：一个 `plugin.json` 挂两条 `themes` 槽贡献（`stone-dark` / `stone-light`），无 renderer、无 locales。它是 Tailwind 的 stone 石色板——暖灰褐底、天蓝 primary、柔语义色、较大圆角，明暗双版。它和 theme-new-york 同源（都是 shadcn/ui 风格），但走暖灰而非冷灰，且 `divider.inset` 更大（14px）。

## 结构

plugin.json 顶层：`id` / `version` / `tier` / `displayName` / `description` / `tokenSchemaVersion: "^1.0"` / `contributes`。`contributes.themes` 两条 `ThemeContribution`：

- `stone-dark`：`name: "Stone Dark"`（字面量，不走 i18n），`base: "dark"`，tokens 覆盖颜色 15 + 圆角 3 + 阴影 3 + 分割线 3。
- `stone-light`：`name: "Stone Light"`，`base: "light"`，tokens 覆盖颜色 15 + 圆角 3 + 阴影 3 + 分割线 3。

两条结构对称，只明暗色值相反。

## 声明了什么 tokens

`stone-dark`（base dark）：

- **颜色（15 个）**：`color.bg #1c1917`（stone-900 暖黑褐）、`color.fg #e7e5e4`（stone-200）、`color.surface #292524`（stone-800）、`color.surface-fg #e7e5e4`、`color.primary #38bdf8`（sky-400）、`color.primary-fg #0a0a0a`、`color.accent.success #86efac`、`color.accent.warning #fde68a`、`color.accent.error #fca5a5`、`color.accent.danger #f87171`、`color.border rgba(255,255,255,0.08)`、`color.muted #a8a29e`（stone-400 暖灰）、`color.chrome #141110`、`color.list.selected.bg #292524`、`color.list.selected.border transparent`。
- **圆角（3 个）**：`radius.sm/md/lg` = 8/12/16px。
- **阴影（3 个）**：低透明柔阴影。
- **分割线（3 个）**：`divider.color rgba(231,229,228,0.10)`、`divider.width 1px`、`divider.inset 14px`（比大多数主题的 10/12px 更大，留白更多）。

`stone-light`（base light）：

- **颜色（15 个）**：`color.bg #fafaf9`（stone-50）、`color.fg #1c1917`（stone-900）、`color.surface #f5f5f4`（stone-100）、`color.surface-fg #1c1917`、`color.primary #0ea5e9`（sky-500，浅色用更深蓝保对比）、`color.primary-fg #0a0a0a`、`color.accent.success #166534`、`color.accent.warning #92400e`、`color.accent.error #b91c1c`、`color.accent.danger #991b1b`、`color.border rgba(0,0,0,0.06)`、`color.muted #78716c`（stone-500 暖灰）、`color.chrome #f5f5f4`、`color.list.selected.bg #f0efed`、`color.list.selected.border transparent`。
- **圆角/阴影/分割线**：与暗色同结构（8/12/16px 圆角、`divider.inset 14px`）。

**未声明、靠继承的**：间距、运动、字族、滚动条、边框宽度全部沿用各自 base。`font.size.*` / `border.color` 派生不赋值。

## 经 merge 管线如何生效

`resolveTheme("stone-dark")` 先 `resolveTheme("dark")` 再覆自身 24 token；`stone-light` 先 `resolveTheme("light")` 再覆自身 24 token。合并后 `injectThemeCssVars` 写变量生效。

## 与其它插件的交互

- **依赖 theme 插件**：两条 base 硬引用，theme 缺失则回退默认。
- **与 theme-manager**：`ctx.themes.list()` 渲染「Stone Dark」「Stone Light」两张卡，选中回写 `setCurrentThemeId`。
- **与 i18n**：token 值与 `name` 均不走 i18n。
- **与 font-presets**：不声明字族，字形由用户偏好决定。
- **与对比度审计**：十六进制色进 `auditThemeContrast`；`muted #a8a29e` on `surface #292524` 走 largeText（≥3:1）档，浅色 `muted #78716c` on `surface #f5f5f4` 同理。

## QA

**Q：Stone 和 New York 到底怎么区分？**

两者 token key 全同、圆角同、primary 同（天蓝系），唯一实质差异是**色板基调**：Stone 走 Tailwind 的 stone 暖灰（`#1c1917`/`#292524`/`#a8a29e` 带褐调），New York 走 zinc 冷灰（`#0b0b0c`/`#171717`/`#9a9a9a` 带蓝调）。此外 Stone 的 `divider.inset 14px` 比 New York 的 12px 更大。暖/冷灰的取舍就是这两个主题的全部差异——机制对两者完全无感。

**Q：`divider.inset 14px` 是什么效果？**

分割线左右各缩进 14px，不顶满容器边缘，视觉上「有呼吸、不像接缝」。不同主题按气质调 inset：terminal 6px（紧贴终端风）、chatgpt 12px、stone 14px（最宽松）。`divider.inset` 是独立 token，主题可单改缩进而不动颜色/宽度。

**Q：Stone 的 muted 为什么在明暗下用两个不同 stone 灰？**

`muted` 是次要文字，暗色用 stone-400（`#a8a29e`）在 `#292524` 上够亮，浅色用 stone-500（`#78716c`）在 `#f5f5f4` 上够暗。同语义不同亮度，保证对比度达标。这是「语义色随明暗取反亮度」的又一例，落在 `color.muted` key 上。

**Q：`color.list.selected.bg` 为什么等于 `color.surface`？**

Stone 的选中态用「选中=卡片底色、无边框」的去边框风格（`border transparent`）。对比 dark 用独立选中色 `#232328`。选中态视觉是主题内容，落在 `color.list.selected.bg/border` 两个 key 上，机制不预设「选中必须有边框或必须变色」。

**Q：这个插件和 theme-new-york 这么像，为什么不合并成一个插件贡献四条主题？**

一个插件可以贡献多条 themes（theme 插件就是三条），但「石色」和「New York」是两个独立配色方案品牌，分插件更符合「一个内容插件一个主题族」的边界。合并也行、不合并也行——机制只认 themes 槽数组，不关心一个插件贡献几条。这是内容组织自由度的体现。
