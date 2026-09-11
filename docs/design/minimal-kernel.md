# minimal 内核：一个不基于 pi / dsh 的独立内核

写这份文档，是因为有一个反复出现的问题需要一次性讲清楚：**在 my-harness-desktop 这套架构里，一个内核到底是什么，以及自己动手写一个内核到底意味着什么。** pi 和 dsh 是现有的两个内核，它们的存在方式容易让人把"内核"和"pi 或 dsh 的某种具体形态"绑在一起——pi 是 JSONL 文件加 parentId 树（一个会话文件里用 parentId 指针连成整棵会话树）加 31 条命令的协议，dsh 是 Cordis 插件树（dsh 的插件框架）加 session forest（每个分支一个子会话）加 JSON-RPC。但内核这个抽象本身，比这两者都要小。本文要设计的 minimal，就是把那个更小的抽象单独拎出来，做成一个真正能跑、能持久化、能聊天的第三个内核，用它证明一件事：壳从来不依赖 pi 或 dsh，它依赖的是"内核"这个抽象，而任何人都可以自己实现一个。

全文只贯穿一个统一抽象：**内核**。pi、dsh、minimal 都是它的实例，谁也不比谁更内建。minimal 的特殊之处只有一条——它是为了验证这个抽象而写的最简实例，但"最简"说的是省掉运行时机器，不是说省掉功能。它照样起子进程、照样有自己的会话文件、照样走 SSE 流式调真模型、照样有工具系统、照样有插件系统。

## 1. 要解决的问题

### 1.1 一个不基于 pi/dsh 的独立内核，要交哪三样

一个内核要成立，至少要交三样东西。这三样不是本文的发明，是 `kernel-design-spec.md` §32 那张"接入第三个内核的检查清单"的第一层，也是"可托管内核"和"一个能跑的程序"的分界线。

#### 1.1.1 运行时本体：会话循环 + 模型调用 + 事件流

内核的第一件事，是能把一条用户消息变成一条模型回复，并且把这个过程作为一串事件吐出来。这是内核的本体，pi 和 dsh 各有一套：pi 是进程里的 agent loop，dsh 是 Cordis 里的 agent loop。minimal 也要有自己的一套——收消息、组请求、调模型、把模型吐出的 token 转成事件、落盘、收尾。没有这一层，剩下的都是空壳。

#### 1.1.2 存储本体：自己的会话文件

内核的第二件事，是把自己跑过的会话存下来。这是本文反复被追问的一点，也是 minimal 和"验证假体"的分界：一个真内核必须写会话文件，否则关掉进程什么都没了，它就不是一个能独立运行的程序。pi 的会话文件是 JSONL，dsh 的会话文件是 append-only 日志；minimal 也要有它自己的会话文件。文件格式是 minimal 自己的，但它的**语义模型**不该另起炉灶——这件事在 1.3 和 §3 展开。

#### 1.1.3 接入面：spawn 命令 + 协议 + 适配器

内核的第三件事，是能被别人托管。pi 能被壳 spawn 是因为它有 cli 入口和 31 条命令的 JSONL 协议；dsh 能被 spawn 是因为它有 bin 入口和 JSON-RPC。minimal 也一样：一个 spawn 命令、一套它自己的协议、一个把它的协议翻译成壳要的中性形状的适配器。注意顺序——**spawn 命令和协议是 minimal 自己的，适配器才是壳的事**。这是本文最容易写反的地方，§2 和 §7 会各讲一半。

### 1.2 "可替换"分两层，minimal 证的是哪一层

"壳不依赖内核"这句话，拆开其实是两句，混在一起就会高估或低估 minimal 的价值。

#### 1.2.1 组装层：换内核 = 换适配器，壳一行不改

第一句是**组装层**的可替换：壳的圆心（中立契约 `BaseBackend`、`SessionCatalog`、`KernelModelSource`）只认抽象，换一个内核就是交一个新适配器，圆心和壳的用例编排一行不改。这一层是 `kernel-design-spec.md` 从第一天就在守的纪律，pi 和 dsh 已经各验证过一次，minimal 是第三次验证。

#### 1.2.2 运行层：一个活会话在多个内核间切换

第二句是**运行层**的可替换：一个正在跑的会话，能不能中途从 pi 切到 minimal、再从 minimal 切到 dsh，消息流不丢。这一层由 `switchKernel` 的编排承担，落点在 `session-store.ts` 的七步切换（七步内容见 §8.1.2）和 `kernel-switch-projection.md`。它和组装层是两件事：组装层验的是"壳能不能装下 minimal"，运行层验的是"一个会话能不能在 minimal 和别的内核之间搬"。本文两件都管——minimal 作为第三个内核，既要能被装下，也要能被切进切出，后者单独在 §8 讲，不再像前几稿那样用"门禁关着"把它推开。

### 1.3 自写内核的成本地图：壳要什么、不要什么

写内核之前，先问清楚壳到底要内核交什么。这件事不问清楚，就会把 pi/dsh 里那些其实壳根本不要的机器，误当成"内核必须有的东西"，然后白白重造一遍。

#### 1.3.1 壳要的是输出形状，不是机器本身

壳要的，从头到尾只有两种东西：**中性事件**（`SessionEvent`，驱动 timeline 的消息流）和**中性会话形状**（`NeutralSession`、`LineageTree`、`NeutralMessage`，驱动会话列表、树、重放）。至于这些形状背后是 JSONL 还是 session forest、是 31 条命令还是 JSON-RPC、是 agent loop 还是 Cordis 插件树，壳一概不关心——`neutral-session-first.md` 把这句钉成了运行时不变量："会话的真相源是中立层，pi/dsh 是它的投影；换内核 = 换投影。"壳要的是投影的结果，不是投影的机器。

#### 1.3.2 哪些机器要重造、哪些永远不用碰

把 pi/dsh 拆开看，一个自写内核真正要重造的，只有表格右列"壳要的输出"对应的那几台机器；剩下的要么是壳不要的、要么可以极简。这张表是本文其余部分的骨架，§3 到 §6 就是顺着它往下填：

| pi/dsh 内部的机器 | 壳要不要它 | minimal 怎么办 |
|---|---|---|
| agent loop（消息→模型→回复的循环） | 只要结果（事件流） | 自己写一套，§4 |
| 会话存储（JSONL / session log） | 只要投影形状 | 自己的线性会话文件，§3 |
| 模型调用（HTTP 网关 / 流式） | 只要 `setModel` + 事件 | 自己的 SSE 客户端，§4 |
| 工具系统（tool-gate / 插件工具） | 只要 `listTools` + 事件里的 toolCall | 自己的工具系统，§5 |
| 插件系统（TS 扩展 / Cordis 树） | 不要，内核自管 | 自己的可拆分模块，§6 |
| 协议（31 命令 / JSON-RPC） | 不要，适配器翻译掉 | 自己的 JSONL 行协议，§2/§4 |

这张表的关键不在"minimal 要写多少"，而在"壳要的那一列少得惊人"——它从来不要内核的插件树、不要内核的协议、不要内核的存储格式。这就是为什么写一个内核是可行的：你只需要把右列那几台机器做出真实可用，就得到一个能被壳当同级托管的完整内核。

## 2. minimal 是什么：一个独立、可单独运行的内核

这一节正面回答"minimal 是什么"。前几稿在这里反复跑偏——一会儿把它当成壳的附属物、一会儿把它当成内存里的假体。现在钉死：**minimal 是一个独立的、离开 desktop 也能跑的内核，desktop 只是它的宿主之一。**

### 2.1 minimal 是一个独立内核，不是 desktop 的附属物

#### 2.1.1 它有自己的 spawn 命令，起子进程跑

minimal 和 pi、dsh 一样，是一个能被 `spawn` 的独立进程。它有 cli 入口，你在命令行里 `minimal` 就能把它拉起来，喂一条消息、它回一条。desktop 托管它，靠的是这条 spawn 命令，不是靠把它编译进壳里。前几稿我一度想让 minimal 跑在壳的进程内，那是把内核和宿主焊死，方向反了——一个真内核必须能脱离宿主单独存在。

#### 2.1.2 它有自己的会话文件与模型配置，离开 desktop 也能跑

minimal 的会话写到它自己的会话文件里，模型配置（provider、apiKey、baseURL）读它自己的配置文件。这两样都是 minimal 自己的资源，不依赖 desktop 的任何数据根、任何中立层。你可以在一个干净的机器上只装 minimal，配好模型，从命令行完整地聊完一轮、关掉、再打开续聊——这就是"独立内核"的最低验收线。

### 2.2 内核 = spawn + 适配器 + 会话模型映射，minimal 是第三个实例

#### 2.2.1 pi、dsh、minimal 是同一抽象的三种参数化

`kernel-design-spec.md` §3 把"内核"定义成三样东西的合体：怎么起（spawn）、怎么翻译（适配器）、会话怎么落到 lineage 坐标系（会话模型映射）。pi 是这三样的一套参数（cli + PiBackend + JSONL/parentId），dsh 是另一套（bin + DshBackend + session forest），minimal 是第三套。它们不是三个并列的概念，是同一个抽象的三种参数化——这是本文最根上的纪律，写任何一节都别把三者当成三件不同的事各讲一遍。注意这里说的"三样"和 §1.1 的"三样"是两回事：§1.1 说的是**内核本体的构成**（运行时/存储/接入面），这里说的是**壳托管契约的检查项**（spawn/适配器/会话模型映射，出自 `kernel-design-spec.md` §32）。两者别当同一份"三样"读，否则会以为前后矛盾。

#### 2.2.2 minimal 不内建、不特权，和另外两个同级

minimal 没有任何"默认就是它"的特权，也没有"临时塞进来凑数"的次等身份。壳里不允许出现"识别 minimal 并特殊对待"的代码路径，就像不允许"识别 pi 并特殊对待"一样。这一点 `kernel-design-spec.md` §7 对 pi 讲过（pi 失去默认特权），对 minimal 同样成立。检验方式一样：把 minimal 删掉，壳照常启动，只是少了 minimal 那份能力。

### 2.3 minimal 与 pi/dsh 无特权差异

#### 2.3.1 壳没有"识别 minimal 并特殊对待"的路径

会话流里不会出现 `if (kernel === "minimal")`，管理面里 minimal 和 pi/dsh 走同一套三个 TAB（内核版本 / 模型 / 拓展）的共享 base。minimal 的特殊性只体现在它自己的适配器和管理桩里，壳一行都不为它改。§7 会给出这个论断的代码级证据。

#### 2.3.2 删掉 minimal，壳照常启动

这是无特权差异的验收：minimal 是可插拔的，不是壳的运行时依赖。这条对 pi/dsh 已经成立，minimal 必须同样成立，否则它就不是"第三个内核"，而是"壳的一个补丁"。

### 2.4 minimal 有自己的协议，desktop 经适配器翻译

#### 2.4.1 spawn 命令 + 协议，是 minimal 的契约不是壳的

minimal 的协议是它自己的私有契约，和 pi 的 31 命令、dsh 的 `DSH_METHODS` 一样，收在 minimal 自己的协议层里。壳不消费它——壳只认适配器吐出来的中性形状。协议长什么样，是 minimal 的自由；唯一的要求是适配器能把它翻译成中性形状。

#### 2.4.2 协议形状：JSONL 行协议，命令进、事件出

minimal 选 JSONL 行协议：stdin 一行一个完整命令对象，stdout 一行一个完整事件对象。选它不是因为要跟 pi 对齐（pi 的协议和会话文件恰好也都是 JSONL，但那是 pi 各自的选择，不是"内核必须 JSONL"的规矩），而是因为它是能跑起来的协议里最简的：一行一个完整 JSON，没有分帧、没有握手协商、`head -n 1` 就能肉眼读。协议细节在 §4.2 展开。

### 2.5 minimal 有自己的会话文件

#### 2.5.1 存储退进内核：壳不读 minimal 的私有文件

"存储退进内核"（`session-storage-retreat.md` 确立、`kernel-design-spec.md` §3.4 记成不变量 #1）说的不是"内核要发明一个神秘的不透明格式"，而是**壳不读内核的私有文件**。这里"壳"要精确到"壳的 application 层"——session-store、controllers、timeline 这些用例编排和渲染，不读 minimal 的私有文件；而内核侧的**适配器**（`MinimalBackend`/`MinimalCatalog`/`MinimalModelsApi`）是读写的，因为读写内核私有文件（会话文件、配置、凭证）正是适配器的本职。"私有"是"对 application 层私有"，不是"对适配器私有"——这个细分在 §4.9.2 讲凭证时也会用到，别把两处读成矛盾。minimal 的会话文件是 minimal 的私有存储，壳（application 层）读的是中立层——那个所有内核共享的 canonical 真相源。

#### 2.5.2 但文件形状学公共 session，不另起炉灶

minimal 的会话文件虽然是私有的，它的**语义模型不该自己发明**。会话该怎么长，`neutral-session-first.md` 已经定了 canonical：一个会话 = 头 + 若干 lineage，每条 lineage = 头部的 fork 引用 + 一串 entry。minimal 的文件就是把这个模型里"它自己那一份"落下来——具体说，是**当前活跃那条 lineage 的线性 AI 内容**。这是"珠玉在前，为啥不学"的答案：学中立层定义的会话模型，而不是学 pi 的 parentId 树或 dsh 的 session forest。

### 2.6 会话模型：头 + 一条活跃 lineage，不存 fork 树

#### 2.6.1 分叉归壳，内核是单线执行器

`neutral-session-first.md` §9 把 fork 钉死在壳侧："fork = 切中立树"。内核永远只物化**当前活跃的那条 lineage**，它是单线执行器——发消息就是在这条线上往后追加，fork 是壳在中立层切出新分支、再把新分支投影给它。所以 minimal 的会话文件不需要存 fork 树（parentId 叉树），它只需要存一条线的线性内容。这是本文前几稿最严重的错误：我一度让 minimal 存 parentId 叉树，等于把壳已经收走的 fork 职责又摊回内核。

#### 2.6.2 与 pi 老 parentId 树、dsh session forest 的区别

pi 的老文件用 parentId 连成树，dsh 用 session forest 一个分支一个会话——那是它们各自的历史形态。minimal 不学任何一个，因为它要学的是**已经收敛到中立层之后的那个形态**：内核只存线性投影，fork 结构归中立层。这不是 minimal 偷懒，是它比 pi 的老形态更贴合当前架构。§3.4 会把这个差别再掰开讲。

### 2.7 壳只认适配器吐出的中性形状

#### 2.7.1 中性事件 + 中性会话是壳和内核的接口

