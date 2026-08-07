# demo 内容层重设计：板块化演示

## 1. 要解决的问题

现有 demo 的"不好看"不是画质问题——GIF 合成参数（880 宽、fps 10、bayer 抖动）可以再调，但换任何参数都救不了内容。问题在内容层，三条根因：

- **画面是空的**。隔离 HOME 只种了 1 条 ping 笔记、2 个中性技能（demo-alpha/demo-beta）、一个只有 2 个文件的 fixture 项目，没有任何种子会话。侧栏会话列表、会话树、主区 timeline 全是空的，观众打开 GIF 前几秒看到的是空桌面。
- **内容不可控**。对话流全靠真实模型往返（full-tour 剧本里 20 处 waitAgent），模型当时回什么、demo 就长什么样——回复长短、排版、语气全是随机变量。好看是运气，不是设计。
- **素材是敷衍的**。`demo-alpha`/`demo-beta` 技能、`ping` 笔记、两文件项目——素材只够"能演示"，不够"像真的"。观众一眼看出是假的，演示说服力归零。

## 2. 设计总则：一个板块 = 一条 GIF

演示按功能板块组织，每个板块是一条独立 GIF，各自成篇；所有板块按固定顺序拼起来就是 demo-all.gif。观众单看任何一条都自洽，从头看全部是一条完整的叙述：认识桌面 → 干活 → 定制 → 管理。

- 板块之间不共享一个连续故事——每条 GIF 独立录制（各自的一次性隔离 HOME、各自的种子、各自的剧本），拼合只发生在最终产物层（speed-up.mjs 的 concat）。
- 顺序即叙述顺序：工作台巡览 → 会话流渲染 → 主题定制 → 工具调度 → 笔记 → Review 批注 → 图钉 → 收藏 → 请求记录 → 管理页巡礼 → Debug 巡检。
- 录制管线机制（recorder/ripple/locate/interact、record.mjs 流水线、隔离 HOME 框架本身）全部保留，只换内容层。机制与内容的分界在 prefs.mjs 的种子函数和 scenarios/ 目录——这两处是本次改动的全部物理范围。
- 这条边界是硬约束：剧本只能使用 record.mjs 已有的 step 原语（hold/hover/click/point/drag/type/select/press/clickRightAt/waitAgent/toolsOnlyReadOnly）和 locate 的既有定位方式（i18n key/语义锚点/css），不新增滚动原语。需要"滚动到某段"时用 locate 自带的 scrollIntoView 定位实现——定位即滚动，不新增机制。

## 3. 种子素材体系

种子素材是每个板块的画面底料，按 locale 生成（zh/en 各一份，文案人工打磨，不依赖任何真实数据）。

### 3.1 种子会话（核心）

手写一条成品会话 JSONL，种子阶段写入隔离 HOME 的 `~/.pi/agent/sessions/<bucket>/<file>.jsonl`，让主区 timeline 和侧栏会话列表一进来就是满的。

- **文件与路径**：bucket 名按 `cwdToBucketName`（`src/core/domain/sessions.ts`）由 fixture 项目路径生成；文件名沿用生产格式 `<ISO 时间戳>_<uuid>.jsonl`——文件名不是随意取的，它同时决定 4.9 请求记录的落盘对齐（见下）。会话名存 `session_info` 条目；`session-scanner` 扫描到即出现在侧栏列表，零新增契约。
- **头行字段**：`{"type":"session","version":3,"id","timestamp","cwd"}` 五项齐全。`timestamp` 是排序依据——侧栏按会话末条 entry 的 timestamp 降序排，不是文件 mtime。
- **时间戳预算**：主线会话时间戳设为"刚干完"（录制时刻附近）；todo 旧会话"修复重复项 bug"设为几天前；另一项目的会话也设几天前——三条会话排序稳定，不退化。
- **删改契约**：从一条真实会话 JSONL 复制结构、替换内容，不凭空手写。删改时保持三类一致性：消息 `parentId` 链（每条 entry 指向链上前一条）、toolCall 的 `id` 与 toolResult 的 `toolCallId` 配对、消息 `timestamp`（毫秒）单调递增。toolCall 的 `arguments` 在真实数据里是对象不是字符串，别写错。assistant 消息上的 `provider/model/stopReason/responseId` 等字段照抄模板，不删。
- **模型证据**：头行不一定有 `custom-pi-desktop`——那是 desktop 会话管理时补写的，不是生产会话的必有字段。模型信息在 `model_change` 条目和 message 的 `provider/model` 字段上；种子会话照模板自然带上即可，不需要额外补 custom-pi-desktop。

