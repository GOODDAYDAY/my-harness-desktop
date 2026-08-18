# 009 事件通信：薄壳架构下的消息通道

my-harness-desktop 的事件通信分两层：内核→插件的纵向推送（pi 底座 stdout 事件 + 桌面自产事件），和插件↔插件的横向事件总线（renderer 侧进程内通道）。两层各走各的物理通道——纵向走 IPC（main→renderer），横向走 `EventBus`（renderer 进程内）——但插件统一经 `ctx.events` 消费，不感知底层差异。

事件总线是插件之间唯一的合法通信通道。不走共享 store 互写、不走直接 `window.pi` 调用对方能力。本文从"为什么需要事件"讲起，逐层展开两条信息流、总线原语、channel 契约、系统事件、生命周期护栏，最后解释为什么三条历史通知机制不够用。

## 1 两条信息流，两种来源

my-harness-desktop 的事件不是只有一个来源。搞清楚"谁产生"和"谁消费"，才能理解事件机制的完整图景。

### 1.1 来源一：pi 底座推送（纵向，main→renderer）

pi 底座以 `pi --mode rpc` 启动后，stdout 持续吐 JSON Lines。`RpcAdapter.handleLine` 分三条路径分流：

- **response**——带 `id` 的响应，和 `RequestCorrelator` 里的 pending 请求配对后 resolve Promise。这是请求-响应模型，不是事件流——调用方 `await adapter.send(cmd)` 拿结果，不订阅。
- **event**——不带 `id` 的 fire-and-forget 推送。底座 agent 运行时的事件流：`message_start`/`message_update`/`message_end`、`tool_execution_start`/`tool_execution_end`、`agent_start`/`agent_settled` 等。这些是单向推送——底座推出来就不管了，桌面端收到后自己决定怎么处理。
- **extension_ui_request**——底座向桌面端请求用户交互（确认、选择、输入）。和 event 的本质区别是：**底座在等待回复**。底座推了 `extension_ui_request` 后会阻塞，直到桌面端回一个 `extension_ui_response`。这不是单向事件，是请求-响应——只是发起方是底座而非桌面端。

这三类消息经 `RpcAdapter` 翻译后，由 `SessionStore` 通过 IPC 推送到 renderer：

- `session:event`——底座 session 事件，preload 暴露为 `window.pi.sessions.onEvent(cb)`。
- `session:kernelEvent`——包装后的内核事件联合 `KernelEvent`，preload 暴露为 `window.pi.sessions.onKernelEvent(cb)`。这是单向推送，所有 renderer 窗口广播。
- `session:extensionUI`——底座 Extension UI 请求，preload 暴露为 `window.pi.sessions.onExtensionUI(cb)`。收到请求的插件通过 `window.pi.sessions.replyExtensionUI(requestId, response)` 回写底座 stdin，完成双向闭环。

IPC 通道名契约定义在 `src/api/preload/ipc-channels.ts`，main 和 preload 共享同一份常量地图，拼错是编译错而非运行时静默失败。

### 1.2 来源二：desktop 自产（纵向，main→renderer）

桌面端在管理 pi 子进程的过程中，自己也会产生信息。这些信息不来自底座的 stdout，而是桌面端内核根据进程状态和 RPC 交互产生的。`docs/core/event-mechanism.md` §1.2 的诊断指出：当前有三条自产信息流断了——进程退出、RPC 超时、进程就绪状态变化——它们被各自的处理逻辑内联消化，没有统一的出口到达插件。

现状：`KernelEvent` 联合（`src/core/domain/events/kernel-event.ts`）已定义四类变体，`SessionStore` 已实现 `dispatchKernel` 和 `onKernelEvent` 回调，IPC 通道 `session:kernelEvent` 已接通（`src/api/preload/preload.ts:210-214`）。底座 event 这条流全通；Extension UI 请求在 preload 已有监听器和回复 API，但 RpcAdapter 层的默认 fallback（60 秒超时自动 cancel）尚未落地，插件侧尚无内置处理器——收到的 Extension UI 请求当前没有插件弹 UI 回复，等超时自动 cancel。进程退出和 RPC 错误事件在 `SessionStore` 的 `onceExit` 和 `send()` catch 里已产生 `KernelEvent` 变体。

