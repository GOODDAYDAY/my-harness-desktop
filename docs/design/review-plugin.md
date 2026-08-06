# review 插件设计：会话内联评论机制

> **术语约定**：
> - **评论**：本文特指人对会话流里模型产出的批注——**选中原文片段、附上意见、随下一条消息发给模型**。与 git-review（审查 git 工作区的代码 diff）、blind-review（多 agent 盲审文件）无关：那两个是既有插件，本文不涉及、不改动。本文中"评论"一词无歧义时均指此。
> - **选区**：用户在 timeline 消息文本上的拖选（`window.getSelection()`）。评论必须锚定在选区上，没有选区就没有评论入口。
> - **浮条**：选中文字后在选区附近浮现的"💬 评论"横排按钮，选区塌缩即隐藏。
> - **评论篮**：输入框上方的待发送评论列表，编号展示，支持就地编辑、删除、清空。
> - **echo / send 双形态**：发送时"时间线显示的消息文本"（echo）与"实际发给 pi 的拼装文本"（send）分离。现状机制：renderer 侧 `sendMessage(cwd, text)` 内部乐观回显 `text`、实际发送 `finalText`（含工具限制前缀），echo/send 的分离已存在；本文方案在此基础上扩展 `sendMessage` 的可选参数 `{ sendSuffix, echoAttachments }`，由 timeline 从附件协议 payload 中取出 review 推送的 `promptFragment` / `items` 传入——echo 不是一行文本，是 user 气泡下方的结构化附件徽章条（§4.3）。
>
> **需求基准**：交互形态已经低保真原型（`docs/design/review-plugin-lofi.html`）五轮迭代定稿——选中片段才能评论（无整体评论）、多条累积一次性发送、评论篮在输入框上方带编号可就地编辑、唤起按钮仅在选区存在时以横排浮条出现在选区旁。本文的机制设计以原型表现出的交互为需求基准，已被原型否掉的形态（右上角动作条唤起、消息级/整体评论、sidePanel 评论栏、按钮悬停显现或固定于消息栏位）不再讨论。

## 1. 解决什么问题

### 1.1 现状：给一段具体回复提意见，要走三条弯路

Timeline 里一条 assistant 回复动辄几百字——正文、思考块、工具输出混在一起。用户想对其中**某一段**提意见——比如只反对"时钟漂移"这一句判断——今天只有三条路，条条有断点：

- **复制原文手动拼**。选中片段，复制，粘贴进输入框，补引号，打字"这里不对，应该……"。断点一是链条太长：选中、复制、点击输入框、粘贴、补引号、写意见，六步打断了"边读边想"的节奏。断点二是**引用与评论的绑定靠人肉**——复制两个片段以上，编号、排版全靠自己，格式稍一走样，模型就分不清哪句是引用、哪句是意见。

- **口头指代**。"你上面说的时钟漂移那段不对。"
  断点在指代本身："上面那段"对模型是高歧义指令——会话流几十条消息、几千 token，模型要先猜你指哪段。猜错了整轮讨论跑偏，还得再花一轮纠正它猜错的部分。长会话里这种指代的命中率随距离指数下降。

- **直接放弃**。只说一句大方向——"不对，重来""再想想"。断点是反馈质量：片段级意见往往信息量最高（哪个论据错了、哪条命令不该敲），恰恰因为组织成本最高，最先被咽回去。反馈粒度停在"大方向"级，而调试类对话里最有信息量的恰恰是片段级意见。

三条弯路断在同一处：**引用和评论的绑定靠人肉维护**。复制靠手、指代靠猜、放弃靠咽。绑定成本降不下来，反馈粒度就永远停在"大方向"级——而调试类对话里最有信息量的，恰恰是片段级意见。

### 1.2 通用抽象：选区锚定的异步反馈，收集与投递分离

把三条弯路翻过来，需求抽象成一句话：**选区锚定的反馈收集，收集与投递分离**。拆开是三个要素：

- **锚定在快照上，不是指针上**。每条评论绑定一个原文快照（quote），而不是行号或消息序号。会话流会持续滚动、新消息不断插入，行号和序号都会漂移，快照不漂移——引文即上下文，哪怕会话又滚了几十屏，评论的指向依然自包含。
- **收集必须零打断**。意见产生的瞬间人在阅读流里，登记成本要接近零：不进设置页、不弹对话框、不写文件，一个动作完成登记，马上接着读。下一条意见随时追加，没有"先提交这批"的仪式。
- **投递合并成一条**。收集的多条意见不各自成消息——连续发 N 条会把会话刷成批注现场，模型还要自己把 N 条消息拼回"它们分别在说哪些片段"。在用户下一次发送时，评论一次性拼装随正文发出，模型在同一条消息里拿到正文与全部批注的对应关系。

这个抽象不止服务"给长回复挑错"：挑几处工具输出一起问（"这两个报错有关系吗"）、引用自己的错误日志追问、评审消息里的代码片段——同一抽象的不同形态。锚定、收集、投递三件事做对一次，形态是参数。

### 1.3 与近邻功能的边界

