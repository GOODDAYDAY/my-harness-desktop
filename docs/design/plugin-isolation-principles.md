# 插件隔离设计原则

pi-desktop 的插件体系已经跑了 27 个插件，槽位契约、加载器、生命周期管理都就位了。但插件代码里有一类问题一直没动过：插件知道了自己的身份标识，知道了对端的内部结构，知道了自己不该碰的路径。这些问题不致命——系统能跑，功能正常——但它们是架构腐化的起点。每多一个插件照着现有模式写，这些隐式耦合就多长一分，长到某个点就再也清不动了。

这份文档定三条原则，把"插件该怎么写"的边界从约定上升为可检验的纪律。原则是通用的——任何插件化系统都适用；落地线索锚定 pi-desktop 的具体代码，让每条原则能对照到"现在哪里违规、改后该怎么写"。

## 0. 这份文档要解决的问题

### 0.1 硬编码的三种形态

硬编码不是"代码里有字符串"。字符串分两种：一种是契约——manifest 声明了 `"component": "GitReviewTab"`，代码里 `registerSidePanelComponent("GitReviewTab", Comp)` 和它对应，两处一致是契约的本质，不是硬编码。另一种是硬编码——插件代码里出现自己或别人的身份标识、手拼的路径、手写的 slot ID，没有任何机制保证它们和源头一致。

第一种硬编码是 **plugin ID 字面量**。15 个插件各自在代码顶部写了 `const PLUGIN_ID = "blind-review"`，然后 `usePluginContext(PLUGIN_ID)` 把它传进去。这个字符串和 manifest 里的 `"id": "blind-review"` 必须一致，但没有编译器检查——改了 manifest 的 id 忘了改代码里的常量，运行时才会炸。更隐蔽的是 plugin-manager 和 theme-manager 两处，它们连常量都省了，直接在调用处手拼：`api.config.get("plugin-manager", "customOrder")`、`pi.config.set("theme-manager", "showFontPreview", on)`。字符串字面量散落在业务逻辑里，改 manifest id 时 grep 不全就漏。

第二种硬编码是 **component 注册名**。插件在 `plugin.json` 里声明 `"component": "GitReviewTab"`，又在代码里写 `registerSidePanelComponent("GitReviewTab", Comp)`——两个 `"GitReviewTab"` 是手写两遍的，没有任何机制保证一致。现有 22 处 `registerXxxComponent` 调用，每一处都是这个模式。插件还得知道"我应该调 registerSidePanelComponent 还是 registerSettingsComponent"——这是框架的槽位分类，不该泄漏到插件代码里。

第三种硬编码是 **配置路径**。timeline 插件直接写 `window.pi.configFile.get("~/.pi-desktop/config/general.json")`——这个路径是 general-config 插件的配置文件，timeline 直读了别人的内部状态。路径硬写意味着路径变了 timeline 就断，而 timeline 和 general-config 之间没有任何依赖声明。

### 0.2 隐式耦合的两种形态

硬编码是"插件知道了自己不该知道的东西"，隐式耦合是"插件之间有了不该有的直接通道"。两者经常同时出现——硬编码 plugin ID 是隐式耦合的前提，有了 ID 才能拼出对端的通道。

第一种隐式耦合是 **共享 store 互读写**。timeline 插件在用户右键消息时调 `useUiStore().requestBookmark({...})` 往全局 store 里写一个请求对象，session-bookmarks 插件从 `useUiStore().bookmarkRequest` 读这个对象再处理。这不是事件，是两个插件通过共享状态变量做了一次隐式握手——timeline 知道"我写了 bookmarkRequest，有人会读"，session-bookmarks 知道"有人会写 bookmarkRequest，我读"。双方都没有声明依赖，没有 channel 契约，payload 的形状是两个插件各自手写的一份类型定义，改一边忘另一边就漂移。

第二种隐式耦合是 **直接 `window.pi.*` 绕过 Context**。6 个插件共 26 处直接调 `window.pi.configFile.get()`、`window.pi.sessions.copySession()`、`window.pi.fs.listDir()` 等，绕过了 `usePluginContext` 的 pluginId 绑定和权限封装。session-bookmarks 直接 `window.pi.sessions.copySession(expandHome(req.sessionPath), targetDir + "/session.jsonl")`——它没经 Context 绑定 pluginId，权限校验形同虚设（IPC 边界拿到的是裸调用，不知道调用方是谁）。这和 `usePiApi()` 返回原始 `window.pi` 是同一个口子——7 个插件用 `usePiApi()` 拿到未绑定的全局对象，手拼 pluginId 字符串。

### 0.3 为什么它们是问题

这些问题的共同特征是**没有编译期保护**。`const PLUGIN_ID = "blind-review"` 和 manifest 的 `"id": "blind-review"` 之间，没有任何东西保证一致。`registerSidePanelComponent("GitReviewTab", Comp)` 和 `"component": "GitReviewTab"` 之间也是。`window.pi.configFile.get("~/.pi-desktop/config/general.json")` 和 general-config 插件的实际配置路径之间还是。每一条都是"改一处忘一处"的定时炸弹，而且爆炸方式是运行时静默失败——组件找不到了、配置读不到了、权限校验过了不该过的调用——不是编译错误，是 bug。

更深层的问题是**依赖关系不可见**。timeline 直读 general-config 的配置文件，但 manifest 里没有 `dependsOn: ["general-config"]`。删掉 general-config 插件，timeline 不会报错"缺少依赖"，而是静默读到空对象然后行为异常。session-bookmarks 从 `useUiStore().bookmarkRequest` 读 timeline 写入的数据，但谁也不知道这个依赖关系——看 manifest 你以为它们互不相关，看代码它们在做隐式握手。依赖图断了，不是图错了，是有人绕过图走了暗道。

## 1. 三条原则总述

