# 事件机制完善设计

my-harness-desktop 的事件机制目前只通了半条路：pi 底座推的 `AgentSessionEvent` 能到达插件的 `onEvent` 回调，但底座推的 Extension UI 请求、桌面端自产的进程崩溃和 RPC 错误，这三条信息流全部断了。插件既无法响应底座的用户交互请求，也无法感知连接断开，更无法在命令失败时拿到结构化反馈。同时，已翻译的 6 种事件类型没有进联合，`sessionFile`/`message` 等关键字段靠 `as` 强转绕过类型系统。本文设计一个统一内核事件抽象 `KernelEvent`，把四条信息流收进一个联合，让插件用一套 API 消费全部内核信息——包括"有来有回"的 Extension UI 双向通道。

## 1 两条信息流，两种来源

my-harness-desktop 的事件不是只有一个来源。搞清楚"谁产生"和"谁消费"，才能设计正确的抽象边界。

### 1.1 来源一：pi 底座推送

pi 底座以 `pi --mode rpc` 启动后，stdout 持续吐 JSONL。每行一条 JSON，`RpcAdapter.handleLine`（`src/gateway/rpc-adapter.ts:160`）分三条路径分流：

- **response**——带 `id` 的响应，和 `correlator` 里的 pending 请求配对后 resolve Promise。这是请求-响应模型，不是事件流——调用方 `await adapter.send(cmd)` 拿结果，不订阅。
- **event**——不带 `id` 的 fire-and-forget 推送。底座 agent 运行时的事件流：消息更新（`message_start`/`message_update`/`message_end`）、工具执行（`tool_execution_start`/`tool_execution_end`）、Agent 轮次（`agent_start`/`agent_settled`）等。这些是单向推送——底座推出来就不管了，桌面端收到后自己决定怎么处理。
- **extension_ui_request**——底座向桌面端请求用户交互。底座在 agent 执行过程中可能需要用户确认（"要执行这个 bash 命令吗？"）、选择（"从这几个选项里选一个"）、输入（"给这段代码起个文件名"）。这和 event 的本质区别是：**底座在等待回复**。底座推了 `extension_ui_request` 后会阻塞，直到桌面端回一个 `extension_ui_response`。这不是单向事件，是请求-响应——只是发起方是底座而非桌面端。

这三类消息目前只有 response 和 event 被正确处理。extension_ui_request 在 `RpcAdapter` 里有监听器基础设施（`extUiListeners`，`rpc-adapter.ts:50`），但 `SessionStore` 从未注册过监听——`adapter.onExtensionUI()` 没有调用方，事件到了 `extUiListeners` 的空集里就蒸发了。

### 1.2 来源二：desktop 自产

桌面端在管理 pi 子进程的过程中，自己也会产生信息。这些信息不来自底座的 stdout，而是桌面端内核根据进程状态和 RPC 交互产生的：

- **进程退出/崩溃**——`SubprocessHandle` 的 `onceExit` 和 `onceError` 回调（`gateway/subprocess-handle.ts:34-36`）。当前 `RpcAdapter.start()` 绑了这两个回调，但只做了 `rejectAll`（把 pending 请求全 reject 掉），没有产任何事件。插件不知道进程死了——只能靠下次调 `ctx.sessions.prompt()` 时报错间接感知，或者靠 `alive` 属性轮询。
- **RPC 超时/拒绝**——`RequestCorrelator` 的超时机制（`gateway/correlator.ts:34`）在 30 秒后 reject Promise。这个 reject 只被 `send()` 的调用方捕获，不进事件流。如果一个插件通过 `ctx.messaging.prompt()` 发消息，超时后 Promise reject 抛异常，但不会产生一个"命令超时"事件给其他订阅了 `onEvent` 的插件。
- **进程就绪状态变化**——`waitReady` 的 `get_state` 轮询结果（`session-store.ts:189`）当前只在内部判断"能不能继续"，不产生事件。进程从"启动中"到"就绪"这个状态变化，插件感知不到。

这三类自产信息当前没有任何通道到达插件。它们被各自的处理逻辑内联消化——`rejectAll` 在 `RpcAdapter` 里、超时在 `correlator` 里、就绪探测在 `SessionStore` 里。没有一个统一的出口。

### 1.3 现状：一条路通，三条断

把四条信息流和它们的去向列出来：

| 信息流 | 产生方 | 当前去向 | 插件能否感知 |
|---|---|---|---|
| 底座 event | pi stdout | `adapter.onEvent` → `translateEvent` → `dispatch` → IPC → `useSessionStore` + 插件 `onEvent` | ✅ 能 |
| Extension UI 请求 | pi stdout | `adapter.extUiListeners`（空集） | ❌ 不能 |
| 进程退出/崩溃 | SubprocessHandle | `RpcAdapter.rejectAll` | ❌ 不能 |
| RPC 超时/拒绝 | RequestCorrelator | Promise reject（调用方捕获） | ❌ 不能 |

一条路通，三条断。根因是：**当前没有一个统一抽象把四条流收进去**。底座 event 有 `SessionEvent` 联合类型和 `onEvent` 通道，Extension UI 有 `RpcExtensionUIRequest` 类型但没有投递通道，进程退出和 RPC 错误连类型都没有。每条流各自处理，没有统一出口，插件只能消费到四分之一的信息。

### 1.4 需要双向：Extension UI 的请求-响应语义

前三条流是单向的——底座或桌面端推出来，消费者收到就行，不需要回复。Extension UI 不同：底座推 `extension_ui_request` 后会**阻塞等待** `extension_ui_response`。如果桌面端不回，底座的 agent 就卡住不动。

这意味着 Extension UI 不是"订阅后被动收"的模型，而是"收到后必须回复"的模型。它和普通事件流的语义本质不同：

- **普通事件**（底座 event + 进程退出 + RPC 错误）：单向推送，fire-and-forget。消费者只读，不回。
- **Extension UI 请求**：双向请求-响应。底座推请求 → 桌面端收到 → 插件（或框架）处理 → 桌面端回响应 → 底座继续。

统一抽象必须容纳这两种语义。不能把 Extension UI 混进普通事件流假装它也是 fire-and-forget——那会让消费者以为收到就完了，不需要回复，底座就卡死了。也不能把 Extension UI 完全独立成另一个通道——那会让插件需要订阅两个不同的东西，增加复杂度。正确做法是：同一个 `KernelEvent` 联合里，Extension UI 请求有自己的 type 标识，消费者收到后判断"这个需要回复"。

