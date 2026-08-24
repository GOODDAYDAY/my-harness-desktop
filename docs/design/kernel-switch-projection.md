# 跨内核切换的投影同步：desktop 会话 ↔ 内核私有会话的映射与落定

> 本文是 `session-neutral-layer.md` 的**执行补全**。那篇定义了中立坐标系（`NeutralSession` / `neutralSessionId` / 中立 entryId）和 `seed` 契约的**形状**；本文钉死「切换这个动作」本身的**正确性**——把 desktop 的中性会话映射到 pi/dsh 私有会话时，投影怎么落定、拓扑怎么排、失效怎么回退、切换后周边状态怎么收尾、并发怎么护栏。

> **一句话主线（全文贯彻）**：**切内核 = 换运行时 + 把 desktop 的中性会话单向投影到新内核的私有会话**。难点不在"怎么写 JSONL / 怎么发 JSON-RPC"，而在**投影的语义边界**（什么跨、什么不跨、什么降级）与**投影动作自身的时序正确性**（先落定、排拓扑、失效回退、收尾周边）。

## 目录

- **第一编 · 问题与目标**（§1–§5）：问题全景、术语表、根本判断、seed 契约、相关文档地图
- **第二编 · 投影正确性**（§6–§9）：落定后快照、拓扑序、失效回退、周边状态收尾
- **第三编 · 投影边界**（§10–§11）：工具块只读历史、模型中立化
- **第四编 · 双向投影实现规格**（§12–§13）：pi 投影算法、dsh 投影算法
- **第五编 · 切换状态机与并发**（§14–§15）：状态机、并发护栏
- **第六编 · 安全与权限**（§16）
- **第七编 · 迁移与回滚**（§17）
- **第八编 · 反模式**（§18）
- **第九编 · QA**（§19）
- **第十编 · 实现要点清单**（§20）

---

# 第一编 · 问题与目标

## §1 问题全景：切内核时"同步协议"到底同步什么

### 1.1 一句话问题

desktop 是会话的**真相源**（壳持有稳定 id + 中性消息流 + lineage 树），pi 和 dsh 是两个同级内核。用户在同一条会话里 pi ↔ dsh 来回切时，desktop 必须把这条中性会话**映射**到目标内核的私有会话形态去——pi 是 JSONL 文件 + `parentId` 树，dsh 是 append-only log + session forest。这个"映射 + 把另一套协议同步过去"的动作，就是 `switchKernel` 的全部难点。

### 1.2 为什么是难点：三个根本原因

**① 存储形状处处相反。** pi 的会话是"文件 + 行级 `parentId` 树"，fork 是文件内分叉；dsh 的会话是"进程内 session forest + 子会话"，fork 是子会话。同一个"分叉"概念，两边的物理表达完全不同。要把 pi 的树"同步"到 dsh 的 forest，没有一个直接对应的字段映射，必须经过一层**中立 lineage 树**做中间态。

**② 在飞回合的收尾时序。** 切换要快照"到目前为止的 transcript"，但如果此刻有一条流式生成还在跑，快照就会读到"半截消息"或"丢掉刚中止的半轮"。什么时候快照、怎么等它落定，是一个真实的竞态，不是 sleep 能解决的。

**③ 会话身份是双轨的。** desktop 的 `neutralSessionId` 稳定不变，但每个内核各有自己的私有 id（pi=文件路径，dsh=不透明 session id）。切换时私有 id 要换绑，回切时要能找回上一次的私有 id，而私有 id 可能已经失效（被删/被压缩/被回收）。

### 1.3 现状代码的缺口全景

对照 `kernel-gap-audit.md`，当前 `switchKernel`（`core/application/sessions/session-store.ts`）的缺口：

| 缺口 | 位置 | 性质 |
|---|---|---|
| 在飞回合 `abort()` 后不等落定就快照 | `switchKernel` 第 1–2 步 | 时序竞态，可能丢半截消息 |
| `seed` 依赖 `getTree` 返回顺序（父先于子） | `PiBackend.seed` 的 `idMap` 解析 | 正确性，投影可能挂错父 |
| 回切命中绑定后无失效检测 | `switchKernel` 第 4–5 步 | 数据丢失，静默开空会话 |
| 切完不重注入 system prompt | `switchKernel` 的 `factory.create` | 一致性，角色卡丢失 |
| 切完会话头 kernel 归属不重绑 | `switchKernel` 尾部 | 一致性，头里 kernel 过期 |
| 切完快照基线残留旧内核 | `switchKernel` 尾部 | 一致性，renderer 显示旧内核 |

### 1.4 目标

- **可来回切**：pi → dsh → pi 任意次数，消息流续接正确、历史不丢、fork 关系不丢。
- **投影正确**：在飞回合先落定；lineage 树按拓扑序投影；边界 id 解析不挂错父。
- **失效可恢复**：回切时私有 id 失效，自动拿中性树重新投影，不静默开空会话。
- **切完自洽**：system prompt、会话头 kernel、快照基线、renderer 内核标，切完全部跟上。
- **不泄漏内核**：desktop 全程只认 `NeutralSession` 与 `BaseBackend` 契约，不读任何一方存储、不写内核专属形状。

### 1.4.1 范围裁决：fork 重建是"pi 原生 / dsh 降级"的非对称现状

`multi-kernel-settings-and-model-display.md` §3.6 说"第一期只支持无 fork 线性 lineage，有 fork 的会话切换入口降级"。本文据此**如实标注两边的真实接线程度**（已核对 `deepseek-harness` SDK server 源码）：

| 内核 | fork 树重建 | 现状 |
|---|---|---|
| **pi** | ✅ 原生重建 | `PiBackend.seed` 已按 `parentId` 树重建（§12），分支 lineage 挂对父 |
| **dsh** | ❌ 只搬根 lineage | dsh 服务端 `session/seed` 只取 `session.lineages[0]`（根），**分支 lineage 被静默丢弃**，方法注释明写 "Forked lineages … are follow-ups" |

**裁决**：

- **pi 方向**：fork 原生重建纳入本期（拓扑序 + 边界归一，§7/§12）。
- **dsh 方向**：fork 重建是 dsh 服务端的 follow-up，**本期降级**——切到 dsh 时只 seed 根 lineage，分支显式降级 + 告警（不静默伪造"已重建 fork"）。这与 §3.6 的降级纪律一致，不是"做半截"，而是"如实标注内核能力缺面"（能力拉平三分法第 3 条：显式降级）。
- **前置待办**：dsh 服务端 `session/seed` 补 fork 重建（把 `lineages` 全量投影成子会话），补上后本裁决自动升级为"dsh 原生"。此项列入 §20 清单。

这个非对称不是架构缺陷，而是"内核能力缺面"的诚实暴露——中立 `NeutralSession` 已经能表达 fork 树，缺的是 dsh 服务端这一侧的投影实现。

### 1.5 现状代码逐行审计

把当前 `switchKernel`（`core/application/sessions/session-store.ts`）逐段摆出来，标注每一段的正确性问题，作为本文各卡点的对照底稿。

**第 1–2 步：abort + 快照**

```ts
await proc.backend.abort().catch(() => {});        // (a)
const session = await this.snapshotNeutralSession(proc); // (b)
```

- (a) 的问题：`abort()` resolve 只代表"命令被内核接受"，不代表"那轮已落定"。若此刻有流式生成，`messageEnd(stopped)` 还没 append 进存储。
- (b) 的问题：紧跟着读 `getTree/getEntries`，读到的是"abort 发出后、落定前"的中间态——可能丢半截消息（若 entry 还没写）或读脏快照（若 entry 是 `pending`）。
- **正确性结论**：§6 卡点一。

**第 3 步：stop 旧内核**

```ts
await proc.backend.stop();
```

- 这段本身没问题（走 SubprocessHandle 的 stop 链）。但要注意：stop 之后 `proc.backend` 的 `getTree/getEntries` 已经不可用，所以快照必须在 stop **之前**完成（当前顺序是对的，只是少了"落定"这一环）。

**第 4 步：查绑定 + 建新后端**

```ts
const binding = this.bindingStore?.get(proc.neutralSessionId, target) ?? null;
const newBackend = this.factory.create({
  cwd: proc.cwd,
  agentDir: this.agentDir,
  kernel: target,
  ...(binding ? { sessionId: binding.kernelPrivateId } : {}),
});
```

- 问题一：`factory.create` 没传 `systemPromptPaths/systemPromptTexts`，而 `createProc`（首次 spawn）传了。切换后角色卡/系统提示丢失 → §9.1。
- 问题二：命中绑定就直接 `sessionId: binding.kernelPrivateId`，没有任何"这个私有 id 还活着吗"的校验 → §8。

**第 5 步：seed 或 resume**

```ts
let newSessionId: string;
if (binding) {
  newSessionId = binding.kernelPrivateId;   // 直接信,不校验
} else {
  newSessionId = await newBackend.seed(session);  // 首切才 seed
  this.bindingStore?.put({ ... });
}
```