壳和 minimal 之间只有一层接口：适配器。适配器往上交两种东西——中性事件（`SessionEvent`，驱动 timeline）和中性会话形状（`NeutralSession`/`LineageTree`/`NeutralMessage`，驱动列表/树/重放）。壳不关心 minimal 内部是不是 JSONL 行协议、是不是有工具系统、是不是起了子进程，它只认这层接口。

#### 2.7.2 minimal 内部长什么样，壳不管

这句要反过来再强调一遍，因为它决定了 minimal 的设计自由度：minimal 的协议、会话文件格式、工具注册表、插件系统，全是 minimal 的私事，壳一行代码都不会为它们改。minimal 可以自由地做最简设计，只要适配器能把结果翻译成中性形状。§3 到 §6 设计的那些内部机制，全都是这个"壳不管"的空间里的事。

### 2.8 壳用能力探测承接 minimal，不按身份硬分支

#### 2.8.1 capabilities 与 factory.seed 两个探测点

壳承接 minimal，靠的是两个能力探测点，不是 `kernel === "minimal"`：一是 `backend.capabilities`（能力按语义分桶、不带内核名，§kernel-plugin §6：pi 给 `{extensions: ..., fileBacked: true}`，dsh 给 `{thinking: ...}`，minimal 给 `{fileBacked: true}`——**曾漂移为** `{pi: ...}`/`{dsh: ...}` 按内核名分桶 + minimal 给空对象，已中性化），二是 `factory.seed`（有预 seed 面的内核返回会话 id，无预 seed 面的返回 null）。先厘清两个术语，否则这节读不懂："预 seed"指内核的 seed 是纯文件写、能在 spawn 之前先把会话灌好（pi、minimal 都如此），"后 seed"指 seed 依赖活进程、必须先 spawn 再灌（dsh 如此）。这两个探测点各自的判据不同：`capabilities` 判"有没有内核专属扩展面 / 是不是文件态"，`factory.seed` 判"seed 要不要先于 spawn"。

#### 2.8.2 minimal 是文件态：预 seed，但无 pi 扩展面

minimal 在这两个探测点上的落位要分清，否则会和 §7.4/§8.2 打架：minimal **有会话文件，是文件态内核**，它的 `factory.seed` 返回会话 id（seed 是纯文件写、先于 spawn），所以它和 pi 同侧走预 seed 路径——`materializedLineageId` 在 spawn 前就是该 lineage 的 id（文件里已经有内容）。minimal 的 `capabilities` 是 **`{fileBacked: true}`**（没有 pi 的 `extensions` 扩展面 `steer`/`followUp`，也没有 dsh 的 `thinking` 面；**文件态是独立轴，经 `fileBacked` 显式声明，不借 `extensions` 当文件态代理**——§minimal-kernel 的"文件态能力位纪律"），所以壳对 minimal 的 `boundSessionPath` 指向 minimal 会话文件（`capabilities.fileBacked ? newSessionId : null`），**不是 null**。一句话把三个维度分开说，别混成一个：minimal 在"文件态/预 seed"上**像 pi**（都有会话文件、都先 seed 后 spawn）；在"`capabilities.extensions` 扩展面"上**像 dsh**（两者都无 pi 扩展面、`extensions` 都 undefined）；而在"专属扩展面"上 minimal **最简**——三者里只有它既无 `extensions` 也无 `thinking`。壳据此承接 minimal，全程不写身份分支——这就是 §2.3 论断的机制来源。

### 2.9 minimal 的模型与配置是自己的

#### 2.9.1 自己的模型配置文件：providers + default

minimal 有它自己的模型配置，格式是它自己定的。最简形态是一个 providers 列表加一个 default：每个 provider 有 id、baseURL、apiKey、一串模型；default 指向"新会话默认用哪个"。这份配置和 pi 的 models.json、dsh 的 settings.yaml 是同构的"内核自己的配置"，壳经 `KernelModelSource`（读清单）和 `KernelModelsApi`（读/写）访问它，不直接碰文件。

#### 2.9.2 真模型调用，SSE 流式

minimal 调的是真模型，走 OpenAI 兼容的 `/chat/completions` 端点，SSE 流式（`stream: true`）。没有"非流式先跑通"这回事——前几稿我把流式留成"以后再做"，那是偷懒。minimal 从第一版就流式，delta 增量直接进事件流，§4.7/§4.8 讲细节。

### 2.10 desktop 只是 minimal 的一个宿主

#### 2.10.1 minimal 能脱离 desktop 跑

这是 §2.1 的收口，也是 minimal 和"desktop 插件"的根本区别：minimal 的核心路径——起进程、读消息、调模型、写会话文件——不经过 desktop 的任何代码。把 desktop 整个拿掉，minimal 照样是一个能用的命令行 agent。裸跑形态具体是：minimal 是一个 CLI，stdin 一行一个 JSONL 命令、stdout 一行一个 JSONL 事件，人可以直接 `echo '{"type":"send","text":"你好"}' | minimal` 喂它一条消息，SSE 流式增量就是 stdout 上的一行行 JSONL。它**不内置 TUI**——TUI 是交互层的会变细节，不该进内核本体（和 §6.5"稳定 vs 会变"同一纪律）；真需要人机交互，就在外面套一个薄 REPL 脚本或让 desktop 当这个壳。裸跑形态的意义不在"好用人肉操作"，而在证明内核本体自足——它不欠 desktop 任何东西。

#### 2.10.2 desktop 托管它，和托管 pi/dsh 一样

反过来，desktop 托管 minimal 的方式，和托管 pi/dsh 一模一样：spawn 它的 cli、经适配器收发、把会话投影进中立层。desktop 不会因为 minimal 是"自己人写的"就少走一步，也不会因为它"简单"就多走一步。这一条是 §7 装配部分要逐项兑现的。

## 3. 会话文件：minimal 自己的线性存储

这一节讲 minimal 的存储本体——§1.1.2 说的"第二件事"。它是 minimal 和"验证假体"的分界，也是前几稿反复出错的地方：先是想让它跑在内存里不落盘，后来又让它存 parentId 叉树。现在两条都纠正过来：**它落盘，但存的是线性 lineage，不存 fork 树。**

### 3.1 minimal 的会话 = 头 + 一条活跃 lineage

#### 3.1.1 学公共 session 的形状，不另起炉灶

minimal 的会话文件虽然是私有的，它的语义模型直接照搬中立层已经定好的 canonical 形状（`neutral-session-first.md` §4）：一个会话由**头**和若干 **lineage** 组成，每条 lineage 是一串 **entry**，entry 里是 AI 消息。minimal 不发明"会话"的第二种定义，它只是把这个定义里"内核该有的那一份"落成文件。这是"珠玉在前，为啥不学"的正面答案：学中立层，不学 pi 的 parentId 树、不学 dsh 的 session forest。

#### 3.1.2 内核是单线执行器，只存活跃那条 lineage

`neutral-session-first.md` 把 fork 钉在壳侧，内核是单线执行器——它永远只物化**当前活跃的那条 lineage**。落到存储上就是：minimal 的文件里只有一条线，没有分支结构。发消息在这条线的末尾追加，fork 时壳在中立层切出新分支、把新分支投影给 minimal 的一个新会话文件，minimal 自己从不"内部开叉"。这一条决定了整个文件格式的简单程度。

### 3.2 目录、命名与文件布局

#### 3.2.1 会话根与 cwd 分桶

minimal 的会话根由 spawn 参数注入（`agentDir`），下面按 cwd 分桶，桶里一个会话一个文件。分桶不是抄 pi 的桶名规则（pi 是 `--<cwd去斜杠换横线>--`），而是"会话按项目归堆"这个业务本质的落地——同一个项目下的会话放在同一个目录里，方便列目录和项目统计。桶名的具体算法是 minimal 自己的实现细节，壳不关心，只经 `SessionCatalog.projectionPath(cwd, lineageId)` 拿结果。

#### 3.2.2 会话 id 由 neutralSessionId 确定性派生，幂等

minimal 的会话 id 不从时间戳或随机数来，而从 `neutralSessionId` 确定性派生——同一个中立会话，永远派生出同一个 minimal 会话文件路径。这是 `kernel-design-spec.md` §12.2 的幂等不变量：seed 两次、重开一次、切走再切回来，落到的是同一个文件，不会因为重复 seed 而堆出一堆副本。根 lineage 的 lineageId 就是 neutralSessionId，所以新会话文件路径恒等于"从 ns 派生"。

#### 3.2.3 一文件一会话，原子写

一个会话一个 JSONL 文件，文件名就是派生的会话 id。写文件用"写临时文件 + rename"或"追加 + 锁"保证不出现半截文件——进程被 kill 在写一半的瞬间，下次重开要么读到完整的旧态、要么读到完整的新态，不会读到半条 JSON。这是 §9.7 要守的边界，格式设计阶段就先把它考虑进去，而不是写完再补。

### 3.3 头行与条目行

#### 3.3.1 头行字段：type / id / createdAt / name / model / tools

第一行是头行，一个 JSON 对象：`type: "session"`、`id`（会话 id）、`createdAt`（创建时间）、`name`（会话名，改名时更新）、`model`（当前模型，切模型时更新）、`tools`（当前工具集，§5.5.2 切工具集时更新）。头行存的是"这个会话是谁、叫什么、现在用哪个模型、开着哪个工具集"，是重开会话时最先读的一行。它对应中立层 `NeutralSession.header` 的内核侧投影。

#### 3.3.2 条目行：最常见的 message 条目 + 分隔条目，线性序即父子

头行之后每一行是一个条目。最常见的条目是 `type: "message"`：`id`（条目 id）、`timestamp`、`message`（role + content，含 toolCall 块、usage、stopReason 等）。

> **`usage` / `stopReason` 已落地（本轮补）**：此前流式响应里的 `usage` 帧**从没解析过**、`finish_reason` 也没留 —— 文档写了、代码没有，属「文档说有、代码没有」的漂移。代价是连锁的两处功能缺失：① 会话的**文件统计基线**（壳侧 `SessionDetail.stats` 明写「message.usage 累加」）在 minimal 上恒空；② `projectStats` 恒返全零 → 壳把各内核的数字**相加**，于是 **minimal 的会话在统计面板里等于不存在**（dsh 由内核算、pi 有自己扫描，只有 minimal 是 0）。现在：请求带 `stream_options.include_usage`、解析 `usage` 归一成中性用量形状（圆心 `messageUsageOf` 是唯一解析处）、`finish_reason` 落成 `stopReason`；`projectStats` 从自己的会话文件算 sessionCount / turns / tokens（cost 留 0 —— 不做计价就不编造）。**拿不到就不写那个键**，不写 0（写 0 会被读成「这一轮真没花 token」）。除 message 外，还有几种**分隔条目**：`session_info`（改名）、`model_change`（切模型）、`tools_change`（切工具集），见 §3.3.3——它们的 `type` 不是 `message`，但也是文件里的一行条目，共同组成线性序列。所有条目都**没有 parentId**——因为文件里只有一条线，上一行天然是下一行的父，线性序本身就是父子关系，不需要再存一个指针。这是 minimal 和 pi 老格式最根本的区别：pi 用 parentId 是因为它一个文件里塞了整棵树，minimal 一个文件只有一条线，树已经在壳侧的中立层了。

#### 3.3.3 改名、切模型、切工具集怎么落盘：三种分隔条目

会话名、模型、工具集的变化，不覆盖历史消息，而是作为**分隔条目**追加进文件——改名字追加一条 `type: "session_info"`（带 `name`），切模型追加一条 `type: "model_change"`（带 `provider`/`modelId`），切工具集追加一条 `type: "tools_change"`（带工具集 id）。这样 `getEntries` 重放历史时，改名、切模型、切工具集的时点都能被还原成时间线上的分隔线，和 pi 的 `session_info`/`model_change` 条目、中立层的 divider 投影一一对应。头行里的 `name`/`model`/`tools` 字段是"当前值"的快照，条目是"变化的历史"。

### 3.4 分叉归壳：minimal 不存 fork 树

#### 3.4.1 fork 树在中立层，壳持有

fork 结构（哪条 lineage 从哪条 lineage 的哪个位置切出来）存在中立层的 `NeutralSession.lineages` 里，`neutral-session-first.md` §9 管它叫"切中立树"。minimal 的文件里没有 fork 结构，也不需要——它只存一条线，fork 是壳在中立层多出一条线、再把那条线投影成 minimal 的另一个会话文件。一个中立会话在 minimal 下可能对应多个文件（每条活跃过的 lineage 各一个），映射关系由壳的绑定表维护，minimal 自己只认"当前这一个文件"。

#### 3.4.2 seed：把活跃 lineage 的线性投影写进文件

`seed` 是 minimal 接收"该跑哪条线"的入口：壳把活跃 lineage 的**纯 AI 内容**（过滤掉展示元数据，`neutral-session-first.md` §10）投影成一串 `NeutralEntry`，交给 minimal 的 `seed`，minimal 把这串内容写成它的会话文件。投影规则（压缩截断 + role 白名单）在壳侧的单源 `assembleSeedProjection` 里，minimal 的 seed 只做"把给到的条目序列落盘"，不再自己过滤一遍——这是契约单源，避免壳和内核各写一份过滤规则。

#### 3.4.3 getTree / getEntries 是灾难恢复面，主路径走中立层

minimal 的 `getTree` 返回单 lineage 树（`{rootId, [{id, fork: null}]}`），`getEntries` 读文件的线性消息序列。这两条不是壳读会话内容的主路径——`session-store.ts` 的 `neutralMessagesOf`/`neutralTreeOf` 已经改从中立层读，内核的 `getEntries` 降级为"中立层缺失时的灾难恢复面"。所以 minimal 的 `getTree`/`getEntries` 只要诚实、简单，不需要还原 fork 树——树本来就不该在内核侧。顺带把 `bookmark`/`resume`/`deleteBookmark` 的实现也钉死：和 pi 的终态一致，**只存中立坐标、不拷副本**——`bookmark(lineageId, boundary)` 返回 `Anchor{lineageId, entryId: boundary}`，`resume(anchor)` 返回 `anchor.lineageId`（minimal 是单线执行器，没有别的分支可重开），`deleteBookmark` 是 no-op。三者在 `MinimalBackend` 里都是一两行的纯坐标往返，没有文件副本、没有 fork 重建。

#### 3.4.4 投影与真相源的一致性：上行同步谁执行、冲突谁为准

minimal 文件是中立层的投影，投影和真相源之间必然有"会不会漂、漂了怎么收"的问题。前几稿只把两边写成"两条独立路径、经上行同步对齐"，却从没展开"上行同步"到底是谁在什么时候做什么——这是盲审确认的缺口，这里补齐。

