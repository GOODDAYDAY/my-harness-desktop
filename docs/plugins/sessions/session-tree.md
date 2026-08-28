# session-tree 插件技术文档

session-tree 是挂 `sidePanel` 槽位的壳插件，把当前会话的分支结构渲染成两种视图：右面板内的紧凑"铁轨泳道树"，以及点"全景"后经 `createPortal` 覆盖全屏的 SVG git-graph 泳道图。它只做一件事——把会话的分叉关系变成用户能看懂、能点、能操作的地图，定位、分叉、收藏三个动作都从这张图出发。它的全部数据来自框架共享 store 与内核契约，自身零权限、零 configFile、零内核插件，是一个纯消费型 UI 插件。

## 1 定位与依赖边界

- session-tree 是一个**纯渲染插件**，不拥有任何会话状态：它读 `useSessionStore` 的投影快照、读 `useUiStore` 的会话指针，通过 `ctx.tree.fork` 发出分叉意图、通过 `ctx.events` 与 timeline/session-bookmarks 通信，但从不写框架 store、从不直接读内核存储。
- 它的 manifest（`src/plugins/sessions/session-tree/plugin.json`）声明了最小接入面：`id` 为 `session-tree`、`version` 为 `0.4.9`、`tier` 为 `official`、`renderer` 指向 `./renderer/index.tsx`、`dependsOn` 只有 `["timeline"]`。
- `dependsOn: ["timeline"]` 不是加载顺序控制，而是生命周期护栏（`packages/react/src/event-bus.ts` 的注册语义 + CLAUDE.md §8.2）：session-tree 会 `invoke` timeline 拥有的 `timeline:scrollTo` channel，按"凡消费别人 channel 就声明 dependsOn"的纪律声明它。
- 依赖方向严格向内：`renderer/index.tsx` 只从 `@my-harness-desktop/react` 和 `@my-harness-desktop/shared` import（`usePluginContext`、`useUiStore`、`useSessionStore`、`EmptyState`、`InlineConfirmInput`、`useArmConfirm`、`TreeNode`、`LineageTree`），`core/tree-model.ts` 只 import `TreeNode` 类型，`core/tree-visual.ts` 只 import `lucide-react` 图标——没有任何一处 import 壳后端、内核实现或具体内核存储格式。
- 插件目录结构（`src/plugins/sessions/session-tree/`）是"core 纯逻辑 + renderer 渲染 + locales 文案"三件套：`core/` 放无 React 无 IO 的纯函数，`renderer/` 放 React 组件，`locales/` 放四个 locale 的文案字典，没有 `pi-extension/` 也没有 `dsh-extension/`——因为本插件不补任何内核能力，只在既有契约上消费。

## 2 文件清单与各文件职责

- `plugin.json`：贡献一个 `sidePanel` 项 `{ id: "tree", label: "Tree", icon: "list-tree", component: "SessionTreeTab", order: 40 }`，外加 `languages` 槽的 12 条贡献（3 个命名空间 × 4 个 locale）。
- `renderer/index.tsx`：导出 `SessionTreeTab` 组件（框架按 `component: "SessionTreeTab"` 自动匹配，§7.4 组件自动匹配）与 `export const channels = ["session-tree:bookmarkRequested"] as const`（第 24 行）。这是主组件，含顶栏、统计条、泳道行列表、hover 动作、分支概览、全景开关。
- `renderer/fullscreen-map.tsx`：导出 `FullscreenMap` 全景覆盖层组件，`createPortal` 到 `document.body`，画 SVG git-graph。
- `core/tree-model.ts`：纯逻辑层，无 React 无 IO，可单测——分组、过滤、相对时间、路径查找、分支泳道、展示行拍平（`compressedRows`）。
- `core/tree-visual.ts`：渲染层共享的视觉映射——`entryType` → lucide 图标（`iconOf`）、分组 → 圆点颜色（`dotColor`），`index.tsx` 与 `fullscreen-map.tsx` 共用，避免两处各写一份。
- `core/tree-model.test.ts`：`compressedRows` 泳道拍平语义的 vitest 单测，覆盖脊柱选择、旁支深度、铁轨延续、线性链、leafId 回退、折叠。
- `locales/zh-CN/system.json`：33 个 `system.*` 键，是本插件的主要文案源；`locales/zh-CN/shell.json` 只有 1 个键 `shell.bookmarkNode`；`locales/zh-CN/plugin.json` 是 displayName/description 的 2 个键。

