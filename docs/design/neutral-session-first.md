# 中立会话层优先（neutral-first）：kernel 版本 canonical

> 本文是 `session-neutral-layer.md` 的**推进篇**。那篇确立了「中立会话坐标系」（中立会话身份 / 中立锚点 / 中立会话树 `NeutralSession` / 双向投影 / 映射表），但只把它当**跨内核切换时的快照载体**——中立层在 `switchKernel` 时才被 `snapshotNeutralSession` 写一次，平时是 stale 的；展示元数据（图等）更是根本没进中立层，落在 renderer 的 `imageIndex`（`session-images.json`，按 pi 文件路径做 key）里。
>
> 本文把方向钉死：**中立会话层（kernel 版本）是 canonical，AI 消息 + 展示元数据都归它维护；pi/dsh 只是 AI 投影，收到过滤掉展示层的纯消息；fork fork 的是 kernel 版本；kernel 版本 ↔ 内核投影之间做双向连续同步。**
>
> 一句话主线：**会话的真相源是 kernel 版本（中立层），pi/dsh 是它的投影；换内核 = 换投影，发消息 = 从中立层投影纯 AI 内容过去。**

## 目录

- **第一编 · 问题与目标**（§1–§3）：两个偏离、目标、核心原则
- **第二编 · 数据模型**（§4–§5）：展示元数据进中立层、展示类型
- **第三编 · 双向连续同步**（§6–§8）：上行 / 下行 / 一致性
- **第四编 · fork 走中立版本**（§9）
- **第五编 · 发送投影与过滤**（§10）
- **第六编 · 读取面**（§11）：renderer 从哪读、回放
- **第七编 · 迁移路径**（§12）
- **第八编 · 边界与反模式**（§13–§14）
- **第九编 · QA**（§15）

---

# 第一编 · 问题与目标

## §1 问题：两个偏离

`session-neutral-layer.md` 把坐标中立了，但**没有把「内容」的中立层做成 canonical**。今天有两个偏离：

### 偏离一：展示元数据没进中立层，落在按 pi 路径 key 的桌面数据里

图（以及未来的其它展示元数据）本该是「会话里的展示条目」。`sticker-plugin.md` §3 的原设计就是 `custom_message(customType:image)` 条目进会话文件，Q5 明说「fork/复制走文件，条目自然带上」。

但落地时被 **pi 的 sync 冲掉了**：`custom_message` 是桌面 append 进 pi 文件的条目，pi 底座内存不知道它，`sync` 的 `onSnapshot` 用底座快照覆盖 `messages` 就把 `role:image` 冲没了。于是退化成 `session-images.json`（`imageIndex`，按 pi 文件路径做 key），renderer 自己维护。

这个退化违反了两条纪律：

1. **壳不读内核存储**（`kernel-design-spec.md` §3.4 不变量 #1）：`imageIndex` 的 key 是 pi 文件路径，等于壳在按 pi 的存储形状维护数据。
2. **展示与 AI 内容耦合在错误的一侧**：图是「交流机制、不是 AI 输入」（`sticker-plugin.md` §1.2），却和 AI 消息一起被塞进 pi 文件 / 又被 pi sync 冲掉，逼出桌面侧那份按路径 key 的旁支存储。

### 偏离二：中立层只在 switch 时快照，不是 canonical

`NeutralSessionStore` 现在只被 `switchKernel` 里的 `snapshotNeutralSession` 写一次。平时会话在 pi/dsh 里跑，中立层是 stale 的。于是：

- **fork 不能 fork 中立版本**：`fork` 走的是 `backend.fork`（pi 切文件 / dsh 开分支），中立层不参与，fork 产物不是一条中立会话。
- **展示元数据没处放**：既然中立层不持续维护，图只能放 renderer 旁支（偏离一），fork 时得靠 `forkedFrom` 复制补丁——在错误模型上打补丁。
- **切内核要现场 snapshot**：`switchKernel` 每次都得「stop 旧 → 从旧内核投影 → seed 新」，而不是「中立层本来就是最新，直接投影切换」。

## §2 目标：kernel 版本 canonical

四件事：

