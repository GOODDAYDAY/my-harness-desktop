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
**套件稳定性**:ws-server 闪红根治(r355)瞬态重跑分类(r359/r372)刷新/重开渲染竞态(两个根因已修:① syncNonce 初始基线 null→ns 误重挂 Virtuoso;② sessionStart 只带 sessionFile 缺 neutralSessionId→renderer 回落 sessionInfos 反查落空清镜像。回点行重开用可信点击,别 dispatchEvent)思考块渲染瞬态(r380:kernel-thinking-matrix 幕A / pi-openai-thinking 偶发「文件有思考块但 DOM 无按钮」,数据已落中立层,模型裁量/时序相关,重跑分类)
**大回归节奏**:r332/r348/r359/r364/r372(每批修复后官方矩阵全跑)
**能力面×思考域(2026-09-07 轮)**:思考矩阵四幕 e2e(kernel-thinking-matrix)|能力面推送流水插桩(__capsLog)|模型项双禁用态(menuitem aria-disabled/inert div)|空思考帧 wire 级实证|dsh 思考档位补面验证(幕D)|新会话跨内核解锁(幕C)
**pi dsv4pro 无思考三层根因(r28-r33)**:网关 anthropic 错标 thinking_delta / 网关 openai 拒 developer 角色(桌面可修=supportsDeveloperRole 复选框 3aec332d)/ pi 配置只在 anthropic 协议(已配到 openai)——「同模型 pi 无思考 dsh 有」的逐协议打穿法
**fork→切内核(r23)**:fork 派生会话 pendingSeed 豁免锁定(pendingSeed=未物化≠历史)——fork pi 后可切 dsh
**in-mem harness(r19)**:Vite __vitePreload 相对 import 在 Node-ESM 挂起→直测预加载全 chunk 修复(87b072d5)
**内核插件补面 + 实证纪律(§10)**:行契约不变/hook 不同名(llm-recorder 的 dsh 侧)|插桩改变时序→无插桩复跑定论|守卫要先证明能红|数据层对≠DOM 对(列表跨作用域 key 必带 cwd)
**构建产物与测试基建的「假结果」(§11)**:改完 server 忘了 build→e2e 读旧代码|e2e 泄漏实例→下次连到旧进程|假守卫两副面孔(同实例 rerender / 行为对但机理不对)|静默 no-op 三例(缺关键帧/未声明变量/文档写的字段不存在)|常年红的门等于没有门|能力驱动渲染用 `=== true`|降级要成对验|断言写错"面"(同一件事两个投递口,11.9)

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

**内核扩展同步的路径契约(§目标 13,勿回退)**:bootstrap 启动同步把**原始插件目录 + 相对扩展路径**传给插件侧 `onActivate(pluginId, pluginPath, extension)`,插件侧自会 `join(pluginPath, extension)`。**曾误传 `resolve(plugin.path, rel)` 再在插件侧 join → 路径双重拼接**(`.../dsh-extension/dsh-extension`),扩展目录永远同步不上 → cordis.yml 相对块指向不存在目录 → dsh 内核启动即崩(pi 扩展同理)。守卫:`pi-smoke`/`dsh-smoke` e2e 的扩展同步 + 内核启动全链(若 pi/dsh 冒烟发送零消息,先查 stderr 是否 `ERR_MODULE_NOT_FOUND` 指向 `.my-harness-desktop-plugins/<id>`)。

**模型下拉内核 TAB 只在多内核渲染**(`kernels.length > 1` 才画 TAB 条):单内核(如只配 pi 模型的隔离 HOME)直接铺清单、无 TAB 可点——`pi-smoke`/`dsh-smoke` 的「点内核 TAB」要写成**条件式**(有 TAB 才点,无 TAB 直接选模型),别硬断言 TAB 存在。

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
| `[data-settings-id="<入口 id>"]` | 设置页左侧导航入口(如 `pi`/`dsh`/`minimal`/`general`)。**本轮新增**——此前导航项只有文案(还经 i18n 查表、缺 key 回落 defaultValue),e2e 只能按文本猜,"某个插件在不在设置页里"这类断言因此写不可靠 |
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

