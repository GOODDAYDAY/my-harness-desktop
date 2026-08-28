# 如何新建一个插件

这是一份照着做的实操文档：从零建一个 my-harness-desktop 壳插件，覆盖 i18n 语言包、renderer 壳插件、pi 内核扩展、dsh 内核扩展四件套。每个论断都落到具体文件、函数、类型名，代码块用真实 API 签名。写之前建议先打开两个参考插件对照看：`src/plugins/sessions/goal/`（四件套全齐）和 `src/plugins/insight/llm-recorder/`（renderer + pi-extension + locales 三件）。

---

## 1 先建立心智模型

一个插件就是 `src/plugins/{domain}/{feature}/` 下一个目录，里面有一个 `plugin.json` 声明「我是谁、挂哪些槽位、带哪些内核扩展」。壳的发现器扫到这个 `plugin.json` 就把它当插件收进注册表。目录结构本身是第一道防线，分四件：

```
src/plugins/{domain}/{feature}/
  plugin.json        # 声明：id / renderer 入口 / 槽位贡献 / 权限 / 内核扩展路径
  locales/           # i18n 文案（desktop UI 文案，纯 JSON）
  renderer/          # 壳插件本体：React 组件 + channels + 事件（经 usePluginContext）
  pi-extension/      # pi 内核插件：给 pi 补能力的 TS 扩展（装进 pi 进程）
  dsh-extension/     # dsh 内核插件：给 dsh 补能力的 Cordis 插件（index.mjs + extension.json）
```

四件套是「按需」的，不是「必须」的：`llm-recorder` 没有 `dsh-extension/`，`goal` 没有 `locales/`（它的文案直接写死在 renderer，属于反例，别学）。一个功能如果两个内核都要，就 pi-extension 和 dsh-extension 都写；只给一个内核补能力就只写那个。

**依赖只向内，这是硬纪律。** 壳插件（`renderer/`）只允许 import 两个包：

```ts
import { ... } from "@my-harness-desktop/shared";   // 圆心契约（类型 + 纯函数）
import { ... } from "@my-harness-desktop/react";    // 发布面（hooks + 组件 + 事件总线）
```

`renderer/` 里出现 `@/server/...`、`@/core/...`、`@/client/...`、`electron`、`better-sqlite3` 都是违规——壳插件不碰壳后端、不碰内核实现。pi-extension 和 dsh-extension 是两个例外：它们各自跑在内核进程里，但**不 import 内核的官方包**（内核 node_modules 里的类型仓库 tsconfig 够不到），而是手写用到的窄结构，只依赖内核注入的 API 面。

一个壳插件接入的触点只有三个：`plugin.json`（声明）、`renderer/index.tsx`（export 组件 + channels + 调 `usePluginContext()`）、PluginContext（拿能力 + 事件）。下面逐段展开。

---

## 2 plugin.json 逐字段

`plugin.json` 是插件唯一的声明文件。它的类型是 `PluginManifest`，定义在 `packages/shared/src/domain/contributions.ts` 第 484 行。加载器发现它、注册表按它填充、生命周期按它驱动。逐字段说明：

```jsonc
{
  "id": "todo",                 // 必填。插件唯一标识，也是 configFile 的文件名、内核扩展目录名。
                                 // 只允许字母/数字/连字符/下划线/点（PLUGIN_ID_RE，见 config-store.ts:24）。
  "version": "0.1.0",           // 必填。semver 字符串。
  "tier": "official",           // 信任级别：official / verified / community。未声明时由 source 推断。
  "displayName": "待办",        // 展示名。用户可见，但正式做法是走 i18n（见 §5），此处可先占位。
  "description": "...",         // 一句话描述。
  "tags": ["session"],          // 分类 tag。最终 tags = 框架推导 ∪ 声明（resolvePluginTags）。
  "renderer": "./renderer/index.tsx",  // 壳插件入口，相对插件目录。框架按它加载 React 模块。
  "piExtension": "./pi-extension",     // 可选。pi 内核扩展目录（相对路径）。
  "dshExtension": "./dsh-extension",   // 可选。dsh 内核扩展目录（相对路径）。
  "permissions": ["fs:project"],       // 可选。声明式能力清单（见 §9）。
  "dependsOn": ["timeline"],           // 可选。生命周期护栏：消费别的插件 channel 时声明。
  "protected": false,                  // 可选。true = 不可卸载（可禁用不可移除）。
  "contributes": { ... }               // 可选。槽位贡献（见 §8）。
}
```

字段逐个说清楚：

**`id`**。全仓唯一。它是框架推导一切路径的根：配置文件写 `<cwd>/.my-harness-desktop/config/{id}.json`（`config-store.ts` 的 `ConfigStore`），pi 扩展同步到 `~/.pi/agent/extensions/{id}/`（`pi-extension-installer.ts` 的 `targetDir`），dsh 扩展同步到 `~/.dsh/.my-harness-desktop-plugins/{id}/`（`dsh-extension-installer.ts` 的 `targetDir`）。`ConfigStore.assertValidPluginId` 用正则 `^[A-Za-z0-9][A-Za-z0-9._-]*$` 白名单校验，且拒绝 `..`——防路径逃逸。id 里不要带中文、空格、斜杠。

**`version`**。semver。目前只在管理页展示，没有版本比较逻辑——但它是 `PluginManifest` 的必填字段，少了会类型报错。

**`tier`**。类型是 `PluginTier = "official" | "verified" | "community"`（`contributions.ts:523`）。声明在 manifest 里；未声明时加载器按 source 推断。这是元数据，不影响权限、不影响加载。

**`displayName` / `description`**。公共元数据。注意：这两个字段在 `plugin.json` 里写死的是「默认值」，正式做法是贡献 `languages` 槽，用 `plugin.{id}.displayName` / `plugin.{id}.description` 两个 key 提供多语言文案（llm-recorder 就是这么做的，见 `locales/zh-CN/plugin.json`）。管理页优先读 i18n，缺失回退 manifest 的原始值。

**`tags`**。类型是 `string[]`。最终 tags 由 `resolvePluginTags`（`contributions.ts:563`）计算：先 `derivePluginTags` 从槽位推导（themes→`theme`、languages→`i18n`、settings/settingsGroups→`management`），再并上 manifest 声明，去重保序。无语义槽（sidePanel/mainView 等）不推导，需要显式声明。推荐词表见 `RECOMMENDED_PLUGIN_TAGS`。

**`renderer`**。壳插件入口路径，相对插件目录。内置插件的 renderer 由 `src/web/app/plugins-host.ts:4` 的 `import.meta.glob("../../plugins/*/*/renderer/index.{ts,tsx}")` 在构建期静态打包；第三方插件的 renderer 由 `loadThirdParty`（`plugins-host.ts:56`）动态 `import("file://...")`。`renderer` 字段的值必须指向那个导出组件/channels 的模块（见 §4）。

**`piExtension`**。声明了它，`lifecycle/index.ts:102` 的 `activate` 才会调 `piExtensionEnsure.onActivate`，把 `<pluginPath>/<piExtension>/` 同步进 `~/.pi/agent/extensions/<id>/`。值是相对插件目录的路径（如 `"./pi-extension"`），不带尾斜杠。不声明就不触发，目录存不存在都不影响插件本体加载。

**`dshExtension`**。与 piExtension 对称，`lifecycle/index.ts:105` 的 `activate` 调 `dshExtensionEnsure.onActivate`，同步到 `~/.dsh/.my-harness-desktop-plugins/<id>/` 并挂 cordis.yml 块。

