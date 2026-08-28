# remote-access 插件技术文档

## 1 定位与分层

- remote-access 是 my-harness-desktop 的**远程访问设置页壳插件**，物理位置 `src/plugins/system/remote-access/`，由 `plugin.json` + `renderer/index.tsx` + `locales/`（4 locale × 2 文件）组成，是壳插件（UI 插件）而非内核插件。
  - `plugin.json` 顶层声明 `id: "remote-access"`、`version: "0.5.0"`、`tier: "official"`，没有 `protected`（可禁用可卸载）、没有 `permissions`、没有 `configFile`、没有 `dependsOn`、没有 `piExtension`/`dshExtension`——它是纯 UI 插件，零内核扩展，零声明能力。
  - 它贡献两个槽位：`settings`（1 项，设置页入口）与 `languages`（8 项，4 locale × 2 文件），见 §2 与 §3。
  - 它的角色是**远程访问控制面的 UI 操作端**：开关、密码管理、二维码展示、设备踢出。它不拥有会话/工具/模型能力，也不实现任何安全机制——安全机制全在壳后端（`src/server/remote/` + `src/server/transport/` + `src/server/controllers/remote.ts`），本插件只消费这些机制暴露出来的 invoke/push 通道。

- 从洋葱分层看，本插件站在最外层"内容层"，圆心与壳只提供机制。
  - 圆心 `packages/shared/src/domain/remote.ts` 定义了线协议类型（`InvokeRequest`/`ResultResponse`/`PushMessage`/`HelloRequest`/`HelloResponse`/`Conn`/`ConnectionInfo`/`RemoteStatus` 等），是**纯类型零依赖**的发布面，本插件并不直接 import 它（插件只 import `@my-harness-desktop/react` 与 `react-i18next`），但它的运行时数据形态与这些类型一一对应。
  - 壳后端 `src/server/remote/` 是远程鉴权机制（`auth.ts`/`token.ts`/`password.ts`/`rate-limiter.ts`/`net.ts`/`remote-config.ts`），`src/server/transport/` 是 HTTP+WS 传输机制（`http/http-server.ts` + `ws/ws-server.ts`），`src/server/controllers/remote.ts` 是 `remote:*` 通道的 handler 注册面——三者合起来是"远程访问"这一功能的机制骨架，本插件一行不碰。
  - 壳前端 `src/web/kernel/build-kernel.ts` L641-663 把 `remote:*` 通道封装成 `window.kernel.remote` API，本插件经它调用后端。

- 一个关键事实要钉死：**本插件不走 `usePluginContext()`，而是直接调 `window.kernel.remote.*`**。
  - `PluginContext`（`packages/react/src/plugin-context.ts`）只暴露 `config/prefs/themes/settings/sessions/i18n/models/kernel/notification/events` 等系统级 API 层，`remote` 不在其中（grep `plugin-context.ts` 与 `packages/shared/src/domain/context.ts` 均无 `remote` 字段）。
  - `window.kernel.remote` 是 `buildKernel` 直接把 `IPC.remote.*` 通道包成方法后挂在 `window.kernel` 上的控制面（`build-kernel.ts` L641-663），当前全仓**唯一消费者**就是本插件的 `renderer/index.tsx`（grep `onStateChanged`/`onConnectionsChanged` 仅命中本插件与 `build-kernel.ts`）。
  - 因此本插件是一个"直连系统控制面"的内置壳插件，而不是"经 PluginContext 受控访问"的插件——它是 `remote` 控制面目前唯一的前端入口，`remote` API 尚未被泛化进 PluginContext 供第三方插件消费。

## 2 settings 槽契约与 renderer 全量

### 2.1 贡献声明与字段语义

- `plugin.json` 的 `contributes.settings` 只有一项：`{ id: "remote-access", title: "远程访问", icon: "radio-tower", component: "RemoteAccessPage", order: 100 }`。
  - `SettingsContribution` 定义在 `packages/shared/src/domain/contributions.ts` L9-39。本项未声明 `configFile`（默认 `null` = 无配置文件、设置页不显示"打开配置"按钮）、未声明 `saveMode`（默认 `"framework"`）、未声明 `configMerge`/`kernelModels`/`kernelConfig`/`tabs`。
  - 一个容易被误读的点：**默认 `saveMode: "framework"` 在这里实际不起作用**——框架的 save/dirty/拦截管线围绕 `configFile` 展开（§9.1 纪律），本项没有 `configFile`，就没有 dirty 状态、没有保存浮层。本插件的"配置"（远程开关、密码）根本不落插件配置管线，而是经 `remote:start/stop/setPassword` 这些 invoke 通道写进服务端 `remote.json`（`RemoteConfigStore`），框架 save 机制全程旁观。
  - `order: 100` 是 `SettingsContribution.order` 的缺省值，本插件显式写出，与其他 100 级设置页并列；对比 i18n 插件用 `order: 999` 置底、pi 管理页 order 0 置顶（contributions.ts L33 注释写明"Pi 永远第一(0),语言置底(999)"）。
  - `component: "RemoteAccessPage"` 由框架按名自动匹配：`registerPluginComponents` 读 `contributes.settings[].component`，在 renderer module 的 exports 里找同名导出 `RemoteAccessPage` 注册，插件不手写 register（§7.4 纪律）。

### 2.2 renderer/index.tsx 结构

- 文件头注释（L1-8）把设计意图钉死：纯内容层壳插件、开关/密码/二维码、不碰网关实现、文案经 i18n、公网隧道已移除（先只做本机与局域网）。
  - import 面只有三处（L9-11）：`react`（`useCallback/useEffect/useRef/useState/CSSProperties`）、`react-i18next`（`useTranslation`）、`@my-harness-desktop/react`（`Button`、`SettingsSection`）。零对 `src/server`/`src/web`/`packages/shared` 内部文件的直接引用，守壳插件依赖边界。
  - 文件定义了两个**本地接口**（不是从圆心 import，而是手写声明，因为 `remote:status` 的返回类型在圆心并未被声明成类型）：`RemoteStatus`（L14-21，`{enabled/bind/port/lanUrls/lan/freshPassword}`）与 `DeviceRow`（L24-30，`{id/kind/authenticated/remoteAddress/connectedAt}`）。
  - 这个 `RemoteStatus` 与圆心 `packages/shared/src/domain/remote.ts` L81-89 的 `RemoteStatus`（`{enabled/boundAddress/connections/channels}`）**同名不同义**：后者是 HTTP `/status.json` 的健康体，前者是 `remote:status` invoke 返回的脱敏视图。两处同名但无引用关系——本插件的本地接口是"消费端对 `remote:status` 返回值的结构化本地声明"，注释 L13/L24 明说这是"服务端 ConnectionInfo 的结构化本地声明"，属契约漂移气味（圆心本可声明 `remote:status` 的返回类型，当前只以 `Record<string, unknown>` 透传，见 §4）。

