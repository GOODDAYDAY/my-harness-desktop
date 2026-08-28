# 工具管理插件（tool-manager）

## 职责边界

tool-manager 是 `src/plugins/manager/` 域下的一个壳插件，plugin id 为 `tool-manager`，版本 `0.4.9`，tier `official`。它只做一件事：**把"当前内核有哪些可用工具"和"本次会话允许哪些工具"这两个事实呈现给用户，并让用户能改后者**。前者叫工具发现（读），后者叫工具配置（读+写）。它不产出任何工具能力——工具能力属于内核（pi 的 `dist/core/tools` 核心工具 + `my-harness-fit-pi-extension` 扩展工具），也不执行过滤——硬过滤由 pi 内核的 tool-gate 扩展执行，软过滤由壳前端 `src/web/stores/session-store.ts` 在发送前拼提示文本执行。tool-manager 只是"配置的生产者"和"清单的展示者"。

这份边界决定了它的依赖形状：`renderer/index.tsx` 只 import `react`、`react-i18next`、`framer-motion`、`lucide-react`、`@my-harness-desktop/react`、`@my-harness-desktop/shared`（经 `../core/types` 间接），没有任何 `@/server`、`@/client` 的跨层 import——符合 §6.3 的依赖方向检验。`core/types.ts` 里唯一的外部类型引用是 `export type { SessionToolConfig } from "@my-harness-desktop/shared"`，这是纯 re-export（契约单源，§1.3），不复制定义。整个插件没有 `permissions` 字段，因为它只用到 `ctx.sessions`（核心默认能力）、`ctx.config`（核心默认能力）、`ctx.kernels.pi.fitPiExtensionAvailable`（核心默认的 kernel 探测面）——都不需要声明权限。

plugin.json 的 `contributes` 声明了三组贡献：`settings`（一个设置页）、`sidePanel`（一个右面板 Tab）、`languages`（三命名空间 × 四 locale 的文案）。它**没有声明任何 `channels`**，也没有 `dependsOn`——tool-manager 不通过事件总线与别的插件通信，它只调壳提供的受控 API（`ctx.sessions.listTools`、`ctx.sessions.readToolConfig`、`ctx.config.get/set`、`ctx.kernels.pi.fitPiExtensionAvailable`），与内核（不是插件）通过中立契约 `BaseBackend.listTools?` 和 `SessionCatalog.readToolConfig` 交互。这是它和 file-preview 插件最大的不同：file-preview 走"事件 channel + 槽位查渲染器"的插件间协作，tool-manager 走"直接调壳 API"的单插件闭环。

## 目录结构

插件物理形态是四件套里的**纯 desktop 壳插件**（没有 `pi-extension/` 和 `dsh-extension/` 目录）——它的内核侧能力（tool-gate 硬过滤、工具播报）由统一的 `packages/my-harness-fit-pi-extension/toolgate.ts` 承担，不在本插件目录里。文件清单：

- `plugin.json`：manifest。声明 id/version/tier/displayName/description/renderer，以及 `contributes.settings`、`contributes.sidePanel`、`contributes.languages`。没有 `permissions`、没有 `dependsOn`、没有 `channels` 导出（channels 是 renderer 代码里的 `export const channels`，这里没有）。
- `renderer/index.tsx`（779 行）：唯一的 renderer 入口。导出两个被 manifest 引用的组件——`ToolManagerPage`（settings 槽）和 `ToolPanelTab`（sidePanel 槽），以及若干私有子组件（`ToolRow`、`ToolCheckGrid`、`GroupRow`、`GroupEditRow`、`GroupIcon`）和三个自定义 hook（`useDiscoveredTools`、`useToolGroups`、`useSessionToolConfig`）。
- `core/types.ts`（133 行）：纯函数 + 纯类型的核心逻辑层。`KnownTool`、`ToolGroup` 两个本地类型；`SessionToolConfig` 从 shared re-export；常量 `PRESET_GROUPS`、`BUILTIN_TOOLS`；纯函数 `reconcilePresetGroups`、`computeDefaultEnabledGroupIds`、`computeEnabledToolIds`、`mergeKnownTools`。
- `core/types.test.ts`（115 行）：vitest 单测，覆盖上述四个纯函数的边界语义。
- `locales/{zh-CN,zh-TW,en,de}/`：四语言三命名空间。`plugin.json`（插件名/描述）、`settings.json`（设置页标题 `settings.tools`）、`toolManager.json`（面板全部文案 key）。

