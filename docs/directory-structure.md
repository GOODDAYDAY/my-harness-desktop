# my-harness-desktop 项目目录结构与设计风格

本文档是 CLAUDE.md §6「洋葱分区」的展开：把 my-harness-desktop 仓库的目录逐层说清，再把这套目录结构背后的设计风格信号提炼出来。目录结构在这里不是组织习惯，是纪律的物理载体——依赖方向、机制与内容分离、契约单源这些规则，最终都落在「哪个文件能 import 哪个文件」上。所以这份文档的读法是两条线并行：一条线是「每个目录/文件装了什么」，另一条线是「这个摆放位置本身说明了哪条纪律」。结论一律以当前代码为准，不以后面的历史文档为准。

## 0. 三个前置术语

读目录之前先把三个词钉死，否则目录名会误导：

- **内核（kernel）**：自洽的 AI agent 运行时，自带插件树、会话模型、能力集。pi 和 dsh 各是一个，同级。内核是被壳管理的**进程**，不是壳插件。物理上对应 `src/server/kernel/pi` 和 `src/server/kernel/dsh`。
- **壳（shell）**：薄壳，只提供机制——加载器、槽位契约、适配器装配、配置读写、权限沙箱。物理上对应 `packages/shared`（圆心）+ `src/server`（壳后端）+ `src/web`（前端）的机制代码。
- **壳插件（plugin）**：挂壳槽位的 UI 插件，只 import `@my-harness-desktop/shared` 和 `@my-harness-desktop/react`。内置壳插件在 `src/plugins/`，出 UI 的是壳插件，出能力（会话/工具/模型）的是内核。

还有一个贯穿全仓的坐标概念：**lineage**——会话里的一条线性历史，根 lineage 是最早那条，fork 出来的分支各是一条。pi 的 `parentId` 树和 dsh 的 session forest 是同一棵 lineage 树的两种存储。目录里反复出现的「中性」「中立契约」都指：去掉内核细节、只留结构化数据的那一层。

## 1. 顶层结构

仓库顶层只有三类东西：源码（`src/` + `packages/`）、仓库外围（`.claude/`、`assets/`、`scripts/`）、工程配置（`package.json`、`tsconfig.json`、`electron.vite.config.ts` 等）。

```
my-harness-desktop/
├── src/                     # 壳 + 内容层（源码主体）
│   ├── server/              # 壳后端（Electron main 或 Node 服务器双宿主）
│   ├── web/                 # 前端 renderer（React）
│   └── plugins/             # 内容层：50 个壳插件，按域分六组
├── packages/                # workspace 包（npm workspaces: packages/*）
│   ├── shared/              # 圆心发布面（纯类型 + 纯函数，零依赖）
│   ├── react/               # 前端发布面（React 组件/hooks/事件总线/PluginContext）
│   └── my-harness-fit-pi-extension/  # pi 内核的桌面适配扩展（非发布面）
├── .claude/skills/          # 内置 skills 源（随壳分发）
├── assets/                  # 外层资产：图标/贴纸/构建补丁脚本
├── scripts/                 # 开发环境引导脚本
├── docs/                    # 设计文档（真相源）
├── package.json             # workspace 根 + 依赖清单 + scripts
├── tsconfig.json            # 项目级 typecheck 基线 + 路径别名
└── electron.vite.config.ts  # 构建：main 双入口 + renderer
```

### 1.1 `src/` 与 `packages/` 的分工

- `src/` 是**应用代码**：壳后端、前端、内容层都在这里，靠 `@/` 别名（`src/*`）内部互引。
- `packages/` 是**被 import 的包**：`shared` 和 `react` 有 `package.json`，是 workspace 发布面；`my-harness-fit-pi-extension` 没有 `package.json`，不参与 npm 发布，它被 `src/server/kernel/pi/extension/` 的安装器整体同步进 pi 内核目录。

### 1.2 路径别名与 workspace

`tsconfig.json` 的 `paths` 钉了三个别名，这是「壳插件只从两个发布面 import」的物理保证：

```jsonc
"paths": {
  "@/*": ["src/*"],
  "@my-harness-desktop/shared": ["packages/shared/src/index.ts"],
  "@my-harness-desktop/react": ["packages/react/src/index.ts"]
}
```

`electron.vite.config.ts` 的 renderer 端也 mirror 了同一份 alias，理由写在注释里：**发布面直读源码，不依赖 node_modules 的 workspace link**，同时绕开 rollup 不 transform `node_modules` 内 `.ts` 的问题。也就是说 `packages/shared/package.json` 的 `"main": "src/index.ts"` 是给类型解析用的「真身直指」，构建时 alias 再指一遍，两头对齐，不存在「发布面指向编译产物、源码改了产物没变」的漂移窗口。

### 1.3 构建的三个入口

`electron.vite.config.ts` 的 `main.build.rollupOptions.input` 声明了三个 main 侧入口，产物都是 CJS：

- `src/server/bootstrap/electron.ts` → `out/main/index.js`（`electron .` 启动）
- `src/server/bootstrap/server.ts` → `out/main/server.js`（`node out/main/server.js` 启动，无 Electron 环境）
- `src/server/preload.ts` → preload 脚本

renderer 侧入口是 `src/web/index.html`，`root` 直接指向 `src/web`。这份配置的核心信号是**双宿主**：同一个壳后端，既能在 Electron 里跑，也能在纯 Node 服务器里跑，差异被收敛到 `bootstrap/` 的两个入口 + `host/` 的两个实现。

## 2. 依赖方向总图（洋葱）

整套目录的第一性原理是：**依赖箭头永远指向圆心，内层绝不 import 外层**。把仓库按稳定度排成同心圆，物理目录就是这些圆：

```
                 ┌───────────────────────────────────────┐
                 │  src/plugins/      （内容层，最外）     │
                 │   50 个壳插件，只 import shared + react │
                 │  ┌─────────────────────────────────┐   │
                 │  │  src/server/ + src/web/（壳）     │   │
                 │  │   application / kernel / client  │   │
                 │  │   controllers / transport / host │   │
                 │  │   routing / remote / bootstrap   │   │
                 │  │  ┌───────────────────────────┐   │   │
                 │  │  │  packages/react（发布面）  │   │   │
                 │  │  │  ┌─────────────────────┐  │   │   │
                 │  │  │  │ packages/shared      │  │   │   │
                 │  │  │  │   ┌───────────────┐ │  │   │   │
                 │  │  │  │   │ domain/ 圆心  │ │  │   │   │
                 │  │  │  │   │（零依赖纯类型）│ │  │   │   │
                 │  │  │  │   └───────────────┘ │  │   │   │
                 │  │  │  └─────────────────────┘  │   │   │
                 │  │  └───────────────────────────┘  │   │
                 │  └─────────────────────────────────┘   │
                 └───────────────────────────────────────┘
```

谁依赖谁，从外到内一句话版：

- **壳插件** → 只 import `@my-harness-desktop/shared` + `@my-harness-desktop/react`，绝不 import `@/server/...`。
- **壳后端（`src/server`）** → import `packages/shared`；`application/` 不 import 具体内核实现；`kernel/core/` 不 import `pi`/`dsh`。
- **前端（`src/web`）** → import `packages/shared` + `packages/react`，不 import `src/server`。
- **`packages/react`** → import `packages/shared`（+ `react` 本体）。
- **`packages/shared`** → 零依赖（`dependencies: {}`），`domain/` 内部零外部 import。
- **`bootstrap` / `kernel/factories`** → 唯一被允许「同时 import 圆心契约和具体实现」的地方——因为组装是它的职责。

这张图不是美学，是变更隔离：换内核（pi→dsh→第三个）、换框架（React→Vue）、换运行时（Electron→Tauri），冲击都被各层吸收，圆心一行不改。后面每一节都在为这张图补证据。

## 3. packages/shared —— 圆心发布面

```
packages/shared/
├── package.json          # name=@my-harness-desktop/shared, "dependencies": {}
└── src/
    ├── index.ts          # 发布面：纯 re-export，一行逻辑没有
    ├── channel/          # 通道契约（channel 名单源 + 元数据）
    ├── contract/         # 配置路径契约 + 样式预设清单
    ├── domain/           # 圆心：纯类型 + 纯函数，零依赖
    │   ├── events/       #   中性事件类型
    │   └── slots/        #   主题 token 清单
    └── wire/             # 线协议序列化（parse/serialize）
```

