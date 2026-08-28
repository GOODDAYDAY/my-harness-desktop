# 结构分析插件设计（structure-analysis）

> 状态：**架构已拍板并经三轮盲审修订，待开发。**
> 版本：v2.1（盲审修订版。v2.0 完成"壳侧生成 → 内核工具"翻面；v2.1 依据架构/技术/产品三轮盲审修正硬伤）。
> 关联：`docs/plugins/git-review.md`、`docs/plugins/projects.md`、`docs/design/plugin-decoupling.md`、`docs/design/tool-manager-design.md`、`docs/plugins/llm-recorder.md`（**配置开关 + 内核侧车**先例，机制范式直接沿用）。
> 低保真：`docs/design/structure-analysis-lofi.html`（可开关写入面板）。

---

## 0. 文档导读与修订说明

### 0.1 本版为什么大改（v1 → v2）

v1 把"生成介绍 / 生成 review"放在**壳渲染层**，用 `ctx.llm.oneshot` 由插件自己发 LLM 请求，再把结果作为**附件**经 `composerAttachments` 投喂回会话。这套方案被否定，原因有三：

1. **生成逻辑放错了层。** 让壳插件自己调 `llm:oneshot`，等于在 UI 层再造一个"小 agent"——自己拼 prompt、管上下文、消化结果。而内核里本就坐着一个完整的、带着会话上下文的 agent。**该让 agent 干的活，不该让 UI 抢着干。**
2. **"附件投喂"方向反了。** v1 是"面板生成 → 附件 → 会话"，单向。但真实需求是**看着结构和 AI 一起思考**：用户在面板观察，在对话里指挥，AI 把结论**写回面板**，用户接着看、接着想。这是双向、持续的协作回路，不是一次性投喂。
3. **用户要的是"可靠的观察面 + 一支可放开的笔"。** 最终形态：面板是可靠的目录结构观察界面（供观察与思考），配一个**默认收起、按需放开**的写入工具（`structure_write`）。点"开始分析"放开这支笔，然后在对话里让 AI 往树上写；不分析时笔收着，面板只是一棵树。

### 0.2 v2.1 盲审修订要点（相对 v2.0）

三轮盲审（架构纪律 / 技术可行性 / 产品完整性）后，v2.0 的若干论断被证实不成立或含糊，本版修正：

| # | v2.0 的问题 | v2.1 的修正 |
|---|---|---|
| R1 | dsh 回传写成"壳用 chokidar 监听侧车" | 渲染进程无文件 watch 能力（已核实）。改为：**首版用 `sessions.onEvent` 的 messageEnd 重读 + ↻ 手动刷新**；文件 watch 列为需新增壳能力的**演进前置**（§5.5/§12.2/§16） |
| R2 | "开关切换往会话发系统提示，让 AI 知道状态" | 该机制不存在（`MessagingApi.prompt` 会触发生成，无 UI-only 注入；systemPrompts 是 pi-only 且仅 spawn 时注入）。**删除此机制**，改为：AI 状态感知 = 工具描述 + 硬门控拒绝回执；模式状态只在面板展示（§8.4/§8.6） |
| R3 | 模式粒度未定，且"默认关闭/常态"与"项目级持久"矛盾 | **定为项目级**并显式声明"跨会话、跨重启保持，直到点结束"；"默认关闭"改为"首次未配置时为关闭"（§8.1） |
| R4 | "清空"跳到 `structure_clear` 工具，称"壳写不了侧车" | 壳有 `FsApi.removePath`，**清空 = 删除侧车文件**，下次重建。无需新工具（§7.3） |
| R5 | `notes-merge`/侧车格式计划"壳 core + pi 扩展 + dsh 扩展各一份" | 违反契约单源。改为**单一真相源 + 构建注入**（§13.2/§17.1） |
| R6 | 落地计划 step1 只读树、step2/3 拆 pi/dsh | 重排为**每步完整、无 pi-only 中间态**、前置定案前移（§16） |
| R7 | 孤儿 note、侧车损坏、无会话开关等边界零覆盖 | 补入 §3 场景与 §17 开放问题 |

### 0.3 术语约定

- **观察面**：右面板目录树视图。只读、可靠、供观察与思考，不生成内容。
- **写入工具**（`structure_write`）：注册在内核的工具，AI 调用它把节点说明写进结构树。唯一能改侧车的写入口。
- **模式开关**（开始/结束）：面板上的显式开关，控制写入工具放开/收起。
- **放开 / 收起**：工具**可用 / 不可用**（门控通过与否），**≠ 注册与否**。工具一直注册着，"收起"只是调用会被拒绝。
- **侧车文件**（sidecar）：内核写、壳读的项目内 JSON，节点说明的单一真相源。
- **配置标志位**：壳写、内核读的开关位（`analysisMode`），模式开关跨进程落地的载体。范式沿用 `llm-recorder`。

> 完整术语表见 §19.3；非目标见 §15；v1/v2 差异对照见 §19.1（正文不再重复）。

---

## 1. 背景与动机

### 1.1 问题：看结构做架构 review 的现状很原始

想审视一个项目的**架构 / 分层 / 职责**时，现有手段都别扭：

- 直接让 AI `ls -R` / 读一堆文件：token 消耗大、噪音多，AI 看到的是散点，用户看不到全貌。
- file-tree 插件：回答"文件在哪"，不回答"目录是干什么的、架构对不对"。它是导航，不是分析。
- 人工在脑子里搭结构：看着一层层目录自己推断职责、判断依赖方向，累且易漏。

用户真正想要的：**看着一棵干净的目录树，每个目录旁有一句职责说明，AI 陪我一起看、一起想，我指哪它写哪，我边看边改主意。** 这是"观察—思考—对话—落笔"的循环，不是"点按钮等一份报告"。

### 1.2 为什么不是 file-tree，也不是 git-review

- **file-tree** 给"文件在哪"（文件级导航）；本插件给"目录是干什么的、架构对不对"（目录级语义 + 判断）。互补。
- **git-review** 围绕 **diff**（这次改动怎么样）；本插件围绕**稳定的目录结构**，与是否改动无关。二者共享"会话结合"范式，对象不同。

### 1.3 "核心还是会话"的再确认

用户反复强调：**核心还是会话，面板是辅助。** 这决定了本插件一切边界：

- 面板**不抢主动权**：不会自己跳出生成结论，不会在用户没开口时往会话塞东西。
- 面板是**观察与思考的台面**：用户看着它、想清楚、在对话里说出来。
- AI 的结论**写回面板**：让思考"看得见"，而不是淹没在滚动的消息流里。

一句话：**面板是会话的一块"外置画布"，会话是主语，画布是宾语。**

---

## 2. 核心概念与定位

### 2.1 一句话定位

> **一个挂在右面板的、可开关的目录结构写入面板：平时是一棵可靠的目录树供你观察思考；点"开始分析"放开写入工具后，你在对话里指挥 AI 把职责说明 / 架构判断写进树里，边看边想边改。**

### 2.2 三个关键词

1. **观察面（reliable observation surface）**：目录树 + 深度 + 过滤 + 排除 + 逐节点说明。必须可靠——读树稳定、渲染稳定、说明持久。用户盯着它思考，它不能抖。
2. **写入工具（armable write tool）**：`structure_write`。常注册、被模式门控。是内核里 agent 的工具，不是壳里的按钮。
3. **模式开关（explicit mode switch）**：开始/结束。把"放开写入工具"显式化、仪式化——用户明确说"现在我要搞结构分析了"，而不是 AI 随时随地可能往树上写。

### 2.3 为什么要有模式开关（而不是工具常开）

用户原话："**平时不分析就不用开，就放开可以往里写信息的工具。**" 背后三个诉求：

- **不污染日常对话。** 若常开，AI 在任何会话都可能"好心"往结构树写。开关把它限制在"用户明确要做结构分析"的场合。
- **清晰的心理状态。** 用户需要看得见的答案："现在是不是在分析？"模式条上的绿点就是答案。
- **干净的收尾。** 点"结束"，工具收起、画布冻结，用户安心做别的，不担心树还在被改。