**`permissions`**。字符串数组。声明式能力清单，壳后端网关（`src/server/controllers/`）在每个受控 IPC 入口调 `registry.assertPermission(pluginId, permission)` 校验。已实现的权限字符串只有六个：`fs:project`、`git:read`、`git:write`、`llm:oneshot`、`sessions:bus`、`rpc:bash`（见 §9 详述）。核心能力（config/prefs/sessions/i18n 等）不需要声明。

**`dependsOn`**。数组，填别的插件 id。它是**生命周期护栏，不是加载顺序控制**：`checkDependents`（`lifecycle/index.ts:21`）在 `canDeactivate` 时检查「有没有别的插件依赖我」，有则禁止卸载/禁用。它不保证加载顺序——如果你 `on` 或 `invoke` 别人的 channel，就声明 dependsOn，让卸载顺序正确、让管理页提示依赖关系。

**`protected`**。布尔。`canUninstall`（`lifecycle/index.ts:15`）读它：true 则不可卸载（管理页隐藏卸载按钮），但仍可禁用。这是声明式，不是硬编码插件 id——壳不识别「哪些是内置插件」，只认这个字段。

**`tokenSchemaVersion`**。仅贡献 `themes` 槽的插件需要。semver 范围（如 `"^1.0"`）。`registry.ts:42` 的 `isTokenSchemaCompatible` 在注册 themes 前用 `satisfies` 判定它与 `THEME_TOKEN_SCHEMA_VERSION` 兼容，不兼容则跳过该插件 themes 注册并告警。未声明视为兼容。不写主题就忽略。

**`contributes`**。槽位贡献对象，类型 `PluginContributes`（`contributions.ts:407`），每个键是一个贡献项数组。这是插件的「挂什么」声明，见 §8。

**`source`**。**不在 manifest 里声明**。它由 `discoverPlugins`（`discover.ts:30`）按插件所在目录归属判定：`project` > `user` > `installed` > `builtin` 四级。你在 `plugin.json` 里写 source 会被忽略，它是加载器「发现时填」的标记。

**`main`**。`PluginManifest` 里有这个字段（历史遗留），但当前 `src/server` 和 `src/web` 没有任何代码消费它——加载只认 `renderer`。新插件不要写它。

---

## 3 目录四件套

一个功能一个插件目录，内部四件套按需建。参考两个真实样例：

`src/plugins/sessions/goal/`（四件套全齐）：

```
goal/
  plugin.json            # 声明 renderer + piExtension + dshExtension + blockRenderers/composerTop
  core/                  # 纯函数状态机（goal-state / goal-command / goal-reduce），renderer 内部 import
  renderer/
    index.tsx            # export GoalCard / GoalBar + channels + composerCommands
    goal-bar.tsx         # composerTop 槽组件
    goal-card.tsx        # blockRenderers 槽组件
    goal-controller.ts   # 续跑引擎 hook（useGoalController）
    goal-reduce.ts       # 纯函数归约
  pi-extension/
    index.ts             # pi 内核扩展：set_goal / achieve_goal 两个工具
  dsh-extension/
    index.mjs            # dsh Cordis 插件：同名两个工具
    extension.json       # dsh 扩展展示元数据
```

`src/plugins/insight/llm-recorder/`（renderer + pi-extension + locales，无 dsh-extension）：

```
llm-recorder/
  plugin.json            # 声明 renderer + piExtension + permissions:["fs:project"] + sidePanel/settings/languages
  core/                  # 纯函数（log-model / payload-model）
  renderer/
    index.tsx            # export RecordsTab / RecorderSettings
    payload-views.tsx
    record-modal.tsx
  pi-extension/
    index.ts             # pi 内核扩展：before_provider_request 等事件钩子落盘 JSONL
  locales/
    zh-CN/{panel,settings,plugin}.json
    zh-TW/...
    en/...
    de/...
```

两个样例揭示的关键结构事实：

1. **`core/` 是可选的自留地**。它放纯函数（状态机、解析、归约），供 renderer 内部 import。它不是壳的机制层——壳插件里的 `core/` 和壳的 `src/server/` 没有任何关系。goal 把状态机放 `core/goal-state.ts`，renderer 的 `goal-controller.ts` import 它，纯粹是「把纯逻辑从 React 组件里拆出去」的工程习惯。

2. **发现器按 `plugin.json` 定位插件**。`discoverPlugins`（`discover.ts:30`）递归下降，最大深度 3，遇到含合法 `plugin.json`（`id` 是非空字符串）的目录就收为插件、不再深入；否则继续向下找。所以 `locales/zh-CN/plugin.json`（语言资源，无 `id` 字段）会被形态校验自然滤掉——它和真正的插件 manifest 同名但形状不同，不冲突。

3. **内置插件的目录深度是两层**：`{domain}/{feature}/`。`plugins-host.ts:23` 的正则 `plugins\/(?:[^/]+\/)*([^/]+)\/renderer` 抓 renderer 的直接上级目录名当插件 id，并强制它与 `manifest.id` 一致。所以「目录名 = plugin.json 的 id = renderer 的上级目录名」三者必须一致。

4. **pi-extension 的入口是 `.ts` 或 `.js`，dsh-extension 的入口是 `.mjs`**。`findExtensionEntry`（`src/server/kernel/core/kernel-extension.ts`）按扩展名清单找入口文件，pi 侧传 `[".ts", ".js"]`，dsh 侧传 `[".mjs"]`。文件名不固定，只要扩展名对。

---

## 4 renderer/index.tsx

`renderer/index.tsx` 是壳插件的「门面」。它做三件事：**export 组件**（供框架自动匹配）、**export channels**（供事件总线注册）、**在组件里用 `usePluginContext()`**（拿受控 API）。先看真实样例——`src/plugins/sessions/goal/renderer/index.tsx` 全文：

```tsx
// goal 插件 renderer 入口 —— manifest component 名与 export 一一对应（框架自动匹配）。
export { GoalCard } from "./goal-card";
export { GoalBar } from "./goal-bar";

// goal:state —— 目标状态广播：payload { active: boolean }。
export const channels = ["goal:state"] as const;

// 用户斜杠命令：/goal 由人在输入框敲，发送前被拦到本插件处理。
import type { ComposerCommand } from "@my-harness-desktop/shared";
import { GOAL_COMMAND_NAME } from "../core/goal-state";
import { runGoalCommand } from "./goal-controller";

export const composerCommands: ComposerCommand[] = [
  {
    name: GOAL_COMMAND_NAME,
    description: "设置/管理本会话目标(自动续跑)。/goal <目标> 设置;stop·resume·edit·clear 控制",
    handle: (input) => runGoalCommand(input),
  },
];
```

### 4.1 export 组件：框架自动匹配，插件不调 register

这是最关键的一条纪律：**壳插件不手动调 `registerXxxComponent("Name", Comp)`**。框架（`src/web/app/plugins-host.ts` 的 `loadBuiltin`/`loadThirdParty`）加载 renderer module 后，读 `manifest.contributes.*[].component` 字段，在 module 的 exports 里找同名组件，自动注册到 `packages/react/src/plugin-modules.ts` 的注册表。具体实现分两类：

- **槽位组件**（settings/sidePanel/sidebar/mainView/titlebar）走 `registerPluginComponents`（`packages/react/src/index.ts:510`），按 `componentRegistries` 五张 Map 存：settings→`settingsComponents`、sidePanel→`sidePanelComponents` 等。
- **其余槽位组件**（messageRenderers/blockRenderers/codeBlockRenderers/messageActions/composer* 等）走 `getPluginComponent(pluginId, name)`（`plugin-modules.ts:31`）从 `pluginModules` Map 里按名查 export，`asReactComponent` 判「函数组件或带 `$$typeof` 的 exotic 组件（memo/forwardRef/lazy）」。

