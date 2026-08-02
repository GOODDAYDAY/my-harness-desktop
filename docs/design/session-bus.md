# Session Bus：多会话通信与自主编排设计

> 前置阅读：本文与 `subagent-scheduling.md` 同域——展示层设计（spawn 卡片、左侧栏分组、灰色输入框）在彼，本文只管通信底座与编排工具。文中"extension"指 pi 的 TypeScript 扩展（运行在 pi 进程内，经 `~/.pi/agent/extensions/` 加载），"plugin"指 pi-desktop 的桌面插件（运行在 renderer），两者是不同层的扩展机制，全文严格分用。

pi 核心只把单个会话管好——这是它刻意的边界，不是缺陷。pi-desktop 作为壳（下文"壳"均指 pi-desktop 的 main 进程侧：它 spawn 并持有全部 pi 子进程），手里同时跑着多个 pi 进程，天然是做多会话规划的那一层。但今天的壳只是把多个会话**平级并列**地管起来：每个进程独立、平等、互不可见。一个 agent 遇到复杂任务，不能说自己把哪块活外包出去，不能问另一个 agent 进展如何，不能拉几个同伴围炉议事。

本文设计的就是壳层补上的这块机制：**一套通用的会话间通信总线**（Session Bus）——给每个会话一个地址，给消息一个路由器，给 agent 一整套编排工具。subagent 是它的第一个租户，不是它的全部。

## 1. 职责分层：单 session 归内核，多 session 归壳

### 1.1 pi 的边界是对的

pi 的哲学写在它自己的 README 里：核心只给四个工具（`read`、`write`、`edit`、`bash`），没有 sub-agents，没有 MCP，没有 plan mode——每一个"不做"的答案都是"要就自己去扩展"。这不是功能缺口，是设计美德：核心小到可以被完全理解，工作流的选择权还给用户。

所以多会话能力**不该进 pi 核心**——给一个会话里的 agent 装上"和别的会话说话"的能力，这件事的正确落点不在那个会话内部，在看得见所有会话的那一层。pi 把单个会话做到极致，壳做多会话的规划，各归其位。

### 1.2 壳已经是调度器，只差"可寻址可路由"

pi-desktop 的 session-store 今天就是多进程调度器：它持有 `procs = Map<string, SessionProc>`，每个 SessionProc 绑一条 pi 子进程的 stdin/stdout，多个会话同时活着互不干扰。它看得见每一个进程、能 spawn 新的、能停掉旧的——多会话规划的物理基础全在。

缺的是逻辑层：这些进程彼此**不可寻址**。会话 A 没有办法指名会话 B 说一句话，因为它们之间没有地址、没有路由、没有消息的概念。总线补的就是这三个词：给会话地址，给消息信封，给壳一个路由器的角色。这是调度器职责的自然延伸——从"把进程管起来"到"让进程连起来"，不是给 pi 加功能。

### 1.3 通用抽象：地址 + 路由，场景全是租户

设计的通用抽象必须一次想对：不是"subagent 调度"，而是**会话间消息路由**。subagent 的父子协作、两个会话互相对话、N 个会话围一个聊天室、一个监督者盯着一群工人——这些看起来像几类功能，其实是同一个抽象的不同拓扑：都是"某地址向某地址投递消息"，拓扑是参数，不是并列概念。

所以本文不出现 subagent 专用管道。总线只提供地址、信封、路由原语；subagent 是第一个租户，它的全部需求（§7.4）都映射为总线原语的一种用法。谁是新租户由内容层决定，总线一行不改。

### 1.4 与现有机制的关系：扩展，不重构

总线挂在既有事件流的**旁边**，不动它一根手指。`dispatch()` 的四路分流（状态追踪、kernel 流、keyedListeners、view 流）保持原样；总线的进线从 keyedListeners 这个全量未过滤流引一条支路，出线复用每条 adapter 的 stdin。pi 核心一行不改，desktop 现有路由一行不改——所有新增都是新文件、新分支、新方法。

和 renderer 侧的插件事件总线（`ctx.events.emit/on`）也不是一回事，两者按进程边界分层、各司其职：

- **插件事件总线**管 renderer 进程内部的插件↔插件消息，消费者是 React 组件，不出 renderer。
- **Session Bus** 管 main 进程的会话进程↔会话进程、会话↔插件消息，消费者是 pi 进程里的 agent 和 renderer 里的插件。`plugin:<id>` 地址（§3.1）是两个世界的唯一桥点——投递到插件的消息经 `session:bus` IPC 跨过进程边界，进了 renderer 之后不转挂插件事件总线，各走各路。

## 2. 传输层：两条不对称的现存通道

总线的通信底座不能发明新协议——pi 的 RPC 协议是封闭的。`RpcCommand` 是 31 个字面量的封闭联合，没有 custom 类型；未知命令类型直接 parse error。这意味着设计文档们（如 subagent-scheduling §2）曾经设想的"desktop 往 pi stdin 写自定义 JSON"这条路**根本不存在**。

