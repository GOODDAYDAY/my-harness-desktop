# 007 冷启动与暖启动

## 1 冷启动定义与边界

### 1.1 机制就绪与内容就绪的分离

pi-desktop 的冷启动把"就绪"拆成两层：

- **机制就绪**：main 进程完成路径解析、Store 初始化、插件发现与注册、IPC handler 全部就位；renderer 完成 prefs hydrate、i18n 初始化、插件 renderer 模块加载与组件注册；React 树挂载，ThemeProvider 注入 CSS 变量。这些是"系统能运转"的前提。

- **内容就绪**：槽壳渲染出 sidebar/sidePanel/settings 的实际内容、pi 子进程已启动并同步了基线。这些是"功能可用"的前提——但不是首帧可见的前提。

冷启动的定义边界是机制就绪。内容就绪不属于冷启动的范畴——它是冷启动完成后逐步发生的事。pi 子进程的启动更不在其中（§1.2）。

### 1.2 pi 子进程不在冷启动链路里

pi 子进程（`spawn("node", [cli.js, "--mode", "rpc"])`）是用户真正要发消息时才按需起的临时工。冷启动全程不碰它。理由在两个方向：

- **看会话**不走 pi。`openSession` 是纯文件读——`session-scanner.ts` 读 JSONL 文件全部行，逐行 `JSON.parse`，映射成中性消息。秒开。
- **发消息**才起 pi。`prompt()` → `ensureForSend()` → `start()` → `waitReady()` → `sync()` → 发真正的 prompt 命令。这条链路只在用户按发送时才触发。

`waitReady` 的实证探测（§3.2）管的是"pi 进程已就绪"这件事，它属于发送路径而非冷启动。冷启动的"就绪"是桌面壳本身的机制就绪——pi 进程根本不在其中。

### 1.3 数据根分流：dev 与 pkg 的物理隔离

冷启动的第一步是确定数据根。`resolvePiDesktopDir()`（`src/client/paths.ts:21-23`）按 `app.isPackaged` 分流：

```
打包态: ~/.pi-desktop/
dev 态: ~/.pi-desktop-dev/
```

分流的原因：打包安装的是稳定版，dev 跑的是迭代版。两版共享同一数据目录时，不稳定版的配置结构变更或迁移 bug 会污染稳定版数据。代码层（dev 跑新代码）和数据层（dev 用 `-dev` 目录）的隔离边界对齐。

不分流的部分：`~/.pi/agent/`（pi 底座标准目录，模型 Key 等，两版共享）和项目级 `<cwd>/.pi-desktop/`（跟项目走，不属于桌面数据根）。

## 2 冷启动序列：从 t=0 到首帧可见

冷启动横跨 Electron 的两个进程：main（Node.js）和 renderer（Chromium，跑 React UI）。六个阶段按时间线排列：

### 2.1 阶段一：main 进程模块级同步初始化

入口文件 `src/bootstrap/index.ts`。所有初始化代码在模块级别同步执行，不等 `app.whenReady`——因为 IPC handler 必须在窗口创建前注册好。

**2.1.1 路径定义与 Store 装配**

main 侧首先定义全部路径常量（`src/bootstrap/index.ts:52-58`），注入给 application 层的各 Store。application 层的 Store 不直读 `process.cwd()` 和 `process.env.HOME`——路径由 bootstrap 在启动时注入。

四种 Store 在模块级实例化：

- `prefsStore`（`electron-store`）：桌面偏好，跨重启持久化到 `~/.pi-desktop/config/`。构造时设 `defaults`，所有 getter 必返回值，renderer hydrate 不需要 `??` 兜底。
- `configStore`（`application/config/config-store.ts`）：插件配置，走项目级 `<cwd>/.pi-desktop/config/{pluginId}.json`，全局 `~/.pi-desktop/config/{pluginId}.json` 自动兜底。
- `piSettingsStore`（`application/pi-settings/pi-settings-store.ts`）：pi 底座的 `~/.pi/agent/settings.json`。
- `modelsStore`（`application/models/models-store.ts`）：pi 底座的 `~/.pi/agent/models.json`。

**2.1.2 插件发现与注册**

`discoverPlugins()`（`src/core/application/loader/discover.ts:30-63`）递归扫描目录，任何含 `plugin.json` 且 manifest 有 `id` 字段的子目录即为一个插件。扫描四目录，按优先级从低到高注册（`src/bootstrap/index.ts:88-91`）：