### 1.5 根因：没有统一抽象

四条信息流各走各的，三条断了，不是因为某条流的技术实现有 bug，而是因为**没有在圆心定义一个覆盖全部信息流的抽象**。当前 `SessionEvent`（`domain/events/session-state.ts:165`）只覆盖底座 event 这一条流，是全部信息流的四分之一。Extension UI 有协议类型（`RpcExtensionUIRequest`）但没有事件类型，进程退出和 RPC 错误连协议类型都没有。

缺了统一抽象的后果是连锁的：SessionStore 不知道要转发 Extension UI（因为没有类型承载它），preload 不知道要开 IPC 通道（因为 SessionStore 没转发），插件不知道要订阅（因为没有 API），插件之间的间接通信（通过共享 store 状态）也无法覆盖这些信息（因为 store 里根本没有这些状态）。一个缺口的缺失引发了整条链路的断裂。

## 2 统一内核事件抽象

### 2.1 设计目标

一个 `KernelEvent` 联合类型，覆盖四条信息流。定义在圆心 `domain/events/`，零依赖、纯类型。它不是替代 `SessionEvent`，而是把它包含进来——`SessionEvent` 是底座事件的投影，`KernelEvent` 是全部内核信息流的投影。

设计目标有三条：

- **全覆盖**——四条流（底座 event、Extension UI、进程生命周期、RPC 错误）全部有对应的 `KernelEvent` 变体。插件订阅一个 `onKernelEvent` 就能收到所有内核信息，不需要分别订阅四个通道。
- **语义区分**——普通事件和 Extension UI 请求在同一联合里，但 Extension UI 有明确的 type 标识。消费者收到后按 type 判断"这个需要回复"，不会把请求-响应误当 fire-and-forget。
- **开闭原则**——新增信息流类型时，往联合里加一个变体，不改已有变体。翻译层新增一个映射，不改已有映射。消费层新增一个 handler，不改已有 handler。底座新推一种事件 type，兜底机制原样透传。

### 2.2 KernelEvent 联合类型

```typescript
// domain/events/kernel-event.ts —— 圆心，零依赖，纯类型。

import type { SessionEvent } from "./session-state";

// ============ 来源一：pi 底座推送 ============

/** 底座事件（已翻译为中性 SessionEvent）。 */
export interface SessionMessageEvent {
  source: "pi";
  kind: "session";
  event: SessionEvent;
}

/** 底座 Extension UI 请求（需回复）。 */
export interface ExtensionUIRequestEvent {
  source: "pi";
  kind: "extensionUI";
  /** 请求 id（底座分配，回复时原样带回）。 */
  requestId: string;
  method: "select" | "confirm" | "input" | "editor" | "notify"
         | "setStatus" | "setWidget" | "setTitle" | "set_editor_text";
  [key: string]: unknown;
}

// ============ 来源二：desktop 自产 ============

/** 进程退出（期望退出或崩溃）。 */
export interface ProcessExitEvent {
  source: "desktop";
  kind: "processExit";
  /** 退出码；null = 被 signal 杀死。 */
  code: number | null;
  /** 退出信号；null = 正常 exit。 */
  signal: string | null;
  /** 是否桌面端主动停止（期望退出，非崩溃）。 */
  expected: boolean;
  /** stderr 最后 500 字符（崩溃时辅助诊断）。 */
  stderr: string;
  /** 关联的会话 key（procs Map 的 key，非 sessionFile）。 */
  sessionKey: string;
}

/** RPC 命令失败（超时或进程退出导致 reject）。 */
export interface RpcErrorEvent {
  source: "desktop";
  kind: "rpcError";
  /** 失败原因分类。 */
  reason: "timeout" | "processExit" | "sendError";
  /** 超时时附带的命令 id（timeout 时有值）。 */
  requestId?: string;
  /** 错误消息。 */
  message: string;
  /** 关联的会话 key。 */
  sessionKey: string;
}

// ============ 统一联合 ============

export type KernelEvent =
  | SessionMessageEvent
  | ExtensionUIRequestEvent
  | ProcessExitEvent
  | RpcErrorEvent;
```

这个设计的核心决策是 `source` + `kind` 两个字段做语义区分。`source` 标识"谁产生的"（`"pi"` 或 `"desktop"`），`kind` 标识"什么类型的信息"（`"session"` / `"extensionUI"` / `"processExit"` / `"rpcError"`）。两个字段的组合是确定性的——每种组合对应一种 KernelEvent 变体，消费者按 `source` + `kind` 做 switch（或按 `kind`，如果只关心类型不关心来源）。

为什么不用 `SessionEvent` 直接扩展——往 `SessionEvent` 联合里加 `ProcessExitEvent` 等变体？因为 `SessionEvent` 的语义是"底座会话事件"，它的所有变体（`messageStart`、`toolCallEnd`、`agentSettled`…）都是底座 agent 运行时的产物。进程退出和 RPC 超时不是底座产生的，塞进去会模糊 `SessionEvent` 的语义边界。`KernelEvent` 是更大的筐，`SessionEvent` 是里面的一格——包含关系而非替代。

为什么 `SessionMessageEvent` 要包一层 `event: SessionEvent` 而不是直接把 `SessionEvent` 的变体铺进 `KernelEvent`？因为 `KernelEvent` 需要区分"这是底座事件"和"这是桌面端事件"——消费者可能只关心 `source: "desktop"` 的事件（进程状态），不想逐个判断 15 种 `SessionEvent` 变体。包一层让 `source` + `kind` 成为一级判别字段，消费者先按 `kind` 路由，再按需展开 `event`。

### 2.3 Extension UI 在联合里的特殊性

Extension UI 是 `KernelEvent` 里唯一需要回复的变体。消费者收到 `ExtensionUIRequestEvent` 后，必须调一个回复 API 把 `extension_ui_response` 写回 pi 的 stdin。

这个回复动作不经过事件流——它是一个主动的 IPC 调用（`window.pi.sessions.replyExtensionUI(requestId, value)`），不是"产生一个 KernelEvent 推回去"。原因：回复是桌面端→底座方向，走的是 pi 的 stdin，不是 stdout。事件流只覆盖 stdout→桌面端方向。回复路径是 `preload → IPC → main → SessionStore.replyExtensionUI() → adapter.sendExtensionUIResponse() → pi stdin`。