所以你的组件**必须在 `index.tsx`（或它 re-export 的模块）里被 `export`，且 export 名 = plugin.json 里的 `component` 名**。goal 的 `plugin.json` 声明 `"component": "GoalCard"` 和 `"component": "GoalBar"`，index.tsx 就 `export { GoalCard }`、`export { GoalBar }`。对不上就是「组件未注册」孤儿 Tab。

各组件的 props 契约（由框架在渲染时注入）：

| 槽位 | 组件 props | 来源 |
|---|---|---|
| `settings` | `SettingsComponentProps { refreshSignal: number; config: Record<string, unknown> \| null; dirty?: boolean; onChange: (config) => void }` | `packages/react/src/index.ts:403` |
| `sidePanel` | `{ isActive: boolean }` | `sidePanelComponents` Map 类型（`index.ts:455`） |
| `sidebar` / `mainView` / `titlebar` | 无 props | `index.ts:456-458` |
| `messageRenderers` | `MessageRendererProps { message: NeutralMessage; streaming: boolean }` | `index.ts:411` |
| `blockRenderers`（toolCall 块） | 块类型对应标准 props，如 goal 的 `GoalCard` 收 `{ toolCall: ToolCallBlock; collapseDefault?: boolean }` | `goal-card.tsx:8` |

`isActive` 是框架传的「本 Tab 是否激活」，用于惰性加载（llm-recorder 的 `RecordsTab` 用 `isActiveRef` 守卫，面板不活跃时收到事件也不读文件）。`SettingsComponentProps.onChange` 是「报告改动」的唯一入口——框架据它设 dirty、弹保存浮层、写回 configFile（§9.2）。

### 4.2 export channels：事件总线的注册声明

`export const channels = ["goal:state"] as const;` 这一行是**代码级声明**。`plugins-host.ts:35` 读 `mod.channels`，调 `eventBus.registerChannels(pluginId, channels, meta)` 注册。事件总线实现在 `packages/react/src/event-bus.ts`：

- **`registerChannels(pluginId, channels, meta?)`**（`event-bus.ts:55`）：把 channel 记到 `pluginChannels`（插件 → channel 集合）和 `channels`（channel → ChannelState）。可选第三参 `channelMeta`，来自 module 的可选导出 `export const channelMeta = { "goal:state": { ... } }`，给快捷键/命令面板提供可读描述。
- **`emit(pluginId, channel, payload)`**（`event-bus.ts:112`）：发布/订阅。硬校验：`system:` 前缀频道插件无权 emit；channel 必须在本插件的 `channels` 声明里（`isChannelOwnedBy`），否则抛错。payload 缓存在 `state.lastPayload`，供新订阅者 `replayLast` 回放。适合**可回放的状态广播**。
- **`on(channel, handler, opts?)`**（`event-bus.ts:171`）：订阅。返回反注册函数（`() => state.handlers.delete(handler)`）。`opts.replayLast` 为 true 时，注册当刻立即用最近一次 payload 调一次 handler。还会冲刷该 channel 的 invoke 待发队列（恰好一次投递）。
- **`invoke(callerId, channel, payload)`**（`event-bus.ts:134`）：定向分派。**调用方不需要拥有 channel**，这是「框架约定的调用通道」（fileActions、messageActions 点击后路由）用的原语。无订阅者时入队 `pendingInvokes`，首个订阅者 attach 时恰好一次投递，**不做回放**。适合一次性命令。

`emit` 和 `invoke` 是两种原语，别混用：状态广播用 emit（可回放），一次性命令用 invoke（恰好一次）。在 `usePluginContext()` 里，它们暴露为 `ctx.events.emit/on/invoke`（`plugin-context.ts:165-169`），emit 和 invoke 的 pluginId 由 `usePluginId()` 自动注入，插件不手写。

插件之间通信**只走事件**，不共享 store 互读写。A 要 B 的数据：B `emit` 一个自己声明的 channel，A 在 manifest 里 `dependsOn: ["B"]` 然后 `ctx.events.on` 订阅。框架系统事件用 `system:` 前缀（已实现：`system:configFileSaved`、`system:settingsChanged`、`system:layoutChanged`、`system:systemThemeChanged`、`system:refreshRequested`、`system:requestNavigateToChat`），插件订阅它们不需要 dependsOn。

### 4.3 用 usePluginContext() 拿能力

`usePluginContext()`（`packages/react/src/plugin-context.ts:22`）是壳插件代码能拿到的**唯一** API 对象。它先 `usePluginId()` 从 `PluginIdContext`（`plugin-id-context.ts`）读当前插件 id——这个 id 是框架在渲染插件组件树时注入的，插件**绝不手写**。返回对象按三层分组（完整契约在 `packages/shared/src/domain/context.ts:278` 的 `PluginContext`）：

**pluginId 绑定层**（框架按插件 id 绑定，插件不感知路径/身份）：

```ts
const ctx = usePluginContext();
ctx.config.get<boolean>("recordEnabled");       // 读配置（项目级覆盖全局层）
ctx.config.set("recordEnabled", true);          // 写配置（默认项目级）
ctx.config.all();                                // 读整个合并快照
ctx.fs.readFile(path);                           // 需 fs:project 权限
ctx.git.status(cwd);                             // 需 git:read
ctx.gitWrite.commit(cwd, msg, files);            // 需 git:write
ctx.llm.oneshot(prompt);                         // 需 llm:oneshot
ctx.bus.send(to, kind, payload, replyTo);        // 需 sessions:bus
```

**系统级 API 层**（核心默认，不需声明）：

```ts
ctx.sessions.onEvent((e) => { ... });   // 订阅中性会话事件（SessionEvent）
ctx.messaging.prompt(text);             // 发消息（= 发送按钮同源）
ctx.messaging.abort();                  // 中断
ctx.messaging.continue();               // 续跑
ctx.models.getModels();                 // 模型清单
ctx.models.setModel(provider, modelId, kernel);
ctx.tree.fork(parentLineageId, boundary);
ctx.i18n.t("panel.empty");              // 同步查字典
ctx.i18n.locale;                        // 当前语言 zh-CN/zh-TW/en/de
ctx.prefs.get("key");                   // 全局偏好
ctx.themes.list();                      // 主题清单
ctx.kernels.pi.status();                // 内核版本管理（按 KernelId 键控）
ctx.kernelModels.pi.readConfig();       // 中性内核模型配置
ctx.notify.show({ title, body });       // OS 通知
ctx.dialog.openDirectory();             // 文件对话框（用户手势驱动）
```

**事件层**：

```ts
ctx.events.emit("goal:state", { active: true });  // 只能 emit 自己声明的 channel
ctx.events.on("goal:state", (p) => {}, { replayLast: true });  // 返回反注册函数
ctx.events.invoke("别的插件:channel", payload);   // 定向分派，不需权属
```

**pi 扩展面**（`ctx.pi`，pi 专属能力，dsh 下入口隐藏/置灰）：`steer`、`followUp`、`cycleModel`、`getThinkingLevels`、`cycleThinkingLevel`、`compact`、`exportHtml` 等。这些是 pi 的扩展面，`PluginContext.pi` 上永远存在，但调用前要按能力探测「有则用、无则降级」——不要按内核身份硬分支。

**共享 store 只读**：`useUiStore` / `useSessionStore`（从 `@my-harness-desktop/react` re-export）可以读，不能调 setter。改变框架状态走 ctx API。goal 的 `goal-controller.ts` 读 `useUiStore.getState().pendingQueue` 判断「用户插队」，但发消息走 `messaging.prompt`，不改 store。

