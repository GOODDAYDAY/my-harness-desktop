# plugin-manager 插件技术文档

## 1 定位与总览

`plugin-manager`（插件 id 恒为字符串 `"plugin-manager"`，manifest 见 `src/plugins/manager/plugin-manager/plugin.json`）是 my-harness-desktop 壳的「插件管理器」，也是壳插件体系里唯一的**元插件**——它不贡献任何业务功能，只贡献一个 settings 槽设置页，用来查看、启用、禁用、安装、卸载、重载**其它全部壳插件**。它在 `src/plugins/` 内容层里按域分组落在 `manager/` 组，与 `pi-manager`、`dsh-manager`、`skill-manager`、`theme-manager` 等管理类插件同组（域分组只是物理目录归位，加载器对分组层不感知，见 §6.1）。

它的职责边界一句话：**只做「把壳已有的插件生命周期机制暴露成 UI」，不拥有任何生命周期逻辑本身**。启用/禁用/卸载/重载/安装的真相源全部在壳后端（`src/server/application/lifecycle/`、`src/server/application/installer/`、`src/server/controllers/plugins.ts`），本插件只负责把 `ctx.plugins.*` 的返回值渲染成列表、把用户动作翻译成一次 IPC 调用、把返回的 error token 翻译成文案。这个定位决定了它不 import `@/server/`、不碰内核、不出会话能力——它唯一的代码文件 `renderer/index.tsx`（392 行）全程只 import `react`、`react-i18next`、`@radix-ui/react-tooltip`、`lucide-react`、`@dnd-kit/*` 和 `@my-harness-desktop/react`。

- **四件套形态（§7.7 插件开发四件套）**：本插件目录下只有 `renderer/` 和 `locales/` 两件，没有 `pi-extension/`、没有 `dsh-extension/`、没有 `skills/`。它不向任何内核补能力（它管理的对象是壳插件，与内核插件是两回事，见 CLAUDE.md 术语区），所以 manifest 里没有 `piExtension`、`dshExtension` 字段，也没有 `permissions` 声明——它用的全部是核心默认能力（`plugins`、`config`、`dialog`、`i18n`），零声明权限、零事件 channel 声明。
- **它的「贡献」只有一个 settings 槽项 + 三组语言包**：`contributes.settings` 里一条 `{id:"plugins", component:"PluginManagerPage", saveMode:"manual", order:6}`；`contributes.languages` 里 12 条（3 个 namespace × 4 个 locale）。没有 themes、sidePanel、sidebar、mainView、titlebar 等任何其它槽位贡献。

## 2 契约面：它消费哪些类型与 API

本插件自身不定义任何类型，全部从 `@my-harness-desktop/react` 和圆心 `@my-harness-desktop/shared` 拿。renderer 第 13 行 import 的 `PluginListItem`、`PluginTier`、`RECOMMENDED_PLUGIN_TAGS`、`usePluginContext`、`Pagination`、`usePagination`、`Button` 是它契约面的全部入口。

### 2.1 `PluginListItem` —— 列表每行数据契约

`PluginListItem` 定义在圆心 `packages/shared/src/domain/contributions.ts:529`，是 `ctx.plugins.list()` 返回的每行数据。字段逐一对照 renderer 消费点：

- `id: string` —— 插件 id，`PluginRow` 用它当 `useSortable({id})` 的排序键、`PluginRow` 副信息行显示 `p.id`、拖拽后的 `customOrder` 数组元素也是它。
- `displayName: string` —— 展示名，`PluginRow` 第 288 行 `t(\`plugin.${p.id}.displayName\`, {defaultValue: p.displayName || p.id})` 消费：优先走 i18n，回退 manifest 原值，再回退 id。
- `description?: string` —— 描述，第 289 行同模式 `t(\`plugin.${p.id}.description\`, {defaultValue: p.description || ""})`。
- `version: string` —— 版本号，第 301 行直接渲染。
- `source: "project" | "user" | "installed" | "builtin"` —— 物理来源，第 22 行 `SOURCE_ORDER` 参与默认排序，第 311 行副信息行渲染。
- `tier: PluginTier` —— 信任级别，`TIER_ORDER`（第 21 行）参与排序，`tierColor`（第 59 行）+ `tierLabel`（第 291 行）渲染 badge。
- `state: PluginState` —— `"active" | "inactive" | "error"` 三态，决定 `PluginRow` 右侧按钮组（§5.4），`stateLabel`（第 290 行）渲染状态文案。
- `protected: boolean` —— 是否受保护（不可卸载），第 303 行渲染 Shield 图标，第 332–334 行禁用卸载按钮。
- `path: string | null`、`renderer: string | null` —— 第三方插件渲染入口（builtin 恒为 null），本插件 UI 不直接消费，但 `plugins-host` 依赖它们动态 import（§7.4）。
- `contributes?: PluginContributes` —— 贡献面，本插件不消费，`plugins-host` 用它注册组件。
- `tags: string[]` —— 最终分类 tag（`resolvePluginTags` 合成结果），第 128 行 `orderTags`、第 207 行 chip 计数、第 312 行副信息行都消费。

### 2.2 `PluginTier` / `PluginState` / `RECOMMENDED_PLUGIN_TAGS`

- `PluginTier = "official" | "verified" | "community"`（`contributions.ts:523`），renderer 第 21 行 `TIER_ORDER: Record<PluginTier, number> = {official:0, verified:1, community:2}` 定义排序权重；第 59–63 行 `tierColor` 映射三档颜色 token。
- `PluginState = "active" | "inactive" | "error"`（`contributions.ts:526`），renderer 第 290 行用 `p.state.charAt(0).toUpperCase()+p.state.slice(1)` 拼成 `pluginManager.state{Active|Inactive|Error}` 三个 i18n key（运行中/已禁用/加载失败）。
- `RECOMMENDED_PLUGIN_TAGS`（`contributions.ts:547`）是 11 个推荐 tag 的 `as const` 元组：`theme/i18n/management/session/project/git/conversation/review/dev/productivity/insight`。它是**标识符词表**，不是用户可见文案；用户可见标签走 `pluginManager.tag.<tag>` i18n key。renderer 第 53–57 行 `orderTags` 用它做 chip 排序：词表内 tag 按词表序优先，词表外 tag 字母序排末尾。

### 2.3 `derivePluginTags` / `resolvePluginTags` —— tag 的推导与合成

这两个是圆心纯函数（`contributions.ts:554` 与 `:563`），本插件不调用它们，但消费它们的产物（`PluginListItem.tags`）。机制规则固定且稳定：

- `derivePluginTags(contributes)`：`themes` 非空 → 推 `"theme"`；`languages` 非空 → 推 `"i18n"`；`settings` 或 `settingsGroups` 非空 → 推 `"management"`。无语义槽（sidebar/sidePanel/mainView/titlebar 等）不推导。
- `resolvePluginTags(manifest)`：`[...new Set([...derive, ...(manifest.tags ?? [])])]`——推导 ∪ 声明，去重保序。最终结果在 `controllers/plugins.ts:83` 与 `:105` 两处填进 `PluginListItem.tags`。

由此，本插件自己（贡献 settings + languages 槽）会被推导出 `["management", "i18n"]` 两个 tag——在管理页 chip 栏里它既是「管理」类也是「多语言」类。

### 2.4 `ctx.plugins` —— 生命周期能力面

`usePluginContext()`（`packages/react/src/plugin-context.ts:22`）返回的 `PluginContext.plugins` 直接就是 `window.kernel.plugins`（`plugin-context.ts:194`），形状在圆心 `packages/shared/src/domain/context.ts:332` 与 `packages/react/src/index.ts:217` 各声明一份（发布面 re-export，契约单源仍是圆心）。本插件用的方法：

