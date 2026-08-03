# 会话流架构设计

> **术语约定**：本文档涉及几个核心概念，先一次性交代：
>
> - **pi 底座**：一个独立的 AI coding agent 进程，可执行 CLI，通过 stdin/stdout 收发 JSON Lines 消息。pi-desktop 是包裹它的桌面壳——pi 是被管理的子进程，不是插件、不是库。用户和 pi 对话，pi 经 stdout 推事件流，桌面端消费事件流并渲染 UI。
> - **Composer**：消息输入区组件——用户在这里打字、选模型/思考强度、按发送。位于 timeline 底部，ChatGPT 式的药丸输入框。
> - **steer**：pi 生成中途插入转向消息。用户在 pi 正在回复时发一条新消息，这条消息不排队等待，而是立即插入当前生成流（steer 模式）或排队等下一轮（follow_up 模式）。`steeringMode`/`followUpMode` 控制排队行为（`all` = 全部排队、`one-at-a-time` = 只保留最新一条）。
> - **cwd**：当前工作目录。既是一个文件系统路径，也是会话的分组键——会话按 cwd 分桶存储在 `~/.pi/agent/sessions/<桶名>/` 下。
> - **zustand**：React 状态管理库，本项目的 renderer 侧单一真相源。store 是模块级单例，组件只读 store、永不各自拉数据。
> - **§1 描述的是当前代码的结构性缺陷（现状），§2 起描述的是重设计方案（目标态）。** §1 的"漏了""没处理"指当前代码的问题，§4.4 的 `patchStateFromEvent` 完整覆盖表是重设计后的目标态。

## 1. 问题诊断：一个通用模式怎么会写残

### 1.1 会话流的本质：事件溯源 + 状态投影

会话流不是什么新东西。打开任何一个聊天应用——ChatGPT、Cursor、Slack——底层数据模型都是同一套：事件溯源 + 状态投影。会话文件（JSONL）是事件存储，每行一条事件，追加写、流式读。UI 上的消息列表是投影——把事件流折叠成用户能看懂的对话视图。pi 进程是事件源，它产出事件、写进文件、同时经 stdout 推给桌面端。renderer store（zustand）是读模型，订阅事件流、增量应用、驱动 React 重渲染。

这套模式被解决了几千遍。EventStoreDB 的文档里讲的就是这件事，CQRS 的读模型分离讲的就是这件事，React 的单向数据流讲的就是这件事。pi-desktop 的会话流在概念上没有做错——JSONL 事件存储、事件增量应用、快照基线 + 增量——方向都对。问题出在执行：投影写了一半，状态同步靠运气，事件覆盖看心情。

严格说，pi-desktop 不是纯事件溯源——纯事件溯源靠重放事件重建状态，pi-desktop 的状态权威在 pi 进程内存里，resync 是 RPC 拉取 pi 的内存状态而非重放 JSONL 文件。JSONL 文件是持久化层（冷启动读、跨重启恢复），pi 进程是运行时权威（热路径事件源 + RPC 状态源）。这种混合模型的设计意图是兼顾两者：冷启动不依赖 pi 进程（秒开文件读），热路径不依赖文件重放（pi 内存里就是最新状态）。代价是两套数据源可能短暂不一致——pi 内存写了但 JSONL 还没刷盘——但这个窗口极小，且 resync 总是拉 pi 内存状态（权威），文件只在 pi 没跑时用。

### 1.2 五个结构性缺陷

- **延迟对齐**。用户在下拉框选了 GPT-4o，`pickModel` 只调 `setCurrentModelId`——写 ui-store 偏好 + 落盘 electron-store，不调 `pi.sessions.setModel`。真正的切模型被塞进 `send()` 函数里，等用户按发送键才执行。结果是：用户选了模型，UI 显示新模型名（偏好优先显示），pi 实际跑的还是旧模型，看不到 modelChange 事件，看不到任何反馈。这个设计最初的理由是"避免选个模型就 spawn 一个 pi 进程"——理由成立，但解法错了：应该是"pi 没跑时只记偏好，pi 在跑时立即发命令"，而不是"不管 pi 在不在跑，都等发送时才发命令"。

- **状态投影不完整**。`packages/react/src/session-store.ts` 的 `onEvent` 回调里，对 `snapshot.state` 的增量更新只处理了 `modelSelect` 一种事件。`thinkingLevelChanged`、`thinkingLevelSelect`、`compactionStart`、`compactionEnd`、`sessionStart`、`sessionInfoChanged`、`queueUpdate`——七种直接影响 `SessionState` 的事件全部漏了。这意味着即使 pi 推了事件，renderer 的 snapshot 也不更新。用户改了思考强度，必须重新加载会话才能看到——因为只有 `resync` 全量拉取才能刷新 snapshot，事件增量被丢了。

- **依赖事件回传**。`setModel` 之后，代码依赖 pi 推 `modelSelect` 事件来更新 snapshot。但 pi 的协议不保证推事件——它可能推，可能不推，可能延迟推。把状态同步的可靠性赌在"对方一定会推事件"上，是双重不可靠的第一重：事件可能不来。即使来了，上一条缺陷说了——handler 不处理，是第二重不可靠：事件来了也没用。两条不可靠叠在一起，用户看到的就是"改了模型什么都没发生"。

- **streaming 双源**。流式状态被存在两个地方：`useSessionStore.streaming`（store 级别，由 `agentStart`/`agentSettled` 事件设置）和 `snapshot.state.isStreaming`（快照级别，resync 时拉到，当前代码事件来时从不更新）。这两个值可以不一致：store 说 `streaming = true`，snapshot 说 `isStreaming = false`。`timeline/renderer/index.tsx` 的 `MessageRow` 里 `isStreaming` 判断混用了两个来源（`message.pending === true || streaming`），行为不可预测。重设计后 `patchStateFromEvent` 会让 `agentStart`/`agentSettled` 同时更新 `snapshot.state.isStreaming`，两个来源同步变化——store 级 `streaming` 保留给全局 UI（如 Composer 发送/停止按钮切换），`snapshot.state.isStreaming` 保留给状态展示（如统计行），`message.pending` 保留给单条消息的流式光标。三者各管一摊，不再混用。

- **事件类型覆盖不全**。22 种事件类型定义在 `domain/events/session-state.ts`，但 `timeline/renderer/index.tsx` 的 `onEvent` 只对 3 种做了 UI 响应——`messageEnd`/`agentSettled`/`agentEnd` 刷新统计，`messageStart`/`messageUpdate` 触发滚动。`turnStart`/`turnEnd`、`autoRetryStart`/`autoRetryEnd`、`queueUpdate`、`compactionStart`/`compactionEnd`——这些事件有类型定义、有翻译映射、从 pi 推过来了，但到了 renderer 层没有可见的 UI 响应。注意这里说的"没有 UI 响应"是指没有可见的 UI 指示器（如"正在重试""队列中有 2 条待发""正在压缩上下文"），不是说事件完全没被处理——`compactionEnd` 当前会触发 `sync()` 重拉基线，`compactionStart`/`compactionEnd` 在重设计后也会更新 `isCompacting` 状态字段。但"更新了一个 boolean"和"用户看到了压缩指示器"是两回事——状态更新是隐式的（React 重渲染但如果没有组件消费这个字段，用户什么也看不到），UI 响应是显式的（有专门的组件渲染指示器）。当前缺的是后者。

### 1.3 根因：投影不完整 + 双重不可靠

五个缺陷不是五个独立的 bug，是同一个根因的五种表现：renderer 的 `onEvent` 是事后补丁，不是系统设计。

写 `onEvent` 的时候，开发者脑子里想的是"pi 推了 messageUpdate 我就 patch 消息"，没有想到"pi 推了 thinkingLevelChanged 我也要 patch 状态"。`applyEvent` 处理消息流（messages 数组）写得相对完整——messageStart/messageUpdate/messageEnd/entryAppended 都有处理；但状态投影（snapshot.state）只写了一个 `modelSelect` 的 if 分支。这不是"漏了几个 if"，是缺少一个系统性的映射："每种事件 → 它影响 state 的哪个字段 → 它触发什么 UI 响应"。

第二个根因是状态同步策略的单一路径。代码只靠事件推送来同步状态，没有"命令 resolve 后主动拉取"的校正机制。事件推送是"尽力而为"——pi 可能推也可能不推，可能延迟推。把状态同步的可靠性全押在事件上，就是赌对方一定会推。正确的做法是双通道：事件增量做实时（可能延迟、可能丢失），命令 resolve 后 sync 做校正（确定性的、拉到的是 pi 的权威状态）。两条路径互补，不互相依赖。

## 2. 架构重设计：事件溯源 + 状态投影

### 2.1 三类状态与各自的生命周期

会话流涉及三类状态，混在一起是所有混乱的起点。分开后，每类状态有自己的来源、自己的更新方式、自己的消费者。

- **UI 偏好状态**（`ui-store`）。`currentModelId`、`currentThinkingLevel` 这些字段，代表用户"想用"什么，不是 pi"正在用"什么。来源是用户选择（pickModel/pickLevel），持久化到 electron-store，跨重启保持。消费者是 Composer 下拉框的显示逻辑——偏好优先于 snapshot 显示。生命周期独立于 pi 进程：pi 没跑时偏好也存在，pi 跑起来时偏好用来对齐。这类状态不需要实时同步——它就是用户的意图，pi 的实际状态是另一回事。

- **会话投影状态**（`session-store.snapshot`）。`SessionState` 的全部字段——`model`、`thinkingLevel`、`isStreaming`、`isCompacting`、`steeringMode`、`followUpMode`、`sessionFile`、`sessionId`、`sessionName`、`autoCompactionEnabled`、`messageCount`、`pendingMessageCount`。代表 pi"正在用"什么。来源有两个：resync 全量拉取（基线）和事件增量 patch（实时更新）。消费者是所有需要知道 pi 当前状态的 UI——Composer 的模型/思考强度显示、统计行、压缩指示器。生命周期绑定于 pi 进程：pi 启动后 resync 产生基线，pi 停止后基线清空。

- **消息流状态**（`session-store.messages`）。`NeutralMessage[]`，代表对话内容。来源有三个：文件读（冷启动）、resync 基线（热启动）、事件增量 patch（实时）。消费者是 timeline 的 `MessageRow` 渲染。生命周期跨 pi 进程——文件读不依赖 pi，即使 pi 没跑也能显示历史消息。

三者的关系是"偏好 → 命令 → 投影"。用户选模型（偏好）→ pickModel 发 setModel 命令（命令）→ pi 切完推 modelSelect 事件 + 命令 resolve 后 sync（投影）。偏好是因，投影是果，命令是中间桥梁。把它们混在一起（比如用 ui 偏好直接当 pi 状态显示）就是延迟对齐缺陷的根源。

### 2.2 三条通信路径：命令提交 / 事件推送 / 主动拉取

会话流在 renderer 和 pi 之间有三条通信路径，各自有不同的语义和可靠性保证。

