# sessions-list 插件技术文档

## 1 定位：左栏会话列表是什么、不是什么

- sessions-list 是左栏（sidebar）"对话"分组的内容插件——把"某个 cwd 桶下有哪些会话、每个会话此刻处于什么状态"这件事，从文件系统层面提升到 UI 层面。
  - 它的 manifest 在 `src/plugins/sessions/sessions-list/plugin.json`，`id` 为 `sessions-list`，`tier` 为 `official`，`renderer` 指向 `./renderer/index.tsx`。
  - 它贡献的唯一一个交互槽位是 `sidebar`：`{ id: "sessions", title: "对话", component: "SessionsSection", order: 10, group: "main" }`——即壳左栏会多出一个标题为"对话"的可折叠分组，其内容由 `SessionsSection` 组件渲染。
  - `group: "main"` 表示它和 `projects`（`order: 5`，标题"项目"）、`sub-agent`（`order: 20`，标题"子 Agent"）、`ask`（`order: 99`，标题"提问"）共享同一个 Panel 区域，`order: 10` 决定它排在项目列表之下、子 Agent 列表之上。

- 它不是内核，也不拥有会话数据——它只消费框架维护好的会话元数据，自己决定怎么分组、怎么排序、怎么渲染交互。
  - 它的数据源是 `useSessionStore((s) => s.sessionInfos)`，而不是自己调 `ctx.sessions.list()`（`renderer/index.tsx` 第 51 行注释明确写"本插件不再 ctx.sessions.list"）。
  - 它不持有会话列表的真相源——真相源在框架的 `useSessionStore`（renderer 侧镜像）与 main 侧 `SessionStore`（`src/server/application/sessions/session-store.ts`），后者再委托给中立层存储 `NeutralSessionStore` 与内核目录 `SessionCatalog`。
  - 删掉这个插件，壳照常启动，左栏只是少了"对话"分组；`sessions.list` / `sessions.updateHeader` / `sessions.onKernelEvent` 这些核心会话能力照常存在，只是没有这个消费者——这正是"机制与内容分离"要求的效果。

- 它也不是任何别的会话相关插件（timeline / session-tree / goal / sub-agent）的"控制器"——它和它们是平级的壳插件，交互只经槽位契约与框架 store 间接发生，不经彼此直调。
  - 它不 emit 也不 invoke 任何插件间 channel，不声明 `dependsOn`（`renderer/index.tsx` 全文没有 `ctx.events.emit/on/invoke`，也没有 `export const channels`）。
  - 它唯一"消费别的插件"的入口是 `sessionGroupings` 槽位（经 `useSessionGroupings()`），用于把子会话嵌套到父会话下；该槽位当前由 `sub-agent` 插件贡献。

## 2 Manifest 与接入点

- 本插件触碰的接入点只有两个半：`plugin.json`（声明）、`renderer/index.tsx`（export `SessionsSection` + 用 `usePluginContext()` / `useUiStore` / `useSessionStore`），外加 `core/search.ts`（纯函数 + 单测，属插件内部分层而非壳接入点）。
  - 它没有 `permissions` 字段——它只用到 `sessions.*`、`config.*`、`dialog.openFile`、`notify.show` 这些核心默认能力，不触碰 `fs:project` / `git:read` / `sessions:bus` / `rpc:bash` / `llm:oneshot` 等声明能力。
  - 它没有 `configFile` 字段——它的私有持久化数据（已读位标 `readState`、拖拽序 `customOrder`）走 `ctx.config.get/set`（`plugins-data` 私有区），不走框架的 configFile 白名单 save/dirty 通道。
  - 它没有 `piExtension` / `dshExtension` 字段——本插件是纯 UI 壳插件，不给任何内核补能力。

- `contributes.languages` 声明了 8 条语言包贡献，覆盖两个命名空间 × 四个 locale。
  - 命名空间 `sessions-list.sessions` 提供界面文案（`locales/{zh-CN,zh-TW,en,de}/sessions.json`），键形如 `sessions.title`、`sessions.pinned`、`sessions.deleteAllConfirm`（共 37 个键，见 `locales/zh-CN/sessions.json`）。
  - 命名空间 `sessions-list.plugin` 提供插件自身元数据文案（`locales/{...}/plugin.json`），键为 `plugin.sessions-list.displayName` / `plugin.sessions-list.description`——这两个键被插件管理页消费，用于显示插件名和描述。
  - locale 用 BCP 47 区域码（`zh-CN` / `zh-TW` / `en` / `de`），简繁靠区域码区分；这符合 `LanguageContribution` 契约（`packages/shared/src/domain/contributions.ts` 第 127-129 行注明"放开为接受区域码"）。

- 组件注册完全靠框架自动匹配，插件零注册代码。
  - `packages/react/src/index.ts` 的 `registerPluginComponents()` 读 `contributes.sidebar[].component`（= `"SessionsSection"`），在 renderer module 的 exports 里找同名导出并注册（`renderer/index.tsx` 第 41 行 `export function SessionsSection()` 是唯一被槽位引用的导出）。
  - 该函数只遍历 `settings/sidePanel/sidebar/mainView/titlebar` 五个有组件槽，`sidebar` 分支直接把 `contributes.sidebar` 数组平铺后按 `component` 名匹配——本插件的 `SessionsSection` 就是这样被挂上左栏的。
  - 其余函数（`buildGroups` / `groupByTime` / `GroupBlock` / `SessionRow` / `ChildSessionRow` / `NewChatRow` / `SortableRow` / `PhaseIcon`）全是模块私有导出，不进槽位注册表，仅被 `SessionsSection` 内部调用。

## 3 目录结构与分层

- 本插件目录按"渲染层 + 纯函数层 + 文案层"三块组织，符合"一个功能一个 plugin"的四件套内聚纪律的 UI 子集。
  - `renderer/index.tsx`（1175 行）：React 组件 + 槽位贡献组件 + 框架 API 消费，是唯一的渲染与交互逻辑所在。
  - `core/search.ts`（18 行）+ `core/search.test.ts`（44 行）：`filterSessions` 纯函数与单测——搜索匹配逻辑从渲染层拆出来，可裸单测、零 React 依赖。
  - `locales/{zh-CN,zh-TW,en,de}/`：`sessions.json`（界面文案）+ `plugin.json`（插件元数据文案），各 4 份。
  - 没有 `pi-extension/` 和 `dsh-extension/` 目录——本插件不需要给内核补能力，四件套里只用了 renderer + locales 两件。

