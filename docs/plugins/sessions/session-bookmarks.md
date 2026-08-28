# session-bookmarks 插件技术文档

## 一、定位与职责边界

`session-bookmarks`（manifest `displayName` 为「会话分叉与收藏」）是 `src/plugins/sessions/` 域下唯一承载「插点」功能的壳插件。它的职责不是"存一个收藏列表"，而是把「fork」和「收藏」这两件看似独立的事收敛成同一个抽象动作——在中立会话流的某个节点「插一个点」，两者的差异只在同步时机：

- **fork**：立即在中立树里切一条新 lineage（空 `entries`，存 fork 指针），但**惰性物化**——分支只在下次 send 时才经 `materializeActiveLineage` seed 投影到内核，比收藏发起更轻。
- **收藏**：把该节点的完整前缀**物化**成一份自包含快照文件（`NeutralEntry[]`），存项目级目录、先不同步内核；用户之后点「发起」时才把快照 `seed` 投影到目标内核再 fork。

这个定位直接写在 `plugin.json` 的 `description` 字段里——「插点功能的唯一宿主」。它的上位设计文档是 `docs/design/bookmark-snapshot-fork-unify.md`，该文档的 §0 一句话把上述二分讲透了，§5 拍板了物理合并方案：fork/收藏的动作组件从 timeline 迁入本插件、timeline 与 session-tree 不再拥有 fork/收藏动作。

把职责边界钉清楚，对读懂后续代码至关重要：

- **本插件拥有的**：插点动作的 UI 入口（`ForkAction`/`BookmarkAction` 两个 messageActions 贡献 + 右面板 `BookmarksTab`）、收藏元数据的读写（`ctx.config` 的 `bookmarks`/`bookmarkOrder` key）、快照文件的触发式物化与删除（经 `ctx.sessions.bookmark`/`deleteBookmark`）、旧全局桶的一次性懒迁移、孤儿对账、发起（fork）动作。
- **本插件不拥有的**：快照文件的物理读写（在 `src/server/application/sessions/bookmark-snapshot-store.ts`，壳后端）、前缀物化的纯函数（在 `packages/shared/src/domain/bookmark-snapshot.ts`，圆心）、seed 投影与内核会话编排（在 `session-store.ts`）、消息行的渲染（在 timeline）、树的渲染（在 session-tree）。
- **本插件刻意不做的**：不 import 任何 `src/server`/`src/web` 内部模块，只 import `@my-harness-desktop/shared` 和 `@my-harness-desktop/react`；不在渲染层写 `if (kernel === "pi")` 的内核分支——发起收藏时目标内核的选择、seed 投影的 pi/dsh 分流全在壳后端的 `session-store.resume` 里按能力探测完成，渲染层只是调 `ctx.sessions.resume(bm.id)`。

一个容易混淆的点要提前说清：本插件的 `permissions` 里声明了 `fs:project`，但它的快照文件**不是**自己用 `ctx.fs` 写的。快照的写读删走的是 `ctx.sessions.bookmark`/`resume`/`deleteBookmark` 这条会话通道（最终落到 `BookmarkSnapshotStore`），`ctx.fs` 只用于两处：加载时 `listDir(snapshotDir)` 枚举盘上快照做 `exists` 判定与孤儿对账、删除孤儿时 `removePath`。这个「会话通道写、fs 通道枚举+删孤儿」的分工，是理解 `fs:project` 权限为什么存在、以及历史 bug（`bookmark-copy-lifecycle.md` 记载的"两条通道圈禁基准不对称"）的关键。

## 二、manifest 声明面（plugin.json）

`plugin.json` 是插件接入的第一接入点，全部 68 行，逐字段值得拆：

- **身份字段**：`id: "session-bookmarks"`、`version: "0.4.9"`、`tier: "official"`（内置官方插件，但按 CLAUDE.md §1.4 无特权差异，可被用户目录同 id 插件覆盖）、`displayName: "会话分叉与收藏"`、`description` 见上、`tags: ["session"]`。
- **renderer 入口**：`"renderer": "./renderer/index.tsx"`——框架加载此 module 后，读 `contributes.*[].component` 字段在 module exports 里自动匹配同名组件（CLAUDE.md §7.4 组件自动匹配），本插件因此只需 export `BookmarksTab`/`ForkAction`/`BookmarkAction`，不调任何 register 函数。
- **`dependsOn: ["timeline", "session-tree"]`**：这是生命周期护栏，不控制加载顺序（CLAUDE.md §8.2）。声明它是因为本插件消费了 timeline 和 session-tree 的东西：`ForkAction`/`BookmarkAction` 作为 messageActions 由 timeline 消费渲染（依赖 timeline 挂消息行），`BookmarksTab` 订阅 session-tree 的 `session-tree:bookmarkRequested` channel（依赖 session-tree 声明该 channel）。反过来 session-tree 并不 dependsOn 本插件（它 emit 的是自己声明的 channel，不依赖本插件存在）。
- **`permissions: ["fs:project"]`**：申请项目级文件系统权限。`ctx.fs` 的所有操作（`listDir`/`removePath`）经此权限在网关边界放行，且被 `assertProjectPath` 圈禁在当前项目根内。这是本插件唯一声明的权限——`ctx.sessions`（含 bookmark/resume/deleteBookmark）属核心默认能力，不需要声明。
- **`contributes.sidePanel`**：一条贡献 `{ id: "bookmarks", label: "收藏", icon: "bookmark", component: "BookmarksTab", order: 5, revealOn: "bookmarks:addRequested" }`。`order: 5` 让它排在右面板图标条最前（session-tree 的 tree 是 `order: 40`）。`revealOn` 是声明式揭示触发器，语义见 §七.3。
- **`contributes.messageActions`**：两条贡献，都是 `placement: "left"`、`when: { role: ["assistant"] }`——即只在 assistant 消息上、消息内容侧出现。`fork` 的 `order: 18`、`bookmark` 的 `order: 20`，与 timeline 自己的 `copy`（order 10）在 timeline 的 `MessageActions` 渲染里按 order 排序混排。注意 `when.role` 是**消费方（timeline）过滤**用的（`timeline/renderer/index.tsx` 的 `slotActions.filter((a) => !a.when?.role || a.when.role.includes(message.role))`），组件内部（`ForkAction`/`BookmarkAction`）仍各自再做一次 `message.role !== "assistant"` 的守卫，双层保险。
- **`contributes.languages`**：4 个语言包（zh-CN/zh-TW/en/de），namespace 都是 `session-bookmarks.bookmarks`，指向 `locales/<locale>/bookmarks.json`。

值得强调的「无硬编码」纪律（CLAUDE.md §8.3）：manifest 里 `component: "BookmarksTab"` 是自动匹配名、`icon: "bookmark"` 是 lucide 图标名、`revealOn` 是 channel 字符串——这些都是契约 key 而非内容值。真正的用户可见文案（「收藏」「删除」「搜索收藏...」）不进 manifest，全走 `locales/*/bookmarks.json` 的 i18n key。manifest 里唯一一段中文是 `label: "收藏"` 和 `displayName`——`label` 是 sidePanel Tab 的显示名，此处直接写了中文字面量而非 i18n key，属历史残留（session-tree 的 `label: "Tree"` 同样是字面量）；严格按「token key 合规、token 值违规」它该改成 key，但 sidePanel 的 `label` 契约字段目前是纯字符串、框架未对 sidePanel label 做 `t()` 解，故作为已知偏离留档。

## 三、renderer 层逐文件解析

### 3.1 index.tsx：BookmarksTab 与快照收藏的 UI 宿主

`renderer/index.tsx` 是 550 行的主文件，结构分四段：顶部类型与工具函数、`BookmarksTab` 主组件、`AddForm` 子组件。顶部两行是接入骨架：

- `export const channels = ["bookmarks:addRequested"] as const;`——代码级 channel 声明（CLAUDE.md §8.2），框架加载 module 后读 `module.channels` 自动注册到事件总线。本插件**拥有**这个 channel。
- `export { BookmarkAction, ForkAction } from "./message-actions";`——把 messageActions 槽的两个动作组件 re-export 到入口，框架按 manifest 的 `component` 名在本 module exports 里找。

