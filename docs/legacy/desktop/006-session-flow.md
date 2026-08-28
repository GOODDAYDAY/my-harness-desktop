# 006 会话流：事件溯源与状态投影

> ⚠ **历史稿**：本文是 pre-多内核 的 pi-only 旧术语稿（"底座"/旧"内核"=壳机制），术语与架构以 CLAUDE.md + kernel-design-spec.md + core-spec.md 为准，本文保留作历史参考。

## 1 本质：事件溯源 + 状态投影

会话流的数据模型不是 my-harness-desktop 的发明。打开任何聊天应用——ChatGPT、Slack、Cursor——底层都是同一套：事件溯源 + 状态投影。

在 my-harness-desktop 里，JSONL 会话文件是事件存储（每一行是一条事件，追加写、流式读），pi 底座进程是事件源（产出事件、写进文件、同时经 stdout 推给桌面端），renderer 的 zustand store 是读模型（订阅事件流、增量应用、驱动 React 重渲染）。三者的角色不会变——无论 pi 底座换成什么、renderer 换成什么框架、JSONL 文件换成什么存储格式，这个三角关系是会话流的业务本质。

严格说，my-harness-desktop 不是纯事件溯源。纯事件溯源靠重放事件重建状态，my-harness-desktop 的状态权威在 pi 进程内存里。resync 是 RPC 拉取 pi 的内存状态（4 个 RPC 并发：`get_state` + `get_entries` + `get_tree` + `get_commands`，见 `src/core/application/orchestrations/resync.ts`），不是重放 JSONL 文件。JSONL 文件是持久化层（冷启动读、跨重启恢复），pi 进程是运行时权威（热路径事件源 + RPC 状态源）。设计意图是兼顾两者：冷启动不依赖 pi 进程（秒开文件读），热路径不依赖文件重放（pi 内存里就是最新状态）。代价是两套数据源可能短暂不一致（pi 内存写了但 JSONL 还没刷盘），但 resync 总是拉 pi 内存状态（权威），文件只在 pi 没跑时用。

## 2 流水线：端到端的完整链路

从 pi 底座的标准输出到 renderer 的 React 组件，一条 JSONL 行经过七个环节，每个环节只做一件事。

### 2.1 底座 stdout → RpcAdapter 分帧

pi 底座以 `pi --mode rpc` 启动后，stdout 持续吐 JSONL 行。`RpcAdapter` 的 `attachJsonlLineReader`（`src/client/pi/rpc-adapter.ts`）做 LF-only 分帧——自己用 `StringDecoder` 解析字节流，按 `\n` 切行，不用 Node 的 `readline`。`readline` 是事件驱动的通用行读取器，自带缓冲和行事件派发，层太厚。LF-only 分帧是几十行自写代码，不引入额外依赖、不引入额外缓冲层。

### 2.2 RpcAdapter.handleLine 分类

`handleLine`（`rpc-adapter.ts:160`）对每行 JSON 做分类，分四条路径：

- **`extension_ui_request`**——pi 底座需要用户交互（确认、选择、输入）。`RpcAdapter` 启动 60 秒超时计时器，转发给 `extUiListeners`。超时自动回 `cancelled: true`，防止底座永远阻塞。
- **`response`**（带 `id`）——RPC 命令的返回值。走 `RequestCorrelator` 配对，resolve 对应的 pending Promise。`correlator` 也管 30 秒超时——命令发出去后 30 秒没回 response 就 reject。
- **`extension_ui_response`**——桌面端发给底座的回复，在 stdout 上看到时忽略（回声）。
- **其余行**——全部当 `AgentSessionEvent` 转发给 `eventListeners`。

四条路径的优先级顺序是：先查 `extension_ui_request`（最高优先，底座在阻塞等待），再查 `response`（按 id 配对），其余当 event。这个顺序不靠运气——`extension_ui_request` 优先保证了底座不会因为 event 洪峰而卡死。

### 2.3 translateEvent：snake_case → camelCase

`translateEvent`（`src/core/protocol/event-translator.ts`）把底座的 snake_case 事件 type（`tool_execution_start`）翻译成圆心的 camelCase（`toolCallStart`）。翻译靠一张静态映射表 `TYPE_MAP`，23 种事件类型一一对应。