- `core/search.ts` 的存在本身就是"构造与执行分开 / 纯函数进圆心外置"纪律在本插件内的局部复刻。
  - 匹配逻辑是纯函数（输入 `SessionInfo[]` + `query`，输出过滤后的数组），无 IO、无 React、无事件，因此放进 `core/` 子目录并配单测。
  - 渲染层 `SessionsSection` 只调用 `filterSessions(sessions, query)`（第 343 行），不自己写匹配循环——如果未来搜索规则变（加模糊匹配、加正则、加拼音），只改这一个纯函数，渲染层不动。
  - 注意这里的分层只发生在插件目录内部；`core/` 这个名字与仓库顶级的圆心（`packages/shared/src/domain/`）无关，它只是插件内部的"纯逻辑层"目录，物理上仍属于壳插件内容层。

- 依赖方向只指向圆心发布面，不 import 任何壳内部路径。
  - `renderer/index.tsx` 顶部 import 了 `@my-harness-desktop/react` 和 `@my-harness-desktop/shared` 两个发布面，以及 `../core/search`（插件内部相对路径），外加第三方 UI 库（radix-ui、framer-motion、react-i18next、lucide-react）。
  - 全文没有 `import ... from "@/server/..."`、`@/application/...`、`@/kernel/...` 之类的壳内部路径——符合"壳插件只从 `packages/shared` 和 `packages/react` 引用类型和 API"的纪律。
  - `core/search.ts` 甚至只 `import type { SessionInfo } from "@my-harness-desktop/react"`（type-only），连运行时都不依赖 React 包，纯净度最高。

## 4 数据流总览：会话列表从哪来

- 列表数据的真相源是壳自己的中立层存储，不是任何内核的会话文件——这是本插件一个最容易误解、也最重要的架构事实。
  - main 侧 `SessionStore.list(cwd)`（`src/server/application/sessions/session-store.ts` 第 599-604 行）的实现是 `this.neutralStore?.listByCwd(cwd)`，再逐条 `neutralToSessionInfo(s, cwd)` 映射。
  - `NeutralSessionStore.listByCwd(cwd)`（`src/server/application/sessions/neutral-session-store.ts` 第 39-52 行）扫 `<数据根>/sessions/*.json`，按 `header.cwd === cwd` 过滤——它读的是壳自己写的 `NeutralSession` JSON 树，不读 pi 的 `.jsonl` 文件、不读 dsh 的 `session.jsonl.zstd`。
  - 代码注释明确标注这是 `§kernel-forkless §27 阶段 D` 的落地："会话列表的唯一源是壳自己的中立层，不读内核存储；path 是投影地址（由 lineageId 派生，§12.2），不再做主键"。

- `neutralToSessionInfo(s, cwd)`（session-store.ts 第 624-646 行）把一条 `NeutralSession` 投影成渲染层要的 `SessionInfo`。
  - `neutralSessionId` 直接来自 `s.neutralSessionId`（主键）；`id` 取根 lineage 的 `lineageId`（`s.lineages.find((l) => l.fork === null)?.lineageId ?? s.neutralSessionId`）。
  - `path` 是**投影地址**，由 `catalog.projectionPath(cwd, rootLineageId)` 派生（pi = `piDerivedSessionPath`，dsh = 裸 lineageId），注释强调"投影地址是坐标系，不承诺磁盘上存在对应文件"。
  - `name` / `created` / `modified` / `lastMessage` / `lastEntryId` / `pinned` / `archived` / `custom` 全部来自中立 header（`s.header.*`），其中 `modified` 用 `updatedAt ?? derived.updatedAt ?? createdAt` 兜底；`derivedHeaderFromSession(s)` 对历史旧数据（阶段 D 之前写入、缺 `lastMessage`/`lastEntryId`/`updatedAt`）做读时自愈回填。

- renderer 侧的会话元数据由框架 `useSessionStore` 统一拉取和维护，本插件零拉取、零失效维护。
  - `initSessionStore()`（`src/web/stores/session-store.ts` 第 612-657 行）在应用启动时订阅 `currentCwd` 变化与内核事件流，两者任一触发就 `loadForCwd()` → `useSessionStore.getState().loadSessionInfos(cwd)`。
  - `loadSessionInfos(cwd)`（第 394-411 行）调 `window.kernel.sessions.list(cwd)`，把返回的 `SessionInfo[]` 建成**双键 map**：每个会话既按 `path` 索引、又按 `neutralSessionId` 索引（第 401-406 行），并带 `sessionInfosCwd` 防竞态（切 cwd 后旧响应丢弃）。
  - 触发重拉的内核事件集合是 `sessionStart` / `messageStart` / `messageEnd` / `agentSettled`（第 652 行）——因为新文件落盘（sessionStart）、自动命名落 `session_info`（messageStart）、消息定稿（messageEnd）、轮次结束（agentSettled）都可能改变本目录的列表内容。
  - 另外 `onHeaderChanged` 广播（第 662 行，第 21 项多端同步）也会触发 `loadForCwd()`——任一客户端归档/置顶/改名/删除会话后，本端列表跟着重拉。

- 为什么本插件不自己 `ctx.sessions.list()`？因为那会造成多个消费方各自拉取、各自维护失效时机，行为漂移。
  - `session-store.ts` 顶部注释记录了历史根因：此前 timeline / token-stats 各自 `useState + getStats + 挑事件刷新`，生命周期维护两份且不一致；会话列表收敛为框架统一维护后，"就绪闸 / 防竞态只有这一份"。
  - 设计文档 `docs/design/plugin-decoupling.md §4.2` 是这次收编的依据；本插件从"自己 list + 自己重拉"改为"只读 `sessionInfos` + 手动刷新走 `loadSessionInfos` 入口"。

## 5 圆心契约消费清单

- 本插件从 `@my-harness-desktop/shared` 与 `@my-harness-desktop/react` 消费的圆心契约，逐条列清如下，每个类型/函数都落在一份圆心文件里，插件侧绝不重写。
  - `SessionInfo`（`packages/shared/src/domain/sessions.ts` 第 33-60 行）：列表行的数据结构。字段 `path`（投影地址）、`id`（根 lineage id）、`cwd`、`neutralSessionId?`（中立主键）、`name?`、`created`、`modified`、`lastMessage?`、`lastEntryId?`、`pinned?`、`archived?`、`custom?`（desktop 私有域）。`renderer/index.tsx` 第 17 行从 `@my-harness-desktop/react` re-export 处 import 了 `type SessionInfo`。
  - `deriveSessionTitle(session)`（sessions.ts 第 83-88 行）：展示层唯一来源，兜底链为"自定义名 → `lastMessage` 预览（经 `truncateSessionName` 截断）→ `id.slice(0, 8)`"。本插件行标题（第 726 行）与面包屑标题（第 162 行）都调它，杜绝了历史上一会话多种显示名的漂移。
  - `SessionRawFilePaths`（sessions.ts 第 93-98 行）：`{ desktop: string | null; kernel: string | null }`，是 `ctx.sessions.rawFilePaths` 的返回类型，`null` = 磁盘上无对应文件，调用方显式降级。
  - `WorkingPhase` + `advancePhase(prev, event)`（`packages/shared/src/domain/working-phase.ts`）：7 值工作阶段与增量状态机，本插件用它给行图标打"此刻在干嘛"的形态（请求/思考/工具/输出/重试/压缩/idle）。
  - `applyCustomOrder(items, order, getKey, getCreated)`（`packages/shared/src/domain/custom-order.ts`）：拖拽后的组内自定义序重建纯函数，本插件与 `session-bookmarks` 共用，不再各写一份。
  - `SessionGroupingContribution`（`packages/shared/src/domain/contributions.ts` 第 188-199 行）：经 `useSessionGroupings()` 间接消费，`parentPathKey` 决定哪个 `custom` 域 key 表示"父会话路径"。
  - `KernelEvent` / `SessionEvent`（`packages/shared/src/domain/events/kernel-event.ts` 与 `events/session-state.ts`）：`ctx.sessions.onKernelEvent` 回调的入参形状，本插件据此做 phase 推进与未读增量。