仓库里名字沾边的已有四家，先把边界划死，避免读着混：

- **blind-review（多 agent 盲审）**：评审对象是会话外的文件，评委是多个 agent，产出是评审报告。本文相反：评审对象是当前会话里模型的产出，评委是人，产出是给模型的反馈。
- **git-review**：对象是 git 工作区的代码 diff，不是会话流。
- **session-bookmarks（消息书签）**：只存锚点给自己回头找，不产出反馈内容。书签是"标记给自己看"，评论是"批注给模型看"。
- **rewind（改写重发）**：改的是"我当时说了什么"并重打一轮；评论批注的是"你刚才说了什么"，不 rewind。

边界一句话：**review 管"人给模型看的批注"**——不评会话外的产物，不替人做评审。功能范围以低保真原型（`docs/design/review-plugin-lofi.html`，多轮迭代定稿）为需求基准：原型没呈现的诉求——评论的长期留存、跨会话检索、对工具卡片整体的评论按钮——不在本文范围。

## 2. 交互流程

本章按低保真原型（`docs/design/review-plugin-lofi.html`）逐环节固定交互行为：什么时候出现什么、点一下发生什么、状态往哪去。机制实现在 §4，本章只规定"系统和用户之间怎么相处"。

### 2.1 唤起：选区浮条

- **出现条件唯一化：有有效选区**。用户在 timeline 任意消息文本（含工具卡片输出区）拖出非空选区，浮条立即出现在选区附近；选区塌缩（点空白、Esc、剪切）、选区落在消息区域之外（如输入框、设置页），浮条消失。鼠标悬停在消息上**不出现**任何按钮——没有选区就没有评论入口，这是"选中啥评论啥"的直接表达，也让阅读态的时间线保持干净。
- **浮条出现在选区右上角**。按钮是一个横排胶囊（"💬 评论"），整体浮于选区包围盒上方 8px、右缘与选区右缘对齐；选区贴近视口顶部时钳位在视口顶 8px（不翻转——贴顶时浮条钉在原位上方，仍然可见可点，省去一套翻转分支）。timeline 滚动时浮条跟随选区重新定位——它锚定的是**选区**，不是消息框的某个固定栏位。这条规则来自原型迭代：固定栏位（右上角动作条、消息左缘 gutter、选区中点下方）都被否掉，因为评论的指向是选中文本本身，浮条必须贴着"用户正在看的那段话"。
- **浮条点击不丢选区**。浮条 `mousedown` 必须 `preventDefault()`——否则按下瞬间焦点转移、选区塌缩，`window.getSelection()` 在 click 时已空。这是整条唤起链路唯一反直觉的实现点，原型验证过两次（不拦截时点击必选区塌缩、拿不到 quote）。
- **选区失效兜底**。点击时若选区已塌缩（如用户截了屏、按了 Ctrl+C 后脚本清空了选区但浮条因时序未及时隐藏），浮条点击静默不响应——选区塌缩时 `selectionchange` 已先行隐藏浮条，能点到失效浮条是极窄时序窗，静默即可，不值得为它造一条提示通道。

### 2.2 写评论：就地内联框

- **评论框内联插在被评论消息的正下方**，与时间线同流；唤起时 timeline 自动滚动到锚定消息（框永远可见）。形态沿用 rewind 内联框（`data-rewind-inline`）的先例：上一行是引用区（灰字斜体，显示完整引文快照），下一行输入区。**键位语义（2026-08-06 两段式修订，用户定夺）**：**Enter = 确认入篮**，焦点经 `timeline:focusComposer` 移交 composer——**随后在 composer 里按 Enter 发送**（composer 既有发送语义，篮非空时正文可空）；**失焦 = 仅入篮**（多条累积走这条）；**Esc = 取消**。没有按钮——键位与 rewind 内联框的肌肉记忆不重学；两段式（先确认后发送）避免评论编辑器里 Enter 直接发出的突兀。草稿不需要仪式性的存废决定。
- **提交即入篮，不打断阅读**。提交后评论框关闭，评论篮里多出一条，编号立即分配；用户回到阅读流，下一条意见随时登记。从"发现不对劲"到登记完毕不超过写一句话的时间——§1.2 的"收集零打断"就靠这个时延活着。
- **选区快照在唤起时固化**。quote 取点击浮条时刻的选区文本存进编辑器（点击即释放选区，提交时刻已无选区可取），此后消息继续流式、追加、重渲染，引用不变（锚定在快照，§1.2）。超过 500 字符的选区文本在唤起时截断——引用是证据不是全文转载，截断规则见 §3.1。

### 2.3 评论篮：输入框上方的编号列表