底座等不到回复怎么办？`RpcAdapter` 需要给每个 `extension_ui_request` 设一个超时——默认 60 秒（底座 agent 的交互等待通常不会超过这个时间）。超时后自动回一个 `cancelled: true` 的响应，让底座不卡死。这个超时在 `RpcAdapter` 层做（它管 stdin/stdout），不在 `SessionStore` 层做（它不直接碰 stdin/stdout）。

## 3 pi 底座事件体系

### 3.1 stdout 三类消息的分流

`RpcAdapter.handleLine`（`rpc-adapter.ts:160`）已经正确实现了分流：先查 `extension_ui_request`（优先级最高，因为有阻塞），再查 `response`（按 id 配对），其余当 event 转发。这个分派顺序不需要改——它确保底座等待回复的请求不会被 event 流量的洪峰挤到后面。

当前的问题不在分流，在分流之后。`extension_ui_request` 分流后进了 `extUiListeners` 的空集——`SessionStore` 从未调 `adapter.onExtensionUI()` 注册监听。修法是 `SessionStore.start()` 里在 `adapter.onEvent(...)` 之后加一行 `adapter.onExtensionUI((req) => this.handleExtensionUI(key, req))`，把 Extension UI 请求接入 `dispatch`。

### 3.2 底座事件全集和兜底

`TYPE_MAP`（`event-translator.ts:10`）映射了 21 种 pi 事件 type。翻译后的 `SessionEvent` 联合定义了 15 种接口 + 1 个兜底 `{ type: string; [key: string]: unknown }`。差出来的 6 种被翻译了但没进联合——它们走兜底，消费者收到的是 `{ type: "turnStart", ... }` 而不是 `{ type: "turnStart"; ...具体字段... }`。

这 6 种是：

- `turnStart` / `turnEnd`——底座 agent 的一轮（turn）开始和结束。和 `agentStart`/`agentEnd` 不同：一个 agent 轮次可以包含多个 turn（比如 steer/followUp 排队的消息各自是一个 turn）。当前 `applyEvent` 不处理这两个，流式状态靠 `agentStart`/`agentSettled` 驱动，功能上够用。但插件如果想在 turn 粒度做统计（如"这一轮用了多少 token"），拿不到结构化的 turn 边界。
- `sessionInfoChanged`——会话信息变更（如会话被重命名）。当前 `applyEvent` 不处理，renderer 的 `snapshot.state.sessionName` 不会随这个事件更新。用户在底座侧改了会话名（如果底座支持这种操作），桌面端不刷新。
- `thinkingLevelChanged` / `thinkingLevelSelect`——思考强度变更。当前 `applyEvent` 不处理，renderer 的 `snapshot.state.thinkingLevel` 不随事件更新。用户在底座侧切了思考强度（比如通过底座自己的 UI），桌面端的思考强度 pill 不刷新。
- `sessionInfoChanged` 重复出现是因为它的语义覆盖面广（不限于改名），需要拆成精确的子类型还是统一一个接口，取决于底座后续的演进。当前先统一一个接口，字段宽松。

### 3.3 翻译补全：6 种事件补接口到联合

补法是在 `domain/events/session-state.ts` 的 `SessionEvent` 联合里加 5 个新接口（`sessionInfoChanged` 合一个）：

```typescript
export interface TurnStartEvent { type: "turnStart" }
export interface TurnEndEvent { type: "turnEnd" }
export interface SessionInfoChangedEvent {
  type: "sessionInfoChanged";
  sessionName?: string;
  [key: string]: unknown;
}
export interface ThinkingLevelChangedEvent {
  type: "thinkingLevelChanged";
  thinkingLevel?: string;
  [key: string]: unknown;
}
export interface ThinkingLevelSelectEvent {
  type: "thinkingLevelSelect";
  thinkingLevel?: string;
  [key: string]: unknown;
}
```

字段用 `[key: string]: unknown` 保持宽松——底座字段形状未完全文档化，过度约束会脆。消费者按需 `as` 取字段，但至少 `type` 字段是精确的字面量，switch 不会漏。

加到联合里：

```typescript
export type SessionEvent =
  | ToolCallStart | ToolCallUpdate | ToolCallEnd
  | AgentStartEvent | AgentEndEvent | AgentSettledEvent
  | MessageStartEvent | MessageUpdateEvent | MessageEndEvent
  | EntryAppendedEvent | SessionStartEvent | ModelSelectEvent
  | CompactionStartEvent | CompactionEndEvent
  | QueueUpdateEvent
  | AutoRetryStartEvent | AutoRetryEndEvent
  | TurnStartEvent | TurnEndEvent                    // 新增
  | SessionInfoChangedEvent                           // 新增
  | ThinkingLevelChangedEvent | ThinkingLevelSelectEvent  // 新增
  | { type: string; [key: string]: unknown };
```

### 3.4 敏感字段过滤的位置

`translateEvent` 当前只做 type 映射，字段原样透传。`content[]`/`toolCalls[].args` 等可能包含敏感信息（文件路径、环境变量、API key）的字段不做过滤。

过滤的正确位置仍然是 `event-translator.ts`——它在协议边界，能拦截底座吐出的所有事件。但过滤需要知道"哪个插件订阅了这个事件"以及"该插件有没有相应权限"。当前 `translateEvent` 是无状态纯函数，拿不到订阅者信息。

演进方案是给 `translateEvent` 加一个可选的 `context` 参数，`SessionStore.dispatch` 在调 `translateEvent` 时传入当前订阅者列表和权限信息。translator 按权限决定是否过滤敏感字段。但这改变了 `translateEvent` 的签名——从纯函数变成有上下文的函数。当前不做，标注"演进"，因为权限体系本身还没建到能 per-plugin per-field 过滤的程度。

## 4 Extension UI：双向请求-响应通道

Extension UI 是整个事件机制里唯一需要"有来有回"的部分。底座推请求，桌面端必须回响应。这条通道目前完全断了，是优先级最高的缺口。

### 4.1 底座侧：请求的 8 种 method

`RpcExtensionUIRequest`（`rpc-types.ts:121`）定义了 8 种 method：

- `select`——让用户从选项列表里选一个（如"选哪个方案？"）。
- `confirm`——让用户确认（是/否，如"要执行这个 bash 命令吗？"）。
- `input`——让用户输入文本（如"给这个文件起名"）。
- `editor`——让用户在编辑器里编辑文本（如"修改这段代码"）。
- `notify`——通知用户一件事（不需要回复，但当前协议要求回 response）。
- `setStatus`——设置状态栏文本（不需要回复，但协议要求回）。
- `setWidget`——设置桌面端的 widget 显示（不需要回复，但协议要求回）。
- `setTitle` / `set_editor_text`——设置标题/编辑器文本。

