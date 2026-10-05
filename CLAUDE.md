# 核心原则

> 本文用到的几个高频术语，先一次性交代清楚，后面不再重复解释：
>
> - **内核**（kernel）：一个自洽的 AI agent 运行时，自带插件树、会话模型、能力集。pi 和 dsh 各是一个，**同级**——谁也不比谁更"内建"。内核是被壳管理的资源，不是壳插件。本文的"内核"一律指这个抽象；历史代码里仍大量用"底座"指代 pi 内核（"pi 底座""底座事件""底座扩展"），读到"底座"按"pi 内核"理解，写新代码/新文档一律用"内核"。
> - **壳**（shell）：my-harness-desktop 的薄壳，提供机制的部分——加载器、槽位契约、适配器装配、配置读写、权限沙箱。物理上对应 `packages/shared`（圆心）+ `src/server`（壳后端）+ `src/web`（前端）的机制代码。壳不拥有任何内核的存储格式、事件形状、插件树、fork 语义。
> - **壳插件**：挂壳槽位的 UI 插件，只 import `@my-harness-desktop/shared` 和 `@my-harness-desktop/react`。内置壳插件在 `src/plugins/`，第三方壳插件在用户目录。出 UI 的是壳插件，出能力（会话/工具/模型）的是内核。
> - **内核插件**：内核自己的插件——pi 侧是装进进程的 TypeScript 扩展（统一为 `my-harness-fit-pi-extension`，内含 toolgate / context-probe / bus / subagent / skills 五能力），dsh 侧是 Cordis 插件树（`my-harness-fit-dsh-extension` 统一适配插件 + upstream 的 dsh-subagent / dsh-compaction-basic / dsh-credentials-local；`llm-deepseek` 仅存在于上游，壳生产代码不引用）。这是"内核的能力来源"，和壳插件是两回事。
> - **中立契约**（contract）：壳需要内核提供的"最小意图"集合，落成 `packages/shared/src/domain/backend.ts` 的 `BaseBackend` 接口（契约 = **18 必实现 + 5 可选 `?`**；基类 `AbstractBackend` 的形状 = **14 abstract + 3 缺面默认（listTools/answerQuestion/setThinkingLevel）+ 4 默认成员（capabilities/configDepPaths/sessionId/supportsRuntimeSetModel）**——成员账以代码为准，勿背注释里的数字）。六条核心意图：消息 / 中断 / 模型 / 分支 / 会话标识（getTree·getEntries·bookmark·deleteBookmark）/ 流式事件；之上再叠命名（`setSessionName`，第七意图）、思考档位设置（`setThinkingLevel`）、`seed`（跨内核切换投影）、工具发现（`listTools?`/`setTools?`）、提问（`answerQuestion?`）与能力探测（`capabilities`）；另有每内核跨会话目录/CRUD 的 `SessionCatalog` 与模型清单的 `KernelModelSource`（§9.4）。续跑不是独立意图——续跑就是发消息（`sendMessage`），见 `docs/design/goal.md` §3.2。（⇐ 此处曾把 `resume?` 列为会话标识核心之一：r72 已随"全仓无消费方"删除，锚点重启走 `SessionStore.resume` 的中立层派生 `deriveSession`，对所有内核一律适用，不是内核面。）
> - **适配器**（adapter）：内核专属形状 ↔ 中立契约之间的翻译层，每个内核一个（`PiBackend` / `DshBackend`）。它做三种事：直接映射、需翻译、缺面（降级或补面）。
> - **圆心**：壳最里面的一层，`packages/shared/src/domain/` 目录。只有类型定义和纯函数，零依赖。换掉 Electron、React、任何内核，它都不动。中立契约（`BaseBackend` / `KernelId` / `LineageTree`）定义在这里。
> - **中性**：不依赖任何框架、任何库、任何运行时、任何内核。中性类型是纯 TypeScript 类型，中性事件是去掉了内核细节的结构化数据。所有内核的事件都往中性域投，壳只认中性域。
> - **lineage**：会话里的一条线性历史。根 lineage 是最早那条，fork 出来的分支各是一条。`fork(parent, boundary)` 里的 parent 和 boundary 都是 lineage 坐标系里的东西。pi 的 `parentId` 树和 dsh 的 session forest 是同一棵 lineage 树的两种存储。
> - **槽位**：壳预定的挂载点。壳插件往槽位上挂内容，壳只认槽位契约不认具体插件。比如 sidebar、settings、themes 都是槽位。
> - **PluginContext**：壳插件代码能拿到的唯一 API 对象，经 `usePluginContext()` 获取。分三层：pluginId 绑定层（config/fs/git/gitWrite/llm/bash，均声明能力——服务端按 manifest permissions 逐面门控）、系统级 API 层（prefs/themes/kernel/sessions 等）、事件层（events.emit/on）。pluginId 由框架从 PluginIdContext 自动注入，插件不手写。
> - **事件总线**：renderer 侧的插件间事件通道（`packages/react/src/event-bus.ts`）。channel 由代码级 `export const channels` 声明，框架加载 module 后自动注册。插件间通信只走事件，不走共享 store 互读写。
> - **JSONL**：JSON Lines，每行一个完整 JSON 对象。它是**传输细节**（内核和壳的对话走 JSONL、pi 的会话文件也是 JSONL），不是语义契约——语义契约是 lineage 和中性事件。

> 📌 **设计原则 + 反模式总纲见 `docs/design/design-principles.md`**——从 176 个 session 的用户输入 + 真实代码 + 1300+ 条 commit 交叉提炼的 38 条原则与 18 条反模式清单（每条为「原则陈述 + 判别气味 + 反模式 + 正确做法」四段，可直接作为 lint / code review / 盲审的检查项）。本文（CLAUDE.md）是纪律总纲，那份是「原则 + 反模式」的可对照执行展开。写插件前先读它。

## 1 底线：不可逾越的纪律

### 1.1 依赖只向内

这是一切纪律的根。圆心是稳定的业务本质，外层是会变的细节，依赖箭头永远指向圆心——外层可以依赖内层，内层绝不依赖外层。这条规则不解释、不通融、没有例外。任何一条依赖如果从内层指向外层，不管它看起来多么"合理"、"只是用了一下"、"临时方便"，都是违规。

为什么是绝对的？因为依赖方向决定了一个系统在面对变化时的冲击传播范围。当外层的一个数据库驱动、一个 Web 框架、一个第三方 SDK、甚至一个内核实现要换的时候，如果内层依赖了它，改它就得改内层，改内层就得改依赖内层的所有东西，冲击波从外向内一路炸进去，整个系统翻一遍。但如果依赖只向内，换外层只动外层，内层一行不改，冲击被外层吸收——这就是洋葱架构把"会变的"推到外层的几何意义：不是美学偏好，是变更隔离的物理需要。

- **判别气味一：业务函数里直接出现 SQL / HTTP / ORM / 进程调用**。业务核心被基础设施污染了——这些是会变的外层细节，不该出现在内层。该做的是把它们推到外层，内层通过接口声明"我需要什么数据"，外层去拿。

- **判别气味二：内层 import 了外层包**。这是依赖方向反了，立即反转。具体到本项目（分区在 §6 详述）：`packages/shared/src/domain/` 里如果出现 `import ... from 'electron'`、`import ... from 'better-sqlite3'`、`import ... from 'react'`、甚至 `import ... from '@/server/kernel/pi/...'`，都是红线。`src/server/application/` 里如果出现对 `kernel/{pi,dsh}` 具体实现的**非 type-only** import，也是红线——它 import 了具体内核实现，等于把"会变的内核"焊进了用例编排。

- **判别气味三：同一逻辑在多个外部入口各写一遍**。这说明这个逻辑应该收进内层统一承担，而不是每个调用方各自实现。多内核场景下的典型：pi 和 dsh 各自写一份"缺面抛错"、"fork 前校验 boundary"——该收进基类或圆心一个实现，调用方只传参数。

- **判别气味四：内层需要知道外层的环境信息**。`process.cwd()`、`process.env.HOME`、`__dirname` 这些是外层环境，内层不该直接读。如果内层需要路径，由外层在启动时注入。内核专属配置同理：`cliPath`、`cordisConfig`、`apiKey` 不进契约，由 `bootstrap` 的工厂闭包捕获（§6.2）。

这条纪律的执行不靠自觉，靠物理隔离。`packages/shared/src/domain/` 里放不下 `electron`，放不下 `better-sqlite3`，物理上就 import 不了——目录结构本身就是第一道防线，比靠 code review 抓违规可靠得多。

### 1.2 机制与内容分离

一个系统的壳分两种东西：让功能能挂上来的机制，和挂在上面的功能本身。机制是加载器、槽位契约、权限沙箱、进程隔离、生命周期管理——这些是"让东西能存在"的能力。内容是文案、配色、管理页、渲染逻辑、业务分支——这些是"存在之后干什么"。核心原则一句话：壳只有机制，内容全部外挂。

这条纪律的极端表达是：壳的功能含量趋近于零。不是"尽量少"，是趋近零——壳里不该出现一个写死的中文文案、一个写死的颜色值、一段"如果工具名是 bash 就渲染成终端"的分支逻辑。出现就是违规。注意：这里说的"功能含量"是指业务内容（文案、配色、渲染逻辑、业务分支），不是说壳里什么都不放——加载器、槽位契约、RPC 适配这些是机制，不是内容，它们当然在壳里。机制和内容的分界线就是：拿掉它系统还能不能启动，以及它会不会被替换。

同一句铁律在内核这一层的延伸是"壳 vs 内核"：壳只放"所有内核共用的机制"（槽位/渲染/意图/事件总线），内核只放"它自己的内容"（会话模型/插件树/能力集）。内核的会话怎么存、怎么分叉、怎么跑插件，是它自己的事，壳不过问。

- **token key 合规，token 值违规**。壳渲染时必然出现查询标识——`theme["color.primary"]`、`i18n.t("timeline.toolExecuting")`。这些是 key，是稳定不变的查询契约，不算"写死"。违规的是写死 key 背后的值——`"#89b4fa"` 是颜色值，`"工具执行中"` 是文案原文，它们是会变的内容，该由主题插件和语言插件贡献。key 是契约、值是内容，性质完全不同。

- **检验方式**：打开壳任何一个文件，如果能找到一个写死的颜色十六进制、一个写死的用户可见文案、一个针对具体内核类型的 if-else 分支（`if (kernel === "pi")` 出现在会话意图链路上）——那就是违规。这个检验不依赖任何外部知识，新人也能当场判。

为什么要这么极端？因为内容会变，机制相对稳定。把内容焊死在壳里，意味着每次改文案、调配色、加一种内核类型的渲染，都要动壳、都要发版、都要全量回归。把内容推出去，改内容只动对应的插件，壳一行不动。VSCode 是这套模型最成功的工业级样本——它的语言包、主题、默认渲染器全是插件，不是硬编码。

### 1.3 契约单源

一个概念只有一份定义。这不是"最好一份"，是必须一份——两份定义必然从第一天就开始漂移。你需要一个发布面，那就 re-export，不是复制。类型在圆心定义一次，外层要引用就 import 或 re-export，永远不在另一个地方重新写一遍。

- **收敛方式**：圆心定义唯一源，外层做纯 re-export——`export type { X } from 'domain'`、`export { f } from 'domain'`，一行逻辑没有。发布面是投影不是副本。这样概念改一次，所有引用处同时变，不存在"改了这里忘了那里"。

- **判别气味**：两个文件里出现了同一个概念的两份定义——哪怕一份是"精确的"、一份是"为了兼容的"——都是违规。多内核下的具体化：`KernelId` 已是**不透明 string**（`packages/shared/src/domain/kernel.ts` 单源；内核 id 由各内核插件在 plugin.json/工厂自声明，清单由 `KernelRegistry` 运行时驱动）——任何 `"pi" | "dsh"` 字面量联合、硬编码内核名数组都是复制身份定义，该删。（⇐ 本条旧版曾写"字面量联合收敛到 kernel.ts 一处"：那是字面量联合还在时的判据，插件化后 kernel.ts 自身也不含字面量，判据随之改为"零字面量"而非"收敛到一处"。）

这条纪律的推论是：内核身份、模型类型、事件类型、配置类型、lineage 类型，全部从圆心发出。外层（壳插件、应用层、适配器）要引用，就从圆心 import，不自己定义一份"本地版"。一旦外层开始定义"本地版"，漂移就开始了。

契约单源和"别重复发明轮子"是两条不同的纪律，别混淆。收敛到成熟包是"用别人的实现"，契约单源是"概念只有一份定义"。前者管的是代码实现，后者管的是类型和接口。一个项目可以同时遵守两条——用成熟的 deepmerge 包（收敛），同时保证 `BaseBackend` 只在圆心定义一次（单源）。注意：圆心（`packages/shared/src/domain/`）零依赖，不能 import deepmerge——deepmerge 的调用发生在 application 层，圆心只定义类型。类型是圆心的，实现是外层的。

