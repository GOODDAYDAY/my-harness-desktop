# 会话节点收藏（session-bookmarks）

## 0 这个插件解决什么问题

pi 的会话有分支结构——用户可以从某条消息 `fork` 出新分支继续对话。但 fork 是即时的、跟着原会话走的：原会话删了，分支也没了；用户想"保存某个有价值的对话节点，日后从那个点重新开始"做不到。

session-bookmarks 解决的是**节点的持久化收藏**。用户在对话中遇到一个有价值的节点（某条消息对应的 entryId），把它收藏起来。收藏是一个 snapshot——保存那一刻的会话状态，跟原始会话完全隔离。原始会话删了、改了，收藏不受影响。点击收藏项，直接从那个节点 fork 出新分支，开始新的对话。

收藏跟着项目走——每个项目目录（cwd）有自己的收藏集，切项目切收藏。

> **stale 标注（2026-08-03）**：本文 §3 的存储模型描述（`index.json`/`meta.json`/用户级分桶目录）是旧实现。当前实现：元数据走统一配置通道（`<cwd>/.pi-desktop/config/session-bookmarks.json` 的 `bookmarks` key，项目级、跟随项目），会话副本住项目级数据目录（`<cwd>/.pi-desktop/session-bookmarks/<id>.jsonl`）；旧全局桶由一次性懒迁移搬回（哨兵 `legacyMigrated` 防重复迁移）。§3.3 的 fork 流程已按 `forkFromSession` 原子用例更新，其余小节待重写。

## 1 整体架构

两个交付物，一个在壳层、一个在插件层：

- **(A) sidePanel 外壳改版**——当前右面板是横排 Tab（Radix Tabs，图标+文字水平排列在顶部）。改为竖排图标条：最右侧一条窄竖排图标（~48px 宽）常驻不消失，点击图标展开对应面板内容到图标条左侧，再点同一图标收起内容区但图标条仍在。这是 shell 层 `right-panel.tsx` 的机制变更，影响所有 sidePanel 插件的布局呈现，但不改槽位契约——插件仍然贡献 `{id, label, icon, component}`，外壳换一种方式渲染它们。

- **(B) session-bookmarks 插件**——贡献一个 sidePanel 槽位，图标是一个书签。面板内是收藏列表，支持增删改查和搜索。收藏创建有多个入口：时间线消息右键、会话树节点按钮、面板内手动添加。点击收藏项触发 `forkFromSession` 原子用例：框架复制 snapshot 到中间路径 → 启动 pi → fork 从 entryId 分叉 → 对账并清理中间副本（详见 §3.3）。

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

所有 sidePanel 插件（git-review、token-stats、context-files、run-panel、session-tree、新收藏插件）受布局变更影响——但只是视觉呈现方式变了（从横排 Tab 变竖排图标），**槽位契约和组件注册方式不变**。插件仍然在 `plugin.json` 的 `contributes.sidePanel` 声明 `{id, label, icon, component, order}`，组件由框架从 manifest 的 `component` 名自动匹配 module exports 注册。唯一变化是 `label` 从"Tab 上显示的文字"变为"图标的 tooltip 文字"（竖排图标条空间窄，不显示文字，hover 出 tooltip）。

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

收藏创建后，副本 jsonl 不可变——除了 `label` 可以改（重命名）。使用收藏时（fork 流程），不直接操作 bookmark 目录里的文件，而是走框架的原子用例：

```ts
await ctx.tree.forkFromSession(bm.cwd, bookmarkFile, bm.entryId);
```

`forkFromSession` 的契约语义是**开一个新会话 + 预制内容**：框架把 bookmark 副本复制到 pi sessions 桶的中间路径（`generateNewSessionPath` 生成——当前时间戳命名、agentDir 由注入决定，插件不碰 `~/.pi/agent` 布局）→ 启动 pi → `fork(entryId)` 在新文件上分叉。fork 产物由底座写全新 header——**header 时间是 fork 当下，不是收藏那一刻**；预制内容（entryId 分支链）保持历史时间戳，那是历史事实不改写。fork 完成后框架自动对账（sync 拉新基线、激活路径切到 fork 产物、推 sessionStart 水合 renderer）并删除中间副本；任何失败路径都回滚上下文并清理，会话桶里不留"当年时间"的幽灵会话。bookmark 原文件全程不被触碰。

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
- 实现在 `application/sessions/session-scanner.ts`（与 `copySession` 同处，文件操作收拢），`electron-main/index.ts` 的 IPC handler 只做权限断言和 `~/` 展开后调用
- `path` 支持 `~/` 展开
- 删除目录时递归删除（`rmSync(recursive: true, force: true)`）

### 4.3 不进内核的