`package.json` 的两个字段定义了它的性质：`"main": "src/index.ts"`（发布面直指源码，无编译产物），`"dependencies": {}`（零依赖，这是「圆心不能 import 任何东西」的包级表达——即便想 import 也没得 import）。`src/domain/` 是整个仓库最内层的一环，物理上放不下 `electron`、`react`、`better-sqlite3`，这是「依赖只向内」的第一道、也是最硬的一道防线。

### 3.1 `index.ts`：发布面是投影不是副本

`packages/shared/src/index.ts` 全文 43 行，全部是 `export * from "./..."` 和带注释的分组。它是「契约单源」的直接落地：概念在 `domain/` 定义一次，这里只 re-export，一行逻辑都没有。发布面是投影不是副本——概念改一次，所有引用处（前端、壳后端、壳插件）同时变，不存在「改了圆心忘了改发布面」。

### 3.2 `domain/`：逐文件

`domain/` 是圆心。装的东西只有两类：**纯类型**（契约、事件、配置形状）和**纯函数**（无 IO、无环境、无状态）。没有任何一个文件 import 外部包。逐文件过一遍：

- **`kernel.ts`**（内核身份单源，最内层原子）：`KernelId = "pi" | "dsh"` + `KERNEL_IDS` 常量 + `KernelLogo` 接口。全仓唯一一处能出现 `"pi" | "dsh"` 字面量联合的地方。它零依赖——不 import 任何 domain 内外的类型。加第三个内核 = 这里加一个字面量，编译器逼着补全所有 `switch(kernel)` 消费处。
- **`backend.ts`**（中立契约核心）：`BaseBackend` 接口（14 必实现 + 4 缺面默认 `listTools?`/`answerQuestion?`/`continue?`/`setThinkingLevel` + 接口可选 `resume?` + 能力探测 `capabilities`）、`BackendFactory`、`BackendCreateOptions`、`SessionCatalog`、`SessionCatalogFactory`、`KernelModelSource`、`Lineage`/`LineageTree`/`LineageFork`、`Anchor`（= `NeutralAnchor` re-export）、`SeedOptions`、`DshCapabilities`、纯函数 `projectLineageTree`。这是壳和内核之间的「最小意图」集合——消息/中断/模型/分支/会话标识/流式事件六条核心，之上叠命名、续跑、seed、工具发现、提问、能力探测。
- **`session-neutral.ts`**（中立会话坐标系）：`NeutralSession` / `NeutralAnchor` / `NeutralEntry` / `NeutralSessionHeader` + 纯函数（`neutralEntryId`、`lineageContent`、拓扑排序 `sortLineagesTopologically`）。这是「中立契约的另一半」：把消息/事件/树形投影都落到内核无关的坐标系。
- **`sessions.ts`**（会话能力契约）：`SessionsApi` / `MessagingApi` / `ModelApi` / `SessionTreeApi` / `PiExtensions` / `BashApi` 等壳暴露给插件的 API 形状。圆心只定义接口，实现归 `application/sessions/session-store`（依赖倒置）。
- **`kernel-manager.ts`**（内核版本管理契约）：`KernelSpec` 纯数据（包名/路径段/cli.js 位置）+ `RegistryVersions` + `CustomCliResolution`。pi/dsh 共用同一套版本管理机制，差异只是「包名 + 安装路径段 + cli.js 位置」这几条数据。
- **`contributions.ts`**（槽位贡献项类型契约）：`SlotName` 联合 + 全部槽位贡献项接口（`SettingsContribution`、`ThemeContribution`、`SidePanelContribution`、`MainViewContribution`、`SidebarContribution`、`LanguageContribution`、`TitlebarContribution`、`FileActionContribution`、`FileIconContribution`、`MessageActionContribution`、`BlockRendererContribution`、`CodeBlockRendererContribution`、`SessionGroupingContribution`、`ComposerPolicyContribution`、`ComposerAttachmentContribution`、`ComposerActionContribution`、`ComposerStatsContribution`、`ComposerTopContribution`、`ComposerVoiceContribution`、`SystemPromptContribution`、`FontPresetContribution`、`SettingsGroupContribution` 等）+ `PluginManifest` + `PluginTier`/`PluginState`/`PluginListItem` + 纯函数 `derivePluginTags`/`resolvePluginTags`。这是「槽位是稳定契约」的圆心落点。
- **`events/session-state.ts`**（中性事件 + 状态投影类型）：`SessionEvent` / `NeutralMessage` / `ModelInfo` / `TreeNode` / `SyncSnapshot` / `SessionStats` / `TurnUsage` 等 + 纯函数 `deduplicateAdjacent`。所有内核的事件都往这里投，壳只认中性域。
- **`events/kernel-event.ts`**（统一内核事件抽象）：`KernelEvent` 联合 + `Question`/`QuestionAnswer`/`QuestionRequestEvent` 等提问帧类型。
- **`events/session-bus.ts`**（Session Bus 中性契约）：会话间消息信封、地址、tap 闸门级别的唯一类型源。
- **`host.ts`**（宿主能力接口）：`Host` 接口——生命周期/窗口/对话框/通知/shell/app 等运行时环境能力。这是「机制而非内容」：宿主只提供环境能力，不含业务逻辑。
- **`context.ts`**（PluginContext 契约）：插件能调用的 API 接口（圆心拥有，零外部依赖）。`PluginContext` 分三层：pluginId 绑定层（config/fs/git/bash）、系统级 API 层（prefs/themes/kernel/sessions 等）、事件层（events）。
- **`layout.ts`**（动态布局引擎中性类型与纯函数）：`LayoutNode` / `LayoutSplit` / `LayoutGroup` / `ViewInstance` / `OpenViewRequest` / `LayoutApi`。页面是一棵布局树：根递归分屏，叶为视图组。
- **`extensions.ts`**（内核拓展管理类型契约）：多内核统一的内核扩展管理类型。
- **`restart.ts`**（重启协调器类型契约）：`RestartCoordinator` / `SessionStoreForRestart` 类型。
- **`remote.ts`**（web 服务化线协议类型）：远程访问的对接契约，纯类型零依赖，不 import `electron`/`react`/`ws`。
- **`skills.ts`**（技能中立契约）：`SkillProvider` 接口 + 中性 `SkillInfo`。壳只认 provider 接口，不读任何内核的技能存储。
- **`aux-blocks.ts`**（结构化块机制纯函数）：用户消息里「机器可识别、对用户是噪声」的结构化块解析（`parseUserBlocks`）。
- **`bookmark-snapshot.ts`**（收藏快照纯函数 + 文件格式）：`materializeLineagePrefix` + 快照往返。
- **`composer-commands.ts`**（输入框斜杠命令契约）：纯类型 + 纯函数。
- **`composer-files.ts`**（输入框附件文件分类纯函数）：`classifyReferenceFile`，main 与 renderer 共用。
- **`custom-order.ts`**（自定义顺序归位纯函数）：`applyCustomOrder`，拖拽排序插件共用的唯一实现。
- **`file-icons.ts`**（fileIcons 槽解析纯函数）：把贡献项清单摊平成「文件名/扩展名 → 图标」索引。
- **`path-utils.ts`**（跨平台路径纯函数）：`pathBasename` 等，零依赖、不感知运行平台。
- **`text.ts`**（文本工具纯函数）：消息内容提取/截断/预览，零依赖叶子模块。
- **`working-phase.ts`**（会话工作阶段状态纯函数）：`WorkingPhase` 推导，与 `SessionState.isStreaming` 同级。
- **`slots/theme-tokens.ts`**（主题 token 清单）：圆心拥有的稳定视觉契约。注意：这里的 `THEME_TOKEN_DEFAULTS` 兜底色值是圆心内容泄漏的历史残留，标注演进待收（CLAUDE.md §7.1）。

`domain/` 里每个 `.ts` 旁边都有一个 `.test.ts`（`aux-blocks.test.ts`、`backend.test.ts`、`session-neutral.test.ts` 等），测试与源码同目录，且测试策略是「domain 测试 95%+ 零 mock」——因为纯函数不需要 mock 环境，这本身就是「这个文件该在内层」的判据。

### 3.3 `channel/`、`contract/`、`wire/`：三个配套面

