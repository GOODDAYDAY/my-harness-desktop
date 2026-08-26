# 内核无 fork：分叉归壳，内核单线执行

> 本文是 `session-neutral-layer.md` / `neutral-session-first.md` 的**推进篇**。那两篇把会话的内容、身份、坐标都中立化了，但**「fork」这个动作至今还留在内核里**——pi 的 `fork` 命令切新文件、dsh 的 `session/fork` 开子会话，两个内核各自"复制一份 + 生成一个新 id"。本文把它整个推翻：**内核根本不 fork。分叉是壳在中立层的纯操作；内核退化成"单线执行器"，只在「发起」（发消息 / 切分支 / 切内核）时被 seed 投影一条 lineage。**
>
> 一句话主线：**换分支 = 换投影，和「换内核 = 换投影」是同一个道理。**

## 目录

- **第一编 · 问题与目标**（§1–§4）：三个偏离、目标、核心原则、术语表
- **第二编 · 现状全链路走查**（§5–§9）：fork / 映射表 / switchKernel / bookmark / prompt 的现状，逐点标注"新模型删还是改"
- **第三编 · 数据模型**（§10–§13）：中立树完整形状、`lineageContent` 纯函数、id 派生、seed 投影规则
- **第四编 · 机制**（§14–§16）：fork 纯中立、seed 幂等投影、切分支、切内核、同步收窄
- **第五编 · 双内核实现**（§17–§19）：pi 侧、dsh 侧、降级与缺面
- **第六编 · 契约变更**（§20–§23）：去 fork、seed 改签名、getTree 降级、回改清单
- **第七编 · 一致性、竞态与失败**（§24–§26）：幂等与派生确定性、并发护栏、回滚与恢复
- **第八编 · 迁移路径**（§27）：四阶段详述
- **第九编 · 边界与反模式**（§28–§29）
- **第十编 · 与 CLAUDE.md 纪律的对照**（§30–§31）
- **第十一编 · 渲染层与插件面的迁移**（§32–§35）：主键迁移、fork 不再新增条目、连带插件、四阶段归属
- **第十二编 · 端到端故事**（§36）
- **第十三编 · QA**（§37）
- **第十四编 · 实现要点清单**（§38）

---

# 第一编 · 问题与目标

## §1 问题：fork 至今仍是内核动作（三个偏离）

`session-neutral-layer.md` §9 已经说了"fork 走中立版本：先切中立树，再投影到后端"，但"投影"那一步**仍调 `backend.fork`**。于是两个内核各自"复制 + 生成新 id"：

- **pi**：`fork(entryId, "at")` → 底座复制会话文件、切到**一个新文件**，新文件路径由底座生成，壳靠 `resync → state.sessionFile` 读回（`pi-backend.ts:333–345`）。
- **dsh**：`session/fork(parentSessionId, boundarySeq)` → 服务端拷贝事件前缀、开**一个子会话**，`childSessionId` 由服务端生成返回（`dsh-backend.ts:223–229`）。

由此带出三个偏离。三个偏离同根：**fork 这个"分叉"动作被错误地派给了内核，而分叉本质上是"会话结构"的事，结构是壳的资产，不是内核的能力。**

### 1.1 偏离一：fork 产生「内核自生成的 id」，逼出映射表

壳在中立层已经先生成了 `newLineageId = randomUUID()`（`session-store.ts:1448`），内核 fork 又生成它自己的 id（pi 新文件路径 / dsh childSessionId）——**一次 fork 产生两个 id**。

于是出现一个多对一、且随时间增长的关系：一个 `neutralSessionId`，在 pi 下对应「根文件 + 若干 fork 文件」多个路径，在 dsh 下对应「主会话 + 若干 childSessionId」多个 id。为了在 pi→dsh→pi 来回切时找回原会话，就逼出 `SessionBindingStore` 这张 `(neutralSessionId, kernel) → kernelPrivateId` 的映射表（`session-binding-store.ts`）。

用户点破问题本质：**"fork 就是复制一份，然后生成一份新的 id"**——那这个新 id 为什么不干脆由壳来定？内核自生成 id，是这张表存在的唯一理由。

### 1.2 偏离二：内核持有分叉树，壳被迫读内核存储

因为内核 fork 把分支结构物化进了内核存储（pi 的 parentId 树 / dsh 的 session forest），壳在三个地方都得**从内核读树**才能把结构拿回来：

| 壳的动作 | 读内核的方式 |
|---|---|
| `snapshotNeutralSession`（`session-store.ts:848`） | `getTree` + 逐 lineage `getEntries`，全量重建中立树 |
| `openSession`（`session-store.ts:645`） | `SessionCatalog.open` 读内核文件 + `getTree` |
| `switchKernel` 第 2 步（`session-store.ts:893`） | 快照全树，同上 |

这和"壳不读内核存储"（`kernel-design-spec.md` §7.5 不变量 #1）处处较劲——壳要么读内核树，要么靠映射表找私有 id，两条都别扭。根因不是某个函数放错文件，而是**内核因为会 fork，所以持有了壳该持有的树**；壳要拿回自己的树，就得回去读内核。

### 1.3 偏离三：fork 的物化是急切的，切了分支就落盘

fork 的语义被实现成了"切了立刻物化"：pi 切新文件、dsh 开子会话，**即使用户切了分支后一句话没说**，内核侧也已经多了一个文件/子会话。这是把"分叉"（一个纯结构操作）和"物化"（把结构投影到内核存储）焊死在了一起。二者本可分离：分叉是壳的事，物化只在需要跑这条分支时才发生。

---

## §2 目标：分叉归壳，内核单线

四件事：

1. **内核不 fork**：`BaseBackend.fork` 从中立契约移除。pi 的 `fork` 命令、dsh 的 `session/fork` 对壳成为死代码。
2. **fork = 壳切中立树**：`session-store.fork` 只做 `upsertNeutralLineage` + 换 `activeLineageId`，零内核参与。
3. **发起才投影**：发消息 / 切分支 / 切内核时，把**活跃 lineage 的完整线性内容** seed 进内核，然后 `sendMessage`。
4. **id 由壳在 seed 时指定（去映射表）**：内核侧会话标识 = 派生自 `lineageId` 的确定性函数，同一条 lineage 永远得到同一个内核 id——`SessionBindingStore` 整张移除。

四件事合起来就是一句话：**内核是单线执行器，壳是完整分叉树。**

---

## §3 核心原则：换分支 = 换投影

`session-neutral-layer.md` 已经确立「换内核 = 换投影实现，中立会话层一行不动」。本文把它推广一层：

> **换内核 = 换投影；换分支 = 换投影。** 内核永远只持有"当前活跃的那一条 lineage"，投影的是这一条，不是整棵树。

- **中立层**（`NeutralSessionStore` + `session-store` 持有的中立树）是壳的业务本质：树有几支、每条 lineage 的完整内容、展示元数据，全在这里。
- **内核**（pi/dsh）是**单线投影**：一次只物化一条 lineage，跑完事件回流到中立层。
- **切分支** = 把"当前活跃 lineage"从 A 投影换成 B 投影，中立树一行不改。

这是"中立层 canonical、内核是投影"这句主线**走到终点的样子**：投影的不是树，是单条 lineage，按需物化。三层职责一次钉死：

