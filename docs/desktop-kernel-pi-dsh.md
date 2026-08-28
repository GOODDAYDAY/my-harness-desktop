# desktop 与内核 pi & dsh 的完整说明

> 本文是 my-harness-desktop 多内核集成的主文档。它回答一个问题：**薄壳 desktop 如何把 pi 与 dsh 两个同级内核都托管起来，又不让任何一个内核的存储格式、事件形状、插件树、fork 语义泄漏进壳。** 每个结论都落到具体文件、函数、类型名；"内核""壳""中立契约""适配器""圆心""中性"等术语沿用 CLAUDE.md 的约定（读到底座按 pi 内核理解）。

## 1 总体架构：壳托管两个同级内核

### 1.1 全景图

```
                              ┌────────────────────────────────────────────────┐
                              │              壳（my-harness-desktop）            │
                              │                                                │
                              │  packages/shared/src/domain/  ── 圆心（零依赖）   │
                              │    kernel.ts  backend.ts  session-neutral.ts     │
                              │    kernel-manager.ts  events/                    │
                              │        ▲            ▲           ▲               │
                              │  依赖只向内 │            │            │               │
                              │        │            │            │               │
                              │  src/server/application/  ── 用例编排            │
                              │    sessions/session-store.ts（只依赖 BaseBackend │
                              │    + BackendFactory 接口）                       │
                              │    models/model-catalog.ts（只依赖               │
                              │    KernelModelSource 接口）                      │
                              │        ▲ 依赖倒置（接口在内层，实现在外层）        │
                              │        │                                         │
                              │  src/server/kernel/  ── 内核层 + 骨架            │
                              │    core/（abstract-backend + kernel-manager      │
                              │           + kernel-runtime + kernel-reconcile）  │
                              │    pi/（PiBackend · PiSessionCatalog · protocol   │
                              │          · manager · model · extension）         │
                              │    dsh/（DshBackend · DshSessionCatalog ·        │
                              │           protocol · manager · extension）       │
                              │    factories/（把接口与实现绑起来）               │
                              │        ▲                                         │
                              │        │ spawn / JSONL / JSON-RPC               │
                              └────────┼────────────────────────────────────────┘
                                       │ 子进程（被壳管理的资源）
                    ┌──────────────────┴───────────────────┐
                    │  pi 内核进程（node cli.js --mode rpc） │  dsh 内核进程（node bin.js <cordis.yml>）
                    │  JSONL 31+ 命令 · parentId 树         │  JSON-RPC 2.0 · session forest
                    │  JSONL 会话文件 · TS 扩展             │  cordis 插件树 · settings.yaml
                    └──────────────────────────────────────┘
```

一句话：**pi 和 dsh 是同一抽象（`BaseBackend`）的两个实现，谁也不比谁更"内建"；壳只认圆心的一份中立契约，每个内核各交一个适配器把它翻译成中性形状。** 换内核 = 换适配器，application 与 domain 一行不改；禁掉 dsh，壳照常启动，只是少了 dsh 那份能力。

### 1.2 四抽象

多内核架构的四个并列抽象，边界钉死（对照 CLAUDE.md §6.4）：

| 抽象 | 是什么 | 不拥有 / 不做 | 物理落点 |
|---|---|---|---|
| **内核** | 自洽的 agent 运行时（插件树 + 会话模型 + 能力集） | 不出 UI；不知道也不需要知道自己被托管 | `src/server/kernel/{pi,dsh}/` 之外，内核本身是外部 npm 包/子进程 |
| **壳** | 槽位/渲染/布局/事件总线的机制 | 不读任何内核的存储格式、事件形状、插件树、fork 语义 | `packages/shared`（圆心）+ `src/server`（机制）+ `src/web`（渲染机制） |
| **中立契约** | 壳需要内核提供的最小意图集合（`BaseBackend` + `SessionCatalog` + `KernelModelSource`） | 不塞内核专属概念（`steer`/`onExtensionUI` 不进契约；思考档位设置 `setThinkingLevel` 已进、dsh 显式降级） | `packages/shared/src/domain/backend.ts` |
| **适配器** | 内核专属形状 ↔ 中立契约的翻译，每内核一个 | 不做"让 dsh 装 pi"的翻译层（不重实现 pi 的 31 命令/parentId） | `PiBackend` / `DshBackend` + 各自的 `*SessionCatalog` |

一个内核要"接入"壳，交三样东西：

- **spawn 命令**：pi = `node cli.js --mode rpc`（`resolvePiSpawn`，`subprocess-lifecycle.ts`）；dsh = `node bin.js <cordis.yml>`（`computeDshSpawn`）。
- **适配器**：`PiBackend extends AbstractBackend` / `DshBackend extends AbstractBackend`，把专属形状投成中立契约。
- **会话模型映射**：把会话落到 lineage 坐标系（pi 的 parentId 树、dsh 的 session forest 都要能投影成 `LineageTree`）。

验收标准：起得来、契约意图逐条有响应（或显式"不支持"）、崩了壳能收尾。

### 1.3 分层洋葱与依赖方向

依赖箭头永远指向圆心；跨层协作靠依赖倒置（接口定义在内层、实现在外层、启动期注入）。三条物理防线：

- `packages/shared/src/domain/` 零 import——放不下 electron/react/任何内核，物理上 import 不了。
- `src/server/application/` 对 `kernel/{pi,dsh}` 具体实现**非 type-only** import 归零——`session-store.ts` 只 import `PiBackendExtensions` 接口（`import type`），不 import `PiBackend` 类。
- `src/server/kernel/core/` 只 import `packages/shared`，绝不 import `pi`/`dsh`——`AbstractBackend`、`KernelManager` 是机制不是内容。

内核层的位置：`src/server/kernel/pi` 与 `src/server/kernel/dsh` 是洋葱里同一层（内核层）的两个实现，与 `src/server/client/{fs,git,npm,remote}` 并列——内核和 git、文件系统是同一层抽象，都是"被壳管理的资源"。内核连接是双向的（命令出、事件入），但它是应用驱动的外部资源——我们 spawn 它、持有它、kill 它——所以执行件（`rpc-adapter.ts`、`json-rpc.ts`、`subprocess-lifecycle.ts`）都归各自内核目录。

### 1.4 内核与壳插件的本质区别

内核**不是**壳插件：壳插件是"被壳加载的代码"（挂在槽位上的 UI），内核是"被壳管理的进程"（有独立生命周期、配置、版本、插件树、会话模型）。这条边界在物理上体现为：壳插件只 import `@my-harness-desktop/shared` 和 `@my-harness-desktop/react`；内核适配器 import `@my-harness-desktop/shared` + `node:` 内置模块，绝不 import React。

## 2 中立契约逐方法说明 + pi/dsh 逐意图对照

### 2.1 契约总览：`BaseBackend` 的成员构成

`packages/shared/src/domain/backend.ts` 的 `BaseBackend` 接口分四块：

- **必实现面**（接口非 optional 成员）：`kernel`、`alive`、`sessionId`、`start`、`stop`、`onEvent`、`getTree`、`getEntries`、`bookmark`、`deleteBookmark`、`sendMessage`、`abort`、`setModel`、`setThinkingLevel`、`setSessionName`、`seed`、`capabilities`（共 17 个成员面）。
- **可缺面**（`?` 可选成员，内核有则实现、无则壳降级）：`resume?`、`continue?`、`listTools?`、`answerQuestion?`。
- **可缺面默认成员**：`configDepPaths?`（可选字段，`AbstractBackend` 给了 getter 默认 `[]`）。

`AbstractBackend`（`src/server/kernel/core/abstract-backend.ts`）把其中 **14 个声明为 abstract**（`kernel`/`alive`/`start`/`stop`/`onEvent`/`sendMessage`/`abort`/`setModel`/`setSessionName`/`getTree`/`getEntries`/`bookmark`/`deleteBookmark`/`seed`），加第 N 个内核时编译器逼着它实现全量意图，漏一条就编译错；**3 个给默认成员**（`capabilities={}`、`configDepPaths` getter→`[]`、`sessionId` getter→`ctx.sessionId`）；**4 条可缺面给缺面默认**（`listTools`→`null`、`answerQuestion`/`continue`/`setThinkingLevel`→`Promise.reject`，不静默吞、不伪造成功）。

> 注：CLAUDE.md 的"15 必实现 + 4 缺面 + 3 默认成员"口诀里那个第 15 条是 `fork`，但 `fork` 实际上**从未进过 `BaseBackend`**——pi 的 fork 是扩展面 `PiBackend.forkCommand`（`implements PiBackendExtensions`），返回 `RpcResponse` 让 `SessionStore` 查 `cancelled`。`resume?` 也不在基类——dsh 覆盖、pi 不实现，属可选意图。本文以代码为准。

### 2.2 六条核心意图 + 之上叠的意图，逐条说明

**意图一：消息（`sendMessage`）**。唯一会起进程的入口（`session-store.ts` 的 `prompt` → `ensureForSend` → `backend.sendMessage`）。resolve 只代表内核接受，输出靠事件流。pi = `buildPromptCommand`（`protocol/commands.ts`，`{type:"prompt", message, images, streamingBehavior}`）；dsh = `DSH_METHODS.sessionPrompt` RPC（`contentBlocks: [{type:"text",text}]` + `images: [{data, mediaType, name}]`）。

**意图二：中断（`abort`）**。pi = `buildAbortCommand`（`{type:"abort"}`），带 `ABORT_TIMEOUT_MS = 8_000` 快速失败超时——工具不响应 agent signal 时强制放弃不阻塞；dsh = `requestSession(DSH_METHODS.sessionAbort, {sessionId})`，懒探测缺面。`SessionStore.abort` 对 pi 还有"先 `abortBash` 再 `abort`"的双保险（`executeBash` 路径持独立 abortController，`agent.abort` 不覆盖）。

**意图三：模型（`setModel`）**。⚠ 两个内核定模型的时机不对称（`AbstractBackend.setModel` 注释点明）：pi 在 `setModel` 时定（`set_model` RPC），start 时不定；dsh 在 `start` 的 `initialize` 握手时定，`setModel` 因旧运行时缺 `session/setModel` 是 no-op。所以"发起 LLM 前必须先定模型"——dsh 侧要换模型只能停旧进程、带新 provider/model 重启（由 `session-store` 的 `ensureForSend` 编排），不能指望 `setModel` 生效。

