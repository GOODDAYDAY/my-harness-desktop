# 子agent 进程调度设计

当前 pi-desktop 管的 pi 进程是"一个会话一个进程"——每个进程独立、平等，但彼此隔离。一个 agent 遇到复杂任务时，它只能自己硬扛：串行执行、上下文膨胀、一个工具卡住整个会话阻塞。它没有能力说"这块活我外包出去，让别人帮我干，干完了把结果给我"。

这件事的本质不是"给 agent 加个子agent 功能"，而是换一个进程模型：子agent 应该是独立进程——有自己的 session 文件、自己的 tool 配置、自己的崩溃边界。有了 desktop 之后，desktop 天然就是那个能看见所有进程、能 spawn 新进程、能在进程间路由消息的角色。所以 desktop 来做调度器，完成 agent 和子agent 的协作。

但这要求两件事：agent 得能主动调用 desktop 的能力（"帮我起个子agent"），还得有通信能力（子agent 的进度和结果得能传回来）。这两条路现在都不存在——pi 和 desktop 之间的 JSONL 通道只有 desktop→pi 的命令和 pi→desktop 的事件，没有 pi 主动向 desktop 请求能力再拿到响应的回路。本文设计的就是这条回路，以及建立在这条回路上的子agent 进程调度、会话展示和落地路径。

## 1. 问题：agent 怎么把活外包出去

### 1.1 现状：多进程调度器已经在了，但只管平级会话

pi-desktop 的 `session-store.ts` 已经是一个多进程调度器。它持有 `procs = Map<string, SessionProc>`，每个 `SessionProc` 包含一个 `RpcAdapter`（绑着一条 pi 子进程的 stdin/stdout）、一个 `cwd`、一个 `sessionPath`。多个会话可以同时活着——用户在会话 A 发消息不会杀掉会话 B 的 pi 进程。

但这个调度器管的是**平级会话**。会话 A 和会话 B 之间没有关系——A 不知道 B 存在，B 不关心 A 在干什么。它们共享的只有"都在同一个 cwd 桶里"这件事。没有人能说"B 是 A 的子任务，B 的结果要传回给 A"。

通信层面，pi 和 desktop 之间的 JSONL 通道有四条消息流：

- **desktop → pi（stdin）**：命令（`prompt`、`abort`、`fork` 等），pi 收到后执行并回 response
- **pi → desktop（stdout）**：response，配对 command 的 id
- **pi → desktop（stdout）**：事件（`agent_start`、`message_start`、`tool_execution_start` 等），fire-and-forget，无 response
- **pi → desktop（stdout）**：`extension_ui_request`，有 response（desktop 经 stdin 回 `extension_ui_response`）

这四条里，**唯一能让 pi 主动向 desktop 请求并拿到响应的是 `extension_ui_request`**。但它是为 UI 交互设计的——method 固定 9 种（`select` / `confirm` / `input` / `editor` / `notify` / `setStatus` / `setWidget` / `setTitle` / `set_editor_text`），而且语义是"底座需要用户在 UI 上做选择"，不是"agent 请求 desktop 执行一个能力"。

所以缺口很具体：**没有一条"pi 主动向 desktop 请求能力执行、desktop 处理后回响应"的通用通道。**

### 1.2 为什么子agent 是独立进程而非进程内线程

把子agent 做成独立进程，不是为了"架构好看"，是四条实打实的工程理由：

- **崩溃隔离**：子agent 挂了（OOM、panic、死循环）不拖死父agent。父agent 收到"子agent 退出 code=1"的通知，决定重试还是换方案。进程内线程做不到——一个线程 panic 整个进程退出。
- **独立 session 文件**：子agent 有自己的 JSONL 会话文件，自己的上下文、自己的消息历史。父agent 的上下文不被子agent 的消息膨胀——父agent 只在 timeline 里放一张 spawn entry 卡片，子agent 的几百条消息在它自己的 session 文件里。
- **独立 tool 配置**：子agent 的 pi 进程可以配不同的 tool 集——有 bash 没 spawn_subagent 的子agent 只能跑命令不能再拆。tool 配置差异是"玩花"的操控面，进程内线程做不到干净的 tool 隔离（共享进程内的 tool 注册表）。
- **独立生命周期**：子agent 可以被 abort、被超时 kill、被父agent 等待——这些操作对应进程级的 stop（已有的 stdin→SIGTERM→SIGKILL 策略），不需要在进程内造一套 task cancel 机制。

进程内线程方案在隔离性、生命周期管理、tool 配置上都做不干净，而 pi-desktop 已经有完整的进程管理基础设施——不利用它才是浪费。

### 1.3 设计原则：三条积木

这个设计的根基是三条原则，后面的协议、进程模型、展示都从这三条延伸：

**积木一：协议平等。** 每个 pi 进程在协议层完全平等——不管是"主 agent"还是"子agent"，都用同一种方式发 `custom` 请求、收 `custom` 响应、推 `custom` 事件。协议里没有 `role: "main" | "sub"` 这种字段——加了就是引擎拿它做 if-else 的外挂戳，和"内容驱动、别 switch"背道而驰。谁是父谁是子，不是协议说的，是 session 文件里 `custom.parent_id` 记的。

**积木二：tool 差异。** agent 之间的差异不在协议层，在 tool 配置层。`spawn_subagent` 是一个 tool——由 pi extension 注册、agent 像调 `bash` 一样调它。父agent 的 pi 进程装了这个 extension，有这个 tool，能起子agent；子agent 的 pi 进程不装，没这个 tool，不能再 spawn，到底了。子agent 装了就能再 spawn 孙agent——递归自然成立，不需要协议层做递归检测。

**积木三：单层是基础形态。** parent→child 一层是所有调度模式的基础。并行 fan-out 是一层上起多个子agent；pipeline 链式是子agent 装了 spawn_subagent tool 再起下一层；受限委托是子agent 的 tool 集只给读不给写。这些都是单层的组合和参数化，不是新概念。文档先把这个基础形态写透，递归树是协议的自然外推。

三条合在一起的含义是：**协议不限制你能做什么，tool 配置决定你能做什么，单层组合产生复杂调度。** 这是"玩花"的三块积木——拿走任何一块，后面的花样就玩不出来。

### 1.4 一个插件的框架压力测试

子agent 这个功能不是普通功能——它同时触及了左侧栏（子agent 缩进嵌套）、会话流（spawn entry 卡片 + 灰色输入框）、配置管理（插件自己的 settings）、pi 通信（custom 协议 + 进度回传）。如果它能作为一个**纯插件**实现——不改内核、不改其他插件——那说明框架的机制足够强。如果不能，缺口在哪就是框架要补的东西。

为什么要求纯插件？因为子agent 是内容，不是机制。它是一种具体的调度功能，不是"让功能能挂上来"的基础设施。按照"机制与内容分离"这条纪律——内核只管机制（加载器、槽位契约、权限沙箱、生命周期），内容全部外挂——子agent 应该完全走插件机制。如果实现它需要改内核代码，说明内核不够薄，机制不够强。VSCode 的语言支持、调试器、主题全是扩展，不是硬编码在内核里。pi-desktop 要走同样的路。

但子agent 和普通插件不一样的地方在于：**它不能自给自足**。一个 theme 插件贡献配色，不依赖别的插件——它往 themes 槽挂一个 `ThemeContribution` 就完了。一个 git-review 插件贡献右面板 Tab，也不依赖别的插件——它往 sidePanel 槽挂一个组件、调 `git.status` IPC 就完了。这些插件是"自封闭"的——自己的数据、自己的渲染、自己的槽位。

子agent 不是。它需要 **sessions-list 帮它缩进渲染子agent 会话**（否则子agent 会话在左侧栏里和父会话平级铺开，乱成一锅粥）；需要 **timeline 帮它渲染 spawn entry 卡片**（否则 spawn 记录在会话流里显示为一条不可读的 raw JSON）；需要 **timeline 帮它在子agent 会话视图里灰色输入框**（否则用户能给子agent 发消息，但子agent 的生命周期由父agent 控制，用户直接输入会产生冲突）。

这三件事都不是 sub-agent 插件自己能做的——它们是 sessions-list 和 timeline 这两个"host 插件"的渲染行为。sub-agent 插件需要 **让别的插件配合自己**——注入过滤逻辑、注入渲染逻辑、注入条件渲染逻辑。当前框架没有"插件 A 影响插件 B 渲染"的协作模型。这就是全文的分水岭：§2–§6 讲"怎么设计"（完整且自洽），§7 讲"框架够不够格让这个设计作为插件落地"（答案是：5 个缺口要补）。

## 2. 通信协议：custom 信封

### 2.1 为什么不发明新顶层类型

pi 和 desktop 之间的 JSONL 协议已经有四个顶层 `type`：`response`、`extension_ui_request`、`extension_ui_response`、以及"其余当 event 转发"的兜底分支（rpc-adapter 的 `handleLine` 方法）。给子agent 调度新发明 `desktop_request` / `desktop_response` / `desktop_event` 三个顶层类型能做，但有两个问题：

- **pi 侧改动大**：每加一个顶层 type，pi 的消息分发器要加一个分支。pi 是独立项目，每改一次协议核心都要协调版本。
- **协议膨胀**：后续每加一个 desktop 能力（不只是 spawn_subagent），是不是又要加新 type？顶层 type 应该是稳定的——它表达"消息的大类"，不应该随能力增长而膨胀。