## 3 数据源之一：投影树（渲染的主数据源）

- 渲染的**主数据源是 `snapshot.tree`**（`TreeNode[]`），不是 lineage 树——`renderer/index.tsx` 第 102 行 `const nodes = useMemo(() => snapshot?.tree ?? [], [snapshot])` 直接取投影快照里的树。
- `snapshot` 是 `useSessionStore()` 返回的 `SyncSnapshot`（`packages/shared/src/domain/events/session-state.ts` 第 196 行），字段含 `state`、`entries`、`messages`、`tree: TreeNode[]`、`commands`、`leafId: string | null`。
- `TreeNode`（同文件第 145 行）是本插件的核心消费类型，六个字段全在投影边界就位：`entryId`（节点锚点）、`children?`、`isLeaf?`、`label?`、`entryType?`（entry 类型）、`preview?`（一行预览）、`timestamp?`（毫秒时间戳）。
- 投影富化发生在适配器层，不在插件里：`src/server/kernel/pi/protocol/context-binding.ts` 的 `toTreeNode`（第 73 行）递归把 pi 的 `SessionTreeNode` 映射成 `TreeNode`，`entryId` 取 `pi.entry?.id`，`entryType`/`preview` 由 `extractTreePreview`（第 90 行）从 entry 一次性提取，`timestamp` 经 `entryTimestampMs` 归一。
- `extractTreePreview` 是"消费而非翻译"的落地：它按内核 `session-manager.d.ts` 的真实线格式（载荷在顶层，不包在 `content` 里）逐 type 提取——`message` 按 role 分派（user/assistant/toolResult），`model_change`/`thinking_level_change`/`compaction`/`branch_summary`/`label`/`session_info`/`custom`/`custom_message` 各取对应字段，assistant 无文本块时取工具调用名兜底（`⚡ bash · read`），缺 entry 回退 `unknown`。插件拿到的是成品 `preview`，不再二次 join。
- `snapshot.leafId`（第 103 行 `const leafId = snapshot?.leafId ?? null`）标记当前活跃叶子，是全插件判定"当前分支"的唯一起点：它决定高亮行（`n.entryId === leafId`）、回到当前按钮的显隐、`compressedRows` 的脊柱选择。
- `snapshot?.state.sessionName`（第 105 行）是会话显示名的单源（与 timeline 收藏同一拍板），无名会话回退节点预览——`SessionState.sessionName` 定义在 `session-state.ts` 第 126 行。
- `useUiStore`（`src/web/stores/ui-store.ts`）提供三个指针：`currentCwd`（第 113 行，空态判断）、`currentSessionPath`（第 115 行，收藏事件 payload 与 getTree 回退）、`currentNeutralSessionId`（第 117 行，fork 与分支概览的主键）。

## 4 数据源之二：lineage 树（分支概览模式）

