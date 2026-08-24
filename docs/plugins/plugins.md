# PLUGINS.md — 插件架构与开发指南

## 1 为什么是插件

my-harness-desktop 是一个薄壳——内核只提供让功能挂上来的机制，一切功能是插件。这不是"方便扩展"的可选项，是架构纪律：内核的功能含量趋近于零，文案、配色、管理页、渲染逻辑、业务分支全是外挂的插件，不焊死在内核里。

为什么这么极端？因为内容会变，机制相对稳定。把功能焊死在内核里，意味着每次改一个文案、调一个配色、加一种渲染类型，都要动内核、都要发版、都要全量回归。把功能推到插件里，改功能只动对应的插件，内核一行不动。VSCode 是这套模型最成功的工业级样本——它的语言包、主题、默认渲染器全是插件，不是硬编码。

my-harness-desktop 借用 VSCode 的架构纪律（薄壳 + 槽位契约 + 无特权差异），但不借用它的 API 形状——那是为代码编辑器优化的，不是为对话式桌面应用优化的。my-harness-desktop 的槽位是"会话列表""设置页""主题"，不是"编辑器面板""调试适配器"。

内置默认插件随壳分发、保证开箱即用，但架构地位和第三方插件完全平等——走同一套加载器、同一套契约，优先级最低、可被覆盖。删掉任何一个内置插件，内核应该照常启动，只是少了那块功能。内核不该有任何"识别内置插件并特殊对待"的代码路径。

## 2 槽位契约

### 2.1 槽位是什么

槽位是内核预定的挂载点。插件往槽位上挂内容，内核只认槽位契约不认具体插件。换掉所有插件，内核机制一行不动——加载器照常加载，注册表照常注册，只是渲染时查不到内容。

这套设计的关键是：内核不反向 import 插件代码。插件在启动时把自己的 contribution 写入注册表，内核在渲染时查注册表按优先级选渲染器。"读注册表"不等于"依赖插件代码"，依赖方向仍然只向内。

### 2.2 当前有哪些槽位

- **`sidebar`**：左侧栏。插件往这里挂列表和树——会话列表、项目列表。
- **`sidePanel`**：右侧面板。插件往这里挂工具页——会话树、Git review、Context 文件、Run 面板、Token 统计。贡献项可声明 `revealOn: "<channel>"`：该 channel 被 emit/invoke 时框架展开右面板并激活本 Tab（声明式揭示，如 session-bookmarks 声明 `revealOn: "timeline:bookmarkRequested"`，时间线一击收藏后面板自动翻开进入改标题）。
- **`mainView`**：中区主视图。插件往这里挂主界面中区的整页渲染——如 timeline 插件贡献会话消息流。
- **`settings`**：设置页。插件往这里挂配置页——Pi 管理、模型管理、主题管理、语言。
- **`themes`**：主题。插件往这里挂配色方案——每个方案是一组 token key-value。token key 是稳定契约，token 值是会变的内容。
- **`languages`**：语言。插件往这里挂文案包——每个语言是一组 namespace + key-value 的 JSON 资源文件。
- **`fileIcons`**：文件图标。插件往文件树贡献"扩展名/文件名 → 图标"映射（`{id, icon, extensions?, filenames?, color?}`），文件名精确匹配优先；不同 id 的规则按 key 合并、高优先级来源在同 key 上胜出，可只覆盖一个扩展名。内置批次见 file-tree 插件。

### 2.3 优先级与覆盖

插件按来源分四个优先级：`builtin`（内置，最低）< `installed`（插件管理器安装）< `user`（用户目录）< `project`（项目目录，最高）。同级时按声明顺序，先声明的先选。

### 2.4 组件自动匹配

插件不再手动调 `registerXxxComponent("Name", Comp)` 注册组件。框架加载插件 renderer module 后，读 manifest 的 `contributes.*[].component` 字段，在 module 的 exports 里找同名组件，自动注册到对应槽位的注册表。插件只 export 组件，不调任何 register 函数。

两层校验保证一致：TypeScript 编译器保证 export 的名字存在，框架加载时保证 manifest 的 component 名和 export 匹配——找不到就报错。

