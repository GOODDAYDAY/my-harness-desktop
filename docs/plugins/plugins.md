# 插件架构与开发指南

## 1 为什么是插件

pi-desktop 是一个薄壳——内核只提供让功能挂上来的机制，一切功能是插件。这不是"方便扩展"的可选项，是架构纪律：内核的功能含量趋近于零，文案、配色、管理页、渲染逻辑、业务分支全是外挂的插件，不焊死在内核里。

为什么这么极端？因为内容会变，机制相对稳定。把功能焊死在内核里，意味着每次改一个文案、调一个配色、加一种渲染类型，都要动内核、都要发版、都要全量回归。把功能推到插件里，改功能只动对应的插件，内核一行不动。VSCode 是这套模型最成功的工业级样本——它的语言包、主题、默认渲染器全是插件，不是硬编码。

pi-desktop 借用 VSCode 的架构纪律（薄壳 + 槽位契约 + 无特权差异），但不借用它的 API 形状——那是为代码编辑器优化的，不是为对话式桌面应用优化的。pi-desktop 的槽位是"会话列表""设置页""主题"，不是"编辑器面板""调试适配器"。

内置默认插件随壳分发、保证开箱即用，但架构地位和第三方插件完全平等——走同一套加载器、同一套契约，优先级最低、可被覆盖。删掉任何一个内置插件，内核应该照常启动，只是少了那块功能。内核不该有任何"识别内置插件并特殊对待"的代码路径。

## 2 槽位契约

### 2.1 槽位是什么

槽位是内核预定的挂载点。插件往槽位上挂内容，内核只认槽位契约不认具体插件。换掉所有插件，内核机制一行不动——加载器照常加载，注册表照常注册，只是渲染时查不到内容。

这套设计的关键是：内核不反向 import 插件代码。插件在启动时把自己的 contribution 写入注册表，内核在渲染时查注册表按优先级选渲染器。"读注册表"不等于"依赖插件代码"，依赖方向仍然只向内。

### 2.2 当前有哪些槽位

当前内核预定了六个槽位：

- **`sidebar`**：左侧栏。插件往这里挂列表和树——会话列表、项目列表。每个贡献项声明 id、title、component、order，内核按 order 排序渲染。

- **`sidePanel`**：右侧面板。插件往这里挂工具页——会话树、Git review、Context 文件、Run 面板、Token 统计。每个贡献项声明 id、label、icon、component、order。

- **`mainView`**：中区主视图。插件往这里挂主界面中区的整页渲染——如 timeline 插件贡献会话消息流（消息气泡、思考块、工具调用、分隔线）。每个贡献项声明 id、component、order，内核按 order 选第一个渲染。

- **`settings`**：设置页。插件往这里挂配置页——Pi 管理、模型管理、主题管理、语言。每个贡献项声明 id、title、component、configFile（可选）、configMerge（可选）、order。

- **`themes`**：主题。插件往这里挂配色方案——每个方案是一组 token key-value，如 `"color.primary": "#89b4fa"`。token key 是稳定契约（`color.primary`），token 值是会变的内容（`#89b4fa`）。

- **`languages`**：语言。插件往这里挂文案包——每个语言是一组 namespace + key-value 的 JSON 资源文件，如 `i18n.common` namespace 下的 `"app.title": "pi-desktop"`。

### 2.3 优先级与覆盖

插件按来源分三个优先级：`builtin`（内置，最低）< `user`（用户目录）< `project`（项目目录，最高）。同级时按声明顺序，先声明的先选。这个规则是确定性的——不会出现"这次加载 A 下次加载 B"的随机行为。

高优先级插件可以覆盖低优先级插件的槽位贡献。比如内置的 `theme` 插件贡献了一个 `dark` 主题，用户目录下放一个 `my-theme` 插件也贡献 `dark`——后者覆盖前者，内核不会"识别这是内置的所以不让覆盖"。

### 2.4 新增一个槽位需要改什么

新增槽位不是插件能做的事，是内核演进。需要改的地方：`domain/contributions.ts` 加槽位类型定义，`application/loader/registry.ts` 加注册逻辑，`shell/renderer/` 加渲染逻辑。这是"机制"的事，不是"内容"的事。

## 3 插件加载器

### 3.1 发现

加载器从四个目录扫描插件，按优先级从低到高：