```
builtin → installed → user → project
```

高优先级覆盖低优先级。内置和第三方走同一扫描逻辑、同一注册表——代码中没有任何 `if (builtin)` 分支。这是"无特权差异"纪律的物理落地。

**2.1.3 i18n 合并**

`mergeLanguageContributions()`（`src/bootstrap/index.ts:95-96`）把所有插件的 `languages` 贡献项合并成 i18next resources。冲突时按来源插件优先级取高。

**2.1.4 SessionStore 装配**

依赖倒置的两层注入（`src/bootstrap/index.ts:101-117`）：

- `RpcAdapterFactory` 接口由 application 层拥有，shell 实现为 `new RpcAdapter(createPiSubprocess(opts))`。
- SessionStore 创建后立即挂上四个广播器（`onEvent` / `onKernelEvent` / `onExtensionUI` / `onSnapshot`），把中性事件推给所有窗口。

**2.1.5 IPC handler 注册**

约四十个 `ipcMain.handle` 在模块级注册完毕（`src/bootstrap/index.ts:202-213`）。按能力域分文件：`config`、`appearance`、`sessions`、`fs-git`、`slots-dialog`、`kernel`、`plugins`、`skills`、`extensions`、`bus`、`window`、`app-info`。

### 2.2 阶段二：窗口创建

`app.whenReady()` 回调（`src/bootstrap/index.ts:246-308`）：

1. 确保 `general.json` 存在（首次启动时写默认值）。
2. 同步 mirrored skills（内置 skills 文件镜像 + settings 条目挂摘）。
3. 安装底座扩展（tool-gate、bus-extension、subagent-extension）。
4. `createWindow()` 创建 `BrowserWindow`：`show: false` + `ready-to-show` 后 `win.show()`，避免白屏。macOS 用原生红绿灯（`titleBarStyle: "hiddenInset"`），非 macOS 用无边框窗口。

### 2.3 阶段三：preload 桥接

窗口创建时 Electron 自动执行 preload 脚本，`contextBridge.exposeInMainWorld("pi", pi)` 暴露受控 API。renderer 只看到 `window.pi`——没有 `require`、没有 `fs`、没有 `process`。`contextIsolation: true`、`nodeIntegration: false`。

### 2.4 阶段四：renderer 并行竞赛

renderer 入口 `src/api/renderer/index.tsx:163-198`。四件事并行竞赛，5 秒超时兜底，全部完成或超时才挂 React 树：

```typescript
const pluginsReadyP = import("./plugins-host").then(({ pluginsReady }) => pluginsReady);
const timeoutP = new Promise<void>((r) => setTimeout(r, 5000));
Promise.race([Promise.all([hydrateP, layoutHydrateP, initI18n(), pluginsReadyP]), timeoutP])
```

- **`hydrateP`**：`hydrateFromPrefs()` 并行 9 个偏好 IPC（`currentThemeId`、`fontScale`、`fontMonoChoice`、`fontSansTone`、`rightPanelOpen`、`lastCwd`、`currentLocale` 等）。完成后若 `currentCwd` 有值，调 `startNewChat(currentCwd)` → `setContext(cwd, null)` 恢复上次工作上下文。
- **`initI18n()`**：1 次 IPC 拿 i18n resources + 1 次 IPC 拿 locale 检测 + `i18next.init()`。
- **`pluginsReadyP`**：动态 import `plugins-host` 模块。模块级代码立即执行 `bootstrap()`——读 disabled 列表、拉插件清单、并行加载所有 builtin 和第三方插件 renderer、注册组件到全局 Map、`bumpPlugins()` 信号。`pluginsReady` Promise resolve 表示全部插件 renderer 加载完成。
- **`layoutHydrateP`**：依赖 `hydrateP`——先恢复 cwd 才能读项目级布局配置。

四件事全部完成（或 5 秒超时）后才进下一阶段。超时后偏好用默认值、i18n 未初始化则 `t("key")` 返回 key 本身、插件未加载则槽壳渲染空。正常路径在 200ms 内完成。

### 2.5 阶段五：React 首帧渲染

`Promise.race` 的 `.finally()` 里顺序执行：

