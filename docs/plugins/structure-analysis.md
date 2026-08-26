# 结构分析插件设计（structure-analysis）

> 状态：**低保真已确认（可开关写入面板版），架构已拍板，待开发。**
> 版本：v2.0（架构大改版：从"壳侧生成 + 附件投喂"改为"内核侧工具 + 可开关写入面板"）。
> 关联：`docs/plugins/git-review.md`（会话结合的交互范式）、`docs/plugins/projects.md`（项目上下文）、`docs/design/plugin-decoupling.md`（槽位三段式）、`docs/design/tool-manager-design.md`（工具白名单）、`docs/plugins/llm-recorder.md`（**配置开关 + 内核侧车**的先例，本插件机制范式直接沿用）。
> 低保真：`docs/design/structure-analysis-lofi.html`（可开关写入面板，已按本版架构重做）。

---

## 0. 文档导读与修订说明

### 0.1 本版为什么大改

v1 设计把"生成介绍 / 生成 review"放在**壳渲染层**，用 `ctx.llm.oneshot` 由插件自己发 LLM 请求，再把结果作为**附件**经 `composerAttachments` 投喂回会话。这套方案在讨论中被逐步否定，原因有三：

1. **生成逻辑放错了层。** 让壳插件自己调 `llm:oneshot` 生成内容，等于在 UI 层再造一个"小 agent"——它要自己拼 prompt、自己管上下文、自己消化结果。而内核里本来就坐着一个完整的、带着会话上下文的 agent。**该让 agent 干的活，不该让 UI 抢着干。**
2. **"附件投喂"方向反了。** v1 是"面板生成 → 附件 → 会话"，信息单向流进会话。但真实需求是**看着结构和 AI 一起思考**：用户在面板上观察，在对话里指挥，AI 把结论**写回面板**，用户接着看、接着想。这是一个**双向、持续**的协作回路，不是一次性投喂。
3. **用户要的是一块"可靠的观察面 + 一支可放开的笔"。** 最终拍板的形态是：面板本身是一个可靠的目录结构观察界面（供用户观察与思考），配合一个**默认收起、按需放开**的写入工具（`structure_write`）。用户点"开始分析"放开这支笔，然后在对话里让 AI 往结构树上写；不分析时笔收着，面板只是一棵树。

因此本版把架构整体翻面：**生成与写入下沉为内核侧工具，壳插件退为纯观察/交互层，会话流成为唯一的指挥通道，一个显式的模式开关控制工具的放开与收起。**

### 0.2 本版相对 v1 的取舍一览

| 维度 | v1（已废弃） | v2（本版） |
|---|---|---|
| 生成逻辑所在层 | 壳渲染层 `ctx.llm.oneshot` | **内核侧工具**，AI 自主调用 |
| 壳插件角色 | 生成者 + 投喂者 | **纯观察/交互**（读树、读侧车、渲染、开关） |
| 信息流向 | 面板 → 附件 → 会话（单向） | 会话 ⇄ 面板（双向持续回路） |
| 会话结合 | `composerAttachments` 附件 | **对话内指挥 + 工具写回侧车** |
| 权限 | `fs:project` + `llm:oneshot` | `fs:project`（+ 可选 `sessions:bus`），**去掉 `llm:oneshot`** |
| 内核侧产物 | 无 | `pi-extension/` + `dsh-extension/` 双内核扩展 |
| 持久化 | `ctx.config` 分桶 | **内核写侧车文件 + 壳读** |
| 启停 | 无（按钮即生成） | **显式模式开关**（开始/结束） |

### 0.3 术语约定（本文高频词）

- **观察面**：右面板的目录树视图。只读、可靠、供用户观察与思考。它不生成任何内容。
- **写入工具**（`structure_write`）：注册在内核里的工具，AI 调用它把一条或多条"节点说明"写进结构树。这是唯一能改侧车内容的写入口。
- **模式开关**（开始/结束）：面板上的显式开关，控制写入工具是否"放开"。关闭=工具收起（调用会被拒绝），开启=工具放开。
- **侧车文件**（sidecar）：内核工具写入、壳插件读取的项目内 JSON 文件，是结构说明的**单一真相源**。
- **配置标志位**：壳插件写、内核工具读的开关位（`analysisMode`），是模式开关跨进程落地的载体。范式沿用 `llm-recorder`。
- **放开 / 收起**：本文对"工具可用 / 不可用"的口语化表述。放开≠注册（工具一直注册着），放开=门控通过、调用会真正执行。

---

## 1. 背景与动机

### 1.1 问题：看结构做架构 review 的现状很原始

当用户想审视一个项目的**架构 / 分层 / 职责**时，现有手段都很别扭：

- 直接让 AI `ls -R` / 读一堆文件：token 消耗大、噪音多，而且 AI 看到的是散点，用户看不到全貌。
- 用 file-tree 插件：它回答"文件在哪"，不回答"目录是干什么的、架构对不对"。它是导航，不是分析。
- 人工在脑子里搭结构：看着一层层目录，自己推断职责、自己判断依赖方向，累且容易漏。

用户真正想要的体验是：**看着一棵干净的目录树，每个目录旁边有一句职责说明，AI 陪我一起看、一起想，我指哪它写哪，我边看边改主意。** 这是一个"观察—思考—对话—落笔"的循环，而不是"点一下按钮等一份报告"。

### 1.2 为什么不是 file-tree，也不是 git-review

- **file-tree** 给的是"文件在哪"（导航）。本插件给的是"目录是干什么的、架构对不对"（语义 + 判断）。两者互补：file-tree 是文件级导航，本插件是目录级语义层。
- **git-review** 给的是"这次改动怎么样"（围绕 diff）。本插件围绕的是**稳定的目录结构**，与是否改动无关。它俩共享"会话结合"的交互范式，但对象不同。

### 1.3 "核心还是会话"的再确认

用户反复强调：**核心还是会话，面板是辅助。** 这句话决定了本插件的一切边界：

- 面板**不抢主动权**。它不会自己跳出来生成一堆结论，也不会在用户没开口时往会话里塞东西。
- 面板是**观察与思考的台面**。用户看着它，想清楚，然后在对话里说出来。
- AI 的结论**写回面板**，让用户"看得见"思考的落点，而不是淹没在滚动的消息流里。

一句话定位面板的角色：**它是会话的一块"外置画布"，会话是主语，画布是宾语。**

---

## 2. 核心概念与定位

### 2.1 一句话定位

> **一个挂在右面板的、可开关的目录结构写入面板：平时是一棵可靠的目录树供你观察思考；点"开始分析"放开写入工具后，你在对话里指挥 AI 把职责说明 / 架构判断写进树里，边看边想边改。**

### 2.2 三个关键词

1. **观察面（reliable observation surface）**：目录树 + 深度切换 + 过滤 + 排除 + 逐节点说明。它必须可靠——读树稳定、渲染稳定、说明持久。用户盯着它思考，它不能抖。
2. **写入工具（armable write tool）**：`structure_write`。它常注册、但被模式门控。它是内核里 agent 的一个工具，不是壳里的一个按钮。
3. **模式开关（explicit mode switch）**：开始 / 结束。它把"放开写入工具"这个动作显式化、仪式化——用户明确地说"现在我要搞结构分析了"，而不是 AI 随时随地可能往树上写。

