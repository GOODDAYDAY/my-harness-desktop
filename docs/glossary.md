# 术语表

这份术语表是 my-harness-desktop 文档集的公共地基。docs/ 下的架构文档和插件文档默认读者已经读过了这份表（或 `core-design.md`），不再在每篇里重复定义这些词。读任何一篇文档前先扫一遍这张表，卡住时回来查。

按「从里到外」分组：先架构分层，再会话/lineage 坐标系，再机制，再多内核，再前后端。

## 1 架构分层

- **圆心**：壳最里面的一层，物理上是 `packages/shared/src/domain/`。只有类型定义和纯函数，零依赖（不 import react/electron/任何内核）。换掉 Electron、React、任何内核，它都不动。中立契约（`BaseBackend`/`KernelId`/`LineageTree`）和槽位契约都定义在这里。
- **壳**（shell）：my-harness-desktop 的薄壳，提供机制的部分——加载器、槽位契约、适配器装配、配置读写、权限沙箱、事件总线。物理上是 `packages/shared`（圆心）+ `src/server`（壳后端）+ `src/web`（前端）。壳不拥有任何内核的存储格式、事件形状、插件树、fork 语义。
- **壳插件**：挂在壳槽位上的 UI 插件，只 import `@my-harness-desktop/shared`（类型）和 `@my-harness-desktop/react`（组件/hooks）。内置壳插件在 `src/plugins/` 六域（themes/sessions/project/insight/manager/system）。出 UI 的是壳插件。
- **内核**（kernel）：一个自洽的 AI agent 运行时，自带插件树、会话模型、能力集。pi 和 dsh 各是一个，同级。内核是被壳管理的资源（独立子进程），不是壳插件。出能力（会话/工具/模型）的是内核。
- **内核插件**：内核自己的插件——pi 侧是装进进程的 TypeScript 扩展（`my-harness-fit-pi-extension`），dsh 侧是 Cordis 插件树。这是「内核的能力来源」，和壳插件是两回事。
- **适配器**（adapter）：内核专属形状 ↔ 中立契约之间的翻译层，每个内核一个（`PiBackend`/`DshBackend`）。它做三种事：直接映射、需翻译（形状不同）、缺面（降级或补面）。
- **中立契约**：壳需要内核提供的「最小意图」集合，落成 `BaseBackend` 接口（14 必实现 + 4 缺面默认 + 3 默认成员）＋ `SessionCatalog` ＋ `KernelModelSource`。
- **洋葱架构**：依赖方向只向内的几何纪律——外层可以依赖内层，内层绝不依赖外层。圆心最稳定，越往外越会变（内核、Web 框架、数据库驱动、第三方 SDK）。

## 2 会话与 lineage 坐标系

- **lineage**：会话里的一条线性历史。根 lineage 是最早那条，fork 出来的分支各是一条。一条会话 = 一根根 lineage + 各自的分叉点。
- **fork（分叉）**：从某个位置切出一条新 lineage。在 my-harness-desktop 里，fork 归壳（内核降级成单线执行器），是 `SessionTreeApi.fork(parentLineageId, boundary)` 的纯操作。
- **中立层**：壳自己的会话真相源，`NeutralSession`（`packages/shared/src/domain/session-neutral.ts`）。会话列表、书签、分组都以它为唯一真相源，内核存储只是投影。
- **neutralSessionId**：壳生成、跨内核稳定的会话主键（UUID）。壳的会话列表/书签/分组的 key 都是它。
- **lineageId**：一条 lineage 的身份。根 lineage 的 lineageId 初始 = neutralSessionId，fork 后新分支各有一个新 UUID。
- **kernelEntryId**：内核私有 entry id（投影时的 opaque 线索，仅适配器用）。pi 是 entry id，dsh 是 seq。
- **entry（条目）**：会话流里的最小单位，一条 message 对应一条 entry。`neutralEntryId = {lineageId}:{seq}`（seq 是 0-based 序号）。
- **回合（turn）**：一次「用户消息 → 模型响应（可能含多轮工具调用）」的完整往返。fork 的分叉点必须落在完整回合之后。
- **seed（投影）**：把「活跃 lineage 的完整线性内容」（`lineageContent` 算出的 `NeutralEntry[]`）物化到内核，内核侧会话标识派生自 lineageId（幂等）。
- **投影 / 物化**：把中立层的数据「翻译」成内核的存储形态（pi 的 JSONL 文件、dsh 的 session）。换内核 = 换投影实现，中立层一行不动。
- **投影地址（projectionPath）**：由 lineageId 确定性派生的地址，作 `SessionInfo.path` 的线索，不承诺磁盘上存在对应文件。
- **原始文件（rawFilePath）**：会话原始内容的真实磁盘路径，「打开原始文件」的唯一权威来源，存在才返回。