1. `initSessionStore()`：挂上 main→renderer 的事件通道（`onSnapshot` + `onEvent` 监听器）。
2. `subscribeLocaleChange()`：locale 变化订阅。
3. `createRoot().render()`：挂载 React 树（`ThemeProvider` → `ErrorBoundary` → `App` → 三栏布局）。
4. 插件组件已注册到全局 Map，首帧时槽壳查 Map 能命中——不再出现"组件未注册"的空白。

### 2.6 关键演变：插件加载从"首帧后"变为"首帧前"

此前版本的冷启动文档描述的是"插件 renderer 首帧后异步加载"——`ensurePlugins()` 在 `createRoot().render()` 之后异步调用。当前代码已演进为插件加载纳入渲染闸门：`pluginsReadyP` 作为 `Promise.all` 的第四个成员，React 树等它完成后才挂载。

这个演变消除了一个历史问题：槽壳首帧渲染时插件组件还没注册 → 查 Map 为空 → 渲染"组件未注册"或空白；之后 `bumpPlugins()` 触发重渲染才补上。现在首帧时 Map 里已有所有组件，一次渲染到位。代价是首帧时间多了插件加载的耗时——但 5 秒超时兜底保证不卡白屏。

## 3 事件驱动的就绪探测

### 3.1 rpc-adapter.start()：去掉 100ms 固定 sleep

`src/client/pi/rpc-adapter.ts:133` 的注释明确记录了这次清理：

```
// 不 sleep 等就绪(评估 P2:100ms 是赌就绪的固定 sleep,慢机不够快机白等)。
// 就绪由 session-store.waitReady 发 get_state 探测确认;此处仅检查进程是否已退出。
```

`adapter.start()` 做完接线（绑 stdout JSONL reader、绑 exit/error 事件）后，只检查 `handle.alive`——进程是否活着。不做任何固定时间的 sleep。

### 3.2 waitReady：事件驱动优先 + 实证探测兜底

`src/core/application/sessions/session-store.ts:410-438` 的 `waitReady` 是就绪探测的核心实现：

```typescript
private async waitReady(adapter: RpcAdapter): Promise<void> {
  let readyResolve: (() => void) | null = null;
  const readyPromise = new Promise<void>((resolve) => { readyResolve = resolve; });
  const off = adapter.onEvent((event) => {
    if ((event as { type?: string } | undefined)?.type === "session_start" && readyResolve) {
      readyResolve();
      readyResolve = null;
    }
  });
  // 事件驱动首选:session_start 事件到立即返回
  // 实证探测兜底:每 150ms 发 get_state 命令
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const race = await Promise.race([readyPromise, new Promise<null>((r) => setTimeout(() => r(null), 150))]);
    if (race !== null) return; // session_start 已触发
    try { await adapter.send({ type: "get_state" }); return; }
    catch { /* 再等一轮 */ }
  }
}
```

两层策略：

- **事件驱动首选**：pi 进程初始化完成后第一时间推 `session_start` 事件。`waitReady` 监听到这个事件立即返回，不用等轮询周期。
- **实证探测兜底**：如果 `session_start` 没到（底座版本不推该事件，或网络延迟），每 150ms 发一条 `get_state` 命令做实证探测，确认 pi 已能正常响应 RPC。

4s 超时也不阻塞——让后续 `sync()` 的真实错误冒出来，不在此掩盖。

### 3.3 为什么不用固定 sleep

固定 sleep 是对时序竞争的赌注——赌 100ms 后进程一定就绪了、赌 500ms 后数据一定到了。赌赢了功能正常，赌输了偶发 bug 永远复现不了。事件驱动是正解：有一个数据源，它变了就推给你，没变就不打扰你。

pi-desktop 的冷启动里删掉了两处固定 sleep：rpc-adapter 的 100ms（`rpc-adapter.ts:133` 注释记录）和旧版 renderer hydrate 里的 500ms。替换为 `session_start` 事件驱动和 `get_state` 实证探测。

## 4 暖启动：pi 进程预热

### 4.1 问题：发送路径上的三段启动延迟

pi 的进程模型是"会话是文件，进程是按需的临时工"。用户打开会话看的是文件，不启动 pi。pi 只在用户按发送时才起。这条链路的成本全在发送路径上——从用户按回车到第一个 token 出现，中间有三段串行延迟：