- `list(): Promise<PluginListItem[]>` —— 全量列表，`refresh`（renderer 第 76–82 行）调它。
- `enable(pluginId)` / `disable(pluginId)` / `uninstall(pluginId)` / `reload(pluginId)` —— 四个生命周期动作，返回 `{ok, error, errorArgs?}`（uninstall 多 `errorArgs`）。
- `install(source: {type:"url"|"local"; location:string}): Promise<{ok, error}>` —— 安装。
- 未使用的：`reportLoadFailed`（renderer 侧 `plugins-host` 专用，本插件不调）、`onUnloaded`/`onPluginsChanged`（订阅类，本插件不订阅——它的列表靠每次动作后手动 `refresh()` 重拉，不靠广播）。

### 2.5 `ctx.config` —— 配置能力面

`ctx.config` 是绑定到 `pluginId = "plugin-manager"` 的 `PluginConfigApi`（`plugin-context.ts:26–31`，pluginId 由 `PluginIdContext` 注入）。本插件只用了 `get` 和 `set`：

- `ctx.config.get<T>(key)` —— 读合并后单 key。renderer 第 78 行读 `customOrder`、第 80 行读 `tagFilter`。
- `ctx.config.set(key, value, {scope:"global"})` —— 写单 key。第 136 行写 `tagFilter`、第 141 行写重置后的 `tagFilter`、第 155 行写 `customOrder`，**三处都显式 `scope:"global"`**。

注意它与 `disabledPlugins` 的差别（§9 详述）：`customOrder`/`tagFilter` 是本插件的纯 UI 状态，由本插件直接写；`disabledPlugins` 是壳生命周期机制的状态，由 `lifecycle/index.ts` 的 `disablePlugin`/`enablePlugin`/`uninstallPlugin` 写，本插件 UI 从不直接读写它，只通过 `ctx.plugins.list()` 的 `state` 字段间接感知。

### 2.6 `ctx.dialog.openDirectory` —— 本地安装的文件选择

renderer 第 121 行 `handleSelectFile` 调 `ctx.dialog.openDirectory()`（`DialogApi`，`plugin-context.ts:154`），返回选中的目录绝对路径（取消返回 null），塞进 `installUrl` 输入框。这是用户手势驱动能力（默认放行，无需权限声明）。

## 3 声明面：plugin.json 逐字段

`src/plugins/manager/plugin-manager/plugin.json`（83 行）是它的完整声明。逐字段：

- `"id": "plugin-manager"` —— 插件唯一 id。它同时是三处硬关联的锚点：`lifecycle/index.ts` 里 `disabledPlugins` 配置读写的 `"plugin-manager"` 字面量（`configStore.get/set("plugin-manager", "disabledPlugins")`）、`assemble.ts:410` 启动期读禁用名单、`plugins-host.ts:85` 读禁用名单。这条「pluginId 作为配置命名空间」是壳机制的既定约定，不是本插件代码里的魔法串（本插件代码零 plugin id 字面量，符合 §8.3 零硬编码）。
- `"version": "0.4.9"` —— semver，`PluginListItem.version` 显示用。
- `"tier": "official"` —— 显式声明官方信任级。由 `inferTier`（`controllers/plugins.ts:60`）读 `manifest.tier ?? "community"` 落进列表。
- `"displayName": "Desktop 插件"` / `"description": "管理 Desktop 插件的启用、禁用、安装、卸载、重载"` —— 这是 manifest 兜底文案；实际渲染优先走 `plugin.plugin-manager.displayName` / `plugin.plugin-manager.description` i18n key（§4.3）。
- `"renderer": "./renderer/index.tsx"` —— 渲染入口。注意：builtin 插件在 renderer 侧经 `import.meta.glob` 加载（`plugins-host.ts:4`），manifest 的 `renderer` 字段对 builtin 实际是冗余的（`controllers/plugins.ts:81` 对 builtin 直接把 `renderer` 置 null）；这个字段主要对第三方插件（动态 `file://` import）有意义。
- `"protected": true` —— 受保护标记。语义在 `lifecycle/index.ts:15–19` `canUninstall`：`manifest.protected` 为真则返回 false，卸载被拒。**本插件与 i18n、theme、message-blocks、timeline、font-presets 等并列是 protected 插件**（grep 各 plugin.json 可见）。protected 只拦「卸载」，不拦「禁用」（§8 详述）。
- `contributes.settings` —— 一条 settings 槽项，§4 专述。
- `contributes.languages` —— 12 条语言包贡献，§4.3 专述。

**它没有的字段**：`permissions`（零声明能力）、`dependsOn`（不依赖任何插件）、`piExtension`/`dshExtension`（不带内核扩展）、`tags`（靠 `derivePluginTags` 自动推 management + i18n）、`tokenSchemaVersion`（不贡献 themes）。

## 4 settings 槽贡献与框架消费

### 4.1 贡献项形状

`contributes.settings[0]` 是一个 `SettingsContribution`（`contributions.ts:9`），字段：

```json
{ "id": "plugins", "title": "settings.plugins", "icon": "puzzle", "component": "PluginManagerPage", "saveMode": "manual", "order": 6 }
```

- `id: "plugins"` —— 设置页左列表项标识，也是设置页 header 文案的 key 来源（`settings-page.tsx:88` 用 `t(\`settings.${item.id}\`, {defaultValue: item.title})`，即 `t("settings.plugins")`）。
- `title: "settings.plugins"` —— 这里 title 本身就是一个 i18n key（不是原文案）。渲染时 `t("settings.plugins", {defaultValue:"settings.plugins"})` 命中本插件 `plugin-manager.settings` namespace 的 `"settings.plugins": "Desktop 插件"`。这是本插件的一个特殊点：title 字段承载的是「key 而非值」，值在语言包里。
- `icon: "puzzle"` —— lucide 图标名，`PluginIcon`（`packages/react/src/widgets/plugin-icon.tsx:45` 词表）解析；设置页 header `PluginIcon name={item.icon}` 渲染。
- `component: "PluginManagerPage"` —— renderer 导出组件名，框架自动匹配注册（§4.2）。
- `saveMode: "manual"` —— 关键字段，决定框架不接管配置读/写/dirty（§4.4）。
- `order: 6` —— 左列表排序权重。`PluginRegistry.settingsItems()`（`registry.ts:199–217`）按 `order ?? 100` 升序，本插件排在 Pi 管理（order 0）等之后、语言（order 999）之前。

### 4.2 组件自动匹配注册（§7.4 组件自动匹配）

本插件不调用任何 `registerXxxComponent`。链路是：

- renderer 侧 `plugins-host.ts` 的 `loadBuiltin` 拿到 module（`import.meta.glob` 动态 import 的 `renderer/index.tsx`）后，调 `registerPluginComponents(mod, manifest.contributes)`（`plugins-host.ts:33`）。
- `registerPluginComponents`（`packages/react/src/index.ts:510`）遍历 `settings` 槽，对 settings 走 `flatSettingsComponents`（`:504`）把 `component` 与 `tabs[].component` 平铺成组件名列表，逐个 `asReactComponent(module[item.component])` 存入 `settingsComponents` 注册表。
- 设置页 `SettingsPane`（`settings-page.tsx:81`）`getSettingsComponent(item.component)` 按名取出 `PluginManagerPage` 渲染。

于是 `component: "PluginManagerPage"` 字符串必须与 `renderer/index.tsx:65` 的 `export function PluginManagerPage()` 导出名严格一致——框架按字符串名在 exports 里找，找不着只 `console.warn`（`index.ts:526`）不抛。

### 4.3 语言槽贡献：三 namespace × 四 locale