三条原则各自独立，但构成一个递进关系：零硬编码堵住插件知道自身标识的口子，事件唯一通道给出插件间通信的唯一合法方式，API 单入口把事件和能力收拢到同一个受控出口。

### 1.1 零硬编码

插件代码中不允许出现 plugin ID、slot contribution ID、component 注册名、配置文件路径的字符串字面量。它们要么由框架注入（pluginId 经 Context 自动传入，不传参），要么由框架从 manifest 自动关联（component 名从 manifest 读，插件只 export 组件，不调 register）。唯一的例外是事件 channel 名——channel 名是发布方拥有的契约（类比 API 签名），发布方在代码里写 channel 名是声明自己的对外契约，不是硬编码对端标识。

### 1.2 事件唯一通道

插件之间不通过共享 store 互读写、不通过 `window.pi` 直调对方能力。唯一合法的插件间通信是 `ctx.events.emit/on`。框架→插件、插件→框架的通信走 PluginContext API（config、sessions、fs 等），不在此限。共享 store 允许读（读框架管理的 UI 状态如 currentCwd），不允许调 store 的 setter——setter 只允许框架代码调用，插件要改变框架状态走 ctx API（详见 §3.6）。

### 1.3 API 单入口

插件代码不直接访问 `window.pi`，不通过 `usePiApi()` 拿原始全局对象。统一经 `usePluginContext()` 拿受控 API。`usePluginContext()` 返回的 Context 对象包含三层：pluginId 自动绑定层（config/fs/git/bash，调用时不用传 pluginId）、系统级 API 层（prefs/themes/kernel/models/sessions 等，框架透传）、事件层（events.emit/events.on）。三层都在同一个 Context 对象上，插件只从一个入口拿所有能力。

### 1.4 三者的关系

零硬编码是基础——如果 plugin ID 还是手写字面量，事件 channel 里就会混入硬编码的 ID 前缀，和原来的问题没有本质区别。事件是插件间唯一通信方式——如果还允许共享 store 互读写，事件总线就是摆设，插件会走更方便的暗道。API 单入口把事件和能力收拢——如果 `window.pi` 还能直访，`usePluginContext` 的 events 就不是唯一通道，插件会绕过 Context 直接调 `window.pi.onSettingsChanged` 而不订阅 `ctx.events.on("system:settingsChanged")`。三条原则是三条腿，缺一条另外两条就站不住。

## 2. 零硬编码

### 2.1 plugin ID：Context 自动注入

现在 15 个插件在代码里写了 `const PLUGIN_ID = "xxx"`，然后 `usePluginContext(PLUGIN_ID)` 把它传进去。plugin-manager 和 theme-manager 更直接——`api.config.get("plugin-manager", "customOrder")` 在调用处手拼。这些字符串和 manifest 的 `"id"` 字段必须一致，但没有任何机制保证。

改法是让 pluginId 从框架注入，插件代码完全不出现自己的 ID。`packages/react` 新增一个 `PluginIdContext`（React Context），shell 的四个槽壳组件（right-panel / sidebar / settings-page / main-view-host）在渲染插件组件时，用 `<PluginIdContext.Provider value={item.pluginId}>` 包裹。`item.pluginId` 来自 `slots:*()` IPC 返回值，shell 已有这个字段，不需要额外查询。

`usePluginContext()` 改为无参调用，内部从 `PluginIdContext` 读 pluginId 自动绑定。插件代码从 `const ctx = usePluginContext(PLUGIN_ID)` 变成 `const ctx = usePluginContext()`——删掉 `const PLUGIN_ID` 常量，删掉传参。plugin-manager 的 `api.config.get("plugin-manager", "customOrder")` 变成 `ctx.config.get("customOrder")`，theme-manager 的 `pi.config.set("theme-manager", "showFontPreview", on)` 变成 `ctx.config.set("showFontPreview", on)`——pluginId 绑定在 Context 里，调用方不传。

这样 pluginId 的唯一来源是框架，唯一消费点是 `usePluginContext()` 内部的绑定逻辑。改 manifest 的 id，框架注入的值自动跟着变，插件代码一行不改。

纯声明式插件（如 i18n 贡献 languages 槽、theme 贡献 themes 槽）如果不挂载 renderer 组件到槽壳，不经 PluginIdContext 注入。这类插件如果不需要调 pluginId 绑定的 API（config/fs/git）和事件，则不需要 pluginId——它们的贡献是纯数据（JSON 文件），框架在加载期直接从 manifest 读 languages/themes 声明，不经过 renderer。i18n 插件实际有一个 settings 槽的 renderer（语言设置页 UI），它会被 settings-page 槽壳渲染并经 PluginIdContext 注入，所以 i18n 能拿到 pluginId。如果某个纯数据插件将来需要 emit 事件，它必须有 renderer 组件（哪怕是个空组件挂在某个槽位），或者框架提供另一种注入路径——当前 pi-desktop 没有这个场景，先不展开。

### 2.2 component 注册名：框架从 manifest 自动关联

现在 22 处 `registerXxxComponent("Name", Comp)` 调用，每一处的 `"Name"` 都和 manifest 里 `contributes.*[].component` 字段手写一致。插件还得知道调哪个 register 函数——`registerSettingsComponent` 还是 `registerSidePanelComponent` 还是 `registerSidebarComponent` 还是 `registerMainViewComponent`——这是框架的槽位分类细节泄漏到了插件代码。

根因是"声明"和"注册"分成了两步：manifest 声明了 component 名，代码里再手动注册组件到对应槽位的注册表。应该合成一步——框架读 manifest 时已经知道这个插件贡献了哪些 component 名到哪些槽位，插件只需要 export 组件，框架自动匹配。