**minimal(第三个同级内核,独立子进程 CLI,未配置真模型时 echo 兜底,零 token;默认不装载——manifest `enabled:false`,生产无意义,§目标 16)**:**e2e 必须先 `MHD_ENABLE_KERNELS=minimal`**(launchApp env)才进内核清单,否则模型下拉无 minimal TAB(默认清单=[pi,dsh];卸载=删 manifest 后即使覆盖也缺面,`minimal-uninstall.e2e.mjs` 三段式验:默认 off→覆盖 on→卸载缺面)。选模型下拉「Minimal Echo」(开 menu → 点内核 TAB「minimal」→ 点模型项,触发定位见 `scripts/demo/minimal-smoke.e2e.mjs` 的 trusted-click 配方)→ 发送 → 两阶段收敛 → 时间线 `[minimal echo] <文本>`(未配真模型)或真模型流式(配了 `<HOME>/.minimal/agent/models.json` + `.credentials.json`)。内核本体 = `src/server/kernel/minimal/kernel/*.mjs`(minimal-cli 协议循环 + minimal-model SSE 客户端 + minimal-tools 工具注册表 + minimal-plugin 插件加载),spawn 走 `process.execPath`(别用字面 "node",tsx/vitest 环境 PATH 里没有)。文件对账守卫(§4 数据层,别只读 DOM):① 中立层 `header.kernel="minimal"` + `header.custom.model.kernel="minimal"`;② minimal 会话文件落 `<隔离HOME>/.minimal/agent/sessions/<桶>/<ns>.jsonl`——**不是 .pi/**(历史坑,已根治:壳曾把单一 `agentDir` 传给所有内核,minimal 文件误写 pi 根。**现在中性契约里已经没有 `agentDir` 这个字段**——三个内核各自在插件里从 `KernelPluginContext` 解析自己的数据根,壳不再持有任何内核路径常量);③ 文件格式 = 头行 `{type:"session",id}` + 条目 `{type:"message",id,timestamp,message:{role,content}}`——write 与 read 曾不一致(appendEntry 裸写 `{role,content}` 缺 type 包装,getEntries 读不回;已统一为 appendMessage/appendDivider 规范格式),对账读文件逐行 JSON 断言 `type==="message"` 与 role 计数;④ 多轮 append 走 appendFileSync(首条走 header 写),第二轮也要发(验 append 非首写路径)。两处「写死→注册式」已修:plugin-icon 曾写死 `name==="pi"||"dsh"` 漏 minimal(改 isKernelId);默认内核回退 `?? "pi"`(timeline refreshKernelStatus / session-store projectHeaderToKernel)改 `KERNEL_IDS[0]`。

**minimal fork/重开/改名/删除(补面,均已验)**:fork 是**纯中立操作**(`deriveFromAnchor` 零内核交互、kernel 归属从源 header 透传),minimal 天然支持不需适配——`scripts/demo/minimal-fork.e2e.mjs` 验全链(派生 `derivedFrom.kind=fork` + `pendingSeed` + `kernel=minimal` 不漂 → 首发物化 echo + minimal 文件落 `.minimal/`)。重开续跑在 `minimal-smoke.e2e.mjs`(⌘N → 回点会话行 → 历史仍在 → 第三条续跑,同文件续写)。改名/删除投影:**活会话走 `backend.setSessionName`、非活会话走 `catalog.rename`(追加 session_info)与 `catalog.deleteSessions`(rm 文件)**——两处曾是 no-op(投影缺失 + 文件泄漏),已修,守卫见 `minimal-catalog.test.ts`。

**minimal 三层验证体系(方法论,可复用于任何内核)**:① **单测层** `src/server/kernel/minimal/backend/*.test.ts`——用本地 mock SSE 服务器(`node:http` 起 127.0.0.1 随机端口 + 种 `<agentDir>/models.json` 指向它)验模型流式/工具回环/中断/失败/损坏,零真实 LLM、零外网;② **e2e echo 层** `minimal-smoke.e2e.mjs`——验 DOM/文件对应/重开续跑(echo 兜底);③ **e2e 真模型层** `minimal-model.e2e.mjs`——种 `.minimal/agent/models.json` 指向 mock 服务器,验 full path 真模型流式(断言**无 echo 兜底**)。**纪律:e2e 跑的是 `out/` 构建产物,改了服务端 TS 后必须先 `npm run build` 再跑 e2e,否则测旧产物**(r25 踩过:改 ModelSource 没重建,e2e 还显示旧的固定模型「Minimal Echo」)。三态正交(都有测试):abort→`stopped`+保留部分内容(`minimal-abort.test.ts`)、工具失败→`isError` 回喂后模型恢复(`minimal-tool-failure.test.ts`)、模型 5xx→messageEnd `error:true`+agentSettled `reason:"error"`(`minimal-model-failure.test.ts`,曾漂移:独立 `error` 事件被 SESSION_EVENT_TYPES 白名单过滤、静默吞错)、损坏行跳过(`minimal-corruption.test.ts`)。**头行快照纪律**:setModel/改名/切工具集要**同时**更新头行当前值(name/model/tools)+ 追加历史条目——§3.3.1 头行是"当前值快照"、§3.3.3 条目是"变化历史",两份都写(CLI 侧 `updateHeader`、adapter 侧 `updateHeaderLine`,曾只写条目不回头更头行)。**模型源同源纪律**:模型下拉的 `KernelModelSource.listModels()` 必须读真 `models.json`,与 CLI 模型客户端同源,不能交写死的固定模型(§4.9,曾漂移)。**文件态能力位纪律(§minimal-kernel,契约级)**:内核"会话是壳要跟踪的文件"是独立轴,用 `backend.capabilities.fileBacked` 显式声明(pi/minimal=true,dsh 无),**不要借 `capabilities.pi` 当文件态代理**——minimal 是文件态但没 pi 扩展面,借代理会在 4 处(materializedLineageId / boundSessionPath×2 / materialize seed 分支)被误判成 dsh 的 RPC 内核(曾漂移:改名/头写/补写全跳过、首发重复 seed)。**写穿先于发事件纪律(§4.3.3,文件对应最核心不变量)**:消息边界事件(agentStart/messageEnd/agentSettled)发出时,对应条目必须**已写穿**——CLI 的 `handleSend` 里 user 条目先落盘再发 agentStart、assistant 条目先 `appendMessage` 再发 messageEnd(曾漂移:messageEnd 先发、appendMessage 后写,事件发出后崩溃则壳侧 append 进中立层、minimal 文件缺条目,两边漂)。中间流式事件(messageUpdate/toolCallStart/toolCallEnd)不是写穿点,只在最终 assistant 消息里落盘,不在边界事件之列。守卫:`minimal-backend.test.ts` 的「写穿先于发事件」——messageEnd 到达时读文件断言 assistant 条目已在。**switchKernel 运行期切换(§8 已启用)**:七步编排对三种内核形态过渡全部走通——测试内翻 gate(`(s as any).switchKernelEnabled=true`)验:① 文件态→文件态(pi→minimal,seed 返派生路径 + 预 seed 重 spawn);② 文件态→RPC(pi→dsh,空会话跳过 seed 走 RPC 分支,目标内核 `sessionId` 是身份不变量,MockBackend 需带 `sessionId`);③ RPC→文件态(dsh→minimal,seed 返派生路径 + start 新后端)。守卫见 `session-store.test.ts` 的「switchKernel 五步切换」+「switchKernel 七步」。**r63-64 已翻门禁 + 接线**:`switchKernelEnabled=true` + switchKernel 收尾**重挂槽位**(proc 从旧内核槽移到目标槽 + activeKernel 跟随,否则 proc.kernel=target 却留旧槽 → 后续 ensureForSend(target) 查不到 → 双 spawn)+ setModel 有历史跨内核选模型改为调 switchKernel(不再"跨内核切换后续支持"降级)。运行期切换现在经 switchKernel IPC 直调 + 模型下拉 setModel 两条路都通。**成对看纪律(§5.6.1,抓第 14 个漂移)**:契约的写读方法要**成对**审计——单看每个方法都合理,成对看才暴露不对称。实弹:`updateHeader`(写 toolConfig)有了、`readToolConfig`(读回)却返 null → 工具管理页永远显示"无配置"(曾漂移:能写不能读);`listTools`(读)在契约、`setTools`(写)却不在 → 活跃会话工具集无法热切。修法:readToolConfig 反向映射(工具集→enabledToolIds)、契约加 `setTools(config: SessionToolConfig)`(翻译归内核,壳不感知工具集名)+ 壳 updateHeader 活跃会话热路径调 `backend.setTools`(缺面静默跳过、文件投影照旧落盘)。

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

**依赖方向审计守卫(r342,npm run audit:deps 入仓)**:CLAUDE.md §6.3「CI 可自动化」的落地——`scripts/dependency-audit.mjs` **九检验**(圆心零外部 import / application 不 import 内核实现 / kernel-core 不碰具体内核 / plugins 只认 shared+react / KernelId 字面量单源 / 会话链路零身份分支 / 内核不互相 import / **内核名不许当契约字段名**（`<内核名>Extension` 形态即红）/ 内核面投影层零内核字面量),325+ 文件实跑 0 违规,exit 1/0 可进 CI。**检验数与覆盖是活的**：写了新纪律就加一条检验，别让文档停在一个过期的数字上（这条曾经写「六检验」而脚本早已是九条——数字过期本身就是文档漂移）。**明文例外机制**:豁免表 `DOCUMENTED_EXCEPTIONS` 曾有一条(neutral-migration.ts,§4.3 授权的离线迁移例外),**现已清空**——读 pi 老格式搬进了 pi 插件,壳侧只剩幂等落库(legacy-import.ts),红线回归无条件。豁免机制本身保留:要加例外必须引用文档条款,不悄悄放行。写架构守卫的纪律:先读文档例外、再写豁免规则、豁免注释引文档节号。

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

**fork × 跨内核(r23 实钉,又揪一真 bug)**:「fork pi 会话 → 派生会话切 dsh 模型 → 发送」组合探针,实测 fork 后派生会话 **dsh TAB disabled(锁死 pi)**。根因:`activeSessionHasHistory()` 按「中立层有 entry」判历史,fork 的 prefix(seed)被当成已落内容锁死源内核——与设计冲突(bookmark-snapshot-fork-unify §8.3:派生是自包含中立格式,目标内核取当前激活内核,seed 由目标内核决定;`pendingSeed` 文档定义=「中立层有内容、内核未物化」)。修法:`activeSessionHasHistory()` 加 `pendingSeed===true` 豁免(未物化=无固定内核=可自由选)。守卫:单测(pendingSeed=true→locked=false)+ fork-cross-kernel e2e 6 断言。**方法论收获:pendingSeed 语义是「未物化」不是「历史」——判「锁内核」要看「内核侧是否已落内容」,不是「中立层有没有 entry」**。

**fork × 跨内核反向(fork dsh→切 pi)已收窄(r26,非产品 bug)**:r24 疑「反向 header.kernel 恒 dsh」,r26 用单测 + 不发消息探针收窄——① 单测:setModel(pi) → writeNeutralModelPrefs(kernel=pi) → header.kernel 确实更新为 pi(72 passed);② 真 app 探针:选 pi 模型后 getCapabilities().kernel 仍 dsh = **反向 e2e 的合成「pi」TAB 点击没切 Radix 菜单,选到了 dsh 模型**(我的 e2e 时序 bug,非产品 bug)。教训:**反向组合探针选内核 TAB 要用可信鼠标点击 + 断言菜单真切换**(选模后读 getCapabilities().kernel 或 composer 模型名),别只断「找到并点了菜单项」——Radix TAB 合成点击有时序窗口,点到没切换就是假选。

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

**遗留 2 项失败(非阻塞)**:① ping 模型回复——沙箱禁外网,尽力而为项必然失败;② 草稿切会话恢复(`newChatEmpty=false`/`restoredA=false`)——**jsdom 合成事件时序问题,非产品 bug**(真 app `composer-draft.e2e.mjs` 6/6 全过:写草稿/新会话空/切回恢复 A/再新会话恢复 B;草稿另有 `use-session-draft.test.tsx` DOM 测试 + `ui-store.composer-drafts.test.ts` 单测)。

## 6.1 能力面×思考域矩阵(2026-09-07 轮;scripts/demo/kernel-thinking-matrix.e2e.mjs 四幕)

**思考矩阵四幕(本轮新增官方 e2e,16 断言)**:幕A pi+能思考模型(网关实发 thinking_delta)→思考块展开有正文;幕B pi+空帧模型(Qwen3.8 Max)→「无思考内容」静态提示、无死展开钮;幕C pi 会话在时开新会话→切 dsh 模型→发送出回复(跨内核解锁);幕D dsh 会话思考档位下拉(关/低/中/高)→切档后「思考强度 → low」分隔线落会话流。基线拨 `defaultThinkingLevel:"high"`(setupBaseline 默认种 "off" 演示省 token——验思考必须先拨高,off 会让 pi 不发思考,幕A 假阴性)。

**能力面推送流水插桩(定位能力面滞留的探针法)**:拉起后立即 `window.kernel.sessions.onKernelEvent((e)=>{ if(e?.kind==="capabilitiesChanged") (window).__capsLog.push(e.capabilities) })`,任意时刻读 `__capsLog` 拿**渲染层实际收到过的全部能力面快照序列**——与主侧 `window.kernel.sessions.getCapabilities()`(IPC 直读真相)两端对账:流水末条 ≠ 主侧现值 = 推送缺口(哪个转变点漏广播,转变点清单见 session-store broadcastCapabilities 注释)。实弹:修前流水末条 `{pi,locked:true}` 而主侧(新会话)`{null,false}` → setContext 漏广播坐实。

**模型项的双禁用态(选模型断言必查两样)**:① 隐藏内核清单是 **inert div**(非 active TAB 的内核清单 `visibility:hidden+pointerEvents:none`,**不占 [role=menuitem] 角色**)——menuitem 只含当前 TAB 的项;② 锁内核时可见项也挂 `aria-disabled="true"`(Radix disabled,点了 onSelect 不触发)。pickModel 断言必须同时查 `getBoundingClientRect().width>0 && aria-disabled!=="true"`,只查文本存在会「找到但点了没反应」(实测浪费一轮)。内核 TAB 置灰读 `disabled` + `title`(锁定文案 shell.kernelLocked)。

**空思考帧的 wire 级实证法(「思考内容为空」类投诉的定界)**:先 curl 原始 provider 流(`anthropic-messages` 路径直接 POST /v1/messages 带 thinking 参数,openai 路径查 `reasoning_content`)——**网关只回 content_block_start 空 thinking 帧、零 thinking_delta** = 供应商行为,pi 落盘 `thinking:""` 忠实记录,desktop 管线无截断(pi JSONL 与中立层同空)。定界完成才谈 UI:空正文配可点展开器=「点开有东西」的假装,显式降级静态提示。同网关换上游模型(glm-5.2)实发 delta——「部分模型空帧」是每上游模型行为,不是系统性缺思考。

**「同模型 pi 无思考、dsh 有」的逐层打穿法(2026-09-08 实锤真凶=网关错标块型)**:这类跨内核差异投诉要**逐段排除**,别先怪内核:① 裸 curl 网关(带 pi 的精确请求形状——thinking 参数 + anthropic-beta 头)——看 `content_block_start` 的 `content_block.type`;**网关把思考块开成 `type:"text"` 却往里流 `thinking_delta` = 违 Anthropic 规范**(thinking_delta 必须进 thinking 块),pi-ai 按规范丢弃块型不匹配的 delta → pi 落盘无思考。② 本地透明代理抓 pi 真实请求(pi 发没发 thinking 参数/头)→ 排除「pi 不发思考」的误判:实测 pi 发了 `thinking:{type:"enabled",budget_tokens:16384}` + `anthropic-beta: interleaved-thinking`,请求侧无责。③ 同模型换 openai-completions 路径条目:网关发干净的 `reasoning_content` → pi-ai 正常捕获(pi headless 实测 320 字思考块)。④ 对照组:同一网关 glm-5.2 正确开 `thinking` 块(桌面有思考)——**逐模型错标,不是系统性缺思考**。结论落点:网关(bifrost ai-router)逐模型 bug,桌面/pi 无可修点(pi-ai 按规范丢错标块是对的),可用路径 = openai 条目。回归守卫 scripts/demo/pi-openai-thinking.e2e.mjs 锁「pi+openai 路径思考可用」。

**桌面侧修法结论(三层根因,r28→r33 完整钉死)**:pi 对接 dsv4pro 无思考是**三层根因叠加**,逐层独立可修:
- **层1 网关 anthropic 错标**:对 dsv4pro 经 anthropic-messages,网关把 thinking_delta 错标进 text 块(无 beta 头也错标,与请求参数无关)。pi 扩展 API `AfterProviderResponseEvent` 只暴露 `{status,headers}` 无流 body、`BeforeProviderRequestEvent` 只改请求改不了响应、pi-ai 按规范丢错标块是对的——**这层桌面/pi 无尊纪律修法,唯一在网关**(修法规范见 docs/design/gateway-anthropic-thinking-fix.md)。
- **层2 网关 openai 拒 developer 角色(核心,桌面可修)**:pi-ai 对 reasoning 模型默认发 `role:"developer"`(OpenAI 新角色),网关 bifrost tencent 路由只认 `system/user/assistant/tool/latest_reminder` → 400 拒(连正文都没有)。**修法**:models.json 加 `compat.supportsDeveloperRole=false` 让 pi-ai 退回 system。pi-ai 的 `useDeveloperRole = model.reasoning && compat.supportsDeveloperRole`(实测),字段是通用 OpenAI-compat 概念非网关专属,透传不违反薄壳。桌面落地:NeutralModel.supportsDeveloperRole → ModelConfig.compat.supportsDeveloperRole → 模型页「devRole 不兼容」复选框(3aec332d + pi-devrole.e2e.mjs)。
- **层3 pi 配置协议**:用户的 `bifrost/tencent/deepseek-v4-pro` 只在 anthropic 协议下(错标)。修法:给 pi 的 openai provider 加同 id 条目 + compat.supportsDeveloperRole=false(已直接改用户 ~/.pi/agent/models.json,有备份)。守卫 pi-bifrost-openai-thinking.e2e.mjs(桌面端到端 135 字思考)。

**方法论收获:同一「无思考」投诉可能是多层独立根因叠加**——先 wire 级逐协议(anthropic vs openai)各测一遍,每层都可能有自己的修法;别在「网关错标」这一个结论上停住,把 openai 路径也测透(它拒 developer 角色是第二层,是桌面可修的核心)。

**dsh 思考档位补面的验证口径(幕D)**:① dsh 会话 composer 档位下拉**存在**(dsh 适配插件补面,清单来自模型 reasoningEfforts 声明,本机种=关/低/中/高);② 切档生效的**留痕断言** = 会话流出现「思考强度 → low」分隔线(dsh request/header 事件派生 thinking_level_change,壳零分支);③ dsh 落盘无 pi 文件,留痕只看视图流分隔线 + dsh 会话日志,别找 pi JSONL。

**新会话跨内核解锁(幕C 三连断言)**:pi 会话(有历史)→「+新会话」(title **startsWith「新会话」**——「刷新会话列表」含子串「新会话」,includes 模糊匹配会先点中刷新钮,实测踩过)→ 开模型下拉读 TAB(disabled 应 false)→ 点 dsh 模型项 → 发送 → dsh 回复到达且无「跨内核/已固定内核/未启动」错误。修后回归锚:`__capsLog` 每个转变点都有新快照(setContext/首发锁定/start 三处广播,见 markTouched 边沿语义)。

## 7 修复纪律速查(CLAUDE.md 摘录的实操形)

1. 根因修复必须带守卫:纯逻辑补单测、配置/清单补静态守卫、链路补 e2e——没有守卫的修复下次重构就回潮。
2. 「build 通过」不算运行时验证;UI/链路改动必须附真实运行证据(本文的路径)。
3. e2e 脚本本身也是代码:选择器锚错、收敛竞态、虚拟化盲区都会让绿变假绿——断言前先问「这个文本此刻真在 DOM 吗」。
4. 修插件先想槽位:manifest `component` 名必须在 renderer 入口 exports 里(自动匹配),漏了就是静默缺席——守卫:`src/plugins/manifest-exports.test.ts`。
5. **读设计文档先过「路径迁移映射」**(2026-09-12 实锤;2026-09-13 修正:初版映射有两处错,已按真实文件位置核对修正):
   - `packages/shared/src/domain/` → `packages/shared/src/domain/`(圆心)【已修 round21】
   - `src/server/controllers/` → `src/server/controllers/`(网关 handler)【已修 round21】
   - `src/web/` → `src/web/`(前端);`src/web/stores/` → `src/web/stores/`(renderer 侧 store,**不是** server application——server 侧 session-store 是 `src/server/application/sessions/`→`src/server/application/sessions/` 的另一条)【已修 round21】
   - `packages/shared/` → `packages/shared/`(圆心发布面)【已修 round21】
   - `src/client/{pi,dsh}/` → `src/server/kernel/{pi,dsh}/`;`src/server/kernel/core/` → `src/server/kernel/core/`【已修 round21】
   - `src/server/application/` → **拆分型,非 1:1,不可盲 sed**(未修,67 处留待逐引用):大部分→`src/server/application/`(sessions/models/loader/lifecycle/skills/config/orchestrations),但内核 backend→`src/server/kernel/{pi,dsh}/backend/`、kernel-manager→`src/server/kernel/core/`、remote→`src/server/remote/`;且部分文件**改名**(pi-model-reader→pi-model-source、dsh-model-reader→dsh-config-source、resync→kernel/pi/backend/resync、backend-factories→kernel/factories/kernel-factories、session-binding-store/session-scanner/project-stats 已改名/移)。
   判据:文档里出现这些旧前缀 = 路径漂移;改路径**逐引用核真实文件位置**(find 一下),「整目录搬家」型可脚本化、「拆分/改名」型必须手查。

## 8 内核插件化 / 注册模型测试(2026-09 round)

内核抽插件后,「有哪些内核」不再是字面量数组(KERNEL_IDS 已删),而是运行时 KernelRegistry 注册表。测试纪律:

1. **N 内核注册验收**(`src/server/kernel/core/kernel-registry-n.test.ts`,真实工厂非 mock):单内核(只 minimal)、任意双内核(pi+minimal / dsh+minimal)、三内核(全量),各验「适配完整 + 真 CLI spawn + 未注册内核显式降级 + 缺适配器 fail-fast」。
2. **内核清单动态化**:前端不再 import KERNEL_IDS,改从 `window.kernel.kernelIds`(boot 时 `IPC.kernel.list` 注入)。加内核 = 写 KernelPlugin 工厂 + `registry.register` 一行,前端零改动。
3. **能力探测语义化**:`capabilities.pi/dsh` → `extension/thinking/fileBacked`(能力名,非内核名)。写判据不写 `kernel === "pi"`,写 `capabilities.extensions != null`(有则用、无则降级)。
4. **内核 id 是不透明 string**:`KernelId = string`,`isKernelId(v) = typeof v === "string"`。测试里内核 id 用中性别名(alpha/beta/gamma),不用 pi/dsh/minimal——验证「任意 id 注册」而非「特定内核」。
5. **插件工厂是「装配 + 初始化」入口**:dsh 的 ensure*(写 cordis.yml/zstd 迁移)收进工厂,工厂有副作用。测试用临时 homedir 隔离,不碰真实 ~/.dsh。
6. **注册表查未注册 → 显式降级**:`registry.get(id)` 返回 undefined 是「未注册」的诚实信号,调用方据此降级,不静默、不伪造成功——这替代了删 KERNEL_IDS 后失去的编译期 Record 漏补检查。

## 9 物理插件 / 可卸载测试(2026-09 round 续)

内核落成「物理插件」(独立目录 + plugin.json + 动态加载)后,测试纪律补三条:

1. **卸载 = 删 manifest,不是删代码**:内核插件目录里有 `plugin.json`(id/factory/order),`scanKernelPlugins` 只认有 manifest 的目录。卸载测试 = 临时 `renameSync(manifest, manifest+'.bak')` → 起 app → 断言 `window.kernel.kernelIds` 不含该内核 + 模型下拉无该内核 TAB → 恢复。参考 `scripts/demo/minimal-uninstall.e2e.mjs`。
2. **动态加载路径坑(实踩)**:rollup 把共享模块拆进 `out/main/chunks/`,`import.meta.url` 是 chunk 路径(不是入口 index.js)→ `dirname(import.meta.url)` 推导插件目录会错。定位编译产物用 `process.cwd()`(dev/build)或 `process.resourcesPath`(packaged),别用 `import.meta.url`。
3. **扫描顺序 = 注册顺序 = 默认内核**:`registry.ids()[0]` 是默认内核,scan 必须排序(manifest.order,越小越先),否则 readdirSync 顺序不确定 → 默认内核漂移。测试里 manifest 显式带 order,断言顺序稳定。

## 10 内核插件补面 + 三条实证纪律(2026-09 round 续)

### 10.1 「行契约不变、hook 不同名」是补面的通用形(实做:llm-recorder 的 dsh 侧)

现象:dsh 内核执行时右侧「请求记录」恒空。根因不是"坏了",是**从没接过**——`llm-recorder/plugin.json` 只有 `piExtension`、没有 `dshExtension`,记录整条实现在 pi 扩展里(§7.6 的"静默缺面")。

补面时的通用判断,按这个顺序走:

1. **先定行契约(读侧的输入),再找内核 hook**。pi 侧落盘是 `<cwd>/.my-harness-desktop/llm-logs/<会话名>.jsonl` + `seq/ts/kind` 行。**读侧一行不改**是目标,所以 dsh 侧要做的是"把 dsh 的 hook 投成同一个行契约",不是"让 dsh 装 pi"。
2. **hook 不对等是常态,不许"补齐"**。pi 的 `before_provider_request` 给**完整请求体**;dsh 的 `agent/request` 只给 `LlmCallConfig`(provider/model/参数)。**原样记配置,绝不在扩展内自持会话投影去凑"等效请求体"**——那是造影子实现(违反 §1.6/§3.1),而且会让读侧以为数据比实际全。dsh 的记录比 pi 薄,是**内核能力差的诚实反映**。
3. **配对不同步:按内核自己的坐标系配对**。pi 用「进程内 pending 队列 + `message_end` 出栈」;dsh 的 `agent/request` 天然带 `(turn, step)`,该按它配对 + **边界结算**(`agent/request-error` 结算失败;`agent/turn-stopping` 或下一次 request 的 turn/step 变化结算成功),而不是抄 pi 的出栈队列。
4. **没给的字段就不写**。dsh 不把 HTTP status / 组装消息给插件 → response 行的 `status`/`message` **缺省**。面板本就容忍缺字段(与 pi 的孤儿 request 同形态)。伪造"看起来完整"的记录比缺字段更坏。
5. **waterfall hook 只读**:`agent/request` 的 `next()` 返回值要**原样 return**,绝不改写配置。

实做落点:`src/plugins/insight/llm-recorder/dsh-extension/index.mjs` + `plugin.json` 装 `dshExtension` 键;设计记 `docs/design/llm-recorder-design.md` §2.5。守卫在 `scripts/demo/dsh-smoke.e2e.mjs`(断言 `<sessionId>.jsonl` 有 request+response 行 + `index.json` 记账 bytes>0)。

**逐行增量记账,别做"一次性按磁盘总量校准"**:后者把上次进程已记过的字节再记一遍(双计)。`bytes`/`requests` 本就是累计量。

### 10.2 插桩会改变时序:结论必须在**无插桩**下复跑

这是 #19 花了两轮才分清的关键。切项目时左侧列表"A 的行没消失",我加了三处 `console.log`(列表加载口/渲染口/cwd 订阅)后**复现不出来了**;去掉插桩又出现。加日志本身改变了渲染时序(多一次 console 调用/多一层 settle),把真实的**时序敏感缺陷**掩盖成了偶发。

纪律:**用插桩定位,用无插桩复跑定论**。插桩下的绿不算绿;必须 `git stash` 掉插桩(或重建产物)再跑同一场景,前后一致才算结论。同理,#19 的复现因为"数据小"而偶尔不触发——**要用逼近用户量级的数据**(用户项目 99 条会话,我用 60 条才稳定复现),小样本的场景不足以证伪。

### 10.3 先证明守卫能**红**,再证明它能**绿**

新增守卫只跑一次"绿"是不够的——那可能只是**它没断言到真东西**(选择器落空、条件恒真)。判定守卫有效的最低要求:

1. 你的断言在**未修复**的代码上会 FAIL(把修复点回退一次跑,或确认断言确实命中了出问题的那一层);
2. 断言刻意"选不到"时的**失败信息要能定位**(#19 的守卫打印了实际命中数,而不是只 `ok(false)`)。

反例(本轮实踩):`page.evaluate` 找项目行返回 `found:false`,因为没有 `data-*` 锚、只有 `title`;如果不打印 `found`,会误判成"现象不存在"而不是"探针没找到"。**探针的"没找到"必须与"现象不存在"可区分**。

3. **同症状第二次挂 = 先做隔离,别急着认账**。`minimal-smoke` 的「重开后历史消息仍在」间歇挂(约 2 次 1 次)。我先按"这一定是我刚改的"去修(把 `recomputeMessages()` 提到列表行同步之前),**改完照样挂**。真正的判据是**隔离实验**:`git show HEAD:<file> > <file>` 换回未改版本 → 重建 → 同一 e2e 连跑两次 —— **HEAD 版本同样 1 挂 1 过** → 与本次改动无关。
   **但"不是我引入的"不等于"是 app 的 bug"**——随后查明它是**探针缺陷**:那句断言在
   `waitForFunction(messages>0)`(泛条件)通过后**一次性取样**具体那条,而 Virtuoso 只渲染
   可视窗口(§3.3),泛条件先满足时目标那条可能还没进 DOM。改成**两阶段收敛**(先等泛条件、
   再 `waitForFunction` 等目标那条)后 **连跑 3 次全绿**(此前约 2 次 1 次挂)。
   所以完整的取证顺序是三步:**① 先隔离归属**(不是我干的)→ **② 再判性质**(app 缺陷还是探针缺陷)
   → **③ 才动手**。跳过 ① 会把别人的 bug 记自己账上;跳过 ② 会把探针缺陷当成 app 缺陷去"修"内核,
   越修越乱。教训有两条:①「改完能过」不是因果证据(间歇缺陷上运气就能骗你一次,我第三跑就 PASS 了);②**认账前先隔离**——否则会把别人的 bug 记在自己账上,并留下一条说假话的注释(我第一版注释写着"稳定挂",已改正)。隔离实验本身很便宜:换文件 + 重建 + 连跑两次。

4. **多幕 e2e 里做定点插入,锚点必须选该幕独有的文本**。我给幕D 插断言时,用 `press("Escape")` + `waitForDomIdle(quietMs: 400)` 当锚,而这段在**幕A 也有** → `replace(...,1)` 命中了第一处,断言落进幕A(一个 pi 幕,本就没有 dsh 档位控件),报出"锚为 null"的**假失败**。插之前先 `grep -n` 数一遍出现次数;插完**核对行号落在目标幕之内**。马脚其实很好认:一个 dsh 幕里出现 `modelAnchor: pi:…`,逻辑上讲不通。

5. **断言只写"该状态真正保证的东西"**。我把幕D 的首条断言写成"锚在场**且带值**",实测该会话开场档位是**未选**(`currentLevel=""`、思考已关闭、下拉显示占位符),控件在场但值为空串——**这是合法状态**。改成断言"**在场**"(= 内核声明了非空清单,这才是那一刻被保证的事),"值跟上选择"交给选档之后的那条。把"我期待的样子"当契约,写出来的就是必然假红或必然真绿的废断言。

6. **探针歧义不是一次性清理,是每写一条探针都要过的关**。同一轮里,前几轮修的是**别人的**探针歧义,而我自己**新写**的那条又踩了同一个坑(按"左栏第一行有文字"取会话行 → 点中了乐观「新对话」行,因为它 `data-session-path` 以 `new:` 开头且排在第一个)。三种高危取值方式,写的时候逐个自问:
   - **「列表第一行/第一个」** → 列表里有没有**占位行/乐观行/装饰行**排在前面?(`new:` 前缀、`新对话` 行)
   - **「下拉第一项」** → 第一项是不是 TAB/分组标题/禁用项,而不是目标项?
   - **「按文案/正则匹配」** → 这个文案是否**多控件共用**?实例:空值占位符 `—` 在模型选择器与档位选择器**共用**,正则里带上它就有点中另一个控件的风险。
   出路统一是**用锚点定位**(item 3 补锚的收益):`[data-project-path]` / `[data-composer-thinking]` / `[data-session-path]:not(...)` —— 锚是唯一、无语义的定位面。

7. **「点完立刻取样」是 §10.3.1 反模式的极端形态——而且我把它误判成过"app 时序窗口"**。三次 e2e(`minimal-model`/`minimal-tool`/`minimal-fork`)的写法是:

   ```js
   await page.mouse.click(tabRect.x, tabRect.y);      // 点内核 TAB → Radix 状态更新 → 重渲染(异步)
   const itemRect = await page.evaluate(…找 "Mock"…);  // ← 中间**没有任何等待**
   ```

   失败现场长这样:`tabs: ["pi","minimal"]`(TAB 切了)但 `items` 全是 pi 的(重渲染还没发生)。
   **我上一轮把四次同形瞬态归到"Radix 下拉对合成事件的时序窗口"——那是源码注释里的解释,我照着套了。错在:那句注释指的是"app/Radix 有竞态",而真凶是探针**压根没等**。误判的代价很具体:它会让人去查 app 竞态,查不到,然后继续加 dump。**

   修法就是 W ⊇ X:点完 TAB **等目标项真的出现**(`waitForFunction(含目标文本的 menuitem)`)再取样。实测 `minimal-model` 此前约 4 次 1 挂,修后**连续 5 次通过**。

   顺带一条方法论:同形缺陷**成批扫**(`mouse.click` + 紧邻 `evaluate(...menuitem)` 且无等待)一次抓到 3 处——单点修完不扫,剩下两处会以"另一次瞬态"的形态回来。

8. **批处理跑 e2e 有两个坑,都是"判据写窄了,失败就消失"**(本会话各踩一次,同一形态):
   - **坑一:脚本有 attach 型,不是全都自启动**。`dsh-credentials` / `dsh-multiturn` 的第 2 行写着"连接**运行中的 app**(CDP 9222)"、"前置:app 已以 `--remote-debugging-port=9222` 运行"——它们**自己不拉 app**,混进批处理必然报 `Failed to fetch browser webSocket URL`。**别把这个当功能缺陷**:先看脚本头部有没有"连接运行中/前置已启动",是就跳过或先起 app。
   - **坑二:`grep -E "PASS|FAIL"` 会静默丢掉别的失败措辞**。实测 `❌ e2e 失败: …`、`Error: Cannot find module …` 都匹配不上 → 批处理既不报错也不报警,看起来像"没跑"。**匹配要写 `PASS|FAIL|❌|失败`**,并且**脚本不存在要显式喊**(`[ ! -f ... ] && echo "⚠ MISSING"`)。

   这两条与 §10.3.1 是同一个病的不同外观:**你的观测谓词比事实窄,W ⊉ X,失败就静默了**。批处理是"一次跑很多断言"的地方,恰恰最不能容忍静默。

### 10.3.1 反模式的精确判据:等的是**弱条件**、断言的是**强条件**

上条那句「一次性取样」容易被误传成"`waitForFunction` 后面接 `evaluate` 就是错的"——不是。精确判据是**谓词覆盖关系**:

> 记等待谓词为 W、断言取样出的谓词为 X。**W ⊇ X 才正确**;W ⊉ X 就是间歇假红的温床。
>
> **可操作判据(2026-09 补)**:不是"有没有 evaluate",而是**等待的谓词与取样的谓词是不是同一个**。
> 等待泛化到 `messages.length > 0`、取样却挑特定内容(`includes("答完了。")`)→ **缺陷**;
> 两者同谓词(`querySelector("[data-bookmark-id]")` 等同一元素)→ **正确**。
> 本会话按此判据清了 12 个候选:**3 个真缺陷**(`fork-cross-kernel` / `bookmark-fork` / `bookmark-snapshot`
> 的「找到 assistant 消息行」,等待泛化、取样特定)、**9 个正确**(W == X)。
>
> 而且——**扫描器自己也会漏**:我第一版正则只认 `ok(var)`,不认 `ok(!!var)`,于是把 12 处误报成 1 处,
> 还在报告里写了"这条已清干净"。**报"已清干净"之前,先验证扫描器本身覆盖了所有断言形态。**

- ❌ **反例(实修)**:`waitForFunction(() => messages.length > 0)` 之后直接断言"第二条 echo 那条消息在"——W="有任意消息",X="有特定那条",**W ⊉ X**。Virtuoso 只渲染可视窗口(§3.3),泛条件先满足时 X 还没成立。
- ✅ **正例(别改)**:`waitForFunction(() => /思考已完成|思考过程/.test(...) || innerText.includes("无思考内容"))` 之后取样同一组条件再断言——**W ⊇ X**,等到了才取样,等超时就该红,这是对的。
- ✅ **负向断言**(如"无 echo 兜底")**不能等**——缺席等不出来。放在一个**已等到正向条件**的等待之后取样是可以的,别强求它也有 W。

**全仓扫描结论(2026-09 轮)**:按"`waitForFunction` 后 6 行内 `evaluate`→`ok`"做的**文本扫描报了 4 处,逐一核对全是 W ⊇ X 的正例**——即这个反模式在仓里是**一处个案**(minimal-smoke,已修),不是一类。教训:静态扫描只能圈出**候选**,判据是语义的(谓词覆盖),必须逐处读谓词;把扫描结果当结论就会去"修"一堆没坏的地方(与 §10.3 的探针假阳性同源)。

### 10.3.2 验证失败必须留下完整输出(本轮我自己违反了)

跑 `npx vitest run` 时看到过 `1 failed | 1176 passed`,但我用 `grep -E "Tests "` 只取了汇总行、**把失败详情丢了**——于是那条瞬态**永久不可考**。随后连跑 5 次全绿(1177),再也抓不到。

纪律:**任何一次验证失败,先把完整输出落盘再看汇总**。汇总行只告诉你"有几条挂",不告诉你是谁挂;丢掉详情等于把一次可定位的信号换成一次不可复现的噪声。

顺带一条排查经验:怀疑"跨测试文件竞争共享目录"时,**先核对两个文件是否真碰同一个路径**——本轮我怀疑 `kernel-registry-n`(在 `out/` 里重命名 manifest)与 `kernel-plugin-loader` 打架,核对后发现后者用 `mkdtemp` 自带临时 root,**假设当场被否**。怀疑要落到路径核对,不能停在"看起来都在动同一个 API"。

### 10.3.3 按形状套模板做迁移,会丢"看不见的约束"——但**先查原代码,别凭感觉补**

同一轮里我做两件事,结论**相反**,两条都要记:

- **真丢了约束(1 处)**:把「找含 X 文本的元素 → 合成点击」批量套成 `clickByText` 时,`dsh-session` 的原代码其实是**限定在 `[data-session-path]` 会话行锚点内**找的,而我的助手搜 `body *`——**会匹配到同样含该文本的消息气泡**。按"形状"套模板把域约束悄悄丢了。为此给助手补了 `scope` 选项。(同一批里还漏插 import → 6 个文件齐刷 `clickByText is not defined`;两个错都被 e2e 当场抓到。)
- **假设不成立(8 处)**:我随后怀疑"另外 8 处也丢了域约束",准备一起补——**`git diff` 一查,那 8 处的原代码全都是 `querySelectorAll("*")`**,本就没限定域,迁移是忠实的。**于是我什么都没改。**

**教训是两面的**:①按形状套模板确实会丢约束,**所以迁移必须逐个跑一遍**(6 个里 2 个是跑出来才发现的);②但**"我觉得应该有那个约束"不等于原代码有**——修之前先用 `git diff` 看原实现。凭感觉补 8 处,就是把 8 个本来正确的探针改成"我认为对"的版本,而且每处都要重新验证。

### 10.4 数据层对 ≠ DOM 对:列表类问题必须分两层断言

#19 的原始观感是"根本不刷新",但实测**数据层恢复正确**(`loadSessionInfos(新 cwd)` 拉到 60 条、渲染层 `sessions` 也只有新项目的行),**坏的只是 DOM 里旧行没卸载**(React 复用 `GroupBlock` 实例 + dnd-kit 状态残留,因为分组 key `g.kind+g.label` 跨项目重复)。

所以列表类回归要**两层各断言一次**:先断数据源(`sessionInfos`/store 里的集合),再断 DOM(`[data-session-path]` 的行集合)。只断数据层会漏掉复用/挂载类缺陷,只断 DOM 会看不出是数据没来还是没渲染。**跨作用域的列表,key 必须带作用域**(如 `cwd`)。


### 10.4.1 探测手法:同族函数**边界互相照** —— 实测能挖出真 bug

补测试时把同一文件里**干同类事的函数**放在一起对照,看它们的**边界符号/判据**是否一致。实测收益很高:

- `blind-review/core/assemble.ts` 里 `truncateContent` 用 `.length <= CONTENT_MAX_CHARS`(恰好上限**不**标注),
  而兄弟函数 `serializeTree` 用 `.length >= TREE_MAX_LINES` **反推**"是否被截断"→ **恰好 200 个节点的完整树也被标成"已截断"**,
  等于在喂给模型的 prompt 里**说了一句假话**(它以为有信息缺失)。
- 根因不是符号写错,是**判据表达不了那个语义**("行数到达上限"≠"被切断了");改成显式 `cut` 标志才对,只把 `>=` 改成 `>` 治不了。
- 修完用变异证明钉住:把实现改回 `>=` 反推 → 边界那条断言当场红。

**为什么这个手法有效**:单个函数自己看往往"逻辑自洽";**只有并排看,不一致才会显形**。而且它不依赖任何外部知识,纯读本文件即可。

**机械化扫描的坑(同轮实测)**:我写的第一版扫描限定"**同一常量**上混用比较符"——**结果扫不出上面那个 bug**(它是同一文件里**不同常量**之间不一致)。
放宽成"同一文件内 `.length` 与上限常量比较、符号混用**且涉及不同常量**"后,恰好命中该文件。
**判据太窄的毛病,连我为了找它而写的扫描器都犯了一次。**

### 10.4.2 「损坏」≠「缺失」:读-改-写路径上的静默数据丢失(实测一例)

判据(可拿去扫全仓解析函数):

> **解析"落盘/持久化"数据:坏数据必须 `throw` 或显式降级;解析"实时/用户输入":缺失返回 `null`/空。**
> 违反它的气味有两种:**落盘数据解析静默返回 null/空**(把损坏当缺失去处理),或**用户输入解析直接 throw**(把正常情况当异常)。

**实测到的真问题**(`config-file.ts`):`readJsonFile` 把"文件损坏"和"文件不存在"都归成 `{}`——**只读时是健壮,但在读-改-写路径上是数据销毁**:

```
writeJsonFile(abs, data, "deep"):
  toWrite = deepMergeJson(readJsonFile(abs), data)     // 损坏 → {} → 深合并
  writeFile(abs, JSON.stringify(toWrite))              // 写回 → 原文件其余键整段消失,无告警
```

可达路径实测:`pi-bundled-skills` 用 `deep` 写 **`~/.pi/agent/settings.json`**——该文件一旦损坏,**pi 自己的设置会被清空**。
(注意别把结论说大:默认 `replace` 的调用方本就整份覆盖,不存在此问题;**只有走 `deep` 的路径**。)

**修法(最小且保守)**:deep 路径读回时**区分不存在与损坏**——损坏则**先原样备份 `<name>.corrupt-<ts>`** 再照常合并。**保留调用方语义**(仍按 `{}` 继续),只把"数据已被销毁"降级为"数据还在,另存了一份"。掷错/拒绝写入属于需要产品拍板的语义变更,不擅自做。

**分诊完全部候选后的实际分布**(21 个 `JSON.parse`+catch+静默返回空的候选):**2 处真问题(已修)、2 处敏感候选经查是对的、其余为只读解析**。关键是那"2 处是对的"也值得写下来——它们给出了**仓内对照实现**:

| 位置 | 处置 | 评价 |
|---|---|---|
| `config-file.ts` deep 路径 | 静默 `{}` 后整段写回 | ❌ 已修(备份) |
| `dsh-config-source.ts` disabled 名单 | 静默 `{}` 后读-改-写 | ❌ 已修(备份) |
| **`pi-catalog.ts` 会话头**(会整文件重写会话文件!) | **掷错 + `content.slice(nl)` 保留 body + 目录锁** | ✅ 正确样例 |
| **`pending-question-store`** | 一记录一文件 + 坏文件跳过且**不覆盖** | ✅ 正确 |

**这条的用法**:"这处该改"的最强依据不是我的偏好,而是**同一仓里已经有人把同类事做对了**(`pi-catalog` 的会话头改写在坏头行上直接 `throw`,且重写时 `rest = content.slice(nl)` 原样保留正文)。**先找仓内对照实现,再动手**——它同时回答了"为什么该改"和"改成什么样"。

**测试要钉住的四条**(缺一条都会漏):损坏→有备份且内容原样 / 合法→**不**备份 / 不存在→**不**备份(不存在≠损坏) / `replace`→不进读路径不备份。
失败信息里直接写后果(`"损坏文件未被备份(原内容将永久丢失)"`),比只说断言不等有用。

### 10.4.3 偶发失败:测试假设自己是"这条流上唯一的消费者"(实测一整类,已根治)

**症状**:套件偶发 `1 failed | N passed`,**每次红的测试还可能不一样**,重跑就绿。本仓历史里至少出现过两次、**都没查出成因**;文件里的稳定性注记把它记成"高并发 worker 下偶发事件循环"——**成因记错了**。

**实测真因**(`src/server/transport/ws/ws-server.test.ts`,6 处):服务端在**连接鉴权成功时**还会推一条 `remote:connectionsChanged`。而每个"等一条具体回复"的断言都写成:

```ts
await expect(nextMessage(ws)).resolves.toEqual({ kind: "result", id: 1, … });
                              ↑ 取"下一条",但它可能正是那条无关推送
```

**判据**:凡是**从一条可能混入无关消息的流上取"下一条"**的断言,都是偶发候选。到达次序决定红绿,所以表现为随机。

**修法**:等**符合条件的那条**,而不是"下一条":

```ts
const isReply = (m) => m.kind !== "push";          // 插队的**永远是 push** —— 这一条让谓词与本文件所有站点通用
await expect(nextMessageWhere(ws, isReply)).resolves.toEqual({ … });
```

**验证必须按"负载"来**:该偶发对并发敏感,单文件连跑(改前 1–2 轮必现 → 改后 **8/8 绿**)不足够,**还要全量套件连跑 2 次**。
**扫全仓**:`grep -rnE '\.once\("(message|data|event)' **+ `await nextMessage\(`** —— 顺带按 §10.5 第 10 条做正控制(确认模式确实能命中已知那处,否则"别处为 0"不成立)。

**为什么这条比"再加几条测试"重要**:偶发失败的套件让每一次"绿"都带未知概率,**久而久之训练人忽略红色**——而忽略红色正是让真问题活下来的方式。

### 10.5 最常出错的是**尺子本身**,不是被测对象(2026-09 整轮实证)

清理「文档交叉引用断链」这条线,从报出 **59 处**到 **0 处**,逐一归因后:

| 成因 | 处数 | 是谁的问题 |
|---|---|---|
| 解析器只试固定几个候选目录 | 42 | **我的量具** |
| 节标题正则漏写法(`## 10 QA` 不带点 / `` `doc.md` §N `` 反引号 / `## §32` 带 §) | 14 | **我的量具** |
| 解析器不看插件目录、同名多份不消歧(`plugin.md` / `DESIGN.md` 各在插件自己目录下) | 6 | **我的量具** |
| 审计用 `git ls-files 'docs/**/*.md'` 漏掉 **docs 顶层 18 份**(git pathspec 的 `**` 不匹配顶层) | — | **我的量具** |
| 文档名引错(`kernel-layer.md §9.4` 其实在 `CLAUDE.md §9.4`) | 2 | 真的 |
| 旧编号系列退役 / 无效节号 `§870` | 1 | 真的 |