- 样式层收敛为几个常量与一个子组件（L32-112）。
  - `inputStyle`（L33-44）、`spreadRowStyle`（L47-53，`justifyContent: "space-between"` 两端对齐）、`labelStyle`/`hintStyle`/`monoStyle` 五个 `CSSProperties` 常量，全部消费 CSS token（`var(--color-border)`、`var(--spacing-md)` 等），不写死色值——这是"token key 合规、token 值违规"纪律的落地。
  - `UrlValue`（L74-112）是"链接 + 复制"子组件：`<a target="_blank" rel="noopener noreferrer">` 点击直达（Electron 下转系统浏览器），旁边一个 `Button variant="secondary"` 复制到剪贴板，`navigator.clipboard.writeText` 成功则显示 1.6 秒"已复制"（`setTimeout` 计时器在 `useEffect` 清理函数里 `clearTimeout`，L78）。
  - 组件唯一导出 `RemoteAccessPage`（L114），与 manifest 的 `component` 字段同名，框架自动匹配。

### 2.3 RemoteAccessPage 的状态与刷新

- 组件持 9 个 state：`status`（脱敏状态）、`freshPassword`（可展示明文）、`customPassword`（输入框）、`qr`（二维码 data URL）、`busy`/`error`（操作态）、`pwdCopied`（密码复制反馈）、`devices`（设备列表），外加 2 个 `useRef` 计时器。
  - `refresh`（L127-136）：`window.kernel.remote.status()` 拿脱敏状态，`window.kernel.remote.qr()` 拿二维码 data URL，两条各自 `.catch(() => {})` 静默失败——拉不到不炸页面。
  - **事件驱动刷新，不轮询**（§3.6 纪律落地）：`useEffect`（L138-143）挂载时 `refresh()` 一次，然后 `window.kernel.remote.onStateChanged(() => refresh())` 订阅配置变更推送，返回取消函数给 `useEffect` 清理。服务端任一端改了配置都会 `broadcast(IPC.remote.stateChanged, status())`，所有端的设置页被动同步刷新。
  - `loadDevices`（L146-148）与第二个 `useEffect`（L149-153）：挂载拉一次 `remote.connections()`，再订阅 `onConnectionsChanged`，`close` 事件回推新清单自动更新。注意 `onConnectionsChanged` 用可选链 `?.`（L151），因为旧后端可能未注册该通道。

- 组件顶部派生值（L168-171）：`enabled = !!status?.enabled`、`port = status?.port`、`localUrl = port ? http://127.0.0.1:${port}/ : null`、`lanUrl = status?.lanUrls?.[0] && port ? http://${status.lanUrls[0]}:${port}/ : null`。
  - 本机地址硬编码 `127.0.0.1`，局域网地址取 `lanUrls[0]`（`getLanAddresses()` 的第一个），两者拼接 `:${port}`。port 来自脱敏状态的 `port` 字段（即真实监听口 `actualPort`，见 §5），不是配置文件里的 `cfg.port`。

### 2.4 三个 SettingsSection 区块

- 第一个区块「远程访问」（L224-280）：`SettingsSection title={t("remote.access")} description={t("remote.accessDesc")}`，`actions` 区放状态圆点 + 开关按钮。
  - 状态圆点（L230-238）：`width:8,height:8` 圆形，`background: enabled ? "var(--color-accent-success)" : "var(--color-border)"`，旁白 `remote.enabled`/`remote.disabled`。
  - 开关按钮 `variant={enabled ? "danger" : "primary"}`（L239-241），`onClick={toggle}`。
  - 内容区四条行：本机地址行（`localUrl` 存在即渲染 `UrlValue`）、局域网地址行（`enabled && lanUrl` 才渲染）、二维码行（`enabled && qr && lanUrl` 时显示 `<img src={qr} width=160 height=160>` + `qrDesc` 说明，否则显示 `qrDisabledHint`）、`restartHint` 提示行（开关即时生效、其他端会短暂断开）。
  - `error` 非空时底部渲染红色错误行（L276-278）。

- 第二个区块「已连接设备」（L283-320）：`SettingsSection title={t("remote.devices")}`。
  - 空态显示 `remote.noDevices`；非空时 `devices.map` 每行一个 `DeviceRow`：kind 圆点（`local` 绿 `--color-accent-success`、`remote` 蓝 `--color-primary`）、`kindLocal`/`kindRemote` 标签、`remoteAddress ?? "—"` 等宽字体、`connectedAt` 转 `toLocaleTimeString()`、右侧 `Button variant="danger"` 踢掉。
  - 底部一行 `kickHint` 提示 + `kickAll` 按钮（`disabled={busy || devices.length === 0}`）。
  - `kick`/`kickAll`（L218-219）都是 `run(() => window.kernel.remote.kick(id))` 后 `loadDevices()` 拉新清单——注释 L217 写明"close 事件回推新清单,列表自动更新"（其实订阅已覆盖，再拉一次是兜底双保险）。

- 第三个区块「局域网密码」（L323-361）：`SettingsSection title={t("remote.lanPassword")} description={t("remote.lanPasswordDesc")}`。
  - 左半：`refreshPassword` 按钮 + `customized` 徽章（`customizedBadge` 绿字 或 `autoGenerated` 灰字）。
  - 右半：`freshPassword` 明文展示（等宽加粗 `letterSpacing 0.06em`，`userSelect: "text"` 允许手动选中）+ 复制按钮 + `customPassword` 输入框 + `setFixed` 按钮。
  - `setFixed` 的 `disabled={busy || strengthError(customPassword) !== null}`（L354）：本地强度预校验不通过就禁用按钮，服务端 `setPassword` handler 仍兜底 `validatePasswordStrength` 再校验一次（§6.4）。
  - 输入框 `onChange={(e) => setCustomPassword(e.target.value.slice(0, 64))}`（L349）：前端截断到 64 字符，`autoComplete="new-password"`。

### 2.5 操作封装与密码强度预校验

- `run`（L155-166）是统一操作封装：`setBusy(true)` → `setError(null)` → `await fn()` → `refresh()` → 失败 `setError(e.message)` → `finally setBusy(false)`。所有按钮点击都经它，保证操作期间 `busy` 禁用、错误统一呈现。
  - `toggle`（L182-193）：`enabled` 时 `remote.stop()` 并 `setFreshPassword(null)`（关闭后明文清零）；否则 `remote.start()`，若返回 `{newPassword}` 则 `setFreshPassword(res.newPassword)`（开启即展示新密码）。
  - `refreshPassword`（L195-199）：`remote.refreshPassword()` 返回明文，`setFreshPassword(pwd)`。
  - `setPassword`（L201-206）：`remote.setPassword(customPassword)` 后 `setFreshPassword(null)` + `setCustomPassword("")`（固定后清空输入框，明文由服务端随 stateChanged 广播下发，不本地留存）。
  - `copyFresh`（L208-215）：复制 `freshPassword` 到剪贴板，1.6 秒"已复制"反馈。

- `strengthError`（L174-180）是本地强度预校验，与服务端 `validatePasswordStrength`（`src/server/remote/password.ts` L36-42）**同规则**：少于 10 位 → `tooShort`；无数字 → `needDigit`；无字母 → `needLetter`；无特殊符号 → `needSymbol`。
  - 注释 L173 写明这是"先本地提示,服务端兜底"——本地禁用按钮只是 UX 优化，真正的安全校验在服务端 `setPassword` handler（L83-84）再跑一次 `validatePasswordStrength`，弱密码抛错拒绝，本地绕过也不生效。

## 3 locales 与 i18n 契约

### 3.1 8 条 languages 声明与 namespace 推导

