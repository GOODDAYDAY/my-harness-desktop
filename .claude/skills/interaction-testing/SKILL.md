---
name: interaction-testing
description: 在 my-harness-desktop 做真实交互验证(DOM 级/E2E)时使用。覆盖拉起应用、隔离 HOME、CDP 驱动、DOM 锚点清单、虚拟化/时序陷阱、数据层 vs 渲染层断言分工、双内核差异。触发词:交互测试、e2e、DOM 断言、CDP、puppeteer、冒烟、真实模型、会话流验证、写 e2e。
---

# 交互测试(my-harness-desktop)

本仓库的功能验证纪律是三级(CLAUDE.md §5.6):纯逻辑单测(vitest node)→ DOM 交互测试(vitest+jsdom)→ 真实 app e2e(puppeteer-core + CDP 驱动 `out/` 构建产物)。本文是第三级(真实交互)的实操手册——每一条都来自实踩过的坑,不是通用 puppeteer 常识。

## 0 索引(按主题速查;条目按轮号 rXXX 编号)

**基础设施与拉起**:§1 基础设施(lastCwd/端口/dsh 三件/seed)| 官方 e2e 矩阵(r326)
**探针通用纪律**:数据/渲染分层断言 | 写穿感知等待 | settle 清缓冲 | 官方 e2e 矩阵
**会话回合生命周期**:多行输入(r339)排队(r331)流式中切换(r321/r322)中断×续跑(r354)重试(r307/r363)回退(r313)
**分叉×收藏(goal §7)**:fork=新会话(r305)入口三分叉+位置两态(r307/r308/r340)收藏 CRUD(r310)删源自包含(r316)跨内核发起(r311)收藏→分叉全链(r340)rewind(r313)resume(r306)
**派生×pendingSeed**:派生链(r314)崩溃重启(r315)嵌套场景(r373)行内分叉两段式(r373)
**多会话切换(goal §9)**:轮换(r309)goal×切换(r312)组合(r317)双并发(r322)跨内核守门(r330)双项目×跨内核(r334)
**sub-agent 派活**:单发(r325)批量并发(r358)
**DOM×文件对账**:一致性对账法(r327)动作齐性(r341)草稿契约(r349/r350)
**行操作/列表**:搜索(r343)重命名(r346)置顶×归档(r347)列表损坏韧性(r368-r370)
**壳机制**:设置双臂(r323/r324)工具限制(r328/r329)语言切换(r344/r345)快捷键(r356)titlebar(r357)右面板(r352/r353)斜杠命令(r365)数据 tab(r366)统计槽(r351)
**韧性与损坏域**:损坏模型域(r367)文件损坏(r368)灾难隔离(r370/r371)姊妹口纪律(r371)
**架构守卫**:依赖方向审计(r342,audit:deps)| 测试文件 tsc 债(r335)
**套件稳定性**:ws-server 闪红根治(r355)瞬态重跑分类(r359/r372)
**大回归节奏**:r332/r348/r359/r364/r372(每批修复后官方矩阵全跑)
**能力面×思考域(2026-09-07 轮)**:思考矩阵四幕 e2e(kernel-thinking-matrix)|能力面推送流水插桩(__capsLog)|模型项双禁用态(menuitem aria-disabled/inert div)|空思考帧 wire 级实证|dsh 思考档位补面验证(幕D)|新会话跨内核解锁(幕C)

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
| `[data-sidepanel-style]` | 右侧面板(**有两个**:图标条 w-12 + 展开面板 h-full,DOM 序展开面板在前且空)——取页签按钮必须用后代选择器 `[data-sidepanel-style] button[aria-label]`(单元素 querySelector 命中空面板得 0 页签,2026-09-08 踩过) |
| `button[title="分支概览"]` | Tree 面板的 lineage 概览开关(**被 `nodes.length>0` 内核树门禁**——seed-only 会话无运行内核 → 空态 → 按钮不渲染;概览 UI 断言要真内核会话,投影纯逻辑走 getTree 单测 f37045eb) |

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

**大回归里程碑(r348,48 轮)**:官方六套(pi×5 + dsh)在终态 build 69/69 全绿 + 单测 989 + tsc 0 + deps-audit 0 + 修复面探针抽检(r328 toolConfig 8/8)。**r317 抽检发现的探针侧坑(已由 r349 定论)**:产品**发送后清稿**(原生 setter 与真键盘两路径均 value=""),但**键盘输入是追加**且**会话切换有按会话的草稿恢复**——探针在两次输入间切过会话时,残稿被草稿恢复带回来,第二轮键盘输入拼进残稿,前缀污染把 /goal 命令变成普通消息(斜杠命令须独占消息开头)。**清稿纪律**:每次输入前**原生 setter 置空**(唯一可靠清稿;真键盘 type 不清残稿);抽检见「X 没生效」先 dump user 条目全文看**拼接痕迹**——前缀污染 = 探针没清稿,不是产品退化。

