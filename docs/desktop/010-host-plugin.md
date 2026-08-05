# 010 主体与插件：设计哲学、契约、通信与目录结构

pi-desktop 的插件体系已经跑了 34 个内置插件、14 个已实现贡献接口的槽位、一整套加载/注册/生命周期机制。这份文档把"主体与插件怎么接在一起"的设计说透——哲学、契约、通信、分类、物理落点、隔离纪律，六面合一。

---

## 1 设计哲学

### 1.1 机制与内容分离

一个系统的内核分两种东西：让功能能挂上来的**机制**，和挂在上面的**功能**本身。机制是加载器、槽位契约、权限沙箱、进程隔离、生命周期管理——这些是"让东西能存在"的能力。内容是文案、配色、管理页、渲染逻辑、业务分支——这些是"存在之后干什么"。

pi-desktop 的内核功能含量趋近于零。内核里不该出现一个写死的中文文案、一个写死的颜色值、一段"如果工具名是 bash 就渲染成终端"的分支逻辑。出现就是违规。

只有一条例外：token key 合规，token 值违规。内核渲染时必然出现查询标识——`theme["color.primary"]`、`i18n.t("timeline.toolExecuting")`——这些是 key，是稳定不变的查询契约，不算"写死"。违规的是写死 key 背后的值——`"#89b4fa"` 是颜色值，`"工具执行中"` 是文案原文，它们是会变的内容，该由主题插件和语言插件贡献。key 是契约、值是内容，性质完全不同。

这条纪律的落点：所有文案推给 `system/i18n` 插件（4 种语言：简/繁/英/德，每个语言包是 key→文案的扁平 JSON 字典），所有配色推给 `themes/` 域的 7 个插件（每个是一组 token key→value 的纯 JSON 声明），所有管理页推给 `manager/` 域（pi-manager、pi-model-manager、theme-manager、plugin-manager、skill-manager、tool-manager、extension-manager），所有业务渲染推给对应功能插件（timeline 管消息流，git-review 管 Git 变更，blind-review 管盲审）。

### 1.2 消费而非翻译

不把自己定位成 pi 底座终端界面的翻译层——不造 adapter 把终端组件树翻译成 Web 组件树。底座经 RPC 吐出结构化数据（JSON Lines），桌面插件拿到数据自己决定怎么画。这是单向的、由桌面主动的消费，不是双向的、被动的翻译。

一字之差消解整个中间层：没有"翻译对方的组件树"这件事，自然不需要翻译层；没有翻译层，就没有"行为和外观两套并列概念"；没有两套并列概念，第三方想在桌面有 UI，写一个桌面插件就行，不用给内核贡献 JSON 等发版。

### 1.3 内置件无特权

内置插件随壳分发、保证开箱即用，但架构地位和第三方插件完全平等——走同一套加载器、同一套契约，优先级最低、可被覆盖。内核不该有任何"识别内置件并特殊对待"的代码路径。

两个检验方式：删掉任何一个内置插件，内核照常启动，只是少了那块功能；把任何一个内置插件复制到用户目录，它以更高优先级覆盖内置版。

代码证据：加载器的发现函数 `discoverPlugins()`（`src/core/application/loader/discover.ts`）对四个目录（builtin → installed → user → project）走同一套扫描逻辑——递归下降，目录含 `plugin.json` 且 manifest 有 id 即为插件——没有 `if (builtin)` 分支。注册表 `PluginRegistry.registerOne()`（`src/core/application/loader/registry.ts`）按优先级序 `builtin → installed → user → project` 依次注册，后注册者通过 `removeById` 覆盖同 id 的旧贡献项——不是"内置件被特殊保护"，而是"后注册者自然优先，而内置件最先注册所以优先级最低"。两个机制都在注册表自身，不在加载器——加载器只扫描、不判特权。

### 1.4 框架管通用，特化归插件