- **下行（真相源 → 投影）**：壳先把用户消息写进中立层（乐观写），再投影纯 AI 内容，经 `sendMessage`/`seed` 交给 minimal，minimal 写成自己的文件。下行是"壳发起、minimal 落盘"，方向单向。
- **上行（投影 → 真相源）**：minimal 跑回合时发事件（`messageEnd`/`entryAppended`/`toolCallEnd`），壳的 `session-store` 在 `dispatch` 里把这些事件 append 进中立层。**执行者是壳，不是 minimal**——minimal 只发事件、只写自己的文件，它从头到尾不知道中立层的存在。这正是"内核不感知宿主"的边界：一致性由壳维护，minimal 不掺和。
- **冲突谁为准**：中立层是 canonical（`neutral-session-first.md` §2 钉死"会话的真相源是中立层，pi/dsh 是它的投影"）。两边不一致时，以中立层为准，minimal 文件是可丢弃、可重建的投影——`seed` 就是"从中立层重建 minimal 文件"这个动作本身。
- **谁检测、怎么修**：这里要明确一个取舍——**本设计不设主动检测器**。没有"比对两边、发现漂移、触发修复"的闭环。漂移只在**进程已死的故障态**发生（崩溃丢尾部、写一半被 kill）；而进程活着时的"落盘时序竞态"（事件先发、条目没写穿）不是靠事后重建，是靠 §4.3.3 的顺序不变量**预防**——写穿先于发事件，保证活着时两边不漂。所以"不检测"成立的前提是两层，别混为一谈：**活着时靠顺序不变量预防，死了时靠下次重开/seed 无条件重建**。时序竞态是预防掉的，不是"发生了等重建"；重建只兜底崩溃/半写这种进程已死、预防无从谈起的故障态。用"检查点上的无条件重建"替代"持续检测"，是因为重建便宜（§9.4 说文件存得越少重建越便宜）、而持续比对要成本。读者别误以为存在一个"检测到漂移→触发重建"的闭环——重建的触发是外部时机（重开/切内核），不是内部比对结果。

## 4. 运行时：会话循环与模型（SSE 流式）

这一节讲 minimal 的运行时本体——§1.1.1 说的"第一件事"。它是一条消息从进来到变成一串事件、落进会话文件、再回到静默的完整路径。

### 4.1 进程与握手：spawn 之后怎么 ready

#### 4.1.1 起子进程的入口与参数

minimal 是一个独立进程，入口是它的 cli。spawn 参数里带会话根、要打开/新建的会话 id、模型偏好（provider/model）、system prompt 路径。这些是 minimal 的私有启动参数，由适配器的工厂闭包拼装，不进中立契约——和 pi 的 `--session`、dsh 的 `cordisConfig` 是同一层的东西，`kernel-design-spec.md` §10 讲得很清楚。

#### 4.1.2 就绪信号：一条探测命令，不赌固定 sleep

进程起来不代表就绪。minimal 遵循 §3.6 的事件驱动纪律：壳起完进程后发一条探测命令（比如 `ping`），以探测响应为准判定就绪，不赌"起 150ms 就 ready"这种固定延迟。pi 的 `start` 就是这条纪律的现成例子（`get_state` 探测，4s 上限），minimal 照做，只是命令名是它自己的。

### 4.2 协议：命令进、事件出

#### 4.2.1 JSONL 行协议，一行一个完整对象

minimal 的协议是 JSONL 行协议：stdin 一行一个命令对象，stdout 一行一个事件对象。没有分帧长度前缀、没有请求 id 配对（minimal 是单线执行器，同一时刻只有一个回合在跑，命令和事件天然顺序对应），所以协议能压到最简。协议是 minimal 的私有契约，收在 minimal 自己的协议层，壳经适配器翻译，不直接消费。

#### 4.2.2 命令清单：send / abort / setModel / setTools / getTree / getEntries / seed …

命令就是 §1.1 那三件事的协议化：`send`（发消息，带文本）、`abort`（中断当前回合）、`setModel`（切模型）、`setTools`（切工具集）、`setSessionName`（改名）、`listTools`（查当前工具清单）、`getTree`/`getEntries`（灾难恢复读）、`seed`（灌入活跃 lineage）、`ping`（就绪探测）。这套清单对齐的是 `BaseBackend` 的意图集合，不是 pi 的 31 命令——minimal 只实现它自己需要的。

#### 4.2.3 事件清单：十种事件，一份常量，无省略号

minimal 的事件就是下面这份完整清单，一行一个，一共十种，没有省略号：`sessionStart`（会话换绑/水合）、`agentStart`/`agentSettled`（回合边界）、`messageStart`/`messageUpdate`/`messageEnd`（消息流式三态）、`toolCallStart`/`toolCallUpdate`/`toolCallEnd`（工具调用三态）、`entryAppended`（条目落盘）。这十种是 minimal 的事件常量，单一来源（**已落地**：`kernel/minimal-events.mjs` 的 `EVENTS`/`EVENT_NAMES`/`SUBSCRIBABLE_EVENTS`，CLI 与插件系统都从它取，谁都不手拼字符串），§6.2.3 的插件可订阅清单就从这里取。

> **漂移记录（勿重蹈）**：这份清单曾有三种事件**从没被发出过**（`sessionStart` / `toolCallUpdate` / `entryAppended`）——壳侧的透传白名单、插件可订阅清单、上行同步分支全都列着它们，却永远不触发：「订阅了一个永不触发的事件」是最难查的一类静默失效（没有任何报错）。现在三种都真的发：`sessionStart` 在插件加载 + 头行读完之后发一次；`entryAppended` 在**每条条目写穿之后**发（§4.3.3 顺序不变量）；`toolCallUpdate` 由模型客户端的参数分片回调驱动（`streamModel` 的 `hooks.onToolCallDelta`，累积快照）。
> **守卫**：`minimal-events.test.ts` 断言①常量清单恰好是文档那十种、②一次带工具调用的真实回合里十种**全部实际发出**（多一种少一种都红）、③`toolCallUpdate` 真的带分片（不是把 Start 复制一遍）、④订阅边界（未知事件名、过程事件均显式拒绝）。它们是适配器翻译成中性 `SessionEvent` 的原料。minimal 的事件名可以和中性事件同名，也可以不同名——适配器负责对齐；同名只是省翻译，不是必须。

### 4.3 agent loop：一条回合从收到落定

#### 4.3.1 收到 send：落 user 条目 → 发事件 → 进入回合

收到 `send`，minimal 先把这条用户消息落成会话文件里的一条 user 条目（先落盘再进回合，保证中途崩溃历史也在），然后进入回合。注意这里的顺序和壳侧"乐观 user 先写中立层"（`neutral-session-first.md` §8）是两条独立路径：壳写壳的中立层，minimal 写 minimal 的文件，两者经上行同步对齐，minimal 不感知壳的中立层。

#### 4.3.2 模型可能返回 tool_call → 执行 → tool_result → 再调模型，直到最终答案

回合不是一次模型调用，而是一个循环：组请求、调模型，如果模型返回 `tool_call` 就执行工具、把 `tool_result` 喂回模型、再调，直到模型吐出纯文本的最终答案。这个循环是工具系统（§5）和 agent loop 的交界——loop 负责"循环和终止"，工具系统负责"定义和执行"。终止条件（最大轮数、用户中断）在 §5.10。

#### 4.3.3 收尾落定：agentSettled，文件写穿

最终答案落成 assistant 条目、写进会话文件，发 `agentSettled` 收尾。一条回合结束。落盘的时机要保证"事件发出时，对应条目已经写穿"——否则壳侧按事件 append 进中立层、回头读 minimal 文件发现缺条目，两边就漂了。这个"壳侧 append、minimal 侧写盘"的双写一致性，机制在 §3.4.4。

### 4.4 组请求：system prompt + 历史 + 工具定义 + 用户文本

#### 4.4.1 历史从哪来：会话文件里的线性 lineage

组请求的历史，就是 minimal 自己会话文件里的那串线性消息。minimal 不需要去壳的中立层拿历史——它自己文件里就有（seed 灌进来的 + 本进程追加的）。这是"内核有自己的存储"的直接好处：组请求不依赖宿主。

#### 4.4.2 工具定义注入：把活跃工具集的 schema 送进请求

组请求时，把当前活跃工具集的 JSON Schema（name/description/parameters）作为 `tools` 字段送进请求，模型才知道能调什么工具。这是 §5.2"注入工具"的落点：工具不是写在 system prompt 里的文字，是结构化 schema 随请求一起发。切工具集 = 换这份 schema。

#### 4.4.3 system prompt 注入：进程参数，不是会话数据

system prompt（角色卡、全局系统提示）是进程参数，spawn 时由壳经私有参数传入，不是会话文件里的条目。它有两种形态：全局 system prompt 走**文件路径**（`systemPromptPaths`，spawn 参数里带路径），角色卡走**内联文本**（壳的 `roleToPrompt` 把角色卡拼成一段文本，作为 spawn 参数直接传，不落文件）。两种都是 spawn 参数、都指向"这个进程怎么想"，不是"这个会话聊了什么"，所以不进会话存储。这条对齐 pi 的做法——pi 的 `--append-system-prompt` 既收文件路径也收内联文本，minimal 照这个语义来。

### 4.5 事件流：流式增量

#### 4.5.1 agentStart / agentSettled 界定回合

`agentStart` 标志一条回合开始，`agentSettled` 标志收敛结束。两者之间是这一回合的全部事件。壳靠这两个边界判断"是否在生成中"（`isBusy`）、"在飞回合是否落定"（`waitSettled`），所以这两个事件必须严格成对、不重不漏。

#### 4.5.2 messageStart → messageUpdate(delta) → messageEnd 的流式形态

流式下，一条 assistant 消息不是一次性出现的：`messageStart` 开一个占位，之后每个 SSE delta 发一个 `messageUpdate`（带增量文本），最后 `messageEnd` 带完整消息收口。壳的 timeline 靠这一串把 token 级增量渲染成逐字滚出的效果。这是 minimal 走 SSE 流式的直接收益——非流式只有 `messageStart` 和 `messageEnd`，中间的增量全没了。

#### 4.5.3 toolCallStart / toolCallUpdate / toolCallEnd 与工具回环

工具调用在事件流里有独立形态，三个事件合起来是工具调用的完整三态：模型决定调工具时发 `toolCallStart`（带 toolCallId、toolName、args），参数分片流式到达时发 `toolCallUpdate`（§4.8.2 的增量），执行完发 `toolCallEnd`（带 result/isError）。它们嵌在 messageStart/messageEnd 之间，timeline 据此把工具卡片渲染成"调用了什么、参数怎么流式、结果如何"。

### 4.6 错误与中断

#### 4.6.1 模型失败：messageEnd 带 error，还是 agentSettled 带 reason

模型调用失败（超时、HTTP 5xx、连接重置），minimal 发一个带 `error: true` 的 messageEnd 收口这条空消息，再发 `agentSettled`（reason 标错误）。两个信号各司其职：messageEnd 的 error 驱动 timeline 的红条（"这条回复失败了"），agentSettled 的 reason 驱动壳判断"回合异常停机"。不能只发一个——壳的 `waitSettled` 和 timeline 各读一个。

#### 4.6.2 用户中断：abort → stopped，历史怎么落

收到 `abort`，minimal 用 AbortController 掐断在飞的 HTTP 请求，把已收到的部分内容落成一条 `stopped: true` 的 assistant 条目，发 messageEnd + agentSettled。已收到的部分内容要保留（用户能看到"生成到一半"），但标记 stopped 而不是 error——用户点停止不是错误，`session-state.ts` 的 `withTerminalState` 把这条语义钉死了。要显式收口一句：**abort 只掐 HTTP（在飞的模型请求/SSE 流），不覆盖正在执行的工具**。工具执行期的强制终止只走 §5.3.2 的 per-tool 超时（30 秒 kill）；用户点 abort 时，一个正在跑的 bash 会自己跑完（或到超时被 kill），abort 只保证"执行完当前工具不再进下一轮"（§5.10.2）。这两条路径别混——读者若以为 abort 覆盖一切，会误判工具执行期的中断语义。

#### 4.6.3 子进程崩溃：壳侧怎么收尾

minimal 进程 crash（OOM、未捕获异常），壳经进程退出事件收尾：把当前回合标记为失败、广播 `processExit`、允许用户重开。这是壳的机制，不是 minimal 的——minimal 只负责"尽量别崩、崩之前把文件写穿"，壳负责"崩了之后怎么办"。§9.7 讲崩在写一半的边界。

### 4.7 模型客户端：OpenAI 兼容，SSE 流式

#### 4.7.1 /chat/completions 流式请求（stream: true）

模型客户端是一个极简的 HTTP 客户端，只调 OpenAI 兼容的 `POST /chat/completions`，`stream: true`。请求体是标准的 messages + model + tools。不抽象成"多 provider 多协议"的网关——minimal 第一版只认 OpenAI 兼容这一种，这是"最简"的取舍，§9.1 讲代价。

#### 4.7.2 SSE 解析：data 行的 delta 增量

响应是 SSE：若干 `data: {...}` 行，最后 `data: [DONE]`。客户端逐行解析，每个 data 对象里的 `choices[0].delta` 就是增量——可能是 `content`（文本增量），也可能是 `tool_calls`（工具调用增量）。解析逻辑是 minimal 的私有实现，收在模型客户端里。

#### 4.7.3 超时、重连与 AbortController

模型客户端要处理三件事：超时（多久没数据就算卡死）、重连（流中途断了怎么办）、中断（`abort` 命令 → AbortController 掐断）。重连是第一版可以显式降级的能力（断了就按失败收尾，不静默伪造"重连成功"），但超时和中断是必须的——没有它们，一个卡住的模型调用会永远占住 minimal 的进程。

### 4.8 流式 SSE：delta 怎么转成事件

#### 4.8.1 文本 delta → messageUpdate

每个 `delta.content` 片段，转成一个 `messageUpdate` 事件（带这段文本）。文本增量是流式的主体，逐字滚出的效果就来自这里。收到第一个 content delta 前先发 `messageStart`（开占位），`[DONE]` 后发 `messageEnd`（带完整文本收口）。

#### 4.8.2 tool_call delta → 按 index 缓冲聚合

SSE 里的 `tool_calls` 是分片到达的：同一个 tool_call 的 `id`、`function.name`、`function.arguments` 各是 delta 里的一小片，多个 tool_call 并发时分片按 `index` 交错到达。聚合算法钉死如下：