**59 处里只有 3 处是仓库的真问题。** 这不是孤例:同一会话里探针缺陷 5 次(e2e 合成点击 / 无等待 / 泛等取样)、无效探针 1 次(选了个本来就过关的文件去测门)、门里一条循环口径不一致 1 次。**每一次的症状都是"我发现了问题"或"门没生效",而真相在量具那一侧。**

**五条操作纪律(都来自本会话的实际翻车)**:

1. **先验尺子的覆盖,再信它的结论**。路径集合(glob/pathspec/扩展名/排除项)、文件数对不对得上——`audit:refs` 报 165 份文档,而 `find` 说 183,差的就是那 18 份从没被看过。
2. **报告数字变大时,先怀疑尺子**。我修一次解析器,断链 6→35→10→8→1;中间两次跳升**全是我的假阳性**,不是仓库新坏。**"发现能力变强"和"假阳性变多"在数字上长得一样。**
3. **把形态空间一次性枚举干净,别一个个撞见**。节标题写法被我分三轮才发现三种;事后全仓枚举(83/126/5 份文档)并**用正反 8 条用例证明正则覆盖**,才敢说"不会再有第四种"。
4. **任何门都要红绿双向证明过再用**。`audit:refs` 清到 0 才设门,设完立刻注入一条断链验证 `exit=1`——顺带发现第一次注入落在**漏扫的 18 份**里,等于没测。
5. **判据粒度要写清是行级/段级/文件级**。`audit:docs` 的退役符号门是**文件级**(某处有标注即合格),所以往 `glossary.md` 注入未标注符号不会红——**不是门坏了,是我拿错了测试文件**(那份文件的 banner 里本来就有标记词)。

