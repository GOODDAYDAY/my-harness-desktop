# 壳 session ↔ 内核 session 映射：neutralSessionId 的派生与投影

## 0. 定位：这份映射在解决什么

- 本文只回答一个问题：桌面壳自己的「会话主键」如何映射到 pi、dsh、以及未来第三个内核各自的「会话标识」。它不展开消息/事件/模型的中立化——那些是 `backend.ts` 里 `BaseBackend` 的六条核心意图（`sendMessage`/`abort`/`setModel`/`fork`/`getTree·getEntries`/流式事件）已经覆盖的另一半。本文覆盖的是「坐标」这一半：会话是谁、一条 lineage 是谁、一条 entry 是谁。

- 一句话定位：壳的 session 主键是壳自己生成的 `neutralSessionId`（UUID），内核的 session 标识是内核私有的，两者**不互相认识，也不存在一张持久化映射表**——它们经「`lineageId` 确定性派生」这一纯函数桥接。这是「壳不读内核存储」（§7.5 不变量 #1）在会话身份上的落地：壳不认识 pi 的 JSONL 文件路径规则，也不认识 dsh 的 `SessionId` 值对象，壳只认自己生成的 `neutralSessionId` 与 `lineageId`；派生出内核侧标识的规则是内核适配器的私事，收在 `src/server/kernel/{kernel}`。

- 先交代一个贯穿全文的不变量，它是一切派生成立的前提：**根 lineage 的 `lineageId` 恒等于 `neutralSessionId`**。这条在 `session-store.ts` 的 `createProc` 里落地——`SessionProc.activeLineageId = ns`、`materializedLineageId = ns`（`session-store.ts:431`），新会话的 `ns` 就是随机 UUID，根 lineage 的 id 即取它。因为这条不变量，映射表才可能退化成「确定性派生」：内核侧标识只要从 `lineageId` 算出来，root 会话就天然等于 `neutralSessionId`，分支会话等于 fork 时生成的 `randomUUID()`。

- 本文所有论断落到具体文件、函数、类型名，行号以当前工作区代码为准。四个关键文件的路径先说清：中立契约与中立类型在 `packages/shared/src/domain/`（`backend.ts`、`session-neutral.ts`、`sessions.ts`、`kernel.ts`）；壳的用例编排在 `src/server/application/sessions/session-store.ts`；pi 适配器在 `src/server/kernel/pi/backend/pi-catalog.ts` 与 `pi-backend.ts`；dsh 适配器在 `src/server/kernel/dsh/backend/dsh-catalog.ts` 与 `dsh-backend.ts`；内核工厂组装在 `src/server/kernel/factories/kernel-factories.ts`。

## 1. 三种身份：neutralSessionId / lineageId / kernelEntryId

- 壳的会话身份系统里并排存在三层「谁是谁」的标识，层级不同、生命周期不同、归属不同，必须先拆开，后面每一条映射规则都是这三者之间的换算。

  - **`neutralSessionId`：壳的会话主键，UUID，跨内核稳定。** 类型是 `NeutralSessionId { value: string }`（`session-neutral.ts:14`），但实际运行时以裸 `string` 流动——`NeutralSession.neutralSessionId: string`（`session-neutral.ts:28`）、`SessionProc.neutralSessionId: string`（`session-store.ts:94`）、`BackendCreateOptions.neutralSessionId: string`（`backend.ts:231`）。它是壳的会话列表、书签、分组、未读位标的主键，`SessionInfo.neutralSessionId`（`sessions.ts:39`）即它。它由壳生成，不由任何内核生成——生成点在 `session-store.ts` 的 `createProc`：`const ns = neutralSessionId ?? randomUUID()`（`session-store.ts:410`），新会话时经 `ensureForSend` 先定出会话路径、再反查回 ns（见 §3/§4）。

  - **`lineageId`：中立 lineage 身份，是「派生内核标识」的唯一输入。** 类型是 `NeutralLineage.lineageId: string`（`session-neutral.ts:55`）。根 lineage 的 `lineageId` ≡ `neutralSessionId`（§0 不变量）；分支 lineage 的 `lineageId` = fork 时 `randomUUID()`，生成点在 `fork()`（`session-store.ts:1536`）与 `forkFromSession()`（`session-store.ts:1605`）。它是内核侧会话标识的派生源——pi 从它派生文件路径、dsh 直接拿它当 `SessionId`（§3/§4）。`SeedOptions.lineageId`（`backend.ts:58`）就是把它显式传给 `seed`，让内核侧 id 由壳掌控。

  - **`kernelEntryId`：内核私有 entry id，opaque 线索，仅适配器用。** 类型是 `NeutralEntry.kernelEntryId?: string`（`session-neutral.ts:66`），注释明说「投影时的 opaque 线索，仅 adapter 用，不进中立契约对外面」。pi 侧是 JSONL 条目的 `id`（`pi-catalog.ts` 里 `entry.id`），dsh 侧是事件 id/seq。它跨内核必然不同（同一条消息在 pi 和 dsh 下的 `kernelEntryId` 不同是正常态，见 `session-neutral-layer.md` §23），所以它永远只作「私有 ↔ 中立」翻译时的临时线索，绝不作为壳的主键或锚点。回填点 `backfillKernelEntryId`（`session-neutral.ts:250`）与读回点 `snapshotNeutralSession`（`session-store.ts:897`）都只把它挂在 `NeutralEntry.kernelEntryId` 上。

