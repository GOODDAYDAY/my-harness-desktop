# 会话级中立映射层：壳的中立会话坐标系

> 本文是 `kernel-design-spec.md` 的**配套下半篇**。那篇立了「壳协议 vs 内核协议」的分层、圆心契约 `BaseBackend`、能力拉平三层次；但它的中立契约**只做到了一半**——消息/事件/树形投影中立了，**会话身份和锚点还是内核私有的**。本文补上缺失的另一半：壳拥有**中立会话坐标系**，内核只做**双向投影（私有 ↔ 中立）**。两篇相辅相成——那篇讲「壳和内核怎么对话」，这篇讲「会话的坐标、身份、历史在中立层怎么表达」。

> **一句话主线（全文贯彻）**：**换内核 = 换投影实现，中立会话层一行不动**。`switchKernel` 不该「stop 旧 + 拿私有 token + seed 线性」，而该「在壳的中立会话层上做投影切换」。

## 目录

- **第一编 · 问题与目标**（§1–§4）：问题、目标、核心原则、术语表
- **第二编 · 中立坐标系**（§5–§9）：中立会话身份、中立锚点、中立会话树、中立模型引用、契约变更清单
- **第三编 · 双向投影**（§10–§13）：pi 投影、dsh 投影、锚点翻译规则、树 seed 反向投影
- **第四编 · 会话身份持久化映射表**（§14–§16）：映射表结构、持久化与恢复、来回切找回原会话
- **第五编 · switchKernel 重写**（§17–§19）：现状、目标、新 switchKernel 完整步骤
- **第六编 · 模型身份中立化**（§20–§21）：中立模型引用、adapter 解析与显式降级
- **第七编 · 迁移路径**（§22）：分阶段
- **第八编 · 边界与反模式**（§23–§24）：边界情况、反模式
- **第九编 · QA**（§25）
- **第十编 · 与 kernel-design-spec.md 的关系**（§26）：相辅相成对照 + 三处回改清单

---

# 第一编 · 问题与目标

## §1 问题：中立契约只做到了一半

`kernel-design-spec.md` 已经中立化了三类东西：

1. **消息**：`sendMessage(text, images?)` 是中性意图，壳不知道 pi 的 `prompt` 命令、dsh 的 `session/prompt` RPC。
2. **事件**：pi 的 `message_start/update/end`、dsh 的 `turn/start`、`assistant/chunk` 都投成同一条中性事件流。
3. **树形投影**：pi 的 parentId 树、dsh 的 session forest 都投成同一棵 `LineageTree`。

这三类中立了，但**会话身份和锚点还留在内核私有里**：

- **会话身份**：`kernelSessionId` 是内核私有的——pi 存 JSONL 文件路径（`~/.pi/agent/sessions/<bucket>/<stamp>.jsonl`），dsh 存 childSessionId。壳侧没有一个稳定、跨内核不变的「会话 id」。
- **锚点**：`Anchor` 的 `opaque` 字段是内核私有 token——pi 存 JSONL 拷贝路径，dsh 存 childSessionId。`bookmark` 建锚点时绑死了一个内核，`resume` 只能在这个内核里续。

**后果**：一跨内核就断。

- `fork(parentLineageId, boundary)` 的 `boundary` 是内核私有坐标（pi 的 entryId / dsh 的 seq），切内核后这个坐标在目标内核里没有意义。
- `bookmark` 建的锚点是内核私有 token，切内核后 `resume` 报「锚点不属于此后端」。
- `switchKernel` 只能 seed 线性 history（`NeutralMessage[]`），fork 出来的分支结构全部丢失——切完内核，原来的分支树变成一条直线。

**根因**：不是「三个小缺口」，是「中立坐标系缺了半边」。消息/事件/树形是「投影」中立了，但「坐标」（会话是谁、锚点在哪、树有几支）还焊在内核私有里。中立契约只覆盖了「内容」，没覆盖「坐标」。

## §2 目标：壳拥有中立会话坐标系

目标一句话：**壳拥有「中立会话坐标系」，内核只负责双向投影（私有 ↔ 中立）**。

具体四件事：

1. **中立会话身份**：壳侧稳定 `neutralSessionId`（壳自己的存储，跨内核不变），adapter 持映射表 `<kernel, neutralSessionId> → kernelPrivateId`，映射**持久化**——pi→dsh→pi 来回切，第二次回 pi 还能找回原来那个文件，而不是每次重开新会话。
2. **中立锚点**：锚点改成中立坐标 `(lineageId, entryId)`，**去掉 `opaque` 内核私有 token**。fork 的 `boundary`、bookmark 的 `anchor` 都落在这个中立坐标系里。切内核时锚点不失效——它是壳的坐标，不是内核的 token。
3. **树 seed 反向投影**：`seed` 从线性 `NeutralMessage[]` 改成中立会话树（lineages + entries）。pi 侧重建 parentId 树，dsh 侧重建 session forest。树能重建，fork 就不丢。
4. **模型身份中立化**：壳记录「当前模型」用中立引用，每个内核 adapter 解析到自己的模型命名空间；切换内核时由 adapter 决定「这个中立引用在目标内核里有没有对应物，没有就显式降级」。

这四件事合起来，就是「中立契约」的另一半：**内容中立（已达成）+ 坐标中立（本文补上）**。

## §3 核心原则：换内核 = 换投影实现

全文最该记住的一句话：

> **换内核 = 换投影实现，中立会话层一行不动。**

它的精确含义：

- **中立会话层**（`core/application` 的 session-store 持有的中立会话 + 映射表）是壳的**业务本质**：会话是谁、锚点在哪、树有几支、当前模型是什么——这些是中立的，不因内核而变。
- **投影实现**（`client/{kernel}` 的 adapter）是**会变的细节**：怎么把中立坐标翻译成 pi 的 parentId、怎么翻译成 dsh 的 seq，每个内核一套。
- 切内核 = 把「当前会话」的投影实现从 `PiBackend` 换成 `DshBackend`，中立会话层的 `neutralSessionId`、锚点、树、模型引用**全部不动**。变的只是「这棵树投影到哪个内核的存储形态」。

这是「依赖倒置」和「抽象在 core」在会话层的直接落地：

```
core/domain/          中立坐标系：LineageTree + 中立 Anchor(lineage,entry) + 中立 sessionId + 中立模型引用
core/application/     session-store 持「中立会话 + 映射表」，switchKernel 只在中立层操作
client/pi, client/dsh   各内核 adapter：私有 ↔ 中立的双向投影（含 seed 树重建、锚点翻译）
```

**反过来说**：现在的实现里，`getTree`/`getEntries` 已经是「私有 → 中立」的投影（方向对了），缺的是**中立锚点、反向树 seed、会话身份持久化映射**这三块。补上这三块，跨内核才不是「线性半成品」。

## §4 术语表（本文专用，与 kernel-design-spec.md §4 互补）