- **编号即身份**。篮子里的评论按加入顺序编号（①②③…），编号同步进发送拼装格式（`> ① :`，§3.3），模型的后续回复可以按编号回引——**编号是人和模型共用的引用句柄**。删除中间一条后后续评论自动重排，编号永远连续：断号会让人（和模型）以为中间丢了一条评论。
- **编辑回到原始位置**。点击条目的**意见区**：滚动到被评论消息、内联编辑框在该消息下方打开（预填该条意见）。编辑与新评论共用同一个内联框形态——**编辑永远发生在原始位置**，用户看着原文改意见；编辑期间编号保持不变。两个内联框互斥，同一时刻只许一个。
- **删除即重排**。删除第 N 条，其后评论自动前移重排，编号永远连续——编号是"人和模型共用的引用句柄"（§2.4），中间留空号会让模型以为有评论丢失。"清空全部"一次清空整篮。
- **点击引文跳原文**。点击条目的**引文区**（❝ 预览）时，timeline 平滑滚动到被评论的消息位置——复用 `timeline:scrollTo` 的滚动逻辑（§12.5 先例，`session-flow-architecture.md`），让"这条评论在说哪段话"一眼即达。锚失效（compaction、会话重载后 id 更替）时降级为不跳转。
- **篮子的存在感与克制**。篮子只在非空时出现在输入框上方，空时完全收起不占像素；可见条数可配（通用配置 `reviewBasketVisibleCount`，3/5/8/10，默认 5），超出滚动、不顶起 Composer；chip 的引文/意见超长截断。它和 Composer 之间没有Tab/焦点切换关系，输入焦点默认始终在正文输入区。

### 2.4 发送：一次拼装，echo/send 双形态

- **拼装发生在发送这一刻**。评论篮平时不产生任何 token 成本——不进 system prompt、不进上下文，只是内存列表。用户按发送时，`promptFragment`（全部评论的拼装文本，含编号、引用块、意见）拼在用户正文之后，一次 `prompt` 发出。拼装格式见 §3.3。
- **echo 与 send 分离**。时间线回显 = 正文气泡 + 气泡下方的**附件徽章条**（编号 + ❝引文预览 + 意见，只读无交互）；发给 pi 的用完整拼装。现状的 `sendMessage(cwd, text)` 已有 echo/send 分离（乐观回显 `text`、实际发送含工具限制前缀的 `finalText`）；本文方案扩展为 `sendMessage(cwd, text, { sendSuffix, echoAttachments })`——`sendSuffix` 拼在正文之后（与工具限制前缀 `buildToolLimitNote` 同一手法但方向相反），`echoAttachments` 结构化挂在乐观消息上、水合存活，由 timeline 在 user 分支渲染徽章条。徽章不是消息 content 的一部分，不参与文本拼装。
- **正文可空**。"就这些评论，你改吧"本身是完整意图：篮非空时发送键即启用，正文可空，发出去的只有评论块——这是评审类反馈的常态姿势。
- **发送成功才清篮**。`prompt` 被底座接受后评论篮清空；发送失败（RPC reject、进程退出）篮子原样保留——**评论是用户资产，投递失败不丢**。注意 abort 不在失败清单里：`prompt` 写 stdin 即 resolve（微秒级），清篮回执同步发出，用户能点到停止按钮时回执早已落地——abort 只停生成，不撤回已投递的评论（消息已发给模型，语义上也不该撤回）。失败重发时直接再点发送，评论随同正文再走一遍拼装，无需任何人工恢复。

### 2.5 边界场景

- **流式渲染进行中选中**。流式输出期间消息 DOM 在持续变化，选区可能随时塌缩。允许选中与评论：quote 以**提交时刻的快照**为准存进篮子；此后消息继续流式、追加、甚至重渲染，篮子里的引用不变（锚定在快照，§1.2）。浮条在流式导致 DOM 变化时按 `selectionchange` 重定位或随选区塌缩而消失。
- **评论篮有货时切换会话**。篮子按 sessionPath 分桶：切到会话 B，看到 B 的篮子；切回 A，A 的篮子原样还在。同一体感规则：**评论跟随它所属的会话走，不串台**。
- **发送失败**。RPC reject、进程退出、用户 abort——篮子原样保留（§2.4），用户修正后重发即可，不需要任何人工恢复评论的动作。
- **被评论的消息随后被压缩（compaction）**。compaction 后原消息被摘要替换、entryId 失效，篮子中该条评论**不失效**——它锚定在 quote 快照上，原文已不在也不影响发送（快照自包含，§1.2）；仅"点击跳原文"降级为不跳转。
- **评论篮有货时 rewind（fork 改写重发）**。rewind 不走附件协议：fork 后的发送不拼装评论，篮子滞留在 fork 前的会话桶——切回原会话仍可取回，不丢。评论锚定的消息在 fork 里是否还有效归属模糊，不自动跟随是保守正确的默认。
- **notes 常用语直发**。notes 插件经 `sendMessage` 直发、不经 timeline 的附件拼装——评论只挂"经 timeline composer 发出的消息"，这是附件协议的明确边界。
- **会话切换后篮子状态**。按 sessionPath 分桶：切到 B 看 B 的篮，切回 A 恢复 A 的篮；新会话（未落盘）使用 `new:<cwd>` 临时桶键，首发落盘后迁移到真实 sessionPath 桶（迁移规则见 §3.2——真实时序下 `new:` 桶几乎恒空，迁移只覆盖首发到水合间的 IPC 窗口）。

## 3. 数据模型

### 3.1 评论条目（ReviewComment）