`type: "custom"` 是一个通用信封：顶层 type 只有一个 `custom`，具体的消息种类用 `sub_type` 鉴别。pi 侧只需在 stdout 上多写一种 `type: "custom"` 的行——rpc-adapter 的 `handleLine` 加一个分支拦截 `custom`，其余逻辑全在分支内部。后续加新能力只加 `sub_type`，不动顶层 type。

这和 `extension_ui_request` 的设计思路一致——它也是一个信封（`type: "extension_ui_request"`），具体的 UI 交互种类用 `method` 鉴别。`custom` 只是把这个思路推广到"desktop 能力调用"这个更大的域。

### 2.2 消息格式

三种 `sub_type` 覆盖请求-响应和异步推送：

```
# pi → desktop (stdout): 请求
{"type": "custom", "sub_type": "desktop_request", "id": "req-1",
 "method": "spawn_subagent", "params": {"task": "...", "cwd": "...", "toolConfig": {...}}}

# desktop → pi (stdin): 响应（spawn 确认，tool 调用仍在 pending）
{"type": "custom", "sub_type": "desktop_response", "id": "req-1",
 "result": {"subagent_id": "sub-1", "status": "running", "subagent_session": "~/.pi/agent/sessions/xxx/sub-1.jsonl", "spawn_entry_id": "entry-42"}}

# desktop → pi (stdin): 异步事件推送（fire-and-forget，无 id）
{"type": "custom", "sub_type": "desktop_event",
 "event": {"kind": "subagent_progress", "subagent_id": "sub-1", "data": {...}}}
{"type": "custom", "sub_type": "desktop_event",
 "event": {"kind": "subagent_done", "subagent_id": "sub-1", "result": "..."}}
```

`desktop_request` 带 `id`，`desktop_response` 用同一个 `id` 配对——沿用 rpc-adapter 已有的 id 配对模式（handler 读 request 的 id，处理后写回同名 id 的 response），但不走 `RequestCorrelator`（correlator 是 command→response 的超时管理机制，custom 通道的 id 配对是 handler 手动回写，和 `sendExtensionUIResponse` 同一模式）。`desktop_event` 不带 `id`，是 fire-and-forget 推送，用于子agent 进度的流式回传。

`desktop_response` 的 `result` 里携带 `subagent_session`（子agent session 文件路径）和 `spawn_entry_id`（desktop 生成的 UUID，用于双向关联父 session 的 spawn entry 和子 session 的 header，见 §6.1）——extension 拿到这些值后写进父agent session 的 spawn entry（见 §5.4），timeline 读 spawn entry 时用 `subagent_session` 打开子agent 会话视图（见 §6.4）。这是向前关联链路的关键一环。

`method` 字段是具体能力的名字（`spawn_subagent`、`query_subagent`、`abort_subagent` 等），`params` 是该能力的参数。这和 `extension_ui_request` 的 `method` + 动态字段是同一套模式——信封固定，内容按 `method` 变化。

### 2.3 rpc-adapter 怎么处理

`handleLine` 当前四个分支的顺序是：`extension_ui_request` → `response`（配对 id）→ `extension_ui_response`（忽略）→ 其余当 event 转发。加 `custom` 分支插在 `extension_ui_request` 之后、`response` 之前：

```typescript
// 新增分支（插在 extension_ui_request 之后）
if (data.type === "custom") {
  const subType = data.sub_type as string;
  if (subType === "desktop_request") {
    // 有 id 的请求 → 走 custom request handler（注入）
    this.customRequestHandler?.(data);
  } else {
    // desktop_response / desktop_event 是 desktop → pi 方向，
    // pi 不会从 stdout 收到这些（它们走 stdin），不会进这条分支
    // 但兜底：未知 sub_type 当 event 转发
    for (const cb of this.eventListeners) cb(data as unknown as AgentSessionEvent);
  }
  return;
}
```

注意方向：`desktop_request` 是 pi → desktop（走 stdout），desktop 处理后经 stdin 回 `desktop_response`。`desktop_event` 是 desktop → pi（走 stdin）。pi 的 stdin 侧需要能收 `custom` 消息——这由 spawn_subagent extension 处理（见 §5）。

desktop 侧回 `desktop_response` 和 `desktop_event` 不是走 `rpc-adapter.send()`（那是发 command 的），而是直接写 stdin：

```typescript
// 回 response（配对 id）
handle.stdin.write(JSON.stringify({
  type: "custom", sub_type: "desktop_response", id: "req-1",
  result: { subagent_id: "sub-1", status: "running" }
}) + "\n");

// 推 event（fire-and-forget）
handle.stdin.write(JSON.stringify({
  type: "custom", sub_type: "desktop_event",
  event: { kind: "subagent_progress", subagent_id: "sub-1", data: {...} }
}) + "\n");
```

这复用了 `sendExtensionUIResponse` 同样的"直接写 stdin、不走 correlator"模式。但这条路径当前只用于回 pi 的请求——**desktop 主动推送 `desktop_event` 需要一个新的 IPC**，让 plugin 告诉 desktop"往这个 session 的 pi stdin 写一行 custom JSON"。这是框架缺口之一，详见 §7.4。

### 2.4 与 extension_ui_request 并存

`extension_ui_request` 和 `custom` 是两条独立的 pi→desktop 请求-响应通道，不合并：

- **`extension_ui_request`**：UI 交互——select/confirm/input/editor 等，desktop 收到后转发到 renderer（经 IPC `session:extensionUI`），renderer 渲染 UI、用户操作、回 IPC `session:replyExtensionUI`，desktop 再经 stdin 写回 `extension_ui_response`。整条链路经过 renderer，因为需要用户交互。
- **`custom`**：能力调用——spawn_subagent/query_subagent/abort_subagent 等，desktop 收到后在 **main 进程直接处理**（spawn 新 pi 进程、路由事件），不经过 renderer。response 经 stdin 直接写回 pi。

两条通道的判据是"需不需要 renderer 参与"：需要的就是 `extension_ui_request`，不需要的就是 `custom`。把它们合并成一条通道不会更简单——反而让 main 进程要判断"这个 request 是走 renderer 还是走自己"，多一层 if-else，违反"别 switch"原则。

## 3. 进程模型：每个 agent 都是平等的 pi 进程

### 3.1 spawn 全链路时序

从 agent 调 spawn_subagent tool 到子agent 结果回传，完整链路：

```mermaid
sequenceDiagram
    participant Agent as 父agent (pi)
    participant Desktop as desktop (Electron main)
    participant Sub as 子agent (pi)

    Agent->>Desktop: stdout: custom/desktop_request<br/>method=spawn_subagent, params={task, cwd, toolConfig}
    Desktop->>Desktop: spawn 新 pi 进程<br/>(createPiSubprocess + RpcAdapter)
    Desktop->>Sub: env: PI_DESKTOP_SPAWN_TASK, PI_DESKTOP_SUBAGENT_ID, ...
    Desktop-->>Agent: stdin: custom/desktop_response<br/>result={subagent_id, subagent_session, status=running}

    Sub-->>Desktop: stdout: 事件流 (message_start, tool_call_start, ...)
    Desktop-->>Agent: stdin: custom/desktop_event<br/>event={kind=subagent_progress, data=...}

    Sub-->>Desktop: stdout: agent_end + 最终结果
    Desktop-->>Agent: stdin: custom/desktop_event<br/>event={kind=subagent_done, result=...}

    Desktop->>Sub: stop (stdin→SIGTERM→SIGKILL)
```

agent 调 spawn_subagent tool 后，extension 发 `desktop_request` 给 desktop。desktop 收到后用 `createPiSubprocess` spawn 一个新 pi 进程，给它绑一个 `RpcAdapter`，分配 `subagent_id`，通过环境变量注入 task 和 parent 信息（见 §6.1）。desktop 回 `desktop_response`（status=running + subagent_session 路径），但 **tool 调用不在这里 resolve**——spawn_subagent tool 的语义和 `bash` 一致：调了就等结果，子agent 的进度像 bash stdout 一样流式推送（`desktop_event` / `subagent_progress`），子agent 完成后 `desktop_event` / `subagent_done` 携带最终结果，extension 此时才 resolve tool 调用，把结果作为 tool 返回值还给 agent。

子agent 运行期间，它的事件流（`message_start`、`tool_execution_start` 等）经自己的 `RpcAdapter.onEvent()` 到 desktop。desktop 把这些事件包成 `desktop_event`（`kind: subagent_progress`），写到父agent 的 stdin。这些进度事件作为 tool 调用的中间输出——agent 在等待 tool 返回值时能看到子agent 的实时进度，和看 bash stdout 是同一套机制。

子agent 完成后（`agent_end` 事件），desktop 发 `desktop_event`（`kind: subagent_done`），包含最终结果。extension 把结果作为 tool 的返回值还给 agent。

### 3.2 复用现有基础设施

子agent 进程的 spawn、kill、JSONL 读写全部复用现有机制，不新造：

- **`createPiSubprocess`**：spawn `pi --mode rpc`，返回 `SubprocessHandle`。子agent 和普通会话进程走同一个函数，同一套 spawn 参数（`cwd`、`args`、`env`）。
- **`RpcAdapter`**：消费 `SubprocessHandle` 的 stdin/stdout 做 JSONL 读写 + id 配对 + event 分发。子agent 的 adapter 和父agent 的 adapter 是同一个类。
- **`RpcAdapterFactory`**：application 层持有的依赖倒置接口，shell 注入实现。子agent store 也持这个接口，同一个 factory 造出来的 adapter 既能管会话进程也能管子agent 进程。
- **stop 策略**：stdin.end → 1s 等 → SIGTERM → 2s 等 → SIGKILL。子agent abort 走同一套。

