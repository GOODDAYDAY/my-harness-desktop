# dsh-manager

## 1 这个插件是什么

dsh-manager 是挂在壳 `settings` 槽位上的一个壳插件，它给 dsh 内核提供「一个入口三个 TAB」的设置界面：内核版本管理（DSH）、Cordis 拓展管理（DSH 拓展）、模型配置（DSH 模型）。它的定位用一句话钉死：**dsh 是 pi 的同级内核**，dsh-manager 是 dsh 的「管理页」，与 `src/plugins/manager/pi-manager/`（pi 的管理页）逐 TAB 对称。物理上它的全部代码只有 4 个 renderer 文件 + 2 个语言资源文件 + 1 个 `plugin.json`，一共约 500 行——它自己几乎不含任何业务逻辑，真正的数据来源与落盘逻辑全部在壳后端（`src/server/kernel/dsh/`）与 `packages/react/` 的共享 base 组件里。这个「薄」不是偷懒，是机制-内容分离（§7.2）的必然结果：dsh-manager 只负责「把哪块内核数据挂到哪个共享 UI 上」，字段知识、密钥语义、cordis.yml/settings.yaml 的读写语义全在适配器层。

它解决的具体问题，按 TAB 拆开：

- **DSH 内核版本管理**：查数据根已装的 `@deepseek-ai/dsh-sdk-jsonrpc-demo` 版本、从 npm registry 拉版本清单、装新=升级/装旧=降级、指定自定义 dsh 目录（自己 build 或魔改的 deepseek-harness）。底层是 `src/server/kernel/core/kernel-manager.ts` 的 `KernelManager` 基类 + `src/server/kernel/dsh/manager/dsh-kernel.ts` 的 `DshKernelManager`，UI 是 `packages/react/src/manager/kernel-version-page.tsx` 的 `KernelVersionPage`。
- **DSH 拓展管理**：Cordis 插件树（npm 包 `@deepseek-ai/dsh-*`，声明在 cordis.yml）的启用/禁用/安装/卸载/重启协调。底层是 `src/server/kernel/dsh/extension/dsh-extension-manager.ts` 的 `DshExtensionManager`，UI 是 `packages/react/src/kernel-extensions-page.tsx` 的 `KernelExtensionsPage`。
- **DSH 模型配置**：dsh 的 provider = LLM 适配器路由（`llm-deepseek` 的固定路由 `deepseek-official` + `llm-pi-ai` 的 `providers` 字典多路由），编辑每个路由的连接事实（`apiKeyEnv`/`api`/`baseURL`）与模型清单（`id`/`name`/`contextWindow`/`maxTokens`）、设默认模型、测连通性。底层是 `src/server/kernel/dsh/backend/dsh-config-source.ts` 的 `DshConfigSource` + `src/server/kernel/dsh/manager/dsh-kernel-api.ts` 的 `createDshModelsApi`，UI 是 `packages/react/src/manager/model-config-page.tsx` 的 `ModelConfigPage`。

没有这个插件，dsh 内核的所有管理动作都退化为「手跑 npm、手编辑 YAML」——技术上仍可操作（`DshConfigSource` 的读写原语都在壳后端、不依赖 UI），但用户失去的是唯一的图形入口。

## 2 架构定位：dsh 内核的一个「内容投影」

### 2.1 dsh-manager 是内容，不是机制

判断一个东西该不该是插件，标准是「一年后会不会换」：管理页的布局、字段表单、安装进度展示都是会变的内容，所以推给壳插件；而「能查/装 dsh 版本」「能读写 cordis.yml + settings.yaml」「能列/启用/禁用 cordis 插件」是内核与壳之间的稳定机制，留在壳后端。dsh-manager 恰好站在内容一侧：它只 import `@my-harness-desktop/react` 和 react-i18next，不 import `src/server/` 任何文件、不 import `@my-harness-desktop/shared` 之外的任何内核实现。`renderer/` 下四个文件全部是「拿 `usePluginContext()` 的 API → 传给共享 base 组件」的薄 wrapper，零 `if (kernel === "pi")` 分支、零 `src/server` 引用。

### 2.2 与 pi-manager 的同级对称

`src/plugins/manager/pi-manager/plugin.json` 贡献 `id: "pi"`、`order: 0`（永远第一）；`src/plugins/manager/dsh-manager/plugin.json` 贡献 `id: "dsh"`、`order: 1`。两者结构逐字对齐：

- pi 的三 TAB：`pi-kernel`（`PiManagerPage`）→ `pi-ext`（`ExtensionManagerPage`）→ `pi-models`（`ModelManagerPage`）。
- dsh 的三 TAB：`dsh-kernel`（`DshKernelPage`）→ `dsh-ext`（`DshExtensionsPage`）→ `dsh-models`（`DshModelsPage`）。

这一对称是「内核无特权」（§1.4）的落地：pi 不因「曾是唯一内核」在设置页拥有任何结构优势，两个内核各交一个管理插件、各贡献一个 settings 分组、各占一个 `order` 序号。删掉 `src/plugins/manager/dsh-manager/`，壳照常启动、设置页只是少了「DSH」这一组——这是无特权差异的可删性检验。

### 2.3 三层协作：renderer 薄 wrapper / packages-react 共享 base / server 适配器

dsh-manager 的每个 TAB 都遵循同一套三层分工，这一分工是 kernel-design-spec.md §12.4/§12.5/§12.6 定的：

- **renderer 层（本插件）**：只填「spec」——把 `ctx.kernels.dsh`、`ctx.kernelConfig.dsh`、`ctx.kernelModels.dsh` 这些 API 对象和 `i18nPrefix`、`capabilities` 旗标传给共享 base。`renderer/kernel.tsx` 只有 19 行，`renderer/models.tsx` 23 行，`renderer/extensions.tsx` 11 行。
- **packages/react 层（共享 base）**：`KernelVersionPage`、`KernelConfigForm`、`ModelConfigPage`、`KernelExtensionsPage` 四个内核无关组件，持有全部 UI 状态（版本列表、安装输出、provider 选中、test 状态、tag 筛选）。它们不含任何 `if (kernel === ...)` 分支，差异经 props 参数化（`api`/`i18nPrefix`/`capabilities`）抹平——这是 §7.5「渲染是纯函数」的具象化。
- **server 层（适配器）**：`DshConfigSource`、`DshKernelManager`、`DshExtensionManager`、`createDshModelsApi`、`createDshConfigApi` 把 dsh 的原生形状（cordis.yml 的插件数组、settings.yaml 的命名空间文档、npm 安装目录）翻译成中性契约（`KernelModelSource`、`KernelSpec`、`KernelModelsApi`、`KernelConfigApi`、`KernelExtensionSource`）。

这个三层结构回答了「为什么 dsh-manager 自己这么薄」：UI 状态和字段知识是 pi/dsh 共享的（收敛进 packages/react），内核形状的差异是 pi/dsh 各自私有的（收敛进 server 适配器），留给插件本身的内容只剩「绑定 API + 绑 i18n 前缀 + 绑能力旗标」这一层真正的差异。

