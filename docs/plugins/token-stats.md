# token-stats

## 1 这个插件解决什么问题

用户需要知道当前会话消耗了多少 token——输入多少、输出多少、跑了几轮。没有这个插件，用户看不到 token 用量，不知道上下文窗口还剩多少、一次对话花了多少钱。token-stats 订阅事件流，实时累加 token 用量并持久化。

## 2 设计决策

### 2.1 为什么是插件而不是内核

Token 统计的渲染会变——展示格式会调、图表会加。但"能订阅会话事件"这个能力不会变——`sessions.onEvent` 是核心默认能力。渲染是内容，推给插件；事件订阅能力留内核。

### 2.2 选了什么机制

贡献 `sidePanel` 槽位，`order: 50`。零权限——`sessions.onEvent` 和 `config` 都是核心默认能力。零 `configFile`——但用了 `ctx.config.get/set("totals", ...)` 持久化累计统计。这是"零权限、零新 hook 点"的范本——只消费已有能力，不扩展内核。

### 2.3 和框架的分工

框架管：组件注册、`usePluginContext` 上下文绑定、`EmptyState` 空态组件。插件管：事件订阅、token 提取、累加逻辑、持久化、重置。

### 2.4 是否修改了内核

没有。token-stats 只从 `@pi-desktop/react` 导入 `usePluginContext`、`EmptyState`、`registerSidePanelComponent`。不 import `domain/`、`gateway/`、`application/`、`shell/` 的任何文件。删掉这个插件，内核的事件总线、`sessions.onEvent` 订阅机制、`config` 持久化能力全部照常运行——唯一的变化是侧面板少了一个"统计"页签。token-stats 是"零权限、零新 hook 点"的范本——它消费的内核能力（事件订阅 + 配置读写）都是核心默认，删掉它对内核的能力集零影响。
### 2.5 使用了内核的什么功能

- **`ctx.sessions.onEvent(cb)`**（核心默认能力）：订阅底座经 gateway 翻译后的中性事件流。`cb` 接收 `messageEnd`（提 token 用量）和 `agentSettled` / `agentEnd`（本轮结束，并账落盘）。返回取消函数，`useEffect` cleanup 调它——组件卸载后监听器不残留。底层走 gateway 的 event-translator 把底座 JSONL 事件翻译成中性事件，再经 IPC 推到 renderer。插件不感知 JSONL 格式和 gateway 翻译逻辑。
- **`ctx.config.get/set`**（核心默认能力）：读写 `totals` 累计统计。底层走 IPC → main 进程 `ConfigStore` → `writeJsonFile` + `withDirLock`。插件不感知文件路径和锁逻辑。
- **`EmptyState`**（框架共享组件）：所有统计为零时显示"暂无数据"空态。
- **`registerSidePanelComponent`**（框架注册函数）：将 `TokenStatsTab` 注册到侧面板组件注册表。
## 3 怎么通信

### 3.1 和内核通信

走 `usePluginContext("token-stats")` 拿绑定上下文。`ctx.sessions.onEvent(cb)` 订阅事件流——`messageEnd` 事件提 usage，`agentSettled` 事件落盘。`ctx.config.get<Stats>("totals")` / `ctx.config.set("totals", next)` 读写持久化累计。

### 3.2 和其他插件通信

不和其他插件通信。纯消费者——订阅事件、写自己的 config，不广播全局状态。右面板 keep-alive（`forceMount`）保证订阅常驻不丢事件——切到别的页签也不丢。

### 3.3 其他插件怎么使用自己

token-stats 是纯消费者——它订阅事件流、写自己的 config，不广播任何全局状态。没有其他插件依赖 token-stats 的输出。它是侧面板上的一个独立页签，和同面板的其他插件并置但互不依赖。它和以下插件存在概念上的关联但无技术依赖：