```
壳（中立层）    完整分叉树：NeutralSession.lineages[]，含 fork 关系 + 独有条目 + 展示元数据
        │  seed 投影单条 lineage（下行，只在发起时）
        ▼
内核（pi/dsh）  单线投影：一条 lineage 的物化（pi=一个 JSONL；dsh=一个 session）
        │  事件回流（上行，entryAppended → 中立层 append）
        ▼
壳（中立层）    AI 生成内容增量 append 回当前活跃 lineage
```

---

## §4 术语表（本文专用，与既有文档互补）

| 术语 | 定义 |
|---|---|
| **单线执行器** | 内核的新定位：一次只物化、只运行**一条** lineage，不知道别的分支存在。 |
| **分叉归壳** | fork 是壳在中立层的纯操作，内核不参与；内核的 `fork` 能力成为死代码。 |
| **发起** | 触发"内核需要跑某条 lineage"的三个入口：发消息、切分支、切内核。 |
| **惰性物化** | 分支只在"发起"时才被 seed 投影进内核；"切了分支没发言"不物化。 |
| **活跃 lineage** | 当前要跑的那条 lineage，由 `SessionProc.activeLineageId` 指向。 |
| **完整线性内容** | 一条 lineage 从会话起点到当前末端的全部 entry（含继承的前缀），`lineageContent` 算出。 |
| **id 派生** | 内核侧会话标识 = `lineageId` 的确定性函数（root lineageId ≡ neutralSessionId），幂等。 |
| **幂等 seed** | 同一条 lineage 每次 seed 得到同一个内核 id；切回已物化分支只重开不重写。 |
| **root 不变量** | root lineage 的 `lineageId` 恒等于 `neutralSessionId`（§12.1）。 |

---

# 第二编 · 现状全链路走查

本编把当前代码里 fork 相关的五条链路逐一走一遍，每条标注"新模型下删还是改"。目的是给迁移路径（§27）一张精确的"每步动什么"的对照底图，而不是凭印象改。

## §5 fork 的现状调用链

`session-store.fork`（`session-store.ts:1443–1468`）现在的完整序列：

```
1. newLineageId = randomUUID()                          // 中立层先生成新 lineage id
2. upsertNeutralLineage(cur, { lineageId: newLineageId,  // 中立树切出新 lineage
      fork: { parentLineageId, boundaryEntryId }, entries: [] })
3. activeLineageId = newLineageId                        // 换活跃 lineage
4. res = await backend.fork(parentLineageId, boundary)   // ← 内核 fork（偏离一/二/三的现场）
5. if (res.sessionReplaced)                              // pi=true 切新文件；dsh=false 同会话开分支
      reconcileAfterSessionReplacement(res.lineageId)    // sync 读回新文件路径 + rekeyProc + 水合
6. setSessionName(forkCopyName(...))                     // 命名"源名 (copy)"
7. return active
```

新模型下的处置，逐行：

| 行 | 现状 | 新模型 |
|---|---|---|
| 1–3 | 保留 | **保留**（这正是"分叉归壳"的正确半段） |
| 4 | `backend.fork` | **删**（内核不 fork） |
| 5 | `reconcileAfterSessionReplacement` | **删**（没有新文件要读回；`ForkResult.sessionReplaced` 随 fork 一起消失） |
| 6 | `setSessionName` | **改**：命名不再写内核（fork 没发生），改为写中立 header（§10 的 header 字段） |
| 7 | 返回 `active`（= 新文件路径） | **改**：返回 `newLineageId`（中立 lineage id） |

`forkFromSession`（`session-store.ts:1491–1563`，书签 fork 的原子用例）现状是"复制源文件到中间路径 → start → fork → 删中间副本"，这条链整条重构为"切中立 lineage → 下次发起时 seed 投影"（§27 阶段 C）。

## §6 映射表的现状生命周期

`SessionBindingStore`（`session-binding-store.ts`）现在的读写点：

| 写 | 位置 | 新模型 |
|---|---|---|
| `createProc` 里 `put({kernel, neutralSessionId, kernelPrivateId: sessionPath})` | `session-store.ts:466` | **删**（id 派生，不存） |
| `switchKernel` seed 后 `put({kernel, neutralSessionId, kernelPrivateId: newSessionId})` | `session-store.ts:940` | **删** |

| 读 | 位置 | 新模型 |
|---|---|---|
| `switchKernel` 回切查 `get(ns, target)` | `session-store.ts:899` | **改**：读中立 header 的 `kernel` 字段 + 派生 id |
| `resolveSessionKernel` 靠 dsh 绑定判定内核 | `session-store.ts:427–430` | **改**：内核归属 = `NeutralSession.header.kernel` |

附带一个反向 smell：`resolveNeutralSessionId`（`session-store.ts:414–421`）读/写内核会话头的 `custom["neutralSessionId"]`——**中立主键寄存在内核存储里**。新模型下中立主键只活在中立层自己的索引，内核头里不再藏这个字段（§27 阶段 B 第 4 项）。

## §7 switchKernel 的现状七步

`switchKernel`（`session-store.ts:879–962`）现在的七步：

```
1. abort + waitSettled（等在飞回合落定）
2. snapshotNeutralSession（getTree + 逐 lineage getEntries 全量重建中立树）
3. stop 旧内核
4. 查绑定（bindingStore.get）：命中且有效 → 回切恢复；否则 seed
   └─ isBindingValid(kernelPrivateId) = catalog.open(...) 是否读得到
5. 模型中立化（resolveModel，读 proc.lastModelRef）
6. 重绑 proc.backend / kernel / boundSessionPath
7. 收尾：writeKernelToHeader（写 custom.kernel）+ sync + dispatch kernelChanged
```

新模型下：

| 步 | 现状 | 新模型 |
|---|---|---|
| 2 | 从旧内核快照全树 | **改**：读中立层活跃 lineage（中立层本来就是最新，`neutral-session-first.md` 已把上行连续同步落地） |
| 4 | 查映射表 + `isBindingValid` 读内核 | **改**：派生 id + 幂等 seed；`isBindingValid` 删 |
| 5 | 不变 | **不变**（模型中立化是正交的） |
| 7 | `writeKernelToHeader` 写 `custom.kernel` | **改**：kernel 归属写中立 header，不写内核头 |

## §8 bookmark / resume 的现状

`bookmark`（`session-store.ts:783`）已经坐标化：`catalog.bookmark(cwd, lineageId, boundary)` 只返回中立坐标，不拷贝副本。这一半**已经是终态**，不动。

`resume`（`session-store.ts:791–802`）现状：

```
if (backend.resume && alive) return backend.resume(anchor)   // dsh：服务端子会话回切
else await forkFromSession(cwd, anchor.lineageId, anchor.entryId, "at")  // pi：现场 fork
```

新模型下：`resume` = "定位坐标 → 激活对应 lineage → 若未物化则 seed → 继续"。`backend.resume?` 和 `forkFromSession` 的"现场 fork"一起消失——fork 没了，resume 里自然也没了 fork。

`deleteBookmark`（`session-store.ts:805`）：坐标书签无副本回收，已是 no-op，不动。

## §9 prompt 的现状下行/上行

`prompt`（`session-store.ts:1103–1152`）现状：

```
1. 模型对齐（setModel）→ 强度对齐（setThinkingLevel，仅 pi）
2. appendNeutral(proc, { message: user, display })   // 中立层先写 user（乐观）
3. backend.sendMessage(text, images)                 // 后端只收纯 AI 内容（display 被过滤）
4. dispatch(sessionStart) + autoName(setSessionName)
```

