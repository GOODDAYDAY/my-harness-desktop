---
name: write-plugin
description: 在 my-harness-desktop 写新桌面插件、给已有插件加功能、或需要理解插件如何接入内核时使用。覆盖目录结构、槽位契约、PluginContext、插件间事件通信、i18n 自持有接入。触发词：写插件、新建插件、plugin.json、contributes、槽位、sidePanel、PluginContext、插件通信、events.emit、插件 i18n。
---

# 写插件（my-harness-desktop）

内核是薄壳：一切功能是插件，内核只认槽位契约不认具体插件。写插件 = 往槽位上挂内容，三个接入点：`plugin.json`（声明）、`renderer/index.tsx`（呈现）、PluginContext（能力）。深文档：docs/plugins/PLUGINS.md（契约全集），本文是实操速查。

## 1 核心方案（先懂这三条再动手）

1. **薄壳**：文案、配色、管理页、渲染逻辑、业务分支全在插件，内核零内容。token key 合规、token 值违规——你写的文案/颜色属于内容，必须留在插件里，不许进内核。
2. **槽位契约**：插件不注册进内核代码，只在 manifest 声明 contributes。换掉所有插件，内核机制一行不动。组件不写 `registerXxxComponent`，只 export——框架从 manifest 的 `component` 字段自动匹配 export 名。
3. **无特权差异**：内置插件（src/plugins/）和第三方插件走同一套加载器同一套契约。来源优先级四级：builtin（内置，最低）< installed（npm 安装）< user（`~/.my-harness-desktop/plugins/`）< project（`<项目>/.my-harness-desktop/plugins/`，最高）——同级按声明顺序，高级别可覆盖低级别。删了任何一个内置插件，内核照常启动。

## 2 目录结构

### 2.1 内置插件按域分六组

```
src/plugins/
  themes/    外观：默认 theme + ChatGPT/Midnight/Mocha/New York/Stone/Terminal 六套变体（共 7 个纯 JSON 主题插件，零代码）
  sessions/  会话域：sessions-list / session-tree / session-bookmarks / session-colors / timeline
  project/   项目域：projects / file-tree / git-review / notes
  insight/   洞察：token-stats / blind-review
  manager/   管理页：pi-manager / pi-model-manager / plugin-manager / theme-manager / skill-manager / tool-manager / extension-manager
  system/    框架级：i18n / general-config / debug-bar
```

新内置插件按职责归组；第三方插件放 `~/.my-harness-desktop/plugins/<id>/`（平铺，不分组）。

### 2.2 单插件内部形态（两个必有 + 三个按需）

```
my-plugin/
  plugin.json        必有：manifest
  renderer/          必有（有 UI 的插件）：index.tsx 入口 + 子组件
  core/              按需：纯 TS 逻辑——不 import react、不碰 ctx，可裸单测（如 session-tree/core/tree-model）
  client/            按需：出站 IO 封装——碰 ctx.* 的调用收敛一处，组件不直接碰 IPC（如 notes/client/notes-store）
  locales/           按需：i18n 资源，插件自持有（见 §6）
```

## 3 三个接入点（最小骨架）

### 3.1 plugin.json

```json
{
  "id": "my-plugin",
  "version": "0.4.9",
  "displayName": "My Plugin",
  "renderer": "./renderer/index.tsx",
  "permissions": ["fs:project"],
  "dependsOn": ["timeline"],
  "contributes": {
    "sidePanel": [
      { "id": "my-panel", "label": "我的面板", "icon": "box", "component": "MyPanel", "order": 70 }
    ]
  }
}
```

必填只有 `id` + `version`。`renderer` 指向 renderer 入口文件（第三方插件经 `import(file://)` 加载时必需，别省）。`permissions`/`dependsOn`/`contributes` 全可选。

### 3.2 renderer/index.tsx