- **spawn（1-2s）**：`createPiSubprocess()` 调 `spawn("node", [cli.js, "--mode", "rpc"])`。node 进程自身的启动开销 + pi 模块的加载和初始化。三段里最重也最不可压缩——取决于 pi 底座自身的启动速度。
- **waitReady（150ms~4s）**：等 pi 推 `session_start` 信号或 `get_state` 实证探测。`session_start` 事件驱动到就立即返回，轮询兜底每 150ms 一次，4s 超时。
- **sync（4 条并行 RPC）**：`resync()` 并行发 `get_state` / `get_entries` / `get_tree` / `get_commands` 拉基线。已经并行了，压缩空间有限。

三段加起来 1-3 秒。这不是偶发——每次打开新会话、每次切到一个没活进程的旧会话，首条消息都要走这条全链路。

### 4.2 根因：三段都在发送路径上

三段各自的优化空间都有限，而且根因是同一个：它们都在发送路径上。用户按发送的那一刻才触发 spawn，那一刻才开始等就绪，那一刻才开始拉基线。如果这三件事能在用户打字期间就跑完——用户打字要花好几秒——那按发送时 pi 早就就绪了，发送路径上零等待。

`setContext` 是天然的预热触发点。用户选项目或打开会话时 `setContext` 立即被调，到用户打完字按发送之间有好几秒——这些时间足够跑完 spawn + waitReady + sync。预热的核心思路就是：把就绪从发送路径提前到 setContext 时刻。

### 4.3 方案：fire-and-remember，发送前 await

warmup 在 `src/core/application/sessions/session-store.ts:191-208`：

```typescript
warmup(cwd: string, sessionPath: string | null): void {
  const key = sessionPath ? this.resolveProcKey(sessionPath) : (cwd ? `new:${cwd}` : "");
  if (!key || this.isAlive(key) || this.warmups.has(key)) return;
  let warmPath = sessionPath;
  if (!warmPath) {
    warmPath = this.generateNewSessionPath(cwd);
    this.activeSessionPath = warmPath;
    this.dispatch(key, { type: "sessionStart", sessionFile: warmPath });
  }
  const p = this.start(cwd, warmPath);
  this.warmups.set(key, p);
  p.then(() => { this.warmups.delete(key); }, () => { this.warmups.delete(key); });
}
```

关键设计：

- **fire-and-forget 发起，fire-and-remember 发送**：warmup 不阻塞 setContext（它 `void` 调用 start 但不 await），但把 start 返回的 Promise 存入 `warmups` Map。发送时 `ensureForSend` 先 check 这个 Map。
- **新会话预生成路径**：sessionPath 为 null → `generateNewSessionPath()` 生成 `~/.pi/agent/sessions/<bucket>/<ts>_<uuid>.jsonl`，dispatch synthetic `sessionStart` 水合 renderer。
- **防重复**：`warmups.has(key)` 和 `isAlive(key)` 双重检查——已经预热中或进程已活就不重复起。

### 4.4 触发点：IPC handler 层

预热不在 `setContext` 里触发，而在 IPC handler 层追加。`src/api/ipc/sessions.ts:33-35`：

```typescript
ipcMain.handle(IPC.session.setContext, (_e, cwd: string, sessionPath: string | null) => {
  sessionStore.setContext(cwd, sessionPath);
  sessionStore.warmup(cwd, sessionPath);
});
```

`setContext` 本身不动进程（只设激活态字段），`warmup` 在 handler 里 fire-and-remember 起 pi。插件的 `ctx.sessions.setContext` 走 IPC → main 的这个 handler → setContext + warmup。main 进程内部的直接方法调用（如 `forkFromSession` 里的 `setContext`）不走 IPC，不触发预热。

### 4.5 三种发送路径

用户按发送时，`ensureForSend()`（`src/core/application/sessions/session-store.ts:300-327`）先检查 `warmups`：

```typescript
private async ensureForSend(): Promise<void> {
  if (!this.activeCwd) throw new Error("未选择工作目录");
  const warming = this.warmups.get(this.activeProcKey);
  if (warming) {
    try { await warming; } catch { }
  }
  if (this.alive) return;
  // ... 原有 start 逻辑
}
```

三种路径：