- **sessions-list**：用户看 token 统计时，可能对照会话列表确认"是哪个会话消耗了这些 token"——两者无技术依赖，但概念上互补。当前实现是全局累计，未来按会话分桶统计后关联会更紧密。
- **run-panel**：token-stats 统计 token 消耗，run-panel（将来接入时）追踪工具执行——两者都是右面板的"运行时监控"类页签，但各自独立订阅事件流，互不干扰。

插件之间的通信完全通过共享状态或共享事件流，而非直接调用。token-stats 不通过 `useSessionStore` 间接影响其他插件——它只订阅事件、只写自己 config，其他插件的订阅不会因 token-stats 的存在而收到额外更新。
## 4 怎么处理

### 4.1 数据流

不拉数据——纯事件驱动。订阅 `ctx.sessions.onEvent`，每条 `messageEnd` 事件到来时从中提取 token 用量，累加到本轮临时存储（`useRef`）。`agentSettled` 事件到来时把本轮增量并入累计、写回 `ctx.config`。重置按钮清零。

### 4.2 轮次定义

一轮 = `agentStart` 到 `agentSettled`。`messageEnd` 事件带单条消息的 usage，`agentSettled` 标志一轮结束。轮结束时 `turns` 加一（仅当本轮有 token 消耗）。

### 4.3 防御性提取

底座 `messageEnd` 事件的 `message` 字段形状未文档化。`extractUsage` 从多路径尝试提取 token 数：`usage.inputTokens` / `usage.input` / `usage.input_tokens` / `usage.promptTokens`（input），`usage.outputTokens` / `usage.output` / `usage.output_tokens` / `usage.completionTokens`（output）。取不到就计 0——展示仍为 0，不报错。字段确认后只改 `extractUsage` 一处。

## 5 怎么保证

### 5.1 事件监听器清理

`ctx.sessions.onEvent` 返回取消函数，`useEffect` 的 cleanup 调它——组件卸载后监听器不残留。

### 5.2 useRef 防高频重渲染

轮级临时存储用 `useRef`（`turnRef`），不放 `useState`——事件回调里的高频更新不需要触发重渲染。只在 `agentSettled` 时一次性 `setStats`。`statsRef` 保持对当前 stats 的稳定引用——跨事件回调时 `statsRef.current` 始终是最新的，不受闭包陷阱影响。

### 5.3 keep-alive 不丢事件

右面板页签 keep-alive（`forceMount`），切到别的页签时组件不卸载——事件订阅常驻。如果卸载了，切回来期间的事件全丢。这是"事件驱动"架构的必要条件——订阅者必须常驻，不能按需 mount。

## 6 如果没有这个插件，整个系统会有什么影响

内核不崩溃。侧面板失去"统计"页签，用户无法在 pi-desktop 内查看 token 用量——不知道上下文窗口还剩多少、当前会话花了多少 token、对话已经进行了几轮。Agent 功能完全不受影响——底座仍然正常推理，只是用户失去了用量可视化。其他插件不受影响：sessions-list 仍然列出会话、context-files 仍然展示文件树、git-review 仍然显示 diff——它们不依赖 token-stats 的存在。第三方插件完全可以替代：只需贡献同一个 `sidePanel` 槽位、订阅同样的 `ctx.sessions.onEvent` 事件流、实现自己的 token 提取和统计逻辑、使用 `ctx.config` 持久化。内核的事件流对所有人平等开放——token-stats 没有独占任何能力。

## 7 QA

**Q：底座事件字段变了怎么办？**

`extractUsage` 多路径探测，取不到就计 0。用户看到统计不变但不报错。字段确认后改 `extractUsage` 一处即可——这是防御性设计的好处：底座字段变不会让插件崩。

**Q：会话切换后累计还在吗？**

在。累计存在 `ctx.config`（`~/.pi-desktop/plugins-data/token-stats/config.json`），不随会话切换丢失。但当前实现是全局累计，不分会话——所有会话的 token 总数混在一起。标注"演进"：将来可以按会话路径分桶统计。

**Q：重置后持久化的数据也清了吗？**

清了。重置按钮调 `ctx.config.set("totals", ZERO)`——不仅清内存也写文件。下次启动读到的就是 0。
