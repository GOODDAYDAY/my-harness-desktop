# 收藏快照 + fork/收藏统一：插点抽象与快照生命周期

> 状态：设计先行文档（代码尚未落地）。目标分支 `feat/bookmark-snapshot-fork-unify`，基线 main `db805f23`。

## 0 一句话

把「fork」和「收藏」统一成**同一个动作**——在中立会话流的某个节点「插一个点」。区别只在**同步时机**：

- **fork**：立即在中立树里插分支 → 同步到内核 → 继续。
- **收藏**：把该节点的完整前缀**物化成一份自包含快照**，存到项目级目录、先不同步内核；「发起」时再同步快照到内核 + fork。

这是对当前「坐标书签去 opaque」终态（`session-neutral-layer.md` §12）的一次**定向反转**：从「收藏存坐标、发起时现场 fork」回到「收藏存快照副本、发起时同步快照」。反转的理由是用户明确要求 + 快照自包含（源会话被删/压缩后收藏仍可发起）。本文同时承接旧文档 `bookmark-copy-lifecycle.md` 的历史教训（孤儿副本、路径过期、跨项目 fork），在新方案里显式规避。

## 1 现状核查（基线 main）

| 关注点 | 现状 |
|---|---|
| 中立层 lineage 模型 | `NeutralLineage { lineageId, fork: {parentLineageId, boundaryEntryId}|null, entries[] }`；子分支**不物理拷贝**父前缀，内容由 `lineageContent()` 沿 fork 链现算（惰性共享） |
| fork 落点 | `sessionStore.fork()` / `forkFromSession()`：`upsertNeutralLineage` 插一条 `entries: []` + fork 指针的新 lineage，`materializeActiveLineage()` 惰性 seed 投影 |
| 收藏落点 | `sessionStore.bookmark()` → `catalog.bookmark()`：只返回 `{lineageId, entryId}` 坐标，**无副本** |
| 发起落点 | `sessionStore.resume()`：dsh 有 `backend.resume` 走服务端切子会话；pi 无 → `forkFromSession(...,"at")` 兜底（能力探测分流） |
| UI 入口 | fork：timeline `ForkAction` + session-tree 行内按钮；收藏：timeline `BookmarkAction` + session-tree 行内按钮 + `session-bookmarks` 侧栏 tab。fork/收藏入口 API 不一致（`ctx.pi.forkFromSession` vs `ctx.sessions.resume`） |
| 收藏存储 | 元数据在 `ctx.config["bookmarks"]`（项目级 config/session-bookmarks.json），**无快照文件**（历史副本已删） |

## 2 统一抽象：插点（insert-point）

底层新增一个纯函数/用例，把「插点」收敛成单一路径：

```
insertPoint(session, anchorEntryId) -> { newLineageId, snapshotEntries }
```

其中 `snapshotEntries = lineageContent(session, 当前活跃 lineage) 截到 anchorEntryId（含）`——这就是「从某节点复制一份完全相同的数据出来，只是 id 不同」的物化结果。fork 和收藏都消费它：

- **fork**：`insertPoint` 得到 `snapshotEntries` 后，插一条 `entries: [] + fork{parent, boundary}` 的新 lineage（保留现有惰性共享，避免每次 fork 全量拷贝），随后 `materializeActiveLineage` 同步内核。
- **收藏**：`insertPoint` 得到 `snapshotEntries` 后，**直接物化**成快照文件（§3），不同步内核。

两者共用「算出某节点的完整前缀」这一处逻辑，差异只在「存成 fork 指针」还是「存成物化快照」——这正是用户「fork 和收藏是同一份功能」的落地形态。

## 3 快照存储设计

### 3.1 目录

