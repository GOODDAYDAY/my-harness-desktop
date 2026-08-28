# theme-terminal（Terminal 终端风格主题）

theme-terminal 是**纯数据型**配色方案插件：一个 `plugin.json` 挂一条 `themes` 槽贡献（`terminal-dark`），无 renderer、无 locales。它是七个配色方案里「气质最极端」的一个——纯黑底、荧光绿 primary、全等宽字体、零圆角、零阴影、最快运动节奏，完整复刻终端（绿字黑底 CRT）的观感。它也是唯一把 `font.family.sans` 也声明成 mono 栈、且 `radius`/`shadow` 归零的主题。

## 结构

plugin.json 顶层：`id` / `version` / `tier` / `displayName` / `description` / `tokenSchemaVersion: "^1.0"` / `contributes`。`contributes.themes` 一条 `ThemeContribution`：

- `id: "terminal-dark"`：注册表唯一键 + 偏好 id。
- `name: "Terminal Dark"`：字面量，直显不走 i18n。
- `base: "dark"`：跨插件指向 theme 插件的 `dark`。
- `tokens`：覆盖颜色 15 + 字族 1（sans）+ 间距 5 + 圆角 3 + 阴影 3 + 运动时长 3 + 分割线 3，共 33 个——七个配色方案里覆盖维度最多的一个。

## 声明了什么 tokens

- **颜色（15 个）**：`color.bg #000000`（纯黑）、`color.fg #f5f5f5`、`color.surface #111111`、`color.surface-fg #f5f5f5`、`color.primary #4ade80`（荧光绿，终端绿字）、`color.primary-fg #000000`、`color.accent.success #4ade80`（success 与 primary 同绿）、`color.accent.warning #facc15`、`color.accent.error #ef4444`、`color.accent.danger #ef4444`、`color.border #1f1f1f`、`color.muted #737373`、`color.chrome #000000`（外壳面也纯黑，全黑沉浸）、`color.list.selected.bg #111111`、`color.list.selected.border transparent`。
- **字族（1 个）**：`font.family.sans` = `"SF Mono", "JetBrains Mono", "Menlo", "Consolas", "Microsoft YaHei", monospace`——**正文 UI 也用等宽**，全界面终端化。`font.family.mono` 不声明，沿用 dark 的默认 mono 栈。
- **间距（5 个，整体收紧）**：`spacing.xs/sm/md/lg/xl` = 6/10/14/20/28px，比 dark 的 8/12/16/24/32 更紧凑，符合终端高密度。
- **圆角（3 个，几乎归零）**：`radius.sm 0px`、`radius.md 2px`、`radius.lg 4px`——终端方角，无圆润。
- **阴影（3 个，全部 none）**：`shadow.sm/md/lg` 全 `none`——终端无投影。
- **运动（3 个时长，最快）**：`motion.duration.fast/normal/slow` = 60/120/200ms，比 dark 默认（120/200/300）快一倍，终端「即时响应」。不覆 `motion.ease.*`。
- **分割线（3 个）**：`divider.color rgba(74,222,128,0.12)`（荧光绿低透明，呼应 primary）、`divider.width 1px`、`divider.inset 6px`（最紧凑缩进）。

**未声明、靠继承的**：`font.family.mono`、滚动条、边框宽度、`motion.ease.*` 沿用 dark。`font.size.*` / `border.color` 派生不赋值。

## 经 merge 管线如何生效

`resolveTheme("terminal-dark")` 先 `resolveTheme("dark")` 再覆自身 33 token。颜色/字族/间距/圆角/阴影/运动/分割线全被覆盖，滚动条/边框宽度/缓动沿用 dark，字号走圆心默认 × fontScale，字体再被 `applyFontChoice` 覆盖。合并后 `injectThemeCssVars` 写变量生效。

## 与其它插件的交互

- **依赖 theme 插件**：`base: "dark"` 硬引用，theme 缺失则回退默认。
- **与 theme-manager**：`ctx.themes.list()` 渲染「Terminal Dark」选择卡，选中回写 `setCurrentThemeId`。
- **与 i18n**：token 值与 `name` 均不走 i18n。
- **与 font-presets（关键交互）**：本主题把 `font.family.sans` 声明成 mono 栈，但**用户字体偏好优先于主题字族**——`applyFontChoice` 在合并后覆盖 `font.family.sans`，只要用户在字体 tab 选了非 mono 英文段，sans 栈就被三段拼接覆盖，终端「全等宽」气质让位于用户选择。这是「主题声明 vs 用户偏好」的优先级关系：用户 > 主题。
- **与对比度审计**：`#f5f5f5` on `#000000` 对比极高，`primary #4ade80` on `#000000` 也高，终端主题通常全项通过审计。

## QA

**Q：为什么把 `font.family.sans` 也声明成 mono 栈？**

终端气质的核心是「一切皆等宽」——正文、按钮、输入框全用等宽字形，像在一个全屏终端里操作。`font.family.sans` 是正文 UI 的字族 token，把它也指向 mono 栈，全界面即终端化。这是「主题可以决定文字样式（字族）」的边界内操作——字号（`font.size.*`）不可设，但字族（`font.family.*`）可以。

**Q：`radius.sm 0px`、`shadow.* none` 会不会让组件看起来「坏」了？**

不会。`0px` 圆角和 `none` 阴影都是合法 CSS 值，框架组件消费 `var(--radius-sm)` 和 `var(--shadow-md)` 后自然呈现方角无投影。这就是终端的「硬边」气质——对比 New York 的 16px 大圆角，两个主题用同一批 token 表达完全相反的形态。机制不预设「圆角/阴影必须非零」。

**Q：终端主题的等宽字体为什么可能被用户覆盖？**

因为字体栈有独立的用户偏好通道（`fontMonoChoice`/`fontEnglishChoice`/`fontChineseChoice` → `applyFontChoice`），它在主题合并**之后**注入，优先级高于主题声明。主题只能声明「默认字族」，用户显式选择永远胜出。这是「用户偏好 > 主题默认」的分层，和「用户 fontScale > 主题（主题根本不能设字号）」同一条原则。

**Q：运动时长 60ms 会不会太急促？**

对终端气质而言是「即时响应」——命令敲下去立刻反馈。`motion.duration.fast` 从 dark 的 120ms 压到 60ms，比 Midnight 的 160ms 快近三倍，三者对比就是「节奏也是主题内容」的最好例证。消费 `var(--motion-duration-fast)` 的动画自动变快，无需改组件。

**Q：`color.chrome` 和 `color.bg` 都是纯黑，三层背景语义不就坍缩了吗？**

是的，终端主题刻意让 chrome（外壳面）和 bg（主区）同黑，制造「无边界沉浸」，只靠 `color.surface #111111` 的卡片色和 `color.border #1f1f1f` 的边框区分层次。三层背景语义（bg → chrome → surface）是圆心给出的**能力**，主题可以选择让 chrome 沉一层（如 theme 插件的 dark）、也可以让 chrome 与 bg 同值（本主题）。语义是「可用的三个槽位」，不是「必须三个不同值」。