**意图四：分支**。`getTree`（拿全部 lineage 及父子/分叉点关系）+ `getEntries`（拿一条 lineage 的线性消息序列）+ `bookmark`（把分叉点持久化成可重启锚点）+ `resume?`（从锚点重启）。分叉点引用 `BoundaryRef = string` 是不透明字符串——pi 把它当 `entryId`，dsh 把它当 `seq` 的字符串化；语义上总指向"父 lineage 里一个完整回合之后的位置"，壳不解析其内容，只当 token 在 fork/bookmark/resume 间回传。

**意图五：会话标识**。`sessionId`（内核侧会话标识：pi=JSONL 文件路径，dsh=不透明 session id/桶名）+ `seed`（把"活跃 lineage 的完整线性内容"物化到内核，返回内核侧会话标识，幂等）。

**意图六：流式事件**。`onEvent(cb)` 订阅中性事件流，返回取消函数。pi = `translateEvent(piEvent)`（`event-translator.ts`）；dsh = `createDshEventTranslator()` 流式组装（`dsh-event-translator.ts`）。

**第七意图：命名（`setSessionName`）**。pi = `buildSetSessionNameCommand`（`set_session_name` RPC）；dsh = `DSH_METHODS.sessionRename` RPC（懒探测缺面，旧运行时 unknown method → 记缺面 + no-op，命名是可选能力不因缺面打断发送）。壳经此命名，不再经 pi 扩展面。

**第八意图：续跑（`continue?`）**。异常停机（工具失败/LLM 失败/max-tokens/崩溃/取消）后原地续跑，不 fork、不重发旧消息。dsh = `session/continue` RPC（服务端按 turn/end reason 语义分发）；pi 无语义化 continue，适配器翻译成 `followUp("继续未完成的工作…")`。

**`seed`（跨内核切换投影）**。`SeedOptions = { neutralSessionId, lineageId, header }`；`seed(lineage: NeutralEntry[], opts)` 把单条 lineage 线性内容物化。pi = `piSeedSession` 写 JSONL 文件（纯文件写，不依赖进程）；dsh = `buildDshSeedSession` 重新包回 `NeutralSession` 树 + `session/seed` RPC（依赖进程）。

**工具发现（`listTools?`）**。pi = `readKnownTools(this.ctx.cwd)`（读 tool-gate 播报文件 `desktop-known-tools.json`）；dsh 继承缺面默认返回 `null`，壳走降级。

**提问（`answerQuestion?`）**。pi = `extension_ui_response` 帧翻译（`adapter.sendExtensionUIResponse`，取首个答案的 `custom ?? selected[0]`，空值转 `cancelled: true`）；dsh = `writeDshAnswer(questionId, answers)`（写 `<requestId>.answer.json` 文件侧车，dsh ask 扩展轮询读取）。

**能力探测（`capabilities`）**。`{ pi?: unknown; dsh?: DshCapabilities }`。pi 给 `{ pi: this as PiBackendExtensions }`（对圆心是 opaque unknown，`src/server/application` 经 type-only import 收窄）；dsh 给 `{ dsh: { missing: Set<string>, onMissing: (m)=>void | null } }`——懒探测的运行时能力面。壳经 `backend.capabilities.pi`/`backend.capabilities.dsh` 探测"有则用、无则降级"，不按内核身份硬分支。

### 2.3 逐意图对照表（pi vs dsh）

| 意图 | 中立契约成员 | pi 实现（`PiBackend`） | dsh 实现（`DshBackend`） |
|---|---|---|---|
| 内核身份 | `kernel` | 字面量 `"pi"` | 字面量 `"dsh"` |
| 存活 | `alive` | `adapter.alive`（RpcAdapter→SubprocessHandle） | `transport.alive`（JsonRpcTransport→SubprocessHandle） |
| 会话标识 | `sessionId` | `ctx.sessionId`（派生文件路径） | `currentSessionId`（构造缺省 = `cwdToBucketName(cwd)`，`seed` 后重绑服务端返回 id） |
| 起进程 | `start` | `adapter.start()` + `get_state` 就绪探测（150ms 间隔、4s 上限） | `transport.start()` + `initialize` 握手（带 "no adapter registered" 瞬时错误重试、10s 上限） |
| 停进程 | `stop` | `adapter.stop()`（关 stdin→1s→SIGTERM→2s→SIGKILL） | `transport.stop()` + `tempDir` `rmSync` 清理 |
| 事件流 | `onEvent` | `translateEvent(piEvent)`（22 条 type 映射） | `createDshEventTranslator()`（无状态映射 + 流式组装） |
| 树 | `getTree` | `piReadSessionTree(sessionId)`（读 JSONL 文件、parentId 连树、`projectLineageTree` 投影） | `requestSession(sessionGetTree)` RPC（懒探测） |
| 条目 | `getEntries` | `piReadSessionEntries(sessionFile, lineageId)`（文件读、沿首子走主干） | `requestSession(sessionGetEntries)` RPC |
| 书签 | `bookmark` | 只存 `{lineageId, entryId}` 坐标（`session-neutral-layer.md §12` 终态，无副本） | `session/bookmark` RPC（`boundarySeq: Number(entryId)`）+ 回坐标 |
| 恢复 | `resume?` | **不实现**（缺面） | `session/resume` RPC → `res.lineageId` |
| 继续 | `continue?` | `followUp("继续未完成的工作…")`（适配器翻译） | `session/continue` RPC（懒探测缺面） |
| 删书签 | `deleteBookmark` | no-op（坐标书签无副本回收） | `session/deleteBookmark` RPC |
| 发消息 | `sendMessage` | `buildPromptCommand`（`prompt` 命令） | `session/prompt` RPC（`contentBlocks` + `images`） |
| 中断 | `abort` | `buildAbortCommand`（8s 超时） | `session/abort` RPC（懒探测） |
| 切模型 | `setModel` | `buildSetModelCommand`（`set_model`，start 时不定） | `session/setModel` RPC（懒探测；旧运行时缺方法 → warn + no-op，模型停在握手值） |
| 思考强度 | `setThinkingLevel` | `override` → `{type:"set_thinking_level", level}` RPC | 继承缺面默认抛错（reasoningEffort 只在 initialize/settings.yaml 定） |
| 命名 | `setSessionName` | `buildSetSessionNameCommand` | `session/rename` RPC（懒探测缺面 → no-op） |
| seed | `seed` | `piSeedSession` 写 JSONL 文件（返回派生路径，幂等） | `buildDshSeedSession` 包树 + `session/seed` RPC（**重绑 `this.sessionId`**） |
| 工具发现 | `listTools?` | `readKnownTools(cwd)`（tool-gate 播报） | 继承缺面默认 `null` |
| 提问 | `answerQuestion?` | `extension_ui_response` 帧（stdin 写回） | `writeDshAnswer`（写 answer 文件侧车） |
| 能力面 | `capabilities` | `{ pi: this }`（`PiBackendExtensions`） | `{ dsh: { missing, onMissing } }` |
| 配置依赖 | `configDepPaths` | `[agentDir/models.json, agentDir/settings.json]` | `[cordisConfig, settingsPath]` |

### 2.4 `SessionCatalog`：per-kernel 跨会话目录/CRUD 的中立面

`SessionCatalog` 与 `BaseBackend` 正交：`BaseBackend` 是 per-session 的进程+分支句柄（有 start/stop 生命周期），`SessionCatalog` 是 per-kernel 的跨会话存储（列/开/改/删/复制/统计）。壳不读任何内核存储——这些操作的 pi 答案是 JSONL 文件 + parentId 树，dsh 答案是 append-only log + session forest，都退进各自适配器实现。

| 方法 | pi（`PiSessionCatalog`） | dsh（`DshSessionCatalog`） |
|---|---|---|
| `kernel` | `"pi"` | `"dsh"` |
| `rename` | `piRenameSession` → `piUpdateSessionHeader`（append `session_info` 条目） | `session/rename` RPC |
| `updateHeader` | `piUpdateSessionHeader`（改写头行 `custom-my-harness-desktop`，加 `withDirLock` 锁） | `session/updateHeader` RPC（只传 pinned/archived/custom） |
| `deleteSessions` | `piDeleteSessionFiles`（按目录分组加锁、真删） | 逐 id `session/delete` RPC |
| `copy` | `copyFileWithDir`（同步，`forkFromSession` 依赖"copy 在 setContext 之前"竞态护栏） | `throw new Error(NOT_WIRED)`（降级抛错） |
| `readToolConfig` | `piReadSessionToolConfig`（读头行 custom.toolConfig） | 返回 `null`（dsh 无 tool-gate，显式缺面） |
| `readCustom` | `piReadSessionCustom`（8KB 头行窗口） | `session/get` RPC → `detail.info.custom` |
| `contextProbeTokens` | `piReadContextProbeTokens`（读 `desktop-context-probe.json` 侧车） | 返回 `null`（context usage 由原生暴露） |
| `newSessionId` | `piDerivedSessionPath(agentDir, cwd, randomUUID())`（预生成路径） | 返回 `null`（惰性创建） |
| `projectionPath` | `piDerivedSessionPath(agentDir, cwd, lineageId)`（投影线索） | 返回 `lineageId`（SessionId 就是 lineageId） |
| `rawFilePath` | 投影文件存在才返回路径，否则 null | `<sessionRoot>/<cwd 桶>/<lineageId>/session.jsonl.zstd` 存在才返回 |
| `projectStats` | `piGetProjectStats`（mtime+size 增量缓存聚合） | `session/projectStats` RPC |
| `getTree` | `piReadSessionTree` | `session/getTree` RPC |
| `bookmark` | 只存 `{lineageId, entryId}` 坐标 | 只存 `{lineageId, entryId}` 坐标 |
| `deleteBookmark` | no-op | no-op |

关键差异：pi 的目录是**纯文件读**（同步 fs，`pi-catalog.ts` 刻意用 `readFileSync`/`copyFileSync`/`rmSync`，因为"会话文件大、写链路上锁原语需要同步语义"）；dsh 的目录是**懒 spawn 一个 JSON-RPC transport 走 RPC**（`DshSessionCatalog.transport()` 用 `transportPromise ??=` 懒初始化，`createTransport` 由 bootstrap 闭包捕获 dsh spawn 配置），因为"dsh 的会话真相源在 dsh 进程内的 `ctx.sessions` + `sessionPersistence`，壳不读 dsh 日志文件"。

### 2.5 `BackendFactory.seed`：生命周期不对称