**dispose 纪律**：`ctx.sessions.onEvent`、`ctx.events.on` 都返回反注册函数。组件卸载时必须返回它（`useEffect` 的 cleanup），否则监听器泄漏。goal 的 `goal-controller.ts:105` 是范本：`useEffect(() => { return sessions.onEvent((event) => { ... }); }, [deps])`——直接 `return` 反注册函数，React 卸载时自动调。

---

## 5 locales 语言包

文案是「会变的内容」，按薄壳纪律全部外挂成 i18n 贡献。`locales/` 是纯 JSON，每个文件一个扁平 key→文案映射。llm-recorder 的结构：

```
locales/
  zh-CN/
    panel.json       # 面板文案（namespace = panel）
    settings.json    # 设置页文案（namespace = settings）
    plugin.json      # 插件展示名/描述（namespace = plugin）
  zh-TW/  en/  de/   # 同结构
```

每个文件的内容是扁平 key，**第一个 `.` 前是 namespace**（`merge.ts:91` 的 dot 解析）。`panel.json`：

```json
{
  "panel.noSession": "先打开一个会话，才能看它的请求记录",
  "panel.empty": "这个会话还没有请求记录",
  "panel.turn": "轮 {{n}}"
}
```

`panel.turn` 的 key 拆出 namespace=`panel`，剩下的 `turn` 落到该 ns 下，代码里 `t("panel.turn", { n: 3 })` 取。`{{n}}` 是 i18next 的插值。

**这些 JSON 文件怎么被声明？** 在 `plugin.json` 的 `contributes.languages` 里逐条声明，类型 `LanguageContribution`（`contributions.ts:130`）：

```json
"contributes": {
  "languages": [
    { "id": "llm-recorder.panel", "locale": "zh-CN", "resources": "./locales/zh-CN/panel.json" },
    { "id": "llm-recorder.panel", "locale": "zh-TW", "resources": "./locales/zh-TW/panel.json" },
    { "id": "llm-recorder.settings", "locale": "zh-CN", "resources": "./locales/zh-CN/settings.json" },
    { "id": "llm-recorder.plugin", "locale": "zh-CN", "resources": "./locales/zh-CN/plugin.json" }
  ]
}
```

三个字段：`id` 通常 `{pluginId}` 或 `{pluginId}.{namespace}`（`(插件, locale)` 维度唯一）；`locale` 是 BCP 47 区域码（`zh-CN`/`zh-TW`/`en`/`de`）；`resources` 是**相对插件目录的 JSON 文件路径**（字符串）或**内联对象**（`Record<string, string>`，很少用）。

**合并规则**在 `src/server/application/i18n/merge.ts` 的 `mergeLanguageContributions`（第 77 行）：key 级 union——不冲突 key 全保留，冲突 key 按 `SOURCE_PRIORITY`（`merge.ts:21`，`builtin:1 < installed:2 < user:3 < project:4`）高值胜，同优先级先处理者胜。`resolveLanguageResources`（`merge.ts:46`）把字符串路径解析成对象（文件不存在/JSON 错/顶层非对象则记 error 返回 null，跳过该贡献项）。dot 拆 namespace，剩余点号再拆成嵌套对象（`collectNamespaces` 动态收集 ns，不硬编码）。

**为什么 `plugin.json` 里那两条 `displayName`/`description` 还不算「写死文案」？** 因为那是兜底默认值。正规做法是贡献 `languages` 里的 `plugin.{id}.displayName` / `plugin.{id}.description` 两个 key（llm-recorder 的 `plugin.json` 语言文件里就有 `"plugin.llm-recorder.displayName": "LLM 请求记录"`），管理页优先读 i18n。你自己的 renderer 组件里的用户可见文案，**必须**走 `t("key")`，不许写死中文字面量。

---

## 6 pi-extension 写法

`pi-extension/` 给 pi 内核补能力——pi 侧是「装进进程的 TypeScript 扩展」。它跑在 pi 进程里，**不 import 官方 pi 包**（内核 node_modules 里的类型仓库 tsconfig 够不到），手写用到的窄结构，只依赖 pi 注入的 API 面。看两个真实样例：`goal`（注册工具）和 `llm-recorder`（订阅事件钩子）。

### 6.1 注册工具：goal 的 pi-extension/index.ts

```ts
// 本目录由 piExtensionEnsure 随插件启停同步到 ~/.pi/agent/extensions/goal/。
// 不 import 官方 pi 包——手写窄结构。

interface GoalToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

interface GoalToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: unknown,
    onUpdate: unknown,
    ctx: unknown,
  ): Promise<GoalToolResult>;
}

interface GoalApi {
  registerTool(tool: GoalToolDefinition): void;
}

export default function goal(pi: GoalApi): void {
  pi.registerTool({
    name: "set_goal",
    label: "Set Goal",
    description: "Set the current long-running completion objective...",
    parameters: {
      type: "object",
      properties: {
        objective: { type: "string", description: "..." },
        max_rounds: { type: "number", description: "..." },
      },
      required: ["objective"],
      additionalProperties: false,
    },
    async execute(_id, params) {
      const objective = typeof params.objective === "string" && params.objective.trim().length > 0
        ? params.objective.trim() : "";
      if (objective === "") {
        return { content: [{ type: "text", text: "set_goal failed: objective must be a non-empty string" }], isError: true };
      }
      return { content: [{ type: "text", text: JSON.stringify({ goal: { objective } }) }] };
    },
  });
}
```

要点：

1. **入口是 `export default function(pi)`**。pi 进程加载扩展时调这个默认导出，把 `pi` API 注入。goal 里 `pi.registerTool(...)` 注册工具；llm-recorder 里 `pi.on("before_provider_request", handler)` 订阅事件钩子。

2. **类型是手写窄结构**。`GoalApi`、`GoalToolDefinition`、`RecorderApi` 都是自己 interface，不 import 官方包。工具定义的核心字段：`name`（工具名，小写，这是 blockRenderers 槽里 `names` 比对的键）、`label`、`description`（模型读的）、`parameters`（JSON Schema）、`execute`。

3. **工具退化为薄标记，状态不落盘、不维护**。goal 的设计（`docs/design/kernel-agnostic-goal.md`）：`set_goal`/`achieve_goal` 只返回一个确认文本，真正的目标状态机 + 续跑引擎全在壳插件侧（`goal-controller.ts`）经中性事件（`toolCallStart`）捕获驱动。这是「壳 vs 内核」分界的样板：**工具是内核注册的（壳注入不了），但状态和续跑是功能，归壳插件**。

4. **异常静默吞掉，不带走会话**。llm-recorder 的每个 `pi.on` 回调里都是 `try { ... } catch { /* 记录失败不影响会话 */ }`——内核扩展炸了不能带走用户会话。

### 6.2 订阅事件钩子：llm-recorder 的 RecorderApi

```ts
export interface RecorderApi {
  on(event: "before_provider_request", handler: (event: BeforeRequestEvent, ctx: RecorderContext) => unknown): void;
  on(event: "after_provider_response", handler: (event: AfterResponseEvent, ctx: RecorderContext) => unknown): void;
  on(event: "message_end", handler: (event: MessageEndEvent, ctx: RecorderContext) => unknown): void;
  on(event: "turn_start", handler: (event: TurnStartEvent, ctx: RecorderContext) => unknown): void;
  on(event: "compaction_start" | "compaction_end", handler: (event: unknown, ctx: RecorderContext) => unknown): void;
}

export default function llmRecorder(pi: RecorderApi): void {
  let seq = 0;
  pi.on("before_provider_request", (event, ctx) => {
    try {
      // ctx.sessionManager.getSessionFile() 拿当前会话文件路径，落盘 JSONL
    } catch { /* ignore */ }
  });
  // ...
}
```