- **命令提交**（renderer → pi）。`pickModel` → `pi.sessions.setModel` → `adapter.send(buildSetModelCommand)` → 写入 pi stdin（JSONL 一行）。这条路径是同步的：`adapter.send` 返回 Promise，resolve 意味着 pi 处理完了这条命令。可靠性由 `RequestCorrelator` 保证——id 配对 + 30s 超时 + 进程退出时 rejectAll。这条路径适合"我确定要让 pi 做某事"的场景——切模型、切思考强度、发消息、压缩上下文。

- **事件推送**（pi → renderer）。pi stdout → JSONL reader（`attachJsonlLineReader`）→ `handleLine`（解析 JSON、分类：response/event/extension_ui）→ `translateEvent`（snake_case → camelCase）→ `dispatch`（路由 + TPS 自算）→ IPC `onEvent` → `patchStateFromEvent` + `applyEvent`。这条路径是尽力而为的：pi 决定推什么、什么时候推、推不推。renderer 是被动接收方。这条路径适合"pi 状态变了我想实时知道"的场景——消息流式更新、工具调用进度、压缩开始/结束。

- **主动拉取**（renderer → pi → renderer）。`pi.sessions.sync()` → `resync(adapter)` → 4 个 RPC 并发（`get_state` + `get_entries` + `get_tree` + `get_commands`）→ 组装 `SyncSnapshot` → `onSnapshot` 广播 → store 替换基线。这条路径是确定性的：拉到的是 pi 的权威状态，不依赖事件是否推过来。适合"我需要确保状态准确"的场景——命令 resolve 后校正、压缩后重拉、显式刷新。

三条路径不是备选关系，是互补关系。事件推送做实时（快但不保证完整），命令提交做控制（确定但只管发不管收），主动拉取做校正（确定且完整但慢）。一个好的会话流设计同时用三条路径，各管一摊：

```
用户选模型
  → ui-store 记偏好（UI 偏好路径）
  → setModel 命令发到 pi（命令提交路径）
  → 命令 resolve 后 sync 拉基线（主动拉取路径）
  → pi 可能也推 modelSelect 事件（事件推送路径，补充）
  → 两条路径都能更新 snapshot.state.model
```

### 2.3 状态同步策略：事件增量 + 命令后 sync 校正

状态同步的核心策略是"双通道互补"。

**事件增量通道**——`patchStateFromEvent` 纯函数处理所有影响 `SessionState` 的事件，实时更新 `snapshot.state`。这个通道是实时的（事件来了立刻 patch），但不保证完整（pi 可能不推某些事件）。`applyEvent` 同理处理消息流——messageUpdate/messageEnd 按 id 精确 patch（find-by-id + merge），messageStart 靠文本匹配替换乐观回显 + 位置判断替换 assistant 占位（乐观回显的临时 UUID 和 pi 的 entryId 不匹配，无法按 id）。两个纯函数并排，各自管一块：`patchStateFromEvent` 管 state，`applyEvent` 管 messages。

**命令后 sync 校正通道**——`pickModel` 调 `setModel`，命令 resolve 后立刻调 `sync()` 拉一次基线。这条通道是确定性的（RPC resolve = pi 处理完了），拉到的是权威状态。它不依赖事件是否推过来——即使 pi 不推 `modelSelect` 事件，sync 也能拿到最新的 `state.model`。

两条通道不互相依赖。事件增量先到（快），sync 校正后到（准）。如果事件没来，sync 校正仍能更新状态。如果 sync 失败（网络问题、进程刚退出），事件增量仍提供了实时更新。只有两条通道都失败，状态才不更新——而这时候 pi 本身也有问题了。

第三条兜底通道是 `send()` 里的偏好对齐。当 pi 首次启动时（`ensureForSend` spawn 了新进程），之前用户选的所有偏好都没提交给 pi。`send()` 在发 prompt 之前，先比较偏好和 pi 实际状态，不一致就 setModel/setThinkingLevel。这是"pi 没跑时只记偏好"的兜底——pi 起来后一次性同步所有偏好，然后发消息。

## 3. 冷启动路径：文件读

### 3.1 JSONL 格式与条目三层映射

会话文件是 JSONL——每行一个 JSON 对象，追加写、流式按行读。第一行是头行（`{type:"session", id, timestamp, cwd, name?, pinned?, archived?}`），其余行是条目。pi 底座写入的条目类型有十几种，`sessionEntryToNeutral`（`domain/events/session-state.ts:217`）把它们映射成 `NeutralMessage`，分三层：

- **内容层**——`message` 和 `custom_message`（`display !== false`）原样进。`message` 条目拆出内嵌的 `AgentMessage`（role + content），直接作为 `NeutralMessage` 返回。`custom_message` 条目根据 `customType` 字段决定 role，`content` 原样透传。这些是时间线上真正显示的消息——用户说的话、assistant 的回复、工具执行结果。

- **分隔层**——`model_change`、`thinking_level_change`、`compaction`、`branch_summary`、`session_info`、`label` 这些条目不显示为消息，而是映射成 `role: "divider"` 的分隔线条目。每条分隔线带 `kind`（model/thinking/compaction/branch/info/label）、`i18nKey`（翻译 key）、`i18nArgs`（翻译参数），渲染层按 kind 选图标、按 i18nKey 调 `t()` 翻译。圆心只产中性结构（key + args），文案由渲染层查 i18n——这是"圆心不内嵌内容"纪律的体现。

- **隐藏层**——`custom`（扩展私有状态，如 plan-mode-state 动辄上百条）和 `session`（文件头行）返回 `null`，不进时间线。`custom_message` 且 `display === false` 也返回 `null`。这些条目存在于文件里但不在 UI 上显示——它们是 pi 的内部状态，不是对话内容。

三层映射是纯函数，文件读（`readSession`）和事件流（`entryAppended` 事件）共用同一条路径——不管是从文件读出来的条目还是从事件流收到的条目，都走 `sessionEntryToNeutral`，保证一致。

### 3.2 去重策略：标准角色相邻去重 + 非标准角色全量去重

pi 底座有时会重复写入相同条目——同一条 `custom_message` 注入两次，同一条 `model_change` 写两遍。`deduplicateAdjacent`（`domain/events/session-state.ts:306`）做两层去重：

- **标准角色**（user/assistant/toolResult/divider）只做相邻去重——如果前一条消息和当前消息 role 相同、content 相同，跳过。不做全量去重，因为用户可以合法地连续发送相同内容（"继续""继续"），全量去重会误删。

- **非标准角色**（即不在标准角色集合里的所有 role）做全量去重——维护一个 `Set<role::contentKey>`，整个消息列表里重复的只保留第一条。底座在同一会话中多次注入相同上下文（非相邻也属冗余），全量去重能滤掉。标准/非标准的判定靠一个硬编码的 `STANDARD_ROLES = new Set(["user", "assistant", "toolResult", "divider"])`（`domain/events/session-state.ts:298`）——role 在集合里的是标准角色，不在的是非标准角色。`custom_message` 衍生角色（bashExecution、multi-agent-dashboard、loop-planning 等）都走非标准全量去重。

去重在两个地方调用：`readSession`（文件读后）和 `resync`（RPC 拉取后）。事件流增量路径（`applyEvent`）不调去重——增量 patch 是按 id 精确定位的，不会产生重复。`entryAppended` 事件处理时有一个相邻去重检查（比较最后一条消息的 role 和 content），防止底座重复追加。

### 3.3 会话扫描与列表

`session-scanner.ts` 负责文件系统层面的会话管理。

**目录结构**。会话文件按 cwd 分桶存放——目录名是 `--<cwd 去掉首斜杠、斜杠换横线>--`。例如 `/Users/user/project` 的桶名是 `--Users-user-project--`。桶目录在 `~/.pi/agent/sessions/` 下。`cwdToBucketName` 是纯函数，文件读和生成新会话路径共用。

**列表扫描**。`listSessions` 扫某 cwd 桶下的所有 `.jsonl` 文件，读第一行解析头行，提取 `id`/`name`/`pinned`/`archived`/`created`/`modified`/`lastMessage`。排序键是"最后一条数据的时间戳"（`lastEntryTime`，倒序找第一个带 timestamp 的行），不是文件 mtime——重命名改写文件会刷 mtime，按 mtime 排会把改名的顶到最上。

**最近设置提取**。`recentSessionSettings` 扫最近会话（mtime 最大），倒序找最后的 `model_change` 和 `thinking_level_change` 条目。这是 pi 没启动时的默认值兜底——用户上次用的模型和思考强度，从会话文件里反推。`extractRecentSettings` 是纯函数，倒序遍历、找到就停。

**头行改写**。`updateSessionHeader` 改写 JSONL 第一行的可选字段（name/pinned/archived/toolConfig），其余行原样保留。写操作在 `withDirLock` 锁保护下进行——同一把锁，一处写头。`renameSession` 是 `updateSessionHeader` 的特例（只改 name 字段）。

## 4. 热路径：事件流

### 4.1 数据流链路：pi stdout → renderer store

热路径是 pi 运行时的实时事件流，从 pi 的 stdout 到 renderer 的 store，完整链路如下：

```
pi 进程 stdout
  → attachJsonlLineReader（LF-only 分帧，不用 readline）
  → handleLine（JSON.parse → 分类）
    → extension_ui_request → 60s 超时计时器 + extUiListeners
    → response（带 id）→ correlator.resolve（配对 Promise）
    → extension_ui_response → 忽略（桌面端发给底座的回声）
    → 其余 → eventListeners（转发为 AgentSessionEvent）
  → translateEvent（snake_case → camelCase，TYPE_MAP 映射）
  → SessionStore.dispatch（路由 + TPS 自算）
    → 流式增量只转发激活会话
    → 定稿/轮结束/新文件事件全转发（列表刷新需要）
  → IPC onEvent → renderer
  → patchStateFromEvent（state 增量 patch）
  → applyEvent（messages 增量 patch）
  → zustand setState → React 重渲染
```

链路上每个环节各管一件事：JSONL reader 管分帧，`handleLine` 管分类，`translateEvent` 管命名转换，`dispatch` 管路由，`patchStateFromEvent`/`applyEvent` 管投影。没有一环做两件事，也没有一件事被两个环节重复处理。

`handleLine` 的分类有四条路：`extension_ui_request` 是 pi 底座的 Extension UI 请求——pi 里的扩展（如文件选择器、确认对话框）需要和用户交互时，经 stdout 发一个请求给桌面端，桌面端弹出 UI、用户操作后经 stdin 回一个 `extension_ui_response`。60s 超时是防止扩展请求挂死——超时自动回复 `cancelled: true`。`response` 带 id，走 correlator 配对（命令提交路径的返回值）。`extension_ui_response` 是桌面端发给 pi 的回声，在 stdout 上看到时忽略。其余行当 event 转发。

