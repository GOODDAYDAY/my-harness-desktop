# font-presets（字体预设槽贡献）

font-presets 是**纯数据型插件**：只有 `plugin.json` + `locales/` 四份语言文件，没有任何 renderer 代码。它独占两个槽——`fontPresets`（17 个字体选项）和 `languages`（这 17 个选项的展示文案，四种语言）。它是字体栈这个「会变的内容」从圆心外推出来的落点：新增一个字体选项 = 改 manifest 一行 + 补一条语言 key，内核、merge 管线、theme-manager 全部零改动。它与 theme 系列插件正交——theme 管「配色与几何」，本插件管「文字用什么字形渲染」，两者经 merge 管线在同一个 `Theme` 上汇合。

## 结构

plugin.json 顶层：`id` / `version` / `tier` / `displayName` / `description` / `protected` / `contributes`。

- **`protected: true`**：与 theme 插件同理由——字体预设是全局依赖，不可卸载。
- **无 `tokenSchemaVersion`**：本插件不贡献 themes 槽，token 清单兼容判定不适用。
- `contributes.fontPresets`：17 条 `FontPresetContribution = { id, category, labelKey, stack, generic? }`，按 `category` 分三组。
- `contributes.languages`：4 条 `LanguageContribution`（`zh-CN` / `zh-TW` / `en` / `de`），每条 `resources` 指向 `./locales/{locale}/fonts.json`，key 是 17 个 `labelKey`。

目录里 `locales/zh-CN` `zh-TW` `en` `de` 四份 `fonts.json` 结构完全一致，只有文案值不同。这是「文案外挂语言槽」的标准形态：manifest 里只存 `labelKey`（稳定查询契约），值（会变的文案）由 languages 槽按当前语言供给。

## 声明了什么（逐类）

### mono 组（6 个，`category: "mono"`）

等宽字体，决定代码/bash/diff/行内 code 的渲染字形，merge 时**整体替换** `font.family.mono`：

- `jetbrains`：`"JetBrains Mono", "SF Mono", "Menlo", monospace`（默认推荐，开发者常装）
- `fira`：`"Fira Code", "JetBrains Mono", monospace`
- `cascadia`：`"Cascadia Code", "Cascadia Mono", monospace`
- `sfmono`：`"SF Mono", "Menlo", monospace`
- `menlo`：`"Menlo", "Consolas", monospace`
- `system-mono`：`ui-monospace, "SF Mono", monospace`（走系统 UI 等宽）

每条 stack 都是「首选 + 回退 + generic」的合法 CSS `font-family` 值，零打包——第一步走系统已装字体，缺失才逐级回落。

### english 组（6 个，`category: "english"`）

英文段，拼进 `font.family.sans` 的**开头**，决定拉丁字符的字形：

- `system`：`-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui`（系统无衬线，默认）
- `georgia`：`Georgia, "Times New Roman"`
- `times`：`"Times New Roman", Times`
- `palatino`：`Palatino, "Palatino Linotype", "Book Antiqua"`
- `garamond`：`Garamond, "EB Garamond", "Times New Roman"`
- `comic-sans`：`"Comic Sans MS", "Comic Sans"`

注意 english 组**不声明 `generic`**——契约注释明确：english 永不落栈尾，`generic` 只被「实际显示中文的那款字体」消费。

### chinese 组（5 个，`category: "chinese"`）

中文段，拼进 `font.family.sans` 的**结尾**，决定汉字字形与 generic 回落方向：

- `heiti`：`"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC"`，`generic: "sans-serif"`（黑体，默认）
- `songti`：`"Songti SC", "STSong", "SimSun", "Noto Serif CJK SC"`，`generic: "serif"`
- `kaiti`：`"Kaiti SC", "STKaiti", "KaiTi", "Noto Serif CJK SC"`，`generic: "serif"`
- `xingkai`：`"Xingkai SC", "STXingkai", "Noto Serif CJK SC"`，`generic: "serif"`
- `fangsong`：`"FangSong", "STFangsong", "Noto Serif CJK SC"`，`generic: "serif"`

`generic` 是 `"serif" | "sans-serif"` 二选一：黑体无衬线，宋/楷/行楷/仿宋都是衬线。它决定 sans 栈末尾的最终回落方向——中文段是栈尾，`generic` 就是整条栈的兜底。

## 经 merge 管线如何生效

本插件不直接产出 `Theme`，它的贡献以**注册表**形态注入 merge：

1. **加载器注册**：`registry.ts` 把 `contributes.fontPresets` 逐条 push 进 `ArraySlot<FontPresetContribution>`（数组槽，按 `id` 覆盖语义、后注册高优先级 source 胜出）。查询面 `fontPresetsRegistry()` 把数组**按 id 扁平聚合成 `Record<string, FontPresetContribution>`**——这就是 merge 消费的形态。
2. **`IPC.fonts.list`**：`appearance.ts` 暴露给 theme-manager 字体 tab 的查询（`registry.fontPresetsItems()`），返回带 `category` 的原数组，theme-manager 按三组分组渲染按钮。
3. **`applyFontChoice`**：用户选择的 `fontMonoChoice` / `fontEnglishChoice` / `fontChineseChoice` 是**字体选项的 id**（存在 `useUiStore`，即用户偏好）。merge 拿这些 id 去 `fontPresets` 注册表查栈：
   - mono：`fontPresets[monoChoice]` 命中则 `font.family.mono = stack`（**整体替换**）；查不到（偏好里存了已卸载插件贡献的 id）保留主题默认。
   - sans：`english.stack` + `chinese.stack` + `chinese.generic` 三段逗号拼接；任一段查不到就回退各自的硬编码兜底栈（英文 `-apple-system, ...`、中文 `"PingFang SC", ...`、generic `sans-serif`），保证偏好无效时也产出合法 `font-family`。