- 在三者之外，还有第四个概念必须一起交代，否则「映射」二字无从谈起：**内核私有会话 id**（设计文档称 `kernelPrivateId`），它才是「内核 session 标识」这一半。

  - pi 的 `kernelPrivateId` = JSONL 文件路径，即 `<agentDir>/sessions/<bucket>/<lineageId>.jsonl`。它是 `BaseBackend.sessionId` 在 pi 侧的取值——契约注释明说「pi=JSONL 文件路径」（`backend.ts:77`）。

  - dsh 的 `kernelPrivateId` = dsh 进程内的 `SessionId`（值对象，客户端可显式指定），即 `lineageId` 本身（root 会话 = `neutralSessionId`）。契约注释说「dsh=不透明 session id/桶名」（`backend.ts:77`）——「不透明」是相对壳的，实际值就是 `lineageId`。

  - 这四者的关系一张图说清：

    ```
    neutralSessionId ──(根 lineage 恒等)──> root lineageId
                                                  │
    fork 时 randomUUID() ─────────────────> branch lineageId（每分支一个）
                                                  │
               ┌──────────────────────────────────┴────────────────────┐
               │  pi：piDerivedSessionPath(agentDir, cwd, lineageId)    │
               │      = <agentDir>/sessions/<bucket>/<lineageId>.jsonl  │
               │  dsh：SessionId(lineageId)                             │
               └───────────────────────────────────────────────────────┘
                                                  │
                                       内核私有会话 id（kernelPrivateId）
                                                  │
                            每条 entry 各自再有 kernelEntryId（pi entry.id / dsh seq）
    ```

- 一个常被混淆的点：`lineageId` 和 `kernelEntryId` 都是「身份」，但一个定位「会话/分支」，一个定位「条目」。`NeutralAnchor { lineageId, entryId }`（`session-neutral.ts:19`）里的 `entryId` 是中立 entry id（`{lineageId}:{seq}`，由 `neutralEntryId()` 生成，`session-neutral.ts:91`），不是 `kernelEntryId`。所以「壳 session ↔ 内核 session」这条主线只关心 `neutralSessionId → lineageId → kernelPrivateId` 这一条链，`kernelEntryId` 只在内核内部的条目投影里出现，不参与会话级的身份换算。

## 2. 映射的总架构：一层中立、两层派生

- 映射不是「一张表 + 一次查表」，而是「一个中立层 + 两个纯派生函数」。这是本仓库最终形态与早期设计（`session-neutral-layer.md` 里的 `SessionBindingStore` 映射表方案）的关键分叉：映射表后来被整体移除，因为它记录的是「多对一、随时间变」的关系，而「确定性派生」用一个纯函数取代了这个关系——只要 `lineageId` 不变，内核 id 就不变，回切找回原会话从「查表」变成「重算」。当前工作区里 grep 不到 `SessionBindingStore` / `session-binding-store` / `resolveNeutralSessionId`，证明该迁移已完成。

- 三个物理层各司其职：

  - **中立层（圆心，`packages/shared/src/domain/`）**只定义「身份」这一抽象，不定义任何内核的存储形状。`NeutralSessionId`/`NeutralAnchor`/`NeutralSession`/`NeutralLineage`/`NeutralEntry` 全在 `session-neutral.ts`，`SeedOptions`/`BaseBackend.seed`/`BackendCreateOptions.neutralSessionId`/`SessionCatalog` 三方法在 `backend.ts`。圆心不知道 pi 怎么拼路径、dsh 怎么建会话。

  - **应用层（`src/server/application/sessions/session-store.ts`）**是映射的「使用方」。它只持 `neutralSessionId`，需要内核侧会话标识时，要么读 `backend.sessionId`（`BaseBackend.sessionId` 属性，`backend.ts:79`），要么调 `SessionCatalog.newSessionId/projectionPath/rawFilePath`（经 `catalogFor(kernel)` 委托，`session-store.ts:225`）。它从不自己拼内核 id——契约注释把它钉死：「壳经此读取，不自行按内核身份拼内核会话 id」（`backend.ts:78`）、「壳不自己拼内核的会话路径」（`backend.ts:292`）。

  - **适配器层（`client/{kernel}`）**是映射的「实现方」。每个内核自己决定「从 `lineageId` 派生内核侧 id」的规则：pi 在 `pi-catalog.ts` 的 `piDerivedSessionPath`，dsh 在 `dsh-catalog.ts` 的 `projectionPath`（恒等）+ `dsh-backend.ts` 的 `sessionId` 覆写。派生规则是内核私有的存储知识，收在 `src/server/kernel/{kernel}`，圆心与应用层一行都不碰。

- 映射的「唯一收口点」在 `BackendCreateOptions.neutralSessionId` 的契约注释里，这是全仓对「壳 session ↔ 内核 session」最权威的一句话：

  > 「中立会话主键：壳只传 ns，内核私有会话 id 由各内核 adapter 派生（pi=piDerivedSessionPath(agentDir,cwd,ns)，dsh=ns）。」（`backend.ts:229-231`）

  它说清了三件事：①壳传下去的只有 `ns`（经 `BackendCreateOptions.neutralSessionId`）；②内核私有 id 由 adapter 派生，不由壳拼；③两条派生规则的精确形式——pi 走 `piDerivedSessionPath`，dsh 直接用 `ns`。后面 §3/§4 分别展开这两条规则，§6 展开「seed 也走同一条派生」。

- 映射方向的完整闭环（下行 = 壳 → 内核，上行 = 内核 → 壳）：

  ```
  下行（壳 → 内核）：neutralSessionId → lineageId → 派生 kernelPrivateId → 交内核
       ├─ 开新会话：newSessionId(cwd) 或 projectionPath(randomUUID()) 定出 ns + 路径（§3/§4）
       ├─ 起进程续聊：createPiBackend/createDshBackend 把 ns 翻译成内核 spawn 参数（§3/§4）
       └─ seed 投影：piSeedSession / DshBackend.seed 把 lineageId 定为内核会话 id（§6）
  上行（内核 → 壳）：内核私有 id/事件 → 适配器翻译 → 中立层（neutralSessionId 不变）
       ├─ getTree/getEntries：私有树 → LineageTree/NeutralMessage（pi-catalog/dsh RPC）
       ├─ entryAppended：内核吐回的 entry.id → 回填 kernelEntryId（syncNeutralEntry）
       └─ backend.sessionId：壳读取当前内核侧会话标识的唯一入口（不自行拼）
  ```

## 3. pi 的映射：ns → 派生文件路径 `<bucket>/<ns>.jsonl`