- **`channel/channel-contract.ts`**：通道名单源。原在 `api/preload/ipc-channels.ts`（Electron IPC 细节），去 IPC 后上提为「对接契约清单」——channel 名是前后端共享的常量地图，不再绑 Electron。
- **`channel/channel-meta.ts`**：channel 元数据契约——事件总线 channel 的可读描述，供快捷键/命令面板类插件「动态列出全部可用事件」。
- **`contract/paths.ts`**：桌面级通用配置文件路径单源（`GENERAL_CONFIG_PATH` 等）。manifest 的 `configFile` 是 JSON 声明无法 import，所以这个常量是给代码侧消费方统一引用的。
- **`contract/style-presets.ts`**：样式预设清单（左栏/右面板风格预设）的唯一 TS 源。样式内容的真源在 `src/web/index.css`，这里是「预设 id → 语义」的契约层。
- **`wire/wire.ts`**：线协议序列化（`parse`/`serialize`），`文本 ↔ WireMessage` 的边界校验。纯函数零依赖，不 import `ws`/`http`/`electron`——JSON 是传输细节，这里是语义边界。

## 4. packages/react —— 前端发布面

```
packages/react/
├── package.json              # name=@my-harness-desktop/react, deps: react + shared
└── src/
    ├── index.ts              # 发布面（544 行：KernelApi 形状 + 全量 re-export）
    ├── plugin-context.ts     # usePluginContext()——壳插件唯一 API 入口
    ├── plugin-id-context.ts  # PluginIdContext / usePluginId——pluginId 自动注入
    ├── event-bus.ts          # 事件总线（emit/invoke/replayLast）
    ├── plugin-modules.ts     # 组件注册/查组件（自动匹配的机制面）
    ├── plugin-overlays.tsx   # 插件浮层
    ├── error-boundary.tsx    # 错误边界
    ├── aux-block-parsers.ts  # aux 块解析器注册
    ├── composer-*.ts         # 各 composer 槽的 hook（查槽 + 渲染分发）
    ├── file-actions.ts / file-icons.ts / message-actions.ts
    ├── block-renderers.ts / code-block-renderers.ts / session-groupings.ts
    ├── settings-groups.ts / settings-section.tsx / list-item.tsx / inline-confirm.tsx
    ├── kernel-extensions-page.tsx
    ├── manager/              # 内核管理共享 base（设置页三 TAB 骨架）
    │   ├── kernel-version-page.tsx
    │   ├── model-config-page.tsx
    │   └── kernel-config-form.tsx
    ├── panel/                # 右面板通用组件（PanelRow/PanelToolbar/PanelTabs…）
    └── widgets/              # 通用 UI 组件（Button/Select/Toast/FileTree/SortableList…）
```

`packages/react/src/index.ts` 是这个包的全部真相。它分两块：

- **`KernelApi` 接口**（1–289 行）：`window.kernel` 的完整形状——config/prefs/themes/settings/slots/sessions/bus/fs/git/gitWrite/llm/dialog/plugins/kernelExtensions/restart/skills/remote/window/notify/app 等全部能力面。这是「前端经 `window.kernel` 访问壳后端」的契约单源。
- **全量 re-export**（305–544 行）：从 `@my-harness-desktop/shared` re-export 类型与常量，从 `../../../src/web/stores/*` re-export 框架 store（`useUiStore`/`useLayoutStore`/`useSessionStore`），从本包各文件 re-export 组件与 hook，末尾还有框架自动注册的机制函数（`registerPluginComponents`/`registerMessageRenderer` 等）。

这个发布面的性质：它是**壳插件能碰到的全部 API 边界**。壳插件 import 它，拿到的是一套受控 API + 通用组件 + 查槽 hook，而不是 `window.kernel` 裸对象。`plugin-context.ts` 的 `usePluginContext()` 在这里，`PluginIdContext` 也在这里——pluginId 由框架自动注入，插件代码里不出现自己的 plugin id 字符串。

一个值得注意的细节：`packages/react/package.json` 的 `dependencies` 里有 `"@my-harness-desktop/contract": "0.4.9"`（历史遗留的旧包名，现已被 `shared` 取代），而 index.ts 实际 import 的是 `@my-harness-desktop/shared`——这是发布面演进过程中残留的一处不一致，不影响运行（构建走 alias），但说明「发布面命名收敛」还没有 100% 收尾。

## 5. packages/my-harness-fit-pi-extension —— pi 内核扩展

```
packages/my-harness-fit-pi-extension/
├── index.ts        # 统一入口：单一 input 钩子 + kind 分派
├── runtime.ts      # 共享机制（formatFrame/takePending/BusFrame/ExtensionApi，契约单源）
├── toolgate.ts     # toolgate 能力
├── context-probe.ts# context-probe 能力
├── bus.ts          # bus 能力（会话间消息）
├── subagent.ts     # subagent 能力（子代理）
├── skills.ts       # skills 能力
├── scanner.ts      # 扫描器
├── tools/          # 暴露给 pi 内核的工具（spawn-subagent/send-to-subagent/session-create…）
└── skills/         # 内置 skills 源（delegate-task/orchestrate/parallel-fanout…）
```

这个包**没有 `package.json`**，不参与 npm 发布。它是 pi 内核的「桌面适配扩展」——把原来的 tool-gate / context-probe / bus-extension / subagent-extension / skills-extension 五个独立内核扩展合并成单一扩展：一个目录、一个 `index.ts` 入口、一个 installer 交付。五能力拆成五个模块，共享机制收敛到 `runtime.ts`（契约单源）。`index.ts` 的 `export default function (pi: ExtensionApi)` 是唯一入口，内部用一个单一 input 钩子做 `$bus` 帧路由（响应帧吞帧 resolve，事件帧人话化 transform），消掉了原 bus/subagent 各自挂钩子导致的「谁先谁后」时序脆弱。

它经 `src/server/kernel/pi/extension/my-harness-fit-pi-extension-installer.ts` 在 app 启动时同步到 `~/.pi/agent/extensions/my-harness-fit-pi-extension/`。定位上它是「内核插件」而非「壳插件」——给 pi 内核补能力，不出 UI，壳对它只经内核侧间接感知。

## 6. src/server —— 壳后端

`src/server` 是壳的机制主体，从旧架构（`core/` + `api/` + `client/` + `bootstrap/`）重构归位后，变成现在的九个顶层目录：

```
src/server/
├── application/    # 用例编排（loader/registry、sessions、models、i18n、skills、theme、config…）
├── kernel/         # 内核层（core + pi + dsh + factories）
├── client/         # 流出适配器（fs/git/npm/remote）
├── controllers/    # 网关 handler（原 api/ipc/，按能力域分文件）
├── transport/      # HTTP + WS（前后端分离新增）
├── host/           # Host 接口实现（electron-host + node-host）
├── remote/         # 远程访问鉴权
├── routing/        # gateway + broadcast
├── bootstrap/      # 组装根（assemble.ts + electron.ts/server.ts 双入口）
├── preload.ts      # Electron preload 脚本
└── seed-transcription.test.ts
```

### 6.1 `application/` —— 用例编排层

「用例编排」是「业务规则（圆心）→ 用例编排（这里）→ 基础设施（kernel/client）」三段里的中间层。它不 import `electron`/`react`，也绝不 import 具体内核实现（`kernel/{pi,dsh}` 的非 type-only import 是红线）。逐子目录：