`core/` 子目录的独立是有意义的：它把**可纯函数化的业务规则**从 React 组件里抽出来，使"组展开""三源合并""预设迁移"这些逻辑可以脱离 React 单独测试、单独演进。`renderer/index.tsx` 里的 hook 只做 IO 编排（调 ctx API、订阅事件），真正的数据变换全部下沉到 `core/types.ts`。

## plugin.json 与贡献的槽位

manifest 的 `contributes` 精确形状如下，每个字段都对应圆心 `packages/shared/src/domain/contributions.ts` 里的一个贡献接口：

- `settings` 数组（对应 `SettingsContribution`）：一条 `{ id:"tools", title:"工具", icon:"sliders-horizontal", component:"ToolManagerPage", saveMode:"manual", order:4 }`。注意 `saveMode:"manual"`——它**不声明 `configFile`**，因此框架的 save/dirty/浮层/拦截/打开配置文件按钮这一整套机制对它不生效；配置的读写由插件自己在 `useToolGroups` 里经 `ctx.config.get/set("groups")` 完成，实时生效。`order:4` 决定它在设置页左列表的位置（Pi 管理恒第一 order 0，语言置底 999）。`title` 是写死的键值对——但这不是内容泄漏，`title` 在这里是 manifest 字段不是最终文案，最终文案由 `languages` 槽的 `settings.tools` key 经 i18n 解出（见 `locales/*/settings.json`）。
- `sidePanel` 数组（对应 `SidePanelContribution`）：一条 `{ id:"tools", label:"工具", icon:"sliders-horizontal", component:"ToolPanelTab", order:15 }`。它是右面板的一个常驻 Tab，没有 `revealOn` 声明（对比 file-preview 的 `revealOn` 用途——tool-manager 的 Tab 不需要被某个 channel 触发自动浮出，它是用户手动打开的常驻 Tab）。`order:15` 决定它在右面板 Tab 条的位置。
- `languages` 数组（对应 `LanguageContribution`）：12 条，三命名空间 `tool-manager.settings` / `tool-manager.plugin` / `tool-manager.toolManager` × 四 locale `zh-CN`/`zh-TW`/`en`/`de`，每条 `resources` 指向相对 JSON 文件。这是壳插件标准 i18n 模式：框架启动时把各 locale 的 key→文案字典合并进 i18next resources，渲染时 `t("toolManager.xxx")` 查。

两个组件名 `ToolManagerPage` 和 `ToolPanelTab` 都是 manifest 里的字符串，框架按 §7.4 的自动匹配规则从 `renderer/index.tsx` 的 exports 里按名找到同名组件注册，插件代码里没有一行 `registerXxx` 调用。

## 圆心契约：listTools? 与 SessionToolConfig / KnownToolInfo

tool-manager 的内核交互面完全落在圆心，涉及三个关键定义。先看工具发现的契约：

`packages/shared/src/domain/backend.ts` 的 `BaseBackend` 接口第 133-135 行声明了可缺面意图 `listTools?`：

```ts
/** 工具清单(可缺面):返回本内核当前可用工具;null = 内核不支持工具发现,壳走降级。
 *  pi=known-tools 播报文件读取,dsh=将来经 SDK server session/listTools。 */
listTools?(): Promise<KnownToolInfo[] | null>;
```

"可缺面"三个字的实现落在 `src/server/kernel/core/abstract-backend.ts` 第 106-109 行——`AbstractBackend` 给 `listTools` 一个缺面默认：直接 `Promise.resolve(null)`。于是 dsh（`DshBackend extends AbstractBackend` 未 override `listTools`）天然"不支持工具发现"，返回 null 走降级；pi（`PiBackend`）在第 374-377 行 override 它，调用 `readKnownTools(this.ctx.cwd)` 读播报文件。这精确复现了 §9.4 的三段式继承：接口在圆心、缺面默认在基类、真实实现只在 pi 子类里补。

`listTools` 的返回类型 `KnownToolInfo` 定义在 `packages/shared/src/domain/sessions.ts` 第 166-171 行：

```ts
export interface KnownToolInfo {
  name: string;
  description: string;
  source: "builtin" | "extension" | "cordis";
  extensionPath?: string;
}
```

这是 tool-gate 播报的单个工具的中性形状，注释里明确它是"契约单源"：写方 `my-harness-fit-pi-extension/toolgate.ts`、读方 `client/pi`（现为 `src/server/kernel/pi/model/known-tools.ts`）、消费方 tool-manager 三方共用同一份类型。`source` 三值里 `cordis` 是为 dsh 预留的（dsh 的 Cordis 插件工具将来经 `session/listTools` 报上来时用），pi 侧目前只会产生 `builtin` 和 `extension` 两值。