### 1.4 无特权差异

这条纪律有两个对象，都要守：

**壳插件无特权**：内置壳插件和第三方壳插件走同一套加载器、同一套契约、同一套权限，优先级最低、可被覆盖。壳不该有任何"识别内置壳插件并特殊对待"的代码路径。检验方式：把任何一个内置壳插件删掉，壳照常启动，只是少了那块功能；把它复制到用户目录，以更高优先级覆盖内置版。

**内核无特权**：pi 和 dsh 同级，谁也不比谁更内建。pi 失去默认特权——今天很多"默认就是 pi"的东西，同级之后都要显式化（"默认 pi"是配置，不是"pi 内建"）。壳不该有任何"识别 pi 并特殊对待"的代码路径。检验方式：把 `src/server/kernel/dsh` 删掉、把 dsh 内核禁掉，壳照常启动，只是少了 dsh 那份能力；换内核 = 换适配器，壳和壳插件不动。

为什么要守这条？因为特权是复杂度炸弹。一旦壳开始"特殊对待"某个插件或某个内核，就意味着多了一套加载逻辑、多了一套优先级判断、多了一条"如果这是 pi 的就……"的分支。每条分支都是 bug 温床。VSCode 的扩展体系里内置扩展和第三方扩展是平等的，这是它能撑起上万扩展生态的原因之一——不平等的系统到不了那个规模。

### 1.5 多内核默认

从 DSH 进来那天起，任何开发都要默认"壳同时托管多个同级内核"，不再是 pi-only。

**内核先抽象、后实现**：任何涉及内核的开发——加能力、加事件、加配置、写适配器、接第三个内核——第一步永远先问「壳要的是一个什么抽象」，把抽象落进中立契约（`BaseBackend` / `SessionCatalog` / `KernelModelSource` 这类接口），第二步才想「pi 怎么实现、dsh 怎么实现」。内核（pi / dsh）永远是抽象的一个实现，不是抽象本身；谁把某个内核的实现细节写进壳或圆心，谁就违反了「内核可替换」这条根——换掉任何一个内核、再加一个内核，壳和圆心必须一行不改。

写任何新功能、新 API、新事件、新槽位之前，先过这一问：

> **壳是不是必须向每一个内核索要它？**

答得上（每个内核都能兑现或显式"不支持"）→ 进中立契约。答不上（是某个内核的专属能力）→ 三条出路，按优先级：**适配器翻译**（内核有同语义、只是形状不同）→ **内核插件补面**（给缺能力的内核补一个实现）→ **显式降级**（壳把该能力入口隐藏/置灰，不静默、不伪造成功）。

不允许的状态只有一种：**静默缺面**——壳调了某个内核没有的能力，既不翻译、也不补面、也不降级，而是静默吞掉或假装成功。

- **判别气味**：会话意图链路上出现 `if (kernel === "pi")`，或**按内核身份取能力面的助手**，说明壳在漏内核身份。理想是**逐轴能力面**探测（`backend.capabilities.<轴>`，轴集由圆心 `BackendCapabilities` 单源定义）——"有则用、无则降级"，而不是按内核身份硬分支。
  - 已退役的两个形态（都真实存在过，勿回退）：① `asPi()` / `piSend()` —— 助手名字面意思就是"当 pi 用"，返回类型还来自跨界 import 的 `BackendExtensions`；现为按轴取面的 `faceOf(proc, 轴, 标签)` / `viaFace(轴, 标签, fn)`，错误消息点名**轴**不点名内核。② opaque 桶 `capabilities.extensions?: unknown` —— 它让 application 必须 type-only import `kernel/pi/backend/`，还把「有没有某能力」与「是不是文件态内核」混成一个判据（minimal 因此被误判）；现拆成逐轴能力面（steering/retry/compaction/snapshot/stats/modelCycle/toolExec/busFrames/questions/thinking + fileBacked + systemPrompt——r50 后共 12 个成员；轴集以 `BackendCapabilities` 定义处为准，勿背数字）。
  - **降级必须逐轴**：renderer 侧曾只有单个 `SessionCapabilities.extension` bit，于是「某内核缺多路并发」连带禁掉了它本可有的压缩与统计——违背「内核同等地位、同等功能」。现为 `faces.<轴>` 逐轴旗标 + 两个成员级位（`thinkingCycle`、`levelsSemantics`），投影是圆心纯函数 `projectCapabilityFlags`（可裸单测）。
- **内核身份不进配置文件**：`ModelInfo.kernel` 由"从哪个内核的配置扫出来"赋值，不由 provider 名反推（`if (provider.includes("deepseek")) kernel = "dsh"` 是错的）。
- **缺面/补面/降级**三分法是"多内核默认"的操作面。缺面 = 内核没有某能力；补面 = 给缺能力的内核补实现（适配器之外的内核侧补齐）；降级 = 壳收到"不支持"后隐藏入口。

### 1.6 内核源码只读：一切内核侧需求走插件

**pi / dsh（及后续任何内核）的源码，一行都不许改。** 这条不解释、不通融、没有例外——包括三个具体形态：

1. **不许改外部内核仓库**（`@earendil-works/pi-coding-agent` 上游、`deepseek-harness` / dsh 仓库）。那是别人维护的项目，我们改不动也不该改。
2. **不许改本地已装的内核包**（`node_modules/@earendil-works/pi-coding-agent/dist/…`、`~/.dsh` 下内核本体文件）。手改装好的产物看着"立刻生效"，但它不在版本控制里、不被任何人 review，下次 `npm install` / 内核升级 / 换机器就整体消失——功能静默回退，且没有任何报错告诉你为什么。
3. **不许做装后补丁**（在 `postInstall` / installer 里往内核文件上打 patch、注入代码、改 `dist/cli.js`）。这是第 2 条的"自动化版"，比手改更危险：它把"改内核源码"包装成了看起来正规的一步。`KernelSpec.postInstall` 只允许做**非源码**的准备工作；历史上的 fork position / entry_appended 运行时补丁已因此退役（见 `src/server/kernel/pi/manager/pi-kernel.ts` 注释）。

**内核侧缺能力，唯一合法通道是内核插件**——写扩展，不写对方核心：

- **pi**：TypeScript 扩展，源码放 `packages/my-harness-fit-pi-extension/`（统一适配）或壳插件自己的 `pi-extension/`，由 installer 同步进 `~/.pi/agent/extensions/<id>/`。pi 的 loader 在 spawn 时扫这个目录，扩展装进进程即为内核补能力。
- **dsh**：Cordis 插件，同步进 `~/.dsh/.my-harness-desktop-plugins/<id>/`，并在 `cordis.yml` 挂一个固定 id 的块（`DshConfigSource.addPlugin` / `syncFitDshExtension`）。
- **marker 纪律**：我们只碰自己带 marker（`.my-harness-desktop-plugin`）的目录，摘除/对账不越界，不覆盖用户手装的同名目录。这是"只写扩展"在物理层面的落点——我们的写入范围被 marker 圈死在内核的插件目录里，碰不到内核本体。

为什么这么绝对？内核是**被壳管理的外部资源**（§6.4），它的价值恰恰在于它是别人持续演进的东西：上游一升级，我们的补丁要么被覆盖、要么与新内核冲突，而冲突的排查成本远高于当初写一个插件。插件通道是内核作者提供的**稳定扩展点**——它随内核版本演进，改内核源码不会。这也是 §7.6 三分法里"补面"的实现形态：补面 = 写内核插件，不是 = 改内核。

- **判别气味一：diff 落在内核包/内核仓库里**。`node_modules/@earendil-works/pi-coding-agent/**`、外部 harness 仓库、`~/.dsh` 本体文件出现改动 → 违规，回滚并改写成插件。
- **判别气味二：installer 里有"读内核文件 → 字符串替换 → 写回"的逻辑**。这就是补丁，不管它注释里写得多"必要"。
- **判别气味三：为了绕开内核的限制而在壳里造一套影子实现**（比如自己重写内核的会话文件格式）→ 违反 §3.1「消费而非翻译」，同样违规。
- **正确做法**：能力缺失 → 先问内核有没有扩展点（pi extension API / dsh cordis plugin）；有 → 写插件（`src/plugins/{domain}/{feature}/pi-extension|dsh-extension`，§7.7 四件套）；确实没有扩展点 → **显式降级**（隐藏/置灰入口 + tooltip），或向上游提 issue/PR，而不是自己动手改。

## 2 什么可以放在壳里，什么不可以

判断标准只有一条：**一年后这东西会不会换。会换就推出去，不会换才留在壳里。**

### 2.1 可以放的：稳定不变的、拿掉它系统就不能启动的

能放在壳里的东西，必须同时满足两个条件：它不会在可预见的未来被替换，以及拿掉它系统就不能启动。

- **加载器**。壳插件加载器是壳的心脏——没有它，一切壳插件都挂不上来，系统空转。留在壳里。
- **槽位契约**。槽位是壳和壳插件之间的接口定义。"有槽位契约"这件事不会变，留在壳里。
- **中立契约**。`BaseBackend` 的意图集合（六条核心 + 命名/思考档位设置/seed/工具发现/提问/能力探测；续跑不是意图——续跑=发消息）是壳和内核之间的接口定义。契约的形状可能随版本演进，但"壳只认一份中立契约、内核各交一个适配器"这件事不会变，留在圆心（`packages/shared/src/domain`）。
- **权限沙箱**。壳插件是不可信代码，壳必须提供隔离和权限校验。留在壳里（安全策略的具体实现分布在各层，见 §4.6）。
- **生命周期管理**。壳插件的 activate/deactivate/dispose，配置文件的读写和锁——留在壳里。
- **事件总线**。壳和壳插件之间、壳插件之间的消息通道。留在壳里。

### 2.2 不可以放的：会变的、可被替换的、功能性的

不能放在壳里的东西，只需满足一个条件：它会变，或者它可以被替换。

- **文案** → 语言插件。**配色** → 主题插件。**管理页** → 对应管理插件。**业务分支**（"如果工具名是 bash 就渲染成终端"）→ 渲染插件。
- **内核的会话存储**。今天 pi 是 JSONL 文件 + `parentId` 树，dsh 是 append-only 日志 + session forest。存储格式退进内核后端，壳只认不透明 `sessionId` 和 `LineageTree`。
- **内核的协议适配**。今天 pi 走 JSONL（`RpcCommand` 联合 29 命令，`src/server/kernel/pi/protocol/` + `backend`），dsh 走 JSON-RPC（`src/server/kernel/dsh/protocol/`）。协议契约（消息格式、命令枚举）留在各自的协议层，传输实现（spawn、stdin/stdout）推到 `src/server/kernel/{kernel}`——换内核只换适配器，圆心一行不改。
- **内核的专属能力**。多路并发（`steer`/`followUp`）、命令直投（`bash`）、上下文压缩、系统提示承接（`systemPrompts` 槽）等——不进中立契约，而是按**语义轴**收成圆心的 `BackendCapabilities` 各面（`steering`/`retry`/`compaction`/`snapshot`/`stats`/`modelCycle`/`toolExec`/`busFrames`/`questions`/`thinking` + `fileBacked` + `systemPrompt`），壳逐轴探测"有则用、无则降级"。思考档位的**设置**（`setThinkingLevel`）已进契约（docs/design/atomic-send.md），档位清单/循环切换仍是 pi 扩展面。

### 2.3 判据：一年后这东西会不会换

答案只有两种：会换，推出去；不会换，留在壳里。没有"大概不会换""暂时不换""应该不换"——这些犹豫都是推出去的信号。

- **"这个以后可能会加一种新形态"** → 会换，推出去。
- **"这个现在只有这一种，但理论上可以有别的"** → 会换，推出去。**内核是这句话的典型**：pi 曾经是唯一，dsh 证明"内核"是一个抽象、pi 只是其一。
- **"这个虽然不变，但拿掉它系统也能跑"** → 可选的，推出去。
- **"这个拿掉系统就不能启动，而且不会换"** → 留在壳里。

## 3 原发原理：为什么这么做

### 3.1 消费而非翻译

不要把自己定位成别人的翻译层。正确姿势是主动消费对方吐出的数据，自己决定怎么呈现。对方吐的是结构化数据，你拿到数据后自己画——用什么组件、什么布局、什么交互，是你的事，和对方无关。这是单向的、你主动的消费，不是双向的、被动的翻译。

**多内核下这条原则有一条关键边界**：适配器的"翻译"是允许的、必要的——它是把一种数据格式转成另一种数据格式（pi 的三态事件 → 中性事件、dsh 的 `assistant/chunk` 增量 → 中性事件），是协议翻译。要禁止的是**UI 翻译层**和**"让 dsh 装 pi"的翻译层**：让 dsh 重新实现 pi 的会话文件、parentId 树、pi 命令集，等于让 dsh 假装自己是 pi，真长处全被埋掉。正确的做法是：两边都投成同一套中性事件，壳只认中性事件。

### 3.2 构造与执行分开