**置顶×归档口径(r347 实钉,核心面全绿)**:① 置顶 = 右键「置顶」→ 行重排到顶 + **`header.pinned=true` 落中立层**;② 归档 = 右键「归档」→ **`header.archived=true`** + A 进「已归档」分组(行不消失——是**分组**不是隐藏;活跃列表断言要按分组上下文筛,别数全 DOM);③ **pinned/archived 是 NeutralSession 顶层字段**(session-neutral.ts §保留键注释:「保留键 pinned/archived/toolConfig 平铺顶层,插件域不得占用」)——断言读 `header.pinned`,**不是** `header.custom.pinned`(HeaderPatch 的注释文案是历史写法,schema 单源在顶层;探针读错位会得 custom={} 的假象);④ custom 域在置顶/归档后完整幸存(model 还在)——键互不干扰;⑤ 取消归档菜单项 =「取消归档」(sessions.unarchive),归档分组的行同样右键可达。

**dsh 侧回合生命周期 + 「继续」钮疑点(r360 实钉,12/12;疑点在档为下轮专攻)**:① **dsh 多轮上下文连续**实锤(轮 2 答出轮 1 记的词「琥珀」,数据层 assistant 块含原文);② dsh 流式中断正常(停止钮工作、停止钮消);③ **疑点已结案(r361 抓到第 9 号产品 bug 并修复,1c042df7)**:链路追踪法(逐层层✓/✗定位)——翻译✓→落盘✓(三次实锤 stopped=True)→投影✓(残留会话实跑 neutralMessagesOfSession 携带 stopped)→渲染行✓(「已停止」提示显=message.stopped 到位)→**动作区✗(rowText 空门禁)**:`{rowText && <MessageActions/>}` 把空正文行的整组动作摘掉——dsh 空缓冲中断落空内容行,「继续」(唯一恢复入口)永不出现。pi 面常带部分内容踩不中——**跨内核各面各验纪律的第 2 次抓捕**。修法:终结态(stopped/error)无正文也渲染动作区。**链路追踪法**:数据层逐层验(翻译→落盘→投影→渲染行→动作区),每层用最小实验定✓/✗,断点在最后一米;诊断探针的要点是**dump 中间层**(`window.kernel.sessions.snapshot()` 渲染端快照、「已停止」提示文案 = message.stopped 到位的活证据)。

**会话文件结构损坏的壳韧性(r368 实钉,启动安全面)**:① 两形态(结构坏 lineages=null / JSON 截断 40%)**重启都不炸启动**(零 pageerror)——启动对账线(KernelReconcile)是韧性主力;② **形态A 有自愈实锤**:注入 null 后重启,A 的 lineages 被重建为数组且原内容保留——启动对账**修复了**损坏文件(不是简单跳过);③ **候选十一已修(a9c7997b,r370 三轮钉死)**:根因 = listByCwd 的 try 只包 JSON.parse,**合法 JSON 但形状坏**(lineages=null)滑过守卫落进 result → neutralToSessionInfo 的 lineages.find 炸 map → **整个列表空**(健康邻居消失)。修法:形状校验进同一 try(Array.isArray + ns string),坏形状与坏 JSON 同等跳过+记日志。实弹:修复前 0 行 → 修复后 2 行,B 全功能恢复。**探针侧纪律**:列表行 needle 用截断安全短形(行显示截断 22 字符+…,全长 needle 永远失配);**损坏类修复的验证要点**:断言「坏文件跳过 + 健康邻居健在」两头。④ 探针纪律:损坏注入后重启会触发**对账自愈**——想验证「损坏持续存在的行为」要用**不重启**的路径,或预期自愈后形态。

**三会话跨内核长任务并发(r376 实钉,15/15 一次全绿——goal §9 最重形态)**:两 pi + 一 dsh **三进程同时在飞**(并行实锤:三会话 assistant 全 0 的时刻采样)→ 各自收敛(数据层轮询 420s 窗)→ 内容零互串(三对泄漏检查全 0)→ 内核归属各正(A/B=pi,C=dsh)→ A→B→C 轮转打开各恢复。**与 r322(双 pi 并发)合成,「一个会话一个进程」的最重压力形态闭环**:三路并发下写穿/隔离/视图各不相扰。探针要点:① 并行采样时刻的 assistant 全 0 是并行的活证据(生成都在飞);② 收敛用数据层轮询(事件面在多会话下会互相污染);③ 轮转打开的行数断言(每会话都有内容)。