- `plugin.json` 的 `contributes.languages` 数组（L18-27）声明 8 条贡献项，结构是 2 id × 4 locale：`remote-access.settings`（zh-CN/zh-TW/en/de 各一份，指向 `./locales/{locale}/settings.json`）与 `remote-access.plugin`（同样四份，指向 `./locales/{locale}/plugin.json`）。
  - 与 i18n 插件文档（`docs/plugins/system/i18n.md` §2.2）同一机制：`LanguageContribution.id` 不参与 i18next namespace 判定，真正决定 namespace 的是**每个 key 第一个 dot 之前的段**（`mergeLanguageContributions` 的 key 拆解）。
  - 本插件 `settings.json` 的所有 key 都以 `remote.` 开头（`remote.access`、`remote.start`…），故这些文案落入 **`remote` namespace**，而不是 `remote-access`；`id: "remote-access.settings"` 只是 `(插件, locale)` 维度的去重/日志标识。

### 3.2 两个文件各自承载的内容

- `locales/{locale}/plugin.json`（每语言 2 条）：`plugin.remote-access.displayName`（"远程访问"）与 `plugin.remote-access.description`（"远程访问设置:局域网开关、密码、二维码"）。
  - 这两条的 ns 是 `plugin`，消费方是 **plugin-manager 插件**渲染插件列表/详情时的 `t("plugin.remote-access.displayName")`——这是本插件与其他插件交互里仅有的"文案被他人消费"点（§10）。
- `locales/{locale}/settings.json`（每语言 27 条，zh-CN L1-37）：`remote.access/accessDesc/start/stop/enabled/disabled/restartHint`（开关区块）、`remote.devices/devicesDesc/noDevices/kindLocal/kindRemote/kick/kickAll/kickHint`（设备区块）、`remote.localAccess/lanAccess/lanPassword/lanPasswordDesc/refreshPassword/autoGenerated/customPlaceholder/setFixed/customizedBadge/passwordPolicy`（密码区块）、`remote.tooShort/needDigit/needLetter/needSymbol`（强度错误）、`remote.openInBrowser/copy/copied/qr/qrDesc/qrDisabledHint`（通用动作与二维码）。
  - 全部落入 `remote` namespace，`renderer/index.tsx` 用 `t("remote.xxx")` 消费——本插件是 `remote` namespace 的**唯一贡献者与唯一消费者**（无其他插件往 `remote` namespace 贡献 key，也无其他插件消费 `remote.*`）。

### 3.3 文案与安全的对应关系

- 几条文案直接承载安全语义，值得单独指出：
  - `remote.accessDesc`（zh-CN L3）："开启后同一局域网的设备可经浏览器访问本机。登录需要密码,无密码不允许访问。"——对应 §6 的"开启 LAN 必有密码"安全策略。
  - `remote.kickHint`（zh-CN L16）："踢只断开连接,不吊销凭证;要彻底失效请刷新密码或重启应用。"——对应 §6.7 设备管理的安全语义。
  - `remote.passwordPolicy`（zh-CN L26）："至少 10 位,须同时包含数字、字母、特殊符号。"——对应 `validatePasswordStrength` 的强度下限。
  - `remote.qrDesc`（zh-CN L35）："本机访问无需密码;局域网设备扫码打开后输入密码登录。"——对应 §6.6 二维码只编码地址不编码凭证。

## 4 圆心契约 remote.ts 与通道单源

### 4.1 线协议五消息

- `packages/shared/src/domain/remote.ts` 是 web 服务化的线协议类型（纯类型零依赖，注释 L1-6 写明"不 import electron/react/ws"）。
  - `InvokeRequest`（L11-16）：`{kind:"invoke", id, channel, args}`，C→S 请求，`id` 自增、跨连接唯一（由 `wsTransport` 内维护）。
  - `ResultResponse`（L19-25）：`{kind:"result", id, ok, result?, error?}`，S→C 应答，`ok:false` 时 `error.message` 是清晰提示不裸透内核错误。
  - `PushMessage`（L28-32）：`{kind:"push", channel, args}`，S→C 推送（原 `webContents.send` 的等价物）。
  - `HelloRequest`（L35-38）与 `HelloResponse`（L41-45）：C→S 鉴权（带 `token`）与 S→C 鉴权结果（带 `ok`）。
  - `WireMessage`（L48-53）是这五者的联合；`parseWire`/`serializeWire` 在 `packages/shared/src/wire/wire.ts` L8-19 做"文本 ↔ WireMessage"的边界校验（`JSON.parse` + 校验 `kind` 字段，非法抛错由 ws-server 捕获）。

### 4.2 连接身份与设备清单类型

- `ConnKind = "local" | "remote"`（L56）：`local` = 本机 Electron 窗口/本机浏览器，`remote` = 外部浏览器。
- `Conn`（L59-69）：`{id, kind, host, authenticated, remoteAddress?, connectedAt?}`——每连接上下文，`host` 是宿主能力面（`Host`），注释 L58 写明"remote 连接为缺省降级实现"。
- `ConnectionInfo`（L72-78）：`{id, kind, authenticated, remoteAddress?, connectedAt?}`——设备列表行，**不带 `Host` 大对象**的连接摘要，对应本插件 `DeviceRow` 的形状。
- `RemoteStatus`（L81-89）：`{enabled, boundAddress, connections, channels}`——这是 **`/status.json` 健康体的 body**（`http-server.ts` L99-104 用它），与本插件本地 `RemoteStatus` 同名不同义，见 §2.2。

### 4.3 通道名单源

- `IPC.remote` 在 `packages/shared/src/channel/channel-contract.ts` L294-311 声明，是本插件与后端交互的全部通道名单源：
  - invoke 通道 7 条：`status: "remote:status"`、`start: "remote:start"`、`stop: "remote:stop"`、`setPassword: "remote:setPassword"`、`refreshPassword: "remote:refreshPassword"`、`setLanPasswordEnabled: "remote:setLanPasswordEnabled"`、`qr: "remote:qr"`。
  - 设备管理 3 条：`connections: "remote:connections"`、`kick: "remote:kick"`、`kickAll: "remote:kickAll"`。
  - push 通道 2 条：`stateChanged: "remote:stateChanged"`（配置变更广播）、`connectionsChanged: "remote:connectionsChanged"`（连接增减/鉴权变化广播）。
  - 这是"通道名单源"纪律：`build-kernel.ts`、`controllers/remote.ts`、`ws-server.ts` 都 import `IPC` 常量，不手写 `"remote:start"` 魔法字符串。

## 5 服务端控制面 controllers/remote.ts

### 5.1 脱敏视图 redactRemoteConfig

- `redactRemoteConfig(cfg, actualPort)`（L15-27）返回 `remote:status` 的脱敏视图：`{enabled, bind, port: actualPort, lanUrls: getLanAddresses(), lan: {enabled, hasPassword, customized}}`。
  - **敏感字段过滤在协议翻译层**（§4.6 纪律）：`passwordHash` 不出服务端边界，只置 `hasPassword` 布尔（`cfg.lan.passwordHash !== null`）；`lanUrls` 是给 UI/二维码用的地址列表。
  - `port` 字段取 `actualPort`（真实监听口）而非 `cfg.port`——注释 L14 明说"配置文件里的 port 是设计默认值,未必等于实际绑定"。这个差异的根在 `assemble.ts`：绑定口是编译期常量 `PORT = 8420`（L104），`DEFAULT_REMOTE_CONFIG.port = 4763`（remote-config.ts L27）实际上从不参与 `listen`，只作为历史字段躺在 `remote.json` 里。`redactRemoteConfig` 刻意用 `actualPort` 让 UI 显示真实地址。