- **`config/`**：配置读写。`config-file.ts` 提供 `readJsonFile`/`writeJsonFile`/`withDirLock`/`appendJsonlLine` 四个原语（所有 store 都调这些原语，是「配置读写单源」）；`config-store.ts` 是插件配置存储（统一项目级配置通道）；`json-merge.ts` 是深合并（deepmerge 包，数组整替）；`json-prefs.ts` 是简单键值偏好（替代 electron-store，不 import electron）；`paths.ts` 是桌面数据根路径单源（打包态 `~/.my-harness-desktop`，dev 态 `~/.my-harness-desktop-dev`）。
- **`loader/`**：插件发现与注册。`discover.ts` 扫描插件目录取 manifest，`registry.ts` 聚合发现结果供渲染层查询。
- **`sessions/`**：会话管理。`session-store.ts` 是多会话多进程调度核心（只依赖 `BaseBackend` + `BackendFactory` 接口）；`neutral-session-store.ts` 是中立会话树的持久化存储（壳自己的存储，不读内核存储）；`bookmark-snapshot-store.ts` 是收藏快照的文件 CRUD；`session-bus.ts` 是 Session Bus 路由器（会话间消息路由 + 房间 + tap）。
- **`models/`**：`model-catalog.ts` 合流 pi（models.json）+ dsh（cordis.yml llm-deepseek）两路模型清单成带 kernel 标的清单，只依赖 `KernelModelSource` 接口。
- **`i18n/`**：`merge.ts` 把各插件 languages 贡献项合并成 i18next resources；`translator.ts` 持 i18next 单例 + 检测 + 查文案。
- **`theme/`**：`merge.ts` 是主题合并（buildCurrentTheme 的家）；`contrast.ts` 是 WCAG AA 对比度审计。
- **`skills/`**：`skill-aggregator.ts` 壳侧技能聚合器（只依赖 SkillProvider 接口）；`bundled-skills.ts` 内置 skills 同步；`skill-frontmatter.ts` pi/dsh 共用的 SKILL.md frontmatter 单字段改写。
- **`extensions/`**：`kernel-extension-manager.ts` 内核拓展管理基类（机制，不含具体内核）。
- **`lifecycle/`**：生命周期管理。
- **`restart/`**：`restart-coordinator.ts` 追踪 pending restart + 事件驱动空闲重载。
- **`installer/`**：插件安装。
- **`bundled/`**：`mirror.ts` 受管目录镜像（把内置资源镜像到用户数据目录）。
- **`context/`**：`main-context.ts` main 进程上下文契约——各注册器共享的依赖面，契约声明在消费侧，bootstrap 负责组装实现并注入（依赖倒置）。

### 6.2 `kernel/` —— 内核层

这是多内核架构的心脏。`kernel/` 装内核的 backend/catalog/protocol/manager/model/extension 全部实现，`core/` 是骨架（只 import `packages/shared`，绝不 import `pi`/`dsh`）。

**`kernel/core/`（骨架，不 import 具体内核）**：

- `abstract-backend.ts`：`AbstractBackend` 抽象基类——`BaseBackend` 契约的骨架 + 缺面默认（14 条 abstract + 4 条缺面默认 + 3 个默认成员）。这是「接口 → 抽象基类 → 具体实现」三段式的中段。
- `kernel-manager.ts`：`KernelManager` 基类——装/查/状态合成机制，注入 `KernelRuntime`。
- `kernel-runtime.ts`：`kernel 运行时抽象`——application 层拥有的依赖倒置接口（`installNpm` + `fetchRegistryVersions`）。
- `kernel-reconcile.ts`：冷启动对账——启动后异步扫描已装状态，缺失则按 dist-tag 最新版自动补装。
- `kernel-extension.ts`：内核扩展入口发现（壳子统一层）。

**`kernel/pi/`（pi 内核实现）**：

- `backend/pi-backend.ts`：`PiBackend extends AbstractBackend` + `implements PiBackendExtensions`——BaseBackend 的 pi 实现。
- `backend/pi-catalog.ts`：`PiSessionCatalog implements SessionCatalog`——pi 的跨会话目录/CRUD。
- `backend/correlator.ts`：pi 事件相关性处理。
- `backend/rpc-adapter.ts`：RPC 适配——构造命令对象但不 spawn 进程（构造与执行分离）。
- `backend/subprocess-handle.ts` + `subprocess-lifecycle.ts`：进程句柄接口 + 进程生命周期。
- `backend/pi-backend-extensions.ts`：pi 扩展面（steer/followUp/thinkingLevel 等）。
- `backend/resync.ts`：pi 基线重同步。
- `protocol/`：pi 的 31 命令契约——`rpc-types.ts`（pi 消息类型）、`commands.ts`（命令构造纯函数）、`event-translator.ts`（pi 事件 → 中性事件）、`context-binding.ts`（RPC 对象 → domain 类型映射）、`versions.ts`。
- `manager/pi-kernel.ts`：`PiKernelManager extends KernelManager`（填 `PI_SPEC` + `postInstall`）；`pi-kernel-api.ts`/`pi-kernel-config.ts`/`pi-logo.ts`/`pi-cli.ts`。
- `model/`：`models-store.ts`/`pi-settings-store.ts`/`pi-model-source.ts`（`implements KernelModelSource`）/`models-config.ts`/`known-tools.ts`。
- `extension/`：`pi-extension-installer.ts`、`my-harness-fit-pi-extension-installer.ts`、`pi-extension-manager.ts`、`pi-bundled-skills.ts`、`pi-skill-provider.ts`、`pi-oneshot.ts`、`patch-rpc-mode.ts`。

**`kernel/dsh/`（dsh 内核实现）**：

- `backend/dsh-backend.ts`：`DshBackend extends AbstractBackend`——BaseBackend 的 dsh 实现。
- `backend/dsh-catalog.ts`：`DshSessionCatalog implements SessionCatalog`。
- `backend/dsh-event-translator.ts`：dsh 事件 → 中性事件。
- `backend/dsh-config-source.ts`：cordis.yml + settings.yaml，`implements KernelModelSource`。
- `backend/subprocess-lifecycle.ts`：进程生命周期。
- `protocol/json-rpc.ts`：JSON-RPC 2.0 行传输（消费 SubprocessHandle 收发 newline-delimited JSON-RPC）；`protocol/dsh-methods.ts`：`DSH_METHODS` 方法名常量枚举（「dsh 方法单源」）。
- `manager/dsh-kernel.ts`：`DshKernelManager extends KernelManager`（填 `DSH_SPEC` + `installPlugin`）；`dsh-kernel-api.ts`/`dsh-kernel-config.ts`/`dsh-logo.ts`/`dsh-question-bridge.ts`。
- `extension/`：`dsh-extension-installer.ts`/`dsh-extension-manager.ts`/`dsh-extension-manifest.ts`/`dsh-extension-contract.ts`/`dsh-skill-provider.ts`。

**`kernel/factories/`（组装）**：

- `kernel-factories.ts`：后端工厂——把「怎么 spawn、怎么翻译」收成一个实现，产出 `BaseBackend`。这是「构造在内、执行在外」的组装点：内核专属 args（cliPath/cordisConfig/apiKey）在这里的工厂闭包里捕获，不进契约。
- `kernel-managers.ts`：把具体内核的 spec + postInstall 实现绑成 `KernelManager` 实例。
- `kernel-logos.ts`：内核身份标（logo）注册表——把各内核在自己适配器里声明的 logo 绑成一份按 `KernelId` 键控的映射。

关键纪律：`core/` 一行不 import 具体实现，`factories/` 是唯一被允许「同时 import 圆心契约和具体实现」的地方，`bootstrap/` 调 factories。这是「接口定义在内层、实现在外层、组装在最外层」的物理形态。

### 6.3 `client/` —— 流出适配器

与内核并列的外层适配器（内核和 git、文件系统是同一层抽象，都是「被壳管理的资源」）：

- `fs/`：`fs-ops.ts`（项目目录内文件增删改读，`fs:project` IPC 实现）、`fs-sync.ts`（同步 fs 原语，服务 pi 会话存储层）、`fs-tree.ts`（目录树递归 walk）。
- `git/`：`git-status.ts`（git 状态）、`git-write.ts`（git 写，commit/push）。
- `npm/`：`kernel-runtime.ts`（`KernelRuntime` 实现——`installNpm` + `fetchRegistryVersions`）。
- `remote/`：`lan-ip.ts`（局域网 IP）、`qr.ts`（二维码生成）。

### 6.4 `controllers/` —— 网关 handler

原 `api/ipc/` 重构归位，按能力域分文件。这是权限校验的边界——壳插件声明了权限但用户不授权，handler 在这里直接拒绝。逐文件：

