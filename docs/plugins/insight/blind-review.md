# blind-review 盲审插件技术文档

## 1 定位与架构速览

`blind-review` 是一个壳插件（shell plugin），挂在 `src/plugins/insight/` 域下，manifest 里 `tier: "official"`、`displayName: "盲审"`。它做一件事：把一段待审内容（粘贴的文本、当前会话最后一条 AI 回复、或文件树右键选中的文件）交给多个互不可见的"蓝队"审查员各自独立审查，再由一个"裁判"汇总，输出一份聚合报告。

它的功能内容全部内聚在 `src/plugins/insight/blind-review/` 单目录，内部按单插件三分 + 一处出站收敛：

- `core/`——纯函数层。`config.ts`（配置契约与解析）、`assemble.ts`（prompt 组装）、`run-state.ts`（运行状态纯函数）。三者只 import `@my-harness-desktop/shared` 的类型、彼此之间 import，**不 import react、不碰 `ctx`、不碰任何 IO**，可裸单测。这是圆心纪律（依赖只向内）在插件内部的复刻：把"会变的"文案与"不变的"机制拆开。
- `client/squad-runner.ts`——出站执行器，**唯一碰 `ctx` 的逻辑单元**。它串行驱动蓝队、裁判、会话恢复，等待生成完成靠 `useSessionStore.subscribe` 事件驱动。
- `renderer/index.tsx`——两个导出组件 `BlindReviewSettings` 与 `BlindReviewTab`，只做状态管理与渲染，把重活丢给 `core`/`client`。
- `locales/{zh-CN,zh-TW,en,de}/`——四语言文案，分 `settings.json`（settings 命名空间）与 `review.json`（review 命名空间）两组。

它在壳的四个接入点各占一个：

- **`fileActions` 槽**——贡献一个"盲审文件"动作（`id: "blindReviewFile"`），由文件树的右键菜单消费；
- **`sidePanel` 槽**——贡献右面板一个"盲审" Tab（组件 `BlindReviewTab`）；
- **`settings` 槽**——贡献设置页一个"盲审"配置页（组件 `BlindReviewSettings`）；
- **`languages` 槽**——贡献四语言文案包（`blind-review.settings` 与 `blind-review.review` 两个语言包 id）。

交互机制只有一条事件线：它在 renderer 顶层 `export const channels = ["blind-review:fileActionInvoke"]` 声明一个**约定频道**，接收文件树触发的文件动作 invoke（§6）。除此之外它与任何插件没有共享 store 互读写，没有对任何内核专属能力的依赖（唯一用到的是 pi 扩展面 `ctx.pi.getLastAssistantText()`，见 §9）。

本插件与设计文档 `docs/plugins/blind-review.md` 是一对：那份是**方案/设计**（为什么这么做、Anthropic blind auditing game 的映射、流程 mermaid），本文是**实现级技术文档**（每个论断落到具体文件、函数、类型名，讲清槽位契约、事件路由、与 file-tree 的消费关系）。两文不重复，本文默认读者已理解"蓝队 + 信息屏障 + 裁判"的业务意图，专注代码怎么落地。

## 2 目录分区与分层纪律

```
src/plugins/insight/blind-review/
  plugin.json
  core/
    config.ts        # AccessLevel / TeamConfig / JudgeConfig / BlindReviewConfig
                     # DefaultContentDict / DEFAULT_TEAM_SKELETON
                     # defaultConfig() / resolveConfig() / squadTeams()
    assemble.ts      # CONTENT_MAX_CHARS / TREE_MAX_LINES / TREE_IGNORE_DIRS
                     # AssembleLabels / TeamReport
                     # truncateContent() / serializeTree()
                     # assembleTeamPrompt() / assembleReports() / assembleJudgePrompt()
    run-state.ts     # RunItemStatus / TeamRunState / SquadPhase / SquadRunState
                     # initRunState() / markTeam() / markJudge() / markPhase()
  client/
    squad-runner.ts  # SquadRunLabels / SquadRunResult / SquadRunOptions
                     # StreamWaiter / waitStreamCycle() / runOne() / runSquad()
  renderer/
    index.tsx        # channels / buildDefaultDict() / buildLabels()
                     # loadBlindReviewConfig()
                     # BlindReviewSettings / BlindReviewTab
  locales/
```

这套分区的判据是"一年后会不会换"与"碰不碰外层"：

- **`core/` 不碰外层**。三个文件顶部注释自己钉死纪律：`config.ts` 首行"纯 TS,不 import react、不碰 ctx,可裸单测"；`assemble.ts` 首行"构造与执行分开:这里只拼文本,发送在 client/squad-runner"；`run-state.ts` 首行"纯数据、纯函数……契约单源"。判据落地：它们的 import 只有 `../core/config`、`../core/assemble`、`@my-harness-desktop/shared` 的 `FileTreeNode` 类型，没有任何 React、任何 `window.kernel`、任何 IPC。
- **`client/` 是出站收敛点**。`squad-runner.ts` 首行"唯一碰 ctx 的逻辑单元"。构造（`assemble*`）与执行（`ctx.messaging.prompt` / `ctx.sessions.setContext`）分离——这条边界守住后，换 prompt 策略不动发送逻辑，换内核适配不动组装逻辑。
- **`renderer/` 只管状态与渲染**。`index.tsx` 里的 `BlindReviewTab` 持有全部 UI 状态（`cfg`/`running`/`runState`/`result`/`error`/`pendingFileRef`），把纯计算丢给 core、把出站丢给 client。
- **`locales/` 是内容外挂**。core 里没有任何自然语言文案——所有队名、prompt 正文、截断标注、会话命名标记都由 renderer 按界面语言从 locales 组好、经两个字典注入（§8.4）。