上行：`entryAppended` → `syncNeutralEntry`（`session-store.ts:829`）把 AI 生成内容 append/回填进中立层。

新模型下：上行**不变**；下行在步骤 3 之前**加一个判定**——"活跃 lineage 是否已物化？未物化则先 seed"（§15）。这是唯一新增的下行时机：**下行不再在 fork 时发生，只在发起时发生。**

---

# 第三编 · 数据模型

## §10 中立会话树的完整形状

`core/domain/session-neutral.ts` 现有类型，本文要补的字段用 `+` 标出：

```ts
export interface NeutralSession {
  neutralSessionId: string;              // 会话主键（root lineageId ≡ 此值，§12.1）
  header: NeutralSessionHeader;
  lineages: NeutralLineage[];
}

export interface NeutralSessionHeader {
  kernel: KernelId;                      // 内核归属（§6 读这里，不再查映射表）
  cwd: string;
  createdAt: string;
  // + 列表行字段（§27 阶段 A，为"壳只读中立层"补齐）：
  name?: string;                         // 会话名（真相源）
  updatedAt?: string;                    // 最近修改
  lastMessage?: string;                  // 末条消息预览
  lastEntryId?: string;                  // 未读位标
  pinned?: boolean;                      // 置顶
  archived?: boolean;                    // 归档
  custom?: Record<string, unknown>;      // desktop 私有域（保留键 pinned/archived/toolConfig）
}

export interface NeutralLineage {
  lineageId: string;                     // root 恒 ≡ neutralSessionId；分支 = fork 时 randomUUID
  fork: { parentLineageId: string; boundaryEntryId: string } | null;
  entries: NeutralEntry[];               // 独有条目（分叉点之后的增量）
}

export interface NeutralEntry {
  neutralEntryId: string;                // {lineageId}:{seq}
  kernelEntryId?: string;                // 内核私有 entry id（opaque 线索，仅 adapter 用）
  message: NeutralMessage;               // AI 内容（会进投影）
  display?: DisplayMeta;                 // 展示内容（不进投影，seed 时过滤）
}
```

关键性质：

- `entries` 是**增量语义**（相对父 lineage 的独有条目），与 pi 的 parentId 树（共享前缀 + 分支增量）、dsh 的 fork 前缀拷贝天然对齐。
- `display` 永不进 seed 投影——它只给人看，`seed` 和 `sendMessage` 一样，只收 AI 内容（`message`）。

## §11 lineage 完整线性内容：`lineageContent` 纯函数

seed 要投影的是"这条 lineage 从会话起点到末端的完整内容"，不是 `entries`（那只是独有条目）。所以要一个纯函数沿 fork 链拼前缀：

```ts
// core/domain/session-neutral.ts（圆心，零依赖）
/**
 * 一条 lineage 的完整线性内容：沿 fork 链向上，取父 lineage 到分叉点为止的前缀，
 * 再拼自身独有条目。root lineage（fork=null）就是自己的 entries。
 */
export function lineageContent(session: NeutralSession, lineageId: string): NeutralEntry[] {
  const byId = new Map(session.lineages.map((l) => [l.lineageId, l]));
  const walk = (id: string, acc: NeutralEntry[]): NeutralEntry[] => {
    const l = byId.get(id);
    if (!l) return acc;                       // 悬空引用：当根处理，不抛错
    if (l.fork) {
      walk(l.fork.parentLineageId, acc);      // 先父
      // 父前缀截到 boundaryEntryId（含边界）之后的部分丢弃——分支从 boundary 之后前行
      // （fork 语义：boundary 是"已继承的最后一个完整回合"，见 session-neutral-layer.md §6）
    }
    acc.push(...l.entries);                    // 再己
    return acc;
  };
  return walk(lineageId, []);
}
```

精确语义要钉死：

1. **boundary 是"含端点的继承前缀"**：父 lineage 的条目从根到 `boundaryEntryId`（含）都继承，`boundaryEntryId` 之后的不继承。
2. **root lineage** 的完整内容 = 它自己的 `entries`（`fork = null`，无前缀）。
3. **分支 lineage** 的完整内容 = 父前缀（截到 boundary）+ 自身 `entries`。
4. **环 / 悬空引用**（损坏数据）：`walk` 里父引用悬空 → 当根处理，不无限递归、不抛错中断（与 `sortLineagesTopologically` 的防御一致，`session-neutral.ts:101`）。

这个函数是"seed 单线"和"切分支投影"共同的地基，落圆心并配单测（含环、悬空、多层嵌套分支）。

## §12 身份与 id：root 不变量 + 派生规则

### 12.1 root lineageId ≡ neutralSessionId

现状已经是这样：`createProc` 里 `activeLineageId = neutralSessionId`（`session-store.ts:469`），`appendNeutralEntry` 把根 lineage 的 `lineageId` 设成传入 id = `neutralSessionId`。把这条钉成**不变量**：

- **root lineage 的 `lineageId` 恒等于 `neutralSessionId`**。
- **分支 lineage 的 `lineageId` = fork 时 `randomUUID()`**（现状 `session-store.ts:1448` 已经是）。

这条不变量的价值：root lineage 的内核 id 直接就是 `neutralSessionId`，不需要任何二次映射；分支 lineage 的内核 id 派生自它的 `lineageId`。**整棵树的内核 id 都由 `lineageId` 决定，而 `lineageId` 全在中立层，壳自有。**

### 12.2 内核侧会话标识 = 派生自 lineageId

| 内核 | 内核侧标识 | 派生规则 | 幂等 |
|---|---|---|---|
| **dsh** | `SessionId`（值对象，可显式指定） | 直接用 `lineageId` 当 `SessionId` | ✅ 同 lineage → 同 id |
| **pi** | JSONL 文件路径 | `<agentDir>/sessions/<bucket>/<stamp>_<lineageId>.jsonl` | ✅ 同 lineage → 同路径 |

两处要点：

- **dsh 的 `SessionId` 是值对象**：dsh 会话模型里 `ctx.sessions.create(SessionId('...'), {...})` 满屏可见（deepseek-harness 仓库），id 是客户端可指定的。所以"带着 id 去 seed"对 dsh 是原生能力，`dsh-backend.ts:264` 已经传 `sessionId`，只是现在传的是 `neutralSessionId`，要改成传 `lineageId`。
- **pi 的"id"是文件路径**：pi 没有独立于路径的会话 id 层，会话就是文件。所以 pi 的派生不是"给个裸 id"，而是"派生一个路径"。路径规则是 pi 适配器的存储细节，放在 `pi-catalog.ts`（`piNewSessionPath` 的邻居），壳不碰。

### 12.3 于是映射表整张移除

`SessionBindingStore` 移除。它的三处用途各自找到归宿：

| 用途 | 归宿 |
|---|---|
| 回切恢复 `kernelPrivateId`（switchKernel 查绑定） | 派生：`kernelPrivateId = derive(neutralSessionId, lineageId)`，幂等 seed 得到同一 id，无需存 |
| `resolveSessionKernel` 靠 dsh 绑定判定内核 | 内核归属是 `NeutralSession.header.kernel` 一个字段（§10） |
| `createProc` 里记"本会话在本内核的私有 id" | 运行时 `proc` 字段（transient），持久化源是中立层，不是表 |