- pi 没有独立于「文件」的会话 id 层——会话就是文件，所以 pi 的映射不是「给个裸 id」，而是「派生一个路径」。路径规则的唯一权威是 `pi-catalog.ts` 的 `piDerivedSessionPath`：

  ```ts
  export function piDerivedSessionPath(agentDir: string, cwd: string, lineageId: string): string {
    return `${agentDir}/sessions/${cwdToBucketName(cwd)}/${lineageId}.jsonl`;
  }
  ```
  （`pi-catalog.ts:508-510`）

  - 关键在 `lineageId` 直接进文件名：`<bucket>/<lineageId>.jsonl`。因为根 lineage 的 `lineageId` ≡ `neutralSessionId`（§0），所以根会话的文件名恒等于 `ns`——`<bucket>/<ns>.jsonl`。这正是任务里「ns → 派生文件路径 `<bucket>/<ns>.jsonl`」的精确出处。

  - 文件注释把这条规则的「幂等」本质点透：「id 部分就是 lineageId，不含时间/随机部分——那是身份，不是可读性前缀（§24 幂等不变量）」（`pi-catalog.ts:503-507`）。注意：这推翻了早期设计文档 `kernel-forkless-branch.md` §12.2/§17 里「`<stamp>_<lineageId>.jsonl`」的旧写法——最终代码把 stamp 前缀也去掉了，文件名就是裸 `lineageId`，因为任何时间/随机前缀一旦进入身份就破坏了派生确定性。真实代码为主，stamp 已不存在。

  - `cwdToBucketName`（`sessions.ts:66`）是桶名规则的唯一源：`--<cwd 去首斜杠、斜杠/冒号换横线>--`。它是「会话按 cwd 分桶」这一业务本质的纯字符串变换，放圆心、零 IO，pi 文件路径与书签分桶共用。

- pi 映射的五个落点，逐一对应到代码：

  - **开新会话**：`PiSessionCatalog.newSessionId(cwd)` = `piDerivedSessionPath(agentDir, cwd, randomUUID())`（`pi-catalog.ts:628-632`）。它返回的是一个**预生成的路径**，且文件名（即 UUID）就是新 ns——`SessionCatalog.newSessionId` 契约注释说「pi=新会话文件路径，先 seed/生成得 id 再 spawn」（`backend.ts:290-293`）。返回 `string` 而非 null，是因为 pi 是文件型内核，需要预生成路径去 `--session <path>`。

  - **起进程续聊**：`createPiBackend`（`kernel-factories.ts:38-52`）做两件事：①`const sessionId = piDerivedSessionPath(opts.agentDir, opts.cwd, opts.neutralSessionId)`（`kernel-factories.ts:41`）把 ns 派生成路径；②`args.push("--session", sessionId)`（`kernel-factories.ts:42`）把路径塞进 pi 的 spawn 参数。所以「ns → 路径 → --session」是 pi 侧一条完整的翻译链，`sessionId` 同时作为 `PiBackend` 的 ctx 传入（`kernel-factories.ts:51`），成为 `BaseBackend.sessionId` 的取值（`AbstractBackend.sessionId` getter 返回 `ctx.sessionId`，`abstract-backend.ts:57-59`）。

  - **seed 投影**：`piSeedSession`（`pi-backend.ts:71-99`）里 `const sessionId = opts.lineageId`、`const path = piDerivedSessionPath(agentDir, cwd, opts.lineageId)`（`pi-backend.ts:72-73`），写出的 JSONL 头行 `type:"session"`、`id: sessionId`（= lineageId）。所以 pi 文件里的会话头 id 和文件名字都是 `lineageId`，二者一致，§6 再展开幂等。

  - **反查 ns**：`session-store.ts` 的 `neutralSessionIdFromPath(sessionPath)` = `basename(sessionPath, ".jsonl") || undefined`（`session-store.ts:380-382`）。因为 pi 派生路径的文件名恒等于 ns，取 basename 就能从路径反查回主键。这条反查是「路径 ↔ ns」双向成立的支点：`ensureForSend` 生成路径后、`start` 再反查回 ns 传 `createProc`，保证「路径文件名 === 中立主键」不漂移。

  - **列表/打开的投影地址**：`neutralToSessionInfo`（`session-store.ts:624-646`）算 `path: catalog.projectionPath(cwd, rootLineageId)`（`session-store.ts:634`），`id: rootLineageId`（`session-store.ts:635`）。pi 侧 `projectionPath` 就是 `piDerivedSessionPath`（`pi-catalog.ts:634-636`），所以 `SessionInfo.path` 对 pi 是派生文件路径，`SessionInfo.id` 是 root lineageId（= ns）。注意 `SessionInfo.path` 已降为「投影线索」，不再做主键——主键是 `neutralSessionId`（`sessions.ts:37-39`）。

- 一张图看 pi 的完整映射链：

  ```
  ensureForSend（新会话）                    start / createProc
    catalog.newSessionId(cwd)                 neutralSessionIdFromPath(path)
      = <bucket>/<randomUUID>.jsonl  ───────>  ns = randomUUID（文件名即 ns）
              │                                    │
              ▼                                    ▼
        activeSessionPath                    factory.create({neutralSessionId: ns})
              │                                    │
              └────────── 同一路径 ────────────────┘
                                                   ▼
                              createPiBackend：sessionId = piDerivedSessionPath(agentDir,cwd,ns)
                                                   │
                                                   ▼
                              --session <bucket>/<ns>.jsonl   →  PiBackend.sessionId = 路径
  ```

- 分支 lineage 的 pi 映射同理，只是 `lineageId` 换成 fork 时生成的 UUID：`fork()` 生成 `newLineageId = randomUUID()`（`session-store.ts:1536`），下次发送触发 `materializeActiveLineage` → `seed` 传 `lineageId: activeLineageId`（`session-store.ts:1559`）→ `piSeedSession` 写 `<bucket>/<branchUUID>.jsonl`。一条分支一个文件，文件名 = 分支 lineageId，与根会话文件并存于同一 `<bucket>` 下。

## 4. dsh 的映射：ns → SessionId 直接用

- dsh 与 pi 在映射上「处处相反」的一个典型：pi 要派生一个路径，dsh 的 `SessionId` 是**值对象、客户端可显式指定**，所以 dsh 侧「派生」退化成一个恒等函数——`lineageId` 就是 `SessionId`，root 会话的 `SessionId` 就是 `ns`。契约注释直接写「dsh=ns」（`backend.ts:231`）、「dsh=lineageId（SessionId 就是 lineageId）」（`backend.ts:296`）。