- **builtin**：`src/plugins/`，随源码分发，优先级最低。
- **installed**：通过安装器安装的第三方插件包。
- **user**：`~/.pi-desktop/plugins/`，用户手动放的插件。
- **project**：`<cwd>/.pi-desktop/plugins/`，项目级插件，优先级最高。

同名插件高优先级覆盖低优先级。发现阶段只扫描目录、读 `plugin.json`、校验 schema，不执行任何插件代码。

### 3.2 校验

`plugin.json` 的必填字段是 `id`、`version`、`displayName`。`contributes` 可选——纯主题插件可能只有 `contributes.themes`，纯功能插件可能有 `contributes.sidebar`。`permissions` 可选——声明了额外能力需求。`configFile` 可选——声明了框架自动管配置生命周期。

校验不通过的插件被跳过，加载器不崩溃——一个坏插件不该影响其他插件加载。这和"无特权差异"一脉相承：内核不信任任何单个插件，包括内置的。

### 3.3 注册

校验通过的插件，其 `contributes` 被写入注册表（一个内核维护的 Map，按槽位分类：`sidebarComponents`、`sidePanelComponents`、`settingsComponents`、`themes`、`languages`）。渲染时内核查注册表按优先级和 order 选渲染器。

注册表只存声明（什么插件贡献了什么），不存代码引用。代码引用在 renderer 侧通过 `registerSidebarComponent("SessionsSection", SessionsSection)` 这样的函数建立——插件 renderer 文件 import 时执行注册，把 React 组件按名字写入同一个注册表。这两步是分开的：manifest 声明"我贡献了一个叫 `SessionsSection` 的 sidebar 组件"，renderer 注册"`SessionsSection` 对应这个 React 组件"。

### 3.4 生命周期

插件的生命周期由加载器管。activate 时插件代码被加载执行（renderer 侧的 `import` 触发注册），deactivate 时插件被卸载（组件从注册中心移除），dispose 时插件资源被清理。一个插件出错不该影响其他插件——加载器做错误隔离，单个插件崩溃只影响它自己挂载的那个槽位。

### 3.5 renderer 侧加载：按文件物理形态分派

main 进程不加载插件 renderer 代码（main 是 CJS，import React ESM chunk 会失败）。插件 renderer 的加载在 renderer 侧 `plugins-host.ts` 统一完成，按文件物理形态分派：

- **builtin 插件**：源码编译进 bundle，经 `import.meta.glob` 加载（编译期路径解析，Vite 生成 chunk）。
- **第三方插件**（installed/user/project）：独立 js 文件，经 `import(file://path)` 运行期加载。

两条路径各自内部一视同仁——glob 对所有内置平等、file:// 对所有第三方平等。判据是"文件物理形态"（源码 vs 独立文件），不是"是否内置特权"。main 侧的 pluginLoader 是 no-op——main 只管注册和通知，不碰 renderer chunk。

热加载：`onPluginsChanged` 事件触发时，对 enabled 且未加载的 builtin 重新执行 glob chunk，对第三方重新 `file://` import（带时间戳避缓存，拿新版本）。

## 4 通信模型

### 4.1 内核和插件怎么通信

pi-desktop 基于 Electron 构建。Electron 有两个进程：main（Node.js 主进程，管文件系统、子进程、窗口）和 renderer（Chromium 渲染进程，跑 React UI）。两者之间靠 preload 脚本通过 `contextBridge` 暴露一个叫 `window.pi` 的受控对象通信。每个 `window.pi` 方法背后是一个 IPC 调用，由 main 进程处理后返回结果。

插件（renderer 侧）看到的不是 Node、不是 Electron、不是文件系统，而是这个 `window.pi` 对象。它能做什么，取决于 `window.pi` 上暴露了多少——暴露了就有的用，没暴露就没有。插件不直接拼 pluginId 参数调 `window.pi`——那样容易写错、没有权限语义。正确姿势是经 `usePluginContext(pluginId)`（从 `@pi-desktop/react` 导入的 React hook）拿绑定后的上下文：config/sessions/fs/git/dialog 都已按 pluginId 预绑定，插件只管调，不用关心自己的 id 是什么。

### 4.2 插件之间怎么通信

插件之间不直接通信。没有插件 A 调插件 B 的接口，没有插件 A 发事件给插件 B 的通道。这是有意的——插件之间的直接通信会创造隐式依赖，而隐式依赖是架构腐化的起点。

