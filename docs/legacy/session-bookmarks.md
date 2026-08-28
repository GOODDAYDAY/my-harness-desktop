# 会话节点收藏（session-bookmarks）

## 0 这个插件解决什么问题

pi 的会话有分支结构——用户可以从某条消息 `fork` 出新分支继续对话。但 fork 是即时的、跟着原会话走的；用户想「保存某个有价值的对话节点，日后从那个点重新开始」做不到。

session-bookmarks 解决的是**节点的持久化收藏**。用户在对话中遇到一条有价值的 **assistant 回答**，把它收藏起来。收藏是一份 **snapshot**——保存那一刻的会话状态，跟原始会话完全隔离。原始会话删了、改了，收藏不受影响。点击收藏项，直接从那条回答之后 fork 出新分支会话，开始新的对话。

收藏跟着项目走——每个项目目录（cwd）有自己的收藏集，切项目切收藏。收藏的元数据与副本都住项目级目录（`<cwd>/.my-harness-desktop/` 下），git 可追踪、跟随项目搬移。

## 1 数据模型

一条收藏 = 一份元数据 + 一份会话快照副本。

### 1.1 元数据（BookmarkMeta）

走统一配置通道 `ctx.config` 的 `bookmarks` key，落盘 `<cwd>/.my-harness-desktop/config/session-bookmarks.json`（项目级、跟随项目）：

```ts
interface BookmarkMeta {
  id: string;                 // 收藏唯一标识（crypto.randomUUID()）
  label: string;              // 用户起的名字（timeline 一击收藏给默认 label）
  preview: string;            // 锚点消息纯文本前 30 字
  createdAt: string;          // 收藏时间 ISO 8601
  cwd: string;                // 创建时项目目录（历史存档，不再参与路径定位）
  entryId: string;            // fork 锚点（assistant 消息的 entryId）
  originalSessionPath: string;// 原始会话路径（展示用，副本独立）
  bookmarkPath?: string;      // 后端书签副本路径（anchor.opaque）。旧书签无此字段
  exists?: boolean;           // 运行时标记：副本文件是否仍在（非持久，加载时计算）
}
```

### 1.2 副本（snapshot）

副本是完整会话 JSONL 文件的逐字节拷贝，**不截断**（pi 的 fork 需要完整 parentId 树结构）。副本落在项目级数据目录：

```
<cwd>/.my-harness-desktop/session-bookmarks/<timestamp>_<uuid>.jsonl
```

- 新式收藏（走 `ctx.sessions.bookmark`）的文件名是 `时间戳_uuid`，`bookmarkPath` 字段记录这份副本的绝对路径（即 `anchor.opaque`）。
- 旧式收藏（历史迁移产物）的文件名是 `<id>.jsonl`（文件名 == 收藏 id），无 `bookmarkPath` 字段，读取时回退按 id 推导路径。

副本是 fork 的素材：点击收藏时，框架把副本复制到中间路径 → 起 pi → 在 `entryId` 处 fork → 切到产物 → 删中间副本。副本本身全程不被 pi 直接加载、不被修改。

## 2 存储路径

| 内容 | 路径 | 通道 |
|---|---|---|
| 元数据 | `<cwd>/.my-harness-desktop/config/session-bookmarks.json` | `ctx.config`（统一通道，项目级） |
| 排序 | 同文件 `bookmarkOrder` key | `ctx.config` |
| 副本 | `<cwd>/.my-harness-desktop/session-bookmarks/*.jsonl` | `ctx.sessions.bookmark`（写）/ `ctx.sessions.deleteBookmark`（删） |

> 历史上副本曾住过两个全局位置：`~/.my-harness-desktop/plugins-data/session-bookmarks/<cwd-hash>/`（最早期）和 `~/.pi/agent/bookmarks/`（base-interface 抽象期）。现统一回项目级目录；最早期全局桶由一次性懒迁移搬回（哨兵 `legacyMigrated` 防重复迁移），`~/.pi/agent/bookmarks/` 已废弃。

## 3 收藏创建

三个入口，都汇到同一个 `createBookmark`：

- **timeline 一击收藏**：assistant 消息 hover 的「收藏」按钮，`ctx.events.invoke("timeline:bookmarkRequested", { sessionPath, entryId, preview, label })`。label 默认取会话名（无则取 preview）。`invoke` 而非 `emit`：收藏 tab 未挂载时请求入队，面板揭示后挂载冲刷恰好一次投递（emit 对零订阅者会静默丢）。
- **session-tree 节点按钮**：assistant 节点的书签图标，`ctx.events.emit("session-tree:bookmarkRequested", { ... })`，原位输入 label。
- **面板内手动添加**：输入 sessionPath + entryId + label，提交前 `ctx.sessions.openSession(sessionPath)` 校验 entryId 存在且是 assistant 消息。

`createBookmark` 流程：

1. 生成 `id = crypto.randomUUID()`。
2. `const anchor = await ctx.sessions.bookmark(sessionPath, entryId)`——后端做全量拷贝到项目级数据目录，返回 anchor（`opaque` = 副本路径）。
3. 把 `{ ...meta, bookmarkPath: anchor.opaque }` push 进 `bookmarks`，`ctx.config.set` 落盘。
4. `loadBookmarks()` 刷新。

创建窗口防护：文件先落盘、元数据后写，中间孤儿对账可能看到「无主文件」。`pendingCreateRef` 同时登记 `id` 与 `basename(opaque)`，对账跳过创建中的文件，完成后撤销。

## 4 收藏使用（fork 流程）

`forkFromBookmark(bm)`：

