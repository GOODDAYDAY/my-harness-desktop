# 会话节点收藏（session-bookmarks）

## 0 这个插件解决什么问题

pi 的会话有分支结构——用户可以从某条消息 `fork` 出新分支继续对话。但 fork 是即时的、跟着原会话走的：原会话删了，分支也没了；用户想"保存某个有价值的对话节点，日后从那个点重新开始"做不到。

session-bookmarks 解决的是**节点的持久化收藏**。用户在对话中遇到一个有价值的节点（某条消息对应的 entryId），把它收藏起来。收藏是一个 snapshot——保存那一刻的会话状态，跟原始会话完全隔离。原始会话删了、改了，收藏不受影响。点击收藏项，直接从那个节点 fork 出新分支，开始新的对话。

收藏跟着项目走——每个项目目录（cwd）有自己的收藏集，切项目切收藏。收藏数据存在用户级目录下按 cwd 分桶，不写项目目录（不污染项目代码库）。

## 1 整体架构

两个交付物，一个在壳层、一个在插件层：

- **(A) sidePanel 外壳改版**——当前右面板是横排 Tab（Radix Tabs，图标+文字水平排列在顶部）。改为竖排图标条：最右侧一条窄竖排图标（~48px 宽）常驻不消失，点击图标展开对应面板内容到图标条左侧，再点同一图标收起内容区但图标条仍在。这是 shell 层 `right-panel.tsx` 的机制变更，影响所有 sidePanel 插件的布局呈现，但不改槽位契约——插件仍然贡献 `{id, label, icon, component}`，外壳换一种方式渲染它们。

- **(B) session-bookmarks 插件**——贡献一个 sidePanel 槽位，图标是一个书签。面板内是收藏列表，支持增删改查和搜索。收藏创建有多个入口：时间线消息右键、会话树节点按钮、面板内手动添加。点击收藏项触发 fork 流程：复制 snapshot 文件到 pi sessions 目录 → 启动 pi → fork 从 entryId 分叉。

两个交付物的关系是：(A) 提供竖排图标的渲染壳，(B) 是挂在这个壳上的一个图标。没有 (A)，(B) 也能用横排 Tab 呈现，但用户体验差——竖排图标条是收藏列表这种"常驻可点开"交互的前提。

## 2 sidePanel 外壳改版

### 2.1 当前结构

`right-panel.tsx` 用 Radix Tabs 渲染横排页签。`Tabs.List` 在顶部水平排列所有 sidePanel 贡献项（图标+文字），`Tabs.Content` 在下方按选中态切换。所有 `Tabs.Content` 都用 `forceMount` 保持挂载——切走不卸载，靠 CSS `data-[state=inactive]:hidden` 隐藏。这保证 token-stats 的事件流订阅、session-tree 的 store 订阅在切走时不断。整个右面板包在 `react-resizable-panels` 的一个 `Panel` 里，`rightPanelOpen` 控制这个 Panel 的 expand/collapse——收起时宽度归零，整个右面板消失。

### 2.2 目标结构

改为竖排图标条：最右边缘一条窄竖排图标条（~48px）常驻，面板内容区在图标条左侧。收起面板时只保留图标条，展开时图标条+内容区并排。

布局上，图标条从 `PanelGroup` 里拆出来作为它的兄弟节点——它不参与 resize，固定宽度，永远可见。内容区仍然在 `PanelGroup` 里，`rightPanelOpen` 控制内容区 Panel 的 expand/collapse（沿用 `collapsedSize={0}` + imperative collapse，不条件渲染——避免 `react-resizable-panels` 动态增删 Panel 子节点导致的布局跳变和百分比重算）。结构从外到内：

```
<div flex-row>                              ← 整个右侧
  <PanelGroup flex-1>                       ← 可 resize 区域(3 Panel 不变)
    <Panel: Sidebar collapsible />          ← 左栏
    <PanelResizeHandle />
    <Panel: MessageList />                 ← 中区
    <PanelResizeHandle />
    <Panel: RightPanelContent collapsible   ← 右面板内容区,collapse 到 0
             collapsedSize={0} />
  </PanelGroup>
  <div w-12>                                ← 图标条,常驻,PanelGroup 的兄弟
    <SidePanelStrip />
  </div>
</div>
```

（`Panel:` 是伪代码标注，表示该 Panel 里渲染哪个组件，不是实际 JSX 语法。）

`SidePanelStrip` 是从 `right-panel.tsx` 拆出来的新组件，只渲染竖排图标。`RightPanelContent` 渲染当前活跃图标的对应组件。两者共享 `activeSidePanelTab` 状态。内容区 Panel 仍然用 `collapsedSize={0}` + `imperativeApi.collapse()`/`expand()`——和当前实现一样，`rightPanelOpen` 变化时调 `panelRef.current.collapse()` 或 `.expand()`。不条件渲染 Panel，PanelGroup 的子节点数始终是 3（Sidebar + MessageList + RightPanelContent），不会触发动态增删。