- **按 index 维护缓冲**：客户端持一个 `Map<index, {id, name, arguments}>`。遇到一个新的 index 就建一个缓冲；`delta.id` 和 `delta.function.name` 直接写进对应缓冲。
- **arguments 是追加拼接，不是覆盖**：`delta.function.arguments` 是字符串分片，每次到达都 `buffer.arguments += delta.function.arguments`。这是聚合里最容易写错的一处——覆盖会让参数只剩最后一片，追加才对。
- **toolCallStart 的时机**：某 index 的 `id` 首次到位时，发 `toolCallStart`（带 toolCallId、toolName、已到的 args）。这是"模型决定调这个工具"的信号。
- **toolCallUpdate 的时机**：之后该 index 的 arguments 分片继续到达，发 `toolCallUpdate`（带增量片段），供流式展示参数。

聚合的复杂度和正确性要求，正是 §9.1.1 说的"SSE 解析最易出错"的代价，这里把它从"容易错"落成"怎么才对"。

#### 4.8.3 [DONE] → 分片到齐，执行工具，再收口

`data: [DONE]` 是这条 assistant 消息流结束的唯一信号，它的语义是**所有分片（文本和所有 tool_call 的 arguments）都到齐了**——不存在"`[DONE]` 之后还有分片"的合法时序，任何在 `[DONE]` 之后到达的分片按协议错误丢弃。收到 `[DONE]` 后：发 `messageEnd`（带完整消息：全文 + 若有的完整 tool_call 列表）；若有 tool_call，进入 §5.3 的工具执行，每个工具执行完发 `toolCallEnd`（带 result/isError），全部执行完回到 §4.3.2 的循环再调模型；没有 tool_call 就直接 `agentSettled` 收尾。这样三个事件的语义完全对齐：`toolCallStart` 是"决定调"、`toolCallUpdate` 是"参数流式"、`toolCallEnd` 是"执行完"。

### 4.9 模型配置：providers + default

#### 4.9.1 minimal 自己的模型配置与凭证，分开存

minimal 的模型配置是它自己的 JSON：providers 列表（id、baseURL、models）+ default（provider + model）。注意这份文件里**没有 apiKey**——apiKey 落在另一份独立的凭证文件里（minimal 自己的凭证库，形如 `~/.minimal/.credentials`），配置里只留 provider/baseURL/models，不留明文密钥。这个拆分不是 minimal 的发明，是学 dsh 已经落地的做法：dsh 的密钥持续写入者是适配器 `DshConfigSource` 的 `setProvider`/`renameProvider`/`removeProvider` 三处，凭证路径由注入的 `settingsPath` **派生**（`dirname + ".credentials.yaml"`），spawn 不注入任何进程 env。minimal 照搬这条"凭证与配置分离"的路，理由和 dsh 完全一样——密钥不该以明文躺在会进列表、会进日志的配置里。

#### 4.9.1b 内置 offline provider：`echo`（**这一条是补的裁决，此前文档没写、代码有**）

代码里一直存在一个"没配置任何 provider 时也能发消息"的回显回落（`minimal-cli.mjs` 的 `[minimal echo] ${text}`），
且 `MinimalModelSource` 在无配置时会交出 `{ provider: "minimal", id: "echo" }` 这个模型。文档此前对**它到底算不算模型**没有表态，
于是形成一个说不清的中间态：它既不是"空清单"（下拉里看得见、选得中），也不是"真清单"（它不来自任何配置文件）。

这里给出裁决，二选一而不是含糊：**算模型，写进文档，并说明它是什么。**

- **它是什么**：minimal 的**内置 offline provider**，id `minimal`、模型 id `echo`。语义是"这个内核在没有配置任何外部模型时的确定性回显能力"——
  不是某个大模型的替身，是内核自己实现的一等行为（真进程、真 JSONL 事件流、真落盘、逐字流式）。
- **为什么保留**：§2.10.1「脱离 desktop 也能用」要求 minimal 在**零配置**的干净机器上就能完整跑通一轮（起进程 → 收消息 → 出事件 → 写会话文件）。
  若没有它，一个刚装好的 minimal 连一条消息都发不出去，"独立内核"的最低验收线就没有可执行形态。
  它同时是 desktop 侧**零 token** 端到端测试的唯一通路（`minimal-smoke.e2e.mjs` 真 app 真发送，不花任何模型费用）。
- **为什么必须写进文档**：编程纪律里"桩不许伪造成功"（§7.9.3）针对的是**声称做了而没做**。
  echo 没有声称自己是别的模型：模型 id 就叫 `echo`、回复正文自带 `[minimal echo]` 前缀、消息的 `model` 域写着 `minimal/echo`。
  它的问题从来不是"假"，而是"**文档没说它存在**"——那条灰色地带才是隐患（下一个人会以为它是 bug 而删掉，删掉即打断零配置可用性）。
- **边界**：一旦配置了任何 provider，`echo` 就不该再作为可选项干扰选择——回落只在"没有任何 provider"时生效；
  有配置但 provider 名写错时**不回落**（那是配置错误，必须显式报错，见 §4.6.1 的失败不静默）。

> 裁决的落点：`src/server/kernel/minimal/manager/minimal-models.ts`（`MinimalModelSource` 的无配置分支）
> 与 `src/server/kernel/minimal/kernel/minimal-cli.mjs`（回落分支）。守卫：`minimal-models.test.ts`。

#### 4.9.2 apiKey 的完整生命周期：子进程自读，永不进 spawn / 事件 / 文件

这条单独成条，因为它在前几稿里整段缺失，是盲审确认的真实缺口。apiKey 的四段生命周期钉死如下：

- **从哪来**：用户在设置页填 apiKey，经壳的 `KernelModelsApi.set` 进来。这是 apiKey 唯一的人口。
- **存哪**：apiKey 由 **minimal 侧的适配器**（`MinimalModelsApi`，位于 `src/server/kernel/minimal/`）写进 minimal 的凭证文件，模型配置文件里不落明文。这里要把"私有知识"的归属说清楚，否则会和"适配器写"自相矛盾：凭证文件路径是 minimal 侧的私有知识，意思是**壳的 application 层**（session-store、controllers）不知道也不碰这个路径，但 minimal 侧的适配器是知道的——路径经工厂闭包注入给适配器（可以像 dsh 一样注入模型配置路径、凭证路径由 `dirname + ".credentials"` 派生，也可以直接注入凭证路径，两种都是"适配器知道、application 层不碰"）。所以"写入者 = minimal 侧适配器、路径经闭包注入、壳 application 层不碰"，三者不冲突。
- **怎么传给子进程**：**不传。** spawn 参数里没有 apiKey、进程 env 里也没有。minimal 子进程启动时自己读自己的凭证文件，靠"进程读自己的私有文件"拿到密钥。这比"经 spawn 参数或 env 注入"干净——密钥不出现在进程列表、不出现在 shell history、不出现在任何 IPC 层。写盘的和读盘的分离：适配器写、子进程读，中间不经过任何通信通道。
- **怎么防泄露**：apiKey 永远不写进会话文件（会话文件只存 role/content 这些对话内容，§3.3 的条目行字段里没有 apiKey 的位置）；永远不写进 stdout 的事件流（事件是给壳翻译用的对话增量，不含凭证）；永远不打进日志。没有这些约束，一个"把整个请求体打出来 debug"的日志就会把密钥带出去。

#### 4.9.3 KernelModelSource 从配置读清单

minimal 交一个 `KernelModelSource` 实现，`listModels()` 把配置里的 providers 展平成带 `kernel: "minimal"` 标的 `ModelInfo[]`，喂给壳的 `ModelCatalog` 合流。合流后 minimal 的模型就出现在会话流的模型下拉里，和 pi/dsh 的模型并列——这是 minimal 能被用户选中的前提，也是 `kernel-design-spec.md` §11 的契约兑现。

### 4.10 模型切换：setModel

#### 4.10.1 setModel 落 header

收到 `setModel(provider, modelId)`，minimal 把模型写进会话文件的头行 `model` 字段，并追加一条 `model_change` 条目（§3.3.3）。头行是"当前值"，条目是"变化历史"，两者都写，重开时头行恢复当前模型、条目还原切换时点。

#### 4.10.2 生效于后续回合，不重写历史

切模型只影响**之后**的回合，不回头改已经生成的历史消息。历史里的 assistant 消息带着它生成时的 model 标（`message.model`），切换后旧消息的模型徽章不跟着变——`session-state.ts` 的 `NeutralMessage.model` 把这条语义钉死了：模型是"执行时的模型"，不是"当前的选择"。

## 5. 工具系统：注入 / 切换 / 工具集

工具系统是 minimal 的第三台机器。它在本文的前几稿里被整块砍掉过——"工具留作扩展点，不进 MVP"——那是错的。注入工具、切换工具、设置工具集，是一个 agent 内核的立身之本，不是锦上添花。这一节把工具系统完整设计出来。

### 5.1 工具是什么：minimal 自己的工具定义

#### 5.1.1 工具 schema：name / description / parameters

一个工具，对模型而言是三个字段：`name`（唯一名）、`description`（什么时候该用它）、`parameters`（JSON Schema，描述入参形状）。这三样组成了送进模型请求的 `tools` 数组。schema 是工具对模型的"说明书"，模型据此决定"要不要调、怎么填参"。

#### 5.1.2 工具实现：一个可调用的函数，进 / 出都是 JSON

对 minimal 而言，一个工具是 schema 之外再加一个实现：一个函数，入参是模型填的 arguments（JSON 对象），出参是结果（JSON 对象或字符串）。schema 面向模型，实现面向执行——两者成对注册进工具注册表。进/出都是 JSON 是硬约束，因为 tool_result 要原样回喂给模型，非 JSON 的返回值会污染下一轮请求。

### 5.2 注入工具

#### 5.2.1 把活跃工具的 schema 送进模型请求

"注入工具"就是把当前活跃工具集的 schema 放进每次模型请求的 `tools` 字段。这个动作发生在 §4.4.2 的组请求里，是工具系统对 agent loop 的唯一侵入点。注入的是 schema 不是实现——实现永远留在 minimal 进程内，模型只拿到"能调什么"，拿不到"怎么执行"。

#### 5.2.2 模型返回 tool_call，minimal 按 name 分派

模型决定调工具时，返回一个 `tool_call`（带 id、name、arguments）。minimal 拿 name 去注册表查实现，用 arguments 调它。查不到 name（模型幻觉出不存在的工具）就回一个"unknown tool"的 tool_result，不静默、不伪造成功——让模型看到自己调错了，下一轮它自己会修正。

### 5.3 工具执行

#### 5.3.1 tool_call → 执行 → tool_result 回喂模型

工具执行的闭环是：`tool_call` → 查注册表 → 执行实现 → 把结果包装成 `tool_result`（带 toolCallId，role 对齐模型协议的 tool 消息）→ 追加进请求历史 → 再调模型。这个闭环是 §4.3.2 那个循环里的一拍，工具系统只负责"定义、查找、执行、包装"，循环的推进由 agent loop 管。

#### 5.3.2 执行失败 / 超时怎么表达

工具执行失败（抛异常、超时），不把异常吞掉，而是把失败信息作为 tool_result 回喂——`isError: true` 加上错误文本。模型看到失败结果，下一轮可以决定重试、换参数、或者换个工具。这里的关键是"失败也是结果"，回喂失败比静默跳过更能让模型走出死胡同。超时必须是**被强制**的，不是等工具自己返回：每个工具执行包一个 per-tool 超时（默认 30 秒），超时强制终止它——kill 它起的子进程、取消它挂起的 IO。没有这个强制，一个 `bash` 跑 `while true` 或读一个永不返回的 pipe，会把整个 minimal 进程永久卡死，超时机制无从触发。

> **已落地，并连带修掉一个更根本的冲突（勿回退成同步执行）**：上面那句"超时机制无从触发"此前**字面成立**——`bash` 用的是 `execFileSync`（同步阻塞），于是不只是工具不会超时，而是**整个 CLI 事件循环被占住、连 stdin 都读不到**：§4.6.2 写的「用户点 abort 时，正在跑的 bash 会自己跑完或到超时被 kill」根本不成立（abort 命令进不来）。现在工具一律**异步**（`fs/promises` + `child_process.execFile`），per-tool 超时由 `withTimeout` 强制：到点 kill 该工具起的全部子进程并以 `isError:true, timeout:true` 回喂模型。`write` 是异步的这一点还顺带满足了"取消它挂起的 IO"——同步读一个 FIFO 同样会占死事件循环。
> 守卫：`minimal-tool-runtime.test.ts`（超时被强制执行且标 timeout / 超时真的 kill 掉子进程不留孤儿 / **bash 在跑时 `ping` 仍能即时得到 `pong`**——最后一条就是"事件循环没被占住、abort 语义成立"的判据）。红绿证明：把 `bash` 改回 `execFileSync`，三条全红，且超时那条实测等了 **30019ms**（= 命令自己跑完的时间，证明包装确实无从触发）。

### 5.4 工具切换

#### 5.4.1 启用 / 禁用单个工具

工具可以逐个启用、禁用。禁用的工具不进下一次组请求的 `tools` 数组，模型就"看不到"它、自然也不会调它。启用/禁用是运行时状态，存在会话或进程里，不落进工具定义本身——同一个工具定义，在不同会话里可以是启用或禁用的。

#### 5.4.2 切换生效于当前会话的后续回合

切换工具和切模型同一语义：影响之后，不回头改历史。历史里的 toolCall 条目带着它发生时的工具状态，切掉某个工具不会让已经发生的调用凭空消失。这条和 §4.10.2 是同一纪律，工具状态是"后续回合的注入清单"，不是"历史的过滤器"。

### 5.5 工具集

#### 5.5.1 工具分组：一个工具集是一组工具

工具集是把若干工具打包成的一个命名组。用户不需要逐个开关工具，而是选一个工具集——"只读集"（read、list、grep）、"写文件集"（再加 write）、"全功能集"（再加 bash）。一个工具可以属于多个工具集，工具集是工具的索引视图，不是工具的重新定义。示例里的工具都来自 §5.8.1 的首批内置集，不出现未定义的工具名。工具集的身份要钉死：每个工具集有一个**稳定 id**（存储和切换用，如 `read-only`/`write`/`full`）和一个展示名（给人看，就是上面"只读集"这些），头行的 `tools` 字段和 `tools_change` 条目存的是 **id**，展示名只在 UI 层解析——存储用 id 不用名，因为名是会变的文案，id 才是稳定契约。

#### 5.5.2 设置 / 切换工具集

`setTools` 命令切换当前活跃工具集。切换后，下一次组请求注入的是新工具集的 schema。工具集是会话级状态（像 model 一样），存进会话文件头行，重开会话时恢复——用户上次开着"写文件集"，下次打开还是"写文件集"，不退回默认。切换的**历史痕迹**和切模型对齐：头行更新当前值，同时追加一条 `tools_change` 分隔条目（像 §3.3.3 的 `model_change`），这样重放历史能还原"哪个时刻切了工具集"——只更新头行、历史不留痕，重放时工具集的时点就丢了。