怎么拼和怎么发是两件事。Assembler 管构造，Gateway 管执行。这条边界一旦守住，两侧独立演化——换 provider 不影响构造逻辑，改构造策略不影响执行流程。

- **判别气味**：一个函数既构造又执行——既拼了请求又发了请求。这个函数该拆成两个：一个返回构造结果，一个接收构造结果并执行。
- **本项目的落地**：`session-store` 不再拼 `--session`/`--append-system-prompt`/`--no-session`，改传中性 `BackendCreateOptions`（构造）；内核专属 args 的拼装收进 `src/server/bootstrap/assemble.ts` 的工厂闭包（执行）。`RpcAdapter` 构造命令对象但不 spawn 进程，`subprocess-lifecycle` 管进程生命周期——两者经 `SubprocessHandle` 接口连接。

### 3.3 框架管通用，特化归外层

多个调用方都要做的事，说明这个逻辑应该收进框架统一承担，而不是让每个调用方各写一遍。判断方式：如果多个调用方传入的回调逻辑大同小异，差别只在参数，那它就是一个逻辑的多次复制——该收敛到框架一个实现，调用方只传参数。

- **本项目的具体落地**：save/dirty/config/拦截/刷新收敛为框架驱动；组件注册、pluginId 注入、事件 channel 注册收敛为框架自动。**多内核下同理**：pi/dsh 共用的"装/查/状态合成"机制收进 `KernelManager` 基类，差异（包名/路径段/装后补丁）只是 `KernelSpec` 数据 + `postInstall` 钩子——不该每个内核各写一遍版本管理。

什么时候不该收敛？当多个调用方的逻辑真的不同时。判断标准不是"它们看起来差不多"，而是"它们的差异是参数级的还是行为级的"。参数级——收敛，传参数。行为级——不收敛，各自保留。**pi 和 dsh 在会话模型、事件形状、fork 语义上处处相反，这些行为级差异不能硬塞进基类共享**——该抽象成 abstract 方法，各自 override。

### 3.4 依赖倒置连通内外

需要跨层协作时，接口定义在内层、实现在外层。内层依赖抽象，外层提供实现，启动期注入。换运行时只换实现，内层一行不改。

这和"别造接口包已有东西"不矛盾。区分在于：这个接口是内层业务本质的抽象（要），还是为包一个已有实现而加的 wrapper（不要）。前者：内层声明"我需要一个能发消息/中断/切模型/分叉/读 lineage 的后端"——这是业务本质的抽象（`BaseBackend`）。后者：外层已经有一个 `DshConfigSource` 类，你给它包一层 Wrapper 然后让内层 import 这个 Wrapper——这是多余的间接层。

- **本项目的落地**：`session-store` 不 `new PiBackend()`，而是持 `BackendFactory` 接口（圆心契约）。`KernelManager` 不 `spawn("npm")`、不 `fetch` registry，而是持 `KernelRuntime` 接口。接口定义在圆心/application，实现在 `src/server/kernel/{kernel}`、`src/server/client/npm`，组装在 `src/server/bootstrap`。换内核只换实现，application 和 domain 一行不改。

### 3.5 手写收敛到成熟包

不重复发明轮子。手写的版本比较、类型解析、拖拽、右键菜单、深合并、UUID 生成——这些都是 bug 温床。成熟包经过千锤百炼，收敛掉。自己写的代码每一行都是自己背的债。

### 3.6 事件驱动，不轮询不 sleep

性能是架构问题不是补丁。用事件驱动替代轮询和固定延迟。固定 sleep 是对时序竞争的赌注，轮询是在空转。事件驱动是正解：有一个数据源，它变了就推给你，没变就不打扰你。组件只读 store、零拉取，基线 + 事件增量应用。冷启动时不用 sleep 猜就绪时间，而是向内核发一条探测命令，以探测结果为准。

### 3.7 根因修复，不打补丁

定位真因再修。补丁让下一个 bug 在别处冒出来。每个 fix 标注根因——是哪个闭包旧值、哪个时序竞态、哪个 useEffect 没重跑、哪个 IPC 监听器没返回清理函数。治标的特征：改完能跑，但没人说得清为什么。治本的特征：改完能说清根因是什么、为什么之前的代码会触发这个根因、为什么改完后不会再触发。

根因修复的闭环不是"改完能跑"，是**留下守卫**。每个根因修复必须同时落地一个回归守卫——单元测试、静态检查、lint 规则、guard 脚本，按 §4.5 的可测性判据选位置（纯逻辑补单元测试，配置/路径/扫描清单补静态守卫）。没有守卫的修复只是"这次对了"，下一次重构就回潮：Tailwind `@source` 扫描 7/29 修过（`f35c0bc`），8/27 前后端分离后原样复发（`ae7c91c`），根因就是第一次只修没守；补上静态守卫（`1a2a91b`）之后才真闭环。

- **判别气味一：同一症状的第二次修复**。修完又发作，说明上一次修的不是根因。第二次修复必须停下来先做根因定位，禁止在同症状上叠第三个补丁。stickers 图片刷新消失曾一天连修四次（`8f7dff9`→`3e081b1`→`d6c2776`→`2411f85`），提交措辞从"终极兜底"升到"终极根因"、次日才到"真凶"（`fd3cf32`）——措辞一路升级本身就是"一直在打补丁"的确证。
- **判别气味二：fix 标题里的升级措辞**。"终极""再次""彻底""真凶"出现在标题里，是前几次修复未达根因的事后签名。标题越激动，越要怀疑根因没找着。

## 4 分层的纪律

### 4.1 为什么分层

不分层的系统会熵增到不可维护。分层不是美学偏好，是变更隔离的工程需要：把"会变的"和"不变的"分开，让变化被控制在局部，不扩散到整个系统。

### 4.2 圆心是什么

圆心是"拿掉所有会变的东西之后还剩什么"。换了内核、换了框架、换了协议之后，你的系统里还剩下什么不会变？那就是圆心。

- **槽位契约**：系统有哪些槽、每个槽的形状是什么——换什么技术栈都不会变。
- **中立契约**：`BaseBackend` 意图集合（六条核心 + 命名/思考档位设置/seed/工具发现/提问/能力探测；续跑不是意图——续跑=发消息）、`KernelId`、`LineageTree`——换哪个内核都不会变，变的只是适配器。
- **中性类型**：事件、配置、模型、lineage 的类型定义——不依赖任何框架、任何库、任何内核，纯 TypeScript 类型。
- **纯函数**：不碰 IO、不碰环境、不碰状态的函数——输入到输出的映射，无副作用。

判断一个东西是不是圆心，用"换壳测试"：如果明天把 pi 换成 dsh、把 Electron 换成 Tauri、把 React 换成 Vue、把 SQLite 换成 PostgreSQL，这个东西还在不在？还在，它是圆心；不在了，它是外层。中立契约在——不管内核是 pi 还是 dsh，"发消息/中断/切模型/分叉/读 lineage"这六条不变。pi 的 `steer` 不在——它是 pi 专属，换成 dsh 就没有了。

### 4.3 外层是什么

外层是"今天用这个、明天可能换那个"的会变细节。

- **内核实现**：pi、dsh——换内核只换 `src/server/kernel/{kernel}` 的适配器。
- **进程管理**：spawn、kill、进程间通信——换运行时就换实现。
- **Web 框架**：React、Vue、Svelte——换框架只动渲染层。
- **数据库驱动**：better-sqlite3、JSON 文件、远程存储——换存储只动存储适配层。
- **第三方 SDK**：git、文件系统、npm registry——换 SDK 只换 `src/server/client/` 层。

外层的变化频率应该很高——不是因为它们不稳定，而是因为它们本来就是"可以换的"。今天 pi 明天可能 dsh、后天可能第三个内核。这些变化不该影响内层。

### 4.4 依赖方向的几何表达

洋葱架构不是某个具体技术，是"依赖方向"的几何纪律。想象一个同心圆：最里面是圆心（最稳定的业务本质），向外逐层是会变的细节。依赖箭头永远指向圆心——外层可以依赖内层，内层绝不依赖外层。

跨层协作靠依赖倒置：内层拥有抽象接口，外层提供实现。内层说"我需要一个能发消息/中断/分叉/读 lineage 的后端"，外层提供具体实现（PiBackend、DshBackend）。内层不知道也不关心具体实现是什么，它只依赖接口。

这个几何纪律的推广形态是"构造在内、执行在外"——组装逻辑在内层（它是业务本质），执行逻辑在外层（它是会变的细节）。

### 4.5 新增功能先问归属哪层

写代码之前先问：这个逻辑是业务规则（内层）、用例编排（中层）还是基础设施（外层）？放错层就是技术债。

- **业务规则**："一个会话可以有多条 lineage""一个内核交一个适配器"——放圆心（`packages/shared/src/domain`）。
- **用例编排**："用户点保存时先校验再写文件再通知 UI""切换内核时 seed 旧历史再起新后端"——放中层（`src/server/application`）。
- **基础设施**："用 spawn 起内核子进程""用 JSON-RPC 和 dsh 通信""用 better-sqlite3 存数据"——放外层（`src/server/kernel/{kernel}`、`src/server/client/npm`）。

判断不清的时候，用"一年后会不会换"做判据。还有一个更实操的判断方式：这个东西的单元测试需不需要 mock 外部环境？需要 mock 的（文件系统、网络、进程、时间），说明它碰了外层——该把依赖的部分推到外层去。不需要 mock 的（纯类型、纯函数、纯数据结构），是内层材料。

### 4.6 安全和会变的细节推到外层

权限校验、敏感字段过滤、进程隔离、凭证保护——这些安全动作是会变的策略，不是稳定的业务本质。所以安全动作按"依赖只向内"推到外层：进程隔离在 `src/server/kernel/{kernel}`，权限校验在 `src/server/controllers/` 网关边界，敏感字段过滤在协议翻译层。圆心只留中性契约——它不知道也不关心"这个内核/插件有没有权限"，它只描述"壳和内核、壳和插件交互的中性接口"。

## 5 开发节奏

### 5.1 设计先行

先写设计文档，再搭骨架，最后填代码。不是事后补文档——文档驱动代码，不是代码驱动文档。设计文档是真相源，代码是落地展开。骨架先行：先建空目录，让目录自己解释"这层装什么"。

### 5.2 搞前端先 bash 打印设计图

做 UI 之前，先用 bash 把设计稿打印出来看一眼。目的是在写第一行 CSS 之前，先确认"我理解的设计"和"实际的设计"是一致的。这一步省掉的话，后面写了三百行 CSS 发现间距/字号/配色全理解错了，全部推翻重来。

### 5.3 定期熵增清理

每做完一阶段功能，回头对照设计逐条审查偏离。清理时分级处理：**架构问题**（依赖方向反了、层间越界、契约漂移）立即修；**stale 标注**（注释说的和代码做的不一致）立即更；**已知缺口**（明确知道还没做的）显式标注"演进"，不藏。清理的产出是一份编号清单（H=安全/架构、M=不一致/stale、L=改进建议），每条标注处置（立即修/演进/不修）和理由。这份清单是下一次清理的基线。

清理范围不限于代码与注释，还包括**仓库卫生**：运行时数据有没有误提交进 git（用户目录配置/日志必须在 .gitignore 且历史干净——`.pi-desktop/` 用户数据曾被误提交入库，靠 `8bd80ce` 才清出）；大二进制资产是否多版本累积（只留最终态或移出 git，demo GIF 曾把 .git 撑到 152MB）；已合并分支 / 陈旧 worktree / 过期 stash 是否堆积（曾同时挂 13 个已合并 worktree）。卫生项同样进编号清单，与代码项同级处理。

### 5.4 提交即文档

每个提交自解释：改了什么、为什么改、架构依据、运行时验证。一个合格的 commit message 包含四个要素：改了什么（一句话）、为什么改（根因修复/架构对齐/性能优化/新需求）、架构依据（对应设计的哪条原则）、运行时验证（功能路径实测、测试通过、边界覆盖）。

第四要素里，**"build 通过"不算运行时验证**——编译只证明类型与语法正确，不证明功能活着。8/26 前后端分离的五个阶段提交条条 build 通过，合完即黑屏，48 小时补了约 20 条 fix(web)（WS 帧序竞态、引导时序、Tailwind `@source` 漂移……）。UI 与链路改动必须附真实运行证据：启动后的界面/功能路径实测（CDP / Playwright / e2e 脚本），不能只写"build 通过"。测试与代码同行：新逻辑不带测试、修复不带守卫（§3.7），都是把验证成本推给未来——首个测试套件在开工第 10 天才落地，前 10 天的功能全部裸奔，这个窗口不该再出现。

### 5.5 分阶段重构：逐阶段验证，不先合后灭火