### 2.3 交互模型

- 点击图标时，如果该图标对应的面板不是当前活跃面板 → 切换 `activeSidePanelTab` 到该面板，同时 `setRightPanelOpen(true)` 展开内容区（如果已展开则不重复展开）。
- 点击图标时，如果该图标对应的面板已经是活跃面板 → toggle `rightPanelOpen`（展开则收起，收起则展开）。
- 面板收起时，图标条仍可见，当前活跃图标有高亮态（表示"收起的是这个面板"），点击它重新展开。
- `rightPanelOpen` 的语义从"整个右面板是否可见"变为"内容区是否展开"——图标条永远可见。这个语义变更影响 `titlebar.tsx` 的开关按钮（仍然 toggle `rightPanelOpen`）和 `⌘J` 快捷键（同上）。按钮行为不变（还是 toggle 同一个布尔值），但视觉结果变了：以前按 `⌘J` 右边整条消失，现在按 `⌘J` 只收起内容区、图标条留着。这是设计意图——图标条常驻是竖排布局的核心价值。
- `rightPanelOpen` 的默认值从 `true` 改为 `false`——首次打开时图标条可见但内容区收起，用户点图标才展开。避免新用户面对一个撑满右侧的面板不知如何收起。
- **首次点击行为**：`activeSidePanelTab` 初始为空字符串 `""`（沿用 ui-store 现有初始值）。用户首次点击任何图标时，`activeSidePanelTab` 为空 → 命中"不是当前活跃面板"分支 → 一步完成：设 `activeSidePanelTab` 为该面板 id + `setRightPanelOpen(true)` 展开内容区。不需要点两次。`activeSidePanelTab` 为空且 `rightPanelOpen` 为 false 时，`RightPanelContent` 渲染一个空白占位（什么组件都不显示，或一句"点击右侧图标打开面板"的提示），因为没有任何组件是活跃的——但内容区此时已 collapse 到 0 宽度，用户看不到这个空态，只看到图标条。

### 2.4 keep-alive 策略

新的 `RightPanelContent` 不用 Radix Tabs 了，但 **keep-alive 语义必须保留**——当前 `forceMount` 保证了所有 sidePanel 组件同时挂载、切走不卸载。新设计沿用同一策略：

- `RightPanelContent` 内部渲染所有 sidePanel 组件，用 CSS `display` 控制可见性——活跃的 `display: flex`，非活跃的 `display: none`。
- 组件挂载顺序：`SidePanelStrip` 加载时拿到 `window.pi.slots.sidePanel()` 的列表，`RightPanelContent` 用 `getSidePanelComponent(name)` 查到所有已注册组件，全部渲染，按 `activeSidePanelTab` 切换 display。
- 不活跃的组件不卸载——它们的 `useEffect` 订阅（事件流、store）持续有效。这和当前 Radix Tabs `forceMount` + `data-[state=inactive]:hidden` 的效果完全一致。

### 2.5 影响范围

所有 sidePanel 插件（git-review、token-stats、context-files、run-panel、session-tree、新收藏插件）受布局变更影响——但只是视觉呈现方式变了（从横排 Tab 变竖排图标），**槽位契约和组件注册方式不变**。插件仍然在 `plugin.json` 的 `contributes.sidePanel` 声明 `{id, label, icon, component, order}`，仍然用 `registerSidePanelComponent` 注册组件。唯一变化是 `label` 从"Tab 上显示的文字"变为"图标的 tooltip 文字"（竖排图标条空间窄，不显示文字，hover 出 tooltip）。

竖排图标条用 `PluginIcon`（已有的图标映射组件）渲染 `item.icon`（lucide 图标名）。每个图标上方/下方可留 badge 位——收藏插件可以在图标上显示收藏数量。

## 3 收藏数据模型

### 3.1 收藏实体

一个收藏 = 一份会话文件副本 + 一份元数据。它不是引用（不指向原始会话文件），而是独立副本——原始会话删了，收藏还在。

副本是完整的 session JSONL 文件，不截断。理由：pi 的 `fork(entryId)` 需要会话树结构，截断会破坏树。完整副本保留了 fork 所需的全部上下文——fork 从 entryId 分叉时，entryId 之前的消息都是新分支的上下文，entryId 之后的消息在另一条分支上不影响。

元数据字段：

