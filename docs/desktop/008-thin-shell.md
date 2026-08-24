# 008 薄壳架构：机制与内容分离

> ⚠ **历史稿**：本文是 pre-多内核 的 pi-only 旧术语稿（"底座"/旧"内核"=壳机制），术语与架构以 CLAUDE.md + kernel-design-spec.md + core-spec.md 为准，本文保留作历史参考。

my-harness-desktop 的设计思想起点是一句话：内核的功能含量趋近于零。它不是"尽量少放功能"，是零——内核里不应该出现一个写死的中文文案、一个写死的颜色值、一段"如果工具名是 bash 就渲染成终端"的分支逻辑。出现就是违规。

这句话不是口号，是物理约束。打开 `src/core/domain/` 和 `src/core/application/` 任何一个文件，如果能看到上述任何一种东西，这条纪律就被打破了。而这个检验不依赖任何外部知识——新人也能当场判。

把功能推到零之后，内核还剩什么？加载器、槽位契约、权限沙箱、进程隔离、生命周期管理、事件总线、RPC 适配、配置读写——全是机制，全是让功能能挂上来的能力，不是功能本身。这就是薄壳的本质：内核只有机制，内容全部外挂。

## 1 两条铁律

薄壳有两条不妥协的规则，违反任何一条都不是薄壳。

### 1.1 铁律一：内核零功能含量

内核里允许出现的只有一种东西：指向外部内容的 token key——`theme["color.primary"]`、`i18n.t("timeline.toolExecuting")`。这些是查询契约，不是硬编码。key 是契约、值是内容，性质完全不同。

违规的是 key 背后的值：`"#89b4fa"` 是具体颜色，`"工具执行中"` 是具体文案，它们是会变的内容，该由主题插件和语言插件贡献。内核知道了具体颜色值，就等于说"我认为这个蓝色是对的"，但配色方案是内容，明天可能换成红色，内核不该知道任何一个颜色值。

**具体检验**：打开 `src/core/` 下任何一个文件，逐行看有没有：
- 写死的颜色 hex（`#0e0e11`、`#ffffff`）
- 写死的用户可见文案（中/英/德任何语言）
- 针对具体业务类型的 if-else 分支（"如果 tool 名是 bash 就渲染成终端"）

找到任何一条，就是违规。

反过来验证——主题插件是纯 JSON 声明。`src/plugins/themes/theme/plugin.json` 里 dark 和 light 两套配色方案全部是 `tokens: { "color.bg": "#0e0e11", ... }` 这样的键值对，文件中没有任何代码逻辑，没有任何非 JSON 结构。内核不知道 `#0e0e11` 这个值，它只知道"有一个 token 叫 `color.bg`，去主题注册表里查"。配色换一套，换的是这个 JSON 文件，内核一行不动。

语言同理。`src/plugins/system/i18n/locales/zh-CN/shell.json` 里是 `"shell.settings": "设置"`，`locales/en/shell.json` 里是 `"shell.settings": "Settings"`。内核代码里只出现 `t("shell.settings")`，不出现 `"设置"` 或 `"Settings"`。切语言是换一组 JSON 文件资源，内核一行不动。

**删掉 i18n 插件后的退化行为**更能说明这条铁律的本质：壳照常启动，所有界面文案退化为显示 key 原文。i18next 配的 `fallbackLng: "en"` 也没有资源可回了——内核没有"默认英文文案"，因为所有文案都是外挂，内核不持有任何一份。退化成 key 不是 bug，是设计——它证明内核确实没有内嵌文案，一旦失去语言插件，它就诚实地告诉你"我缺了这部分内容"。

### 1.2 铁律二：内置与第三方无特权差异

内置插件和第三方插件走同一套加载器、同一套契约、同一套权限。内核不该有任何"识别内置件并特殊对待"的代码路径。

**检验方式一**：把任何一个内置插件从 `src/plugins/` 目录删掉，内核照常启动——加载器继续递归扫描，注册表继续填充余下的插件贡献项，只是那块功能不在了。删掉 timeline，中区显示一行灰字"mainView 槽无贡献"（文案来自 shell locale key `shell.mainViewEmpty`，不是硬编码）。删哪个都不会崩。

**检验方式二**：把任何一个内置插件从 `src/plugins/` 复制到 `~/.my-harness-desktop/plugins/`（用户目录），它应该以更高优先级覆盖内置版。覆盖是怎么工作的？注册表 `PluginRegistry.registerOne`（`src/core/application/loader/registry.ts:109`）在 push 数组类槽的贡献项前，先按 `contribution.id` 移除同 id 旧项（`reg.removeById(id)`）。bootstrap 的注册序是 `builtin → installed → user → project`——后注册的优先级更高，所以 user 目录下同 id 的贡献自动覆盖 builtin。这段逻辑是通用的覆盖语义，没有"如果是 builtin 源就跳过"的判断——`removeById` 只按 `id` 匹配，不认 source（registry.ts:57-59）。