工具配置的契约有两份，都是圆心单源。类型 `SessionToolConfig` 在 `sessions.ts` 第 123-130 行：

```ts
export interface SessionToolConfig {
  enabledGroupIds?: string[];
  /** 组展开后的工具 id 清单(写侧 Apply 时解析落盘;消费方只认该字段,不回退组展开) */
  enabledToolIds?: string[];
}
```

注释把字段语义钉死：`enabledGroupIds` 是用户偏好的"开了哪些组"，`enabledToolIds` 是组展开后的**工具 id 清单**——这是落盘时已经解析好的终值，消费方（timeline 软注入、tool-gate 硬过滤）只认 `enabledToolIds`，不回退组展开。这个"写侧展开一次、消费侧直接用"的设计避免了每个消费方各自重写一遍组→工具展开逻辑（§1.1 判别气味三的正面解法）。无 `mode` 字段（v7 起废弃）——字段存在即过滤生效。

读写这配置的契约在 `backend.ts` 的 `SessionCatalog` 接口第 280-281 行：

```ts
/** 读会话工具配置(无配置返回 null)。 */
readToolConfig(sessionId: string): Promise<SessionToolConfig | null>;
```

`SessionCatalog` 是 per-kernel 的跨会话存储中立面，与 `BaseBackend` 正交：`BaseBackend` 管 per-session 的进程+分支句柄，`SessionCatalog` 管 per-kernel 的跨会话目录/CRUD。`readToolConfig` 是它 15 个方法之一。写侧不走 `SessionCatalog` 的专门方法，而是走它的 `updateHeader(sessionId, patch)`（第 270-271 行），把 `HeaderPatch.toolConfig`（`sessions.ts` 第 181-182 行，语义 `toolConfig?: SessionToolConfig | null`，null=删键）写进会话头行的 `custom-my-harness-desktop.toolConfig` 保留键。

## 工具发现数据流（listTools → 播报文件 → tool-gate）

工具发现是一条**从 renderer 一路下钻到 pi 内核扩展写出的侧车文件**的读链。从 renderer 侧看，入口是 `useDiscoveredTools()`（`renderer/index.tsx` 第 26-66 行）：

- 第一个 effect（第 35-49 行）是权威来源：`ctx.sessions.listTools()`。它把返回的 `KnownToolInfo[]` 逐条映射成 `KnownTool`（`id=t.name, name=t.name, description=t.description, source=t.source, extensionId=t.extensionPath`）。deps 是 `[ctx, currentCwd, currentSessionPath]`，cwd 或会话路径变化即重拉。若 `listTools()` 返回 null（播报文件缺席/无活跃进程/dsh 缺面），`announced` 留空数组。
- 第二个 effect（第 52-63 行）是增量兜底：订阅 `ctx.sessions.onEvent` 的活跃会话中性事件流，遇到 `event.type === "toolCallStart"` 且 `toolName` 非空时，把未见过的工具名塞进 `discoveredRef`（一个 `Map<string, KnownTool>`），`source` 标 `"extension"`。这是设计文档 §4.3 的"降级纪律不删"——tool-gate 未装、播报文件未写时，靠直播事件补全工具名。
- 第 65 行 `return mergeKnownTools(BUILTIN_TOOLS, announced, [...discoveredRef.current.values()])` 做三源合并。

`ctx.sessions.listTools()` 的落地在 `packages/react/src/plugin-context.ts` 第 64 行——它把 PluginContext 的 `sessions.listTools` 绑定到 `window.kernel.sessions.listTools()`，类型标注 `Promise<KnownToolInfo[] | null>`。这是壳插件能拿到的受控 API 形状，插件不直接碰 `window.kernel`。

壳后端侧，`src/server/controllers/sessions.ts` 第 49 行把 IPC 通道 `IPC.session.listTools` 注册为 `() => sessionStore.listTools()`。`src/server/application/sessions/session-store.ts` 第 1111-1116 行实现：

```ts
async listTools(): Promise<KnownToolInfo[] | null> {
  const proc = this.activeProc();
  if (!proc?.backend.listTools) return null;
  return proc.backend.listTools();
}
```