| 术语 | 定义 |
|---|---|
| 中立会话坐标系 | 壳拥有的、内核无关的会话表达体系：中立会话身份 + 中立锚点 + 中立会话树 + 中立模型引用 |
| 中立会话身份 `neutralSessionId` | 壳生成的稳定会话 id，跨内核不变；经映射表投影到各内核私有 id |
| 私有会话 id `kernelPrivateId` | 内核侧的会话标识：pi = JSONL 文件路径，dsh = session id / childSessionId |
| 中立锚点 | `(lineageId, entryId)` 的中立坐标，替代 `Anchor.opaque` 私有 token |
| 中立 entryId | 壳生成的、在 lineage 内稳定有序的条目 id（`{lineageId}:{seq}`），投影时赋予 |
| 中立会话树 | 完整的中立会话结构：`{ neutralSessionId, lineages: [{ lineageId, fork, entries[] }] }`，比 `LineageTree`（只有分叉关系）多了 entries |
| 双向投影 | adapter 做的「私有 ↔ 中立」两个方向的翻译：读时私有→中立（getTree/getEntries），写时中立→私有（seed 树重建、锚点翻译） |
| 树 seed | `seed(NeutralSession)` 把中立会话树反向投影成内核私有树（pi 重建 parentId 树 / dsh 重建 session forest） |
| 中立模型引用 | 壳记录的「当前模型」的中立 id，adapter 解析到各自模型命名空间 |
| 投影切换 | `switchKernel` 的正确语义：在中立会话层上换投影实现，中立数据不动 |

---

# 第二编 · 中立坐标系

本编定义中立坐标系的核心契约（落 `core/domain`，零依赖）。这是「抽象在 core」的另一半：坐标系（会话是谁、锚点在哪、树有几支、模型是什么）都是中立抽象，放圆心。

## §5 中立会话身份 `neutralSessionId`

### 5.1 定义

```ts
// core/domain/session-neutral.ts（新增）
export interface NeutralSessionId {
  /** 壳生成、跨内核稳定的会话 id（UUID）。 */
  value: string;
}

/** 一个内核里，中立会话 id → 私有会话 id 的投影。 */
export interface KernelSessionBinding {
  kernel: KernelId;
  neutralSessionId: string;
  /** 内核私有会话标识：pi = JSONL 文件路径，dsh = session id / childSessionId。 */
  kernelPrivateId: string;
}
```

### 5.2 语义

- `neutralSessionId` 是壳**自己存储里**的会话主键。壳的会话列表、会话头、书签、会话分组，全都以它为准——**不再以 pi 的文件路径为准**。
- `KernelSessionBinding` 是「中立 → 私有」的映射一行。一个中立会话，在 pi 内核下绑定一个文件路径，切到 dsh 后绑定一个 dsh session id，切回 pi 再绑定回**原来的那个文件路径**（映射持久化，不重新开会话）。
- 映射表是 **`kernel × neutralSessionId → kernelPrivateId`** 的多对一关系：一个中立会话，最多同时绑定一个内核的私有 id（因为「一个会话永远只在一个内核下打开」，见 §23 边界）；但历史上可能先后绑过 pi 和 dsh 两行，切回旧内核时恢复旧绑定。

### 5.3 与现有 `kernelSessionId` / `boundSessionPath` 的关系

- 现在 `SessionProc` 里有两个字段：`kernelSessionId`（当前内核的会话 id，dsh 用）和 `boundSessionPath`（pi 文件路径中心的遗留，dsh 下为 null）。这两个是「投影结果」，不是「中立主键」。
- 终态：`SessionProc` 持 `neutralSessionId`（中立主键）+ 当前 `kernelPrivateId`（投影结果，运行时缓存）。`boundSessionPath` 作为 pi 专属字段收进 pi 投影内部，壳不再直读。

### 5.4 中立 id 的生成与归属

- `neutralSessionId` 由壳在「开新会话」时生成（UUID），**不**由内核生成。内核只生成自己的私有 id（pi 的文件名、dsh 的 session id）。
- 映射表的写入口是 `switchKernel` 的 seed 步：切到目标内核、seed 出目标私有 id 后，写一行 `{kernel, neutralSessionId, kernelPrivateId}`。切回旧内核时，读历史绑定恢复 `kernelPrivateId`，不重新 seed。

## §6 中立锚点 `(lineageId, entryId)`

### 6.1 定义

```ts
// core/domain/session-neutral.ts
/** 中立锚点：中立会话树里的坐标，完全内核无关。替代 kernel-design-spec.md §9.6 的 Anchor.opaque。 */
export interface NeutralAnchor {
  /** 中立 lineage id（LineageTree 里的 lineage.id）。 */
  lineageId: string;
  /** 该 lineage 内的中立 entry 坐标（{lineageId}:{seq}，见 §5.4 中立 entryId）。 */
  entryId: string;
}
```

### 6.2 为什么去掉 `opaque`

现在 `Anchor = { lineageId, boundary, opaque }`，`opaque` 是「后端自留的持久化线索」（pi 存 JSONL 拷贝路径，dsh 存 childSessionId）。这个 `opaque` 是**跨内核断的根因**：

- `bookmark` 建锚点时，`opaque` 绑死了建锚点的那个内核；
- `resume` 时，`opaque` 是别家内核的 token，只能报「锚点不属于此后端」。

去掉 `opaque`，锚点变成**纯中立坐标** `(lineageId, entryId)`——它是壳的坐标，不是内核的 token。切内核时锚点不失效：`resume` 在中立层按坐标找到「这条 lineage 的这个 entry」，再由目标内核的 adapter 把坐标翻译成目标内核的私有形态。

### 6.3 中立 entryId 的生成规则

`entryId` 必须是中立的、稳定的。规则：

- 中立 entryId = `` `${lineageId}:${seq}` ``，`seq` 是条目在**它所属 lineage 内的 0-based 序号**（按时间序）。
- 投影时（`getEntries` 私有 → 中立），adapter 把每条内核私有 entry 翻译成 `NeutralMessage` 并附 `neutralEntryId`；壳按 lineage 内的顺序编号。
- 稳定性：只要一条 lineage 的 entry 序列不变（不 fork 不追加），每条 entry 的 `neutralEntryId` 不变。fork 出新 lineage 时，新 lineage 有自己的 `lineageId`，entry 从 0 重新编号——父 lineage 的编号不受影响。

### 6.4 中立锚点与 fork boundary / bookmark 的关系

- `fork(parentLineageId, boundary)` 的 `boundary` 就是中立 `entryId`（不再是 pi 的 entryId 或 dsh 的 seq）。
- `bookmark(lineageId, entryId)` 返回 `NeutralAnchor { lineageId, entryId }`，**不返回 opaque**。
- `resume(anchor)` 在中立层定位坐标，adapter 翻译成目标内核的私有形态（§12 锚点翻译规则）。

### 6.5 与 kernel-design-spec.md §9.6 的冲突裁决