具体做法：每个插件的 `renderer/index.tsx` 改为 `export` 具名组件，不再调任何 register 函数。框架的 plugins-host 加载插件 renderer 后，读 manifest 的 contributes 字段，拿到 `{ slot: "sidePanel", component: "GitReviewTab" }` 这样的映射，在 renderer module 的 exports 里找名为 `GitReviewTab` 的组件，自动注册到对应槽位的注册表。插件代码从：

```tsx
function GitReviewTab(): React.ReactNode { ... }
registerSidePanelComponent("GitReviewTab", GitReviewTab);
```

变成：

```tsx
export function GitReviewTab(): React.ReactNode { ... }
```

component 名字符串只出现在 manifest 里（声明），框架读 manifest 做匹配（消费），插件代码里只有 export 的函数名（TypeScript 编译器保证名字和 manifest 一致——如果 manifest 写 `"component": "GitReviewTab"` 但 renderer export 的是 `GitReview`，加载时框架找不到 export，立即报错）。两层校验：编译期 TypeScript 保证 export 的名字存在，加载期框架保证 manifest 的 component 名和 export 匹配。

### 2.3 slot 可见性：框架传 props

blind-review、git-review、tool-manager 三个插件读 `useUiStore().activeSidePanelTabs`，然后用 `includes("blind-review")` 或 `includes("review")` 判断自己是否可见。这里有两层问题：插件硬编码了自己的 slot contribution ID（`"blind-review"` / `"review"`），以及插件自己判断可见性而不是由框架告知。

改法是 shell 渲染 sidePanel 组件时传 `isActive` prop。`right-panel.tsx` 渲染时已经知道 `activeTabs.includes(item.id)`——它本来就在做这个判断来决定是否渲染。把结果作为 prop 传下去：

```tsx
<PluginIdContext.Provider value={item.pluginId}>
  <Comp isActive={true} />
</PluginIdContext.Provider>
```

插件组件声明 `isActive` prop，不再查 store、不再 includes 字符串。框架决定渲染谁、谁就 `isActive={true}`，不渲染的组件根本不 mount——可见性从"插件查 store 自行判断"变成"框架通过 props 告知"，组件代码里零 slot ID。

### 2.4 配置路径：框架托管

timeline 插件直读 `~/.pi-desktop/config/general.json`——这是 general-config 插件的配置文件。timeline 和 general-config 之间没有 `dependsOn` 声明，没有事件通道，timeline 直接伸手进了别人的文件。路径硬写意味着 general-config 换了配置文件位置，timeline 就断。

这类问题的根因是"插件 A 需要消费插件 B 的配置状态"。正确做法是 B 把配置状态通过事件暴露出去，A 订阅。general-config 在配置变更时 `ctx.events.emit("general-config:changed", payload)`，timeline 声明 `dependsOn: ["general-config"]` 并 `ctx.events.on("general-config:changed", handler)`。payload 里的字段是 B 的对外契约——B 保证 payload 的形状稳定，A 按 payload 类型消费。路径不再出现在 A 的代码里，A 甚至不知道 B 的配置存在文件还是数据库里。

如果 payload 太大或 A 需要主动拉取（不是等事件推送），当前 pi-desktop 没有这个场景。未来的"插件→框架→插件"API 调用路径如果实现，会是 B 在 PluginContext 上暴露一个方法、A 经 ctx 调用、框架路由到 B——但这条路径当前不存在，也不在本文档的设计范围内。当前插件间通信只有事件一条路。

## 3. 事件唯一通道

### 3.1 什么算插件间通信

判断标准是"数据从插件 A 流到插件 B"。以下三种方式都算插件间通信：

- **共享 store 互读写**：timeline 写 `useUiStore().requestBookmark()`，session-bookmarks 读 `useUiStore().bookmarkRequest`。双方通过全局 store 做了一次隐式握手，没有依赖声明，没有 payload 契约。
- **直接 `window.pi` 绕过 Context**：插件不绑 pluginId 直接调 `window.pi.sessions.copySession()`，IPC 边界不知道调用方是谁，权限校验失效。
- **框架全局事件挂在 `window.pi` 上**：blind-review 订阅 `window.pi.onSettingsChanged(cb)`，这本来是框架系统事件，但挂在 `window.pi` 上意味着插件绕过 Context 访问事件。

不算插件间通信的：插件调 `ctx.config.get("key")` 读自己的配置（插件→框架），插件调 `ctx.sessions.start(cwd)` 起会话（插件→框架→底座），插件读 `useUiStore().currentCwd`（插件读框架管理的 UI 状态）。这些是插件和框架之间的通信，走 PluginContext API，不涉及插件之间。

### 3.2 事件总线：代码即声明

事件 channel 不进 manifest，但也不靠 emit 执行时才注册——那样订阅方在模块初始化时 on 一个还没被 emit 过的 channel 会报错，时序上不成立。解法是代码级 `export const channels` 声明：插件在 renderer 入口文件 export 一个 channels 数组，框架加载 module 后自动读取并注册。这和 §2.2 的 component export 自动匹配是同一个模式——声明在代码文件里，不在 manifest 配置里，框架读 module exports 时自动发现。

```tsx
// blind-review/renderer/index.tsx
export const channels = ["blind-review:reviewSent", "blind-review:reviewComplete"] as const;

export function BlindReviewTab(): React.ReactNode { ... }
```

框架加载流程：框架 `import()` 插件 renderer module（module 顶层代码执行），拿到 module namespace 对象后读 `module.channels`（如果有），注册所有声明的 channel。此时 module 顶层代码已经执行完毕，但下一个插件（依赖方）还没开始加载。所以发布方的 channel 在订阅方加载之前就已经注册——前提是 dependsOn 保证了发布方先加载。代码里 `ctx.events.emit("blind-review:reviewSent", payload)` 执行时，框架校验 channel 在自己的 `channels` export 里声明过——没声明就报错（emit 未声明的 channel）。emit 只通知已注册的 handler，不负责注册 channel——注册在 module 加载后就完成了。

