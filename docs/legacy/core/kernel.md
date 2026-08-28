# 内核机制设计

> ⚠ **历史稿**：本文是 pre-多内核 的 pi-only 旧术语稿（"底座"/旧"内核"=壳机制），术语与架构以 CLAUDE.md + kernel-design-spec.md + core-spec.md 为准，本文保留作历史参考。

> 本文讲内核内部的机制实现——加载器怎么发现插件、RPC 适配怎么收发 JSONL、会话怎么管理进程、配置怎么加锁、主题怎么合并、i18n 怎么合并、安全边界在哪。通用原理和分层纪律见 `DESIGN.md`（CLAUDE.md 副本），插件开发指南见 `plugins/PLUGINS.md`，本文不重复那些文档的内容。

## 1 内核是什么

内核是 my-harness-desktop 中提供机制的部分——加载器、槽位契约、RPC 适配、配置读写、权限沙箱、进程隔离、生命周期管理。物理上对应 `src/core/` + `src/api/` + `src/client/` + `src/bootstrap/` 的机制代码。不含 `src/plugins/`（内容层）和 `packages/`（发布面）。

> 注：本文成文于顶层分区重构（`shell` 消亡 → `core/api/client/bootstrap`，commit 1db7d96）之前。旧术语映射：`src/domain/` → `src/core/domain/`、`src/gateway/` → `src/core/protocol/`（协议契约与翻译）+ `src/client/pi/`（RPC 适配、子进程句柄）、`src/application/` → `src/core/application/`、`src/shell/` → `src/api/`（流入：ipc/preload/renderer）+ `src/client/`（流出：pi/fs/git/npm）+ `src/bootstrap/`（组装根）。本文以下全部路径已按新分区重写。

本文逐个讲内核内部的六大机制：RPC 适配、会话管理、配置读写、插件加载器、主题合并、i18n 合并。每个机制锚定到具体的源码文件，讲它做什么、不做什么、怎么和上下游连接。

## 2 RPC 适配层

RPC 适配层是内核和 pi 底座之间的唯一通道。代码在 `src/client/pi/rpc-adapter.ts`，只做三件事：JSONL 读写、id 配对、事件转发。它不 spawn 进程——进程生命周期归 `subprocess-lifecycle` 管。

### 2.1 JSONL 协议

pi 底座以 `pi --mode rpc` 启动后，通过 stdin 收 JSON 命令、stdout 吐 JSON 响应和事件。每条消息是一行完整 JSON（JSONL 格式）。三类消息：

- **command**：从 stdin 发给底座，每条带一个 `id` 做关联。比如 `{"type":"get_state","id":"req_1"}`。
- **response**：从 stdout 回，带 `command`（回的是哪个命令）、`success`、可选的 `data` 或 `error`。按 `id` 和 pending 的 command 配对。
- **event**：从 stdout 推，是底座 agent 运行时的事件流（消息更新、工具执行、会话状态变化等），没有 `id`，fire-and-forget。

JSONL reader 自写 LF-only 分帧，不用 Node 的 `readline`——`readline` 会拆 U+2028/U+2029（JSON 字符串内合法的行分隔符），导致大 JSON 被错误截断。reader 维护一个 buffer，按 `\n` 切行，流式处理 stdout data 事件。

### 2.2 id 配对

`src/client/pi/correlator.ts` 的 `RequestCorrelator<T>` 是 id 配对 + timeout 兜底的通用工具。rpc-adapter 持有一个实例。

工作方式：`register()` 分配递增 id（`req_1`、`req_2`、…）并存入 pending Map，同时启动一个超时定时器（默认 30s）。`resolve(id, value)` 按 id 查 Map、清定时器、resolve Promise。`rejectAll(error)` 一次性 reject 全部 pending——进程退出时调。

timeout 不是为了"取消"命令——底座可能还在跑。timeout 是为了不让调用方永远挂在一个没有响应的 Promise 上。超时后 Promise reject，但底座如果后来回了 response，correlator 找不到 pending 条目会静默丢弃。

### 2.3 事件翻译

`src/core/protocol/event-translator.ts` 的 `translateEvent` 把底座的 `AgentSessionEvent` 翻译成圆心的中性 `SessionEvent`。翻译做了三件事：