### 2.4 非目标（本版不做）

- **不做代码级 review。** 不读业务代码文件内容、不做行级审查。只看**目录结构**这个粒度。
- **不做壳侧自动生成。** 不用 `llm:oneshot` 由插件发起生成。
- **不做"一键全量报告"按钮。** 生成由对话驱动、按需进行；发起者是对话，不是按钮。
- **不做跨项目全局结构库。** 侧车按 `<cwd>` 隔离。
- **不接管 tool-manager 的工具白名单。** 门控走配置标志位，不动 `enabledToolIds`（§8.3）。

---

## 3. 用户场景与故事

### 3.1 场景一：平时浏览（模式关闭）

> 打开项目，切到"结构分析"Tab。看到目录树，切到二级，扫一眼 `src/` 几大块。只是想确认项目长什么样，**不打算分析**。模式条灰着：`⚪ 结构分析未开启`。我在对话里问 AI 别的（改 bug、问用法），AI 正常回答，**不会**往结构树写。

**要点**：模式关闭是**首次未配置时的初始态**。此时面板是增强版 file-tree（带深度/过滤/排除），写入工具收起。

### 3.2 场景二：开始分析，指挥 AI 写

> 想认真看架构了。点 **「🧭 开始分析」**，模式条变绿：`🟢 分析中 · structure_write 已放开`。
> 我在输入框说："**给 `src/server` 和 `packages` 写一句职责说明。**"
> AI 回应后调用 `structure_write`，会话里出现工具卡 `🛠 structure_write · 写入 2 条`。几乎同时，右面板 `src/server`、`packages` 下各冒出一行说明 + 📝 + 蓝色闪烁。

**要点**：开关放开工具 → 对话指挥 → 工具写侧车 → 面板渲染。回路全程可见。

### 3.3 场景三：边看边想边改

> 看到 `src/server` 说明不够准——它其实不该含 controllers。我说："那句改一下，controllers 属于 api 层，不算 server。" AI 重新调 `structure_write` 覆盖。面板更新。
> 我又说："`src/server/application` 和 `client` 也写一下，顺便说说依赖方向对不对。" AI 写两条，并在对话里补了架构判断。我盯着树想，继续。

**要点**：核心价值场景——**观察（面板）与思考（对话）交织**。写入可覆盖、可追问、可下钻。

### 3.4 场景四：结束分析

> 看得差不多，点 **「⏹ 结束」**。模式条回灰，工具收起。树上已写的说明**都还在**（落在侧车，跟项目走）。再次"开始"可继续追加。

**要点**：结束≠清空。产物持久。

### 3.5 场景五：清空

> 写乱了想重来。点 **「🗑 清空」**。壳调 `ctx.fs.removePath` 删除侧车文件，面板说明消失；下次写入自动重建侧车。

### 3.6 边界场景（本版显式定义）

- **切项目**：侧车按 `<cwd>` 隔离，切到新项目读新侧车；模式条按新项目的 `analysisMode` 重置（新项目未配置=关闭）；树自动重读新项目。
- **会话切换 / 新建**：模式是**项目级**，跨会话保持。切到另一个会话，模式条仍显示项目当前状态；该会话的 AI 同样受门控（开则可写、关则被拒）。
- **多会话同时**：项目级开关对所有会话一致生效。因为写入总由**用户主动要求**触发（工具描述约束"仅当用户要求时写"，§6.2），不存在"某会话的 AI 背着用户偷偷写"。
- **无会话时点"开始"**：只置位配置标志 + 更新面板，不涉及会话（没有任何会话注入动作，§8.6）。之后任意会话都按此标志受门控。
- **说明文字很长**：渲染单行 + 省略号，完整文本在行尾 📝 悬停/展开查看（§9.3）；工具描述软约束"一句话"，超长由 AI 自律 + 渲染兜底。
- **目录被重命名 / 删除**：旧说明成为**孤儿 note**，不再渲染、惰性残留在侧车。本版不做自动迁移，列为已知局限（§17.2），清空可一并移除。
- **全展开巨型树**：逐层手动下钻，只读展开部分（§9.1）；搜索只作用于**已加载层**，不触发自动下钻（§9.2）。
- **侧车被手动编辑 / 损坏**：读取容错——损坏/非法时面板按"无说明"渲染 + 状态条提示"侧车读取失败"，不崩溃（§17.3）。
- **反场景：模式没开却让 AI 写** → AI 调工具被**硬门控拒绝**，回执说明"未开启，请让用户点开始分析"，AI 转达用户。**不静默、不假装写了。**（§14.4）

---

## 4. 交互设计

### 4.1 面板总体布局

```
┌─ 结构分析 ────────────────────────────────────────────────────────┐
│ [🔍 过滤…]  (○一级)(●二级)(○三级)(○逐层展开)   [⚙排除] [↻]        │  ① 工具栏（观察控制）
├──────────────────────────────────────────────────────────────────┤
│ ⚪ 结构分析未开启 · 只浏览结构，写入工具未放开      [🧭 开始分析]   │  ② 模式开关条
├──────────────────────────────────────────────────────────────────┤
│ 📁 src                                                            │
│    源码入口，含 plugins/server/web 三大部分      📝               │  ③ 树观察面
│   ├─ 📁 plugins    内容层壳插件                  📝               │     （逐节点说明）
│   ├─ 📁 server     后端：应用编排/内核/…          📝               │
│   │   ├─ 📁 application                          （未写）         │
│   │   └─ 📁 client     流出适配器                📝               │
│   └─ 📁 web        渲染层                        📝               │
│ 📁 packages                                                       │
├──────────────────────────────────────────────────────────────────┤
│ 🟢 structure_write 已放开 · 侧车 …/structure-analysis/…           │  ④ 侧车/工具状态条
├──────────────────────────────────────────────────────────────────┤
│ 「开始」放开 structure_write → 对话里让 AI 写 → 这里观察。 [🗑清空]│  ⑤ 底部提示 + 清空
└──────────────────────────────────────────────────────────────────┘
```

自上而下五个区块：**① 观察控制（工具栏）→ ② 模式开关条 → ③ 树观察面 → ④ 侧车/工具状态条 → ⑤ 底部提示 + 清空**。模式开关条位于树之上，是面板的"状态中枢"，一眼可见。

### 4.2 模式开关条

面板里唯一"有状态"的控制，其余都是无状态观察控件。

| 态 | 视觉 | 文案 | 按钮 |
|---|---|---|---|
| 关闭 | 灰点、无底色 | `结构分析未开启 · 只浏览结构，写入工具未放开` | `🧭 开始分析`（主色填充，醒目） |
| 开启 | 绿点（光晕）、整条淡绿底 | `分析中 · structure_write 已放开，下方对话里指挥 AI 写` | `⏹ 结束`（幽灵按钮，弱化） |

**设计意图**：关闭态按钮醒目（邀请开启），开启态按钮弱化（避免误触结束）。绿点+绿底是"正在分析"的持续视觉锚点。

**开关切换的副作用**（完整清单见 §8.6，此处概述）：写配置标志位 `analysisMode` → 面板重渲染（模式条、状态条、输入框 placeholder）。**不往会话注入任何消息**（该机制不存在，§8.4/R2），**不动侧车**。

**busy 时开关置灰禁用**：AI 正在执行写入时，开关 `disabled` + 视觉置灰，避免半空中抽走工具。

### 4.3 树观察面

树是面板主体，纯观察：

- **深度切换**：一级/二级/三级/逐层展开（§9.1，逐层=手动下钻懒加载）。
- **搜索过滤**：命中路径 + 祖先链保留，其余折叠（§9.2，纯前端，只作用已加载层）。
- **排除目录**（⚙）：持久忽略清单，读树前由内核跳过（§9.2）。
- **逐节点说明**：目录节点下方一行灰字，来自侧车；有说明的节点行尾 📝。新写入的说明闪一下蓝色（仅新增/变更项，§9.3）。
- **刷新**（↻）：手动重读树 + 侧车（兜底，尤其 dsh 无实时回传时，§5.5）。