`BackendFactory` 除了 `create(opts): BaseBackend`，还有一个可选的 `seed?` 预 seed 方法，它体现两个内核 seed 的**生命周期不对称**：

- pi 的 seed 是**纯文件写**（不依赖进程）→ 必须**先 seed 得路径、再以该路径 spawn**；
- dsh 的 seed 是 `session/seed` RPC（依赖进程）→ 不能预 seed → 返回 `null`，由 `create` 后的 `backend.seed` 在 `start` 之后处理。

在 `assemble.ts` 的 `baseBackendFactory.seed` 闭包里体现：`kernel === "pi"` 时 `piSeedSession(agentDir, cwd, lineage, {...})` 返回路径；否则返回 `null`。`session-store.ts` 的 `switchKernel` 与 `materializeActiveLineage` 两处都按这个不对称分支：`seeded != null` 走"先 seed 得 id、再 `factory.create` + `start`"，否则走"先 `factory.create` + `start`、再 `backend.seed`"。

### 2.6 `KernelModelSource`：模型清单合流的圆心契约

`KernelModelSource` 只有一个方法 `listModels(): ModelInfo[]`。`ModelInfo.kernel` 由"从哪个内核的配置扫出来"赋值（pi=`PiModelSource` 扫 `models.json`；dsh=`DshConfigSource` 扫 `settings.yaml`），**不进任何配置文件、不由 provider 名反推**。`ModelCatalog`（`application/models/model-catalog.ts`）持 `KernelModelSource[]`，`listModels()` 就是 `sources.flatMap(s => s.listModels())`——加第三个内核 = 加一个 source，`ModelCatalog` 一行不改。

### 2.7 `BackendCreateOptions`：构造与执行分离的契约载体

`BackendCreateOptions` 只收"壳必须向每一个内核索要"的中性字段：`cwd`、`agentDir`、`kernel`（路由依据）、`provider?`/`model?`（`setModel` 中性输入；pi 走 setModel 命令、dsh 走 initialize 握手）、`neutralSessionId`（中立会话主键，内核私有 id 由各内核 adapter 派生）、`systemPromptPaths?`/`systemPromptTexts?`（pi 翻译成 `--append-system-prompt`，dsh 忽略）、`ephemeral?`（pi=`--no-session`，dsh=临时 `DSH_SESSION_ROOT`）、`maxTokens?`（dsh initialize 握手用，pi 忽略）。**不含任何内核专属 spawn 参数**（`cliPath`/`cordisConfig`/`env`/`apiKey`）——那些由 `kernel-factories.ts` 的工厂入参 `PiFactoryOptions`/`DshFactoryOptions` 扩展、由 bootstrap 闭包捕获（§1.1 判别气味四）。

## 3 pi 内核深挖

### 3.1 协议：JSONL 31+ 命令（`RpcCommand` 联合）

pi 的线协议是 **JSONL**：命令一行一个 JSON 对象写进 stdin，响应/事件从 stdout 读回。命令枚举在 `protocol/rpc-types.ts` 的 `RpcCommand` 联合，实际是 **33 个 `type` 字面量**（最后一个 `reload`）；`versions.ts` 的 `FALLBACK_COMMAND_SET` 回退集收 32 个（不含 `reload`）。"31 命令"是仓库的历史简称（`CURRENT_PROTOCOL_VERSION = "1.0"`，当前不实现 handshake，只声明版本 + 回退集，协议漂移时动 `versions.ts`）。

33 命令按语义分组：

- **消息入口**：`prompt`、`steer`、`follow_up`（三者各带 `images`；`prompt` 多 `streamingBehavior`）。
- **会话生命周期**：`new_session`、`switch_session`、`fork`（`entryId` + `position?`）、`clone`、`get_fork_messages`。
- **状态/快照**：`get_state`、`get_entries`（`since?` 增量拉）、`get_tree`、`get_messages`、`get_last_assistant_text`。
- **模型**：`set_model`、`cycle_model`、`get_available_models`。
- **思考强度**：`set_thinking_level`（`level: "minimal"|"low"|"medium"|"high"`）、`cycle_thinking_level`、`get_available_thinking_levels`。
- **队列模式**：`set_steering_mode`、`set_follow_up_mode`（各 `"all"|"one-at-a-time"`）。
- **维护**：`compact`（`customInstructions?`）、`set_auto_compaction`、`set_auto_retry`、`abort_retry`、`abort`。
- **工具执行**：`bash`（`command` + `excludeFromContext?`）、`abort_bash`。
- **统计/导出**：`get_session_stats`、`export_html`。
- **命名**：`set_session_name`。
- **命令发现**：`get_commands`、`reload`。

命令构造是**纯函数**（`protocol/commands.ts` 的 `build*Command`），与执行分离（§3.2）：构造在 `commands.ts`，执行在 `RpcAdapter.send` → `SubprocessHandle`。`rpc-adapter.ts` 用 `RequestCorrelator`（`correlator.ts`）做 id 配对 + timeout 兜底——`register` 分配递增 id（`req_${++counter}`）并挂 `setTimeout`，`resolve`/`reject` 按 id 配对，进程退出时 `rejectAll` 一次性清空。`handleLine` 的处理顺序：`extension_ui_request` 优先 → `$bus` 上行帧 → `response`（带 id 配对，`success:false` 必须 reject 成 `RpcCommandError` 而非 resolve——根因：此前错误响应当正常值放行，fork 等命令的调用方看不到失败）→ 其余当 event 转发。

**`$bus` 双流路由**（`rpc-adapter.ts` 关键细节）：内核 0.83.0 起 `output-guard`（`takeOverStdout`）把 extension 的 `stdout.write` 重定向到 stderr，`$bus` 上行帧实际落在 stderr——所以 stderr 走两条路：累积调试串 + 行级扫描 `$bus` 帧；stdout 与 stderr 两条流都路由、按 `$bus === true` 识别，一帧只出现在一条流上。

### 3.2 进程生命周期：`SubprocessHandle` + `resolvePiSpawn`

`subprocess-handle.ts` 定义 `SubprocessHandle` 接口（最小集：`stdin`/`stdout`/`alive`/`stop`/`onceExit`/`onceError`/`onStderr`，不暴露 `ChildProcess` 全貌）。`subprocess-lifecycle.ts` 实现：`resolvePiCli()` 优先数据根 `pi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js`，回退全局 `pi`（走 PATH）；`resolvePiSpawn()` 拼 `--mode rpc`；`cliInvocationFromPath()` 由自定义 cli.js 绝对路径拼 spawn（"node 跑、无 shell、cli.js 作首参"这份知识只此一份）。`PiSubprocessHandle.stop` 走"关 stdin→1s→SIGTERM→2s→SIGKILL"策略，`exit` 只发一次（`exitFired` 标志）。

### 3.3 事件翻译：`event-translator.ts` 的 `TYPE_MAP`

`translateEvent(piEvent)` 把 pi 的 `AgentSessionEvent` 投成圆心中性 `SessionEvent`。22 条映射：

| pi 事件 | 中性事件 |
|---|---|
| `agent_start` / `agent_end` / `agent_settled` | `agentStart` / `agentEnd` / `agentSettled` |
| `turn_start` / `turn_end` | `stepStart` / `stepEnd`（单次模型调用） |
| `message_start` / `message_update` / `message_end` | `messageStart` / `messageUpdate` / `messageEnd` |
| `entry_appended` | `entryAppended` |
| `session_start` | `sessionStart` |
| `session_info_changed` | `sessionInfoChanged`（字段名映射 `name`→`sessionName`） |
| `model_select` | `modelSelect` |
| `thinking_level_changed` / `thinking_level_select` | `thinkingLevelChanged` / `thinkingLevelSelect` |
| `tool_execution_start` / `tool_execution_update` / `tool_execution_end` | `toolCallStart` / `toolCallUpdate` / `toolCallEnd` |
| `compaction_start` / `compaction_end` | `compactionStart` / `compactionEnd` |
| `queue_update` | `queueUpdate` |
| `auto_retry_start` / `auto_retry_end` | `autoRetryStart` / `autoRetryEnd` |

三条翻译细节：① 消息载体事件（`messageStart`/`messageUpdate`/`messageEnd`）里做 `withNormalizedToolCalls`（`arguments`→`args` 补别名）+ `withErrorState`（`stopReason:"error"`/`errorMessage` → `error:true` 标记，与文件读路径同规则）；② `session_info_changed` 的内核字段是 `name`、圆心契约是 `sessionName`，字段映射在此完成（此前原样透传 `name` 与 domain 契约漂移，消费方永远读到 undefined）；③ 未识别 type 原样透传（兜底）。

### 3.4 类型绑定：`context-binding.ts`

`toModelInfo`（Model→ModelInfo，kernel 写死 `"pi"`）、`toSessionState`（RpcSessionState→SessionState）、`toMessageEntry`（SessionEntry→MessageEntry）、`toTreeNode`（SessionTreeNode→TreeNode，递归 + `extractTreePreview` 提取 `entryType`/`preview`，注意 pi 条目的载荷字段在**顶层** `message/provider/summary/…`，不包在 content 里——此前按 `content.{role,summary}` 读全部落空）、`toCommandItem`、`toNeutralMessage`、`toSessionStats`（`get_session_stats` 响应 → `SessionStats`，`local` 参数是壳从事件流自算的 tps/turn/lastTurn/turns/steps）。

### 3.5 会话文件存储：JSONL + parentId 树（`pi-catalog.ts`）

pi 的会话是一个 JSONL 文件，路径 = `piDerivedSessionPath(agentDir, cwd, lineageId)` = `${agentDir}/sessions/${cwdToBucketName(cwd)}/${lineageId}.jsonl`。**路径是 lineageId 的确定性函数，文件名恒等于 lineageId**——这是 seed 幂等的根基（同 lineage → 同路径，seed 两次覆盖写同文件）。root lineage 的 lineageId ≡ neutralSessionId，新会话路径也走这里（`randomUUID()` 作 ns）。

每行一个 JSON 对象，类型分三类：

- **头行** `type:"session"`：`{id, timestamp, cwd, "custom-my-harness-desktop": {kernel, pinned, archived, toolConfig, neutralSessionId, ...}}`。这是 desktop 私有域（保留键 `pinned`/`archived`/`toolConfig` 平铺顶层，插件域不得占用）。
- **条目行** `type:"message"`：`{id, parentId?, timestamp, message: {role, content, usage, stopReason, error, startedAt, ...}}`。`parentId` 指向前一条的 id——**parentId 树是分叉的存储载体**。
- **分隔/元数据行**：`model_change`（`provider`+`modelId`）、`thinking_level_change`、`compaction`（`summary`+`tokensBefore`）、`branch_summary`、`session_info`（`name`，重命名真相源）、`label`、`custom`、`custom_message`。

