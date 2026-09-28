---
name: interaction-testing
description: 在 my-harness-desktop 做真实交互验证(DOM 级/E2E)与全仓质量审计时使用。覆盖拉起应用、隔离 HOME、CDP 驱动、DOM 锚点清单、虚拟化/时序陷阱、数据层 vs 渲染层断言分工、多内核差异、DOM 组装/文件格式/功能漂移的审计范式、假绿识别、守卫反向注入。触发词:交互测试、e2e、DOM 断言、CDP、puppeteer、冒烟、真实模型、会话流验证、写 e2e、DOM 审计、格式对账、功能漂移、i18n 检查、可访问性、假绿、守卫。
---

# 交互测试(my-harness-desktop)

本仓库的功能验证纪律是三级(CLAUDE.md §5.6):纯逻辑单测(vitest node)→ DOM 交互测试(vitest+jsdom)→ 真实 app e2e(puppeteer-core + CDP 驱动 `out/` 构建产物)。本文是第三级(真实交互)的实操手册——每一条都来自实踩过的坑,不是通用 puppeteer 常识。

## 0 索引(按主题速查;条目按轮号 rXXX 编号)

**基础设施与拉起**:§1 基础设施(lastCwd/端口/dsh 三件/seed/**静默开拉·不抢用户焦点**)| 官方 e2e 矩阵(r326)
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
**架构守卫**:依赖方向审计(r342,audit:deps)| **测试静默守卫(audit:quiet,§1)** | 测试文件 tsc 债(r335)
**套件稳定性**:ws-server 闪红根治(r355)瞬态重跑分类(r359/r372)刷新/重开渲染竞态(两个根因已修:① syncNonce 初始基线 null→ns 误重挂 Virtuoso;② sessionStart 只带 sessionFile 缺 neutralSessionId→renderer 回落 sessionInfos 反查落空清镜像。回点行重开用可信点击,别 dispatchEvent)思考块渲染瞬态(r380:kernel-thinking-matrix 幕A / pi-openai-thinking 偶发「文件有思考块但 DOM 无按钮」,数据已落中立层,模型裁量/时序相关,重跑分类)
**大回归节奏**:r332/r348/r359/r364/r372(每批修复后官方矩阵全跑)
**能力面×思考域(2026-09-07 轮)**:思考矩阵四幕 e2e(kernel-thinking-matrix)|能力面推送流水插桩(__capsLog)|模型项双禁用态(menuitem aria-disabled/inert div)|空思考帧 wire 级实证|dsh 思考档位补面验证(幕D)|新会话跨内核解锁(幕C)
**pi dsv4pro 无思考三层根因(r28-r33)**:网关 anthropic 错标 thinking_delta / 网关 openai 拒 developer 角色(桌面可修=supportsDeveloperRole 复选框 3aec332d)/ pi 配置只在 anthropic 协议(已配到 openai)——「同模型 pi 无思考 dsh 有」的逐协议打穿法
**fork→切内核(r23)**:fork 派生会话 pendingSeed 豁免锁定(pendingSeed=未物化≠历史)——fork pi 后可切 dsh
**in-mem harness(r19)**:Vite __vitePreload 相对 import 在 Node-ESM 挂起→直测预加载全 chunk 修复(87b072d5)
**内核插件补面 + 实证纪律(§10)**:行契约不变/hook 不同名(llm-recorder 的 dsh 侧)|插桩改变时序→无插桩复跑定论|守卫要先证明能红|数据层对≠DOM 对(列表跨作用域 key 必带 cwd)
**双内核「写半/读半」对齐怎么验(§16,r-hw1)**:钩子挂哪个面(构造面 vs 执行面)先自查|三级配方(假ctx驱动真钩子→假盘驱动真组件→真内核+mock模型真回合)|新 DOM 锚点(data-llm-log-row/state/detail)|判据用不变量不用魔法阈值|形状词典两套词汇并列认|`npm run e2e:dsh:recorder`
**全仓审计范式(§17,r7–r123)**:审计剧本 vs 功能剧本(静默缺陷的正向盲区)|五个必查面(结构/文案/**语言维度**/文件格式/能力面↔DOM)|假绿九成因(作用域选到叶子·选择器取第一个·不可见子树重复计数·检测集手抄混同形字·类型 bug 让断言恒真·路径 off-by-one·**扫描范围空而判据对**·**自检与判据耦合**·**量词门槛放过整类**) + 判据要用第二种实现独立复核|锚点三纪律(不按译文定位·不依赖第三方库属性·不凭空发明)|文件↔DOM 用不变量不用等式(中立层是超集:4 vs 7 vs 7)|大批量债务走棘轮清单|CDP 四硬约束(字符串求值不传参·Set 序列化变空·模板内反引号·&& 链静默跳过 build)|静态守卫与行为测试不可互替|硬编码文案三形态(属性字面量·**属性内表达式**·**数据里嵌展示文案**)与正则字面量假阳性(§17.8)|剧本基建要共用而非内联·审计发现先排除剧本自身准备缺陷(§17.9)|**延迟求值≠活**(快照改 getter 的两种错误形态与「先构造再改源」判据,§17.10)|waitForFunction 的 options 在第二位·断言写不变量不写阶段值·判据用词要查真实格式(§17.11)|设置页表单审计要落到**磁盘种类**·受控 checkbox 用可信点击·交互前先 scrollIntoView·别猜控件形态(§17.12)|列表类审计:归档=移进分组而非消失·有条件菜单项要双向钉·锚点分清开关与输入框·别写死行号(§17.13)|跨作用域缺陷单作用域剧本结构上撞不到·对账键要先查清·数量不变量强于逐行匹配·dnd-kit 行要用合成 click(§17.14)|**驱动不了的交互要分层覆盖、别留恒真断言**(framer-motion 拖拽诊断留档)(§17.15)|锚点要覆盖所有渲染分支·对账 key 查实现别凭直觉·占位行让索引差一位·改完必须重新 build(§17.16)|能力旗标审计先数消费者再判性质(0 消费者有三种可能,处置完全不同)(§17.17)|合成事件驱动不了某路径时:留**成对对照观测**的证据链、可测的那半下沉单测、做不到的如实记录(§17.18)|选区驱动 UI 用**程序化选区**不用像素拖选(三个连环坑)(§17.19)|entries 文件真实形状 {neutralSessionId,lineages}(§17.20)|按名字抓模式的守卫必须枚举**整个同族**(§17.21)|CSS 类名与死 locale 键是 TS 审计扫不到的两类泄漏面(§17.22)|同一数据有两个来源时,错的那个通常更"顺手"(§17.23)|语言包审计四陷阱(繁体形搜术语·同形异义要账本·**语言文件必须登记否则静默不加载**·范围含夹具)(§17.24)|跨内核复制粘贴用「不得提到别的内核」当判据(§17.25)|「文件对但界面错」:语言包审计必须落到**真实渲染结果**(两种形态+两层判据)(§17.26)|守卫写太宽=逼合法改动绕过它,具名回归锚要窄而实(§17.27)
**构建产物与测试基建的「假结果」(§11)**:|**三内核同场真回合**(§14)||**用 mock 模型给内核补零 token 真回合**(§13)||**全量 e2e 广扫抓到真 bug**(§12)|**先插桩再猜**(§12.2)改完 server 忘了 build→e2e 读旧代码|e2e 泄漏实例→下次连到旧进程|假守卫两副面孔(同实例 rerender / 行为对但机理不对)|静默 no-op 三例(缺关键帧/未声明变量/文档写的字段不存在)|常年红的门等于没有门|能力驱动渲染用 `=== true`|降级要成对验|断言写错"面"(同一件事两个投递口,11.9)|瞬态闪烁要录**序列**不是比两端(11.10)|重挂缺陷真 app 最短复现=切走再切回(11.11)|测试替身:身份要稳、形状要真(11.12)|运行态动效两条成因链,产物级守卫(11.13)|环境展不出该缺陷时守卫是假的(11.10)

## 1 基础设施(现成件,别重造)

| 件 | 位置 | 用途 |
|---|---|---|
| `launchApp` / `killApp` / `assertPortFree` | `scripts/demo/lib/app.mjs` | 拉起 electron(`--remote-debugging-port`)+ puppeteer 连 renderer 页;`assertPortFree` 防撞用户实例;**默认静默开拉**(见下) |
| `quietEnv` | `scripts/demo/lib/quiet-env.mjs` | 测试环境静默开关:默认 `MHD_WINDOW=hidden`(窗口永不 show、不抢用户焦点/鼠标、不弹系统通知);要看窗口显式 `MHD_WINDOW=shown` |
| `pngStats` | `scripts/demo/lib/png-ink.mjs` | 零依赖 PNG 解码 + "有没有内容"统计(不同颜色数 / 非背景像素占比)——判"隐藏窗口截图非黑"的尺子 |
| `makeRunRoot` / `setupBaseline` | `scripts/demo/lib/home.mjs` | 一次性隔离 HOME(/tmp/pi-demo-\<uuid\>);pi 内核符号链接借真实 HOME,models.json/settings.json 拷贝防写回 |
| `waitForDomIdle` | `scripts/demo/lib/util.mjs` | DOM 静默等待(事件驱动,不赌固定 sleep) |
| 场景种子 | `scripts/demo/scenarios/*` | seed.json + index.mjs,`applySeed(ctx, ...)` 组装演示状态 |
| **`dom-audit.e2e.mjs`** | `scripts/demo/` | **全仓审计**(非功能剧本):首屏 + 设置页逐子页 + 配置文件 + 能力面↔DOM 对账。`--locale zh-CN\|zh-TW\|en\|de` 逐语言跑(i18n 缺陷是**按语言**出现的);排除不可见子树并打印跳过数;H 级发现 → 退出码 2。详见 §17 |
| **`timeline-panel-audit.e2e.mjs`** | `scripts/demo/` | 内容区审计:时间线消息卡结构 + **文件↔DOM 对账**(内核 jsonl vs 中立层 vs 卡片数)+ 右面板逐窗格。零 token(minimal echo)。详见 §17.4 |
| `clickPointUntil` | `scripts/demo/lib/interact.mjs` | 可信点击 + 重试(每轮重算坐标,判据是"目标真的出现了"而不是"点过了")。切内核 TAB 这类"点了没反应就白等"的场景必须用它 |

**静默开拉(默认,别绕过)**:`launchApp` 默认注入 `MHD_WINDOW=hidden`。根因:应用开窗代码曾无条件 `win.show()`,macOS 上 `show()` 即激活应用——**用户正在打字的窗口失焦、鼠标被夺走**,每跑一次 e2e 就打扰用户一次(CLAUDE.md §5.6「测试静默」,设计原则 38)。静默态 = 不 show、`focusable:false`、`skipTaskbar:true`、不设 dock 图标、不发系统通知(`src/server/bootstrap/window-visibility.ts` 是策略单源)。

- **隐藏着照样能测**:e2e 要的是 CDP——JS 求值、`Input.dispatchKeyEvent`(`page.keyboard.type` / `page.mouse.click`)、`Page.captureScreenshot` 都不依赖窗口可见。静默态强制 `backgroundThrottling: false`;不关的话,窗口不可见时 Chromium 把定时器/rAF 降频到 ~1Hz,长回合会等不到收敛,表现成"产品坏了"的假红。
- **要看窗口必须显式授权**:`MHD_WINDOW=shown node scripts/demo/<剧本>.e2e.mjs`(人工观察、现场录屏)。别再往脚本里写 `show()` / `showInactive()` ——那是把"打扰用户"变成默认。`MHD_WINDOW` 写错值**启动即报错**(不静默回落 shown)。
- **守卫三层**:`npm run audit:quiet`(静态:凡 spawn electron 的脚本必须过 quiet-env;开窗代码不得回到无条件 `win.show()`)＋ `src/server/bootstrap/window-visibility.test.ts`(unittest)＋ `scripts/demo/quiet-launch.e2e.mjs`(真 app)。
- **写"有没有抢焦点"类断言的现成配方**(照抄 `quiet-launch.e2e.mjs`):① `lsappinfo front` 读前台 App 名(macOS,纯读、不弹权限),断言**不是**被测应用;② `window.kernel.window.isFocused() === false`(走产品自己的 Host 链路,不是脚本自说自话);③ "隐藏窗口真在渲染"用 `pngStats` 判——**空帧标尺:2560×1680 的纯色帧只有 1 种颜色、非背景像素 0%;真 UI 是数百种颜色、>50%**。别拿"PNG 文件挺大"当判据。

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
| `[data-session-action="rename\|pin\|archive\|open-desktop-file\|open-kernel-file\|delete"]` | 会话行**右键菜单**的六个动作（r22 新增）。⚠ Radix ContextMenu 要**真实右键**（`page.mouse.click(x,y,{button:"right"})`），合成事件不弹；菜单在 Portal 里，用 `[role=menuitem]` 或本锚点查 |
| `[data-session-rename]` | 会话行**重命名态**的输入框（r22 新增）。⚠ 它**不一定**是 `[data-session-path]` 的后代（SessionRow 与 ContextMenu.Trigger 是两层），别用 `[data-session-path] input` 这种层级猜测定位。它是 `defaultValue` + Enter 提交，替换前要先 `select()` 全选 |
| `[data-session-search-input]` | **真正的搜索输入框**（仅展开时渲染）。⚠ 别与 `[data-session-search]` 混淆——后者是**展开/收起搜索的按钮**。往按钮上打字的症状是「搜索没生效」，看起来像过滤坏了 |
| `[data-plugin-install="toggle|source|browse|submit"]` | 插件管理页的安装表单四件套（r96 新增）。**折叠开关与提交钮文本高度相似**（`pluginManager.install` vs `pluginManager.installBtn`），按文本匹配会反复点错——点开关等于把刚展开的表单又关上，症状是"提交没反应"（r95 白跑一轮）。提交钮另带 `data-installing="true|false"`，让"卡在 installing 态"这个 r80 的根因可被**直接断言**而不必靠推断按钮文案；开关另带 `aria-expanded` |
| `[data-settings-pane="<条目 id>"]` / `[data-settings-pane-active="true|false"]` | 设置页**内容面板**（r93 新增）。此前 pane 根元素无任何锚点，自动化无法判断"当前激活的是哪个条目"——只能靠 `[role=tabpanel]` 猜，而**无 `tabs` 的条目根本不渲染 tabpanel**，于是判据永假、误判成"点击无效"（r88/r89 连续两轮踩坑）。判激活态用 `-active`，不要用可见性（两个视图可能同时在渲染树里，r92） |
| `[data-settings-unsaved-dialog]` / `[data-settings-unsaved="cancel|discard|save"]` / `[data-settings-unsaved-title]` | 设置页「未保存修改」拦截对话框（r89 新增、r92 起被 `settings-controls-audit` 使用）。`guardNavigate` 在 `activeDirty` 时会**拦下导航**并弹此框；没有锚点时脚本无法区分"没点上"与"被拦了"（r88 的误诊源头之一） |
| `[data-collapsible-header]` / `[data-exec-status="running|error|success"]` | 共享可折叠卡片头与执行状态块（r57 收敛三个调用方；`data-tool-status`/`data-goal-tool-status` 已统一为 `data-exec-status`） |
| `[data-model-devrole]` / `[data-model-reasoning]` | 模型配置页里受**能力门控**的两个控件（r45 新增；只能按锚点验，按译文定位换语言就失效） |
| `[data-pagination="prev|next"]` / `[data-pagination-page="<n>"]` | 共享分页部件的箭头与页码（r38 新增；箭头是纯图标，可访问名由**必填** props 提供） |
| `[data-plugin-drag-handle]` | plugin-manager 每行的拖拽手柄（r38 新增；dnd-kit 给 role/tabIndex，可访问名要自己给） |
| `[data-composer-model-item="<kernel>/<provider>/<id>"]` + `-selected` / `-locked` | 模型下拉里的模型项与其状态（r34 新增）。⚠ id 自身可含 `/`，所以段数是 >=3，别用 split 取段 |
| `[data-composer-model-provider="<provider>"]` | 模型下拉的 provider 分组头（r34 新增；此前是裸 div） |
| `[data-settings-tab="<tabId>"]` + `-tab-active` | 设置页条目内的 TAB（r33 新增）。此前 TAB 按钮只有 `key`，被改的 `kernelModels` 路径 e2e 走不到 |
| `[data-kernel-custom-dir]` / `-browse` / `-apply` / `-clear` | 内核版本页的「自定义内核目录」输入框与三个按钮（r33 新增）。⚠ 按钮上的锚点能被 DOM 收到，是因为 r32 修了共享 `Button` 不透传 `data-*` 的缺陷（§17.31） |
| `[data-project-path="<绝对路径>"]` + `[data-project-active="true\|false"]` | 侧栏项目行与其激活态（既有锚点，r23 开始用于跨项目审计）。⚠ 该行同时挂了 dnd-kit 拖拽 listeners，**坐标点击不触发 onClick**，要用合成 `el.click()`（见 §17.14） |
| `[data-session-group="<groupId>"]` | 会话列表的**分组**（r22 新增）：`pinned`/`today`/`yesterday`/`last7days`/`earlier`/`archived`/`search`，另有 `data-session-group-open` 标折叠态。⚠ 归档不是「行从 DOM 消失」而是**移进 archived 组**（且该组默认折叠）——断言要查分组归属，不要断言行数变少 |
| `[data-session-new]` / `[data-session-search]` / `[data-session-refresh]` | 会话列表工具条的三个控件（r22 新增）。⚠ 列表**首行是「新对话」乐观占位行**，不是会话——按内容找行，别用 `rows[0]` |
| `[data-goal-phase]` | goal 目标条(active/paused/achieved) |
| `[data-ask-question]` | ask 提问卡 |
| `button[title]` | 图标按钮的唯一可达名(收藏/分叉/重试/复制/钉图钉/回退;侧栏图标条的 Review/Tree/统计 等) |
| `[role=menu]` + `[role=menuitem]` | 模型下拉(Radix) |
| `[role=menuitem]` | 右键菜单项(会话行右键:重命名/置顶/归档/打开两文件) |
| `[data-sidepanel-style]` | 右侧面板(**有两个**:图标条 w-12 + 展开面板 h-full,DOM 序展开面板在前且空)——取页签按钮必须用后代选择器 `[data-sidepanel-style] button[aria-label]`(单元素 querySelector 命中空面板得 0 页签,2026-09-08 踩过) |
| `[data-sidepanel-pane="<贡献项 id>"]` | **右面板的某个窗格**(r8 新增)。右面板是**多窗格 toggle** 语义(`toggleSidePanelTab`,`activeSidePanelTabs` 是数组),多个 Tab 可同时展开——没有窗格身份就没法判断"哪块内容属于哪个 Tab"。⚠ 别改用 react-resizable-panels 渲染出的 `data-panel-id`:那是**第三方库内部属性**(升级改名就全断),且不在本仓源码里,会被 `e2e-anchor-coverage.test.ts` 判红。⚠ 点**已开**的 Tab 会把它**关掉**(toggle),遍历前先读 `aria-pressed` |
| `[data-composer-pending-files="<n>"]` / `[data-composer-pending-file="<绝对路径>"]` / `[data-composer-pending-file-remove="<路径>"]` | composer 上方的**待发送文件条**（r26 新增）。chip 的身份就是绝对路径（附件是路径引用、不读 base64），所以直接落成属性值，按路径定位而不是按下标 |
| `[data-composer-pending-image="<src>"]` / `[data-composer-pending-image-remove]` | **待发送图片条**（r26 新增）。有 `dataUri` 才渲染 `<img>`（alt 取图片标题，无标题回落 `timeline.pendingImageAlt`），否则只显示 src 文本 |
| `[data-composer-readonly="<reason>"]` | composer 被**只读条**替换（r19 新增）。四种成因即四个 reason 值：`policy`（会话策略只读）/ `kernel-not-loaded`（会话归属的内核没装载）/ `kernel-required`（内核未安装）/ `open-folder-first`（未打开文件夹）。⚠ 出现只读条时 `[data-timeline-composer]` **不存在**（整个 composer 被替换掉，不是"能输入但发送才报错"）。⚠ 别按译文找它：四条文案全经 i18n，按文案匹配等于把测试绑死在某一种语言上（§17.3）——reason 属性就是为此存在的 |
| `[data-session-kernel-unloaded]` | 会话行的「内核未装载」角标（`session.kernelLoaded === false` 时渲染）。判据是**会话自己的** kernelLoaded，不是 `currentModel.kernel`：模型链只在"已装载内核的模型清单"里解析，孤儿会话的模型必然回落到默认内核的模型，按模型判会得出"内核可用" |
| `[data-message-meta]` | 消息行右下角的时间/指标 span（r21 从 `aria-label="message-meta"` 改过来——把机器标识符塞进 aria-label 会**覆盖**内容作为可访问名，屏幕阅读器会念出 "message-meta"。锚点归 data-*，可访问名归内容） |
| `[data-config-field="<字段 key>"]` | 内核配置表单里**某个字段**的行（r21 新增，key 是 dotted 形式如 `terminal.hyperlinks`）。字段清单由 parseSettingsSchema 从内核 .d.ts 动态解析，所以 key 是这里唯一稳定的身份——label/description 都是可缺译文的 i18n key，按译文定位不可靠 |
| `[data-settings-save="confirm\|discard"]` | 设置页顶部「未保存改动」浮层的两个钮（r21 新增）；保存中态另有 `data-settings-saving="true"`。⚠ 改完配置**必须点 confirm 才落盘**，只改不点等于没改（skill §2 早记过这条） |
| `[data-settings-back="chat"]` | 设置页左下角「返回对话」（r20 新增）。⚠ 此前只能按译文找，而它在四种语言下是四个不同字符串 |
| `[data-sidebar-entry="settings"]` | 侧栏设置入口(r8 新增)。⚠ 别按文案找:zh-CN「设置」/ zh-TW「設定」/ en「Settings」/ de「Einstellungen」——按文案匹配等于把测试绑死在某一种语言上(§17.3) |
| `button[data-composer-model]` | composer 的模型下拉触发器(值形如 `<kernel>:<provider>/<model>`)。⚠ 别用"带 svg 且文本长度>2 且不是思考档位"这类文案启发式:`closest("form")` 落空时会退回 `document.body`、点到页面上第一个符合条件的按钮(r8 实测 8s 等不到下拉)。**下拉是按内核分 TAB 的**,要先用 `clickPointUntil` 切到目标内核 TAB,否则菜单里只有当前内核的模型 |
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

### 11.10 瞬态闪烁：录**序列**，不是比两端；且先确认环境**展得出**这个缺陷

这是本轮最花时间的一条，因为**我连写了两版假守卫**才做对。目标：守住 #17「发送之后输入框的模型没固定」。

- **第一版（假）**：在 `minimal-smoke` 里比对"发送前 / 发送后"两次采样的 `[data-composer-model]`。
  删掉修复做红证 —— **照样绿**。根因：那个隔离 HOME 只把 minimal 的 `echo` **一个**模型摆上台，
  键漂之后显示掉到"清单首项/应用默认"**恰好还是同一个模型**，现象根本展不出来。
  → **判据一：环境展不出该缺陷时，守卫是假的。** 红证不是"改坏代码看它红吗"就够，
  还得先问"这个环境里，坏代码**能**产生可观测差异吗"。
- **第二版（仍然假）**：换成两个模型 + 默认≠所选，`data-composer-model` 会比出差异了。
  再删修复做红证 —— **还是绿**。根因：漂回默认后又被**中立层头域**（`headerPrefs`，spawn 时
  已写入所选模型）拉回来了。**#17 是个瞬态闪烁，不是持续的错误值**——两次采样之间的那一下，
  它自己愈合了。
  → **判据二：瞬态问题必须录序列。** 装 `MutationObserver`（监听 `data-composer-model`
  属性变化）+ rAF 周期采样兜底（元素可能被整块重挂，收不到 attribute 变更），
  把翻键窗口里**每一次**取值都记下来，逐条断言"没有出现过越界值"。
- **第三版（真）**：同样删掉修复 → 序列里出现 `pi:bifrost/dashscope/qwen3.8-max`
  —— 正是用户看到的那一下跳变 ✓。恢复修复 → 全程只有 `minimal:beta` ✓。

**两条通用判据**（值得单独记）：
1. **凡"跳变/闪烁/闪回"类问题，只比两端一定漏**。判据是"序列里有没有出现过不该出现的值"，
   不是"最后对不对"——最后往往是对的，用户抱怨的恰恰是中间那一下。
2. **做红证之前先问：这个环境展得出这个缺陷吗**？展不出（只有一个模型/只有一个内核/
   只有一次机会）就先改造环境，别急着宣布守卫有效。**红证失败时，先怀疑尺子，再怀疑修复。**

### 11.13 「运行态动效」有**两条**独立的成因链，只守一条等于没守

用户诉求 #15「运行中的图标要么动、要么明暗交替」。这条需求有两条**完全独立**的失败方式：

| 成因链 | 症状 | 该在哪一层守 |
|---|---|---|
| ① 引用的动画名**没有关键帧**（内联 `animation: "tool-live-pulse …"` 但全仓没定义 `@keyframes`） | 静默 no-op：不报错、不动 | 源码静态门（`animation-keyframes.test.ts`：用到的动画名 ⊆ 已定义关键帧 ∪ 框架内建） |
| ② **工具类根本没被生成**（Tailwind `@source` 漏扫某目录 → `.animate-pulse` 规则不在样式表里） | 类名还在、DOM 断言还绿，样式表里没规则 → 不动 | **构建产物级**守卫：查 `out/renderer/assets/*.css` 里有没有那条规则 |

第二条是本仓**复发过两次**的坑（`@source ../../plugins` 曾指向不存在的旧目录，插件内整批工具类漏生成）。
它躲过所有源码级守卫的原因很直白：**类名在源码里是好的**，坏的是"它没被生成到产物里"。

**判据**：UI 视觉类需求（动效/过渡/自定义工具类）的守卫要落到**产物**上——
`e2e` 里 `readdirSync(out/renderer/assets)` 读 CSS 断言规则存在（e2e 本来就要求先 build，产物一定在）。
红绿实证：删掉 `@source "../plugins/**/*.tsx"` → 重新 build → `.animate-pulse` 从产物里消失，断言当场红 ✓。

### 11.12 测试替身的两条纪律：**身份要稳**、**形状要真**

补 llm-recorder 面板的 DOM 守卫时，两个坑都长得像"组件坏了"：

- **身份要稳**：`vi.mock` 里的 `usePluginContext` 第一版**每次调用都返回新对象**。
  真实 `PluginContext` 跨渲染是同一个引用，组件据此写 `useCallback([ctx.fs, …])` /
  `useEffect([fullLoad])`。替身不稳定 → 依赖数组每渲染都变 → setState → **无限回环**，
  vitest worker 直接崩，报的是 `Worker exited unexpectedly`（看不出是回环）。
  **判据：替身与真实对象在"身份是否稳定"上必须一致**——否则你测的是另一套语义。
- **形状要真**：`fs.listDir` 的条目是 `{name, isDir}`，我写成 `{name, kind:"file"}`；
  分片名要**恰好等于**会话文件名（= 分片 1）或 `<base>.<N>.jsonl`，我先写了个 `*.log`。
  两处合起来的结果是面板读到空列表，现场显示 `panel.empty` —— **看起来像组件没渲染记录，
  其实是替身喂的形状不对**。判据：断言失败且现象是"什么都没有"时，先核对**替身喂进去的形状**
  与源码里真实读取的形状（`grep` 一次调用点的字段名即可），别急着改被测组件。

### 11.11 「重挂缺陷」在真 app 里的最短复现：**切走再切回**

- **场景**：缺陷形态是"组件被换掉了实例，局部 state 归零"（用户手动展开的思考块
  在定稿后自己合上 —— #18）。jsdom 里能用 `unmount()` + 全新 `render()` 复现，
  但那只证明"换个实例会归零"，**不证明真 app 里真的会换实例**。
- **真 app 里的最短路径**：**点开另一个会话，再点回来**。
  Virtuoso 的 `computeItemKey` 随消息 id 变化（流式 id → `neutralEntryId`）、
  切会话时整份消息列表重建 —— 两条都会换实例，而"切走再切回"是最容易复现、
  最贴近用户动作（"我看着看着…"）的那条。
- **红绿实证**：把 `thinkingOpenOverride` 的赋值删掉（= 修复前）→ 「切走再切回后仍保持展开」当场红
  （`second=false third=false`）；恢复 → 绿。**这才算真守卫**（此前只有 jsdom 那条）。
- **配套坑**：判"切走了没"**不能用 `body.innerText`** —— 侧栏会话行的 `lastMessage`
  预览会把上一个会话的内容一直留在 body 里（§3.5 那条），拿 body 判永远为假。
  判据要收窄到**消息区**：`[...document.querySelectorAll("[data-message-id]")]`。

**附带一条工程纪律**：确认第一版是假守卫之后，我没有把它留在 `minimal-smoke` 里充数，
而是**把它降级成诚实的弱断言**（"锚点渲染出模型"）并在注释里写明"#17 的强守卫在专用 e2e"。
**留着一条自己知道抓不到东西的断言，比没有断言更糟**——它会让人以为这块被守住了。


## 12 全量 e2e 广扫：一条自己找上门的真 bug（本轮）

### 12.1 为什么要跑**全部**零 token e2e，而不是只跑跟改动相关的

本轮跑了一遍库里全部 39 个 e2e 中"种子态/无真模型"的那些 —— **脚本已入仓**：
`bash scripts/demo/sweep-zero-token.sh`（24 条；用法见脚本头注释，含失败自动复跑分类）。
结果 **20 通过、1 失败** —— 失败的是 `minimal-fork`，而且它不是我这轮改出来的，
是一条**一直躺在那里、平时没人走的路径**上的 bug：

> **任何由分叉（fork）或 seed 物化出来的会话，第一条 assistant 回复会从中立层里静默消失。**
> 内核文件里**有**这条回复（内核没做错），但中立层没有 → DOM 读中立层 → 用户看不到回复。

这条路径 `fork.e2e.mjs`（pi 侧）**验不到**：它零模型、fork 完没有回复可断言。
minimal 侧有内置 echo（零 token 也能真回复），所以只有 `minimal-fork` 能照出它。

**纪律**：改动面相关的 e2e 是底线，不是上限。**定期把全部零 token e2e 跑一遍**——
它们的价值恰恰在"你此刻没想到的那条路径"。这也解释了为什么值得给每个内核都留一条
能自产回复的零 token 通路（minimal 的 echo 就是这种"探针内核"）。

### 12.2 **先插桩，再猜**：本轮我连猜错两次

症状：fork 后发消息，DOM 里没有回复。我的三次假设，以及代价：

| 假设 | 怎么排除的 | 代价 |
|---|---|---|
| ① 等待预算太紧（10s 冷启动不够） | 调到 60s **仍然失败** | 一次 e2e 运行 |
| ② minimal CLI 在"预置过会话文件"时不发 `messageEnd` | 写了个**独立探针**直接 spawn CLI 对比两种形状：都发 ✓ | 一个 30 行脚本 |
| ③ 兜底：**插桩**（`writeThroughMessageEnd` 入口 + append/skip 分支 + 条目清单） | 一次运行就看到了 `SKIP-idempotent`，且那条 id 绑在**上一段历史**的 seeded 条目上 | 一次 build+e2e |

**判据**：症状"某个东西没出现"时，**别再往下猜**（我猜了两次，一次是超时、一次是内核事件），
直接在"它本该出现的那一步"插桩，打印"进来了吗 / 走了哪个分支 / 现场数据长什么样"。
插桩的成本是**一次 build**，猜测的成本是**每次一个 e2e 周期而且还不一定收敛**。

### 12.3 根因形状：「按角色向前找第一个未绑条目」这类**无界回溯**

`backfillKernelEntryId`（圆心纯函数）的作用是"写穿刚 append 的那条还没 id，
等 `entryAppended` 把权威 id 带回来补上" —— 候选**只可能在**本回合的尾巴上。
而它当时写的是"从后往前找第一个未绑的同 role 条目"，会**穿过整段历史**：
fork/seed 物化出来的会话里，继承来的条目**都没有 kernelEntryId**（它们是投影来的），
于是新一轮 assistant 的 id 被绑到了**旧的** seeded assistant 上 →
紧接着同一条的 `messageEnd` 判定"该 id 已存在"→ **幂等跳过** → 这条回复静默消失。

修法：**已绑定的条目是"上一回合既成内容"的边界，遇到就停**。
判据（一般化）：**任何"回溯查找"都要有界**——问自己"最远应该找到哪"，
并把这个界写成代码里的显式条件（这里就是 `if (e.kernelEntryId !== undefined) break`），
而不是靠"通常找不到那么远"。无界回溯 + 幂等跳过 = **静默丢数据**，是最坏的一类组合。

守卫：`packages/shared/src/domain/session-neutral.test.ts` 两条（越界不绑 + 正常尾巴照绑），
红绿证明：去掉边界 → 第一条当场红。真 app 侧 `minimal-fork.e2e.mjs` 从"必失败"变"通过"。

### 12.4 又一次被"产物陈旧"骗到（§11.1 的复发形态）

定位过程中有一批 e2e（minimal-smoke / thinking-block / minimal-fork）**同时**开始失败，
我一度以为自己的改动炸了全局。真相是：我在**同一个命令链**里 `cp` 文件 + `npm run build` +
跑 e2e，其中一次 build 与文件改动交叠，`out/` 处于半新半旧状态。
重新 build 后同一批 e2e 全绿。

**纪律**：改完源码 → **单独一次 build** → 再跑 e2e。不要 `改文件 && build && e2e` 串成一条，
也不要在一批 e2e 全红时先怀疑自己的改动——**先重 build 再复跑一次**（成本一次 build，
收益是排除掉一整类假信号）。

### 12.5 顺手修掉的一处测试抢跑

`minimal-fork` 另一处偶发失败：点开会话后**一次性** `evaluate` 找 assistant 行，拿到 null →
报 `Cannot read properties of null (reading 'x')`（像代码 bug，其实是尺子抢跑：
`[data-message-id]` 已出现 ≠ 那条行已经渲染完，Virtuoso 是分批挂行的）。
改成 `waitForFunction` 轮询等目标行（事件驱动），并在超时时抛出**说人话**的错误。
**判据**：DOM 查询若可能"还没到"，一律用等待而不是一次性读；一次性读的 null 会被误读成崩溃。


## 13 用 mock 模型给内核补「零 token 真回合」（本轮新增 `dsh-round.e2e.mjs`）

### 13.1 为什么 dsh 侧一直缺一条真回合 e2e

dsh 的真回合此前**只能靠真 key**：`dsh-smoke` / `dsh-multiturn` / `dsh-credentials` 都写着
"前置：app 已运行 + 真凭证"。于是：
- 用户诉求「一定要有 pi 和 DSH 的调度测试」在 dsh 侧**只到派发为止**
  （`kernel-dispatch` 验的是 setModel 路由 + 能力指纹，没有跑完一轮）；
- #20（dsh 执行时右侧请求记录）**连能跑的 e2e 都没有**，只有两半单测。

### 13.2 配方（照抄即可，`scripts/demo/dsh-round.e2e.mjs`）

1. **本地 mock OpenAI 兼容 SSE**：`node:http` 起在 `127.0.0.1:0`（拿随机端口），
   `/v1/chat/completions` 回两段 `data: {...delta...}` + `finish_reason` + `[DONE]`。
2. **隔离的 provider 配置**：`setupDshKernel(home, realHome)` 会把根落到隔离 HOME，
   再用一个**只含 mock provider** 的 `settings.yaml` 覆盖它
   （`llm-pi-ai.providers.<id>`：`api: openai-completions` / `baseURL` / `apiKeyEnv`）。
   key 走**环境变量**（`launchApp` 的 env），不落盘、不进仓库。
3. 之后就是常规 e2e：选模型（多内核才有内核 TAB，**条件式**）→ 发送 → 等回复 → 落盘对账。

**收益**：dsh 的**真内核、真 JSON-RPC、真会话落盘**整条链路变成零 token 可反复跑。
本回合就靠它补上了 #20 的端到端守卫（request/response 记录真的落盘）。

### 13.3 mock 必须**像**真协议：少一个字段，现场像内核坏了

第一版 mock 的 SSE 只发了 `delta.content` 和 `[DONE]`，dsh 侧报
**「生成失败：Stream ended without finish_reason」**——看着像 dsh 内核坏了，
其实是我这个替身不像 OpenAI（末尾要有一帧 `finish_reason`）。
**又一次「替身的形状要真」**（§11.12）：写协议级 mock 时，**照着真实协议帧补全**
（role 帧 / content 帧 / finish_reason 帧 / [DONE]），别只发"够用"的那几帧。

### 13.4 判据要照**契约**写，别自己加码

补 #20 断言时我先写了「response 必须带数字状态码」——**红了**。查契约才发现
`ResponseLine.status` 是可选的（扩展侧注释："连接级失败无 status(after_provider_response 未触发)"），
dsh 的结算路径本来就不一定带。面板对 `undefined` 渲染 `—`，而**「未返回」的判据是
response 行为 null（孤儿）**。改成"每条 request 都有配对的 response"就对了。
**判据比契约强 = 假红**；写断言前先读一眼被断言字段是不是可选。

### 13.5 又一次被自己吞掉的错误（§10.3.2 的复发）

同一轮里，我的读日志辅助写成了：

```js
const readLogs = () => { try { return readdirSync(logDir)... } catch { return []; } };  // ✗
```

而 `readdirSync` **根本没 import** → ReferenceError 被这个 catch 吞掉 → 断言报"0 条记录"，
现场看着像"扩展没写盘"，其实盘上**明明有**（我用手工 `cat` 一眼就看到了）。
**诊断期的 catch 就是会这样骗你**：要么别 catch，要么至少把错误打出来。


### 13.6 同一症状的**第二个根因**：盘上有了 ≠ 面板看得见（dsh 上的 #20）

补完"盘上真有记录"的断言之后，我又把断言推到**面板 DOM**（开右面板 → 点「请求记录」页签 →
断言出现 `#1` 且不是「未返回」）。结果当场红：面板显示 **「这个会话还没有请求记录」**，
而盘上记录好好的。

根因（与 §13.2 那次完全不同）：`shardNumber(fileName, base)` 的 `base` 取自
`currentSessionPath` 的 basename，而**那个路径的形状是各内核自己的**：
- pi 的会话路径是 `<ns>.jsonl` → base 自带 `.jsonl`；
- dsh 的会话标识就是 `<ns>`（无后缀）。

写侧恒把首片命名成 `<标识>.jsonl`，于是 dsh 上 base=`<ns>`、文件名=`<ns>.jsonl`：
既不相等、切片又是空串 → 判 null → **一个分片都匹配不上**。
修法：base 无 `.jsonl` 后缀时补上再比（对 pi 向后兼容）。

**两条判据**：
1. **"数据层对了"不等于"用户看得见"**（§10.4 的老话，这次以新形态复现）：
   同一条用户症状在 dsh 上有**两个独立根因**——一个在写侧结算时机、一个在读侧分片匹配。
   只断言盘上文件，第二个根因**永远照不出来**。UI 类症状的守卫要一路推到**用户真正看的那个面**。
2. **别把某个内核的路径形状当成通用约定**：`shardNumber` 是在"我只见过 pi"的时候写的，
   于是把 "<basename 自带 .jsonl>" 当成了事实。多内核下，**任何拿会话路径做字符串运算的地方
   都要先问一句"这个形状是哪个内核的"**（同类：`data-session-path` 的值在 pi/dsh 上形状就不同）。

### 13.7 假失败分类：先单跑，再怀疑代码；"点了没反应"多半是**点击打偏**

本轮全量广扫出现 4 个失败，**逐个单跑全部通过**。纪律：

1. **一批 e2e 失败时，先逐个单跑一遍**（顺带重 build 一次，见 §12.4）。广扫是连跑 N 个 app，
   环境抖动会让"看着像功能性失败"的东西混进来；单跑能立刻把它们分出去。
2. 分出去之后**不要就此结案**——找出抖动的**机制**。本轮机制很清楚：失败的簇集中在
   "点内核 TAB 之后期望的模型项没出现"，现场 dump 是 `tabs: ["pi","minimal"]` 但 items 全是 pi 的
   → **TAB 没生效**，而根因是**点击打偏**：菜单刚打开时还在动画，一次性取
   `getBoundingClientRect()` 拿到的位置与最终位置不一致，可信点击落到了别处。
3. 修法是加原语而不是加 sleep：`clickPointUntil(page, locate, predicate, {tries})` ——
   算点 → 点 → **每次重算坐标**（动画结束后才稳定）→ 直到判据成立或有界重试用尽；
   判据直接用**"目标项可见"**，于是把"打偏"和"重渲染未完成"两种情况一起覆盖。
   修完连跑 3 次 + 全量广扫 23/23 全绿。

**判据**：UI 里"点了没反应"的假失败，八成是**点在动画中间**。凡是"点 → 等某个东西出现"的流程，
都值得用"点+重算+判据"的循环，而不是"点一次 + 等很久"。


## 14 三内核同场真回合：`multi-kernel-round.e2e.mjs`

### 14.1 与另两条的分工（别重复做）

| e2e | 验什么 |
|---|---|
| `kernel-dispatch.e2e.mjs` | **派发**：setModel 路由到哪个内核 + 能力指纹（extension/thinking），不跑真实回合 |
| `dsh-round.e2e.mjs` | **dsh 单内核**真回合 + 请求记录链路 |
| `multi-kernel-round.e2e.mjs`（本轮新增） | **三个内核在同一次 app 运行里各跑一轮**，且**互不污染** |

最后一条回答的是"别哪里给覆盖了"这类问题：共存时各自还能跑完一轮吗？会话文件/中立头/DOM 行会不会串？

### 14.2 配方：一个 mock，三份内核配置

一个本地 mock OpenAI 兼容服务同时伺候三个内核，但**三份配置格式完全不同**（这是多内核最真实的摩擦面）：

| 内核 | 配置文件 | 形状要点 |
|---|---|---|
| pi | `~/.pi/agent/models.json` | `providers` 是**字典**（`{<id>: {baseUrl, api, apiKey, models[]}}`）；`settings.json` 的 `defaultProvider`/`defaultModel` 要一起改，否则默认指向已不存在的 provider |
| dsh | `~/.dsh/settings.yaml` | `llm-pi-ai.providers.<id>` + `apiKeyEnv`（key 走环境变量，不落盘） |
| minimal | `~/.minimal/agent/models.json` + `.credentials.json` | `providers` 是**数组** + `default` |

mock 的回复**回显请求里的 model id**（`答复来自 <model>`），于是"这轮是谁答的"从 DOM 文本就能判，
不需要额外探针。断言：每轮 composer 固定到该内核的模型、回复进时间线、
三份中立头各有一个该内核的会话、左栏三行、**minimal 文件落 `.minimal/`、pi 文件落 `.pi/`**（各写各的根）。

### 14.3 两条踩到的坑（都是 page.evaluate 的闭包/形状）

1. **`page.evaluate` 是跨进程序列化的，闭包变量传不过去**：我把内核名/模型名写在闭包里去查元素，
   页面里拿到的是 `undefined` → 报 `modelName is not defined`。**必须显式当参数传**：
   `page.evaluate(fn, arg)`；`clickPointUntil` 也因此加了 `arg` 透传（写进它自己的注释）。
2. **下拉里显示的是"显示名"，不是 model id**：我第一版拿 id（`mock-pi`）去菜单里找，找不到。
   两套名字都要有：**id 用于"谁答的"**（mock 回显请求里的 id）、**name 用于在 UI 里点**。

### 14.4 一次瞬时失败与它的价值

首次跑通前有过一次失败：mock 收到了 `mock-pi`、**中立层里回复也在**，但 DOM 一个消息行都没有
（`messages: []`）。重跑 3 次全绿。**判据**：这类"数据层对了、DOM 空"的瞬时态，
先按 §13.7 单跑分类；同时把失败诊断**加到能自证的程度**——
本文件在失败时会打出 `timelineMounted` / `bodyHead` / `sidebarRows`，
下一次它再犯时就能一眼看出是"没开会话"还是"开了但没渲染"，而不是再来一轮猜。

### 14.5 广扫脚本入仓：`scripts/demo/sweep-zero-token.sh`（带**失败自动复跑分类**）

广扫此前是我临时敲的循环，这轮把它落进仓库并加了一条关键机制：**失败自动复跑一次**（间隔 3s），
结果分三档报：

| 报法 | 含义 | 该怎么办 |
|---|---|---|
| `PASS` | 一次过 | — |
| `FLAKY` | 首跑失败、复跑通过 | 抖动。**别当回归**，也**别就此结案**——找出机制（见 §13.7） |
| `FAIL(2x)` | 复跑也失败 | 可信失败，按正常流程定位 |

动机是实测出来的：连跑 N 个 app 会互相挤资源，一批里会冒出若干"DOM 还没渲染出来就超时"的失败
（`messages: []`、`Waiting failed: 8000ms exceeded`），逐个单跑又全绿。
加了这个脚本之后一次全绿：`PASS=24 FLAKY=0 FAIL=0`。
**单次结果不足以判定**——把"抖动"和"回归"分开报，广扫的结论才可信。

### 15 「生成失败: next is not a function」——替身**多给一个参数**，把真 bug 挡在门外

**用户症状**：界面上一条消息报「生成失败」，正文是 `next is not a function`。

**根因**：dsh 的钩子**派发方式不同、参数就不同** ——
`dispatch.waterfall("…")` 有 `next`（要 `await` 它拿上游值），`dispatch.serial("…")` 是纯事件
**没有 `next`**，`ctx.events.dispatch("emit", […])` 也没有且 dsh 会**吞掉监听器异常**（只打 warn）。
我们的 llm-recorder 扩展在 `agent/turn-stopping`（**serial**）上写了 `return next()` →
**每次回合边界都抛 TypeError → 回合被标失败**。而记录是**先写后抛**，所以盘上看着正常、
界面却报生成失败 —— 只断言文件、或只断言回复，都照不出它。

**为什么单测没抓到**：假 ctx 的 `fire` 给**每个**钩子都塞了一个 `next`。替身比现实多给一个参数，
正好把这个 bug 挡在门外（§11.12「替身的形状要真」的同一条，这次代价是线上可见的失败）。

**三条纪律**：
1. **替身的参数表要照抄现实**：不是"多给一个不会错"，而是"多给一个就测不到契约"。
   现在 `dsh-extension-flow.test.ts` 的 `fire` 按钩子类型决定给不给 `next`（表里带 dsh 证据位置），
   于是同样的 bug 会当场报 `TypeError: next is not a function`。
2. **静态契约守卫**（`dsh-hook-contract.test.ts`）：扫我们自己的扩展源码取每个钩子的形参，
   与"DISPATCH 表"（waterfall / serial / emit，每条都写了 dsh 里的证据位置）对比；
   用 `next()` 的钩子必须是 waterfall，非 waterfall 不许声明 `next` 形参。装了 dsh 时还**顺便复核表本身**。
3. **对外部宿主（内核）的 API，去它的**实现**里核对，别只信文档/注释**：
   `grep -rhoE 'dispatch\.(waterfall|serial)\("[^"]+"' @deepseek-ai/*/lib/*.js` 一行就能列出
   全部钩子的派发方式 —— 这一条比读文档可靠得多，也解释了"为什么同一个文件里三个钩子只有一个炸"。

**e2e 判据**：`dsh-round.e2e.mjs` 增加"时间线里没有「生成失败」"——直接断言**这一轮没被标失败**
（数据层断言照不出"回合被钩子带崩"，必须打用户看得见的那个面）。
红绿证明：把 `return next()` 放回去，该断言当场红，正文与用户报的一模一样。


## 16 双内核「写半 / 读半」对齐怎么验（llm-recorder 轮，r-hw1）

> 场景：一个壳插件，数据由**内核进程内的扩展**写文件（写半），**桌面插件**读文件渲染（读半）。
> 两半不共享代码、不共享类型，只共享文件契约；两个内核各有一套写半。这类结构的 bug 有个共同形状：
> **两半各自单测都绿，拼起来是空的**。本文是这一轮的实操记录，配方可直接照抄到下一个同类插件。

### 16.1 先问「钩子挂在哪个面」，再写一行代码

本轮的真根因不是"字段没取到"，而是**钩子挂在构造面**：dsh 的记录挂在 `agent/request`，它的契约
`LlmCallConfig` 只有 provider/model/思考档位/采样五项；完整请求（messages/system/tools）在执行面
——`llm` 服务的 `llm/stream` waterfall，参数 `GenerateOptions`，其类型注释就是
*A single model request, fully assembled*。用户症状「DSH 一直只有 67B、核心内容全无」= 一条 148 B 的配置行。

**自查三步（任何一个"记录/观测"类插件都适用）**：
1. **列钩子的契约字段**：打开宿主类型定义，把候选钩子的 payload 类型抄下来，逐个问"我要的东西在不在它的契约里"。不在 = 换面，不是"想办法凑"。
2. **去实现里核对谁在调它**：`grep -rn 'waterfall(\|dispatch\.\|emit(' ~/.dsh/node_modules/@deepseek-ai/*/lib/*.js`。有别的消费者（本轮：agent-loop / session-title / checkpoint-policy）说明它是**公开扩展点**，不是内部细节。
3. **对齐 pi 侧站的位置**：两侧在同一层才有同等保真度。pi 的 `before_provider_request` 与 dsh 的 `llm/stream` 是同一层（执行面）——这就是"对齐"的判据，而不是把配置"补全"成请求体（那是影子实现）。

**反面教材（本轮踩过）**：`agent/request` 的返回值是 `await next()` 拿到的 `LlmCallConfig`——它**看起来**像"请求"（有 model、有 provider），实际只是"打算怎么发"。判断方法是看契约类型名与字段清单，不看调用点长得像不像。

### 16.2 三级配方（每级都用**真**钩子/真组件，替身只替环境）

| 级 | 替身替什么 | 被验的东西必须是真的 | 本轮文件 |
|---|---|---|---|
| unittest | 假 `ctx`（只实现 `on`）+ 假 chunk 流 | 真扩展模块、真落盘（临时 cwd）、真 seq/分片/index | `dsh-extension-flow.test.ts`（12 条） |
| DOM | 假 `ctx.fs`（假盘，内容是**真**行）+ mock `usePluginContext`/`react-i18next` | 真组件树、真字典文案、真 data 锚点 | `renderer/dsh-rows.dom.test.tsx`（5 条） |
| e2e | 本地 mock SSE 模型（真内核 + 真 JSON-RPC + 真落盘） | 真 app、真 dsh 内核、真回合、真 DOM | `scripts/demo/dsh-round.e2e.mjs`（31 条） |

**跑法**：`npx vitest run src/plugins/insight/llm-recorder` → `npm run build` → `npm run e2e:dsh:recorder`
（零 token：mock 模型；真 app 走 `launchApp` 的静默默认，不抢用户焦点）。

### 16.3 DOM 锚点：按 data 属性查，并且把「状态」做成属性

本轮给记录行加了三个锚点（**壳插件给自己的 DOM 加 data 属性是合规的**，属于内容层）：

| 锚点 | 含义 |
|---|---|
| `[data-llm-log-row="<seq>"]` | 记录行本体（点它 = 展开/收起详情） |
| `[data-llm-log-state="ok\|pending\|failed"]` | 这一行的机器可读状态 |
| `[data-llm-log-detail="<seq>"]` | 展开后的详情容器（六个分区都在里面） |

**为什么状态要做成属性**：原来"失败"只能从颜色看出来（`--color-danger`），而颜色是主题的事、随主题变。
判据不能依赖它。状态属性是契约，颜色只是它的一个投影。

**e2e 里怎么点开**（避免"点击打偏"）：
```js
await page.evaluate(() => {
  const row = document.querySelector("[data-llm-log-row]");
  row?.querySelector("div")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
});
await page.waitForFunction(() => document.querySelector("[data-llm-log-detail]") !== null, { polling: 200 });
```

### 16.4 判据：写**不变量**，不写魔法阈值

反面（本轮第一版，跑出来 462 就红了）：
```js
expect(row.length).toBeGreaterThan(500);   // 拍脑袋的数，测的是我的想象
```
正面（照契约写）：
```js
expect(row.length).toBeGreaterThanOrEqual(bytes(messages) + bytes(system) + bytes(tools)); // 行必须装得下内容
expect(payload.messages).toHaveLength(200);        // 长上下文会话不许退化成配置行
expect(respText).toContain("mock 回合的回复");       // 响应里要有模型真正答的那句
```
另一条：**别自己加码**（§13.4 的老账）。`status` 是可选字段，断言"必须有数字状态码"是我发明的强条件。
本轮又踩两次，都是同一种形状——**判据分两档，别把"形状定档"写成"契约定档"**：
- 「System 提示」分区**不是契约保证的**：`system` 在顶层（Anthropic 形状、dsh 的 GenerateOptions）
  才画得出来；**OpenAI 形状没有顶层 system**（它的 system prompt 是 messages 里 role=system 的一条）。
  要求两内核都出现它 = 发明条件；正确写法是「契约定档（请求/响应/消息历史/原始 JSON）两内核都要有」＋
  「形状定档（工具定义看 tools、System 提示看顶层 system）有才画」。**先把判据归类，再写断言。**

### 16.4b 对账断言是这一轮最值钱的东西

本轮新加的「**两内核文件对账**」（在 `multi-kernel-round.e2e.mjs` 里）一口气抓出一条真缺陷：
`index.json` 的桶键在两个写侧不是一套约定——同一份文件里出现 `{"xxx.jsonl":…}` 与 `{"yyy":…}`
两种键空间（pi 用 `path.basename(sessionFile)`，dsh 用了裸会话标识）。统计页只做聚合求和，
**肉眼与既有断言都看不见它**；只有"拿 index 的键去 join 实际文件/行数"才照得出来。

对账断言的形状（可照抄）：
```js
// 桶里的 requests 必须等于该会话实际落盘的 request 行数（按首片文件名为键）
for (const [stem, rec] of perStem) {
  const bucket = idx.sessions[`${stem}.jsonl`];
  if (bucket.requests !== rec.reqs) 报红;
}
// 文件名 ↔ 会话：dsh 日志文件名必须真的是某个 dsh 会话 id（面板按会话定位，错一个就看不到记录）
// 分片命名：首片无编号、续片 .N.jsonl 且 N>=2
// 两内核都要有记录 + 每行都带 messages + 请求响应成对
```
**"文件是否对应、格式是否对应"这类用户提问，答案就在这种断言里**——不是读代码读出来的。

### 16.5 「数据层对 ≠ DOM 对」在双内核下是**三处**都要断

本轮把同一件事在三个面上各断一次，缺一层就会漏：

1. **盘上**：request 行 8581 B（旧 147 B）、`messages` 非空、`system` 526 字符、`tools` 11 个、`sessionId` 在、`signal` 已丢。
2. **DOM 结构**：点开详情 → `请求 / 响应 / System 提示 / 工具定义 / 消息历史 / 原始 JSON` 六个分区齐全、`data-llm-log-state="ok"`。
3. **用户可见的负面面**：面板里没有「未返回」、时间线里没有「生成失败」、页面零报错。

**本轮三处各抓到一个真问题**：盘上全量但 DOM 少一段（provider 重复渲染被 DOM 守卫抓出）、
失败行被判成成功（`error` 字段读侧不认）、空 message 被报成"形状未识别"（把读侧缺口说成数据畸形）。

### 16.6 读侧形状词典：按**形状**认两套词汇，不按内核身份分支

同一个概念，两个内核的原生词汇不同（`reasoning`/`thinking`、`tool-call`/`tool_use`/`toolCall`、
`parameters`/`input_schema`、`inputTokens`/`input`、`stopReason:{kind}`/字符串）。
做法是一张**形状词典**放在纯模型层（`core/payload-model.ts`），读侧不出现任何 `if (kernel === …)`——
换第三个内核只要它吐这两套里的任一套，面板就能画（§7.5 三条不变量的落地形态）。

断言这类适配的写法：**两套词汇各喂一遍，断言归到同一个中性结果**（`blockToPart` 的词典用例）。

### 16.7 本轮踩到的坑（都不是产品 bug，是"测试/工具自己的假象"）

1. **`--port 9363` 让端口变成 1**：`dsh-round.e2e.mjs` 用 `--port=9363` 形式解析；传空格分隔时
   `args.port === true` → `Number(true) === 1` → 等 CDP 端口 1 超时。**报错信息里那个数字要读**。
2. **build 之后才加 DOM 锚点**：先跑了一次 build 才发现锚点是后加的 → e2e 找不到锚点。
   顺序固定为 **改代码 → build → e2e**；`out/` 是产物，插件代码变了必须重打（§11.1 同源）。
3. **模块级状态的"假重启"用例**：旧的"进程重启续号"用例新建了假 ctx，却复用同一份模块级 `Map`
   ——那条路径根本没被走到（守卫是假的）。用 `vi.resetModules()` + 重新 `import()` 造真新实例，
   才照出"分配 seq 前必须先与磁盘对账"这个真缺陷。
4. **`git commit -m "…"` 里的反引号会被 shell 执行**：commit message 里写
   `` `node scripts/demo/…` `` → 命令替换**真的跑了那两个 e2e**（几分钟）+ 消息被污染 + commit 失败。
   **多行/含反引号的消息一律走 `git commit -F -` + heredoc**，别用 `-m "…"`。
5. **守卫自己的解析器也会错，而且假红比没守卫更坏**：`dsh-hook-contract.test.ts` 数形参用
   `pattern.split(",").length`，把解构模式 `({ agent, messages, step, signal }, next)` 数成 5 个；
   又用"非 waterfall 不许有第二个形参"的启发式，把 `session/event (session, event)` 判红
   ——**emit 钩子的参数是事件自己的参数，`session/event` 就是 2 个**。
   两条都会逼着人把正确的代码改错。修的是**守卫的模型**（表里加 `args: 真实参数个数`，
   判据改成"形参个数 ≤ args 且非 waterfall 不许调 next()"），不是改代码迎合错误规则。
   教训：**守卫报红先问"守卫的模型对不对"**，尤其在它刚被你引入新场景（新钩子/新形状）的时候。
6. **改动收尾要"扫一遍自己"**：本轮最后把 diff 当外来代码读了一遍，抓出
   `dsh-extension/extension.json` 的描述还写着旧行为（"dsh 只给 LlmCallConfig，故原样记配置"）
   ——这是扩展管理页要展示的文案，属于"文档与代码同批同步"的一部分，很容易漏。

### 16.8 交付清单（同类任务的完成定义）

写半改造 + 读侧对齐 + i18n 四语 + 设计文档（根因与终态）+ 插件技术文档（§13）+ 三级测试全绿
+ e2e 真回合 PASS + 截图留证 + 文档与代码同批提交（CLAUDE.md §5.5）。
**没有"应该没问题"**：每一处结论后面都要跟一个能复现它的命令。

## 17 全仓「DOM 组装 / 文件格式 / 功能漂移」审计范式（r7–r9）

前 16 节都是**功能剧本**：验某条路径通不通。本节是另一类——**审计剧本**：不预设要验哪个功能，
而是把整棵 DOM / 整批落盘文件扫一遍，找"功能照常、页面不报错、但结构已经坏了"的东西。
两个成品：`scripts/demo/dom-audit.e2e.mjs`（首屏 + 设置页遍历 + 配置文件 + 能力面对账）、
`scripts/demo/timeline-panel-audit.e2e.mjs`（时间线 + 文件↔DOM + 右面板逐窗格）。

**为什么单立一类**：这类缺陷**静默**。r7–r9 实测抓到的 12+ 项里，没有一项会让任何既有剧本变红——
112 处裸 i18n key、13 个 Tab 名从不翻译、语言偏好冷启动失效、212 条 zh-TW 是简体、
图钉色块无可访问名……功能全通、页面零报错，只有换语言 / 开屏幕阅读器 / 逐条对文件才暴露。
正向剧本的覆盖面对它们是**结构性盲区**，多写一百个功能剧本也抓不到。

### 17.1 审计剧本的五个必查面

| 面 | 查什么 | 实测抓到的例子 |
|---|---|---|
| **结构** | 交互元素嵌套违规、锚点重复、空壳容器、图片无 alt、图标按钮无可访问名、标题层级 | 图钉色块按钮只含 `<PinSVG>`、无 `aria-label`，未选中时 `background`/`border` 都 transparent |
| **文案** | 裸 i18n key 上屏、插值残留 `{{}}`、硬编码中文（§7.1 铁律一） | `fieldDescs.terminal.hyperlinks` 直接显示在设置页 |
| **语言维度** | **同一套审计要在每个 locale 下各跑一遍** | zh-TW 有 212 条是简体照抄；`shell.loading` 等 2 个共享组件的 key 住在 pi 插件里 |
| **文件格式** | 落盘文件的 schema、字段、与读它的那份代码是否一致 | 中立层不是 jsonl，是 `<ns>.header.json` + `<ns>.entries.json` |
| **能力面 ↔ DOM** | 内核声明的能力与界面呈现的控件是否一致（缺面不该长出控件） | minimal 自带工具门控却被判"不能过滤"，被拼上冗余散文说明 |

**语言维度是最容易漏的一维**：审计剧本必须能 `--locale` 参数化。首版只跑 zh-CN，
于是"zh-TW 全是简体""en/de 用户被强制显示中文"这两类整批漏掉。
而且**语言切换本身要当断言**（`document.documentElement.lang === LOCALE`）——
r7 正是这条断言暴露了「prefs 存着 zh-TW、renderer 也读得到 zh-TW、界面却是 zh-CN」的启动竞态。

### 17.2 假绿的六种成因（本轮全部实踩，每种都有对策）

审计剧本最大的风险不是漏报，是**看起来在查、其实什么都没查**。

1. **作用域选到叶子元素** → 元素数 0，后续所有结构检查空转。
   实例：用 `[data-timeline-composer]` 当时间线作用域，而它是 `<textarea>` 本身（无子元素）。
   对策：作用域断言 `count > 0`，为 0 就红（"作用域又选错了"）。
2. **选择器取"第一个匹配"而不是"当前那个"** → 10 个 Tab 全在审同一个面板。
   实例：右面板是多窗格 toggle，`querySelector(".overflow-y-auto")` 恒返回 Review 的内容，
   于是每个 Tab 都报"可见元素=14"。**数字全同就是空转的信号**。
   对策：按窗格身份选（`data-sidepanel-pane`），并且打印每窗格的元素数——不同面板数字必然不同。
3. **不可见子树被重复计数** → 结论失真（既夸大严重度，也掩盖"到底几处"）。
   实例：设置页 keep-mounted（`settings-page.tsx:84` 用 `display:none` 不重 mount），
   8 处裸 key 被报成 112 处（8 × 14 个子页）。
   对策：先算出 `display:none`/`visibility:hidden` 的根集合，遍历时跳过其子树，
   并**打印跳过了多少个**（透明度）。
4. **检测集手抄 → 混进同形字 → 假阳性**。
   实例：简繁检测集里混进「形」（简繁同形），把合法译文 `npm 命令 argv 形式` 判成违规。
   对策：检测集**从已验证的映射表派生**，不手抄；假阳性比漏报更糟——它侵蚀守卫可信度，进而被绕过。
5. **类型层 bug 让断言恒真**。
   实例：`userFacingStrings` 返回元组数组，消费方按 `{key, value}` 解构 → 两个都 `undefined`
   → `pattern.test(undefined)` 永不匹配 → **3 条断言全绿，而守卫是空的**。
   是 `tsc` 的类型错误暴露的。对策：**每个审计/守卫都必须反向注入验一次**（§10.3），
   而且 `tsc` 的错误不要当风格问题放过。
6. **脚本自己的路径推导 off-by-one** → 全部 `continue`、报告"0 问题"。
   实例：`dirname(dirname(p))` 少算一层，locale 目录变成 `…/locales/locales`。
   **连续两轮犯了同一个错**。对策：脚本开头打印"扫到 N 个文件/目录"并对 N 断言下限；
   路径推导后加 `assert "/locales" not in dir`。

7. **判据逻辑对、但扫描范围空** → 守卫变装饰品，且**所有断言都绿**。
   实例（r10，我自己写的守卫）：重写 `walk()` 时把"收集 .json 文件"那个 `else if` 分支整段丢了，
   只剩 `if (!isDirectory()) continue`，于是 `walk` 恒返回空、`detect` 恒返回 0 条；
   而"合成样本自检"照样通过、"没有清单外的新增"照样绿（0 条当然没有新增）。
   同一轮里它报"德语债 0 条"，而真实 app 的德语设置页肉眼可见 `General` / `Compaction` /
   `Last Changelog Version` 一片英文——实际是 **101 条**。
   对策：防空转必须**同时**验两件事——① 判据能判（合成样本三向：能抓坏的、放过好的、放过豁免的）；
   ② **真的扫到了东西**（`expect(文件数).toBeGreaterThanOrEqual(N)`）。只有 ① 不够。
8. **自检与判据耦合，判据一改自检就失效（或反过来变成永真）**。
   实例：自检原本是"拿 en 包跑同一判据，必然大量命中"。判据从"含英文虚词"换成
   "de 与 en **逐字相同**"之后，en 包与 de 包本就不同 → 判据①不成立 → 命中 0 → 自检反而红。
   对策：自检用**合成样本**（自己造三个输入：该抓的、该放的、该豁免的），与被测数据解耦。
   另：合成样本里传的参数要能真的触发规则——首版给豁免规则的 file 参数传 `"x/y.json"`，
   而豁免规则匹配的是 `themes/font-presets/`，于是"豁免生效"这条自检**永远是假通过**。

9. **判据的门槛把整类条目放过**（量词型盲区）。
   实例（r11）：德语未翻译判据里有一条"剥掉路径后**至少 2 个词**才判定"，理由是单词条目
   （`Transport`/`IM`/`Tree`）无法判断该不该译。结果**所有单词条目被整批放过**，而其中
   `General`/`Compaction`/`Retry`/`Images`/`Warnings`/`Cancel`/`When`/`Protected`/`Reload`
   都是该译而未译的——德语界面实际显示英文，共 **95 条**盲区（比已知的 97 条还多）。
   对策：不能用"词数"这种粗门槛一刀切，要**逐类表态**——建一张显式的
   "语言中立术语表"（德语技术 UI 惯例保留英文原词的那些：Status/System/Debug/Prompt/Markdown/
   Chat/Tree…），在表里的放过、不在表里的单词条目一律参与判定；表长打印出来，
   防止靠"塞进中立表"把债务藏起来。并给盲区配自检：`General` 必须被抓到、`Status` 必须被放过。

> **验证手法：判据要用第二种实现独立复核一遍。** r10 我据守卫的"0 条"报告"德语债清零"，
> r11 在真机肉眼看到大片英文——守卫与结论都错。r11 改完判据后，除了跑守卫，还用 Python
> **独立重写了一遍同样的判据**去数（TS 与 Python 两套实现给出同一个数字 0 才采信），
> 并且回到真实 app 切到德语**肉眼看**设置页。三条独立证据一致，才敢说"清零"。
> 单靠守卫自证是循环论证：守卫坏了的时候，它报告的正是"一切正常"。

> 通则：**每条审计判据都要配"判据本身不空转"的断言**，而且那条断言要覆盖**两个维度**——
> 判据逻辑（合成样本三向）+ 扫描范围（文件数/元素数 > 0）。本仓所有新守卫都带这两条。
>
> 还有一条更硬的通则：**"守卫绿了"永远不等于"问题没了"**。r10 的德语债就是完整反例——
> 判据太弱（要求含英文虚词）→ 清单只收了 49 条 → 照单还清 → 守卫转绿 → 我据此报告"清零"，
> 而真实债务是 101 条。**判据必须先在真实界面/真实数据上被证明能看见问题**（§10.3 的
> "先证明能红"在这里要升级成"先证明能看见全貌"）：本轮的做法是把判据换成不依赖词表的
> 硬对比（de 与 en 逐字相同），并在真实 app 里切到德语**肉眼抽查**设置页。

### 17.3 锚点纪律（三条，都来自实测）

1. **不按译文文案定位元素**。首版按 `/^(设置|Settings)$/` 找设置入口，换 zh-TW 就失效——
   繁中是「設定」（正确的台式术语）。按文案匹配等于把测试绑死在某一种语言上。
   正确做法：给需要的元素加稳定锚点（本轮加了 `data-sidebar-entry="settings"`）。
2. **不依赖第三方库渲染出的属性**。右面板窗格的身份本来是 react-resizable-panels 的
   `data-panel-id`——依赖它等于把 e2e 绑在库的实现细节上（升级改名就全断），
   而且它不在本仓源码里，`src/e2e-anchor-coverage.test.ts` 会判"e2e 依赖了源码中不存在的锚点"。
   正确做法：加自有锚点 `data-sidepanel-pane={id}`。
3. **不凭空发明锚点名**。首版写了 `data-slot`/`data-region`/`data-container` 三个选择器，
   源码里根本不存在，被 `e2e-anchor-coverage` 当场判红。那条守卫就是为此存在的。
   （它也拒绝豁免清单——"手写清单会过期"，所以修的是剧本和产品，不是放宽守卫。）

### 17.4 文件 ↔ DOM 对账：先问「哪一份是超集」

跨存储对账最常写错的断言是"两边条数相等"。实测：2 轮发送 →
内核侧 jsonl **4** 条 message、中立层 **7** 个 entry、DOM **7** 张卡。
中立层是**超集**（多出的 3 个是壳侧事件：`role:"divider"` 的模型切换分隔卡、会话重命名卡）。

正确的三条不变量：
- 内核侧每条消息都能在中立层找到对应（**按抽取文本**比，不按原始 JSON——内核侧 content 是
  内容块数组 `[{type:"text",text}]`，中立层形状不同，直接比 JSON 必然假红；
  而且数组 `.toString()` 得到 `"[object Object]"`，r8 就这么假红过一次）；
- 中立层 entry 数 ≥ 内核侧 message 数（超集关系）；
- **中立层 entry 数 == DOM 卡片数**（7 == 7）← 这条才真正回答"文件与界面是否对应"，
  任何一侧多算/漏算（折叠、去重、虚拟化窗口）都会在这里暴露。

顺带钉住格式本身（连写审计的人都会记错，正说明值得钉）：`.header.json` 三字段
（`neutralSessionId` / `rootLineageId` / `header`）、header 内 8 字段、header↔entries 一一对应、
无遗留整树残留（`<ns>.json` 读到即懒迁移拆开）。

### 17.5 大批量债务用**棘轮守卫**，不要要么全修要么不修

实例：德语包 49 条其实是英文。翻译 49 条技术文案需要专门一轮——本轮已有一次教训：
把 `Basis`(阴) 一刀切换成 `Kernel`(阳) 时写出 `eine dsh-Kernel`、`installiere sie`（应 `ihn`）
等 6 处性数不一致。**赶工翻译的风险比不翻译更高**。

正确处置：① 量化成清单落盘（`scripts/i18n-de-untranslated.json`）；② 上**棘轮守卫**两条断言——
"当前检出必须都在清单里"（新增即红）+"清单里的必须都还没修"（修好了不删清单 = 清单失真，也红）。
第二条是关键：没有它，清单会随修复逐渐失真，守卫慢慢变成空转。

同一范式适用于：`dependency-audit` 的 allowlist（打印长度防悄悄变长）、
`doc-drift-audit` 的 RETIRED 表、§6.1.3 的 `PENDING_WARM_TABLES`（由"文件是否存在"推导，
文件一落地名单自动变空、下一条测试立刻开始要求真实调用点存在）。

### 17.6 CDP / `page.evaluate` 的四条硬约束（每条都实测踩过）

1. **`evaluate(字符串)` 是当表达式求值、且不传参**。写成 `evaluate(FN_STRING, sel)`
   会返回函数对象本身（症状：`r.nesting` undefined）。要把参数 JSON 内联进 IIFE。
2. **`Set` / `Map` 经 CDP 序列化会变成空对象**。跨边界只传数组/普通对象，回 Node 侧再 `new Set(…)`。
3. **注入页内的代码若是模板字符串，注释里不能有反引号**（会提前终止模板字面量）。
   两轮各犯一次，症状是 `SyntaxError: Unexpected identifier`。
4. **`&&` 链里前一步失败会静默跳过后面的 build**，于是审的是旧产物。
   实例：`node --check x.mjs && npm run build && node x.mjs`，`--check` 失败 → build 没跑 →
   审计跑在旧产物上 → 一度以为修复没生效。改完产物必须**显式确认 build 跑过**。

### 17.7 静态守卫与行为测试不可互相替代

实例：验证"暖启动必经 `runOps`"时，用 `if (false) { await runOps(...) }` 做反向注入 →
**纯文本静态扫描看不见不可达代码，没红**。改成真实回归形态（整段删除）→
静态守卫 2 红 + 行为测试 2 红。

结论：静态守卫防"声明腐烂"（字段没人读、key 没人译、锚点不存在），
行为测试防"路径不通"（真的调了、真的生效）。两者判据不同、失效形态不同，**必须都写**。
静态守卫还要在文件头**声明自己的局限**（抓不到中间变量/forEach/跨行 for 头/不可达代码），
否则下一个人会误以为它覆盖了一切。

### 17.8 「硬编码文案」这类缺陷的三种形态与判据演化（r12 实测）

同一个违规（§7.1 铁律一：壳/插件不内嵌文案）在代码里有**三种形态**，判据必须分别覆盖，
只覆盖一种就会大面积漏报。r12 实测：判据每扩宽一次都抓到新缺陷，共三轮。

| 形态 | 例子 | 判据 |
|---|---|---|
| ① JSX 属性字面量 | `title="移除图片"` | `ATTR` 正则 |
| ② **属性里的表达式**（三元 / `??` 兜底） | `title={copied ? "已复制" : "复制内容"}`、`alt={sticker.title ?? "贴纸图"}` | ATTR 必须允许 `{…}` 内含中文字符串——**首版只认 `attr="…"` 与 `attr={"…"}`，于是 5 处全放过**，直到在德语真机里看见「复制内容 / 删除」才发现 |
| ③ **数据里嵌展示文案** | `core/types.ts` 的 `{ id:"readonly", name:"只读", description:"读取与搜索…"` | 单独一条守卫，只认展示字段名（`name`/`description`/`title`/`label`），且**有配套 `<field>Key` 就放过** |

形态 ③ 的修法值得单独记：`name` 同时是**用户可改的数据**（重命名写回它）和**内置预设的默认文案**
（该随语言变），两个身份都要留位置。所以加 `nameKey?`/`descriptionKey?`，渲染侧统一走
`g.nameKey ? t(g.nameKey, { defaultValue: g.name }) : g.name`——**不按 `builtIn` 分支**
（那是身份分支，CLAUDE.md §1.5 判别气味），内置预设与用户自建组走同一条路径；
用户保存过之后清掉 key，让字面值优先（用户显式写下的值不该被任何翻译覆盖）。
连带要修编辑框初始化：`useState(group.name)` 会把中文字面量填进德语用户的编辑框，
一保存就把中文写进了他的配置——要用解析后的展示值初始化。

**必须排除的假阳性**：正则字面量里的中文。`ask-question-card.tsx` 有
`/\s*(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)\s*$/i`，那是**剥掉内核回传选项标签里
「(推荐)」后缀的匹配模式**，必须同时认中英文两种写法（内核可能回传任一种），
把它改成 i18n key 反而是错的。判据里要先挖掉 `/…/flags` 再找中文。

**i18n 改动会连带弄红既有测试**，修法按 CLAUDE.md §5.6：`useTranslation` 用 `vi.mock` 给**真字典**。
最稳的做法是测试**直接读插件自己的 locale 文件**当字典（`readFileSync(../locales/zh-CN/ask.json)`），
而不是在测试里另抄一份——另抄必然与真实文案漂移，于是"测试绿但界面是别的字"。
mock 的 `t` 还要支持 `{{var}}` 插值，否则带变量的文案断言会假红。

### 17.9 剧本基建也要"共用而非内联"——否则审计结论会假

r13 新写的 `composer-session-audit.e2e.mjs` 报了一条 **H 级发现**：
「注册表有内核 dsh，但模型下拉里找不到对应 TAB（现有 pi/minimal）」。查下去发现**是剧本自己的错**：

- dsh 的准备**不在 `setupBaseline` 里**，是独立导出的 **`setupDshKernel(home, realHome)`**
  （三件套：`<dataRoot>/dsh` 符号链接 + `settings.yaml`/`cordis.yml`/`.credentials.yaml` 拷贝 +
  `~/.dsh/node_modules` 符号链接）。漏调它 → 隔离 HOME 没有 dsh 配置（app 运行时自建了一个空的）
  → dsh 报 0 个模型 → 下拉没有 dsh TAB。**而"已注册但无模型的内核不出现 TAB"恰恰是正确行为**
  （出现一个空 TAB 才是缺陷）。
- 所以判据也写错了：不能断言"注册表里每个内核都要有 TAB"，只能断言"**有模型的**内核要有 TAB"，
  且 dsh 那一条以 `setupDshKernel().available` 为前提——`home.mjs` 的注释早就规定了
  「`available=false` 表示本机没装 dsh，**调用方应跳过而非伪造**」。

顺带发现 `kernel-thinking-matrix.e2e.mjs` 把同一套 dsh 准备**内联复制**了一遍（逐项对比：7 个要素
一个不缺，所以不是现存 bug，但是"将来抄漏"的机会）。已收敛到共用助手，并跑真实双内核剧本验证
（18/18 通过、幕C `dsh 回复到达: true`）。`home.mjs` 对这件事的措辞值得抄下来当判据：
**「少任何一件都不是"少一点功能"，是"内核起不来"——抄漏一件的排查成本远高于共用一份」**。

> 通则：**审计剧本的"发现"必须先排除剧本自身的准备缺陷**。判据里凡涉及"某内核应当如何"，
> 都要先确认该内核在这个隔离环境里**真的被完整准备了**；否则报出来的是环境缺件的影子，
> 而不是产品缺陷。这类假阳性的代价很高——它会让人去"修"一个本来正确的行为。

### 17.10 「延迟求值 ≠ 活」——把快照改成 getter 时的头号陷阱（r16）

把构造参数从 `T[]` 改成 `() => T[]` 之后，**所有既有测试仍然全绿**：夹具是静态的
（构造时给一个数组、之后再不改），所以"改了签名"这件事本身没有任何测试盯着。
两种实现错误都能悄悄活下来：

1. **getter 调一次就存下结果**：`constructor(get) { this.items = get(); }` —— 与快照无异；
2. **getter 捕获了构造期的局部量**：`new ModelCatalog(() => plugins.map(...))`，
   其中 `plugins` 是本函数早先算出的局部数组。签名对了、类型过了、测试全绿，
   但重载造出的新实例与长期持有的旧实例各自捕获各自的数组，旧实例永远只看到旧数据。

第 2 种是机械改造最容易产出的形态（把 `f(x)` 包成 `() => f(x)` 就交差），
所以**必须审 getter 的闭包里读的是什么**：要读"当前的活源"（注册表 / `state.surfaces` /
访问器），不能读构造期的局部变量。

**判据写法**（三条消费者通用）：**先构造消费者 → 再改数据源 → 断言消费者看到新数据**。
顺序反了（先改源再构造）就退化成静态夹具，什么也证明不了。
并且**把错误写法本身写成一条"反例"测试**钉住它——它不是测产品，是防止有人再机械包一层。

配套的一条：反向注入要注在**实现**上而不是测试上。本例注入
`constructor(get) { this.sources = get(); }`（即错误形态 1），活性测试立刻红；还原即绿。

### 17.11 两条 puppeteer/断言层面的实踩（r18，都会让断言**静默为假**）

1. **`waitForFunction(pageFunction, options, ...args)`——options 在第二位**。
   写成 `waitForFunction(fn, PROMPT, { timeout, polling })` 不会报错：options 收到字符串、
   页内函数的参数收到那个 options 对象，于是匹配的是 `"[minimal echo] [object Object]"`。
   症状是**回复明明在 DOM 里、断言却为假**（我先 `page.evaluate` 打印了卡片文本才看出来）。
   与 §17.6 的 `evaluate(字符串)` 不传参是同一族陷阱：puppeteer 这几个 API 的"参数在哪一位"
   都不可靠直觉，用之前先确认签名。
2. **断言要写不变量，不要写某个阶段的具体值**。同一条断言（`reloadKernelIds()` 的返回）
   在剧本只有"删"阶段时写的是"不含 minimal"；加了"增"阶段之后 minimal 又被还原，
   断言就成了过期期望而报红。改成"与 `window.kernel.kernelIds` 一致"这类不变量后，
   剧本再加阶段也不会失真。（同一原则见 §16.4：写不变量，不写魔法阈值。）

顺带一条关于**判据用词**的：断言 echo 回复时不能凭印象写 `"[echo]"`——minimal 的真实格式是
`[minimal echo] <原文>`（`kernel/minimal/backend/minimal-backend.test.ts:70` 有钉）。
凭印象写判据的后果与凭印象写选择器一样：看起来在验，其实永远验不到。

### 17.12 设置页表单类审计：判据要落到**磁盘上的种类**，交互要用可信点击（r21）

新增 `scripts/demo/settings-controls-audit.e2e.mjs`（31 项断言，零 token）：逐类型走
「UI 改 → 点保存 → **读那个配置文件** → 断言 JSON 里的种类」。为什么不能只靠单测：
单测验的是 `onChange` 收到什么，落盘还要经过保存浮层 → `kernelConfig.set()` →
**内核自己的写盘逻辑**，中间任何一环把种类改了单测都看不见。r9 那个 `"false"` 真值反转
就是这样——单测能钉住 coerce，但"文件里到底是不是布尔"只有读文件才知道。

实测的类型 ↔ 控件 ↔ 落盘对账（pi 的 70 个字段：string 11 / enum 14 / object 2 /
boolean 18 / number 18 / string[] 7，全部有 `data-config-field` 锚点）：

| 声明类型 | 控件 | 落盘种类（实测） |
|---|---|---|
| `boolean` | checkbox | 真布尔 |
| `number` | number input | 真数字（`1234`，不是 `"1234"`） |
| `string` | text input | 原样字符串 |
| `enum`（含 boolean kind 选项） | select | 选 `false` → **布尔 false**；选 `auto` → **字符串 "auto"**（同一字段两种种类） |
| `string[]` | 草稿框 + chip（**Enter 添加，没有添加钮**） | 真数组、元素都是字符串 |
| `object` | JSON textarea（不透明类型的**正确**降级） | 真嵌套对象；非法 JSON 被挡住且不污染原值 |

三条交互层面的实踩（都会让断言假红或假绿）：

1. **受控 checkbox 要用可信点击**。首版用 `page.evaluate(el => el.click())`，三次跑里有一次
   React 没收到 → 表单不 dirty → 保存浮层不出现 → 读文件得到 `undefined`，
   看起来像"落盘种类错了"，其实是**点击没生效**。改 `page.mouse.click(x, y)`（skill §3.2）。
2. **交互前先 `scrollIntoView`**。`page.select()` 对屏幕外/被遮挡的 select 偶发不生效，
   症状是"选了但值没变 → 不 dirty → 读到旧值"。加滚动后连跑三次全绿。
3. **不要猜控件形态，先读它**。`string[]` 的 `StringListInput` **没有添加按钮**
   （草稿框 `onKeyDown` 里 Enter 即添加）；首版探针去找按钮，找不到就报"控件不可操作"。
   行内确实有按钮，但那是每项的**移除**钮。探针对控件形态的错误假设会伪装成产品缺陷
   （§17.9 的同一条通则）。

顺带在这轮修掉两处产品缺陷：① `JsonInput` 原是 **onBlur 才提交**，于是键入合法 JSON 后
**保存浮层根本不出现**（框架不知道有改动），用户以为编辑没生效，此时直接关窗/切页会
**静默丢编辑且无提示**；改成边改边提交（解析成功即上报、失败只在行内报错不上报），
并加 `lastReported` ref 防"自己上报的值回流后把草稿重排版"（否则每敲一个字符就被
`JSON.stringify(…, null, 2)` 重排、光标跳末尾，功能通了但完全不可用）。
② 移除钮的 `aria-label="remove"` 是**硬编码英文**——在 `packages/react` 发布面里，
屏幕阅读器在任何语言下都念英文（§7.1）；已改走 `settings.listRemoveItem`。
⚠ 注意它躲过了"硬编码中文"守卫：那条守卫只找 CJK，**英文硬编码同样是违规**，
判据应当是"用户可见文案有没有走 i18n"，不是"有没有中文"。

### 17.13 列表类交互审计：判据要落在「分组归属」和「文件」上（r22）

新增 `scripts/demo/session-list-audit.e2e.mjs`（29 项断言，零 token，连跑三次稳定）。
判据不是"点了有反应"，而是三件事**同时**成立：① DOM 显示了新状态；② 磁盘上的中立层
header 真的写了那个字段；③ 两者一致。只验①会漏掉"界面改了但没落盘"（刷新就回退），
只验②会漏掉"落盘了但界面不刷新"（用户看不到自己刚做的操作生效）——这类**半生效**缺陷
在"乐观更新 + 广播补丁"的架构里特别容易出现（本仓列表行正是走本地补丁 `applyHeaderPatch`
而不是全量重拉）。

这一轮四条断言写错了，每条都对应一个容易踩的语义：

1. **归档不是"行从 DOM 消失"，而是移进 `archived` 分组**（`buildGroups` 里
   `items.filter((s) => s.archived)` 单独成组，且该组 `defaultOpen: false`）。
   断言"离开活跃列表"会把正确行为判成缺陷。正确判据是**它现在属于哪个分组**
   （`[data-session-group]` + `-open` 折叠态），并且要**对照**未被归档的那行不在该组。
2. **有条件的菜单项要双向钉**。`delete` 只在**非当前活跃会话**上出现
   （源码注释：「删除:不可恢复,仅 deletable」）。首版把它当无条件项断言 → 报了一条假缺陷。
   正确写法是两条：活跃行**没有** delete、非活跃行**有** delete。
3. **锚点要区分"开关"与"输入框"**。`[data-session-search]` 是**展开搜索的按钮**，
   `[data-session-search-input]` 才是输入框（仅展开时渲染）。往按钮上打字的症状是
   "搜索没生效"，看起来像过滤坏了——所以**打完字要回读输入框的值确认**，
   再去断言过滤结果。同理适用于任何"折叠区里的输入框"。
4. **别写死行号**。重命名可能改变排序（置顶/自定义序），而且上一步操作的可能不是第 0 行。
   按**内容**定位（名字），不要按索引。

另一条环境事实（不是缺陷，但剧本必须知道）：**新会话的 composer 不继承上一个会话的模型绑定**
（内核跟随模型，新会话没有模型 → 落回兜底模型，实测是 pi）。所以"造第二个零 token 会话"
必须在点新建之后**重新选一次 minimal**，否则发送会走 pi（花真 token）或因无可用模型而失败。

### 17.14 跨项目/跨作用域类缺陷：单作用域剧本**结构上**撞不到（r23）

新增 `scripts/demo/project-switch-audit.e2e.mjs`（21 项断言，零 token，连跑三次稳定）。
它守的是一条已修根因的回潮：`sessions-list/renderer/index.tsx:505-512` 记着——
分组键 `g.kind+g.label` **跨项目高度重复**（每个项目都有「今天」组），切项目时 React 复用同一
`GroupBlock` 实例 + 拖拽库内部状态残留 → 旧项目的行不卸载 → **两个目录的会话叠加**
（观感是「切项目后左侧根本不刷新」）。

这类缺陷的特征是：功能"看起来能用"（列表有内容、能点、能发消息），但内容是**两个作用域混在一起的**。
在单个项目里跑一百个正向剧本也撞不到——**必须跨作用域往返**。判据要三层，缺一不可：

| 层 | 查什么 | 只验这层会漏掉什么 |
|---|---|---|
| ① 行数 | 切到空项目就该是 0 行 | 行数对但内容是别的项目的 |
| ② 归属 | 每行的文件存在、且属于**当前**作用域 | 归属对但切走就丢 |
| ③ 往返 | 切回来还能看到原来那些 | **叠加**（叠加时切回来也还在，①③都绿） |

**对账的键必须先查清楚再写**。首版按 `header.sessionPath` 去匹配中立层 header，
结果 5 行全部"找不到对应 header"、报出 5 条**假 M 级发现**——header 的真实字段是
`kernel / cwd / createdAt / lastEntryId / updatedAt / custom / lastMessage / name`，
**根本没有会话路径字段**，对应关系是靠 `cwd`。这又是 §17.9 那条通则的实例：
审计发现必须先排除剧本自身的假设错误。

改对之后判据反而更强：**「`cwd` == 当前项目的 header 份数」== 「当前可见行数」**。
数量不变量比逐行匹配路径强，因为它同时抓住"多了"（串台/叠加）与"少了"（丢会话），
而且不需要猜两侧用什么字段关联。第二条独立证据：内核侧路径里含当前项目目录的 slug
（minimal 按 cwd 分子目录存会话），与 `header.cwd` 互不依赖。

**一条交互层的实踩（与 §3.2 不冲突，要分清）**：项目行同时挂了 dnd-kit 的拖拽 listeners
（`{...listeners}`，`PointerSensor` + `activationConstraint:{distance:4}`）与 React `onClick`。
实测**坐标点击不触发切换**（无控制台错误、cwd 不变、active 标记不动）——pointerdown 被
拖拽传感器接管后，后续 click 没走到 React 的 onClick。改用合成 `el.click()` 即可。
⚠ 这不违反"优先可信点击"：§3.2 那条讲的是 **Radix 菜单这类依赖 `isTrusted` 的组件**；
普通 React `onClick` 不看 `isTrusted`。判据是"这个组件的库实现有没有检查事件可信性"，
不是"一律用坐标点击"。另：`clickPointUntil` 内部固定走 `page.mouse.click`，
**没有改用合成点击的口子**——别用 `{x:0,y:0}` 之类的假坐标去骗它（会真点屏幕左上角），
该写本地重试循环就写。

### 17.15 驱动不了的交互怎么办：分层覆盖，别留恒真断言（r24）

**实测结论：CDP 驱动不了 framer-motion 的拖拽重排。** 诊断留档（这些都验过，不是猜）：
指针事件是**可信**的（`isTrusted:true, pointerId:1, isPrimary:true, pointerType:"mouse"`）、
落点正确（`document.elementFromPoint` 命中行内图标 div，不在 `input,textarea,button,[contenteditable]`
排除集里）、`Reorder.Item` 确实在祖先链上（`position:relative; cursor:grab; list-style:none`）、
pointermove 序列也发出去了——但拖拽**没有启动**：拖拽中途元素的 `transform`/`zIndex`/
`boxShadow`/`scale` 全是默认值（`whileDrag` 样式没生效），松手后顺序不变。
本仓的排序控件是 `dragListener={false}` + 自定义 `onPointerDown` 里 `controls.start(e)`
（`packages/react/src/widgets/sortable-list.tsx`），这条路径在 CDP 下走不通。

**正确处置是分层覆盖，不是硬凑一个偶发剧本，更不是留一条恒真断言**：

| 层 | 覆盖什么 | 手段 |
|---|---|---|
| 算法 | "顺序如何被重排" | 圆心纯函数单测（`domain/custom-order.test.ts`，8 条） |
| 读回 | "文件里的顺序 → DOM 顺序" | **预置配置文件 + 重启 + 断言 DOM 顺序**（确定性，不依赖拖拽） |
| 写入 | "拖拽 → 写文件" | 剧本**如实声明做不到**，需人工 `MHD_WINDOW=shown` 复核 |

⚠ 顺带清掉一条**因交互做不到而变成恒真**的断言：原先写"搜索态拖一下、列表不变 ⇒ 禁拖生效"，
但既然拖拽根本驱动不了，无论禁没禁结果都是"unchanged"——那是 §17.2 第 7 种假绿。
改成验**结构**：`sortable-list.tsx` 里 `style={{ cursor: disabled ? undefined : "grab" }}`，
所以"禁拖"在 DOM 上的可观测后果是 `Reorder.Item` 的 `cursor !== "grab"`。
并且**成对验**（§11.7）：搜索态 `cursor:"auto"`、退出搜索后回到 `"grab"`——
只验前者会把"一直禁着"也算通过。

### 17.16 本轮另外四条实踩（都会伪装成产品缺陷或伪装成通过）

1. **锚点必须覆盖组件的*所有*渲染分支**。`GroupBlock` 有条早退分支
   `if (!group.label) return <motion.div …>`（搜索组的 `label` 是空串，走的正是它），
   首版只给带标题的主分支加了 `data-session-group` → 搜索态查出 **0 个分组元素**，
   而 `[].every(g => g === "search")` **恒真**，于是假绿通过。加锚点时要数一遍 return 分支。
2. **对账的 key 要查实现，不要按直觉**。`customOrder` 的 key 是 `neutralSessionId ?? path`
   （`ids = orderedItems.map((s) => s.neutralSessionId ?? s.path)`），而中立层 header 的字段是
   `kernel/cwd/createdAt/lastEntryId/updatedAt/custom/lastMessage/name`——**没有内核侧路径**，
   所以 path→ns **不能**从 header 文件反查，只能走 IPC 的 `sessions.list`（两个字段都带）。
   首版拿 path 当 key 种进文件，一个都没匹配上 → 全部落进 `rest` → 顺序没变，
   看起来像"落盘没被读回来"。
3. **列表首行可能是「新对话」乐观占位行**（`path` 形如 `new:<cwd>`、`group` 为 null、不是会话）。
   §2 早记过这条，r24 又踩了一次：拿过滤后数组的下标去索引**未过滤**的 `querySelectorAll` 结果，
   **差一位**，于是"把排序乙拖向新对话"，症状是"拖拽没生效"。凡按索引操作 DOM 集合，
   先确认手里的数组与那个集合是不是同一个过滤条件。
4. **改完圆心/服务端必须重新 build 再跑 e2e**（§17.6 第 4 条，这是第三次踩）：
   修完 `applyCustomOrder` 只跑了 tsc 与单测就去跑 e2e，产物还是旧的，
   于是"重复行缺陷"看起来没修好。判据：**e2e 结论只在 `npm run build` 之后才有效**。

### 17.17 能力旗标类审计：先问「投影出去的旗标谁在读」（r25）

审"能力面 ↔ DOM 是否一致"时，第一步**不是**去界面上找控件，而是先数清
**每一轴的消费者在哪一侧**。实测（`grep faces\.<轴>` 扫 `src/plugins` + `src/web` + `packages/react/src`）：
11 轴投影到 renderer，**只有 2 轴被读**（`retry`、`thinking`），其余 9 轴零 renderer 消费者。

这不是缺陷，而是**分工**：多数轴由**服务端强制**（后端不产数据 / `faceOf(轴)` 抛可行动错误），
renderer 靠可选链与空数据隐式降级；只有"决定画不画某个控件"的轴才需要 renderer 门控。
但这个分工原本是**隐含知识**，于是两种腐烂都可能发生：① 有人给某轴加了控件却忘了门控
（控件对缺能力的内核照样长出来，点了才报错）；② 有人以为"投影了就有人用"，据此推理 UI 行为。

处置：立一条守卫（`src/capability-axis-consumers.test.ts`，5 测，已双向反向注入验证）把分类
**显式化**——轴清单从圆心源码 `BackendCapabilities` 接口**解析**（不硬编码，加第 12 轴会自动
因"未分类"变红），两份清单（`RENDERER_GATED` / `SERVER_ENFORCED`）必须**恰好划分**全部轴，
且与实际扫描结果**双向一致**：声明有门控的必须真扫到消费者、声明服务端强制的必须真扫不到。
每条声明还要带理由（≥12 字），理由要能说清"缺面时用户看到什么"，否则就是静默缺面。

顺带查出一处**文档与实际的漂移**：`ModelCycleCapabilities` 的契约注释写着
「壳自行轮转属行为变更，本次不做（记录在案）」，而壳其实**早就在自行轮转**了——
默认快捷键 `mod+shift+]`/`[` 走 `timeline:cycleModel`，在**跨内核合流清单**里推导下一个模型；
内核那一面（`IPC.session.cycleModel` → `faceOf(proc,"modelCycle")`）**生产零消费者**。
两者是**不同操作**（内核面 = 单内核内轮转、顺序是内核私有语义；快捷键 = 跨内核轮转，
内核做不到因为它不知道别的内核），所以正确处置是**修注释**而不是"归位"——
照旧注释去把快捷键改成走内核面，会**失去跨内核轮转**，是功能退化。
已把对照表写进契约注释，并由上面那条守卫把"零消费者"钉成显式声明（不是被遗忘）。

> 通则：审"某个声明/旗标/字段有没有用"时，**先数消费者、再判性质**。
> 数出来是 0，有三种可能——字段腐烂（该删）、缺门控（该加）、分工在别处（该写下来）。
> 三者的处置完全不同，靠猜必然做错其中两种。

### 17.18 合成事件驱动不了某条路径时：留完整证据链，并把可测的那半下沉到单测（r26）

目标本是审 composer 的附件态（拖拽/粘贴 → 待发送文件条）。**实测驱动不了**，而且证据链
自相矛盾，值得把判别过程记下来——因为它示范了"怎么证明是环境限制而不是产品缺陷"：

| 观测 | 结果 | 含义 |
|---|---|---|
| `new DataTransfer()` + `items.add(file)` | `files.length === 1`、name/type 正确 | 构造侧没问题 |
| 在 form 上派发 `drop`，**文档级冒泡**监听 | `defaultPrevented === true` | 有人调了 preventDefault |
| 同样事件派发到 **body** | `defaultPrevented === false` | ⇒ 不是全局/宿主层干的，是 form 上的 React `onDrop` |
| `onDrop` 的实现 | `if (!onFiles \|\| files.length === 0) return;` **之后**才 `preventDefault()` | ⇒ 守卫通过了、`onFiles` 被调用了 |
| 投一个**不可分类**的文件名（`blob.zip`） | **没有**"已跳过 N 个"的 toast | ⇒ `ingestFiles` 的 `rejected` 分支没走到 |
| 投可分类的（`note.md`） | 没有 chip；全文档 `[data-composer-pending-files]` 为 0 | ⇒ `newFiles` 也是 0 |
| `pageerror` / `console.error` / `console.warning` | **全空** | 没有异常被吞 |
| `window.mhdFile.getPathForFile(合成 File)` | 返回 `""`（不抛） | 宿主桥可用，会回落到 `f.name` |

矛盾点：无 toast ⇒ `rejected === 0`；无 chip ⇒ `newFiles.length === 0`；两者同时成立只能是
**`files` 数组为空**，而 `files` 为空又与"`preventDefault` 被调用"（守卫要求 `files.length > 0`）
直接冲突。加上 `classifyReferenceFile("note.md")` 按源码必然返回 `"file"`（`md` 在 `TEXT_EXTS` 里）、
构建产物里确实有锚点（`grep out/renderer/assets/*.js` 验过）——**判定为合成事件在本环境驱动不了
这条路径**，与 framer-motion 拖拽同类（§17.15），不再硬凑。

处置（三条，缺一不可）：
1. **把可确定性验证的那半下沉到单测**：两个提示条本来就是纯展示组件，从 1600+ 行的插件入口
   抽成 `pending-bars.tsx`（与该插件既有惯例一致：`MessageMeta.tsx` / `phase-icon.tsx` 都是
   独立文件 + 自带测试），补 8 条 DOM 交互测试（锚点值 = 路径、显示完整路径而非文件名、
   每个移除钮各自回调且带自己的路径、可访问名是真译文不是裸 key、无 dataUri 不渲染 `<img>`）。
2. **补锚点**（`data-composer-pending-file*` / `-image*`），这样将来人工或换驱动方式复核时有稳定抓手。
3. **如实记录做不到的那半**：拖拽/粘贴 → `ingestFiles` → chip 这一段没有自动化覆盖，
   需要人工用 `MHD_WINDOW=shown` 拖一个真文件复核。不写成"已覆盖"。

> 通则：判别"环境限制 vs 产品缺陷"要靠**成对的对照观测**（同一事件在 form 上 vs body 上、
> 可分类文件 vs 不可分类文件），单点观测几乎总能被另一种解释吃掉。以及——
> **矛盾的证据比一致的失败更有信息量**：一致地失败只告诉你"没成"，矛盾才告诉你"哪一环的假设错了"。

### 17.19 选区驱动的 UI：用**程序化选区**，不要像素拖选（r27）

评论篮（划词 → 「评论」浮钮 → 入篮）这类交互由 `selectionchange` 驱动。像素拖选
（`selectAcross`）在既有剧本里能用，但换个场景就连环踩坑，实测三个：

1. **锚文本会命中侧栏会话行**：会话行文本形如 `<名字>[minimal echo] <末条消息>`，
   与消息正文含同样字串。不限定搜索域时 `locate` 命中侧栏（返回 x=132，而 sidebarW=239），
   拖选落在侧栏上 → `getSelection()` 为空 → 浮钮不出现，症状像"产品坏了"。
2. **`within` 限定后反而 0 命中**：消息卡里 `[minimal echo]` 前缀与正文是**两个不同元素**，
   没有单个元素含整串；`locate` 的两轮文本匹配（先直接文本节点、再叶子 textContent）
   在这种嵌套下命中不到目标 `<p>`——而 `document.querySelector("[data-message-id] p")` 明确能找到它。
3. **`fromFx`/`toFx` 是宽度比例（0..1）不是字符偏移**：传 2 和 9 会把拖选起点甩到元素矩形之外。

可靠做法：直接建 Range + `addRange` + 派发 `selectionchange`——这与用户拖选**同构**
（不是 mock 产品代码，而是模拟用户输入的那一侧），且完全绕开几何与文本匹配的坑：

```js
const range = document.createRange();
range.setStart(node, Math.floor(len * 0.05));
range.setEnd(node, Math.floor(len * 0.6));
const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
```

判据要**回读选区**（`sel.toString()`）确认真的选上了，再去断言浮钮——否则又是"没选上"伪装成"功能坏了"。

### 17.20 中立层 entries 文件的真实形状（对账前必须查清）

`<dataRoot>/sessions/<ns>.entries.json` 的顶层是 **`{ neutralSessionId, lineages }`**——
既不是扁平数组，也不是 `{ entries }`。按想象的形状读会得到 0 条，于是"落盘里没有 X"这条
**假红**（r27 实踩）。稳妥写法是递归遍历找 `role === "user"` 的节点，而不是假定层级。
这与 §17.16 第 2 条是同一个教训：**对账的结构要先查清再写**。

同轮另一条：会话被**自动命名**为第一条消息的文本，所以"用消息正文当锚文本"时，
侧栏行、标题栏都可能含它。凡用文本定位，先问一句"这段文本还会出现在哪里"。

### 17.21 守卫的覆盖面：按**名字**抓模式的守卫，必须枚举整个同族（r28）

本轮排查"通用壳插件里的内核名泄漏"，最有价值的一条不是找到的缺陷本身，而是**既有守卫为什么漏了它**：

依赖审计的检验⑬（"不许用字面量键访问内核的面"）首版正则是
`kernels\.(pi|dsh|minimal)|kernels\["(pi|dsh|minimal)"\]`——只盯 `kernels` 这**一个**注册表名。
于是 `ctx.kernelConfig["pi"].get()` 从旁边溜了过去（真实缺陷：通用插件 `timeline` 用它取
`retry.maxRetries` 当重试折叠条的展示分母，导致 dsh/minimal 会话也按 pi 的设置显示，
且 pi 未装时抛 TypeError 被 `Promise.allSettled` 吞掉）。而按内核键控的面**同族还有六个**：
`kernelModels` / `kernelConfig` / `kernelVersionApis` / `kernelExtensions` / `kernelLogos` / `kernelOneshots`。

> 通则：**凡是"按名字匹配"的守卫，第一件要做的事是枚举同族名字**。写守卫时问一句
> "这个概念在仓里还有几个同形状的名字？"——`kernels` 有，`kernelConfig` 就有；
> `fitExtensionAvailable` 有，`toolFilterEnforced` 就有。只守一个名字 = 守了个样本，不是守了个规则。

同轮还修了守卫的两个附带缺陷：

1. **注释过滤只看行首是不够的**。首版 `if (/^\s*(\/\/|\*|\/\*)/.test(text)) continue;`
   漏掉了**块注释的中间行**（既不以 `/*` 也不以 `*` 开头），于是把 `kernel-config-form.tsx`
   里一句提到旧写法的说明文字判成违规。正确做法是按文件**剥离块注释后再判**：
   把 `/* … */` 整段挖空（保留换行以维持行号），再对行注释按"引号计数为偶数"判断 `//` 是否真在字符串外。
2. **shell 引号里不要试图同时匹配两种引号**。`execSync` 交给 `/bin/sh -c` 的字符串里，
   模式既要含 `"` 又要含 `'` 时，JS 模板 → shell → grep 三层转义实测**三次都没写对**
   （关键陷阱：shell 双引号里 `\'` **不是**转义，反斜杠只转义 `$ \ ` " \` 与换行，
   写 `\'` 反而让那个引号开启一个新的单引号串）。绕开办法：用 `.` 代指引号字符
   （`["pi"]` 与 `['pi']` 都能命中，误报面可忽略），从根上不需要引号。

### 17.22 两类"审计扫不到"的泄漏面（r28）

依赖审计扫的是 **TS 源码**。本轮找到两类它结构上扫不到的泄漏：

1. **CSS 类名**。`.pi-collapsible` 定义在 `src/web/index.css`（壳机制层！），
   被发布面 `packages/react/src/widgets/section.tsx` 与两个通用插件共用；
   另有 `.pi-composer-command-chip`。壳层的样式钩子以某个内核命名，
   而检验⑤（壳机制层不许出现内核名字面量）只扫 `.ts`/`.tsx`，CSS 从不在扫描范围里。
   已改名为 `.shell-collapsible` / `.shell-composer-command-chip`（12 处，零残留，
   折叠动画由 session-list-audit 29 项复验）。
   > 通则：改判据之前先问"**这个概念还能以什么载体存在**"——标识符之外还有
   > CSS 类名、i18n key、DOM 属性、存储键、事件名、prompt 文本（r27 的 `<pi-review>` 就是最后这种）。
2. **死 locale 键 + 硬编码副本**。`settings.fontSampleCode` 在 4 个语言包里都有，
   而组件把同一份文本**又硬编码了一遍**（`{\`const sessions = await pi.sessions.list(...)\`}`）——
   键零消费者、副本里还带内核名，而且那个 API 形状根本不是本仓插件的真实 API。
   两头一起修：组件改为消费键，样本内容换成真实且中性的 `ctx.sessions.list(cwd)`。
   > 判据：**locale 键要有消费者**。有键无用 = 死键（改文案时改了个没人读的地方）；
   > 有用无键 = 硬编码（换语言不变）。两者常常成对出现，因为硬编码副本一出现，键就死了。

### 17.23 同一份数据有两个来源时，错的那个通常更"顺手"（r28）

重试上限这个数，仓里有两个来源：

| 来源 | 中性? | 准确? | 谁在用 |
|---|---|---|---|
| `autoRetryStart` 事件的 `maxAttempts` | ✅ 内核自己报的 | ✅ 逐会话逐内核 | **在飞**的重试横幅 |
| `ctx.kernelConfig["pi"].get().retry.maxRetries` | ❌ 写死 pi | ❌ 对非 pi 会话给错值；pi 未装则抛错被吞 | **历史**折叠分隔条 |

同一个 UI 概念（"重试 N/max"）的两处呈现，用了两个来源，错的那个是"顺手刮配置"。
修法不是把配置读取写得更好，而是**删掉这个来源**：分母改由事件提供（`RetryState` 是纯内存态、
不落盘，所以上一次运行遗留的历史行没有对应事件，回落契约注释里写明的默认值 3——
这是展示层的细微差别，且比"给 dsh 会话显示 pi 的配置"更正确，已如实写进注释）。

> 通则：发现某处"刮"了一个数据时，先全仓搜这个数据的**其它来源**。
> 若已有一个中性来源在用（尤其就在同一个组件里），那基本可以确定刮的这个是历史残留。

### 17.24 语言包审计的四个陷阱（r29：zh-TW 术语层 + 插件元数据本地化）

本轮从"zh-TW 界面里出现简体字"一路查到四类缺陷，每类都对应一个容易踩的陷阱。

**陷阱一：审已转字形的语言包，要用大陆术语的「繁体形」去搜。**
zh-TW 早已过简→繁转换，所以要找的是 `內核`（不是 `内核`）、`視頻`（不是 `视频`）、`網絡`（不是 `网络`）。
首版用简体形去搜，`內核` 32 处、`默認` 15 处、`數據` 5 处**全部漏计**，量出来的债务只有真实的一半。
字形层与术语层是**两件不同的事**：字形守卫（`locale-zhtw-simplified.test.ts`，判据是
"zh-TW 值 === zh-CN 值 且 含简体专用字"）对这批文案**结构上抓不到**——它们已是繁体字形、
且与 zh-CN 不同形。新守卫 `locale-zhtw-terminology.test.ts` 的第 ⑤ 条测试就是**盲区自检**：
构造 `zhCN="加载失败" / zhTW="加載失敗"`，断言字形守卫的两个条件都不成立、而术语守卫抓得到，
以此证明两条守卫互补而非重复。

**陷阱二：同形异义词不能一刀切替换。**
`項目` 作 item 解时台语也说「項目」（`拖曳列表項目時`），只有作 project 解才写「專案」；
`用戶端` 是 client 的台语标准词，改成「使用者端」反而错；台语的「文件」= document、
「信息」= message。所以判据分两层：**HARD**（大陆专用词，硬零，19 个）与
**LEDGER**（同形异义词，按 (插件, key, 词) 精确登记 + 理由，双向检查：
账本里的必须仍存在、账本外的一律违规）。r10 批量替换把德语性数一致弄坏过，同一个教训。

**陷阱三（最阴）：语言包文件必须在 manifest 的 `contributes.languages` 里登记，否则静默不加载。**
`contributes.languages` 是**显式文件清单**（`[{id, locale, resources}]`），不是"扫目录"。
本轮新建/补写了 `plugin.json` 后界面毫无变化、**也没有任何报错**——因为文件没被登记。
实测全仓有 **72 个 `plugin.json` 从未登记**（历史遗留 + 本轮新建），全部补登记后才生效。
> 通则：**加了语言文件却没生效、且不报错** ⇒ 先查注册表/清单，别怀疑译文内容。
> 同款形态在别处也出现过（内核插件的 `factory` 路径、槽位贡献的静态声明）。

**陷阱四：守卫的扫描范围要包含"会到达 UI 的夹具目录"。**
minimal 内核插件住在 `test-plugins/`（不在生产扫描根里），但测试剧本把它种进隔离 HOME 后
**设置页就有 Minimal 页签**，它的语言包一样显示给用户。术语守卫首版只扫 `src/plugins`，
于是 minimal 的 16 处大陆术语从旁边溜了过去。已扩到 `test-plugins`。
> 而且夹具是**模板**：`test-plugins/kernels/minimal/` 就是"第四个内核插件长什么样"的样板，
> 模板错 = 之后每个新内核都从这里抄错。

### 17.25 跨内核复制粘贴：用「不得提到别的内核」当判据（r29）

实测缺陷：`test-plugins/kernels/minimal/locales/*/minimal-models.json` 里
`minimalModels.title` 在**四个语言全部**是 "DSH 模型配置" / "DSH model config" /
"DSH-Modellkonfiguration"；`minimalModels.apiKeyDesc` 还写着"密钥写入 **dsh** 凭证库
(`~/.dsh/.credentials.yaml`)、**dsh** 运行时读取、不写进 models.json/**cordis.yml**"
——cordis.yml 是 dsh 的配置格式，而 minimal 的凭证实际落在 `<agentDir>/.credentials.json`
（`src/server/kernel/minimal/manager/minimal-config-source.ts:44`，已核实源码）。
整份文件是从 dsh 插件**复制后没适配**：用户配置 minimal 内核时，标题写着 DSH、
说明文字教他把密钥写进 dsh 的凭证库。功能不报错、页面不崩，只有读界面上的字才会发现。

判据：**内核插件的语言包不得提到别的内核 id**（词边界匹配）。但直接判违规会产出 20 条假阳性，
实测三种合法形态，所以配账本（按 (own, key, other) 登记 + 理由，双向检查）：
① **包名**——dsh 的 `dshModels.desc` 提到 `llm-pi-ai`（npm 包名，不是对 pi 内核的指称）；
② **有意的对等性陈述**——`plugin.dsh.description` 写"与 PI 同级"（§1.4 无特权差异的正面表达，
   删掉反而丢信息）；③ **同形异义**——pi 的 `thinkingBudgets.minimal` 里 `minimal` 是
   **思考档位名**（off/minimal/low/medium/high/xhigh）。
另加一条**具名回归锚**（不依赖账本）：minimal 的语言包一个 dsh 字都不该有，
且标题必须含 "Minimal"。反向注入验证：把标题改回 "DSH 模型配置" → 通用检查与回归锚**两条**同时变红。

> 这类守卫的价值不在"抓到多少"（当前账本外命中为 0），而在
> **新增的跨内核提及必须当场解释**——上面那个缺陷正是因为从来没人被要求解释过
> "minimal 的语言包为什么在说 dsh"。

### 17.26 「文件对但界面错」：语言包审计必须落到真实渲染结果（r30）

**locale 文件全绿 ≠ 界面全绿。** r29/r30 实测两种形态：

1. **语言文件没登记 → 静默不加载**。`contributes.languages` 是**显式文件清单**
   （`[{id, locale, resources}]`）而不是"扫目录"。新建/补写了 `plugin.json` 之后界面毫无变化、
   **也没有任何报错**——文件根本没被加载，`t()` 回落到 manifest 的中文字面量。
   实测全仓有 **72 个 `plugin.json` 从未登记**（历史遗留 + 新建），补登记后才生效。
2. **键名与派生公式不同源 → "看起来已经有键了"**。manifest 的贡献标签没有 `titleKey` 字段，
   渲染方是**按 id 派生键**、把字面量当 defaultValue：设置侧栏 `settings.<entryId>`、
   设置 TAB `settings.<tabId>`、右面板 `sidePanel.<id>`、插件名 `plugin.<id>.displayName`。
   pi 的语言包里确实有 `settings.extensions` / `settings.models` 两个键——但**名字与派生公式对不上**
   （那是页面组件内部自用的标题），所以 TAB 标题一直回落到 manifest 里的 "PI 拓展"/"模型"，
   四个语言全都显示简体中文。这种缺陷靠"grep 有没有 i18n 键"永远查不出来，
   必须**把派生公式本身写进判据**。

处置有两层，缺一不可：

| 层 | 判据 | 守卫 |
|---|---|---|
| 文件层 | 含 CJK 字面量的贡献项，其**派生键**必须四语言齐全；派生公式**从渲染方源码核对**（公式一改守卫就红） | `contribution-label-i18n.test.ts`（4 测） |
| 界面层 | 真实 app 在 en/de 下**可见文本零 CJK**；在 zh-TW 下**零大陆术语** | `dom-audit.e2e.mjs --locale <L>`（本轮加的 2 条断言） |

界面层那条特别值：**任何**未本地化的串（硬编码在组件里、manifest 字面量兜底、键没登记）
都会以"英文界面里冒出中文"的形式暴露，一条断言覆盖三类成因。实测四语言全绿：
en/de 各 0 处中文串、zh-TW 0 种大陆术语（可见文本 11022 字）。

⚠ zh-TW 那条判据要用**词**而不是**字集**：字集里「默」「加」这类**简繁同形**字会造成假阳性
（r29 实踩：把"前提不成立"的自检判反了）。

### 17.27 守卫写太宽 = 逼合法改动绕过它（r30）

r29 给跨内核守卫写了一条具名回归锚：「minimal 的语言包一个 dsh 字都不该有」。
r30 给 minimal 补 `plugin.minimal.description` 时写了「与 pi/dsh 同级」——
那是 §1.4「无特权差异」的**正面陈述**，合法且已入账本——这条锚立刻变红。

锚**写太宽**的后果不是"多报一个错"，而是**逼着合法改动去绕过守卫**（删断言、加豁免、改判据），
守卫一旦被绕过就失去信任，之后所有真报警都会被当成噪音。这与 §17.2 的假阳性教训同源。

修法是把锚**收窄到它真正要保护的东西**：那条锚要防的从来不是"任何提及 dsh"，
而是"模型页那份被整体抄自 dsh 的文案回潮"。所以改成扫 `minimal-models.json` 一个文件，
并换成**更实质**的断言（不只是"不提 dsh"）：`apiKeyDesc` 不得含 `cordis`（dsh 的配置格式）、
必须含 `.credentials.json`（minimal 自己的凭证路径，源码事实 `minimal-config-source.ts:44`）、
`title` 必须含 `Minimal`。反向注入验证：把 dsh 凭证库那句塞回去 → 通用检查与回归锚**两条同时红**。

> 通则：**具名回归锚的范围 = 缺陷实际发生的那个位置**，不是"这个模块里所有可能出现的地方"。
> 宁可窄而实（断到具体字段的具体值），不要宽而虚（断"任何地方都不许出现某个词"）。

### 17.28 把"手工扫过一遍"固化成守卫，否则每轮重新发明判据（r31）

r27–r31 我连续**四轮**用临时 Python 脚本扫同一件事（通用层里的内核名泄漏），每次都要重新
处理同一批坑：词边界、注释剥离、豁免清单、载体分类。临时脚本用完就扔，于是**判据 never 沉淀**。
按 §3.7「根因修复的闭环是留下守卫」，r31 把它固化成 `src/kernel-name-carriers.test.ts`（6 测）。

固化的价值立刻显出来：**同一份判据写严一点，就多查出 51 处**（此前手工扫只报 0～5 处）。
差别全在两个规则细节上：

| 规则 | 首版（漏） | 修好（准） |
|---|---|---|
| 词边界 | `(?<![A-Za-z0-9_./-])` —— 把 `- . / _` 也算进"不是边界" | `(?<![A-Za-z0-9])` —— 标点/引号/连字符/点/下划线**都算边界** |
| 复合名前缀 | 无 | 另加一条 `(?=[A-Z_-])`：`piLayout` / `dshManager` / `pi_collapsible` |

首版漏掉的正是**已经抓到过真实缺陷的那些形态**：`.pi-collapsible`（CSS 类名，r28 的真实缺陷）、
`config.set("piLayout")`（存储键的驼峰前缀）。而 `picker`/`pins`/`ping`/`sessionGroupings`/`api`/`pixel`
在新规则下**仍然不误报**（pi 前后接字母），所以放宽是安全的。

⚠ **这个假绿是反向注入抓出来的，不是靠读代码**：守卫 5/5 全绿、自检也过，
但我把 `.dsh-legacy-panel` 与 `config.set("piLayout")` 注进去，它**依然全绿**。
自检断言当时只写了 `BOUND.test('kernels["pi"]')`（独立词形态），恰好没覆盖前缀形态——
**自检样本必须包含"你声称能抓的每一种形态"**，只测最典型的那一种等于没测。

### 17.29 账本要分「永久合法」与「架构债」两类，后者必须带棘轮（r31）

扫出来的 51 处不是一类东西，混在一个豁免清单里会**把债洗白**：

- **同形异义（homonym，永久合法，5 条）**：`minimal` 既是内核 id，又是**思考档位**名
  （`off/minimal/low/medium/high/xhigh`），又是**视觉风格预设**名（`StylePresetId = default|card|minimal|outline|glass`，
  实测 `[data-sidebar-style="minimal"]`）；`pi-review` 是**历史线格式**，解析方必须继续认。
  这些不是债，改名反而是错的。
- **架构债（debt，必须只减不增，4 条）**：`MODELS_CONFIG_PATH = "~/.pi/agent/models.json"`（在**发布面**里）、
  壳设置页的 `AGENT_PREFIX`/`DSH_PREFIX`（靠路径前缀反推内核归属）、
  application 层 MainContext 的 `dshCustomCliDir`（按内核名分字段 = §6.3 检验④ 禁的形态）。

两条纪律：
1. **架构债的理由里必须写"正确修法"**（守卫强制检查这个词），且不能只写"同上一条"——
   每条自包含。我自己的第一条 `DSH_PREFIX` 就写了"与上一条同源"，被守卫③ 挡下来（该挡）。
2. **棘轮**：`DEBT_CEILING = 4`，涨了就红。意义不在数字，在于**让债可见**——
   没有它，"通用层零内核名"这个目标会在一次次"就这一处、下轮再收"里悄悄退化成"到处都有"。

⚠ **架构债不能"顺手改名"**。这四条的正确修法都是"让内核自报自己的配置目录/路径"
（经注册表或 `KernelPlugin` 面），而不是把常量改成中性名——改名只是把泄漏藏得更深，
数据流里壳照样在按内核身份分支，属 §3.7 禁止的补丁式修复。所以本轮只做了**能真修的**：
CSS 动画家族 `pi-composer-*`/`pi-menu-*` → `shell-*`（49 处）、`piAlive` → `snapshotAlive`（7 处，
它的语义本来就是 `snapshot !== null`，与 pi 无关）、以及 `skills.ts` 那条特判尾巴。

### 17.30 「修复留下的特判尾巴」比原缺陷更难发现（r31）

`src/server/controllers/skills.ts` 的注释写着：「监视哪些文件由各内核自报…**此前这里写死了 pi 的三个路径**，
现在从注册表收集，加内核自动纳入」。看起来那次修复很干净。但同一行还挂着：

```js
.filter((p) => existsSync(p) || p.endsWith(".pi" + join("", "settings.json")))
```

两个问题叠在一起：
1. **特判尾巴**：意图是合法的（清单文件还不存在时也要监视，好让用户创建它的那一刻触发刷新），
   但被写死在 pi 的路径上 → dsh/minimal/第四个内核的清单若尚未创建就**不会**被监视
   （症状：装了内核、建了清单，技能列表不刷新，要重启才行）。
2. **字符串被拆开拼接**（`".pi" + join("", "settings.json")`）：无论初衷是什么，
   这种形态在效果上就是**躲开按字面量搜索的审计**。它躲过了 r28 之前的所有手工 grep，
   直到本轮的多载体守卫用词边界才抓到。

中性修法：存在的直接监视，不存在的改监视其**父目录**（创建事件同样能捕获），不点名任何内核。

> 通则：看到「此处曾经写死 X，现已改为通用」这类注释时，**别信注释，读同一行的剩余部分**。
> 修复常常留下一个 `|| 特例` 的尾巴，而注释只描述了被修掉的那一半。

### 17.31 共享控件不透传 `data-*` ＝ 锚点纪律在按钮上落不了地（r32）

给"自定义内核目录"的输入框和三个按钮加锚点时，输入框生效、**按钮的锚点在 DOM 里根本不存在**
——而 `grep` 构建产物能看到那 4 个锚点字符串，tsc 也全绿。根因：共享 `Button`
（`packages/react/src/widgets/button.tsx`）的 `ButtonProps` 是**封闭接口**，
既不声明 rest props 也不 spread，于是写在 `<Button data-foo="">` 上的属性被**静默丢弃**。

为什么这个缺陷特别隐蔽：**TypeScript 对 `data-*` 属性不报错**（JSX 的连字符属性被放行），
所以编译期一声不响；产物里字符串还在（因为源码里写了）；只有真去 DOM 里查才发现没有。

影响面不是"某个测试失败"，而是**全仓任何用 `Button` 的控件都挂不上稳定锚点**——
e2e 与 DOM 审计只能退回"按译文定位"，换语言就失效。等于 §17.3 的锚点纪律在所有按钮上作废。

修法（按根因，不是绕开）：`ButtonProps` 加 `[key: \`data-${string}\`]: string | undefined`
索引签名 + 函数签名收集 `...anchors` + 在 `<button>` 上 `{...anchors}`（放在 `type`/`onClick`
之前，避免锚点覆盖行为属性）。并补 DOM 级单测（3 条）钉住：锚点必须出现在真实 DOM、
多个锚点与既有 props 共存且 `disabled` 重渲染后仍在、不传 data-* 时默认形状不变。

> 通则：**共享控件必须透传锚点**（`data-*`）。审一个组件库时，先写一个
> "挂 data-x 然后去 DOM 里查"的最小测试——封闭接口 + TS 对 `data-*` 不报错，
> 这个组合会让缺陷在编译期与产物层都隐形。

### 17.32 消内核名的两个正确姿势（r32：把架构债真修掉，不是改名）

r31 记下 4 条架构债并写明"不能顺手改名"。r32 真修掉 3 条，两个姿势值得记：

**姿势一：反转判据，让内核名根本不出现。**
壳设置页原有 `AGENT_PREFIX = "~/.pi/agent/"` / `DSH_PREFIX = "~/.dsh/"`，
用"路径以哪个内核目录开头"判断某配置项是否内核自留地（决定分不分层）。
正确修法不是把常量搬走，而是**反转判据**：分层只属于壳自己的配置空间
`~/.my-harness-desktop/`，**不在里面的一律扁平**（`isOutsideLayeredSpace(f) = !f.startsWith(DESKTOP_PREFIX)`）。
判据里没有任何内核名，且对第四个内核**自动成立**。

顺带修掉一个潜在真 bug：旧判据对 `~/.minimal/agent/config.json` 返回 false（判成分层项），
于是 `relPathOf` 用 `slice(DESKTOP_PREFIX.length)` 去切一个不以该前缀开头的路径，
得到垃圾（实测 `'g.json'`）——壳会去读写一个错误的分层路径。当前 minimal 的 TAB 都声明
`configFile: null` 所以没踩到，但任何声明了内核原生 configFile 的**第四个内核**会立刻踩中。
已补 8 条纯函数单测，其中一条是显式的"第四内核"回归锚
（`~/.minimal/agent/…`、`~/.fourth-kernel/…`、绝对路径都必须判为扁平）。

**姿势二：契约与类型自相矛盾时，按契约改类型。**
圆心 `kernel-plugin.ts` 写着「偏好读写；内核插件读写自己的 customCliDir 等 key
（**核心不硬编码 key 名，key 由插件自定**）」，而 `KernelPluginContext.prefs` 的契约形状也确实是
`get<T>(key: string)`。但 application 层的 `Prefs` 接口把 `customCliDir`（隐式 pi 的）
与 `dshCustomCliDir` **枚举**了进去——加内核就要改中层类型（§6.3 检验④ 禁的形态），
而且 `customCliDir` 不带前缀本身就是"默认就是 pi"的残留特权（§1.4）。

**发现它的信号是装配点那句 cast**：`prefsStore.get(key as keyof Prefs)`。
契约要泛型键、实现只接受 `keyof Prefs`，中间靠强转糊上——强转存在的地方，
就是"契约与类型对不上"的地方。

修法：给 `JsonPrefsStore` 加**动态键** API（`getDynamic`/`setDynamic`/`removeDynamic`，
不进 `T`、不需强转、照样持久化，因为 `data = {...defaults, ...raw}` 且写盘整份 dump），
装配点改用它，然后把两个字段从 `Prefs`/`DEFAULT_PREFS` 删掉。
**持久化格式没变**（盘上仍是那两个键名，由各内核插件自己声明），所以无需迁移；
未设置时读到 `undefined`，消费方本就按 falsy 处理（`?? ""` / `if (custom)`）。

⚠ 类型层重构**照样要验行为**，否则是纸面正确。已补 e2e `kernel-custom-dir.e2e.mjs`（9 项，零 token）
走完 ① UI 填入能通过校验的目录并应用 → ② 盘上出现**插件自定键名**（壳不认识它）与正确的值 →
③ **重启后**输入框显示同一目录（读回走同一条动态键路径）→ ④ 清除后盘上回到空串。
只验①会漏"界面改了没落盘"，只验②会漏"落盘了读不回"——而后者正是换 API 最容易断的地方。
（另注：apply 会先校验目录，pi 找 `dist/cli.js`、dsh 找 `apps/cli/lib/bin.js`，
所以剧本要造一个能通过校验的假目录，否则拿到的是"校验失败"而不是"写入成功"，看起来像 prefs 坏了。）

### 17.33 事件 payload 要带**语义**，别让消费方从路径反推（r33）

`system:configFileSaved` 原本只带 `{ path }`，消费方自己判断"这是不是我关心的文件"。
timeline 的写法是 `payload.path === MODELS_CONFIG_PATH`，而那个常量在**发布面**里、
值是 `"~/.pi/agent/models.json"`。两个问题叠在一起：

1. 通用插件靠**某个内核的私有路径**做判断（内核名泄漏，r31 记的架构债）；
2. 加内核时这条链对新内核**静默失效**：路径不匹配 → 不重探模型清单 →
   用户改了模型配置却看不到变化、要重启才行，**全程无报错**。

正确做法是**语义由声明方给出**：设置页手里就有被保存项的贡献声明
（`kernelModels` / `kernelConfig`，类型都是 `KernelId`），它知道"这次保存的是内核模型配置"，
不需要消费方拿路径反推。于是 payload 变成 `{ path, kind }`，`kind` 由圆心纯函数
`configSavedKind(item)` 派生，消费方只认 `kind === "kernelModels"`。

三条落地纪律：

- **派生函数放圆心、收发双方共用**（§1.3 契约单源）。两端各写一遍判断，语义必然漂移；
  共用一个纯函数，它还可裸单测（7 条，含"任何内核 id 都同样派生"与"派生不依赖路径"两条★）。
- **`path` 保留**。它是日志/调试信息，也可能有按路径精确匹配的老消费方；
  加语义字段而不是替换，改动面最小。
- ⚠ **这类重构最容易断在"声明挂在哪一层"**。`kernelModels` 声明在设置**TAB** 上，
  不在 entry 上；如果 emit 点传的是 entry，`kind` 会静默派生成 `pluginConfig`、缺陷照旧，
  而且 tsc 与单测**都不会红**（纯函数没错，是喂进去的对象错了）。
  必须核到具体那一行：`activeItem = activeEntry?.tabs?.[activeTabIndex] ?? activeEntry`（取的是 tab ✓）。
  这正是"纯函数两端都有单测"仍然不够、必须补一条真机 e2e 的理由。

配套补的两件事：设置页 TAB 按钮此前**没有锚点**（只有 `key={tab.id}`），
被改的那条路径 e2e 根本走不到 → 补 `data-settings-tab` / `-tab-active`；
新剧本 `models-config-save.e2e.mjs`（6 项，零 token）走完
「切到模型 TAB → 改开关 → 保存浮层出现 → **模型配置文件真的变了** → 回聊天页 composer 仍有绑定模型 → 零报错」。

> 通则：看到消费方在用**路径/名字字面量**判断"这是哪一类东西"，先问一句
> "**发送方是不是本来就知道？**"。通常都知道——那就把语义放进 payload，
> 而不是让每个消费方各自反推一遍（反推规则一旦不同，行为就开始分叉）。

### 17.34 高密度控件的组装审计：叠放/分组/状态三件事要**成对**验（r34）

模型下拉是全应用信息密度最高的控件之一：内核 TAB 条 + provider 两级分组 + 模型项 + 选中态 +
锁定降级态，而且为了"切内核时下拉宽度不跳动"用了 **grid 叠放**——所有内核的清单叠在同一
grid 单元格，非激活的 `height:0 + visibility:hidden + aria-hidden + pointer-events:none`。

这种结构最容易出的问题不是"渲染不出来"，而是**渲染出来了但组装错了**。新剧本
`model-dropdown-audit.e2e.mjs`（24 项，零 token，连跑稳定）按五组判据审，其中三组是**成对**的：

| 判据 | 成对的另一半 | 只验一半会漏掉什么 |
|---|---|---|
| 项在 `aria-hidden` 里 | 项**同时**不可见 | 只藏可读性不藏视觉（读屏与眼睛看到的不一样），或反之 |
| 分组头有对应可见项 | 可见项都有对应分组头 | "有头无项"（空分组）与"有项无头"（游离项）是两种不同的混乱 |
| 置灰的 TAB 带 title | 置灰的**模型行**也带 title | 同一组件内两种标准 —— 本轮的真实缺陷 |

**本轮修的真缺陷**：会话锁定内核后，其它内核的模型行只是 `opacity: 0.4`，
**没有任何解释**；而同一个下拉里的内核 TAB 却有 `title={t("shell.kernelLocked")}`。
用户看到一排灰的模型，不知道是坏了、没装、还是因为会话已锁定 —— 这就是 §7.6 说的
"置灰但静默"。timeline 早有正确范式（`thinkingUnavailableHint` = 置灰 + 悬浮真实原因），
对齐它即可（复用同一个 i18n key，不新造文案）。修完实测 52 个置灰行全部带原因
「当前会话已使用 minimal 内核，跨内核切换后续支持」，且是真译文不是裸 key。

顺带补的锚点（此前 e2e 只能按文本/透明度反推状态）：
`data-composer-model-item="<kernel>/<provider>/<id>"`、`-selected`、`-locked`、`data-composer-model-provider`。
以及一处**单一事实源**收敛：Check 图标与 `data-composer-model-selected` 共用同一个
`selected` 判据，避免两处各写一遍三段比较而漂移。

### 17.35 剧本编写陷阱两则（同一轮各踩一次，都很像产品缺陷）

1. **id 里可能含分隔符，就不能靠 `split` 取段。** 模型 id 实测形如
   `bifrost/dashscope/qwen3.8-max`，而锚点值是 `kernel/provider/id` 拼出来的 —— `split("/")`
   会得到 5 段。我在**同一个剧本里犯了两次**：先是断言"段数 === 3"把正确行为判成缺陷，
   再是比较选中项时 `const [sk, , sid] = key.split("/")` 取错了 id，
   于是"打勾的项与按钮显示的不是同一个模型"这条假红。
   正解：**整体比对**，或 `startsWith(kernel + "/") && endsWith("/" + id)`。
2. **`clickPointUntil(page, locate, predicate, {arg})` 的 `arg` 会传给两个函数，两个都是页面内执行的。**
   我的 predicate 改对了（内联 DOM 查询），但 **locate 仍在用 Node 侧闭包变量** `otherTab` ——
   它在页面里是 undefined，locate 抛错后被内部的 `.catch(() => null)` 吞掉，
   `pt` 为 null ⇒ **一次都没点**。症状却是"切了 TAB 但清单没换"，看起来像产品坏了。
   > 通则：凡是被 `.catch(() => null)` 兜住的定位函数，**失败与"元素不存在"不可区分**。
   > 诊断这类问题时，先打印 `elementFromPoint` 与按钮 rect 确认"到底点没点、点在谁身上"，
   > 别先去怀疑被测功能。

### 17.36 改一个 ARIA role 是**横切**改动：先 grep 测试语料（r35）

缺陷：模型清单是**单选**语义，但用的是 `DropdownMenu.Item`（`role="menuitem"`），
选中态只有一个 Check 图标 —— 读屏用户听不出哪个是当前模型（**视觉信息与可访问信息不对等**）。

正确修法是用语义正确的部件：`DropdownMenu.RadioGroup` + `RadioItem`，由 Radix 自动给出
`role="menuitemradio"` 与 `aria-checked`。**不要**直接在 `Item` 上覆盖 `role` ——
手改 role 会与 Radix 内部的键盘导航/typeahead/焦点管理不一致，得到"属性对了但行为不对"的更坏结果。

改完的连带面比改动本身大得多：`grep -rl "menuitem" scripts/demo/*.e2e.mjs` 命中 **27 个剧本**，
其中 24 个用 `[role='menuitem']` 定位**模型项**，共 53 处选择器全部失效（症状是"切不到 minimal 模型"，
看起来像产品坏了）。处置：

- 把选择器统一放宽成 `[role^='menuitem']`（同时匹配 `menuitem` / `menuitemradio` / `menuitemcheckbox`）。
  对**其它**菜单（右键菜单、思考档位下拉仍是 `menuitem`）是等价放宽 —— 那里没有 radio 项。
- 但**严格相等**的断言不能用选择器放宽糊过去，要逐个判断：
  `session-list-audit` 断言右键菜单项 `role === "menuitem"` 是对的（不动）；
  我自己那条"锁定行形态"断言必须改成 `menuitemradio`。
- 还有一处容易漏：`composer-session-audit` 里统计**可交互元素**的选择器清单
  （`button, a[href], …, [role=menuitem], [role=checkbox], [role=switch]`）——
  `menuitemradio` 同样可聚焦，漏了会让"可交互元素计数"少数，而这类计数断言通常是 `>=`，
  **少数不会红**，只会让判据悄悄变松。
- 花真 token 的剧本（`kernel-thinking-matrix`：真实 pi+dsh 三条 tiny prompt）不为了验证而跑，
  改为**逐处静态核验**并如实记录：模型选择处本就要求"可见+未禁用"（RadioItem 的 disabled
  同样渲染成 `data-disabled`/`aria-disabled`），档位选择处按精确文本 `"低"`/`low` 匹配
  （模型名不可能撞上）。

重构后新增 6 条 a11y 断言（剧本从 24 项增至 **30 项**）：每个可见模型项都是 `menuitemradio`、
都有明确的 `aria-checked`（不能缺失）、**恰好一个** `aria-checked=true`、
且它与 `data-composer-model-selected` 是同一项（可访问态与视觉态同源）、
以及被叠放隐藏的那份清单里**没有** `menuitemradio`（否则键盘会走到看不见的项上 ——
这正是 `renderKernelList` 的 `interactive` 参数存在的理由，重构不能把它丢掉）。

> 通则：**改 role / 改标签名 / 改锚点名之前，先 grep 整个测试语料**。
> 这类改动的连带面几乎总是比改动本身大，而且失效症状一律长得像"产品坏了"。
> 顺带一条：放宽判据时要检查它是否因此**变松**（`>=` 型计数断言在元素变少时不会红）。

### 17.37 「视觉态有、可访问态无」的系统性查法（r36）

r35 修的那个缺陷（模型清单用 `menuitem` 表达单选）不是孤例，它属一类：
**状态只用颜色/图标表达，没有对应的 ARIA 状态**。查法是可自动化的：

1. 扫出所有**带状态语义的 `data-*` 属性**（`-open` / `-active` / `-selected` / `-pinned` /
   `-collapsed` / `-checked` / `-current` …），实测通用层 13 处；
2. 对每一处问：这个状态**同时**有没有暴露给辅助技术（`aria-expanded` / `aria-selected` /
   `aria-current` / `aria-checked` / `aria-pressed`）？
3. 顺带统计整个通用层的 aria 覆盖面当基线：实测 `aria-expanded` 6、`aria-checked` 2、
   `aria-pressed` 3、`aria-current` 1、`aria-selected` 1、**`aria-disabled` 0**。
   数字低不等于都有缺陷（Radix 会自动给一部分），但它告诉你**手写控件**是重点怀疑对象。

⚠ 这个扫描**必然有假阳性**，结果要逐个核实而不是照单修：
· 状态属性挂在**容器**上、开关在子元素上（共享 `Section` 的 `data-section-collapsed` 在根 div，
  而 `<button aria-expanded={open}>` 在里面 —— 已经是对的）；
· aria 由**组件库自动给**（模型项的 `aria-checked` 来自 Radix RadioItem，源码里搜不到字面量）；
· 该文件只是**读**这些锚点（`sidebar.tsx` 用 MutationObserver 观察 `data-section-collapsed`）。
本轮 13 处里，真缺陷只有 2 处，其余 11 处核实为合法 —— 但**核实本身**就是产出：
它把"哪些已经做对了"变成已知事实，下一轮不必重扫。

**查出的两处真缺陷：**

1. **设置页的 TAB 条是一排裸 `<button>`**：无 `role="tablist"` / `role="tab"` / `aria-selected` /
   `aria-controls`，面板也没有 `role="tabpanel"`。读屏只会念成"按钮"，既听不出这是一组互斥 TAB，
   也听不出哪个是当前选中的（选中态只用 `borderBottom` 颜色 + `color` 表达）。
   手写 TAB 条要自己补齐 ARIA APG 的**全套**：容器 `role=tablist` + `aria-label`、
   每项 `role=tab` + `aria-selected` + `aria-controls`（**tab[i] → panel[i]**，别指向 entry 级 id）、
   面板 `role=tabpanel` + `id` + `aria-labelledby`、**roving tabindex**（只有选中项 `tabIndex=0`，
   其余 `-1`）、以及 **ArrowLeft/ArrowRight** 在同组内移动焦点并激活
   （Radix Tabs 自带这些，手写的一条都不会自动有）。
2. **项目行的激活态只有颜色**：dnd-kit 的 `attributes` 已给了 `role="button"` 与 `tabIndex`，
   缺的是"当前项"语义 → 补 `aria-current={active ? "true" : undefined}`
   （注意非激活时要给 `undefined` 而不是 `"false"`，否则每行都带一个 aria-current）。

⚠ **惰性挂载的取舍要写出来**：从未访问过的 TAB，其面板还没 mount，`aria-controls` 会指向
暂不存在的 id。这是 lazy-mount UI 的常见取舍（点开即建立），比"整条 TAB 无语义"好；
而 `role=tab` 与 `aria-selected` 这两个**关键**语义不依赖面板存在，始终有效。
把取舍写进注释，而不是假装没有断链。

新行为必须验：方向键导航是新写的逻辑，补了 3 条断言（ArrowRight 后选中态移到下一个 TAB、
**焦点跟着选中态走**、ArrowLeft 回到起始 TAB）。`settings-controls-audit` 从 31 项增至 **42 项**，
`project-switch-audit` 从 21 项增至 **23 项**，全绿。

> 通则：审 a11y 不要从"ARIA 属性够不够多"入手（那会产出一堆装饰性属性），
> 而从**"这个状态在界面上怎么被看见的"**入手 —— 颜色、图标、勾选、位置，
> 每一种视觉表达都问一句"不用眼睛能不能得到同一个信息"。

### 17.38 瞬时提示的 a11y：**容器必须先于内容存在**（r37）

实测：通用层 `aria-live` **0 处**、`role="status"` 1 处、`role="alert"` 1 处、`aria-atomic` 0 处。
而应用里有 **6 处** toast 状态源，其中共享 `Toast` 部件（`packages/react/src/widgets/toast.tsx`，
fixed 定位、2.5s 自动消失）**完全没有 live region 语义**——读屏用户一条都收不到。
toast 承载的恰恰是**一次性告知**（「附件类型不支持」「已跳过 N 个不可参考的文件」「保存失败」
「重试失败」），错过就没有第二次机会；而"重试失败"这类甚至**没有其它可见后果**。

⚠ **最容易做错的一步**：给条件挂载的元素直接加 `aria-live` 是**不够的**。
消费方的写法一律是 `{toast && <Toast … />}` —— 元素与文本**同一次挂载**，
而 `aria-live` 的播报前提是**容器在内容变化之前就已经在 DOM 里**。
（`role="alert"` 因为是"插入即播报"的特例，可靠性稍好，但 success/info 用的 `status` 基本听不到。）

正确结构是**常驻宿主 + 内容进出**：

```tsx
// 单例、常驻、0×0、pointer-events:none 的宿主，带 aria-live/aria-atomic/role
export function ensureToastHost(): HTMLElement { /* 幂等；脱离文档时重建 */ }
// 应用根挂一次 → 宿主从启动就存在 → 连**第一条**也能播报
export function LiveRegionHost(): ReactNode { useEffect(() => { ensureToastHost(); }, []); return null; }
```

三条设计取舍，每条都有理由、都写进了注释与断言：

| 取舍 | 理由 |
|---|---|
| 宿主用 `polite` + `role="status"` | toast 是"告知"不是"打断"，自动消失、非阻塞，不该抢占用户当前朗读 |
| `aria-atomic="true"` | 整条消息作为一个整体播报（里面可能有图标 + 文本），不逐节点念 |
| **error 变体**在内容元素上另给 `role="alert"` | 出错要立刻知道，可打断；**嵌套** alert 有效，且不需要再写 `aria-live`（嵌套 live region 会互相干扰） |

还有一条通用原语 `Announce`（只补"被读到"、不改视觉）：应用里并非所有瞬时提示都走共享 `Toast`
——timeline 的提示条锚在输入框附近（带图标、非 fixed 顶部），retry/continue 的报错是行内一个
`<span>`。把它们全迁到 `Toast` 会改变视觉位置与既有交互，**代价与收益不对等**；
它们缺的只是"被读到"这一件事，所以用 `<Announce message={…} variant="error" />` 与原有视觉元素**并存**。

单测 13 条（`live-region.test.tsx`）钉住：宿主语义正确、**幂等**（文档里只能有一个，
多个 live region 会互相干扰/重复播报）、脱离文档后能重建、0×0 不占位；
`LiveRegionHost` 挂载即建宿主且自身不渲染可见内容；`Toast` portal 进宿主内部（不是 body 直挂）、
error 带 alert 而 success 不额外声明 role；`Announce` 送进宿主、空消息不产生节点、自身不渲染可见内容。
真机侧补进 `dom-audit`（5 条）：**启动即有且仅有 1 个**宿主、aria 三件套正确、0×0——
"应用根真的挂了它"这件事只有起真 app 才知道（实测 `{count:1, ariaLive:"polite", ariaAtomic:"true", role:"status", box:{w:0,h:0}}`）。

⚠ 一处连带：retry/continue 的既有测试用 `vi.mock("@my-harness-desktop/react")` 给了替身，
新增导出后 mock 里没有 `Announce` → 3 条测试报 `No "Announce" export is defined on the mock`。
这是 §11.12「测试替身必须与真实形状一致」的又一次实例：**给发布面加导出时，
要顺带查有哪些测试 mock 了这个模块**。

### 17.39 有些缺陷只能靠**面级普查**，不能靠点级单测（r38）

图标按钮缺可访问名这类缺陷的特点是：**看不见也点不出来**（按钮照常显示、照常能点、
视觉完全正常），正向功能剧本永远撞不到；而逐个组件写单测又**覆盖不全**——
新增一个图标按钮就多一个洞，且没人会记得给它补测试。

所以用**普查**：起真 app、走遍所有视图、把每个可交互元素的可访问名按 ARIA 计算顺序算出来
（`aria-labelledby` → `aria-label` → 元素文本 → 内部 `img[alt]`/`svg title` → `title`），
全部落空即缺陷。剧本 `a11y-names-audit.e2e.mjs` 首跑实测：**23 个视图 / 1379 个可交互元素**，
无名 **12 处、去重后仅 3 种**：

| 处 | 形态 | 为什么漏 |
|---|---|---|
| 共享 `Pagination` 的左右箭头 ×2 | 纯 `ChevronLeft`/`ChevronRight` 图标 | 部件在发布面里，不能写死文案，于是干脆没给名字 |
| plugin-manager 每行的拖拽手柄 ×10 | dnd-kit 的 `attributes` 给了 `role="button"` 与 `tabIndex`，但**可访问名要自己给** | 误以为"库给了 role 就等于给了语义" |

三条可直接复用的结论：

1. **共享部件的缺陷会被所有消费方复制一遍**（3 种里 2 种出自同一个部件）。
   普查报告要**去重后按出现次数排序**，次数最高的那个往往就在共享层。
2. **库给的 `role`/`tabIndex` 不等于可访问名**。dnd-kit、Radix 这类库会把角色和键盘可达性
   给你，但"这个控件叫什么"永远是内容层的责任。
3. **让漏传在编译期暴露，比事后审计强**：把 `prevLabel`/`nextLabel` 设成**必填 props**
   （而不是可选 + 默认文案），改完 tsc 立刻在两个消费方各报一条
   `TS2739: missing the following properties`。这比 lint 规则或测试都硬——
   因为它不可能被"忘了跑测试"绕过。发布面不能写死文案（§1.2），
   文案落在壳的 `shell.*` 命名空间（一处、四语言、两个消费方共用）。

顺带修了页码按钮缺 `aria-current="page"`：它有数字文本所以"有名字"，
但光念"3"听不出这是**当前页**——这是"有可访问名"与"可访问名**够用**"的区别，
普查只能查前者，后者要靠对具体控件的语义判断。

**两层守卫**：普查（真机、慢、完整、能抓到任何新洞）+ 部件单测（快、提交前就拦住，
`pagination.test.tsx` 6 条）。并对普查本身做了反向注入：删掉 prev 的 `aria-label` →
普查 FAIL，且现场信息精确到 `data-pagination=prev` 与图标类名（能直接定位）。

> 通则：**"每个 X 都必须有 Y"这类全称命题，用普查而不是抽样**。
> 抽样只能证明"我看过的那些是对的"，普查才能证明"没有漏的"；
> 而普查的产出是一份**去重后的种类清单**，通常比原始命中数小一个数量级（12 → 3），
> 修起来是完全可行的工作量。

### 17.40 库给的 ARIA 是**半成品**，且运行时普查看不见未渲染的元素（r39）

r38 查"有没有名字"，本轮查"**状态有没有语义**"。三条可复用的结论：

**① 组件库给的 ARIA 往往只给一半。** `react-resizable-panels` 的 `PanelResizeHandle`
渲染出 `role="separator"`、`aria-valuenow/min/max`、`tabIndex=0`、`aria-controls`——看起来很完备。
但实测 4 处手柄**全部** `aria-label=null`、`aria-orientation=null`。两个后果：
读屏只念"分隔条 19"，不知道它分隔的是什么；而 `aria-orientation` 缺省时按 ARIA 落到
**默认值 `horizontal`**，对 `col-resize` 的手柄（竖向分隔条、水平移动）是**错的**——
读屏会给出相反的方向提示，用户按 ↑↓ 调而实际要按 ←→。

> 通则：**"库已经处理了 a11y"这个假设要用运行时探针证伪**，不能靠读文档或看有没有 `role`。
> 探针要打印的是**完整属性集**（label / orientation / valuenow / tabIndex / controls / cursor），
> 只打印 `role` 会让你以为已经完备。

而且朝向**不能写死**：`layout-engine.tsx` 的手柄朝向取决于 `split.direction`
（horizontal 布局 ⇒ 手柄是竖条 ⇒ `vertical`），必须按方向算。
即便某处的值恰好等于 ARIA 默认值，也要**显式写出**——默认值不是契约，库改版就可能变。

**② 运行时普查看不见"当时没渲染"的元素，必须配一条静态守卫。**
右面板的分隔条只在"2 个以上堆叠 TAB"时才渲染（`i < renderIds.length - 1`），
默认布局下根本不出现 ⇒ 普查只看到 3 个，而全仓有 **4 个**站点。
未被渲染 ≠ 无缺陷：用户把右面板拉成堆叠布局时它就在，而那时没人测过。
所以补 `src/resize-handle-a11y.test.ts`（4 测）扫**源码里全部站点**，
要求同一元素上同时出现 `aria-label` 与 `aria-orientation`，外加一条"名字必须走 i18n 不许写死"。
**反向注入验证过分工**：删掉右面板那处（普查够不到的）的 `aria-label` → 静态守卫红、普查不红；
这正好证明两者不是重复而是互补。

**③ 源码 grep 会低报运行时属性。** `aria-disabled` 在源码里 grep 是 **0 处**，
但真机探针数出 **11 处**——因为它是 Radix 在运行时根据 `disabled` prop 设置的。
所以"某属性全仓 0 处"这个结论**只对显式书写成立**，判缺陷前必须再用运行时探针对一遍，
否则会去"修"一个根本不存在的问题（我差点就这么干了）。

**两条判据写法上的细节：**

- **同源性**：不能只断言"有某一行带 `aria-current`"，要断言**带 `aria-current` 的那一行 ==
  视觉上有激活底色的那一行**。否则可能各说各话（可访问态指 A、视觉态指 B），
  而两条单独的断言都会绿。
- **`aria-current="false"` 是噪音**：非激活项要给 `undefined`（属性不出现），
  不是 `"false"`。给 `"false"` 等于每个元素都挂一个状态属性，部分读屏会念出来。

### 17.41 「有名字」≠「名字**够用**」：状态要进可访问名，不是给图标加 label（r40）

r38 的普查查的是"每个可交互元素有没有可访问名"，归零了。但**另一类缺陷普查结构上查不到**：
元素有名字，名字却**不承载状态**。

实例：会话列表的行。它的可访问名是标题文本（所以普查判它合格），而"置顶""归档"
"正在思考/执行工具/重试/压缩"这六种工作阶段，全部只靠**图标形态与颜色**表达
（`Pin` / `Archive` / `PhaseIcon` 的六种形状与配色）。读屏用户听得到"排序甲"，
听不到"已置顶、思考中"——视觉信息与可访问信息不对等，而且这一行是用户导航的主入口。

**修法的关键选择**：补一段**视觉隐藏的状态文本**到行内（于是它自然并入行的可访问名），
而**不是**给每个图标加 `aria-label`。理由：图标是装饰性的，语义应由文本承担；
给每个图标单独加名字会让读屏念出一串碎片（"图钉 图片方块 脑"），比没有更糟。
配套地，与状态文本重复的装饰图标要标 `aria-hidden="true"`（避免重复播报）。

断言要落在**行的可访问文本**上，不能只断"某处有这个文本"：

```js
ok(rowAccessibleText.includes("已置顶"), "状态文本必须在行的内容里，否则读屏念行时听不到");
```

实测修完行的可访问文本是「审计改名甲**已置顶**[minimal echo] 甲会话的提问」。

**三条配套纪律：**

1. **复用既有译文，不另造一份**（§1.3 契约单源）。阶段文案直接用 timeline 底部指示器
   那套 `shell.*` 键（`shell.thinking` / `shell.requesting` / …）。查的过程中发现
   `shell.retrying` **四个语言全缺**——但那是**有意的**：timeline 的注释写明
   「idle/retrying 不在此表：前者不显示指示，后者由重试横幅承担」。
   而会话行的图标确实画了 retrying 的红色转圈，所以这个键对**行**是必需的。
   > 教训：发现"缺一个键"时先查它**为什么**缺。可能是遗漏，也可能是有意分工；
   > 前者补上，后者要判断"我这个消费方是否属于原设计没考虑到的场景"。
2. **首次使用某个工具类，要断言它真的生成了**。这里第一次在本仓用 Tailwind 的 `sr-only`，
   而本仓有过 `@source` 扫描漂移的历史（CLAUDE.md §3.7：7/29 修过、8/27 原样复发）。
   类没生成的后果**比不加更糟**——那串"已置顶"会直接显示在界面上。
   所以断言的是**计算样式**而不是类名存在：`position === "absolute" && w<=1 && h<=1 && overflow==="hidden"`。
   （顺带一条：验证类是否生成时，`grep "sr-only{"` 会漏——产物是 `.sr-only {` 带空格的未压缩形态。）
3. **状态文本要在行内，不在行的兄弟节点**。读屏念的是行这个可聚焦单元；
   放在行外面（比如放在分组头上）等于没放。

### 17.42 折叠控件的三件套要么全给要么全撤；重复实现才是根因（r41）

审消息流里的折叠块（工具卡 / 思考链 / 分隔条详情），过程里有两步值得单独记：

**第一步差点报了一个不存在的缺陷。** 看到 `tool-cards.tsx` 的 `CardHeader` 里有一堆 span，
我判断"根元素大概是 `<div onClick>`，那键盘就完全不可达"。**去读了才知道它是错的**：
`CardHeader` 有 `role="button"` + `tabIndex={0}` + Enter/Space 的 `onKeyDown`，键盘本来就可达。
如果按猜测写进报告，就是一条假缺陷（而且是"看起来很专业"的那种，最难被质疑）。

**真缺陷在它的重复实现里。** 同一个文件的 `DefaultCard`（兜底卡，承载 custom_message 与未知工具）
**自己内联了一份卡头**，而那一份比 `CardHeader` 差三处，且三处都是"看不见"的：

| | `CardHeader`（Bash/Edit/Read 卡在用） | `DefaultCard` 内联的那份 |
|---|---|---|
| 键盘 | `role=button` + `tabIndex=0` + Enter/Space | `onClick` 挂在 div 上，**三者全无** ⇒ 键盘完全不可达 |
| 状态文案 | i18n | 硬编码英文 `running` / `error` |
| 展开态 | （本轮补）`aria-expanded` | 无 |

而兜底卡恰恰是**最需要能被展开看内容**的那一种（未知工具的 args/result 只能在这里看到）。
根因是 §3.5 的重复实现，所以修法是**收敛**而不是三处各打一个补丁：给 `CardHeader` 加
`expandable?: boolean`，`DefaultCard` 改用它。三个问题一次消失，且以后不会再分叉。

**收敛时定的一条纪律：折叠语义三件套要么全给、要么全撤。**
`role="button"` / `tabIndex` / `aria-expanded` 必须成套：

- 只给 `role` 不给 `tabIndex`+键处理 ⇒ 读屏能发现但键盘到不了；
- 只给 `tabIndex` 不给 `role` ⇒ 键盘能到但读屏不知道它是按钮；
- **给一个点了不动的元素挂 `aria-expanded="false"` ⇒ 错误承诺**：读屏用户会一直试着展开，
  而什么都不会发生。所以"无详情可展开"时三者全撤（它就是个静态标题，不是控件）。

这条写成了两条对照测试（无详情 ⇒ 三者全无；有详情 ⇒ 三者齐全），
只写前一条会把实现推向"一律不给"。

**图标态改文本态的同一套做法**（与 r40 一致）：工具卡的成功/失败此前是纯 `<Check/>` / `<X/>`
（无可访问名）——而"这个工具成功还是失败"恰恰是工具卡最该被听到的一条信息。
修法：图标标 `aria-hidden` 保留视觉锚，语义由 `sr-only` 文本承担；顺带把硬编码的
`running` / `error` 收进 i18n（新增 `timeline.toolRunning/toolFailed/toolSucceeded` × 4 语言）。
分隔条的 `aria-expanded` 也**只在有 detail 时声明**（同一个"错误承诺"理由）。

⚠ 本轮的工具卡/思考链断言落在**单测**（渲染真实组件 + 真实 DOM），没有进 e2e：
零 token 的 minimal 会话不产生工具调用，而 seed 引擎的场景 spec 里没有现成的工具调用剧本。
这些是纯渲染件（无集成风险），单测覆盖是合适的层级——但要**如实标注覆盖到哪一层**，
不能因为"测了"就当成全链路验过。

### 17.43 硬编码文案守卫的两个盲区：**语言**与**文件扩展名**（r42）

既有的 `shell-no-hardcoded-copy.test.ts` 有三个探测器（ATTR / JSX_TEXT / 括号内 CJK），
但它们**全部以 `[\u4e00-\u9fff]` 为判据**——只认中文。于是两个盲区：

**盲区一：硬编码英文完全不设防。** 而这是个**四语言**产品，硬编码英文对 de/zh-CN/zh-TW
用户同样是缺陷。实测漏网的有：工具卡的 `running` / `error` / `lines collapsed` / `exit {code}`、
模型配置页的 `unknown error`、文件预览的 `File system access is not available` / `No content returned`、
transport 的 `remote error`。已补英文探测器（判据刻意收紧：字面量**整体**形如
"2 个以上纯英文单词、单空格分隔、无任何标点符号"，以避开专名/类名/路径/i18n 键造成的大片假阳性；
CSS 声明上下文整行跳过——否则 `font-family:…,'Segoe UI',…,'PingFang SC'` 会被当成文案）。

⚠ **最糟的形态不是整句英文，而是一句话里两种语言**：file-preview 把
`throw new Error("File system access is not available")` 的消息经 `setError(err.message)` 存下、
再按 `${t("preview.loadFailed")}: ${error}` 显示 ⇒ 用户看到
「加载失败: File system access is not available」。前缀翻译了、原因没翻译——
这种混合串比纯英文更难被发现，因为**看起来已经 i18n 了**。

**盲区二：`walk()` 的默认 exts 是 `[".tsx"]`**，所以 `src/web` 与 `packages/react/src` 里的
**`.ts` 文件从不被扫**。实测那一片有 34 处中文字符串，其中确有用户可见的
（`build-kernel.ts` 的安装超时 `error:` 字段、`bootstrap.ts` 的断连浮层 `textContent`、
`login-gate.ts` 的整个登录闸文案）。这与 r28「守卫只覆盖一个名字而非同族」、
r31「扫描范围要含会到达 UI 的夹具」是**同一类缺陷：判据的覆盖面小于它声称的覆盖面**。

**但不能简单把 exts 放宽到 `.ts`**：那 34 处里大多数是**开发者可见的不变量违规**
（`throw new Error("setLayout 的树根必须…")`、`warnOnce("装配顺序被破坏")`），
只进 console、只给开发者看，翻译它们反而有害（报错原文是排查线索）。

⚠ 而且**"是不是 throw 出来的"不能当判据**——上面 file-preview 那两处正是 `throw new Error(...)`，
却被 catch 后显示给用户。正确判据是**静态可判的"必然被显示的汇点"**：
`.textContent =` / `.innerText =`（直接写进 DOM 文本）、对象字面量的 `error:` 字段
（本仓 API 结果形状，UI 会渲染它）。这三类出现字面量即缺陷；throw / warn / console 不在判据内。
自检要**双向**：三个汇点形态都要能识别，且 `throw new Error(...)` / `warnOnce(...)` 必须**不**被识别。

**三条配套纪律（都是本轮实踩）：**

1. **账本的语义是"当前存在且合法的豁免"**，不能拿账本条目当回归锚。
   我曾想留一条 `remote error` 作"若它再出现就说明回退了"的对照——修好之后
   ② 的腐烂检查立刻（正确地）红了：源码里已经没有这个串，豁免就该删。
   **回归保护要写成独立断言**，不要塞进豁免清单。
2. **守卫要判代码，不判原文**：修复说明的注释里必然会引用旧字面量
   （"此前写死中文 `安装超时`"），按原文判会被**自己的注释**绊倒。探针一律先过 `stripComments`。
3. **非组件的壳代码也能 i18n**：`src/web/kernel/build-kernel.ts` 与 `src/web/transport/ws-transport.ts`
   拿不到 `useTranslation`，但可以 import `i18next` 单例（`src/web/app/i18n-init.ts` 导出）。
   注意时序：只有"必然在 i18n 初始化之后才执行"的路径能这么用（安装超时是 300 秒后触发，安全）；
   模块加载期就要用的文案不行——那种情况（登录闸、断连浮层）恰恰是 i18n **可能拉不到**的时候，
   所以它们自带文案且刻意做成双语，已作为**文件级豁免**登记并写明理由。

守卫从 8 测扩到 **17 测**；反向注入（把安装超时改回硬编码中文）让 **3 条**同时变红
（汇点判据 + 两个回归锚）。

### 17.44 最隐蔽的一类：`aria-label` 挂在**无 role** 的元素上（r43）

这是"视觉态有、可访问态无"里最难发现的一种——因为**代码看起来已经做了 a11y**。
实测三处同型：

```tsx
// 未读圆点：无内容、无 role，只有 title + aria-label
{unread && !hovered && <span title={t("sessions.unread")} aria-label={t("sessions.unread")} className="size-2 rounded-full …" />}
// 内核未装载角标：同样形态（span 里只有一个 svg）
<span title={…} aria-label={…}><TriangleAlert /></span>
```

问题：**ARIA 1.2 不支持在 `role=generic` 上使用 `aria-label`**，各浏览器/读屏实现不一，
很可能被忽略。靠 `title` 兜底也脆——`title` 同时是悬浮提示，且部分读屏/浏览器组合
不会把**后代**的 title 并入父级可访问名。所以这两处的状态在 AT 侧大概率是**空的**。

还叠了第二个隐患：未读圆点的渲染条件是 `unread && !hovered`——**hover 时徽标整个从 DOM 消失**，
状态跟着消失。这与命名无关，是"把状态挂在一个会被交互态移除的节点上"。

**根治办法与 r40 一致**：状态搬进行内**常驻的 sr-only 文本**，徽标改 `aria-hidden="true"`
（视觉锚保留、`title` 保留给明眼人做悬浮解释）。这样一举解决三件事：
命名可靠（真文本一定进可访问名）、不依赖 hover、不会重复播报。

**需要给非交互元素一个名字时，用 `role="img"`**：`stats-titlebar` 的四个统计项
（`↑ 1.2k` 这类"符号 + 文本"）原先也是 `<span aria-label>`。`role="img"` 是
"整块作为一个整体朗读"的既定模式，且它的子节点对 AT **完全不透明**（内层符号本来就已 aria-hidden），
于是可访问名稳定等于 `aria-label`。注意这里**保留了上一轮的两条正确判断**：
仍修在缺名的调用点而不是一刀切进共享的 `HoverTip`（另一个消费者有可见文本 `45%`，
覆盖它会违反 WCAG 2.5.3「Label in Name」）。

**可自动化的通用不变量**（比逐个组件查更划算）：
"行内不得有『无 role 却挂 aria-label』的元素"——一条 `querySelectorAll("[aria-label]")` 过滤
`!getAttribute("role") && !/^(BUTTON|A|INPUT)$/.test(tagName)` 就能扫，实测稳定通过（0 个）。
全仓扫下来这种形态只有 3 处，其中 2 处是正则误报（`{...attributes}` 展开提供的 role 静态看不见、
对象字面量里的 `aria-labelledby`），所以**这个判据适合做成断言、不适合做成硬守卫**（假阳性要人工分辨）。

### 17.45 造不出来的状态：如实降级为"只有代码级证据"，不要凑成通过（r43）

未读态在隔离环境里**造不出来**，两条路都试过：
① 改 header 的 `lastEntryId` → 刷新后行里仍没有未读（说明 `lastEntryByPath` 不是直接读我改的那个字段）；
② 改插件配置里的 `readState[ns]` 为陈旧值 → 仍然没有：`readState` 是插件在**挂载时读一次**，
点刷新不重读配置；而且活跃会话会"自动跟随已读"把它写回。
要真造出未读需要"另一个会话在后台收到新 entry"——那是生产路径（真实内核推送），零 token 剧本复刻不了。

处置（三条，缺一不可）：
1. **能验的照验**：那条通用不变量（行内无"无 role 却挂 aria-label"的元素）与未读无关，稳定通过；
2. **造不出的写成条件断言**：`if (isUnread) { …断言… } else { …打印为什么没验到… }`，
   并且**不计入通过项**——不能因为"跑绿了"就让它冒充覆盖；
3. **在剧本里写清替代证据的强度**：`unread ? t("sessions.unread") : null` 这一支与
   **已真机验证过**的 `pinned`/`archived` 两支在**同一个 `stateText` 数组、同一条渲染路径**上
   （那两条实测行的可访问文本确实带上了「已置顶」/「已归档」）。所以它有代码级 + 同构级证据，
   但没有端到端证据——这个区别要写出来，不能含糊成"已覆盖"。

> 通则：**"验不了"是一个合法结论，"假装验了"不是。** 剧本里出现
> `if (能造出该状态) { 断言 } else { 打印原因 }` 比一条恒真断言有价值得多——
> 前者告诉下一个人"这里缺什么、为什么缺、替代证据有多强"，后者只会让人误以为已覆盖。

### 17.46 共享组件的能力门控：**空页面的负结果不是证据**（r44）

`ModelConfigPage` 是 pi / dsh / minimal **三个内核共用**的（各自只填 `i18nPrefix` 与
`capabilities`）。这类组件有一种**独有的缺陷形态**：某个控件对声明了该能力的内核完全正常，
只在**另一个**内核上错——所以在"有那个能力"的内核上跑一百遍正向剧本也撞不到。

r44 的实例：「developer role 不兼容」勾选框写的是 `supportsDeveloperRole`，而这个字段
**只有 pi 消费**（`kernel/pi/model/models-config.ts` 的 `compat.supportsDeveloperRole`），
dsh / minimal 都没有消费者，控件却**无条件渲染** ⇒ 它们的模型页上有一个勾了也没任何作用的开关
（§7.6 该显式降级却没降级）。

⚠ **文案中性化 ≠ 能力门控，两件事都要做。** 上一轮已把这个控件的措辞中性化
（原文写「pi-ai 对 reasoning 模型默认发 developer」，共享组件里不该出现某个内核的专属措辞）。
但只做中性化，dsh 用户看到的是一个**措辞中性、对自己却毫无作用**的开关——那仍然是缺陷。
前者管"不出现专属措辞"，后者管"没有这一维的内核根本不该看到这个控件"。

修法（§1.5 先抽象后实现）：中立契约 `KernelModelsCapabilities` 加一轴 `developerRole: boolean`
**且设为必填**，三个内核各自声明（pi `true`，dsh / minimal `false`），控件按它门控。
必填的意义：新内核接入时**必须当场表态**（漏声明 = TS2739 编译错），
不会静默等同于 false——与 r38 给分页部件的 `prevLabel`/`nextLabel` 设必填是同一个手法。

**两条实测踩到的判据陷阱：**

1. **空页面的负结果不是证据。** 真机跑三个内核的模型页，dsh 与 minimal 都报
   `devRole=false`——看着像验证通过。但同一份探针数据里它们的**复选框数是 0、文案量只有
   154/130 字**：隔离环境里这两个内核**没有配置任何模型**，页面基本是空的。
   页面空 ⇒ 任何控件都不会出现 ⇒ "没看到 devRole" 什么也证明不了。
   > 通则：断言"X 不存在"之前，先断言**这个页面确实渲染了内容**（有兄弟控件、有非空文案量）。
   > 否则空页面会让所有"不存在"断言恒真。
   真正严格的证据来自单测：用**真实 provider 数据**渲染同一个组件，
   `capabilities={reasoning:true, developerRole:false}` ⇒ 控件不在、`true` ⇒ 在（4 条，含两轴互相独立）。
2. **设置页的 pane 挂载后不卸载**（非激活的只是 `display:none`），所以 document 级的
   `querySelectorAll` 会被**之前访问过的 pane 污染**：首版探针就是这么把 minimal 的
   `reasoning` 判成 `true` 的（那其实是 pi 的隐藏 pane）。
   修法：限定到当前可见的 `[role=tabpanel]`。注意 `innerText` **尊重可见性**（不受污染），
   而 `querySelectorAll` 不尊重——两者结论可能相反，混用会得出自相矛盾的结果。

顺带记录一个**有意为之**、不按缺陷处理的现状：`reasoning` / `contextWindow` / `maxTokens`
这三个 API/schema 字段名在四个语言里都照原样显示（没有 locale 键），而通用 UI 词
（`name`、`devRoleIncompatible`）走 i18n。这是可辩护的策略——用户要拿字段名去对照服务商文档，
翻译反而对不上。但它也暴露了 r42 那个英文探测器的**已知边界**：判据要求"2 个以上单词"，
所以单词级字面量（`reasoning`）不在覆盖面内；那是刻意收紧以避免大片假阳性的代价，
不是漏配，写在这里以免下一轮又去"修"它。

### 17.47 播种夹具要**从真实写入方导出**，而反空转探针自己也会错（r45）

r44 如实记了一条覆盖缺口："dsh/minimal 的门控只有单测级证据，真机页是空的"。
本轮把它补上，过程里两条教训都值得单记。

**① 播种数据的形状不能手猜，要从真实写入方导出来。**
dsh 的 `settings.yaml` 是嵌套 YAML（`llm-pi-ai.providers.<id>` + `apiKeyEnv` 引用，
明文密钥另落 `.credentials.yaml` 的 `refs`）。手写这种结构极易写出"看着像但解析不出"的东西，
而症状会是"页面还是空的"——与"播种没生效"完全无法区分。
做法：写一个**一次性测试**调用真实的 `DshConfigSource.setProvider()`，把它写出的文件 dump 出来，
再照着做播种助手。minimal 同理（形状取自 `MinimalModelsDocument` 类型：
`{ providers: [{id, baseURL, models:[{id,name?}]}], default }`，provider 记录**不含 apiKey**）。
助手落在 `scripts/demo/lib/seed/kernel-models.mjs`（共享基础设施，§17.9），
用 `yaml` 库 **parse → merge → dump**，不覆盖 `setupBaseline` 从真实 HOME 复制来的其它命名空间。

> 命名也跟着职责走：文件原叫 `dsh-models.mjs`，加了 minimal 播种后改名 `kernel-models.mjs`——
> 名字说谎的助手，下一个人不会想到用它。

**② 反空转探针自己也会给出假结果。**
剧本里有一条"先证明页面真的渲染了播种的模型，再断言控件不存在"（r44 的教训）。
它报了假红：dsh 页面明明有 `Audit Seed (2)`、2 个复选框、2 个 reasoning 控件，
探针却说"播种的模型名一个都没找到"。根因：**模型名是渲染成 `<input value=…>` 的，
而 `innerText` 不包含 input 的值**。修法是把 input 值一起并入检索串。

> 通则：反空转断言是"用来防止假绿的"，所以它一旦报红，**先怀疑探针的取样面**，
> 再怀疑被测功能。取样面常见的漏项：`input/textarea` 的 value、`placeholder`、
> `title`/`aria-label` 等属性、被 `display:none` 的兄弟 pane、canvas/svg 里的文本。

**③ 受门控的控件要有锚点。** `devRole` 与 `reasoning` 两个控件原先只能按译文定位
（`devRole 不兼容` / 裸字面量 `reasoning`），换语言就失效。已补 `data-model-devrole` /
`data-model-reasoning`，单测与 e2e 都改用锚点（单测里原先按 `label.textContent === "reasoning"`
精确匹配，那也是在赌字面量）。

补完后的真机证据（`kernel-capability-gating.e2e.mjs`（r45 时名为 model-capability-gating），14 项，零 token，连跑两次稳定）：

| 内核 | 播种 | 页面非空证据 | devRole | reasoning | 与声明一致 |
|---|---|---|---|---|---|
| pi | 用 `setupBaseline` 复制的真实 `~/.pi` | 42 个复选框 | **21** | 21 | ✓（true/true） |
| dsh | `seedDshModels` 2 个模型 | 两个模型名都在（含 input 值） | **0** | 2 | ✓（false/true） |
| minimal | `seedMinimalModels` 2 个模型 | 两个模型名都在 | 0 | **0** | ✓（false/false） |

外加一条**跨内核对照**：同一个共享组件在 pi 与 dsh 下呈现不同（21 vs 0）⇒ 门控真的按
各内核的声明生效，而不是写死成"全开"或"全关"。这条比逐个内核断言更强，
因为"全关"也能让 dsh/minimal 的断言通过。

### 17.48 注释可以描述一个**不存在的行为**；能力轴必须与消费者同批落地（r46）

r45 结尾记了一个问题："其它共享组件是否也有『对某内核无意义却无条件渲染』的控件"。
系统排查后答案是**有**，而且现场比 r44 那处更值得记。

**排查方法**：先列出被**全部三个内核插件**共用的共享组件（`ModelConfigPage` /
`KernelVersionPage` / `KernelExtensionsPage` / `KernelConfigForm`），再逐个问
"它渲染的每个控件，底层字段是不是每个内核都有消费者"。结果：
`KernelVersionPage` 门控正确（`caps?.install` / `caps?.customDir`，false 时还有显式降级文案）；
`KernelConfigForm` 是数据驱动（字段来自内核自己的 schema，没有写死控件）；
**`KernelExtensionsPage` 完全不读能力面** ⇒ 缺陷在这里。

**最刺眼的一点：注释描述了一个不存在的行为。** `minimal-extension.ts` 的文件头写着
「不支持装/卸，能力缝 update/reorder 均 false。**壳据此置灰入口**，不伪造扩展列表」——
而共享页从来没读过 `capabilities`。minimal 的扩展页上是一个**完整可用的安装表单**：
用户填完来源、点安装、等一轮，才在事后看到「不支持安装拓展」。
注释说的降级、契约里声明的能力、UI 的实际行为，三者互相不一致。

> 通则：读到"壳据此降级"这类注释时，**去查壳到底读没读**。注释是意图，不是事实；
> 而这类注释因为写得很具体（点名了机制），反而最容易让人跳过验证。

**顺带查出的死契约面**：`KernelExtensionCapabilities` 原有的 `update` / `reorder` 两轴，
三个内核都老老实实声明了 `false`，但全仓**零消费者**（UI 与 controller 都不读）。
死轴不是"无害的冗余"，它**有害**：读到 `{update:false, reorder:false}` 的人会以为
UI 据此做了降级，实际什么也没发生（与 r25 查出的"声明了没人读的能力轴"同型）。已删除。

⚠ **而且我在同一轮里差点亲手造一条新的死轴**：一开始给契约加了 `install` **和** `uninstall`
两轴，随后发现页面里**根本没有卸载按钮**（`grep uninstall` 只命中我自己刚加的两行）⇒
`uninstall` 会立刻变成新的死面。已收回。

> 纪律：**能力轴与它的消费者必须同一批落地**。不加"为将来准备"的轴——
> 将来真要加时，轴和 UI 一起加，成本一样，而中间不存在"声明了但没人读"的窗口。

**降级的要点是"用户什么时候知道"，不是"有没有报错"。** 事后报错在功能上不算静默失败，
但它把成本转嫁给了用户（填表 → 等待 → 失败）。§7.6 的"显式降级"要的是**动手之前就知道**。
两个实现细节：
- **保留区块标题**，只把表单换成一句说明（整块静默消失会让人以为功能坏了或自己找错页面）；
- 说明要**讲清原因**（"这个内核没有提供扩展安装能力"），不是只说"不支持"。

**改动是一条完整的链，少一环 tsc 就红**（这正是把新轴设为**必填**的价值）：
圆心契约 → `channel-contract` 加 IPC 名 → controller 注册 handler → **`packages/react/src/index.ts`
里那份独立的 `window.kernel` 类型声明**（容易漏：它不是从 `build-kernel.ts` 推导的）→
`build-kernel.ts` 接线 → 共享页消费 → 三个内核各自声明。
必填让"漏声明"在编译期变成 TS2739（本轮三个内核同时报），而不是运行时静默当 false。

**验证层级选 e2e 而不是 jsdom 单测**：这条链跨了 IPC 与进程边界，jsdom 测不到
"controller 忘了注册"或"`window.kernel` 类型漏了方法"。剧本 `kernel-capability-gating.e2e.mjs`
（由 `model-capability-gating` 扩名而来，14 → **27 项**）三内核真机对照两个面：
pi/dsh 有安装表单且无降级说明、minimal 无表单且降级说明含原因；模型页那面沿用 r45 的
播种 + 反空转 + 跨内核对照。实测 minimal 扩展页文案量 66 字（只有降级说明），
pi 1248 / dsh 1073（完整表单 + 列表）。

### 17.49 普查判据漏了一种消费形态，就会**指认活代码为死代码**（r47）

把 r46 的发现推广成全仓普查：所有 `*Capabilities` 契约里还有没有别的"声明了却零消费者"的死轴。
结论是**没有**（15 个契约、44 个字段、死轴 0），但过程比结论更值得记——因为**首版判据指认了两条活轴为死轴**。

**陷阱：能力轴有两种消费语法，只认一种就会误杀。**

| 形态 | 谁在用 | 例子 |
|---|---|---|
| 点访问 `capabilities.<轴>` / `caps?.<轴>` | renderer、投影层 | `caps?.install === false` |
| **字符串字面量轴名** | application 层的"按轴取面"助手 | `viaFace("modelCycle", "模型轮转", f => …)`、`faceOf(proc, "toolExec", "命令直投")` |

首版只认点访问，于是把 `BackendCapabilities.modelCycle` 与 `.toolExec` 报成"0 消费者的死轴"。
手工核实后：`modelCycle` 撑着 `cycleModel()`（模型轮转，还有默认键位）、
`toolExec` 撑着 `bash()` / `abortBash()`（命令直投）。**信了自动结果就会删掉两条活轴、
打断两个功能**——而且删完 tsc 不会报错（字符串轴名不是类型引用），只会在运行时炸。

这正是 CLAUDE.md §1.5 描述的形态（「现为按轴取面的 `faceOf(proc, 轴, 标签)` /
`viaFace(轴, 标签, fn)`」）：**轴名是字符串参数**。所以判据必须是
「点访问 **或** 引号字面量」。而"声明"是冒号形态（`modelCycle: this`），
既不是点也不是引号，天然不计入消费——这条区分要写成**自检**（否则判据一旦放宽到把声明也算消费，
"死轴 0"就恒真、守卫失效）。

**第二个陷阱：成员语法也有两种，解析器漏一种就会低报规模。**
属性式 `fileBacked: boolean;` 与方法式 `steer(text: string): Promise<void>;`
（`SteeringCapabilities` / `RetryCapabilities` / `CompactionCapabilities` / `SnapshotCapabilities`
等整批都是方法式）。首版字段正则只认 `^(\w+)\??\s*:`，于是 15 个契约只解析到 7 个、
44 个字段只数到 26 个——**漏掉的恰恰是方法式那批，而它们同样可能变成死轴**（声明了却没人调）。

⚠ 连带一条：**守卫的反空转阈值必须按真实规模卡死，不能用"当前解析器数出来的值"倒推一个宽松下限。**
首版写的是 `>= 24`（因为坏解析器数到 26），那样即使解析器再次退化也照样绿。
改成 `toBe(15)` 与 `>= 44` 之后，解析器漏任何一种成员语法都会立刻红。

> 通则：**"死代码/死契约"这类判定的假阳性代价极高**（删掉的是活功能），
> 所以判据必须先穷举该概念在本仓的**全部表达形态**（这里是两种消费语法 + 两种成员语法），
> 并为每种形态写一条自检。宁可判据复杂一点，也不要让"看起来干净"的结果骗过自己。

**第三条是工具自身的**：本轮一个 Python 改文件脚本忘了 `write()` 回文件，
三个 `✓` 全打在内存里，tsc 与 vitest 自然照旧报错。我一度以为改动没生效去查语法，
实际是**根本没落盘**。教训：脚本自己打印的 ✓ 不算证据，**改完要重新读文件**（或直接看 tsc/测试的变化）。

产出：`src/capability-axis-consumers.test.ts` 加 3 条（普查 + 两条自检），5 → 9 测；
反向注入（往 `KernelExtensionCapabilities` 加一条无消费者的 `reorder`）让 ① 立刻变红，
并给出可执行的处置建议（"要么补上消费者，要么删掉这条轴"）。

### 17.50 架构承诺要**造出来**验，不是读代码验；成本在验证层（r48）

「加第四个内核 = 加一个目录（含 `plugin.ts`），壳零改动」这条承诺写在两个地方
（`electron.vite.config.ts` 的注释、`docs/design/kernel-plugin.md` §1），但**从未被实测过**。
本轮真的造了一个第四内核 `probe4`（`minimal` 的整体克隆 + 改名），结论分两半：

**壳机制层：承诺成立。** 以 probe4 的创建时刻为界用 mtime 核过——
`src/web`、`src/server/{application,bootstrap,controllers,kernel/core,transport,routing}`、
`packages/{shared,react}/src` **零文件改动**；圆心也零改动（`KernelId = string`，
身份早已去字面量化、`KERNEL_IDS` 已删）。构建自动产出 `out/main/server/kernel/probe4/plugin.js`
与三个 renderer chunk（两侧都是 glob，没有白名单）。本轮为接入它改的只有 **2 个验证侧文件**。

**验证层：承诺不成立，而这才是真正的成本。** 加 probe4 打红了 4 处，全是守卫在正确工作：

| 打红处 | 根因 | 修法 |
|---|---|---|
| `kernel-registry-n.test.ts` 3 处 + 卸载矩阵 | 写死 `["pi","dsh","minimal"]` 与三行矩阵 | 从文件系统**派生**（`TEST_KERNEL_IDS`/`ALL_KERNEL_IDS`）；矩阵改成 `ALL_KERNEL_IDS.map(gone => [gone, 其余])`，**内核越多用例越多**，比写死三行更强 |
| `locale-kernel-identity.test.ts` | 同样写死清单 | 派生自插件 manifest 目录 |
| `plugin-doc-coverage.test.ts` | 每个插件要有同名文档 | 补 `docs/plugins/kernels/probe4.md` |
| 文档交叉引用门 12 处断链 | **blanket 改名把文档路径也改了**（`minimal-kernel.md` → 不存在的 `probe4-kernel.md`） | 指回 minimal 的那份（克隆体的设计依据本来就是它） |

> **可复用的缺陷类**：*测试里写死"扩展点恰好有 N 个实例"*。它守的不是被测不变量
> （存在性 / 卸载语义 / 语言包一一对应），而是"实例个数"——那是扩展点的**反面**。
> 修法一律是**派生期望值**，而不是往清单里再加一个名字。

⚠ 其中一处比"打红"更危险：`locale-kernel-identity` 的**跨内核提及检测循环**也在遍历那份写死清单
（`for (const other of KERNEL_IDS)`）。这意味着**清单里没有的内核名，永远不会被当成"跨内核提及"**
——新内核被别的内核语言包提到时，守卫会**静默放过**。写死清单不只是"加东西时会红"，
它还会让守卫在别的方向上失效。查这类守卫时要问：**这份清单是"期望值"还是"检测范围"？**
是检测范围的，写死就等于给自己挖盲区。

**两条方法论：**

1. **参数化剧本 > 复制剧本。** 要证明的命题是"第四内核与 minimal **同等地位、同等功能**"。
   复制一份 probe4 剧本只能证明"probe4 也跑得通"；**同一个剧本、同一组 24 条判据、只换一个 id**
   才证明两者走同一条路径、享受同一套契约。实测 `--kernel minimal` 与 `--kernel probe4` 双双 24/24。
   参数化时踩到一个老坑的变体：页内闭包读不到 Node 侧变量，改成一次性
   `page.evaluate((k) => { window.__K = k; }, K)` 注入，比逐个 evaluate 传 arg 更省也更不易漏。
2. **被截断的工具输出会造出自信的错误判断。** 本轮我先断定"minimal 不 spawn 进程、是纯进程内的"，
   依据是一次 `grep spawn | head -5` ——而 `head` 把真正的 `import { spawn }` 截掉了。
   后来 clone 出的 probe4 在续跑那步失败，我才回头查到 `subprocess-lifecycle.ts` 确实 spawn 一个 CLI。
   > 通则：**用 `head`/`tail` 截断过的 grep 结果不能支撑"不存在"这类全称结论**；
   > 要下这种结论就用 `grep -c` 或不截断地看全。

另外本轮又一次自伤：probe4 冒烟第一次失败是剧本里漏改的 `"[minimal echo] 第三条续跑"`
（我的替换清单只列了两条 echo 文本，漏了第三条）——**先排除剧本自身的问题**（§17.9），
确认不是产品缺陷后再改剧本。

### 17.51 历史审计文档要**回写结论**；回写过程会挖出活缺陷（r49）

`docs/add-new-kernel.md` 是一份"抽象体检"，正文列了五处「不合理/需要补」。
它头部有诚实的历史声明（说清 `KERNEL_IDS` 已删、`KernelId` 不再是字面量联合），
但**五条断言的现状从未回写**——于是每个读者都要自己去代码里对一遍。
本轮逐条取证复核，结果是 4 条已修、1 条仍成立：

| § | 断言 | 现状 | 取证方式 |
|---|---|---|---|
| 4.1 | `capabilities` 只有 pi/dsh 两个硬桶 | ✅ 已修 | `backend.ts:156` 现为 `BackendCapabilities`（十一轴 + `fileBacked`）；r47 普查死轴 0 |
| 4.2 | `BackendCreateOptions` 三字段各服务一个内核 | ⚠️ **仍成立** | 逐字段 grep 消费点（见下） |
| 4.3 | 内核身份在圆心外被复制字面量 | ✅ 已修 | `asPi`/`piSend`/`KERNEL_IDS`/`newPiSessionPath` **只出现在说明其退役的注释里** |
| 4.4 | pi 特权残留在 application 层 | ✅ 已修 | 现为 `faceOf(proc, 轴, 标签)` / `viaFace(轴, …)` |
| 4.5 | manifest 的 `piExtension`/`dshExtension` | ✅ 已修 | 两个字段名只存在于解释性注释；实际是按内核 id 的映射 |

⚠ 复核这类"某符号是否已退役"的断言时，**grep 命中不等于仍在用**：4.3/4.4/4.5 的符号
都能 grep 到，但全在注释里（解释"为什么不再这么写"）。要区分**代码命中**与**注释命中**
（先剥注释再判，与 r31 的 `stripComments` 同一手法），否则会把已修好的断言误判成仍成立。

**§1.1 的判定被实验推翻，而推翻的理由值得写进文档。** 当时写「不要改成 `string`
（那会丢掉编译期穷尽检查）」。r48 造 probe4 的实测给出了答案：圆心与壳机制层零改动即可接入。
取舍的结论是：`string` + 运行时注册表换来"加内核不动圆心"，代价是失去穷尽检查——
而这个代价在本仓**可接受**，因为内核身份早就不该出现在 `switch` 里
（§6.3 检验⑤：机制层不许出现内核名字面量，已归零）；**既然没有穷尽分支，穷尽检查也就无从失去**。
§1.1 当初的前提（存在大量 `switch(kernel)`）已经不成立了。
> 通则：推翻一条旧建议时，要写清**它的哪个前提失效了**，而不是只写"现在不这样了"——
> 否则下一个人无从判断这条建议在别的场景是否仍然适用。

**回写过程挖出了一个活缺陷**（这才是本轮的主要产出）：
`systemPromptPaths` / `systemPromptTexts` 由 application 层**中性地**注入给每个内核
（`session-store.ts` 无内核分支），但**只有 pi 的 backend-factory 消费**；
dsh / minimal / probe4 对 `systemPrompt*` **零匹配**。而 `systemPromptPaths` 的来源是
`registry.systemPromptPaths()` = 壳插件贡献的 `systemPrompts` 槽，`goody-hao` 插件正在用它
——于是该插件在 pi 下真注入、在另外三个内核下**静默不注入**，而它的 manifest 描述
向用户承诺「随会话注入……卸载即停止注入」，还写死了 pi 的 CLI 旗标 `--append-system-prompt`。
这是 §1.5 唯一禁止的状态「**静默缺面**」（既不翻译、也不补面、也不降级）。

**处置分两层，且刻意不越界：**

1. **立即修掉"说谎的部分"**（有据、无争议）：manifest + 四语言描述改为
   「由壳在内核支持『追加系统 prompt』时注入」；圆心 `roleToPrompt` 的注释去掉 pi 的 CLI 旗标
   （圆心出现某内核专属机制 = §7.1 铁律一违规）。
2. **根因不顺手修**，因为它需要一个设计决定：正确修法是加一轴能力（如 `systemPrompt`）
   再在 renderer 明示降级，但**轴必须有生产消费者**，否则就是 r46/r47 刚清掉的"死轴"
   （`capability-axis-consumers` 的普查语料**排除测试文件**，只被测试读的轴同样算死轴）；
   而消费者该落在哪一层还没定——插件管理页是**全局页**，用"当前会话的内核"去判一份
   全局插件列表并不贴切；静态描述里列举内核名又违反内核中性。
   > **宁可延后并写清设计依据，也不要为了"这轮有产出"而加一条没有消费者的轴。**

**延后 ≠ 放着不管：加棘轮守卫**（`src/system-prompt-asymmetry.test.ts`，5 测）。
根因未修时，守卫的职责是**让不对称无法静默变化**：支持面变宽（某内核补上了翻译）→ 红，
并给出要同步更新的清单；变窄（连唯一支持者也没了）→ 红，因为那意味着整个 `systemPrompts`
槽失效而插件仍在承诺；新增第五个内核 → 必须显式登记进 `SUPPORTING`/`IGNORING` 之一，
不许默默漏。反向注入验过（让 dsh 也消费 → ① 立刻红）。

⚠ **判据只扫各内核的 backend-factory（消费点），不扫 application 层（生产点）**：
生产点对所有内核一视同仁，扫它只会得到"人人都有"的**假对称**，恰好掩盖缺陷。
这条"扫消费侧不扫生产侧"的选择，是本守卫唯一容易写反的地方。

### 17.52 把上一轮**刻意延后**的设计决定做完（r50）

r49 查出 `systemPrompt*` 的契约不对称（application 层中性注入、只有一个内核消费、
其余静默忽略），当轮只修了"说谎的文案"并加了棘轮守卫，**根因刻意没修**——因为正确修法
需要一条能力轴，而轴必须有**生产消费者**，否则就是 r46/r47 刚清掉的死轴；消费者落在哪一层
当时还没想清。本轮把它做完，过程里四条经验：

**① 走既有通路，别自己新开一条。** 我先写了 `ctx.sessions.getCapabilities()`——tsc 立刻报
`Property 'getCapabilities' does not exist on type 'SessionsApi'`。那是 `window.kernel.sessions`
的形状；**插件侧的既定入口是 store**（timeline 就是 `useSessionStore(s => s.capabilities)`）。
> 通则：要在插件里取某个运行时事实时，先看**同类插件怎么取的**。自己新开一条 API 通路
> 即使能编译过，也会造出第二份获取路径（§1.3 契约单源的反面）。

**② 三态，不是布尔。** 提示条件是 `caps.kernel != null ? caps.faces?.systemPrompt !== true : null`：
`null` = 还不知道（没有会话 / 能力面尚未就绪）⇒ **不显示**。
把"没取到"当成"不支持"会**误伤真正支持的内核**——用户会在 pi 下看到"此插件不生效"的假警告。
这类"信息不足"的分支必须显式建模，不能靠 falsy 兜底。

**③ 守卫的判据又一次漏了表达形态。** `rendererConsumers` 只认 `faces.x` 与 `faces["x"]`，
不认**可选链** `faces?.x`，于是我按 ③ 写的合法消费者被判成"空头声明"。与 r47 的
`viaFace("轴")` 完全同一类错误。修法是补形态 + **三形态自检**（点 / 下标 / 可选链，
且钉在真实轴名上——用合成轴名测不出正则里 `${axis}` 插值那段写没写对）。

**④ 自检的反向用例会替你收紧判据。** 我给三形态自检写了反向用例，其中 `myfaces?.retry`
当场暴露正则**缺左边界**（同后缀标识符会被误判成消费点）。此时正确动作是**收紧判据**
（加 `(?<![\w$])`）而不是删掉那条用例——判据过宽 ⇒ "有消费者"更容易恒真 ⇒ 守卫变松。
> 只有正向用例的自检，抓不到"判据过宽"这半边。两边都要写。

**归类为 renderer 门控而不是服务端强制，理由要写进清单**：注入发生在 **spawn 期**、
且**没有任何用户可见的反馈**，所以"服务端不产数据"在这里等于**什么都不发生**
——那正是本轴要消灭的静默缺面本身。必须由 renderer 主动说出来。
（`capability-axis-consumers` 的守卫要求每条声明写清"缺面时用户看到什么"，
这条恰好是"用户什么也看不到"，所以只能走 renderer。）

**验证放哪儿：不要调一次性探针，把断言放进前置条件已具备的常驻剧本。**
我先写了个独立探针去驱动模型下拉选 minimal，反复失败（`evaluate(() => el.click())`
对 Radix 菜单无效——合成 click 不带指针序列）；而 `minimal-smoke` **已经**能稳定建起
minimal 会话。把断言加进去后一次通过，而且从此常驻（28 项，minimal 与 probe4 双双通过）。
实测输出：`提示条数=1 文案="当前内核不承接追加系统 prompt，此插件贡献的 systemPrompts 暂不生效"`，
且反空转断言先确认了 `GoodyHao 在场=true`（否则"有提示"可能只是页面恰好别的插件触发）。

顺带：`e2e-anchor-coverage` 守卫抓到我在选择器里**凭空发明**的 `data-plugin-id`
（源码里不存在）——它把 e2e 用到的每个 `data-*` 与源码对账，这条防线本轮真的拦下一次。

### 17.53 疑似缺陷要先验**交互模型**；回归锚要按缺陷的真实形态写（r51）

**① 挂了五轮的"疑似 a11y 缺陷"其实是对的。** 待办里长期记着"右面板堆叠 TAB 的当前项
（缺 `aria-selected`/`aria-current`）"。真去读代码才发现那个按钮有
`title` + `aria-label` + **`aria-pressed={isActive}`** ——它用的是 **toggle button** 语义，
不是 tab。而且这**更正确**：那些图标是开关（`toggleSidePanelTab`），堆叠布局下可以
**同时多个激活**，实测点开第二个后 `["收藏","Review"]` 两个同时 `pressed=true`；
而 `role=tab` + `aria-selected` 隐含**单选**（tablist 语义），套上去反而是错的。

> 通则：判"某个控件缺 ARIA"之前，先确定它的**交互模型**——单选（tab/radio）、
> 多选开关（`aria-pressed`）、还是展开 disclosure（`aria-expanded`）。
> 三者用的属性互不通用，套错比不套更糟（会给读屏用户错误的心智模型）。
> 而"能不能同时激活多个"这种事实**要点一下才知道**，读代码只能猜。

**② 回归锚必须按缺陷的真实形态写，否则会钉出一条恒绿的假锚。**
r51 修掉了 `tool-cards.tsx` 里给用户看的硬编码英文 `truncated`。我顺手把它加进
r42 那条英文守卫的回归锚清单——而那份清单的探针查的是**带引号的字面量**
（`src.includes('"' + needle + '"')`）。可原缺陷是 **JSX 文本节点**（`>truncated<`，不带引号），
所以那条锚**回潮了也照样绿**。是自己复核探针形态时发现的。修法：单立一条判据用
`/>\s*truncated\s*</` 匹配真实形态，并配**双向自检**（认得出缺陷形态、且不会把已修好的
`{t("timeline.outputTruncated")}` 误判成缺陷）。

> 通则：写完回归锚，**问一句"如果缺陷原样回来，这条会红吗"**。
> 锚的判据形态与缺陷的实际形态不一致，是假守卫最常见的成因之一
> （另一常见成因是 r45 那次：反空转探针的取样面漏了 `input.value`）。

**③ 单词级英文字面量是 r42 判据的已知盲区，只能靠人工看 DOM。**
`truncated` 能存在这么久，是因为 r42 的英文判据**刻意**要求"2 个以上英文单词"
（否则专名、CSS 值、类名会产出大片假阳性）。所以 `>truncated<`、`>error<`、`>running<`
这类**一个词的界面提示**扫不出来。本轮是逐个组件看 JSX 文本节点才发现的。
> 收紧判据换取低假阳性，代价就是留出盲区——**盲区要写进守卫的注释里**（r42 已写），
> 这样下一轮知道该用人工审而不是再调判据。

### 17.54 重复实现会**各自漂移**；共享文案要住在始终装载的插件里（r52）

**① 修一处漏一处，而漏掉的那处不会报错。** r41 给 message-blocks 的 `CardHeader`
补齐了 `aria-expanded`、把硬编码英文 `running`/`error` 收进 i18n、把纯图标的成功/失败
改成 sr-only 文本。r52 扫到 goal 插件的 `GoalCard` ——它与 `CardHeader` 是
**两份近乎相同的可折叠头实现**（图标 + 摘要 + 状态 + chevron + 可折叠正文），
而**三个缺陷一个不少地都还在**：`running` 硬编码英文、`<Check/>`/`<X/>` 纯图标无可访问名、
没有 `aria-expanded`（`role`/`tabIndex`/`onKeyDown` 倒是有——三件套缺了第三件）。

> 这是 §3.5「重复实现」的代价被具体化的样子：不是"多写一遍"这么抽象，
> 而是**修一处漏一处，且漏掉的那处不会报错、不会红、不会被任何人提起**。
> 所以每次修一个组件级缺陷，要顺手问一句：**还有谁长得像它？**
> 本轮的查法是全仓扫 JSX 文本节点（见 ③），而不是靠记忆。
>
> 收敛成一份是更好的修法，但那是带视觉风险的跨插件重构（两者的图标与状态语义并不完全相同），
> 本轮选择先补齐语义 + 立守卫 + 把"两份实现"记入待办——**不为了消除重复而顺手改视觉**。

**② 共享文案要住在"始终装载"的插件里。** r41 我把三个状态词加在了 message-blocks 的
`timeline.json`。当 goal 插件也要用同一组词时，就出现了选择：跨插件引用另一个**业务**插件的
语言包 —— 那是**脆的**（用户禁用 message-blocks，goal 卡的状态词就丢，`t()` 回落到裸 key）。
正确做法是挪到 `shell.*`（由 `system/i18n` 插件贡献，属核心、始终装载），
并**删掉原来那一份**（§1.3 契约单源：两份定义必然漂移）。

⚠ 挪键之后有个隐蔽的假绿：**测试字典若只读自己插件的 locale，`DICT[k] ?? k` 会回落到 key**，
于是断言变成"key === key"——**界面显示裸 key 时测试照样绿**。修法是让测试字典
**像真实 i18n 那样合并多个来源**，并单立一条断言"这个键必须真在合并后的字典里、且不等于 key 本身"。

**③ 单词级英文界面提示的扫法（r42 判据的已知盲区）。** r42 的英文判据刻意要求
"2 个以上英文单词"（否则专名/CSS 值/类名会产出大片假阳性），所以 `>running<`、`>truncated<`
这类**一个词的提示**扫不出来。本轮的扫法与收敛过程值得复用：

- 判据：JSX 文本节点（`>([^<>{}]{1,60})<`）里出现**单个纯英文单词**；
- 首扫 27 处，其中 **24 处是 TypeScript 泛型假阳性**（`Promise<void>` 的尖括号被当成 JSX）——
  加一条**行级**跳过（行里出现 `=>`/`:`/`type`/`interface` 且带 `标识符<` 的，整行不算）后收敛到 **3 处**；
- 3 处里 2 处**合法**：`model`（payload 视图里的 schema 字段名，按 r44 记录的策略照原样显示）、
  `core`（在 `<code>` 里，是代码样例）；1 处是真缺陷（`GoalCard` 的 `running`）。

> 通则：这类"判据刻意留盲区"的扫描，**产出要连假阳性的收敛过程一起记**——
> 下一个人重扫时会得到同样的 27 处，若不知道那 24 处是泛型，就会以为守卫失效或重新调判据。

本轮顺带发现 `GoalCard` **根本没有测试文件**（goal 插件有 90 条测试，无一条覆盖它），
已补 `goal-card.test.tsx`（3 条：折叠三件套齐全且 `aria-expanded` 随 Enter/Space 翻转、
运行中显示译文而非硬编码英文、成功/失败由 sr-only 文本承担且图标 `aria-hidden`）。

### 17.55 守卫的**机制性**盲区：判据在检测前就把证据抹掉了（r53）

r52 修 `GoalCard` 时发现它有硬编码中文 `"目标达成"`。奇怪的是：中文守卫（r21 建，
三个探测器）本该抓到它。读判据才看清机制：

| 探测器 | 覆盖 | 为什么漏 |
|---|---|---|
| `ATTR` | `title`/`aria-label`/`aria-description`/`placeholder`/`alt` 五个属性（含三元形态） | 只认这五个属性名 |
| `JSX_TEXT` | `>…中文…<` 裸文本节点 | `"目标达成"` 在 JS 三元里，不是文本节点 |
| `bare` | 走 `jsxTextOf(line)` | ⚠ **那个函数会先把所有 `{…}` 块与所有字符串字面量剥掉再判** |

第三条是关键：`jsxTextOf` 是**为了"只看裸文本"而设计**的，它 `.replace(/\{[^{}]*\}/g, "{}")`
再把引号内容清空——于是中文在判定之前就被抹掉了。这不是"判据写得松"，
而是**判据的预处理步骤主动销毁了要检测的证据**。这类盲区靠读判据的**实现**才看得见，
光看它声称覆盖什么（"用户可见位置不得硬编码中文"）完全看不出来。

漏网的形态（实测 **37 处**真债务）都是用户可见的：
`flash("已导出表情包 zip")`（toast）、`activateDisabledReason={streaming ? "等待当前回复完成" : …}`
（传给组件去显示的 prop）、`{copied ? "已复制" : "复制"}`（在 JSX 里但**在花括号内**，
所以 `JSX_TEXT` 也匹配不到）、`notify.show({ body: \`续跑发送失败…\` })`（系统通知正文）、
`label: "打开设置"`（键位绑定的显示名）。

**⚠ 先收敛判据，再钉棘轮上限。** 首版粗判据数出 56 处，其中混着假阳性；
若直接把上限钉在 56，将来"债务减少"就分不清是真修了还是判据漂了。收敛过程：

- 56 → **40**：① `login-gate.ts` 文件级豁免（React/i18n 之前的登录闸，与 r42 的显示汇点守卫
  共用同一份理由）；② **上下文回看 3 行**——`throw new Error(\n "消息"\n)` 是跨行写的，
  只看当前行会把开发者可见的错误消息误算成用户文案债务（实测 `plugins-host.ts:9-11`）。
- 40 → **37**：③ 用 `new Error\(` 而不是 `throw new Error\(`（错误对象也常被**构造后交给别处**，
  如 `reject(new Error("保存超时…"))`）；④ 加 `warnOnce\(`（r42 已定性为**开发者可见**的
  不变量违规，只进 console，翻译它反而有害）。

判据每收紧一次，**自检的反向用例要跟着补**（否则收紧本身没人守）：
`reject(new Error("…"))` 与 `warnOnce("…")` 两种形态都已钉进"不该算债务"那一侧。

**债务棘轮要配一条具体锚点。** 只有"总数 ≤ 37"的话，回潮时你不知道是哪一处；
所以另加一条 `② r53 修掉的那处不得回潮（goal-card 的「目标达成」）`。
反向注入（把它改回硬编码中文）时**两条同时红**：棘轮报 `38 > 37`，锚点报具体文件与修法。
这正是想要的分工——棘轮管"总量不许涨"，锚点管"已修的不许退回"。

> 与 r31–r33 清架构债（4 → 3 → 2 → 1 → 0）同一手法：**上限只能降不能升**，
> 每修一处就调低一格，上限本身就成了进度条。

⚠ 工具纪律（本轮第 **4** 次踩）：Python 改文件的脚本里 `sub()` 打印了 ✓ 但**忘了 `write()`**，
两处改动全丢在内存里，而 tsc/测试照旧报错让我以为判据没生效。
> 脚本自己打印的 ✓ 不算证据。改完必须**重新读文件**或直接看 tsc/测试的变化。

本轮未做（已记入待办）：37 处债务的实际清理（每处要补 4 个语言的键），
以及 r52 记下的 `GoalCard` 与 `CardHeader` 收敛——后者本轮原计划做，
但扫出守卫盲区后优先级改了：**守卫的盲区会让后续所有同类修复漏掉一半**，先补判据更值。

### 17.56 清债务时的四个坑：取清单、判据精度、既有键、测试替身（r54）

按 r53 的棘轮开始清 37 处中文债务（实清 8 处，上限 37 → **29**）。过程里四个坑都值得记：

**① 别在一次性脚本里重新实现守卫的逻辑——去问守卫本身。**
我先写了个 Python 复扫想拿到清单，得到 **239** 处，而守卫说 37。差 6 倍的原因是
我的脚本**没有剥 `//` 行注释**（守卫用 `stripComments`），于是注释里被引号夹住的中文
全被当成了字面量。做法改成：临时给守卫加一个 `it("DUMP", …)` 把命中逐条打印，
跑一次拿到权威清单，然后还原守卫。
> 通则：**清单要从判据本身取**。自己重写一遍判据必然发散（剥注释、上下文回看、
> 豁免清单……每一处细节都会漂），而发散的结果会让你要么白修一堆假阳性、
> 要么以为债务比实际多得多。

**② 判据用 `exec` 只取每行第一个匹配 ⇒ 债务数低报，而低报的棘轮更危险。**
`flash(path ? "已导出表情包 zip" : "已取消")` 一行有两个中文字面量，首版只算 1 处。
改成 `matchAll` 后基线从 37 变 36（同时我修掉了 5 处，所以净变化看不出来——
这正是低报的害处：**修掉一处后总数可能不变**，看起来"没进度"；
反过来新增一处也可能被同行的既有命中掩盖）。
> 棘轮类判据要先确认**计数单位**与直觉一致（"处"是字面量数还是行数？），
> 否则进度条本身就是错的。

**③ 先查有没有现成的键，再决定要不要新造。**
stickers 那批 6 处里，**5 处的译文四个语言早就齐了**：`stickers.openFolderFirst`（先打开文件夹）、
`waitForReply`（等待当前回复完成）、`moveToGlobal`（设为全局）、`moveToProject`（移到项目）、
`cancel`（取消）——代码却写死中文。这是 r28/r30 那个「**死键 + 硬编码副本**」模式的又一实例，
而且修法几乎零成本（改用既有键即可），只有 3 个键需要新造。
> 通则：清 i18n 债务时，**第一步是在该插件的 locale 文件里搜现成键**（按值搜，不是按键名搜）。
> 直接新造键会造出第二份译文，两份必然漂移（§1.3）。

**④ 文案一走 i18n，测试替身的形状问题就暴露了。**
`goal-controller.test.tsx` 原本**没有** mock `react-i18next`，于是 `t(k)` 返回 `k` 本身。
在文案全是硬编码中文时这件事看不出来；把通知正文改走 `t()` 之后，
断言"正文含 `/goal`"拿到的是 `goal.usage`，立刻红。
修法是给测试**真字典**（读插件自己的 `locales/zh-CN/goal.json`），
**不是**把断言软化成"含 goal.usage"。
> 这与 r37 那次（给发布面加导出后 mock 里没有 `Announce`）同型：
> **测试替身与真实形状的差别，只在被测代码开始真正依赖它时才暴露。**

另外两条实现细节：
- **模块级常量拿不到 hook**：`GOAL_USAGE` 是 `export const`，改法是删掉它、
  在使用点 `t("goal.usage")`（本文件只有两处用，都在 hook 内部）。
- **跨插件键依赖又差点犯一次**：给 timeline 的 `pending-bars` 加兜底名时我先用了
  `stickers.stickerFallback`——那是依赖另一个**业务**插件的语言包（用户禁用 stickers 就丢文案）。
  已按 r52 定的原则搬到 `shell.*`（始终装载），并把理由写进注释。

**本轮未做（记入待办）**：剩下 29 处里最大的一块是 `ChannelMeta` 的 `label`/`description`
（timeline 12 + goal 3 + key-hints 2 + app-main 4 ≈ 21 处，全是命令/键位绑定的显示名与说明）。
正确修法是照本仓既有的 **`labelKey` 形态**（`ThemeContribution` / `FontPresetContribution` /
enum options 都这么做）把契约从 `label` 改成 `labelKey`，由消费方 `t()` 解析——
但那是**契约变更 + 38 个条目 × 4 语言**的量级，一轮做完风险太高，所以留作专轮。

### 17.57 债务的批准书往往写在**契约注释**里（r55）

r54 结束时剩 29 处中文债务，其中 **20 处**是同一个来源：`ChannelMeta` 的 `label`/`description`
（8 个通道 × 2 + 壳的 2 个导航通道 × 2，显示在键位绑定页）。读契约才发现根因不在调用点：

```ts
/** 人类可读的短名(列表展示)。文案归插件自持有,直接写文本或走 i18n 均可。 */
label?: string;
```

**那句"均可"就是债务的批准书。** 8 个通道无一例外都选了"直接写文本"——不是因为疏忽，
而是因为契约明确允许。所以只改调用点是打地鼠：下一个新通道照样会写中文，而且它合规。

修法是改契约：`label` → `labelKey`、`description` → `descriptionKey`（与本仓既有的
`ThemeContribution.labelKey` / `FontPresetContribution.labelKey` 同形态），
注释里写清"文案字段是 **i18n 键**，不是文本"，并记下那句"均可"造成过什么。
改名的两个直接收益：

1. **"直接写文本"在字段名上就说不通**（消费方一律 `t(key)`），新人不会误用；
2. **改完 tsc 立刻在 5 个文件报 12 个错**——消费方一个都漏不掉。
   若只是加一个可选的 `labelKey` 而保留 `label`，就会长期两套并存（§1.3 两份定义必漂移）。

**改成键之后出现一个新的失败模式，必须配守卫**：键写错或某语言漏译 ⇒ 界面显示裸键
（`timeline.channel.scrollTo.label`），而 **tsc 不会报错**（键是字符串）。
所以补 `src/channel-meta-i18n.test.ts`（4 测）：① 每个声明的键在**四个语言**里都存在；
② 译文非空且不等于键名本身（挡"占位式假翻译"）；③ 语言包里的通道键不能是**死键**
（声明侧删了而译文还在 = 漂移）。反向注入已验（删掉 de 的一条 → ①③ 同时红，
报错精确到"缺哪个键、哪个语言、声明在哪个文件哪一行"）。

**三个容易漏的语义细节**（都不是编译错，只能靠想清楚）：

- **回退要用 channel 名，不能用键名**：缺译文时 `chanLabel()` 回退到 `c.channel`
  （如 `timeline:scrollTo`）——键名对用户毫无意义，而 channel 名至少是他能在别处认出来的标识。
  契约原有语义是"增强而非门槛"（不声明文案就回退显示 channel 名），改键之后要保住这条。
- **搜索要匹配解析后的译文，不是键**：键位绑定页有过滤框，原先按 `meta.label` 文本匹配；
  改键之后若直接拿 `labelKey` 去匹配，用户搜"聚焦"就什么都搜不到（他看到的是译文）。
- **`payloadExample` 与 `scope` 不动**：它们是数据不是文案（payload 形状在各语言里必须
  逐字一致，翻译它就坏了）。写译文时 description 里的 `payload: { position: "top" | "bottom" }`
  也保持代码原样，只译说明部分。

**验证要能区分"翻译对了"与"页面是空的"**：en 语言下实测
`中文字符=0、裸键=0`，但这两个数字**单独看没有意义**（空页面同样满足）。
所以另加**点名查**：6 条已知英文译文（Focus composer / Cycle model / Scroll timeline /
Open settings / Back to chat / Toggle key-hint mode）必须真的出现在页面上，
且页面上能数出 10 个 channel 名。zh-CN 侧对照：`中文字符=165、裸键=0`。

**债务上限 29 → 9**，并把剩下 9 处的**性质**写进守卫注释（它们不是同类，不能顺手清）：
4× `session-store.ts` + 1× `continue/renderer` 是**送进模型的正文**（工具限制前缀、续跑提示），
本地化会改变**模型行为**而不只是显示 ⇒ 需先定设计；2× `ws-transport.ts` 是壳侧传输错误，
可用 `i18next` 单例（同 r42 的 build-kernel）；其余 2 处待逐个核。

> 通则：清一批债务之后，**剩下的要按性质重新分组**，不要继续用同一个上限数字笼统管着。
> "送进模型的文本"和"给用户看的文案"是两类东西，混在一个棘轮里会导致
> 要么为了降数字去改模型行为，要么因为不敢改而让整个棘轮停摆。

### 17.58 债务归零：最后 9 处要**按性质分别处置**，一种办法处理必错（r56）

r55 结束时剩 9 处，我在守卫注释里写了"性质不同、不能顺手清"。本轮把它做完，
结论是这 9 处分成**三类**，每类的正确动作都不一样：

**① 修掉 4 处**（真该本地化）：
- `ws-transport` 的 2 条传输错误：经 `failAll` → reject 原因 → **浮到 UI**，
  用 `i18next` 单例（非组件的壳代码，同 r42 的 `build-kernel`）；
- `continue` 的续跑文案：它是经 `messaging.prompt()` **发出去的用户消息**，
  会原样出现在时间线的用户气泡里 ⇒ 属"用户说的话"，英文界面里冒出一句中文是错的；
- `goal` 的斜杠命令说明：契约字段 `ComposerCommand.description` → **`descriptionKey`**
  （与 r55 的 `ChannelMeta.labelKey` 同批同理）。

**② 豁免 4 处**（本地化会造成**真实回归**）：`session-store` 的工具白名单注入。
判据不是"我觉得不该译"，而是源码注释里已有的定性 + 一条更硬的技术理由：

```ts
// 注入文本是发往内核的协议指令(渲染层经 stripToolLimitNote 剥除,用户气泡不可见),
// 非 UI 文案——演进:内核提供工具白名单 RPC 后整体移除(勿 i18n,勿当界面文案改)。
const TOOL_LIMIT_PREFIX = "[System] 本次会话已限制可用工具。";
export function stripToolLimitNote(text: string): string {
  if (!text.startsWith(TOOL_LIMIT_PREFIX)) return text;   // ← 字面比对
```

⚠ **`startsWith` 那行是关键**：前缀一旦被本地化，**此前已发送并落盘的消息**（带旧语言前缀）
就不再被剥除 ⇒ 老会话的用户气泡里会突然露出协议原文。所以本地化它不是"改文案"，是**制造回归**。

> 可复用的判据：**这段文本会不会作为「用户可见的消息内容」出现？**
> 会（`CONTINUE_PROMPT`）→ 本地化，那是用户说的话；
> 不会（协议注入 + 渲染层剥除）→ 豁免，且理由要写进代码注释**和**守卫的豁免清单。
> 这个判据比"是不是中文"有用得多——它同时解释了为什么同一批债务要分成两类处置。

**③ 豁免 1 处**（本地化会**降低**可用性）：`stt-engine` 的 `label: "中文"`。
那是转写语言选择器，与它并列的是 `"English"` / `"Deutsch"` ——**endonym 惯例**：
各语言用自己的文字书写自身，让用户无论界面是什么语言都能找到自己的语言。
把"中文"在中文界面译成"Chinese"、在德语界面译成"Chinesisch"，用户反而要再做一次翻译。

**处置完之后上限归零，判据的性质就变了**：从"棘轮"（只许减少）变成**硬门禁**
（任何新增的 JS 表达式硬编码中文当场红）。要新增合法形态时走 `CJK_EXPR_EXEMPT`
（逐条写理由 + 腐烂检查盯着），**不要调高上限**——调高就是把新债合法化。

**一个契约设计细节：来源不同就要两个字段，不能合成一个。**
`CommandItem` 是内核 `RpcSlashCommand` 的中性投影，`source` 可以是
`extension`/`prompt`/`skill`（文案来自**内核**，已经是文本，壳无权也不该替内核翻译）
或 `plugin`（文案来自**壳插件**，必须是键）。若把两者合成一个 `description` 字段，
就会逼其中一方撒谎：要么插件写死文本（债务），要么把内核文本当键去 `t()`
（查不到 ⇒ 界面显示一整句英文/中文当键名）。所以 `description`（文本）与
`descriptionKey`（键）**并存**，渲染时优先解析键。

**验证要覆盖两条不同的显示路径**（它们由不同代码渲染，一条通不代表另一条通）：
键位绑定页（`ChannelMeta`，r55）与斜杠弹窗（`ComposerCommand`，r56）。实测 en 下
两者都 `中文字符=0、裸键=0`，且点名查到 `/goal` 的英文说明；zh-CN 下照常显示中文。

⚠ 实现细节（踩了一次）：豁免清单里存的是**源码字面文本**，所以 `\n` 要写成
TS 里的 `"\\n"`（两个字符：反斜杠 + n）。首版写成 `"\n"`（被 TS 解析成真换行），
于是过滤与腐烂检查都匹配不上——报错信息是"豁免已失效"，看起来像源码变了，其实是转义反了。

### 17.59 收敛重复实现时，全仓签名扫描会挖出**你不知道的第三份**（r57）

r52 记下"`GoalCard` 与 `CardHeader` 是两份近乎相同的可折叠头，应收敛"。r57 做这件事时，
先抽共享组件、再写**防再分叉守卫**（扫全仓找内联特征签名）——守卫第一次跑就查出
**第三份逐字副本**：`ask-question-card.tsx`，而且它带着**同样的漂移**
（没有 `aria-expanded`、成功/失败是纯 `<X/>`/`<Check/>` 无可访问名）。

> 这印证了 r52 那条通则（"修一个组件级缺陷要问：还有谁长得像它？"），
> 但把答案的来源从**记忆**换成了**签名扫描**。记忆里只有两份，仓库里其实有三份。

**抽取边界：只抽"壳"，内容一律走插槽。** 两份（后来是三份）实现逐字相同的部分是
容器样式（`borderLeft: 3px solid` + `color-mix(…surface 30%…)` + `padding: 5px 12px` +
`flex items-center gap-2 …font-mono…rounded-md`）、交互语义（role/tabIndex/Enter·Space/
`aria-expanded`）、以及「图标 → 摘要 → 状态 → 尾随 → chevron」的四段布局。
差异全在**内容**上，所以组件只负责壳，内容经 `icon` / `summary` / `status` / `trailing` 传入。

⚠ **刻意不加业务旗标**（`isToolCard` / `variant: "tool" | "goal" | "ask"`）——
那会把三个调用方的差异重新焊回共享层，等于把"三份重复"换成"一个更难读的分叉组件"。
唯一的布尔是 `livePulse`（流式呼吸条），它是**视觉机制**不是业务分支。

**特征签名要够具体，否则误报。** 首版签名只写 `borderLeft: \`3px solid`，
结果把 `goal-bar.tsx` 也报了出来——那是个状态条，同样用了这条样式，但**不是**可折叠头。
收紧成"两个特征同时命中"（左边条 + 那句 `color-mix(in srgb, var(--color-surface) 30%` 背景）后
只匹配这一族容器。
> 与 r45 那次同型：判据太宽会产出假阳性，而假阳性多了守卫就会被人绕过。

**测试替身要展开真实模块，不要手抄导出清单。** 收敛后 `ask-question-card.test.tsx` 的 3 条测试报
`No "CollapsibleCardHeader" export is defined on the "@my-harness-desktop/react" mock`
——与 r37 给发布面加 `Announce` 后 retry/continue 的 mock 报错**同型**。
可持续的修法是 `vi.mock(…, async (importOriginal) => ({ ...await importOriginal(), usePluginContext: … }))`：
先展开真实模块、再覆盖要打桩的成员。这样**发布面以后再加导出，所有 mock 都不会破**。
（手抄清单的做法注定每加一个导出就要改 N 个测试文件。）

**两处如实记录的取舍：**
1. **小的视觉归一化**：`GoalCard` 与 ask 卡此前没有 `transition-colors`，运行态文案也没有
   shimmer；收敛后三者一致。这与 r41 收敛 `DefaultCard` 时的左边条颜色归一同类——
   是"三份实现该长一样"的修正，不是顺手改设计，已在注释里写明。
2. **状态锚点统一**：`data-tool-status` / `data-goal-tool-status` → **`data-exec-status`**
   （同一个概念一个名字）。改前确认过没有 e2e 依赖，只有两个单测引用，一并更新。

⚠ 实现教训：我用"找起点/终点索引再切片"的方式替换 `CardHeader` 函数体，
结果把夹在它与 `BashCard` 之间的 `interface BashArgs` / `interface BashResult` 一起删了
（tsc 报 `Cannot find name 'BashArgs'` 才发现）。
> **索引切片替换要确认边界之间没有别的声明**；用 `git diff` 复核删掉的行是最快的兜底。

产出：`packages/react/src/widgets/collapsible-card-header.tsx`（`CollapsibleCardHeader` +
`ExecutionStatus`）+ 9 条测试（折叠三件套全给/全撤、插槽顺序、三态译文与 sr-only、
防再分叉三条）。反向注入已验（把 ask 卡换回内联容器 → ② 立刻红并点名文件）。
全量 240 文件 / 2118 测试、5 项审计 0、e2e 全绿。

### 17.60 「扫描返回 0」是危险信号，不是合格证（r59）

r37 建立了瞬时提示的 live region 机制（常驻宿主 + `<Announce>` 原语），当时接了 5 处，
但**没有做全仓普查**。r59 补普查，扫出还有 **3 处**漏网：
`plugin-manager` 的 `feedback`（安装/启用/卸载结果）、`session-bookmarks/message-actions`
的 `toast`（错误提示）、`stickers` 的 `transfer.msg`（导入导出结果，含失败原因）。
共同后果：用户点了按钮、界面闪一下就没了，而读屏**一个字都没念**——
从 AT 侧看这次操作"没有任何反应"。

**但本轮真正的教训是普查判据自己坏了两次，而两次都表现为"扫出 0 个文件"：**

| # | 坏在哪 | 症状 |
|---|---|---|
| ① | `setTimeout\([^)]*?set(\w+)\(null\)` —— `[^)]*` **跨不过箭头函数里的 `)`** | `setTimeout(() => setMsg(null), 3000)` 匹配不上 |
| ② | 从 `setMsg` 提取出的名字是 `Msg`，而状态变量是 `msg`（**首字母大小写没换算**） | "是否被渲染成文本"那一步永远为假 |

两次都返回 0，而 0 看起来像"仓库很干净"。**如果没有自检，我会带着一个坏判据宣布普查通过。**

> 通则（本仓已踩三次的同一类）：**扫描类判据必须在已知正例上自检**。
> r45 是"反空转探针自己给假结果"（`innerText` 不含 `input.value`）、
> r47 是"判据漏一种消费形态就指认活代码为死代码"、本轮是"判据坏了返回 0"。
> 三次的共同解法：把**已知正例清单**写进守卫，命中数不足就直接红。
> 判据的"零违规"只有在"自检通过"的前提下才有意义。

**判据的边界要如实写出来，不能假装全覆盖。** 单文件正则能覆盖
"`setTimeout` 自动清空 + 同文件里渲染成文本"；覆盖不到的是**状态由自定义 hook 产出、
经 `obj.prop` 在另一个组件渲染**（stickers 正是这样：`useStickerTransfer` 返回 `msg`，
组件里写 `transfer.msg`）。这类走 `CROSS_FILE_LEDGER` 显式登记 + 腐烂检查兜住，
并在守卫注释里写明"不假装能自动发现"。

**修法本身沿用 r37 定的形态**：`<Announce message={…} variant={…}/>` 与原有视觉元素**并存**
（只补"被读到"，不改位置与样式）；错误态用 `variant="error"`（⇒ `role=alert`，可打断）。
其中 stickers 需要**先给状态加严重级**才能正确区分——原本 `flash(m: string)` 只有文本，
无法判断该用 polite 还是 alert，于是把状态从 `string | null` 扩成
`{ text: string; kind: "info" | "error" } | null`，`flash(m, kind = "info")`，
两处失败调用（导出失败/导入失败）显式传 `"error"`。
> 这是个可复用的判断：**播报强度是语义的一部分**，不是渲染细节。
> 若瞬态状态里没有严重级，就先补上，别一律用 polite（错误被"礼貌地排队播报"等于听不到）。

产出：`src/transient-message-live-region.test.ts`（5 测：已知正例自检 + ① 未接站点归零 +
② 账本理由 + ③ 账本腐烂 + ④ 三处回归锚）。反向注入已验（移除 message-actions 的
`<Announce>` → ①④ 同时红）。全量 241 文件 / 2123 测试、5 项审计 0、e2e 全绿。

### 17.61 把"推断过的结论"升级为"取证过的结论"，顺手会挖出别的缺陷（r61）

r37 当时判断"timeline 自己的 toast 与共享 `Toast` 部件不该收敛，因为位置语义不同"，
并把它记成待办。这条判断在待办里挂了 20 多轮——因为它是**推断**，没人去比对过两份实现。
r61 逐份读了两者的样式块：

| | 共享 `Toast` 部件 | timeline 的 `toastStyle` |
|---|---|---|
| 定位 | `position: fixed`，顶部居中，从 `top:-60px` 滑入，`zIndex:200` | **文档流内**，`width:fit-content` + `margin:0 auto 8px`，锚在输入框上方 |
| 宽度 | `maxWidth:480` + 单行省略 | 随内容 |
| 边框 | 按 variant 着色 | 恒中性 `--color-border` |

结论：**放置模型确实不同**（浮层 vs 就地提示），r37 的判断成立，这条待办可以关闭。
> 通则：长期挂在待办里的"已判断但未做"项，要么去**取证**、要么删掉。
> 推断被反复转述多轮之后，会被当成既有事实，从而挡住真正的检查——
> 而取证的成本往往比想象低（这里就是读两个样式块）。

**而比对过程挖出了一个更实的缺陷**：timeline 的 toast **完全没有严重级**。
它有 15 个调用点，其中 **11 个是失败**（`modelApplyFailed` ×3 / `thinkingApplyFailed` /
`rewindFailed` ×2 / `attachmentUnsupported` / `attachSkipped` / `openFolderFirst` /
`sessionKernelNotLoaded` / `kernelRequired`），但一律：
① 视觉上与告知**长得一样**（恒中性边框 + `--color-fg`）；
② 读屏侧一律 `polite`（排队播报）。
按 r59 自己定的原则——**播报强度属于语义，不是渲染细节**——失败被"礼貌地排队"等于听不到。

修法：状态从 `{key,text}` 扩成 `{key,text,kind}`，`showToast(text, kind = "info")`，
样式按 kind 着色（错误走 `--color-accent-error` 的边框与文字），
`<Announce variant={kind}>` 让错误走 `role=alert`（可打断）；11 处失败调用点显式传 `"error"`，
4 处告知类（`queue.enqueued` / `queue.mergedSent` / `queue.interruptedSent` / `toolsFilter*`）保持 info。

**⚠ 缺省参数会把"漏分类"变成静默的。** `kind = "info"` 意味着将来新增一条失败路径时
忘传 `"error"`——编译器不报错、界面不报错、测试不红，只是失败又一次"看不出来、听不到"。
所以补了一条**分类守卫**（`src/transient-severity-classification.test.ts`，4 测），
判据是**文案键的语义**而不是"所有 showToast 都要 error"：

- `FAILURE_HINT = /(Failed|Unsupported|Skipped|Required|NotLoaded|Unavailable|Rejected|First$)/`
  命中的键，调用时必须显式传 `"error"`；
- **反向也要守**：已知的告知类键（`queue.enqueued` 等）**不得**被标 error——
  否则它们会打断用户，且红色边框制造虚假紧迫感；
- 自检钉住 `FAILURE_HINT` 两边：认得 7 个已知失败键、且不会把 5 个告知键误判成失败。

反向注入已验（去掉 `rewindFailed` 两处的 `"error"` → ① 立刻报"2 处失败提示没标严重级"）。

> 通则：**任何"缺省值是安全的那一侧"的参数，都需要一条守卫盯着显式标注**。
> 因为缺省的意义就是"不写也能过"，而这里"不写"恰恰是缺陷。
> 同类形态：r44 的 `developerRole` 设为**必填**（让漏声明编译期就红）是另一种解法——
> 能改必填就改必填，改不了（会破坏既有调用方）才用守卫。

### 17.62 做"声明 ↔ 实际"对账前，先确认被测对象**处于启用态**（r62）

本轮目标是查一类还没系统查过的对应关系：manifest 声明的贡献，界面上是否真的能到达。
第一跑就"查出"一个像是功能漂移的缺陷：`sub-agent` 声明了两个 sidePanel
（`sub-agents-panel` / `sub-agent-dialog`），而右面板只有 11 个开关 ⇒ 用户永远打不开子 Agent 面板。

**它是假缺陷。** 排查链走了四层才落地：

| 层 | 查到什么 |
|---|---|
| 真机 dump 开关 | 13 声明 vs 11 渲染，差的正是 sub-agent 那两个 |
| 壳 `slots.sidePanel()` | 返回里**没有** sub-agent 的项 ⇒ 不是右面板漏画 |
| `plugins.list()` 的 `state` | 其它插件全 `active`，只有 sub-agent 是 **`inactive`** |
| `lifecycle/index.ts` 的 `getPluginState` | `inactive` = 在 `disabledPlugins` 里 |
| **`scripts/demo/lib/home.mjs:132`** | 隔离基线**自己**写了 `disabledPlugins: ["goody-hao", "sub-agent"]` |

启用后重跑：**声明 13 = 渲染 13，两侧差集均为 0**；设置页同样 18 = 18。

> 通则：做"声明 ↔ 实际"对账前，**先确认被测对象处于启用态**。
> 测试基线为了别的用途（例如让某插件不干扰冒烟）而禁用插件是完全合理的，
> 但复用那个基线做可达性对账，就会把**基线的选择**误读成**产品的缺陷**。
> 所以剧本里要有一条**前置断言**：`所有插件都处于 active`——它不通过时，
> 后面的"不可达"结论一律无效。这条断言现在常驻在剧本里。

**本轮我自己还错了两次，都值得记：**

1. **被截断的工具输出造出一个自信的错误结论。** 我看到 `ls sub-agent/ sub-agent/renderer/ | head -12`
   只列出 3 个文件，就断定"manifest 声明的 `renderer/index.tsx` 根本不存在"。
   实际是 `head` 把**两个目录的合并输出**截断了，`index.tsx`、`panel.tsx`、`settings.tsx`
   等 12 个文件都在。与 r48 那次（`grep spawn | head -5` 让我断定"minimal 不 spawn"）
   **完全同一类**：
   > `head`/`tail` 截断过的输出**不能支撑"不存在"这种全称结论**。要下这种结论，
   > 用 `ls | wc -l`、`grep -c`，或不截断地看全。
2. **把一个字段读成了它不是的意思。** 我看到 `sub-agent-dialog` 有 `"revealOn": "subagent:dialog"`，
   就判断它"有意隐藏，合法"。但 `bookmarks` 也有 `revealOn`（`bookmarks:addRequested`）
   而它**有**开关 ⇒ `revealOn` 的语义是"事件触发时自动展开"，不是"隐藏"。
   > 判一个字段语义时，找一个**反例**对照最快：同一字段在别处的行为若与你的解读矛盾，
   > 你的解读就是错的。

**顺带核实了一个"看着像缺陷其实合法"的形态**：22 处 manifest 里写死中文的展示字段
（12 个 `settings.title` + 10 个 `sidePanel.label`）。它们是 r30/r35 确立的**派生键**形态的
`defaultValue` 兜底（`t("sidePanel.<id>", { defaultValue: <manifest 字面量> })`），
真译文来自插件语言包；而 `contribution-label-i18n.test.ts` **已经覆盖**这三个槽位
（`settings[].title` / `tabs[].title` / `sidePanel[].label`）并核对四语言。
所以不是缺陷——**先查有没有守卫覆盖，再决定要不要动手**（r51 的教训）。

产出：`scripts/demo/contribution-reachability.e2e.mjs`（8 项断言）——解除基线禁用 →
前置断言"全部插件 active" → sidePanel 与 settings 两个槽位各做**双向差集**
（声明了没渲染 = 不可达；渲染了没声明 = 幽灵贡献）+ 页面零报错。实测 13/13 与 18/18 全对齐。

### 17.63 静默失败模式值得**预防性**守卫；自检样本要挑最难的那条路径（r63）

r62 那次误判（以为 `renderer/index.tsx` 不存在）反而指出了一个值得守的方向：
壳解析贡献组件的方式是**按字符串查模块导出**——

```ts
const comp = asReactComponent(module[item.component]);
if (comp) registry.set(item.component, comp);
else console.warn(`[registerPluginComponents] 组件 ${item.component} 未在 module exports 中找到 …`);
```

manifest 里写错一个组件名（打字错、重命名组件时忘了改 manifest、或组件存在但**没从
`renderer/index.tsx` 导出**），后果是：**只有一条 console.warn，那个槽位静默空白**。
不抛错、不变红、正向剧本也撞不到（没人会去点一个不存在的面板）。

实测：32 个声明的 component，错配 **0** 个 —— 当前没有缺陷。
**但仍然值得立守卫**，判据是"失败模式是否静默"而不是"现在有没有缺陷"：

> 通则：**静默失败模式（只 warn / 只回落 / 只留空）优先配预防性守卫**。
> 会抛错的缺陷迟早被人撞上，静默的缺陷可以潜伏到用户报障才被发现——
> 而那时现场早已丢失。r53 的债务棘轮、r57 的防再分叉、本条的组件名对账都是这一类。

**这条守卫自己的判据坏了两次，都是被它的自检抓出来的：**

1. **没有递归 re-export**。插件的 `renderer/index.tsx` 通常只是**汇出口**
   （sub-agent 的就是 `export { SubAgentPanel } from "./panel"`），
   只扫入口文件自身的 `export function` 会把绝大多数组件判成"缺失"。
   修法：解析 `export { A } from "./x"` 与 `export * from "./x"` 并递归进被引用模块。
2. **只认 `./` 前缀的说明符**。`system/i18n` 的 manifest 写的是 `"renderer/index.tsx"`
   （没有 `./`），于是入口解析成 null、"导出 0 个名字"。

⚠ **自检样本要挑最难的那条路径。** 第 1 个 bug 之所以被发现，是因为自检样本故意选了
sub-agent 的 `index.tsx`——它**全是 re-export**。若当时随手挑一个直接写
`export function` 的插件做样本，这个 bug 会一直藏着，而守卫看起来是绿的。
> 写自检时问一句：**哪个真实文件会让这个判据最难通过？** 用它当样本。
> 同类：r59 的已知正例清单要包含"状态由 hook 产出、跨文件渲染"那种最刁的形态。

**顺带查出一处真的不一致（虽小）**：43 个 manifest 里只有 `system/i18n` 的 `renderer`
字段缺 `./` 前缀。对**内置**插件是装饰性的（`plugins-host.ts` 的 glob 按路径约定找它们，
不读这个字段），但 `manifest.renderer` 确实**有人读**——只对第三方插件
（`loadThirdParty(p.id, p.path!, p.renderer!)`，与 `path` 拼 URL）。
所以它是一颗"哪天这个插件被当第三方装载才会炸"的种子，已统一成 `./renderer/index.tsx`。
> 查这类"字段写法不一致"时，别停在"看起来没人用"：要 grep 出**读取点**，
> 看它在**哪条路径**上被读（内置 vs 第三方、dev vs packaged），再判断是不是隐患。

产出：`src/manifest-component-exports.test.ts`（4 测：反空转 + re-export 自检 +
① 组件名对账 + ② renderer 入口存在 + ③ 故意写错的名字必须被抓到）。
反向注入已验（把 `SubAgentPanel` 改成 `SubAgentPanelX` → ① 报出精确现场：
哪个 manifest、哪个槽位、该模块导出了几个名字、以及"静默空白"的后果）。

### 17.64 先枚举契约，再拿守卫的覆盖面去对——以及对应关系的**两个方向**都要守（r64）

**① 守卫的覆盖面要和契约对账，不能和"我记得有哪些"对账。**
把契约里全部 **21 种贡献**的字段逐个提取出来后发现：带 `component` 字段的有 **14 种**，
而 r63 那条守卫只查了 **5 种**（照抄 `registerPluginComponents` 里的槽位清单）。
扩面之后声明数从 **32 → 64**（`blockRenderers` 一种就有 14 个，此前完全没查）。
守卫一直是绿的，但它只守了三分之一的面——**r42 那类缺陷的又一次实例**
（判据的覆盖面小于它声称的覆盖面）。

扩面时还查出**静默是分档的**，而报错文案必须说对档位，否则会误导下一个人：

| 槽位 | 解析入口 | 组件名对不上时 |
|---|---|---|
| settings / sidePanel / sidebar / mainView / titlebar | `registerPluginComponents` | `console.warn` 一句，槽位空白 |
| messageRenderers | `registerPluginMessageRenderers` | 同上（另一处 warn） |
| blockRenderers / codeBlockRenderers / messageActions / composer{Stats,Top,Actions,Attachments,Voice} | `getPluginComponent()` | **直接 `return undefined`，连 warn 都没有** |

首版报错文案统一写"壳只 console.warn 一句"，对第三档是**错的**（它比 warn 更静默）。
已按档位改写。
> 通则：描述缺陷后果时，要按**真实代码路径**分档，不要用一个笼统说法盖住差异——
> 下一个人是按这句话判断严重性的。

另外补了一条**覆盖面自检**：断言 `SLOTS` 里必须含 `messageRenderers` / `blockRenderers` /
`composerStats` / `messageActions`，并把反空转阈值按真实规模钉住（≥50 个声明、≥8 种槽位）。
这样"某个槽位从清单里掉了"会立刻红，而不是让覆盖面悄悄缩回去。

**② 对应关系的两个方向都要守，而历史缺陷往往在没人守的那一半。**
`contribution-i18n.test.ts` 早就有一条「声明了 locale 文件 → 路径必须存在」（manifest 指向空气）。
但**反方向**「磁盘上有 locale 文件 → 必须被 `contributes.languages` 登记」一直没有守卫——
而那恰恰是 r29/r30 真出过事的一半：当时查出 **72 个**语言文件躺在 `locales/` 里没登记，
于是**静默不加载**（文件在、内容对、键也齐，界面却永远显示 fallback 或裸键，且不报错）。
根因是 `contributes.languages` 是**显式文件清单**而不是目录扫描 ⇒ "忘记登记"没有任何信号。

§3.7 说「没有守卫的修复只是"这次对了"」——那 72 个修完之后**三十多轮都没有守卫**，
本轮补上（实测 504 个文件 / 504 条登记 / 未登记 0；反向注入放一个 `orphan.json` 进去立刻红，
报错精确到 `sessions/goal: locales/en/orphan.json 未登记进 contributes.languages`）。

> 通则：做"A ↔ B 对应"类守卫时，**先问两个方向各有没有守**。
> 单向守卫给人的安全感是假的：它证明"声明的都有效"，
> 却对"有效的都没声明"（也就是**静默失效**的那一半）一无所知。

**③ 先测量再决定要不要立守卫，并如实说明是预防还是纠错。**
本轮两处测量都是干净的：505 条路径型声明（`systemPrompts.file` + `languages.resources`）
指向不存在的文件 **0** 处；504 个 locale 文件未登记 **0** 个。
所以这两条守卫是**预防性**的（当前无缺陷）。这与 r63 的组件名对账同理——
判据是"失败模式是否静默"，不是"现在有没有缺陷"；但报告里必须写清是哪一种，
否则会把"没查出问题"说成"修了问题"。

产出：`manifest-component-exports.test.ts` 扩到 14 种槽位 / 64 个声明（+ 覆盖面自检），
`contribution-i18n.test.ts` 加反方向守卫（5 测）。反向注入两条都验过。
全量 243 文件 / 2132 测试、5 项审计 0、`contribution-reachability` 8/8。

### 17.65 命名歧义会让**自动化审计本身**出错；先改名，守卫才立得起来（r65）

本轮想给 manifest 里的 i18n 键引用做四语言存在性对账。第一次扫出"4 条缺失译文"
（`subagent.parent_session` 缺 zh-CN/zh-TW/en/de）——**是假阳性**：那个字段
（`sessionGroupings[].parentPathKey`）根本不是文案键，而是 `session.custom` 里的**数据字段名**
（证据：消费方 `sessions-list/renderer/index.tsx` 写的是 `s.custom[g.parentPathKey]`，
以及 `sub-agent/core/orchestrator.ts:15` 的注释「平铺 … 键(sessionGroupings 槽是平铺直接访问)」）。

根因是**契约的命名歧义**：`*Key` 后缀在这份契约里有两种含义——

| 含义 | 字段 |
|---|---|
| i18n 键 | `labelKey` / `titleKey` / `descKey` / `childLabelKey` / `readonlyMessageKey` |
| **数据键** | `customKey`（`session.custom` 域字段）、`parentPathKey`（同） |

这个歧义在**一轮里骗了我两次**（先 `customKey`、后 `parentPathKey`）。
而它不只骗人：任何按字段名做的自动化审计/工具都会在这里产假阳性，
假阳性多了，守卫就会被人加豁免绕过去——歧义于是长期留存。

**所以先改名，守卫才立得起来**：`customKey` → `customField`、`parentPathKey` → `parentPathField`
（契约 + 发布面类型 + `build-kernel` + 两个消费方 + manifest 共 12 处，tsc 全程兜底），
规则变干净：**契约里 `*Key` 一律指 i18n 键，数据字段一律 `*Field`**。
之后才写守卫 `src/manifest-i18n-keys.test.ts`（4 测）：
① 契约的 `*Contribution` 接口里不得再出现语义不明的 `*Key`（**守规则本身**，
防止有人新加一个数据字段又叫 `xxxKey`，把歧义带回来）；
② 每个 `*Key` 引用在四语言里都存在；③ 嵌套形态自检。

> 通则：**当一条守卫必须靠豁免清单才能通过时，先怀疑命名而不是先加豁免。**
> 命名歧义的修复成本是一次机械重命名（编译器兜底），而歧义留存的成本是
> 每一轮审计都要重新踩一次、且每次都可能踩出不同的假结论。

**本轮 grep 的"找不到"错了三次**，都值得记（与 r48 / r62 同一类）：

| # | 结论 | 实际 |
|---|---|---|
| ① | `customKey` 是 i18n 键 | 是 `session.custom` 的数据字段名 |
| ② | `parentPathKey` 是 i18n 键 | 同上 |
| ③ | `customKey='subagent'` **没有写入方** | 有：`spawn-subagent.ts:123` 的 `custom: { subagent: domain, … }` |

第 ③ 次最能说明问题：我只 grep 了带引号的 `"subagent"`，而写入方用的是
**不带引号的对象字面量键**。
> 通则：下"不存在"结论前，先枚举这个东西**可能以哪些形态出现**
> （带引号字符串 / 对象字面量键 / 模板串 / 计算属性 / 类型位置），
> 每种形态都要搜一遍。只搜一种形态得到的"0 处"没有意义。

**自检样本必须来自实测分布，不能凭想象写。** ③ 首版断言
`contributes.settings[].titleKey` 与 `contributes.sidePanel[].labelKey` 两种形态存在——
**两个都不存在**（那两个槽用的是 `title`/`label` 字面量 + 派生键，见 `contribution-label-i18n`）。
实测真实分布是：`fontPresets[].labelKey` 18、`settingsGroups[].fields[].titleKey`/`descKey` 各 12、
**三层嵌套**的 `settingsGroups[].fields[].options[].labelKey` 8、`settingsGroups[].titleKey` 5、
`fileActions[].labelKey` 2、`sessionGroupings[].childLabelKey` 1、`composerPolicies[].readonlyMessageKey` 1
（合计 59）。改用实测分布后，自检样本里特意保留了**三层嵌套**那条——按 r63 的教训，
样本要挑判据最难通过的形态。自检当场红了，这正是它的作用。

**还有一处判据边界要收窄**：① 首版扫整个 `contributions.ts`，把 `sessionKey`
（运行时会话标识，属别的接口、不是 manifest 字段）报成"语义不明的 `*Key`"。
已收窄到只扫 `*Contribution` 接口体内部。

**守卫替我抓到了我自己的 sloppy 还原**：反向注入时我删掉了 de 包的 `review.fileAction`，
还原时却把**英文值**追加到文件末尾（原值是 `"Datei-Blind-Review"`），
`locale-de-coverage` 的棘轮立刻报"新增未翻译条目"。
> 教训：**还原用 `git checkout -- <file>`，不要靠重新输入值**——
> 手输的还原既可能值错、也可能位置错（键序变化会让 diff 噪声变大），
> 而这类错误恰好会被别的守卫抓到，浪费一轮排查。

**本轮的四个"已验证的否定结论"**（都写进报告，避免下一轮重复劳动）：
59 个 `*Key` 引用四语言缺失 **0**；两个数据键都有写入方；505 条路径型声明指向不存在的文件 **0**；
504 个 locale 文件未登记 **0**。

### 17.66 manifest 是字符串世界、契约是类型世界，中间没有自动检查（r66）

把 r63–r65 三条守卫放在一起看，它们守的其实是**同一条缝**：

| 轮 | 缝的哪一半 | 写错的后果 |
|---|---|---|
| r63 | `component` 名 ↔ renderer 导出 | 槽位静默空白（`getPluginComponent` 连 warn 都没有） |
| r64 | locale 文件 ↔ `contributes.languages` 登记 | 语言包静默不加载 |
| r65 | `*Key` 字段 ↔ 四语言译文 | 界面显示裸键或回落 |
| **r66** | **枚举字段的取值 ↔ 契约允许值**、**`icon` 名 ↔ 图标表** | **静默落到默认分支 / 回落 Puzzle 图标** |

根因是一句话：**`plugin.json` 是 JSON，tsc 不检查它**。契约把字段定义成
`saveMode?: "framework" | "manual"`、`when?: { target?: "file" | "dir" | "both" }`、
`placement?: "left" | "right"`，但 manifest 里写成 `"Manual"`（大小写）、`"files"`（多个 s）、
`"manual "`（多个空格）**都不会有任何编译期信号**，运行时表现为静默失效：
`saveMode` 错 ⇒ 保存行为与预期不符；`when.target` 错 ⇒ 文件动作在错误的目标类型上出现/消失；
`placement` 错 ⇒ 按钮跑到另一侧；`icon` 错 ⇒ 回落 Puzzle（这个至少**看得见**，其余三个都看不见）。

**判据的一个关键选择：允许值从契约源码解析，不在守卫里另抄一份。**
否则契约加了新取值而守卫不知道 ⇒ 合法写法被判违规（假阳性），或新取值没人校验（假阴性）——
两种都是 §1.3 契约单源的反面。实测解析出 **8 个**枚举字段
（`configMerge` / `saveMode` / `type` / `target` / `placement` / `category` / `generic` / `source`），
其中 `type` / `category` / `source` 是我手工枚举时**漏掉的**——这就是"解析胜过硬编码"的直接证据。

**图标名的合法集要按真实解析路径来定**，不能只看图标表：`PluginIcon` 的实现是

```tsx
if (window.kernel.kernelIds.includes(name)) return <KernelLogo kernel={name} … />;  // 内核 id → 内核自己的 logo
const Icon = ICONS[name] ?? Puzzle;                                                  // 其余 → 图标表，未知回落 Puzzle
```

所以合法集 = `ICONS` 表的键 **∪ 内核插件的 id**（§6.1：logo 由内核自己声明、不进静态表，
判据用运行时注册表清单而不是写死 `name === "pi"`）。首版只查 `ICONS`，
于是把 `pi`/`dsh`/`minimal`/`probe4` 四个合法值报成"图标名解析不到"——
**又一次假阳性**，而它恰好证明了内核 logo 那条路径是按注册表驱动的（加第四个内核不用改这里）。

**解析器又被自检修了两次**（与 r63/r65 同一类）：
① 首版正则锚在行首（`^\s*`），于是 `when?: { target?: … }` 这种**行内嵌套对象**里的 `target`
整个漏掉；② 改了锚点仍不行，因为值后面的结束符是 `};` 而不是 `;`。
两次都是 ③ 的自检（拿契约里**真实存在**的字段名当样本）当场抓出来的。
> 自检样本要用"已知应该被解析到的真实字段"，而不是"我随手编一个字段名"——
> 后者只能证明正则能匹配自己编的形态。

反向注入两条判据都验过：`saveMode: "manual"` → `"Manual"` 报出
`src/plugins/kernels/dsh/plugin.json .contributes.settings[0].tabs[1].saveMode = "Manual"（契约允许：framework | manual）`；
`icon: "folder-open"` → `"folder-open-typo"` 同样精确报出。

**本轮同时核实了两个"看着像缺陷其实合法"的形态**（都写了证据，不是推断）：
① `revealOn` 的两个取值（`subagent:dialog` / `bookmarks:addRequested`）都在各自插件的
`export const channels` 里真实声明；② `resolvePluginIcon` 对未知名返回 `null`
（把回退决定权交给调用方），而 `PluginIcon` 自己回落 Puzzle——**两种行为不同是有意的**，
源码注释里写着"消费方自己定回退，不吃 PluginIcon 的 Puzzle 兜底"。

### 17.67 `git checkout --` 会抹掉**往轮的未提交工作**；"0 违规"必须报出比对基数（r67）

本轮补上 manifest 对账的最后一半（**字段名**与 **theme token 名**），但过程里犯了两个
方法论错误，都比被查的缺陷更值得记。

**① 我用 `git checkout --` 还原文件，抹掉了早轮的合法工作。**
r66 的反向注入把 `file-tree/plugin.json` 重排了格式（42 行 → 438 行），我想清掉这个噪声，
就跑了 `git checkout -- <file>`。但**本仓是跨轮累积、不逐轮提交的**——HEAD 里根本没有
r29/r30 给这个文件加的 4 条 `sidePanel` 语言登记。于是 checkout 把它们一起抹了，
而 r64 那条"磁盘上的 locale 文件必须被登记"的反方向守卫**当场就红了**（这是它的价值）。

修法：从**本轮注入前**的备份（`/tmp/ft2.bak`）里取出那 4 条，用**字符串插入**合回当前文件
（不再 json round-trip），并验证与备份**语义完全一致**（`json.load(a) == json.load(b)` 为 True），
最终 diff 是干净的 +20/-0。

> 铁律：**撤销自己这一轮的手误，只能用本轮的备份或反向施加同一处编辑**；
> 绝不能对"往轮改过的文件"用 `git checkout --`——在这个仓库里 HEAD 不是安全还原点。
> 配套动作：动 JSON 前后都看一眼 `git diff --numstat`（行数暴涨 = 被重排了）。

**② 改 manifest 用字符串替换，不用 json round-trip。** `json.dumps(…, indent=2)` 会
重排整个文件（缩进、键序、数组展开方式全变），制造几百行噪声 diff，
把真正的改动埋掉——上面那次重排就是这么来的。

**③ 两次"0 违规"其实是空转，靠基数自检才发现。**
token 名那条判据我写了两个版本的提取器，两版都返回 **0 个 token 路径**：
第一版用"TS 对象字面量 → JSON"的粗转换（遇到 `color-mix(…)` 这类含逗号的值就崩）；
第二版手写扫描器，但 `pos` 停在空白处导致键正则匹配失败。
两次下游都得到"manifest 里 0 种未知 token"——**看起来是干净结论，实际是拿空集在比对**。
发现方式是打印比对基数（`THEME_TOKEN_DEFAULTS` 应有 48 条路径）。

> 通则：**任何"0 违规"的结论都必须同时报出比对基数**（扫了多少个字段/多少个 token/多少个文件）。
> 基数为 0 或远小于预期时，"0 违规"是判据坏了，不是仓库干净。
> 这条已写进守卫的反空转断言（`tokens.size >= 40`、`checked > 2000`、`total > 200`）。

**判据本身的两个决定：**

- **`themes[].tokens` 子树在字段名校验里整棵豁免**：它不是固定形状的 record，而是
  **自由 token 字典**（键就是 token 路径本身，如 `"color.bg"`）。首版没豁免，
  报出 307 处"未知字段名"（`bg`/`sm`/`fg`/`surface-fg`… 全是 token 路径的分段）——全假阳性。
  它的合法性由**另一条判据**单独守（token 路径必须存在于 `THEME_TOKEN_DEFAULTS`）。
  > 一个字段"名字不固定"不代表它没法校验，只是**校验维度不同**：
  > 结构型字段查"名字在不在契约里"，字典型字段查"键在不在值域里"。
- **字段名拼错比枚举值写错更隐蔽**：枚举值错还会落到默认分支（行为可观察），
  字段名错等于**那个字段根本不存在**——壳读不到、也不报错，贡献项带着缺省形状渲染。

实测（都是干净的否定结论，且基数非空）：契约字段名 211 个、manifest 里检查 2727 个
（排除 tokens 子树）未知 **0**；`THEME_TOKEN_DEFAULTS` 48 条路径、manifest 声明 307 个 token、
未知 **0**。守卫 `src/manifest-field-names.test.ts`（4 测），两条判据都反向注入验过
（`"label"` → `"labell"` 报出 `sidePanel[0].labell`；`"color.bg"` → `"color.bgTypo"`
报出 `color.bgTypo ← theme-chatgpt/plugin.json theme=chatgpt-dark`）。

至此 r63–r67 把"manifest 是字符串世界、契约是类型世界"这条缝**四面都封上了**：
组件名（r63）、locale 登记双向（r64）、i18n 键（r65）、枚举值与图标名（r66）、
字段名与 token 名（r67）。

### 17.68 「碰巧对」的决定也是缺陷：顺序裁决要变成被测试钉住的决定（r68）

圆心的图标裁决语义是「同 key 后注册者胜出」（`buildFileIconIndex` 里
`for (const c of contributions) … byExt.set(ext, c)`，迭代中后者覆盖前者）。
这条语义本身没问题——它让高优先级 source 能覆盖内置。但它有个副作用：
**同一个插件内部**两个条目争抢同一扩展名时，胜负完全由 **manifest 里的数组顺序**决定，
而这个顺序从来没人显式决定过，也没有任何提示。

实测的唯一一处就很典型：`.key` 同时被

- `file-tree:slides`（Keynote 演示文稿：`ppt/pptx/**key**/odp`，图标 `file-pie-chart`）
- `file-tree:key`（私钥与证书：`pem/**key**/crt/cer/p12/pfx`，图标 `file-key`）

声明。两种含义在现实里都成立，当前胜出的是 `key`（私钥图标）——**因为它在数组里靠后**。

对开发工具来说这个结果**恰好是对的**（工作区里的 `.key` 极大概率是私钥），
但它是**偶然的**：把两个条目换个顺序，`.key` 就静默变成"演示文稿"图标——
不报错、不变红、没有任何测试会发现。而这不是纯观感问题：
**把私钥显示成幻灯片图标，会误导用户对敏感文件的处理判断。**

> 通则：**"碰巧对"的决定也是缺陷**，因为没有任何东西阻止它翻掉。
> 判据不是"现在的行为对不对"，而是"这个行为是**被决定的**还是**碰上的**"。
> 凡是靠顺序/字典序/文件系统枚举序/对象键序决定的行为，都要问一句：
> 换个顺序会怎样？谁会发现？——如果答案是"没人会发现"，就需要一条守卫。

修法不是改裁决语义（它是对的），而是把偶然变成**被登记、被测试的决定**
（`src/file-icon-collisions.test.ts`，5 测）：
① 找出全部争抢；② 每处必须在 `RESOLVED` 里登记**期望胜出者 + 理由**
（理由要写清冲突的两侧与选择依据，不是只写结论）；
③ 按圆心语义算出**实际胜出者**，必须与登记一致 ⇒ 有人重排数组立刻红；
④ **跨插件**的争抢不由本条断言胜负——那取决于运行时的 source 优先级
（project > user > installed > builtin），静态算不准——但必须登记并写明
"由 source 优先级决定"，避免它变成没人知道的暗坑。

> ④ 是这条守卫里最值得抄的一点：**把"我能静态验证的"与"我不能"分开处理**，
> 不能验的那部分也要显式登记 + 说明为什么不能验，而不是悄悄跳过。
> 悄悄跳过 = 守卫的覆盖面又小于它声称的覆盖面（r42/r64 那类）。

**反向注入的手法本身也有讲究。** 第一次注入我用正则去匹配条目对象，
`\{ "id": "slides"[^\n]*` 只匹配到半截，写回去之后 JSON 非法 ⇒ 测试报 "no tests"
（收集失败）。那不是"守卫抓到了缺陷"，而是"我把文件弄坏了"。
改用**花括号配对**取出完整对象再对调，并在注入后**先验证**：
`json.loads` 能解析、id 多重集不变、顺序确实变了——三条都成立才算注入成功。

> 通则：做反向注入时，**先断言注入后的文件仍然合法**（能解析、只改了你打算改的那一点），
> 再去看守卫红不红。否则你测的是"守卫在坏文件上的行为"，而不是"守卫能不能抓到这个缺陷"。

还原按 r67 定的铁律做：用**本轮的备份**（不是 `git checkout --`），
并验证 `json.load(备份) == json.load(当前)` 为 True，最后确认 `git diff --numstat`
回到本轮之前那份合法的 +20/-0。

本轮另一处测量是干净的：`settingsGroups[].fields` 共 12 个，`type: enum` 都配了 `options`、
`type` 取值都在契约允许集内，**0 处不自洽**（基数非空，所以是有意义的否定结论）。

### 17.69 把一处发现推广成"这一类"时，先分清**查找型**与**列表型**槽位（r69）

r68 查出 `.key` 的胜出者由 manifest 数组顺序偶然决定。按 r57 的通则（"修一个组件级缺陷要问：
还有谁长得像它？"）本轮把它推广到全部贡献槽位。第一次扫描报出 8 处"争抢"，
**逐个辨真伪后全是误报**——而辨真伪的过程恰好把这一类问题的结构讲清楚了：

| 槽位 | 首扫报告 | 真相 |
|---|---|---|
| `blockRenderers` | `toolcall` 被 6 条争抢、`auxblock` 被 3 条 | **有意设计的特异性分层**：`resolveBlockRenderer` 先取特化层（`names` 精确命中）、无特化才落通用层（未声明 `names` 的兜底）。6 条里 5 条是特化（bash/edit/read/…）、1 条是通用兜底 |
| `codeBlockRenderers` | `dot`/`gv`/`mermaid`/`plantuml`/`puml` 各被"同一条目"争抢两次 | **两个独立键空间**：`languages` 与 `fileExtensions` 由 `resolveCodeBlockRenderer` / `resolveCodeBlockRendererByExtension` **两个函数**分别解析。首扫把两个列表合并成一个键空间，于是每条自己和自己"冲突" |
| `messageActions` | `assistant\|left` 被 5 条争抢 | **列表型槽位**：5 条全部渲染，`order` 只定先后；且 registry 已按 `order ?? 100` 排序 |

**关键区分（这才是本轮的产出）：**

| 类型 | 槽位 | 消费方式 | order 平手意味着 |
|---|---|---|---|
| **查找型** | `fileIcons`、`blockRenderers`、`codeBlockRenderers` | 一个 key 只能有**一个胜出者** | **谁生效**由注册序决定 ⇒ r68 那一类 |
| 列表型 | `messageActions`、`fileActions`、`sidePanel`、`settings`、`sidebar`、`mainView`、`titlebar` | 全部渲染，order 只定先后 | 两个条目的相对次序由注册序决定（影响小得多） |

> 推广一处发现时，**先按"消费方式"给对象分类**，再决定判据。
> 首扫把两类混在一起、又把两个键空间合并，于是 8 处报告全是噪声。
> 若照着噪声去"修"，就会把 blockRenderers 的分层设计当成缺陷拆掉——
> **误报不只是浪费时间，它会诱使人破坏正确的设计。**

**同时要修正 r68 的一处表述（准确性优先于叙事连贯）：** r68 说"顺序裁决没有文档"，
这话说重了。registry 侧其实写了：`fileIconItems()` / `blockRendererItems()` 的注释都标明
"按 order 升序、缺省 100、**保注册序**（同 order 时先注册的 builtin 在前）——
消费侧按 key 合并时后注册者胜出"；`resolveBlockRenderer` 更写了三层规则**加一句不可能性论证**
（"同插件同 id 贡献在注册时已被 `removeById` 整项替换，再平手不可能"）。
所以缺的不是"规则没写"，而是**这一处具体争抢没有被显式决定过、且没有守卫**。
> 报告里描述缺陷时要区分三种情况：规则没写 / 规则写了但这一例没按规则决定过 / 规则和决定都有但没守卫。
> 三者的修法完全不同（分别是补文档、补登记、补测试），混为一谈就会修错地方。

**跨插件平手不报，同插件内平手才报**——因为跨插件的注册序**就是** source 优先级
（project > user > installed > builtin，高优先级后注册故胜出），那是有语义的、已文档化的；
而**同一插件内**的数组顺序不承载任何优先级语义，纯粹是书写次序。

实测（基数都非空）：三个查找型槽位共 **195** 个查找键，同插件内平手 **1** 处（就是 `.key`，
已由 r68 登记）；跨插件平手 **0** 处。守卫 `src/lookup-slot-order-ties.test.ts`（4 测）含：
键空间不得混淆的自检（只用 `filenames` 的 `docker` 条目不得产生 `ext:` 键）、
已知争抢必须被识别、登记腐烂检查。
反向注入两件事都验过：① 造一处新的同插件平手（把 `ts` 加进 `js` 条目）⇒ 报出
`fileIcons ext:ts ← file-tree:ts(order=100,idx=0) vs file-tree:js(order=100,idx=1)`；
② **守卫建议的修法①（写明确 order）真的能消除违规**（给 `js` 条目加 `order: 101` ⇒ 转绿）。
> ②这一步值得抄：**守卫给出的修法建议要真的验一次**。只验"能变红"不验"建议的修法能变绿"，
> 就可能留一条"红了但按建议改也不绿"的死路（那会逼人绕过守卫）。

### 17.70 顺着"注册顺序有语义"往上追，会追到文件系统枚举序（r70）

r68/r69 确立了一件事：**注册顺序是有语义的**——registry 的各 `ArraySlot` 保注册序，
消费侧对 `order` 平手的裁决是「后注册者胜出」（查找型）或「后注册者靠后」（列表型）。
顺着这条往上追一层就是本轮的问题：**注册顺序本身从哪来？**

- **跨 source 是显式的**：`bootstrap/boot/steps/40-shell-plugins.ts` 按
  `builtin → installed → user → project` 的固定次序逐个 `registerAll`，
  与文档的 source 优先级（project > user > installed > builtin）一致 ✅
- **同一 source 内部是偶然的**：`discoverPlugins` 直接沿用 `readdirSync(dir)` 的枚举序，
  没有任何排序。而 POSIX **不保证** readdir 的顺序，APFS / ext4 各不相同，
  且增删文件后还会变。

后果分两档，第二档是用户可见的：

1. 查找型槽位的平手胜负**跨机器不可复现**；
2. 列表型槽位里 `order` 相同的条目，其**显示先后**由文件系统说了算。

实测有 **6 组**落在第 2 档：`sidePanel` 的 order=15（blind-review vs tool-manager）、
order=40（im-graph vs session-tree）、order=60（stickers vs sub-agent）、
`settings` 的 order=1（dsh vs general-config）与 order=2（theme-manager vs minimal vs probe4）、
`fileActions` 的 order=100（blind-review vs file-preview）。
这些组内谁先谁后，此前**没有任何人决定过**。

修法（根因，不是补丁）：在 `discoverPlugins` 里 `walk` 之后按 `manifest.id` 字典序排序。
于是同一 source 内的次序变成**确定、可复现、可写进文档**的规则：
「同 source、同 order ⇒ 插件 id 字典序小者在前」；跨 source 优先级不受影响。
`shell-reload.ts` 也走同一个 `discoverPlugins`，一处修两处生效。

⚠ 本机验证时观感**没有变化**（原枚举序恰好与字典序相同）——这正是这类缺陷难发现的原因：
它在开发机上"看起来是对的"，换一台机器/换个文件系统/装一个新插件就可能翻。
> 判据不是"我看到的顺序对不对"，而是"这个顺序是**被规则决定的**还是**被环境碰巧决定的**"。
> 与 r68 的"碰巧对也是缺陷"同一条通则，只是这次的决定者是文件系统而不是数组书写次序。

**本轮又一次踩到"扫描显示什么都没有"**：第一版用花括号配对提取每个 `xxxItems()` 的方法体，
提取失败（19 个方法里 17 个报"未提及 order"），而 r69 明明读过 `messageActionItems()` 里有 sort。
改成"按方法起始行号取到下一个方法之间的行窗口"后，得到正确结果：**19 个 Items 方法里 18 个排序**，
唯一没排序的 `fontPresetsItems` 是因为 `FontPresetContribution` 契约里**根本没有 `order` 字段**（合法）。
> 与 r59 同一条铁律：**扫描返回"全都没有"时，先怀疑扫描器**。
> 尤其当它与本轮之前亲眼读过的事实矛盾时——矛盾就是扫描器坏了的证据。

产出：`discoverPlugins` 排序 + `src/server/application/loader/discover.test.ts`（3 测：
乱序创建仍按 id 升序、递归下降不聚簇、排序只改次序不改集合）。
真机确认三组 sidePanel 平手都按 id 字典序呈现。全量 249 文件 / 2156 测试、
5 项审计 0、e2e 全绿（reachability 8 / minimal-smoke 28 / settings-controls-audit 42）。

### 17.71 「声明了却不兑现」：字段存在比字段缺失更骗人（r71）

把 r46/r47 对**能力轴**做的"声明 ⇔ 消费"普查，换到 **manifest 字段**上重做一遍。
判据：契约里声明、且至少一个 manifest 真在用的字段，必须有**至少一个消费方读取**它。

实测查出 **2 个死字段**：`sessionGroupings[].childIcon` 与 `sessionGroupings[].childLabelKey`。
sub-agent 的 manifest 明明白白写着

```json
{ "id": "subagent", "parentPathField": "subagent.parent_session",
  "childLabelKey": "sub-agent.childLabel", "childIcon": "git-fork" }
```

而唯一的消费方 `sessions-list` 只读了 `parentPathField`——于是子 agent 会话在列表里
与普通会话**长得一模一样**（写死的 `MessageSquare` 图标、没有子分组标题）。
契约注释还写着回落语义（"不提供则用默认缩进图标"/"不提供则不显子分组标题"），
说明设计是打算兑现的，只是消费侧漏了。已按契约兑现（声明优先、缺省回落原默认）。

> **死字段比缺字段更骗人**：字段不存在，插件作者会立刻发现声明不生效；
> 字段存在（还带注释、还进了契约），作者会合理地相信它生效，
> 而界面无反应、不报错、不警告、不变红。这类缺陷只能靠**全仓对账**发现，
> 靠"用一下看看"永远撞不到——因为没人会去验一个自己以为生效的声明。

**语料范围本身必须被断言。** 首版语料漏了 `packages/shared/src`，
于是把 `fileIcons[].filenames` 报成"无人读取"——而它的消费方正是**圆心**的
`buildFileIconIndex`（`for (const name of c.filenames ?? []) byName.set(…)`）。
这个假阳性的价值在于它证明了一件事：

> 判"死代码/死字段"时，**语料范围是判据的一部分**，要和判据一起被自检。
> 现在守卫里有一条 `expect(files.some(f => f.file.startsWith("packages/shared/src/domain/")))`，
> 语料一旦漏掉圆心层就立刻红。与 r48 那次（三个守卫硬编码"恰好三个内核"，
> 导致未列出的内核名永远不会被检测）是同一类盲区：**扫描范围写死 ⇒ 范围外的东西永远绿**。

**反向注入要做"彻底"，否则测的是自己的注入而不是守卫。** 第一次注入我只删了
分组循环里的赋值（`childIcon: g.childIcon`），守卫**仍然全绿**——因为
`ChildSessionRow` 里的 `child.childIcon` 还在，`.childIcon` 这个读取形态依然命中。
这不是守卫失效，是**注入没打中判据**。重做时把三处（接口字段、赋值、渲染分支）全删掉，
`.childIcon` 读取点 3 → 0，守卫立刻红并点名 `sessionGroupings[].childIcon`。

> 通则：反向注入后**先确认注入本身生效**（数一下目标形态的出现次数：3 → 0），
> 再去看守卫红不红。"注入没生效"和"守卫没抓到"在结果上都是绿的，
> 但前者是你的操作失误、后者才是缺陷——不区分就会得出"守卫没用"的错误结论，
> 或者更糟：得出"守卫有用"的假信心（本次若只看第一次注入，我会以为守卫失效并去改它）。

产出：`sessions-list` 兑现 `childIcon`（经 `PluginIcon` 解析，不在插件里自己映射图标名——
图标解析是机制，只该有一份实现）+ `childLabelKey`（声明了才显子分组标题，不编默认标题）；
`src/manifest-field-consumers.test.ts`（3 测：语料范围与已知正例自检、① 死字段归零、
② r71 兑现的回归锚含"缺省必须回落"）。全量 250 文件 / 2159 测试、5 项审计 0、
e2e 全绿（reachability 8 / session-list-audit 41）。

### 17.72 死契约成员：注释声称的消费方不存在（r72）

把 r71 的"声明 ⇔ 兑现"普查从 manifest 字段推到**中立契约的可选成员**。
`BaseBackend` 的可选成员表达的是 §1.5 的「缺面」：某内核可以没有这个面，
壳探测后走三条出路之一（适配器翻译 / 内核插件补面 / 显式降级）。
**这套机制成立的前提是壳真的去探测。**

实测 5 个可选成员里查出 1 个死的——`resume?`：

| 证据 | 内容 |
|---|---|
| 契约注释 | 「pi 无此面（现场 fork 由 session-store 编排），**壳经 `backend.resume?` 探测**」 |
| 全仓搜索 | `backend.resume` / `resume?.(` / `resume &&` / `.resume?.` **全部形态**，唯一命中是**这句注释自己** |
| 壳的实际做法 | `SessionStore.resume(snapshotId)` 用快照的 lineage entries 在**中立层**派生新会话（`deriveSession`），对所有内核一律适用，不需要任何内核提供"服务端回切"面 |
| 实现分布 | 只有 dsh 实现（走 `DSH_METHODS.sessionResume`）⇒ 同时是死代码与**内核间功能不对称** |

处置：**删除**（契约成员 + dsh 实现 + 协议常量三处），并在契约里留下带证据的退役说明。

> 为什么不是"改注释说明它没用"：死契约成员**有害**——与 r46/r47 的死能力轴同理，
> 读者（以及**第五个内核的实现者**）会以为必须实现它、以为壳会探测它。
> **没有消费方的抽象不是抽象，是猜测**；§1.5「内核先抽象后实现」的前提是壳真的需要这个面。
> 若将来真需要（例如中立层派生无法表达某内核的语义），按 §1.5 重走一遍：
> 先落契约、再各内核实现或显式降级，并**同时**接上消费方。

**顺带修好一个被我的退役说明暴露出来的扫描器缺陷。** 删掉 `sessionResume` 后，
`dsh-sdk-method-coverage.test.ts` 报「DSH_METHODS.sessionResume 在单源表里不存在」——
看起来像我删错了。真因：那个测试的 `scanCalledMembers()` **不剥离注释**，
而我在 `dsh-backend.ts` 写的退役说明里提到了 `DSH_METHODS.sessionResume`，被当成了调用点。

本仓的纪律恰恰是"退役符号可以留在代码里，但要带标注"（文档漂移审计就是按"有标注即合法"工作的），
所以**注释里提到旧符号是合法且会反复出现的形态**。已给扫描器加上剥离块注释与行注释
（与 `audit:deps` 检验⑬ 同一教训）。
> 通则：**写退役说明时，你正在给所有"不剥注释的扫描器"埋假阳性**。
> 与其要求注释避开符号名（那会让说明变得含糊），不如修扫描器——
> 这类扫描器通常不止一个，修一个就少一类长期噪声。

**判据收紧的两处（都被自检修出来）：**
1. 语料范围判据用 `/kernel/` 粗匹配，把 `src/server/bootstrap/kernel/`（**组装根的内核注册表**，
   属壳侧装配层）也算成"实现侧"⇒ 自检假红。已精确到 `startsWith("src/server/kernel/")`。
2. 探测形态里有一条 `\.name\s*\?`（想抓三元），结果把注释散文「壳经 backend.resume? 探测」
   也算成探测 ⇒ **死成员会被判成活的**（正是本条守卫要防的假绿）。
   已改成只认带探测语义的形态：`?.name(` / `.name?.` / `.name &&` / `typeof ….name` /
   `if (….name` / `!….name`，并把"散文提及不得算探测"写成显式反例断言。

> 这两处合起来是一条通则：**"有消费方"类判据的两个失败方向都要自检**——
> 判据太松 ⇒ 死成员判成活的（假绿，守卫失效）；判据太严 ⇒ 活成员判成死的（假阳性，逼人加豁免）。
> 所以自检里必须**同时**有正例（真实探测写法要认得）与反例（散文提及不得算探测）。

产出：契约/dsh/协议三处删除 + `src/contract-optional-members.test.ts`（3 测：
语料范围与已知成员自检、① 死成员归零、② 探测判据正反例自检）。
反向注入已验（往契约加一个无人探测的 `deadFaceForTest?` ⇒ ① 立刻点名它）。
全量 251 文件 / 2162 测试、5 项审计 0、构建通过；e2e：minimal 28 / probe4 28 /
kernel-capability-gating 27（本轮动了契约与 dsh 后端，所以三个内核相关的剧本都跑了）。

### 17.73 动态键存储的特有缺陷：只写不读 ⇒ 重启后设置丢失（r73）

把"声明 ⇔ 兑现"普查推到两个新面，结果都是干净的，但过程中挖出一条**值得单独立守卫**的缺陷类。

**① `KernelSpec` 的 8 个字段全都有消费方**（`pkg` 6 处、`distTag`/`extraPackages` 各 1、
其余各 2）——干净。

**② prefs 的 17 个键全部既写又读**——但这是**修好判据之后**的结论。首版判据报了
`lastSessionByCwd` "只写不读"，实际读取点是：

```ts
window.kernel.prefs.get<Record<string, string>>(PREF_KEYS.lastSessionByCwd)
```

首版正则写的是 `prefs\s*\.\s*get\s*(?:<[^>]*>)?\s*\(\s*PREF_KEYS\.x` ——
`Record<string, string>` 里**嵌套了 `>`**，`[^>]*` 提前截断，于是这个读取点匹配不上。

> 通则（与 r59 同源）：**遇到嵌套语法就别用正则解析它**。
> 改成"定位 `prefs.get` / `prefs.set`，再在其后 N 字符**窗口**里找 `PREF_KEYS.<name>`"，
> 对泛型、换行、注释全都不敏感。代价是窗口太大可能把邻近的键算进来，
> 所以窗口要小（本处用 80），并且**把窗口上限本身写成断言**（`expect(WINDOW).toBeLessThanOrEqual(120)`），
> 防止有人为了让某条通过而把窗口放大到失去意义。

**为什么 prefs 这类"动态键存储"值得单独立守卫**——它有一个静态类型帮不上忙的失败模式：

> 新增一个偏好 → 在 setter 里 `prefs.set(PREF_KEYS.x, v)` 落盘 → **忘了在启动水合里 `prefs.get`**

症状极其隐蔽：**当次会话里一切正常**（值就在 zustand store 里，UI 立刻响应），
只有**重启之后**才发现设置没保存。而"重启"恰恰是开发中最不会反复做的动作，
所以这类缺陷常常活到用户报障。反过来"只读不写"同样有害：那个键永远 undefined，
只能靠回落默认值，用户改了不生效。

产出 `src/prefs-keys-readwrite.test.ts`（4 测）：
① 每个键既有 `set` 又有 `get`（三种不平衡分别给不同修法：死键删掉 / 只读不写补落盘 / 只写不读补水合）；
② 自检认得**嵌套泛型**的读取形态（就是首版翻车的那处）+ 窗口上限断言；
③ **单源里成员名与字面量必须一致**（`lastCwd: "lastCwd"`）——若不一致，改成员名会让
**用户已保存的偏好静默失联**（落盘键名变了，旧数据读不到），要改就必须同时写迁移。
反向注入已验：删掉 `lastSessionByCwd` 的启动回读 ⇒ ①② 同时红并点名该键与症状。

**顺带记下普查 prefs 时第一次扫描的错**：我按"字符串字面量"去扫 `prefs.get("x")`，
只扫到 5 个键、0 处写入——因为真实代码用的是 `PREF_KEYS.<name>` **常量单源**（§1.3 的好设计）。
> 教训：**扫一个 API 的用法前，先看它有没有单源常量**。有单源时按字面量扫必然漏
> （而且漏得"看起来很干净"：0 处写入像是没人写，实际是全走了常量）。
> 结果少得可疑就是扫描器坏了——这条铁律本轮又应验一次（r59/r67/r70/r71 之后第五次）。

### 17.74 "会抛错"不等于"能被发现"：路径相关的运行时错误值得静态守卫（r74）

普查事件总线 channel 的注册 ⇔ 收发。`EventBus` 对未注册频道是**抛错**的
（`plugin X emit 未声明的 channel Y` / `invoke 的 channel Y 未被任何已加载插件注册`），
听起来够响亮，但：

> **抛错只在用户走到那条路径时才发生**——某个快捷键组合、某个文件动作、某个面板的 revealOn。
> 而这类路径恰恰是自动化最容易漏的（r26 就记着"附件链的拖拽/粘贴没有自动化覆盖"）。
> 所以"运行时会抛错"不构成"不需要静态守卫"的理由；**路径相关的运行时错误正是静态对账的主场**。

实测结果是干净的（注册 17 个 + 路由 7 + 约定频道 2；死声明 0、未注册发送 0、未注册监听 0），
但**得到这个结论之前，我的判据错了三次**，每次都表现为"报出一批假阳性"：

| # | 判据缺陷 | 假阳性 |
|---|---|---|
| ① | 只认 `.emit(` / `.on(`，漏了 **`invoke`** 这个动词 | 9 个频道被判"只听无人发"（其实是 `ctx.events.invoke(...)` 发的） |
| ② | 正则写 `\.\s*emit`，匹配不到 **`?.emit`**（可选链） | `subagent:dialog` 被判"只发无人听"（真实代码是 `ctx.events?.emit(...)`） |
| ③ | 按**任意对象**的 `.on("…")` 匹配，没限定到事件总线 | **17 个 WS transport 频道**（`transport.on("session:event")`、`"plugins:changed"`、`"restart:state"`…）被判"监听了但未注册" |

③ 最能说明问题：**两套频道名字空间被混算了**。transport 的频道走 WS 传输、
事件总线的频道走 `registerChannels`，注册机制完全不同。混算必然产假阳性，
而假阳性一多，人就会去加豁免——豁免一加，守卫就废了。

**注册来源有四个，少算一个就产假阳性**（这也是 ①②③ 之外的第四类坑）：
1. 插件的 `export const channels = [...]`（框架经 `plugins-host.ts` 自动注册）
2. **壳侧自己注册**：`eventBus.registerChannels("shell", ["shell:openSettings", "shell:backToChat"], …)`
   —— 壳不是插件，所以它不会出现在任何 `channels` 导出里（首版就漏了这两个）
3. **约定频道**：`<pluginId>:fileActionInvoke`（契约里写明是约定频道，由
   `fileActionInvokeChannel(pluginId)` **动态拼名**后 invoke，全仓找不到这个字符串的发送点）
4. **manifest 的 `revealOn`**（框架订阅它来自动展开面板）——⚠ 它在 `plugin.json` 里，
   而语料只收了 `.ts/.tsx`，首版就这么漏了；是 ③ 的自检样本（`subagent:dialog`）抓出来的

**还查出一个签名陷阱**（反向注入时暴露）：两个对象的 `invoke` **实参位置不同**——
`ctx.events.invoke(channel, payload)`（pluginId 已绑定，频道在第 1 位）vs
`eventBus.invoke(callerId, channel, payload)`（频道在第 2 位）。
首版用一条交替式 `(?:"([^"]+)"|[^,)]*,\s*"([^"]+)")` 兜两种，而交替式**总是先试第 1 个分支**，
于是 `eventBus.invoke("timeline", "x:y")` 会把 callerId `"timeline"` 当成频道名报出来——
碰巧它也不是注册频道，所以看着像"抓到了"，其实报错了对象。
> 通则：**一条正则兜两种签名时，先确认两种签名的目标位置是否相同**。
> 不同的话必须按接收者分开写；否则错误会被"碰巧也是违规"掩盖掉。

**本轮反向注入失败了三次，前两次都是注入没打中判据**（r71 之后又犯）：
第一次用形参 `e.invoke(...)`（不是总线对象，判据正确地不匹配）；
第二次把 `eventBus` 起了别名 `__ebR74`（判据按字面接收者匹配，同样不匹配）。
第三次用 `ctx.events.invoke("未注册频道", {})` 才让 ① 变红。
> 教训（第二次写进 skill）：**注入要用被测代码的真实形态**——真实的接收者名字、真实的动词、
> 真实的实参位置。注入前先问"判据是按什么模式匹配的"，照着那个模式写注入。
> 而"注入没打中"与"守卫没抓到"在结果上都是绿的，**不区分就会去改一条正确的守卫**。
> 另外：当注入难以构造时，**单元级自检**（直接断言判据函数对给定代码片段的行为）
> 往往比端到端注入更精确——本轮 arity 修复就是靠 ③ 的
> `sends('eventBus.invoke("timeline", "blind-review:fileActionInvoke", p)') === ["blind-review:fileActionInvoke"]`
> 钉住的。

产出：`src/event-bus-channels.test.ts`（4 测：四个注册来源的自检、① 未注册收发归零、
② 死声明归零、③ 收发形态正反例自检含"transport 频道不得算进来"）。
全量 253 文件 / 2170 测试、5 项审计 0、构建通过、e2e 全绿（reachability 8 / minimal-smoke 28）。

### 17.75 单源表只有在**所有调用点都走常量**时才是单源（r75）

把 r74 的纪律推到 **IPC 频道表**（跨进程：renderer 调用、server 注册）。
`packages/shared/src/channel/channel-contract.ts` 的 `IPC` 表有 **210 条**
`IPC.<组>.<名> = "<wire 字符串>"`，是频道名单源（§1.3）。

三方对账时发现"21 条声明了但无注册点、10 条无调用点"——追下去真因不是漏注册，而是
**34 处传输调用点用了裸字面量**（分布在 5 个文件），所以按 `IPC.` 引用去扫当然扫不到。
其中最要命的是核心会话推送：

```ts
sessionStore.onEvent((event) => { gateway.broadcast("session:event", event); });   // 推送侧字面量
transport.on("session:event", listener);                                           // 接收侧字面量
```

还有 `broadcast("settings:changed")` / `"plugins:changed"` / `"plugin:unloaded"` /
`"skills:changed"`（3 处）/ `"window:maximizedChanged"`。已全部改成走 `IPC.*` 常量
（34 处，tsc 全程兜底；改完 e2e 真跑：minimal 28 / probe4 28 / kernel-reload 46 /
timeline-panel-audit 39——因为这动的是 WS 装配这条最关键的运行时路径）。

**为什么这是缺陷而不只是风格问题**——两种失败模式都**静默**：

1. 改表里的 wire 字符串 ⇒ 走常量的调用点跟着变、走字面量的**留在旧名字上** ⇒
   推送方与接收方名字不再一致：**消息发出去没人收**，不报错、不警告；
2. 字面量拼错一个字符 ⇒ 同上，且 tsc 完全不报（字符串字面量没有类型约束）。

反过来，走常量时这两种情况都变成**编译期错误**（`IPC.session.evet` 不存在）。

> 通则：**单源表的价值 = 定义只有一处 × 引用全部走它**。只满足前半句时，
> 表看起来是单源、实际是"一份权威定义 + 若干平行副本"，而副本不会跟着定义变。
> 这类违反**必须靠静态守卫**，因为字面量与常量都能编译、都能跑，没有别的机制会拦。
> 同类：r65 的 `*Key` 命名歧义、r66 的 manifest 枚举值、r73 的 `PREF_KEYS`——
> 都是"字符串世界与类型世界之间没有自动检查"这一条缝的不同侧面。

**判据的一个正则坑（自检修出来）**：首版给 `\.` 加了左边界 `(?:^|[^\w$])`，
而真实形态是 `gateway.broadcast("…")`——`.` 前面是 `y`（属 `\w`），
于是**所有正常调用点都匹配不上**。症状是两条自检同时报"一个走常量的调用点都没扫到"
与"裸字面量没被抓到"。`\.` 本身已经要求一个点，左边界既多余又有害。
> 写"匹配某个方法调用"的正则时，**不要给点号加左边界**；要限定接收者就写明接收者
> （像 r74 那样写 `ctx\.events|eventBus`），那是有意义的限定，而 `[^\w$]` 不是。

产出：`src/ipc-channel-single-source.test.ts`（3 测：表解析与"确实有走常量的调用点"自检、
① 裸字面量归零、② 正反例自检含"表外字面量不由本条管"——避免把日志文案与测试夹具算进来）。
阈值按实测钉（走常量的调用点正好 20 个文件 ⇒ `>= 20`，首版凭想象写 `> 20` 直接假红）。

### 17.76 引用未定义的 CSS 变量是**纯静默**失败，只能靠静态对账 + 真机取值双证（r76）

`var(--未定义)` 且无回落值时，该声明在计算值阶段无效 ⇒ 属性被丢弃、元素回落继承值/初始值。
**不报错、不警告、控制台干净、tsc 无关**——只是界面某处颜色/间距/圆角"不太对"，
而这类偏差最容易被人当成"设计如此"。

实测查出 **5 个变量、27 处引用**（已修，分布在 10 个文件）：

| 变量 | 引用 | 真相与修法 |
|---|---|---|
| `--color-accent` | **21** | token 表里**没有**裸 `color.accent`（只有 `color.accent.success/warning/error/danger`）；本设计系统的强调色是 `color.primary`（证据：`index.css` 里 `--sidepanel-icon-active-indicator: 3px solid var(--color-primary)`）⇒ 改 `--color-primary` |
| `--color-danger` | 2 | 表里叫 `color.accent.danger` ⇒ `--color-accent-danger` |
| `--color-error` | 2 | 表里叫 `color.accent.error` ⇒ `--color-accent-error` |
| `--color-bg-secondary` | 1 | 表里叫 `color.surface` ⇒ `--color-surface` |
| `--spacing-xxs` | 1 | 表里最小是 `spacing.xs`（没有 xxs）⇒ `--spacing-xs` |

那 21 处 `--color-accent` 分布在 skill-manager 的图标、keybindings 的边框等**装饰性强调**位置，
因为无回落值，实际渲染成继承色——观感"淡得看不出强调"。

**判据要有三类合法例外，且例外必须显式登记而不是放宽判据：**

1. token 单源 `THEME_TOKEN_DEFAULTS`（`color.bg` → `--color-bg`）；
2. CSS/TS 里的 `--x:` 声明（含 `src/web/index.css` 的壳级布局变量 `--sidebar-*` / `--sidepanel-*`，
   共 100+ 个，它们**不在** token 表里——首版只拿 token 表比对，报了 103 个假阳性）；
3. **动态注入**：`injectThemeCssVars` 对 `font.size.*` 额外注入 `-raw` 基值
   （`element.style.setProperty(\`${cssVar}-raw\`, value)`——**模板拼名，静态扫不到**）。
   本轮 `--font-size-{xs,sm,base,lg}-raw` 共 24 处引用全靠这条豁免。

框架提供的变量走 `EXTERNAL` 账本（Tailwind v4 默认主题的 `--radius-xs` 等、Radix 的 `--radix-*`），
每条写清来源与**真机验证方式**。

**两个"看着像缺陷其实合法"的判定，都靠额外取证才没误修：**

- `--sidepanel-divider-display`：静态扫说未定义、真机取值也为空。但查引用点发现它**只出现在注释里**
  （`right-panel.tsx` 用它解释"旧名为什么被改名成 `--sidepanel-divider-visual-display`"），
  代码里手柄用的是硬编码 `display:"flex"`（那正是当年的修复）。
  > 所以判据只统计**代码行**里的 `var(...)`，注释里的退役说明不算引用。
- `--radius-xs`（8 处）：我们源码里确实没有定义处，但真机 `getComputedStyle` 取到 `.125rem`
  ——正是 Tailwind v4 默认主题的值 ⇒ 归入 `EXTERNAL` 账本，不是缺陷。

**真机取证是对账的另一半，且必须带对照组。** 用
`getComputedStyle(document.documentElement).getPropertyValue(v)` 逐个取值时，
同时取 `--color-primary` / `--radius-sm` 作对照：它们有值（`#ececec` / `8px`）才说明取法有效。
> 没有对照组的"全空"结果毫无意义——可能是取法错了（r45 的教训：反空转探针自己也会给假结果）。
> 本轮正是靠对照组把"12 个未定义"缩小到"6 个真空 + 6 个假阳性"。

**一个环境坑（不是产品缺陷，但会误判）**：连跑多个 e2e 剧本后，
`settings-controls-audit` 崩在 `EADDRINUSE: 127.0.0.1:18465`——前几轮残留的 electron 进程
仍占着 `MHD_PORT`。清掉残留（`lsof -ti:18465 | xargs kill -9`）后 42/42 通过。
> 通则：**e2e 崩溃先分辨"产品坏了"还是"端口/进程残留"**。看错误类型：
> `EADDRINUSE` / `Failed to fetch browser webSocket URL` 基本是环境问题；
> 断言失败才是产品问题。把环境错误当成产品缺陷去查，会白跑一整轮。

产出：27 处引用改成真实 token 名 + `src/css-var-definitions.test.ts`（4 测：
反空转与对照组自检、① 未定义变量归零、② EXTERNAL 账本理由与腐烂检查、③ r76 的回归锚）。
反向注入已验（把一处改回 `var(--color-accent)` ⇒ ①③ 同时红）。
全量 255 文件 / 2177 测试、5 项审计 0、构建通过；e2e：settings-controls-audit 42 /
a11y-names-audit 12 / minimal-smoke 28。

### 17.77 键写错 ⇒ 界面显示裸键：i18n 对账的最后一块面（r77）

r55/r65 守的是 **manifest 与 ChannelMeta 里的键**；本轮补上最大的一块面：**代码里的 `t("…")`**。
i18next 查不到键时**不报错**，而是把键名本身当译文返回，于是界面上直接出现
`sessions.collapse` 这样的字符串——显眼但不崩溃、不进控制台、tsc 也不管（键是普通字符串）。

实测规模：**911 处静态调用、749 种键**（动态形态 34 处另计），其中 **5 种四语言全缺**：

| 键 | 用处 | 修法 |
|---|---|---|
| `sessions.collapse` / `sessions.expand` | 子会话分组开关的 `title`（既是 tooltip 也是**可访问名**） | 改用**已存在**的 `shell.collapse` / `shell.expand` |
| `sessions.dragToReorder` | 拖拽手柄 tooltip | 改用已存在的 `shell.dragToReorder` |
| `dsh.extTitle` | DSH 内核扩展页标题 | 补四语言（`minimal.extTitle`="Minimal 拓展"、`probe4.extTitle`="Probe4 拓展" 已确立范式） |
| `shell.composerReadonly` | 输入框只读条的**默认**文案（策略未声明 `readonlyMessageKey` 时用） | 补四语言 |

**三个是"另造了一份不存在的键"，两个是"该有却没有"——修法完全不同。**

> 前者的正确修法**不是补译文**，而是改用既有共享键。补译文会让同一句文案在语言包里有两份，
> 将来必然漂移（§1.3 契约单源）。所以查到"键不存在"时，**第一步是搜同义的既有键**
> （本轮 `shell.collapse`/`shell.expand`/`shell.dragToReorder` 三个都现成，四语言齐全），
> 第二步才是决定要不要新增。
> 判断"该新增"的依据是**没有同义键**（`dsh.extTitle` 的两个兄弟内核都有、它独缺；
> `shell.composerReadonly` 是壳级默认文案，只有 sub-agent 自己那条策略专属的）。

**判据边界要写清（本轮显式排除了动态形态）**：覆盖 `t("字面量")` 与
`i18next.t("字面量")`（r56 起非组件的壳代码走 i18next 单例）；
**不覆盖**模板串 `` t(`shell.greeting.${n}`) ``、变量 `t(key)`、
以及经 manifest / `registerChannels` 传入的 `labelKey`（后两类由
`manifest-i18n-keys.test.ts` 与 `channel-meta-i18n.test.ts` 各自负责）。
把动态形态算进来会产假阳性（无法静态求出键名），所以 ③ 的自检里明确断言
"模板串与变量键**不得**被提取"——这条反例和正例一样重要。

**反方向（死键）本轮刻意没做**，并说明原因：粗扫 `shell.*`/`sessions.*` 两族得到 41 个"无引用"键，
但抽查即知多为假阳性——`shell.channel.*` 是经 `registerChannels` 的 meta 对象传入（不是 `t()` 调用）、
`shell.greeting.1` / `sessions.today` 等是**动态拼键**。要做反方向必须先按"前缀族"匹配动态形态，
否则会把一批活键判死（r47 的教训：判据漏一种消费形态就会指认活代码为死代码）。
> 通则：**一个方向的判据没把握时，不要顺手把反方向也做了**。
> 宁可如实写"反方向未做 + 为什么 + 要做什么才能做"，也不要交一条会产假阳性的守卫
> ——假阳性会逼人加豁免，豁免一加，两个方向都废了。

产出：`src/code-i18n-keys.test.ts`（4 测：规模与已知键自检、① 四语言缺失归零、
② 被引用的键译文非空且不等于键名、③ 提取器正反例自检含 `i18next.t` 形态与
"不存在的键必须被判缺失"）。反向注入已验（`shell.dragToReorder` → `…Typo` ⇒ ① 点名该键、
缺哪四语言、在哪个文件）。全量 256 文件 / 2181 测试、5 项审计 0、构建通过；
e2e：kernel-capability-gating 27（覆盖 dsh 扩展页）/ session-list-audit 41 / settings-controls-audit 42。

### 17.78 跨十轮悬而未决的设计题，答案可能是"机制早已建好、只是没接线"（r78）

"服务端错误消息要不要国际化"这道题从 r42 起被推迟了 **10+ 轮**，每轮的理由都是
"需要先定设计"。r78 真去查，发现：

**`src/server/application/i18n/translator.ts` 早已按 `docs/plugins/05-plugin-i18n §6.2`
（「main 端持单例(init 一次)」）实现好了** —— `initTranslator` / `t(key, vars)` /
`changeLocale` / `currentLocale` / `detectLocale` / fallback 链（当前 locale → en → manifest 字面值 → 键名）
一应俱全，94 行。而 **`initTranslator` 全仓零调用点** ⇒ 单例从未初始化 ⇒
`t()` 恒走 `if (!initialized) return key` 的退化路径 ⇒ 服务端只能写死中文。

> 所以这道题不是"设计未定"，而是**机制齐全、没人启动**。
> 与 r72 删掉的死契约成员同类、方向相反：那次是"契约有面没人调"（删），
> 这次是"实现有机制没人接"（接）。两者的共同点是**编译期与运行期都不报错**。
>
> 通则：**一道设计题被反复推迟时，先去看它依赖的机制是不是已经存在**。
> "需要先定设计"常常是"没去查现状"的委婉说法——而查现状的成本通常是一两个 grep
> （本轮就是 `grep -rn "initTranslator" src/server`）。
> 反复推迟的代价是：每轮都要重新想起它、重新判断要不要做，而它一直在那儿。

**接线**（依据充分：文档写了 main 端持单例；§1.2 说文案归语言插件——这里查的仍是
**插件贡献的语言包**，服务端不持有文案，只按当前 locale 查表）：
在 `50-wiring.ts` 拿到 `i18nResources` 之后调用
`initTranslator({ resources: i18nResources, lng: prefsStore.get("currentLocale") || DEFAULT_LOCALE, ns, supportedLngs })`。

**迁移第一批**（只迁真正面向用户的，判据沿用 r56 那条：*这段文本会不会作为用户可见内容出现？*）：
`controllers/kernel.ts` 与 `controllers/extensions.ts` 的两条缺面错误——它们含
**用户操作指引**（"在设置页重载内核插件后重试"），会经 IPC 浮到 UI。
改成 `t("shell.kernelFaceMissing", { kernel, face })` / `t("shell.kernelExtensionFaceMissing", { kernel })`
+ 2 键 × 4 语言（落在 system/i18n 的 shell.json，符合"跨插件壳文案归 shell.*"的既有约定）。

**为什么不全迁**：实测 `src/server` 里 `throw new Error(含中文)` 共 **153 处 / 21 个目录**，
但绝大多数是**开发者可见的不变量**（启动顺序、插件重复注册、路径越界、"已在运行"），
按 r42 的定性它们该留中文（进日志与开发控制台，不是 UI 文案）。
所以本轮的守卫守的是"**接线不能断** + **已迁移的不能退回**"，不是"全部迁完"。

**真机双证**（这类跨进程改动必须真跑）：
- `LOCALE=en`：`Kernel ghost-kernel has no extension management capability (it may be unloaded; reload kernel plugins in Settings and retry)` —— 中文字符 **0**、无裸键；
- `LOCALE=zh-CN`：`内核 ghost-kernel 没有拓展管理面（…在设置页重载内核插件后重试）` —— 照常中文，无回归。
> 只验 en 不够：那只能证明"变成了英文"，证明不了"按 locale 走"。
> **两种语言都验**才说明是查表而不是把文案换了一份写死的。

**测试怎么改（沿用 r54/r56 的纪律：给真字典，不软化断言）**：
`kernel-live-accessors.test.ts` 原本断言消息含 "ghost" / "模型配置" / 匹配 `/重载|装载|卸载/`。
迁移后 `t()` 在单测里未初始化会返回键名，于是断言收到 `"kernelFaceMissing"`。
修法是**在测试里用真实语言包初始化 translator**，断言原样保留。
⚠ 这里还踩了一个资源形状的坑：语言包文件是**带 ns 前缀的扁平键**（`"shell.kernelFaceMissing"`），
而 merge 的规则是「第一个 dot 前是 namespace、其余按 dot 分层嵌套」，
i18next 要的形状是 `{ "zh-CN": { shell: { kernelFaceMissing: … } } }`。
首版把扁平对象直接当 resources 传，于是查 `shell.kernelFaceMissing` 在 ns=shell 里找
key=`kernelFaceMissing` 落空、`t()` 返回**键尾**（症状：断言收到 `"kernelFaceMissing"` 而不是译文）。
> 通则：**给测试喂字典时，形状要按生产的合并规则来**，不能直接把语言包文件当 resources。
> 症状"收到了键名的一部分"就是形状不对的信号（全键名=没初始化，键尾=ns/分隔符错配）。

产出：接线 + 2 键 × 4 语言 + `src/server-i18n-wiring.test.ts`（4 测：文件在场、
① 必须调用 initTranslator 且喂真实 resources 与 prefs 的 currentLocale、
② 已迁移消息不得写回中文字面量、③ 迁移键四语言齐全非空）。
全量 257 文件 / 2185 测试、5 项审计 0、构建通过、kernel-capability-gating 27。

### 17.79 分类账本 + 棘轮：153 处里先做完"最可能面向用户的那一层"（r79）

r78 把服务端 i18n 单例接上线之后，"服务端中文错误消息"这件事从"做不到"变成了"能做"。
但全仓 `src/server` 里含中文的 `throw` 有 **153 处 / 21 个目录**——全迁既无收益
（绝大多数是启动顺序、插件重复注册、路径越界这类不变量，用户永远看不到），
又会把 153 条开发信息塞进语言包（污染翻译面、四语言维护成本翻倍）。

所以本轮的做法是：**只对最可能面向用户的一层（`src/server/controllers/`，IPC handler 所在层）
做完逐条分类**，其余层留待按同一判据逐层推进。实测该层 9 处含中文的 throw：

- **1 处面向用户 ⇒ 迁移**：`kernel.ts` 的 `无内核提供 llm:oneshot 能力`。
  判定依据不是"它在 controllers 里"，而是**查了调用方的 catch**：
  git-review 的 `setActionError(t("review.generateFailed", { error: (err as Error).message }))`
  把服务端消息**插进用户可见文案** ⇒ 英文界面里会出现
  `Generation failed: 无内核提供 llm:oneshot 能力`。改成 `t("shell.noOneshotCapability")` + 四语言。
- **8 处开发者可见 ⇒ 登记入账本**，每条写清「**谁会看到它** + **为什么不该 i18n**」：
  插件作者（`未知插件` / `未声明权限 sessions:bus` / `configFile 路径越界`）、
  调用方开发者（`relPath 不能是绝对路径` / `不能含 ..`）、
  安全审计（`fs:project 越界` / `session 文件路径越界`）、
  以及"UI 侧已有用户提示、服务端只是兜底"的那条（`fs:project 拒绝:无激活项目目录`——
  renderer 侧本就有 `shell.openFolderFirst` 的用户提示，r61 给它标过 error 严重级）。

> 判断"会不会浮到 UI"**不能只看抛出点在哪一层**，要**查调用方的 catch**：
> 同一条服务端消息，被 `console.error` 吞掉就是开发者可见，
> 被插进 `t("…", { error: err.message })` 就是用户可见。
> 这条判据比"按目录分类"准，也是本轮唯一那处迁移能被识别出来的原因。

**守卫形态：账本 + 棘轮**（`src/server-error-copy-classification.test.ts`，5 测）：
① 该层每一处中文 throw 都必须在 `DEV_FACING` 账本里登记（未登记 = 没人判断过它是否面向用户）；
② **棘轮**：数量只许减少（基线 8），新增的大概率是面向用户的消息；
③ 账本腐烂检查（needle 还在不在、理由是否够长、有没有写清"谁会看到"）；
④ 已迁移的那条不得写回中文字面量。

**两处被自检修出来的判据问题（都是老熟人）：**

1. ④ 首版不剥注释 ⇒ 我在迁移时写的说明里引用了旧字面量
   （"于是英文界面里会出现 Generation failed: 无内核提供 llm:oneshot 能力"），
   被判成"写回了硬编码中文"。**这就是 r74 那条通则的第二次应验**：
   > 写退役/迁移说明时，你正在给所有"不剥注释的扫描器"埋假阳性。修扫描器，别改说明。
2. ③ 的理由长度阈值（>20 字）抓出我两条偷懒的 `"同上：…"`。
   修法是**扩写理由**而不是降低阈值——降阈值等于削弱守卫（r53 的债务棘轮同理：
   上限只许降不许升，理由只许写清不许含糊）。

**测试断言的改法沿用 r54/r56/r78 的纪律**：`kernel-live-accessors.test.ts` 原本断言
`msg` 含 `"无内核提供"` 且不含 `"没有"`（用字面量当"聚合错误 vs per-id 错误"的区分器）。
迁移后改成**从真字典取文案**来断言：`expect(msg).toBe(SHELL_ZH["noOneshotCapability"])`
——整句相等既证明是聚合错误、又天然排除 per-id 那条（后者含 `{{kernel}}`/`{{face}}` 插值）。
> 通则：**断言文案时从字典取，不要在测试里复制字面量**。复制一份就等于把文案存了第二遍，
> 将来必然漂移；而且"从字典取"会让"字典里没这条"直接暴露（本轮就靠 `expect(aggregate).toBeTruthy()` 兜住）。

**如实说明验证边界**：本轮对 oneshot 那条的验证是**单测级**（断言消息等于真字典的译文）
+ r78 已证的接线端到端有效（同一套 `t()` 机制、同一份 shell.json）。
**没有**真机触发 git-review 的 AI 生成失败路径去看那句英文——那需要让 oneshot 真的失败
（无内核提供该能力），零 token 剧本里构造不出来。这条边界记入待办，不当成"已真机验证"。

### 17.80 一个 i18n 追查牵出**UI 卡死**：失败有两种形态，传输路径不同（r80）

本轮目标本来是继续 r79 的分类（把 installer 的「ZIP 格式暂不支持，请使用 .tar.gz」判成面向用户并迁移）。
追它的调用链时发现了更严重的东西。

**服务端 → renderer 的失败有两种形态，走的是不同的传输路径：**

| 形态 | 服务端 | gateway | transport | renderer 侧 |
|---|---|---|---|---|
| ① 返回值 | `return { ok:false, error:"plugin.error.notLoaded" }` | 原样回传 | **resolve** | `await` 得到对象 |
| ② **抛错** | `throw new Error("ZIP 格式暂不支持…")` | 转成 `{ok:false, error:{code:"HANDLER_ERROR", message}}`（`routing/gateway.ts:61-66`） | **reject**（`ws-transport.ts:102`） | `await` **throw** |

plugin-manager 的 **5 个 handler**（enable / disable / uninstall / reload / install）此前都写成
`showFeedback(await ctx.plugins.X(…))` 且**没有 try/catch**，只处理了形态①。于是形态②的后果是：

- `showFeedback` 根本走不到 ⇒ **一点错误提示都没有**（§7.6 禁止的静默失败）；
- install 那条还会让后续的 `setInstalling(false)` / `setInstallOpen(false)` / `setInstallUrl("")`
  全部走不到 ⇒ **按钮永久停在 installing 态、对话框不关、输入不清**，用户只能刷新页面。

而 `ctx.plugins.install` 的返回类型标称 `Promise<{ ok, error }>`——**对抛错路径这个类型是假的**
（类型承诺"总会拿到对象"，运行时却可能 reject）。触发形态②的现实场景很多：
安装源是 `.zip`（installer 明确 throw）、npm 安装失败、URL 不可达、controllers 里的路径越界安全 throw。

> 通则：**追一条错误消息的去向时，要把"抛错"与"返回错误对象"当成两条不同的路径分别追**。
> 只追一条就会得出"已经处理了"的错误结论——本例里形态①确实处理得很完善
> （token-key 协议 + `errorArgs` 插值 + 非 token 原样显示），恰恰因此掩盖了形态②完全没处理。
> 而**类型签名在这里帮不上忙**：它描述的是形态①，形态②在类型上是不可见的（Promise 当然可以 reject）。

**修法（根因，不是给 install 单加一个 catch）**：抽 `runOp(op)` 把两种形态**收敛到一处**——
成功走 `showFeedback(r)`，抛错则把 `err.message` 交给同一个 `showFeedback`
（它内部先按 i18n 键翻译、不是键就原样显示），并返回 `boolean` 供调用方决定后续动作；
5 个 handler 全部改走它（§3.3：同一逻辑在 5 处复制，该收进一处）。
install 另用 `try/finally` 保证**无论成败都解除 installing 态**，且只在成功时关对话框/清输入
（失败时保留，方便改完 URL 直接重试）。

**守卫与如实说明的边界**：`src/plugin-op-rejection-handling.test.ts`（5 测：
① 裸形态 `showFeedback(await ctx.plugins.…)` 归零、② 必须存在 runOp 且其 catch 里真的调了 showFeedback、
③ install 必须 try/finally 且 finally 里有 setInstalling(false)、④ **五个操作都要走收敛点**
——只修 install 是不够的）。反向注入已验（把 handleEnable 改回裸形态 ⇒ ①④ 同时红）。

⚠ **本轮没有真机验证这个修复**，原因如实记下：构造真实失败路径需要在插件管理页的安装框里
填一个 `.zip` 路径并提交，而**设置面板是常驻挂载、非激活时 `display:none`**（早轮已知的形态），
探针虽能找到那个 input（占位符「输入 URL 或选择本地文件」）却无法与隐藏面板里的提交按钮交互。
所以本轮的证据是：**静态守卫 + 三个文件的代码级证据链**（gateway 转错误 → transport reject →
handler 无 catch）。这足以确立缺陷存在与修法的正确性，但**不等于运行时已验证**——
待办里记着"补 DOM 级测试或让探针先激活插件页"。
> 通则：**验不了就写"验不了"，并写清为什么、以及要什么才能验**（本轮缺的是"先点进插件设置页"这一步）。
> 这比含糊地说"已验证"有用得多——下一个人能接着做完。

### 17.81 把一个点的缺陷推广成普查时：分类账本要写"失败后果"，不是写"可接受"（r81）

r80 在 plugin-manager 上查出"只处理返回错误对象、不处理抛错/reject"这一类缺陷。
本轮把它推广到全部 renderer：实测 `await ctx.*(` 共 **72** 处——
在 try 块内 39 处、带行内 `.catch(` 4 处、**两者都没有的 29 处**。
按 API 分布：`ctx.config.set` 9、`ctx.configFile.readBinary` 4、`ctx.config.all` 3、
`ctx.dialog.openDirectory` 2，其余各 1（plugins.list / window.isFocused / sessions.openSession /
sessions.setContext / sessions.getLastAssistantText / configFile.{writeBinary,get} /
config.getScope / dialog.{writeImages,openImages,openZip}）。

**判据的一个必要细节**：必须认**行内 `.catch(`** 这种保护形态。首版只看 try 块，
于是把 sub-agent 的 `await ctx.sessions.openSession(…).catch(() => null)`、
timeline 的 `await ctx.dialog.openFiles().catch(() => {…})` 等 4 处**已保护**的算成未保护。
现在这两处被写成显式自检反例（它们**不得**出现在结果里）。

**为什么是账本 + 棘轮而不是一次改 29 处**：29 处的影响面差别很大——
`ctx.config.set` 失败 = 用户的设置**静默不生效**（界面上开关已翻、实际没落盘，§7.6 禁止，该修）；
`ctx.dialog.openDirectory` 失败 ≈ 用户取消选择（无需提示）；
`ctx.window.isFocused` 失败 = 通知策略退化成"当作未聚焦"（可接受）。
一次全改会把"可接受的静默"也变成弹提示，反而更吵。所以先分类登记、棘轮钉住总数（基线 29），
把高影响的三条（`config.set` 9 处、`configFile.writeBinary` 1 处、`plugins.list` 1 处）标 `todo` 逐轮消化。

**账本条目的质量比数量重要——本轮被自己的守卫抓了四次。**
④ 那条断言要求每条 `consequence` 写清"用户会看到什么/看不到什么"（阈值 >12 字），
结果我先后写了 **4 条 `"同上"`**（`configFile.get` / `dialog.openImages` / `dialog.openZip` /
`sessions.getLastAssistantText`）被逐条抓出来。修法是**扩写理由，不是降低阈值**
（与 r79 那次同款处置）。

> 通则：**账本/豁免清单的条目必须自证**。写"同上"等于把判断留给读者，
> 而账本的价值恰恰是"三年后有人问为什么这里不处理错误，答案就在这一行"。
> 所以给账本加一条**理由长度与内容判据**（本轮是 >12 字 + todo 项必须含"静默/以为"字样）
> 比加更多条目有用——它逼着登记的人真的想清楚。
> 附带好处：`"同上"` 这种偷懒写法会被当场抓住，而它往往正是"其实没想清楚"的信号。

产出：`src/unprotected-ctx-await.test.ts`（5 测：反空转 + 行内 `.catch` 反例自检、
① 每个未保护 API 都已分类、② 账本条数与实际扫到的**逐 API 数量**一致（不得有失效条目）、
③ 棘轮 ≤29、④ 每条理由自证 + todo 项判据）。
全量 260 文件 / 2200 测试、5 项审计 0、构建通过、minimal-smoke 28。

### 17.82 消化账本 todo 时：9 个调用点的同款缺陷该收进**框架一处**（r82）

r81 的账本里最高影响的一条是 `ctx.config.set`（9 处未保护）：失败时用户的设置
**界面上已翻、实际没落盘，且一点提示都没有**。本轮消化它。

9 处分布在 5 个文件、上下文各异（llm-recorder 的录制开关、tool-manager 的分组保存、
session-bookmarks 的迁移与收藏写入 ×3、stickers 的表情包持久化 ×2、voice-input 的模型与语言选择 ×2），
但**失败时的正确处理逻辑是完全一样的**。按 §3.3（多个调用方的逻辑大同小异、差别只在参数 ⇒
它是一个逻辑的多次复制，该收进框架一个实现），修法是**在框架一处兜底**，不是改 9 处：

```ts
// packages/react/src/plugin-context.ts
set: (key, value, opts) =>
  window.kernel.config.set(pluginId, key, value, opts).catch((err) => {
    announceTransient(i18next.t("shell.configWriteFailed", { detail: err?.message ?? String(err) }), "error");
    throw err;                       // ← 保持 reject 语义
  }),
```

三个设计决定都值得记：

1. **重新抛出，不吞掉**。吞掉会让"已经自己 try/catch 的调用方"以为成功了
   （它们的 catch 分支永不触发）。兜底只负责"让用户看见"，不改变控制流语义。
2. **用 `i18next` 单例而不是 hook 的 `t`**。这段在 `useMemo(…, [pluginId])` 里构造，
   把 `t` 塞进来就得加进依赖数组 ⇒ 每次切换语言都会重建整个 config 面（以及所有持有它的组件重新订阅）。
   与 r42/r56 的先例一致：非组件路径用单例。
3. **命令式提示不另造一套 DOM**。`Announce` 是组件、必须被渲染，框架兜底发生在普通函数里，
   所以给 `live-region.tsx` 加了 `announceTransient(message, variant, ttl)`——
   它渲染出与 `Announce` **完全相同的结构**（`<span role="alert"?>[data-announced]`，
   插进同一个 `ensureToastHost()` 宿主），并在 ttl 后移除节点
   （宿主是常驻 live region，节点留着会让后续播报重复念旧内容）。
   > 通则：给非组件代码补能力时，**照着既有组件的 DOM 形态写孪生**，不要另发明一套
   > （否则读屏行为、样式、主题响应都会与组件版漂移——又造出一份 r57 那种重复实现）。

**账本要怎么更新（这一步容易做错）**：`ctx.config.set` 那 9 处在**语法上仍然**没有 try/catch，
所以扫描结果不变（还是 9 处）。变的是**后果**：不再静默。于是账本条目从 `todo` 改成
`acceptable` 并把 consequence 改写成"框架级兜底播报 …；不再静默"，
而**没有**去改判据把这 9 处算成"已保护"——判据守的是"调用点自身有没有处理"，
框架兜底是另一层；把它算进来会让判据失去发现"框架兜底被删"的能力。
所以另加了一条 **⑤ 回归锚**：`plugin-context` 里必须同时有 `announceTransient`、
`config.set(…).catch(`、`shell.configWriteFailed`、`throw err`，且 `announceTransient` 仍存在。

> 通则：**当修复发生在"比调用点更高的一层"时，调用点级判据不要放水**。
> 正确做法是：调用点判据照旧（它反映语法事实）+ 账本更新后果描述 + 给高层修复单独加回归锚。
> 三者合起来才既不误报、也不会在高层修复被回退时失明。

**过程失误（如实记）**：首次用正则做替换时把 `.catch(` 插错了位置——挂到了 `opts` 参数上
（`config.set(pluginId, key, value, opts.catch(…))`）而不是挂到 `config.set(…)` 返回的 promise 上。
tsc 报了错才发现。教训与 r57 那次索引切片同类：**用正则/索引改写多行表达式后，必须立刻 tsc + 目视那几行**，
不能只看"替换成功"的打印。

产出：框架兜底 + `announceTransient` + `shell.configWriteFailed` × 4 语言 + 账本更新 + ⑤ 回归锚
（守卫 6 测全绿）。全量 260 文件 / 2201 测试、5 项审计 0、构建通过、
e2e：settings-controls-audit 42 / minimal-smoke 28。

### 17.83 账本 todo 清零：单点缺陷局部修，且**守卫会提醒你删条目**（r83）

消化 r81 账本剩下的两条 todo。它们各只有 1 处，与 r82 的 `config.set`（9 处同款）不同，
所以**局部修**而不是收进框架（§3.3 的判据是"多个调用方逻辑大同小异"，单个调用方不满足）。

**① `plugin-manager` 的 `refresh()`**：此前是三段裸 await 串起来
（`ctx.plugins.list()` → 读 customOrder → 读 tagFilter），任一段抛错就**静默中止后面的段**：
列表停在旧数据、用户以为操作没生效、且没有任何提示。修成**分段兜底**：
list 失败走 `showFeedback`（error 严重级，r59 已接 live region）；
偏好读取失败静默用默认值——**这不是"用户以为成功了"的那类静默**，打扰用户反而更差。
分段还保证一段失败不影响另一段的恢复。

**② `stickers` 的 create/save**：追调用链才发现真问题不在被扫到的那一行。
`ctx.configFile.writeBinary` 在 store 层的 `writeBanner()` 里，它被 store 的 add/update 调用，
再被 UI 的 `onSave` / `create` 调用——**这三层全都没有 try/catch**。后果与 r80 的 install 卡死同类：
`setEditing(null)` 与 `reload()` 全走不到 ⇒ 编辑器不关、列表不刷新、且无提示。
修法：加 `mutate(op, failKey)` 助手，失败时播报 + **仍尝试 `reload()`** 让列表回到真实状态
（否则界面会显示"半截"：编辑器关了但列表没更新，或反之）。

> 通则：**扫描命中的那一行往往不是该修的那一层**。`writeBinary` 那行在 store 里是对的
> （store 就该把失败抛给调用方），真正缺兜底的是**最外层的用户动作 handler**。
> 追调用链到"用户动作"那一层再决定修哪里，否则会修错层（在 store 里吞掉错误，
> UI 就永远不知道失败了）。

**一个作用域坑**：stickers 有现成的 `flash(msg, "error")`（r59 给它加了严重级），
但它住在 `useStickerTransfer` hook 里，主组件作用域**取不到**。
所以改用 r82 为框架兜底建的命令式原语 `announceTransient`——它渲染出与
`<Announce variant="error">` 相同的 DOM（role=alert 可打断），读屏行为与本插件
导入导出的失败提示一致。本轮它有了第一个**插件侧**消费方，于是补进发布面导出。
> 这也验证了 r82 那个原语的抽象是对的：它不是只为框架兜底造的一次性东西。

**守卫自己提醒我删账本条目**：修完 ① 之后，`ctx.plugins.list` 在调用点已被 try/catch 包住，
扫描不再命中它 ⇒ ② 的腐烂检查立刻红："账本里这些 API 已不再有未保护调用点（修好了就删条目）"。
于是删掉该条目并把棘轮从 29 下调到 28。
> 这正是"账本必须带腐烂检查"的价值：没有它，账本会越攒越多、里面一半是已失效的条目，
> 最后没人再信它。**注意区分两种更新**：调用点修好了 ⇒ **删条目**（扫不到了）；
> 更高层修好了（如 r82 的框架兜底）⇒ **改 consequence + 保留条目**（语法事实没变）。

④ 那条断言也从"todo 数量 >0"翻成"**todo 必须为空**"——账本清空是进展，不是判据失效；
注释里写明了将来若又登记新 todo，这条会红、那时该改回 >0 并在报告里说明。

产出：两处修复 + `mutate` 助手 + `announceTransient` 进发布面 + `stickers.saveFailed` × 4 语言 +
账本更新（删 1 条、改 1 条、棘轮 29→28、todo 断言翻成清零）。守卫 6 测全绿；
全量 260 文件 / 2201 测试、5 项审计 0、构建通过、e2e：settings-controls-audit 42 / a11y-names-audit 12。

**如实说明验证边界**：两处修复都**没有真机目视**（要构造真实的写盘失败/列表读取失败，
零 token 剧本里不易造）。证据是 tsc + 全量测试 + 账本判据 + 棘轮。

### 17.84 行窗口启发式撑不起"未处理异步"普查；但顺着它仍挖到一处真缺陷（r84）

把 r81/r83 的普查推到其它异步形态，实测：
`void X()` 无 `.catch` **231** 处、`await window.kernel.*` 附近无 try **29** 处、
`useEffect` 里的 async 形态 **0** 处。

**结论是：这三类都不能直接做成守卫**，原因各不相同，都值得记：

| 形态 | 为什么不能直接守 |
|---|---|
| `void X()` 231 处 | 绝大多数是**合法的**发射后不管（系统通知、定时器回调、fire-and-forget 刷新）。要区分"该接住"与"可以不接"，必须知道**这个 promise 的失败对用户意味着什么**——那是语义判断，不是语法判断 |
| `await window.kernel.*` 29 处 | 我的判据是"往上 N 行找 `try {`"，这是**行窗口启发式**，而保护关系是**函数作用域**级的。抽查即崩：`settings-page.tsx` 的保存路径其实是 `try { … } catch (err) { setSaveError(…) } finally { setSaving(false) }`（r80 那个模式的正确形态），`remote-access` 的 6 处全走集中包装器 `run()`（try/catch/finally + setError + setBusy(false)） |
| `useEffect` async 0 处 | 判据本身没错，但这个形态在本仓不存在（都用 `void (async () => …)()` 或 `.then`） |

> 通则：**"未处理异步"这类判据需要 enclosing-function 分析，行窗口必然产假阳性**。
> 而假阳性一多，人就会加豁免，豁免一加守卫就废（r74/r77 的同款结论）。
> 按 r77 的纪律：**一个方向的判据没把握时，就不要交那条守卫**——
> 本轮如实记下"这三类扫了、判据不成立、要什么才能做（作用域分析）"，
> 而不是硬交一条 29 处全红的守卫。

**但顺着这条线仍挖到一处真缺陷**（这说明"普查做不成守卫"不等于"普查没价值"）：
`layout-store.ts` 的防抖布局持久化是 `void writeGeneralConfig({ layout: skeleton })`——
发射后不管、无 catch。写盘失败（服务端抛错 ⇒ transport reject）会变成 unhandled rejection，
用户侧的表现是**"布局改了、下次打开没记住"，且一点提示都没有**（§7.6 禁止的静默）。
已修：`.catch()` 里用 `announceTransient` 播报 `shell.layoutSaveFailed`（+ 四语言），
并写明**不重试**的理由（布局是可重放的 UI 状态，用户下一次拖动会再触发持久化）。

**追这处的路径也值得记**：`general-config.ts` 被扫出"3 处 await 无 try、全文 0 个 catch"，
看着像重灾区，实际它是 **store 层工具**——把错误抛给调用方是**正确设计**
（r83 的教训：store 就该抛，缺兜底的应在最外层的用户动作层）。
于是改查它的**调用方**，一跳就到 `layout-store.ts:137` 那个 `void`。
> 通则：**"0 个 catch"在某一层是缺陷、在另一层是正确设计**。判断标准是这一层的职责：
> 工具/store 层该抛（让调用方决定），用户动作层该接（决定给用户看什么）。
> 所以普查要**沿调用链走**，不能按文件计数下结论。

**过程失误（如实记）**：给 `layout-store.ts` 补 import 时，我用"找最后一个以 `import ` 开头的行、
在其后插入"的办法，结果插进了一个**多行 import 的中间**（`import {` 与它的成员之间），
tsc 立刻报 3 个语法错。与 r57 的索引切片、r82 的正则插错位置同类：
> **凡是用"位置"而不是"锚点文本"做插入，都要立刻 tsc + 目视那几行**。
> 更稳的做法是拿一段唯一的锚点文本做替换（本轮修就是这么修的）。

产出：布局持久化兜底 + `shell.layoutSaveFailed` × 4 语言。全量 260 文件 / 2201 测试、
5 项审计 0、构建通过、minimal-smoke 28。本轮**没有新增守卫**（理由见上，如实记）。

### 17.85 判据升级到位、但分类工作量超出一轮时：交「棘轮 + 锚」，不交半个账本（r85）

r84 因为行窗口启发式产假阳性而**没有交守卫**。本轮把判据升级成**作用域级**，三个要素：

1. **花括号配对**的 try 范围（不是"往上 N 行找 try"）；
2. 语句级 `.catch(`；
3. **集中包装器识别**：文件内形如
   `const run = async (fn: () => Promise<unknown>) => { … try { await fn(); } catch … }` 的函数，
   凡在它调用点范围内的 await 都算已保护。
   ⚠ 参数表要用**括号配对**取，不能用 `[^)]*`：参数类型 `fn: () => Promise<unknown>` 里就含 `)`，
   正则会在它面前截断——**r73 那条教训的第三次应验**（前两次：泛型 `Record<string, string>`、
   `?.emit` 的可选链）。

判据升级后，包装器识别出 **3 个**：`run`（remote-access）、`runOp`（plugin-manager，r80）、
`mutate`（stickers，r83）——**正是最近三轮建的那三个收敛点**。
> 这本身就是对判据的一次交叉验证：一个"找集中错误处理"的判据，如果连你亲手写的那三个都认不出来，
> 它一定还会漏别人的。**用已知的正确实现当判据的自检样本**（与 r63"挑最难的文件当样本"同理，
> 这里是"挑最该被认出的实现当样本"）。

升级后未保护的 await 从 r84 那份不可信的 29 变成 **54** 处（口径也变了：本轮同时覆盖
`window.kernel.*` 与 `ctx.*`，r84 只扫了前者的一半）。

**本轮交什么、不交什么（这是本轮的主要方法论产出）：**

- **交**：度量 + 棘轮（≤54，只许减少）+ **反假阳性锚**（三处已知已保护的调用点
  ——remote-access 的 `window.kernel.remote.*`、settings-page 的保存路径、plugin-manager 的
  `ctx.plugins.list`——**不得**出现在未保护名单里）+ 分层事实钉住（store/工具层 17 处）。
- **不交**：逐处分类账本。因为分类要按**层职责**判断（`stickers-store.ts` 10 处、
  `general-config.ts` 3 处都是 store 层，把错误抛给调用方是**正确设计**；
  `settings-page.tsx` 11 处要逐个分辨读路径还是用户动作），一轮做不完，
  而**半分类的账本比没有账本更糟**——它给人一种"已经审过了"的错觉。

> 通则：**判据升级到位、但分类工作量超出一轮时，交"棘轮 + 锚"而不是"半个账本"**。
> 棘轮保证债务不增长，锚保证判据不退化（不会悄悄变回假阳性机器），
> 两者合起来让后续每一轮都能安全地往下消化——这比交一份看着完整、实则一半没审的账本有用得多。

**③ 那条"分层事实"值得单说**：它断言 store/工具层的未保护点 ≤17（实测 stickers-store 10 /
general-config 3 / squad-runner 2 / stt-engine 2）。这些**不是待修项**，而是设计如此
（r83/r84 的结论：store 就该抛，缺兜底的应在最外层用户动作层）。
把它们单独钉住的目的是**防止后续轮次把它们反复当成新发现重审**——
> 普查类工作要有"已知合法"的一格，否则每一轮都会重新"发现"同一批东西，
> 而真正的进展（数字下降）反而看不出来。

**又一次阈值凭猜**：反空转断言我写了"语料 >300 个文件"（照 r77 的 407 推），
实测只有 229——因为本守卫的语料是 `src/plugins + src/web + packages/react/src`，
**不含 `src/server`**（服务端不走 `window.kernel`/`ctx`，判据对它无意义）。
已按实测钉并把差异写进注释。
> 这是本项目第 N 次同一个错：**反空转阈值必须来自当轮实测，不能从别处类推**。
> 类推的阈值要么假红（本轮），要么更糟——松到永远不红。

产出：`src/unhandled-async-scope.test.ts`（4 测）。全量 261 文件 / 2205 测试、
5 项审计 0、构建通过。

### 17.86 消化棘轮债务时，先挑**杠杆最高**的那处；发布面的组件要特别小心作用域（r86）

r85 交了"棘轮 + 锚"（54 处未处理异步），本轮开始消化。选点标准是**杠杆**：
`packages/react/src/kernel-extensions-page.tsx` 的 5 处——它在**发布面**，
是 pi / dsh / minimal / probe4 **四个内核的扩展页共用组件**，修一处等于修四处。

查实缺陷与 r80 的 plugin-manager 完全同型（形态①处理了、形态②没处理）：

| handler | 形态②（抛错/reject）的后果 |
|---|---|
| `handleToggle` | 开关静默无效、`loadExtensions()` 不跑 ⇒ 界面停在旧状态 |
| `handleInstall` | `setInstalling(false)` 走不到 ⇒ **按钮永久卡在 installing 态** |
| `handleRestart` / `handleRestartAll` | 重启静默没发生、待重启列表不刷新 |

`handleInstall` 尤其值得看：它**已经**处理了形态①（`if (result.ok) … else setInstallProgress(result.error)`），
代码看着很完整——恰恰因此掩盖了形态②完全没处理。这是 r80 那条通则的第二次应验：
> **只追一条路径就会得出"已经处理了"的错误结论**；形态①处理得越完善，形态②的缺口越不容易被看见。

修法沿用已建成的三件东西（不另造）：`runGuarded`（r80 `runOp` / r83 `mutate` 同款收敛）+
`announceTransient`（r82 的命令式原语）+ `try/finally` 保证解除 busy 态（r80 的 install 同款）。
失败后仍然刷新列表——**失败时也要让界面回到服务端的真实状态**，而不是停在"我以为的那一侧"。

**踩到一个作用域坑（发布面组件特有）**：首版把 `runGuarded` 定义在组件内，
而 `handleRestart` / `handleRestartAll` 属于**同文件的另一个组件**（扩展页 + 待重启区），
于是 `TS2304: Cannot find name 'runGuarded'`。改成**模块级**函数、`t` 由调用方传入
（模块级函数拿不到 hook）。
> 通则：在一个**导出多个组件**的文件里加共享助手时，先确认它们是否属于同一个组件作用域；
> 不确定就放模块级 + 把 hook 产物当参数传。这比"先写在组件里、报错了再挪"省一轮。
> 另外 `loadExtensions()` / `loadPending()` 返回 `void`，不能在后面挂 `.catch()`
> （`TS2339: Property 'catch' does not exist on type 'void'`）——
> **给 void 返回的调用挂 .catch 是常见笔误**，tsc 会抓，但要认得这个错误信息指的是什么。

消化后棘轮按纪律下调：**54 → 49**（r85 定的"每消化一批就下调"）。
新增 `ext.toggleFailed` / `ext.restartFailed` 两个键 × 4 语言（落在 `system/i18n` 的 `ext.json`，
与既有 `ext.installFailed` 同处——§1.3 单源，跨插件共用的壳文案归 system/i18n）。

验证：全量 261 文件 / 2205 测试、5 项审计 0、构建通过、
**`kernel-capability-gating` 27/27**（这个剧本正好覆盖"模型配置页 + 扩展页 × 三内核真机对照"，
即本轮改动的组件；页面均非空 ⇒ 改动没把扩展页弄坏）。

⚠ 仍未真机目视的：抛错路径本身（要构造服务端 install/toggle 抛错）。
与 r80/r82/r83/r84 同类，记在待办。

### 17.87 构造真实失败路径：一次清掉五轮累积的"未真机目视"债（r87）

r80/r82/r83/r84/r86 连续五轮都在修同一类缺陷（服务端失败两种形态，只处理①不处理②⇒静默失败），
但每轮都只能如实写"未真机目视"——因为构造真实失败需要让写盘/安装**真的失败**，
而零 token 剧本里没有这个手段。本轮找到了：**把项目层配置文件设为只读**。

```
chmod 444 <project>/.my-harness-desktop/config/general.json
chmod 555 <project>/.my-harness-desktop/config/          # 目录也要，否则可删可重建
```
然后在界面上点一次右面板开关（触发布局树变更 ⇒ 防抖 300ms ⇒ `writeGeneralConfig`）。
于是服务端真的抛 `EACCES`，完整走一遍：
**服务端 throw → gateway 转 HANDLER_ERROR → transport reject → renderer `.catch`
→ `announceTransient` → 常驻 live region（role=alert）+ 可见文本**。

实测三语言各 **9/9** 通过，播报内容形如：
`布局保存失败：EACCES: permission denied, open '…/project/.my-harness-desktop/config/general.json'`
/ `Failed to save layout: EACCES: …` / `Layout konnte nicht gespeichert: EACCES: …`
——**三语言都验**才说明是按 locale 查表，而不是换了份写死文案（r78 定的纪律）。

**两个踩坑都值得记：**

**① 只读要设在项目层，不是全局层。** `writeGeneralConfig(patch, cwd)` 在**有 cwd 时**走
`setProject(dir, "config/general.json", …)`，写的是 `<cwd>/.my-harness-desktop/config/general.json`。
首版把只读设在全局 `<dataRoot>/config/general.json` 上，结果写盘照样成功、探针报"无播报"。
> 那是**假阴性**：看起来像"修复无效"，实际是**根本没造出失败**。
> 通则：**构造失败路径的剧本，第一步要证明失败真的发生了**。
> 本剧本靠"播报文本里必须出现 `EACCES`/`permission denied` **以及那个具体路径**"来证明
> （两条独立断言），否则"没有播报"永远分不清是修复无效还是没造出失败。

**② 判"可打断播报"要看任一匹配元素，不能只看第一个。** 首版断言取
`querySelectorAll('[aria-live],[role=status],[role=alert]')` 里**第一个**含该文案的元素，
而 r37 的常驻宿主本身是 `role=status` + `aria-live=polite`（外层），
`announceTransient` 把 `role=alert` 设在**它追加的内层 span** 上（嵌套 live region，
按 ARIA 内层对自己子树优先）。`querySelectorAll` 按文档序返回 ⇒ 外层先命中 ⇒ 断言假红
（看着像"错误没用 alert 播报"，实际是断言取错了元素）。dump 出真实结构才看清：
`[{role:status,live:polite,…},{role:alert,live:null,…}]` 两层都在，都含该文案。
> 通则：**断言嵌套结构的属性时，先 dump 出真实层级**。"取第一个匹配"在嵌套场景下
> 几乎总是错的——要么取最内层，要么断言"存在任一满足"。
> 顺带把外层也断言了（`role=status`/`polite` 必须还在）：那是 r37 的形态要求
> （宿主先于内容存在，才能播报瞬时内容），两层各有各的断言才算把设计钉住。

产出：`scripts/demo/write-failure-feedback.e2e.mjs`（9 项断言 × 3 语言）——
失败文案是本语言译文、带真实底层错误、点名失败文件、不是裸 i18n 键、
落在 live region 里、内层 role=alert 可打断、外层仍是 polite 宿主、页面零报错。
剧本末尾**还原权限**（否则清理临时目录会失败、留下垃圾）。

> 这条剧本的价值超出它验的那一处：它证明了**整条失败反馈链路在真机上通**，
> 于是 r80（plugin-manager runOp）、r82（config.set 框架兜底）、r83（stickers mutate）、
> r86（扩展页 runGuarded）四处修复共用同一条链路，都有了间接的真机证据。
> 五轮累积的"未真机目视"债，用一个剧本 + 一个手段（只读文件系统）清掉了。
> **找手段比逐处验更值**：一个能构造失败的办法，胜过五个"只能靠静态守卫"的说明。

### 17.88 自动化点不动时，先量**元素矩形**与**判据等的是什么**，别先怀疑坐标（r89）

r88 的结论是"点击没生效，怀疑坐标落在不可见元素上"。r89 按接手点①先查机制，
把三个假设逐个证伪/证实：

| 假设 | 实测 | 结论 |
|---|---|---|
| 元素不可见 / 矩形为 0 | `getBoundingClientRect()` = `{x:24, y:641, w:181, h:24}`，`display:flex`、`visibility:visible`、无隐藏祖先，视口 1280×840 | **证伪**：元素可见、矩形正常、在视口内 |
| 被"未保存修改"对话框拦截 | `[data-settings-unsaved-dialog]` 不存在 | **证伪**（这一轮没被拦；但机制真实存在，见下） |
| 判据在等一个不会出现的元素 | `panels:1 / visible:0`；`llm-recorder` 的 settings 条目**没有 `tabs`**，右侧因此不渲染 `[role=tabpanel]` | **证实**：`clickPointUntil` 的谓词要求"可见 tabpanel 内有开关"，而这个条目根本没有 tabpanel ⇒ 谓词永假 ⇒ 重试 6 次后放弃 |

> 通则：**自动化"点不动"时，按顺序量三件事**——① 目标元素的矩形与可见性（不是"存在"）；
> ② 有没有遮罩/守卫把动作拦下（本例是 `guardNavigate`：`activeDirty` 时把动作存进
> `pendingAction` 而不执行）；③ **自己的成功判据等的是不是这个页面真会产出的东西**。
> 第③条最容易被忽略，而它的症状与"点击无效"完全一样（都是"什么都没发生"）——
> r88 就是把③误判成了坐标问题。

**顺带修掉一个有据可查的真缺陷**：那个"未保存修改"对话框（容器 + 取消/放弃/保存三个按钮）
此前**只有 i18n 文案、没有任何 `data-*` 锚点**，而同一个文件 461-463 行的注释自己写着
「`data-settings-id` 是稳定探针锚点……e2e 只能按文本猜——因此写不可靠（skills §10.3：
探针必须靠稳定锚，不靠文本子串）」。已补 `data-settings-unsaved-dialog` 与
`data-settings-unsaved="cancel|discard|save"` 四个锚点，并把理由写进注释
（含"它会拦下设置页内导航，脚本看不到变化就会误判成点击无效"这条 r88 的实测教训）。

> 这也说明**锚点缺失的代价不只是"脚本文案耦合"**：它会连带让脚本**误诊**
> （被守卫拦住时无法判断"是没点上还是被拦了"）。所以给拦截类 UI（确认框/守卫条）补锚点
> 的收益比普通控件更高。

**验证目标本身仍未达成**（如实）：`ctx.config.set` 的框架级兜底（r82）还没能在真机上目视。
剩下的障碍已定位到具体一步：点击 `[data-settings-id=…]` 后，DOM 里有 25 个开关但**没有一个可见**
（`panels:1 / visible:0`），即右侧配置区没有切到该条目。下一轮的接手点：
① 查 `ListItem` 的 `onClick` 是否被 `guardNavigate` 之外的东西包住（`activeDirty` 的初值从哪来）；
② 或绕过 UI 导航——直接触发某个**不需要进设置页**的 `ctx.config.set` 调用方
（r81 账本里 voice-input 的 `stt-engine.ts` 两处、session-colors 的两处都不在设置页里）；
③ 或用 `shell:openSettings` 频道（r55）带参数直达某个条目（若它支持）。

产出：设置页未保存对话框 4 个稳定锚点。全量 261 文件 / 2205 测试、5 项审计 0、tsc 0、构建通过；
e2e：settings-controls-audit 42 / a11y-names-audit 12 / write-failure-feedback（en）9。

### 17.89 真机路走不通时，退到**能精确钉住那一支**的层级，并说清两者互补关系（r90）

r88/r89 两轮想在真机上触发 `ctx.config.set` 的框架级兜底（r82）都失败：
设置页导航在隐藏窗口里点不动（条目无 `tabs` 时右侧不渲染 tabpanel、25 个开关全不可见），
而其它调用方（voice-input 的模型/语言选择）同样难触达。

本轮**不再硬攻真机**，改在 **DOM 层**精确钉住这一支（`packages/react/src/plugin-context.config-set.test.tsx`，4 测）：
① 失败时 live region 里出现 `role=alert` 的播报且含真实原因（`EACCES`）；
② 播报是**译文**不是裸键（用真实 `shell.json` 初始化 i18next，按 r78 的规则整形资源）；
③ **仍然 reject**（不吞掉）——否则自己写了 try/catch 的调用方会以为成功了。

> 通则：**真机路走不通时，退到能精确钉住那一支的层级，但要写清两层各证什么、缺哪层会留什么死角。**
> 本轮的关系是：r87 的真机剧本证明**传输链路**通（服务端 throw → gateway HANDLER_ERROR →
> transport reject → renderer catch → announceTransient → live region + 可见文本），
> DOM 测试证明**这一支的兜底逻辑**对。两者互补——
> 只有真机剧本，则 config.set 这一支没有直接证据；只有 DOM 测试，则传输链路是假设。
> 这比"因为真机跑不通所以这条没验证"有用得多，也比"用 DOM 测试冒充真机验证"诚实。

**测试替身的边界要划清**：`usePluginContext` 在构造期会触碰多个 API 面，
最小桩（只给 `config`）会报 `Cannot read properties of undefined (reading 'get')`。
逐个枚举既啰嗦、又会在发布面新增面时假红，所以用**宽容 Proxy 兜住不关心的面**，
而**被断言的 `config.set` 仍是显式桩**（不受 Proxy 影响）。
> 通则：宽容替身只能用于**本测试不关心的面**；被断言的那一个必须是精确替身。
> 全宽容的替身会让断言失去意义（什么都返回 undefined 也能"通过"），
> 全精确的替身则会在无关演化上假红——**按"是否被断言"划界**。

**又一次路径层级错**（r57 同款、本项目第二次）：从 `packages/react/src/` 到仓库根是 **3** 级，
首版写了 2 级 ⇒ `ENOENT: …/packages/src/plugins/…`。
> 通则：`packages/<pkg>/src/**` 下的测试要读仓库里的其它文件时，**先数层级再写**，
> 或者干脆用 `process.cwd()`（vitest 的 cwd 就是仓库根）。报错信息里出现
> `packages/src/…` 这种"两个根拼在一起"的路径，就是层级数错了的签名。

反向注入已验：摘掉 `plugin-context.ts` 里那段 `.catch(…)` ⇒ ①③ 同时红
（① 报"失败后必须往常驻 live region 里插一条播报"、③ 报"兜底不得吞掉 rejection"）。
全量 262 文件 / 2209 测试、5 项审计 0、构建通过。

### 17.90 迁移服务端文案会**连带触发三类守卫**，这是好事（r91）

按 r79 的判据（查调用方的 catch）继续消化服务端中文错误，迁移三条：
`dsh-config-source` 的空路由/空 model id（经"模型配置页保存"→ `kernelConfig.set` →
设置页 `setSaveError` 浮到 UI，且带**用户可执行指引**）、`installer` 的 ZIP 不支持
（r80 已证安装链路会把 reject 的 message 交给 `showFeedback`）。

**文案归属按 §1.2 分开放**，这是一个容易搞错的点：
- dsh 专属 ⇒ **dsh 内核插件自己的语言包**（`src/plugins/kernels/dsh/locales/*/dsh.json`）。
  不放共享 `shell.*`：那会把内核名带进壳的文案面（§6.3 检验⑤ 的精神）。
- installer 是壳级 ⇒ `shell.installZipUnsupported`（`system/i18n`）。

**迁移连带触发了三类守卫，每一类都抓到了真问题**：

| 守卫 | 报什么 | 处置 |
|---|---|---|
| `locale-kernel-identity` | 新搬进 dsh.json 的文案含 `llm-pi-ai`（内含 "pi"）⇒ 跨内核提及未登记 | **登记**（那是 npm 包名/配置段名，不是对 pi 内核的指称；账本里已有同款先例） |
| `dsh-config-source.test.ts` ×2 | 断言旧中文字面量 | 按 r54/r78/r90 纪律**给真字典**（init translator + 从字典取译文断言），不软化断言 |
| 依赖审计（十三检验） | kernel → application 的新 import | **0 违规**（application 在内圈；`kernel/core/kernel-test-ctx.ts` 早有同款 import 作先例） |

> 通则：**一次改动触发多条守卫不是麻烦，是这些守卫在替你做影响面分析**。
> 尤其"文案搬家"这种看着无害的改动：它会跨进语言包守卫的辖区（内核身份、四语言齐全、
> 键对账），也会跨进依赖方向的辖区（服务端 i18n 在 application 层）。
> 如果一条都没触发，反而要怀疑改动没生效或守卫没覆盖到。

**测试助手自己也会错，而且错得很像被测代码的缺陷。** `dict(key, vars)` 首版直接拿全键
（`"dsh.routeEmptyModels"`）去查已剥前缀的字典 ⇒ 查不到 ⇒ 回落成键名 ⇒
断言显示 `Expected: "dsh.routeEmptyModels"`，看起来像"被测代码没翻译"。
修法是让助手**查不到就直接抛**，而不是静默回落：

```ts
if (out === key) throw new Error(`字典里没有 ${key}（测试助手会静默回落成键名，必须先炸出来）`);
```

> 通则：**测试助手里的"回落默认值"是诊断毒药**。`?? key`、`|| ""`、`?? []` 这类写法
> 会把"助手自己查错了"伪装成"被测代码行为不对"。助手应当在拿不到数据时**立刻炸**，
> 把两种失败分开。（这与 r67"任何 0 违规都要报基数"是同一条纪律的两个面：
> 都是**不让空值/回落冒充结果**。）

**又一次路径层级错**（本项目第三次：r57 两级、r90 三级、本轮五级）：
`src/server/kernel/dsh/backend/` → 仓库根是 **5** 级，首版写 4 级 ⇒ `ENOENT: …/src/src/plugins/…`。
> 报错里出现"两个根拼在一起"（`packages/src/…`、`src/src/…`）就是层级数错了的签名——
> 这个签名比去数目录快得多，值得直接记住。

产出：3 条消息迁移 + 3 个键 × 4 语言 + 跨内核提及登记 + 2 条测试改真字典断言。
全量 262 文件 / 2209 测试、5 项审计 0、构建通过；
e2e：kernel-capability-gating 27（覆盖模型配置页 = 本轮 dsh 消息的浮现路径）、
write-failure-feedback 9（zh-CN）。

### 17.91 新锚点必须**当轮就有剧本用它**；判"在哪个页面"别用可见性（r92）

r89 给设置页的"未保存修改"对话框补了 4 个锚点（`data-settings-unsaved-dialog` /
`data-settings-unsaved="cancel|discard|save"`），但当时**没有任何剧本使用它们**。
本轮把它们用进 `settings-controls-audit`，新增一节验证这条此前完全未测的真实交互路径：
弄脏表单 → 试图离开 → 对话框必须弹出且三个动作锚点齐全 → 『取消』关闭且留在设置页 →
再次导航对话框重新出现（拦截不是一次性的）→ 『放弃』关闭且脏字段被复位。
剧本从 42 项断言增至 **51 项**，全绿。

> 通则：**加锚点的那一轮就要有剧本用它**。锚点是给探针用的，没人用的锚点会腐烂
> （改了没人发现、删了没人报错），而它腐烂时**不会有任何信号**——
> 与 r63 的"死组件名"、r71 的"死字段"、r72 的"死契约成员"同一族：
> **声明了却没有消费方，就是死声明**，只是这次死的是测试锚点而不是产品字段。
> `src/e2e-anchor-coverage.test.ts` 那条守卫（§2 锚点表 + 腐烂检查）正是为此存在的，
> 新锚点要同时进那张表。

**一个判据错误值得单独记：不要用"元素可见性"判"当前在哪个页面"。**
首版断言『放弃并离开』后 `设置列表不可见 && 输入框可见`，实测**两者的 `offsetParent` 都非 null**
（两个视图都在渲染树里、也都能取到布局盒）。可见性判据在本仓的 DOM 结构下不可靠，
而**不可靠的判据比没有判据更糟**：它会随布局细节漂移，红了也说不清是产品坏了还是判据坏了。

改断言『放弃』的**本质效果**——`doReset()` 把脏字段复位（探针输入的文本消失）。
这条比"在哪个页面"更贴合按钮语义，且判据稳定（读的是 input 的 value，不依赖布局）。

> 通则：**断言要挑"语义本质"而不是"表象副作用"**。
> 「点了放弃」的本质是"我的未保存修改被丢掉了"，而不是"某个视图不见了"；
> 「点了取消」的本质是"修改还在、我还在原地"。表象（哪个视图可见）依赖布局实现，
> 本质（值有没有被复位）依赖行为契约——后者才该被断言。
> 同类：r53 那次"回归锚要写在缺陷的真实语法形态上"、r45 那次"反空转探针要包含 input.value"，
> 都是"别断言表象"的变体。

**顺带证实了 r88/r89 的一个猜测**：`guardNavigate` 的拦截机制真实存在且工作正常
（脏表单 + 导航 ⇒ 弹对话框；『取消』⇒ 留在原地、修改不丢）。
所以 r88/r89 那两轮"点条目没反应"确实**不是**产品缺陷，而是自动化侧的问题
（r89 已定位为"判据在等一个不会出现的元素"：条目无 `tabs` 时右侧不渲染 tabpanel）。

产出：`settings-controls-audit` 新增"未保存拦截"一节（9 项断言，42 → 51）。
全量 262 文件 / 2209 测试、5 项审计 0、构建通过、`e2e-anchor-coverage` 4/4。

### 17.92 卡了三轮的自动化阻塞，根因是**产品缺锚点**（r93）

r88/r89 连续两轮想在真机上验证 `ctx.config.set` 的失败兜底，都卡在
"点了设置条目之后，不知道右侧有没有真的切过去"。r88 归因为坐标、r89 归因为
"判据在等一个不会出现的元素（条目无 `tabs` 时不渲染 `[role=tabpanel]`）"——
两个都是**症状**，根因是：

**`SettingsPane` 的根元素没有任何稳定锚点**（无 `data-*`、无 `id`、无 `role`——
`role="tabpanel"` 与 `id` 只在 `inTabs` 分支里才有）。于是自动化**无法判断
"当前激活的是哪个设置条目"**，只能靠 `[role=tabpanel]` 或文本猜，而没有 `tabs`
的条目（17 个里的大多数）根本不渲染 tabpanel ⇒ 判据永假 ⇒ 看起来像"点击无效"。

这违反了该文件自己写在 461-463 行的纪律（「`data-settings-id` 是稳定探针锚点……
e2e 只能按文本猜——因此写不可靠（skills §10.3：探针必须靠稳定锚，不靠文本子串）」）：
入口列表有锚点，**内容面板却没有**。已补 `data-settings-pane={item.id}` 与
`data-settings-pane-active={active}`，并把 r88/r89 的误诊过程写进注释。

补上之后**立刻见效**：探针第一次能确证"点击其实成功了"——
`pane 锚点: ["pi-kernel=false", "llm-recorder=true"]`。
也就是说 r88 的"点击没生效"是**假的**（点击一直是好的），r89 的"判据等错元素"只对了一半
（判据确实错，但错的原因是产品没给可判的东西）。

> 通则：**自动化卡住时，"缺锚点"是与"判据写错"同等常见的根因，而且它伪装成产品缺陷**。
> 排查顺序建议：① 元素矩形与可见性（r89）→ ② 有无遮罩/守卫拦截（r89/r92）→
> ③ 自己的判据等的是不是这页真会产出的东西（r89）→ ④ **产品有没有给出可判定的锚点**（本轮）。
> 前三条都在自动化侧，第四条在产品侧——而它最容易被忽略，因为"加锚点"看起来像是
> 为了测试而改产品（实际上它同时服务可访问性与未来的 e2e，且 §10.3 本来就要求它）。

**本轮验证目标仍未完成，但阻塞已清除**（如实）：`llm-recorder` 的设置面板里
只有一个"清理全部记录"按钮，它的 `recordEnabled` 开关不在设置页（在侧面板），
所以这个插件不适合当验证载体。下一步只需换一个设置面板里**真的有开关**的插件
（voice-input / session-colors / tool-manager 都在 r81 账本里、且都有设置页），
探针已经就绪（判据改成断言 `data-settings-pane-active="true"` + 在激活 pane 内找控件）。
> 这也说明：**选验证载体时要先确认它真的有那条路径**，否则会白跑一轮
> （本轮就是选了 llm-recorder 才发现它的开关不在设置页）。

产出：`SettingsPane` 两个稳定锚点（+ 注释记录 r88/r89 的误诊链）。
全量 262 文件 / 2209 测试、5 项审计 0、构建通过；
e2e：settings-controls-audit 51 / a11y-names-audit 12（锚点是纯增量属性，两者都未受影响）。

### 17.93 四轮才补上的真机验证：阻塞链的每一环都记错了一次（r94）

r82 给 `ctx.config.set` 加了框架级兜底，但 r82/r83/r84/r86 四轮都只能如实写"未真机目视"。
r94 补上了：新剧本 `scripts/demo/config-write-failure.e2e.mjs`，**zh-CN 与 en 各 7/7 通过**，
播报形如 `设置保存失败：EACCES: permission denied, open '…/config/tool-manager.json'`
/ `Failed to save setting: EACCES: …`，且内层 `role=alert`、外层 `status`+polite 宿主都在。

**这条验证花了四轮，每一轮的归因都错了一次**——把这条链完整记下来，比结果更有价值：

| 轮 | 当时的归因 | 实际 |
|---|---|---|
| r88 | "坐标落在不可见元素上" | 错。元素矩形正常（r89 实测 24,641,181×24） |
| r89 | "判据在等一个不会出现的元素（无 `tabs` 的条目不渲染 tabpanel）" | **只对一半**：判据确实错，但错的原因是产品没给可判的东西 |
| r92 | （转向别的事，顺带证实拦截对话框机制正常） | 排除了"被 guardNavigate 拦住"这个假设 |
| r93 | 查明根因：`SettingsPane` 根元素**没有任何锚点** | ✅ 补 `data-settings-pane[-active]` 后立刻通 |
| r94 | 换载体（`llm-recorder` 的开关不在设置页 ⇒ 改 `tool-manager`） | ✅ 一次通过 |

> 通则：**一个自动化阻塞如果连续两轮没解决，就要怀疑"归因层级"错了**——
> r88/r89 都在自动化侧找原因（坐标、判据），而根因在产品侧（缺锚点）。
> 判据是：如果每一轮的修复都"让情况变好一点但没通"，说明还在剥症状；
> 真正的根因被修掉时，通常是**一次就通**（r93 补锚点后 r94 立刻成功）。

**两个可复用的操作细节：**

1. **只读要设两层**：`ctx.config.set` 有 cwd 时写**项目层**
   `<cwd>/.my-harness-desktop/config/<pluginId>.json`，无 cwd 时写全局层
   `<dataRoot>/config/<pluginId>.json`。r87 只设全局层 ⇒ 写盘照样成功 ⇒ 假阴性。
   最稳的做法是两层都设（文件 444 + 目录 555，目录也要否则可删可重建）。
2. **选载体前先确认它真的有那条路径**：首版选 `llm-recorder`（因为 r81 账本里它有
   `ctx.config.set`），但它的 `recordEnabled` 开关在**侧面板**、不在设置页 ⇒ 白跑一轮。
   改用 `tool-manager`（账本里同样有 `config.set("groups", …)`，且设置面板里有可点按钮）。
   > 探明载体的最省办法：先用一个"只读不写"的探针把候选逐个走一遍，
   > dump 每个面板里的控件类型（本轮就是这么筛出 `tools` 有 5 个 button、
   > `blind-review` 有 1 个 select、而 `voice-input`/`session-colors`/`stickers` 面板压根没激活）。

产出：`config-write-failure.e2e.mjs`（7 断言 × 2 语言）+ §2 锚点表登记 4 个新锚点
（`data-settings-pane`/`-active`、`data-settings-unsaved-dialog`/`=cancel|discard|save`/`-title`），
并把 r88/r89 的误诊链写进锚点表备注——**锚点表是下一个人的入口，误诊史比锚点本身更值钱**。

### 17.94 半成品剧本要么不交、要么**自己说清没覆盖什么**（r95）

想给 r80 的 plugin-manager 修复补直接真机证据（安装 `.zip` ⇒ installer 确定性抛错），
结果卡在最后一步：**提交按钮识别不出来**。已查明的三个事实：

1. 插件管理面板**初始没有任何 input**——安装表单默认折叠，要先点「安装插件」展开
   （对应 `installOpen` 状态）。首版直接找 input ⇒ 找不到 ⇒ 假失败。
2. 面板顶部的「安装插件」是**折叠开关**，文本与表单内的提交钮高度相似；
   按文本匹配、按"输入框容器内"匹配都反复命中它——点它等于把刚展开的表单又关上。
3. 在输入框里按 Enter 也不提交。

于是本轮**没有**完成 r80 的直接验证。处置值得记：

**不能把一个会失败的剧本留在仓库里**（它会让任何全量 e2e 变红，下一个人分不清是新缺陷还是旧坑）；
**但也不该直接删掉**（那就丢掉了已经查明的卡点信息）。所以改成**自报半成品**：
- 保留已证实的四步（导航 → 面板激活 → 表单展开 → 填入安装源），它们本身是有价值的导航回归
  （依赖 r93 的 `data-settings-pane` 锚点）；
- 文件头与末尾输出都明写「**半成品**：仅覆盖…；提交后的失败反馈未覆盖」；
- 文件内写下**接手点**（按优先级）：① 给提交钮补稳定锚点（如 `data-plugin-install="submit"`）——
  与 r89/r93 同一处置：产品缺锚点时补锚点比让脚本猜更根本（§10.3）；
  ② 或读 plugin-manager 的 JSX 按**结构**而非文本定位；③ 补完后恢复被摘掉的那段断言。

> 通则：**半成品交付物的唯一合法形态是"自己说清没覆盖什么"**。
> 三个反例都见过：留着会红的剧本（污染全量结果）、悄悄删掉（丢失卡点信息）、
> 以及最糟的——**留着且输出 PASS 但不说自己只覆盖了一半**（那是假绿，比红更危险）。
> 本轮首版就差点犯第三个：末尾还印着「PASS: 4 项断言（插件安装失败可见且不卡死）」，
> 而那正是**没验**的部分。发现后立刻把文案改成如实描述。
> **检查自己的成功输出文案有没有超出实际断言范围**，应当是每次交付前的固定动作。

顺带：本轮又一次栽在**测试标题/标签里的嵌套双引号**（第 9 次），已改 `『』`。
这个错的稳定形态是"在双引号字符串里再写一对双引号做强调"，
值得直接养成习惯：**中文强调一律用 `『』`/`「」`，不用 `"`**。

产出：`scripts/demo/plugin-install-failure.e2e.mjs`（半成品，4 项断言，自报覆盖范围 + 接手点）。
全量 262 文件 / 2209 测试、5 项审计 0、tsc 0、构建通过。

### 17.95 产品缺锚点时，补锚点比让脚本继续猜更根本（r96）

r95 留下的接手点①是"给安装表单的提交钮补稳定锚点"。本轮照做，一次通过：
`scripts/demo/plugin-install-failure.e2e.mjs` **zh-CN 与 en 各 10/10**，
r80 的修复（`runOp` 收敛两种失败形态 + `try/finally` 解除 busy 态）终于有了**直接**真机证据：

- ZIP 不支持的提示以**本语言**出现（r91 迁移的那条服务端消息）
- 提示含**可执行的下一步**（改用 `.tar.gz`），不是只说"失败了"
- 不是裸 i18n 键
- **提交钮没有卡在 installing 态**（`data-installing="false"`）← r80 的根因
- 失败后表单**保持打开**、输入**没被清空**（r80 的设计：成功才关，失败留着方便改完重试）
- 页面零报错

补的锚点是一族而不是一个：`data-plugin-install="toggle|source|browse|submit"`。
**为什么是一族**：r95 的困难不是"找不到提交钮"，而是**折叠开关与提交钮文本高度相似**
（`pluginManager.install` = "安装插件" vs `pluginManager.installBtn` = "安装"），
按文本匹配、按"输入框容器内"匹配、按 Enter 提交三种办法都失败。
一族锚点把"这一组的每个角色"都定死，脚本就不必再猜谁是开关、谁是提交。

顺带补了 `aria-expanded` 到折叠开关上——它此前是个**没有展开态语义**的按钮
（读屏用户按了之后听不到"已展开"）。这与 r41 给可折叠头补 `aria-expanded` 是同一类修复：
> **补探针锚点时顺手检查该控件的 ARIA 语义**：两者服务的是同一批"看不见界面的人"
> （自动化脚本与读屏用户），缺锚点的地方往往也缺语义。r89（未保存对话框）、
> r93（设置面板）、r96（安装表单）三次都是这样：锚点补上时顺带发现语义也缺。

**提交钮另带 `data-installing`** 这一点值得单独说：r80 的根因是"失败后 `setInstalling(false)`
走不到 ⇒ 按钮永久卡在 installing 态"。要断言它，靠读按钮文案（"安装中"/"Installing"）
就得跟着语言与措辞变；而 `data-installing="true|false"` 是**状态本身**，与文案无关。
> 通则：**断言"某个状态位"时，让产品暴露状态位本身，不要从文案反推**。
> 从文案反推的断言会在改文案时假红、也会在多语言下漏判（本轮 en 与 zh-CN 共用同一条断言）。
> 同类：r50 的 `data-plugin-systemprompt-inert`、r46 的 `data-ext-install-unsupported`、
> r61 的 `data-toast-kind`、r93 的 `data-settings-pane-active`。

产出：安装表单 4 个锚点 + `aria-expanded` + `data-installing`，剧本从半成品变成
10 项断言 × 2 语言，§2 锚点表登记（含"为什么是一族"与 r95 的误点史）。
全量 262 文件 / 2209 测试、5 项审计 0、构建通过、a11y-names-audit 12。

### 17.96 一条没有 `.catch` 的加载链 = 整页静默变空（r97）

消化 r85 棘轮时查 `settings-page.tsx` 的 11 处未保护 await，发现真正的问题不在"某一处"，
而在**整条加载链的形状**：

```ts
void window.kernel.settings.list().then(async (list) => {
  for (const item of …) {
    cfgs.set(item.id, await window.kernel.kernelModels[item.kernelModels].readConfig());  // ← 会抛
    …
  }
  setConfigs(…); setProjectOverrides(…); setDirties(…);
});        // ← 链尾**没有 .catch**
```

后果分两层，第二层比第一层严重：

1. 任一读取抛错（内核未装载时 `kernelModels[k].readConfig()`、`configFile` 读失败等）
   ⇒ 整条链 reject ⇒ **unhandled rejection**；
2. 而 `setConfigs` / `setProjectOverrides` / `setDirties` 都在链的**末尾**，
   所以抛错时它们**一个都没执行** ⇒ 设置页呈现"全空/全默认"，且**没有任何提示**。
   用户看到的是"我的配置不见了/本来就是默认值"，而不是"加载失败了"。

> 通则：**把"多个读取 + 最后统一 setState"写进一条 promise 链时，链中任何一处抛错
> 都会让全部 setState 落空**——失败面不是"那一项没读到"，而是"整页变空"。
> 这类形状的代码必须要么逐项兜底（r83 的 refresh 分段兜底），要么链尾统一 `.catch` 并
> 给用户一个"加载失败"的可见状态。两者都要，因为逐项兜底能让**其它项照常显示**，
> 链尾 catch 能保证**无论如何都有提示**。本轮先补链尾（成本低、覆盖全部十来个 await），
> 逐项兜底记入待办。

修法（三件，都是一处）：`loadError` 状态 + 链尾 `.catch`（`announceTransient` 播报 +
`setLoadError`）+ 界面上一行可见提示（带 `data-settings-load-error` 锚点，供 e2e 断言），
并在每次重新加载前 `setLoadError(null)`。

**为什么 loadError 与 saveError 分开**：两者的**可执行下一步不同**——
保存失败 = 重试保存；加载失败 = 重载窗口 / 检查内核是否装载。混用一条会给出错误指引
（§7.6 的降级要"解释"，解释错了等于没解释）。

新增 `shell.settingsLoadFailed` × 4 语言。全量 262 文件 / 2209 测试、5 项审计 0、构建通过；
e2e：settings-controls-audit **51**、config-write-failure 7。

**顺带查明棘轮判据的一类假阳性（如实记）**：补了链尾 `.catch` 之后，
`unhandled-async-scope` 的计数**没有下降**——因为链内那些 `await window.kernel.*`
既不在 `try {}` 里、也没有**语句级** `.catch`，而我的判据只认这两种形态。
语义上它们**是**被保护的（async 回调里抛错 ⇒ 链 reject ⇒ 链尾 catch 接住）。
> 所以棘轮当前的 49 里含这一类假阳性。按 r85 的设计（棘轮 + 锚，不做逐处账本）
> 这是可接受的——棘轮只保证"不增长"，而增长时人要复核。但要**如实写下这类假阳性**，
> 否则下一轮有人会以为"数字没降 = 我白改了"。
> 判据要认全"链式保护"需要识别 `.then(async …)` 之后的链尾 `.catch`，
> 那是 r85 说的 enclosing-function 分析的延伸，记入待办。

### 17.97 判据漏一种保护形态，就会让"修好了"看起来像"白改了"（r98）

r97 给 `settings-page` 的加载链补了链尾 `.catch`，但棘轮计数**没有下降**。
r97 如实记下了这个现象并归因为"判据只认 `try{}` 与语句级 `.catch` 两种保护形态"。
本轮把判据补全：新增第 ④ 种——**链式保护**。

`void p.then(async (…) => { …await X… }).catch(…)` 这种形状里，回调体内的 `await X`
既不在 `try{}` 里、也没有语句级 `.catch`，但**语义上是被保护的**：
async 回调里抛错 ⇒ 整条链 reject ⇒ 链尾 `.catch` 接住。
识别办法：定位每个 `.then(`，用**花括号配对**取出回调体范围，
再检查体结束后紧跟的少量字符里有没有 `.catch(`。

补上之后基线从 **49 → 46**（`settings-page` 从 11 处降到 8 处——那 3 处正是加载链里的）。

> 通则：**判据漏一种"合法形态"，代价不只是假阳性，而是会让修复看起来无效**。
> r97 那次如果没如实记下"计数没降"这个现象、而是直接把它当成"改了也没用"，
> 下一轮就不会去补判据，那条链尾 `.catch` 的价值也就永远显示不出来。
> 所以：**修复后指标没动时，先怀疑指标，再怀疑修复**——
> 与 r59/r67/r70/r71/r73 那条"扫描返回 0（或不变）是危险信号"是同一族纪律，
> 只是这次的方向相反（那边是"太干净"，这边是"没变化"）。

**四种保护形态的完整清单**（这条判据现在的样子，可作为同类普查的模板）：

| # | 形态 | 例子 | 识别方式 |
|---|---|---|---|
| ① | `try { … } catch` 包住 | `settings-page` 的保存路径 | 花括号配对的 try 范围 |
| ② | 语句级 `.catch(` | `await x().catch(() => null)` | 该语句文本里含 `.catch(` |
| ③ | **集中包装器** | `run()` / `runOp()` / `mutate()` / `runGuarded()` | 识别"参数是回调、体内 `try{ await 回调() }catch`"的函数，其调用点范围算已保护（r85） |
| ④ | **链式保护** | `.then(async …).catch(…)` | 花括号配对取回调体 + 体后紧跟 `.catch(`（本轮） |

③ 与 ④ 都是"保护不在 await 那一行、而在更外层结构里"——这正是 r84 说的
"行窗口启发式必然产假阳性"的具体形态，也说明**这类判据必须做结构分析**（花括号/括号配对），
不能靠正则窗口。而结构分析的参数（如 `.then(` 后 120 字符内必须出现 `{`、
体后 40 字符内必须出现 `.catch(`）要**写进注释**，否则下一个人调不动也不敢调。

产出：判据扩到四种保护形态，棘轮基线 49 → **46**（并在注释里记下每次下调的原因）。
全量 262 文件 / 2209 测试、5 项审计 0、构建通过、settings-controls-audit 51。

### 17.98 棘轮量的是"有没有被保护"，量不出"失败时是否优雅降级"（r99）

r97 给 `settings-page` 的加载链补了链尾 `.catch`，但那只是**兜住**——链中任一条目读失败，
后面的 `setConfigs` / `setItems` 仍然全部落空，页面依旧"整体变空"。
本轮补 r97 记下的待办：**逐项兜底**（把 for 循环体包进 try，单项失败则记入 `failed[]`、
该项置空态、**循环继续**；循环后若有失败，`setLoadError(failed.join("; "))` + 播报一次）。

依据是 §7.6 的精神：部分成功应当**显示已成功的部分 + 说明哪一项失败**，而不是全部隐藏。
最典型的现实场景：某个内核未装载时 `kernelModels[k].readConfig()` 抛错——
而其它十几个条目（主题/语言/技能/工具/插件…）与它毫无关系，没理由跟着消失。

**但棘轮计数没有下降（仍是 46）**，查清原因后得到一个值得记的结论：

- 加载循环里的那几处 await，**r98 的"链式保护"判据早已把它们算作已保护**
  （链尾有 `.catch`）；所以本轮再加一层逐项 try，对"是否被保护"这个维度**没有任何改变**。
- settings-page 剩下的 8 处未保护点其实在**别的函数**里（`readLayered` L63、
  `refreshActive` L303/309/316、`clearProject` L439、另一处读取 L449/452/459），
  与加载循环无关。

> 通则：**"有没有兜底"与"兜底之后行为对不对"是两个维度，一条棘轮只能守前者。**
> 本轮的逐项兜底是**行为改进**（全空 → 部分可用 + 指明失败项），
> 而棘轮的语义是"未保护点数只许减少"，所以它测不出这次改进。
> 这不是棘轮的缺陷——它就该只管一件事——而是提醒：
> **改了行为但指标没动时，要能说清"这个指标本来就不度量这件事"**，
> 否则会与 r98 那条"指标没动要先怀疑指标"混淆（那次是判据漏了形态，这次是判据管的维度不同）。
> 两者的分辨办法：把改动前后的判据输出**逐项对比**（本轮就是列出 settings-page 剩下的 8 处
> 具体在哪几个函数），确认它们与本次改动的位置不重叠。

行为改进本身**未做真机验证**（如实）：要构造"部分条目读失败"需要一个内核未装载而其它条目正常的环境，
`kernel-capability-gating` 剧本虽然按内核对照，但它是**播种成功路径**的；
构造失败路径需要新的手段（例如临时移除某个内核插件目录再重载）。记入待办。
已验证的是：tsc + 全量 2209 测试 + `settings-controls-audit` 51（设置页交互全链路未回归）+
`kernel-capability-gating` 27（三内核的模型配置页与扩展页均非空 ⇒ 正常路径未受影响）。

产出：加载链逐项兜底 + 部分失败可见（`loadError` 承载"哪一项: 什么原因"）。
棘轮基线维持 **46**（并在注释里写明"r99 的逐项兜底未使计数下降，原因见 §17.98"，
避免下一轮有人以为改动无效或误把基线调错）。

### 17.99 构造失败路径时，"没有报错"可能是**代码根本没跑**（r100）

想验证 r99 的逐项兜底（一个条目读失败时其它条目照常显示），构造手段是
`chmod 000 <dataRoot>/config/general.json` 再让设置页重新加载。两次尝试都得到
"条目 17 → 17、`loadError` 为空"，看起来像"兜底没生效"。逐个排除后查明两层原因：

**① 第一次：加载链根本没重跑。** 我用"离开设置页 → 再回来"触发重载，
但那个 `useEffect` 的依赖是 `[pluginsNonce, currentCwd]`——两者都没变，组件也没卸载，
所以链没有重跑。改用 `page.reload()` 强制重跑。
> 通则：**构造失败之后，第一步要确认"那段代码真的又执行了一次"**。
> 否则"没有报错"既可能是修复有效、也可能是代码没跑——与 r87 那条
> "构造失败的剧本要先证明失败真的发生了"是同一纪律的两面：
> 那边是证明**失败发生了**，这边是证明**代码跑到了**。

**② 第二次：服务端有配置缓存，`chmod` 之后读取根本不碰磁盘。**
`page.reload()` 只重载 **renderer**，服务端进程不重启；`ConfigStore` 侧的读取命中内存缓存，
于是 `chmod 000` 对运行时读取无效。已单独验证 `chmod 000` 本身是有效的
（非 root 用户 `cat` 得到 `Permission denied`，uid 502），所以不是构造手段的问题。

要让这条路径真的失败，需要在**服务端首次读取之前**就破坏文件（即启动前 chmod），
但那会与 boot 的种子逻辑纠缠（`40-shell-plugins` 在 general.json 不存在时会写种子；
不可读时的行为未知，可能让启动本身失败）——超出本轮预算，记入待办。

> 通则：**"改文件权限/内容"这类构造手段，要先问"目标进程什么时候读它、读几次、有没有缓存"**。
> 前端渲染进程与服务端进程对同一文件的读取时机完全不同；
> 有缓存的一侧，运行期改文件是无效的（这一条对本仓所有 config/prefs/locale 文件都适用）。
> 可用的替代手段：① 启动前就破坏（需确认 boot 不会因此失败）；
> ② 让服务端**主动重读**（例如触发 `pluginsNonce` 变化的插件重载路径，r49 的 kernel-reload 剧本就是这么做的）；
> ③ 换一个**不经缓存**的读取路径做载体。

本轮结论：r99 的逐项兜底**仍未获得真机证据**（如实），已有的证据是
tsc + 全量 2209 测试 + `settings-controls-audit` 51（设置页交互未回归）+
`kernel-capability-gating` 27（三内核正常路径未受影响）。
下一轮的接手点就是上面②：**用插件重载路径触发 `pluginsNonce` 变化**，
让加载链在服务端仍持缓存的情况下重跑——但那样读到的还是缓存，所以真正可行的是①或③。

### 17.100 构造失败前先读**服务端的错误策略**：有些失败被设计成永不外泄（r101）

r100 的两次构造失败后，本轮改成**启动前**就把 `blind-review.json` 设为 `chmod 000`
（挑它是因为全仓只有它同时具备 `saveMode:"framework"` + `configFile`，且不参与 boot 种子逻辑）。
结果：设置页 **17 个条目照常渲染**（说明没有整体崩塌）、页面零报错，但**仍然没有 loadError**。

查服务端才明白：**这个失败根本不可能浮上来**。`src/server/application/config/config-file.ts` 里
有两个读取函数，错误策略**故意不同**：

```ts
/** 读 JSON 文件。不存在/损坏返回空对象。 */
export function readJsonFile(absPath) {
  if (!existsSync(absPath)) return {};
  try { return JSON.parse(readFileSync(absPath, "utf-8")); }
  catch { return {}; }                     // ← 一切读/解析失败都吞掉
}

/** deep 合并前的读取:**区分"不存在"与"损坏"**。
 *  为什么不能直接用 readJsonFile:它把"损坏"和"不存在"都归成 {}——对**只读**是对的(健壮),
 *  但 deep 合并是**读-改-写**:文件损坏时读回 {}、合并后写回,就会把原文件里**其余键整段抹掉**
 *  且无任何告警。…所以这里在写回前先把损坏文件原样备份,让"损坏"这件事可恢复、可见。 */
function readJsonFileForDeepMerge(absPath) { … catch { copyFileSync(absPath, `${absPath}.corrupt-${Date.now()}`); console.warn(…); return {}; } }
```

也就是说：`configFile.get` 走的是 `readJsonFile`，**读失败 = 空配置**，这是有意的健壮性设计
（用户看到的是默认值，而不是一屏错误）；只有"读-改-写"路径才会区分损坏并备份 + warn。

> 通则：**构造失败路径之前，先读一遍目标路径上的错误策略**。
> 有些失败被**设计成永不外泄**（吞掉后回落默认值），此时无论怎么破坏输入都不会产生可观测的失败——
> 继续换手段是白费，正确动作是**换一个不吞错误的载体**。
> 这与 r100 的教训（"先确认代码真的跑了"）是同一条纪律的下一层：
> 先确认代码跑了 → 再确认**这条路径会把失败传出来**。
> 本轮据此确定了下一个载体：`kernelModels[k].readConfig()` / `kernelConfig[k].get()`
> （内核配置源，走的是各自内核的读取实现，不经 `readJsonFile`）。

**顺带一个正面结论**：17 个条目在"某个条目配置文件不可读"时**全部照常渲染**，
说明 r99 的逐项兜底至少没有引入"一处失败拖垮全页"的回归（虽然本轮没能触发它的 catch 分支）。
这个对照本身有价值：**破坏一个输入、观察整体是否仍可用**，是"优雅降级"类改动的最低成本验证。

本轮**无代码改动**（纯验证 + 结论）。全量 262 文件 / 2209 测试、5 项审计 0、tsc 0、构建通过。

### 17.101 三层都吞错误 ⇒ 兜底代码"不可达"，此时该写的是**可达性分析**而不是删掉它（r102）

r101 定下的新载体（内核配置源）也失败：`pi-settings-store.get()` 同样是
`catch { console.warn(…); return {} }`。加上 r101 查明的 `readJsonFile`，结论是：

**设置页加载链上的每一条读取路径都被设计成"失败不抛错、回落空值"**，
所以 r97 的链尾 `.catch` 与 r99 的逐项 try/catch 在当前服务端策略下**实际触发不了**。
r100/r101/r102 三轮的"构造失败"尝试全部得到同一结果（17 个条目照常、`loadError` 为空）——
不是兜底失效，是**失败根本没被传出来**。

**处置不是删掉那两层，而是把可达性分析写进代码注释**（就在 try 之前），内容包括：
① 三条读取路径各自的吞错位置与理由（`config-file.ts` 的 `readJsonFile`、
`pi-settings-store.get()`、`readLayered`）；② 三轮构造尝试的手段与结果；
③ **为什么保留**——它们是防御纵深：`settings.list()` 本身仍可能 reject；
`kernelModels[k].readConfig()` 走各内核自己的实现，未来新增内核不保证吞错；
服务端若哪天把"损坏"改成抛错（那是更好的设计），这两层立刻有用且行为正确；
④ 明确写"**不要**因为触发不了就删掉它们，也不要再花轮次去构造触发"。

> 通则：**当一段错误处理被证明不可达时，正确的产出是"可达性分析 + 保留理由"，不是删除、也不是继续硬触发。**
> 删除会失去防御纵深（而它的成本是几行代码）；继续硬触发是浪费（本轮之前已浪费三轮）。
> 而**把分析写进代码**（不只写进报告）才是真正止损的一步：
> 下一个人读到那段 try 时，第一眼就知道"这里触发不了、为什么、什么时候会有用"，
> 不会重走 r100→r101→r102。这与 r72 删死契约成员**不矛盾**：
> 那里的"死"是**契约声明了一个没人调用的面**（会误导实现者去实现它），
> 这里的"不可达"是**实现里多了一层防御**（不误导任何人，只在需要时生效）。
> 判据：**它会不会让读者对系统行为产生错误预期？** 会 ⇒ 删；不会 ⇒ 注明保留理由。

**顺带浮出一个值得单独立项的设计问题（本轮未做，需要有文档依据再动）**：
配置文件损坏时静默回落 `{}`，对用户意味着"**我的设置好像全没了**"，而界面上没有任何解释；
更糟的是下一次保存会用默认值**覆盖**掉原文件。
`readJsonFileForDeepMerge` 已经认识到这个危险（所以它对损坏文件先备份再 warn），
但**只读路径没有**同样的待遇。可能的方向：只读路径遇到"文件存在但解析失败"时，
也返回一个可区分的信号（而不是 `{}`），让 UI 能说明"配置损坏，已备份到 X"。
> 这属于 §7.6 的"显式降级"范畴，但改它会牵动所有 `configFile.get` 的调用方，
> 需要先确认设计文档的意图（`readJsonFile` 的注释明确写了"对只读是对的(健壮)"，
> 所以这可能是**有意的取舍**而不是疏漏）——**有注释背书的取舍，改之前要先推翻它的理由**。

本轮**无功能代码改动**（只加注释）。全量 262 文件 / 2209 测试、5 项审计 0、tsc 0。

### 17.102 同族函数的错误处理必须一致，最弱的那个就是这条路径的实际行为（r103）

r102 查明"构造失败"这条路当前走不通后，本轮转向不依赖构造的消化：`settings-page` 剩下的 8 处。
查下来发现一个很典型的形态——**同族函数里只有一个没兜底**：

| 函数 | 触发方式 | 错误处理 |
|---|---|---|
| `doSave` | 保存按钮 | `setSaving` + `try/catch(setSaveError)` + `finally` ✅ |
| `doSetGlobal` | 设为全局 | 同上 ✅ |
| **`doClearProject`** | 移除项目覆盖 | **裸 await** ❌ |
| **`doReset`** | 放弃修改（未保存对话框的「放弃并离开」） | **裸 await** ❌ |

`doReset` 的后果最严重：它被 r92 验过的那个对话框按钮调用——
`onClick={async () => { await doReset(); setPendingAction(null); a?.(); }}`。
若 `doReset` 抛错，`setPendingAction(null)` 与后续导航都走不到 ⇒
**对话框永远关不掉、用户被卡在设置页**（与 r80 的 install 卡死同类，只是触发者换成了对话框）。

修法按兄弟函数的形态补齐（`setSaving` + `try/catch(setSaveError)` + `finally`），
`doReset` 则**在函数内部兜住**（而不是让调用方兜），因为调用方那段
`await doReset(); setPendingAction(null); a?.()` 的语义是"无论重置成不成功都要关框并导航"——
把兜底放在被调方，才能让所有调用方都获得这个保证。

⚠ 一个容易写错的细节：**失败时不清 dirty**。`doReset` 成功时才 `setDirties(false)`；
若重读配置失败就把它标成"已保存"，那是**撒谎**（用户的编辑还在内存里、盘上也没变）。
所以 catch 分支只 `setSaveError`，不动 dirty。

> 通则：**同一组用户动作（保存/另存/重置/清除…）的错误处理必须一致**。
> 不一致时，最弱的那个就是这条路径的实际行为，而它通常也是最少被测的那个
> （因为"保存"是主路径、"移除项目覆盖"是角落功能）。
> 审这类代码的有效切入点是**并排读同族函数**，而不是逐个函数孤立地看——
> 孤立地看 `doClearProject` 会觉得"没兜底也不算错"，并排看才看得出它是漏了。

棘轮 **46 → 42**（本轮修掉 4 处：`doClearProject` 1 + `doReset` 3）。
全量 262 文件 / 2209 测试、5 项审计 0、构建通过、`settings-controls-audit` **51**
（其中 r92 那节正好走「放弃并离开」→ `doReset`，所以这条改动是被真机覆盖的）。

### 17.103 i18n 反方向（死键）：先分清"非 t() 消费"，再动手删（r104）

r77 把死键方向推迟了，理由是"动态拼键需要前缀族匹配"。本轮把它做通，方法是
**先把所有消费机制建模，再看剩下什么**，而不是直接拿 `t("…")` 的扫描结果当死键清单。

建模的五类消费方（1719 个键）：
① 静态 `t("key")`（758 个）；② 模板前缀族 `t(\`debug.density.${d}\`)`（14 个前缀）；
③ **完全动态**键 `t(\`${i18nPrefix}.${suffix}\`)` ⇒ 去调用方收集 `i18nPrefix="…"` 的字面量
（得到 `dsh.` / `dshModels.` / `kernel.` / `models.` 四族）；
④ manifest 的 `*Key` 字段（59）+ 派生键前缀（`settings.<id>.` / `sidePanel.<id>.` / `plugin.<id>.`，96 种）；
⑤ `registerChannels` 的 meta `labelKey`/`descriptionKey`（37）。

**一个必须先排除的陷阱**：首版把 ② 的正则写成 `` t\(`([^`$]*)\$\{ ``，
它会把 `t(\`${i18nPrefix}.…\`)` 的前缀匹配成**空字符串**，而空前缀 `startswith("")` 恒真
⇒ `covered()` 对所有键都返回 true ⇒ 报"死键 0 个"。
> 这就是 r59/r67/r76 那条纪律的又一次应验：**判据退化时的"0 违规"毫无意义**，
> 而退化最隐蔽的形态就是"某个匹配模式恰好匹配一切"。
> 防法：把参与判定的**前缀集合打印出来**看一眼（本轮就是这么发现 `''` 混在里面的）。

建模之后仍有 **255** 个键四类都覆盖不到。逐个抽查发现其中**真假混杂**：

| 键族 | 真相 |
|---|---|
| `common.locale.*`（4 个） | **假阳性**：`merge.ts` 的 `collectLocaleList` 直接遍历 `resources[id].common.locale[id]`，**不经 `t()`** |
| `dshExt.*`（13 个） | **真死键**：r58/r63 把按内核分的扩展页统一成 `kernel-extensions-page`（用 `ext.*`）后留下的残渣；`piExt.*` 已经是 0 个 ⇒ 当时只清了 pi 那半 |
| `debug.area.*` / `copyDomTitle` / `simplify` / `areaNotFound`（7 个） | **真死键**：debug-bar 里唯一的动态拼键是 `debug.density.${d}`（已被前缀族覆盖），这几个是"复制区域 DOM"功能退役后的残留 |

> 通则：**死键判定必须建模"非 `t()` 的消费方式"**——直接遍历 resources 对象
> （本轮的 `collectLocaleList`）、把键当数据传（manifest 的 `*Key`）、
> 运行时拼键（前缀族）。只看 `t()` 的扫描会把第一类全部误判成死键。
> 而**删除前的最后一道关**是拿候选键去全仓（含 `.mjs`/`.md` 之外的所有代码）做一次字面量反查：
> 本轮就是这样救回 `debug.copied`（正则把它列进候选，但反查发现仍有引用）——
> **候选清单不等于删除清单**。

删除结果：`dshExt.*` 13 × 4 语言 = 52 条，`debug.*` 7 × 4 = 28 条，**共 80 条**；
四语言键数删后仍严格对齐（各 **1538**）。依据是 r72 的纪律：
**死声明会让读者以为系统还有这个能力**（`dshExt.*` 会让人以为 dsh 有独立的扩展页文案），
而它的成本是四语言的翻译维护。

⚠ **没有把这条做成守卫**（如实）：255 个候选里仍有未逐个核实的部分
（例如 `common.*` 的其余键、`shell.*` 里可能存在的同类结构遍历消费），
按 r77 的纪律——**判据没把握时不交那条守卫**。已建模的五类 + "非 t() 消费"这一类
写进本节，下一轮把剩余候选逐个核实后再交守卫（带账本 + 棘轮）。

产出：删除 80 条死键条目（四语言对齐 1538）。全量 262 文件 / 2209 测试、5 项审计 0、
tsc 0、构建通过、minimal-smoke 28。

### 17.104 我第二次用 `git checkout --` 毁掉前几轮的工作（r105）

本轮交了死键守卫（`src/i18n-dead-keys.test.ts`，5 测：反空转 + 自检 + 棘轮 231 +
"已删死键不得复活"账本 + 四语言键集对齐）。六类消费方建模见 r104/守卫文件头。
反向注入两处都正确变红（注入一个新死键 ⇒ ② 报"从 231 涨到 232"且 ④ 报四语言不齐；
复活 `dshExt.title` ⇒ ③ 报"已删除的死键又回来了"）。

**然后我在还原注入时用了 `git checkout -- src/plugins/kernels/dsh/locales/zh-CN/dsh.json`。**

这正是 r76 写下铁律禁止的动作（「**永远不要** `git checkout --` 一个前几轮改过的文件；
本仓累积着大量未提交的工作」），我第二次犯了。损伤面比想象的大——它回退的不是我注入的那一个键，
而是**该文件的所有后续修改**：

| 损伤 | 发现它的守卫 |
|---|---|
| 丢了 r91 的 `dsh.routeEmptyModels` / `dsh.routeEmptyModelId` | `dsh-config-source.test.ts`（r91 改成真字典断言，查不到键就抛） |
| 恢复了 r104 删掉的 13 个 `dshExt.*` 死键 | 本轮新守卫的 ③（"已删死键不得复活"） |
| 丢了早期轮次的 `dsh.extTitle` / `dshModels.devRoleHint` / `dshModels.devRoleIncompatible` / `settings.dsh-ext` / `settings.dsh-models` | `locale-parity` + 本轮 ④（四语言键集对齐） |
| 把已修的旧术语「底座」退回文案里 | `locale-terminology` |

**四条守卫各自抓到了损伤的一面，合起来把损伤范围完整框出来了**——这是"守卫网"最值的一次体现：
如果只有其中一条，我会以为"补回那两个键就好了"，而实际上还丢了 5 个键、退回了 1 处术语。

> 通则（强化 r76 那条铁律）：**还原注入只能用"本轮自己的备份 + 逐字/语义比对"**，
> 绝不能用任何 VCS 回退命令。本仓的工作方式是长周期累积未提交改动，
> `git checkout --`/`git stash`/`git reset` 在这个仓库里的语义是"删掉若干轮的工作"，
> 而不是"撤销我刚才那次注入"。
> 修复步骤也应记下来（可复用）：① 用**其它语言的键集**当基准做差集，找出丢了哪些键；
> ② 从 zh-TW 取值转简体补回（术语按 zh-CN 惯例：相容→兼容、預設→默认、擴充→扩展、核心→内核）；
> ③ 删掉被带回来的死键；④ 跑**全部**语言相关守卫（parity / terminology / kernel-identity /
> 派生标签四语齐全 / 死键）而不是一条，因为损伤是跨维度的。

**又一次自检样本凭空造**（r72 同款、本项目第二次）：①那条断言我写了 `debug.density.compact`，
实际语言包里是 `smart` / `structure` / `all`；改对后又手滑写成 `.loose`（也不存在）。
守卫自己的报错文案救了我：「自检样本不在语言包里（样本必须来自实测分布，不能凭空造）」。
> **把纪律写进断言的失败文案里，它就会在下一次犯错时自己提醒你**——
> 这比写进 skill 更有效，因为它出现在你正要看的那一行。

产出：死键守卫（5 测，棘轮基线 **231**）+ 修复 `git checkout` 造成的 6 键缺失 / 13 死键复活 / 1 处术语退回。
全量 **263 文件 / 2214 测试**、5 项审计 0、tsc 0、构建通过、kernel-capability-gating 27。

### 17.105 先建还原点，再继续冒险；以及"死键"的第七类消费方（r106）

**第一件事是补上 r105 暴露的流程缺口**：把 r1–r105 的累积工作落一个**本地提交**作为还原点
（`chore(checkpoint)`，**不 push**，符合任务纪律第 5 条）。提交前按 §5.3 的仓库卫生核过：
未跟踪文件最大是 252KB 的设计文档，无 `.log` / `tmp/` / `.DS_Store` / 用户数据目录，
`.gitignore` 已覆盖 `out/`、`dist/`、`.my-harness-desktop/`、`.pi-desktop/`。

**然后验证这个还原点真的能用**（r105 缺的正是这一步）：注入"加一个键 + 删一个 r91 的键"
⇒ 守卫 2 条变红 ⇒ `git checkout -- <file>` ⇒ 与注入前**语义完全一致**
（`__restore_probe__` 消失、`dsh.routeEmptyModels` 回来）⇒ 守卫复绿 5/5。
> 关键差别：现在 `git checkout --` 还原到的是**本轮基线**，而不是某个古老提交。
> r105 那次之所以毁掉多轮工作，不是因为用了 `git checkout`，而是因为**当时没有还原点**。
> 所以正确的纪律不是"永远不用 VCS 回退"，而是：
> **① 每轮（或每个风险动作前）先有还原点；② 有了还原点之后，VCS 回退才是安全的还原手段。**
> 只写"禁止 git checkout"而不建还原点，等于让人用更脆弱的方式（手工备份单个文件）还原，
> 而手工备份恰恰容易漏（r105 我只备份了注入的那一个文件，损伤却在同一个文件的其它键上）。

**第二件事：死键判据补上第七类消费方。** r105 交了 231 的棘轮基线，本轮按族分布一看就发现
一批明显的假阳性——`ext.toggleFailed` / `ext.restartFailed` 是**我 r86 自己加的**，
它们经 `runGuarded(t, op, "ext.toggleFailed")` 传进去、再在函数里 `t(failKey, …)`，
所以键的字面量**不在 `t(` 的紧邻位置**，① 那条正则抓不到。同族还有
`minimal.customCli` / `probe4.customCli` 各 13 个（经内核的 `fields()` 机制以数据形式传键）。

补第七类：收集语料里所有"含点"的字符串字面量（**精确值**，不做前缀匹配）。
> ⚠ 必须是精确值：如果做成前缀匹配，又会退化成"匹配一切"（r104 的空前缀教训）。

结果：死键候选 **231 → 190**（41 个假阳性消除），棘轮基线下调到 190。

> 通则：**"死 X"类判据的消费方建模是渐进的，每消除一批假阳性就要重量基线**。
> 有效的推进方式不是"一次想全所有消费方式"，而是
> **按族看分布 → 挑一个自己认识的族 → 查清它为什么被误判 → 补进模型 → 重量**。
> 本轮就是这么发现第七类的：看到自己上一轮亲手加的键出现在死键清单里，
> 立刻就知道判据漏了一类（**自己的改动是最好的判据试金石**）。

产出：本地还原点提交 + 还原点可用性验证 + 死键判据第七类（棘轮 231 → **190**）。
全量 263 文件 / 2214 测试、5 项审计 0、tsc 0、构建通过。

### 17.106 第八类消费方：键当**运行时数据**传，字段名不带 Key 后缀（r107）

按 r106 的"按族推进"继续核实 190 个候选。两族结果不同，正好展示两种判定路径：

**① `common.clear` / `default` / `delete` / `send`（4 个）⇒ 真死键，删。**
判定依据：全仓字面量反查（含 `.ts`/`.tsx`/`.mjs`，排除测试与语言包）**0 处命中**；
而同族的 `common.refresh` / `common.on` / `common.off` 都有 `t("common.…")` 的直接引用——
**同族里有的在用、有的没在用**，说明这不是"整族被动态消费"，而是这四个被后来的
按插件专属键取代后忘了删。删除 4 × 4 语言 = **16 条**。

**② `theme.json` 的 `dark` / `light` / `auto` ⇒ 假阳性，补第八类模型。**
追查路径：`theme-manager` 的 `TABS` 用的是 `settings.*`（不是这三个键）⇒
继续找 ⇒ `theme-tab.tsx:28` 是

```tsx
label={opt.name.includes(".") ? t(opt.name, { defaultValue: opt.name }) : opt.name}
```

即**主题名在运行时被当键查**，而 `opt.name` 来自主题贡献的 `name` 字段（值形如 `theme.dark`）。
所以键是当**数据**传的，但字段名**不带 `Key` 后缀** ⇒ ④（manifest `*Key`）抓不到。

补第八类：收集 manifest 里**任何**含点的字符串值（不只 `*Key` 字段）。
⚠ 还有一个容易漏的细节：**语言包里有两种键形态**——带 ns 前缀的扁平键（`shell.cancel`）
与**裸键**（`theme.json` 里的 `dark`，ns 由文件名给出）。所以两个形态都要登记：
完整值（`theme.dark`）与 ns 剥离后的尾键（`dark`），否则裸键永远匹配不上。

> 通则：**"键当数据传"这一大类里，字段名约定（`*Key`）只是其中一种形态**。
> 任何"把字符串交给 `t()` 去查"的地方都算消费方，而那个字符串可能来自
> manifest 的任意字段（`name` / `title` / `label`…）、配置文件、甚至服务端返回的数据。
> 建模时宁可**放宽到"任何含点的字符串值"**，也不要只认字段名——
> 放宽的代价是可能漏报几个真死键（可由人工核实兜住），
> 只认字段名的代价是**批量误报**（会诱导人删掉还在用的文案，不可逆）。
> **在"删错"与"漏删"之间，永远选漏删。**

结果：死键候选 **190 → 186**（删 4 个真死键；第八类消除的是潜在误报，
本轮数字上没再降，因为 `theme.*` 那三个此前已被第七类的字面量扫描间接覆盖）。
棘轮基线下调到 186。

**流程**：本轮末尾同样落了本地提交（r106 起的新纪律：每轮一个还原点，不 push）。
全量 263 文件 / 2214 测试、5 项审计 0、tsc 0、构建通过、minimal-smoke 28。

### 17.107 两侧语料范围不一致 = 160 个假阳性（r108）

r107 点名的下一批是 `minimal.customCli` / `probe4.customCli` 各 13 个。查它们的消费方时发现：
两个测试内核的 renderer **确实**在用——`<KernelVersionPage api={ctx.kernels.minimal} i18nPrefix="minimal" />`，
经 `kernel-version-page.tsx` 的 `t(\`${i18nPrefix}.customCli.${suffix}\`)` 两级动态键消费。
那为什么被判成死键？因为它们在 **`test-plugins/`** 下，而守卫的**代码语料只扫
`src/*` 与 `packages/*`**——可**语言包侧 `localeKeys()` 两个根都扫**。

**语料不对称 ⇒ 系统性假阳性**。补上 `test-plugins` 后：死键候选 **186 → 26**，
也就是说此前 **160 个候选是假的**（占 86%）。

> 通则：**双侧对账类判据（A 侧的声明 vs B 侧的引用），两侧语料范围必须对称**，
> 而"对称"要**按根断言**、不能只看总量。本轮补的断言就是
> `expect(cf.some((f) => f.includes("/test-plugins/")))`——
> 因为漏掉一整根时总数仍 >400，光看规模断言什么也发现不了。
> 这是 r67/r76 那条"任何计数都要报语料基数"的升级版：
> **不仅报基数，还要报"哪些根在里面"**。

**顺带写断言时又踩一个坑**：`codeFiles()` 返回的是**绝对路径**（`join(ROOT, base)`），
所以判归属要用 `includes("/test-plugins/")` 而不是 `startsWith("test-plugins/")`——
首版写了 `startsWith`，恒假，于是"按根断言"自己成了假红
（而前缀其实已经收进来了、计数已经降到 26）。
> **假红比假绿更容易被发现，但同样浪费一轮**；写路径归属断言前先确认路径是绝对还是相对。

**另一处重要更正（r104 的人工核查错了）**：`debug.copied` 在 r104 被"全仓字面量反查"救回，
理由是"仍有引用"。本轮查明那次反查是**子串匹配**，命中的其实是 `debug.copiedElement`
（另一个键）。守卫的第⑦类用**精确字面量**匹配，所以它报 `debug.copied` 是死键**是对的**。
> 通则：**人工反查要用精确匹配（带引号/带边界），子串匹配会造出"仍在用"的假象**。
> 而这类假象的后果是**保留死键**（相对无害），所以它比反向错误（误删在用键）容易被人忽略——
> 但正因如此，人工核查的结论不该长期压在守卫之上：**能让机器精确判的，就不要靠人工子串搜**。

**本轮不删任何键**（如实）：26 个候选仍需逐个核实，r104 的纪律是
**候选清单不等于删除清单**。已抽查到的线索（供下一轮）：
`pluginManager.pageNext/pagePrev` 与在用的 `shell.pagePrev/pageNext` 重复（疑似放错命名空间）；
`pluginManager.title` 全仓 0 命中；`stats.*` 6 个需查是否有动态前缀消费；
`auto`/`dark`/`light` 是 `theme.json` 的裸键（r107 已查明经 `t(opt.name)` 消费，
需确认为何第⑧类的"ns 剥离尾键"没覆盖到——可能主题 manifest 的 `name` 值不是 `theme.dark` 形态）。

产出：语料补 `test-plugins` + 按根断言 + 棘轮 **186 → 26**。
全量 263 文件 / 2214 测试、5 项审计 0、tsc 0、构建通过。

### 17.108 死键清零：从 231 到 0，以及"还原点"纪律的第二次应验（r109）

把 r108 留下的 26 个候选逐个核实完，全部确认无消费方后删除（26 × 4 语言 = **104 条**），
四语言键数删后仍严格对齐（各 **1674**）。守卫的 ② 从"≤N 棘轮"翻成**"必须为空"**
（仿 r83 对 todo 的做法：清零是进展、不是判据失效；将来若出现第九类消费方式，
正确处置是**先把新消费方式补进模型**，而不是把断言改回 ≤N）。

**四轮把 231 降到 0 的路径**（每一轮都是"消除一批假阳性"或"删一批真死键"）：

| 轮 | 动作 | 候选数 |
|---|---|---|
| r105 | 建模六类消费方 + 删 80 条真死键（`dshExt.*` / `debug.area.*` 等） | 231 |
| r106 | 补第七类（键作变量/常量传递，精确字面量） | 190 |
| r107 | 补第八类（manifest 任意含点字符串值 + ns 剥离尾键）+ 删 4 个真死键 | 186 |
| r108 | **语料补 `test-plugins`**（两侧对称）⇒ 消除 160 个假阳性 | 26 |
| r109 | 逐个核实 26 个 ⇒ 全为真死键 ⇒ 删 104 条 | **0** |

> 值得记的比例：**231 个初始候选里，真死键只有 100 个（80+4+…+26=110 条键、含四语言共 200 条条目），
> 其余 131 个是判据不全造成的假阳性**（57%）。
> 如果 r105 当时直接按候选清单删，会删掉 131 个**在用**的文案——
> 运行时表现为大量裸键/回落英文，而且是**分散在各处**的，极难定位。
> 这就是 r107 那条"在删错与漏删之间永远选漏删"的量化后果。

**核实方法**（可复用）：对每个候选做两种搜索——
① **精确匹配**（带引号的完整键字符串，语料含 `.ts`/`.tsx`/`.mjs` **与 manifest**）；
② **动态前缀匹配**（`ns.${` 或 `ns.<首段>.${` 形态）。
两者皆无 ⇒ 无消费方。⚠ 不能用子串匹配：r104 就是这样把 `debug.copied`
误判成"仍在用"（实际命中的是 `debug.copiedElement`），本轮已更正并删除。

**"还原点"纪律的第二次应验（本轮又踩了一次，形态不同）**：
反向验证 ② 时我注入一个死键、然后用 `git checkout -- <debug.json>` 还原——
结果还原到的是 **r108 的提交态**，而本轮删掉的 `debug.copied` **还没提交**，
于是它被带回来了，② 继续红。
> r106 的结论是"先有还原点、VCS 回退才安全"，本轮补上它的**边界条件**：
> **还原点只保护到"上一次提交"为止；本轮未提交的改动，VCS 回退同样会毁掉。**
> 所以纪律要写成：**① 每轮开头（或做完一批改动后）先提交；② 反向注入前，
> 若本轮已有未提交改动，就先提交再注入**——这样 `git checkout --` 才真的只撤销注入。
> 本轮的处置：重新删掉被带回来的键 + 复核"本轮已删键是否还有其它被带回来的"（0 个）
> + 复核四语言键数（1674 对齐）。

产出：删 104 条死键、② 翻成"必须为空"、守卫 5/5。
全量 263 文件 / 2214 测试、5 项审计 0、tsc 0、构建通过、minimal-smoke 28。

### 17.109 把"死声明"方法推到 CSS 变量：三类消费方在语料之外（r110）

r76 做的是正方向（用了但没定义 ⇒ 27 处修正）。本轮做反方向（定义了但没人用），
初测 **22 个候选**（语料 470 个 css/ts/tsx 文件、109 个定义、163 个使用）。
按 r109 的纪律逐个核实，结果**只有 3 个是真死**，其余 19 个的消费方都在语料之外：

| 候选族 | 数量 | 真实消费方 |
|---|---|---|
| `--rct-*` | 16 | **第三方库** `node_modules/react-complex-tree/lib/style.css`——我们的 `file-tree.css` 定义它们是为了给这个库换肤（库自己 `var(--rct-item-height)`） |
| `--text-sm/base/lg/xs` | 4 | **构建工具**：`--text-sm: var(--font-size-sm)` 是 Tailwind v4 的主题变量，构建期被读走生成 `text-sm` 工具类 |
| `--motion-duration-slow`、`--sidepanel-header-bg-hover`、`--sidepanel-icon-btn-bg-hover` | 3 | **无**——全仓 `var(...)` 引用 0 处，也没有 Tailwind 任意值形态（`bg-[var(--x)]` 会含字面量名，grep 会命中）⇒ 真死 |

真死的三个还有个特征：`--sidepanel-*-hover` 在 **3 个主题块里各定义了一次**
（408/516/562 行，值分别是 `var(--color-surface)` / `transparent` / `transparent`）——
说明它是某次"给侧栏头部加 hover 态"的改动只写了 token、没写消费它的样式，
然后被后续主题块照抄。**token 定义比消费代码更容易被复制粘贴**，
所以死 token 往往成族出现在多个主题块里（这也是为什么删掉的是 9 行而不是 3 行）。

删除 9 行；构建通过、r76 的 `css-var-definitions` 守卫仍 4/4、
a11y-names-audit 12、settings-controls-audit 51（无视觉/交互回归）。

> 通则（把 r107/r109 的 i18n 经验推广）：**"死声明"普查的难点从来不是扫描，而是
> "消费方可能在你扫不到的地方"**。已实测到的四类语料外消费方：
> ① **第三方库**读你定义的自定义属性（`--rct-*`）；
> ② **构建工具**读主题变量生成工具类（Tailwind 的 `--text-*`）；
> ③ **运行时数据**定义（主题插件的 `"color.primary": "#ececec"` ⇒ 运行时变成 `--color-primary`，
>    所以 CSS 文件里"没有定义"不等于"没定义"）；
> ④ **动态拼名**（`var(--color-${kind})`）。
> 前三类都会让"未定义"与"未使用"两个方向同时产生大量假象：
> 本轮初测还报"使用了但未定义 76 个"，其中绝大多数正是 ③（主题 token 当数据定义）
> 与 CLI 参数名（`--agent-dir` 这类被 `"--x"` 字符串正则误捕）。
> **所以这个方向本轮不交守卫**——按 r77 的纪律，判据没把握就不交；
> 已查明的四类语料外消费方写进本节，等把 ③④ 建模后再交（与死键守卫同款：账本 + 断言必须为空）。

**一个方法上的细节值得记**：判断"某个 CSS 变量真死"时，除了 `var(--x)`，
还要查 **Tailwind 任意值形态** `bg-[var(--x)]` / `text-[var(--x)]`——
它把变量名写在 class 字符串里。好在这种形态**包含变量名字面量**，
所以用变量名做一次全仓 `grep -F` 就能同时覆盖两种形态（本轮就是这么确认的）。
> 通则：**查"某个标识符有没有被用"时，用标识符本身做全仓精确搜索，
> 比枚举所有可能的使用语法更可靠**——语法形态会随框架/构建工具演化，标识符不会。

### 17.110 纪律写在 skill 里就会被违反：锚点消费方对账（r111）

r92 定过一条纪律：**加锚点的那一轮就要有剧本用它**（没人用的锚点会腐烂，且腐烂时无信号）。
但它只写在 skill 里、没有守卫，于是**被我自己违反了**：r111 实测发现 **8 个 `data-*` 锚点
发出后从未被任何测试/剧本消费**，其中两个是我亲手加的——
r97 的 `data-settings-load-error`、r61 的 `data-toast-kind`。

本轮把它变成机器可判：`src/data-anchor-consumers.test.ts`（4 测）对账
"生产代码发出的锚点" ⇔ "测试/e2e 剧本消费的锚点"，账本外死锚点必须为 0，
账本内 8 条各写明 `why`（为什么当轮用不上）与 `next`（该怎么补），棘轮基线 8。

> 通则：**写在文档/skill 里的纪律，只要没有守卫，就会被违反——而且违反者往往就是定它的人**。
> 判据是：如果一条纪律的违反**不产生任何信号**（死锚点不会报错、不会测试失败），
> 那它就一定会被违反。§3.7 那句话在这里的具体形态是：
> **纪律本身也需要守卫**，不只是"修复需要守卫"。

**这个方向适合交守卫，而 CSS 变量方向不适合**（对照 §17.109），差别在**语料是否封闭**：
锚点的发出方与消费方都在仓库内且可枚举；CSS 变量有三类语料外消费方
（第三方库 / 构建工具 / 运行时数据）。
> 判据：**做"死声明"普查前，先问"消费方会不会在我扫不到的地方"**——
> 会 ⇒ 先建模或先不交守卫；不会 ⇒ 可以交。

**两个判据坑（都已写进守卫注释）：**

**① JSX 裸属性形态必须覆盖。** 首版正则只认 `data-x` 后跟 `=`/`:`/`{`，
而 `ask-question-card.tsx` 里是 `data-ask-question` 后面**直接换行**（不带 `=`）⇒
发出侧少算 21 种（70 → 91），反方向还因此报出 `data-ask-question` 这种假阳性。
与 r73（泛型里的 `>`）、r85（`fn: () => Promise<…>` 里的 `)`）同类：
**判据的分隔符集合必须覆盖真实代码的所有形态，漏一种就批量错**。

**② 对账类守卫的两侧语料必须互斥，尤其要排除守卫自己。** 首版把消费方语料取成
所有 `*.test.ts`，而**守卫自己的账本里逐条写着那 8 个死锚点的名字** ⇒
自指让它们全算"已被消费" ⇒ `dead` 恒为 0、守卫彻底失效（实测 ②③ 同时红，
报"账本里这些锚点已经有消费方了"）。
> 通则：**任何"标识符对账"守卫都要检查自己是否在消费方语料里**——
> 它天然是"引用了所有被对账标识符"的那个文件。同类陷阱：i18n 死键守卫若把
> 自己的样本清单算进消费方，也会自证清白。

**顺带修掉一个空探针**（反方向抽查时发现的真缺陷）：`settings-controls-audit` 里
查 `[data-settings-id][data-active]` 与 `[aria-current]`，但设置页条目**从来不带这两个属性**
（r89 的诊断早就显示"当前激活=(无显式激活标记)"）⇒ 选择器永不匹配、日志恒打印 null，
看着像"产品没给激活标记"，实际是探针查错了属性。已改用 r93 补在**内容面板**上的
`data-settings-pane-active`（条目行本身没有激活态语义）。
> **空探针比没有探针更糟**：它会在日志里持续输出一个"看起来在验"的值，
> 让人以为这一维已经覆盖了（r89 那次误诊的一部分成因就是它）。

反向注入已验（**先提交、再注入**，r109 的纪律）：生产代码里加一个无人消费的锚点 ⇒
② 报"1 个 data-* 锚点发出后没有任何测试/剧本消费，且不在账本里"、③ 报"涨到了 9"；
`git checkout --` 还原干净（这次安全，因为注入前已提交）。

产出：锚点消费方对账守卫（4 测 + 8 条账本）+ 空探针修复。
全量 **264 文件 / 2218 测试**、5 项审计 0、tsc 0、构建通过、settings-controls-audit 51。

### 17.111 空探针普查：修掉一个恒空的审计维度，代价是它立刻变吵（r112）

把 r111 发现的"空探针"推广成普查：扫所有剧本/测试里的**属性选择器**，
反查它们选中的 `data-*` 在生产代码里是否真的发出。实测 12 种引用了不存在的属性，其中两个是真问题：

**① `scripts/demo/dom-audit.e2e.mjs` 的 ③「空壳容器」维度恒为空。**
它写死 `querySelectorAll("[data-section], [data-panel]")`，而生产代码**这两个属性一个都不发**
（91 种 `data-*` 里没有）⇒ 选择器恒匹配空集 ⇒ `emptyAnchored` **永远是 `[]`**，
输出看着像"没有空壳容器"，实际是"根本没扫"。

修法不是再换两个锚点（下次锚点演化又会变空集），而是**扫所有带 `data-` 前缀属性的元素**——
这一维的语义本来就是"任何锚点元素都不该是空壳"，与具体锚点名无关。

**修好之后它立刻报了 49 条**。逐条看发现多数是**设计上就该为空**的族，于是加白名单（每条写明理由）：
`data-toast-live-region`（常驻 live region **宿主**，r37 的设计：宿主先于内容存在才能播报瞬时内容，
空的时候正是它待命的正常态）、`data-resize-handle`（拖拽把手，视觉靠 CSS）、
`data-panel-group-*`（布局库的包装层，内容由库运行时填）。加完降到 **33 条**，
剩下的仍需逐族甄别（例如 `data-kernel-custom-dir` 在未设自定义目录时本就为空——
那是**条件挂载点**，不是空壳）。

> 通则：**把空探针修成"真的在扫"之后，第一件事是给它加"设计上就该如此"的白名单**，
> 否则它会一次性倒出几十条噪音，而下一个人会直接把这一维关掉（比空探针更糟）。
> 白名单每条必须写**为什么空是语义**（与 r68/r79/r105/r111 的账本同款纪律：
> 不是豁免，是"已知合法"的一格）。
> 顺序也很重要：**先让它非空、再让它安静**——反过来（先加白名单再修扫描）会白名单写在猜测上。

**② 一条守卫的注释与它的实际能力不符。** `dom-audit` 里那段注释声称
"`src/e2e-anchor-coverage.test.ts` 会把 e2e 脚本里出现、而 `src/` 中不存在的 `data-*` 全部列为失败"
——但 `[data-section]` / `[data-panel]` **没有被它抓住**。所以那条守卫的判据有漏
（可能只核对 §2 锚点表里登记的、而不是脚本里出现的全部）。已记入待办：
> **守卫注释里写的"它会抓住 X"是一种断言，要实测过一次才算数**。
> 没实测过的注释比没有注释更危险——它让人以为这一维已被覆盖（本轮就是这样被误导的：
> 我一开始以为 ③ 那一维是有效的，因为注释说有守卫兜着）。

**③ 附带发现**：`scripts/e2e-inmem.mjs` **不在 npm scripts 里**（孤儿脚本），
且引用了 4 个不存在的属性（`data-testid` / `data-virtuoso-scroller` / `data-viewport-type` 等）
⇒ 它是遗留物，跑起来必然失败或空跑。已记入待办（删或修，需要先确认它是否还被文档引用）。

**过程失误（如实记，同类第三次）**：往 `page.evaluate(...)` 的**模板字符串**里插注释时，
注释中写了反引号（`` `[data-section], [data-panel]` `` 与 `` `emptyAnchored` ``）⇒
**反引号把模板串提前闭合**，后面的中文变成真 JS ⇒ `SyntaxError: Invalid destructuring assignment target`
（报在注释那一行，看上去莫名其妙）。分两次才清干净（第一次只去了一个）。
> 通则：**往模板字符串/`evaluate` 回调里插注释，注释里不能有反引号**；
> 更稳的做法是插完立刻 `node --check`（本轮就是靠它发现的），
> 而且报错行指向注释时，第一反应该是"我这段注释里有没有会终止外层字符串的字符"。
> 这与 r57 的索引切片、r82 的正则插错位置、r84 的多行 import 中间插入同一族：
> **凡是用字符串替换往代码里插内容，插完立刻做语法检查**。

产出：dom-audit ③ 从恒空变成真扫（+ 三族白名单，49 → 33）。
全量 264 文件 / 2218 测试、5 项审计 0、构建通过、dom-audit 12 项断言通过（33 条 M 级待甄别）。

### 17.112 守卫"声称的能力"要用反向注入实测过才算数（r113）

r112 发现 `e2e-anchor-coverage` 的注释声称"e2e 不该依赖想象中的锚点"，
但它放过了 `dom-audit` 里两个想象出来的锚点。本轮查根因并修：

**根因是判据太宽**：`anchorsInSource()` 用 `/data-[a-z0-9-]+/g` 扫 `src`+`packages` 的
**所有** `.ts/.tsx`——也就是**注释里、测试文件里、字符串里出现过就算"源码里存在"**。
于是 `data-section` / `data-panel` 因为在某处注释中被提到而蒙混过关。

收紧成与 `data-anchor-consumers`（r111）发出侧**同款判据**：只看生产代码（排除 `*.test.ts(x)`）、
**剥掉块注释与整行注释**、只认**属性位置**（`data-x` 后跟 `= : { " ' \` ) / >` 空白或行尾，
覆盖 JSX 裸属性形态），并把 `test-plugins` 纳入语料。

**收紧后立刻抓到 2 个**，而这两个的处置正好覆盖了两种典型情形：

| 抓到 | 真相 | 处置 |
|---|---|---|
| `data-active` | 来自**我 r112 写的注释**（那段注释引用了旧选择器 `[data-settings-id][data-active]` 来说明修了什么） | **e2e 侧也要剥注释**（两侧对称，r108 的教训）⇒ 消失 |
| `data-panel` | 由**第三方库** `react-resizable-panels` 的 `<Panel>` 发出（`sidebar.test.tsx` 有实测断言 `length === 2`） | 登记进 `LIBRARY_EMITTED` 账本（写明库名）+ 腐烂检查 |

> 两条通则：
> **① 判据两侧必须对称到"剥注释"这一层。** r108 说的是"语料范围对称"，本轮补上更细的一层：
> **连"要不要剥注释"也要对称**。发出侧剥了、消费侧没剥，于是**记录修复过程的注释**
> 被当成了探针——这是最讽刺的一类假阳性：注释的内容正是"这个锚点已经不存在了"。
> **② "发出方在语料之外"要用账本显式登记，不能靠放宽判据。**
> 库发出的属性（`data-panel` 族）天然不在仓库里，与 r110 的 CSS 变量同一类；
> 正确做法是登记 + 写明库名 + 加腐烂检查（哪天我们自己也开始发这个属性，条目就该删）。

**验证**：反向注入一个想象锚点（`[data-r113-imaginary]`）⇒ 守卫立刻红并点名它；
还原后 4/4 复绿。**这一步是 r112 那条教训的落实**：
> 守卫注释里写的"它会抓住 X"是一种**断言**，要用反向注入实测过一次才算数。
> 本轮修完就立刻注入了一个想象锚点——如果没抓出来，说明判据还是松的。
> （首版就是没做过这一步，所以注释里那句话一直是**未被验证的承诺**。）

产出：判据收紧（两侧剥注释 + 属性位置 + 生产代码）+ `LIBRARY_EMITTED` 账本 4 条 + 腐烂检查。
全量 264 文件 / 2218 测试、5 项审计 0、tsc 0、构建通过。

### 17.113 "先非空、再安静"的下半场：把噪音甄别成白名单，再把这一维变成断言（r114）

r112 把 `dom-audit` 的「空壳容器」维度从恒空修成真的在扫，代价是它一次倒出 49 条。
本轮做下半场：甄别 → 白名单 → **升级成断言**。

**甄别结果**：49 → 33（r112 加了三族白名单）→ **0**（本轮补齐）。33 条的实际构成
（靠"打印完整属性名列表"才看清——此前 80 字符截断，看不出元素还带了哪个属性）：

| 族 | 数量 | 为什么空是语义 |
|---|---|---|
| panel-group 的拖拽把手 | 6 | 同时带 `data-resize-handle` + `data-panel-resize-handle-enabled/-id` + `data-resize-handle-state`（都是 react-resizable-panels 发的）；视觉靠 CSS |
| `data-kernel-custom-dir` | 3 | **条件挂载点**：未设自定义内核目录时本就为空 |
| `data-timeline-composer` | 1 | 零会话基线下时间线无内容 ⇒ 容器为空是正常态 |

**一个判据细节决定了成败**：白名单的判据是"**全部** `data-*` 都命中才排除"
（因为一个元素可能同时带库发出的布局属性与我们自己的语义属性，只要有一个不属于
"设计上就该空"的族，它就仍然值得被审）。所以**白名单必须按前缀族列全**——
r112 只写了 `data-resize-handle` 与 `data-panel-group-`，漏了 `data-panel-resize-handle-`
与 `data-resize-handle-state`，于是那 6 个把手一个都漏不掉。
> 通则：**"全部命中才排除"这类判据，白名单的完整性直接决定它有没有用**；
> 而漏一个前缀的症状是"白名单加了但数字没降"（与 r97/r98 那条"指标没动先怀疑指标"同款）。
> 排查办法：把被排除/未被排除的**完整属性名列表**打出来看，不要看截断后的摘要。

**升级成断言**，并且断言要放在 `auditSurface(label)` **内部**：
该函数对每个被审界面各调一次，放外层只能覆盖最后一次调用的结果
（首版就放错了作用域，直接 `ReferenceError: r is not defined`）。
移进去之后断言数从 12 涨到 **28（zh-CN）/ 29（en）**——
> 这个数字变化本身是个信号：**把一个"只打印"的维度变成断言时，
> 断言数应该按被审对象的个数增长**（这里是每个界面一条）。
> 如果只加了 1 条，说明断言写在了循环外面，只覆盖了最后一个对象。

反向注入已验：摘掉 `data-kernel-custom-dir` 那条白名单 ⇒ 某界面报出
"有 1 个带 data-* 锚点的元素既无子元素也无文本"并点名 `<DIV> data-kernel-custom-dir`；
还原（逐字一致）后复绿 28 项。

> **"恒空 + 只打印"是最坏的组合**：它既没在验，也不会因为没在验而报错。
> 修好之后必须**升级成断言**，否则下一个人只会看到"审计发现 0 条"而以为一切正常。
> 完整的修复顺序是：**恒空 → 真的在扫（会吵）→ 甄别成带理由的白名单（安静）→ 升级成断言（守住）**。
> 四步少一步都不行：跳过第二步会得到假安静，跳过第三步会得到没人看的噪音，
> 跳过第四步会得到"修好了但守不住"。

产出：白名单补齐（6 族，每条带理由）+ 断言化（12 → 28/29）+ 完整属性名打印。
全量 264 文件 / 2218 测试、5 项审计 0、构建通过、dom-audit 双语言 0 发现。

### 17.114 查可访问性时只搜 ARIA 属性，会漏掉"组件形态"的语义（r115）

本轮想消化 r111 锚点账本里最便宜的两条，先查它们的实际发出形态，结果**推翻了我自己的一个判断**：

**判断（错）**：`data-toast-kind` 由 timeline 的 toast 发出，而我在 timeline 的 renderer 里
`grep "aria-live|role=\"status\"|role=\"alert\""` **一处都没有** ⇒ 结论"timeline 的瞬时提示
读屏完全听不到，是 a11y 缺口"。

**真相**：往上看几行就有

```tsx
{toast && (
  <div key={toast.key} style={toastStyle(toast.kind)} data-toast-kind={toast.kind}>
    …
    <Announce message={toast.text} variant={toast.kind} />   // ← 可访问孪生在这
  </div>
)}
```

`Announce` 是 `packages/react` 的组件（r59 的成果），**live region 语义在它内部**，
所以在消费方文件里搜 ARIA 属性必然搜不到。

> 通则：**查"某处有没有可访问性语义"时，只搜 ARIA 属性是不充分的**——
> 本仓（以及任何有组件库的项目）大量语义是**由组件承载**的：
> `<Announce>`（live region）、`<CollapsibleCardHeader>`（r57：`aria-expanded`/`aria-controls`）、
> `<Button>`（r40：透传 `data-*` 与 `aria-*`）、`<ExecutionStatus>`（统一 `data-exec-status`）。
> 正确的查法是两步：**① 搜 ARIA 属性；② 搜该处渲染了哪些自有组件，再去组件实现里看语义**。
> 只做第①步会得出"缺语义"的假缺陷——而假缺陷比漏报更费时间
> （本轮我差一点就去给 timeline 的容器贴 `aria-live`，那会造成**第二个 live region**、
> 与 `Announce` 重复播报，把一个不存在的问题修成一个真问题）。

**顺带查明两件事**（都记进账本，避免下轮重查）：

1. `data-toast-kind` 与 `announceTransient` 是**两套并行的瞬时提示机制**：
   前者是插件自己的视觉 toast（带 `data-toast-kind` 标严重级，可访问性由同处的 `<Announce>` 承担），
   后者是壳的常驻 live region 宿主里的命令式播报（r82）。
   所以 r94 的 `write-failure-feedback` 剧本**消费不到** `data-toast-kind`——
   要消费它得触发一个 timeline 自己的 toast（例如"宿主无对话框能力时显式降级"那条路径）。
2. `data-settings-saving` 挂在保存按钮上（与 `data-settings-save="confirm"` 同一个元素），
   值是 `"true" | "false"`——**是状态位而不是文案**，所以断言它与语言无关（r96 的通则）。

**兑现账本里的一条**：`data-settings-saving`（r21 加的、长期无人消费）。
做法是在点保存后**立刻**以 25ms 间隔轮询最多 40 次（≈1s 窗口）采样，
并把它从"打印"升级为**断言**（`settings-controls-audit` 断言数 51 → **52**），
账本条目删除、棘轮 **8 → 7**。

> **瞬时态断言的纪律：先实测连续命中若干次，再把它变成断言。**
> 本轮实测 3/3 命中才断言。最大的风险是**偶发不命中**（写盘快过一次轮询）⇒ flaky；
> 而 flaky 断言的下场通常是被删掉，等于白做。
> 若将来它变 flaky，正确处置是**加宽轮询窗口**（或降低轮询间隔），**不是删断言**。
> 这条与 r114 的"先让它非空、再让它安静"是同一族：**先证明它稳定，再让它承担守门职责**。

产出：保存中态断言（51 → 52）+ 锚点账本 8 → 7 + 两条查明事实写进账本理由。
全量 264 文件 / 2218 测试、5 项审计 0、tsc 0、构建通过。

### 17.115 上一轮记的"缺陷"可能是误判：处置前先核实引用与发出方（r116）

r112 记下两条待办：`scripts/e2e-inmem.mjs` 是"孤儿脚本"、且"引用 4 个不存在的属性"。
本轮准备处置它，先按纪律核实，结果**两条都错了**：

| r112 的判断 | 核实结果 |
|---|---|
| "不在 npm scripts 里 ⇒ 孤儿/遗留物" | 它被 **两份设计文档**引用（`docs/design/seed-wire-alignment.md` 的测试分层表、`docs/directory-structure.md`），skill §6.2 还有它的修复记录。它是**沙箱模式**的 e2e：沙箱禁 bind/connect（含 loopback），所以用内存桥替代 TCP/WS 层，其余全真 |
| "引用 4 个不存在的属性 ⇒ 空探针" | 那 4 个是 **react-virtuoso**（`data-virtuoso-scroller` / `data-viewport-type` / `data-testid='virtuoso-item-list'`）与 **react-resizable-panels**（`data-panel-id`）**库自己发出的**属性——`node_modules/*/dist/` 里都能 grep 到，与 r113 的 `data-panel` 同一类 |

> 通则：**上一轮记下的"缺陷"在处置前必须重新核实**，尤其是这两种判断：
> ① "没人用它"——要查**文档引用**与 npm scripts 两处，只查其一会误判
>   （脚本没挂进 npm scripts 只说明**可发现性差**，不说明它该删）；
> ② "引用了不存在的东西"——要查**第三方库**是否发出它（r110/r113 的同款陷阱）。
> 这两条合起来就是 r112 那次误判的全部成因：**用"仓库内没找到"推断"不存在/没人用"**，
> 而证据可能在文档里、也可能在 node_modules 里。

真正的问题是**可发现性**（§5.3 仓库卫生）：两份设计文档都引用它，却没挂进 npm scripts ⇒
没人会跑。已加 `test:e2e:inmem`。

**顺带按 r108 的对称纪律扩了守卫语料**：`e2e-anchor-coverage` 的 e2e 侧此前只扫
`scripts/demo/*.e2e.mjs`，现在同时扫 `scripts/*.mjs`（顶层）。扩完**立刻多抓到一个**
未登记的 `panel-id`（`e2e-inmem.mjs:617` 用它打印主区结构诊断）⇒ 登记进 `LIBRARY_EMITTED`（现 5 条）。
> 这印证了 r108 那条：**语料范围每扩一处，就会暴露一批此前看不见的违规**。
> 所以"守卫通过"永远只在**当前语料范围**内成立——报告里要写清范围，
> 而扩大范围应当是例行动作，不是等到出问题才做。

产出：`test:e2e:inmem` 挂上 npm scripts + 守卫语料扩到 `scripts/*.mjs` + 账本补 4 条库属性。
全量 264 文件 / 2218 测试、5 项审计 0、tsc 0、构建通过、`e2e-anchor-coverage` 4/4。

### 17.116 "挂上入口"不等于"它能跑"：签名漂移让报错点与根因分家（r117）

r116 把 `e2e-inmem` 挂进 npm scripts，但**如实记了"本轮没有实际跑过"**。本轮补上实跑，
结果它**一跑就崩**：

```
TypeError: Cannot read properties of undefined (reading 'channelCount')
  at scripts/e2e-inmem.mjs:150:60
```

看着像"gateway 没了"，实际根因是**签名漂移**：`assemble` 已变成 `async` 且
`rendererDir` 变成必填（`bootstrap/assemble.ts:41`），而脚本仍同步调用、也不传该参数 ⇒

```js
assembled = assemble(nodeHost, { isPackaged: false });        // ← 得到的是一个 Promise
const { ctx, sessionStore, gateway, localToken } = assembled; // ← 全部 undefined
check("…", true, `channels=${gateway.channelCount()}`);        // ← 在这里炸
```

> 通则：**"同步调用一个已变成 async 的函数"这类漂移，报错点与根因不在同一处**——
> 解构 Promise 不会报错（只是全 undefined），炸的是**第一个真正用到它的地方**。
> 所以看到 `Cannot read properties of undefined` 时，若那个变量来自一次解构，
> **先去看解构的源头是不是一个没被 await 的调用**，而不是怀疑那个属性被删了。
> 这条的通用形态：**症状在下游、根因在上游的"值形态变化"**（同步→异步、
> 必填参数新增、返回结构改名），排查时优先核对**被调方的当前签名**。

修法是按 §3.7 的根因修（不是给 `gateway` 加可选链把崩溃吞掉）：
`await assemble(...)` + 补 `rendererDir: join(ROOT, "out", "renderer")`
（与 `bootstrap/server.ts` 的 `resolve(__dirname, "../renderer")` 同语义，
也与脚本自己第 257 行读 `index.html` 的路径一致）。

**修完的实测结果**（两级分别报，不含糊）：

- `--stage server`：**全部 PASS**——assemble 189 channels、内置插件 **50 全 active**、
  兜底模型解析成功、channel 探测正常。
- `--stage all`：能跑到底（此前立即崩），剩 **3 条 FAIL**，分类如下：
  | FAIL | 分类 |
  |---|---|
  | `ping: 模型回复` | **环境限制**：沙箱无外网，脚本头部本就声明"模型回复尽力而为" |
  | `消息: 时间/指标徽标 count=0` | **①的级联**：没有模型回复 ⇒ 没有 assistant 消息 ⇒ 没有徽标 |
  | `草稿: 切会话保留/恢复`（`newChatEmpty=false` / `restoredA=false`） | **疑似①的级联**（发送失败后 composer 残留），待单独查 |

> 通则：**一个长期没人跑的剧本，修好之后第一次跑必然报一堆失败，要按"环境限制 / 级联 / 真缺陷"
> 三类分开报**，不能笼统说"还有 3 条失败"。级联失败的特征是：它的被断言对象依赖前一条的产物
> （这里徽标依赖 assistant 消息、草稿状态依赖发送成功）。
> 而"长期没人跑"的根因正是 r116 查明的**可发现性**问题——所以这两轮是同一件事的两半：
> **挂上入口（可发现）→ 实跑（暴露漂移）→ 修根因（恢复可用）**。
> 只做第一步等于把一个坏入口放到了显眼的地方。

另核了一项仓库卫生（§5.3）：脚本会在仓库里生成 `.e2e-home/`，
已在 `.gitignore` 第 60 行覆盖 ✓（未被误提交）。

产出：`e2e-inmem` 恢复可跑（server 级全绿）。全量 264 文件 / 2218 测试、5 项审计 0、构建通过。

### 17.117 静默失效的探针会把"功能正常"报成"功能坏了"（r118）

r117 把 `e2e-inmem --stage all` 的 3 条 FAIL 分成"环境限制 / 级联 / 疑似级联"。
本轮查第③条（草稿切会话恢复），结果**两条分类都错了**——产品是好的，坏的是探针：

**① 草稿测试靠 title 文案找按钮**：`NEW_SESSION_TITLES = ["新会话","New session","新增工作階段","Neue Sitzung"]`，
而真实按钮是 `title={t("sessions.new")}`（语言包里的文案与这四个字面量都不一致）
⇒ `findNewSessionBtn()` 恒返回 `undefined` ⇒ 第 2/5 步**从未真的切换会话**。
于是三个断言值全是"没切走"的产物：`newChatEmpty=false`（草稿A 还在框里）、
`restoredA=false`（框里是草稿B）、`restoredB=true`（压根没离开）——
**看起来像"草稿隔离坏了"，实际是这段测试根本没跑**。
改用真锚点 `[data-session-new]`（`sessions-list/renderer/index.tsx:456`）后
三个值全 `true`，**功能一直是好的**。

**② 徽标断言用了已被移除的 `aria-label`**：`[aria-label="message-meta"]` 查不到任何东西，
因为那个 aria-label 是被**正确地移除**的（`MessageMeta.tsx:13` 的注释：
机器标识符不该当可访问名——`aria-label` 会覆盖元素内容，读屏于是对这个 span 念
"message-meta" 而不是时间与指标），锚点改成了 `data-message-meta`。剧本没跟上 ⇒ 恒 `count=0`。
改对选择器后：消息行=4、徽标=1（`buildMessageMeta` 对部分消息类型返回 `null` 属预期）⇒ PASS。

修完 `--stage all` **ALL PASS**（唯一 FAIL 是脚本头部声明的"尽力而为"网络项，
`report.ok` 的判据本就排除名字含"尽力而为"的项）。

> 三条通则：
>
> **① 静默失效的探针比崩溃的探针危险得多。** 崩溃会让人去修；静默失效只会产出
> **看起来合理的假数据**，然后被人当成产品缺陷记进待办（r117 就记了两条错的）。
> 判据：**任何"找不到元素就跳过/返回 false"的探针，都必须配一条"元素找到了"的显式断言**
> ——本轮补的 `check("草稿: 找到新会话按钮", …)` 就是这个作用；
> 有了它，失败会直接说"按钮没找到"，而不是让三个下游值变成谜。
>
> **② a11y 修复把 `aria-label` 改成 `data-*` 时，所有按旧 aria-label 定位的探针都会静默失效。**
> 这类改动必须**同批全仓搜一遍旧选择器**（剧本 + 测试 + skill §2 锚点表）。
> 这是"改一处、影响面在别处"的典型：改的是产品语义（正确），坏的是测试的定位方式（无声）。
>
> **③ 文本匹配定位是这类失效的上游成因**（skills §10.3 早就写了，但剧本里还残留）。
> 本轮那两个都是"按文案/按旧属性"定位；换成稳定锚点后一次就通。
> **凡是需要跨语言跑的剧本，文本匹配定位注定会失效**——不是"可能"，是"迟早"。

**顺带把断言改成能自诊断**：徽标那条现在同时报"消息行数"与"徽标数"，
并据此区分**真缺陷**（有消息行却无徽标）与**级联**（连消息行都没有 ⇒ 发送未成功）。
> 断言的现场信息应当**足以区分它自己的几种失败原因**；
> 只报 `count=0` 会让下一个人（包括下一轮的自己）重新推一遍因果。

产出：两个探针修复 + 一条显式前置断言 + 自诊断现场。`e2e-inmem` 两级全绿
（server 级 PASS、all 级 ALL PASS）。全量 264 文件 / 2218 测试、5 项审计 0、tsc 0、构建通过。

### 17.118 语言绑定探针的普查，与守卫第一次抓到我自己（r119）

把 r118 的通则②（a11y 改 `aria-label` ⇒ 按旧 aria-label 定位的探针静默失效）推成普查：
扫所有剧本/测试里的 `[aria-label="X"]` 选择器，反查生产代码是否仍发出 X。

**普查结果本身说明这条路不能直接做成守卫**：选择器里只出现 5 种 aria-label 值，
而生产代码**字面量**发出的只有 1 种、**动态形态** `aria-label={t(…)}` 有 33 处 ⇒
字面量比对几乎无意义（要把 `t("shell.send")` 解析成各语言的译文才能比，且比出来的结论
本身是"这个探针只在某种语言下成立"）。所以本轮**不交这条守卫**（r77 纪律），
但普查已经完成了它该做的事：**指出了具体的语言绑定探针**。

查到一处真的：`composer-session-audit.e2e.mjs:125`

```js
const send = document.querySelector("button[aria-label*='发送'], button[aria-label*='停止']");
```

对**本地化 aria-label 做子串匹配** ⇒ 换 locale 就静默失效（与 r118 那两个同类）。
根因不在剧本而在产品：`composer.tsx` 的发送/停止按钮**只有 `aria-label={t(…)}`、没有 `data-*` 锚点**，
剧本没有别的选择。按 r96 的处置补锚点：`data-composer-stop`、`data-composer-send`，
以及 `data-composer-queued`（streaming 时该按钮的 aria-label 会从"发送"变成"排队发送"，
所以**状态不能从文案反推**，要单独暴露状态位——r96 的通则）。剧本改用锚点后 25/25 通过。

**然后守卫抓到了我自己**：`data-composer-queued` 加了却没当轮消费 ⇒
`data-anchor-consumers` 的 ②③ 立刻变红（"账本外的死锚点必须为 0"）。
这是 r111 那条守卫**第一次真实拦截**，而且拦的是定它的人（r111 的通则就是这么写的：
"写在文档里的纪律只要没有守卫就会被违反，违反者往往就是定它的人"——现在有了守卫，它当场生效）。
处置选**补消费方**而不是删锚点（状态位有真实价值）：剧本采样并断言
"静息态 `data-composer-queued` 必须为 `false`"，断言数 25 → **26**。

> 通则：**守卫的价值要在它第一次拦到人时才算兑现**，而它最先拦到的往往是写它的人。
> 拦住之后的正确处置是**兑现纪律**（补消费方/补账本理由），不是把断言放宽——
> 这与 r79/r81 那两次"扩展理由而不是降低阈值"是同一条。

**一条如实说明**：`composer-session-audit` 本身没有 `--locale` 参数，
所以"换语言仍可用"是由**锚点与语言无关**这一性质保证的，本轮**未做双语言实跑**。

产出：composer 三个稳定锚点（含排队态状态位）+ 剧本改用锚点 + 排队态断言。
全量 264 文件 / 2218 测试、5 项审计 0、构建通过、composer-session-audit 26、dom-audit 28。

### 17.119 "语言绑定探针"要做成守卫，先得把两种形态分开（r120）

r119 提出的思路是：不比译文，而是扫剧本里**对 aria-label/title/textContent 做字面量匹配**的地方。
本轮实测了这个判据，得到 **254 处**候选（剧本语料 90 个文件，排除 `lib/`）：

| 形态 | 处数 | 例子 |
|---|---|---|
| 按文案的谓词（`includes`/`match`/`test`） | 127 | `ok(innerText.includes("苹果"))` |
| CSS 属性选择器按文案 | 100 | `querySelector('[role="radio"][aria-label="苹果"]')` |
| `textContent`/`innerText` 比对 | 26 | `btns.find((b) => b.innerText.trim() === "提交")` |
| `getAttribute` 比对 | 1 | `cells.find((c) => c.getAttribute("title") === "标题二")` |

**254 处里绝大多数不该改**，因为判据缺了两个必须区分的维度：

**维度一：按文案「定位」 vs 按文案「断言内容」。**
`ok(document.body.innerText.includes("苹果"))` 是**内容断言**——它验的正是
"播种的选项标签确实显示出来了"，这不但正当、而且必要（换成锚点断言反而验不到内容）。
而 `querySelector('[aria-label="苹果"]')` 是**定位**——它用文案当坐标，文案一变就找不到元素。
> 只有后者是缺陷。判据必须能区分"这个字面量是用来**找元素**的还是用来**验内容**的"，
> 而这需要看它出现在 `querySelector*`/`find`/`filter`/`waitForFunction` 的参数里，
> 还是出现在 `ok(...)`/`check(...)`/`expect(...)` 的条件里——**是语法位置判断，不是文本匹配**。

**维度二：aria-label 的来源是「播种数据」还是「t() 译文」。**
`ask-question` / `ask-resume` 里的 `苹果`/`香蕉` 是**剧本自己播种的选项标签**
（测试数据），它们不随 locale 变 ⇒ 用它们定位是**稳定的**。
而 `发送`/`停止`/`提交`/`新对话` 来自 `t()` ⇒ 语言绑定。
> 所以"含 CJK 的字面量"不是判据（播种数据也是中文）；
> 真正的判据是"这个文案是否由 i18n 产生"——而那需要追到产品侧的 aria-label 表达式，
> 正是 r119 判定"做不成守卫"的那个难点。

**结论：本轮不交这条守卫**（r77 纪律：判据没把握就不交；254 处里假阳性占绝大多数，
硬交会逼人加豁免、豁免一加守卫就废）。但普查已经兑现了价值——**它精确定位了该修的那几处**。

**本轮修的两处**（都是 r119 补的 `data-composer-send` 能解的）：

1. `composer-session-audit.e2e.mjs:161` 的 `button[aria-label*='发送']`
   ——注意这是**同一文件里的第二处**（r119 只改了 125 行）。
   > 教训：**修一个语言绑定探针时，要在同一文件里搜完所有同类**，
   > 因为一个剧本往往在多个步骤里重复定位同一个控件（"点击前采样"与"点击后采样"）。
   > r119 那次只改了被发现的那一处，属于"改了症状没改完族"。
2. `composer-model-pin.e2e.mjs:162` 的 `button[aria-label^='发送'] || button[aria-label*='发送']`
   ——这处更糟：下一行 `b.getBoundingClientRect()` 在 `b` 为 null 时**直接抛 TypeError**，
   所以换 locale 它不是静默失效而是**崩在一个与根因无关的位置**。
   已改成锚点 + 找不到时 `throw new Error("找不到 [data-composer-send]：…（不要退回按 aria-label 文案定位）")`。
   > **定位失败时显式抛、并写明"不要退回按文案定位"**——把纪律写进错误信息里，
   > 下一个人（或下一轮的我）在报错现场就能看到该怎么做（r105 的同款手法）。

**一个环境坑（如实记）**：`composer-model-pin` 用默认参数跑是 7/7 通过，
但我传 `--port 10064` 时报"等待 CDP 端口 **1** 超时"——因为它的参数解析是自定义的
`process.argv.slice(2).flatMap(...)`，与其他剧本的 `parseArgs` 不同，
空格分隔的 `--port 10064` 被解析错了。
> 通则：**跑一个剧本前先确认它的参数解析方式**（`parseArgs` vs 自定义），
> 否则会把"我传参传错了"误读成"剧本坏了"或"产品坏了"。
> 这与 r80 那次 `EADDRINUSE` 同类：**先区分环境/用法错误与产品失败**。

产出：两处探针改用稳定锚点 + 定位失败显式抛错。
`composer-session-audit` 26、`composer-model-pin` 7、全量 264 文件 / 2218 测试、
5 项审计 0、tsc 0、构建通过。

### 17.120 收窄口径后能判了：只盯"由 t() 产生的属性文案"（r121）

r120 说"254 处里假阳性占绝大多数，所以不交守卫"，并留了一条收窄思路。本轮把它实现并实测：

**三步口径**（每一步都是可判的，不靠猜）：
1. 扫产品代码，收集 `aria-label={t("key")}` / `title={t("key")}` / `placeholder={t("key")}` 的 **key**
   ⇒ 实测 **216 个键**；
2. 拿这些 key 去四个语言包解析出译文 ⇒ **语言绑定文案集 752 种**
   （这一步是关键：它把"哪些文案会随语言变"变成了**数据**，而不是靠人判断）；
3. 扫剧本，看**定位位置**（`querySelector*` / `waitForSelector` / `waitForFunction` / `.find` / `.filter`）
   的**引号内字面量**是否落在这个集合里。

**结果：79 → 1 处**。但这个下降**必须拆成两部分如实报告**：

| 来源 | 说明 |
|---|---|
| **本轮修掉的** | `[aria-label*='停止']` 一族：**18 个剧本、43 处** 改成 `[data-composer-stop]`（r119 补的锚点） |
| **口径变窄排除的** | 新判据只覆盖**由 `t()` 产生的属性文案**，不再覆盖 `.textContent === "提交"` 这类"按钮可见文本"形态——那不是假阳性被排除，而是**这一类根本没进判据**（更难：可见文本可能来自子元素拼接、模板插值） |

> 通则：**报告"违规数下降"时必须拆清"修掉了多少"与"判据变窄排除了多少"**。
> 混在一起报会让人以为债务清完了，而实际是**判据的覆盖面缩小了**。
> 这与 r98（判据漏一种保护形态 ⇒ 修复看起来无效）是同一枚硬币的两面：
> 那边是判据太窄导致**假阳性**，这边是判据太窄导致**假阴性**（漏报）。
> 两者都要求：**每次改判据，都要说明覆盖面怎么变了**。

**修的这一族为什么值得优先**：43 处里绝大多数是
`await page.waitForSelector("[aria-label*='停止']", …).catch(() => {})` 这个形态——
`.catch(() => {})` 意味着等不到就**静默继续**，于是"停止按钮没出现"会被记成
"streaming 没发生"或"内核没响应"，**症状与根因完全错位**（r118 那条"静默失效的探针
比崩溃的探针危险"的最典型样本：它不崩、只是让下游断言基于假前提）。
换成锚点后，找不到就是找不到（`waitForSelector` 超时会显式失败），不再依赖语言。

**剩下 1 处**（`确认分叉？`，出现在 `dsh-session.e2e.mjs:246` 一类的 `[title="分叉"]` 组合里）
留待下轮：它需要产品侧给分叉确认按钮补锚点，与 r119/r121 同一处置路径。

**仍未交守卫**（如实）：判据本身已经可判（三步都是数据驱动），但要交成守卫还需要
① 处理"可见文本"那一类（否则守卫只覆盖属性文案，容易给人"语言绑定探针已清零"的错觉）；
② 给 `waitForSelector(...).catch(()=>{})` 这类**静默失败形态**单独一条判据
（它比语言绑定更普遍：任何"等不到就算了"的探针都会让下游断言基于假前提）。
按 r77 纪律：先把覆盖面说清，再交守卫。

产出：18 个剧本 43 处改用稳定锚点。`minimal-smoke` 28、`composer-session-audit` 26、
`dom-audit` 28 全过；全量 264 文件 / 2218 测试、5 项审计 0、构建通过。

### 17.121 意图判不了时，就守"必须写下意图"（r122）

r121 指出比语言绑定更普遍的一类：**静默失败形态**——探针等不到就 `.catch(() => {})` 静默继续，
让下游断言基于假前提（r118/r121 两次事故都源于此，各花一整轮才定位）。

本轮实测这个方向的规模：剧本语料 90 个文件里 `.catch(…)` 吞掉失败的调用共 **361 处**，
按被调函数分族后，绝大多数是**正当**的：

| 族 | 处数 | 为什么正当 |
|---|---|---|
| `waitForDomIdle` | 179 | settle 助手，超时本就是正常路径 |
| `.then(() => true).catch(() => false)` | 52 | **显式布尔探针**——结果被赋值并被断言，这是正确形态 |
| `killApp` | 44 | teardown，成败无关 |
| `keyboard.press` | 18 | 关浮层，没有浮层时失败是正常的 |
| `screenshot` | 11 | 诊断产物，失败不该让测试红 |
| `waitForSelector` / `waitForFunction` | 61 | **需要甄别**：其中 9 处结果被接住、**52 处丢弃** |

**关键结论：丢弃结果的等待有两种意图，而语法判不出是哪种。**
- **best-effort settle**（正当）：零 token 剧本里模型可能从不回复，停止按钮合法地不出现；
  等一等是为了让"出现了"的情况稳定，等不到也继续。
- **静默失败的探针**（缺陷）：下游断言其实依赖它等到了，于是"没等到"被当成"功能没发生"。

所以本轮**不做"禁止丢弃"的守卫**（会逼人加豁免、豁免一加守卫就废），
改做一条**有先例且可判**的：**丢弃结果的等待必须带行内理由注释**
（`best-effort` / `尽力而为` / `等不到也…` / `optional` 等标记，同行或上一行）。
棘轮基线 **50**（收窄到"空体 `.catch(() => {})`"后的实测值）。

> 这与文档漂移审计的"退役符号 392 处命中，**均需标注**"是同一形态：
> **不禁止这个写法，但要求每一处写下"为什么这里可以吞掉失败"——写的过程本身就是甄别。**
> 写不出理由的那些，就是真该改成显式布尔探针的。
> 通则：**当判据无法判定意图时，就守"必须把意图写下来"**。
> 这比"猜意图"可靠（猜会产假阳性），也比"不管"有用（它把隐性决定变成显性决定，
> 而且新增时必须当场表态）。

**判据本身的三个坑（都写进了守卫注释）：**

1. **只认空体 `.catch(() => {})`**。返回值形态（`.catch(() => false)`）一定是被表达式接住的
   ——那正是 52 处显式布尔探针。首版把两者都算进来，于是**多行写法**的布尔探针被误报
   （`const appeared = await page.waitForSelector(…)` 换行后接 `.then(() => true).catch(() => false)`，
   含 `.catch` 的那一行不以 `const` 开头 ⇒ 赋值判据认不出）。
   > 与其做跨行语句分析，不如**把判据收窄到一个无歧义形态**。
2. **样本要存整行、不能截断**。首版存 `st.slice(0, 96)`，而自检要在 `code` 上跑正则，
   `.catch(() => {})` 被切掉 ⇒ 自检假红。
   > 通则：**给断言用的数据不要提前截断**（截断只该发生在打印时）。
3. **反空转锚要证明"正当族确实存在于语料里"**。守卫显式断言语料含
   `waitForDomIdle` / `killApp(` / `.then(() => true).catch(() => false)`，
   并断言名单里没有它们——否则"没报正当族"可能只是因为语料里没有。

反向注入已验（先提交再注入）：加一处无理由的丢弃等待 ⇒ ② 报"从 50 涨到了 51"；
`git checkout --` 还原后复绿 4/4。

产出：`src/e2e-silent-wait-rationale.test.ts`（4 测，棘轮 50）。
全量 **265 文件 / 2222 测试**、5 项审计 0、tsc 0。

### 17.122 消化"必须写理由"类守卫时，判据要接受多行理由（r123）

r122 立的规矩是：不禁止 `waitFor*(…).catch(() => {})` 这个写法，但每处要写下
"为什么这里可以吞掉失败"。本轮消化第一个剧本（命中最多的 `minimal-smoke`，8 处）。

**逐处判定的结论是：8 处全部属 best-effort settle，没有一处该改成显式布尔探针。**
理由不是套话，每处都写清了"真失败会由哪条断言报出来"：

| 处 | 形态 | 为什么吞掉失败是安全的 |
|---|---|---|
| 1 | 等右键菜单 `[role='menu']` 展开 | 只为让后续采样稳定；菜单真没出来，下面对**菜单项**的断言会自己红 |
| 3 | 两阶段收敛的第一阶段：等 `[data-composer-stop]` 出现 | 零 token 剧本里模型端点不可达，streaming 可能**从不开始**，停止钮合法地不出现 |
| 3 | 第二阶段：等停止钮消失 | 后续断言读的是**终态 DOM**，若仍在 streaming 会由那些断言报出来 |
| 1 | 泛条件 settle：等"有消息行" | 泛条件等不到时，后面**具体那条**等待会自己超时并报出来 |

> 这张表本身就是 r122 那条通则的验证：**"写的过程就是甄别"**——
> 逐处写理由时，如果某一处写不出"真失败会由谁报出来"，那它就是该改成显式布尔探针的。
> 本轮 8 处都写得出，所以都是正当的；这个结论**只有写过才知道**，
> 光看代码是分不出 best-effort 与静默失败的（r122 就是这么判定"语法判不了意图"的）。

**判据被这次消化逼着修了一处**：首版只认"同行或上一行"的理由，
而我写的是 2–3 行的注释块 ⇒ **标注了却仍被计入棘轮**，看起来像"标注没用"。
已改成"同行 + 向上连续注释块（最多 6 行）"，并把标记词 `等不到也` 放宽成 `等不到`
（真实写法有"等不到不算失败"与"等不到也继续"两种）。

> 通则：**要求人写理由的判据，必须接受"多行理由"**。
> 否则人会为了过判据把理由挤成一行，反而写不清——
> 而写不清的理由就等于没写（下一轮的人还是不知道这里为什么可以吞失败）。
> 同类：r122 那条"反空转锚要证明正当族确实在语料里"、
> r114 那条"白名单要按前缀族列全"，都是**判据的宽容度要匹配真实书写形态**。

**一个计数细节（如实）**：标注 8 处后棘轮从 50 降到 **43** 而不是 42——
说明其中 1 处原本就不在守卫的计数里（我用来预估的那个脚本正则与守卫判据略有差别：
`polling: 300` 那行的形态）。处置是**以守卫的实测值为准**钉 43，不按算术推。
> 通则：**棘轮基线永远取守卫的实测值，不要用"原值 − 修掉数"推算**。
> 两者不等时，差值本身就是"我的预估脚本与守卫判据不一致"的信号（本轮就是）。

产出：`minimal-smoke` 8 处理由标注 + 守卫判据接受多行注释块 + 棘轮 50 → **43**。
`minimal-smoke` e2e 28 项断言仍全过；全量 265 文件 / 2222 测试、5 项审计 0、tsc 0、构建通过。

### 17.123 交付清单（做一次全仓审计的完成定义）

审计剧本（可 `--locale`、排除不可见子树、打印跳过计数、H 级发现非零退出）
+ 每个 locale 各跑一遍 + 每条判据配"不空转"断言 + 每个修复配反向注入验证
+ 大批量债务走棘轮清单 + 锚点只用自有且源码可查的 + 文件↔DOM 用不变量而非等式
+ 结论落到守卫（下次自动跑）而不是一次性输出。