`ctx` 是 pi 注入的上下文（`RecorderContext { sessionManager: { getSessionFile() } }`），扩展用它拿会话级信息。llm-recorder 在 `before_provider_request` 记 request 行、`after_provider_response` 挂 status、`message_end` 出栈写 response 行，配对落 JSONL 到 `<cwd>/.my-harness-desktop/llm-logs/`——这是「壳插件需要的能力，pi 内核没有，就写 pi 扩展补」的典型。

### 6.3 同步机制（piExtension 怎么进内核）

声明了 `piExtension` 后，`lifecycle/index.ts:102` 的 `activate` 调 `piExtensionEnsure.onActivate`，最终落到 `src/server/kernel/pi/extension/pi-extension-installer.ts` 的 `syncPluginPiExtension`（第 64 行）：

1. `findExtensionEntry(sourceDir, [".ts", ".js"])` 找入口文件（`.ts`/`.js`，没有则跳过同步告警）。
2. 目标 `~/.pi/agent/extensions/<pluginId>/` 若已存在但无 `.my-harness-desktop-plugin` 标记文件 → 是用户手装的同名扩展，跳过不覆盖。
3. 目录内容签名相同（`dirSignature`）→ 已同步，跳过。
4. 否则 `rmSync` + `cpSync` 整个目录，`patchPackageJson` 把 `package.json` 的 `pi.extensions` 修正为 `["./<entry>"]`（**壳声明入口，内核不再自扫**），写标记文件 `.my-harness-desktop-plugin`（内容 = pluginId）。

deactivate 时 `removePluginPiExtension`（第 102 行）只删带标记的目录。启动时 `reconcilePluginPiExtensions`（第 117 行）扫 `EXT_ROOT`，带标记但不在 active 集合里的孤儿目录摘除。**任何异常都不 crash**——同步失败只记日志，插件本体照常加载。

---

## 7 dsh-extension 写法

`dsh-extension/` 给 dsh 内核补能力——dsh 侧是 **Cordis 插件**，自描述结构：`index.mjs`（cordis 插件入口）+ `extension.json`（展示元数据）。看 `src/plugins/sessions/goal/dsh-extension/`：

### 7.1 index.mjs：Cordis 插件

```js
// 本目录由 dshExtensionEnsure 随插件启停同步到 ~/.dsh/.my-harness-desktop-plugins/goal/。
// 零 import dsh 内核包（与 pi 扩展同纪律）：只依赖 cordis 的 ctx.tools 注入面。
export const name = "desktop-goal";

// cordis 服务依赖声明：apply 里访问 ctx.tools 必须先在此注入，
// 否则插件树加载期抛 "cannot get property tools without inject" → 整个 dsh 内核崩溃。
export const inject = ["tools"];

export function apply(ctx) {
  ctx.tools.register({
    name: "set_goal",
    label: "Set Goal",
    description: "Set the current long-running completion objective...",
    parameters: {
      type: "object",
      properties: {
        objective: { type: "string", description: "..." },
        max_rounds: { type: "number", description: "..." },
      },
      required: ["objective"],
      additionalProperties: false,
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    async execute(args) {
      const objective = typeof args.objective === "string" && args.objective.trim().length > 0
        ? args.objective.trim() : "";
      if (objective === "") {
        return { error: "set_goal failed: objective must be a non-empty string" };
      }
      return { goal: { objective } };
    },
  });
}
```

要点：

1. **`export const name`**：cordis 插件名。
2. **`export const inject = ["tools"]`**：cordis 依赖注入声明。`apply` 里访问 `ctx.tools` 必须先在这里声明注入，否则加载期抛错、整个 dsh 内核崩溃。这是 cordis 的硬规矩。
3. **`export function apply(ctx)`**：cordis 装载入口。`ctx.tools.register({...})` 注册工具。工具字段与 pi 侧 `registerTool` 语义对齐：`name`/`label`/`description`/`parameters`/`execute`，多一个 `output`（dsh 侧渲染返回值的 schema + render）。
4. **薄标记纪律同 pi**：`set_goal`/`achieve_goal` 只返回确认，不落盘不维护状态，真正状态机在壳层。

### 7.2 extension.json：展示元数据

```json
{
  "displayName": "Goal (set_goal/achieve_goal)",
  "description": "内核无关的同会话持久目标的两个薄工具：设置目标 + 达成目标（续跑在壳层驱动）"
}
```

类型 `DshExtensionManifest`（`src/server/kernel/dsh/extension/dsh-extension-manifest.ts:10`）：`{ displayName: string; description?: string }`。缺 manifest 时拓展管理页回落 cordis id（剥 `my-harness-desktop-` 前缀），同步期 `warnMissingManifest`（`dsh-extension-installer.ts:76`）打告警提醒补齐。

### 7.3 同步机制（dshExtension 怎么进内核）

声明了 `dshExtension` 后，`lifecycle/index.ts:105` 调 `dshExtensionEnsure.onActivate`，落到 `src/server/kernel/dsh/extension/dsh-extension-installer.ts` 的 `syncPluginDshExtension`（第 134 行）：

1. `findExtensionEntry(sourceDir, [".mjs"])` 找 `.mjs` 入口。
2. 目标 `~/.dsh/.my-harness-desktop-plugins/<id>/` 带标记检查（同 pi）。
3. 目录签名比对，变了才 `rmSync`+`cpSync`，写 `.my-harness-desktop-plugin` 标记。
4. **`dshConfigSource.addPluginBlock(blockId, blockName)`** 挂 cordis.yml 块：块 id = `my-harness-desktop-<pluginId>`，name = `./.my-harness-desktop-plugins/<id>/<entryFile>`（相对 cordis.yml 目录解析）。幂等——同 id 存在则替换 name。

deactivate 时 `removePluginDshExtension` 摘 cordis 块 + 删带标记目录。启动时 `reconcilePluginDshExtensions` 摘孤儿。异常同样不 crash。

**pi 和 dsh 的对称**：同一能力在两个内核里的对称实现，字段名对齐（`name`/`description`/`parameters`/`execute`），但运行时 API 不同（pi 是 `registerTool` + 默认导出函数，dsh 是 cordis `apply(ctx)` + `inject`）。这正体现「多内核默认」——内核差异在适配层和内核插件层抹平，壳插件侧（renderer）完全不感知。

---

## 8 声明槽位贡献

`contributes` 是插件「挂什么」的声明。每个键是一个贡献项数组，类型在 `PluginContributes`（`contributions.ts:407`）。已实现贡献接口的槽位共 23 个，`SlotName` 联合（`contributions.ts:377`）里另有 `management`、`cardRenderers`、`viewers`、`commands` 四个预留名（尚无接口，别声明）。

goal 的 contributes 是最小但典型的样本：

```json
"contributes": {
  "blockRenderers": [
    { "id": "goal", "block": "toolCall", "names": ["set_goal", "achieve_goal"], "component": "GoalCard" }
  ],
  "composerTop": [
    { "id": "goal", "component": "GoalBar", "order": 40 }
  ]
}
```

llm-recorder 的 contributes 覆盖三类槽：

```json
"contributes": {
  "sidePanel": [
    { "id": "llm-records", "label": "请求记录", "icon": "scroll-text", "component": "RecordsTab", "order": 55 }
  ],
  "settings": [
    { "id": "llm-recorder", "title": "请求记录", "icon": "scroll-text", "component": "RecorderSettings", "saveMode": "manual", "order": 9 }
  ],
  "languages": [ ... ]
}
```

各槽位贡献项的关键字段（全部定义在 `contributions.ts`，逐个接口）：

