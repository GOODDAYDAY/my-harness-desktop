---
name: interaction-testing
description: 在 my-harness-desktop 做真实交互验证(DOM 级/E2E)时使用。覆盖拉起应用、隔离 HOME、CDP 驱动、DOM 锚点清单、虚拟化/时序陷阱、数据层 vs 渲染层断言分工、双内核差异。触发词:交互测试、e2e、DOM 断言、CDP、puppeteer、冒烟、真实模型、会话流验证、写 e2e。
---

# 交互测试(my-harness-desktop)

本仓库的功能验证纪律是三级(CLAUDE.md §5.6):纯逻辑单测(vitest node)→ DOM 交互测试(vitest+jsdom)→ 真实 app e2e(puppeteer-core + CDP 驱动 `out/` 构建产物)。本文是第三级(真实交互)的实操手册——每一条都来自实踩过的坑,不是通用 puppeteer 常识。

## 1 基础设施(现成件,别重造)

| 件 | 位置 | 用途 |
|---|---|---|
| `launchApp` / `killApp` / `assertPortFree` | `scripts/demo/lib/app.mjs` | 拉起 electron(`--remote-debugging-port`)+ puppeteer 连 renderer 页;`assertPortFree` 防撞用户实例 |
| `makeRunRoot` / `setupBaseline` | `scripts/demo/lib/home.mjs` | 一次性隔离 HOME(/tmp/pi-demo-\<uuid\>);pi 内核符号链接借真实 HOME,models.json/settings.json 拷贝防写回 |
| `waitForDomIdle` | `scripts/demo/lib/util.mjs` | DOM 静默等待(事件驱动,不赌固定 sleep) |
| 场景种子 | `scripts/demo/scenarios/*` | seed.json + index.mjs,`applySeed(ctx, ...)` 组装演示状态 |

**拉起前必种 `lastCwd`**,否则应用停在无项目空态、composer 不渲染:

```js
const prefsFile = join(home, ".my-harness-desktop-dev", "config", "config.json");
writeFileSync(prefsFile, JSON.stringify({ ...JSON.parse(readFileSync(prefsFile, "utf-8")), lastCwd: projectDir }, null, 2));
```

**端口纪律**:CDP 端口与 `MHD_PORT`(应用内 HTTP 服务)各错开;跑前 `pkill -f "remote-debugging-port=<port>"` 清残留,否则下一个实例静默起不来(报错是 `Failed to fetch browser webSocket URL`,不是端口占用)。

**dsh 侧额外三件**(缺一则插件树崩/凭证读不到,见 `scripts/demo/dsh-session.e2e.mjs` 开头):
- `~/.my-harness-desktop-dev/dsh` → 符号链接真实(内核 + 会话根)
- `~/.dsh/{cordis.yml,settings.yaml,.credentials.yaml}` → **拷贝**(不写回真实 profile)
- `~/.dsh/node_modules` → 符号链接(桌面适配插件的依赖解析根)

## 2 DOM 锚点清单(实测有效,按角色/数据属性查,不按 class 查)

| 锚点 | 目标 |
|---|---|
| `[data-timeline-composer]` | 输入框 textarea(唯一) |
| `button[aria-label^="发送"]` / `[aria-label*="停止"]` | 发送/停止钮(流式中发送变停止) |
| `[data-message-id]` | 消息行(锚点 id = 中立 entryId `{lineageId}:{seq}`) |
| `[data-session-path]` | 侧栏会话行(sessions-list) |
| `[data-goal-phase]` | goal 目标条(active/paused/achieved) |
| `[data-ask-question]` | ask 提问卡 |
| `button[title]` | 图标按钮的唯一可达名(收藏/分叉/重试/复制/钉图钉/回退;侧栏图标条的 Review/Tree/统计 等) |
| `[role=menu]` + `[role=menuitem]` | 模型下拉(Radix) |
| `[role=menuitem]` | 右键菜单项(会话行右键:重命名/置顶/归档/打开两文件) |

**消息行悬停动作钮**:先 `page.mouse.move` 到行中心,等 ~600ms(hover 淡入),再按 title 查。行内按钮 title 全集:复制/分叉/收藏/钉图钉/重试(user 行另有「回退」)。

**会话列表首行是「新对话」乐观占位行**,不是会话——点行重开要按内容找(`rows.find(r => r.innerText.includes(会话名))`),`rows[0]` 会点到空壳(刷新后点击「重开」探针踩过)。

**设置页改配置要过「保存浮层」**:settingsGroups/设置字段改值后只进 dirty,不落盘——页面底部弹「未保存改动」浮层,**点「确定改动」(t shell.confirmChanges)才写回 configFile**,再经 `system:configFileSaved` 广播让消费方(如 timeline)重读生效。探针改了值不点保存 = 行为不变(r85b 踩过)。找钮按文案「确定改动」,不是「保存」。

## 3 七条实踩陷阱(每条都是根因,别再踩)

### 3.1 「刷新会话列表」包含子串「新会话」
`title.includes("新会话")` 会先命中**刷新按钮**(DOM 序更前)。按钮匹配一律用 `startsWith` 或全等,不用 `includes`。

### 3.2 合成事件 vs 可信点击
`dispatchEvent(new MouseEvent("click"))` 对 Radix 组件和部分壳组件(ChatRow 设置行)不触发 onClick。**可信路径**:拿 `getBoundingClientRect()` 中心坐标,`page.mouse.click(x, y)`。发送按钮例外——它被验证过吃合成事件(历史 e2e 同款)。