关键认识：**映射表记的是"多对一、随时间变"的关系，而"确定性派生"用纯函数取代了这个关系**——只要 `lineageId` 不变，内核 id 就不变，回切找回原会话从"查表"变成"重算"。

## §13 seed 的精确投影规则

`seed` 从"全树 → 一个 id"改为"单条 lineage 完整线性内容 → 一个 id"。

### 13.1 通用规则

```
seed(lineage: NeutralEntry[], opts: { neutralSessionId, lineageId, header })
  → string   // 内核侧标识（§12.2 派生，幂等）
```

1. 只投影 `lineage`（`NeutralEntry[]`），不投影整棵树。
2. 投影时**跳过 `display`**——展示元数据不进内核，与 `sendMessage` 过滤 display 同一条纪律（`neutral-session-first.md` §10）。
3. 只投影 AI 内容角色（`user` / `assistant` / `toolResult`），其余角色跳过。
4. 返回内核侧标识，幂等：同 `lineageId` → 同标识。

### 13.2 pi 侧：写单条线性序列

`piSeedSession`（`pi-backend.ts:69–112`）现状是"写全树 parentId"，改为"写单条线性序列"：

```
1. sessionId = opts.lineageId（不再 randomUUID，pi-backend.ts:70）
2. path = <agentDir>/sessions/<bucket>/<stamp>_<lineageId>.jsonl
3. 写 session 头（id=lineageId, cwd, custom.kernel）
4. 逐 entry 写 message 行，parentId 挂前一条的 id（线性链，无分支）
5. 返回 path
```

因为只写一条 lineage，parentId 退化成"前一条的 id"——**pi 的 parentId 树变成一条直线**。这正是"内核单线"的投影形态：pi 看到的永远是一条线性会话，分叉结构在壳，不在 pi。

### 13.3 dsh 侧：seed 传 lineageId

`dsh-backend.ts:262–269` 现状传 `sessionId: session.neutralSessionId`，改为传 `sessionId: opts.lineageId`，其余不变。dsh 服务端把 `lineageId` 当 `SessionId` 建会话、写事件日志前缀。root lineage 的 `lineageId === neutralSessionId`，所以 root 会话的 dsh id 与中立主键一致，无差异。

---

# 第四编 · 机制

## §14 fork = 中立层切 lineage（纯操作）

`session-store.fork` 拆掉内核那半（§5 的对照表）：

```
现（含内核 fork）：切中立 lineage → backend.fork → reconcileAfterSessionReplacement → 命名
新（纯中立）：    切中立 lineage → 换 activeLineageId → 命名写中立 header → 结束
```

- `upsertNeutralLineage` + `activeLineageId = newLineageId`（现状 `1448–1457` 保留）。
- **删 `backend.fork`（`1458`）和 `reconcileAfterSessionReplacement`（`1462`）**——没有新文件要读回，没有会话身份要换。
- 命名改写中立 header（§10 的 `header.name`），不再 `setSessionName` 写内核（fork 没发生，内核还停在父 lineage）。
- fork 后不物化任何东西：分支只存在于中立层，直到下次"发起"。

## §15 发起 = seed 投影活跃 lineage（幂等）

"发起"的三个入口——发消息、切分支、切内核——统一走同一条物化路径：

```
1. lineage = lineageContent(neutralSession, activeLineageId)   // §11 完整线性内容
2. id = derive(activeLineageId)                                // §12.2 派生内核 id
3. 若内核未跑在这条 lineage 上：stop 旧的 → seed(lineage, {..., lineageId: activeLineageId})
   → start(以派生 id)
4. sendMessage(...)
```

**幂等是关键**：seed 同一 lineage 两次得到同一内核 id（§12.2），所以"切回已经物化过的分支"不需要重新写文件、只需要 stop/start 重新打开。物化是**惰性**的——"切了分支但没发言"不物化（比现在 fork 即物化更省）。

### 15.1 发消息（prompt）

`prompt`（§9）现状已做到"中立层先写 user + 过滤 display 再 send"。新增的是**发消息前判定活跃 lineage 是否已物化**：未物化 → 先 seed（§15 步骤 1–3）；已物化且内核正跑在这条 lineage → 直接 `sendMessage`。

判定方式不靠查表：`proc` 记录"当前内核正物化哪条 lineage"（`activeLineageId` 的投影状态），与目标 lineage 比对即可。

### 15.2 切分支

用户切到另一条 lineage → `activeLineageId = 目标 lineage` → 下次 send 时走 §15.1 的"未物化先 seed"。若内核当前物化的是别的 lineage，先 stop 再 seed 目标 lineage。切分支本身**同步、零内核动作**，和 fork 一样纯。

### 15.3 切内核（switchKernel）

`switchKernel`（§7 对照）从"快照全树 → seed 全树"简化为"读中立层活跃 lineage → seed 这一条"：

- 不再 `snapshotNeutralSession` 从旧内核读树——中立层本来就是最新。
- 不再 fork 全部分支——只 seed 活跃 lineage；分支留在中立层，激活时再投影。

## §16 上行同步不变，下行收窄

`neutral-session-first.md` 的双向同步，方向不变，收窄的是**下行时机**：

| 方向 | 现在 | 新 |
|---|---|---|
| **上行**（内核事件 → 中立层） | `entryAppended` → `syncNeutralEntry` append/回填（`session-store.ts:829`） | **不变** |
| **下行**（中立层 → 内核） | prompt 投影 + fork + switchKernel seed | **只在"发起"时**：seed 投影活跃 lineage（§15）；fork 不再下行 |

一句话：**下行不再在 fork 时发生，只在发起时发生。** 上行是"内核吐回来"，下行是"壳按需投影过去"，两条都流经中立层。

---

# 第五编 · 双内核实现

## §17 pi 侧：`piSeedSession` 单线化 + 路径派生

`piSeedSession`（`pi-backend.ts:69–112`）改三处：

1. **`sessionId` 用 `opts.lineageId`**，不再 `randomUUID()`（`pi-backend.ts:70`）——这是"id 派生"的 pi 落点，也是反模式"内核 id 现生成"的根治点。
2. **只写单条 lineage**：入参从 `NeutralSession`（全树）改为 `NeutralEntry[]`（单条完整线性内容），删掉 `for (const lineage of session.lineages)` 的多 lineage 循环，改为单链写。
3. **路径派生**：`path = join(agentDir, "sessions", cwdToBucketName(cwd), `${stamp()}_${lineageId}.jsonl`)`。`stamp()` 前缀保留目录时间排序可读性，id 部分用 `lineageId` 保证幂等。

保真字段不变：`usage` / `stopReason` / `error` / `startedAt` 等语义字段原样搬，身份字段（`id`）换成派生 id（现状 `pi-backend.ts:86–90` 的纪律保留）。

`PiBackend.fork`（`pi-backend.ts:333–346`）删除；`forkCommand`（`pi-backend.ts:188`）降为 `PiCapabilities` 的扩展面，壳默认不走。

## §18 dsh 侧：`session/seed` 传 lineageId

`dsh-backend.ts:262–269`：

```ts
async seed(lineage: NeutralEntry[], opts: { neutralSessionId; lineageId; header }): Promise<string> {
  const res = await this.requestSession("session/seed", {
    sessionId: opts.lineageId,      // 原 session.neutralSessionId → opts.lineageId
    session,                        // 单条 lineage 内容（wire 形状与 NeutralEntry[] 一致）
  });
  this.currentSessionId = res.sessionId;
  return res.sessionId;
}
```

