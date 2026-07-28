# theme-manager

## 1 这个插件解决什么问题

用户需要切换主题、调字号、选字体。没有这个插件，用户得手动编辑配置文件。theme-manager 把主题选择和字体偏好放到设置页——选主题、拖字号、选等宽/正文字体，实时预览。

## 2 设计决策

### 2.1 为什么是插件而不是内核

主题选择和字体偏好的 UI 会变——网格布局会调、预览卡片会改。但"能合并主题 token"这个能力不会变（内核的 `theme/merge.ts`）。UI 是内容，推给插件；合并能力留内核。

### 2.2 选了什么机制

贡献 `settings` 槽位，`order: 10`。声明 `configFile: "~/.pi-desktop/config/config.json"` + `saveMode: "manual"`——注意是 `saveMode` 不是 `configMerge`，因为 theme-manager 只存一个 `showFontPreview` 开关，主题和字体偏好走另一条路。零权限。

### 2.3 和框架的分工

框架管：组件注册、configFile 生命周期（`showFontPreview` 的 dirty/save/reset）、`SettingsSection` 样式。插件管：主题网格渲染、字号滑块、字体选择、预览卡片（`theme-preview.tsx`）。

### 2.4 是否修改了内核

没有。theme-manager 插件只从 `@pi-desktop/react` 导入受控 API——`useUiStore`、`usePiApi`、`registerSettingsComponent`、`SettingsSection`、`SettingsComponentProps`、`MONO_CHOICES`、`SANS_TONES`，外加 `react-i18next` 的 `useTranslation`。不 import `@pi-desktop/core`，不 import `src/domain/`、`src/gateway/`、`src/application/`、`src/shell/` 的任何文件。插件的全部代码在 `renderer/index.tsx`（155 行）和 `renderer/theme-preview.tsx`——全部是 React UI 逻辑和主题预览渲染，零内核代码侵入。

删掉 `src/plugins/theme-manager/` 目录，内核一行不动。设置页的"主题" tab（`order: 10`）消失，但设置页槽位完好——其他 tab 正常渲染。内核的主题合并机制（`theme/merge.ts` 的 `resolveTheme` → `buildTheme` → `buildCurrentTheme`）仍然存在、仍然工作——只是没有 UI 来触发 `setCurrentThemeId` 了。其他插件仍然可以通过直接修改 `useUiStore` 的值来切换主题（如果它们有 UI 的话）。内核的加载器、主题合并器、CSS 变量应用机制全都不受影响。
### 2.5 使用了内核的什么功能

theme-manager 插件使用内核提供的以下能力，每一项底层走什么、内核提供什么保障逐条列出：