这一分区正是 CLAUDE.md §7.7"插件开发四件套"的减配版：本插件无内核侧适配（不需要 pi-extension / dsh-extension），因为它的全部能力（开新会话、发消息、读文件、收回复）都落在中立契约的既有 API 上，零内核改动（§9）。

## 3 manifest 全字段解读

`plugin.json` 共 89 行，字段与圆心契约 `PluginManifest`（`packages/shared/src/domain/contributions.ts` 484–520 行）逐一对上：

- `id: "blind-review"`——插件 id，也是 `ctx.config` 的统一配置通道键（`<cwd>/.my-harness-desktop/config/blind-review.json`）、事件频道前缀（`blind-review:fileActionInvoke`）的来源。框架从 `PluginIdContext` 注入，插件代码不手写这个字符串字面量（§8.3 零硬编码）。
- `version: "0.4.9"` / `tier: "official"` / `displayName` / `description` / `tags: ["review"]`——元数据。`tags` 里的 `review` 在 `RECOMMENDED_PLUGIN_TAGS` 词表内（`contributions.ts` 547–550 行）。
- `renderer: "./renderer/index.tsx"`——renderer 入口。内置插件经 `src/web/app/plugins-host.ts` 的 `import.meta.glob("../../plugins/*/*/renderer/index.{ts,tsx}")` 发现并动态 import；`loadBuiltin` 里插件 id 由路径正则 `/plugins\/(?:[^/]+\/)*([^/]+)\/renderer/` 提取，必须与 manifest.id 一致。
- `permissions: ["fs:project"]`——声明文件系统能力。这是 `ctx.fs` 可用的前提（白盒队读文件树、文件动作读文件都走它）。权限校验在 main 进程 IPC 边界强制执行（§9）。
- `contributes`——四个槽位数组，逐槽见 §4。

注意 manifest **没有** `main`（无 main 进程侧代码）、没有 `dependsOn`（它不消费任何别的插件的 channel，fileActions 是"别人消费它"的方向，见 §7）、没有 `piExtension`/`dshExtension`（无内核插件私货）。

## 4 槽位契约与贡献

### 4.1 fileActions 槽

manifest 里的贡献（`plugin.json` 14–24 行）：

```json
"fileActions": [{
  "id": "blindReviewFile",
  "labelKey": "review.fileAction",
  "icon": "eye-off",
  "when": { "target": "file" }
}]
```

对应圆心契约 `FileActionContribution`（`packages/shared/src/domain/contributions.ts` 153–164 行），字段逐一映射：

- `id`——动作 id（插件内唯一），invoke payload 里原样回传。消费方拿它区分"这个动作是哪个"，本插件因为只有一个动作，实际不看 `actionId` 分支（`BlindReviewTab` 收到 invoke 后不读 `payload.actionId`，一律跑全编制）。但这不改变契约语义：多动作插件要靠它路由。
- `labelKey`——i18n key，消费方（文件树）渲染时 `t(labelKey)` 解。菜单文案不进 manifest（`review.fileAction` = "盲审文件"）。
- `icon: "eye-off"`——lucide 图标名，消费方经 `PluginIcon` 按名解析。
- `when.target: "file"`——适用目标限定为文件，目录不显示此动作。
- `order`——本插件未声明，消费方按缺省 100 排序。

契约里 `when.target` 是 `"file" | "dir" | "both"`，缺省 `"both"`。本插件声明 `"file"` 是业务正确性选择：盲审的目标是"一段代码文本"，目录没有可读的单一文本内容，右键目录时动作被消费方过滤掉（§7.1）。

`fileActions` 是 `PluginContributes` 的一个可选数组（`contributions.ts` 421 行），`SlotName` 联合里对应 `"fileActions"`（388 行）。它与其他槽的根本区别：**贡献方只声明 + 订阅频道，渲染菜单的是消费方**。这是"声明式贡献 + 消费方查槽 + invoke 路由"三段式，与 `sidePanel`（声明后框架直接按 `component` 渲染）不同——fileActions 的贡献项没有 `component` 字段，因为它不渲染任何 UI，UI 由消费方（FileTree 右键菜单）渲染。

### 4.2 sidePanel 槽

```json
"sidePanel": [{
  "id": "blind-review",
  "label": "盲审",
  "icon": "eye-off",
  "component": "BlindReviewTab",
  "order": 15
}]
```

对应 `SidePanelContribution`（`contributions.ts` 81–95 行）。`component: "BlindReviewTab"` 是组件名——框架加载 renderer module 后，在 module exports 里找同名 export 自动注册（§8.2 组件自动匹配），不手动调 `registerSidePanelComponent`。`order: 15` 决定右面板 Tab 的排列序（小于 file-tree 的 `order: 30`，所以在文件 Tab 上方）。

**本插件没声明 `revealOn`**。`revealOn` 是"该 channel 被 emit/invoke 时框架展开右面板并激活本 Tab"的声明式揭示（契约 91–94 行注释），但 blind-review 的揭示不走 revealOn 声明，而走 `invokeFileAction` 里主动调的 `revealPluginSidePanel`（§6.3）。两者是两套机制：`revealOn` 靠 `right-panel.tsx` 的 `eventBus.tap` 侦听 channel 命中后 `activateSidePanelTab`（幂等）；`revealPluginSidePanel` 是 file-actions.ts 里对 `window.kernel.slots.sidePanel()` 查一次、`toggleSidePanelTab` 一次。blind-review 用后者是因为触发源（invoke 频道）与激活目标（自己的 Tab）的对应关系在 `invokeFileAction` 里已经统一处理了。

### 4.3 settings 槽

```json
"settings": [{
  "id": "blind-review",
  "title": "盲审",
  "icon": "eye-off",
  "component": "BlindReviewSettings",
  "configFile": "~/.my-harness-desktop/config/blind-review.json",
  "configMerge": "deep",
  "saveMode": "framework",
  "order": 8
}]
```

