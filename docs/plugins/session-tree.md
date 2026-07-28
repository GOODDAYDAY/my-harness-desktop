# session-tree

## 1 这个插件解决什么问题

底座 agent 的会话有分支结构——用户可以从某条消息分叉出新对话。用户需要看到这个分支树，理解会话的结构。没有这个插件，用户看不到会话的树形结构，不知道哪些消息是从哪里分叉的。session-tree 把底座的 `tree` 投影渲染成 VSCode 式树形视图。

## 2 设计决策

### 2.1 为什么是插件而不是内核

树形渲染会变——树形组件会换、交互方式会调。但"有会话树数据"这个能力不会变——`tree` 在 `SyncSnapshot` 里，由 `SessionStore` 的 `resync` 拉取。渲染是内容，推给插件；投影能力留内核。

### 2.2 选了什么机制

贡献 `sidePanel` 槽位，`order: 40`。零权限、零 configFile。数据走 `useSessionStore`（共享 store 的投影）和 `ctx.sessions.sync()`（强制重拉基线）。

### 2.3 和框架的分工

框架管：组件注册、`useSessionStore` 共享 store（`snapshot.tree` 和 `ready`）、`useUiStore`（`currentCwd`）、`EmptyState`。插件管：`buildItems` 数据转换（`TreeNode[]` → `react-complex-tree` 格式）、树渲染、刷新按钮。

### 2.4 是否修改了内核

没有。session-tree 只从 `@pi-desktop/react` 导入 `usePluginContext`、`useUiStore`、`useSessionStore`、`EmptyState`、`registerSidePanelComponent`、`TreeNode` 类型。不 import `domain/`、`gateway/`、`application/`、`shell/` 的任何文件。删掉这个插件，内核的 SessionStore 投影、`sync` 机制、事件总线全部照常运行——唯一的变化是侧面板少了一个"Tree"页签。`snapshot.tree` 的数据仍然由 SessionStore 维护，只是少了一个消费它的 UI。
### 2.5 使用了内核的什么功能

- **`useSessionStore`**（框架共享状态）：读取 `snapshot.tree`（`TreeNode[]`，会话分支树的投影数据）和 `ready`（pi 进程是否就绪）。SessionStore 是投影 owner——pi 进程启动后 `resync` 一次拉基线（含 `tree`），后续事件流维持投影鲜活。session-tree 只读不写。
- **`useUiStore`**（框架共享状态）：读取 `currentCwd`，用于判断是否显示"先打开文件夹"空态。
- **`ctx.sessions.sync()`**（核心默认能力）：刷新按钮触发，强制重拉底座基线数据（含 `tree`）——不走缓存。底层走 gateway 的 RPC 适配层发 `get_state` 等 RPC。`sync` 不需要声明权限，是核心默认。
- **`EmptyState`**（框架共享组件）：无目录、pi 未就绪、无树数据时分别使用。
- **`registerSidePanelComponent`**（框架注册函数）：将 `SessionTreeTab` 注册到侧面板组件注册表。
## 3 怎么通信

### 3.1 和内核通信

不走 `usePluginContext` 的常规 API——这个插件读 `useSessionStore` 的投影（不拉取），只在用户点刷新时调 `ctx.sessions.sync()` 强制重拉基线。`sync` 是核心默认能力，不需要声明权限。

### 3.2 和其他插件通信

通过 `useSessionStore` 间接通信。sessions-list 打开会话、projects 切目录时触发 `sync`，`snapshot.tree` 更新，session-tree 自动重渲染。这是"事件驱动"的落地——组件只读 store、零拉取。

### 3.3 其他插件怎么使用自己

session-tree 是纯消费者——它读 `useSessionStore` 和 `useUiStore`，不写任何共享状态。没有其他插件直接依赖 session-tree 的输出。但它渲染的会话树和其他插件存在概念上的关联：

- **sessions-list**：用户可能在会话列表中看到一个会话，然后在 session-tree 中看到它的分支结构——两者消费同一份 `snapshot` 数据（来自 SessionStore），只是视角不同（列表 vs 树）。
- **token-stats**：用户看 token 统计时，可能对照 session-tree 确认"是哪条分支消耗了这些 token"——两者无技术依赖，但概念上互补。

session-tree 不通过 `useSessionStore` 间接影响其他插件——它只读不写，所以其他插件的订阅不会因 session-tree 的存在而收到额外更新。
## 4 怎么处理

### 4.1 数据流

SessionStore 是投影 owner：pi 进程启动后 `sync` 一次拉基线（含 `tree`），后续事件流维持投影鲜活。插件只读 `useSessionStore().snapshot.tree`，不自己拉数据。`buildItems` 把 `TreeNode[]` 转成 `react-complex-tree` 的 flat items 格式——合成一个 `__root__` 虚拟根节点，递归 walk 把每个 `TreeNode` 映射成 `TreeItem`。

### 4.2 刷新

刷新按钮调 `ctx.sessions.sync()` 强制重拉底座基线（不走缓存）。`catch(() => {})` 静默错误——刷新失败不弹错误框，用户可以重试。

## 5 怎么保证

### 5.1 防御性数据转换

`buildItems` 的 `walk` 函数跳过没有 `entryId` 的节点——底座可能推不完整的节点（缺锚）。这是防御性编程：不假设底座数据永远完整。

### 5.2 空态分档

三档空态：无目录 → "先打开文件夹"、pi 未就绪 → 空树提示、有目录有数据 → 正常渲染。每档都有对应的空态组件。

## 6 如果没有这个插件，整个系统会有什么影响

内核不崩溃。侧面板失去"Tree"页签，用户无法在 pi-desktop 内查看会话的分支结构——不知道哪些消息从哪个节点分叉，只能通过消息列表线性浏览。Agent 功能完全不受影响——底座的分支机制仍在运行，用户仍然可以通过 agent loop 分叉新对话，只是看不到树形的可视化。其他插件不受影响：sessions-list 仍然列出所有会话、token-stats 仍然统计 token——它们不依赖 session-tree 的渲染。第三方插件完全可以替代：只需贡献同一个 `sidePanel` 槽位、读同样的 `useSessionStore().snapshot.tree`、自己实现树形渲染，即可提供等价或更强的会话树可视化（比如加搜索、加节点预览、加 diff 对比）。

## 7 QA

**Q：tree 数据从哪来？**

底座的 `get_state` RPC 返回里包含 `tree` 字段。`resync` 在 pi 进程启动后发 5 条 RPC（get_state + get_entries + get_available_models + get_session_stats + get_available_thinking_levels），`tree` 在 `get_state` 的响应里。后续 `sessionStart` / `sessionInfoChanged` 事件会更新 tree。

**Q：react-complex-tree 为什么要 canDragAndDrop=false？**

因为树是只读投影——底座的分支结构不由桌面端编辑。拖拽排序、重命名都禁用。用户想分叉新对话走底座的 agent loop，不走桌面端 UI。