复用的前提是：子agent 和会话进程在进程层面是同一个东西——都是 `pi --mode rpc`，都有 stdin/stdout JSONL，都有 `RpcAdapter` 绑着。区别只在"谁 spawn 的"（desktop 直接受父agent 请求 spawn vs 用户开新会话时 spawn）和"session 文件里有没有 parent_id"。这个区别不进进程管理层，只进 session 元数据和路由逻辑。

### 3.3 生命周期状态机

```mermaid
stateDiagram-v2
    [*] --> Spawning: desktop 收到 spawn_subagent 请求
    Spawning --> Running: pi 进程启动 + RpcAdapter.start() 成功
    Spawning --> Error: spawn 失败 (cli 不存在 / 权限不够)
    Running --> Done: 子agent agent_end + 结果已回传
    Running --> Error: 进程异常退出 (code != 0)
    Running --> Aborted: 父agent 发 abort_subagent / 超时 kill
    Done --> [*]: desktop stop 子agent 进程
    Error --> [*]: desktop stop 子agent 进程
    Aborted --> [*]: desktop stop 子agent 进程 (SIGTERM→SIGKILL)
```

五个状态：`spawning`（desktop 正在 spawn）、`running`（子agent 活着、事件在流转）、`done`（子agent 正常完成、结果已回传父agent）、`error`（子agent 异常退出）、`aborted`（被父agent 或超时主动 kill）。

状态转移的触发者分三类：

- **desktop 内部触发**：spawning→running（spawn 成功）、spawning→error（spawn 失败）。desktop 自己管。
- **子agent 事件触发**：running→done（收到 `agent_end`）、running→error（进程退出 code≠0）。desktop 经子agent 的 `RpcAdapter.onProcessExit` 感知。
- **父agent 请求触发**：running→aborted（父agent 发 `abort_subagent` 或子agent 超时）。desktop 收到后调子agent adapter 的 `stop()`。

状态存哪：进程池持一个 `Map<subagentId, SubAgentProc>`，每个 `SubAgentProc` 记录 `adapter`、`parentSessionKey`、`subagentId`、`status`、`spawnTime`、`toolConfig`。

### 3.4 资源限制

四道闸：

- **并发上限**：一个父agent 同时活着的子agent 数量有上限（配置项，默认 5）。超过上限的 spawn 请求直接回 `desktop_response` 带 `status=rejected, reason=max_concurrent`，extension 把这个结果还给 agent，agent 决定排队还是放弃。
- **超时**：每个子agent 有最大执行时间（配置项，默认 10 分钟）。超时后 desktop 自动 abort（走 stop 策略），发 `desktop_event` 带 `kind=subagent_done, status=timeout`。
- **递归深度**：不靠协议层检测递归——靠 tool 配置。子agent 的 `toolConfig` 不包含 `spawn_subagent` group，它就没这个 tool，不能再 spawn。要允许递归（子agent 能再 spawn 孙agent），给子agent 配上 `spawn_subagent` tool 即可。递归深度 = tool 配置的层数，是部署决策不是协议限制。
- **父进程崩溃 → 孤儿清理**：desktop 通过父agent 的 `RpcAdapter.onProcessExit` 感知父agent pi 进程退出。如果退出是非预期的（非 desktop 主动 stop），遍历该父 session 下所有 `status=running` 的子agent，逐个调 `stop()`（stdin→SIGTERM→SIGKILL），并在子agent session 文件里记一条 `custom.sub_type: "subagent_aborted", reason: "parent_crashed"`。子agent 的结果不再尝试路由到父agent stdin（父已死，stdin 不可达）。这和 desktop 整体关闭（`app.on("before-quit")` → `stopAll()`）不同——整体关闭时 desktop 自己也死了，没有进程来清理；父进程崩溃时 desktop 还活着，能主动清理。

第三道闸是"tool 差异"原则的直接体现——不靠 `depth` 字段让引擎 if-else，靠 tool 可用性涌现。第四道闸是"崩溃隔离"的反面——§1.2 说子agent 崩溃不拖死父agent，这里补上父agent 崩溃不留下孤儿子agent。

## 4. tools 驱动的差异控制

### 4.1 spawn_subagent 是 tool 不是协议角色

agent 调 spawn_subagent 的方式和它调 `bash`、`read_file` 完全一样——pi 的 tool 系统注册了一个叫 `spawn_subagent` 的 tool，agent 在推理过程中决定"这个子任务我外包出去"，调了这个 tool，tool 的实现（一个 pi extension）经 stdout 发 `custom/desktop_request` 给 desktop，desktop spawn 新 pi 进程，结果经 stdin 回 `custom/desktop_response` 和 `custom/desktop_event`，extension 把最终结果作为 tool 的返回值还给 agent。

agent 不知道 desktop 存在。它的视角是："我调了一个 tool，tool 帮我起了一个子agent，子agent 的结果回来了"。这和调 `bash`——"我调了一个 tool，tool 帮我跑了个命令，命令的输出来了"——是同一个心智模型。

这个设计的关键是：**层级控制不在协议层，在 tool 可用性层**。没有 `role: "main" | "sub"` 字段让引擎 switch——加了就是声明式类型标签，和"内容驱动、别 switch"背道而驰。谁是父谁是子，是 session 文件里 `custom.parent_id` 记的，是数据，不是引擎分支的依据。

### 4.2 tool 配置决定 agent 能力

pi 已有 tool 配置机制：session header 里的 `toolConfig`（`{ mode: "all" | "custom", enabledGroupIds?: string[] }`），`session:readToolConfig` IPC 已经能读，`session:updateHeader` IPC 已经能改。

spawn 子agent 时，desktop 在 spawn 参数里注入子agent 的 `toolConfig`。注入方式：desktop 把 `toolConfig` 序列化为 JSON 放进环境变量 `PI_DESKTOP_TOOL_CONFIG`，子agent 的 extension 启动时读出来写进 session header 的 `toolConfig` 字段——和 parent 信息注入（§6.1 的 `PI_DESKTOP_PARENT_SESSION` 等）走同一套环境变量机制。pi 启动后从 session header 读 `toolConfig` 限制可用 tool：

- `mode: "custom"` + `enabledGroupIds` 不含 `spawn_subagent` group → 子agent 不能再 spawn
- `mode: "custom"` + `enabledGroupIds` 含 `spawn_subagent` group → 子agent 能再 spawn 孙agent
- `mode: "all"` → 子agent 有全部 tool，包括 spawn_subagent（默认全开，用于不限制的场景）
- `enabledGroupIds` 不含 `bash` → 子agent 不能跑命令，只能纯推理
- `enabledGroupIds` 不含 `write_file` → 子agent 只能读不能写

不同的 tool 组合产生不同的 agent 角色——"只读分析型"（有 read 没 write）、"受限执行型"（有 bash 没 spawn）、"全权委托型"（全开）。这些角色不是枚举出来的 `kind`，是 tool 配置的参数化结果。

### 4.3 "玩花"的三块积木

回到 §1.3 的三条原则，这里是它们怎么产生调度模式：

- **单层 + 并行 fan-out**：父agent 同时调 3 次 spawn_subagent，传不同的 task 和 toolConfig。desktop 并行起 3 个 pi 进程，各自跑各自的，结果分别回传。父agent 在 timeline 里看到 3 张 spawn entry 卡片。
- **单层 + 受限委托**：父agent 调 spawn_subagent，toolConfig 只给 `read_file` + `bash`（不给 `write_file`、不给 `spawn_subagent`）。子agent 能分析、能跑命令，但不能改文件、不能再拆。父agent 信任度低时用。
- **递归 + pipeline 链式**：子agent 的 toolConfig 含 `spawn_subagent`，它跑了一半发现需要再拆，调 spawn_subagent 起 孙agent。孙agent 的结果回给子agent，子agent 把自己的结果回给父agent。三层 pipeline 自然成立——协议层每层都是平等的 pi 进程，每层的 extension 都是一样的代码。
- **递归 + 分治**：父agent 把大任务拆成 2 个子agent，每个子agent 再拆 2 个孙agent，4 个孙agent 并行跑。结果逐级合并回传。tool 配置控制每层能拆几层、能做什么。

这些模式不需要协议层或 desktop 专门支持——都是"单层 spawn + tool 配置"的组合。desktop 只管"收到 spawn 请求 → 起进程 → 路由事件"，不关心调用方是父agent 还是子agent，不关心是并行还是串行。调度模式是 tool 配置涌现的，不是 desktop 编排的。

## 5. spawn_subagent extension 设计

### 5.1 extension 的职责边界

spawn_subagent tool 由一个 **pi extension** 提供。pi extension 是 pi 的扩展机制——用 `pi install` 安装、在 pi 进程内运行、能注册 tool 和 slash command。这个 extension 的职责是：

- 向 pi 注册一个 tool（`spawn_subagent`），让 agent 能在推理时调它
- tool 被调时，经 pi 的 stdout 发 `custom/desktop_request` 给 desktop
- 在 pi 的 stdin 上监听 `custom/desktop_response` 和 `custom/desktop_event`
- 子agent 完成后，把结果作为 tool 的返回值还给 pi 的 tool 系统
- 在 session 文件里写 spawn 记录 entry（`type: "custom"`, `custom.sub_type: "subagent_spawned"`）

