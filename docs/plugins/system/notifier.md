# notifier：后台会话完成时的系统通知

notifier 是一个零可见槽后台常驻的壳插件：订阅全量内核事件流，在 `agentSettled`（会话回合收敛）且主窗口不在前台时发一条操作系统级通知。它没有设置页组件（设置项走 settingsGroups 纯 JSON 声明），没有标题栏按钮，`Overlay` 组件 `return null`，只有一条 `useEffect` 订阅链。它的设计文档是 `docs/design/notifier-plugin.md`，本文是那份设计的独立技术展开，落到具体文件/函数/类型名。

## 职责边界

notifier 的职责是**一条判定链**：从"回合收敛"这个事件到"发系统通知"这个动作，中间四道闸（开关 → 焦点 → 冷却 → 弹出）。它不解析会话名、不维护会话清单、不做应用内横幅、不覆盖窗口关闭场景。

- **能力与策略分离**。"能发系统通知"和"能查窗口是否前台"是机制（壳内核能力，`ctx.notify.show` + `ctx.window.isFocused`）；"什么算完成""发什么文案""多久发一次不烦人"是策略（插件内容）。按 §1.2 机制内容分离，能力进壳、策略进插件。这是 notifier 成为插件的根本理由：触发条件和文案会变（明天可能"子 agent 完成""工具失败"也要通知），变了只改插件 manifest 和 renderer，壳一行不动。

- **内核无关**。`agentSettled` 是跨内核中性契约——pi 由 `agent_settled` 翻译、dsh 由 `turn/end` 翻译，两边产出同一事件，壳插件不感知 pi/dsh。`renderer/index.tsx` 第 6–7 行注释明确写"内核无关：agentSettled 是跨内核中性契约"，第 27–28 行过滤 `ev.event.type !== "agentSettled"` return。新增第三个内核只要把"回合收敛"翻译成 `agentSettled`，notifier 依旧无感。

## 目录结构

```
src/plugins/system/notifier/
  plugin.json          manifest：settingsGroups 槽 + languages 槽 + renderer
  renderer/
    index.tsx          Overlay（零可见常驻）+ 判定链
  locales/
    zh-CN/plugin.json  文案 key（settings.* + notify.*）
    zh-TW/ en/ de/     同构
```

没有 `core/`（判定链短到不需要拆纯函数，`numberOr` 一个局部函数就够），没有内核扩展。这是"纯订阅插件"的最小形态：一个 renderer + 一份声明 + 四份文案。

## plugin.json 逐字段

```json
{
  "id": "notifier",
  "version": "0.1.0",
  "tier": "official",
  "displayName": "系统通知",
  "description": "会话回合在后台完成时发一条系统通知（macOS / Windows / Linux）",
  "tags": ["productivity"],
  "renderer": "./renderer/index.tsx",
  "contributes": {
    "settingsGroups": [
      { "id": "notifier", "titleKey": "settings.groupNotifier", "order": 40,
        "fields": [
          { "key": "notifier.enabled", "type": "boolean", "default": true,
            "titleKey": "settings.notifierEnabled", "descKey": "settings.notifierEnabledDesc" },
          { "key": "notifier.cooldownSec", "type": "int", "default": 3,
            "titleKey": "settings.notifierCooldown", "descKey": "settings.notifierCooldownDesc",
            "options": [1, 3, 5, 10] }
        ] }
    ],
    "languages": [ ... ]
  }
}
```

- **`settingsGroups` 声明，零渲染代码**。两个字段 `notifier.enabled`（boolean，总开关）和 `notifier.cooldownSec`（int，冷却秒数，档位 1/3/5/10）走 settingsGroups 纯 JSON 声明，由 general-config 的通用渲染器渲成开关和下拉。值落 general.json（general-config 的 configFile），save/dirty/分层走既有框架管线。notifier 自己**不写任何设置页渲染代码**。