- `id`：收藏的唯一标识（UUID）
- `label`：用户起的名字（必填）
- `preview`：收藏节点处那条消息的纯文本前 30 个字符（从消息 content 提取，剥掉 Markdown 格式符号，超长截断加 …）。创建时自动提取，不可编辑。
- `createdAt`：收藏创建时间（ISO 8601 字符串）
- `cwd`：创建时的项目目录（fork 时需要这个 cwd 启动 pi）
- `entryId`：fork 锚点（pi 会话树中的节点 ID，即消息的 entryId）
- `originalSessionPath`：原始会话路径（仅供展示"来自哪个会话"，不用于读取——副本是独立的）

### 3.2 存储结构

收藏数据存在用户级 `~/.pi-desktop/plugins-data/` 下（框架插件数据区），按 cwd 分桶保持"书签跟随项目"语义，不写项目目录（不污染项目代码库）：

```
~/.pi-desktop/plugins-data/session-bookmarks/<cwd-bucket>/
  index.json          ← 收藏列表索引
  {bookmarkId}/
    session.jsonl     ← 会话文件完整副本
    meta.json         ← 单条收藏的完整元数据
```

`<cwd-bucket>` 是 cwd 经 pi 底座的桶名规则编码（`--{cwd去首斜杠、斜杠换横线}--`），与 `sessions.list` 用的桶一致。这样同一项目的收藏集中在一个桶下，切项目时换桶。

`index.json` 是列表查询的快查索引（避免遍历所有子目录读 meta）。每次增删改同步更新。`meta.json` 是单条收藏的完整元数据。`index.json` 的条目结构：

```typescript
// index.json: 顶层数组
[
  {
    "id": "uuid-string",
    "label": "用户起的名字",
    "preview": "消息内容前30字…",
    "createdAt": "2025-07-28T10:30:00.000Z",
    "cwd": "/Users/user/project",
    "entryId": "entry-abc123",
    "originalSessionPath": "~/.pi/agent/sessions/xxx/yyy.jsonl"
  }
]
```

`index.json` 的每条条目包含 `meta.json` 的全部字段——它是完整复制而非部分投影，这样列表查询只需读一个文件。`meta.json` 的字段与 `index.json` 单条完全一致，两份是冗余的但用途不同：`index.json` 供列表快查，`meta.json` 供单条详情读取（预留——当前元数据字段少，两份一致；未来 meta.json 加字段时 index.json 只投影列表展示需要的子集）。

收藏数据路径在 `configFile.get/set` 的路径白名单内（`~/.pi-desktop/` 前缀），无需声明额外权限即可经框架级 `configFile` 通道读写。

### 3.3 不可变性

收藏创建后，`session.jsonl` 和 `meta.json` 都不可变——除了 `label` 可以改（重命名）。使用收藏时（fork 流程），不直接操作 bookmark 目录里的文件，而是复制一份到 pi sessions 目录：

```
~/.pi/agent/sessions/{cwdBucket}/{newSessionId}.jsonl
```

新会话的 `entryId` 与 bookmark 副本中的 `entryId` 一致（因为是完整文件复制），pi 启动后 `fork(entryId)` 在新文件上创建新分支。bookmark 原文件不被触碰。

### 3.4 一致性保障

`index.json` 和 `meta.json`/`session.jsonl` 之间的一致性靠两个手段保障：

**写入顺序**——先写目录内文件，最后更新 index.json：

- 创建：先 `copySession`（写 session.jsonl）→ 写 `meta.json` → 更新 `index.json`。如果前两步失败，index.json 没有这条记录，列表不显示，不产生孤儿。如果第三步失败，目录有完整文件但 index.json 没记录——下次列表加载时的校验会补上（见下）。
- 删除：先更新 `index.json`（移除条目）→ 再 `removePath`（删目录）。如果第一步失败，目录还在但 index.json 还有记录——列表校验发现目录还在，照常显示。如果第二步失败，index.json 已无记录但目录残留——下次 `removePath` 时先清理。
- 重命名：先更新 `meta.json` → 再更新 `index.json`。两步都经 `configFile.set`。

**列表加载校验**——每次加载列表时做一次轻量校验：

- 遍历 `index.json` 的每条记录，检查 `{bookmarkId}/session.jsonl` 是否存在（用 `fs.listDir` 列收藏目录，检查 `{bookmarkId}` 是否在返回的条目列表里）。不在则标记为"失效"（灰色显示，不可 fork，只能删除）。
- 扫描收藏目录下的子目录（同样用 `fs.listDir`），如果有 `meta.json`（用 `configFile.get` 尝试读取该子目录的 `meta.json`，成功即有）但 `index.json` 没有对应记录的，补进 `index.json`（自愈孤儿）。