## 3 插件加载器

### 3.1 发现

加载器从四个目录扫描插件，按优先级从低到高：builtin < installed < user < project。同名插件高优先级覆盖低优先级。发现阶段只扫描目录、读 `plugin.json`、校验 schema，不执行任何插件代码。

### 3.2 校验

`plugin.json` 的必填字段是 `id`、`version`。`contributes` 可选，`permissions` 可选，`dependsOn` 可选。校验不通过的插件被跳过，加载器不崩溃。

### 3.3 注册

校验通过的插件，其 `contributes` 被写入注册表。框架加载 renderer module 后自动完成两件事：读 `module.channels`（如果有）注册事件 channel，读 manifest contributes 自动匹配组件。

### 3.4 生命周期

插件的生命周期由加载器管。activate 时插件代码被加载执行，deactivate 时插件被卸载（组件从注册中心移除、事件 channel 注销），dispose 时插件资源被清理。一个插件出错不该影响其他插件。

### 3.5 renderer 侧加载

main 进程不加载插件 renderer 代码。插件 renderer 的加载在 renderer 侧 `plugins-host.ts` 统一完成，按文件物理形态分派：builtin 插件经 `import.meta.glob` 加载，第三方插件经 `import(file://path)` 运行期加载。

`dependsOn` 是生命周期护栏（卸载/停用拦截），不控制加载顺序——全部插件并行加载，channel 在 module 加载期注册、订阅在组件挂载期发生，挂载天然晚于注册。

## 4 插件上下文

### 4.1 PluginContext 是什么

PluginContext 是插件代码能拿到的唯一 API 对象。插件在 React 组件内调 `usePluginContext()` 获取，不需要传参、不需要手写 pluginId。

PluginContext 分三层：

**pluginId 绑定层**——调用时不用传 pluginId，框架从 `PluginIdContext`（React Context）自动读取。这个 Context 由 shell 的四个槽壳组件在渲染插件组件时用 `<PluginIdContext.Provider value={item.pluginId}>` 包裹注入。

- `ctx.config.get(key)` / `ctx.config.set(key, value)` / `ctx.config.all()`：插件配置读写，统一项目级通道（unified-project-config.md）——默认读写项目级 `<cwd>/.my-harness-desktop/config/{pluginId}.json`，全局 `~/.my-harness-desktop/config/{pluginId}.json` 自动兜底（顶层 key 浅合并，项目级只存 diff）。不拼路径、不感知 cwd。天然全局的数据用 `set(key, value, { scope: "global" })` 显式写全局；`getScope("project" | "global")` 读单层原始快照（并集型数据用，覆盖型配置用 `all()` 即可）
- `ctx.fs.listDir(cwd)` / `ctx.fs.removePath(path)`：文件系统访问（需声明 `fs:project` 权限）
- `ctx.git.status(cwd)` / `ctx.git.fileDiff(cwd, path)` / `ctx.git.fileContent(cwd, path)`：Git 只读（需声明 `git:read` 权限）
- `ctx.bash?.runBash(command)` / `ctx.bash?.abortBash()`：Bash 执行（需声明 `rpc:bash` 权限）

**系统级 API 层**——不绑 pluginId，框架透传，所有插件可用：

- `ctx.prefs` / `ctx.themes` / `ctx.kernel` / `ctx.modelsConfig` / `ctx.piSettings` / `ctx.sessions` / `ctx.messaging` / `ctx.i18n` / `ctx.dialog` / `ctx.plugins` / `ctx.extension` / `ctx.skills` / `ctx.restart` / `ctx.openFile`
- `ctx.configFile.get(path)`：只读旧数据迁移窄口（一次性搬迁白名单内 JSON 用）。**常规配置读写走 `ctx.config`，新代码勿用**

**事件层**——插件间通信唯一通道：

- `ctx.events.emit(channel, payload?)`：发布事件
- `ctx.events.on(channel, handler, opts?)`：订阅事件，返回 cleanup 函数

### 4.2 零硬编码

插件代码中不允许出现以下内容的字符串字面量：

