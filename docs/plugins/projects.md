# projects

## 1 这个插件解决什么问题

用户在多个工作目录之间切换时，需要一个"最近打开的项目"列表。没有这个插件，用户每次启动 pi-desktop 都要手动选目录；切回上一个项目要重新打开目录选择器。projects 把"最近工作目录"这件事持久化，一点就切，拖拽排序。

## 2 设计决策

### 2.1 为什么是插件而不是内核

"最近目录列表"的渲染会变——排序规则、显示数量、拖拽交互都可能调。但"能读写插件配置"这个能力不会变——`ctx.config.get/set` 是内核机制。渲染是内容，推给插件；配置读写能力留内核。

### 2.2 选了什么机制

贡献 `sidebar` 槽位，`order: 5`（排在会话列表上面）。零权限——`ctx.config` 是核心默认能力。零 `configFile`——但用了 `ctx.config.get/set("recentCwds", ...)` 存最近目录列表到 `~/.pi-desktop/plugins-data/projects/config.json`，这是 `config` 默认能力的落地，不需要声明 configFile。

### 2.3 和框架的分工

框架管：组件注册、`useUiStore` 全局状态、`Section` 共享组件。插件管：目录列表持久化（`ctx.config`）、拖拽排序（`@dnd-kit`）、目录切换逻辑。

### 2.4 是否修改了内核

没有。projects 只从 `@pi-desktop/react` 导入受控 API——`usePluginContext`、`useUiStore`、`useSessionStore`、`Section`、`registerSidebarComponent`。不 import `domain/`、`gateway/`、`application/`、`shell/` 的任何文件。删掉这个插件，内核的加载器、槽位契约、RPC 适配、配置读写全部照常运行——唯一的变化是侧栏少了一个"项目"分组。内核不依赖任何具体插件，projects 只是往 `sidebar` 槽位上挂了一个组件。
### 2.5 使用了内核的什么功能

- **`ctx.config.get/set`**（核心默认能力）：读写 `recentCwds` 数组。底层走 IPC → main 进程 `ConfigStore` → `writeJsonFile` + `withDirLock`。插件不感知文件路径和锁逻辑。
- **`ctx.dialog.openDirectory`**（用户手势驱动）：弹系统目录选择器。用户点"+"按钮触发，默认放行。底层走 Electron `dialog.showOpenDialog`，返回绝对路径字符串。
- **`useUiStore`**（框架共享状态）：`setCurrentCwd(dir)` 广播当前工作目录切换，`setCurrentSessionPath(null)` + `setSessionTitle(null)` 清空会话上下文，`bumpSession()` 递增 `sessionNonce` 触发会话列表刷新。
- **`useSessionStore`**（框架共享状态）：`getState().startNewChat(dir)` 新建会话——清空视图，不预启动 pi 进程。
- **`Section`**（框架共享组件）：提供带标题栏和 actions 插槽的容器样式。
- **`registerSidebarComponent`**（框架注册函数）：在插件加载时将 `ProjectsSection` 注册到内核的侧栏组件注册表。
## 3 怎么通信

### 3.1 和内核通信

走 `usePluginContext("projects")` 拿绑定上下文。`ctx.config.get<string[]>("recentCwds")` 读列表，`ctx.config.set("recentCwds", list)` 写列表。`ctx.dialog.openDirectory()` 弹系统目录选择器——用户手势驱动，默认放行。

### 3.2 和其他插件通信

不直接通信。切目录时走 `useUiStore` 广播：`setCurrentCwd(dir)` 通知 sessions-list 重拉会话列表、`setCurrentSessionPath(null)` + `setSessionTitle(null)` 清空会话上下文、`bumpSession()` 触发 `sessionNonce` 变化。`useSessionStore.getState().startNewChat(dir)` 新建会话——清空视图，不预启动进程。

### 3.3 其他插件怎么使用自己

projects 通过 `useUiStore` 的 `currentCwd` 间接影响几乎所有插件。projects 切换目录时调 `setCurrentCwd(dir)`，以下插件被动响应：