为什么必须守住这条？因为特权是复杂度炸弹。一旦内核开始"特殊对待"内置件，就意味着多了一套加载逻辑、多了一套优先级判断、多了一条"如果来源是 builtin 就……"的条件分支。每条分支都是 bug 温床，每条分支都要测试，每条分支都会随着内置件增多而膨胀。VSCode 的扩展体系里内置扩展和第三方扩展是平等的，这是它能撑起上万扩展生态的原因之一。不平等的系统到不了那个规模。

## 2 唯一判据：一年后这东西会不会换

什么东西进内核、什么东西推给插件，判断标准只有一条：**一年后这东西会不会换。会换就推出去，不会换才留在内核。**

这个判断的妙处在于它不需要架构知识——技术新人也可以问这个问题。答案只有两种，没有"大概不会"、"暂时不换"、"应该不换"——这些犹豫都是推出去的信号。真正不会换的东西，你问这个问题的时候不需要犹豫。

### 2.1 不会换的：留在内核（机制）

这些东西的共同特征是"拿掉它系统就不能启动"——它们是让插件体系存在的先决条件。

**加载器**。`discoverPlugins`（`src/core/application/loader/discover.ts`）递归扫描四目录，含 `plugin.json` 且 manifest 有 id 的目录即插件。加载器本身不会换——你可以换它的实现方式，但"有一个加载器"这件事不会变。没有它一切插件挂不上来，系统空转。

**槽位契约**。`src/core/domain/contributions.ts` 定义的 `SlotName` 联合类型（sidebar / sidePanel / mainView / settings / themes / languages / 等 18 个槽位名）和每种贡献项的形状接口。槽位的数量和形状可能随版本演进，但"有槽位契约"这件事不会变。

**权限沙箱**。插件是不可信代码，内核必须隔离和校验。"需要隔离"这件事不会变。具体实现在各层——权限校验在 `api/ipc/fs-git.ts` 的 IPC 边界（`registry.assertPermission(pluginId, permission)`）、进程隔离在 `client/pi/subprocess-lifecycle.ts`。圆心只留中性契约——`PluginContext` 的能力分层（核心默认 vs 声明能力 vs 用户手势驱动），不感知具体安全策略。

**生命周期管理**。插件的 activate/deactivate/dispose，配置文件的读写和锁——这些是所有插件都需要的底层能力，不会换。

**事件总线**。内核和插件之间、插件和插件之间的消息通道。通道的实现可以换（从 IPC 换到 MessagePort 换到别的），但"有一个通道"不会变。

### 2.2 会换的：推给插件（内容）

以下每一项，只要满足"会变"或"可替换"之一，就推出去：

| 会变的内容 | 推给谁 | 物理位置 |
|---|---|---|
| 文案 | i18n 插件 | `src/plugins/system/i18n/locales/` |
| 配色 | 主题插件 | `src/plugins/themes/*/plugin.json` |
| 管理页（pi 管理、模型管理、主题管理、插件管理） | manager 域插件 | `src/plugins/manager/` |
| 时间线渲染（消息气泡、思考块、工具调用） | timeline 插件 | `src/plugins/sessions/timeline/` |
| 会话列表、项目列表 | sessions-list、projects 插件 | `src/plugins/sessions/`、`src/plugins/project/` |
| 业务分支（文件预览、Git 审查、盲审、Token 统计） | 对应插件 | `src/plugins/project/`、`src/plugins/insight/` |

一个标志性的案例：时间线渲染曾经焊在 shell 里——message-list 是内核代码。DESIGN.md §7.2 标注"已落地：message-list 从 shell 迁出，经 mainView 槽贡献"。迁出后，timeline 插件通过 `mainView` 槽贡献其中区渲染组件，壳只留一个空容器——`api/renderer/components/main-view-host.tsx` 按槽查注册表选渲染器。换掉 timeline 插件，壳的中区就是一片空白，换个新的消息渲染插件就换一种呈现方式。内核既不认识"消息气泡"，也不认识"思考块"，它只认识"mainView 槽上有贡献"。

### 2.3 几个会让人犹豫的边界案例

**"这个以后可能会加一种新形态"** → 会换，推出去。犹豫本身就是推出去的信号。