树**不带 checkbox**——本版不需要"圈定范围生成"，范围由对话自然表达。保持观察面干净。

### 4.4 对话驱动写入

写入发起永远在**中区对话**，面板不提供"生成"按钮。

- 模式开启：输入框 placeholder = `指挥 AI 往结构树里写，例如：给 packages 和 web 写职责说明`。
- 模式关闭：placeholder = `结构分析未开启 · 点右面板「开始分析」后可指挥 AI 写入`。
- 用户正常发消息，AI 自主决定是否调 `structure_write`。

**面板与对话联动**：写入时会话出现工具卡，面板树对应节点更新，两处同步。

### 4.5 侧车 / 工具状态条

底部细状态条，常驻：`structure_write 已放开/未放开`（随模式）+ 侧车文件路径 `…/structure-analysis/annotations.json`（数据落点透明）+ 最近写入时间。每次成功写入后状态点闪一下。若侧车读取失败，显示提示（§3.6）。

**设计意图**：把"工具状态"和"数据落点"摆到明面上——用户对正在发生什么有完全知情权，这是"可靠观察面"的一部分。

### 4.6 低保真

交互低保真见 `docs/design/structure-analysis-lofi.html`，已按本版实现：模式开关条、门控输入框、工具卡（含**关态拒绝回执**演示）、树的实时回填与按 `changedPaths` 的闪烁、真实清空。验收交互以它为准。

---

## 5. 架构设计总览

### 5.1 三层分工

```
┌──────────────────────────────────────────────────────────────────┐
│ 壳插件（渲染层）renderer/ —— 纯观察 + 交互                         │
│   读树(ctx.fs.readDirTree) · 读侧车(ctx.fs.readFile)              │
│   模式开关 UI · 写配置标志位(ctx.config.set) · 清空(ctx.fs.removePath)│
│   监听回传（有 bus 用 bus，无则 messageEnd 重读 + ↻）              │
├──────────────────────────────────────────────────────────────────┤
│ 内核扩展 —— 能力提供方（双内核各一份）                              │
│   pi-extension  : pi.registerTool(structure_write)               │
│   dsh-extension : ctx.tools.register(structure_write)            │
│   工具 execute：读配置门控 → 合并写侧车 → (有 bus 则)发回传帧       │
├──────────────────────────────────────────────────────────────────┤
│ 文件系统（项目内）—— 单一真相源                                    │
│   <cwd>/.my-harness-desktop/config/structure-analysis.json        │ 配置(含 analysisMode)：壳写、内核读
│   <cwd>/.my-harness-desktop/structure-analysis/annotations.json   │ 侧车(节点说明)：内核写、壳读
└──────────────────────────────────────────────────────────────────┘
```

**核心数据流（一次写入）**：

```
用户在对话里说"给 server 写说明"
   ▼
内核 agent 调用 structure_write(entries=[{path:"src/server", note:"…"}])
   ▼
工具 execute：
   1. 读 <cwd>/.my-harness-desktop/config/structure-analysis.json → analysisMode?
        关 → 返回 {refused, reason:"未开启…请让用户点开始分析"}（不落盘）
        开 → 继续
   2. 读现有侧车 annotations.json（无则视为空）
   3. notes-merge：对每个 entry 做 path 键 upsert
   4. 写回 annotations.json
   5. （有 bus 能力的内核）发回传帧
   6. 返回 {written, paths}
   ▼
壳收到回传信号 → 重读侧车 → 重渲染（新增/变更节点闪烁）
```

### 5.2 为什么生成逻辑放内核侧（工具），而非壳侧（llm.oneshot）

本版第一原则，展开讲透：

**(a) 上下文在谁手里。** 生成准确的目录职责说明，常需结合当前对话上下文与项目知识——这些**天然在内核 agent 手里**。壳调 `llm:oneshot` 是无（或需重塞）上下文的孤立请求，信息残缺。

**(b) 谁是决策者。** 写什么、写到哪、怎么措辞、要不要顺带给架构判断——是**推理决策**，属于 agent。壳自己做就要把决策逻辑用 prompt 工程硬编码在 UI 层，笨重且脆弱。

**(c) 多内核一致性。** "工具"是每个内核的原生概念（pi `registerTool`、dsh `ctx.tools.register`）。做成内核工具天然适配双内核，走"能力归内核"的正道（注：这里是给两个内核各提供同一能力，属"内核插件"，不是三分法里的"补面"——补面专指给缺面内核补实现，见 §7.6）；做成壳侧 oneshot 则是在壳里再造跨内核生成通路，违背"能力归内核"。

**(d) 会话回路完整性。** 工具写入后 agent 能**接着在对话里回应**（"已写入，还要深入哪个目录？"），形成自然多轮。壳侧 oneshot 生成完就断了。

一句话：**能用内核工具表达的生成，就不用壳侧 oneshot。**

### 5.3 模式开关机制——概览

模式开关要解决：**壳（渲染进程）如何控制内核（子进程）里一个工具的可用性。** 两者隔进程，靠**文件**传状态。机制沿用 `llm-recorder` 成熟范式（§8 详述）：壳把开关写进**项目级配置**，内核工具每次 `execute` 读它放行或拒绝。好处：**跨内核通用**（不依赖 pi 专属 toolgate）、**动态生效**（每次调用读最新值）、**有先例**。

### 5.4 双内核对称

写入工具双内核各一份，语义一致，仅注册 API 与回传通道不同：

| | pi 内核 | dsh 内核 |
|---|---|---|
| 扩展形态 | TS 扩展 `pi-extension/index.ts` | Cordis 插件 `dsh-extension/index.mjs` + `extension.json` |
| manifest 字段 | `"piExtension": "./pi-extension"` | `"dshExtension": "./dsh-extension"` |
| 工具注册 | `pi.registerTool({name,label,description,parameters,execute})` | `ctx.tools.register({name,label,description,parameters,output,execute})` + `export const inject=["tools"]` |
| 读配置/写侧车 | `node:fs` + `process.cwd()` | 同（一致） |
| 回传通知 | **有 bus**：`emitFrame($bus)` → 壳 `ctx.bus.onMessage` | **无 bus**：壳靠 `sessions.onEvent` 的 messageEnd 重读 + ↻（§5.5） |

**对称部分**（门控、侧车读写、合并逻辑）来自**单一真相源**（§13.2）；**不对称部分**（注册 API、回传通道）各自适配。措辞按**能力**而非**内核身份**：是"有 bus 能力 / 无 bus 能力"，不是"是 pi / 是 dsh"。

### 5.5 结果回传：侧车文件是唯一真相源

**侧车文件是唯一真相源，回传只是"触发壳重读"的信号。** 这是全文最稳的支点——把正确性与实时性解耦，↻ 永远兜底。

- **有 bus 能力的内核（pi）**：工具写完侧车后发回传帧，壳 `ctx.bus.onMessage` 收到 → 重读侧车 → 刷新。事件驱动、实时。
- **无 bus 能力的内核（dsh）**：当前壳插件**没有文件 watch 能力**（已核实：渲染进程无 `chokidar`，`FsApi`/`PluginContext` 无通用 watch 原语；`skills.watch` 只监听技能目录、且其 chokidar 规则忽略 `.my-harness-desktop` 这类点目录，不可挪用）。因此首版回传 = **`sessions.onEvent` 在 messageEnd 时重读侧车 + ↻ 手动刷新**——两者都用现有能力，无轮询、无 sleep。
- **文件 watch 作为演进**：若将来给壳新增通用文件 watch 能力（新机制，非既有），dsh 可升级为实时。单列为**前置依赖**（§16/§17），不在首版假设它存在。