`fs.listDir` 接受任意目录路径参数。bookmark 插件声明了 `fs:project` 权限，可以用 `window.pi.fs.listDir(pluginId, bookmarkDir)` 枚举收藏目录下的子目录（`bookmarkDir` 是 `~/.pi-desktop/plugins-data/session-bookmarks/<cwd-bucket>/`）。`fs.listDir` 返回 `{name, isDir}[]`，`isDir=true` 的条目就是各 bookmark 子目录。校验逻辑是纯插件侧代码，不需要新的内核 API——`fs.listDir` + `configFile.get` 足够完成枚举 + 读 meta + 补 index 的自愈流程。

这样即使中间步骤失败，下次加载列表时自动修复。多窗口并发写的竞态（后写覆盖先写）短期可接受——收藏操作低频，且校验机制兜底。

## 4 内核 API 扩展

收藏需要两个当前内核不提供的文件操作。这两个操作是通用机制（文件复制和文件删除），不是收藏特有逻辑——内核已有 `openSession`（读会话文件）、`renameSession`（重命名会话文件）、`updateHeader`（改写会话文件头行），`copySession` 和 `removePath` 是同一层抽象的自然补全。

### 4.1 sessions.copySession

```typescript
// domain/sessions.ts — SessionsApi 新增方法
/** 复制会话文件(单个 JSONL 文件)到目标路径。用于创建会话快照。 */
copySession(srcPath: string, targetPath: string): Promise<void>;
```

- `srcPath`：源会话文件路径（支持 `~/` 展开），指向一个 `.jsonl` 文件
- `targetPath`：目标文件路径（支持 `~/` 展开，指向一个 `.jsonl` 文件，不是目录；父目录不存在时自动创建）
- `copySession` 复制的是单个文件，不是目录。bookmark 目录下的 `meta.json` 由插件用 `configFile.set` 单独写，不经 `copySession`
- 实现在 `application/sessions/session-scanner.ts`（已有 `readSession`/`renameSession`/`updateSessionHeader`，文件操作在同一处）
- IPC 通道：`session:copySession`，在 `electron-main/index.ts` 注册
- 不需要声明权限——核心默认能力（与 `openSession`/`renameSession` 同级）
- 实现用 Node `fs.copyFile`（在 main 进程的 IPC handler 里执行，renderer 侧是异步 `Promise<void>`——IPC 本身是异步的，但 main 进程内部的 `fs.copyFile` 是同步阻塞的）。大会话文件（几百 MB）会阻塞 main 进程几秒，短期可接受；长期改为 `fs.createReadStream + createWriteStream` 流式复制 + 进度上报。
- `srcPath` 和 `targetPath` 在 main 进程展开 `~/` 前缀后直接复制，不经 `configFile` 路径白名单（`configFile` 白名单只管 `config-file:get/set` 通道）。`copySession` 的路径安全性靠它是核心默认能力（不经 renderer 可控的 `pluginId` 参数）+ main 进程内部展开 `~/` 来保障。

### 4.2 fs.removePath

```typescript
// domain/sessions.ts — FsReadApi 扩展为 FsApi(读写合一)
/** 删除文件或目录(递归)。需声明 fs:project 权限。 */
removePath(path: string): Promise<void>;
```

- 权限门控：声明 `fs:project` 的插件才能调用。当前已有 `fs:project` 权限用于 `listDir`（只读目录列表），`removePath` 是同一权限下的写操作。不新增 `fs:project:write` 之类的子权限——`fs:project` 表示"可访问项目文件系统"，读和写都在这个权限下。权限校验仍在 main IPC 边界用 `assertPermission(pluginId, "fs:project")`。
- 实现在 `electron-main/index.ts` 的 IPC handler
- `path` 支持 `~/` 展开
- 删除目录时递归删除（`rmSync(recursive: true, force: true)`）

### 4.3 不进内核的

收藏的元数据管理（CRUD index.json、label 编辑、preview 提取）是插件内容，不进内核。插件用已有的 `configFile.get/set`（通用 JSON 读写）操作 `index.json` 和 `meta.json`，用 `sessions.copySession` 创建副本，用 `fs.removePath` 删除收藏目录。内核只提供文件原语，不知道"收藏"这个概念。

`configFile.get/set` 在 main IPC 边界有路径白名单门控——只允许 `~/.pi-desktop/`（桌面配置区）和 `~/.pi/agent/`（底座配置区）前缀，越界抛错。收藏数据存在 `~/.pi-desktop/plugins-data/session-bookmarks/<cwd-bucket>/` 下，在白名单内，可正常读写。

## 5 收藏创建

### 5.1 时间线右键入口

在 `message-list.tsx`（shell 层）的每条消息上添加 `onContextMenu`，弹出右键菜单。菜单项包含"收藏此节点"。

当前消息列表用 `react-virtuoso` 虚拟滚动，每条消息渲染时已有 `id`（对应 entryId）。右键菜单的"收藏此节点"需要拿到：当前会话路径（`useUiStore.currentSessionPath`）、消息的 entryId（`message.id`）、消息预览（`textOf(message.content)` 前 30 字）。