1. 算 `opaque = bm.bookmarkPath ?? bookmarkSessionFile(bm.cwd, bm.id)`（新式走后端副本路径，旧式回退 id 推导）。
2. `await ctx.sessions.resume({ lineageId: bm.originalSessionPath, boundary: bm.entryId, opaque })`。
   - pi 内核：`resume` = `forkFromSession(cwd, opaque, boundary, "at")` 编排——复制副本到中间路径 → 起 pi → 在 boundary 处 fork → 对账切到产物 → 删中间副本；任何失败回滚、不留孤儿。**不需要预先有活 pi**。
   - dsh 内核：走 JSON-RPC resume（需活 dsh 进程）。
3. `ctx.events.invoke("timeline:scrollTo", { messageId: bm.entryId })` 定位锚点。
4. toast 提醒「已从收藏创建新会话」。

> fork 语义 = 「从这条 assistant 回答之后继续」：`position: "at"` 保留到锚点消息为止，新会话从其后开始。收藏的锚点必须是 assistant 消息（user 锚点 fork 必失败），入口已挡，前端 `openSession` 校验再兜一道。

## 5 收藏管理（CRUD）

- **列表**：显示 label（加粗）、preview（灰小字）、相对时间（`Intl.RelativeTimeFormat`，随 i18n 切换）。支持搜索（label + preview 子串），拖拽排序（`bookmarkOrder`）。
- **重命名**：铅笔按钮 → inline input，`config.set` 更新对应条目。
- **删除**（`deleteBookmark`）：
  1. 元数据过滤 + `config.set`——**必须成功**，失败弹提示直接返回（唯一对用户可见的失败）。
  2. 副本清理——best-effort：新式走 `ctx.sessions.deleteBookmark({ opaque })`（`removePath(opaque)`），旧式走 `ctx.fs.removePath(bookmarkSessionFile(cwd, id))`；失败只 warn，残留由对账兜底。
  3. `bookmarkOrder` 移除该 id（内存同步 + void 写回）。
  4. `loadBookmarks()` 刷新 UI（必执行）。

## 6 孤儿对账与 exists

`loadBookmarks` 每次加载时对项目级数据目录做一次对账：

- `files` = 目录里所有 `.jsonl` 文件名。
- 构造两个豁免集合：`metaIds`（旧式 `<id>.jsonl`）和 `opaqueNames`（新式 `basename(bookmarkPath)`）。
- 盘上有、两个集合里都没有、且非在途创建的文件 → 静默 `fs.removePath`（历史残留自愈）。
- `exists`：新式 = `files.has(basename(bookmarkPath))`，旧式 = `files.has(\`${id}.jsonl\`)`。`exists=false` 的收藏灰显（line-through）、不可 fork、只能删。

## 7 内核 API 交互

| 操作 | API | 说明 |
|---|---|---|
| 创建收藏（拷贝副本） | `ctx.sessions.bookmark(lineageId, boundary)` | pi 走纯文件复制到项目级目录，不需活进程；返回 `Anchor{ lineageId, boundary, opaque }` |
| fork 收藏 | `ctx.sessions.resume(anchor)` | pi = `forkFromSession` 编排（自己起进程）；dsh = JSON-RPC |
| 删副本 | `ctx.sessions.deleteBookmark(anchor)` | pi = `removePath(opaque)` |
| 校验锚点 | `ctx.sessions.openSession(path)` | 纯文件读，找 entryId + 校验 assistant |
| 读元数据 | `ctx.config.get/set` | 项目级统一通道 |
| 对账枚举/删 | `ctx.fs.listDir` / `ctx.fs.removePath` | `fs:project` 权限 |
| 收请求 | `ctx.events.on("timeline:bookmarkRequested" / "session-tree:bookmarkRequested")` | 事件总线 |

三个分支操作（bookmark/resume/deleteBookmark）对 pi 都是**文件级操作**，不再 gate 在「激活会话 pi 活着」上——打开历史会话（纯文件读、pi 未起）也能收藏、也能 fork、也能删。只有 dsh 分支才需要活进程走 JSON-RPC。

## 8 插件架构

`plugin.json`：`sidePanel` 槽（`id: "bookmarks"`, `icon: "bookmark"`, `revealOn: "timeline:bookmarkRequested"`）、`languages` 四语言、`dependsOn: ["timeline", "session-tree"]`、`permissions: ["fs:project"]`。

组件 `BookmarksTab` 经 `usePluginContext()` 拿受控 API，不 import 内核文件；纯函数（`cwdToBucketName` 等）经 `@my-harness-desktop/contract` 引用。

## 9 QA

**Q：收藏的会话文件很大，拷贝会卡吗？**

会。`copySession` 在 main 进程用 `fs.copyFileSync` 同步复制，大会话会阻塞 main 几秒。收藏低频、用户有预期，短期可接受；长期改流式复制。

**Q：副本被外部删了会怎样？**

`exists=false`，收藏灰显、不可 fork、只能删。删除时元数据移除、副本路径是「不存在的路径」的幂等清扫（`removePath` 对不存在路径 force 静默成功）。孤儿对账只在加载时跑，不主动补删。

**Q：切项目后看得到别的项目的收藏吗？**

看不到。元数据与副本都按 cwd 物理隔离，切项目 `useUiStore.currentCwd` 变，插件 `useEffect` 依赖它重新加载当前项目的收藏。

**Q：同一个节点收藏两次？**

允许，各生成独立 id 与副本。不做去重。

**Q：并发写元数据会冲突吗？**

`ctx.config.get` + 业务 + `ctx.config.set` 的 read-modify-write 序列非原子，多窗口后写覆盖先写。短期可接受（收藏低频）；`loadBookmarks` 的对账是兜底。
