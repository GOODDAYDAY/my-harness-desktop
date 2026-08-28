# theme-chatgpt（ChatGPT 风格主题）

theme-chatgpt 是**纯数据型**配色方案插件：一个 `plugin.json` 挂一条 `themes` 槽贡献（`chatgpt-dark`），无 renderer 代码、无 locales。它复刻 ChatGPT 的中性灰暗色视觉——暖灰底、白 primary、柔语义色、更宽松的间距圆角、略慢的运动节奏。它不声明完整 token 集，只声明「与 dark 的差异层」，其余全部从 `base: "dark"` 继承。

## 结构

plugin.json 顶层：`id` / `version` / `tier` / `displayName` / `description` / `tokenSchemaVersion` / `contributes`。`tokenSchemaVersion: "^1.0"` 与 theme 插件同款兼容声明。`contributes.themes` 一条 `ThemeContribution`：

- `id: "chatgpt-dark"`：主题在注册表里的唯一键，也是 `base` 引用和偏好里存的 id。
- `name: "ChatGPT Dark"`：**字面量展示名，不含 `.`**，theme-manager 渲染时直接显示、不进 i18n（与 theme 插件的 `theme.dark` 走 `t()` 解析不同）。
- `base: "dark"`：跨插件按主题 id 指向 theme 插件注册的 `dark` 条目。
- `tokens`：32 个覆盖 token（颜色 15 + 间距 5 + 圆角 3 + 阴影 3 + 运动 3 + 分割线 3，见下）。

## 声明了什么 tokens

`chatgpt-dark` 声明的 token 分六类，是「在 dark 之上调差异」的覆盖层：

- **颜色（15 个）**：`color.bg #212121`、`color.fg #ececec`、`color.surface #2f2f2f`、`color.surface-fg #ececec`、`color.primary #ececec`（白字，ChatGPT 的 primary 是反向白而非彩色）、`color.primary-fg #212121`、`color.accent.success #34d399`、`color.accent.warning #facc15`、`color.accent.error #f87171`、`color.accent.danger #f87171`、`color.border rgba(255,255,255,0.08)`、`color.muted #9b9b9b`、`color.chrome #171717`、`color.list.selected.bg #2f2f2f`、`color.list.selected.border transparent`。
- **间距（5 个，整体放大）**：`spacing.xs/sm/md/lg/xl` = 10/16/20/28/40px，比 dark 的 8/12/16/24/32 更松。
- **圆角（3 个，整体加大）**：`radius.sm/md/lg` = 8/12/16px，比 dark 的 4/8/12 更圆润。
- **阴影（3 个）**：`shadow.sm/md/lg`，透明度略高，强化卡片浮起感。
- **运动（3 个时长）**：`motion.duration.fast/normal/slow` = 140/240/320ms，比 dark 默认（120/200/300）慢半拍。未声明 `motion.ease.*`，沿用 dark 继承的圆心缓动。
- **分割线（3 个）**：`divider.color rgba(255,255,255,0.12)`、`divider.width 1px`、`divider.inset 12px`。

**未声明、靠继承的**：`font.family.*`（dark 的 SF Mono/Sans 栈）、`scrollbar.*`（dark 的细条悬浮风）、`border.width.thin`、`color.disabled`/`color.disabled-fg`（dark 也不声明，最终落圆心兜底）。`font.size.*` 与 `border.color` 是派生 token，任何主题都不该显式赋值（赋了 merge 记警告并忽略）。

## 经 merge 管线如何生效

`buildCurrentTheme("chatgpt-dark", registry, ...)` → `resolveTheme` 递归：`chatgpt-dark` 有 base，先 `resolveTheme("dark")` 得到 `{ ...THEME_TOKEN_DEFAULTS, ...dark的own }`，再把自己的 19 个 token 覆盖上去，产出 `{ ...DEFAULTS, ...dark, ...chatgpt-dark }`。间距/圆角/阴影/运动的分割线值被本插件覆盖，字族/滚动条/边框宽度沿用 dark，字号沿用圆心默认 × fontScale，字体栈再被 `applyFontChoice` 按用户选择覆盖。合并后 `injectThemeCssVars` 写 `--color-bg` 等变量，组件即生效。

## 与其它插件的交互

- **依赖 theme 插件**：`base: "dark"` 是硬引用。theme 插件被删/禁用，本插件 resolve 抛「主题不存在: dark」，`buildTheme` 回退 `THEME_TOKEN_DEFAULTS`（低保真兜底）。
- **与 theme-manager**：经 `ctx.themes.list()` 查槽渲染成一张选择卡（`name` 字面量「ChatGPT Dark」直显，无 `.` 不走 i18n），选中回写 `setCurrentThemeId("chatgpt-dark")` 触发重 build。
- **与 i18n**：颜色/间距/圆角等 token 值全是不翻译的 CSS 字面量；唯一的用户可见文案 `name` 是英文品牌名，也不走 i18n。切语言不影响本主题任何像素。
- **与 font-presets**：不声明 `font.family.*`，字体全由用户偏好（`applyFontChoice`）决定，本主题不干预字形。
- **与对比度审计**：本主题用 `rgba()` 和 `color-mix` 之外多为十六进制，可静态解析的对比对进 `auditThemeContrast`，不达标主进程告警。

## QA

**Q：为什么 primary 是白色而不是某个彩色？**

这是 ChatGPT 的中性气质：主按钮/强调用反向明暗（白字黑底）而非品牌色，让语义色（success/warning/error）成为界面里唯一的彩色来源。对比 `theme-mocha` 的 `primary #89b4fa`（Catppuccin 蓝）就清楚：primary 的「彩不彩」是主题气质的一部分，都合法地落在 `color.primary` 这一个 key 上。

**Q：间距和圆角为什么整体放大？**

ChatGPT 的对话界面以宽松留白和圆润卡片著称。token 层面把 `spacing.*` 和 `radius.*` 整体抬一档，比逐组件改 CSS 更经济——所有消费 `var(--spacing-md)` 的组件自动同步变松，主题只改值不改布局结构。

**Q：声明了 `motion.duration.*` 却不声明 `motion.ease.*`，缓动从哪来？**

从 base 继承——dark 没声明 `motion.ease.*`，于是继续落到圆心默认 `cubic-bezier(0.4, 0, 0.2, 1)`。主题按需覆盖：想调节奏就覆 duration，想调手感才覆 ease，逐 key 覆盖、不重不漏，这正是 base 继承的覆盖语义。

**Q：如果我想改 ChatGPT 主题的字号怎么办？**

改不了——`font.size.*` 是 `DERIVED_TOKENS`，主题显式赋值会被 merge 剥离并忽略，字号只能来自圆心默认值 × 用户 `fontScale`。这是刻意设计：字号是用户无障碍偏好，主题不得劫持。想改变视觉密度，靠间距/圆角（本主题已做），不靠字号。

**Q：`name` 为什么不走 i18n？**

因为它不含 `.`，theme-manager 的判断逻辑是「含点走 `t()`，不含点直显」。品牌名「ChatGPT Dark」是专有名词，翻译反而失真；而 theme 插件的「深色/浅色/跟随系统」是通用概念，才需要随语言变。这是两种合法的命名策略，由 `name` 字面量是否带点区分。