大重构允许分阶段提交（"完整设计，一次落地"已界定：每个交付物自身完整），但每个阶段必须**独立通过运行时验证**再进下一阶段，不攒到全部合完再统一验证。"先合阶段、后灭火"把验证成本压到收尾，一旦黑屏，五个阶段的改动同时在嫌疑名单上，定位成本翻倍；逐阶段验证，每次只有一个阶段的改动在嫌疑名单上。对照组：8/01 大分区重构（文档同批同步、当日平稳）与 8/26 前后端分离（先合五步、灭火两天）——差异不在拆分本身，在逐阶段验证与文档同步。

结构重构（目录搬迁 / 分区调整 / 改名 / 发布面迁移）另有两条随批义务：

- **文档同批同步**：目录树、路径引用、CLAUDE.md 与 docs/ 随代码改动同一批落地，不留"代码已搬、文档照旧"的漂移窗口。
- **历史守卫回归**：合并前主动跑一遍历史上已修同类 bug 的守卫（§3.7）——重构是已修 bug 回潮的高发场景，守卫清单就是为此准备的；守卫没覆盖到的历史修复点，趁这次重构补上。

### 5.6 干到结束为止 + 三级测试（unittest / DOM 交互 test / e2etest）

**做一下就停 = 没做完。** 一个任务的完成定义不是"代码写完了"，是"**行为验证过**"：每个修复/功能都必须带着它的验证证据一起交付，不准把"应该没问题"当结论。任务结束的唯一判据：三级测试里该覆盖的层都覆盖且全绿 + 真实运行证据（能起 app 的功能改动必须起 app 验过）。

**三级测试的分工与写法**（工具链都已就位，不许再说"没法测"）：

1. **unittest（纯函数/纯逻辑单测）**——`npx vitest run <file>`，node 环境（`vitest.config.ts` 默认）。
   - 测什么：圆心纯函数（`packages/shared/src/domain/`）、归约器（如 `goal-reduce.ts`）、翻译器（如 `dsh-event-translator.ts`）、状态机、解析器。特征：不需要 mock 外部环境（§4.5 判据）。
   - 怎么写：输入 → 输出断言，一个行为一个 `it`，标题写清业务语义（"轮数上限：round 达到 maxRounds 后不再续跑"这种，不写 "works correctly"）。
   - 范例：`src/server/kernel/dsh/backend/dsh-event-translator.test.ts`、`src/plugins/sessions/goal/core/goal-state.test.ts`。

2. **DOM 交互 test（组件/用户交互）**——vitest + jsdom + `@testing-library/react`，文件首行 `// @vitest-environment jsdom`。
   - 测什么：插件 UI 组件的真实 DOM 交互——渲染出的元素、点击/键入/提交、状态翻转、DOM 锚点（`data-*`）。
   - 怎么写：`render(<Comp/>)` → `screen.getByRole/getByTitle/getByText` 查元素（**按角色/文案查，不按 class 查**）→ `fireEvent.click/change/keyDown` 真实交互 → 断言 DOM 结果。`usePluginContext` 用 `vi.mock("@my-harness-desktop/react")` 给机制面（onEvent/prompt/updateHeader），`useTranslation` 用 `vi.mock("react-i18next")` 给真字典（断言跑真文案，不断言 key）。i18n 文案改动时测试跟文案一起改，不许为过测试而软化断言。
   - 范例：`src/plugins/sessions/goal/renderer/goal-bar.test.tsx`（删改停全链路 DOM 对账）、`src/plugins/sessions/ask/renderer/ask-question-card.test.tsx`（提问点选/多选/自定义输入）。

3. **e2etest（真实 app 端到端）**——`scripts/demo/*.e2e.mjs` / `scripts/verify-e2e.mjs`，puppeteer-core + CDP 驱动**真实构建产物**（`out/`）+ 隔离 HOME。
   - 测什么：跨进程全链路——真实输入框敲字、真实内核起停、真实事件流、真实 DOM 呈现。jsdom 测不了的（虚拟列表、CDP 时序、真实内核事件）都在这里验。
   - 怎么写：参考 `scripts/demo/goal-command.e2e.mjs`——`launchApp` 拉起 → `page.keyboard.type` 真实键入 → `page.waitForFunction` 轮询断言（**不赌固定 sleep**，事件驱动等 DOM 落位）→ 每步截图留证 → 失败留诊断现场。需要"不花真 token"时覆写 models.json 为空清单（快速失败路径也是真实路径）。
   - 什么时候必须写：涉及内核进程/真实发送/多窗口的改动。跑法：`npm run build && node scripts/demo/<name>.e2e.mjs`。

**测试静默：跑测试不得抢占用户窗口与焦点**（用户坐在同一台机器上，这是硬纪律不是礼貌）：

- **窗口永不 show**：所有拉起 electron 的脚本都过 `scripts/demo/lib/quiet-env.mjs`（默认 `MHD_WINDOW=hidden`）；应用侧由 `src/server/bootstrap/window-visibility.ts` 分岔——hidden 时**不 show、不可聚焦、不进任务栏、不设 dock 图标、不弹系统通知**。要看窗口人工观察：`MHD_WINDOW=shown node scripts/demo/<某剧本>.e2e.mjs`。
- **为什么可以隐藏着测**：e2e 要的是 CDP（JS 求值 / `Input.dispatchKeyEvent` / `Page.captureScreenshot`），**都不依赖窗口可见**；`launchApp` 的 `page.keyboard.type`、`page.click` 走 CDP 注入，不需要窗口持有系统焦点。唯一要小心的失败模式是"隐藏窗口不渲染/截图全黑"，所以静默态强制 `backgroundThrottling: false`，并由 `scripts/demo/quiet-launch.e2e.mjs` 当真 app 级守卫（前台 App 不变 + 隐藏窗口照样渲染、照样收输入）。
- **守卫**：`npm run audit:quiet`（静态：凡 spawn electron 的脚本必须过 quiet-env；开窗代码不得回到无条件 `win.show()`）＋ `window-visibility.test.ts`（unittest：hidden 策略与非法值抛错）＋ `scripts/demo/quiet-launch.e2e.mjs`（e2e：真实前台 App 不被抢）。
- **反面**：为了"看着方便"在测试里 `win.show()` / `showInactive()` / 弹系统通知——用户正在打字的窗口失焦、鼠标被夺走，是每次验证都在打扰用户。人工要看画面时走 `MHD_WINDOW=shown` 显式授权，不写成默认。

**纪律收口**：修复一个 bug = 定位根因 + 修复 + **补一条能复现该 bug 的守卫测试**（§3.7）。三级里没有"这层没法测"——纯逻辑补 unittest，UI 行为补 DOM 交互，全链路补 e2e。提交信息里写清跑了哪几级（§5.4 第四要素）。

---

## 6 洋葱分区：多内核的分层执行

前五节讲的是通用原理。从这一节开始，落到 my-harness-desktop 这个具体项目——原理怎么变成物理目录、怎么变成代码纪律、怎么变成可检验的规则。

### 6.1 物理目录分区

源码按"圆心 + 壳后端 + 前端"分区（前后端分离后，旧的 `core/` + `api/` + `client/` + `bootstrap/` 已重构归位），目录自己解释"这层装什么"：

```
src/
  server/            # 壳后端（原 core/application + api/ipc + client + bootstrap 归位）
    application/     #   用例编排：loader/registry、sessions/session-store、models、i18n、skills、theme、config、lifecycle、restart、installer、bundled、extensions
    kernel/          #   内核层（原 client/{pi,dsh} + client/backend 上提）
      core/          #     AbstractBackend 抽象基类 + KernelManager 基类 + KernelRuntime + KernelReconcile（骨架/机制，不 import 具体内核）
      pi/            #     pi 内核：backend/（PiBackend+catalog+correlator）protocol/（RpcCommand 联合 29 命令契约）manager/ model/ extension/
      dsh/           #     dsh 内核：backend/（DshBackend+catalog+event-translator+**backend-factory**）protocol/（json-rpc + dsh-methods）manager/ extension/
      minimal/       #     minimal 内核（测试专用，manifest 在 test-plugins/）：backend/（含 **backend-factory**）manager/ kernel/
      probe4/        #     probe4 内核（测试专用，manifest 亦在 test-plugins/；"接第四内核"的实证克隆）：backend/ kernel/ manager/ plugin.ts
                     #     ⚠ 曾有 factories/（kernel-factories + kernel-managers + kernel-logos）把三个内核绑在一个共享文件里，
                     #     已删除：共享装配点让「删掉一个内核目录会牵连其它内核编译」，检验⑧扫不到这条**传递**依赖。
                     #     现在每个内核的后端/目录工厂住在自己目录（<id>/backend/<id>-backend-factory.ts），
                     #     logo 由 KernelPlugin.logo 经 buildKernelSurfaces 投影（不再有静态表）。守卫：audit 检验⑪。
    client/          #   流出适配器：fs/、git/、npm/、remote/
    controllers/     #   网关 handler（原 api/ipc/，按能力域分文件：sessions/config/kernel/plugins/fs-git/remote…）
    transport/       #   HTTP + WS（前后端分离新增）：http-server + ws-server
    host/            #   Host 接口实现（新增）：electron-host + node-host
    remote/          #   远程访问鉴权（新增）：auth + remote-config
    routing/         #   gateway + broadcast
    bootstrap/       #   组装根：assemble.ts（共享组装）+ electron.ts / server.ts（双入口）
  web/               # 前端 renderer（原 api/renderer/）：app/、components/、kernel/、stores/、transport/、ui/
  plugins/           # 内容层：内置壳插件；按域分组（themes/sessions/project/insight/manager/system/**kernels**）
                     #   kernels/<id> = 随壳分发的内核插件（一个内核一个插件：kernel 块 + renderer/ + locales/）
packages/
  shared/            # 圆心发布面（原 packages/contract/ + core/domain/ 合并）：src/domain/（纯类型+纯函数零依赖）+ channel/ + contract/ + wire/
  react/             # 发布面（有 package.json）：React 组件/hooks/事件总线 + PluginContext
  my-harness-fit-pi-extension/   # pi 内核的桌面适配扩展（统一入口，含 toolgate/context-probe/bus/subagent/skills 五能力；非发布面，经 kernel/pi/extension 安装器同步进内核）
.claude/skills/    # 内置 skills 源（仓库顶级职业技能目录，随壳分发）
assets/            # 外层资产：随壳分发/使用的一切非代码文件
scripts/           # 开发环境引导脚本
test-plugins/      # 测试专用插件（kernels/minimal + kernels/probe4）：**不在任何生产扫描根里**，只有测试把它种进
                   #   隔离 HOME 的用户插件目录才会装载（结构性杜绝"测试内核在真实项目留下幽灵会话"）
```

这不是逻辑约定，是物理隔离。`packages/shared/src/domain/` 目录下没有 `node_modules` 里任何包的 import——物理上做不到。`src/server/application/` 里没有对 `kernel/{pi,dsh}` 具体实现的**非 type-only** import。`src/server/kernel/` 里没有 React 组件。目录结构本身就是第一道防线。

**内核层的位置**：`src/server/kernel/pi` 和 `src/server/kernel/dsh` 是洋葱里同一层（内核层）的两个实现，与 `src/server/client/fs`、`git`、`npm` 并列——内核和 git、文件系统是同一层抽象，都是"被壳管理的资源"，都经依赖倒置接入。pi 不再有专属协议特权：pi 的协议契约在 `src/server/kernel/pi/protocol/`（纯部分），dsh 的协议契约在 `src/server/kernel/dsh/protocol/`（json-rpc.ts + dsh-methods.ts，方法名已收敛为 `DSH_METHODS` 常量枚举——这是"dsh 方法单源"已落地的收尾，见 §10 QA）。"流入/流出"按**发起方向**分：内核连接是双向的（命令出、事件入），但它是应用驱动的外部资源——我们 spawn 它、持有它、kill 它——所以执行件（rpc-adapter、json-rpc、subprocess-lifecycle）都归 `src/server/kernel/{kernel}`。

### 6.2 每区的装与不装

**`packages/shared/src/domain/` 圆心**——装：槽位契约（contribution 类型）、中立契约（`KernelId`、`BaseBackend`、`BackendFactory`、`BackendCreateOptions`、`KernelModelSource`、`LineageTree`、`NeutralAnchor`）、中性事件类型（`SessionEvent`、`NeutralMessage`、`ModelInfo`）、会话/主题/配置/宿主（`Host`）的类型定义、纯函数。不装：任何 import（零依赖）、任何 IO、任何环境感知、任何框架、任何内核实现。

当前 `packages/shared/src/domain/` 里的内核相关文件：`kernel.ts`（`KernelId = string`——不透明 id，去字面量化；内核 id 由各内核插件自声明、清单由 `KernelRegistry` 运行时驱动；曾经的 `KERNEL_IDS` 字面量数组已删）、`backend.ts`（`BaseBackend`/`BackendFactory`/`BackendCreateOptions`/`KernelModelSource`/`LineageTree`/`SessionCatalog`）、`kernel-manager.ts`（`KernelSpec` 纯数据契约）、`session-neutral.ts`（`NeutralSession`/`neutralEntryId`/`lineageContent`）。其余是槽位契约（`contributions.ts`）、会话类型、事件类型、宿主接口（`host.ts`）、技能契约、字体预设、扩展管理、布局类型——全是类型定义和纯函数，没有一个 import 外部包。