- **`contributes.settings` 槽位**：`order: 10`，`component: "ThemeSettings"` 指向 renderer 导出的 React 组件，`configFile: "~/.pi-desktop/config/config.json"` + `saveMode: "manual"`。注意 `saveMode: "manual"` 意味着框架不会自动追踪 dirty 和弹出保存浮层——插件的 `showFontPreview` 开关走 `pi.config.get/set` 自己管保存逻辑（见下文），不走框架的 configFile 机制。`configFile` 声明在这里主要是占位——如果后续 theme-manager 有更多自己的配置项，可以用框架的 dirty/save 管理。
- **`useUiStore`（经 `@pi-desktop/react`）**：读 `currentThemeId`、`fontScale`、`fontMonoChoice`、`fontSansTone`，写 `setCurrentThemeId`、`setFontScale`、`setFontMonoChoice`、`setFontSansTone`。底层走 electron-store（`~/.pi-desktop/config/config.json`），内核在 shell 层的 `theme-context.tsx` 订阅这些字段的变化 → 调 `pi.themes.build(themeId, fontScale, fontMono, fontSans)` 合并出最终 Theme（`Record<string, string>`，token key → CSS 值）→ 写到 `document.documentElement.style`（CSS 变量）。内核保障：electron-store 的读写带文件级原子性；`pi.themes.build` 的合并链路三层（`resolveTheme` 递归解析 token → `buildTheme` 包失败回退 → `buildCurrentTheme` 叠加字号和字体偏好）；CSS 变量写 `:root`，所有 DOM 节点自动继承。
- **`usePiApi()`（经 `@pi-desktop/react`）**：拿原始 `window.pi` 对象。插件用它调 `pi.themes.list()` 和 `pi.config.get/set`。
  - `pi.themes.list()`：拿所有已注册主题的列表（`{ id, name }[]`）。底层走 main 进程 IPC → 查主题注册表（application 层的 theme registry，启动时扫描所有插件的 `contributes.themes` 写入）。内核保障：返回的列表已去重、已按优先级排序；内置主题（`dark`、`light`、`auto`）和第三方主题平等——都从同一个注册表出。
  - `pi.config.get("theme-manager", "showFontPreview")` / `pi.config.set("theme-manager", "showFontPreview", on)`：读写 theme-manager 自己的插件配置（存到 `~/.pi-desktop/plugins-data/theme-manager/config.json`）。底层走 main 进程 IPC → `config-store.ts`（application 层）→ `readJsonFile` / `writeJsonFile`（带 `withDirLock` 串行化）。内核保障：插件配置按 pluginId 隔离——theme-manager 的配置不会和 pi-manager 的配置冲突；`config.set` 失败时抛异常，不静默吞错（所以插件有 `try/catch` 做回滚）。
- **`MONO_CHOICES` / `SANS_TONES`（经 `@pi-desktop/react`）**：等宽字体选项和正文调性选项的常量数组。这是内核提供的字体预设——不是插件定义的，是内核定义的。注意：application 层的 `theme/merge.ts` 有一份逐字一致的副本——这是已知技术债（违反契约单源），因为 application 不能 import `packages/react`（依赖方向）。标注"演进"。
- **框架组件**：`SettingsSection`（只边框无填色）。在 `@pi-desktop/react` 发布面。
- **`useTranslation`（react-i18next）**：插件自己的所有用户可见文字走 `t("key")`。
- **`refreshSignal` prop**：框架刷新按钮点击时 `refreshSignal` +1，插件的 `useEffect` 依赖它重拉主题列表和自己的 `showFontPreview` 配置。
## 3 怎么通信

### 3.1 和内核通信

这个插件同时操作两个配置源——这是它的特殊之处：

- **桌面偏好**（走 `useUiStore`）：`currentThemeId`、`fontScale`、`fontMonoChoice`、`fontSansTone`。这些是全局偏好，存到 electron-store（`~/.pi-desktop/config/config.json`），经 `useUiStore` 读写。切换主题、调字号在这里做。不走 `config`/`onChange` prop——因为这些是全局状态，不是插件私有的。

- **插件自己的配置**（走 `usePiApi().config`）：`showFontPreview` 开关。这是 theme-manager 自己的 UI 偏好，存到 `~/.pi-desktop/plugins-data/theme-manager/config.json`。调 `pi.config.get("theme-manager", "showFontPreview")` / `pi.config.set("theme-manager", "showFontPreview", on)`。

为什么分两套？因为主题选择是全局状态——所有插件都消费主题 token，切主题要全局广播。`showFontPreview` 是 theme-manager 自己的 UI 偏好——不影响别的插件。

### 3.2 和其他插件通信

通过 `useUiStore` 广播：`setCurrentThemeId` / `setFontScale` / `setFontMonoChoice` / `setFontSansTone` → shell 层的 `theme-context.tsx` 订阅这些变化 → 调 `pi.themes.build(themeId, fontScale, fontMono, fontSans)` 合并出最终 token → 写 CSS 变量 → 所有消费主题 token 的组件自动重渲染。

### 3.3 其他插件怎么使用自己

theme-manager 的输出被所有插件消费——通过 CSS 变量和 `useUiStore` 的共享状态间接协作。插件之间不直接通信，theme-manager 也没有发事件给其他插件。它是怎么影响整个系统的：