`DshBackend.fork`（`dsh-backend.ts:223–229`）删除——`session/fork` RPC 不再被壳调用。

## §19 降级与缺面

新模型让两个内核的能力面**变窄**，反而是优势：

| 能力 | pi | dsh |
|---|---|---|
| fork | 从契约移除，`forkCommand` 降扩展面 | 从后端删除 |
| seed 单线 | 纯文件写（不依赖进程，预 seed 生命周期不对称保留） | `session/seed` RPC（依赖进程） |
| id 派生 | 路径派生（`lineageId`） | `SessionId = lineageId`（原生值对象） |
| getTree/getEntries | 降为兜底 | 降为兜底 |

没有任何内核因新模型缺面——反而两个内核都不再需要"分叉"这个它们实现得各不相同的动作，契约变得更薄、更对称。

---

# 第六编 · 契约变更

## §20 BaseBackend 去 fork

`core/domain/backend.ts`：

| 变更 | 内容 |
|---|---|
| **移除** | `fork(parentLineageId, boundary?)`（`backend.ts:99`） |
| **移除** | `ForkResult`（`backend.ts:60`）——没有 fork 就没有"是否换会话身份"这个差异要表达 |
| **保留（降级）** | `LineageTree` / `Lineage` / `LineageFork`——仍用于"只读投影视图"（session-tree 画树用），但不再是 fork 指令的输入输出 |

实现方义务同步更新：删掉"fork 不改动原 lineage""boundary 必须落在完整回合之后"（`backend.ts:71–74`）——这些是 fork 的实现义务，随 fork 一起消失。

`AbstractBackend`（`client/backend/abstract-backend.ts`）的 `abstract fork(...)` 删除，15 abstract 减为 14。

## §21 seed 签名改：投影单条 lineage

```
现：seed(session: NeutralSession): Promise<string>            // 全树 → 一个 id
新：seed(lineage: NeutralEntry[], opts: {                      // 单条 lineage 完整线性内容 → 一个 id
      neutralSessionId: string;
      lineageId: string;
      header: NeutralSessionHeader;
    }): Promise<string>
```

- **入参**：一条 lineage 的完整线性内容（`NeutralEntry[]`，壳侧用 §11 `lineageContent` 算好传入），不再传整棵树。
- **返回**：该 lineage 的内核侧标识（§12.2 派生，幂等）。
- `BackendFactory.seed?`（`backend.ts:310`，预 seed 生命周期不对称）保持存在，入参同步改成单条 lineage + opts。

## §22 getTree / getEntries 降级为兜底

壳的常规读取面改读中立层，`getTree`/`getEntries` 从"常规路径"降为"中立层缺失时的兜底重建"：

| 现在（读内核） | 新（读中立层） |
|---|---|
| `openSession` → `SessionCatalog.open` 读内核文件 + `getTree` | 读 `NeutralSessionStore.get(neutralSessionId)` |
| `snapshotNeutralSession` → `getTree`+`getEntries` 重建中立树 | 删——中立层本来就是最新 |
| `switchKernel` 快照 → `getTree`+`getEntries` | 读中立层活跃 lineage，seed 投影 |

`getTree`/`getEntries` 保留在契约里，仅作**恢复兜底**（中立层损坏时从内核侧反投影重建），不进入日常链路。

## §23 与既有文档的回改清单

以本文为准，三处回改：

1. **`session-neutral-layer.md` §9.2**："fork 走中立版本：先切中立树 → 投影后端"——"投影后端"从"调 `backend.fork`"改为"惰性 seed（本文 §15）"。§10.4/§11.4 的 pi/dsh fork 位置翻译整节废除（fork 没了，position 和 boundarySeq 都不需要翻译）。
2. **`neutral-session-first.md` §9**：fork 的"投影层动作（pi 切文件 / dsh 开子会话）"删除，改为"惰性 seed 投影"。
3. **`kernel-design-spec.md` §9.5**：`BaseBackend.fork` 从六意图里移除；`ForkResult` 删除；seed 改单线签名。

---

# 第七编 · 一致性、竞态与失败

## §24 幂等与派生确定性

幂等是"去映射表"成立的物理基础，必须当成不变量守住：

1. **派生函数是纯的**：`derive(lineageId)` 不读任何外部状态（不读时间戳的随机部分、不读全局计数器）。pi 的 `stamp()` 前缀是时间戳——它**只影响可读性、不影响身份**，身份由 `lineageId` 决定，所以同 lineage 两次 seed 的路径 id 部分一致。要防的坑是：不能把 `stamp()` 的随机/时间部分当成身份的一部分。
2. **同 lineage → 同 id → 同文件/同 session**：seed 第二次时，目标文件已存在 → pi 侧覆盖写（幂等）；dsh 侧 `session/seed` 若遇同 id 已存在，需幂等语义（覆盖或复用，取决于 dsh 服务端实现——这是 dsh 侧要实现的一个点）。
3. **root ≡ neutralSessionId**（§12.1）是幂等的特殊情况：root lineage 的内核 id 永远等于中立主键，切内核 root 会话 id 不变。

## §25 并发护栏

`forkFromSession` 现有的竞态护栏（`session-store.ts:1504–1544`）语义**保留，但守的对象变了**：

- 旧护栏守的是"pi 文件副本 + fork 命令窗口"；
- 新护栏守的是"seed 投影窗口"：`seed` 的 await 窗口内，若 `activeLineageId` 被并发切走（用户点了别的分支/会话），seed 目标已失效 → 中止，不把命令落到错误的 lineage 上。

护栏形式不变（`activeLineageId` 比对 + 抛"并发上下文切换打断"），只是把"比对 activeSessionPath"换成"比对 activeLineageId"。

## §26 失败回滚与崩溃恢复

| 场景 | 处置 |
|---|---|
| seed 中途失败 | 内核无半截物化：pi seed 是纯文件写、失败不 spawn；dsh seed 失败不落 session。保持旧活跃态，报错。 |
| 切分支后崩溃（seed 未发生） | 中立层已有新 lineage（fork 时已 `put`），崩溃恢复读中立层即可——分支结构不丢。 |
| 切内核 seed 后崩溃 | 派生 id 幂等，重启后重算同 id，重开同文件/同 session。 |
| 中立层损坏 | `getTree`/`getEntries` 兜底从内核侧反投影重建（§22）；展示元数据不可恢复则显式"图已丢失"（`neutral-session-first.md` §13）。 |
| 内核侧文件被手动删 | 派生 id 算出的文件不存在 → 重新 seed 重建（幂等）；不静默、不伪造。 |

---

# 第八编 · 迁移路径

## §27 分阶段

每阶段编译 + 测试全绿，一个 commit 一个完整态。顺序从内往外（先补中立层能力，再动内核契约，最后收口）。

### 阶段 A：中立层补「按 cwd 枚举」+ 列表行字段（前置，纯增量）

这是"壳不读内核存储"的底子，也是本设计的依赖——新模型下壳的**唯一读源**就是中立层，所以中立层必须能自己列会话。