- `renderer/index.tsx` 第 23 行定义了一个**本地窄化的** `type HeaderPatch = { name?: string; pinned?: boolean; archived?: boolean }`，这是唯一一处"契约的本地投影"。
  - 它注释写明"与 updateHeader 契约一致"——圆心 `sessions.ts` 第 174-187 行的 `HeaderPatch` 还含 `toolConfig` 与 `custom` 两个字段，本插件只用得到 name/pinned/archived 三键，于是声明了一个子集别名。
  - 这不算"契约复制漂移"：本地别名只裁剪字段、不改变语义，且 `ctx.sessions.updateHeader` 的真实参数类型仍是圆心 `HeaderPatch`，编译器保证两者兼容；真正要扩展时改圆心一处即可。

- `useSessionGroupings()`（`packages/react/src/session-groupings.ts`）是唯一经 IPC 动态查槽的 hook。
  - 它调 `window.kernel.slots.sessionGroupings()` 拿 `(SessionGroupingContribution & { pluginId })[]`，并按 `useUiStore.pluginsNonce` 做缓存失效（插件加载完成 nonce 递增后重查）。
  - 本插件第 345 行 `const groupings = useSessionGroupings()` 拿到的就是这个列表，随后在 `topLevel/childrenByParent` 计算里逐条消费。

## 6 Renderer 源码逐块解析

### 6.1 SessionsSection 顶层骨架

- `SessionsSection()`（第 41-561 行）是本插件唯一对外组件，它先拉框架状态，再做本地状态声明，最后 render 一棵"Section 外壳 → 搜索框 → 状态占位 → 乐观新对话行 → 分组列表"的树。
  - 框架状态读的是 `useUiStore` 的 `currentCwd` / `currentNeutralSessionId` / `setCurrentSessionPath` / `setCurrentNeutralSessionId` / `setSessionTitle`，以及 `useSessionStore` 的 `snapshot`（→ `piAlive`）和 `sessionInfos`。
  - `piAlive = useSessionStore((s) => s.snapshot !== null)`（第 48 行）被用来区分"行图标空心/实心"——`snapshot` 非空表示当前有活进程投影基线；这个判断是框架状态，本插件不自己探测进程存活。

- `sessions` 的计算（第 55-65 行）是一段有明确根因的防御代码：`sessionInfos` 是双键 map，`Object.values` 会把每条会话画两遍。
  - 根因是框架 `loadSessionInfos` 为迁移过渡把每个会话既按 `path` 又按 `neutralSessionId` 存进 map（session-store.ts 第 402-405 行），渲染必须去重。
  - 去重键取 `s.neutralSessionId ?? s.path`，用 `Set` 保证同一会话只出现一次；代码注释点明"直接 Object.values 会把每条会话画两遍（根因：React duplicate key，列表行翻倍）"。
  - `loading = sessionInfos === null`（第 66 行）：`null` 表示框架尚未拉取（区别于"拉到了但为空"），用于渲染"加载会话…"占位。

### 6.2 本地状态清单

- 本插件维护七组本地 state，全部是"渲染投影/私有持久化"，不写框架 store、不写会话文件本身。
  - `query` + `searchOpen`：搜索关键词与搜索框开合，纯 UI 态。
  - `refreshState` + `refreshTimer`：手动刷新的三态机（idle / refreshing / refreshed），`refreshed` 态显示对勾 800ms 后归 idle，靠 `refreshTimer`（`useRef`）定时器驱动，`useEffect` 卸载时 `clearTimeout` 清理。
  - `phaseByPath`：`Record<string, WorkingPhase>`，key 是会话（`neutralSessionId ?? path`），值由 `advancePhase` 增量推进；注释说明它替代了旧的 `busyByPath` 二元忙标志（设计 `docs/design/session-working-phase.md §2.3`）。
  - `lastEntryByPath`：`Record<string, string>`，记录每个会话最后一条 entry id，未读判定依赖它；由 `entryAppended`（权威）与 `messageEnd`（兜底）两个事件源增量更新。
  - `readState` + `readStateRef` + `readLoadedRef`：已读位标，`ref` 保最新值防连续 `markRead` 闭包旧值互相覆盖，`readLoadedRef` 保证盘上读回前不推进（基于空 ref 写会冲掉盘上其他会话的 key）。
  - `removing` + `removingRef`：乐观移除集合，写操作（归档/删除）点击瞬间把行摘出渲染树，exit 动画即刻播放，权威重拉完成后清空。
  - `customOrder` + `customOrderRef` + `customOrderLoadedRef`：组内拖拽自定义序，`groupId → path[]`，与 `readState` 同落点同机制持久化。

- 挂载时的一次性初始化（第 111-126 行）用 `Promise.all` 并发读两个私有配置 key，读完才置 loaded 标记。
  - `ctx.config.get<Record<string, string>>("readState")` 与 `ctx.config.get<Record<string, string[]>>("customOrder")` 并行拉取，缺省值 `{}`。
  - `readLoadedRef.current = true` / `customOrderLoadedRef.current = true` 在数据就位后才置真，后续 `markRead` / `setGroupOrder` 才有权写盘。

### 6.3 事件订阅 onKernelEvent

- 本插件唯一的事件订阅是 `ctx.sessions.onKernelEvent`（第 200-225 行），订阅**全量内核事件**而非 `onEvent`——因为列表要覆盖后台会话，而 `onEvent` 只含激活会话（视图流）。
  - 注释给出明确边界：`sessionStart`（新文件）/ `messageStart`（自动命名落 session_info）/ `messageEnd`（定稿）/ `agentSettled` 都可能改变本目录列表，这些来自后台会话的事件只有 `onKernelEvent` 能收到。
  - 订阅里先处理终态兜底：`event.kind === "processExit"` 或 `"rpcError"` 时，把对应会话 phase 归 idle（第 202-205 行）；非 `"session"` 种类直接 return。
  - 对 `kind === "session"` 的事件，取 `event.event.type` 分两条线维护状态：`setPhase` 喂 `advancePhase` 推进工作阶段；`entryAppended` / `messageEnd` 更新 `lastEntryByPath` 并视情况推进已读位标。