### 1.3 现状：底座事件全通，自产事件框架已就绪

`docs/core/event-mechanism.md` §1.3 的原始诊断"一条路通，三条断"表述的是 `KernelEvent` 设计落地前的状态。当前修复状态：

| 信息流 | 状态 | 说明 |
|---|---|---|
| 底座 event → SessionEvent | ✅ 全通 | `adapter.onEvent` → `translateEvent` → `dispatch` → IPC → renderer store + onEvent 回调 |
| Extension UI 请求 → onExtensionUI | ⚠️ IPC 通，无插件处理器 | IPC 通道已接通；底座 60s 超时自动 cancel 的兜底尚未在 RpcAdapter 实现；无内置插件处理交互式请求 |
| 进程退出/崩溃 → ProcessExitEvent | ⚠️ KernelEvent 类型已定义，SessionStore 产出点待补 | `RpcAdapter.onceExit` 当前只做 `rejectAll`，未调 `onProcessExit` 回调产事件 |
| RPC 超时/错误 → RpcErrorEvent | ⚠️ 同上 | `SessionStore.send()` 的 catch 块可产事件，但 `onProcessExit` 回调链路未接通 |

## 2 事件总线：插件之间的唯一通道

`docs/design/plugin-event-flow.md` 暴露了一个结构性缺口：插件之间没有协作机制。子 agent 往 session 文件追加了 entry 后，timeline 不知道"有新 entry 了，该重读"；子 agent 状态从 running 变成 done，sessions-list 不知道"该刷新列表了"。现有的三种通知机制（zustand store 订阅、IPC 事件、`settings:changed` 广播）都不解决"插件 A 产生状态变更后通知插件 B 更新渲染"这个需求（详见 §8）。

事件总线（`packages/react/src/event-bus.ts`）是这个问题的答案——renderer 侧进程内的轻量同步分发器，插件通过 `ctx.events` 拿到受控的发布和订阅 API。

### 2.1 插件侧 API

插件通过 `usePluginContext()` 拿到的 `ctx.events`，类型为 `PluginEventsApi`（圆心定义在 `src/core/domain/context.ts:57`），三个方法：

```typescript
export interface PluginEventsApi {
  emit(channel: string, payload?: unknown): void;
  on(channel: string, handler: (payload: unknown) => void, opts?: { replayLast?: boolean }): () => void;
  invoke(channel: string, payload?: unknown): void;
}
```

在 `packages/react/src/plugin-context.ts:152-156`，这三个方法绑定到全局单例 `eventBus`，`pluginId` 由 `PluginIdContext` 自动注入——插件不写自己的 pluginId 常量。

### 2.2 emit：发布/订阅，只能发自己声明过的 channel

`emit` 是经典的 pub/sub 原语。插件 A 发事件，插件 B（或框架）订阅并响应。核心约束：**emit 只能发自己声明过的 channel**——这是运行时防线，不是建议。

`EventBusImpl.emit`（`event-bus.ts:88-105`）的三步校验：

1. 拒绝 `system:*` 前缀——插件无权 emit 系统事件。
2. 查 `isChannelOwnedBy(pluginId, channel)`——channel 必须在调用插件的 `export const channels` 里声明过。越权直接抛错。
3. 同步遍历 `state.handlers`，每个 handler 在当前调用栈里执行。

每次 emit 后，`EventBusImpl` 缓存 payload（`state.lastPayload`），供后续订阅者通过 `replayLast: true` 回放——这是"可回放的状态广播"，适合书签请求、附件列表等场景：新订阅者挂载时能拿到最近一次 emit 的值，不用等下一次。

### 2.3 invoke：定向分派，不需要 channel 所有权

`invoke` 和 `emit` 是两种不同的原语，别混用。`emit` 是"我有这个 channel，谁想听就来听"；`invoke` 是"我要调那个插件的能力，但我不拥有那个 channel"。