`contributes.languages` 的 12 条是 `LanguageContribution`（`contributions.ts:130`），拆成三个 namespace id，每个覆盖 zh-CN/zh-TW/en/de 四个 locale：

| namespace id | 资源文件 | 关键 key |
|---|---|---|
| `plugin-manager.settings` | `locales/*/settings.json` | `settings.plugins`（设置页标题） |
| `plugin-manager.plugin` | `locales/*/plugin.json` | `plugin.plugin-manager.displayName`、`plugin.plugin-manager.description` |
| `plugin-manager.pluginManager` | `locales/*/pluginManager.json` | `pluginManager.*` 全部操作/状态/tag 文案（37 个 key） |

三个 namespace 的分工：

- `plugin-manager.settings` 只供设置页 header 的 `t("settings.plugins")` 用。
- `plugin-manager.plugin` 供「本插件自己在列表里的显示名/描述」用（`PluginRow` 对每个插件查 `plugin.<id>.displayName`，本插件查到的就是它自己的这个 namespace）。
- `plugin-manager.pluginManager` 供页面全部交互文案用：操作（install/enable/disable/uninstall/reload/installBtn/selectFile/installing）、反馈（operationSuccess/operationFailed）、状态（stateActive/stateInactive/stateError）、tier（tierOfficial/tierVerified/tierCommunity）、保护提示（protectedTooltip）、分页（pagePrev/pageNext/total）、筛选（filterHint/filterReset）、tag 词表（`tag.theme/tag.i18n/.../tag.insight` 共 11 个）。

**一个必须点名的交互**：`PluginRow` 第 290–291 行拼的 `pluginManager.state*`、`pluginManager.tier*` 是本插件的 namespace；而 `showFeedback`（第 92–100 行）翻译的 `plugin.error.notLoaded/notFound/protected/dependents` 这 4 个 token **不在本插件的语言包里，而在 i18n 插件（`src/plugins/system/i18n/locales/*/plugin.json`）的 `i18n.plugin` namespace 里**。§7 展开这条跨插件依赖。

### 4.4 `saveMode: "manual"` 的框架语义

`SettingsContribution.saveMode`（`contributions.ts:24`）两档：`"framework"`（框架管 save：读 config、传 `config` prop、dirty 浮层、打开配置按钮、切 tab 拦截）与 `"manual"`（实时生效：框架不传 config、不管 save/dirty、无浮层）。

`settings-page.tsx` 对 manual 的处理（`src/web/components/settings-page.tsx`）：

- 第 18 行注释与第 189 行：`item.saveMode !== "framework"` 时 `cfgs.set(item.id, null)`——config prop 恒 null。
- 第 268 行 `activeConfigFile`：manual 项恒 null → 不显示「打开配置」按钮（本插件也没有 configFile 字段，双保险）。
- 第 276–277 行：`activeIsFramework` 判据排除 manual，dirty/save/拦截/浮层全部不生效。

为什么本插件用 manual：它的「配置」不是设置页那种「填表单 → 点保存」的模型，而是操作即时生效（点启用立刻改 `disabledPlugins`、点拖拽立刻写 `customOrder`、点 tag 立刻写 `tagFilter`），没有「草稿态」。它从框架拿到的 `config` prop 恒 null、`dirty` prop 恒 false，组件内部完全自管状态（`useState` + `ctx.config`），与框架的 save 管线零耦合。

## 5 渲染实现：renderer/index.tsx 逐块

`src/plugins/manager/plugin-manager/renderer/index.tsx` 是唯一代码文件，392 行。结构：4 个纯函数（`defaultCompare`/`sortPlugins`/`filterPluginsByTags`/`orderTags`）+ 1 个 `tierColor` + 1 个主组件 `PluginManagerPage` + 1 个子组件 `PluginRow` + 1 个样式工厂 `iconBtn` + 1 个 `TooltipButton` + 1 个 `tipStyle`。

### 5.1 状态与数据流

主组件 `PluginManagerPage`（第 65 行）持有 7 个本地 state：

- `plugins: PluginListItem[]` —— 全量列表快照，`refresh` 里 `ctx.plugins.list()` 拉。
- `customOrder: string[]` —— 用户拖拽后的完整 id 顺序，`refresh` 里 `ctx.config.get("customOrder")` 读，`handleDragEnd` 里 `ctx.config.set("customOrder", ..., {scope:"global"})` 写。
- `tagFilter: TagFilter` —— tag 三态筛选表（`Record<string, "inc"|"exc">`），`refresh` 里读、`cycleTag`/`resetTagFilter` 里写。
- `installOpen`/`installUrl`/`installing` —— 安装面板 UI 状态。
- `feedback: {ok,msg}|null` —— 操作反馈浮层，3 秒后自动清除（第 86–90 行 `setTimeout`）。

派生数据链（第 125–128 行）严格三步，顺序不可乱：`sortPlugins(plugins, customOrder)` → `filterPluginsByTags(sortedPlugins, tagFilter)` → `usePagination(filteredPlugins, PAGE_SIZE=10)`。即**排序 → 筛选 → 分页**，与既有设计 `plugin-manager-ui.md §8.4` 一致。分页总数（第 258 行 `filteredPlugins.length`）是筛选后数量。

`refresh` 用 `useCallback` 包（第 76 行），依赖 `ctx`；`useEffect(() => { void refresh(); }, [refresh])`（第 84 行）挂载时拉一次。之后每次动作 handler（`handleEnable` 等）末尾都 `void refresh()` 重拉——**本插件靠「动作后主动重拉」而不是订阅 `onPluginsChanged` 广播**，这是它相对其它消费方（如 `plugins-host` 订阅广播做热加载）更简单的选择，代价是「别的端改了插件状态」本页要手动触发才刷新。

### 5.2 排序：三级默认 + 自定义顺序覆盖

`defaultCompare`（第 24–28 行）三级：`tier`（`TIER_ORDER`）→ `source`（`SOURCE_ORDER`）→ `displayName.localeCompare`。

`sortPlugins`（第 30–40 行）在默认序之上叠自定义序：建 `Map(customOrder → index)`，比较器四条分支——两者都在 customOrder 里按 index 差排；只有一方在则「在的排前」；都不在则回落 `defaultCompare`。语义：**customOrder 里的插件永远排在前面并按用户顺序，新插件/未拖拽过的插件按默认规则排到末尾**。

`SOURCE_ORDER = {builtin:0, installed:1, user:2, project:3}`（第 22 行）与注册优先级 `builtin<installed<user<project` 同向——这只是**显示顺序**，不是加载优先级。设计文档明确：拖拽只影响管理页显示序，加载优先级永远由 source 四目录决定（§6.4），用户拖不动加载优先级。

### 5.3 tag 筛选：三态循环 + 组合

`filterPluginsByTags`（第 42–51 行）：收集 `inc`（只看）集合与 `exc`（排除）集合；两者都空直接原样返回；否则过滤——`inc` 非空时要求 `p.tags.some(命中任一 inc)`（并集），`exc` 非空时要求 `p.tags` 不含任一 exc（减去）。多 chip 组合语义：inc 是 OR 并集、exc 是 OR 减去。

`cycleTag`（第 130–137 行）三态循环：无状态 → `inc`（只看）→ `exc`（排除）→ 删除 key（不过滤）。每次点击立即 `ctx.config.set("tagFilter", next, {scope:"global"})` 持久化，下次打开保持。`resetTagFilter`（第 139–142 行）清空并写空对象。

`orderTags`（第 53–57 行）：把 `plugins.flatMap(p => p.tags)` 去重后的集合，按「`RECOMMENDED_PLUGIN_TAGS` 词表序优先，词表外字母序」排序。chip 渲染（第 205–226 行）每个 tag 一个按钮，样式三态：inc 实心 primary、exc 红色加删除线、无态虚线；右侧 `count` 是全量（未筛选）命中数；label 走 `t(\`pluginManager.tag.${tag}\`, {defaultValue: tag})`（词表外 tag 回退显示原标识符）。

