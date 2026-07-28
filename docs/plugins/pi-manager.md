# pi-manager

## 1 这个插件解决什么问题

用户需要管理 pi 底座——查当前装的什么版本、从 registry 列可用版本、升级/降级到指定版本。同时需要编辑底座配置（`~/.pi/agent/settings.json`）。没有这个插件，用户得手动跑 `npm install` 和编辑 JSON 文件。pi-manager 把版本管理和配置编辑放到一个设置页里。

## 2 设计决策

### 2.1 为什么是插件而不是内核

版本管理的 UI 会变——安装进度展示、版本列表排序都会调。配置编辑的表单会变——字段描述会加、分组会调。这些都是内容，推给插件。内核只管"能查/装 pi 版本"这个能力（`pi.kernel.status/listVersions/install`）和"能读写配置文件"这个原语（`config-file.ts`）。

### 2.2 选了什么机制

贡献 `settings` 槽位，`order: 0`（永远第一）。声明 `configFile: "~/.pi/agent/settings.json"` + `configMerge: "deep"`——框架自动管配置的读/写/dirty/save/reset/拦截。零权限——`kernel` 和 `configFile` 都是核心默认能力。

### 2.3 和框架的分工

框架管：组件注册、configFile 生命周期（读/写/dirty/save/reset/拦截/刷新/打开配置）、`SettingsSection` 样式。插件管：内核版本管理 UI（`usePiApi` 调 `pi.kernel.*`）、配置字段表单渲染（`config`/`onChange` prop）。

### 2.4 是否修改了内核

没有。pi-manager 插件只从 `@pi-desktop/react` 导入受控 API——`usePiApi`、`registerSettingsComponent`、`SettingsSection`、`SettingsComponentProps`，外加第三方包 `semver`、`dot-prop`、`react-i18next`（`useTranslation`）。不 import `@pi-desktop/core`，不 import `src/domain/`、`src/gateway/`、`src/application/`、`src/shell/` 的任何文件。插件的全部代码在 `renderer/index.tsx`（356 行）和 `field-descriptors.ts`（134 行）——全部是 React UI 逻辑和字段元数据，零内核代码侵入。

删掉 `src/plugins/pi-manager/` 目录，内核一行不动。设置页第一个 tab 消失（`order: 0` 的 `pi` 设置页），但设置页槽位本身完好——其他设置页 tab 正常渲染。configFile 的声明在 `plugin.json` 的 `contributes.settings[].configFile` 里——插件不在注册表中，框架自然不会去读 `~/.pi/agent/settings.json` 和调用 configFile 生命周期。内核的加载器、configFile 机制、`pi.kernel.*` IPC handler 全部不受影响。
### 2.5 使用了内核的什么功能

pi-manager 插件使用内核提供的以下能力，每一项底层走什么、内核提供什么保障逐条列出：

- **`contributes.settings` 槽位**：`order: 0`（设置页第一个 tab），`component: "PiManagerPage"` 指向 renderer 导出的 React 组件，`configFile: "~/.pi/agent/settings.json"` + `configMerge: "deep"`。内核的插件加载器注册组件后，框架自动管 configFile 的生命周期：读 JSON → 传入 `config` prop → 监听 `onChange` → 设 dirty → 弹保存浮层 → 用户确认后深合并写回。内核保障：`readJsonFile` 带目录不存在则创建、文件不存在返回空对象；`writeJsonFile` 用 `withDirLock` 串行化防多进程竞写；深合并走 `deepmerge` 包。
- **`usePiApi()`（经 `@pi-desktop/react`）**：拿原始 `window.pi` 对象。插件用它调 `pi.kernel.status()`（查当前底座版本和可用性）、`pi.kernel.listVersions(forceRefresh)`（从 npm registry 拉版本列表）、`pi.kernel.install(version, onProgress, onDone)`（安装指定版本）、`pi.piSettings.schema()`（拉底座的 `.d.ts` schema 获得未知字段的类型提示）。底层走 main 进程 IPC → `ipcMain.handle` 处理 → 调 shell 层的子进程管理能力（spawn npm 命令查版本/安装）或文件系统能力（读底座 `.d.ts`）。内核保障：IPC 有权限校验（`kernel` 是核心默认能力，零声明）；`install` 的 `onProgress` 和 `onDone` 回调经 IPC 事件通道转发，顺序和主进程一致；安装失败时返回 `{ ok: false, error }` 而非抛未捕获异常。
- **`config`/`onChange` prop（框架 configFile 机制）**：`config` 是框架从 `configFile` 读进来的 `Record<string, unknown>`，`onChange` 是报告改动的回调。插件改了配置字段后调 `onChange(newConfig)` → 框架记录 dirty → 用户点"确定改动"后框架按 `configMerge: "deep"` 深合并写回文件。内核保障：dirty 追踪带拦截（切 tab/关窗口弹"保存/丢弃/取消"）；保存失败时 dirty 保留允许重试；刷新按钮重读 configFile 并重置 dirty。
- **框架组件**：`SettingsSection`（只边框无填色，`title` + `description` prop）。这个组件在 `@pi-desktop/react` 发布面，内核提供统一的设置页视觉契约。插件自己的 `FieldRow` / `UnknownRow` / `InfoRow` / `kernelBtn` 等小组件是插件内部实现，不依赖内核。
- **`useTranslation`（react-i18next）**：插件自己的所有用户可见文字走 `t("key")`。key 的值由 i18n 插件（或其他语言插件）贡献——pi-manager 不贡献语言资源。
- **`refreshSignal` prop**：框架刷新按钮点击时 `refreshSignal` +1，插件的 `useEffect` 依赖它重拉数据。内核保障：刷新不重载页面，仅重新执行 `useEffect`。
## 3 怎么通信