6. **`... | tail; echo "exit=$?"` 量到的是 `tail` 的退出码,不是被测命令的**。本会话**一天内踩三次**(e2e 批处理、`audit:refs` 红绿验证、`run-tests.sh` 失败路径),每次都差点得出反向结论(以为门没生效/脚本没报错)。要看真实退出码,就**别接管道**:`cmd >/dev/null 2>&1; echo $?`。
7. **给"留证"类工具也要验它的失败路径**。`run-tests.sh` 我先只证了"全绿时不打详情块"——那只证明它**不会多嘴**,没证明它**在需要时会说话**。补验:注入一个故意失败的测试 → 详情块打印 ✓、失败测试名与文件进落盘日志 ✓、真实 `exit=1` ✓;全绿 `exit=0` ✓。**"不会误报"和"会报警"是两件事,得分开证。**

8. **"文件存在"和"它会被执行"是两件事**。本轮我把新守卫放在 `scripts/` 下,跑起来**没有任何输出**——查明 `vitest.config.ts` 的 include 只有 `src/**` 与 `packages/shared/src/**`,**`scripts/**` 下的测试永不被发现**(全仓发现 1183 个测试文件,`scripts/` 下 0 个)。移到 `src/` 下立刻被发现并跑通。**一个存在但永不执行的守卫比没有守卫更坏:它让人以为有人守着。** 识别信号很朴素——**跑起来没有任何输出**。放测试/守卫前先确认发现机制覆盖了那个路径(`vitest.config.ts` 的 include、CI 的 glob、`package.json` 的入口)。

