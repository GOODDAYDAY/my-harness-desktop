# 核心设计

这份文档回答一个问题：my-harness-desktop 到底是一个什么样的系统，为什么它长成现在这个样子。它不是功能清单，也不是文件索引——那是 `directory-structure.md` 的事。它只讲「这套架构的核心决策是什么、为什么这么定、代码里落在哪」。

先给结论：这是一个**多内核 AI agent 桌面壳**。壳（shell）提供机制——插件加载、槽位契约、事件总线、进程隔离、权限沙箱——而内容（配色、文案、管理页、时间线渲染、甚至内核本身）全部外挂。壳托管多个同级内核（现在是 pi 和 dsh），通过一份中立契约（`BaseBackend`）和一层中立会话坐标系（`NeutralSession`）把「这个内核怎么存会话、怎么分叉、怎么流式」全部挡在内核适配器后面。

这个结论的每一个词都有代价，后面逐条展开。

---

## 1 圆心：换壳测试下不动的部分

判断一个东西是不是圆心，用「换壳测试」：明天把 pi 换成 dsh、把 Electron 换成 Tauri、把 React 换成 Vue、把 SQLite 换成 PostgreSQL，这东西还在不在。还在的是圆心，不在的是外层。

圆心物理上落在 `packages/shared/src/domain/`，纪律只有一条——**零依赖**。这个目录里不 import react、不 import electron、不 import better-sqlite3，连 domain 外部的类型都不碰（只 import 内部的 `kernel.ts`、`events/`、`text.ts` 几个零依赖原子）。这不是靠 code review 抓违规，是靠物理隔离：目录里放不下 electron，import 语句写出来就编译不过。

圆心里装的四样东西：

- **纯类型**：`NeutralMessage`、`ModelInfo`、`SessionInfo`、`LineageTree`、各槽位贡献项。全是 TypeScript type/interface，运行时零成本。
- **纯函数**：`neutralEntryId`、`lineageContent`、`sortLineagesTopologically`、`projectLineageTree`、`resolveForkBoundaries`。输入到输出的映射，无副作用，有测试（`*.test.ts` 与源文件同目录）。
- **中立契约**：`BaseBackend`、`SessionCatalog`、`BackendFactory`、`KernelModelSource`、`Host`。这是「壳需要内核/运行时提供什么」的意图集合。
- **槽位契约**：`contributions.ts` 里 27 个槽的形状。这是「壳和壳插件之间的接口定义」。

圆心不装任何 IO、任何环境感知、任何框架、任何内核实现。`kernel.ts` 里只有 `type KernelId = "pi" | "dsh"` 和一个 `KERNEL_IDS` 数组——这是全仓唯一能出现内核身份字面量的地方。加第三个内核，就是在这里加一个字面量，编译器会逼着补全所有 `switch(kernel)` 和 `KERNEL_IDS` 消费处。

### 1.1 为什么圆心要放 packages/shared 而不是 src 里

历史上前端还没和壳分离时，圆心在 `src/core/domain/`。前后端分离（见 §7）之后，前端（`src/web`）、壳后端（`src/server`）、内核扩展（`packages/my-harness-fit-pi-extension`）三方都要消费同一批类型，圆心必须是一个可以被三方 import 的发布面。于是圆心搬到 `packages/shared`，带上 `package.json` 和 `index.ts` 的 re-export 面，成为发布面。

这个移动没有改变圆心的性质——它仍然是零依赖的纯类型+纯函数，只是物理位置从「壳的某个子目录」变成了「一个独立包」。`packages/react` 是另一个发布面，它是 React 组件/hooks/事件总线的 re-export 兜底，供壳插件 import——壳插件只 import `@my-harness-desktop/shared`（类型）和 `@my-harness-desktop/react`（组件/hooks），不 import `src/server` 或 `src/web` 的任何东西。

### 1.2 契约单源：一个概念只有一份定义

`KernelId` 只在 `kernel.ts` 定义一次。`NeutralAnchor` 只在 `session-neutral.ts` 定义一次，`backend.ts` 里 `type Anchor = NeutralAnchor` 是 re-export 兼容旧 import。`BoundaryRef = string` 只在 `backend.ts` 一处。两份定义必然从第一天开始漂移——要一个发布面就 re-export，不要复制。

这条纪律的判别气味是：两个文件里出现同一个概念的两份定义，哪怕一份「精确」、一份「为了兼容」，都是违规。多内核场景最典型的就是 `"pi" | "dsh"` 字面量散落全仓——那是复制了 `KernelId` 的联合。正确的做法是全部 import `KernelId`。

---

## 2 内核抽象：壳只认一份中立契约

壳怎么看待一个内核？答案是：不看它。壳只认 `BaseBackend` 接口，pi 和 dsh 各交一个实现了它的适配器。这就是「内核可替换」的根——换掉任何一个内核、再加一个内核，壳和圆心一行不改。

### 2.1 BaseBackend 的十四个必实现方法 + 四个缺面默认

`backend.ts` 里 `BaseBackend` 的精确形状（这是抽象基类 `src/server/kernel/core/abstract-backend.ts` 落地的骨架）：14 条 abstract + 4 条缺面默认 + 3 个默认成员。注意「分叉」不在契约里——`fork` 是壳的 `SessionTreeApi`，内核降级成单线执行器（见 §4），所以没有 fork 方法。4 条缺面默认是 `listTools`（返回 null）、`answerQuestion`/`continue`/`setThinkingLevel`（抛错）；`resume?` 是接口可选意图（dsh 覆盖、pi 不实现），不在基类。

**进程生命周期**：`alive`（子进程是否存活）、`start()`、`stop()`。内核是一个独立子进程，壳 spawn 它、持有它、kill 它。

**事件流**：`onEvent(cb)` 订阅中性事件流（驱动 timeline），返回取消函数。这是「壳只认中性事件」的入口——内核吐什么格式，适配器翻译成中性事件喂进来。

**会话分支（五个核心操作）**：

- `getTree(sessionId)`：拿一个会话的全部 lineage 及父子/分叉点关系，返回 `LineageTree { rootId, lineages }`。
- `getEntries(lineageId)`：拿一条 lineage 的线性消息序列（重放历史；timeline/git-review/token-stats 消费）。
- `bookmark(lineageId, boundary)`：把一个分叉点持久化成可重启锚点。
- `resume?(anchor)`：从锚点重启一条 lineage（可缺面——dsh 服务端回切，pi 无此面）。
- `deleteBookmark(anchor)`：回收锚点副本。