翻译后的事件 type 用中性名，其余字段原样保留（底座已用 camelCase 命名字段）。有两个例外处理：

- **`session_info_changed`**——底座字段叫 `name`，圆心契约叫 `sessionName`。翻译器做字段映射：`name` → `sessionName`，空名规约为 `undefined`。此前原样透传导致 renderer 永远读到 `undefined`（根因见 `docs/design/session-name-tracks.md` §3.4），已修复。
- **消息载体事件**（`messageStart`/`messageUpdate`/`messageEnd`）——翻译器对 `message` 字段做 `withErrorState` + `withNormalizedToolCalls` 归一化（`domain/events/session-state.ts` 内定义）。失败消息统一标 `error` 标记，工具调用归一化为 `ToolCallBlock[]`，和文件读路径同规则——不管事件流的还是文件读的，进 renderer 前消息形状一致。

未识别的 type 原样透传（`TYPE_MAP[piEvent.type] ?? piEvent.type`）——底座新增事件类型时翻译表不更新也不会丢数据，只是 type 名保持底座的原始 snake_case。

### 2.4 SessionStore.dispatch 路由

`dispatch`（`src/core/application/sessions/session-store.ts:907`）是 main 进程的事件路由核心。它做四件事：

1. **`sessionStart` 捕获**——从事件里取 `sessionFile`，更新 `proc.boundSessionPath`。如果是激活会话，同步更新 `activeSessionPath`。`dispatch` 同时有两个异步消费方（视图流 `listeners` + 运维流 `keyedListeners`），而 `sessionStart` 下的 boundSessionPath 写动作是同步的——保证两个异步方无论谁先执行，拿到的路径都已是落定的值（不依赖竞态先后）。

2. **busy 状态记账**——`agentStart`/`autoRetryStart`/`compactionStart` 设 `busyStates.set(key, true)`，`agentSettled`/`compactionEnd` 设 `false`。busy 状态被 `restart-coordinator` 消费——只有非 busy 的会话才能安全重启。

3. **TPS 自算**——`messageStart` 记 `genStartMs`，`messageEnd` 用 `extractOutputTokens` 多路径提取 output tokens（底座字段形状未文档化：`usage.outputTokens`/`output`/`output_tokens`/`completionTokens`），算出 `lastTps`。

4. **事件路由**——流式增量事件只转发激活会话（`key !== activeProcKey` 就 return），定稿/轮结束/新文件事件全转发。路由判断在 `dispatch` 里，不在 IPC 层——IPC 只管透传。

事件路由分两条流：
- **视图流**（`listeners`，即 `onEvent` 回调）——只收激活会话的事件。后台会话的任何事件都不得污染当前视图。
- **运维流**（`dispatchKernel` + `keyedListeners`）——激活会话全量事件；后台会话只收生命周期事件（`messageEnd`/`agentSettled`/`agentEnd`/`sessionStart`），不转流式增量。列表刷新/统计/restart 等只需要生命周期事件。

### 2.5 IPC 桥 → renderer store

main 进程的 `registerSessionsIpc`（`src/api/ipc/sessions.ts`）把 `onEvent`/`onSnapshot`/`onKernelEvent` 三个回调注册为 Electron IPC 广播——每个回调触发时用 `BrowserWindow.getAllWindows().forEach(w => w.webContents.send(...))` 推到所有 renderer 窗口。

renderer 的 `initSessionStore`（`src/api/renderer/stores/session-store.ts:431`）在应用启动时调一次，绑定两个通道：

- **`onSnapshot`**——收到新基线时替换 `snapshot` + `messages` + `streaming`，刷新 stats 和 thinkingLevels。同时递增 `syncNonce`，timeline 依赖它重置滚动位置。
- **`onEvent`**——收到事件时调 `patchStateFromEvent`（增量 patch `snapshot.state`）+ `applyEvent`（增量 patch `messages`）+ 更新 `streaming`。`compactionEnd` 触发 `sync()` 重拉基线（压缩改变了消息列表）。`messageEnd`/`agentSettled`/`agentEnd` 触发 `refreshStats()`。