- **无 `settings` 槽**。它不需要自己的设置页——两个字段声明式就能表达，开设置页反而多余。这正是 plugin.md（general-config 的）§2.3 的边界应用：字段能用 boolean/int 表达就走 settingsGroups，不能才开 settings 槽。

- **`renderer` 是 Overlay 而非声明组件**。manifest 有 `renderer: "./renderer/index.tsx"`，但 `contributes` 里没有任何 `component` 字段。因为 `Overlay` 是框架固定 export 名，不在 manifest 声明——框架 `PluginOverlays` 宿主读 `module["Overlay"]` 自动匹配（`packages/react/src/plugin-modules.ts` 的 `getPluginOverlay`），与组件自动匹配同一规则。

## 判定链（renderer/index.tsx）

`Overlay` 组件（第 20 行）的 `useEffect`（第 25–52 行）返回 `ctx.sessions.onKernelEvent` 的退订函数，`maybeNotify` 是嵌套的 async 函数。整条链四道闸，前三个"拦住就不发"。

- **订阅全量流，不是视图流**。`ctx.sessions.onKernelEvent`（第 26 行）是**全量**内核事件流——转所有会话的事件，`KernelEvent` 联合里 `kind: "session"` 那支带 `sessionKey` 归属。视图流 `ctx.sessions.onEvent` 只转激活会话的事件、不给 sessionKey，后台会话的 `agentSettled` 不在视图流里。通知要盯全量流，否则"同时有第二个会话在后台跑"时视图流漏掉。设计文档 §2.2 详述了这条分工。

- **第一道闸：事件类型**。`if (ev.kind !== "session") return; if (ev.event.type !== "agentSettled") return;`（第 27–28 行）。`agentSettled` 的语义是"agent 收敛"——LLM 不再产生动作、工具不再执行，这一回合彻底结束。选它而不是 `messageEnd`（单条消息结束，一回合响多次会连弹）、`agentEnd`（与 agentSettled 同帧双发但语义略弱）、`turnEnd`（桌面端自产标记覆盖面不稳），设计文档 §2.3 有完整对比。

- **第二道闸：开关 + 焦点**。`const cfg = useUiStore.getState().generalConfig`（第 34 行）读最新配置态——**用 `getState()` 而非渲染闭包**，避免闭包旧值（这是"闭包旧值 bug"的根因修复，注释第 33 行点破）。`cfg["notifier.enabled"] === false` return。然后 `await ctx.window.isFocused()`（第 37 行）——`isFocused() === true`（窗口前台）return，用户正看着，通知是打扰。

- **第三道闸：冷却（节流不是去抖）**。`numberOr(cfg["notifier.cooldownSec"], 3) * 1000`（第 41 行）把档位转毫秒，`numberOr`（第 14–17 行）非数/非正回退默认 3。`now - lastNotifyAtRef.current < cooldownMs` return。**只在真正 `show()` 成功时更新 `lastNotifyAtRef`，判定被拦不更新**（第 44 行）——这是节流（固定窗口）不是去抖（重新计时），否则每次被拦都刷新时间戳会把冷却窗口无限拉长。冷却状态放 `useRef`（内存），进程重启清空无副作用。

- **第四道闸：弹出**。`await ctx.notify.show({ title: t("notify.title"), body: t("notify.body") })`（第 47 行），文案走 i18n。`catch` 里静默（第 48–50 行）——通知失败（环境不支持）不致命，注释点明"静默"是有意的不抛错，因为这是环境能力缺失不是用户操作失败。

- **冷却的意义**。多个会话几乎同时收敛、或一个会话被 steer/followUp 连续触发时，冷却窗口内只弹第一条、后续直接丢弃，防轰炸。默认 3 秒，用户可调 1/3/5/10。

## 壳侧的两个新能力

notifier 依赖的 `ctx.notify.show` 和 `ctx.window.isFocused` 是壳为它补的两个核心默认能力，两者都是机制、不进插件。