### 5.2 设备管理接口与 registerRemote 签名

- `RemoteDeviceManager`（L29-33）：`{list(): ConnectionInfo[]; kick(id): boolean; kickAll(): number}`——设备管理面的抽象，由 `assemble.ts` 注入真实实现（`wsHandleRef` 的 `listConnections/kick/kickAll`）。
- `registerRemote(gateway, auth, opts)`（L35）签名：`opts: {port, rebind?, deviceManager?}`——`rebind` 是热重绑闭包（`assemble.ts` 延迟注入），`deviceManager` 是设备管理句柄（同样延迟注入）。

### 5.3 lastFreshPassword：多端可见的明文展示机制

- `registerRemote` 内持一个模块级变量 `lastFreshPassword: string | null`（L40），记录"最近一次可展示的密码明文"。
  - `status()`（L42）= `{...redact(), freshPassword: lastFreshPassword}`，随 `remote:status` 与 `stateChanged` 广播下发到所有客户端——注释 L39-40 写明这是"第 20 项"修订：任何一端开启/刷新，所有端打开都看得到，不再只有操作端可见。
  - 信任边界与响应同口径：明文只达**已鉴权客户端**（本机免密 + 局域网登录后），落盘仍只存 hash（`cfg.update` 只写 `passwordHash`）。
  - `pushState`（L44）= `gateway.broadcast(IPC.remote.stateChanged, status())`——配置一变就全量广播，多客户端设置页同步刷新。

### 5.4 各 handler 逐个拆解

- `IPC.remote.status`（L60）：`() => status()`，只读脱敏视图。
- `IPC.remote.start`（L62-73）：**每次开启必刷新一次密码**。
  - 生成 `newPassword = generateStrongPassword()`，`lastFreshPassword = newPassword`，`cfg.update({enabled: true, bind: "lan", lan: {..., passwordHash: hashPassword(newPassword), customized: false}})`，然后 `rebind()` + `pushState()`，返回 `{...status(), newPassword}`（明文随响应返回给操作端展示）。
  - 注释 L63-66 钉死设计决策：不做"固定密码沿用"例外——只存 hash 无法回显，藏密码 = 用户拿不到凭证；固定密码的价值是"启用期间 + 重启后持续有效"，但下一次开启仍会被刷新替换。
- `IPC.remote.stop`（L74-79）：`cfg.update({enabled: false, bind: "loopback"})` + `rebind()` + `pushState()`，返回 `status()`。
- `IPC.remote.setPassword`（L81-89）：`validatePasswordStrength` 兜底校验（弱则 `throw new Error(weak)`），通过后 `lastFreshPassword = pwd`（用户刚敲的可展示）、`cfg.update({lan: {..., passwordHash: hashPassword(pwd), customized: true}})`、`pushState()`。
- `IPC.remote.refreshPassword`（L90-96）：生成新强密码、`lastFreshPassword = pwd`、`cfg.update({..., customized: false})`、`pushState()`，返回明文 `pwd`（注释 L95 "返回明文供 UI 展示一次"）。
- `IPC.remote.setLanPasswordEnabled`（L97-101）：`cfg.update({lan: {..., enabled: Boolean(enabled)}})` + `pushState()`。**注意**：本插件的 UI 从未调用它——这是后端预留的"局域网密码开关"通道，renderer 里没有对应控件（关闭密码 = 无密码不允许访问，与 `accessDesc` 文案矛盾，故 UI 不暴露）。
- 设备管理三条（L107-109）：`connections` 返回 `opts.deviceManager?.list() ?? []`；`kick` 返回 `{ok: deviceManager?.kick(String(id)) ?? false}`；`kickAll` 返回 `{ok: true, kicked: deviceManager?.kickAll() ?? 0}`。
- `IPC.remote.qr`（L111-116）：`getLanAddresses()[0]` 无则返回 `null`，有则 `generateQr("http://${ip}:${opts.port}/")`——**二维码只编码地址，不编码密码/凭证**（§6.6）。

### 5.5 启动防御与热重绑

- **启动防御**（L54-58）：`boot = cfg.get()`，若 `boot.enabled && (passwordHash === null || !customized)`（含历史"无密码"裸奔态）→ 重启即生成强密码并 `hashPassword` 写回，`customized: false`，`lastFreshPassword` 记明文供广播。这保证任何历史裸奔态在重启后立即补上密码。
- **rebind 闭包**（L47-49）：`setTimeout(() => opts.rebind?.(), 150)` 延迟一拍执行——先让本次 invoke 应答冲刷出去，因为重绑会终止所有现存连接（含调用者）。

## 6 远程访问安全体系

> 本节是任务要求专节。远程访问安全按五个维度展开：登录、token、隧道、QR、设备管理。核心结论先给：**信任边界 = loopback 本机免密 + 局域网密码换 HMAC token；凭证只经表单 + httpOnly cookie / hello token 传递，密码永不进 URL；token 绑定进程、重启全失效；公网隧道已移除。**

### 6.1 登录：/login → scrypt 密码 → HMAC token

- 登录门的前端是 `src/web/login-gate.ts`：`fetchAuthState`（L6-10）查 `GET /auth-state`，`required=true` 时 `renderLoginForm`（L24-77）接管 `#root` 渲染纯 DOM 登录表单（此时 `window.kernel` 未构建、React 树未起）。
  - 表单提交（L54-58）`fetch("/login", {method:"POST", body: JSON.stringify({password})})`；成功（`res.ok && body.ok`）则 `location.replace(location.pathname)` 整页重载走正常引导（cookie 已种）；`429` 显示 `locked(sec)`，否则显示 `error` 或"密码错误"。
  - 登录门文案（L13-21）是引导期基础设施，中英对照写死——注释 L12 明说与 `/login` 服务端错误文案同属基础设施层，不经过 i18n 框架。

- 服务端 `/login` 在 `src/server/transport/http/http-server.ts` L41-74：
  - `const ip = req.socket.remoteAddress`（L43），先 `auth.rateLimiter.peek(ip)`（L48）——**锁定中的请求不暴露密码对错，正确密码也不消耗失败额度**。
  - 密码正确（L56-64）：`recordSuccess(ip)` 清零 → `signRemoteToken()` 签发 HMAC token → `set-cookie: mhd_session=<token>; HttpOnly; SameSite=Strict; Path=/` + JSON `{ok:true, token}`。
  - 密码错误（L65-71）：`recordFailure(ip)`，锁定期返回 `429` + `retryAfterSec`，未锁返回 `401` + "密码错误"。
  - **双通道下发 token**：httpOnly cookie 供浏览器随静态/WS 请求携带，JSON `token` 供无 cookie 客户端经 `hello` 传递（注释 L59）。

- `/logout`（L75-79）当前只返回 `{ok:true}`，不真正清除服务端状态（无服务端会话表可清）——它是预留的对称端点。

### 6.2 token：localToken 与 HMAC token 复合校验

