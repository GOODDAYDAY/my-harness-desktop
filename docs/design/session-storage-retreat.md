# 会话存储退进内核：目录/CRUD 下沉适配器 + 会话标识中性化

> 本文是一份**设计文档**，讲"为什么这么做""边界在哪""取舍是什么"，不写实现代码。落地展开是另一个 commit 的事，但每个 commit 都必须是本文某个完整阶段的完整态。

## 0 一句话结论

壳（`core/application`）一直在读 pi 的会话存储（JSONL 文件 + parentId 树），这违反了「壳不读任何内核的存储」这条不变量。根因不是某个函数放错文件，而是**中立契约 `BaseBackend` 漏掉了「会话目录/CRUD」这半张面**——契约没覆盖，壳就用「直接读 pi JSONL」把这半张补上了。修复不是把函数挪个地方，而是：**补齐中立契约的会话目录面 + 把整套 pi 存储层迁进 `client/pi` 适配器 + 把会话标识从「pi 文件路径」中性化为「不透明 sessionId」**。

## 1 问题与根因

### 1.1 被违反的不变量

CLAUDE.md §7.5 不变量 #1：

> 壳不读任何内核的存储。pi 的 JSONL 文件、dsh 的 session log，壳都不碰，只认不透明 `sessionId` + `LineageTree` + `Anchor`。

现状违反这条不变量的是**一整层**，不是一两个函数：

| 文件（都在 `core/application/sessions/`，即壳内） | 读的是 pi 的什么 |
|---|---|
| `session-scanner.ts` | `listSessions` / `readSession` / `readSessionHeader` / `readSessionCustom` / `readSessionToolConfig` / `readSessionTree` / `renameSession` / `updateSessionHeader` / `copySession` / `removePath` / `deleteSessionFiles` —— 全是 pi JSONL 的读/写 |
| `project-stats.ts` | `getProjectStats` 扫 `<agentDir>/sessions/<cwd桶>/` 下 JSONL，聚合 usage |
| `context-probe.ts` | `readContextProbeTokens` 读 pi 侧车文件 `desktop-context-probe.json` |
| `session-bus.ts` | `readLastAssistantTextFromFile` 读会话 JSONL 尾部；`opSessionReopen` 用 `~/.pi/agent/sessions/` 路径圈禁 |

`session-scanner.ts` 第一行注释就写着"扫 `~/.pi/agent/sessions/<cwd桶>/` 下的 JSONL"——它**自知**在扫 pi 的存储，只是物理上长在了壳里。

### 1.2 根因：中立契约漏了「会话目录/CRUD」这张面

把壳要的会话能力和中立契约对照：

- `BaseBackend`（圆心契约，`core/domain/backend.ts`）覆盖的是**进程 + 分支**：
  - 进程：`start` / `stop` / `sendMessage` / `abort` / `setModel` / `seed`
  - 分支：`fork` / `getTree` / `getEntries` / `bookmark` / `resume` / `deleteBookmark`
- `SessionsApi`（壳的会话面，`core/domain/sessions.ts`）还额外需要**目录/CRUD**：
  - `list` / `openSession` / `renameSession` / `updateHeader` / `deleteSessions` / `copySession` / `readToolConfig` / `projectStats`

这八个操作**在 `BaseBackend` 里没有对应**。契约没覆盖，壳又不能不用，于是壳在 `session-scanner` 里直接读了 pi JSONL 把这块补上。

「目录/CRUD」和「进程/分支」一样，是「会话模型」这个完整面的一部分，都是内核专属存储操作——pi 的答案是 JSONL + parentId 树，dsh 的答案是 append-only log + session forest。壳都不该知道。契约漏了这半，壳就越界自己读了。

### 1.3 为什么这是原则问题，而不是代码问题

这个错误的自然后果已经显现：**dsh 会话在壳里不可见**。因为目录/CRUD 是 pi 形状的（读 pi JSONL），dsh 会话不是 pi JSONL 文件，所以 dsh 会话进不了会话列表、打不开、不能改名、不能删——dsh 永远只能当"二等内核"。

也就是说，之前那一串"问题"（bookmark 路径重复、getTree 死参数、activeProc gate、`pi-backend` 死代码）全是一个根因的多个症状。逐个修症状 = 在错误层里打转；修根 = 补齐契约 + 迁层。