- 问题一：`binding` 分支完全跳过 `seed`，且不校验 `kernelPrivateId` 是否还指向有效会话。pi 侧 `--session <path>` 对不存在的文件懒建空会话 → 历史静默丢失 → §8。
- 问题二：`seed(session)` 的入参 `session` 来自第 2 步快照，其 `lineages` 顺序依赖 `getTree` 返回顺序（pi 恰好根在前，dsh 无保证）→ §7。

**第 6 步：模型中立化**

```ts
const cur = this.latestSnapshot?.state.model;
if (cur && this.modelCatalog) {
  const ref = { ref: classifyModel(cur) };
  const resolved = this.modelCatalog.resolveModel(target, ref);
  if (resolved) await newBackend.setModel(resolved.provider, resolved.model).catch(() => {});
}
```

- 这段方向正确（档位分类 → resolveModel 目标内核模型）。但 `classifyModel(cur)` 依赖 `cur.reasoning`，而 `latestSnapshot.state.model` 是投影后的 `ModelInfo`，`reasoning` 字段未必有 → 档位分类退化为"仅按 id 含 flash 判断"，可能把 reasoning 模型误判成 pro → §11 的已知取舍。

**尾部：重绑**

```ts
proc.backend = newBackend;
proc.kernel = target;
proc.kernelSessionId = newSessionId;
proc.boundSessionPath = target === "pi" ? newSessionId : null;
proc.configSnapshot = this.captureConfigSnapshot();
this.bindProcEvents(proc);
```

- 问题：重绑了 `boundSessionPath`，但**没**重绑会话头里的 `kernel`（`custom-my-harness-desktop.kernel`）、**没**重置 `latestSnapshot`（切到 dsh 后还是旧 pi 的基线）、**没**广播内核切换信号 → §9.2/§9.3。

**`snapshotNeutralSession` 逐行**

```ts
const tree = await proc.backend.getTree(sessionId);
const lineages = await Promise.all(tree.lineages.map(async (l) => {
  const entries = await proc.backend.getEntries(l.id);
  return {
    lineageId: l.id,
    fork: l.fork ? { parentLineageId: l.fork.parentLineageId, boundaryEntryId: l.fork.boundary } : null,
    entries: entries.map((msg, i) => ({ neutralEntryId: neutralEntryId(l.id, i), message: msg })),
  };
}));
```

- 问题一：`tree.lineages` 顺序直接沿用，没做拓扑排序 → §7。
- 问题二（blocker）：`kernelEntryId` 没填（`NeutralEntry.kernelEntryId` 留空），而 `boundaryEntryId` 直接赋了 `l.fork.boundary`（后端私有 id）。两个坐标系混用 → `PiBackend.seed` 的 `idMap`（以 `neutralEntryId` 为键）`get(boundaryEntryId)` 恒 miss → 分支全挂根，fork 树被拍平。**这是真 bug，不是"无影响"** → §7.4 的坐标归一。
- 问题三：`Promise.all` 并发 `getEntries`，不同 lineage 的读取顺序与完成顺序无关（`Promise.all` 保序），但**依赖 `tree.lineages` 已有序**。

## §2 术语表（与 `session-neutral-layer.md` §4 互补）

| 术语 | 含义 |
|---|---|
| **真相源** | desktop 持有的 `NeutralSession`，跨内核稳定，可重放 |
| **投影** | 把中性树翻译成某个内核私有会话形态的动作（`seed`），单向 |
| **seed** | `BaseBackend.seed(NeutralSession) → sessionId`，跨内核切换的唯一同步原语 |
| **绑定** | `SessionBindingStore` 里 `(neutralSessionId, kernel) → kernelPrivateId` 的一行 |
| **落定** | 在飞回合被 abort 后，`agentSettled`（或带 `stopped` 的 `messageEnd`）已发出、transcript 不再变 |
| **拓扑序** | lineage 按 `fork.parentLineageId` 依赖排，父先于子 |
| **失效回退** | 回切时私有 id 失效 → 拿已快照的中性树重新 `seed` 并覆盖绑定 |
| **内核标** | renderer 三处显标（空态 logo / 下拉触发按钮 / assistant 消息头）的内核归属 |

## §3 根本判断：单向投影，不是双向同步

### 3.1 真相源与投影

desktop 持有的 `NeutralSession` 是**真相源**，内核的私有会话是**投影**。切换永远只有 `desktop → 内核` 一个方向：把中性树 `seed` 到新内核，从不"从内核读回存储重建 desktop"。

### 3.2 为什么不能双向

pi 是 JSONL + `parentId` 树，dsh 是 append-only log + session forest，两边的存储形状处处相反。一旦允许"从内核读回来补 desktop"，就等于让壳去理解内核的存储格式——这是 `kernel-design-spec.md` §7.5 不变量 #1（"壳不读任何内核的存储"）的违反，冲击波反向炸进圆心。双向同步还会引入"两个真相源哪个为准"的裁决难题，而单向投影把这个难题在机制上消解了：**desktop 永远对**。

### 3.3 推论：`seed` 是唯一同步原语

"同步"的落地就是 `seed`。desktop 只要一份权威中性树，就能在任何时候向任何一个内核重新投影。这也是失效回退（§8）能成立的前提——真相源可重放，投影丢了就再投一次。

### 3.4 与"消费而非翻译"的关系

`kernel-design-spec.md` §3.1 说"消费而非翻译"，多内核下的边界是：**适配器翻译是允许的、必要的**（把 pi 三态事件 / dsh `assistant/chunk` 增量都投成同一套中性事件），禁止的是"让 dsh 装 pi"的翻译层。本文的投影正是这条边界的落地：两边都投成 `NeutralSession`，壳只认中性树；pi/dsh 各自的 `seed` 是把中性树**翻译**成自己的私有形态，而不是让 dsh 去重建 pi 的 `parentId` 树。

## §4 同步原语 `seed` 的完整契约

### 4.1 签名与语义

```ts
// core/domain/backend.ts —— BaseBackend
/** 从一段中立会话树起步,返回新会话在内核侧的标识(不透明;pi=文件路径,dsh=子会话 id)。
 *  跨内核切换(§3.6)第 5 步:把旧内核的中立会话树 seed 到新内核,树能重建,fork 不丢。 */
seed(session: NeutralSession): Promise<string>;
```

语义：让内核开一个"已含这段中立历史"的新会话，返回该会话的内核侧 session-id。这是**造一段新历史再续**，与 `resume`（续"内核自己的会话"）正交。

### 4.2 `NeutralSession` wire 形状逐字段

`core/domain/session-neutral.ts`：

```ts
interface NeutralSession {
  neutralSessionId: string;          // 壳生成、跨内核稳定
  header: { kernel: KernelId; cwd: string; createdAt: string };
  lineages: NeutralLineage[];
}
interface NeutralLineage {
  lineageId: string;                 // 中立 lineage id
  fork: { parentLineageId: string; boundaryEntryId: string } | null;  // null=根
  entries: NeutralEntry[];
}
interface NeutralEntry {
  neutralEntryId: string;            // {lineageId}:{seq},稳定跨内核不变
  kernelEntryId?: string;            // 内核私有 entry id(opaque 线索,仅 adapter 用)
  message: NeutralMessage;           // role/content/...
}
```

每个字段的跨内核语义：

- `neutralSessionId`：投影后 `seed` 返回的私有 id 与它绑定（§8 的 bindingStore 键）。
- `lineageId`：pi 侧投影成"分支锚点条目 id"，dsh 侧投影成"子会话 id"。
- `fork.boundaryEntryId`：指向**父 lineage 的某条 entry 的中立 id**（`{lineageId}:{seq}`），**不是**内核私有 id。投影时必须在父 lineage 的 `entries` 里命中。快照侧要做**坐标系归一**：把后端返回的私有 boundary（`l.fork.boundary`，pi=entryId / dsh=seq）反查成中立 id（§7.4）。
- `neutralEntryId`：`{lineageId}:{seq}`，seq 是 0-based 序号，内容稳定时跨内核不变。
- `kernelEntryId`：内核私有 entry id（`getEntries` 返回的 `message.id`），opaque 线索。**必须填充**——它是 `boundaryEntryId` 归一（私有 boundary → 中立 id）的唯一反查键。

### 4.3 幂等性

`seed` 的幂等语义：对同一份 `NeutralSession` 调两次，应产生**两个独立但内容相同的私有会话**（不要求返回同一个 id）。幂等不是"去重"，而是"可重放不产生错误"。失效回退（§8）依赖这条：重新 `seed` 是安全的。

### 4.4 失败语义

`seed` 失败（目标内核没接线、协议错、磁盘写失败）→ 抛错，`switchKernel` 第 5 步 catch 里 `newBackend.stop()` 收尾并外抛，切换不静默降级。这是"显式降级"纪律：seed 是六条意图的硬依赖，补不了就报错，不伪造成功。

### 4.5 seed 与 start 的生命周期不对称（必须分内核）

`BaseBackend` 契约的调用顺序是 `start()` → `seed()`，但两个内核的 seed 对进程的依赖相反：

| 内核 | seed 性质 | 对进程的依赖 | 正确顺序 |
|---|---|---|---|
| **pi** | 纯文件写（写 JSONL，不 spawn 不 RPC） | 不依赖进程 | **seed 先于 start**：先写文件得路径，再以该路径 `--session <path>` spawn |
| **dsh** | `session/seed` JSON-RPC | 依赖进程（initialize 就绪后） | **start 先于 seed**：先 spawn，再 RPC seed，再重绑 `this.sessionId` |