- `RemoteAuth`（`src/server/remote/auth.ts` L12-47）在构造时生成两个密钥：`localToken = randomUUID()`（L20）与 `serverSecret = randomBytes(32).toString("hex")`（L21）。
  - `serverSecret` 每次后端启动随机 → HMAC token **绑定进程，重启全失效**（注释 L11、auth.test.ts L50-56 的"换 serverSecret 失效"用例）。
  - `createTokenVerifier()`（L26-32）：返回 `TokenVerifier`——`token === localToken` → 返回 `"local"`；否则 `verifyToken(token, serverSecret)` → 返回 `payload?.kind ?? null`（`"remote"` 或 `null`）。
  - `checkPassword`（L35-38）：`cfg.lan.enabled && !!cfg.lan.passwordHash && verifyPassword(password, hash)`——**lan 关或无 hash → 一律拒绝，不静默放行**（auth.test.ts L40-48 用例）。
  - `signRemoteToken(ttlSec = 24*60*60)`（L41-46）：`signToken({kind:"remote", exp: now+ttl, nonce: randomUUID()}, serverSecret)`，默认 24 小时过期。

- HMAC 签名在 `src/server/remote/token.ts`：`signToken`（L15-19）= `base64url(JSON(payload)) + "." + base64url(HMAC-SHA256(body))`；`verifyToken`（L22-43）= 拆点号 → 重算 HMAC → `timingSafeEqual` 常量时间比较 → 解析 payload → 校验 `kind`/`exp`/`nonce` 字段类型 → 校验 `exp >= now`，任一步失败返回 `null`。
  - token.test.ts 覆盖四类失败：签名篡改、载荷篡改（重签不了）、过期、换 secret。
  - `timingSafeEqual` 防时序侧信道（token.ts 注释 L3、L34）；`nonce` 随机串保证同一 payload 不同签。

### 6.3 失败限速：5 错锁 60s

- `createRateLimiter(opts?)`（`src/server/remote/rate-limiter.ts` L19-52）返回 `RateLimiter` 三方法：`peek`（只读查锁不计数）、`recordFailure`（记一次失败，`count >= maxFailures` 时锁 `lockSec`）、`recordSuccess`（清零）。
  - 默认 `maxFailures=5`、`lockSec=60`（L20-21）。纯内存 `Map<key, {count, lockedUntil}>`，不落盘。
  - 注释 L2 写明"作用于 /login 与 hello 两个入口,共用一个实例"；实际代码里 `/login` 用 `peek`/`recordFailure`/`recordSuccess`（http-server.ts L48/L57/L66），`hello` 入口当前未挂限速（ws-server 的 hello 鉴权失败直接关闭连接，天然防批量爆破，见 §6.5）。
  - 关键设计：`peek` 先查锁、后验密码（http-server.ts L47 注释），使**锁定期间不泄露"密码对错"这一侧信道**，正确密码也不消耗失败额度。

### 6.4 密码：scrypt 哈希与强度策略

- `src/server/remote/password.ts` 是密码哈希与强度策略单源。
  - `hashPassword`（L9-13）：`scrypt$<salt hex>$<hash hex>`，盐 `randomBytes(16)`、`scryptSync(password, salt, 32)`——node:crypto 内置，不引 bcrypt 依赖（注释 L1）。
  - `verifyPassword`（L16-24）：`stored.split("$")` 三段校验 → `scryptSync` 重算 → `timingSafeEqual` 常量时间比较。非 scrypt 格式或长度不符 → false。
  - 字符集（L27-30）：`DIGITS = "23456789"`（**排除 0**）、`LETTERS = "abcdefghjkmnpqrstuvwxyz..."`（**排除 1/l/I/O**）、`SYMBOLS = "!@#$%^&*()-_=+"`——排除易混字符。
  - `PASSWORD_MIN_LENGTH = 10`（L33），`validatePasswordStrength`（L36-42）四查：长度 ≥ 10、含数字、含字母、含特殊符号，合法返回 `null` 否则返回原因。
  - `generateStrongPassword(length = 12)`（L45-55）：三类字符各保底一个，其余从 `ALL` 随机补足，最后 Fisher-Yates 洗牌（保底字符不落固定位）。注释 L3-4 解释为何要混合字符集：纯数字 8 位可被离线字典秒破，且密码不进 URL（登录走表单 + 限流），故字符集不受 URL 安全约束。
  - 强度策略在两端各校验一次：前端 `strengthError`（renderer L174-180）禁用按钮，服务端 `setPassword` handler（controllers/remote.ts L83-84）兜底 `throw new Error(weak)`——本地绕过无效。

### 6.5 loopback 信任边界与鉴权门

- `src/server/remote/net.ts` 是"来源判定"单源：`SESSION_COOKIE = "mhd_session"`（L5）、`isLoopback(remoteAddress)`（L8-10，覆盖 `127.0.0.1`/`::1`/`::ffff:127.0.0.1`）、`parseCookies`（L13-21）。
- **三条本地/远程身份路径在此汇合**（§6.2 的 `TokenVerifier` 语义 + ws-server 的 hello 流程）：
  1. Electron 窗口：`assemble.ts` L705 返回 `localToken: auth.localToken`，`electron.ts` L63 `win.loadURL(...?lt=${assembled.localToken})`，`src/web/bootstrap.ts` L46 读 `?lt=`、L74 把 `lt` 作为 `token` 传给 `wsTransport`，open 后第一帧发 `hello {token: lt}` → `createTokenVerifier` 命中 `token === localToken` → `"local"` 身份。
  2. 本机浏览器 loopback 直连：`attachWsServer` 的 `trustLoopback`（默认 true，ws-server.ts L24/L60-63）——`isLoopback(remoteAddress)` 命中则 `conn.kind = "local"; conn.authenticated = true` 免 hello。
  3. 远程浏览器：`/login` 拿 HMAC token → httpOnly cookie（WS 升级时 ws-server L56-57 读 cookie `mhd_session` 并 `gateway.authenticate(conn, cookieToken)`）或 `?token=` query（bootstrap.ts L47 的 `urlToken`，供无 cookie 环境）→ `hello` 传 token → `verifyToken` → `"remote"` 身份。
- `/auth-state`（http-server.ts L83-94）是本连接鉴权态势探测：`authed = isLoopback || cookieToken 有效 || queryToken 有效`，返回 `{required: !authed}`。渲染层启动前先查它决定要不要弹登录门（login-gate.ts L6-10、index.tsx 的两段式引导）。
- **未鉴权拒绝**在网关 `dispatch`（gateway.ts L50-53）：`conn.authenticated` 为假 → 返回 `{ok:false, error:{code:"AUTH_REQUIRED"}}`；hello 鉴权失败 → ws-server L84 `ws.close()` 关闭连接（ws-server.test.ts L67-73 用例）。

### 6.6 隧道与 QR

- **公网隧道已移除**：`controllers/remote.ts` L2、`renderer/index.tsx` L3、`auth.test.ts` L32 三处注释一致写明"公网隧道已移除（先只做本机与局域网）"。当前远程访问只有两个可达面：`127.0.0.1`（loopback，`bind: "loopback"`）与 `0.0.0.0`（局域网，`bind: "lan"`，见 `bindFor` 逻辑 assemble.ts L650-651）。
- **QR 只编码地址不编码凭证**：`IPC.remote.qr`（controllers/remote.ts L111-116）取 `getLanAddresses()[0]`，`generateQr("http://${ip}:${opts.port}/")`——二维码内容是局域网地址 URL，**不含密码、不含 token**。
  - `src/server/client/remote/qr.ts` 的 `generateQr(url)`（L7-9）用 `qrcode` 包 `QRCode.toDataURL(url, {width: 240, margin: 1})` 输出 data URL（base64 PNG）。
  - 设备扫码打开地址后走登录门（`/auth-state` → 登录表单 → `/login`），凭证仍经表单 + cookie/token 传递，不进 URL（renderer L114 注释、login-gate 注释）。