**通过 CSS 变量影响所有插件的视觉**：用户切换主题 → `setCurrentThemeId(id)` → `theme-context.tsx` 订阅到变化 → 调 `pi.themes.build(themeId, fontScale, fontMono, fontSans)` 合并出最终 token → 写 `document.documentElement.style` 上的 CSS 变量（`--color-bg`、`--color-fg`、`--color-primary`、`--spacing-md`、`--font-family-mono` 等）。所有插件的 React 组件在 `style` prop 和 CSS 中引用这些变量——CSS 变量一变，浏览器自动重绘，React 不需要重新渲染。这是最高效的全局视觉切换机制——一次 CSS 变量批量更新，所有 DOM 节点同步响应。

受影响的插件：**全部**。sessions-list 的背景色走 `var(--color-bg)`，边框走 `var(--color-border)`，列表项选中态走 `var(--color-list-selected-bg)`；timeline 的消息气泡走 `var(--color-surface)`，代码块走 `var(--font-family-mono)`；pi-manager 的字段输入框走 `var(--color-surface)` 和 `var(--color-border)`；pi-model-manager 的右键菜单走 `var(--color-surface)` 和 `var(--shadow-md)`；所有设置页的 `SettingsSection` 边框走 `var(--color-border)`。没有一个插件需要知道当前是哪个主题——它们只引用 token key。

**通过 `useUiStore` 影响字号和字体**：用户调字号 → `setFontScale(scale)` → `theme-context.tsx` 订阅到变化 → `buildCurrentTheme` 在合并结果上叠加字号倍率（`font.size.base` × `fontScale`）→ 写 CSS 变量。用户选等宽字体 → `setFontMonoChoice(id)` → `buildCurrentTheme` 在合并结果上叠加字体栈 → 写 CSS 变量。所有使用 `var(--font-size-*)` 和 `var(--font-family-mono)` 的插件自动响应。这包括代码展示（timeline、file-preview）、版本号显示（pi-manager）、模型 ID 显示（pi-model-manager）——所有等宽文本。

**通过主题列表影响设置页**：`pi.themes.list()` 返回的主题列表包含所有插件的 `contributes.themes`。theme-manager 用它渲染主题选择网格——每个主题一张预览卡片。用户看到的列表不区分内置主题（`dark`、`light`）和第三方主题（`chatgpt-dark`、`mocha-dark` 等）——无特权差异。第三方主题插件新增后，`pi.themes.list()` 自动包含新主题，theme-manager 的网格自动多一张卡片。

**不受 theme-manager 影响的插件**：没有。CSS 变量是全站生效的——没有插件能"选择不响应主题切换"。这是设计决策：统一的视觉语言要求所有插件使用同一套 token 体系。如果某个插件硬编码了颜色值（`color: "#ffffff"` 而不是 `color: var(--color-fg)`），它在暗色主题下可能看不清——但这不是 theme-manager 的问题，是那个插件不守契约。
## 4 怎么处理

### 4.1 数据流

启动时 `pi.themes.list()` 拿所有主题插件贡献的主题列表 + `pi.config.get("theme-manager", "showFontPreview")` 拿自己的配置。用户切主题 → `setCurrentThemeId(id)` → 全局广播 → CSS 变量更新。用户拖字号 → `setFontScale(scale)` → 同上。`refreshSignal` 变化时重拉主题列表。

### 4.2 主题预览

`renderer/theme-preview.tsx` 渲染可视化主题卡片——用主题的 token 值画一个缩小版预览（背景色、前景色、主色调、圆角等）。`showFontPreview` 控制是否显示字体预览。

## 5 怎么保证

### 5.1 写配置失败回滚

`toggleFontPreview` 包了 `try/catch`——`pi.config.set` 失败时 `console.error` 记录，UI 不更新（`setShowFontPreview(on)` 在 `await` 之后，只在成功时调）。不产生"UI 显示开了但配置没写"的不一致。