9. **断言强度必须对齐"被验的性质"——过强的断言会产出假发现,而假发现会被当结论写进代码**。实例:我给"插件级 dsh 扩展同步"补幂等测试时断言 `twice === once`(**字节完全相同**),它失败了,于是我判定"这条不幂等",还把这个结论**写进了源码注释**并在报告里讲了一轮。下一轮读实现才发现:`addPluginBlock` 本来就幂等(`findBlock` 命中则**只重写 name 行**)——**字节变了、块数没变**。要验"不重复追加",就该断**块数**;断字节全同是在验另一件事。
   - 这与 §10.3.1 的 `W ⊉ X` 是同一族,但方向相反:那次是**观测太弱**(漏报),这次是**断言太强**(假报)。两者都会让你对着一个不存在的问题干活。
   - 更值得记的是:**假发现一旦写进注释/报告,它就获得了"已被核查过"的外观**。所以"我很谨慎地记下了一个已知差异(带证据、不留红)"**不等于它是真的**——本轮我的 skip 注释里每条证据都在,结论却是错的。
   - 操作面:断言前先问"**我要验的那句话,最短的等价命题是什么**";能断"不增长/不重复/集合相等"就不要断"文本相同"。
   - **补测试前先读同文件里已有的同类测试**。上例的正确答案就在**同一文件上方 70 行**处——原有那条测的是 `text.split(...).length === 2`(**块数**),而我在写之前没看它。所以那次错的成因不是"没有可参照的做法",是"没先读旁边那条已经写对的"。**同类测试就在旁边时,先抄它的断言强度,再写自己的。**