**主线会话内容**：「给 todo 项目加 `--due` 参数」的完整干活过程：用户一句话需求 → 助手 thinking → toolCall（find/grep/read 连击）→ toolResult → 写代码（bash）→ 完成回复。所有 timeline 渲染形态覆盖一遍：thinking 块、toolCall 卡、toolResult、文本气泡、bash 执行卡、divider（`model_change`/`thinking_level_change` 条目映射为 divider）。

**会话列表 3 条**（4.1 工作台巡览的侧栏画面）：

- todo 主线会话（刚干完，上述内容）
- todo 旧会话（"修复重复项 bug"，几天前，短对话）
- 第二项目会话（见 3.2，几天前，短对话）

### 3.2 fixture 项目

两个项目，都是看得懂的小项目。

- **todo 项目**（主项目，主线会话的 cwd，也是 lastCwd）：`main.py`（含 add/list/`--due` 过滤逻辑）、`README.md`、`tests/test_main.py`、`.pi-desktop/config/tool-manager.json`（项目级覆盖一个工具组，让分层配置有东西可演示）。
- **第二项目**（侧栏"项目列表"和"会话列表"的第二条来源）：一个最小目录，如 `notes-site/`，几个文件 + 1 条短会话。它不必像 todo 一样完整，能撑起"工作台里有多个项目"的画面即可。
- 工作台全景里项目列表、会话列表、会话流三处共用同一项目（todo），画面自洽。

### 3.3 笔记 / 技能 / 书签 / 图钉

- 笔记 3 条：「发布前检查」清单、「`--due` 实现要点」、「随手」代码片段——从 1 条 ping 扩成有真实感的随手记。其中一条文案要够长、段落够多，供 4.6 的选区评论定位（见 4.6）。
- 技能 2 条：换成像真的名字（如 `git-release`、`code-review`），描述正常，替代 demo-alpha/beta 的敷衍感。
- 书签/图钉：主线会话里留 1 条已收藏、1 个已落钉——板块剧本演示的是"继续加"，不是"从零开始"。

### 3.4 保留的稳定性决策

- `plugin-manager.json` 继续禁用 goody-hao 与 sub-agent：goody-hao 会注入工程原则 prompt 污染模型回复，sub-agent 启动握手会建 $bus 会话干扰录制——这两条是稳定性需要，不因重设计而改变。
- 工具组种子保留 write（write/edit/bash）与 read-only（read/grep/ls/find）两组，是工具调度板块的演示基础。

## 4. 板块与剧本

每条 GIF 的目标时长 5–15s。点击都有涟漪（ripple），动作后定格让画面"停下来看清"，不赶场。

### 4.1 工作台巡览（6–8s）

观众第一眼：这个桌面是满的、活的。

- 种子：会话列表 3 条、主区主线会话流、笔记 3 条、右侧面板开（prefs 种 `rightPanelOpen: true` + 默认 tab）。
- 剧本：定格 2.5s 全景 → 悬停侧栏会话条目（定位锚 `[data-session-path]`）→ 点击打开主线会话 → 定格 2s。

### 4.2 会话流渲染（12–15s）

一条完整的干活会话，消息全形态一次看全。

- 种子：todo 主线会话。
- 剧本：打开会话 → 定位到「thinking 段」（scrollIntoView，定格）→ 定位到「实现方案」文本段（定格 2.5s）——用两次定位制造"滚动感"，不新增滚动原语。
- 「实现方案」段文案要够长、可选中，同时服务 4.6 的选区评论。

### 4.3 主题定制（10–12s）

把桌面换成自己喜欢的样子。

- 种子：默认 chatgpt-dark。
- 剧本：设置 → 主题 → 切 Mocha Dark → 定格 → 字体/侧栏/右面板/会话流 4 个拖条各拖一下（回位）→ 回对话 → 新主题定格 2s。

### 4.4 工具调度（10–14s）

能写 → 只读拦截 → 恢复。