多个插件都要做的事——save/dirty/intercept/refresh/pluginId 注入/组件注册/事件 channel 注册——收进框架统一承担，不让每个插件各写一遍。插件只管两件事：渲染 UI，和报告改动。

具体落点：
- **配置保存**：插件在 manifest 里声明 `configFile`，框架自动管读、写、dirty 追踪、保存、重置。插件只管渲染 UI 和调 `onChange` 报告改动。
- **拦截**：有 dirty 时切 tab/返回对话，框架弹窗"保存/丢弃/取消"。插件不用自己写拦截逻辑。
- **组件注册**：插件只 `export function ComponentName()`，框架从 manifest 的 `contributes.*[].component` 字段在 module exports 里自动匹配。`packages/react/src/index.ts` 的 `registerPluginComponents()` 函数（第 396-413 行）完成此工作。
- **pluginId 注入**：`PluginIdContext`（`packages/react/src/plugin-id-context.ts`）是一个 React Context，shell 的四个槽壳组件（right-panel / sidebar / settings-page / main-view-host）在渲染插件组件时用 `<PluginIdContext.Provider value={item.pluginId}>` 包裹。插件调 `usePluginContext()` 无参，内部从 `PluginIdContext` 读 pluginId 自动绑定。
- **事件 channel 注册**：插件 `export const channels = [...]`，框架加载 module 后读 `module.channels` 自动注册。

---

## 2 契约

### 2.1 三个接入点

一个插件要接入 pi-desktop，只需要触碰三个点：

1. **`plugin.json`**（声明）：manifest 文件，声明插件的身份、依赖、权限、槽位贡献。
2. **`renderer/index.tsx`**（呈现）：React 组件入口，export 组件 + channels + 调 `usePluginContext()` 拿受控 API。
3. **PluginContext**（能力）：`usePluginContext()` 返回的 API 对象，分层提供 config/fs/git/sessions/events 等全部能力。

三个点，三种职责：manifest 管声明，renderer 管呈现，PluginContext 管能力。

### 2.2 Manifest 字段

类型定义在 `src/core/domain/contributions.ts` 的 `PluginManifest` 接口（第 262-287 行）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | `string` | 是 | 插件唯一标识，发现阶段以此过滤（无 id 的 `plugin.json` 被形态校验自然滤掉，如 i18n/locales 下的语言资源文件） |
| `version` | `string` | 是 | 语义版本号 |
| `displayName` | `string` | 否 | 展示名（如"会话收藏"） |
| `description` | `string` | 否 | 描述 |
| `renderer` | `string` | 否 | renderer 入口文件路径（相对插件目录，如 `"./renderer/index.tsx"`） |
| `permissions` | `string[]` | 否 | 声明能力数组：`fs:project` / `git:read` / `git:write` / `llm:oneshot` |
| `dependsOn` | `string[]` | 否 | 依赖的插件 id 列表，声明后框架保证拓扑加载顺序和卸载拦截 |
| `contributes` | `PluginContributes` | 否 | 槽位贡献声明（见 §2.3） |
| `protected` | `boolean` | 否 | 不可卸载标记。plugin-manager / i18n / theme 各自声明 `protected: true` |
| `tokenSchemaVersion` | `string` | 否 | 主题 token schema 兼容范围（如 `"^1.0"`），仅 themes 槽插件需要。与圆心 `THEME_TOKEN_SCHEMA_VERSION` 按 semver 判定兼容性 |
| `tier` | `PluginTier` | 否 | 信任级别：`official` / `verified` / `community` |
| `tags` | `string[]` | 否 | 分类标签（如 `["session", "git"]`）。最终 tags = 框架推导（themes → `"theme"`, languages → `"i18n"`, settings → `"management"`）∪ manifest 声明 |

实例（`src/plugins/sessions/session-bookmarks/plugin.json`）：