### 3.1 和内核通信

这个插件同时用两种方式拿内核能力：

- `usePiApi()` 拿原始 `window.pi` 对象——调 `pi.kernel.status()`、`pi.kernel.listVersions()`、`pi.kernel.install()`。这是跨插件的系统能力，不属于任何单个插件的上下文，所以走 `usePiApi` 而非 `usePluginContext`。
- `config`/`onChange` prop（框架从 configFile 读进来的配置对象 + 报告改动的回调）——框架管配置生命周期，插件只管渲染和报告改动。

### 3.2 和其他插件通信

不和其他插件通信。配置写回 `~/.pi/agent/settings.json` 后，pi 底座下次启动时读取新配置——不走插件间通信。

### 3.3 其他插件怎么使用自己

pi-manager 不产生可被其他插件消费的输出。它和 pi 底座交互——读/写 `~/.pi/agent/settings.json` 和调 `pi.kernel.*` 管理底座版本，但这些操作的结果不写入 `useUiStore` 或 `useSessionStore`，其他插件无从感知。

**唯一的间接影响路径**：pi-manager 写的 `~/.pi/agent/settings.json` 在 pi 底座下次启动时被底座读取。底座根据这些配置（默认模型、thinking level、工具偏好等）调整自己的行为。其他插件通过 `useSessionStore` 消费底座产生的会话事件——这些事件的内容（比如模型回复的质量、工具调用的方式）受 `settings.json` 影响。但这个影响是 pi 底座 → 会话事件 → 其他插件，不是 pi-manager → 其他插件。pi-manager 和其他插件之间没有通信通道。

**不受影响的插件**：所有插件都和 pi-manager 无关。theme-manager 管主题切换、pi-model-manager 管 models.json、sessions-list 管会话展示——它们都不依赖 pi-manager 的任何输出。实际上，pi-manager 是目前设置页中最"孤立"的插件——它的输出只改变 pi 底座的行为，不影响桌面端任何其他插件的 UI 或状态。
## 4 怎么处理

### 4.1 上区：内核版本管理

`pi.kernel.status()` 查当前版本和可用性。`pi.kernel.listVersions(forceRefresh)` 从 npm registry 拉版本列表——用 `semver` 包做版本排序和比较，不手写字符串比较（`"0.10.0" < "0.9.0"` 会误判）。`pi.kernel.install(version, onProgress, onDone)` 安装指定版本——进度经 `onProgress` 回调实时更新安装输出，完成经 `onDone` 回调刷新版本状态。安装是覆盖式：装新=升级、装旧=降级。

### 4.2 下区：pi 配置编辑

`config` prop 是框架从 `~/.pi/agent/settings.json` 读进来的对象。`onChange(newConfig)` 报告改动——框架设 dirty + 弹保存浮层，用户点"确定改动"后框架按 `configMerge: "deep"` 深合并写回。点路径读写用 `dot-prop` 包（`getProperty(obj, "a.b.c")` / `setProperty`），不手写路径解析。深拷贝用 `structuredClone`，不手写——React state 需要新引用触发重渲染。