**类型契约 `BookmarkMeta` / `BookmarkRequest`**：

- `BookmarkMeta` 是收藏元数据（存 `ctx.config["bookmarks"]` 数组元素）。字段里 `bookmarkPath?`（旧书签副本路径，即 `anchor.opaque` 时代残留）和 `originalSessionPath` 已被新快照模型废弃语义——注释明说 `bookmarkPath` 是「旧书签无此字段,resume 回退 bookmarkSessionFile 推导」的历史字段，当前代码路径实际不再读它做定位。`exists?` 是运行时标记（非持久），加载时算「对应快照文件 `<id>.json` 是否在盘上」，UI 据此决定是否显示 fork 图标、是否允许点击发起。
- `BookmarkRequest` 是收藏触发点（timeline 一击收藏 / session-tree 树行收藏）经事件总线投递的 payload 形状：`{ sessionPath, entryId, preview, label }`。`label` 字段的语义差异是关键——timeline 一击收藏给的是默认 label（会话名或预览），tree 树行原位输入给的是终值，这决定了 `createBookmark` 之后的「是否原位进入改标题」。

**路径工具函数**：`bookmarkDataDir`/`bookmarkSessionFile` 是旧 fork 副本模型（`<cwd>/.my-harness-desktop/session-bookmarks/<id>.jsonl`）的路径构造，现已基本废弃、仅 `migrateLegacyBucket` 迁移时用；`snapshotDir` 是新快照模型（`<cwd>/.my-harness-desktop/bookmarks/<id>.json`）的目录，渲染层只用来做 `exists` 判定与孤儿对账的 `listDir` 枚举。`joinPath` 是本地 `base.replace(/\/$/,"")` + 拼接的简单 helper。

**`migrateLegacyBucket`（一次性懒迁移）**：读旧全局桶 `~/.my-harness-desktop/plugins-data/session-bookmarks/<cwdToBucketName(cwd)>/index.json`，非空则先 `ctx.config.set("legacyMigrated", true)` 落哨兵、再逐条 `ctx.sessions.copySession` 把旧 `session.jsonl` 副本搬回项目级 `session-bookmarks/` 目录、最后把 index 写进统一通道 `bookmarks`。这里有几条必须读懂的纪律：

- `cwdToBucketName` 来自 `@my-harness-desktop/shared`（`packages/shared/src/domain/sessions.ts`），是「会话按 cwd 分桶」规则的**唯一源**——注释明说它不可逆（横线歧义）但正向可算，故迁移只在打开项目时算自己的旧桶名去检查，不反向解析。
- 「哨兵纪律」是根因修复的产物：迁移没有完成态会导致「删光全部收藏 → 下次加载又迁移复活」。`legacyMigrated` 标记解决的是「迁移无完成态」这个根因，而非在删除逻辑上打补丁。
- 迁移用 `ctx.sessions.copySession`（session 通道，宽松圈禁）而非 `ctx.fs`（fs 通道，严格圈禁当前项目根）——旧桶在 `~` 下、不在项目根内，fs 通道够不着，这也是历史 P1-D1 bug 把书签逼出项目目录的遗留（`bookmark-copy-lifecycle.md` 的背景）。
- 旧桶搬迁后残留不删（删除需写白名单外路径、通道不开放），注释明说「残留只读无危害」。

**`formatRelativeTime`**：用 `Intl.RelativeTimeFormat` + 分档阈值（<60s second、<1h minute……<1y month、≥1y year）把 ISO 时间转本地化相对时间。零文案 key、零依赖——复数/语序由 ICU 处理，locale 随 `i18n.language` 切换。这符合「文案走 i18n、值走库」的纪律：相对时间的「文案值」由浏览器 ICU 生成，插件不写死任何「刚刚/3 分钟前」字面量。

**`BookmarksTab` 主组件**：状态清单见 `useState` 段——`bookmarks`（元数据数组）、`order`/`orderRef`（拖拽排序，`orderRef` 是给删除时同步内存序用）、`pendingCreateRef`（在途创建豁免 Set）、`search`/`editingId`/`editLabel`（搜索与改名）、`forking`/`forkError`（发起中态与错误条）、`deleteTarget`/`showAddForm`/`toast`（删除确认/手动添加表单/提示）。

**`loadBookmarks`** 是加载+对账的核心，值得逐行读（120–156 行）：

1. 先 `if (!currentCwd || !ctx.fs) return;`——无项目或无 fs 权限直接早退。
2. 读统一通道 `ctx.config.get("bookmarks")`；若为空且未迁移过（`!legacyMigrated`），试 `migrateLegacyBucket`。
3. `ctx.fs.listDir(snapshotDir(currentCwd))` 枚举盘上快照，`catch(() => [])` 兜底（目录不存在）。
4. **孤儿对账**：`files - metaIds - pending` 的差集静默 `removePath`。只处理 `.json` 后缀。注释写明设计依据（`bookmark-copy-lifecycle.md §2.4`）：fs:listDir 通道不携带 mtime，为对账给内核加字段违背单文件原则，故用「在途创建豁免」替代 mtime 阈值——`pendingCreateRef` 登记创建中的 id，对账跳过；创建完成（元数据已含 id）后撤销。
5. 把 `exists: files.has(id+".json")` 标记打进每条元数据，`setBookmarks`；读 `bookmarkOrder` 同步 `order`/`orderRef`。

孤儿对账的设计意图要讲透：对账是**兜底不是主力**——主力是 `deleteBookmark` 里删除时顺手清快照文件；对账只在加载时跑，兜住「元数据已删但快照残留」的历史垃圾与删除失败残留，跨加载周期自愈。

**`createBookmark`**（收藏落盘核心，162–191 行）：

- 入口校验 `!currentCwd || !req.sessionPath` 返回 null。
- `crypto.randomUUID()` 生成 id（快照 id 也是文件名 `<id>.json`）。
- 组装 `BookmarkMeta`：`cwd: currentCwd`（注意：**用当前根**，不是任何历史路径）、`entryId: req.entryId`、`originalSessionPath: req.sessionPath`、`createdAt: new Date().toISOString()`。
- **创建窗口豁免**：先把 id 加进 `pendingCreateRef`，`try` 里 `await ctx.sessions.bookmark(sessionPath, entryId, id, label, preview)` 写快照文件 → `ctx.config.get`+`push`+`set` 写元数据 → `loadBookmarks()`；`finally` 里删豁免。这个顺序是「文件先落盘、元数据后写」，中间窗口内对账可能看到「无主文件」——豁免就是为这。
- `ctx.sessions.bookmark` 是快照物化的触发点：渲染层只传 `id/label/preview`，**物化前缀的纯函数计算在壳后端 `session-store.bookmark` 里做**，渲染层不碰 `materializeLineagePrefix`。

**事件订阅段（196–211 行）**是「与其他插件交互」的枢纽，§七专节展开，此处先记结构：`ctx.events.on("bookmarks:addRequested", handler(true))`（timeline 一击收藏，`editAfter=true` 创建后原位改标题）与 `ctx.events.on("session-tree:bookmarkRequested", handler(false))`（树行收藏，已原位输入完、静默创建）。`handler(editAfter)` 闭包：校验 `req.label?.trim()` 非空 → `createBookmark` → `editAfter && id` 时 `setSearch("")`+`setEditingId(id)`+`setEditLabel(label)`。

**`forkFromBookmark`（发起，213–228 行）**：`setForking(bm.id)` → `ctx.sessions.resume(bm.id)` 发起（返回新 lineage id）→ `ctx.events.invoke("timeline:scrollTo", { messageId: bm.entryId })` 让 timeline 滚到锚点消息 → toast 成功。失败 `setForkError({ bm, message })`，错误条带「重试/关闭」两按钮。注意 `void lineageId;`——发起返回的 lineage id 当前渲染层不消费（只需副作用「切到新会话」），留占位。

**`renameBookmark` / `deleteBookmark`**：