- **LAN IP 探测**：`src/server/client/remote/lan-ip.ts` 的 `getLanAddresses()`（L7-15）用 `node:os.networkInterfaces()` 取 `family === "IPv4" && !internal` 的地址，`Set` 去重返回数组。供 `redactRemoteConfig.lanUrls`（UI 展示）与 `qr`（二维码）消费。

### 6.7 设备管理：kick 只断连接不吊销凭证

- 设备清单在 `ws-server.ts` 维护：`conns: Map<id, {info, ws}>`（L44），`notifyChanged`（L45-46）把摘要广播为 `IPC.remote.connectionsChanged`。
  - `WsServerHandle`（L28-37）四操作：`closeAllClients`（`wss.clients` 逐个 `terminate`）、`listConnections`（映射 `c.info`）、`kick(id)`（`entry.ws.close()` 优雅关闭）、`kickAll`（遍历 close，返回计数）。
  - `kick` 返回是否命中，`kickAll` 返回被踢数量；`assemble.ts` L531-539 把 `wsHandleRef` 包装成 `RemoteDeviceManager` 注入 `registerRemote`。
- **安全语义**（controllers/remote.ts L104-106 注释 + renderer 的 `kickHint` 文案）：**踢只断连接、不吊销 token**——被踢端仍持有效凭证可重登。彻底失效分两层：刷新密码（换 `passwordHash`）只使旧密码失效，已签发的 HMAC token 仍在其 24h 有效期内（token 不绑定密码，见 §12 Q「踢掉后还能重连吗」）；只有重启应用（换 `serverSecret`）才使所有 HMAC token 全失效。
  - 踢是 `ws.close()` 优雅关闭（先冲刷缓冲再发 close 帧，保证本次 invoke 应答能出去），触发 `ws.on("close")` → 注册表回收 + `connectionsChanged` 广播，各端列表事件驱动刷新。

## 7 传输层：HTTP + WS 服务器

### 7.1 HTTP 服务器 http-server.ts

- `createHttpServer({staticDir, gateway, auth})`（L27）组装 node:http 服务器，处理五类请求：
  - `POST /login`（§6.1）与 `POST /logout`（§6.1）。
  - `GET /auth-state`（§6.5）。
  - `GET /status.json`（L97-106）：返回 `{enabled: true, boundAddress: boundAddress(), connections: gateway.connectionCount(), channels: gateway.channelCount()}`——`boundAddress()`（L31-35）自引用 `self.address()` 报告真实监听地址（热重绑后随之变化）。
  - 静态 + SPA 回退（L108-124）：`staticDir` 由 bootstrap 注入，`normalize(url)` 去路径穿越、`join(staticDir, ...)` 拼文件，`existsSync` 否则回退 `index.html`，`readFile` 后按 `MIME` 表（L13-24）写 content-type。
- 依赖只向内：只 import `node:http/fs/path` + `gateway`/`auth`/`net` 类型，不 import electron（注释 L2）。

### 7.2 WS 服务器 ws-server.ts

- `attachWsServer(server, gateway, host, verifyToken, opts)`（L40）把 gateway 挂到 `/rpc` 路径，返回 `WsServerHandle`。
  - 连接建立（L48-68）：`connSeq` 自增生成 `conn-${id}`，`kind` 缺省 `remote`、`authenticated: false`、记 `remoteAddress`/`connectedAt`；先查 cookie 鉴权（L56-57），再查 loopback 信任（L60-63），然后 `conns.set` + `notifyChanged`。
  - `gateway.addSink`（L69-71）注册发送 sink（`serializeWire` 后 `ws.send`），返回的 `offSink` 在 close 时调用回收。
  - `ws.on("message")`（L73-94）：`parseWire` 失败忽略（坏帧不炸连接）；`hello` 帧 → `gateway.authenticate` → 回 `hello {ok}` → 失败 `ws.close()`、成功更新注册表摘要并 `notifyChanged`；`invoke` 帧 → `gateway.dispatch` → 回 `result`。
  - `ws.on("close")`（L96-99）：`offSink()` 回收 sink + `conns.delete` + `notifyChanged`。
- 注释 L5-9 把职责钉死：连接生命周期（建立→鉴权 hello→工作→断开回收）、广播经 `gateway.addSink` 收口、本地窗口与远程浏览器同路、设备清单增减与鉴权变化广播 `connectionsChanged`（事件驱动不轮询）。

### 7.3 网关 gateway.ts

- `createGateway(verifyToken)`（L35）组装 channel 分发 + 鉴权 + 广播扇出。
  - `register(channel, handler)`（L40-42）：`handlers.set`。
  - `authenticate(conn, token)`（L43-49）：`verifyToken(token)` 返回 kind → 置 `conn.kind`/`conn.authenticated`。
  - `dispatch(conn, msg)`（L50-67）：未鉴权 → `AUTH_REQUIRED`；无 handler → `UNKNOWN_CHANNEL`；handler 抛错 → `HANDLER_ERROR`（`e.message`）；成功 → `{ok:true, result}`。
  - `addSink`（L68-71）：`sinks` Set 增删；`broadcast`（L72-75）：对每个 sink 发 `{kind:"push", channel, args}`。
  - `channelCount`/`connectionCount`（L76-81）：`handlers.size` / `sinks.size`（`connectionCount` 实为已鉴权 sink 数，供 `/status.json`）。
  - `Handler` 签名（L12）= `(conn, ...args)`，与原 `ipcMain.handle` 的 `(event, ...args)` 同形，搬迁 handler 体零改动（注释 L9-11）。

## 8 组装与热重绑：bootstrap/assemble.ts

- 组装序（L104-107）：`remoteConfig = new RemoteConfigStore(join(CONFIG_DIR, "remote.json"))` → `auth = new RemoteAuth(remoteConfig)` → `gateway = createGateway(auth.createTokenVerifier())`。
  - `RemoteConfigStore`（`src/server/remote/remote-config.ts` L33-54）：`readJsonFile` 读 raw，按字段显式取值 + `DEFAULT_REMOTE_CONFIG` 兜底，`lan` 深层字段逐层合并；`update` 合并 patch 后 `writeJsonFile`。历史遗留键（如已移除的 `public`）读后即丢、下次写回清除（password.test.ts L80-89 用例）。
  - `DEFAULT_REMOTE_CONFIG`（L24-29）：`{enabled: false, bind: "loopback", port: 4763, lan: {enabled: true, passwordHash: null, customized: false}}`。

- `registerRemote` 的注入（L527-540）：`rebindRemote` 与 `wsHandleRef` 先声明为占位，`registerRemote(gateway, auth, {port: PORT, rebind: () => rebindRemote(), deviceManager: {list/kick/kickAll → wsHandleRef}})`——真实实现延迟到下方 `createHttpServer`/`attachWsServer` 后赋值。