**消息/模型/中断**：`sendMessage(text, images?)`（唯一会起进程的入口，resolve 只代表内核接受，输出靠事件流）、`abort()`、`setModel(provider, modelId)`、`setThinkingLevel(level)`。

**命名与续跑**：`setSessionName(name)`（第七意图）、`continue?()`（第八意图——异常停机后原地续跑，可缺面）。

**投影**：`seed(lineage, opts)`——把「活跃 lineage 的完整线性内容」物化到内核，返回内核侧会话标识。这是「内核是单线执行器」的落地（见 §4）。

**工具发现与提问**：`listTools?()`（可缺面）、`answerQuestion?(questionId, answers)`（可缺面）。

**能力探测面**：`capabilities: { pi?: unknown; dsh?: DshCapabilities }`——壳经 `backend.capabilities.pi` / `.dsh` 探测「有则用、无则降级」，不按内核身份硬分支。`configDepPaths?: string[]`——内核 spawn 时读取的配置文件路径清单，变了壳重建进程。

`BoundaryRef` 是不透明字符串：pi 后端把它当 entryId，dsh 后端把它当 seq 的字符串化。语义上它总指向「父 lineage 里一个完整回合之后的位置」——两个内核各自的锚点表示，归一成同一个不透明引用。壳不解析它的内容，只当 token 在 fork/bookmark/resume 间回传。这是「适配器翻译」的一个典型例子：同一个语义（分叉点），两种形状（entryId vs seq），在适配器里抹平。

### 2.2 四个并列抽象：内核 / 壳 / 中立契约 / 适配器

边界必须钉死：

- **内核**：自洽的 agent 运行时（插件树 + 会话模型 + 能力集）。不出 UI，不知道也不需要知道自己被托管。
- **壳**：槽位/渲染/布局/事件总线的机制。不读任何内核的存储格式、事件形状、插件树、fork 语义。
- **中立契约**：壳需要内核提供的意图集合（`BaseBackend` + `SessionCatalog` + `KernelModelSource`）。不塞任何内核专属概念——pi 的 `steer`/`onExtensionUI` 不进，思考档位的「设置」进了（`setThinkingLevel`）、「清单/循环切换」留在 pi 扩展面。
- **适配器**：内核专属形状 ↔ 中立契约的翻译，每内核一个。不做「让 dsh 装 pi」的翻译层。

一个内核要接入壳，交三样东西：**spawn 命令**（怎么起、起几个、怎么杀）、**适配器**（把专属形状投成中立契约）、**会话模型映射**（把会话落到 lineage 坐标系）。三样齐了它是「可托管内核」，缺一样它只是「一个能跑的程序」。三样在代码里的落点：spawn 命令在 `src/server/kernel/{pi,dsh}` 的 subprocess-lifecycle + 工厂闭包；适配器在 `pi-backend.ts` / `dsh-backend.ts`；会话模型映射在 `pi-catalog.ts` / `dsh-catalog.ts`。

### 2.3 SessionCatalog：跨会话的目录/CRUD 面

`BaseBackend` 是 per-session 的进程+分支句柄（有 start/stop 生命周期），`SessionCatalog` 是 per-kernel 的跨会话存储（列/开/改/删/复制/统计）。两者正交。

`SessionCatalog` 的方法：`rename`、`updateHeader`、`deleteSessions`、`copy`、`readToolConfig`、`readCustom`、`contextProbeTokens`、`newSessionId`、`projectionPath`、`rawFilePath`、`projectStats`、`getTree`、`bookmark`、`deleteBookmark`。

这里有两个关键方法值得单独说：

- `newSessionId(cwd)`：生成新会话的不透明 id。返回 string = 本内核需预生成会话标识（pi=新会话文件路径，先 seed 得 id 再 spawn）；返回 null = 本内核惰性创建（dsh，服务端首次 prompt 时惰性建会话）。
- `projectionPath(cwd, lineageId)` vs `rawFilePath(cwd, lineageId)`：前者是投影地址（由 lineageId 确定性派生，作 `SessionInfo.path` 的投影线索，**不承诺磁盘上存在对应文件**）；后者是会话原始文件的真实磁盘路径（「打开原始文件」的唯一权威来源，存在才返回）。这条区分的根因是：投影地址是坐标系，不是文件路径，拿它当文件路径打开会打开一个不存在的文件。

壳不读任何内核的存储——这些操作的 pi 答案是 JSONL 文件 + parentId 树，dsh 答案是 append-only log + session forest，都退进各自适配器实现。壳只认中性类型（`SessionInfo`、`HeaderPatch` 等）。

### 2.4 KernelModelSource：加第三个内核 = 加一个 source

`KernelModelSource { listModels(): ModelInfo[] }` 是一个内核的模型清单（已带 kernel 标）。`ModelCatalog`（`src/server/application/models/model-catalog.ts`）持一个 `KernelModelSource[]`，把 pi 的 `PiModelSource` 和 dsh 的 `DshConfigSource` 合流成一份模型清单。加第三个内核 = 加一个 `KernelModelSource` 实现，`ModelCatalog` 一行不改。

模型清单里的 `kernel` 字段不是由 provider 名反推的（`if (provider.includes("deepseek")) kernel = "dsh"` 是错的），而是由「从哪个内核的配置扫出来」赋值的——这是「内核身份不进配置文件」纪律的落地。

---

## 3 中立会话层：壳的主键是它自己的 UUID

这是整个多内核设计里最反直觉、也最关键的一层。直觉上你会觉得「会话存在内核里，壳要列会话就得读内核的存储」。中立层的答案是：**壳有自己的会话真相源，内核存储只是投影**。

### 3.1 三个身份，三种用途

`session-neutral.ts` 定义了三个身份，用途严格分开：

- `neutralSessionId`（壳生成 UUID）：壳的会话列表/书签/分组/置顶/归档的主键。跨内核稳定——同一个会话从 pi 切到 dsh，neutralSessionId 不变。
- `lineageId`：一条 lineage 的身份（根 lineage 的 lineageId 初始 = neutralSessionId，fork 后新分支各有一个新 UUID）。
- `kernelEntryId`：内核私有 entry id（投影时的 opaque 线索，仅 adapter 用，不进中立契约对外面）。pi 是它的 entry id，dsh 是 seq。