- **pi 侧**：当前"先 `start()` 再 `seed()`"是错的——`start()` 已按 `--session`（或默认）spawn 了进程，`seed()` 写出的新文件是**孤儿**（运行中的进程不指向它）。正确做法是首切 pi 时"先 `seed` 得路径，再以该路径 `create + start`"。
  - **注意（blocker 级）**：不能用 `factory.create("pi")` 当"只 seed 不起进程"的探针——`createPiBackend` 在构造 `PiSubprocessHandle` 时就 `spawn()` 了进程，且 `RpcAdapter.stop()` 在 `!this.started` 时提前 return 不调 `handle.stop()`，探针进程既不 start 也不 stop，每次首切 pi 泄漏一个孤儿进程。
  - **正确做法**：pi seed 提为**不 spawn 的纯函数**（自由函数 `piSeedSession(agentDir, cwd, session): string`，或 `PiBackend` 的静态方法），`switchKernel` 调它拿路径，再以该路径 `factory.create({sessionId: path})` + `start()`。`PiBackend.seed`（实例方法）保留给契约，内部委托这个纯函数。
- **dsh 侧**：`start()`（initialize 握手）→ `seed()`（RPC）→ 重绑 `this.sessionId`。顺序与契约一致。
- **契约结论**：`seed` 的契约注明"pi 侧不依赖进程存活（可纯函数化）、dsh 侧依赖进程存活"，`switchKernel` 据此分两支编排（§9.5）。这不是内核泄漏，是"seed 生命周期"这一契约面的正当不对称（与 `kernel-gap-audit.md` G3 的协议不对称同类）。

## §5 相关文档地图

| 文档 | 关系 |
|---|---|
| `kernel-design-spec.md` | 六条意图 + `BaseBackend` 契约 + 能力拉平三层次 |
| `session-neutral-layer.md` | 中立坐标系 + seed 契约形状（本文的上半篇） |
| `base-interface-lineage.md` | lineage 坐标系、`getTree`/`getEntries`/`bookmark`/`resume` |
| `multi-kernel-settings-and-model-display.md` | §3.6 跨内核切换五步 + 工具边界 + fork 边界 |
| `kernel-gap-audit.md` | 本文各缺口的实证扫描来源（G2/G5/P0） |

---

# 第二编 · 投影正确性

## §6 卡点一：在飞回合落定后才快照

### 6.1 现状逐行

```ts
// session-store.ts switchKernel 第 1–2 步
await proc.backend.abort().catch(() => {});        // 命令被接受 ≠ 那轮已收尾
const session = await this.snapshotNeutralSession(proc); // 可能读到半截/丢失消息
```

`abort()` 只代表内核接受了中止命令，不代表 `messageEnd(stopped)` 已经落地。此刻 `getTree/getEntries` 可能读到一条**还没 append 的半截 assistant**，或**丢掉刚被中止的那半轮**。注释写"收尾后再快照"，代码没兑现。

### 6.2 竞态时序

```
t0  用户点切内核 → switchKernel
t1  abort() 发出(内核收到)
t2  abort() resolve(命令被接受,但 agent loop 还在收尾)
t3  snapshotNeutralSession → getTree/getEntries  ← 此刻那轮还没落定
t4  messageEnd(stopped) 才 append 进存储
```

t3 在 t4 之前快照，导致 t4 的"已中止的半轮"要么没进快照（丢历史），要么 t3 读到一条 `pending` 未定稿的消息（脏快照）。

### 6.3 解法：事件驱动落定

`abort()` 之后订阅 `onSessionEvent(proc.key)`，等到落定事件再 resolve：

- **落定判据**：`agentSettled`（agent loop 收敛）或带 `stopped`/`error` 的 `messageEnd`。**补**：`compactionEnd` / `autoRetryEnd(success !== true)` 也是 busy 翻转事件——`dispatch` 里 `compactionStart/End`、`autoRetryStart/End` 都置 `busyStates`，abort 时若正压缩/重试，只有这两个事件能清 busy，漏了它们会空等满 8s。
- **超时兜底**：超时（如 8s，对齐 `ABORT_TIMEOUT_MS`）视为"已尽力"，照快照，不空等、也不让一条卡死的工具把切换永久卡住。
- **不做轮询不 sleep**：订阅事件 + 一次性 Promise，呼应 `kernel-design-spec.md` §3.6。

伪代码：

```ts
async function waitSettled(proc: SessionProc, timeoutMs: number): Promise<void> {
  if (!this.isBusy(proc.key)) return;            // 没在忙,直接快照
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    const done = (): void => { clearTimeout(timer); off(); resolve(); };
    const off = this.onSessionEvent(proc.key, (ev) => {
      if (ev.type === "agentSettled") done();
      else if (ev.type === "messageEnd") {
        const stop = (ev as { message?: { stopped?: boolean; error?: boolean } }).message;
        if (stop?.stopped || stop?.error) done();   // 带 stopped/error 的 messageEnd 也是落定
      }
      else if (ev.type === "compactionEnd") done();                       // 压缩收尾也清 busy
      else if (ev.type === "autoRetryEnd" && (ev as { success?: boolean }).success !== true) done();
    });
  });
}
// switchKernel 第 1–2 步改为:
await proc.backend.abort().catch(() => {});
await this.waitSettled(proc, ABORT_TIMEOUT_MS);
const session = await this.snapshotNeutralSession(proc);
```

**落定判据的完整性**：`agentSettled` 是主判据（agent loop 收敛）；带 `stopped`/`error` 的 `messageEnd` 是补充判据（有些内核/路径 abort 后直接收尾 messageEnd 而不发 agentSettled）。两个都订，避免"abort 已触发 stop 链、agentSettled 永不发"时 `waitSettled` 空等满 8s。超时兜底仍在（有界等待）。

### 6.4 失败语义

abort 超时（内核卡死）→ 走 stop 的 kill 链（关 stdin → SIGTERM → SIGKILL），transcript 里这条消息标「已停止」，照快照。与 `multi-kernel-settings-and-model-display.md` §3.6 第 1 步一致。注意 `waitSettled` 超时 resolve 后，快照仍会读到"半截"，但这是"内核卡死"这种极端情况下的尽力而为，语义诚实（标「已停止」而非伪造"完整"）。

### 6.5 测试规格

- 流式生成中点切内核：断言快照里那条消息是 `stopped` 定稿，不是 `pending`。
- abort 不响应（工具卡死）→ 超时兜底仍完成切换，不永久挂起。
- 空闲态切换：`waitSettled` 直接返回，不额外等。

## §7 卡点二：`seed` 的拓扑序——父 lineage 先于子分支

### 7.1 现状

`PiBackend.seed` 用 `idMap` 把 `fork.boundaryEntryId`（中立 id）解析成分叉点的 pi entryId，再挂 `parentId`。这个解析要求**父 lineage 先写、分支后写**，否则 `idMap.get(boundaryEntryId)` 命中不了，退回 `?? null` 挂错父。

### 7.2 为什么父先于子

`fork.boundaryEntryId` 指向父 lineage 的某条 entry。投影是"边写边记 `idMap`"，只有父 lineage 写完后，父侧所有 entry 的中立 id → pi id 的映射才完整；分支 lineage 开写时才能从 `idMap` 查到自己的分叉点。父后于子，分叉点必然缺失 → 挂到 null（根），树的父子关系错乱。

### 7.3 拓扑排序算法（纯函数，放圆心）

排序规则：`fork.parentLineageId` 指向谁，谁在前。根 lineage（`fork === null`）排最前。

- **有环**（数据损坏）：DFS 遇 `visiting` 已含的节点直接 return（不无限递归），环内按 DFS 发现序输出——**不是"原顺序"**，是有界降级。环是损坏数据，只要"不挂死 + 不丢节点"即可，顺序本身无保证可言。
- **`parentLineageId` 悬空**（指向不存在的父）：按无父处理（当根），显式告警，不抛错中断整个切换——悬空父是"父分支丢了"的退化，宁可降级为独立根也不拖垮整次切换。

```ts
// core/domain/session-neutral.ts(零依赖纯函数)
export function sortLineagesTopologically(lineages: NeutralLineage[]): NeutralLineage[] {
  const byId = new Map(lineages.map((l) => [l.lineageId, l]));
  const out: NeutralLineage[] = [];
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (l: NeutralLineage): void => {
    if (done.has(l.lineageId)) return;
    if (visiting.has(l.lineageId)) return; // 环:降级为已访问,不无限递归
    visiting.add(l.lineageId);
    if (l.fork) {
      const parent = byId.get(l.fork.parentLineageId);
      if (parent) visit(parent);
    }
    visiting.delete(l.lineageId);
    done.add(l.lineageId);
    out.push(l);
  };
  for (const l of lineages) visit(l);
  return out;
}
```

落点：在 `snapshotNeutralSession`（快照出口）对 `tree.lineages` 排一次，`seed` 拿到的 `session.lineages` 天然满足父子序，两个 adapter 都不用各自再排序。