两个降级点：`!proc`（没有活跃进程）→ null；`!proc.backend.listTools`（后端没实现这个可缺面方法）→ null。二者都静默返回 null，由消费方（tool-manager）自己决定怎么呈现——这正是 §1.5"静默缺面"禁令的**例外**：listTools 是契约里明确"可缺面、null 即降级"的意图，返回 null 不是"假装成功"，而是"诚实告知无清单"，消费方落到兜底链（BUILTIN_TOOLS + 事件收集）。

再往下是内核实现。`PiBackend.listTools()`（`src/server/kernel/pi/backend/pi-backend.ts` 第 374-377 行）只有一行：`return Promise.resolve(readKnownTools(this.ctx.cwd))`。真正的文件读在 `src/server/kernel/pi/model/known-tools.ts`：

- 常量 `KNOWN_TOOLS_FILE = join(homedir(), ".pi", "agent", "desktop-known-tools.json")`（第 12 行）——这是播报文件的绝对路径。
- `readKnownTools(cwd)`（第 14-28 行）：`readFileSync` + `JSON.parse`，取 `parsed.byCwd?.[cwd]?.tools`，若非数组返回 null，否则 filter 出 `name` 为 string 的条目（运行时窄化 `KnownToolInfo`）。整个 try/catch 包住，文件缺失、半截 JSON、结构不对都走同一个 null 出口。

这个文件是谁写的？`packages/my-harness-fit-pi-extension/toolgate.ts` 的 `announceTools`（第 59-82 行）。它挂在 `pi.on("turn_start", ...)`（第 109 行），每轮 turn 开始时调 `pi.getAllTools()` 拿到内核当前全量工具，经 `toAnnouncedTool`（第 47-55 行）做来源映射——`sourceInfo.source === "builtin"` 标 `builtin`，否则标 `extension` 并带 `extensionPath = sourceInfo.path`——然后按 cwd 分桶写进同一个 `desktop-known-tools.json`。播报时机选择 `turn_start` 而非 `session_start` 是 v4 的修正（见 QA），因为桌面扩展的 `registerTool` 门控在与 desktop 的握手之后，`session_start` 时 `getAllTools()` 只返回核心 7 个，会回写成残缺集。

于是完整读链是：**tool-gate（pi 内核扩展）turn_start 写播报文件 → `PiBackend.listTools` 读文件 → `sessionStore.listTools` 透传 → IPC → `usePluginContext().sessions.listTools` → `useDiscoveredTools` 映射成 KnownTool**。dsh 侧这条链在 `AbstractBackend.listTools` 就断了（返回 null），tool-manager 拿到空 `announced`，只显示 BUILTIN_TOOLS + 事件收集的兜底结果。

## 工具配置数据流（readToolConfig / Apply flush / tool-gate 硬过滤 / 软注入）

工具配置是**读一路、写一路、执行一路**的三段。读链和 `listTools` 同构：`useSessionToolConfig(sessionPath)`（`renderer/index.tsx` 第 107-119 行）→ `ctx.sessions.readToolConfig(sessionPath)` → `plugin-context.ts` 第 81 行 → `controllers/sessions.ts` 第 55 行 → `sessionStore.readToolConfig`（第 735-737 行，一行 `return this.catalog.readToolConfig(sessionPath)`）→ `PiSessionCatalog.readToolConfig`（`src/server/kernel/pi/backend/pi-catalog.ts` 第 616-618 行）→ `piReadSessionToolConfig`（第 480-485 行）→ `piReadSessionCustom` 读头行 `custom-my-harness-desktop`，取 `custom.toolConfig`。dsh 的 `DshSessionCatalog.readToolConfig`（`dsh-catalog.ts` 第 59-63 行）直接 `return null`——注释明确"dsh 无 tool-gate（pi 专属扩展面），工具启停配置缺面 → 返回 null，壳按「无配置」处理。不抛错——发送路径会读它，抛错会打断发送前的工具过滤"。

写链的入口是 `ToolPanelTab` 的 `toggleGroup`（第 520-525 行）：切换一个组后，`setEnabledIds(next)` 立即更新 UI 显示，同时 `pushPending([...next])` 把新开的组 id 数组写入 pending。`pushPending`（第 479-487 行）构造 `{ sessionPath, config: { enabledGroupIds, enabledToolIds: computeEnabledToolIds(groups, enabledGroupIds, allTools) }, flushed: false }` 并 `setPendingToolConfig`。关键点：**写 pending 的时候就把组展开成 `enabledToolIds` 了**，这是 §4.4.2 契约的落地——消费方只认 `enabledToolIds`，所以在 pending 构造时就展开好，落盘时直接写终值。