### 5.4 `PluginRow`：单行渲染与动作按钮

`PluginRow`（第 266 行）是每行的纯展示组件，收 `plugin/t/onEnable/onDisable/onUninstall/onReload` 五个 props（父组件把 handler 注入，子组件零逻辑）。

- **排序拖拽手柄**：`useSortable({id: p.id})`（第 274 行），`attributes`/`listeners` 绑在 `<GripVertical>` span 上（第 295 行），`transform`/`transition` 经 `CSS.Transform.toString`（@dnd-kit/utilities）应用，拖拽中 `opacity: 0.5`。`SortableContext` 的 `items` 是 `pageItems.map(p=>p.id)`（第 243 行）——**只有当前页的 10 个可拖**，拖拽动作在 `handleDragEnd` 里对全量 `sortedPlugins` 做 `arrayMove`（§5.5）。
- **三行信息**：第一行「显示名 + 版本 + tier badge + Shield（若 protected）」；第二行「描述（单行 ellipsis，`title` 属性悬停全量）」；第三行「`id · source · stateLabel · tag 列表`」。
- **状态化按钮组**（第 315–338 行）：`state==="inactive"` → 显示启用（Power）；`state==="active"` → 显示禁用（PowerOff）；`state==="active" || state==="error"` → 显示重载（RotateCw）；卸载（Trash2）恒显示，但 `disabled={p.protected}`，tooltip 在 protected 时切 `pluginManager.protectedTooltip`。按钮是 `TooltipButton`（无边框图标小方块 + 悬停气泡），不是框架 `Button`（§5.7）。

### 5.5 拖拽排序：`handleDragEnd` 与全量 `customOrder`

`handleDragEnd`（第 146–156 行）：

- `PointerSensor` 的 `activationConstraint: {distance: 5}`（第 144 行）——移动 5px 才激活拖拽，避免点击误触拖拽。
- `collisionDetection={closestCenter}`，`onDragEnd` 拿 `active.id`/`over.id`，相等或缺一方直接 return。
- 在**全量 `sortedPlugins`**（非 pageItems）上 `findIndex` 找旧/新位置，`arrayMove(sortedPlugins, oldIndex, newIndex)` 重排，`reordered.map(p=>p.id)` 生成**完整 id 序列**，`setCustomOrder` + `ctx.config.set("customOrder", newOrder, {scope:"global"})` 持久化。

关键点：`customOrder` 存的是**全量顺序**，不是「拖过的增量」——拖一次就冻结了当时全列表的顺序。因此拖拽一次后，之后新装的插件（id 不在 customOrder）按默认规则排到 customOrder 段之后。

### 5.6 安装面板

`handleInstall`（第 107–118 行）：`installUrl` 以 `http` 开头 → `{type:"url", location}`，否则 `{type:"local", location}`（本地目录路径）；`ctx.plugins.install(source)` → `showFeedback` 显示结果 → 清空面板并 `refresh`。`handleSelectFile`（第 120 行）用 `ctx.dialog.openDirectory()` 选目录填进输入框。安装面板是内联展开的输入条（第 172–186 行），非弹窗。

**安装的返回与激活**：`controllers/plugins.ts:134–141` 的 `IPC.plugins.install` handler 在 `install()`（installer）成功后，若 `result.manifest` 和 `result.pluginPath` 存在，立刻调 `activate(lifecycleDeps, manifest, pluginPath, "installed")`——即「安装即激活」，装完的插件直接进入注册表并广播，renderer 侧 `plugins-host` 收到 `plugins:changed` 热加载其 renderer。本插件 UI 无感知这个「安装 → 激活」两步，只看到 `install` 一个调用的返回。

### 5.7 反馈浮层与错误 token 翻译

`showFeedback`（第 92–100 行）是唯一把后端返回映射成文案的地方：

- `r.ok` → `t("pluginManager.operationSuccess")`。
- `!r.ok && r.error` → `t(r.error, {deps: r.errorArgs.join(", ")})`：把 error 字符串当 **token key** 翻译，`errorArgs`（如依赖插件 id 列表）经 `{{deps}}` 插值。4 个 token 是 `plugin.error.notLoaded/notFound/protected/dependents`。
- `!r.ok && !r.error` → `t("pluginManager.operationFailed")` 兜底。

这里有一个精妙的容错约定（第 93–94 行注释）：error 若是 token key（如 `plugin.error.protected`）则 `t()` 命中翻译；若是非 token（如 installer 的 npm 退出码、HTTP 状态、解压错误这类**运行时原文**），i18next 的 `parseMissingKeyHandler` 原样返回该字符串——于是「token key」和「原文错误」共用一条 `t()` 通道自动分流。feedback 浮层样式（第 188–200 行）按 `ok` 分成功绿/失败红。

### 5.8 `TooltipButton`：Radix 收敛

`TooltipButton`（第 357–380 行）封装 Radix `Tooltip`，`delayDuration={1000}` 悬停 1 秒浮出，`Portal` + `Content side="top"` + `Arrow`。注释（第 353–356 行）记录两个收敛点：

- 手写 setTimeout 版已收敛到 Radix（§3.5 手写收敛到成熟包）——portal、边界翻转、加热区交接由成熟包代劳。
- `Trigger asChild` 套一个 `<span>` 而不是直接用 `button`：因为 `disabled` 的 button 不派发 pointer 事件，套 span 后 protected 插件的 `protectedTooltip` 也能浮出——修掉了原手写版 `!disabled &&` 把该文案写成死代码的 bug。

`iconBtn`（第 343–351 行）是无边框 28×28 小方块样式工厂；`tipStyle`（第 382 行）是气泡样式。注意 `Tooltip.Provider` 由内核根组件统一提供（第 158 行注释），本处只保留 `Root` 局部配置。

## 6 后端机制链：发现 / 注册 / 生命周期 / 安装

本插件 UI 的每一个按钮，背后都是一条「IPC → lifecycle → registry → 广播 → renderer 热加载」的完整链路。这部分是壳机制（`src/server/`），本插件不拥有它，但文档必须把它讲透——否则「插件管理器」四个字是空的。

### 6.1 发现：`discover.ts`

`discoverPlugins(rootDir, source): DiscoveredPlugin[]`（`src/server/application/loader/discover.ts:30`）：

- 递归下降 `walk(dir, depth)`，`depth > 3` 或目录不存在即停；跳过 `.` 开头和 `node_modules` 目录。
- 某目录含 `plugin.json` 且 `JSON.parse` 后 `manifest.id` 是非空字符串 → 收为 `{manifest, path, source}`，且**不再深入该目录**（plugin.json 所在目录是终点）。
- JSON 损坏或 id 缺失（如 locale 资源文件 `locales/<lang>/plugin.json` 本无 id 字段）→ 跳过，同样不深入。
- `source` 由调用方传入的目录归属决定：`builtin/installed/user/project` 四档。本文件不 import electron（扫描根由 shell 注入），同一扫描逻辑无 `if(builtin)` 分支——内置与第三方平等（§1.4）。

`DiscoveredPlugin`（`:16`）是三字段结构 `{manifest, path, source}`，是全链路的中间形态。

### 6.2 注册表：`registry.ts`

`PluginRegistry`（`src/server/application/loader/registry.ts:75`）聚合发现结果：