- 快照目录：`<cwd>/.my-harness-desktop/bookmarks/<id>.json`（项目级数据目录，跟随项目、git 可追踪）。
- 元数据：仍走 `ctx.config["bookmarks"]`（`<cwd>/.my-harness-desktop/config/session-bookmarks.json`），但**去掉** `bookmarkPath`/`originalSessionPath` 等旧字段的语义，改为 `snapshotPath` 指向 §3.1 的快照文件。

> 命名决策：用户口述「`.my-harness-desktop/收藏/`」。技术实现用英文目录名 `bookmarks/`（避免中文目录名的编码/跨平台风险），语义等同；如坚持中文目录名可再改，属纯命名项。

### 3.2 快照文件格式（中立 JSON，跨内核）

```jsonc
{
  "version": 1,
  "id": "<bookmark-id>",                 // crypto.randomUUID()
  "label": "…",
  "preview": "…",
  "createdAt": "ISO-8601",
  "sourceKernel": "pi" | "dsh",          // 来源内核（仅记录，不参与投影路由）
  "sourceNeutralSessionId": "…",
  "boundaryEntryId": "{lineageId}:{seq}", // 锚点（fork "at" 的 entry）
  "lineage": {
    "lineageId": "<快照自身 lineage id>",
    "entries": [ /* NeutralEntry[] —— 完整前缀的物化拷贝 */ ]
  }
}
```

关键点：`entries` 是 `insertPoint` 物化出的**中立格式** `NeutralEntry[]`，不是任何内核的 JSONL/日志格式。这样快照与内核解耦，发起时经既有 `seed` 投影投到任意内核（pi / dsh），满足「desktop 同步到 pi、同步到 dsh 是必须实现的功能」。

### 3.3 历史教训规避（承接 bookmark-copy-lifecycle.md）

- **路径基准单一**：快照目录永远用 `currentCwd` 构造，元数据里的 `cwd` 只作展示存档、不参与路径拼接（旧 bug 根因）。
- **删除解耦**：取消收藏（删元数据）必须成功，快照文件清理 best-effort + 孤儿对账兜底（保留现有 `loadBookmarks` 对账，把 `bookmarkSessionFile` 改成新快照路径）。
- **孤儿对账**：`listDir(bookmarks 目录)` 减元数据 id 集合，差集静默删 + 在途创建豁免（`pendingCreateRef`），沿用现有机制。

## 4 发起（initiate/resume）流程

收藏「发起」= 快照 → 内核 → fork：

1. 读快照文件，得到物化的 `lineage.entries`。
2. 在中立 store `upsertNeutralLineage` 插一条 `entries: []`（或直接把快照 lineage 作为新分支）+ `fork{parent: 当前活跃 lineage, boundary: 快照.boundaryEntryId}`，设为活跃 lineage。
3. `materializeActiveLineage()` 把该 lineage 的完整内容（= 快照 entries）经 `seed` 投影到目标内核——pi 走文件 seed、dsh 走 RPC seed，**能力探测、不写 `if (kernel)`**。
4. 返回新会话 lineage，UI 滚到锚点消息。

与现状 `resume` 的差异：现状是「现场从源会话 fork」，新方案是「从快照 fork」——源会话删了也能发起（快照自包含）。

## 5 插件物理合并

目标：**只留一个插件承载「插点」功能**。以 `session-bookmarks` 为宿主（保留 id 以最小化 dependsOn 破坏，displayName 改为「会话分叉与收藏」）：

1. **messageActions**：把 timeline 的 `fork`/`bookmark` 两个贡献迁到 `session-bookmarks` 的 `contributes.messageActions`，组件实现 `ForkAction`/`BookmarkAction` 从 timeline 的 `message-actions.tsx` 移到 `session-bookmarks/renderer/`（timeline 删贡献 + 删组件 + 删 re-export）。`messageActions` 槽天然跨插件（`resolveMessageActionComponent(pluginId, component)`），无需改框架。
2. **tree 行内按钮**：session-tree 目前 fork/收藏按钮是硬编码行内、无槽位。为把「插点」收进一个插件，给 session-tree 增加 `treeActions` 槽（新贡献接口，镜像 messageActions），fork/收藏/copy 按钮迁为槽贡献、由 session-bookmarks 贡献 fork+收藏。若槽位化成本过高，最低限度是：行内按钮调用 `session-bookmarks` 导出的同一套 `insertPoint` 逻辑（机制统一），UI 位置暂留 session-tree——但优先走槽位化终态。
3. **timeline 与 session-tree 的 dependsOn** 相应调整（它们不再拥有 fork/收藏动作）。