插件禁止在模块顶层代码中调用 `ctx.events.emit` 或 `ctx.events.on`——所有事件调用必须放在 React 组件的生命周期里（useEffect、事件处理器）。这是因为 channel 注册发生在 module import 完成之后、下一个插件加载之前，但同一个 module 的顶层代码和 channel 注册没有先后保证。顶层代码放 emit/on 会有时序竞争。这条由 lint 规则强制（见 §5.1）。

为什么不进 manifest？因为事件是代码的行为产物，和组件 export 是同一类东西——组件名在 manifest 声明、组件实现在代码里 export，框架加载时匹配；channel 名在代码里 export 声明，框架加载时注册。manifest 只管 `dependsOn`（依赖关系）和槽位贡献（静态结构），事件从代码自动生长出来。`dependsOn` 是静态依赖关系——"B 依赖 A 存在才能工作"——这是加载时就能确定的，放 manifest 合理。

事件总线在 renderer 侧运行（`packages/react` 的 Context 实现），不跨进程。插件间的 emit/on 全部在 renderer 进程内完成，不涉及 Electron main 进程。框架系统事件（§3.5）如果触发源在 main 进程（如 settings.json 被写入），main 经 IPC 通知 renderer 侧的事件总线，由 renderer 侧的框架代码 emit——对插件来说，订阅方看到的始终是 renderer 侧的 `ctx.events.on`。

channel 名由发布方全权命名并保证稳定。`"blind-review:reviewSent"` 这个名字是 blind-review 插件的对外契约——就像 API 签名一样，改 channel 名是 breaking change，发布方要自行管理版本兼容。channel 名不强制加 pluginId 前缀，但推荐用 `{pluginId}:{eventName}` 格式避免冲突——这是约定，框架不解析 channel 名的语义，不从中提取 pluginId。lint 不强制拦截 channel 名格式——发布方自己保证命名规范。

### 3.3 dependsOn 与加载顺序

订阅方 `ctx.events.on("blind-review:reviewSent", handler)` 时，框架检查两件事：blind-review 插件是否已加载，以及 `"blind-review:reviewSent"` channel 是否已被注册。channel 注册发生在框架 import blind-review 的 renderer module 之后（module 顶层代码已执行完毕），读 `module.channels` 并注册。只要 dependsOn 保证了 blind-review 先加载，订阅方加载时 channel 就已就绪。如果 blind-review 还没加载或没注册这个 channel，on 直接报错——不会静默注册一个永远不会触发的 handler。

为了保证加载顺序，订阅方在 manifest 里声明 `dependsOn`：

```json
{
  "id": "some-subscriber",
  "dependsOn": ["blind-review"]
}
```

框架加载时做拓扑排序——blind-review 先于 some-subscriber 加载，保证 emit 方的 channel 在 on 方注册之前已经就绪。如果依赖图有环，加载阶段直接报错不启动。如果 `dependsOn` 声明的插件不存在或被禁用，订阅方不加载，报错告知"依赖的插件 blind-review 不可用"。

现有 27 个插件的 manifest 都没有 `dependsOn` 字段，因为现有插件之间没有显式依赖——所有"依赖"都走暗道（共享 store、直读文件）。改后这些暗道迁到事件，dependsOn 声明会自然出现。

### 3.4 加载与卸载的生命周期

加载流程：

1. 框架 discover 所有插件，读 manifest 构建依赖图。
2. 拓扑排序，按依赖顺序逐个加载。被依赖的插件先加载，依赖方后加载。
3. 框架 `import()` 插件的 renderer module（module 顶层代码执行），拿到 namespace 对象后读 `module.channels`（export const channels），注册所有声明的 channel，记录"pluginId 注册了 channel"。
4. 下一个插件（依赖方）加载，其 module 代码执行时，订阅方 `ctx.events.on("channel", handler)` 校验 channel 已在步骤 3 注册——没有就报错。

关键时序：channel 注册（步骤 3）发生在发布方 module import 完成之后、订阅方 module import 开始之前。所以发布方的 channel 在订阅方的 on 执行时一定已注册——前提是 dependsOn 保证了发布方先加载。emit 发生在组件生命周期中（useEffect、事件处理器），不发生在模块顶层——顶层 emit/on 被 lint 禁止（见 §5.1）。

卸载流程：

1. 用户禁用或卸载插件 A。框架检查有没有别的插件声明了 `dependsOn: ["A"]`——有就阻止卸载，报错告知"插件 B 依赖 A，需先禁用 B"。
2. 允许卸载时，框架自动注销 A 注册的所有 channel。此后任何插件对 A 的 channel 的 emit 调用都报错（channel 不存在）。
3. A 的组件卸载，`ctx.events.on` 返回的 cleanup 函数自动调用，订阅方 handler 被移除。如果订阅方组件还在 mount 状态但依赖的事件源消失了——这不应该发生，因为 dependsOn 保证依赖方先于被依赖方卸载（卸载顺序是加载顺序的逆序）。

热加载（enable 已禁用的插件）走和加载一样的流程：拓扑排序找到位置，插入加载，channel 自动注册，订阅方可以恢复订阅。

### 3.5 框架系统事件

框架本身也会 emit 事件，插件订阅这些事件不需要声明 dependsOn——依赖的是框架不是别的插件。框架系统事件用 `system:` 前缀和插件事件区分：

| channel | 触发时机 | payload |
|---|---|---|
| `system:cwdChanged` | 工作目录切换 | `{ cwd: string }` |
| `system:sessionChanged` | 当前会话切换 | `{ sessionPath: string \| null }` |
| `system:panelVisibilityChanged` | 右面板 Tab 显隐变化 | `{ tabId: string, visible: boolean }` |
| `system:settingsChanged` | settings.json 被外部写入 | `{ cwd: string }` |
| `system:pluginsChanged` | 插件加载/卸载 | `{ nonce: number }` |