### 5.6 工具与会话配置的关系

#### 5.6.1 映射到 SessionToolConfig / listTools

minimal 的工具面和壳的中立契约有两处对接：`listTools`（可缺面）返回 minimal 当前可用的工具清单（`KnownToolInfo[]`），壳据此在工具管理页渲染；`SessionToolConfig`（`enabledToolIds`）是壳下发的"启用哪些工具"的配置，minimal 的适配器把它翻译成 minimal 自己的工具集/开关语义。壳不直接操作 minimal 的工具注册表，只经这两个中立面。`listTools` 的数据来源是 minimal 的协议命令（§4.2.2 命令清单里的 `listTools`）：适配器发这条命令，minimal 返回自己工具注册表的投影——工具注册表在 minimal 子进程内，不经协议命令是拿不到的。

#### 5.6.2 壳怎么读 minimal 的工具清单

壳读 minimal 的工具清单，走 `backend.listTools()` 这条可缺面契约。minimal 实现它，返回自己的工具清单（name/description/source）；如果 minimal 没实现（理论上），壳走降级——工具管理页隐藏或置灰，不静默、不伪造。minimal 第一版就实现它，因为工具系统是本体不是扩展。

### 5.7 工具的安全边界

#### 5.7.1 哪些工具能跑、怎么隔离

工具是要执行的代码，安全边界必须显式。minimal 的工具分三档：纯只读（read/grep，无副作用）、受控写（write，限定在项目目录内）、危险（bash，可执行任意命令）。

> **受控写已落地（勿放宽成裸路径）**：`write` 此前是裸 `writeFileSync(String(args.path))`，绝对路径与 `..` 都能写穿项目目录——而它的档位标的是 `write`（受控）不是 `dangerous`，文档对它的承诺是"限定在项目目录内"。现在路径统一经 `resolveInsideProject` 解析，越界即 `isError`。判定用 `relative` 而不是 `startsWith(项目根)`：后者会把 `/proj-evil` 当成 `/proj` 内部（前缀相同但不是子目录），正是路径门最常见的假阴性。另有一个明确取舍：**不自动建父目录**（不做隐式 `mkdir`）——隐式创建会让"路径写错"看起来像成功。守卫见 `minimal-tool-runtime.test.ts`。每档有不同的默认策略——只读默认开、受控写默认可开、危险默认关且需显式启用。档位是工具定义上的语义字段，不是外挂的 kind 戳（`kernel-design-spec.md` 反模式 §28 的同一纪律）。这里要诚实交代隔离的边界：第一版工具**同进程执行**，隔离是"档位门控（软约束）+ per-tool 超时强制终止（§5.3.2）"，**不做 OS 级沙箱**（没有子进程隔离、没有 seccomp/chroot/容器）。这意味着一旦用户显式启用 bash，一个 `rm -rf /` 会真实作用于宿主机文件系统，minimal 拦不住。这是明确的取舍，不是遗漏——§9.2.1 已经把"安全边界"列为工具系统最大的代价，第一版接受这个代价，OS 级沙箱留作后续（§10 的 QA 也会再答这条）。

#### 5.7.2 危险工具的门控

危险工具（bash 这类）不进任何默认工具集，用户必须显式选"全功能集"或逐个启用。门控落在工具集的设计里（危险工具只出现在显式的危险集里），而不是散在调用点各写一遍 if。这样门控是数据（工具属于哪个集），不是代码分支。

### 5.8 内置工具的最小集

#### 5.8.1 首批内置哪些工具

minimal 的首批内置工具给一个最小可用集：`read`（读文件）、`list`（列目录）、`grep`（搜内容）、`write`（写文件）、`bash`（执行命令）。这五个覆盖"读项目 → 改代码 → 验证"的最短闭环。不是每个工具都要从第一天就做全，但这五个是"真能用"的底线——没有 read/write，模型就只是个聊天机器人。

#### 5.8.2 内置工具与插件工具同构

内置工具和插件工具走同一个注册表、同一种 schema、同一种执行接口。内置只是"随 minimal 一起装、默认可用"，插件是"后加载、可卸载"。两者同构的意义在于：工具系统不区分"官方"和"第三方"，注册表一视同仁——这是 §1.4 无特权差异在工具层的落地。

### 5.9 工具注册：内置 + 插件

#### 5.9.1 工具注册表

工具注册表是 minimal 进程内的一个 map：name → { schema, 实现, 档位, 来源 }。内置工具在启动时注册，插件工具在插件加载时注册，禁用只改"活跃集"不改注册表。注册表是工具系统的单源，`setTools`/`listTools`/工具执行都从它查。

#### 5.9.2 插件怎么往注册表加工具

插件往注册表加工具，走的是插件系统的接口（§6.3.1）：插件在加载时声明自己提供的工具（schema + 实现），插件系统把它们注册进工具注册表。卸载插件时，同步从注册表撤掉它注册的工具，并把它参与的活跃工具集里的对应项摘除——不留"插件已卸载、工具还悬在注册表"的孤儿。

### 5.10 工具回环的终止条件

#### 5.10.1 最大 tool_call 轮数，防死循环

工具回环（模型调工具 → 执行 → 再调 → 再调工具…）必须有一个硬上限，否则一个"执行失败又反复重试"的工具会让回合永远不收敛。minimal 设一个最大轮数（比如 8 轮），超过就强制收尾：把最后一轮的结果落成 assistant 消息，发 `agentSettled`（reason 标"达到工具轮数上限"）。上限是配置不是写死，但默认值必须存在。

#### 5.10.2 用户中断回环

用户在工具回环中途点停止，`abort` 不仅掐断当前模型调用，还要掐断"这个回合的整个循环"——执行完当前工具不再进下一轮，直接按 interrupted 收尾。这条和 §4.6.2 是同一个中断语义，只是作用范围从"一次调用"扩到"整条回环"。

## 6. 插件系统：一个可拆分的独立模块

插件系统是 minimal 的第四台机器，也是边界最要划清的一台。它不是"以后再考虑"的东西——它现在就要作为一个独立模块设计好，因为将来可能要把它整个拆出去单独成项目。这一节讲清楚它的边界和拆分方式。

### 6.1 为什么插件系统是独立模块

#### 6.1.1 插件系统与内核本体解耦

插件系统解决的是"内核的能力怎么扩展"，内核本体解决的是"内核怎么跑一条回合"。这两件事的稳定程度不同：内核本体（会话循环、模型调用、事件流）相对稳定，插件系统（发现、加载、生命周期、注册）是另一套机制。把两者耦在一起，改插件系统就得动内核本体，改内核本体又牵连插件系统。拆开，各自独立演化。

#### 6.1.2 将来能拆出去单独成项目

这是用户明确的一条要求：插件系统将来可能拆出去，作为独立的项目单独维护。所以它的设计必须满足一个硬约束——**插件系统不反向依赖内核本体的内部实现**。它只依赖一个接口面（"插件能拿到什么、能注册什么"），这个接口面是稳定的，内核本体和插件系统都依赖它，谁都不依赖谁的内部。这样将来拆，就是把插件系统连同那个接口面一起拎走，内核本体换成"引用这个接口面"即可。

### 6.2 插件的加载接口

#### 6.2.1 一个 minimal 插件长什么样：入口 + 清单

一个 minimal 插件是一个目录：一个清单文件（声明 id、name、版本、提供的工具/命令）+ 一个入口（加载时执行的代码）。入口代码拿到一个受限的上下文对象，靠它往内核注册能力。清单声明"我是谁"，入口执行"我提供什么"，两者分开——清单可静态扫描，入口才真正执行。

#### 6.2.2 内核本体只依赖接口，不依赖插件系统实现

这是 6.1.2 的落地：内核本体（agent loop、工具注册表）只认"工具注册表"这个接口，不认"插件系统"这个模块。插件系统往注册表里塞工具，内核本体从注册表读工具——两者经注册表这个接口通信，谁都不知道对方的具体实现。这是依赖倒置：接口在内层（注册表是内核本体的业务本质），插件系统在外层（是往注册表塞东西的一种方式）。

#### 6.2.3 接口面的成员：一个可实现的契约

盲审指出 §6.5.2 白纸黑字写"现在就要把这个接口面显式定义出来"，通篇却没给成员——"可拆分"的论证全押在这个接口面上，接口面空着，论证就悬空。这里把它落成契约。这个接口叫 `MinimalPluginHost`，是插件入口代码拿到的那个"受限上下文对象"，定义在一个内核本体和插件系统**共同依赖**的模块里：

- **`registerTool(spec, run)` / `unregisterTool(name)`**——插件往工具注册表加/撤工具。`spec` 是 §5.1.1 的 schema（name/description/parameters），`run` 是 §5.1.2 的实现。这是插件最核心的产出，§5.9.2 已经用过它。
- **`on(event, handler)` → 退订函数**——插件订阅内核生命周期事件。`event` 不是裸字符串，是 §4.2.3 十种事件常量里的一个成员（收敛成常量清单，不是让插件手拼字符串）；**可订阅的清单是生命周期"结果/边界"事件，具体五个**：`sessionStart`、`agentStart`、`agentSettled`、`messageEnd`、`toolCallEnd`。**不可订阅的是流式"过程/增量"事件，具体五个**：`messageStart`、`messageUpdate`、`toolCallStart`、`toolCallUpdate`、`entryAppended`——它们挂在高频路径上，插件回调若挂上去会把流式主路径拖慢。`handler` 签名是 `(payload) => void`，payload 就是该事件的中性字段（`agentSettled` 带 `reason`、`messageEnd` 带 `message`、`toolCallEnd` 带 `result`/`isError`），和 §4.2.3 协议事件的字段同形。返回退订函数，§6.4.2 的"卸载解绑"靠它。
- **`registerCommand(name, handler)`**——插件扩展协议面，注册一条新命令。第一版可晚做（§6.3.2），但接口里现在就留位。
- **`getConfig<T>()`**——插件读自己的配置（§6.10.1）。配置读写经这个口子，插件不自己找文件路径。

这四类成员就是"接口面"的全部。要点不在成员多，而在**边界**：插件只能经这四类成员碰内核，碰不到内核本体的内部状态（agent loop 的当前回合、模型客户端的连接、其他插件的内存）。将来拆出去，拎走的是"插件系统 + 这份 `MinimalPluginHost` 契约"，内核本体改成"实现这份契约、供插件系统调用"。§6.5.2 的"显式定义"到这里兑现。

### 6.3 插件能提供什么

#### 6.3.1 工具：往注册表加工具

插件第一能力是提供工具——§5.9.2 已经讲过，这里从插件侧再说一遍：插件声明一组工具的 schema + 实现，加载时注册进工具注册表，卸载时撤掉。工具是插件最核心的产出，因为它是模型能感知到的能力扩展。

#### 6.3.2 事件 / 命令扩展

插件第二能力是扩展协议面：注册新的命令（比如 `customAction`）或订阅事件（比如 `agentSettled` 后做点什么）。这给插件一个"钩住内核生命周期"的口子，不只是被动提供工具。但命令/事件扩展是第一版可以晚一点做的能力，工具注册是第一版必须有的——先让插件能提供工具，再让它能挂生命周期。

### 6.4 插件生命周期

#### 6.4.1 load / unload

插件生命周期两个动作：`load`（加载入口、注册能力）和 `unload`（回收能力、释放资源）。加载在 minimal 启动时或插件被动态添加时发生，卸载在插件被移除或 minimal 退出时发生。生命周期由插件系统管理，内核本体只看到"注册表里的工具多了一个/少了一个"。

#### 6.4.2 卸载时回收它注册的工具与监听

卸载必须干净：插件注册的工具从注册表撤掉、它挂的事件监听解绑、它打开的资源（文件句柄、子进程）释放。不留孤儿是插件系统的硬纪律——§5.9.2 的工具撤出、§6.4.1 的监听解绑，都是同一条"卸载即清零"的展开。这条做不干净，插件反复装卸就会泄漏状态，内核越来越慢、越来越乱。

### 6.5 插件与内核本体的边界

#### 6.5.1 哪块归内核、哪块归插件系统

边界画在"稳定 vs 会变"上：会话循环、模型客户端、事件流、会话文件、工具注册表——这些是内核本体，稳定；插件发现、加载、生命周期、清单解析——这些是插件系统，相对会变。工具的执行实现是插件的（会变），工具的执行调度是内核本体的（稳定，§5.3 的"查注册表 → 执行 → 包装"）。

#### 6.5.2 拆分的缝画在哪

拆分的缝画在"接口面"上，不在"目录"上。将来拆出去，不是把某个目录整个拎走，而是把"插件系统 + 它依赖的那个接口面（工具注册表接口、事件接口、命令接口）"拎走。所以现在就要把这个接口面显式定义出来，让插件系统只 import 这个接口面，不 import 内核本体的任何具体类。这是 §6.2.2 的延伸，也是"可拆分"的真正含义——不是物理目录干净，是依赖方向干净。

### 6.6 将来拆成独立项目怎么拆

#### 6.6.1 目录与包边界

现在的形态：minimal 是一个仓库，插件系统是里面的一个子模块（一个目录或一个包），内核本体是另一个。将来拆分的形态：插件系统变成一个独立仓库，内核本体通过依赖引用它。拆分能成立的前提是 6.5.2 的依赖方向——如果插件系统今天 import 了内核本体的内部实现，拆分时就得把这些 import 全部反转，那是一次大手术；如果今天就把依赖方向守干净，拆分就是"挪目录 + 改 package 引用"。

#### 6.6.2 依赖方向：插件系统不反向依赖内核

这条是 6.6.1 的前提，值得单独成条再钉一遍：插件系统可以依赖"接口面"，接口面可以依赖"中性类型"（工具 schema、事件形状），但插件系统**不能**依赖内核本体的具体类（agent loop 的实现、模型客户端的实现）。方向反了，拆分就成了一句空话。§9.3 把这个代价讲全。

### 6.7 与 pi 扩展、dsh Cordis 插件的异同

#### 6.7.1 同：都是"内核能力来源"

minimal 的插件系统和 pi 的 TS 扩展、dsh 的 Cordis 插件树，在架构上是同一类东西——都是内核补能力的抓手，都是"内核的能力来源"，都遵循"补面下沉内核插件、适配器只翻译"（`kernel-design-spec.md` ADR D4）。壳对三者一视同仁：壳不直接操作任何一个内核的插件系统，只经中立契约（`listTools`、`KernelExtensionSource`）看到它们产出的能力。

