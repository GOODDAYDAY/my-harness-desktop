# web 服务化：去 IPC、纯前后端分离、Electron-free 后端

> 状态：终态设计（待落地）。本文描述把 my-harness-desktop 从「Electron 桌面壳」改造成「web 服务」的完整方案：渲染层零 Electron、前后端只走 HTTP/WebSocket、后端从 Electron 独立出来。远程访问不是外挂功能，而是这套架构的天然属性。

## 0. 一句话

把「renderer ↔ IPC ↔ main」这条唯一的通信缝，替换成「web 前端 ↔ HTTP/WebSocket ↔ Electron-free 后端」；`window.kernel` 从 contextBridge 桥变成 WebSocket 客户端；Electron 从宿主降级为可选宿主。目标：外部浏览器可直接 web 访问，后端可独立跑在用户自己的服务端上。

## 1. 目标与背景

### 1.1 核心目标

用户拍板：**后续外部可以直接 web 访问，并对接用户自己的服务端**。这意味着 my-harness-desktop 要能作为一个 web 服务被集成，而不是一个锁在桌面进程里的应用。

### 1.2 为什么必须 Electron-free

只要后端还锁在 `bootstrap/index.ts` 的 Electron 生命周期里，用户的服务端就只能「隔着 Electron 反代」——永远带着一个桌面壳。只有后端变成纯 Node HTTP 服务器，才能：

- 由用户服务端直接 `node` 部署；
- 或实现同一协议对接；
- 或反代。

三条路都通，前提是后端与 Electron 解耦。

### 1.3 远程访问为什么是免费属性

一旦前端是纯 web 客户端、后端是 HTTP/WS 服务器，「远程访问」就退化为「服务器 bind 0.0.0.0 + 鉴权」：本地 Electron 窗口和远程浏览器是**同一个服务器的两个同构客户端**，无需第二套 UI、第二套传输。

### 1.4 非目标

- 多用户/多沙箱：同一份后端、同一个激活会话，同屏同会话模型。
- 手机触控适配（先只做远程电脑浏览器）。
- 第三方插件的远程加载（v1 显式降级，见 §10）。

## 2. 现状

### 2.1 通信缝：window.kernel

renderer 与 main 之间只有一条缝：`window.kernel`。

- 类型：`KernelApi`，定义在 `packages/react/src/index.ts`（`declare global { interface Window { kernel: KernelApi } }`，约 :264）。
- 实现：`src/api/preload/preload.ts`（624 行对象字面量），`contextBridge.exposeInMainWorld("pi", pi)`。
- 消费：`src/api/renderer/**` 内 `window.kernel.*` 调用 84+ 处；壳插件经 `usePluginContext()` 间接消费同一对象。

### 2.2 通道名单源：ipc-channels

`src/api/preload/ipc-channels.ts` 的 `IPC` 常量树是通道名单源。请求通道走 `ipcMain.handle`/`ipcRenderer.invoke`，推送通道走 `webContents.send`/`ipcRenderer.on`。分组包括：`app`、`bus`、`config`、`configFile`、`dialog`、`kernelExtensions`、`fonts`、`fs`、`git`、`llm`、`i18n`、`kernel`、`misc`、`models`、`notification`、`piSettings`、`dshKernel`、`dshModels`、`dshSettings`、`kernelModels`、`kernelConfig`、`kernelLogos`、`plugin`、`plugins`、`prefs`、`refresh`、`restart`、`session`、`sessions`、`settings`、`skills`、`slots`、`themes`、`window`。

### 2.3 handler 层：api/ipc

`src/api/ipc/*.ts` 按能力域分文件：`appearance.ts`、`app-info.ts`、`broadcast.ts`、`slots-dialog.ts`、`bus.ts`、`extensions.ts`、`fs-git.ts`、`main-context.ts`、`notification.ts`、`window.ts`、`skills.ts`、`kernel.ts`、`config.ts`、`sessions.ts`、`plugins.ts`。它们接收 `MainContext`（`api/ipc/main-context.ts`），直接调 `sessionStore`/`modelCatalog`/`kernelManagers` 等。

### 2.4 应用编排层本来就是纯 Node

`SessionStore`、pi/dsh 内核适配器、fs、git、npm、models、i18n、插件加载器——**零 Electron import**。这是「后端能独立跑」的事实基础：要拆的只有传输层 + 少量宿主依赖。

### 2.5 六样 Electron 依赖

全仓真正 Electron 专属的只有 6 样（详见 §5）：

1. `app` 生命周期（`bootstrap/index.ts` 的 `app.whenReady`/`before-quit`/`quit`）；
2. `BrowserWindow`（含窗口控制，`api/ipc/window.ts`）；
3. `dialog`（`api/ipc/slots-dialog.ts`）；
4. `shell`（openFile/revealPath，`api/ipc/*` 的 `IPC.misc`）；
5. `notification`（`api/ipc/notification.ts`）；
6. `electron-store`（prefs 持久化）；`api/ipc/app-info.ts` 里的 electron/chrome 版本号同属此类。

### 2.6 插件加载机制

- 内置壳插件：`api/renderer/plugins-host.ts:4` 用 `import.meta.glob` 在**构建期**打进 renderer——web 构建天然自带，无需额外处理。
- 第三方插件：同文件 :51 用 `file://` 动态 import——浏览器不可用，是 §10 的降级点。

## 3. 终态架构

### 3.1 架构图

```
前端（React，纯 web 客户端，零 Electron API）
   │  fetch / WebSocket（唯一通道，无第二条）
   ▼
后端（纯 Node HTTP+WS API 服务器）—— SessionStore / 内核 / fs / git / models / i18n / 插件加载器
   │
   ▼
宿主（可插拔，注入「宿主能力」）：
   · Electron 宿主：起后端 + 开 BrowserWindow 指向 http://127.0.0.1:PORT（本地桌面）
   · 服务器宿主：直接跑 Node 后端，前端静态文件由任意 web 服务器/对象存储托管（对接用户服务端）
```

### 3.2 三角色

| 角色 | 是什么 | 不拥有 |
|---|---|---|
| 前端 | 纯 web 客户端（React） | 不 import Electron，只认 `window.kernel` |
| 后端 | 纯 Node HTTP+WS 服务器 | 不依赖 Electron，只依赖应用编排 + 宿主能力接口 |
| 宿主 | 运行时环境适配（Electron / Node 服务器） | 不含业务逻辑，只提供生命周期/窗口/对话框/通知等能力 |

### 3.3 对接契约

**HTTP/WS 协议 = 对接契约**。用户服务端三种对接方式：托管同一后端、实现同一协议、反代。三者皆可，因为协议是标准 HTTP/WS、且不依赖 Electron。

## 4. 去 IPC

### 4.1 channel 名即 wire 方法名

现存 `IPC` 通道常量树**语义不变**，只把传输从 Electron IPC 换成 WS。IPC 本来就是消息传递抽象，换的是下面的传输：

| 现状 | 终态 |
|---|---|
| `ipcMain.handle(channel, handler)` | `gateway.register(channel, handler)` |
| `ipcRenderer.invoke(channel, ...args)` | `wsTransport.invoke(channel, ...args)` |
| `webContents.send(channel, ...args)` | `gateway.broadcast(channel, ...args)` |
| `ipcRenderer.on(channel, cb)` | `wsTransport.on(channel, cb)` |

`handler(args, conn) => result`，其中 `conn` 携带每连接身份（本地/远程）、鉴权状态、宿主能力判定。

### 4.2 三原语 transport

```ts
interface RemoteTransport {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, cb: (...args: unknown[]) => void): () => void;   // 返回取消函数
  off(channel: string, cb: (...args: unknown[]) => void): void;
}
```

`buildKernel(transport): KernelApi` 只依赖这三个原语。原 preload.ts 里的特殊方法（`install(version, onProgress, onDone)`、`watch(cwd, onChanged)`、`onSettingsChanged` 等）都是 `invoke`/`on` 的薄封装，迁到 `buildKernel` 后逻辑不变，只是底层从 `ipcRenderer` 换成 `transport`。

### 4.3 buildKernel 与 KernelApi 拆分

`KernelApi` 拆两半：

- `CoreKernelApi`（可远程）：`config`/`prefs`/`themes`/`fonts`/`settings`/`slots`/`kernels`/`dshModels`/`dshSettings`/`kernelModels`/`kernelConfig`/`kernelLogos`/`piSettings`/`i18n`/`models`/`configFile`/`sessions`/`bus`/`fs`/`git`/`gitWrite`/`llm`/`skills`/`plugins`/`onSettingsChanged`/`onRefreshRequested`/`kernelExtensions`/`restart`。
- `HostKernelApi`（宿主原生）：`dialog`/`openFile`/`revealPath`/`notify`/`window`/`app.restart`/`platform`。
- `KernelApi = CoreKernelApi & HostKernelApi`（对外形状不变，壳插件零感知）。

### 4.4 renderer 启动引导

renderer 入口（`api/renderer/index.tsx`）启动链之前，加一段引导：

```ts
// 前端永远走 WS，无「宿主注入」；本地身份由页面 URL 的 ?lt=<token> 判定
const token = new URLSearchParams(location.search).get("lt") ?? undefined;
const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/rpc`);
window.kernel = buildKernel(wsTransport(ws), remoteHostKernel()) as KernelApi;
if (token) ws.send(JSON.stringify({ kind: "hello", token }));
```

本地 Electron 窗口同样加载 `http://127.0.0.1:PORT`、走 WS（**单一传输，无第二条**）；`window.kernel` 永远由 `wsTransport` 构建，不存在「宿主注入」——本地身份由「Electron 加载时在 URL 带一次性 local token（`?lt=<token>`）+ loopback 来源」判定（§8.3）。浏览器态自然走 WS。

### 4.5 消失的东西

`preload.ts`、`contextBridge`、`ipc-channels.ts`（迁为 wire 契约）、`api/ipc/*`（迁为 `api/http/*`）这层 IPC 传输全部消失。`MainContext` 保留但去 Electron 化（见 §5）。

## 5. 后端 Electron-free

### 5.1 宿主能力接口总览

宿主能力接口定义在 `bootstrap/host/`（或 `client/host/`），是**运行时环境能力**，不是内核能力、不进中立契约、不进 `core/domain`。组装期注入两种实现。

### 5.2 六样依赖逐一映射

| # | Electron 依赖 | 宿主能力接口 | Electron 实现 | 服务器宿主实现 |
|---|---|---|---|---|
| 1 | `app` 生命周期 | `HostLifecycle.{onReady,onBeforeQuit,quit}` | `app.whenReady`/`before-quit`/`quit` | Node 信号（SIGINT/SIGTERM → stopAll） |
| 2 | `BrowserWindow` + 窗口控制 | `HostWindow.{minimize,maximize,close,isMaximized,isFocused}` | `BrowserWindow` 实例方法 | 返回「不支持」 |
| 3 | `dialog` | `HostDialog.{openDirectory,openImages,openTextFile,saveTextFile,saveZip,openZip,writeImages}` | `dialog.showOpenDialog` 等 | 返回「不支持」 |
| 4 | `shell` | `HostShell.{openPath,openExternal,revealPath}` | `shell.openPath`/`openExternal`/`showItemInFolder` | 返回「不支持」 |
| 5 | `notification` | `HostNotify.show(opts)` | `new Notification(...).show()` | no-op（或第三方通知库） |
| 6 | `electron-store`（prefs） | 改用 `core/application/config` 的 JSON 文件原语 | 同左 | 同左（纯 JSON，天然可用） |