## 2 目标与终态

终态是下面这张图，依赖方向只向内：

```
core/domain/backend.ts           圆心契约（零依赖，换内核不动）
  BaseBackend          进程 + 分支（已存在）
  SessionCatalog       目录/CRUD（本次补）
  BackendFactory       create(opts) → BaseBackend（已存在）
  SessionCatalogFactory create(kernel) → SessionCatalog（本次补）
        ▲ implements
client/pi/                       pi 适配器（pi 存储的唯一读点）
  pi-backend.ts         PiBackend（进程 + 分支）
  pi-catalog.ts         PiSessionCatalog（目录/CRUD；现 session-scanner + project-stats + context-probe 迁来）
client/dsh/                      dsh 适配器（dsh 存储的唯一读点）
  dsh-backend.ts        DshBackend（进程 + 分支）
  dsh-catalog.ts        DshSessionCatalog（目录/CRUD；第一阶段显式降级，第二阶段补面）
        ▲ 组装归 bootstrap（bootstrap/kernel/kernel-factories.ts 把接口和实现绑起来）
core/application/sessions/
  session-store.ts      只做编排：经工厂拿 Backend/Catalog 委托；一行不碰 pi JSONL、不拼 pi 路径
```

终态之后：

- pi 的存储（JSONL 格式、parentId 树、桶命名、副本路径、usage 口径）**只在 `client/pi` 出现**。
- dsh 的存储只在 `client/dsh` 出现。
- 壳（`session-store`）只认不透明 `sessionId` + 中性类型（`SessionInfo`/`SessionDetail`/`LineageTree`/`Anchor`/`ProjectStats`）。
- 之前那串"问题"自动消失：bookmark 路径规则只在 pi-catalog 单源、getTree 是 pi 适配器自己的存储实现、目录/CRUD 不经过活进程、pi-backend 不再是死代码。

## 3 契约设计

### 3.1 SessionCatalog：目录/CRUD 的中立面

独立于 `BaseBackend` 的原因：`BaseBackend` 是 **per-session**（一个 backend = 一个会话进程，有 `start`/`stop` 生命周期）；目录/CRUD 是 **per-kernel、跨会话**（列一个项目下所有会话、打开任意会话）。两者正交，混在一个接口里会让 `BaseBackend` 承担两个职责。

```ts
// core/domain/backend.ts（圆心，零依赖）
export interface SessionCatalog {
  readonly kernel: KernelId;

  /** 列某 cwd 下的历史会话（中性投影）。 */
  list(cwd: string): Promise<SessionInfo[]>;

  /** 打开会话：头信息 + 全部消息 + 文件聚合统计基线（纯存储读，不启进程）。文件不存在/损坏返回 null。 */
  open(sessionId: string): Promise<SessionDetail | null>;

  /** 重命名会话（名字真相源落存储）。 */
  rename(sessionId: string, name: string): Promise<void>;

  /** 改写会话元字段（pinned/archived/toolConfig/custom 域）。 */
  updateHeader(sessionId: string, patch: HeaderPatch): Promise<void>;

  /** 删除会话（真删，不可恢复）。 */
  deleteSessions(sessionIds: string[]): Promise<void>;

  /** 复制会话到目标（书签快照素材）。 */
  copy(srcId: string, dstId: string): Promise<void>;

  /** 读会话工具配置（无配置返回 null）。 */
  readToolConfig(sessionId: string): Promise<SessionToolConfig | null>;

  /** 项目总统计：聚合本 cwd 桶下全部会话的 usage（含壳未运行期产生的会话）。 */
  projectStats(cwd: string): Promise<ProjectStats>;
}

/** 目录/CRUD 工厂：产出某内核的 SessionCatalog（依赖倒置，组装归 bootstrap）。 */
export interface SessionCatalogFactory {
  create(kernel: KernelId): SessionCatalog;
}
```

方法全部是 `Promise`——pi 的实现是同步 `readFileSync` 包一层，dsh 的实现是真正的异步 JSON-RPC。契约按最难的实现（异步）定形状。

### 3.2 为什么目录/CRUD 是"内核专属"，不是"壳通用"