#### 6.7.2 异：minimal 的插件系统是可拆分的独立模块

区别在"独立性"：pi 的扩展装进 pi 进程、dsh 的插件挂在 Cordis 树里，都是各自内核的私有实现，没有"拆出去单独维护"的诉求。minimal 的插件系统从一开始就按"可拆分"设计——这是 minimal 独有的工程诉求，不是架构上的特权，而是 minimal 这个项目自己的演进计划。

### 6.8 插件的沙箱与权限

#### 6.8.1 插件是不可信代码吗

这个问题决定沙箱的复杂度。如果插件是不可信第三方代码，就需要进程隔离、权限白名单、资源限额——一套大工程。如果插件是"用户自己写的、或用户信任的来源"，就可以先做轻量边界（运行在同一进程、约定不越界）。minimal 第一版取后者：插件是可信代码，同进程运行，沙箱降到"接口面约束"（插件只能经受限上下文对象访问内核，不能碰文件系统以外的任意资源）。这条是 §9.3 的边界，明确写出来而不是含糊带过。

#### 6.8.2 权限边界怎么定

可信插件也要有边界，只是边界轻：插件拿到的上下文对象，只暴露"注册工具、订阅事件、读写自己的配置"这几个口子，不暴露内核的内部状态、不暴露其他插件的内存。边界是接口面的形状，不是运行时拦截——插件能做什么，由"接口面给了它什么"决定，而不是"运行时检查它做了什么"。这比进程沙箱弱，但比"插件直接 import 内核内部"强，是第一版的合理落点。

### 6.9 插件发现：目录扫描

#### 6.9.1 扫哪、怎么认入口

minimal 的插件发现是目录扫描：扫一个（或几个）插件目录，认"有清单文件的子目录"为插件，读清单拿 id/name，找入口文件。这是 pi 扫扩展目录、dsh 扫 cordis 插件同款的最小实现。壳侧 `kernel-extension.ts` 的 `findExtensionEntry` 已经把"扫目录找入口"这个思路收敛成一层，minimal 借鉴这个**思路**（扫目录、认入口），但实现是 minimal 插件系统自己的——不 import 壳侧代码，否则就违反 §6.5.2 的依赖方向。借思路可以，借代码不行。

#### 6.9.2 优先级与覆盖

多个插件目录（内置、用户、项目）之间，靠扫描顺序定优先级，后扫的覆盖先扫的同名插件。这条对齐壳插件加载器的"低到高优先级"纪律（§1.4）：内置插件和第三方插件平等，只是被发现的顺序不同。minimal 的插件发现也遵循这条，不搞"识别内置插件特殊对待"。

### 6.10 插件配置

#### 6.10.1 每个插件的配置读写

每个插件有自己的配置，读写走插件系统提供的统一通道，落在一个以插件 id 命名的文件里。插件不自己去找文件路径，经接口面拿"我的配置"——这是 §6.8.2 接口面约束的一部分，也是将来拆分的干净性保证（配置通道是接口面的成员，插件系统拆出去后通道跟着走）。

#### 6.10.2 配置变更怎么生效

配置变更的生效方式，由插件自己声明：有的是"读时生效"（每次用都读配置），有的是"重载才生效"（需要 unload + load）。插件系统提供"重载"动作，但不替插件决定哪些配置需要重载——这是插件的语义，插件系统只提供机制。这条是"框架管通用、特化归外层"在插件配置上的体现。

## 7. 接入 desktop：适配器与装配

前六节讲的是 minimal 本身——一个独立内核的内部设计。这一节讲它怎么被 desktop 托管。这里的核心立场是 §2 反复强调的那句：**minimal 是独立的，desktop 只是宿主**。所以这一节写的全是"壳侧要交什么"——适配器、装配、以及把 minimal 加进 `KernelId` 时编译器逼出来的那几处补全。

### 7.1 适配器：MinimalBackend / MinimalCatalog 是什么

#### 7.1.1 翻译层：minimal 专属形状 ↔ 中立契约

适配器是 minimal 和壳之间唯一的翻译层，两个类：`MinimalBackend extends AbstractBackend`（进程面 + 会话读面，把 minimal 的协议翻译成 `BaseBackend`），`MinimalCatalog implements SessionCatalog`（目录/CRUD 面，把 minimal 的会话文件翻译成中性形状）。它们和 `PiBackend`/`DshBackend`、`PiSessionCatalog`/`DshSessionCatalog` 是同一抽象的两个新实例，§2.2.1 的"三种参数化"在这里兑现成代码结构。注意"会话读面"不是"分支面"——fork 归壳（§2.6），minimal 的 `getTree`/`getEntries`/`bookmark`/`seed` 只读单条线性 lineage，不做分支结构，所以这里不叫"分支面"。

#### 7.1.2 它做三种事：直接映射 / 需翻译 / 缺面降级

适配器里的方法分三类（`kernel-design-spec.md` §3.3 的同一分类）：直接映射（minimal 的 `setModel` 就是一条 `setModel` 命令，形状一致）、需翻译（minimal 的协议事件要翻译成中性 `SessionEvent`，会话文件要投影成 `LineageTree`/`NeutralMessage`）、缺面降级（minimal 没有 pi 的 `steer`/`followUp`、没有 dsh 的 capability 面，这些在 `capabilities` 里是空的，壳据此显式降级）。三类里只有"需翻译"是适配器的真正工作量，另两类一行就是一行。

### 7.2 spawn 与协议对接

#### 7.2.1 desktop 怎么起 minimal 子进程

desktop 起 minimal，走和 pi/dsh 同构的子进程生命周期：一个 `createMinimalSubprocess` 负责拼 spawn 参数（cli 入口、会话根、会话 id、模型偏好）和管进程生死，一个 JSONL transport 负责往 stdin 写命令、从 stdout 读事件。`kernel-design-spec.md` §28.8 的反模式是"适配器里 spawn 进程"——所以 spawn 在工厂闭包里拼装，适配器只持一个 transport 接口，不自己 spawn。

#### 7.2.2 命令出、事件进，经 SubprocessHandle 连接

适配器和子进程之间经 `SubprocessHandle` 接口连接：适配器构造命令对象但不 spawn，子进程生命周期管 spawn 和退出。这是 §3.2"构造与执行分开"的落地——命令是构造出来的数据，spawn 是执行，两者经接口解耦。minimal 的 transport 和 pi 的 `RpcAdapter`、dsh 的 `JsonRpcTransport` 同构，只是协议不同。

### 7.3 事件翻译：minimal 协议事件 → 中性事件

#### 7.3.1 minimal 事件和中性事件未必同形

minimal 的协议事件是它自己的形状，中性事件是壳的形状。**实现选了"同名"那条路**：minimal 的 CLI 事件名**有意取成与中性事件一致**（`messageStart` / `messageUpdate` / `messageEnd` …），于是根本不需要字段重映射——适配器里没有 `translateMinimalEvent` 这样一个纯函数，而是 `minimal-backend.ts` 里的一个**白名单过滤**：`SESSION_EVENT_TYPES.has(e.type)` 命中的才透传给壳，其余（`pong`/`tree`/`entries`/`seeded` … 协议响应）滤掉。

#### 7.3.2 翻译是喂线，不是第二套语义

这条是 `kernel-design-spec.md` §16.3 的纪律，对 minimal 同样成立：翻译层的职责只是"让 minimal 的事件能被壳当中性事件用"，不是"在这里重新发明一套事件语义"。壳只认中性事件，minimal 只认自己的事件，中间这条线越薄越好——**薄到极点就是没有翻译层**（同名 + 白名单，本实现走的就是这条），而不是"有一个只做字段搬运的翻译函数"。检验标准随之更硬：既然连字段搬运都没有，适配器里就**不该出现任何重算回合状态、重新聚合消息**的分支；出现了，就说明这条线越界成了第二套语义。

### 7.4 会话模型映射：minimal 文件 → 中性形状

#### 7.4.1 头 + 线性 lineage → LineageTree / NeutralMessage

`MinimalCatalog.getTree` 读 minimal 的会话文件，投影成 `LineageTree`（单 lineage：`{rootId, [{id, fork: null}]}`）；`MinimalCatalog`/`MinimalBackend.getEntries` 读文件投影成 `NeutralMessage[]`（线性消息序列）。这个投影和 pi 的 `sessionEntryToNeutral` 是同一件事的两半：pi 侧把 pi 条目投成中性消息，minimal 侧把 minimal 条目投成中性消息。投影函数是 minimal 自己的（`minimalEntryToNeutral`，因为 minimal 的条目形状是 minimal 的），但产出的中性形状一致。具体到 §3.3.3 的三种分隔条目，各自投影成一个 divider（`role:"divider"`），`kind` 各不同：`session_info` → `kind:"info"`（改名分隔线）、`model_change` → `kind:"model"`（切模型分隔线）、`tools_change` → `kind:"tools"`（切工具集分隔线），i18nKey 和 i18nArgs 随 kind 走渲染层的翻译。这些 divider 和 pi 的 divider 形状完全一致——timeline 只认 divider 这一种分隔线形态，不分内核。`message` 条目投影成 `NeutralMessage`（role + content + toolCall 块），分隔条目投影成 divider，两条投影规则都在 `minimalEntryToNeutral` 里，是纯函数、可单测。

#### 7.4.2 seed 投影：中性 lineage → minimal 文件

反向投影是 seed：壳把活跃 lineage 的纯 AI 内容（`assembleSeedProjection` 组装，压缩截断 + role 白名单）交给 minimal 的 `seed`，minimal 适配器把这串 `NeutralEntry` 写成 minimal 的会话文件。和 pi 的 `piSeedSession` 同构——都是"把中立 lineage 落成内核自己的文件"。minimal 是文件态内核，所以它的 seed 是纯文件写，不依赖活进程（这点对 §8 的运行期切换很关键）。

### 7.5 KernelId 加字面量

> ⚠️ **历史演进记录**：本节（7.5–7.8）描述的是**插件化之前**接入 minimal 的路径——通过 `KernelId` 字面量联合 + `KERNEL_IDS` 数组。插件化后（§kernel-plugin）`KernelId` 已去字面量化（`= string`）、`KERNEL_IDS` 已删（内核清单由 `KernelRegistry` 运行时驱动），接入内核 = **写一个插件目录（plugin.json + factory）+ 注册**，核心零改动。本节保留作历史，实际接入见 `src/server/kernel/minimal/plugin.json` + `plugin.ts`。

#### 7.5.1 kernel.ts 的联合 + KERNEL_IDS

接入 minimal 的第一刀落在圆心：`packages/shared/src/domain/kernel.ts` 的 `KernelId` 联合从 `"pi" | "dsh"` 扩成 `"pi" | "dsh" | "minimal"`，`KERNEL_IDS` 数组同步加一项。这一刀很小，但它触发的是全仓的编译期检查——`kernel-design-spec.md` ADR D2 说的"加内核编译器逼补全所有 switch"，就是这一刻。

#### 7.5.2 编译器逼你补全消费处

`KernelId` 加字面量后，所有 `Record<KernelId, X>` 和穷尽 `switch(kernel)` 的地方开始报错，逼你把 minimal 补进去。这些地方就是下一小节 7.6 的五个 Record 槽位，外加散落各处的穷尽检查。这是字面量联合（而非 `string`）的直接红利：漏补任何一处，编译不过；编译过了，说明 minimal 在所有受检的消费处都齐了。

### 7.6 五个 Record 槽位逐一补全

> ⚠️ **本节同 §7.5，属插件化前的历史**（`KERNEL_IDS` / 字面量联合 / Record 槽位 / 工厂路由均已退役）。现行接入见 `src/server/kernel/minimal/plugin.json` + `plugin.ts`。

#### 7.6.1 logo / 模型 / 配置 / 扩展 / 版本

五个槽位是 `KernelId` 联合驱动出来的 `Record<KernelId, X>`：`KERNEL_LOGOS`（内核 logo）、`kernelModels`（模型管理 API，类型 `KernelModelsRegistry`）、`kernelConfig`（原生配置 API）、`kernelExtensions`（扩展源）、`kernels`（web 侧版本管理 `KernelVersionApi`）。minimal 要在这五处各交一个实现——前三处是诚实实现，后两处是诚实桩，见 7.9。

#### 7.6.2 每个槽位对 minimal 是诚实实现还是桩

分两档：模型（`kernelModels`）和 logo 是诚实实现——minimal 真的有模型清单（§4.9）和 logo；配置（`kernelConfig`）、扩展（`kernelExtensions`）、版本（`kernels`）是诚实桩——minimal 第一版没有"配置 TAB 要编辑的原生配置"、没有"扩展管理页要列出的扩展"、没有"npm 版本安装/切换"（它是随壳分发的，不装不升不降）。桩不是"留空"，是显式返回"不支持/空清单/内置态"，§7.9 展开。

### 7.7 工厂路由

> ⚠️ **本节同 §7.5，属插件化前的历史**（`KERNEL_IDS` / 字面量联合 / Record 槽位 / 工厂路由均已退役）。现行接入见 `src/server/kernel/minimal/plugin.json` + `plugin.ts`。

#### 7.7.1 createMinimalBackend / createMinimalCatalog

装配层加两个工厂：`createMinimalBackend(opts)`（拼 minimal 的 spawn 参数 + 建 transport + 建 `MinimalBackend`）和 `createMinimalCatalog(agentDir)`（建 `MinimalCatalog`）。它们和 `createPiBackend`/`createDshBackend`、`createPiCatalog`/`createDshCatalog` 并列，注册进 `kernel-factories.ts`，由 bootstrap 组装。

#### 7.7.2 路由从取反兜底改显式分支

这是接入 minimal 时暴露的一处真问题（§7.8 细讲）：现在的 `baseBackendFactory.create` 写的是 `if (opts.kernel !== "dsh") return createPiBackend(...)`，`sessionCatalogFactory.create` 写的是 `kernel === "dsh" ? ... : createPiCatalog(...)`。两个内核时"不是 dsh 就是 pi"碰巧成立，三个内核时 minimal 会被静默当成 pi——路由必须改成显式三分支：`minimal → createMinimal*`、`dsh → createDsh*`、`pi → createPi*`。这是编译器抓不住的逻辑分支，只能靠"加第三个内核"这个动作逼人发现。

### 7.8 三处字面量谓词漂移

> ⚠️ **本节同 §7.5，属插件化前的历史**（`KERNEL_IDS` / 字面量联合 / Record 槽位 / 工厂路由均已退役）。现行接入见 `src/server/kernel/minimal/plugin.json` + `plugin.ts`。

