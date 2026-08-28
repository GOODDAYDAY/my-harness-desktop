# im-graph

## 1 定位与职责

- 先纠正一个前提：im-graph **不是** `codeBlockRenderers` 槽的贡献方。它不声明 `codeBlockRenderers`，没有 `languages`（围栏语言）、没有 `fileExtensions`、没有「围栏代码块 → 图」的渲染器。它与 mermaid/puml/graphviz 三个兄弟插件**不同构**——那三个是「文本块内部的围栏语言渲染器」，im-graph 是「右侧面板的 Session Bus 会话关系图」。全仓 grep 确认：`codeBlockRenderers` 只出现在 `mermaid`/`puml`/`graphviz` 三个插件的 `plugin.json`（外加 markdown 的 description 提及消费方身份），im-graph 不在其列。

- im-graph 的真实身份：`sidePanel` 槽的贡献方。它贡献右侧面板的一个「IM」页签（`contributes.sidePanel: [{ id: "im-graph", label: "IM", icon: "network", component: "ImGraphPanel", order: 40 }]`），在页签里实时画出 Session Bus 的会话关系图——房间成员、spawn 父子、消息流动。`plugin.json` 的 `description` 自述「Session Bus 会话关系图——房间成员、spawn 父子、消息流动实时可视」，精确对应它的真实职责。

- 它的数据源是 Session Bus（`permissions: ["sessions:bus"]`），不是 `codeBlockRenderers` 槽、不是 `blockRenderers` 槽、不是 `markdown` 插件、不是 `timeline` 插件。它经 `usePluginContext()` 拿 `ctx.bus`（`BusApi` 能力面），订阅总线状态与事件，自己折叠成图模型渲染。这是「消费而非翻译」原则的体现：它主动消费 Session Bus 吐出的中性信封（`SessionBusMessage`），自己决定怎么画——用什么布局、什么交互，与总线实现无关。

- 它与 markdown 插件、timeline 插件**零交互**：不消费它们的 channel、不查它们的槽、不 `dependsOn` 它们。它只与「Session Bus 路由器」（`application` 层的运行时状态）和「sidePanel 槽机制」（框架侧）发生关系。这一点在写作要求里被误设为「与 markdown（消费方）和 timeline（blockRenderers 上层）的交互」，实际不成立，本文按代码实况纠正。

- 它的结构是四件套的**非完整形态**：`client/`（出站封装）+ `core/`（纯 TS 图模型）+ `renderer/`（React 渲染）+ `locales/`（文案），没有 `pi-extension/`、没有 `dsh-extension/`——因为它不需要给内核补能力，Session Bus 是壳后端 `application` 层已有的运行时，im-graph 只是它的一个观察者。`core/` 是纯函数层（不 import react、不碰 ctx），带两个 vitest 测试文件，这是它区别于三个图渲染插件的第二个结构特征（那三个没有 `core/`、没有测试）。

## 2 目录结构

- `plugin.json`：声明面。`renderer` 指向 `./renderer/index.tsx`，`permissions: ["sessions:bus"]`，`contributes` 声明 `sidePanel`（一条）+ `languages`（4 locale × `im-graph.panel`）两槽。`sessions:bus` 是声明能力（`window.kernel` 上的能力分层里，`sessions:bus` 需插件在 `permissions` 字段声明，壳后端在网关边界检查）——im-graph 声明它，才能在 `usePluginContext()` 里拿到 `ctx.bus`。

- `client/bus-observer.ts`：`BusObserver` 类，Session Bus 的出站封装。所有 `ctx.bus` 调用（`status`/`tapStart`/`tapStop`/`onMessage`）收敛此一处，组件不直接碰总线。观察策略是「status 基线 + tap 订阅 + 帧增量」。

- `core/graph-model.ts`：纯 TS 图模型，无 React 无 IO，可裸单测。把 Session Bus 的两路输入（status 全景快照 + tap 收到的总线帧）折叠成「会话树 + 房间区」的图模型，产出流动脉冲 `FlowPulse`。含 `SessionNode`/`ChannelNode`/`GraphModel` 类型、`applyStatus`/`applyFrame`/`edgesOf`/`linkedRefs`/`layout` 纯函数。

- `core/flow-events.ts`：事件流面板的条目模型与增量聚合，纯 TS。聚焦会话的 stream 事件 → 面板条目：边界事件原样标记、消息按 `messageId` 归并流式递增、工具调用按 `toolCallId` 归并（start 一行、end 同行补 ✓/✗）、碎事件不进面板。