`dispatch` 的路由逻辑值得展开。流式增量事件（`messageUpdate`、`messageStart` 等）只转发激活会话——非激活会话的流式增量不干扰当前视图。但定稿事件（`messageEnd`）、轮结束事件（`agentSettled`/`agentEnd`）、新文件事件（`sessionStart`）全转发——因为会话列表需要这些事件刷新（新消息来了列表要更新 modified 时间，消息数要变）。路由判断在 `dispatch` 里，不在 IPC 层——IPC 层只管透传。

`dispatch` 同时做 TPS 自算（TPS = tokens per second，每秒输出 token 数，衡量生成速度）：`messageStart` 记录开始时间（`genStartMs`），`messageEnd` 时用 output tokens / 耗时算 TPS。底座不给 TPS，桌面端自己从事件流推算。output tokens 从 `messageEnd.message` 的 `usage`/`tokenUsage`/`tokens` 字段防御性提取（字段名未文档化，多路径兜底）。

### 4.2 事件翻译：snake_case → camelCase

`event-translator.ts` 的 `translateEvent` 做的事很朴素：把 pi 的 snake_case 事件 type（`tool_execution_start`）翻译成圆心的 camelCase（`toolCallStart`）。翻译靠一张静态映射表 `TYPE_MAP`，22 种事件类型一一对应。

翻译后的事件 type 用中性名，其余字段原样保留（pi 已经用 camelCase 命名字段）。未识别的 type 原样透传——这保证了 pi 新增事件类型时，即使翻译表没更新，事件也不会丢，只是 type 名还是 pi 的原始 snake_case。

翻译是协议层的职责，不是 UI 层的。`translateEvent` 在 gateway 层，把 pi 的协议事件翻译成圆心的中性事件。renderer 拿到的永远是中性事件，不感知 pi 的协议细节。换底座时只改 `translateEvent` 的映射表，renderer 一行不动。

### 4.3 消息增量 patch：按 id 精确定位

`applyEvent`（`packages/react/src/session-store.ts:48`）是消息流的增量投影纯函数。它处理四种影响 messages 数组的事件：

- **`messageStart`**。如果消息带 id，先找有没有乐观回显的 user 消息（`__optimistic === true` 且文本相同）可以替换。找到就替换（去掉 optimistic 标记，设 pending）。找不到且最后一条是空 assistant 占位，就替换占位。否则追加。user 消息的乐观回显替换是关键——用户发消息时先乐观显示，pi 推 `messageStart(user)` 时替换掉乐观版本，去重靠文本匹配。

- **`messageUpdate`**。如果消息带 id，按 id find-and-replace（merge，清除 pending）。找不到 id 就替换最后一条 assistant（兜底）。都没有就追加。按 id patch 是核心——不靠"末条 role 替换"，因为可能有多个 assistant 消息在流式（steer 场景）。

- **`messageEnd`**。如果消息带 id，按 id 替换，清除 pending 和 stopped。找不到 id 且最后一条 role 相同，替换最后一条。如果是 user 消息，尝试匹配乐观回显版本替换。否则追加。

- **`entryAppended`**。非 message 类型的条目（model_change、compaction 等），走 `sessionEntryToNeutral` 映射成分隔线，检查是否与最后一条重复，不重复就追加。

四个分支的共同模式是"先按 id 精确定位，找不到再按 role 兜底"。id 是 patch 锚点——pi 给每条消息分配 entryId，renderer 的乐观回显用 `crypto.randomUUID()` 生成临时 id，pi 推 `messageStart` 时用真实 id 替换占位。

### 4.4 状态增量 patch：SessionState 全字段覆盖

`patchStateFromEvent`（`packages/react/src/session-store.ts:44`）是状态投影纯函数，和 `applyEvent` 并排。它处理所有影响 `SessionState` 的事件：

| 事件 | 更新的 state 字段 |
|---|---|
| `modelSelect` | `model` |
| `thinkingLevelChanged` / `thinkingLevelSelect` | `thinkingLevel` |
| `agentStart` | `isStreaming = true` |
| `agentSettled` / `agentEnd` | `isStreaming = false` |
| `compactionStart` | `isCompacting = true` |
| `compactionEnd` | `isCompacting = false` |
| `sessionStart` | `sessionFile` |
| `sessionInfoChanged` | `sessionName` |
| `queueUpdate` | `pendingMessageCount` |

返回 `null` 表示该事件不影响 state（如 `messageStart` 只影响 messages 不影响 state），调用方跳过。`onEvent` 里的调用方式是一行：

```ts
const patched = s.snapshot ? patchStateFromEvent(s.snapshot.state, event) : null;
// ...
snapshot: patched ? { ...s.snapshot!, state: patched } : s.snapshot,
```

和 `applyEvent` 的调用方式同构：

```ts
messages: applyEvent(s.messages, event),
```

两个纯函数并排，onEvent 只做编排——调两个纯函数，合并结果，set 到 store。纯函数可独立测试，不依赖 store。

## 5. pi 事件类型全览与展示设计

### 5.1 事件分类：消息流 / 工具调用 / 生命周期 / 状态变更 / 压缩 / 队列 / 重试

`SessionEvent` 联合类型定义了 22 种事件，按功能分七类：

- **消息流事件**（3 种）。`messageStart`（消息开始）、`messageUpdate`（流式增量）、`messageEnd`（消息定稿）。这是最高频的事件——pi 每生成一个 token 就推一次 `messageUpdate`。renderer 的 `applyEvent` 按 id 精确 patch 消息内容（messageStart 例外，见 §4.3）。UI 响应：流式光标（pending 期间）、滚动桥（新内容来了推到底部）。

- **工具调用事件**（3 种）。`toolCallStart`（工具开始执行）、`toolCallUpdate`（部分结果）、`toolCallEnd`（工具完成，带 result/isError）。这三个事件描述一个工具调用的完整生命周期。UI 响应：工具卡片显示"running"状态 + 脉冲动画，完成后显示结果 + checkmark/error。

- **生命周期事件**（4 种）。`agentStart`（agent 开始工作）、`agentEnd`（agent 结束，带最终消息列表）、`agentSettled`（完全 settled，所有后续事件处理完）、`turnStart`/`turnEnd`（一轮对话的开始/结束）。`agentStart`/`agentSettled` 控制 `isStreaming` 和 store 级 `streaming`。`turnStart`/`turnEnd` 当前未接 UI——设计上应在 Composer 显示"thinking..."指示器。

- **状态变更事件**（5 种）。`modelSelect`（模型切换）、`thinkingLevelChanged`/`thinkingLevelSelect`（思考强度变更/选择）、`sessionInfoChanged`（会话名变更）、`sessionStart`（新会话文件创建，带 sessionFile）。这些事件直接映射到 `SessionState` 的字段更新，由 `patchStateFromEvent` 处理。

- **压缩事件**（2 种）。`compactionStart`（压缩开始）、`compactionEnd`（压缩完成）。压缩是 pi 把长上下文摘要成短上下文的过程。UI 响应：压缩指示器（timeline 里显示一条 compaction 分隔线，表示"从这里开始上下文被压缩了"）。`compactionEnd` 后应触发 `sync()` 重拉基线——因为压缩会改变消息列表（历史消息被摘要替换）。

- **队列事件**（1 种）。`queueUpdate`（待处理消息数变更）。steer/follow_up 模式下，用户可以在 pi 生成中途发消息，消息排队等待。UI 响应：Composer 附近显示"队列中有 N 条待发"。

- **自动重试事件**（2 种）。`autoRetryStart`（自动重试开始，带 attempt 次数）、`autoRetryEnd`（重试结束，带 success 标志）。pi 生成失败后可能自动重试。UI 响应：在消息流中显示"正在重试 (第 N 次)"指示器，成功/失败后更新。

### 5.2 每种事件的渲染策略与 UI 响应

事件分类之后，每种事件需要明确"renderer 收到后做什么"。当前代码只对少数事件做了 UI 响应，大多数事件被静默忽略。完整的事件 → UI 映射如下：

**消息流事件**的 UI 响应已经覆盖——`messageStart`/`messageUpdate` 触发滚动桥（`scrollBridge.onNewItem()`），`messageEnd`/`agentSettled`/`agentEnd` 触发统计刷新（`refreshStats()`）。`applyEvent` 按 id patch 消息内容。唯一缺的是 `messageStart` 的 user 消息乐观回显替换——当前用文本匹配，如果两条用户消息文本相同会误替换。设计上应该用 pi 给的 id 匹配，但 pi 不一定给 user 消息分配 id（乐观回显用了临时 UUID，pi 推的 messageStart 可能不带相同 id），文本匹配是兜底。

**工具调用事件**的 UI 响应存在缺口。当前 `toolCallStart`/`toolCallUpdate`/`toolCallEnd` 被定义但 renderer 没有独立处理——工具调用的渲染是靠 `messageUpdate` 推的 assistant 消息 content 里的 `toolCall` 块驱动的。也就是说，工具调用的状态（running/completed/error）不是由 toolCall 事件驱动的，而是由 assistant 消息 content 里的 `toolCall.state` 字段驱动的。这是一个设计选择——工具调用是 assistant 消息的一部分，不是独立的 UI 实体。toolCall 事件可能被用来做更细粒度的 UI 更新（比如实时显示工具执行进度），但当前未接入。

**生命周期事件**中 `agentStart`/`agentSettled` 的 UI 响应已覆盖（设置 `streaming` 状态 + `patchStateFromEvent` 更新 `isStreaming`）。`turnStart`/`turnEnd` 未接 UI——设计上应在 Composer 上方显示一个细条指示器，表示"pi 正在思考"。当前 Composer 下方有一个 `streaming` 时的脉冲点和"thinking"文案，但那个是 `streaming` store 状态驱动的，不是 `turnStart`/`turnEnd` 事件驱动的。区别在于：`streaming` 表示"pi 正在工作"（粗粒度），`turnStart`/`turnEnd` 表示"一轮对话开始/结束"（细粒度，一个 agentStart 里可能有多个 turn）。

**状态变更事件**中 `modelSelect`/`thinkingLevelChanged`/`thinkingLevelSelect` 由 `patchStateFromEvent` 处理。`sessionInfoChanged` 更新 `sessionName`。`sessionStart` 更新 `sessionFile` 并通知 ui-store 设 `currentSessionPath`。这些事件的 UI 响应是隐式的——snapshot 更新后 React 自动重渲染，Composer 下拉框显示新模型名/新思考强度。

**压缩事件**中 `compactionEnd` 触发 `sync()` 重拉基线——压缩改变了消息列表，必须全量重拉。`compactionStart` 当前没有独立 UI 响应——设计上应在 Composer 上方显示"正在压缩上下文..."的指示条。压缩事件还会写入 JSONL 文件一条 `compaction` 条目，冷启动时经 `sessionEntryToNeutral` 映射成分隔线显示。

**队列事件**和**自动重试事件**当前完全没有 UI 响应。`queueUpdate` 应在 Composer 附近显示待处理消息数。`autoRetryStart`/`autoRetryEnd` 应在消息流中显示重试指示。这两个事件的类型定义、翻译映射、dispatch 路由都有，只差 renderer 的 UI 组件接入。