- 服务器起 + 热重绑（L645-684）：
  - `createHttpServer({staticDir: opts.rendererDir, gateway, auth})` + `attachWsServer(httpServer, gateway, host, auth.createTokenVerifier())`，`wsHandleRef = wsHandle`。
  - `bindFor()`（L650-651）：`remoteConfig.get().enabled && bind === "lan" ? "0.0.0.0" : "127.0.0.1"`——默认关闭 = 仅 loopback，开启 LAN 才 0.0.0.0。
  - `httpServer.listen(PORT, currentBind)`（L653），`PORT = 8420`（L104）。
  - `rebindRemote`（L662-684）：`next = bindFor()`，`next === currentBind || rebinding` 则直接返回（防重入）；置 `rebinding = true` → `wsHandle.closeAllClients()`（升级后的 WS socket 不计入 `server.close` 等待，须显式清，否则 close 回调不触发、端口悬空）→ `httpServer.closeAllConnections?.()` → `httpServer.close(cb)` 里 `listen(PORT, next)`，完成后 `rebinding = false`，若 `bindFor() !== currentBind` 则 `rebindRemote()`（连点收敛，listen 期间再次开关的最新配置自检补一轮）。
  - 防御（L657-660）：全程 try/catch + 常驻 `error` 监听——重绑路径上任何未捕获异常都会杀掉主进程（应用整体暴毙的根因）。

- 返回值（L705）：`{ctx, sessionStore, gateway, localToken: auth.localToken, port: PORT}`——`localToken` 供 `electron.ts` 拼 `?lt=` 注入本机窗口。

## 9 前端传输与断连横幅

- `src/web/transport/ws-transport.ts` 的 `wsTransport(ws, opts)`（L41）把 WebSocket 包装成 `RemoteTransport`（三原语 `invoke/on/off`）。
  - **hello 收进传输层**（注释 L29-33）：有 `opts.token` 时 open 先发 `hello {token}`，鉴权通过前 `send` 把一切业务帧缓冲进 `outbox`，`hello` 应答 `ok` 才 `flush`。根因是引导期大量 invoke（hydrate/i18n/plugins-host）在模块级发出、早于 WS open，若 hello 与 invoke 各自排队会把 invoke 冲在 hello 之前、整批被网关按"未鉴权"拒掉（首屏黑屏根因）。
  - 鉴权失败/断开（L54-58、L84-89、L102-106）：`failAll(message)` 把所有挂起 invoke 显式 reject——不静默挂死（不伪造成功、也不无限等待）。
  - `bootstrap.ts` L52-71 的 `showDisconnectedBanner`：断连挂底部横幅 + 刷新按钮，补页面级可见性（输入框还能动但发送无响应，不能静默）。
- `bootstrap.ts` L45-50 读 URL：`lt`（本机身份 token）、`token`（远程 HMAC token 供无 cookie 环境），`platform = lt ? detectClientPlatform() : "browser"`——本机窗口按宿主 OS 归一化，远程浏览器自判 `"browser"`（无原生红绿灯/窗口控制）。
- `build-kernel.ts` L641-663 把 `IPC.remote.*` 封装成 `window.kernel.remote`：7 个 invoke 方法 + `onStateChanged`/`onConnectionsChanged` 两个订阅（内部 `transport.on`，返回取消函数）。这是本插件的唯一 API 来源。

## 10 与其他插件的交互

- **零 peer 事件耦合**：本插件不 `emit`、不 `on`、不 `invoke` 任何插件间事件通道（`ctx.events`），manifest 无 `dependsOn`。
  - grep 全仓确认：`remote:stateChanged` 与 `remote:connectionsChanged` 的消费方只有 `build-kernel.ts`（框架封装）与本插件 renderer；本插件不订阅任何 `system:*` 框架事件、不消费其他插件 channel。
  - 这意味着本插件与其它壳插件之间是**完全解耦**的：删掉任何其他插件（含 i18n、plugin-manager），本插件功能不受影响（最多显示名/文案回退 key）；删掉本插件，其他插件也不受影响（没有任何插件 `dependsOn` 它）。

- **与 i18n/languages 槽的交互（单向产出-消费）**：本插件是 `remote` namespace 的唯一贡献者，也是唯一消费者——`useTranslation()` 拿到的 `t("remote.*")` 命中自己贡献的 `settings.json`。
  - 它与 i18n 插件共享同一个 i18next 实例（`initI18n` 用 `mergeLanguageContributions` 的全局合并结果），但 i18n 插件不贡献 `remote.*`，本插件也不贡献 `shell/common/settings` 等共享 namespace——两者在 namespace 层面互不重叠。
  - `remote` namespace 的文案可被第三方语言插件覆盖（`SOURCE_PRIORITY` 高来源胜），这是无特权差异纪律的自然结果，本插件不设防。

- **与 plugin-manager 的交互（文案被他人消费）**：`plugin.remote-access.displayName/description` 两条 key（ns `plugin`）由 plugin-manager 渲染插件列表/详情时 `t("plugin.remote-access.displayName")` 消费——这是本插件唯一"产出被其他插件消费"的点。
  - 本插件 `tier: "official"` 且无 `protected`，故 plugin-manager 允许禁用它、卸载它（对比 i18n 插件的 `protected: true` 可禁用不可卸载）。

- **与 settings 槽框架的交互**：`RemoteAccessPage` 由框架按 `component` 名自动注册、在设置页左列表按 `order: 100` 排位、点击进入渲染——本插件不手写 register、不感知设置页左列表实现（`settings-page.tsx` 读 `t(\`settings.${id}\`, {defaultValue: title})`，本插件 id 为 `remote-access`，查 `t("settings.remote-access")` 无贡献方 → 回落 manifest 字面值 `title: "远程访问"`，英文环境显示字面中文——这是一个轻微文案缺口：本插件没往 `settings` namespace 贡献 `settings.remote-access`，左列表标题不随语言切换）。
- **与壳后端的交互（直连控制面）**：本插件是 `window.kernel.remote` 的**唯一消费者**，经 7 个 invoke + 2 个 push 订阅与后端交互。它不经过 `usePluginContext()`（`remote` 未泛化进 PluginContext），这是它与其他设置页插件（如 i18n 的 `LanguageSettings` 用 `ctx.i18n.list`）在接入方式上的本质差异——本插件更"贴着系统控制面"，尚未抽象成可供第三方复用的 PluginContext 能力。

## 11 纪律边界与分层检验

- **依赖只向内**：renderer 只 import `react`/`react-i18next`/`@my-harness-desktop/react`，零对 `src/server`/`src/web`/`packages/shared` 内部文件的直接引用；服务端各文件（remote/transport/controllers）只 import `node:*` + `@my-harness-desktop/shared` + 同目录文件，不 import electron/react。
  - `packages/shared/src/domain/remote.ts` 零依赖（只 `import type { Host }`），`src/server/remote/token.ts`/`password.ts`/`rate-limiter.ts`/`net.ts` 只 import `node:crypto`/`node:os` 或零 import——物理隔离守住。