- phase 推进走 `setPhase`（第 140-145 行），用 functional update 保最新 prev，规避事件闭包 stale。
  - `setPhaseByPath((prev) => { const next = advancePhase(prev[path] ?? "idle", event); return prev[path] === next ? prev : {...prev, [path]: next}; })`——无变化返回原引用，避免无谓重渲染。
  - `advancePhase`（working-phase.ts 第 89-124 行）是纯转移表：`agentStart`→requesting、`messageStart/Update`→`phaseFromMessage(content)`、`toolCallStart`→toolExecuting、`autoRetryStart`→retrying、`compactionStart`→compacting、`agentEnd/agentSettled`→idle 归零等。
  - 增量状态机的固有属性是"粗粒度概览 + 权威终态自纠正"：`messageEnd` 后 phase 回到 requesting 是"AI 进思考下一步"的保守估计，最终由 `agentSettled` 权威归零。

- 未读判定由两个事件源增量维护，与列表 reload 解耦。
  - `entryAppended`（第 209-215 行）：从 `event.event.entry.id` 提取权威 entry id，`recordEntry` 记录到 `lastEntryByPath`；若该事件恰是激活会话（`event.sessionKey === currentSessionPath`），立即 `markRead(activeNs, entryId)`（打开着=已读）。
  - `messageEnd`（第 216-219 行）：兜底第二来源，处理"部分落盘路径跳过 entryAppended"（如自定义消息）的情况，从 `event.event.message.id` 取 id。
  - `recordEntry`（第 150-153 行）对无 id 的 entry 直接 return，避免污染位标。

- `nsForSessionKey`（第 147-148 行）是运维流 key 到中立主键的桥：`event.sessionKey` 是 `proc.key`（即会话文件路径），而本插件大部分状态用 `neutralSessionId` 作 key，故经 `sessionInfos` 双键查回中立 id，旧会话回退 `path`。

### 6.4 分组 buildGroups / groupByTime

- 分组逻辑由两个纯函数承担，`buildGroups` 是数据分组、`groupByTime` 是时间分桶，都不依赖 `t()`（label 存 i18n key，渲染时再翻译）。
  - `buildGroups(items)`（第 588-598 行）按优先级切三刀：`pinned`（已置顶且未归档）、`archived`（已归档）、`rest`（其余）走 `groupByTime` 分时间四档；产出 `Group[]`，其中 `groupId` 是持久化 `customOrder` 的稳定 key。
  - `LABEL_TO_GROUP_ID`（第 580-587 行）把 i18n key 映射到稳定 groupId：`sessions.pinned`→`pinned`、`sessions.today`→`today`、`sessions.yesterday`→`yesterday`、`sessions.last7days`→`last7days`、`sessions.earlier`→`earlier`、`sessions.archived`→`archived`。
  - `groupByTime(items)`（第 601-618 行）用 `dayStart`（当天 0 点）、`yesterday`（-86400000）、`week`（-7 天）三个阈值把 `created` 时间戳投进 `today / yesterday / last7days / earlier` 四个桶，空桶过滤掉；`earlier` 桶 `min: -Infinity` 兜底。

- `groups` 的最终形态区分搜索态与非搜索态（第 380-382 行）。
  - 有 `query` 时只产一个平铺组 `{ groupId: "search", label: "", items: filtered, kind: "time", defaultOpen: true }`，`label` 为空使 `GroupBlock` 不画折叠头。
  - 无 `query` 时调 `buildGroups(topLevelSorted)`，其中 `topLevelSorted` 已按 `created` 降序排好（第 375-378 行），组内默认序保底是创建时间恒定降序（不因 mtime 跳变）。

### 6.5 子会话嵌套（sessionGroupings 消费）

- `topLevel / childrenByParent` 的 `useMemo`（第 347-371 行）是本插件消费 `sessionGroupings` 槽位的唯一代码点。
  - 对每个 `filtered` 会话，若其 `custom` 域里存在某个分组策略的 `parentPathKey` 且值为非空字符串，就把它记为一个 `ChildSession`（`{ session, parentPath }`），并把它加入 `childPaths` 集合。
  - 多个分组策略命中时只认第一个（`break`）——按 `useSessionGroupings()` 返回顺序，即贡献项的 `order` 升序；这与 `SessionGroupingContribution` 契约"多个分组策略时，先匹配 order 小的"一致。
  - `topLevel = filtered.filter((s) => !childPaths.has(s.path))`：被识别为子会话的行从顶层摘除，只作为父行下的嵌套行出现；`childrenByParent` 是 `parentPath → ChildSession[]` 的 map，供 `SessionRow` 渲染子行。

- 这是一个三段式解耦的完整闭环：domain 契约 → registry 注册 → renderer hook 查询 → 本插件消费。
  - `SessionGroupingContribution`（contributions.ts 第 188-199 行）定义契约字段 `parentPathKey` / `childLabelKey` / `childIcon` / `order`。
  - `sub-agent` 插件在它的 `plugin.json` 贡献 `sessionGroupings: [{ id: "subagent", parentPathKey: "subagent.parent_session", childLabelKey: "sub-agent.childLabel", childIcon: "git-fork" }]`——即 `custom["subagent.parent_session"]` 有值的会话会被嵌套。
  - 双向解耦体现在：本插件不认识"sub-agent"这个插件，它只知道"有个槽位给我一组 `parentPathKey` 规则"；sub-agent 也不知道 sessions-list 怎么画，它只声明数据关系。
  - 契约注释（contributions.ts 第 187 行）写"sessions-list buildGroups 消费"，但当前代码的实际消费点已移到 `topLevel/childrenByParent` 这个 useMemo——这是注释与实现的一次轻微错位，功能语义不变。

- 搜索平铺态（`flat`）不嵌套子会话，避免父、子同命中时重复显示。
  - 第 547 行 `children={query ? undefined : childrenByParent.get(s.path)}`：搜索态下子会话已在 `filtered` 里作为独立行出现，再嵌套会双显示（代码注释标"问题 D10"）。

### 6.6 排序与拖拽