1. `NeutralSessionStore` 加 `listByCwd(cwd)`（扫 `*.json`、按 header.cwd 过滤）。
2. `NeutralSessionHeader` 加列表行字段：`name / updatedAt / lastMessage / lastEntryId / pinned / archived / custom`（§10）。
3. `SessionInfo` 加 `neutralSessionId` 字段，renderer 列表改以它为稳定主键（现以 `path` 为键，`stores/session-store.ts:398`）。

**验收**：中立层能独立回答"某 cwd 下有哪些会话"；既有列表功能不回归。

### 阶段 B：seed 单线化 + id 派生（去映射表）

1. `seed` 签名按 §21 改（单条 lineage 入参）；`piSeedSession` 写单线、路径用 `lineageId` 派生（§17）；dsh 传 `lineageId` 当 `SessionId`（§18）。
2. 加 `lineageContent` 纯函数（§11）+ 单测（含环、悬空、嵌套分支）。
3. `SessionBindingStore` 移除；`switchKernel`/`resolveSessionKernel` 改读中立 header + 派生 id。
4. `resolveNeutralSessionId` 移除（中立主键不再藏内核头，§6）。

**验收**：switchKernel 幂等（同 lineage 同 id）；映射表文件不再生成；pi→dsh→pi 来回切找回原会话仍成立（靠派生 id + 幂等 seed）。

### 阶段 C：fork 去内核（核心）

1. `BaseBackend.fork` + `ForkResult` 移除，`AbstractBackend` 删 abstract。
2. `session-store.fork` 删 `backend.fork` + `reconcileAfterSessionReplacement`，只留切中立 lineage（§14）。
3. `forkFromSession`（`session-store.ts:1491`）重构：不再"复制源文件 → fork → 删中间副本"，改为"切中立 lineage → 下次 send 时 seed 投影"。
4. `prompt` 加"活跃 lineage 未物化则先 seed"（§15.1）。

**验收**：fork → 立即切到新分支（中立层）→ 首条消息触发 seed 物化 → 正常跑；内核侧无 fork 调用；pi 的 fork 命令、dsh 的 session/fork 不再被壳调用。

### 阶段 D：读取面收口（list/open 读中立层，SessionCatalog 吸收）

1. `session-store.list` 改读 `NeutralSessionStore.listByCwd`（不再 pi/dsh 各自 `catalog.list` 合并，`session-store.ts:637`）。
2. `openSession` 改读中立层；`catalogFor`（`.jsonl` 后缀路由，`session-store.ts:658`）移除。
3. rename/updateHeader/delete 双写中立 header + 下沉内核（`setSessionName` / `session/rename` 作投影），不落下中立层。
4. `SessionCatalog` 降级：pi 专属残留（`readToolConfig`/`contextProbeTokens`）留 pi 适配器；目录/CRUD 面被中立层吸收。

**验收**：壳不再读任何内核存储（list/open/树全走中立层）；pi 专属 tool-gate/context-probe 经能力面探测，不按内核身份硬分支。

---

# 第九编 · 边界与反模式

## §28 边界

| 边界 | 处置 |
|---|---|
| 内核独立创建的会话（不经壳，pi CLI / dsh CLI 直建） | 壳侧不可见——"壳是唯一源"的固有代价。接受；未来可加"从内核存储导入"面。 |
| pi 文件名从 `<stamp>_<uuid>` 改为 `<stamp>_<lineageId>` | 文件名是 pi 适配器的存储细节，壳不感知；`stamp` 前缀保留目录时间排序可读性。 |
| 切分支频繁（A→B→A→B） | 每次切都重新 seed 目标 lineage；幂等 seed 使"切回已物化分支"只重新打开、不重写，代价是 stop/start 一次。 |
| 分支 lineage 的完整内容随父 lineage 增长 | `lineageContent` 每次发起现算，是纯函数；父 lineage 追加不改变子分支的历史前缀。 |
| 中立层损坏 | 以 `getTree`/`getEntries` 兜底从内核侧反投影重建（§22）；展示元数据不可恢复则显式"图已丢失"。 |
| seed 中途失败 | 内核无半截物化（pi seed 是纯文件写，失败不 spawn；dsh seed 失败不落 session），保持旧活跃态。 |
| dsh `session/seed` 同 id 已存在 | 幂等语义由 dsh 服务端保证（覆盖或复用）；这是 dsh 侧要实现的点，§24.2。 |

## §29 反模式

### 29.1 让内核 fork 再翻译回来

- **症状**：内核 fork + `ForkResult.sessionReplaced` + 映射表 + `reconcileAfterSessionReplacement` 读回新文件。
- **根因**：把"分叉"（结构操作）派给了内核（执行器），内核执行完结构又翻译回壳，来回倒腾。
- **正解**：内核不 fork，壳切树，发起时 seed。

### 29.2 内核 id 用 randomUUID 现生成

- **症状**：`piSeedSession` 里 `sessionId = randomUUID()`（`pi-backend.ts:70`），每 seed 一次一个全新 id，逼出映射表记"这次是哪个"。
- **根因**：把身份生成权交给了内核/投影实现，壳失去对身份的掌控。
- **正解**：id 派生自 `lineageId`，纯函数、幂等。

### 29.3 中立主键藏内核头

- **症状**：`resolveNeutralSessionId` 把 `neutralSessionId` 写进内核 `custom` 字段（`session-store.ts:414`），主键寄存在内核存储里才能跨重启存活。
- **根因**：中立层没有自己的索引，只能借内核存储当持久化载体。
- **正解**：中立主键只活在中立层索引（`NeutralSessionStore` 按 id 存），内核头不藏。

### 29.4 "切了分支不发言"也物化

- **症状**：fork 即切新文件 / 开子会话，分支没被跑也落盘。
- **根因**：fork 把"切结构"和"物化"焊死。
- **正解**：惰性物化，发起才 seed。

### 29.5 按文件后缀路由内核（`.jsonl`）

- **症状**：`catalogFor` 用 `path.endsWith(".jsonl")` 判 pi（`session-store.ts:658`），壳在会话意图链路上知道 pi 的存储形状。
- **根因**：目录/CRUD 还按内核拆，壳被迫知道"pi 是文件、dsh 不是"。
- **正解**：内核归属是 `NeutralSession.header.kernel` 字段，路由不按后缀（§27 阶段 D）。

---

# 第十编 · 与 CLAUDE.md 纪律的对照

## §30 依赖只向内 + 契约单源

- **`lineageContent` 落圆心**（`core/domain/session-neutral.ts`，零依赖）——它是"会话结构的业务本质"（一条 lineage 的完整内容怎么算），换内核、换框架都不变，是圆心材料。
- **id 派生规则的内核部分留在适配器**：pi 的路径规则在 `pi-catalog.ts`，dsh 的 `SessionId = lineageId` 在 `dsh-backend.ts`。壳只依赖"seed 返回内核标识"这个中性契约，不知道 pi 怎么拼路径。
- **契约单源**：`seed` 的新签名、`BaseBackend` 去 fork，只在 `backend.ts` 定义一次，外层 re-export，不在别处写"本地版"。

## §31 机制内容分离 / 无特权 / 多内核默认 / 消费而非翻译

