# theme-midnight（Midnight 深色主题）

theme-midnight 是**纯数据型**配色方案插件：一个 `plugin.json` 挂一条 `themes` 槽贡献（`midnight-dark`），无 renderer、无 locales。它是一套「比 dark 更沉更慢」的深色主题——更黑的底、压淡的前景、去阴影的扁平感、明显放慢的运动节奏，适合深夜低光环境。它是七个配色方案里唯一主动 `shadow.sm: "none"` 并放慢三档时长的插件。

## 结构

plugin.json 顶层：`id` / `version` / `tier` / `displayName` / `description` / `tokenSchemaVersion: "^1.0"` / `contributes`。`contributes.themes` 一条 `ThemeContribution`：

- `id: "midnight-dark"`：注册表唯一键 + 偏好 id。
- `name: "Midnight Dark"`：字面量，直显不走 i18n。
- `base: "dark"`：跨插件指向 theme 插件的 `dark`。
- `tokens`：覆盖颜色 15 + 阴影 3 + 运动时长 3 + 分割线 3，共 24 个。

## 声明了什么 tokens

- **颜色（15 个）**：`color.bg #101014`（比 dark 的 `#0e0e11` 略冷灰）、`color.fg #b8b8c0`（前景明显压淡，降低刺眼）、`color.surface #18181d`、`color.surface-fg #b8b8c0`、`color.primary #d0d0d8`（柔白）、`color.primary-fg #141417`、`color.accent.success #7ba88b`、`color.accent.warning #b3a06b`、`color.accent.error #c07a7a`、`color.accent.danger #c07a7a`、`color.border #232329`、`color.muted #6a6a74`、`color.chrome #0b0b0e`、`color.list.selected.bg #1d1d22`、`color.list.selected.border transparent`。语义色整体低饱和（偏灰绿/灰黄/灰红），延续「低刺激」气质。
- **阴影（3 个）**：`shadow.sm "none"`（小阴影直接取消，扁平化）、`shadow.md 0 2px 8px rgba(0,0,0,0.25)`、`shadow.lg 0 8px 24px rgba(0,0,0,0.35)`——比 dark 更克制。
- **运动（3 个时长）**：`motion.duration.fast/normal/slow` = 160/260/360ms，三档都比 dark 默认（120/200/300）慢约 30%，营造「深夜慢节奏」。不覆 `motion.ease.*`（沿用继承的圆心缓动）。
- **分割线（3 个）**：`divider.color rgba(255,255,255,0.05)`、`divider.width 1px`、`divider.inset 10px`。

**未声明、靠继承的**：间距、圆角、字族、滚动条、边框宽度全部沿用 dark；`font.size.*` / `border.color` 派生不赋值。

## 经 merge 管线如何生效

`resolveTheme("midnight-dark")` 先 `resolveTheme("dark")` 得 `{DEFAULTS, ...dark}`，再覆自身 24 token，产出 `{DEFAULTS, ...dark, ...midnight-dark}`。阴影/运动/分割线被覆盖，几何与字族沿用 dark，字号走圆心默认 × fontScale，字体再被 `applyFontChoice` 覆盖。合并后 `injectThemeCssVars` 写变量生效。

## 与其它插件的交互

- **依赖 theme 插件**：`base: "dark"` 硬引用，theme 缺失则回退默认。
- **与 theme-manager**：`ctx.themes.list()` 渲染「Midnight Dark」选择卡，选中回写 `setCurrentThemeId`。
- **与 i18n**：token 值与 `name` 均不走 i18n。
- **与 font-presets**：不声明字族，字形由用户偏好决定。
- **与对比度审计**：`shadow.sm "none"` 不影响审计（审计只看颜色对）；前景 `#b8b8c0` 对 `#101014` 的对比进 `auditThemeContrast` 静态校验。

## QA

**Q：`shadow.sm: "none"` 有什么影响？**

消费 `var(--shadow-sm)` 的组件（小卡片、浮层）不再有投影，视觉上更扁平、贴底。`none` 是合法 CSS 阴影值，`applyFontScale` 不会碰它（只处理 `font.size.*`），注入 `--shadow-sm: none` 后浏览器直接无阴影。这是主题气质——Midnight 追求「沉」，去小阴影减浮起感。

**Q：为什么放慢运动而不覆盖 ease？**

时长和缓动是两个正交维度：时长决定「多久」，缓动决定「加速度曲线」。Midnight 只想放慢节奏（duration），手感曲线沿用 dark 继承的圆心标准缓动即可，无需重写。逐 key 覆盖的好处：改一个维度不必连带另一个。

**Q：语义色为什么都压成低饱和？**

深夜低光下高饱和色（如 ChatGPT 的 `#34d399` 绿）会刺眼。Midnight 把 success/warning/error 全调成灰调（`#7ba88b`/`#b3a06b`/`#c07a7a`），保持「这是成功/警告/错误」的语义可辨性，同时降刺激。语义色的饱和度也是主题内容，落在 `color.accent.*` key 上。

**Q：和 dark 主题比，Midnight 到底改了什么？**

一句话：更黑（bg/chrome 都压一档）、更柔（fg/muted 压淡、语义色降饱和）、更平（shadow.sm none、阴影减弱）、更慢（三档时长 +30%）。间距/圆角/字族/滚动条完全不动，继承 dark。它是「差异层」覆盖语义的标准示范——只写与 base 不同的 key。

**Q：`motion.duration.slow` 360ms 会不会让 UI 显得卡？**

不会「卡」，是「慢半拍」的有意节奏。这些值最终由组件 `var(--motion-duration-slow)` 消费，若某个主题想快就覆成更小值（对比 theme-terminal 的 200ms）。节奏是主题内容，机制不预设「快=好」——圆心默认只是兜底。