## 3 plugin.json 声明

### 3.1 settings 槽位：一个入口、三个 TAB

`plugin.json` 的 `contributes.settings` 只有一个数组元素，`id: "dsh"`、`title: "DSH"`、`icon: "dsh"`、`order: 1`，声明 `tabs` 数组作为「展示分组入口」（`SettingsContribution.tabs` 的语义：入口是壳，只画 TAB 条 + 当前 TAB 的 pane，component 在各 TAB 里）。三个 TAB 各自的声明（`packages/shared/src/domain/contributions.ts` 的 `SettingsContribution` 类型）：

- **`dsh-kernel` TAB**（`component: "DshKernelPage"`，`configFile: "~/.dsh/settings.yaml"`，`kernelConfig: "dsh"`）：`kernelConfig` 字段声明本 TAB 走 `kernelConfig.dsh` 的 `get`/`set` 读写全量 JSON（settings.yaml 的非模型命名空间），`configFile` 仅用于「打开配置」按钮。saveMode 缺省 `"framework"`（框架管 save，有浮层/拦截）。
- **`dsh-ext` TAB**（`component: "DshExtensionsPage"`，`saveMode: "manual"`）：`saveMode: "manual"` 表示实时生效、无保存浮层——启用/禁用 cordis 插件是「立即移出/还原 cordis.yml 文本块」，没有「未保存待确认」的中间态，所以走 manual，不经过框架的 dirty/浮层管线。
- **`dsh-models` TAB**（`component: "DshModelsPage"`，`configFile: "~/.dsh/settings.yaml"`，`saveMode: "framework"`，`kernelModels: "dsh"`）：`kernelModels` 字段声明本 TAB 走 `kernelModels.dsh` 的 `readConfig`/`saveConfig` 读写中性 `KernelModelConfig`（providers + default），不直读 configFile。saveMode 是 `"framework"`——模型配置是「受控组件」，改动经 `onChange` 上报、框架顶部保存浮层落盘。

### 3.2 三个 TAB 的 saveMode 差异为什么不同

这是理解本插件一个关键点：三个 TAB 的持久化语义完全不同，saveMode 精确对应各自的语义：

- **内核版本 TAB 无 saveMode 声明**（缺省 `"framework"`），但它的真实落盘其实不经过 configFile——`KernelVersionPage` 内部直接调 `api.install`/`api.setCustomCliDir` 即写即生效，`configFile` 声明只是给「打开配置」按钮一个路径。内核版本是「点安装就 npm install」，没有「配置对象待保存」的概念。
- **拓展 TAB 是 `"manual"`**：`KernelExtensionsPage` 里 `handleToggle` 直接 `await ctx.kernelExtensions.disable/enable(kernel, id)`，`InstallSection` 直接 `await ctx.kernelExtensions.install(...)`，都是即写即生效（移出/还原 cordis.yml 块、npm install 进内核目录），框架不为它管 dirty。
- **模型 TAB 是 `"framework"`**：`ModelConfigPage` 是受控组件——数据来自框架注入的 `config`（中性 `KernelModelConfig`），所有增删改（`addProvider`/`deleteProvider`/`renameProvider`/`updateModel`/`setDefault`）只调 `onChange` 上报，由框架置 dirty + 顶部保存浮层，用户点保存后框架调 `kernelModels.dsh.saveConfig` 全量落盘。这一差异是 `model-config-page.tsx` 文件头注释点明的设计：**「本组件不自己 set api、不自己管 dirty、不带保存按钮」**。

### 3.3 languages 槽位

`contributes.languages` 贡献 8 条：`dsh-manager.dsh` 与 `dsh-manager.ext` 两个资源 id，各配 `zh-CN`/`zh-TW`/`en`/`de` 四个 locale。资源文件在 `locales/` 下按 `locale/dsh.json` 与 `locale/ext.json` 分。注意两个资源 id 的职责划分：

- `dsh-manager.dsh`（`locales/<locale>/dsh.json`）：版本管理 TAB 与模型 TAB 的全部文案，key 前缀 `dsh.*` 与 `dshModels.*`。例如 `dsh.title`、`dsh.desc`、`dsh.customCli.title`、`dshModels.apiKeyDesc`。
- `dsh-manager.ext`（`locales/<locale>/ext.json`）：拓展 TAB 的文案，key 前缀 `ext.*`，与 pi-manager 的 `pi-manager.ext` 资源逐字相同（`ext.search`/`ext.empty`/`ext.protected`/`ext.pendingRestart`/`ext.tag.*`/`ext.filterHint` 等 26 条完全一致）。这印证了拓展 TAB 的 UI 已经收敛进共享 base `KernelExtensionsPage`，文案也共享同一份 `ext.*` 命名空间——pi 和 dsh 的拓展页文案是「同一件事」，不该各写一份。

## 4 renderer：三个薄 wrapper 的逐行语义

### 4.1 index.tsx：re-export 与 channels

`renderer/index.tsx` 只有 10 行，做两件事：re-export 三个 TAB 组件（`DshKernelPage`/`DshExtensionsPage`/`DshModelsPage`），并 re-export `channels`。框架按 manifest 的 `contributes.settings[].tabs[].component` 字段，在 module 的 exports 里找同名组件自动注册（§7.4 组件自动匹配）——所以组件名必须与 `plugin.json` 里的 `component` 字符串一字不差：`DshKernelPage`、`DshExtensionsPage`、`DshModelsPage`。

`channels` 的 re-export 是容易漏的一环：框架从入口 module 读 `module.channels` 注册事件总线，`channels` 声明在 `models.tsx` 里（`export const channels = ["dsh-manager:defaultChanged"] as const`），若 `index.tsx` 不 re-export，框架就读不到、这个 channel 就「未被任何插件注册」。pi-manager 的 `index.tsx` 同样 re-export `channels`，两者是同一约定。

### 4.2 kernel.tsx：DshKernelPage = 版本 + 配置

`DshKernelPage`（`renderer/kernel.tsx`）渲染两段，中间一条 `borderTop: "2px solid var(--color-border)"` 分隔：

- `<KernelVersionPage api={ctx.kernels.dsh} i18nPrefix="dsh" />`：内核版本管理走共享 base。`ctx.kernels.dsh` 的类型是 `KernelVersionApi`（`packages/shared/src/domain/context.ts`），`KernelVersionPage` 内部调 `api.status()`（查已装版本 + 生效来源）、`api.listVersions(forceRefresh)`（registry 版本清单）、`api.install(version, onProgress, onDone)`（覆盖式安装）、`api.setCustomCliDir(dir)`（自定义目录）。`i18nPrefix="dsh"` 让 base 用统一后缀拼 key：`dsh.title`/`dsh.desc`/`dsh.installedVersion`/`dsh.installSwitch`/`dsh.customCli.*`。
- `<KernelConfigForm api={ctx.kernelConfig.dsh} config={config} onChange={onChange} refreshSignal={refreshSignal} />`：配置表单走共享 base。`ctx.kernelConfig.dsh` 的类型是 `KernelConfigApi`（`context.ts`），`KernelConfigForm` 先 `api.fields()` 拉字段清单，dsh 的 `fields()` 返回 `[]`（见 §6.4），于是走「按值递归推断类型」的兜底渲染（`InferredField`）。