两个纯函数并排：
- `patchStateFromEvent`——覆盖 9 种事件（modelSelect、thinkingLevelChanged/thinkingLevelSelect、agentStart/agentSettled/agentEnd/autoRetryStart/autoRetryEnd、compactionStart/compactionEnd、sessionStart、sessionInfoChanged、queueUpdate），返回新的 `SessionState` 或 `null`（该事件不影响 state）。
- `applyEvent`——处理 messageStart/messageUpdate/messageEnd/entryAppended 四种事件，按 messageId 精确 patch 消息数组。

### 2.6 组件只读 store

组件通过 `useSessionStore`（zustand hooks）读状态——`messages`、`snapshot`、`streaming`、`stats`。组件不自己拉数据、不自己调 `sync()`、不自己算 stats——全部由框架在事件到来时统一更新。此前 timeline 自己在 `useEffect` 里调 `getStats`、自己维护 stats state、自己挑事件刷新——收敛后插件零拉取、零刷新时机、零失效维护。

## 3 三条通信路径：命令提交 / 事件推送 / 主动拉取

会话流在 renderer 和 pi 之间有三条通信路径，各自有不同的语义和可靠性保证：

### 3.1 命令提交（renderer → pi）

`setModel` → `RpcAdapter.send(buildSetModelCommand)` → pi stdin（JSONL 一行）。这条路径是同步的：`adapter.send` 返回 Promise，resolve 意味着 pi 处理完了这条命令。可靠性由 `RequestCorrelator` 保证——id 配对 + 30s 超时 + 进程退出时 `rejectAll`。

### 3.2 事件推送（pi → renderer）

pi stdout → JSONL reader → `translateEvent` → `dispatch` → IPC `onEvent` → `patchStateFromEvent` + `applyEvent`。这条路径是尽力而为的：pi 决定推什么、什么时候推、推不推。renderer 是被动接收方。

### 3.3 主动拉取（renderer → pi → renderer）

`sync()` → `resync(adapter)` → 4 个 RPC 并发（`get_state` + `get_entries` + `get_tree` + `get_commands`）→ 组装 `SyncSnapshot` → `onSnapshot` 广播 → store 替换基线。这条路径是确定性的：拉到的是 pi 的权威状态，不依赖事件是否推过来。

三条路径不是备选关系，是互补关系。事件推送做实时（快但不保证完整），命令提交做控制（确定但只管发不管收），主动拉取做校正（确定且完整但慢）。`setModel` 发送后走"命令提交 + 事件推送 + 主动拉取"三路径：

```
用户选模型
  → setModel 命令发到 pi（命令提交）
  → 命令 resolve 后 sync 拉基线（主动拉取校正，fire-and-forget，不阻塞调用方）
  → pi 可能也推 modelSelect 事件（事件推送补充）
  → 两条路径都能更新 snapshot.state.model
```

关键设计是 `setModel` 里 `void this.sync().catch(() => {})`（`session-store.ts:599`）——命令后校正走 fire-and-forget，不阻塞 UI。同时事件增量通道保留——谁会更新 `snapshot.state.model` 取决于谁先到，结果一致。

## 4 冷启动路径：文件读

### 4.1 JSONL 格式与三层映射

会话文件是 JSONL——每行一个 JSON 对象。第一行是头行（`{type:"session", id, timestamp, cwd, name?, pinned?, archived?}`），其余行是条目。`readSession`（`session-scanner.ts`）读全文件，每行经 `sessionEntryToNeutral`（`src/core/domain/events/session-state.ts:217`）映射成 `NeutralMessage`，分三层：

- **内容层**——`message` 和 `custom_message`（`display !== false`）映射为可显示的消息。`message` 条目拆出内嵌的 `AgentMessage`（role + content），`custom_message` 条目按 `customType` 决定 role。
- **分隔层**——`model_change`、`thinking_level_change`、`compaction`、`branch_summary`、`session_info`、`label` 映射为 `role: "divider"` 的分隔线条目，带 `kind`、`i18nKey`、`i18nArgs`。圆心只产中性结构（key + args），文案由渲染层查 i18n。
- **隐藏层**——`custom`（扩展私有状态，如 plan-mode-state）和 `session`（头行）返回 `null`，不进时间线。`custom_message` 且 `display === false` 也返回 `null`。

`sessionEntryToNeutral` 是纯函数——不管从文件读还是从事件流收，同一条条目映射出的 `NeutralMessage` 完全一致。