### 3.3 Virtuoso 只渲染可视窗口
会话流是虚拟列表:**视口外的条目不在 DOM**。`body.innerText.includes(...)` 只能证可见窗口。断言顶部内容(模型分隔线/首条消息)前先滚顶:

```js
await page.evaluate(() => {
  document.querySelectorAll("div").forEach((d) => { if (d.scrollHeight > d.clientHeight + 200) d.scrollTop = 0; });
});
```

顶部前缀与底部新消息**不可能同时在 DOM**——二者择一断言,或用中立层文件证(见 §4)。

### 3.4 收敛必须两阶段
发送后「停止」钮挂载有几百 ms 窗口。只等「停止消失」会在起跑前立即通过(假收敛),断言打在在飞回合上。正确:

```js
await page.waitForSelector("[aria-label*='停止']", { timeout: 20000 });            // 先等起跑
await page.waitForFunction(() => !document.querySelector("[aria-label*='停止']"), { timeout, polling: 500 }); // 再等收敛
```

### 3.5 body.innerText 混入侧栏预览
会话列表行带消息预览文本——`innerText.includes("ping")` 命中的是侧栏,不是时间线。时间线内容断言打 `[data-message-id]` 集合,不查 body 全文。

### 3.6 assistant content 是内容块数组,不是字符串
中立层 assistant `message.content` = `[{type:"thinking",...},{type:"text",text:"..."}]`。`String(content)` 得 `[object Object]`。取文本:`content.filter(b=>b.type==="text").map(b=>b.text).join("")`(圆心有 `messageContentText`,测试里直用)。

### 3.7 探针自身的时序假设
模型行为不确定(可能调工具/开子会话/秒回)。探针别假设回合时长、别假设模型不调工具;断言写「至少/存在性」,不写精确序。

## 4 数据层 vs 渲染层断言分工

**能读文件就别读 DOM**。中立层会话文件 `<隔离HOME>/.my-harness-desktop-dev/sessions/<ns>.json` 是硬证据:

- `header.custom.model` = 当前模型域(provider/modelId/thinkingLevel/kernel)
- `header.custom.goal` = goal 引擎持久态(phase/round/maxRounds)
- `lineages[].entries[]` = 全部条目(user/assistant/divider/toolResult/goal_note)
- divider 条目:`{role:"divider", kind:"model"|"info"|..., i18nKey, i18nArgs}`
- assistant 条目:`usage`(token)、`timestamp`(写穿时刻)、`startedAt`(调用开始)、`stopReason`/`stopped`/`error` 终结标记、 `model`(执行时模型)

DOM 只断「呈现对不对」(右对齐/徽标/按钮在不在),数据正确性全走文件。文件名即 ns。**fork 已改产新会话**(bookmark-snapshot-fork-unify §5,commit 4ea26727):fork/retry/rewind/收藏发起统一派生**全新中立会话**——新 ns、根 lineageId ≡ ns、`header.derivedFrom` 记源、`header.pendingSeed` 置位(首发强制物化、成功清除);pi 侧内核文件在**首发后**才物化为 `<bucket>/<newNs>.jsonl`(内容=前缀+新消息),源会话文件不动。探针断言:派生后读 neutralStore 验 `derivedFrom.kind` + pendingSeed;首发后验 pi 文件存在 + pendingSeed 清除;重试用**结构断言**(boundaryEntryId = 待重发 user 前一条;重发条目恰 1 条),别数字符串出现次数(模型回复会回显,次数虚高)。

## 5 按内核的最小验证路径

**pi(默认)**:种 lastCwd → 等 `[data-timeline-composer]` → setComposer(原生 setter + input 事件)→ 发送 → 两阶段收敛 → 中立层文件断言。

**命令(/goal 等)**:命令是即时状态动作、永远不进内核消息流——发送前被 composer 拦截。**用真实键盘**(`page.click` 聚焦 + `page.keyboard.type` + `press("Enter")`),别用合成 KeyboardEvent(实测合成 Enter 在「发送在飞/流式」窗口会静默吃掉命令)。中止 goal 优先点目标条的「停止」钮(`[data-goal-phase]` 内的 button),比命令更直接。

**dsh**:先按 §1 备齐三件 → 模型下拉(`button[id^=radix]` 开 menu → 点 `DSH` 页签 → 选 `qwen3.8-max`)→ 发送。注意 dsh 无 thinking 档、事件形状不同(回合收敛 = turn/end 合成的 agentSettled)。

**消息动作全是「arm-confirm 两段式」**(收藏/分叉/重试/删除):第一次点 = armed(钮文案变「确认X?」),第二次点才执行。探针只点一次 = 没执行(r61 踩过)。重试的「重发」语义 = fork 派生新会话(position=before,前缀排除待重发 user)+ messaging.prompt 重发——重试后视图切到**新会话**,消息行数变少(只含前缀+重发)是设计语义,不是丢消息。

**dsh fork/重开(已修复,根因在 deepseek-harness 仓)**:fork 本身三层皆证;但 fork 分支发送 + 重开历史 dsh 会话续发,两条路径曾死在「seed → prompt 不产回合」——实弹 r305/r307/r308:分支发送 25s 零事件(无 agentStart)、停止钮不出;dsh 会话文件只有 seed 的 8 行(`session→turn/start→user→assistant→turn/end→session/end-seed`),无后续 prompt 的 turn。**根因在 dsh SDK**(`@deepseek-ai/dsh-sdk-jsonrpc-server`):`seed` handler 用 `ctx.sessions.create(SessionId,{seed})` 建会话但**从不写 server 的 `this.sessions` map**;`prompt` 的 `getOrCreateSession` 读 `this.sessions` 落空 → `createSession` 再 `ctx.agents.create` 对已存在会话重复 prepare → `followup` 不产回合。**修复(已在 deepseek-harness 仓提交 bff174fa77)**:seed 改 async、用 `ctx.agents.create({sessionId,seed,meta,agentOptions})`(照抄 `createSession`/`setModel` 的 create+`this.sessions.set` 范式,多传 seed)+ 注册。**实弹复核通过**:r305 fork 分支物化含 assistant ✓、r308 重开续发产回合(agentStart/agentSettled/messageEnd)✓。复核手法:fork/重开 → 分支发 → 插桩 `window.kernel.sessions.onEvent` 看有无 agentStart + 读 dsh `session.jsonl` 有无 turn 2。