值得强调的是 `kernel.tsx` 文件头注释里的一句话：「与 pi 配置 TAB 同构——不再「dsh 只打开 cordis.yml」降级，settings.yaml 的非模型段可表单编辑」。这是历史演进的落点：早期 dsh 的配置 TAB 可能只是「打开 cordis.yml 文件」的降级形态，现在已收敛到和 pi 一样的 `KernelConfigForm` 表单——settings.yaml 的非模型命名空间也能结构化成叶子控件编辑。

### 4.3 models.tsx：DshModelsPage 与 capabilities 旗标

`DshModelsPage`（`renderer/models.tsx`）渲染 `<ModelConfigPage api={ctx.kernelModels.dsh} i18nPrefix="dshModels" capabilities={{ reasoning: false }} ... />`。三个参数的语义：

- `api={ctx.kernelModels.dsh}`：`KernelModelsApi` 中性接口（`context.ts` 第 138 行），`ModelConfigPage` 只用它的 `test(cwd, provider, modelId)`（测连通性）；增删改全走框架注入的 `config`/`onChange`，不直接调 `api.set/remove/rename`。
- `i18nPrefix="dshModels"`：base 拼 key `dshModels.title`/`dshModels.providerId`/`dshModels.apiKeyDesc` 等。
- `capabilities={{ reasoning: false }}`：能力旗标（`KernelModelsCapabilities`，`context.ts` 第 153 行），声明「dsh 不渲染 per-model 的 reasoning 布尔列」。这是「显式降级」的落地：pi 的模型有 per-model `reasoning` 布尔（`models.tsx` 里 pi 传 `{ reasoning: true }`），dsh 是 agent 级 `reasoningEffort`（写在 `agent-default-model` 命名空间，不是 per-model 布尔），所以 `ModelConfigPage` 的 `ModelRow` 里 `{capabilities.reasoning && <checkbox>}` 这一整列对 dsh 隐藏——不是按 `kernel === "dsh"` 分支，是按能力旗标降级（§7.6）。

`channels` 与 `onDefaultChanged`：`ModelConfigPage` 的 `onDefaultChanged` 回调在用户点「设为默认」时触发，dsh-manager 把它接到 `ctx.events.emit(channels[0], { provider, modelId })`——即 emit `dsh-manager:defaultChanged` 事件（§7 详述）。

### 4.4 extensions.tsx：DshExtensionsPage 只绑 kernel

`DshExtensionsPage`（`renderer/extensions.tsx`）只有一行实质内容：`<KernelExtensionsPage kernel="dsh" title={t("dsh.extTitle")} refreshSignal={refreshSignal} />`。`KernelExtensionsPage`（`packages/react/src/kernel-extensions-page.tsx`）是内核无关组件，`kernel` prop 是 `KernelId`，组件内部所有能力都经 `ctx.kernelExtensions.list/enable/disable/install(kernel, ...)` 按 kernel 作用域访问，不含任何 `if (kernel === "pi")` 分支。`title` 由外层薄封装传翻译好的值（dsh 是 `t("dsh.extTitle")` = "DSH 拓展"，pi 是 `t("settings.extensions")`）——这是 base 组件「不硬编码内核专属文案」的做法：文案差异由外层 i18n 层消解，base 只收一个 `title: string`。

## 5 settings 槽位契约：kernelConfig / kernelModels 两个声明位

dsh-manager 贡献的三个 TAB 里，两个声明了内核专属配置源字段，这是理解「壳怎么把内核配置能力暴露给壳插件」的契约点，定义在 `packages/shared/src/domain/contributions.ts` 的 `SettingsContribution`：

- **`kernelModels?: KernelId`**（`contributions.ts` 第 28 行）：声明后，framework 用 `kernelModels[kernel]` 的 `readConfig`/`saveConfig` 读写中性 JSON（`KernelModelConfig` = `{ providers, default }`），不直读 configFile。`configFile` 仍可声明（用于「打开配置」按钮）。「声明即隐含走内核模型源」，pi/dsh 各自实现翻译——pi 是 `createPiModelsApi(modelsStore, piSettingsStore, sessionStore)` 写 models.json，dsh 是 `createDshModelsApi(dshConfigSource, sessionStore, prefs 密钥访问)` 写 settings.yaml + prefs 密钥。
- **`kernelConfig?: KernelId`**（`contributions.ts` 第 32 行）：声明后，framework 用 `kernelConfig[kernel]` 的 `get`/`set` 读写全量 JSON（pi=settings.json，dsh=settings.yaml 非模型 namespace）。表单走共享通用渲染，字段名 + 类型由内核吐（`kernelConfig[kernel].fields()`），label/文案由壳 i18n 贡献。

这两个字段是「内核专属配置源」从壳插件下沉到内核适配器的关键：壳插件不再自己 import 内核存储、不再自己写 `~/.dsh/settings.yaml` 的读写逻辑，而是声明 `kernelModels: "dsh"` / `kernelConfig: "dsh"`，由框架把对应 adapter 注入。`plugin.json` 里 `dsh-models` TAB 声明 `kernelModels: "dsh"`、`dsh-kernel` TAB 声明 `kernelConfig: "dsh"`，正是把「dsh 模型配置」和「dsh 原生配置」两个能力分别绑定到 `ctx.kernelModels.dsh` 与 `ctx.kernelConfig.dsh`（`PluginContext` 第 314/316 行的两个 `Record<KernelId, ...>`）。

## 6 dsh 内核版本管理 / 配置 / 密钥（专节）

这一节落到后端，是 dsh-manager 三个 TAB 各自背后的真实机制。分三个子块：版本管理（`KernelSpec` + `KernelManager` + `DshKernelManager`）、配置（cordis.yml + settings.yaml 的读写语义 + `DshConfigSource`）、密钥（`apiKeyEnv` 与 prefs 注入链路）。

### 6.1 内核版本管理：KernelSpec 数据 + KernelManager 机制 + DshKernelManager 差异

**契约层：`KernelSpec`（`packages/shared/src/domain/kernel-manager.ts`）**。圆心把「一个内核的 npm 安装形态」抽成纯数据接口 `KernelSpec`，八个字段全部是「包名 + 路径段 + dist-tag」这类数据，零逻辑：

- `pkg`：npm 主包名。
- `distTag?`：npm dist-tag，决定「最新版本」取哪个 tag。缺省 `latest`；dsh 用 `next`——文件头注释写死根因：dsh 的 `latest` 陈旧（0.0.1-rc.x 依赖坏），真实发版 0.1.0-rc.7 挂在 `next`。
- `pkgJsonPath`：installDir 下到主包 package.json 的相对段（npm 形态）。
- `extraPackages?`：附带插件包（dsh 的 JSON-RPC 运行时是「bin + 插件」组合，须与主包同版本一并装）。
- `cliWithinPkg`/`srcCli`/`srcPkgJson`/`cliJsLabel`：自定义目录归一化的两套路径段（源码根形态一 / npm 安装形态二）+ 校验失败时展示的 cli.js 名。