**降级是显式的**：dsh 下状态条可提示"改动在消息结束后 / 手动刷新时同步"。正确性不受影响。

### 5.6 面板纯观察的数据流

面板**不写任何语义数据**，只读两类：
1. **目录树**：`ctx.fs.readDirTree(cwd, {maxDepth, ignore})` → `FileTreeNode`。
2. **节点说明**：`ctx.fs.readFile(<cwd>/.my-harness-desktop/structure-analysis/annotations.json)` → 渲染。

面板写的只有：**配置标志位**（`config.set`）和**清空时的 `removePath`**——前者是它自己的设置，后者是删侧车（删除≠写内容，`FsApi` 支持）。语义数据的**写权完全归内核工具**。

---

## 6. 工具契约：structure_write

### 6.1 职责与边界

`structure_write` 是**唯一**能写侧车的工具。职责单一：把一批"路径 → 说明"落盘。它**不做**：读目录树、生成说明文本（文本由 AI 调用时备好）、读代码。

**为什么批量**：AI 常被要求一次写多个目录（"给 server、web、packages 都写"），批量参数一次搞定，减少往返；写一条就是 `entries` 长度 1。

### 6.2 输入 schema

```jsonc
{
  "name": "structure_write",
  "description": "把目录职责说明写进项目结构树侧车；用户在右面板『结构分析』观察这棵树。仅当结构分析已开启、且用户明确要求你写时才调用；只写用户点名的节点，每条一句话说明职责。若被拒绝（未开启），把拒绝原因转达用户。",
  "parameters": {
    "type": "object", "required": ["entries"],
    "properties": {
      "entries": {
        "type": "array", "description": "要写入/更新的节点说明。",
        "items": {
          "type": "object", "required": ["path", "note"],
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

**描述措辞是"注意力控制"的一部分**（§8.4）：只在开启且被要求时调用、只写点名节点、每条一句话、被拒要转达。这在软层面约束 AI 不乱写。

### 6.3 输出 / 回执

```jsonc
{ "written": 2, "paths": ["src/server","packages"], "sidecar": "…/annotations.json" }
// 或被拒绝：
{ "written": 0, "refused": true, "reason": "结构分析未开启（analysisMode=false）。请让用户在右面板点『开始分析』。" }
```

### 6.4 模式门控（execute 时校验）

`execute` 第一步读配置门控（§8）。这是**硬门控**——即便 AI 在关闭时调用也被拒并得到清晰理由。软约束（描述）+ 硬门控（配置校验）双保险。

### 6.5 幂等与覆盖语义

- 同一 `path` 重复写 = **覆盖**旧说明（最新意图优先）→ "改一下那句"自然成立。
- 不同 `path` = 各自 upsert。侧车以 `path` 为键，覆盖是键级，不影响其他节点。

### 6.6 错误处理

- 配置读不到（首次/被删）→ 视为 `analysisMode=false`（保守收起），拒绝并提示。
- 侧车读写失败（权限/磁盘）→ 返回 `{refused,reason}`，不抛崩。
- `entries` 空/非法 → 参数错误，不落盘。

---

## 7. 侧车文件格式

### 7.1 路径与命名

```
<cwd>/.my-harness-desktop/
  config/structure-analysis.json              ← 配置（含 analysisMode）：框架按 pluginId 推导，壳写、内核读
  structure-analysis/
    annotations.json                          ← 节点说明侧车：内核写、壳读