### 4.2 去重策略

`deduplicateAdjacent`（`session-state.ts:306`）做两层去重：

- **标准角色**（user/assistant/toolResult/divider）只做相邻去重——前一条和当前条 role 相同、content 相同时跳过。不做全量去重，因为用户可以合法地连续发送相同内容。
- **非标准角色**（不在 `STANDARD_ROLES` 集合里的所有 role）做全量去重——维护一个 `Set<role::contentKey>`，重复的只保留第一条。

去重在两个地方调用：`readSession`（文件读后）和 `resync`（RPC 拉取后）。事件流增量路径（`applyEvent`）不调去重——增量 patch 是按 id 精确定位的，不产生重复。

### 4.3 会话扫描与列表

`listSessions`（`session-scanner.ts:92`）扫某 cwd 桶下的所有 `.jsonl` 文件。目录结构按 cwd 分桶——桶名是 `--<cwd 去掉首斜杠、斜杠换横线>--`。排序键是 `lastEntryTime`（倒序找第一个带 timestamp 的行），不是文件 mtime——重命名改写文件会刷 mtime，按 mtime 排会把改名的顶到最上。

名字读取走单轨：`extractSessionInfoName` 在文件内容里找最后一条 `session_info` 条目（名字唯一真相源），无条目即无名、展示层经 `deriveSessionTitle` 回退。头行不存 name（desktop 私有数据统一进 `custom-my-harness-desktop`）。见 `docs/design/session-name-tracks.md` §7。

## 5 五个结构性缺陷与修复

`docs/design/session-flow-architecture.md` §1.2 诊断了当前代码的五个结构性缺陷。以下是每个缺陷的根因和修复后的落地代码。

### 5.1 延迟对齐：选择即提交

**原问题**。用户在 UI 选了模型，`pickModel` 只写 ui-store 偏好 + electron-store，不调 `setModel`。真正的切模型被塞进 `send()` 里，等用户按发送键才执行。结果是 UI 显示新模型名，pi 实际跑的仍是旧模型。

**修复**。`setModel`（`session-store.ts:583`）调 `ensureForSend()`——pi 没跑就起，pi 在跑就发命令，不等到发送。`pickModel` 立即调 `setModel`（模型选择即立即通知底座），命令 resolve 后 `void this.sync()` 做 fire-and-forget 校正。

`ensureForSend` 的关键设计是"pi 没跑时也起"——旧的 `setModel` 检查 `alive` 没活就静默 return，冷启动首条消息的 pref flush 被吞，会话开在 settings.json 默认模型上。现在和 `cycleModel` 同行为——没活就起，起来后发命令。

### 5.2 状态投影不完整：patchStateFromEvent 全覆盖

**原问题**。`onEvent` 回调里对 `snapshot.state` 的增量更新只处理了 `modelSelect` 一种事件。`thinkingLevelChanged`、`thinkingLevelSelect`、`compactionStart`、`compactionEnd`、`sessionStart`、`sessionInfoChanged`、`queueUpdate`——七种直接影响 `SessionState` 的事件全部漏了。用户改了思考强度必须重新加载会话才能看到。

**修复**。`patchStateFromEvent`（`api/renderer/stores/session-store.ts:113`）现在是一个 `switch(event.type)` 覆盖 9 种事件，返回新的 `SessionState` 或 `null`（该事件不影响 state）：

| 事件 | 更新的 state 字段 |
|---|---|
| `modelSelect` | `model` |
| `thinkingLevelChanged` / `thinkingLevelSelect` | `thinkingLevel` |
| `agentStart` | `isStreaming = true` |
| `agentSettled` / `agentEnd` | `isStreaming = false` |
| `autoRetryStart` | `isStreaming = true` |
| `autoRetryEnd`（success !== true） | `isStreaming = false` |
| `compactionStart` | `isCompacting = true` |
| `compactionEnd` | `isCompacting = false` |
| `sessionStart` | `sessionFile` |
| `sessionInfoChanged` | `sessionName` |
| `queueUpdate` | `pendingMessageCount` |

### 5.3 依赖事件回传：命令后 sync 校正