- 三个落点：

  - **惰性创建，不预生成**：`DshSessionCatalog.newSessionId(_cwd)` 返回 `null`（`dsh-catalog.ts:75-78`）。契约注释说「返回 null = 本内核惰性创建，服务端首次 prompt 时建」（`backend.ts:290-292`）。dsh 的会话在 dsh 进程内（`ctx.sessions` + `sessionPersistence`），壳没有、也不该有「预先造一个文件/会话」这一步。所以 `ensureForSend` 里走 `generated ?? catalog.projectionPath(this.activeCwd, randomUUID())` 分支（`session-store.ts:577`）：dsh 返回 null，壳就用 `projectionPath(randomUUID())` 现派一个裸 UUID 作为会话路径（见下条）。

  - **投影地址 = lineageId（恒等）**：`DshSessionCatalog.projectionPath(_cwd, lineageId)` 直接 `return lineageId`（`dsh-catalog.ts:80-82`）。对新会话，`ensureForSend` 传的 `randomUUID()` 就是新 ns——注释点透「新 ns 即投影地址（与中立主键同源）」（`session-store.ts:575-576`）。所以 dsh 侧 `SessionInfo.path`（= `projectionPath(rootLineageId)`）是一个**裸 UUID，不是文件路径**——这直接催生了 §5 的 `projectionPath` vs `rawFilePath` 区分。

  - **sessionId = ns 直接传给后端**：`createDshBackend`（`kernel-factories.ts:63-86`）里 `sessionId: opts.neutralSessionId`（`kernel-factories.ts:81`）——把 ns 原样交给 `DshBackend` 构造。`DshBackend` 构造函数 `this.currentSessionId = config.sessionId ?? cwdToBucketName(config.cwd)`（`dsh-backend.ts:94`），所以 dsh 后端初始的会话标识就是 ns（无 ns 时回落 cwd 桶名）。这是「dsh 的映射（ns → sessionId 直接用）」的最直白出处。

- dsh 的 `BaseBackend.sessionId` 覆写了基类，语义与 pi 不同：`DshBackend.sessionId` getter 返回 `this.currentSessionId`（`dsh-backend.ts:98-100`），而不是 `ctx.sessionId`。原因在 seed 的「重绑」——dsh 的 seed 依赖进程（`session/seed` RPC），seed 后服务端返回的 `sessionId` 要回绑到 `currentSessionId`，否则后续 `sendMessage`/`abort`/`setModel` 全读 `this.sessionId` 会发到构造时的桶名会话（`dsh-backend.ts:286-288` 注释把这个坑点名）。所以 dsh 的 `sessionId` 有两态：初始 = ns（惰性未建），seed 后 = 服务端返回的 `sessionId`（值仍是 lineageId，但由服务端权威回传）。

- dsh 的会话标识在事件流里的位置：`DshBackend.onEvent` 订阅 `session.event` 通知，通知参数带 `sessionId`（`dsh-backend.ts:153-156`）——dsh 的每个事件都标了它属于哪个 session。壳侧 `SessionProc.neutralSessionId` 才是路由主键，`backend.sessionId`（dsh 的 `currentSessionId`）只在发 `session/prompt`、`session/abort` 等 RPC 时作为 `sessionId` 参数传回。dsh 分支 lineage（fork 出的子会话）的映射规则同理：`sessionId = lineageId`（分支 UUID），只是 dsh 侧物化走 `session/seed` RPC 而非写文件。

- 一张图看 dsh 的映射：

  ```
  ensureForSend（新会话，dsh 惰性）
    catalog.newSessionId(cwd) = null
      └─> catalog.projectionPath(cwd, randomUUID()) = randomUUID   // 裸 UUID = ns = lineageId
              │
              ▼
        activeSessionPath = UUID
              │
              ▼
        neutralSessionIdFromPath(UUID) = UUID（无 .jsonl 后缀，basename 原样返回）
              │
              ▼
        createDshBackend({neutralSessionId: UUID})  →  DshBackend.sessionId 初始 = UUID
              │
              ▼
        sendMessage → session/prompt { sessionId: UUID }   // ns 直接当 SessionId 用
  ```

## 5. projectionPath vs rawFilePath：坐标系 vs 磁盘真相

- 两个方法都在 `SessionCatalog` 接口上（`backend.ts:295-307`），都收 `(cwd, lineageId)`，但回答的是两个不同的问题，根因是「dsh 的投影地址根本不是文件路径」。

  - **`projectionPath(cwd, lineageId): string`** 返回的是「会话的投影地址」，一个**坐标系**，不承诺磁盘上存在对应文件。契约注释原话：「注意：投影地址是坐标系，不承诺磁盘上存在对应文件——『打开原始文件』必须走 rawFilePath，不得把投影地址当文件路径直接打开」（`backend.ts:298-299`）。

  - **`rawFilePath(cwd, lineageId): string | null`** 返回的是「会话原始文件的真实磁盘路径」，**存在才返回**，不存在返回 null。契约注释：「返回 null = 磁盘上没有可打开的原始文件（临时会话/迁移前旧文件无投影等），调用方必须显式降级（提示用户），不得静默吞掉」（`backend.ts:302-306`）。

- 两个内核的取值对照：

  | 内核 | `projectionPath(cwd, lineageId)` | `rawFilePath(cwd, lineageId)` |
  |---|---|---|
  | pi | `piDerivedSessionPath(agentDir,cwd,lineageId)` = `<bucket>/<lineageId>.jsonl`（`pi-catalog.ts:634-636`） | `existsSync(派生路径) ? 派生路径 : null`（`pi-catalog.ts:638-643`） |
  | dsh | `lineageId`（裸 UUID，恒等，`dsh-catalog.ts:80-82`） | `existsSync(<sessionRoot>/<bucket>/<lineageId>/session.jsonl.zstd) ? 该路径 : null`（`dsh-catalog.ts:84-91`） |

