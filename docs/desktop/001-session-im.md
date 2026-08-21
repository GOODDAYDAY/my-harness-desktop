# 001 Session 间通信：会话即用户的多会话 IM 与编排

my-harness-desktop 的 session-store 手里同时跑着多个 pi 子进程（`SessionStore.procs`，`Map<string, SessionProc>`）。每个进程就是一次会话——有独立的 stdin/stdout、独立的 session 文件、独立的生命周期。但今天的壳只把它们**平级并列**管着：会话 A 没有办法指名会话 B 说一句话，因为进程之间没有地址、没有路由、没有消息的概念。一个 agent 想派活出去？想拉几个同行围炉议事？做不到——每个会话是孤岛。

Session Bus 就是补上这块机制的。它把"多会话并列管理"升级为"会话间 IM"：每个会话是一个用户、房间是群、成员关系设好之后说话即传输。subagent 编排是它的第一个租户，不是它的全部。

## 1 IM 映射：会话即用户

总线的全部概念一次对齐：

| IM 概念 | 总线映射 |
|---|---|
| 群聊 | `channel:<name>`，成员 = session / plugin |
| 冒泡发言 | 在房间里的 turn 最终 assistant 消息自动 fan-out（见 §4.1） |
| 潜水 | tap（只收不说的只读观察） |
| 私聊 | 两人 channel——不是特殊机制，就是普通小房间 |
| 退群 = 闭麦 | `channel_member({action: "leave"})` |
| 系统提示音 | 总线自产帧：`peer_joined` / `peer_left` / `session_done` / `bus_throttled` |

这个映射消解了"发送/发布"作为独立动作的必要性——agent 有天然嗓子：在房间里说话就是发消息。当 agent 调 `session_create` 起工人然后说"开始吧"，那条 assistant 消息按成员关系自动 fan 到房间里每个同伴。编排动作（拉人、建房、围观、踢人）是显式 tool 调用，发消息不是。

## 2 地址与信封

### 2.1 四种地址形态

地址类型定义在 `src/core/domain/events/session-bus.ts`，四个前缀判定纯函数：

- **`session:<key>`**——一个活着的 pi 进程。key 即 `procs` Map 的键（激活会话用 sessionPath，总线 spawn 的用 `bus:<uuid8>`）。地址构造：`sessionAddress(key)` → `"session:abc123"`；反向提取：`sessionKeyOf("session:abc123")` → `"abc123"`。
- **`channel:<name>`**——命名房间的全部成员。地址构造：`channelAddress("ops")` → `"channel:ops"`。
- **`plugin:<id>`**——一个 renderer 插件。地址构造：`pluginAddress("sub-agent")` → `"plugin:sub-agent"`。
- **`"desktop"`**——路由器内部 handler，用于 spawn、查询等操作。不是函数，就是字面量。

地址是开放字符串，前缀判定是纯机械的（`startsWith("session:")` / `startsWith("channel:")` / `startsWith("plugin:")`）。新增地址形态只需要路由器加一个前缀分支，信封和 tool 面不感知。

### 2.2 信封：唯一形状

所有消息——上行请求、下行响应、事件通知——共用一个类型：

```typescript
// src/core/domain/events/session-bus.ts
interface SessionBusMessage {
  $bus: true;            // 协议标记，接收方 JSON.parse 后判 $bus === true 识别
  id: string;            // randomUUID，追踪与去重
  from: string;          // 发送方地址，传输层认证覆写，不自报
  to: string;            // 目标地址，§2.1 任一形态
  kind: string;          // 开放字符串。总线自产 "bus_response"、"chat"、"session_done" 等
  payload: unknown;      // 各 kind 的内容层自定义
  timestamp: number;     // Unix ms
  replyTo?: string;      // 请求-响应配对（响应帧带，值 = 原请求 id）
}
```

`from` 的安全模型有一条硬约束：**传输层认证，不由发送方自报**。执行点在路由器的上行入口——`SessionBus.handleFrame`（`src/core/application/sessions/session-bus.ts:63`）拿到 pi 侧帧后，用"从哪条 adapter 来"绑定的 sessionKey **覆写** from 字段，帧里自报的 from 值直接丢弃。插件侧的 from 恒为 `plugin:<id>`（PluginIdContext 框架注入，同样不采信自报）。除此之外零角色校验——谁都能向谁说话，但每个动作可溯源。开放，但不匿名。