- 组内拖拽排序由框架组件 `SortableList` 承担触发面、排他、悬浮卡、token 化视觉，本插件只传 `values` + `onReorder` + `onEnd`。
  - `GroupBlock` 内第 638 行 `<SortableList values={ids} onReorder={onReorder} onEnd={onEnd}>`，`ids` 是 `orderedItems.map((s) => s.neutralSessionId ?? s.path)`（第 636 行）。
  - `onReorder` 回调触发 `setGroupOrder(groupId, paths)`（第 390-394 行），它把新序写进 `customOrderRef` + `customOrder` state；`onEnd` 触发 `persistOrder()`（第 395-397 行）落盘 `ctx.config.set("customOrder", customOrderRef.current)`。
  - 行的拖拽由 `SortableRow`（第 563-575 行）包裹 `SortableList.Item`，`value` 是 `path`，`dragEnabled = !query && g.kind !== "archive"`（搜索态与归档组禁拖）。
  - `SortableList` 内部用 `framer-motion` 的 `Reorder.Group/Item`，并对 `input/textarea/button/[contenteditable]` 的 pointerdown 短路（sortable-list.tsx 第 107 行），避免重命名输入框的选文本手势被拖拽抢走。

- 渲染时的顺序由 `applyCustomOrder` 纯函数重建，默认序与自定义序严格分离。
  - 第 490 行 `applyCustomOrder(g.items, customOrder[g.groupId], (s) => s.neutralSessionId ?? s.path, (s) => s.created)`——不在 `customOrder` 里的新项按 `created` 降序排前（新项置顶），在清单里的项按拖拽序排后，失效 key 被过滤。
  - 默认序只在 `topLevelSorted` 用一次（第 375-378 行的 `created` 降序），拖拽序只影响命中 `customOrder` 的项，两条序互不覆盖。

### 6.7 行渲染（SessionRow / ChildSessionRow / NewChatRow / PhaseIcon）

- `SessionRow`（第 693-991 行）是本插件最重的一块，承担三种渲染形态：内联删除确认态、内联重命名编辑态、正常行。
  - 正常行的行标题 `title = deriveSessionTitle(session)`（第 726 行），副标题 `sub = session.lastMessage ?? new Date(session.created).toLocaleString()`（第 727 行）——预览缺省时回退创建时间。
  - 行图标（第 732-738 行）优先级：`session.pinned` → 图钉；否则 `phase !== "idle"` → `PhaseIcon`；否则 `piAlive` → 实心 `MessageSquare`，非活 → 空心 `MessageSquare`。
  - 未读圆点（第 846-852 行）只在 `unread && !hovered && !childSessions?.length` 时显示，hover 时让位给操作区；子会话存在时让位给展开箭头。

- `unread` 的计算（第 518-522 行）是"读过之后是否有新内容"的精确判定：`currentNeutralSessionId !== s.neutralSessionId && !!lastEntryByPath[key] && readState[key] !== lastEntryByPath[key]`。
  - 三个条件缺一不可：非激活会话（激活会话打开即已读，不亮）、有 `lastEntryByPath` 记录（无记录 = 从未有 entry，不误报）、位标不等于最新 entry（不相等 = 有新内容未读）。
  - 这条逻辑是"位标 vs 最新 entry"的双变量比较，不是布尔 busy 标志——它与 `SessionInfo.lastEntryId` 字段配合，把未读判定做成了纯数据比较。

- hover 操作区与右键菜单提供六类操作：置顶/取消置顶、归档/取消归档、打开原始文件（两个子项）、重命名、删除。
  - hover 操作区（第 867-925 行）在 `hovered || rawMenuOpen` 时显示：置顶按钮调 `onUpdate({ pinned: !session.pinned })`，归档按钮调 `onUpdate({ archived: !session.archived })`，打开原始文件是 `DropdownMenu`（两项：desktop 中立层文件 / 内核原始文件）。
  - `rawMenuOpen` 状态专门解决"弹层经 Portal 渲染在行外、鼠标移入弹层触发行 mouseLeave 导致菜单秒关"的根因（第 720-722 行注释）。
  - 右键菜单（`ContextMenu`）复用同一组动作，删除项仅当 `deletable`（非当前活跃会话）时出现，点后进入行内联确认态。

- `ChildSessionRow`（第 995-1100 行）是嵌套子会话行，此前只有"点选切换"、无操作入口，现补齐右键菜单（打开原始文件 + 删除内联确认）。
  - 缩进用 `paddingLeft: "32px"` 区分层级，`deletable = active === false`（活跃子会话不可删——进程 append 会复活文件）。
  - 子行图标复用 `PhaseIcon` 或空心 `MessageSquare`（第 1064-1066 行），标题同样走 `deriveSessionTitle`。

- `NewChatRow`（第 1106-1130 行）是乐观新建条目（设计 `docs/design/optimistic-new-session-entry.md`）的占位行。
  - 显示条件 `showOptimistic = !loading && !!currentCwd && currentNeutralSessionId === null && !query`（第 388 行）：有 cwd、列表已加载、非搜索态、且处于"新对话壳"（当前会话主键为空）。
  - 点击 = 幂等 `newSession()`，与"+"按钮同语义；首条消息落盘 → `sessionStart` 水合 `currentSessionPath` → 占位消失，由真实会话条目接管。
  - 它是纯渲染投影，`sessionInfos` 权威数据源不动；无右键、无 hover 操作区、无拖拽、无未读点。

- `PhaseIcon`（第 1169-1175 行）+ `PHASE_COLOR`（第 1158-1165 行）把 `WorkingPhase` 映射成图标与颜色。
  - 固定形态：`thinking`→`Brain`（脑形，蓝紫色）、`toolExecuting`→`Wrench`（扳手，绿色）；其余忙碌态（`requesting`/`outputting`/`retrying`/`compacting`）→ `LoaderCircle` 转圈。
  - 颜色是 CSS 主题 token（`var(--color-muted)` / `var(--color-primary)` / `var(--color-accent-success)` / `var(--color-accent-error)`）与 `color-mix` 表达式，不是写死色值——注释声明"渲染层内容，主题 token 是查询契约，不新增 token"。

### 6.8 写操作

- 所有写操作都经 `ctx.sessions.*` 走 IPC 到 main 侧 `SessionStore`，本插件不直连任何存储。
  - `ctx.sessions.updateHeader(s.path, patch)`（第 305、532 行）：改写 name/pinned/archived，main 侧 `SessionStore.updateHeader`（session-store.ts 第 707-721 行）双写中立 header + 投影回内核存储。
  - `ctx.sessions.deleteSessions(paths)`（第 319、334 行）：真删会话，main 侧 `deleteSessions`（第 725-734 行）过滤活跃会话后调 `catalog.deleteSessions` 并级联删中立层。
  - `ctx.sessions.rawFilePaths(s.neutralSessionId ?? s.path)`（第 239 行）：解析可打开的原始文件地址，main 侧 `rawFilePaths`（第 611-620 行）返回 `{ desktop, kernel }`。

