# token-stats

## 1 定位：一个零状态、零权限、零事件通道的纯渲染器

token-stats 是 `src/plugins/insight/` 域下的一个壳插件，回答一个单一问题：「token 用到哪了」。它不产生任何能力，不发起任何消息，不写任何配置，不声明任何权限，不拥有任何事件通道——它只做一件事：把框架已经算好的统计数字，以三种呈现方式画出来。

先把它和「内核插件」划清界限。token-stats 目录下只有 `plugin.json`、`renderer/`、`locales/` 三样东西，没有 `pi-extension/`、没有 `dsh-extension/`。CLAUDE.md §7.7 的四件套（locales / renderer / pi-extension / dsh-extension）是「需要给内核补能力」的插件才用的形态；token-stats 不补任何能力，它消费的是壳自身已经拥有的统计投影，所以它不需要任何内核插件。这是它区别于 `src/plugins/insight/llm-recorder/`（含 `core/` + `pi-extension/`）和 `src/plugins/sessions/goal/`（含 `pi-extension/` + `dsh-extension/`）的根本原因：后两者要「造数据」或「改内核行为」，前者只「读数据、画数据」。

把它说成「纯渲染器」不是修辞，是可以逐条验证的结构事实：

- **零累计状态**。`renderer/index.tsx` 里唯一的 `useState` 是 `projectStats`（存一次 RPC 返回值），没有第二个 `useState` 用于累计 token。本轮、上一次、本会话三层数字全部来自 `useSessionStore((s) => s.stats)`，累计动作在 main 侧 `session-store.ts` 的 `dispatch` 里完成，不在插件里。
- **零权限**。`plugin.json` 没有 `permissions` 字段。它用的两个 API——`ctx.sessions.projectStats` 和 `ctx.sessions.onKernelEvent`——都属于 `SessionsApi`（`packages/shared/src/domain/sessions.ts`），是「核心默认」能力，任何壳插件不需声明即可用。
- **零事件通道**。grep 整个插件目录的 `channels` 无一处命中。`renderer/index.tsx` 没有 `export const channels`，意味着框架加载这个 module 时不会为它注册任何插件间 channel。它不 emit、不 invoke、不声明 dependsOn——它压根不参与插件间事件总线。
- **零持久化**。没有 `configFile`，没有 config API 调用，没有任何写盘路径。它读的两个数据源（投影 + 文件聚合）都是框架/内核已经持久化好的东西。

这个「纯消费者」身份是理解整个插件的钥匙：它所有的复杂性都不在自身，而在它消费的那套「统计投影」是怎么被框架算出来的。所以本文把一半篇幅花在数据来源上，另一半花在「它怎么把数字画对」。

## 2 清单与槽位贡献

### 2.1 manifest 全貌

`src/plugins/insight/token-stats/plugin.json` 只有 118 行，核心是 `contributes` 里的四个槽：

- `id: "token-stats"`、`version: "0.4.9"`、`tier: "official"`、`tags: ["insight"]`、`renderer: "./renderer/index.tsx"`。
- `contributes.sidePanel`：一条 `{ id: "stats", label: "统计", icon: "bar-chart-3", component: "TokenStatsTab", order: 50 }`。
- `contributes.titlebar`：一条 `{ id: "session-stats", component: "SessionStatsTitlebar", order: 50 }`。
- `contributes.composerStats`：一条 `{ id: "context-usage", component: "ContextUsageBar", order: 50 }`。
- `contributes.languages`：16 条，4 个贡献 id（`token-stats.stats` / `token-stats.system` / `token-stats.plugin` / `token-stats.shell`）× 4 个 locale（`zh-CN` / `zh-TW` / `en` / `de`）。

没有 `permissions`、没有 `dependsOn`、没有 `configFile`、没有 `systemPrompts`。这个 manifest 的「空白处」和「有内容处」同等重要：它把 CLAUDE.md §8.4 说的三个接入点（manifest 声明 + renderer 出口 + PluginContext）压缩到最小——只声明槽位，不声明任何能力依赖。

### 2.2 三个 UI 槽位各是什么形状

三个 UI 槽位贡献项的契约形状各不相同，但 token-stats 的组件恰好都满足「组件 props 无、自订阅框架 store」这条共性，这正是这三个槽位的设计约定：

- **`sidePanel`**（`SidePanelContribution`，`packages/shared/src/domain/contributions.ts` 第 81 行）要求 `{id, label, icon, component, order?}`，另有一个可选 `revealOn?: string`——该 channel 被 emit/invoke 时框架展开右面板并激活本 Tab。token-stats 的贡献项**没有** `revealOn`，所以「统计」Tab 是常驻的，不靠某个事件触发展开，与 `git-review`、`session-tree` 这类可 `revealOn` 的 Tab 区分开。
- **`titlebar`**（`TitlebarContribution`，同文件第 141 行）只要求 `{id, component, order?}`，渲染在标题栏右侧、右面板开关左侧。
- **`composerStats`**（`ComposerStatsContribution`，同文件第 263 行）与 titlebar 同形 `{id, component, order?}`，契约注释明说「组件 props 无（自订阅框架 store）」「领域归属：统计展示是 token-stats 插件的领域，composer 只提供挂载点」。

三者的组件 props 契约分别是：`sidePanel` 组件收 `{isActive: boolean}`（见 `packages/react/src/index.ts` 第 455 行 `sidePanelComponents = new Map<string, ComponentType<{ isActive: boolean }>>()`）；`titlebar` 和 `composerStats` 组件收零 props（`titlebarComponents = new Map<string, ComponentType>()`，`useComposerStats` 注释「组件 props 无」）。

### 2.3 组件自动匹配的两条路径