- `byId: Map<string, DiscoveredPlugin>` —— 按 id 存 manifest（含 source/path），`manifestOf`/`allPlugins`/`hasPermission` 查它。
- `themes: Map<string, ThemeContribution>` —— themes 槽特殊：Map 按 `t.id` 覆盖（`:146` `this.themes.set(t.id, t)`），与数组槽语义不同。
- 二十个数组类槽统一走 `ArraySlot<T>`（`:55`）：`settings/sidePanel/sidebar/mainView/titlebar/fileActions/fileIcons/messageActions/blockRenderers/codeBlockRenderers/sessionGroupings/composerPolicies/composerAttachments/composerActions/composerStats/composerTop/composerVoice/settingsGroups/systemPrompts/fontPresets`，经 `arraySlots` 映射表（`:107`）统一遍历。加新数组槽 = 加字段 + 加 SlotName + 加查询方法，register/unregister 经通用遍历不改（开闭原则）。
- `languages` 单独存 `{contribution, pluginId, source, pluginPath}[]`（`:104`），因为 i18n 合并器要按 source 优先级仲裁，不能简单数组覆盖。

`registerOne`（`:136`）单插件注册：`byId.set` → themes（先 `isTokenSchemaCompatible` 校验，不兼容则只跳过 themes 贡献、其余槽照注册并 warn，不拒整个插件）→ 遍历 `arraySlots`，每个贡献项先按 `contribution.id` 调 `removeById` 清同 id 旧项再 `push`（覆盖语义）→ languages push。

`unregister`（`:166`）按 pluginId 反操作：`byId.delete`、themes 删、所有 `ArraySlot.removeByPlugin`、languages 过滤。

**覆盖语义（无特权差异 §1.4 检验方式二）**：数组槽 `removeById` + 注册序 `builtin → installed → user → project`（`assemble.ts:206–209`）保证「后注册者（更高优先级 source）覆盖先注册者同 id 贡献」。复制内置插件到高优先级目录 = 覆盖低优先级同名贡献，无需任何 `if(builtin)` 分支。

`settingsItems()`（`:199`）是本插件 settings 槽的直接消费方：`toItem` 把 `SettingsContribution` 投影成 `SettingsItem`（补 `configFile ?? null`、`configMerge ?? "replace"`、`saveMode ?? "framework"`、`icon ?? "settings"` 兜底），并按 `order ?? 100` 升序返回。本插件的 `order:6`、`saveMode:"manual"`、无 `configFile`/`tabs`，投影后 `configFile:null`、`configMerge:"replace"`（未声明用默认）、`saveMode:"manual"`。

### 6.3 网关 handler：`controllers/plugins.ts`

`registerPlugins(gateway, ctx)`（`src/server/controllers/plugins.ts:16`）注册 7 个 IPC：

- `IPC.plugins.list`（`:66`）：读 `configStore.get("plugin-manager", "disabledPlugins")`，遍历 `registry.allPlugins()` 组装 `PluginListItem`；builtin 的 `path`/`renderer` 置 null、第三方取 manifest 值；`tier = inferTier(...)`、`state = getPluginState(id, disabled)`、`protected = !!manifest.protected`、`tags = resolvePluginTags(manifest)`。**第二段**（`:88–109`）：`disabled ∪ erroredPlugins()` 里不在注册表的 id（禁用后已撤注册、或加载失败已撤注册）也经 `rediscoverPlugin` 兜底列出，`state` 由 `getPluginState` 判定——「加载失败」和「已禁用」是可见的一等状态，不静默消失。
- `IPC.plugins.enable/disable/uninstall/reload`（`:113–127`）：各自薄转发到 `lifecycle` 的 `enablePlugin/disablePlugin/uninstallPlugin/reloadPlugin`，enable/reload 额外传 `() => rediscoverPlugin(pluginId)` 闭包。
- `IPC.plugins.loadFailed`（`:130`）：renderer 上报加载失败 → `reportLoadFailure`。
- `IPC.plugins.install`（`:134`）：`UrlSource`/`LocalFileSource` → `installPlugin(source, paths.installedDir)` → 成功则 `activate(..., "installed")`。

两个关键本地函数：

- `rediscoverPlugin`（`:43`）：按 `project → user → installed → builtin` 顺序（注意与注册序相反，从高优先级开始找）逐个 `discoverPlugins(dir, src).find(id 匹配)`。根因注释（`:44–46`）：旧码 `join(dir, pluginId)` 平铺直查，而内置仓库按域分组多一层，卸载后装不回；复用 `discoverPlugins` 单源逻辑修掉。
- `inferTier`（`:60`）：`manifest.tier ?? "community"`——tier 由 manifest 声明、不按 source 赋级（避免「内置 = official」特权），未声明统一 community。

`pluginLoader`（`:25–30`）是 no-op：main 进程不渲染插件 UI（React 组件在 renderer 进程），main 侧 load renderer chunk 是死代码（且 main 是 CJS、import React ESM chunk 会失败），已改为只注册/通知、不碰 renderer chunk。真正的 renderer 加载在 renderer 侧 `plugins-host`。

### 6.4 优先级与注册序

四级来源优先级（低 → 高）：`builtin < installed < user < project`。物理锚点在 `assemble.ts`：

- 四目录（`:184–204`）：`builtinDir`（dev 扫 `src/plugins`、pkg 扫 `resources/my-harness-desktop-builtin`）、`installedDir`（`~/.my-harness-desktop/installed`，installer 落点）、`userPluginsDir`（`~/.my-harness-desktop/plugins`）、`projectPluginsDir`（`<cwd>/.my-harness-desktop/plugins`）。
- 注册序（`:206–209`）：`registerAll(discoverPlugins(builtinDir,"builtin"))` → `installed` → `user` → `project`，**从低到高**。后注册者覆盖先注册者同 id 贡献（`registry.removeById`）。

`discover.ts` 头部注释与 `registry.ts` 注释、CLAUDE.md QA 都钉死这条序。本插件作为 builtin 源插件，若被复制到 `~/.my-harness-desktop/plugins/`（user 源），会以更高优先级覆盖内置版——这正是 §1.4 无特权差异检验方式二的落地。

## 7 与其他插件交互

这是本插件的核心主题——它存在的全部意义就是「管别的插件」。交互分五类，逐一落地到文件/函数。

### 7.1 读其它插件的 manifest 与语言贡献（显示层）

`PluginRow` 渲染每一行的显示名/描述时，做的不是「读 `p.displayName`」，而是 `t(\`plugin.${p.id}.displayName\`, {defaultValue: p.displayName || p.id})`（第 288–289 行）。这意味着：

- 每个插件的显示名优先从**它自己的语言贡献**里查——约定是每个插件贡献一个 `<pluginId>.plugin` namespace，key 为 `plugin.<id>.displayName` / `plugin.<id>.description`。例如 i18n 插件在 `src/plugins/system/i18n/locales/zh-CN/plugin.json` 里贡献 `plugin.i18n.displayName`；本插件自己贡献 `plugin.plugin-manager.displayName`。
- 壳在启动期把所有 `contributes.languages` 合并成 i18next resources（`assemble.ts:213–214` `mergeLanguageContributions`），renderer 端 `t()` 查的是**合并后的全局资源池**。所以 plugin-manager 能翻译任何插件贡献的 `plugin.<id>.*` key，而不需要知道对方是谁——这是一个「通过共享 i18n 资源池的单向消费」，插件之间没有直接 import，只有共同约定 key 命名规则。
- 第三方插件没贡献 `plugin.<id>.*` 语言 key 时，`defaultValue` 回退到 manifest 的 `displayName`/`description`（或 id/空串）。

### 7.2 消费其它插件贡献的 `plugin.error.*` token（隐式依赖 i18n 插件）