- 区分的根因有两条，都来自「壳不读内核存储」这条不变量：

  - **dsh 的投影地址是裸 `lineageId`，不是路径。** dsh 的 `SessionId` 是值对象，`projectionPath` 把它原样返回，壳拿到的是一个 UUID 字符串——它**不能**被当作文件路径去打开。dsh 真实落盘形状是 `<sessionRoot>/<cwd 桶>/<lineageId>/session.jsonl.zstd`（`dsh-catalog.ts:85-86` 注释），这是一个只有 dsh 适配器知道的存储细节。若壳把 `SessionInfo.path`（= 裸 UUID）当路径去 `open`，必然找不到文件。所以「打开原始文件」这条链路必须绕开投影地址、走 `rawFilePath`，由 dsh 适配器解析出真实的嵌套 zstd 路径。

  - **pi 的投影地址 = 派生路径，但只在文件实际存在时才「是」原始文件。** pi 的 `projectionPath` 和 `rawFilePath` 在文件存在时值相同（都是派生路径），但语义仍被刻意分开：pi 是惰性建会话（进程首发才创建文件），「新建但未发言」的会话有投影地址、无磁盘文件；迁移前的旧 stamp 文件（§7）也不在派生路径上。所以 pi 的 `rawFilePath` 加 `existsSync` 守卫（`pi-catalog.ts:641-642`），把「坐标系」和「磁盘真相」在 pi 侧也拆开，与 dsh 对齐。

- 两个方法在壳侧的消费点，都在 `session-store.ts`：

  - `neutralToSessionInfo` 用 `projectionPath` 填 `SessionInfo.path`（`session-store.ts:634`）——列表行只展示「投影线索」，不打开文件。

  - `rawFilePaths(sessionId)`（`session-store.ts:611-620`）用 `rawFilePath` 填 `SessionRawFilePaths.kernel`（`sessions.ts:93-98`），同时用 `neutralStore.filePathOf(ns)` 填 `.desktop`（`session-store.ts:615`，壳自己的中立层文件 `<数据根>/sessions/<ns>.json`）。`SessionRawFilePaths` 注释把责任边界说死：「原始文件位置是内核专属知识，由服务端经 SessionCatalog.rawFilePath 解析，插件不拿投影地址硬猜」（`sessions.ts:91`）。返回的 `.desktop`/`.kernel` 各自可为 null，调用方显式降级。

- 结论一句话：`projectionPath` 是「这个会话在坐标系里叫什么地址」，`rawFilePath` 是「这个会话的原始文件现在在哪、能不能打开」。前者永远能算出来（纯派生），后者要查磁盘、可能为 null。把二者拆开，是因为「内核私有会话标识」和「内核私有文件位置」在 dsh 里已经不是同一个东西了，pi 里也只是「恰好同值、未必存在」。

## 6. seed 的 id 派生与幂等

- seed 是「壳 session ↔ 内核 session」映射在**写方向**的集中体现：把中立层的 lineage 内容物化到内核，返回内核侧会话标识。契约签名是 `BaseBackend.seed(lineage: NeutralEntry[], opts: SeedOptions): Promise<string>`（`backend.ts:131`），`SeedOptions = { neutralSessionId, lineageId, header }`（`backend.ts:56-60`）。返回的 `string` 就是内核侧标识，契约注释点明「§12.2 派生自 lineageId，幂等」（`backend.ts:130`）。

- seed 的入参只有「一条 lineage 的完整线性内容」（`NeutralEntry[]`），不是整棵树。因为内核是**单线执行器**——一次只物化当前活跃那条 lineage，分叉结构留在壳的中立层。这条线性内容由 `lineageContent(session, lineageId)` 纯函数沿 fork 链拼出（`session-neutral.ts:277-296`）。两个内核吃同一份 `NeutralEntry[]`，各投各的内核形态：pi 投 JSONL、dsh 投 `session/seed` 树（`dsh-backend.ts:54-56` 注释原话「换内核 = 换投影实现，中立层一行不动」）。

- **pi 侧 seed 的 id 派生**（`piSeedSession`，`pi-backend.ts:71-99`）：

  - `const sessionId = opts.lineageId`（`pi-backend.ts:72`）——会话 id 直接用 lineageId，不再 `randomUUID()`。这是「内核 id 现生成」这个反模式（`kernel-forkless-branch.md` §29.2）的根治点：身份由壳掌控，seed 只负责物化。

  - `const path = piDerivedSessionPath(agentDir, cwd, opts.lineageId)`（`pi-backend.ts:73`）——路径也由 lineageId 派生，与 §3 的 `piDerivedSessionPath` 同一条规则。

  - 写出的 JSONL 头行 `type:"session"`、`id: sessionId`、`custom-my-harness-desktop.kernel = opts.header.kernel`（`pi-backend.ts:76`）；逐 entry 写 message 行，`parentId` 挂前一条的 id（`pi-backend.ts:78-96`）。因为只写一条 lineage，`parentId` 退化成「前一条的 id」——**pi 的 parentId 树在 forkless 后是一条直线**，分叉结构只活在中立层。

  - 返回 `path`（`pi-backend.ts:98`），即 pi 侧会话标识。`PiBackend.seed` 直接委托本函数（`pi-backend.ts:185-187`），两者同源。

- **dsh 侧 seed 的 id 派生**（`DshBackend.seed`，`dsh-backend.ts:289-296`）：

  - `sessionId: opts.lineageId`（`dsh-backend.ts:291`）——把 lineageId 当 `SessionId` 传，dsh 的 `SessionId` 是值对象、可显式指定，所以「带着 id 去 seed」是 dsh 原生能力。root lineage 的 `lineageId === neutralSessionId`，root 会话的 dsh id 与中立主键一致，无差异。

  - `session: buildDshSeedSession(lineage, opts)`（`dsh-backend.ts:292`）——`buildDshSeedSession`（`dsh-backend.ts:61-75`）把「线性 `NeutralEntry[]`」重新包回 dsh 运行时 `session/seed` 要的「单 lineage 树」（`NeutralSession` 形状），且剥离 `display`（展示元数据永不进内核投影）。

  - `this.currentSessionId = res.sessionId`（`dsh-backend.ts:294`）——**重绑** `currentSessionId`，因为 `sendMessage`/`abort`/`setModel` 全读 `this.sessionId`，不重绑则发到构造时的桶名会话（§4 已述）。