- `renderer/index.tsx`：`ImGraphPanel` 主组件（109 行），面板激活才挂观察、非激活全拆。持有图模型/脉冲/聚焦/事件流四个 state，用 `BusObserver` 出站。

- `renderer/GraphCanvas.tsx`：SVG 左右两段图渲染——会话树在左（spawn 树连接线），房间在右列（y 取成员均值），脉冲粒子沿边流动（CSS 变量传起止点）。纯展示组件：模型/布局/linked 集全在 `core/graph-model`，本文件只管坐标 → SVG 元素。

- `renderer/EventFlow.tsx`：聚焦会话的事件流面板，tag 三色（消息/工具/边界）、流式条目挂光标、新事件自动滚底。

- `renderer/im-graph.css`：面板样式，颜色全部走主题 token 变量，零写死色值（`var(--color-*)`、`var(--spacing-*)`、`var(--font-size-*)`）。含脉冲/蚂蚁线/呼吸/光标闪烁等 keyframes。

- `core/graph-model.test.ts` + `core/flow-events.test.ts`：两个 vitest 测试，覆盖基线快照折叠、帧增量（脉冲/成员/spawn 父子）、竖向布局、边界标记、消息流式归并、工具 ✓/✗ 归并、碎事件过滤。

- `locales/`：`de`/`en`/`zh-CN`/`zh-TW` 四个 locale，每个含一个 `panel.json`，是 `im-graph.*` 命名空间的文案（`title`/`empty`/`emptyHint`/`channels`/`refresh`/`close`/`flow.title`/`tag.message`/`tag.tool`/`tag.boundary`）。

## 3 plugin.json 逐字段

- `id: "im-graph"`、`version: "0.4.9"`、`tier: "official"`、`displayName: "IM"`、`description: "Session Bus 会话关系图——房间成员、spawn 父子、消息流动实时可视"`、`tags: ["sessions"]`。`displayName` 是「IM」（页签标题的短名），但 `zh-CN/panel.json` 里 `im-graph.title` 是「会话关系」（页签内容区的标题），两者不同源——`displayName` 是插件元信息，`im-graph.title` 是渲染期文案。

- `permissions: ["sessions:bus"]`：唯一权限声明。它对应 `packages/shared/src/domain/events/session-bus.ts` 的 `BusApi` 能力面注释——「Session Bus 插件能力面(permissions: "sessions:bus";实现=application SessionBus,经 IPC 门控)」。im-graph 声明它，`usePluginContext()` 才返回非空的 `ctx.bus`；不声明则 `ctx.bus` 缺面，`index.tsx` 第 33 行的 `if (!isActive || !ctx.bus) return;` 直接短路，面板空转不崩。

- `contributes.sidePanel[0]` 逐字段，对应圆心契约 `SidePanelContribution`（`contributions.ts` 第 81-95 行）：

  - `id: "im-graph"`：贡献 id，插件内唯一。

  - `label: "IM"`：Tab 显示名（契约字段名是 `label`，不是 `title`——`contributions.ts` 第 83 行注释写「契约字段名是 label,不是 title」）。

  - `icon: "network"`：lucide 图标名，渲染层按名映射。`index.tsx` 的 `EmptyState` 也用 `<Network size={28} />` 作空态图标，与页签图标同族。

  - `component: "ImGraphPanel"`：renderer 侧组件名，框架从 exports 自动匹配。`renderer/index.tsx` 具名 export 了 `ImGraphPanel`。

  - `order: 40`：Tab 排序，小的在前。右侧面板里 session-tree（会话树）、context-files（Context 文件）、git-review、run-panel、token-stats 等多个 sidePanel 贡献方按 order 排序，im-graph 的 40 排在相对靠后的位置。

- 无 `revealOn`：`SidePanelContribution` 的 `revealOn` 字段（「该 channel 被 emit/invoke 时框架展开右面板并激活本 Tab」）im-graph 不声明，所以它只靠用户手动点开页签激活，不被任何事件自动唤起。

- `contributes.languages`：4 条 `LanguageContribution`，id 都是 `im-graph.panel`，locale `zh-CN`/`zh-TW`/`en`/`de`，resources 指向各 locale `panel.json`。与三个图渲染插件不同，im-graph 的语言包有**渲染期文案**（`im-graph.title`/`im-graph.channels`/`im-graph.tag.*` 等 10 个 key），因为它的 UI 有用户可见文本，不是零文案的图渲染器。

