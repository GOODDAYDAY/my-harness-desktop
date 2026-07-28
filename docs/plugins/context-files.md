# context-files

## 1 这个插件解决什么问题

用户在 AI 对话时需要查看当前工作目录下有哪些文件——想加 Context 文件、想确认文件结构、想浏览目录树。没有这个插件，用户得切到外部文件管理器看。context-files 把"当前目录文件树"放到右面板，随时可查。

## 2 设计决策

### 2.1 为什么是插件而不是内核

文件树的渲染会变——树形组件会换、交互方式会调。但"能列目录"这个能力不会变——`fs.listDir` 在内核。渲染是内容，推给插件；文件系统能力留内核。

### 2.2 选了什么机制

贡献 `sidePanel` 槽位，`order: 30`。声明 `permissions: ["fs:project"]`——文件系统只读，需要声明权限。这是"声明能力"模式的最简范本：manifest 声明权限，main 进程 IPC 边界校验，插件通过 `ctx.fs` 访问。

### 2.3 和框架的分工

框架管：组件注册、`useUiStore` 全局状态（`currentCwd`）、`FileTree` 共享组件（内部调 `ctx.fs.listDir`）、`EmptyState` 空态组件。插件管：19 行代码——判断有无目录，有就渲染 `FileTree`，没有就显示空态。

## 3 怎么通信

### 3.1 和内核通信

不走 `usePluginContext`——这个插件不直接调 `ctx.fs`。`FileTree` 组件（框架提供的）接收 `pluginId` 和 `cwd`，内部自己调 `ctx.fs.listDir(pluginId, cwd)`。权限声明在 manifest，IPC 边界校验在 main，插件不感知校验逻辑。

### 3.2 和其他插件通信

通过 `useUiStore` 的 `currentCwd` 被动响应——projects 插件切目录时广播 `setCurrentCwd`，context-files 自动重渲染。

## 4 怎么处理

### 4.1 数据流

`currentCwd` 变化 → `FileTree` 组件重渲染 → 内部调 `ctx.fs.listDir(currentCwd)` 拉文件列表 → 渲染树。无目录时显示"先打开文件夹"空态。纯响应式——目录变了就重渲染，不轮询。

## 5 怎么保证

### 5.1 权限校验

`fs:project` 声明在 manifest。当 `FileTree` 内部调 `ctx.fs.listDir` 时，IPC handler 在 main 进程查 `context-files` 的 manifest 是否声明了 `fs:project`——声明了就放行。如果用户没授权，IPC handler 拒绝，`FileTree` 收到错误自己处理。插件不感知权限校验。

### 5.2 零状态

整个组件无 `useState`、无 `useEffect`、无事件订阅。纯函数式——输入 `currentCwd`，输出 `FileTree`。没有状态就没有状态 bug。

## 6 QA

**Q：文件树展开子目录时怎么拉数据？**

`FileTree` 组件内部处理。用户点击展开 → 组件调 `ctx.fs.listDir(pluginId, subDirPath)` 拉子目录。每次展开都是一次 IPC 调用——不预加载整个目录树（大目录会卡）。

**Q：如果目录没有读权限怎么办？**

`ctx.fs.listDir` 的 IPC handler 会返回错误（`fs.readdirSync` 抛 EACCES）。`FileTree` 组件内部处理错误——显示空列表或错误提示。插件不自己处理，因为文件树渲染完全委托给了框架组件。