### 2.3 为什么要有模式开关（而不是工具常开）

用户原话："**平时不分析就不用开，就放开可以往里写信息的工具。**" 这背后是三个诉求：

- **不污染日常对话。** `structure_write` 若常开，AI 在任何会话里都可能"好心"地往结构树写东西。开关把它限制在"用户明确要做结构分析"的场合。
- **一个清晰的心理状态。** 用户需要一个看得见的答案："现在是不是在分析？"模式条上的绿点就是这个答案。
- **一个干净的收尾。** 点"结束"，工具收起，画布冻结，用户可以安心去做别的事，不用担心树还在被改。

### 2.4 非目标（本版明确不做）

为避免范围蔓延，明确列出本版**不做**的事：

- **不做代码级 review。** 不读具体业务代码文件内容，不做行级审查。那是别的插件（或纯对话）的事。本插件只看**目录结构**这个粒度。
- **不做壳侧自动生成。** 不用 `llm:oneshot` 由插件发起生成。一切生成由会话里的 agent 通过工具完成。
- **不做"一键全量报告"按钮。** 没有一个按钮点下去自动把整棵树的介绍全生成好。生成由对话驱动、按需进行（可以一次让 AI 写多个节点，但发起者是对话，不是按钮）。
- **不做跨项目的全局结构库。** 侧车跟项目走（`<cwd>` 下），不汇总跨项目。
- **不接管 tool-manager 的工具白名单。** 模式门控走配置标志位（见 §8），不动 `enabledToolIds`（理由见 §8.3）。

---

## 3. 用户场景与故事

### 3.1 场景一：平时浏览（模式关闭）

> 我打开项目，切到右面板"结构分析"Tab。我看到一棵目录树，切到二级，扫一眼 `src/` 下的几大块。我只是想确认一下项目长什么样，**不打算分析**。
>
> 面板顶部模式条是灰的：`⚪ 结构分析未开启 · 只浏览结构，写入工具未放开`。我在对话里问 AI 别的问题（改 bug、问用法），AI 正常回答，**不会**往结构树写任何东西。

**要点**：模式关闭是默认态、常态。此时面板就是一个增强版 file-tree（带深度/过滤/排除），写入工具收起。

### 3.2 场景二：开始分析，指挥 AI 写

> 我想认真看看这个项目的架构了。我点面板上的 **「🧭 开始分析」**。模式条变绿：`🟢 分析中 · structure_write 已放开`，会话里多了一条系统提示"写入工具已放开"。
>
> 我在输入框里说："**给 `src/server` 和 `packages` 写一句职责说明。**"
>
> AI 回应："好，我把这两个目录的职责写进结构树…"，然后调用 `structure_write`。会话里出现一张工具卡：`🛠 structure_write · 写入 2 条`。
>
> 几乎同时，右面板的 `src/server` 和 `packages` 下面各冒出一行说明，带 📝 标记和一下蓝色闪烁。我一眼就看到了。

**要点**：开关放开工具 → 对话指挥 → 工具写侧车 → 面板实时渲染。整个回路用户全程可见。

### 3.3 场景三：边看边想边改

> 看到 `src/server` 的说明是"后端：应用编排 / 内核 / client / controllers"，我觉得不够准确——它其实不该含 controllers。我直接在对话里说："`src/server` 那句改一下，controllers 其实属于 api 层，不算 server。"
>
> AI 重新调用 `structure_write` 覆盖那条。面板上的说明更新了。
>
> 我又说："再往下看，`src/server/application` 和 `src/server/client` 也写一下，顺便说说它俩的依赖方向对不对。" AI 写两条说明，并在对话里补了一句架构判断。我盯着树想了一会儿，继续。

**要点**：这是本插件的核心价值场景——**观察（面板）与思考（对话）交织**。面板是稳定的参照物，对话是流动的推理。写入可覆盖、可追问、可下钻。

### 3.4 场景四：结束分析

> 看得差不多了。我点 **「⏹ 结束」**。模式条回到灰色，会话里提示"写入工具已收起"。
>
> 树上已经写好的说明**都还在**（它们落在侧车里，跟项目走）。我只是不再让 AI 改了。之后我切去干别的，树就是静静地带着一堆 📝 说明在那儿，像一份我自己和 AI 一起做的架构笔记。

**要点**：结束≠清空。产物持久。再次"开始"可继续追加。

### 3.5 反场景（不该发生的）

- **模式没开，用户让 AI 写结构** → AI 调 `structure_write`，工具拒绝并返回"结构分析未开启，请在面板点开始分析"，AI 把这句话转达给用户。**不静默失败、不假装写了。**
- **AI 在模式开启时自作主张写了一堆没被要求的节点** → 这是 prompt/描述层面要约束的（工具描述里写清"只写用户要求的节点"）。但即便发生，因为面板实时可见，用户能立刻看到并让它撤回/改正——可见性是兜底。
- **切到别的项目，旧项目的说明串过来** → 侧车按 `<cwd>` 隔离，切项目读的是新项目的侧车，不会串。

---

## 4. 交互设计

### 4.1 面板总体布局

```
┌─ 结构分析 ────────────────────────────────────────────────────────┐
│ [🔍 过滤…]  (○一级)(●二级)(○三级)(○全展开)   [⚙排除] [↻]         │  ← 工具栏（观察控制）
├──────────────────────────────────────────────────────────────────┤
│ ⚪ 结构分析未开启 · 只浏览结构，写入工具未放开      [🧭 开始分析]   │  ← 模式开关条
├──────────────────────────────────────────────────────────────────┤
│ 📁 src                                                            │
│    源码入口，含 plugins/server/web 三大部分      📝               │  ← 逐节点说明
│   ├─ 📁 plugins    内容层壳插件                  📝               │
│   ├─ 📁 server     后端：应用编排/内核/…          📝               │
│   │   ├─ 📁 application                          （未写）         │
│   │   └─ 📁 client     流出适配器                📝               │
│   └─ 📁 web        渲染层                        📝               │
│ 📁 packages                                                       │
│ 📁 docs                                                           │
├──────────────────────────────────────────────────────────────────┤
│ 🟢 structure_write 已放开 · 侧车 .my-harness-desktop/…            │  ← 侧车/工具状态
├──────────────────────────────────────────────────────────────────┤
│ 「开始分析」放开 structure_write → 对话里让 AI 写 → 这里观察。 [🗑] │  ← 底部提示 + 清空
└──────────────────────────────────────────────────────────────────┘
```

四个分区自上而下：**观察控制（工具栏）→ 模式开关条 → 树观察面 → 状态/提示**。模式开关条位于树之上、工具栏之下，是面板的"状态中枢"，一眼可见。

### 4.2 模式开关条

模式条是面板里唯一"有状态"的控制，其余都是无状态的观察控件。

**两态：**

| 态 | 视觉 | 文案 | 按钮 |
|---|---|---|---|
| 关闭（默认） | 灰点、无底色 | `结构分析未开启 · 只浏览结构，写入工具未放开` | `🧭 开始分析`（主色填充，醒目） |
| 开启 | 绿点（带光晕）、整条淡绿底 | `分析中 · structure_write 已放开，下方对话里指挥 AI 写` | `⏹ 结束`（幽灵按钮，弱化） |