## 4 数据契约：Session Bus 中性契约

- im-graph 的输入是 Session Bus，其唯一类型源是 `packages/shared/src/domain/events/session-bus.ts`——圆心拥有的中性契约，不依赖任何框架/库/运行时/内核。im-graph 从 `@my-harness-desktop/shared` import 的 `BusApi`/`SessionBusMessage`/`TapFilter` 及地址 helper 全在此文件。

- `SessionBusMessage`（`session-bus.ts` 第 12-31 行）是总线消息的唯一信封形状：`{ $bus: true, id, from, to, kind, payload, timestamp, replyTo? }`。上行请求、下行响应、事件通知全是这一个形状，`kind` 鉴别用途、`replyTo` 配对请求。注释写「信封只有一个形状(契约单源)——不存在传输层一套字段、应用层一套字段的两张皮」。im-graph 消费的 `applyFrame`/`onMessage` 只认这个信封。

- 地址系统：`from`/`to` 是字符串地址，前缀三种——`session:<key>`、`channel:<name>`、`plugin:<id>`，另有 `desktop` 特殊目标（路由器内部 handler）。圆心提供地址构造/判定 helper 防各手拼前缀漂移：`sessionAddress`/`channelAddress`/`pluginAddress`/`isSessionAddress`/`isChannelAddress`/`isPluginAddress`/`sessionKeyOf`/`channelNameOf`（`session-bus.ts` 第 57-83 行）。im-graph 的 `core/graph-model.ts` 全量 import 这些 helper，节点 ref 统一 `s:<key>`/`c:<name>` 带前缀形式。

- `TapFilter = "done" | "lifecycle" | "stream"`（第 34 行）：tap 闸门级别。`done` 只给完成信号；`lifecycle` 加五个边界事件；`stream` 全量（仅 plugin 目标）。`LIFECYCLE_EVENT_TYPES`（第 37-43 行）是 lifecycle 的五边界：`sessionStart`/`agentStart`/`agentEnd`/`agentSettled`/`messageEnd`。im-graph 的 `SessionTapFilter = Extract<TapFilter, "lifecycle" | "stream">` 排除了 `done`——它需要至少 lifecycle 级的 busy 亮灭，不需要 done-only 档。

- `BusApi`（第 100-114 行）是 im-graph 出站的唯一接口：`status()`（一轮查全景）、`send`/`sessionCreate`/`sessionAbort`/`channelMember`（im-graph 不用）、`tapStart`/`tapStop`（im-graph 核心用）、`onMessage(cb)`（订阅投递到本插件的总线帧，返回取消订阅函数）。注释写「订阅投递到本插件的总线帧(返回值取消订阅;按 to === plugin:<ownId> 自行过滤)」——im-graph 的 `BusObserver.onMessage` 里 `if (msg.to !== this.selfAddress) return;` 正是这个「自行过滤」的落地。

- im-graph 不 import 任何内核实现，它只认这份中性契约。Session Bus 路由器（`application` 层）由哪个内核驱动（pi 的 bus-extension 或 dsh 侧实现）对 im-graph 透明——它看到的永远是 `SessionBusMessage` 信封。这是「壳只认中性事件」在会话关系图上的体现：图的正确性不依赖任何内核的存储格式或事件形状。

## 5 client/bus-observer 观察层

- `BusObserver`（`client/bus-observer.ts`）是 Session Bus 的出站封装，职责是「status 基线 + tap 订阅 + 帧增量」三步，全部 `ctx.bus` 调用收敛此一处，组件不直接碰。`ObserverHooks`（第 17-21 行）是它回灌组件的两个回调：`onModel(model, pulses)` 与 `onSessionEvent?(sessionKey, eventType, event)`。

- `SessionTapFilter = Extract<TapFilter, "lifecycle" | "stream">`（第 15 行）：会话 tap 的两种档位，默认 `lifecycle`、聚焦时 `stream`。channel tap 不吃 filter（第 14 行注释「channel tap 不吃 filter」——`tapStart({ channel })` 不传 filter，房间消息流全量订阅）。