`api/ipc/app-info.ts` 的 `electron`/`chrome` 版本号在服务器宿主下返回 `null`，`node`/`name`/`version`/`platform` 照常（纯 Node 可得）。

### 5.3 宿主能力不进契约

宿主能力是「运行时环境」概念，与「内核能力」（`BaseBackend`）正交。两者都经依赖倒置注入，但前者是宿主边界、后者是内核边界。别把 `HostWindow` 塞进 `BaseBackend`，也别把 `dialog` 塞进中立契约。

### 5.4 组装期注入

`bootstrap/electron.ts` 注入 Electron 宿主能力，`bootstrap/server.ts` 注入缺省宿主能力。`MainContext`（去 Electron 后）持有应用编排依赖 + `Host` 接口，handler 经 `conn.host` 访问宿主能力。

## 6. 线协议（对接契约）

### 6.1 WS /rpc 消息

WebSocket 端点 `/rpc`，消息均为 JSON：

| 方向 | 消息 | 形状 |
|---|---|---|
| C→S | 请求 | `{ kind:"invoke", id:number, channel:string, args:unknown[] }` |
| S→C | 应答 | `{ kind:"result", id:number, ok:true, result:unknown }` / `{ kind:"result", id, ok:false, error:{ message } }` |
| S→C | 推送 | `{ kind:"push", channel:string, args:unknown[] }` |
| C→S | 鉴权 | `{ kind:"hello", token:string }` |
| S→C | 鉴权结果 | `{ kind:"hello", ok:true }` / `{ kind:"hello", ok:false, error }`（失败后关闭） |