有人会问：pi 不是已经有一条 `extension_ui_request` / `extension_ui_response` 的请求-响应通道吗，为什么不复用它？三个理由把它排除了：它的 method 是封闭的 9 种 UI 交互（select/confirm/input/editor/notify/setStatus/setWidget/setTitle/set_editor_text），语义是"底座需要**用户**在界面上做选择"，不是"agent 请求 desktop 执行能力"；它的路由要经 renderer 转发等用户操作，而总线的信令是机器对机器、该在 main 进程内闭环；往它的封闭 method 联合里塞私货，是把信令伪装成 UI 请求，比没有通道更糟。所以总线不用它——但盘点 pi 的实际能力面后，两个方向各有一条现存通道，不对称，但够用。

### 2.1 下行 desktop→pi：prompt 命令 + streamingBehavior

下行唯一可用的官方通道是 **`prompt` RPC 命令带 `streamingBehavior: "steer" | "followUp"`**。消息以对轮输入形态注入会话，agent 天然会读、会回应，且自动持久化进 session 文件、自动出现在 timeline。

有一个实现要点必须钉死：**不能用 `steer` / `follow_up` RPC 命令投递**。这两条命令进 pi 后走 `session.steer()` 直插消息队列，绕过了 `emitInput`（extension 的 input 事件分发）；而 `prompt` 命令在 rpc-mode 里以 `session.prompt(message, { streamingBehavior, source: "rpc" })` 调用，`prompt()` 是所有输入必经 `emitInput` 的唯一入口。只有走后一条路，接收方 extension 的 `input` 钩子才有机会拦截消息——这是 §2.3 整条响应回路的前提。

`streamingBehavior` 取 steer 还是 followUp，是路由器的固定策略，发送方和接收方都不操心：**响应帧用 steer**（挂起的 tool 调用在等结果，即使接收方正在跑别的也要插队尽快 resolve）；**事件帧用 followUp**（chat、tap_event、session_done 这类通知排进队列，不打断接收方当前的 run）。两类帧的紧迫度天然不同，策略按帧型分派，不需要内容层声明优先级。

### 2.2 上行 pi→desktop：stdout custom 行

pi 的 extension 运行在 pi 进程内部，可以 `process.stdout.write` 写一行自定义 JSON——pi 的 loader 不拦 stdout。desktop 的 rpc-adapter 对未知 `type` 本来就兜底当 event 转发，只差在 `handleLine` 里加一个正式分支：识别 `{"$bus": true, ...}` 信封，转交给总线路由器，不再落进普通事件流。

上行还有一条备选：`pi.appendEntry(type, data)` 是官方 API，写 session 文件并触发 `entry_appended` 事件流回 desktop——自带持久化。需要落盘的消息（如协作的最终结论）走它，纯信令走 stdout custom 行。

### 2.3 响应回路：input 钩子的 handled/transform 分流

上行的单条消息是 fire-and-forget（发送即忘，协议层无应答），但 tool 调用要拿结果——agent 调 `session_create`，必须把新会话的地址作为 tool 返回值拿回来。请求-响应语义不是协议给的，是应用层用两条单向消息拼出来的：request 走上行 stdout，response 走下行 prompt 注入。在没有 stdin 反向通道的前提下，响应回路靠 extension 的 `input` 钩子拼装：

```mermaid
sequenceDiagram
    participant Ext as bus-extension (pi 进程内)
    participant Bus as desktop 路由器
    participant Agent as 接收方 agent

    Ext->>Bus: stdout: {"$bus":true,"id":"req-1","to":"desktop","kind":"session_create","payload":{...}}
    Note over Ext: 挂起 Promise,登记 pending: Map&lt;reqId, resolve&gt;
    Bus->>Bus: 处理(spawn 新 pi 进程)
    Bus->>Ext: stdin: prompt 命令(streamingBehavior,source:"rpc")<br/>message={"$bus":true,"to":"session:req方","kind":"bus_response","replyTo":"req-1","payload":{...}}
    Note over Ext: input 钩子识别 $bus 信封:<br/>响应帧 → return "handled"<br/>(agent 看不到,不入上下文)
    Ext->>Ext: pending 取出 resolve,tool 返回结果
    Note over Agent: 看到一次普通的 tool 调用/返回对
```

钩子的两种返回值把消息分成两路：

- **`handled`**——帧被整个吞掉，不进 agent 上下文、不落 session 文件。响应帧（`replyTo` 配对 pending 里的挂起 Promise）走这条路：agent 只看到 tool 调用正常返回，对传输细节一无所知。这同时意味着**隐藏控制帧今天就有**——不需要等上游支持。

- **`transform`**——帧被改写成可读文本后进 agent 上下文。通知帧（chat 消息、tap 事件、session_done）走这条路：extension 把 JSON 信封展开成"【来自 session:w1 的消息】……"这样的人话，agent 收到的是自然语言，可以读可以回。

**信封识别规则与防伪造**（钩子的判定逻辑，按序执行）：