- **sessions-list**：读取 `currentCwd` 变化后重拉会话列表，同时 `sessionNonce` 变化触发 `bumpSession()` 的连锁更新。
- **context-files**：读取 `currentCwd`，`FileTree` 组件自动重渲染为新目录的文件树。
- **git-review**：`useEffect` 依赖 `[currentCwd, visible]`，`currentCwd` 变化时自动刷新 Git 状态。
- **session-tree**：读取 `currentCwd` 判断是否显示"先打开文件夹"空态。
- **run-panel**：当前为空占位，不响应 `currentCwd`，后续接入事件订阅后可能间接关联。

插件之间不直接通信——projects 不调用 sessions-list 的 API，也不发送事件给它。projects 只写 `useUiStore` 的共享状态，其他插件作为订阅者被通知。
## 4 怎么处理

### 4.1 数据流

启动时 `ctx.config.get("recentCwds")` 读列表，渲染。用户点目录项 → `switchCwd(dir)` → 广播全局状态 → 切到新目录。用户打开新目录 → `ctx.dialog.openDirectory()` → 加入列表头部（已存在则先移除再置顶）→ `ctx.config.set` 持久化 → 切过去。

### 4.2 拖拽排序

`@dnd-kit/core` + `@dnd-kit/sortable` 实现拖拽。拖完 `arrayMove` 重排 → `persist(next)` 写回 `ctx.config`。拖拽用 `PointerSensor`（鼠标 + 触摸），`closestCenter` 碰撞策略。每个目录项是 `useSortable` 的返回——`transform` 和 `transition` 由 dnd-kit 管理，不手写 mousemove 事件链。

### 4.3 切换语义

点项目只切换、不重排——置顶只由"新增/拖拽"触发。这避免了"点一下就顶到最上"的困惑。列表上限 10 个，超出截断。

## 5 怎么保证

### 5.1 配置持久化安全

`ctx.config.set` 走 IPC → main 进程的 `ConfigStore` → `writeJsonFile` + `withDirLock`。文件锁串行化并发写，不会撕裂。插件不自己写文件操作——锁逻辑在内核一处。

### 5.2 切目录失败处理

`switchCwd` 包了 `try/catch`，失败时 `console.error` 记录但不崩溃——UI 还在，用户可以重试。`startNewChat` 如果失败（比如目录不可读），全局状态已经被设了（`currentCwd` 已切），但会话列表为空——用户看到空列表知道有问题。

## 6 如果没有这个插件，整个系统会有什么影响

内核不崩溃——加载器、槽位契约、RPC 适配均不受影响。侧栏失去"项目"分组，用户失去了"最近打开目录"列表。用户每次启动 pi-desktop 或切换工作目录时，需要手动点击系统目录选择器——功能上仍可实现，但效率大幅下降。sessions-list 和其他插件不会因此崩溃——它们读取 `currentCwd`，如果 `currentCwd` 为空则显示空态。第三方插件完全可以替代：只需贡献同一个 `sidebar` 槽位、读同样的 `useUiStore`、调同样的 `ctx.dialog.openDirectory` 和 `ctx.config` API，即可提供等价或更强的目录管理功能。

## 7 QA

**Q：拖拽排序后如果 config 写失败怎么办？**

UI 已经更新了（`setCwds(next)` 先于 `ctx.config.set`），但持久化失败。下次重启会恢复旧顺序。当前没有回滚 UI 状态——这是已知缺口：应该在 `ctx.config.set` 的 Promise reject 时回滚 `setCwds`。标注"演进"。

**Q：两个 pi-desktop 实例同时打开，会覆盖彼此的 recentCwds 吗？**

会。`writeJsonFile` 用 `withDirLock` 串行化同一进程内的并发写，但跨进程的文件锁（`proper-lockfile`）在同一台机器上也能工作——stale 5s。所以两个实例几乎同时写时，后写的会等先写的释放锁后再写，不会撕裂。但后写的会覆盖先写的内容——这是"最后写赢"语义，不是合并。