**跨内核边角(已厘清)**:pi 会话有历史后改选 dsh 模型再发,设计是显式降级抛错(「跨内核切换暂缓」)。早前实测的「渲染层 CDP 长阻塞」根因不是产品 bug,是 **CDP `protocolTimeout`(默认 180s)< 探针的等待超时(300s)**——单调用超 180s 被协议层截断成 `Runtime.callFunctionOn timed out` 假失败。已在 `scripts/demo/lib/app.mjs` 的 connect 补 `protocolTimeout: 600000`(c2ef99b2)根治。教训:凡是「等收敛/长回合」类等待,先确认协议层超时不比你的 timeout 小。

**跨内核切会话(真 bug 已修 554c42c3)**:`setModel` 的「会话固定内核」真相源用错了——`fixedKernel = activeKernel ?? activeSessionKernel()` 让全局 activeKernel(只记「最后一次选的内核」,跨会话残留)优先,而非会话自身上下文 header.kernel(会话内容属于哪个内核的唯一真相)。从 dsh 会话切回有历史的 pi 会话时 fixedKernel 取到残留的 dsh,误判「当前会话已固定内核」挡发(停止钮不出、回合不起,不对称:dsh 续发正常)。修复:`activeSessionKernel() ?? activeKernel`(会话上下文优先)。复现:pi 发一条 → 新会话选 dsh 发一条 → 切回 pi 会话 → pi 续发(观察 `[aria-label*=停止]` 是否出现)。探针注意:切会话后视图断言用 `[data-message-id]` 行文本,别用 `body.innerText`(混侧栏预览);多会话切换要多切几轮(pi→dsh→pi→dsh)才能暴露「最后一次内核」这类残留。

**多会话建会话的模型选择器时序(探针,非 bug)**:建第 3 个会话时,模型选择器的内核 tab 切换(PI↔DSH)后模型列表要重渲染——`pickModel` 每步 sleep 要给足(≥800ms),否则第 3 次选模会落在旧列表/选错内核;会话 needle 用完整首条消息文本(如「ping sA」),别用单字母「A」(多会话时 `includes("A")` 会误匹配)。r303 实证:3 会话(pi/dsh/pi)切换发送全绿(停止钮出+收敛+隔离),此前 r300 用 500ms sleep + 单字母 needle 全挂是探针问题,不是产品 bug。

**goal 引擎**:`/goal limit N`(须先有别目标时无效,limit 只改现存目标;要限速先在设置里改 goal.maxRounds 再设目标)→ `/goal <目标>`(正文作为真实用户消息发出,所见即所得)→ `[data-goal-phase]` 观察 active→(暂停)→paused→(恢复)→active;留痕卡 role=`goal_note` 落中立层。

**ask 提问**:指令模型「调用 ask_user_question 问我…」→ 等 `[data-ask-question]` → 选项整行(单选点选即答;多选勾选+提交)。