```json
{
  "id": "session-bookmarks",
  "version": "0.1.0",
  "displayName": "会话收藏",
  "description": "会话书签管理",
  "tags": ["session"],
  "renderer": "./renderer/index.tsx",
  "dependsOn": ["timeline", "session-tree"],
  "permissions": ["fs:project"],
  "contributes": {
    "sidePanel": [
      { "id": "bookmarks", "label": "收藏", "icon": "bookmark", "component": "BookmarksTab", "order": 5, "revealOn": "timeline:bookmarkRequested" }
    ],
    "languages": [
      { "id": "session-bookmarks.bookmarks", "locale": "zh-CN", "resources": "./locales/zh-CN/bookmarks.json" }
    ]
  }
}
```

### 2.3 槽位契约

槽位是内核预定的挂载点。插件往槽位上挂内容，内核只认槽位契约不认具体插件。每个槽位有形状定义——`src/core/domain/contributions.ts` 里定义了 14 个贡献接口，对应 14 个已实现贡献接口的槽位：

| 槽位 | 贡献接口 | 说明 |
|---|---|---|
| `sidebar` | `SidebarContribution` | 左侧栏：会话列表(sessions-list)、项目列表(projects) |
| `sidePanel` | `SidePanelContribution` | 右侧面板 Tab：会话树、Git review、盲审、Token 统计等。支持 `revealOn` 声明式揭示 |
| `mainView` | `MainViewContribution` | 中区主视图：timeline 插件贡献的会话消息流 |
| `titlebar` | `TitlebarContribution` | 标题栏右侧按钮：debug-bar |
| `settings` | `SettingsContribution` | 设置页：pi-manager、pi-model-manager、theme-manager、plugin-manager、skill-manager、tool-manager、extension-manager、general-config、blind-review |
| `themes` | `ThemeContribution` | 主题配色方案（`{id, name, tokens, base?}`，纯 JSON 声明） |
| `languages` | `LanguageContribution` | 语言文案包（`{id, locale, resources}`） |
| `messageRenderers` | `MessageRendererContribution` | 按消息 role/kind 自定义卡片 |
| `fileActions` | `FileActionContribution` | 文件上下文动作（盲审文件）。声明 `{id, labelKey, icon?, when?}`，触发经 `ctx.events.invoke` 路由 |
| `fileIcons` | `FileIconContribution` | 文件树图标映射（扩展名/文件名 → 图标）。按 key 合并，后注册者覆盖 |
| `messageActions` | `MessageActionContribution` | 消息行动作按钮（重试/复制/收藏）。声明 `{id, component, placement?, when?, order?}` |
| `sessionGroupings` | `SessionGroupingContribution` | 会话分组策略。声明 `{id, parentPathKey, childLabelKey?, childIcon?, order?}` |
| `composerPolicies` | `ComposerPolicyContribution` | 输入框策略。声明 `{id, customKey, readonlyMessageKey?, order?}` |
| `systemPrompts` | `SystemPromptContribution` | 系统提示注入。声明 `{id, file, order?}`，SessionStore spawn 收集后注入底座 |

`SlotName` 联合类型里另有 `management` / `cardRenderers` / `viewers` / `commands` 四个预留名，贡献接口未实现，在 manifest 里声明了会被忽略。

### 2.4 优先级与覆盖

插件按来源分四个优先级：`builtin`（内置，最低）< `installed`（已安装）< `user`（用户目录 `~/.pi-desktop/plugins/`）< `project`（项目目录 `<cwd>/.pi-desktop/plugins/`）。

覆盖语义（`src/core/application/loader/registry.ts` 第 109-136 行）：数组类槽位（sidebar/sidePanel/settings 等 11 个），后注册者在 push 前通过 `removeById` 清除同 contribution id 的旧项——bootstrap 注册序 `builtin → installed → user → project` 保证后注册者（更高优先级 source）自然覆盖先注册者。Map 型槽位（themes）按 id 覆盖。同级时按声明顺序，先声明的先选。

### 2.5 组件自动匹配