`EventBusImpl.invoke`（`event-bus.ts:110-128`）的语义：

- **调用方不需要 channel 所有权**——和 `emit` 的"只能发自己的 channel"不同，`invoke` 允许任何插件调任何已注册的 channel。这是框架约定的调用通道原语（如 `timeline:scrollTo`、`<pluginId>:fileActionInvoke`）。
- **无订阅者时入队**——payload 进 `pendingInvokes` Map，不丢弃、不抛错。这是为懒挂载场景（如右面板 tab）设计的：调用时目标组件可能还没挂载，先存着。
- **首个订阅者挂载时恰好一次冲刷**——`on()` 里检测 `pendingInvokes` 有内容，清空队列、逐条投递。不是回放（不回放历史），是一次性投递排队的命令。
- **不支持 `replayLast`**——invoke 是一次性命令，不是可回放的状态。新订阅者不应该收到"历史上的命令"。

典型用法：

```typescript
// session-bookmarks 插件 fork 书签后，让 timeline 滚动到对应消息
// src/plugins/sessions/session-bookmarks/renderer/index.tsx:187
ctx.events.invoke("timeline:scrollTo", { messageId: bm.entryId });

// file-tree 插件触发文件动作后，invoke 到贡献者的约定频道
// packages/react/src/file-actions.ts:67
eventBus.invoke(callerId, fileActionInvokeChannel(action.pluginId), payload);
```

### 2.4 何时用 emit，何时用 invoke

| | emit | invoke |
|---|---|---|
| 语义 | "我宣布一件事发生了" | "我请求你执行一个动作" |
| 典型场景 | 书签创建请求、附件变更通知 | 滚动到消息、触发文件动作、提交编辑器内容 |
| channel 所有权 | 必须是自己的 channel | 不需要 |
| 无订阅者时 | 静默丢弃 | 入队等订阅者 |
| 回放 | 支持 `replayLast` | 不支持（命令不是状态） |
| 框架内部 tap | 触发 | 触发 |

## 3 channel 契约：代码即声明

channel 不进 manifest，由代码级 `export const channels` 声明。框架加载插件 renderer module 后，读 `module.channels` 自动注册——插件不手动调 `registerChannel()`。

### 3.1 声明方式

每个需要发布或接收事件的插件，在 `renderer/index.tsx` 顶层 export channels：

```typescript
// src/plugins/sessions/timeline/renderer/index.tsx:15
export const channels = [
  "timeline:bookmarkRequested",
  "timeline:scrollTo",
  "timeline:rewindRequested",
  "timeline:composerAttachments",
] as const;

// src/plugins/insight/blind-review/renderer/index.tsx:29
export const channels = ["blind-review:fileActionInvoke"] as const;
```

**命名约定**：channel 名用 `插件id:动作名` 格式。两部分用冒号分隔——不是技术限制，是约定——让消费者一眼看出谁拥有这个 channel，该向谁声明 `dependsOn`。

### 3.2 自动注册

`plugins-host.ts` 的 `loadBuiltin` 和 `loadThirdParty` 在加载完 renderer module 后，读 `module.channels` 调 `eventBus.registerChannels()`：

```typescript
// src/api/renderer/plugins-host.ts:30-33
const channels = mod.channels;
if (Array.isArray(channels)) {
  eventBus.registerChannels(pluginId, channels as string[]);
}
```

`registerChannels`（`event-bus.ts:49-61`）做两件事：
1. 记录 `pluginId → Set<channel>` 映射（供 emit 时 `isChannelOwnedBy` 校验）。
2. 为每个 channel 初始化 `ChannelState`（handlers Set + lastPayload + hasLastPayload）。

卸载时 `unregisterPlugin`（`event-bus.ts:63-77`）反向操作：给每个 channel 的 handler 推 `null`（通知"channel 没了"），清掉注册——已卸载插件的 channel 不再可 `on`。

### 3.3 emit 权限校验：运行时防线

`EventBusImpl.emit` 做了两层校验（`event-bus.ts:88-93`）：