10. **两处独立的小失误会叠加成一个"看起来很硬"的假结论**。实例:做 `hover-tip` 浮层测试时它抛 `Tooltip must be used within TooltipProvider`,我据此判"全仓没人提供 Provider → 生产会崩"(崩溃级)。两轮反证后**结论反转**——推翻它的正是我自己的两个尺子错误:
    - grep 找字面 `TooltipProvider` → **漏掉命名空间写法** `Tooltip.Provider`(而这个文件自己就是 `import * as Tooltip` 风格);
    - 补查时 `head -8` **把输出截断**,决定性那行被切掉。
    真相:`src/web/app-main.tsx:246-254` **全局提供**了 `Tooltip.Provider`,注释就写着"唯一一份……任何插件都不需要自己包"。**那次报错是我的测试缺了前提,不是组件有问题。**
    - 为什么危险:**"grep 零命中" + "组件会抛错"** 两条各自都真、拼起来读着像铁证,**但结论错**。单点检查都做了,漏的是**它们之间的推理**(零命中≠不存在,因为尺子的模式可能就错了)。
    - 操作面:① **零命中的结论必须配一个正控制**(先在已知有该东西的地方跑同一模式,确认模式能命中);② 任何 `| head` / `| grep -c` 的**截断输出不能当证据**——截断本身就说明"还有没看到的部分";③ 报严重度前先问"**如果这个结论错了,最可能的错法是什么**",然后专门去验那一条。

11. **假定时器与第三方库的内部计时不同源时,`advanceTimersByTime` 推进不了它**。实例:测 Radix Tooltip 的 `delayDuration=1000`——`fireEvent.pointerEnter` + `vi.useFakeTimers()` + `advanceTimersByTime(1200)` **超时 5s**(东西没出来)。误判方向是"Radix 在 jsdom 里不能用";实际是**它的延迟计时不在 `vi` 的时钟上**。改**真实计时** + `waitFor` → 立刻通过,且测试自身耗时 **1035ms**——这个时长本身就是"1s 延迟真的在跑"的实证。
    - 症状特征:**操作做了、时间推了、东西没出来**。此时先换真实计时试一次,别急着下"这库测不了"的结论。
    - 代价:该测试会真的等 ~1s(本例 1035ms)。**换来的是它真的在验那段延迟**——比"用假定时器跑得飞快但什么都没验"值。
    - 顺带:**量级也要钉**。只断"刚悬停时没出现"证明不了"就是 1000ms"(Radix 默认 700ms 也会过)。加一条 **800ms 时仍不该出现**,才真正钉住量级——变异证明:去掉 `delayDuration` 回落默认 700ms → 该条当场红。
    - 前置:`jsdom` 缺 `ResizeObserver`,Radix 浮层需要它——本仓 `vitest.setup.ts` **已全局 stub**(为 sidebar 加的,浮层同样受益)。加浮层测试前先看 setup,别重复造。

12. **组件测试的替身要满足"组件声明的 props 类型",而不是"组件里实际用到的字段"**。本会话**踩了三次**(`TeamConfig` 只给 id/name、`AccessLevel` 写非法字面量、`SettingsComponentProps` 少 `refreshSignal` 且 `config` 传了 `undefined`)——三次都是**运行时全绿、`typecheck` 报错**。
    - 危险特征:**运行时是绿的**。只有把 `typecheck 0` 当基线守着,它才会暴露;否则这条"绿"是靠残形**绕过了类型契约**换来的——假绿。
    - 操作面:① 写组件测试前,把**组件 props 引用的那个接口**读出来(不只是组件自己的参数签名——`{ config, onChange }: SettingsComponentProps` 的关键在 `SettingsComponentProps`,不在解构出来的两个名字);② 用一个 `props()` 助手统一构造,改类型时改一处;③ "缺失/未配置"要按类型的表达来写(这里是 `null`,不是 `undefined`)。