现有 `window.pi.onSettingsChanged(cb)` 迁移为 `ctx.events.on("system:settingsChanged", cb)`。现有 `window.pi.plugins.onPluginsChanged(cb)` 迁移为 `ctx.events.on("system:pluginsChanged", cb)`。这些事件由框架在相应操作后 emit，插件只订阅不 emit——`system:` 前缀的 channel 框架保留 emit 权限，插件 emit `system:*` 会被框架拒绝。

### 3.6 共享 store 只读边界

`useUiStore` 和 `useSessionStore` 是框架管理的共享状态（zustand store，由 `packages/react` 持有）。插件可以读它们——读 `currentCwd`、`currentSessionPath`、`messages`、`streaming` 等框架状态是允许的，这些是框架向插件暴露的只读投影。

插件不可以调 store 的 setter——任何 setter（`setCurrentCwd`、`setRightPanelOpen`、`toggleSidePanelTab` 等）都只允许框架代码（shell 层的组件）调用，插件代码调 setter 应被 lint 规则拦截。`useUiStore().requestBookmark()` 就是被禁的例子——timeline 调了一个 setter 往 store 里写请求对象，session-bookmarks 读它，这是隐式事件。改后 timeline `ctx.events.emit("timeline:bookmarkRequested", payload)`，session-bookmarks `ctx.events.on("timeline:bookmarkRequested", handler)` 声明 `dependsOn: ["timeline"]`。

插件需要触发框架状态变更时（如 projects 插件切换工作目录），走 PluginContext API 而不是直接写 store。插件调 `ctx.sessions.setContext(cwd, sessionPath)`，框架在 main 进程处理完成后更新 renderer 侧的 store（`setCurrentCwd`），然后框架 emit `system:cwdChanged` 事件通知所有插件。整个流程是：插件调 ctx API → 框架处理 → 框架更新 store → 框架 emit 系统事件 → 插件收到通知。插件自始至终没有碰 store 的 setter。

判断标准：store 的字段是谁写的？框架写、插件读——合法。插件 A 写、插件 B 读——非法，改走事件。插件要改变框架状态——走 ctx API，不直接调 setter。

### 3.7 用例：现有交互如何迁移到事件

**用例 A：timeline → session-bookmarks（书签请求）**

现在：timeline 用户右键消息时调 `useUiStore().requestBookmark({ sessionPath, entryId, preview })`，往全局 store 写一个请求对象。session-bookmarks 从 `useUiStore().bookmarkRequest` 读这个对象，处理后调 `clearBookmarkRequest()` 清掉。

问题：timeline 和 session-bookmarks 没有依赖声明，payload 形状是两边各手写一份，`bookmarkRequest` 字段是两个插件共享的隐式契约。

改后：timeline `ctx.events.emit("timeline:bookmarkRequested", { sessionPath, entryId, preview })`。session-bookmarks manifest 声明 `dependsOn: ["timeline"]`，代码里 `ctx.events.on("timeline:bookmarkRequested", (payload) => { ... })`。payload 形状由 timeline 定义（它是发布方），session-bookmarks 按 timeline 的契约消费。`bookmarkRequest` 和 `clearBookmarkRequest` 从 `useUiStore` 删除。

**用例 B：blind-review 订阅配置变更**

现在：blind-review 调 `window.pi.onSettingsChanged(() => { if (currentCwd) void loadConfig(); })`。这是框架广播的事件，但挂在 `window.pi` 上，插件绕过 Context 直访。

改后：blind-review `ctx.events.on("system:settingsChanged", (payload) => { if (payload.cwd) void loadConfig(); })`。不需要声明 dependsOn——依赖的是框架系统事件。`window.pi.onSettingsChanged` 从 preload 删除，框架改为在 settings.json 被写入后 `ctx.events.emit("system:settingsChanged", { cwd })`。

**用例 C：timeline 读 general-config 的配置**

现在：timeline `window.pi.configFile.get("~/.pi-desktop/config/general.json")` 直读 general-config 的配置文件。路径硬写，没有依赖声明，general-config 不存在时 timeline 静默拿到空对象。

改后：general-config 在配置变更时 `ctx.events.emit("general-config:changed", { showHiddenMessages, defaultThinkingLevel, ... })`。timeline manifest 声明 `dependsOn: ["general-config"]`，代码里 `ctx.events.on("general-config:changed", (cfg) => { setGeneralConfig(cfg); })`。路径不再出现在 timeline 代码里，general-config 换存储方式不影响 timeline。timeline 初始加载时也需要拉一次当前配置——这可以走 `ctx.events.on` 的回放（框架在插件加载后 emit 一次最近的系统状态），或 general-config 暴露一个 `ctx.getConfig()` 式的 API（但当前没有插件间 API 调用的机制，见 §2.4 末尾的说明）。

**用例 D：session-bookmarks 调用会话能力**

现在：session-bookmarks 直接 `window.pi.sessions.copySession()`、`window.pi.sessions.setContext()`、`window.pi.sessions.start()`、`window.pi.sessions.fork()`——5 处直接 `window.pi.sessions.*` 调用，绕过 Context 绑定。

改后：session-bookmarks `const ctx = usePluginContext()`，然后 `ctx.sessions.copySession()`、`ctx.sessions.setContext()`、`ctx.sessions.start()`、`ctx.sessions.fork()`。这不是插件间通信——sessions 是框架→底座的能力，走 PluginContext API。迁移只是为了堵 `window.pi` 直访的口子（§4 的要求），和事件无关。同样 `window.pi.configFile.get/set`（书签的 meta.json 和 index.json 读写）也迁到 `ctx.configFile.get/set`，`window.pi.fs.listDir` 迁到 `ctx.fs.listDir`。

## 4. API 单入口

### 4.1 废除 `usePiApi()`