- 观察策略（第 2-7 行注释）：每房间 tap channel（流量天然稀疏，订阅即得全部房间帧）；每会话 tap lifecycle（五边界事件，够 busy 亮灭/完成判定）；聚焦某会话时该会话升级 stream（全量事件流供事件流面板；stream 闸门只许 plugin 目标，本插件正是）；退出聚焦降回 lifecycle——同时至多一个 stream。

- `start()`（第 38-41 行）：`offMessage = bus.onMessage((msg) => this.onMessage(msg))` 挂订阅，然后 `await refresh()` 拉基线。

- `refresh()`（第 43-49 行）：`status = await bus.status()` 一轮查全景；`this.model = applyStatus(this.model, status)` 全量重建基线；`await syncTaps()` 对齐 tap 订阅集；`hooks.onModel(this.model, [])` 回灌（pulses 为空数组——基线刷新不产脉冲）。

- `stop()`（第 51-61 行）：`stopped = true`、摘 `offMessage`、清 `refreshTimer`、逐个 `tapStop` 清 `tapIds`。这是「非激活全拆」的落点——组件 unmount 或失活时，所有 tap 句柄释放，插件不常驻白吃 IPC 流量。

- `focus(key)`/`unfocus()`（第 64-77 行）：聚焦把该会话 tap 从 `lifecycle` 升级 `stream`（先 `unfocus` 降旧的，保证同时至多一个 stream），退出聚焦降回 `lifecycle`。`retapSession(key, filter)`（第 79-94 行）做实际的 tap 重挂：`tapStop` 旧句柄 → `tapStart({ session: key, filter })` 拿新 `tapId`；目标会话已死（`tapStart` 抛错）时静默吞掉，下轮 refresh 基线自然剔除。

- `syncTaps()`（第 96-121 行）：把「图上想要的 tap 目标集」与「当前已挂 tap 集」对齐——`wanted` 集合 = 所有 `c:<name>`（channel）+ 所有 `s:<key>`（session）；不在 wanted 里的旧 tap `tapStop` 摘除；wanted 里没挂的补挂（channel → `tapStart({ channel })`，session → `retapSession` 按是否聚焦选 stream/lifecycle）。

- `onMessage(msg)`（第 123-133 行）：先 `if (this.stopped || msg.to !== this.selfAddress) return;` 过滤非本插件的帧；若 `tap_event` 且 `focusedKey` 且 `msg.from === session:<focusedKey>`，透传 `onSessionEvent`；然后 `applyFrame(this.model, msg, Date.now())` 折叠帧增量，`hooks.onModel(result.model, result.pulses)` 回灌；若 `result.unknownSeen`（帧里出现图上没有的会话，新 spawn 未入基线）则 `scheduleRefresh()`。

- `scheduleRefresh()`（第 135-141 行）：`REFRESH_DEBOUNCE_MS = 600` 防抖刷新。帧里发现未知会话时不立即刷（可能高频），600ms 内只触发一次 `refresh()` 补齐基线并重挂 tap。这是「事件驱动不轮询」的补丁式自愈——常态靠帧增量，异常（新 spawn）才防抖补基线。

## 6 core/graph-model 图模型纯函数

- `core/graph-model.ts` 是纯 TS 层：不 import react、不碰 ctx，可裸单测（顶部注释写「不 import react、不碰 ctx,可裸单测」）。它把 Session Bus 的两路输入（status 全景快照 + tap 收到的总线帧）折叠成「会话树 + 房间区」图模型，产出 `FlowPulse` 供渲染层播动画。

- 模型类型：`SessionNode`（key/label/title/busy/settledAt/spawnedBy）、`ChannelNode`（name/throttledAt）、`GraphModel`（sessions Map + channels Map + members `Map<string, Set<string>>`）、`FlowPulse`（id/kind `"chat"|"done"|"join"|"leave"`/path `[fromRef, toRef]`/status?）。`members` 只画 session 成员，plugin 成员不进图（第 30 行注释）。

- `sessionRef(key) = \`s:${key}\`` / `channelRef(name) = \`c:${name}\``（第 47-52 行）：节点 ref 统一带前缀，防会话 key 与房间名撞名（第 4 行注释）。