`KernelSpec` 之外还有 `RegistryVersions`（registry 查询结果 `{ versions, latest }`）、`CustomCliResolution`（自定义内核归一化结果 `{ cliJs, version }`）、`InstalledVersionStatus`（数据根安装状态 `Pick<KernelStatusView, ...>`）。

**机制层：`KernelManager` 基类（`src/server/kernel/core/kernel-manager.ts`）**。pi/dsh 共用的「装/查/状态合成」机制全部收在这里，只依赖 `KernelSpec` + `KernelRuntime`（`core/kernel-runtime.ts` 的接口），不 import 任何具体内核。核心成员：

- `currentVersion()`：直接读 `join(installDir, ...spec.pkgJsonPath)` 的 package.json version，不 spawn CLI——避免依赖 PATH 里的那份 dsh。
- `resolveCustomCli(dir)`：自定义目录归一化（纯函数，只做存在性检查 + JSON 读取），形态一（源码根 `srcCli`）优先于形态二（npm 安装目录 `cliWithinPkg`）。
- `status(customCliDir)`：状态合成——customCliDir 空 → `source: "installed"`；非空且命中 → `source: "custom"` 取自定义版本；非空未命中 → `source: "custom"` 保留配置意图、状态跟随数据根、error 标注回落。
- `listVersions(forceRefresh)`：fetch npm registry（经 `KernelRuntime.fetchRegistryVersions`），带 per-pkg 10min TTL 的 `registryCache`。
- `install(version, onProgress)`：覆盖式安装。关键细节：`prepareInstallDir` 先清 `node_modules` + `package-lock.json` 再写最小 staging package.json——文件头注释写死根因（实证）：不清干净时 npm 对旧树做增量更新，dsh 主包的 peer deps（dsh-invariants/cordis）跨 0.1.0→0.1.1 升版后新版要求 `^0.1.1-rc.x` 而旧版遗留 0.1.0-rc.x 无法满足 → ERESOLVE → 升级永远失败。主包 + 附带包全部 `@version` 同版本一次装成（附带包之前不写 `@version` 会落到陈旧的 `latest`，同样 ERESOLVE）。装完回读 `currentVersion()` 校验，不只看 npm exit code（npm 可能 exit 0 却没把包落到预期路径）。
- `installNpm`/`uninstallNpm`（protected）：`KernelRuntime.installNpm/uninstallNpm` 的封装，供子类 `installPlugin`/`uninstallPlugin` 复用。
- `postInstall`（protected，默认空）：安装后钩子，子类覆盖。

**差异层：`DSH_SPEC` + `DshKernelManager`（`src/server/kernel/dsh/manager/dsh-kernel.ts`）**。`DSH_SPEC` 填 dsh 的数据：

- `pkg: "@deepseek-ai/dsh-sdk-jsonrpc-demo"`，`distTag: "next"`，`pkgJsonPath: ["node_modules", "@deepseek-ai", "dsh-sdk-jsonrpc-demo", "package.json"]`。
- `extraPackages` 10 个：`dsh-sdk-jsonrpc-server`、`dsh-agent-spine-demo`、`dsh-llm-deepseek`、`dsh-settings-file`、`dsh-llm-pi-ai`、`dsh-session-persistence-jsonl`、`dsh-session-checkpoint-policy`、`dsh-subprocess-local`、`dsh-bash-local`、`dsh-fs-local`。文件头注释点明：主包只带 bin/boot，插件由 cordis.yml 按包名解析，须一并装进同一 node_modules。
- `cliWithinPkg: ["lib", "bin.js"]`、`srcCli: ["packages", "examples", "jsonrpc-demo", "lib", "bin.js"]`、`srcPkgJson: ["packages", "examples", "jsonrpc-demo", "package.json"]`、`cliJsLabel: "apps/cli/lib/bin.js"`。

`DshKernelManager extends KernelManager`：`postInstall` 无操作（dsh 无装后补丁），另加 dsh 独有的两个方法：

- `installPlugin(pkgName, onProgress)`：白名单只放 `^@deepseek-ai/dsh-[a-z0-9-]+$`（防 npm spec 注入），先 `currentVersion()` 校验内核已装，然后 `installNpm(\`${pkgName}@${installed.currentVersion}\`)`——**钉到已装内核同版本**，不写版本会落到 latest（陈旧 0.0.1-rc.x）与新内核 peer deps 冲突（与 install 的附带包同根因）。
- `uninstallPlugin(pkgName, onProgress)`：同白名单，`uninstallNpm` 卸出内核目录（装/卸对称）。

`DshKernelManager` 是「子类只填差异」的范本：数据（`DSH_SPEC`）+ 行为差异（`installPlugin`/`uninstallPlugin` + 空的 `postInstall`），装/查/状态合成机制一行不重写。组装在 `src/server/bootstrap/assemble.ts` 第 140 行 `const dshKernelManager = createDshKernelManager(DSH_INSTALL_DIR)`，`DSH_INSTALL_DIR = join(MY_HARNESS_DESKTOP_DIR, "dsh")`（`~/.my-harness-desktop/dsh`）。

### 6.2 dsh 原生配置：cordis.yml + settings.yaml 的双面模型

dsh 有两处原生配置面（`dsh-config-source.ts` 文件头 §2.3 依据），语义截然不同：

- **`cordis.yml`** = 插件组成 + 出厂 base。它是一个 YAML 数组，每个元素是 `- id: <逻辑id>` + `name: <包名或相对路径>` + 可选 `config:` 块。它回答「哪些插件在跑、默认 config 是什么」，是**读作兜底的 base**。
- **`~/.dsh/settings.yaml`** = 用户覆盖。namespace 分节的纯字面量 YAML 文档，解析链 = schema 默认 → cordis base → 用户分节。它回答「用户改了哪些东西」，是**用户可编辑面**。

两条纪律贯穿 `DshConfigSource` 的实现：

1. **模型 / 默认模型 / 配置的「用户可编辑面」在 settings.yaml；cordis.yml 是 base（读作兜底）**。所以 `listProviders()` 读模型时「用户 settings.yaml 覆盖 base」：`deepseekNs?.models ?? deepseekBaseNs.models`（第 270-272 行）。
2. **dsh 侧用 `!!js` 自定义 YAML tag（仅 cordis.yml base）；settings.yaml 是纯字面量用户文档**。`!!js` 是 cordis 的运行时求值表达式（如 `!!js process.env.DSH_SESSION_ROOT ?? './.sessions'`），`DshConfigSource` 读它时**不求值只存表达式**（`JS_TAG.resolve` 返回 `{ __js: s }`），写时把表达式原样 stringify 回（round-trip 不丢）。