- **plugin ID**：不写 `const PLUGIN_ID = "my-plugin"`，pluginId 由 PluginIdContext 自动注入。`usePluginContext()` 无参调用。
- **component 注册名**：不调 `registerSidePanelComponent("MyTab", MyTab)`，只写 `export function MyTab()`。框架从 manifest 自动匹配。
- **slot contribution ID**：不写 `activeSidePanelTabs.includes("my-tab")` 判断自身可见性。框架渲染组件时传 `isActive` prop。
- **配置文件路径**：不写 `window.pi.configFile.get("~/.my-harness-desktop/config/general.json")`。如果需要消费另一个插件的配置状态，通过事件订阅。

这些规则由 lint 强制执行（`no-restricted-syntax` 拦截 `window.pi` 直访、`PLUGIN_ID` 常量、`usePiApi` 调用、`registerXxxComponent` 调用），在 `src/plugins/` 目录下零容忍。

### 4.3 API 单入口

插件代码不直接访问 `window.pi`，不通过 `usePiApi()` 拿原始全局对象。统一经 `usePluginContext()` 拿受控 API。

`usePiApi()` 已废弃并删除。`window.pi.*` 直访被 lint 拦截。唯一允许的例外是 `packages/react/src/plugin-context.ts`（它内部需要调 `window.pi` 实现 Context）和 `src/shell/` 目录（shell 层可以直接用 `window.pi`）。

## 5 事件总线

### 5.1 插件间通信唯一通道

插件之间不通过共享 store 互读写、不通过 `window.pi` 直调对方能力、不通过框架全局事件挂载在 `window.pi` 上。唯一合法的插件间通信是 `ctx.events.emit/on`。

框架→插件、插件→框架的通信走 PluginContext API，不在此限。共享 store 允许读，不允许调 store 的 setter——setter 只允许框架代码调用。插件要改变框架状态走 ctx API（如 `ctx.sessions.setContext(cwd, sessionPath)`），框架处理后更新 store 并 emit 系统事件。

### 5.2 代码即声明

事件 channel 不进 manifest。插件在 renderer 入口文件 export 一个 `channels` 数组：

```tsx
export const channels = ["my-plugin:eventA", "my-plugin:eventB"] as const;
```

框架加载 module 后读 `module.channels`，注册所有声明的 channel。emit 时框架校验 channel 在自己的 `channels` export 里声明过——没声明就报错。

channel 名由发布方全权命名并保证稳定。推荐用 `{pluginId}:{eventName}` 格式——这是约定，框架不强制，不从中提取 pluginId。

### 5.3 dependsOn 与加载顺序

订阅方在 manifest 里声明 `dependsOn`：

```json
{ "id": "my-subscriber", "dependsOn": ["my-plugin"] }
```

框架并行加载全部插件——channel 在 module 加载期注册、订阅在组件挂载期发生，挂载天然晚于注册，所以订阅方 `on` 时 channel 已注册，无需拓扑排序。`dependsOn` 声明的插件不存在或被禁用，订阅方按生命周期护栏拦截。

### 5.4 框架系统事件

框架本身也会 emit 事件，插件订阅不需要声明 dependsOn。框架系统事件用 `system:` 前缀：

| channel | 触发时机 | payload |
|---|---|---|
| `system:configFileSaved` | 配置文件保存 | `{ path }` |
| `system:settingsChanged` | settings.json 被外部写入 | `{ cwd }` |
| `system:layoutChanged` | 布局变更 | `{ layout }` |
| `system:systemThemeChanged` | 系统主题切换 | `{ theme }` |
| `system:refreshRequested` | 刷新请求 | `{}` |

`system:` 前缀的 channel 框架保留 emit 权限，插件 emit `system:*` 会被拒绝。

### 5.5 事件回放

`ctx.events.on("channel", handler, { replayLast: true })` 时，框架检查该 channel 是否有最近一次 emit 的缓存——有就立即调 handler。如果 channel 从未被 emit 过，`replayLast` 不会调 handler，handler 只作为普通订阅者注册。插件卸载时 replay 缓存随 channel 一起清除。

### 5.6 加载与卸载

加载：并行 import 全部 module → 读 channels 注册 → 读 contributes 匹配组件（channel 注册先于订阅挂载）。