- 插件还有一个**次级数据源**：点顶栏 `GitFork` 按钮切到 `overviewMode` 时，拉取内核的 `LineageTree` 展示纯分叉关系，与逐条明细的投影树并存。
- 拉取逻辑在 `renderer/index.tsx` 第 93–100 行的 `useEffect`：仅当 `overviewMode && currentNeutralSessionId` 时调 `ctx.sessions.getTree(currentNeutralSessionId ?? currentSessionPath)`，成功 `setLineageTree(tree)`，失败 `setLineageTree(null)`，且带 `cancelled` 守卫防竞态（切会话/关概览后旧响应丢弃）。
- `LineageTree` 类型在 `packages/shared/src/domain/backend.ts` 第 44–49 行：`{ rootId: string; lineages: Lineage[] }`，只含分叉关系、不含 entries——它回答"这个会话有哪几条 lineage、各自从哪条父 lineage 的哪个位置切出来"，不回答"每条 lineage 里有什么消息"。
- `Lineage`（第 36–41 行）只有两个字段：`id`（后端自留的 lineage 标识，pi=分支锚点条目 id、dsh=子会话 id，桌面当不透明 id 用）与 `fork: LineageFork | null`（根 lineage 为 null）。
- `LineageFork`（第 28–33 行）与 `BoundaryRef`（第 25 行）是理解分叉坐标的关键：`fork.parentLineageId` 是父 lineage id，`fork.boundary` 是不透明字符串，pi 把它当 entryId、dsh 把它当 seq 的字符串化，语义上总指向"父 lineage 里一个完整回合之后的位置"。
- 概览模式的渲染（第 210–216 行）逐条 `lineageTree.lineages.map`：有 fork 的显示 `branchFork`（`分支 {{id}}（从 {{parent}} 第 {{boundary}} 分叉）`），无 fork 的显示 `branchRoot`（`根 {{id}}`），id 与 parent 各截前 8 位，boundary 原样显示——这直接暴露了 `BoundaryRef` 的不透明性：pi 下是 entry id、dsh 下是 seq，插件不做任何解析。
- `projectLineageTree`（backend.ts 第 181 行）是圆心纯函数，定义"节点从条目换成分叉点"的投影语义：沿首子走到尽头的最大线性链是一条 lineage，某节点 >1 个子节点即分叉点（首子延续当前 lineage、其余子各开分支、`fork.boundary` = 分叉点节点的 entryId）。它是 LineageTree 语义的契约参照，session-tree 不直接调用它，但理解它才能理解 `Lineage.fork.boundary` 的取值来源。

## 5 数据源之三：中立会话树与 lineageContent（fork 的地基）

- 分叉关系的**持久化真相源是中立会话树** `NeutralSession`（`packages/shared/src/domain/session-neutral.ts` 第 27 行），`session-tree` 通过 `ctx.tree.fork` 间接触发对它的写，自身不读它，但 fork 的语义完全由它定义。
- `NeutralSession` = `{ neutralSessionId, header, lineages: NeutralLineage[] }`，`NeutralLineage`（第 54 行）= `{ lineageId, fork: { parentLineageId, boundaryEntryId } | null, entries: NeutralEntry[] }`——注意这里的 fork 用的是 `boundaryEntryId`（中立 entry id），与 `LineageTree` 里的 `fork.boundary`（内核私有 boundary）是两个坐标系，`resolveForkBoundaries`（第 133 行）负责把后者归一到前者。
- `NeutralEntry`（第 62 行）= `{ neutralEntryId, kernelEntryId?, message, display? }`，其中 `neutralEntryId` 是 `{lineageId}:{seq}`（`neutralEntryId` 函数，第 91 行），`kernelEntryId` 是内核私有 entry id（投影时的 opaque 线索，仅 adapter 用）。
- `lineageContent`（第 277 行）是"分叉归壳"的地基纯函数，也是 fork 惰性物化时的内容来源：给定 `(session, lineageId)`，沿 `fork` 链向上 walk，取父 lineage 到 `boundaryEntryId` 为止的前缀（含端点，之后的丢弃），再拼自身独有条目，返回一条 lineage 的完整线性内容。
- `lineageContent` 的防御语义值得单独记：父引用悬空 → 当根处理（无前缀）；环 → `visited` 集合停，不无限递归；`boundaryEntryId` 反查不到 → 边界截断失效。这三条与 `sortLineagesTopologically`（第 106 行，父先于子、环降级、悬空当根）共同保证损坏数据下 seed/切换不炸。
- 中立树的读写全部在壳后端 `src/server/application/sessions/session-store.ts`：`readNeutral`（第 843 行）、`appendNeutral`（第 857 行）、`snapshotNeutralSession`（第 885 行，逐 lineage 调 `backend.getTree` + `backend.getEntries` 把内核树水合成中立树并落盘）、`getTree`（第 743 行，中立层优先、`catalog.getTree` 兜底）。
- `snapshotNeutralSession` 是中立树的首次水合路径，值得单独展开：它先 `backend.getTree` 拿全部 lineage，再逐 lineage `backend.getEntries(l.id)` 读独有条目，每条 entry 填 `neutralEntryId = neutralEntryId(l.id, i)` 与 `kernelEntryId = msg.id`，然后 `resolveForkBoundaries(sortLineagesTopologically(lineages))` 把内核私有 boundary 归一到中立 `boundaryEntryId`，最后 `derivedHeaderFromSession` 回填列表行字段。这条路径是"壳不读内核存储格式、只经契约投影"的落地载体，常规运行不触发（中立层随上行同步持续新鲜），只在损坏兜底与跨内核切换时作为回退。