**同名按钮歧义:按 title/aria 找按钮前先排除消息行(r310 踩过)**:「收藏」title 在页面里有两种来源——右栏面板页签(sidePanel 槽)与消息行 hover 悬浮动作钮(BookmarkAction)。探针 `find(title==="收藏")` 会先命中消息行里残留的动作钮,点了它=误发一次收藏(多出一个"幽灵"快照+面板 revealOn 打开)。判别:面板页签不在 `[data-message-id]` 行内(`!b.closest("[data-message-id]`)`;同理「分叉」「重试」钮也各有行内/别处两种来源。另外:面板 revealOn 在一击收藏后已打开面板,再点页签=**切换关闭**——开面板先查"占位符已可见"(input[placeholder*=搜索收藏]),幂等勿重复点。

**收藏→分叉全链探针口径(r340 实钉,15/15)**:① 收藏动作 = hover assistant 行点「收藏」(一击默认 label,快照落 `<cwd>/.my-harness-desktop/bookmarks/<id>.json`);② **面板由 revealOn 自动揭示**(收藏点击 invoke `bookmarks:addRequested` → 框架展开收藏 tab)——探针**等行出现**(`[data-bookmark-id]`),别手动点「收藏」钮(可能点错 sidebar 组头、或把已激活 tab 点回隐藏);③ **收藏行本体即 fork 按钮**(行 div onClick=forkFromBookmark,GitBranch 图标 title「点击 fork」只是装饰——找不到「分叉」钮,点行);④ fork 链数据断言:新会话快照前缀 seed 落 user、内核归属同源、源会话零互串。

**composer 多行契约(r339 实钉,10/10)**:① Shift+Enter = 换行(textarea 值计 
,不触发发送);Enter = 发送——多行发送后 user 落盘**保留换行**(内容明文多行),DOM 组装行高随行数走(三行 ≈116px vs 单行 ~30px),渲染不丢行;② 空输入 Enter **不触发回合**(user 计数不变——断言口径:落盘计数,别赌 DOM);③ 真键盘序列:Shift 修饰要 keyboard.down(Shift)+press(Enter)+up(Shift),单次 press("Shift+Enter") 不带修饰。官方回归抽查(r39):goal-command 25/25 + single-source 11/11 在 989-test 构建上仍全绿。

**WS 离线/重连探针口径(r337 实钉,疑点在档)**:① CDP `Network.emulateNetworkConditions` **不杀已建立的 WS**(活 socket 存活)——离线只拦新请求;离线证据 = 离线窗口内 fetch 被拦(TypeError: Failed to fetch)或 `Network.loadingFailed`;② **重连等待要清事件缓冲**:轮间不清 `window.__ev` 会让下一轮的 settle 立即返回(上一轮的 agentSettled 还在缓冲里)——每轮 settle 前清一次;③ **疑点已结案(r338 复验 10/10 全绿)**:r337 的「写穿推迟到进程关闭」是**探针伪影**——stale agentSettled 假满足 settle(读文件时轮次还没起跑),60s 窗口在慢轮次完成前耗尽。干净口径(每轮 settle 前清 `window.__ev` + 120s 数据感知窗口)下,离线窗口后的回合写穿正常(2+2 落盘、内容正确、基线无损)。**写穿链完好**的静态佐证:writeThroughMessageEnd 在**壳后端**事件泵里跑,走内核进程管道,与前端 WS 健康无关。教训:任何「X 推迟/丢失」结论前,先排除 settle 假满足(清缓冲重验),再下产品 bug 定性。④ e2e 探针 ESM 里别用 require(动态 import node:child_process)。

**测试文件的 tsc 债(r335 实钉教训)**:`as never` 绕 props 能让 vitest 过(esbuild 只剥类型),但**全量 tsc 会照出缺的 props**——每轮写完测试必须跑 `npx tsc --noEmit -p tsconfig.json` 收尾,vitest 绿 ≠ tsc 绿。圆心接口的协议标记别省:测试造 `SessionBusMessage` 帧要带 `$bus: true`(它是「识别锚点」契约,缺了类型不过);MessageActionProps 的 text 是必填(渲染动作条需要,探针视角常忽略)。排查命令:`npx tsc --noEmit | grep test`。

**双项目×跨内核验收(r334 实钉,18/18)**:项目隔离 + 各桶内核归属 + 切回续发全链。两个必带判据:① **项目注册探针法**——「添加项目」走原生目录选窗(探针不可自动化);程序化注册 = **预种 `~/.my-harness-desktop-dev/config/projects.json` 的 `recentCwds: [dirA,dirB]`**(projects 插件的插件配置全局层,config-store 按 pluginId 分文件)——不预种则列表空、切项目点空、B 轮全落 A 的 cwd;② 项目分桶判据 = 会话文件 `header.cwd` 落属主目录、桶间内容零互串、各桶内核归属正确;③ 切项目 = `setCurrentCwd + startNewChat`(壳态干净 0 行);④ 切回后原会话续发不撞「已固定内核」(项目切换不改会话归属,goal §9 的进程面在项目面上同样成立)。

**review 评论篮的触发坑(r333 实钉,未完待续)**:① 评论入口 = **划词浮钮**(review Overlay:selectionchange 监听,选区须非折叠 + 落 [data-message-id] 行内)——**不是**消息行 hover 动作钮;② 消息行块布局(思考块/meta 标记/正文)导致双击/拖选**极易落在空白或 meta 上塌缩**(实弹:caretRangeFromPoint 命中的是「思考已完成(3.9s)」meta 文本,双击后选区塌缩)——要选中**正文叶子文本**需先按文本特征定位(TreeWalker 找非 meta/thinking 的深叶子)再程序化选区;③ 程序化 Selection API 设 Range 与 selectionchange 的时序:事件异步派发,设置后**要等 ≥500ms 真事件循环**再断言浮钮;④ Overlay 挂载机制 = 插件 module 的命名导出 `Overlay`(plugin-modules.getPluginOverlay,零 manifest 声明)——插件加载即挂载,排查 UI 不显形先查插件在不在清单(review 实证在)。

**大回归纪律(r332 轮,30 轮里程碑)**:每完成一批修复后,**官方矩阵全量重跑 + 自写探针抽重跑**——官方六套(69 断言)是地面真值,自写探针补官方没覆盖的修复面(goal×切换/custom 域跨重启/fork 派生各抽其一)。重跑口径:① 全绿 = 修复间无互踩;② 出现 DOM 断言失败时**先查数据层**(读会话文件)再定性——虚拟视口(§3.3)的滚动假阴最多,数据层在 = 非回归;③ 全部在**同一隔离 build** 上跑,不许中途改代码。

**流式中排队发送探针口径(r331 实钉)**:① 流式态下发送钮变形为「**排队发送**」(aria;title=「加入排队,AI 完成后自动发出」),与「停止生成」并存——点它 = **入队**而非直发;② 入队哨兵 = **「已加入排队 (第 N 条)」toast**(timeline.queue.enqueued)——没弹 = 没入队;③ 放出链:首回合 agentSettled → streaming false 边沿 → flushQueue 自动放出(数据层:等第二条 user+assistant 落盘);④ **流式态必须真键盘输入**:合成 value-setter 在流式 React 状态下 canSend 滞后、按钮 disabled 点不动(type=submit 的 disabled 拦截)——`elementHandle.click + keyboard.type + 真鼠标坐标点击`三件套才稳定(r331a/b/c 三轮实钉);⑤ 队列项合并语义:多条约 \n\n 合并发出(queue.mergedSent toast)。

**跨内核守门的断言口径(r330 实钉)**:守门的**完整性契约**是「内核归属绝不被错改 + 消息绝不在错内核下跑」,**不是**「跨内核消息必须被拦在外面」——pi→dsh 向实测:守门拒掉 dsh 模型后,消息**以会话内核 pi 落盘跑**(回落,消息保留);dsh→pi 向实测:发送被整个拦下(消息没落,弹「已固定内核」toast)。两种都是完整性行为,探针断言打在归属不变 + 零互串,别写死「消息必须不落」。toast 是 3s 自动消失——显式面断言在 ~1.5s 窗口内查,晚查是尽力项不作硬断言;守门报错文案「已固定内核/跨内核切换」。

**dsh 侧工具限制验收(r329,f64c16d2 修复面)**:dsh 会话是工具限制的「受损面」——修复前 toolConfig 无任何落点(dsh updateHeader 不收、中立层漏转),发完即丢、静默失效。验收序:dsh 显式选模 → 基线轮 → 工具面板关 4 组(pill)→ 发送 → toast + `header.custom.toolConfig` 落中立层 + `custom.model` 幸存(r317 键合并)+ 刷新持久。**跨内核修复的验收纪律:修复声称护住的每个内核面都要各自实弹**(pi 面过 ≠ dsh 面过——本次就是靠 dsh 面探针揪出修复前的真 bug)。

**工具面板探针口径(r328 实钉)**:① 组开关 = **32x18 圆角胶囊 div(恰一个 knob 子 div)**——形态识别(children.length===1 && 宽 28-70 && 高 14-30 && 子宽<父宽),别用文本/类名猜(盲审面板有同款胶囊);② 发送时 flush 的 pending → 弹「**工具过滤已应用:N 个工具可用**」toast(timeline.toolsFilterApplied)——toast 出现 = pending 已落,是 flush 面的活证据;③ 断言落盘读 `header.custom.toolConfig`(中立层真相源;pi 投影文件只是镜像);④ 本次实弹揪出真 bug:updateHeader 漏转 toolConfig 进中立层(f64c16d2 修复)——「toast 出现但中立层查无此键」= 契约面已生效、持久化面断裂的判别法。

**DOM×文件一致性对账法(r327 实钉)**:一条消息的旅程四层(pi JSONL → 中立层 JSON → DOM 行 → 可见文本),对账三断言——① 中立层条目数 = DOM 行数(虚拟列表滚动后);② 每个 data-message-id 都命中中立层(孤儿 0);③ pi 文件行数 ≥ 条目数且恰 1 行 session 头。活会话与刷新后各跑一遍(刷新前后条目数一致 = 单源零漂移)。两个必带判据:④ **写穿感知等待**——agentSettled 只是事件面,messageEnd 写穿可能晚到(实测轮 2 收敛后 1s 内才落盘),收敛断言要**轮询数据层**(assistant 计数到位)再对账,别赌 waitForDomIdle;⑤ **重开后点行先等列表**——reload 后侧栏异步重拉,行不在就点空;先 waitForFunction(行>0) 再点,点完等 DOM 行挂载(行点击后 openSession 异步)。

**官方 e2e 矩阵(r326 轮全绿实跑)**:`scripts/demo/` 下有五套官方 e2e(ask-question 真实模型/ask-resume 杀内核复活/message-actions 收藏分叉入口/goal-command 删改停 25 断言/session-single-source 单源冒烟)——改壳侧代码后跑它们是「官方口径回归」的现成手段,不必自写:ask-question 6/6、ask-resume 13/13(含杀内核→重启→卡片复活→续路作答→模型继续的跨流程矩阵)、message-actions 3/3、goal-command 25/25(零 token 沙箱)、single-source 11/11。注意各带独立 --port 默认(9334-9338)与兄弟 e2e 错开;跑前清端口;goal-command 不花 token(种子沙箱),其余真实模型。 第六套 dsh-session 11/11(思考中自清/模型分隔线/dsh 上收藏分叉入口/不重名/刷新持久;隔离 HOME 需 dsh 三件,花真实 dsh token,端点限流=环境问题非产品)——至此官方六套共 69 断言构成双内核地面真值。

**sub-agent 派活探针口径(r325 实钉)**:① 派活工具名 = **session_create**(bus 工具面;spawn_subagent 是插件内部名——痕迹断言两个都收);② worker 的 task 首条是**数组内容块** [{'type':'text','text':任务}]——needle 匹配统一 JSON.stringify(字符串原样、数组含块文本;typeof==='string' 过滤会把数组内容整个丢掉,r325 实钉);③ 隔层断言要**排除派活指令自身**(指令引用了任务文本,不排除就误报泄漏);④ watch:true 的完成回执 = `[bus session_done]` 帧(**以 user 消息落进主会话**)——数据层可见;⑤ 全链路验收序:主回合收敛→工人会话出现(轮询中立层)→工人 assistant 落盘→运维流有增量。

**设置浮层双臂完整口径(r324 实钉,全绿收官)**:① 弃臂按钮文案 = **「取消改动」**(locale `shell.discardChanges`,不是「放弃改动」——猜文案必错,查 locale 文件);浮层双钮 =「取消改动」+「确定改动」。② 落盘写**项目层**(`<cwd>/.my-harness-desktop/config/general.json`,unified-project-config 分层:项目层键覆盖全局层)——读生效值要**两层合并**(项目层键胜出),只读 dev 根会误判「没落盘」。③ checkbox 定位:SettingsSection 的 **title div 文本恰等于标题文案**(「启动时打开侧边栏」)——includes 匹配会命中包整页的外层容器,sec.querySelector('label') 拿到的是**别人的 label**(点错开关、dirty 不来);向上 4 级找 input[type=checkbox] 再 `input.click()`(HTMLElement.click 合成全路径,React onChange 触发;puppeteer ElementHandle.click 在自定义样式 checkbox 上偶发 not-clickable)。④ 完整验收序:翻 → dirty 浮层 → 确定改动 → 值落盘(项目层) → 浮层消失;再翻 → 浮层 → 取消改动 → 值不变 → 浮层消失。

**设置页三段式入口 + 浮层判据(r323 实钉)**:① 设置页是**分组 TAB**——点侧栏「设置」进的是第一个 TAB(pi 管理那组控件:自动压缩/分支摘要/请求重试);「通用」是独立 settings 入口(title=通用,order:1,自己的 configFile=general.json),得**再点一次**才进它的界面。② 找开关按 **locale 文案**(「启动时打开侧边栏」,非 key 名);settingsGroups 通用渲染的控件是 input[type=checkbox],**React 受控**——翻它要用原生 setter + click() 事件(鼠标坐标点可能只点中 label,onChange 不触发,值不变但 dirty 浮层可能出现,别拿浮层当翻成功)。③ dirty → 「确定改动」浮层是 fixed 定位在页面顶部中央(AnimatePresence),断言它出现 = 改动进 config state;落盘断言读 **dev 数据根**(~/.my-harness-desktop-dev/config/general.json)。

**双会话并发流式(r322 实钉,「一个会话一个进程」最纯验收)**:A 流式中起 B(新会话发第二条长任务)→ 两进程**真并发**(并行时点 A 的文件 assistant=0 = A 还在生成)——两会话各自收敛、视图互不含对方内容、终态零互串。探针要点:① 并行实锤 = 在 B 流式中读 A 的中立文件(assistant 仍 0 证明 A 未被打断);② 两条长任务都写「不要使用任何工具」(防模型调工具拉长时序);③ 收敛判据全走数据层(轮询两文件各自的 assistant 落盘),不赌视图流。

**流式中切换的断言口径(r321 实钉)**:① `sessions.onEvent` 是**视图流,只转激活会话**——切走后 A 的 agentSettled/messageEnd 永不进它(session-working-phase §2.2 的设计,不是丢事件);后台收敛判据必须走**数据层**(轮询中立层文件看 assistant 落盘)或 `onKernelEvent`(运维流,带 sessionKey 全转)。② 流式中切走的纯净断言三件套:壳态 0 行 + 无 A 的流式内容 + 无 A 的停止钮(执行态不跨会话污染);③ 切回视图恢复 + 终态落盘双验;④ 会话行定位兜底:needle 匹配不到时取**列表末行**(最近创建)——长 prompt 会话名可能被自动命名截成意外形状。

**设计稿审计法(minimal-kernel 实证)**:审计一份「加第三个内核」设计稿的可信度,三条腿——①**谓词漂移扫描**:grep 全仓 `=== "pi" || === "dsh"` 与 `Record<KernelId`,字面量谓词(不在 Record/switch 里,编译器不逼)就是漂移点,设计稿点名的三处逐一核对(实弹:isKernelId 与 resolveSessionKernel 兜底两处确修,工厂 create 分支是合法显式装配不改);②**编译器强制力实测**:临时给 KernelId 加第三个字面量跑 tsc——错误数=编译器逼补的槽位清单(实测 13 错/4 文件:assemble/kernel-logos/settings-page/web-kernel-logos),改完恢复并复跑归零,「漏补不过编译」从论断变实测;③**文档-代码逐主张核对**:14 条 abstract(数 AbstractBackend 正好 14)、写穿先于发事件(dispatch 里 writeThroughMessageEnd 在 listener 扇出前)、五 Record 槽位清单——设计稿每条代码级主张都在现码上验,不许「看起来对」。

**归档流与分组 DOM 口径(r320 实钉)**:① 归档右键菜单项文本 = **「归档」/「取消归档」**(同一项按 session.archived 翻转);置顶 = 「置顶」/「取消置顶」同款。② 归档后行移入 **「已归档」分组**(zh-CN 文案,**不是英文 "archived"**——body 搜英文恒 false 是探针错,搜本地化词);分组带「全部删除」批量钮;默认折叠 defaultOpen:false,但单行时可能展开——断言用「已归档」词 + 行在其下。③ 数据层:`updateHeader({archived:true})` 落中立层 header.archived(r320 已验),server list 立即反映——UI 旧态 = 缓存未刷,别误判产品 bug:先 window.kernel.sessions.list 对照再下结论。④ 侧栏 10 面板全开零报错(收藏/Tree/统计/请求记录/Review/盲审/IM/图钉/文件/工具逐开,console 计数 0)——面板巡检是 DOM 一致性的廉价全量哨兵。

**titlebar「收藏」钮是 toggle + 孤儿对账触发法(r319 实钉)**:① titlebar 的「收藏」钮(右上,x≈1242/y≈46)是 **aria-pressed 开关 toggle**——点一次关面板(组件卸载),再点重开(重挂载);它**不是**「打开面板」幂等钮。② 收藏插件的孤儿对账(bookmarks 目录无主快照回收)只跑在 **loadBookmarks 的挂载 useEffect**——触发 = 面板 tab 卸载再重挂(toggle 关→开),「+新会话」或切到别的面板 tab 都不重挂(侧栏页签的多开语义)。③ 手动添加表单:三个 placeholder 输入框(会话文件路径/entryId/收藏名称),校验失败两条文案都**显形在表单**且**不落盘**(§8.1)。

**探针工程坑:后台任务里的文件修改不落盘(r319 实钉)**:`run_in_background: true` 的 bash 里跑 python 改探针 .mjs——print 确认了、文件却**没变**(13675→写入丢失,下一次跑的还是旧版,浪费三轮)。教训:**改探针文件的 patch 一律前台跑**,后台只跑「执行 node 探针」本身;改完 grep -c 验证关键词在盘上(0 = patch 丢了)再跑。

**pickModel 的双形态 + /goal 命令的验证重试(r318 实钉)**:① 模型下拉**单内核形态无 TAB**(composer:多内核才有 TAB,单内核直接铺清单)——没装 dsh 三件的隔离 HOME 是单内核,pickModel 查 TAB 落空是形态不是 bug;先探 TAB 在不在,不在就直接选模型项。② /goal 的**键盘命令输入有偶发竞态**(焦点/输入法/命令弹层),敲完+Enter 后查 `[data-goal-phase]` 是否挂载,5s 未出即清空重敲(至多 3 次)——别赌一次输入一定触发(实测同脚本两次运行一次触发一次没触发)。

**组合场景的威力(r317 实钉,真 bug 猎场)**:「派生 × goal × 跨内核切换」这种**组合探针**是单功能探针探不到的 bug 的猎场——r317 靠它揪出 writeNeutralHeader 的 custom 整域赋值(goal 分片写抹掉 custom.model → 续跑「会话未启动」→ auto_pause 停摆)。方法论:组合探针失败时**先读会话头的 custom 全键**(不只读你关心的键)——键凭空消失=有调用方在做整域覆盖;再反查该键的所有写方。探针侧教训:① A 显式选 pi(装 dsh 后默认=dsh,别赌默认);② 长组合(≥4 次回合收敛)跑 **后台任务+日志文件**,bash 前台 10min 超时掐断 probe 收尾;③ 端口残留(kill 后未清)让下一次 assertPortFree 拒跑——起前 `lsof -ti :PORT | xargs kill -9`;④ (copy) 行定位:侧栏列宽会截掉后缀,兜底取「含前缀文本的最后一行」。

**删会话/快照自包含探针口径(r316 实钉)**:① 删会话入口 = 侧栏行**右键** → ContextMenu「删除」→ 整行内联确认(行内容被替换成确认条);确认按钮是 **Check 图标钮,title=「确认删除」(无文本)**——按 title 找,别 textContent;取消 = X 图标钮 title=「取消」。② 活会话不可删(deletable=false 右键菜单项直接不渲染)——先「+ 新会话」切壳再删;删除级联 = 中立层文件 + pi 文件 + 侧栏行全消失。③ 快照自包含断言:删源后 `<cwd>/.my-harness-desktop/bookmarks/` 快照仍在,resume 照常发起、新会话含全量快照内容——「源删了也能发起」的实弹验收法。

**整重启(崩溃安全)探针口径(r315 实钉)**:pendingSeed 是**会话头行字段**(中立层文件),不随进程消失——「派生 → killApp 整退 → 同 HOME 重新 launchApp → 冷启动首发」的断言序列:① 派生后 pi 文件不存在;② 重启后读盘 pendingSeed 仍 true;③ 冷启动侧栏点开 (copy) 行,前缀可见;④ 首发 → pi 文件出现且**前缀+新回合都在**(内容零丢失);⑤ pendingSeed 清除。launch/kill 两次要用同一 runRoot+HOME(killApp 后 sleep 3s + assertPortFree 再起,端口残留会静默起不来)。这是 §6.5「持久标记,崩溃重启后下次首发自动重试」的实弹验收法。

**派生链探针口径(r314 实钉)**:① 链式语义——A 分叉出 A' 再分叉出 A'' 时,A'' 的 `derivedFrom.source = A'`(记直接父,不是根 A),内容隔代全继承(A 原轮 + A' 新轮都在 A'' 前缀);名字 = forkCopyName 递归叠 **(copy) (copy)** 双层。② 分叉钮点击后 hover 淡入有时序竞态(回合刚收敛动作钮未及挂)——fork 点击包一层重试(至多 2 次,间隔 1.5s),比调大 sleep 便宜。③ 刷新持久断言:reload 后启动停新会话壳,主动点行再断言两轮 needle 同现(中立层单源,派生会话与普通会话同等待遇);④ 从派生会话一击收藏,快照自包含隔代内容(快照只看锚点前缀,不看 derivedFrom)。