收藏的元数据管理（CRUD index.json、label 编辑、preview 提取）是插件内容，不进内核。插件用已有的 `configFile.get/set`（通用 JSON 读写）操作 `index.json` 和 `meta.json`，用 `sessions.copySession` 创建副本，用 `fs.removePath` 删除收藏目录。内核只提供文件原语，不知道"收藏"这个概念。

`configFile.get/set` 在 main IPC 边界有路径白名单门控——只允许 `~/.pi-desktop/`（桌面配置区）和 `~/.pi/agent/`（底座配置区）前缀，越界抛错。收藏数据存在 `~/.pi-desktop/plugins-data/session-bookmarks/<cwd-bucket>/` 下，在白名单内，可正常读写。

## 5 收藏创建

### 5.1 时间线右键入口

timeline 插件（`mainView` 槽）的每条消息上有右键菜单，菜单项包含"收藏此节点"。点击时 timeline 经事件总线发一个收藏请求——**已落地为事件方案**，不再是早期的 ui-store 共享字段方案（演进记录见 `docs/design/plugin-isolation-principles.md`）：

```typescript
// timeline 插件(renderer/index.tsx)
export const channels = ["timeline:bookmarkRequested", ...] as const;

// 右键菜单点击时:
ctx.events.emit("timeline:bookmarkRequested", { sessionPath, entryId, preview });
```

payload 三个字段：当前会话路径（`useUiStore.currentSessionPath`）、消息的 entryId（`message.id`）、消息预览（`textOf(message.content)` 折叠空白后前 30 字，空则 `"(empty)"`）。channel 名是 timeline 的对外契约，payload 形状由发布方定义。

**右键只对 user 消息放行**——底座 RPC fork 只接受 user 消息锚点（`position:"before"` 校验 role），assistant/divider 消息右键不发 `bookmarkRequested`。在入口挡住，不产生 fork 必失败的收藏（旧版不挑 role，产生的存量 assistant 锚点由 fork 流程的前置校验兜底，见 §6.1 步骤 2）。

session-bookmarks 在 manifest 声明 `dependsOn`（含 `timeline`，拓扑排序保证 timeline 先加载、channel 先注册），组件内订阅：

```typescript
useEffect(() => {
  const handler = (payload: unknown) => {
    setDialogState({ req: payload as BookmarkRequest, label: "" });
  };
  const off1 = ctx.events.on("timeline:bookmarkRequested", handler);
  const off2 = ctx.events.on("session-tree:bookmarkRequested", handler);
  return () => { off1(); off2(); };
}, [ctx.events]);
```

handler 直接把请求写进本地 `dialogState`，弹出内联 label 输入对话框。确认 → `createBookmark`；取消 → 清空 `dialogState`。

**不用 `replayLast`**——`bookmarkRequested` 是命令型事件（一次性请求），不是状态。`replayLast` 会把最近一次 emit 回放给每个新订阅者：插件重订阅（热重载、`ctx.events` 引用变化）时已消费过的旧请求会幽灵重现、重复弹对话框，且总线里的 lastPayload 无法被消费方清除。`replayLast` 适合 `system:settingsChanged` 这类"最新值即真相"的状态事件，不适合这里。订阅必就绪由 keep-alive 保证（§2.4：所有 sidePanel 组件始终挂载），不需要回放兜底。

**并发请求**：两次快速触发时，后到的 emit 直接覆盖 `dialogState`——旧对话框被新请求顶替，最终只创建一个收藏。不需要 requestId 去重。

### 5.2 会话树节点按钮入口

session-tree 插件用 `react-complex-tree` 渲染树。**user 节点**上有 bookmark 图标按钮（hover 时显示；与 fork 按钮同守底座的 user 锚点约束，非 user 节点不渲染这两个按钮），点击时经自己的 channel 发同一个形状的请求：

```typescript
// session-tree 插件(renderer/index.tsx)
export const channels = ["session-tree:bookmarkRequested"] as const;

ctx.events.emit("session-tree:bookmarkRequested", { sessionPath, entryId, preview });
```

session-bookmarks 的 manifest `dependsOn` 同时声明 `session-tree`，在同一个 `useEffect` 里订阅两条 channel、共用同一个 handler（§5.1 的代码块）——两个入口汇到同一个对话框、同一个 `createBookmark`。跨插件通信只走事件，不直接调对方接口，符合"插件之间不直接通信"的架构纪律。

### 5.3 面板内手动添加

bookmark 插件面板顶部有"+"按钮，点开后展示一个表单：
- sessionPath：文本输入（从当前会话自动填充）
- entryId：文本输入
- label：文本输入（必填）