- kernel-design-spec.md §9.6 的 `Anchor = { lineageId, boundary, opaque }` 是**旧契约**，本文 §6.1 的 `NeutralAnchor = { lineageId, entryId }` **覆盖并取代**它（契约单源，冲突以本文为准）。
- `BoundaryRef`（旧 `string`）统一改称 `entryId`（仍是 string，但语义从「不透明引用」收窄为「中立 entry 坐标」）。
- 回改清单见 §26。

## §7 中立会话树（完整结构）

### 7.1 为什么需要「完整结构」而不是 `LineageTree`

`LineageTree = { rootId, lineages: [{ id, fork }] }` 只有**分叉关系**（谁从谁分叉、分叉点是谁），没有**每条 entry 的完整序列**。要「树 seed」（切内核后重建 fork 结构），光有分叉关系不够——得知道每条 lineage 里**有哪些 entry、每条 entry 在什么位置**。

所以中立坐标系需要一个比 `LineageTree` 更完整的结构：

```ts
// core/domain/session-neutral.ts
/** 中立会话树：完整的中立会话结构，含 entries。 */
export interface NeutralSession {
  neutralSessionId: string;
  /** 会话头元数据：内核归属、项目、时间戳等。 */
  header: NeutralSessionHeader;
  lineages: NeutralLineage[];
}

export interface NeutralSessionHeader {
  kernel: KernelId;
  cwd: string;
  createdAt: string;
  // ... 会话头其它字段
}

export interface NeutralLineage {
  lineageId: string;
  /** 从哪条父 lineage 的哪个中立 entry 切出来；null = 根 lineage。 */
  fork: { parentLineageId: string; boundaryEntryId: string } | null;
  /** 该 lineage 相对父 lineage 的**独有条目**（分叉点之后；增量语义）。
   *  根 lineage = 从根到主干末尾的完整链。选增量语义是因为它和 pi 的 parentId 树
   *  （共享前缀 + 分支增量）、dsh 的 fork 前缀拷贝天然对齐——树 seed 时分支先 fork 到
   *  分叉点、再追加独有条目，无需去重前缀。 */
  entries: NeutralEntry[];
}

export interface NeutralEntry {
  /** 中立 entry id（{lineageId}:{seq}，见 §6.3）。 */
  neutralEntryId: string;
  /** 内核私有 entry id（投影时的 opaque 线索，仅 adapter 用，不进中立契约对外面）。 */
  kernelEntryId?: string;
  /** 中性消息（role/content/…，复用 kernel-design-spec.md §12 的 NeutralMessage）。 */
  message: NeutralMessage;
}
```

### 7.2 语义

- `NeutralSession` 是「一个会话的全部中立数据」：身份（neutralSessionId）+ 头（kernel 归属等）+ 树（lineages + entries）。
- 它是**壳的会话存储格式**（`~/.my-harness-desktop/sessions/` 下，JSONL 或 JSON），不是内核的存储。内核的存储（pi 文件、dsh session log）是「这个中立树的投影」，由 adapter 维护双向同步。
- `seed(session: NeutralSession)` 把整棵树反向投影到目标内核（§13）；`getTree`/`getEntries` 把目标内核的私有树投影回 `NeutralSession`。

### 7.3 与现有 `LineageTree` / `NeutralMessage` 的关系

- `NeutralLineage` 是 `LineageTree.lineages[]` 的**扩展**（多了 `entries`）。
- `NeutralEntry` 是 `NeutralMessage` 的**包装**（多了 `neutralEntryId` + `kernelEntryId`）。
- 现有 `LineageTree`（只读分叉关系，供 session-tree 画树）**保留**，它是 `NeutralSession` 的「投影视图」；`NeutralSession` 是「完整数据」。画树用前者，seed 用后者。

## §8 中立模型引用

### 8.1 定义

```ts
// core/domain/session-neutral.ts
/** 中立模型引用：壳记录的「当前模型」的中立 id。 */
export interface NeutralModelRef {
  /** 壳的中立模型 id（如 "fast" / "pro" / "reasoning"，壳自己的语义，非内核 provider/model）。 */
  ref: string;
  /** 可选：中立推理档位（壳自己的档位，非 pi thinkingLevel / dsh reasoningEffort）。 */
  effort?: string;
}
```

### 8.2 语义

- 壳记录「当前模型」用 `NeutralModelRef`（壳自己的模型语义），不用内核的 `provider/model`。
- 每个内核 adapter 把中立引用解析到自己的模型命名空间：pi 解析成 `models.json` 里的 `provider + modelId`，dsh 解析成 cordis.yml 里的 `provider route + model id`。
- 切换内核时，adapter 决定「这个中立引用在目标内核里有没有对应物」：有 → 解析成目标内核的 provider/model；没有 → **显式降级**（提示「目标内核无对应模型，已回落默认」），不静默、不猜。

### 8.3 与现有 `provider/model` 的关系

- 现有 `setModel(provider, modelId)`、`BackendCreateOptions.provider/model` 是「内核私有模型引用」，不是中立的。
- 终态：壳持 `NeutralModelRef`（中立），`setModel` 在中立层改 `NeutralModelRef`，adapter 在发送时解析成各自内核的 provider/model。
- 这是「抽象在 core」在模型层的落地：壳的「模型偏好」是中立抽象（core），内核的「provider/model」是投影（client）。

## §9 契约变更清单（相对 kernel-design-spec.md）

| # | 旧契约（kernel-design-spec.md） | 新契约（本文） | 变更性质 |
|---|---|---|---|
| C1 | `Anchor = { lineageId, boundary, opaque }` | `NeutralAnchor = { lineageId, entryId }`（去 opaque） | **破坏性**（去字段 + 改名） |
| C2 | `BoundaryRef = string`（不透明引用） | 语义收窄为「中立 entryId」（`{lineageId}:{seq}`） | 语义收窄 |
| C3 | `seed(history: NeutralMessage[])`（线性） | `seed(session: NeutralSession)`（树，含 lineages + entries） | **破坏性**（签名改） |
| C4 | `bookmark(lineageId, boundary): Anchor` | `bookmark(lineageId, entryId): NeutralAnchor` | 返回类型改 |
| C5 | `resume(anchor): string`（返回内核私有 id） | `resume(anchor): NeutralSessionId`（返回中立 id） | 返回类型改 |
| C6 | 无 `neutralSessionId` 契约 | 新增 `NeutralSessionId` + `KernelSessionBinding` | 新增 |
| C7 | 无中立会话树 | 新增 `NeutralSession`/`NeutralLineage`/`NeutralEntry` | 新增 |
| C8 | 无中立模型引用 | 新增 `NeutralModelRef` | 新增 |

这些变更的迁移路径见 §22；与 kernel-design-spec.md 的回改清单见 §26。契约单源纪律：本文是中立坐标系的**唯一权威**，kernel-design-spec.md §9.6/§9.7 的旧 `Anchor`/`seed` 定义以本文为准。

---

# 第三编 · 双向投影

本编定义两个内核 adapter 怎么把「私有形态」和「中立坐标系」互相投影。双向投影是 adapter 的**唯一职责**：读时私有 → 中立（getTree/getEntries），写时中立 → 私有（seed/fork/bookmark/resume）。这是「消费而非翻译」的正确边界——adapter 翻译的是「坐标和树」，不是「渲染」。