- **type 映射**：底座用 snake_case（`tool_execution_start`），圆心用 camelCase（`toolCallStart`）。一张静态映射表，未识别的 type 原样透传（兜底，新事件不丢）。
- **字段保持**：pi 已用 camelCase 字段名（`toolCallId` 等），翻译后原样保留。不改字段名，只改 type。
- **敏感字段过滤**：当前版本未实现——`content[]`/`toolCalls[].args` 等敏感字段的过滤需要权限信息（哪个插件订阅了这个事件），留演进。

翻译发生在 `session-store.dispatch` 调用链路里：adapter 的 `onEvent` 回调收到原始 `AgentSessionEvent`，经 `translateEvent` 翻译成中性事件后推给 renderer。renderer 只看到中性事件，不知道底座的 type 命名。

### 2.4 子进程句柄

接口定义在本层：`src/client/pi/subprocess-handle.ts`。它只抽 rpc-adapter 真正用到的能力：`stdin`（写命令）、`stdout`（读响应和事件）、`alive`（是否存活）、`stop()`（停止进程）、`onceExit`/`onceError`/`onStderr`（生命周期事件）。

实现也在本层：`src/client/pi/subprocess-lifecycle.ts` 的 `PiSubprocessHandle` 封装 `spawn("node", [cliPath, "--mode", "rpc", ...])` + kill 策略（关 stdin → 1s → SIGTERM → 2s → SIGKILL）+ pi CLI 入口定位（优先全局 `pi` 命令，回退 `~/.my-harness-desktop/pi` 的 cli.js）。

接口和实现同处 `client/pi`——这里是"协议传输"和"进程传输"的共建区：rpc-adapter 持有 `SubprocessHandle` 接口，不 import `child_process`。换运行时（从 Electron 换到 CLI、从本地换到远程），只换 `PiSubprocessHandle` 实现，protocol 和 application 一行不改。

### 2.5 启动序列

rpc-adapter 的 `start()` 做四件事：

1. 绑定 SubprocessHandle 的事件——`onStderr` 收集 stderr（调试用）、`onceExit` reject 全部 pending、`onceError` 同上。
2. Attach JSONL reader 到 stdout——每行经 `handleLine` 解析。
3. 检查 `handle.alive`——如果进程启动后立即退出，抛 `RpcProcessError`。

`handleLine` 的消息分派有三条路径：先查 `extension_ui_request`（底座主动发给桌面的 UI 请求——比如底座想弹一个选择框或确认对话框，这种消息走独立的监听器，不经事件翻译），再查 `response`（按 id 配对 resolve），其余当 event 转发。

启动时不 sleep 等就绪——此前有 100ms 固定 sleep（参考 pi SDK 经验值），已删除。进程管道就绪由 Node.js stream 机制保证（stdout `data` 事件触发即管道通），底座 agent loop 就绪由 `session-store.waitReady` 发 `get_state` 探测确认。

## 3 会话管理

会话管理是内核最复杂的部分。代码在 `src/core/application/sessions/session-store.ts`，实现了 `SessionsApi` 接口（定义在圆心 `src/core/domain/sessions.ts`）。

### 3.1 会话是文件

每个会话是一个 JSONL 文件，每行一条消息。追加写不需要锁整个文件，流式读按行解析，删会话删文件就行。看会话 = 纯文件读（`session-scanner.readSession` 解析 JSONL 全部消息），零 RPC、零进程、秒开。

注意："看会话"和"起进程发消息"是两条路径。"看会话"是纯文件读——打开一个历史会话时，直接读 JSONL 文件渲染消息列表，不起 pi 进程、不发 RPC。只有用户发了消息（`prompt`），才走 `ensureForSend` → `start` → `sync` 的进程路径——此时 sync 会发 5 条 RPC 拉基线。所以"零 RPC"指的是"看会话"这条路径，不是"发消息"这条路径。

这个设计决策的背景：最初版本把"看会话"和"发消息"绑在一起——看会话也要先起 pi 进程、切会话也要 RPC。这导致冷启动 2.5-4 秒。改成"会话是文件"后，看会话变成纯文件读，只有发消息才起进程，冷启动压到 1.3 秒。

### 3.2 进程是按需的临时工