关键判断（§4.5 换壳测试 + §7.6 三分法）：

- `SessionInfo.name` 怎么来？pi 读 `session_info` 条目（JSONL 里的一种 entry），dsh 读 header 里的名字——**派生方式内核专属**，但派生产出的中性类型（`SessionInfo`）是壳通用的。
- `SessionDetail.stats` 怎么聚合？pi 扫 `message.usage`（JSONL），dsh 从 session log 拿——**内核专属**。
- `list` 怎么列？pi 扫 `<agentDir>/sessions/<cwd桶>/` 目录，dsh 查 `DSH_SESSION_ROOT`——**内核专属**。

所以「目录/CRUD」进 `SessionCatalog` 契约，由每个内核用自己的存储实现；`SessionInfo`/`SessionDetail`/`HeaderPatch`/`SessionToolConfig`/`ProjectStats` 这些**中性类型留在圆心**，是内核交出来的投影，不是内核私有。

### 3.3 会话标识中性化（关联的更深一层，同根）

目录/CRUD 之外，进程层还有一处 pi 形状泄漏，是同一根的第二半：

- `session-store` 的 `procs` 用 `key === boundSessionPath`（pi 文件路径）做键。
- `SessionProc.boundSessionPath` / `kernelSessionId` 是文件路径语义。
- `resync` 的 `state.sessionFile` 是 pi 的 `get_state` 返回的文件路径，`session-store` 读它来 `rekeyProc`。
- `SessionTreeApi.fork` 用的是 `pi.forkCommand` + `reconcileAfterSessionReplacement`（读 `state.sessionFile`），而不是中性契约里的 `BaseBackend.fork(parent, boundary)`（它返回不透明 `lineageId`）。

中性化的终态：壳里不出现"会话文件路径"这个 pi 概念，只出现不透明 `sessionId`。`procs` 按 `sessionId` 键；fork 后切激活会话用 `BaseBackend.fork` 返回的 `lineageId`，而不是读 RPC 状态里的文件路径；新会话 id 由适配器生成（`seed`/`start` 返回不透明 id），壳不自己拼 `~/.pi/agent/sessions/<桶>/<时间戳>_<uuid>.jsonl`。

这一半和目录/CRUD 是同一根（"壳不认 pi 的文件路径"），但动的是进程层，风险更高，单列成一个阶段（§5 阶段 2）。

## 4 内核实现

### 4.1 pi：把现有存储层整体迁进 client/pi

`client/pi/pi-catalog.ts` 收编现壳里所有 pi 存储读，函数逐个落位：

| 现位置（壳） | 迁到（pi 适配器） | 变成 |
|---|---|---|
| `session-scanner.listSessions` | `PiSessionCatalog.list` | 实现 |
| `session-scanner.readSession` | `PiSessionCatalog.open` | 实现 |
| `session-scanner.renameSession` / `updateSessionHeader` | `PiSessionCatalog.rename` / `updateHeader` | 实现 |
| `session-scanner.copySession` / `removePath` / `deleteSessionFiles` | `PiSessionCatalog.copy` / `deleteSessions`（+ 内部 `removePath`） | 实现 |
| `session-scanner.readSessionToolConfig` | `PiSessionCatalog.readToolConfig` | 实现 |
| `session-scanner.readSessionHeader` / `readSessionCustom` / `extractSessionInfoName` / `lastEntryId` / `readSessionTree` | `pi-catalog.ts` 内部 | 私有 helper |
| `project-stats.getProjectStats` | `PiSessionCatalog.projectStats` | 实现 |
| `context-probe.readContextProbeTokens` | `pi-catalog.ts` 内部（或 pi-backend 内部） | 私有 helper |
| `session-bus.readLastAssistantTextFromFile` | `PiSessionCatalog`（经 `open` 取末条 assistant 文本）或 pi-backend 内部 | 复用 `open` |

`session-scanner.ts`、`project-stats.ts`、`context-probe.ts` 迁空后删除；`PiBackend` 里 `bookmark` 的副本拷贝、`getTree` 的树读、`deleteBookmark` 的删副本都改调 `pi-catalog` 的同一份实现——路径规则（`<cwd>/.my-harness-desktop/session-bookmarks/<stamp>.jsonl`）在 `pi-catalog` 单源。