`DshConfigSource`（`src/server/kernel/dsh/backend/dsh-config-source.ts`）的类声明 `class DshConfigSource implements KernelModelSource, DshConfigApi`——它同时是两个圆心契约的实现：`KernelModelSource`（`packages/shared/src/domain/backend.ts` 第 336 行，`listModels(): ModelInfo[]`，供 model-catalog 合流）+ `DshConfigApi`（`packages/shared/src/domain/context.ts` 第 49 行，provider CRUD + 默认模型 + settings + cordis 插件块管理）。

构造参数三个路径（`assemble.ts` 第 154-158 行）：

- `cordisPath = DSH_CORDIS_PATH = process.env.DSH_CORDIS_CONFIG ?? join(HOME_DIR, ".dsh", "cordis.yml")`——`DSH_CORDIS_PATH` 单源：配置读写与 spawn 的 `DSH_CORDIS_CONFIG` env 共用同一路径。
- `settingsPath = join(HOME_DIR, ".dsh", "settings.yaml")`。
- `installDir = DSH_INSTALL_DIR`（`~/.my-harness-desktop/dsh`），用于列「可用插件」（读内核 node_modules）。

关键方法（每个都是 dsh-manager 某个 TAB 的底层）：

- **`ensureDefaultCordis()`**：首次运行缺 cordis.yml 时写一份默认 JSON-RPC 组合（`DEFAULT_CORDIS_YAML`，含 sdk-jsonrpc-server/agent-core/settings-file/llm-pi-ai/sessions/session-checkpoints/subprocess/bash/fs-local 九个块；llm-deepseek 已随官方路由废弃移除），否则 `dsh-jsonrpc-agent` 报 usage 退出。
- **`ensureAgentCoreSkillForkBase()`**：确保 agent-core 的 skill-filesystem 被「中立化」（改名 `filesystem-builtin` + 清空发现根），让统一适配插件的 fork provider 独占 "filesystem" 名。duplicate provider 会让 dsh 启动即崩，所以这是启动期必须保证的内核形状；幂等（块内已出现 `filesystem-builtin` 即跳过）。
- **`listProviders()`**：列所有 provider 路由（**纯自定义**，只有 `llm-pi-ai.providers` 字典一个来源；用户按 route 覆盖 base，`api`/`baseURL`/`displayName` 逐字段 `strField(uCfg.x) ?? strField(bCfg.x)` 合并）。`apiKey` 字面值从 dsh 凭证库 `~/.dsh/.credentials.yaml` 读回（`readApiKey(credentialsPath, route)`），不落 settings.yaml。
- **`listModels()`**：合流成 `ModelInfo[]`（每项带 `kernel: "dsh"`、`provider`、`id`、`name`、`contextWindow`、`maxTokens`），供 model-catalog 的会话流模型下拉。
- **`setProvider`/`renameProvider`/`removeProvider`**：provider 路由 CRUD（全部纯自定义，无固定路由）。`setProvider` 空串字段视为「清掉覆盖」（落回 base/默认），undefined 表示不动；`apiKeyEnv` 由 `deriveKeyRef(provider)` 派生写回 settings.yaml，`apiKey` 字面值写凭证库。`renameProvider` 迁移凭证库 ref（旧 ref → 新 ref），`removeProvider` 清除凭证库 ref。
- **`getDefaultModel`/`setDefaultModel`/`clearDefaultModel`**：`agent-default-model` 命名空间的默认模型（`{ provider, model, reasoningEffort? }`）。`clearDefaultModel` 在删除 default provider 时清悬空指针。
- **`getSettings`/`setSettings`**：整份 settings.yaml 读写（`KernelConfigApi` 的底层）。
- **`listPlugins`/`listDisabledPlugins`/`disablePlugin`/`enablePlugin`/`addPlugin`/`addPluginBlock`/`removePluginBlock`/`resolvePluginId`/`listAvailablePlugins`**：cordis.yml 插件树的文本块操作。`disablePlugin` 把块移出到 `<cordisPath>.disabled.json`（可还原），`enablePlugin` 从 disabled.json 还原；`addPlugin` 追加 `- id: <id>` + `name: <pkgName>`（幂等 + id 冲突防护）；`addPluginBlock`/`removePluginBlock` 是随附通道的显式 id+name 追加/摘除。`resolvePluginId` 走 `PLUGIN_ID_MAP`（24 个标准 dsh 插件的包名 → 逻辑 id 映射），未知包回落「剥 `@deepseek-ai/dsh-` 前缀」。

**一个关键正确性守卫：`assertPiAiRouteServiceable`**。它校验一个 `llm-pi-ai` 手写路由「确定不可服务」的毒源——空 models 会让 dsh 运行时 `resolveProfiles` 抛 "resolves no models" → 整段 llm-pi-ai 被拒 → 连带其它合法路由一起失效。所以 `setProvider` 和 `createDshModelsApi.saveConfig` 都在写盘前调用它：只拦「空 models」这一确定性毒源（缺 baseURL 是否毒化取决于该路由在 pi-ai catalog 里有无兜底，桌面端无从得知，故不拦，避免误杀 catalog 路由的「空串清覆盖」语义）。

### 6.3 模型配置适配：createDshModelsApi 把 dsh 形状翻译成中性 KernelModelsApi

`createDshModelsApi(dshConfigSource, sessionStore)`（`src/server/kernel/dsh/manager/dsh-kernel-api.ts`）返回中性 `KernelModelsApi`，是模型 TAB 的 `ctx.kernelModels.dsh` 真身。它的核心是「形状翻译」：

- `toNeutral()`：`dshConfigSource.listProviders()` 的 `DshProvider[]` → `NeutralProvider[]`。`apiKey` 字段直接来自 `p.apiKey`（listProviders 从凭证库读回）——**密钥字面值不落 settings.yaml**（见 §6.5）。
- `setImpl`/`removeImpl`：`set` 调 `dshConfigSource.setProvider`（写 settings.yaml 连接事实 + models + 派生 apiKeyEnv，同时把 apiKey 字面值写凭证库）；`remove` 调 `removeProvider`（清路由 + 清凭证库 ref）。
- `rename`：`dshConfigSource.renameProvider`（改路由 + 迁移凭证库 ref），无固定路由限制。
- `test`：`sessionStore.test(cwd, provider, modelId, "dsh")` 走会话测试链路（spawn 一次性会话）。
- `saveConfig(config)`：全量 reconcile——**先整体校验再动任何写入**（`for (const p of config.providers) assertPiAiRouteServiceable(p.id, { models: p.models })`），再删缺、增改、设默认。文件头注释写死根因：若先删后写再校验，空路由抛错时会留下半写状态（旧路由已删、新路由未落）。default 为 null 时 `clearDefaultModel()` 清悬空指针（根因：此前只在非 null 时 set，残留 agent-default-model 指向已删路由）。

### 6.4 配置适配：createDshConfigApi 暴露「非模型命名空间」

`createDshConfigApi(dshConfigSource)`（`src/server/kernel/dsh/manager/dsh-kernel-config.ts`）返回 `KernelConfigApi`，是配置 TAB 的 `ctx.kernelConfig.dsh` 真身。三个关键决策：