`showFeedback` 翻译的 4 个错误 token `plugin.error.notLoaded/notFound/protected/dependents` **不在本插件语言包里**，而在 i18n 插件的 `i18n.plugin` namespace（`src/plugins/system/i18n/locales/{zh-CN,zh-TW,en,de}/plugin.json:4–7`）。`plugin.error.dependents` 的文案还带 `{{deps}}` 插值占位（`"以下插件依赖此插件: {{deps}}"`），对应 `lifecycle` 返回的 `errorArgs`。

- 这是一条**未声明 `dependsOn` 的隐式依赖**：本插件的错误文案质量依赖 i18n 插件在场。它不声明 `dependsOn` 是合理的——i18n 是 `protected: true` 的常驻插件，壳启动期无条件合并其语言包；且 `t()` 有 `defaultValue`/`parseMissingKeyHandler` 兜底（i18n 缺失时 error token 原样显示，不崩）。但严格讲，这是「通过语言包共享的资源依赖」，与「通过事件总线的行为依赖」不同类。
- 反向看，本插件自己贡献的 `plugin.plugin-manager.displayName/description`、`settings.plugins`、`pluginManager.*` 也是被壳合并进同一资源池，供其它插件（理论上）与壳自身查询。

### 7.3 共享 `disabledPlugins` 单源（配置层）

`disabledPlugins` 是本插件管理的核心状态，但它**不是本插件私有配置**，而是壳生命周期机制的共享状态，单源是 `ConfigStore` 的 `plugin-manager` namespace 下这个 key。读写方清单：

- **写方**：`lifecycle/index.ts` 的 `disablePlugin`（`:156` 追加 id）、`enablePlugin`（`:175` 过滤 id）、`uninstallPlugin`（`:208` 追加 id）。注意 `uninstallPlugin` 也把 id 写进 disabled——卸载 = 禁用 + 撤注册 + 记住「别在下次启动又加载它」。
- **读方**：`controllers/plugins.ts:67`（list 算 state）、`assemble.ts:410`（启动期对 disabled 名单逐个 `registry.unregister`）、`plugins-host.ts:85` 与 `:144`（renderer 加载时跳过 disabled）。

关键含义：**本插件 UI 点「禁用」，实际上调用的是 `ctx.plugins.disable(id)` → `disablePlugin` → 写 `disabledPlugins` + `deactivate`**。UI 从不直接写这个 key；它只是把壳的 `disablePlugin` 暴露成按钮。而「禁用」的持久化语义是「写进配置」，所以重启后依然禁用（`assemble.ts` 启动期按名单撤注册）。§9 详述这个 key 与 `customOrder`/`tagFilter` 的分层差异。

### 7.4 经广播驱动 renderer 热加载（运行时层）

本插件每个动作完成后，链路末端是 `notifyPluginsChanged(gateway)`（`lifecycle/activate`/`deactivate` 等末尾，`src/server/routing/broadcast.ts:21`），广播 `plugins:changed`（带自增 nonce）。renderer 侧 `plugins-host.ts:138` 订阅 `onPluginsChanged`：

- 首 `bumpPlugins()`（`:143`）让槽壳（sidebar/右面板/设置页）重渲染查组件。
- 重拉 `disabled` + `list`，对「未加载且未 disabled 且未 failed」的 builtin/第三方插件 `loadBuiltin`/`loadThirdParty` 热加载，二次 `bumpPlugins()`（`:169`）。

以及 `notifyPluginUnloaded`（`broadcast.ts:26`）广播 `plugin:unloaded {pluginId, components}`，`plugins-host.ts:115` 的 `onUnloaded` 订阅后 `unregisterPluginModule` + `unregisterPluginComponents` + `eventBus.unregisterPlugin` + 摘 auxParsers/composerCommands——把被卸载插件的组件注册表、事件 channel、块解析器、命令全部摘掉，右栏不出现「组件未注册」孤儿。

所以本插件「禁用/卸载一个插件」的**副作用**是：renderer 侧那个插件的 React 组件被注销、它贡献的槽位项从各消费方消失、它的事件 channel 失效。这些全由壳机制完成，本插件只负责发起动作。

### 7.5 依赖关系（`dependsOn`）与卸载阻断

`lifecycle/index.ts:21–37` 的 `checkDependents`/`canDeactivate` 实现「卸载/停用被依赖插件」的护栏：

- `checkDependents(pluginId, registry)`：遍历注册表，找 `manifest.dependsOn` 里含目标 id 且 `state !== "error"` 的插件，返回其 id 列表。
- `canDeactivate(pluginId, registry)`：先 `canUninstall`（protected 则阻断，`blockedBy:["protected"]`），再 `checkDependents`（有依赖者则 `blockedBy: [依赖者 id...]`）。
- `uninstallPlugin`（`:195`）用 `canDeactivate` 把关，protected → `plugin.error.protected`、有依赖者 → `plugin.error.dependents`（`errorArgs` 带依赖者列表）。

本插件 UI 是这个护栏的**展示面**：`PluginRow` 把 `protected` 插件卸载按钮 disabled + Shield 图标 + tooltip；`showFeedback` 把 `plugin.error.dependents` 翻译成「以下插件依赖此插件: {{deps}}」。护栏逻辑在壳，UI 只是呈现。

### 7.6 本插件「不」怎么交互

同样重要：本插件**不声明任何事件 channel**（renderer 没有 `export const channels`）、**不 `dependsOn` 任何插件**、**不 emit/invoke**、**不读共享 store setter**。它与其他插件的全部交互都是「被动单向」——读别的插件的 manifest/语言包（显示）、触发壳机制去改别的插件状态（禁用/卸载）、消费壳广播的副作用（别的插件被热加载/卸载）。它从不主动 `ctx.events.emit` 告诉别的插件什么，也从不订阅任何插件自己的 channel。

## 8 插件生命周期：activate / deactivate / 卸载 / 禁用

本节把「本插件 UI 的四个按钮 + 安装」对应的完整生命周期讲透。真相源是 `src/server/application/lifecycle/index.ts`（212 行），网关是 `controllers/plugins.ts`，注册表是 `registry.ts`，renderer 热加载是 `plugins-host.ts`。

### 8.1 三态模型与判定

`PluginState = "active" | "inactive" | "error"`。`getPluginState(pluginId, disabled)`（`lifecycle/index.ts:39–43`）判定：`pluginStates` 内存 Map 里是 `"error"` → 返回 error（**error 优先于 inactive**）；否则 `disabled` 数组含 id → inactive；否则 active。

两个独立真相源合流：

- `disabled: string[]` —— 持久化在 `ConfigStore("plugin-manager","disabledPlugins")` 磁盘态。
- `pluginStates: Map<string, PluginState>`（`:9`）—— 内存态，只存 error 标记（`setPluginError` 写入、`clearPluginState` 清除），active/inactive 不落这个 Map（由 disabled 数组推导）。

### 8.2 `activate`：注册 + 挂扩展 + 广播

`activate(deps, manifest, pluginPath, source)`（`:92–116`）顺序：

1. `deps.registry.registerOne({manifest, path, source})` —— 贡献进注册表。
2. `deps.loader.load(manifest, pluginPath)` —— main 侧 no-op（`controllers/plugins.ts:26`），renderer 加载由 `plugins-host` 独立完成。
3. `deps.skillsEnsure?.onActivate(...)` —— 若插件目录带 `skills/`，写 pi settings.json skills 条目（`assemble.ts:338–361` 实现）。
4. `deps.piExtensionEnsure?.onActivate(...)` / `deps.dshExtensionEnsure?.onActivate(...)` —— 若 manifest 声明 `piExtension`/`dshExtension`，同步内核扩展目录（`assemble.ts:363–379` 实现）。
5. `clearPluginState(id)` —— 清 error 标记。
6. `deps.notifyPluginsChanged()` —— 广播 `plugins:changed`。