extension **不**负责：spawn 进程（desktop 的事）、路由事件（desktop 的事）、渲染 UI（timeline 插件的事）。它是 pi 和 desktop 之间的桥——一侧接 pi 的 tool 系统，另一侧接 JSONL 的 custom 通道。

### 5.2 tool 注册与调用流程

```mermaid
flowchart TD
    A["pi 启动"] --> B["extension 注册<br/>spawn_subagent tool"]
    B --> C["agent 推理时<br/>决定调用 spawn_subagent"]
    C --> D["extension 收到 tool 调用<br/>参数: task, cwd, toolConfig"]
    D --> E["经 stdout 发<br/>custom/desktop_request"]
    E --> F["desktop 收到<br/>spawn 新 pi 进程"]
    F --> G["desktop 经 stdin 回<br/>custom/desktop_response"]
    G --> H["extension 收到 response<br/>tool 进入等待"]
    H --> I["desktop 推送<br/>custom/desktop_event<br/>(subagent_progress)"]
    I --> J["desktop 推送<br/>custom/desktop_event<br/>(subagent_done)"]
    J --> K["extension 把结果<br/>作为 tool 返回值还 agent"]
    K --> L["agent 拿到结果<br/>继续推理"]
```

extension 注册 tool 时声明它的参数 schema（`task: string`, `cwd?: string`, `toolConfig?: object`），pi 的 tool 系统据此让 agent 知道"有一个叫 spawn_subagent 的 tool 可以用，参数长这样"。agent 在推理时如果决定用它，pi 的 tool 系统调 extension 的 handler，handler 拿到参数后发 custom 请求。

### 5.3 stdin 监听与消息分发

extension 需要在 pi 的 stdin 上监听 `custom` 消息。pi 的 stdin 当前收两类消息：command（`type: "prompt"` 等）和 `extension_ui_response`。extension 要让 pi 的 stdin 分发器多识别一种 `type: "custom"`：

```
pi stdin 收到一行 JSON
  ├── type === "prompt" / "abort" / ... → command 分发器
  ├── type === "extension_ui_response" → extension UI 回复分发器
  └── type === "custom" → extension 的 custom 分发器
        ├── sub_type === "desktop_response" → 配对 id，把 resolve 从第一级迁移到第二级（key 换成 subagentId），不在此处 resolve
        └── sub_type === "desktop_event"  → 按 event.kind 分发
              ├── kind === "subagent_progress" → 存进度（可选透传给 agent）
              └── kind === "subagent_done" → 取 result，调 resolve（此时才 resolve tool 调用）
```

extension 内部维护**两级映射**，处理从 spawn 到完成的完整生命周期：

**第一级**：`pendingRequests: Map<requestId, { resolve: (result) => void, task: string }>`——每次发 `desktop_request` 时分配一个 `requestId`（自增计数器或 UUID），把 Promise 的 resolve 函数和 task 存进去。收到 `desktop_response` 时按 `requestId` 取出，response 里的 `subagent_id` 和 `subagent_session` 转存到第二级。

**第二级**：`activeSubAgents: Map<subagentId, { resolve: (result) => void, task: string, progress: unknown[] }>`——`desktop_response` 到达后，把 resolve 函数从第一级迁移到第二级（key 从 `requestId` 换成 `subagentId`）。后续收到 `desktop_event`（`subagent_progress`）时按 `subagent_id` 查第二级，把进度追加到 `progress` 数组（作为 tool 的中间输出，agent 在等待时能看到）。收到 `subagent_done` 时按 `subagent_id` 取出 resolve，把 `result` 作为 tool 返回值调 resolve，然后从第二级删除。

**竞态处理**：如果 `desktop_event`（`subagent_progress`）比 `desktop_response` 先到达（子agent 起得太快、事件路由比 response 回写快），extension 暂存这些 event 到一个 `pendingEvents: Map<subagentId, event[]>` 队列。`desktop_response` 到达、第二级映射建好后，把队列里的 event flush 进去。这样即使事件早于 response 到达，也不会丢失。

### 5.4 session 文件写入

extension 在两个时机写 session 文件：

**spawn 时**，写一条 spawn 记录 entry 到父agent 的 session 文件。entry 里的 `subagent_session` 路径来自 `desktop_response` 的 `result.subagent_session`（见 §2.2），extension 从 response 里拿到后写进 entry：

```json
{
  "id": "entry-42",
  "type": "custom",
  "custom": {
    "sub_type": "subagent_spawned",
    "subagent_id": "sub-1",
    "subagent_session": "~/.pi/agent/sessions/xxx/sub-1.jsonl",
    "task": "把 auth.ts 拆成 3 个文件",
    "tool_config": { "mode": "custom", "enabledGroupIds": ["read_file", "bash"] }
  },
  "timestamp": 1234567890
}
```

**子agent 完成时**，追加一条 done entry 到父agent 的 session 文件（JSONL 不支持原地修改，只追加）：

```json
{
  "id": "entry-43",
  "type": "custom",
  "custom": {
    "sub_type": "subagent_done",
    "subagent_id": "sub-1",
    "result": "拆成 auth-login.ts, auth-token.ts, auth-session.ts"
  },
  "timestamp": 1234567999
}
```

这些 entry 由 timeline 按 `entry.type === "custom"` 识别、按 `custom.sub_type` 选渲染器——和现在按 `entry.type` 选渲染器是同一套机制，只是多了一个分支。

session 文件写操作由 desktop 经框架的 JSONL 追加能力完成（`~/.pi/agent/` 在路径白名单内），extension 经 IPC 请求 desktop 追加——不是 extension 直接写文件。详见 §7.6。

子agent 的 session 文件由 pi 自己写（和普通会话一样），session header 里加 `custom.parent_id` 等字段——desktop spawn 子agent 时通过环境变量注入这些值（`PI_DESKTOP_PARENT_SESSION` 等），子agent 的 extension 启动时读到环境变量后写进 session header（见 §6.1）。

### 5.5 extension 的配置

extension 自身需要知道几件事：

- **desktop 的 custom 通道是否可用**：extension 启动时可以发一个 `desktop_request`（`method: "ping"`），如果收到 `desktop_response` 说明跑在 pi-desktop 里、custom 通道活着；超时没回说明没跑在 desktop 里（比如用户直接命令行用 pi），extension 退化为"spawn_subagent tool 不可用"——agent 调时直接返回"此环境不支持子agent"。

- **自身作为子agent 运行时的 parent 信息**：desktop spawn 子agent 时通过环境变量注入（如 `PI_DESKTOP_PARENT_SESSION=/path/to/parent.jsonl`、`PI_DESKTOP_SUBAGENT_ID=sub-1`），extension 读到这些变量就在 session header 里写 `custom.parent_id`。读不到说明是普通会话，不写。

这个设计让 extension 在"有 desktop"和"没 desktop"两种环境都能跑——有 desktop 时提供 spawn_subagent tool，没 desktop 时静默退化为不可用。pi 核心不需要知道 desktop 存不存在。

## 6. session 元数据与会话展示

### 6.1 子agent session header 的 custom 字段

子agent 的 session 文件第一行（header）加 `custom` 字段，记录它的归属：

```json
{
  "type": "session_header",
  "sessionId": "sub-1",
  "sessionName": "拆分 auth.ts",
  "custom": {
    "parent_id": "agent-main",
    "parent_session": "~/.pi/agent/sessions/xxx/parent.jsonl",
    "subagent_id": "sub-1",
    "spawn_task": "把 auth.ts 拆成 3 个文件",
    "spawn_entry_id": "entry-42"
  }
}
```

desktop spawn 子agent 时，通过环境变量注入这些值（`PI_DESKTOP_PARENT_SESSION`、`PI_DESKTOP_SUBAGENT_ID`、`PI_DESKTOP_SPAWN_TASK`、`PI_DESKTOP_SPAWN_ENTRY_ID`）。`spawn_entry_id` 由 desktop 在 spawn 时生成（UUID），同时放进 `desktop_response` 回给父agent 的 extension（extension 用它写 spawn entry 的 `id` 字段）和子agent 的环境变量（子agent 的 extension 用它写 session header 的 `spawn_entry_id`）。这样父 session 的 spawn entry 和子 session 的 header 通过同一个 id 双向关联。子agent 的 extension 启动时读到环境变量，写进 session header。

timeline 读到 header 有 `custom.parent_id` 就知道这是子agent 会话，渲染时加"← 返回父会话"导航和灰色输入框。

### 6.2 父agent session 的 spawn 记录

父agent 的 session 文件里，spawn 这步落盘为一条 `type: "custom"` 的 entry（见 §5.4）。timeline 遇到 `entry.type === "custom"` 时，按 `custom.sub_type` 选渲染器：

- `subagent_spawned` → 渲染为 spawn entry 卡片（见 §6.4）
- `subagent_done` → 更新对应卡片的 status 和结果

timeline 需要支持如下 entry 渲染器注册机制（当前不存在，是框架缺口之二，见 §7.3）——`registerCustomEntryRenderer(subType, renderer)`，和 `registerSettingsComponent`、`registerSidePanelComponent` 同一套按名注册、按名查的模式，只是在 entry 渲染管线加一个分支。

> **框架缺口**：`registerCustomEntryRenderer` 当前不存在。timeline 是一个封闭的胖插件——自己读 session 文件、自己渲染所有 entry 类型，不暴露扩展点。其他插件想注册自定义 entry 渲染器做不到。这是框架缺口之二，详见 §7.3。

### 6.3 左侧栏：子agent 缩进嵌套在父会话下