**parentId 树 → lineage 树的投影**（`piReadSessionTree`）：读文件把所有 `id`/`parentId` 连成 `childrenOf` 映射，找根（无 parent 或 parent 不在集合内），`build` 递归成 `TreeNode`，最后 `projectLineageTree(roots.map(build))`——这是 `backend.ts` 的纯函数：沿首子（主干）走到尽头是最大线性链 = 一条 lineage，>1 子节点即分叉点，首子延续当前 lineage、其余子各开一条分支 lineage，`fork.boundary` = 分叉点节点的 `entryId`。

**逐 lineage 独有条目**（`piReadSessionEntries(sessionPath, lineageAnchorId)`）：从锚点（根 lineage 用 rootId、分支用分叉点 child 的 entryId）沿 `parentId` **首子**走到底，返回该链的 `NeutralMessage[]`。增量语义：分支返回分叉点之后的独有条目，根返回完整链。

**名字/预览/叶子派生**：`extractSessionInfoName`（只认 `session_info` 条目，最后一条为准）、`lastEntryId`（倒序找第一个非 session 的 id）、`lastEntryTime`、`lastMessagePreview`（倒序找第一条有文本的消息，前 30 字）。

**读会话全文**（`piReadSession`）：单次遍历同时聚合统计基线（`userMessages`/`assistantMessages`/`toolCalls`/`toolResults`/tokens/cost/`ctxSeq`）与 messages（`sessionEntryToNeutral` 逐条），零额外 IO；`modelEvidence` 从 `model_change` 或 assistant 消息的 `provider`+`model` 提取。`sessionEntryToNeutral`（`events/session-state.ts`）把条目映射成三层：内容层（`message`/`custom_message` display=true 原样进）、分隔层（`model_change`/`thinking_level_change`/`compaction`/`branch_summary`/`session_info`/`label` 映射成 `role:"divider"` 的居中分隔线，content 留空、文案由渲染层按 `i18nKey`+`i18nArgs` 查 i18n）、隐藏层（`custom`/`label`/display=false 返回 null）。

**改/删/复制**：`piUpdateSessionHeader`（头行 `custom-my-harness-desktop` 改写，`withDirLock` 锁目录；name 单轨 append `session_info` 条目；头行超 8KB 预算时 `custom` 读取链静默失效，仅 warn）；`piDeleteSessionFiles`（按目录分组加锁、单文件失败不拖垮整批）；`copyFileWithDir`。

### 3.6 seed：`piSeedSession`（纯文件写、幂等）

`pi-backend.ts` 顶层导出的 `piSeedSession(agentDir, cwd, lineage, opts)`：写"单条 lineage 的完整线性内容"——内核是单线执行器，只物化当前活跃那条 lineage，分叉结构在壳。`parentId` 退化成"前一条的 id"（一条直线）。逐条：只保留 `user`/`assistant`/`toolResult` 角色，`piId = entry.kernelEntryId ?? randomUUID()`，`message` 搬 `role`/`content`/`toolName`/`toolCallId` + 语义字段（`usage`/`stopReason`/`error`/`startedAt`）原样搬、身份字段 `id` 换成新内核 id；`if (prevId) e.parentId = prevId`。返回派生路径。单独导出供 `switchKernel` 在 spawn 之前调用（生命周期不对称）。

### 3.7 catalog：`PiSessionCatalog`

见 §2.4 表。重点：`newSessionId` 预生成路径（文件名即新 ns），`projectionPath` = 派生路径（投影线索，不承诺磁盘存在），`rawFilePath` 投影文件存在才返回（迁移前旧 `<timestamp>_<id>.jsonl` 命名的文件投影路径不存在 → null，调用方显式降级）。

### 3.8 扩展安装器：TS 扩展同步进进程

pi 内核插件是**装进进程的 TypeScript 扩展**，统一为 `my-harness-fit-pi-extension`（内含 toolgate / context-probe / bus / subagent / skills 五能力）。两条安装通道：

- **统一适配**（`my-harness-fit-pi-extension-installer.ts`）：把 `packages/my-harness-fit-pi-extension/` 的 `index.ts`+`runtime.ts`+五能力模块+`tools/*.ts` 按内容 diff 同步到 `~/.pi/agent/extensions/my-harness-fit-pi-extension/`，`skills/` 镜像到 `~/.pi/agent/skills/bus-extension/<name>/SKILL.md`。**pi 的 loader 只在 spawn 时扫一次 extensions 目录**，已跑着的进程不热更，所以本 installer 只负责"启动时同步一次"，版本升级有时差（重启 desktop 才生效）。
- **插件私货**（`pi-extension-installer.ts`）：插件 manifest 声明 `piExtension` 相对路径，activate 时同步到 `~/.pi/agent/extensions/<pluginId>/`，deactivate/uninstall 摘除。marker 纪律：同步目录写 `.my-harness-desktop-plugin`，摘除/对账只碰带 marker 的目录，不覆盖用户手装同名目录。

## 4 dsh 内核深挖

### 4.1 协议：JSON-RPC 2.0 行传输（`json-rpc.ts`）

dsh 的线协议是 **JSON-RPC 2.0**（newline-delimited）：`request` 带 `id` 配对（`{jsonrpc, id, method, params}`），`notification` 无 id（服务端推 `session.event`），`response` 带 `id` 回配对（`result`/`error`）。`JsonRpcTransport` 消费 `SubprocessHandle`（stdin/stdout），`request` 写 stdin + `pending` Map 挂 timeout，`handleLine` 按"有 id 且无 method = response → 配对；有 method = notification → 分发监听器"分派。错误响应 reject 成 `DshRpcError(code, method)`。

`dsh-methods.ts` 是**方法名单源**（`DSH_METHODS` 常量枚举）：`initialize`、`llm/retry`（`llmRetry`）、`session/abort`、`session/bookmark`、`session/continue`、`session/delete`、`session/deleteBookmark`、`session/fork`、`session/get`、`session/getEntries`、`session/getTree`、`session/list`、`session/projectStats`、`session/prompt`、`session/rename`、`session/resume`、`session/seed`、`session/setModel`、`session/title`、`session/updateHeader`——此前散落在各文件的 `"session/*"` 魔法字符串收敛为单源常量，加一个方法改一处、拼错编译期现形。

### 4.2 cordis 插件树（`dsh-config-source.ts`）

dsh 内核是 **Cordis 插件树**——`cordis.yml` 声明插件组成 + 出厂 base，`~/.dsh/settings.yaml` 是用户覆盖层（namespace 分节；解析链 = schema 默认 → cordis base → 用户分节）。模型/默认模型/配置的"用户可编辑面"在 settings.yaml；cordis.yml 是 base（读作兜底）。

`DEFAULT_CORDIS_YAML`（首次运行写入的默认组合）含 `sdk-jsonrpc-server`（stdio JSON-RPC 服务条目，缺了它 agent 没有对外通道）、`agent-core`（`dsh-agent-spine-demo`）、`llm-deepseek`、`settings-file`、`llm-pi-ai`、`sessions`（`dsh-session-persistence-jsonl`，`root: !!js process.env.DSH_SESSION_ROOT ?? './.sessions'`）、`session-checkpoints`、`subprocess`、`bash`、`fs-local`。`!!js` 自定义 YAML tag 只在 cordis.yml base 出现（读=不求值存 `__js` 表达式、写=原样 stringify round-trip 不丢），settings.yaml 是纯字面量。

`PLUGIN_ID_MAP` 把 cordis 包名映射成逻辑 id（24 个标准插件的已知集，如 `@deepseek-ai/dsh-llm-deepseek`→`llm-deepseek`、`@deepseek-ai/dsh-session-persistence-jsonl`→`sessions`）；未知包回落"剥 `@deepseek-ai/dsh-` 前缀"。

插件操作：`disablePlugin`（移出块到 `cordis.yml.disabled.json` 可还原）、`enablePlugin`（还原块）、`addPlugin`（追加 `- id: <id>\n  name: <pkg>` 块，幂等 + id 冲突防护——同 id 被别的包占用会生成 duplicate loader entry id、dsh 启动即崩，拒绝写盘）、`addPluginBlock`/`removePluginBlock`（相对路径插件挂摘）、`listAvailablePlugins`（列 node_modules 里的 `@deepseek-ai/dsh-*` 真插件，排除传递依赖里的抽象服务基类如裸 `dsh-subprocess`/`dsh-subagent`）。

`ensureAgentCoreSkillForkBase()`：把 agent-core 自带的 skill-filesystem"中立化"（改名 `filesystem-builtin` + 清空发现根），让统一适配插件的 fork provider 独占 `filesystem` 名——duplicate provider 会让 dsh 启动即崩，所以这是启动期必须保证的内核形状。

### 4.3 settings.yaml 与模型路由

`DshConfigSource`（`implements KernelModelSource, DshConfigApi`）读写两处：`cordisPath`（cordis.yml）+ `settingsPath`（settings.yaml）+ `installDir`（列可用插件）。模型路由两条：`llm-deepseek` → 单路由 `deepseek-official`（`apiKeyEnv` 缺省 `DEEPSEEK_API_KEY`）；`llm-pi-ai` → `providers` 字典（用户按 route 覆盖 base）。`listProviders()` 合并 settings.yaml 覆盖 + cordis.yml base 兜底；`listModels()` 合流成 `ModelInfo[]`（`kernel:"dsh"`）。`assertPiAiRouteServiceable` 只拦"空 models"这一确定性毒源（空路由让 dsh 运行时拒绝整个 llm-pi-ai 段，连带其它合法路由一起失效）。`getDefaultModel`/`setDefaultModel` 管 `agent-default-model` 命名空间（含 `reasoningEffort`）。

### 4.4 session forest + append-only log（`dsh-catalog.ts`）

dsh 的会话真相源在 dsh 进程内（`ctx.sessions` + `sessionPersistence`），落盘形状是 `<DSH_SESSION_ROOT>/<cwd 桶>/<lineageId>/session.jsonl.zstd`（append-only 日志，zstd 压缩）。fork 是 `ctx.sessions.fork`（自带前缀拷贝），会话树是 **session forest**（父会话 + 子会话）。`DshSessionCatalog.rawFilePath` 解析真实落盘路径（根未注入或文件不存在 → null，显式降级）；`projectionPath` 返回裸 `lineageId`（坐标系，不是文件路径）；`newSessionId` 返回 `null`（惰性创建——服务端首次 prompt 时建会话）。