失败分支（`:111–115`）：`unregister` + `setPluginError` + 返回 `{ok:false, error}`。本插件（无 skills/piExtension/dshExtension）走的是最简路径：registerOne → no-op load → clearPluginState → notify。

### 8.3 `deactivate`：撤注册 + 摘扩展 + 广播卸载

`deactivate(deps, pluginId)`（`:118–135`）：`manifestOf` 查不到直接 return；否则 `unregister` → `skillsEnsure.onDeactivate` → `piExtensionEnsure.onDeactivate` → `dshExtensionEnsure.onDeactivate` → `collectComponentNames(manifest)` 收集组件名 → `notifyPluginUnloaded(pluginId, components)` → `notifyPluginsChanged()`。

`collectComponentNames`（`:53–63`）只收 settings（含 tabs 递归）/sidePanel/sidebar 三槽的 `component` 名——因为只有这三类有「组件注册表需摘除」的 renderer 侧对应物。这个组件名清单经 `plugin:unloaded` 广播送到 `plugins-host.onUnloaded`，驱动 `unregisterPluginComponents` 摘除对应组件。

### 8.4 `disablePlugin` / `enablePlugin`：禁用与启用

`disablePlugin`（`:150–160`）：读 `disabled`，id 不在则追加并 `configStore.set` 写回；然后 `deactivate`。返回恒 `{ok:true}`（除非 deactivate 抛）。

`enablePlugin`（`:162–178`）：**先 `rediscover()` 成功再清禁用标记**（`:167–170` 注释：旧序先清标记后 rediscover，失败时标记已清但插件未激活——磁盘态与内存态脱节，重启后「复活」半个卸载）；rediscover 不到 → `{ok:false, error:"plugin.error.notFound"}`；成功则从 disabled 过滤掉 id 写回，再 `activate(discovered.manifest, discovered.path, discovered.source)`。

**禁用 vs 卸载的本质区别**：禁用 = 写 `disabledPlugins` + deactivate（撤注册但磁盘文件还在，id 留在 disabled 名单防启动重载）；卸载 = 写 `disabledPlugins` + deactivate（但磁盘文件**不删**——见 §8.6）。两者都撤注册，区别只在「是否从目录删文件」，而当前实现里 `uninstallPlugin` 也**不删文件**（只标记 disabled），所以二者在当前实现下的净效果几乎等价（详见 §8.6）。

### 8.5 `reloadPlugin`：deactivate → rediscover → activate

`reloadPlugin`（`:137–148`）：`allPlugins().get(id)` 查不到 → `{ok:false, "plugin.error.notLoaded"}`；否则 `deactivate` → `rediscover()`（重读磁盘 manifest，拿到更新后的 `manifest/path/source`）→ 查不到 → `{ok:false, "plugin.error.notFound"}` → `activate(discovered...)`。语义：重载 = 完整走一遍「摘掉旧的 + 重新发现 + 重新注册」，用于 manifest 或代码改动后刷新。UI 对 `state==="active" || state==="error"` 显示重载按钮——error 态插件可经重载尝试恢复。

### 8.6 `uninstallPlugin`：护栏 + 禁用语义

`uninstallPlugin`（`:195–212`）：

1. `canDeactivate` 校验：protected → `{ok:false, "plugin.error.protected"}`；有依赖者 → `{ok:false, "plugin.error.dependents", errorArgs: [...]}`。
2. 通过后读 `disabled`，id 不在则追加写回。
3. `deactivate`。

**要点：`uninstallPlugin` 不删磁盘文件**。installer 解压落点 `installedDir/<id>/`（`installer/index.ts:105`），但卸载只把 id 写进 disabled + 撤注册，目录文件原地保留。所以「卸载」在当前实现是「禁用 + 记住禁用」，磁盘上仍是完整插件——这与用户直觉的「卸载=删除」有落差，但这是壳机制层的既定行为，本插件 UI 不篡改（UI 的 Trash2 按钮 tooltip 只写「卸载」）。要真删文件是壳的演进项，不是本插件的职责。

### 8.7 `reportLoadFailure`：renderer 加载失败上报

`reportLoadFailure`（`:184–188`）：`setPluginError(id)` + `unregister(id)` + `notifyPluginsChanged()`。触发方是 renderer 侧 `plugins-host` 的 `loadBuiltin`/`loadThirdParty` catch 分支（`:95–98`、`:102–103`）——renderer 模块 import 失败（第三方 `file://` 动态 import 失败、组件 export 缺失等）时调 `window.kernel.plugins.reportLoadFailed(id)` → `IPC.plugins.loadFailed` → 本函数。它与 `activate` 的失败分支同出口（`:181` 注释）：撤贡献 + 记 error 态 + 广播，让右栏/设置页/侧栏/标题栏的槽位消费方自然不再列出该插件——修掉了「main 注册表昭告了贡献、renderer 却无组件可注册 → 右栏出现『组件未注册』孤儿 Tab」的根因。

`erroredPlugins()`（`:191`）列当前 error 态插件 id，供 `controllers/plugins.ts:88` 在 list 第二段把它们兜底列出（管理页可见「加载失败」状态行）。

### 8.8 本插件 UI 触发链路的完整映射

| UI 动作 | 调用的 ctx API | 后端 handler | lifecycle 函数 | 净效果 |
|---|---|---|---|---|
| 启用（Power） | `ctx.plugins.enable(id)` | `IPC.plugins.enable` | `enablePlugin` | rediscover → 清 disabled → activate → 广播 |
| 禁用（PowerOff） | `ctx.plugins.disable(id)` | `IPC.plugins.disable` | `disablePlugin` | 写 disabled → deactivate → 广播 |
| 卸载（Trash2） | `ctx.plugins.uninstall(id)` | `IPC.plugins.uninstall` | `uninstallPlugin` | canDeactivate 护栏 → 写 disabled → deactivate → 广播 |
| 重载（RotateCw） | `ctx.plugins.reload(id)` | `IPC.plugins.reload` | `reloadPlugin` | deactivate → rediscover → activate → 广播 |
| 安装（Download） | `ctx.plugins.install(source)` | `IPC.plugins.install` | `installer.install` → `activate` | 解压落盘 → 注册 → 激活 → 广播 |

每次动作后 `handleXxx` 末尾 `void refresh()` 重拉列表，反映新的 `state`。

## 9 配置与持久化

本插件涉及三个配置 key，全部落在 `ConfigStore` 的 `plugin-manager` namespace（物理文件 `~/.my-harness-desktop/config/plugin-manager.json` 或项目级 `<cwd>/.my-harness-desktop/config/plugin-manager.json`）。但三个 key 的**写方、作用域、语义**各不相同，必须分开讲。

### 9.1 `disabledPlugins` —— 壳机制状态，非本插件 UI 状态

- **写方**：`lifecycle/index.ts` 的 `disablePlugin`/`enablePlugin`/`uninstallPlugin`，通过 `configStore.set("plugin-manager", "disabledPlugins", ...)` **不带 `scope` 参数**（默认写 project，无项目时落 global）。
- **读方**：`controllers/plugins.ts:67`、`assemble.ts:410`、`plugins-host.ts:85/144`。
- **本插件 UI 从不读写**：它只通过 `ctx.plugins.list()` 返回的 `state` 字段间接看到。

### 9.2 `customOrder` / `tagFilter` —— 本插件 UI 状态

- **写方**：renderer 第 136/141/155 行 `ctx.config.set(key, value, {scope:"global"})`，**显式 global**。
- **读方**：renderer 第 78/80 行 `ctx.config.get(key)`。
- **语义**：纯 UI 偏好（显示顺序、筛选态），与加载/生命周期无关，天然全局、不分项目。