```tsx
import { useEffect, type ReactNode } from "react";
import { ListItem, usePluginContext, useUiStore } from "@my-harness-desktop/react";

export const channels = ["my-plugin:dataChanged"] as const;

export function MyPanel({ isActive }: { isActive: boolean }): ReactNode {
  const ctx = usePluginContext();               // 无参，pluginId 框架注入
  const cwd = useUiStore((s) => s.currentCwd);  // 共享 store 只读

  useEffect(() => {
    return ctx.events.on("system:cwdChanged", () => { /* 重拉数据 */ }, { replayLast: true });
  }, [ctx.events]);

  if (!cwd) return null;
  return <ListItem>hello</ListItem>;
}
```

- 组件名 === manifest 的 `component` 字段，框架自动匹配，两层校验（tsc + 加载时）。
- 事件调用必须在组件生命周期内，**模块顶层调 ctx.events 被 lint 拦截**。

### 3.3 槽位与 props 形状

| 槽位 | 用途 | 组件 props |
|---|---|---|
| `sidebar` | 左侧栏列表/树 | 无额外 |
| `sidePanel` | 右面板工具页 | `{ isActive }` |
| `mainView` | 中区整页 | 无额外 |
| `titlebar` | 标题栏按钮 | — |
| `settings` | 设置页 | `{ refreshSignal, config, onChange }` |
| `themes` | 配色（纯 JSON 声明，可零代码） | — |
| `languages` | 语言包（§6） | — |
| `messageRenderers` | 消息卡片覆盖默认渲染 | `{ message, streaming }` |
| `fileActions` | 文件上下文动作 | — |

`management`/`cardRenderers`/`viewers`/`commands` 是预留名，声明了会被忽略。注意各槽贡献的显示名字段不同：sidebar 用 `title`、sidePanel 用 `label`（抄骨架时别跨槽复制错）。

## 4 插件间交流：事件唯一通道

**铁律**：插件间不共享 store 互读写、不 `window.pi` 直调对方能力。唯一合法通道是 `ctx.events.emit/on`。共享 store（useUiStore/useSessionStore）只读，setter 只有框架能调。

1. **发布方**：renderer 入口 `export const channels = ["my-plugin:eventX"] as const`——框架加载 module 自动注册。`emit` 只允许自己声明过的 channel，越权抛错。
2. **订阅方**：`ctx.events.on(channel, handler, { replayLast: true })`（返回 cleanup 函数，useEffect 直接 return 即可）+ manifest 声明 `dependsOn: ["publisher"]`。
3. **dependsOn 是生命周期护栏，不是加载顺序控制**：全部插件并行加载（Promise.all），但 channel 在模块加载期注册、订阅在组件挂载期发生——挂载天然晚于注册，订阅时 channel 一定已就绪。dependsOn 的真正作用：依赖方在线时，被依赖插件不能被停用/卸载。被依赖方不存在或被禁用 → 依赖方不加载。
4. **emit 与 invoke 是两种原语，别混用**：`emit` 是发布/订阅（只能发自己声明的 channel，payload 被缓存供 replayLast 回放）——适合可回放的状态广播。`invoke` 是定向分派（调别的插件拥有的 channel，调用方不需要权属）——适合一次性命令：无订阅者时入队，首个订阅者挂载时恰好一次投递，不回放。fileActions 的 `<pluginId>:fileActionInvoke` 约定频道是 invoke 的既有先例。
5. **系统事件**（`system:` 前缀，免 dependsOn，框架保留 emit 权）：
   `system:cwdChanged {cwd}`、`system:sessionChanged {sessionPath}`、`system:panelVisibilityChanged {tabId, visible}`、`system:settingsChanged {}`（空 payload，仅通知信号）、`system:pluginsChanged {nonce}`、`system:systemThemeChanged {}`（系统明暗变化，空 payload）。
   `replayLast: true` 让新订阅者立即收到最近一次 payload——系统事件天然要开。
6. **可选插件的方向纪律**：受保护/核心插件不能 dependsOn 可选插件（可选插件缺席会把核心插件拖垮）。此时反过来：核心插件以 try/catch 兜底订阅可选插件的 channel（on 一个未注册的 channel 会抛错），实例见 timeline 订阅 `notes:fillComposer`。

channel 命名约定 `{pluginId}:{eventName}`——是发布方的对外契约，框架不强制但靠它避免撞名。

## 5 PluginContext 能力速查