`usePiApi()` 返回原始 `window.pi` 全局对象——没有 pluginId 绑定，没有权限封装，调用方拿到的是一个可以调任何东西的裸对象。7 个插件在用：plugin-manager、theme-manager、timeline、skill-manager、pi-manager、extension-manager、tool-manager。

根因是 PluginContext 缺系统级 API。插件需要调 `themes.list()`、`kernel.status()`、`plugins.list()`、`models.get()`、`prefs.get()` 这些系统级能力，但 PluginContext 只定义了 config/sessions/messaging/models/tree/maintenance/queue/i18n/fs/git/dialog/bash——系统级的管理 API 没放进来。插件只能走 `usePiApi()` 拿原始 `window.pi` 手拼，或者直接 `window.pi.*`。

解法不是把 `window.pi` 的所有方法搬进 PluginContext——那只是换了个名字的 `window.pi`。解法是分清"pluginId 绑定的"和"系统级的"两层，都收进 `usePluginContext()` 返回的同一个对象上。

### 4.2 PluginContext 完整形态

`usePluginContext()` 返回的对象分三层：

**pluginId 绑定层**——调用时不用传 pluginId，从 Context 自动读：

- `ctx.config.get(key)` / `ctx.config.set(key, value)` / `ctx.config.all()`：插件自己的配置读写
- `ctx.fs.listDir(cwd)` / `ctx.fs.removePath(path)`：文件系统访问（需声明 `fs:project` 权限）
- `ctx.git.status(cwd)` / `ctx.git.fileDiff(cwd, path)` / `ctx.git.fileContent(cwd, path)`：Git 只读（需声明 `git:read` 权限）
- `ctx.bash?.runBash(command)` / `ctx.bash?.abortBash()`：Bash 执行（需声明 `rpc:bash` 权限）

**系统级 API 层**——不绑 pluginId，框架透传，所有插件可用：

- `ctx.prefs.get(key)` / `ctx.prefs.set(key, value)`：桌面偏好（主题、字号等）
- `ctx.themes.list()` / `ctx.themes.build(themeId, fontScale, fontMono, fontSans)`：主题列表和合并
- `ctx.kernel.status()` / `ctx.kernel.listVersions()` / `ctx.kernel.install(version, onProgress, onDone)`：pi 内核管理
- `ctx.models.get()` / `ctx.models.set(config)`：模型配置读写（`~/.pi/agent/models.json`）
- `ctx.piSettings.get()` / `ctx.piSettings.set(patch)` / `ctx.piSettings.schema()`：pi 底座 settings（`~/.pi/agent/settings.json`）
- `ctx.configFile.get(path)` / `ctx.configFile.set(path, data, mergeMode)` / `ctx.configFile.getLayered(cwd, relPath)` / `ctx.configFile.setProject(cwd, relPath, data, mode)` / `ctx.configFile.clearProject(cwd, relPath)`：通用 JSON 配置读写
- `ctx.sessions.*`：会话全生命周期（start/stop/prompt/abort/fork/clone/compact/exportHtml/copySession 等）
- `ctx.messaging.*`：消息发送（prompt/steer/followUp/abortRetry）
- `ctx.i18n.t(key, vars?)` / `ctx.i18n.locale`：翻译和当前语言
- `ctx.dialog.openDirectory()` / `ctx.dialog.openImages()` / `ctx.dialog.openFile(path)`：对话框
- `ctx.plugins.list()` / `ctx.plugins.enable(id)` / `ctx.plugins.disable(id)` / `ctx.plugins.uninstall(id)` / `ctx.plugins.reload(id)` / `ctx.plugins.install(source)` / `ctx.plugins.onUnloaded(cb)` / `ctx.plugins.onPluginsChanged(cb)`：插件管理
- `ctx.extension.*`：pi 底座 extension 管理
- `ctx.skills.*`：技能管理
- `ctx.restart.*`：重启协调
- `ctx.openFile(path)`：用系统默认编辑器打开文件

**事件层**——插件间通信唯一通道：

- `ctx.events.emit(channel, payload?)`：发布事件，channel 自动关联当前 pluginId
- `ctx.events.on(channel, handler)`：订阅事件，返回 cleanup 函数

### 4.3 禁止 `window.pi.*` 直访

现有 6 个插件共 26 处直接 `window.pi.*` 调用，全部迁到 `ctx.*`：

| 现有调用 | 迁移去向 | 涉及插件 |
|---|---|---|
| `window.pi.configFile.get/set` (12 处) | `ctx.configFile.get/set` | session-bookmarks |
| `window.pi.sessions.copySession/setContext/start/fork` (5 处) | `ctx.sessions.*` | session-bookmarks |
| `window.pi.fs.listDir/removePath` (2 处) | `ctx.fs.listDir/removePath` | session-bookmarks |
| `window.pi.config.get/set/all` (4 处) | `ctx.config.get/set/all` | session-colors |
| `window.pi.configFile.get` (1 处) | `ctx.configFile.get` | timeline |
| `window.pi.openFile` (1 处) | `ctx.dialog.openFile` | timeline (tool-cards) |
| `window.pi.onSettingsChanged` (1 处) | `ctx.events.on("system:settingsChanged")` | blind-review |
| `window.pi.i18n.list` (1 处) | `ctx.i18n` 扩展或保留框架初始化 | i18n 插件 |

i18n 插件那 1 处 `window.pi.i18n.list()` 是在 i18n 插件的 renderer 里调的——i18n 插件是语言槽插件，它的 renderer 负责语言设置页 UI，需要拉语言列表。这个调用迁到 `ctx.i18n` 上对应的方法（PluginContext 的 i18n 层需要补一个 `list()` 方法），或者框架在初始化时把语言列表注入 store，i18n 插件从 store 读。

lint 规则 `no-restricted-syntax` 配置：

```javascript
{
  "selector": "MemberExpression[object.name='window'][property.name='pi']",
  "message": "禁止直接访问 window.pi，使用 usePluginContext() 拿受控 API"
}
```