组件怎么从 manifest 的 `component` 字符串变成真组件，token-stats 里涉及两条不同路径，这是理解「为什么入口要 re-export」的关键：

- **sidePanel / titlebar 走 `registerPluginComponents`**（`packages/react/src/index.ts` 第 510 行）。它遍历 `["settings","sidePanel","sidebar","mainView","titlebar"]` 五个槽，读 `contributes[slot][].component`，在 module 的 `exports` 里找同名组件。所以 `TokenStatsTab`、`SessionStatsTitlebar` 必须能被 module exports 找到。
- **composerStats 走 `useComposerStats` + `getPluginComponent`**（`packages/react/src/composer-stats.ts` 第 13 行）。`useComposerStats` 经 `window.kernel.slots.composerStats()` 查槽拿到 `{id, component, order, pluginId}` 列表，消费方（timeline）再按 `getPluginComponent(c.pluginId, c.component)`（`packages/react/src/plugin-modules.ts` 第 31 行）从完整 module exports 里按名取组件。

两条路径的共同前提是：**组件必须在入口 module 的 exports 里，且名字与 manifest 的 `component` 字段一字不差**。这就是 `renderer/index.tsx` 第 21-22 行显式 `export { SessionStatsTitlebar } from "./stats-titlebar"`、`export { ContextUsageBar } from "./context-usage-bar"` 的原因——这两个组件不挂在 index.tsx 里，而是分散在独立文件，必须经入口 re-export 才能进 module exports。CLAUDE.md §7.4「组件自动匹配」+ §8.3「零硬编码」：插件不调 `registerXxxComponent("名字", 组件)`，component 名也不以字符串字面量出现在插件代码里，只出现在 manifest 与 export 标识符的对应关系里。

## 3 三层口径与中性统计类型

`renderer/index.tsx` 头部注释是全文的骨架：「三层口径，一层一源，不跨层校准」。这三层各对着一张中性类型，全部定义在圆心 `packages/shared/src/domain/events/session-state.ts`。

### 3.1 `SessionStats`：会话统计的单一投影

`SessionStats`（`session-state.ts` 第 55 行）是整个插件消费的核心类型，字段分三类，来源完全不同：

- **内核 RPC 基座字段**：`userMessages` / `assistantMessages` / `toolCalls` / `toolResults` / `totalMessages` / `tokens` / `cost` / `contextUsage?`。这些是 pi 内核 `get_session_stats` RPC 的返回值，经 `src/server/kernel/pi/protocol/context-binding.ts` 的 `toSessionStats(data, local)` 防御性提取后投成中性形状。
- **壳自算字段**：`tps?` / `turn?` / `lastTurn?` / `turns?` / `steps?`。注释明确写「桌面端从事件流自算，内核不给」。这些字段在 `SessionStats` 里是可选的，因为只有活进程在跑时才有值；进程没起、纯文件读历史会话时它们是 undefined。
- **`tokens` 是 `TokenUsage`**（第 26 行）：`{input, output, cacheRead, cacheWrite, total}` 五项。注意 `input` 的语义陷阱——它在 token-stats 的标题栏组件里被特别处理（见 §5.2）。

`ContextUsage`（第 35 行）是 `{tokens: number|null, contextWindow: number, percent: number|null}`。`tokens` 为 `null` 表达「未知」（压缩后、下次响应前），这是「诚实态」的类型载体——未知不是 0，不能用 0 冒充。

### 3.2 `TurnUsage`：轮次用量的壳自算单元

`TurnUsage`（第 46 行）是 `{input, output, cacheRead, cacheWrite, cost}`，与 `TokenUsage` 的区别只在「没有 total、多了 cost」——它是一轮内所有 `messageEnd` 的 usage 累加结果。它的定义注释直接点破语义：「一轮 = agentStart 到下一轮 agentStart；轮内全部 messageEnd 的 usage 之和」。

`SessionStats.turn`（本轮）和 `lastTurn`（上一次完成轮）都是 `TurnUsage`。这两个字段的存在理由是历史事故：sidePanel 页签不保活，组件在页签未激活期间收不到事件，若在插件内累计，「上一次」会静默归零（用户关着面板聊一小时，打开统计页全是 0）。所以累计必须上移到 main 侧常驻层——这是「框架管通用，特化归外层」§3.3 的直接落地，细节在 §4.2。

### 3.3 `ProjectStats`：项目目录的文件真值

`ProjectStats`（第 105 行）是 `{tokens: TokenUsage, cost: number, sessionCount: number, turns: number}`。它与 `SessionStats` 并列，注释说得很清楚：「一个管『这个会话』，一个管『这个项目目录』」。`turns` 的语义是 `role:"user"` 的消息条数（一轮 ≈ 一条用户消息，steer/followUp 也算一条），与 `SessionStats.turns`（`agentSettled` 次数）是**两个不同的「轮次」口径**——这是「不跨层校准」的又一处体现：面板上「本会话·完成轮次」和「项目总·完成轮次」两个数字的含义本来就不一样，各认各的源，不去强行对齐。

### 3.4 `messageUsageOf`：usage 形状解析的唯一入口

`messageUsageOf(message)`（第 212 行）是从单条消息提取 `{tokens, cost}` 的唯一解析处。它的注释列了三个消费方：「session-scanner（文件基线聚合）、project-stats（项目总聚合）、token-stats（事件流单条提取）——三处入口，形状解析只此一份」。这是 CLAUDE.md §1.3「契约单源」在统计域的落点：内核 usage 的实测形状（`{input, output, cacheRead, cacheWrite, cost, totalTokens}`，cost 是分解对象 `{..., total}`、旧版数字形态兜底）只在圆心写一次，文件扫描、项目聚合、事件流累计三处都 import 它，不存在第二份「本地解析」。