- **`sidePanel`**（`SidePanelContribution`，第 81 行）：`id`/`label`（Tab 显示名，字段名是 label 不是 title）/`icon`（lucide 图标名）/`component`（renderer 组件名）/`order`（排序，小的在上，缺省 100）/`revealOn`（可选，声明后该 channel 被 emit/invoke 时框架展开右面板并激活本 Tab）。
- **`settings`**（`SettingsContribution`，第 9 行）：`id`/`title`/`icon`/`component`/`configFile`/`configMerge`/`saveMode`/`kernelModels`/`kernelConfig`/`order`/`tabs`。详见 §9。`component` 可省略（展示分组入口只有 tabs 无自身 component）。
- **`blockRenderers`**（`BlockRendererContribution`，第 465 行）：`id`/`block`（`"thinking"|"toolCall"|"text"|"userText"|"divider"` 或开放字符串）/`names`（可选，仅 toolCall/divider 有意义，toolCall 比工具名小写）/`component`/`order`。解析规则（`block-renderers.ts:39` 的 `resolveBlockRenderer`）：names 精确命中的特化层优先于未声明 names 的通用层；层内 order 小者胜。
- **`sidebar`**（第 110 行）：`id`/`title`/`component`/`order`/`group`（同 group 共享 Panel）。
- **`mainView`**（第 100 行）：`id`/`component`/`order`。多贡献按 order 选第一个。
- **`titlebar`**（第 141 行）：`id`/`component`/`order`。
- **`messageRenderers`**（第 452 行）：`role`/`component`，按消息 role 贡献卡片。
- **`fileActions`**（第 153 行）：`id`/`labelKey`（i18n key）/`icon`/`when.target`/`order`。点击后框架把 invoke 路由到 `<pluginId>:fileActionInvoke` 约定频道。
- **`fileIcons`**（第 328 行）：`id`/`icon`/`extensions`/`filenames`/`color`/`order`。
- **`messageActions`**（第 170 行）：`id`/`component`/`placement`/`when.role`/`order`。组件收 `{ message, text }`。
- **`codeBlockRenderers`**（第 307 行）：`id`/`languages`/`fileExtensions`/`component`/`order`。
- **`sessionGroupings`**（第 188 行）：`id`/`parentPathKey`/`childLabelKey`/`childIcon`/`order`。
- **`composerPolicies`**（第 205 行）：`id`/`customKey`/`readonlyMessageKey`/`order`。
- **`composerAttachments`**（第 221 行）：`id`/`component`/`order`。
- **`composerActions`**（第 249 行）、**`composerStats`**（第 263 行）、**`composerTop`**（第 277 行）、**`composerVoice`**（第 292 行）：`id`/`component`/`order`（composerVoice 组件收 `{ onTranscribed, disabled }`）。
- **`settingsGroups`**（第 45 行）：`id`/`titleKey`/`order`/`fields`（`SettingsFieldDecl`：key/type/default/titleKey/descKey/options），纯 JSON 声明，通用渲染器渲 UI，插件零渲染代码。
- **`themes`**（第 73 行）：`id`/`name`/`tokens`/`base`。
- **`languages`**（第 130 行）：见 §5。
- **`fontPresets`**（第 361 行）：`id`/`category`/`labelKey`/`stack`/`generic`。
- **`systemPrompts`**（第 347 行）：`id`/`file`（相对插件目录，注入 `--append-system-prompt`）/`order`。

**注册与覆盖语义**（`registry.ts`）：themes 是 Map 型槽（按 id 覆盖），其余是 `ArraySlot`（第 55 行）——push 前先按 `contribution.id` 清同 id 旧项（`removeById`），所以「复制到高优先级目录即覆盖低优先级同名贡献」。bootstrap 注册序 `builtin → installed → user → project` 保证后注册者（高优先级 source）覆盖先注册者。同 id 不同插件、同 order 时后注册者胜，确定性不随机。

**组件自动匹配兜底**：`registry.ts` 里每个贡献项只有 `component` 名，组件本体由 `plugins-host.ts` 加载 module 后从 exports 匹配。所以你在 plugin.json 里写的每个 `component` 名，都必须在 `renderer/index.tsx`（或其 re-export 链）里 `export`。

---

## 9 configFile 与权限声明

### 9.1 统一配置通道（ctx.config）与 configFile 的区别

先分清两个东西，别混：

- **`ctx.config`**（`PluginConfigApi`，`context.ts:196`）是**运行时键值存储**，插件自己在代码里 `ctx.config.get/set`。框架自动管路径：项目级 `<cwd>/.my-harness-desktop/config/{pluginId}.json` + 全局 `{userDir}/{pluginId}.json` 兜底，顶层 key 浅合并。它**不需要在 manifest 里声明任何东西**，任何插件都能用。
- **`configFile`** 是 `SettingsContribution` 上的字段，**只针对 settings 槽的设置页**，让框架自动管「读配置文件 → 渲染表单 → 设 dirty → 保存浮层 → 写回」。

`SettingsContribution` 的配置相关字段（`contributions.ts:9-39`）：

| 字段 | 类型 | 含义 |
|---|---|---|
| `configFile` | `string \| null` | 配置文件路径（`~` 开头）。null = 无配置文件，不显示打开按钮 |
| `configMerge` | `"deep" \| "replace"` | 写回合并方式，deep=深合并，replace=整份覆盖。缺省 `"replace"` |
| `saveMode` | `"framework" \| "manual"` | framework=框架管 save（浮层/拦截）；manual=实时生效（无浮层，仅打开按钮）。缺省 `"framework"` |
| `kernelModels` | `KernelId` | 声明后框架用 `kernelModels[kernel].readConfig/saveConfig` 读写中性 JSON（providers+default），不直读 configFile |
| `kernelConfig` | `KernelId` | 声明后框架用 `kernelConfig[kernel].get/set` 读写内核原生全量 JSON（pi=settings.json，dsh=settings.yaml） |
| `tabs` | `SettingsContribution[]` | 展示分组：声明后本项成为「入口」，渲染成顶部 TAB 条 + 当前 TAB pane |

`saveMode: "manual"` 的典型是 llm-recorder 的设置页：它 `ctx.config.set("recordEnabled", next)` 实时生效，不走 save 浮层，所以 manifest 里 `"saveMode": "manual"` 且不声明 `configFile`（`plugin.json` 第 31 行）。

「框架管 save/dirty」的具体分工：settings 组件收 `SettingsComponentProps.onChange(config)` 报告改动，框架设 dirty、弹保存浮层；保存时框架按 `configMerge` 深合并或整份覆盖写回 `configFile`。插件**只管渲染 + 调 onChange**，不自己碰文件路径。

### 9.2 权限声明

`permissions` 数组声明式能力。壳后端网关（`src/server/controllers/`）在受控入口调 `registry.assertPermission(pluginId, permission)`（`registry.ts:413`）：未知插件或未声明即抛错。六个权限字符串（已实现）：

| 权限 | 能力 | 检查位置 |
|---|---|---|
| `fs:project` | 文件系统读写（listDir/readFile/createFile/removePath 等） | `controllers/fs-git.ts` 各 handler |
| `git:read` | git 只读（status/fileDiff/fileContent/log） | `controllers/fs-git.ts` |
| `git:write` | git 收敛写面（commit/push） | `controllers/fs-git.ts` |
| `llm:oneshot` | 一次性 LLM 调用 | `controllers/kernel.ts:165` |
| `sessions:bus` | 会话总线（bus.send/sessionCreate/tapStart 等） | bus 域 handler |
| `rpc:bash` | bash 执行（高危 RCE，门控最严） | `controllers/sessions.ts:165` |