sessions-list 插件读 session 列表时，对每个 session 检查 header 的 `custom.parent_id`。有 `parent_id` 的不作为顶层会话列出，而是缩进在父会话下面：

```
┌─────────────────────────────────────────────┐
│  对话                                [+ 新建] │
│  ┌─────────────────────────────────────┐    │
│  │ 💬 重构认证模块             14:32     │    │
│  │  ▸ 🔹 拆分 auth.ts          14:33     │    │
│  │  ▸ 🔹 为 auth 写测试        14:33     │    │
│  │  ▸ 🔹 集成测试              14:35     │    │
│  │ 💬 上周的 bug 修复          10:15     │    │
│  │ 💬 数据库迁移脚本          昨天       │    │
│  └─────────────────────────────────────┘    │
└─────────────────────────────────────────────┘
```

父会话默认收起子agent 列表（▸），点展开（▾）才看到子agent。子agent 的 icon 用 🔹 区分于普通会话的 💬。点击子agent 切到它的会话视图。

渲染逻辑：sessions-list 读到 session 的 `custom.parent_id` 时，把它归到 parent 下面。parent 没在当前列表里（比如父会话被归档了）的子agent 退化为顶层显示，加"🔹 └ [父会话名]"标记。

> **框架缺口**：这里有两个问题。第一，`SessionInfo` 类型没有 `custom` 字段——`listSessions` 解析了 header 但只提取已知字段，`custom` 被丢弃。第二，sessions-list 是另一个插件的封闭组件，sub-agent 插件无法注入自己的渲染逻辑。这是框架缺口之一，详见 §7.2。

### 6.4 父会话 timeline 的 spawn entry 卡片

父会话的 timeline 里，spawn 记录渲染为一张卡片——不是一条消息气泡，视觉上和普通消息有区分：

```
┌─────────────────────────────────────────────────────────┐
│  🤖 Assistant                                           │
│  这个任务我拆成两路并行处理：                            │
│                                                         │
│  ┌───────────────────────────────────────────────┐      │
│  │ 🔹 拆分 auth.ts              ✅               │      │
│  │ 把 auth.ts 拆成 3 个文件       [打开 ↗]        │      │
│  └───────────────────────────────────────────────┘      │
│                                                         │
│  ┌───────────────────────────────────────────────┐      │
│  │ 🔹 为 auth 模块写测试        ● 运行中          │      │
│  │ 给 3 个文件写单元测试         [打开 ↗]        │      │
│  └───────────────────────────────────────────────┘      │
│                                                         │
│  🤖 Assistant (等待子agent完成...)                      │
└─────────────────────────────────────────────────────────┘
```

卡片三行：任务名 + 状态指示灯（● 运行中 / ✅ 完成 / ❌ 失败）+ 任务描述。"打开"按钮或点卡片本身切到子agent 的会话视图。**不在父 timeline 里展开子agent 的消息**——子agent 的完整消息流在它自己的 session 视图里。

并行子agent 多了（5 个以上）时，聚合为一个批次卡片：

```
┌───────────────────────────────────────────────┐
│ ▸ 🔹 子agent 批次 (3/5 完成)                   │
│   ✅ 拆分 auth.ts                              │
│   ✅ 写 auth-login 测试                        │
│   ✅ 写 auth-token 测试                        │
│   ● 写 auth-session 测试                      │
│   ⏳ 写集成测试                                │
└───────────────────────────────────────────────┘
```

### 6.5 子agent 会话视图：完整 timeline + 灰色输入框

点 spawn entry 卡片切到子agent 的会话视图——和普通会话的 timeline 一模一样的渲染，完整消息流，只是两处不同：

```
┌─────────────────────────────────────────────────────────┐
│ ← 返回 "重构认证模块"    🔹 拆分 auth.ts        ✅ 完成 │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  🤖 子agent 开始                                        │
│  分析 auth.ts 结构，文件 420 行...                      │
│                                                         │
│  🔧 read_file auth.ts                                   │
│  🔧 write_file auth-login.ts                            │
│  🔧 write_file auth-token.ts                           │
│  🔧 write_file auth-session.ts                         │
│                                                         │
│  🤖 完成                                                │
│  拆成: auth-login (登录) / auth-token (token) / session │
│                                                         │
├─────────────────────────────────────────────────────────┤
│  ┌───────────────────────────────────────────────┐      │
│  │  子agent 已完成，输入不可用                    │      │
│  └───────────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────────┘
```

两处不同：

- **标题栏左侧加"← 返回"导航**：点击切回父会话视图。标题显示"🔹 任务名"和状态。
- **输入框灰色不可输入**：子agent 的生命周期由父agent 控制——用户不能直接给子agent 发消息。运行中显示"子agent 运行中，输入不可用"，完成后显示"子agent 已完成，输入不可用"。

灰色输入框的实现：timeline 插件渲染时检查 session header 的 `custom.parent_id`，有就把输入框组件替换为一个只读提示条。这是纯渲染层逻辑，不碰通信——session header 有没有 `parent_id` 是数据，不是权限检查。

> **框架缺口**：timeline 不暴露条件渲染 hook。一个插件不能修改另一个插件的渲染行为——sub-agent 插件无法让 timeline 在检测到 `parent_id` 时换灰色输入框。这和 §6.2 的 `registerCustomEntryRenderer` 缺口是同一个根因：timeline 是封闭组件，不提供扩展点。详见 §7.3。

### 6.6 回看与持久化

session 文件是 agent 层级的单一真相源。重启 pi-desktop 后：

- 父agent session 里的 spawn entry 仍在 → timeline 仍显示 spawn 卡片
- 子agent session 文件仍在 → 点击卡片仍能打开完整会话视图
- 左侧栏仍能按 `custom.parent_id` 缩进嵌套 → 层级关系完整保留

这比"关系只存在 desktop 内存"的方案多一个持久化维度——desktop 进程重启不丢 agent 树，任何时刻打开都能看到完整的层级和全部历史。

## 7. 框架能力审查：纯插件实现的五个缺口

子agent 作为纯插件需要触碰 9 个框架接入点。逐一审查后，5 个有缺口，4 个框架已具备。这一节是全文的分水岭——§2–§6 的设计完整且自洽，但"设计完整"不等于"框架够格让这个设计作为插件落地"。缺口按严重度排列，从最大的开始。

### 7.1 接入点全景

| # | 接入点 | 框架是否支持 | 缺口类型 |
|---|--------|:-----------:|----------|
| 1 | 左侧栏缩进嵌套 | ❌ | 插件 inter-plugin 扩展机制缺失 |
| 2 | timeline spawn 卡片渲染 | ❌ | timeline 不暴露 entry 渲染 hook |
| 3 | 子agent 灰色输入框 | ❌ | timeline 不暴露条件渲染 hook |
| 4 | 子agent 进度回传到父agent | ❌ | 缺 desktop→pi 主动推送 IPC |
| 5 | spawn pi 带自定义配置 | ❌ | HeaderPatch 缺 custom 字段 |
| 6 | session 写 custom entry | ❌ | 缺 appendJsonlLine 操作原语 |
| 7 | 插件配置 | ✅ | 框架自动管 |
| 8 | sidebar/sidePanel/settings 槽位贡献 | ✅ | 完整支持 |
| 9 | pi 通信（extension_ui_request 回路） | ✅ | 已有 request-response 通道 |

### 7.2 缺口一：插件 inter-plugin 扩展机制缺失（大缺口）

#### 问题的本质：插件是"自封闭"的，没有协作模型

pi-desktop 的插件体系目前只有一种协作模式：**槽位并列**。sidebar 槽允许多个插件各贡献一个组件，`Sidebar` 组件按 `slots:sidebar()` 遍历渲染——每个组件在自己的 Panel 里各画各的。sidePanel 槽同理——多个插件各贡献一个 Tab，`RightPanel` 按 `slots:sidePanel()` 遍历渲染。

"并列"够用的场景是：插件的数据自己拉、渲染自己做、不依赖别的插件。git-review 插件调 `git.status` 拿数据、自己画 diff 视图——不碰 sessions-list、不碰 timeline。token-stats 插件调 `session.getStats` 拿数据、自己画统计图——也不碰别人。这些插件是"自封闭"的：自己管数据、自己管渲染、自己占一个槽位。

子agent 打破了这个前提。它需要的三件事全是**改别的插件的渲染行为**：

- **sessions-list 帮它缩进渲染子agent 会话**——子agent 的 session 文件和父agent 在同一个 cwd 桶里，`listSessions` 按 mtime 排序返回。如果不改 sessions-list 的渲染逻辑，子agent 会话会作为顶层会话平级铺开，用户看到一堆"拆分 auth.ts""为 auth 写测试"混在正常会话列表里，不知道哪个是谁的子任务。sub-agent 插件需要让 sessions-list "遇到有 `custom.parent_id` 的 session，就缩进在父会话下面渲染"——这是 sessions-list 的渲染行为，sub-agent 插件自己画不了。

- **timeline 帮它渲染 spawn entry 卡片**——spawn 记录是 `type: "custom"` 的 entry，timeline 当前不认识这种 entry 类型。如果 timeline 遇到不认识的 entry 类型默认跳过或显示 raw JSON，spawn 记录在会话流里要么消失、要么是一坨不可读的 JSON。sub-agent 插件需要让 timeline "遇到 `type: "custom"` + `sub_type: "subagent_spawned"` 的 entry，用我注册的渲染器画成一张 spawn 卡片"——这是 timeline 的 entry 渲染行为。