### 7.4 边界归一：私有 `boundary` → 中立 `boundaryEntryId`（按内核分形状）

这是 fork 投影能否成立的前提（blocker 级）。`getTree` 返回的 `l.fork.boundary` 是**内核私有 id**，而 `NeutralLineage.fork.boundaryEntryId` 要求是**中立 id**（`{lineageId}:{seq}`）。两者坐标系不同，不能直接赋值——否则 `PiBackend.seed` 的 `idMap.get(boundaryEntryId)` 恒 miss，分支全挂根。

**关键：两边的私有 `boundary` 形状不同，归一算法不能写一套通用的**：

| 内核 | `getTree` 的 `fork.boundary` | `getEntries` 的 `message.id` | 能否反查命中 |
|---|---|---|---|
| **pi** | entryId（JSONL 行级 id） | entryId（同源） | ✅ 能：`boundary === message.id` |
| **dsh** | `seedLength - 1`（原始事件流 seq，含 step/start 等非消息事件） | message UUID | ❌ 不能：两者坐标系不同 |

**pi 归一**（`snapshotNeutralSession` 里，两遍）：

1. **第一遍**：逐 lineage 读 `getEntries`，每条 entry 记 `kernelEntryId = message.id`（pi 下就是后端 entryId），生成 `neutralEntryId = neutralEntryId(lineageId, seq)`。
2. **第二遍**：对有 fork 的 lineage，在父 lineage 的 `entries` 里反查 `kernelEntryId === l.fork.boundary`，取其 `neutralEntryId` 作 `boundaryEntryId`。反查不到 → 显式降级（§7.4 末）。

```ts
const byLineage = new Map(lineages.map((l) => [l.lineageId, l]));
for (const l of lineages) {
  if (!l.fork) continue;
  const parent = byLineage.get(l.fork.parentLineageId);
  const anchor = parent?.entries.find((e) => e.kernelEntryId === l.fork.boundary);
  l.fork.boundaryEntryId = anchor?.neutralEntryId ?? /* 降级 */ "";
}
```

- **pi 隐藏条目边缘**：若 pi 的 fork 点落在 `custom`/`session` 类型条目，`sessionEntryToNeutral` 返回 null、该条目不进 `entries`，`kernelEntryId === boundary` 反查失败——即便 pi 也会误降级。兜底：反查不到时按"boundary 落在父 lineage 两条 entry 之间的位置"推断，而不是仅按 id 命中；再不行才降级。

**dsh 归一（当前不接线，降级）**：dsh 的 `boundary`（事件 seq）与 `getEntries` 的 `message.id`（UUID）坐标系不同，且 `session-neutral-layer.md` §11.4 把"中立 seq = lineage 内消息 0-based 序号"误当成了"dsh boundarySeq"（后者是原始事件流序号，含 `step/start`/`session/end-seed` 等，不对齐）。所以 dsh 侧 fork 归一**需要 `DshBackend.getTree/getEntries` 额外暴露每条 entry 的 seq 才能做**，当前未接线 → dsh 侧 fork 直接降级（只搬根 lineage，§1.4.1/§13.2）。这不是"写统一算法"能解决的，是 dsh 适配器侧的补面。

- **边界裁决**：反查不到（或内核侧 fork 未接线）时，显式降级（fork 关系标缺失，分支按根处理 + 告警），不静默伪造"成功重建 fork"。与 `multi-kernel-settings-and-model-display.md` §3.6 的"有 fork 先降级"同一纪律。

### 7.5 测试规格

- 构造"根 → 分支1 → 分支1 的分支"三级树，断言 seed 后的 `parentId` 链正确。
- 构造"分支先于父"的乱序输入，断言排序后父在前。
- 构造有环的 lineage（损坏数据），断言不无限递归、不丢节点（DFS 发现序即可）。
- 构造 `parentLineageId` 悬空的 lineage，断言按根处理 + 告警、不抛错中断切换。

## §8 卡点三：回切私有 id 失效 → 重新投影

### 8.1 现状

`SessionBindingStore` 主键 `(neutralSessionId, kernel)`，首切 `seed` 后写绑定，回切读绑定直接 `sessionId: binding.kernelPrivateId` 续上、**不 seed**。问题：私有 id 可能已经失效（内核侧会话被删、被压缩、dsh 子会话被回收），当前代码没有失效检测——pi 侧 `--session <path>` 对不存在的文件会**懒建一个空会话**，历史静默丢失；dsh 侧初始化可能报错或开新会话。

### 8.2 失效场景枚举

| 场景 | pi | dsh |
|---|---|---|
| 会话文件被手动删 | `--session <path>` 懒建空会话 | 不适用 |
| 会话被压缩/清理 | 文件被替换，旧 entry 不在 | 子会话被回收 |
| dsh 进程重启后 session id 失效 | 不适用 | SDK RPC 面只读内存 `ctx.sessions`，不懒加载持久化 |
| 绑定写了一半（崩溃） | 绑定指向不存在的路径 | 绑定指向失效 id |
| **切离即不可续（dsh 特有）** | 不适用 | `switchKernel` 每次 stop 旧后端，新进程的 `getTree` 只查内存会话 |

**dsh 绑定的失效根因（已核对 deepseek-harness 源码）**：dsh 会话**不是进程内易失**——存在 `sessionPersistence`（SQLite 落盘，`session/list`/`projectStats` 都从持久化读）。真正的现象是：**新 dsh 进程的 `getTree`/`getEntries` 只读内存 `ctx.sessions`，不懒加载持久化会话**，所以回切绑定在当前 RPC 面下查不到旧会话 → `isBindingValid` 失效 → 每次进 dsh 都重新 seed。

- 有一条可用的恢复路径：`ctx.agents.resume`（`session/setModel` 里已用）可从持久化恢复会话。若 dsh 侧把"按 sessionId 懒加载持久化会话"补进 `getTree`/`getEntries` 面，绑定就能真正可续。
- **本期结论**：在 dsh 补懒加载之前，"每次进 dsh 必重新 seed"成立，接受两个后果：① 每次进 dsh 累积一个孤儿子会话（需回收）；② "回切找回私有 id"这一支对 dsh 实际不命中。

### 8.3 解法：resume + 校验 + 回退 seed

绑定是"找回的捷径"，不是"必须命中的真相源"。回切命中绑定后：

1. 先按私有 id 打开/续接（现状 `sessionId: binding.kernelPrivateId`）。
2. **校验续接结果**：判定标准是"目标会话是否还持有预期历史"。
3. **失效 → 落到 `seed` 重新投影并覆盖绑定**（`bindingStore.put` 同主键去重，天然覆盖）。

关键：**中性树在 `switchKernel` 第 2 步已经快照出来了**，所以失效回退不需要额外读，直接拿这份 `session` 重新 `seed`。真相源可重放，投影丢了就再投一次——这正是 §3 单向投影的红利。

**对 §18.1（"每次切都重新 seed 是反模式"）的修正**：该反模式只对 **pi 成立**（pi 是文件持久化，绑定可长期有效、回切应走 resume）。对 **dsh 不成立**——dsh 内存态使"每次进 dsh 必重新 seed"成为既定事实，反模式退化为"**孤儿子会话要回收**"（`deleteBookmark`/`session/delete` 清理上一次的 dsh 子会话），不是"不要 seed"。

### 8.4 校验的判定标准（pi/dsh 各自）

- **pi**：`sessionId` 是文件路径，**经 `SessionCatalog` 读**（`catalog.open(sessionId)` 返回 null = 不存在，返回 detail 且 `messages.length > 0` = 非空）——不直读文件系统，守"壳不读内核存储"（§7.5 不变量 #1）。文件不存在 / 只有头行（空会话）→ 失效。
- **dsh**：`sessionId` 是不透明 id，靠运行时回话——`newBackend.getTree(sessionId)` 是否返回有效树。报错 / 空树 → 失效（且 §8.2 已知 dsh 当前不懒加载持久化，此校验对 dsh 恒失效 → 每次进 dsh 必 seed）。

伪代码（**仅为绑定校验逻辑草图，完整生命周期顺序见 §9.5**——此处不展开 pi 先 seed 后 start / dsh 先 start 后 seed 的分支）：

```ts
// switchKernel 第 4–5 步改造(绑定校验逻辑,顺序细节以 §9.5 为准)
const binding = this.bindingStore?.get(proc.neutralSessionId, target) ?? null;
const valid = binding && await this.isBindingValid(binding.kernelPrivateId, target);
// valid → 以 binding.kernelPrivateId 续接(不 seed)
// !valid → seed(session) 得新 id + put 覆盖绑定
// 具体 create/start/seed 顺序按内核分两支,见 §4.5/§9.5
```

### 8.5 测试规格

- 首切 seed 后删 pi 文件 → 回切：断言走了 `seed`（新文件路径），绑定被覆盖，历史不丢。
- 回切命中有效绑定：断言不 seed（`seed` 不被调用）。
- dsh 侧回话报错 → 回退 seed。

## §9 卡点四：切换后周边状态收尾

切完内核，`proc.backend/kernel/kernelSessionId/boundSessionPath` 重绑了，但三样东西漏了，"来回切"体感最明显：