核心默认能力（`config`/`prefs`/`themes`/`sessions`/`i18n`/`models`/`kernels`/`notify`）不需声明。`dialog` 由用户手势触发，默认放行。

**声明了权限但没授权怎么办？** 不存在「用户逐项授权」的流程——权限是 manifest 声明 + 网关校验，声明了就有，没声明调了就抛错。壳插件功能受限但不崩溃：调了没授权的能力，handler 直接拒绝，插件收到错误自己决定怎么呈现（try/catch 或提前降级）。写代码时用可选访问 `ctx.fs?.readFile`——`fs` 是 `PluginContext.fs?`，未声明时 undefined，先判空再调。

llm-recorder 是范本：它需要读自己 pi-extension 落盘的 JSONL（`<cwd>/.my-harness-desktop/llm-logs/`），所以 `plugin.json` 声明 `"permissions": ["fs:project"]`，代码里 `ctx.fs?.readFile(...)` 处处判空。

---

## 10 生命周期：activate / deactivate / dispose

插件的生命周期由 `src/server/application/lifecycle/index.ts` 管。**插件不写 activate/deactivate 函数**——它没有 main 入口，生命周期是框架按 manifest 声明驱动的。开发者需要理解的是「我的插件在什么时机被做什么事」，以及**renderer 组件自身的 dispose 纪律**。

### 10.1 activate（`lifecycle/index.ts:92`）

顺序固定：

```ts
deps.registry.registerOne({ manifest, path, source });   // 1. 注册槽位贡献到注册表
await deps.loader.load(manifest, pluginPath);             // 2. 加载 renderer 模块（前端 plugins-host）
if (deps.skillsEnsure) await deps.skillsEnsure.onActivate(...);       // 3. 技能挂载（若有）
if (deps.piExtensionEnsure && manifest.piExtension)                 // 4. pi 扩展同步
  deps.piExtensionEnsure.onActivate(manifest.id, pluginPath, manifest.piExtension);
if (deps.dshExtensionEnsure && manifest.dshExtension)               // 5. dsh 扩展同步
  deps.dshExtensionEnsure.onActivate(manifest.id, pluginPath, manifest.dshExtension);
clearPluginState(manifest.id);                            // 6. 清 error 态
deps.notifyPluginsChanged();                               // 7. 广播（前端据 nonce 重拉槽清单）
```

任一步抛错 → `registry.unregister` 撤回贡献注册 + `setPluginError` 记 error 态，返回 `{ ok: false, error }`。所以**一个插件的 renderer 模块加载失败，它的槽位贡献会被撤回**，不会留下「右栏孤儿 Tab」。

### 10.2 deactivate（`lifecycle/index.ts:118`）

反向：

```ts
deps.registry.unregister(pluginId);                        // 1. 从注册表移除全部贡献
await deps.skillsEnsure.onDeactivate(...);                 // 2. 技能摘除
deps.piExtensionEnsure.onDeactivate(pluginId);             // 3. pi 扩展摘除（删带标记目录）
deps.dshExtensionEnsure.onDeactivate(pluginId);            // 4. dsh 扩展摘除（摘 cordis 块 + 删目录）
const components = collectComponentNames(manifest);        // 5. 收集组件名
deps.notifyPluginUnloaded(pluginId, components);           // 6. 通知前端卸载模块
deps.notifyPluginsChanged();
```

前端 `plugins-host.ts:115` 的 `onUnloaded` 回调收到通知后：`eventBus.unregisterPlugin(pluginId)`（把该插件所有 channel 的 handler 用 null 调一遍再删）、`unregisterPluginModule`、`unregisterPluginComponents`、`unregisterAuxParsers`、`unregisterComposerCommands`。

### 10.3 卸载/禁用/重载的保护

- `canUninstall`（第 15 行）：`manifest.protected` 为 true 则不可卸载。
- `canDeactivate`（第 32 行）：protected 或 `checkDependents` 发现别的插件 `dependsOn` 它，则拒绝（返回 `blockedBy`）。
- `disablePlugin`（第 150 行）：把 id 写进 `plugin-manager` 的 `disabledPlugins` 配置，再 deactivate。
- `enablePlugin`（第 162 行）：先 rediscover 成功再清禁用标记（防「标记已清但插件未激活」的磁盘态/内存态脱节）。
- `reloadPlugin`（第 137 行）：deactivate → rediscover → activate。
- `reportLoadFailure`（第 184 行）：renderer 上报加载失败，与 activate 失败分支同出口（撤回注册 + error 态 + 广播）。

### 10.4 插件自己的 dispose 纪律

生命周期框架只管到「模块卸载」。**组件级的资源释放是插件自己的事**，核心一条：`onEvent`/`on`/`watch` 等返回的反注册函数，必须在 `useEffect` cleanup 里返回。goal 的 `goal-controller.ts` 是范本：

```ts
useEffect(() => {
  return sessions.onEvent((event) => {
    if (event.type === "agentStart") busyRef.current = true;
    if (event.type === "agentSettled") busyRef.current = false;
    // ...
  });
}, [sessions, messaging, setGoal]);
```

`return sessions.onEvent(...)` 直接把反注册函数交出去。llm-recorder 的 `RecordsTab` 也是 `return ctx.sessions.onEvent(...)`。忘了返回 cleanup，插件重载后会收到双份事件，这是最常见的 bug。

---

## 11 完整最小示例

下面从零建一个「待办」插件 `todo`（域 `sessions`），完整演示四件套。它做一件最小但真实的事：给两个内核各注册一个 `add_todo` 工具（模型可调），在时间线用自定义卡片渲染这个工具调用块，在右侧面板列当前会话的待办，配置一个开关。

目录结构：

```
src/plugins/sessions/todo/
  plugin.json
  locales/
    zh-CN/panel.json
    en/panel.json
  renderer/
    index.tsx
    todo-card.tsx
    todo-panel.tsx
  pi-extension/
    index.ts
  dsh-extension/
    index.mjs
    extension.json
```

### 11.1 plugin.json

```json
{
  "id": "todo",
  "version": "0.1.0",
  "tier": "official",
  "displayName": "待办",
  "description": "内核无关的同会话待办：add_todo 工具 + 时间线卡片 + 右侧面板",
  "tags": ["session"],
  "renderer": "./renderer/index.tsx",
  "piExtension": "./pi-extension",
  "dshExtension": "./dsh-extension",
  "contributes": {
    "blockRenderers": [
      { "id": "todo", "block": "toolCall", "names": ["add_todo"], "component": "TodoCard" }
    ],
    "sidePanel": [
      { "id": "todo-panel", "label": "待办", "icon": "list-todo", "component": "TodoPanel", "order": 60 }
    ],
    "languages": [
      { "id": "todo.panel", "locale": "zh-CN", "resources": "./locales/zh-CN/panel.json" },
      { "id": "todo.panel", "locale": "en", "resources": "./locales/en/panel.json" }
    ]
  }
}
```

### 11.2 locales/zh-CN/panel.json

```json
{
  "panel.title": "待办",
  "panel.empty": "这个会话还没有待办",
  "panel.added": "已添加待办"
}
```

### 11.3 renderer/index.tsx

```tsx
// 组件 export 名 = plugin.json 里的 component 名，框架自动匹配，不调 register。
export { TodoCard } from "./todo-card";
export { TodoPanel } from "./todo-panel";

// 待办状态广播：payload { items: string[] }。
export const channels = ["todo:state"] as const;
```

### 11.4 renderer/todo-card.tsx