- `applyStatus(model, raw)`（第 70-101 行）：全量重建基线。`StatusSnapshot`（第 56-59 行）是消费方对 `status()` 返回 `unknown` 的窄化字段子集（`sessions`/`channels` 两数组）。`sessionLabel(s, key)`（第 62-67 行）决定节点 label：优先会话名（`truncateSessionName` 截断到显示上限），无名退回 `sessionPath` basename 的 uuid 短码。`settledAt`/`throttledAt` 是历史痕迹，跨快照保留（第 69 行注释）——基线刷新不清掉「上次完成时刻」，否则完成闪烁会随刷新丢失。

- `applyFrame(model, frame, now)`（第 112-192 行）按 `frame.kind` switch，产 `FrameResult { model, pulses, unknownSeen }`：

  - `chat`：from 会话 → 房间一条脉冲（`from→c`），房间 → 每个其他成员各一条（`c→session`），实现「消息扇出」的可视化。

  - `peer_joined`/`peer_left`：维护 `members` 集合，发 join/leave 脉冲（`session→c`）。未知会话置 `unknownSeen`。

  - `tap_event`：`agentStart` 置 busy、`agentSettled`/`agentEnd` 清 busy + 记 `settledAt` + 向 spawn 父发 done 脉冲。

  - `session_done`：清 busy、记 settledAt，向 spawn 父发 done 脉冲（带 `status`，error 系染红）。

  - `bus_throttled`：记房间 `throttledAt`（熔断时刻，渲染层红框闪烁）。

  - default：静默忽略（不认识的 kind 不崩、不产脉冲）。

- `spawnParentRef(model, key)`（第 195-200 行）：spawn 父节点的 ref。`spawnedBy` 是 session 地址且父在图内才返回父 ref；plugin 父不算（图上无该节点）。

- `edgesOf(model)`（第 211-222 行）：边派生。`spawn` 边（父→子，会话树内连接线）+ `member` 边（会话→房间，会话区到房间区连线）。渲染层 `GraphCanvas` 只消费这个边集，不自己推导。

- `linkedRefs(model, key)`（第 227-238 行）：聚焦时保留高亮的 ref 集合 = 选中会话 + spawn 直系亲属（父 + 子）+ 所在房间。其余节点/边由渲染层沉入背景（dim）。

- `layout(model)`（第 271-322 行）：竖向布局。spawn 树 DFS（根 = 无 spawn 父的会话，子顺序按 Map 插入序）排在左列、深度缩进；房间在右列（`CHANNEL_X = 196`），y 取成员中心均值（交叉天然最少），无成员房间排在会话树下方。返回 `LayoutResult { nodes, width, height, channelsHeader }`。这是「布局 v2」（第 240 行注释）——会话树在左、房间在右的固定两段式，宽度 `WIDTH = 280` 是画布 viewBox 宽。

## 7 core/flow-events 事件流聚合

- `core/flow-events.ts` 是事件流面板的条目模型与增量聚合（纯 TS，可裸单测）。聚焦会话的 stream 事件 → 面板条目：边界事件原样标记，消息按 `messageId` 归并流式递增，工具调用按 `toolCallId` 归并（start 一行、end 同行补 ✓/✗），碎事件不进面板。

- `FlowKind = "message" | "tool" | "boundary"`；`FlowEvent`（id/ts/kind/text/streaming?/messageId?/toolCallId?）。`TEXT_LIMIT = 200`（消息文本截断上限）、`LIST_LIMIT = 200`（列表长度上限，超长裁头）。

- `BOUNDARY_TYPES`（第 25-28 行）：`sessionStart`/`agentStart`/`agentEnd`/`agentSettled`/`compactionStart`/`compactionEnd`/`stepStart`/`stepEnd` 八个边界事件，原样入列（`kind: "boundary"`，`text` = 事件名）。注意这个集合比 `LIFECYCLE_EVENT_TYPES`（5 个）宽——im-graph 的事件流面板是 stream 全量事件，比 lifecycle 五边界多了 `compactionStart/End`/`stepStart/End`。

- `appendFlowEvent(list, eventType, raw, ts, seq)`（第 30-87 行）按 eventType 分派：

  - 边界 → `push("boundary", eventType)`。

  - `messageStart` → `push("message", "messageStart · <role>")`。

  - `messageUpdate` → 用 `messageContentText(msg?.content)`（`packages/shared/src/domain/text.ts` 的圆心纯函数，提取内容纯文本）截断到 200；若上一条是「同 messageId 的流式消息」，原地替换（同行递增）而非新行；否则 `push` 一条 `streaming: true` 的新行。

  - `messageEnd` → 同上归并，落定 `streaming: false`。

  - `toolCallStart` → `push("tool", toolName, { toolCallId })`。

  - `toolCallEnd` → 按 `toolCallId` 反找 start 那行，同行补 `✓`（`isError` 补 `✗`）；找不到则单行补标。

  - default → 返回原 list（碎事件如 `toolCallUpdate`/`messageAutoRetry`/`turn*`/`usage` 不进面板，防刷屏）。