这些 method 的回复内容不同：`select` 回选中的值，`confirm` 回 true/false，`input` 回文本，`editor` 回编辑后的文本，`notify`/`setStatus`/`setWidget`/`setTitle`/`set_editor_text` 回一个"已处理"的 ack。但回复协议是统一的——都是 `RpcExtensionUIResponse`（`rpc-types.ts:129`），带 `id`（和请求的 id 对应）、`value`（文本/选中值）、`confirmed`（布尔）、`cancelled`（取消标记）。

### 4.2 桌面端侧：从 RpcAdapter 到 SessionStore 到 IPC

打通方案分三层：

**RpcAdapter 层**——已有 `onExtensionUI` 和 `extUiListeners`，不需要改。但需要新增一个发送响应的方法：

```typescript
// rpc-adapter.ts 新增
sendExtensionUIResponse(response: RpcExtensionUIResponse): void {
  if (!this.handle.stdin) throw new Error("pi 未启动");
  const line = JSON.stringify(response) + "\n";
  this.handle.stdin.write(line);
}
```

这个方法只是把 `RpcExtensionUIResponse` 序列化成 JSON 写到 stdin。和 `send()` 不同——它不走 correlator 配对（不需要 id 配对 response，因为 extension_ui_response 不产生 response），它是 fire-and-forget 写入。

**SessionStore 层**——新增两个方法：

```typescript
// session-store.ts 新增

/** 注册 Extension UI 请求的处理器。返回取消函数。 */
onExtensionUI(cb: (req: RpcExtensionUIRequest) => void): () => void {
  this.extUiListeners.add(cb);
  return () => this.extUiListeners.delete(cb);
}

/** 回复 Extension UI 请求。 */
async replyExtensionUI(requestId: string, response: {
  value?: string;
  confirmed?: boolean;
  cancelled?: true;
}): Promise<void> {
  const proc = this.activeProc();
  if (!proc) throw new Error("pi 未启动");
  proc.adapter.sendExtensionUIResponse({
    type: "extension_ui_response",
    id: requestId,
    value: response.value,
    confirmed: response.confirmed,
    cancelled: response.cancelled,
  });
}
```

`SessionStore.start()` 里注册 adapter 监听：

```typescript
adapter.onExtensionUI((req) => {
  // 构造 KernelEvent 推给消费者
  this.dispatchKernel(key, {
    source: "pi",
    kind: "extensionUI",
    requestId: req.id,
    method: req.method,
    ...req,
  });
});
```

**IPC 层**——`preload.ts` 新增两个方法，`index.ts` 新增两个 IPC handler：

```typescript
// preload.ts pi.sessions 新增
onExtensionUI: (cb: (req: unknown) => void): (() => void) => {
  const listener = (_e: unknown, req: unknown) => cb(req);
  ipcRenderer.on("session:extensionUI", listener);
  return () => { ipcRenderer.removeListener("session:extensionUI", listener); };
},
replyExtensionUI: (requestId: string, response: {
  value?: string; confirmed?: boolean; cancelled?: true;
}): Promise<void> => ipcRenderer.invoke("session:replyExtensionUI", requestId, response),
```

```typescript
// index.ts 新增
sessionStore.onExtensionUI((req) => {
  for (const w of BrowserWindow.getAllWindows())
    w.webContents.send("session:extensionUI", req);
});
ipcMain.handle("session:replyExtensionUI",
  (_e, requestId: string, response: { value?: string; confirmed?: boolean; cancelled?: true }) =>
    sessionStore.replyExtensionUI(requestId, response));
```

### 4.3 插件侧：收到请求 + 回复

插件通过 `ctx.sessions.onExtensionUI(cb)` 订阅请求，通过 `ctx.sessions.replyExtensionUI(requestId, response)` 回复。

一个 `confirm` 请求的处理示例：

```typescript
// 插件 renderer
useEffect(() => {
  const off = ctx.sessions.onExtensionUI((req) => {
    if (req.method === "confirm") {
      // 弹确认对话框
      setShowConfirm({ requestId: req.id, message: req.message });
    }
  });
  return off;
}, []);

// 用户点"确认"后
const handleConfirm = async () => {
  await ctx.sessions.replyExtensionUI(activeRequest.requestId, { confirmed: true });
  setShowConfirm(null);
};

// 用户点"取消"后
const handleCancel = async () => {
  await ctx.sessions.replyExtensionUI(activeRequest.requestId, { cancelled: true });
  setShowConfirm(null);
};
```

插件不需要处理所有 8 种 method。框架层可以提供一个默认处理器，对 `notify`/`setStatus`/`setWidget`/`setTitle`/`set_editor_text` 这些不需要用户交互的 method 自动回复 ack。只有 `select`/`confirm`/`input`/`editor` 需要插件或框架弹 UI。这个默认处理器在 `SessionStore` 里注册一个 fallback——如果插件没有处理某个请求，60 秒后自动回 `cancelled: true`。

### 4.4 超时兜底

底座推 `extension_ui_request` 后会阻塞等待。如果桌面端崩溃、或插件代码有 bug 没回复、或用户离开桌面不操作，底座会永远卡住。

兜底机制在 `RpcAdapter` 层。`handleLine` 收到 `extension_ui_request` 时启动一个 60 秒定时器，到时自动回 `{ type: "extension_ui_response", id, cancelled: true }`。如果桌面端在 60 秒内正常回复了，取消定时器。

为什么 60 秒？底座 agent 的交互等待通常不超过这个时间——如果用户 60 秒没操作，大概率已经离开。自动 cancel 让底座能继续走（通常会走错误处理或跳过这个步骤），不卡死。60 秒可配置，但默认值要保守——宁可早 cancel 也别让底座无限等。

## 5 desktop 自产事件

### 5.1 进程生命周期事件

`SubprocessHandle` 的 `onceExit` 和 `onceError` 当前在 `RpcAdapter.start()` 里被绑定，但只做了 `rejectAll`。需要增加：把退出信息包装成 `ProcessExitEvent`，经 `SessionStore.dispatch` 推给消费者。

改造在 `RpcAdapter` 层。当前 `onceExit` 回调：