- **`HostNotify`（`packages/shared/src/domain/host.ts` 第 64–66 行）**。`show(opts: { title; body; silent? }): Promise<void>`。这是宿主能力接口的"系统通知"分支，与 `HostWindow`/`HostDialog`/`HostApp` 并列。实现分双宿主：Electron 宿主用 `new Notification({ title, body, silent })`（映射到 macOS 通知中心 / Windows toast / Linux libnotify），Node 服务器宿主 no-op（远程连接没有系统通知）。接口在圆心，实现在 `src/server/host/electron-host`/`node-host`（依赖倒置，§3.4）。

- **`HostWindow.isFocused`（`host.ts` 第 25 行）**。`isFocused(): Promise<boolean>`。服务器宿主全部 reject `UNSUPPORTED_HOST`（`host.ts` 第 19 行注释）。Electron 宿主用 `BrowserWindow.isFocused()`。"要不要通知"的判定就一条 `isFocused() === false` 才发，最小化天然为 false（`isFocused` 对最小化窗口返回 false），不需要再判 `isMinimized()`。

- **`PluginContext` 的暴露**（`packages/shared/src/domain/context.ts` 第 346–348 行）。`notify: { show }` 和 `window: { isFocused }` 是 PluginContext 的核心默认成员，注释写"核心默认,零权限"和"notifier 判定窗口是否前台用"。`usePluginContext` 的实现（`packages/react/src/plugin-context.ts` 第 200–201 行）把它们桥到 `window.kernel.notify.show` 和 `window.kernel.window.isFocused`。

- **为什么算核心默认能力而非声明权限**。权限模型的分界是"要不要读写用户数据、跑外部命令"：`fs`/`git`/`llm:oneshot` 要声明；`config`/`prefs`/`themes`/`notify`/`isFocused` 是壳自有能力，默认可用。发通知和查焦点只调壳自有的窗口/通知 API，不读不写用户数据。所以 notifier 的 `permissions` 为空。

## 系统通知的三端落点

notifier 的 `ctx.notify.show` 最终落到 Electron 的 `Notification` API，一个 API 内部映射到三端原生机制——macOS 走通知中心（UNUserNotificationCenter）、Windows 走 toast（WinRT ToastNotificationManager）、Linux 走 libnotify（D-Bus `org.freedesktop.Notifications`）。代码层**不分平台**，不写 `if (darwin/win32/linux)` 分支，让 `Notification.isSupported()` 如实报告当前环境支不支持，不支持就静默降级。差异不在代码分支，在三端各自的运行环境要求。

- **为什么必须走 main 进程 IPC，而不是 renderer 直接发**。插件的 renderer 是沙箱（`contextIsolation: true, nodeIntegration: false`），插件只 import `@my-harness-desktop/shared` 和 `@my-harness-desktop/react`，够不到 `electron` 模块；renderer 里那个 HTML5 `Notification` 是 Chromium 的壳，Electron 对它的原生 toast 支持不完整（尤其 Windows AUMID 和 Linux libnotify）。所以系统通知做成壳内核能力，经 `window.kernel.notify.show` IPC 交给 main 进程的 Electron `Notification`。通道名 `notification:show`、桥接方法 `window.kernel.notify.show`、插件上下文字段 `ctx.notify.show` 是同一能力在 IPC 通道层 / 桥接层 / 插件层的三个名字，本质一件（设计文档 §3.1.1）。

- **三端各自的运行环境要求**。macOS 要用户授权（系统设置 → 通知，首次 `show()` 弹授权），授权之外专注模式/勿扰会静默吞通知，应用无感知；未签名自分发（`mac.identity: null`）能弹但应用名可能显示成"Electron"、授权在重装/升级后容易失效，`icon` 参数在 macOS 被忽略（恒用 app bundle 的 icns）。Windows 的硬门槛是 AppUserModelId（AUMID），打包版由 electron-builder 按 `appId` 在 NSIS 安装时写好，dev 态必须手动 `app.setAppUserModelId(...)` 否则 toast 不显示或显示成"Electron"，便携 zip 包（无安装器）toast 能弹但不进操作中心历史。Linux 依赖系统有通知守护进程（GNOME/KDE 自带，i3/sway 要另装 dunst/mako），没有时 `Notification.isSupported()` 返回 false。

