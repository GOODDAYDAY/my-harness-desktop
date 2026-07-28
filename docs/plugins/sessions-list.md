# sessions-list

## 1 这个插件解决什么问题

用户打开一个工作目录后，需要看到这个目录下所有 AI 会话的列表——哪些在跑、哪些结束了、哪些置顶了、哪些归档了。没有这个插件，用户只能去文件管理器里翻 JSONL 文件，看不到会话标题、最后一条消息预览、置顶/归档状态。sessions-list 把"会话列表"这件事从文件系统层面提升到 UI 层面——分组、搜索、右键操作、实时刷新。

## 2 设计决策

### 2.1 为什么是插件而不是内核

会话列表的渲染逻辑会变——分组方式会调、搜索规则会改、右键菜单会加项。但"有会话列表"这件事不会变——只要 pi-desktop 有会话，就需要列表。问题是：渲染逻辑会换（分组方式、视觉风格、交互模式都可能变），所以渲染是内容，推给插件。但"列会话"这个能力不会换（内核的 `sessions.list` API 在 `domain/sessions.ts` 定义，经 `SessionStore` 实现），所以能力留在内核。插件消费内核暴露的能力，自己决定怎么画。

### 2.2 选了什么机制

贡献 `sidebar` 槽位，`order: 10`（排在 projects 下面）。零权限——`sessions.list` 是核心默认能力，不需要声明 `permissions`。零 `configFile`——会话列表不需要持久化配置，所有元数据（pinned/archived/name）存在 JSONL 文件头行里，经 `ctx.sessions.updateHeader` 写回。

### 2.3 和框架的分工

框架管：组件注册（`registerSidebarComponent` 按名字匹配 manifest）、全局状态（`useUiStore` 提供 `currentCwd` / `currentSessionPath` / `sessionNonce`）、共享组件（`Section` 提供标题栏 + 折叠容器）。

插件管：数据拉取（`ctx.sessions.list`）、事件订阅（`ctx.sessions.onEvent`）、分组逻辑（`buildGroups`）、右键菜单（Radix ContextMenu）、动画（framer-motion）、会话行渲染。

## 3 怎么通信

### 3.1 和内核通信

走 `usePluginContext("sessions-list")` 拿绑定后的上下文。`ctx.sessions` 是核心默认能力——不需要声明权限。`ctx.sessions.list(currentCwd)` 拉会话列表，`ctx.sessions.updateHeader(path, patch)` 写 JSONL 头行，`ctx.sessions.onEvent(cb)` 订阅事件流。`ctx.dialog.openFile(path)` 用系统默认编辑器打开原始 JSONL 文件——用户手势驱动，默认放行。

### 3.2 和其他插件通信

不直接通信。通过 `useUiStore` 共享全局状态：`setCurrentSessionPath` 通知 timeline 插件切换会话、`setSessionTitle` 通知标题栏更新、`bumpSession()` 触发 `sessionNonce` 变化让其他订阅者知道会话列表变了。`useSessionStore.getState().openSession(path)` 打开会话——纯文件读，不起进程。

## 4 怎么处理

### 4.1 数据流

`currentCwd` 或 `sessionNonce` 变化 → `useEffect` 重拉 `ctx.sessions.list(currentCwd)` → `setSessions` → 分组渲染。这是事件触发的拉取——目录变了就拉一次，不轮询。

增量刷新走单独的事件订阅 `useEffect`：`ctx.sessions.onEvent` 收到 `agentSettled` 事件时重扫列表——一轮对话结束后副标题（最后一条消息预览）自动更新。事件监听器在 `useEffect` 返回时清理（`onEvent` 返回取消函数），组件卸载不泄漏。

### 4.2 分组

三段式：已置顶（带 Pin，恒在最上）→ 时间四档（今天/昨天/过去7天/更早，各可折叠）→ 已归档（默认折叠）。搜索时平铺——归档项带 Archive 角标仍可搜到。`buildGroups` 是纯函数不依赖 `t()`，label 存 i18n key，`GroupBlock` 渲染时翻译。

批量归档对一组会话逐个写头行 `archived:true`——`Promise.all` 并行，各文件各自锁（`withDirLock`），不互相阻塞。

### 4.3 会话行

标题 `name ?? id.slice(0, 8)`——未命名用 UUID 前 8 位（整串太吵）。副标题 `lastMessage ?? created.toLocaleString()`——有最后一条消息就预览，没有就显示创建时间。

右键菜单（Radix ContextMenu）支持重命名、置顶/取消置顶、归档/取消归档、打开原始文件。hover 时显示快捷操作按钮（置顶/归档/打开原始文件），`stopPropagation` 不点穿行选中。重命名走内联 `<input>`，Enter 提交写回 `updateHeader({ name })`，Escape 取消。

## 5 怎么保证

### 5.1 事件监听器清理

`ctx.sessions.onEvent` 返回取消函数，`useEffect` 的 cleanup 调它——组件卸载后监听器不残留。这是根因修复：不是"内存泄漏"这个表象，是 `ipcRenderer.on` 返回的不是 off 函数这个 API 使用方式问题。

### 5.2 闭包陷阱

两个 `useEffect` 的依赖数组分别包含 `[currentCwd, sessionNonce]` 和 `[currentCwd]`。第一个拉列表，第二个订阅事件。如果第一个的依赖少了 `sessionNonce`，其他插件改了会话列表后这个组件不会重拉——闭包捕获了旧的 `currentCwd`，看起来对但 `sessionNonce` 变化时不会重跑。依赖数组必须完整包含所有影响输出的变量。

### 5.3 空态处理