## 4 统计从哪来：产出方与消费方的分工

插件自身不累计，那么数字是谁算的？答案是三层各有产出方，插件只是最末端的消费方。

### 4.1 本会话基座字段：pi RPC → 协议翻译 → 投影

链路的起点是 pi 内核的 `get_session_stats` RPC。`src/server/application/sessions/session-store.ts` 的 `getStats()`（第 1467 行）是这个链路的编排者：

- 拿 `activeProc()`，若进程未起直接 `throw new Error("内核未启动")`——这不是 bug，是「诚实态」的上游保证：renderer 侧 `refreshStats()` 的 `.catch` 会吞掉这个 throw，保持现状。
- 从 `proc` 里拼出 `local = { tps, turn, lastTurn, turns, steps }`（第 1470 行），这五个是壳自算字段。
- 判 `proc.backend.capabilities.pi` 是否为 `PiBackendExtensions`：**不是 pi（即 dsh 或其它缺面内核）→ 直接 `shellSessionStats(local)`**，基座字段全部留空（0/undefined），不伪造；是 pi → `pi.getSessionStats(local)` 拿 RPC 真值。
- 上下文信任序：若 `!proc.lastPromptAnchorReal`，读 `catalog.contextProbeTokens(proc.boundSessionPath)` 的实测值，喂给 `resolveContextUsage(stats.contextUsage, false, measured)`（`session-state.ts` 第 346 行）。

`toSessionStats`（`context-binding.ts` 第 149 行）做协议翻译：把 RPC 返回的 `d`（防御性 `(data ?? {}) as Record<string, unknown>`）里的数字字段逐个 `num(k)` 提取回退 0，把 `d.contextUsage` 映射成 `ContextUsage`，最后 `{...local}` 把壳自算的五项盖进去。注意 `local` 是 `Pick<SessionStats, "tps"|"turn"|"lastTurn"|"turns"|"steps">`，与 `shellSessionStats` 的参数形状一致——两处共享同一份「壳自算字段」概念，不重复声明。

### 4.2 turn / lastTurn / turns / steps：main 侧 dispatch 的轮次记账

这是 token-stats 里「技术上最重」但「代码上插件零参与」的部分。累计发生在 `session-store.ts` 的 `dispatch` 事件处理段（第 1742-1799 行），挂在 `SessionProc` 的字段上（第 103-116 行）：

- **`turn`（本轮）**：`agentStart` 时若 `turn.input+output+cacheRead+cacheWrite > 0` 才归档到 `lastTurn`，然后 `turn = zeroTurnUsage()` 清零（第 1746-1750 行）；`messageEnd` 时 `const u = messageUsageOf(event.message)`，把 `u.tokens` 的四项累加进 `turn`，`u.cost` 累加进 `turn.cost`（第 1786-1789 行）。
- **`lastTurn`（上一次）**：只在 `agentStart` 归档，归档有守卫——空轮（中止、无 messageEnd 落地 usage）不覆盖有效历史。
- **`turns`（完成回合数）**：`agentSettled` 时 `proc.turns += 1`（第 1756 行）。注释强调「只数 agentSettled 不数 agentEnd——pi 两者同帧双发，双数会翻倍，dsh 无 agentEnd」。
- **`steps`（步数）**：`stepEnd` 时 `proc.steps += 1`（第 1797 行）。`stepEnd` 是跨内核中性事件（pi 的 `turn_end` / dsh 的 `step/end`）。
- **`lastTps`（轮次加权速率）**：`messageStart` 记 `genStartMs`，`messageEnd` 累加 `roundOut`（本轮输出 token 和）与 `roundGenSec`（生成时长和），`lastTps = roundOut / roundGenSec`（第 1768-1785 行）。这是一轮多条 assistant 消息（工具循环）时的加权速率，不是定格在最后一条的瞬时速率。

**翻轮唯一时机 = `agentStart`** 是这条链路上最要紧的纪律。`agentEnd`/`agentSettled` 与 `agentStart` 的关系在 pi 是「同帧双发」，若把翻轮也挂到后两者，先到者归档清零、后到者用已清零的累计器再覆盖一次，「上一次」恒为 0（双发覆盖 bug，实测）。且 usage 只在 `messageEnd` 落地，流式期间无增量可累计，settle 即清会让「本轮」在整个生成期间恒 0。

### 4.3 项目总：文件真值聚合，含 app 未运行期

`projectStats(cwd)` 走的是 `session-store.ts` 第 738 行的 `this.catalog.projectStats(cwd)`。`this.catalog` 的 getter（第 233 行）钉死 `catalogFor("pi")`——**项目总这一层当前读的是 pi 的 JSONL 文件存储**。实现是 `src/server/kernel/pi/backend/pi-catalog.ts` 的 `piGetProjectStats`（第 558 行）：

- 按 `cwdToBucketName(cwd)` 定位桶目录，遍历 `.jsonl` 文件。
- 每个文件经 `parseSessionFile`（第 527 行）逐行扫描，只认 `type === "message"` 且 `role === "user"` 的行累加 `turns`，对每条 message 调 `messageUsageOf` 累加 tokens/cost。
- 增量缓存：`fileCache` 按 `mtimeMs + size` 判新鲜，未变的文件复用上次聚合结果，只有新文件或变动的文件才重扫（第 570-573 行）——所以 `refreshProject` 每次调用是廉价的，插件可以在「轮结束」时无脑重扫。