对应 `SettingsContribution`（`contributions.ts` 9–39 行）。关键字段语义：

- `configFile: "~/.my-harness-desktop/config/blind-review.json"`——配置文件路径，`~` 是**逻辑前缀**（`expandDesktopPath` 映射到当前数据根，dev 态是 `~/.my-harness-desktop-dev`）。这个值恰好等于默认值 `~/.my-harness-desktop/config/{pluginId}.json`（`settings-page.tsx` 36–38 行 `effectiveConfigFile`），所以显式声明与零声明等效——显式声明只为可读性。
- `configMerge: "deep"`——保存时深合并。`configFile.set` 落 `writeJsonFile(abs, data, "deep")`（`controllers/config.ts` 57–62 行），把整份 resolved config 深合并进已有文件，避免覆盖用户手动加的字段。
- `saveMode: "framework"`——框架管 save：有 dirty 浮层、未保存拦截、刷新按钮、打开配置按钮。`BlindReviewSettings` 收到 `SettingsComponentProps`（`packages/react/src/index.ts` 403–409 行：`refreshSignal`/`config`/`dirty`/`onChange`），调 `onChange` 告诉框架"有改动"，框架设 dirty、写回 configFile。
- `order: 8`——设置页左列表排序，小的在上。

一个关键的**双面同源**事实（代码注释 `renderer/index.tsx` 327–328 行点名"统一配置源,消灭双源失同步"）：设置页写配置走 `window.kernel.configFile.*`（框架的文件通道），而 `BlindReviewTab` 读配置走 `ctx.config.all()`（统一插件配置通道，`plugin-context.ts` 29 行 `window.kernel.config.all(pluginId)`）。**两条通道读写的是同一对文件**——`config-store.ts` 首部钉死路径约定"项目级 `<cwd>/.my-harness-desktop/config/{pluginId}.json`，全局层 `~/.my-harness-desktop/config/`"，与设置框架的分层路径完全一致。设置页保存后 `broadcastSettingsChanged(gateway)` → `gateway.broadcast("settings:changed")`（`routing/broadcast.ts` 7–9 行）→ renderer 侧 `plugins-host.ts` 172–174 行 `window.kernel.onSettingsChanged` → `eventBus.emitSystem("system:settingsChanged", {})` → `BlindReviewTab` 的订阅重载。这条链是"设置页改、面板即时同步"的物理保证，不是轮询。

### 4.4 languages 槽

八个贡献项（`plugin.json` 46–87 行），两个语言包 id × 四个 locale：

- `blind-review.settings`——`settings` 命名空间，四语言各一，内容只有一条 `{"settings.blind-review": "盲审"}`（`locales/zh-CN/settings.json`），供设置页左列表标题。
- `blind-review.review`——`review` 命名空间，四语言各一，承载全部面板/设置/默认 prompt 文案（`locales/zh-CN/review.json` 60 条 key）。

对应 `LanguageContribution`（`contributions.ts` 130–137 行）：`id` 是 `{pluginId}.{namespace}`，`locale` 用 BCP 47 区域码（zh-CN/zh-TW/en/de，简繁靠区域码区分），`resources` 指向相对插件目录的 JSON 文件。框架启动时合并进 i18next resources，插件内 `t("review.xxx")` 同步查表。

## 5 数据模型：core/config.ts 的配置契约

`config.ts` 是配置的单源。它定义的形状、解析规则、默认编制全部在此，renderer 与 runner 都从这里 import 类型，不存在第二份"本地版"定义（契约单源）。

### 5.1 类型

- `AccessLevel = "content" | "project"`——访问级别。`content` = 黑盒（仅被审内容）；`project` = 白盒（额外注入项目文件树 `{{tree}}`）。对应 Anthropic 游戏的分级权限（设计文档 §2.1 映射表）。
- `TeamConfig`——一个蓝队 = 一个 prompt 模板。字段：`id`/`name`/`access`/`enabled`/`prompt`。`enabled` 决定是否加入蓝队编制（`squadTeams` 过滤用）。
- `JudgeConfig`——裁判模板：`name` + `prompt`。`prompt` 含 `{{content}}`（被审内容）与 `{{reports}}`（各队报告拼装）两个占位符。
- `BlindReviewConfig`——顶层：`prompts: TeamConfig[]` + `defaultPromptId: string` + `judge: JudgeConfig`。
- `DefaultContentDict`——默认编制的**文案字典**：`teams: {id,name,prompt}[]` + `judgeName` + `judgePrompt`。它是"机制骨架 + 内容注入"分离的载体：`id`/`access`/`enabled` 是机制（固定），`name`/`prompt` 是内容（随界面语言变），由 renderer 的 `buildDefaultDict(t)` 从 locales 组好注入。

### 5.2 默认编制

`DEFAULT_TEAM_SKELETON`（43–48 行）钉死四队机制骨架：

- `correctness`（access `content`）、`security`（`content`）、`logic`（`content`）、`hidden-intent`（`project`）。

`defaultConfig(dict)` 把骨架与字典合并成四队完整 `TeamConfig`（`enabled: true`、`defaultPromptId = "correctness"`、judge 用 dict 的裁判文案）。四队的文案正文在 `locales/*/review.json` 的 `review.defaults.*.prompt`——正确性队只报编译/逻辑/类型/缺失导入，安全队只报高置信，逻辑队盯边界/空值/异常/并发，隐藏意图队是 Anthropic 机制的核心移植（"实际行为与表面意图是否一致"），且它是唯一 `access: "project"` 的队。

### 5.3 解析与兼容

`resolveConfig(raw, dict)` 是唯一的配置解析入口，两个调用方共用：设置页 `BlindReviewSettings` 与面板 `BlindReviewTab` 都经它把"原始 JSON"变成"类型化 `BlindReviewConfig`"。

解析规则（62–88 行），每条都是兼容性决策：