提交时**先校验再创建**：调 `ctx.sessions.openSession(sessionPath)` 读会话文件——文件不存在/损坏报错；在 `messages` 里按 `id === entryId` 找消息——找不到报"该 entryId 不存在于此会话"；消息 role 不是 user 报"收藏的锚点不是用户消息,无法 fork"（与 fork 流程同一约束，见 §6.1 步骤 2）。校验通过后从该消息的 content 提取 preview（纯文本折叠空白后前 30 字，空则 `"(empty)"`）。错误就地显示在表单里，不产生坏收藏。

面板内手动添加不走事件总线——它直接调 §5.4 的创建流程函数（插件内部的 `createBookmark`），因为没有跨插件通信的需求。事件入口和手动入口最终都汇到同一个 `createBookmark` 函数。

### 5.4 创建流程

1. 生成 `bookmarkId`（`crypto.randomUUID()`）
2. 目标目录：`~/.pi-desktop/plugins-data/session-bookmarks/<cwd-bucket>/{bookmarkId}/`
3. 调 `window.pi.sessions.copySession(sessionPath, targetDir + "/session.jsonl")` 复制会话文件
4. 写 `meta.json`（经 `window.pi.configFile.set`），包含全部元数据字段
5. 更新 `index.json`（先 `configFile.get` 读现有列表，push 新条目，`configFile.set` 写回）——写入顺序见 §3.4

如果 `sessionPath` 为 null（新会话，还没有文件），创建按钮禁用——没有会话文件就无法创建快照。

## 6 收藏使用（fork 流程）

### 6.1 流程

用户点击收藏列表中的一个收藏项，执行以下步骤（`forkFromBookmark`）：

1. **前置校验**（纯文件读，不启动 pi）：`openSession(副本)` 找 `entryId` 对应消息——文件不可读、entryId 不存在、或**消息 role 不是 user**，就地报错返回，不复制不启动。底座 RPC fork 只接受 user 消息锚点（`position:"before"` 校验 role），assistant 锚点必失败，在这一步挡住给可读错误（存量 assistant 锚点：旧版 timeline 右键不挑 role 时收藏的）
2. 调 `ctx.tree.forkFromSession(bm.cwd, 副本路径, bm.entryId)` 原子用例——中间路径生成、启动、fork、对账、清理全在框架内（语义与步骤详解见 §3.3）
3. fork 完成，pi 在新分支上等待用户输入——用户开始对话

**步骤 2 的框架行为**（`forkFromSession`，插件不感知但影响列表所见）：fork 成功后框架自动对账（sync 拿截断基线、激活路径切到 fork 产物、推 sessionStart 水合 renderer），随后删除中间副本并补播一次 sessionStart 触发列表重扫——删文件本身无内核事件，不补这一下，中间副本那行会残留成僵尸（点开文件已不在）。fork 被底座扩展取消时不发生切换，中间副本就是当前会话本体，保留不删。

**fork 之后点列表里的新会话**：fork 产物和跑它的 pi 进程是"路径 ≠ 进程 key"的关系（key 是中间路径，进程绑定的文件已是 fork 产物）。框架按路径找进程经 `resolveProcKey`（按 `boundSessionPath` 解析）——点 fork 产物能找到已活进程直接 sync，不会重复 spawn 第二个 pi 写同一文件。

**失败回滚**：步骤 1 失败（校验）什么都不产生；步骤 2 内部任何失败（复制失败、pi 启动失败、fork RPC 抛错）由框架回滚——恢复先前上下文、停掉跑在中间副本上的 pi、删中间副本，任何路径不留孤儿。面板顶部错误条显示错误消息 + 重试/关闭按钮，重试对同一个收藏重新执行完整流程，上一次残留已被回滚清掉。

**跨项目语义**：fork 用收藏元数据里的 `cwd`（收藏创建时的项目目录），不是用户当前的 `useUiStore.currentCwd`——收藏的会话文件属于创建时那个项目，fork 出的新会话也在那个项目的桶下。桶名规则（`--<cwd去首斜杠、斜杠换横线>--`）的唯一源是 `domain/sessions.ts` 的纯函数 `cwdToBucketName`（契约单源）。

步骤 1-2 是异步的，需要 loading 态。UI 在收藏项上显示 spinner（`forking` 状态），流程结束（成功或失败）自动消失。

### 6.2 不可变性保障

每次使用收藏，`forkFromSession` 都会新复制一份中间文件——bookmark 目录里的副本 jsonl 永远不被 pi 进程直接加载，fork 完成后中间文件即删（见 §3.3/§6.1）。用户在新会话里的对话追加到 fork 产物文件，bookmark 原文件不动。

同一个收藏可以被多次使用——每次使用都走一遍原子用例，fork 出独立的新分支。收藏像一个"对话模板"：从同一个点出发，可以 fork 出多条独立的对话线。

## 7 收藏管理（CRUD）

### 7.1 列表展示