13. **验证工具可能把"被验的差异"抹平** —— 那样断言**永远不可能失败**,而它看起来和真绿一模一样。实测:我断言"空白被折叠成单空格"用
    `expect(screen.getByText("第一行 第二行")).toBeInTheDocument()`,而 **RTL 的 `getByText` 默认会归一化空白** —— 未折叠的 `"第一行\n\n   第二行"` 对它**同样匹配**。
    于是"去掉折叠"的变异**照样绿**;改读**原始 `textContent`**(`expect(el.textContent).toBe("第一行 第二行")`)后才红,并直接把原文打出来:
    `expected '第一行\n\n   第二行' to be '第一行 第二行'`。
    - **同族风险**:`toHaveTextContent`/`getByText`/`textContent` 归一化空白、`toMatchSnapshot` 的序列化、CSS 断言被 `jsdom` 忽略(`getComputedStyle` 拿不到样式表规则)、`toEqual` 忽略 `undefined` 键。
    - **判据**:断言前问一句「**我用来取值的那个 API,会不会把它归一化/忽略掉?**」。**凡断言"格式/空白/样式"这类差异,必须走不归一化的读取**(`el.textContent`、`el.attributes`、`el.style.xxx`)。
    - **配套纪律**(同轮实测,两件事必须一起做):**变异注入后要回读文件确认它真的改到了**(我第一次写 `\\s` 落成 `\s`,与源码 `\s+` 不匹配 → 替换为空 → 变异从未生效,测试当然绿)。
      **"变异无效"和"断言无效"看起来都是绿** —— 所以顺序是:① 注入后回读确认 → ② 跑测试看是否红 → ③ 没红就分辨是哪种无效。

14. **mock 的"引用稳定性"必须与真实 hook 一致,否则 effect 会打转**。实测:`usePluginContext` 的 mock **每次渲染返回新对象**,而组件 effect 的依赖是 `ctx.i18n` → **依赖每次都是新的** → `setLocales` → 重渲染 → **无限循环**(整轮 vitest 跑成 60s 超时,报告里只看到 "[timed out]")。
    - **判据**:只要被测 effect 的依赖里出现**对象/函数**(ctx、store 切片、回调),mock 就必须给**模块级稳定引用**(`vi.hoisted` 里建一个常量对象,`beforeEach` 只改它的字段)。
    - **症状识别**:"单个组件测试把整轮跑挂"而不是"某条断言失败" → 先怀疑**渲染循环**,别去调超时时间。
    - **顺带**:这类超时也可能是**命令根本没跑**(见下),不是循环 —— 两种都要排除。
15. **失败信息的"流向"也是仪器的一部分**。实测:我写了 `timeout 120 npx vitest …`,而 **macOS 没有 `timeout`**(报错进 **stderr**),我又只 `grep` 了 **stdout** → 我看到的是"**没有输出**",于是**读成了"还在挂"**,并据此继续排查了一个不存在的问题。
    - **判据**:排查时**不要只看 stdout**;命令挂/不挂先确认**它到底有没有跑**(看 exit code、看 stderr、或跑一条已知会输出的对照)。
    - 同族:任何经过 `| grep` / `| tail` / `| head` 的读取都可能把"失败"过滤掉 —— 这和第 10 条"截断输出不能当证据"是同一件事。

16. **"我核过了"必须带上"核了什么范围"** —— 范围没说的结论会被读成**全域结论**。实测:我扫完 `manager/{pi,dsh}-manager` 里的内核身份引用,得到"10 处、10 处已覆盖",报告里写成"**这个接缝已守全**"。下一轮把同一模式**扩到全仓**再跑一次,立刻多出**第 11 处**(`manager/tool-manager/renderer/index.tsx:472` 的 `ctx.kernels.pi.fitPiExtensionAvailable?.()`)。
    - **成因**:我确实跑了 grep、结论也没错 —— **错的是"范围"没写进结论**。而"两个 manager 之内守全"和"全仓守全"在读者眼里是同一句话。
    - **判据**:凡"全部/已守全/无遗漏"这类结论,**必须写出它的查询边界**(哪些目录、哪个模式),并且**把边界本身当成待验项再扩一次** —— 扩一次往往只需一条命令,而它决定结论成不成立。
    - **配套**:扩完发现的新处也要**判定性质**,不能一律当缺陷:该处 `fitPiExtensionAvailable` 问的是"**pi 的**扩展是否可用"(语义上确实 pi 专属,且带 `?.()` 降级),所以**不是泄漏**,只是**没有守卫** —— 这两件事要分开说。

17. **"我用它查了"≠"它能查到"** —— 仪器有**视野边界**,视野外的东西它不会报,而**不报看起来就像"没有"**。实测:我这一路都用 `git status --short | wc -l` 报"**无残留**",而它**按构造看不见被忽略的路径**(`.gitignore` 里的 `out/`、`.e2e-home/`、`.sessions/` …)。**若我的工作往那些目录里丢过东西,它会照样说"干净"。** 换成 `git clean -nXd`(干跑,列出会被删的 ignored 路径)复核后,才真的确认"无本会话产物"。
    - **判据**:报"没有/不存在/干净"之前,先问"**我这个仪器按构造能看见这一类东西吗**"。每个工具有它天生盲区: `git status` 看不见 ignored;`grep` 看不见它没搜的路径;`vitest` 看不见 `include` 之外的测试;**`ls` 看不见隐藏文件**(除非 `-a`)。
    - **做法**:对每个"零"结论,**配一个针对该类路径的专门探针**(ignored → `git clean -nXd`;隐藏文件 → `ls -a`;跨目录 → 显式列出目录),而不是用同一个通用命令反复报"干净"。
    - 同族:第 7 条(漏扫 18 份文档)、第 10 条(零命中没配正控制)、第 16 条(结论没写范围) —— **四次都是"我以为看见了"**。

18. **"提到" ≠ "执行"**:在**文本**里搜"动作词",命中的往往只是**关于该动作的叙述**。实测:我用 `git reflog --all | grep -icE "push|fetch|clone"` 得到 **4 条**,据此差点判"有推送痕迹" —— 逐条看发现**2 条是 commit 标题里含英文单词 "push"**(`…能力面改 push`)、2 条是 fetch。**reflog 里 0 条 push**。
    - **判据**:凡用关键词判断"**有没有发生过某动作**",要区分**动作词出现在叙述里**还是**出现在动作位置**(git 的 `HEAD@{n}: <动作>` 段、日志的字段而非正文)。**能按位置定位就按位置**,别按全文包含。
    - 同族:第 17 条(仪器看不见/看得太宽)的"太宽"变体 —— 前几轮的"断言太宽"是同一形状,只是换到了搜索上。

> **正面实践(由此轮实测得出,值得照做)**:**把硬约束做成机械的,而不是靠纪律记得**。本仓 `git config remote.origin.pushurl` 被设成 **`must-not-push`**(一个**不存在的远程名**) → **任何 `git push origin` 都会因无法解析而失败**。这比"我不会 push"这种承诺可靠得多。同类做法:CI 里禁用的命令用**不存在的可执行名**顶替、危险脚本加**前置闸**(如 `[ "$ALLOW_DESTRUCTIVE" = 1 ] || exit 1`)、只读模式用**文件权限**而非约定。

19. **异步行为:先 flush 再断言,否则你断的是竞态,不是行为**。实测(把"永不空白"守卫移植到 graphviz 时):我断言"流式期间不该去加载渲染器",写成**同步** `expect(instanceCalls).toBe(0)` —— 而 effect 里的异步调用**那一刻还没发生**,所以**任何实现都会通过** ✗。红绿证明时立刻现形:去掉 effect 里的 `if (streaming) return;` 早退,**测试照样绿** ✗;补上 `await new Promise(r => setTimeout(r, 20))` 再断言,同一变异**当场红**(`expected 1 to be +0`)✓。
    - **判据**:凡断言"**某异步副作用没有发生**"(没调用某函数、没发请求、没 setState),必须**先让它有机会发生**再断言。**"没发生"的证据只能来自"给了足够时间仍没发生"**,不能来自"我读的时候还没有"。
    - **对偶**:断言"某异步副作用**发生了**"用 `waitFor`,断言"**没发生**"用"先 flush 再查一次" —— **两侧都不能省等待**。
    - 同族:第 13 条(工具抹平差异)、第 17 条(仪器看不见)。**三条都在讲"断言能不能失败"**,而**红绿证明是唯一能自动发现它们的手段** —— 本轮就是靠它发现的。

20. **变异要打"实现该语义的那一行",不能打"文本第一次出现的地方"**。本会话**同一个错犯了三次**(实测):
    - 想变异 `rename`,按 `await sessionStore.rename(` 找 → 真名是 **`renameSession`** ✗;
    - 想变异 `on()` 里"冲刷待发 invoke",按第一个 `pendingInvokes.delete(` 找 → 打中了 `unregisterPlugin` 那处 ✗;
    - 想变异 `reportLoadFailure` 的"撤注册",按第一个 `unregister(pluginId)` 找 → 打中了 `deactivate` 那处 ✗。
    - **三次症状完全相同**:**变异跑过了、测试却仍绿** ✗ —— 而**"绿"看起来像通过**,不特意看就发现不了 ✗。
    - ⚠ 我三次都写了"锚点断言"(`assert old in s`)却都没拦住 ✗ —— **当目标串出现多次时,`in` 为真并不代表打中了那一处** ✗。
    - **判据**:① 先 `grep -n` 数目标串出现几次;**>1 次就别按文本改** ✗;② 定位到"实现该语义的那一行"后**按行号改** ✓;③ 改完**回读确认**落到预期行 ✓。
    - 同族:第 13/19 条 —— 都是"我的验证动作看起来做了、其实没作用在目标上"。