- `renameBookmark`：`config.get` → `map` 替换同 id → `config.set` → `loadBookmarks`。纯元数据操作，不碰快照文件。
- `deleteBookmark` 四步（注释对齐 `bookmark-copy-lifecycle.md §2.2`）：① 元数据过滤 `config.set` 必须成功，失败 toast `bookmarks.deleteFailed` 直接返回（唯一对用户可见的失败）；② `ctx.sessions.deleteBookmark(bm.id)` best-effort，catch 只 warn（残留由对账兜底）；③ `bookmarkOrder` 内存同步 + `void config.set` 写回；④ `loadBookmarks()` 刷新 UI。① 失败早退、②③ 成败不影响 ④——这正是「删除解耦」的落地：取消收藏是元数据操作必须成功，删快照是资源回收可失败。

**排序与过滤**：`applyCustomOrder(bookmarks, order, (b)=>b.id, (b)=>b.createdAt)`（来自 `@my-harness-desktop/shared` 的 `custom-order.ts`，是 sessions-list 与 session-bookmarks 共用的拖拽排序唯一实现：不在 order 里的按 created 降序置顶，order 里的接后）；`filtered` 按 label/preview 做大小写不敏感 substring 匹配。

**渲染细节**：无 `currentCwd` 显示 `EmptyState`；搜索框 + 手动添加按钮；`AddForm`（手动添加，输入 sessionPath/entryId/label）；`forkError` 错误条；`SortableList`（来自 react，`values`/`onReorder`/`onEnd` 三态，`disabled={!!search}`）；每条收藏行 `data-bookmark-id={bm.id}`，点击（`bm.exists && forking !== bm.id && deleteTarget?.id !== bm.id`）触发 `forkFromBookmark`；行内悬停显示 fork 图标（`bm.exists` 才显示）/铅笔改名/垃圾桶删除；`deleteTarget` 命中时绝对定位原位覆盖整行的删除确认条。改名交互（Enter/blur 共用 `commitEdit` 提交路径、Escape 取消）注释对齐项目内联编辑器惯例。

**`AddForm` 子组件**：`onResolve`（校验 sessionPath 能 `openSession`、entryId 存在、role 必须是 assistant，返回 `preview` 或 `error`）与 `onSubmit`（调 `createBookmark`）两个回调由父传入。校验里 `messageContentText(msg.content)` 截前 30 字符做预览、`msg.role !== "assistant"` 报 `bookmarks.errorNotForkable`——这条 role 校验是「收藏锚点必须是 assistant 消息」语义的落地（`bookmark-fork-at.md` 的结论）。

### 3.2 message-actions.tsx：ForkAction / BookmarkAction

`renderer/message-actions.tsx`（98 行）是 messageActions 槽两个动作组件的实现，文件头注释写清来源：从 timeline 迁入（原 `timeline/renderer/message-actions.tsx`），`copy/rewind` 仍留 timeline。组件收到框架注入的 `{ message, text }`（`MessageActionProps`，定义在 `packages/react/src/message-actions.ts`）。

**`BookmarkAction`**（一击收藏按钮）：

- 读 `useUiStore` 的 `currentSessionPath`/`currentNeutralSessionId`、`useSessionStore` 的 `snapshot?.state.sessionName`。
- 守卫：`message.role !== "assistant" || !message.id || !currentNeutralSessionId` 返回 null。
- 默认 label 逻辑（与 session-tree 同一拍板）：`sessionName ?? preview`——会话名优先，无名会话回退消息预览（`text.replace(/\s+/g," ").trim().slice(0,30) || "(empty)"`）。
- 点击：`ctx.events.invoke("bookmarks:addRequested", { sessionPath, entryId, preview, label })`，然后 `setDone(true)` + `setTimeout 1500ms` 复位（瞬时反馈「已收藏」，不依赖后端回执）。
- **为什么 invoke 而非 emit**：注释明写「invoke 而非 emit:收藏 tab 未挂载时请求入队,面板揭示后挂载冲刷恰好一次投递」。invoke 有 `pendingInvokes` 队列（`event-bus.ts`：无订阅者时入队、首个订阅者 attach 时恰好一次冲刷），emit 没有这个队列、只会同步调当前 handler——一击收藏时 BookmarksTab 通常未挂载（用户在 timeline 上），必须靠 invoke 的入队语义保证请求不丢。

**`ForkAction`**（分叉按钮）：

- 读 `currentCwd`/`currentNeutralSessionId`、`useSessionStore` 的 `streaming`、`useArmConfirm`（react 的武装确认 hook）。
- 守卫同上（assistant + id + currentNeutralSessionId）。
- `handleFork`：`streaming` 时 toast `shell.forkStreamingBlocked` 挡住；否则 `await ctx.pi.forkFromSession(currentCwd, currentNeutralSessionId, message.id, "at")`。
- 交互是「武装确认」：首次点击 `arm(true)`（按钮原地变红「确认 fork?」，`useArmConfirm` 的 6 秒超时/Esc 自动复位），武装态再点才 `disarm()` + `handleFork()`。这是危险操作（切走当前会话）的二次确认，不是防抖。
- **fork 与收藏的发起同源但路径不同**：收藏发起走 `ctx.sessions.resume`（读快照 → seed → fork），fork 动作走 `ctx.pi.forkFromSession`（pi 扩展面，直接在中立树切 lineage、惰性物化）。注释写明「与收藏发起同源『从某节点开新分支』」。`forkFromSession` 是 `PiExtensions` 的方法（`packages/shared/src/domain/sessions.ts`），dsh 下无此面——但 ForkAction 不感知这个差异，因为 `plugin-context.ts` 的 `ctx.pi` 恒存在、dsh 下调用会在后端 `piSend`/`asPi` 边界显式降级抛错，UI 用 try/catch 接住报 `shell.forkFailed`。错误消息用正则 `/Error invoking remote method '[^']+': (?:Error: )?([\s\S]*)$/` 剥掉 IPC 前缀，取出内核侧原始错误文本。
- 文案用 `shell.*` 共享命名空间（`shell.fork`/`shell.forkArmed`/`shell.forkFailed`/`shell.bookmark`/`shell.bookmarked` 等），由 timeline 贡献（§七.4）。

### 3.3 message-actions.test.tsx：DOM 测试

`renderer/message-actions.test.tsx`（72 行）用 `@vitest-environment jsdom` + `@testing-library/react` 验证两个动作组件的渲染条件与点击行为。要点：

- `vi.hoisted` 预置 `invoke`/`forkFromSession`/`arm`/`disarm` 四个 mock，`vi.mock("@my-harness-desktop/react")` 把 `usePluginContext`/`useUiStore`/`useSessionStore`/`useArmConfirm` 全 mock 掉——只验证组件自身行为，不碰真实框架。
- `BookmarkAction` 两条：assistant 消息渲染按钮、点击 invoke `bookmarks:addRequested` 且 payload 含 `entryId`/`sessionPath`；非 assistant 返回 null（`toBeEmptyDOMElement`）。
- `ForkAction` 两条：assistant 消息渲染、首次点击进入武装确认（`arm(true)` 且 `forkFromSession` 未被调）；非 assistant 返回 null。

这个测试的存在本身就是「fork/收藏统一迁入 session-bookmarks」的验收证据（对齐 `bookmark-snapshot-fork-unify.md §6` 的 DOM 测试项）。它没测 `BookmarksTab` 主组件（那需要更多 mock，当前留白），但覆盖了两个 messageActions 的渲染/交互核心。

## 四、圆心：快照模型与中立坐标

### 4.1 bookmark-snapshot.ts：快照的纯函数地基

`packages/shared/src/domain/bookmark-snapshot.ts`（93 行）是「收藏 = 在某节点插点」的圆心纯函数 + 快照文件格式。零依赖（只 import 圆心内部的 `kernel.ts`/`session-neutral.ts`），文件头注释点明它是 `docs/design/bookmark-snapshot-fork-unify.md §2/§3` 的地基，且是对「坐标书签去 opaque」终态（`session-neutral-layer.md §12`）的一次定向反转：从「存坐标、发起时现场 fork」回到「存物化快照、发起时同步快照」。