插件之间的间接通信通过共享状态完成。内核维护一个 session store（zustand 状态管理库），通过 `@pi-desktop/react` 的 hooks 暴露给插件——插件不直接 import zustand，而是调 `usePluginContext` 返回的 sessions API 间接读写。会话列表、当前会话的消息、模型信息、主题 token 都在 store 里。插件 A 改了某个状态（比如用户切换了模型），所有订阅了这个状态的插件自动收到更新。这不是插件 A 通知插件 B，而是插件 A 改了共享状态，插件 B 作为订阅者被通知。

i18n 是另一个间接通信的例子。i18n 插件贡献了所有语言的文案包，其他插件通过 `t("key")` 消费——插件不需要知道文案是谁贡献的，只需要知道 key 是什么。

### 4.3 为什么不允许插件间直接通信

因为直接通信创造耦合，耦合创造不可维护。插件 A 调插件 B 的接口，意味着 A 依赖 B 的存在、B 的 API 形状、B 的版本。B 升级改了 API，A 就崩。B 被卸载了，A 就崩。这些隐式依赖在代码里看不出来——只有运行时才知道 A 依赖 B。

通过共享 store 间接通信，插件 A 只依赖 store 的数据形状，不依赖任何其他插件是否存在。B 没了，只是 store 里少了某些数据，A 可以优雅降级。框架不提供插件之间的直接调用通道，是有意的。

## 5 权限模型

### 5.1 核心默认能力

所有插件都能用的能力，不需要在 `plugin.json` 里声明权限：

- **config**：读写插件自己的配置 `~/.pi-desktop/plugins-data/{id}/config.json`
- **prefs**：桌面偏好（当前主题、字号等）
- **themes**：主题列表和合并
- **settings**：设置页槽位清单
- **sessions**：会话能力（发消息、切会话、列模型等）
- **i18n**：语言资源
- **models**：模型配置
- **kernel**：pi 内核管理

### 5.2 声明能力

需要额外声明才能用的能力：

- **fs:project**：文件系统只读，访问当前项目目录。文件预览插件需要这个。
- **git:read**：Git 只读，访问工作区状态和 diff。Git review 插件需要这个。

声明方式：在 `plugin.json` 的 `permissions` 数组里加字符串。main 进程在 IPC 边界检查——没声明就调，直接抛错。

### 5.3 用户手势驱动

- **dialog**：打开目录、打开图片。由用户手势触发，默认放行。

### 5.4 声明了但不授权

插件功能受限但不崩溃。比如文件预览插件声明了 `fs:project`，用户不授权，那预览功能不可用，但插件本身能加载、能挂载、能显示一个"需要文件系统权限"的提示。权限校验在 main 进程的 IPC 边界——插件调了没授权的能力，IPC handler 直接拒绝，插件收到一个错误，自己决定怎么呈现。

---

## 6 三个接入点

一个插件要接入 pi-desktop，需要触碰的接入点只有三个。

### 6.1 plugin.json

插件的身份证。声明 id、版本、入口文件、contributes（往哪些槽位挂什么）、permissions（需要哪些额外能力）。内核读这个文件来决定怎么加载这个插件、给它什么能力、把它挂到哪些槽位。

完整字段示例：

```json
{
  "id": "my-plugin",
  "version": "0.1.0",
  "displayName": "My Plugin",
  "description": "一句话描述插件功能",
  "renderer": "./renderer/index.tsx",
  "permissions": ["fs:project"],
  "protected": false,
  "tier": "community",
  "contributes": {
    "sidebar": [
      { "id": "my-section", "title": "My Section", "component": "MySection", "order": 10 }
    ],
    "mainView": [
      { "id": "my-main-view", "component": "MyMainView", "order": 100 }
    ],
    "settings": [
      {
        "id": "my-settings",
        "title": "My Settings",
        "component": "MySettingsPage",
        "configFile": "~/.pi-desktop/plugins-data/my-plugin/config.json",
        "configMerge": "deep",
        "order": 30
      }
    ]
  }
}
```

字段说明：