### 6.2 HTTP 端点

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/` | 无会话 → 登录页；有会话 → 应用 |
| POST | `/login` `{password}` | 校验，签发 httpOnly 会话 cookie |
| POST | `/logout` | 注销会话 |
| GET | `/app`、`/assets/*` | 应用 + 静态资源 |
| GET | `/status.json` | 网关健康/状态 |

其余全部走 `/rpc` 的 channel（含 `remote:*` 控制面）。

### 6.3 channel 清单

channel 名沿用现有 `IPC` 常量树命名（如 `session:prompt`、`session:event`、`session:snapshot`、`session:answerQuestion`、`bus:event`、`restart:state`、`settings:changed`、`refresh:requested`、`plugins:changed`）。分组见 §2.2。这是一份**对接契约清单**，用户服务端按此 channel 清单对接，不加前缀、不改语义。

### 6.4 错误约定

- `ok:false` 时 `error.message` 为清晰中文/英文提示，不裸透内核错误（沿用现有「缺面转清晰错误」纪律）。
- 未鉴权的 `invoke`（除 `hello`）直接关闭连接。
- `unknown channel` 返回 `ok:false`，不静默。

## 7. 分层落位（洋葱）

### 7.1 core/domain

`core/domain/remote.ts`：线协议类型（`invoke/result/push/hello`）+ `RemoteStatus`。纯类型，零依赖。不 import electron/react/ws。

### 7.2 core/application

`core/application/remote/`：网关编排——channel→handler 分发表、鉴权状态机、失败限速、广播扇出。只依赖 domain + 注入的 `MainContext` 抽象（不含 Electron）。**不 import `ws`/`http`**（那是基础设施，见 §7.3）。

### 7.3 api/http

流入适配器落地：`node:http` 静态服务、`ws` 升级、route 注册。原 `api/ipc/*` 的 handler 逻辑改成 `gateway.register(channel, handler)`。这一层才碰 `ws`/`http` 包。

handler 是**薄转发**：只做 channel→业务映射 + 序列化 + **插件权限门控**（fs/git/llm/bus/bash 的 manifest `permissions` 校验，仍按 `pluginId` 首参 + manifest 判断，与客户端身份无关）；业务逻辑仍在 `core/application`（`SessionStore` 等）。远程 shell 客户端本身是 Core 面，不受插件权限门控影响。

### 7.4 api/renderer

前端（基本不动）+ 新增 `ws-transport.ts`（`buildKernel(wsTransport)` + 宿主能力探测）。

### 7.5 bootstrap

- `bootstrap/electron.ts`：Electron 宿主入口（起后端 + 开窗口 + 注入 Electron 宿主能力）。
- `bootstrap/server.ts`：服务器宿主入口（`node out/main/server.js`，无窗口，注入缺省宿主能力）。
- `bootstrap/context.ts`：`MainContext` 最终 home（组装期类型，去 Electron），`api/http/handlers` 只 import 它 + domain，不 import electron。
- `bootstrap/host/`：宿主能力接口 + 两种实现。

### 7.6 client / plugins 不动

内核/fs/git/npm 本就纯 Node；壳插件仍 import `@my-harness-desktop/contract` + `@my-harness-desktop/react`，经 `window.kernel` 消费，现在 `window.kernel` 是 WS 客户端。

## 8. 鉴权方案

### 8.1 凭据模型

8 位数字密码，分两套独立管理：

- **局域网密码**：默认开，可一键关闭；手动刷新或自定义固定。
- **公网密码**：强制开，每次开启自动换新；可自定义固定（自定义后不再自动换）。

密码以 hash 存数据根 `~/.my-harness-desktop/config/remote.json`，不落代码、不进日志。

### 8.2 认证流程

1. 前端登录页输入密码 → `POST /login {password}` → 后端校验（+ 限速）。
2. 校验通过 → 签发 httpOnly cookie，内含 HMAC 签名 token（含过期时间、客户端身份标记）。
3. 静态资源与 `/rpc` 请求携带 cookie；WS 升级时校验 cookie。
4. 无 cookie 场景（非浏览器客户端 / 服务端对接）→ WS 首帧 `hello{token}` 等价。
5. token 校验通过 → 连接标记 authenticated，后续 `invoke` 放行；失败 → `hello ok:false` + 关闭。

### 8.3 每连接身份与能力

连接分「本地客户端」与「远程客户端」，由 token 内的身份标记 + 来源判定：

- **本地客户端**：Electron 窗口加载时在 URL 带一次性 local token（`?lt=<token>`，loopback 来源），或本机浏览器经 loopback 登录。有宿主能力（window/dialog/shell/notification）。
- **远程客户端**：局域网/公网登录。无宿主能力，按 §10 显式降级。

身份决定 `conn.host` 能力面（能否控制窗口、能否弹原生对话框）。

### 8.4 限速

- 同 IP 5 错锁 60s；全局失败超阈值短暂全锁（防换 IP 分布式扫描）；输对清零。
- 作用于 `/login` 与 `hello` 两个入口，共用一个限速器。

### 8.5 每场景鉴权策略

| 场景 | 密码 | 轮换 | 客户端身份 | 宿主能力 |
|---|---|---|---|---|
| 本机 | 无（loopback 信任边界） | — | 本地 | 有 |
| 局域网他机 | 默认开，可关 | 手动刷新 / 自定义固定 | 远程 | 无 |
| 公网他机 | 强制 | 每次开启自动换新 / 自定义固定 | 远程 | 无 |

### 8.6 Origin 与网络绑定

- 默认只绑 `127.0.0.1`；局域网模式显式开启才绑 `0.0.0.0`；公网必须经隧道 + 密码 + 免责声明。
- 非本机来源的静态/WS 请求必须带有效会话；无会话的跨源请求拒绝。

## 9. 三种接入场景与对接方案

### 9.1 总览

| 场景 | 网络绑定 | 入口 URL | 传输 | 鉴权 | 前置条件 |
|---|---|---|---|---|---|
| 本机 | `127.0.0.1` | `http://127.0.0.1:PORT` | 明文 HTTP（loopback） | 本机信任 | 无 |
| 局域网他机 | `0.0.0.0` | `http://<lan-ip>:PORT` | 明文 HTTP（局域网） | 8 位密码 | 显式开启局域网访问 |
| 公网他机 | 经 cloudflared / 用户反代 | `https://<trycloudflare 或用户域名>` | TLS（隧道/网关终结） | 8 位密码强制 | cloudflared 隧道或用户网关 |

### 9.2 本机

- Electron 宿主起后端 + 开 BrowserWindow 指向 `http://127.0.0.1:PORT`；本机浏览器直接开同一 URL 等价。
- loopback = 信任边界，不暴露网络，无需密码。
- 本地窗口 URL 带一次性 local token → 判定本地 → 有宿主能力（标题栏可控制窗口、可弹原生对话框）。

### 9.3 局域网他机

1. 用户在设置页开启「局域网访问」→ 后端从 `127.0.0.1` 改绑 `0.0.0.0`。
2. `os.networkInterfaces()` 探测局域网 IPv4（排除 loopback/internal），固定端口 + 被占自适应，`qrcode` 出二维码。
3. 他机浏览器输 8 位局域网密码 → cookie → 接入。
4. 密码默认开；可关（关后局域网扫码直连，仅同网段设备可达）。

### 9.4 公网他机（两条路）

- **路 A：cloudflared 隧道**（桌面自托管，不依赖用户服务器）。`cloudflared tunnel --url http://localhost:PORT`，多镜像下载（清华优先）、从 stdout 解析 `https://*.trycloudflare.com`、启停/自动恢复。TLS 由 cloudflared 终结。密码强制 + 每次开启自动换新 + 免责声明。
- **路 B：用户自己的服务端网关**（对接契约）。后端跑在用户服务器，或用户反代到本机后端；TLS 由用户网关终结；鉴权可由用户网关叠加（SSO 等），后端仍保留密码作为底线。

### 9.5 对接用户服务端的三种形态

| 形态 | 做法 | 用户要做的 |
|---|---|---|
| 托管同一后端 | 用户服务器跑 `bootstrap/server.ts` | 部署 Node 后端 + 前端静态文件 |
| 反代本机后端 | 用户网关 → 本机 `http://127.0.0.1:PORT` | 配反代 + 证书 |
| 实现同一协议 | 用户自写后端实现 channel 契约 | 按 §6 线协议实现，前端只换 `ws` 指向 |

三种形态里，前端都无需改代码：静态文件任意托管，`ws://` 指向后端 `/rpc` 即可。

## 10. 宿主能力显式降级

### 10.1 降级表

| 能力 | 远程/服务器宿主行为 |
|---|---|
| `window.*` | 返回「不支持」；前端按能力探测隐藏标题栏 |
| `dialog.*` | 返回「不支持」；相关入口置灰 |
| `openFile` / `revealPath` | 返回「不支持」；置灰 |
| `app.restart` | 禁用 |
| `notify.show` | no-op（或宿主通知） |
| `platform` | 注入 `"browser"` / 服务器宿主报 `process.platform` |
| 第三方插件加载 | 跳过（`file://` import 浏览器不可用），设置页标注 |

### 10.2 能力探测

前端经一次 `hello` 应答或 `app.info` 拿到 `hostCapabilities`（`window/dialog/shell/notification` 的布尔面），据此显式置灰/隐藏，不静默、不伪造成功。

第三方插件加载的跳过由 `platform === "browser"`（或 `host.window` 缺失）判定，不靠 `file://` import 抛错的 try/catch 兜底——先判后跳，避免对每个第三方插件都走一次必然失败的 import。

## 11. 分阶段落地

### 11.1 阶段 1 传输重构

删 IPC，后端变 HTTP+WS 服务器，`window.kernel` 变 WS 客户端；Electron 暂作宿主。验收：本地桌面行为不变，但已走 HTTP/WS；`ipcMain`/`ipcRenderer`/`contextBridge` 生产代码归零。

### 11.2 阶段 2 Electron-free 化

6 样宿主能力抽接口，`bootstrap/server.ts` 可 `node` 独立跑、无窗口。验收：不装 Electron 也能起后端 + 服务前端。

### 11.3 阶段 3 远程/对接

bind 0.0.0.0 + 鉴权 + 二维码 + cloudflared 隧道 + 前端静态托管。验收：外部浏览器直连、用户服务端可反代/直连。

### 11.4 阶段边界

每个阶段交付物自身完整可用，不留半成品占位；阶段间不交叉（不做「先传输重构一半 + 顺便 Electron-free 一半」）。

## 12. 验收标准

### 12.1 零 IPC

`preload.ts`/`contextBridge`/`ipcMain`/`ipcRenderer` 生产代码归零；`window.kernel` 仅由 WS 客户端构建。

### 12.2 同语义

`session:prompt`/`session:event`/`session:snapshot`/`session:answerQuestion` 等原通道经 WS 走通，与桌面行为一致。

### 12.3 后端独立

`node out/main/server.js` 起后端，无 Electron 环境可服务前端、可连内核。

### 12.4 远程访问

另一台电脑打开 `http://<ip>:<port>` 输密码 → 同一前端、实时同步、可发消息/点审批。

### 12.5 安全

错 5 次锁 60s；公网必密码；隧道关闭旧 URL 失效。

### 12.6 无特权/无内核硬分支

远程/服务器链路只认 `KernelApi`/中立契约，不出现 `if (kernel === "pi")`。

## 13. 风险与边界

### 13.1 安全

安全边界从 Electron 隔离沙箱换成服务器鉴权。需把鉴权/限速/Origin 当一等公民，不能随手。

### 13.2 同屏同会话

本地与远程是同一 main、同一激活会话，无冲突仲裁（后写覆盖），与 dsh-pocket 同模型。

### 13.3 多客户端并发

事件全量推给所有已鉴权客户端，v1 不做每客户端订阅过滤。

### 13.4 第三方插件远程加载

v1 显式降级（见 §10），后续演进为 HTTP 服务插件模块。

### 13.5 性能

localhost WS 与 IPC 的延迟差异可接受（dsh web 即同模型）；事件量级下 WS 单连接足够。

### 13.6 文档同步

本变更落地后，`CLAUDE.md` §6.1/§8.1 关于 `api/ipc` 的描述需同步改为 HTTP/WS 形态。

## 14. 文件清单

### 14.1 新增

- `core/domain/remote.ts`（线协议类型）
- `core/application/remote/`（网关编排）
- `api/http/`（HTTP+WS 服务器落地 + channel handler 改造）
- `api/renderer/ws-transport.ts`（`buildKernel(wsTransport)` 的 renderer 侧构建）
- `bootstrap/host/`（宿主能力接口 + Electron/缺省实现）
- `bootstrap/server.ts`（服务器宿主入口）
- `src/plugins/system/remote-access/`（设置 UI：开关/密码/二维码/隧道）
- `docs/design/web-service-architecture.md`（本文）

### 14.2 改动

- `packages/react/src/index.ts`（`KernelApi` 拆 `CoreKernelApi`/`HostKernelApi`）
- `api/preload/preload.ts` → 抽 `buildKernel`（迁往 renderer 侧共享模块）
- `api/preload/ipc-channels.ts` → channel 清单迁为 wire 契约
- `api/ipc/*` → `api/http/*`（handler 逻辑保留，换注册方式）
- `bootstrap/index.ts` → 拆 `bootstrap/electron.ts`（宿主装配 + 起后端 + 开窗）
- `electron.vite.config.ts`（renderer 双入口/静态产物 + server 入口）
- `package.json`（+`ws`/`qrcode`/`@types/ws`/`@types/qrcode`；`ws@8.21.1` 已在 node_modules 但需列为直接依赖）

---

# 第二部分：详细规格

## 15. RemoteTransport 与 buildKernel 详细规格

### 15.1 三原语契约

`RemoteTransport` 是前端 `window.kernel` 与后端之间的唯一抽象，只有三个原语。所有 `KernelApi` 方法都在这三个原语之上表达，不引入第四个：

```ts
interface RemoteTransport {
  /** 发一个请求，等后端应答。channel 是 §18 清单里的名字，args 是位置参数。 */
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  /** 订阅一个推送 channel。返回取消函数（幂等，可重复调用）。 */
  on(channel: string, cb: (...args: unknown[]) => void): () => void;
  /** 取消订阅。cb 必须是 on 时传入的同一引用。 */
  off(channel: string, cb: (...args: unknown[]) => void): void;
}
```

### 15.2 两个实现

- `wsTransport(ws)`：`invoke` 构造 `{kind:"invoke", id, channel, args}` 发到 `/rpc`，按 `id` 配对 `{kind:"result"}`，resolve/reject；`on` 维护 `channel → cb[]` 表，收到 `{kind:"push"}` 按 channel 派发。
- `ipcTransport`（迁移期参考，终态删除）：原 `ipcRenderer.invoke`/`on` 的等价物，仅用于阶段 1 的逐步迁移对照，不进终态。

### 15.3 buildKernel 签名

```ts
function buildKernel(t: RemoteTransport, host: HostKernelApi): KernelApi;
```

`CoreKernelApi` 全部由 `t` 构建，`HostKernelApi` 由宿主注入（§20）。返回值是 `KernelApi = CoreKernelApi & HostKernelApi`。壳插件经 `usePluginContext()` 看到的是完整 `KernelApi`，不感知拆分。

### 15.4 特殊方法的迁移规则

preload.ts 里若干方法不是「invoke 一次」这么简单，迁到 `buildKernel` 时按以下规则逐一处理，逻辑不变、只换底层：

- **进度双通道**（`kernels.{pi,dsh}.install`、`kernelExtensions.install/uninstall`）：`invoke(channel)` 发起 + `on(progressChannel)` 收进度 + 完成事件收尾。`on/off` 的取消函数充当原 `removeListener`。
- **watch 型**（`skills.watch`）：`invoke(watchChannel)` 注册 + `on(changedChannel)` 收通知，取消函数里 `invoke(unwatchChannel)`。
- **订阅型**（`onEvent`/`onSnapshot`/`onQuestion`/`onKernelEvent`/`onMessage`/`onStateChange`/`onMaximizedChanged`/`onSystemChanged`/`onUnloaded`/`onPluginsChanged`/`onSettingsChanged`/`onRefreshRequested`）：纯 `on` 封装，返回 `off`。
- **纯值型**（`platform`）：非函数，由宿主注入（见 §20.8），不经 transport。

### 15.5 请求配对与超时

`wsTransport.invoke` 维护 `Map<id, {resolve, reject, timer}>`。应答 `ok:true` → resolve(result)；`ok:false` → reject(Error(error.message))。超时（默认 30s，可对 `session:prompt` 等长操作放宽）→ reject + 清理。`id` 用自增整数，跨连接唯一。

### 15.6 断线重连与状态一致性

WS 断开时：

1. `invoke` 全部 reject（`TransportError("disconnected")`）。
2. `on` 订阅保留，重连成功后重新 `hello` 鉴权。
3. 前端 stores（`session-store.ts` 等）收到断开 → 走现有「resync 拉基线 + 事件增量」路径，与现在 IPC 断线同语义；重连 `hello` 成功后触发一次 `session:sync`（拉基线），再续事件增量，避免断线期间的事件空洞。

重连由 `wsTransport` 内建指数退避（1s/2s/4s，上限 30s），不引入全局轮询。

## 16. KernelApi 全量成员拆分清单

### 16.1 归类总原则

- **Core**：语义与「本机/远程」无关，只经 transport 的 `invoke`/`on` 表达。全部进 `CoreKernelApi`。
- **Host**：依赖运行时环境（Electron/Node 服务器）的原生能力。全部进 `HostKernelApi`，由宿主注入。
- **半 Host**：`app.info()` 里 `name/version/platform/node` 是纯 Node 可得（Core），`electron/chrome/isPackaged` 是 Electron 专属（Host）。拆成 `app.info()` 返回两部分，Electron 宿主填全，服务器宿主把 electron/chrome 填 null、isPackaged 填 false。

### 16.2 全量清单

| 成员 | 方法 | 归类 | 远程/服务器宿主降级 |
|---|---|---|---|
| config | get/set/all/getScope | Core | 无 |
| prefs | get/set | Core | 无 |
| themes | list/build/onSystemChanged | Core | 无 |
| fonts | list | Core | 无 |
| settings | list | Core | 无 |
| slots | sidePanel/sidebar/mainView/titlebar/fileActions/fileIcons/messageActions/blockRenderers/codeBlockRenderers/sessionGroupings/composerPolicies/composerAttachments/composerActions/composerStats/settingsGroups | Core | 无 |
| kernels | pi{status/setCustomCliDir/toolgateAvailable/listVersions/install}、dsh{status/setCustomCliDir/listVersions/install} | Core | 无 |
| dshModels | get/set/removeProvider/renameProvider/getDefault/setDefault/test | Core | 无 |
| dshSettings | get/set | Core | 无 |
| kernelModels | pi/dsh：list/set/remove/rename/getDefault/setDefault/test/readConfig/saveConfig | Core | 无 |
| kernelConfig | pi/dsh：get/set/fields | Core | 无 |
| kernelLogos | get | Core | 无 |
| piSettings | get/set/schema | Core | 无 |
| i18n | resources/list/detect | Core | 无 |
| models | get/set/list/getFallbackModel | Core | 无 |
| configFile | get/set/getLayered/getProject/setProject/clearProject/append/readBinary/writeBinary | Core | 无 |
| sessions | 见 16.3 | Core | 无 |
| bus | status/send/sessionCreate/sessionAbort/channelMember/tapStart/tapStop/onMessage | Core | 无 |
| fs | listDir/removePath/readDirTree/readFile/readFileBase64/createFile/createDir/renamePath/copyPath | Core | 无 |
| git | status/fileDiff/fileContent/log | Core | 无 |
| gitWrite | commit/push | Core | 无 |
| llm | oneshot | Core | 无 |
| skills | list/getCapabilities/setEnabled/setModelInvocable/getBundled/setBundledEnabled/watch | Core | 无 |
| plugins | list/enable/disable/uninstall/reload/reportLoadFailed/install/onUnloaded/onPluginsChanged | Core | 无 |
| onSettingsChanged | — | Core | 无 |
| onRefreshRequested | — | Core | 无 |
| kernelExtensions | list/enable/disable/install/uninstall | Core | 无 |
| restart | pendingSessions/restart/restartAllIdle/onStateChange | Core | 无 |
| dialog | openDirectory/openImages/openTextFile/saveTextFile/writeImages/saveZip/openZip | Host | 返回「不支持」+ 入口置灰 |
| openFile | path | Host | 返回「不支持」+ 置灰 |
| revealPath | path | Host | 返回「不支持」+ 置灰 |
| notify | show | Host | no-op |
| window | minimize/toggleMaximize/close/isMaximized/isFocused/onMaximizedChanged | Host | 返回「不支持」+ 标题栏隐藏 |
| app | info/restart | 部分 Host（info 拆分，见 §20.6） | restart 禁用；info 的 electron/chrome 填 null |
| platform | 值 | Host | `"browser"` / `process.platform` |

### 16.3 sessions 成员细分

`sessions` 是最大的一个成员，逐条归 Core，无一 Host：

- 生命周期：start/stop/setContext/getSnapshot/sync/switchKernel/getCapabilities/openSession
- 目录/CRUD：list/projectStats/getTree/bookmark/resume/deleteBookmark/renameSession/updateHeader/deleteSessions/readToolConfig/copySession
- 消息：prompt/abort/steer/followUp/abortRetry/continue
- 模型：getModels/setModel/cycleModel/testModel/getThinkingLevels/setThinkingLevel/cycleThinkingLevel
- 树：fork/forkFromSession/clone/getForkMessages
- 维护：compact/setAutoCompaction/setAutoRetry/exportHtml/getLastAssistantText/getStats
- 队列：setSteeringMode/setFollowUpMode
- 工具：runBash/abortBash/listTools
- 事件订阅：onEvent/onKernelEvent/onQuestion/onSnapshot/answerQuestion

全部经 transport 表达，远程与本地语义一致（这是「同屏同会话」的落点）。

## 17. 线协议完整规格

### 17.1 消息封装

所有 WS 消息是单层 JSON 对象，以 `kind` 判别类型。除 `hello` 外，鉴权前的连接只允许 `hello` 一条消息，其余直接断开。

### 17.2 消息字段

| kind | 方向 | 字段 | 说明 |
|---|---|---|---|
| invoke | C→S | `id:number` `channel:string` `args:unknown[]` | 请求；`id` 由客户端单调递增 |
| result | S→C | `id:number` `ok:boolean` `result?:unknown` `error?:{code:string,message:string}` | 应答；`ok:true` 带 result，`ok:false` 带 error |
| push | S→C | `channel:string` `args:unknown[]` | 服务端主动推 |
| hello | C→S | `token:string` | 鉴权；无 cookie 场景的等价物 |
| hello | S→C | `ok:boolean` `error?:string` `host?:HostCapabilityFlags` | 鉴权结果；`host` 回传本连接的能力面 |

### 17.3 错误码

| code | 含义 |
|---|---|
| `AUTH_REQUIRED` | 未鉴权就发 invoke |
| `AUTH_FAILED` | 密码/token 错误 |
| `RATE_LIMITED` | 触发限速 |
| `UNKNOWN_CHANNEL` | channel 不在契约清单 |
| `UNSUPPORTED_HOST` | 宿主能力缺失（远程调用 window/dialog 等） |
| `KERNEL_ERROR` | 内核侧错误（透传 §6.4 的清晰错误，不裸透） |
| `TIMEOUT` | 后端处理超时 |
| `INTERNAL` | 未分类内部错误 |

### 17.4 连接生命周期状态机

```
[连接建立] → [未鉴权] --hello ok--> [已鉴权] --invoke/push--> [工作]
                 │ hello 失败 / 非法消息                │ 客户端断开 / 服务端关闭
                 ▼                                        ▼
              [关闭]                                  [关闭]
