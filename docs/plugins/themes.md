# 主题插件

## 1 这个插件解决什么问题

pi-desktop 需要支持多套配色方案——今天暗色明天亮色，今天 Catppuccin 明天 shadcn。没有主题插件，配色硬编码在内核里，改颜色要动内核、要发版。主题插件把所有配色方案贡献成外挂的 token 声明——改配色只改插件 JSON，内核一行不动。

七个主题插件共存，每个贡献一组 token 声明，无 renderer 组件。这是"机制与内容分离"的极致落地——内容（配色）完全是声明式的，内核只提供合并和应用机制。

## 2 设计决策

### 2.1 为什么是插件而不是内核

配色是内容——会变、会加新主题、会调 token 值。按 DESIGN.md §2 判据，"一年后会不会换"——会换，推出去。内核只管"能合并主题 token 并应用为 CSS 变量"这个机制（`theme/merge.ts`），配色方案是内容，推给主题插件。

### 2.2 选了什么机制

七个插件全部贡献 `themes` 槽位，声明 `tokenSchemaVersion: "^1.0"`，token 定义在 `contributes.themes[].tokens` 里。零 renderer——主题插件不写 React 组件，只有 `plugin.json`。内核读 token 定义、合并（`resolveTheme` 递归 base + 自身覆盖）、应用为 CSS 变量。

### 2.3 和框架的分工

框架管：发现主题插件、读 token 声明、合并、应用为 CSS 变量。合并分三层调用：`resolveTheme(themeId, registry)` 递归解析单个主题的 token（base 继承 + 环检测）→ `buildTheme(themeId, registry)` 包一层失败回退 → `buildCurrentTheme(themeId, registry, fontScale, fontMonoChoice, fontSansTone)` 是最终入口，在 `buildTheme` 结果上叠加字号倍率和字体选择，输出最终 Theme（`Record<string, string>`，token key → CSS 值）。`fontMonoChoice` 和 `fontSansTone` 是用户的字体偏好（从 `useUiStore` 拿），不是主题插件贡献的 token。

主题插件管：声明 token key-value。插件不写代码，内核不认识具体主题。

## 3 怎么通信

### 3.1 和内核通信

主题插件不主动通信——纯声明式。内核在启动时扫描所有插件的 `contributes.themes`，写入注册表。用户在 theme-manager 设置页切主题时，内核调 `buildCurrentTheme(themeId, registry, fontScale, fontMonoChoice, fontSansTone)` 合并出最终 token，写 CSS 变量。主题插件在这个过程中不执行任何代码。

### 3.2 和其他插件通信

间接通信。所有插件通过 CSS 变量消费主题 token——`var(--color-primary)`、`var(--spacing-md)` 等。主题切换时 CSS 变量更新，所有消费它的组件自动重渲染。插件不需要知道当前是哪个主题，只需要用 `var(--xxx)` 引用 token key。

## 4 怎么处理

### 4.1 七个插件一览

| 插件 | 主题 ID | 风格 | base |
|------|---------|------|------|
| `theme` | `dark` / `light` / `auto` | 内置默认 | `auto` → 动态检测系统明暗 |
| `theme-chatgpt` | `chatgpt-dark` | ChatGPT 风格 | `dark` |
| `theme-midnight` | `midnight-dark` | 深沉暗色 | - |
| `theme-mocha` | `mocha-dark` | Catppuccin 配色 | - |
| `theme-new-york` | `new-york-dark` / `new-york-light` | shadcn/ui 风格 | - |
| `theme-stone` | `stone-dark` / `stone-light` | 暖色中性 | - |
| `theme-terminal` | `terminal-dark` | 终端风格（零圆角、等宽、绿字） | - |

### 4.2 token 体系

token key 是稳定契约（`color.primary`、`font.size.base`、`spacing.md` 等），token 值是会变的内容（`#89b4fa`、`14px`、`16px`）。内核的 `resolveTheme` 合并时：`THEME_TOKEN_DEFAULTS`（圆心默认值）→ base 主题的 token → 自身 token，后写的覆盖先写的。