`NeutralEntry` 里的 `neutralEntryId` 是 `{lineageId}:{seq}`（seq 是该 entry 在所属 lineage 内的 0-based 序号），由纯函数 `neutralEntryId(lineageId, seq)` 生成。稳定、跨内核不变。

`NeutralAnchor = { lineageId, entryId }` 是完全内核无关的坐标——替代了早期 `Anchor.opaque` 私有 token。书签跨内核 resume 的终态就是经这个中立坐标在目标内核重投影找回。

### 3.2 中立层是唯一真相源

`SessionStore.list()`（`session-store.ts`）的实现只有一行核心：`this.neutralStore?.listByCwd(cwd)`。会话列表的唯一源是壳自己的中立层，不读内核存储。`openSession` 同样读中立层。会话创建即写空中立会话（`emptyNeutralSession`），「开始但未发言」的会话也进中立层——否则 list 会漏掉它。

内核存储退为投影：`rename`/`updateHeader` 时，名字/置顶/归档先写中立层（真相源），再投影回内核存储（`projectHeaderToKernel`，失败不阻断——中立层才是真相源）。这条「投影失败不阻断」是有血泪教训的：早期 pi 投影因派生路径与 pi 实际文件名不匹配而抛「会话文件不存在」，把中立层写整个吞掉，归档/置顶一次就丢名。

### 3.3 纯函数 mutation

中立树的增改全是纯函数（`session-neutral.ts` 后半段）：`appendNeutralEntry`、`appendNeutralEntryWithHeader`、`upsertNeutralLineage`、`backfillKernelEntryId`、`lineageContent`。session-store 的读写模式是「读 → 纯函数 → 写」，不 mutate 持久化对象。

`lineageContent(session, lineageId)` 是最核心的一个：沿 fork 链向上，取父 lineage 到分叉点为止的前缀（boundary 是「含端点的继承前缀」），再拼自身独有条目。这是「分叉归壳」的地基——seed 投影、切分支投影都靠它拼出「一条 lineage 的完整线性内容」。

这些纯函数带防御：父引用悬空当根处理、环用 visited 停不无限递归、损坏数据不抛错中断整次操作。它们在 `*.test.ts` 里有测试覆盖。

---

## 4 内核是单线执行器，分叉归壳

这是 fork 语义上最激进的一刀：**内核不再负责分叉，它只物化当前活跃的那一条 lineage**。分叉是壳在中立层的纯操作。

早期（pi 曾是唯一内核时）分叉是内核能力——pi 的 parentId 树、dsh 的 session forest，各有一套 fork 语义。多内核化之后，这两个语义处处相反，硬拉平的成本极高。于是反向决策：把 fork 从内核拿出来，归壳。内核降级成「单线执行器」——一次只跑一条线性消息流，喂什么 seed 就续什么。

落地的三个关键动作：

- **seed 单线投影**：`BaseBackend.seed(lineage, opts)` 把「活跃 lineage 的完整线性内容」（`lineageContent` 算出来的）物化到内核。内核侧会话标识派生自 lineageId，幂等——`piDerivedSessionPath(agentDir, cwd, ns)` 的 pi 文件名就是 `<bucket>/<ns>.jsonl`，dsh 直接是 ns。
- **fork 归壳**：`SessionTreeApi.fork(parentLineageId, boundary)` 是壳在中立层的纯操作——新开一条 lineage，记下 fork 点。内核不感知 fork，只在下一次 prompt 时收到「这条 lineage 的完整内容」的 seed。
- **活跃 lineage 追踪**：`SessionProc.activeLineageId`（追加新 entry 的目标）与 `materializedLineageId`（内核当前物化的 lineage）不等时，说明活跃 lineage 未物化（fork 后），prompt 先 seed。

这个决策的代价是 seed 的「生命周期不对称」：pi 的 seed 是纯文件写（不依赖进程），必须先 seed 得路径、再以该路径 spawn；dsh 的 seed 是 `session/seed` RPC（依赖进程），不能预 seed——所以 `BackendFactory.seed` 返回 null 表示「本内核不支持预 seed」，调用方走「create → start → backend.seed」。这个不对称写进了 `BackendFactory.seed?` 的契约注释里，是「适配器翻译」的又一个例子：同一个语义（投影一条 lineage），两种时序（spawn 前 vs spawn 后）。

---

## 5 薄壳：槽位契约 + 事件总线 + 插件四件套

壳的功能含量趋近于零。壳只放「拿掉它系统就不能启动、且一年后不会换」的机制：加载器、槽位契约、中立契约、事件总线、权限沙箱、生命周期。内容全部外挂。

### 5.1 槽位契约

壳预定槽位，壳插件往槽位上挂东西。`SlotName` 联合类型列出了 27 个槽：`languages`、`themes`、`sidePanel`、`sidebar`、`mainView`、`titlebar`、`messageRenderers`、`fileActions`、`fileIcons`、`sessionGroupings`、`composerPolicies`、`composerAttachments`、`composerActions`、`composerStats`、`composerTop`、`composerVoice`、`messageActions`、`blockRenderers`、`codeBlockRenderers`、`settings`、`settingsGroups`、`fontPresets`、`systemPrompts`，外加预留的 `management`、`cardRenderers`、`viewers`、`commands`。

每个槽的贡献项形状在 `contributions.ts` 里定义。消费方（如 timeline、sessions-list、文件树）查槽渲染，贡献方（各插件）在 `plugin.json` 的 `contributes.<slot>[]` 里声明。三段式：**domain 契约 → registry 注册 → renderer hook 查询 → 消费方渲染前查表**。双向解耦：消费方不认识贡献方（清单来自内核注册表），贡献方不认识消费方。

### 5.2 事件总线：插件间唯一通信通道

壳插件之间唯一合法的通信是 `ctx.events.emit/on/invoke`，不通过共享 store 互读写。channel 由代码级 `export const channels` 声明，框架加载 module 后自动注册。`emit` 是发布/订阅（可回放），`invoke` 是定向分派（无订阅者时入队）。`dependsOn` 是生命周期护栏，凡消费别人 channel 的插件都声明它。

### 5.3 插件四件套：一个功能一个目录

一个功能收进同一个壳插件目录，内部按需四件：