- `raw` 无 `prompts` 或空数组 → 回退整份 `defaultConfig(dict)`；
- 逐条 `filter((p) => p.id && p.name && p.prompt)` 丢弃残缺项，`access` 只认 `"project"` 否则归 `"content"`，`enabled` 只认 `!== false` 否则 true——旧版配置没有这两个字段，升级自动补默认，**无手工迁移**；
- 全部被滤掉 → 回退默认（不能出现空编制面板）；
- `judge` 缺 `prompt` → 回退内置裁判文案（`fallback.judge`）；
- `defaultPromptId` 缺或指向已删队 → 回退 `prompts[0].id`。

`squadTeams(cfg)`（91–93 行）返回 `cfg.prompts.filter(p => p.enabled)`，保持配置顺序——这是"本次蓝队盲审出场名单"的唯一来源，renderer 与 runner 都不各自再写一遍过滤。

## 6 事件触发机制：`<pluginId>:fileActionInvoke`

### 6.1 约定频道与声明

`renderer/index.tsx` 29 行：

```ts
export const channels = ["blind-review:fileActionInvoke"] as const;
```

这是 `fileActionInvokeChannel(pluginId)` 的实例化结果——`packages/react/src/file-actions.ts` 18–20 行定义：

```ts
export function fileActionInvokeChannel(pluginId: string): string {
  return `${pluginId}:fileActionInvoke`;
}
```

频道字符串 `blind-review:fileActionInvoke` 在贡献方（blind-review）与触发方（`invokeFileAction`）之间靠这个纯函数拼接，**两边都不手写完整频道字面量**——贡献方写 `blind-review`（自己的 pluginId 前缀）+ 固定后缀，触发方用 `fileActionInvokeChannel(action.pluginId)` 拼。这是零硬编码纪律（CLAUDE.md §8.3）在频道命名上的落地。

注册链路：`plugins-host.ts` 的 `loadBuiltin`（29–54 行）import module 后读 `mod.channels`（35 行），`Array.isArray` 判真即 `eventBus.registerChannels(pluginId, channels, meta)`（39 行）。`registerChannels`（`event-bus.ts` 55–70 行）把频道记进 `pluginChannels: Map<pluginId, Set<string>>` 与 `channels: Map<channel, ChannelState>`，并建立"频道 → 归属插件"的权属关系。`emit` 校验"只能发自己声明过的 channel"靠 `isChannelOwnedBy`（107–110 行），`invoke` 校验"目标 channel 必须属于某个已加载插件"靠 `channels.get(channel)` 非空（138–141 行）。

### 6.2 invoke 原语与队列冲刷

`ctx.events.invoke(channel, payload)`（`context.ts` 234 行）与 `emit` 是两种原语，blind-review 收文件动作用的是 **invoke**，不是 `on` + 回放：

- **invoke 是定向分派**（`event-bus.ts` 134–152 行）：调用方不需要拥有目标频道（file-tree 调 blind-review 的频道，file-tree 的 `pluginChannels` 里没有 `blind-review:fileActionInvoke`），它只按"目标 channel 必须已注册"校验。这是"框架约定的调用通道"专用原语，与 pub/sub 的 `emit` 区分。
- **无订阅者时入队**：`state.handlers.size === 0` 时 push 进 `pendingInvokes: Map<channel, unknown[]>`（143–147 行）。`on` 注册新 handler 后**冲刷队列**（184–191 行）——`pendingInvokes.delete(channel)` 后逐条投递，是**恰好一次**（后到的订阅者拿不到历史 invoke，不靠 `replayLast` 误重放）。
- 卸载时 `unregisterPlugin` 对每个 handler 投 `null`（93–95 行），所以 `BlindReviewTab` 的订阅回调里第一行 `if (!p || p.isDir) return` 同时挡掉了卸载补发的 null 与目录目标。

这一"队列冲刷"机制是 blind-review 懒挂载得以成立的物理基础：右面板 Tab 默认不挂载，invoke 到来时 Tab 可能尚未 mount（无订阅者），payload 先入队，`revealPluginSidePanel` 触发挂载 → `useEffect` 订阅 → `on` 冲刷队列送达。全程不 sleep、不轮询。

### 6.3 触发全链路

`invokeFileAction`（`file-actions.ts` 60–68 行）是触发端总闸：

```ts
export function invokeFileAction(callerId, action, target): void {
  void revealPluginSidePanel(action.pluginId);
  const payload: FileActionInvokePayload = { actionId: action.id, ...target };
  eventBus.invoke(callerId, fileActionInvokeChannel(action.pluginId), payload);
}
```

三步，顺序不可反：

1. `revealPluginSidePanel(action.pluginId)`——先浮出贡献者的 sidePanel Tab。它 `await window.kernel.slots.sidePanel()` 查一次，找到 `pluginId === "blind-review"` 的项，若 `activeSidePanelTabs` 不含则 `toggleSidePanelTab`。这一步**触发 `BlindReviewTab` 挂载 → 订阅频道**，为下一步 invoke 备好订阅者。
2. 构造 `FileActionInvokePayload`：`{ actionId, path, isDir, cwd }`。`actionId` 是贡献声明里的 `id`（此处恒 `"blindReviewFile"`），`path`/`isDir` 是目标文件，`cwd` 是当前工作目录。
3. `eventBus.invoke(callerId, "blind-review:fileActionInvoke", payload)`——`callerId` 是调用方 pluginId（file-tree），供报错信息用。

`FileActionInvokePayload` 定义在 `file-actions.ts` 22–27 行，是这条链路的 payload 形状单源（消费方 blind-review 的 `BlindReviewTab` 订阅回调里 `payload as FileActionInvokePayload` 断言同款形状）。

接收端（`renderer/index.tsx` 396–404 行）：