### 5.3 未覆盖事件兜底：未知类型不丢

`SessionEvent` 联合类型的最后一项是 `{ type: string; [key: string]: unknown }`——兜底子句。pi 新增事件类型时，`translateEvent` 的 `TYPE_MAP` 没有对应映射，事件以原始 snake_case type 透传到 renderer。

`sessionEntryToNeutral` 对未知条目类型的兜底是映射成分隔线——`divider("entry", "timeline.unknownEntry", { type: String(e.type) }, ts, safeJson(j))`。分隔线渲染时显示"未知条目"图标 + 类型名 + 可展开的原始 JSON。这保证了未来 pi 新增条目类型时，用户能看到"这里有个我不知道是什么的东西"，而不是被静默丢弃。

事件流路径的兜底同理——未知事件 type 不匹配任何 `patchStateFromEvent` 的 case（走 default 返回 null），不匹配 `applyEvent` 的任何分支（返回 messages 不变）。事件不会被消费，但也不会报错——只是没有 UI 响应。设计上应该把未知事件记个日志，方便发现 pi 新增了什么事件类型。

## 6. 消息类型与渲染

### 6.1 role 分发：user / assistant / divider / 自定义角色

`MessageRow`（`timeline/renderer/index.tsx:328`）是消息渲染的入口，按 `message.role` 分发到不同的渲染分支。`message` 是 `NeutralMessage`——一个宽松类型，role 是 string，content 是 unknown，还有 pending/stopped/error 等状态标记。

- **`role: "user"`**。右对齐的消息气泡，surface 底色，圆角，内嵌文本。无工具调用、无思考块——用户消息是纯文本（或文本 + 图片，图片当前在 content 块里但 MessageRow 只提文本）。右键菜单可加书签。

- **`role: "assistant"`**。最复杂的渲染分支。assistant 的 content 是内容块数组，可能包含 text 块、thinking 块、toolCall 块的组合。渲染时先提取所有 thinking 块渲染为 `ThinkingChainBlock`，再提取所有 toolCall 块渲染为 `ToolCardRenderer`，最后剩余的 text 块渲染为 `Markdown`。三种子渲染器按顺序排列——思考块在上，工具卡片在中，文本回复在下。

- **`role: "divider"`**。居中分隔线，不显示为消息。`EntryDivider` 组件按 `kind` 选图标（Cpu/Brain/Archive/GitBranch/Pencil/Bookmark/FileQuestion），按 `i18nKey` + `i18nArgs` 调 `t()` 翻译。有 `detail` 字段时可展开显示原始 JSON（如 compaction 的摘要文本）。

- **自定义角色**（`role: "bashExecution"` 等）。来自 `custom_message` 条目，role 是 `customType` 字段值。`bashExecution` 特殊处理为 BashCard 渲染（显示 command + output + exitCode），其余自定义角色走 `ToolCardRenderer` 兜底——把整个 message 当作 toolCall 渲染，name 取 message.name 或 role，args 取 message 本身，result 取 content。

role 分发是"内容驱动"的——不靠声明 `kind` 字段让引擎 switch，而是靠 role 本身的值决定渲染分支。新增角色不需要改框架，只需要在 `MessageRow` 里加一个 if 分支（或用渲染器注册表，让插件贡献自定义角色的渲染器）。

### 6.2 assistant 内容块：text / thinking / toolCall 的组合渲染

assistant 消息的 `content` 是一个数组，每个元素是一个内容块，块类型由 `type` 字段区分。`MessageRow` 用三个提取函数分别提取不同类型的块：

- **text 块**（`type: "text"`）。提取 `text` 字段，拼接成完整文本，传给 `Markdown` 组件渲染。`Markdown` 支持 GFM、代码高亮、流式光标（pending 时显示打字光标）。

- **thinking 块**（`type: "thinking"`）。提取 `thinking`/`text` 字段和 `redacted` 标记、`thinkingSignature`。传给 `ThinkingChainBlock` 组件——一个可折叠的思考过程展示，带"思考中..."指示器和时间戳。流式时（`streaming=true`）显示实时更新，定稿后可折叠。

- **toolCall 块**（`type: "toolCall"`）。提取 `id`/`name`/`args`/`state`/`result`/`isError`。传给 `ToolCardRenderer`，由它按工具名分发到具体的工具卡片（BashCard/EditCard/ReadCard/DefaultCard）。

三种块的组合是自由的——一条 assistant 消息可以只有文本，可以先思考再调工具再给文本，也可以只调工具不给文本（工具执行完后直接结束）。渲染顺序固定（thinking → tool → text），但每种块的数量不限。这种设计让 assistant 的回复结构灵活——pi 可以先思考一段、调一个工具、再思考一段、再调另一个工具、最后给文本回复——全部在一条 assistant 消息里。

### 6.3 工具卡片：bash / edit / read / grep / 默认

`ToolCardRenderer`（`tool-cards.tsx:501`）按工具名分发到四类卡片：

- **BashCard**。工具名匹配 `bash`/`execute_bash`/`run_tests`。渲染为终端样式——左边框 + 深色背景 + 等宽字体，显示 `$ command` 和输出。输出超过 200 行折叠，显示行数。有 exitCode 时底部显示退出码，非 0 标红。流式时（`state === "pending"`/`"running"`）显示流式光标。

- **EditCard**。工具名匹配 `edit`/`write`/`multi_edit`/`edit_file`/`write_file`。如果 args 有 `edits` 数组（multi_edit），逐个渲染 diff（FallbackDiff——旧红新绿的逐行对比）。如果 args 有 `content`（write），渲染为 pre 块。否则走 DefaultCard。

- **ReadCard**。工具名匹配 `read`/`read_file`（渲染文件内容或图片）和 `grep`/`find`/`ls`/`glob`（渲染可点击的搜索结果列表）。ReadCard 的 result 是 `ReadResult` 结构，`content` 数组里可能有 text 块和 image 块——image 块渲染为 `<img>`，text 块渲染为 `<pre>`。grep/find 结果渲染为 `CollapsibleOutput`——每行可点击打开文件（`window.pi.openFile`）。

- **DefaultCard**。兜底渲染。左边框 + 工具名 + 可折叠的参数和结果。参数用 `fmtArgs` 格式化成 key-value 列表，结果用 `fmtResult` JSON 序列化。流式时显示"running"shimmer 动画。完成时显示 checkmark，出错显示 error。

工具卡片的设计原则是"按工具特性特化渲染"——bash 要像终端，edit 要像 diff，read 要像文件预览。未知工具走 DefaultCard，保证任何工具都有渲染——不会因为 pi 新增了一个工具就渲染崩溃。

### 6.4 分隔线：model_change / thinking_level / compaction / branch / label

分隔线是 `role: "divider"` 的 `NeutralMessage`，由 `sessionEntryToNeutral` 从 JSONL 条目映射而来。每条分隔线带 `kind`（决定图标）、`i18nKey`（决定文案）、`i18nArgs`（决定参数）、`detail`（可选展开内容）。

六种 kind 对应六种条目类型：`model`（模型切换，图标 Cpu）、`thinking`（思考强度变更，图标 Brain）、`compaction`（上下文压缩，图标 Archive）、`branch`（分支摘要，图标 GitBranch）、`info`（会话重命名，图标 Pencil）、`label`（书签，图标 Bookmark）。还有一种 `entry`（未知条目类型，图标 FileQuestion）作为兜底。

分隔线是居中显示的——左右各一条 `h-px` 线，中间是图标 + 文案。有 `detail` 时可点击展开，展开后显示在一个圆角框里。分隔线不可加书签（`handleContextMenu` 里 `message.role === "divider"` 直接 return）。

分隔线的文案由 i18n 插件贡献——圆心只产 key（`timeline.modelChange`、`timeline.compaction` 等）和 args（`{provider, modelId}`、`{tokens}` 等），渲染层调 `t(key, args)` 翻译。换语言时分隔线文案自动变，不需要改内核代码。

### 6.5 状态标记：pending / stopped / error

`NeutralMessage` 有三个状态标记字段，驱动渲染层的视觉态：

- **`pending`**。流式中 = true。assistant 占位 + `messageUpdate` 期间为 true，`messageEnd` 后为 false。驱动单条消息的流式光标/思考态视觉：pending 期间显示思考态（脉冲点 + "thinking"文案），`messageStart` 后显示流式光标（Markdown 的打字光标）。`MessageRow` 的 `isStreaming` 判断是 `message.pending === true || streaming`——消息级 pending（这条消息在流式）或全局 store 级 streaming（pi 正在工作），任一为 true 就显示流式态。重设计后三者分工明确（见 §1.2 streaming 双源修复）：store 级 `streaming` 给 Composer 发送/停止按钮，`snapshot.state.isStreaming` 给统计行，`message.pending` 给单条消息光标。`MessageRow` 里 `|| streaming` 读的是 store 级 `streaming`，不是 `snapshot.state.isStreaming`——两者在重设计后同步变化（`patchStateFromEvent` 同时更新），不会不一致。

- **`stopped`**。用户点停止或生成失败后 = true。保留已收到的部分内容，标一条红色斜体"已停止"提示。`messageEnd` 时清除 stopped（设为 false）。

- **`error`**。生成失败（进程 crash/RPC reject/toolCall isError）= true。显示一条红色"错误"提示。error 和 stopped 可以共存——pi 生成中途 crash，消息既有部分内容又标 error。

三个标记是"语义字段驱动"而非"类型戳驱动"——不需要声明 `kind: "stopped"` 让引擎 switch，消费者读 `message.stopped` 判断状态。这呼应了"内容驱动、别 switch"的设计纪律。

## 7. 乐观回显

### 7.1 用户消息乐观回显与去重

用户按发送键后，`send()` 函数在调 `pi.sessions.prompt()` 之前，先做两件事：`appendOptimisticUser(text)` 和 `appendPendingAssistant()`。乐观回显的目的是消除"按了发送但什么都没发生"的空窗——用户消息立刻出现在时间线上，assistant 占位立刻显示思考态。

`appendOptimisticUser` 生成一个临时 id（`crypto.randomUUID()`）、role 为 user、content 为纯文本、带 `__optimistic: true` 标记的消息，追加到 messages 末尾。`__optimistic` 是内部标记字段，不进 pi 协议——它只存在于 renderer store 里，用来在 pi 推 `messageStart(user)` 事件时定位并替换乐观回显版本。

替换逻辑在 `applyEvent` 的 `messageStart` 分支里：如果 pi 推了一条 user 消息，从 messages 末尾倒序找 `__optimistic === true` 且文本相同的消息，找到就用 pi 的版本替换（去掉 optimistic 标记，设 pending）。文本匹配是兜底——pi 不一定给 user 消息分配 id（或者说，pi 的 id 和乐观回显的临时 UUID 不匹配），文本匹配是目前唯一的关联方式。