**设计意图：** 关闭态按钮醒目（邀请开启），开启态按钮弱化（避免误触结束）。绿点+绿底是"正在分析"的持续视觉锚点，用户扫一眼就知道当前状态。

**开关切换的副作用（详见 §8）：**
1. 写配置标志位 `analysisMode`（项目级）。
2. 往会话里发一条**系统样式提示**（`· structure_write 工具已放开 ·` / `· 已收起 ·`），让对话上下文也知道状态变了。
3. 面板自身重渲染（模式条、侧车状态、输入框 placeholder）。

**busy 时禁用切换**：AI 正在执行写入时，开关置灰，避免半空中抽走工具。

### 4.3 树观察面

树是面板的主体，纯观察。能力：

- **深度切换**：一级 / 二级 / 三级 / 全展开（见 §9.1，全展开=懒加载）。
- **搜索过滤**：命中路径 + 祖先链保留，其余折叠（§9.2，纯前端）。
- **排除目录**（⚙）：持久忽略清单，读树前由内核跳过（§9.2）。
- **逐节点说明**：目录节点下方一行灰字，来自侧车；有说明的节点行尾带 📝。新写入的说明带一下蓝色闪烁（提示"刚写的"）。
- **刷新**（↻）：手动重读树 + 侧车（兜底，尤其 dsh 无实时回传时）。

树本身**不带 checkbox**（v1 的勾选聚焦取消）——因为本版不需要"圈定范围生成"，范围由对话自然表达（"给 X 和 Y 写"）。保持观察面干净。

### 4.4 对话驱动写入

写入的发起永远在**中区对话**。面板不提供"生成"按钮。

- 模式开启时，输入框 placeholder 提示：`指挥 AI 往结构树里写，例如：给 packages 和 web 写职责说明`。
- 模式关闭时，placeholder 提示：`结构分析未开启 · 点右面板「开始分析」后可指挥 AI 写入`。
- 用户正常发消息，AI 自主决定是否调 `structure_write`（被要求写时就调）。

**面板与对话的联动**：写入发生时，会话里出现工具卡（`🛠 structure_write`），面板树上对应节点更新。两处同步，用户在哪边看都行。

### 4.5 侧车/工具状态条

面板底部一条细状态，常驻显示：

- `structure_write 已放开/未放开`（随模式）。
- 侧车文件路径 `.my-harness-desktop/structure-analysis/annotations.json`（让用户知道数据落在哪，透明）。
- 每次成功写入后，状态点闪一下（提示"刚更新"）。

**设计意图**：把"工具状态"和"数据落点"都摆到明面上，符合"可靠观察面"的定位——用户对正在发生什么有完全的知情权。

### 4.6 低保真

交互低保真见 `docs/design/structure-analysis-lofi.html`，已按本版架构实现：模式开关条、门控的输入框、工具卡动画、树的实时回填与闪烁。验收交互时以它为准。

---

## 5. 架构设计总览

### 5.1 三层分工

```
┌──────────────────────────────────────────────────────────────────┐
│ 壳插件（渲染层）renderer/ —— 纯观察 + 交互                         │
│   读树(ctx.fs.readDirTree) · 读侧车(ctx.fs.readFile) · 渲染树      │
│   模式开关 UI · 写配置标志位(ctx.config.set) · 监听回传             │
├──────────────────────────────────────────────────────────────────┤
│ 内核扩展 —— 能力提供方（双内核各一份）                              │
│   pi-extension/index.ts   : pi.registerTool(structure_write)     │
│   dsh-extension/index.mjs : ctx.tools.register(structure_write)  │
│   工具 execute：读配置门控 → 写侧车 → 回传通知                     │
├──────────────────────────────────────────────────────────────────┤
│ 文件系统（项目内）—— 单一真相源                                    │
│   <cwd>/.my-harness-desktop/config/structure-analysis.json        │ ← 配置(含 analysisMode)，壳写、内核读
│   <cwd>/.my-harness-desktop/structure-analysis/annotations.json   │ ← 侧车(节点说明)，内核写、壳读
└──────────────────────────────────────────────────────────────────┘
```

**核心数据流（一次写入）：**

```
用户在对话里说"给 server 写说明"
   │
   ▼
内核 agent 决定调用 structure_write(entries=[{path:"src/server", note:"…"}])
   │
   ▼
工具 execute：
   1. 读 <cwd>/.my-harness-desktop/config/structure-analysis.json → analysisMode?
        关闭 → 返回"未开启，请让用户点开始分析"（拒绝）
        开启 → 继续
   2. 读现有侧车 annotations.json（没有则建空）
   3. 合并/覆盖 entries 里每个 path 的说明
   4. 写回 annotations.json
   5. 回传通知：pi=emitFrame(bus) / dsh=（无 bus，靠壳监听文件）
   6. 返回回执"已写入 N 条"
   │
   ▼
壳插件收到回传（或监听到文件变化）→ 重读侧车 → 重渲染树（新节点闪烁）
```

### 5.2 为什么生成逻辑放内核侧（工具），而不是壳侧（llm.oneshot）

这是本版架构的**第一原则**，值得展开讲透。

**(a) 上下文在谁手里。** 生成一句准确的目录职责说明，往往需要结合当前对话上下文（用户刚才在聊什么、关注什么）、项目知识（AI 可能已经读过一些文件）。这些上下文**天然在内核 agent 手里**。壳插件调 `llm:oneshot` 是一个无上下文（或要自己重新塞上下文）的孤立请求，信息是残缺的。

**(b) 谁是"决策者"。** 写什么、写到哪、怎么措辞、要不要顺带给个架构判断——这些是**推理决策**，属于 agent。壳插件若自己做，就要把这套决策逻辑用 prompt 工程硬编码在 UI 层，既笨重又脆弱。让 agent 通过工具做，决策留在它该在的地方。

**(c) 多内核一致性。** `llm:oneshot` 是壳的一个能力面，而"工具"是**每个内核都有的原生概念**（pi 有 `registerTool`，dsh 有 `ctx.tools.register`）。把能力做成内核工具，天然适配双内核，走的是"内核插件补面"的正道（§12）；做成壳侧 oneshot，则是在壳里再造一个跨内核的生成通路，违背"能力归内核"。

**(d) 会话回路的完整性。** 工具写入后，agent 可以**接着在对话里回应**（"已写入，还要深入哪个目录？"），形成自然的多轮。壳侧 oneshot 生成完就完了，接不回对话。

一句话：**能用内核工具表达的生成，就不要用壳侧 oneshot。** 这和本项目"能力归内核、壳只做机制与观察"的整体哲学一致。

### 5.3 模式开关的机制（放开/收起工具）——概览

模式开关要解决：**壳（渲染进程）如何控制内核（子进程）里一个工具的可用性。** 两者隔着进程，靠**文件**传递状态。机制沿用 `llm-recorder` 的成熟范式（§8 详述）：

- 壳把开关状态写进**项目级配置**（`config.set("analysisMode", …)`），落在 `<cwd>/.my-harness-desktop/config/structure-analysis.json`。
- 内核工具每次 `execute` 时**读这个配置文件**，据此放行或拒绝。