1. 对输入文本尝试 `JSON.parse`，顶层 `$bus === true` 才认作总线信封；辅助信号是 `source`——input 钩子的回调能拿到本次输入的来源（desktop 注入是 `"rpc"`，人类在 TUI 里敲字是 `"interactive"`），来源不符直接放行当普通输入。
2. **吞帧（handled）有且仅有一个条件**：`kind === "bus_response"` 且 `replyTo` 命中本进程 pending Map 里一个活着的 reqId。reqId 是 extension 发请求时用 `randomUUID()` 生成的 id，外部无法预知——所以伪造帧最坏的结果是被 transform 成一条丑消息，**永远吞不掉任何东西**。
3. 不匹配上述两条的 `$bus` 帧（比如人类手敲了一段 `$bus` JSON）按普通输入透传给 agent，不吞不改写。防伪造的全部要点就是一句话：吞帧权只授给"自己发出的请求的应答"，其余帧最差只是难看。

注意信封从头到尾只有一个形状：上行请求、下行响应、事件通知全是 §3.2 的 `SessionBusMessage`（`kind` 鉴别用途，`replyTo` 配对请求），不存在"传输层一套字段、应用层一套字段"的两张皮——路由器和 extension 处理的都是同一个类型。

同步 tool 语义由此恢复，且不依赖任何上游 pi 改动。整条回路的代价只有一个约束：响应必须经 prompt 命令投递（§2.1 的实现要点），不能图省事走 steer 命令。

### 2.4 演进路径：上游 custom 协议是纯优化

如果将来给 pi 提上游改动（`RpcCommand` 加 custom 类型、extension 加 stdin 分发 hook、官方 `pi.emit` stdout API），传输层可以升级：控制帧改走 stdin 直投不再借 prompt 通道，上行 custom 行换成官方 API。但地址、信封、四原语、tool 面**一个字段不动**——那是传输升级，不是协议变迁。本文的其余部分不依赖这个演进，它发生与否只影响 §2 的实现细节。

## 3. 总线模型：地址、信封、四原语

### 3.1 地址：类型开放，路由表可扩

地址的**类型是开放字符串**——这样将来新增地址形态不需要改信封的类型定义；路由器的**路由表当前覆盖四个前缀**，收到未知前缀的地址回发送方一个 undeliverable 错误，不静默丢弃。两层别混淆："四种形态"是当前路由表的内容，不是架构不变量。四种形态按前缀分派投递方式，路由器不为任何具体地址写分支：

- **`session:<key>`**——一个活着的 pi 进程（session-store procs Map 的 key）。投递 = prompt 命令注入其 stdin。
- **`channel:<name>`**——命名房间的全部成员。投递 = 逐个成员 fan-out。
- **`plugin:<id>`**——一个 renderer 插件。投递 = `session:bus` IPC 广播。
- **`desktop`**——路由器内部 handler。投递 = 进程内直调（如 spawn 请求的处理）。

地址是数据不是类型戳。新增一种地址形态（比如将来的 `group:<project>`）只需要路由器多一个前缀分支，信封和 tool 面不感知。

### 3.2 信封与 from 传输认证

消息信封是圆心的中性类型，零依赖：

```typescript
interface SessionBusMessage {
  $bus: true;            // 协议标记,识别锚点(§2.3 判定第一步);恒为 true
  id: string;            // randomUUID,追踪与接收方去重(同一 id 重复到达只处理一次)
  from: string;          // 发送方地址——传输层认证,不自报
  to: string;            // §3.1 任一地址形态
  kind: string;          // 开放字符串,总线自产=控制帧 bus_response + 事件帧七种(§5.16),内容层可自定义
  payload: unknown;      // 各 kind 的内容层自定义
  timestamp: number;
  replyTo?: string;      // 请求-响应配对(可选)
}
```

安全模型只有一条硬约束：**from 由传输层认证，不由发送方自报**。执行点在路由器的上行入口：pi 侧帧到达时，路由器用"它从哪条 adapter 来"绑定的 sessionKey **覆写** from 字段——帧里自报的 from 值直接丢弃，伪造就此失效；插件侧的 from = `plugin:<id>`（PluginIdContext 框架注入，同样不采信自报）。除此之外没有任何角色校验——谁都能向谁说话、谁都能替别人牵线（§5.1），但每个动作可溯源。开放，但不匿名。

### 3.3 四原语：send / publish / join-leave / tap

总线的动词只有四个，全部拓扑都是它们的组合：

- **send(to, kind, payload)**——单播。两个会话互相对话 = 互相 send。
- **publish(channel, kind, payload)**——向房间全体成员 fan-out（除发送者）。聊天室、集群协作、广播全是它——广播不单独造概念，它就是"全员房间的 publish"。
- **join / leave(channel, member?)**——房间成员管理。member 缺省是自己，显式声明可以是别人（§5.1 的替人拉房）。
- **tap(target, filter?, deliverTo?)**——只读观察一个会话或一个房间的事件流。监听者不进入被监听者的输入流，只拿副本；deliverTo 缺省是自己，可以是第三方地址（§5.1 的牵线搭桥）。

### 3.4 房间：运行时成员，死会话自动清理