- `id`：插件唯一标识，用于权限绑定和配置目录名。
- `version`：语义化版本号。
- `displayName`：显示名（plugin-manager 页面 fallback 用，优先走 i18n `plugin.<id>.displayName`）。
- `description`：可选，一句话描述插件功能（plugin-manager 页面展示，优先走 i18n `plugin.<id>.description`）。
- `renderer`：UI 入口文件路径。
- `permissions`：可选，声明额外能力。当前支持 `fs:project`（文件系统只读）和 `git:read`（Git 只读）。
- `protected`：可选，声明 `true` 后该插件不可从注册表卸载（可禁用但不可 uninstall）。无特权差异——由 manifest 声明，不靠内核硬编码 id 列表。
- `tier`：可选，信任级别 `official` / `verified` / `community`。未声明统一 `community`（不按 source 自动赋级，避免"内置=官方"隐性特权）。
- `contributes`：可选，声明往哪些槽位挂什么。每个槽位的贡献项形状不同（见 §2.2）。
- `contributes.settings[].configFile`：可选，声明后框架自动管该设置页的配置读/写/dirty/save/reset。
- `contributes.settings[].configMerge`：可选，`deep`（深合并）或 `replace`（整份覆盖）。不声明 configFile 的设置页不参与框架 save。
- `tokenSchemaVersion`：可选，仅 themes 槽位贡献项需要。声明 token schema 版本，如 `"^1.0"`。

### 6.2 renderer/index.tsx

插件的 UI 入口。一个 React 组件文件，通过 `@pi-desktop/react` 拿受控 API，渲染界面并注册到槽位。

最简骨架（sidebar 槽位）：

```tsx
import { registerSidebarComponent, usePluginContext } from "@pi-desktop/react";

const PLUGIN_ID = "my-plugin";
registerSidebarComponent("MySection", MySection);

function MySection(): React.ReactNode {
  const ctx = usePluginContext(PLUGIN_ID);
  // ctx.config / ctx.sessions / ctx.fs / ctx.git / ctx.dialog 已按 PLUGIN_ID 预绑定
  return <div>My Plugin</div>;
}
```

注册函数按槽位分四个：`registerSidebarComponent`（左栏）、`registerSidePanelComponent`（右面板）、`registerSettingsComponent`（设置页）、`registerMainViewComponent`（中区主视图）。注册的组件名必须和 `plugin.json` 里 `contributes` 中声明的 `component` 字段一致——内核按名字查注册中心。对应的 unregister 函数用于热加载卸载：`unregisterSidebarComponent` / `unregisterSidePanelComponent` / `unregisterSettingsComponent` / `unregisterMainViewComponent`。

### 6.3 window.pi

插件的能力入口。`usePluginContext` 返回的 `PluginContext` 对象，背后是 `window.pi` 上的 IPC 调用。这是插件和内核之间的唯一通道——插件想读配置、想调会话、想访问文件系统，都走这条路。

`PluginContext` 包含：

- `config`：读写插件自己的配置（`config.get(key)` / `config.set(key, value)` / `config.all()`）
- `sessions`：会话能力（`sessions.list(cwd)` / `sessions.prompt(text)` / `sessions.openSession(path)` / `sessions.onEvent(cb)` 等）
- `fs`：文件系统（`fs.listDir(cwd)`），需声明 `fs:project` 权限
- `git`：Git 只读（`git.status(cwd)` / `git.fileDiff(cwd, path)` / `git.fileContent(cwd, path)`），需声明 `git:read` 权限
- `dialog`：对话框（`dialog.openDirectory()` / `dialog.openImages()`），用户手势驱动
- `i18n`：翻译（`i18n.t(key, vars)` / `i18n.locale`）

三个接入点，三种职责：manifest 管声明，renderer 管呈现，window.pi 管能力。插件不需要碰 main 进程代码、不需要碰 preload 代码、不需要碰内核的任何实现细节——它只需要知道这三个接入点的形状。

## 7 框架管什么，插件管什么

### 7.1 框架自动管

框架（core 的机制部分）管所有插件都需要做的事——这些事收进框架统一承担，不让每个插件各写一遍：

- **save/dirty/reset**：插件在 manifest 里声明 `configFile`，框架自动管读、写、dirty 追踪、保存、重置。插件只管渲染和调 `onChange` 报告改动。
- **拦截**：有 dirty 时切 tab/返回对话，框架弹窗"保存/丢弃/取消"。插件不用自己写拦截逻辑。
- **刷新**：框架提供刷新按钮，重读当前 configFile。刷新通过 `refreshSignal` prop 传递——框架刷新按钮触发 +1，组件 useEffect 依赖它重拉数据。
- **打开配置**：框架提供"打开配置"按钮，用系统默认编辑器打开插件的 configFile。插件不用自己拼路径。
- **样式**：框架提供 `SettingsSection`（只边框无填色）、`ListItem`（列表项样式），所有插件统一。插件不用自己写边框和 hover 样式。
- **语言**：框架管 i18n 初始化和语言切换，插件只管调 `t("key")`。