```typescript
if (this.isSystemChannel(channel)) {
  throw new Error(`plugin ${pluginId} 无权 emit 系统事件 ${channel}`);
}
if (!this.isChannelOwnedBy(pluginId, channel)) {
  throw new Error(`plugin ${pluginId} emit 未声明的 channel ${channel}`);
}
```

第一层：插件不能冒充框架发系统事件。第二层：插件只能在自己的 channels export 里声明过的 channel 上 emit，越权直接抛错。

这是运行时防线，不是编译期防线——`as const` 的 channels 数组类型安全只在模块内生效，但跨模块 `emit("some-string")` 的字符串参数 TypeScript 管不到。防线在运行时。

### 3.4 on 校验：channel 必须来自已加载插件

`EventBusImpl.on`（`event-bus.ts:147-148`）调 `channelExists(channel)`——检查 channel 是否在 `pluginChannels` Map 里，或者是 `system:` 前缀。后者是框架系统事件，不需要任何插件声明。前者要求 channel 来自某个**已加载**插件。

这意味着：订阅方 `on("timeline:scrollTo", handler)` 必须在 timeline 插件已经加载后才能成功。这个顺序天然保证——`plugins-host.ts` 先并行 `Promise.all` 加载全部插件（此时 channels 全部注册完毕），然后组件才挂载（此时才调 `useEffect` 里的 `on`）。

## 4 system:* 框架事件

`system:` 前缀的事件由框架 emit，不进任何插件的 channels export。插件订阅不需要 `dependsOn` 声明——系统事件不属于任何插件。

### 4.1 已落地的系统事件

| channel | 触发时机 | 代码位置 | 消费者示例 |
|---|---|---|---|
| `system:settingsChanged` | settings.json 被外部写入（skill-toggle 改字段） | `plugins-host.ts:124` | `settings-page.tsx:149` 重读当前 configFile |
| `system:systemThemeChanged` | 系统明暗模式切换 | `plugins-host.ts:128` | `theme-context.tsx:18` 重 build 主题 |
| `system:configFileSaved` | 框架保存配置后 | `settings-page.tsx:275/295/312`, `general-config.ts:34` | debug-bar 等订阅方刷新 |
| `system:layoutChanged` | 布局变更（拖拽分栏等） | `layout-store.ts:233` 等 | 布局消费者重读 |

框架用 `emitSystem`（`event-bus.ts:130-145`）发系统事件——不走 `emit` 的插件 channel 校验，也不需要提前声明 channel。`emitSystem` 内部对 `system:` 前缀做断言（非 `system:` 调用直接抛错），payload 同样缓存供 `replayLast` 回放。

### 4.2 系统事件不声明 dependsOn

插件订阅 `system:*` 事件不需要在 `plugin.json` 的 `dependsOn` 里声明任何依赖。dependsOn 的语义是"依赖某插件的 channel 或能力"——系统事件不属于任何插件，不在此列。

### 4.3 tap：框架内部侦听

`EventBusImpl.tap`（`event-bus.ts:34-37`）是框架专用机制，不进 `PluginEventsApi`——插件不可用。任何 `emit`/`invoke`/`emitSystem` 派发前，tap 回调同步触发。

典型用法：右面板的 `revealOn` 声明式揭示（`right-panel.tsx:111-125`）。插件在 manifest 的 `sidePanel` 贡献项里声明 `revealOn: "timeline:bookmarkRequested"`，框架注册 tap 侦听该 channel——命中时幂等展开右面板并激活对应 tab。插件代码不出现自己的 contribution id，框架居中撮合。

## 5 加载顺序与 dependsOn

### 5.1 并行加载，channel 天然在订阅之前

`plugins-host.ts` 的 `bootstrap()`（第 77 行）对所有插件做 `Promise.all(promises)`——全部插件**并行**加载。每个插件的加载流程是：`import module`（Vite/动态 import）→ `registerPluginComponents` → 读 `mod.channels` → `eventBus.registerChannels` → `registerPluginModule`。

所有插件的 channels 都在这个阶段注册完成。组件挂载（React render）在后——`useEffect` 里的 `ctx.events.on()` 在渲染提交后才执行。所以**订阅方调 `on` 时，目标 channel 一定已注册**。