## 3 机制

- **槽位（slot）**：壳预定的挂载点。壳插件往槽位上挂内容，壳只认槽位契约不认具体插件。共 27 个（sidebar/sidePanel/mainView/titlebar/settings/themes/languages/blockRenderers/codeBlockRenderers/composerActions…）。
- **贡献项（contribution）**：插件在 `plugin.json` 的 `contributes.<slot>[]` 里声明的槽位内容。
- **三段式**：槽位机制的统一模式——domain 契约 → registry 注册 → renderer hook 查询 → 消费方渲染前查表。贡献方声明、消费方查槽、框架自动匹配组件。
- **组件自动匹配**：框架加载 renderer module 后，读 manifest 的 `component` 字段，在 module exports 里找同名组件自动注册。插件只 export 组件，不调 register 函数。
- **事件总线**：renderer 侧的插件间通信通道。channel 由代码 `export const channels` 声明。
- **emit / invoke**：事件总线的两种原语。emit 是发布/订阅（可回放 `replayLast`），invoke 是定向分派（无订阅者时入队）。
- **dependsOn**：生命周期护栏，凡消费别人 channel 的插件声明它。
- **PluginContext**：壳插件代码能拿到的唯一 API 对象，经 `usePluginContext()` 获取（config/fs/git/sessions/models/events/layout 等）。
- **权限沙箱**：壳插件声明 `permissions`（fs:project/git:read/git:write/llm:oneshot/sessions:bus/rpc:bash），壳后端在网关边界检查。
- **插件四件套**：一个功能收进同一个插件目录——`locales/`（文案）+ `renderer/`（壳插件）+ `pi-extension/`（pi 内核插件）+ `dsh-extension/`（dsh 内核插件）。

## 4 多内核

- **KernelId**：`"pi" | "dsh"`，全仓唯一能出现内核身份字面量的地方（`packages/shared/src/domain/kernel.ts`）。
- **多内核平权**：pi 和 dsh 同级，谁也不比谁更内建。「默认 pi」是配置，不是「pi 内建」。
- **能力探测**：壳经 `backend.capabilities.pi` / `.dsh` 探测「有则用、无则降级」，不按内核身份硬分支。
- **三分法**：壳看到 pi/dsh 差异的三条出路——适配器翻译（同语义不同形状）→ 内核插件补面（能力缺失写内核插件）→ 显式降级（隐藏入口不伪造成功）。
- **静默缺面**：壳调了内核没有的能力，既不翻译也不补面也不降级，静默吞掉或假装成功——不允许。

## 5 前后端与运行

- **前后端分离**：my-harness-desktop 是「服务器 + 前端」双端。`src/server`（壳后端，Electron main 或 Node 服务器双宿主）+ `src/web`（React 前端），经 HTTP + WS 通信。
- **Host 抽象**：宿主能力接口（生命周期/窗口/对话框/通知/系统主题）。Electron 宿主是完整实现，Node 服务器宿主是降级实现。
- **window.kernel**：前端访问壳后端能力的桥（`src/web/kernel/build-kernel.ts` 构造）。壳插件经 `usePluginContext()` 访问，不直连。
- **进程模型**：每会话一进程、多会话多进程。看会话读文件不启内核，发消息才按需起该会话的内核进程。
- **内核 = 模型的派生量**：选模之前不起任何内核进程；内核身份由所选模型的归属决定，不回落 pi。

## 6 高频歧义澄清

- **「唯一真相源」vs「真相源」**：前者指会话数据（中立层 `NeutralSession` 是列表/书签/分组的唯一真相源）；后者在讲会话流时指「会话事件流的真相源单一在壳后端 main」。两个语境，别混。
- **「投影」有两个用法**：一个指「把中立 lineage 物化成内核存储」（seed/投影实现）；一个指「由 lineageId 派生出地址」（投影地址 projectionPath）。前者是动作，后者是地址。
- **「15 条必实现」是旧说法**：早期 BaseBackend 含 `fork`，是 15 条；fork 归壳后是 14 条 abstract。源码注释里「15 条必实现」是 stale 残留，以代码（14 条 abstract）为准。
