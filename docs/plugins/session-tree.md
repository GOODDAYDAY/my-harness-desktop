# session-tree

## 1 这个插件解决什么问题

底座 agent 的会话有分支结构——用户可以从某条消息分叉出新对话。用户需要看到这个分支树，理解会话的结构，并基于结构做三件事：快速定位到时间线某条消息、从某个节点分叉出新对话、在长会话里滤掉噪声（工具调用、结构性事件）只看主干。没有这个插件，用户只能线性浏览消息列表，不知道哪些消息是从哪里分叉的。session-tree 把底座的 `tree` 投影渲染成"会话地图"——富节点分支树 + 全景分支泳道，交互仿底座 TUI 的 `/tree` 命令。

## 2 设计决策

### 2.1 为什么是插件而不是内核

树形渲染会变——树形组件会换、交互方式会调。但"有会话树数据"这个能力不会变——`tree` 在 `SyncSnapshot` 里，由 `SessionStore` 的 `resync` 拉取。渲染是内容，推给插件；投影能力留内核。

### 2.2 选了什么机制

贡献 `sidePanel` 槽位，`order: 40`。零权限、零 configFile。数据走 `useSessionStore`（共享 store 的投影）和 `ctx.sessions.sync()`（强制重拉基线）。

### 2.3 为什么自绘而不是 react-complex-tree

初版用 react-complex-tree，它只提供通用树骨架——节点标题、折叠、键盘导航。会话地图需要的富节点（类型图标 + 分组色点 + 一行预览 + 相对时间）、无信息事件链压缩、行内 hover 动作（定位/Fork/收藏/复制）、全景泳道覆盖层，全都要在它的 render props 里自己画，库本身只剩一个壳。自绘后逻辑层（tree-model.ts）是纯函数可单测，渲染层只是消费，session-tree 不再依赖它。依赖本身保留在 dependencies——`packages/react` 的 file-tree widget 仍在使用。

### 2.4 和框架的分工

框架管：组件注册、`useSessionStore` 共享 store（`snapshot.tree`、`snapshot.leafId` 和 `ready`）、`useUiStore`（`currentCwd`、`currentSessionPath`）、`EmptyState`、事件总线（`timeline:scrollTo` 定位通道）、`ctx.tree.fork`（底座分叉 RPC）。插件管：tree-model 纯逻辑（过滤/压缩/泳道）、树渲染、全景覆盖层、hover 动作。

### 2.5 是否修改了内核

改了，且是有意的契约扩展。初版 TreeNode 只有 entryId/children/isLeaf/label，展示层要画富节点必须自己 join entries——每个消费方各写一遍 join 是"判别气味三"（同一逻辑多处复制）。现在 `domain/events/session-state.ts` 的 TreeNode 扩了三个字段：`entryType`（entry 类型）、`preview`（一行预览）、`timestamp`（时间戳），由 `gateway/context-binding.ts` 的 `toTreeNode` 在投影时从底座 entry 一次性提取（纯函数 `extractTreePreview`）。这是"消费而非翻译"的落地：数据在投影边界就位，展示层直接读，不再二次推导。除此之外不 import `domain/`、`gateway/`、`application/`、`shell/` 的任何实现——插件仍只从 `@pi-desktop/react` 引用类型和 API。删掉这个插件，富化字段仍在投影里（其他消费方可用），内核机制照常运行。

### 2.6 使用了内核的什么功能

- **`useSessionStore`**（框架共享状态）：读取 `snapshot.tree`（`TreeNode[]`，已带 entryType/preview/timestamp/label）、`snapshot.leafId`（当前叶子，判定"当前分支"和高亮）和 `ready`。SessionStore 是投影 owner——pi 进程启动后 `resync` 一次拉基线，后续事件流维持投影鲜活。session-tree 只读不写。
- **`useUiStore`**（框架共享状态）：读取 `currentCwd`（空态判断）和 `currentSessionPath`（收藏事件 payload）。
- **`ctx.sessions.sync()`**（核心默认能力）：刷新按钮触发，强制重拉底座基线——不走缓存。
- **`ctx.tree.fork(entryId, "at")`**（核心默认能力）：从指定节点分叉出新会话（底座 fork RPC；`position: "at"` 表示分叉包含锚点 entry 本身，锚点不限 user 消息——assistant 回答同样合法，`before` 才有 role 校验）。fork 成功后内核自动对账（sync 拿截断基线 + synthetic sessionStart 水合激活路径），调用方不再各自补 `sync()`。
- **`ctx.events`**（事件总线）：invoke `timeline:scrollTo` 定位消息；emit `session-tree:bookmarkRequested` 请求收藏（契约见 §3.3）。
- **`EmptyState`**（框架共享组件）：无目录、pi 未就绪、无树数据时分别使用。