**rewind 探针口径(r313 实钉)**:「回退」钮在 **user 行**(assistant 行没有——它只有复制/分叉/收藏/重试);点击 = 原位内联 Composer(`[data-rewind-inline]` 内的 textarea)且**预填原文**——写入用原生 setter + input 事件,提交点框内 aria-label^=发送 的钮。改写提交 = fork("before")+sendMessage:派生会话的 user 条目**只含改写文本**(原文被 before 排除);boundary = 原会话里锚点的**前一条**(首条前有 model divider 时是 :0,不是空串——空串只当锚点真是第一条);断言 boundary 用「源条目[userIdx-1]」现算,别写死空串。

**goal 探针口径(r312 实钉)**:① /goal 命令要**真实键盘**输入(`page.keyboard.type`+Enter,合成事件被 composer 拦截层吞);② 目标正文决定可达性——"数到 2"这类一轮可达的目标 kickoff 回合就 achieved,要测多轮续跑,目标文本得写"每轮报告计数,达到 N 才调用 achieve_goal"(模型一回合数完=单轮达成);③ maxRounds 缺省=1000(代码兜底 DEFAULT_MAX_GOAL_ROUNDS,goal.maxRounds 配置可覆盖)——别拿它当 bug;④ 「后台不自走」断言口径 = **round 冻结**(切走后 round 不再涨,phase 头行持久),goal 状态存在 header.custom.goal(会话头行),切回经 openSession 恢复+[data-goal-phase] 断言;⑤ goal 会话的侧栏名=自动命名取**目标正文开头**("每轮在回复末尾…"),切回行定位用这个,别拿 needle 词。