#### 7.8.1 isKernelId / resolveSessionKernel / 工厂路由

接入 minimal 会暴露三处"字面量谓词"漂移，它们都不是 `Record<KernelId, X>`，所以编译器不报错，但都会把 minimal 静默错配成 pi：

- `sessions.ts` 的 `isKernelId` 写死 `v === "pi" || v === "dsh"`，却注释"契约单源"。minimal 会话的模型偏好读回来会 `kernel: undefined`。
- `session-store.ts` 的 `resolveSessionKernel` 又写死一遍 `custom?.["kernel"] === "pi" || custom?.["kernel"] === "dsh"`，同一份漂移复制了第二次。
- `assemble.ts` 的工厂路由用取反兜底（§7.7.2），第三处、也是最危险的一处——它不是"读不到 minimal"，是"把 minimal 起成 pi"。

这三处的共同根因：字面量谓词的"单源"没有被物理强制。`KernelId` 联合是单源的（`kernel.ts` 一份），但"判断一个字符串是不是合法 KernelId"这件事，散成了三处手写的字面量比较。

#### 7.8.2 收口：isKernelId 改用 KERNEL_IDS + 回归守卫

收口是把字面量谓词统一到 `KERNEL_IDS` 上：`isKernelId` 改成 `(KERNEL_IDS as readonly string[]).includes(v)`，`resolveSessionKernel` 和工厂路由改成显式分支或复用 `isKernelId`。但"改对一次"不够——§3.7 的纪律是根因修复必须留守卫：补一条单测，断言"`isKernelId` 识别的集合 === `KERNEL_IDS`"，让字面量谓词和字面量联合永不再漂。没有这条守卫，下次加第四个内核时这三处还会再漂。

### 7.9 管理面是平行缝

#### 7.9.1 内核本体缝 vs 管理面缝

接 minimal 要补的其实是两套缝，别混为一谈：**内核本体缝**是 `BaseBackend`（14 条意图，即 `AbstractBackend` 声明的 14 条 abstract 方法：kernel/alive/start/stop/onEvent/sendMessage/abort/setModel/setSessionName/getTree/getEntries/bookmark/deleteBookmark/seed）+ `SessionCatalog`（目录/CRUD），这是"内核能跑、能被会话流用"的缝；**管理面缝**是 `KernelVersionApi` / `KernelModelsApi` / `KernelConfigApi` / `KernelExtensionSource`，这是"设置页三个 TAB 能管这个内核"的缝。两套缝正交：一个内核可以本体缝齐了（能跑）但管理面缝是桩（不可管理），minimal 第一版就是这种。

#### 7.9.2 可托管 vs 可管理

这个区分回答了一个容易卡住的点：minimal 的版本管理、原生配置、扩展管理为什么要写桩。因为它们不是"内核能不能被托管"的必要条件——`kernel-design-spec.md` §32 的十项清单里，前三项（spawn、适配器、会话模型映射）决定"可托管"，后三项（模型源、内核管理、管理 UI）决定"可管理"。minimal 第一版把"可托管"做全、把"可管理"做成诚实降级：版本管理返回"内置态、不装不升不降"，扩展管理返回空清单，原生配置返回空字段。这比伪造一个"假版本号"或"假扩展列表"诚实。

#### 7.9.3 桩不能静默、不能伪造成功

桩的纪律是 §7.6 的收口：返回"不支持/空/内置态"，让 UI 显式置灰或隐藏入口，而不是返回一个编造的值让 UI 以为能操作。版本管理返回 `available: true, source: "installed"`（诚实的"内置可用"），而不是编一个 `v1.0.0` 装成"可升级"；扩展管理返回 `[]`（诚实的"没有扩展"），而不是伪造一个"read-claude-md"装成有插件。这条是 `kernel-design-spec.md` §7.6 三条出路的第三条——显式降级，不静默、不伪造。

#### 7.9.4 哪些**可选面** minimal 不提供，以及为什么

「同等地位、同等功能」不等于"逐项相同"——`KernelPlugin` 的可选面本来就是"有则用、无则降级"（§1.5）。
把这件事写清楚，是因为**灰区比差异更危险**：文档不表态，下一个人就会以为它是 bug 而"补"上一个假的。
按 §7.6 三分法逐项表态（判据：**内核有没有这个能力**，不是"pi 有没有"）：

| 可选面 | minimal | 为什么 |
|---|---|---|
| `createSkillProvider` / `ensureSkills` / `skillWatchPaths` | **无** | minimal 内核**没有技能加载机制**（§5 的工具是另一回事：工具是模型可调用的函数，技能是按需载入的提示词包）。pi 的技能住在 `settings.json` + `skills/` 目录，dsh 有 fork 插件扫目录 —— minimal 两者都没有。**显式降级**：技能面板里 minimal 不贡献任何行；若一个内核都不提供，面板显式写「当前装载的内核都不提供技能清单」，而不是一句含糊的「暂无」。**将来若要补**，正路是在 minimal 内核里实现技能发现/载入（内核能力），而不是在壳里造一个影子读 pi 的目录。 |
| `createOneshot` | **无** | 一次性问内核（pi 的 headless 单轮）是 pi 的能力面；minimal 的等价物是"起一个会话发一条"，壳不需要单开面。 |
| `createPluginExtensionSync` | **无** | minimal 没有"内核扩展"这套机制（pi 是 TS 扩展、dsh 是 Cordis 插件）。所以声明了 `extensions.minimal` 的壳插件会在启动同步时打日志跳过（**显式**，不静默）。 |
| `createQuestionBridge` | **无** | 交互式提问（dsh 的 question bridge）是 dsh 的能力面。 |
| `createLifecycle` / `migrateSkills` | **无** | 同上一条族的 pi 专属面。 |
| `readLegacySessions` | **无** | minimal 没有"前一代格式"要迁移（它就是第一版格式）。 |
| `sessionRoot` / `configRoot` / `createVersionApi` / `createModelsApi` / `createConfigApi` / `createExtensionSource` / `createModelSource` / `createCatalog` / `seed` / `createBackend` | **有** | 这些是"可托管 + 可管理"的必需面，minimal 一个不少（§7.9.1 的两套缝）。 |

**自检**：这张表里任何一行从"无"变成"有"，都应该是**内核长出了那个能力**（在内核侧实现），
而不是壳或插件里多了一段特判。

### 7.10 无特权差异

#### 7.10.1 删掉 minimal，壳照常启动

minimal 接入后，删掉 minimal 的目录、禁掉 minimal 内核，壳照常启动，只是少了 minimal 那份能力。这条和 pi/dsh 的验收标准一致——minimal 是可插拔的第三个内核，不是壳的运行时依赖。检验方式就是 §2.3.2 那一条：删掉它，壳不崩。

#### 7.10.2 minimal 与 pi/dsh 走同一套加载与契约

minimal 不享受任何"识别 minimal 并特殊对待"的路径：会话流里它走和 pi/dsh 一样的 `factory.create` + `backend.*` 契约，管理面里它走和 pi/dsh 一样的三 TAB 共享 base，模型清单里它的模型和 pi/dsh 的模型并列。minimal 的特殊性只在它自己的适配器和桩里，壳一行都不为它分支。这条在 §2.3 是论断，在这里是装配层逐项兑现的结论。

## 8. 运行期切换：minimal 与 switchKernel

这一节处理前几稿被我用"门禁关着"推开的那件事：**一个活会话能不能在 minimal 和别的内核之间切进切出。** 答案是能，而且必须能——minimal 是第三个同级内核，运行期切换是"同级"的题中之义，不是可选项。这一节把 minimal 参与切换的完整路径讲清楚。

### 8.1 运行期切换是什么

#### 8.1.1 一个活会话 pi → minimal 或 minimal → dsh

运行期切换说的是：一个正在跑的会话，中途从 pi 切到 minimal（或反向、或 minimal ↔ dsh），消息流续接，后续发送走新内核。它和 §1.2.1 的组装层切换是两回事——组装层是"起新会话时选哪个内核"，运行层是"一个会话中途换内核"。后者难得多，因为要保住已有历史、在飞回合、会话身份三样东西。

#### 8.1.2 七步编排：abort → 落定 → 快照 → stop → seed → 重绑 → 收尾

`session-store.ts` 的 `switchKernel` 是七步编排（`kernel-switch-projection.md` 展开）：先 `abort` 在飞回合并等它落定，再从中立层读活跃 lineage 的投影，`stop` 旧内核，把活跃 lineage `seed` 到新内核，重绑进程条目，最后收尾（写回会话头内核归属、广播切换事件）。minimal 作为切换目标或切换源，要在这七步里各就各位。

### 8.2 minimal 作为切换目标

#### 8.2.1 seed 把活跃 lineage 投影进 minimal 文件

切到 minimal，就是把这七步里的"seed"落到 minimal 上：壳把活跃 lineage 的纯 AI 内容（`assembleSeedProjection`）交给 minimal 的 `seed`，minimal 把它写成自己的会话文件（§3.4.2）。之后 minimal 从这份文件续跑，历史不丢。seed 的内容是中立层投影出来的，和 minimal 从哪个内核切过来无关——切自 pi、切自 dsh、切自 minimal 自己，seed 进去的都是同一种"纯 AI 内容"。

#### 8.2.2 minimal 的生命周期不对称：文件 seed，不需进程

minimal 是文件态内核，它的 seed 是纯文件写、不依赖活进程——这点和 pi 的 `piSeedSession` 一样，和 dsh 的"先 spawn 再 RPC seed"相反。所以 minimal 走切换编排里的"预 seed"路径：先写文件得会话 id、再以该 id spawn。这个不对称不是 minimal 的特殊设计，是"文件态内核"和"进程态内核"的天然差别，`kernel-design-spec.md` §12.2 已经把它钉成契约的一部分。

### 8.3 minimal 作为切换源

#### 8.3.1 从 minimal 切走，中立层是唯一真相源

从 minimal 切到别的内核，历史从哪来？不是从 minimal 的文件读——而是从中立层读。因为 `neutral-session-first.md` 已经把真相源钉在中立层：会话进行中，壳侧持续把事件 append 进中立层，minimal 的文件只是它的投影。切走时，壳直接读中立层的活跃 lineage 投影，不回头读 minimal 文件。minimal 的文件在中立层缺失时才是兜底（§3.4.3 的灾难恢复面）。

#### 8.3.2 快照与 stop 的收尾

从 minimal 切走，先 `abort` minimal 的在飞回合、等 `agentSettled` 落定，再 `stop` minimal 进程。stop 是子进程生命周期的正常收尾，minimal 的 `stop` 要保证"在飞回合已落定、文件已写穿"——这两样 minimal 在 §4.6/§4.3 里已经保证，切走时不需要额外动作。收尾后 minimal 进程退出，它的文件留在原地，将来切回来还能续（§8.2 的 seed 幂等）。

### 8.4 模型中立化

#### 8.4.1 跨切换时档位模型怎么映射到目标内核

切换时，壳要处理"当前用的是什么模型"：它读 `proc.lastModelRef`（壳的中立模型档位引用，如 `fast`/`pro`/`reasoning`），用目标内核的模型清单解析出目标内核对应的 provider/model，`setModel` 到新内核。这是 `model-catalog.ts` 的 `resolveModel(kernel, ref)` 干的活——档位引用是壳的中立概念，跨内核稳定，解析成具体模型是目标内核的事。

#### 8.4.2 minimal 的模型在目标内核无对应时回落默认

minimal 切到 pi，如果当前档位引用（壳的中立概念，§8.4.1 的 `fast`/`pro`/`reasoning`）在目标内核（pi）的模型清单里解析不到对应模型，壳回落 pi 的默认模型，并告警（`session-store.ts` 里 `console.warn` 的现成路径）。不静默用错模型、也不因为找不到就中断切换——回落默认 + 显式告警，是 §7.6 那条"不静默、不伪造"在模型上的又一次落地。

### 8.5 门禁与风险

#### 8.5.1 switchKernelEnabled = false 的现状

> ⚠ **本节已过期（最直白的一例：`false` → `true`）**：§8.5.2 说的"门禁必须翻"**已经翻了**——
> `session-store.ts:196` 现在是 `private switchKernelEnabled = true;`（第 1281 行的 `if (!this.switchKernelEnabled) throw ...` 仍在，
> 但已不再触发）。运行期切换现在可跑 `pi ↔ dsh ↔ minimal`，由 `stream-switch-session` / `fork-cross-kernel` 等 e2e 覆盖。
> 本节保留作**门禁关闭期**的记录,勿当现状读。

现在的 `session-store.ts` 里有个 `switchKernelEnabled = false` 的门禁，`switchKernel` 入口直接抛"跨内核切换暂未启用"。这个门禁是历史遗留的谨慎——七步编排里的 seed 投影、模型中立化、非对称生命周期当年还没完全验证，于是先关掉。minimal 要真正参与运行期切换，这个门禁必须翻。

#### 8.5.2 要跑通 minimal 切换，门禁该翻、翻之前补什么

翻门禁不是删一行 `if` 就完事，它要求七步编排对 pi/dsh/minimal 三方都验证过：seed 投影对三个内核都正确（pi 文件写、dsh RPC、minimal 文件写）、模型中立化对三方都解析得通、非对称生命周期（预 seed / 后 seed）对三方都走得对。minimal 的接入恰好是"第三次验证"的契机——`kernel-design-spec.md` §32 第十项说"同一套壳插件测试跑第三个后端不改一行，'内核无关'才第三次被验证"，切换这条链也同理：pi↔dsh、pi↔minimal、dsh↔minimal 三对切换都跑通，运行层可替换才算真正坐实。

### 8.6 失败回滚

#### 8.6.1 切换中途失败，旧内核还能不能回来

切换中途失败（seed 失败、目标内核起不来），要能回到旧内核。七步编排的顺序保证了这一点：`stop` 旧内核发生在 seed 目标内核**之前**，所以 seed 失败时旧内核已经 stop 了，回滚的是"重新起旧内核"而不是"旧内核还在原地"。具体回滚语义：seed 失败 → 报错，会话保持在中立层的最新态，用户重试或回落旧内核重开。这条是 §9 边界要写实的，这里先立原则：失败不能留"半切换"的中间态。

#### 8.6.2 seed 失败 / 目标内核起不来的处置

两类失败分开处置：seed 失败（写 minimal 文件失败、dsh RPC seed 失败）→ 目标内核没拿到历史，报错、不启动目标内核、会话身份不变；目标内核起不来（spawn 失败、探测超时）→ 报错、清理半起的进程、会话回落旧内核或待重试。两种失败都**不静默**——用户要看到"切换失败"，而不是会话悄悄停在某个中间态。这是 §7.9.3"不静默"纪律在切换路径上的延伸。