- **机制内容分离**：壳只放"分叉树"这个机制（`NeutralSession` + `lineageContent`），不放"pi 怎么 fork / dsh 怎么 fork"的内容——那是内核的事，且新模型下内核连这事都不需要做了。
- **无特权差异**：pi 的 `forkCommand` 降为 `PiCapabilities` 扩展面，与 dsh 无 fork 能力**在契约层拉平**——不再有"pi 能 fork、dsh 也能 fork 但形状不同"的差异，而是"谁都不 fork"。
- **多内核默认**：本文从"pi 和 dsh 各实现一遍 fork"收敛到"壳一个 fork、内核零 fork"——加第三个内核时，它只需要 `seed + sendMessage + 事件回流`，不需要实现分叉。这是"内核先抽象、后实现"走到最薄的样子。
- **消费而非翻译**：内核不再是"分叉语义的翻译层"（pi 的 parentId、dsh 的 forest 都是对同一分叉结构的不同翻译）。分叉结构由壳直接消费（它自己持有树），内核只消费一条线性 lineage。

---

# 第十一编 · 渲染层与插件面的迁移

> 前八编讲的是内核/契约/应用层的改动。但 forkless 不是"内核层一个改动"，它是**会话主键从"内核私有 id"换成"壳自有中立 id"的全局迁移**。左侧栏（`sessions-list`）是这个迁移最密集、最外显的落点。本编补上前八编漏掉的渲染层/插件面。

## §32 主键迁移：`path` → `neutralSessionId`

现在整个左侧栏都拿 `SessionInfo.path`（内核私有 id：pi 文件路径 / dsh 会话 id）当主键。forkless 之后主键是 `neutralSessionId`（选中分支再加 `activeLineageId`）。逐处对照：

| 处 | 现在 | 新 | 落点 |
|---|---|---|---|
| `sessionInfos` map | `map[s.path] = s` | `map[neutralSessionId] = s` | `api/renderer/stores/session-store.ts:398` |
| 列表数据源 | `loadSessionInfos` → `window.kernel.sessions.list(cwd)`（读内核） | 读中立层 `listByCwd` | 同文件 `:394` |
| 高亮 | `currentSessionPath === s.path` | `currentNeutralSessionId === s.neutralSessionId` | `sessions-list/renderer/index.tsx:467` |
| 选中 | `setCurrentSessionPath(s.path)` + `openSession(s.path)` | neutral id | 同文件 `:223-226` |
| `phaseByPath`/`lastEntryByPath`/`readState` | 按 path key | 按 neutral id key | 同文件 `:59-65` |
| `customOrder` 持久化 | 存 `/path/a.jsonl` | 存 neutralSessionId | `session-list-order-bookmark-fork.md` §2.3 |
| 行 key / 调试锚 | `key={s.path}` / `data-session-path` | neutral id | 同文件 `:463,757` |
| 乐观新建条目判据 | `currentSessionPath === null` | 无活跃 neutralSessionId | 同文件 `:340` |

**附带收益**：`customOrder` 和 `readState` 改存 neutralSessionId 后，**跨内核切换不再失效**——现在存的是 pi 文件路径，切到 dsh 就查不到；neutralSessionId 跨内核稳定。

**注意**：`path` 字段不删，降级为"投影线索"（打开文件/调试用），但它不再是主键。`SessionInfo` 里 `neutralSessionId` 是主键、`path` 是当前内核的投影地址（§10）。

## §33 fork 不再新增列表条目（语义变化）

这是最大、最需要向用户交代的可见变化：

- **现在**：书签 fork（`forkFromSession`）复制源文件 + fork → **列表里多一个「源名 (copy)」新会话**（`session-list-order-bookmark-fork.md` §3）。
- **新**：fork = 在源会话中立树里切一条新 lineage → **不新增列表条目**；分支显示在右侧 `session-tree`，不进左侧列表。

连带两处：

1. **`sessionGroupings` 父引用迁移**：`sessions-list/index.tsx:300-322` 的 `childrenByParent` 读 `s.custom[parentPathKey]`（父 path）。这条分组机制**保留**（sub-agent 会话仍是独立会话、要挂父），但 `parentPathKey` 的引用值从"父 path"改成"父 neutralSessionId"。fork 相关的子会话嵌套（若走这条机制）则随 fork 语义消失。
2. **书签 fork 文案**：「已从收藏创建新会话」（`session-bookmarks` 四语言 `bookmarks.forkCreated`）改成「已在源会话中创建新分支」。

## §34 连带插件

| 插件 | 现在 | 新 |
|---|---|---|
| `session-tree`（右侧） | 树来源 `getTree`/`getEntries`（读内核） | 读中立层 `NeutralSessionStore.get`；`locate` 切活跃 lineage |
| `session-colors` | 按 path 查单个会话 | 按 neutral id 查 |
| `timeline` | 按 path 查 SessionInfo（`session-list-order-bookmark-fork.md` §4 提到的消费方） | 按 neutral id 查 |
| `session-bookmarks` | `forkFromSession` 新建会话 + `timeline:scrollTo(entryId)` | 切中立 lineage；entryId 已是中立 entryId（`{lineageId}:{seq}`） |

## §35 渲染层迁移与四阶段的归属

渲染层/插件面的改动不是独立一步，散落在 §27 的四阶段里：

- **阶段 A**：`SessionInfo` 加 `neutralSessionId`（§10）→ 列表能拿到主键，但 renderer 还在用 path（过渡态，path 仍是主键）。
- **阶段 C**：fork 去内核 → 书签 fork 语义变（§33），`session-bookmarks` 文案、`childrenByParent` 的 fork 嵌套同步改。
- **阶段 D**：`list` 读中立层 → `loadSessionInfos` 换数据源；此时做**主键一次性迁移**（§32 的整表：`sessionInfos`/`currentSessionPath`/`phaseByPath`/`lastEntryByPath`/`readState`/`customOrder` 全换 neutral id）。

**为什么主键迁移放阶段 D 而不是阶段 A**：主键从 path 换 neutral id 会同时打断"打开/高亮/选中/拖拽/未读"一整条 renderer 链路，必须等 `list`/`openSession` 都已经读中立层、neutral id 成为可用主键之后，才能一次切干净。阶段 A 只是把字段加进去，阶段 D 才是切换点。

---

# 第十二编 · 端到端故事

## §36 完整叙事

把完整链路串起来，看"内核无 fork"下每个用户动作发生了什么。

**1. 开新会话，聊 A、B**：壳生成 `neutralSessionId = "ns-1"`，root lineage `L0`（`lineageId = ns-1`），entries `[A, B]`。发起时 `seed(L0 内容, lineageId: ns-1)` → pi 写 `<bucket>/<stamp>_ns-1.jsonl`、dsh 建 `SessionId(ns-1)`。内核只看到线性 `[A, B]`。

**2. 在 B 之后 fork**：壳 `fork` 纯操作 → 中立树切出新 lineage `L1`（`lineageId = uuid-1`，`fork = {L0, B}`），`activeLineageId = L1`。**内核没有任何动作**——pi 还停在 `ns-1.jsonl`，dsh 还停在 `SessionId(ns-1)`。左侧列表**不新增条目**。

**3. 在 L1 上发 C**：`lineageContent(ns-1, L1)` = `[A, B]`（父前缀截到 B）+ `[C 待追加]` → `seed(L1 内容, lineageId: uuid-1)` → pi 写新文件 `<stamp>_uuid-1.jsonl`、dsh 建 `SessionId(uuid-1)` → `sendMessage(C)`。内核跑的是 `[A, B, C]`。

**4. 切回 L0 发 D**：`activeLineageId = L0`，`lineageContent = [A, B]` → `seed(L0, lineageId: ns-1)` 幂等 → 得到**同一个** `ns-1.jsonl` / `SessionId(ns-1)`（重开，不重写内容）→ `sendMessage(D)`。内核跑 `[A, B, D]`。