- **`DSH_MODEL_NAMESPACES = new Set(["llm-pi-ai", "agent-default-model"])`**：这两个命名空间已由模型 TAB（`kernelModels.dsh`）收编，本适配器不碰，避免双写。
- **`get()`**：返回 `nonModelSection(dshConfigSource.getSettings())`——去掉模型命名空间的子集。
- **`set(obj)`**：**替换非模型命名空间、保留模型命名空间**。因为 get 返回的是非模型子集，若 set 整份写回会把模型命名空间抹掉（settings.yaml 是模型配置的家）。所以在适配器内做 reconcile：删旧非模型段、并入新值、保留模型段，再整份落盘。
- **`fields()`：返回 `[]`**。这是 dsh 与 pi 的关键差异——dsh 的字段 schema 在它的运行时（cordis 插件注册的 schemastery schema），不落文件、桌面读不到，所以 fields 返回空。壳表单于是退化成「按值推断类型的通用 JSON 编辑器」（`KernelConfigForm` 的 `InferredField`），不硬编码 dsh 的字段清单——那是 dsh 自己的信息，桌面不该复制（§1.3 契约单源的反面：不复制内核的字段知识）。

### 6.5 密钥链路：凭证库 ~/.dsh/.credentials.yaml（不注入进程 env）

这是「dsh 模型配置」里最容易误解的一条链路，分「存」与「解析」两段：

**存**：`dshModels.apiKeyDesc` 文案写死语义：「密钥字面值按 provider 写入 dsh 凭证库(~/.dsh/.credentials.yaml)，dsh 运行时直接读取；不注入进程环境变量、不写进 settings.yaml/cordis.yml」。落到代码是 `DshConfigSource.setProvider`——`apiKey` 字面值经 `writeApiKey(credentialsPath, provider, key)` 写进凭证库 `refs.<deriveKeyRef(provider)>`；settings.yaml 的 route 只写派生的 `apiKeyEnv` 引用（`deriveKeyRef(provider)`，与 dsh 官方 settings-models UI 同款公式 `provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_") + "_API_KEY"`），密钥值从不在 settings.yaml。

**解析**：`assemble.ts` 的 `baseBackendFactory.create` spawn dsh 时**不再注入任何密钥 env**——只注入 `DSH_SESSION_ROOT`。dsh 运行时经 `dsh-credentials-local` 从凭证库 `refs` 解析密钥（凭证库优先于 `.env`、继承环境只读层仍可覆盖，这是 dsh 原生凭证链）。

**迁移**：`assemble.ts` 第 123-137 行有一次幂等迁移——旧 `prefs.dshApiKeys`（provider → 密钥字面值，旧机制 spawn 注入 env）→ 凭证库 refs；迁移后清空旧 map，避免「凭证库 + prefs」双份真相。旧单值 `dshApiKey`（指向已废弃的 deepseek-official）随迁移一并清除。

### 6.6 默认模型链路：agent-default-model → initialize 握手

dsh 无 `session/setModel` 运行时切换（`setModel` 懒探测缺面时 no-op，`dsh-backend.ts` 第 235-252 行），模型只能在 initialize 握手时定。所以「默认模型」不是摆设，是 warmup 起进程未带显式模型时的真实兜底：`assemble.ts` 的 `dshDefaultProviderModel()` 读 `settings.yaml` 的 `agent-default-model`，再回落首个 provider/模型（**不再写死 deepseek-official**）；`baseBackendFactory` 与 `sessionCatalogFactory`（目录 transport）共用这一同源兜底。`getDefaultModel()` 读 `settings.yaml` 的 `agent-default-model` 命名空间，模型 TAB 里「设为默认」最终经 `setDefaultModel` 写回这个命名空间。

## 7 与其他插件交互（专节）

### 7.1 唯一对外输出：`dsh-manager:defaultChanged` 事件

dsh-manager 只产生一个可被其他插件消费的输出：`renderer/models.tsx` 声明 `channels = ["dsh-manager:defaultChanged"]`，当用户在模型 TAB 里点「设为默认」时，`ModelConfigPage` 的 `onDefaultChanged` 回调触发 `ctx.events.emit(channels[0], { provider: sel.provider, modelId: sel.model })`。这是典型的事件总线用法（§8.2）：dsh-manager 是「拥有」这个 channel 的插件（它声明 channel 并 emit），其他插件若关心「dsh 默认模型变了」就 `dependsOn: "dsh-manager"` + `ctx.events.on("dsh-manager:defaultChanged", ...)`。

注意对称性：pi-manager 声明的是 `pi-manager:defaultChanged`，两个 channel 分属两个插件、互不相干。默认模型的变更广播是「谁的内核默认模型变了」这一语义，按内核分 channel，而不是共用一个 `kernelDefaultChanged` 然后带 `kernel` 参数——这是「channel 由代码级 `export const channels` 声明、框架加载 module 后自动注册」的约定：channel 名即权属声明，emit 只能发自己声明过的 channel。

### 7.2 与 pi-manager 的关系：同级、零依赖、共享 base 与文案

dsh-manager 与 pi-manager 之间没有任何代码依赖、没有任何事件订阅、没有任何共享 store 互读写。它们的关系是「结构对称的两个独立插件」：

- **各自贡献各自的内核分组**：pi 贡献 `id: "pi"` order 0，dsh 贡献 `id: "dsh"` order 1。
- **各自声明各自的 defaultChanged channel**：`pi-manager:defaultChanged` vs `dsh-manager:defaultChanged`。
- **共享的是 packages/react 的 base 组件与 ext.* 文案**：`KernelVersionPage`/`KernelConfigForm`/`ModelConfigPage`/`KernelExtensionsPage` 是框架提供的共享 base（不是 dsh-manager 依赖 pi-manager），`ext.*` 文案两个插件贡献完全相同的一份（dsh-manager 的 `locales/<locale>/ext.json` 与 pi-manager 的 `locales/<locale>/ext.json` 内容一致）。
- **能力旗标反向**：模型 TAB 的 `capabilities.reasoning`，pi 传 `true`、dsh 传 `false`——这是「按能力降级，不按内核身份分支」的体现，两者都走同一个 `ModelConfigPage`，只是旗标不同。

### 7.3 与壳后端的内核能力交互：经 PluginContext 的中性面

dsh-manager 不直连 `src/server`，它通过 `usePluginContext()` 拿受控 API（`packages/shared/src/domain/context.ts` 的 `PluginContext`），用到的字段逐个列出：

