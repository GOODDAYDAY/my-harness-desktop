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

### 2.4 是否修改了内核

没有。七个主题插件全部只包含一个 `plugin.json` 文件——零 TypeScript，零 renderer，零 import。它们唯一做的事是在 `contributes.themes` 里声明 token key-value。不 import `@pi-desktop/react`、不 import `@pi-desktop/core`、不 import 任何 `src/` 目录下的文件。

删掉所有七个主题插件目录（`src/plugins/theme/`、`src/plugins/theme-chatgpt/`、`src/plugins/theme-midnight/`、`src/plugins/theme-mocha/`、`src/plugins/theme-new-york/`、`src/plugins/theme-stone/`、`src/plugins/theme-terminal/`），内核一行不动。主题合并器（`theme/merge.ts` 的 `resolveTheme` → `buildTheme` → `buildCurrentTheme`）仍然工作——只是 theme registry 里只有 `THEME_TOKEN_DEFAULTS`（圆心默认值），`pi.themes.list()` 返回空数组或只有 `dark`/`light`/`auto`（如果内置 `theme` 插件还在）。内核的加载器、主题注册表、合并机制、CSS 变量应用机制全都不受影响。JSON 声明式插件的优雅之处就在这里——删掉的只是数据，不是代码。

内置 `theme` 插件提供 `dark`、`light`、`auto` 三个基础主题。它是 builtin，优先级最低——可以被用户目录下的同名主题覆盖。内核不识别"这是内置的所以不让覆盖"——任何插件的 `contributes.themes` 声明了同一个 theme id，按优先级覆盖即可。
### 2.5 使用了内核的什么功能

七个主题插件是纯声明式插件——不写代码，不调 API。它们使用的内核能力全部通过声明式契约（`plugin.json` 的 `contributes.themes`）间接触发。每一项底层走什么、内核提供什么保障逐条列出：

- **`contributes.themes` 槽位**：主题插件的唯一接入点。`plugin.json` 中声明 `tokenSchemaVersion`（`"^1.0"`，semver 范围）和 `themes[]` 数组（每个包含 `id`、`name`、`tokens`、可选 `base`）。内核的插件发现器扫描到 `contributes.themes` 后：
  1. 校验 `tokenSchemaVersion` 是否匹配——不匹配的跳过并记日志。
  2. 将每个 theme 声明写入全局 theme registry（按 theme id 索引），记录来源插件和优先级。
  3. 当 `buildCurrentTheme` 被调用时（由 theme-manager 的 `setCurrentThemeId` 触发），从 registry 查对应 theme 的 token 定义 → `resolveTheme` 递归合并（base 继承 + `THEME_TOKEN_DEFAULTS` 兜底）→ 输出最终 `Record<string, string>` → 写 CSS 变量。
  内核保障：registry 是全局单例——所有主题插件的贡献写入同一个 Map；重复的 theme id 按优先级覆盖（project > user > installed > builtin），同级先注册者胜；继承链路可递归，带环检测；`border.color` 和 `font.size.*` 等派生 token 被内核剥离（插件显式赋值一律忽略），防止插件破坏设计系统的派生关系。
- **`THEME_TOKEN_DEFAULTS`（圆心默认值）**：定义在 `domain/slots/theme-tokens.ts` 的默认 token 值。主题插件的 token 声明覆盖这些默认值——未声明的 token 保留默认值。内核保障：这是最后的安全网——没有任何主题插件时，系统用这些默认值渲染界面，不会白屏。
- **CSS 变量应用机制**（shell 层 `theme-context.tsx`）：主题插件不感知这一步——它只声明 token key-value。内核的 `theme-context.tsx` 在 `buildCurrentTheme` 返回最终 Theme 后，遍历所有 token key → 写 `document.documentElement.style.setProperty('--' + key.replace(/\./g, '-'), value)`。所有 DOM 节点自动继承这些 CSS 变量。内核保障：CSS 变量覆盖是幂等的——多次调用同一个 key 不会残留旧值；删除一个主题插件后，系统切到另一个主题时旧主题的 CSS 变量被彻底替换，不会残留。
- **零权限要求**：主题插件不需要声明任何 `permissions`。`contributes.themes` 是纯声明式贡献——不涉及文件系统、网络、进程、IPC。内核不需要在权限沙箱里检查主题插件——它根本不执行任何代码。
## 3 怎么通信

