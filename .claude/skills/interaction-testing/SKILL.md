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

DOM 只断「呈现对不对」(右对齐/徽章/按钮在不在),数据正确性全走文件。文件名即 ns;fork 是同会话加 lineage(`fork:{parentLineageId,boundaryEntryId}`),不是新文件。

## 5 按内核的最小验证路径

**pi(默认)**:种 lastCwd → 等 `[data-timeline-composer]` → setComposer(原生 setter + input 事件)→ 发送 → 两阶段收敛 → 中立层文件断言。

**命令(/goal 等)**:命令是即时状态动作、永远不进内核消息流——发送前被 composer 拦截。**用真实键盘**(`page.click` 聚焦 + `page.keyboard.type` + `press("Enter")`),别用合成 KeyboardEvent(实测合成 Enter 在「发送在飞/流式」窗口会静默吃掉命令)。中止 goal 优先点目标条的「停止」钮(`[data-goal-phase]` 内的 button),比命令更直接。

**dsh**:先按 §1 备齐三件 → 模型下拉(`button[id^=radix]` 开 menu → 点 `DSH` 页签 → 选 `qwen3.8-max`)→ 发送。注意 dsh 无 thinking 档、事件形状不同(回合收敛 = turn/end 合成的 agentSettled)。

**消息动作全是「arm-confirm 两段式」**(收藏/分叉/重试/删除):第一次点 = armed(钮文案变「确认X?」),第二次点才执行。探针只点一次 = 没执行(r61 踩过)。重试的「重发」语义 = fork 当前 lineage + messaging.prompt 重发——重试后视图切到新分支,消息行数可能变少(旧分支的后续不在视图),不是丢消息。

**dsh fork(已厘清)**:服务端 fork 内核无关、有确定性单测守卫(`31b56efe`);UI 触发链(悬停→armed→确认分叉)在干净环境下正常。分支物化(分支发送后 assistant 回写分支 lineage)在慢端点下实测不稳定——根因多是 CDP `protocolTimeout` 截断(见上条),不是产品 bug。复核先确认 protocolTimeout 已拉大,再轮询中立层分支条目。

**跨内核边角(已厘清)**:pi 会话有历史后改选 dsh 模型再发,设计是显式降级抛错(「跨内核切换暂缓」)。早前实测的「渲染层 CDP 长阻塞」根因不是产品 bug,是 **CDP `protocolTimeout`(默认 180s)< 探针的等待超时(300s)**——单调用超 180s 被协议层截断成 `Runtime.callFunctionOn timed out` 假失败。已在 `scripts/demo/lib/app.mjs` 的 connect 补 `protocolTimeout: 600000`(c2ef99b2)根治。教训:凡是「等收敛/长回合」类等待,先确认协议层超时不比你的 timeout 小。

**goal 引擎**:`/goal limit N`(须先有别目标时无效,limit 只改现存目标;要限速先在设置里改 goal.maxRounds 再设目标)→ `/goal <目标>`(正文作为真实用户消息发出,所见即所得)→ `[data-goal-phase]` 观察 active→(暂停)→paused→(恢复)→active;留痕卡 role=`goal_note` 落中立层。

**ask 提问**:指令模型「调用 ask_user_question 问我…」→ 等 `[data-ask-question]` → 选项整行(单选点选即答;多选勾选+提交)。

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