**`BOOKMARK_SNAPSHOT_VERSION = 1`**：快照格式版本。向后不兼容的字段变更时递增；`parseBookmarkSnapshot` 读旧版本显式抛错，不静默降级——这是「显式降级、不静默吞」纪律在序列化层的落地。

**`BookmarkSnapshot` 接口**：一条自包含的 lineage 前缀（物化拷贝）。逐字段语义：

- `version`/`id`（`crypto.randomUUID()`，也是文件名 `<id>.json`）/`label`/`preview`/`createdAt`：id + 展示元数据，与 `BookmarkMeta` 一一对应。
- `sourceKernel: KernelId`：来源内核，**仅记录**（展示/默认投影参考），注释明说「不参与投影路由——投影走能力探测」。
- `sourceNeutralSessionId`：来源中立会话 id，**仅溯源**，「发起时不以它读源会话（快照自包含）」。
- `boundaryEntryId`：锚点，fork "at" 的 entry 中立 id（`{lineageId}:{seq}`），快照内容含此 entry。
- `lineage: { lineageId, entries: NeutralEntry[] }`：快照自身的 lineage id（物化后的新身份，与源 lineage 解耦）+ 完整前缀（含 boundary），发起时 seed 用。

**`MaterializedPrefix`**：`{ entries: NeutralEntry[], boundaryEntryId: string }`——`entries` 是完整前缀（含锚点）、`boundaryEntryId` 是锚点的中立坐标（`neutralEntryId`，`{lineageId}:{seq}`），fork "at" 的落点。

**`materializeLineagePrefix(session, lineageId, anchorId): MaterializedPrefix | null`**：物化一条 lineage 到锚点为止的完整前缀。核心逻辑：

1. `lineageContent(session, lineageId)` 沿 fork 链现算完整线性内容（复用 `session-neutral.ts` 的 `lineageContent`）。
2. `content.findIndex((e) => e.kernelEntryId === anchorId || e.neutralEntryId === anchorId)` 定位锚点——`anchorId` 是渲染层给的节点 id，实际是 `kernelEntryId`（JSONL 行级 id，经 `NeutralMessage.id` 透出），同时兼容 `neutralEntryId`（调用方若已持有中立坐标）。
3. `idx < 0` 返回 null——**锚点不在内容里（数据损坏/压缩已移除），调用方显式降级，不静默把「整条 lineage」当快照**（那会把锚点之后的条目也卷进快照，语义错误）。
4. 返回 `{ entries: content.slice(0, idx + 1), boundaryEntryId: content[idx].neutralEntryId }`——`boundaryEntryId` 恒为 `neutralEntryId`（快照锚点要跨内核稳定，不存内核私有 id）。

**`serializeBookmarkSnapshot` / `parseBookmarkSnapshot`**：序列化/反序列化。`serialize` 用 `JSON.stringify(snapshot, null, 2)`（字段名即文件格式契约，不改键名）；`parse` 先校验 `version`（不符抛「快照版本不兼容」），再校验 `id` 是 string、`lineage.entries` 是数组（不符抛「快照结构损坏」）。

### 4.2 session-neutral.ts：中立坐标体系

`bookmark-snapshot.ts` 依赖的中立坐标全部来自 `packages/shared/src/domain/session-neutral.ts`（296 行，零依赖，只 import domain 内部）。本插件直接/间接依赖的关键类型与纯函数：

- **`NeutralAnchor`**（19–24 行）：`{ lineageId, entryId }`，完全内核无关的会话树坐标，替代旧的 `Anchor.opaque` 私有 token。`backend.ts` 里 `Anchor = NeutralAnchor` 是它的 re-export（契约单源）。
- **`NeutralEntry`**（62–72 行）：`{ neutralEntryId, kernelEntryId?, message: NeutralMessage, display? }`。`neutralEntryId` 是中立 entry id（`{lineageId}:{seq}`，跨内核稳定），`kernelEntryId?` 是内核私有 entry id（投影时的 opaque 线索，仅 adapter 用，不进中立契约对外面）。快照 `lineage.entries` 存的就是 `NeutralEntry[]`。
- **`NeutralSession`/`NeutralLineage`**（27–60 行）：中立会话树。`NeutralLineage = { lineageId, fork: {parentLineageId, boundaryEntryId} | null, entries: NeutralEntry[] }`——注意 `fork.boundaryEntryId` 是中立的 `neutralEntryId`，不是内核私有 boundary。
- **`neutralEntryId(lineageId, seq)`**（91–93 行）：`{lineageId}:{seq}`，seq 是条目在所属 lineage 内的 0-based 序号。`materializeLineagePrefix` 返回的 `boundaryEntryId` 就是这个形态。
- **`lineageContent(session, lineageId)`**（277–295 行）：一条 lineage 的完整线性内容——沿 fork 链向上取父 lineage 到分叉点为止的前缀（boundary 是「含端点的继承前缀」），再拼自身独有条目。root lineage 就是自己的 entries。带防御：父引用悬空当根处理、环 visited 停不无限递归。这是 `materializeLineagePrefix` 的地基，也是 seed 投影/切分支投影共用。
- **`sortLineagesTopologically`/`resolveForkBoundaries`**（106–148 行）：seed 投影的前置（拓扑排序保证父 lineage 先写、边界归一反查）。收藏快照本身是单条自包含 lineage（`entries` 已物化完整前缀），发起时 `resume` 把它灌成一条 `fork: null` 的根 lineage，所以收藏路径**不直接依赖**这两个函数——但它们在中立层的 seed/switchKernel 路径里同源使用。

要点：快照的 `entries` 是**物化拷贝**，不是 `NeutralLineage.fork` 指针。这就是「收藏」与「fork」的差异在数据层的体现——fork 存 `fork: {parent, boundary}` 指针 + `entries: []`（惰性共享父前缀），收藏存 `entries: 完整前缀拷贝`（自包含、源删了也能发起）。

### 4.3 backend.ts：bookmark/resume/seed 契约

`packages/shared/src/domain/backend.ts`（338 行）是中立契约所在。本插件经由 `ctx.sessions` 间接触达它，但理解后端语义对读懂发起流程不可或缺：

- **`Anchor = NeutralAnchor`**（52 行）：`backend.ts` 不再定义自己的 Anchor，而是 re-export `session-neutral.ts` 的 `NeutralAnchor`——契约单源（`bookmark-snapshot-fork-unify.md §6.5` 说「快照是收藏唯一真相源，坐标 Anchor 退场」）。
- **`BaseBackend.bookmark(lineageId, boundary): Promise<Anchor>`**（97 行）：把分叉点持久化成可重启锚点。注意：这是**旧坐标书签契约**的残留——新快照模型下，收藏的快照物化不走 `backend.bookmark`，改由 `session-store` 读中立层 + `BookmarkSnapshotStore` 写文件。`backend.bookmark` 在 pi 侧仍实现（`PiBackend`），但 `session-bookmarks` 插件的收藏路径已不经过它。
- **`BaseBackend.resume?(anchor)`**（101 行）：可缺面（dsh 服务端回切、pi 无此面）。同样是旧坐标书签的发起面，新快照模型的 `resume` 由 `session-store` 编排（读快照 → seed → fork），不直接调 `backend.resume`。
- **`BaseBackend.deleteBookmark(anchor)`**（109 行）：旧契约删锚点。新模型的删除走 `session-store.deleteBookmark(snapshotId)` → `BookmarkSnapshotStore.delete`。
- **`BaseBackend.seed(lineage, opts): Promise<string>`**（131 行）：seed 单线投影——把「活跃 lineage 的完整线性内容」物化到内核，返回内核侧会话标识。**这是发起收藏的核心依赖**：快照 `entries` 经 seed 投到目标内核。
- **`BackendFactory.seed?`**（255 行）：预 seed，在 spawn 前产出目标内核会话标识。pi 是纯文件写（先 seed 得路径再 spawn），dsh 是 RPC 依赖进程（返回 null 走 create → start → backend.seed）。生命周期不对称在这里显式成契约。
- **`SessionCatalog.bookmark(cwd, lineageId, boundary): Anchor`**（317 行）/`deleteBookmark(anchor): void`（320 行）：目录/CRUD 面的旧坐标书签面，同步（pi 是 copyFileSync/rmSync）。新快照模型不经过它——`session-store` 直接持 `BookmarkSnapshotStore`（应用层自己的文件 CRUD），绕过 `SessionCatalog`。