- **timeline 帮它在子agent 会话视图里灰色输入框**——子agent 会话视图就是正常 timeline 渲染子agent 的 session 文件。但子agent 的生命周期由父agent 控制，用户不能直接给子agent 发消息——输入框必须是灰色只读的。timeline 渲染输入框时不检查 session header 的 `custom.parent_id`，sub-agent 插件无法让它"在特定条件下换组件"。

三件事的核心都是同一个问题：**插件 A 需要改变插件 B 的渲染行为，但框架没有提供这个能力。**

#### 当前框架的两种插件协作方式和它们的局限

框架目前有两种让插件"配合"的方式，但都不够：

**第一种：槽位并列。** sidebar 槽允许多个插件各贡献一个组件。但这是"并列"不是"协作"——sub-agent 插件可以往 sidebar 槽贡献一个自己的列表组件，但 sessions-list 还在那里照常平铺。结果是同一个会话出现两次：sessions-list 里一份（平级顶层），sub-agent 插件里一份（缩进嵌套）。用户看到两份列表，重复且混乱。

**第二种：共享状态。** 插件间通过 zustand store 间接通信——插件 A 改了某个状态（如 `currentSessionPath`），订阅这个状态的插件 B 被通知。但这是"数据共享"不是"渲染控制"——sessions-list 可以从 store 读到 `custom.parent_id`（如果 SessionInfo 带了这个字段），但它自己的渲染代码不根据这个字段分组。共享状态让"数据可见"，不解决"渲染可控"。

缺的是第三种协作方式：**host 插件暴露扩展 hook，extension 插件注入渲染逻辑**。这不是新概念——`@pi-desktop/react` 已经有 `registerSettingsComponent`、`registerSidePanelComponent`、`registerSidebarComponent`——这些就是 "host（壳组件）暴露注册函数，extension（插件）注册组件"的模式。但它们注册的都是**槽位级组件**（整个 Tab、整个分组），不是**组件内部的渲染分支**（一个 entry 类型、一个条件渲染）。

#### 缺口的形状：host 插件需要暴露"渲染分支注册"

缺口不是"框架缺一个 API"——是 host 插件（sessions-list、timeline）需要从"封闭渲染"升级为"host + extension"模式。具体形状：

**sessions-list 需要暴露两层 hook**：

- `registerSessionFilter(filter: (session: SessionInfo) => SessionInfo | null)`——其他插件过滤或变换 session 列表项。sub-agent 插件注册一个 filter：遇到有 `custom.parent_id` 的 session，把它从顶层列表移除（不作为顶层项渲染），只保留 parent→child 的关联信息让分组渲染器处理。

- `registerSessionGroupRenderer(renderer: (sessions: SessionInfo[], parentMap: Map<string, string>) => ReactNode)`——其他插件注册自定义分组逻辑。sub-agent 插件注册一个 renderer：按 `parent_id` 分组，子agent 缩进在父会话下面，父会话可折叠。

timeline 需要暴露两层 hook（§7.3 详述）：

- `registerEntryRenderer(entryType: string, renderer: Component)`——自定义 entry 类型的渲染器
- 条件渲染 hook——根据 session header 条件替换输入框

#### 为什么这是最大的缺口

这不是"加一个 API 就行"的事。它改变的是插件的架构前提——从"插件是封闭组件，自己管自己的渲染"变成"host 插件是可扩展的渲染平台，extension 插件往上面挂钩子"。这个转变影响的不只是子agent——timeline 以后可能要支持自定义消息类型渲染（如未来某个插件贡献 markdown 渲染器），sessions-list 以后可能要支持自定义分组（如按项目分组、按标签分组）。这些场景都撞上同一堵墙。

当前 timeline 和 sessions-list 的代码是"自己读数据、自己 for 循环渲染所有 entry/session、不暴露任何扩展点"。要加 hook，意味着它们要在渲染管线的关键位置插入"查注册表"的分支，把"自己渲染"变成"先查有没有人注册了渲染器，有就用它，没有走默认"。这是架构形态的升级，不是 API 的增删。

但好消息是：这个模式在框架里已经有先例。壳组件（`Sidebar`、`RightPanel`、`SettingsPage`、`MainViewHost`）已经是"host + extension"模式——它们按槽位查注册表选渲染器，不自己渲染内容。timeline 和 sessions-list 只需要把这个模式从"槽位级"推广到"组件内部渲染分支级"——同一个设计原则的深化，不是发明新东西。

#### 临时方案与长期方案

如果不想一步到位做通用的 inter-plugin 扩展机制，可以先在 timeline 和 sessions-list 里各加一个硬编码的 hook（临时方案）：

- timeline 加一个 `registerEntryRenderer` + 一个 `shouldHideInput` 回调，硬编码在 timeline 自己的代码里
- sessions-list 加一个 `registerSessionFilter` + 分组逻辑 hook

这些 hook 不需要进 `@pi-desktop/react` 的公共 API，只是 timeline 和 sessions-list 自己暴露的扩展点。等有了更多场景（第二个插件也需要注册 entry 渲染器），再抽象成通用机制。

这样做的好处是改动量可控——先让子agent 能落地，再逐步抽象。坏处是每个 host 插件各搞一套，没有统一的注册模式。这是"先跑通再优化"的实用路线。

### 7.3 缺口二+三：timeline 不暴露 hook（中缺口）

缺口一的结构性问题，落到 timeline 上就是两个具体的 hook 缺失。timeline 当前是一个"封闭胖组件"——它自己读 session 文件、自己解析 entry、自己按 `entry.type` 渲染所有消息类型（消息气泡、思考块、工具调用、分隔线），不暴露任何扩展点。sub-agent 插件需要往它的渲染管线里注入两种东西：

**hook 一：`registerEntryRenderer(entryType: string, renderer: Component)`**

timeline 渲染 entry 时，当前是"按 `entry.type` 自己 switch"——遇到已知类型自己画，遇到未知类型跳过或显示 raw JSON。sub-agent 插件需要注册一个 `custom/subagent_spawned` 类型的渲染器，让 timeline 遇到这种 entry 时用它画的 spawn 卡片。

这个 hook 的形状和框架已有的 `registerSettingsComponent`、`registerSidePanelComponent` 是同一套模式——按名注册、按名查。timeline 渲染 entry 时，先查注册表有没有匹配的 renderer，有就用它，没有走默认渲染。区别只是：已有的注册函数注册的是"槽位级组件"（整个配置页、整个 Tab），`registerEntryRenderer` 注册的是"entry 级组件"（会话流里的一条消息）。

补了之后，timeline 的 entry 渲染管线从：

```
entry.type === "message" → 自己画消息气泡
entry.type === "tool_call" → 自己画工具调用
entry.type === "thinking" → 自己画思考块
其余 → 跳过
```

变成：

```
entry.type === "message" → 自己画消息气泡
entry.type === "tool_call" → 自己画工具调用
entry.type === "thinking" → 自己画思考块
entry.type === "custom" → 查 registerEntryRenderer(custom.sub_type)，有就用它，没有走默认
其余 → 跳过
```

多了一个"查注册表"的分支，不是把整个渲染管线推倒重来。

**hook 二：条件渲染 hook（灰色输入框）**

timeline 渲染子agent 的会话视图时，需要把输入框换为灰色只读。但 timeline 当前不检查 session header 的 `custom.parent_id`——它对所有会话都画一样的可输入输入框。sub-agent 插件需要让 timeline "检测到 `parent_id` 时隐藏输入框"。

两个方向：

- `shouldHideInput(sessionHeader) => boolean`——timeline 渲染输入框前调这个 hook，返回 true 就显示只读提示条、不显示输入框。简单直接，但每个条件渲染需求都要加一个专门 hook。

- `renderInputArea(sessionHeader) => Component | null`——更通用的方向：timeline 把输入框区域的渲染完全委托给注册的渲染器，返回 null 就用 timeline 默认的输入框。一个 hook 覆盖所有"输入框区域要条件渲染"的场景。但 timeline 以后可能有其他需要条件渲染的区域（如标题栏、底部状态栏），每个区域都搞一个渲染委托又太碎。

推荐第一个方向（`shouldHideInput`）——子agent 的需求就是"有 parent_id 就隐藏输入框"，不涉及自定义输入框内容。以后有更复杂的需求再升级。简单 hook 先跑通，不要预设计。

#### timeline 的架构转变

加了这两个 hook 后，timeline 从"封闭渲染"变成"host + extension"模式。这个转变不是推倒重来——timeline 的核心渲染管线（读 session 文件、解析 entry、按类型渲染）不变，只是多了两个"查注册表"的分支。注册表就是 `Map`，和已有的 `registerSettingsComponent` 是同一套实现模式。

但架构心态要变：timeline 不再是"我画所有东西"，而是"我画默认的东西，别人可以注册覆盖特定类型的渲染"。这和壳组件（`MainViewHost`、`Sidebar`、`RightPanel`）已经是的模式一致——壳按槽位查注册表选渲染器，不自己渲染内容。timeline 只是把"槽位级"推广到"entry 级"。

改动量中等——两个 hook 加在 timeline 插件内部，不影响框架其他部分。但 timeline 的架构要从"封闭渲染"改成"host + extension"模式。

### 7.4 缺口四：desktop→pi 主动推送缺失（小缺口）

sub-agent 运行期间，子agent 的事件经 desktop 路由到父agent pi 的 stdin。transport 层不是问题——`handle.stdin.write()` 本身能用（`sendExtensionUIResponse` 就是直接写 stdin）。缺的是一个 IPC 让 plugin 说"往这个 session 的 pi stdin 写一行 custom JSON"。