评论篮里每一条评论是一份自包含的记录——它必须脱离消息现场依然成立，因为投递发生在未来某个不确定的时刻，而那时原文可能已经滚动、追加、甚至被压缩。字段集按"投递所需最小集"裁剪：

- **id**（uuid）：篮内身份，增删改与 invoke 回传的寻址键。离开篮子即消亡，不进拼装文本——编号（§3.2）才是对模型可见的引用句柄，id 只是 renderer 内的列表键。
- **messageId**（可空）：被评论消息当前渲染期的 id。用途只有一个——点击篮子条目跳原文。可空场景比最初设想的窄：直播期消息（乐观回显、流式占位）渲染时即带临时 UUID（`entryAppended` 只为 user 消息水合权威 entryId，assistant 消息终身背临时 id），会话重载后全部更替为文件 entryId——**锚只在直播期内有效，重载后跳原文静默降级**（§2.5）。
- **quote**：选区文本快照，唤起编辑器时固化，超过 500 字符截断。它是评论的锚——不是指针是快照（§1.2）：投递时原文可能已滚动、被追加、被压缩替换，quote 使评论自包含。截断是 token 成本控制：引用是证据不是全文转载。
- **comment**：用户的意见文本，只多行纯文本，不支持附件。
- **createdAt / updatedAt**：排序与"刚刚/N 分钟前"展示；排序永远按 createdAt 升序，与用户感知的发言顺序一致。

刻意没有的字段：行号、DOM 偏移、rect 坐标——任何指向"现场"的指针都会随会话流漂移，快照不漂移（§1.2）；sessionKey 不是字段而是篮子的分桶键（§3.2）；编号不是字段，是数组下标的展示形态（§3.2）。messageId 入篮即固化、**不回填不追踪**——评论锚定在 quote 文本上而非 DOM 指针，quote 与后续 id 更替之间无可靠匹配键，回填引错锚的风险大于跳转收益。代价是锚失效后"点击跳原文"降级——这是已知取舍，收进 QA。

### 3.2 评论篮状态（CommentBasket）

- **内存态，不落盘**。篮子是"下一条消息的附件"，生命周期短于一次应用运行是常态。落盘会引入过期引用问题：隔夜的草稿指向的消息可能已被压缩、会话可能已删除，而用户多半早已忘记这半篮草稿——醒来看到一篮昨天的评论不是功能是惊吓。刷新页面丢草稿是可接受的代价（§2.4 失败保留针对的是进程活着的发送失败，不是应用重启）。
- **按会话分桶**。桶键 = `currentSessionPath ?? "new:" + currentCwd`——与 SessionStore 的 procs key 同规则（`src/core/application/sessions/session-store.ts`），保证"评论跟随它所属的会话"（§2.5）。真实时序下 `new:` 桶几乎恒空：新会话窗口无消息可选、无从产生评论，`ensureForSend` 在首发瞬间即生成 sessionPath 并经 synthetic sessionStart 水合——唯一非空来源是"首发已渲染、水合未到达"的 IPC 窗口（毫秒级）。迁移规则因此可以极窄：**仅当上一桶键以 `new:` 开头、且当前拿到真实 sessionPath 时，把上一桶迁入新桶**；path→path（打开旧会话、rewind fork）一律不迁（fork 滞留取舍见 §2.5）。
- **清空时机全集**：发送成功（`channels.sent` 回执）、用户点"清空全部"、用户删光最后一条。发送失败**不清**（§2.4）；应用退出自然消亡（内存态，§3.2）。
- **编号是下标的展示形态，不是存储字段**。删除重排、编辑不换号、发送拼装按下标编号——人和模型读到的是同一套编号（§2.3）；存编号进字段就是冗余真相源，违反了编号即身份的初衷。

### 3.3 发送拼装格式（promptFragment / echoAttachments）

拼装是"组装与调用分离"的组装侧：review 的 `compose` 纯函数负责，timeline 的 `send()` 只拼接不感知格式。契约形状：

- **promptFragment**（追加在正文之后）：分隔线 `---` + 引导句 + 每条一段——`> ① : 引用快照` + 换行 + 意见文本。给模型的引用格式采用 markdown 引用块风格（`>` 引用行 + 下行意见），主流模型对这种格式的指向理解不需要额外 prompt 工程；引导句告诉模型编号是引用句柄，它的回复可以按编号回引（§2.3）。引用快照在拼装时已是截断后的存档，不再二次裁剪。**格式可配**：review 设置页（§4.5）开放两项——引导句与单条模板（占位符 `{seq}` `{quote}` `{comment}`），留空回内置 i18n 默认；默认模板与设置页"填入默认值"同键（`shell.formatItemPlaceholder`），运行时回退和设置页单源不漂移。
- **echoAttachments**（挂在乐观消息上的附件徽章数据）：与 `items` 同构的只读预览（seq、quote 预览、comment）。timeline 在 user 气泡下方渲染成徽章条，不做文本拼装；展示文案零 i18n（编号与引文自描述）。水合存活（entryAppended spread 保留），重扫 JSONL 后自然消失——会话重载降级为显示完整发送文本（§4.3）。
- **空篮契约**：`items: []`、`promptFragment: ""`——timeline 据此收起篮子区域、发送时零拼接，review 存在与否对发送链路零差异。