- **幂等的物理基础是「派生函数是纯的」**：`lineageId` 是唯一身份，pi 路径、dsh 会话 id 都是它的确定性函数，同一条 lineage 每次 seed 得到同一个内核 id。

  - pi 侧：同 lineage → 同路径 → seed 两次覆盖写同一文件（`piSeedSession` 注释「seed 两次覆盖写同文件」，`pi-backend.ts:66`）。

  - dsh 侧：同 lineage → 同 `SessionId` → 服务端幂等（覆盖或复用，取决于 dsh 服务端实现）。

  - 根 lineage 是幂等的特殊情况：root 的 `lineageId` ≡ `neutralSessionId`，切内核后 root 会话 id 不变。

  - 这条幂等直接替代了早期设计里的 `SessionBindingStore` 映射表——「回切找回原会话」从「查表」变成「重算」：切回 pi 时 `piDerivedSessionPath(agentDir, cwd, lineageId)` 重算出同一个文件路径，重新 seed/打开即可，不存任何绑定行。`kernel-forkless-branch.md` §12.3 把这张表的三个用途各自判了归宿：回切恢复 → 派生重算；内核归属判定 → `NeutralSession.header.kernel` 字段；运行时私有 id → `SessionProc` 的 transient 字段（`neutralSessionId`）。

- seed 的**生命周期不对称**（`BackendFactory.seed?`，`backend.ts:246-256`）是幂等之外的第二个关键：

  - pi 的 seed 是**纯文件写，不依赖进程**，必须「先 seed 得路径、再以该路径 spawn」——所以 `BackendFactory.seed?` 预 seed 返回 `string`（派生路径）。

  - dsh 的 seed 是 `session/seed` RPC，**依赖进程**，不能预 seed——所以返回 `null`，由 `create → start → backend.seed` 在 start 之后处理。

  - 壳侧两条编排路径都吃这套不对称：`switchKernel`（`session-store.ts:949-975`）与 `materializeActiveLineage`（`session-store.ts:1562-1585`）都是「`seedFn` 返回非 null → 先 seed 得路径再 create/start（pi）；返回 null → 先 create/start 再 backend.seed（dsh）」。这保证了幂等派生在「spawn 前」和「spawn 后」两个时机都能成立。

## 7. 旧随机 stamp 文件的迁移边界

- 迁移边界指：pi 的会话文件名从旧命名 `<stamp>_<id>.jsonl`（带时间戳前缀 + 随机 id）改成新命名 `<lineageId>.jsonl`（裸 lineageId，§3）之后，磁盘上遗留的旧文件处于什么状态、壳如何对待它们。这整条边界的行为，最终落在「壳的读取面只读中立层」这一条上。

- 旧文件的定义先钉死：旧命名 `<stamp>_<id>.jsonl` 里的 `<id>` 是 pi 内核在 forkless 之前自己 `randomUUID()` 生成的会话 id（`kernel-forkless-branch.md` §29.2 反模式的产物），文件名里那个 `<stamp>` 是时间戳。这两个部分**都不等于** `neutralSessionId`，也不等于任何 lineageId。所以在新的派生规则下，旧文件的名字无法从任何 `lineageId` 反推出来，它是一条「新规则覆盖不到」的孤儿。

- 迁移边界的第一道墙：`list` 只读中立层。`session-store.list(cwd)` 的实现是 `this.neutralStore?.listByCwd(cwd) ?? []`（`session-store.ts:602`），`NeutralSessionStore.listByCwd` 扫 `<数据根>/sessions/*.json` 按 `header.cwd` 过滤（`neutral-session-store.ts:39-52`）。旧 stamp 文件从未进过中立层（它们是 forkless 之前、中立层出现之前建的），所以**旧会话在中立层读取面下不可见**——列表里看不到、点不开。这是「壳是唯一源」的固有代价（`kernel-forkless-branch.md` §28「内核独立创建的会话壳侧不可见，接受，未来可加导入面」）。

- 迁移边界的第二道墙：`neutralSessionIdFromPath` 的反查对旧文件「反查不回主键」。它的实现是 `basename(sessionPath, ".jsonl") || undefined`（`session-store.ts:381`），注释声称「旧随机 stamp 文件文件名不含 ns → 返回 null」（`session-store.ts:378-379`）。真实代码行为与注释有一处需如实标注的偏差：`basename` 对旧文件 `<stamp>_<id>.jsonl` 返回的是 `<stamp>_<id>` 这个字符串，而非 `null`（`null` 只在 basename 为空串时经 `|| undefined` 出现）。但这不改变结论——`<stamp>_<id>` 不是一个合法 `neutralSessionId`，随后 `neutralStore.get("<stamp>_<id>")` 必然返回 `null`（`neutral-session-store.ts:26-34`），所以下游的 `writeNeutralHeader`（`session-store.ts:665-676`）会因 `if (!session) return` 提前退出，`projectHeaderToKernel` 会因 `(ns && neutralStore?.get(ns)?.header.kernel) || "pi"` 回落 `"pi"`（`session-store.ts:684`）。真正的守卫不在 `neutralSessionIdFromPath` 内部，而在中立层读不到这一环。

- 迁移边界的第三道墙：`rawFilePath` 对旧文件返回 null。`PiSessionCatalog.rawFilePath` = `existsSync(piDerivedSessionPath(agentDir,cwd,lineageId)) ? path : null`（`pi-catalog.ts:638-643`）。对一个「本应从旧文件继承」的会话，它的 lineageId 派生路径 `<bucket>/<lineageId>.jsonl` 在磁盘上不存在（旧文件在 `<bucket>/<stamp>_<id>.jsonl`），所以 `rawFilePath` 返回 null → `rawFilePaths` 的 `.kernel` 为 null（`session-store.ts:618-619`）→ 「打开原始文件」这条入口显式降级。注释把这条边界点明：「迁移前旧文件（<时间戳>_<id>.jsonl 命名）的投影路径不存在 → null，调用方显式降级（§7.6 不静默）」（`pi-catalog.ts:639-640`）。