- `locales/`：i18n 文案
- `renderer/`：desktop 壳插件（UI 组件 + 槽位贡献 + 事件）
- `pi-extension/`：pi 内核插件（给 pi 补能力的 TS 扩展）
- `dsh-extension/`：dsh 内核插件（给 dsh 补能力的 Cordis 插件）

`plugin.json` 里两个字段接通内核侧：`piExtension`（相对路径，activate 时同步到 `~/.pi/agent/extensions/<pluginId>/`）和 `dshExtension`（同步到 dsh cordis 插件目录并挂 cordis.yml 块）。同一个能力在两个内核的对称实现——比如「读用户全局 CLAUDE.md」pi 侧走 piExtension（read-claude-md 内核扩展），dsh 侧走 dshExtension（dsh cordis 插件）。

「非必要不修改薄壳内核」：新写功能去改壳来容纳它是违规——要扩展别人功能走槽位填槽，给内核补能力只写内核插件（pi-extension / dsh-extension），严禁改外部内核仓库的核心。

---

## 6 依赖倒置：接口在内、实现在外、组装在 bootstrap

跨层协作靠依赖倒置。`session-store.ts` 的注释写得很直白：「application 依赖 gateway(type)+ domain，不依赖 shell」「本层不 new RpcAdapter，持 RpcAdapterFactory 接口，实现由 shell 注入」。

六个具体形态：

- **内核后端**：`session-store` 持 `BackendFactory` 接口（圆心契约），`PiBackend`/`DshBackend` implements `BaseBackend`，实现在 `src/server/kernel/{pi,dsh}`，组装在 `bootstrap/assemble.ts`。换内核只换适配器，application 和 domain 一行不改。
- **内核版本管理**：`KernelManager` 基类（`kernel/core/kernel-manager.ts`）管 pi/dsh 共用的「装/查/状态合成」机制，只依赖 `KernelSpec` + `KernelRuntime` 接口。`PiKernelManager`/`DshKernelManager` 填 spec + `postInstall` 差异。
- **RPC 适配**：`RpcAdapter` 不直接 spawn，持 `SubprocessHandle` 接口。
- **内核运行时**：`KernelManager` 不直接 spawn npm，持 `KernelRuntime` 接口（`installNpm` + `fetchRegistryVersions`）。
- **路径注入**：`config-store`、`pi-settings-store` 不直读 `process.cwd()`，路径由 bootstrap 注入。
- **配置读写**：`config-file.ts` 提供 `readJsonFile`/`writeJsonFile`/`withDirLock` 原语，各 store 都调这些原语。

组装根是 `bootstrap/assemble.ts`——它读环境、建依赖、注入 `MainContext`、把接口和实现绑起来。`baseBackendFactory` 的 `create` 闭包里，内核专属 spawn 参数（pi 的 `cliPath`、dsh 的 `cordisConfig`/`apiKeyEnv`/`DSH_SESSION_ROOT`）都在这里捕获，不进契约。这正是「构造在内、执行在外」的落点：内核专属 args 的拼装收进工厂闭包（执行），`BackendCreateOptions` 只收中性字段（构造）。

### 6.1 继承 + 实现的三段式

「接口 + 两个平行实现」会让重复代码（缺面抛错、装/查机制）各写一份。解法是「接口 → 抽象基类 → 具体实现」：

```
backend.ts(圆心)            BaseBackend(接口)
      ▲ implements
abstract-backend.ts(骨架)   AbstractBackend(15 abstract + 4 缺面默认 + 3 默认成员)
      ▲ extends
pi-backend.ts / dsh-backend.ts  PiBackend / DshBackend(override 各自能力)
```

`AbstractBackend` 的 14 条 abstract 对应契约的 14 个必实现；4 条缺面默认（`listTools` 返回 null、`answerQuestion`/`continue`/`setThinkingLevel` 抛错）让 pi/dsh 不必各自写一遍「缺面抛错」。但注意：**基类解决的是实现复用，不产生新能力**；能力拉平靠内核插件（§8.3）。两者正交——别把「抽了基类」当成「拉平了能力」。

同样的三段式用于内核版本管理：`KernelSpec`（纯数据）→ `KernelManager`（基类）→ `PiKernelManager`/`DshKernelManager`。

---

## 7 前后端分离：Host 抽象 + WS/HTTP transport

壳曾经是 Electron-only。现在它是「服务器 + 前端」双端：`bootstrap/electron.ts` 和 `bootstrap/server.ts` 两个入口，各注入一份 `Host`，共用 `assemble.ts` 组装。

`Host` 接口（`domain/host.ts`）是「机制而非内容」——宿主只提供生命周期/窗口/对话框/通知/系统主题等环境能力，不含业务逻辑。Electron 宿主是完整实现（`host/electron-host.ts`），Node 服务器宿主是降级实现（`host/node-host.ts`，窗口/对话框 reject `UNSUPPORTED_HOST`，通知 no-op）。远程连接的 host 是「缺省降级实现」。

transport 层是 HTTP（静态 + `/rpc`）+ WS（`session:event` 等广播），`gateway` 把控制器 handler 注册成 `(conn, ...args)` 签名。前端 `src/web/transport/` 走 WS 传输三原语，renderer 不再有 preload/IPC。这层的变化和圆心无关——圆心还是那批类型，只是渲染端从「同进程 IPC」换成了「跨进程 WS」。

### 7.1 会话流路由：main 进程是真相源

前后端分离后，会话流的真相源单一在壳后端（main）。`session-store` 把中性事件经 `gateway.broadcast("session:event", event)` 推给前端，前端只读 store、零拉取，基线 + 事件增量应用。`setContext` 激活会话时主动推 synthetic `sessionStart`（因为内核的 `session_start` 是纯扩展事件，走 RPC stdout 永远到不了 renderer，早期靠 sessions-list 手动补写 `currentSessionPath` 是隐式契约，第二个忘记补写的入口就出 bug）。

---

## 8 能力拉平三分法：翻译 / 补面 / 降级

壳看到 pi 和 dsh 的差异，三条出路按优先级：