这一节的核心结论：**新快照模型把收藏从「内核契约面（backend.bookmark/resume/deleteBookmark + catalog.bookmark/deleteBookmark）」整体上移到了「壳应用层的 `BookmarkSnapshotStore` + 中立层 `materializeLineagePrefix`」**。内核的 `bookmark`/`resume`/`deleteBookmark` 仍是 `BaseBackend`/`SessionCatalog` 的成员（兼容旧路径与 pi/dsh 各自的实现），但 `session-bookmarks` 插件走的快照路径不再依赖它们。这是「收藏是壳自己的数据、不读内核存储」这条不变量（CLAUDE.md §7.5 不变量 #1）在收藏场景的精确落地——快照是中立的 `NeutralEntry[]`，发起时经既有 seed 投影投到任意内核。

## 五、壳后端：快照存储与用例编排

### 5.1 bookmark-snapshot-store.ts：纯文件 CRUD

`src/server/application/sessions/bookmark-snapshot-store.ts`（58 行）是收藏快照的持久化存储。文件头注释定死边界：壳自己的快照存储、不读内核存储、纯文件 CRUD（整读整写，快照规模小）、不依赖内核、不 import client、镜像 `NeutralSessionStore` 的形状。

- `constructor(private readonly dir: string)`：目录（bookmarks 目录）由调用方按项目注入——路径注入纪律（CLAUDE.md §4.6/§9.3），store 不自己拼 `process.cwd()`。
- `filePath(id)`：`join(dir, id + ".json")`。
- `get(id)`：不存在返回 null；`readFileSync` + `parseBookmarkSnapshot`，catch 返回 null（调用方显式降级）。版本不符/损坏都收敛成 null。
- `list()`：`readdirSync` 枚举 `.json`，逐个 `parseBookmarkSnapshot`，损坏跳过不中断枚举（孤儿对账用）。
- `put(snapshot)`：`mkdirSync(recursive)` + `writeFileSync(serializeBookmarkSnapshot)`，整文件覆盖。
- `delete(id)`：`existsSync` 才 `rmSync`。

这个类**不 import `@my-harness-desktop/shared` 之外任何项目内部模块**（只 import node:fs/node:path 和 shared），是应用层里最「瘦」的存储类——它只懂「快照文件怎么读写」，不懂「快照怎么物化、怎么 seed 投影」，后者在 `session-store` 和圆心。

### 5.2 session-store.ts：bookmark/resume/deleteBookmark

`session-store.ts`（1985 行）是会话管理的用例编排核心。收藏相关的三处关键：构造注入、`bookmark`、`resume`、`deleteBookmark`。

**构造注入（198–219 行）**：`bookmarkDir: ((cwd: string) => string) | null`（收藏快照目录解析器，null = 快照收藏未启用）+ `bookmarkStores = new Map<string, BookmarkSnapshotStore>()`（懒缓存，cwd → store）。`bookmarkDir` 由 `bootstrap` 组装时注入（`() => join(cwd, ".my-harness-desktop", "bookmarks")` 之类），`bookmarkStoreFor(cwd)` 按 cwd 懒建并缓存 `BookmarkSnapshotStore`——`bookmarkDir` 变化时缓存项随 cwd 隔离。

**`bookmark(sessionPath, entryId, id, label, preview): Promise<BookmarkSnapshot>`**（770–796 行）：

1. 校验 `activeCwd`/`neutralStore`/`bookmarkStoreFor(cwd)` 非空，逐条抛中文错误（「无激活 cwd,无法收藏」等）。
2. `neutralSessionIdFromPath(sessionPath)` 反查中立会话 id；`neutralStore.get(ns)` 读源会话中立树，不存在抛「源会话中立树不存在」。
3. **活跃 lineage 判定**（781–782 行）：`const proc = this.activeProc(); const lineageId = proc?.activeLineageId ?? (session.lineages.find((l) => l.fork === null)?.lineageId ?? ns);`——有活跃进程取活跃 lineage（当前进程活跃分支优先），无进程回退根 lineage。这是锚点所在线性历史的确定。
4. `materializeLineagePrefix(session, lineageId, entryId)` 物化前缀，null 抛「收藏锚点不在会话内容里(可能已被压缩移除)」。
5. 组装 `BookmarkSnapshot`（`sourceKernel: session.header.kernel`、`sourceNeutralSessionId: ns`、`boundaryEntryId: prefix.boundaryEntryId`、`lineage: { lineageId, entries: prefix.entries }`），`store.put(snapshot)` 写文件，返回快照。

注意 id/label/preview 由渲染层传入并持久化——session-store 只物化前缀、只持久化，不生成文案、不生成 id（id 是渲染层 `crypto.randomUUID()`，沿用其 `pendingCreateRef` 豁免逻辑）。这是「构造与执行分开」+「内容归插件」的体现：文案是内容归渲染层，物化是机制归应用层。

**`resume(snapshotId): Promise<string>`**（801–831 行）：发起收藏，是最能体现「多内核默认」的方法：

1. 校验 cwd/neutralStore/store 非空。
2. `store.get(snapshotId)` 读快照，不存在抛「快照不存在或已损坏」。
3. **目标内核**（810 行）：`const kernel = this.activeKernel ?? snap.sourceKernel;`——当前激活内核优先，无激活内核（仅浏览历史）回退快照来源内核。**这里不写 `if (kernel === "pi")`**，目标内核只是 seed 投影的一个入参。
4. `await this.start(cwd, undefined, undefined, true, kernel, undefined, undefined)` 起一个**空的新会话**（新 neutralSessionId）——`start` 签名是 `start(cwd, sessionPath?, role?, skipResolve = false, kernel?, provider?, model?)`，第四参 `true` 是 `skipResolve`（跳过把持久化会话载入新进程的 resolve，因为要灌快照内容、不 resolve 源会话），第五参 `kernel` 指定目标内核。之后再灌快照内容 + 惰性 seed 投影。
5. **重投影**（816–822 行）：`newLineageId = randomUUID()`；`snap.lineage.entries.map((e, i) => ({...e, neutralEntryId: neutralEntryId(newLineageId, i), kernelEntryId: undefined, message: {...e.message, id: undefined}}))`——neutralEntryId 重派生到新 lineage（0-based seq），清 kernelEntryId/message.id（目标内核重分配私有 id）。
6. `neutralStore.put({ ...cur, lineages: [{ lineageId: newLineageId, fork: null, entries }] })`——把快照前缀灌成一条 `fork: null` 的根 lineage。
7. `proc.activeLineageId = newLineageId; proc.materializedLineageId = "";`——强制 seed 快照内容（把 materialized 标记置空，让下一次 `materializeActiveLineage` 认为「未物化」）。
8. `await this.materializeActiveLineage(proc)`——真正把快照前缀 seed 投影到目标内核。
9. 返回新会话路径（`activeSessionPath ?? boundSessionPath ?? backend.sessionId ?? newLineageId`）。

**`deleteBookmark(snapshotId)`**（834–838 行）：`bookmarkStoreFor(cwd)?.delete(snapshotId)`。元数据删除由渲染层负责（`renderer/index.tsx` 的 `deleteBookmark` 先删 config 元数据再调这里删快照文件）。

### 5.3 materializeActiveLineage 与 forkFromSession

发起收藏最终落到 `materializeActiveLineage`（1552–1591 行），它是「惰性物化」的实现——换分支 = 换投影：