房间成员关系是**运行时状态，不持久化**。理由：持久化会引出"房间里有死会话"的清理问题——重启后哪些成员还活着要逐个核实，比重新 join 一遍贵得多。重启后 rejoin 由各成员自己负责（插件重新声明、extension 重新加入）。

死会话的清理由路由器自动完成：session-store 的 `processExit` 内核事件已经存在，路由器订阅它——会话死亡时，把它移出所有房间（并向房间广播 `peer_left`）、停掉以它为源的 tap、停掉以它为 deliverTo 的 tap。desktop 自身退出时走既有的 `before-quit → stopAll()` 把全部 pi 进程停掉，所以不存在"desktop 重启后还有无主活会话"的场景——重启即全量清零，运行时状态（房间、tap、pending）随进程消失，与成员不持久化的语义自洽。成员不持久化加上死亡自动清理，房间的生命周期闭环，没有孤儿状态。

### 3.5 tap 与流量闸门

tap 的订阅分级，默认只给最稀疏的一档：

- **`done`（默认）**——只给完成信号（§4 的 session_done）。这是"盯一个任务到结束"的标准用法。
- **`lifecycle`**——加给边界事件：会话与 run 的起止和消息的完成态，即 `sessionStart`、`agentStart`、`agentEnd`、`agentSettled`、`messageEnd` 这五个，不给任何增量。这五个是**起止标记不是执行细节**——它们回答"开始了没有、结束了没有"，不回答"正在干什么"，所以即便进入 agent 上下文也符合 §4 的模型："只吃完成态"吃的是不含执行细节的边界信号，§4 要挡的是 stream 级别的增量，不是这五帧。
- **`stream`**——全量事件流 = lifecycle 五个边界事件 + 全部增量（`messageStart`、`messageUpdate`、`toolCallStart/Update/End`、`turnStart/End` 等）。**正当消费者是 plugin 地址**（监控面板：消费者是人，没有上下文成本）；deliverTo 是 session 时路由器把 stream 降级为 lifecycle，并回给订阅方一条 `kind: "tap_degraded"` 的系统事件帧说明降级原因——agent 上下文是稀缺资源，stream 灌进 agent 等于让接收方为发送方的执行细节付 token 账，这是 §4 论证要防的事，路由器替粗心的编排方兜底。

闸门的适用域：三级过滤对 plugin 目标全部原样放行（消费者是人，无上下文成本）；降级只发生在 deliverTo 是 session 时（stream→lifecycle）。channel 目标的 tap 不吃这套闸门——房间流量只有 publish 帧和 `peer_joined`/`peer_left` 帧，天然稀疏，filter 参数对 channel 目标无效，订阅即得全部房间流量；房间没有"完成"概念，不产生 session_done。

闸门的目的不是省带宽，是**保护接收方 agent 的上下文**：每一条转发进 agent 上下文的消息都是 token 成本，N 个被观察方的流式增量就是 N 倍上下文膨胀。默认 done，需要再加，是通信层的节俭纪律（§4 展开）。

## 4. 完成通知模型：一次性交付完整输出

观察一个正在跑的任务，总线的交付方式是：**等它全部执行完，把最终的完整输出一整份送过去**。不转中间的工具调用流，不给流式增量，没有"跑到 60% 了"这种中间态。

这个模型管的是**deliverTo 为 session 地址的观察**——agent 看 agent。deliverTo 为 plugin 地址的观察（监控面板，消费者是人）不受此限，§3.5 的 lifecycle/stream 级别就是为它留的；但路由器会把 session 目标的 stream 请求降级（§3.5），agent 上下文永远只吃完成态。

### 4.1 为什么不转中间流

中间流对观察者是三种浪费，一种错觉。

浪费在三个地方：工具流是**执行细节**不是进度——接收方 agent 拿到另一个 agent 的 `read_file` / `bash` 调用记录，没有行动价值；流式增量是**上下文传染**——发送方每吐一个 token，接收方的上下文就长一截，几个被观察方同时跑就是几倍膨胀；中间态是**重复决策源**——接收方看到半成品输出，除了提前焦虑什么决定都做不了，因为结果还没定。

错觉是"实时进度有用"。进度的本质是二元信号：**完了没有，结果是什么**。中间过程想不想看是人的需求，不是 agent 的需求——人要看，打开那个会话的 timeline 看完整消息流，那是展示层的事（spawn 卡片点进去就是完整会话视图），不该让通信层把执行细节灌进另一个 agent 的上下文。一次性交付恰好只回答那两个本质问题：session_done 事件=完了，完整 payload=结果是什么。一个字节不多。

### 4.2 完成判定与输出采集

完成的权威信号是 **`agentSettled`**——pi 的扩展事件里语义最干净的一个："没有更多 auto retry / compaction / continuation"，即这轮工作真正落定。`agentEnd` 是单次 run 的结束，后面可能还跟着自动重试；`processExit` 作为兜底（进程非正常退出也算一种"完"，status 标记为 error）。settled 永不触发的情形（进程挂死、模型侧死循环）由 watch/tap 的可选超时参数兜底——**默认无超时**：完成通知模型语义上不设 deadline（任务爱跑多久跑多久，结果是唯一关注点），超时是编排方显式声明的自治策略；超时后路由器停掉该会话并照常交付 `session_done`（status: timeout），编排方收到的信号形状不变，只是状态不同。