当前 desktop→pi 的 stdin 只有两条路：command（`session-store.send()`，发 prompt/abort 等）和 `extension_ui_response`（配对 extension_ui_request 的 id）。没有"desktop 主动 push 任意 custom 数据到 pi stdin"的通用机制。

补法：加一个 `sessions.pushCustomMessage(sessionPath, message)` IPC。plugin 调它把 `desktop_event` 推给父agent 的 pi。rpc-adapter 不需要改（它不管 stdin 写入，那是 session-store/插件的事），只是多一个 IPC handler。

改动量小——一个 IPC handler + 一个 preload 暴露。但它是通信层的缺口，没有它整个进度推送链路断在"desktop 收到子agent 事件但推不出去"这一步。

### 7.5 缺口五：HeaderPatch 缺 custom 字段（极小缺口）

plugin 用 `window.pi.sessions.start(cwd, sessionPath)` 起一个 pi 进程，然后用 `window.pi.sessions.updateHeader(sessionPath, patch)` 设 tool 配置和 parent 关系。但 `HeaderPatch` 只有 `name`、`pinned`、`archived`、`toolConfig`——**没有 `custom` 字段**。plugin 没法通过 `updateHeader` 往 session header 写 `custom.parent_id` 等子agent 标记。

补法：domain 层的 `HeaderPatch` 加 `custom?: Record<string, unknown>`。`session-scanner` 解析 header 时透传 `custom` 字段到 `SessionInfo`。两处改动，都是加一个可选字段，不影响现有逻辑。

这是 5 个缺口里最小的——一个类型定义加一个字段。

### 7.6 缺口六：缺 appendJsonlLine 操作原语（小缺口）

extension 需要往 session 文件追加 `type: "custom"` 的 entry。session 文件在 `~/.pi/agent/sessions/` 下——`~/.pi/agent/` 在 `configFile` 路径白名单内（`resolveConfigFilePath` 检查 `PI_AGENT_DIR` 前缀）。路径权限没问题。

但 `configFile.set` 写的是 JSON（`writeJsonFile`，整份覆盖或深合并），不是 JSONL 追加。session 文件是 JSONL——每行一个 JSON 对象，追加写不锁全文件。要追加一行 entry，需要的是 `appendJsonlLine(path, entry)` 而不是 `writeJsonFile(path, data, mergeMode)`。

补法：`config-file.ts` 已有 `readJsonFile` / `writeJsonFile` / `withDirLock`，加一个 `appendJsonlLine` 是同级别的原语。加完后暴露为 `configFile.append` IPC，plugin 就能往 session 文件追加 custom entry。

改动量小——一个操作原语 + 一个 IPC。和缺口四一样是"基础设施在，差最后一环"。

### 7.7 已具备的能力：四项框架已完整支持

不是所有接入点都有缺口。这四项框架已完整支持，sub-agent 插件直接用就行：

**槽位贡献——不需要改。** `registerSidePanelComponent`、`registerSidebarComponent`、`registerSettingsComponent` 都存在。壳组件（`Sidebar`、`RightPanel`、`SettingsPage`、`MainViewHost`）按槽位查注册表选渲染器，不自己渲染内容——这就是"host + extension"模式。sub-agent 插件可以贡献自己的 sidePanel（运行中的子agent 状态面板）和 settings（配置页：并发上限、超时、tool 预设），走标准槽位流程，和 git-review 贡献 Review Tab、pi-manager 贡献 Pi 管理页是同一套机制。

**插件配置管理——不需要改。** 插件在 `plugin.json` 声明 `configFile` + `contributes.settings`，框架自动管读/写/dirty/save/reset/拦截/刷新。sub-agent 插件的配置完全走这套：声明一个 `configFile` 指向 `~/.pi-desktop/plugins-data/sub-agent/config.json`，声明 `configMerge: "deep"`，框架就自动管起来了。插件只管渲染配置 UI 和调 `onChange` 报告改动——和所有其他 settings 插件一样。

**session 读写——部分可用。** `sessions.list`（列会话列表）、`sessions.openSession`（打开会话读全部消息）、`sessions.updateHeader`（改 session header）都在。sub-agent 插件用 `list` 拿会话列表（但需要缺口五补上 `custom` 字段才能知道哪个是子agent）、用 `openSession` 打开子agent 的 session 文件渲染完整 timeline 视图。`updateHeader` 能改 `toolConfig`（已有字段），但不能改 `custom`（缺口五）。`sessions.start` 能起 pi 进程，但不能传 `custom` 配置。

**pi 通信回路——最终结果能传回，缺的只是进度推送。** `extension_ui_request` / `extension_ui_response` 是完整的 pi→desktop request-response 通道。pi extension 发 spawn 请求（`extension_ui_request` 或 `custom/desktop_request`）、plugin 处理后回响应、最终结果传回——这条链路通。缺的只是进度流式推送（缺口四），那是"子agent 跑到一半的实时进度"——最终结果（`subagent_done`）可以作为 response 的内容传回，不需要主动 push。

这四项说明框架的"机制底座"是够的——加载器、槽位契约、配置管理、IPC 回路都在。缺的是"host 插件暴露扩展 hook"这一层——也就是插件之间的协作能力。这恰好是 §1.4 说的"子agent 不能自给自足，需要别的插件配合"的那个点：框架让你能挂上来（槽位），让你能配置（configFile），让你能通信（IPC 回路），但不让你改别的插件的渲染行为。

## 8. 落地路径：先补框架再写插件

### 8.1 第零阶段：补框架缺口

目标：让框架具备纯插件实现子agent 的能力。

- **缺口五（极小）**：`HeaderPatch` 加 `custom?: Record<string, unknown>` 字段；`SessionInfo` 加 `custom` 字段；`listSessions` 透传 header 的 `custom`。domain + application 各改一处。
- **缺口六（小）**：`config-file.ts` 加 `appendJsonlLine` 原语；preload 暴露 `configFile.append` IPC。
- **缺口四（小）**：electron-main 加 `sessions.pushCustomMessage` IPC handler；preload 暴露对应方法。
- **缺口二+三（中）**：timeline 插件暴露 `registerEntryRenderer` + 条件渲染 hook；`@pi-desktop/react` 导出注册函数。
- **缺口一（大）**：timeline 和 sessions-list 从"封闭渲染"升级为"host + extension"模式——timeline 暴露 `registerEntryRenderer` + `shouldHideInput`；sessions-list 暴露 `registerSessionFilter` + `registerSessionGroupRenderer`。临时方案：各 host 插件自己暴露 hook，不进 `@pi-desktop/react` 公共 API，等有更多场景再抽象成通用机制。

验收：一个测试插件能往 timeline 注册自定义 entry 渲染器并看到它生效；sessions-list 能根据 `custom.parent_id` 缩进显示；`configFile.append` 能往 JSONL 文件追加一行；`sessions.pushCustomMessage` 能把一行 JSON 写到 pi 的 stdin。

### 8.2 第一阶段：custom 协议 + 单层子agent 全链路

目标：agent 能 spawn 一个子agent，子agent 跑完结果回传，timeline 和左侧栏正确展示。

- pi extension：注册 `spawn_subagent` tool + 发/收 custom 消息 + 写 session entry
- plugin renderer：timeline 注册 `custom/subagent_spawned` entry 渲染器（spawn 卡片）+ 条件渲染灰色输入框；sessions-list 按缩进嵌套
- rpc-adapter：`handleLine` 加 `custom` 分支
- SubAgentStore（或复用 session-store 的多进程能力）：spawn + 事件路由 + 生命周期

验收：agent 在推理时调 spawn_subagent，desktop 起子agent pi 进程，子agent 跑完结果回传给 agent，父会话 timeline 显示 spawn 卡片，左侧栏子agent 缩进在父会话下，点卡片打开子agent 完整会话视图（灰色输入框）。

### 8.3 第二阶段：tool 配置化 + 多种调度模式

目标：通过 toolConfig 参数控制子agent 能力，实现并行 fan-out 和受限委托。

- spawn 参数加 `toolConfig`，desktop spawn 子agent 时注入
- extension 读取环境变量里的 toolConfig 传给 pi
- timeline 支持多张 spawn 卡片并行显示 + 批次折叠
- 并发上限和超时机制落地

验收：agent 能同时 spawn 多个子agent 并行跑；子agent 的 tool 集受限（如只读、无 bash）；超过并发上限被拒绝。

### 8.4 第三阶段：递归树 + 能力开放注册

目标：子agent 能再 spawn 孙agent（递归），第三方插件能贡献 desktop 能力。

- toolConfig 含 `spawn_subagent` group 的子agent 能再 spawn
- timeline 支持嵌套层级展示
- capability-registry 开放给插件注册
- 资源调度（递归深度限制、全局并发池）

验收：子agent spawn 孙agent，三层 pipeline 跑通；第三方插件注册了一个新 desktop 能力，agent 能调它。

## QA

**Q1：agent 没装 spawn_subagent extension，调 spawn_subagent 会怎样？**

agent 调不存在的 tool 会被 pi 的 tool 系统拒绝（tool 没注册，agent 不知道它存在）。agent 的推理过程中不会主动调一个不在 tool 列表里的 tool——pi 的 tool 系统只展示已注册的 tool 给 agent。所以没装 extension = agent 根本不知道 spawn_subagent 这个 tool 存在 = 不会尝试调它。不存在"调了但失败"的情况。

**Q2：desktop 没在跑（用户直接命令行用 pi），extension 怎么办？**