pending 到落盘的 flush 发生在**发送消息时**，不是切换开关时。`src/web/stores/session-store.ts` 第 505-525 行的 `sendMessage` 编排里：

- 第 507 行读 `ui.pendingToolConfig?.sessionPath === sessionPath ? ui.pendingToolConfig : null`——pending 只对当前会话生效。
- 第 509-512 行：若 pending 存在且 `!flushed`，`await window.kernel.sessions.updateHeader(sessionPath, { toolConfig: pendingTools.config })` 把配置写进会话头行，然后 `setPendingToolConfig({ ...pendingTools, flushed: true })` 标记已落盘。这条 updateHeader 最终走到 `pi-catalog.ts` 的 `piUpdateSessionHeader`（第 401-403 行处理 `toolConfig` 键：有值则写 `cur.toolConfig`，null 则 delete）。
- 第 514-516 行：否则（pending 已 flush 或不存在）`toolCfg = await window.kernel.sessions.readToolConfig(sessionPath)` 读回头的现有配置。
- 第 517-523 行：若 `toolCfg.enabledToolIds` 是数组，`gateInstalled = await window.kernel.kernels.pi.fitPiExtensionAvailable?.().catch(() => false)` 探测 tool-gate 是否在场；**若 gate 不在场**，`finalText = buildToolLimitNote(enabledTools) + "\n\n" + text` 把限制提示前置拼进 prompt——这就是"软注入"。

`buildToolLimitNote`（session-store.ts 第 20-31 行）生成 `[System] 本次会话已限制可用工具。\n可用工具: <list>\n请勿使用未在列表中的工具。`，空清单显示"无"（显式全禁语义）。注释自述它是"非 UI 文案——演进:内核提供工具白名单 RPC 后整体移除"，是过渡期的软过滤手段，靠 LLM 自觉遵守，不一定有效。

硬过滤的执行者是 tool-gate 的 `applyFromHeader`（`toolgate.ts` 第 88-106 行），挂在 `pi.on("session_start")` 和 `pi.on("turn_start")`：读会话文件头行 8KB 窗口，取 `custom-my-harness-desktop.toolConfig.enabledToolIds`，若字段缺失（无配置/旧数据）恢复全量 `allNames`，否则 `enabledToolIds.filter(n => allNames.includes(n))` 过滤掉未注册名，最后 `pi.setActiveTools(enabled)` 硬性设置内核活跃工具。第 99-101 行有个指纹优化：`lastAppliedKey` 记录上次应用的排序指纹，无变化就跳过 `setActiveTools`，避免每轮 turn 重复设置。tool-gate 为什么自己读文件而不是走 `sessionManager.getHeader()`——第 10-11 行注释给的理由是：desktop 在会话运行中改头行，sessionManager 缓存的是 spawn 时读的那份，自己读文件才能拿到 desktop 刚写的最新值。

于是三段拼成闭环：**ToolPanelTab 切开关 → pending（内存）→ send 时 flush 写头行 → tool-gate turn_start 读头行 → setActiveTools 硬过滤**。软注入（`buildToolLimitNote`）只在 `fitPiExtensionAvailable()` 为 false 时作为降级手段介入。`fitPiExtensionAvailable`（`src/server/kernel/pi/extension/my-harness-fit-pi-extension-installer.ts` 第 114-117 行）就是 `existsSync(EXT_FILE_TARGET)`——检查 tool-gate 扩展文件是否已同步进内核目录。

## 核心纯函数（core/types.ts）

`core/types.ts` 是插件的心智核心，四个纯函数 + 两份常量，全部零 IO、零 React、可单测（`types.test.ts` 覆盖）。

**`BUILTIN_TOOLS`**（第 90-98 行）：7 个 pi 内核核心工具的硬编码清单——`bash`/`read`/`write`/`edit`/`find`/`grep`/`ls`，source 全标 `builtin`。这是播报缺席时的兜底底版。注释交代了工具名以内核注册名为准的纪律：`pi.setActiveTools` 对未注册名静默忽略，写错名字的代价是白名单静默失效。

**`PRESET_GROUPS`**（第 28-65 行）：4 个内置组。`readonly`（read/find/grep/ls，icon eye）、`writeonly`（write/edit/bash，icon pencil）、`bus`（bus_status/session_create/session_abort/channel_member/tap_start/tap_stop，icon radio）、`subagent`（spawn_subagent/send_to_subagent/wait_subagent/list_subagents/abort_subagent，icon bot），全部 `builtIn: true`、`defaultEnabled: true`。这些组名直接对应 `my-harness-fit-pi-extension` 的 bus/subagent 扩展工具。