```tsx
import type { ToolCallBlock } from "@my-harness-desktop/react";

export function TodoCard({ toolCall }: { toolCall: ToolCallBlock }) {
  const args = (toolCall.args ?? {}) as Record<string, unknown>;
  const text = typeof args.text === "string" ? args.text : "";
  return (
    <div style={{ borderLeft: "3px solid var(--color-primary)", padding: "5px 12px" }}>
      <span>待办</span>
      <span style={{ marginLeft: 8 }}>{text}</span>
    </div>
  );
}
```

### 11.5 renderer/todo-panel.tsx

```tsx
import { useEffect, useState } from "react";
import { usePluginContext } from "@my-harness-desktop/react";
import { useTranslation } from "react-i18next";

export function TodoPanel({ isActive }: { isActive: boolean }) {
  const ctx = usePluginContext();
  const { t } = useTranslation();
  const [items, setItems] = useState<string[]>([]);

  useEffect(() => {
    // on 返回反注册函数，卸载自动清理；replayLast 让晚挂载的 Tab 立即拿到最近一次广播。
    return ctx.events.on("todo:state", (p) => {
      const payload = p as { items: string[] } | undefined;
      setItems(payload?.items ?? []);
    }, { replayLast: true });
  }, [ctx.events]);

  if (items.length === 0) {
    return <div style={{ padding: 12, color: "var(--color-muted)" }}>{t("panel.empty")}</div>;
  }
  return (
    <div style={{ padding: 12 }}>
      {items.map((it, i) => <div key={i}>{it}</div>)}
    </div>
  );
}
```

### 11.6 pi-extension/index.ts

```ts
interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}
interface ToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(id: string, params: Record<string, unknown>, ...rest: unknown[]): Promise<ToolResult>;
}
interface PiApi { registerTool(tool: ToolDefinition): void; }

export default function todo(pi: PiApi): void {
  pi.registerTool({
    name: "add_todo",
    label: "Add Todo",
    description: "Add a todo item to the current session.",
    parameters: {
      type: "object",
      properties: { text: { type: "string", description: "The todo item text." } },
      required: ["text"],
      additionalProperties: false,
    },
    async execute(_id, params) {
      const text = typeof params.text === "string" ? params.text : "";
      if (text === "") {
        return { content: [{ type: "text", text: "add_todo failed: text must be non-empty" }], isError: true };
      }
      return { content: [{ type: "text", text: JSON.stringify({ todo: { text } }) }] };
    },
  });
}
```

### 11.7 dsh-extension/index.mjs

```js
export const name = "desktop-todo";
export const inject = ["tools"];

export function apply(ctx) {
  ctx.tools.register({
    name: "add_todo",
    label: "Add Todo",
    description: "Add a todo item to the current session.",
    parameters: {
      type: "object",
      properties: { text: { type: "string", description: "The todo item text." } },
      required: ["text"],
      additionalProperties: false,
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    async execute(args) {
      if (typeof args.text !== "string" || args.text === "") {
        return { error: "add_todo failed: text must be non-empty" };
      }
      return { todo: { text: args.text } };
    },
  });
}
```

### 11.8 dsh-extension/extension.json

```json
{
  "displayName": "Todo (add_todo)",
  "description": "内核无关的同会话待办薄工具：添加待办"
}
```

### 11.9 这个示例遗漏了什么

它故意最小，所以有几件事没做，真实插件按需补：没有 settings 页（所以没有 `contributes.settings`、没有 `configFile`、没有 `permissions`）；`add_todo` 只返回确认文本，没把「待办列表」持久化到会话头行 `custom` 域、也没把「模型调工具」接到「面板展示」的完整数据流（这需要像 goal 那样用 `sessions.onEvent` 捕获 `toolCallStart`、`updateHeader` 写 custom、`emit` 广播）。这些是「功能」，做法都能在 goal 的 `goal-controller.ts` 里找到范本。

---

## 12 QA

**Q：plugin.json 的 `id` 和目录名、renderer 上级目录名不一致会怎样？**

内置插件会出问题。`plugins-host.ts:23` 用正则 `plugins\/(?:[^/]+\/)*([^/]+)\/renderer` 抓 renderer 的直接上级目录名当插件 id，与 `manifest.id` 比对。不一致时 `builtinPathById` 的 key 和 manifest.id 对不上，加载找不到 chunk。三者保持一致：目录名 = `plugin.json` 的 `id` = renderer 的上级目录名。

**Q：我改了 renderer 代码，为什么页面没更新？**

内置插件由 `import.meta.glob` 在构建期打包成静态 chunk，改代码要重新构建；第三方插件 `loadThirdParty` 用 `?t=${Date.now()}` 缓存破坏，但 dev 热更新是否生效取决于有没有跑 `pnpm run dev:web`（客户端插件改动经 HMR 重载的条件）。不要假设「改了就自动生效」，构建产物变了要验证 URL。

**Q：两个插件往同一个槽位挂了同 id 的贡献，谁赢？**

高优先级 source 赢。`registry.ts` 的 `ArraySlot.removeById` 在 push 前清同 id 旧项，bootstrap 注册序 `builtin → installed → user → project` 保证后注册者（更高优先级）覆盖。同 order、同 id 的平手不可能——同 id 已被 removeById 替换。这是确定性的，不随机。

**Q：我想让我的插件读别的插件的数据，怎么读？**

不能读，只能听。插件间唯一合法通道是事件：对方 `ctx.events.emit` 广播，你在 `dependsOn` 声明依赖后 `ctx.events.on` 订阅。不通过共享 store 互读写、不通过 `window.kernel` 直调对方。要「拉取一次性数据」就用 `invoke`（定向分派，恰好一次）。

**Q：什么时候必须写 pi-extension/dsh-extension？**

只有「内核缺能力、壳插件又需要」时才写。判断链条：壳要的能力，pi 和 dsh 有没有「同语义只是形状不同」的对应物？有 → 适配器翻译（不用写插件）；没有 → 写内核插件补面；补不了 → 壳侧显式降级。goal 的 `set_goal`/`achieve_goal` 是「模型可调用的工具」——工具只能由内核注册、壳注入不了，所以两侧都写内核扩展。llm-recorder 的「LLM 请求落盘」是 pi 没有的钩子能力，所以写 pi 扩展。如果能力两个内核都不缺，就别写。

**Q：`ctx.config` 和 `configFile` 都用吗？什么时候用哪个？**

两个机制，互不排斥。`ctx.config` 是运行时键值，任何插件任何代码都能用（`get`/`set`/`all`），适合「读一个开关」这类简单状态。`configFile` 只在 settings 槽的设置页用，让框架管「读文件 → 表单 → dirty → 保存浮层 → 写回」，适合「一份用户可见的 JSON 配置文件」。llm-recorder 就同时用：设置页 `saveMode: "manual"` 用 `ctx.config.set("recordEnabled")` 实时生效，不声明 `configFile`。

**Q：pi-extension 和 dsh-extension 里能 import 内核的官方包吗？**

不能。内核 node_modules 里的类型仓库 tsconfig 够不到，且「不 import 对方核心」是纪律（只写扩展，不写对方核心）。手写用到的窄结构（goal 的 `GoalApi`、llm-recorder 的 `RecorderApi` 都是自己 interface），只依赖内核注入的 API 面（pi 的 `registerTool`/`on`，dsh 的 cordis `ctx.tools`）。要改内核核心，去内核仓库提 PR，不在桌面插件里绕。

**Q：插件加载失败会怎样？**

不拖垮整个壳。`activate` 的 try/catch 会 `registry.unregister` 撤回它的贡献注册、`setPluginError` 记 error 态、广播。管理页能看到 error 态插件，其余插件照常。renderer 加载失败走 `reportLoadFailure` 同出口。pi/dsh 扩展同步失败只记日志，插件本体照常加载。