4. **注入**：`applyFontChoice` 的结果随 `buildCurrentTheme` 产出，由 `injectThemeCssVars` 写成 `--font-family-mono` / `--font-family-sans` CSS 变量，组件消费 `var(--font-family-mono)` 即生效。

关键点：**拼接是构造、回落是执行**。merge 只负责把三段字符串拼成一条合法 `font-family`（构造在内层）；「某字符先取英文字形、无则落中文字形、再无则 generic」的逐字符回退交给 CSS 引擎执行（执行在外层）。merge 不 import 任何字体数据，数据由外层注册表注入（依赖倒置）。

## 与其它插件的交互

- **与 theme-manager（字体 tab）**：theme-manager 的 `font-tab.tsx` 经 `ctx.fonts.list()` 查槽、按 `category` 分组渲染按钮，按钮文案 `t(p.labelKey)` 走 i18n；选中状态回写 `useUiStore` 的 `fontScale` / `fontMonoChoice` / `fontEnglishChoice` / `fontChineseChoice`。它不静态 import 本插件——新增字体选项自动可见。
- **与 i18n**：这是本插件与 theme 系列最大的不同——**theme 的 token 值不进 i18n（颜色不翻译），本插件的 `labelKey` 走 i18n**。17 个 label 的文案由本插件自己的 languages 槽供给，「黑体（默认）」在中文/德文/英文环境各显示不同。labelKey 是契约、值在语言文件，与「token key 是契约、值在主题插件」同构。
- **与 theme 系列（base 继承无关）**：字体栈与 theme 的 base 继承是两条独立路径。`resolveTheme` 产出 `font.family.*` 后，`applyFontChoice` 在**合并后注入层**覆盖——用户选字体优先于主题声明的字族。theme-terminal 会把 `font.family.sans` 也声明成 mono 栈（终端气质），但只要用户在字体 tab 选了非 mono 英文段，merge 会用三段拼接覆盖掉它。
- **与第三方插件（无特权差异）**：任何第三方插件贡献 `fontPresets` 槽条目，走同一注册表、同一 `applyFontChoice`、同一 `ctx.fonts.list()` 渲染，`id` 冲突按 source 优先级覆盖。本插件 `protected` 只防卸载，不防被更高优先级同 id 覆盖。

## QA

**Q：为什么字体栈要外推成插件，而不是写死在圆心或 merge？**

字体栈是会变的内容——新装一个字体、想加一个「等宽 + 衬线」组合，都是内容变更。写死在 merge 或圆心意味着每次加字体都动壳/圆心。外推成 `fontPresets` 槽后，新增 = 改插件 JSON 一行，merge 只按 id 查栈、theme-manager 只按 category 渲染，机制零改动。这正是「机制与内容分离」的字体版。

**Q：english 组为什么不声明 `generic`？**

`generic` 是「sans 栈末尾的回落方向」，只有落在栈尾的那段才需要它。english 永远拼在开头（决定拉丁字符），中文段拼在结尾才是栈尾，所以 generic 跟随「实际显示中文的那款字体」——黑体 sans-serif、宋体 serif。english 声明 generic 是无意义的死字段。

**Q：用户偏好里存了一个已卸载插件的字体 id 会怎样？**

`applyFontChoice` 查不到该 id 时**不抛错**：mono 保留主题默认栈；sans 的英文段/中文段各自回退硬编码兜底栈、generic 回退 `sans-serif`。三档兜底保证偏好无效时仍渲染出合法 `font-family`，界面不崩、字形回落系统默认。这是「偏好是弱引用、字体栈是强兜底」的语义。

**Q：为什么 labelKey 走 i18n，但 font stack 字符串不翻译？**

stack 是 CSS `font-family` 值，字体名（"JetBrains Mono"、"PingFang SC"）是跨语言不变的标识符，翻译了反而失效。要本地化的是「展示名」——「黑体（默认）」这个用户可见文案随语言变。所以两者拆开：`labelKey` 进 languages 槽，`stack` 留在 manifest 字面量。

**Q：等宽字体为什么是「整体替换」而 sans 是「三段拼接」？**

mono 只渲染一类文本（代码/bash/diff），一个选择就该决定整条栈，替换最干净。sans 是「正文 UI」，同时要照顾拉丁字符、汉字、以及无匹配字形时的 generic 回落，是三类字形来源的组合，所以拆成英文段 + 中文段 + generic 拼接。语义不同，拼接策略就不同——merge 里 `font.family.mono` 一行赋值、`font.family.sans` 三段 join 正是这个差异的镜像。