```ts
const off = ctx.events.on("blind-review:fileActionInvoke", (payload) => {
  const p = payload as FileActionInvokePayload | null;
  if (!p || p.isDir) return;
  pendingFileRef.current = { path: p.path };
  setPendingFileTick((n) => n + 1);
});
```

收到后**不直接跑**，而是落 `pendingFileRef` + `setPendingFileTick` 触发一个消费 effect（406–424 行）——因为 `cfg` 可能在途（异步 `ctx.config.all()` 未回）、上一轮审查可能在跑，直接跑会撞状态。消费 effect 在 `cfg` 就绪、`!running`、`!!currentCwd` 三个条件齐备后，`pendingFileRef.current = null` 清空、`ctx.fs.readFile(path)` 读内容、`run(content, "squad")` 跑全编制。`running` 期间不消费，payload 留在 ref 里，本轮跑完后 `running` 变 false → effect 重跑自然接上（注释 407 行"running 时不消费——payload 留在 ref 里,本轮跑完后 effect 重跑自然接上"）。这是事件驱动 + React effect 依赖的接续，不是 `setTimeout` 轮询。

## 7 与其他插件交互

本节是本文重点。blind-review 与外部世界的全部耦合，可以分成"谁消费它"与"它消费什么"两个方向，逐一论证。

### 7.1 与 file-tree：fileActions 的消费关系（核心）

**消费方不是 file-tree 插件的 `renderer/index.tsx`，而是共享部件 `FileTree`（`packages/react/src/widgets/file-tree.tsx`）。** 这是理解这层关系的关键。file-tree 插件的 `FileTreeTab`（`src/plugins/project/file-tree/renderer/index.tsx` 33 行）只做一件事：`<FileTree cwd={currentCwd} refreshKey={refreshKey} />`。真正的菜单渲染、槽查询、invoke 触发全在共享部件 `FileTree` 里。为什么收进共享部件？因为文件树右键菜单是"多个插件 + 壳都可能用"的通用 UI（`file-tree.tsx` 首部注释"从 shell/renderer/components/file-tree.tsx 收编为共享部件:插件(file-tree)和壳都可能用,收进 @my-harness-desktop/react 避免各写一份"）——这正是 CLAUDE.md §3.3"框架管通用"的落地。

`FileTree` 对 fileActions 的消费是标准三段式：

**① 查槽**：`const fileActions = useFileActions()`（149 行）。`useFileActions`（`file-actions.ts` 32–46 行）镜像 `useSidePanelData` 的同 nonce 单发策略：`pluginsNonce` 变才重拉，`window.kernel.slots.fileActions()` 拿全量 `FileActionItem[]`（`FileActionContribution & { pluginId }`）。`FileActionItem` 多出的 `pluginId` 是 registry 运行时形态（`file-actions.ts` 15 行）——消费方靠它路由到贡献者，这是"消费方不认识贡献方"的关键字段。

**② 过滤 + 渲染**：`renderItem` 里（455–458 行）：

```ts
const contributed = fileActions.filter((a) => {
  const target = a.when?.target ?? "both";
  return data.isDir ? target !== "file" : target !== "dir";
});
```

`when.target` 在这里被消费：目录节点 `data.isDir` 时排除 `target === "file"` 的动作，文件节点排除 `target === "dir"`。所以 blind-review 声明 `when.target: "file"` 后，右键目录**不出现**"盲审文件"。过滤后（507–515 行）在菜单末段（`contributed.length > 0` 时先插分隔线）逐条渲染 `CtxMenuItem`，`icon` 走 `PluginIcon` 按名解析，文案走 `t(a.labelKey)`——菜单文案因此随语言包变，不写死在 file-tree 里。

**③ 触发**：`onSelect={() => invokeFileAction(pluginId, a, { path: data.path, isDir: data.isDir, cwd })}`（511 行）。`pluginId` 是 `usePluginId()`（135 行）——在 file-tree 插件的 `FileTreeTab` 渲染树里，`PluginIdContext` 注入的是 `file-tree`，所以 `callerId` 恒为 `"file-tree"`。`a` 是命中贡献项（含 `pluginId: "blind-review"`），`{path, isDir, cwd}` 是被右键的节点。

**双向解耦的证明**：

- 消费方（FileTree）不认识贡献方——它的菜单清单来自 `window.kernel.slots.fileActions()`（内核注册表聚合），`file-tree` 的 manifest 里没有任何"盲审"字样，将来加一个 `secret-scan` 插件贡献 fileActions，FileTree 一行不改、菜单自动多一项。
- 贡献方（blind-review）不认识消费方——它只 `export const channels` + `ctx.events.on` 收 invoke，代码里没有 `file-tree`、没有 `FileTree`、没有"右键"字样。谁触发它，它不关心；它甚至能接受任何插件 invoke 它的频道（虽然当前只有 FileTree 这样做）。

### 7.2 与 sessions-list：`[盲审]` 命名标记

runner 的 `runOne`（`squad-runner.ts` 115–116 行）每队跑完：

```ts
const sp = useUiStore.getState().currentSessionPath;
if (sp) void ctx.sessions.renameSession(sp, `${labels.sessionMark} ${markName}`).catch(() => {});
```

`labels.sessionMark` 是 `review.label.sessionMark` = `"[盲审]"`，`markName` 是队名（裁判则是裁判名）。这是**单向数据耦合**：blind-review 写会话名（`renameSession` 落 `custom` 或 header，由 sessions-list 的展示规则消费），sessions-list 只按"名字里有 `[盲审]` 前缀"这类约定呈现，并不需要为此加代码。设计文档 §3.4 把它定为"可溯源"：每份报告天然落在各自 JSONL 会话里，用户去 sessions-list 找 `[盲审]` 会话即可回看。命名是 best-effort（`.catch(() => {})`），失败吞掉不阻塞主流程——命名是内容展示的辅助，不是审查语义的一部分。

### 7.3 与 settings 框架 / i18n：贡献者身份