### 4.3 字段描述表

`field-descriptors.ts` 定义 43 个已知配置字段的元数据（key、type、section、description）。未知字段兜底渲染——底座可能支持但未记录的字段也能编辑。`.d.ts` 解析用 TypeScript Compiler API，不正则——正则在嵌套类型、extends、联合类型面前脆弱不堪。

## 5 怎么保证

### 5.1 版本比较正确性

`semver.compare(current, target)` 做语义化版本比较。字符串字典序会误判 `0.10.0 < "0.9.0"`（因为 `"10" < "9"` 字典序成立）。semver 包处理了 prerelease（`0.1.0-beta` < `0.1.0`）等边界。

### 5.2 安装进度不丢

`pi.kernel.install` 有三个回调：`onProgress`（每行 npm 输出）、`onDone`（完成信号）、invoke 返回的 Promise。完成信号以 `onDone` 为准——不靠 invoke 返回值，因为 invoke reply 与 done 事件的顺序不保证（曾经导致 `onDone` 不触发卡住，根因是 preload 在 done 监听器内同步移除自己）。

### 5.3 配置写回安全

框架管写——`writeJsonFile` 用 `withDirLock` 串行化，`configMerge: "deep"` 用 `deepmerge` 包深合并。插件不自己写文件操作。

## 6 如果没有这个插件，整个系统会有什么影响

删掉 `src/plugins/pi-manager/` 目录后，系统仍然能正常启动——内核加载器跳过这个插件，其他一切照常。内核不崩溃，机制全在。但用户失去了以下东西：

**失去的 UI 入口**：设置页第一个 tab（"Pi"）消失。用户无法通过 UI 查看当前 pi 底座版本、无法浏览可用版本列表、无法点击安装/升级/降级。同时失去 pi 底座配置编辑——43 个字段的表单（模型与推理、队列与传输、压缩与重试、工具与 Shell、技能与启动、界面与终端、路径与扩展七个分组）全部不可见。

**失去的功能**：用户必须手动管理 pi 底座。查版本得跑终端命令（`npm list -g @anthropic-ai/claude-code` 或类似）；安装/升级得手动 `npm install`；编辑配置得手动打开 `~/.pi/agent/settings.json` 用文本编辑器修改 JSON。对技术用户可行，对非技术用户等于不可用。特别是 `settings.json` 里的嵌套字段（`compaction.reserveTokens`、`retry.provider.maxRetries` 等），手写 JSON 容易打错 key、写错类型、漏逗号。

**对其他插件的影响**：无。所有插件照常工作——sessions-list 继续展示会话，theme-manager 继续切换主题，pi-model-manager 继续编辑 models.json。桌面端不依赖 pi-manager 的任何输出。

**第三方能否替代**：完全可以。第三方插件贡献 `contributes.settings`（带 `configFile: "~/.pi/agent/settings.json"` + `configMerge: "deep"`）和 renderer 组件（调 `usePiApi().kernel.*` 和 `config`/`onChange` prop）即可完全替代 pi-manager。由于 pi-manager 是 builtin（优先级最低），第三方插件的设置页会覆盖同名 tab。实际上，第三方可以做一个更好的版本管理 UI——比如显示 changelog、一键回滚、安装历史——pi-manager 作为 builtin 只提供最基础的功能。

## 7 QA

**Q：安装过程中用户切走了怎么办？**

安装是异步的——`onProgress` 和 `onDone` 是回调，切走后回调仍然触发。但用户切回来时看到的是安装输出（因为 React state 在 keep-alive 下保持）。安装完成后 `onDone` 回调刷新版本状态。

**Q：降级版本会丢配置吗？**

不会。pi 底座配置存在 `~/.pi/agent/settings.json`，和底座二进制是分开的。降级只换二进制，不碰配置文件。但旧版本底座可能不认识新版本配置里的某些字段——这是底座的事，不是 pi-manager 的事。

**Q：未知字段怎么编辑？**

`field-descriptors.ts` 不认识的所有字段都走兜底渲染——显示 key 和原始值，可编辑。底座 `.d.ts` 解析出的字段也加进来——`pi-settings-store.ts` 用 TypeScript Compiler API 解析底座的类型定义文件，拿到字段名和类型。