插件不手动调 register 函数。框架加载 renderer module 后，读 manifest 的 `contributes.*[].component` 字段，在 module 的 exports 里找同名组件，自动注册。

`packages/react/src/index.ts` 的 `registerPluginComponents()` 函数（第 396-413 行）完成此逻辑：遍历五个有 component 字段的槽位（settings/sidePanel/sidebar/mainView/titlebar），对每个 item 在 `module[item.component]` 中查找，找到即注册到对应 `Map`。找不到则 console.warn。

两层校验：TypeScript 编译器保证 export 的名字存在，框架加载时保证 manifest 的 component 名和 export 匹配——找不到就报错。

---

## 3 通信设计

### 3.1 概述：PluginContext 即全部

插件代码能拿到的唯一 API 对象是 PluginContext（圆心定义在 `src/core/domain/context.ts`，实现在 `packages/react/src/plugin-context.ts`）。经 `usePluginContext()` 获取，不需要传参、不需要手写 pluginId——pluginId 由 `PluginIdContext`（React Context）自动注入。

PluginContext 分三层：

**pluginId 绑定层**——调用时不用传 pluginId，从 Context 自动读：
- `ctx.config.get/set/all/getScope`：插件自身配置读写。默认项目级 `<cwd>/.pi-desktop/config/{pluginId}.json`，全局 `~/.pi-desktop/config/{pluginId}.json` 自动兜底（顶层 key 浅合并）
- `ctx.fs.*`：文件系统访问（需声明 `fs:project` 权限）。全部路径经 `assertProjectPath` 圈禁到项目根
- `ctx.git.*`：Git 只读（需声明 `git:read`）——status/diff/content/log
- `ctx.gitWrite.*`：Git 写面（需声明 `git:write`）——commit/push
- `ctx.llm?.oneshot`：一次性问底座（需声明 `llm:oneshot`）

**系统级 API 层**——不绑 pluginId，框架透传，所有插件可用（不需声明权限）：
- `ctx.prefs.get/set`：桌面偏好（主题 id、字号、字体等）
- `ctx.themes.list/build`：主题列表和合并
- `ctx.kernel.status/listVersions/install`：pi 底座内核管理
- `ctx.modelsConfig.get/set`：模型配置（`~/.pi/agent/models.json`）
- `ctx.piSettings.get/set/schema`：pi 底座 settings（`~/.pi/agent/settings.json`）
- `ctx.sessions.*`：会话全生命周期（start/stop/prompt/fork/clone 等 40+ 方法）
- `ctx.messaging.*`：消息发送（prompt/steer/followUp/abortRetry）
- `ctx.i18n.t/locale`：翻译和当前语言
- `ctx.dialog.openDirectory/openImages`：对话框（用户手势驱动）
- `ctx.plugins.list/enable/disable/uninstall/reload/install`：插件管理
- `ctx.configFile.get/append`：通用 JSON 配置读写（只读旧数据迁移窄口；JSONL 追加原语服务 session 文件等 append-only 文件）
- `ctx.skills.*`：技能管理
- `ctx.extension.*`：pi 底座 extension 管理
- `ctx.restart.*`：重启协调
- `ctx.openFile`：系统默认编辑器打开文件
- `ctx.layout.openView/closeView`：动态布局引擎

**事件层**——插件间通信唯一通道（§3.3-3.5）：
- `ctx.events.emit(channel, payload?)`
- `ctx.events.on(channel, handler, opts?)`
- `ctx.events.invoke(channel, payload?)`

### 3.2 权限模型：三层能力

`window.pi` 上的 API 分三层（`src/api/preload/preload.ts` 的实际组织）：

**核心默认**：config、prefs、themes、settings、sessions、messaging、models、i18n、kernel、piSettings、configFile、plugins、extension、skills、restart、dialog、events、openFile、revealPath、platform、app.info、window.*。所有插件可用，不需声明权限。