## 6 渲染管线：tree-model 纯逻辑层

- 渲染层"只消费、不推导"是硬约束：`renderer/index.tsx` 顶部注释明说"渲染层只消费，不推导"，所有从 `TreeNode[]` 到可画结构的推导都收在 `core/tree-model.ts`，这是 §3.3"框架管通用、特化归外层"在插件内部的一次自我复制——把会变的推导收成纯函数，渲染层只剩画。
- `groupOf`（tree-model.ts 第 12 行）把 `entryType` 归成四组：`chat`（user/assistant）、`tool`（toolResult/bashExecution/custom/custom_message）、`label`（label/label_reset）、`event`（其余结构性事件，如 compaction/model_change）；`TreeGroup` 类型在第 10 行。
- `matchesFilter`（第 24 行）实现四种过滤模式 `TreeFilter = "all" | "noTools" | "userOnly" | "labeled"`，与 `renderer/index.tsx` 第 26 行的 `FILTERS` 数组一一对应，`FILTER_KEY` 把模式映射到 i18n key（`system.filterAll` 等）。
- `visibleForest`（第 42 行）与 `visibleChildren`（第 32 行）实现"命中保留、未命中的后代上提"的过滤语义：滤掉工具节点后其下 assistant 回复仍可见，不是整子树消失。
- 关键约束（tree-model.ts 第 129–133 行注释 + `renderer/index.tsx` 第 106 行注释）：`pred` 必须同一引用贯穿 `visibleForest` 与 `compressedRows`——节点 `children` 是原数组，`walk` 时靠 `pred` 重新取可见子节点，谓词不同会导致过滤模式下子节点重复出现。实现上用 `useMemo` 按 `filter` 缓存 `pred`（`renderer/index.tsx` 第 107 行）。
- `compressedRows`（第 138 行）是核心算法，把可见森林拍平成 `DisplayRow[]`（第 112 行），每行含 `node`、`depth`、`run?`（压缩链元信息）、`hasKids`（是否有可见子节点）、`forkKids`（分出的旁支数 = 可见子节点数 - 1）、`cont`（铁轨延续数组）。
- 单链压缩：`chainable`（第 125 行）= 纯事件组、无标签、非当前叶子；沿单链向下收集连续 `chainable` 节点，`run.length >= 2` 时合并成一行 `run: { count, types }`，`expandedRuns` 里的链头解压成普通节点。
- 泳道模型（第 134–136 行注释 + `spineOf` 第 161 行）：多子节点的孩子分两类——**脊柱孩子**（子树含当前叶子者优先，否则子树时间戳最新者）同深度延续泳道、最后走；**旁支孩子** depth+1、先走，分支块紧贴分叉点。这是 git-graph 化的核心，也是 `tree-model.test.ts` 第 26–30 行断言的对象（`["root","a1","b1","b2","c1"]` 对应 `depth [0,0,1,0,0]`）。
- `cont` 由倒扫得出（第 203–211 行）：`nextAt[d]` 记下方最近的深度 d 行，被更浅行截断即失效，渲染层据此决定每条铁轨是否向下延续（`tree-model.test.ts` 第 37–44 行断言 `cont` 语义）。
- `branchLanes`（第 84 行）与 `uniqueSegment`（第 102 行）服务全景图：`main` = root→当前叶子的路径（`findPath` 第 74 行），`others` = 其他 root→leaf 路径按末条时间倒序；`uniqueSegment` 去掉与主泳道的最长公共前缀、保留分叉点本身，使每条旁支只画分支独有段。
- `relTime`（第 52 行）用 `Intl.RelativeTimeFormat` 产出相对时间，零新 i18n 键；`findNode`/`findPath` 是通用树查找。

## 7 渲染层：紧凑树与全景图