### 9.3 作用域差异的含义

`ConfigStore`（`src/server/application/config/config-store.ts`）的分层：读 = `{...user, ...project}` 顶层 key 浅合并；写默认 project（无项目落 global），`scope:"global"` 显式写全局。由此：

- `customOrder`/`tagFilter` 恒 global —— 用户在 A 项目拖的排序在 B 项目也生效（显示偏好不分项目）。
- `disabledPlugins` 默认写 project —— 在「有激活项目」时禁用清单落到项目级 diff，切项目可能看到不同的禁用集合；无项目时落 global。这是壳生命周期的既定行为，本插件 UI 不干预也不感知（它只看到 `state`）。

**一个值得标注的边界**：`ctx.config` 是绑定 `pluginId = "plugin-manager"` 的 API，但它读写的 `customOrder`/`tagFilter` 与壳生命周期读写的 `disabledPlugins` 共用同一个 namespace 文件 `plugin-manager.json`。三个 key 互不冲突（key 名不同），但物理同文件——所以「卸载 plugin-manager 插件」不会清掉 `disabledPlugins`（那是壳机制依赖的），也不会影响其它插件（`ConfigStore.delete` 只在显式「卸载并清除」时调用，`uninstallPlugin` 不调它）。

## 10 与框架共享控件的收敛

本插件渲染层不手写分页、不手写按钮视觉契约，复用 `@my-harness-desktop/react` 框架控件。这是 §3.5「手写收敛到成熟包」与 §3.3「框架管通用」在具体控件上的落地：

- **`Button`**（`packages/react/src/widgets/button.tsx`）：主安装按钮、安装面板按钮、取消等用 `variant="primary"|"secondary"`。注释记录：blind-review/pi-manager/pi-model-manager/skill-manager/plugin-manager/tool-manager 曾各自抄一份 `btnStyle` 工厂（差异仅参数级），收敛为框架控件；禁用态消费 `--color-disabled`/`--color-disabled-fg` token，不再 opacity 压色。
- **`Pagination` / `usePagination`**（`packages/react/src/widgets/pagination.tsx`）：翻页组件与 Hook。注释记录：plugin-manager 与 skill-manager 曾各自抄一份翻页（iconBtn、页码渲染、滚动方向检测、clamp、slice 完全重复，且 skill-manager 把「非当前页」误当「禁用」语义），收敛为框架控件。`usePagination` 额外负责「当前页超出 totalPages 自动回退」和「翻页 scrollIntoView 上溯真滚动祖先」——设置页内容容器契约下 `scrollRef` 锚的元素自身不可滚，`scrollIntoView` 上溯。
- **`PluginIcon`**（`packages/react/src/widgets/plugin-icon.tsx`）：本插件只在贡献声明里用了 `icon:"puzzle"`，渲染由设置页 header 的 `PluginIcon` 解析（词表在 `:16–75`，未知名回落 Puzzle）。
- **框架 SettingsSection/ListItem 等**本插件没直接用（它自绘行布局），但设置页整体由框架 `SettingsPage`/`SettingsPane` 提供滚动/padding/内容容器契约（`settings-page.tsx:94–99`），本插件只渲染内容、不自建滚动容器。

本插件唯一保留的手写小方块按钮 `iconBtn`/`TooltipButton` 是行内图标按钮（非框架 `Button` 的语义），且有明确的 Radix 收敛理由（§5.8）；它不是「重复造轮子」，是「框架 Button 不适配行内图标方块 + disabled tooltip」的局部例外。

## 11 QA

**Q1：为什么 plugin-manager 用 `saveMode: "manual"` 而不是 framework？**

它的「配置」没有「草稿 → 保存」模型：启用/禁用/拖拽排序/tag 筛选都是**操作即时生效并立即写盘**（`ctx.config.set` 或后端 lifecycle 直接写），不存在「编辑表单后点保存」。framework 模式会传 `config` prop、管 dirty、弹保存浮层，对本插件全部多余。manual 下框架传 `config: null`、`dirty: false`，组件自管状态，与框架 save 管线零耦合（`settings-page.tsx:189/268/277`）。

**Q2：`disabledPlugins` 和 `customOrder`/`tagFilter` 都在 plugin-manager.json 里，为什么作用域不同？**

写方不同：`disabledPlugins` 是壳生命周期（`lifecycle/index.ts`）写的，默认 project scope（切项目可能看到不同禁用集）；`customOrder`/`tagFilter` 是本插件 UI 写的，显式 `scope:"global"`（显示偏好不分项目）。同 namespace 不同 key 只是「物理同文件」，语义上一个是壳机制状态、一个是插件 UI 状态，互不干扰。

**Q3：卸载一个插件真的会删除它的文件吗？**

不会。`uninstallPlugin`（`lifecycle/index.ts:195`）只做「`canDeactivate` 护栏 → 写 `disabledPlugins` → `deactivate`」，**不删磁盘目录**（installer 落点在 `installedDir/<id>/` 原地保留）。所以当前「卸载」净效果约等于「禁用 + 记住禁用」，重启后因 `assemble.ts` 按 disabled 名单撤注册而保持卸载态。真删文件是壳机制演进项，不是本插件职责。

**Q4：为什么本插件不订阅 `onPluginsChanged` 广播，而是每次动作后手动 `refresh()`？**

它只关心「自己刚发起的动作」的即时反馈，动作 handler 末尾 `void refresh()` 重拉足够。订阅广播对它是「别的端改了插件状态要同步刷新」的场景，本插件目前不做多端同步 UI，所以选择更简单的手动重拉。相比之下 `plugins-host` 必须订阅广播，因为热加载/卸载组件注册表不能靠手动触发。

**Q5：`plugin.error.*` 错误文案为什么不在 plugin-manager 自己的语言包里？**

历史约定：这些错误 token 是壳生命周期通用错误（notLoaded/notFound/protected/dependents 对任何调用方都有意义），收敛在 i18n 插件的 `i18n.plugin` namespace（`src/plugins/system/i18n/locales/*/plugin.json`）。plugin-manager 只是它的一个消费方。这条依赖没声明 `dependsOn`，因为 i18n 是 protected 常驻插件、启动期无条件合并，且 `t()` 有 `defaultValue`/`parseMissingKeyHandler` 兜底不崩。

**Q6：拖拽排序会不会改变插件的加载优先级？**

不会。拖拽只写 `customOrder`（显示顺序），加载优先级永远由 source 四目录序 `builtin < installed < user < project`（`assemble.ts:206–209` + `registry` 覆盖语义）决定，用户拖不动。`SOURCE_ORDER` 在 `defaultCompare` 里只是「默认显示顺序」的权重，与加载无关。

**Q7：protected 插件能禁用吗？**

能。`protected` 只拦「卸载」（`canUninstall` → `canDeactivate` 返回 `blockedBy:["protected"]`），不拦「禁用」——`disablePlugin` 不调 `canDeactivate`，直接写 disabled + deactivate。所以 plugin-manager/i18n/theme 这些 protected 插件可以被用户禁用（功能消失但可再启用），只是不能卸载（Trash2 按钮 disabled + Shield 图标 + tooltip）。

**Q8：本插件自己能被卸载或禁用吗？**

不能卸载（`protected: true`），但**能禁用**（Q7 的推论）。不过禁用它会陷入「管理页消失 → 无法从 UI 再启用」的自指困境——因为它是唯一暴露插件管理 UI 的插件。禁用后要恢复只能手动改 `plugin-manager.json` 的 `disabledPlugins` 去掉 `"plugin-manager"`，或经 `ctx.plugins.enable` 从其它入口调用。这是 protected 只拦卸载、不拦禁用这一机制对「自管理插件」的边界效应。