## 4. 接入架构

本章回答一个工程问题：review 插件的 UI 和逻辑，各自挂在系统的什么地方。结论先行：**唤起侧（选区浮条）完全由 review 自渲染，零槽位、零 timeline 改动；评论篮与内联编辑器处在 timeline 的表面区域内，由 timeline 渲染、状态由 review 经通道下发**。这条分界线的依据是两处 UI 的"宿主归属"不同，§4.1、§4.2 分别论证。

### 4.1 唤起侧零槽位：选区监听与浮条自渲染

- **唤起不挂任何槽位**。最终定稿的唤起形态是"选区浮条"：document 级 `selectionchange` 监听 + 选区旁横排浮条，按 `getRangeAt(0).getBoundingClientRect()` 定位。它既不是"消息行的动作按钮"（messageActions 槽的形状），也不属于任何槽位表面——它是**选区的附属物**，跟随的是 Selection API 的几何位置，不是 timeline 的布局槽位。原型迭代否掉的两种槽内形态（右上角动作条按钮、消息左缘 gutter 按钮）本质上都是"消息级入口"，与"选区级唤起"的语义不匹配。因此 review 对 messageActions、titlebar、sidePanel 等槽位**零贡献**。
- **零可见槽插件的加载与挂载**。plugins-host 的加载条件是物理的：内置插件按 glob `plugins/*/*/renderer/index.{ts,tsx}` 命中即加载（`src/api/renderer/plugins-host.ts` 的 `import.meta.glob`），manifest 的 `contributes` 与否不影响加载本身；加载即执行模块顶层代码并完成 channels 注册。因此"零可见槽"插件天然有一个执行入口：**renderer 模块顶层**。选区监听（`document.addEventListener("selectionchange")`）在模块挂载 effect 中启动即可。
- **浮条与覆盖层的 React 宿主**。浮条需要 React 渲染（主题 token、i18n），而它不属于任何槽位表面——先例是 session-colors：`document.body.appendChild(overlayRoot)` + `create-root(overlayRoot).render(<PluginIdContext.Provider value={pluginId}>…)`（`src/plugins/sessions/session-colors/renderer/index.tsx` 的 `renderOverlay`），pluginId 由框架树内首次挂载的组件经 `usePluginId()` 捕获后传入。review 采用同一模式，但 review 没有 sidePanel 之类的槽内组件可以"顺路"捕获 pluginId——专钓 pluginId 的面板又违背"零可见槽"初衷。
- **解法收进框架：plugins-host 增加 Overlay 挂载机制**。这是把 session-colors 的手写先例收敛为框架能力（§3.3 框架管通用：第二个调用方出现了）：plugins-host 加载模块后，若发现命名导出 `Overlay`（React 组件），则挂进主 React 树并以 `PluginIdContext.Provider` 包裹——pluginId 由框架注入，悬浮层插件获得与槽内组件完全相同的 `usePluginContext()` 能力；每个 overlay 套独立 ErrorBoundary，单插件悬浮层崩溃不拖垮主树。timeline、i18n 上下文天然可用（overlay 渲染在主 React 树内）。session-colors 已迁移到该机制（见 Q7）。
- **浮条本身建议 DOM/portal 直渲**。浮条只是"一个跟随选区的胶囊按钮"，用 React portal 挂 body 或原生 DOM 注入皆可；文案 i18n 取自全局 i18next 实例（框架的 i18n 合并已把插件语言包并入全局实例，悬浮层与槽内组件共享同一 `t()`）。

### 4.2 评论篮与内联编辑器：timeline 渲染表面通道协议

- **划分原则：timeline 拥有"消息流表面"上的全部 UI**。评论篮（Composer 上方）和内联评论框（消息正下方）都长在 timeline 的布局里——尤其是内联评论框插在被评论消息正下方，而 timeline 的列表是 Virtuoso 虚拟列表（滚出视口的行会被回收），外部 overlay 锚定会漂移脱锚；rewind 内联框（`data-rewind-inline`）已经证明了"timeline 在消息行下方渲染内联输入区"这条路径可行。因此：**篮子和内联编辑器由 timeline 渲染，review 只提供状态与语义**。浮条（§4.1）例外——它是选区的附属物、document 级浮层，不属于 timeline 表面，由 review 自渲染。
- **通信载体是 `timeline:composerAttachments` 通道**（timeline 拥有并订阅，插件 invoke 投递）。payload 是全量快照：
  - `items`：篮内评论数组（id、seq 编号预览、messageId、quote 预览、comment 全文——编辑态预填与 chip 展示都用它）；
  - `promptFragment`：发送拼装段（§3.3），每次变更重算——invoke 没有返回值，timeline 无法在发送瞬间回问，只能消费最近一次推送，因此**每次变更即推全量**，保证 timeline 持有的副本永远新鲜；
  - `editor`：新建评论的内联编辑器状态（锚定 messageId、quoteText），为 null 时 timeline 收起内联框。编辑已有评论不走 editor——那是篮子条目的就地编辑态（§2.3）；
  - `channels`：回调通道名集合（submitNew/submitEdit/cancelEditor/remove/clearAll/sent），全部归 review 所有——timeline 交互事件经 `invoke` 回传到这些 channel，权属校验天然放行（invoke 不校验调用方权属）。