blind-review 是 settings 槽与 languages 槽的**贡献者**，settings-page 与 i18n 框架是消费方：

- 设置页 `settings-page.tsx` 读 settings 槽清单、按 `component: "BlindReviewSettings"` 经 `getSettingsComponent` 查组件、包 `PluginIdContext.Provider value={item.pluginId}` 后渲染（96–98 行），并把 `configFile`/`configMerge`/`saveMode` 交给框架管 save/dirty/刷新。`BlindReviewSettings` 只负责"把 config 画成编辑表单 + 调 onChange"，读文件、写文件、dirty、拦截全在框架。
- i18n 框架在启动时把 `languages` 槽的 JSON 合并进 i18next resources，插件内 `useTranslation()` + `t("review.*")` 查。注意 `buildDefaultDict`（`renderer/index.tsx` 34–45 行）用 `t("review.defaults.correctness.prompt")` 组默认 prompt——`t(key)` 不传 vars 是纯查表，prompt 里的 `{{content}}`/`{{tree}}` 占位符**原样保留**（i18next 插值只在显式传 vars 时发生，且本插件需要插值的 key 只有 `review.label.reportHeading`/`failedHeading` 里的 `{{name}}`，这两个在 `assembleReports` 里手动 `.replace("{{name}}", ...)`，不走 i18next 插值）。

### 7.4 与 timeline / session 事件流：被动跟随

blind-review **不主动**和 timeline 通信，但它开新会话、发 prompt 会触发 main 推 `sessionStart`/流式事件，timeline 跟随跳转——这是既成机制（设计文档 QA 第三条自认"跑蓝队时 timeline 一直跳会话"是优点：用户能看到审查正在发生、每队 prompt 原样可见）。blind-review 不拦、也拦不了，它只负责跑完 `setContext(cwd, 原会话)` 把 timeline 跳回。它也不向 timeline 贡献任何槽（不贡献 `messageRenderers`/`blockRenderers`/`composer*`），审查结果在面板内聚合展示，不写进会话流。

### 7.5 一个反事实检验：为什么不需要 dependsOn

CLAUDE.md §8.2 说"凡消费别人的 channel（on 或 invoke）都应声明 dependsOn"。blind-review **不声明** `dependsOn`，因为：

- 它 `on` 的 `blind-review:fileActionInvoke` 是**自己的**频道（自己 export 声明、自己订阅），不是别人的；`on` 自己的频道不构成对外依赖。
- 它 `on` 的 `system:settingsChanged` 是 `system:` 前缀框架系统事件，订阅不需要 dependsOn（同条纪律）。
- 它没有 `on`/`invoke` 任何别的插件的频道。

所以它的依赖面是空集，manifest 里没有 `dependsOn` 字段是**正确**的，不是遗漏。

## 8 核心流程实现

### 8.1 等待完成的机制：waitStreamCycle（事件驱动）

`squad-runner.ts` 61–94 行 `waitStreamCycle()` 是"等一次生成完成"的唯一实现，它的正确性直接决定整条审查链：

- **两阶段等待**（注释 52–55 行）：先等 `streaming` 起（确认本轮生成开始），再等 `streaming` 回落 + 末条 assistant 非 pending。为什么两阶段？因为 `useSessionStore.subscribe` 订阅早于 `agentStart` 事件时，store 里还是**旧会话**状态——直接等 `streaming` 回落会用旧的 assistant 消息误判完成。先确认"这一轮真的开始了"再等结束，是时序竞态的根因修复。
- **实现**：`useSessionStore.subscribe((s) => {...})` 是 zustand 的非组件订阅，闭包内维护 `started` 布尔，`!started` 阶段看 `s.streaming` 置 true，`started` 后 `s.streaming` 回落到 false 时取 `s.messages[last]`，`role === "assistant" && !pending` 才 `done(...)`。`stopped`/`error` 记 `{ok:false, error:"interrupted"}`（83 行）。
- **超时是保险丝**：`STREAM_TIMEOUT_MS = 10 * 60 * 1000`（26 行），`setTimeout` 兜底进程异常失联。注释钉死语义："正常路径 agentStart/agentEnd 事件驱动,超时只在进程异常失联时兜底"——不轮询、不 sleep。
- **`cancel`**（87–93 行）用于 prompt 发送失败的路径：回收订阅与计时器，promise 悬空无人等（prompt 抛错时 `waiter.cancel()` + throw，见 `runOne` 105–110 行）。

### 8.2 runOne：单队 = 真新会话 + 收报告 + 打标记

`runOne(ctx, cwd, promptText, markName, labels)`（96–118 行）是"一队出一次"的原子单元：

1. `await ctx.sessions.setContext(cwd, null)`（103 行）——`null` 让下一条 `prompt` 起**全新会话进程**。这是"盲"的物理保证：零历史、零上下文，模型看不到代码是谁写的。设计文档 §3.4 点明这是 Anthropic 游戏"严格信息屏障"的等价物。
2. `await ctx.messaging.prompt(promptText)`（106 行）——发送组装好的审查指令。
3. `await waiter.promise`（111 行）——事件驱动等完成。
4. `ctx.pi.getLastAssistantText()`（113 行）收报告文本，空则抛错。
5. `renameSession` 打 `[盲审] {队名}` 标记（115–116 行，best-effort）。

### 8.3 runSquad：串行蓝队 + 裁判 + finally 恢复

`runSquad(ctx, opts)`（120–186 行）是编排主函数，`opts` 是 `SquadRunOptions`（40–50 行）：`cwd`/`content`/`teams`（已过 enabled 筛选）/`judge`（null = 单发）/`labels`/`onProgress`/`isCancelled`。

关键决策点，每条都是论证式选择：