## 3 怎么通信

### 3.1 和内核通信

读 `useSessionStore` 的投影（不拉取）；用户点刷新时调 `ctx.sessions.sync()` 强制重拉基线；Fork 走 `ctx.tree.fork`（底座 fork RPC，fork 后状态对账已收进内核）。三者都是核心默认能力，不需要声明权限。

### 3.2 和其他插件通信

- **出向·定位**：单击节点 invoke `timeline:scrollTo`（channel 由 timeline 插件发布），payload `{ messageId: node.entryId }`——scrollTo 是一次性命令不是可回放状态，按事件总线契约走 invoke 定向分派：调用方不拥有 channel，emit 会因权属校验直接抛错；无订阅者时入队，timeline 挂载时恰好一次投递。TreeNode.entryId 和 timeline 消息的 id 是同一个底座 entry.id（都在 context-binding 投影时取 `pi.id`），所以能直接定位。timeline 找不到该 id 时会挂起等数据到达（pendingScroll），本插件不处理。
- **出向·收藏**：hover 动作 emit `session-tree:bookmarkRequested`（channel 由本插件发布，见 `channels` export），payload `{ sessionPath, entryId, preview }`，session-bookmarks 插件订阅（`replayLast: true`）。
- **入向**：sessions-list 打开会话、projects 切目录时触发 `sync`，`snapshot.tree` 更新，session-tree 自动重渲染——事件驱动，组件只读 store、零拉取。

### 3.3 其他插件怎么使用自己

session-bookmarks 订阅 `session-tree:bookmarkRequested` 把节点加入收藏——订阅方需在 manifest 声明 `dependsOn: ["session-tree"]`。除此之外 session-tree 是纯消费者，不写任何共享状态。概念关联：sessions-list（列表视角 vs 树视角，同一份 snapshot）、token-stats（对照分支确认 token 消耗）。

## 4 怎么处理

### 4.1 文件结构

- **`core/tree-model.ts`**（纯逻辑层，无 React 无 IO）：过滤谓词（`matchesFilter`，四种模式）、可见森林（`visibleForest`/`visibleChildren`，被滤节点的后代上提）、相对时间（`relTime`，Intl.RelativeTimeFormat 零 i18n 键）、路径查找（`findNode`/`findPath`）、分支泳道（`branchLanes`/`uniqueSegment`）、展示行拍平（`compressedRows`，单链压缩 + 手动折叠 + 分叉点缩进）。渲染层只消费不推导。
- **`core/tree-visual.ts`**（共享视觉映射）：entryType → lucide 图标、分组 → 圆点颜色。index.tsx 和 fullscreen-map.tsx 共用，避免两处各写一份。
- **`renderer/index.tsx`**（紧凑树主组件）：顶栏（过滤器 + 回到当前 + 全景开关 + 刷新）+ 展示行列表。
- **`renderer/fullscreen-map.tsx`**（全景泳道覆盖层）：`createPortal` 到 body，Esc/backdrop/× 关闭。

### 4.2 过滤与压缩（仿 TUI /tree 的 Ctrl+O）

四种过滤模式：全部 / 无工具（隐藏 toolResult、bashExecution）/ 仅用户 / 仅标签。过滤语义是"命中保留、未命中的后代上提"——滤掉工具节点后其下的 assistant 回复仍然可见，不是整子树消失。关键约束：`visibleForest` 和 `compressedRows` 必须用**同一个过滤谓词**——节点的 children 是原数组，walk 时靠谓词重新取可见子节点，谓词不同会导致过滤模式下子节点重复出现。

无信息事件链自动压缩：连续的纯事件节点（compaction、model_change、thinking_level_change 等结构性事件——无标签、非当前叶子）单链 ≥2 时合并成一行"×N 条事件"，点击解压。长会话里满屏的 model_change 噪音收成一行。

缩进不随树深度一路加深：只有可见子节点 ≥2 的分叉点才让下一层缩进 +1，线性单链（含压缩链尾部的单子节点）保持同级——"不要一直缩进，只有 fork 才缩进"。窄面板里长会话的主干始终顶格成列，每个分支段成块内缩一级，嵌套分叉再内缩。折叠箭头与缩进互不影响（`hasKids` 仍按可见子节点数判定）。

### 4.3 全景泳道