- 种子：write 组、read-only 组。**本板块有自己的种子会话变体**——不是复用主线会话，而是独立 HOME 里种一条"正在干活、遇到拦截"的短会话：预置一条被拦截的 toolCall 红条（toolResult `isError:true` 形态），作为真实往返失败时的兜底画面。
- 剧本：开工具面板 → 关 write 组 → 发「往 README 加一行用法」→ waitAgent → 拦截红条定格 → 恢复 write → 重发 → 成功定格。
- 这是全片唯一保留真实模型往返的板块——权限拦截必须真跑才有说服力，其余全部种子。waitAgent 走 soft 降级：模型往返失败不致命，画面落到预置的红条变体上，演示仍成立。

### 4.5 笔记（6–8s）

随手记几条，看笔记面板长什么样。

- 种子：3 条笔记。
- 剧本：开笔记 tab → 定格 → 点开一条展开内容 → 定格。
- **不点卡片直发**：笔记点卡会真实调 `sendMessage` 起 pi 进程等模型回复（notes 插件既有行为），等于第二个真实往返点。本版总纲是"只有 4.4 有真实往返"，所以 4.5 只展示面板与内容浏览，不触发发送。

### 4.6 Review 批注（8–10s）

选中一段话，写两条评论发出去。

- 种子：主线会话的「实现方案」段（够长、可选中——4.2 已约定）。
- 剧本：选中段落（select 原语拖选）→ 浮出评论钮 → 输入「先过滤再排序，少一次遍历」→ 发送入篮 → 再选一句 → 第二条 → 发送 → 定格。

### 4.7 图钉（6–8s）

给关键结论标个颜色。

- 种子：主线会话。
- 剧本：图钉模式 → 选蓝 → 点完成回复落钉 → 退出模式 → 定格。

### 4.8 收藏（5–7s）

悬停一击收起来。

- 种子：主线会话（留 1 条已收藏）。
- 剧本：悬停消息（`[data-message-id]`）→ 收藏按钮出现 → 点击 → 收藏页签弹出 → 定格。

### 4.9 请求记录（6–8s）

看一次模型请求的完整明细。

- 种子：主线会话 + 对应的请求记录。记录落盘在 `<cwd>/.pi-desktop/llm-logs/<会话文件名>.jsonl`——**会话文件名决定记录文件名**，所以 3.1 的文件名不是随意取的；记录格式与 rotate 语义以 `docs/design/llm-recorder-design.md` 为准，落地时从真实 llm-logs 复制结构、替换文案（与种子会话同策略）。
- 剧本：开请求记录 tab → 定格 → 点展开放大 → 定格 → Esc 退出 → 定格。

### 4.10 管理页巡礼（10–12s）

模型/技能/工具/插件/扩展/通用一条龙。

- 种子：中性模型配置（脱敏）、2 个技能、工具组、插件清单。
- 剧本：设置 → 模型页 → 技能页（启用/全部过滤）→ 工具页 → 插件页（会话过滤）→ 扩展页（ON/OFF）→ 通用页，每页定格 1–1.5s。

### 4.11 Debug 巡检（5–7s）

收尾——进巡检模式看一眼，右键退出。

- 剧本：回对话 → 右上角 debug 按钮 → 巡检画面定格 → 右键退出 → 定格收尾。

## 5. 板块 → 场景文件映射

record.mjs 按 `--scenario <name>` import `./scenarios/<name>.mjs`，GIF 产物名 = `demo-<name>-<locale>.gif`，speed-up 的 SCENARIO_ORDER、parallel-record 的 SCENARIOS、README 表格、清理清单都引用这个名字。11 个板块的映射如下（大部分复用既有场景名，降低改名成本）：

| 板块 | scenario name | mjs 文件 | 说明 |
|---|---|---|---|
| 工作台巡览 | `workbench` | `scenarios/workbench.mjs` | 新写 |
| 会话流渲染 | `timeline-flow` | `scenarios/timeline-flow.mjs` | 新写 |
| 主题定制 | `theme-settings` | 既有文件 | 复用，微调节奏 |
| 工具调度 | `tool-schedule` | 既有文件 | 复用，改种子 |
| 笔记 | `notes` | `scenarios/notes.mjs` | 新写 |
| Review 批注 | `review-comments` | 既有文件 | 复用，锚种子文案 |
| 图钉 | `pins` | 既有文件 | 复用 |
| 收藏 | `bookmark` | 既有文件 | 复用 |
| 请求记录 | `llm-recorder` | 既有文件 | 复用，改种子 |
| 管理页巡礼 | `manager-tour` | 既有文件 | 复用 |
| Debug 巡检 | `debug-inspect` | 既有文件 | 复用 |