这条路径的好处：**跨内核通用**（不依赖 pi 专属的 toolgate，dsh 也能用）、**动态生效**（每次调用都读最新值，切开关立即生效，不受"会话 spawn 时注入"的时机限制）、**有先例**（llm-recorder 已验证）。

### 5.4 双内核对称

写入工具在两个内核各有一份实现，语义完全一致，只有注册 API 和回传通道不同：

| | pi 内核 | dsh 内核 |
|---|---|---|
| 扩展形态 | TS 扩展 `pi-extension/index.ts` | Cordis 插件 `dsh-extension/index.mjs` + `extension.json` |
| manifest 字段 | `"piExtension": "./pi-extension"` | `"dshExtension": "./dsh-extension"` |
| 工具注册 | `pi.registerTool({...})` | `ctx.tools.register({...})`（`inject:["tools"]`） |
| 读配置/写侧车 | `node:fs` + `process.cwd()` | `node:fs` + `process.cwd()`（一致） |
| 回传通知 | `emitFrame($bus)` → 壳 `ctx.bus.onMessage` | **无 bus** → 壳监听侧车文件变化（§12.2） |

**对称的部分**（读配置、写侧车、门控逻辑）抽成共享纯函数放 `core/`，两个扩展各自 import/内联（§13）。**不对称的部分**（注册 API、回传通道）各自适配。

### 5.5 结果回传：侧车文件 + pi bus / dsh 文件监听

写入发生后，壳怎么知道该刷新？两条通道：

- **pi**：工具写完侧车后 `emitFrame({$bus:true, to:"plugin:structure-analysis", kind:"structure_updated"})`，壳 `ctx.bus.onMessage` 收到 → 重读侧车 → 刷新。**事件驱动，实时。**
- **dsh**：没有 bus。壳**监听侧车文件**的变化（`chokidar`/`watchFile`，事件驱动，不是轮询）→ 重读 → 刷新。若文件监听不可用，退化为"会话消息结束时重读 + ↻ 手动刷新"。

**侧车文件是唯一真相源**，两条通道都只是"触发重读"的信号。这保证了：即便某条回传通道失效，用户点 ↻ 也总能拿到正确数据——回传是优化，不是正确性依赖。

### 5.6 面板纯观察的数据流

面板自己**不写任何语义数据**，只读两类东西：

1. **目录树**：`ctx.fs.readDirTree(cwd, {maxDepth, ignore})` → `FileTreeNode`。
2. **节点说明**：`ctx.fs.readFile(<cwd>/.my-harness-desktop/structure-analysis/annotations.json)` → 渲染到对应节点下。

面板写的只有**配置标志位**（`analysisMode`）——那是它自己的设置，不是语义内容。这条纪律让面板保持"纯观察"，语义数据的写权完全归内核工具。

---

## 6. 工具契约：structure_write

### 6.1 职责与边界

`structure_write` 是**唯一**能修改结构说明侧车的工具。职责单一：把一批"路径 → 说明"写进侧车。它**不做**：读目录树（AI 要看结构可用别的工具，或壳面板已经展示了）、生成说明（说明文本由 AI 在调用时就准备好，工具只负责落盘）、任何代码读取。

**为什么是"批量写入"而不是"单条写入"：** AI 常常一次被要求写多个目录（"给 server、web、packages 都写"）。批量参数让它一次工具调用搞定，减少往返。但批量不强制——写一条就是 `entries` 长度为 1。

### 6.2 输入 schema

```jsonc
{
  "name": "structure_write",
  "description": "把目录职责说明写进项目结构树侧车。用户在右面板『结构分析』观察这棵树。仅当用户开启了结构分析并要求你写时才调用；只写用户要求的节点，每条一句话说明职责。",
  "parameters": {
    "type": "object",
    "required": ["entries"],
    "properties": {
      "entries": {
        "type": "array",
        "description": "要写入/更新的节点说明。",
        "items": {
          "type": "object",
          "required": ["path", "note"],
          "properties": {
            "path": { "type": "string", "description": "相对项目根的目录路径，如 'src/server'。" },
            "note": { "type": "string", "description": "一句话职责说明。" }
          }
        }
      }
    }
  }
}
```

**工具描述的措辞很关键**（这是"注意力控制"的一部分，见 §8.4）：它明确告诉 AI——只在用户开启分析并要求写时调用、只写被要求的节点、每条一句话。这在软层面约束 AI 不要乱写。

### 6.3 输出 / 回执

工具返回结构化回执，供 agent 组织回复：

```jsonc
{ "written": 2, "paths": ["src/server", "packages"], "sidecar": "…/annotations.json" }
// 或被拒绝时：
{ "written": 0, "refused": true, "reason": "结构分析未开启（analysisMode=false）。请让用户在右面板点『开始分析』。" }
```

### 6.4 模式门控（execute 时校验）

`execute` 的第一步就是读配置门控（§8）。这是**硬门控**——即便 AI 在模式关闭时调用，也会被拒绝并得到清晰理由。软门控（工具描述）+ 硬门控（配置校验）双保险。

### 6.5 幂等与覆盖语义

- 同一 `path` 重复写 = **覆盖**旧说明（最新意图优先）。这让"改一下那句"自然成立。
- 不同 `path` = 追加/更新各自条目。
- 侧车以 `path` 为键存，覆盖是键级 upsert，不影响其他节点。

### 6.6 错误处理

- 配置读不到（首次、被删）→ 视为 `analysisMode=false`（保守：默认收起），拒绝并提示。
- 侧车读写失败（权限、磁盘）→ 返回 `{refused:true, reason}`，不抛崩，agent 转达用户。
- `entries` 为空/非法 → 返回参数错误，不落盘。

---

## 7. 侧车文件格式

### 7.1 路径与命名

```
<cwd>/.my-harness-desktop/
  config/structure-analysis.json              ← 配置（含 analysisMode），框架按 pluginId 推导，壳写、内核读
  structure-analysis/
    annotations.json                          ← 节点说明侧车，内核写、壳读
```

- 配置文件路径由框架按 `pluginId` 推导（CLAUDE.md §9.1 统一配置通道），`llm-recorder` 同款。
- 侧车放独立子目录 `structure-analysis/`，为将来扩展留空间（如 `review-notes.json`），不与配置混。
- 两者都**跟项目走**（`<cwd>` 下），切项目天然隔离。

### 7.2 annotations.json 结构

```jsonc
{
  "version": 1,
  "updatedAt": "2025-08-30T12:00:00.000Z",
  "notes": {
    "src":            "源码入口，含 plugins/server/web 三大部分",
    "src/server":     "后端：应用编排 / 内核 / client",
    "src/server/client": "流出适配器（内核层在此）",
    "packages":       "发布面包：react / shared / pi 扩展"
  }
}
```

- `notes` 是 `path → note` 的扁平映射，键是相对项目根的目录路径。
- 扁平映射（而非树）的理由：写入是键级 upsert，简单、无树结构维护成本；渲染时壳按当前树结构把 `notes[path]` 挂到对应节点即可。
- `version` 留演进余地；`updatedAt` 供 UI 显示"最近更新"。

### 7.3 读/写方职责