## §10 pi 的投影：文件路径 / parentId 树 ↔ 中立

### 10.1 pi 的私有形态

- **会话**：一个 JSONL 文件，路径 `~/.pi/agent/sessions/<bucket>/<stamp>.jsonl`。
- **树**：条目靠 `parentId` 连成树，根是 session 头，每条 `message`/`custom` 条目有 `id` 和 `parentId`。
- **fork**：`fork(entryId, position)` 在文件内开分支，`position` 是 `before`/`at`（对某条 user 锚点的位置）。
- **条目身份**：`entry.id`（pi 生成的 UUID）。

### 10.2 私有 → 中立（读）

| 私有 | 中立 | 投影规则 |
|---|---|---|
| 文件路径 | `neutralSessionId` | 查映射表 `<pi, neutralSessionId> → 路径`；没有则视为新会话，壳生成 neutralSessionId 并写绑定 |
| parentId 树 | `LineageTree` + `entries` | 沿 parentId 走主干找分叉点，投影成 lineage 树（复用 `projectLineageTree`）；每条 entry 按 lineage 内顺序编 `neutralEntryId = {lineageId}:{seq}` |
| `entry.id` | `kernelEntryId`（opaque 线索） | 存进 `NeutralEntry.kernelEntryId`，仅 adapter 用 |

### 10.3 中立 → 私有（写）

| 中立 | 私有 | 投影规则 |
|---|---|---|
| `neutralSessionId` | 文件路径 | 查映射表；命中旧绑定 → 用旧路径（来回切找回原文件）；未命中 → 生成新路径并写绑定 |
| 中立会话树 | parentId 树 | 见 §13 树 seed |
| 中立 entryId `{lineageId}:{seq}` | `entry.id` | 树 seed 时按 seq 顺序重建条目，父条目的 id 挂到子条目的 `parentId` |

### 10.4 pi 的 fork 位置翻译

- 中立 `fork(parentLineageId, boundaryEntryId)` → pi 的 `fork(entryId, position)`：`boundaryEntryId` 映射到 pi 的 `entry.id`（经 `kernelEntryId` 线索），`position` 固定 `"at"`（当前约定，见 kernel-design-spec.md §9.5）。
- pi 的 `parentLineageId` 冗余（pi 总 fork 激活会话），由壳保证「要 fork 的 lineage 就是当前活跃 lineage」（若否，先 activateLineage——这是 kernel-design-spec.md §9.5 标注的已知缺口，本文的中立层给它补上了落点：`activateLineage(lineageId)` 先投影激活）。

## §11 dsh 的投影：childSessionId / seq ↔ 中立

### 11.1 dsh 的私有形态

- **会话**：一个 append-only `SessionEvent` 日志，主会话有 `sessionId`，fork 出的子会话有 `childSessionId`。
- **树**：session forest——父会话 + 若干 fork 出的子会话，lineage 记在会话 header。
- **fork**：`session/fork(parentSessionId, boundarySeq)`，`boundarySeq` 是源会话里含端点的 seq，内部 `events.slice(0, boundary+1)` 前缀拷贝成子会话。
- **条目身份**：事件的 seq（append 顺序号）+ 事件 id。

### 11.2 私有 → 中立（读）

| 私有 | 中立 | 投影规则 |
|---|---|---|
| session id / childSessionId | `neutralSessionId` | 查映射表 `<dsh, neutralSessionId> → sessionId`；主会话绑 neutralSessionId，fork 出的子会话各自是独立 lineage（其 childSessionId 作为该 lineage 的 kernel 私有线索） |
| session forest | `LineageTree` + `entries` | 父会话 = 根 lineage，子会话 = fork 出的分支 lineage，`boundarySeq` 是分叉点；每条 event 按 lineage 内顺序编 neutralEntryId |
| 事件 seq | `kernelEntryId`（opaque 线索） | 存进 NeutralEntry，仅 adapter 用 |

### 11.3 中立 → 私有（写）

| 中立 | 私有 | 投影规则 |
|---|---|---|
| `neutralSessionId` | session id | 查映射表；命中 → 用旧 session id；未命中 → seed 出主会话 |
| 中立会话树 | session forest | 见 §13 树 seed |
| 中立 entryId | seq | 树 seed 时按 lineage 内顺序映射到 seq |

### 11.4 dsh 的 fork 位置翻译

- 中立 `fork(parentLineageId, boundaryEntryId)` → dsh 的 `session/fork(parentSessionId, boundarySeq)`：`boundaryEntryId` 的 seq 部分（`{lineageId}:{seq}` 里的 seq）直接就是 `boundarySeq`。
- dsh 的 fork 自带前缀拷贝，比 pi 更贴中立树——这是 dsh 的顺风（kernel-design-spec.md §9.5 已记）。

## §12 锚点翻译规则

中立锚点 `(lineageId, entryId)` 在两个内核里的翻译，是全篇最要钉死的一张表：

| 操作 | 中立 | pi 翻译 | dsh 翻译 |
|---|---|---|---|
| `fork` 的 boundary | `(lineageId, entryId)` | `entryId` → pi `entry.id`（经 kernelEntryId 线索），`position="at"` | `entryId` 的 seq → `boundarySeq` |
| `bookmark` 建锚点 | 返回 `NeutralAnchor{lineageId, entryId}` | 锚点**只存中立坐标**，pi 不存拷贝路径 | 锚点**只存中立坐标**，dsh 不存 childSessionId |
| `resume` 续锚点 | 按坐标定位 | 先在中立层找到 `(lineageId, entryId)` 对应的 lineage，投影到 pi 激活该 lineage 的会话文件，再 `fork(entryId, "at")` 切到分叉点 | 找到 lineage 对应的子会话（childSessionId 线索），`resume` 回该子会话并定位到 seq |
| `deleteBookmark` | 删锚点 | 无内核侧副本要回收（不再有 JSONL 拷贝） | 无内核侧副本要回收（不再有额外子会话） |

**关键变化**：`bookmark` 不再是「拷贝一份文件/开一个子会话」，而是「在中立会话树里标记一个坐标」。锚点的持久化从「内核侧副本」变成「壳侧坐标记录」——`bookmark` 存的是一条 `{neutralSessionId, lineageId, entryId}` 记录，落壳的存储（`~/.my-harness-desktop/bookmarks/`），不碰内核。

**`resume` 的语义随之简化**：不再「物化 opaque 副本」，而是「在中立会话树里定位坐标 → 投影到目标内核 → 切到该分叉点继续」。内核没做的事（开分支、拷贝前缀）由「resume 时的一次 fork」完成，而不是「bookmark 时预先拷贝」。

## §13 树 seed 反向投影

`seed(session: NeutralSession)` 是中立会话树 → 内核私有树的反向投影。这是切内核「不丢 fork」的关键。

### 13.1 通用步骤