1. **适配器翻译**（契约层 + 形状层）：内核有「同一个语义、只是形状不同」，就在适配器里翻译。发消息/中断/切模型是契约层硬性拉平；三态事件 ↔ `assistant/chunk` 增量、parentId 树 ↔ session forest、entryId ↔ seq 是形状翻译。
2. **内核插件补面**：形状翻译不了的能力缺失，给缺能力的内核写内核插件。pi 侧 = 装进进程的 TS 扩展（`my-harness-fit-pi-extension` 统一了 toolgate/context-probe/bus/subagent/skills 五能力），dsh 侧 = Cordis 插件（`my-harness-fit-dsh-extension`）。
3. **显式降级**：写了/启用了插件还拉不平的，壳把该能力入口隐藏/置灰 + tooltip，不静默、不伪造成功。典型：pi 的 `steer`/`followUp`/`onExtensionUI` 在 dsh 下。

判断该翻译还是补面，只问一句：内核有没有「同一个语义、只是形状不同」的对应物。有 → 翻译；没有 → 补面；补不了 → 降级。不允许的状态只有一种：**静默缺面**——壳调了内核没有的能力，既不翻译也不补面也不降级，静默吞掉或假装成功。

能力探测靠 `capabilities` 而不是内核身份硬分支：壳经 `backend.capabilities.pi`（`PiBackendExtensions`，pi 扩展面形状定义在 src/server/kernel/pi/backend，application 经 type-only import 收窄）和 `backend.capabilities.dsh`（`DshCapabilities`，懒探测缺面方法）探测「有则用、无则降级」。会话意图链路上出现 `if (kernel === "pi")` 或 `asPi()` 类型守卫，就是壳在漏内核身份。

`DshCapabilities` 的懒探测值得一提：装上的 dsh 版本可能缺某些 `session/*` 方法，首次调用失败（unknown method）时记录进 `missing`，之后壳据此显式降级——不静默、不伪造成功。这是「运行时能力探测」而不是「版本号硬编码」的落地。

---

## 9 进程模型：每会话一进程，多会话多进程

进程模型（`session-store.ts` 顶部注释写得清楚）：会话是文件，进程是按需的临时工，**每会话一进程、多会话多进程**。

- 看会话 = 读文件（不启内核）。
- 发消息 = 按需起该会话的内核：`ensureForSend` 保证激活会话的目标内核在跑，不杀其他会话的进程（多会话并存）。
- 切会话：`setContext` 设激活；激活会话活着则 resync 推基线，没活则等 prompt 时起。
- 内核启动/关闭不阻塞展示：进程动作全在发送路径上。

多槽位并存：`procs` 是 `Map<key, Map<KernelId, SessionProc>>`——一个会话的 pi 槽位和 dsh 槽位并存，`activeKernel` 只决定「哪个槽位参与会话流」，不是「替换另一个槽位」。

「内核是模型的派生量」是这里最关键的纪律：选模之前不起任何内核进程。历史教训是预热双内核会把会话绑进「预热时随机定的中立会话 + 首注册内核」，用户选的模型被旧预热进程截胡（选 dsh 却路由到 pi 的根因）。所以 `ensureForSend(kernel, provider, model)` 由调用方显式指定内核，不做任何回落；`resolveSessionKernel` 读不到内核归属就报错，不静默落 pi。

---

## 10 槽位契约与事件总线：内容怎么挂上壳

§5 讲了「薄壳」的原则——壳只有机制，内容外挂。这一节讲外挂的机制本身：槽位（slot）和事件总线。这是壳插件和壳之间、壳插件之间的两根连接管道，也是「壳不内嵌内容」能成立的物理基础。

### 10.1 槽位：声明式贡献 + 消费方查槽

槽位是壳预定的挂载点。壳只认槽位契约，不认具体插件。`contributions.ts` 里的 `SlotName` 联合类型列出 27 个槽位名，每个槽位的贡献项形状是一个 interface——`SidebarContribution`、`SidePanelContribution`、`BlockRendererContribution`、`ComposerActionContribution` 等等。

三段式是槽位机制的统一模式：**domain 契约 → registry 注册 → renderer hook 查询 → 消费方渲染前查表**。贡献方在 `plugin.json` 的 `contributes.<slot>[]` 里声明（数据），消费方（timeline、sessions-list、文件树、右面板）经 hook 查槽（查询），框架自动匹配组件（注册）。双向解耦：消费方不认识贡献方，贡献方不认识消费方——清单来自内核注册表，两者只认识圆心契约里的那个 interface。

这条模式的统一性有一个判别信号：`fileActions`、`messageActions`、`sessionGroupings`、`composerPolicies`、`composerAttachments`、`composerActions`、`composerStats`、`composerTop`、`composerVoice` 这些槽，注释里都是同一句话——「与 fileActions 同范式」「机械镜像 xxx 槽」。它们不是九个独立设计，是同一个「声明式贡献 + 查槽 + 组件自动匹配」模式在九个挂载点上的参数化（呼应 §1.3「先想统一抽象，再分类」）。

### 10.2 组件自动匹配

壳插件不手动调 `registerXxxComponent("Name", Comp)` 注册组件。框架加载 renderer module 后，读 manifest 的 `contributes.*[].component` 字段，在 module 的 exports 里找同名组件，自动注册。壳插件只 export 组件，不调任何 register 函数。这条「自动匹配」消掉了「注册名散落」这类 bug 温床——组件名只在 manifest 出现一次，框架负责查 exports。

`messageActions` 槽是这条的一个变体：贡献项里 `component` 字段指向的组件，框架从插件 exports 自动匹配，组件收到 `{ message, text }` props 自己渲染按钮、自己处理点击——贡献方自持渲染和交互，消费方（timeline）只查槽把它挂上去。

### 10.3 事件总线：插件间唯一通信通道

壳插件之间唯一合法的通信是 `ctx.events.emit/on/invoke`，不通过共享 store 互读写，不通过 `window.kernel` 直调对方能力。事件总线在 renderer 侧运行（`packages/react/src/event-bus.ts`），不跨进程。

channel 由代码级 `export const channels` 声明，框架加载 module 后读 `module.channels` 自动注册。两种原语分工明确：

- `emit` 是发布/订阅：只能发自己声明过的 channel，payload 被缓存供 `replayLast` 回放——适合可回放的状态广播（比如 `goal:state`）。
- `invoke` 是定向分派：调别的插件拥有的 channel，调用方不需要权属——适合一次性命令；无订阅者时入队，首个订阅者挂载时恰好一次投递，不做回放（比如 `timeline:scrollTo`、`bookmarks:addRequested`）。