- `if (proc.materializedLineageId === proc.activeLineageId) return;` 幂等早退。
- `lineageContent(session, proc.activeLineageId)` 现算活跃 lineage 的完整线性内容。
- `proc.backend.stop()` 停旧后端。
- 组装 `seedOpts`（kernel/cwd/agentDir/neutralSessionId/lineageId/header）。
- **分内核 seed**（1562–1585 行）：`const seedFn = this.factory.seed; const seeded = seedFn ? await seedFn(lineage, seedOpts) : null;`——有预 seed（pi 纯文件写）先 seed 得路径再 `factory.create`+`start`；无预 seed（dsh RPC）先 create+start 再 `backend.seed(lineage, seedOpts)`（空 lineage 跳过）。**能力探测分流，不写 `if (kernel === "pi")`**——pi/dsh 的差异由 `factory.seed` 返回 null 与否体现，`materializeActiveLineage` 本身只认「seedFn 有没有、返回值 null 与否」。
- `proc.backend = newBackend; proc.boundSessionPath = newBackend.capabilities.pi ? newSessionId : null;`——注意这里 `newBackend.capabilities.pi` 是**能力探测**（pi 有 capabilities.pi，dsh 没有），不是内核身份硬分支。
- `bindProcEvents(proc); proc.materializedLineageId = proc.activeLineageId;`

`forkFromSession`（1601–1617 行）是 `ForkAction` 的后端落地（经 `ctx.pi.forkFromSession` → `PiExtensions.forkFromSession`）：在源会话中立树切一条新 lineage（`upsertNeutralLineage` 插 `fork: {parentLineageId: rootLineageId, boundaryEntryId: entryId}` + `entries: []`），设 `proc.neutralSessionId = srcNs; proc.activeLineageId = newLineageId`，惰性物化（分支只在下次 send 时 seed）。这就是「fork 与收藏同源」在后端的对照：fork 存 fork 指针 + 空 entries（惰性共享），收藏存物化 entries（快照自包含），两者都经 `materializeActiveLineage` seed 投影。

### 5.4 网关 handler 与 headerChanged 广播

`src/server/controllers/sessions.ts`（102–112 行）是 IPC 网关 handler：

- `IPC.sessions.bookmark` → `sessionStore.bookmark(...)` + `notifyHeaderChanged({ kind: "bookmark", sessionPath })`。
- `IPC.sessions.resume` → `sessionStore.resume(snapshotId)`。
- `IPC.sessions.deleteBookmark` → `sessionStore.deleteBookmark(snapshotId)` + `notifyHeaderChanged({ kind: "deleteBookmark", snapshotId })`。

`notifyHeaderChanged` 是列表行变更广播——收藏创建/删除会推 `headerChanged` 事件，驱动会话列表等端重拉。注意 resume 不广播（发起是新会话的 start 流程，由 `sessionStart` 事件驱动）。

## 六、通道桥接链路

收藏能力从 renderer 到内核会话的完整桥接链路，本插件只触碰 renderer 一侧，但把整条链读通才能定位 bug：

**renderer → window.kernel**：`usePluginContext()`（`packages/react/src/plugin-context.ts`）构造 `SessionsApi`/`PiExtensions`。`SessionsApi.bookmark/resume/deleteBookmark`（84–87 行）与 `PiExtensions.forkFromSession`（47 行）分别桥接到 `window.kernel.sessions.bookmark/resume/deleteBookmark` 与 `window.kernel.sessions.pi.forkFromSession`。

**window.kernel → transport**：`src/web/kernel/build-kernel.ts`（345–347 行、424–425 行）把这些方法桥接成 `transport.invoke(IPC.sessions.bookmark, sessionPath, entryId, id, label, preview)`、`IPC.sessions.resume`、`IPC.sessions.deleteBookmark`、`IPC.session.copySession` 等 HTTP/WS 调用。

**transport → gateway handler**：`src/server/controllers/sessions.ts` 的 `gateway.register(IPC.sessions.bookmark, ...)` 等把 IPC 通道绑到 `sessionStore` 方法。

**sessionStore → 圆心 → 内核**：`bookmark` 调 `materializeLineagePrefix`（圆心纯函数）→ `BookmarkSnapshotStore.put`（应用层文件写）；`resume` 调 `BookmarkSnapshotStore.get` → `materializeActiveLineage` → `BackendFactory.seed`/`Backend.seed`（内核投影）。

这条链的纪律是：**每一层只依赖下一层的抽象**。renderer 依赖 `SessionsApi`（圆心契约），`build-kernel` 依赖 `transport.invoke`（传输），controller 依赖 `sessionStore`（应用层），sessionStore 依赖 `BaseBackend`/`BackendFactory`/`BookmarkSnapshotStore`（圆心 + 应用层），内核实现归 `src/server/kernel/{pi,dsh}`。没有一层 import 具体内核实现（application 对 kernel 的 import 是 type-only 的 `PiBackendExtensions` 类型，见 `session-store.ts` 第 17 行）。

## 七、与其他插件交互（专节）

本插件的全部跨插件协作都走事件总线（`ctx.events.emit/on/invoke`），不通过共享 store 互读写、不通过 `window.kernel` 直调对方能力——这是 CLAUDE.md §8.2 的唯一合法通道。本插件涉及的交互有四条线。

### 7.1 与 session-tree：`session-tree:bookmarkRequested`

session-tree（`src/plugins/sessions/session-tree/`）在树行 hover 时提供 fork/收藏按钮（`renderer/index.tsx` 305–312 行的 `Bookmark` 按钮，仅挂 `entryType === "assistant"` 的节点）。点收藏按钮 → 行内 `InlineConfirmInput`（`defaultValue = sessionName ?? (n.label ?? n.preview ?? n.entryId.slice(0,8))`）让用户原位输入收藏名 → 确认后：

```
ctx.events.emit("session-tree:bookmarkRequested", {
  sessionPath: currentSessionPath,
  entryId: n.entryId,
  preview: n.label ?? n.preview ?? n.entryId.slice(0, 8),
  label,   // 原位输入的终值
});
```

关键点：

- **channel 归属**：`session-tree:bookmarkRequested` 由 session-tree 在 `renderer/index.tsx` 顶部 `export const channels = ["session-tree:bookmarkRequested"]` 声明并拥有，故它用 `emit`（emit 校验 channel 在自己 channels export 里声明过，`event-bus.ts` 116–118 行）。
- **本插件订阅**：`BookmarksTab` 的 `ctx.events.on("session-tree:bookmarkRequested", handler(false))`——`editAfter=false`，因为树行来源已原位输入完 label，创建后**静默**（不进入改标题态）。
- **dependsOn 对齐**：本插件 `dependsOn` 含 `session-tree`，因为本插件消费（on）session-tree 声明的 channel。session-tree 自身不 dependsOn 本插件——它 emit 的是自己声明的 channel，不依赖本插件存在（emit 到零订阅者是合法 no-op）。
- **原语不对称（事实记录）**：session-tree 用 `emit`（发布/订阅，无排队），本插件对 timeline 来源用 `invoke`（有排队）。`emit` 只同步调当前已挂载的 handler——若 BookmarksTab 恰好未挂载（用户在 tree 页、收藏 tab 关闭），emit 到零 handler、请求丢失。这与 timeline 一击收藏的 `invoke` 语义不同（invoke 无订阅者时入队、首个订阅者挂载时冲刷恰好一次）。这是两个来源当前的原语差异，属 session-tree 侧既有实现，本文只记录事实、不替 session-tree 定论是否该改成 invoke。

### 7.2 与 timeline：messageActions 收藏/分叉按钮

timeline（`src/plugins/sessions/timeline/`）是 messageActions 槽的**消费方**。这是「与其他插件交互」里最体现「槽位填槽」的一条线：