- 写操作普遍带"乐观摘行 + 权威重拉 + 失败回滚"三段式。
  - 归档/删除点击瞬间 `markRemoving(s.path)` 把行摘出渲染树（第 530、303 行），exit 动画立即播，不等写 + 重拉两跳 IPC。
  - `reloadAfterWrite()`（第 294-297 行）统一走 `useSessionStore.getState().loadSessionInfos(cwd)` 重拉权威列表，返回 promise 供调用方在 finally 里 `clearRemoving()`。
  - `finally` 兜底失败路径：写失败时行必须能回滚，乐观摘除不能永久吞行（第 539-541 行注释）。

- 批量操作做了一层安全护栏：`archiveAll` / `deleteAll` 分别针对"整组归档"与"整组删除"。
  - `archiveAll`（第 301-313 行）对整组 `Promise.all` 并发 `updateHeader({ archived: true })`，失败进 console，但 finally 仍 reload（已写成功的部分要立刻可见）。
  - `deleteAll`（第 329-341 行）先 `filter((s) => s.neutralSessionId !== currentNeutralSessionId)` 剔除当前活跃会话（进程 append 会复活文件），再批量删。
  - `deleteOne`（第 316-326 行）删单个，`confirmingDelete` 内联确认态兜底"真删 JSONL，不可恢复"的强提醒。

- `select`（第 261-290 行）是"点选切换会话"的核心，体现乐观层 + 权威层两层水合契约。
  - 点击瞬间同步写 `setCurrentSessionPath(s.path)` / `setCurrentNeutralSessionId` / `setSessionTitle(deriveSessionTitle(s))`——这是**乐观层**，管高亮即时性（async IPC 事件有毫秒级差，不能等）。
  - 随后 `useSessionStore.getState().openSession(s.neutralSessionId ?? s.path)`——这是**权威层**，main 侧会 dispatch synthetic `sessionStart` 权威水合同一字段；失败时回滚三个乐观字段。
  - 打开成功且 `s.lastEntryId` 存在时补一次 `markRead`（第 282 行）——历史会话打开后无新事件，位标推进需要这个入口（另一入口是活跃会话的 `entryAppended` 事件）。

## 7 三个状态标识：执行中 / 未读 / 乐观移除

- 执行中标识（`phaseByPath`）是 7 值工作阶段，不是布尔忙标志，且覆盖后台会话。
  - 数据来源是 `onKernelEvent` 全量事件流，`advancePhase` 增量推进；注释明确"替代旧的 busyByPath 二元忙标志"（设计 `docs/design/session-working-phase.md §2.3`）。
  - 阶段 → 图标映射在 `PhaseIcon`，与 timeline 底部指示共用同一份 `phaseFromMessage` 优先级判定（working-phase.ts 头注：`phaseFromView` 供 timeline 快照式、`advancePhase` 供 sessions-list 增量式，共享 `phaseFromMessage`，两投影不漂移）。
  - `processExit` / `rpcError` 是权威兜底归 idle 的两个事件源，防止进程退出后行图标卡在忙碌态。

- 未读标识是"位标 vs 最新 entry"的数据比较，落插件私有 config，与列表 reload 解耦。
  - `lastEntryByPath` 由 `entryAppended`（权威）与 `messageEnd`（兜底）增量推进，推进发生在消息到达时刻，不等列表重拉。
  - `readState` 位标推进有两个入口：打开会话瞬间（`select` 内 `markRead`）与活跃会话收到 `entryAppended`（第 215 行）。
  - `readLoadedRef` 闸保证位标从盘上读回前不推进，防止"基于空 ref 写回整对象冲掉盘上其他会话 key"（第 82-83 行注释）。

- 乐观移除（`removing`）是纯渲染投影，权威数据源（`sessionInfos`）不动。
  - `markRemoving` 把 path 加入 `Set`，渲染时 `.filter((s) => !removing.has(s.path))` 摘除（第 490-491 行），`AnimatePresence mode="popLayout"` 让 exit 动画立即播。
  - `clearRemoving` 只在权威重拉完成后调（各写操作的 finally 里），保证回滚正确性。

## 8 与框架 store 的分工

- 本插件读两个框架 store，但遵守"共享 store 只读"纪律：读 `useUiStore` / `useSessionStore` 的状态，写它们只经框架暴露的 setter 动作，不直接 `setState`。
  - 读：`useUiStore` 的 `currentCwd` / `currentNeutralSessionId`；`useSessionStore` 的 `snapshot` / `sessionInfos`。
  - 写：`useSessionStore.getState().openSession(...)` / `.startNewChat(...)` / `.loadSessionInfos(...)`（框架动作，不是裸 set）；`useUiStore.getState().setCurrentSessionPath(...)` / `.setCurrentNeutralSessionId(...)` / `.setSessionTitle(...)`（框架 setter）。
  - 本插件不碰 `useSessionStore.setState`，不碰 `useUiStore.setState`——状态变更意图全部经框架动作表达，符合"插件不直改 store（§8.2 只读纪律）"。

- `newSession`（第 227-232 行）与 `startNewChat` 的分工是"清 UI 态 + 起空会话壳"。
  - 先清 `currentSessionPath` / `currentNeutralSessionId` / `sessionTitle`（三个 null），再 `useSessionStore.getState().startNewChat(currentCwd)`。
  - `startNewChat`（session-store.ts 第 459-463 行）只做 `setContext(cwd, null)` + 清 messages/snapshot/stats/thinkingLevels，**零 RPC**——进程在首次发送时按需起（`ensureForSend`）。

- 标题同步（`syncTitleFromList`，第 157-167 行）处理"活跃会话标题水合"的第二来源。
  - 权威层在 `openSession` 用 detail 设标题；但列表事件更新（后台改名）时标题要跟得上列表最新值，故在 `sessionInfos` 变化时从 `sessions` 里找到活跃会话、`deriveSessionTitle` 重设标题。
  - 这补上了"后台会话被改名后 ui-store.title 变 stale"的缺口（session-store.ts 第 443-448 行注释有对应权威层补写）。

- 手动刷新（`refresh`，第 175-188 行）保留"用户主动重拉"的语义，但走框架入口。
  - `refreshList()` 调 `useSessionStore.getState().loadSessionInfos(currentCwd)`——不自己 list，复用框架的防竞态与双键建图逻辑。
  - `refresh` 里 `Promise.all([refreshList(), new Promise((r) => setTimeout(r, 400))])` 保证转圈至少可见 400ms，再切 `refreshed` 对勾 800ms——这是纯 UX 时序，不是数据正确性依赖。

## 9 本插件如何与其他插件交互