「含 app 未运行期」是这一层的核心价值：`SessionStats` 是活进程内存态，重启即空；`ProjectStats` 是文件真值，覆盖你在 app 关闭期间用别的客户端跑出来的会话。这也解释了为什么项目总**没有清零按钮**——文件真值不可「重置」，要清零只能删会话文件（注释第 7-8 行明说）。插件不做这个按钮，是「不伪造成功」的诚实态：不提供「看起来能清零但实际清不掉」的假入口。

### 4.4 刷新时机：框架统一拉取，插件零拉取

`useSessionStore.stats` 的刷新完全由框架驱动，token-stats 不参与。`src/web/stores/session-store.ts` 的 `refreshStats()`（第 354 行）是「框架唯一拉取口」：

- `onSnapshot` 回调里每次快照到达都 `refreshStats()`（第 619 行）。
- `onEvent` 回调里，`messageEnd / agentSettled / agentEnd / agentStart` 四类事件触发 `refreshStats()`（第 679 行）——`agentStart` 是翻轮点，必须拉，否则翻轮后旧值停留到首个 messageEnd。
- `openSession` 里 `stats: detail.stats`（第 433 行）先放文件聚合基线（`piReadSession` 产出的 `SessionStats|null`），再 `refreshStats()` 拉活会话真值覆盖。
- `refreshStats` 用 `sessionGen` 代际防竞态：`const gen = sessionGen`，RPC 回来后 `if (gen === sessionGen)` 才写，切会话后旧响应丢弃。

这整条链路的意义是：token-stats 的组件**订阅 store 即得最新值，store 更新即重渲，零拉取、零刷新时机、零失效维护**。`session-store.ts` 头部注释专门点名了这段历史的反面教材——「此前 timeline/token-stats 各自 useState + getStats + 挑事件刷新，生命周期维护两份且不一致」，收敛后「就绪闸/防竞态只有这一份，勿回退到插件侧各自拉取」。

## 5 四个组件逐一拆解

`renderer/` 下四个文件，每个的职责、数据源、诚实态都不同。

### 5.1 `TokenStatsTab`（sidePanel 主面板）

`renderer/index.tsx` 第 36 行的 `TokenStatsTab({ isActive })` 是整个插件的「本体」，面板按三层分四段渲染：

- **本会话**（`SectionHead` + 若干 `StatRow`）：`sessionStats.tokens.input/output/cacheRead/cacheWrite`、`ContextRow`（上下文）、`TpsRow`、`turns`、`steps`。数据源是 `useSessionStore((s) => s.stats)`（第 43 行）。
- **本轮**：`turn.input / turn.output`、`TpsRow`（复用 `sessionStats.tps`——本轮 TPS 与「本会话 TPS」在显示上同源，因为 `lastTps` 就是本轮加权速率）。
- **上一次完成轮**：`lastTurn.input / lastTurn.output`。
- **项目总**：`projectStats.tokens.input/output/cacheRead/cacheWrite`、`CostRow`（费用）、`turns`、`sessionCount`。

它唯一的本地状态是 `projectStats`（`useState<ProjectStats | null>`），两个 `useEffect` 管理它：

- 上行 effect（第 53-57 行）：依赖 `[sessionPath, cwd]`，先 `setProjectStats(null)` 再 `refreshProject()`。挂载、切会话、切项目都会重拉。
- 哑触发 effect（第 61-69 行）：`ctx.sessions.onKernelEvent` 订阅运维流，`event.kind === "session"` 且 `event.event.type` 是 `agentSettled` 或 `agentEnd` 时 `refreshProject()`。注释点明「哑触发无状态——卸载期漏触发不损失正确性，挂载即经上行 effect 重拉」，这是「有状态采集上移框架、无状态触发留在插件」的分界线的精确表达。

`empty` 判定（第 73-76 行）：`projectStats.sessionCount === 0` 且 `sessionZero`（本会话 tokens 和 userMessages 都为 0）且本轮 input+output 为 0 → 显示 `EmptyState`（`system.noData` / `system.noDataDesc`）。

四个展示件是纯函数组件，没有业务逻辑：

- `fmtCount(n)`（第 25 行）：`<1e3` 取整、`<1e6` 两位小数的 K、`<1e9` 的 M、其余 B。注释强调「token 是计数不是字节，单位用 K/M/B 不用 KB/MB/GB」。
- `CostRow`（第 156 行）：`cost < 0.01` 用 `toFixed(4)`，否则 `toFixed(2)`——因为 `toFixed(2)` 会把 `$0.0043` 显示成 `$0.00`，看起来像没数据。
- `TpsRow`（第 169 行）：`tps == null` 显示 `—`，否则 `tps.toFixed(2) t/s`。
- `ContextRow`（第 180 行）：`percent` 优先用投影真值，缺则 `tokens/contextWindow*100` 现算；条宽按 `pct` 百分比填充，`transition: width 200ms`。

### 5.2 `SessionStatsTitlebar`（titlebar 次级统计）

`renderer/stats-titlebar.tsx` 的 `SessionStatsTitlebar`（第 40 行）只渲染一行次级统计 `↑↓⚡Σ`，不再含上下文条（上下文条已迁 composer，见 §6.1）。

`StatsInline`（第 12 行）里最关键的逻辑是第 17 行：

```
const promptTotal = tok ? tok.input + tok.cacheRead + tok.cacheWrite : 0;
```

注释解释了这个加法的根因：「内核口径 input 只是未命中缓存的新 token（实测每轮个位数），prompt 主体走 cacheRead/cacheWrite——『上传』必须是三项之和，否则差四个数量级」。所以「↑上传」不是 `tokens.input`，而是 `input + cacheRead + cacheWrite`。这是一个典型的「内核口径 vs 用户直觉」的翻译点：内核把命中缓存的 prompt token 拆进 cacheRead/cacheWrite，用户只想知道「这一轮到底喂了多少 token 进去」，所以三项相加。但注意这个加法**只发生在标题栏的「上传」展示**，面板里的「输入」仍老老实实显示 `tokens.input`——同一个 `tokens.input`，在两个 UI 里有两种呈现语义，因为两个 UI 回答的问题不同（「总上传」vs「未命中缓存的新输入」）。