- **写方**：仅内核工具 `structure_write`。壳**绝不写**侧车（`FsApi` 也没有带内容的写，物理上写不了——见 §8.2）。
- **读方**：壳插件（`ctx.fs.readFile`）+ 内核工具自己（写前读旧值做合并）。
- **清空**：面板"🗑 清空"按钮怎么实现？壳不能写侧车 → 清空通过**对话**完成（用户说"清空结构说明"，AI 调工具写空），或提供一个 `structure_clear` 工具。本版倾向**提供 `structure_clear`**（同样受模式门控），面板按钮经对话触发或直接触发（§17 开放问题）。

### 7.4 并发与一致性

- 单会话场景下写入是串行的（agent 一次一个工具调用），无并发。
- 多会话同时写同一项目侧车理论上可能，但结构分析是低频、单人操作，本版不做锁，接受"后写覆盖"。若将来需要，侧车写入可加文件锁（`config-file.ts` 有 `withDirLock` 原语）。

---

## 8. 模式开关机制详解

这是本版架构最需要讲清楚的一块：壳渲染进程如何可靠地控制内核子进程里一个工具的可用性。

### 8.1 模式状态的存储

模式状态 = 壳插件的一个**项目级配置项**：

```
config.set("analysisMode", true|false, { scope: "project" })
```

- 落盘：`<cwd>/.my-harness-desktop/config/structure-analysis.json`（框架推导路径）。
- 面板启动时 `config.get("analysisMode")` 读出，决定模式条初始态。
- 用户切开关 → `config.set` → 立即生效（下次工具调用就读到新值）。

**为什么用配置而不是别的：** 配置是壳插件的**原生可写**通道（`ctx.config.set`），且框架负责落盘与按 pluginId 隔离；内核侧读项目内一个 JSON 文件是它力所能及的（`node:fs`）。两边都不需要新能力。

### 8.2 关键约束：壳写不了任意文件，所以状态必须走配置

一个必须点破的约束（它决定了机制形状）：壳插件的 `FsApi`（`packages/shared/src/domain/sessions.ts:412`）**没有带内容的写文件**——只有 `createFile`（建空文件）、`readFile`、`renamePath` 等。也就是说，**壳物理上无法把模式标志直接写进一个自定义侧车文件**。

因此模式标志**只能走 `config.set`**（框架代写配置文件），而语义数据（节点说明）**只能由内核工具写**（内核有 `node:fs`）。这条约束恰好把职责切干净了：

- 壳写**配置**（它能写的）。
- 内核写**侧车**（它能写的）。
- 两者通过**文件系统**在 `<cwd>/.my-harness-desktop/` 下汇合。

### 8.3 为什么不用 toolgate / enabledToolIds 做门控

项目里已有一套工具白名单机制（`toolgate`，`packages/my-harness-fit-pi-extension/toolgate.ts`，读会话头 `toolConfig.enabledToolIds` 硬过滤）。乍看"放开/收起工具"可以用它，但本版**不用**，理由：

1. **它是 pi 专属。** `dsh-catalog.ts:54` 明确"dsh 无 tool-gate（pi 专属扩展面）→ 缺面"。用它，dsh 就拉不平，违背多内核对称。
2. **白名单语义不合。** `enabledToolIds` 是**白名单**（`sessions.ts:140`：显式空数组=全禁）。要"只放开 structure_write"，得把当前所有启用工具列全 + 增删这一项——等于侵入 `tool-manager` 的职责域，且极易和用户在工具管理器里的选择打架。
3. **配置标志位更简单通用。** 一个布尔位，双内核一致，不碰白名单。

**结论**：门控走配置标志位（§8.1）。toolgate 留作**可选的 pi 侧增强**（模式关闭时把 `structure_write` 从工具清单里也藏掉，减少 AI 注意力），但那是锦上添花，不是依赖，且必须在工具管理器白名单语义之外谨慎处理——本版默认**不做**，列为演进（§17）。

### 8.4 注意力控制：AI 怎么知道该不该用这个工具

`structure_write` **一直注册着**（两个内核都是），不做动态注册/注销（注册时机在内核扩展加载，难以随开关动态变）。那么怎么防止 AI 在模式关闭时乱用？三层：

1. **工具描述**（软约束）：描述里写清"仅当用户开启结构分析并要求写时调用"（§6.2）。
2. **配置硬门控**（兜底）：即便 AI 调了，`execute` 读配置发现关闭 → 拒绝 + 清晰理由（§6.4）。
3. **开关切换的会话提示**（上下文同步）：点"开始/结束"时往会话发一条系统样式提示（"工具已放开/收起"），让对话上下文也知道当前状态，AI 后续行为更贴合。

三层叠加：软约束让 AI 大概率不会在关闭时调用；硬门控保证即便调了也不会真的写；会话提示让状态对 AI 透明。

### 8.5 与 systemPrompts 槽位的关系（为什么不用它）

项目有 `systemPrompts` 槽（往会话注入系统提示）。乍看可用它在模式开启时注入"你现在可以做结构分析"。**但不用**，关键原因：

- **它是 pi-only。** `packages/shared/src/domain/backend.ts:232-234`：system prompt 注入"pi 翻译成 --append-system-prompt；**dsh 忽略**"。用它，dsh 又是缺面。
- **注入时机是 spawn。** 系统提示在会话 spawn 时注入，**中途切开关无法即时生效**。而模式开关的核心诉求恰恰是"随时切、即时生效"。

所以注意力控制走 §8.4 的三层（描述 + 硬门控 + 会话提示），不依赖 systemPrompts。这条也再次印证：**跨内核 + 动态生效的能力，不能押在 pi-only / spawn 时注入的机制上。**

### 8.6 开关切换的完整副作用清单

点「开始分析」（关闭→开启）：
1. `config.set("analysisMode", true)`（落盘）。
2. 往当前会话发系统样式提示 `· structure_write 工具已放开（结构分析开启）·`。
3. 面板重渲染：模式条变绿、按钮变「结束」、侧车状态变"已放开"、输入框 placeholder 变指挥文案。

点「结束」（开启→关闭）：对称反向（`analysisMode=false`、提示已收起、模式条回灰）。

**切换不动侧车**：已有的节点说明不受开关影响（产物持久）。切换也不清空对话。

---

## 9. 树观察面实现

### 9.1 树读取与"真·全展开"（懒加载）

- `FileTreeNode`（`packages/shared/src/domain/sessions.ts:434`）语义：目录 `children: undefined` = 未下钻，消费方可懒加载；`children: []` = 空目录。
- **深度切换 1/2/3**：`readDirTree(root, { maxDepth: 1|2|3, ignore })` 一次拿 N 层，纯参数差异，无懒加载。
- **全展开**：无固定上限。初次 `readDirTree(root, { maxDepth: 1 })` 只拿根层；展开某目录时对该目录 `readDirTree(dirPath, { maxDepth: 1 })` 下钻一层。只读展开的部分，巨型项目也不卡。
- `ignore` 清单默认 `["node_modules", ".git", "dist", "out", "build", "__pycache__"]`，可在 ⚙ 弹层增删，持久化到项目级配置。

**深度态与全展开态的渲染统一**：渲染器只认"当前已拿到的 `FileTreeNode` 树"，深度切换只是改变"一次读多深"，全展开只是"分多次读"。渲染逻辑对两者无感，避免两套代码。