1. 目标内核的 adapter 收到完整 `NeutralSession`（linesages + entries，含中立 entryId + 各 lineage 的 fork 关系）。
2. 先 seed **根 lineage**：把根 lineage 的 entries 按顺序写入目标内核的会话。
3. 再按 fork 关系**逐分支 seed**：每条分支 lineage，从父 lineage 的分叉点（boundaryEntryId）切出，写入分支的 entries。
4. 记录每条 lineage 的目标内核私有 id（pi 文件路径 / dsh session id），作为后续 fork/bookmark/resume 的投影线索。

### 13.2 pi 侧：重建 parentId 树

- 根 lineage：写一个 JSONL 文件，session 头 + 每条 entry 按顺序挂 `parentId`（前一条的 id）。
- 分支 lineage：在父 lineage 的分叉点 `entryId` 处 `fork(entryId, "at")`，底座切到新文件后，把分支 entries 追加进去（挂 parentId）。
- 结果：一个 parentId 树，与中立树同构。

### 13.3 dsh 侧：重建 session forest

- 根 lineage：seed 成一个主会话（前缀事件流写入）。
- 分支 lineage：`session/fork(parentSessionId, boundarySeq)` 出子会话（dsh 自带前缀拷贝），分支 entries 追加进子会话。
- 结果：一个 session forest，与中立树同构。

### 13.4 seed 的失败语义与幂等

- **失败**：目标内核 seed 中途失败（某条 entry 不支持、fork 边界无效）→ 整体回滚（关掉已开的会话、删掉已写的文件），不留下半截树。
- **幂等**：同一 `NeutralSession` seed 到同一内核两次 → 第二次识别出已有绑定（映射表命中），**不重复 seed**，返回已有私有 id。seed 只在「切到未绑定过的内核」时发生。

### 13.5 与线性 seed 的区别

- 旧 `seed(NeutralMessage[])` 只搬「一条直线的消息」，fork 出的分支全丢。
- 新 `seed(NeutralSession)` 搬「整棵树」，fork 结构保留。跨内核切换后，用户看到的不是「历史变成一条直线」，而是「原来的分支树还在，只是投影到了新内核」。

---

# 第四编 · 会话身份持久化映射表

本编定义「中立 → 私有」映射表的存储结构、持久化与恢复。映射表是「会话坐标中立化」的**落地载体**——没有它，`neutralSessionId` 就只是另一个不稳定 id；有了它，pi→dsh→pi 来回切才能找回原会话。

## §14 映射表结构

```ts
// core/application/sessions/session-binding-store.ts（用例编排层）
export interface SessionBinding {
  neutralSessionId: string;
  kernel: KernelId;
  kernelPrivateId: string;
  /** 绑定时间（诊断/排序用）。 */
  boundAt: string;
}
```

- **一行 = 一个内核下的一次绑定**。一个中立会话在 pi 下有一行（文件路径），切到 dsh 后又有一行（dsh session id），切回 pi 恢复旧的那一行。
- **主键**：`(neutralSessionId, kernel)` 唯一——一个中立会话在同一个内核下只有一个私有 id（不重复绑定）。
- **存储位置**：`~/.my-harness-desktop/sessions/bindings.jsonl`（JSONL 追加，一行一个绑定；或 JSON 数组整读整写）。JSONL 追加写不锁全文件、流式读按行解析，与项目现有会话存储同款纪律（kernel-design-spec.md §4 术语「JSONL」）。
- **归属**：映射表是 `core/application` 的用例编排（session-store 的持久化面），不是内核的东西——内核不知道映射表的存在，它只认自己的私有 id。

## §15 持久化与恢复

- **写**：`switchKernel` 的 seed 步、`openSession` 首次投影步，追加一行绑定。
- **读**：`openSession`/`switchKernel` 时按 `(neutralSessionId, kernel)` 查绑定；命中 → 直接恢复 `kernelPrivateId`，不重新 seed。
- **删**：删会话时，级联删该 `neutralSessionId` 的所有绑定行（pi 的文件、dsh 的 session 由各自 adapter 清理，映射表只删记录）。
- **一致性**：映射表的「真相」是「哪个内核持有哪个会话的哪个私有 id」；内核侧的实际文件/会话是「投影结果」。两者不一致时（文件被手动删了、dsh 会话被清理了），以**内核侧实际**为准——`openSession` 发现私有 id 失效（文件不存在/session 已清理），删掉失效绑定，报「会话已失效」，不凭空重建。

## §16 pi→dsh→pi 来回切找回原会话

这是映射表最核心的价值，用一个完整序列说清：

1. **pi 下开会话**：壳生成 `neutralSessionId = "ns-1"`，pi 起一个文件 `s1.jsonl`，写绑定 `{ns-1, pi, s1.jsonl}`。
2. **切到 dsh**：`switchKernel("dsh")` 在中立层快照 `ns-1` 的完整树 → `seed` 到 dsh，dsh 开出主会话 `dsh-s1`，写绑定 `{ns-1, dsh, dsh-s1}`。此时 `ns-1` 有两行绑定（pi 和 dsh）。
3. **在 dsh 下继续聊**：dsh 的 `dsh-s1` 追加新消息；中立层的树同步更新。
4. **切回 pi**：`switchKernel("pi")` 查 `{ns-1, pi}` 命中 `s1.jsonl`——**不重新 seed，直接找回原来的文件**，把 dsh 下新增的消息投影回 pi（pi 的 `s1.jsonl` 追加 dsh 期间的新 entry）。绑定 `{ns-1, pi}` 不变。
5. **结果**：用户看到的还是「同一个会话 `ns-1`」，fork 结构、历史消息、书签全在，只是投影实现来回换了两次。

**关键不变量**：`neutralSessionId` 从头到尾不变；变的只是「当前活跃内核」和「活跃内核的私有 id」。这就是「换内核 = 换投影实现，中立会话层一行不动」的实证。

---

# 第五编 · switchKernel 重写

## §17 现状：stop 旧 + 拿私有 token + seed 线性

现在的 `switchKernel`（`session-store.ts`）是五步：

1. `abort()` 在飞回合；
2. `getEntries()` 快照**线性** history（`NeutralMessage[]`，fork 结构丢失）；
3. `stop()` 旧内核；
4. `factory.create({kernel: target})` + `start()` 新内核；
5. `seed(history)` 线性历史到新内核，重绑 `kernelSessionId`。

**三个问题**：

1. **线性 seed 丢 fork**：`getEntries` 只拿一条 lineage 的线性消息，fork 分支全丢（§13.5）。
2. **会话身份是私有 token**：`kernelSessionId` 是「当前内核的私有 id」，切完就换一个，没有中立主键，回切也找不回旧文件。
3. **锚点失效**：`bookmark` 存的 `opaque` 是旧内核的私有 token，切完 `resume` 报「锚点不属于此后端」。

## §18 目标：在中立会话层上做投影切换

正确的 `switchKernel` 语义不是「搬家」，是「**换投影**」：