**声明能力**：`fs:project`、`git:read`、`git:write`、`llm:oneshot`。需要插件在 `plugin.json` 的 `permissions` 字段里声明，main 进程在 IPC 边界检查。

权限门控实现在 `src/api/ipc/fs-git.ts` 的 `registerFsGitIpc()` 函数（第 13-129 行）。每个 IPC handler 开头调用 `assertPermission(pluginId, "fs:project")` 或对应的权限字符串——该函数委托给 `registry.assertPermission()`（`src/core/application/loader/registry.ts` 第 307-312 行），未声明则直接抛错。

路径圈禁同时生效：`assertProjectPath()` 函数（第 23-32 行）做 resolve + 前缀检查，防止 `..` 逃逸——路径必须落在当前项目根（`sessionStore.getActiveCwd()`）内，fail-closed（无激活 cwd 时拒绝）。

**用户手势驱动**：dialog（打开目录、打开图片）。由用户手势触发，默认放行。

### 3.3 插件间通信：事件唯一通道

插件之间唯一合法的通信是 `ctx.events.emit/on`。不通过共享 store 互读写，不通过 `window.pi` 直调对方能力。

**事件总线**在 renderer 侧运行（`packages/react/src/event-bus.ts` 的 `EventBusImpl` 类），不跨进程。channel 不进 manifest，由代码级 `export const channels` 声明——框架加载 module 后读 `module.channels` 自动注册（`registerChannels` 方法，第 49-61 行）。

**emit 与 invoke 是两种原语**：
- `emit`（第 88-105 行）：发布/订阅。只能发自己声明过的 channel（越权直接抛错），payload 被缓存供 `replayLast` 回放——适合可回放的状态广播。
- `invoke`（第 110-128 行）：定向分派。调别的插件拥有的 channel，调用方不需要权属——适合一次性命令。无订阅者时入队（`pendingInvokes`），首个订阅者挂载时恰好一次投递，不做回放（命令不是状态，回放会误重放）。

**dependsOn** 声明在 manifest 里，作用有两层：加载时拓扑排序保证发布方先于订阅方加载，使 channel 在订阅方 `on` 时已就绪；卸载时反向依赖检查——依赖方在线时，被依赖插件不能被停用/卸载（`src/core/application/lifecycle/index.ts` 的 `checkDependents()` 和 `canDeactivate()` 函数，第 21-37 行）。凡消费别人的 channel（on 或 invoke）都应声明 dependsOn。

**框架系统事件**用 `system:` 前缀（`system:cwdChanged`、`system:sessionChanged`、`system:settingsChanged`、`system:pluginsChanged`、`system:panelVisibilityChanged`），插件订阅不需要 dependsOn。`emitSystem` 方法（第 130-145 行）是框架专用，插件 emit `system:*` 会被拒绝。

**replayLast**：`ctx.events.on("channel", handler, { replayLast: true })` 时，框架检查该 channel 是否有最近一次 emit 的缓存——有就立即调 handler。`system:*` 事件天然需要这个——新加载的插件需要知道当前 cwd。如果 channel 从未被 emit 过，不会调 handler，handler 只作为普通订阅者注册。

**共享 store 只读**：插件可以读 `useUiStore` / `useSessionStore` 的框架状态（currentCwd、messages 等），但不能调 store 的 setter。插件要改变框架状态走 ctx API（如 `ctx.sessions.setContext()`），框架处理后更新 store 并 emit 系统事件。

### 3.4 零硬编码

插件代码中不允许出现 plugin ID、component 注册名、slot contribution ID、配置文件路径的字符串字面量。具体落点：