**原问题**。`setModel` 之后代码依赖 pi 推 `modelSelect` 事件来更新 snapshot。但 pi 的协议不保证推事件——它可能推、可能不推、可能延迟推。把状态同步的可靠性赌在"对方一定会推事件"上是双重不可靠。

**修复**。不靠事件回传。`setModel` 命令 resolve 后自己拉一次 baseline——`void this.sync().catch(() => {})`。`sync` 是确定性的：RPC resolve 意味着 pi 处理完了命令，拉到的是 pi 处理完命令后的权威状态。事件增量通道仍然保留——如果 pi 推了 `modelSelect` 事件，`patchStateFromEvent` 也会更新 `snapshot.state.model`。两条通道互补，不互相依赖。

### 5.4 streaming 双源：patchStateFromEvent 统一

**原问题**。流式状态被存在两个地方：`useSessionStore.streaming`（由 `agentStart`/`agentSettled` 事件设置）和 `snapshot.state.isStreaming`（resync 时拉到，事件来时从不更新）。两个值可以不一致——store 说 `streaming = true`，snapshot 说 `isStreaming = false`。

**修复**。`patchStateFromEvent` 让 `agentStart`/`agentSettled`/`agentEnd` 同时更新 `snapshot.state.isStreaming`。两个来源同步变化。三者各管一摊：store 级 `streaming` 给 Composer 发送/停止按钮，`snapshot.state.isStreaming` 给统计行，`message.pending` 给单条消息的流式光标。三者不再混用。

### 5.5 事件类型覆盖不全：部分修复

23 种事件类型定义在 `SessionEvent` 联合里（`domain/events/session-state.ts` 的判别联合 + `autoRetryStart`/`autoRetryEnd`），经 `TYPE_MAP` 翻译、`dispatch` 路由后全部能到 renderer。但 UI 响应仍有缺口：

- **已覆盖**——`messageStart`/`messageUpdate`/`messageEnd`（`applyEvent` 增量 patch）、`agentStart`/`agentSettled`/`agentEnd`（`streaming` 状态 + `patchStateFromEvent`）、`modelSelect`/`thinkingLevelChanged`/`thinkingLevelSelect`（`patchStateFromEvent`）、`compactionStart`/`compactionEnd`（`isCompacting` 状态）、`sessionStart`（`sessionFile` 水合）、`sessionInfoChanged`（`sessionName` 更新）、`entryAppended`（`applyEvent` 增量追加）。
- **未覆盖**——`turnStart`/`turnEnd`（一轮对话的开始/结束，无 UI 指示器）、`autoRetryStart`/`autoRetryEnd`（重试指示器，有状态更新无可见 UI）、`queueUpdate`（待处理消息数，有状态更新无可见 UI）。这些事件的类型定义、翻译映射、dispatch 路由都有，只差 renderer 的 UI 组件接入。

## 6 追加原语：appendJsonlLine

### 6.1 为什么需要第四个原语

`config-file.ts`（`src/core/application/config/config-file.ts`）原有三个原语：`withDirLock`（锁目录）、`readJsonFile`（整读 JSON）、`writeJsonFile`（整写，deep/replace 两种模式）。它们服务 settings.json、models.json 这类"整份读改写"的配置文件。

会话文件是 JSONL——append-only，读是流式的，写是追加的。用 `writeJsonFile` 写会话文件在两个维度上都是错的：语义上，整份覆盖违背 JSONL 的格式契约；并发上，"读-改-写"在 pi 进程持续追加的背景下必然丢行——desktop 读完旧内容、pi 追加一行、desktop 把旧内容写回去，pi 那行被吞。

### 6.2 原语签名与设计

`appendJsonlLine`（`config-file.ts:64`）的签名：

```typescript
export async function appendJsonlLine(
  absPath: string,
  entry: Record<string, unknown>,
): Promise<void>
```

关键设计决策：

- **entry 开放形状**——原语中性。原语不认识 `custom_message`、`subagent_spawned` 等业务概念，那些是内容层的事。
- **序列化不带缩进**——`JSON.stringify(entry)` 不加第三参数。JSONL 的格式定义是每行一条 JSON，带缩进的多行 JSON 是格式错误。
- **换行边界三形态**——追加前读文件尾 1 个字节判断是否需要补 `\n`。文件为空直接写；尾字节是 `\n` 直接写；尾字节不是 `\n`（写入中途崩溃的残留），补一个 `\n` 再写。
- **文件不存在则创建**——对齐 `writeJsonFile` 的创建语义。