其余：`⚡` 是 `stats.tps.toFixed(1)`、`Σ` 是 `tok.total`；每项用 `min-w-[44px]` 固定宽防跳（占位 `—` 与真实数字宽度不同）。`placeholder = !stats` 时整行 `opacity: 0.4`、全 `—`，这是「三级诚实态」的第一级。

`SessionStatsTitlebar` 外层还带了一个 `WebkitAppRegion: "no-drag"`（第 46 行，`@ts-expect-error` 标注 Electron 私有 CSS 属性）——标题栏是窗口拖拽区，统计行要禁拖，否则 tooltip 悬停不可靠。这是 Electron 壳的宿主细节，被收在这一行，不进组件业务逻辑。

### 5.3 `ContextUsageBar`（composer 中段上下文条）

`renderer/context-usage-bar.tsx` 的 `ContextUsageBar`（第 13 行）是「零 props、位置无关」的典型。它只读两个 store 字段：

- `stats = useSessionStore((s) => s.stats)` → `ctx = stats?.contextUsage`，`used = ctx?.tokens ?? null`。
- `contextWindow = useSessionStore((s) => s.snapshot?.state.model?.contextWindow ?? 0)` → 窗口兜底。

窗口取值两级（第 19-20 行）：`ctx.contextWindow` 优先（RPC 真值自带窗口），为 0 时兜底到模型配置窗口——因为文件聚合基线里 contextWindow 恒为 0（文件无此字段），不兜底则历史会话的百分比算不出来。

「三级诚实态」在这里完整落地（第 21-25 行）：

- `stats == null`（pi 没起）→ `placeholder = true`，整行 `opacity: 0.4`，所有值 `—`。
- `used == null || limit <= 0`（压缩后待测、窗口未至）→ `pct = null`，条空显 + 百分比 `—`，不冒充 0%（注释点明「内核 TUI 同样显示 `?` 而非 0%」）。
- 都已知 → `pct = ctx.percent ?? Math.min(100, used/limit*100)`，`Math.min(100, ...)` clamp 防超 100 爆表。

填充色：`pct > 80` 用 `var(--color-accent-warning)`，否则 `var(--color-primary)`（第 30 行）——上下文快满时颜色先于数字预警。百分比 `Math.round` 取整、`min-w-[28px]` 固定位防跳。悬停用 `HoverTip`，文案 `shell.contextUsed`（"已用 {used} tokens / 上限 {limit} tokens"）。

### 5.4 `HoverTip`（共享 tooltip）

`renderer/hover-tip.tsx` 是一个 33 行的共享件，把 `@radix-ui/react-tooltip` 包成一个 `HoverTip`。注释给出选择 Radix 的理由：「原生 title 在 Electron/Chromium 里时延不可控且经常不弹」。`delayDuration={1000}` 固定 1 秒，portal / 边界翻转 / 加热区交接全由成熟包代劳——这是 CLAUDE.md §3.5「手写收敛到成熟包」的样本：不手写 tooltip 的定位、翻转、延时，只声明样式 token。

`tipStyle` 全部引用主题变量（`--color-surface`/`--color-fg`/`--color-border`/`--radius-md`/`--shadow-lg`/`--font-size-sm`/`--font-family-sans`），没有写死一个颜色十六进制——token key 合规（§1.2）。`zIndex: 99999` 是唯一一个「魔法数字」，但它是 tooltip 置顶的必要值，属机制非内容。

## 6 与其他插件交互

这一节是本文的核心。token-stats 的「交互面」与其「零事件通道」的表象相反，它其实深度参与了槽位生态，只是全部走「贡献 + 被消费」而不是「互相收发事件」。

### 6.1 与 timeline：槽位提供方 / 消费方关系，及历史归属迁移

token-stats 与 timeline 之间是**单向的槽位关系**：token-stats 贡献 composerStats 槽，timeline 消费它。

- **token-stats 是提供方**：`contributes.composerStats` 声明 `ContextUsageBar`。
- **timeline 是消费方**：`src/plugins/sessions/timeline/renderer/index.tsx` 第 732-740 行 `useComposerStats()` 查槽，遍历 `composerStatsContribs`，对每个贡献项 `getPluginComponent(c.pluginId, c.component)` 取组件，包一层 `PluginIdContext.Provider` 后 push 进 `composerStatsNodes`，最终传给 `<Composer composerStats={composerStatsNodes} />`（第 1079 行）。timeline 的 `composer.tsx` 第 441-443 行把 `{composerStats}` 渲染在思考控件右侧的 `ml-auto` 中段。

这段关系的历史是理解「领域归属」的关键。`docs/design/context-usage-bar-in-composer.md` 记录了迁移：统计组件**原本住在 timeline**（`timeline/renderer/stats-titlebar.tsx` 曾同时画上下文条 + 次级统计），后来上下文条迁到 composer、整个统计展示迁到 token-stats。设计文档 §1.2 说清了动机：上下文占用是「发之前看一眼」的反馈，用户在输入框组织下一条 prompt 时最关心「还能塞多少上下文」，所以上下文条移到 composer 中段。