- 先立结论：sessions-list 是"读框架 store + 写框架 store + 会话 API"的插件，它**不参与插件间事件总线**——不 export channels、不 emit、不 invoke、不声明 dependsOn。
  - `renderer/index.tsx` 全文 grep 不到 `ctx.events.`、`export const channels`、`dependsOn`（`plugin.json` 里也无 `dependsOn` 字段）。
  - 这与其他会话插件形成对比：`timeline` export `["timeline:scrollTo", "timeline:rewindRequested", ...]` 且 `dependsOn: ["pi-manager", "message-blocks", "stickers", "goal"]`；`session-tree` `dependsOn: ["timeline"]` 且 export `["session-tree:bookmarkRequested"]`；`goal` export `["goal:state"]`。
  - sessions-list 不需要向谁广播、也不需要订阅谁的 channel——它的数据来自框架、它的状态自己维护，唯一"给出去"的是一组槽位消费语义（`sessionGroupings`）和一组框架 store 写动作。

- 与 `sub-agent` 的交互：这是本插件**唯一**真正"消费别的插件"的通道，走 `sessionGroupings` 槽位。
  - 槽位名：`sessionGroupings`；贡献项 id `subagent`，`parentPathKey` = `subagent.parent_session`，`childLabelKey` = `sub-agent.childLabel`，`childIcon` = `git-fork`。
  - 本插件经 `useSessionGroupings()` 查槽（IPC `window.kernel.slots.sessionGroupings()`），在 `topLevel/childrenByParent` 计算里把 `custom["subagent.parent_session"]` 有值的会话嵌套到父会话下。
  - 双向解耦：sessions-list 不认识 sub-agent，sub-agent 不感知 sessions-list 的画法——一个只声明"父会话路径存在哪个 custom 域 key"，一个只消费"有一组 parentPathKey 规则"。新增一个分组策略 = 新增一个贡献项，sessions-list 一行不改。

- 与 `timeline` 的交互：**无 channel，只经共享框架 store 与共享圆心契约间接耦合**。
  - 共享 store 写读：sessions-list 点选会话时写 `useUiStore.currentSessionPath / currentNeutralSessionId / sessionTitle`，timeline 读同一份 store（`currentNeutralSessionId` 用于其 `sessionModelPending` 写入键，`sessionNonce` / `openNonce` / `syncNonce` 用于重置滚动与重挂 Virtuoso）——两者经框架状态耦合，不经彼此。
  - 共享圆心契约：`WorkingPhase`。timeline 用 `phaseFromView`（快照式，有完整消息数组）驱动底部指示，sessions-list 用 `advancePhase`（增量式，只有事件流）驱动行图标，两者共享 `phaseFromMessage` 的"消息内容 → 阶段"优先级判定——同一份实现，谁都不许本地再写一份（working-phase.ts 头注）。
  - 共享数据源：`sessionInfos`。timeline（及 session-colors）与 sessions-list 都只读 `useSessionStore.sessionInfos`，这是框架统一维护的会话元数据，不是插件间共享 store 互读写。

- 与 `session-tree` 的交互：无直接交互，两者在会话身份上共享 `neutralSessionId` 主键。
  - session-tree 走 `sidePanel` 槽（`id: "tree"`），消费 lineage 树与书签坐标，`dependsOn: ["timeline"]`；sessions-list 不读 lineage 树、不碰书签。
  - 两者的公共语言是 `neutralSessionId`：sessions-list 用它做列表主键、未读 key、customOrder key；session-tree 的锚点/回退也落 lineage 坐标系——它们经圆心 `session-neutral.ts` 的 `NeutralSession` 契约各自消费，互不 import。

- 与 `goal` 的交互：无直接交互。
  - goal 贡献 `blockRenderers`（`set_goal` / `achieve_goal` 工具卡）与 `composerTop`（GoalBar），并带 `piExtension` / `dshExtension` 给内核补能力；它 export `goal:state` channel，但 sessions-list 不订阅。
  - 两者唯一共享的是 sessions 域（都在 `src/plugins/sessions/` 分组下）与框架 store，无槽位或 channel 关联。

- 与 `projects` 的交互：同在 `sidebar` 槽 `group: "main"`，靠 `order` 决定上下位置，无数据交互。
  - `projects`（`order: 5`）在上、sessions-list（`order: 10`）居中、`sub-agent`（`order: 20`）、`ask`（`order: 99`）在下。
  - projects 切换 cwd 会写 `useUiStore.currentCwd`，从而触发框架 `loadForCwd()` 重拉会话列表——这是**经框架 store 的间接连锁**，sessions-list 不感知 projects 的存在。

- 一个反直觉但重要的结论：sessions-list 的"对其他插件的可见影响"主要是**被动的、经框架中介的**，而不是主动的 channel 通信。
  - 它点选会话 → 写 `currentNeutralSessionId` → timeline 跟着切消息流、session-tree 跟着切树、composer 跟着切草稿 key——这些连锁全是别的插件各自订阅框架 store 的结果，sessions-list 一行 emit 都没写。
  - 这符合"插件间通信只走事件，共享 store 只读，要改变框架状态走框架动作"的纪律：sessions-list 改的是框架状态（切会话意图），不是某个插件的私有状态。

## 10 与内核的边界：不读内核存储，走中立层 + 三分法

- 本插件渲染层完全内核无关——全文没有一个 `if (kernel === "pi")` 或 `asPi()` 分支。
  - 行图标、分组、未读、拖拽、右键菜单都不看内核身份；内核差异在适配器与中立层已抹平，本插件只消费中性 `SessionInfo` / `KernelEvent` / `WorkingPhase`。
  - 这是"壳的渲染是纯函数"不变量（§7.5 #3）在本插件的具体体现：给定同一份 `sessionInfos` 与事件流，怎么画与内核无关。

- 唯一触碰"内核专属知识"的地方是"打开原始文件"，它严格走 `SessionCatalog.rawFilePath` 三分法，不拿投影地址硬猜。
  - `fetchRawPaths`（第 237-244 行）调 `ctx.sessions.rawFilePaths(s.neutralSessionId ?? s.path)`，注释明确"原始文件位置是内核专属知识，经服务端 catalog.rawFilePath 解析（§7.6 不硬猜）"。
  - main 侧 `rawFilePaths`（session-store.ts 第 611-620 行）返回两个地址：`desktop` = 中立层会话文件（`<数据根>/sessions/<ns>.json`，壳自己的存储），`kernel` = 内核原始文件（pi = 派生 `.jsonl`，dsh = `session.jsonl.zstd`）。
  - `openRawFile`（第 248-259 行）对 `null` 显式降级通知（`ctx.notify.show` "该会话无可打开的原始文件"），对打开失败也显式报错——不静默，呼应"三分法"里"显式降级、不伪造成功"。