### 9.2 过滤（两种，正交）

本版保留两种过滤（v1 的"勾选聚焦"随 checkbox 一起取消）：

1. **搜索聚焦**：工具栏关键字。保留命中节点 + 其祖先链，其余折叠为 `▸`。**纯前端**，不重读磁盘（对已加载的树做切片）。命中词高亮。
2. **排除目录**：`ignore` 清单，读树前由**内核**跳过（`readDirTree` 的 `ignore` 参数），不回读子树。这是"读之前就不读"，与搜索的"读了再藏"正交。

> 说明：两种过滤一前一后——`ignore` 作用于**读树时**（省 IO），搜索作用于**渲染时**（省交互）。改动 `ignore` 需要重读树，改搜索词不需要。

### 9.3 逐节点说明的渲染

- 渲染树时，对每个目录节点查 `notes[path]`，有则在该节点行下方渲染一行灰字说明，并在行尾加 📝。
- **新写入高亮**：本次回传新增/变更的 `path` 集合，渲染时给对应说明加 `flash` 动画（一下蓝色渐隐）。实现上，回传消息带上 `changedPaths`，或壳对比前后 `notes` 的 diff。
- 说明是**目录级**的（每个目录一句），不给文件级写说明（文件的语义由其所在目录的说明涵盖）。

### 9.4 性能

- **读树**：深度态单次 `readDirTree` 是内核一次递归，项目几千节点内无压力；全展开按需下钻，天然分摊。
- **渲染**：树是扁平化后一次渲染，节点多时可考虑虚拟化，但结构分析场景目录数通常可控（用户靠深度/过滤收敛视野），本版不做虚拟化，列为演进。
- **侧车读取**：`annotations.json` 是小 JSON（几十~几百条），读取可忽略。回传触发重读是低频事件。

---

## 10. 槽位与挂载

### 10.1 主落点：sidePanel

| 字段 | 值 | 说明 |
|---|---|---|
| `id` | `structure` | 槽位贡献 id |
| `label` | `结构分析` | Tab 文案（走 i18n key） |
| `icon` | `folder-tree` | 图标 token |
| `component` | `StructureAnalysisTab` | 与 `renderer/index.tsx` export 同名 |
| `order` | `20` | 「Review」10 与「文件」30 之间 |

挂 `sidePanel`，右面板一个 Tab。`isActive` 由框架传入，控制面板在不可见时不做无谓重读。

### 10.2 副落点：composerAttachments（降级为可选）

v1 的核心结合通道，本版**降级为可选、默认不做**。理由：本版的结合是"对话指挥 + 工具写回"，已经天然嵌在会话里，不需要再把结构作为附件投喂。

保留它的一个可能用途：用户想"把当前结构 + 已写说明作为背景，发起一个全新话题"时，可以把它作为附件带进新会话。但这是锦上添花，列演进（§17），不阻塞首版。

### 10.3 不落的槽位

- **`systemPrompts`**：不用（§8.5，pi-only + spawn 时机）。
- **`mainView`**：不落（中区是 timeline 本体）。
- **`sidebar`**：不落（左栏是导航）。
- **`settingsGroups`**：可选——若要暴露"默认深度 / 默认 ignore"给用户配，走通用设置页。本版默认 ignore 有合理缺省，设置项列演进。

### 10.4 revealOn（可选）

可声明 `revealOn: "structure:updated"`：当工具写入发生（回传到达）时，若右面板没展开/没激活本 Tab，自动展开并切到本 Tab，让用户"一写入就看到"。这是增强可见性的可选行为，需权衡"自动跳面板会不会打扰"——本版倾向**开**（写入是用户主动要求的，跳过去看正是他要的），但留配置余地。

---

## 11. manifest 与权限

### 11.1 manifest

```jsonc
{
  "id": "structure-analysis",
  "version": "0.1.0",
  "tier": "official",
  "displayName": "结构分析",
  "description": "右面板可开关的目录结构写入面板：平时观察目录树，开始分析后在对话里指挥 AI 写入职责说明",
  "tags": ["project", "analysis"],
  "renderer": "./renderer/index.tsx",
  "permissions": ["fs:project", "sessions:bus"],
  "piExtension": "./pi-extension",
  "dshExtension": "./dsh-extension",
  "contributes": {
    "sidePanel": [
      { "id": "structure", "label": "结构分析", "icon": "folder-tree",
        "component": "StructureAnalysisTab", "order": 20,
        "revealOn": "structure:updated" }
    ],
    "languages": [ /* zh-CN / zh-TW / en / de */ ]
  }
}
```

### 11.2 权限收窄（相对 v1）

| 权限 | v1 | v2 | 原因 |
|---|---|---|---|
| `fs:project` | ✅ | ✅ | 读树 + 读侧车 + 写配置（配置经框架，但读侧车需要） |
| `llm:oneshot` | ✅ | ❌ **移除** | 生成下沉内核工具，壳不再发 LLM 请求 |
| `sessions:bus` | ❌ | ✅（pi 实时回传用） | 监听 pi 工具的 bus 帧；dsh 无 bus 则此权限在 dsh 下无对应面（显式降级） |

**权限收窄是本版"壳退为纯观察"的直接体现**：壳不再需要 `llm:oneshot`（不生成），只需要读（`fs:project`）+ 监听（`sessions:bus`）。

### 11.3 piExtension + dshExtension 双字段

一个插件同时携带两个内核扩展，框架分别同步：
- `piExtension` → `~/.pi/agent/extensions/<pluginId>/`（pi-extension-installer，随插件启停）。
- `dshExtension` → `~/.dsh/.my-harness-desktop-plugins/<pluginId>/` + 挂 cordis.yml 块（dsh-extension-installer，随插件启停）。

两者都由框架在插件激活时同步、停用时摘除，插件作者不手写同步逻辑。

---

## 12. 多内核不对称处理

这是本项目"多内核默认"纪律（CLAUDE.md §1.5、§7.6）在本插件的具体应用。逐个差异过"能力拉平三分法"：适配器翻译 → 内核插件补面 → 显式降级。

### 12.1 工具注册：形状不同，语义相同 → 各自适配

- pi：`pi.registerTool({ name, description, parameters, execute })`。
- dsh：`ctx.tools.register({ name, label, description, parameters, output, execute })`，且需 `export const inject = ["tools"]`。

两者参数形状略有差异（dsh 多 `label`/`output`），但语义一致（注册一个工具）。这属于"同一语义、形状不同"，**各自在扩展里适配**，共享的部分（门控、侧车读写的纯逻辑）抽到 `core/`。

### 12.2 回传通道：pi 有 bus，dsh 没有 → dsh 降级为文件监听

- **pi**：工具 `emitFrame` → 壳 `ctx.bus.onMessage`。实时、事件驱动。
- **dsh**：没有 bus 通道（dsh 的桌面通信走文件侧车，见 `src/server/kernel/dsh/dsh-extension/index.mjs` 的 ask/goal 均为文件侧车）。**降级**：壳监听侧车文件变化（`chokidar`，事件驱动）触发重读；若不可用，退为"会话消息结束时重读 + ↻ 手动刷新"。