迁移后形成的纪律是：**timeline 只提供挂载点（机制），token-stats 拥有统计领域（内容）**。`composer-stats.ts` 第 258-262 行的契约注释把这句话写成了契约文本：「统计展示是 token-stats 插件的领域，composer 只提供挂载点（机制），不再硬编码任何统计组件——数据仍来自框架 `useSessionStore.stats`」。这是 §1.2「机制与内容分离」的一个精确案例：timeline 不再知道「上下文条长什么样」，它只知道「composerStats 槽上有组件，查出来挂上去」。

**为什么这里不走事件总线**：设计文档 §2.2 专门回答了「为什么不把数字从 titlebar 传到 composer」——`ContextUsageBar` 和 titlebar 次级统计曾是**同一个插件（timeline）内部的两个组件**，数据源又是共享框架状态，事件总线解决的是「A 插件发、B 插件收」的跨插件协作，为「同插件内部读共享状态」上事件等于把 store 里的状态绕道事件总线再传一遍。即便现在它们分属两个文件、后来还迁到了 token-stats，这条「组件读共享 store」的通道依然成立，因为它们读的是**框架的** `useSessionStore`，不是某个插件的私有状态。

### 6.2 与框架（壳）：共享 store 只读 + PluginContext

token-stats 与框架的交互走两条被 CLAUDE.md §8.2 明确允许的通道：

- **共享 store 只读**：`useUiStore((s) => s.currentCwd)`、`useUiStore((s) => s.currentSessionPath)`（`index.tsx` 第 40-41 行）、`useSessionStore((s) => s.stats)`、`useSessionStore((s) => s.snapshot?.state.model?.contextWindow)`。它只读、绝不调 store 的 setter——想改框架状态走 ctx API，但 token-stats 压根不需要改任何框架状态。
- **PluginContext 的 sessions API**：`usePluginContext()`（第 38 行）拿 `ctx.sessions`，只用两个方法：`projectStats(cwd)`（一次性 RPC）和 `onKernelEvent(cb)`（订阅全量内核事件）。这两个都是 `SessionsApi` 的成员，默认注入、零权限。

值得强调的是 `onKernelEvent` 与 `onEvent` 的区分（`sessions.ts` 第 345/347 行）：`onEvent` 只收「激活会话」的事件流（视图流，驱动时间线渲染）；`onKernelEvent` 收「全部会话」的事件（带 `sessionKey` 归属，含后台会话）——「运维类需求（列表刷新/统计）用后者，视图渲染用前者」。token-stats 的项目总刷新是典型的「运维类」需求：任何会话一轮结束（哪怕后台会话）都意味着会话文件长大了，要重扫，所以它用 `onKernelEvent` 而不是 `onEvent`。这也意味着它的哑触发能覆盖「当前 cwd 下其它会话」的轮结束，不止当前激活会话。

### 6.3 与其它壳插件：零横向事件，纯槽位邻居

token-stats 与除 timeline 外的其它壳插件**没有横向通信**：

- 它不 emit 任何 channel，不 invoke 任何 channel，不声明 `dependsOn`。`grep channels` 整个目录零命中。
- 它与 `git-review`、`session-tree`、`context-files`、`run-panel` 等同样贡献 sidePanel 的插件，是**同一槽位上的平级邻居**：它们在 `sidePanel` 槽里按 `order` 排序，各占一个 Tab，互不知道对方存在。token-stats 的 `order: 50` 决定它在右面板 Tab 条里的位置。
- 它与「语言插件」的关系是**槽位贡献**而非通信：token-stats 自己就贡献 `languages` 槽（16 条文案），不需要依赖一个「语言插件」来获得文案——i18n 合并器把它的贡献项与其它插件的贡献项 key 级合并进同一份 resources。

这个「零横向」是有意为之的架构结论：token-stats 要的数据（统计投影）全部是**框架的**，不是**某个插件的**。如果它需要的是某个插件的私有数据，才必须走事件总线 + dependsOn；它不需要，所以它不上总线。反过来说，其它插件若想要 token 统计数字，正确的路径是「读 `useSessionStore.stats`」或「调 `ctx.sessions.projectStats`」或「订阅内核事件自己累计」，而不是向 token-stats 发事件要数据——token-stats 从不广播，它没有数据可广播，它只是框架统计的投影。

### 6.4 与内核：pi 提供基座、dsh 缺面留空、context-probe 补面

token-stats 不直接跟内核说话，它消费的 `SessionStats` 是内核统计经过适配器翻译后的中性投影。但它的数字质量**取决于内核提供什么**：

- **pi**：`get_session_stats` RPC 提供完整的基座字段（tokens/消息计数/cost/contextUsage），经 `toSessionStats` 翻译进投影。这是 token-stats「本会话」层数字的完整形态。
- **dsh（或任何无 `get_session_stats` 的内核）**：`getStats()` 走 `shellSessionStats(local)` 分支（`session-store.ts` 第 1472 行），基座字段全部留空（0/undefined），只有壳自算的 tps/turn/lastTurn/turns/steps 照常返回。`shellSessionStats`（`session-state.ts` 第 84 行）的注释把这个「缺面」说透：「不伪造——统计是壳自身的事，基座口径只有 pi 提供，缺面即显式留空」。所以 dsh 会话下 token-stats 的「本会话」层会显示 tokens 全 0、contextUsage 缺失，但「本轮/上一次/回合数/步数」这些壳自算字段照常有——这就是 §7.6「显式降级」在统计域的表现：能算的算，不能算的诚实留空，绝不假装 dsh 也有 pi 那套 `get_session_stats`。
- **context-probe 内核扩展**：当 pi 的 usage 锚点不可信（供应商不报 prompt token），`resolveContextUsage` 用 context-probe 实测值兜底（§4.1）。这个实测值来自 `piReadContextProbeTokens`（`pi-catalog.ts` 第 489 行）读的 `desktop-context-probe.json` 侧车文件，写方是 `my-harness-fit-pi-extension` 的 context-probe 扩展。token-stats 组件自己**不知道**这些存在，它只看到 `contextUsage.tokens` 最终是某个数还是 `null`。

