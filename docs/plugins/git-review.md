# git-review

## 1 这个插件解决什么问题

用户在 AI 对话时需要看工作区的 Git 改动——哪些文件改了、diff 是什么。没有这个插件，用户得切到终端跑 `git status` 和 `git diff`。git-review 把工作区改动和 diff 放到右面板，可见即刷新，不切会话不刷（工作区不因切会话而变）。

## 2 设计决策

### 2.1 为什么是插件而不是内核

Git status 的渲染会变——diff 视图会换、分组方式会调。但"能读 Git 状态"这个能力不会变——`git.status` / `git.fileDiff` / `git.fileContent` 在内核。渲染是内容，推给插件；Git 只读能力留内核。

### 2.2 选了什么机制

贡献 `sidePanel` 槽位，`order: 10`。声明 `permissions: ["git:read"]`——Git 只读，需要声明权限。三个子页签：本轮（空态占位，turn 级追踪待接入）、本对话（空态占位）、Git 工作区（真数据）。

### 2.3 和框架的分工

框架管：组件注册、`useUiStore` 全局状态、`EmptyState` 空态组件。插件管：Git 数据拉取（`ctx.git`）、diff 渲染（`react-diff-view`）、子页签切换（Radix Tabs）、可见性判断。

### 2.4 是否修改了内核

没有。git-review 只从 `@pi-desktop/react` 导入 `usePluginContext`、`useUiStore`、`EmptyState`、`registerSidePanelComponent`。不 import `domain/`、`gateway/`、`application/`、`shell/` 的任何文件。删掉这个插件，内核的加载器、IPC 权限校验（`git:read`）、Git 只读能力全部照常运行——唯一的变化是侧面板少了一个"Review"页签。`ctx.git.status` / `ctx.git.fileDiff` / `ctx.git.fileContent` 是内核提供的 IPC 能力，其他插件如果也声明了 `git:read` 权限，照样能调。
### 2.5 使用了内核的什么功能

- **`ctx.git.status(cwd)`**（声明能力 `git:read`）：返回 `{ isRepo, files: [{ path, status }] }`。底层在 main 进程 spawn `git status --porcelain`，结果解析后返回。权限校验在 IPC 边界——manifest 声明了 `git:read` 才放行。
- **`ctx.git.fileDiff(cwd, path)`**（声明能力 `git:read`）：返回 unified diff 文本。底层 spawn `git diff -- <path>`。用于渲染已修改文件的 diff 视图。
- **`ctx.git.fileContent(cwd, path)`**（声明能力 `git:read`）：返回文件纯文本。用于渲染未跟踪文件（status `?`）的内容预览——未跟踪文件无 diff，退到纯文本展示。
- **`useUiStore`**（框架共享状态）：读取 `currentCwd`（目录切换时重刷）、`activeSidePanelTab`（判断页签是否可见，不可见时不 spawn git 进程）。
- **`EmptyState`**（框架共享组件）：非 Git 仓库、无改动、页签空态均使用。
- **`registerSidePanelComponent`**（框架注册函数）：将 `GitReviewTab` 注册到侧面板组件注册表。
## 3 怎么通信

### 3.1 和内核通信

走 `usePluginContext("git-review")` 拿绑定上下文。`ctx.git.status(cwd)` 拿工作区改动列表，`ctx.git.fileDiff(cwd, path)` 拿 unified diff，`ctx.git.fileContent(cwd, path)` 拿未跟踪文件的纯文本。`git:read` 声明在 manifest，IPC 边界校验。

### 3.2 和其他插件通信

通过 `useUiStore` 的 `currentCwd` 和 `activeSidePanelTab` 被动响应。projects 切目录时自动重刷。页签切换时 `activeSidePanelTab` 变化，插件据此判断是否可见。

### 3.3 其他插件怎么使用自己

git-review 是纯消费者——它读 `useUiStore` 的 `currentCwd` 和 `activeSidePanelTab`，不写任何共享状态。没有其他插件依赖 git-review 的输出。它是侧面板上的一个独立页签，和同面板的其他插件并置但互不依赖。projects 切换目录时广播 `setCurrentCwd`，git-review 被动刷新——但它不是被"使用"，而是被"触发"。插件之间的通信完全通过共享状态而非直接调用。
## 4 怎么处理

### 4.1 数据流

刷新时机有三档：页签变可见（`activeSidePanelTab === "review"`）、`currentCwd` 变、手动刷新。切会话不刷——工作区文件不因切会话而变。这是"事件驱动，不轮询"的落地——不做定时轮询，只在状态变化时拉数据。

### 4.2 diff 渲染

`react-diff-view` 的 `parseDiff` 解析 unified diff 文本，`Diff` + `Hunk` 组件渲染。未跟踪文件（`?` 状态）无 diff，退到 `ctx.git.fileContent` 纯文本预览。

## 5 怎么保证

### 5.1 可见性门控

`visible = activeSidePanelTab === "review"`。只有可见时才刷——`useEffect` 依赖 `[currentCwd, visible]`。不可见时不发 `git.status`（spawn 一个 git 进程），不浪费 CPU。这是"事件驱动"的落地——组件从"我要什么就去拉"变成"我在乎什么就订阅什么"。

### 5.2 非 repo 处理

`ctx.git.status` 返回 `{ isRepo: false }` 时显示"不是 Git 仓库"空态，不报错。防御性——用户可能在非 Git 目录下工作。

## 6 如果没有这个插件，整个系统会有什么影响

内核不崩溃。侧面板失去"Review"页签，用户无法在 pi-desktop 内查看工作区的 Git 改动——需要切到终端跑 `git status` 和 `git diff`。其他插件不受影响：context-files 仍然能浏览文件树、session-tree 仍然能渲染会话分支、token-stats 仍然能统计 token——它们不依赖 git-review 的存在。内核的 `ctx.git.*` 能力持续可用，第三方插件只需贡献同一个 `sidePanel` 槽位、声明 `git:read` 权限、使用同样的 `ctx.git` API，即可提供等价或更强的 Git 审查功能（比如接入 turn 级追踪、做 staged/unstaged 分栏视图）。

## 7 QA

**Q：diff 很大时会卡吗？**

`react-diff-view` 渲染完整 diff，不做虚拟滚动。大 diff（几千行）可能卡。当前没有做虚拟化——标注"演进"。

**Q：git status 执行很慢时怎么办？**

`ctx.git.status` 是异步 IPC 调用，不阻塞 UI。但用户在等待期间看到的是旧数据，不是 loading 态——当前没有 loading 指示器。标注"演进"。

**Q：为什么"本轮"和"本对话"页签是空的？**

turn 级追踪需要底座提供"哪些消息属于哪一轮"的元数据，底座当前不提供。这是已知缺口——等底座补了 turn 级追踪 RPC 后接入。