## 6. 合并与节奏

- 合并顺序即板块表顺序（4.1→4.11）。**两处清单同步改**：`speed-up.mjs` 的 SCENARIO_ORDER 和 `parallel-record.mjs` 的 SCENARIOS（全量录制走后者，只改前者会录不出新板块）。
- demo-all 合并版只拼 **zh 一条主线**（11 段）——双语各拼一遍是 22 段，观众在总片里每段功能看两遍，冗长；README 表格里每板块仍保留 zh/en 两条单条 GIF，双语覆盖不丢。
- 单条 5–15s；合并版 3x 加速后目标 90s 以内（现在是 142s，且含大量 waitAgent 等待）。
- 只有 4.4 有真实模型往返，其余板块零 waitAgent——录制时长与稳定性同时改善。

## 7. 落地步骤

- 清理：prefs.mjs 种子函数（旧素材 + 旧会话种子逻辑）、scenarios/ 全部旧剧本、docs/demo/ 旧 GIF 产物、README demo 章节引用。
- 重建顺序：先手写主线种子会话（板块 4.2 的画面是其他板块的地基，最先做）→ 两个 fixture 项目 → 笔记/技能/书签种子 → 按板块表逐个写剧本 → 单板块录制验证 → 全量录制 → speed-up 合并 → README 更新。
- 每完成一个板块就录一条验证，不攒到最后一起录——种子会话文案不理想、剧本定位器失配这类问题，单板块录制时就能发现。

## 8. QA

**Q：种子会话会不会和真实会话混淆，导致用户在演示里看到假数据？**
种子会话只存在于录制的一次性隔离 HOME（/tmp/pi-demo-*/），每次录制完即删。真实 profile 的 ~/.pi/agent/sessions 完全不受影响——隔离是既有机制，种子只是往隔离区里写内容。

**Q：手写会话 JSONL 的格式谁来保证正确？**
格式以 `session-scanner` 与 timeline 的消费契约为准。落地时从一条真实会话 JSONL 复制结构、替换内容，不凭空手写；删改时保持三类一致性（parentId 链、toolCall id ↔ toolResult toolCallId 配对、timestamp 单调），细节见 3.1。

**Q：4.4 的兜底红条会不会污染 4.2 的画面？**
不会。4.4 有自己的独立种子会话变体（各板块独立隔离 HOME 是既有机制），红条只存在于 4.4 的隔离环境里；4.2 用的主线会话是纯成功叙事，两者不共享同一份种子文件。

**Q：4.4 保留真实模型往返，录制环境没有可用模型怎么办？**
waitAgent 已走 soft 降级（record.mjs 既有逻辑）：超时不致命，继续执行。画面落到 4.4 种子会话变体预置的"被拦截红条"上，演示仍成立——只是少了 live 感。

**Q：笔记点卡直发明明是核心功能，为什么 4.5 不演示？**
点卡会真实调 sendMessage 起 pi 进程等模型回复（notes 插件既有行为），等于第二个真实往返点。本版总纲是"只有 4.4 有真实往返"，4.5 先展示面板与内容浏览；点卡直发若要演示，应并入 4.4 的 live 段或作为独立 live 板块，不在纯种子板块里硬塞。

**Q：跨语言（zh/en）的种子文案谁维护？**
种子函数接收 locale 参数，按语言各写一份会话/笔记/技能文案。文案集中在种子函数里（prefs.mjs 内），不散在剧本里——剧本 target 仍走 i18n key/语义锚点（locate 既有契约），语言差异只在种子数据层。

**Q：板块边界在哪？一个板块内能不能有多个功能？**
一个板块只讲一个功能，一条 GIF 里只出现该功能的相关 UI 与交互。拼合版里相邻板块的边界靠板块末尾的定格区分。超过一个核心动作的板块（如 4.10 管理页巡礼）是例外——它本质是"管理页"这一个功能的多个子页，仍是单一功能板块。