`dependsOn` 是生命周期护栏，不控制加载顺序：凡消费别人的 channel（on 或 invoke）都应声明它。框架系统事件用 `system:` 前缀（`configFileSaved`、`settingsChanged`、`systemThemeChanged` 等），插件订阅不需要 dependsOn。

### 10.4 槽位是纯函数渲染

槽位渲染是纯函数：给定同一条中性事件流，timeline 怎么画，与内核无关。壳插件的渲染逻辑里不该出现内核身份分支——内核差异由适配器在事件层抹平，不由壳插件在渲染层抹平。这是「壳只认中性事件」在渲染层的推论：`blockRenderers` 槽的分发按块类型（thinking/toolCall/text/userText/divider），不按内核；`codeBlockRenderers` 按围栏语言（mermaid/puml）分发，也不按内核。内核差异在到达渲染层之前已经被适配器翻译掉了。

## 11 插件四件套与内核插件：一个功能如何跨两个内核

§7 讲了前后端分离、§10 讲了槽位和事件总线，但还有一个问题没回答：一个功能既要在壳里出 UI，又要在 pi 和 dsh 两个内核里补能力，它怎么组织？答案是「插件四件套」——一个功能收进同一个壳插件目录，内部按需四件。

### 11.1 四件套的物理结构

```
src/plugins/{domain}/{feature}/
  locales/          # i18n 文案（desktop UI 文案）
  renderer/         # desktop 壳插件（UI 组件 + 槽位贡献 + 事件）
  pi-extension/     # pi 内核插件（给 pi 补能力的 TS 扩展）
  dsh-extension/    # dsh 内核插件（给 dsh 补能力的 Cordis 插件）
```

`plugin.json` 里两个字段接通内核侧：`piExtension`（相对路径，activate 时同步到 `~/.pi/agent/extensions/<pluginId>/`）和 `dshExtension`（同步到 dsh cordis 插件目录并挂 cordis.yml 块）。同一个能力在两个内核的对称实现——比如「读用户全局 CLAUDE.md」，pi 侧走 piExtension（read-claude-md 内核扩展），dsh 侧走 dshExtension（dsh cordis 插件）。goal 插件是四件套的完整参考实现：`renderer/`（目标条 UI）+ `pi-extension/`（set_goal/achieve_goal）+ `dsh-extension/`（同名 cordis 插件），内核侧只是「薄工具」，真相源在壳的 goal-state。

### 11.2 四件套 vs 三分法

四件套是「内核插件补面」的物理载体。三分法（§8）说「翻译 / 补面 / 降级」，四件套回答「补面怎么落地」：给缺能力的内核写内核插件，pi 侧是装进进程的 TS 扩展，dsh 侧是 Cordis 插件。而「非必要不修改薄壳内核，也绝不修改外部内核仓库」是四件套的纪律边界：要改别人的功能首选改对方插件（走槽位填槽），给内核补能力只写内核插件（pi-extension / dsh-extension），严禁改 deepseek-harness / dsh 等外部仓库的核心。

判别气味：改动一个功能时 diff 落在 `src/server/`（壳）而非 `src/plugins/` 或内核插件，就是把功能做成了「改内核」而非「写内核插件」——违规。

### 11.3 内置内核扩展的收敛

pi 侧的五能力（toolgate / context-probe / bus / subagent / skills）被合并成统一入口 `packages/my-harness-fit-pi-extension`，dsh 侧的四个随插件携带的 cordis 插件被合并成 `my-harness-fit-dsh-extension`。这是「框架管通用，特化归外层」在内核插件上的落地：不是每个壳插件各自带一套内核基础设施，而是基础设施收敛成统一适配插件，壳插件只带自己的私货通道（`piExtension`/`dshExtension`）。

## 12 会话标识：三种身份，一条投影链

§3 讲了中立层是唯一真相源，但没细说「身份」这件事。这里展开——因为会话标识是整个多内核设计的承重墙：壳怎么定位一个会话、怎么把它投到内核、怎么在 pi 和 dsh 之间切换，全靠这一套身份和投影。

### 12.1 三种身份，用途严格分开

`session-neutral.ts` 定义了三种身份，一条都不能混：

- `neutralSessionId`（壳生成 UUID）：壳的会话列表/书签/分组/置顶/归档的主键。跨内核稳定——同一个会话从 pi 切到 dsh，它不变。它是「壳的坐标系」的原点。
- `lineageId`：一条 lineage 的身份。根 lineage 的 lineageId 初始 = neutralSessionId，fork 后新分支各有一个新 UUID。它是「分支坐标系」的原点。
- `kernelEntryId`：内核私有 entry id（投影时的 opaque 线索，仅 adapter 用，不进中立契约对外面）。pi 是它的 entry id，dsh 是 seq。

`NeutralEntry` 里的 `neutralEntryId` 是 `{lineageId}:{seq}`，由纯函数 `neutralEntryId(lineageId, seq)` 生成——稳定、跨内核不变。`NeutralAnchor = { lineageId, entryId }` 是完全内核无关的坐标，替代了早期 `Anchor.opaque` 私有 token。

### 12.2 壳的主键是它自己的 UUID，内核标识是投影

核心命题一句话：壳的 session 主键是它自己生成的 neutralSessionId，内核的 session 标识是内核私有的，两者经适配器映射。这是「壳不读内核存储」的落地——壳不需要知道 pi 的 JSONL 文件路径或 dsh 的 session id，它只需要一个 neutralSessionId，然后问内核的 SessionCatalog「这个 ns 在你那里对应什么」。

`SessionCatalog` 的三个方法承载这条投影链：

- `newSessionId(cwd)`：生成新会话的不透明 id。pi 返回派生文件路径（`<bucket>/<lineageId>.jsonl`，文件名就是 ns，无随机 stamp）；dsh 返回 null（惰性创建，服务端首次 prompt 时建会话）。
- `projectionPath(cwd, lineageId)`：投影地址，由 lineageId 确定性派生、幂等。作 `SessionInfo.path` 的投影线索，**不承诺磁盘上存在对应文件**。
- `rawFilePath(cwd, lineageId)`：会话原始文件的真实磁盘路径，「打开原始文件」的唯一权威来源，存在才返回。