### 7.2 插件只管

插件只管两件事：渲染 UI，和报告改动。

**渲染 UI**：插件的 `renderer/index.tsx` 是一个 React 组件，接收 props，渲染自己的界面。想怎么画怎么画，框架不管。

**报告改动**：用户改了什么东西，插件调 `onChange` 告诉框架"有改动了"。框架接到 `onChange` 后设 dirty，弹出保存浮层，用户点"确定改动"后框架写回 configFile。插件不用自己写 save 逻辑、不用自己管 dirty 状态、不用自己弹拦截窗。

### 7.3 configFile 声明

设置页插件（`contributes.settings`）可以在 manifest 里声明 `configFile` 和 `configMerge`。声明后，框架全管配置生命周期：

- **读**：框架读 configFile，传入设置页组件的 `config` prop。
- **写**：用户点"确定改动"，框架按 `configMerge` 策略写回 configFile。`deep` = 深合并（保留未改字段），`replace` = 整份覆盖。
- **dirty**：组件调 `onChange` 后框架设 dirty，弹出保存浮层。
- **reset**：用户点"取消改动"，框架重读 configFile，丢弃组件的改动。
- **打开配置**：框架"打开配置"按钮用系统编辑器打开 configFile 路径。

不声明 configFile 的设置页插件（如 theme-manager）不参与框架 save——它没有配置文件需要持久化，自己管自己的状态。`refreshSignal` 只传给设置页组件（`SettingsComponentProps` 的一个字段）；sidebar 和 sidePanel 组件不接收 `refreshSignal`——它们通过 `useUiStore()` 订阅全局状态变化自行决定刷新时机。

## 8 从零写一个插件

### 8.1 创建目录和 plugin.json

在 `src/plugins/` 下创建插件目录，放一个 `plugin.json`：

```
src/plugins/my-plugin/
  plugin.json
  renderer/
    index.tsx
```

最简 `plugin.json`（左栏列表，零权限，零配置）：

```json
{
  "id": "my-plugin",
  "version": "0.1.0",
  "displayName": "My Plugin",
  "renderer": "./renderer/index.tsx",
  "permissions": ["fs:project"],
  "contributes": {
    "sidebar": [
      { "id": "my-section", "title": "My Section", "component": "MySection", "order": 10 }
    ]
  }
}
```

注意：如果你要写一个不需要文件系统访问的简单插件，删掉 `permissions` 字段即可。这里声明 `fs:project` 是因为 §8.2 的示例代码用到了 `ctx.fs.listDir`。

### 8.2 写 renderer 组件

```tsx
import { useEffect, useState } from "react";
import { registerSidebarComponent, usePluginContext, useUiStore, ListItem } from "@pi-desktop/react";

const PLUGIN_ID = "my-plugin";
registerSidebarComponent("MySection", MySection);

function MySection(): React.ReactNode {
  const ctx = usePluginContext(PLUGIN_ID);
  const { currentCwd } = useUiStore();
  const [items, setItems] = useState<string[]>([]);

  useEffect(() => {
    if (!currentCwd) { setItems([]); return; }
    void ctx.fs.listDir(currentCwd).then((entries) => {
      setItems(entries.map((e) => e.name));
    });
  }, [currentCwd]);

  return (
    <div>
      {items.map((name) => (
        <ListItem key={name} onClick={() => { /* do something */ }}>
          {name}
        </ListItem>
      ))}
    </div>
  );
}
```

注意三个关键点：

- `registerSidebarComponent("MySection", MySection)` 在文件顶层执行，名字必须和 manifest 里 `component` 字段一致。
- `usePluginContext(PLUGIN_ID)` 返回已绑定的上下文，`ctx.fs` / `ctx.git` / `ctx.config` 都不用拼 pluginId。
- `useUiStore()` 拿桌面全局状态（当前工作目录等），`ListItem` 用框架提供的列表项样式。

### 8.3 声明槽位贡献

在 `plugin.json` 的 `contributes` 里声明。每个槽位的贡献项形状不同：