不存在"A 订阅了 B 的 channel，但 B 还没加载所以报错"的问题。`on` 的 `channelExists` 校验通过的前提是 channel 在 `pluginChannels` Map 里——而它在并行加载阶段由 B 注册进去了。

### 5.2 invoke 入队兜底

`invoke` 的入队机制覆盖组件懒挂载场景：调用方发出 invoke 时，目标组件的 `on` handler 可能还没注册（比如右面板 tab 用户还没点开）。`invoke` 对此入队（`pendingInvokes`）——不抛错、不丢弃。等目标组件挂载、调 `on` 时，`on` 里检测 pending queue 并冲刷（恰好一次投递）。

emit 没有入队机制，但有 `replayLast` 选项——新订阅者可以在 `on` 时传 `{ replayLast: true }`，拿到最近一次 emit 的缓存 payload。这是 emit（pub/sub）场景下解决"订阅晚于发布"的机制。注意当前 session-bookmarks 的 `on("timeline:bookmarkRequested", handler)` 并未传 `replayLast: true`（`session-bookmarks/renderer/index.tsx:169`）——它依赖 `revealOn` tap 在组件挂载后才激活 tab 这一事实（tabs 可能已有实例），或依赖右面板 keep-alive 策略维持的现有订阅。若未来改为更激进的懒卸载，此处应加 `{ replayLast: true }`。

### 5.3 dependsOn：生命周期护栏，不管加载顺序

`dependsOn` 声明在 `plugin.json` 里，作用是**生命周期护栏**——被依赖插件在线时，依赖方不能被停用/卸载。它不管加载顺序。

```json
// src/plugins/sessions/session-bookmarks/plugin.json:10-13
"dependsOn": [
  "timeline",
  "session-tree"
]
```

护栏实现在 `src/core/application/lifecycle/index.ts`：

- `checkDependents(pluginId, registry)`（第 21-30 行）——遍历所有已注册插件，查其 manifests 的 `dependsOn` 是否包含 `pluginId`，返回依赖方列表。
- `canDeactivate(pluginId, registry)`（第 32-37 行）——先查是否 `protected`，再查 `checkDependents`。有依赖方时返回 `{ ok: false, blockedBy: [...] }`。
- `uninstallPlugin`（第 165-182 行）——卸载前先调 `canDeactivate`，被 blocked 时返回错误。

效果：只要 session-bookmarks 在线，用户就不能停用/卸载 timeline 或 session-tree——UI 按钮灰掉，错误提示列出 blocking 插件。

**凡消费别人的 channel 都应声明 dependsOn**。订阅 `timeline:scrollTo` 的插件应在 manifest 里写 `"dependsOn": ["timeline"]`——一方面是语义诚实，另一方面是生命周期护栏：timeline 被卸载时订阅方也一并被停用，避免孤悬的 handler 引用。

声明 dependsOn 不需要对方做任何事——timeline 不需要知道谁依赖了它。这是单向声明，和"插件 A import 插件 B"不同——A 不 import B，A 只声明"我需要 B 在线"。

## 6 共享 store 只读规则

`useUiStore` 和 `useSessionStore`（`src/api/renderer/stores/`）是 renderer 侧的框架级运行时状态。插件可以**读**但不能**写**。

### 6.1 插件读 store

插件通过 zustand hook 订阅 store 状态：

```typescript
const currentCwd = useUiStore((s) => s.currentCwd);
const messages = useSessionStore((s) => s.messages);
```

这是纯读取——zustand 的 `useStore(selector)` 只返回状态切片，不暴露 setter。插件可以响应框架状态变更（当前目录变了、消息流更新了），但不能直接改 store。

### 6.2 改变框架状态走 ctx API

插件要改变框架状态，不走 store setter，走 `ctx` API。框架处理完后自己更新 store 并 emit 系统事件通知所有订阅方：