**降级是显式的，不静默**：dsh 下状态条可提示"实时回传不可用，改动在消息结束后/手动刷新时同步"。正确性不受影响（侧车是真相源，↻ 总能读到）。

### 12.3 门控机制：配置标志位，双内核一致 → 无需拉平

`analysisMode` 读配置是纯 `node:fs`，两个内核扩展都能做，**天然对称**，无需翻译/补面/降级。这正是选配置标志位而非 toolgate 的红利——toolgate 是 pi-only，会把一个本可对称的能力变成不对称。

### 12.4 能力差异小结

| 能力 | pi | dsh | 处理 |
|---|---|---|---|
| 注册 `structure_write` | ✅ | ✅ | 各自适配（形状差异） |
| 读配置门控 | ✅ | ✅ | 对称 |
| 写侧车 | ✅ | ✅ | 对称 |
| 实时回传 | ✅（bus） | ❌（无 bus） | dsh 降级为文件监听 |
| `sessions:bus` 权限对应面 | ✅ | ❌ | dsh 下该权限无对应面，显式降级 |

**结论**：核心能力（注册/门控/写侧车）双内核完全拉平；唯一不对称是回传实时性，dsh 显式降级，不静默、不伪造。

---

## 13. 分层纪律对照

对照 CLAUDE.md §1（依赖只向内、机制内容分离、契约单源、无特权、多内核默认）逐条自检。

### 13.1 目录结构与归属

```
src/plugins/project/structure-analysis/
  plugin.json
  renderer/
    index.tsx              # StructureAnalysisTab（右面板 Tab 入口，usePluginContext）
    mode-bar.tsx           # 模式开关条（开始/结束）
    toolbar.tsx            # 搜索 + 深度 + ⚙排除 + 刷新
    structure-tree.tsx     # 树 + 逐节点说明渲染（懒加载下钻）
    ignore-sheet.tsx       # 排除目录弹层
    status-strip.tsx       # 侧车/工具状态条
  core/                    # 纯类型 + 纯函数，零依赖，可单测
    types.ts               # Annotation / AnnotationFile / ModeState 类型
    notes-merge.ts         # 纯函数：旧 notes + entries → 新 notes（upsert）
    tree-attach.ts         # 纯函数：FileTreeNode + notes → 带说明的渲染树
    serialize.ts           # 纯函数：树 → 缩进文本（演进期 composerAttachments 用）
  client/
    tree-reader.ts         # readDirTree 封装：深度/懒加载/ignore 透传
    sidecar-reader.ts      # 读 annotations.json（ctx.fs.readFile + 容错）
    mode-flag.ts           # analysisMode 读写（ctx.config）
    update-listener.ts     # 回传监听：pi=bus / dsh=chokidar（按能力探测分支）
  pi-extension/
    index.ts               # pi.registerTool(structure_write)；execute 复用 core 门控/侧车逻辑
  dsh-extension/
    index.mjs              # ctx.tools.register(structure_write)；同上
    extension.json         # { displayName, description }
  locales/{zh-CN,zh-TW,en,de}/*.json
```

### 13.2 依赖只向内检验

- `core/` 零依赖：`notes-merge`/`tree-attach` 是纯函数，不 import 任何包，可单测。内核扩展复用这份逻辑时**内联**（内核扩展运行在内核进程，不能 import 壳的 `core/`，需把纯函数内联进扩展，或经构建注入——见 §17 开放问题）。
- `client/` 只做 IO 适配，不写 UI，不 import `src/server`/`src/web` 内部。
- `renderer/` 只调 `usePluginContext()` + 纯展示。
- 内核扩展（`pi-extension`/`dsh-extension`）运行在内核进程，只 import 内核 API + `node:` 内建，不 import 壳。

### 13.3 机制与内容分离

- 壳不提供任何"结构分析"的机制——加载器、槽位、配置通道、bus、文件监听全是既有机制。本插件是**内容**，挂在既有机制上。
- 文案（模式条文案、提示、工具描述的中文部分）走 i18n key，颜色走主题 token，零硬编码。

### 13.4 零硬编码

- pluginId 由框架注入；component 名由框架匹配；侧车/配置路径由框架按 pluginId 推导（内核扩展侧读配置文件的文件名，沿用 llm-recorder 先例，见 §17 对"扩展如何得知自身配置文件名"的讨论）。

---

## 14. 状态机与时序

### 14.1 模式开关状态机

```
        ┌─────────────┐
        │   关闭(默认) │  analysisMode=false，工具收起
        └──────┬──────┘
   点「开始」   │  config.set(true) + 会话提示「已放开」
               ▼
        ┌─────────────┐
        │    开启      │  analysisMode=true，工具放开
        └──────┬──────┘
   点「结束」   │  config.set(false) + 会话提示「已收起」
               ▼
           （回到关闭）
```

两态、显式切换、切换即落盘。没有中间态。busy（AI 正在写）时切换被临时禁用，避免竞态。

### 14.2 一次成功写入的时序（pi）

```
用户: "给 src/server 写说明"
  └→ 内核 agent 生成 toolCall: structure_write({entries:[{path:"src/server",note:"…"}]})
       └→ pi-extension execute:
            1. readFileSync(config/structure-analysis.json) → analysisMode=true → 放行
            2. readFileSync(structure-analysis/annotations.json) → 旧 notes
            3. notes-merge(旧, entries) → 新 notes
            4. writeFileSync(annotations.json, 新)
            5. emitFrame({to:"plugin:structure-analysis", kind:"structure_updated", changedPaths:["src/server"]})
            6. return {written:1, paths:["src/server"]}
       └→ agent 收到回执，回复"已写入，还要深入哪个目录？"
  └→ 壳 ctx.bus.onMessage 收到 structure_updated
       └→ sidecar-reader 重读 annotations.json → tree-attach → 重渲染（src/server 说明闪烁）
```

### 14.3 一次成功写入的时序（dsh）

与 14.2 相同，唯二差异：
- 注册用 `ctx.tools.register`，`execute(args, exec)` 形状。
- **无第 5 步 emitFrame**。壳靠 `chokidar` 监听 `annotations.json` 变化 → 重读 → 重渲染。实时性略低于 pi，但事件驱动、无轮询。

### 14.4 模式关闭时被调用的时序（门控生效）

```
用户（未点开始）: "给 src/server 写说明"
  └→ agent 调 structure_write
       └→ execute 第 1 步读配置 → analysisMode=false
            └→ return {refused:true, reason:"结构分析未开启…请让用户点开始分析"}
       └→ agent 收到拒绝，回复用户"需要先在右面板点开始分析"
  （侧车未被写入；无 bus 帧；面板无变化）
```

---

## 15. 边界与非目标（汇总）

- **只看目录结构粒度**，不读代码文件内容，不做行级 review。
- **不做壳侧生成**，不用 `llm:oneshot`。
- **不做一键全量报告按钮**，生成由对话驱动。
- **不做跨项目汇总**，侧车按 `<cwd>` 隔离。
- **不接管工具白名单**（不动 `enabledToolIds`）。
- **面板不写语义数据**，只写自己的配置标志位。
- **本版不做虚拟化渲染、不做 composerAttachments、不做 settingsGroups 设置项**（均列演进）。

---

## 16. 落地计划（每个 commit 都是可用的完整态）