```

- 未鉴权状态只接受 `hello`，其余消息记日志 + 关闭。
- `hello` 限速与 `/login` 共用（§8.4）。
- 连接断开即回收 `conn`，其订阅的推送 sink 一并移除。

## 18. channel 全量清单（对接契约）

channel 名沿用现有 `IPC` 常量树，是用户服务端对接的**唯一契约清单**。方向标记：`I`=invoke（C→S 请求）、`P`=push（S→C 推送）。

### 18.1 应用与会话

| 组 | channels | 方向 |
|---|---|---|
| app | info、restart | I |
| session | start、stop、setContext、getSnapshot、sync、switchKernel、getCapabilities、open、prompt、abort、steer、followUp、abortRetry、continue、abortBash、runBash、setModel、cycleModel、testModel、setThinkingLevel、getThinkingLevels、cycleThinkingLevel、fork、forkFromSession、clone、getForkMessages、compact、setAutoCompaction、setAutoRetry、exportHtml、getLastAssistantText、getStats、setSteeringMode、setFollowUpMode、rename、updateHeader、delete、readToolConfig、listTools、answerQuestion、copySession、getModels | I |
| session | event、kernelEvent、question、snapshot | P |
| sessions | list、projectStats、getTree、bookmark、resume、deleteBookmark | I |
| restart | pendingSessions、restart、restartAllIdle | I |
| restart | state | P |

### 18.2 内核与模型

| 组 | channels | 方向 |
|---|---|---|
| kernel | status、setCustomCliDir、listVersions、install、toolgateAvailable | I |
| kernel | install-progress、install-done | P |
| dshKernel | status、setCustomCliDir、listVersions、install | I |
| kernelModels | list、set、remove、rename、getDefault、setDefault、test、readConfig、saveConfig | I |
| kernelConfig | get、set、fields | I |
| kernelLogos | get | I |
| dshModels | get、set、removeProvider、renameProvider、getDefault、setDefault、test | I |
| dshSettings | get、set | I |
| piSettings | get、set、schema | I |
| models | get、set、list、getFallbackModel | I |

### 18.3 配置 / 主题 / i18n / 槽位

| 组 | channels | 方向 |
|---|---|---|
| config | all、get、getScope、set | I |
| configFile | get、set、getLayered、getProject、setProject、clearProject、append、readBinary、writeBinary | I |
| prefs | get、set | I |
| themes | list、build | I |
| themes | systemChanged | P |
| fonts | list | I |
| i18n | resources、list、detect | I |
| settings | list | I |
| settings | changed | P |
| slots | sidebar、sidePanel、mainView、titlebar、fileActions、fileIcons、messageActions、blockRenderers、codeBlockRenderers、sessionGroupings、composerPolicies、composerAttachments、composerActions、composerStats、settingsGroups | I |
| refresh | requested | P |

### 18.4 插件 / 技能 / 扩展 / 总线

| 组 | channels | 方向 |
|---|---|---|
| plugins | list、enable、disable、uninstall、reload、install、loadFailed | I |
| plugins | changed | P |
| plugin | unloaded | P |
| skills | list、getCapabilities、setEnabled、setModelInvocable、getBundled、setBundledEnabled、watch、unwatch | I |
| skills | changed | P |
| kernelExtensions | list、enable、disable、install、uninstall | I |
| kernelExtensions | install-progress | P |
| bus | status、send、sessionCreate、sessionAbort、channelMember、tapStart、tapStop | I |
| bus | event | P |

### 18.5 文件 / Git / LLM / 宿主

| 组 | channels | 方向 |
|---|---|---|
| fs | listDir、readDirTree、readFile、readFileBase64、createFile、createDir、renamePath、copyPath、removePath | I |
| git | status、fileDiff、fileContent、log、commit、push | I |
| llm | oneshot | I |
| dialog | openDirectory、openImages、openTextFile、saveTextFile、writeImages、saveZip、openZip | I（Host） |
| misc | openFile、revealPath | I（Host） |
| notification | show | I（Host） |
| window | minimize、toggleMaximize、close、isMaximized、isFocused | I（Host） |
| window | maximizedChanged | P（Host） |

### 18.6 远程控制面（新增）

| 组 | channels | 方向 |
|---|---|---|
| remote | status、start、stop、setPassword、refreshPassword、setLanPasswordEnabled、tunnelStart、tunnelStop、qr | I |
| remote | stateChanged | P |

## 19. 网关内部设计

### 19.1 dispatch 分发表

`gateway.register(channel, handler)` 把 channel 绑到 handler。handler 签名 `(args: unknown[], conn: Conn) => Promise<unknown> | unknown`。`conn` 提供：

```ts
interface Conn {
  id: string;                    // 连接唯一 id
  kind: "local" | "remote";      // 客户端身份（§8.3）
  host: Host;                    // 宿主能力（§20），remote 连接为缺省实现
  authenticated: boolean;
}
```

原 `api/ipc/*` 的 handler 逻辑搬进 `api/http/handlers/*`，只把 `ipcMain.handle(channel, ...)` 换成 `gateway.register(channel, ...)`，业务体不变。

### 19.2 鉴权状态机

- 连接建立即「未鉴权」，可收 `hello`。
- `hello` 校验 token（HMAC 签名 + 过期 + 身份标记），通过 → 标记 authenticated + 下发 `host` 能力面 + 把连接加进广播 sink。
- 未鉴权发 `invoke` → 回 `AUTH_REQUIRED` + 关闭。

### 19.3 失败限速器

单例，作用于 `/login` 与 `hello`：同 IP 连续 5 错 → 锁 60s；全局失败超阈值 → 短暂全锁；成功清零。按 IP 存内存 Map，不落盘。

### 19.4 广播 sink

`gateway.broadcast(channel, ...args)` 对每个已鉴权连接发 `{kind:"push", channel, args}`。原 bootstrap 里所有 `for (const w of BrowserWindow.getAllWindows()) w.webContents.send(...)` 收敛为对 `gateway.broadcast` 的调用——Electron 本地窗口也是一个已鉴权连接（本地客户端），所以本地/远程天然同路。

### 19.5 连接生命周期

建立 → 鉴权 → 工作 → 断开回收。断开时移除其 sink、reject 其未完成的 invoke。多连接并发同一会话无仲裁（§13.2）。

## 20. 宿主能力接口详细规格

### 20.1 HostLifecycle

```ts
interface HostLifecycle {
  onReady(cb: () => void): void;
  onBeforeQuit(cb: (e: { preventDefault(): void }) => void): void;
  quit(): void;
}
```

Electron：`app.whenReady`/`app.on("before-quit")`/`app.quit`。服务器：`onReady` 立即触发，`onBeforeQuit` 绑 `SIGINT/SIGTERM`，`quit` 调 `process.exit`。

### 20.2 HostWindow

```ts
interface HostWindow {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  isMaximized(): Promise<boolean>;
  isFocused(): Promise<boolean>;
  onMaximizedChanged(cb: (m: boolean) => void): () => void;
}
```

Electron：`BrowserWindow` 实例方法。服务器：全部 reject `UNSUPPORTED_HOST`，`onMaximizedChanged` 返回 no-op 取消函数。

### 20.3 HostDialog

```ts
interface HostDialog {
  openDirectory(): Promise<string | null>;
  openImages(): Promise<{name:string; data:string; mimeType:string}[]>;
  openTextFile(opts?: {filters?: {name:string; extensions:string[]}[]}): Promise<{name:string; content:string} | null>;
  saveTextFile(opts: {...}): Promise<string | null>;
  writeImages(dir: string, images: {name:string; base64:string}[]): Promise<number>;
  saveZip(opts: {...}): Promise<string | null>;
  openZip(opts?: {...}): Promise<{name:string; files:{name:string; base64:string}[]} | null>;
}
```

Electron：`dialog.showOpenDialog`/`showSaveDialog` + 文件读写。服务器：全部 reject `UNSUPPORTED_HOST`。

### 20.4 HostShell

```ts
interface HostShell {
  openPath(path: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  revealPath(path: string): Promise<void>;
}
```

Electron：`shell.openPath`/`openExternal`/`showItemInFolder`。服务器：reject `UNSUPPORTED_HOST`。

### 20.5 HostNotify

```ts
interface HostNotify { show(opts: {title:string; body:string; silent?:boolean}): Promise<void>; }
```

Electron：`new Notification(...).show()`。服务器：no-op（可选接第三方通知库，v1 不做）。

### 20.6 HostApp

```ts
interface HostApp {
  info(): Promise<AppInfo>;       // name/version/platform/node 纯 Node；electron/chrome/isPackaged 由宿主填
  restart(): Promise<void>;       // 服务器宿主 reject UNSUPPORTED_HOST
}
```

### 20.7 HostPlatform

`platform: string` 常量。Electron 宿主 = `process.platform`；远程浏览器由前端自判 `"browser"`；服务器宿主 = `process.platform`。

### 20.8 Host 聚合与注入

`Host` = 上述接口的聚合，`bootstrap/electron.ts` 与 `bootstrap/server.ts` 各造一份注入 `MainContext`。handler 经 `conn.host` 访问；`HostKernelApi` 由 `buildKernel(t, hostKernel)` 的第二参注入。

## 21. 构建系统改造与产物布局

### 21.1 现状

electron-vite 三端构建：`main`（`bootstrap/index.ts` → `out/main`）、`preload`（`preload.ts` → `out/preload`）、`renderer`（`index.html` → `out/renderer`）。

### 21.2 终态三产物

| 产物 | 入口 | 输出 | 运行方式 |
|---|---|---|---|
| 后端（共享） | `bootstrap/assemble.ts`（组装 MainContext + 起服务器） | 被两个宿主入口 import | 无独立运行 |
| Electron 宿主 | `bootstrap/electron.ts` | `out/main/index.cjs` | `electron .` |
| 服务器宿主 | `bootstrap/server.ts` | `out/server/index.cjs` | `node out/server/index.cjs` |
| 前端静态 | `api/renderer/index.html` | `out/renderer/` | 由后端 HTTP 服务 |

`preload` 产物删除。renderer 不区分「Electron 版 / web 版」——同一份 `out/renderer`，Electron 窗口和远程浏览器都加载它，差异只在前端运行时探测 `window.kernel` 是否已注入（§4.4）。

### 21.3 后端组装模块

`bootstrap/assemble.ts` 是纯函数式组装：读路径/配置 → 建 `SessionStore`/`ModelCatalog`/内核 manager/插件 registry → 拼 `MainContext` → 起 HTTP+WS 服务器 → 返回 `{ server, ctx }`。Electron 宿主与服务器宿主都调它，差异只在「之后干什么」：Electron 开窗口，服务器挂信号处理。**硬约束：`assemble.ts` 不 import `electron`**——这是后端 Electron-free 的物理保证。

### 21.4 静态托管

- 开发态：electron-vite dev 起 Vite，后端把 `/` 反代到 Vite dev server（或前端直连 Vite，WS 直连后端 `/rpc`）。
- 打包态：`out/renderer` 随 Electron 分发改名 `out/renderer` 之外的 asar 内路径，或随服务器宿主分发；后端 HTTP 静态根指向它。
- 服务器宿主部署：`out/renderer` 可交给任意静态服务器/CDN，前端 `ws://<backend-host>/rpc` 由构建期或运行时配置指定。

### 21.5 package.json 与依赖

- `ws`、`qrcode` 列为 dependencies；`@types/ws`、`@types/qrcode` 为 devDependencies。
- `electron`、`electron-builder`、`electron-store` 从「运行依赖」降级为「Electron 宿主专属」——服务器宿主不 import 它们（§5），故可做可选依赖或拆 `bootstrap/host/electron` 单独按需加载。

## 22. 数据流与时序

### 22.1 冷启动（Electron 宿主）

```
app.whenReady
  → assemble() 建 MainContext + 起 HTTP/WS 服务器（绑 127.0.0.1:PORT）
  → createWindow() 开 BrowserWindow → loadURL("http://127.0.0.1:PORT")
  → 前端加载 index.html → 建 WS 连接 → hello（带 local token）→ await 就绪
  → buildKernel → hydrateFromPrefs → initI18n → plugins-host → initSessionStore → render
```

### 22.2 冷启动（服务器宿主）

```
node out/server/index.cjs
  → assemble() 建 MainContext + 起 HTTP/WS 服务器（绑配置的 host:port）
  → 挂 SIGINT/SIGTERM → stopAll + 关服务器
  → 无窗口；前端由外部静态服务器加载，WS 指向本后端 /rpc
```

### 22.3 发送消息

```
前端 prompt(text) → window.kernel.sessions.prompt → wsTransport.invoke("session:prompt", text)
  → 后端 gateway.dispatch → sessionStore.prompt → 内核 sendMessage
  → 内核事件流 → sessionStore.onEvent → gateway.broadcast("session:event", e)
  → 所有已鉴权连接收到 {kind:"push", channel:"session:event", args:[e]}
  → 前端 stores 增量应用事件 → 时间线滚动
```

### 22.4 鉴权（远程）

```
远程浏览器 GET / → 无 cookie → 登录页
  → 输密码 POST /login → 校验 + 限速 → Set-Cookie: session=<HMAC token>
  → 前端建 WS /rpc → 升级时校验 cookie → hello 回 host 能力面（remote，无宿主能力）
  → invoke/push 全通
```

### 22.5 局域网接入

```
用户在设置页开启局域网 → remote:start 绑定 0.0.0.0
  → 后端探测局域网 IPv4 → remote:qr 出二维码
  → 他机扫码/输入 http://<lan-ip>:PORT → 走 §22.4 鉴权
```

### 22.6 公网隧道接入

```
用户点「开启公网」→ 勾免责声明 → remote:tunnelStart
  → 下载 cloudflared（镜像优先）→ spawn "cloudflared tunnel --url http://127.0.0.1:PORT"
  → 解析 stdout 的 https://*.trycloudflare.com → remote:stateChanged 推公网 URL
  → 公网密码自动换新 → 二维码
  → 外部手机/他机打开公网 URL → TLS 由 cloudflared 终结 → 走 §22.4 鉴权（密码强制）
```

## 23. 阶段迁移文件级清单

### 23.1 阶段 1：传输重构

| 动作 | 文件 |
|---|---|
| 新增 | `core/domain/remote.ts`（线协议类型） |
| 新增 | `core/application/remote/gateway.ts`（dispatch/鉴权/限速/广播） |
| 新增 | `core/application/remote/wire.ts`（invoke/push 序列化） |
| 新增 | `api/http/http-server.ts`（静态 + 登录 + status 路由） |
| 新增 | `api/http/ws-server.ts`（/rpc 升级 + 帧解析） |
| 新增 | `api/renderer/ws-transport.ts`（`buildKernel` + `wsTransport`） |
| 新增 | `api/http/handlers/*`（原 `api/ipc/*` 的 handler 逻辑搬迁） |
| 改 | `packages/react/src/index.ts`（`KernelApi` 拆 `CoreKernelApi`/`HostKernelApi`） |
| 改 | `api/preload/preload.ts` → 抽 `buildKernel`（迁 renderer 侧） |
| 改 | `bootstrap/index.ts` → 起服务器 + `gateway.broadcast` 替换 `webContents.send` 循环 |
| 删 | `api/preload/ipc-channels.ts` → channel 清单迁 `core/domain/remote.ts` 或独立 `channel-contract.ts` |
| 改 | `electron.vite.config.ts`（renderer 单入口、删 preload） |

验收：`ipcMain`/`ipcRenderer`/`contextBridge` 生产代码归零；本地桌面走 HTTP/WS 行为不变。

### 23.2 阶段 2：Electron-free 化

| 动作 | 文件 |
|---|---|
| 新增 | `bootstrap/host/types.ts`（Host 聚合接口） |
| 新增 | `bootstrap/host/electron-host.ts`（Electron 实现） |
| 新增 | `bootstrap/host/node-host.ts`（服务器实现） |
| 新增 | `bootstrap/assemble.ts`（共享组装） |
| 新增 | `bootstrap/server.ts`（服务器入口） |
| 改 | `bootstrap/electron.ts`（Electron 入口，调 assemble + 开窗） |
| 改 | `api/ipc/main-context.ts` → 去 Electron（prefs 改 JSON 文件原语） |
| 改 | `api/ipc/app-info.ts`/`window.ts`/`slots-dialog.ts`/`notification.ts` → 经 `conn.host` |
| 改 | `package.json`（electron 依赖降级为宿主专属） |

验收：`node out/server/index.cjs` 无 Electron 环境可起后端、可服务前端、可连内核。

### 23.3 阶段 3：远程/对接

| 动作 | 文件 |
|---|---|
| 新增 | `api/http/handlers/remote.ts`（`remote:*` handler） |
| 新增 | `client/remote/lan-ip.ts`（局域网 IP 探测） |
| 新增 | `client/remote/qr.ts`（qrcode） |
| 新增 | `client/remote/cloudflared.ts`（下载/spawn/解析 URL/生命周期） |
| 新增 | `src/plugins/system/remote-access/`（设置 UI） |
| 改 | `bootstrap/assemble.ts`（装配 remote 服务 + 鉴权/限速） |

验收：外部浏览器直连、用户服务端可反代/直连、公网隧道可用。

## 24. 测试策略

### 24.1 单元测试（纯函数，无 mock 外部环境）

| 对象 | 测什么 |
|---|---|
| `wsTransport` | invoke 配对/超时/断线 reject；on/off 订阅派发；重连后重新 hello |
| `buildKernel` | 每个 Core 方法正确映射到对应 channel 与 args 顺序；特殊方法（install/watch/订阅型）的封装修为 |
| 线协议序列化 | invoke/result/push/hello 的字段完整性与错误码 |
| 网关 dispatch | 未知 channel 报 UNKNOWN_CHANNEL；未鉴权报 AUTH_REQUIRED |
| 限速器 | 5 错锁 60s、成功清零、全局阈值 |
| 鉴权 | HMAC token 签名/过期/身份标记、篡改拒绝 |

### 24.2 集成测试（起真实服务器 + 假内核）

- 起 `assemble()`（服务器宿主）→ 连 WS → `hello` → 走 `session:prompt`/`session:event` 全链路，断言事件 push 到达。
- 用假 `BackendFactory`（内存内核）验证 pi/dsh 两路同语义。
- 验证 `gateway.broadcast` 同时到达本地 + 远程两个连接。

### 24.3 端到端测试（Playwright）

- 本地：Electron 窗口加载 → 发消息 → 时间线滚动（回归现有 e2e，替换 `window.kernel` 实现后不破）。
- 远程：起服务器宿主 → Playwright 用另一 origin 打开 → 登录 → 同屏实时同步。
- 局域网/公网：mock `lan-ip`/`cloudflared` 验证 URL 与二维码产出、隧道生命周期。

### 24.4 安全测试

- 未鉴权访问 `/` 只出登录页；未鉴权 WS 首帧 invoke 被拒。
- 错 5 次锁 60s；换 IP 仍受全局阈值。
- 远程连接调用 `window.minimize` 等 → 回 UNSUPPORTED_HOST，前端置灰。
- token 过期/篡改 → 拒绝。

## 25. 威胁模型与安全分析

### 25.1 资产

- 能执行宿主机代码的内核（pi/dsh 子进程）——最高价值。
- 会话数据（代码、提示词、工具输出）。
- 凭证（API key、公网/局域网密码）。

### 25.2 威胁与对策

| 威胁 | 对策 |
|---|---|
| 局域网内他人扫描端口直连 | 默认绑 loopback；局域网显式开启 + 密码默认开 |
| 公网暴力破解密码 | 8 位密码 + 5 错锁 60s + 全局阈值 + 每次开启换新 |
| 中间人窃听（局域网明文） | 公网走 TLS（隧道/用户网关）；局域网明文是已知取舍（同 dsh-pocket），公网必 TLS |
| 越权控制宿主（远程弹对话框/关窗口） | 每连接身份 + Host 能力面，远程无宿主能力 |
| cookie/token 泄露 | httpOnly + 签名 + 过期 + 后端重启失效 |
| 未鉴权读静态资源 | `/app`、`/assets` 也校验 cookie（登录页除外） |
| 内核错误裸透（探测内网/路径） | 错误码收敛，KERNEL_ERROR 不透原始栈 |

### 25.3 明确接受的风险

- 局域网明文传输（无 TLS）：与 dsh-pocket 同模型，靠「同网段 + 密码」。
- 同屏同会话无仲裁：后写覆盖。
- 单因子（密码）无二次验证：个人自用定位，不做 TOTP。

## 26. 备选方案对比与已否决方案

### 26.1 保留 IPC + 叠加 WS（已否决）

原方案：`window.kernel` 双实现（IPC + WS），远程走 WS、本地走 IPC。否决理由：双传输、双 `buildKernel`、两套降级逻辑、广播要扇到「窗口 + WS 客户端」两类 sink，复杂度高；且后端仍锁 Electron，无法对接用户服务端。

### 26.2 屏幕镜像（已否决）

VNC/WebRTC 桌面串流。否决理由：延迟高、无触控/语义适配、安全模型差、无法「对接服务端」，是错误工具。

### 26.3 复用 dsh web UI（已否决）

起 `dsh --profile web` + 装 dsh-pocket 代理。否决理由：手机看到的是 dsh 官方界面，不是本壳界面；且是另一套 dsh 运行时，与壳的会话模型不通；无法覆盖 pi 内核。

### 26.4 REST 全量替代 WS（部分否决）

把 180 通道全做成 REST 端点。否决理由：push 型通道（session:event 等）用 REST 只能轮询或 SSE，违背「事件驱动不轮询」；WS 单连接 + channel 命名正好 1:1 映射现有 IPC 模型。采纳折中：WS 承载 invoke/push，HTTP 只承载静态/登录/状态。

## 27. 开放问题与决策记录

| # | 问题 | 现状/决策 | 状态 |
|---|---|---|---|
| 1 | 局域网是否默认开 TLS | 否（同 dsh-pocket，靠密码） | 已定 |
| 2 | 服务器宿主是否需要独立发布物 | 是，`out/server` 单文件 | 已定 |
| 3 | 第三方插件远程加载 | v1 跳过，演进 HTTP 服务插件模块 | 已定 |
| 4 | 多客户端并发会话仲裁 | v1 无仲裁，后写覆盖 | 已定 |
| 5 | prefs 迁移：electron-store → JSON 文件 | 阶段 2 一次性迁移，读旧 store 写新 JSON | 待落地 |
| 6 | 前端 ws 指向（服务器宿主跨域） | 构建期注入 `VITE_WS_URL` 或运行时 `window.__WS_URL__` | 待定 |
| 7 | 登录页归属（壳内置 vs 插件） | 壳内置（机制层，`api/http` 服务一个极简登录页） | 已定 |

## 28. 可观测性与运维

### 28.1 日志

- 后端起停、连接建立/断开、鉴权失败（带 IP）、隧道起停、限速触发——结构化日志，不落密码。
- 保留现有内核 stderr 调试串（`PiCapabilities.stderr`）。

### 28.2 状态面

`remote:status` 返回：`{ running, bound, lanUrl, publicUrl, port, lanPasswordEnabled, tunnelRunning, clients }`。`remote:stateChanged` 推变化。设置页据此渲染，不轮询。

### 28.3 优雅退出

- Electron：`before-quit` → stopAll（内核子进程 stdin→SIGTERM→SIGKILL）→ 关服务器 → 关窗口。
- 服务器：SIGINT/SIGTERM → stopAll → 关服务器 → exit。

## 29. 迁移顺序与回滚

### 29.1 顺序

严格按阶段 1 → 2 → 3，每阶段独立 commit、独立验收、可独立回滚。阶段间不交叉。

### 29.2 回滚

- 阶段 1：单 commit 回滚即恢复 IPC（preload/ipc-channels/api-ipc 在该 commit 前仍在 git 历史里）。
- 阶段 2：回滚即回到「Electron 宿主 + WS 传输」的可用态（阶段 1 终态）。
- 阶段 3：回滚即回到「无远程/无隧道」的可用态（阶段 2 终态）。

### 29.3 灰度

- 先只启用本机（loopback）验证阶段 1，行为对齐后再放局域网（阶段 3 前半）。
- 公网隧道最后开，且默认关。

## 30. 多内核不变量在 web 形态下的保持

去 IPC 只换传输，不改变内核无关的三条不变量（§7.5 的表述仍成立）：

### 30.1 壳不读任何内核的存储

`session:*`/`sessions:*` channel 的 handler 仍只经 `SessionStore`/`SessionCatalog` 走中立契约；存储格式（pi JSONL、dsh session forest）退在内核适配器。远程链路不新增任何「按内核拼路径」的分支。

### 30.2 壳只认中性事件

`session:event` 推送的仍是 `SessionEvent`（中性联合），由各内核适配器翻译投喂。远程浏览器与本地窗口收到的是同一份中性事件，不因来源不同而变形。

### 30.3 渲染是纯函数

前端只认 `window.kernel`，不认内核身份。远程/本地不引入 `if (kernel === "pi")` 于会话意图链路。内核差异仍由适配器在事件层抹平。

### 30.4 新增能力的门槛

远程网关本身不进中立契约（它不是内核能力，是壳的流入适配器）。新增任何 `remote:*` 或新 channel 前仍过「壳是否必须向每一个内核索要它」这一问——答案是否定的，所以它不进 `BaseBackend`，留在 `api/http` 与 `core/application/remote`。

## 31. 前端影响面盘点

### 31.1 统计

renderer 侧 `window.kernel.*` 调用 84+ 处，分布在 `api/renderer/`（`i18n-init.ts`、`plugins-host.ts`、`layout-store.ts`、`session-store.ts`、`ui-store.ts`、`general-config.ts`、`kernel-logos.ts`）与 `plugin-context.ts`（壳插件经此间接调用）。

### 31.2 归类

- **Core（不改）**：sessions/config/prefs/themes/models/i18n/slots/plugins/skills/fs/git/kernelExtensions/restart 等——占绝大多数。`window.kernel` 对象换成 WS 客户端后，这些调用点**零改动**。
- **Host（需降级）**：`titlebar` 的 `window.minimize/toggleMaximize/close`、设置/项目里的 `dialog.*`、`openFile`/`revealPath`、`notify.show`、`app.restart`。这些调用点包一层「能力探测」，远程/服务器宿主下隐藏或置灰（§10）。
- **边界（platform）**：`titlebar` 的自绘按钮依赖 `platform`，远程下 `platform="browser"` → 标题栏不渲染。

### 31.3 结论

传输重构对前端是「换 `window.kernel` 的底层实现」，不是「改调用点」。前端改动集中在：新增 `ws-transport.ts`、标题栏/对话框等宿主能力的降级分支、`index.tsx` 启动引导。时间线/会话流/模型/配置/主题/插件宿主等主体零改动。

## 32. 关键实现骨架

### 32.1 wsTransport.invoke

```ts
function wsTransport(ws: WebSocket): RemoteTransport {
  let seq = 0;
  const pending = new Map<number, {resolve: (v: unknown) => void; reject: (e: Error) => void}>();
  const subs = new Map<string, Set<(...a: unknown[]) => void>>();

  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.kind === "result") {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      m.ok ? p.resolve(m.result) : p.reject(new Error(m.error?.message ?? "remote error"));
    } else if (m.kind === "push") {
      subs.get(m.channel)?.forEach((cb) => cb(...(m.args ?? [])));
    }
  });

  return {
    invoke(channel, ...args) {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ kind: "invoke", id, channel, args }));
      });
    },
    on(channel, cb) {
      (subs.get(channel) ?? subs.set(channel, new Set()).get(channel)!).add(cb);
      return () => subs.get(channel)?.delete(cb);
    },
    off(channel, cb) { subs.get(channel)?.delete(cb); },
  };
}
```

### 32.2 gateway.dispatch

```ts
async function dispatch(conn: Conn, id: number, channel: string, args: unknown[]): Promise<void> {
  if (!conn.authenticated) return reply(id, { ok: false, error: { code: "AUTH_REQUIRED" } });
  const handler = handlers.get(channel);
  if (!handler) return reply(id, { ok: false, error: { code: "UNKNOWN_CHANNEL" } });
  try {
    const result = await handler(args, conn);
    reply(id, { ok: true, result });
  } catch (e) {
    reply(id, { ok: false, error: { code: codeOf(e), message: messageOf(e) } });
  }
}
```

### 32.3 鉴权校验

```ts
function verifyToken(token: string): { kind: "local" | "remote" } | null {
  // 校验 HMAC 签名 + 过期 + 身份标记；失败返回 null
  const payload = hmacVerify(token);
  return payload ? { kind: payload.kind } : null;
}
```

## 33. 与既有设计文档/代码的关系

### 33.1 需同步修改的文档

- `CLAUDE.md` §6.1 物理目录分区：`api/ipc` → `api/http`、`api/preload` 删除。
- `CLAUDE.md` §8.1：`window.kernel` 经 contextBridge 的表述 → 经 WS 客户端。
- `DESIGN.md` / `docs/DESIGN.md`：如有 IPC 传输描述，同步为 HTTP/WS。

### 33.2 不需改的文档

- 中立契约相关（`base-interface-lineage.md`、`kernel-design-spec.md`、`session-neutral-layer.md` 等）：它们描述内核契约与中性域，与传输无关，**一行不改**。
- 插件机制（`plugin-decoupling.md`、`plugin-event-flow.md` 等）：壳插件仍 import contract/react、经 `usePluginContext()` 消费，插件侧零改动。

### 33.3 纪律保持

本变更是「换传输」，不触碰「依赖只向内」「机制与内容分离」「多内核默认」「无特权差异」任何一条。设计文档单独一份（本文），是后续实现的真相源。

## 34. 术语表

| 术语 | 含义 |
|---|---|
| 前端 | 纯 web 客户端（React renderer + 壳插件），零 Electron API |
| 后端 | 纯 Node HTTP+WS API 服务器，Electron-free |
| 宿主 | 运行时环境适配（Electron / Node 服务器），注入宿主能力 |
| 宿主能力 | 依赖运行时的原生能力：生命周期/窗口/对话框/通知/外壳/shell |
| 线协议 | `/rpc` 上的 invoke/result/push/hello JSON 消息契约 |
| channel | 线协议的「方法名/事件名」，沿用原 IPC 通道名 |
| 对接契约 | 用户服务端与后端交互的 HTTP+WS 协议（§6/§18） |
| 本地客户端 | loopback 来源、注入 local token、有宿主能力的连接 |
| 远程客户端 | 局域网/公网登录、无宿主能力的连接 |

## 35. 性能与并发指标

### 35.1 目标

- 本机 loopback 场景：单条 invoke 往返 p50 < 2ms（原 IPC 同量级），事件 push 延迟 < 5ms。
- 局域网：带宽足够时，事件流吞吐与本地一致，不因序列化劣化（事件本身已是 JSON）。
- 并发：单后端支撑 ≥ 16 个并发连接（本地 + 远程 + 服务端对接），事件广播对连接数 O(n)，无每连接事件排队放大。

### 35.2 约束

- 单会话单内核进程模型不变（§2.4），远程连接不额外 spawn 进程。
- 事件全量推送（§13.3），不做每客户端订阅过滤（v1），广播成本随连接数线性，16 连接量级可忽略。

## 36. 附录 A：KernelApi 完整接口签名（展开）

> 完整签名以 `packages/react/src/index.ts` 的 `KernelApi` 为准（契约单源）。此处只展开拆分后的边界，不复制全量——避免「类型在圆心之外复制一份」的契约漂移。落地时 `KernelApi = CoreKernelApi & HostKernelApi` 直接在 `packages/react/src/index.ts` 内拆，`CoreKernelApi` 与 `HostKernelApi` 从同一文件 re-export，不另起本地版。

## 37. 附录 B：鉴权数据模型

### 37.1 密码存储

> ⚠️ 实现状态：公网（`public`）一块已从当前实现移除——先只做本机/局域网；
> 结构示例中的 `public` 字段与 §39 cloudflared 隧道保留为设计存档，代码中不存在。

```jsonc
// ~/.my-harness-desktop/config/remote.json
{
  "enabled": false,            // 远程访问总开关
  "bind": "loopback",          // loopback | lan
  "port": 4763,                // 固定默认，被占自适应后写回实际值
  "lan": {
    "enabled": true,           // 局域网密码开关
    "passwordHash": "bcrypt$...",
    "customized": false
  },
  "public": {
    "passwordHash": "bcrypt$...",
    "customized": false,       // 自定义后不再每次换新
    "activeTunnel": null       // 上次隧道 URL（恢复用）
  }
}
```

### 37.2 token 结构

```
token = base64url(payload) + "." + base64url(hmacSha256(payload, serverSecret))
payload = { kind: "local" | "remote", exp: unixSeconds, nonce: string }
```

- `serverSecret` 每次后端启动随机生成 → token 绑定后端进程，重启全失效。
- cookie：`httpOnly` + `SameSite=Strict` + `Path=/`；`Secure` 仅在 TLS 下置位（公网/反代场景由网关终结 TLS 时由反代注入）。

### 37.3 密码换新

- 公网每次 `remote:tunnelStart` 成功 → 生成新密码 → 写 `public.passwordHash` → 旧 token 因 `nonce`/`exp` 仍有效但旧密码已不可登录 → 旧链接作废。
- 自定义固定密码 → `customized=true`，不再自动换。
- 局域网手动 `refreshPassword` / 自定义。

## 38. 附录 C：远程访问设置 UI

### 38.1 归属

`src/plugins/system/remote-access/`，`contributes.settings` 声明一个 `component: RemoteAccessPage`，经 `window.kernel.remote.*` 控制（§18.6）。纯内容层壳插件，不碰网关实现。

### 38.2 页面结构

| 区块 | 控件 | 行为 |
|---|---|---|
| 远程访问 | 开关 | `remote:start` / `remote:stop` |
| 局域网 | 地址下拉 + URL + 二维码 | 显示 `lanUrl`，`remote:qr` 出码 |
| 局域网密码 | 显示/刷新/自定义/关 | `setPassword`/`refreshPassword`/`setLanPasswordEnabled` |
| 公网 | 开启按钮 + 免责声明勾选 + URL + 二维码 | `tunnelStart`/`tunnelStop`，开启前强制勾选 |
| 公网密码 | 显示/自定义 | 同密码 API |
| 在线客户端 | 列表 | `remote:status` 的 `clients`，`remote:stateChanged` 驱动刷新 |

### 38.3 降级

远程客户端（本身）打开设置页时，局域网/公网开关与二维码正常显示，但「在线客户端」里的「本机窗口」标记为 local；所有 `remote:*` 都是 Core channel，远程可调（这是用户远程管理远程访问入口的依据）。

## 39. 附录 D：cloudflared 集成细节

> ⚠️ 实现状态：整节为设计存档——公网隧道已从当前实现移除（`remote:tunnelStart/tunnelStop`
> channel、cloudflared 下载/拉起、免责声明均不在代码中）。未来恢复公网时按本节落地。

### 39.1 下载

- 顺序：清华镜像 → 官方 GitHub release → 加速源；全部失败报错并提示手动安装。
- 安装位置：`~/.my-harness-desktop/cloudflared/cloudflared`（Windows 加 `.exe`）。
- 已装 PATH 里有的 → 直接用，不下载。

### 39.2 启动与解析

```
spawn("cloudflared", ["tunnel", "--url", `http://127.0.0.1:${port}`])
  → 逐行读 stdout，匹配 /https:\/\/[a-z0-9-]+\.trycloudflare\.com/ → 得公网 URL
  → 通过 remote:stateChanged 推给前端
```

### 39.3 生命周期

- 启动失败/中途退出 → `stateChanged` 标 failed + 重试（上限 N 次，指数退避）。
- 后端重启 → 读 `public.activeTunnel` 自动重拉隧道（沿用上次密码，不换新）。
- 关闭 → SIGTERM 子进程，作废旧 URL（cloudflared 退出即失效）。

### 39.4 免责声明

每次 `tunnelStart` 服务端强制校验「已勾选」标记（前端勾选 + 后端记入本次会话），未勾选直接拒绝——不靠前端禁用按钮这种可绕过的方式。

## 40. 附录 E：与 dsh-pocket 的对照

| 维度 | dsh-pocket | 本方案 |
|---|---|---|
| 被代理对象 | `dsh web` 已有的 HTTP+WS 服务 | 后端本身就是 HTTP+WS（无需代理） |
| 前端 | dsh 官方 web UI + 移动适配 | 本壳 renderer（同一套） |
| 传输改造 | 无（纯代理） | 去 IPC，`window.kernel` 变 WS 客户端 |
| 鉴权 | 改头反向代理 + 按 Host 分令牌 | 后端内建密码 + cookie + hello |
| 公网 | cloudflared | cloudflared（可借鉴）或用户网关 |
| 移动端 | dsh-web-mobile 移植 | v1 不做，仅远程电脑浏览器 |

**可借鉴**：cloudflared 多镜像下载 + URL 解析 + 自动恢复、限速（5 错 60s）、密码自动换新、`~/.dsh` 下的 token/settings 持久化位置设计。
**不可复用**：`lib/proxy.mjs` 反向代理（我们无需代理，后端即服务）、`client/` 移动适配（不同前端）。

## 41. 附录 F：决策日志（ADR）

| # | 决策 | 理由 | 日期 |
|---|---|---|---|
| ADR-1 | 去 IPC，`window.kernel` 走 WS | 单一传输，远程访问免费，可对接服务端 | 本文 |
| ADR-2 | 后端 Electron-free，宿主能力接口化 | 让后端可跑用户服务端 | 本文 |
| ADR-3 | WS 承载 invoke/push，HTTP 只承载静态/登录/状态 | 1:1 映射 IPC 模型，避免 REST 轮询 | 本文 |
| ADR-4 | channel 名沿用 IPC 常量树 | 契约延续，迁移机械，对接面稳定 | 本文 |
| ADR-5 | 局域网明文、公网 TLS | 与 dsh-pocket 同模型，降低本机部署门槛 | 本文 |
| ADR-6 | v1 远程不加载第三方插件 | `file://` 动态 import 浏览器不可用，演进 HTTP 服务 | 本文 |
| ADR-7 | 同屏同会话无仲裁 | 与 dsh-pocket 同模型，v1 范围收敛 | 本文 |

## 42. 附录 G：文档自检记录（首轮）

> 本附录记录编写时的自检项，供盲审对照。

- [x] 依赖方向：`core/domain/remote.ts` 零依赖；网关不 import `ws`/`http`（在 `api/http`）；宿主能力不进中立契约。
- [x] 契约单源：channel 清单沿用 `IPC` 常量树，不复制；`KernelApi` 拆在 `packages/react` 单处。
- [x] 无特权差异：远程/本地同走 `KernelApi` + 中性事件，无 `if (kernel)` 于会话链路。
- [x] 机制/内容分离：登录页/设置 UI 属内容（壳插件 + 内置登录页），网关/协议属机制（`core/application/remote` + `api/http`）。
- [x] 显式降级：Host 能力缺面均返回 UNSUPPORTED_HOST + 前端置灰，不静默。

## 43. 附录 H：迁移期兼容策略

### 43.1 阶段 1 的过渡态

阶段 1 目标「删 IPC」，但为降低一次性切换风险，采用**单 commit 内完成**而非「双跑」：

- 不接受「IPC 与 WS 并行双跑」的过渡态——那正是已否决方案 A（§26.1），会留下双传输技术债。
- 阶段 1 的 commit 边界 = 「本地桌面行为不变 + IPC 归零」，一次切干净，回滚靠 git（§29.2）。

### 43.2 验证闸门

阶段 1 切换前，先补一组「现有行为快照」测试（Playwright 录制：发消息、切模型、开设置、拖布局），切换后重放比对。行为不一致即视为阶段 1 未完成，不回滚就不进阶段 2。

### 43.3 顺序依赖

- `buildKernel` 抽取必须先于「删 preload」——先有 transport 无关实现，再切入口。
- `gateway` + `ws-server` 必须先于「删 `api/ipc`」——先起新路，再把 handler 逐个搬过去，最后删旧。
- 每搬一个 handler 域（session → config → models → …）跑对应测试，不攒到最后。

## 44. 附录 I：常见问题

### 44.1 为什么不用 REST？

push 型通道（`session:event` 等实时事件流）用 REST 只能轮询或 SSE；SSE 单向、REST 语义冗余。WS 单连接 + channel 命名正好 1:1 映射现有 IPC 模型，机械迁移、实时双向、天然 push。

### 44.2 为什么 loopback 明文、不本地也起 TLS？

loopback 无网络暴露，加自签 TLS 徒增证书信任复杂度。局域网明文是同 dsh-pocket 的已知取舍；公网必 TLS（隧道/用户网关终结）。

### 44.3 远程浏览器能装壳插件吗？

内置壳插件随 renderer 构建期打包，远程天然可用。第三方壳插件 v1 不加载（§10），后续经 HTTP 服务插件模块。

### 44.4 多个远程客户端同时操作会怎样？

同屏同会话、后写覆盖，无仲裁（§13.2）。事件全量推给所有客户端。

### 44.5 服务器宿主下 dialog/窗口控制怎么办？

返回 UNSUPPORTED_HOST，前端置灰（§10）。用户服务端若需要，可自行在网关层实现等价能力（那是「实现同一协议」的扩展点）。

### 44.6 后端重启后远程连接怎么办？

token 绑定后端进程（§37.2），重启全失效，需重新登录；隧道按 `activeTunnel` 自动重拉（§39.3）。

## 45. 附录 J：文档盲审记录

### 45.1 第 1 轮：架构正确性

| # | 发现 | 处置 | 章节 |
|---|---|---|---|
| 1 | 「宿主注入 window.kernel」与「零 IPC / 单一 WS」自相矛盾 | 修正：单一传输，window.kernel 永远由 wsTransport 构建，本地身份由 URL `?lt=<token>` 判定 | §4.4、§22.1 |
| 2 | 「本地 token 注入」机制未说明（无 preload 后靠什么注入） | 修正：Electron 窗口加载 URL 带一次性 local token | §8.3、§9.2 |
| 3 | 插件权限门控（fs/git/llm/bus/bash 的 manifest permissions）在 HTTP/WS 边界的落点缺失 | 修正：明确在 api/http handler 边界，按 pluginId + manifest 校验 | §7.3 |
| 4 | MainContext 去 Electron 后的最终 home 未说明 | 修正：明确 `bootstrap/context.ts` | §7.5 |
| 5 | 重连后如何补断线期间的事件空洞未说明 | 修正：重连 hello 成功后触发 `session:sync` 拉基线 | §15.6 |

### 45.2 第 2 轮：完备性

| # | 发现 | 处置 | 章节 |
|---|---|---|---|
| 6 | `assemble.ts` 是否 import electron 无硬约束 | 修正：明确不 import electron（Electron-free 的物理保证） | §21.3 |
| 7 | 第三方插件「跳过」的判定机制缺失（靠什么知道在浏览器里） | 修正：`platform === "browser"` 先判后跳，不靠 try/catch 兜底 | §10.2 |
| 8 | 冷启动 hydrate 前需 await WS 建连 + hello 就绪 | 修正：引导序列补 await 就绪 | §4.4、§22.1 |
| 9 | 服务器宿主下前端 ws 指向的跨域/注入方式 | 已覆盖（§46 三方式 + CORS） | 无改动 |

### 45.3 第 3 轮：一致性与契约单源

| # | 发现 | 处置 | 章节 |
|---|---|---|---|
| 10 | §16.2 `app.info` 标「半 Host」与 §20.6 的「info 拆分」术语不一致 | 修正：统一「部分 Host（info 拆分）」 | §16.2 |
| 11 | §4.4 引导代码 `if (!window.kernel)` 与「无宿主注入」不一致 | 修正：无条件构建 + hello token 流程 | §4.4 |
| 12 | §7.3 handler 与 core/application 的边界（是否薄转发） | 修正：明确 handler 薄转发，业务在 application | §7.3 |

### 45.4 明确接受的风险（不修，记录在案）

- 局域网明文传输（无 TLS），靠同网段 + 密码（§25.3）。
- 同屏同会话、多客户端无冲突仲裁，后写覆盖（§13.2）。
- 事件全量推送，无每客户端订阅过滤（§13.3）。

### 45.5 结论

三轮盲审共发现 12 处需修正，全部已改；3 处明确接受的风险记录在案。修正不改变终态架构的骨架（去 IPC / Electron-free / 线协议 / 三场景 / 鉴权），只补齐矛盾、边界与判定机制。文档基线升为 v1.4（见 §50）。

## 46. 附录 K：前端与后端的连接配置

### 46.1 ws 指向的三种确定方式

| 方式 | 场景 | 优先级 |
|---|---|---|
| 同源推断 | 前端由后端同一 host 服务（Electron 本地、反代、自托管） | 默认：`ws(s)://location.host/rpc` |
| 运行时注入 | 前端静态文件与后端分离（CDN + 独立后端） | `window.__WS_URL__`（登录页/配置注入） |
| 构建期注入 | 固定部署目标 | `VITE_WS_URL`（electron-vite define） |

三者在 `ws-transport.ts` 里统一为一个取值函数，按优先级取，不散在多处。

### 46.2 跨域（CORS）

- 同源部署（推荐）：无 CORS 问题。
- 前后端分离：后端在 `/rpc` 与 `/status.json` 返回 `Access-Control-Allow-Origin`（白名单，默认拒绝未知 origin），WS 升级校验 `Origin` 头（§8.6）。

### 46.3 前端判定「本地 vs 远程」

前端不猜测，由 `hello` 应答的 `host` 能力面 + `app.info` 判定：`host.window === true` 才渲染标题栏窗口控制；否则 `platform="browser"` 走无标题栏布局。

## 47. 附录 L：补充时序

### 47.1 跨内核切换（pi ↔ dsh）

```
前端 setModel(provider, modelId) → wsTransport.invoke("session:setModel", ...)
  → gateway → sessionStore.setModel
  → switchKernel：stop 旧后端 → seed 中性历史 → 起新后端
  → 期间事件经 gateway.broadcast 推给所有客户端
  → 前端 stores 与桌面同逻辑更新，不感知「客户端在远程」
```

### 47.2 fork 分叉

```
前端 fork(parentLineageId, boundary) → invoke("session:fork")
  → sessionStore.fork → 内核 fork → 新 lineage 事件 push 回
  → 树面板/时间线照常更新（中性 LineageTree，无内核身份分支）
```

### 47.3 提问审批

```
内核提问 → sessionStore.onQuestion → gateway.broadcast("session:question", req)
  → 远程浏览器弹出审批 → 前端 answerQuestion(requestId, answers) → invoke("session:answerQuestion")
  → sessionStore.answerQuestion → 内核回填 → 继续执行
```

### 47.4 模型连通性测试

```
前端 testModel(cwd, provider, modelId) → invoke("session:testModel")
  → 内核隔离临时会话（ephemeral）→ 结果返回
  → 远程与本地同路径，无额外权限分支
```

## 48. 附录 M：文档完成度核对

| 项 | 目标 | 现状 |
|---|---|---|
| 三种接入场景（本机/局域网/公网） | §9 明确 | 已写 |
| 鉴权方案 | §8 明确 | 已写 |
| 对接用户服务端形态 | §9.5 明确 | 已写 |
| 三级标题结构 | 全文 ## / ### | 已写 |
| 详细规格（transport/协议/channel/宿主能力） | §15–§20 | 已写 |
| 迁移文件级清单 | §23 | 已写 |
| 测试/威胁/备选/决策 | §24–§27、§41 | 已写 |
| 盲审记录 | §45 | 待回填 |

> 盲审开始前，本文正文视为冻结基线 v1；盲审中发现的修正直接改正文，并在 §45 记录处置，不另起分支版本。

## 49. 附录 N：边界再确认（一句话速查）

- **内核 vs 壳**：内核出能力（会话/工具/模型），壳出机制（槽位/渲染/事件总线）。去 IPC 只动壳的流入适配器，内核与中立契约不动。
- **壳 vs 壳插件**：壳插件仍只 import `contract`/`react`、经 `usePluginContext()` 消费。`window.kernel` 换底层后插件零改动。
- **宿主 vs 内核**：宿主能力（窗口/对话框/通知）是运行时环境，不是内核能力，不进 `BaseBackend`、不进 `core/domain`。
- **前端 vs 后端 vs 宿主**：前端纯 web、后端纯 Node、宿主可插拔。三者边界以「线协议」和「宿主能力接口」为界，越界即违规。
- **远程 vs 本地**：同一前端、同一后端、同一协议、同一份中性事件。差别只在「连接身份」与「宿主能力面」。

## 50. 修订记录

| 版本 | 变更 | 说明 |
|---|---|---|
| v1.0 | 初稿 | 14 节，含终态架构、去 IPC、Electron-free、线协议、鉴权、三场景、分阶段 |
| v1.1 | 扩到三级标题 | 每节拆 ## / ###，补 60+ 三级小节 |
| v1.2 | 补三场景 + 鉴权方案 | §8 鉴权方案、§9 三种接入场景与对接方案 |
| v1.3 | 补详细规格 + 迁移 + 测试 + 威胁 + 附录 | §15–§50 |
| v1.4 | 三轮盲审 | 见 §45（待回填） |

> 本文是「web 服务化」这一架构级变更的真相源；落地时以本文为准，代码是展开。改架构先改本文，不在代码里另起一套。

---

## 51. 结语

本文把 my-harness-desktop 从「Electron 桌面壳」到「web 服务」的改造，拆成一条清晰、可回滚、每步完整可用的路径：

1. **阶段 1 传输重构**——删 IPC，`window.kernel` 变 WS 客户端，本地桌面行为不变，IPC 归零；
2. **阶段 2 Electron-free**——六样宿主能力接口化，后端可 `node` 独立跑；
3. **阶段 3 远程/对接**——本机/局域网/公网三种接入，密码鉴权 + 二维码 + cloudflared 隧道，前端可托管、后端可对接用户服务端。

一条不变的根贯穿始终：**换的是传输，不是内核契约**。中立契约、中性事件、多内核无特权、壳插件无特权——这些纪律一条不动，本文只是把「会变的传输层」从 Electron IPC 换成了标准 HTTP/WebSocket，从而让「远程访问」和「对接服务端」从外挂需求变成架构的天然属性。落地时对照 §45 盲审记录与 §48 完成度核对逐项推进，不留中间态。