- 切换工作目录 → `ctx.sessions.setContext(cwd, sessionPath)` → store 的 `currentCwd` 更新 → 不 emit 系统事件（cwdChanged 信号暂缺，见 §6.3）。
- 创建新会话 → `ctx.sessions.start(cwd)` → 底座 spawn 新进程 → `sessionStart` event → store 更新。

**禁止的行为**：

```typescript
// ❌ 插件不能直接调 store setter
useUiStore.setState({ currentCwd: "/new/path" });

// ❌ 插件不能通过 window.pi 直调另一个插件的能力
window.pi.sessions.start(...);  // 只能经 ctx

// ✅ 正确：经 ctx API
ctx.sessions.setContext(cwd, sessionPath);
```

### 6.3 系统事件覆盖缺口

当前 `system:*` 事件只覆盖了 settings/settingsChanged/systemThemeChanged/configFileSaved/layoutChanged 五个场景。切上下文（cwd）、切会话（sessionPath）、skills 变更等框架状态变更尚未统一产出 `system:*` 事件。这些缺口意味着当前部分插件仍在 `useEffect` 里直接订阅 store 的 selector 变化来判断"上下文变了"——这不是事件驱动，是轮询式订阅。但这是 store 的订阅机制本身不违规——zustand selector 是框架提供的合法读接口。

## 7 内核实事件：SessionBus

事件总线（`EventBus`）是 renderer 进程内的插件间通道。另有一条跨进程的通道叫 **SessionBus**（`src/core/domain/events/session-bus.ts`），它是会话之间的消息通道——pi 子进程之间、插件与 pi 子进程之间通过消息信封（`SessionBusMessage`）通信。本文不展开 SessionBus 的全部细节，只标注它与事件总线的关系：

- **SessionBus 是"会话间通信"**（跨进程/跨会话），事件总线是"插件间通信"（renderer 进程内）。
- SessionBus 的消息经 IPC → main → `SessionStore` → preload → `window.pi.bus.onMessage(cb)` 到达插件。这不是事件总线的 channel，是独立的 IPC 通道 `bus:event`。
- SessionBus 有自己的 `TapFilter`（`done`/`lifecycle`/`stream`）、地址方案（`session:<key>` / `channel:<name>` / `plugin:<id>`），和事件总线的 `system:*` / 插件 channel 是两套命名空间。

## 8 为什么事件是唯一的合法通道

### 8.1 三条历史机制的局限

`docs/design/plugin-event-flow.md` §1.1 识别了 my-harness-desktop 曾有三条让"状态变更"传到消费者的路，每条都只解决了一部分问题：

**zustand store 订阅**。`useUiStore` 和 `useSessionStore` 是 renderer 侧共享状态。组件通过 zustand selector 订阅变更——store 变了消费者自动收到更新。局限：
- store 只管"我自己持有的状态变了"，不管"session 文件变了"或"另一个插件做了某件事"。子 agent 往 session 文件追加了 entry，store 不知道——store 里没有"session 文件内容变了"这个状态。
- 订阅者是 React 组件（经 `useSyncExternalStore`），不是"插件"——一个插件的非渲染逻辑（如初始化、数据预处理）没法订阅 store 变更。

**IPC 事件**。main 进程通过 `webContents.send` 推事件到 renderer——`session:event`、`session:kernelEvent`、`settings:changed`、`plugins:changed` 等。方向单一（main→renderer），每个事件类型是硬编码的 IPC channel——加一个新类型要在 main 加 handler、在 preload 加方法、在 renderer 加监听。插件不能自定义事件类型——`window.pi` 上没有"发布事件"的 API。

**settings:changed 广播**。当前最接近"事件流"的机制——skill-toggle 写了 settings.json 后，main 进程广播 `settings:changed`，所有订阅的设置页重读当前 configFile。但它是一个**硬编码的专用广播**，只解决一个场景，不能扩展到"session 文件被追加 entry"或"子 agent 状态变更"。

### 8.2 事件总线补上了什么

事件总线把"谁产生变更"和"谁响应变更"解耦了：