文本匹配有一个已知边界：用户连续发送两条相同的消息（"继续""继续"），第二条的乐观回显和第一条（已被 pi 确认替换掉 optimistic 标记的那条）文本相同，`applyEvent` 倒序找 `__optimistic === true` 会跳过已确认的消息（因为它们的 `__optimistic` 已经被清除了），找到正确的乐观回显版本。但如果 pi 延迟推送第一条 `messageStart(user)`，用户已经发了第二条相同内容的消息，两条乐观回显都在 messages 里，pi 推来的第一条 `messageStart` 会替换倒序找到的第一条 `__optimistic`——也就是第二条，而不是第一条。顺序就乱了。这是文本匹配的固有缺陷，根因是缺少稳定的关联 id。

### 7.2 assistant 占位与替换

`appendPendingAssistant` 生成一个临时 id、role 为 assistant、content 为空字符串、`pending: true` 的占位消息。占位的作用是让 timeline 立刻显示思考态（脉冲点 + "thinking"文案），而不是等 pi 推 `messageStart(assistant)` 事件——后者有网络延迟，可能几百毫秒。

pi 推 `messageStart(assistant)` 时，`applyEvent` 的处理逻辑是：如果最后一条是 assistant 且 `pending` 或 content 为空，就替换占位（用 pi 的消息版本，设 pending: true）。否则追加。替换靠位置判断（最后一条 assistant），不靠 id 匹配——因为占位用了临时 UUID，pi 的 `messageStart` 带 pi 分配的 entryId，两者不匹配。

pi 随后推 `messageUpdate` 时，带 id 的消息按 id 精确 patch（`findIndex(m => m.id === msg.id)`）。这说明 `messageStart` 替换占位后，pi 的 id 进入了 messages 数组，后续 `messageUpdate`/`messageEnd` 都按这个 id 精确定位。占位 → 替换 → 按 id patch 是三步：占位靠位置替换（临时），pi 接管后靠 id（稳定）。

如果用户在 pi 生成中途 steer 了（插入转向消息），`appendPendingAssistant` 不会被再次调用——steer 消息走 `pi.sessions.steer()`，不走 `send()` 流程。pi 推的 `messageStart(assistant)` 会追加新的 assistant 消息（因为最后一条 assistant 不为空，不满足替换条件）。这是正确的——steer 产生新的 assistant 回复，不是替换之前的。

## 8. 命令提交与状态对齐

### 8.1 选择即提交：pickModel/pickLevel 立即发命令到 pi

"选择即提交"是重设计的核心。原来的 `pickModel`/`pickLevel` 只记偏好，等 `send()` 时才提交。重设计后，用户在下拉框选了模型/思考强度，如果 pi 在跑，立刻发命令。

`pickModel` 的完整逻辑：

1. `setCurrentModelId(`${provider}/${modelId}`)`——写 ui-store 偏好 + 落盘 electron-store。这一步无论如何都做——偏好要持久化，下次启动时恢复。
2. `pi.sessions.setModel(provider, modelId)`——发 `set_model` RPC 命令到 pi。这一步只在 pi 在跑时有效——`setModel` 内部检查 `proc.adapter.alive`，没活就 return（不抛错、不起进程）。
3. `.then(() => pi.sessions.sync())`——命令 resolve 后拉一次基线。`sync` 返回 `SyncSnapshot`，经 `onSnapshot` 广播，store 替换基线，React 重渲染。Composer 下拉框显示的模型从"偏好值"变成"pi 实际值"——两值一致了。

`pickLevel` 同理——`setCurrentThinkingLevel` → `setThinkingLevel` → `sync`。

这里的关键设计决策是"`setModel` 不调 `ensureForSend`"。原来的 `setModel` 调了 `ensureForSend`，意味着选个模型可能 spawn 一个 pi 进程——这不对。用户选模型是 UI 操作，不该有进程副作用。`setModel` 只在 pi 已经在跑时发命令，没跑就只记偏好，等 `send()` 时由兜底逻辑一次性同步。

### 8.2 发送时生效：pi 在下次 prompt 轮次应用

"选择即提交"不等于"选择即生效"。用户选了 GPT-4o，命令立刻发到 pi stdin，pi 收到 `set_model` 命令并处理——但 pi 的实际模型切换可能在当前轮次结束时或下次 prompt 时才应用。这是 pi 底座的行为，不是桌面端控制的。

桌面端能保证的是：命令发出去了（RPC resolve = pi 处理了），sync 拉回来的状态是准确的（snapshot.state.model 更新了）。至于 pi 在哪个轮次应用新模型，是 pi 的实现细节。

这个"中间态"——命令已提交、pi 已确认、下次发送时真正生效——是用户期望的行为。用户选模型时不想等"下一条消息才用新模型"，而是"现在选了，下一条回复就用新模型"。`pickModel` 立即发命令 + sync 校正，确保了"现在选了，pi 知道了，状态是对的"。

### 8.3 命令 resolve 后 sync 校正（不靠事件回传）

`pickModel` 的 `.then(() => pi.sessions.sync())` 是状态同步策略的第二通道——命令后校正。

为什么不靠事件回传？因为 pi 不保证推事件。`set_model` 命令 resolve 后，pi 可能推 `modelSelect` 事件，也可能不推，也可能延迟推。如果只靠事件，snapshot 什么时候更新取决于 pi 什么时候推——不可控。

`sync()` 是确定性的。RPC resolve 意味着 pi 处理完了命令，`sync` 拉到的是 pi 处理完命令后的权威状态。不管 pi 推不推事件，`sync` 都能拿到正确结果。`onSnapshot` 广播后，store 替换基线，React 重渲染——用户看到模型切换了。

事件增量通道仍然保留——如果 pi 推了 `modelSelect` 事件，`patchStateFromEvent` 会更新 `snapshot.state.model`。两条通道都能更新状态，谁先到用谁的结果，最终一致。

### 8.4 send() 的兜底对齐（pi 首次启动时一次性同步偏好）

`send()` 函数里保留了偏好对齐逻辑，作为"pi 没跑时只记偏好"的兜底。当用户在 pi 没跑时选了模型/思考强度（`pickModel` 只记偏好，`setModel` 检查 alive 后 return），然后发送第一条消息——`send()` 里 `ensureForSend` spawn 了 pi 进程，此时偏好和 pi 实际状态可能不一致。

兜底逻辑（`timeline/renderer/index.tsx` 的 `send()`）：

- 读 `ui.currentModelId`（偏好）和 `snapshot.state.model`（pi 实际）。不一致就 `pi.sessions.setModel(provider, modelId)`。
- 读 `ui.currentThinkingLevel`（偏好）和 `snapshot.state.thinkingLevel`（pi 实际）。不一致就 `pi.sessions.setThinkingLevel(level)`。
- 对齐完偏好后，才发 `pi.sessions.prompt(finalText)`。

这个兜底逻辑只在 pi 首次启动时触发——后续 `pickModel`/`pickLevel` 已经在 pi 在跑时立即提交了，偏好和 pi 状态一致，`send()` 里的对齐检查通过，不重复发命令。

`send()` 里还有一段"工具过滤"逻辑——读会话的 `toolConfig`，如果是 custom 模式就拼一段 `[System] 本次会话已限制可用工具...` 的前缀到消息文本里。这是会话级配置，和模型/思考强度的对齐无关，是另一条关注点。

## 9. resync 基线拉取

### 9.1 四 RPC 并发模型

`resync`（`application/orchestrations/resync.ts:18`）是基线拉取的共享原语。它并发发 4 个 RPC 命令到 pi，拿到全部会话数据后组装成 `SyncSnapshot`：

- `get_state`——拉 `RpcSessionState`，经 `toSessionState` 映射成中性 `SessionState`（model、thinkingLevel、isStreaming、isCompacting、steeringMode、followUpMode、sessionFile、sessionId、sessionName、autoCompactionEnabled、messageCount、pendingMessageCount）。
- `get_entries`——拉 `SessionEntry[]` + `leafId`，每个 entry 经 `sessionEntryToNeutral` 映射成 `NeutralMessage`，过滤 null（隐藏层），`deduplicateAdjacent` 去重，组成 messages 数组。
- `get_tree`——拉 `SessionTreeNode[]` + `leafId`，经 `toTreeNode` 递归映射成中性 `TreeNode`（会话树结构，fork 场景用）。
- `get_commands`——拉 `RpcSlashCommand[]`，经 `toCommandItem` 映射成中性 `CommandItem`（斜杠命令列表，Composer 的 `/` 弹窗用）。

4 个命令用 `Promise.all` 并发——不串行等，减少延迟。pi 只有一对 stdin/stdout，但 `RequestCorrelator` 的 id 配对机制允许多个命令同时在途：4 个命令各分配一个递增 id（`req_1`/`req_2`/`req_3`/`req_4`），几乎同时写入 pi stdin（JSONL 每行一个命令，pi 按行接收）。pi 处理完后逐个返回 response（也带 id），`handleLine` 按 id 配对 resolve 对应的 Promise。pi 不保证按发送顺序返回——`get_state` 可能先返回，`get_entries` 后返回——但 id 配对保证了不管什么顺序，每个 Promise 都拿到自己的 response。4 个命令互不阻塞，总延迟约等于最慢的那个命令。

### 9.2 SyncSnapshot 结构

`SyncSnapshot` 是基线的完整快照，包含：

- `state: SessionState`——pi 的当前状态（模型、思考强度、流式态、压缩态等）。
- `entries: MessageEntry[]`——会话树条目元数据（id、type、content、toolCalls、timestamp）。
- `messages: NeutralMessage[]`——对话消息列表（经 `sessionEntryToNeutral` 映射 + 去重后的时间线数据源）。这是 timeline 渲染的直接数据。
- `tree: TreeNode[]`——会话树（fork 分支结构）。
- `commands: CommandItem[]`——斜杠命令列表。
- `leafId: string | null`——当前叶子节点 id（最新条目的 id）。

注意 `entries` 和 `messages` 的区别——`entries` 是会话树的条目元数据（所有节点，包括 fork 出去的分支），`messages` 是时间线数据源（只有当前分支的可见消息）。不要混用：timeline 渲染用 `messages`，会话树 UI 用 `entries` + `tree`。

### 9.3 何时触发 resync

resync 在以下场景触发：

- **pi 启动后**（`SessionStore.start`）。spawn 进程 + `waitReady`（`get_state` 轮询探测就绪）后，`sync()` 拉一次基线。这是冷启动到热路径的切换点。
- **命令 resolve 后**（`pickModel`/`pickLevel` 的 `.then(() => sync())`）。命令完成后拉权威状态，校正 snapshot。
- **压缩完成后**（`onEvent` 收到 `compactionEnd`）。压缩改变了消息列表（历史被摘要替换），必须全量重拉。
- **显式刷新**（用户点刷新按钮）。settings 页框架提供刷新按钮，调 `sync` 重读配置。
- **会话切换时**（`setContext` 激活会话 pi 活着）。切回正在跑的会话，resync 推一次基线拿实时状态。