1. **展示元数据进中立层**：`NeutralEntry` 增加展示字段（图等交流机制），`imageIndex`（`session-images.json`）整个拆除。
2. **中立层连续维护**：kernel 版本（`NeutralSession`）随会话进行**持续更新**，不是 switch 时一次性快照。
3. **fork fork 中立版本**：fork 在中立层切出新 lineage（新 `neutralSessionId` 或新 `NeutralLineage`），产物是一条完整中立会话，再投影到后端。
4. **发送过滤**：发消息 = 从中立层投影**纯 AI 内容**（过滤展示层）给 `backend.sendMessage`。

四件事合起来就是「中立层优先」：**中立层是会话的真相源，pi/dsh 是投影**。

## §3 核心原则

> **换内核 = 换投影实现；发消息 = 从中立层投影；fork = 切中立树。**

- 中立层（`core/application` 的 `NeutralSessionStore` + `session-store` 持有的中立树）是壳的业务本质。
- 投影（`client/{kernel}` 的 adapter）是会变的细节。
- 内核（pi/dsh）永远**看不到展示元数据**——它们只收 AI 内容，展示元数据在投影那一刻被过滤。

这落在一个已存在但没兑现的表述上（`session-neutral-layer.md` §7.2）：「`NeutralSession` 是壳的会话存储格式，内核的存储是这个中立树的投影，由 adapter 维护双向同步」。本文把这句话从「设计意图」变成「运行时不变量」。

---

# 第二编 · 数据模型

## §4 展示元数据进中立层

### 4.1 字段

`core/domain/session-neutral.ts` 的 `NeutralEntry` 增加展示字段：

```ts
/** 展示元数据：交流机制，不进 AI 投影。图/贴纸等归中立层维护，发送时过滤。 */
export interface DisplayMeta {
  /** 配图（IM 配图风格：图挂在 user 消息上方）。 */
  image?: { src: string; title?: string };
}

export interface NeutralEntry {
  neutralEntryId: string;
  kernelEntryId?: string;        // AI 投影线索（pi entry.id / dsh seq），仅 adapter 用
  message: NeutralMessage;       // AI 内容（会进投影）
  display?: DisplayMeta;         // 展示内容（不进投影，发送时过滤）
}
```

关键区分：

- `message` 是 **AI 内容**——会投影给 pi/dsh，会进上下文。
- `display` 是 **展示内容**——只给人看，永不进 pi/dsh，发送时过滤。

一张图可以同时是「AI 输入」（vision）和「展示内容」吗？不。本文的 `display.image` 特指**展示图**（贴纸 banner、用户配图）——它从来不是 AI 输入。真需要给模型喂图的 vision 场景，走 `sendMessage` 的 `images` 参数（`BaseBackend.sendMessage(text, images?)`），那是 AI 投影的一部分，和 `display.image` 是两条不相交的路径（§10 再讲）。历史上「图是交流机制、不是 AI 输入」这条（`sticker-plugin.md` §1.2）在这里显式成类型。

### 4.2 拆掉 `imageIndex`

`session-images.json`（`imageIndex`，按 pi 路径 key）整个删除。它的三处读写全部改走中立层：

| 现在（imageIndex） | 改后（中立层） |
|---|---|
| 发送带图 → `recordImage` 写 `imageIndex[path][hash]` | 发送带图 → `display.image` 挂到 user 的 `NeutralEntry` |
| `entryAppended` 水合出 id → `upgradeImageAnchor` 升级锚 | 不需要——图跟着 user 条目走，不靠 id/hash 二次查找 |
| 打开会话 → `buildImageIndexFromMessages` 从 role:image 建锚 | 中立层读回 `NeutralSession`，`display.image` 直接可用 |
| fork/clone → `copySessionImages(from,to)` 复制 | fork 走中立层（§9），`display` 自然带上 |

### 4.3 图文件本体

图文件仍存 `~/.my-harness-desktop/stickers/`（全局数据根，`sticker-plugin.md` §2.2），`display.image.src` 存逻辑路径。中立层只存**引用**，不存图文件本体。删会话/删贴纸不影响图文件（`sticker-plugin.md` Q3）；图文件被删则渲染层降级「图已丢失」，不崩（Q3/Q4）。

---

# 第三编 · 双向连续同步

这是「同步问题」的核心。两条方向都得流经中立层。

## §5 同步总图