**`src/server/kernel/{pi,dsh}/protocol/` 协议契约（各内核专属）**——装：各内核的协议契约纯部分——pi 侧 `rpc-types.ts`（pi 消息类型）、`commands.ts`（pi 命令构造纯函数）、`event-translator.ts`（pi 事件 → 中性事件）、`context-binding.ts`（pi RPC 对象 → domain 类型映射）、`versions.ts`；dsh 侧 `json-rpc.ts`（JSON-RPC 2.0 行传输）、`dsh-methods.ts`（`DSH_METHODS` 方法名常量枚举——"dsh 方法单源"已落地）。不装：传输实现（spawn/stdin/stdout 在同内核的 subprocess-lifecycle）。**终态已落地**：两边协议面各归各的内核目录，语义上都是「内核专属形状，壳只认中立契约」。

**`src/server/application/` 用例编排**——装：插件加载器（loader/registry）、配置读写、会话管理（session-store 只依赖 `BaseBackend` + `BackendFactory` 接口）、主题合并、i18n 合并、模型合流（`ModelCatalog` 只依赖 `KernelModelSource` 接口）、技能聚合（skill-aggregator）、生命周期、重启协调（restart-coordinator）。不装：UI 组件、进程管理、框架特定 API、任何具体内核实现。

**`src/server/kernel/` 内核层（流出适配器，内核在此）**——装：内核的 backend/catalog/protocol/manager/model/extension 全部实现。`core/` 是骨架（`AbstractBackend` 抽象基类 + `KernelManager` 基类 + `KernelRuntime` 接口 + `KernelReconcile` 冷启动对账），只 import `packages/shared`，绝不 import `pi`/`dsh` 具体实现。不装：UI、业务编排（那是 application）。

- `src/server/kernel/pi/`：`backend/pi-backend.ts`（`PiBackend extends AbstractBackend` + `implements` 九个中性能力面接口）、`backend/pi-catalog.ts`（`PiSessionCatalog implements SessionCatalog`）、`backend/correlator.ts`、`backend/subprocess-lifecycle.ts`、`backend/pi-backend-factory.ts`（后端与目录工厂，**归 pi 自己**）、`protocol/`（RpcCommand 联合 29 命令契约）、`manager/pi-kernel.ts`（`PiKernelManager extends KernelManager`）、`manager/pi-kernel-api.ts`/`pi-kernel-config.ts`/`pi-logo.ts`、`model/`（models-store/pi-settings-store/pi-model-source）、`extension/`（各扩展安装器 + skill-provider + oneshot）。
- `src/server/kernel/dsh/`：`backend/dsh-backend.ts`（`DshBackend extends AbstractBackend`）、`backend/dsh-catalog.ts`（`DshSessionCatalog implements SessionCatalog`）、`backend/dsh-event-translator.ts`（dsh 事件 → 中性事件）、`backend/dsh-config-source.ts`（cordis.yml + settings.yaml，`implements KernelModelSource`）、`backend/subprocess-lifecycle.ts`、`protocol/json-rpc.ts` + `dsh-methods.ts`、`manager/dsh-kernel.ts`（`DshKernelManager extends KernelManager`）、`manager/dsh-kernel-api.ts`/`dsh-kernel-config.ts`/`dsh-logo.ts`、`extension/`（dsh-extension-installer/manager + skill-provider + question-bridge）。
- `src/server/client/`（fs/、git/、npm/、remote/）：与内核并列的外层适配器。

**`src/server/bootstrap/` 组装根**——装：`assemble.ts`（共享组装）+ `electron.ts`/`server.ts`（双入口）、全部 store/registry/coordinator 的构造、MainContext 注入、**内核注册表**（`kernel/core/kernel-plugin-loader.ts` 扫描并 require 各内核的 `plugin.js`，工厂把 `BaseBackend` 接口和该内核的实现绑起来；`kernel-surfaces.ts` 把注册表投影成壳需要的全部中性面，含 logo）。组装根**不 import 任何具体内核**——它只认 `KernelPlugin` 契约（曾有 `kernel/factories/` 作为共享装配点，已删除，见 §6.1 目录树与 §6.3 检验⑥）。不装：任何一个具体 handler 的实现、任何业务规则。目标极薄——组装代码是"怎么拼"，不是"怎么干"。

**`src/plugins/` 内容层（壳插件）**——装：一切功能，按域分组（themes/sessions/project/insight/manager/system/kernels）。不装：机制实现、跨层 import、任何内核的存储格式/事件形状/插件树。

**`src/plugins/kernels/<id>/` 内核插件**——「一个内核 = 一个插件」（§kernel-plugin）：manifest 里的 `kernel` 块声明内核面（order/enabled），同目录的 `renderer/`+`locales/` 是它的 desktop 对接面，内核实现在 `src/server/kernel/<id>/`。卸载这一个目录 = 内核与它的设置页一起消失。

### 6.3 依赖方向检验

依赖方向只向内，物理检验方式：

- 打开 `packages/shared/src/domain/` 任何一个文件，如果有任何外部包 import——违规。
- 打开 `src/server/application/` 任何一个文件，如果有 `import ... from 'electron'`、`import ... from 'react'`、或对 `kernel/{pi,dsh}` 具体实现的**非 type-only** import——违规（application import 内核具体实现是红线）。
- 打开 `src/server/kernel/core/` 任何一个文件，如果有 `import ... from 'react'` 或对 `kernel/pi`、`kernel/dsh` 的 import——违规（基类/机制不 import 具体内核）。
- 打开 `src/server/kernel/{pi,dsh}/` 任何一个文件，如果有 `import ... from 'react'`、`import ... from '../bootstrap/...'`——违规。
- 打开 `src/plugins/` 任何一个文件，如果有 `import ... from '@/server/...'`、`import ... from '@/core/...'`、`import ... from '@/client/...'`——违规。壳插件只从 `@my-harness-desktop/shared` 和 `@my-harness-desktop/react` 引用类型和 API。

这条检验不依赖任何外部知识，CI 可以自动化——grep 每个目录下的 import 语句，凡是从内层 import 外层的，报警。另外几条多内核专属的 grep 检验（都已落进 `npm run audit:deps`，现在共**十三检验**）：

① 全仓零内核字面量（`KernelId = string` 不透明 id；`"pi" | "dsh"` 联合曾是"收敛到 kernel.ts 一处"的字面量单源判据，插件化后 kernel.ts 自身也不含字面量，判据改为全仓归零）；
② `src/server/application/` 生产代码对 `kernel/{pi,dsh}` 具体实现的 import 归零（**豁免表已清空**，
   不再有"明文例外"）；
③ 内核之间不许互相 import（`kernel/pi` 不 import `kernel/dsh`）；
④ 圆心与壳机制层不许出现 `<内核名>Extension` 形态的**契约字段名**（按内核名分字段 = 加内核要改圆心）；
⑤ **壳机制层（application + bootstrap + kernel/core）生产代码里不许出现内核名字面量** ——
   这一条是 §目标 11 的收口判据，已归零：路径常量（`PI_AGENT_DIR`/`DSH_INSTALL_DIR`）、
   按内核名分字段（`manifest.piExtension`）、以及 `catalogFor("pi")` 这类"机制层写死某内核"
   的形态全部消失。总线工人会话的内核改由**继承父会话**决定（`kernelOfSessionKey`），
   application 因此不需要知道任何内核名。
⑥ **内核目录自包含**（= `scripts/dependency-audit.mjs` 的**检验⑪**；注意本节 ①–⑤ 与脚本 ①–⑪ 是两套不同源的编号：本节①=脚本⑤、②=②、③=⑧、④=⑨、⑤=⑩，脚本另有 ①–④ 的分层 import 检验与 ⑥⑦ 的身份分支/能力名检验）：`src/server/kernel/<id>/` 之外的**生产代码**不许 import 该目录内部 ——
   内核对外只暴露动态 require 的 `plugin.js` 一个面，任何静态 import 都是越界。这条补的是⑧的洞：
   ⑧只扫内核目录**内部**的互引，所以「`kernel/pi/plugin.ts` → 共享 `factories/` → `kernel/dsh/backend/*`」
   这种**传递**依赖从它旁边溜过去了，而它同样让「删掉 dsh 会编译不过 pi」——「内核可整体卸载」变成假的。
   豁免：测试文件（用真实内核实现做夹具是集成测试的正当形状）；生产代码走显式 allowlist，
   每条须写明理由与清理归属，allowlist 长度会被打印以防悄悄变长。**当前为空**——曾有 1 条
   （`session-store.ts` 对 `kernel/pi/backend/pi-backend-extensions` 的 type-only 消费），清空办法不是
   放宽判据，而是把那个 pi 专属 opaque 桶拆成圆心的逐轴中性能力面（见 §1.5 判别气味），
   `pi-backend-extensions.ts` 随之删除。机制层从此不认识任何内核的专属形状。
⑦ **不许用字面量键访问内核的面**（= 脚本检验⑬）：`ctx.kernels.pi` / `kernelConfig["dsh"]` 这类写法。
   为什么单立一条：⑥（脚本⑥）抓的是 `kernel === "pi"` 身份硬分支，而字面量键访问不比较身份、
   直接**取某个指定内核的面**，同样让壳漏内核身份且更隐蔽（读起来像正常取值）。实测三处真实缺陷
   都是这个形态：壳前端发送前问 `kernels.pi.<能力>()` 决定要不要给**当前会话**内联
   工具限制说明（dsh/minimal 会话下拿 pi 的答案）；`tool-manager` 插件报告 `kernels.pi` 的扩展
   可用性，与用户实际在用哪个内核无关；`timeline` 插件用 `ctx.kernelConfig["pi"].get()` 取
   `retry.maxRetries` 当重试折叠条的展示分母（dsh/minimal 会话也按 pi 的设置显示，且 pi 未装时
   `ctx.kernelConfig["pi"]` 是 undefined → `.get()` 抛 TypeError → 被 `Promise.allSettled` 吞掉 →
   静默回落默认值）。前两处改为问**当前会话的内核**（壳侧 `prefs.kernel`、插件侧 `capabilities.kernel`）；
   第三处改为用**内核自己在 `autoRetryStart` 事件里报的 `maxAttempts`**（逐会话逐内核的真实值，
   既中性、又不需要通用插件去懂某个内核的配置 schema）。
   ⚠ **判据必须覆盖整个「按内核键控的面族」**，不能只盯 `kernels` 一个名字：脚本首版只扫
   `kernels.pi|kernels["pi"]`，第三处（`kernelConfig["pi"]`）就从旁边溜了过去。现覆盖
   `kernels` / `kernelModels` / `kernelConfig` / `kernelVersionApis` / `kernelExtensions` /
   `kernelLogos` / `kernelOneshots`（后四个在服务端已改成函数形状，字面量键访问在类型上就不可能，
   仍列进判据以防回潮），并按文件**剥离块注释**后再判（退役说明里引用旧写法是合法的，
   而块注释的中间行既不以 `*` 也不以 `//` 开头，只看行首会误报）。
   豁免：内核自己的插件目录引用自己（`src/plugins/kernels/<id>/` 里的 `<面>.<id>`）——那正是
   「一个内核 = 一个插件」的应有形状。
⑧ **圆心与发布面零内核名前缀标识符**（= 脚本检验⑫）：`packages/shared/src` 与 `packages/react/src`
   的生产代码里不许出现 `Pi*` / `Dsh*` / `Minimal*` 形态的类型名。实测漏网的有
   `DshConfigApi`（还带 `addPluginBlock` 这种 cordis 内部概念）、`DshProvider` / `DshModelSpec` /
   `DshDefaultModel`、`PiSettingsApi`、`SchemaField`——它们的真实消费者**全在各自内核目录内**，
   壳侧 import 经核实是死 import。已全部下移到 `kernel/<id>/` 自己的契约文件；壳只认中性
   `KernelConfigApi`（`get`/`set`/`fields()`，三个内核各自实现）。

### 6.4 四抽象与内核层

多内核架构的四个并列抽象，边界必须钉死：

| 抽象 | 是什么 | 不拥有 / 不做 |
|---|---|---|
| **内核** | 自洽的 agent 运行时（插件树 + 会话模型 + 能力集） | 不出 UI；不知道、也不需要知道自己被托管 |
| **壳** | 槽位/渲染/布局/事件总线的机制 | 不读任何内核的存储格式、事件形状、插件树、fork 语义 |
| **中立契约** | 壳需要内核提供的意图集合（六条核心 + 命名/思考档位设置/seed/工具发现/提问/能力探测，`BaseBackend`） | 不塞任何内核专属概念（`steer` 等不进 `BaseBackend`，改按语义轴进 `BackendCapabilities` 可选面；思考档位**设置**已进契约，清单/轮转是 `thinking` 面的可选成员） |
| **适配器** | 内核专属形状 ↔ 中立契约的翻译，每内核一个 | 不做"让 dsh 装 pi"的翻译层 |