extension 启动时发一个 `desktop_request`（`method: "ping"`），1 秒内没收到 `desktop_response` 就认为没跑在 desktop 里。此时 extension 不注册 `spawn_subagent` tool——agent 看不到这个 tool，不会尝试调。extension 退化为静默无操作，不报错、不影响 pi 正常使用。

**Q3：子agent 跑到一半 pi-desktop 被关了怎么办？**

desktop 关闭时走 `app.on("before-quit")` → `sessionStore.stopAll()`。子agent 进程池也挂在这里——关闭时遍历所有子agent 进程调 `stop()`（stdin→SIGTERM→SIGKILL）。子agent 的 session 文件已经在磁盘上（pi 边跑边追加写 JSONL），不会被删。下次打开 pi-desktop，timeline 读 session 文件照常显示 spawn 卡片，点开能看子agent 的部分历史（跑到哪里算哪里）。但子agent 不会被自动恢复——它已经停了。

**Q4：两个子agent 的 session 文件在同一个 cwd 桶里，会冲突吗？**

不会。session 文件名用 UUID 生成（`randomUUID()`），不依赖 cwd。同一个 cwd 下可以有多个 session 文件，session-scanner 的 `listSessions` 按目录列全部。子agent 的 session 文件和父agent 的 session 文件在同一个桶里，靠 `custom.parent_id` 区分关系，不靠文件名。

**Q5：父agent 调 spawn_subagent 时，会阻塞到子agent 完成吗？**

会。spawn_subagent tool 的语义和 `bash` 一致——调了就等结果（见 §3.1）。tool 调用在子agent 完成（`desktop_event` / `subagent_done`）后才 resolve，结果作为 tool 返回值还给 agent。等待期间，子agent 的进度通过 `desktop_event`（`subagent_progress`）流式推送，作为 tool 的中间输出——agent 在等待 tool 返回值时能看到子agent 的实时进度，和看 bash stdout 是同一套机制。

如果 agent 需要并行跑多个子agent，在同一轮推理中多次调 spawn_subagent 即可——每个 tool 调用独立 pending，各自等各自的子agent 完成。父agent 的 pi 进程不被子agent 阻塞（进程独立），但 agent 的推理流程在等 tool 返回值——这是 tool 调用的正常行为，不是子agent 造成的额外阻塞。

**Q6：子agent 用了不同的 model 怎么配？**

spawn 参数里可以传 `model`（provider + modelId），desktop spawn 子agent 时在 pi 的启动参数里注入（`--model` 或环境变量），子agent 启动后用该 model。不传则继承父agent 的 model。这是 `SpawnOpts` 的一个参数，不是协议层的角色字段——和 `toolConfig` 一样是 spawn 的参数化。

**Q7：session header 没有 custom 字段的旧 session 文件，timeline 怎么处理？**

当普通会话处理。timeline 检查 `header.custom?.parent_id`——`undefined` 就是没有 parent 的顶层会话，正常渲染、输入框可输入。旧 session 文件完全兼容，不需要迁移。这是"内容驱动"的好处：有 `parent_id` 就渲染子agent 样式，没有就渲染普通样式，不靠 version 字段 switch。

**Q8：capability-registry 里注册的能力和 `window.pi` 上的 IPC 能力是什么关系？**

不同层、不同消费者。`window.pi` 上的 IPC（`config.get`、`fs.listDir`、`git.status` 等）是 **renderer 插件** 调 desktop 的通道——消费者是 React 组件。`capability-registry` 是 **pi 进程**（agent）调 desktop 的通道——消费者是 pi extension 经 custom 协议。两套能力各自注册、各自分发，不共用 registry。后续如果出现"同一个能力既要给插件用又要给 agent 用"的情况，可以在两个 registry 各注册一份、共享底层实现——但这是优化不是架构约束，现阶段不预设计。

**Q9：extension 写 session 文件的机制是什么？desktop 能写吗？**

能。`~/.pi/agent/` 在 `configFile` 路径白名单内（`resolveConfigFilePath` 检查 `PI_AGENT_DIR` 前缀）。desktop 有写权限。但当前框架只有 `configFile.set`（写 JSON，整份覆盖或深合并），没有"往 JSONL 文件追加一行"的操作原语。session 文件是 JSONL——每行一个 JSON 对象，要追加一条 entry 需要的是 `appendJsonlLine(path, entry)` 而不是 `writeJsonFile(path, data, mergeMode)`。

补法：`config-file.ts` 加一个 `appendJsonlLine` 原语，暴露为 `configFile.append` IPC。extension（或 plugin renderer）经这个 IPC 请求 desktop 追加。这是框架缺口六（§7.6），补了就能写。

**Q10：`desktop_event`（`subagent_progress`）会不会比 `desktop_response` 先到达？**

理论上是可能的——如果子agent 启动极快、在 desktop 写 response 到父agent stdin 的同时已经产生事件。§5.3 的 `pendingEvents` 队列是防御性设计：即使这种情况发生，extension 也能正确处理（暂存 event、等 response 到后再 flush）。§3.1 的时序图画的是正常路径（response 先于 event），不代表协议保证严格有序——实际取决于事件路由和 stdin 写入的时序，两者是独立的异步操作。

**Q11：父agent 的 pi 进程崩溃后，desktop 往已死的 stdin 写 `desktop_event` 会报错吗？**

不会立即报错——管道缓冲区会吸收写入，`stdin.write()` 返回 true。但数据永远不会被消费（父进程已死）。desktop 通过 `RpcAdapter.onProcessExit` 感知父退出后设置"已死"标记，后续路由逻辑检查这个标记、跳过写入。在 `onProcessExit` 触发之前的时间窗口里，可能有少量 event 被写入死管道——这些 event 会丢失，但不影响正确性（父进程已死，没人消费它们）。

**Q12：父进程崩溃清理时，谁往子agent session 文件写 `subagent_aborted` 记录？**

§3.4 说孤儿清理时"在子agent session 文件里记一条 `subagent_aborted`"。但 session 文件正常由 pi 进程写——子agent 被 `stop()` 强杀后来不及自己写。这种情况下 desktop 直接追加写 JSONL 文件——这是一个例外：正常路径 session 文件只由 pi 写，崩溃清理路径 desktop 写。desktop 只追加一行、不修改已有行，原子追加写 JSONL 在文件系统层面是安全的（`appendFileSync`）。如果 desktop 写入时子agent 恰好也在写（竞态），最坏情况是两行交叉损坏——但子agent 已被 SIGTERM/SIGKILL，不会再写，所以实际不会发生。

**Q13：spawn 被拒绝（`status=rejected`）时 extension 怎么处理？**

extension 收到 `desktop_response` 的 `status=rejected` 后直接 reject tool 调用——tool 返回一个错误给 agent（如"子agent 并发上限已达，spawn 被拒绝"）。agent 拿到错误后自行决策：等一会重试、换一种方案、或放弃。不写 spawn entry（子agent 没起来，没有东西可记）。两级映射的第一级 `pendingRequests` 里的 entry 直接 reject + 删除，不迁移到第二级。

**Q14：spawn 失败（进程起不来）时 desktop 发什么？**

desktop 回 `desktop_response` 带 `status=error, reason=spawn_failed`（附错误信息）。extension 收到后同样直接 reject tool 调用。agent 拿到错误信息后决策。不写 spawn entry。状态机里对应 `spawning → error` 转移。

**Q15：用户能不能从子agent 会话视图的 UI 上 abort 子agent？**

可以——灰色输入框区域可以放一个"中止"按钮，点击后经 `window.pi` 的 IPC 到 main 进程调 `SubAgentStore.abort(subagentId)`。这走的是和"父agent 程序化 abort"同一条路径，只是触发方从"父agent 的 extension 发 custom 请求"变成"用户点按钮经 IPC"。具体 UI 设计（按钮放哪、长什么样）是 timeline 插件的实现细节，不在本文设计范围。

**Q16：为什么要求纯插件实现？改内核不行吗？**

子agent 这个功能同时触及了左侧栏、会话流、配置、pi 通信全部接入点——它是框架的终极压力测试。如果需要改内核才能实现，说明内核不够薄——"机制与内容分离"这条纪律就没守住。子agent 是内容（一种具体功能），它应该全部走插件机制。如果机制不够用，补机制（§8.1 第零阶段），而不是把功能焊死在内核里。

这不是教条——VSCode 的语言支持、调试器、主题全是扩展，不是硬编码在内核里。pi-desktop 要走同样的路：内核只管机制，功能全部外挂。子agent 是验证这条路能不能走通的最佳试金石。

**Q17：框架缺口的修复顺序是什么？为什么？**

先 transport 层（缺口四、六），再展示层（缺口二+三），最后 domain 层（缺口五），最后最大的（缺口一）。理由是依赖链：

- 缺口四（push IPC）和缺口六（appendJsonlLine）是通信和持久化的基础——没有它们，子agent 的进度推不出去、spawn entry 落不了盘。后面什么都做不了。
- 缺口二+三（timeline hook）依赖于通信层通了之后才能验证渲染效果——空有 hook 但没有 custom 消息流进来，测不了。
- 缺口五（HeaderPatch 加字段）可以和缺口四、六并行——它们之间没有依赖。
- 缺口一（inter-plugin 扩展机制）最大、最复杂，放最后。它影响的不只子agent，是整个插件体系的结构性升级。可以先在 timeline 和 sessions-list 里各加一个 hook 作为临时方案（等于缺口二+三），等有更多场景验证后再抽象成通用机制。