- 把三道墙合成一张边界图：

  ```
  旧文件：<bucket>/<stamp>_<id>.jsonl   （id 是 pi 旧随机 UUID，非任何 lineageId/ns）

    list(cwd)          → 读中立层 listByCwd        → 旧文件无中立层条目 → 列表不可见
    openSession(id)    → 读中立层 get(id)           → 无此 neutralSessionId → null
    rawFilePath(...)   → existsSync(<bucket>/<lineageId>.jsonl) → 派生路径不存在 → null
    neutralSessionIdFromPath(<stamp>_<id>.jsonl) → "<stamp>_<id>"（非合法 ns）→ neutralStore.get() 落空
  ```

- 迁移边界没有「自动迁移」步骤：代码里没有把 `<stamp>_<id>.jsonl` 重命名/导入成 `<ns>.jsonl` 或补建中立层条目的逻辑。旧文件原样留在 `~/.pi/agent/sessions/<bucket>/` 下，pi 内核自己还能经 `--session` 打开它，但壳的列表/打开/原始文件三条面都对它「看不到」。这与 `kernel-forkless-branch.md` §28 的「内核独立创建的会话壳侧不可见」是同一语义——迁移边界不是「旧文件被删」，而是「旧文件退出了壳的可见面」。要恢复，只能走未来可选的「从内核存储导入」面，当前未实现、显式标注演进。

## 8. 未来第三个内核要交什么

- 接第三个内核，壳与圆心必须一行不改。这句话的可执行形态就是：新内核交一个 `BaseBackend` 实现（15 abstract + 4 可缺面 + 3 默认成员）+ 一个 `SessionCatalog` 实现 + 一个 `KernelModelSource` 实现 + 一个工厂，注册进 `bootstrap/kernel`。本文只聚焦「会话映射」这一半，所以重点落在 `SessionCatalog` 的**三个方法**与 `BaseBackend` 的**会话标识相关面**。

- 第三个内核在 `SessionCatalog` 上必须回答三个问题，对应三个方法（`backend.ts:293-307`）：

  - **`newSessionId(cwd): string | null`**——「开新会话要不要预生成内核侧标识？」回答 `string` = 本内核需预生成（像 pi，先得到标识再 spawn，通常是有文件/路径型存储的内核）；回答 `null` = 本内核惰性创建（像 dsh，服务端首次 prompt 时建，无文件可预生成）。这个返回值直接决定 `ensureForSend` 的分支：非 null 走 `generated`，null 走 `projectionPath(randomUUID())` 派生裸地址（`session-store.ts:574-577`）。第三个内核必须诚实回答自己属于哪一类——这是「生命周期不对称」在 `SessionCatalog.newSessionId` 上的显式化。

  - **`projectionPath(cwd, lineageId): string`**——「这个 lineage 在内核坐标系里的投影地址是什么？」必须是一个**由 `lineageId` 确定性派生**的字符串（幂等），可以是路径（pi）、可以是裸 id（dsh）、可以是任何内核自定形状，但必须是坐标系而非磁盘真相。它的消费方是 `neutralToSessionInfo` 填 `SessionInfo.path`（`session-store.ts:634`）。第三个内核选择「路径」还是「裸 id」是它的自由，但一旦选裸 id，就必须同时把 `rawFilePath` 实现对（见下条），否则「打开原始文件」会断。

  - **`rawFilePath(cwd, lineageId): string | null`**——「这个 lineage 的原始文件现在在磁盘哪、能不能打开？」必须解析出真实落盘路径并 `existsSync` 守卫，不存在返回 null（临时会话/迁移前旧文件无投影等）。消费方是 `rawFilePaths`（`session-store.ts:618`）。第三个内核若不落磁盘文件（纯内存/远程会话），返回 null 是合法的，但要让调用方显式降级，不得静默。

- 三方法之外，第三个内核在**会话标识**这条链上还有几处必须对齐：

  - `BaseBackend.sessionId`（`backend.ts:79`）——必须返回「当前内核侧会话标识」，壳经它读，不自拼。基类默认 `ctx.sessionId ?? null`（`abstract-backend.ts:57-59`），dsh 覆写加了桶名默认 + seed 重绑；第三个内核按需覆写，但语义必须满足「pi=文件路径/dsh=session id」这类「内核私有标识」的定位。

  - `BaseBackend.seed(lineage, opts)`（`backend.ts:131`）——必须从 `opts.lineageId` 派生内核侧 id（幂等），不能 `randomUUID()` 现生成。这是「id 派生」对第三个内核的硬约束：一旦它现生成 id，就会退回「映射表」时代，破坏「回切重算同 id」这一整套无表机制。返回的 `string` 是内核侧标识。

  - `BackendFactory.seed?`（`backend.ts:255`）——第三个内核必须明确自己是「预 seed 型」（seed 不依赖进程，返回 string）还是「后 seed 型」（seed 依赖进程，返回 null），并与 `newSessionId` 的类型自洽（通常文件型内核两者都预生成，RPC 型内核两者都惰性）。

  - `BackendCreateOptions.neutralSessionId`（`backend.ts:231`）——第三个内核的工厂从 `opts.neutralSessionId` 派生自己的内核侧 id，规则自定但必须确定性、幂等，且注释里那条「壳只传 ns，内核私有 id 由 adapter 派生」的契约要继续成立。

- 三方法的「可交付验收」一句话：给定同一个 `lineageId`，`projectionPath` 与 `seed` 返回的内核侧 id 必须稳定同源；`rawFilePath` 只在原始文件真实存在时返回非 null；`newSessionId` 的 null/非 null 与 `BackendFactory.seed?` 的 null/非 null 自洽。三者齐了，第三个内核的「会话模型映射」这一样（§6.4 三样之一的「会话模型映射」）就交付完成，壳的 `session-store` 一行不改即可托管它——因为它只经 `catalogFor(kernel)`（`session-store.ts:225`）和 `factory`（`session-store.ts:158`）这两个接口说话。