- **plugin ID**：不写 `const PLUGIN_ID = "my-plugin"`，pluginId 由 `PluginIdContext`（`packages/react/src/plugin-id-context.ts`）自动注入。`usePluginContext()` 内部调 `usePluginId()` 拿 pluginId，调用方无参。
- **component 注册名**：不调任何 register 函数，只 `export function ComponentName()`。框架从 manifest 的 `contributes.*[].component` 自动匹配 export（`packages/react/src/index.ts` 的 `registerPluginComponents()`）。
- **slot 可见性**：插件不查 `useUiStore` 判断自己是否可见。框架渲染组件时传 `isActive` prop——只有当前激活的组件才被渲染，不激活的组件根本不 mount。
- **配置路径**：不写 `window.pi.configFile.get("~/.pi-desktop/config/general.json")`。框架通过 `ctx.config.get/set/all` 提供自动路径推导（基于 pluginId），不需要插件拼路径。

这些规则由 ESLint 在 `src/plugins/` 目录下强制执行（`no-restricted-syntax` 拦截 `window.pi` 直访、`PLUGIN_ID` 常量、`usePiApi` 调用、`registerXxxComponent` 调用）。

---

## 4 分类设计

### 4.1 六组内置域

34 个内置插件按功能域分六组，物理上对应 `src/plugins/` 下的六个目录（与 `src/core/application/loader/discover.ts` 的递归下降兼容——目录含 `plugin.json` 即终点，不深入；无 `plugin.json` 则继续向下找）：