### 4.2 dsh：目录/CRUD 文件级读 dsh 会话日志（与 PiSessionCatalog 对称，不碰 deepseek-harness）

dsh 的会话是**事件溯源、append-only 的 JSONL 日志**（`packages/core/session/lib/index.js`：in-memory store `ctx.sessions` + persistence plugins 异步写 JSONL）。所以 dsh 的目录/CRUD 和 pi 同构：**dsh 适配器（`client/dsh`）直接读 dsh 的会话日志文件，翻译成壳协议**，不需要给 dsh 加任何 JSON-RPC 方法、不改 deepseek-harness。

- `DshSessionCatalog.list` 扫 dsh 会话日志目录；`open` 读日志并投影成 `SessionDetail`；`rename`/`updateHeader`/`delete`/`copy` 走文件操作；`projectStats` 聚合日志 usage；`getTree` 从日志事件投影 lineage。
- **内核切换的转换层**（§3.3）同步补齐 dsh 侧：`getEntries` = 读 dsh 日志 → 中性历史；`seed` = 中性历史 → 写 dsh 会话日志（让 persistence backend 下次 load 读入）。转换永远经壳协议（中性历史），不直接 pi↔dsh。

> 前置未钉：dsh 日志的**落盘目录、文件名规则、JSONL 事件格式、以及 seed 能否纯文件级重建会话**——这四项要在写 DshSessionCatalog 前定位（persistence backend 的落盘逻辑还没查实）。

### 4.3 session-store：只留编排

`session-store`（壳）改动后：

- 目录/CRUD：`list`/`openSession`/`renameSession`/`updateHeader`/`deleteSessions`/`copySession`/`readToolConfig`/`projectStats` 全部变成「按会话头行内核身份 → `catalogFactory.create(kernel)` → 委托」。
- 分支：`getTree`/`bookmark`/`resume`/`deleteBookmark` 经 `backendFactory.create({kernel})` → 委托（`create` 不 spawn，pi 的文件级方法不依赖活进程）。
- `forkFromSession` 这个"书签 fork 原子用例"里的 `copySessionFile`/`deleteSessionFiles` 改成经 catalog 委托；`start`/`fork`/`reconcile` 走 backend（阶段 2 里 `reconcile` 改按不透明 id）。

`session-store` 不再 import `session-scanner` 的任何函数，也不拼任何 pi 路径。

## 5 迁移阶段

每个阶段都是可用的完整态（不是"先占位"），每阶段一个 commit：

### 阶段 1：目录/CRUD 下沉 + SessionCatalog 契约（本次核心）

1. 圆心补 `SessionCatalog` + `SessionCatalogFactory`（`core/domain/backend.ts`）。
2. 新建 `client/pi/pi-catalog.ts`，把 `session-scanner`/`project-stats`/`context-probe` 的 pi 存储读迁进去，实现 `PiSessionCatalog`。
3. 新建 `client/dsh/dsh-catalog.ts`，`DshSessionCatalog` 全方法显式抛"未接线"（显式降级）。
4. `bootstrap/kernel/kernel-factories.ts` 补 `createPiCatalog`/`createDshCatalog`，绑进 `SessionCatalogFactory`。
5. `session-store` 的目录/CRUD 方法改经 catalog 工厂委托；`PiBackend` 的 bookmark 拷贝/getTree/deleteBookmark 改调 `pi-catalog`；删掉壳里的 `session-scanner`/`project-stats`/`context-probe` 及 `session-store` 内直接文件操作。
6. **验证**：pi 全功能不回归（列表/打开/改名/删/收藏/统计/树），dsh 的目录入口显式降级。

### 阶段 2：会话标识中性化（进程层）

1. `state.sessionFile` → 不透明 `sessionId`（resync/context-binding 层面，pi 仍给文件路径但当不透明 id 回传）。
2. `procs` 键从 `key === boundSessionPath` 改为按 `sessionId`；`rekeyProc`/`resolveProcKey` 的中性化。
3. `SessionTreeApi.fork` 改走 `BaseBackend.fork`（返回 lineageId），"切激活会话"用返回的 id 而非读 RPC 状态。
4. 新会话 id 由适配器生成（`start`/`seed` 返回不透明 id），壳不再 `generateNewSessionPath`。
5. **验证**：fork/clone/retry/rewind/收藏 fork/跨内核切换在 pi 下全链路不回归。