- id 生成：`\`${ts.toString(36)}-${seq.toString(36)}\``（第 41 行）——时间戳 36 进制 + 递增序列号 36 进制，保证同 tick 内不撞 id。`seq` 由 `index.tsx` 的 `seqRef.current++` 供给，单调递增。

- 归并键：`messageId` 归并消息（同一条消息的多次 update 合到同一行）、`toolCallId` 归并工具（end 找到 start 那行补标）。这是「事件流面板不刷屏」的关键——一条长消息的几十次 `messageUpdate` 只占一行，一个工具的 start/end 只占一行。

## 8 renderer 渲染层

- `ImGraphPanel({ isActive }: { isActive: boolean })`（`renderer/index.tsx`）是 sidePanel 组件，收到框架注入的 `isActive` prop（槽可见性由框架传 prop，非插件自判断）。四个 state：`model`（`GraphModel`，`emptyModel` 初始）、`pulses`（`FlowPulse[]`）、`focusedKey`（`string | null`）、`flowEvents`（`FlowEvent[]`）。

- 挂载/卸载观察（第 32-57 行 useEffect）：`if (!isActive || !ctx.bus) return;`——面板激活且有 bus 权限才挂观察；`new BusObserver(ctx.bus, \`plugin:${pluginId}\`, { onModel, onSessionEvent })` 构造观察者（selfAddress 用 `usePluginId()` 注入的 pluginId 拼 `plugin:<id>`，遵守零硬编码）；`observer.start()` 拉基线 + 挂订阅；cleanup `observer.stop()` 全拆 + 清空四个 state。这是「面板激活才挂、非激活全拆」——tap 是路由器运行时状态，插件不常驻白吃 IPC 流量，重新激活时 refresh 一轮基线自愈。

- `onModel` 回调（第 35-43 行）：`setModel(m)`；若有脉冲，追加到 `pulses`，每个脉冲 `setTimeout` 在 `PULSE_TTL_MS = 900`（与 CSS 动画时长一致）后移除。脉冲是「播完即移除」的瞬时粒子，不是持久状态。

- `onSessionEvent` 回调（第 44-46 行）：`setFlowEvents((prev) => appendFlowEvent(prev, eventType, event, Date.now(), seqRef.current++))`。

- `onFocus(key)`（第 59-66 行）：点会话节点 → `setFocusedKey(key)` + 清空事件流 + `observer.focus(key)` 升级 stream；再点/✕/失活 → `observer.unfocus()` 降级拆流。`focusedLabel`（第 68 行）从 `model.sessions.get(focusedKey)?.label` 取节点名。

- 渲染（第 70-108 行）：`im-panel` 容器，`im-toolbar`（标题 `im-graph.title` + 刷新按钮 `observer.refresh()`）；`model.sessions.size === 0` 时 `EmptyState`（`Network` 图标 + `im-graph.empty`/`im-graph.emptyHint`）；否则 `im-body` 里 `GraphCanvas`（图）+ 聚焦时 `EventFlow`（事件流面板，占满图下方剩余空间）。

- `GraphCanvas`（`renderer/GraphCanvas.tsx`）：纯展示组件。`useMemo` 算 `layout(model)`（节点坐标）、`edgesOf(model)`（边集）、`posOf`（ref → PlacedNode 映射）、`linked`（聚焦时 `linkedRefs`）、`activeEdges`（pulses 的活跃边集）。SVG 元素三类：spawn 边（父底中点 → 折线 → 子左中点）、member 边（会话右中点 → 房间左中点，横向微弯贝塞尔）、节点（session 矩形 + channel chip）。聚焦交互：`dim(ref)` 把非 linked 节点沉入背景（`opacity 0.18`），选中节点 `im-node-focused` 发光，linked 边转蚂蚁线持续流动。