**「当前激活内核」= activeKernel 的语义(r311 实钉,易误解)**:resume(收藏发起)的目标内核缺省取 `activeKernel`——它是**全局最后一次 setModel 选定的内核**,openSession/setContext(切会话/点行)不改写它。想「在 dsh 下发起」必须先在 dsh 会话里**真发一条**(setModel 使 activeKernel=dsh),仅切视图不够;否则 resume 按残留内核派生(行为符合 §8.3 文档,不是 bug)。跨内核收藏发起的探针序列:pi 会话建收藏 → dsh 会话续发一条(激活)→ 面板点「点击 fork」→ 断言派生 header.kernel=dsh。

**dsh 派生会话的惰性物化断言(r311)**:forkFromSession 对 dsh 同路径(曾是 pi 扩展面,dsh 下显式降级抛错;unify §7.1 已收编中性面)。派生后 `~/.dsh/sessions/<桶>/<newNs>/session.jsonl` **不存在**(惰性,首发才物化);首发后文件出现且内容=前缀+新回合。dsh 会话文件路径:`<DSH_SESSION_ROOT>/sessions/<cwd 桶>/<lineageId>/session.jsonl`。

**收藏搜索/preview 语义(r310 实钉)**:面板搜索按 **label+preview** 匹配(不搜消息全文)。label 默认=会话名(自动命名),preview=被收藏 assistant 的回复文本;同一会话连续三条收藏的 label 全同名,搜索要按 label 前缀断言全量,按"未出现过的词"断言空态。