## 3 传输层：两条不对称通道拼出的双向回路

总线的通信底座不能发明新协议——pi 的 `RpcCommand` 是 31 个字面量的封闭联合类型，没有 custom 类型。两个方向各有现成通道，不对称，但够用。

### 3.1 下行 desktop→pi：prompt 命令

下行唯一可用的官方通道是 `prompt` RPC 命令。消息以用户输入形态注入会话，agent 天然会读、会回应，且自动持久化进 session 文件。

实现要点：**必须走 `session.prompt()`，不能走 `session.steer()`**。`prompt()` 是所有输入经 `emitInput` 的唯一入口，接收方 extension 的 `input` 钩子才有机会拦截消息——这是 §3.3 整条响应回路的前提。`SessionBus.deliver`（`session-bus.ts:182`）经 `sessionStore.sendPromptTo(key, JSON.stringify(message), streamingBehavior)` 注入。

`streamingBehavior` 按帧型固定分派：响应帧用 `"steer"`（挂起的 tool 调用在等结果，要插队），事件帧用 `"followUp"`（chat、tap_event、session_done 这类通知排队，不打断接收方当前 run）。路由器自动决策，发送方和接收方都不操心。

### 3.2 上行 pi→desktop：stdout custom 行 + $bus 分支

pi 的 extension 运行在 pi 进程内部，可以 `process.stdout.write` 写一行自定义 JSON——pi 的 loader 不拦 stdout。desktop 的 rpc-adapter 对未知 `type` 本来就兜底转发，但总线需要正式分支。

执行点：session-store 的 `createProc`（`session-store.ts:240`）在装配 adapter 时绑了 `adapter.onBusFrame` 回调；rpc-adapter 的 `handleLine` 识别 `$bus === true` 的信封后转给这个回调。bootstrap 把 `sessionStore.onBusFrame` 接到 `sessionBus.handleFrame`（`bootstrap/index.ts:148`），形成完整上行链路。

### 3.3 响应回路：input 钩子的 handled/transform

上行是 fire-and-forget，但 tool 调用要拿结果——agent 调 `session_create`，必须拿到新会话地址作为 tool 返回值。请求-响应语义不是协议给的，是应用层用两条单向消息拼的：

1. 请求走上行 stdout → router 处理（如 spawn 新进程）→ 响应走下行 prompt 注入
2. 接收方 extension 的 `input` 钩子识别 `$bus` 信封，响应的用 `handled` 吞掉（agent 看不到），通知的用 `transform` 人话化进上下文

**防伪造**：吞帧（handled）有且仅有一个条件——`kind === "bus_response"` 且 `replyTo` 命中本进程 pending Map 里的 reqId。reqId 是 extension 发请求时用 `randomUUID()` 生成的，外部无法预知。所以伪造帧最坏的结果是被 transform 成一条丑消息，吞不掉任何东西。

### 3.4 防回声：注入帧不再外 fan

bus 投递进会话的消息（chat 转发、tap_event、session_done 等）永远不再外 fan。判定纯机械——autoFan 前查 `messageEnd` 的文本：

```typescript
// src/core/application/sessions/session-bus.ts:445
function looksLikeBusFrame(text: string): boolean {
  if (!text.startsWith("{")) return false;
  try {
    return (JSON.parse(text) as { $bus?: unknown }).$bus === true;
  } catch { return false; }
}
```

没有这条，A 收到房间消息 → 消息落进时间线 → 又被当 A 的发言 fan 回房间 → 无限回声。agent 看了房间消息后的**回复**不是注入帧，是 A 自己的新发言，正常 fan——回声断在"转发不再转"，对话不断。

## 4 路由器

路由器是 `SessionBus` 类，实现在 `src/core/application/sessions/session-bus.ts`。两个 Map（`channels`、`taps`）加路由逻辑，不 import Electron，不摸 adapter——纯用例编排。依赖倒置：它持有 `BusRendererSink` 接口（只有一个 `broadcast` 方法），bootstrap 用 `webContents.send` 实现后注入。