**`reconcilePresetGroups(stored)`**（第 71-82 行）：内置组随代码换新的迁移纪律。它把 stored 里的 builtIn 组**整体丢弃**，用当前 `PRESET_GROUPS` 的结构（name/description/toolIds）重建；但 `defaultEnabled` 是用户偏好，同 id 旧组有显式覆盖时保留（结构归框架、状态归用户）；自定义组（`builtIn: false`）原样保留，缺 `defaultEnabled` 补默认 true。注释强调它是纯函数不写盘——落盘等用户下次 save 顺带完成，load 路径写盘会触发 `settings:changed` 广播回环（这是根因修复的教训）。

**`computeDefaultEnabledGroupIds(groups)`**（第 86-88 行）：返回 `defaultEnabled` 的组 id 清单，即"无 session 配置时的默认启用组"。

**`computeEnabledToolIds(groups, enabledGroupIds, allTools)`**（第 100-123 行）：组展开核心。三条规则：显式空数组 = 全禁（返回 `[]`，注释点名 v7 契约"tool-gate setActiveTools([]) 硬禁全部"）；开启组的 toolIds 取并集；**未被任何组收录的工具恒并入**（默认全开）——组开关只控制组内工具，新扩展工具开箱可用，不被静默挡在门外。

**`mergeKnownTools(builtin, announced, discovered)`**（第 127-133 行）：三源合并。顺序是 builtin 打底、discovered 补未见过的、announced 最后**覆盖同名**（`merged.set(t.id, t)` 无条件覆盖）——即"同名冲突以播报文件为准，其余来源先见先得"。这对应 `types.test.ts` 里 5 个 mergeKnownTools 用例的核心断言。

`types.test.ts` 用 vitest 的 `describe/it/expect` 逐条钉死语义：播报缺席落回 BUILTIN+事件收集、播报带来真描述与来源、同名冲突播报胜出、事件收集不覆盖 BUILTIN、显式空数组全禁、未分组工具恒并入、reconcile 旧预设整体替换+自定义保留+defaultEnabled 覆盖保留+缺字段补 true。这些测试让"纯函数层"成了可独立验证的真相源。

## 两个 UI 表面：ToolManagerPage 与 ToolPanelTab

插件提供两个用户入口，职责严格分离。

**`ToolManagerPage`**（settings 槽，第 121-227 行）管**工具组的全局管理**（项目级配置）。它用 `useDiscoveredTools()` 拿全量工具、`useToolGroups(currentCwd)` 拿组、`useSessionToolConfig` 不参与。`refreshSignal` 的 effect（第 129-135 行）只做一件事：`if (refreshSignal > 0) void reload()` 重读磁盘。注释记录了一个真实根因：刷新信号绝不能反向 save——写 tool-groups.json 会再触发 `settings:changed` 广播 → 设置页 bump refreshSignal → 本 effect 又 save，自激死循环（曾致 settingsChanged 每秒数百次、renderer CPU 打满）。这是"根因修复不打补丁"的活案例，直接写进代码注释防回归。页面布局是"组管理区 + 全量工具区"两段：上半部分 `sortedGroups`（builtIn 优先排序）渲染 `GroupRow`，可编辑/删除（builtIn 组不显示删除按钮，`onDelete={g.builtIn ? undefined : ...}`）；下半部分 `allTools.map` 渲染 `ToolRow`，每个工具标注它所属的组（`toolGroups = groups.filter(g => g.toolIds.includes(tool.id))`），无显式组的工具无组标签——恒可用。

**`ToolPanelTab`**（sidePanel 槽，第 455-613 行）管**会话级开关**。它读 `useUiStore` 的 `currentCwd`、`currentSessionPath`、`sessionTitle`、`pendingToolConfig`、`setPendingToolConfig`，用 `useSessionToolConfig(currentSessionPath)` 读会话头配置，用 `useToolGroups(currentCwd)` 读组定义。生效开关的优先级是代码第 489-518 行 effect 钉死的三段：**pending > session 头 > 组默认**。具体展开：`cfg = pending ? pending.config : headerConfig`；若 `cfg.enabledGroupIds` 缺失（无配置）→ 回落组默认 `computeDefaultEnabledGroupIds(groups)`；若显式空数组 → 全关（不回落，空即零工具的显式语义）；若 id 全是已退役组（旧预设 files/exec 遗存）→ 配置失效，回落组默认并挂起 pending 待下次发送自愈落盘。第 464-470 行有两个防死循环的细节：`gateAvailable` 状态探测 tool-gate 可用性；`allToolsRef` 是因为 `mergeKnownTools` 每次渲染都返回新引用，进 effect deps 会死循环，所以 effect 里经 ref 读最新值、deps 只挂稳定引用。降级提示区（第 552-563 行）在 `!gateAvailable && restrictive`（有过滤动作但 tool-gate 缺席）时显示两条警告文案 `gateUnavailable` 和 `softFilterWarn`——这是 §7.6"显式降级不静默"的 UI 呈现。