- **机制与内容分离**：安全机制（scrypt/HMAC/限速/来源判定/网关分发）全在壳后端，本插件零安全实现；文案全在 `locales/`，renderer 只写 `t("remote.*")` key 不写死中文值（对比 login-gate.ts 是引导期基础设施，文案写死属已知例外，注释 L12 已声明）。
- **契约单源**：通道名单源在 `channel-contract.ts` L294-311；线协议类型单源在 `domain/remote.ts`。**一处契约漂移气味**：`remote:status` 的返回类型未在圆心声明，本插件在 renderer 手写了本地 `RemoteStatus`/`DeviceRow` 接口（§2.2/§4.2），且与圆心 `RemoteStatus` 同名不同义——若将来第三方插件也要消费 `remote:status`，应在圆心补一个 `RedactedRemoteStatus` 类型并 re-export，消除这份本地副本。
- **事件驱动不轮询**：本插件两处订阅（`onStateChanged`→`refresh`、`onConnectionsChanged`→`setDevices`）都是"服务端 push → 前端被动刷新"，挂载拉一次基线、之后零轮询；服务端 `notifyChanged`/`pushState` 都是"变更即广播"。
- **构造与执行分开**：`redactRemoteConfig`（构造脱敏视图，纯函数）与 `registerRemote` 各 handler（执行 cfg.update + pushState）分离；`generateQr`（构造 data URL）与 `qr` handler（执行）分离。
- **无特权差异**：本插件 `tier: "official"` 无 `protected`，与第三方插件同权——可禁用、可卸载、其 `remote`/`plugin.remote-access` 文案可被更高来源覆盖；后端安全机制不对任何插件开特权后门。

## 12 QA

**Q：本机浏览器访问为什么免密码，而局域网设备要密码？**

信任边界是 loopback。`isLoopback`（`net.ts` L8-10）把 `127.0.0.1`/`::1`/`::ffff:127.0.0.1` 判定为本机来源，`attachWsServer` 的 `trustLoopback`（默认 true）直接给 `local` 身份 + 已鉴权；`/auth-state` 里 `isLoopback` 也直接 `required: false`。本机窗口（Electron）走 `?lt=localToken` 的 hello 鉴权，`localToken = randomUUID()` 每次启动随机。局域网设备则是不可信来源，必须经 `/login` 密码换 HMAC token 才能拿到 `remote` 身份。二者在 `createTokenVerifier`（auth.ts L26-32）里是同一份复合校验的两个分支。

**Q：为什么说 token 绑定进程、重启全失效？**

因为 `serverSecret = randomBytes(32).toString("hex")` 在 `RemoteAuth` 构造时每次随机生成（auth.ts L21），HMAC token 用它签名（`signRemoteToken` → `signToken`）。进程重启 = 新 `RemoteAuth` = 新 `serverSecret`，旧 token 的签名校验 `timingSafeEqual` 必失败（auth.test.ts L50-56 的"换 serverSecret 失效"用例）。本地 `localToken = randomUUID()` 同理每次启动随机。唯一跨重启持久的凭证是**固定密码**（`customized: true` 的 `passwordHash` 落 `remote.json`），它是密码而非 token——重启后仍可用同一密码重新登录换新 token。

**Q：`remote.json` 里存的 `port`（默认 4763）和实际监听口（8420）为什么不一样？**

这是历史残留。`DEFAULT_REMOTE_CONFIG.port = 4763`（remote-config.ts L27）是设计默认值，但 `assemble.ts` 的绑定用编译期常量 `PORT = 8420`（L104）`httpServer.listen(PORT, ...)`，`remote.json` 的 `port` 字段从不参与 `listen`。`redactRemoteConfig`（controllers/remote.ts L15-27）刻意返回 `port: actualPort`（真实 8420）而非 `cfg.port`，注释 L14 明说"配置文件里的 port 是设计默认值,未必等于实际绑定"——UI 显示的是真实地址。要消除这个双源，应把 `PORT` 收敛为从 `remote-config` 读，或删掉 `RemoteConfig.port` 字段，这是待清理的契约漂移。

**Q：密码为什么能明文展示在设置页，这不是违背"不存明文"吗？**

两个层面要分清：**落盘**只存 `passwordHash`（scrypt hash），`RemoteConfigStore`/`cfg.update` 从不写明文；**内存展示**的 `lastFreshPassword`（controllers/remote.ts L40）只在服务端内存持有"最近一次"明文，随 `remote:status`/`stateChanged` 广播给已鉴权客户端，供用户复制。这是刻意的 UX 决策（注释 L39-40）：只存 hash 无法回显，藏密码 = 用户拿不到凭证，会导致"开不了访问"的盲区。安全边界靠"只达已鉴权客户端"守住——未登录的局域网设备拿不到 `stateChanged` 广播（广播走 `gateway.broadcast`，只对已鉴权 sink 发）。固定密码（`customized: true`）则无法回显明文，UI 只显示"已固定"徽章，用户要点"刷新密码"重新生成一份明文。

**Q：踢掉一个设备后，它还能重连吗？**

能。`kick` 是 `ws.close()` 优雅关闭（ws-server.ts L105-110），只断连接、不吊销 token——被踢端仍持有效 HMAC token，重连（`?token=` 或 cookie）可再次通过鉴权。要彻底失效两条路：**刷新密码**（换 `passwordHash`，旧密码失效，但已签发的 token 仍在其 24h 有效期内，因为 token 不绑定密码）；**重启应用**（换 `serverSecret`，所有 HMAC token 全失效）。这个语义在 `kickHint` 文案与 controllers/remote.ts L104-106 注释里都明确提示了。

**Q：公网隧道为什么被移除？**

代码注释（controllers/remote.ts L2、renderer L3、auth.test.ts L32）一致写"公网隧道已移除（先只做本机与局域网）"。当前可达面只有 `127.0.0.1`（loopback）与 `0.0.0.0`（局域网，`bindFor` assemble.ts L650-651 决定）。公网暴露需要一套完全不同的安全模型（TLS 终止、更强的爆破防护、可能的 OAuth），在只做本机/局域网的前提下，现有的 scrypt 密码 + HMAC token + 失败限速 + loopback 信任已够用——把公网隧道砍掉是把安全面收敛到"局域网内可信边界"，而非"互联网不可信边界"。

**Q：远程浏览器连接时，`conn.host` 是什么？**

是 `Host` 的缺省降级实现。`Conn.host`（domain/remote.ts L59-68）是宿主能力面，本机 Electron 连接是完整实现（`electron-host`），远程浏览器连接是"缺省降级实现"（UNSUPPORTED_HOST/no-op）——因为远程浏览器没有原生窗口控制、对话框、系统通知等宿主能力。`attachWsServer` 构造 `Conn` 时把同一个 `host`（由 `assemble.ts` 传入，Electron 宿主是完整 Host）赋给所有连接，但远程连接的 handler 经 `conn.host` 调窗口/对话框能力时会得到降级行为（`host.ts` L7-8 注释、各 `HostXxx` 接口注释）。这是"能力探测/降级"而非"按内核身份分支"的体现。

**Q：删掉 remote-access 插件，远程访问还能用吗？**

远程访问的**机制**照常工作——HTTP/WS 服务器、鉴权、token、限速、设备管理全在壳后端，删掉插件只少了设置页这个 UI 入口，`remote.json` 里的既有配置（如已开启 + 固定密码）依然生效。但用户失去了开关/查看密码/看二维码/踢设备的能力，只能直接编辑 `remote.json` 或经其他自定义前端调 `remote:*` 通道。这正符合无特权差异纪律：内置壳插件可删、壳照常启动、只是少块功能（§7.1）。