一个内核要"接入"壳，交三样东西：**spawn 命令**（怎么起、起几个、怎么杀）、**适配器**（把专属形状投成中立契约）、**会话模型映射**（把会话落到 lineage 坐标系）。三样齐了，它是"可托管内核"；缺任何一样，它只是"一个能跑的程序"。验收标准：起得来、契约意图逐条有响应（或显式"不支持"）、崩了壳能收尾。

## 7 薄壳与内核无关

### 7.1 两条铁律

**铁律一：壳不内嵌功能性内容。** 打开 `packages/shared/src/domain/` 和 `src/server/application/` 任何一个文件，如果看到一个写死的中文文案、一个写死的颜色值、一段"如果工具名是 bash 就渲染成终端"、或一段 `if (kernel === "pi")` 的内核专属分支逻辑——那就是违规。token key 合规（`theme["color.primary"]`），token 值违规（`"#89b4fa"`）。

（已知偏离，演进待收：`packages/shared/src/domain/slots/theme-tokens.ts` 的 `THEME_TOKEN_DEFAULTS` 兜底色值、`packages/shared/src/domain/sessions.ts` 的 `roleToPrompt` 中文提示，是圆心内容泄漏的历史残留，标注演进。）

**铁律二：内置和第三方、pi 和 dsh 无特权差异。** 删掉任何一个内置壳插件，壳照常启动；复制到用户目录，以更高优先级覆盖。同理，禁掉 dsh 内核，壳照常启动，只是少了 dsh 那份能力；pi 不因"曾是唯一内核"而享有任何特权。

### 7.2 什么进壳，什么不进（在本项目的具体形态）

**进壳**（`packages/shared` 圆心 + `src/server` 机制部分 + `src/web` 渲染机制）：

- 壳插件加载器：发现、校验、注册、生命周期
- 槽位契约：sidebar、sidePanel、mainView、settings、themes、languages
- 中立契约：`BaseBackend` 意图集合（六条核心 + 命名/思考档位设置/seed/工具发现/提问/能力探测，在 `packages/shared/src/domain`）
- 事件总线：壳和壳插件之间的消息通道
- 权限沙箱：进程隔离 + 白名单 scoped API
- 内核装配：`src/server/bootstrap/` 把接口和实现绑起来（机制），不绑任何具体内核的业务逻辑

**不进壳**（推给壳插件 / 内核）：

- 界面文案 → i18n 插件；配色 → 主题插件；管理页 → 对应管理插件；时间线渲染 → timeline 插件
- **内核的会话存储** → pi 后端（JSONL + parentId）/ dsh 后端（session forest），壳只认不透明 `sessionId` + `LineageTree`
- **内核的协议** → `src/server/kernel/pi/protocol/`（pi）/ `src/server/kernel/dsh/protocol/`（dsh），壳只认中立契约
- **内核的专属能力** → 圆心 `BackendCapabilities` 的**逐轴能力面**（"有则用、无则降级"）：多路并发（`steering`）、重试（`retry`）、压缩（`compaction`）、内核实况快照（`snapshot`）、会话统计（`stats`）、模型轮转（`modelCycle`）、命令直投（`toolExec`）、bus 上行帧（`busFrames`）、提问上行（`questions`）、思考档位（`thinking`）。哪个内核有哪一轴由它自己声明，壳与 renderer 逐轴降级——**不再有「某个内核的扩展面」这种袋子**

### 7.3 插件槽位契约

壳预定槽位，壳插件往槽位上挂东西。壳只认槽位契约，不认具体插件。

当前已实现贡献接口的槽位：

- **`sidebar`**：左侧栏（会话列表、项目列表）。
- **`sidePanel`**：右侧面板（会话树、Git review、Context 文件、Run 面板、Token 统计）。贡献项可声明 `revealOn: "<channel>"`，该 channel 被 emit/invoke 时框架展开右面板并激活本 Tab。
- **`mainView`**：中区主视图（timeline 贡献会话消息流）。
- **`titlebar`**：标题栏右侧按钮。
- **`messageRenderers`**：按消息 role/kind 贡献自定义卡片呈现。
- **`fileActions`**：文件上下文动作。
- **`fileIcons`**：扩展名/文件名 → 图标映射。
- **`settings`**：设置页（Pi 管理、DSH 管理、模型管理、主题管理、语言）。
- **`settingsGroups`**：通用设置字段组（纯 JSON 声明，通用渲染器渲成框与控件）。
- **`themes`**：配色方案。**`languages`**：文案包。**`fontPresets`**：字体预设。
- **`messageActions`**：消息行动作按钮（重试、复制、收藏）。
- **`blockRenderers`**：块级渲染槽（工具卡/思考链/气泡/文本/分隔线）。
- **`codeBlockRenderers`**：围栏语言渲染槽（mermaid、puml）。
- **`sessionGroupings`**：会话分组策略。
- **`composerPolicies`**：输入框条件渲染策略。
- **`composerAttachments`**：输入框附件策略（echo 附件徽章等）。
- **`composerActions`**：输入框动作按钮。
- **`composerStats`**：输入框中段状态指示（上下文占用条等，token-stats 插件贡献）。
- **`systemPrompts`**：系统提示槽。壳插件往**当前内核会话** spawn 时注入系统提示文件——实际只有 pi 兑现（`--append-system-prompt`；`capabilities.systemPrompt` 仅 pi 声明 true），dsh/minimal/probe4 **静默缺面**：插件管理页按轴显式降级提示"当前内核不承接"（renderer 门控，§7.6 缺面三分法的"显式降级"），不是"dsh 走 cordis"。

`SlotName` 联合里另有 `management`、`cardRenderers`、`viewers`、`commands` 四个预留名，尚无贡献接口实现。

**槽位渲染是纯函数**：给定同一条中性事件流，timeline 怎么画，与内核无关。壳插件的渲染逻辑里不该出现内核身份分支——内核差异由适配器在事件层抹平，不由壳插件在渲染层抹平。

### 7.4 组件自动匹配

壳插件不手动调 `registerXxxComponent("Name", Comp)` 注册组件。框架加载 renderer module 后，读 manifest 的 `contributes.*[].component` 字段，在 module 的 exports 里找同名组件，自动注册。壳插件只 export 组件，不调任何 register 函数。

### 7.5 内核无关的三条不变量

壳"内核无关"的可检验标准，违反任何一条，壳就偷偷依赖了某个内核：

1. **壳不读任何内核的存储**（pi 的 JSONL 文件、dsh 的 session log，壳都不碰，只认不透明 `sessionId`）。
2. **壳只认中性事件**（内核事件由适配器投喂，翻译器是喂线、不是第二套语义）。
3. **壳的渲染是纯函数**（给定同一条中性事件流，怎么画与内核无关）。

判据：会话意图链路上出现 `if (kernel === "pi")`，或按内核身份取能力面（曾经的 `asPi()`，已退役为按轴取面的 `faceOf()`），就是一处泄漏。

### 7.6 能力拉平三分法

壳看到 pi 和 dsh 的差异，三条出路按优先级：

1. **适配器翻译**（契约层 + 形状层）：内核有"同一个语义、只是形状不同"，就在适配器里翻译。发消息/中断/切模型（契约层硬性拉平），三态事件 ↔ `assistant/chunk` 增量（形状翻译；dsh 侧 token 级流式当前未接，仅 `finish-error` 已接 `messageEnd`），parentId 树 ↔ session forest（lineage 投影）。
2. **内核插件补面**：形状翻译不了的**能力缺失**，给缺能力的内核写内核插件。pi 侧 = 装进进程的 TS 扩展，dsh 侧 = Cordis 插件（`DshConfigSource.addPlugin` 写 cordis.yml）。最小成本是启用现成插件（`dsh-subagent`、`dsh-compaction-basic`）。
3. **显式降级**：写了/启用了插件还拉不平的，壳把该能力入口隐藏/置灰 + tooltip，不静默、不伪造成功。典型：pi 的 `steer`/`followUp`、`onExtensionUI` 在 dsh 下。

判断一个差异该"翻译"还是"补面"，只问一句：内核有没有"同一个语义、只是形状不同"的对应物。有 → 适配器翻译；没有 → 内核补面；补不了 → 降级。

### 7.7 插件开发四件套与「非必要不修改内核」

**一个功能收进同一个壳插件目录**，内部按需四件（高内聚，把功能的所有内核侧适配都内聚在这一个 plugin 下）：

```
src/plugins/{domain}/{feature}/
  locales/          # i18n 文案（desktop UI 文案）
  renderer/         # desktop 壳插件（UI 组件 + 槽位贡献 + 事件）
  pi-extension/     # pi 内核插件（给 pi 补能力的 TS 扩展）
  dsh-extension/    # dsh 内核插件（给 dsh 补能力的 Cordis 插件）
```

参考实现：`src/plugins/sessions/goal/`（`renderer/` + `pi-extension/` + `dsh-extension/`）、`src/plugins/insight/llm-recorder/`（`core/` + `renderer/` + `pi-extension/` + `locales/`）。

**非必要不修改薄壳内核，也绝不修改外部内核仓库**（§1.6 内核源码只读：外部仓库、本地已装内核包、装后补丁三个形态一律禁止）。新写插件时去改 desktop 的内核（壳）来容纳这个插件——这是把会变的内容焊进壳，破坏薄壳。要改别人的功能，**首选改对方插件**：对方插件提供槽位，本插件去填槽（会话流 UI 由 timeline 插件提供槽位、文件列表由 file-tree 插件提供槽位、会话列表由 sessions-list 插件提供槽位），动的是对方插件和本插件，动不到壳的核心内核。给内核补能力只写内核插件（pi-extension / dsh-extension），**严禁改 deepseek-harness / dsh / pi 等内核的源码**——只写扩展，不写对方核心。

- **判别气味**：改动一个功能时，diff 落在 `server/`（壳）而非 `plugins/` 或内核插件；或把功能做成「改内核」而非「写内核插件」。
- **正确做法**：一个功能一个 plugin，四件套内聚（i18n/pi 内核插件/dsh 内核插件/desktop 插件收进同一个 plugin）；要扩展别人功能走槽位填槽；内核侧缺能力写内核插件。

## 8 通信机制

### 8.1 壳和壳插件怎么通信

my-harness-desktop 是「服务器 + 前端」双端：`src/server`（壳后端，Electron main 或 Node 服务器双宿主）+ `src/web`（React 前端），经 HTTP + WS 通信。前端经 `window.kernel`（由 `src/web/kernel/build-kernel.ts` 构造）访问壳后端能力。壳插件不直接访问 `window.kernel`，统一经 `usePluginContext()` 拿受控 API——pluginId 由 PluginIdContext 自动注入。

`window.kernel` 上的 API 按能力分层：

- **核心默认**：config、prefs、themes、settings、sessions、i18n、models、kernel（**多内核**管理：版本/安装/切换/连通性测试）、notification（系统通知）。所有壳插件可用，不需声明权限。
- **声明能力**：fs:project、git:read、git:write、llm:oneshot、sessions:bus、rpc:bash。需要壳插件在 `plugin.json` 的 `permissions` 字段里声明，壳后端在网关边界（`src/server/controllers/` 的 handler）检查。
- **用户手势驱动**：dialog。由用户手势触发，默认放行。

### 8.2 壳插件之间怎么通信：事件唯一通道

壳插件之间唯一合法的通信是 `ctx.events.emit/on`。不通过共享 store 互读写，不通过 `window.kernel` 直调对方能力。

**事件总线**在 renderer 侧运行，不跨进程。channel 由代码级 `export const channels` 声明，框架加载 module 后读 `module.channels` 自动注册。

**emit 与 invoke 是两种原语，别混用**。`emit` 是发布/订阅：只能发自己声明过的 channel，payload 被缓存供 `replayLast` 回放——适合可回放的状态广播。`invoke` 是定向分派：调别的插件拥有的 channel，调用方不需要权属——适合一次性命令；无订阅者时入队，首个订阅者挂载时恰好一次投递，不做回放。

**dependsOn** 是生命周期护栏，不控制加载顺序。凡消费别人的 channel（on 或 invoke）都应声明 dependsOn。

**框架系统事件**用 `system:` 前缀（configFileSaved、settingsChanged、layoutChanged、systemThemeChanged、refreshRequested 等），插件订阅不需要 dependsOn。`replayLast: true` 让新订阅者立即收到最近一次 emit 的 payload。

**共享 store 只读**：壳插件可以读 `useUiStore` / `useSessionStore` 的框架状态，但不能调 store 的 setter。要改变框架状态走 ctx API。

### 8.3 零硬编码

壳插件代码中不允许出现 plugin ID、component 注册名、slot contribution ID、配置文件路径、**内核身份**的字符串字面量。plugin ID 由 PluginIdContext 自动注入，component 名由框架自动匹配，slot 可见性由框架传 `isActive` prop，内核身份由框架/适配器抹平。这条由 lint 强制执行。