### 4.1 自动路由：说话即传输

三条进线中的"全会话事件流"（`sessionStore.onAnySessionEvent` → `sessionBus.onSessionEvent`）驱动着自动 fan 心跳。`onSessionEvent` 做三件事：

1. **tap 分发**：匹配目标键的 tap，按 filter 级别投递 event
2. **完成判定**：`agentSettled` 时调 `settleSession`（§4.3）
3. **自动 fan**：`messageEnd` 时调 `autoFan`

`autoFan` 的逻辑（`session-bus.ts:101`）：
- 取 messageEnd 的 assistant/user 消息文本
- 经 `looksLikeBusFrame` 判回声，是注入帧就跳过
- 查发送方（`sessionAddress(sessionKey)`）是所有 channel 的成员
- 对每个成员房间，打一条 `kind: "chat"` 帧（`from` = 发言会话，`to` = 房间地址，`payload = { text }`）
- 向房间其他成员 fan-out（除发言者自己）：session 成员经 `deliver`→`sendPromptTo` 注入 stdin，plugin 成员经 `sink.broadcast` 推送

agent 全程不知道总线的存在——它在房间里，说话，别人收到，和微信群的心智模型一字不差。

### 4.2 乒乓熔断

自动路由让"说话"变机械，也让"互抛"变机械了——两个 LLM 可以永远互抛。双保险，一软一硬：

**硬上限（路由器层）**：每个 channel 一个独立的令牌桶，容量 20，每分钟补满。一次 fan-out 花一个令牌；桶空则该房间的 fan-out 整批丢弃，并向房间发一条 `bus_throttled` 系统帧（同一冷却窗口只发一条）。预算按房间隔离，一个房间熔断不影响其他房间。

```typescript
// src/core/application/sessions/session-bus.ts:122-148
private tokenBuckets = new Map<string, { tokens: number; refillAt: number }>();
private static readonly FAN_BUCKET_CAPACITY = 20;
private static readonly FAN_BUCKET_WINDOW_MS = 60_000;
```

**软约定（内容层）**：bus-extension（设计中，未落地）在 transform chat 帧时，包装文本写明"有新内容才回复，不回复是合法选项"。把"可以闭嘴"写进消息本身。

### 4.3 完成通知：一次性交付完整输出

观察一个正在跑的任务，总线的交付方式是：等它全部执行完（`agentSettled`），把最终完整输出一整份送过去。不转中间的工具调用流，不给流式增量。

完成采集在 `settleSession`（`session-bus.ts:412`）执行：先经 adapter 发 `get_last_assistant_text` RPC 拿最后一条 assistant 文本（主源）；取不到（进程已退出）时回退读 session 文件尾部。采集的是**最终态完整文本**，不是增量拼接。

输出超过 8000 token 时截断（保留头部 1/4 与尾部 3/4，中段折叠，附文件路径）：

```typescript
// src/core/application/sessions/session-bus.ts:428-441
const limit = OUTPUT_TOKEN_LIMIT * CHARS_PER_TOKEN;  // 8000 * 4
if (text.length > limit) {
  const head = Math.floor(limit / 4);
  const tail = limit - head;
  text = `${text.slice(0, head)}\n\n…[${text.length - limit} chars elided]…\n\n${text.slice(-tail)}`;
  return { session, status, output: text, sessionPath };
}
```

截断保语义（头尾在、结论在），路径保完整（全文可达）。

### 4.4 房间与 tap

房间成员关系是**运行时状态，不持久化**。重启后 rejoin 由各成员自己负责。死会话清理由 `onProcessExit` 自动完成：移出全部房间、广播 `peer_left`、停相关 tap、清理 watchers。

tap 三级闸门（`src/core/domain/events/session-bus.ts:34`）：

- **`done`（默认）**——只给完成信号（`session_done`）
- **`lifecycle`**——加五个边界事件：`sessionStart`、`agentStart`、`agentEnd`、`agentSettled`、`messageEnd`
- **`stream`**——全量事件流。**仅 plugin 目标可用**；deliverTo 是 session 时路由器降级为 lifecycle 并发 `tap_degraded` 通知