- **中立会话层**（`neutralSessionId` + 中立树 + 中立锚点 + 中立模型引用）**全程不动**。
- **投影实现**（`PiBackend` ↔ `DshBackend`）从旧换到新。
- 新内核的私有形态（pi 文件 / dsh session）由**树 seed** 从已有中立树重建；旧内核的私有形态留着（映射表记着，回切能找回）。

一句话：**切内核 = 把「当前会话」从 pi 的投影切到 dsh 的投影，中立数据一行不改**。

## §19 新 switchKernel 的完整步骤

```
输入：target: KernelId
前提：激活会话已有 neutralSessionId + 中立树（若还没有，先从中立存储/当前内核投影出完整 NeutralSession）

1. abort 旧内核在飞回合（收尾，不丢半截消息）
2. 快照完整中立树：
   session = getNeutralSession(neutralSessionId)   // 含 lineages + entries（从当前内核投影，或从壳的中立存储读）
3. stop 旧内核（旧私有形态留着，不删；映射表保留旧绑定行）
4. 查目标内核绑定：
   binding = bindingStore.get(neutralSessionId, target)
   if (binding) {
     // 回切：目标内核已有这个会话的私有形态，直接恢复，不重新 seed
     kernelPrivateId = binding.kernelPrivateId
     newBackend = factory.create({ kernel: target, sessionId: kernelPrivateId })
     newBackend.start()  // 打开已有会话（pi 用 --session <path>，dsh 用 sessionId）
   } else {
     // 首切：目标内核没有这个会话，树 seed 重建
     newBackend = factory.create({ kernel: target })
     newBackend.start()
     kernelPrivateId = newBackend.seed(session)   // 树 seed，返回目标内核私有 id
     bindingStore.put({ neutralSessionId, kernel: target, kernelPrivateId })
   }
5. 同步增量：把「快照后、切换期间」在旧内核产生的新 entry（若有）补投影到新内核
6. 重绑运行时：proc.backend = newBackend; proc.kernel = target; proc.kernelPrivateId = kernelPrivateId
7. 会话头重绑：NeutralSession.header.kernel = target（持久化到壳的中立存储）
```

**关键变化（相对 §17 现状）**：

| 步 | 现状 | 新 |
|---|---|---|
| 快照 | 线性 `NeutralMessage[]` | 完整 `NeutralSession`（树） |
| 会话身份 | 私有 token 换来换去 | `neutralSessionId` 全程不变 |
| seed | 每次切都 seed | 首切 seed，回切恢复（映射表命中） |
| 锚点 | 失效 | 中立坐标，不失效 |
| 会话头 | 未重绑 | 重绑 `header.kernel`（持久化） |

**失败处理**：

- seed 失败（目标内核不支持某 entry / fork 边界无效）→ 回滚：`stop` 新内核、删掉 seed 出的半截私有形态、**不写绑定**、保持旧内核的活跃状态（旧内核已 stop，则重启旧内核恢复）。
- 回切时绑定失效（目标内核私有形态已被清理）→ 删失效绑定，按「首切」走树 seed，并提示「原会话在目标内核已失效，已重建」。

**「有 fork 会话切换」从降级变原生**：现状是「第一期只支持无 fork 线性 lineage，有 fork 降级」；新 switchKernel 靠树 seed 原生支持 fork——树能重建，fork 就不丢（§13）。这是本文相对 kernel-design-spec.md §25「第一期只支持线性」的**升级**。

---

# 第六编 · 模型身份中立化

## §20 中立模型引用

- 壳记录「当前模型」用 `NeutralModelRef { ref, effort? }`（§8.1），**不**用内核的 `provider/model`。
- `NeutralModelRef.ref` 是壳自己的模型语义（如 `"fast"` / `"pro"` / `"reasoning"`），由壳的模型管理 UI（pi-model-manager / dsh-manager 的合流下拉）定义和维护；`effort` 是壳自己的推理档位（如 `"low"` / `"high"`），**不**等于 pi 的 `thinkingLevel` 或 dsh 的 `reasoningEffort`。
- 会话头记 `header.modelRef`（中立），`setModel` 在中立层改这个字段，adapter 在**发送时**解析成各自内核的 provider/model。

## §21 adapter 解析与显式降级

每个内核 adapter 提供一个「中立模型引用 → 内核模型」的解析：

```
pi  adapter：resolveModel(ref) → { provider, modelId }    // 查 models.json 的 provider 树
dsh adapter：resolveModel(ref) → { provider, modelId }    // 查 cordis.yml 的 llm-deepseek/llm-pi-ai
```

**解析规则**：

- 命中：中立 ref 在目标内核有对应模型 → 解析成 provider/model，发送时用。
- 未命中：目标内核没有对应模型 → **显式降级**（提示「目标内核无对应模型，已回落默认模型」），不静默、不猜、不拿 provider 名反推（kernel-design-spec.md §28.2 反模式）。
- 切换内核时：`switchKernel` 不搬模型，只在中立层保持 `header.modelRef`；新内核 adapter 在首次发送时解析——命中就用，未命中降级。这样「模型偏好」是中立坐标的一部分，跨内核不丢，但「内核里有没有这个模型」是 adapter 的事。

---

# 第七编 · 迁移路径

## §22 分阶段

迁移顺序从内往外，每阶段编译 + 测试全绿，不出现「新契约 + 新投影一起炸」。三阶段：

### 阶段 A：契约落地（纯增量）

1. 新增 `core/domain/session-neutral.ts`：`NeutralSessionId` / `NeutralAnchor` / `NeutralSession` / `NeutralLineage` / `NeutralEntry` / `NeutralModelRef` / `KernelSessionBinding`（§5–§9 的契约）。
2. 新增 `core/application/sessions/session-binding-store.ts`：映射表的读写原语（`get`/`put`/`deleteBySession`，JSONL 追加）。
3. `packages/contract/src/index.ts` re-export 新契约。

**验收**：typecheck 通过；新契约单测（映射表 get/put/删除、中立 entryId 生成）；既有 403 测试 + build 全绿（纯增量，无行为变化）。

### 阶段 B：投影落地（改 adapter）

1. `PiBackend` / `DshBackend` 实现双向投影：`getTree`/`getEntries` 投影时给每条 entry 附 `neutralEntryId` + `kernelEntryId`；`bookmark` 返回 `NeutralAnchor`（去 opaque）；`seed` 改 `seed(NeutralSession)` 树签名（§13 树重建）。
2. `session-store` 持 `neutralSessionId` + 映射表，`openSession`/`switchKernel` 走映射表（§14–§16）。
3. `switchKernel` 按 §19 重写（快照树、首切 seed / 回切恢复、会话头重绑）。

**验收**：pi/dsh 两端「fork → bookmark → 切内核 → resume」端到端通；pi→dsh→pi 来回切找回原会话（§16 序列）；fork 结构跨内核保留；模型引用切换显式降级。

### 阶段 C：模型中立化（视需求）

1. 壳的模型管理 UI 改持 `NeutralModelRef`；adapter 加 `resolveModel`。
2. 会话头 `header.modelRef` 持久化。