### 4.5 事件翻译：`dsh-event-translator.ts`（无状态映射 + 流式组装）

dsh 事件的外壳是 `{ type, seq, time, data, surfaceOp? }`，真正 payload 统一在 `data` 字段下（读字段必须从 `data` 读，不能从外壳顶层读）。两层翻译：

**无状态映射**（`translateDshEvent`）：

| dsh 事件 | 中性事件 | 备注 |
|---|---|---|
| `turn/start` | `agentStart` | dsh 的 turn ≈ pi 的 agent loop |
| `turn/end` | `agentSettled`（带 `reason`） | 把 turn/end reason 带进中性流，供"继续执行"判断异常停机 |
| `step/start` / `step/end` | `stepStart` / `stepEnd` | step = 一次模型调用 + 其工具执行 ≈ pi 的 turn |
| `user/message` | `messageEnd`（role user） | 只在 `source.kind==="user"` 时翻译，否则丢弃（系统上下文注入的 CLAUDE.md/技能清单不冒充用户气泡） |
| `assistant/message` | `messageEnd`（role assistant + usage） | usage 在 `data.usage`（与 message 平级），不在 `data.message` 里 |
| `assistant/chunk`（finish-error） | `messageEnd`（error） | token 级流式不接，只接 finish-error 显形失败原因 |
| `tool/call` | `toolCallStart` | `arguments` 是 JSON 字符串，`parseArgs` 解析成对象 |
| `tool/result` | `toolCallEnd` | `data.message.content[0]` 是 ToolResultBlock |
| `compaction/start` / `compaction/end` | `compactionStart` / `compactionEnd` | compaction-basic 插件 |
| `llm/retry` | `autoRetryStart` | llm-retry 插件，对齐 pi 的 auto_retry_start 字段 |
| `session/title` | `sessionInfoChanged`（sessionName） | session-title 插件，latest-wins |

`mapDshUsage`（`inputTokens`/`outputTokens`/`cacheReadTokens`/`cacheWriteTokens`→中性 usage 形状，cost 置 0、totalTokens=四项和）；`normalizeContent`（`tool-call`→`toolCall` 补 args、`tool-result`→`toolResult`、`reasoning`→`thinking`——不归一 `thinkingBlocksOf` 过滤 type==="thinking" 落空，整段思考链静默消失）。

**流式组装**（`createDshEventTranslator`）：每 `(turn, step)` 一个缓冲 `DshStreamBuffer`（key=`${turn}:${step}`），把 `assistant/chunk` 的 `text-delta`/`reasoning-delta` 与顶层批式 `reasoning-chunks`/`text-chunks`（`data.texts` 增量数组，多数 token 走这条）组装成 `messageStart`（首增量发 Start、后续发 Update）。时间戳只锚在 `messageStart`（首增量的事件时间=回合开始，`anchorTs`），`messageUpdate` 不带 timestamp——否则 `startedAt` 被每次更新持续前移、思考计时反复归零。`block-end` 校正缓冲（只补不缩）；`finish` 成功时**不清**缓冲（`assistant/message` 随后到达要读 `anchorTs` 落 `startedAt` 持久化思考时长），error 时清缓冲防泄漏；`assistant/message` 终态清缓冲 + `withNeutralEntry` 补 `entryAppended`（pi/dsh 经同一条路收敛进中立层）。`turn/end reason=error` 补带 error 的 `messageEnd`（此前只发 agentSettled，错误消息被吞——"消息发出、无回复、无报错"的根因）。

### 4.6 seed：`buildDshSeedSession`（转录回树）

dsh 运行时 `session/seed` 要的是 `NeutralSessionWire` 树（mirrors desktop 的 `NeutralSession`），不是线性数组。`buildDshSeedSession(lineage, opts)` 把壳的 forkless 线性 `NeutralEntry[]` 重新包回"单 lineage 树"（root lineage，`fork:null`），剥离 `display`（展示元数据永不进内核投影）。`DshBackend.seed` 发 `session/seed` RPC（`sessionId: opts.lineageId` 当 SessionId），**关键：重绑 `this.currentSessionId = res.sessionId`**——不重绑则首切 pi→dsh 后所有消息发到构造时的桶名会话。

### 4.7 懒能力探测（`dsh-capability-gate`）

装上的 dsh 版本可能缺某些 `session/*` 方法。`DshBackend` 做懒探测：`requestSession` 已知缺面直接抛清晰错误；未知则调用，首次捕获 "unknown DeepSeek Harness SDK runtime method" 前缀记进 `missingMethods` 并转成清晰错误（"dsh 内核版本过旧,缺少 X 方法"）。`recordMissing` 广播 `onMissing`，壳据此 `capabilityDegraded` 事件显式降级入口，不裸炸、不静默吞。`setSessionName`/`setModel` 是特殊处理：unknown method 记缺面 + no-op（命名/切模型是可选/握手态，不因缺面打断发送），"unknown session" 是会话未惰性创建纯冗余照旧 no-op。

### 4.8 扩展安装器 + 提问桥

dsh 内核插件是 Cordis 插件，两条挂载路径（`dsh-extension-installer.ts`）：随插件携带（`syncPluginDshExtension`，id=插件 id、块 id=`my-harness-desktop-<id>`，随插件启停）+ 统一适配（`syncFitDshExtension`，块 id=`my-harness-fit-dsh-extension`，bootstrap 常驻，合并原 ask/goal/read-claude-md/skill-manager 四个插件为一块）。同步目录写 marker，cordis.yml 块用固定 id 幂等挂摘（`addPluginBlock`/`removePluginBlock`）。

`dsh-question-bridge.ts` 是文件侧车桥：dsh ask 扩展写问句到 `~/.pi/agent/.my-harness-desktop-questions/<requestId>.json`，本模块 `fs.watch` 监听目录（事件驱动，不轮询）→ 投中性提问 → `answer` 写 `<requestId>.answer.json`。全局单例（非 per-session），经 `sessionStore.injectQuestion` 与 pi 的 `onQuestion` 汇聚到同一批监听器。

## 5 两内核差异逐项对比

### 5.1 总表

| 维度 | pi | dsh |
|---|---|---|
| **传输协议** | JSONL 33 命令闭联合（`RpcCommand`），`prompt`/`set_model`/`fork`… | JSON-RPC 2.0 行传输（`DSH_METHODS` 20 方法） |
| **命令/方法构造** | `commands.ts` `build*Command` 纯函数 | `dsh-methods.ts` 常量枚举（无构造器，直接 `request(method, params)`） |
| **id 配对** | `RequestCorrelator`（`correlator.ts`，递增 `req_N`） | `JsonRpcTransport` 内联 `pending` Map（递增 `1..N`） |
| **事件形状** | `AgentSessionEvent` 平铺 `{type, message, ...}` | `{type, seq, time, data}` 外壳，payload 在 `data` 下 |
| **事件翻译** | `translateEvent` 单函数 22 条 type 映射 | `translateDshEvent`（无状态）+ `createDshEventTranslator`（流式组装） |
| **回合粒度** | `agent_start`（回合）、`turn_start`（单次模型调用） | `turn/start`（≈pi 回合）、`step/start`（≈pi turn） |
| **流式载体** | `message_update` 事件（内核推） | `assistant/chunk` text-delta + `text-chunks` 批式增量（壳自组装） |
| **会话存储** | JSONL 文件 + parentId 树，路径=派生函数 | append-only `session.jsonl.zstd` + session forest |
| **会话标识** | JSONL 文件路径（`piDerivedSessionPath`） | 不透明 session id（缺省桶名，seed 后重绑） |
| **新会话 id** | 预生成（`newSessionId` 返回路径） | 惰性创建（`newSessionId` 返回 null） |
| **目录/CRUD** | 纯文件读（同步 fs） | 懒 spawn JSON-RPC transport 走 RPC |
| **fork** | 内核 `fork` RPC（`forkCommand`）+ 文件复制 `clone` | `ctx.sessions.fork`（自带前缀拷贝，`session/fork`） |
| **seed** | 纯文件写（`piSeedSession`，spawn 前） | `session/seed` RPC（`buildDshSeedSession` 树，spawn 后） |
| **切模型时机** | `set_model` 时定（start 不定） | `initialize` 握手定（运行时切模缺面 no-op） |
| **思考强度** | `set_thinking_level` 运行时切换 | reasoningEffort 只在 initialize/settings.yaml，运行时切抛错 |
| **中断** | `abort` + `abort_bash` 双保险 | `session/abort`（懒探测） |
| **续跑** | 适配器翻译 `followUp("继续…")` | `session/continue` RPC（语义分发） |
| **提问** | `extension_ui_response` 帧（stdin 写回） | 文件侧车（`writeDshAnswer` + fs.watch 桥） |
| **工具发现** | `readKnownTools`（tool-gate 播报） | 缺面（null） |
| **统计** | `get_session_stats` RPC（基座口径）+ 壳自算 | 无基座 RPC，壳自算 `shellSessionStats`（tokens 等留空） |
| **模型配置** | `models.json`（provider 树）+ `settings.json`（深合并） | `settings.yaml`（用户覆盖）+ `cordis.yml`（base）+ prefs 密钥 |
| **内核插件** | TS 扩展装进进程（`~/.pi/agent/extensions/`） | Cordis 插件树（cordis.yml 块） |
| **版本管理** | `PI_SPEC`（`@earendil-works/pi-coding-agent`）+ postInstall 打补丁 | `DSH_SPEC`（`@deepseek-ai/dsh-sdk-jsonrpc-demo`，distTag `next`）+ extraPackages 同版本 |
| **logo** | 六边形几何标 | DeepSeek 鲸鱼 mark |

### 5.2 最关键的四处行为级差异

**（1）定模型时机不对称**（§2.2 意图三）：这是"切模型"在两个内核上语义根本不同的根因。pi 支持运行时 `set_model`；dsh 的模型在 `initialize` 握手定死，`session/setModel` 在旧运行时是坏面（报 "cannot get property sessions without inject"）。`session-store.setModel` 因此有两套"已生效"判据：pi 走 `latestSnapshot.state.model` 比对，dsh 走 `proc.model`（起进程模型）比对——dsh 无快照面恒 null，旧判据恒"未生效"每次发送都重发 `session/setModel` 坏面调用（"dsh 不能发送第二条语句"的根因）。