- **`isSupported` 的降级边界**。`Notification.isSupported()` 是降级开关：Linux 无守护进程时返回 false，handler 直接 return，不抛错、不留半截状态。但它只探测"守护进程在不在"，探测不到"勿扰/专注模式会不会吞"——守护进程在、勿扰开着时 `isSupported()` 仍为 true，通知照发但被静默吞，和 macOS 被拒授权同一类黑盒。这是所有"系统级勿扰"的共性：应用无法探测、也无法补。

- **点击通知聚焦窗口的三端差异**。main 进程的 `Notification` 上 `on("click", () => { win?.show(); win?.focus(); })`——点击通知把窗口 show + focus。macOS 和 Windows（AUMID 正确时）可靠；Linux 的 Wayland 合成器限制应用抢焦点，点击可能只唤起不聚焦，取决于桌面环境。这是已知边界，不是 bug。

- **启动期唯一的平台相关代码**。整个 notifier 链路里真正写进代码的平台相关动作只有一个，且是启动期一次性设置不是运行时分支：`bootstrap` 无条件调一次 `app.setAppUserModelId("works.earendil.my-harness-desktop")`——mac/linux 是 no-op，Windows 补齐 dev 态的 AUMID 门槛，与打包版对齐。其余三端差异都是运行环境要求，不是代码分支。

## 事件链的完整形态

从内核信号到系统通知的完整路径，跨了内核协议层、适配器、session-store、事件总线、PluginContext 五层，notifier 只站在最后一层消费。

- **内核侧**。pi 后端把 `agent_settled` 翻译成中性 `agentSettled`（`src/server/kernel/pi/protocol/event-translator.ts`），dsh 后端把 `turn/end` 翻译成它（`src/server/kernel/dsh/backend/dsh-event-translator.ts`）——dsh 的「turn」就是 pi 的「agent loop」，同指「一整轮执行收敛」。

- **session-store 侧**。`dispatch()` 把 `agentSettled` 的 busy 态翻成 false，并把后台会话的 `agentSettled` 列入全量流转发白名单（`isBackgroundEvent` 含 `agentSettled`）。全量流 `onKernelEvent` 转所有会话的事件。

- **renderer 侧**。notifier 的 Overlay 经 `ctx.sessions.onKernelEvent` 订阅，`usePluginContext` 把它桥到 `window.kernel.sessions.onKernelEvent`。

## 贡献的槽

- **`settingsGroups`**（`SettingsGroupContribution`）：`notifier` 组，两个字段。

- **`languages`**（`LanguageContribution`）：`notifier.plugin` 命名空间，key 前缀 `settings.*`（组名/字段名/说明）和 `notify.*`（通知文案）。

无 `settings`、无 `titlebar`、无 channel 声明、无内核扩展。它只订阅框架事件（`onKernelEvent`），不订阅任何插件的自定义 channel。

## 与其他插件交互

- **依赖 general-config 的 settingsGroups 渲染**。notifier 的两个字段由 general-config 的通用渲染器渲成 UI，值落 general.json。notifier 只读 `useUiStore.generalConfig`，不 import general-config。

- **依赖 i18n**。`t("notify.title")`/`t("notify.body")` 经 i18n 插件合并的语言字典。文案是通用的"会话已完成/助手已完成回答"，不解析会话名（`sessionKey` 是进程 key，映射到显示名要再查会话清单，属可选增强）。