```
用户发消息（text + display.image）
        │
        ▼
┌─────────────────────────────┐
│  kernel 版本（NeutralSession）│   ← canonical：AI 消息 + 展示元数据
│  NeutralSessionStore（main）  │
└──────────────┬──────────────┘
               │ 下行：投影纯 AI 内容（过滤 display）
               ▼
┌─────────────────────────────┐
│  内核投影（pi / dsh）         │   ← 只收 AI 内容
│  PiBackend / DshBackend      │
└──────────────┬──────────────┘
               │ 上行：事件流（entryAppended / messageEnd …）
               ▼
┌─────────────────────────────┐
│  kernel 版本（NeutralSession）│   ← 增量 append AI 生成的内容
└─────────────────────────────┘
```

## §6 下行：发送 = 从中立层投影

发送一条用户消息的完整序列：

1. **中立层先写**：`NeutralSessionStore` 在当前活跃 lineage 追加一条 user `NeutralEntry`（`message` = 文本，`display` = 可选图）。
2. **投影纯 AI 内容**：从中立层当前 lineage 的 entries 里取 `message`（**跳过 `display`**），得到要发给后端的 `NeutralMessage[]` / `text`。
3. **调后端**：`backend.sendMessage(text, images?)`——`text` 是文本，`images` 只在真 vision 场景传（那是 AI 内容，不是 `display`）。
4. **后端回报经上行同步**（§7）把 AI 生成的内容 append 回中立层。

关键：**展示元数据在步骤 2 被过滤，永不进后端**。这是用户指出的「传递给 pi 的时候，它可以直接过滤了，不需要输入」的落地。

## §7 上行：事件流 → 中立层增量 append

AI 生成的内容（assistant / toolResult / 状态条目）由事件流带回，session-store 在 `dispatch` 时同步 append 进中立层：

| 事件 | 中立层动作 |
|---|---|
| `entryAppended`（新条目落盘，含 `entry.id`） | 投影成 `NeutralEntry`（`kernelEntryId = entry.id`，`neutralEntryId = {lineageId}:{seq}`），append 到当前 lineage 末尾 |
| `messageEnd`（消息闭合，含完整 message） | 若该 message 尚未在中立层（乐观 user 已先写，见下），补一条 / 回填权威 id |
| `sessionStart`（会话换绑/水合） | 重绑活跃 lineage（若 fork 换了会话身份，见 §9） |
| `compactionEnd` / 分支条目 | 按投影规则 append 对应 entry 类型 |

**与现有 `snapshotNeutralSession` 的关系**：`snapshotNeutralSession`（现在 switch 时逐 lineage `getTree`+`getEntries` 全量重建）从「唯一写入口」降级为「冷启动/回切的兜底重建」——日常走事件增量，switch 时若中立层已新鲜就直接用，只有中立层缺失/损坏时才全量重建。

**一致性的关键不变量**：中立层的 `neutralEntryId` 按 lineage 内 seq 递增。上行 append 只发生在「当前活跃 lineage 末尾」，所以 seq 单调；fork 出新 lineage 时新 lineage 从 0 重新编号（`session-neutral-layer.md` §6.3），父 lineage 编号不动。

## §8 一致性与竞态

- **乐观 user 先写中立层，后端再回报**：下行第 1 步先写 user entry，第 3 步才发后端。后端的 `entryAppended`（user 落盘）回来时，中立层已有该 user——按 `kernelEntryId` 去重（回填权威 id，不重复 append）。这与现在 renderer「乐观回显 + 权威水合」同构，只是承载从中立层走。
- **展示元数据永不进后端**：所以不存在「后端 sync 冲掉展示元数据」的问题——展示元数据根本不进后端，pi 的 `onSnapshot` 冲不掉它。这是把偏离一的根因从机制上消灭，而不是继续补丁。
- **双写顺序**：先写中立层、后发后端。若后端发送失败，中立层的乐观 user 仍在（与文本同生共死，`sticker-plugin.md` Q2 语义），由现有「发送失败」路径统一处理。

---

# 第四编 · fork 走中立版本

## §9 fork = 切中立树

### 9.1 语义

`fork(parentLineageId, boundaryEntryId)` 现在有两层语义要分开：

| 层 | 动作 |
|---|---|
| **中立层** | 在中立树里切出新 lineage：新 `NeutralLineage`，`fork = { parentLineageId, boundaryEntryId }`，entries 从空开始。**这是 fork 的真相**——fork 结构、展示元数据、书签坐标都在中立层。 |
| **投影层** | 把「新 lineage」投影到后端：pi 切文件（`fork(entryId,"at")`）、dsh 开子会话（`session/fork`）。这是投影，`session-neutral-layer.md` §10.4/§11.4 已定义。 |