### 8.4 接入点都有哪些

一个壳插件要接入，需要触碰的接入点只有三个：`plugin.json`（声明）、`renderer/index.tsx`（export 组件 + channels + 用 `usePluginContext()`）、PluginContext（能力 + 事件）。一个内核要接入，交三样东西（§6.4）：spawn 命令、适配器、会话模型映射。

## 9 框架与插件的分工：通用与特化

### 9.1 框架管什么

框架（壳的机制部分）管所有壳插件都需要做的事——这些事收进框架统一承担，不让每个壳插件各写一遍。

- **save/dirty/reset**：壳插件在 manifest 里声明 `configFile`，框架自动管读、写、dirty、保存、重置、拦截、刷新、打开配置。
- **样式**：框架提供 `SettingsSection`、`ListItem`，所有壳插件统一。
- **语言**：框架管 i18n 初始化和语言切换，壳插件只管调 `t("key")`。
- **组件注册 / pluginId 注入 / 事件 channel 注册**：框架自动。
- **统一配置通道**：壳插件配置默认读写 `<cwd>/.my-harness-desktop/config/{pluginId}.json`（项目级），全局兜底。路径由框架按 pluginId 推导。
- **多内核能力**：框架管内核装配（各内核自己的 `<id>/backend/<id>-backend-factory.ts` + `KernelRegistry`）、模型合流（`ModelCatalog` 持 `KernelModelSource[]`，加第三个内核 = 加一个 source，`ModelCatalog` 一行不改）、内核切换（`switchKernel`：stop 旧后端 → seed 中性历史 → 起新后端）。

### 9.2 壳插件管什么

壳插件只管两件事：渲染 UI，和报告改动。渲染 UI：`renderer/index.tsx` 是 React 组件，通过 `usePluginContext()` 拿受控 API。报告改动：调 `onChange` 告诉框架"有改动了"，框架设 dirty、弹保存浮层、写回 configFile。

### 9.3 依赖倒置的具体形态

依赖倒置在这个项目里有六个具体形态，前四个是旧有的，后两个是 DSH 引入后新增的：

**内核后端（新增，最核心）**：`session-store` 不 `new PiBackend()`，持有 `BackendFactory` 接口（圆心契约）。`PiBackend`/`DshBackend` `implements BaseBackend`（圆心契约），实现与**工厂**都在 `src/server/kernel/{kernel}`（工厂 = `<id>/backend/<id>-backend-factory.ts`，由该内核的插件调用）。换内核只换适配器，application 和 domain 一行不改。

**内核版本管理（新增）**：`KernelManager` 基类（`src/server/kernel/core`）管 pi/dsh 共用的"装/查/状态合成"机制，只依赖 `KernelSpec` + `KernelRuntime` 接口，不 import 具体内核。`PiKernelManager`/`DshKernelManager` 在 `src/server/kernel/{kernel}/manager` 填数据（`PI_SPEC`/`DSH_SPEC`）+ 行为差异（`postInstall`/`installPlugin`）。实例构造也在各自 manager 里（`createDshKernelManager`；pi 侧由插件工厂直接 `new`），不再有共享的 `kernel-managers.ts`。

**RPC 适配（旧）**：`session-store` 持有 `BackendFactory`（原 `RpcAdapterFactory`）。`RpcAdapter` 不直接 `spawn()`，持有 `SubprocessHandle` 接口。

**内核运行时（旧）**：`KernelManager` 不直接 `spawn("npm")`，持有 `KernelRuntime` 接口（`installNpm` + `fetchRegistryVersions`）。

**路径注入（旧）**：`config-store`、`pi-settings-store` 不直读 `process.cwd()`。路径由 `bootstrap` 注入。

**配置读写（旧）**：`config-file.ts` 提供 `readJsonFile`/`writeJsonFile`/`withDirLock`/`appendJsonlLine` 原语，各 store 都调这些原语。

### 9.4 继承 + 实现

多内核下，"接口 + 两个平行实现"会让重复代码（缺面抛错、装/查机制）各写一份。解法是"接口 → 抽象基类 → 具体实现"的三段式继承结构：

```
packages/shared/src/domain/backend.ts          BaseBackend（接口，契约）
        ▲ implements
src/server/kernel/core/abstract-backend.ts     AbstractBackend（骨架 + 缺面默认，已落地 `094f639`）
        ▲ extends
src/server/kernel/pi/backend/pi-backend.ts     PiBackend（override pi 的能力）
src/server/kernel/dsh/backend/dsh-backend.ts   DshBackend（继承缺面默认 + override dsh 能力）
```

`AbstractBackend` 精确形状：14 条 abstract（`kernel`/`alive`/`start`/`stop`/`onEvent`/`sendMessage`/`abort`/`setModel`/`setSessionName`/`getTree`/`getEntries`/`bookmark`/`deleteBookmark`/`seed`）+ 3 条缺面默认（`listTools` 返回 null、`answerQuestion`/`setThinkingLevel` 抛错）＋ 4 个默认成员（`capabilities={}`/`configDepPaths=[]`/`sessionId` getter/`supportsRuntimeSetModel` 乐观 true）。`fork` 不在基类——分叉归壳（§7 内核是单线执行器），fork 是壳的 `SessionTreeApi`；`resume?` 曾是可选意图、r72 已删（锚点重启走 `SessionStore.resume` 中立层派生）；思考档位**设置**进契约（`setThinkingLevel`，atomic-send），清单/轮转仍走 `thinking` 轴；`PiBackend` 另显式 `implements` 九个中性能力面接口（`SteeringCapabilities` / `RetryCapabilities` / `CompactionCapabilities` / `SnapshotCapabilities` / `StatsCapabilities` / `ModelCycleCapabilities` / `ToolExecCapabilities` / `BusFrameCapabilities` / `QuestionChannelCapabilities`），故 `capabilities` 各轴直接填 `this`、**无需 `as` 断言**（曾是 `{ extensions: this as BackendExtensions }`）。`capabilities` 的形状由圆心 `BackendCapabilities` 单源定义，`AbstractBackend` 只给缺省 `{}`，不再各写一遍内联形状。

以及已经落地的内核版本管理：

```
packages/shared/src/domain/kernel-manager.ts    KernelSpec（纯数据，零依赖）
src/server/kernel/core/kernel-manager.ts        KernelManager（基类：装/查/状态合成，注入 KernelRuntime）
src/server/kernel/pi/manager/pi-kernel.ts       PiKernelManager extends（填 PI_SPEC + postInstall）
src/server/kernel/dsh/manager/dsh-kernel.ts     DshKernelManager extends（填 DSH_SPEC + installPlugin）
```

三条纪律：

1. **基类只 import `packages/shared`，绝不 import 具体内核**——它是机制（"契约骨架 + 缺面默认"、"装/查/状态合成"），不是内容。`AbstractBackend` 只依赖契约和中性类型，`KernelManager` 只依赖 `KernelSpec` + `KernelRuntime`。
2. **子类只填差异**：数据（`PI_SPEC`/`DSH_SPEC`）+ 行为差异（`postInstall`/`installPlugin`/override 缺面方法）。pi 和 dsh 在会话模型、事件形状、fork 语义上处处相反，那些**不能共享的仍是 abstract**——不要为"看起来能复用"硬塞进基类。什么时候再往基类加 protected 模板方法？等真有第二个内核也共享的编排（如"fork 前校验 boundary 落在完整回合之后"），不预支。
3. **组装归各内核自己**：`createPiBackend`/`createDshBackend`/`createMinimalBackend` 在各自 `<id>/backend/<id>-backend-factory.ts`，由该内核的插件工厂调用；`bootstrap` 只经 `KernelRegistry` 拿到插件、调 `plugin.createBackend(opts)`。core 一行不 import 具体实现，且**没有任何一个文件同时 import 两个内核**（检验⑪ 守住）。

**边界（关键，别混淆）**：基类解决的是**实现复用**（怎么少写重复的缺面抛错），不产生新能力；**能力拉平**（怎么让壳无感）靠内核插件（§7.6）。两者正交——别把"抽了基类"当成"拉平了能力"。

## 10 QA

**Q：为什么不直接用 VSCode 的扩展 API，而是自己造一套插件体系？**

VSCode 的扩展 API 是为代码编辑器设计的，my-harness-desktop 是 AI coding agent 的桌面壳。借用 VSCode 的架构纪律（薄壳 + 槽位契约 + 无特权差异），但不借用它的 API 形状。

**Q：两个壳插件往同一个槽位挂了同样的东西，怎么办？**

按优先级选。四级来源：`builtin`（内置，最低）< `installed`（插件管理器安装）< `user`（用户目录）< `project`（项目目录，最高）。同级按声明顺序，先声明的先选。确定性，不随机。

**Q：壳插件 A 真的需要壳插件 B 的数据，怎么办？**

通过事件获取。B 通过 `ctx.events.emit` 发布，A 在 manifest 声明 `dependsOn`，然后 `ctx.events.on` 订阅。

**Q：为什么内核是被管理的资源，而不是一个壳插件？**

内核是一个独立的子进程，有自己的生命周期、配置、版本管理、插件树、会话模型。它不是"挂在壳槽位上的一个功能"，而是"壳通过中立契约和适配器管理的一个外部能力"。把它当壳插件会模糊边界——壳插件是"被壳加载的代码"，内核是"被壳管理的进程"。内核和 git、文件系统是同一层抽象——都是被管理的资源。二者的区别现在更清楚：pi 和 dsh 是两个同级内核，谁也不比谁更"内建"。

**Q：壳插件声明了权限但用户不授权，怎么办？**

壳插件功能受限但不崩溃。权限校验在壳后端的网关边界（`src/server/controllers/` 的 handler）——壳插件调了没授权的能力，handler 直接拒绝，壳插件收到错误自己决定怎么呈现。

**Q："手写收敛到成熟包"——如果没有成熟包呢？**

没有成熟包的时候才自己写。但判断要谨慎——不是没有名气大的包，是真的没有解决这个问题的包。自己写的每一行代码都是自己背的债，能还就还。

**Q：会话为什么用 JSONL 文件而不是数据库？**

这是 pi 内核的存储实现，不是壳的契约。壳只认不透明 `sessionId` 和 `LineageTree`——pi 后端存 JSONL 文件，dsh 后端存 append-only 日志，壳都不关心。选 JSONL 是 pi 后端内部的取舍（追加写、流式读、删文件就行），不影响壳。

**Q：pi 自己就能配 DeepSeek，为什么还要接 dsh？**

取决于"dsh 的 DeepSeek 适配是否比 pi 直接连更完整"这个前提。成立，dsh 当内核才能拿到思考模式 / `reasoningEffort` / 重试这些 pi 未必有深度的东西；不成立，直接让 pi 连 DeepSeek。这是接 dsh 的第一道门，不藏在结论里。

**Q：书签能跨内核 resume 吗？**

书签重启**不依赖**内核 resume 面——`resume?` 已于 r72 从契约删除（无内核实现它，dsh 侧 `sessionResume` 同批删）。现行机制：书签发起的重启走 `SessionStore.resume(snapshotId)` 在**中立层派生**新会话（`deriveSession`：快照里的 lineage entries → 目标内核的 seed 投影），对所有内核一律适用；跨内核书签重启同理（先 `switchKernel` 投影到目标内核，再按坐标派生），七步切换已启用（`switchKernelEnabled = true`，三过渡已验）。`anchor` 是中立坐标 `NeutralAnchor = { lineageId, entryId }`（`c5189a8` 去 opaque）。

**Q：pi 的专属能力（steer / thinkingLevel / onExtensionUI）去哪了？**

`steer`/`onExtensionUI` 不进中立契约，是 pi 的扩展面，壳经能力接口探测"有则用、无则降级"——dsh 下这些入口隐藏/置灰。`thinkingLevel` 已分半：**设置**（`setThinkingLevel`）进契约（docs/design/atomic-send.md，dsh 显式降级抛错），**档位清单/循环切换**（`getThinkingLevels`/`cycleThinkingLevel`）仍留 pi 扩展面。要么将来给 dsh 写 cordis 插件补面，要么永久降级。

**Q：为什么 pi 和 dsh 的协议各在 `src/server/kernel/{pi,dsh}/protocol/`，而不是共用一个纯契约层？**

历史遗留——pi 曾是唯一内核，协议面曾上过 `core/protocol`（现已随前后端分离下沉到 `src/server/kernel/pi/protocol/`）。终态已拍板（`kernel-design-spec.md §6.5`）：两边协议面都上提纯契约层。当前已落地收尾：dsh 的方法名已从 `json-rpc.ts` 魔法字符串收敛为 `dsh-methods.ts` 的 `DSH_METHODS` 常量枚举（「dsh 方法单源」commit）；pi 的命令契约在 `pi/protocol/`（rpc-types/commands/event-translator/context-binding/versions；RpcCommand 联合 29）。两边的协议契约现在物理上各归各的内核目录，语义上都是「内核专属形状，壳只认中立契约」。