- `GraphCanvas` 的脉冲渲染（第 112-130 行）：每个 `FlowPulse` 一个 `<circle>`，起止点经 CSS 自定义属性 `--fx/--fy/--tx/--ty` 传给 `im-pulse-move` keyframes（`from { cx: var(--fx) } to { cx: var(--tx) }`）。这是「CSS 变量传参」的动画技巧——粒子路径不写进 JS，只写起止坐标，动画由 CSS 驱动，避免 JS 每帧更新。

- `EventFlow`（`renderer/EventFlow.tsx`）：纯展示。`fmtTime` 格式化 `HH:mm:ss`；`useEffect` 在 `events` 变化时 `scrollTop = scrollHeight` 自动滚底；每条 `flow-item` 渲染时间戳 + 三色 tag（`im-graph.tag.message/tool/boundary`）+ 文本，`streaming` 条目挂流式光标（`::after content "▌"` 闪烁）。

- `im-graph.css`：全部主题 token，零写死色值。脉冲颜色按 kind 分（`im-pulse-chat`/`done`/`join`/`leave`），`im-pulse-error` 染红（error 系完成）；`im-node-busy` 呼吸动画（busy 会话描边呼吸）、`im-settled-dot` 完成绿点、`im-channel-throttled` 熔断红框、`im-edge-linked` 蚂蚁线流动。这是「token key 合规、token 值违规」纪律的正面样本——颜色全部 `var(--color-*)`，没有一个 hex。

## 9 与 sidePanel 槽、timeline、markdown 的关系 + 内核无关性

- 与 sidePanel 槽：im-graph 是贡献方，框架是消费方。框架读 manifest 的 `contributes.sidePanel[].component`，在 exports 里匹配 `ImGraphPanel`，渲染进右侧面板，按 `order: 40` 排序，传 `isActive` prop。im-graph 不调任何 register 函数（§7.4 自动匹配），不写死自己的 contribution id。

- 与 timeline：**无直接交互**。timeline 是中区主视图（`mainView` 槽），im-graph 是右侧面板（`sidePanel` 槽），两者是并行的两个页签，不消费彼此 channel、不查彼此槽、不 `dependsOn` 彼此。它们唯一的「关系」是共享同一个数据源的下游——timeline 消费 `useSessionStore` 的中性消息流，im-graph 消费 Session Bus 的 `SessionBusMessage`，两者是「同一批会话的两种投影」，但彼此不认识。这是「壳插件之间唯一合法通信是事件总线」的负例反证——im-graph 与 timeline 不需要通信，就真的零通信。

- 与 markdown：**零交互**。markdown 是 `blockRenderers` 槽的 text 块贡献方 + `codeBlockRenderers` 槽的消费方，im-graph 是 `sidePanel` 槽贡献方，两者分属完全不同的槽，不查对方槽、不消费对方 channel、不 `dependsOn`。写作要求里「与 markdown 插件（消费方）的交互」对 im-graph 不成立——im-graph 不产出任何 markdown 文本、不消费任何围栏代码块。

- 内核无关性：im-graph 的三层保证。其一，读的是中性契约——`SessionBusMessage` 信封由圆心定义（`session-bus.ts`），Session Bus 路由器由哪个内核驱动对 im-graph 透明；其二，渲染是纯函数——`core/graph-model.ts` 的 `applyStatus`/`applyFrame`/`layout` 无 React 无 IO，给定同一批 `SessionBusMessage` 画出的图与内核无关；其三，无内核身份分支——全插件 grep 不到 `if (kernel === "pi")` 或 `asPi()`，它不认识 pi/dsh，只认识 `session:<key>`/`channel:<name>` 中性地址。

- 无 `dependsOn`：im-graph 的 `plugin.json` 无 `dependsOn` 字段。它消费的是 `ctx.bus`（声明能力，经 `permissions: ["sessions:bus"]` 门控），不是任何插件的 channel；它贡献的是 `sidePanel` 槽（被框架消费），不是依赖任何插件。所以它既不需要 `dependsOn` 别人，也没人 `dependsOn` 它——是一个「自足」的观察型插件。

- 与三个图渲染插件的「兄弟」关系需要重新表述：mermaid/puml/graphviz 是「文本块内部围栏语言的渲染器」（`codeBlockRenderers` 槽），im-graph 是「会话关系图的面板」（`sidePanel` 槽）。四者同属 `sessions` 域、同是「图」相关、同是纯壳插件（无内核插件），但槽位不同、数据源不同、渲染对象不同。把它们称为「四个代码块渲染器插件」是不准确的——准确的说法是「sessions 域的四个图插件：三个围栏渲染器 + 一个会话关系图面板」。