顺序：**先切中立树，再投影**。这样 fork 产物天然是一条完整中立会话（含 boundary 之前的共享前缀 + 之后的展示元数据），不依赖任何「复制 pi 文件 + 复制旁支图片」的补丁。

### 9.2 fork 产物是一条新的中立会话，还是同一条中立会话的新 lineage？

两条都可，本文选**同一条中立会话（同一个 `neutralSessionId`）里的新 lineage**，理由：

- pi 的 fork 是「文件内开分支 / 切到新文件」，dsh 的 fork 是「session forest 里开子会话」——两者在 `LineageTree` 里都表达为「同一会话的多条 lineage」（`session-neutral-layer.md` 的 `NeutralSession.lineages` 本来就是多 lineage 的）。
- `session-tree` 画树、bookmark 坐标都建立在「一个会话多 lineage」之上，fork 出新 lineage 而不是新会话，不破坏这条基线。

但 pi 的 fork 有个实现细节：它**切到新文件**（换 `kernelPrivateId`）。这是投影细节——映射表里 `{neutralSessionId, pi}` 的 `kernelPrivateId` 会从「fork 前文件」换成「fork 后文件」。`session-neutral-layer.md` §16 的「一个中立会话在 pi 下只绑一个私有 id」要松绑为「**活跃 lineage 的私有 id**」——见 §13 边界。

### 9.3 fork 后的命名与展示

- **命名**（`forkCopyName`）：fork 产物命名「源名 (copy)」这件事也归中立层——fork 时在 `NeutralSession.header` 或新 lineage 上记 `name = "源名 (copy)"`，投影到后端时经 `setSessionName`（中立命名意图）落盘。
- **展示元数据**：boundary 之前的 `display`（图）随共享前缀在中立树里，投影到后端时只投影 AI 内容、`display` 留在中立层——fork 产物重放时图自然在，不需要任何复制。

### 9.4 fork 的投影失败语义

- 中立层切树成功、投影失败（后端拒绝 boundary）→ 回滚中立层的 fork（删掉新 lineage），报错。不出现「中立层有、后端没有」的漂移。
- 投影成功、但并发上下文切换打断（现有 `forkFromSession` 的竞态护栏）→ 护栏语义保留，只是护栏现在守的是「中立层 lineage」而非「pi 文件副本」。

---

# 第五编 · 发送投影与过滤

## §10 发送时过滤展示层

`sendMessage(text, { image })` 的受管写口（renderer 的 `sendMessage`）重构为：

1. **中立层写**：append user `NeutralEntry { message: text, display: { image } }`。
2. **投影**：取当前 lineage 的 entries，过滤出 AI 内容（`message`，跳过 `display`），得到发给后端的消息序列。
3. **后端发送**：`backend.sendMessage(投影后的 text)`。

过滤的精确规则：

- `display` 字段**整体不进投影**。
- `NeutralMessage` 里若出现 `role === "image"` 这类纯展示 role（历史遗留），投影时也跳过——展示内容永不进后端。
- vision 场景（真要把图喂给模型）走 `backend.sendMessage(text, images)` 的 `images` 参数，那是 AI 内容，和 `display` 是两条路径，互不相交。

「发给 AI 的」和「给人看的」在投影函数里显式分离，而不是散在 renderer 各处。

---

# 第六编 · 读取面

## §11 renderer 从哪读

今天 renderer 的消息有三个来源（文件读 / snapshot / 事件增量），图片另走 `imageIndex`。中立层优先后收敛为**一个来源**：

| 现在 | 改后 |
|---|---|
| `openSession` 读 pi 文件 → messages | 读中立层 `NeutralSessionStore` → messages（`message`）+ 展示（`display`） |
| `sync`/`onSnapshot` 用底座快照覆盖 messages | 底座快照仍是「AI 内容」的权威回填源，但**展示元数据由中立层持有，不被快照覆盖** |
| `imageIndex` 按路径查图 | `display.image` 直接挂在 entry 上，渲染时读 |

renderer 的 `messages` 状态由「中立层投影」驱动：`NeutralEntry → { ...message, __image: display?.image }` 这一纯投影产出时间线用的消息（`__image` 字段可保留作渲染契约，但它的真相源是中立层 `display`，不再是 `imageIndex`）。