`usePluginContext()` 拿到的唯一 API 对象，三层：

- **pluginId 绑定层**：`ctx.config`（插件自己的配置 kv）、`ctx.fs`、`ctx.git`
- **系统级 API 层**：`prefs / themes / kernel / modelsConfig / piSettings / configFile / sessions / messaging / i18n / dialog / plugins / extension / skills / restart / openFile`
- **事件层**：`ctx.events.emit / on / invoke`

**权限模型**：核心默认（上述大部分）免声明；`fs:project` / `git:read` 要在 manifest `permissions` 声明，main 在 IPC 边界检查；dialog 由用户手势驱动默认放行。`configFile` 读写圈禁在 `~/.my-harness-desktop/` 与 `~/.pi/agent/` 前缀内，越界抛错。

**设置页红利**：manifest settings 项声明 `configFile` 后，框架自动管 读/写/dirty/保存浮层/切页拦截/刷新/打开配置——插件只渲染 UI + 调 `onChange` 报告改动。`saveMode` 默认 `"framework"`（托管模式）；即时落盘场景（如 notes 的增删改直接写盘）用 `configFile: null + saveMode: "manual"` 绕过。

## 6 i18n：插件自持有语言资源

去中心化形态（每个插件自带文案，不往 i18n 插件目录塞）：

```
my-plugin/locales/zh-CN/my-plugin.json   { "my-plugin.title": "我的面板" }
my-plugin/locales/en/my-plugin.json      { "my-plugin.title": "My Panel" }
```

manifest 注册（每 namespace × 每语言一条；id 形如 `{pluginId}.{ns}`，ns 可按功能拆——如 notes 同时注册 `notes.notes` 与 `notes.settings`）：

```json
{ "id": "my-plugin.my-plugin", "locale": "zh-CN", "resources": "./locales/zh-CN/my-plugin.json" }
```

组件里用 react-i18next：

```tsx
import { useTranslation } from "react-i18next";
const { t } = useTranslation();
t("my-plugin.title");
```

要点：

- key 第一个 dot 前是 namespace；命名空间以插件 id 开头防撞车（同级插件撞 key 是先处理者胜），一个插件可持多个 namespace（功能域 + settings tab 标题域等）。
- `fallbackLng = "en"`，至少保证 en 或 zh-CN 一份是全的，否则显示裸 key。
- 设置页左 tab 标题走 `settings.<设置项id>` 动态 key——放进自己的 settings.json（如 `settings.notes`）。
- 多插件资源是 key 级 union 合并；user/project 级插件可用同 key 覆盖内置文案（source priority：builtin < installed < user < project）。

## 7 红线（lint 强制，写完必查）

- 禁 `window.pi.*` 直访、`usePiApi`、`PLUGIN_ID` 常量、`registerXxxComponent` 调用
- 禁手写 slot contribution id 判断可见性——框架传 `isActive` prop
- 禁手写配置文件路径字面量——跨插件状态走事件订阅
- 禁模块顶层调 `ctx.events.emit/on`
- 组件不直接碰 IPC——出站 IO 收敛 `client/`（同一逻辑多处用 = 收敛一处的信号）

## 8 验证与参考

```bash
npm run typecheck   # tsc 全量
npm run lint        # eslint src/plugins/ 零 warning 门槛
npm run build       # electron-vite build
```

照着抄最快（按需求类型选参考）：

| 我要写… | 参考插件 |
|---|---|
| 右面板工具页 + 一键动作 | `project/notes`（含 client/ 出站封装 + dnd 排序 + 行内编辑） |
| 设置页（框架托管保存） | `manager/theme-manager` |
| 设置页（即时落盘 manual） | `project/notes` 的 NotesSettings |
| 侧栏列表 | `sessions/sessions-list` |
| 纯 JSON 主题 | `themes/theme-chatgpt` |
| 纯逻辑多的（core/ 三分） | `manager/pi-manager`、`sessions/session-tree` |
| 插件间事件发布 | `project/notes`（channels export + emit） |
| 订阅别的插件事件 | `sessions/timeline`（on + 可选插件 try/catch 兜底） |