```

- 配置路径由框架按 `pluginId` 推导（CLAUDE.md §9.1），`llm-recorder` 同款。
- 侧车放独立子目录 `structure-analysis/`，为扩展留空间（如 `review-notes.json`），不与配置混。
- 两者都**跟项目走**（`<cwd>` 下），切项目天然隔离。
- 两个文件名**有意区分**：`config/structure-analysis.json`（配置）≠ `structure-analysis/annotations.json`（侧车）。全文统一此命名。

### 7.2 annotations.json 结构

```jsonc
{
  "version": 1,
  "updatedAt": "2025-08-30T12:00:00.000Z",
  "notes": {
    "src":               "源码入口，含 plugins/server/web 三大部分",
    "src/server":        "后端：应用编排 / 内核 / client",
    "src/server/client": "流出适配器（内核层在此）",
    "packages":          "发布面包：react / shared / pi 扩展"
  }
}
```

- `notes` 是 `path → note` 扁平映射，键为相对项目根目录路径。
- 用扁平映射而非树：写入是键级 upsert，简单、无树结构维护成本；渲染时壳按当前树把 `notes[path]` 挂到对应节点。
- `version` 留演进；`updatedAt` 供 UI 显示"最近更新"。
- **孤儿 note**：目录重命名/删除后，旧键残留、不再渲染、惰性存在。本版不自动迁移（§17.2）。

### 7.3 读 / 写 / 清空职责

- **写方**：仅内核工具 `structure_write`。壳**不写侧车内容**（`FsApi` 无带内容写，物理写不了——见 §8.2）。
- **读方**：壳（`readFile`）+ 内核工具自己（写前读旧值合并）。
- **清空**：壳调 `ctx.fs.removePath(<cwd>/.my-harness-desktop/structure-analysis/annotations.json)`（`FsApi.removePath` 现成能力，删除无需写内容），容错"文件不存在"。下次写入自动重建。**无需 `structure_clear` 工具**（v2.0 的误判，R4）。

### 7.4 并发与一致性

- 单会话写入串行（agent 一次一个工具调用），无并发。
- 多会话同写同一项目理论可能，但结构分析低频、单人，本版不做锁，接受"后写覆盖"。需要时侧车写入可加文件锁（`config-file.ts` 有 `withDirLock` 原语）。

---

## 8. 模式开关机制详解

壳渲染进程如何可靠控制内核子进程里一个工具的可用性。

### 8.1 模式状态的存储与粒度

模式状态 = 壳插件的一个**项目级配置项**：`config.set("analysisMode", true|false, { scope:"project" })`，落 `<cwd>/.my-harness-desktop/config/structure-analysis.json`。

**粒度决策（R3，盲审定案）：项目级。** 明确语义：
- **跨会话、跨重启保持**，直到用户点"结束"。这不是"会话内一次性"，而是"这个项目的分析开关"。
- **首次未配置时为关闭**（不是"常态关闭"——一旦开启就持续开启，直到结束）。§3.1 已按此表述。
- 面板启动 `config.get("analysisMode")` 读出，决定模式条初始态；切换 `config.set` 后立即生效（下次工具调用读到新值）。

**为什么项目级而非会话级**：机制最简（`config.set` 原生）；契合"分析这个项目"的心智；所有会话一致受门控、无跨会话不对称（§8.4）。写入总由用户主动要求触发，故"开着但没写"不会造成意外写入。会话级作为备选记录在 §17.4。

**显式契约：项目根如何被内核扩展定位。** 壳写配置走 `config.set`（框架按 `<cwd>` + pluginId 推导路径）；内核扩展侧则按**自身工作目录 `process.cwd()`**（= 项目根）拼出同一 `<cwd>/.my-harness-desktop/...` 路径——与 `llm-recorder` 同款。这是一条**跨进程的位置约定**：壳的 `<cwd>` 与内核扩展的 `process.cwd()` 必须指向同一项目根（由壳在拉起内核时保证）。此约定在此显式声明，不藏在代码里；若某日内核工作目录与项目根脱钩，该机制需改为显式传根（列入 §17 风险意识）。

### 8.2 关键约束：壳写不了任意文件 → 状态必须走配置

必须点破的约束（它决定机制形状）：壳的 `FsApi`（`packages/shared/src/domain/sessions.ts`）**没有"往项目内任意路径写内容"的写文件**——只有 `createFile`（建空）、`readFile`、`removePath`、`renamePath` 等。壳有的其它内容写通道都不适用：`configFile.set` 只写**本插件自己的**配置文件、`dialog.saveTextFile` 需用户保存对话框——都写不了"项目内一个给内核读的侧车"。因此**侧车内容只能由内核工具写**（内核有 `node:fs`）。

因此：**壳只能写配置**（`config.set`，框架代写），**侧车内容只能由内核工具写**（内核有 `node:fs`）。这条约束把职责切干净：壳写配置（它能写的）、内核写侧车（它能写的）、两者在 `<cwd>/.my-harness-desktop/` 下经文件系统汇合。（删除侧车用 `removePath`，是删除不是写内容，壳可做——§7.3。）

### 8.3 为什么不用 toolgate / enabledToolIds 做门控

项目已有工具白名单机制（`toolgate`，`packages/my-harness-fit-pi-extension/toolgate.ts`，读会话头 `toolConfig.enabledToolIds` 硬过滤）。本版**不用**：

1. **它是 pi 专属**（`dsh-catalog.ts` 明确"dsh 无 tool-gate"）。用它，dsh 拉不平。
2. **白名单语义不合**：`enabledToolIds` 是白名单（显式空=全禁）。"只放开 structure_write"得列出全部启用工具再增删——侵入 tool-manager 职责域，易与用户选择打架。
3. **配置标志位更简单通用**：一个布尔位，双内核一致。

**结论**：门控走配置标志位。toolgate 留作**可选 pi 侧增强**（关闭时把工具从清单藏掉），但须在白名单语义外谨慎处理——本版默认不做，列演进。

### 8.4 注意力控制：AI 怎么知道该不该用（两层，不含"会话提示"）

`structure_write` 一直注册（不做动态注册/注销）。防 AI 在关闭时乱用，靠**两层**：

1. **工具描述**（软约束）：写清"仅当开启且用户要求时调用、只写点名节点"（§6.2）。
2. **配置硬门控**（兜底）：即便调了，`execute` 读配置发现关闭 → 拒绝 + 清晰理由；工具描述要求 AI **把拒绝转达用户**（§6.2）。

**v2.0 的"第三层：开关切换往会话发系统提示让 AI 知道"已删除（R2）**。原因：该机制不存在——`MessagingApi` 只有 `prompt/abort/continue`，`prompt` 会触发生成，没有"不触发生成地注入系统消息"的 API；`systemPrompts` 是 pi-only 且仅 spawn 时注入（§8.5）。因此：**模式状态不进会话上下文**，只在面板展示；AI 的状态感知完全靠上面两层（描述 + 拒绝回执自学习）。这是**拒绝写入 → 回执 → AI 转达**的闭环，不需要任何注入机制。

**这也消解了"多会话静默放开"的担忧**：模式是项目级单一标志，所有会话的工具读同一标志、一致受门控；没有"某会话收到提示、另一会话没收到"的不对称。写入又总由用户要求触发，故无"背着用户写"的风险（§3.6）。

### 8.5 与 systemPrompts 槽位的关系（为什么不用）

`systemPrompts` 槽往会话注入系统提示。不用它，因为：
- **它是 pi-only**：`packages/shared/src/domain/backend.ts` 明确"内联/文件 system prompt → pi 翻译成 --append-system-prompt；**dsh 忽略**"。用它，dsh 缺面。
- **注入时机是 spawn**：系统提示在会话 spawn 时注入，**中途切开关无法即时生效**。而模式开关的核心诉求恰是"随时切、即时生效"。

所以注意力控制走 §8.4 两层，不依赖 systemPrompts。这再次印证：**跨内核 + 动态生效的能力，不能押在 pi-only / spawn 时注入的机制上。**

### 8.6 开关切换的完整副作用清单

点「开始分析」（关→开）：
1. `config.set("analysisMode", true)`（落盘）。
2. 面板重渲染：模式条变绿、按钮变「结束」、状态条变"已放开"、输入框 placeholder 变指挥文案。
3. **（无会话注入动作）**——不往任何会话发消息（§8.4）。无会话时也照常置位。

点「结束」（开→关）：对称反向（`analysisMode=false`、模式条回灰、状态条"未放开"）。

**切换不动侧车**：已有说明不受开关影响（产物持久）。

---

## 9. 树观察面实现

### 9.1 树读取与"逐层展开"（手动下钻懒加载）

- `FileTreeNode`（`packages/shared/src/domain/sessions.ts`）语义：目录 `children: undefined` = 未下钻，消费方可懒加载；`children: []` = 空目录。
- **深度切换 1/2/3**：`readDirTree(root, { maxDepth: 1|2|3, ignore })` 一次拿 N 层，纯参数差异，无懒加载。
- **逐层展开**（旧称"全展开"，R：改名以免误导成"一眼看全树"）：初次 `readDirTree(root, { maxDepth: 1 })` 只拿根层；展开某目录时对该目录 `readDirTree(dirPath, { maxDepth: 1 })` 下钻一层。只读展开部分，巨型项目也不卡。因是**手动逐层下钻**而非"自动铺满整树"，正名为"逐层展开"，按钮加 tooltip 说明。
- `ignore` 清单默认 `["node_modules", ".git", "dist", "out", "build", "__pycache__"]`，可在 ⚙ 弹层增删，持久化到项目级配置。

**深度态与逐层态渲染统一**：渲染器只认"当前已拿到的 `FileTreeNode` 树"，深度切换只是改"一次读多深"，逐层只是"分多次读"。渲染逻辑对两者无感，避免两套代码。

### 9.2 过滤（两种，正交）

本版保留两种过滤（v1 的"勾选聚焦"随 checkbox 取消）：

1. **搜索聚焦**：工具栏关键字。保留命中节点 + 祖先链，其余折叠为 `▸`。**纯前端**，对**已加载层**切片，不重读磁盘、**不触发自动下钻**（未加载的子树不在搜索范围，避免"搜索引发大量 IO"）。命中词高亮。
2. **排除目录**：`ignore` 清单，读树前由**内核**跳过（`readDirTree` 的 `ignore` 参数），不回读子树。这是"读之前就不读"，与搜索的"读了再藏"正交。

> 两种过滤一前一后：`ignore` 作用于**读树时**（省 IO），搜索作用于**渲染时**（省交互）。改 `ignore` 需重读树，改搜索词不需。

### 9.3 逐节点说明的渲染

- 渲染时对每个目录节点查 `notes[path]`，有则在节点行下方渲染一行灰字说明 + 行尾 📝。
- **长说明**：单行 + 省略号，完整文本在 📝 悬停/展开查看（§3.6）。
- **新写入高亮**：仅**本次新增/变更**的 `path` 才闪烁。实现上，回传信号带 `changedPaths`（有 bus 时由回传帧携带；无 bus 时由壳对比前后 `notes` 求 diff）。**不是无条件全闪**（修正原型旧行为）。
- 说明是**目录级**（每目录一句），不给文件级写。

### 9.4 性能

- **读树**：深度态单次递归，几千节点无压力；逐层按需下钻，天然分摊。
- **渲染**：树扁平化一次渲染。结构分析场景目录数可控（用户靠深度/过滤收敛视野），本版不做虚拟化，列演进。
- **侧车读取**：小 JSON（几十~几百条），可忽略；回传触发重读是低频事件。

---

## 10. 槽位与挂载

### 10.1 主落点：sidePanel

| 字段 | 值 | 说明 |
|---|---|---|
| `id` | `structure` | 槽位贡献 id |
| `label` | `结构分析` | Tab 文案（i18n key） |
| `icon` | `folder-tree` | 图标 token |
| `component` | `StructureAnalysisTab` | 与 `renderer/index.tsx` export 同名 |
| `order` | `20` | 「Review」10 与「文件」30 之间 |

挂 `sidePanel`。`isActive` 由框架传入，控制不可见时不做无谓重读。**Tab 视觉顺序以 `order` 排序为准**（Review 10 < 结构分析 20 < 文件 30）；低保真中 tab 横向顺序仅为示意，实际按 order。

### 10.2 副落点：composerAttachments（降级为可选）

v1 的核心结合通道，本版**降级为可选、默认不做**——本版的结合是"对话指挥 + 工具写回"，已天然嵌在会话里，无需附件投喂。保留的唯一潜在用途：把"当前结构 + 已写说明"作为背景带进全新话题。列演进（§17），不阻塞首版。

### 10.3 不落的槽位

- **`systemPrompts`**：不用（§8.5，pi-only + spawn 时机）。
- **`mainView`** / **`sidebar`**：不落（分别是 timeline 本体、导航）。
- **`settingsGroups`**：可选——若要暴露"默认深度/默认 ignore"走通用设置页。本版有合理缺省，列演进。

### 10.4 revealOn 与回传→事件的桥

可声明 `revealOn: "structure:updated"`：写入发生时，若右面板未展开/未激活本 Tab，自动展开并切到本 Tab，让用户"一写入就看到"。

**触发链必须补全（盲审指出）**：`revealOn` 由 **events 通道**触发，而写入回传在有 bus 的内核里是 **bus 帧**。二者之间需要一步桥：插件收到回传（bus 帧或 messageEnd）后，**`ctx.events.emit("structure:updated", { changedPaths })`**，这才触发 `revealOn`。因此：
- 插件声明 `channels`（`structure:updated`，`replayLast` 按需）。
- 命名统一为 **`structure:updated`**（events channel，冒号）；bus 帧的 `kind` 也用 `structure:updated`，全文一致（修正 v2.0 下划线/冒号两套命名）。
- 是否自动展开留配置余地（写入是用户主动要求的，跳过去看通常正是他要的；若觉打扰可关）。

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
  "permissions": ["fs:project"],
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
| `fs:project` | ✅ | ✅ | 读树 + 读侧车 + `removePath` 清空（配置经框架，不经此权限） |
| `llm:oneshot` | ✅ | ❌ **移除** | 生成下沉内核工具，壳不再发 LLM 请求 |
| `sessions:bus` | ❌ | ❌ **不声明** | 接收回传帧走 `onMessage` 自由广播订阅，不需此权限（见下） |

**为什么不声明 `sessions:bus`（盲审核实，修正 v2.0/v2.1 的误判）**：`sessions:bus` 门控的是 bus 的**发送类 op**（`send`/`sessionCreate`/…，`controllers/bus.ts` 对这些按 `pluginId` 校验 `sessions:bus`）；而 **`onMessage` 是无 pluginId 的自由广播订阅**（`transport.on(IPC.bus.event)`，不走权限校验）。本插件在有 bus 面只是**接收**内核工具发来的回传帧，**不发送**任何 bus 帧（§10.4 的 `structure:updated` 走的是渲染层 `ctx.events` 事件总线，不是 sessions bus）。因此**接收回传不需要 `sessions:bus`**，声明它反而是多余且误导的。无 bus 面（dsh）本就走 messageEnd+↻，与该权限无关。

**权限收窄是"壳退为纯观察"的直接体现**：壳不再需要 `llm:oneshot`（不生成）、也不需要 `sessions:bus`（只收不发），唯一权限是读/删项目文件的 `fs:project`。

### 11.3 piExtension + dshExtension 双字段

一个插件同时携带两个内核扩展，框架分别同步、随插件启停：
- `piExtension` → pi 扩展目录（`pi-extension-installer` 同步）。
- `dshExtension` → `~/.dsh/.my-harness-desktop-plugins/<pluginId>/` + 挂 cordis.yml 块（`dsh-extension-installer`）。

插件作者不手写同步逻辑，框架在激活/停用时自动同步/摘除。

---

## 12. 多内核不对称处理

对照"能力拉平三分法"（适配器翻译 → 内核插件补面 → 显式降级）逐项过。措辞按**能力**而非内核身份。

### 12.1 工具注册：形状不同，语义相同 → 各自适配

- 有 `registerTool` 面（pi）：`pi.registerTool({name,label,description,parameters,execute})`。
- Cordis 面（dsh）：`ctx.tools.register({name,label,description,parameters,output,execute})` + `export const inject=["tools"]`。

语义一致（注册一个工具），形状略异，各自在扩展里适配；共享逻辑来自单一真相源（§13.2）。

### 12.2 回传通道：有 bus vs 无 bus → 无 bus 侧显式降级

- **有 bus 能力**：工具发帧 → 壳 `ctx.bus.onMessage`。实时、事件驱动。
- **无 bus 能力**：壳**无文件 watch 可用**（§5.5 已核实）。首版 = `sessions.onEvent` 的 **messageEnd 重读侧车 + ↻ 手动刷新**，用现有能力，无轮询、无 sleep。**文件 watch 实时化是演进**，依赖新增壳 watch 能力，单列前置（§16/§17.7）。
- **降级显式不静默**：无 bus 侧状态条提示"改动在消息结束后 / 手动刷新时同步"。正确性不受影响（侧车是真相源，↻ 总能读到）。

### 12.3 门控机制：配置标志位，天然对称 → 无需拉平

读配置是纯 `node:fs`，两个内核扩展都能做，天然对称。这是选配置标志位而非 toolgate 的红利——toolgate 是有 bus 侧专属面，会把本可对称的能力变成不对称。

### 12.4 能力差异小结

| 能力 | 有 bus 面 | 无 bus 面 | 处理 |
|---|---|---|---|
| 注册 `structure_write` | ✅ | ✅ | 各自适配（形状差异） |
| 读配置门控 | ✅ | ✅ | 对称 |
| 写侧车 | ✅ | ✅ | 对称 |
| 实时回传 | ✅（bus） | ❌（无 watch） | 无 bus 侧降级 messageEnd+↻，显式提示 |

**结论**：核心能力（注册/门控/写侧车）双内核完全拉平；唯一不对称是回传实时性，显式降级，不静默、不伪造。bus 的**接收**（`onMessage`）是自由订阅、不涉及 `sessions:bus` 权限，故不产生权限面的不对称（§11.2）。

---

## 13. 分层纪律对照

对照 CLAUDE.md §1（依赖只向内、机制内容分离、契约单源、无特权、多内核默认）逐条自检。

### 13.1 目录结构与归属

```
src/plugins/project/structure-analysis/
  plugin.json
  channels.ts                # 声明 structure:updated（events channel）
  renderer/
    index.tsx                # StructureAnalysisTab（右面板 Tab，usePluginContext）
    mode-bar.tsx             # 模式开关条（开始/结束）
    toolbar.tsx              # 搜索 + 深度 + ⚙排除 + 刷新
    structure-tree.tsx       # 树 + 逐节点说明渲染（懒加载下钻）
    ignore-sheet.tsx         # 排除目录弹层
    status-strip.tsx         # 侧车/工具状态条
  core/                      # 纯类型 + 纯函数，零依赖，可单测（单一真相源，§13.2）
    types.ts                 # Annotation / AnnotationFile / ModeState 类型 + 侧车 schema
    notes-merge.ts           # 纯函数：旧 notes + entries → 新 notes（upsert）
    tree-attach.ts           # 纯函数：FileTreeNode + notes → 带说明的渲染树
  client/
    tree-reader.ts           # readDirTree 封装：深度/懒加载/ignore 透传
    sidecar-reader.ts        # 读 annotations.json（ctx.fs.readFile + 容错）
    mode-flag.ts             # analysisMode 读写（ctx.config）
    update-listener.ts       # 回传监听：有 bus 用 bus，无则 messageEnd 重读；收信号后 emit structure:updated
  pi-extension/
    index.ts                 # pi.registerTool(structure_write)；门控/合并/侧车逻辑由构建注入（§13.2）
  dsh-extension/
    index.mjs                # ctx.tools.register(structure_write)；同上
    extension.json           # { displayName, description }
  locales/{zh-CN,zh-TW,en,de}/*.json
```

### 13.2 契约单源：共享逻辑单一真相源 + 构建注入（R5，盲审定案）

v2.0 计划把 `notes-merge`、侧车 schema、配置文件名在"壳 core + pi 扩展 + dsh 扩展"各写一份，违反 §1.3（绝对禁止复制定义）。本版定案：

- **单一真相源**：`notes-merge` 纯逻辑、侧车 JSON schema、配置键名，**只定义在插件 `core/`**（`types.ts` / `notes-merge.ts`），配单测。这是唯一权威定义。
- **构建注入而非内联**：内核扩展不复制这份逻辑，而是由**构建步骤从 `core/` 单一源生成/注入**到 `pi-extension`（TS）与 `dsh-extension`（mjs）。因为 pi 是 TS、dsh 是 .mjs，语言不同，注入产物形态不同，但**逻辑源只有一份**——构建器读 `core/` 产出两份等价实现，任何改动先改 `core/` 再重新生成，杜绝双份手写漂移。
- **为何不能靠"内联 + 对齐"**：内联等于承认两份可漂移的定义，正是 §1.3 要消灭的。构建注入把"一份定义、多份产物"落到机制上。
- 具体构建工具/脚本（如何在插件构建时把 `core/` 编译/转译注入两个扩展目录）是实现细节，**开发前定案**（§17.1）。

### 13.3 机制与内容分离

- 壳不提供任何"结构分析"机制——加载器、槽位、配置通道、bus、`readDirTree`/`readFile`/`removePath` 全是既有机制。本插件是**内容**，挂在既有机制上。
- **注意**：v2.0 曾说"文件监听是既有机制"，**不成立**（壳无通用文件 watch，§5.5）。本版更正：首版回传不依赖文件监听；若将来要实时化，文件 watch 是**需新增的机制**，不是既有的。
- **两类文本，分别处置（消除"零硬编码"的歧义）**：
  - **用户可见文案**（模式条、状态条、提示、按钮）→ i18n key；**颜色**→主题 token。这类零硬编码。
  - **工具描述**（`structure_write` 的 `description`/`label`）是 **LLM 面向的工具契约**，不是用户可见文案——它定义工具的语义与使用约束，随工具走、不进 i18n（内核工具描述通常不本地化）。它"写死"是契约的一部分，不违反机制/内容分离；但它的**措辞**须与 §6.2 单一源对齐，不在多处各写一版。

### 13.4 依赖只向内 + 零硬编码

- `core/` 零依赖、纯函数、可单测；`client/` 只做 IO 适配、不写 UI、不 import `src/server`/`src/web` 内部；`renderer/` 只用 `usePluginContext()` + 纯展示；内核扩展只 import 内核 API + `node:` 内建。
- pluginId 框架注入、component 名框架匹配、侧车/配置路径框架按 pluginId 推导。内核扩展解析自身配置文件名的方式见 §17.2。

---

## 14. 状态机与时序

### 14.1 模式开关状态机

```
        ┌─────────────┐
        │   关闭       │  analysisMode=false（首次未配置的初始态）；工具收起
        └──────┬──────┘
   点「开始」   │  config.set(true)；面板重渲染；（无会话注入）
               ▼
        ┌─────────────┐
        │    开启      │  analysisMode=true；工具放开；跨会话/重启保持
        └──────┬──────┘
   点「结束」   │  config.set(false)；面板重渲染
               ▼
           （回到关闭）
```

两态、显式切换、切换即落盘、无中间态。busy 时切换临时禁用（置灰），避免竞态。

### 14.2 一次成功写入的时序（有 bus 面）

```
用户: "给 src/server 写说明"
  └→ agent 生成 toolCall: structure_write({entries:[{path:"src/server",note:"…"}]})
       └→ 扩展 execute:
            1. 读配置 → analysisMode=true → 放行
            2. 读侧车旧 notes（无则空）
            3. notes-merge → 新 notes
            4. 写回 annotations.json
            5. 发回传帧 { $bus:true, to:"plugin:structure-analysis", kind:"structure:updated",
               payload:{ changedPaths:["src/server"] } }（id/timestamp 由框架补全）
            6. return {written:1, paths:["src/server"]}
       └→ agent 收到回执，回复"已写入，还要深入哪个目录？"
  └→ 壳 ctx.bus.onMessage 收到 → emit("structure:updated") → 重读侧车 → tree-attach → 重渲染（该节点闪烁）+（若配置）触发 revealOn
```

### 14.3 一次成功写入的时序（无 bus 面）

与 14.2 相同，唯二差异：注册用 `ctx.tools.register`；**无第 5 步发帧**。壳在 `sessions.onEvent` 收到该回合 **messageEnd** 时重读侧车 → 重渲染；或用户点 ↻ 手动刷新。实时性低于有 bus 面，但事件驱动、无轮询。

### 14.4 模式关闭时被调用的时序（硬门控生效）

```
用户（未点开始）: "给 src/server 写说明"
  └→ agent 调 structure_write
       └→ execute 第 1 步读配置 → analysisMode=false
            └→ return {refused:true, reason:"结构分析未开启…请让用户点开始分析"}
       └→ agent 收到拒绝，回复用户"需要先在右面板点开始分析"
  （侧车未被写入；无回传帧；面板无变化）
```

**低保真须演示这条拒绝路径**（工具卡 + refused 回执），而非"AI 干脆不调"的软约束，与 §6.4/§14.4 对齐。

---

## 15. 边界与非目标（索引）

非目标见 §2.4（不重复）。此处补**边界承诺**：

- 只看目录结构粒度；不读代码文件内容。
- 壳不写语义数据（写权归内核工具）；壳只写配置标志位、只删侧车（清空）。
- 门控硬兜底：关闭态调用必被拒，侧车不被写。
- 侧车按 `<cwd>` 隔离，切项目不串。
- 回传降级显式：无实时通道时明确提示，不静默、不伪造成功。
- 本版不做：虚拟化渲染、`composerAttachments`、`settingsGroups` 设置项、孤儿 note 自动迁移、文件 watch 实时化（均列演进/前置）。

---

## 16. 落地计划（每个 commit 完整、无半成品、无 pi-only 中间态）

> 纪律：不允许"先占位半成品"，不允许 pi-only 中间态（多内核默认）。前置定案前移到写码之前。

**Step 0 · 前置定案（写码前）**：把挡在写入路径前的两个实现决策定案并落进本文档——§17.1（共享逻辑单一真相源 + 构建注入的具体机制）、§17.2（内核扩展如何解析自身配置文件名）。未定案不动工写入路径。

**Step 1 · 观察面板完整态**：`plugin.json` + `locales` + `renderer/`（mode-bar 展示 + toolbar + structure-tree + status-strip + ignore-sheet）+ `channels.ts` + `core/types.ts` + `client/{tree-reader,sidecar-reader,mode-flag}.ts`。
交付：**完整可用的结构观察面板**——浏览树（深度/过滤/排除/逐层下钻）、读已有侧车渲染说明、模式条展示配置态、清空（`removePath`）。它是**观察功能的完整交付**（一个带深度/过滤/排除/清空的结构浏览器，独立有价值），不是"写入功能的半成品"；此时写入工具未安装，面板不假装能写。

**Step 2 · 双内核写入能力完整态**：`core/notes-merge.ts`（单一真相源）+ `pi-extension/` + `dsh-extension/`（`structure_write`，逻辑构建注入）+ 模式门控 + 侧车写入 + 回传（有 bus 用 bus，无则 messageEnd+↻）。**两个内核同步交付，无 pi-only 中间态。** 交付后为完整"可开关写入面板"。

**Step 3 · 联动与健壮性增强（可选，各自完整）**：`update-listener` 的 `emit("structure:updated")` + `revealOn` 自动展开、孤儿 note 计数提示、侧车损坏提示、长说明展开查看。

**Step 4 · 实时化演进（依赖新机制，单独前置）**：给壳新增通用文件 watch 能力后，无 bus 面升级为实时回传。**不在首版承诺。**

---

## 17. 风险与开放问题

按"显式标注、不藏"列出：

1. **构建注入机制的具体形态（R5，Step 0 定案）**：`core/` 单一源如何生成/注入 pi-extension（TS）与 dsh-extension（mjs）两份等价实现。候选：插件构建脚本编译 `core/` 分别产出；或维护一份中立的 `.mjs` 由 pi 侧包装。选哪种影响构建链，须开发前定。**方向已定（单一源 + 注入），具体工具待选。**
2. **内核扩展解析自身配置文件名（Step 0 定案）**：`llm-recorder` 先例是扩展内写死自身配置文件名（`llm-recorder.json`）。本插件沿用则需在注入代码里写死 `structure-analysis.json`。这与"零硬编码 pluginId"有张力——但它是扩展引用**自身**配置的既有先例，倾向接受；或探索安装器把 pluginId 注入扩展。**待确认。**
3. **孤儿 note 清理**：目录重命名/删除后旧键残留（§7.2）。本版惰性残留 + 清空可移除；是否做"渲染时提示 N 条孤儿说明"列演进。
4. **侧车损坏 / 手改的容错语义**：读失败时"按无说明渲染 + 状态条提示"已定（§3.6），具体提示文案与是否提供"重置侧车"动作待细化。
5. **内核切换时的回传衔接**：pi↔dsh 切换（`switchKernel`）瞬间，回传通道从 bus 变 messageEnd。mode flag 是项目级单点不受影响；但切换瞬间若有在途写入，面板刷新时机需实测确认。
6. **与先例的语义差异（自辨，非照搬）**：借鉴两个先例但语义有差——(a) `llm-recorder` 配置默认**开**（`recordEnabled !== false`），本设计默认**收**（`analysisMode` 须显式置 true 才放开）；(b) dsh 的 ask/goal 侧车落**全局** `~/.pi/agent/...`，本设计侧车落**项目内** `<cwd>/.my-harness-desktop/...`（跟项目走）。借鉴机制、不照搬语义。
7. **文件 watch 实时化前置**：无 bus 面要实时，须先给壳新增通用文件 watch 能力（新机制）。列 Step 4 前置，不在首版假设存在。
8. **会话级模式备选（R3）**：本版定项目级。若用户实测后更想要"每个会话各自开关"，可改为把 `analysisMode` 放会话 header（`sessions.updateHeader`）。记录为备选，不阻塞。
9. **toolgate 可选增强**：关闭时把 `structure_write` 从有 bus 面的工具清单藏掉（减少 AI 注意力）。须在白名单语义外谨慎处理，默认不做，列演进。
10. **`composerAttachments` 可选回归**：把"结构 + 说明"作背景带进新话题，列演进。

---

## 18. 验收标准（可测、可判定）

- **观察面**：切深度 1/2/3/逐层，渲染与 `readDirTree` 参数一致；搜索命中 + 祖先链保留、其余折叠；`ignore` 目录不出现在树中且持久。
- **模式开关**：切换后 `config.get("analysisMode")` 返回新值；模式条/状态条/输入框 placeholder 随态变化；busy 时开关置灰不可点。
- **硬门控（可测断言）**：**关闭态连续调用 `structure_write` N 次，侧车文件 `mtime` 不变、内容不变**，且每次返回 `{refused:true}`。
- **写入（有 bus 面）**：开启态写入后，**面板在 1 个事件循环内**（收到回传帧后）出现对应说明 + 闪烁。
- **写入（无 bus 面）**：开启态写入后，**该回合 messageEnd 之后或点 ↻ 后**面板出现说明；若超过约定时限未出现，状态条给出降级提示（可设"3 秒内未刷新则提示手动刷新"）。
- **持久化**：说明跨开关、跨面板重开、跨应用重启保留；切项目后读新侧车、不串旧项目。
- **覆盖**：对同一 `path` 重写，新说明覆盖旧的，其他节点不受影响。
- **清空**：点清空后侧车文件被 `removePath` 删除；下次写入自动重建。
- **纪律**：`core/` 纯函数可单测；壳不写语义数据；权限清单**无 `llm:oneshot`**；双内核能力对称、无 bus 面降级显式。

---

## 19. 附录

### 19.1 与 v1（壳侧生成）差异对照（详表见 §0.1/§0.2，此处一句话）

v1 壳侧 `llm:oneshot` 生成 + 附件投喂（单向）→ v2 内核工具 + 可开关画布 + 对话驱动写回（双向回路）。

### 19.2 关键参考文件（机制落点，已逐一核实）

> 路径以**真实仓库布局**为准：`src/server/{bootstrap,application,controllers,kernel/{pi,dsh}}`、`src/web`、`src/plugins`、`packages/{react,shared,my-harness-fit-pi-extension}`。CLAUDE.md §6.1 给出的 `src/core` + `client/` + `api/` 示意布局与当前代码不一致处，**一律以代码为准**（代码是真相源）。本节引用均已对照真实文件逐一核实。

- **配置开关 + 内核读配置先例**：`src/plugins/insight/llm-recorder/pi-extension/index.ts`（按 `process.cwd()/.my-harness-desktop/config/<pluginId>.json` 每请求读开关，mtime 缓存）。
- **工具注册 + bus（有 bus 面）**：`packages/my-harness-fit-pi-extension/tools/*.ts`、`bus.ts`（`pi.registerTool` + `emitFrame`）。
- **工具注册 + 文件侧车（无 bus 面先例）**：`src/server/kernel/dsh/extension/dsh-extension/index.mjs`（`ctx.tools.register`；该 fit 扩展 `inject:["tools","skills"]`，因它同时注册工具与 ask/goal 技能——**本插件只需 `inject:["tools"]`**；ask/goal 为文件侧车先例）。
- **dsh 扩展同步**：`src/server/kernel/dsh/extension/dsh-extension-installer.ts`。
- **树契约**：`packages/shared/src/domain/sessions.ts`（`FsApi`/`FileTreeNode`/`ReadDirTreeOptions`；**`FsApi` 无带内容写**，有 `removePath`）。
- **toolgate（本版不用，作对比）**：`packages/my-harness-fit-pi-extension/toolgate.ts`；dsh 缺面：`src/server/kernel/dsh/backend/dsh-catalog.ts`。
- **systemPrompts pi-only**：`packages/shared/src/domain/backend.ts`（dsh 忽略）。
- **skills.watch（不可挪用）**：`packages/react/src/index.ts` + `src/server/controllers/skills.ts`（只监听技能目录、忽略点目录）。
- **槽位/权限**：`packages/shared/src/domain/contributions.ts`、`context.ts`。

### 19.3 术语表（正文不重复，见 §0.3 简版）

| 术语 | 含义 |
|---|---|
| 观察面 | 右面板目录树视图，只读，供观察思考 |
| 写入工具 | `structure_write`，内核工具，唯一写侧车者 |
| 模式开关 | 开始/结束，控制工具放开/收起（项目级） |
| 放开/收起 | 工具可用/不可用（门控通过与否），≠ 注册与否 |
| 侧车文件 | `structure-analysis/annotations.json`，节点说明单一真相源，内核写壳读 |
| 配置标志位 | `analysisMode`，壳写内核读的开关位（项目级） |
| 回传 | 写入后通知壳刷新的信号（有 bus=帧，无 bus=messageEnd+↻） |
| 孤儿 note | 目录改名/删除后残留、不再渲染的说明 |

---

> **一句话收尾**：本插件把"结构分析"从"壳侧生成一份报告"翻面成"内核工具 + 可开关画布"——平时是一棵可靠的树供你观察，点开始放开一支笔，你在对话里指挥 AI 往树上写，边看边想边改。核心还是会话，面板是它的外置画布。三轮盲审后，机制收敛到"配置标志位门控 + 侧车单一真相源 + 回传只是触发重读的信号"，所有不可行的假设（chokidar、会话注入提示）都已剔除并给出可行替代。