```typescript
// 当前（rpc-adapter.ts:93）
handle.onceExit((exit: ProcessExit) => {
  if (this.stopping) return; // 期望退出，不设 exitError
  const err = new RpcProcessError(...);
  this.exitError = err;
  this.correlator.rejectAll(err);
});
```

改成：

```typescript
handle.onceExit((exit: ProcessExit) => {
  const expected = this.stopping;
  if (!expected) {
    this.exitError = new RpcProcessError(...);
    this.correlator.rejectAll(this.exitError);
  }
  // 通知上层：进程退出了（期望和崩溃都通知）
  this.onProcessExit?.(exit, expected);
});
```

`RpcAdapter` 新增一个可选的 `onProcessExit` 回调属性，由 `SessionStore` 在创建 adapter 后设置。`SessionStore` 收到后包装成 `ProcessExitEvent` 推给 `dispatch`：

```typescript
// session-store.ts start() 里
adapter.onProcessExit = (exit, expected) => {
  this.dispatchKernel(key, {
    source: "desktop",
    kind: "processExit",
    code: exit.code,
    signal: exit.signal,
    expected,
    stderr: adapter.stderr.slice(-500),
    sessionKey: key,
  });
};
```

`expected: true` 表示桌面端主动 stop（用户切会话或应用退出），`expected: false` 表示崩溃。消费者（插件）可以据此展示不同 UI："正在停止…"vs"连接已断开"。

### 5.2 RPC 错误事件

`RequestCorrelator` 的超时和 `rejectAll` 当前只 reject Promise。需要增加：把失败信息包装成 `RpcErrorEvent`。

改造在 `SessionStore` 层。当前 `send()` 方法：

```typescript
// 当前（session-store.ts:412）
async send(command: RpcCommand): Promise<unknown> {
  const proc = this.activeProc();
  if (!proc || !proc.adapter.alive) throw new Error("pi 未启动");
  return proc.adapter.send(command);
}
```

改成：

```typescript
async send(command: RpcCommand): Promise<unknown> {
  const proc = this.activeProc();
  if (!proc || !proc.adapter.alive) throw new Error("pi 未启动");
  const key = this.activeKey;
  try {
    return await proc.adapter.send(command);
  } catch (err) {
    // 通知上层：RPC 命令失败了
    // 按 err.code 判定超时（RpcTimeoutError 带 code="timeout"，不靠中文 substring 匹配）
    const reason = err instanceof Error && (err as { code?: string }).code === "timeout"
      ? "timeout" : "sendError";
    this.dispatchKernel(key, {
      source: "desktop",
      kind: "rpcError",
      reason,
      message: err instanceof Error ? err.message : String(err),
      sessionKey: key,
    });
    throw err; // 仍然 throw，调用方需要处理
  }
}
```

进程退出导致的 `rejectAll` 产出的 `RpcErrorEvent` 由 §5.1 的 `ProcessExitEvent` 覆盖——不重复产 `RpcErrorEvent`。只有非进程退出原因的 RPC 失败（超时、stdin 写失败）才单独产 `RpcErrorEvent`。

### 5.3 投递时机：不经过激活过滤

进程退出和 RPC 错误不经 `dispatch` 的"激活会话过滤"（`session-store.ts:440` 的 `isLifecycleEvent` 判断）。这两个事件对全部消费者都有意义——插件需要知道哪个会话的进程死了，不管它是不是当前激活的。

新的 `dispatchKernel` 方法处理所有 `KernelEvent` 的投递：

```typescript
private dispatchKernel(key: string, event: KernelEvent): void {
  // 底座事件（SessionMessageEvent）走原有激活过滤逻辑
  if (event.kind === "session") {
    // 复用现有 dispatch 的过滤：非激活会话只放行生命周期事件
    const isLifecycleEvent = ...; // 现有逻辑
    if (!isLifecycleEvent && key !== this.activeProcKey) return;
  }
  // Extension UI、processExit、rpcError：全广播，不经过滤
  for (const cb of this.kernelListeners) {
    try { cb(event); } catch (err) {
      console.error("[session-store] kernel event listener 抛错已隔离:", err);
    }
  }
}
```

现有 `dispatch` 方法改为内部调用 `dispatchKernel`——把 `SessionEvent` 包成 `SessionMessageEvent` 后投递。原有 `onEvent` 回调保留向后兼容，新增 `onKernelEvent` 回调接收全部 `KernelEvent`。

## 6 投递层：从两个来源到消费者

### 6.1 当前 dispatch 的三重职责

`SessionStore.dispatch`（`session-store.ts:420`）当前混了三件事：

- **路由过滤**——判断事件该不该转发给激活会话（`isLifecycleEvent` 检查 + `key !== activeProcKey` 检查）。
- **sessionStart 捕获**——从 `sessionStart` 事件里提取 `sessionFile`，更新 `boundSessionPath` 和 `activeSessionPath`。
- **TPS 计算**——`messageStart` 记时，`messageEnd` 用 output tokens / 耗时算 TPS。

这违反了 CLAUDE.md §3.2"构造与执行分开"——TPS 计算是"从事件提取指标"（构造），dispatch 是"决定事件往哪投"（执行），两者绑在一个方法里。改 TPS 算法要动 dispatch，改路由策略要动 TPS 逻辑。

> **注**：rpc-adapter `start()` 里的 100ms 固定 sleep 已删除（§3.6 事件驱动不 sleep），就绪靠 `waitReady` 的 `get_state` 探测确认。本节描述的 TPS 拆分尚未落地，TPS 计算仍在 dispatch 里。

### 6.2 职责拆分：TPS 独立为 event transformer

拆法是把 TPS 计算从 `dispatch` 里抽出来，变成一个独立的 event transformer——一个接收 `SessionEvent`、返回 `SessionEvent`（可能附加了 TPS 信息）的纯函数。

```typescript
// application/orchestrations/tps-transformer.ts

/** TPS 跟踪状态（per-session）。 */
interface TpsState {
  genStartMs: number | null;
  lastTps: number | null;
}

/** 创建一个 TPS transformer。返回 transform 函数 + 取 lastTps 的 getter。 */
export function createTpsTransformer(): {
  transform: (event: SessionEvent, state: TpsState) => SessionEvent;
  getTps: (state: TpsState) => number | null;
} {
  return {
    transform: (event, state) => {
      if (event.type === "messageStart") {
        state.genStartMs = Date.now();
      } else if (event.type === "messageEnd" && state.genStartMs != null) {
        const elapsed = (Date.now() - state.genStartMs) / 1000;
        const out = extractOutputTokens((event as { message?: unknown }).message);
        state.lastTps = elapsed > 0 && out > 0 ? out / elapsed : null;
        state.genStartMs = null;
      }
      return event; // TPS transformer 不改事件内容，只更新 state
    },
    getTps: (state) => state.lastTps,
  };
}
```