## 9. 取舍与边界

这一节把前八节里"这么做而不那么做"的取舍，和"这条路走到边上会怎样"的边界，集中交代一遍。前几稿把这一节写成了"为什么不做流式/不做工具/不做插件/不碰 switchKernel"——全是把该做的往后推，这版反过来：取舍只讲真取舍，边界只讲真边界。

### 9.1 流式 SSE 的代价

#### 9.1.1 SSE 解析与重连的复杂度

走 SSE 流式是有代价的：要解析分片的 `data` 行、要聚合乱序的 tool_call delta、要处理流中途断开。这套解析逻辑比"一次请求拿完整 JSON"复杂得多，是 minimal 模型客户端里最容易出错的地方。这个代价是真实的，但它是"真流式体验"的必要成本——非流式省掉的是这层复杂度，损失的是逐字滚出的体验和工具调用的增量形态。

#### 9.1.2 换来的是真流式体验

代价的另一面是收益：`messageUpdate` 的 token 级增量驱动 timeline 逐字滚出，工具调用能边生成边显示。这是 minimal 作为"真能用的内核"的体验底线——一个不流式的 agent，用起来是"点发送、等几秒、整块蹦出来"，和流式的"边想边出"是两种东西。minimal 从第一版就要后者。

### 9.2 工具的代价

#### 9.2.1 tool loop 与安全边界

工具系统最大的代价不是"定义工具"（那简单），是 tool loop 的终止条件和安全边界：模型可能陷入"调工具失败又重试"的死循环，危险工具可能造成不可逆的副作用。这两件事（§5.10 的轮数上限、§5.7 的档位门控）必须从第一天就做对，否则工具系统不是加分项，是事故源。

#### 9.2.2 换来的是注入 / 切换 / 工具集

代价的另一面是能力：模型不再只是"聊天"，它能读文件、搜代码、执行命令、改文件。这是"agent"和"聊天机器人"的分界，也是用户点名要的"非常重要的功能"。注入/切换/工具集三件套，是让这个能力可控的关键——不是"一股脑给所有工具"，而是"按集给、按需切"。

### 9.3 插件系统的代价

#### 9.3.1 独立模块的边界维护

把插件系统设计成可拆分的独立模块，代价是边界纪律：插件系统不能 import 内核本体的任何具体类，只能依赖接口面。这条纪律每写一行插件系统代码都要守一次，守不住就漂成"看似独立、实则缠死"，将来拆分时全是手术。这个代价是真实的，但它正是"可拆分"的全部意义——现在守，将来拆。

#### 9.3.2 换来的是将来能拆分

代价的另一面是自由：插件系统将来能整个拎出去单独成项目，内核本体和插件系统各自演化。这是用户明确要的工程诉求，不是本文的假设。§6.5/§6.6 已经把它从"愿景"落成了"依赖方向怎么画"的具体方案。

### 9.4 线性会话文件

#### 9.4.1 分叉归壳，内核只存活跃 lineage

minimal 的会话文件只存一条线性 lineage，不存 fork 树。这个取舍的根子是"分叉归壳"：fork 是壳在中立层的事，内核是单线执行器。存 fork 树是多余的——树已经在壳侧了，内核再存一份就是双写、就会漂。线性文件是"内核只存它该存的那份"的直接结果。

#### 9.4.2 文件越简，越不容易错

线性文件的第二层好处是简单：没有 parentId 指针就没有"指针悬空、环、乱序"这些树结构的固有 bug。一个只有头行加顺序条目的 JSONL 文件，读写的正确性一眼能看穿。这是"最简"纪律在存储层的落地——不是省功能，是省掉不必要的复杂度。

### 9.5 JSONL 行协议

#### 9.5.1 最简、可读、易调试

minimal 的协议选 JSONL 行协议，因为它是最简的进程间协议：一行一个完整 JSON，没有分帧长度、没有握手协商。debug 时 `tail -f` 就能看事件流，`echo` 就能喂命令。这不是偷懒，是"协议只做协议该做的"——minimal 是单线执行器，同一时刻一个回合，命令和事件天然顺序对应，不需要请求 id 配对这种复杂机制。

#### 9.5.2 协议是 minimal 的契约，将来可换

JSONL 行协议是 minimal 的私有契约，壳经适配器翻译、不直接消费。所以它将来可以换（换 JSON-RPC、换二进制分帧），换的时候只动 minimal 自己的协议层和适配器，壳一行不改。协议是"会变的细节"，放在最外层，正是依赖只向内的体现。

### 9.6 管理面写诚实桩

#### 9.6.1 版本 / 模型 / 配置 / 扩展对 MVP 不是本体

minimal 的版本管理（装/升/降）、原生配置 TAB、扩展管理页，第一版写诚实桩（§7.9）。这不是"这些功能不重要"，是"它们不是内核本体"——一个内核能不能跑、能不能聊、能不能持久化，不取决于它有没有 npm 版本切换。本体缝做全、管理面缝降级，是把有限的精力投在"可托管"上，而不是"可管理"上。

#### 9.6.2 诚实降级，不静默、不伪造成功

桩的唯一纪律是不欺骗：版本管理返回"内置态、不装不升不降"，扩展管理返回空清单，配置返回空字段。UI 据此置灰入口或显示"不适用"，而不是看到一个编造的版本号以为能点升级。这条和 §7.9.3 是同一句，在取舍这一节再钉一遍，因为它是最容易在执行时走样的一条。

### 9.7 边界：子进程崩溃与收尾

#### 9.7.1 崩了壳怎么收尾

minimal 进程崩溃（OOM、未捕获异常、被 kill），壳经进程退出事件收尾：把当前在飞回合标记为失败、广播 `processExit`、允许用户重开。这是壳的机制（§4.6.3 已经说过），minimal 只负责"尽量别崩、崩之前写穿文件"。两者的边界是：minimal 保证文件一致性，壳保证崩溃后的用户体验。

#### 9.7.2 会话文件写一半怎么恢复

minimal 的会话文件用"写临时文件 + rename"或"追加 + 锁"保证原子性（§3.2.3），所以"写一半被 kill"的结果是"要么旧态、要么新态"，不是"半条 JSON"。重开时读到完整态，读到损坏行则跳过（和 pi 读 JSONL 的损坏行跳过同款防御）。这是存储层设计阶段就要考虑的边界，不是写完再补的补丁。

### 9.8 边界：模型失败、超时、并发

#### 9.8.1 模型失败回合怎么收尾

模型调用失败（超时、5xx、连接重置），minimal 发带 error 的 messageEnd + 标 reason 的 agentSettled（§4.6.1），历史里落一条 error 的 assistant 消息。失败是"这一条回复失败了"，不是"会话坏了"——用户可以重试、换模型、或继续。这条边界的要点是：失败要显式成状态，不能让 timeline 上凭空少一条回复。

#### 9.8.2 同一会话并发 send 怎么拒

minimal 是单线执行器，同一时刻只跑一条回合。同一会话发来第二个 `send` 而第一个还没结束，minimal 要拒绝（回一个"busy"错误）而不是排队或静默丢弃。**已落地**：CLI 用 `turnInFlight` 互斥位（handleSend 起手置位、`finally` 复位——用 finally 而不是各出口复位，因为 handleSend 有 abort/失败/达上限多个出口，漏一个就会把内核永久卡在"忙"上），命中则回 `{type:"error", error:"busy"}`。守卫见 `minimal-standalone.test.ts` 的两条（显式 busy + 会话文件不被两条回合写坏）。壳侧本来就有"正在生成时输入框禁用"的机制，minimal 侧的拒绝是第二道防线——防的是协议层绕过壳直接并发。拒绝要显式，让调用方知道"现在忙"。

### 9.9 边界：工具执行失败与死循环

#### 9.9.1 工具失败怎么回喂模型

工具执行失败，不吞异常，把失败作为 `isError` 的 tool_result 回喂（§5.3.2）。这条边界的关键是"失败是给模型的信号"——模型看到失败会自己换策略。吞掉失败、假装成功，模型会沿着错误的方向一路走下去，越走越偏。

#### 9.9.2 回环轮数上限

工具回环必须有硬上限（§5.10.1），超过就强制收尾并标 reason。没有上限，一个"反复失败反复重试"的工具会把一个回合跑成死循环，占住 minimal 进程、烧掉模型 token。上限是配置项，但默认值必须存在且保守。

### 9.10 哪些是参数化、哪些要动结构

#### 9.10.1 模型 / 工具 / 插件都是可换的缝

minimal 的模型客户端、工具集、插件系统，都是"会变的细节"，设计成了可换的缝：模型客户端可以换 provider 协议，工具可以换集，插件系统可以整个拆走。换它们不动内核本体（会话循环、事件流、会话文件）。这是依赖只向内的收口——会变的都在外层，换外层不惊动内层。

#### 9.10.2 会话文件与协议是内核的契约，动它们要迁移

反过来，会话文件格式和协议是 minimal 的"稳定内核"，动它们不是改代码、是要做迁移（旧文件兼容、旧协议版本兼容）。所以这两个要一开始就定对，宁可多花时间在格式和协议的设计上，也不要在上线后被迫迁移。这呼应 §9.4/§9.5 的"最简"——最简不只是省工作量，是减少将来要迁移的表面积。

## 10. QA

这一节把盲审和起草过程中攒下的边界、取舍、已知限制收成显式问答。每条都是一个真会卡住读者或实现者的场景，答给的是明确处置，不是"这是一个已知限制"这种糊弄。能补进正文的，前两轮盲审已经补掉了；剩下的都是"该让读者知情"的取舍。

**Q：工具第一版同进程执行、没有 OS 级沙箱，用户启用 bash 后模型诱导跑了个 `rm -rf /`，怎么办？**

答：拦不住，这是第一版明确接受的风险。隔离只有两道：档位门控（bash 默认关、只出现在显式的"全功能集"里）+ per-tool 超时强制终止（§5.7.1、§5.3.2）。要挡 `rm -rf /` 这种"工具确实被授权、但授权后造成不可逆破坏"的场景，只能靠 OS 级沙箱（子进程隔离 / seccomp / 容器），那不在第一版。这条的处置是"诚实告知 + 默认不启用 + 危险工具只在显式集"，不是"假装有沙箱"。

**Q：minimal 文件和中立层的一致性，不设检测器、靠 seed 无条件重建——那进程活着时两边因并发或重复 seed 漂了，会漏吗？**

答：正常路径不漂。下行内容同源（都从中立层投影）、上行事件回流（壳的 dispatch 增量 append），闭环里两边一致是构造保证，不是靠运气。漂移只在故障态发生：进程崩溃丢尾部、写一半被 kill、落盘时序竞态。这些故障态的修复靠"下次重开/seed 时无条件从中立层重投影"，不靠持续比对。这是一个明确取舍：检测比对的成本 > 重建的成本（因为文件存得越少、重建越便宜），所以放弃检测、只保留重建。不是"漏了检测"，是"有意不检测"。

**Q：minimal 裸跑没有 TUI，人肉怎么跟它聊？"离开 desktop 也能用"是不是只是口号？**

答：裸跑是机器面，不是人面。minimal 的裸跑形态是 CLI：stdin 一行 JSONL 命令、stdout 一行 JSONL 事件（§2.10.1），`echo '{"type":"send","text":"你好"}' | minimal` 就能喂一条、`tail -f` 能看 SSE 增量。人肉要友好交互，就在外面套一个薄 REPL 脚本，或让 desktop 当这个壳——TUI 是交互层的会变细节，不该进内核本体。"离开 desktop 也能用"指的是内核本体自足（起进程、读消息、调模型、写文件都不欠 desktop），不是指"裸跑时人肉操作体验好"。

**Q：SSE 聚合到底哪几处最容易写错，怎么保证写对？**

答：三处，都在 §4.8.2 钉死：arguments 是**追加拼接不是覆盖**（覆盖会让参数只剩最后一片）、按 index 维护缓冲（多个 tool_call 并发时分片交错）、`[DONE]` 之后不再有分片（之后到达的按协议错误丢弃）。这三处靠单测覆盖，不是靠人肉小心——聚合逻辑是纯函数（喂一串 SSE 片段、断言事件序列），正好是 §4.5 说"该补单元测试"的典型。

**Q：apiKey 凭证文件由适配器写、子进程读，两边怎么保证落到同一个路径？**

答：路径经工厂闭包**单源注入**——同一份凭证文件路径在组装时定一次，同时交给适配器（写）和 spawn 配置（子进程读），两边不是各自猜。这和 pi 的 `agentDir`、dsh 的凭证路径注入进配置源是同一套机制（§4.9.2）。单源注入的落点是 `assemble.ts` 的工厂组装，不是散在各处拼路径。

**Q：插件能订阅哪些事件？`messageUpdate` 这种流式增量为什么不开放给插件？**

答：只开放生命周期**边界**事件——`agentStart`、`agentSettled`、`messageEnd`、`toolCallEnd` 这类回合边界（§6.2.3）。`messageUpdate` 这种高频流式事件不开放，因为插件回调若挂在高频路径上，会把流式主路径拖慢。这是一条能力边界，不是漏：插件要感知"回合发生了什么"走边界事件，要感知"逐字生成"走不了、也不该走。

**Q：switchKernel 门禁翻了之后，minimal 参与的运行期切换，验证到哪一步才算数？**

答：三对切换都跑通（pi↔dsh、pi↔minimal、dsh↔minimal）+ 壳插件集成测试跑 minimal 后端零改动，两样都过才算"运行层可替换"对 minimal 成立。这是 §8.5.2 和 `kernel-design-spec.md` §32 第十项的同一判据：前九项是接入成本，第十项是接入成功的证据。翻门禁不是删一行 `if`，是七步编排对三个内核都验证过 seed 投影、模型中立化、非对称生命周期。

**Q：minimal 和 pi 都是文件态内核、都有 JSONL 会话文件和 agent loop，为什么写 minimal 而不是直接扩展 pi？**

答：三个本质区别，§2.6.2 和 §6.7.2 各占一半。一是**存储语义**：pi 的老文件用 parentId 连成整棵叉树，minimal 只存当前活跃 lineage 的线性序列、不存 fork 树（分叉归壳），这是 pi 的历史形态做不到的、也是"学了中立层收敛之后形态"的结果。二是**插件系统可拆分**：minimal 的插件系统设计成能拆出去单独成项目，pi 的 TS 扩展没有这个诉求。三是**协议最简**：pi 有 31 条命令，minimal 只实现自己需要的十来条。写 minimal 不是为了"更简单"，是为了要一个"存储和分叉语义都对齐当前架构、插件系统可独立"的内核，这些 pi 都给不了。