- **白盒树读一次**（133–143 行）：`teams.some(t => t.access === "project")` 才读；`ctx.fs.readDirTree(cwd, {maxDepth:3, ignore: TREE_IGNORE_DIRS})` 读一次，所有白盒队共享同一份快照（树在流程期间不变，读一次是事实不是缓存）；读失败给 `labels.treeUnavailable` 占位——`{{tree}}` 不能原样留在 prompt 里发给模型（不静默）。
- **串行而非并行**：`for (const team of teams)` 顺序 await。这是单激活会话进程模型决定的（`MessagingApi` 全部操作绑定同一个激活会话），插件层不绕过。串行是内核纪律的忠实反映，不是实现偷懒。
- **失败不中断编制**（152–159 行）：每队 try/catch，失败 `reports.push({..., ok:false, text: String(err)})` + `markTeam(state, id, "failed")`，继续下一队。失败原因作为报告文本如实进 `reports`，裁判据此知道覆盖缺口。
- **裁判门**（164 行）：`!cancelled && judge && reports.some(r => r.ok)` 才跑裁判。至少一队成功才有汇总意义；中止则跳过。**跳过要显式标记**（174 行 `markJudge(state, "skipped")`），不留 `pending` 假相——这是运行状态诚实性的体现。
- **中止检查散布**：每队前 `if (isCancelled())`（147–149 行）、裁判后（176 行），`isCancelled` 是 `() => cancelRef.current` 闭包（renderer 传入），读的是 React ref 的最新值。
- **finally 恢复**（178–184 行）：`ctx.sessions.setContext(cwd, originalPath)` 恢复原会话，**含中止与失败路径**。恢复失败 catch 吞掉不阻塞结果返回。`originalPath` 在函数入口 `useUiStore.getState().currentSessionPath`（122 行）记录。

### 8.4 组装纯函数：assemble.ts

`assemble.ts` 是"构造"层，与 `squad-runner` 的"执行"层严格分离（`assemble.ts` 首行注释"构造与执行分开:这里只拼文本,发送在 client/squad-runner"）。四个纯函数 + 三个常量：

- `truncateContent(text, labels)`——超 `CONTENT_MAX_CHARS = 100_000` 截断 + 正文标注 `labels.contentTruncated`。截断标注写进 prompt 正文让审查方知道输入不完整（不静默）。
- `serializeTree(root, labels)`——`FileTreeNode` 树 → 缩进文本，超 `TREE_MAX_LINES = 200` 行截断 + 标注。树的定位是"代码与周边关系的线索"，不是全文 dump（`assemble.ts` 14 行注释）。
- `assembleTeamPrompt(team, content, tree, labels)`——`team.prompt` 的 `{{content}}` 替换为截断后内容；`tree !== null` 时才替换 `{{tree}}`。**占位符缺席 = 用户的选择**，不注入、不报错（`assemble.ts` 5 行注释）。
- `assembleReports(reports, labels)`——各队报告拼装，失败队用 `failedHeading` 如实标注（裁判需要知道覆盖缺口）。
- `assembleJudgePrompt(judge, content, reports, labels)`——裁判 prompt 的 `{{content}}` + `{{reports}}` 双占位替换。

`AssembleLabels`（19–25 行）是组装期文案标注的注入接口，`SquadRunLabels extends AssembleLabels`（`squad-runner.ts` 29–32 行）再补 `treeUnavailable`/`sessionMark` 两个运行期文案。所有自然语言都经这两个 label 字典注入——core 不硬编码任何文案（机制与内容分离，§2）。

### 8.5 运行状态纯函数：run-state.ts

`run-state.ts` 是"面板运行区展示模型 + runner 进度上报形状"的单源（首行注释"组件渲染和 runner 上报共用同一份,杜绝两处各造状态形状漂移"）。五个纯函数：

- `initRunState(teams, withJudge)`——初始 `SquadRunState`：全队 `pending`，judge 有则 `pending` 否则 `null`，phase `"teams"`。
- `markTeam(state, id, status)` / `markJudge(state, status)` / `markPhase(state, phase)`——不可变推进（`{...state, ...}`），不做原地改。

`SquadRunState`（16–21 行）的 `judgeStatus: RunItemStatus | null` 用 null 表达"本次无裁判"（单发模式），与 `pending` 区分开。renderer 里 `STATUS_COLOR`（287–293 行）把五种状态映射到主题 token 颜色，`statusLabel`（440–445 行）映射到 i18n 文案——展示层只消费状态机，不自己造状态。

## 9 权限与能力依赖

全部能力落在中立契约既有 API + 一个 pi 扩展面，**零内核改动、零新增权限**（设计文档 §4 结论，本文落到具体 API）：

- `ctx.config.all()`——统一插件配置通道（核心默认，无需声明）。`fs:project` 是唯一声明的权限。
- `ctx.fs.readDirTree / readFile`——白盒队文件树 + 文件动作读文件。走 `fs:project` 门控 + 项目根圈禁（`FsApi` 契约 `sessions.ts` 399–418 行注释"读写均经 assertProjectPath 圈禁到项目根"）。`ctx.fs` 是可选字段（`PluginContext.fs?: FsApi`，`context.ts` 287 行）——未声明权限时 main IPC 边界拒绝，runner 里 `if (!ctx.fs) throw` 显式降级。
- `ctx.sessions.setContext / renameSession`——开新会话（信息屏障）+ 恢复 + 命名标记（核心默认）。
- `ctx.messaging.prompt / abort`——发送审查指令 / 中止（核心默认）。
- `ctx.pi.getLastAssistantText()`——收报告文本。这是 **pi 内核专属扩展面**（`PiExtensions`，`context.ts` 285 行注释"pi 内核专属扩展面……dsh 下这些入口隐藏/置灰"）。blind-review 在这里有一个显式的内核耦合点：它读的是 pi 的"最后一条 assistant 文本"，dsh 内核下此入口降级（抛"当前内核不支持"）。这是本插件唯一没有完全抹平内核差异的地方——设计文档 §4 写的是 `ctx.maintenance.getLastAssistantText()`，但实现落点是 `ctx.pi.getLastAssistantText()`（`plugin-context.ts` 53 行）。要在 dsh 下等价，需经 `ctx.sessions` 的中性消息面另取，属已知演进点，不影响当前 pi 路径正确性。
- `useSessionStore.subscribe` / `useUiStore.getState()`——zustand 非组件订阅（等待完成）与 store 快照读（记录/取会话路径、读 cwd）。这是 renderer 侧框架状态只读，不调 setter。