`dispatch` 在投递前调 `tpsTransformer.transform(event, proc.tpsState)`，TPS 状态存在 `SessionProc` 里。`getStats` 时从 `tpsState` 取 `lastTps` 注入。`dispatch` 本身只管路由——收事件、过滤、转发，不管 TPS。

`sessionStart` 捕获也类似——它是一个"副作用"，不是"路由"。但它的逻辑（从事件取 `sessionFile` 更新内部状态）比 TPS 简单，且和路由强相关（更新 `boundSessionPath` 影响后续事件的路由上下文）。当前可以先留在 `dispatch` 里，标注"可进一步抽离"。

### 6.3 事件过滤策略

当前过滤策略：非激活会话只放行 4 种生命周期事件（`messageEnd`/`agentSettled`/`agentEnd`/`sessionStart`），流式增量全部丢弃。

这个策略对底座事件是合理的——流式增量只给当前视图看，后台会话的流式 UI 没意义。但对 `KernelEvent` 需要调整：

- `SessionMessageEvent`——保持现有策略（非激活会话的流式增量丢弃）。
- `ExtensionUIRequestEvent`——全广播。底座的交互请求不管来自哪个会话，都可能需要当前激活的 UI 去响应。
- `ProcessExitEvent`——全广播。插件需要知道所有会话的进程状态。
- `RpcErrorEvent`——全广播。同上。

### 6.4 IPC 桥：session:event 扩展为 kernel:event

当前 IPC 通道 `session:event` 只传 `SessionEvent`。新增 `session:kernelEvent` 通道传 `KernelEvent`。两个通道并行——`session:event` 保留向后兼容（现有插件的 `onEvent` 不需要改），`session:kernelEvent` 是新通道（订阅 `onKernelEvent` 的插件收到全部信息流）。

```typescript
// index.ts
sessionStore.onKernelEvent((event) => {
  for (const w of BrowserWindow.getAllWindows())
    w.webContents.send("session:kernelEvent", event);
});

// preload.ts pi.sessions 新增
onKernelEvent: (cb: (event: unknown) => void): (() => void) => {
  const listener = (_e: unknown, event: unknown) => cb(event);
  ipcRenderer.on("session:kernelEvent", listener);
  return () => { ipcRenderer.removeListener("session:kernelEvent", listener); };
},
```

`SessionStore` 内部，`dispatch` 投递 `SessionEvent` 时同时推两个通道——老的 `onEvent` 回调收 `SessionEvent`，新的 `onKernelEvent` 回调收 `SessionMessageEvent`（包了一层 `source` + `kind` + `event`）。这保证了向后兼容：现有插件不改也能继续工作，新插件用 `onKernelEvent` 收到更全的信息。

## 7 消费层：renderer store 改造

### 7.1 applyEvent if-chain 的问题

`packages/react/src/session-store.ts:48` 的 `applyEvent` 是一个大 if-chain，对每种事件类型硬编码 patch 逻辑：

```typescript
function applyEvent(messages: NeutralMessage[], event: SessionEvent): NeutralMessage[] {
  if (event.type === "messageUpdate" && msg) { ... }
  if (event.type === "messageStart" && msg) { ... }
  if (event.type === "messageEnd" && msg) { ... }
  if (event.type === "entryAppended") { ... }
  return messages;
}
```

新增一个需要修改 `messages[]` 的事件类型，必须改这个函数——违反开闭原则。比如补上 `sessionInfoChanged` 后需要更新 `snapshot.state.sessionName`，就得在 `applyEvent` 里加一个 `if` 分支。

### 7.2 handler 注册表

改法是把 if-chain 换成 handler 注册表——按 `event.type` 查表，不 if-chain：

```typescript
type StateTransformer = (state: SessionStoreState, event: SessionEvent) => SessionStoreState;

const handlers = new Map<string, StateTransformer>();

export function registerSessionEventHandler(type: string, handler: StateTransformer): void {
  handlers.set(type, handler);
}

function applyEvent(state: SessionStoreState, event: SessionEvent): SessionStoreState {
  const handler = handlers.get(event.type);
  if (handler) return handler(state, event);
  // 兜底：未知事件不改 messages
  return state;
}
```

框架在初始化时注册核心 handler：

```typescript
registerSessionEventHandler("messageUpdate", (state, event) => {
  const msg = (event as { message?: NeutralMessage }).message;
  if (!msg) return state;
  // 现有 messageUpdate 逻辑
  return { ...state, messages: patchMessages(state.messages, msg) };
});

registerSessionEventHandler("messageStart", (state, event) => { ... });
registerSessionEventHandler("messageEnd", (state, event) => { ... });
registerSessionEventHandler("entryAppended", (state, event) => { ... });
```

插件也可以注册自己的 handler——如果某个插件需要在 `modelSelect` 时更新自己的状态，它调 `registerSessionEventHandler("modelSelect", handler)` 就行，不改框架代码。这是开闭原则的落地。

但要注意：handler 注册表是全局可变的，插件注册的 handler 如果有 bug 会影响全局状态。需要做错误隔离——handler 抛错时 catch 住，不改 state（等效于这个 handler 不存在）。

### 7.3 compactionEnd 触发自动 resync

`compactionEnd` 事件到达 renderer 后需要触发 `sync()` 重新拉基线——compaction 会改变底座的上下文窗口状态，压缩后的消息列表和基线可能不一致（底座可能已经删除了部分历史消息的详细内容，替换成了摘要）。

当前已在 `initSessionStore`（`packages/react/src/session-store.ts`）里实现——收到 `compactionEnd` 事件时调 `void window.pi.sessions.sync()` 重新拉基线。不是 handler 注册表形态（§7.2 的设计尚未落地），而是在 `onEvent` 回调里直接判断 type 触发，效果一致：基线到了自动覆盖 `messages`，不阻塞当前渲染。

### 7.4 背压：流式高频 messageUpdate

`applyEvent` 每次创建新数组（`messages.map(...)` 或 `[...messages, msg]`）。流式期间 `messageUpdate` 高频到达——底座每生成一个 token 就推一次 update。对于长会话（上百条消息），每次 update 都拷贝整个数组，O(n) 的数组拷贝在高频下可能造成 GC 压力和渲染抖动。