### 阶段 3：dsh 补面（dsh 会话成为一等公民，全在 my-harness-desktop 侧）

1. 定位 dsh persistence backend 的落盘目录 / 文件名 / JSONL 事件格式（只读 deepseek-harness，不改）。
2. `DshSessionCatalog` 文件级读 dsh 会话日志，实现 list/open/rename/updateHeader/delete/copy/readToolConfig/readCustom/projectStats/getTree/bookmark/deleteBookmark。
3. `DshBackend.getEntries` 改读 dsh 日志 → 中性历史；`seed` 改中性历史 → 写 dsh 会话日志（补内核切换转换层的 dsh 侧）。
4. **验证**：dsh 会话可列/可开/可改名/可删；pi↔dsh 切换经 getEntries/seed 不丢内容；壳的目录 UI 对 pi/dsh 无差异。

## 6 边界与 QA

**Q：为什么目录/CRUD 不并进 `BaseBackend`，而是新开 `SessionCatalog`？**

`BaseBackend` 是 per-session 的进程句柄（有 `start`/`stop`/`alive`），目录/CRUD 是 per-kernel 的跨会话存储。硬并进去会让"一个会话的进程"和"一个项目的目录"混成一个对象，`list(cwd)` 这种无会话概念的操作没法安放。分开是职责边界，不是多造抽象。

**Q：pi 的实现是同步 `readFileSync`，契约却是 `Promise`，不是白包一层吗？**

是白包一层，但契约要按"最难的实现"定形状。dsh 的目录/CRUD 读日志文件也可能是异步（大文件流式读），pi 同步实现包成 `Promise` 是零成本；反过来（契约用同步、dsh 被迫转同步）才是真污染。`copy` 是唯一例外（同步），因 forkFromSession 的竞态护栏依赖"copy 在 setContext 之前的同步段"。

**Q：阶段 1 迁完，`session-scanner.ts` 这个文件就删了吗？**

删。它的全部职责（读 pi JSONL）都进了 `pi-catalog`。它的单测（`session-scanner.test.ts`）随迁到 `client/pi`，改测 `PiSessionCatalog` 的公开方法。

**Q：`context-probe.ts` 读的是 `desktop-context-probe.json`，不是会话文件，也算"读 pi 存储"吗？**

算。这个侧车文件是 pi 的 context-probe 扩展写出来的，路径在 `<agentDir>`（pi 的目录），形状是 pi 的。它和 `known-tools.ts` 一样属于"pi 底座侧车文件的桌面读取"，该在 `client/pi`。

**Q：dsh 阶段 1 全抛"未接线"，会不会让 dsh 用户看到半吊子界面？**

不会。阶段 1 是显式降级：壳在目录入口按"内核不支持"隐藏/置灰，并给 tooltip，不是抛错给用户看。这正是 §7.6 的第三条出路，比静默缺面（现在的样子）诚实。

**Q：这个重构会不会和「收藏 fork 用 `forkFromSession`」的既有设计冲突？**

不冲突，反而是它的正确归宿。`forkFromSession` 是"从任意会话文件 fork"的原子用例，它内部的文件复制/删除本就是 pi 存储操作，阶段 1 里这些动作改经 `PiSessionCatalog.copy`/`deleteSessions` 委托；阶段 2 里"切激活会话"改按不透明 id。用例编排留在壳，存储动作退进适配器，正是"构造在内、执行在外"。

**Q：阶段 2（会话标识中性化）为什么不能和阶段 1 一起做？**

两者都源于"壳认 pi 文件路径"，但阶段 2 动的是进程调度层（procs 键、resync 基线、fork 对账），牵到 timeline 的增量应用、多进程并存、restart 协调。把它和阶段 1 混在一个 commit 里，pi 回归和"中性化"两个变量一起炸，分不清是谁的错。分开后每个阶段有已知正确的参照线（CLAUDE.md §4.5 迁移顺序的同一逻辑）。