不该触发 resync 的场景：消息流式更新（`messageUpdate`）。流式增量靠 `applyEvent` 按 id patch，不需要全量重拉——全量重拉会闪烁、会丢失滚动位置、会浪费 RPC。

## 10. 多会话进程调度

### 10.1 进程模型：会话是文件，进程是临时工

pi-desktop 的会话进程模型是"会话是文件，进程是临时工"。会话的持久形态是 JSONL 文件——打开历史会话是纯文件读，不启 pi 进程，秒开。pi 进程是按需的临时工——只有发消息（`prompt`）时才起进程，进程跑完不主动杀（多会话并存）。

这个模型的设计意图是资源效率：看历史会话不需要起一个 AI agent 进程，只有要和 AI 对话时才需要。用户可以同时打开多个会话在 tab 间切换——只有当前 tab 的 pi 在跑（或最近发过消息的几个 tab），其余 tab 是纯文件读。

"每会话一进程、多会话多进程"是 pi-desktop 的进程模型。`procs` 是 `Map<key, SessionProc>`，每个会话一个 pi 进程，互不干扰。切会话只设激活（`setContext`），不杀其他会话的进程——用户可以在会话 A 发了消息，切到会话 B 发消息，切回会话 A 时 pi 还在跑、上下文还在。

### 10.2 procs Map 与激活会话管理

`procs` 的 key 有两种形式：历史会话用 `sessionPath`（文件路径），新会话用 `new:${cwd}`（未落盘时的临时 key）。key 的选择在 `setContext` 时确定——`sessionPath` 给了用 sessionPath，没给（新会话）用 `new:${cwd}`。

`activeProcKey` 是当前激活会话的 key。`setContext` 设激活时更新 `activeProcKey`，`adapter.onEvent` 闭包绑这个 key——事件路由靠 key 判断"这条事件属于哪个会话"。key 不能随 sessionFile 变（pi 推 `sessionStart` 事件时可能带新文件路径），因为 adapter 的事件监听器闭包绑了初始 key，移 key 会丢事件转发。所以 key 不动，只更新 `boundSessionPath`。

`SessionProc` 结构：`adapter`（RpcAdapter）、`cwd`（工作目录）、`boundSessionPath`（绑定的会话文件路径）、`genStartMs`（TPS 自算用——messageStart 记时）、`lastTps`（上次算出的 TPS）。

`setContext` 的核心逻辑：

- 设 `activeCwd` 和 `activeSessionPath`，算出 `activeProcKey`。
- 新会话（`sessionPath === null`）时：停掉旧的新会话进程（`new:cwd` key），不复用旧进程——否则"新会话"会复用上一个新会话的 pi 进程（续旧会话，非新会话语义）。
- 激活会话 pi 活着：resync 推基线（切回流式中的会话拿实时状态）。
- 激活会话 pi 没活：清基线（`latestSnapshot = null`），renderer 走文件读。

### 10.3 ensureForSend 与新会话路径生成

`ensureForSend`（`session-store.ts:197`）是发送路径的进程保证。它做三件事：

1. 检查 `activeCwd`——没选工作目录就抛错。
2. 检查 `this.alive`——pi 在跑就 return，不重复起。
3. pi 没跑就起：新会话（`activeSessionPath === null`）生成新文件路径，调 `start(cwd, sessionPath)`。

新会话路径生成（`generateNewSessionPath`）：`~/.pi/agent/sessions/<桶>/<ISO timestamp>_<uuid>.jsonl`。时间戳用 ISO 格式（冒号和点替换成横线，文件系统友好），UUID 用 `crypto.randomUUID()`。这个路径传给 pi 的 `--session` 参数，pi 底座拿到不存在的文件会建新会话。

`start` 做的事：创建 adapter（`factory.create({cwd, args})`）、绑事件监听器（`adapter.onEvent` → `dispatch`）、设 `onProcessExit` 回调、`adapter.start()`（绑 handle + attach JSONL reader）、`waitReady`（`get_state` 轮询探测，150ms 间隔，4s 预算）、`sync()`（拉基线广播）。

`waitReady` 不用固定 sleep 赌就绪——`get_state` 轮询是实证探测，首个成功就返回。超时（4s）也继续——让后续 sync 的真实错误冒出去，不在此掩盖。这消除了原来 100ms/500ms 固定 sleep 的时序竞争——慢机上 sleep 不够会偶发 bug，快机上 sleep 是白等。

### 10.4 事件路由：流式增量只转发激活会话

`dispatch`（`session-store.ts:511`）是事件路由的核心。它做三件事：

1. **sessionStart 事件特殊处理**。如果 key 以 `new:` 开头（新会话）且事件带 `sessionFile`，更新 `proc.boundSessionPath` 和 `this.activeSessionPath`——pi 创建了新文件，桌面端要记录路径。

2. **busy 状态追踪**。`agentStart` 设 busy=true，`agentSettled` 设 busy=false，`compactionStart` 设 busy=true，`compactionEnd` 设 busy=false。busy 状态用于 restart 协调——只有非 busy 的会话才能安全重启。

3. **事件路由**。流式增量事件（非 `messageEnd`/`agentSettled`/`agentEnd`/`sessionStart`）只转发激活会话——`key !== this.activeProcKey` 就 return，不推给 renderer。定稿/轮结束/新文件事件全转发——因为会话列表需要这些事件刷新（modified 时间、消息数）。TPS 自算也在这里：`messageStart` 记 `genStartMs`，`messageEnd` 用 output tokens / 耗时算 `lastTps`。

路由判断在 `dispatch` 里，不在 IPC 层。IPC 层（`onEvent`/`onKernelEvent`）只管透传——所有注册的监听器都收到事件。`dispatch` 决定哪些事件推给 renderer（流式的只推激活会话的），哪些推给所有监听者（定稿的推所有）。

## 11. 会话树与维护操作

### 11.1 fork/clone/getForkMessages

会话树操作通过 `SessionTreeApi` 接口暴露，实现在 `SessionStore` 里。

- **`fork(entryId)`**。从指定条目分叉出新会话（entryId 必须是 user 消息锚点）。发 `fork` 命令到 pi，pi 创建一个新的会话分支文件并**切换过去**——当前会话的后续消息走新分支。底座 `session_start` 不上 RPC stdout、fork 响应不带新路径，内核 fork 成功后自动对账（`reconcileAfterSessionReplacement`：sync 拿截断基线 + dispatch synthetic sessionStart 水合激活路径），调用方不再各自补 `sync()`。

- **`clone()`**。克隆当前会话。发 `clone` 命令到 pi，pi 创建一个完全相同的新会话。clone 和 fork 的区别：fork 从指定点分叉（后续可能不同），clone 复制全部（完全相同）。

- **`getForkMessages(entryId)`**。取分叉点的消息。发 `get_fork_messages` 命令到 pi，返回 `NeutralMessage[]`——从会话开始到 `entryId` 的所有消息。返回值经 `deduplicateAdjacent` 去重 + `isVisibleMessage` 过滤（对齐文件读路径的 `custom_message display=false` 隐藏规则）。这些消息可以用来在 fork 预览 UI 里显示"从这个点分叉会保留哪些消息"。

三个操作都走 `this.send`（`adapter.send` + correlator 配对），是 RPC 命令——不是文件操作。fork/clone 在 pi 底座创建会话分支/副本，结果写进 JSONL 文件。

### 11.2 compact/setAutoCompaction/setAutoRetry

会话维护操作通过 `SessionMaintenanceApi` 接口暴露。

- **`compact(customInstructions?)`**。手动压缩上下文。发 `compact` 命令到 pi，pi 把长上下文摘要成短上下文，压缩后的会话继续。`compactionStart`/`compactionEnd` 事件会推过来，`compactionEnd` 后 `onEvent` 触发 `sync()` 重拉基线——因为压缩改变了消息列表（历史消息被摘要替换）。`customInstructions` 是可选的自定义压缩指令（比如"保留关于架构的讨论"）。

- **`setAutoCompaction(enabled)`**。设自动压缩开关。发 `set_auto_compaction` 命令，pi 根据上下文占用自动触发压缩（不用用户手动点）。开关状态存在 pi 的 `SessionState.autoCompactionEnabled` 里，resync 时拉到。

- **`setAutoRetry(enabled)`**。设自动重试开关。发 `set_auto_retry` 命令，pi 生成失败后自动重试。`autoRetryStart`/`autoRetryEnd` 事件会推过来，带 attempt 次数和 success 标志——但当前 renderer 没有接这两个事件的 UI 响应（§5.2 里提到的事件覆盖缺口）。

### 11.3 exportHtml/getLastAssistantText

- **`exportHtml(outputPath?)`**。导出会话为 HTML 文件。发 `export_html` 命令到 pi，pi 生成一个 HTML 文件（包含完整对话），返回生成路径。`outputPath` 可选——不给时 pi 用默认路径。

- **`getLastAssistantText()`**。取最后一条 assistant 回复的纯文本。发 `get_last_assistant_text` 命令到 pi，pi 返回纯文本（去掉 markdown 标记、去掉 thinking 块、去掉 toolCall 块的纯文本）。这个接口用于"复制最后一条回复"按钮、或者把回复传给其他工具。

`SessionMaintenanceApi` 还继承了 `RpcOps` 的 `getStats()`——取会话统计（token 用量/上下文占用/消息计数/cost + 桌面端自算的 TPS）。`getStats` 是所有 `RpcOps` 子接口共享的基类方法，因为不管发消息、切模型、还是 fork，都可能需要拿统计。

`QueueModeApi`（`setSteeringMode`/`setFollowUpMode`）也继承 `RpcOps`，控制 steer/follow_up 的排队行为（`all` = 全部排队、`one-at-a-time` = 只保留最新一条）。`queueUpdate` 事件推送当前待处理消息数，但如前所述，renderer 当前没有接这个事件的 UI 响应。

`BashApi`（`run`/`abortBash`）是独立权限门控的 RPC 操作——需要声明 `rpc:bash` 权限。`run` 在 pi 进程上下文执行 bash 命令，等价 RCE，所以独立权限门控。`excludeFromContext` 参数控制执行结果是否进会话上下文——`true` 不进（临时执行，不影响对话），`false` 进（执行结果作为上下文的一部分）。

## 12. 插件参与会话流

会话流不是 timeline 插件的私有领地。其他插件需要读会话状态、订阅事件流、注入自定义消息渲染、跨插件协作、触发跳转。这一章讲插件怎么参与会话流，以及哪些机制是已有的、哪些需要新建。

### 12.1 插件会话能力访问：PluginContext

插件经 `usePluginContext(pluginId)` 拿到 `PluginContext`——一个按 pluginId 绑定的受控 API 对象。`pluginId` 由框架从 `PluginIdContext`（React Context）自动注入，插件不手写常量。`PluginContext` 包含会话相关的全部能力，按关注点分组：