- 附带一个「加内核」的圆心侧联动，虽不属于 `SessionCatalog` 但属于「第三个内核」的完整交付清单：`KernelId` 联合与 `KERNEL_IDS` 数组在 `packages/shared/src/domain/kernel.ts:10-13` 各加一个字面量，编译器会逼着补全所有 `switch(kernel)` 与 `KERNEL_IDS` 消费处（`kernel.ts` 注释点明这是字面量联合的直接红利）。加上 `BaseBackend` 15 abstract（`abstract-backend.ts:44-125`）编译器逼着逐条实现，漏一条就编译错，杜绝静默缺面。会话映射这一半，`SessionCatalog` 三方法 + `seed` 派生 + `sessionId` 语义，就是第三个内核要交的全部。

## QA

**Q：为什么不在壳里存一张 `neutralSessionId → 内核私有 id` 的映射表，而是靠派生？**

- 因为映射表记的是「多对一、随时间变」的关系——一次 fork 就多一个文件/子会话，pi 下是「根文件 + 若干 fork 文件」多个路径，dsh 下是「主会话 + 若干 childSessionId」多个 id。而派生用纯函数取代了这个关系：只要 `lineageId` 不变，内核 id 就不变，回切找回原会话从「查表」变成「重算」。早期设计的 `SessionBindingStore` 正是因此被整体移除（`kernel-forkless-branch.md` §12.3），当前代码里已无此表。派生还消灭了「内核 id 现生成」这个反模式——内核 id 由壳掌控（`piSeedSession` 里 `sessionId = opts.lineageId`，`pi-backend.ts:72`）。

**Q：`neutralSessionId` 和根 `lineageId` 到底是同一个东西吗？**

- 值相同、职责不同。根 lineage 的 `lineageId` 恒等于 `neutralSessionId`（`createProc` 里 `activeLineageId = ns`，`session-store.ts:431`），所以 root 会话的内核 id（pi 文件名 / dsh SessionId）就是 `ns`。但 `neutralSessionId` 是「会话」这一层的身份（列表/书签/分组的主键），`lineageId` 是「一条线性历史」这一层的身份（fork 出的分支各有一个自己的 lineageId）。一个会话可以有多个 lineageId（根 + 若干分支），但只有一个 `neutralSessionId`。分支 lineage 的 `lineageId` 是 fork 时 `randomUUID()`，与 `neutralSessionId` 无关。

**Q：dsh 的 `projectionPath` 返回裸 UUID，壳怎么打开 dsh 的原始文件？**

- 壳不「拿投影地址猜」，而是走 `rawFilePath`。`SessionInfo.path` 对 dsh 是裸 `lineageId`（坐标系，不是路径），真正落盘在 `<sessionRoot>/<cwd 桶>/<lineageId>/session.jsonl.zstd`，这条路径只有 `DshSessionCatalog.rawFilePath` 知道（`dsh-catalog.ts:84-91`）。`session-store.rawFilePaths` 经 `catalog.rawFilePath` 解析（`session-store.ts:618`），`SessionRawFilePaths` 注释钉死「插件不拿投影地址硬猜」（`sessions.ts:91`）。这正是 `projectionPath` 与 `rawFilePath` 必须拆开的根因——dsh 的投影地址根本不是文件路径。

**Q：为什么 pi 的 `rawFilePath` 要对派生路径做 `existsSync` 守卫？**

- 因为「派生路径」是坐标系，「磁盘上有这个文件」是另一回事。pi 惰性建会话（进程首发才创建文件），「新建但未发言」的会话有投影地址、无磁盘文件；迁移前的旧 stamp 文件（`<stamp>_<id>.jsonl`）也不在派生路径 `<bucket>/<lineageId>.jsonl` 上。所以 `rawFilePath` 加 `existsSync`（`pi-catalog.ts:641-642`），不存在返回 null，调用方显式降级。若不加守卫，「打开原始文件」会对一个不存在的路径静默失败或误开。

**Q：seed 两次，pi/dsh 各发生什么？**

- pi：`piSeedSession` 同 `lineageId` → 同路径，第二次覆盖写同一 JSONL（`pi-backend.ts:66` 注释「seed 两次覆盖写同文件」）。dsh：同 `lineageId` → 同 `SessionId` → 服务端幂等（覆盖或复用）。所以「切回已物化的分支」只需重新打开/seed，不重写新内容，也不用查表找回。这是「派生确定性」的直接后果。

**Q：旧 `<stamp>_<id>.jsonl` 文件还能在壳里打开吗？**

- 壳的读取面（`list`/`openSession`）只读中立层，旧文件从未进过中立层，所以列表看不到、点不开；`rawFilePath` 对它们的派生路径也不存在，返回 null，「打开原始文件」显式降级。旧文件原样留在 pi 会话目录，pi 内核自己能 `--session` 打开，但壳对它们不可见。当前没有自动迁移/导入逻辑，属「壳是唯一源」的固有代价，未来可选的「从内核存储导入」面未实现。

**Q：第三个内核如果要「惰性创建会话」，必须同时做对哪两件事？**

- ① `newSessionId` 返回 `null`（不预生成）；② `projectionPath` 返回一个由 `lineageId` 派生的稳定地址（哪怕不是路径），并让 `ensureForSend` 的 `generated ?? projectionPath(randomUUID())` 分支（`session-store.ts:577`）能据此定出新 ns。同时 `BackendFactory.seed?` 也返回 `null`（seed 依赖进程），三处「惰性」要自洽——这正是 dsh 的现状：`newSessionId = null`、`projectionPath = lineageId`、`seed` 依赖 `session/seed` RPC。

**Q：壳在什么情况下会「自己拼内核会话 id」？**

- 一次都不该。契约把它钉死：「壳经 `backend.sessionId` 读取，不自行按内核身份拼内核会话 id」（`backend.ts:78`）、「壳不自己拼内核的会话路径」（`backend.ts:292`）。所有需要内核侧标识的地方，要么读 `backend.sessionId`，要么经 `SessionCatalog` 三方法（`catalogFor(kernel)` 委托），要么由 `seed` 返回。`createPiBackend`/`createDshBackend` 里从 `neutralSessionId` 派生的逻辑收在工厂闭包（`kernel-factories.ts`），是「执行」不是「壳拼」——拼装的规则属于内核适配器，壳只传 ns。