### 5.2 桌面偏好不参与框架 dirty

`currentThemeId` / `fontScale` 等走 `useUiStore`——不走 `config`/`onChange` prop。这意味着切主题不弹"保存/丢弃/取消"浮层——即时生效，不需要确认。这是设计决策：主题切换是探索性操作（用户试了不满意就切回去），如果每次切都要确认太烦。

## 6 如果没有这个插件，整个系统会有什么影响

删掉 `src/plugins/theme-manager/` 目录后，系统仍然能正常启动——内核加载器跳过这个插件，其他一切照常。内核不崩溃，机制全在。主题合并器（`theme/merge.ts`）、CSS 变量应用机制（`theme-context.tsx`）、electron-store 读写全部完好。但用户失去了以下东西：

**失去的 UI 入口**：设置页的"主题" tab（`order: 10`）消失。用户无法通过 UI 切换主题——没有主题选择网格、没有字号滑块、没有字体选择按钮、没有预览卡片。

**失去的功能但机制仍在**：主题切换的机制全在——`useUiStore.currentThemeId` 仍然可读写，`theme-context.tsx` 仍然订阅变化，`buildCurrentTheme` 仍然能合并 token 并写 CSS 变量。但用户没有 UI 来改变 `currentThemeId` 的值。系统会一直停留在启动时的默认主题（`currentThemeId` 的初始值，由 electron-store 里存的最后一次选择决定——如果从未改过，默认是 `dark`）。

**对其他插件的影响**：视觉上无影响——CSS 变量仍然生效，所有插件正常渲染。用户只是不能换主题了，但当前主题的所有颜色、字号、字体都正确。如果用户之前选了 `light` 主题，删掉 theme-manager 后界面保持亮色——CSS 变量不会因为插件被删而丢失，因为 CSS 变量写在了 `document.documentElement.style` 上，和插件是否存在无关。

**第三方能否替代**：完全可以。第三方插件贡献 `contributes.settings`（带 `saveMode: "manual"` 或不声明 configFile）和一个调 `useUiStore` 和 `usePiApi().themes.list()` 的 renderer 组件即可完全替代 theme-manager。由于 theme-manager 是 builtin（优先级最低），第三方插件的设置页会覆盖同名 tab。实际上，第三方可以做一个更好的主题管理 UI——比如用 `pi.themes.build(themeId)` 预生成预览（而非 theme-manager 当前的 token 值预览）、支持主题收藏、支持导入外部主题——theme-manager 作为 builtin 只提供最基础的切换能力。

**特殊注意**：`MONO_CHOICES` 和 `SANS_TONES` 常量仍然可用——它们定义在 `@pi-desktop/react` 发布面，不依赖 theme-manager 插件。第三方插件可以直接 import 它们来做字体选择 UI。这是"机制在内核、内容在插件"的又一次体现——字体预设是机制（内核定义），字体选择 UI 是内容（插件实现）。

## 7 QA

**Q：为什么主题切换不弹保存浮层？**

因为主题切换走 `useUiStore`（全局偏好），不走框架的 configFile 管理机制。`configFile` 只管 `showFontPreview` 开关——那个才弹 dirty 浮层。主题切换是即时生效的探索性操作，不需要确认。

**Q：MONO_CHOICES 和 SANS_TONES 从哪来？**

从 `@pi-desktop/react` 导入。这些是字体预设常量——等宽字体选项（JetBrains Mono、SF Mono、Menlo 等）和正文调性选项（Sans、Serif、Mono、Rounded）。application 层的 `merge.ts` 有一份逐字一致的副本——这是已知技术债（违反契约单源），因为 application 不能 import packages/react（依赖方向）。标注"演进"。

**Q：第三方插件能加自己的主题吗？**

能。第三方插件贡献 `contributes.themes` 即可。theme-manager 调 `pi.themes.list()` 会自动收录所有主题插件贡献的主题。用户在设置页看到的不分内置和第三方——无特权差异。