**Q：这套原则适用于别的项目吗？**

通用原理（§1–§5）适用于任何需要插件化、需要分层、需要机制-内容分离、需要多后端/多内核的系统。具体落地（§6–§9）是 my-harness-desktop 这个项目的执行方式——别的项目可以借鉴，但不该照抄。原则是通用的，执行是特化的。

# 工程原则

## 关注点分离

### 回调参数是责任边界模糊的气味

当一个函数接受 `fn: Callable` 类型的参数，往往意味着它在把本该自己承担的职责外包出去。

不是说回调一定错，但值得问：这个逻辑是不是应该内聚在某个专门的类里，而不是让每个调用方各自实现一遍？

**判断方式**：如果多个调用方传入的回调逻辑大同小异，说明这个逻辑应该收进来，由被调用方统一承担。

### 组装和调用应该分开

"怎么拼 prompt"和"怎么发给 LLM"是两件事。Assembler 层管前者，Gateway 层管后者。

这条边界一旦守住，两侧可以独立演化——换 LLM provider 不影响 prompt 逻辑，改 prompt 策略不影响调用流程。

**推广**：同样的原则适用于任何"构造"和"执行"的分离——构造 SQL 和执行 SQL、构造请求和发送请求、构造配置和启动服务。

## 洋葱架构思维

写代码、改代码、做方案时，默认用洋葱架构的视角看依赖——它不是某个具体技术，而是"依赖方向"的几何纪律。

1. **依赖只向内**：圆心是稳定的业务本质，外层是会变的细节（DB、框架、HTTP、第三方 SDK）。箭头永远指向圆心——外层可依赖内层，内层绝不依赖外层。
2. **把"会变的"推到外层**：DB 选型、消息协议、Web 框架、第三方 SDK 都是细节，不该污染业务核心。业务规则不 import ORM、不 import Web 框架。
3. **依赖倒置连通内外**：需要跨层协作时，接口定义在内层、实现在外层。内层依赖"抽象"，外层提供"实现"，两侧可独立演化。
4. **新增功能先问归属哪层**：这逻辑是业务规则（内层）、用例编排（中层）还是基础设施（外层）？放错层就是技术债。

**判别气味**：
- 业务函数里直接出现 SQL / HTTP / ORM 调用 → 业务核心被基础设施污染，该往外推。
- 内层 import 了外层包 → 依赖方向反了，立即反转。
- 同一业务逻辑在多个外部入口各写一遍 → 该收进内层统一承担（呼应"回调参数是责任边界模糊的气味"）。

**和已有原则的关系**：洋葱是"组装和调用应该分开"的推广形态——构造在内，执行在外；"依赖向内"即"关注点分离"的几何表达。落到具体项目时，按项目自身的分层映射（见各项目 CLAUDE.md 的洋葱视角章节）。

## 完整设计，一次落地

思考方案时，默认没有时间压力、没有执行压力——只问这个问题的正确解法（终态）长什么样，先设计最完整、最长期主义的版本。终态先行，再谈落地。

落地时拒绝两种切香肠：

- **方案菜单**：列方案供选择没有问题，但把补丁方案列进选项就有问题。选项之间应该是不同正确解法的差异，不该是"做对"和"做半截"的差异——只要"省事"出现在菜单里，就可能被选中，而选中即欠债。补丁方案不进菜单。
- **步骤切片**：把一个大步骤拆成五个，每搞一个就停下来。方案定下来后，一次把多步做完，在一个工作流里把完整方案全部落地，不留"演进中"的缺口。

中间态即技术债：第二步永远排不上期，第一步的半成品就成了系统的永久形态。

**允许拆分，但边界是"每个交付物自身完整"**：大任务拆成多个 commit 是好的——每个 commit 都是可用的完整态；禁止的是"先交个半成品占位"的拆法。

**判别气味**：
- "先简单实现，后面再完善" → 简单实现会成为永久实现，拒绝。
- "分三期，第一期先……" → 三期方案往往只有一期落地，一期就按终态做。
- 讨论时只谈"第一步做什么"、不谈终态 → 先把终态设计完整，再谈步骤。

**边界**：完整不等于扩大范围。"一次做完"指把**已确认需求范围内**的每一步做透，不是把想象中的需求也提前做掉——范围内做透是纪律，范围外提前建设是浪费。

## 按方案实现：worktree 标准工作流

**触发即默认**：凡是"按设计文档 / 已定方案开始实现"的任务，一律走 worktree 闭环，不直接在主工作区改代码。这是默认路径不是可选路径——改动再小也走，闭环不因改动小而省。

**闭环五步**：

1. **建 worktree**：从当前分支最新处拉一个 worktree + 临时分支（一任务一分支，命名带任务标识），所有改动只发生在 worktree 里。
2. **实现**：按方案一次落地（"完整设计，一次落地"），实现思路守五条——
   - **高内聚**：一个功能内聚到一个模块/插件目录（§7.7 四件套），不散落各处。
   - **低耦合**：依赖接口不依赖具体实现，跨层协作走依赖倒置（§3.4、§9.3）。
   - **开闭原则**：新逻辑走扩展点 / 槽位 / 新插件，不改已有稳定代码。
   - **洋葱架构**：依赖只向内，会变的细节推外层，放错层即技术债（§1.1、§4）。
   - **薄壳架构**：机制留壳、内容外挂，非必要不改壳，绝不改外部内核仓库（§7）。
3. **验证**：三级测试该覆盖的层全覆盖且全绿（§5.6）——纯逻辑补 unittest、UI 行为补真实 DOM 交互 test、全链路补 e2etest；能起 app 的改动起 app 实测。没有验证证据不进下一步。
4. **commit**：在 worktree 里提交，message 带四要素（§5.4），每个 commit 自身完整可用。
5. **合并回当前分支 + 收尾**：切回主工作区，把临时分支合并进发起任务的当前分支；确认无误后**直接删掉本任务自建的 worktree 和临时分支，不必回头问用户**（自建自清是闭环的一部分，代码已 commit 不丢任何东西）。唯一例外：worktree 里还有未提交改动、或还有未合进当前分支的 commit —— 这时停下来告知用户，不加 `--force`。他人/他任务的 worktree 永远不自动碰（见「Worktree 操作禁令」）。

**多任务并行的合并纪律**：本仓库常态是多个功能各自在 worktree 里同步推进，当前分支随时在前进——合并不是收尾的形式步骤，是最容易出事的环节：

- **合并前先对齐当前分支**：先把当前分支的最新进展合进自己的临时分支，冲突在 worktree 里解掉再回合——不把冲突留给当前分支。
- **冲突是语义信号，不是文本障碍**：冲突说明两个任务碰了同一块代码。逐个 hunk 读懂两边意图再解；解不动（语义级冲突）就停下来找用户裁决，不猜、不用 `--ours`/`--theirs` 一把梭——那等于盲改别人正在做的功能。
- **合并后复验**：worktree 里全绿 ≠ 合并后全绿——别人的改动可能已经动了你依赖的面。合并进当前分支后重跑受影响的测试 + 起 app 验一遍，顺手回归历史守卫（§5.5）。

**判别气味**：

- "就改几行，直接在主工作区改吧" → 违规，几行也走闭环。
- "先合进去，有问题再修" → 把灭火成本推给当前分支（§5.5 的教训：先合五步、灭火两天）。
- 合并前没看当前分支前进了多少 → 可能在用过期的世界覆盖别人的新工作。

## Worktree 操作禁令

**背景**：worktree 不是一次性容器——只要改动已经 commit，删掉 worktree 目录并不丢代码，commit、分支都还在仓库里。但 AI 常把 worktree 误当成"任务跑完就该销毁"的临时区，在 checkout / fetch / merge 等操作里顺手批量清理 worktree，可能毁掉别的分支上**还没 commit / 还没 merge 的工作**。

**正向工作流（有修改任务时默认采用，必须执行）**：任何代码修改任务，默认走「按方案实现：worktree 标准工作流」的完整闭环（建 worktree → 改 + 验证 → commit → 合并回当前分支 → 删 worktree），不直接在主工作区改。闭环的正向步骤以那节为唯一源；本节只管删除纪律。

**核心边界：区分「自建自清」与「别人的 worktree」**。本节禁令防的是后者——顺手清掉不属于本任务、可能还持有未提交工作的 worktree。前者（本任务自己创建的 worktree + 临时分支）是闭环第 5 步，**合并确认无误后直接删，不需要每次回头问用户**：代码已 commit，删目录不丢任何东西，反复确认只是仪式不是保护。

**A. 自建自清（默认直接做，不问）**

1. 范围严格限定于**本任务自己创建**的那一个 worktree + 它的临时分支，一次只删这一个。
2. 前置条件（三条同时成立才自动删）：① 改动已全部 commit；② 临时分支已合进当前分支；③ 删的是自己建的那个路径。任何一条不成立 → 落到下面的例外。
3. 命令：`git worktree remove <路径>`（**不加 `--force`**）+ `git branch -d <临时分支>`（用 `-d` 不用 `-D`——git 拒删本身就是"未合并"的信号，此时停下来看）。删完顺手 `git worktree prune`。
4. **例外（必须停下来告知用户，不自作主张）**：目标 worktree 有 uncommitted 改动、或有未合并进当前分支的 commit、或 `remove` 因脏工作区被 git 拒绝。把情况说清楚，由用户决定丢弃 / 提交 / 保留；**绝不用 `--force` 绕过拒绝**。

**B. 别人的 worktree（禁止自动碰）**

1. **不属于本任务创建的 worktree，未经用户明确要求不得 remove**：尤其禁止遍历 `git worktree list` 后批量 `remove`。"顺手整理一下"不构成授权。
2. **切换分支 / fetch / merge 等操作不得附带 worktree 清理副作用**：用户说"checkout 到远程最新 test"就是 checkout，不是"checkout + 清 worktree"。不得借题发挥、扩大操作范围（呼应"组装和调用应该分开"）。
3. **确需清理遗留 worktree 时必须先确认**：先 `git worktree list` 列出全部，逐个说明要删哪个、为什么，等用户确认后再 `git worktree remove <路径>`（不加 `--force`）。
4. **区分 prune 与 remove**：`git worktree prune` 仅清理"目录已不存在"的残留登记，不碰现存目录 → **安全，任何场景可做**；`git worktree remove <路径>` 会真实删除工作目录 → 只适用 A 类，或 B 类经用户点头。

**目的**：一手杜绝"切个分支结果别的 worktree 被清掉"这类越界破坏，一手不把自建自清的正常收尾变成每次都要用户点头的仪式。判据一句话：**删自己刚建的 = 收尾，删别人建的 = 需要授权。**

## Claude Code 八荣八耻
- 以瞎猜接口为耻，以认真查询为荣。
- 以模糊执行为耻，以寻求确认为荣。
- 以臆想业务为耻，以人类确认为荣。
- 以创造接口为耻，以复用现有为荣。
- 以跳过验证为耻，以主动测试为荣。
- 以破坏架构为耻，以遵循规范为荣。
- 以假装理解为耻，以诚实无知为荣。
- 以盲目修改为耻，以谨慎重构为荣。

## 实现类回复格式要求

每当回复涉及代码实现、重构或修复，**必须在回复末尾追加以下两个 section**，不得省略：

---
### 架构自检
- [ ] 高内聚：各模块职责单一、边界清晰（一个功能内聚到一个模块/插件目录，§7.7）
- [ ] 低耦合：依赖最小化，通过接口而非具体实现（§3.4、§9.3）
- [ ] 开闭原则：新逻辑通过扩展点/槽位/新插件实现，未修改已有稳定代码
- [ ] 薄壳架构：机制留壳、内容外挂，未把功能焊进壳或内核（§7）
- [ ] 方案视角：解决根本问题，而非打补丁
- [ ] 洋葱架构：依赖只向内，会变的细节推外层，放错层即技术债（§1.1、§4）
- [ ] 测试同行：纯逻辑有 unittest、UI 行为有真实 DOM 交互 test、全链路有 e2etest，该覆盖的层已覆盖且全绿（§5.6）
- [ ] 测试静默：本轮验证没弹窗、没抢用户焦点（拉起 app 的脚本都过 `quiet-env` / `MHD_WINDOW=hidden`）且 `npm run audit:quiet` 通过（§5.6）

### 修改文件清单
本次改动涉及的全部文件的树形清单，按目录分组。目的是让读者一眼看清改动的物理范围和落点——不用翻 diff 就能知道这次动了哪些文件；每个文件后可附一行说明改了什么。

文件树必须带上提交上下文：分支名 + commit hash（short hash）。已提交的在树头标注 `分支@hash`；尚未提交的显式标注"未提交"。改动跨多个 commit 时按 commit 分组，每组各自标注 hash——读者不用翻 git log 就能定位每个文件落在哪个提交里。

如有不符合项，在对应行标注问题并给出改进建议。