**（2）seed 生命周期不对称**（§2.5）：pi seed 纯文件写、spawn 前；dsh seed RPC、spawn 后。`switchKernel` 和 `materializeActiveLineage` 都按 `factory.seed` 返回 null 与否分支。

**（3）fork 语义相反**：pi 的 fork 是内核 RPC（`forkCommand`，返回 `RpcResponse` 查 `cancelled`），但新架构下**分叉是壳的纯操作**（`SessionStore.fork` 只切中立树 `upsertNeutralLineage`，内核不 fork、不物化，惰性物化在下次 send 时 `materializeActiveLineage` seed）；dsh 的 fork 是 `ctx.sessions.fork` 自带前缀拷贝。两者在壳的 forkless 投影下都退化成"壳切中立树 + seed 投影"。

**（4）事件回合粒度命名相反**：pi 的 `turn_start/turn_end` 是**单次模型调用**（= 中性 `stepStart/stepEnd`），pi 的 `agent_start/agent_settled` 是**回合**；dsh 反过来，`turn/start/turn/end` 是**粗粒度一整轮**（≈pi 的 agent loop，= 中性 `agentStart/agentSettled`），`step/start/step/end` 是**单次模型调用**（≈pi 的 turn，= 中性 `stepStart/stepEnd`）。翻译器在两边各自把语义对齐成同一套中性事件。

## 6 能力拉平三分法落地实例

壳看到 pi 和 dsh 的差异，三条出路按优先级：**适配器翻译 → 内核插件补面 → 显式降级**。判断只问一句：内核有没有"同一个语义、只是形状不同"的对应物。

### 6.1 适配器翻译（契约层 + 形状层）

**契约层硬性拉平**（发消息/中断/切模型/命名/seed 都是两边现成、形状不同的接口面，各交一个实现即拉平）：`sendMessage` pi=`prompt` 命令 vs dsh=`session/prompt` RPC；`abort` pi=`abort` 命令 vs dsh=`session/abort` RPC；`setSessionName` pi=`set_session_name` vs dsh=`session/rename`。

**形状翻译（三态事件 ↔ 增量）**：pi 的 `message_start/message_update/message_end` 三态事件，dsh 的 `assistant/chunk` text-delta/reasoning-delta + 批式 `text-chunks` 增量——两边都投成中性 `messageStart/messageUpdate/messageEnd`。dsh 侧 token 级流式由 `createDshEventTranslator` 自组装（`DshStreamBuffer` 按 `(turn,step)` 缓冲），`finish-error` 已接 `messageEnd`。

**lineage 投影（parentId 树 ↔ session forest）**：pi 的 `piReadSessionTree`（parentId 连树 + `projectLineageTree`）与 dsh 的 `session/getTree` RPC，都返回同一 `LineageTree`。壳只认 `LineageTree`，不读任何一方的存储格式。

**seed 转录（线性 ↔ 树）**：壳的 forkless seed 契约给单条 lineage 线性内容 `NeutralEntry[]`，pi 投 JSONL（`piSeedSession`），dsh 投 `session/seed` 树（`buildDshSeedSession`）——两边吃同一份中立输入，各投各的内核形态。

**续跑翻译**：pi 无语义化 continue，适配器翻译成 `followUp("继续未完成的工作…")`；dsh 走 `session/continue` RPC。

### 6.2 内核插件补面

形状翻译不了的能力缺失，给缺能力的内核写内核插件。

- **pi 侧** = 装进进程的 TS 扩展，统一为 `my-harness-fit-pi-extension`（toolgate / context-probe / bus / subagent / skills 五能力）。toolgate 播报 `desktop-known-tools.json` 供 `listTools` 读；context-probe 写 `desktop-context-probe.json` 侧车供 `contextProbeTokens` 读。
- **dsh 侧** = Cordis 插件（`DshConfigSource.addPlugin` 写 cordis.yml）。最小成本是启用现成插件（`dsh-subagent`、`dsh-compaction-basic`）。实例：`assemble.ts` 里 `dshConfigSource.addPlugin("@deepseek-ai/dsh-tool-skill")` 启用 dsh 技能消费方；`my-harness-fit-dsh-extension` 运行时把 `session/meta` 补进 dsh 源码漏收的 `KNOWN_SESSION_EVENT_TYPES`（桌面适配插件补面，不改 dsh 源码）。

### 6.3 显式降级

写了/启用了插件还拉不平的，壳把该能力入口隐藏/置灰 + tooltip，不静默、不伪造成功。

- **pi 专属扩展面在 dsh 下**：`steer`/`followUp`/`cycleModel`/`getThinkingLevels`/`compact`/`setAutoCompaction`/`setAutoRetry`/`exportHtml`/`bash`/`clone` 等（`PiBackendExtensions`）在 dsh 下经 `asPi` 抛错降级——`SessionStore.asPi(proc)` 探测 `proc.backend.capabilities.pi`，无则抛"当前后端不支持 pi 专属命令"。renderer 据 `SessionCapabilities.piExtension` 置灰入口。
- **思考强度**：`setThinkingLevel` 已进契约（dsh 继承缺面默认抛错），档位清单/循环切换（`getThinkingLevels`/`cycleThinkingLevel`）仍留 pi 扩展面。
- **工具发现**：dsh `listTools` 缺面默认 null，壳走降级。
- **copy 复制**：dsh `DshSessionCatalog.copy` 抛 `NOT_WIRED` 降级。
- **contextProbeTokens**：dsh 返回 null（context usage 由原生暴露，不经此探针）。
- **懒探测缺面**：dsh 的 `session/setModel`/`session/rename`/`session/continue` 等 unknown method 时记缺面 + 清晰错误/降级，`capabilities.dsh.missing`/`onMissing` 驱动 UI 置灰对应入口。

## 7 进程模型与内核切换

### 7.1 进程模型：每会话一进程、多会话多进程、每内核一槽位

`session-store.ts` 的进程模型（用户拍板）：会话是文件，进程是按需的临时工。

- **看会话 = 读文件**（`list`/`openSession` 读中立层 `NeutralSessionStore`，不启内核）。
- **发消息 = 按需起进程**：`prompt` → `ensureForSend` 保证目标内核进程在跑，不杀其他会话的进程（多会话并存）。
- **切会话 = `setContext` 设激活**：激活会话进程活着则 `sync` 推基线，没活则清基线等 prompt 时起。

数据结构：`procs: Map<key, Map<KernelId, SessionProc>>`——**key 是会话路径（历史会话）或 `new:${cwd}`（新会话），内层 Map 按内核分槽位**。所以一个会话 pi/dsh 进程槽位并存，`activeKernel` 只决定"哪个槽位参与会话流"，不是"替换另一个槽位"。

`SessionProc` 是关键条目：`backend`（`BaseBackend`）、`kernel`、`neutralSessionId`、`cwd`、`key`、`boundSessionPath`、`activeLineageId`、`materializedLineageId`、`model`（起进程时绑定的 provider/modelId）、`configSnapshot`（spawn 时记录的配置文件 mtime）、`lastModelRef`（跨切换模型中立化载体）、`touched`（是否发过消息，多会话并存保护）、`turn`/`lastTurn`/`turns`/`steps`/`lastTps`（壳从事件流自算的统计）。

### 7.2 进程复用判据：`ensureForSend`

`ensureForSend(kernel, provider, model)` 的复用判据：该内核进程已活 + 配置未过期（`isConfigStale` 比对 `configDepPaths` 的 mtime）+ 模型未失配。模型失配处理分内核：pi 支持运行时切模（`setModel` 差量执行，不重启）；**dsh 的模型在 initialize 握手定死——失配必须停旧起新**，否则用户选的模型被旧进程的握手模型截胡。新会话时：文件型内核（pi）预生成路径（`--session <path>`）；惰性内核（dsh）壳派生投影地址（新 ns 即投影地址）。

### 7.3 内核切换：`switchKernel` 七步

`switchKernel(target)`（`session-store.ts`）——当前入口 gate 是 `switchKernelEnabled = false`（暂缓切换，七步编排原样保留）：

1. **abort + 落定**：`proc.backend.abort()` + `waitSettled(proc, ABORT_TIMEOUT_MS)`（事件驱动等在飞回合收尾：订阅 `agentSettled`/带 stopped·error 的 `messageEnd`/`compactionEnd`/`autoRetryEnd(success!==true)`，超时兜底，不 sleep 不轮询）。
2. **读中立层**（唯一真相源）：`readNeutral(proc) ?? snapshotNeutralSession(proc)`（常规路径不读内核树，快照只是损坏兜底）；`lineageContent(session, activeLineageId)` 取活跃 lineage 的完整线性内容。
3. **stop 旧内核**：`proc.backend.stop()`，之后并发护栏校验 `activeProcKey` 未变。
4. **seed 活跃 lineage**：`factory.seed(lineage, seedOpts)`——pi 返回派生路径（先 seed 得 id 再 spawn），dsh 返回 null（先 start 再 `backend.seed`）。
5. **模型中立化**：读 `proc.lastModelRef`（跨切换载体，不读 `latestSnapshot`——dsh 下恒 null），`modelCatalog.resolveModel(target, ref)` 解析到目标内核的 provider/model，`newBackend.setModel`。
6. **重绑**：`proc.backend = newBackend; proc.kernel = target; proc.boundSessionPath = ...; proc.configSnapshot = captureConfigSnapshot(...); bindProcEvents(proc)`。
7. **周边收尾**：`writeKernelToHeader`（pi 有文件则写头行 custom.kernel）+ `sync` + `dispatchKernel(kernelChanged)` 广播。

### 7.4 惰性物化：`materializeActiveLineage`

fork 后活跃 lineage 与内核物化的 lineage 不一致（`materializedLineageId !== activeLineageId`），`prompt` 发消息前 `materializeActiveLineage(proc)`：`lineageContent` 取活跃 lineage 完整线性内容 → `factory.seed`（pi 文件写 / dsh RPC）→ 换绑 `proc.backend` 到新会话（单线执行器）→ `materializedLineageId = activeLineageId`。幂等：同 lineageId → 同派生 id。

### 7.5 时序图：跨内核切换（pi → dsh）