- 紧凑树主组件 `SessionTreeTab`（`renderer/index.tsx` 第 76 行）先做三档空态：`!currentCwd` → `shell.openFolderFirst`；`!ready || nodes.length === 0` → `system.sessionTree`/`system.emptyTreeDesc`；有数据才渲染。
- 顶栏（第 160–199 行）是分段过滤器 + 四个图标按钮：`GitFork` 切 `overviewMode`、`Crosshair` 回当前叶子（`invoke timeline:scrollTo`）、`Maximize2` 开全景、`RefreshCw` 调 `ctx.sessions.sync()`。
- 统计条（第 200–206 行）遍历整棵树计数（第 113–127 行的 `stats` useMemo）：`forks` 判据是 `(n.children ?? []).length > 1`，即分叉点 = 子节点数 > 1 的节点；`tools` 用 `groupOf(n.entryType) === "tool"` 计，其余按 `entryType` 分 user/assistant。
- `RowGutter`（第 44 行）是行左侧的 SVG 泳道 gutter：`cont.slice(0, d0)` 画延续竖轨，本行轨道画到 `cy`，`forkKids > 0` 时画分叉弧线（从节点点到旁支轨的贝塞尔），压缩链画虚线方块，叶子加环，label 组加警示色环。
- 泳道色 `railColor`（第 38 行）用 `color-mix` 混 CSS 变量：主干 `--color-primary`、旁支依次 `--color-accent-warning`/`--color-accent-success`/`--color-muted`，色深即层级——token 是查询契约（合规），具体色值是主题插件贡献的（值外挂）。
- 行渲染（第 219–326 行）：`run` 行显示"×N 条事件"虚线药丸，点击解压；普通行显示图标 + 截断文本（`n.label || n.preview || n.entryId.slice(0, 8)`）+ `forkKids > 0` 时的 `⑂N` 徽章 + 相对时间 + hover 动作组。
- `textStyleFor`（第 341 行）按分组分层配色：user 最亮、assistant 次之、tool 等宽 muted、event 斜体、label 警示色——这是"渲染是纯函数"的直观体现，给定同一 `entryType` 序列，配色与内核无关。
- `iconOf`/`dotColor`（`core/tree-visual.ts`）是紧凑树与全景图共用的视觉映射：`ICONS` 表覆盖 14 个 entryType（user/assistant/toolResult/bashExecution/compaction/model_change/thinking_level_change/branch_summary/compactionSummary/branchSummary/label/label_reset/session_info/custom/custom_message），`dotColor` 按 `groupOf` 分组着色。
- `FullscreenMap`（`fullscreen-map.tsx`）用 `createPortal` 挂到 `document.body`：`branchLanes(nodes, leafId)` 分主/副泳道，`laneOf` Map 记归属（主干=0，旁支 `uniqueSegment` 独有段依次 1..n），节点 y 取全局时间序等距（第 61 行 sort + 第 62–66 行 pos），相邻节点间隔 >20 分钟画弱时间分隔线（第 67–70 行 gaps）。
- 全景交互：悬停节点出 tooltip（entryType + 时间 + 预览），点击 = 定位并关闭（`onLocate` 由父组件统一关），Esc/点 backdrop/× 关闭（第 37–43 行 keydown + 第 81 行 backdrop）；泳道头悬浮列顶，旁支标注独有段条数（`system.laneOtherCount`）。

## 8 fork 操作与边界