- `sessions: SessionsApi`——会话生命周期。插件能调 `list(cwd)` 列历史会话、`openSession(path)` 纯文件读、`setContext(cwd, path)` 设激活会话、`start(cwd, path?)` 启动 pi、`stop(path?)` 停 pi、`copySession(src, target)` 复制会话文件、`renameSession`/`updateHeader` 改头行。这些操作不直接 `spawn` 进程——`start` 和 `setContext` 是进程管理的入口，但实际 spawn 由 application 层的 `SessionStore` 控制。
- `messaging: MessagingApi`——消息发送。`prompt`/`abort`/`steer`/`followUp`/`abortRetry`。
- `models: ModelApi`——模型与推理。`getModels`/`setModel`/`cycleModel`/`getThinkingLevels`/`setThinkingLevel`/`cycleThinkingLevel`。
- `tree: SessionTreeApi`——会话树。`fork(entryId)`/`clone()`/`getForkMessages(entryId)`。
- `maintenance: SessionMaintenanceApi`——会话维护。`compact`/`setAutoCompaction`/`setAutoRetry`/`exportHtml`/`getLastAssistantText`。
- `queue: QueueModeApi`——队列模式。`setSteeringMode`/`setFollowUpMode`。
- `bash?: BashApi`——Bash 执行（需声明 `rpc:bash` 权限）。
- `events: PluginEventsApi`——事件总线。`emit(channel, payload)`/`on(channel, handler, opts?)`。

所有接口在 `domain/context.ts` 定义，实现在 `packages/react/src/plugin-context.ts`——每个方法都转发到 `window.pi.*` IPC 调用。插件不直接访问 `window.pi`（lint 拦截），经 `usePluginContext` 拿绑定后的 API。

**实际案例——session-bookmarks 插件**。用户在 timeline 右键一条消息请求书签 → timeline 发 `timeline:bookmarkRequested` 事件 → session-bookmarks 订阅收到 → 调 `ctx.sessions.copySession(sessionPath, target)` 把会话副本存进项目级数据目录 → 元数据写统一配置通道（`ctx.config.set("bookmarks", …)`）。用户点书签打开 → `ctx.tree.forkFromSession(bm.cwd, bookmarkFile, bm.entryId)` 一个原子用例完成"开新会话（当前时间 header）+ 预制内容（到收藏点的分支）"：中间路径生成、fork 后路径对账、中间副本清理全在框架内（见 `SessionStore.forkFromSession`）。整个流程不碰 timeline 代码，纯靠 PluginContext 的 session API + 事件总线完成。

### 12.2 事件订阅机制：两条路径的分工

插件有两条事件订阅路径，分工不同：

**`ctx.sessions.onEvent`——会话事件流**。这是 pi 事件的透传通道。pi 推的 22 种 `SessionEvent`（messageStart/toolCallStart/agentStart/...）经 `translateEvent` 翻译、`dispatch` 路由后，通过 `onEvent` 推给所有订阅者。每个订阅者收到完整的事件对象，自己决定关心哪些。这条路径是**只读的**——插件订阅事件做自己的事（统计、索引、触发副作用），但不影响事件流本身。`onEvent` 返回取消函数，组件卸载时调。

实际案例——token-stats 插件：`ctx.sessions.onEvent((event) => { if (event.type === "messageEnd") extractUsage(event.message); if (event.type === "agentSettled") accumulate + persist })`。它订阅 `messageEnd` 提取 token usage，订阅 `agentSettled` 做累计落盘。不影响 timeline 的渲染，不影响 session-store 的投影——它是一个旁路消费者。

**`ctx.events.emit/on`——插件间事件总线**。这是 renderer 侧的插件间通信通道（`packages/react/src/event-bus.ts`）。channel 由代码级 `export const channels = [...]` 声明——框架加载 renderer module 后读 `module.channels` 自动注册。emit 校验 channel 在自己的 channels 里声明过，on 校验 channel 来自已加载插件或 `system:*` 框架事件。`replayLast: true` 让新订阅者立即收到最近一次 emit 的 payload。

两条路径的区别：

- `sessions.onEvent` 是 **pi → renderer** 的单向透传，事件来自 pi 进程，内容是会话流事件。所有插件都能订阅，但都不能 emit（pi 是唯一发布者）。
- `events.emit/on` 是 **插件 ↔ 插件** 的双向通信，事件来自其他插件，内容是插件自定义的协作信号。只有声明了 channel 的插件能 emit，只有已加载插件声明的 channel 能被 on。

两者不混用——会话事件不走事件总线（它们是 pi 的，不是插件间的），插件协作不走 `onEvent`（它们是插件间的，不是 pi 的）。

### 12.3 自定义消息渲染注册

当前的问题：pi 推的 `custom_message` 条目经 `sessionEntryToNeutral` 映射后，role 是 `customType` 字段值（如 `bashExecution`/`multi-agent-dashboard`/`loop-planning`）。timeline 的 `MessageRow` 按 role 分发渲染——但分发逻辑是硬编码的 if-else 链：

```tsx
if (message.role === "user") { ... }
if (message.role === "assistant") { ... }
if (message.role === "divider") { ... }
if (message.role === "bashExecution") { /* 特殊处理为 BashCard */ }
return <ToolCardRenderer toolCall={...} />; // 兜底
```

`bashExecution` 是唯一被特殊处理的 custom_message 角色——因为它由 pi 的 bash 工具产生，渲染成终端卡片。其他自定义角色全走 `ToolCardRenderer` 兜底——把整个 message 当作一个 toolCall 渲染，name 取 role，args 取 message 本身，result 取 content。这对简单场景够用，但对"多 agent 看板""循环规划"这类有自身结构的 custom_message 来说是降级渲染——插件可能想画一个完全不同的 UI（树状图、甘特图、多列对比），而不是一个折叠卡片。

**设计方案：messageRenderer 槽位注册**。在现有槽位体系（sidebar/sidePanel/mainView/settings/themes/languages）基础上新增 `messageRenderers` 槽位。插件在 manifest 的 `contributes.messageRenderers` 里声明：

```json
{
  "contributes": {
    "messageRenderers": [
      { "role": "multi-agent-dashboard", "component": "DashboardMessage" },
      { "role": "loop-planning", "component": "LoopPlanMessage" }
    ]
  }
}
```

框架加载 renderer module 后，按 manifest 的 `component` 字段在 module exports 里找同名组件，自动注册到 `messageRendererComponents` 注册表。`MessageRow` 的渲染逻辑从硬编码 if-else 改为注册表查表：

```tsx
// 渲染分发：先查注册表，找不到再走内置 if-else，最后兜底 DefaultCard
const Renderer = getMessageRendererComponent(message.role);
if (Renderer) return <Renderer message={message} streaming={streaming} />;
if (message.role === "user") { ... }
if (message.role === "assistant") { ... }
if (message.role === "divider") { ... }
if (message.role === "bashExecution") { ... }
return <DefaultCard toolCall={...} />;
```

注册表查询是 O(1)（Map.get），不影响渲染性能。内置角色（user/assistant/divider/bashExecution）的 if-else 保留——它们是 timeline 插件自己的渲染逻辑，不该被覆盖。自定义角色的渲染器由其他插件贡献，按 role 匹配。

渲染器组件接收 `MessageRendererProps`：

```tsx
interface MessageRendererProps {
  message: NeutralMessage;
  streaming: boolean;
}
```

插件拿到 `message`（完整的 NeutralMessage，包含 role/content/pending/stopped/error 等全部字段）和 `streaming`（全局流式态），自己决定怎么画。插件可以经 `usePluginContext(pluginId)` 拿 ctx，在渲染器内部调 `ctx.sessions.onEvent` 订阅事件、调 `ctx.config.get` 读配置——渲染器是一个普通 React 组件，有完整的插件能力。

优先级规则：用户级插件覆盖内置级（`user > builtin`），同级按声明顺序。这和现有槽位（sidebar/settings 等）的优先级规则一致——内置件优先级最低、可被覆盖。

### 12.4 跨插件协作模式

跨插件协作的通用模式是：**一个插件发事件、另一个插件接**。不需要互相 import、不需要共享 store、不需要知道对方存在。

**案例：timeline ↔ session-bookmarks 的书签协作**。

timeline 插件在 `renderer/index.tsx` 里声明 channel：

```tsx
export const channels = ["timeline:bookmarkRequested"] as const;
```

框架加载 timeline 的 renderer module 后，读 `module.channels` 自动注册到事件总线。

用户在 timeline 右键一条消息 → `MessageRow` 的 `handleContextMenu` 调 `useUiStore.getState().requestBookmark({ sessionPath, entryId, preview })` → ui-store 设 `bookmarkRequest`（带 requestId）→ timeline 的 `TimelineView` 监听 `bookmarkRequest` 变化，调 `ctx.events.emit("timeline:bookmarkRequested", { sessionPath, entryId, preview, requestId })`。

session-bookmarks 插件在 `renderer/index.tsx` 里订阅：

```tsx
const off = ctx.events.on("timeline:bookmarkRequested", (payload) => {
  // 收到书签请求 → 复制会话文件到项目级数据目录 → 元数据写统一配置通道
  const { sessionPath, entryId, preview } = payload as BookmarkRequest;
  ctx.sessions.copySession(sessionPath, bookmarkFile);
  ctx.config.set("bookmarks", [...index, { sessionPath, entryId, preview, ... }]);
  // ...
});
```

关键设计点：

- timeline 不 import session-bookmarks、不调 session-bookmarks 的方法。它只 emit 一个事件到总线。
- session-bookmarks 不 import timeline、不读 timeline 的 store。它只 on 一个事件。
- 两者的耦合点是 channel 名（`timeline:bookmarkRequested`）和 payload 形状（`{sessionPath, entryId, preview, requestId}`）。channel 名是 timeline 的对外契约，payload 形状由 timeline 定义。
- `dependsOn: ["timeline"]` 在 session-bookmarks 的 manifest 里声明，框架做拓扑排序保证 timeline 先加载、channel 先注册。如果 session-bookmarks 先加载，on 一个还没注册的 channel 会抛错——`dependsOn` 保证不会。
- 如果 session-bookmarks 没安装，timeline emit 的事件到总线后没有订阅者，静默丢弃——不报错、不影响 timeline 功能。timeline 不依赖 session-bookmarks 存在。

这个模式可以推广到其他协作场景：git-review 插件发 `git:statusChanged` 事件，timeline 接收后在时间线上显示 git 状态条；blind-review 插件发 `review:completed` 事件，timeline 接收后在对应消息上标"已审"标记。只要 channel 名 + payload 形状是双方约定好的契约，任何两个插件都能协作。

### 12.5 跳转与导航

当前没有插件驱动的跳转机制。timeline 的滚动由 Virtuoso 虚拟列表控制，外部插件无法直接操作滚动位置。需要设计一个事件驱动的跳转协议。

**设计方案：timeline:scrollTo 系统事件**。timeline 插件声明 channel 并监听跳转请求：

```tsx
export const channels = ["timeline:bookmarkRequested", "timeline:scrollTo"] as const;
```