**"这个现在只有一种，但理论上可以有别的"** → 会换，推出去。比如现在只有一个 pi 底座，理论上可以有别的 AI agent 后端——所以 RPC 适配的执行件（spawn/stdin/stdout）在 `client/pi`，是外层；协议契约（消息类型、命令构造）在 `core/protocol`，是内层。换底座只动 client/pi，protocol 不动。

**"这个虽然不变，但拿掉它系统也能跑"** → 可选的，推出去。比如某个特定渲染组件——内核不需要知道它存在就能跑。

将这三个边界案例编程为可操作的判断法则见 DESIGN.md §2.3。

## 3 消费而非翻译：34 个 JSON adapter 的教训

薄壳的设计有一个直接的经验来源：旧方案的中间层爆炸。

旧方案把自己定位成"底座 TUI 的 UI 翻译层"——底座的扩展输出终端组件树（TUI），桌面壳要把它翻译成 Web 组件树。为此造了 34 个纯 JSON adapter，每个 adapter 对应一种 TUI 组件，干的事就是把一种终端的组件规格翻译成一种 Web 渲染规格。但 Web 吃不下终端组件——TUI 是字符网格，Web 是 DOM 树，两种渲染模型有根本性的差异。翻译不完就要再加一层，层越叠越多，复杂度爆炸，而开发者始终是在追底座的版本变化。

根源是把自己定位成了翻译层。一旦定位成翻译层，就被迫适配对方那套你不控制的东西——它的渲染机制、它的组件树、它的生命周期。你吃不下它，只能层层转译。

my-harness-desktop 重新来过：不翻译，只消费。底座经 JSONL RPC 吐出结构化数据（`src/core/protocol/event-translator.ts` 把底座事件翻译成中性事件），桌面插件拿到数据自己决定怎么画——用什么组件、什么布局、什么交互，是插件的事，和内核对底座的理解无关。这是单向的、主动的消费，不是双向的、被动的翻译。

一字之差消解了整个中间层：没有"翻译底座的组件树"这件事，自然不需要翻译层；没有翻译层，就没有"行为和外观两套并列概念"；没有两套并列概念，第三方想在桌面有 UI，只要写一个桌面插件自带 UI 自带代码，不用给内核贡献 JSON 等发版。adapter 这整个层直接从架构里消失了。

这里有一条边界需要澄清：协议层面的结构化消息翻译是必要的——底座经 stdout 吐出 JSON Lines，`core/protocol/event-translator.ts` 把它翻译成中性事件。这是数据格式的翻译（JSON → TypeScript 对象），不是渲染机制的翻译（TUI 组件树 → Web 组件树）。前者是边界工作，后者是不必要的中间层。

## 4 薄不等于弱：极薄的内核 + 极强的机制

薄壳容易让人误以为"因为我内核很薄，所以我的插件体系很弱"。薄和弱不是一回事。薄指的是内核的功能含量趋近于零——文案、配色、管理页、渲染逻辑一概不焊死在内核；厚（强）指的是内核提供的机制足够强，强到第三方插件能在不碰内核代码的前提下把整个桌面端填满功能。

VSCode 是这套模型最成功的工业级样本。它的语言包、主题、默认渲染器全是扩展，不是硬编码。但它的扩展 API 极强——`vscode.window.createWebviewPanel`、`vscode.workspace.onDidChangeTextDocument`、`vscode.languages.registerCompletionItemProvider`——功能不是它给的，但"如何挂上功能"的机制是它给的。my-harness-desktop 借鉴的是这套架构纪律（薄壳 + 槽位契约 + 无特权差异），但不借用它的 API 形状——那是为代码编辑器优化的，my-harness-desktop 的槽位是会话列表、设置页、主题，为对话式桌面应用优化。

只薄不厚是空壳——插件挂不上、挂上也不安全；只厚不薄是胖客户端——功能焊死在内核，第三方只能补边角。要的是前者：极薄的功能含量加上极强的机制保障。

my-harness-desktop 的机制保障体现在五个层面：

- **加载器**：`discoverPlugins` + `PluginRegistry` 支持四来源优先级（project > user > installed > builtin）、拓扑排序依赖、tokenSchemaVersion 兼容校验、热加载与卸载。
- **槽位契约**：18 个槽位（`SlotName` 联合类型），每个槽位有精确的类型接口。`ThemeContribution` 的 `tokens: Record<string, string>` 和 `LanguageContribution` 的 `resources: Record<string, string> | string` 是声明式契约——插件只贡献数据，不需要写逻辑。
- **权限沙箱**：核心默认、声明能力、用户手势驱动三层权限模型。IPC 边界 `registry.assertPermission(pluginId, permission)` 校验，声明了才放行。
- **进程隔离**：pi 底座是独立子进程，经 JSONL RPC 通信。插件 renderer 运行在 Chromium 渲染进程，和 main 进程间只通过 `window.pi` 受控桥接面通信。`contextIsolation: true, nodeIntegration: false`。
- **生命周期管理**：activate → deactivate → dispose 全生命周期。卸载时自动检查 dependsOn 反向依赖，阻止"拆掉 B 让依赖 B 的 A 崩掉"；自动注销 channel 和 replay 缓存；自动移除注册表贡献项。