### 6.5 项目总的多内核现状：当前钉在 pi 文件目录

§4.3 已经点出：`session-store.ts` 的 `get catalog()` 钉死 `catalogFor("pi")`，所以 `projectStats` 当前读的是 pi 的 JSONL 文件。这是 token-stats「项目总」层的一个多内核事实，需要精确陈述而不是含糊带过：

- `SessionCatalog` 契约（`backend.ts` 第 310 行）里 `projectStats(cwd)` 是每个内核都要实现的目录方法。
- pi 的实现是文件扫描 `piGetProjectStats`（含增量缓存），dsh 的实现是 `dsh-catalog.ts` 第 93 行的 `t.request(DSH_METHODS.sessionProjectStats, { cwd })`（走 JSON-RPC 让 dsh 内核自己聚合）。
- 但 `SessionsApi.projectStats` 的入口（`session-store.ts` 第 738 行）当前直接委托 `this.catalog`，而 `this.catalog` 恒为 pi。所以插件调的「项目总」现在是 pi 口径——「含 app 未运行期」的文件真值语义，也只有 pi 的 JSONL 文件扫描天然满足（dsh 的会话存在 session forest / append-only 日志里，是否落入同一 cwd 桶、是否覆盖未运行期，语义不同）。

这个事实对 token-stats 的含义是：插件本身**不感知**、也**不该感知**这个多内核差异——它只调 `ctx.sessions.projectStats(cwd)` 拿 `ProjectStats`。把这个差异留在契约实现层（catalog）而不是插件层，正是「壳只认中立契约、内核差异由适配器抹平」的正确落点；当前「入口钉 pi」是 catalog 路由层的演进事项，不属于 token-stats 的职责。

## 7 多内核下的诚实降级

token-stats 是多内核架构下「统计域诚实降级」的教科书样本，因为它恰好卡在一个尴尬位置上：统计的口径一部分是壳自算（跨内核同口径），一部分是内核提供（pi 有 dsh 无）。

- **壳自算字段跨内核同口径**：`tps / turn / lastTurn / turns / steps` 五个字段由 main 侧 `dispatch` 从中性事件流累计（§4.2）。`agentStart/agentSettled/messageEnd/stepEnd` 这些中性事件是适配器翻译的产物——pi 的 `agent_settled` 和 dsh 的 `turn/end` 都翻译成 `agentSettled`（`dsh-event-translator.test.ts` 第 7-8 行有断言），pi 的 `turn_end` 和 dsh 的 `step/end` 都翻译成 `stepEnd`。所以这五个字段在 pi/dsh 下口径一致，token-stats 照常显示。
- **内核基座字段 pi 有 dsh 无**：`tokens/cost/contextUsage/消息计数` 是 pi `get_session_stats` 的产物，dsh 无此面 → `shellSessionStats` 留空。token-stats 在 dsh 下显示本会话 tokens 为 0、上下文为 `—`，但不报错、不伪造。
- **插件自身无内核身份分支**：翻遍 `renderer/` 四个文件，没有 `if (kernel === "pi")`、没有 `asPi()`、没有「内核」字符串字面量。内核差异完全被 `getStats()` 的 `capabilities.pi` 探测（第 1471 行）和 `shellSessionStats` 的留空语义吸收，插件看到的永远是同一份 `SessionStats` 形状。这是 §7.5「渲染是纯函数」的直接验证：给定同一条 `SessionStats`，token-stats 怎么画与内核无关。

这个诚实态不是零成本，它要求用户接受「dsh 会话的 token 用量显示不全」这个现实——但「不全」是「诚实显示为 0/—」，不是「假装有数字」。「不静默、不伪造成功」是 §1.5 明文禁止的唯一状态（静默缺面）的反面，token-stats 在上游（`shellSessionStats`）就把这个诚实态钉死了，插件只需忠实渲染。

## 8 i18n 与文案

### 8.1 贡献结构：16 条语言贡献项

`languages` 槽贡献 4 个 id × 4 个 locale = 16 项，每项 `{id, locale, resources}` 指向 `./locales/<locale>/<ns>.json`。四个 namespace 文件：

- `stats.json`：面板统计文案，键如 `stats.sessionTotal`（本会话）、`stats.thisTurnLive`（本轮）、`stats.lastTurn`（上一次对话）、`stats.projectTotal`（项目总）、`stats.input2/output2/cacheRead/cacheWrite/tps/cost/turns/steps/sessionCount/contextUsed`。注意有 `stats.input/output/total/cumulative/tpsCap/effort` 六个键在组件里**没被引用**（组件用 `stats.input2` 而非 `stats.input`）——这是历史键残留，不算错误但属于「key 冗余」。
- `system.json`：`system.noData`（暂无数据）、`system.noDataDesc`（发消息跑一轮后自动累计），供 `EmptyState` 用。
- `shell.json`：标题栏/上下文条的悬停文案，`shell.contextUsed`（已用 {used} / 上限 {limit}）、`shell.tokensUp`（上传 tokens）、`shell.tokensDown`（下载 tokens）、`shell.tpsTitle`、`shell.totalTitle`。
- `plugin.json`：`plugin.token-stats.displayName`（统计）、`plugin.token-stats.description`。

### 8.2 namespace 由 key 前缀派生，不由贡献 id 决定

这是容易读错的一点。`LanguageContribution.id`（`contributions.ts` 第 130 行）的注释说它是「语言包贡献项标识，通常 `{pluginId}` 或 `{pluginId}.{namespace}`」，即 `token-stats.stats` 是**贡献项标识**（用于 (插件, locale) 维度唯一性、去重/覆盖），不是 i18next 的 namespace。