两个层面的优化：

- **批量合并**——不每次 update 都 setState，而是把 16ms 内到达的多个 update 合并成一次 setState。用 `requestAnimationFrame` 或 microtask 延迟实现。`useSessionStore` 的 `setState` 从同步改为 raf-batched。
- **结构共享**——不拷贝整个数组，而是用 immer（或手写 persistent data structure）做不可变更新。`messages.map((m, i) => i === idx ? { ...m, ...patch } : m)` 只改了受影响的元素，其他元素引用不变。React 的 `useMemo` / `memo` 能跳过未变元素的渲染。

当前先做批量合并（rAF throttle），结构共享标注"演进"。rAF throttle 把 60fps 的 setState 降到每帧一次，对大多数场景够用。结构共享的收益在于超长会话（500+ 条消息），当前还不到那个量级。

## 8 插件消费 API

### 8.1 订阅 API

插件有两个订阅入口：

- `ctx.sessions.onEvent(cb)`——只收底座事件（`SessionEvent`），向后兼容。现有插件的 `onEvent` 代码不需要改。
- `ctx.sessions.onKernelEvent(cb)`——收全部内核事件（`KernelEvent`），包括底座事件、Extension UI、进程退出、RPC 错误。

`onKernelEvent` 在 `SessionsApi` 接口里新增：

```typescript
// domain/sessions.ts SessionsApi 新增
export interface SessionsApi {
  // ...现有方法...

  /** 订阅全部内核事件（底座事件 + Extension UI + 进程退出 + RPC 错误）。 */
  onKernelEvent(cb: (event: KernelEvent) => void): () => void;
}
```

`usePluginContext`（`packages/react/src/plugin-context.ts`）补上绑定：

```typescript
const sessions: SessionsApi = {
  // ...现有方法...
  onKernelEvent: (cb) => window.pi.sessions.onKernelEvent((e) => cb(e as KernelEvent)),
};
```

插件用法示例：

```typescript
// 插件订阅进程状态
useEffect(() => {
  const off = ctx.sessions.onKernelEvent((event) => {
    if (event.kind === "processExit" && !event.expected) {
      setStatus("disconnected");
    }
    if (event.kind === "rpcError") {
      console.warn("RPC 失败:", event.message);
    }
  });
  return off;
}, []);
```

### 8.2 回复 Extension UI

插件通过 `ctx.sessions.onExtensionUI(cb)` 收请求，通过 `ctx.sessions.replyExtensionUI(requestId, response)` 回复。

`SessionsApi` 新增：

```typescript
export interface SessionsApi {
  // ...现有方法...

  /** 订阅底座 Extension UI 请求（需回复）。 */
  onExtensionUI(cb: (req: RpcExtensionUIRequest) => void): () => void;

  /** 回复 Extension UI 请求。 */
  replyExtensionUI(requestId: string, response: {
    value?: string;
    confirmed?: boolean;
    cancelled?: true;
  }): Promise<void>;
}
```

`usePluginContext` 补绑定，`preload.ts` 和 `index.ts` 如 §4.2 所述新增 IPC 通道。

插件不需要处理所有 8 种 method。框架提供一个默认 fallback——对插件没处理的请求，60 秒后自动 cancel。这样即使没有插件处理 Extension UI，底座也不会卡死。

### 8.3 进程状态感知

插件通过 `onKernelEvent` 收 `ProcessExitEvent`，展示连接状态：

```typescript
// 进程状态感知示例
const [connected, setConnected] = useState(false);

useEffect(() => {
  const off = ctx.sessions.onKernelEvent((event) => {
    if (event.source === "desktop" && event.kind === "processExit") {
      setConnected(false);
    }
    // pi 发的事件里有 sessionStart → 重新连上了
    if (event.source === "pi" && event.kind === "session") {
      if (event.event.type === "sessionStart") setConnected(true);
    }
  });
  return off;
}, []);
```

### 8.4 插件之间的间接通信

现有纪律不变：插件之间不直接通信，通过共享 store 状态间接交互。`KernelEvent` 不改变这条纪律——它只是让更多信息流进了共享 store。插件 A 订阅了 `processExit` 事件并更新了 `useSessionStore` 的状态，插件 B 通过 `useSessionStore` 读到这个状态。不是插件 A 通知插件 B，是插件 A 改了共享状态，插件 B 被动收到。

## 9 类型契约对齐

### 9.1 sessionFile 入 SessionStartEvent 类型

当前 `SessionStartEvent`（`session-state.ts:153`）声明 `{ type: "sessionStart"; reason?: string }`，但 `SessionStore.dispatch`（`session-store.ts:424`）用 `as { sessionFile?: string }` 取了未声明的 `sessionFile` 字段。

修法是把 `sessionFile` 加到接口里：

```typescript
export interface SessionStartEvent {
  type: "sessionStart";
  reason?: string;
  /** 新会话首次落盘的文件路径（底座创建文件后推带）。 */
  sessionFile?: string;
}
```

消除 `as { sessionFile?: string }` 强转——类型系统直接知道这个字段存在。

### 9.2 message 字段从 unknown 到 NeutralMessage

当前 `MessageStartEvent`/`MessageUpdateEvent`/`MessageEndEvent`（`session-state.ts:148-150`）声明 `message?: unknown`，但 `applyEvent`（`session-store.ts:49`）用 `as NeutralMessage` 强转后直接访问 `.id`/`.role`/`.content`。

修法是把 `message` 字段类型从 `unknown` 改为 `NeutralMessage`：

```typescript
export interface MessageStartEvent {
  type: "messageStart";
  message?: NeutralMessage;
}
export interface MessageUpdateEvent {
  type: "messageUpdate";
  message?: NeutralMessage;
}
export interface MessageEndEvent {
  type: "messageEnd";
  message?: NeutralMessage;
}
```

`NeutralMessage` 已经在同一个文件里定义了（`session-state.ts:94`），不引入新依赖。`translateEvent` 原样透传字段，底座推的 `message` 对象结构大体和 `NeutralMessage` 一致（都有 `role`/`content`/`id`），改成 `NeutralMessage` 不丢数据——`NeutralMessage` 有 `[key: string]: unknown` 兜底，多余字段不报错。

### 9.3 modelSelect 的 model 字段

当前 `session-store.ts:167` 有 `(event as { model?: never }).model`——`never` 是类型系统的"不可能值"，这个 cast 在编译期让 TypeScript 认为这个分支不可达。