| 缺口 | 现状 | 解法 |
|---|---|---|
| **system prompt 丢失** | `switchKernel` 的 `factory.create` 只传 `cwd/agentDir/kernel/sessionId`，没传 `systemPromptPaths/systemPromptTexts`（`createProc` 传了） | `factory.create` 补 `systemPromptPaths: this.getSystemPromptPaths()`，与 `createProc` 同源 |
| **会话头 kernel 归属没重绑** | `boundSessionPath` 重绑了，头里 `custom-my-harness-desktop.kernel`（或中性 `header.kernel`）没同步 | 切换后把新 kernel 写回头（`catalog.updateHeader` 或中性 store） |
| **快照基线残留旧内核** | 切到 dsh 后 `latestSnapshot` 还是旧 pi 的（dsh 无 `get_state` 面） | 切换后把基线重置/清空并广播，renderer 三处内核标（§3.5）跟着切 |

前两条是 `kernel-gap-audit.md` §3 已标注的既有缺口，本文把它们从"缺口清单"收进"投影动作的必做步骤"。第三条是本次补的：**切换本身要广播一个中性信号**（复用 `system:sessionChanged` 或新增 `system:kernelChanged`，payload 只带"会话 id + 新内核"），让依赖内核身份的订阅方同步，而不是各自轮询。

### 9.1 system prompt 重注入细节（路径 + 角色卡两样都补）

`createProc` 传了两样：`systemPromptPaths: this.getSystemPromptPaths()`（插件贡献的系统提示文件）与 `systemPromptTexts: role ? [roleToPrompt(role)] : undefined`（会话级角色卡）。`switchKernel` 的 `factory.create` 当前两样都没传。

- **systemPromptPaths**：切换时**重新拉取**（`this.getSystemPromptPaths()`），不是缓存旧值——切换前用户可能改了插件贡献。
- **systemPromptTexts（角色卡）**：`role` 只在 `createProc` 的入参里、没存进 `SessionProc`，切换时拿不到。解法：`SessionProc` 新增 `role?: SessionRole` 字段，`createProc` 存进去，切换时 `proc.role ? [roleToPrompt(proc.role)] : undefined` 重注入。**只补 `systemPromptPaths` 不补角色卡，"角色卡不丢"就是空话。**
- 注意 dsh 侧 `BackendCreateOptions.systemPromptPaths/Texts` 当前是"dsh 忽略"（见 `backend.ts` 注释），所以 pi 侧是主战场；但契约上仍应传，保持两个 adapter 入口一致。

### 9.2 会话头 kernel 重绑细节

中性 `header.kernel`（`NeutralSession.header.kernel`）是快照时的旧内核；切换后应写回新内核。

- **pi 落点**：`catalog.updateHeader(path, { custom: { kernel } })` 写 pi 头行 `custom-my-harness-desktop.kernel`——但注意当前 `session-store` 的 `catalog` getter 写死 `catalogFactory.create("pi")`，dsh 侧没有可用的 catalog 面。pi 侧可行，dsh 侧头写回缺机制。
- **dsh 落点缺口**：dsh 的 `session/updateHeader` 面**已存在**（`dsh-catalog.ts` 已实现 `updateHeader`），真正缺的是 `session-store` 的 `catalog` getter 写死 `create("pi")`、**不按 `proc.kernel` 路由**，导致 `catalog.updateHeader(dsh sessionId)` 走了 pi 实现。需补一个按 kernel 路由的 catalog 面（`catalogFor(kernel)`），或退化为"dsh 头不写 kernel、只靠 bindingStore 记内核归属"。
- **中性落点**：`neutralStore.put`（`NeutralSession` 持久化）是内核无关的，`header.kernel` 写这里最干净——但读回路径（打开会话读 kernel）目前只认 pi 头行，中性 store 的读回未接线。

**裁决**：本期把 kernel 归属的**真相源收口到 bindingStore**（`(neutralSessionId, kernel) → kernelPrivateId`，已有），头行 kernel 只是展示层冗余。pi 头行照写（顺手），dsh 头行不写（无机制），打开会话读回走 bindingStore 反查。避免为"展示层冗余"补一整套 dsh catalog 头写机制。

### 9.3 快照基线重置与广播

切到 dsh 后 `latestSnapshot` 还是旧 pi 的（dsh 无 `get_state` 面，`sync` 已降级为 no-op）。解法：`switchKernel` 尾部把 `this.latestSnapshot = null`（pi→dsh）或触发一次 `sync`（dsh→pi，pi 有快照面），并广播 `system:kernelChanged`。renderer 消费该信号刷新三处内核标，不再显示旧内核的模型/状态。

**依赖陷阱（与 §11 模型的耦合，方向要捋清）**：模型中立化（第 6 步）读 `this.latestSnapshot?.state.model`，而清基线（第 8 步）把它置 null。但**"清基线前缓存 `curModel`"只救同一次 `switchKernel`（pi→dsh）**——dsh→pi 回切时 `latestSnapshot` 早在上次切 dsh 时就被置 null（dsh 无 `get_state` 面、`sync` 是 no-op），缓存到的 `curModel` 恒为 null，救不了 dsh→pi。

**正解：模型引用要有跨切换的持久载体**。`latestSnapshot` 是内核投影态的临时基线，不该承担"跨切换模型记忆"的职责。把模型中立引用落成一个**随 SessionProc 存活的字段**：

```ts
// SessionProc 新增
lastModelRef: NeutralModelRef | null;   // 最近一次 setModel 时的中立引用(档位分类)
```

- `setModel` 成功后在 `proc.lastModelRef = { ref: classifyModel(model) }` 更新。
- `switchKernel` 第 6 步读 `proc.lastModelRef`（不是 `latestSnapshot.state.model`），跨切换不丢。
- 首切（尚无 setModel 记录）时 `lastModelRef` 为 null → 跳过模型解析、落目标内核默认模型（显式降级，§11）。

这样模型中立化经受得住完整 pi→dsh→pi 往返，不依赖"当前内核有没有快照面"。

### 9.4 测试规格

- 切内核后断言 `factory.create` 收到的 `systemPromptPaths` 非空。
- 切内核后断言会话头/中性 header 的 `kernel` 是目标内核。
- 切内核后断言 renderer 收到 `system:kernelChanged`，payload 只有"会话 id + 新内核"。

### 9.5 重写后的 `switchKernel` 完整伪代码

把 §6–§9 的解法合起来，给出一个参考实现骨架（不逐行对齐现有类，只表达正确顺序与护栏）：

```ts
async switchKernel(target: "pi" | "dsh"): Promise<void> {
  const proc = this.activeProc();
  if (!proc || !proc.backend.alive) throw new Error("底座未启动");
  if (proc.kernel === target) return;
  if (this.switching) throw new Error("切换进行中");        // §15.1 互斥
  this.switching = true;
  const key = proc.key;
  try {
    // 1. abort + 落定(§6)
    await proc.backend.abort().catch(() => {});
    await this.waitSettled(proc, ABORT_TIMEOUT_MS);
    // 2. 快照 + 拓扑排序 + 边界归一(§7)
    const session = await this.snapshotNeutralSession(proc);  // 内部已做 §7.4 坐标归一
    session.lineages = sortLineagesTopologically(session.lineages);
    // 3. stop 旧内核
    await proc.backend.stop();
    // 并发护栏:stop 的 await 窗口内激活态被切走则中止(§15.3)
    if (this.activeProcKey !== key) throw new Error("切换被并发上下文切换打断");
    // 4. 查绑定
    const binding = this.bindingStore?.get(proc.neutralSessionId, target) ?? null;
    let newBackend: BaseBackend;
    let newSessionId: string;
    // 5. resume 或 seed,按内核分生命周期(§4.5)
    if (binding && await this.isBindingValid(binding.kernelPrivateId, target)) {
      // 回切:私有 id 有效,直接续接(不 seed)
      newBackend = this.factory.create({
        cwd: proc.cwd, agentDir: this.agentDir, kernel: target,
        systemPromptPaths: this.getSystemPromptPaths(),       // §9.1
        systemPromptTexts: proc.role ? [roleToPrompt(proc.role)] : undefined,  // §9.1 角色卡
        sessionId: binding.kernelPrivateId,
      });
      await newBackend.start();
      newSessionId = binding.kernelPrivateId;
    } else if (target === "pi") {
      // 首切 pi:seed 先于 start(§4.5)。pi seed 用不 spawn 的纯函数,避免 factory.create 泄漏孤儿进程
      newSessionId = piSeedSession(this.agentDir, proc.cwd, session);  // 纯文件写得路径
      newBackend = this.factory.create({
        cwd: proc.cwd, agentDir: this.agentDir, kernel: "pi",
        systemPromptPaths: this.getSystemPromptPaths(),
        systemPromptTexts: proc.role ? [roleToPrompt(proc.role)] : undefined,
        sessionId: newSessionId,                              // 以 seed 路径 spawn
      });
      await newBackend.start();
      this.bindingStore?.put({ kernel: "pi", neutralSessionId: proc.neutralSessionId,
        kernelPrivateId: newSessionId, boundAt: new Date().toISOString() });
    } else {
      // 首切 dsh:start 先于 seed(dsh seed 是 RPC,依赖进程,§4.5)
      newBackend = this.factory.create({
        cwd: proc.cwd, agentDir: this.agentDir, kernel: "dsh",
        systemPromptPaths: this.getSystemPromptPaths(),
      });
      await newBackend.start();
      newSessionId = await newBackend.seed(session);          // seed 内部 this.sessionId = res.sessionId(§13.1)
      this.bindingStore?.put({ kernel: "dsh", neutralSessionId: proc.neutralSessionId,
        kernelPrivateId: newSessionId, boundAt: new Date().toISOString() });
    }
    // 6. 模型中立化(§11,读 proc.lastModelRef 跨切换载体,不读 latestSnapshot——后者在 dsh 下恒 null)
    if (proc.lastModelRef && this.modelCatalog) {
      const resolved = this.modelCatalog.resolveModel(target, proc.lastModelRef);
      if (resolved) await newBackend.setModel(resolved.provider, resolved.model).catch(() => {});
    }
    // 7. 重绑(§9)
    proc.backend = newBackend;
    proc.kernel = target;
    proc.kernelSessionId = newSessionId;
    proc.boundSessionPath = target === "pi" ? newSessionId : null;
    proc.configSnapshot = this.captureConfigSnapshot();
    this.bindProcEvents(proc);
    // 8. 周边收尾(§9.2/§9.3)
    await this.writeKernelToHeader(proc, target).catch(() => {});
    this.latestSnapshot = target === "pi" ? await this.sync().catch(() => null) : null;
    this.broadcastKernelChanged(proc.neutralSessionId, target);
  } finally {
    this.switching = false;
  }
}
```