**sub-agent 面板×中止(r374/r375 两轮,中止面留手工)**:① **面板挂载真相(双源)**:sub-agent 插件贡献 **sidePanel「子 Agent」(order 60,panel 标签钮确实在右栏)** + sidebar 区「子 Agent」(order 20)——r352 的 tab census 是**探针取数不全**(title 匹配漏了它),不是产品没挂;② 中止钮只在工人**运行中**显形——r374 慢任务仍赶不上(r375 2000 字任务 50s 窗口内中止钮仍未见:面板未被探针点开,worker 的 subagent 域状态也未写回);**中止面收口为手工形态**——需要 panel 先开 + 真慢 worker + 即点,探针的三重时序成本高于收益,单元面已由 orchestrator 测试覆盖;③ worker 的任务文本正确落盘(2000 字分析任务的 user 条目在),派活链本身绿。

**行内分叉的两段式 arm-confirm(r373 实钉,三轮揪出)**:行内「分叉」钮与重试同款 **useArmConfirm 两段式**——首点 arm(title 变「确认分叉?」),二点才执行 `forkFromSession`;**一次点击只进确认态,fork RPC 永不发出,派生会话永不出现**(且无任何报错——纯静默,最易误判「fork 坏了」)。探针口径:① 点后查 title 变化(r→确认态)再二击;② **fork 派生要数据感知等**(异步 RPC + 重投影,轮询 derivedFrom 出现);③ 点前先 sync(r363 id-域口径)。**已验证面(全绿收官 10/10)**:两段式 fork → A' 派生(pendingSeed=true)→ 重启 → 打开 A' → 首发 → **物化完成**(pendingSeed 清除 + 派生前缀保持 + 源会话 A 零牵连)——§6.5 的完整生命周期在「fork 自身产生 pendingSeed」的嵌套场景下闭环。fork copy 行名 = 源名+「 (copy)」——重开 A' 的行 needle 用 copy。深度链(A'' 再派生的进程面)由 r314/r315 覆盖,不重复。

**姊妹口修复后的官方回归(r372,12 修复终态)**:goal-command 25/25 + message-actions 3/3 + single-source 11/11 + dsh-session 11/11(首跑 step5 等待超时 = dsh 冷启动 + 15s 窗口的端点瞬态,**重跑即分**——r359 定性序第三次适用:先查数据层/事件面,再定性,别急着归罪新改动)。形状守卫(两读口)对正常会话零影响(守卫只收窄坏形状)——修窄面不改宽面,回归重心放在**受影响读口的下游**(列表/打开/树投影)。**回归节奏**:每「姊妹口批量修复」后,官方矩阵抽受影响面 + 重跑法分类瞬态。