- fork 的触发路径是：`renderer/index.tsx` 第 143–145 行 `const fork = (node) => void ctx.tree.fork(currentNeutralSessionId ?? "", node.entryId).catch(() => {})`，即传两个参数——第一参名义上是父 lineage id（实际传 `currentNeutralSessionId ?? ""`），第二参是 `node.entryId`（boundary）。
- `ctx.tree` 是 `SessionTreeApi`（`packages/shared/src/domain/sessions.ts` 第 277 行）：`fork(parentLineageId: string, boundary?: string): Promise<string>`，继承 `RpcOps.getStats`；`usePluginContext`（`packages/react/src/plugin-context.ts` 第 107 行）把它桥接到 `window.kernel.sessions.fork(parentLineageId, boundary)`。
- IPC 层（`src/server/controllers/sessions.ts` 第 132–136 行）注册 `IPC.session.fork` → `sessionStore.fork(parentLineageId, boundary)` → `notifyHeaderChanged({ kind: "fork", parentLineageId })`。
- **关键实现细节**：`sessionStore.fork`（`session-store.ts` 第 1531 行）并不使用传入的 `parentLineageId` 参数，而是用 `proc.activeLineageId` 作父——第 1541 行 `fork: { parentLineageId: proc.activeLineageId, boundaryEntryId: boundary ?? "" }`。所以渲染层传的第一参（`currentNeutralSessionId`）实际是冗余的，真正生效的是第二参 `boundary`。
- fork 本体是**壳在中立层的纯操作**（第 1534 行注释）：`newLineageId = randomUUID()`，`readNeutral` 读当前中立会话，`upsertNeutralLineage`（`session-neutral.ts` 第 243 行）插入一条空 entries 的新 lineage，`fork` 记父 lineage 与 boundary，最后 `proc.activeLineageId = newLineageId` 翻转活跃分支指针并返回新 id。
- fork 是**惰性物化**：fork 当下不调内核 fork RPC、不复制文件、不新增列表条目（第 1534–1535 行注释），分支只在下次 `sendMessage` 时经 `materializeActiveLineage`（第 1552 行）seed 投影——`lineageContent` 取活跃 lineage 的完整线性内容，`factory.seed` 或 `backend.seed` 物化到内核。
- `materializeActiveLineage` 的 seed 决策树值得展开：先判 `materializedLineageId === activeLineageId`（一致则早退）；不一致则 `lineageContent` 取完整线性内容、`backend.stop()` 停旧进程；随后分两支——`factory.seed` 能预 seed（pi，纯文件写、先 seed 得路径再以该路径 spawn）则 `factory.create` + `newBackend.start()`，否则（dsh，seed 是 RPC 依赖进程）`factory.create` + `start` 后再 `newBackend.seed(lineage, seedOpts)`。最后换绑 `proc.backend`、`proc.boundSessionPath`、重绑事件、`materializedLineageId = activeLineageId`。这套差异由 `BackendFactory.seed` 的返回 null 与否分流，壳不写 `if (kernel === "pi")`。
- boundary 的取值来源是 `node.entryId`，即投影树节点的 entryId，对 pi 而言是 `pi.entry?.id`（`context-binding.ts` 第 76 行，内核私有 entry id）。这正对应 `BoundaryRef` 契约（backend.ts 第 25 行）："pi 后端把它当 entryId"，桌面不解析它的内容，只当 token 在 fork/bookmark/resume 间回传。
- UI 层 fork 用 `useArmConfirm<string>()`（第 89 行）做**两击原位确认**：第一击 `armFork(n.entryId)` 武装、按钮原地变"确认分叉？"、第二击 `disarmFork()` 后 `fork(n)`；全面板只有 fork 用武装形态（只有它会切换当前会话，是唯一破坏性动作），收藏用 `InlineConfirmInput` 输入形态，定位/复制即时执行。
- fork/收藏按钮只在 `n.entryType === "assistant"` 的节点渲染（第 290 行）：注释明说"收藏语义 = 从这条回答后继续（fork 'at'）"，user 节点不提供入口——"回退到这条 user 之前"是 rewind/重试语义，已由 timeline 承担，树里再给入口是同一逻辑两处复制。
- fork 成功后壳自动对账（第 1625 行 `reconcileAfterSessionReplacement`）：内核切换会话文件不推事件（`session_start` 是纯扩展事件，fork 响应不带新路径），框架主动 sync 拿 `get_state.sessionFile` 真相，切激活路径并 dispatch synthetic `sessionStart` 水合 renderer——所以调用方（session-tree）不需要在 fork 后自己补 `sync()`。

## 9 与其他插件交互