**验收**：pi↔dsh 切换模型引用解析正确、无对应物显式降级。

**回滚**：阶段 A 纯增量可 revert；阶段 B 逐 commit 回退（投影改 adapter，行为变化在切内核路径，有测试守住）。

---

# 第八编 · 边界与反模式

## §23 边界情况

| 边界 | 处置 |
|---|---|
| 一个中立会话同时在两个内核下有绑定（pi 和 dsh 各一行） | 合法——「一个会话永远只在一个内核下打开」指「活跃内核只有一个」，但历史绑定可以两行（回切恢复用） |
| 回切时目标内核私有形态已被清理（文件被删 / dsh 会话被清） | 删失效绑定，按「首切」走树 seed 重建，提示「原会话已失效，已重建」 |
| 中立 entryId 在 fork 后是否稳定 | 稳定——fork 出新 lineage（新 lineageId），父 lineage 的 entry 编号不变；新 lineage 从 0 重新编号 |
| 同一条消息在 pi 和 dsh 下的 `kernelEntryId` 不同 | 正常——`kernelEntryId` 是 opaque 线索，内核私有，跨内核本就不同；中立 `neutralEntryId` 才稳定 |
| seed 中途失败（某 entry 不支持 / fork 边界无效） | 整体回滚（§13.4），不留半截树 |
| 空会话（无任何 entry）切内核 | 树 seed 一个空根 lineage，目标内核开空会话 |
| 映射表与内核侧实际不一致 | 以内核侧实际为准，删失效绑定（§15） |
| 锚点指向的 entry 已被压缩（compaction 后 entry 消失） | `resume` 报「锚点已失效」（entry 不在中立树里），壳给「删除」或「重建」两选择 |

## §24 反模式

### 24.1 把中立坐标和内核私有 id 混在一个字段

- 症状：`NeutralEntry` 里 `neutralEntryId` 和 `kernelEntryId` 用一个字段，投影时互相覆盖。
- 根因：中立坐标（稳定、跨内核）和私有线索（opaque、内核私有）是两种性质，混在一个字段就会在切内核时互相污染。
- 正解：两个字段分开（§7.1），中立 id 是坐标、私有 id 是线索。

### 24.2 树 seed 只搬 messages 不搬 fork 关系

- 症状：`seed` 把 lineages 拍平成一条 `NeutralMessage[]`，fork 关系丢弃。
- 根因：这就是旧的线性 seed，是「线性半成品」的病根。
- 正解：`seed(NeutralSession)` 按 §13 逐分支重建，fork 关系不丢。

### 24.3 bookmark 还存内核私有副本

- 症状：`bookmark` 返回的锚点还带 `opaque`（pi 拷贝路径 / dsh childSessionId）。
- 根因：锚点绑死内核，跨内核失效。
- 正解：`bookmark` 只存中立坐标 `(lineageId, entryId)`，副本由「resume 时的一次 fork」按需产生（§12）。

### 24.4 switchKernel 每次切都重新 seed

- 症状：回切 pi 时不是恢复旧文件，而是重新 seed 一个新文件。
- 根因：没查映射表，丢了「回切恢复」这条路径。
- 正解：§19 第 4 步——首切 seed，回切恢复（映射表命中）。

### 24.5 模型引用用 provider 名反推内核

- 症状：`if (provider.includes("deepseek")) kernel = "dsh"`。
- 根因：中立模型引用不该由 provider 名反推内核（kernel-design-spec.md §28.2 已禁，本文重申）。
- 正解：`NeutralModelRef` 是壳的模型语义，adapter 的 `resolveModel` 按「当前内核」解析，不由 provider 名猜内核。

---

# 第九编 · QA

**Q：中立坐标系和 kernel-design-spec.md 的 `BaseBackend` 是什么关系？**
答：`BaseBackend` 是「壳和内核怎么对话」（六条意图），中立坐标系是「对话里的坐标怎么表达」（会话是谁、锚点在哪、树有几支）。前者是动词（sendMessage/abort/fork），后者是名词（neutralSessionId/NeutralAnchor/NeutralSession）。`BaseBackend` 的 `fork`/`bookmark`/`resume`/`seed` 的**参数和返回值**从中立坐标系来。

**Q：中立 entryId 用 `{lineageId}:{seq}`，seq 会不会因为 compaction 变化？**
答：会。compaction 压缩后 entry 消失，seq 重排，指向被压缩 entry 的锚点失效（§23 已列）。这是「锚点指向活 entry」的固有约束——锚点是「坐标」，坐标指向的对象被压缩了，坐标自然失效。处置是显式报「锚点已失效」，不静默。

**Q：映射表是壳的存储，内核删了会话怎么办？**
答：以内核侧实际为准（§15）。内核侧私有形态被清（文件删了 / 会话被清），`openSession` 发现私有 id 失效 → 删失效绑定 + 报「会话已失效」。映射表不凭空重建，也不挽留幽灵会话。

**Q：为什么锚点不用 `opaque` 了，还能「resume 到分叉点」？**
答：`resume` 从「恢复一个预先拷贝的副本」变成「在中立树里定位坐标 → 投影到目标内核 → 现场 fork 一次切到分叉点」。副本是「现场按需产生」的，不是「bookmark 时预先存的」。所以锚点只需要坐标，不需要 opaque。

**Q：树 seed 比线性 seed 贵多少？**
答：贵在「分支重建」。线性 seed 写一条序列，树 seed 要逐分支 fork + 写。分支越多越贵，但这是「不丢 fork」的代价——线性 seed 便宜是因为它把 fork 丢了。二者不是同一件事的两种成本，是一个「保 fork」一个「丢 fork」。

**Q：中立模型引用和现有的 models.json / cordis.yml 模型清单什么关系？**
答：模型清单（models.json / cordis.yml）是「每个内核有哪些模型」的内核侧事实；`NeutralModelRef` 是「壳想用哪个模型」的壳侧偏好。adapter 的 `resolveModel` 把偏好解析到内核侧事实——偏好在壳（中立），事实在内核（私有），两者靠解析连接。

**Q：这个映射层会让 switchKernel 变复杂吗？**
答：会多一层「映射表 + 中立树」，但它把「切内核」从「搬家」变成「换投影」，反而让语义更简单——`switchKernel` 只做「快照树 → 查绑定 → seed 或恢复 → 重绑」，不再碰内核私有 token 的搬运。复杂度从「搬家的细节」转移到「投影的正确性」，后者是可测的纯函数。

**Q：为什么中立会话树要存壳侧，而不是让内核各存各的、壳只记 id？**
答：因为「fork 结构」是跨内核要保的东西。如果内核各存各的（pi 存 parentId 树、dsh 存 session forest），壳只记 id，那切内核时 fork 结构只能靠「读旧内核的树 + 翻译 + 写新内核」——这正是现在的线性半成品。把**完整中立树存壳侧**，切内核时壳拿的是「已经中立化、和内核无关」的树，直接 `seed` 给目标内核，不需要「从旧内核读」这步——旧内核可以立即 stop，不依赖它还活着。这也是「换投影」而非「搬家」的另一层含义：中立树是壳的资产，不是内核的投影缓存。

