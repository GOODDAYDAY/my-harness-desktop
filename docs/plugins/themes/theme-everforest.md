# theme-everforest（Everforest 暖绿森系主题）

theme-everforest 是**纯数据型**配色方案插件：一个 `plugin.json` 挂两条 `themes` 槽贡献（`everforest-dark` / `everforest-light`），无 renderer、无 locales。它复刻 Everforest 的暖绿低饱和森系配色——米白纸感底、暖绿 primary、低对比柔语义色，明暗双色都偏「护眼的低刺激」。它是七个配色方案里同时贡献明暗两版的插件之一（另两个是 theme-new-york 和 theme-stone），且明暗各以 theme 插件的对应根为主题。

## 结构

plugin.json 顶层：`id` / `version` / `tier` / `displayName` / `description` / `tokenSchemaVersion: "^1.0"` / `contributes`。`contributes.themes` 两条 `ThemeContribution`：

- `everforest-dark`：`name: "Everforest Dark"`（字面量，不走 i18n），`base: "dark"`，tokens 覆盖颜色 15 + 圆角 3 + 滚动条 2 + 分割线 1。
- `everforest-light`：`name: "Everforest Light"`，`base: "light"`，tokens 覆盖颜色 15 + 圆角 3 + 分割线 1（不覆滚动条）。

两条共用同一套圆角（6/10/14px）和同一气质的分割线，差异只在明暗色值。

## 声明了什么 tokens

`everforest-dark`（base dark）：

- **颜色（15 个）**：`color.bg #2d353b`（暖深灰）、`color.fg #d3c6aa`（暖米白，Everforest 标志性前景）、`color.surface #343f44`、`color.surface-fg #d3c6aa`、`color.primary #a7c080`（暖绿）、`color.primary-fg #2d353b`、`color.accent.success #a7c080`（success 与 primary 同绿）、`color.accent.warning #dbbc7f`、`color.accent.error #f49093`、`color.accent.danger #f49093`、`color.border #475258`、`color.muted #859289`、`color.chrome #232a2e`、`color.list.selected.bg #3d484d`、`color.list.selected.border transparent`。
- **圆角（3 个）**：`radius.sm/md/lg` = 6/10/14px，比 dark 的 4/8/12 略圆。
- **滚动条（2 个）**：`scrollbar.thumb rgba(211,198,170,0.2)`、`scrollbar.thumb.hover rgba(211,198,170,0.32)`——thumb 用前景色做半透明，滚动条随主题气质。不覆 `scrollbar.width/radius`（沿用 dark）。
- **分割线（1 个）**：`divider.color rgba(211,198,170,0.08)`。不覆 `divider.width/inset`（沿用 dark）。

`everforest-light`（base light）：

- **颜色（15 个）**：`color.bg #fdf6e3`（米白纸色）、`color.fg #5c6a72`、`color.surface #f4f0d9`、`color.surface-fg #5c6a72`、`color.primary #8da101`（橄榄绿）、`color.primary-fg #232a2e`、`color.accent.success #5f7101`、`color.accent.warning #8a5d00`、`color.accent.error #c23430`、`color.accent.danger #c23430`、`color.border #e0dcc7`、`color.muted #76867a`、`color.chrome #efebd4`、`color.list.selected.bg #e6e2cc`、`color.list.selected.border transparent`。
- **圆角（3 个）**：同暗色 6/10/14px。
- **分割线（1 个）**：`divider.color rgba(92,106,114,0.1)`。

**未声明、靠继承的**：间距、阴影、运动、字族、边框宽度全部沿用各自 base（dark/light 的继承链再落到圆心默认）；`scrollbar.thumb` 只在暗色覆、亮色不覆（亮色用 light 继承的滚动条色）。`font.size.*` 与 `border.color` 是派生 token，不赋值。

## 经 merge 管线如何生效

`buildCurrentTheme("everforest-dark", ...)` → `resolveTheme("everforest-dark")` 先递归 `resolveTheme("dark")`（`{DEFAULTS, ...dark}`），再覆盖自身 21 个 token；`everforest-light` 同理先 `resolveTheme("light")`。关键差异：light 的 base 链是 `DEFAULTS → light → everforest-light`，而 light 本身不声明间距/圆角/字族，所以 everforest-light 的几何常量实际来自圆心默认值，圆角则由本插件显式覆盖为 6/10/14。合并后 `injectThemeCssVars` 写 CSS 变量生效。

## 与其它插件的交互

- **依赖 theme 插件**：两条 base（`dark`/`light`）都是跨插件硬引用，theme 插件缺失则回退默认。
- **与 theme-manager**：`ctx.themes.list()` 渲染两张卡（「Everforest Dark」「Everforest Light」直显），选中回写 `setCurrentThemeId`。
- **与 i18n**：token 值和 `name` 都不走 i18n，切语言零影响。
- **与 font-presets**：不声明字族，字形全由用户偏好决定。
- **与对比度审计**：十六进制色可静态解析进 `auditThemeContrast`，低对比告警不阻断。Everforest 的整体低饱和设计天然对比度偏低，审计能抓出 muted-on-surface 这类组合的不足。

## QA

**Q：为什么 success 和 primary 用同一个绿色？**

Everforest 的语义色哲学是「克制的同族色」：成功态与主强调共享暖绿，视觉上主色即成功色，减少界面彩色数量。对比 ChatGPT 主题的 primary 白 + success 绿就看出差异——语义色是否与 primary 同源是主题气质的一部分，都只落在 `color.accent.success` / `color.primary` 两个 key 上。

**Q：为什么暗色覆滚动条 thumb、亮色不覆？**

暗色的滚动条用前景色 `#d3c6aa` 的半透明，能随森系暖调走；亮色沿用 light 继承的 `rgba(134,142,150,0.5)` 灰系即可协调。这是「按需覆盖」：缺什么补什么，light 的滚动条默认值在米白底上已经合适，不必重声明。

**Q：light 版不声明间距/圆角，但暗色版声明了圆角，几何不一致吗？**

不。light 版显式声明了圆角 6/10/14（与暗色一致），只是间距/阴影/运动靠 light 继承链落圆心默认——而 dark 也靠 dark 继承链落同样的圆心默认间距/阴影/运动。最终明暗两版几何常量一致，只是「圆角显式写两遍」而「间距/阴影/运动都吃圆心默认」两条路径殊途同归。

**Q：Everforest 低饱和色对比度不足怎么办？**

`auditThemeContrast` 在 build 后对 `CONTRAST_PAIRS` 逐对算 WCAG 比值，不达标只在主进程 `console.warn`（诊断不阻断，主题开发者可见）。终端用户不受损；主题作者据此调色。静态解析不了的值（`var()`/`color-mix()`）记 skipped 不误报。

**Q：为什么这个插件贡献明暗两版，而 chatgpt/midnight/mocha/terminal 只有暗色？**

取决于配色方案的「原生形态」。Everforest 有官方明暗双色，theme-stone / theme-new-york 同理；ChatGPT 只以暗色闻名、Midnight/Mocha/Terminal 名字本身就暗色。这是内容层的取舍，机制不做任何「必须成对」的假设——单暗色主题照样走 `base: "dark"` 生效。