## 5 物理执行：薄是怎么被守住的

薄壳不是靠代码审查抓违规守住的，是靠物理隔离。目录结构本身就是第一道防线。

### 5.1 分区物理隔离

```
src/
  core/domain/        # 圆心：零依赖。只有类型定义和纯函数
  core/protocol/      # 协议契约：纯类型和纯函数
  core/application/   # 用例编排：不碰 UI 不碰进程
  api/ipc/            # 流入：IPC handler，不 import bootstrap
  client/pi/          # 流出：spawn/stdin/stdout，不 import react
  bootstrap/          # 组装根：只拼不造
  plugins/            # 内容层：不 import src/ 内部实现
```

`core/domain/` 里放不下 `electron`，放不下 `better-sqlite3`，放不下 `react`——物理上 import 不了。当前 `core/domain/` 下的文件验证：`contributions.ts`（349 行）、`sessions.ts`、`context.ts`、`events/session-state.ts`……全部是 `interface`、`type`、纯函数定义，import 列表里没有一个外部包。

`plugins/` 不 import `src/` 内部实现。插件只从 `packages/contract` 和 `packages/react` 两个发布面引用类型和 API。ESLint 强制执行这条边界——`no-restricted-syntax` 拦截 `window.pi` 直访、`const PLUGIN_ID =` 模式、`usePiApi` 调用、`registerXxxComponent` 调用，在 `src/plugins/` 目录下零容忍。

### 5.2 组装根极薄

`src/bootstrap/index.ts`（320 行）是应用启动的组装根，目标是极薄——只拼不造。它的代码结构是：

1. 读环境路径（唯一的 `homedir()`、`process.cwd()` 调用点）
2. 构造依赖（ConfigStore、PiSettingsStore、PluginRegistry、SessionStore 等）
3. 注入 MainContext
4. 注册全部 IPC handler
5. 创建窗口

每行代码都在组装——`new PluginRegistry()` → `discoverPlugins(builtinDir, "builtin")` → `registry.registerAll(...)`。没有一行在实现业务逻辑。IPC handler 的实现全在 `api/ipc/` 的十四个按能力域分的文件里，bootstrap 只是 `registerConfigIpc(ctx)` 一行注册。

### 5.3 打开任何一个内核文件能当场判

这条是给新人的自检工具——不需要懂架构，打开文件扫一遍：

- 有没有写死的颜色 hex（`#0e0e11`、`#ffffff`）？
- 有没有写死的中/英/德文案？
- 有没有针对具体插件/业务类型的 if-else 分支？

找到任何一条就是违规。主题插件 `plugin.json` 是通过检查的反面教材——它全部是 token key-value，没有代码、没有逻辑、没有 import。

## 6 框架向上收敛：几十份变成一份

薄壳不只是"把内容推出去"，另一面是"把通用逻辑收上来"。如果每个插件都要自己写 save/dirty/拦截/刷新/组件注册/pluginId 管理/事件 channel——那薄壳只是把复杂从内核挪到了插件，总量没减。

my-harness-desktop 在开发过程中反复经历同一个模式：最初是插件驱动——每个插件自己注册、自己管理、自己写样板代码。后来发现多个插件都在做同一件事，差异只在参数，于是收敛为框架驱动。

### 6.1 save/dirty/拦截/刷新/打开配置

最初每个设置页插件需要自己注册 saveBar、自己管理 dirty 状态、自己写拦截逻辑（"有改动没保存，你确定要切走吗？"）。几十个插件的 save 逻辑是几十份大同小异的代码。

收敛后：插件在 manifest 里声明 `configFile`，框架自动管读、写、dirty 追踪、保存、重置。插件只管渲染 UI 和调 `onChange` 报告改动。整个流程变成：
- 框架读 configFile，传 `config` 给插件组件
- 用户修改后插件调 `onChange({ key: value })`
- 框架设 dirty，弹出保存浮层
- 用户点"确定改动"，框架写回 configFile
- 有 dirty 时切 tab / 返回对话，框架弹窗"保存/丢弃/取消"