- `sessions.ts`：会话域（`session.*`/`sessions.*` 全部 handler，SessionStore 单持的实现面）。
- `config.ts`：插件配置（config）+ 桌面偏好（prefs）+ 通用 JSON 配置文件（configFile）+ 分层配置。
- `kernel.ts`：内核管理 + 内核 settings/models 配置（`kernel.*`/`kernelModels.*`/`kernelConfig.*`）。
- `plugins.ts`：插件生命周期（plugins.*）。
- `extensions.ts`：内核拓展管理（kernelExtensions.*）+ restart 协调（restart.*）。
- `skills.ts`：Skills 管理（skills.*）——经聚合器消费内核回报 + 转发开关意图。
- `fs-git.ts`：`fs:project` + `git:read`/`git:write` 声明能力——权限门控 + 路径圈禁在边界。
- `bus.ts`：Session Bus 插件面（sessions:bus 声明权限门控）。
- `appearance.ts`：外观三件套——i18n 资源/语言列表、主题构建、settings 槽清单。
- `app-info.ts`：应用基本信息（经 `conn.host.app`，不直接 import electron）。
- `notification.ts`：系统通知（纯机制，文案由调用方传）。
- `window.ts`：窗口控制（经 `conn.host`）。
- `slots-dialog.ts`：槽位清单（Core）+ 系统对话框/文件管理器（Host）。
- `remote.ts`：远程访问控制面（remote:* handler）。

### 6.5 `transport/` —— HTTP + WS

前后端分离后新增的传输层。基础设施层，这里才 import `node:http`/`ws`：

- `http/http-server.ts`：静态文件 + 状态服务。import `node:http`/`fs`/`path`，不 import electron。
- `ws/ws-server.ts`：`/rpc` 的 WebSocket 服务——WS 升级 + 帧解析 → 网关。这里才 import `ws`（「网关不 import ws/http，这里收传输」）。

### 6.6 `host/` —— Host 接口实现

「机制而非内容」的宿主层。`Host` 接口（在圆心 `domain/host.ts`）提供生命周期/窗口/对话框/通知/shell/app 等环境能力，两个实现：

- `electron-host.ts`：Electron 实现（本地连接用的真值实现）。
- `node-host.ts`：Node 服务器缺省降级实现——窗口/对话框/shell 全 `UNSUPPORTED_HOST`，notify no-op，lifecycle 绑 SIGINT/SIGTERM。

### 6.7 `remote/` —— 远程访问鉴权

- `auth.ts`：打包本地 token + serverSecret + 限速器 + 密码校验 + token 签发。
- `token.ts`：HMAC 会话 token（base64url(payload) + hmac 签名，serverSecret 每次启动随机 → token 绑定进程）。
- `password.ts`：密码哈希与强度策略（scrypt + 随机盐，常量时间比较）。
- `rate-limiter.ts`：失败限速器（同 key 连续 5 错锁 60s）。
- `remote-config.ts`：`remote.json` 读/写（密码以 hash 存，不存明文）。
- `net.ts`：远程来源判定与 cookie 解析（http 与 ws 两个传输共用，单源）。

### 6.8 `routing/` —— 网关编排

- `gateway.ts`：channel → handler 分发表 + 鉴权 + 广播扇出。只依赖 domain + 注入的 token 校验策略，不 import ws/http/electron。
- `broadcast.ts`：广播助手——配置写后/插件生命周期/kernel 状态变化时经 gateway 推所有连接。

### 6.9 `bootstrap/` —— 组装根

- `assemble.ts`：共享组装——stores + ctx + gateway + handlers + 起服务器，零 electron。electron.ts/server.ts 各注入一份 Host + isPackaged，共用本组装。
- `electron.ts`：Electron main 入口——调 assemble + 开窗 + app 生命周期。
- `server.ts`：Node 服务器入口——注入 Node 宿主 + 绑信号优雅退出。

组装根的目标是「极薄」：它是「怎么拼」，不是「怎么干」。全部 store/registry/coordinator 的构造、MainContext 注入、内核注册表（调 `kernel/factories`）都在这里，但没有任何一个具体 handler 的实现、任何业务规则。

## 7. src/web —— 前端 renderer

```
src/web/
├── index.html               # renderer 入口
├── index.tsx                # 前端引导（React 挂载）
├── app-main.tsx             # 应用主体
├── bootstrap.ts             # 前端启动
├── login-gate.ts            # 登录门（远程访问）
├── index.css                # 全局样式（Tailwind）
├── app/                     # 应用级机制
│   ├── plugins-host.ts      #   插件宿主（加载/激活壳插件 renderer module）
│   ├── i18n-init.ts         #   i18n 初始化
│   ├── ui-store.ts          #   UI store（useUiStore）
│   └── theme-context.tsx    #   主题上下文
├── components/              # 壳的骨架组件（布局机制，非内容）
│   ├── layout-engine.tsx    #   动态布局引擎渲染
│   ├── sidebar.tsx          #   左栏容器
│   ├── right-panel.tsx      #   右面板容器
│   ├── settings-page.tsx    #   设置页容器
│   └── titlebar.tsx         #   标题栏容器
├── kernel/                  # window.kernel 的构造
│   └── build-kernel.ts      #   把 KernelApi 绑到 window.kernel
├── stores/                  # 框架 store（插件只读，不写 setter）
│   ├── ui-store.ts          #   useUiStore
│   ├── session-store.ts     #   useSessionStore
│   ├── layout-store.ts      #   useLayoutStore
│   ├── general-config.ts    #   通用配置
│   └── kernel-logos.ts      #   内核 logo store
├── transport/               # 前端传输
│   └── ws-transport.ts      #   WebSocket 传输
└── ui/                      # 极少量 UI 原子（button/chat-row）
    ├── button.tsx
    └── chat-row.tsx
```

前端的关键纪律是「**壳的组件是容器，内容是插件**」：`components/` 里的 `layout-engine.tsx`、`sidebar.tsx`、`right-panel.tsx`、`settings-page.tsx`、`titlebar.tsx` 全是**空容器**——它们只做布局和查槽，不画任何业务内容。中区主视图内容由 timeline 插件经 `mainView` 槽贡献，左栏由 sessions-list/projects 插件经 `sidebar` 槽贡献，右面板各 Tab 由会话树/git-review/token-stats 等插件经 `sidePanel` 槽贡献。`ui/` 目录只有 `button.tsx` 和 `chat-row.tsx` 两个原子，说明壳自己的 UI 含量被压到了极低——这与「壳的功能含量趋近于零」的铁律对应。

`app/plugins-host.ts` 是前端侧的插件加载机制：发现、校验、注册、生命周期、组件自动匹配、channel 注册都在这里。`kernel/build-kernel.ts` 把 `KernelApi` 绑到 `window.kernel`，这是前端与壳后端的唯一通道。`stores/` 是框架状态，插件只能读（`useUiStore`/`useSessionStore`），不能调 setter。

## 8. src/plugins —— 内容层

`src/plugins/` 是「一切功能」的家，按域分六组，50 个壳插件。这是「机制与内容分离」的内容侧：壳的所有业务内容（文案、配色、管理页、渲染逻辑、业务分支）都外挂在这里，删掉任何一个内置壳插件，壳照常启动，只是少了那块功能。

### 8.1 插件内部结构：四件套

一个功能收进同一个壳插件目录，内部按需四件（高内聚）：

```
src/plugins/{domain}/{feature}/
├── plugin.json        # manifest（声明 id/contributes/permissions/piExtension/dshExtension）
├── renderer/          # desktop 壳插件（UI 组件 + 槽位贡献 + 事件，index.tsx 是入口）
├── locales/           # i18n 文案（desktop UI 文案，zh-CN/en/de/zh-TW 四个 locale）
├── pi-extension/      # pi 内核插件（给 pi 补能力的 TS 扩展）
├── dsh-extension/     # dsh 内核插件（给 dsh 补能力的 Cordis 插件）
└── core/              # 纯逻辑（可被 renderer/pi-extension 共享的纯函数，可无）
```

参考实现：`sessions/goal/`（`core/` + `renderer/` + `pi-extension/` + `dsh-extension/`）、`insight/llm-recorder/`（`core/` + `renderer/` + `pi-extension/` + `locales/`）、`sessions/sub-agent/`（`client/` + `core/` + `tools/` + `renderer/`）。「四件套」的意图是：一个功能的所有内核侧适配都内聚在同一个 plugin 下，改功能只动一个 plugin，动不到壳的内核。`plugin.json` 里的 `piExtension` / `dshExtension` 字段声明插件携带的内核扩展目录，框架在 activate 时同步、deactivate 时摘除。

### 8.2 `themes/`（9 个，配色 + 字体）