SessionStore 管理多个 pi 进程——每会话一进程、多会话多进程并存。核心逻辑在 `ensureForSend`：发消息前检查激活会话的 pi 是否活着，没活就起。不杀其他会话的进程。

- **看会话**：读文件，不启 pi。
- **发消息**：`ensureForSend` 保证激活会话的 pi 在跑。绑错会话 → 停旧起新（spawn `--session <path>`，底座从文件续上下文）。
- **切会话**：`setContext` 设激活。激活会话 pi 活着 → resync 推基线（切回流式中的会话拿实时状态）；没活 → 清基线（renderer 走文件读）。
- **新会话/切目录**：本地概念，清空视图即可，进程首次发送才起。

### 3.3 事件投影架构

SessionStore 是投影 owner：`start` 后 `sync` 一次拉基线（`resync` 发 5 条 RPC：get_state + get_entries + get_available_models + get_session_stats + get_available_thinking_levels），基线经 `session:snapshot` 广播给 renderer。事件流维持投影鲜活——底座推事件 → adapter `onEvent` → `translateEvent` → `dispatch` → 转发给 renderer 的事件监听器。

renderer 侧持一个 zustand store（实体在 `src/api/renderer/stores/session-store.ts`，`packages/react` re-export 兜底保插件 import 不变），只读不拉：基线 + 事件增量应用。组件不各自拉数据——这是"事件驱动，不轮询"的落地。消灭了 timeline/ModelPill/session-tree 3× getSnapshot 重复拉取。

### 3.4 就绪探测

`waitReady` 用 `get_state` 命令做实证轮询：150ms 间隔、4s 预算，首个成功即返回。不靠固定 sleep 猜就绪时间——固定 sleep 是对时序竞争的赌注，赌输了偶发 bug 你永远复现不了。超时也不阻塞——让后续 sync 的真实错误冒出来，不在此掩盖。

### 3.5 TPS 自算

底座不给 TPS（每秒 token 数），SessionStore 自己算：`messageStart` 记时，`messageEnd` 用 output tokens / 耗时算 TPS。output tokens 的提取是防御性的——底座字段形状未文档化，从 `message.usage.outputTokens` / `message.tokenUsage.output` / `message.tokens.completionTokens` 等多路径尝试。

### 3.6 事件路由

`dispatch` 只转发激活会话的事件。非激活会话的 adapter 事件静默——切回时 resync 补基线。这避免了"会话 A 的事件跑到会话 B 的 UI 上"。

一个关键的实现细节：SessionStore 内部维护一个 `procs` Map（key = 会话路径或 `new:${cwd}`，value = `SessionProc` 对象，包含 adapter、绑定的工作目录、绑定的会话路径、TPS 跟踪）。这个 Map 的 key 不随 sessionFile 变。底座推 `sessionStart` 事件时会带 `sessionFile`（新会话首次落盘的路径），但 procs 的 key 不动——因为 adapter 的 `onEvent` 回调是闭包，闭包捕获了创建时的 key，移动 key 会丢事件转发（旧监听器里的 key 和 Map 里的新 key 对不上了）。所以底座推 `sessionStart` 时只更新 `boundSessionPath`（该进程实际绑的会话文件路径，由底座事件更新）和 `activeSessionPath`（当前激活会话的路径，由 `setContext` 设）——两个值不同时更新会有短暂不一致，但不影响事件路由。

## 4 配置读写

配置读写是内核的通用基础设施。代码在 `src/core/application/config/`，提供通用的 JSON 文件读写原语，不针对任何特定配置文件。

### 4.1 通用原语

`config-file.ts` 提供三个原语：

- `readJsonFile(absPath)`：读 JSON 文件，不存在或损坏返回空对象。
- `writeJsonFile(absPath, data, mergeMode)`：写 JSON 文件。`deep` = 深合并（保留未改字段），`replace` = 整份覆盖。写操作用文件锁串行化。
- `withDirLock(dir, fn)`：锁目录执行 fn。用 `proper-lockfile`（stale 5s），锁目录而非文件——首次写时文件可能不存在，锁文件会 ENOENT，锁已 mkdir 的目录最稳。

`proper-lockfile` 只在 `config-file.ts` 引入一处。`config-store`、`models-store`、`pi-settings-store`、`session-scanner` 都调 `withDirLock`，不自己写锁逻辑。锁的实现在一处，换锁库只改一处。