- **发布者不 import 消费者，消费者不 import 发布者**。timeline emit `timeline:bookmarkRequested`，不知道 session-bookmarks 在听；session-bookmarks on `timeline:scrollTo`，不知道是谁 invoke 了它。事件总线是唯一的中间人。
- **插件自定义 channel**。加一个新的通知场景（如"子 agent spawn 了"），只需要一个新的 channel 名字——两边各加一行 export/on，不改框架代码。
- **非组件逻辑也能订阅**。`useEffect` 里的 `on` 覆盖了组件级订阅；mixin 函数模式（`withSessionUpdate(bus, ctx)`）覆盖了非组件逻辑——在模块顶层调也行，返回清理函数在手，卸载时统一调。

### 8.3 唯一通道的纪律

插件之间的全部横向通信只走 `ctx.events.emit/on/invoke`。禁止的通道：

- **禁止共享 store 互写**：插件 A 不能调 `useUiStore.setState()` 或 `useSessionStore.setState()` 去改另一个插件关心的字段。store 的 setter 只归框架。
- **禁止直接 `window.pi` 调对方能力**：插件 A 不能通过 `window.pi.sessions.xxx` 做"替另一个插件"的操作——每个插件通过自己的 `ctx` 调自己的事。

违反的后果不一定是即时崩溃——但会让插件之间产生隐式耦合。今天改 store 字段名、改 `window.pi` API 签名，明天就炸另一个插件。

## 9 QA

**Q：插件卸载时订阅会自动清理吗？**

两层保险。如果插件用 React hook 订阅（`useEffect(() => ctx.events.on(...), [])`），React 组件卸载时 cleanup 自动调取消函数。如果插件直接调 `eventBus.on()` 但没收集返回的清理函数，卸载后 handler 泄漏——这是插件的 bug，不是框架的缺陷。框架的 `unregisterPlugin` 会在卸载时给已注册 channel 的所有 handler 推 `null`（通知"channel 没了"），随后清掉整个 channel 的 handlers Set——所以即使插件没调清理函数，handler 也会在下一次 emit 前被清除。

**Q：emit 和 invoke 可以互相替代吗？**

不能，语义不同。emit 是"我宣布一件事"，invoke 是"我请求你执行"。用 emit 替代 invoke（"session-bookmarks emit `timeline:scrollTo`"）会违反权限校验——emit 只能发自己的 channel，`timeline:scrollTo` 是 timeline 的 channel，session-bookmarks 没有所有权。反过来用 invoke 替代 emit（"timeline invoke `timeline:bookmarkRequested`"）虽然语法上能过（invoke 不需要 channel 所有权），但语义错了——这是通知，不是命令；而且 invoke 不支持 `replayLast`。

**Q：invoke 入队后如果一直没有订阅者会怎样？**

pending payload 永久存在 `pendingInvokes` Map 里——内存泄漏。这在实践上不会发生：invoke 的 channel 必须已注册（`channelExists` 检查），已注册意味着有插件加载了并 declare 了这个 channel。只要插件在加载时 export 了 channel，它的组件迟早会挂载并注册 handler。唯一泄漏风险是：插件 declare 了 channel 但从不 `on` 它——这不是设计问题，是插件 bug。

**Q：为什么 dependsOn 不管加载顺序？**

因为不需要管。所有插件并行加载，channels 在加载期注册完毕，组件挂载在渲染期才调 `on`——订阅天然在注册之后。即使以后改为异步懒加载，`invoke` 的入队机制也保障了"命令不丢"。dependsOn 只管卸载护栏——保证被依赖的插件不会在依赖方还在线时被移除。这两件事是正交的。

**Q：`window.pi.sessions.onEvent` 和事件总线是什么关系？**

`onEvent` 是底座事件的 IPC 监听——main 进程把 pi 的 stdout 事件经 IPC 推到 renderer。它和事件总线不互斥——它们不在同一层：`onEvent` 是纵向（main→renderer）的 IPC 事件，事件总线是横向（renderer 进程内）的插件间事件。当前两者没有桥接——`onEvent` 的事件不自动进入事件总线。如果插件既要消费底座事件，又要消费插件间事件，需要在代码里同时订阅两套 API。