## 10 QA

**Q：`channels` 里只声明一个频道，为什么不用 `revealOn` 声明式揭示，而要在 `invokeFileAction` 里主动 `revealPluginSidePanel`？**

两条机制分工不同。`revealOn` 是"某 channel 被派发时激活本 Tab"的声明式揭示，靠 `right-panel.tsx` 的 `eventBus.tap` 全局侦听命中后 `activateSidePanelTab`，适合"触发方完全不知道贡献者是谁"的场景。而 fileActions 的 `invokeFileAction` 已经把"浮出贡献者 UI"作为触发前置步骤内置（先浮出→挂载→订阅→再 invoke），且它需要精确路由到 `action.pluginId` 对应的 Tab（一个插件可能多个动作共享一个 Tab），用 `revealOn` 反而表达不了"动作→贡献者→Tab"的对应。两者不冲突：`revealOn` 面向通用频道，fileActions 面向动作路由，blind-review 走后者。

**Q：文件动作 invoke 到达时 Tab 还没挂载，payload 会不会丢？**

不会。`invokeFileAction` 先 `revealPluginSidePanel` 触发挂载，且事件总线的 `invoke` 在无订阅者时把 payload 入 `pendingInvokes` 队列，首个订阅者 `on` 时冲刷——恰好一次投递（`event-bus.ts` 184–191 行）。即便挂载与 invoke 之间仍有竞态，队列保证不丢。卸载时 `unregisterPlugin` 补发 null，订阅回调第一行的 `if (!p) return` 挡掉。

**Q：`pendingFileRef` 为什么不能直接跑，要落 ref + tick 再消费？**

因为三个前置条件可能在 invoke 到达时都不成立：`cfg` 是异步 `ctx.config.all()` 的结果（首帧为 null）、`running` 可能为 true（上一轮在跑）、`currentCwd` 可能为空。直接跑会读到一个未就绪的 cfg 或撞正在跑的状态。落 ref + 一个消费 effect（依赖 `[cfg, pendingFileTick, running, currentCwd, ...]`），条件齐备才读文件跑编制；`running` 期间不消费，payload 留在 ref，本轮结束 `running` 回落 effect 自动重跑接上。这是 React effect 依赖驱动的接续，不是轮询。

**Q：设置页和面板读配置走两条不同通道（configFile vs ctx.config），会不会双源漂移？**

同源不会漂移。两条通道读写的是**同一对文件**（`~/.my-harness-desktop/config/blind-review.json` 全局 + `<cwd>/.my-harness-desktop/config/blind-review.json` 项目），`config-store.ts` 与 `settings-page.tsx` 的路径约定一致。漂移的风险只存在于"写后不通知"，这里靠 `broadcastSettingsChanged` → `settings:changed` → `system:settingsChanged` → 面板重载这条广播链封死（`renderer/index.tsx` 328–333 行订阅）。这是"统一配置源,消灭双源失同步"的注释所指。

**Q：为什么裁判要在"至少一队成功"才跑，而不是无条件跑？**

裁判的输入是 `{{reports}}`（各队报告拼装）。若全部失败，`reports` 里只有错误文本，没有可用发现，裁判汇总没有意义。所以门是 `reports.some(r => r.ok)`。且跳过要显式 `markJudge(state, "skipped")`——不留 pending 假相，UI 上明确显示"裁判：跳过"而非永远转圈。这是运行状态诚实性：失败、跳过、完成三态必须可区分，不能静默。

**Q：单发模式（`run(content, "single")`）也走独立新会话，和蓝队模式的区别只在"没有裁判"吗？**

是。`run` 里 `mode === "single"` 时 `teams = cfg.prompts.filter(p => p.id === selectedPromptId)`（只取选中队）、`judge = null`（单发无裁判）。底层 `runSquad` 对 `judge === null` 的路径完全一致：`initRunState(teams, false)` → `judgeStatus: null`，`assembleTeamPrompt` 照常，`runOne` 照常开新会话。所以单发的"盲"和蓝队一样真——发当前会话等于让审查者看着被审者档案打分，旧版的"发当前会话"已被统一隔离语义取代（设计文档 QA 第四条）。

**Q：审查进行中用户切了工作目录，插件怎么处理？**

`renderer/index.tsx` 336–342 行的 cwd 守卫：`useEffect` 监听 `currentCwd`，若 `running && cancelRef.current === false`，置 `cancelRef.current = true` 并 `ctx.messaging.abort()`。理由是 fs 圈禁锚点已变，继续跑语义即错——白盒队的树快照、文件动作读的路径都以旧 cwd 为锚，切换后这些不再有效。守卫是**立即中止**，不是"等这轮跑完"，因为等下去得到的是错误锚点下的结果。

**Q：为什么文件树右键"盲审文件"拿的是"全编制报告"，而不是选中模板单审？**

这是文件动作语义的升级（设计文档 §3.7）：右键一步到位，语义是"把这个文件交给我的蓝队整建制审一遍"，拿完整汇总报告（裁判 + 各队），而不是只跑当前下拉选中的那个队。实现上消费 effect 固定调 `run(content, "squad")`（`renderer/index.tsx` 422 行），不经输入框、不看 `selectedPromptId`。单审是面板内交互（"仅此队审查"按钮），文件动作是重操作入口，两者定位不同。