关键点：

- `try/finally` 保证 `switching` 标记一定清。
- **第 6 步读 `proc.lastModelRef`**（跨切换载体，§9.3/§11），不读 `latestSnapshot`——后者在 dsh 下恒 null，读它 dsh→pi 模型不回切。
- **第 5 步分三支**：回切（绑定有效）直接续接；首切 pi 走"seed 先于 start"（`piSeedSession` 纯函数得路径，再以该路径 create+start，不泄漏孤儿进程）；首切 dsh 走"start 先于 seed"（seed 内部重绑 `this.sessionId`）。
- **`proc.role` 是新增字段**（§9.1）：`createProc` 里把 `role` 存进 `SessionProc`，切换时才能重注入 `systemPromptTexts`。
- **`proc.lastModelRef` 是新增字段**（§9.3/§11）：`setModel` 成功时更新，`switchKernel` 读它做模型中立化。

---

# 第三编 · 投影边界

## §10 卡点五：工具块只读历史，不重跑

### 10.1 规则

工具调用/结果是内核侧产物（pi 的 bash、dsh 的工具卡）。跨内核投影的规则（`multi-kernel-settings-and-model-display.md` §3.6 工具边界）：

- **保留**：`NeutralMessage` 里的工具块原样 seed 过去，新内核当"只读历史"显示（用户能看到完整上下文）。
- **不重跑**：新内核不重新执行旧内核的工具。后续若要用旧工具产物，由用户/内核自己在消息里补，壳不替它"重跑"。

### 10.2 投影器保 `toolCallId` 关联

`toolCallId` 是"工具调用 ↔ 工具结果"的配对键。`PiBackend.seed` 已写 `if (typeof msg.toolCallId === "string") message.toolCallId = msg.toolCallId`——`toolResult` 消息顶层的 `toolCallId`（`sessionEntryToNeutral` 透传）已被写入。所以这一条**不是待补，是已覆盖**；真正要盯的是"投影器别在重构消息时丢了这个字段"（§12.6/§12.7 的字段保真边界统一管）。

字段保真清单（`PiBackend.seed` 写入集）：

| 字段 | 状态 | 说明 |
|---|---|---|
| `role` | ✅ | user/assistant/toolResult |
| `content` | ✅ | 文本或内容块 |
| `toolName` | ✅ | 工具卡名 |
| `toolCallId` | ✅ | 工具调用↔结果配对键（toolResult 顶层同字段） |
| `usage` | ✅（§12.7 补） | token/cost 统计 |
| `stopReason`/`error` | ✅（§12.7 补） | 停止/错误语义 |

### 10.3 测试规格

- 含"工具调用 + 工具结果"的 transcript 跨内核 seed 后，回放时结果能关联到调用。
- 工具块在新内核里是只读历史（不被重新执行）。

## §11 卡点六：模型中立化（已收口）

模型引用不跨内核直接搬 provider/id，而是走"档位分类 → `resolveModel(target)`"映射（`ModelCatalog`，`session-neutral-layer.md` §20–§21）。

已落地（提交 `696b2c6`）：`SessionStore.setModel` 经 `ModelCatalog` 反查模型归属内核，属别的内核先 `switchKernel` 再在同内核 `setModel`；`switchKernel` 第 6 步用 `resolveModel(target, ref)` 做档位对齐。这条与 `seed` 是同一套思路——**desktop 只传中性引用，adapter 翻译成内核专属形状**。

**跨切换载体（本文补）**：模型中立引用要有跨切换的持久载体 `SessionProc.lastModelRef`（§9.3），不能依赖 `latestSnapshot.state.model`（dsh 下恒 null）。`setModel` 成功时写 `lastModelRef`，`switchKernel` 第 6 步读它做 `resolveModel(target, lastModelRef)`。

---

# 第四编 · 双向投影实现规格

## §12 pi 投影完整算法（`PiBackend.seed`）

### 12.1 JSONL 头行

```ts
const path = join(agentDir, "sessions", cwdToBucketName(cwd), `${randomUUID()}.jsonl`);
const lines = [JSON.stringify({ type: "session", id, timestamp, cwd, "custom-my-harness-desktop": { kernel: "pi" } })];
```

头行记 `kernel: "pi"`，供打开会话读回内核归属（§9.2 的另一半）。

### 12.2 `parentId` 树重建

根 lineage 线性挂 `parentId`（每条指向上一条）；分支 lineage 从 `fork.boundaryEntryId` 解析出的 pi entryId 处挂 `parentId`。`idMap`（中立 entryId → pi entryId）在写的过程中累积。

### 12.3 `idMap` 与 `boundaryEntryId`

```ts
const idMap = new Map<string, string>(); // neutralEntryId → pi entryId
const writeEntry = (entry, parentPiId) => {
  const piId = entry.kernelEntryId ?? randomUUID();
  // ...写行,记录 idMap.set(entry.neutralEntryId, piId)
  return piId;
};
// 分支 lineage 的第一条:
let prevId = lineage.fork ? (idMap.get(lineage.fork.boundaryEntryId) ?? null) : null;
```

关键：`idMap.get` 命中的前提是父 lineage 已写（§7 拓扑序保证）。`?? null` 是兜底，正常态不该触发。

### 12.4 工具块字段

见 §10.2，投影器要补 `toolResult.toolCallId`。

### 12.5 拓扑序

`PiBackend.seed` 收到 `session.lineages` 时应已是拓扑序（§7.3 在快照出口排过）。为防御，`seed` 内部可再断言/不依赖外部排序（幂等，§4.3）。

### 12.6 完整伪代码

```ts
async seed(session: NeutralSession): Promise<string> {
  const sessionId = randomUUID();
  const dir = join(this.ctx.agentDir, "sessions", cwdToBucketName(this.ctx.cwd));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);            // §16.3 路径不自取外部字段
  const lines: string[] = [JSON.stringify({
    type: "session", id: sessionId,
    timestamp: new Date().toISOString(), cwd: this.ctx.cwd,
    "custom-my-harness-desktop": { kernel: "pi" },
  })];
  const idMap = new Map<string, string>();                  // neutralEntryId → pi entryId

  const writeEntry = (entry: NeutralEntry, parentPiId: string | null): string => {
    const piId = entry.kernelEntryId ?? randomUUID();       // §4.2 opaque 线索
    const msg = entry.message;
    const message: Record<string, unknown> = { role: msg.role, content: msg.content ?? "" };
    if (typeof msg.toolName === "string") message.toolName = msg.toolName;
    if (typeof msg.toolCallId === "string") message.toolCallId = msg.toolCallId;  // §10.2 工具块关联
    if (msg.usage != null) message.usage = msg.usage;       // §12.7 保 token/cost 统计
    if (typeof msg.stopReason === "string") message.stopReason = msg.stopReason;
    if (msg.error === true) message.error = true;
    if (typeof msg.startedAt === "number") message.startedAt = msg.startedAt;
    const ts = typeof msg.timestamp === "number"
      ? new Date(msg.timestamp).toISOString() : new Date().toISOString();
    const e: Record<string, unknown> = { type: "message", id: piId, timestamp: ts, message };
    if (parentPiId) e.parentId = parentPiId;
    lines.push(JSON.stringify(e));
    idMap.set(entry.neutralEntryId, piId);
    return piId;
  };

  // session.lineages 已拓扑序(§7):父先于子,idMap 在分支引用父边界时必命中
  for (const lineage of session.lineages) {
    let prevId: string | null = null;
    if (lineage.fork) {
      prevId = idMap.get(lineage.fork.boundaryEntryId) ?? null;   // 兜底 null=挂根(正常态不触发)
    }
    for (const entry of lineage.entries) {
      if (!["user", "assistant", "toolResult"].includes(entry.message.role)) continue; // 只搬可见角色
      prevId = writeEntry(entry, prevId);
    }
  }
  await writeFile(path, lines.join("\n") + "\n", "utf-8");
  return path;
}
```