- 会话数据的读写事实：列表读中立层、元数据写双写、原始文件经 catalog 解析。
  - 列表读：`SessionStore.list` → `neutralStore.listByCwd`（中立层，不读内核）。
  - 元数据写：`SessionStore.updateHeader` → `writeNeutralHeader`（中立层是真相源）+ `projectHeaderToKernel`（按会话内核归属投影回内核存储，失败不阻断）。
  - 删除：`deleteSessions` → `catalog.deleteSessions`（删内核文件）+ `neutralStore.delete`（级联删中立树）。
  - 这套"中立层唯一真相源 + 内核存储是投影"的格局，是 `docs/design/session-neutral-layer.md` 阶段 D 的落地，本插件只是消费端，不感知写侧细节。

## 11 持久化

- 本插件有两类持久化：会话元数据（写会话头/中立层，走 `ctx.sessions.updateHeader`）与插件私有数据（写 `ctx.config`，走 plugins-data 私有区）。
  - `pinned` / `archived` 落 `custom-my-harness-desktop` 保留键，`name` 单轨落 `session_info` 条目——main 侧 `updateHeader` 双写中立 header 与内核存储，本插件只传 patch。
  - `readState`（已读位标）与 `customOrder`（拖拽序）落 `ctx.config`，key 分别是 `"readState"` 和 `"customOrder"`；这是插件私有数据，走 `window.kernel.config.get/set(pluginId, key, ...)`（pluginId 由 `PluginIdContext` 自动注入，插件不手写）。

- `markRead`（第 129-137 行）的写盘策略是"有变化才写 + fire-and-forget + ref 保最新"。
  - `if (cur[path] === entryId) return` 短路无变化写；`readStateRef.current` 先同步更新，再 `void ctx.config.set("readState", next)`。
  - 注释说明 `config.set` 有写队列串行化，fire-and-forget 安全；`ref` 保最新值防连续 markRead 的闭包旧值互相覆盖。

- `persistOrder`（第 395-397 行）只在拖拽 `onEnd` 落一次盘，拖动过程只改内存 state。
  - `setGroupOrder` 更新 `customOrderRef` + state（跟手），`persistOrder` 把整份 `customOrderRef.current` 一次性 `ctx.config.set("customOrder", ...)`——`SortableList` 的 `onEnd` 语义是"一次性持久化钩子"。

## 12 QA

**Q：sessions-list 为什么既不 emit/invoke channel、也不声明 dependsOn，这符合"插件间只走事件"的纪律吗？**

符合。纪律说的是"插件间通信只走事件"，但 sessions-list 根本不与任何插件做双向通信——它读的是框架 store（`useSessionStore.sessionInfos` / `useUiStore`），写的是框架状态（切会话意图），消费的是槽位（`sessionGroupings`）。它的所有影响都是经框架中介的被动连锁，不需要主动事件。dependsOn 只在"消费别人 channel（on/invoke）"时才需要声明，sessions-list 不消费任何 channel，自然不声明。

**Q：列表数据到底来自内核存储还是中立层？会不会和内核实际文件不一致？**

当前（阶段 D）列表数据来自壳自己的中立层 `NeutralSessionStore`（`<数据根>/sessions/*.json`），不读 pi 的 `.jsonl` 或 dsh 的 `session.jsonl.zstd`。中立层是唯一真相源，内核存储是它的投影；写元数据时 `updateHeader` 双写（先写中立层、再投影回内核），所以两者最终一致。`path` 字段是投影地址（由 lineageId 派生），不承诺磁盘有对应文件——这正是"打开原始文件"必须走 `rawFilePaths` 而不是直接开 `path` 的原因。

**Q：为什么 `sessionInfos` 是双键 map，渲染时要去重？**

框架 `loadSessionInfos` 处于"主键迁移过渡期"（`§kernel-forkless §32`）：为了让事件流既能按 `path`（运维流 sessionKey）也能按 `neutralSessionId`（中立主键）回查会话，把每个会话同时以两个键存进 map。渲染 `Object.values` 就会把每条会话画两遍（React duplicate key），所以 `SessionsSection` 用 `Set` 按 `neutralSessionId ?? path` 去重。

**Q：未读圆点为什么不直接用"有没有新 entry"布尔，而是做位标比较？**

因为"未读"必须相对"用户读到哪里"。布尔 busy 标志只能表达"这个会话有没有活动"，表达不了"活动之后用户看没看"。位标方案用两个变量：`readState[path]`（用户最后读到哪条 entry id）与 `lastEntryByPath[path]`（这个会话最新 entry id），两者不相等 = 有未读。`lastEntryByPath` 由 `entryAppended`/`messageEnd` 事件增量维护，与列表重拉解耦，所以消息一到就能亮，不必等列表刷新。

**Q：为什么归档/删除要"乐观摘行 + 权威重拉"，直接等 IPC 回来刷新不行吗？**

行直接摘除能让 exit 动画立即播，体感是"点击瞬间消失"；如果等 `updateHeader` + 重拉两跳 IPC，期间行纹丝不动，体感是"停一会儿才消失"。乐观层管即时性，权威层管最终一致性——重拉完成后 `clearRemoving` 让权威数据接管渲染。失败路径靠 `finally` 兜底：写失败时行必须回滚，乐观摘除不能永久吞行。

**Q：`WorkingPhase` 为什么不直接用 timeline 的 `phaseFromView`，而要多一个 `advancePhase`？**

两个投影服务两类消费端：`phaseFromView` 需要完整消息数组（活跃会话，timeline 有），`advancePhase` 只有事件流（后台会话，sessions-list 没有完整消息）。但两者共享 `phaseFromMessage` 的"消息内容 → 阶段"优先级判定，所以不会漂移。`advancePhase` 是增量状态机，`messageEnd` 后回 requesting 是"AI 进思考下一步"的保守估计，最终由 `agentSettled` 权威归零——这是"只有事件流、没有完整视图"的固有属性。

**Q：本插件消费 `sessionGroupings` 槽位时，契约注释说"sessions-list buildGroups 消费"，但代码里实际消费点在别处，这是 bug 吗？**

不是功能 bug，是注释与实现的一次轻微错位。契约注释（`contributions.ts`）写的是早期形态，当时子会话嵌套逻辑在 `buildGroups`；现在实际消费点在 `SessionsSection` 的 `topLevel/childrenByParent` useMemo（`renderer/index.tsx` 第 347-371 行），`buildGroups` 只做 pinned/时间/归档三切。功能语义不变——都是"custom[parentPathKey] 有值的会话嵌套到父会话下"。

**Q：子会话（sub-agent）的删除为什么不支持删除活跃子会话？**

机制兜底：活跃会话的进程还在 append 文件，删了也会被复活，删也白删。所以 `ChildSessionRow` 的 `deletable = active === false`，`deleteAll` 也在批量删除前 `filter((s) => s.neutralSessionId !== currentNeutralSessionId)` 剔除当前活跃会话。这是"不伪造成功"的体现——UI 侧不给出一个注定无效的操作入口。