修法是把 `ModelSelectEvent` 的 `model` 字段类型约束为 `ModelInfo | undefined`：

```typescript
export interface ModelSelectEvent {
  type: "modelSelect";
  model?: ModelInfo;
  source?: string;
}
```

`ModelInfo` 已经在同一个文件里定义了（`session-state.ts:8`）。消除 `as { model?: never }` 强转。

### 9.4 Extension UI 请求/响应的完整类型

`RpcExtensionUIRequest` 和 `RpcExtensionUIResponse` 已在 `rpc-types.ts:121-135` 定义。需要把它们 re-export 到 `domain/events/kernel-event.ts`，让插件通过 `@my-harness-desktop/core` 拿到类型。

`ExtensionUIRequestEvent` 的 `method` 字段直接用 `RpcExtensionUIRequest["method"]` 类型——契约单源，不重复定义。

## 10 QA

**Q：KernelEvent 包了一层 `SessionMessageEvent`，现有插件的 `onEvent` 还能用吗？**

能。`onEvent` 通道不变——它仍然只收 `SessionEvent`（底座事件），不收 `KernelEvent`。`SessionStore` 内部投递时同时推两个回调集：`onEvent` 回调收裸 `SessionEvent`，`onKernelEvent` 回调收包了 `source`/`kind` 的 `KernelEvent`。现有插件不调 `onKernelEvent` 就不受影响。新插件调 `onKernelEvent` 收到更全的信息。

**Q：Extension UI 请求的 60 秒超时和 correlator 的 30 秒超时是什么关系？**

不同机制，不同目的。correlator 的 30 秒超时是给 RPC 请求-响应用的——桌面端发命令到 pi stdin，30 秒没回 response 就 reject Promise。Extension UI 的 60 秒超时是给底座发起的请求-响应用的——底座推 `extension_ui_request` 到 stdout，60 秒没收到 `extension_ui_response` 就自动 cancel。两个超时在不同方向、管不同类型的消息，互不干扰。

**Q：进程崩溃时，ProcessExitEvent 和 RpcErrorEvent 会重复吗？**

会部分重叠，但不重复产生。进程退出时 `RpcAdapter` 的 `onceExit` 回调产出 `ProcessExitEvent`；同时 `correlator.rejectAll` reject 了所有 pending 请求，`SessionStore.send()` 的 catch 会为每个 rejected 请求产出一个 `RpcErrorEvent`（`reason: "processExit"`）。这是有意的设计——`ProcessExitEvent` 告诉消费者"进程死了"（一次），`RpcErrorEvent` 告诉消费者"你发的哪个命令失败了"（每个 pending 命令一个）。消费者可以按 `reason: "processExit"` 过滤掉进程退出导致的 RPC 错误（因为 `ProcessExitEvent` 已经覆盖了根因），只关注非进程退出原因的 RPC 错误（`reason: "timeout"` / `"sendError"`）。

**Q：handler 注册表会不会让插件互相干扰？**

会，如果插件注册了一个有 bug 的 handler。防护方式是错误隔离——`applyEvent` 调 handler 时 try/catch，handler 抛错不改变 state（等效于 handler 不存在），同时 console.error 记录。这样有 bug 的 handler 只影响它自己关心的那个事件类型的处理，不波及其他 handler。但要注意：如果两个插件注册了同一个 `event.type` 的 handler，后注册的覆盖先注册的。这是有意设计——避免多个 handler 同时改 state 产生冲突。插件注册 handler 时应该检查是否已有同名注册，或者框架用"第一个注册者胜"的规则。

**Q：compactionEnd 触发 sync，如果 sync 又失败了怎么办？**

`sync()` 返回 Promise，失败时 reject。`compactionEnd` handler 里用 `void window.pi.sessions.sync()` 调用——不 await、不 catch。如果 sync 失败，Promise reject 在控制台报一个 unhandled rejection，但不影响 UI。`useSessionStore` 的 `onSnapshot` 监听器不会收到新基线，messages 保持 compaction 前的状态。用户可以手动点"刷新"按钮（调 `ctx.sessions.sync()`）重试。这是"best effort"策略——compaction 后基线可能不对，但不阻塞用户操作。

**Q：Extension UI 请求的 `select`/`confirm`/`input`/`editor` 需要弹 UI，谁来弹？**

当前没有内置插件做这件事。框架层提供一个默认的 fallback——60 秒后自动 cancel。这意味着底座如果推了 `confirm`（"要执行这个 bash 命令吗？"），当前桌面端不会弹确认框，底座 60 秒后收到 cancel，agent 继续走（通常会跳过这个步骤或走默认行为）。后续应该有一个内置插件（如 `extension-ui-bridge`）注册 `onExtensionUI`，对 4 种需交互的 method 弹原生对话框（Electron 的 `dialog.showMessageBox` / `dialog.showInputBox`），把用户选择回复给底座。这个插件和现有插件平等——用同一套 `onExtensionUI` + `replyExtensionUI` API。

**Q：`KernelEvent` 的 `source` 字段是 `"pi"` 或 `"desktop"`，会不会太粗？**

当前够用——消费者需要知道"这是底座推的还是桌面端自产的"来做不同处理。如果未来桌面端有更多自产来源（如插件进程管理、网络状态监控），`source` 可以扩展。但 `source` 不应该变成一个细粒度的"来源 ID"——那会退化成声明式类型标签（CLAUDE.md §1.4），让消费者按 source switch 而不是按 kind 判断。`source` 的语义是"产生方向"（底座推 vs 桌面端产），不是"谁产生的"。后者由 `sessionKey` 隐含——它关联到具体的会话和进程。

**Q：底座新增了一种事件 type，没在 TYPE_MAP 里也没在 SessionEvent 联合里，会怎样？**

走兜底。`translateEvent` 的 `TYPE_MAP[piEvent.type] ?? piEvent.type` 原样透传——新 type 不会被翻译成中性名，用底座的原始 snake_case 名字传递。`SessionEvent` 联合的兜底 `{ type: string; [key: string]: unknown }` 让这个事件类型安全——消费者收到 `{ type: "some_new_event", ... }`，TypeScript 认为它是兜底变体，可以 `switch(event.type)` 的 `default` 分支处理，或忽略。`applyEvent` 的 handler 注册表查不到 `some_new_event`，走兜底不改 state。这是正确的开闭行为——底座新增事件不需要改桌面端代码就能透传，只有想消费新事件时才需要往注册表里加 handler。