### 3.1 和内核通信

主题插件不主动通信——纯声明式。内核在启动时扫描所有插件的 `contributes.themes`，写入注册表。用户在 theme-manager 设置页切主题时，内核调 `buildCurrentTheme(themeId, registry, fontScale, fontMonoChoice, fontSansTone)` 合并出最终 token，写 CSS 变量。主题插件在这个过程中不执行任何代码。

### 3.2 和其他插件通信

间接通信。所有插件通过 CSS 变量消费主题 token——`var(--color-primary)`、`var(--spacing-md)` 等。主题切换时 CSS 变量更新，所有消费它的组件自动重渲染。插件不需要知道当前是哪个主题，只需要用 `var(--xxx)` 引用 token key。

### 3.3 其他插件怎么使用自己

主题插件不和其他插件直接通信——它们没有代码，不能发事件、不能调 API。所有插件通过 CSS 变量的方式间接消费主题插件的输出。这是"插件之间不直接通信，通过共享状态间接通信"在视觉层的极致表达。

**所有插件通过 CSS 变量消费主题 token**：每个插件的 React 组件在 `style` prop 和 CSS 中引用 `var(--color-bg)`、`var(--color-fg)`、`var(--color-primary)`、`var(--spacing-md)`、`var(--font-family-mono)`、`var(--radius-md)`、`var(--shadow-md)` 等 CSS 变量。这些变量的值来源于主题插件的 token 声明——但不是直接来源，而是经过内核合并器（`resolveTheme` → `buildTheme` → `buildCurrentTheme`）处理后的结果。插件不引用"dark 主题的 `color.bg`"——它们引用 `var(--color-bg)`，内核保证这个变量在所有主题下都有值。

受影响的插件：**全部，无一例外**。这是视觉基础设施——不是"某些插件受影响"，是"整个应用的外观由主题 token 决定"。sessions-list 的列表背景走 `var(--color-bg)`，选中的会话项走 `var(--color-list-selected-bg)`；timeline 的消息气泡走 `var(--color-surface)`，代码块走 `var(--font-family-mono)` 和 `var(--color-surface)`；pi-manager 的表格走 `var(--color-border)` 和 `var(--radius-sm)`；pi-model-manager 的右键菜单阴影走 `var(--shadow-md)`，供应商列表间距走 `var(--spacing-sm)`。每个插件的视觉一致性由主题插件通过 CSS 变量保障——不需要代码协调。

**theme-manager 通过 `pi.themes.list()` 消费主题列表**：theme-manager 调 `pi.themes.list()` 拿所有已注册主题的列表（`{ id, name }[]`），渲染主题选择网格。这个列表的每一项来自一个主题插件的 `contributes.themes` 声明。theme-manager 不区分内置（`dark`、`light`）和第三方（`chatgpt-dark`、`mocha-dark`）。

**主题插件的 `name` 字段走 i18n**：主题插件的 `"name": "theme.dark"` 是一个 i18n key。i18n 插件的 `theme` 命名空间提供翻译（`"theme.dark": "暗色"` / `"Dark"`）。用户看到的主题名（"暗色"、"Dark"等）来自 i18n 插件，不是主题插件自己的硬编码——主题插件只声明 key，i18n 插件提供值。这是两个插件通过共享 key 间接协作的范例。

**主题继承的跨插件协作**：`theme-chatgpt` 声明 `base: "dark"`——它的 token 基于 `theme` 插件的 `dark` 主题。合并时内核从同一个 registry 查 `dark` 的 token（可能来自 `theme` 插件，也可能被用户目录下的同名主题覆盖）→ 再叠加 `theme-chatgpt` 自己的 token。这不需要 `theme-chatgpt` 插件 import `theme` 插件——它只声明了一个 base id，内核在运行时解析。两个主题插件完全解耦，可以独立演化、独立替换。
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

## 6 如果没有这个插件，整个系统会有什么影响