投影地址和原始文件必须分开——投影地址是坐标系，不是文件路径；拿它当文件路径打开会打开一个不存在的文件。这条区分是有实际 bug 教训的（「打开原始文件」点击无反应的根因就是拿投影地址硬猜）。

### 12.3 seed 的 id 派生幂等

`seed` 把「活跃 lineage 的完整线性内容」物化到内核，内核侧会话标识派生自 lineageId，幂等。pi 的 `piDerivedSessionPath = <bucket>/<ns>.jsonl` 就是「从 ns 确定性地算出文件路径」，重复 seed 同一个 lineage 不会产生两份文件。dsh 的 sessionId 直接是 ns（SessionId 就是 lineageId）。

早期有过一个「映射表」方案（SessionBindingStore 之类，把 neutralSessionId ↔ 内核 id 存进表里查），后来被删掉，收敛成「lineageId 确定性派生」的纯函数——查表是可变状态，纯函数派生是幂等。这是「同一逻辑收进内层统一承担」的一个实例：映射不该是存储，该是函数。

### 12.4 旧随机 stamp 的迁移边界

历史遗留：pi 早期的新会话文件名带随机 stamp（`<stamp>_<id>.jsonl`），文件名不含 ns，所以从路径反查 ns 会失败。现在 `neutralSessionIdFromPath` 用 `basename(path, ".jsonl")` 直接拿文件名当 ns——迁移前的旧文件返回 null（list 读中立层已不可见）。这是「投影链收敛为纯函数」之后，对历史数据的一个诚实边界：旧数据不在新坐标系里，不假装能投影。

## 13 设计权衡：拒绝过的方案

前面各节讲了「是什么」，这一节讲「为什么不是别的」——每一处核心设计都有一个被明确拒绝的替代方案，拒绝的理由比选中的方案更说明问题。这些权衡散落在 commit 历史和设计文档里，收拢在这里，因为它们才是「核心设计」最深的那一层。

### 13.1 为什么 fork 归壳，而不是保留内核 fork

最早（pi-only 时代）fork 是内核能力：pi 有 parentId 树，dsh 有 session forest，各有一套 fork 语义。多内核化之后，这两个语义处处相反，要拉平就得在壳里写一套「如果 pi 怎么 fork、如果 dsh 怎么 fork」的分支。被拒绝的方案是：在壳里给两个内核各写一份 fork 编排，然后靠适配器把它们翻译成「好像是一种 fork」。

拒绝的理由是 §3.1「消费而非翻译」的极端形态：让 dsh 的 fork 假装成 pi 的 fork，等于让 dsh 装 pi，真长处（dsh 的 session forest 本身就是很好的分支模型）全被埋掉。选中的方案是反向的：把 fork 从内核拿出来归壳，内核降级成单线执行器，只物化活跃 lineage，分叉是壳在中立层的纯操作（`fork(parentLineageId, boundary)` 新开一条 lineage 记 fork 点）。代价是内核自带的 fork 能力被闲置（退成历史存储格式，只被 SessionCatalog 读历史树），但换来的是「两个内核的 fork 差异对壳完全不可见」。

### 13.2 为什么中立层 + 确定性派生，而不是映射表

壳要定位一个会话、把它投到内核，早期的方案是「映射表」：一张 `neutralSessionId ↔ 内核私有 id` 的表，存进文件里查。被拒绝的理由是映射表是可变状态——fork 一次就多一条记录，删会话要级联删，跨内核切换要对账，表漂移了就找不到会话。选中的方案是「确定性派生」：内核侧标识从 lineageId 纯函数算出（pi=`<bucket>/<lineageId>.jsonl`，dsh=`lineageId`），没有表、没有对账、没有漂移——幂等，重复派生永远得同一个结果。

这条权衡的教训是一个更通用的原则：**映射不该是存储，该是函数**。凡是一个标识能从另一个标识确定性地算出来，就不要建一张表去存这个映射——表是「两份真相」，函数是「一份真相派生两份视图」。

### 13.3 为什么 seed 单线投影，而不是多线并行

既然内核是单线执行器，一个会话又有多条 lineage，那「把哪条 lineage 物化给内核」就成了问题。被拒绝的方案是：内核同时物化多条 lineage（恢复 pi 时代的 parentId 树全量 fork 语义），壳在多个活跃分支之间切换。拒绝的理由是这又回到了「让内核做分叉」的老路——内核要理解 fork 语义，两个内核的 fork 模型又打架。

选中的方案是 seed 单线投影：`BaseBackend.seed(lineage, opts)` 一次只物化一条 lineage 的完整线性内容（`lineageContent` 沿 fork 链拼出来的），内核侧标识派生自 lineageId。切换活跃分支 = 重新 seed 另一条 lineage。代价是「seed 生命周期不对称」——pi 的 seed 是纯文件写（spawn 前），dsh 的 seed 是 RPC（spawn 后）——这个不对称写进了 `BackendFactory.seed?` 返回 null 的契约里，是「适配器翻译」而非「让 pi 装 dsh」。

### 13.4 为什么 Host 抽象 + 前后端分离，而不是纯 Electron

壳曾经是 Electron-only：main 进程 + renderer，靠 preload/contextBridge 暴露 `window.kernel`。被拒绝的方案是继续 Electron-only，把远程访问做成「Electron 内的一个功能」。拒绝的理由是「远程访问」这个需求暴露了 Electron 的假设——窗口、对话框、系统通知这些宿主能力，在一个 headless Node 服务器上根本不存在；如果把这些能力焊死在 main 进程里，就没法起一个服务器宿主。

选中的方案是 Host 抽象（`domain/host.ts` 的 `Host` 接口：lifecycle/window/dialog/shell/notify/app/theme/platform）+ 前后端分离（`bootstrap/electron.ts` 和 `bootstrap/server.ts` 双入口，各注入一份 Host，共用 `assemble.ts`）。Electron 宿主是完整实现，Node 服务器宿主是降级实现（窗口/对话框 reject `UNSUPPORTED_HOST`、通知 no-op）。代价是 renderer 从「同进程 IPC」换成「跨进程 WS」，但圆心一行没动——圆心还是那批类型，只是渲染端换了传输。

### 13.5 为什么能力探测，而不是内核身份硬分支