面板内列表展示当前项目下的所有收藏。每项显示：

- **label**（用户起的名字，加粗）
- **preview**（消息内容前 30 字，灰色小字，截断加 …）
- **createdAt**（收藏时间，相对时间如"2 小时前"——分档阈值 + `Intl.RelativeTimeFormat` 本地化，随界面语言切换，零文案 key）

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
  "dependsOn": ["timeline", "session-tree"],
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

- `dependsOn: ["timeline", "session-tree"]`——订阅两者的 bookmarkRequested channel，拓扑排序保证发布方先加载、channel 先注册
- `permissions: ["fs:project"]`——需要 `fs.removePath` 删除收藏目录
- `icon: "bookmark"`——lucide 的 bookmark 图标
- `order: 5`——排在靠前位置（session-tree 是 40，git-review 是 10）

### 8.2 组件注册与接入点

renderer 入口 `renderer/index.tsx` 只 export 组件，**不调任何 register 函数**——框架加载 renderer module 后读 manifest 的 `contributes.sidePanel[].component` 字段，在 module 的 exports 里找同名组件自动注册（`import.meta.glob({ eager: true })` 同步加载，见 `plugins-host.ts`）。两层校验：TypeScript 编译器保证 export 的名字存在，框架加载时保证 manifest 的 component 名和 export 匹配。

`BookmarksTab` 是面板主组件，内部管理：列表加载、搜索、CRUD、fork 流程。数据全部经 `usePluginContext()` 调内核 API（pluginId 由 PluginIdContext 自动注入，不手写常量），不直接 import `domain/`、`gateway/`、`application/`、`shell/` 的任何文件；桶名规则等纯函数经 `@pi-desktop/core`（domain 的 re-export 发布面）引用。

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
| 接收创建请求 | `ctx.events.on("timeline:bookmarkRequested" / "session-tree:bookmarkRequested")` | — | — |
| 校验 entryId + 提取 preview（手动添加） | `ctx.sessions.openSession(path)` | 核心默认 | — |
| cwd 桶名计算 | `cwdToBucketName(cwd)`（`@pi-desktop/core` 纯函数） | — | — |

### 8.4 与其他插件的间接通信

session-tree 插件的节点按钮触发收藏创建时，不直接调 session-bookmarks 插件——它 `ctx.events.emit("session-tree:bookmarkRequested", payload)`，session-bookmarks 经 `ctx.events.on` 订阅处理。timeline 插件的右键菜单同理（`timeline:bookmarkRequested`）。这是事件总线通信，符合"插件之间唯一合法通信是 `ctx.events.emit/on`"的架构纪律：channel 名是发布方的对外契约，payload 形状由发布方定义，订阅方在 manifest 声明 `dependsOn` 保证加载顺序。

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

**Q：fork 流程中途失败了（比如 pi 启动失败、fork RPC 抛错）怎么办？**

框架自动回滚。`forkFromSession` 的 catch 里恢复先前上下文、停掉跑在中间副本上的 pi、删中间副本——任何失败路径都不留孤儿文件、不留泄漏进程。插件侧的前置校验（锚点必须是 user 消息）在更早一步失败，什么都不产生。面板顶部错误条显示错误消息和重试/关闭按钮，重试是干净的（上一次残留已被回滚清掉）。

**Q：多个窗口同时操作同一项目的收藏会冲突吗？**

`index.json` 的读写不是原子的——窗口 A 读、窗口 B 读、窗口 A 写、窗口 B 写，后写的覆盖先写的。短期可接受（收藏操作低频）。`configFile.set` 底层已有 `withDirLock`（proper-lockfile），但 `configFile.get` + 业务逻辑 + `configFile.set` 这个 read-modify-write 序列不是原子的。长期需要 `configFile` 支持 read-modify-write 原语（传入 updater 函数，在锁内完成读改写），但当前不提前处理。§3.4 的列表加载校验是兜底——即使并发写丢了某条记录，下次加载时孤儿目录会被自愈补回。收藏数据在 `~/.pi-desktop/plugins-data/` 下，同一用户的多窗口共享同一份数据。

**Q：sidePanel 竖排图标条在小屏幕上放不下怎么办？**

图标条宽度固定 48px，不参与 resize。小屏幕上 MessageList 的可用宽度减少 48px。如果 MessageList 已经很窄，图标条仍然可见——这是设计意图（IDE 类编辑器都这么做）。极端小屏幕可以考虑自动隐藏图标条，但当前不做。

**Q：右键菜单和会话树按钮同时触发收藏会冲突吗？**

不会。两个入口都 emit 到同一个 handler，后到的请求直接覆盖 `dialogState`——旧对话框被新请求顶替，最终只创建一个收藏。见 §5.1 并发请求。