- `sidebar`：`{ id, title, component, order }`
- `sidePanel`：`{ id, label, icon, component, order }`
- `settings`：`{ id, title, component, configFile?, configMerge?, order }`
- `themes`：`[{ id, name, tokens: { "color.primary": "#89b4fa", ... } }]`
- `languages`：`[{ id, locale, resources: "./locales/zh-CN/common.json" }]`

一个插件可以同时贡献多个槽位——比如 i18n 插件同时贡献 `languages`（文案包）和 `settings`（语言切换页）。

### 8.4 声明权限（如需要）

如果插件需要访问文件系统或 Git，在 `plugin.json` 里声明：

```json
{
  "permissions": ["fs:project"]
}
```

声明后，`ctx.fs.listDir(cwd)` 才能用——不声明直接调，main 进程的 IPC 边界会直接拒绝抛错。

### 8.5 声明 configFile（如需要配置持久化）

设置页插件可以声明 configFile，让框架管配置生命周期：

```json
{
  "contributes": {
    "settings": [
      {
        "id": "my-settings",
        "title": "My Settings",
        "component": "MySettingsPage",
        "configFile": "~/.pi-desktop/plugins-data/my-plugin/config.json",
        "configMerge": "deep",
        "order": 30
      }
    ]
  }
}
```

声明后，设置页组件接收三个 prop——`refreshSignal`（框架刷新按钮触发 +1，useEffect 依赖它重拉数据）、`config`（框架读进来的配置对象）、`onChange`（报告改动，框架设 dirty + 弹保存浮层）。不用自己读写文件：

```tsx
import { registerSettingsComponent, type SettingsComponentProps } from "@pi-desktop/react";

registerSettingsComponent("MySettingsPage", MySettingsPage);

function MySettingsPage({ refreshSignal, config, onChange }: SettingsComponentProps): React.ReactNode {
  // config 是框架读进来的配置对象
  // onChange(newConfig) 告诉框架"改动了"，框架设 dirty + 弹保存浮层
  // refreshSignal 变化时重拉数据（框架刷新按钮触发）
  const myValue = (config.myKey as string) ?? "default";
  return (
    <input
      value={myValue}
      onChange={(e) => onChange({ ...config, myKey: e.target.value })}
    />
  );
}
```

## 9 现有插件参考

### 9.1 最简单的插件——sessions-list

`sessions-list` 插件贡献了一个 sidebar 槽，零权限，零 configFile。它的 `plugin.json` 只声明了 `contributes.sidebar`，renderer 通过 `ctx.sessions.list(cwd)` 拉会话列表。这是"纯展示 + 零配置"插件的最简范本。

关键模式：`registerSidebarComponent("SessionsSection", SessionsSection)` 在文件顶层执行，`usePluginContext(PLUGIN_ID)` 绑定上下文，`useUiStore()` 拿全局状态。数据通过 `ctx.sessions` 拉取，不需要声明任何权限。

### 9.2 带配置的插件——pi-manager

`pi-manager` 插件贡献了一个 settings 槽，声明了 `configFile: "~/.pi/agent/settings.json"` 和 `configMerge: "deep"`。框架自动管配置的读/写/dirty/save/reset/拦截。插件只管渲染 UI 和调 `onChange` 报告改动。

关键模式：`registerSettingsComponent("PiManagerPage", PiManagerPage)` 注册设置页组件，组件接收 `{ refreshSignal, config, onChange }` 三个 prop。`usePiApi()` 是 `@pi-desktop/react` 导出的另一个 hook，直接返回 `window.pi` 对象——用于调框架没封装的底层 API（如 `pi.kernel.status()` 查内核版本、`pi.kernel.listVersions()` 列可用版本）。它和 `usePluginContext` 的区别是：`usePluginContext` 返回按 pluginId 预绑定的上下文（有权限语义），`usePiApi` 返回原始 API（无绑定，调用时需自己拼 pluginId）。点路径读写用 `dot-prop` 包，版本比较用 `semver` 包——这是"手写收敛到成熟包"原则的落地。

### 9.3 带权限的插件——git-review

`git-review` 插件贡献了一个 sidePanel 槽，声明了 `permissions: ["git:read"]`。renderer 通过 `ctx.git.status(cwd)` 拉工作区改动，`ctx.git.fileDiff(cwd, path)` 拿 diff。