闸门的目的是保护接收方 agent 的上下文——每一条转发进 agent 上下文的消息都是 token 成本。

## 5 插件面

插件经 `plugin.json` 声明 `sessions:bus` 权限后，通过 `window.pi.bus.*` 使用总线能力。全部 handler 在 `src/api/ipc/bus.ts`，每个 handler 开头调 `assertBusPermission` 检查权限，与 fs/git 的既有门控同一模式。

IPC 通道名契约定义在 `src/api/preload/ipc-channels.ts:15-23`：

```typescript
bus: {
  status: "bus:status",
  send: "bus:send",
  sessionCreate: "bus:sessionCreate",
  sessionAbort: "bus:sessionAbort",
  channelMember: "bus:channelMember",
  tapStart: "bus:tapStart",
  tapStop: "bus:tapStop",
  event: "bus:event",       // renderer 下行的广播通道
}
```

`event` 通道是下行广播——路由器推帧到 renderer 时经 `webContents.send("bus:event", message)`（`bootstrap/index.ts:144`），插件侧通过 `window.pi.bus.onMessage` 订阅。插件按 `to === plugin:<ownId>` 自行过滤。

7 个 op 与 bus-extension（pi 侧）的 7 个 tool 是同一组契约（status/send/sessionCreate/sessionAbort/channelMember/tapStart/tapStop），只是参数形态不同——extension 侧走 `{kind, payload}` 的 tool 调用，插件侧走 `window.pi.bus.send(to, kind, payload)`。契约单源，不存在插件面和 extension 面的两张皮协议。

## 6 Session Bus 与插件事件总线的分层

两个"事件总线"容易混淆，它们按进程边界分两层：

- **插件事件总线**（`packages/react/src/event-bus.ts`，`EventBusImpl`）：renderer 进程内部，插件↔插件消息，channel 由代码级 `export const channels` 声明，框架自动注册。消费者是 React 组件，不出 renderer。
- **Session Bus**（`src/core/application/sessions/session-bus.ts`，`SessionBus`）：main 进程，会话进程↔会话进程、会话↔插件消息。消费者是 pi 里的 agent 和 renderer 里的插件。

`plugin:<id>` 地址是两个世界的唯一桥点——投递到插件的消息经 `session:bus` IPC 跨过进程边界。它是《plugin-event-flow.md》所描述"main→renderer 桥接"的一种具体形态——桥的另一端直接连到 `window.pi.bus.onMessage`，不进 renderer 插件事件总线的 emit/on 分发。两条总线各司其职：renderer 管 UI 内的通知，main 管跨会话的消息。

## 7 编排消费者：subagent

subagent 是 Session Bus 的第一个租户。subagent 不是总线内置的东西——bus 只有地址和路由，没有"父子"概念。subagent 的父子关系、生命周期从属、资源闸、spawn 卡片等全是内容层的事，由 **sub-agent 桌面插件**（renderer，归属编排）+ **subagent-extension**（pi 侧，tool 注册与帧收发）串联既有基础设施实现。详见 `docs/design/subagent-scheduling.md`。

subagent 的通信链路是这样的：父 agent 调 `spawn_subagent` tool → extension 往 `plugin:sub-agent` 地址发 `spawn_subagent` 帧 → 帧走 `$bus` 上行到 main 路由器 → 路由器广播到 renderer → sub-agent 插件收到后调 `bus.sessionCreate` spawn 子进程 → 子完成时路由器检测 `agentSettled` → `session_done` 帧经 prompt 注入回父 agent → extension 的 input 钩子吞/transform。

整条链路不发明协议、不改 bus 一行——subagent 只是 bus 的一组私域 `kind` 约定和路由参数组合。

## 8 落地状态

### 8.1 已落地（代码中存在）