```
SessionStore.switchKernel("dsh")
   │
   ├─ proc = activeProc()                     // pi 槽位进程
   ├─ abort() → waitSettled()                 // 等在飞回合落定
   ├─ readNeutral(proc) ?? snapshotNeutralSession()
   ├─ lineage = lineageContent(session, activeLineageId)
   ├─ proc.backend.stop()                     // 停 pi
   ├─ seeded = factory.seed(lineage, {kernel:"dsh", ...})
   │     └─ kernel==="dsh" → return null       // 生命周期不对称
   ├─ newBackend = factory.create({kernel:"dsh", ...})
   ├─ newBackend.start()                       // transport.start + initialize 握手
   ├─ newSessionId = newBackend.seed(lineage, seedOpts)  // session/seed RPC, 重绑 sessionId
   ├─ modelCatalog.resolveModel("dsh", proc.lastModelRef) → newBackend.setModel
   ├─ proc.backend = newBackend; proc.kernel = "dsh"; bindProcEvents(proc)
   ├─ writeKernelToHeader(proc)                // 写头行 custom.kernel (pi 文件)
   └─ dispatchKernel({kind:"kernelChanged", kernel:"dsh", ...})
```

## 8 内核版本管理 / 安装 / 冷启动自愈

### 8.1 契约 + 基类 + 实现的三段式

```
packages/shared/src/domain/kernel-manager.ts    KernelSpec（纯数据：pkg/distTag/pkgJsonPath/
                                                  extraPackages/cliWithinPkg/srcCli/srcPkgJson/cliJsLabel）
src/server/kernel/core/kernel-manager.ts        KernelManager（基类：装/查/状态合成，注入 KernelRuntime）
src/server/kernel/pi/manager/pi-kernel.ts       PiKernelManager extends（PI_SPEC + postInstall 打补丁）
src/server/kernel/dsh/manager/dsh-kernel.ts     DshKernelManager extends（DSH_SPEC + installPlugin）
```

三条纪律：① 基类只 import `packages/shared`，绝不 import 具体内核；② 子类只填差异（`PI_SPEC`/`DSH_SPEC` 数据 + `postInstall`/`installPlugin` 行为差异）；③ 组装归 `kernel-managers.ts`（`createPiKernelManager`/`createDshKernelManager` 各一行构造）。

### 8.2 `KernelManager` 基类机制

`currentVersion()`（读 package.json 版本，不 spawn CLI）；`resolveCustomCli(dir)`（自定义目录归一化：形态一源码根 build 后优先、形态二 npm 安装目录）；`status(customCliDir)`（状态合成：customCliDir 空→installed、非空命中→custom、非空未命中→custom 保留意图 + error 标注回落）；`listVersions(forceRefresh)`（fetch registry，per-pkg 10min TTL 缓存）；`install(version, onProgress)`（semver 白名单防 npm spec 注入 → `prepareInstallDir` 清空重装 → 主包 + 附带包同版本 → `postInstall` → 回读校验 `currentVersion` 与 ok 口径一致）；`installNpm`/`uninstallNpm`（`KernelRuntime` 依赖倒置的封装）。

**关键根因**（`install` 注释实证）：① 清 `node_modules` + `package-lock.json` 再装——不清时 npm 对旧树增量更新，dsh 主包 peer deps 跨版本升版后 ERESOLVE 升级永远失败；② 附带包必须与主包同版本——不写 `@version` 会落到该包 latest dist-tag，而 `@deepseek-ai/dsh-*` 的 latest 是陈旧的 0.0.1-rc.x、真实新发版挂在 next → peer deps 冲突 → 安装永远失败；③ 成功判定不能只信 npm exit code，要回读 `currentVersion`（npm 可能 exit 0 却没把包落到预期路径，造成"假安装成功"）。

### 8.3 `KernelRuntime` 依赖倒置

`kernel-runtime.ts` 定义接口（`installNpm`/`uninstallNpm`/`fetchRegistryVersions`），`application` 只依赖接口；实现 `createNpmKernelRuntime()` 在 `client/npm/kernel-runtime`，由 `assemble.ts` 的 `initKernelRuntime(createNpmKernelRuntime())` 注入。`env` 由实现侧用 allowlist（不继承宿主凭证）。

### 8.4 两个内核的 `KernelSpec` + 行为差异

- **`PI_SPEC`**：`pkg: "@earendil-works/pi-coding-agent"`，`cliWithinPkg: ["dist","cli.js"]`，无 extraPackages。`PiKernelManager.postInstall` 打两个补丁：`patchRpcModeForkPosition`（rpc-mode.js fork case 透传 position）+ `patchAgentSessionEntryAppended`（agent-session.js 补 entry_appended 发射）——装/升内核会丢这两个补丁（postinstall 脚本只在仓库 npm install 时跑），须装完重打。
- **`DSH_SPEC`**：`pkg: "@deepseek-ai/dsh-sdk-jsonrpc-demo"`，`distTag: "next"`（latest 陈旧 0.0.1-rc.x 依赖坏），`extraPackages` 10 个插件包（JSON-RPC 运行时是"bin + 插件"组合，须与主包同版本一并装）。`DshKernelManager.postInstall` 无操作；`installPlugin`（npm install 进内核目录，包名白名单 `/^@deepseek-ai\/dsh-[a-z0-9-]+$/` 防注入，钉到已装内核同版本）；`uninstallPlugin`。

### 8.5 冷启动自愈：`kernel-reconcile.ts`

`reconcileMissingKernels(entries, onProgress, onSettled)`：逐个扫 `currentVersion().available`，未装的按 dist-tag 最新版自动补装（`listVersions().latest` → `install`）。串行执行（避免两个 npm install 并发抢 registry/锁），任一失败不抛、记入结果、继续下一个。`assemble.ts` 启动后 fire-and-forget 调用（`[{kernel:"pi", manager: piKernelManager}, {kernel:"dsh", manager: dshKernelManager}]`），进度不进 UI（后台静默），装完 `broadcastRefreshRequested` 让"未安装"只读条消失。"扫描 → 判缺 → 补装/更新"三步是通用形状，后续插件安装/更新扫描可复用（把 entry 换成插件、manager 换成扩展管理器）。只处理"缺失补装"；"有新版可更新"留演进（更新语义需产品决策，不静默升级）。

## 9 模型合流（`KernelModelSource`）

### 9.1 合流机制

`ModelCatalog`（`application/models/model-catalog.ts`）持 `KernelModelSource[]`，`listModels()` = `sources.flatMap(s => s.listModels())`，`resolveModel(kernel, ref)` 按 `classifyModel` 匹配中立模型引用到目标内核的 provider/model。`assemble.ts` 注入两个 source：`new PiModelSource(modelsStore)` + `dshConfigSource`（`DshConfigSource implements KernelModelSource`）。

- **`PiModelSource`**（`pi/model/pi-model-source.ts`）：`ModelsStore`（`models.json` 的 provider 树）→ `ModelInfo[]`（`kernel:"pi"`）。
- **`DshConfigSource.listModels`**：`listProviders()`（合并 settings.yaml 覆盖 + cordis.yml base）→ `ModelInfo[]`（`kernel:"dsh"`）。

### 9.2 `ModelInfo.kernel` 是来源投影，不是配置输入

`ModelInfo.kernel`（`events/session-state.ts`）由"从哪个内核的配置扫出来"赋值，**不进任何配置文件、不由 provider 名反推**（`if (provider.includes("deepseek")) kernel = "dsh"` 是错的）。`toModelInfo`（pi）写死 `"pi"`，`DshConfigSource.listModels` 写死 `"dsh"`。同名模型不跨内核去重（pi/dsh 可能有同 provider+id 的模型，各有各的 `kernel` 标）。

### 9.3 档位分类 + 跨切换模型中立化

`classifyModel`：`reasoning=true`→`reasoning`，id 含 `flash`→`fast`，其余→`pro`（元数据是权威档位，命名约定是无 reasoning 字段时的兜底）。`NeutralModelRef = {ref, effort?}` 是壳的中立模型引用（壳自己的档位，非 pi `thinkingLevel` / dsh `reasoningEffort`）。`SessionProc.lastModelRef` 是跨切换模型中立化的持久载体——`setModel` 成功即更新，`switchKernel` 读它经 `resolveModel` 重投影到目标内核，不读 `latestSnapshot`（dsh 无快照面恒 null），经受得住完整 pi→dsh→pi 往返。

### 9.4 模型域的双写落点

`setModel` 成功后模型域落两层（`session-store.ts`）：① 中立层（全内核，真相源）：`header.kernel + custom.model`——内核归属随模型域原子持久，重开/重启按头读回，不再依赖全局 `activeKernel` 偶然状态；② pi 文件头行（仅 pi 的投影面）：`writeModelPrefsToHeader`，dsh 无文件跳过。`SESSION_MODEL_PREFS_KEY` 域三字段（provider/modelId/thinkingLevel）+ kernel 原子替换。

## 10 会话标识映射（壳 ns ↔ pi 路径 / dsh id）

### 10.1 中立会话主键：`NeutralSessionId`

`session-neutral.ts` 的 `NeutralSessionId.value` 是壳生成、跨内核稳定的 UUID。壳的会话列表/书签/分组都以它为主键。`NeutralAnchor = {lineageId, entryId}` 是中立锚点（`lineageId` 是 `LineageTree` 里的 `lineage.id`，`entryId` 是 `neutralEntryId` 即 `{lineageId}:{seq}`）——替代了旧的 `Anchor.opaque` 私有 token。

### 10.2 映射表：`piDerivedSessionPath` 与 dsh id

| 概念 | pi | dsh |
|---|---|---|
| 中立主键 ns | `NeutralSessionId.value`（UUID） | 同左 |
| 内核私有 id | `piDerivedSessionPath(agentDir, cwd, ns)` = `<bucket>/<ns>.jsonl`（文件名 = ns） | `ns`（SessionId 就是 lineageId，值对象可显式指定） |
| 派生方向 | ns → 文件路径（确定性、幂等） | ns → session id（直等） |
| 反查 ns | `neutralSessionIdFromPath` 靠 `basename(path, ".jsonl")` | ns 即 id |
| `projectionPath` | `piDerivedSessionPath`（投影线索） | 返回 `lineageId` |
| `rawFilePath` | 投影文件存在才返回 | `<sessionRoot>/<bucket>/<lineageId>/session.jsonl.zstd` 存在才返回 |
| `newSessionId` | 预生成路径（文件名 = 新 ns） | 返回 null（惰性） |

### 10.3 幂等不变量

