# token-stats

## 1 这个插件解决什么问题

用户需要知道 token 消耗：当前这轮花了多少、上一轮花了多少、整个会话累计多少、整个项目目录累计多少。没有这个插件，用户看不到 token 用量，不知道上下文窗口还剩多少、一次对话花了多少钱。token-stats 在右面板贡献一个"统计"页签，三层口径各一数据源，实时呈现。

## 2 设计决策

### 2.1 为什么是插件而不是内核

Token 统计的渲染会变——展示格式会调、图表会加。但"能订阅会话事件"这个能力不会变——`sessions.onKernelEvent` 是核心默认能力。渲染是内容，推给插件；事件订阅能力留内核。

### 2.2 三层口径，一层一源，不跨层校准

面板分三层，每层只认一个数据源，互不校准（校准意味着发明第四个口径）：

- **本轮 live**：事件流累计。订阅 `ctx.sessions.onKernelEvent`（运维流，全量会话带 sessionKey 归属），只累计当前 sessionKey 的 `messageEnd` usage。运行时内存态，重启即空。
- **本会话**：会话投影 stats（`useSessionStore((s) => s.stats)`）。框架统一拉取/刷新/切会话失效，插件只读——插件不自己发 `getStats` 查询（启动零查 pi，未就绪不发）。
- **项目总**：`ctx.sessions.projectStats(cwd)` 聚合本 cwd 全部会话 JSONL 的文件真值，含 app 未运行期的消耗。真值不可"重置"，故无清零按钮——要清零去删会话文件。刷新时机：挂载/切项目/任一会话一轮结束（`agentEnd`/`agentSettled`），scanner 有增量缓存，重扫廉价。

### 2.3 翻轮（rollover）唯一时机 = agentStart

"本轮"和"上一次"的交接只发生在 `agentStart`：上一轮 totals 归档为"上一次"，本轮清零重新累计。本轮值在轮结束后持续可见，直到下一轮开始。

**勿在 `agentEnd`/`agentSettled` 翻轮**（根因标注，勿回退）：底座每轮同帧连发这两个事件（`messageEnd` → `agentEnd` → `agentSettled`），若两个都触发翻轮，先到者归档并清零、后到者用已清零的累计器再覆盖一次——"上一次"恒为 0（双发覆盖 bug 实测）。且 usage 只在 `messageEnd` 落地（流式期间无增量 usage 可取），settle 即清会让"本轮"在整个生成期间恒为 0。

归档有守卫：上一轮有真实 token 消耗才覆盖"上一次"——用户中止的空轮（无 `messageEnd`）不会把有效历史抹成 0。

### 2.4 数字格式化

- 计数（token/轮次/会话数）：K/M/B 人性化 + 两位小数（`1234 → "1.23K"`）。token 是计数不是字节，单位用 K/M/B 不用 KB/MB/GB。
- TPS：两位小数（`45.67 t/s`）。TPS 底座不给，桌面端自算 = `output tokens / messageStart→messageEnd 耗时`，即**输出（生成）速度**。
- 费用：≥ $0.01 两位小数；亚分金额（< $0.01）留 4 位——`toFixed(2)` 会把 $0.0043 显示成 $0.00，看起来像没数据。

### 2.5 是否修改了内核

没有。token-stats 只从 `@pi-desktop/react` 导入 `usePluginContext`、`useUiStore`、`useSessionStore`、`EmptyState` 和 `ProjectStats` 类型。删掉这个插件，内核照常运行——唯一的变化是右面板少了一个"统计"页签。

## 3 怎么通信

### 3.1 和内核通信

走 `usePluginContext()` 拿绑定上下文（pluginId 框架注入）。消费两个核心默认能力，零权限声明、零持久化：

- **`ctx.sessions.onKernelEvent(cb)`**：订阅运维流。`messageStart` 记时（按 sessionKey 分桶，多会话并存不串）、`messageEnd` 提 usage 累计、`agentStart` 翻轮、`agentEnd`/`agentSettled` 触发项目总重扫。返回取消函数，`useEffect` cleanup 调它。
- **`ctx.sessions.projectStats(cwd)`**：一次性 RPC，聚合本 cwd 全部会话文件。

### 3.2 和其他插件通信

不和其他插件通信。纯消费者——订阅内核事件、读框架 store（只读），不广播任何状态。右面板页签 keep-alive（`forceMount`）保证订阅常驻，切页签不丢事件。

## 4 怎么处理

### 4.1 数据流

纯事件驱动，不轮询。每条当前会话的 `messageEnd` 到来时提取 usage 累加进 `turnRef`，并 `setTurnLive` 镜像给渲染层；`agentStart` 翻轮归档；`agentEnd`/`agentSettled` 重扫项目总。

### 4.2 轮次定义

一轮 = `agentStart` 到下一轮 `agentStart`（或会话切换）。`messageEnd` 带单条消息的 usage（仅 assistant 消息有），本轮累计 = 轮内全部 `messageEnd` usage 之和。steer/followUp/自动重试/压缩续跑都在同一轮内（底座不因此重发 `agentStart`）。

### 4.3 usage 形状（底座实测，2026-07）

`message.usage = {input, output, cacheRead, cacheWrite, cost, totalTokens}`，仅挂在 assistant 消息上；abort 的消息可能没有 usage。`cost` 是分解对象 `{input, output, cacheRead, cacheWrite, total}`——取 `cost.total`（旧版数字形态兜底）。解析在插件侧 `extractUsage` 一处；文件基线侧另有圆心 `messageUsageOf`（session-scanner/project-stats 共用）。

## 5 怎么保证

### 5.1 事件监听器清理

`ctx.sessions.onKernelEvent` 返回取消函数，`useEffect` 的 cleanup 调它——组件卸载后监听器不残留。

### 5.2 sessionKey 匹配

运维流是全量会话的事件，插件只累计当前会话：`sessionKey = currentSessionPath ?? new:${cwd}`（与 main 侧 procs Map key 同构），事件按 `event.sessionKey` 过滤。切会话/切项目时重置本轮与上一次（不留旧会话残值）。

### 5.3 keep-alive 不丢事件

右面板页签 keep-alive（`forceMount`），切到别的页签时组件不卸载——事件订阅常驻。事件驱动架构的必要条件：订阅者必须常驻，不能按需 mount。

## 6 如果没有这个插件，整个系统会有什么影响

内核不崩溃。右面板失去"统计"页签，用户无法查看 token 用量与上下文占比。Agent 功能完全不受影响。第三方插件完全可以替代：贡献同一个 `sidePanel` 槽位、订阅同样的 `onKernelEvent` 流、实现自己的统计逻辑——内核的事件流对所有人平等开放。

## 7 QA

**Q：底座事件字段变了怎么办？**

`extractUsage` 取不到就计 0——展示仍为 0，不报错。字段确认后改 `extractUsage` 一处。

**Q：为什么"本轮"在流式期间长时间显示 0？**

usage 只在 `messageEnd` 落地（底座不提供增量 usage），流式期间无数据可累计。含工具调用的轮次里，首个 assistant `messageEnd` 之后"本轮"即有累计值并持续到轮结束。

**Q："上一次"为什么重启后为空？**

本轮/上一次是运行时内存态（事件流累计），不落盘。跨重启的历史消耗看"项目总"——那是文件真值聚合。