注意：`role` 白名单 `["user","assistant","toolResult"]` 是"只搬可见角色"的边界——`model_change`/`thinking_level_change` 等分隔线类条目不进投影（它们是内核侧展示细节，不是会话历史真相）。这条边界出自 `multi-kernel-settings-and-model-display.md` §3.6 工具边界（"user 消息 + assistant 文本跨内核，工具块只读"）。

### 12.7 投影的字段保真边界（usage/stopReason/error/id）

`NeutralMessage` 有索引签名 `[key: string]: unknown`，`usage`/`stopReason`/`error`/`startedAt`/`id` 都随 `getEntries` 透传在消息对象上。投影器若只搬 `role/content/toolName/toolCallId`，这些字段就**静默丢失**，跨内核后：

- **`usage`（token/cost）丢失**：项目统计（`pi-catalog` 的 `projectStats`、会话 `getStats`）读 `message.usage`，切回后该条消息的用量归零 → 成本/上下文/Token 统计失真。
- **`stopReason`/`error` 丢失**：被中止/出错的消息回放时不再标"已停止/错误"，时间线语义变。
- **`id` 丢失**：`id` 是 patch 锚点（`applyEvent` 按 id 定位），但投影时 `id` 要换成**目标内核的私有 entry id**（= `writeEntry` 里的 `piId`），不能原样照搬旧内核 id（旧 id 在新内核里无意义、还可能撞 id）。

**保真规则**：`usage`/`stopReason`/`error`/`startedAt` 这类**语义字段原样搬**；`id` 这类**身份字段换成目标内核的新 id**（`kernelEntryId ?? randomUUID()`）。dsh 侧 `session/seed` 同理——`NeutralSession` JSON 里的 `usage`/`stopReason` 等要透传，不能只挑 role/content。

这是"投影边界"的另一半：**什么跨（语义字段）**、**什么重命名（身份字段）**。与 §10 的工具块"只读历史不重跑"是同一套边界纪律。

## §13 dsh 投影完整算法（`DshBackend.seed`）

### 13.1 `session/seed` wire

```ts
async seed(session: NeutralSession): Promise<string> {
  const res = await this.transport.request<{ sessionId: string }>("session/seed", {
    sessionId: session.neutralSessionId,
    session,  // 整棵 NeutralSession JSON 原样传
  });
  this.sessionId = res.sessionId;   // 关键:重绑后续操作的目标会话
  return res.sessionId;
}
```

**关键（blocker 级）**：`DshBackend.seed` 必须把返回的 `res.sessionId` 写回 `this.sessionId`。当前 `sendMessage`/`abort`/`setModel` 全部读构造时的 `this.sessionId`（首切时 = `cwdToBucketName(cwd)` 桶名），不重绑则首切 pi→dsh 后所有消息都发到桶名会话而不是 seed 出的子会话。

desktop **不替 dsh 翻译 forest**——dsh 服务端自己把 `NeutralSession` 投影成 session forest。

### 13.2 session forest 投影（现状：只根 lineage，分支降级）

dsh 服务端 `session/seed` 的**当前实现只取 `session.lineages[0]`（根 lineage）**，`entriesToSeedEvents(root.entries, ...)` 只搬根；其余分支 lineage 被静默忽略，方法注释明写 "Forked lineages and tool-loop reconstruction are follow-ups"。所以：

- **本期**：切到 dsh 只 seed 根 lineage；若有分支 lineage，desktop 显式告警降级（§1.4.1），不伪造"fork 已重建"。
- **终态（dsh 服务端 follow-up）**：根 lineage 投影成父会话、分支 lineage 投影成子会话，`fork.boundaryEntryId` 由 dsh 服务端解析成分叉 seq。

desktop 只见 `seed → sessionId`，不替 dsh 翻译 forest——缺的是 dsh 服务端这一侧的投影实现，不是 desktop 的职责。

### 13.3 边界归一

dsh 的 seq 与 lineage id 可能混用，`getTree` 返回的分叉点 id 与 `getEntries` 条目 id 坐标系不一致时，适配器在投影前归一（`session-neutral-layer.md` §11.4）。

---

# 第五编 · 切换状态机与并发

## §14 切换的状态机

### 14.1 状态枚举

| 状态 | 含义 | 触发 |
|---|---|---|
| `idle` | 无切换进行 | 初始 / 切换完成 |
| `aborting` | 已发 abort，等落定 | switchKernel 第 1 步 |
| `snapshotting` | 快照中性树 | 落定后 |
| `seeding` | spawn 新内核 + seed | 第 4–5 步 |
| `rebinding` | 重绑 proc + 收尾周边 | 第 6 步起 |

### 14.2 状态转移

```
idle → aborting → snapshotting → seeding → rebinding → idle
        ↑超时兜底(卡死→stop kill 链→照快照)         ↑失败回滚
```

失败回滚：`seeding` 的 `seed` 失败 → `newBackend.stop()` + 外抛（§4.4），**不回滚旧内核**（旧内核已 stop，回滚 = 重新 spawn 旧内核，代价高；失败显形让用户重试）。

### 14.3 与 `busyStates`/`streaming` 的关系

`aborting` 阶段 `waitSettled` 依赖 `busyStates`（`isBusy(proc.key)`）判"是否在忙"。`agentSettled` 清 `busyStates`，这是落定判据的来源。切换期间 `streaming` 应置位（renderer 已有的 `switching` 状态），阻止并发发送。

## §15 并发与竞态分析

### 15.1 切换期间用户再点切

`switchKernel` 开头 `if (proc.kernel === target) return` 只拦"同目标"，不拦"切换中再切"。解法：新增 `switching` 布尔标记（`SessionStore` 私有字段，**本文新提**，不是 `setContext` 已有——renderer store 里那个 `switching` 是另一处 UI 态，main 侧 session-store 无此字段），切换期间再点切 → 拒绝/排队，不并发跑两个 `switchKernel`。

### 15.2 切换期间发消息

`prompt` 的 `ensureForSend` 会 `activeProc()` 取 proc 并发消息。若切换进行中（proc 正在被替换），发消息会命中"半换"的 proc。解法：`ensureForSend` 校验 `switching` 标记，切换中抛"切换进行中"（对齐 §6.5 的 `forkFromSession` 竞态护栏思路）。

### 15.3 切换期间 `setContext`

`setContext` 会把 `activeProcKey` 切走。若切换的 `await` 窗口内插入 `setContext`，切换收尾要校验"激活态没被切走"（`this.activeProcKey === key`），否则不重绑错 proc。

### 15.4 护栏汇总

| 竞态 | 护栏 |
|---|---|
| 切换中再点切 | `switching` 标记拒绝并发切换 |
| 切换中发消息 | `ensureForSend` 校验 `switching` |
| 切换中 `setContext` | 收尾校验 `activeProcKey` 未变 |

---

# 第六编 · 安全与权限

## §16 投影的安全边界

### 16.1 seed 数据不可信

`seed` 的入参 `NeutralSession` 来自**旧内核**（`getTree`/`getEntries` 的回放），不是 desktop 自己构造的。投影器必须把它当不可信输入：`content` 可能是任意结构，`kernelEntryId`/`neutralEntryId` 可能是任意字符串。投影器写 JSONL / 发 JSON-RPC 前不做语义假设，只做结构化映射，不 eval、不执行。

**图片消息边界**：user 消息可能带 image 内容块（`content` 数组里的 `{type:"image", data/...}`）。pi 侧 `seed` 的 `content` 原样写入 JSONL 可行（JSONL 能承载）；dsh 侧 `session/seed` 对 image 块的处理**未指定**，且 `kernel-gap-audit.md` G5 明确 dsh"图片输入未接线"。裁决：图片历史的跨内核投影**显式降级**——dsh 侧 seed 时图片块按"无法重放"丢弃或标注占位，不静默伪造成功；pi 侧原样保留。这是 dsh 图片能力缺面的延伸（能力拉平三分法第 3 条：显式降级）。

### 16.2 工具块注入风险

工具块是旧内核产物，投影时当只读历史（§10），**绝不重跑**。这同时是一条安全边界：重跑旧内核的 bash/工具 = 在用户无感知下重新执行历史命令，是注入面。只读历史从机制上关掉了这个面。

### 16.3 路径圈禁

pi 投影写 JSONL 的目标路径由 `seed` 内部 `join(agentDir, "sessions", cwdToBucketName(cwd), uuid)` 生成，不取 `neutralSessionId`/`kernelEntryId` 作为路径成分——防止恶意中性树把文件写到任意路径。

---

# 第七编 · 迁移与回滚

## §17 分阶段落地与回滚

### 17.1 分阶段（每阶段独立可用、独立提交）

