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

## 3 怎么通信

### 3.1 和内核通信

走 `usePluginContext("token-stats")` 拿绑定上下文。`ctx.sessions.onEvent(cb)` 订阅事件流——`messageEnd` 事件提 usage，`agentSettled` 事件落盘。`ctx.config.get<Stats>("totals")` / `ctx.config.set("totals", next)` 读写持久化累计。

### 3.2 和其他插件通信

不和其他插件通信。纯消费者——订阅事件、写自己的 config，不广播全局状态。右面板 keep-alive（`forceMount`）保证订阅常驻不丢事件——切到别的页签也不丢。

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

## 6 QA

**Q：底座事件字段变了怎么办？**

`extractUsage` 多路径探测，取不到就计 0。用户看到统计不变但不报错。字段确认后改 `extractUsage` 一处即可——这是防御性设计的好处：底座字段变不会让插件崩。

**Q：会话切换后累计还在吗？**

在。累计存在 `ctx.config`（`~/.pi-desktop/plugins-data/token-stats/config.json`），不随会话切换丢失。但当前实现是全局累计，不分会话——所有会话的 token 总数混在一起。标注"演进"：将来可以按会话路径分桶统计。

**Q：重置后持久化的数据也清了吗？**

清了。重置按钮调 `ctx.config.set("totals", ZERO)`——不仅清内存也写文件。下次启动读到的就是 0。
