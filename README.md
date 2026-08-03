<p align="center">
  <img alt="pi-desktop logo" src="assets/icons/icon.png" width="128">
</p>

<h1 align="center">pi-desktop</h1>

<p align="center">pi 的桌面壳 —— 薄壳 + 槽位 + 插件，一切功能是外挂</p>

<p align="center">
  <img alt="Electron 33" src="https://img.shields.io/badge/Electron-33-47848F?logo=electron&logoColor=white">
  <img alt="React 18" src="https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black">
  <img alt="TypeScript 5.9" src="https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white">
</p>

---

pi-desktop 是 pi 的桌面壳。pi 是 Mario Zechner 发起的开源终端 coding agent（[pi.dev](https://pi.dev)）——核心刻意收窄，其余一切靠扩展。pi-desktop 给它配一个桌面：不是把终端界面搬进窗口，而是把 pi 当作被管理的子进程，经 JSONL RPC（stdin/stdout 上每行一个 JSON 消息）驱动，用一套插件体系把整个桌面 UI 组装出来。

## 1 设计思想：从 pi 到桌面

### 1.1 pi 的哲学

pi 的 README 里有一句话概括了它的全部设计：*aggressively extensible, so it doesn't have to dictate your workflow*——极端可扩展，这样它就不必规定你的工作方式。

这不是口号，是一张刻意的不做清单：

- 核心只给四个工具：`read`、`write`、`edit`、`bash`。大模型靠这四个工具完成一切，其余能力全是外挂。
- 没有 MCP（Model Context Protocol）——写一个带 README 的 CLI 工具（pi 称之为 skill），或者自己写个扩展去支持 MCP。
- 没有 sub-agents——用终端复用器 tmux 起多个 pi 实例，或者装一个按你的方式做的扩展包。
- 没有权限弹窗——跑在容器里，或者用扩展自建一套符合你安全要求的确认流。
- 没有 plan mode、没有内置 to-do、没有后台 bash——每一种的答案都是同一个：要就自己去扩展。

妙处不在功能少，在于每个"不做"都把选择权还给了用户：功能不进核心，谁的工作流谁自己组装。核心因此小到可以被完全理解，而生态可以长得比任何一家厂商的路线图都快。完整论证见 pi README 的 Philosophy 一节和 Mario Zechner 的设计长文 [pi-coding-agent](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)。

### 1.2 同一副药，抓到桌面上

pi-desktop 把同一条原则原样抓到桌面壳上：

- **内核功能含量趋近于零**。内核指 pi-desktop 自己提供的机制代码：加载器、槽位契约、RPC 适配、配置读写、权限沙箱、事件总线。文案、配色、管理页、渲染逻辑、业务分支——全是插件，不焊死在内核。

- **pi 底座不是插件，是被管理的资源**。它是一个独立子进程，内核经 RPC 管它——和 git、文件系统处在同一层抽象。

- **内置件没有特权**。删掉任何一个内置插件，内核照常启动，只是少了那块功能；内置件和第三方件走同一套加载器、同一套契约，内置件优先级最低、可被覆盖。

这套模型在桌面端有一个工业级样本：VSCode——它的语言包、主题、默认渲染器全是扩展，不是硬编码。pi-desktop 借它的架构纪律（薄壳 + 槽位契约 + 无特权差异），但不借它的 API 形状：那是为代码编辑器优化的，pi-desktop 的槽位是会话列表、设置页、主题，为对话式桌面应用优化。

### 1.3 pi-desktop 自己的增量

继承不是照抄。落到桌面，pi-desktop 加了三个自己的判断：

- **消费而非翻译**。不把自己定位成 pi 终端界面的翻译层——不造 adapter 把终端组件树翻译成 Web 组件树。底座经 RPC 吐出结构化数据，桌面插件拿到数据自己决定怎么画。翻译层整个被消解，第三方想在桌面有 UI，写一个桌面插件就行，不用给内核贡献 JSON 等发版。

- **槽位契约**。内核预定挂载点——侧栏、主视图、设置页、主题、语言等——插件往槽位上挂内容，内核只认契约不认具体插件。换掉所有插件，内核机制一行不动。

- **内核管通用，特化归插件**。save / dirty / 拦截 / 刷新这类每个设置页都要做的事，收进内核统一承担；插件只管渲染 UI 和报告改动。几十个插件的保存逻辑从几十份变成一份。

这三条只给结论，完整论证和全部架构纪律在 [docs/DESIGN.md](docs/DESIGN.md)。

## 2 跑起来

### 2.1 环境要求

- Node.js 18 或更高（electron-vite 的要求；开发机实际用的是 Node v25）。
- macOS 是目前验证过的开发平台。`npm install` 时有个 postinstall 脚本会给 dev 模式的 Electron.app 换名换图标，那是 macOS 专用的，其他平台自动跳过、不报错。Windows / Linux 没有已知的平台特定障碍——依赖全是跨平台的（Electron / React / Node）——但也没有人实测过。

### 2.2 两条命令

```bash
npm install   # 装依赖，postinstall 顺手把 dev 模式的 Electron.app 换名换图标
npm run dev   # electron-vite 开发模式，起窗口
```

窗口起来后还有两步初始化，都在设置页完成（左栏底部的齿轮入口）：先在第一个 tab（pi-manager 插件）安装 pi 底座版本——底座是公共 npm registry 上的 `@earendil-works/pi-coding-agent` 包，界面会列出可用版本，选一个安装，不随仓库分发；再在"模型" tab（pi-model-manager 插件）配好 provider 和 API Key（支持哪些 provider 由底座决定，Anthropic、OpenAI 等主流都在，Key 去对应 provider 官网申请）。之后回主界面，在左栏选一个本地目录作为工作目录（任意代码项目即可）、新建会话，开始对话。

其他常用命令：

- `npm run build` — 构建产物到 `out/`。
- `npm run typecheck` — `tsc --noEmit` 全量类型检查。
- `npm run lint` — ESLint 检查 `src/plugins/`，零 warning 门槛。
- `npm start` — 直接跑 `out/` 里的构建产物，带 `--remote-debugging-port=9222`。

### 2.3 打安装包（稳定版与迭代版共存）

```bash
npm run dist       # 出本机平台的安装包到 dist/
npm run dist:all   # 一台 mac 一次出三端：mac(.dmg/.zip) + Windows(nsis/.zip) + Linux(AppImage/.deb)
npm run pack       # 只打目录形式(不压安装包)，快速验证打包态
```

产物未签名：macOS 首次打开走 右键→打开 过 Gatekeeper；Windows SmartScreen 选"仍要运行"。签名/公证需要开发者证书，是另一摊事。

**数据目录分流**：打包安装的版本（`app.isPackaged`）读写 `~/.pi-desktop/`，`npm run dev` / `npm start` 跑的开发版读写 `~/.pi-desktop-dev/`——安装一个稳定版日常用，dev 版随便迭代，两边数据互不污染。两个例外不分流：`~/.pi/agent/`（pi 底座的模型 Key 等，两版共享，只配一次）和项目级 `<cwd>/.pi-desktop/`（跟着项目走）。dev 版首次启动想继承稳定版数据，可以 `cp -r ~/.pi-desktop ~/.pi-desktop-dev` 后再删要隔离的部分。

**窗口与平台适配**：macOS 用原生红绿灯；Windows/Linux 无边框窗口的标题栏自带 min/max/close 按钮（自绘，经 `window:*` IPC）。win/linux 的 spawn 调用（npm install、pi CLI）已做 `.cmd`/shell 适配，但这两端尚未真机实测——第一个在 Windows / Linux 上跑的人就是验证者。

## 3 三分钟看懂架构

### 3.1 一句话模型

三层各管一件事：**底座**是能力（pi 子进程，经 RPC 驱动），**内核**是机制（加载器、槽位、配置、权限），**插件**是内容（一切 UI 和功能）。内核不认具体插件，只认槽位契约；插件不碰内核实现，只经 `packages/contract` 和 `packages/react` 两个发布面拿受控 API。

### 3.2 目录分区

```
src/
  core/         # 圆心：domain(槽位契约、中性类型、纯函数，零依赖) + protocol(协议契约与翻译)
                #   + application(用例编排：加载器、配置、会话、主题/i18n 合并)
  api/          # 流入适配器：ipc(main 进程 IPC handler，按能力域分文件) + preload(window.pi 桥接面)
                #   + renderer(React 入口、槽壳、plugins-host、stores)
  client/       # 流出适配器：pi(底座 RPC 适配、子进程生命周期、pi CLI) + fs + git + npm
  bootstrap/    # 组装根：Electron main 入口——读环境、建依赖、注入 MainContext、管窗口
  plugins/      # 内容层：一切功能，按域分六组(themes/sessions/project/insight/manager/system)
packages/
  contract/     # 发布面：domain + 路径/样式预设契约的 re-export
  react/        # 发布面：React 组件与 hooks，插件唯一允许的 API 入口
  pi-cli/       # 打安装包时的底座副本落点（仓库里为空；dev 运行时底座由应用装进 ~/.pi-desktop/）
```

"中性"指不依赖任何框架、任何运行时——纯 TypeScript 类型和结构化数据，换掉 Electron 或 React 都不受影响。

依赖只向内：`core/domain/` 不 import 任何外部包，`plugins/` 只经 `packages/` 引用类型和 API。前者是物理的——`core/domain/` 里没有任何外部包可引；后者由 ESLint 强制——插件直接 import `src/` 内部实现的引用会被 lint 拦下。

### 3.3 槽位一览

内核预定的挂载点，插件往槽上挂内容。当前已实现贡献接口的九个：

- **`sidebar`** — 左侧栏：会话列表、项目列表。
- **`sidePanel`** — 右侧面板：会话树、Git review、文件树、Token 统计。
- **`mainView`** — 中区主视图：timeline 插件贡献的会话消息流。
- **`titlebar`** — 标题栏右侧按钮。
- **`settings`** — 设置页：pi 管理、模型管理、主题管理、语言等。
- **`themes`** — 主题配色方案。
- **`languages`** — 语言文案包。
- **`messageRenderers`** — 按消息 role/kind 自定义卡片，覆盖默认渲染。
- **`fileActions`** — 文件上下文动作（如盲审文件）。

圆心的 `SlotName` 类型里另有 `management` / `cardRenderers` / `viewers` / `commands` 四个预留名，贡献接口未实现，在 `plugin.json`（插件的 manifest）里声明了会被忽略。

### 3.4 内置插件一览

28 个内置插件随壳分发、开箱即用，但架构地位和第三方插件完全平等——可被覆盖、可被删掉。按域分六组（与 `src/plugins/` 下的物理分组一致）：

- **sessions/**（会话域）：sessions-list（会话列表）、session-tree（分支树）、session-bookmarks（书签）、session-colors（会话图钉）、timeline（中区消息流）。
- **project/**（项目域）：projects（项目列表）、file-tree（文件树）、git-review（Git 审查 + commit/push）、notes（常用语）。
- **insight/**（洞察）：token-stats（Token 统计）、blind-review（盲审：多蓝队独立会话审查 + 裁判汇总，借鉴 Anthropic blind auditing game）。
- **manager/**（管理页）：pi-manager（底座版本 + 底座配置）、pi-model-manager（模型供应商）、plugin-manager（桌面插件自身）、theme-manager（主题选择、字体、字号）、skill-manager、tool-manager（工具过滤）、extension-manager——最后两个管的是 pi 底座的技能与扩展资产，不是桌面插件。
- **themes/**（外观）：theme（默认配色）加 ChatGPT / Midnight / Mocha / New York / Stone / Terminal 六套主题，全部是纯 JSON 声明。
- **system/**（框架级内容）：i18n（简 / 繁 / 英 / 德四种文案 + 语言设置页）、general-config（通用配置）、debug-bar（标题栏 debug 按钮）。

第三方插件放 `~/.pi-desktop/plugins/`（用户级）或项目根目录的 `.pi-desktop/plugins/`（项目级），和内置件走同一套加载器、同一套契约——项目级覆盖用户级，用户级覆盖内置。

## 4 文档地图

README 只负责指路，不重复任何深文档的内容。

- **想懂架构原理和全部纪律** → [docs/DESIGN.md](docs/DESIGN.md)：为什么薄壳、什么进内核什么不进、分区依赖纪律、通信机制、框架与插件的分工。仓库根目录的 CLAUDE.md 是指向它的符号链接，同一份文件。
- **想懂内核某个机制怎么实现** → [docs/core/](docs/core/)：[kernel.md](docs/core/kernel.md)（加载器、RPC 适配、会话管理、配置加锁、主题/i18n 合并、安全边界），外加冷启动、事件机制、扩展管理三篇专项。
- **想写一个插件** → [docs/plugins/PLUGINS.md](docs/plugins/PLUGINS.md)：插件架构与开发指南。同目录下每个内置插件还有自己的文档，讲它解决什么问题、做了哪些设计决策、用了内核的什么功能——挑一个和你想法相近的照着写最快。
- **想查某个特性的设计来龙去脉** → [docs/design/](docs/design/)：分层配置、会话流架构、插件事件流、subagent 调度等单特性设计文档。
- **想知道测试怎么打** → [docs/test/testing-strategy.md](docs/test/testing-strategy.md)。

## 5 QA

**Q：删掉某个内置插件，界面具体会变成什么样？**
壳照常启动，对应槽位空着。两个典型：删掉 timeline，中区显示一行灰字"mainView 槽无贡献"；删掉 i18n，所有界面文案退化为显示 key 原文——i18next 配的英文回退（`fallbackLng: "en"`）也没有资源可回了。删哪个都不会崩，只是那块功能没了。

**Q：Windows / Linux 能跑吗？**
`npm run dist:all` 在一台 mac 上就能出齐三端安装包。代码层面已处理的跨平台点：win/linux 无边框窗口的自绘标题栏按钮、npm/pi CLI 的 `.cmd` 与 shell 差异、环境变量大小写（`Path` vs `PATH`）、窗口 icon 三端格式。依赖全是跨平台的（Electron / React / Node）。但 win/linux 未真机实测——"能出包"和"跑得好"之间还差一轮真机验证。

**Q：plugin、skill、extension 三个词是什么关系？**
分属两层。plugin 是 pi-desktop 的桌面插件——本文讲的全部内容。skill 和 extension 是 pi 底座的两类扩展资产（技能包和底座的 TypeScript 扩展），由底座定义和加载。内置的 skill-manager、extension-manager 是管理底座那两类资产的界面，它们自己是桌面插件。

**Q：`npm install` 时的 patch 脚本干了什么，安全吗？**
干的事在 `assets/scripts/patch-electron.cjs` 里全部可见：用 PlistBuddy 把 `node_modules/` 里 Electron.app 的 `CFBundleName` 和 `CFBundleDisplayName` 改成 "π Desktop"，换上项目图标，刷新 LaunchServices 缓存。只动本地 `node_modules`，找不到 Electron.app 就直接跳过，可重复执行。它只影响 dev 模式的显示名，不影响功能。

**Q：`packages/pi-cli/` 是空的，底座到底装在哪？**
dev 模式下，在设置页点安装后，底座从公共 npm registry 拉取、装进 `~/.pi-desktop/pi/`，不在仓库里。`packages/pi-cli/` 是打桌面安装包时存放底座副本的落点，仓库里刻意为空。

**Q：`@earendil-works/pi-coding-agent` 和 pi 是什么关系？**
pi 的上游是 Mario Zechner 发起的开源项目（[pi.dev](https://pi.dev)）。`@earendil-works/pi-coding-agent` 是 pi-desktop 实际拉取并驱动的底座分发包，发布在公共 npm registry——版本列表和安装都由 pi-manager 插件在应用内完成。

**Q：怎么写自己的第一个插件？**
最短路径：照 [docs/plugins/PLUGINS.md](docs/plugins/PLUGINS.md) 写 manifest 和 renderer，在 `src/plugins/` 的 28 个内置插件里挑一个职责相近的对照着写，然后把成品放进 `~/.pi-desktop/plugins/`（用户级）或项目根的 `.pi-desktop/plugins/`（项目级）。不需要改内核任何一行。