shell 不直接处理收藏逻辑——它通过共享状态发一个请求，bookmark 插件监听并处理。在 `ui-store`（`packages/react/src/ui-store.ts`，zustand store，所有插件和 shell 共用）中加一个请求字段：

```typescript
// ui-store.ts 新增
bookmarkRequest: { requestId: string; sessionPath: string; entryId: string; preview: string } | null;
requestBookmark: (req: Omit<BookmarkRequest, "requestId">) => void;
clearBookmarkRequest: () => void;
```

`requestBookmark` 生成唯一 `requestId`（`crypto.randomUUID()`）后写入 `bookmarkRequest`。`clearBookmarkRequest` 把 `bookmarkRequest` 置为 `null`。

shell 的右键菜单调 `useUiStore.getState().requestBookmark(...)`（zustand 的 `getState()` 在 React 组件外的事件回调里用，拿到最新 state 和 action）。bookmark 插件在组件内 `useEffect` 订阅 `bookmarkRequest`：

```typescript
// bookmark 插件内
const bookmarkRequest = useUiStore((s) => s.bookmarkRequest);
const clearBookmarkRequest = useUiStore((s) => s.clearBookmarkRequest);
useEffect(() => {
  if (!bookmarkRequest) return;
  // 弹出 label 输入对话框,用 AbortController 管理生命周期
  const abortController = new AbortController();
  showLabelDialog(bookmarkRequest, { signal: abortController.signal })
    .then((label) => {
      if (label) createBookmark({ ...bookmarkRequest, label });
      clearBookmarkRequest();  // 消费后立即清理,防止重复处理
    })
    .catch(() => {
      // 对话框被 abort(新请求来或组件卸载)或用户取消 → 清理请求
      clearBookmarkRequest();
    });
  return () => {
    // useEffect cleanup:新请求来(依赖变)或组件卸载时,abort 旧对话框
    abortController.abort();
  };
}, [bookmarkRequest, clearBookmarkRequest]);
```

**对话框生命周期管理**——`showLabelDialog` 接受一个 `AbortSignal`，被 abort 时自动关闭对话框、reject Promise。`useEffect` 的 cleanup 函数在新请求到来（`bookmarkRequest` 变化导致 effect 重新执行）或组件卸载时调 `abortController.abort()`，确保：

- 旧对话框在弹新对话框之前被关闭——不会出现两个对话框叠着。
- 用户关闭对话框（点取消/点外面/按 Esc）时 `showLabelDialog` reject，走 `.catch` 清理 `bookmarkRequest`——不会出现 promise 悬挂、请求残留。
- 组件卸载时对话框被关闭——不会出现"插件面板没挂载但对话框还在"的孤儿对话框。

**去重机制**：`requestId` 保证每次请求唯一。如果用户快速点两次"收藏此节点"，第二次请求覆盖 `bookmarkRequest` 为新的 `requestId`，`useEffect` 依赖变化触发 cleanup（abort 旧对话框）→ 重新执行（弹新对话框）。最终只创建一个收藏。如果 bookmark 插件未加载（不可能——见 §2.4 keep-alive，所有 sidePanel 组件始终挂载），`bookmarkRequest` 会留在 store 里等首次消费。

### 5.2 会话树节点按钮入口

session-tree 插件用 `react-complex-tree` 渲染树。在每个树节点上添加一个 bookmark 图标按钮（hover 时显示）。点击时同样调 `useUiStore.getState().requestBookmark(...)`，传入 `currentSessionPath` + `node.entryId` + 节点 label 作为 preview。

session-tree 插件需要从 `@pi-desktop/react` 导入 `useUiStore`——这是跨插件的间接通信，走共享 store，不直接调 bookmark 插件的接口。`useUiStore` 在 `packages/react`，所有插件都能导入。

### 5.3 面板内手动添加

bookmark 插件面板顶部有"+"按钮，点开后展示一个表单：
- sessionPath：文本输入（支持从当前会话自动填充）
- entryId：文本输入（或从消息列表选择）
- label：文本输入（必填）
- preview：自动从 session 文件中读取该 entryId 对应的消息内容前 30 字

用户填完提交后执行创建流程（§5.4）。面板内手动添加不走 `bookmarkRequest`——它直接调 §5.4 的创建流程函数（插件内部的 `createBookmark` 函数，封装了步骤 1-5），因为没有跨插件通信的需求。`bookmarkRequest` 的处理路径和面板内手动添加最终都汇到同一个 `createBookmark` 函数。

### 5.4 创建流程