**关键**：`display` 永不被底座快照覆盖——它不进底座，底座也没东西覆盖它。这是偏离一（图被 sync 冲掉）的根治。

---

# 第七编 · 迁移路径

## §12 分阶段

每阶段编译 + 测试全绿，不出现「新模型 + 新同步一起炸」。

### 阶段 A：数据模型 + 展示元数据进中立层（纯增量，可 revert）

1. `session-neutral.ts` 加 `DisplayMeta`，`NeutralEntry` 加 `display?`。
2. renderer `sendMessage` 的图写口：从 `recordImage`（imageIndex）改挂 `display` 到中立层 user entry；读口从 `imageIndex` 查图改从 `display` 读。
3. `session-images.json` 的写停止，读保留作迁移兼容（读到旧数据仍能显示），新数据不再写。
4. 删除 `copySessionImages`/`adoptSessionImages` 等 imageIndex 迁移动作。

**验收**：发送带图 → 图显示、fork 后图在（经中立层，不再经 forkedFrom 复制补丁）；typecheck + 既有测试全绿。

### 阶段 B：上行连续同步（事件 → 中立层）

1. session-store 在 `dispatch` 的 `entryAppended`/`messageEnd` 分支同步 append `NeutralEntry` 到 `NeutralSessionStore`。
2. 乐观 user 先写、后端回报回填权威 id（按 `kernelEntryId` 去重）。
3. `snapshotNeutralSession` 降级为冷启动/回切兜底。

**验收**：会话进行中，`NeutralSessionStore` 持续新鲜；switch 时不需要现场 snapshot（直接读中立层）。

### 阶段 C：fork 走中立版本

1. `fork`/`forkFromSession` 重构为「先切中立树 → 投影后端」。
2. 拆掉 `forkedFrom` 图片复制补丁（阶段 A 已让图进中立层，此补丁无用）。
3. 命名走中立层（`header.name` 或新 lineage name）。

**验收**：fork 产物是完整中立会话（含图、命名），端到端「fork → 展示 → 切内核」不丢图不丢名。

### 阶段 D：发送投影与过滤 + 读取面收敛

1. `sendMessage` 投影纯 AI 内容（过滤 `display`）发给后端。
2. renderer 消息读取面收敛到「中立层投影」单一来源。

**验收**：发消息后端只收到 AI 内容；renderer 展示 = 中立层投影，与内核无关。

**回滚**：每阶段逐 commit 回退。阶段 A 停写 imageIndex、读保留，是安全的过渡态。

---

# 第八编 · 边界与反模式

## §13 边界情况

| 边界 | 处置 |
|---|---|
| pi fork 换 `kernelPrivateId`（切文件），映射表「一个中立会话只绑一个 pi 私有 id」被打破 | 松绑为「**活跃 lineage 的私有 id**」：映射表 key 从 `(neutralSessionId, kernel)` 扩到 `(neutralSessionId, lineageId, kernel)`，或 pi 侧在绑定里记录「活跃文件路径」随 fork 更新 |
| 展示元数据与 AI 内容同一条 entry（user 带图） | 投影时只取 `message`，`display` 留在中立层——一条 entry 两个面，互不干扰 |
| compaction 压缩后 entry 消失 | 中立层同步删对应 `NeutralEntry`（`session-neutral-layer.md` §23 已列「锚点失效」语义） |
| 中立层损坏 / 与内核侧漂移 | 以「内核侧 AI 内容 + 中立层展示内容」合并重建；展示内容不可恢复则显式「图已丢失」，不静默（`sticker-plugin.md` Q3） |
| 后端发送失败，中立层乐观 user 已写 | 与文本同生共死（`sticker-plugin.md` Q2）：回滚乐观 user + 展示元数据，不留半截 |

## §14 反模式

- **展示元数据按内核路径 key**：`imageIndex[path]` 这种——违反「壳不读内核存储」，是本文要拆的病根。
- **图既进 AI 投影又进展示**：一条图既是 vision 输入又是配图，两个面混在一条路径。正解：`display`（展示）和 `images`（AI 输入）两条不相交路径。
- **fork 靠复制 pi 文件 + 复制旁支图片**：在错误模型上打补丁。正解：fork 切中立树，投影自然带上。
- **中立层只在 switch 时 snapshot**：平时 stale。正解：事件驱动连续 append（§7），switch 只做「换投影」。