输出采集在 settled 时刻由 desktop 执行：经该会话的 adapter 发 `get_last_assistant_text` RPC（pi 协议既有命令，session-store 的同名 IPC 已在用）拿最后一条 assistant 文本——这是完整输出的主源；取不到（进程已退出）时回退读 session 文件尾部的最后一条 assistant 消息（会话地址即 procs Map 的 key，SessionProc 持有的 sessionPath 给出文件路径）。采集的是**最终态的完整文本**，不是增量的拼接——中间改过什么、重试过几次，全部折进最终结果里，不单独呈现。

### 4.3 一次性送达

```mermaid
sequenceDiagram
    participant A as 编排方 agent
    participant Bus as desktop 路由器
    participant W as 工人会话 (pi)

    A->>Bus: session_create({task, watch:true})
    Bus->>W: spawn + prompt(task)
    Bus-->>A: bus_response: {session: "session:w1"} (同步返回地址)
    Note over Bus,W: W 独立执行,A 不等不看不收中间流
    W-->>Bus: (事件流经 keyedListeners,仅观察 agentSettled)
    Bus->>Bus: settled → get_last_assistant_text 采集完整输出
    Bus->>A: session_done 帧: {session:"session:w1", status:"done", output:<完整输出>}
    Note over A: 一条消息拿全量结果,继续推理
```

`session_done` 帧的 payload 三块：会话地址、完成状态（done / error / aborted / timeout）、完整输出文本。编排方 agent 收到后自己决定怎么用——汇总、继续派活、向用户汇报，都是它的推理决策，总线不预设。

完整输出默认全量交付，只有一条例外：输出过长时路由器截断——按字符数估算 token（4 字符≈1 token），超过 8000 token 时保留头部 1/4（任务上下文）与尾部 3/4（结论密集区），中段以省略标记折叠，并附上会话文件的绝对路径——接收方真要全文，自己用 `read` 工具按路径取。截断保语义（头尾在，结论在），路径保完整（全文可达），两者缺一才会真的丢信息。

## 5. Orchestration Tools：调度权全面开放

### 5.1 原则：谁都可以

tools 由 **bus-extension** 提供——一个 pi extension，源码随壳分发（`packages/bus-extension/index.ts`），照 tool-gate 先例由 installer 在 app 启动时同步到 `~/.pi/agent/extensions/bus-extension/`。它每个 pi 进程加载一次、每进程一个实例，职责四件：经 pi 的 `registerTool` 把本节全部 tool 注册进 tool 系统（agent 看到的 `session_create`、`bus_send` 和 `bash`、`read` 是普通同事关系，推理时自然可调用）；挂上 `input` 事件钩子做信封识别（§2.3）；持有 pending Map 配对请求-响应；启动时 ping 探测 desktop 决定注册与否（§8 Q3）。

返回与拒绝的两个惯例：所有 tool 的同步返回都是小 JSON 对象（字段即各节所述——地址、tapId、清单项），不返回大 payload；plugin 侧调总线走 manifest 声明权限（`sessions:bus`），未声明而调，IPC 边界直接抛错（沿用 fs/git 既有门控的拒绝形态）。

总线不设特权方。任何会话可以调任何 tool，没有"父 agent""房主""管理员"的角色字段——拓扑是数据，不是权限。三种"谁都可以"各自有明确的参数形态：

- **谁都可以为自己申请**——所有 tool 的 target 参数缺省都是自己。
- **谁都可以替别人申请**——`channel_join({channel, member: "session:B"})`：A 把 B 拉进房间；`session_create` 后把新地址 `bus_send` 给任何会话。
- **谁都可以替别人牵线搭桥**——`tap_start({session: "session:W", deliverTo: "session:S"})`：A 让监督者 S 监听工人 W，A 自己不在回路里。

配合 from 传输认证（§3.2），开放但不匿名：每个动作都知道是谁发起的。plugin 侧调总线走 manifest 声明权限（`sessions:bus`），IPC 边界检查，沿用 fs/git 的既有门控；pi 侧不需要权限概念——传输认证已经限定了它只能以自己的身份发言。

每个 tool 的返回都走 §2.3 的响应回路同步返回给 agent；产生的后续事件以异步事件帧回流（§5.15）。以下逐 tool 展开。

### 5.2 bus_whoami

返回调用方自己的总线身份：session 地址、当前加入的房间清单、活跃的 tap（自己建的和别人建给自己的）。

编排的元信息基础——agent 规划前需要先知道"我是谁、我已经在哪些回路里"，避免重复 join 或重复 tap。

### 5.3 bus_sessions

列出当前运行中的全部会话：地址、会话名、cwd、忙碌状态（busy = 该会话 pi 进程的 isStreaming 标志，即当前有 run 在进行）。可选 `filter` 按 cwd 或名称前缀收窄。

编排方"看看现在场上都有谁"的发现入口。返回的是地址清单，后续所有 tool 都以地址引用这些会话。

