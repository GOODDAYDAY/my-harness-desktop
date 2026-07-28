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

## 3 怎么通信

### 3.1 和内核通信

这个插件同时操作两个配置源——这是它的特殊之处：

- **桌面偏好**（走 `useUiStore`）：`currentThemeId`、`fontScale`、`fontMonoChoice`、`fontSansTone`。这些是全局偏好，存到 electron-store（`~/.pi-desktop/config/config.json`），经 `useUiStore` 读写。切换主题、调字号在这里做。不走 `config`/`onChange` prop——因为这些是全局状态，不是插件私有的。

- **插件自己的配置**（走 `usePiApi().config`）：`showFontPreview` 开关。这是 theme-manager 自己的 UI 偏好，存到 `~/.pi-desktop/plugins-data/theme-manager/config.json`。调 `pi.config.get("theme-manager", "showFontPreview")` / `pi.config.set("theme-manager", "showFontPreview", on)`。

为什么分两套？因为主题选择是全局状态——所有插件都消费主题 token，切主题要全局广播。`showFontPreview` 是 theme-manager 自己的 UI 偏好——不影响别的插件。

### 3.2 和其他插件通信

通过 `useUiStore` 广播：`setCurrentThemeId` / `setFontScale` / `setFontMonoChoice` / `setFontSansTone` → shell 层的 `theme-context.tsx` 订阅这些变化 → 调 `pi.themes.build(themeId, fontScale, fontMono, fontSans)` 合并出最终 token → 写 CSS 变量 → 所有消费主题 token 的组件自动重渲染。

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

## 6 QA

**Q：为什么主题切换不弹保存浮层？**

因为主题切换走 `useUiStore`（全局偏好），不走框架的 configFile 管理机制。`configFile` 只管 `showFontPreview` 开关——那个才弹 dirty 浮层。主题切换是即时生效的探索性操作，不需要确认。

**Q：MONO_CHOICES 和 SANS_TONES 从哪来？**

从 `@pi-desktop/react` 导入。这些是字体预设常量——等宽字体选项（JetBrains Mono、SF Mono、Menlo 等）和正文调性选项（Sans、Serif、Mono、Rounded）。application 层的 `merge.ts` 有一份逐字一致的副本——这是已知技术债（违反契约单源），因为 application 不能 import packages/react（依赖方向）。标注"演进"。

**Q：第三方插件能加自己的主题吗？**

能。第三方插件贡献 `contributes.themes` 即可。theme-manager 调 `pi.themes.list()` 会自动收录所有主题插件贡献的主题。用户在设置页看到的不分内置和第三方——无特权差异。