真正的 namespace 由 i18n 合并器 `src/server/application/i18n/merge.ts` 的 dot 解析决定：`mergeLanguageContributions`（第 77 行）对每个 key 做「第一个 dot 前是 namespace」的切分——`stats.sessionTotal` → ns `stats`、key `sessionTotal`；`system.noData` → ns `system`；`shell.contextUsed` → ns `shell`；`plugin.token-stats.displayName` → ns `plugin`。同时 `translator.ts` 第 63 行配 `nsSeparator: "."`，所以组件里 `t("stats.sessionTotal")` 能正确拆出 ns `stats` + key `sessionTotal`。

这意味着 `stats` / `system` / `shell` / `plugin` 是**共享命名空间**：`plugin` 命名空间里汇聚了所有插件各自的 `plugin.<id>.displayName`，`stats` 命名空间理论上也能被别的插件往 `stats.*` 下塞键，合并器按 key 级 union + 优先级覆盖（第 99-102 行）。token-stats 用了 `stats` 这个相对泛化的前缀，靠 `sessionTotal/thisTurnLive/lastTurn` 这些具体后缀避免与别的插件撞键，但严格说这个前缀的「私有性」不如 `plugin.token-stats.*` 强——这是文案 key 设计上的一个小观察，不影响运行。

### 8.3 fallback 链

文案解析的 fallback 链（`translator.ts` 第 14 行注释 + 第 59-66 行配置）：当前 locale → `en`（`fallbackLng`）→ manifest 字面值 → key 本身。`defaultNS` 是 `common`，但 token-stats 的 key 都带 ns 前缀，不走 defaultNS。组件用 `useTranslation()` 无参（默认 ns），靠 `nsSeparator: "."` 让带点的 key 自己选择 namespace。

## 9 QA

**Q1：token-stats 为什么不自己累计「本轮 / 上一次」？**

因为 sidePanel 页签不保活。只有进入活跃集合的 Tab 才挂载，组件在 Tab 未激活期间收不到任何事件；若在插件里累计，用户关着面板聊一小时再打开，「上一次」会静默归零。有状态的轮次累计必须上移到 main 侧常驻层（`session-store.ts` 的 `dispatch`），插件只读投影。这是「框架管通用，特化归外层」的典型：有状态采集是通用机制，上移；无状态渲染是特化，留在插件。

**Q2：为什么翻轮只认 `agentStart`，不认 `agentEnd` / `agentSettled`？**

pi 每轮同帧连发 `messageEnd → agentEnd → agentSettled`。若后两者也触发翻轮，先到者归档并清零、后到者用已清零的累计器再覆盖，「上一次」恒为 0（双发覆盖 bug）。且 usage 只在 `messageEnd` 落地，settle 即清会让「本轮」在整个生成期间恒 0。`agentStart` 是唯一翻轮点，归档带守卫（有真实消耗才覆盖 `lastTurn`）。

**Q3：标题栏的「↑上传」为什么是 `input + cacheRead + cacheWrite` 三项之和？**

内核口径里 `input` 只是「未命中缓存的新 token」，prompt 主体走 cacheRead/cacheWrite。单看 `input` 会差四个数量级（实测每轮个位数）。用户只想问「这轮喂了多少 token」，所以三项相加。但面板里的「输入」仍显示裸 `input`——两个 UI 回答的问题不同，不是同一语义的两处实现。

**Q4：为什么上下文占用有时显示「—」而不是一个数字？**

因为诚实态：压缩后、下次响应前，锚点失效，`contextUsage.tokens` 为 `null`。`resolveContextUsage` 三级信任序（usage 锚点 → context-probe 实测 → 诚实未知）里，前两级都拿不到就返回 `null`，UI 显示 `—`。内核 TUI 也显示 `?` 而非 0%——「未知」不该伪装成「0%」。

**Q5：token-stats 和其它插件之间有事件通信吗？**

没有。它不 `export const channels`，不 emit/invoke，不声明 dependsOn。它与 timeline 是「贡献 composerStats 槽 / 消费槽」的单向槽位关系，与其它 sidePanel 插件是同一槽位上的平级邻居。它要的数据全是框架统计投影，不是某个插件的私有数据，所以不需要事件总线。

**Q6：dsh 会话下 token-stats 显示什么？**

壳自算字段（本轮/上一次/回合数/步数/TPS）照常显示——它们从跨内核中性事件流累计，口径一致。内核基座字段（tokens/cost/contextUsage/消息计数）走 `shellSessionStats` 留空，显示 0 或 `—`，不伪造、不报错。这是统计域的「显式降级」：能算的算，不能算的诚实留空。

**Q7：项目总的数字为什么含 app 没运行时产生的会话？**

因为项目总走 `piGetProjectStats` 文件扫描，聚合本 cwd 桶下全部 `.jsonl` 的 `message.usage`，与进程无关。它覆盖你在 app 关闭期间用别的客户端跑的会话。也正因为它读的是文件真值，所以没有「清零」按钮——真值不可重置，要清零只能删会话文件。

**Q8：为什么 token-stats 没有 `pi-extension` / `dsh-extension` 目录？**

因为四件套（locales / renderer / pi-extension / dsh-extension）是「给内核补能力」的插件才需要的形态。token-stats 不补任何内核能力，它消费的是壳已有的统计投影，是纯渲染器。补能力的典型是 `llm-recorder`（含 pi-extension）和 `goal`（含 pi-extension + dsh-extension），它们要「造数据」或「改内核行为」，与 token-stats 的「读数据、画数据」性质不同。