两个入口共享 `useToolGroups` 的配置读写（第 68-105 行）：`ctx.config.get<ToolGroup[]>("groups")`，读不到时 `ctx.config.set("groups", PRESET_GROUPS)` 写预设；读到的组经 `reconcilePresetGroups` 换新；save 直接 `ctx.config.set("groups", newGroups)`。这里用的是框架的统一配置通道——`ctx.config` 按 pluginId 推导路径 `<cwd>/.my-harness-desktop/config/tool-manager.json`（项目级），全局兜底，插件不手写任何路径。

## 与其他插件 / 内核的交互（专节）

tool-manager 是一个**低协作度的插件**，它不 emit/invoke 任何 channel、不声明 `dependsOn`、不 import 任何兄弟插件的代码。它的交互对象分两类：

**与壳（框架）的交互**——全是受控 API 调用，无事件总线参与：

- `ctx.sessions.listTools()` / `ctx.sessions.readToolConfig(path)`：读内核工具清单和会话工具配置，走中立契约。前者对应 `BaseBackend.listTools?`，后者对应 `SessionCatalog.readToolConfig`。
- `ctx.config.get/set("groups")`：工具组的项目级持久化，走框架统一配置通道。
- `ctx.kernels.pi.fitPiExtensionAvailable?.()`：探测 pi 内核扩展面 tool-gate 是否安装，决定降级警告是否显示。这是"有则用、无则降级"的能力探测，不是 `if (kernel === "pi")` 硬分支。
- `ctx.sessions.onEvent`：订阅活跃会话中性事件流，做 `toolCallStart` 的事件收集兜底。

**与内核 / 内核插件的交互**——这是 tool-manager 真正的"能力下游"，但都不在本插件目录：

- 工具清单的**权威生产者**是 `packages/my-harness-fit-pi-extension/toolgate.ts` 的 `announceTools`（写 `~/.pi/agent/desktop-known-tools.json`），tool-manager 是它的消费者。两者之间没有直接调用，只有**文件契约**（`known-tools.ts` 的 `readKnownTools` 读同一个文件）和**类型契约**（`KnownToolInfo` 圆心单源）。
- 工具过滤的**硬执行者**是同一扩展的 `applyFromHeader`（`pi.setActiveTools`），tool-manager 写进头行的 `custom-my-harness-desktop.toolConfig.enabledToolIds` 是它的输入。tool-manager 从不直接调 `setActiveTools`——它只写头行，执行交给内核扩展。
- 工具过滤的**软执行者**是壳前端 `src/web/stores/session-store.ts` 的 `buildToolLimitNote`，在 tool-gate 缺席时把限制拼进 prompt。tool-manager 通过 `fitPiExtensionAvailable` 探测到缺席后只显示警告，拼提示的动作由 session-store 在 send 路径完成。

**槽位名清单**：tool-manager **贡献** `settings`（`tools` 页）、`sidePanel`（`tools` Tab）、`languages`（三命名空间）；**不贡献**任何其他槽位；**不消费**任何兄弟插件的槽位。**channel 清单**：无。**dependsOn 清单**：无（符合 §8.2——它不消费任何人的 channel，自然无需 dependsOn）。

这份低协作度是**故意的、正确的**：工具配置的语义闭环（清单→组→开关→头行→硬过滤）只涉及"壳 + 内核 + 内核扩展"三方，不需要也不应该有第四方插件介入。如果未来有插件想复用"工具清单"数据，正确姿势不是 tool-manager 提供 channel，而是那个插件自己调 `ctx.sessions.listTools()`——因为清单的真相源在内核，不在 tool-manager 的内存态。

## QA

**Q：为什么工具发现走播报文件而不是内核 RPC？**