`branchLanes` 计算：主泳道 = root→当前叶子路径，副泳道 = 其他 root→leaf 路径（按末条时间倒序）。每条副泳道只画**分支独有段**（`uniqueSegment` 去掉与主泳道的最长公共前缀，保留分叉点本身为首元素并标记 GitFork 图标）——共享主干在每条泳道重复出现只有噪音。点节点 = 定位并关闭（由父组件统一关地图）。

### 4.4 刷新与 Fork

刷新按钮调 `ctx.sessions.sync()` 强制重拉基线，`catch(() => {})` 静默错误。Fork 用共享原语 `useArmConfirm` 原位两步确认：第一击武装、按钮原地变"确认分叉？"、第二击执行；6 秒超时或 Esc 自动复位——不会一直锁定。全面板只有 fork 用武装形态（只有它会切换当前会话，是唯一破坏性动作），收藏用 `InlineConfirmInput` 输入形态，定位/复制即时执行。fork/收藏按钮只在 `entryType === "assistant"` 的节点渲染：fork 传 `position: "at"`，语义是"从这条回答后继续"——分叉包含该回答，这是树视图里自然的"从这里分叉"；user 节点不提供入口（"回退到这条 user 之前"是 rewind/重试语义，已由 timeline 的 rewind 和 retry 插件承担，树里再给入口是同一逻辑两处复制）。fork 成功后内核 `reconcileAfterSessionReplacement` 自动对账（底座切到新会话文件，但 `session_start` 不上 RPC stdout、fork 响应不带新路径——内核 sync 一次拿 `get_state` 的 `sessionFile` 真相，切激活路径并 dispatch synthetic sessionStart 水合 renderer，投影基线截断到分叉点），调用方不再各自补 `sync()`。

## 5 怎么保证

### 5.1 纯逻辑层可单测

tree-model.ts 无 React、无 IO、无环境依赖——过滤、压缩、泳道、相对时间都是纯函数，可以直接单元测试。渲染层只剩"把 DisplayRow 画出来"。

### 5.2 防御性数据处理

`extractTreePreview`（gateway）对缺 entry、未知 type、非字符串内容块都有回退（unknown/空串）；`compressedRows` 对无 children 的节点安全；预览截断 120 字符防超长。

### 5.3 空态分档

三档空态：无目录 → "先打开文件夹"、pi 未就绪或无树数据 → 空树提示、有数据 → 正常渲染。

## 6 如果没有这个插件，整个系统会有什么影响

内核不崩溃。侧面板失去"Tree"页签，用户无法在 pi-desktop 内查看和操作会话的分支结构——不能定位、不能从 UI 分叉（底座的 fork 机制仍在运行，agent loop 内分叉不受影响）。TreeNode 的 entryType/preview/timestamp 富化字段留在投影里无害——其他消费方可用可忽略。session-bookmarks 少一个收藏来源（timeline 的 bookmarkRequested 仍在）。第三方插件完全可以替代：贡献同一个 `sidePanel` 槽位、读同样的投影、自己实现渲染。

## 7 QA

**Q：tree 数据从哪来？**

底座的 `get_state` RPC 返回里包含 `tree` 字段。`resync` 在 pi 进程启动后发 5 条 RPC（get_state + get_entries + get_available_models + get_session_stats + get_available_thinking_levels），`tree` 在 `get_state` 的响应里。后续 `sessionStart` / `sessionInfoChanged` 事件会更新 tree。

**Q：为什么 entryType/preview 要在 gateway 投影时提取，而不是插件自己 join？**

初版插件只有 entryId，要画富节点必须拿 entryId 回 entries 里查——这个 join 逻辑每个消费方都要写一遍，且要理解底座 entry 的 content 结构（role、内容块数组、toolName 等十几个 case）。收进 gateway 的 `toTreeNode` 后，投影边界一次提取、所有消费方直接读——构造在内、执行在外，"同一逻辑多处复制"的气味消除。

**Q：Fork 和底座的 agent loop 分叉是什么关系？**

同一条路径。`ctx.tree.fork(entryId, "at")` 就是底座的 fork RPC——底座从该 entry 分叉出新会话文件并切换过去。桌面端只是多了一个 UI 入口，分叉的语义、会话文件格式、切换行为全由底座决定。

**Q：为什么副泳道只画独有段？**

如果每条泳道画完整 root→leaf 路径，分叉点之前的共享主干在每条泳道里重复出现——十条分支就是十遍主干，满眼冗余。去掉公共前缀后，每条泳道第一眼就是"这条分支从哪开始、走了什么自己的路"。