**[data-message-id] 只数带锚点的行——丢 id 的行在锚点查询里不存在(r309 踩过)**:服务端 openSession 曾漏 id 提升(已修 946fbd2e),无 message.id 的存量条目整行渲染但无 data-message-id——锚点计数比 div.group 少。断行数时「全行」用 div.group 数、「锚点行」用 [data-message-id] 数,二者不等 = 有行丢了锚点(真 bug);旧代码上跑探针,别把少行当视口陷阱。

**「+ 新会话」才是新建入口(r309 踩过)**:「新对话」占位行只在壳态渲染——已有活会话时侧栏根本没有这行,点它=无效点击,发送全落当前会话。新建会话点工具栏「+」钮(title 全等「新会话 (⌘N)」;includes 会先命中「刷新会话列表」,§3.1)。点完验壳态(消息行=0)再选模发送。

**默认模型随 dsh 配置漂移,别赌(r309 踩过)**:装了 dsh 三件后默认模型=dsh;隔离区没装 dsh 时默认=pi。多内核探针每站都显式选模(内核 TAB 在下拉底部,button 文本是小写 "pi"/"dsh,不是 DSH 大写页签);pi 侧选已验证的 qwen3.8(Glm 5.2 实测产生零条 assistant 的空回合——空回合照样 agentSettled?不,空回合无 agentSettled,用「等 agentSettled 事件」当收敛判据,别用「停止钮消失」(空回合不发停止钮,两阶段等待会假通过)。

**跨内核轮换的行定位(r303/r309 同坑扩展)**:fork 派生会话与源会话侧栏预览同文(前缀继承),按 needle 找行会撞——用派生名 "(copy)" 后缀区分;needle 用带句号的全文("ping sA。")防子串撞("ping sA" 也命中 "sAprime-two")。

**bus 乒乓污染探针(r307 踩过,非产品 bug)**:基础回合若发"ping alpha"这类开放 prompt,模型会读 bus skill 文档(chatroom-collab/delegate-task)并自发 `channel_member` 进 channel;fork/重试产生第二个会话后,两会话在房间互发 `[bus chat]` 帧、每帧触发对方新回合,乒乓到 `bus_throttled`(20 条/分钟令牌桶熔断)——settle 永不收敛、双方会话被注入帧刷爆。这是 session-bus.md §3.4 Q6 文档化的双保险场景(防回声 looksLikeBusFrame + 节流熔断,行为符合设计),不是 fork 的 bug。探针避法:基础回合用明确指令「不要使用任何工具/不要加入任何 channel,只回一个词」;断言别数文本出现次数(模型回复会回显 prompt 文本)。

## 6 诊断现场留存(失败时可复现)

- 每步关键截图:`page.screenshot({ path })`;失败时再补一张现场
- console/pageerror 全程收集,末尾断言「零报错」并把首条打进失败信息
- `window.__neutralLog`(渲染端插桩 `window.kernel.sessions.onNeutralChange`)对账写穿回执
- 事件流插桩 `window.kernel.sessions.onEvent` 记 type 序列(定位「思考中永挂」类)

## 7 修复纪律速查(CLAUDE.md 摘录的实操形)

1. 根因修复必须带守卫:纯逻辑补单测、配置/清单补静态守卫、链路补 e2e——没有守卫的修复下次重构就回潮。
2. 「build 通过」不算运行时验证;UI/链路改动必须附真实运行证据(本文的路径)。
3. e2e 脚本本身也是代码:选择器锚错、收敛竞态、虚拟化盲区都会让绿变假绿——断言前先问「这个文本此刻真在 DOM 吗」。
4. 修插件先想槽位:manifest `component` 名必须在 renderer 入口 exports 里(自动匹配),漏了就是静默缺席——守卫:`src/plugins/manifest-exports.test.ts`。