- **timeline 的五处改动**（全部是通用机制，无 review 字样）：
  1. `channels` 增加 `timeline:composerAttachments`（命名承载通用语义：附件，不是评论），TimelineView 订阅并本地缓存 payload；
  2. Composer 上方渲染附件篮：编号 chips（seq 由 payload 携带，编号逻辑只有 review 一份）、✕ 删除、"清空全部"、引文区点击跳原文（scrollTo）、意见区点击跳原文并打开内联编辑框（编辑回到原始位置；draft 归 timeline 组件 state，保存才 invoke submitEdit，打字零事件流量；失焦有内容即提交、无内容即取消），交互动作 invoke 到 payload.channels 指明的 channel；
  3. **内联评论框渲染点**：`editor` 非空且 `anchorMessageId` 命中当前渲染的消息行时，在该消息下方渲染内联输入框——形态与 rewind 内联框（`data-rewind-inline`）同款，输入草稿归 timeline 组件 state（rewind 内联框先例，`data-rewind-inline`），提交/取消经 `invoke` 转发到 payload.channels 指定 channel；
  4. MessageRow 根节点补 `data-message-id={message.id}`：review 侧浮条与编辑器定位的 DOM 锚点。直播期消息（乐观回显、流式占位）渲染时即带临时 UUID，该属性恒在；分隔线等无 id 消息不渲染；
  5. `send()` 拼装与回执：命中当前 sessionKey 的 payload 存在时，`send = 正文 + promptFragment`、乐观消息挂 `echoAttachments = items`，`prompt` 成功后 `invoke channels.sent {sessionKey}`，失败不回执（篮子保留，§2.4）。发送使能谓词 = 正文非空**或**附件非空——Composer 组件层（`allowEmptySubmit`）与 `send()` 逻辑层同一份谓词（篮非空时"只发评论"是完整意图，§2.4）；篮子显示也只消费 sessionKey 对齐的 payload，时序错位不串台。
- **编辑器草稿的归属**。内联编辑器的文本 draft 归 timeline 组件 state（与 rewindText 同一先例），提交/取消才经 `channels.submitNew/cancelEditor` invoke 回 review；篮子条目的就地编辑同理，保存才经 `channels.submitEdit`——打字过程零事件流量，只有提交动作过通道。

### 4.3 发送链路：拼装、回执、失败路径

- **拼装是预计算，不是发送时回查**。invoke 没有返回值，timeline 无法在发送瞬间"回问"review；因此 review 在**每次篮子变更时**重算 `promptFragment` 并推送全量快照，timeline 发送瞬间消费的是最近一次推送的副本。变更即推 + 恰好一次投递，保证两侧无漂移窗口（§4.4）。
- **与工具限制前缀的顺序**。timeline 现有 `[System]` 工具限制前缀（`buildToolLimitNote`）拼在正文**之前**；`promptFragment` 拼在正文**之后**——评论引用的是"上面的回复"，紧跟正文的阅读顺序对模型最自然，两者不冲突。
- **成功清篮的回执**。`prompt` resolve 仅代表底座接受了消息（MessagingApi.prompt 契约：resolve = 底座接受，输出靠事件流），timeline 在 resolve 后 `invoke channels.sent {sessionKey}`，review 据此清桶并推送空 payload。发送失败（reject、进程退出）则不回执——**篮子保留，comment 是用户资产**（§2.4）；用户重发时 promptFragment 仍是最近一次推送的快照，随重发再走一遍。abort 不在此列：`prompt` 微秒级 resolve，回执先于任何 abort 落地，abort 只停生成、不撤回已投递的评论（§2.4）。
- **echo/send 双形态的渲染管线：乐观消息要能被底座回放认出**。乐观回显（echo 内容）与实发文本（send 内容）不同，底座回放 user 消息时按"全文相等"去重必然失配——回放被当成新消息追加，时间线双条（短 echo 一条、完整拼装泄漏一条；工具限制前缀同样触发）。修法：乐观消息携带 `__sendText`（实发全文）作匹配键，`messageStart`/`messageEnd`/`entryAppended` 三处匹配双轨（echo 全文或 `__sendText`），命中后保留 echo 内容（content、echoAttachments），只吸收回放权威字段——用户永远只见 echo 形态。重扫 JSONL 后 echoAttachments 丢失（文件无此字段），降级为显示完整发送文本：已知取舍，不为重扫链路设映射表。
- **sessionKey 对齐**。payload 的 sessionKey 与 timeline 的 `currentSessionPath ?? "new:" + currentCwd` 比对，不匹配则忽略显示但保留缓存——时序错位（切会话瞬间）不会把 A 会话的评论误拼进 B 会话的消息。
- **"无漂移窗口"的物理依据：invoke 同步派发**。`eventBus.invoke` 的实现（`packages/react/src/event-bus.ts`）在调用栈内同步循环执行所有 handler——不是异步入队后稍后执行（无订阅者时才入队）。因此 timeline `invoke channels.submitEdit` → review handler 同步执行 → review 在同一调用栈内 `invoke timeline:composerAttachments` 推送新快照 → timeline handler 同步更新缓存——整个链路在一条 JS 调用栈内完成，invoke 返回时 timeline 的缓存已是最新。JS 单线程模型下用户输入（点击发送）不可能插入同一调用栈，因此"编辑提交后立刻按发送用旧 promptFragment"的竞态在物理上不可能发生。唯一的前提：**未提交的编辑草稿不进发送**——draft 留在 timeline 组件 state，只有用户点"保存"（invoke submitEdit）后才进入 review 状态并推送新快照；用户不保存直接按发送，timeline 消费的是最近一次提交的版本，草稿丢弃。