### 6.3 两个写入者模型与并发安全

会话文件的写者不止 desktop。pi 进程从会话开始到结束一直在往文件追加。`withDirLock` 是 advisory lock（基于 `proper-lockfile`），只约束愿意配合的写者——pi 不在锁内。

并发安全靠三层：

1. **同锁串行 desktop 写者**——`appendJsonlLine` 和 `updateSessionHeader`（整份读-改-写）共用同一把目录锁，互不吞行。
2. **O_APPEND 兜住 pi 写者**——pi 每次写带 `O_APPEND` 标志，单次 write 行内不撕裂。两个进程同时追加，行与行可能交错出现，但任何一行内部不会撕裂。
3. **读取侧容忍兜底**——`readSession` 解析 JSONL 时空行跳过、单行 JSON 损坏跳过，不拖垮整体读取。

### 6.4 接入路径

原语有三条接入路径：pi extension → custom 通道 method 分派（extension 构造条目、desktop 做追加）、renderer 插件 → `config-file:append` IPC（共享白名单校验）、main 内部 → 直接 import（崩溃清理场景）。详见 `docs/design/session-jsonl-append.md` §5。

## 7 显示名单轨化与列表排序稳定化

两个独立问题，各自有完整的设计文档。这里只提炼对会话流有影响的结论。

### 7.1 显示名单轨化

会话名只存底座 `session_info` 条目一条轨道（RPC `set_session_name`、autoName、非活跃改名都写这里）。头行 `header.name` 轨道已删除——desktop 私有数据统一进 `custom-my-harness-desktop`，名字回归底座正式轨道。`docs/design/session-name-tracks.md` §7 做了以下收敛：

- **读端单轨**——`extractSessionInfoName`（`session-scanner.ts`）以最后一条 `session_info` 条目为准（trim 空 = 显式清除），无条目即无名。
- **非活跃 rename 纯追加**——只追加 `session_info` 条目，不写头行（name-only 走 append 快路径）。活跃路径维持纯 RPC 不动文件（避免读-改-写竞争）。
- **打开即补命名**——`SessionStore.openSession` → `nameOnOpenIfMissing`（`session-store.ts`）。CLI 建的会话无名时，用首条 user 消息派生名字，追加 `session_info` 条目。
- **autoName 触发条件修正**——从"新会话才命名"改为"活跃会话还没有名字就命名"（`session-store.ts`）。CLI 建、desktop 打开续聊的会话首次发送即获首句名。
- **派生名回退**——`deriveSessionTitle`（`domain/sessions.ts`）：自定义名 → lastMessage 截断 → id 前 8 位。不再用创建日期兜底。

### 7.2 列表排序稳定化

`docs/design/session-list-order-bookmark-fork.md` 修复了并行会话列表乱跳的问题：

- **排序从 `modified` 改为 `created`**——sessions-list renderer 在 `buildGroups` 前按 `created` 降序重排，组内再应用自定义序。`created` 是文件落盘后就恒定的值，列表不再自己动。
- **新会话永远顶到组首**——不在自定义数组里的会话按 `created` 降序置顶。
- **组内拖拽自定义顺序**——持久化到 sessions-list 的项目级 config（`<cwd>/.my-harness-desktop/config/sessions-list.json`），每次 reload 原样恢复。
- **收藏 fork 闭环**——fork 完成后自动切到新会话（`setContext`）、timeline 滚动到锚点消息（`timeline:scrollTo` invoke）、toast 提醒。

## 8 性能：从组件拉取到单 store 事件增量

### 8.1 原架构：组件各自拉数据

修复前，timeline 和 token-stats 插件各自在 `useEffect` 里调 `getStats`，各自维护 stats state，各自挑事件（`messageEnd`/`agentSettled`）刷新。同一个 `getStats` RPC 被调了两遍，两边的 stats state 可能不一致（一个切会话清了旧值，另一个残留）。这是"拉取式架构"的典型熵增——每个消费者各自拉，拉取时机各自定，数据一致性靠运气。

### 8.2 新架构：单 store + 事件增量