**形状守卫的双口堵漏纪律(r371,候选十一第二半)**:修了列表读口(listByCwd)后,**扫同一条数据的所有读口**——get() 的 9 个调用方(openSession/写穿/树投影/seed 判定)同样信任返回值,姊妹口不补,同一坏文件换个路径还能炸。**纪律:根因修复后必扫姊妹口**(同一数据的全部读口,同一守卫逐口补);守卫措辞与第一口一字不差(可复制性)。**tsc 教训**:doc 注释里写「/**」会把注释提前闭合(48 个语法错)——注释里别用嵌套 /**;**测试教训**:store 构造不建目录(put 才 mkdir)——测试直接 writeFileSync 前要 mkdirSync。

**损坏 custom.model 的运行时容错(r367 实钉,10/10)**:① 注入损坏(provider=123 类型错)→ 重启**壳不炸**、会话照常打开、时间线内容在;② 发送 → **显式失败 toast「会话未启动，请先选择模型」**(§7.6 正确形态:损坏域拒发 + 明确提示,非静默卡死);③ 消息**不该落盘**(损坏域下拒发是契约,不是壳失韧);④ custom.model 保持损坏原样(不静默覆写——修复要用户显式重选模型)。**单元面配套**:parseSessionModelPrefs 的四种损坏形态(半写字符串/数字/null/数组、缺字段、字段类型错、kernel 坏)全部安全落 null 或降级 kernel,不抛错——会话列表/发送链全依赖它,炸面必须为零。**探针纪律**:损坏注入探针要先想清「正确行为是什么」再断言——初版断言「发送仍落盘」把正确的拒发判成 FAIL,契约反转后才见全绿。

**右面板数据 tab 三联(r366 实钉,8/8)**:① 「统计」视图 = token-stats 卡片全文形态(「本会话输入0输出0缓存读0缓存写0…TPS—完成轮次0步数0」——零轮次空态;有轮次后数字翻新);② 「请求记录」空态或列表;③ 「IM」tab = 会话图(GraphCanvas,42 个 SVG 元素);④ **多 tab 开启下的视图断言口径**:右侧面板区按 x>60% 宽 + width>150 过滤——但**所有已开 tab 的内容都在 DOM**(toggle 多开,r353 口径),断言要按「目标 tab 的特征文本」判(SVG 计数/统计卡文本),**别按面板区整体文本**——书签 tab 的「暂无收藏」在收集文本里混进来了(收集区样本里可见)。⑤ 探针自身纪律:模板字符串尾部多余右括号(node --check 秒捕,先 check 后跑)。

**斜杠命令面板(r365 实钉,5/5)**:① 输入 `/` 后命令可发现(/goal 名+描述在界面可见——不是 Radix 浮层,是**内联提示区**形态,overlays=0 但 body 可见——断言按 body 文本判,别赌浮层选择器);② 前缀过滤生效(/goa → /goal 可见);③ 未知 `/xxx` **照发普通消息**(composer-commands 不命中 → 放行契约,数据层断言落盘);④ 命令命中即吞(contracts:send 改写/goal 的目标正文作为真实消息发——goal-command 官方 25 断言已覆盖);⑤ Esc 关。

**空停止行重试的 id-域坑(r363 实钉,8/8)**:① 事件态行带**流式 buf id**(dsh 翻译器 stopped 帧的 id),快照投影后行 id 换**neutralEntryId 域**——RetryAction 按 `snapshot.messages.findIndex(m => m.id === message.id)` 查,拿事件态行去查投影域快照会**静默 idx<0 返回**(连 toast 都没有)。探针纪律:**点行级动作前先 `window.kernel.sessions.sync()` 等再水合**(行的 id 域换轨后 findIndex 才命中);真实用户的手速天然慢于再水合,产品语义在用户时间尺度上成立。② **入档的 UX 缺口(候选十,已修 671c6731)**:重试的 `idx < 0` 分支原是纯静默 return(点钮像死了)——已改弹「消息不在当前快照中,请稍候再点一次」toast(四语言包同步 + 守卫测试)。§7.6 不静默原则的收口:静默分支都要有显形出口,哪怕只是「再试一次」提示。③ 重试链在空行完整成立:arm-confirm → fork(before)+原 user 重发 → 派生会话 derivedFrom.kind=fork + 重发回合完成 + 源会话零动。

**空停止行的动作区完备面(r362 实钉,r361 修复的旁路验证)**:修复后空停止行渲染**全五项动作**(分叉/收藏/钉图钉/继续/重试)——门禁打开后整个 messageActions 槽位恢复,不止「继续」。**「复制」不显是复制组件自身的空正文门禁**(复制空文本无意义,行为合理);钉图钉/收藏/分叉照常(它们不依赖正文)。③ 的续跑闭环:**数据层三件套即活证据**——`继续未完成的工作` user 条目 + 新 assistant 内容条目 + 原 user 保留;agentSettled 的 WS 事件面在 dsh 慢端点下可能迟到,**续跑收敛断言以数据层为准**(r327 纪律的又一实例)。error 行的等价面已由守卫五态测试覆盖(empty-stopped-actions)。

**第四次大回归 checkpoint(r364,65 轮;10-fix build)**:官方六套 69/69 全绿 + 两个生命周期探针 (r354 pi 11/11 + r360 dsh 12/12) 在十修复终态 build 复检全绿。**回归节奏**:每批修复落地即全量回归(本轮的 retry-toast/empty-row-actions/ws-flake 三修都在上检之后)——修复互不踩;10 修复 + 哨兵 + 守卫的终态在官方口径与自写探针双面稳态。

**第三次大回归 checkpoint(r359,59 轮)**:官方六套 69/69 全绿(终态 build)+ r305 fork 抽检 22/23(唯一 FAIL = r348 已定性的视口假阴)。**探针超时的定性序**:先看**数据层**(会话文件的 user/assistant 计数)——user 在 assistant 空 = 回合未完成 = 模型端点瞬态(空回合是已知环境形态,r305 首跑超时即此),重跑即分;别把端点瞬态误定性为产品回归。**大回归纪律执行记录**:59 轮时官方矩阵 + 抽检全绿,与 r332/r348 的前两次 checkpoint 构成「每 ~10 轮回归一次」的节奏。

**批量派活并发(r358 实钉,8/8)**:① 派活指令的**工具名与限定坑(二钉确认)**:工具面叫 **session_create**——写 spawn_subagent 模型会诚实答「没有这个工具」拒绝执行(好行为);**别加「禁止使用其它工具」**——派活本身就要用 session_create,自相矛盾的限定把它也禁掉(模型会卡死在确认);② 批量 = tasks 数组一次 spawn,三工人**并行起**(各一个进程)→ 各自完成(数据层各 1 assistant)→ **done 帧逐个回主会话**(user 总数 = 指令 1 + done 3);③ 隔离断言排除指令自身(指令引了任务文本;排除词=工具名「session_create」);④ 并行实锤口径:三个工人会话同时在存(轮询 listSessions 到 3),完成判据各自 assistant(数据层,别赌视图)。

**titlebar 槽位与 ⌘B/⌘J(r357 实钉)**:① titlebar 按钮三核心(顶栏 60px 带):「切换左栏 (⌘B)」「切换右侧面板 (⌘J)」+「Debug: 元素审查模式」;⌘B/⌘J 是 shell 内建 toggle(不在 DEFAULT_BINDINGS,keybindings 插件的可配置表之外);② **⌘B 折叠是渐变/带过渡**——断言别写「宽=0」,写**往返恢复**(两翻后宽度回原值即 toggle 契约成立;折叠中间态宽 ~190 可能是动画或 icon-rail);③ 侧栏宽断言的取法:找含「新对话/项目」文本且 50-400px 宽的最大容器(左栏区域);④ titlebar 逐钮点(除重启/删除类)无崩溃 = 钮面健康;⑤ Debug 审查模式钮(title=「Debug: 元素审查模式…」)是 dev 侧 titlebar 贡献(⌥ 面板类)。

**快捷键绑定实弹口径(r356 实钉,7/7)**:① CDP 组合键三段式:keyboard.down(修饰们)+press(键)+up(逆序)——mod 在 mac = Meta;② 默认三核心:⇧⌘S=shell:openSettings / ⇧⌘C=shell:backToChat / ⌘K=timeline:focusComposer(断言 activeElement 是 composer 的 data 锚点);③ ⇧⌘]/⇧⌘[ 模型循环、⌥⌘]/[ 思考循环(Vim unimpaired 语义:shift 管模型 alt 管深度)——**循环后徽标不变是正常的**(composerApplyTiming=onSend 时 pending 在内存,发送才透传 setModel;别拿徽标断言循环);④ 快捷键设置页 = 绑定清单渲染(combo + channel 可读描述,channelMeta 导出供列表);⑤ 绑定实现在 keybindings 插件 core(bindings.ts DEFAULT_BINDINGS 单源,可配置覆盖)。

**套件闪红的修法(r355 实钉,ws-server 4/6 失败→10/10 绿)**:套件偶发闪红(1/8 轮)先**isolated 复现**(单文件连跑测闪红率),再按形态定根因:① **server.close() 只停监听不等连接排空**——残留 ws 跨用例存活,吃到下个用例的广播(收到别人的消息 = teardown 不彻底的铁证);② connect/nextMessage 无限时,事件循环饿死时挂到 20s 测试超时;③ 挂起连接把 afterEach 钩子拖过 10s。修法四件:**teardown 先硬断客户端**(attachWsServer 的 closeAllClients = terminate 免握手等待)再关 server;connect 加上限+一次重试;nextMessage 加上限+close 即拒;钩子显式 timeout。**纪律:任何等待型测试原语(connect/waitFor/nextMessage)都要有上限**,无上限 = 把瞬时饿死变成 20s 超时,污染整轮 CI 信号。

**中断×续跑全链(r354 实钉,11/11 一次全绿)**:① 流式中点「停止生成」→ 回合终(停止钮消失);② 数据层:部分 assistant **已落盘**(中断不丢内容,stopped=true 踪迹在末条);③ **「继续」钮显形**(stopped 态 assistant 行的 continue 插件入口——与 error 态共用渲染条件);④ 点「继续」= prompt 发通用续跑文案 → **原位续跑收敛**(goal.md §3.2:续跑就是发消息,不 fork 不重发);⑤ 断言口径:续跑后 user 数 +1(「继续未完成的工作」作为新 user 消息落盘)。

**右面板布局面(r352 实钉)**:① tab 全集 13 个(语音输入/手动添加/收藏/Review/盲审/工具/文件/IM/Tree/统计/请求记录/表情包/图钉);② prefs 键形态:`activeSidePanelTabs`(数组)+`rightPanelOpen`+`sidePanelOrder`+`sidepanelStyle/FontScale`(布局态全家);③ 面板默认开;开合状态**刷新后恢复**(layout store 从 prefs hydrate);④ **Tab 语义 = toggle 多开**(r353 结案):`activeSidePanelTabs` 是「组内已开 tab 的数组」,点 tab = 开/关翻转(再点同 tab = 关掉);**revealOn 走 activateSidePanelTab(幂等补入,不反向关)**——收藏动作后收藏 tab 必然在数组里,人手再点可能是关!断言口径:① 数组包含(不等于)即激活;② 点击后的期望要按 toggle 算(初态有 bookmarks,点 tools → [bookmarks,tools];再点 bookmarks → [tools]);③ 真相源读 prefs,异步落键要等;别赌空态文案。

**composerStats 槽与思考档位(r351 实钉)**:① **上下文占用条形态** = composer 区「{模型名}{档位}{百分比}」(实弹:「Qwen3.8 Max (Free)高1%」——token-stats 槽把模型+思考档+上下文占用三态一屏渲染;断言查 `\d+%` 正则即活证据);② **thinkingLevel 落 header.custom.model**(与 provider/modelId/kernel 同域——档位是模型偏好的一部分,非独立键);③ 档位的显示态是中文单字(高/off 等档名在 composer 区常驻),选档 UI 在模型下拉的 pi 页签内(levels 行——r324 口径);默认档来自 settings.defaultThinkingLevel(设置域)。

**按会话草稿恢复(r350 实钉,10/10)**:草稿按会话键保留——A 留「草稿AAA」→ 切壳(壳 composer 空)→ 留「草稿BBB」→ 回 A:恢复 AAA;回壳:恢复 BBB;两草稿互不串。**r349 之谜的正面闭环**:残稿正是这个特性带回来的(切会话恢复),产品契约成立;探针纪律随之完备:**输入前原生 setter 置空**(防恢复的残稿吃掉斜杠命令前缀)。壳(新会话态)的草稿键 = `new:${cwd}`(与 pendingQueue/sessionModelPending 同款键形态)。

**会话重命名口径(r346 实钉,10/10;r12 补 e2e 守卫 34768798)**:① 入口 = 侧栏行**右键菜单**(项:重命名/置顶/归档/打开 Desktop 会话文件/打开内核会话文件——右键五项是行操作的完整面);② 点重命名 → 行内 INPUT 编辑器(带旧名聚焦);③ 清旧值用**原生 setter**(CDP 的组合键命名不稳:Control+a/Meta+a 双双 Unknown key——受控 input 全场景原生 setter 是通用解);④ Enter 确认 → 列表行即显新名 + **header.name 落中立层**(单轨写名的真相源)+ 刷新重开后仍在(5s 内写穿完成);⑤ 断言读 `header.name`(不是列表文本——列表可能延迟)。**r12 补两点**:⑥ Radix ContextMenu.Item 的 `onSelect` 要用**可信点击**(取菜单项坐标 `page.mouse.click`,合成 dispatchEvent 不保证触发——与 DropdownMenu menuitem 同坑);⑦ **编辑态行是另一个 div、不带 `data-session-path`**(与正常行逐像素同构但属性不同)——rename input 按 `value===旧名` 找,别按 `[data-session-path] input` 后代选择器(会扑空)。

**语言切换口径(r344 实钉,②③ 面 8/11;④ 往返留憾)**:① 语言页四选项(ListItem 网格,当前项有实心圆点;页脚显 currentLocale);点击 = setCurrentLocale **直写**(实时生效,无「确定改动」浮层,saveMode=manual 的语言项走 prefs 直写);② 切 English 全 UI 立换(New chat/General/Theme/Skills/…中文全退)——「实时生效」契约实证;③ **prefs 键名 = `currentLocale`**(ui-store PREF_KEYS,不是 `locale`)——落盘断言读对键;④ 探针锚点必须 **locale-aware**(设置/Settings、语言/Language 双语认)——切完英文后中文锚点全扑空;语言名是**原生名**(简体中文/English 在任何 locale 下不变,可跨语言点)。**留憾已结案(r345 一次点击闭环法,11/11 全绿)**:往返用「**原地点击**」——语言页打开后不重新导航,重查-点-复核一个闭环(点前同 evaluate 重查坐标 → 真鼠标点 → 立读页脚 currentLocale);r344 的失败根因是探针的重导航(设置→语言再走一遍),非产品缺陷。**页脚 locale id 是语言页就位与点击生效的双面哨兵**(挂载完成 + 点击生效一次读出);二次往返全绿证稳定性。教训:**切换类探针的「往回切」要在原地进行**——重新导航会引入全新一批时序变量,把简单事搅成疑难杂症。

**会话搜索探针口径(r343 实钉,12/12)**:① 搜索 input **默认隐藏**——入口是「会话」区标题的搜索图标钮(aria-label=「搜索会话」),点开才有 placeholder=「搜索会话」的 input;② 该图标钮是 **toggle**——探针复用 typeSearch 别每轮再点(会把搜索框点折叠回去,清空 query 视觉残留 = 过滤态假锁死);③ 清空 query 用原生 setter + input 事件(受控 input 的可靠路径);④ 匹配大小写敏感(D9 注释:设计如此,name/created/id/ns 四键任一命中);⑤ 过滤是纯 UI 面(会话文件零影响——数据层计数对照)。顺带:列表行显示的是**会话首条 user 文本**(未命名/自动名形态),needle 要打在消息文本上别赌会话名。

**依赖方向审计守卫(r342,npm run audit:deps 入仓)**:CLAUDE.md §6.3「CI 可自动化」的落地——`scripts/dependency-audit.mjs` 六检验(圆心零外部 import/application 不 import 内核实现/kernel-core 不碰具体内核/plugins 只认 shared+react/KernelId 字面量单源/会话链路零身份分支),269 文件实跑 0 违规,exit 1/0 可进 CI。**明文例外机制**:neutral-migration.ts 是 session-single-source.md §4.3 授权的离线迁移例外——「例外写在明处,禁令才守得住」(文档原句);审计脚本的豁免表引用文档条款,不悄悄放行。写架构守卫的纪律:先读文档例外、再写豁免规则、豁免注释引文档节号。

**消息行动作齐性对账(r341 实钉,14/14)**:逐行型 hover 收集动作钮 title 集,断言行型齐性 + DOM⊆声明集。**行型动作矩阵**(实测):user=复制+钉图钉+回退;assistant=复制+分叉+收藏+钉图钉+重试(+异常停机态的「继续」);divider=只 meta 徽标(模型→/思考已完成/会话重命名——非动作,按行型豁免)。**声明集要逐插件审计**(timeline=复制+回退/timeline.rewind;bookmarks=收藏+分叉;retry=重试+确认重试?;continue=继续;colors=钉图钉+拔图钉)——想当然写清单必漏(本例初版清单漏了回退/钉图钉/meta,三处误报)。对账法:DOM 出现的 title 全集过滤 meta 正则后,断言差集为空。

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

## 6.2 e2e-inmem 修复记录(Vite `__vitePreload` 相对 import 在 Node-ESM 混合桥挂起 → 直测预加载全 chunk,已修 87b072d5)

**根因(bisect 实锤)**:`index.tsx`/`plugins-host` 的动态 `import("./x.js")` 被 Vite 编译成 `__vitePreload(() => import("./x.js").then(n => n.xx), deps, import.meta.url)`——该包装的**相对 import 在 Node-ESM+jsdom 混合桥下不完成**(app-main/插件 renderer 模块体 60s 不执行;定界手段:模块体顶部写 `globalThis.__appMainLoaded=true`,e2e-inmem 直测 import 同一 chunk 前后各读一次——「直测前未置位、直测后置位」= 动态 import 挂起而非模块体报错)。

**修法(87b072d5)**:入口 bundle import 后,直测 `import(pathToFileURL(...))` **全部 151 个 renderer chunk**(Promise.allSettled),让各模块体照跑,后续 `__vitePreload` 的相对 import 命中 ESM 缓存。效果:黑屏全灭 → 151 chunk 零失败、#root/composer/sidebar/sidepanel 皆渲染、页签可点、ping 提交。

**遗留 2 项失败(非阻塞)**:① ping 模型回复——沙箱禁外网,尽力而为项必然失败;② 草稿切会话恢复(`newChatEmpty=false`/`restoredA=false`)——jsdom 下草稿 store 隔离时序(固定 sleep 不足),待查;真 app 草稿隔离是 renderer 面,可补 CDP e2e 验证。

## 6.1 能力面×思考域矩阵(2026-09-07 轮;scripts/demo/kernel-thinking-matrix.e2e.mjs 四幕)

**思考矩阵四幕(本轮新增官方 e2e,16 断言)**:幕A pi+能思考模型(网关实发 thinking_delta)→思考块展开有正文;幕B pi+空帧模型(Qwen3.8 Max)→「无思考内容」静态提示、无死展开钮;幕C pi 会话在时开新会话→切 dsh 模型→发送出回复(跨内核解锁);幕D dsh 会话思考档位下拉(关/低/中/高)→切档后「思考强度 → low」分隔线落会话流。基线拨 `defaultThinkingLevel:"high"`(setupBaseline 默认种 "off" 演示省 token——验思考必须先拨高,off 会让 pi 不发思考,幕A 假阴性)。

**能力面推送流水插桩(定位能力面滞留的探针法)**:拉起后立即 `window.kernel.sessions.onKernelEvent((e)=>{ if(e?.kind==="capabilitiesChanged") (window).__capsLog.push(e.capabilities) })`,任意时刻读 `__capsLog` 拿**渲染层实际收到过的全部能力面快照序列**——与主侧 `window.kernel.sessions.getCapabilities()`(IPC 直读真相)两端对账:流水末条 ≠ 主侧现值 = 推送缺口(哪个转变点漏广播,转变点清单见 session-store broadcastCapabilities 注释)。实弹:修前流水末条 `{pi,locked:true}` 而主侧(新会话)`{null,false}` → setContext 漏广播坐实。

**模型项的双禁用态(选模型断言必查两样)**:① 隐藏内核清单是 **inert div**(非 active TAB 的内核清单 `visibility:hidden+pointerEvents:none`,**不占 [role=menuitem] 角色**)——menuitem 只含当前 TAB 的项;② 锁内核时可见项也挂 `aria-disabled="true"`(Radix disabled,点了 onSelect 不触发)。pickModel 断言必须同时查 `getBoundingClientRect().width>0 && aria-disabled!=="true"`,只查文本存在会「找到但点了没反应」(实测浪费一轮)。内核 TAB 置灰读 `disabled` + `title`(锁定文案 shell.kernelLocked)。

**空思考帧的 wire 级实证法(「思考内容为空」类投诉的定界)**:先 curl 原始 provider 流(`anthropic-messages` 路径直接 POST /v1/messages 带 thinking 参数,openai 路径查 `reasoning_content`)——**网关只回 content_block_start 空 thinking 帧、零 thinking_delta** = 供应商行为,pi 落盘 `thinking:""` 忠实记录,desktop 管线无截断(pi JSONL 与中立层同空)。定界完成才谈 UI:空正文配可点展开器=「点开有东西」的假装,显式降级静态提示。同网关换上游模型(glm-5.2)实发 delta——「部分模型空帧」是每上游模型行为,不是系统性缺思考。

**「同模型 pi 无思考、dsh 有」的逐层打穿法(2026-09-08 实锤真凶=网关错标块型)**:这类跨内核差异投诉要**逐段排除**,别先怪内核:① 裸 curl 网关(带 pi 的精确请求形状——thinking 参数 + anthropic-beta 头)——看 `content_block_start` 的 `content_block.type`;**网关把思考块开成 `type:"text"` 却往里流 `thinking_delta` = 违 Anthropic 规范**(thinking_delta 必须进 thinking 块),pi-ai 按规范丢弃块型不匹配的 delta → pi 落盘无思考。② 本地透明代理抓 pi 真实请求(pi 发没发 thinking 参数/头)→ 排除「pi 不发思考」的误判:实测 pi 发了 `thinking:{type:"enabled",budget_tokens:16384}` + `anthropic-beta: interleaved-thinking`,请求侧无责。③ 同模型换 openai-completions 路径条目:网关发干净的 `reasoning_content` → pi-ai 正常捕获(pi headless 实测 320 字思考块)。④ 对照组:同一网关 glm-5.2 正确开 `thinking` 块(桌面有思考)——**逐模型错标,不是系统性缺思考**。结论落点:网关(bifrost ai-router)逐模型 bug,桌面/pi 无可修点(pi-ai 按规范丢错标块是对的),可用路径 = openai 条目。回归守卫 scripts/demo/pi-openai-thinking.e2e.mjs 锁「pi+openai 路径思考可用」。

**dsh 思考档位补面的验证口径(幕D)**:① dsh 会话 composer 档位下拉**存在**(dsh 适配插件补面,清单来自模型 reasoningEfforts 声明,本机种=关/低/中/高);② 切档生效的**留痕断言** = 会话流出现「思考强度 → low」分隔线(dsh request/header 事件派生 thinking_level_change,壳零分支);③ dsh 落盘无 pi 文件,留痕只看视图流分隔线 + dsh 会话日志,别找 pi JSONL。

**新会话跨内核解锁(幕C 三连断言)**:pi 会话(有历史)→「+新会话」(title **startsWith「新会话」**——「刷新会话列表」含子串「新会话」,includes 模糊匹配会先点中刷新钮,实测踩过)→ 开模型下拉读 TAB(disabled 应 false)→ 点 dsh 模型项 → 发送 → dsh 回复到达且无「跨内核/已固定内核/未启动」错误。修后回归锚:`__capsLog` 每个转变点都有新快照(setContext/首发锁定/start 三处广播,见 markTouched 边沿语义)。

## 7 修复纪律速查(CLAUDE.md 摘录的实操形)

1. 根因修复必须带守卫:纯逻辑补单测、配置/清单补静态守卫、链路补 e2e——没有守卫的修复下次重构就回潮。
2. 「build 通过」不算运行时验证;UI/链路改动必须附真实运行证据(本文的路径)。
3. e2e 脚本本身也是代码:选择器锚错、收敛竞态、虚拟化盲区都会让绿变假绿——断言前先问「这个文本此刻真在 DOM 吗」。
4. 修插件先想槽位:manifest `component` 名必须在 renderer 入口 exports 里(自动匹配),漏了就是静默缺席——守卫:`src/plugins/manifest-exports.test.ts`。
5. **读设计文档先过「路径迁移映射」**(2026-09-12 实锤:前后端分离重构后 30+ 份 `docs/design/*.md` 残留旧目录路径,100+ 处——按旧路径 grep 会扑空):
   - `src/core/domain/` → `packages/shared/src/domain/`(圆心)
   - `src/core/application/` → `src/server/application/`(用例编排)
   - `src/api/ipc/` → `src/server/controllers/`(网关 handler)
   - `src/api/renderer/` → `src/web/`(前端);`src/api/renderer/stores/` → `src/server/application/sessions/`(stores 上提 server)
   - `packages/contract/` → `packages/shared/`(圆心发布面)
   - `src/client/{pi,dsh}/` → `src/server/kernel/{pi,dsh}/`;`src/client/backend/` → `src/server/kernel/core/`
   判据:文档里出现这些旧前缀 = 路径漂移(设计文档是真相源,落地后路径随重构改名);改路径要逐条核对目的目录(非 1:1,盲 sed 会把 `stores/` 这类上提项指错地方)。