### 4.4 事件通信合规：为什么是 invoke 而不是 emit/on

- **emit/on 的两条硬约束**（`packages/react/src/event-bus.ts`）：emit 校验调用方拥有 channel（越权抛错）；on 校验 channel 已被某已加载插件注册（未注册抛错）。若用 emit/on 做状态同步，timeline 必须 on `review:*`，review 未安装/被禁用时 on 直接抛错——timeline 被迫对"可选插件"硬编码 try/catch，违反无特权差异。
- **invoke 的语义恰好匹配**：调用方不需要拥有 channel（`eventBus.invoke(callerId, channel, payload)` 只校验 channel 已被某已加载插件注册）；无订阅者时入队，首个订阅者挂载时恰好一次冲刷。所以：**timeline 拥有表面 channel 并订阅**（timeline 恒在、review 可缺，注册方必须是在场的一方），**review 拥有回调 channel 并订阅**（timeline 仅在持有 attachments 时 invoke 回调——有附件即蕴涵 review 推送过、必然在线，不会触发"未注册抛错"）。
- **状态推送制而非请求-响应**。invoke 没有返回值，timeline 无法在发送瞬间回问 review；因此 review 把"每次变更的全量快照"推给 timeline——`promptFragment` 随每次篮子变更重新拼装并随快照推送，timeline 永远消费最近一次推送，无漂移窗口。这是 invoke 无返回值约束下唯一正确的数据流方向。
- **dependsOn 声明**：review 在 manifest 声明 `dependsOn: ["timeline"]`——invoke 校验 channel 必须已被某已加载插件注册，dependsOn 保证 timeline 先加载、channel 先注册（§8.2）。timeline 不声明对 review 的依赖（可选项，不构成生命周期环）。注意 dependsOn 只拦停用/卸载，不拦加载期失败：timeline 加载失败时 review 的推送 invoke 会抛"channel 未注册"，review 侧 try/catch 静默降级（与 Q3 的 timeline 侧兜底对称）；悬浮层插件的异常由框架 per-overlay ErrorBoundary 兜底，不拖垮主树。
- **插件禁用/卸载的缓存处置**：review 被用户禁用或卸载时，plugins-host 经 `onUnloaded` 回调注销其 channels（`eventBus.unregisterPlugin`）。timeline 持有的缓存 payload 不会自动清除——处置规则：timeline 在 `useUiStore(pluginsNonce)` 变化时（插件列表刷新的统一信号），丢弃缓存中来自已卸载来源的 payload。具体实现：payload 不携带 source 字段（review 不自报身份），timeline 改用更简单的规则——pluginsNonce 变化即清空全部附件缓存，review 重装后会重新推送。粗但安全，避免 timeline 感知插件身份。

### 4.5 设置页：拼装格式可配

- **两个可配项**：引导句（`promptHeader`）与单条评论模板（`itemTemplate`，占位符 `{seq}` 编号、`{quote}` 引用快照、`{comment}` 意见文本），留空回内置 i18n 默认。配置经 manifest `configFile` 声明（`~/.pi-desktop/config/review.json`），save/dirty/拦截/刷新全由框架管（§9.1），设置页组件只报 `onChange`。
- **生效路径**：设置页 `onChange` 即写 review 内部 format store——草稿即生效，发送拼装所见即所得；Overlay 挂载时从 config 水合。configFile 通道与 `ctx.config` 通道读的是同一组文件（项目级覆盖全局、两层合并），设置页保存与 Overlay 读取天然对齐，无第二条同步链路。

## 5. QA

**Q1：在流式消息上评论，锚的是临时渲染 id 还是落盘后的权威 entryId？跳原文会一直可用吗？**

锚的是临时渲染 id。直播期消息（含流式占位）渲染时即带临时 UUID，评论的 messageId 就是它；assistant 消息的临时 id 终身不换（`entryAppended` 只水合 user 消息），所以直播期内跳原文稳定可用。会话重载后消息从 JSONL 重扫、全部换成文件 entryId，旧锚静默失效、跳原文降级为不跳转（§2.5）——评论本身不受影响（锚定在 quote 快照，§1.2）。不回填、不追踪，理由见 §3.1。