| 域 | 插件 | 职责 |
|---|---|---|
| **sessions/** | sessions-list, session-tree, session-bookmarks, session-colors, timeline, sub-agent, review, im-graph, retry | 会话生命周期：列表、树、书签、时间线、子代理、审查、消息图、重试 |
| **project/** | projects, file-tree, git-review, notes, file-preview | 项目与文件：项目列表、文件树、Git 审查、常用语、文件预览 |
| **insight/** | token-stats, blind-review | 洞察：Token 统计、盲审（多蓝队独立审查 + 裁判汇总） |
| **manager/** | pi-manager, pi-model-manager, plugin-manager, theme-manager, skill-manager, tool-manager, extension-manager | 管理页：底座版本/配置、模型、桌面插件、主题、技能、工具过滤、扩展 |
| **themes/** | theme, theme-chatgpt, theme-midnight, theme-mocha, theme-new-york, theme-stone, theme-terminal | 外观：7 套主题，全部是纯 JSON 声明 |
| **system/** | i18n, general-config, debug-bar, goody-hao | 框架级内容：4 种语言、通用配置、debug 按钮 |

### 4.2 内置 vs 用户 vs 项目

三者在加载器眼里没有区别——同一个 `discoverPlugins()` 函数，同一个 `registerOne()` 注册逻辑，同一个生命周期管理。唯一的区别是 `source` 标记和由此决定的注册顺序。

第三方插件放 `~/.pi-desktop/plugins/`（用户级，source = `"user"`）或项目根目录的 `<cwd>/.pi-desktop/plugins/`（项目级，source = `"project"`）。已安装的第三方插件放 `~/.pi-desktop/installed/`（source = `"installed"`）。四种 source 加上 `builtin`，共五个可能值。

安装流水线（`src/core/application/installer/index.ts`）：解压 tar.gz → 校验 `plugin.json`（必填 id + version）→ 移到 `~/.pi-desktop/installed/{id}/`。URL 和本地文件两种 source 都支持。

### 4.3 单插件内部三分

单插件内部可按需分出三个子目录（有逻辑才建，小插件不建）：

- **`core/`**：纯 TypeScript 逻辑——不 import react、不 import ctx，可裸单测。如 session-tree 的 `core/tree-model`。
- **`renderer/`**：流入面——React 组件 + hooks + 事件订阅。manifest 契约的入口名（`renderer` 字段指向的路径）不动。
- **`client/`**：流出面——封装 `ctx.*` 的出站调用。如 notes 的 `client/notes-store`。

这不是强制结构——34 个内置插件中大部分只有 `renderer/index.tsx` 一个文件，够用就不多建。当一个插件的业务逻辑足够复杂、需要独立测试时，才拆出 `core/`。

---

## 5 目录结构

### 5.1 内核分区与插件的关系

pi-desktop 的源码按洋葱分区，`src/` 下五层各自装什么（详见 `docs/DESIGN.md` §6）：

```
src/
  core/         # 圆心：插件能引用的类型来自这里（经 packages/contract 发布）
    domain/     #   PluginManifest / PluginContributes / SlotName / PluginContext 接口 —— 全部在此定义
    application/#   加载器(discover + registry)、生命周期(activate/deactivate)、安装器(installer)
  api/          # 流入适配器：IPC handler / preload 桥接面 / renderer 槽壳
  client/       # 流出适配器：pi RPC 适配 / fs / git / npm
  bootstrap/    # 组装根：Electron main 入口
  plugins/      # 内容层：一切功能
packages/
  contract/     # 发布面：domain 类型的纯 re-export（零新定义）
  react/        # 发布面：usePluginContext + PluginIdContext + eventBus + 组件/hooks
```

插件代码物理上不放在 `src/plugins/` 也行——第三方插件放 `~/.pi-desktop/plugins/`，经 `import(file://path)` 运行期加载。内置插件在 `src/plugins/` 经 `import.meta.glob` 编译期加载。

### 5.2 插件能引用什么

插件只从两个发布面引用类型和 API：
- `@pi-desktop/contract`（`packages/contract/src/index.ts`）：纯类型 re-export——`PluginManifest`、`PluginContributes`、`SlotName`、`PluginContext`、`SessionInfo` 等圆心定义的全部类型。不含任何实现代码。
- `@pi-desktop/react`（`packages/react/src/index.ts`）：React 组件 + hooks + `usePluginContext` + `PluginIdContext` + eventBus + stores 的 re-export。含实现——`usePluginContext()` 函数本身在此。

插件不准 import `src/` 内部实现（如 `@/core/...`、`@/client/...`、`@/api/...`）。ESLint 强制执行。

### 5.3 插件 manifest 发现时的物理目录

三个接入点之一——`plugin.json`——在发现阶段（`src/core/application/loader/discover.ts`）被扫描。扫描逻辑：从四个目录递归下降（最多 3 层），目录含 `plugin.json` 且 manifest 有 `id` 字段即为插件，不再深入子目录；否则继续向下找。这个逻辑同时兼容内置仓库的按域分组（`sessions/`、`project/` 等）和第三方目录的平铺——递归对平铺是退化的（第一层即命中）。

---

## 6 隔离原则

`docs/design/plugin-isolation-principles.md` 定义了插件隔离的三条原则。这里从"主体与插件怎么接在一起"的视角做对照说明。

### 6.1 硬编码的三种形态

**plugin ID 字面量**：15 个插件曾写 `const PLUGIN_ID = "blind-review"`。解法：`PluginIdContext`（`packages/react/src/plugin-id-context.ts`）——shell 渲染插件时用 Context Provider 注入 pluginId，`usePluginContext()` 内部从 Context 读取，插件不写 ID 常量。

**component 注册名**：22 处 `registerXxxComponent("Name", Comp)` 调用，manifest 里 `"component": "Name"` 和代码里的 `"Name"` 是手写两遍。解法：`packages/react/src/index.ts` 的 `registerPluginComponents()`（第 396-413 行）——框架读 manifest 后自动在 module exports 里匹配，插件只 export 不调 register。

**配置路径**：timeline 曾直写 `window.pi.configFile.get("~/.pi-desktop/config/general.json")`——这是 general-config 插件的配置文件。解法：插件通过事件暴露配置状态（`ctx.events.emit`），消费方通过事件订阅（`ctx.events.on` + `dependsOn` 声明）。路径不再出现在消费方代码里。

### 6.2 隐式耦合的两种形态

**共享 store 互读写**：timeline 曾调 `useUiStore().requestBookmark()` 写请求，session-bookmarks 从 `useUiStore().bookmarkRequest` 读——两个插件通过全局 store 做隐式握手，没有依赖声明。解法：timeline `ctx.events.emit("timeline:bookmarkRequested", payload)`，session-bookmarks 声明 `dependsOn: ["timeline"]` 并 `ctx.events.on("timeline:bookmarkRequested", handler)`。manifest 里显式声明依赖，payload 形状由发布方定义。

**直接 `window.pi.*` 绕过 Context**：6 个插件共 26 处直接调 `window.pi.*`，绕过 pluginId 绑定和权限封装。解法：全部迁到 `ctx.*`——sessions 能力走 `ctx.sessions.*`，配置读写走 `ctx.config.get/set/all`，事件通知走 `ctx.events.on("system:settingsChanged")`。`usePiApi()` 已废弃删除；`window.pi.*` 直访在 `src/plugins/` 下被 ESLint 零容忍拦截（唯一例外是 `packages/react/src/plugin-context.ts` 和 `src/shell/` 目录，它们是框架代码自身）。

### 6.3 三层校验

- **编译期（lint）**：ESLint `no-restricted-syntax` 拦截 `window.pi` 直访、`PLUGIN_ID` 常量、`usePiApi` 调用、`registerXxxComponent` 调用、模块顶层 `ctx.events.emit/on`。在 `src/plugins/` 目录下零容忍。
- **加载期（manifest 校验）**：dependsOn 拓扑校验（依赖不存在/被禁用/有环 → 报错）、component 名与 export 自动匹配（找不到 → 报错）、channels 自动读取注册。
- **运行期（emit/on 校验）**：emit 校验 channel 在自己的 channels export 里声明过、on 校验 channel 来自已加载插件或 system:*、卸载时自动注销 channel 并清除 replayLast 缓存。

---

## 7 QA

**Q：加载器怎么区分内置插件和第三方插件？**
不区分。`discoverPlugins()`（`src/core/application/loader/discover.ts`）对四个目录走同一套递归下降逻辑，唯一区别是调用方传入的 `source` 参数，它只影响注册顺序。注册表 `registerOne()` 也不知道"这是内置件"——它只按调用顺序注册，内置件最先注册所以优先级最低。这就是"无特权差异"的机制保证。

**Q：插件发现时 locale 资源文件（`i18n/locales/zh-CN/plugin.json`）为什么不会被误认成插件？**
因为 `discoverPlugins()` 在读到 `plugin.json` 后检查 `manifest.id` 是否为非空字符串——locale 资源文件没有 `id` 字段，被形态校验自然滤掉（`discover.ts` 第 50 行）。不被认作插件，也不深入其子目录。

**Q：`packages/react` 的 `registerPluginComponents()` 和 `registerPluginMessageRenderers()` 为什么是分开的两个函数？**
因为 messageRenderers 的注册表结构不同——它是按 role 字符串索引的 `Map<string, ComponentType>`，不是按组件名字符串。两者在加载流程中被 `plugins-host.ts` 分别调用。

**Q：插件 A 订阅了插件 B 的事件，运行中 B 被用户禁用了，A 的订阅怎么处理？**
`canDeactivate()`（`src/core/application/lifecycle/index.ts` 第 32-37 行）做反向依赖检查——发现 A 声明了 `dependsOn: ["B"]`，返回 `{ ok: false, blockedBy: ["A"] }`，阻止卸载。用户必须先禁用 A 再禁用 B。dependsOn 是强约束，不允许"我还在用你你就被拆了"。

**Q：`ctx.events.invoke` 和 `ctx.events.emit` 什么区别？**
`emit`：发布/订阅，只能发自己声明过的 channel，payload 被缓存供 `replayLast` 回放——适合可回放的状态广播（`packages/react/src/event-bus.ts` 第 88-105 行）。`invoke`：定向分派，调别的插件拥有的 channel，调用方不需要权属，不做回放——适合一次性命令（第 110-128 行）。无订阅者时入队等首个订阅者冲刷。fileActions 的 `<pluginId>:fileActionInvoke` 约定频道是 invoke 的既有先例。
