# token-stats

## 1 这个插件解决什么问题

用户需要知道 token 消耗：当前这轮花了多少、上一轮花了多少、整个会话累计多少、整个项目目录累计多少。没有这个插件，用户看不到 token 用量，不知道上下文窗口还剩多少、一次对话花了多少钱。token-stats 在右面板贡献一个"统计"页签，三层口径各一数据源，实时呈现。

## 2 设计决策

### 2.1 为什么是插件而不是内核

Token 统计的渲染会变——展示格式会调、图表会加。但"会话统计投影"这个能力不会变——`SessionStats` 投影是框架的统一产出。渲染是内容，推给插件；统计投影留内核。

### 2.2 三层口径，一层一源，不跨层校准

面板分三层，每层只认一个数据源，互不校准（校准意味着发明第四个口径）：

- **本轮/上一次**：会话投影 `stats.turn` / `stats.lastTurn`（`useSessionStore((s) => s.stats)`）。累计在 main 侧 `SessionStore.dispatch` 完成：`messageEnd` 按圆心 `messageUsageOf` 累加，`agentStart` 翻轮（归档上轮、清零本轮）；框架在轮次起止刷新投影，插件只读。运行时内存态（随 pi 进程），重启即空。
- **本会话**：同一投影的其余字段（tokens/contextUsage/tps）。框架统一拉取/刷新/切会话失效，插件只读——插件不自己发 `getStats` 查询（启动零查 pi，未就绪不发）。
- **项目总**：`ctx.sessions.projectStats(cwd)` 聚合本 cwd 全部会话 JSONL 的文件真值，含 app 未运行期的消耗。真值不可"重置"，故无清零按钮——要清零去删会话文件。刷新时机：挂载/切项目/任一会话一轮结束（`agentEnd`/`agentSettled` 哑触发），scanner 有增量缓存，重扫廉价。

### 2.3 为什么本轮/上一次的累计在内核而不在插件（根因标注，勿回退）

"上一次"要求采集者常驻：一轮的结束事件到来时累计器必须在场。而 sidePanel 页签**不保活**——只有进入活跃集合的页签才挂载（初版右面板曾 `forceMount` 全部页签，多板块模型后改为只挂活跃项），插件组件在页签未激活期间收不到任何事件，"本轮/上一次"静默归零（实测事故：用户关着面板聊了一小时，打开统计页全是 0）。

哑触发（项目总的"轮结束就重扫"）可以留在插件——它没有状态，卸载期漏触发不损失正确性，挂载即重拉。有状态的轮次累计必须在常驻层：main 侧 `SessionStore.dispatch` 本来就在为 TPS 做轮次记账（`roundOut`/`roundGenSec`），turn/lastTurn 是同一台机器的延伸，不是新机制。

### 2.4 翻轮（rollover）唯一时机 = agentStart

"本轮"和"上一次"的交接只发生在 `agentStart`：上一轮 totals 归档为"上一次"，本轮清零重新累计。本轮值在轮结束后持续可见，直到下一轮开始。

**勿在 `agentEnd`/`agentSettled` 翻轮**（根因标注，勿回退）：底座每轮同帧连发这两个事件（`messageEnd` → `agentEnd` → `agentSettled`），若两个都触发翻轮，先到者归档并清零、后到者用已清零的累计器再覆盖一次——"上一次"恒为 0（双发覆盖 bug 实测）。且 usage 只在 `messageEnd` 落地（流式期间无增量 usage 可取），settle 即清会让"本轮"在整个生成期间恒为 0。

归档有守卫：上一轮有真实 token 消耗才覆盖"上一次"——用户中止的空轮（无 `messageEnd`）不会把有效历史抹成 0。

### 2.5 数字格式化

- 计数（token/轮次/会话数）：K/M/B 人性化 + 两位小数（`1234 → "1.23K"`）。token 是计数不是字节，单位用 K/M/B 不用 KB/MB/GB。
- TPS：两位小数（`45.67 t/s`）。取投影 `stats.tps`——轮次加权速率（本轮输出和/本轮生成时长和），桌面端自算，底座不给。
- 费用：≥ $0.01 两位小数；亚分金额（< $0.01）留 4 位——`toFixed(2)` 会把 $0.0043 显示成 $0.00，看起来像没数据。

### 2.6 是否修改了内核

改了，且是有意的：圆心 `SessionStats` 投影新增 `turn`/`lastTurn` 两个桌面自算字段（与既有 `tps` 同一先河——底座不给、桌面从事件流自算），main 侧 `SessionStore` 在 dispatch 里累计。理由见 §2.3：有状态的轮次采集无法在"不保活的页签组件"里成立，这是框架该承担的通用记账（框架管通用，§3.3），不是一个插件的特化。插件仍是纯渲染器：删掉它，投影字段照常存在，内核照常运行，右面板只是少了一个"统计"页签。