21. **别为了让测试不红而吞掉错误** ✗。本会话实录(相隔两轮、同一个人犯同一个):
    - 第 242 轮我批评 `minimal-smoke` 的三处 `.catch(() => {})`:«把就绪等待的失败吞掉,于是失败信息**指向了错误的组件**» ✓;
    - 第 248 轮我**在自己新写的测试里**写下
      `await handleSpawnSubagent(orch, frame).catch(() => { /* 替身不全,后半程可能抛 */ })` ✗ ——
      结果:**完全看不到"为什么它没走到断言点"** ✗,白丢一轮;
    - 第 249 轮把那句 `.catch` 去掉,**一次就看到真错**(它卡在并发护栏、根本没 spawn)✓。
    - **判据**:诊断期**绝不要 catch** ✓;确需兜住时**至少打出来** ✓。你吞掉的那条错误,
      **正是你唯一需要的那条信息** ✓。
    - **同族**:第 15 条(只 grep stdout 把"没跑"读成"在挂")—— 都是**把信息丢掉,然后凭想象继续** ✗。

22. **`grep` 别带"形式假设"** ✗。本会话实录(同一个靶上耗掉四轮):
    - 想找 `SubagentOrchestrator` 的定义,我先用 `interface SubagentOrchestrator` ✗ 零命中,
      再用 `(interface|type) SubagentOrchestrator` ✗ 仍零命中 —— 而它实际是
      **`export class SubagentOrchestrator`** ✓✓(第三种形式我压根没写进模式里 ✗);
    - 代价:249~252 四轮都花在"再补一个字段"上 ✗,而**读一次类型定义本可一轮见底** ✓;
    - **判据**:找定义时用**裸名字**(`grep -rn "X" src/ packages/`)✓,拿到**文件**再去看它怎么写 ✓;
      要限定就写成 `(interface|type|class|const|function) X` ✓ —— **别用排除法猜形式** ✗。
    - **同族**:第 20 条(按"文本第一处"变异)、以及"猜 API 名而不读它" ✓ —— 都是
      **先假设形状,再拿假设当事实用** ✗。
    - **推论(战略层)**:找不到形状时,**不要继续从它身上切薄片** ✗ ——
      先判断"这个靶在我的剩余条件下做不做得完" ✓,做不完就换小靶 ✓,并**把已清出的路径交接** ✓。

**一句话**:审计和守卫的价值取决于"它能不能在该红的时候红、该绿的时候绿";**在这条被验证之前,它报出的所有数字都不可当作事实**,尤其不能当作"进展"。


## 11 构建产物与测试基建的「假结果」(2026-09 round 2;每条都是本轮实踩)

前面 §10 讲的是"守卫要能红";这一节讲**它红了/绿了之后,你怎么知道这个结果是真的**。本轮四类假结果,每一类都让断言"看起来在工作"。

### 11.1 改完 `src/server` 忘了 build → e2e 读的是**旧代码**

- **实录**:内核扩展声明从 `piExtension`/`dshExtension` 改成 `extensions: {内核id: 路径}` 后,新写的 e2e 断言全红。我把测试逻辑读了三遍,最后发现 **e2e 跑的是 `out/` 里上一版的 `assemble`** —— 旧代码读新 manifest = **静默不同步**(不报错,只是什么都没发生)。
- **判据**:① 跑 e2e 前**必 build**(改过 `src/server` / `src/web` / `packages/*` 都算);② 新断言的失败,**先排除产物陈旧,再怀疑断言本身**。
- **同族**:§11.4 的第三例(文档描述的字段已不存在)——都是"代码/产物/文档三者不一致,而三者都不报错"。

### 11.2 e2e 泄漏实例 → 下一次运行连到**旧进程**(假绿与假红都可能)

- **实录**:新 e2e 在失败路径没 kill app,端口上留着上一轮 `MHD_ENABLE_KERNELS=minimal` 的实例;下一次运行的 `cdpAlive(port)` 立刻为真 → **直接连上旧实例**,于是"默认不装载 minimal"那一步读到了**上一轮**的内核清单。
- **根因**:`launchApp` 只等 CDP 就绪,**不检查端口是否已被占用**;而"端口被占"的表现恰恰是"CDP 可用",所以两者不可区分。
- **修法**:`launchApp` 先 `assertPortFree(port)`(响亮失败,别静默连旧的);e2e 的 `catch` 路径也要 `killApp`。
- **判据**:任何"结果与预期不符、但看着没错"的 e2e,先确认**连的是不是自己刚拉起的那个进程**。

### 11.3 假守卫的两副面孔

- **面孔一:用同一个实例驱动状态变化**。思考块"跑完自动收起"的守卫用 `rerender()` —— 同组件实例的 state 天然保留,**今天绿,却抓不到真缺陷**(真实路径是 Virtuoso 因消息 id 变化换 key 导致**重挂**)。→ 用 `unmount()` + 全新 `render()` 复现重挂。
- **面孔二:行为断言对,但机理没被锁住**。原子写的守卫断言"文件是完整 JSON" —— 没被 kill 时**非原子写同样产出完整文件**,把 `updateHeader` 改回裸 `writeFileSync` 它**照样绿**。→ 改成**机制检查**:会话文件路径上唯一的 `writeFileSync` 只允许是 `writeAtomicFile` 里那次(写临时文件)。
- **判据(写守卫时先自问)**:「我把这行要防的代码改回去,它会红吗?」答不上来就是假守卫。
- **同族**:§11.6 的 `=== true` —— 断言也要落在"最不承诺"的一侧。

### 11.4 静默 no-op 三例(全在"看起来没事"这一侧)

| 形态 | 为什么没人发现 | 守卫 |
|---|---|---|
| `animation: "tool-live-pulse …"` 引用的 `@keyframes` **全仓不存在** | 没有关键帧的 `animation` 声明是**静默 no-op**:不报错、不警告、什么都不动。既有守卫只查 `classList.contains("animate-pulse")`,**查不到内联动画名** | 新增静态门 `src/animation-keyframes.test.ts`:用到的动画名 ⊄ 已定义关键帧即红(反向也列出未被引用的关键帧) |
| `abort` 命令里一句对**已删除变量**的赋值(ESM 严格模式 → `ReferenceError`)被 stdin 的 `try/catch` 转成一个多余的 `error` 事件 | abort **本身仍然能用**(`abort()` 已经先执行了),所以"只断言消息带 stopped"的守卫一路绿 | ① 守卫补"整个 abort 链路不许产出任何 `error` 事件";② 新增**协议命令全覆盖**:把命令面全喂一遍,断言零 `error` 事件 + 正向应答都在(防"什么都没跑所以没报错") |
| `docs/new-plugin.md` 教人声明 `piExtension`,而该字段已改名 | 按文档写的插件**静默不生效** | 文档与代码**同批改**(这不是"文档不整齐",是功能静默失效) |

### 11.5 常年红的门 = 没有门

- **实录**:`npm run lint` 长期 **10 个 error** 全红(`_v`/`_ms` 这类有意不用的形参被判 unused-vars)。红着的门没人看,新引入的 lint 错误也就无人发现。
- **修法**:`argsIgnorePattern`/`varsIgnorePattern: "^_"`(社区约定:下划线前缀 = 有意不用)+ 清掉 5 处真死代码 → lint 归零。
- **判据**:任何"状态门",**先让它归零**再谈它有没有用;长期红的门应当视为不存在。

### 11.6 能力驱动的渲染用 `=== true`,不用 `!== false`

- **实录**:版本页按能力旗标隐藏"用不了的安装区"。第一版写 `caps?.install === false ? 隐藏 : 显示` —— 能力**还没问到**时会先**闪出一个点不动的按钮**(它像承诺,比没有更糟)。改成 `caps?.install === true` 才画:未知一律不画,宁可短暂空着。
- **判据**:**默认渲染落在"最不承诺"的那一侧**;等数据到了再补上是可接受的,先承诺再撤回不是。

### 11.7 降级要**成对**验:隐藏对 + 不过度降级

- **实录**:只验"minimal 的安装区没了"会漏掉"把 pi 的也一起关掉"这种**过度降级**(单侧断言的经典盲区)。
- **现状**:`minimal-settings.e2e.mjs`(9 断言,零 token)同时断言两侧——minimal 隐藏安装区/检查更新/自定义目录**并给出说明**,pi **照常**有安装区与自定义底座区。
- **判据**:凡"按条件隐藏/置灰"的改动,守卫必须**同时**覆盖"该隐的隐了"和"该留的留着"。

### 11.8 设置页入口用 `[data-settings-id]` 定位

导航入口此前只有文案(还经 i18n 查表、缺 key 时回落 `defaultValue`),按文本猜既脆又可能因语言包变化而失效。本轮在 `settings-page.tsx` 加了 `data-settings-id={item.id}`,e2e 一律用它(§2 锚点清单已收录)。

### 11.9 断言写错「面」：同一件事有两个投递口，选错了全红

- **实录**：给零测试的 `session-bus.ts` 补 21 条守卫时，十条一开始全红。代码没错——**我把断言全部写在了 renderer sink 上**，而 bus 有两套投递口：
  - **session 目标**的帧走 `store.sendPromptTo`（序列化后注入那个会话），**不经过** sink；
  - **plugin 目标**的帧才 `sink.broadcast(message)`（给 desktop 界面）。
  房间消息的收件人是会话，所以它出现在 `sendPromptTo` 的入参里，sink 里一条都没有。
- **判据**：被断言的对象如果是"消息送达了没有"，先确认**送达这个词在这个组件里有几种写法**（这里两种），再决定观察哪个口。宁可先打印一次实际流向，也不要按直觉选口。
- **同族两坑（同一次实测撞出）**：
  - 数"熔断提示发了几次"时按**帧数**数 → 一张提示要投给房间每个成员，两个成员就是两帧，看着像"刷屏两次"；
  - 改按 **id 去重**数 → `broadcastToChannel` 给每次投递 `id: randomUUID()` **重新生成 id**，同一条逻辑提示在两处是两个不同 id，仍是 2。
  正确判据是**每个成员各收到一条**（按接收方分别断言），与"发了几个逻辑提示"无关。
- **推论**：一条断言写错"面"，症状与"功能坏了"完全一样。**十条同族断言同时红**时，优先怀疑断言而不是代码——同一次改动很难同时精确破坏十个不同行为。