这条规则唯一允许的例外是 `packages/react/src/plugin-context.ts`（它内部需要调 `window.pi` 实现 Context）和 `src/shell/` 目录（shell 层可以直接用 `window.pi`，它本身就是框架代码）。插件目录 `src/plugins/` 下零容忍。

### 4.4 usePiApi 的删除

`usePiApi()` 从 `packages/react/src/index.ts` 删除。7 个使用 `usePiApi()` 的插件改为 `usePluginContext()`：

- plugin-manager：`const api = usePiApi()` → `const ctx = usePluginContext()`，`api.plugins.list()` → `ctx.plugins.list()`，`api.config.get("plugin-manager", "customOrder")` → `ctx.config.get("customOrder")`
- theme-manager：`const pi = usePiApi()` → `const ctx = usePluginContext()`，`pi.themes.list()` → `ctx.themes.list()`，`pi.config.set("theme-manager", ...)` → `ctx.config.set(...)`
- timeline：`const pi = usePiApi()` → `const ctx = usePluginContext()`，`pi.sessions.*` → `ctx.sessions.*`，`pi.models.get()` → `ctx.models.get()`
- skill-manager、pi-manager、extension-manager、tool-manager：同模式替换

## 5. 三层校验

原则定了不等于执行了——没有校验的纪律等于没有纪律。三层校验从编译期到运行期层层拦截，每层抓不同类别的违规。

### 5.1 编译期（lint）

lint 在开发阶段拦截，违规连 build 都过不了：

- **拦截 `window.pi` 直访**：`no-restricted-syntax` 规则，selector 匹配 `window.pi` 的 MemberExpression，在 `src/plugins/` 目录下报错。例外白名单：`packages/react/src/plugin-context.ts` 和 `src/shell/`。
- **拦截 `const PLUGIN_ID =` 模式**：`no-restricted-syntax` 规则，selector 匹配 `VariableDeclarator[id.name='PLUGIN_ID']`。pluginId 应从 Context 注入，不应手写常量。
- **拦截 `usePiApi` 调用**：`no-restricted-syntax` 规则，selector 匹配 `CallExpression[callee.name='usePiApi']`。所有插件改用 `usePluginContext()`。
- **拦截 `registerXxxComponent` 调用**：`no-restricted-syntax` 规则，selector 匹配 `CallExpression[callee.name=/^register.*Component$/]`。组件注册由框架从 manifest 自动关联，插件只 export 组件。
- **拦截顶层 `ctx.events.emit/on`**：插件模块顶层代码不得调用 `ctx.events.emit` 或 `ctx.events.on`——所有事件调用必须放在 React 组件的生命周期里（useEffect、事件处理器）。lint 规则匹配 module 顶层作用域的 `ctx.events.emit/on` 调用。

### 5.2 加载期（manifest 校验）

框架加载插件时做以下校验，违规则拒绝加载并报错：

- **dependsOn 拓扑校验**：声明的依赖必须存在且已激活。依赖不存在 → 报错"插件 A 依赖的 B 不存在"。依赖存在但被禁用 → 报错"插件 A 依赖的 B 未激活，需先启用 B"。依赖图有环 → 报错"依赖循环"。
- **component 名与 export 自动匹配**：框架读 manifest 的 `contributes.*[].component`，在 renderer module 的 exports 里找同名组件。匹配是大小写敏感的字符串查找（JavaScript 对象属性查找 `module[componentName]`）。找不到 → 报错"插件 A 声明了 component 'GitReviewTab' 但 renderer 未 export 该组件"。多槽位插件（如 tool-manager 同时贡献 settings 和 sidePanel）在 manifest 的不同槽位各自声明 component 名，框架对每条 contributes 条目逐一做 `{ slot, component }` 配对查找。
- **channels export 自动读取**：框架读 renderer module 的 `channels` export，在 module 代码执行前注册所有声明的 channel。如果插件代码里 emit 了一个不在 `channels` export 里的 channel 名，运行期报错（见 §5.3）。

### 5.3 运行期（emit/on 校验）

运行时拦截违规调用，报错或拒绝执行：

- **emit 校验**：插件 `ctx.events.emit("channel", payload)` 时，框架校验 channel 在当前插件的 `channels` export 里声明过。如果 channel 名以 `system:` 开头但调用方不是框架 → 拒绝执行，报错"插件 A 无权 emit 系统事件"。
- **on 校验**：插件 `ctx.events.on("channel", handler)` 时，框架校验 channel 来自某个已加载插件的 `channels` export 或 `system:*` 框架事件。未注册 → 报错"channel 'xxx' 未被任何已加载插件注册"。on 校验在代码执行时（运行期）进行，不是 manifest 解析时（加载期）——因为 channel 是从 `channels` export 动态发现的，只有 module 加载后才知道有哪些。
- **卸载时自动注销**：插件被禁用或卸载时，框架自动注销该插件注册的所有 channel，并清除该 channel 的 replayLast 缓存（replayLast 机制见 QA"timeline 错过初始 emit"一条）。此后任何对该 channel 的 emit 调用报错"channel 'xxx' 已注销"。on 返回的 cleanup 函数自动调用，订阅方 handler 被移除。
- **反向依赖检查**：卸载插件 A 时，框架检查有没有别的插件声明了 `dependsOn: ["A"]`。有 → 阻止卸载，报错"插件 B 依赖 A，需先禁用 B"。这是加载期拓扑校验的逆序——加载时保证依赖先于依赖方加载，卸载时保证依赖方先于被依赖方卸载。

## 6. QA

**Q：插件 A 订阅了插件 B 的事件，运行中 B 被用户禁用了，A 的订阅怎么处理？**