## 3 怎么通信

### 3.1 和内核通信

走 `usePluginContext()` 拿绑定上下文（pluginId 框架注入）。消费两个核心默认能力，零权限声明、零持久化：

- **`ctx.sessions.onKernelEvent(cb)`**：订阅运维流，只作项目总重扫的哑触发（`agentEnd`/`agentSettled`）。返回取消函数，`useEffect` cleanup 调它。
- **`ctx.sessions.projectStats(cwd)`**：一次性 RPC，聚合本 cwd 全部会话文件。

### 3.2 和其他插件通信

不和其他插件通信。纯消费者——读框架 store（只读）、订阅内核事件做哑触发，不广播任何状态。

## 4 怎么处理

### 4.1 数据流

纯事件驱动，不轮询。插件零累计状态：本轮/上一次/本会话全部渲染自 `useSessionStore` 投影（框架在快照到达/轮次起止时经 `getStats` 刷新）；项目总在挂载/切项目/轮结束哑触发时重扫。

### 4.2 轮次定义

一轮 = `agentStart` 到下一轮 `agentStart`（或会话切换）。`messageEnd` 带单条消息的 usage（仅 assistant 消息有），本轮累计 = 轮内全部 `messageEnd` usage 之和。steer/followUp/自动重试/压缩续跑都在同一轮内（底座不因此重发 `agentStart`）。

### 4.3 usage 形状（底座实测，2026-07）

`message.usage = {input, output, cacheRead, cacheWrite, cost, totalTokens}`，仅挂在 assistant 消息上；abort 的消息可能没有 usage。`cost` 是分解对象 `{input, output, cacheRead, cacheWrite, total}`——取 `cost.total`（旧版数字形态兜底）。形状解析全系统只此一份：圆心 `messageUsageOf`（文件基线的 session-scanner/project-stats 与事件流的 SessionStore 累计共用，契约单源）。

## 5 怎么保证

### 5.1 事件监听器清理

`ctx.sessions.onKernelEvent` 返回取消函数，`useEffect` 的 cleanup 调它——组件卸载后监听器不残留。订阅只剩哑触发，卸载无状态损失。

### 5.2 切会话/切项目

投影侧：切会话时框架用文件基线替换 stats（无 turn/lastTurn 字段，渲染为 0），活会话快照到达后经 `getStats` 覆盖为进程内真值——与切会话失效语义一致，插件不做任何重置。项目总侧：`sessionPath`/`cwd` 变化触发重扫。

## 6 如果没有这个插件，整个系统会有什么影响

内核不崩溃。右面板失去"统计"页签，用户无法查看 token 用量与上下文占比。Agent 功能完全不受影响。第三方插件完全可以替代：贡献同一个 `sidePanel` 槽位、读同样的 `useSessionStore` 投影与 `projectStats` RPC——内核的统计投影对所有人平等开放。

## 7 QA

**Q：底座事件字段变了怎么办？**

解析只在圆心 `messageUsageOf` 一处，取不到就计 0——展示仍为 0，不报错。字段确认后改这一处，文件基线与事件流两侧同时生效。

**Q：为什么"本轮"在流式期间长时间显示 0？**

usage 只在 `messageEnd` 落地（底座不提供增量 usage），流式期间无数据可累计。含工具调用的轮次里，首个 assistant `messageEnd` 之后"本轮"即有累计值并持续到轮结束。

**Q："上一次"为什么重启后为空？**

本轮/上一次是 pi 进程内的运行时态（事件流累计），不落盘。跨重启的历史消耗看"项目总"——那是文件真值聚合。

**Q："上下文"的数从哪来？为什么有的会话显示 "—"？**

信任序三级（圆心 `resolveContextUsage` 单源）：① usage 锚点——最后一条真测到 prompt 的 assistant usage（最准，供应商正常上报时走这级）；② context-probe 实测——内核常驻底座扩展在每次请求发出时对完整 payload（system prompt + 工具定义 + 消息历史）做 chars/4，写侧车文件，供应商不报 prompt token 时走这级；③ 皆无 → "—" 诚实未知，不显示"输出量当上下文"的假数字。②在 app 重启（扩展同步 + pi 重 spawn）后生效。

**Q：统计页签不激活时打开，"本轮"是什么？**

是投影真值，不是"打开之后才开始累计"——累计在 main 侧常驻进行，页签显隐只影响渲染，不影响数据（§2.3 之前不是这样：页签卸载期的事件永久丢失，这是修复点）。