壳要区分「这个内核有没有某能力」，被拒绝的方案是 `if (kernel === "pi")` 硬分支。拒绝的理由是硬分支把「内核身份」漏进了壳的会话意图链路——每加一个内核，壳里就多一处「如果这是新内核就……」，而「内核可替换」要求加内核时壳一行不改。

选中的方案是能力探测：`backend.capabilities.pi` / `.dsh` 分桶，壳经「有则用、无则降级」探测，不按内核身份硬分支。pi 的扩展面（`PiBackendExtensions`）在圆心里是 opaque（`unknown`），application 经 type-only import 收窄——圆心不 import pi 实现，依赖方向不倒。dsh 的能力面（`DshCapabilities`）是懒探测：首次调用失败（unknown method）才记录进 `missing`，之后显式降级——这是「运行时探测」而非「版本号硬编码」。

### 13.6 为什么每会话一进程，而不是进程池或单进程

进程模型有三个候选：单进程跑所有会话、进程池复用、每会话一进程。被拒绝的是前两个——单进程跑所有会话会把一个会话的崩溃/阻塞传导给所有会话；进程池复用会引入「哪个会话分到哪个进程」的分配复杂度和跨会话状态泄漏。选中的是每会话一进程、多会话多进程：看会话读文件不启进程，发消息才按需起该会话的内核，不杀其他会话的进程。

这条权衡的关键推论是「内核 = 模型的派生量」：选模之前不起任何内核进程。历史教训是预热双内核会把会话绑进「预热时随机定的中立会话 + 首注册内核」，用户选的模型被旧预热进程截胡（选 dsh 却路由到 pi 的根因）。所以 `ensureForSend(kernel, provider, model)` 由调用方显式指定内核、不做任何回落，读不到内核归属就报错、不静默落 pi。

## 14 QA

**Q：为什么壳要维护自己的中立会话层，而不是直接读内核存储？**

因为「读内核存储」意味着壳要知道每个内核的存储格式——pi 是 JSONL 文件 + parentId 树，dsh 是 append-only log + session forest，第三个内核可能又是别的。每加一个内核，壳的 list/open/rename 就要各写一遍。中立层把这件事变成「壳只认 NeutralSession，内核存储是投影」——加第三个内核只加一个投影适配器，壳的列表/打开/命名一行不改。代价是双写（中立层 + 内核投影），但「投影失败不阻断」把代价压到了可容忍。

**Q：`seed` 的「生命周期不对称」——pi 先 seed 后 spawn、dsh 先 spawn 后 seed——会不会把调用方搞复杂？**

会，但这是内核真实差异的诚实反映，不是设计偷懒。pi 的会话文件是纯文件，seed 就是写文件，不依赖进程；dsh 的会话在服务端，seed 是 RPC，必须进程先起。`BackendFactory.seed?` 返回 null 把这个差异显式化：调用方统一走「先试预 seed，null 则 create→start→backend.seed」。如果硬要把两边拉成同一个时序（比如给 pi 也先 spawn 再 seed），等于让 pi 装 dsh——那是「让 dsh 装 pi」的反向版本，同样违规。

**Q：fork 归壳之后，内核自带的 fork 能力怎么办？**

不用它。内核降级成单线执行器，它的 fork 语义（pi parentId 树、dsh session forest）退成「历史存储格式」，只被各自的 SessionCatalog 读（getTree 读历史树），不再被壳的 fork 路径调用。壳的 fork 是中立层纯操作：`fork(parentLineageId, boundary)` 新开 lineage 记 fork 点，下次 prompt 前 `lineageContent` 拼出完整线性内容 seed 进去。这样 pi 和 dsh 的 fork 差异对壳完全不可见。

**Q：`capabilities` 为什么用 `{ pi?: unknown }` 而不是直接把 PiBackendExtensions 写进圆心？**

因为 `PiBackendExtensions` 的形状是 pi 专属的，定义在 `src/server/kernel/pi/backend/pi-backend-extensions.ts`。如果圆心 import 它，圆心就依赖了 pi 的实现——依赖方向反了。所以圆心里 pi 槽是 opaque（unknown），application 经 type-only import 收窄。这是「内核专属能力不进中立契约、圆心不依赖内核实现」的落地：壳经能力接口探测，pi 扩展面形状在外层。

**Q：`projectionPath` 和 `rawFilePath` 为什么要分成两个方法，不能合并吗？**

不能。投影地址是坐标系（pi = 派生文件路径 `<bucket>/<ns>.jsonl`，dsh = lineageId），它由 lineageId 确定性派生，是「这个会话在哪个坐标系里」的答案，不承诺磁盘上有对应文件。原始文件是「这个会话的原始内容真的存在哪个磁盘文件」的答案，是内核专属知识（pi 的 JSONL 文件、dsh 的 `<会话根>/<cwd 桶>/<lineageId>/session.jsonl.zstd`），存在才返回。合并成「一个 path」会让调用方拿投影地址当文件路径硬猜，「打开原始文件」点开会落到不存在的文件上。这是有实际 bug 教训的（fix commit：修复「打开原始文件」点击无反应——投影地址不硬猜，原始文件经内核目录解析）。

**Q：基类（AbstractBackend）和内核插件（补面）都解决「缺能力」，它们有什么区别？**

基类解决的是实现复用：pi 和 dsh 都缺 `continue` 时，各自抛一次「缺面」错误是重复代码，抽到基类的缺面默认（`continue` 抛错）就只写一份。内核插件解决的是能力拉平：某个内核真的没有某能力，给它补一个实现（pi 的 TS 扩展、dsh 的 Cordis 插件），让壳无感。区别在于：基类的「抛错」是显式降级（壳据此隐藏入口），内核插件的「补实现」是真把能力补出来（壳正常用）。两者正交——抽了基类不等于拉平了能力，写了插件不等于不用基类。

**Q：前后端分离之后，为什么圆心还要保持「零依赖」？**

前后端分离只是把渲染端从「同进程 IPC」换成「跨进程 WS」，圆心要服务的目标更多了（壳后端、前端、内核扩展三方 import），但圆心的性质没变——它还是「拿掉所有会变的东西之后剩下的」：纯类型 + 纯函数 + 中立契约。零依赖是圆心稳定性的物理保证：如果圆心 import 了 react 或 electron，那前端换框架、壳换运行时，圆心都要跟着动。零依赖让圆心在任何运行环境（Electron、Node 服务器、将来的 Tauri）里都是同一份不动的东西。