**Q2：用户编辑了一条评论（点击 chip 意见区 → 内联框打开 → 打字中），还没保存就按了发送键。发送的 promptFragment 包含刚才打的草稿吗？**

不包含。编辑草稿留在 timeline 组件 state（与 rewindText 同一先例，§4.2），只有保存（Enter 提交、或失焦时有内容自动放回）后才进入 review 的篮子状态并触发新快照推送。未保存的草稿不进发送——timeline 消费的是最近一次**已提交**版本的 promptFragment。用户直接按发送等于丢弃草稿，与"在输入框打字一半直接关窗口"的行为一致。如果需要更友好的体验，可以在编辑态打开时 disable 发送按钮（实现细节，本文不强制）。

**Q3：review 插件被禁用/卸载后，timeline 上还显示着评论篮的 chips，点 ✕ 删除会怎样？**

timeline 在 `pluginsNonce` 变化时清空全部附件缓存（§4.4），因此卸载后 chips 会消失。但存在一个时序窗口：`onUnloaded` 触发到 `pluginsNonce` 广播之间，timeline 可能还持有旧 payload 的 chips。此时用户点 ✕ → timeline `invoke channels.remove {id}` → review 的 channels 已被 `eventBus.unregisterPlugin` 注销 → invoke 抛错"channel 未被任何已加载插件注册"。timeline 的 invoke 调用应 try/catch 兜底，静默忽略——chips 随 pluginsNonce 刷新后自然消失。这是已知边界，不是 bug。

**Q4：同一 cwd 下连续新建两个会话（都未落盘），两个会话的评论篮会串吗？**

理论上共用 `new:<cwd>` 桶键，但真实时序下这个问题几乎不存在：新会话窗口无消息可选、无从产生评论，而首发瞬间 `ensureForSend` 即生成 sessionPath 并经 synthetic sessionStart 水合——`new:` 桶的唯一非空来源是"首发已渲染、水合未到达"的毫秒级 IPC 窗口，水合时迁入真实桶（§3.2 的极窄迁移规则）。两个未落盘新会话在此窗口内同时持有评论的概率可以忽略。

**Q5：promptFragment 和工具限制前缀（`buildToolLimitNote`）的拼装顺序是什么？会冲突吗？**

不冲突。工具限制前缀拼在正文**之前**（`finalText = toolNote + "\n\n" + text`），promptFragment 拼在正文**之后**（`finalText = toolNote + "\n\n" + text + promptFragment`）。两者位置不重叠：前者是"系统指令"（告诉模型工具被限制了），后者是"用户反馈"（告诉模型哪段回复有问题）。发送链路：`sendMessage(cwd, text, { sendSuffix: promptFragment, echoAttachments: items })`——`sendMessage` 内部先把 `buildToolLimitNote` 拼在 `text` 前，再把 `sendSuffix` 拼在其后；`echoAttachments` 不进文本，挂在乐观消息上供徽章渲染。如果将来有第三个拼装段，追加在 sendSuffix 之后即可——拼装顺序是线性追加，不是嵌套。

**Q6：评论篮落不落盘？刷新 app 后评论还在吗？**

不落盘（§3.2）。评论篮是内存态，刷新 app 后自然消亡。"发送失败保留"（§2.4）针对的是进程活着时的 RPC reject/进程退出/用户 abort——进程一退出，内存就没了。这条取舍的理由：落盘草稿会引入"过期引用"问题——隔夜的草稿指向的消息可能已被压缩或会话已删除，用户醒来看到一篮昨天的评论不是功能是惊吓。如果将来有强持久化需求，可以用 `ctx.config` 落盘（项目级配置通道），但需要在加载时做"引用消息是否还存在"的校验，不在本文范围。

**Q7：plugins-host 的 Overlay 挂载机制是新建的框架改动，它会不会影响现有插件？**

不会。机制是**纯增量**：plugins-host 在 `loadBuiltin`/`loadThirdParty` 加载模块后，检查模块是否有命名导出 `Overlay`（React 组件），有则挂进主 React 树、以 `PluginIdContext.Provider` 包裹，且**每个 overlay 套独立 ErrorBoundary**——单个插件悬浮层崩溃只摘除自己，不拖垮共享根级边界。session-colors 的手写 `renderOverlay` 已迁移到该机制（机制落地即有第二个真实用户）：其 config 读写（load/persist）随 Overlay 从面板收进常驻挂载点，面板只读 store——同时修掉了手写版"面板未挂载就不加载 pin"的启动空洞。

**Q8：评论的编号 ①②③ 用的是 Unicode 圆圈数字，超过 9 条怎么办？**

① 到 ⑨ 是 Unicode 圆圈数字，第 10 条开始降级为 `10`、`11`… 的纯数字（`numOf` 函数兜底）。发送拼装格式里对应 `[评论 ①]` 到 `[评论 10]`——前 9 条视觉一致，10 条以上功能一致但样式降级。一条会话里评论超过 9 条是极端场景（评审类反馈通常 2-5 条），降级可接受。