## 6 测试与演示

- **单测（vitest，node 环境）**：
  - `insertPoint` 纯函数：物化前缀截取正确、含 boundary、多分支/环/悬空引用防御。
  - 快照写读往返：快照 JSON 与 `NeutralEntry[]` 互转、`version` 校验。
  - `resume/initiate` 用例：快照 → seed 投影（pi 文件 seed / dsh RPC seed 双路，mock backend）→ fork。
- **DOM 测试（新增 jsdom + @testing-library/react 基建）**：`BookmarksTab` / `ForkAction` / `BookmarkAction` 交互（点击收藏 → config/快照落盘、点击发起 → resume 调用、删除确认、空态）。
- **e2e（`scripts/verify-e2e.mjs`）**：在既有验证链上补「收藏 → 发起」链路检查。
- **demo（`scripts/demo/scenarios/bookmark/`）**：扩展现有场景，从「只演示收藏动作 + tab 揭示」升级为「收藏 → 发起（fork）」，并解决注释里记录的隔离 HOME 下 fork 路径圈禁限制（快照改走项目级 `bookmarks/` 目录 + seed 投影，不再依赖 `~/.pi/agent` 真路径校验），达成「成功执行、成功发起」+ 日志/效果/文件多端校验。

## 6.5 精确契约（已钉死，实现据此落地）

快照文件（`bookmarks/<id>.json`）是收藏的**唯一真相源**（含内容 + 展示元数据）；config 里的 `bookmarks` 降级为**轻量列表索引**（`{ id, label, preview, createdAt, entryId }`，entryId 仅用于发起后 scrollTo）。两者同 id。

session-store 三个方法签名（替换现有坐标版 `bookmark`/`resume`/`deleteBookmark`）：

```ts
// 收藏：物化前缀 → 写快照文件 → 返回快照（不同步内核）
bookmark(sessionPath: string, entryId: string, id: string, label: string, preview: string): Promise<BookmarkSnapshot>;

// 发起：读快照 → seed 到目标内核 → fork 新 lineage（返回新会话路径）
resume(snapshotId: string): Promise<string>;

// 取消收藏：删快照文件（元数据删除仍由渲染层负责）
deleteBookmark(snapshotId: string): Promise<void>;
```

关键点：
- `bookmark` 的 `id` 由渲染层 `crypto.randomUUID()` 生成并传入（沿用其 `pendingCreateRef` 创建窗口豁免逻辑）；label/preview 由渲染层传入（session-store 只持久化、不生成文案）。
- `resume` 用能力探测找投影：有 `backend.resume` 用服务端切子会话；否则把快照 `lineage.entries` 经 `materializeActiveLineage` seed 投影（pi 文件 seed / dsh RPC seed），不写 `if (kernel === "pi")`。
- IPC 通道名不变（`sessions.bookmark` / `sessions.resume` / `sessions.deleteBookmark`），只改 handler 入参形状与 `build-kernel.ts` 桥接签名。

## 7 迁移与兼容

- 存量「坐标书签」元数据（无快照文件）→ 首次加载时惰性补物化：若 `snapshotPath` 缺失，按 `{lineageId, entryId}` 从源会话 `lineageContent` 物化一份快照，失败则标记 `exists=false`（沿用现有降级）。
- `bookmarkPath`（旧 opaque 副本路径）字段废弃，仅作迁移期读源。