- `ctx.kernels.dsh`（`KernelVersionApi`）：版本管理 TAB 的 `status/listVersions/install/setCustomCliDir`。dsh 侧没有 `fitPiExtensionAvailable?` 可选方法（pi 专属，tool-gate 探测），`KernelVersionApi` 把它标成可选，据以显式降级。
- `ctx.kernelConfig.dsh`（`KernelConfigApi`）：配置 TAB 的 `get/set/fields`。
- `ctx.kernelModels.dsh`（`KernelModelsApi`）：模型 TAB 的 `list/test/readConfig/saveConfig` 等。
- `ctx.kernelExtensions`（`KernelExtensionSource` 中性面）：拓展 TAB 的 `list/enable/disable/install/uninstall(kernel, ...)`，按 kernel 作用域。dsh 的实现是 `DshExtensionManager`。
- `ctx.restart`：拓展 TAB 的 `PendingRestartSection` 用 `pendingSessions/restart/restartAllIdle/onStateChange` 做「插件启停变更需重启 dsh 会话进程」的协调。
- `ctx.events`：emit `dsh-manager:defaultChanged`。
- `ctx.dialog`：`KernelVersionPage` 的 `CustomCliSection` 用 `openDirectory()` 浏览目录、`ModelConfigPage` 的导出用 `saveTextFile`。
- `ctx.config`：`KernelExtensionsPage` 的 tag 筛选用 `ctx.config.get/set("tagFilter", ...)` 存筛选态（global scope）。

这些 API 全部是核心默认能力（不声明权限）或声明能力（`ctx.dialog` 是用户手势驱动），dsh-manager 的 `plugin.json` **没有 `permissions` 字段**——它不碰 fs/git/bash/llm 这些需声明的能力。

### 7.4 内核插件补面：dsh-manager 不是补面者，但它的拓展 TAB 是补面的入口

dsh-manager 本身不写任何内核插件，但它的「DSH 拓展」TAB 是 §7.6「内核插件补面」三分法里第 2 条（内核插件补面）的用户入口：`DshExtensionManager.doInstall` 把 `@deepseek-ai/dsh-*` 包 `npm install` 进内核目录 + `addPlugin` 写 cordis.yml 块，`doEnable`/`doDisable` 移出/还原 cordis 块。这些 Cordis 插件（`dsh-subagent`、`dsh-compaction-basic` 等）就是「给缺能力的内核补面」的载体。

随附通道（非本插件、但与 dsh-manager 的拓展 TAB 同屏展示）是 `assemble.ts` 第 164-176 行的 `DSH_FIT_EXTENSION_SOURCE`：把 ask/goal/read-claude-md/skill-manager 四个壳插件随附的 dsh cordis 插件合并成一块 `my-harness-fit-dsh-extension`，`addPlugin("@deepseek-ai/dsh-tool-skill")` 启用技能消费方。这些随附插件在 `DshExtensionManager.scan()` 里以「相对路径块」形态展示（`isLocalEntry(name)` 判断 name 以 `./` 开头），元信息来自随附目录的 `extension.json` 单源（`readExtensionManifest`），标签标 `desktop`（来源）+ `file`（形态）。

### 7.5 model-catalog 合流：DshConfigSource 是 KernelModelSource 之一

`DshConfigSource implements KernelModelSource`（`backend.ts` 第 336 行的圆心契约），`listModels()` 合流出 `kernel: "dsh"` 标好的 `ModelInfo[]`。`assemble.ts` 第 177 行 `const modelCatalog = new ModelCatalog([new PiModelSource(modelsStore), dshConfigSource])`——model-catalog 持 `KernelModelSource[]`，加第三个内核 = 加一个 source，`ModelCatalog` 一行不改（§9.1 多内核能力）。这是「模型清单是能力、由内核交 source、壳只合流」的落点：dsh-manager 的模型 TAB 编辑 `settings.yaml` 的模型段，改完后 `ModelCatalog` 的下一次 `listModels()` 就能看到新模型——两者经 `DshConfigSource` 这个共享实例串起来（同一个 `dshConfigSource` 既进 modelCatalog、又进 `createDshModelsApi`、又进 `createDshConfigApi`、又进 `DshExtensionManager`）。

### 7.6 依赖方向：只 import 两个包

dsh-manager 的四个 renderer 文件 import 清单穷尽如下：`@my-harness-desktop/react`（`ModelConfigPage`/`KernelConfigForm`/`KernelVersionPage`/`KernelExtensionsPage`/`usePluginContext`/`SettingsComponentProps` 类型）、`react-i18next`（`useTranslation`）。它不 import `@my-harness-desktop/shared` 之外的任何内核实现、不 import `src/server/` 任何文件、不 import `electron`。这正是 §6.3 依赖方向检验「打开 `src/plugins/` 任何一个文件，如果有 `import ... from '@/server/...'` 就是违规」的正面例证——dsh-manager 一行都不违规。

## 8 分层纪律与三条可检验不变量

### 8.1 dsh-manager 落在哪一层

dsh-manager 在 `src/plugins/manager/`，是内容层（壳插件）。它之上是 `packages/react/`（共享 base，框架发布面）、`src/server/kernel/dsh/`（内核适配器，流出适配器层）、`packages/shared/src/domain/`（圆心契约）。依赖箭头只向内：renderer → packages/react + packages/shared，packages/react → packages/shared，src/server/kernel/dsh → packages/shared + core 基类。没有一环反向。

### 8.2 三条可检验不变量

- **不变量一：渲染纯函数**。`ModelConfigPage`/`KernelConfigForm`/`KernelVersionPage`/`KernelExtensionsPage` 四个 base 组件不含 `if (kernel === "pi")` 或 `asPi()`；dsh-manager 的四个 renderer 文件也不含。内核差异由 `capabilities={{ reasoning: false }}`（能力旗标）、`api={ctx.kernelModels.dsh}`（注入不同 adapter）、`i18nPrefix="dsh"`（注入不同文案）抹平。
- **不变量二：内核身份单源**。dsh-manager 的 `plugin.json` 里出现 `"kernelConfig": "dsh"`、`"kernelModels": "dsh"`、`"kernel": "dsh"` 这些字符串，但它们是 `KernelId = "pi" | "dsh"` 联合的字面量取值，不是「复制一份内核身份定义」——类型定义单源在 `packages/shared/src/domain/kernel.ts`。`extensions.tsx` 里的 `kernel="dsh"` 也是 `KernelId` 类型的字面量赋值，经类型系统校验合法取值。
- **不变量三：字段知识不复制**。`createDshConfigApi.fields()` 返回 `[]` 而非「把 dsh 的字段清单硬编码进桌面」——dsh 的 schema 在它的运行时，桌面读不到就不猜、退化成通用 JSON 编辑器。这是「不复制内核字段知识」的纪律，与 pi 的「解析 .d.ts 拿 schema」形成对照（pi 有文件可解析，dsh 没有，各走各的合法路径，但都不硬编码字段清单）。

## 9 如果没有这个插件，系统会有什么影响

删掉 `src/plugins/manager/dsh-manager/`，壳照常启动——加载器跳过这个插件，`settings` 槽位本身完好，其他设置页 TAB 正常渲染。dsh 内核的机制（`DshConfigSource`/`DshKernelManager`/`DshExtensionManager`/`createDshModelsApi`/`createDshConfigApi`）全在壳后端，不因插件缺失而失效——它们由 `assemble.ts` 无条件组装，注入 `MainContext` 供 kernel IPC 使用，插件只是「消费它们的 UI」。