深合并用 `deepmerge` 包（`json-merge.ts`），不手写——手写的 deepMerge 在数组、null、undefined 边界上各有微妙的不同行为，成熟包定义清晰、测试充分。

### 4.2 ConfigStore

`config-store.ts` 管插件自己的配置——读写 `~/.my-harness-desktop/plugins-data/{id}/config.json`。插件通过 `window.pi.config.get(pluginId, key)` / `set(pluginId, key, value)` / `all(pluginId)` 间接调它。ConfigStore 不碰文件路径——路径由 bootstrap 注入（`~` 已展开为绝对路径），不 import electron。

### 4.3 ModelsStore 和 PiSettingsStore

这两个 store 读写 pi 底座的配置文件：

- `models-store.ts`：读写 `~/.pi/agent/models.json`（模型配置）。`configMerge: "replace"`——整份覆盖，不做深合并。
- `pi-settings-store.ts`：读写 `~/.pi/agent/settings.json`（底座标准配置）。`configMerge: "deep"`——深合并，保留未改字段。还负责解析底座的 `.d.ts` 拿字段 schema（用 TypeScript Compiler API，不正则解析）。

### 4.4 依赖倒置

所有 store 不直读 `process.cwd()`、`process.env.HOME`——路径由 bootstrap 在启动时注入。`findSettingsDts` 的 npm 全局目录也由 bootstrap 传入。kernel-manager 同样走依赖倒置：`spawn("npm")`、`fetch(registry)`、`process.env` 这些外层细节经 `KernelRuntime` 接口封装（接口定义在 `src/core/application/kernel/kernel-runtime.ts`），实现在 `src/client/npm/kernel-runtime.ts`——换运行时（从 Electron 换到 CLI），application 层一行不动。

## 5 插件加载器

加载器代码在 `src/core/application/loader/`，分发现（`discover.ts`）和注册（`registry.ts`）两步。

### 5.1 发现

`discoverPlugins(rootDir, source)` 扫描一个根目录下的所有子目录，每个子目录里有 `plugin.json` 即算一个插件。只扫一层，不递归。发现阶段只读 `plugin.json`、标记来源（`builtin`/`installed`/`user`/`project`），不执行任何插件代码。

扫描根目录由 bootstrap 注入——application 不 import electron、不直读 `process.env.HOME`。bootstrap 传入四个目录路径，application 逐个调 `discoverPlugins` 收集全部 `DiscoveredPlugin`。

### 5.2 校验

`plugin.json` 的必填字段是 `id`、`version`、`displayName`。`contributes`、`permissions`、`configFile` 都可选。校验不通过的插件被跳过——一个坏插件不该影响其他插件加载。这和"无特权差异"一脉相承：内核不信任任何单个插件，包括内置的。

### 5.3 注册

校验通过的插件，其 `contributes` 被写入注册表（`registry.ts` 维护的 Map，按槽位分类）。注册表按优先级合并——同名插件高优先级覆盖低优先级（project > user > installed > builtin）。

组件注册是框架自动匹配：框架加载插件 renderer module 后，读 manifest 的 `contributes.*[].component` 字段，在 module 的 exports 里找同名组件，自动注册到对应槽位的注册表。插件只 `export` 组件，不调任何 register 函数。两层校验：TypeScript 编译器保证 export 的名字存在，框架加载时保证 manifest 的 component 名和 export 匹配。

### 5.4 生命周期

加载器管插件的生命周期。activate 时插件 renderer 代码被 `import` 执行（触发组件注册），deactivate 时组件从注册表移除，dispose 时插件资源被清理。一个插件出错不该影响其他插件——加载器做错误隔离，单个插件崩溃只影响它自己挂载的那个槽位。

## 6 主题合并

主题合并代码在 `src/core/application/theme/merge.ts`。多个主题插件贡献 token，内核合并成一份 CSS 变量。

### 6.1 token 合并

`resolveTheme(themeId, registry)` 递归解析主题：取 `base` 的 token 打底，再用自身 `tokens` 覆盖。带环检测——`seen` Set 记录已解析链路，循环继承抛错。