三档空态：无目录 → "请先打开目录"、有目录无会话 → "暂无会话"、搜索无匹配 → "无匹配结果"。loading 期间显示"加载中..."。每档都有对应的 i18n key，不是硬编码文案。

## 7 是否修改了内核

没有。这个插件不碰内核任何一行代码。它只从 `@pi-desktop/react` 导入受控 API（`usePluginContext`、`useUiStore`、`useSessionStore`、`Section`、`SessionInfo` 类型），所有数据操作走 `ctx.sessions.*`（IPC 调用，main 进程处理）。插件不 import `@/application/...`、`@/gateway/...`、`@/shell/...`——依赖方向只向外。

如果删掉这个插件，内核的 `sessions.list` / `sessions.updateHeader` / `sessions.onEvent` 能力照常存在，只是没有消费者。`useUiStore` 里的 `currentSessionPath` / `sessionNonce` 照常存在，只是没人写它们。这正是"机制与内容分离"要的效果：内容（这个插件）删了，机制（会话能力、全局状态）不动。

## 8 使用了内核的什么功能

- **`ctx.sessions.list(cwd)`**：核心默认能力，读当前目录下的 JSONL 会话文件列表。返回 `SessionInfo[]`——path、id、name、created、lastMessage、pinned、archived。底层是 `session-scanner.ts` 扫描目录 + 解析每个 JSONL 文件头行。

- **`ctx.sessions.updateHeader(path, patch)`**：核心默认能力，写 JSONL 文件头行的 `name` / `pinned` / `archived` 字段。底层走 `session-scanner.ts` → `writeJsonFile` + `withDirLock` 串行化。插件不感知锁逻辑——锁在内核一处。

- **`ctx.sessions.onEvent(cb)`**：核心默认能力，订阅事件流。底层是 `session-store.ts` 的 `dispatch` ——底座推 `AgentSessionEvent` → `translateEvent` 翻译成中性 `SessionEvent` → 转发给所有订阅者。`onEvent` 返回取消函数，`useEffect` cleanup 调它。

- **`ctx.dialog.openFile(path)`**：用户手势驱动能力，用系统默认编辑器打开 JSONL 文件。底层走 IPC → main 进程 `shell.openPath`。

- **`useUiStore`**：全局状态（`currentCwd`、`currentSessionPath`、`sessionNonce`），来自 `@pi-desktop/react` 的 zustand store。插件读写全局状态——写 `setCurrentSessionPath` 通知其他消费者，读 `currentCwd` 响应 projects 插件的目录切换。

- **`useSessionStore.getState().openSession(path)` / `.startNewChat(cwd)`**：会话投影 store 的命令式 API。`openSession` 是纯文件读（不起进程），`startNewChat` 清空视图不预启动。

- **`Section` / `SessionInfo` 类型**：`Section` 是框架提供的左栏折叠容器组件，`SessionInfo` 是圆心定义的类型（`domain/sessions.ts`），经 `@pi-desktop/core` re-export → `@pi-desktop/react` 再 re-export。类型契约单源——插件不定义"本地版"。

## 9 其他插件怎么使用自己

sessions-list 不暴露自己的 API 给其他插件——插件之间不直接通信。其他插件通过共享状态间接消费 sessions-list 的输出：

- **timeline 插件**：sessions-list 调 `setCurrentSessionPath(path)` 切会话 → timeline 订阅 `useUiStore` 的 `currentSessionPath` 变化 → 重渲染消息列表。timeline 不知道是 sessions-list 切的会话，它只知道全局状态变了。

- **token-stats 插件**：sessions-list 调 `bumpSession()` 触发 `sessionNonce` 变化——但 token-stats 不订阅 `sessionNonce`，它订阅 `ctx.sessions.onEvent` 的事件流。两者独立工作。token-stats 的统计数据跟随会话事件更新，和 sessions-list 的列表操作不耦合。

- **projects 插件**：projects 切目录时调 `useSessionStore.getState().startNewChat(dir)`——这个调用清空了会话上下文。sessions-list 订阅 `currentCwd` 变化，目录变了就重拉会话列表。两个插件通过 `useUiStore` 的 `currentCwd` 间接协作。

- **session-tree 插件**：sessions-list 的 `openSession` 和 `startNewChat` 都走 `useSessionStore`——session-tree 读 `useSessionStore` 的 `snapshot.tree` 投影。切会话时 projection 更新，session-tree 自动重渲染。

## 10 如果没有这个插件，整个系统会有什么影响

用户看不到会话列表。打开一个工作目录后，侧栏的"对话"分组消失。用户无法：
- 看到当前目录下有哪些会话
- 搜索会话
- 新建会话（`startNewChat` 的入口在这里）
- 置顶/归档/重命名会话
- 打开历史会话的原始 JSONL 文件

系统不会崩溃——内核的 `sessions.list` / `sessions.updateHeader` / `sessions.onEvent` 能力照常工作，`useUiStore` 的全局状态照常存在。只是没有 UI 消费这些能力。其他插件（timeline、token-stats、session-tree）不受直接影响——它们不依赖 sessions-list 组件存在，只依赖全局状态和事件流。

但 `startNewChat` 的入口消失了——用户没有 UI 入口新建会话。这个影响是实质性的：虽然 `useSessionStore.getState().startNewChat(cwd)` 的能力还在，但没有人调它。用户只能通过 projects 插件间接触发（projects 切目录时调 `startNewChat`），但那不是显式"新建会话"的操作。

第三方插件可以替代 sessions-list——贡献一个 sidebar 槽位的组件，调 `ctx.sessions.list` 渲染自己的会话列表。这是"无特权差异"的落地：内置的 sessions-list 被删掉，第三方同名插件可以覆盖上来。