**5. 切到 dsh**：`switchKernel("dsh")` 读中立层活跃 lineage（假设 L1）→ `seed(L1 内容, lineageId: uuid-1)` → dsh 建 `SessionId(uuid-1)`。**只 seed 活跃 lineage，L0 留在中立层**。

**6. 切回 pi**：`switchKernel("pi")` → 派生 `derive(uuid-1)` = `<stamp>_uuid-1.jsonl` → 幂等重开同文件，**不重新 seed、不查表**。全程 `ns-1` / `uuid-1` 不变，变的只是投影到哪个内核。

关键不变量贯穿全程：**`lineageId` 是唯一身份，内核 id 是它的派生；分叉结构从头到尾只活在中立层，内核永远只持有当前活跃那条线性 lineage。**

---

# 第十三编 · QA

## §37 QA

**Q：内核不 fork，那 pi/dsh 自己的 fork 能力去哪了？**
答：变成死代码。pi 的 `forkCommand` 降为 pi 扩展面（壳默认不走），dsh 的 `session/fork` 从 dsh 后端删掉。内核不再需要"分叉"这个能力——分叉是壳的事，内核只跑一条 lineage。

**Q：这和"换内核 = 换投影"什么关系？**
答：是它的推广。`session-neutral-layer.md` 说换内核 = 换投影实现；本文说**换分支也是换投影**。内核永远只投影"当前活跃 lineage"这一条，所以"切分支"和"切内核"在投影层是同构操作。

**Q：seed 幂等是什么意思，为什么能去映射表？**
答：内核侧 id = 派生自 `lineageId` 的确定性函数（§12.2）。同一条 lineage 每次 seed 得到同一个 id，所以"回切找回原会话"不需要查表——重新 seed 就得到同一个文件/session。映射表记的"多对一随时间变"关系，被"确定性派生"取代了。

**Q：切分支每次都要 seed，会不会比 fork 慢？**
答：惰性 seed 只在"发起"时发生；fork 是"切了立刻物化"。二者都是写文件/seed 会话的等价成本，但惰性 seed 对"切了不发言"的分支零成本。唯一多出来的是"切回已物化分支"要 stop/start 一次，这是单线执行器的固有代价。

**Q：pi 的 fork 有 position（before/at）语义，seed 怎么表达？**
答：position 是"分叉点落在哪条 entry 前后"的 pi 细节。中立层的 `lineageContent` 已经决定"前缀截到哪条 entry"（`fork.boundaryEntryId`），seed 只需把截好的线性内容写进去，position 不需要了。

**Q：getTree/getEntries 还留在契约里，为什么？**
答：只作中立层损坏时的兜底反投影（§22）。日常链路不再调它们——壳的树在中立层，不向内核要。

**Q：这个改动让"壳不读内核存储"彻底成立了吗？**
答：是的，这是它的最终形态。list/open/树/身份/展示元数据全走中立层；内核只被 seed 投影 + 事件回流。`SessionCatalog` 只剩 pi 专属侧车残留（tool-gate/context-probe），那是 pi 能力面不是会话存储。

**Q：为什么中立会话树要存壳侧，而不是让内核各存各的、壳只记 id？**
答：这正是本文的进一步回答。`session-neutral-layer.md` §25 的答案是"fork 结构是跨内核要保的东西"。本文更进一步：**如果内核根本不 fork，内核连"树"都没有，只有一条 lineage**——壳存树不是"缓存"，是**唯一真相**；内核存的是"当前活跃 lineage 的投影"。

**Q：内核独立创建的会话（pi CLI 直建）在新模型下怎么办？**
答：壳侧不可见，需要"从内核存储导入"面（§28）。这是"壳是唯一源"的固有代价，本文接受并标注演进，不静默假装可见。

**Q：这个改动会不会让内核的某些既有功能退化？**
答：不会，反而变薄。pi 的 fork、dsh 的 session/fork 是"壳调内核去分叉"用的；壳不再调它们，它们对壳是死代码，对内核自身功能（如果有别的消费者）无影响。内核少了一个必须实现、且实现得各不相同的动作。

**Q：左侧栏的会话列表也变了吗？**
答：变了，见第十一编。最大变化是"fork 不再新增列表条目"（分支是源会话内的 lineage，不进列表），以及主键从 `path` 迁到 `neutralSessionId`（`customOrder`/`readState`/高亮/选中全换 key）。

**Q：三个阶段（阶段 B 去映射表、阶段 C 去 fork）能不能合成一个 commit？**
答：不能。阶段 B（seed 单线 + id 派生）是阶段 C（去 fork）的前置——先把 seed 改成"幂等投影单线"，fork 才有替代品可切。合成一个 commit 会让"seed 语义变了"和"fork 删了"两个变量一起炸，分不清是谁的错（CLAUDE.md §4.5 迁移顺序的同一逻辑）。

---

# 第十四编 · 实现要点清单

## §38 实现要点清单

| 层 | 交什么 | 落点 |
|---|---|---|
| core/domain | `lineageContent` 纯函数（沿 fork 链拼完整线性内容，§11） | `core/domain/session-neutral.ts` |
| core/domain | `NeutralSessionHeader` 加列表行字段；`SessionInfo` 加 `neutralSessionId`（§10） | `session-neutral.ts` / `sessions.ts` |
| core/domain | `BaseBackend` 去 `fork`/`ForkResult`；`seed` 改单条 lineage 签名（§20–§21） | `backend.ts` |
| core/application | `NeutralSessionStore.listByCwd`（§27 阶段 A） | `neutral-session-store.ts` |
| core/application | `session-store.fork` 纯中立（删 backend.fork）；`prompt` 加"未物化先 seed"；`switchKernel` 只 seed 活跃 lineage；删 `resolveNeutralSessionId`（§14–§15） | `session-store.ts` |
| core/application | 移除 `SessionBindingStore`（§12.3） | 删 `session-binding-store.ts` |
| client/backend | `AbstractBackend` 删 abstract fork（§20） | `abstract-backend.ts` |
| client/pi | `piSeedSession` 写单线 + 路径派生自 lineageId；删 fork 调用面（§17） | `pi-backend.ts` / `pi-catalog.ts` |
| client/dsh | `seed` 传 lineageId 当 SessionId；删 `session/fork`（§18） | `dsh-backend.ts` |
| api/renderer | `sessionInfos` 改 key 为 neutralSessionId；`loadSessionInfos` 读中立层（§32） | `stores/session-store.ts` |
| plugins/sessions | `sessions-list` 主键迁移 + fork 语义（§32–§33）；`session-tree` 读中立层；`session-bookmarks` 切中立 lineage（§34） | `plugins/sessions/*` |

**验收铁律（三句话）**：

1. 壳侧 fork 全程不触内核；内核侧无任何 fork 调用（pi `fork` 命令、dsh `session/fork` 归零）。
2. 内核侧会话标识 = 派生自 `lineageId`（root ≡ neutralSessionId），seed 幂等，`SessionBindingStore` 文件不再生成。
3. 发消息 / 切分支 / 切内核三者统一走"seed 活跃 lineage → sendMessage"，中立树是唯一读源、内核是单线投影；左侧栏主键是 neutralSessionId，fork 不新增列表条目。