合并顺序：`THEME_TOKEN_DEFAULTS`（圆心默认值）→ base 主题的 token → 自身 token。后写的覆盖先写的。

派生 token（`border.color`、`font.size.*`）在 `resolveTheme` 里被剥离——插件显式赋值一律忽略。`border.color` 由 `color.border` 派生，字号只能来自圆心默认值 × fontScale。这是为了防止插件搞乱设计系统的派生关系。

`__auto__` 主题是动态 base：跟随系统明暗。当前简化为固定回退 `dark`，后续接 IPC 做系统主题检测。

### 6.2 字体覆盖

`applyFontScale(theme, scale)` 对 `font.size.*` token 应用字号倍率：`"14px"` → `"14px" * scale`。`applyFontChoice(theme, monoChoice, sansTone)` 覆盖 `font.family.mono` 和 `font.family.sans`——用预设的系统字体栈，零打包（不内嵌字体文件）。

字体栈在圆心 `src/core/domain/font-presets.ts` 的 `FONT_PRESETS` 单源定义（`src/core/application/theme/merge.ts` 和 `packages/react/src/font-presets.ts` 都从 `@my-harness-desktop/contract` import）。此前发布面名为 `@my-harness-desktop/core`，已改名 `@my-harness-desktop/contract`（commit 04c8a43）。此前双份契约（application 的 `MONO_PRESETS`/`SANS_PRESETS` 与 react 的 `MONO_CHOICES`/`SANS_TONES` 各自硬编码）已收敛到圆心单源，`packages/react/src/font-presets.ts` 只补 UI label。此前双份契约（application 的 `MONO_PRESETS`/`SANS_PRESETS` 与 react 的 `MONO_CHOICES`/`SANS_TONES` 各自硬编码）已收敛到圆心单源，`packages/react/src/font-presets.ts` 只补 UI label。

### 6.3 合并入口

`buildCurrentTheme(themeId, registry, fontScale, fontMonoChoice, fontSansTone)` 是合并入口：主题解析 → 字号倍率 → 字体选择 → 最终 Theme（`Record<string, string>`，token key → CSS 值）。失败回退 `THEME_TOKEN_DEFAULTS`——解析失败不能让界面没有配色。

## 7 i18n 合并

i18n 合并代码在 `src/core/application/i18n/merge.ts`。多个插件的 `languages` 贡献合并成一份 i18next resources。

### 7.1 资源合并

`mergeLanguageContributions(contributions)` 做 key 级合并：不冲突的 key 全保留，冲突的按来源插件优先级取高（project > user > installed > builtin），同优先级先处理者胜。

key 的 namespace 解析：第一个 dot 前是 namespace，无 dot 走 `common`。比如 `app.title` → namespace `app`、key `title`；`appName` → namespace `common`、key `appName`。

resources 文件可以是字符串路径（相对插件目录）或内联对象。字符串路径解析失败（文件不存在/JSON 错/顶层非对象）记 error 并跳过该贡献项——一个坏文件不拖垮整个 i18n。

### 7.2 语言检测和切换

`collectSupportedLngs` 纯动态收集所有贡献项的 locale 去重（此前硬编码 ["zh-CN","zh-TW","en","de"] 兜底已移除）。`collectNamespaces` 纯动态收集 resources 里出现的所有 namespace（此前硬编码 8 个内置 namespace 兜底已移除）。`collectLocaleList` 从合并后的 resources 查 `common.locale.{code}` 拿展示名，缺失回退 locale code 本身——任何贡献的 locale 都进列表，不再被硬编码清单限制。

语言切换不重载——i18next 实例换资源，React 组件自动重渲染。框架管 i18n 初始化和语言切换，插件只管调 `t("key")`。

## 8 安全边界

安全动作分布在各层，圆心不感知。

### 8.1 进程隔离

Electron 的安全配置：`contextIsolation=true`、`nodeIntegration=false`。preload 脚本在隔离上下文跑，通过 `contextBridge.exposeInMainWorld("pi", ...)` 暴露受控对象。renderer（插件代码运行的地方）没有 Node.js 全局——没有 `require`、没有 `fs`、没有 `process`，只有 `window.pi` 上暴露的 API。

### 8.2 权限校验