---

# 第九编 · QA

**Q：kernel 版本和中立会话层是一个东西吗？**
答：是。本文的「kernel 版本」= `session-neutral-layer.md` 的 `NeutralSession`（中立会话树）。差别只在定位：那篇把它当「切内核的快照载体」，本文把它升为「会话的 canonical 真相源」。名字上沿用户口径叫「kernel 版本」，落点就是中立层。

**Q：图到底进不进 AI？**
答：展示图（贴纸 banner、用户配图）**不进**——它是 `display`，发送时过滤。真要把图喂给模型（vision）走 `backend.sendMessage(text, images)`，那是 AI 内容，和 `display` 两条不相交路径。历史上「图是交流机制、不是 AI 输入」（`sticker-plugin.md` §1.2）在本文显式成类型。

**Q：为什么这次不继续用 forkedFrom 复制补丁了？**
答：因为那是「展示元数据按 pi 路径 key」这个错误模型的补丁。根因是图没进中立层、才需要 fork 时复制。图进了中立层（阶段 A）、fork 切中立树（阶段 C），复制补丁就无用了，直接拆。

**Q：同步问题到底指什么？**
答：中立层 ↔ 内核投影的**双向连续同步**——下行「发送时从中立层投影纯 AI 内容给后端」，上行「后端事件流增量 append 回中立层」。今天下行绕过中立层（直连后端）、上行只在 switch 时全量 snapshot，都不是连续同步。本文 §6/§7 把两条方向都落到事件驱动/投影上。

**Q：这个改动会让 pi 文件不再是真相源吗？**
答：对。pi 文件（JSONL）从中立层之外的「会话真相源」降为「中立树在 pi 内核下的投影」（`session-neutral-layer.md` §QA 已预告这个方向）。AI 内容的投影仍写 pi 文件（pi 自己跑，文件是它的存储），但壳的真相源是中立层——壳不读 pi 文件（`kernel-design-spec.md` 不变量 #1），壳读中立层。

**Q：阶段 A「停写 imageIndex、读保留」会不会漏图？**
答：不会。阶段 A 是「新数据走中立层、旧数据仍能从 imageIndex 读回」的过渡态，读保留是为了老会话的图不丢。阶段 D 读取面收敛到中立层后，imageIndex 彻底删除。

---

# 附：与既有文档的关系

| 文档 | 本文与之的关系 |
|---|---|
| `session-neutral-layer.md` | 本文是其推进篇：把「中立坐标系」从快照载体升为 canonical，补展示元数据 + 连续同步 + fork 走中立 + 发送过滤 |
| `kernel-design-spec.md` | 不变量「壳不读内核存储」「壳只认中性事件」在展示元数据上的落地 |
| `sticker-plugin.md` | §1.2「图是交流机制不是 AI 输入」+ §3「custom_message 条目」的设计意图，本文把它从中立层层面落地（不再依赖 pi 文件条目、不再被 sync 冲掉） |

---

# 实现要点清单（照着落地）

| 层 | 交什么 | 落点 |
|---|---|---|
| core/domain | `DisplayMeta` + `NeutralEntry.display` | `core/domain/session-neutral.ts` |
| core/application | 中立层连续同步（事件 → append / 发送 → 投影） | `core/application/sessions/session-store.ts` |
| core/application | `NeutralSessionStore` 增删 entry 原语（append/按 entryId 去重回填） | `core/application/sessions/neutral-session-store.ts` |
| core/application | fork 切中立树 | `core/application/sessions/session-store.ts` |
| client/pi, client/dsh | 投影纯 AI 内容（`seed`/`sendMessage` 过滤 `display`） | `client/{kernel}` |
| api/renderer | 读取面收敛到中立层投影；删 `imageIndex` | `api/renderer/stores/session-store.ts` |

**验收铁律（三句话）**：

1. 展示元数据（图）在 fork/切内核/重开后都在，且**永不进 pi/dsh 的 AI 投影**。
2. `NeutralSessionStore` 随会话进行持续新鲜，switch 时直接读中立层、不再现场全量 snapshot。
3. fork 产物是完整中立会话，命名/图/fork 结构都在中立层，后端只拿到 AI 内容投影。