- **消费方不认贡献方**：timeline 的 `MessageActions` 组件（`timeline/renderer/index.tsx` 1425–1445 行）用 `useMessageActions()`（`packages/react/src/message-actions.ts`，读 `window.kernel.slots.messageActions()` 拿全部贡献项 + pluginId）拉槽清单，`slotActions.filter((a) => !a.when?.role || a.when.role.includes(message.role))` 按 role 过滤，`resolveMessageActionComponent(action.pluginId, action.component)` 从对应插件的 module exports 取组件，`<Comp message={message} text={text} />` 渲染。
- **timeline 让渡了 fork/收藏**：`timeline/plugin.json` 的 `contributes.messageActions` 现在只剩 `copy`（order 10）和 `rewind`（order 10, right, user）——fork/bookmark 已迁出。timeline 的 `MessageActions` 里，本插件贡献的 `fork`（order 18）/`bookmark`（order 20）与 timeline 自己的 `copy`（order 10）按 order 排序混排，`when.role: ["assistant"]` 让它们在 assistant 消息下才出现。
- **组件自动匹配**：本插件 `renderer/index.tsx` 第 10 行 `export { BookmarkAction, ForkAction } from "./message-actions"` 把两个组件 re-export 到入口，框架按 manifest `component: "ForkAction"`/`"BookmarkAction"` 在 exports 里找到——这是 CLAUDE.md §7.4 自动匹配的落地。
- **`shell.*` 共享文案命名空间**：`BookmarkAction`/`ForkAction` 用的 `t("shell.bookmark")`/`t("shell.fork")`/`t("shell.bookmarkNode")` 等 key，是 timeline 贡献的 `languages` 里 `timeline.shell`（或 session-tree 的 `session-tree.shell`）namespace 提供的。本插件自己的文案走 `session-bookmarks.bookmarks` namespace，跨插件共享的动作按钮文案走 `shell.*`——这是「消费方提供共享文案、贡献方引用」的分工。
- **dependsOn 对齐**：本插件 `dependsOn` 含 `timeline`，因为 `ForkAction` 里 `ctx.events.invoke("timeline:scrollTo", ...)`（发起收藏后滚到锚点）与 `BookmarkAction` 的 messageActions 渲染都依赖 timeline。`timeline:scrollTo` 是 timeline 声明的 channel，本插件用 invoke（定向分派，不拥有该 channel，无订阅者时入队）。

### 7.3 与右面板框架：`revealOn` 声明式揭示

`revealOn` 是本插件与壳框架（右面板）的交互，体现「触发方不认识贡献者、贡献者代码不出现自己的 contribution id」的居中撮合（`bookmark-snapshot-fork-unify.md` 与 CLAUDE.md §7.3）：

- **声明**：`plugin.json` 的 sidePanel 贡献 `revealOn: "bookmarks:addRequested"`。
- **框架侦听**：`src/web/components/right-panel.tsx` 116–130 行，`useEffect` 里遍历 items 建 `Map<channel, tabId>`，然后 `eventBus.tap((channel) => { const tabId = byChannel.get(channel); if (tabId) activateSidePanelTab(tabId); })`。`eventBus.tap`（`event-bus.ts` 40–43 行）是框架内部侦听，**在每次 emit/invoke 派发前同步触发**（`fireTaps`，45–53 行）——所以无论 emit 还是 invoke，只要命中 `revealOn` 的 channel，就会触发揭示。
- **揭示动作**：`activateSidePanelTab(tabId)`（`ui-store.ts` 190 行，`useUiStore` 的揭示语义）幂等激活该 Tab 并展开右面板——「与 toggle 的区别是不做反向关闭」。
- **拼起来的完整时序**（timeline 一击收藏）：用户点 `BookmarkAction` → `ctx.events.invoke("bookmarks:addRequested", payload)` → `fireTaps` 同步触发右面板 tap → `activateSidePanelTab("bookmarks")` 揭示 BookmarksTab → BookmarksTab 挂载 → `ctx.events.on("bookmarks:addRequested", handler(true))` 订阅时 `pendingInvokes` 冲刷恰好一次投递 payload → `createBookmark` 创建并 `setEditingId(id)` 进入改标题。这一整条链用「invoke 入队 + tap 揭示 + 订阅冲刷」把「未挂载的 tab」与「一次性命令」精确接上，全程不 sleep、不靠 replayLast 误重放（`event-bus.ts` 注释明说「invoke 是一次性命令,不是可回放的状态」）。

### 7.4 与 i18n 框架：语言包合并

本插件通过 `contributes.languages` 贡献 `session-bookmarks.bookmarks` namespace 的 4 个语言包，框架启动时合并进 i18next resources，渲染时 `t("bookmarks.xxx")` 查。`shell.*` 共享 key 由 timeline/session-tree 贡献，本插件跨插件引用——这要求 `dependsOn` 里声明依赖方（timeline/session-tree），否则 i18n 合并顺序无保证时 `t("shell.fork")` 可能拿到 key 本身。i18n 是「内容外挂」的机制面：壳只做合并与 `t()` 查询，文案值全在插件 locales。

## 八、两条端到端数据流

### 8.1 收藏流（一击收藏 / 树行收藏 / 手动添加）

以 timeline 一击收藏为主线：

1. `BookmarkAction` 守卫通过（assistant + id + currentNeutralSessionId）→ 算默认 label（`sessionName ?? preview`）→ `ctx.events.invoke("bookmarks:addRequested", { sessionPath, entryId, preview, label })` + 本地 `done` 瞬时反馈。
2. `fireTaps` 同步 → 右面板 tap → `activateSidePanelTab("bookmarks")` 揭示 BookmarksTab（若未挂载）。
3. BookmarksTab 挂载 → `on("bookmarks:addRequested", handler(true))` 订阅 → `pendingInvokes` 冲刷恰好一次 → `handler(true)` 校验 label 非空 → `createBookmark(req, label)`。
4. `createBookmark`：`crypto.randomUUID()` 生成 id → `pendingCreateRef.add(id)` → `ctx.sessions.bookmark(sessionPath, entryId, id, label, preview)`。
5. `build-kernel` 桥接 → `IPC.sessions.bookmark` → controller → `sessionStore.bookmark`：`neutralSessionIdFromPath` 反查 ns → `neutralStore.get(ns)` 读中立树 → 定活跃 lineage → `materializeLineagePrefix` 物化前缀（`kernelEntryId` 定位、截到锚点含、返回 `boundaryEntryId` 为中立坐标）→ 组装 `BookmarkSnapshot` → `BookmarkSnapshotStore.put` 写 `<cwd>/.my-harness-desktop/bookmarks/<id>.json` → 返回快照 → `notifyHeaderChanged({kind:"bookmark"})`。
6. 回到 renderer：`config.get("bookmarks")` → push meta → `config.set` 写元数据 → `loadBookmarks()` → `finally` 撤 `pendingCreateRef`。
7. `handler(true)` 里 `editAfter && id` → `setEditingId(id)` 进入原位改标题。

树行收藏的差异只在第 1–3 步：session-tree 行内 `InlineConfirmInput` 原位输入 label → `emit("session-tree:bookmarkRequested", ...)` → 本插件 `on(..., handler(false))` 静默创建（不进入改标题）。手动添加走 `AddForm`：`onResolve` 校验（openSession 存在 + entryId 存在 + role=assistant）→ `onSubmit` 调 `createBookmark`。

### 8.2 发起流（fork from bookmark）

1. 用户点击收藏行（`bm.exists && forking !== bm.id && deleteTarget?.id !== bm.id`）→ `forkFromBookmark(bm)`。
2. `ctx.sessions.resume(bm.id)` → `IPC.sessions.resume` → controller → `sessionStore.resume(snapshotId)`。
3. `BookmarkSnapshotStore.get(snapshotId)` 读快照 → 不存在抛「快照不存在或已损坏」。
4. `kernel = activeKernel ?? snap.sourceKernel` 定目标内核 → `start` 起空新会话 → 重投影（新 lineageId + 重派 neutralEntryId + 清 kernelEntryId/message.id）→ `neutralStore.put` 灌成根 lineage → `materializedLineageId = ""` 强制 seed → `materializeActiveLineage` seed 投影（`factory.seed` 有则先 seed 后 start、无则先 start 后 `backend.seed`，能力探测不分内核）→ 返回新会话路径。
5. 回到 renderer：`ctx.events.invoke("timeline:scrollTo", { messageId: bm.entryId })` 让 timeline 滚到锚点消息 → toast `bookmarks.forkCreated`。

发起流的关键不变量：**快照自包含**——第 3 步读的是快照文件、不是源会话，源会话被删/压缩后发起仍成功（`bookmark-snapshot-fork-unify.md` 的核心动机）。`sourceNeutralSessionId` 只溯源不读源；`sourceKernel` 只作默认投影参考不参与路由。

## 九、设计纪律对照

把本插件放进 CLAUDE.md 的纪律框架里对照，逐条落地：