| 层 | 文件 | 状态 |
|---|---|---|
| 圆心中性契约 | `src/core/domain/events/session-bus.ts` (114行) | `SessionBusMessage`、`BusTap`、`TapFilter`、地址纯函数、`SessionDonePayload`、`BusApi` |
| 路由器 | `src/core/application/sessions/session-bus.ts` (471行) | 房间管理、tap闸门、自动fan、乒乓熔断令牌桶、完成判定与输出采集、desktop op 全部 7 个 |
| session-store 支撑 | `src/core/application/sessions/session-store.ts` | `onAnySessionEvent`、`onBusFrame`、`spawnSession`、`sendPromptTo`、`getLastAssistantTextFor` |
| 插件 IPC 面 | `src/api/ipc/bus.ts` (48行) | 7 个 `ipcMain.handle` + `sessions:bus` 权限门控 |
| preload 暴露 | `src/api/preload/preload.ts` | `window.pi.bus.*` 完整 API |
| IPC 通道名 | `src/api/preload/ipc-channels.ts` | `bus:*` 通道契约 |
| bootstrap 组装 | `src/bootstrap/index.ts:141-153` | SessionBus 实例化 + 三路进线注入 + MainContext 注入 |

### 8.2 设计中/未落地

- **bus-extension**（pi extension）：注册 5 个 bus tool 到 pi 的 tool 系统 + input 钩子（`$bus` 信封锁吞/transform）+ 启动时 ping 探测。源码未写入仓库，设计见 `docs/design/session-bus.md` §5。
- **sub-agent 插件 + subagent-extension**：bus 之上的第一个内容租户，设计见 `docs/design/subagent-scheduling.md`（2026-08-05 重写版）。
- **im-graph 可视化插件**：右面板"IM"页签的会话关系图（节点+边+事件流面板），低保真原型已随定稿清理，源码未创建。

## 9 与 renderer 插件事件总线的关系

两个总线不是一回事，没有谁替代谁的问题：

- **插件事件总线**（renderer 侧，`EventBusImpl`）管的是"timeline 知道新 entry 了没""sessions-list 知道子 agent 状态变了没"这类 UI 内通知——消费者是 React 组件，调用栈在 renderer 进程内。`emit` / `on` / `invoke` / `replayLast`。
- **Session Bus**（main 侧，`SessionBus`）管的是"会话 A 给会话 B 说了一句话""监督者盯工人的完成态"这类跨进程消息——消费者是 pi 进程里的 agent，调用栈从 main 到 renderer 到 pi。

`plugin:<id>` 是两个世界的桥点——一条 frame 从 main 路由到 renderer 后，插件自己的组件可以直接在 `onMessage` 回调里处理，也可以再做一层内部转发（比如发一条 `tap_event` 给 renderer 插件事件总线让其他插件订阅）。但这不是框架自动做的——Session Bus 把帧交到插件手里就完成了路由职责，插件怎么消化是内容层的事。

## 10 QA

**Q：为什么不用 renderer 的插件事件总线替代 Session Bus？**

物理上够不着。renderer 事件总线在 Chromium 进程里跑，pi 进程在 Node 进程里跑，message 必须跨进程。而且 renderer 事件总线是 fire-and-forget 的同步分发器——没有地址、没有路由、没有投递到 stdin 的管道。把 Session Bus 建在 renderer 侧等于让 Chromium 做路由器，main 进程里持有全部 pi stdin 管道的 session-store 反而成了旁观者。路由器的正确位置是离管道最近的那层。

**Q：两个会话能同时向同一个会话发消息吗？**

能。两条 prompt 命令走 RPC 协议的 id 配对各自独立响应，pi 的 prompt 队列按 streamingBehavior 排队。投递不做互斥——和两个人同时在微信群里发消息一样，接收方 agent 在它的推理循环里自然串行化。

**Q：房间为什么不持久化？**

持久化会引出"房间里有死会话"的清理问题——重启后哪些成员还活着要逐个核实，比重新 join 一遍贵得多。会话死亡时路由器自动清理（`onProcessExit`），desktop 退出时 `stopAll()` 全量停进程，房间随进程清零而清零，生命周期闭环，没有孤儿状态。

**Q：pi 没有装 bus-extension 的会话能收到消息吗？**

能。消息不会丢——prompt 注入不依赖接收方有任何扩展，裸 JSON 信封作为一条普通 user 输入落进 agent 上下文。agent 读 JSON 没问题，只是缺少人话化的 transform，体验降级但不丢数据。所以向一个裸会话投递是合法的降级用法，只是正式协作成员都该装上 bus-extension。