修复后，`useSessionStore` 是唯一的 stats 真相源。框架在以下时机统一拉取 `getStats` 并写入 store：

- **`onSnapshot`**——基线到达时拉（`refreshStats`，`session-store.ts:288`）。
- **`onEvent` 收到 `messageEnd`/`agentSettled`/`agentEnd`**——轮次结束时拉。

两个刷新点覆盖了 stats 需要更新的全部时机。插件不自己拉——timeline 和 token-stats 只读 `useSessionStore.stats`。防竞态代际 `sessionGen` 保证了切会话后旧 RPC 的回值不会写回。

### 8.3 waitReady 零固定 sleep

`waitReady`（`session-store.ts:410`）不用固定 sleep 赌就绪。策略是"事件驱动优先 + 实证探测兜底"：

- **事件驱动优先**——`sessionStart` 事件是底座跑通后第一时间推的就绪信号，到立即返回，不等 150ms。
- **实证探测兜底**——`sessionStart` 未达或 150ms 内没来，发 `get_state` RPC 探测。首个成功即返回。
- **4 秒超时兜底**——超时也继续，让后续 `sync()` 的真实错误冒出去，不在此掩盖。

此前有两个固定 sleep（100ms 等进程启动、500ms 等就绪），慢机上 sleep 不够会偶发 bug，快机上 sleep 是白等。全部删除。

### 8.4 rAF throttle 防高频抖动

流式期间 `messageUpdate` 高频到达——底座每生成一个 token 就推一次 update。`applyEvent` 每次创建新数组，高频 setState 会引发渲染抖动。当前在 store 层做 `requestAnimationFrame` batch——16ms 内到达的多个 update 合并成一次 setState，每帧只渲染一次。

## 9 多会话进程调度

my-harness-desktop 的进程模型是"会话是文件，进程是临时工"。会话的持久形态是 JSONL 文件——打开历史会话是纯文件读，不启 pi 进程，秒开。pi 进程是按需的临时工——只有发消息时才起进程。

`procs`（`Map<string, SessionProc>`）是全部活着的 pi 进程。`setContext` 设激活但不杀其他进程——用户可以在会话 A 发了消息，切到会话 B 发消息，切回会话 A 时 pi 还在跑、上下文还在。

`ensureForSend` 是发送路径的进程保证——pi 没跑就起，pi 在跑就复用。新会话生成文件路径（ISO timestamp + uuid），传给 pi 的 `--session` 参数。

`dispatch` 的事件路由纪律是多会话并存的核心——流式增量只转发激活会话，定稿事件全转发。前者防止后台会话的 `messageUpdate` 刷屏 IPC，后者保证列表的 modified 时间和消息数总是对的。

## 10 进程就绪与 resync 触发时机

`waitReady` 确认 pi 进程就绪后，`start` 调 `sync()` 拉一次基线（4 RPC 并发）。这是冷启动到热路径的唯一切换点。

resync 在其他场景也触发：
- **命令 resolve 后**——`setModel`/`setThinkingLevel` 的 `.then(() => sync())`。
- **压缩完成后**——`onEvent` 收到 `compactionEnd` 触发 `sync()`。压缩改变了消息列表，必须全量重拉。
- **显式刷新**——用户点刷新按钮。
- **会话切换时**——切回正在跑的会话，resync 拿实时状态。

不该触发 resync 的场景：消息流式更新（`messageUpdate`）。流式增量靠 `applyEvent` 按 id patch，全量重拉会闪烁、丢失滚动位置、浪费 RPC。

---

### 架构自检
- [x] 高内聚：各模块职责单一、边界清晰（文档准确反映代码结构）
- [x] 低耦合：依赖最小化，通过接口而非具体实现（文档描述的依赖倒置与代码一致）
- [x] 开闭原则：新逻辑通过扩展实现，未修改已有稳定代码（文档描述的事件体系扩展点与代码一致）
- [x] 方案视角：解决根本问题，而非打补丁（文档以根因分析为线索组织内容）
- [x] 洋葱架构：依赖只向内，会变的细节推外层（文档映射的六区职责与 DESIGN.md §6 一致）

### 修改文件清单
本次仅创建 docs/desktop/006-session-flow.md（未提交）