1. 生成 `bookmarkId`（`crypto.randomUUID()`）
2. 目标目录：`~/.pi-desktop/plugins-data/session-bookmarks/<cwd-bucket>/{bookmarkId}/`
3. 调 `window.pi.sessions.copySession(sessionPath, targetDir + "/session.jsonl")` 复制会话文件
4. 写 `meta.json`（经 `window.pi.configFile.set`），包含全部元数据字段
5. 更新 `index.json`（先 `configFile.get` 读现有列表，push 新条目，`configFile.set` 写回）——写入顺序见 §3.4

如果 `sessionPath` 为 null（新会话，还没有文件），创建按钮禁用——没有会话文件就无法创建快照。

## 6 收藏使用（fork 流程）

### 6.1 流程

用户点击收藏列表中的一个收藏项，执行以下步骤：

1. 读 `meta.json` 拿到 `cwd`、`entryId`、`session.jsonl` 路径
2. 生成新会话 ID（`crypto.randomUUID()`）
3. 计算新会话路径：`~/.pi/agent/sessions/{cwdBucket}/{newSessionId}.jsonl`
4. 调 `window.pi.sessions.copySession(bookmarkSessionPath, newSessionPath)` 复制副本到 sessions 目录
5. 调 `window.pi.sessions.setContext(cwd, newSessionPath)` 设置发送上下文
6. 调 `window.pi.sessions.start(cwd, newSessionPath)` 启动 pi 进程（加载新会话文件）
7. 调 `window.pi.sessions.fork(entryId)` 从 entryId 分叉
8. pi 在新分支上等待用户输入——用户开始对话

**步骤 3 的 `cwdBucket`**：这是 pi 底座把会话文件按项目目录分桶存储的目录名——`cwd` 的哈希值。插件不自己算哈希——`sessions.list(cwd)` 返回的 `SessionInfo.path` 里已包含完整的 session 文件路径（含桶名）。fork 时用 `meta.json` 里的 `cwd`（收藏创建时的项目目录），而不是用户当前的 `useUiStore.currentCwd`——因为收藏的会话文件属于创建时那个项目，fork 出的新会话也应该在那个项目的桶下。如果用户当前在不同项目，`start(cwd, newSessionPath)` 的 `cwd` 参数（来自 `meta.json`）会让 pi 切到正确的项目目录。

**步骤 6 的 `start` 与已有会话**：`sessions.start(cwd, sessionPath)` 的行为是"绑当前会话，绑错停旧起新"（CLAUDE.md §8.1 的 `ensureForSend` 模型）——如果已有 pi 进程在跑另一个会话，`start` 会先 stop 旧进程再 spawn 新进程。fork 流程依赖这个行为：用户点击收藏项时，当前会话（如果有）的 pi 进程会被停掉，新进程加载 bookmark 副本。用户不需要手动停旧会话。

**步骤 7 的 fork 语义**：pi 加载副本文件后，会话树和原始会话一致。`fork(entryId)` 在副本文件上以 entryId 为分叉点创建新分支，pi 自动切到新分支。entryId 之前的消息是新分支的上下文，entryId 之后的消息在另一条分支上不影响。fork 完成后，session-store 收到 `session:snapshot` 推送，timeline 自动切换到新会话的新分支。

步骤 4-7 是异步的，需要 loading 态。UI 在收藏项上显示 spinner，fork 完成后（`session:snapshot` 到达）自动消失。如果某步失败，显示错误提示和重试按钮——副本文件是临时的，pi 下次启动不会自动加载它，重试只需重新点击收藏项。

### 6.2 不可变性保障

每次使用收藏都执行步骤 4 的复制——bookmark 目录里的 `session.jsonl` 永远不被 pi 进程直接加载。pi 加载的是 sessions 目录里的副本。用户在新会话里的对话追加到副本文件，bookmark 原文件不动。

同一个收藏可以被多次使用——每次使用都复制一份新副本，fork 出独立的新分支。收藏像一个"对话模板"：从同一个点出发，可以 fork 出多条独立的对话线。

## 7 收藏管理（CRUD）

### 7.1 列表展示

面板内列表展示当前项目下的所有收藏。每项显示：

- **label**（用户起的名字，加粗）
- **preview**（消息内容前 30 字，灰色小字，截断加 …）
- **createdAt**（收藏时间，格式化为相对时间如"2 小时前"，经 i18n 翻译）

列表按 `createdAt` 倒序——最新收藏在最上面。

列表顶部有搜索框，实时按 `label` 和 `preview` 过滤。

### 7.2 编辑（重命名）

每项右侧 hover 出编辑按钮（pencil icon）。点击后 label 变为 inline input，用户改完按 Enter 或点确认。

重命名流程：更新 `meta.json` 的 `label` 字段 + 更新 `index.json` 对应条目。两步都经 `configFile.set`，写入顺序见 §3.4。