几十个插件的 save 逻辑从几十份变成 `SettingsContribution` 接口里的 `saveMode: "framework"` 一个字段。

### 6.2 组件自动匹配

最初插件手写 `registerSidePanelComponent("GitReviewTab", GitReviewTab)`——22 处调用，每处的字符串和 manifest 里的 `"component": "GitReviewTab"` 是手写两遍的。改一个忘一个就炸。

收敛后：框架加载 renderer module 后，读 manifest 的 `contributes.*[].component` 字段，在 module 的 exports 里找同名组件，自动注册到对应槽位（DESIGN.md §7.4）。插件只写 `export function GitReviewTab()`，不调任何 register 函数。两层校验：TypeScript 编译器保证 export 的名字存在，框架加载时保证 manifest 的 component 名和 export 匹配——找不到立即报错。

### 6.3 pluginId 自动注入

最初 15 个插件各自在代码顶部写了 `const PLUGIN_ID = "blind-review"`，然后 `usePluginContext(PLUGIN_ID)` 传入。plugin-manager 和 theme-manager 更直接——在调用处手拼 `api.config.get("plugin-manager", "customOrder")`。

收敛后：`PluginIdContext`（React Context）由 shell 的四个槽壳组件在渲染插件组件时自动注入（`<PluginIdContext.Provider value={item.pluginId}>`）。`usePluginContext()` 无参调用，内部从 Context 读 pluginId 自动绑定。插件代码从 `const ctx = usePluginContext(PLUGIN_ID)` 变成 `const ctx = usePluginContext()`。pluginId 的唯一来源是框架，唯一消费点是 `usePluginContext()` 内部的绑定逻辑。改 manifest 的 id，框架注入的值自动变，插件代码一行不改。

### 6.4 事件 channel 自动注册

最初插件间通信走共享 store 互读写——timeline 调 `useUiStore().requestBookmark()` 往全局 store 写请求对象，session-bookmarks 从 `useUiStore().bookmarkRequest` 读。这是隐式握手——双方没有依赖声明，payload 形状是各处手写，改一边忘另一边就漂移。

收敛后：插件间唯一通信通道是 `ctx.events.emit/on`。channel 不进 manifest，由代码级 `export const channels = ["my-plugin:eventA"] as const` 声明。框架加载 module 后自动读取并注册。emit 时校验 channel 在自己的 `channels` export 里声明过——没声明就报错。订阅方声明 `dependsOn` 保证加载顺序。

### 6.5 样式、语言、路径

框架还管了：
- **样式**：`SettingsSection`（只边框无填色）、`ListItem`（列表项样式），所有插件统一。插件不写边框和 hover 样式。
- **语言**：i18n 初始化和语言切换由框架管，插件只管 `t("key")`。
- **统一配置通道**：插件 `ctx.config.get/set/all` 使用，框架按 pluginId 推导路径——默认项目级 `<cwd>/.my-harness-desktop/config/{pluginId}.json`，全局 `~/.my-harness-desktop/config/{pluginId}.json` 自动兜底。插件不拼路径、不感知 cwd。
- **settings:changed 通知**：外部模块写 `~/.pi/agent/settings.json` 后框架 emit `system:settingsChanged`，设置页自动刷新。不靠用户手动点刷新。

### 6.6 收敛的边界

什么时候不该收敛？当多个调用方的逻辑真的不同时。标准是"差异是参数级的还是行为级的"——参数级（输入不同但处理逻辑相同）收敛，调用方传参数；行为级（处理逻辑本身不同）不收敛，各自保留。

## 7 小结

薄壳不是"少写功能"，是把"会变的"和"不变的"彻底分开——机制留在内核，内容推给插件。两条铁律（零功能含量、无特权差异）和一条判据（一年后会不会换）构成了整个架构的最高约束。

薄不等于弱：内核虽然零功能，但加载器、槽位契约、权限沙箱、进程隔离、生命周期管理提供的机制保障足够强，强到第三方插件可以在不碰内核代码的前提下把整个桌面端填满功能。VSCode 是这套思路的工业级样本。

薄不是靠代码审查守住的，是靠物理隔离——`core/domain/` 零依赖、`plugins/` 不 import 内部实现、ESLint 强制执行。打开任何一个内核文件，一眼就能判：有没有写死的颜色 hex、写死的文案、针对具体业务的 if-else。

完整的架构纪律体系（依赖只向内、契约单源、依赖倒置、消费而非翻译、构造与执行分开等全部原则）见 DESIGN.md，本文档只聚焦薄壳这条纪律及其执行。