失去的东西按 TAB：

- **版本管理入口**：无法在 UI 里查已装 dsh 版本、列 registry 版本、装/升级/降级、设自定义 dsh 目录。底层 `KernelManager.install` 仍在，但没有 UI 触发。
- **配置表单入口**：无法在 UI 里编辑 settings.yaml 的非模型段。底层 `createDshConfigApi.get/set` 仍在。
- **拓展管理入口**：无法在 UI 里启停/安装/卸载 cordis 插件、看待重启会话清单。底层 `DshExtensionManager` 仍在。
- **模型配置入口**：无法在 UI 里编辑 provider 路由、模型清单、密钥、默认模型、测连通性。底层 `createDshModelsApi` 仍在。

**对其他插件的影响**：`dsh-manager:defaultChanged` 事件不再有 emit 方——任何订阅了这个 channel 的插件（若存在）会因框架的「dependsOn 生命周期护栏」在加载时被拦（消费别人的 channel 应声明 dependsOn，目标缺失则加载失败或事件永不触发）。其余插件无感：sessions-list/timeline/theme-manager 等都不依赖 dsh-manager 的输出。

**第三方能否替代**：可以。第三方插件贡献 `contributes.settings`（带 `tabs` + `kernelConfig: "dsh"` + `kernelModels: "dsh"`）和 renderer 组件（调 `ctx.kernels.dsh`/`ctx.kernelConfig.dsh`/`ctx.kernelModels.dsh`/`ctx.kernelExtensions`）即可完全替代 dsh-manager。由于 dsh-manager 是 `tier: "official"`（builtin 优先级最低），第三方同 id 的 settings 分组会覆盖它。

## 10 QA

**Q：dsh-manager 的三个 TAB 为什么 saveMode 各不相同？**

因为三个 TAB 的持久化语义不同。内核版本 TAB 是「点安装即 npm install」，没有「配置对象待保存」概念（`KernelVersionPage` 内部直接调 `api.install`/`setCustomCliDir`）；拓展 TAB 是「即写即生效」（`disablePlugin` 立即移出 cordis.yml 块到 `.disabled.json`），所以 `saveMode: "manual"` 无浮层；模型 TAB 是「受控组件」，增删改只 `onChange` 上报，由框架置 dirty + 顶部保存浮层，用户点保存才 `saveConfig` 全量落盘，所以 `saveMode: "framework"`。

**Q：为什么 dsh 的密钥不进 settings.yaml，而 pi 的密钥内联写 models.json？**

两者的存储面不同。pi 的 `NeutralProvider.apiKey` 内联写 models.json（pi 的 models.json 是「完整配置」语义，密钥是其中一部分）；dsh 的密钥写 `prefs.dshApiKeys`（`~/.my-harness-desktop/config/config.json`），spawn 时按 `apiKeyEnvFor(provider)` 注入 `<apiKeyEnv>=<key>` 环境变量。原因是 dsh 的 settings.yaml 是「用户文档」、会被 dsh 运行时读取，密钥字面值不该落进内核能读的 YAML；而 `apiKeyEnv` 字段本身（只是环境变量名）仍写在 settings.yaml 里，作为连接事实的一部分。这个分家是 `createDshModelsApi` 里 `setImpl` 的两条写路径（`setProvider` 写 settings.yaml + `writeApiKey` 写 prefs）实现的。

**Q：dsh 的内核版本为什么用 `distTag: "next"` 而不是默认的 `latest`？**

因为 dsh 的 `latest` dist-tag 是陈旧的 0.0.1-rc.x（依赖坏），真实发版 0.1.0-rc.7 挂在 `next`。若用 `latest`，`listVersions` 的「最新版本」显示错误，且附带插件包不写 `@version` 时会落到陈旧的 latest，与主包 peer deps 冲突 → ERESOLVE → 安装永远失败。所以 `DSH_SPEC.distTag: "next"` 是根因修复，不是偏好。

**Q：为什么 dsh 的配置表单 `fields()` 返回空，而 pi 的表单有字段清单？**

因为两者的 schema 位置不同。pi 的 settings.json 字段 schema 可解析自内核 `.d.ts` 文件（`parseSettingsSchema`），所以 `createPiConfigApi` 能吐字段清单；dsh 的字段 schema 在它的运行时（cordis 插件注册的 schemastery schema），不落文件、桌面读不到。桌面不该复制 dsh 的字段知识（那是 dsh 自己的信息），所以 `createDshConfigApi.fields()` 返回 `[]`，壳表单退化成 `KernelConfigForm` 的 `InferredField`「按值递归推断类型」通用 JSON 编辑器。

**Q：`assertPiAiRouteServiceable` 为什么只拦「空 models」这一种毒源？**

因为「空 models」是唯一确定不可服务的毒源：dsh 运行时按「整段 llm-pi-ai 全有或全无」注册，一个空路由会让 `resolveProfiles` 抛 "resolves no models" → 整段被拒 → 连带其它合法路由（含正在测的 provider）一起失效，症状是 initialize 报 "no adapter registered"。缺 baseURL 是否毒化取决于该路由在 pi-ai catalog 里有无兜底，桌面端无从得知，所以不拦——避免误杀 catalog 路由的「空串清覆盖」语义。

**Q：拓展 TAB 里「禁用」和「卸载」有什么区别？**

禁用是「移出 cordis.yml 到 `.disabled.json`，可还原」——`DshConfigSource.disablePlugin` 把块文本存进 `cordis.yml.disabled.json`，`enablePlugin` 还原，包仍在 node_modules。卸载是「npm uninstall 出内核目录 + 彻底摘 cordis 块」——`DshExtensionManager.doUninstall` 先 `removePluginBlock` 再 `uninstallPlugin`，相对路径随附插件只摘块不 npm 卸。语义不同：禁用是「暂时不跑」，卸载是「彻底移除」。

**Q：dsh-manager 改了默认模型后，正在跑的会话会立即用新模型吗？**

不会。dsh 的模型在 initialize 握手时定（`dsh-backend.ts` 的 `start()` 发 `initialize` 带 `provider/model`），运行中 `session/setModel` 缺面时 no-op（模型停在握手值）。所以改默认模型只影响**下一次 spawn**（`assemble.ts` 的 `getDefaultModel()` 兜底在 create 时读），正在跑的会话要重开才生效。`dsh-manager:defaultChanged` 事件只是通知其他插件「默认模型配置变了」，不驱动运行时切换。

**Q：为什么 dsh-manager 和 pi-manager 的拓展 TAB 文案完全相同？**

因为拓展 TAB 的 UI 已经收敛进共享 base `KernelExtensionsPage`，pi 和 dsh 的拓展页是「同一件事」（一根 enabled 轴 + 元信息 + 受保护 + 重启协调），文案共享同一份 `ext.*` 命名空间。两份 `ext.json` 逐字相同是「内容不各写一份」的体现——差异（标题 `settings.extensions` vs `dsh.extTitle`）由外层薄封装用各自的 i18n key 传，base 只收 `title: string`。
