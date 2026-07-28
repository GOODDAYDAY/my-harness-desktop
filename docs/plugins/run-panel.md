# run-panel

## 1 这个插件解决什么问题

用户需要一个地方看"AI 正在执行什么任务"——跑了什么命令、执行了多久、成功还是失败。当前这个功能还没有实数据——run-panel 是一个占位符，声明了槽位但只显示空态。它的存在保证侧面板的"Run"页签在用户看到时不是缺一块，而是有明确的"待接入"提示。

## 2 设计决策

### 2.1 为什么是插件而不是内核

运行任务追踪的渲染一定会变——任务列表格式、执行时间展示、失败状态标识都会调。这是功能内容，推给插件。内核只提供"能订阅底座事件"的能力（`sessions.onEvent`），怎么把事件聚合成"任务列表"是插件的事。

### 2.2 选了什么机制

贡献 `sidePanel` 槽位，`order: 20`。零权限、零 configFile。17 行代码——一个 `EmptyState` 组件就完成了整个渲染。

### 2.3 和框架的分工

框架管：组件注册、`EmptyState` 空态组件。插件管：什么都不管——当前没有逻辑。后续接入时，在这里扩展事件订阅和数据渲染。

### 2.4 是否修改了内核

没有。run-panel 只从 `@pi-desktop/react` 导入 `EmptyState` 和 `registerSidePanelComponent`。只有 17 行代码，零逻辑。不 import `domain/`、`gateway/`、`application/`、`shell/` 的任何文件。删掉这个插件，内核完全不受影响——侧面板少了一个"Run"页签，但加载器、槽位契约、事件总线全部照常运行。run-panel 是"无特权差异"纪律的最极简示范：它和第三方插件走同一个加载器，内核没有任何识别它为内置插件并特殊对待的代码。
### 2.5 使用了内核的什么功能

- **`registerSidePanelComponent`**（框架注册函数）：将 `RunPanelTab` 注册到侧面板组件注册表。这是内核的插件加载器提供的注册原语——插件在 renderer 入口顶层调用它，内核在渲染侧面板时查注册表找到组件并挂载。
- **`EmptyState`**（框架共享组件）：提供图标 + 标题 + 描述的空态布局。内核不关心空态里写的是什么文案——文案由 i18n 插件通过 `t("system.noRunningTask")` 注入。

当前 run-panel 是功能真空——不调 `usePluginContext`、不订阅事件、不读写配置。后续接入真数据时，预计使用 `ctx.sessions.onEvent`（核心默认能力）订阅底座的 `messageStart` / `toolCallStart` / `toolCallEnd` 等事件。
## 3 怎么通信

### 3.1 和内核通信

当前不通信。后续接入时预计走 `ctx.sessions.onEvent` 订阅底座的 `tool_execution_start` / `tool_execution_update` / `tool_execution_end` 事件（经 gateway 的 event-translator 翻译成中性事件 `toolCallStart` / `toolCallUpdate` / `toolCallEnd`）——和 token-stats 一样的模式：零权限，核心默认能力。

### 3.2 和其他插件通信

当前不和其他插件通信。后续接入时和其他 sidePanel 插件一样，通过 `useUiStore` 共享全局状态。

### 3.3 其他插件怎么使用自己

run-panel 当前不产生任何输出，不写任何共享状态，因此没有其他插件依赖它。它是侧面板上的一个独立页签，和同面板的其他插件并置但互不影响。projects 切换目录不影响 run-panel（它不读 `currentCwd`），会话变化也不影响它（它不读 `useSessionStore`）。它唯一的作用是占据 `sidePanel` 槽位的一个页签位置，确保 Run 页签在 UI 中存在。
## 4 怎么处理

不处理。显示"暂无运行任务"空态。

## 5 怎么保证

唯一保证的是页签存在——用户切到 Run 页签不会看到白屏，而是有图标 + 标题 + 描述的空态。这是"无特权差异"的落地——内置插件和第三方插件走同一套加载器，删掉这个插件 core 照常启动，只是少了 Run 页签。

## 6 如果没有这个插件，整个系统会有什么影响

内核不崩溃。侧面板失去"Run"页签——用户切到侧面板时少了一个 tab，其他页签（Review、Context、Tree、统计）仍然正常工作。功能上零损失——run-panel 本身就是空占位，当前不提供任何真实功能。但对用户体验有影响：用户看不到"Run"页签，不知道这里将来会有任务追踪功能，也不清楚当前是否已有任务在运行。第三方插件完全可以替代：只需贡献同一个 `sidePanel` 槽位、订阅 `ctx.sessions.onEvent` 事件流、自己实现任务列表的渲染和状态管理。run-panel 被替代后，无论新插件功能多强，内核一行不动。

## 7 QA

**Q：为什么保留一个空插件？**

因为槽位需要被声明才能渲染页签。如果不放 run-panel，侧面板就没有 Run 页签——用户看到的是缺一块。放了 run-panel，用户看到的是"待接入"提示，知道这里将来会有东西。这是 UX 决策，不是技术决策。

**Q：什么时候接入真数据？**

等底座的 `tool_execution_start` / `tool_execution_end` 事件流稳定后。当前底座推这些事件但字段形状未文档化——和 token-stats 的 `extractUsage` 一样，需要防御性提取。等字段确认后接入。