### 5.4 session_create

```
session_create({ task?, cwd?, name?, model?, toolConfig?, watch? })
```

spawn 一个新的 pi 会话进程。`task` 作为首条 prompt 直接注入——新会话落地即开工，不需要再单独 send 一次。`cwd` 缺省继承调用方的 cwd；`model` / `toolConfig` 缺省继承调用方会话的配置，显式声明则覆盖（toolConfig 经头行写入 + tool-gate 硬过滤执行，复用 tool-manager 已验证的回路）。

`watch: true` 是编排的标准姿势：总线自动对该会话挂一个 done 级 tap，会话完成时向调用方交付 §4 的 `session_done`（含完整输出）。不设 watch 的会话是"放出去的野会话"，完成时不通知任何人——适合"起个会话给用户自己玩"的场景。

同步返回新会话的地址。`session_done` 事件异步回流。

### 5.5 session_abort

```
session_abort({ session })
```

停掉一个会话进程，走既有的 stdin→SIGTERM→SIGKILL 停止策略。可以停自己（自杀），也可以停别人（他杀）——谁都可以，from 记录在总线日志。

停止后触发 §3.4 的死亡清理：移出所有房间、停掉相关 tap、房间广播 `peer_left`。如果有人在 watch 它，watch 者收到 `session_done`（status: aborted）。

### 5.6 bus_send

```
bus_send({ to, kind?, payload })
```

单播一条消息。`to` 是 §3.1 任一地址形态——session、channel（等价于 publish）、plugin、desktop。`kind` 缺省 `"chat"`，内容层自定义（"task"、"result"、"review_request"……），总线不枚举。

到达接收方会话时，extension 的 input 钩子把信封 transform 成可读文本注入——接收方 agent 读到一条说明来源的消息，可以读可以回（回的机制也是 bus_send，from 自动带上）。

### 5.7 bus_publish

```
bus_publish({ channel, kind?, payload })
```

向房间全体成员 fan-out，除发送者自己。发送者不需要在房间里也能 publish（对外广播），但通常成员才有发言权——这是内容层的礼貌约定，总线不强制。

聊天室、集群协作、广播统一是这一个动词，不单独造"广播"概念。

### 5.8 bus_reply

```
bus_reply({ replyTo, payload })
```

响应便捷形。`replyTo` 填收到的消息 id，总线把 `to` 自动解析为原消息的发送方、把 replyTo 写进信封供对方配对。等价于 `bus_send({to: <原发送方>, replyTo, payload})`，单独存在是因为请求-响应是高频模式，值得一个一等动词。

### 5.9 channel_join

```
channel_join({ channel, member? })
```

加入房间。`member` 缺省是自己，显式声明可以是任何会话地址——替别人拉房（§5.1）。房间不存在即创建，无需显式建房间动作：房间是成员的涌现，不是需要管理的实体。

加入后开始收到房间的 publish 帧；同时房间现有成员收到 `peer_joined` 通知。

### 5.10 channel_leave

```
channel_leave({ channel, member? })
```

退出房间，`member` 同样可代别人退出。退出后不再收该房间的 publish；其余成员收到 `peer_left`。最后一个成员离开时房间自然消散——没有空房间需要清理。

### 5.11 channel_members

```
channel_members({ channel })
```

返回房间的当前成员地址清单。编排方确认"房里现在都有谁"的查询。

### 5.12 channel_list

返回当前全部活跃房间及各自成员数。发现既有协作空间的入口——agent 可以用它发现"已经有一个 review 房了，我 join 就行，不用另起炉灶"。

### 5.13 tap_start

```
tap_start({ session? | channel?, filter?, deliverTo? })
```

开始只读观察。target 二选一：`session` 盯一个会话的事件（`filter` 三级闸门，§3.5）；`channel` 盯一个房间的消息流（publish + 成员进出帧，天然稀疏，`filter` 不适用，§3.5 末段）。`deliverTo` 缺省是自己，可填第三方地址——替别人牵线（§5.1）。

同步返回 `tapId`。此后事件按闸门级别以 `tap_event` 帧回流到 deliverTo；被观察方完成时无论哪级闸门都补发 `session_done`。

### 5.14 tap_stop

```
tap_stop({ tapId })
```

取消一个进行中的 tap。事件流停止回流；被观察方不受任何影响（tap 是只读的）。

### 5.15 tap_list

返回调用方相关的 tap 清单：自己建的、别人建给自己的，各自的目标、闸门、deliverTo。编排方盘点"我现在都在听谁"的查询。

### 5.16 异步事件帧与展示分流

agent 经总线收到的异步消息统一是这个形状：

```json
{"$bus": true, "kind": "chat|task|result|tap_event|session_done|peer_joined|peer_left",
 "from": "session:w1", "to": "channel:review", "payload": {...}, "id": "msg-42", "timestamp": 1754131200}
```

`to` 保留逻辑目的地：经房间 fan-out 的消息，接收方看到的 `to` 是 `channel:<房名>`——一眼知道"这条从哪个房间来"；直发的消息 `to` 就是接收方自己。