- **依赖内核适配器的中性事件**。notifier 是"内核无关"的活样本：它只认 `agentSettled` 中性事件，pi/dsh 差异消在翻译层。这正是 §7.5 三条不变量里"壳只认中性事件"的插件侧体现。

- **无反向依赖**。没有插件依赖 notifier。它不 emit、不 invoke，删掉它只是"后台会话完成时不再弹通知"。

## 相关契约与类型落点

- `HostNotify`：`packages/shared/src/domain/host.ts:64`
- `HostWindow`：`packages/shared/src/domain/host.ts:20`
- `PluginContext.notify`/`window`：`packages/shared/src/domain/context.ts:346–348`
- `SettingsGroupContribution`/`SettingsFieldDecl`：`packages/shared/src/domain/contributions.ts:45/57`
- `agentSettled` 中性事件：`packages/shared/src/domain/events/`（session-state）
- 全量流 vs 视图流：`src/server/application/sessions/session-store.ts`（`dispatch`）

## QA

**Q：会话在后台完成了，但通知没弹，最可能是什么原因？**

A：四道闸里逐段排查。① `notifier.enabled` 被关了（general.json 里 false）；② 窗口其实是前台（`isFocused()` 为 true，比如用户切回来后焦点判断有延迟）；③ 冷却窗口内（距上次通知不足 `cooldownSec` 秒，被节流吞掉）；④ 系统级原因——macOS 拒了通知授权或开了勿扰、Windows 专注助手、Linux 没装通知守护进程，`Notification` 静默失败。前三个是插件逻辑，第四个是环境能力，`Notification.isSupported()` 只探测"守护进程在不在"，探测不到"勿扰会不会吞"。

**Q：Windows 上 `pnpm dev` 跑起来，为什么通知不显示？**

A：dev 态缺 AUMID。Windows toast 的硬门槛是 AppUserModelId，打包版由 electron-builder 按 `appId` 在 NSIS 安装时写好，dev 态要手动补 `app.setAppUserModelId(...)`。这是壳侧 `bootstrap` 的启动期一次性设置（mac/linux no-op，Windows 补齐 dev 态门槛），不是 notifier 的代码。详见设计文档 §3.1.2。

**Q：用户在前台看会话 A，后台会话 B 完成了，会发通知吗？**

A：不发。判定用的是"整个主窗口是否前台"（`isFocused()`），不是"这个会话是否可见"。窗口前台时任何会话完成都不打扰。这是有意的粗粒度——需求定的是"窗口后台才通知"。若未来要"窗口前台但提醒后台会话"，需要引入"当前激活会话 vs 事件会话"的对比，属演进。

**Q：为什么通知文案不带会话名？**

A：`sessionKey` 是 session-store 的 procs key（进程 key），不是会话显示名。映射到名字要再查会话清单（`sessionInfos`），且多内核/新会话的 key 形态不稳定。v1 用通用文案"会话已完成/助手已完成回答"，避免为了一个名字引入脆映射。带名是后续增强。

**Q：切换内核（pi ↔ dsh）会影响这个插件吗？**

A：不影响，前提是内核层履行"同一中性事件契约"。`agentSettled` 是中性契约里的"回合收敛"：pi 由 `agent_settled` 翻译、dsh 由 `turn/end` 翻译，两边产出同一事件。notifier 只消费中性契约，不感知 pi/dsh。新增第三个内核，只要它的后端把"回合收敛"翻译成 `agentSettled`，notifier 依旧无感。

**Q：为什么通知在窗口关闭后（macOS 红点关窗）就不发了？**

A：关窗销毁 renderer 进程，notifier 的 Overlay 订阅跟着没了，没人监听 `agentSettled`，判定链根本不会执行——尽管 main 进程和会话都还活着。这个边界只在 macOS（`window-all-closed` 不退出应用）出现。要覆盖它，触发逻辑得从 renderer 搬到 main 进程，是另一套设计，v1 不做。这是设计文档 §5 QA 里明确写清的边界。