### 4.3 主题继承

`base` 字段实现主题继承。`theme-chatgpt` 的 `chatgpt-dark` 声明 `base: "dark"`，合并时先取内置 dark 的全部 token，再用 `theme-chatgpt` 自己的 `tokens` 覆盖。继承是递归的——base 可以再 base。`resolveTheme` 带环检测（`seen` Set），碰到循环继承抛错。

内核怎么知道 `base: "dark"` 指向哪个主题？通过全局 theme registry——所有主题插件贡献的 `themes` 都写入同一个注册表（按 theme id 索引）。`resolveTheme("chatgpt-dark", registry)` 查到 `chatgpt-dark` 的 base 是 `"dark"`，再去同一个 registry 里查 `"dark"` 的 token。如果用户目录下有一个同名 `dark` 主题覆盖了内置的，`resolveTheme` 查到的是高优先级的那个——base 继承也受优先级影响。

`theme` 插件的 `auto` 主题用 `base: "__auto__"`——特殊值，当前简化为固定回退 `dark`，后续接系统明暗检测。

### 4.4 派生 token

`border.color`、`font.size.*` 在 `resolveTheme` 里被剥离——插件显式赋值一律忽略。`border.color` 由 `color.border` 派生，字号只能来自圆心默认值 × `fontScale`。这是为了防止插件搞乱设计系统的派生关系——派生关系是机制（内核管），不是内容（插件管）。

## 5 怎么保证

### 5.1 环检测

`resolveTheme` 的 `seen` Set 记录已解析链路。如果主题 A base B、B base A，`resolveTheme` 碰到已见过的 themeId 抛 `Error("循环继承")`。正常使用不会出现环，但恶意或错误配置的插件可能制造环——防御性设计。

### 5.2 失败回退

`buildTheme` 调 `resolveTheme`，失败时回退 `THEME_TOKEN_DEFAULTS`（圆心默认值）。解析失败不能让界面没有配色——这是"根因修复"的落地：不是"配色错了"这个表象，是"`resolveTheme` 抛错了"这个根因，处理方式是回退到安全默认值。

### 5.3 零代码 = 零 bug

主题插件没有 renderer 组件、没有 TypeScript 代码、没有运行时逻辑。纯 JSON 声明——JSON 解析失败内核跳过该插件，不影响其他主题加载。这是"无特权差异"的落地：一个坏主题插件不拖垮整个主题系统。

## 6 QA

**Q：怎么加一个新主题？**

在 `src/plugins/` 下创建目录，放一个 `plugin.json`，声明 `tokenSchemaVersion` + `contributes.themes`。不需要 `renderer` 字段、不需要写任何代码。内核自动发现、合并、应用。第三方主题插件放到 `~/.pi-desktop/plugins/` 即可，和内置主题平等。

**Q：两个主题插件声明了同一个 theme id 怎么办？**

按优先级覆盖。高优先级插件（project > user > installed > builtin）的同名主题覆盖低优先级的。内置 `theme` 插件的 `dark` 主题可以被用户目录下的同名主题覆盖——内核不"识别内置的所以不让覆盖"。

**Q：派生 token 为什么不让插件赋值？**

因为派生关系是设计系统的约束，不是单个主题的选择。`border.color` 必须由 `color.border` 派生——如果某个主题可以随意设 `border.color`，就会和 `color.border` 不一致，导致边框颜色和其他 UI 元素不协调。字号同理——`font.size.base` 只能由圆心默认值 × `fontScale` 得到，不能由主题插件随意设。这是"机制与内容分离"的落地：派生关系是机制（内核管），token 值是内容（插件管）。

**Q：`__auto__` 主题什么时候做系统检测？**

当前是已知缺口——简化为固定回退 `dark`。实现需要 shell 层检测系统暗色/亮色偏好（macOS `defaults read -g AppleInterfaceStyle`，Windows 注册表，Linux DBus），然后选择对应 base。标注"演进"。