## 10 QA

**Q：im-graph 为什么不是 `codeBlockRenderers` 贡献方，却和 mermaid/puml/graphviz 放在一起写文档？**

因为它与那三个同属 `sessions` 域、同是「图」、同是纯壳插件，但槽位不同——im-graph 是 `sidePanel` 贡献方，那三个是 `codeBlockRenderers` 贡献方。im-graph 没有围栏语言契约（不认 ` ```xxx ` 围栏）、没有 `fileExtensions`（不参与文件预览）、没有「code → 图」的 props 契约（`ImGraphPanel` 收的是 `{ isActive }` 而非 `{ code, streaming }`）。本文按代码实况把它写成「sidePanel 会话关系图」，不硬套「四个渲染器」的错误前提。

**Q：im-graph 为什么要在面板失活时全拆观察（`observer.stop()`），而不是常驻订阅？**

因为 tap 是 Session Bus 路由器的运行时状态，不是持久资源。若面板失活仍持 tap，插件会常驻白吃 IPC 流量——每个 tap 都让路由器把对应帧投递给本插件。全拆（`stop()` 逐个 `tapStop` + 摘 `onMessage`）让失活面板零流量占用；重新激活时 `refresh()` 拉一轮基线自愈（`applyStatus` 全量重建 + `syncTaps` 重挂订阅）。这是「事件驱动不轮询、不常驻白吃」的具体落地。

**Q：`BusObserver.onMessage` 里的 `if (msg.to !== this.selfAddress) return;` 是做什么的？**

是按 `to === plugin:<ownId>` 自行过滤。`bus.onMessage(cb)` 订阅的是「投递到本插件的总线帧」，但 `onMessage` 是全局回调（返回取消订阅函数），路由器会把所有投递到本插件的帧（包括 tap 事件帧）都喂给 cb。selfAddress 是构造时传入的 `plugin:<pluginId>`，过滤掉「to 不是本插件」的杂讯。这与 `BusApi.onMessage` 注释「按 to === plugin:<ownId> 自行过滤」逐字对应。

**Q：im-graph 的 `core/` 为什么能裸单测，而 `renderer/` 不能？**

因为 `core/` 是纯 TS（不 import react、不碰 ctx、无 IO），`applyStatus`/`applyFrame`/`layout`/`appendFlowEvent` 都是「输入 → 输出」纯函数，vitest 直接断言输入信封产出的模型/脉冲/布局。`renderer/` 依赖 React DOM、`usePluginContext`、`useTranslation`，需要 mock 或 jsdom 环境才能测。`graph-model.test.ts` 与 `flow-events.test.ts` 正是「无需 mock 外部环境的才是内层材料」这条判据的实证——它们测的图折叠、帧增量、事件归并全是纯数据变换。

**Q：im-graph 的脉冲粒子动画为什么用 CSS 变量传起止点，而不是 JS 每帧更新坐标？**

因为粒子是「播完即移除」的瞬时动画（`PULSE_TTL_MS = 900` 与 CSS 动画时长一致），路径是「两点直线段」，不需要 JS 干预中间帧。`GraphCanvas` 把 `--fx/--fy/--tx/--ty` 写进 `<circle>` 的 style，CSS `im-pulse-move` keyframes 从 `var(--fx)` 到 `var(--tx)` 驱动 `cx/cy`，浏览器 GPU 合成，零 JS 每帧开销。这比 `requestAnimationFrame` 手写补间更省、更声明式——路径知识（起止点）在 JS，动画知识（时长/缓动）在 CSS。

**Q：im-graph 会不会泄漏某个内核的专属概念？**

不会。它全程只认 `SessionBusMessage` 中性信封 + `session:<key>`/`channel:<name>` 中性地址，`core/graph-model.ts` 的 `applyFrame` 只 switch `frame.kind`（`chat`/`peer_joined`/`tap_event`/`session_done`/`bus_throttled` 等总线级 kind），不认 pi 的三态事件、不认 dsh 的 `assistant/chunk`。唯一「贴近内核」的字段是 `spawnedBy`（spawn 父子），但它是 status 快照里的中性字段（`StatusSnapshot.sessions[].spawnedBy`），由 Session Bus 路由器投影，im-graph 只消费投影结果。这是「壳只认中性事件」在会话关系图上的兑现。