**Q：中立坐标系和「会话文件」是什么关系？会话文件还存在吗？**
答：会话文件（pi 的 JSONL）还存在——它是「中立树在 pi 内核下的投影」，是内核私有的存储。中立树存壳侧（`~/.my-harness-desktop/sessions/`），pi 文件存 pi 侧（`~/.pi/agent/sessions/`），两者靠映射表 + 双向投影同步。壳认中立树，pi 认自己的文件，adapter 在中间投影。删会话 = 删壳侧中立树 + 通知各内核删各自的投影。

---

# 第十编 · 与 kernel-design-spec.md 的关系

## §26 相辅相成对照 + 三处回改清单

两篇是**上下半篇**，不是两份并列文档：

| 维度 | kernel-design-spec.md（上） | 本文（下） |
|---|---|---|
| 主题 | 壳和内核怎么对话（六条意图、协议分层、适配器） | 对话里的坐标怎么表达（会话身份、锚点、树、模型引用） |
| 核心原则 | 抽象在 core、实现在 client | 换内核 = 换投影实现，中立会话层一行不动 |
| 圆心契约 | `BaseBackend` / `BackendFactory` / `KernelModelSource` | `NeutralSessionId` / `NeutralAnchor` / `NeutralSession` / `NeutralModelRef` |
| 覆盖范围 | 消息/事件/树形投影（内容中立） | 会话身份/锚点/树 seed/模型（坐标中立） |

**三处回改清单**（kernel-design-spec.md 需要改，以本文为准）：

1. **§9.6 的 `Anchor`**：`Anchor = { lineageId, boundary, opaque }` → 去掉 `opaque`，改指本文 `NeutralAnchor = { lineageId, entryId }`（§6.1）。原「opaque 后端自留 token」的表述删除。
2. **§9.7 的 `seed`**：`seed(history: NeutralMessage[])` → 改指本文 `seed(session: NeutralSession)` 树签名（§13），并加「见 session-neutral-layer.md」引用。
3. **§12.2 会话标识中性化**：加引用「完整方案见 session-neutral-layer.md」，把「id↔路径索引」升级为「映射表 + neutralSessionId」（本文 §5/§14）。

另外 §9.5 fork 的「⚠ 已知缺口（pi 只 fork 激活会话）」在本文 §10.4 补上了落点（`activateLineage`）；§25 阶段 C 的「switchKernel 补缺口」在本文 §19 升级为「树 seed + 回切恢复」。

## §27 端到端故事：一次 fork → bookmark → 切内核 → resume

把一个完整链路串起来，看中立坐标系怎么让「坐标」跨内核不断：

1. **pi 下开会话，聊 A、B 两条消息**：壳生成 `neutralSessionId = "ns-1"`，pi 起文件 `s1.jsonl`，写绑定 `{ns-1, pi, s1.jsonl}`。中立树：根 lineage `L0`，entries `[A(0), B(1)]`（中立 entryId 是 `L0:0`、`L0:1`）。

2. **在 B 之后 fork**：壳调 `fork(L0, "L0:1")`，pi 侧 `fork(B.entryId, "at")` 开出新文件 `s1-fork.jsonl`。中立树多一条分支 lineage `L1`，`fork = { parentLineageId: L0, boundaryEntryId: "L0:1" }`，entries 从空开始。绑定加一行 `{ns-1, pi, s1-fork.jsonl}`（当前活跃 lineage 的私有 id）。

3. **在新分支聊 C、D，觉得值得留，bookmark**：壳调 `bookmark(L1, "L1:1")`（D 的位置）。**不拷贝文件**，只在中立存储记一条锚点记录 `{neutralSessionId: ns-1, lineageId: L1, entryId: "L1:1"}`。锚点里没有任何内核私有 token。

4. **切到 dsh**：`switchKernel("dsh")` 快照 `ns-1` 的完整中立树（L0 + L1 + 各自 entries + fork 关系）→ `seed` 到 dsh：主会话 seed 出 L0 前缀（A、B），`session/fork` 出 L1 子会话（C、D）。dsh 绑定 `{ns-1, dsh, dsh-main}`（主会话 id），子会话 id 作为 L1 的投影线索。**fork 结构在 dsh 下原样重建**。

5. **在 dsh 下 resume 那个 bookmark**：壳调 `resume({lineageId: L1, entryId: "L1:1"})`。中立层定位「ns-1 的 L1 这条 lineage 的 L1:1 这个位置」→ dsh adapter 翻译成「L1 对应的子会话 + boundarySeq=1」→ 现场 fork 一次切到 D 之后。**锚点没有失效，因为它是中立坐标**。

6. **切回 pi**：`switchKernel("pi")` 查 `{ns-1, pi}` 命中 `s1.jsonl`（和 `s1-fork.jsonl`）——**不重新 seed，找回原来的两个文件**。dsh 期间的新消息投影回 pi。用户看到的还是 `ns-1`，fork 树、书签全在。

全程 `neutralSessionId = "ns-1"` 不变，变的只是「投影到 pi 还是 dsh」。这就是「换内核 = 换投影实现，中立会话层一行不动」。

## §28 实现要点清单（照着落地）

一个实现者按本文落地，需要交的东西：

| 层 | 交什么 | 落点 |
|---|---|---|
| core/domain | `session-neutral.ts`：`NeutralSessionId`/`NeutralAnchor`/`NeutralSession`/`NeutralLineage`/`NeutralEntry`/`NeutralModelRef`/`KernelSessionBinding` 七类型 + 中立 entryId 生成纯函数 | `core/domain/session-neutral.ts` |
| core/application | `session-binding-store.ts`：映射表 `get(neutralSessionId, kernel)`/`put(binding)`/`deleteBySession(neutralSessionId)` + JSONL 持久化 | `core/application/sessions/session-binding-store.ts` |
| core/application | `session-store` 改持 `neutralSessionId` + 中立树 + 映射表；`switchKernel` 按 §19 重写 | `core/application/sessions/session-store.ts` |
| client/pi | `PiBackend` 双向投影：`getTree/getEntries` 附 `neutralEntryId`/`kernelEntryId`；`bookmark` 返回 `NeutralAnchor`；`seed(NeutralSession)` 重建 parentId 树 | `client/pi/pi-backend.ts` |
| client/dsh | `DshBackend` 双向投影：同上 + `seed(NeutralSession)` 重建 session forest | `client/dsh/dsh-backend.ts` |
| 契约发布面 | re-export 七类型 | `packages/contract/src/index.ts` |

**验收铁律（三句话）**：

1. `neutralSessionId` 跨内核不变，映射表持久化，回切找回原会话（§16）。
2. 锚点是中立坐标 `(lineageId, entryId)`，无 `opaque`，跨内核 `resume` 不报「锚点不属于此后端」（§6/§12）。
3. `seed(NeutralSession)` 树重建，fork 结构跨内核保留（§13）。