- session-tree 通过 `sidePanel` 槽贡献右面板的 `tree` Tab（`order: 40`），这是它被用户看到的唯一入口；`SidePanelContribution`（`packages/shared/src/domain/contributions.ts` 第 81 行）支持可选的 `revealOn`（该 channel 被 emit/invoke 时框架展开右面板并激活本 Tab），但 session-tree 的 manifest **没有声明 `revealOn`**——它的 Tab 由用户手动切换，不被任何 channel 自动揭示。
- 与 **timeline** 的关系是"消费方 → 拥有方"的单向 invoke：单击节点 `locate(node)`（第 138–142 行）调 `ctx.events.invoke("timeline:scrollTo", { messageId: node.entryId })`，回到当前按钮（第 186 行）同样 invoke 同 channel 带 `leafId`。
- 为什么用 invoke 不用 emit：`timeline:scrollTo` 是 timeline 插件拥有的 channel（`src/plugins/sessions/timeline/renderer/index.tsx` 第 20 行 `channels` 导出），session-tree 是调用方不拥有权属；`event-bus.ts` 第 112–129 行 `emit` 会校验 channel 归调用方所有（否则抛错），第 134–152 行 `invoke` 不要求权属、无订阅者时入队、首个订阅者 attach 时恰好一次投递——`renderer/index.tsx` 第 139–140 行注释显式说明了这个选择。
- timeline 消费端（`timeline/renderer/index.tsx` 第 491–506 行）订阅 `timeline:scrollTo`，payload 支持 `{ messageId }`（scrollToMessageId）或 `{ position: "top" | "bottom" }`；`TreeNode.entryId` 与 timeline 消息的 `id` 是同一内核 entry id（都在投影时取 `pi.id`），所以能直接定位，找不到时挂 `pendingScrollRef` 等数据到达。
- 与 **session-bookmarks** 的关系是"发布方 → 订阅方"的 emit：hover 收藏动作（第 269 行）`ctx.events.emit("session-tree:bookmarkRequested", { sessionPath: currentSessionPath, entryId: n.entryId, preview: n.label ?? n.preview ?? n.entryId.slice(0, 8), label })`。
- `session-tree:bookmarkRequested` 是 session-tree **自己拥有**的 channel（第 24 行 `channels` 导出），所以用 emit 合法；session-bookmarks 在 `renderer/index.tsx` 第 209 行订阅 `ctx.events.on("session-tree:bookmarkRequested", handler(false))`，`BookmarkRequest`（第 26 行）= `{ sessionPath, entryId, preview, label }`，`label` 空则静默跳过（第 199 行 `if (!req.label?.trim()) return`）。
- 收藏最终落 `ctx.sessions.bookmark`（`plugin-context.ts` 第 84 行 → `sessionStore.bookmark` 第 770 行），它物化某节点的完整前缀成自包含快照文件——session-tree 只发请求、不感知快照存储。
- 收藏链路端到端：session-tree `emit` → session-bookmarks `on`（`handler(false)`）→ `createBookmark(req, req.label)`（session-bookmarks 第 200 行）→ `ctx.sessions.bookmark(sessionPath, entryId, id, label, preview)`（第 84 行）→ `sessionStore.bookmark`（第 770 行）物化前缀快照。`handler(false)` 的 `editAfter=false` 表示"树行来源已原位输入完，静默创建"，与 timeline 一击收藏的 `editAfter=true`（创建后进改标题）区分开——`session-tree:bookmarkRequested` 走静默创建分支。
- 与 **sessions-list** 的关系是"上游状态 → 下游消费"的读依赖：sessions-list 的 `select()`（`src/plugins/sessions/sessions-list/renderer/index.tsx` 第 261 行）乐观写 `currentSessionPath` + `currentNeutralSessionId`，再 `openSession`；session-tree 读这两个指针（第 79 行）感知会话切换，`snapshot.tree` 更新后自动重渲染——事件驱动，组件只读 store、零拉取。
- session-tree 不向任何插件广播自己的状态，它是纯消费者 + 两个出向 channel（一个 invoke、一个 emit）的发布者，与 sessions-list/timeline/session-bookmarks 的耦合全部经槽位与事件总线，无共享 store 互写（§8.2 纪律）。

## 10 契约与类型单源清单