删掉所有七个主题插件目录后，系统仍然能正常启动——内核加载器发现不到这些插件，跳过加载。theme registry 为空（或只有其他插件贡献的主题），所有机制完好：`resolveTheme`、`buildTheme`、`buildCurrentTheme`、CSS 变量应用全部正常工作。内核不崩溃。但用户失去了以下东西：

**失去的配色方案**：七个主题插件贡献的十一个配色方案（`dark`、`light`、`auto`、`chatgpt-dark`、`midnight-dark`、`mocha-dark`、`new-york-dark`、`new-york-light`、`stone-dark`、`stone-light`、`terminal-dark`）全部消失。`pi.themes.list()` 返回空数组（如果没有其他主题插件）。theme-manager 的主题选择网格为空——用户无法选择任何主题。

**系统回退到什么状态**：当 `buildCurrentTheme` 被调用时，`resolveTheme` 在 registry 里找不到对应 theme id → 回退 `THEME_TOKEN_DEFAULTS`（圆心默认值）。这个默认值是一组最基础的 token——有背景色、前景色、边框色、间距、字号、阴影等，但只有一套：没有暗/亮之分，没有个性化配色。界面仍然可读、仍然可用，但视觉效果是最基础的——灰色背景、黑色文字、蓝色主色调、标准间距。这类似一个"无主题"状态。

**对其他插件的影响**：视觉上界面变基础但功能完全正常。所有插件照常加载、渲染、交互——CSS 变量仍然有值（来自 `THEME_TOKEN_DEFAULTS`），只是值单调。用户失去了通过切换主题改变视觉风格的能力——没有 Catppuccin、没有 shadcn、没有终端风格。字号和字体偏好（来自 theme-manager 的 `fontScale` / `fontMonoChoice` / `fontSansTone`）仍然生效——这些不依赖主题插件，是内核合并器在 `buildCurrentTheme` 阶段叠加的。

**`auto` 主题的影响**：失去 `auto` 主题意味着失去系统明暗自动检测的入口。虽然当前 `auto` 简化为固定回退 `dark`（标注"演进"），但它是一个能力点位——删掉后这个能力点位消失，后续即使内核实现了系统检测也没有对应的主题声明来承接。

**第三方能否替代**：完全可以，而且这是主题插件设计的目的——第三方主题插件和内置主题插件完全平等。第三方插件只需一个 `plugin.json`，声明 `tokenSchemaVersion` + `contributes.themes`，放到 `~/.pi-desktop/plugins/` 即可。内核自动发现、注册、合并、应用。由于内置 `theme` 插件是 builtin（优先级最低），用户目录下的同名 `dark` 主题直接覆盖内置的——用户不需要"禁用"内置主题，只需要装一个第三方同名主题。主题生态的扩展方式就是不断有第三方贡献新的 `plugin.json`——零代码、零门槛、零特权差异。

## 7 QA

**Q：怎么加一个新主题？**

在 `src/plugins/` 下创建目录，放一个 `plugin.json`，声明 `tokenSchemaVersion` + `contributes.themes`。不需要 `renderer` 字段、不需要写任何代码。内核自动发现、合并、应用。第三方主题插件放到 `~/.pi-desktop/plugins/` 即可，和内置主题平等。

**Q：两个主题插件声明了同一个 theme id 怎么办？**

按优先级覆盖。高优先级插件（project > user > installed > builtin）的同名主题覆盖低优先级的。内置 `theme` 插件的 `dark` 主题可以被用户目录下的同名主题覆盖——内核不"识别内置的所以不让覆盖"。

**Q：派生 token 为什么不让插件赋值？**

因为派生关系是设计系统的约束，不是单个主题的选择。`border.color` 必须由 `color.border` 派生——如果某个主题可以随意设 `border.color`，就会和 `color.border` 不一致，导致边框颜色和其他 UI 元素不协调。字号同理——`font.size.base` 只能由圆心默认值 × `fontScale` 得到，不能由主题插件随意设。这是"机制与内容分离"的落地：派生关系是机制（内核管），token 值是内容（插件管）。

**Q：`__auto__` 主题什么时候做系统检测？**

当前是已知缺口——简化为固定回退 `dark`。实现需要 shell 层检测系统暗色/亮色偏好（macOS `defaults read -g AppleInterfaceStyle`，Windows 注册表，Linux DBus），然后选择对应 base。标注"演进"。