- **预热已完成**（最常见）：`warming` 已 resolved，await 立即返回，`this.alive` 为 true，`ensureForSend` 直接 return——零等待发 prompt。
- **预热还在跑**（用户极快按发送）：await 等到预热完成。spawn 那最重的 1-2s 已经省了，等的只是 waitReady 或 sync 的尾巴。
- **预热失败**（pi 起不来）：catch 吞错，`warming` 已从 Map 删除，`this.alive` 为 false，走原有 `start()` 逻辑重新起。

### 4.6 回收：没发消息的预热进程不留垃圾

`setContext` 切走旧会话时做回收（`session-store.ts:166-171`）：

```typescript
if (prevKey && prevKey !== key) {
  const prevProc = this.procs.get(prevKey);
  if (prevProc && prevProc.adapter.alive && !prevProc.touched) {
    void prevProc.adapter.stop().then(() => { this.procs.delete(prevKey); });
  }
}
```

`touched` 是 SessionProc 上的 boolean 标记（`session-store.ts:62`）。`false` = 没发过消息的空壳（预热起的、pref flush 起的）→ 切走时 stop + delete 回收。`true` = 已发过会话内容（prompt/steer/followUp）→ 不动（多会话并存保护）。

预热进程的 `touched` 天然是 `false`——没发过消息就是空壳。用户切走时自动回收，不留 50-100MB 的 idle 进程。

## 5 冷启动与暖启动都不做的事

### 5.1 不在应用启动时 eager spawn pi

应用启动时不发起 pi 子进程。pi 是用户要对话时才起的东西——打开首页不需要、浏览会话不需要、进设置页不需要。eager spawn 的代价是每次启动都白起一个进程，用户可能根本不发消息就关了窗口。冷启动结束后 pi 进程数量为零——第一个 pi 在用户第一次按发送时才起（或预热时起）。

### 5.2 不用固定 sleep 猜就绪

两处固定 sleep 已被清除：

- `rpc-adapter.start()` 的 100ms（`rpc-adapter.ts:133` 注释记录去掉了"600ms sleep 评估 P2：100ms 是赌就绪的固定 sleep"）。
- renderer hydrate 的 500ms 已被事件驱动模型替换。

就绪判断全部走实证探测（`waitReady` 的 `get_state` 命令）或事件驱动（`session_start` 事件）。

### 5.3 不在冷启动中阻塞等待 pi

pi 进程的就绪探测（`waitReady`）和基线拉取（`sync`）都在冷启动之外——它们只在发送路径上发生。冷启动不依赖 pi 的任何响应，不需要等 pi 起来。

## 6 QA

**Q：冷启动耗时最长的是哪个阶段？**

main 进程模块级同步初始化——路径定义、四种 Store 构造、四目录插件发现与注册、i18n 合并、SessionStore 装配、四十个 IPC handler 注册。这些都是同步代码，Electron 加载模块时执行。耗时取决于插件数量和文件系统速度，通常在几百毫秒内。

**Q：renderer 的 5 秒超时兜底什么时候会触发？**

IPC 卡住时：main 进程卡死、electron-store 文件锁竞争、prefs 文件损坏导致读挂。5 秒是保险不是预期——正常路径 200ms 内完成。

**Q：暖启动的 pi 占多少资源？**

一个 idle 的 pi 子进程（node + pi 模块）大约 50-100MB RSS。回收策略是"切走时 `touched=false` 就 stop"——用户切到别的会话，预热进程立即被回收。没有"空闲超时自动杀"的机制——用户停在一个会话页面上大概率是要用它的，保留进程让首条消息秒发比节省内存更值。

**Q：预热和 setContext 之间的竞态怎么处理？**

见 `docs/design/pi-warm-start.md` §4 竞态全景。摘要：四种竞态（预热未完成时发送、预热中切走、预热完成后上下文已变、pref flush 在预热窗口内触发）各有保护机制——`ensureForSend` 的 `await warming`、`start()` 的并发护栏、上下文校验、`warmups.has()` 防重复。全部覆盖，不依赖锁。

**Q：跨会话多进程的隔离靠什么？**

进程边界。每个 pi 是独立子进程——独立 stdin/stdout pipe、独立 `RpcAdapter` 实例、独立 `RequestCorrelator`。进程间零共享，不需要锁。激活态字段（`activeProcKey` / `activeSessionPath`）只有同步函数写，JavaScript 单线程事件循环里同步代码间不会被 `await` 打断——不存在写写冲突。