- 本插件消费的每一个类型都有唯一圆心定义，插件内零副本：`TreeNode`/`SyncSnapshot`/`SessionState`（`session-state.ts`）、`LineageTree`/`Lineage`/`LineageFork`/`BoundaryRef`（`backend.ts`）、`NeutralSession`/`NeutralLineage`/`NeutralEntry`/`lineageContent`（`session-neutral.ts`）、`SessionTreeApi`（`sessions.ts`）、`PluginEventsApi`/`PluginContext`（`context.ts`）、`SidePanelContribution`（`contributions.ts`）。
- `PluginEventsApi`（`context.ts` 第 229 行）钉死三种原语：`emit`（只能发自己声明过的 channel）、`on`（带可选 `replayLast`）、`invoke`（定向分派到别的插件 channel，无订阅者入队、恰好一次投递）——session-tree 三种都用：emit 发收藏请求、invoke 发定位命令、on 不用（它不订阅任何插件 channel，只订阅 `system:*` 之外没有）。
- `SessionTreeApi.fork` 是唯一被调用的内核契约方法，`ctx.sessions.getTree` 与 `ctx.sessions.sync` 是 `SessionsApi`（`plugin-context.ts` 第 57–90 行）的两个方法——三者都是核心默认能力，不需要声明权限，所以 manifest 的 `permissions` 字段为空。

## 11 QA

**Q：投影树（snapshot.tree）和 lineage 树（LineageTree）是什么关系？**

投影树是渲染的日常数据源，节点带 entryType/preview/timestamp/label 富化，是"逐条明细树"；lineage 树只有分叉关系（id + fork），是"分叉点树"，只在 `overviewMode` 时经 `ctx.sessions.getTree` 拉取。前者服务逐行渲染，后者服务分支概览，两者并存不互相替代。

**Q：为什么 `ctx.tree.fork` 传了 parentLineageId，session-store 却用 activeLineageId？**

这是壳后端的实现选择：分叉只可能从当前活跃 lineage 切出（内核是单线执行器，只物化当前活跃那条），所以 `sessionStore.fork` 忽略传入的 parent、直接取 `proc.activeLineageId`。渲染层传 `currentNeutralSessionId` 更多是契约签名对齐，真正生效的是第二参 `boundary`。

**Q：fork 为什么不立即调内核，而是惰性物化？**

因为 fork 是壳在中立层的纯操作——切一条新 lineage 只是 `upsertNeutralLineage` 一条空 entries + 翻转活跃指针，零内核 RPC、零文件复制。内核只在下次 `sendMessage` 时经 `materializeActiveLineage` 把活跃 lineage 的完整线性内容（`lineageContent`）seed 投影进内核，换绑到新会话。这是"内核是单线执行器、分叉归壳"的直接体现。

**Q：`node.entryId` 作为 fork boundary，到底是中立 id 还是内核私有 id？**

是内核私有 id。投影树的 `entryId` 来自 `toTreeNode` 的 `pi.entry?.id`（pi 的 entry id），对应 `BoundaryRef` 契约里"pi 后端把它当 entryId"的定义。中立坐标系里的 `boundaryEntryId` 是 `{lineageId}:{seq}`，由 `resolveForkBoundaries` 在快照/切换路径做归一，session-tree 不感知这个差异。

**Q：为什么定位用 invoke、收藏用 emit，不能反过来吗？**

`timeline:scrollTo` 是 timeline 拥有的 channel，session-tree 是调用方——emit 会因权属校验抛错（`eventBus.emit` 检查 `isChannelOwnedBy`），所以定位必须 invoke；`session-tree:bookmarkRequested` 是 session-tree 自己声明的 channel，emit 合法。反过来：session-tree 无法 emit 别人的 channel，session-bookmarks 也不会去 invoke 一个该由对方发布的收藏请求。

**Q：为什么 fork/收藏按钮只在 assistant 节点上，user 节点不能分叉吗？**

语义取舍：树里的 fork 是"从这条回答后继续"（收藏语义同此），锚点是 assistant 回答完成之后的位置。而"回到这条 user 之前重发"是 rewind/重试语义，已由 timeline 的 rewind 和 retry 承担。同一逻辑两处各给入口违反收敛纪律，所以树只保留 assistant 入口。

**Q：session-tree 删掉会怎样？**

内核不崩溃。右面板失去 `tree` Tab，用户不能在桌面内看/操作分支结构，但内核的 fork 机制照常运行（agent loop 内分叉不受影响）。`TreeNode` 的富化字段留在投影里无害（其他消费方可用可忽略），session-bookmarks 少一个收藏来源（timeline 的收藏仍在）。第三方插件可贡献同 `sidePanel` 槽、读同投影、自实现渲染来替代它。