- **依赖只向内**（§1.1）：`renderer/` 只 import `@my-harness-desktop/shared`/`@my-harness-desktop/react`，无任何 `@/server`/`@/web`/`@/core` 越层 import。快照物化纯函数在圆心（`bookmark-snapshot.ts`），物理上 import 不了 node:fs/electron。
- **机制与内容分离**（§1.2）：本插件是内容层——文案在 locales、渲染逻辑在 renderer、业务分支（「role 必须是 assistant」「label 默认会话名」）在插件内。壳后端只提供「物化前缀、写快照、seed 投影」的机制。
- **契约单源**（§1.3）：`BookmarkSnapshot`/`MaterializedPrefix`/`materializeLineagePrefix`/`NeutralAnchor`/`neutralEntryId`/`lineageContent` 只在圆心定义一次，renderer 经 `@my-harness-desktop/shared` 引用，无本地副本。`cwdToBucketName` 是「cwd 分桶」唯一源，迁移时引用而非重写。
- **无特权差异**（§1.4）：本插件是 official 壳插件，无任何「识别内置」路径；删掉它壳照常启动，只少收藏/分叉 UI。
- **多内核默认**（§1.5）：发起收藏的 seed 投影不分内核硬分支（`materializeActiveLineage` 认 `factory.seed` 返回 null 与否、`capabilities.pi` 能力探测），渲染层 `ctx.sessions.resume` 不写 `if (kernel === "pi")`。`ForkAction` 走 `ctx.pi.forkFromSession` 是 pi 扩展面，dsh 下在后端边界显式降级抛错、UI catch 报错——符合「有则用、无则降级」。
- **事件驱动**（§3.6）：跨插件交互全走事件（invoke 入队 + tap 揭示 + 订阅冲刷），无 sleep、无轮询。`BookmarkAction` 的 `setTimeout 1500ms` 只是瞬时反馈复位，不是时序赌注。
- **事件唯一通道**（§8.2）：本插件与 timeline/session-tree 的交互只走 `ctx.events.emit/on/invoke`，不读写对方 store。
- **根因修复**（§3.7）：`legacyMigrated` 哨兵解决「迁移无完成态」根因、`pendingCreateRef` 豁免解决「文件先落盘/元数据后写在途窗口」根因、`deleteBookmark` 解耦解决「元数据删除被副本删除失败绑架」根因——都是定位根因后的结构修，不是补丁。
- **路径注入**（§9.3）：`BookmarkSnapshotStore` 的 dir 由 `session-store.bookmarkDir` 注入、`bookmarkDir` 由 bootstrap 注入，应用层不读 `process.cwd()` 拼收藏目录。

## 十、QA

**Q：为什么收藏不用内核的 `backend.bookmark`（存坐标锚点），而要做成物化快照文件？**

因为坐标书签有「源会话被删/压缩后发起即失效」的硬伤——坐标只记 `{lineageId, entryId}`，发起时现场去源会话 fork，源会话没了就 fork 不了。快照把完整前缀 `NeutralEntry[]` 物化成自包含文件，发起时读快照而非源会话，源删了也能发起。这是 `bookmark-snapshot-fork-unify.md` 对 `session-neutral-layer.md §12` 去 opaque 终态的「定向反转」：从「存坐标、发起时现场 fork」回到「存物化快照、发起时同步快照」。代价是磁盘多一份前缀拷贝，换取自包含的可靠性。

**Q：`bookmark`（收藏）和 `resume`（发起）在 shell 里为什么一个「不同步内核」、一个「同步内核」？**

这是插点抽象的「同步时机」二分。收藏的语义是「先记着，以后再分叉」——所以 `session-store.bookmark` 只物化前缀写快照文件、`materializedLineageId` 不动、不起内核进程。发起的语义是「现在就从这分叉」——所以 `session-store.resume` 要 `start` 起空新会话、`materializeActiveLineage` 把快照前缀 seed 投影到目标内核。fork（`ForkAction`/`ctx.pi.forkFromSession`）则是第三种时机：立即在中立树切 lineage，但**惰性物化**（分支只在下次 send 时才 seed），比发起更轻。

**Q：快照文件路径为什么是 `<cwd>/.my-harness-desktop/bookmarks/`，而不是跟元数据一起放 config 目录？**

因为「快照是数据、不是配置」。元数据（id/label/preview/顺序）是配置语义，走统一通道 `ctx.config`（`<cwd>/.my-harness-desktop/config/session-bookmarks.json`，跟随项目、git 可追踪）；快照文件是数据语义，住项目级数据目录 `bookmarks/`。两者同 id 关联：元数据是轻量列表索引，快照是真相源（`bookmark-snapshot-fork-unify.md §6.5`）。目录名用英文 `bookmarks` 而非中文「收藏」是编码/跨平台安全的命名决策。

**Q：`BookmarkSnapshotStore.get` 返回 null 时（快照损坏/版本不符/不存在）会发生什么？**

`session-store.resume` 直接抛「快照不存在或已损坏」，renderer `forkFromBookmark` catch 后 `setForkError` 显示错误条（带重试/关闭）。这是显式降级——不静默伪造成功、不静默按新形状解析出错。`parseBookmarkSnapshot` 对版本不符抛「快照版本不兼容」，旧版本快照需要显式迁移，而非悄悄按新形状解析（`bookmark-snapshot.ts` 注释）。

**Q：`materializeLineagePrefix` 里 `anchorId` 为什么同时兼容 `kernelEntryId` 和 `neutralEntryId`？**

因为调用方可能持有两种 id。渲染层给的节点 id（timeline 消息 id / session-tree 的 `TreeNode.entryId`）实际是 `kernelEntryId`（JSONL 行级 id，经 `NeutralMessage.id` 透出）；但若调用方已持有中立坐标（如某些已中性化的路径），给的是 `neutralEntryId`。`findIndex((e) => e.kernelEntryId === anchorId || e.neutralEntryId === anchorId)` 两个都试，最终返回的 `boundaryEntryId` 恒为 `neutralEntryId`——快照锚点要跨内核稳定，不能存内核私有 id。

**Q：孤儿对账为什么用 `pendingCreateRef` 豁免而不是 mtime 阈值？**

因为 `fs:listDir` 通道只返回 `{ name, isDir }`、不携带 mtime。为对账给内核契约加字段违背「单文件原则」（`bookmark-copy-lifecycle.md §2.4`）。`pendingCreateRef` 豁免语义等价——只豁免创建窗口内（文件已落盘、元数据未落盘）的在途文件，不依赖时钟。两个方案的差异只在「依赖通道字段」vs「依赖内存状态」，后者不扩契约。

**Q：发起收藏时目标内核怎么定，会不会出现「pi 的快照投给 dsh」的错配？**

目标内核是 `activeKernel ?? snap.sourceKernel`——当前激活内核优先，无激活内核回退快照来源内核。快照本身是中立 `NeutralEntry[]`，与内核无关，seed 投影（pi 文件 seed / dsh RPC seed）由 `materializeActiveLineage` 按 `factory.seed` 返回 null 与否分流，不按内核身份硬分支。所以「pi 快照投 dsh」是合法且被支持的路径——快照的 `sourceKernel` 只是默认投影参考，不参与路由。这正是「desktop 同步到 pi、同步到 dsh 是必须实现的功能」的落地。

**Q：`ForkAction`（立即分叉）和收藏发起（`resume`）都是「开新分支」，为什么不合并成一条路径？**

它们同源（插点）但时机与数据载体不同：`ForkAction` 走 `ctx.pi.forkFromSession`（pi 扩展面，中立树切空 lineage、惰性物化，立即从当前会话某节点分叉）；收藏发起走 `ctx.sessions.resume`（读快照自包含前缀、seed 到目标内核，可跨会话、可跨内核、可跨时间）。前者「现在就分叉当前会话」、后者「从记过的快照发起」。UI 上两个入口（messageActions 的 fork 按钮 + 收藏列表的点击发起）语义不同，不能合并。这也是 `bookmark-fork-at.md` QA 里「fork 按钮和收藏按钮不重复」的答案。