插件禁止在模块顶层代码中调用 `ctx.events.emit` 或 `ctx.events.on`——所有事件调用必须放在 React 组件的生命周期里（useEffect、事件处理器）。这条由 lint 强制执行。

卸载：检查 dependsOn 反向依赖（生命周期护栏）→ 有依赖方时阻止卸载 → 自动注销 channel 和 replay 缓存 → cleanup 函数自动调用 → 组件从注册中心移除。

## 6 权限模型

- **核心默认**：config、prefs、themes、settings、sessions、messaging、models、i18n、kernel、piSettings、configFile（只读迁移窄口）、plugins、extension、skills、restart、dialog、events。不需要声明权限。
- **声明能力**：`fs:project`（文件系统只读）、`git:read`（Git 只读）、`git:write`（Git 写面）、`llm:oneshot`（一次性问内核）、`sessions:bus`（会话总线）、`rpc:bash`（Bash 执行）。在 `plugin.json` 的 `permissions` 数组里声明，main 进程在 IPC 边界检查。
- **用户手势驱动**：dialog（打开目录、打开图片）。由用户手势触发，默认放行。

## 7 三个接入点

### 7.1 plugin.json

```json
{
  "id": "my-plugin",
  "version": "0.4.9",
  "displayName": "My Plugin",
  "renderer": "./renderer/index.tsx",
  "permissions": ["fs:project"],
  "dependsOn": ["timeline"],
  "contributes": {
    "sidebar": [
      { "id": "my-section", "title": "My Section", "component": "MySection", "order": 10 }
    ]
  }
}
```

### 7.2 renderer/index.tsx

```tsx
import { usePluginContext, useUiStore, ListItem } from "@my-harness-desktop/react";

export const channels = ["my-plugin:dataChanged"] as const;

export function MySection({ isActive }: { isActive: boolean }): React.ReactNode {
  const ctx = usePluginContext();
  const { currentCwd } = useUiStore();

  useEffect(() => {
    const off = ctx.events.on("system:cwdChanged", () => {
      // 重新拉数据
    }, { replayLast: true });
    return off;
  }, [ctx.events]);

  return <div>My Plugin</div>;
}
```

- `export function MySection()` — 组件名和 manifest 的 `component` 字段一致，框架自动匹配。
- `usePluginContext()` — 无参调用，pluginId 由框架注入。
- `{ isActive }` — 框架传入的可见性 prop。
- `export const channels` — 该插件对外发布的事件 channel 列表。
- sidePanel 组件接收 `{ isActive: boolean }`；settings 组件接收 `{ refreshSignal, config, onChange }`；sidebar 和 mainView 无额外 props。

### 7.3 PluginContext

插件的能力入口。`usePluginContext()` 返回的 PluginContext 对象，背后是 `window.pi` 上的 IPC 调用。

## 8 框架管什么，插件管什么

### 8.1 框架自动管

save/dirty/reset、拦截、刷新、打开配置、样式、语言、组件注册（自动匹配 export）、pluginId 注入（PluginIdContext）、事件 channel 注册（自动读 channels export）、settings:changed 通知（system:settingsChanged）。

### 8.2 插件只管

渲染 UI + 报告改动。

## 9 QA

**Q：插件之间能直接调用吗？**
不能。唯一通信方式是 `ctx.events.emit/on`。A 需要 B 的数据，B 通过事件暴露，A 声明 `dependsOn: ["B"]` 订阅。

**Q：事件 channel 名是硬编码吗？**
不算。channel 名是发布方的对外契约——就像 export 的函数名一样。订阅方写 channel 名引用发布方契约，是 dependsOn 声明的依赖关系，是必要耦合。

**Q：插件能访问 `window.pi` 吗？**
不能。lint 拦截。所有能力走 `usePluginContext()`。

**Q：插件能在模块顶层调 ctx.events 吗？**
不能。所有事件调用必须放在 React 组件生命周期里。lint 拦截顶层调用。

**Q：插件怎么响应工作目录变化？**
订阅 `ctx.events.on("system:cwdChanged", handler, { replayLast: true })`。replayLast 保证加载时立即收到当前 cwd。