| 阶段 | 内容 | 依赖 | 验证 |
|---|---|---|---|
| A | §6 落定后快照 | 无 | 流式中切换不丢半截 |
| B | §7 拓扑排序（圆心纯函数 + 快照出口调用） | 无 | 乱序 lineage 投影正确 |
| C | §8 失效回退 | A/B（依赖快照中性树） | 删文件回切不丢历史 |
| D | §9 周边状态收尾 | 无 | 切完三处状态自洽 |
| E | §15 并发护栏 | A–D | 并发切换/发送不崩 |
| F | §10 工具块关联 | 无 | 工具卡↔结果配对 |

### 17.2 回滚

每一阶段是独立 commit，回滚 = revert 该 commit。数据层不动：`bindingStore`、`neutralStore`、会话文件都是追加/覆盖语义，回滚代码不迁移数据。

---

# 第八编 · 反模式

## §18 反模式

- **18.1 每次切都重新 seed（仅对 pi 成立）**：回切应走绑定找回私有 id（§8），只在失效时回退 seed。每次都 seed 会累积孤儿会话 + 丢 fork 关联。**例外**：dsh 的 session forest 是进程内的，切离即销毁，每次进 dsh 必重新 seed（§8.2）——对 dsh 这条反模式退化为"孤儿子会话要回收"，不是"不要 seed"。
- **18.2 把私有 id 当真相源**：私有 id 会失效，真相源是中性树。绑定只是捷径。
- **18.3 快照前不等落定**：在飞回合没 `agentSettled` 就快照，会读到半截消息（§6）。
- **18.4 从内核读回重建 desktop**：违反单向投影，让壳理解内核存储（§3）。
- **18.5 seed 依赖 `getTree` 返回顺序**：父子序是投影正确性硬前提，必须显式拓扑排序（§7）。
- **18.6 切换中不加锁**：两个并发 `switchKernel` 会互相覆盖 proc，必须 `switching` 标记互斥（§15）。
- **18.7 把内核专属形状写进 NeutralSession**：`NeutralSession` 里塞 `parentId`/`childSessionId` 就是泄漏。中立树只放中立字段（§4.2）。

---

# 第九编 · QA

**Q：为什么"同步"是单向投影，不是双向？**

双向会让壳理解内核存储（违反 §7.5 不变量 #1），且引入"两个真相源哪个为准"的裁决难题。单向投影把难题在机制上消解：desktop 永远对，投影丢了就再投一次。

**Q：失效回退会不会每次都 seed，退化回"每次都重新 seed"的反模式？**

不会。回切命中有效绑定走 resume（不 seed），只在失效时回退 seed。失效是例外路径，不是常态。

**Q：拓扑排序为什么放圆心，不放 adapter？**

它是纯函数、零依赖、两个 adapter 共用，符合"圆心只放纯函数"（§2.2）与"同一逻辑收进内层统一承担"（§1.1 判别气味三）。adapter 不各自写一遍排序。

**Q：dsh 无 `get_state` 面，切换后 renderer 怎么知道新内核？**

靠 `system:kernelChanged` 广播（§9.3）。payload 只带中性"会话 id + 新内核"，renderer 三处内核标订阅它，不各自轮询。

**Q：切换失败能回滚吗？**

`seed` 失败 → `newBackend.stop()` + 外抛，不回滚旧内核（旧内核已 stop，回滚 = 重新 spawn，代价高）。失败显形让用户重试，这是"显式降级"，不伪造成功。

---

# 第十编 · 实现要点清单（照着落地）

## §20 清单

**正确性（投影）**

- [ ] §6：`switchKernel` 第 1 步 abort 后 `waitSettled` 等 `agentSettled`/带 stopped 的 `messageEnd`/`compactionEnd`/`autoRetryEnd(success!==true)`（超时兜底），再快照。
- [ ] §7：圆心加 `sortLineagesTopologically` + **边界归一**（pi 反查 entryId；dsh 侧 fork 归一未接线 → 降级），`snapshotNeutralSession` 出口调用。
- [ ] §8：`switchKernel` 加 `isBindingValid` 校验（pi 走 `catalog.open` 不直读文件）+ 失效回退 seed + 覆盖绑定；dsh 每次进必 seed + 孤儿回收。
- [ ] §1.4.1：dsh 侧 fork seed 未接线（服务端只搬根 lineage）——列为 dsh 服务端前置待办，本期降级。

**一致性（收尾）**

- [ ] §9.1：`factory.create` 补 `systemPromptPaths` + `systemPromptTexts`（`SessionProc` 新增 `role` 字段存角色卡）。
- [ ] §9.2：kernel 归属真相源收口 bindingStore；pi 头行照写，dsh 头行不写（无机制，读回走 bindingStore）。
- [ ] §9.3：模型中立化读 `proc.lastModelRef`（不读 `latestSnapshot`），再重置 `latestSnapshot` + 广播 `system:kernelChanged`。

**生命周期（seed/start 顺序）**

- [ ] §4.5：pi 首切"seed 先于 start"（`piSeedSession` 纯函数，不 spawn 不泄漏孤儿进程）；dsh 首切"start 先于 seed"。
- [ ] §13.1：`DshBackend.seed` 内部 `this.sessionId = res.sessionId`。

**模型中立化载体**

- [ ] §9.3/§11：`SessionProc` 新增 `lastModelRef`，`setModel` 成功时写，`switchKernel` 第 6 步读它（不读 `latestSnapshot`）。

**边界**

- [ ] §10/§12.7：`PiBackend.seed` 保 `toolCallId`/`usage`/`stopReason`/`error`/`startedAt`，`id` 换目标内核 id。
- [ ] §11：模型中立化已收口（`696b2c6`），无需动作。
- [ ] §16.1：dsh 图片历史显式降级（不静默伪造）。

**并发**

- [ ] §15：新增 `switching` 标记互斥 + `ensureForSend`/收尾校验激活态。

**安全**

- [ ] §16：pi 投影路径不取外部字段、工具块只读不重跑。

**测试**

- [ ] §6.5/§7.5/§8.5/§9.4/§10.3 各卡点的测试规格。
- [ ] 同一套断言参数化：先 `createPiBackend` 跑、再 `createDshBackend` 跑，差异只在适配器，壳插件代码零改动（参数化测试策略见 `multi-kernel-settings-and-model-display.md` §5.4 阶段四）。

---

# 附录 A · 端到端故事

一次完整的 pi → dsh → pi 来回切，串起全文各卡点：

**① 会话在 pi 上跑。** 用户发了三轮消息，其中一轮带了 `bash` 工具调用。此刻 pi 侧是 `~/.pi/agent/sessions/<bucket>/<uuid>.jsonl`，desktop 记 `neutralSessionId = N`，绑定 `(N, pi) → 文件路径`，`latestSnapshot` 是 pi 的 `get_state` 基线。

**② 用户选了个 dsh 模型。** `setModel("us-new", "bifrost/tencent/deepseek-v4-pro")` 经 `ModelCatalog` 反查到 `kernel = "dsh"` ≠ 当前 `pi`，路由进 `switchKernel("dsh")`。

**③ 落定 + 快照。** 若此刻还有一轮在流式，先 `abort()`，`waitSettled` 等到 `agentSettled` 再快照（§6）——那半轮以 `stopped` 定稿进快照，不丢。`snapshotNeutralSession` 读 `getTree`（根 lineage + 若有 fork 的分支），`getEntries` 逐条投影成 `NeutralEntry`，`sortLineagesTopologically` 排成父先于子（§7）。

**④ stop pi + 首切 seed。** 无 dsh 绑定 → `newBackend.seed(session)`。dsh 服务端把 `NeutralSession` 投影成 session forest（根会话 + 子会话），返回 dsh session id。desktop 写绑定 `(N, dsh) → dshSessionId`。工具块当只读历史投喂，不重跑（§10）。

**⑤ 切完收尾。** `factory.create` 已带 `systemPromptPaths` + `systemPromptTexts`（系统提示与角色卡都不丢，§9.1），kernel 归属写回 bindingStore（§9.2），模型引用存在 `proc.lastModelRef` 供下次回切恢复（§9.3），`latestSnapshot = null`（dsh 无快照面）+ 广播 `system:kernelChanged`。renderer 三处内核标切 🐋。

**⑥ 用户在 dsh 上继续聊。** 消息走 `DshBackend.sendMessage` → `session/prompt`，事件经 `dsh-event-translator` 投成中性事件，timeline 无感。

**⑦ 用户又选回 pi 模型。** `setModel` 反查 `kernel = "pi"` → `switchKernel("pi")`。这次命中绑定 `(N, pi) → 文件路径`，`isBindingValid` 校验文件还在且非空 → 直接 `sessionId: 文件路径` 续上，**不 seed**（§8）。若文件早被删了，`isBindingValid` 判失效 → 拿第 3 步快照的中性树重新 `seed` 一个新 pi 文件，覆盖绑定，历史不丢。

**⑧ 回切收尾。** pi 有 `get_state` 面 → `sync()` 重拉基线，renderer 内核标切 ⬡。

整个来回里，desktop 只认 `NeutralSession` 和 `BaseBackend` 六条意图，没读过一个 JSONL 的 `parentId`、没拼过一个 dsh 的 forest——换内核 = 换投影实现，壳一行不动。这就是"中间转换层"的完整兑现。