因为 pi 内核至今没有 `get_tools` 命令。设计文档 `docs/design/tool-manager-design.md` §4.1 原规划的 `get_tools` RPC 被 v4 修订取代——实测安装态内核的 `rpc-types.d.ts` 里没有该命令，桌面单方面加不了，继续等是被上游卡脖子。v4 改走"tool-gate 播报 + 侧车文件"：tool-gate 扩展沙箱里已有 `getAllTools()` 现成 API（带 `sourceInfo` 来源元数据），在 `turn_start` 把它写进 `~/.pi/agent/desktop-known-tools.json`，桌面经 `PiBackend.listTools` 读回。这与 v3 用扩展 API `setActiveTools` 替代 `set_tool_filter` RPC 是同一思路——扩展沙箱里已有的能力，不等 RPC。将来 dsh 若提供 `session/listTools`，`DshBackend` override 一下 `listTools` 即可，契约不用动。

**Q：为什么播报挂在 `turn_start` 而不是 `session_start`？**

这是 v4 落地后实测修正（设计文档 §4.4.3）。bus/subagent 这类桌面扩展把 `registerTool` 门控在与 desktop 的握手之后：`session_start` 时扩展先 ping desktop，应答到达才注册工具，所以 `session_start` 时 `getAllTools()` 只返回核心 7 个。此时播报会把 byCwd 里已有的好桶回写成残缺集，而热进程每次 spawn 都触发 `session_start`——每次 app 重启 bucket 就被退化一次，直到下一个 turn 才自愈。`turn_start` 时握手早已完成（desktop 即时应答，毫秒级），集合才是权威。

**Q：为什么 `ToolManagerPage` 的 refreshSignal 只能重读、绝不能反向 save？**

因为写 `tool-groups.json` 会触发 `settings:changed` 系统广播，广播又会让设置页 bump `refreshSignal`，若 effect 里收到 refreshSignal 就 save，就形成"save → 广播 → bump refreshSignal → effect save → 广播 → …"的自激死循环——注释记录的实锤是 settingsChanged 每秒数百次、renderer CPU 打满、设置页闪卡暗态。正确语义是：refreshSignal 只代表"重读磁盘"（框架刷新按钮 / settings:changed 广播），save 只由用户的显式编辑动作（handleSaveGroup/handleDelete）触发，两条路径永不相交。

**Q：dsh 内核下工具过滤是什么行为？**

三层降级，全部显式、不静默。① `DshBackend` 继承 `AbstractBackend.listTools` 的缺面默认，返回 null——工具清单只有 BUILTIN_TOOLS + 事件收集兜底。② `DshSessionCatalog.readToolConfig` 直接返回 null——按"无配置"处理，ToolPanelTab 回落组默认，`enabledToolIds` 为空。③ 发送路径里 `fitPiExtensionAvailable()` 对 dsh 无意义（tool-gate 是 pi 专属扩展），软注入提示只在 pi + 无 gate 时拼。这意味着 dsh 下工具过滤实际上不生效（没有硬过滤执行者），但 UI 不假装成功——它显示的是"当前内核无工具过滤能力"的诚实状态，而不是伪造一个过滤开关。

**Q：`enabledGroupIds` 显式空数组和字段缺失有什么区别？**

这是两个语义，代码里刻意区分。字段缺失（`cfg.enabledGroupIds` 是 `undefined`）= 无配置，回落组默认 `computeDefaultEnabledGroupIds`（defaultEnabled 的组）。显式空数组 `[]` = 全禁，不回落——"空即零工具的显式语义"，`computeEnabledToolIds` 第一行 `if (enabledGroupIds.length === 0) return []` 直接短路，tool-gate 侧 `setActiveTools([])` 硬禁全部。如果二者混同（把空数组也当无配置回落），用户"全部关闭"的意图就被静默吞掉了。

**Q：为什么"未被任何组收录的工具恒可用"，会不会让组过滤形同虚设？**

这是有意的默认全开策略，不是漏洞。`computeEnabledToolIds` 第 115-121 行：先算所有组收录过的工具集合 `assigned`，再把 `allTools` 里不在 `assigned` 的工具并入 `enabled`。理由写在第 113-114 行注释：组开关只控制组内工具，新扩展工具开箱可用（默认全开），不被静默挡在门外。想禁用某个未分组工具，正确做法是"把它加进某个组再关组"——这避免了 custom 模式硬白名单把从未被发现的扩展工具静默挡在门外的问题（设计文档 §4.4 指出的过渡期功能后果）。代价是：如果用户预期"关掉所有组 = 只留我显式开的工具"，未分组工具仍会放行——但这个语义是显式的、可预测的，且只在自定义组时代价显著，预设四组已覆盖核心+扩展工具的绝大多数。