### 7.3 删除

每项右侧 hover 出删除按钮（trash icon）。点击后弹确认对话框（"确定删除收藏 '{label}'？此操作不可撤销。"）。确认后：

1. 更新 `index.json`（移除对应条目）——写入顺序见 §3.4（先更新 index.json，再删目录）
2. 调 `window.pi.fs.removePath("~/.pi-desktop/plugins-data/session-bookmarks/<cwd-bucket>/{bookmarkId}/")` 删除收藏目录
3. 刷新列表

### 7.4 搜索

搜索框在列表顶部，输入即时过滤。匹配规则：`label` 和 `preview` 的子串匹配（不区分大小写）。空搜索框时显示全部。搜索是客户端过滤——列表数据已全量加载到内存，不需走 IPC。

## 8 插件架构

### 8.1 plugin.json

```json
{
  "id": "session-bookmarks",
  "version": "0.1.0",
  "displayName": "会话收藏",
  "renderer": "./renderer/index.tsx",
  "permissions": ["fs:project"],
  "contributes": {
    "sidePanel": [
      {
        "id": "bookmarks",
        "label": "收藏",
        "icon": "bookmark",
        "component": "BookmarksTab",
        "order": 5
      }
    ]
  }
}
```

- `permissions: ["fs:project"]`——需要 `fs.removePath` 删除收藏目录
- `icon: "bookmark"`——lucide 的 bookmark 图标
- `order: 5`——排在靠前位置（session-tree 是 40，git-review 是 10）

### 8.2 组件注册与接入点

renderer 入口 `renderer/index.tsx`：

```typescript
import { registerSidePanelComponent } from "@pi-desktop/react";

registerSidePanelComponent("BookmarksTab", BookmarksTab);
```

`registerSidePanelComponent` 是 `@pi-desktop/react` 提供的注册函数，插件 renderer 入口在模块加载时调用一次（`import.meta.glob({ eager: true })` 同步加载，见 `plugins-host.ts`）。组件名 `"BookmarksTab"` 对齐 `plugin.json` 里的 `contributes.sidePanel[].component`。重复注册同名组件会覆盖——但内置插件只注册一次，不会重复。

`BookmarksTab` 是面板主组件，内部管理：列表加载、搜索、CRUD、fork 流程。数据全部经 `usePluginContext("session-bookmarks")` 调内核 API，不直接 import `domain/`、`gateway/`、`application/`、`shell/` 的任何文件。

### 8.3 与内核 API 的交互

| 操作 | API | 权限 | 路径白名单 |
|------|-----|------|-----------|
| 复制会话文件（创建收藏 + fork） | `window.pi.sessions.copySession(src, dst)` | 核心默认 | `~/` 展开，不经 configFile 白名单 |
| 读收藏列表 | `window.pi.configFile.get(path)` | 核心默认 | 路径限 `~/.pi-desktop/` 或 `~/.pi/agent/` 前缀 |
| 写收藏元数据 | `window.pi.configFile.set(path, data, "replace")` | 核心默认 | 路径限 `~/.pi-desktop/` 或 `~/.pi/agent/` 前缀 |
| 删除收藏目录 | `window.pi.fs.removePath(path)` | `fs:project` | `~/` 展开 |
| 启动 pi | `window.pi.sessions.start(cwd, path)` | 核心默认 | — |
| 设置上下文 | `window.pi.sessions.setContext(cwd, path)` | 核心默认 | — |
| fork 分叉 | `window.pi.sessions.fork(entryId)` | 核心默认 | — |
| 读当前会话路径 | `useUiStore.currentSessionPath` | — | — |
| 读当前 cwd | `useUiStore.currentCwd` | — | — |
| 接收创建请求 | `useUiStore.bookmarkRequest` | — | — |

### 8.4 与其他插件的间接通信

session-tree 插件的节点按钮触发收藏创建时，不直接调 session-bookmarks 插件——它调 `useUiStore.getState().requestBookmark()`（zustand 的 `getState()` 在 React 组件外的事件回调里用），session-bookmarks 插件 `useUiStore((s) => s.bookmarkRequest)` 订阅并处理。这是通过共享状态间接通信，符合"插件之间不直接通信"的架构纪律。

message-list.tsx（shell 层）的右键菜单同理——shell 调 `useUiStore.getState().requestBookmark()`，bookmark 插件响应。shell 不是插件，但共享 store 是 shell 和插件之间的正常通信通道。

## 9 QA

**Q：收藏的会话文件很大（几百 MB），复制会不会卡？**