框架在卸载 B 之前做反向依赖检查——发现 A 声明了 `dependsOn: ["B"]`，阻止卸载并报错"插件 A 依赖 B，需先禁用 A"。用户必须先禁用 A 再禁用 B。这是有意的：dependsOn 声明的依赖是强约束，不允许"我还在用你你就被拆了"的情况。如果用户确实要禁用 B 而保留 A，A 的事件 handler 会因为 channel 注销而报错——这是正确行为，说明 A 离了 B 跑不了。

**Q：两个插件互相 emit 对方的 channel 怎么办？比如 A emit "b:event"，B emit "a:event"。**

不会。`ctx.events.emit("channel", payload)` 执行时，框架校验 channel 在当前插件自己的 `channels` export 里声明过。插件 A emit `"b:event"` 时，框架检查 `"b:event"` 是否在 A 的 `channels` export 里——如果 A 没声明这个 channel，报错"emit 未声明的 channel"。框架不解析 channel 名的前缀语义，不从中提取 pluginId——但 emit 必须在自己的 `channels` export 里有声明，A 不能 emit 声明为 B 的 channel。channel 名用 `{pluginId}:{eventName}` 格式是发布方的命名约定，框架不强制，但 `channels` export 的声明本身就限制了"只有声明过的 channel 才能 emit"。

**Q：插件 A emit 了一个事件，当前没有任何插件订阅它，会怎样？**

什么也不发生。emit 是 fire-and-forget，框架不保证有订阅者。但框架会缓存这次 emit 的 payload 供 replayLast 使用（见下一条 QA）。事件是单向通知，不是请求-响应。

**Q：事件 payload 的类型怎么保证？发布方改了 payload 结构，订阅方怎么知道？**

框架不做 payload 类型校验——channel 名是契约，payload 是契约的内容。类型安全靠 TypeScript：发布方在代码里定义 payload 类型并 export，订阅方 import 发布方的类型。这要求发布方和订阅方在同一个 TypeScript 项目里（或者发布方发布了 @types 包）。第三方插件之间的类型安全是一个已知缺口——当前 pi-desktop 的内置插件都在同一个 monorepo 里，类型共享不是问题；第三方插件跨仓库的场景留待后续解决。

**Q：框架系统事件的 payload 可以变吗？比如 `system:cwdChanged` 加一个字段？**

可以加字段但不能删字段或改语义——这是向后兼容的常规约束。加字段是安全变更，旧订阅方忽略新字段不受影响。删字段或改字段语义是 breaking change，需要大版本号升级。框架系统事件的 payload 类型在 `packages/core`（domain 层的 re-export发布面）里定义并 export，所有插件从 `@pi-desktop/core` import 类型。

**Q：插件组件注册名从 manifest 自动关联（§2.2），那第三方插件的组件怎么 export？内置插件编译进 bundle，第三方插件是独立 js 文件。**

第三方插件经 `import(file://path)` 加载，加载后 framework 拿到 module 的 exports。内置插件经 `import.meta.glob` 加载，同样拿到 module 的 exports。两条路径在"拿 module exports"这步是统一的——框架读 `module[componentName]`，有就注册，没有就报错。第三方插件的 renderer js 文件必须 export 和 manifest `component` 字段同名的组件，和内置插件的约束完全一致。

**Q：timeline 读 general-config 的配置（用例 C），如果 general-config 还没加载完就 emit 了事件，timeline 错过了怎么办？**

加载顺序由 dependsOn 拓扑排序保证——timeline 声明了 `dependsOn: ["general-config"]`，general-config 先于 timeline 加载。general-config 在 renderer 执行时 emit 初始配置事件，此时 timeline 还没加载——事件发出去了但没人订阅。timeline 加载后才 `ctx.events.on`，错过了初始 emit。

解法是框架提供事件回放：插件 `ctx.events.on("channel", handler, { replayLast: true })` 时，框架检查该 channel 是否有最近一次 emit 的缓存——有就立即调 handler 传给它。框架为每个 channel 在 renderer 侧（`packages/react` 的事件总线实现）缓存最近一次 emit 的 payload。新订阅者可以选择回放。`system:*` 事件天然需要这个——`system:cwdChanged` 在插件加载前可能已经触发过了，新加载的插件需要知道当前 cwd。回放只缓存最近一次，不是事件历史。

replayLast 的边界行为：如果 channel 从未被 emit 过，`{ replayLast: true }` 不会调 handler，handler 只作为普通订阅者注册——等第一次 emit 时才触发。插件卸载时，该插件注册的所有 channel 的 replay 缓存随 channel 一起清除。

**Q：插件代码里 `useTranslation()` 是 react-i18next 的 hook，和 `ctx.i18n.t()` 是什么关系？**

`usePluginContext()` 内部调 `useTranslation()` 拿 i18next 的 `t` 函数和 `i18n.language`，包成 `ctx.i18n.t(key, vars)` 和 `ctx.i18n.locale`。插件代码里可以直接用 `useTranslation()`（react-i18next 是框架依赖，不是插件间通信），但推荐统一用 `ctx.i18n.t()` 保持 API 单入口。两者背后是同一个 i18next 实例，行为完全一致。

**Q：`ctx.events.emit` 里的 channel 名是字符串字面量，这算不算硬编码？**

不算。channel 名是发布方的对外契约——就像 `export function GitReviewTab()` 里的函数名是契约一样。发布方在代码里写自己的 channel 名，是在声明"我对外提供这个事件"，不是在引用别人的标识。这和 `const PLUGIN_ID = "blind-review"`（引用自己的 manifest id）不同——manifest id 的源头是 manifest 文件，代码里写一遍是复制；channel 名的源头就是代码本身，代码是唯一源。当然，如果 channel 名里包含别的插件的 id（比如 `ctx.events.on("blind-review:reviewSent")` 里订阅方写了 `"blind-review"`），那确实是引用别人的标识——但这正是 dependsOn 声明的依赖关系，是必要耦合，不是硬编码。