关键模式：`permissions` 声明在 `plugin.json` 里，main 进程在 IPC 边界校验。`ctx.git` 的所有方法都已按 pluginId 预绑定——插件不用拼 pluginId 参数。刷新时机有讲究：只在页签可见时刷（`activeSidePanelTab === "review"`），切会话不刷（工作区文件不因切会话而变）——这是"事件驱动，不轮询"的落地。

### 9.4 主题插件——theme

`theme` 插件贡献了 `contributes.themes`，每个主题是一组 token key-value。`plugin.json` 里声明 `tokenSchemaVersion: "^1.0"`，token 定义在 `contributes.themes[].tokens` 里。

关键模式：token key 是稳定契约（`color.primary`），token 值是会变的内容（`#89b4fa`）。主题插件不写 renderer 组件——它只有 `plugin.json`，内核读 token 定义、合并、应用到 CSS 变量。多个主题插件共存，用户在设置页切换。这是"机制与内容分离"的极致落地——内容（配色）完全是声明式的，内核只提供合并和应用机制。

## 10 QA

**Q：一个插件能同时贡献多个槽位吗？**

能。一个插件的 `contributes` 里可以同时声明 `sidebar` 和 `sidePanel`，或同时声明 `themes` 和 `settings`。比如 i18n 插件同时贡献了 `languages`（文案包）和 `settings`（语言切换页）。内核按槽位分别注册，不关心它们是不是来自同一个插件。

**Q：插件可以用 npm 包吗？**

可以。插件是标准的 TypeScript/React 项目，可以 import 任何 npm 包。但要注意：插件不能 import `@/application/...`、`@/gateway/...`、`@/shell/...` 这些内核内部路径——插件只从 `@pi-desktop/core` 和 `@pi-desktop/react` 引用类型和 API。这是依赖方向的纪律：插件是内容层，不依赖内核实现细节，只依赖内核暴露的契约。

**Q：插件怎么响应当前工作目录变化？**

通过 `useUiStore()` 拿 `currentCwd`，在 `useEffect` 的依赖数组里包含它。目录变了，useEffect 重跑，插件重新拉数据。这是"事件驱动，不轮询"的落地——不轮询目录有没有变，而是订阅全局状态变化。

**Q：两个插件往同一个槽位挂了同名的 component，怎么办？**

这是两套规则，别混淆。第一套是**插件优先级**：同名插件（`plugin.json` 的 `id` 相同）高优先级覆盖低优先级（project > user > builtin）。只有最高优先级的那个插件会被加载。第二套是**组件注册**：不同插件可能注册了同名 component（比如两个插件都注册了 `MySection`），后注册的覆盖先注册的。因为插件按优先级顺序加载，高优先级插件后加载，所以后注册的是高优先级的——最终效果和优先级一致。这个规则是确定性的，不会随机。

**Q：插件怎么做 i18n？**

框架管 i18n 初始化和语言切换。插件通过 `ctx.i18n.t("key")` 消费文案——不需要知道文案是谁贡献的，只需要知道 key 是什么。如果插件想贡献自己的文案，在 `plugin.json` 的 `contributes.languages` 里声明 JSON 资源文件。文件格式是 namespace + key-value，和 i18n 插件的格式一致。

**Q：插件的配置文件格式是什么？**

JSON。`configFile` 声明的路径指向一个 JSON 文件。`configMerge: "deep"` 时框架用 deepmerge 深合并——保留未改字段，只写改了的。`configMerge: "replace"` 时整份覆盖。插件不自己写文件操作和锁逻辑——`config-file.ts` 提供通用原语，框架调用它。

**Q：插件能起子进程吗？**

不能直接起。插件是 renderer 侧代码，跑在 Chromium 渲染进程里，没有 Node.js 的 `child_process`。如果插件需要让底座执行命令，走 `ctx.sessions` 的 RPC 通道——`sessions.prompt(text)` 发消息、`sessions.abort()` 中断。底座是"被内核管理的进程"，插件通过内核间接驱动，不直接 spawn。

**Q：插件能访问 pi 底座的配置文件吗？**

能，但走框架管。`pi-manager` 插件声明 `configFile: "~/.pi/agent/settings.json"`，框架读这个文件、传入 `config` prop、写回也由框架做。插件不直接 `fs.readFile` / `fs.writeFile`——文件操作是框架的事，插件只管渲染和报告改动。