会。`sessions.copySession` 在 main 进程用 `fs.copyFile`（Node 原生同步 I/O），IPC 接口是 `Promise<void>`（异步），但 main 进程内部的文件复制是同步阻塞的——大会话文件会阻塞 main 进程几秒，期间所有 IPC 调用排队。短期可接受（收藏操作低频、用户有心理预期）。长期改为 `fs.createReadStream + createWriteStream` 流式复制 + 进度上报，但当前不提前优化。

**Q：entryId 在 bookmark 副本里不存在了怎么办？**

不会发生。bookmark 副本是从原始会话文件完整复制的，entryId 存在于原始文件就一定存在于副本。唯一的风险是原始会话文件在收藏创建后被 pi 改写了（新消息追加），但副本是创建那一刻的快照，不受后续修改影响。

**Q：用户在项目 A 收藏了节点，切到项目 B 后看得到吗？**

看不到。收藏存在 `~/.pi-desktop/plugins-data/session-bookmarks/<cwd-bucket>/` 下，按 cwd 分桶。切项目时 `useUiStore.currentCwd` 变了，bookmark 插件 `useEffect` 依赖 `currentCwd` 重新加载新项目桶的收藏列表。这是设计意图——收藏是项目级的上下文，跨项目没有意义。

**Q：点击收藏项时用户当前在项目 B，收藏属于项目 A，会发生什么？**

fork 流程用 `meta.json` 里的 `cwd`（项目 A），不用 `useUiStore.currentCwd`（项目 B）。`start(cwd, newSessionPath)` 的 `cwd` 参数会让 pi 切到项目 A 的目录，新会话文件存在项目 A 的桶下。这会触发项目切换——`useUiStore.currentCwd` 变为项目 A，左栏会话列表刷新。如果用户不想切项目，不应该点别的项目的收藏——但当前设计收藏列表只显示当前项目的收藏（见上一条），所以这个场景不会发生。未来如果加跨项目收藏搜索，需要再考虑。

**Q：同一个节点被收藏了两次怎么办？**

允许。每次收藏生成新的 `bookmarkId`，存为独立目录。列表里会出现两条同 label 的收藏（preview 和 createdAt 可能不同）。不做去重——用户可能想给同一个节点起不同的 label 做不同用途。

**Q：bookmark 目录被用户手动删了怎么办？**

`index.json` 里有记录但目录不存在。列表加载时对每个 `bookmarkId` 检查 `session.jsonl` 是否存在，不存在则标记为"失效"（灰色显示，不可 fork，只能删除）。删除时只清 `index.json` 条目（目录已经没了）。如果反过来——目录在但 `index.json` 没记录（创建时第三步失败），列表加载校验会扫描到孤儿目录并补进 `index.json`（见 §3.4 自愈机制）。收藏目录在 `~/.pi-desktop/plugins-data/` 下，用户一般不会手动碰；但如果手动删了，自愈机制兜底。

**Q：fork 流程中途失败了（比如 pi 启动失败）怎么办？**

步骤 4（复制副本）和步骤 6（启动 pi）之间失败，新会话文件已存在于 sessions 目录但 pi 没启动。这不影响 bookmark——副本文件是临时的，pi 下次启动不会自动加载它。用户重新点击收藏项即可重试。UI 在 loading 态加错误提示和重试按钮。

**Q：多个窗口同时操作同一项目的收藏会冲突吗？**

`index.json` 的读写不是原子的——窗口 A 读、窗口 B 读、窗口 A 写、窗口 B 写，后写的覆盖先写的。短期可接受（收藏操作低频）。`configFile.set` 底层已有 `withDirLock`（proper-lockfile），但 `configFile.get` + 业务逻辑 + `configFile.set` 这个 read-modify-write 序列不是原子的。长期需要 `configFile` 支持 read-modify-write 原语（传入 updater 函数，在锁内完成读改写），但当前不提前处理。§3.4 的列表加载校验是兜底——即使并发写丢了某条记录，下次加载时孤儿目录会被自愈补回。收藏数据在 `~/.pi-desktop/plugins-data/` 下，同一用户的多窗口共享同一份数据。

**Q：sidePanel 竖排图标条在小屏幕上放不下怎么办？**

图标条宽度固定 48px，不参与 resize。小屏幕上 MessageList 的可用宽度减少 48px。如果 MessageList 已经很窄，图标条仍然可见——这是设计意图（IDE 类编辑器都这么做）。极端小屏幕可以考虑自动隐藏图标条，但当前不做。

**Q：右键菜单和会话树按钮同时触发收藏会冲突吗？**

不会。两者都调 `useUiStore.getState().requestBookmark()`，`requestBookmark` 每次生成唯一 `requestId`。如果两个入口几乎同时触发，第二个请求覆盖 `bookmarkRequest`，bookmark 插件的 `useEffect` 重新触发，关闭旧对话框、弹新对话框——最终只创建一个收藏。见 §5.1 去重机制。