extension 的 input 钩子对事件帧做 transform：展开 JSON 为可读文本（来源、房间、正文分行呈现）再进 agent 上下文。人这一侧如果想看得更漂亮，渲染层可以再拆 JSON 字段做卡片化展示——那是展示层的自由，通信层只保证 JSON 信封的完整和一致。

**接收方没有装 bus-extension 时会怎样**：消息不会丢——prompt 注入不依赖接收方有任何扩展，裸 JSON 信封作为一条普通用户输入落进 agent 上下文。agent 读 JSON 没有问题，只是没有人话化的 transform，体验降级但功能完整。所以 deliverTo 一个"裸会话"是合法用法（比如临时起个没装扩展的会话当苦力），只是正式协作成员都该装上 bus-extension。

上例 kind 字段列出的七个是总线自产的**事件帧**；另有控制帧 `bus_response`（§2.3）专走 handled 通道不进事件流。kind 是开放字符串，内容层（插件、其他 extension）可以发明自己的 kind，总线原样路由不解释。

## 6. desktop 侧挂点

### 6.1 三个附着点，不动现有路由

总线在 desktop main 进程的接入是三个新增点，全部在既有结构旁边，不修改 `dispatch()` 的既有分流：

```mermaid
flowchart LR
    subgraph 上行入口
        A1["rpc-adapter handleLine<br/>加 $bus 分支"] --> R
        A2["keyedListeners 支路<br/>(全量全会话事件)"] --> R
        A3["bus.* IPC<br/>(插件调用)"] --> R
    end
    R["session-bus.ts<br/>路由器:channels/taps 两个 Map + route()"]
    subgraph 下行出口
        R --> B1["getAdapter(key) + prompt 命令<br/>注入会话 stdin"]
        R --> B2["session:bus IPC 广播<br/>(bootstrap 第五条 wire)"]
    end
```

- **入口一**：rpc-adapter 的 `handleLine` 加 `$bus` 信封分支，extension 的上行请求转给路由器（§2.2）。
- **入口二**：session-store 的 keyedListeners——全量、全会话、未过滤的事件流（粒度 = pi 底座经 rpc-adapter 转发的全部 SessionEvent，含流式增量，逐事件带 sessionKey；现在只有 restart-coordinator 和 model-test 两个消费者）。总线引一条支路喂 tap 分发和完成判定（§4.2）。暴露方式是 session-store 加一个 `onAnySessionEvent((event: SessionEvent, sessionKey: string) => void)` 公开方法。
- **入口三**：`bus.*` IPC——插件调 send/publish/join/tap 的通道，走 manifest 声明权限门控。
- **出口一**：session-store 加 `getAdapter(key)` 公开方法，路由器拿到目标会话的 adapter 后发 prompt 命令注入（§2.1）。
- **出口二**：bootstrap 加第五条 `webContents.send("session:bus", ...)` wire，与既有四条推送 wire 并列，插件经 preload 的 `bus.onMessage` 订阅。

### 6.2 路由器与 DeliveryPort

`core/application/sessions/session-bus.ts` 是纯用例编排：两个 Map（channels、taps）加 route()，不 import Electron、不摸 adapter。它持有 `DeliveryPort` 接口——`sendToSession(key: string, message: SessionBusMessage): void` 与 `broadcastRenderer(message: SessionBusMessage): void` 两个方法，接口定义在 application 层、实现在 bootstrap 接线（依赖倒置：换运行时只换 port 实现，router 一行不改）。

### 6.3 死会话清理

路由器订阅 session-store 的 `processExit`（内核事件流已有）：会话死亡 → 移出全部房间 + 房间广播 `peer_left` → 停以它为源的 tap + 通知 deliverTo → 停以它为 deliverTo 的 tap + 通知 tap 主。配合房间成员不持久化（§3.4），生命周期闭环，无孤儿状态。

## 7. 场景回放

### 7.1 并行 fan-out：重构 + 补测试

用户说"把 auth 模块重构了并补齐测试"，agent 自主编排：

1. `session_create({task: "拆 auth.ts", watch: true})` → 得 `session:w1`
2. `session_create({task: "写测试", watch: true})` → 得 `session:w2`
3. `channel_join({channel: "auth-squad", member: "session:w1"})` + join w2——两个工人互通：w1 改了接口签名，w2 立刻知道
4. 自己不看不等，继续陪用户聊；两个 `session_done` 帧先后到达，各带完整输出
5. 汇总两边结果，向用户汇报；会话文件留在盘上，用户点 spawn 卡片看完整过程

拓扑（并行还是串行、要不要聊天室、几个工人）全是 agent 的推理决策——总线给能力，AI 给拓扑。

### 7.2 监督者：替别人牵线

复杂重构，agent 想要一个"审查员"盯着"工人"但不亲自下场：

1. `session_create({task: "重构 storage 层", watch: true})` → 工人 `session:w`
2. `session_create({task: "待命,审查 supervision 转给你的进展", name: "reviewer"})` → 监督者 `session:s`
3. `tap_start({session: "session:w", filter: "done", deliverTo: "session:s"})`——A 牵线，s 听 w，A 不在回路里
4. w 完成时，s 收到完整输出并开始审查；审查结论经 `bus_send` 回到 A