1. **骨架 + 观察面**：`plugin.json` + `locales` + `renderer/index.tsx` + `toolbar.tsx` + `structure-tree.tsx` + `core/types.ts` + `client/tree-reader.ts`。挂上右面板，能浏览树（深度/过滤/排除），无写入、无模式。
2. **内核工具（pi）**：`pi-extension/index.ts` + `core/notes-merge.ts`（内联）。`structure_write` 可被 pi agent 调用，写侧车，门控生效。
3. **内核工具（dsh）**：`dsh-extension/index.mjs` + `extension.json`。dsh 对称落地。
4. **模式开关 + 侧车渲染**：`mode-bar.tsx` + `status-strip.tsx` + `client/mode-flag.ts` + `client/sidecar-reader.ts` + `core/tree-attach.ts`。开关控门控、侧车渲染说明、会话提示。
5. **回传联动收尾**：`client/update-listener.ts`（pi=bus / dsh=chokidar）+ `revealOn`。写入实时反映到面板。

每步交付后，前一步的能力都完整可用：第 1 步是纯观察面板，第 4 步起是完整"可开关写入面板"。

---

## 17. 风险与开放问题

按"显式标注、不藏"的纪律列出：

1. **内核扩展如何复用 `core/` 纯函数。** 内核扩展运行在内核进程，不能 import 壳的 `src/plugins/.../core/`。`notes-merge` 等纯逻辑要么**内联**进扩展（llm-recorder 先例是内联手写窄结构），要么经构建把纯函数产物注入扩展目录。倾向内联（简单、与先例一致），但需接受"同一纯逻辑在壳 core 与两个扩展各有一份"的契约单源张力——缓解：以壳 `core/` 为真相源 + 单测，扩展内联版对齐之。**待开发时定案。**
2. **内核扩展如何得知自身配置文件名。** llm-recorder 的 pi-extension 硬编码 `llm-recorder.json`（自身 pluginId）。本插件沿用则需在内联代码里写死 `structure-analysis.json`。这与"零硬编码 pluginId"有张力——但它是扩展引用**自身**配置的既有先例，倾向接受（扩展知道自己的身份），或探索安装器把 pluginId 注入扩展。**待确认。**
3. **`structure_clear` 是否需要。** "🗑 清空"按钮因壳写不了侧车，需经内核。提供 `structure_clear` 工具（受门控）最干净，但面板按钮怎么触发内核工具？要么经对话（用户说"清空"），要么壳发一条指令消息。**待设计。**
4. **dsh 文件监听的可靠性。** `chokidar` 在不同 OS/文件系统（尤其网络盘）的事件可靠性不一。若不稳，退化为"会话消息结束重读 + 手动刷新"。**需实测。**
5. **`revealOn` 自动展开是否打扰。** 写入即展开右面板，若用户此刻在看别的 Tab，可能打扰。本版倾向开（写入是用户主动要求的），但留配置。**待用户反馈。**
6. **AI 过度写入。** 工具描述约束 + 面板可见性是软兜底，若 AI 仍频繁写没被要求的节点，考虑在开关提示里加更强的范围说明，或在工具回执里提示"仅写了被要求的 N 条"。**观察后调优。**

---

## 18. 验收标准

- **观察面**：树可浏览，深度 1/2/3/全展开（懒加载）正常，搜索过滤命中+祖先链，排除目录生效且持久。
- **模式开关**：默认关闭；点开始变绿 + 配置落盘 + 会话提示；点结束回灰。切换即时生效（下一次工具调用即读到新值）。
- **写入（pi）**：开启后对话指挥，`structure_write` 写侧车，面板实时出现说明 + 闪烁 + 📝；关闭时调用被拒绝并提示。
- **写入（dsh）**：同上，回传经文件监听（或降级路径），最终一致。
- **门控**：关闭态调用必被拒（硬门控），侧车不被写。
- **持久化**：说明跨开关、跨面板重开、跨应用重启保留；切项目不串。
- **覆盖**：对同一目录重写，新说明覆盖旧的。
- **纪律**：`core/` 纯函数可单测；壳不写语义数据；权限无 `llm:oneshot`；双内核能力对称、降级显式。

---

## 19. 附录

### 19.1 与 v1（壳侧生成）差异对照

| 关注点 | v1 做法 | v2 做法 | 动因 |
|---|---|---|---|
| 谁生成说明 | 壳 `llm:oneshot` | 内核 agent + `structure_write` | 上下文在 agent 手里；能力归内核 |
| 说明写哪 | `ctx.config` 分桶 | 内核写侧车 `annotations.json` | 壳无带内容文件写；写权归内核 |
| 怎么结合会话 | `composerAttachments` 附件 | 对话指挥 + 工具写回 | 双向回路，非单向投喂 |
| 启停 | 按钮即生成 | 显式模式开关 | 不污染日常对话；清晰心理状态 |
| 壳权限 | `fs:project`+`llm:oneshot` | `fs:project`+`sessions:bus` | 壳退为纯观察 |
| 内核侧 | 无 | pi-extension + dsh-extension | 生成下沉内核 |

### 19.2 关键参考文件（机制落点）

- 配置开关 + 内核读配置先例：`src/plugins/insight/llm-recorder/pi-extension/index.ts`（第 14/86 行，按 `process.cwd()/.my-harness-desktop/config/<pluginId>.json` 每请求读开关）。
- 工具注册（pi）：`packages/my-harness-fit-pi-extension/tools/*.ts`、`bus.ts`（`pi.registerTool` + `emitFrame`）。
- 工具注册（dsh）：`src/server/kernel/dsh/dsh-extension/index.mjs`（`ctx.tools.register` + `inject:["tools"]` + 文件侧车先例）。
- dsh 扩展同步：`src/server/kernel/dsh/dsh-extension-installer.ts`。
- 树契约：`packages/shared/src/domain/sessions.ts`（`FsApi`/`FileTreeNode`/`ReadDirTreeOptions`）。
- toolgate（本版不用，作对比）：`packages/my-harness-fit-pi-extension/toolgate.ts`；dsh 缺面：`src/server/kernel/dsh/backend/dsh-catalog.ts:54`。
- systemPrompts pi-only：`packages/shared/src/domain/backend.ts:232-234`。
- 槽位/权限：`packages/shared/src/domain/contributions.ts`、`context.ts`。

### 19.3 术语表

| 术语 | 含义 |
|---|---|
| 观察面 | 右面板目录树视图，只读，供观察思考 |
| 写入工具 | `structure_write`，内核工具，唯一写侧车者 |
| 模式开关 | 开始/结束，控制工具放开/收起 |
| 侧车文件 | `annotations.json`，节点说明单一真相源，内核写壳读 |
| 配置标志位 | `analysisMode`，壳写内核读的开关位 |
| 放开/收起 | 工具可用/不可用（门控通过与否），≠ 注册与否 |
| 回传 | 写入后通知壳刷新的通道（pi bus / dsh 文件监听） |

---

> **一句话收尾**：本插件把"结构分析"从"壳侧生成一份报告"翻面成"内核工具 + 可开关画布"——平时是一棵可靠的树供你观察，点开始放开一支笔，你在对话里指挥 AI 往树上写，边看边想边改。核心还是会话，面板是它的外置画布。