其他插件发 `timeline:scrollTo` 事件，payload 是跳转目标：

```tsx
ctx.events.emit("timeline:scrollTo", { messageId?: string; role?: string; position?: "top" | "bottom" });
```

timeline 监听这个 channel，用 Virtuoso 的 `scrollToIndex` 跳到对应位置。三种定位方式：

- `messageId`——按消息 id 精确跳转。timeline 在 messages 数组里 findIndex，调 `virtuosoRef.scrollToIndex({ index })`。用于"跳到某条书签对应的消息"。
- `role`——按角色跳转。从当前位置向前/后找第一个匹配 role 的消息。用于"跳到上一个 assistant 回复"。
- `position: "top" | "bottom"`——跳到顶部/底部。`bottom` 是最常用的——新会话加载后自动滚到底部、发送消息后滚到底部。

跨会话跳转（从会话 A 跳到会话 B 的某条消息）需要两步：先 `ctx.sessions.setContext(bm.cwd, bm.sessionPath)` 切换会话，等 `onSnapshot` 基线到位后再 `ctx.events.emit("timeline:scrollTo", { messageId })`。这两步不能在一个 tick 里完成——切换会话是异步的（文件读或 RPC resync），scrollTo 必须等 messages 数组更新后才能 findIndex。设计上 timeline 在 `onSnapshot` 回调里检查是否有"待跳转"的 messageId，有就跳——这样 emit 时机不需要精确对齐。

**右键菜单的扩展**。当前 timeline 的 `handleContextMenu` 只处理书签请求。设计上应该让其他插件能贡献右键菜单项——在 manifest 的 `contributes.messageRenderers` 里附带 `contextMenuActions` 字段，或者单独开一个 `contextMenu` 槽位。用户右键消息时，timeline 查注册表把所有插件贡献的菜单项画出来，点击后 emit 对应的 channel。这样 git-review 可以贡献"在此消息处查看 git diff"、blind-review 可以贡献"标记此消息为已审"——不需要改 timeline 代码。

## 13. QA

**Q1：pi 没跑时用户选了模型，这个偏好会丢吗？**

不会丢。`pickModel` 第一步就调 `setCurrentModelId`——写 ui-store 内存状态 + 落盘 electron-store（一个 Electron 生态的键值持久化库，数据存在磁盘上，跨重启保持）。`setModel` 内部检查 `proc.adapter.alive`，pi 没跑就 return，不抛错。等用户发第一条消息时，`send()` 里的 `ensureForSend` spawn pi 进程，然后兜底对齐逻辑检测到偏好和 pi 实际状态不一致，一次性 `setModel` + `setThinkingLevel`，再发 prompt。

**Q2：用户连续发两条相同内容的消息（"继续""继续"），乐观回显会乱吗？**

正常时序下不会。`applyEvent` 的 `messageStart(user)` 分支倒序找 `__optimistic === true` 且文本相同的消息。第一条消息被 pi 确认后 `__optimistic` 标记被清除，倒序找会跳过它，定位到第二条的乐观回显。但如果 pi 延迟推送第一条 `messageStart(user)`，用户已经发了第二条相同消息，两条乐观回显同时在 messages 数组里，pi 推来的第一条 `messageStart` 会替换倒序找到的第一条 `__optimistic`——也就是第二条，而不是第一条——顺序就乱了。根因是乐观回显用临时 UUID，pi 的 entryId 和它不匹配，只能靠文本兜底。这是已知边界，修复需要 pi 在 user 消息上也提供稳定 id。

**Q3：compactionEnd 后为什么要 sync 而不靠事件增量 patch？patchStateFromEvent 不是已经处理了 compactionStart/compactionEnd 吗？**

`patchStateFromEvent` 只更新 `isCompacting` 布尔值（true → false）。但压缩的本质是把几十条历史消息替换成一条摘要——`messages` 数组发生了结构性置换。`applyEvent` 按 id patch 单条消息，不处理"整个数组被替换"的场景。所以 `compactionEnd` 后必须 `sync()` 全量重拉 `get_entries`，重新走 `sessionEntryToNeutral` 映射 + `deduplicateAdjacent` 去重，生成全新的 messages 数组。

**Q4：多会话切换时，非激活会话的流式事件被丢弃了，切回去能看到完整状态吗？**

能。流式增量事件（`messageUpdate` 等）只转发激活会话——`dispatch` 里 `key !== activeProcKey` 就 return。但用户切回去时，如果该会话的 pi 进程还活着，`setContext` 触发 `sync()` → `resync()` 4 RPC 并发拉取完整基线（state + entries + tree + commands），用 pi 的权威状态全量替换当前基线。如果 pi 进程已退出，切回去走文件读路径（`openSession`），也是全量的。两条路径都不依赖被丢弃的流式事件。

**Q5：send() 的兜底对齐和 pickModel 的选择即提交会不会重复发 setModel？**

不会。两条路径覆盖互斥场景：pi 在跑时 `pickModel` 立即发 `setModel` + sync 校正，偏好和 pi 状态一致，`send()` 的对齐检查通过（一致就跳过）。pi 没跑时 `pickModel` 只记偏好（`setModel` 检查 alive 后 return），`send()` 里 `ensureForSend` spawn 新进程后兜底对齐发一次 `setModel`——这是这条偏好唯一一次被发送。两条路径由 `setModel` 的 `alive` 检查精确划界，不会同时触发。

**Q6：§1.1 说"事件溯源 + 状态投影"，又说"不是纯事件溯源"——到底是还是不是？**

是混合模型。JSONL 文件是持久化层（冷启动读、跨重启恢复），pi 进程内存是运行时权威（热路径事件源 + RPC 状态源）。纯事件溯源靠重放 JSONL 重建状态，pi-desktop 不这么做——resync 是 RPC 拉取 pi 内存状态，不重放文件。设计意图是兼顾两者：冷启动不依赖 pi 进程（秒开文件读），热路径不依赖文件重放（pi 内存里就是最新状态）。代价是两套数据源可能短暂不一致（pi 内存写了但 JSONL 还没刷盘），但 resync 总是拉 pi 内存状态（权威），文件只在 pi 没跑时用。

**Q7：streaming 有三个来源（store 级 streaming、snapshot.state.isStreaming、message.pending），重设计后还是三个，这不是没修吗？**

修了。问题不是"有三个来源"，而是"三个来源不同步"——当前代码只有 store 级 streaming 随事件更新，snapshot.state.isStreaming 只在 resync 时拉到、事件来时不更新。重设计后 `patchStateFromEvent` 让 `agentStart`/`agentSettled`/`agentEnd` 同时更新 `snapshot.state.isStreaming`，两个来源同步变化。三个来源各自服务不同的消费者（store 级给 Composer 按钮、snapshot 级给统计行、pending 给单条消息光标），不是"三个值做同一件事"，是"三个值做三件不同的事，但它们的真值必须一致"。重设计保证了一致性。

**Q8：turnStart/turnEnd 事件和 agentStart/agentSettled 有什么区别？为什么前者没接 UI？**

粒度不同。`agentStart`/`agentSettled` 表示"pi 开始/结束整个工作周期"——粗粒度。`turnStart`/`turnEnd` 表示"一轮对话的开始/结束"——细粒度，一个 agentStart 里可能有多个 turn（如 steer 场景：pi 正在回复，用户 steer 了，pi 当前轮结束、新轮开始）。当前 UI 用 `streaming` 布尔值驱动"thinking"指示器，是粗粒度的——pi 在工作就显示。细粒度的 turn 级指示器（如"第 2 轮"标签）当前没有 UI 组件消费，但事件类型已定义、翻译已有、dispatch 已路由，只差 renderer 的 UI 组件接入。

**Q9：插件注册的 messageRenderer 和 timeline 内置的 if-else 冲突了怎么办？**

不会冲突。注册表查询在 if-else 之前——先查 `getMessageRendererComponent(role)`，找到就用插件的渲染器，找不到再走内置 if-else 链。内置角色（user/assistant/divider/bashExecution）不会出现在 messageRenderer 注册表里——它们的渲染器是 timeline 自己的代码，不经过注册表。messageRenderer 槽位只处理 custom_message 衍生的自定义角色（multi-agent-dashboard、loop-planning 等）。如果某个插件声明了 `role: "assistant"` 的渲染器想覆盖内置的——这不应该被允许，设计上在注册时跳过内置角色的声明（或用优先级规则：内置 if-else 优先于插件注册表）。内置角色的渲染逻辑是 timeline 的核心，不该被外部插件覆盖。

**Q10：ctx.sessions.onEvent 和 ctx.events.on 会不会收到重复的事件？**

不会。两条路径完全独立。`ctx.sessions.onEvent` 收到的是 pi 推的 `SessionEvent`（messageStart/toolCallStart 等），经 `translateEvent` + `dispatch` 路由后透传——这些事件来自 pi 进程，通过 IPC `onEvent` 通道推给 renderer。`ctx.events.on` 收到的是其他插件 emit 的自定义事件（`timeline:bookmarkRequested` 等），经事件总线 `EventBusImpl` 路由——这些事件来自 renderer 侧的插件，不经过 IPC。两个通道的数据格式、来源、消费者都不同，不会重复。

**Q11：session-bookmarks 调 ctx.sessions.copySession + ctx.tree.fork 时，timeline 知道吗？**

timeline 不知道也不需要知道。`copySession` 是文件操作（复制 JSONL 文件），`fork` 是 RPC 命令（发 `fork` 到 pi）。这些操作完成后会有副作用：fork 让底座切到新会话文件，内核对账后 dispatch synthetic sessionStart（底座 `session_start` 是纯扩展事件不上 RPC stdout，真相源单一在 main），timeline 的 `onEvent` 会收到这个事件并更新 ui-store 的 `currentSessionPath`。timeline 不是"被通知 fork 发生了"，而是"收到了事件"——它不关心是谁触发的 fork（是用户点按钮还是 session-bookmarks 调 API），只关心事件来了就更新状态。这是事件驱动的好处：发起方和消费方解耦。

**Q12：跨会话跳转（timeline:scrollTo）在会话切换中间态怎么办？**

用户在会话 A 发 `scrollTo messageId:xxx`，然后立刻切到会话 B。此时 A 的 messages 数组还在 store 里，`findIndex(messageId:xxx)` 可能在 A 里找到——但用户已经看到 B 了，跳转到了错误会话的消息上。设计上的防护是：`scrollTo` 事件携带 `sessionPath` 字段，timeline 收到后检查 `sessionPath === currentSessionPath`，不匹配就忽略。跨会话跳转的正确流程是：先 `ctx.sessions.setContext` 切换会话 → 等 `onSnapshot` 推新基线 → timeline 在 `onSnapshot` 回调里检查待跳转的 messageId → 找到就跳。`scrollTo` 事件不发给旧会话的 timeline 实例——切换会话后 timeline 的 messages 已更新，旧会话的 messageId 不在新数组里，`findIndex` 返回 -1，跳转被忽略。