### 7.3 聊天室：人也在房间里

三个 agent 加一个真人在同一个 `channel:war-room`：agent 们 publish 进展和分歧，用户在 desktop 上（插件 join 同一房间）围观全部消息，随时可以插话——人的发言经 `bus_publish` 进房间，agent 们收到和人发言同构的消息帧。prompt 注入形态让"人和 agent 同房对话"不需要任何特殊机制。

### 7.4 subagent 退化为纯用法

subagent-scheduling.md 里的三条专用消息，全部映射为总线原语，无一需要专用管道：

- `desktop_request/spawn_subagent` → `session_create({task, toolConfig, watch: true})`
- `desktop_event/subagent_progress` → 取消（§4：不转中间流）；人在要看进度就打开子会话 timeline
- `desktop_event/subagent_done` → `session_done` 帧（含完整输出）

展示层的设计原样保留：spawn 卡片（custom_message + messageRenderers 槽）、头行 `custom.parent_id`（HeaderPatch 缺口）、左侧栏缩进分组、灰色输入框。原设计的框架缺口审查（§7）依然有效；变的只是通信底座从"custom 信封专用协议"换成了"总线的第一个租户"。

## 8. QA

**Q1：响应帧会被 input 钩子 handled 吞掉，那给它配 streamingBehavior 还有意义吗？**

有，是兜底不是主路径。`prompt()` 在接收方正忙（isStreaming）时，不带 streamingBehavior 会直接抛错——所以响应帧必须带，否则忙时投递失败。带 steer 的深层理由是降级路径：万一信封识别失败（比如接收方是没装 bus-extension 的裸会话），帧不会被吞，而是按 steering 队列尽快进入 agent 视野——识别失败时的 steer 比 followUp 更快被看到。主路径（识别成功）里帧在 emitInput 阶段就被吞掉，根本到不了队列选择，steer 和 followUp 此时无差别。

**Q2：replyTo 引用的消息在 desktop 重启后还有效吗？**

无效，这是显式的运行时边界。消息 id、pending Map、房间成员、tap 清单全部是会话级运行时状态，重启即清空——和房间成员不持久化（§3.4）是同一条纪律。重启后对一个旧 id 发 bus_reply，路由器按未知地址回 undeliverable 错误给发送方，不静默丢弃。跨重启的引用需求应该落 session 文件（appendEntry），不该依赖总线内存。

**Q3：用户不经 desktop、直接命令行跑 pi 时，bus tools 会怎样？**

优雅退化。bus-extension 加载时先发一个 ping 上行帧探测 desktop 的总线路由器：有应答则注册全部 tools；超时无应答说明跑在裸 pi 里，extension 一个不注册——agent 的 tool 清单里根本看不到这些 tool，不会尝试调用。不存在"调了但失败"的路径，和 spawn_subagent 设计里"没 desktop 就静默退化"是同一手法。

**Q4：开放模型下一个会话被垃圾消息轰炸怎么办？**

三道防线，按从轻到重排：from 传输认证让轰炸者无法匿名（§3.2），被炸方的 agent 自己可以选择不回、可以 `channel_leave` 退出房间；编排方或用户可以 `session_abort` 直接杀掉轰炸源——他杀是合法操作（§5.5）。已知边界：总线没有频率限制和配额，这是刻意的——限流策略是内容层的治理决策，不是通信层的职责；真出现失控会话，处置权在用户手里。

**Q5：两个不相干的编排方用了同一个房间名，会互相听见吗？**

会，而且这是特性不是 bug。房间名是开放字符串，同名即同房——它是"广场"不是"包间"。`channel_list`（§5.12）就是发现机制：agent 起名前先看一眼既有房间，想进就 join，想隔离就起个带前缀的私有名（如 `auth-squad-x7f`）。命名冲突的化解靠约定（项目名 + 随机后缀），不靠总线的命名空间隔离。

**Q6：A 监听 B、B 又监听 A，消息互灌会不会死循环？**

总线层不做环检测——环是拓扑数据，不是协议错误，和内容驱动原则一致。实际风险有限：tap 默认只给 done 级事件（§3.5），完成信号是终止态不是新话题，互灌止于各自完成；真正的循环要 agent 在收到事件后主动发新消息触发对方新 run，那是 agent 行为层的决策问题，和"两个人类同事互相秒回邮件"同性质——解法是编排方规划拓扑时避免互指，不是路由器当交警。已知边界：极端失控时用户 session_abort 任一环节即断链。

**Q7：plugin 地址的消息，插件正好没挂载（tab 未打开）时会丢吗？**

会丢，语义和渲染层事件总线一致：`session:bus` 是广播不是队列，没有订阅者即弃。需要可靠送达的场景不该用 plugin 地址，应该用 session 地址（prompt 注入会持久化进 session 文件，天然可靠）；plugin 地址的定位就是"在线面板的实时推送"，不在线就不推。