`piDerivedSessionPath` 的注释点明：路径 = lineageId 的确定性函数，**id 部分就是 lineageId，不含时间/随机部分**——那是身份，不是可读性前缀（§24 幂等不变量）。root lineage 的 lineageId ≡ neutralSessionId，新会话路径也走这里（`randomUUID()` 作 ns），文件名恒等于 ns——`neutralSessionIdFromPath` 靠 basename 反查，不再有随机 stamp。

### 10.4 投影地址 vs 原始文件（`rawFilePath` 的降级语义）

`SessionInfo.path` 是**投影地址**（`projectionPath` 派生，坐标系线索，不再做主键），**不承诺磁盘上存在对应文件**。要"打开原始文件"必须走 `rawFilePath`（内核专属知识，由各内核 `SessionCatalog` 解析），壳/插件不拿投影地址硬猜。返回 null（临时会话/迁移前旧文件无投影）时调用方必须显式降级（提示用户），不得静默吞掉。`session-store.rawFilePaths` 返回双地址：`desktop`（中立层会话文件 `<数据根>/sessions/<ns>.json`）+ `kernel`（内核原始文件，投影存在才返回）。

### 10.5 会话列表的唯一源是中立层

`SessionStore.list` 的唯一源是壳自己的中立层（`NeutralSessionStore.listByCwd`），不读内核存储——`neutralToSessionInfo` 把中立会话转成 `SessionInfo`（`neutralSessionId` 是主键、`path` 是投影地址、`id` 是 root lineageId）。`openSession` 读中立层，`lineageContent` 展开根 lineage 的线性内容 + `display.image` 合到 `message.__image`。

## 11 附：关键不变量与易错点速查

- **壳不读任何内核的存储**（pi 的 JSONL、dsh 的 session log 都不碰，只认 `NeutralSessionStore` 的中立层 + 不透明 `sessionId` + `LineageTree`）。会话列表/打开/树读的唯一源是中立层，内核目录降级为兜底（`getTree` 中立层缺失才走 `catalog.getTree`）。
- **壳只认中性事件**（内核事件由适配器投喂，翻译器是喂线、不是第二套语义）。
- **壳的渲染是纯函数**（给定同一条中性事件流，timeline 怎么画与内核无关）。
- **会话意图链路上不出现 `if (kernel === "pi")`**——理想是能力接口（`backend.capabilities.pi`）探测。例外是 `session-store.ts` 里少量 `capabilities.pi` 探测（如 `!proc.backend.capabilities.pi` 判断 dsh），这是能力探测不是身份硬分支。
- **内核 = 模型的派生量**：选模之前不起任何内核进程（`kernel-follows-model`），选模型 = 激活对应内核的槽位。
- **dsh 的 `session/prompt` 只新建空会话、不加载磁盘日志**：app 重启后重开旧会话再发会撞 "id collision"，须先 `session/continue` 把持久化会话载入新进程（`prompt` 里 `neutralHasHistory` 时 `backend.continue?.()`）。
- **pi 的 `session_start`/`model_select`/`thinking_level_select` 是纯扩展事件**（RPC stdout 永不见），`session-store` 在 `setContext`/`prompt`/`sync` 主动推 synthetic `sessionStart` 水合 renderer。

## QA

**Q1：为什么 dsh 的 `setModel` 在运行时切模型是 no-op，壳怎么兜住"用户选了 A 模型却用 B 模型跑"？**

因为 dsh 的模型在 `initialize` 握手时定死（`DshBackend.start` 传 `provider/model/maxTokens`），运行时 `session/setModel` 在旧运行时是坏面。壳的兜法在 `session-store.ensureForSend`：模型失配（`existing.model.provider/modelId !== 目标`）且该内核无 `capabilities.pi`（即 dsh）时，**停旧进程、带新 provider/model 重启**，而不是指望 `setModel` 生效。`setModel` 里的"已生效"判据对 dsh 改走 `proc.model`（起进程模型）而非 `latestSnapshot`（dsh 恒 null）。

**Q2：`BackendFactory.seed` 为什么要分"预 seed"和"start 后 seed"两条路，不能统一吗？**

因为两个内核的 seed 生命周期不对称：pi 的 `piSeedSession` 是纯文件写（不依赖进程，必须**先 seed 得路径、再以该路径 spawn**）；dsh 的 `session/seed` 是 RPC（依赖进程，只能先 start 再 seed）。统一成一条路会迫使 dsh 在 spawn 前写文件（那是"让 dsh 装 pi"的翻译层）或迫使 pi 在 spawn 后写文件（pi 的 spawn 需要 `--session <path>` 参数，路径必须先存在）。`factory.seed` 返回 null 即"本内核不支持预 seed"，调用方走 create→start→backend.seed。

**Q3：pi 的 `parentId` 树和 dsh 的 session forest 是两套完全不同的存储，壳怎么统一看待它们？**

壳**不看**它们——壳只认 `LineageTree`（`rootId` + `lineages[{id, fork:{parentLineageId, boundary}}]`）。pi 侧 `piReadSessionTree` 把 parentId 连成树再 `projectLineageTree` 投影；dsh 侧 `session/getTree` RPC 直接返回 `LineageTree`。两边投成同一形状后，壳的 fork/seed/bookmark 全在 lineage 坐标系操作，与底层是 parentId 还是 session forest 无关。这就是"存储退进内核后端"的落点。

**Q4：为什么 `projectionPath` 和 `rawFilePath` 要拆成两个方法？**

因为投影地址是**坐标系**（pi 的 `piDerivedSessionPath`、dsh 的裸 `lineageId`），不承诺磁盘上存在对应文件；而"打开原始文件"需要的是**真实磁盘路径**（pi 存在才返回、dsh 是 `<sessionRoot>/<bucket>/<lineageId>/session.jsonl.zstd` 存在才返回）。把两者混成一个，会让迁移前的旧文件（`<timestamp>_<id>.jsonl` 命名）投影路径不存在时被误当"文件存在"打开失败，或让调用方拿坐标系去 `fs.readFile`。拆开后 `rawFilePath` 返回 null 时调用方必须显式降级，不静默吞。

**Q5：dsh 的事件翻译为什么要分无状态 `translateDshEvent` 和有状态 `createDshEventTranslator` 两层？**

因为 dsh 的流式是**增量**（`text-delta`/`reasoning-delta` + 批式 `text-chunks`），纯函数 `translateDshEvent` 做不了"把增量累加成完整消息"——它需要跨事件状态（按 `(turn,step)` 缓冲文本/思考、记是否已发 `messageStart`、锚定 `anchorTs`）。所以无状态映射负责生命周期类事件（`turn/start`、`tool/call` 等），有状态翻译器在其上叠加"assistant/chunk 流式组装 + assistant/message 收尾清缓冲"。一个 dsh 事件可能产出 0~N 个中性事件。

**Q6：为什么 dsh 的 `session/prompt` 不能直接续跑历史会话，重启后重开会话会撞 "id collision"？**

dsh 的 `session/prompt` 语义是"新建空会话"（服务端惰性建），不加载磁盘日志；app 重启后新进程内存里没有历史会话，直接 prompt 会与服务端已持久化的同名会话撞 id。壳在 `prompt` 里对"无 pi 运行时切模能力的内核 + 中立层已有历史"先调 `backend.continue?.()`（`session/continue` 走 `getOrResumeSession` 重放日志）再 prompt。旧运行时缺 `session/continue` → 记缺面抛清晰错误，降级为原 prompt 路径（id collision 以其原错误显形，不静默吞）。

**Q7：pi 的 fork 和 dsh 的 fork 在壳里为什么都退化成"壳切中立树 + seed"？**

这是 forkless 架构的核心（`kernel-forkless`）：**内核是单线执行器，只物化当前活跃那条 lineage；分叉是壳在中立层的纯操作。** `SessionStore.fork` 只 `upsertNeutralLineage` 切一条新分支 lineage、设 `activeLineageId`，不调内核 fork、不物化；下次 `prompt` 时 `materializeActiveLineage` 发现 `materializedLineageId !== activeLineageId`，把活跃 lineage 的完整线性内容 `lineageContent` 取出来 seed 投影进内核（pi 写文件/dsh 发 RPC）。这样 pi 的 `forkCommand`（内核 RPC）和 dsh 的 `session/fork`（前缀拷贝）都只是内核各自的实现细节，壳统一走"切树 + seed"。

**Q8：为什么 `setThinkingLevel` 进了中立契约、而 `getThinkingLevels`/`cycleThinkingLevel` 留在 pi 扩展面？**

因为"设置思考强度档位"是壳可能向每个内核索要的意图（`atomic-send` 设计里发送路径要原子地对齐档位），但 pi 有运行时 `set_thinking_level` RPC、dsh 只有 initialize/settings.yaml 定死的 `reasoningEffort`——所以"设置"进契约、dsh 显式降级抛错。而"档位清单 + 循环切换"是 pi 的交互形态专属（dsh 没有档位清单概念），答案答不上"每个内核都能兑现"，于是留在 pi 扩展面，dsh 下入口隐藏/置灰。

**Q9：`AbstractBackend` 的 4 条缺面默认为什么是"抛错"而不是"返回空/静默"？**

因为契约的底线是"不静默吞、不伪造成功"（§1.5）。`listTools` 返回 null 是特例——null 是契约约定的"降级信号"（壳据此隐藏工具入口），不是静默吞；而 `answerQuestion`/`continue`/`setThinkingLevel` 若静默返回空，壳会误以为能力已兑现、继续走后续流程，最终在更深处才炸或更糟的是用户看到"操作成功但没效果"。抛错让缺面在调用点立即显形，壳据此显式降级（置灰入口/提示"当前内核不支持"）。

**Q10：内核版本管理里 dsh 为什么要用 `distTag: "next"`、且附带包必须钉到主包同版本？**

因为 `@deepseek-ai/dsh-*` 的 latest dist-tag 是陈旧的 0.0.1-rc.x（依赖坏），真实发版 0.1.0-rc.7 挂在 next——`DSH_SPEC.distTag: "next"` 让"最新版本"取对 tag。附带包（sdk-jsonrpc-server/agent 核心/DeepSeek 适配器/会话/工具等）若不写 `@version`，npm 会落到它们各自的 latest（同样陈旧），与主包 peer deps 跨 rc 线冲突 → ERESOLVE → 安装永远失败。所以 `KernelManager.install` 里主包 + 附带包统一 `${pkg}@${version}`，同版本对齐后一次装成。