- **`theme`**（id: theme）：主题槽的基准实现，`theme.dark` 暗色基准主题 + token 基准。
- **`theme-chatgpt`**（ChatGPT Dark）：ChatGPT 风格暗色主题。
- **`theme-everforest`**（Everforest Dark）：Everforest 配色主题。
- **`theme-midnight`**（Midnight Dark）：午夜蓝主题。
- **`theme-mocha`**（Mocha Dark）：摩卡主题。
- **`theme-new-york`**（New York Dark）：New York 风格主题。
- **`theme-stone`**（Stone Dark）：石头灰主题。
- **`theme-terminal`**（Terminal Dark）：终端风格主题。
- **`font-presets`**：字体预设槽贡献（等宽/英文/中文三组字体栈）。

这九个插件证明了「配色是会变的内容」：八套主题全是同一 `themes` 槽的贡献项，走同一套 token 契约 + 同一套合并逻辑，改配色只动对应主题插件的 `tokens` 字段，壳一行不动。

### 8.3 `sessions/`（18 个，会话流的一切）

- **`timeline`**：主视图时间线（经 `mainView` 槽贡献中区会话消息流，是会话流的骨架 + 块渲染分发中枢）。
- **`message-blocks`**：块级渲染器（工具卡/思考链/用户气泡/文本/分隔线五种块类型的渲染，经 `blockRenderers` 槽）。
- **`markdown`**：Markdown 文本渲染器。
- **`mermaid`** / **`puml`** / **`graphviz`**：三个围栏语言渲染器（经 `codeBlockRenderers` 槽，把 ```mermaid/```puml/```dot 渲染成图）。
- **`im-graph`**：交互式图/思维导图（client + core + renderer，较重的一个）。
- **`sessions-list`**：会话列表（左栏 `sidebar` 槽）。
- **`session-tree`**：会话树（右面板 `sidePanel` 槽，展示 lineage 树）。
- **`session-bookmarks`**：会话书签（书签快照的 UI 面）。
- **`session-colors`**：会话配色（给会话标色的纯逻辑 + 渲染）。
- **`retry`**：消息重试（经 `messageActions` 槽）。
- **`review`**：消息审查动作（经 `messageActions` 槽）。
- **`continue`**：续跑（异常停机后原地续跑的入口）。
- **`ask`**：交互式提问（带 pi-extension，接内核提问帧）。
- **`goal`**：目标条（四件套核心参考，composer 上方的目标进行态展示，`core` + `renderer` + `pi-extension` + `dsh-extension`）。
- **`sub-agent`**：子代理（client + core + tools + renderer，会话分派/子代理管理）。
- **`voice-input`**：语音输入（经 `composerVoice` 槽，STT 转文字）。

### 8.4 `project/`（5 个，项目与文件）

- **`file-tree`**：文件树（左栏/右面板的文件树，消费 `fileIcons` 槽）。
- **`file-preview`**：文件预览（预览文本/图片/图，消费 `codeBlockRenderers` 槽的 `fileExtensions`）。
- **`projects`**：项目列表（左栏项目分组）。
- **`git-review`**：Git review 面板（右面板，diff/日志）。
- **`stickers`**：表情包/贴纸（经 `composerActions` 槽，client + renderer）。

### 8.5 `insight/`（3 个，洞察与记录）

- **`blind-review`**：盲审（经 `fileActions` 槽，对文件做无偏审查）。
- **`llm-recorder`**：LLM 记录器（core + renderer + pi-extension，记录/回放 LLM 调用 payload）。
- **`token-stats`**：Token 统计（经 `composerStats` 槽贡献上下文占用条 + `sidePanel` 槽贡献 Token 统计面板）。

### 8.6 `manager/`（6 个，管理页）

- **`pi-manager`**：Pi 内核管理页（版本/安装/切换/配置）。
- **`dsh-manager`**：DSH 内核管理页。
- **`plugin-manager`**：插件管理页。
- **`skill-manager`**：技能管理页。
- **`theme-manager`**：主题管理页（含字体 tab）。
- **`tool-manager`**：工具管理页。

### 8.7 `system/`（9 个，系统能力）

- **`i18n`**：语言包（`languages` 槽，贡献各 locale 的 key→文案字典）。
- **`general-config`**：通用设置（`settingsGroups` 槽 + `settings` 槽，纯 JSON 声明字段组）。
- **`keybindings`**：快捷键（core + renderer）。
- **`key-hints`**：按键提示（core + renderer）。
- **`notifier`**：系统通知。
- **`debug-bar`**：调试栏（经 `titlebar` 槽贡献标题栏按钮）。
- **`remote-access`**：远程访问控制面板。
- **`read-claude-md`**：读 CLAUDE.md（带 pi-extension，把项目 CLAUDE.md 注入内核）。
- **`goody-hao`**：技能包（`skills/` 目录，内置 `arch-to-code`/`write-design-doc` 两个技能）。

## 9. 仓库外围

- **`.claude/skills/`**：内置 skills 源（仓库顶级职业技能目录，随壳分发）。当前两个技能：`my-harness-desktop-guide`（本项目的开发指南，`SKILL.md` + `.meta.json`）、`write-plugin`（写插件技能）。每个技能一个目录，`SKILL.md` 是 frontmatter + 正文，`.meta.json` 是元数据。
- **`assets/`**：外层资产。`icons/`（应用图标 icns/icns/icon.png + deepseek.svg）、`stickers/`（贴纸图 + stickers.json）、`banner.svg`、`scripts/`（`patch-electron.cjs` 和 `patch-pi-rpc.cjs` 两个构建期补丁，被 `postinstall` 调用）。
- **`scripts/`**：开发环境引导脚本。`setup.sh`/`setup.ps1`（环境引导）、`run.cjs`（dev/preview/start 的运行时包装）、`verify-e2e.mjs`/`e2e-inmem.mjs`/`pixel-check.mjs`/`class-coverage.mjs`（验证脚本）、`demo/`（demo 与 e2e 脚本：record.mjs、dsh-multiturn.e2e.mjs、goal-command.e2e.mjs、parallel-record.mjs、speed-up.mjs）。

## 10. 设计风格提炼

这一节是本档的重点：从上面的目录结构里，把贯穿这套代码的风格信号逐条提炼出来。每一条都不停留在「原则陈述」，而是落到「哪几个目录/文件的摆放证明了这条」。

### 10.1 洋葱分层：目录是稳定度的同心圆

**信号**：仓库按稳定度排成同心圆，物理目录就是这些圆——圆心 `packages/shared/src/domain/`，向外 `src/server`+`src/web`，最外 `src/plugins/`。

**证据**：
- `packages/shared/package.json` 的 `"dependencies": {}` 是零依赖的包级表达——圆心物理上放不下任何会变的东西。
- `src/server/application/` 不 import 具体内核实现（`kernel/{pi,dsh}` 非 type-only import 是红线）。
- `src/server/kernel/core/` 不 import `pi`/`dsh`——骨架和实现物理分离。
- `src/plugins/` 只 import `shared` + `react`，不 import `@/server/...`。

**风格意义**：这套分层不是美学偏好，是变更隔离。换内核只动 `kernel/{kernel}`，换框架只动 `web/` + `react/`，换运行时只动 `host/` + `bootstrap/`，圆心一行不改。目录结构本身就是第一道防线——比靠 code review 抓违规可靠得多。

### 10.2 圆心零依赖：最内层只有类型和纯函数

**信号**：`packages/shared/src/domain/` 里没有任何 `import ... from 'electron'/'react'/'better-sqlite3'`，只有 `import type` 和 domain 内部互引。

**证据**：
- `kernel.ts` 零依赖，不 import 任何 domain 内外的类型，是「最内层的原子」。
- `backend.ts` 只 `import type` 自 `./events/...`、`./sessions`、`./kernel`、`./session-neutral`——全是 domain 内部。
- `events/`、`slots/` 同理：全是类型定义 + 纯函数，测试策略「95%+ 零 mock」。

**风格意义**：纯函数不需要 mock 环境，这反过来成为「这个东西该不该在内层」的判据——需要 mock 文件系统/网络/进程/时间的，就该推到外层；不需要的，是内层材料。

### 10.3 发布面 re-export：投影不是副本

**信号**：`packages/shared/src/index.ts`（43 行）和 `packages/react/src/index.ts`（544 行）都是「定义 + 纯 re-export」结构，没有一行重复定义。

**证据**：
- `shared/index.ts` 每一行都是 `export * from "./domain/..."`。
- `react/index.ts` 的 `export type { ... } from "@my-harness-desktop/shared"` 是类型投影。
- `contributions.ts` 里的 `SlotName` 只定义一次，所有消费方（`react/index.ts`、`controllers/`、插件）都从圆心 import，不自己写一份「本地版」。

**风格意义**：契约单源的推论是「发布面是投影不是副本」。概念改一次，所有引用处同时变。一旦外层开始定义「本地版」，漂移就开始了。

### 10.4 四件套内聚：一个功能一个 plugin，内核侧适配都收进来

**信号**：`src/plugins/{domain}/{feature}/` 内部按需出现 `renderer/` + `pi-extension/` + `dsh-extension/` + `locales/`（+ `core/`），一个功能的所有内核侧适配内聚在同一个 plugin 下。

**证据**：
- `sessions/goal/` 是 `core/` + `renderer/` + `pi-extension/` + `dsh-extension/` 四件齐全的参考实现。
- `insight/llm-recorder/` 是 `core/` + `renderer/` + `pi-extension/` + `locales/`。
- `system/read-claude-md/` 带 `pi-extension/extension/`，dsh 侧走 `plugin.json` 的 `dshExtension` 字段——同一能力在两个内核的对称实现。

**风格意义**：「非必要不修改薄壳内核」。给内核补能力写内核插件（pi-extension/dsh-extension），不写对方核心；改功能只动一个 plugin，diff 不该落在 `server/`。

### 10.5 按域分组：目录名即语义

**信号**：`src/plugins/` 顶层按六域分组（themes/sessions/project/insight/manager/system），`src/server/` 按能力域分文件（sessions/config/kernel/plugins/fs-git/remote…）。

**证据**：
- `src/plugins/sessions/` 装会话流的一切（timeline/message-blocks/markdown/mermaid/session-tree…），`src/plugins/manager/` 装管理页的一切（pi-manager/dsh-manager/plugin-manager/theme-manager…）。
- `src/server/controllers/` 的每个文件对应一个能力域：`sessions.ts`、`config.ts`、`kernel.ts`、`plugins.ts`、`skills.ts`、`fs-git.ts`、`remote.ts`、`window.ts`。

**风格意义**：目录名承担了「这层装什么」的解释责任。新人打开目录树就能看懂系统分了几块，不用先读代码。这是「骨架先行：先建空目录，让目录自己解释这层装什么」的落地。

### 10.6 机制与内容分离：壳的功能含量趋近于零

**信号**：壳（`src/server` + `src/web` + `packages/shared`）里没有写死的文案/配色/业务分支，内容全部外挂到 `src/plugins/`。

**证据**：
- `src/web/components/` 的五个文件（layout-engine/sidebar/right-panel/settings-page/titlebar）全是**空容器**，只做布局和查槽，不画业务内容。
- `src/web/ui/` 只有 `button.tsx` + `chat-row.tsx` 两个原子。
- `src/plugins/themes/` 有八套主题，全是同一 `themes` 槽的贡献项，改配色只动主题插件。
- `src/plugins/system/i18n/` 是语言包，文案不在壳里。

**风格意义**：token key 合规（`theme["color.primary"]`），token 值违规（`"#89b4fa"`）。内容会变、机制相对稳定，把内容焊死在壳里，改文案/调配色/加内核类型渲染都要动壳、发版、全量回归。

### 10.7 文件名自解释：一个文件一个概念

**信号**：文件名几乎都是「概念 kebab-case + 单数/复数语义」，读文件名就知道内容，注释只是补充设计依据。

**证据**：
- `packages/shared/src/domain/` 的 `kernel.ts`/`backend.ts`/`session-neutral.ts`/`contributions.ts`/`host.ts` 每个文件对应一个圆心概念。
- `src/server/kernel/pi/backend/` 的 `pi-backend.ts`/`pi-catalog.ts`/`correlator.ts`/`rpc-adapter.ts`/`subprocess-lifecycle.ts` 每个文件对应一个职责。
- `src/server/controllers/` 的 `sessions.ts`/`config.ts`/`kernel.ts`/`plugins.ts` 按能力域切分。

**风格意义**：文件名承担了第一层导航责任。`pi-backend.ts` 不需要打开就知道是「BaseBackend 的 pi 实现」，`dsh-event-translator.ts` 不需要打开就知道是「dsh 事件 → 中性事件」的翻译。

### 10.8 test 与源码同目录：纯函数零 mock 的物理证据

**信号**：几乎每个 `.ts` 源码旁边都有一个 `.test.ts`，测试与源码同目录，不设独立 `__tests__` 目录。

**证据**：
- `packages/shared/src/domain/` 里 `backend.test.ts`、`session-neutral.test.ts`、`aux-blocks.test.ts`、`composer-files.test.ts` 等与源码并列。
- `src/server/application/sessions/` 里 `session-store.test.ts`、`session-store.bookmark.test.ts`、`session-store.dsh.integration.test.ts` 与源码并列。
- `src/server/kernel/pi/backend/` 里 `pi-backend.test.ts`、`pi-backend.integration.test.ts` 与源码并列。

**风格意义**：测试和源码同目录，意味着「测什么」和「被测对象」物理相邻，找测试不用猜路径；「零 mock 的纯函数测试」和「需真机的集成测试」用文件名后缀区分（`.test.ts` vs `.integration.test.ts` vs `.dsh.integration.test.ts`）。

### 10.9 依赖倒置三段式：接口 → 抽象基类 → 具体实现

**信号**：多内核下「接口 + 两个平行实现」会重复，解法是「接口 → 抽象基类 → 具体实现」的三段式继承，物理上跨三个目录。

**证据**：
- `packages/shared/src/domain/backend.ts` 的 `BaseBackend`（接口）→ `src/server/kernel/core/abstract-backend.ts` 的 `AbstractBackend`（骨架 + 缺面默认）→ `src/server/kernel/pi/backend/pi-backend.ts` / `src/server/kernel/dsh/backend/dsh-backend.ts`（override 各自能力）。
- `packages/shared/src/domain/kernel-manager.ts` 的 `KernelSpec`（纯数据）→ `src/server/kernel/core/kernel-manager.ts` 的 `KernelManager`（基类）→ `src/server/kernel/pi/manager/pi-kernel.ts` / `dsh/manager/dsh-kernel.ts`（填 spec + 行为差异）。
- 组装全在 `src/server/kernel/factories/`（`kernel-factories.ts`/`kernel-managers.ts`）。

**风格意义**：基类只 import `packages/shared` 绝不 import 具体内核（机制不是内容）；子类只填差异（数据 + 行为）；组装归最外层。换内核 = 换适配器，`application` 和 `domain` 一行不改。

### 10.10 构造与执行分离：拼命令和发命令是两件事

**信号**：内核专属 args 的拼装在工厂闭包里（构造），进程 spawn 在 subprocess-lifecycle 里（执行），两者经接口连接。

**证据**：
- `src/server/kernel/pi/backend/rpc-adapter.ts` 构造命令对象但不 spawn 进程，`subprocess-handle.ts` + `subprocess-lifecycle.ts` 管进程生命周期，两者经 `SubprocessHandle` 接口连接。
- `src/server/kernel/factories/kernel-factories.ts` 把「怎么 spawn、怎么翻译」收成一个实现（构造），产出 `BaseBackend`（执行面）。
- `application/sessions/session-store.ts` 传中性 `BackendCreateOptions`（构造），不拼 `--session`/`--append-system-prompt`（那是执行）。

**风格意义**：一个函数既构造又执行是气味。拆成两个后，换 provider 不影响构造逻辑，改构造策略不影响执行流程。

### 10.11 双宿主：同一壳后端，两个运行时

**信号**：`bootstrap/` 两个入口 + `host/` 两个实现，同一份壳后端在 Electron 和纯 Node 服务器里都能跑。

**证据**：
- `src/server/bootstrap/assemble.ts` 零 electron，`electron.ts`/`server.ts` 各注入一份 Host + isPackaged。
- `src/server/host/electron-host.ts`（真值实现）+ `node-host.ts`（缺省降级，窗口/对话框/shell 全 `UNSUPPORTED_HOST`）。
- `electron.vite.config.ts` 的 `main.build.rollupOptions.input` 同时声明 `electron.ts` 和 `server.ts` 两个入口。

**风格意义**：运行时环境是被隔离的外层细节。换运行时只换 `host/` + `bootstrap/` 两个入口，`application`/`kernel`/`controllers` 一行不改。远程访问（`remote/` + `login-gate.ts`）正是「Node 服务器宿主」存在的理由。

### 10.12 中性事件：翻译器是喂线，不是第二套语义

**信号**：所有内核的事件都经适配器投成同一套中性事件，壳只认中性域，内核差异在事件层抹平。

**证据**：
- `src/server/kernel/pi/protocol/event-translator.ts`（pi 事件 → 中性事件）和 `src/server/kernel/dsh/backend/dsh-event-translator.ts`（dsh 事件 → 中性事件）是两个内核各自的翻译器，都投到 `packages/shared/src/domain/events/session-state.ts` 的 `SessionEvent`。
- 壳的渲染（`src/plugins/sessions/timeline/`）只认 `NeutralMessage`/`SessionEvent`，不出现 `if (kernel === "pi")` 分支。

**风格意义**：适配器的「翻译」是允许的（协议翻译），要禁止的是「让 dsh 装 pi」的翻译层和 UI 翻译层。两边都投成同一套中性事件，壳只认中性事件——这是「内核无关」的第二条不变量。

### 10.13 契约单源的三个物理落点

**信号**：三个最容易漂移的概念，各自收敛到唯一的物理文件。

**证据**：
- 内核身份 `KernelId = "pi" | "dsh"` 只出现在 `packages/shared/src/domain/kernel.ts`，全仓 60+ 处的字面量副本应归零。
- dsh 方法名只出现在 `src/server/kernel/dsh/protocol/dsh-methods.ts` 的 `DSH_METHODS` 常量枚举，`json-rpc.ts` 不再有魔法字符串。
- 通用配置路径只出现在 `packages/shared/src/contract/paths.ts`，`general-config` 插件拥有此文件，其余消费方统一引用常量。

**风格意义**：一份定义必然从第一天开始漂移。需要发布面就 re-export，不是复制；需要跨文件共享就 import 常量，不是各写一份字面量。

### 10.14 无特权差异：内置 = 第三方，pi = dsh

**信号**：目录上找不到「内置壳插件被特殊对待」或「pi 被特殊对待」的路径。

**证据**：
- `src/plugins/` 的内置壳插件和用户目录的第三方壳插件走同一套 `loader/discover.ts` + `loader/registry.ts`，四级来源 `builtin < installed < user < project` 只体现在优先级排序里，不体现在加载路径分支里。
- `src/server/kernel/pi/` 和 `src/server/kernel/dsh/` 是完全对称的两个目录，`factories/` 把它们平等地绑进注册表，`application/` 只认 `BaseBackend` 接口不认具体内核。

**风格意义**：特权是复杂度炸弹。每条「如果这是 pi 的就……」的分支都是 bug 温床。删掉 dsh 内核壳照常启动，换内核 = 换适配器，壳和壳插件不动。

## 11. QA

**Q：为什么 `packages/shared` 和 `packages/react` 的 `main` 都直指 `src/index.ts`，而不是编译产物？**

因为发布面是「投影」不是「副本」。直指源码让类型解析和构建 alias 对齐到同一份文件，不存在「源码改了、编译产物没变」的漂移窗口。代价是消费方（rollup）不能按默认规则 transform `node_modules` 里的 `.ts`，所以 `electron.vite.config.ts` 用 alias 把这两个包指回 `packages/*/src/index.ts` 绕开。workspace 里的包「零构建产物」是刻意为之，不是偷懒。

**Q：`packages/react` 的 `dependencies` 里为什么还有一个 `@my-harness-desktop/contract`，但 index.ts import 的是 `@my-harness-desktop/shared`？**

历史遗留。`contract` 是旧包名（原 `packages/contract/`），后来与 `core/domain/` 合并成了 `shared`。`package.json` 的 `dependencies` 没有同步清理，但代码已经全部 import `shared`，构建走 alias 所以不报错。这是一处「发布面命名收敛尚未 100% 收尾」的残留，属于 M 级 stale，标注待清理，不影响运行。

**Q：`src/plugins/sessions/timeline/` 和 `src/web/components/` 里都出现「布局」，为什么一个在插件里一个在壳里？**

分工是「容器 vs 内容」。`src/web/components/` 的五个文件是**空容器**：只做布局（怎么分栏、怎么查槽、怎么激活 Tab），不画任何业务内容。`timeline` 插件画的是**内容**：会话消息流、工具卡、思考链、气泡这些业务渲染。容器是机制（不变，留在壳里），内容是功能（会变，外挂插件）。判据还是那句「一年后会不会换」：分栏容器不会换，消息流怎么渲染会换。

**Q：`src/server/kernel/factories/` 为什么不叫 `registry/` 或 `assemblers/`？**

因为它做的是「把接口和实现绑起来」这个**组装**动作，而组装被纪律钉死为「只能发生在最外层」。`kernel-factories.ts` 把 `BaseBackend` 接口和 `PiBackend`/`DshBackend` 实现绑起来，`kernel-managers.ts` 把 `KernelManager` 基类和两个子类绑起来，`kernel-logos.ts` 把 logo 数据绑成映射。这些文件「同时 import 圆心契约和具体实现」是合法的，因为组装是它们的职责；`core/` 和 `application/` 没有这个资格。命名上 `factories` 比 `registry` 更准确地表达了「生产实例」而非「登记查询」。

**Q：`src/server/remote/`（鉴权）为什么单独一个目录，而不是塞进 `transport/` 或 `controllers/`？**

因为它横跨两个传输（HTTP 和 WS 共用同一套 token/限速/密码逻辑），且是「会变的安全策略」。`remote/net.ts` 的注释写明了「http 与 ws 两个传输共用，单源」；`auth.ts` 同时服务 `/login` 和 `hello` 两个入口。把它抽成独立目录，`transport/http/http-server.ts` 和 `transport/ws/ws-server.ts` 都调它，避免两份鉴权逻辑。这符合「安全动作是会变的策略，推到外层」——圆心不知道也不关心「这个连接有没有权限」。

**Q：`src/web/ui/` 只有两个文件（button.tsx、chat-row.tsx），这是刻意收敛还是没做完？**

刻意收敛。壳自己的 UI 含量被压到极低，通用 UI 组件（Button/Select/Toast/FileTree/SortableList/Pagination/ContextMenu…）都在 `packages/react/src/widgets/` 和 `panel/`，因为那些是「壳插件要用」的受控 API 面。`src/web/ui/` 只留壳自己骨架渲染必需的极少量原子。这对应「壳的功能含量趋近于零」：不是「尽量少」，是「只有拿掉它系统不能启动的才留」。

**Q：`packages/my-harness-fit-pi-extension/` 没有 `package.json`，它算 workspace 包吗？**

它被 `package.json` 的 `"workspaces": ["packages/*"]` 覆盖（目录在 `packages/` 下），但它没有自己的 `package.json`，所以不参与 npm 发布、也不被 import——它是一堆「待同步」的源码文件。它的交付路径是 `src/server/kernel/pi/extension/my-harness-fit-pi-extension-installer.ts` 在 app 启动时把它整体同步到 `~/.pi/agent/extensions/my-harness-fit-pi-extension/`。它和 `shared`/`react` 性质完全不同：那两个是「发布面」，这个是「内核扩展的源码仓库」。

**Q：为什么 `domain/` 里的测试和源码同目录，而 `packages/react/src/` 里几乎看不到 `.test.tsx`？**

因为测试策略按层分。`domain/` 是纯类型 + 纯函数，测试「95%+ 零 mock」，同目录放 `.test.ts` 成本最低、价值最高。`packages/react/src/` 是 React 组件和 hook，它们的测试主要在 `src/web/stores/`（`ui-store.composer-drafts.test.ts`、`session-store.image.test.ts`、`layout-store.test.ts`）和插件里（`src/plugins/sessions/goal/renderer/goal-bar.test.tsx`、`goal-controller.test.tsx`），用 Testing Library 测组件行为。不是「react 包不测」，是「纯函数测试归圆心同目录、组件测试归用它的插件/框架侧」。