main 进程在 IPC 边界查 manifest permissions。插件调 `ctx.fs.listDir(cwd)` → preload 的 `ipcRenderer.invoke("fs:listDir", pluginId, cwd)` → main handler 收到后查该 pluginId 的 manifest 是否声明了 `fs:project` → 没声明直接拒绝抛错。当前版本的权限校验只查 manifest 声明，没有用户授权步骤（即没有"用户点击允许"的 UI 流程）——声明了就算授权，没声明就拒绝。后续演进可以加用户授权 UI，但当前是声明即放行。

`config-file:get/set`（通用 JSON 配置读写）有路径白名单门控：只允许 `~/.my-harness-desktop/` 和 `~/.pi/agent/` 前缀内的路径，杜绝任意路径读写。插件的私有数据应走 `ctx.config`（`~/.my-harness-desktop/plugins-data/<id>/`），项目级数据走声明能力（`fs:project`）。

### 8.3 敏感字段过滤

gateway 层的 `event-translator` 是做敏感字段过滤的正确位置——它在协议边界，能拦截底座吐出的所有事件。当前版本未实现过滤逻辑（`translateEvent` 只做 type 映射，字段原样透传），因为过滤需要知道"哪个插件订阅了这个事件"以及"该插件有没有 `content:sensitive` 权限"——这需要 session-store 把订阅者信息传给 translator，留演进。

## 9 QA

**Q：为什么 RPC 适配层不自己 spawn 进程？**

因为构造和执行要分开。rpc-adapter 管的是"怎么收发 JSONL"（协议），spawn 管的是"怎么起进程"（传输）。混在一起的结果是改 JSON 格式要动 spawn 逻辑，改 kill 策略要动 JSONL 解析。分开后，rpc-adapter 持有 `SubprocessHandle` 接口，`client/pi` 提供 `PiSubprocessHandle` 实现——换运行时只换 client 层的实现，protocol 和 application 一行不改。

**Q：为什么 correlator 的超时是 30 秒？**

默认值，可配置。不是"30 秒后底座一定死了"——是"30 秒还没回，调用方不该再挂了"。底座可能还在跑（比如一个长时间的工具执行），超时后 Promise reject 但底座继续。如果后来回了 response，correlator 找不到 pending 条目会静默丢弃。调用方应该自己处理超时后的 UI 状态。

**Q：会话文件被其他程序修改了怎么办？**

SessionStore 不监控文件变化。JSONL 是追加写的，外部修改不会影响正在运行的 pi 进程（它维护自己的内存状态）。但如果用户在文件管理器里手动删了会话文件，会话列表刷新时会少那一条——这是预期行为，SessionStore 不做文件 watch。

**Q：多会话多进程会不会占太多内存？**

每个 pi 进程是一个独立的 Node.js 进程，有自己的 V8 堆。多会话同时活跃确实会占内存。但实际使用中，用户很少同时活跃超过 2-3 个会话——大多数会话是"看过就关"的。SessionStore 不主动杀非激活会话的进程（用户可能正在等它们的结果），但应用退出时 `stopAll` 全杀干净。

**Q：主题合并的环检测为什么是必须的？**

因为主题可以 `base` 继承。如果主题 A base B、B base A，`resolveTheme` 会无限递归。`seen` Set 记录已解析链路，碰到已见过的 themeId 抛错。这是防御性设计——正常使用不会出现环，但恶意或错误配置的插件可能制造环。

**Q：i18n 合并为什么用 key 级合并而不是贡献项级覆盖？**

因为语言槽不是"二选一"——多个插件可以贡献同一个语言的不同 key。比如 i18n 插件贡献 `common.app.title`，sessions-list 插件贡献 `sessions.list.empty`——它们不冲突，都应该保留。只有同一个 key 被多个插件贡献时才需要按优先级取舍。这就是"key 级合并"：字典 union，冲突按优先级。

**Q：敏感字段过滤什么时候实现？**

当前是已知缺口，标注"演进"。实现需要三步：event-translator 拿到订阅者列表和权限信息 → 按 `content:sensitive` 权限决定是否过滤 `content[]`/`toolCalls[].args` → 过滤后的事件才推给 renderer。难点在于 session-store 的 `dispatch` 需要把每个订阅者的权限信息传给 translator，当前 translator 是无状态的纯函数。
