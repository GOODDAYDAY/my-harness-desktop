# sub-agent 插件技术文档

sub-agent 是 my-harness-desktop 的「子 Agent 编排」插件，物理路径 `src/plugins/sessions/sub-agent/`，manifest `id = "sub-agent"`，`tier = "official"`，`version = "0.4.9"`。它的职责一句话：**让父 agent 通过工具调用派活给一批独立的子会话进程，管理父子归属、资源闸、终态闭环，并把子会话在左栏缩进、在时间线出卡片、在输入框置灰**。它不是内核能力，是纯壳插件 + 一段 pi 内核扩展串联既有基础设施拼出来的关系层。

## 1 定位与架构分层

subagent 和普通会话在物理层是同一种东西——都是经 `session-store.spawnSession` 起的独立内核进程、同一套 `RpcAdapter` 绑定、同一条 `stop` 停止链。差异在关系层：**对话是平的，任务是有向的**。普通 session 归用户、开放式对话、无「完成」概念；subagent 归「父 agent 的一次 tool 调用」、有 task 有交付、生命周期从属于父（父 abort 它该 abort、父崩溃它该被收尸）。这层有向关系不是 Session Bus 管的事——bus 是「地址 + 路由 + tap + 房间」的平世界（`src/server/application/sessions/session-bus.ts` 的 `SessionBus` 类从不读父子），而是本插件管的事。

三层架构（设计文档 `docs/design/subagent-scheduling.md` §1.2）：

- **展示层（三槽纯消费）**：`messageRenderers` 出 spawn/done 卡片、`sessionGroupings` 左栏缩进嵌套、`composerPolicies` 子视图灰输入框。机制全由壳的槽机制兑现，插件只声明 manifest + export 组件，零命令式注册。
- **归属编排层（本插件）**：spawn 七步编排、父子映射、资源闸、父死子清、完成转发、对话面板。
- **传输层（Session Bus，一行不改）**：地址路由、tap 闸门、房间 fan-out、完成采集（`agentSettled → collectOutput → session_done`）。

关键工程事实：**编排者住在 renderer 插件**，因为 my-harness-desktop 的 main 侧没有插件机制，renderer 插件是「内容」的唯一合法载体；依赖方向始终是「插件 → IPC → main」，不违反洋葱。编排的关键路径可靠性由「常驻组件」保证——即 `SubAgentSection` 这个 sidebar 常驻挂载件，其 `useEffect` 里挂 `ctx.bus.onMessage` 驱动 orchestrator，这正是设计文档 §7.2「风险一」（三槽组件查表渲染不常驻、没有常驻挂载点就收不到 spawn 请求）的解法。

## 2 代码资产与目录结构

插件目录 `src/plugins/sessions/sub-agent/` 内的文件清单：

- `plugin.json`：manifest，八组槽贡献 + `sessions:bus` 权限 + 配置页声明。
- `core/orchestrator.ts`：编排机制层——状态账、帧路由、终态闭环、公共 helper。纯 TS，`import type { SessionBusMessage, TapFilter, HeaderPatch } from "@my-harness-desktop/shared"`，不 import react、不碰 ctx；全部出站能力经 `OrchestratorPorts` 注入，可裸单测。
- `client/ports.ts`：出站封装，`buildPorts(ctx)` 把 `ctx.bus / ctx.sessions / ctx.configFile` 收敛成 `OrchestratorPorts`——组件不直接碰 IPC 的红线在这里兑现，orchestrator 因此保持纯 TS。
- `renderer/index.tsx`：renderer 入口，`export const channels = ["subagent:dialog"]` + export 五个组件 + `SubAgentSection` 常驻编排宿主。
- `renderer/orchestrator-singleton.ts`：模块级单例，`ensureOrchestrator` 惰性组装、`peekOrchestrator` 读账。
- `renderer/spawn-card.tsx`：`SpawnCard` / `SpawnDoneCard`（messageRenderers 槽组件）。
- `renderer/panel.tsx`：`SubAgentPanel`（sidePanel 状态列表）。
- `renderer/dialog.tsx` + `renderer/dialog-state.ts`：`SubAgentDialog` 对话面板（组件 + 内存态分离）。
- `renderer/settings.tsx`：`SubAgentSettings` 配置页。
- `tools/`：五个 tool 的**接收侧**处理函数（`spawn-subagent.ts` / `list-subagents.ts` / `wait-subagent.ts` / `send-to-subagent.ts` / `abort-subagent.ts`），一文件一 tool。
- `locales/`：四语言 × 两命名空间（`sub-agent` 与 `settings`）文案。

注意区分两处「tools」目录，别混淆：

- `src/plugins/sessions/sub-agent/tools/` 是**编排者侧的请求处理器**——orchestrator 收到 `$bus` 帧后按 `kind` 路由到这里执行编排，是接收方。
- `packages/my-harness-fit-pi-extension/tools/` 是**pi 内核侧的 tool 定义**——`registerTool` 注册给 agent 调用的五个 `ToolDefinition`，是发起方，agent 调用时经 `subagentOpCall` 发 `$bus` 帧给编排者。

本插件目录内**没有** `pi-extension/` 或 `dsh-extension/` 子目录（区别于 CLAUDE.md §7.7 的「四件套」参考实现 `sessions/goal/`）。pi 侧的 agent 能力面收在共享扩展 `packages/my-harness-fit-pi-extension/`（统一了 toolgate / context-probe / bus / subagent / skills 五能力），其中 `subagent.ts` + `tools/*` 是 subagent 能力。这是历史收敛的结果：五能力合并成单一扩展后，subagent 的 pi 侧不再独立成包。契约单源靠一个字符串钉住——`packages/my-harness-fit-pi-extension/runtime.ts` 的 `ORCHESTRATOR_ADDR = "plugin:sub-agent"`，注释明说「= sub-agent 桌面插件的 manifest id」，与 `plugin.json` 的 `id` 字面量同源。

## 3 manifest 与槽位贡献全景

`plugin.json` 的 `contributes` 八组，逐组看形状与语义：

- **`sidebar`**：`{id:"sub-agents", title:"子 Agent", component:"SubAgentSection", order:20, group:"main"}`。这是编排宿主，不是普通列表——`SubAgentSection` 组件在 `renderer/index.tsx` 里 `useEffect` 挂 `ctx.bus.onMessage((msg) => void orch.handleFrame(msg))`，把「渲染 UI」和「驱动编排」两件事塞进同一个常驻挂载点。无活跃子时组件 `return null`，不占左栏。
- **`sidePanel`**：两项。`SubAgentPanel`（`id:"sub-agents-panel"`，order 60）是状态列表；`SubAgentDialog`（`id:"sub-agent-dialog"`，order 70）是对话面板，带 `revealOn:"subagent:dialog"`——见 §10 的声明式揭示。
- **`messageRenderers`**：`{role:"subagent_spawned", component:"SpawnCard"}` 与 `{role:"subagent_done", component:"SpawnDoneCard"}`。契约类型 `MessageRendererContribution`（`packages/shared/src/domain/contributions.ts`）只有 `role` + `component` 两个字段；`role` 是 `NeutralMessage.role`，组件收 `MessageRendererProps = { message: NeutralMessage; streaming: boolean }`（`packages/react/src/index.ts`）。
- **`sessionGroupings`**：`{id:"subagent", parentPathKey:"subagent.parent_session", childLabelKey:"sub-agent.childLabel", childIcon:"git-fork"}`。契约类型 `SessionGroupingContribution` 的字段语义：`parentPathKey` 是 `custom` 域平铺键，值=父会话路径；有此键的 session 被嵌套在父会话下。详见 §8.1 与 §9.1。
- **`composerPolicies`**：`{id:"subagent", customKey:"subagent", readonlyMessageKey:"sub-agent.composerReadonly"}`。契约类型 `ComposerPolicyContribution`：`customKey` 存在即触发只读，数据驱动无需函数；`readonlyMessageKey` 是只读提示的 i18n key。详见 §8.2 与 §9.2。
- **`settings`**：`{id:"sub-agent", component:"SubAgentSettings", configFile:"~/.my-harness-desktop/config/sub-agent.json", configMerge:"deep", order:80}`。`configFile` 声明后框架自动管读/写/dirty/save/拦截；`configMerge:"deep"` 是深合并。
- **`languages`**：8 项——`sub-agent.sub-agent` 与 `sub-agent.settings` 两个命名空间 × zh-CN / zh-TW / en / de 四 locale。契约类型 `LanguageContribution` 的 `resources` 指向相对 JSON 文件。

权限面：`permissions: ["sessions:bus"]`。这是声明能力（CLAUDE.md §8.1），main 进程在 IPC 边界检查。插件经 `ctx.bus` 拿到 `BusApi`（`packages/shared/src/domain/events/session-bus.ts`），未授权时 `ctx.bus` 为空，`buildPorts` 返回 `null`，orchestrator 不建、UI 静默降级（§11）。

## 4 通信底座：Session Bus 子会话 $bus 帧

subagent 不发明协议、不改 bus，流量全走 bus 既有路由，只约定一组私域 `kind`。要读懂编排，先读懂 bus 信封与地址。

### 4.1 信封与地址

`SessionBusMessage`（`packages/shared/src/domain/events/session-bus.ts`）是唯一信封形状，上行请求、下行响应、事件通知全用它：

- `$bus: true`：协议标记，接收方 `JSON.parse` 后判 `$bus === true` 识别。
- `id`：randomUUID，追踪与去重。
- `from`：发送方地址，**由传输层认证不自报**——pi 侧路由器按到达管道覆写，插件侧框架注入 `plugin:<id>`。
- `to`：目标地址，四形态：`session:<key>` | `channel:<name>` | `plugin:<id>` | `"desktop"`（路由器内部 handler）。
- `kind`：开放字符串。总线自产控制帧 `bus_response` + 事件帧七种（`chat`/`task`/`result`/`tap_event`/`session_done`/`peer_joined`/`peer_left`），内容层可自定义。
- `payload` / `timestamp` / `replyTo`（响应帧带，值=原请求 `id`）。

地址构造/判定是纯函数 helper（同文件）：`sessionAddress` / `channelAddress` / `pluginAddress` / `isSessionAddress` / `isChannelAddress` / `isPluginAddress` / `sessionKeyOf` / `channelNameOf`，消费方共享，防各处手拼前缀漂移。

### 4.2 私域 kind 约定

subagent 的私域 kind 表（契约单源：pi 扩展 `runtime.ts` 与插件 `orchestrator.ts` 共用同一份字面量）：

- `subagent_ping`：extension → 插件，探测插件在线（session_start 时），回 `bus_response`。
- `spawn_subagent`：extension → 插件，派活请求，回 `bus_response`（replyTo 配对）。
- `list_subagents`：查我的子全景，回 `bus_response`。
- `wait_subagent`：补等一个子到终态，回 `bus_response`（延迟回）。
- `send_to_subagent`：父对子追加指令，回 `bus_response`。
- `abort_subagent`：中止子，回 `bus_response`。
- `subagent_done`：插件 → 父 extension，子完成异步通知，事件帧无响应。
- `subagent_note`：插件 → 子会话，父追加指令的转发投递，事件帧无响应。

### 4.3 上行链路（agent 调 tool 到编排者执行）

pi 扩展侧：`setupSubagent`（`packages/my-harness-fit-pi-extension/subagent.ts`）在 `session_start` 时先读自己 session 头行判身份（发现 `custom.subagent` 且 `allowSpawn !== true` → 我是子，不注册 spawn 系 tool），否则 `callOrchestrator("subagent_ping", {}, 1500)` 探测——编排者在线才 `registerTool` 五个 tool，裸 pi / 无插件环境优雅退化（ping 无响应即不注册，agent 的 tool 清单里根本没有它）。tool 执行时 `subagentOpCall(kind, payload, timeoutMs)`（`runtime.ts`）→ `callBus(ORCHESTRATOR_ADDR, ...)` → `emitFrame` 往 stdout 写一行 `$bus` JSON 帧。

路由器侧：pi 后端的 `rpc-adapter` 有 `$bus` 分支收帧，转发到 `SessionBus.handleFrame(sessionKey, raw)`（`session-bus.ts` 第 65 行）。`handleFrame` 判 `raw.$bus !== true` 则忽略，然后把 `from` 覆写为 `sessionAddress(sessionKey)`（到达管道绑定的地址，自报值丢弃——§4.4 安全模型），再 `route(message)`。`route` 按 `to` 分派：`to === "plugin:sub-agent"` 命中 `isPluginAddress` 分支 → `sink.broadcast(message)`，经 `session:bus` IPC 广播进 renderer。

renderer 侧：`SubAgentSection` 的 `ctx.bus.onMessage` 回调收到帧，调 `orch.handleFrame(msg)`。`handleFrame`（`orchestrator.ts` 第 152 行）先判 `frame.to !== this.selfAddr`（`selfAddr = "plugin:" + pluginId`，即 `plugin:sub-agent`）——bus 的 `onMessage` 是 plugin 地址帧的广播面，所有 plugin 地址帧都广播，必须按 `to` 自过滤。然后按 `kind` switch 到五个 tool 处理器或 `session_done`。

### 4.4 下行链路（编排者响应回 agent）

编排者执行完，`orch.reply(frame, payload)`（`orchestrator.ts` 第 174 行）调 `ports.bus.send(req.from, "bus_response", payload, req.id)`。`req.from` 是父会话的 `session:<key>` 地址（上行时被路由器覆写），`replyTo = req.id`。路由器 `route` 命中 `isSessionAddress` → `deliver`，`deliver` 按 `message.kind === "bus_response" ? "steer" : "followUp"` 分派 `store.sendPromptTo(key, ...)`——**响应帧用 steer 插队，事件帧用 followUp 排队**（`session-bus.ts` 第 190 行）。父 pi 进程收到 stdin prompt 注入，`my-harness-fit-pi-extension/index.ts` 的单一 input 钩子识别 `$bus` 帧：`kind === "bus_response" && replyTo` 命中 pending Map → `takePending` 吞帧 resolve，tool 返回；否则 `transform` 调 `formatFrame` 人话化进上下文。

`formatFrame`（`runtime.ts` 第 169 行）对 `subagent_done` 人话化为 `【子 agent 完成】任务:<name> 状态:<status>\n<output>`，对 `subagent_note` 人话化为 `【父 agent 追加指令】<message>`，对 `chat` 帧区分 plugin 来源（「来自桌面对话面板的消息——请直接回复」）与房间转发（「有新内容才回复，不回复是合法选项」）。

### 4.5 from 认证与归属校验的安全模型

插件收到的上行帧 `from` 已被路由器覆写为发送方 session 地址，自报值在 `handleFrame` 里丢弃。这是 §4.1 提到的「传输层认证」：伪造在传输层已失效，插件据此校验「子的 parent 必须等于请求方」才可靠。插件发出的帧 `from` 恒为 `plugin:sub-agent`（`pluginSend` 覆写），子的地址放 payload 里。归属校验具体落在 `send-to-subagent.ts` 与 `abort-subagent.ts` 的 `if (!rec || rec.parentAddr !== frame.from)` 分支，以及 `list-subagents.ts` 的 `parentAddr === from` 过滤。

### 4.6 tap 闸门与完成通知

`TapFilter = "done" | "lifecycle" | "stream"`（`session-bus.ts` 共享层）。`lifecycle` 只给五个边界事件（`sessionStart`/`agentStart`/`agentEnd`/`agentSettled`/`messageEnd`），`stream` 给全量增量且**只许 plugin 目标**（`opTapStart` 里 session 目标降级 lifecycle 并告知，`session-bus.ts` 第 398 行）。本插件用两种 tap：`tapStart({session: 父, filter:"done"})` 挂父死监听（§5.4）、`tapStart({session: 子, filter:"stream"})` 挂对话面板的流式进度（§10）。

完成通知：`onSessionEvent` 里 `event.type === "agentSettled"` → `settleSession(sessionKey, "done")`；`settleSession`（`session-bus.ts` 第 453 行）收集 `watchers`（`sessionCreate` 时 `watch:true` 登记的地址）+ 所有 `filter:"done"` 且 target 匹配的 tap 投递地址，调 `collectOutput` 拿完整输出，逐地址发 `session_done` 帧。`collectOutput` 不截断（`getLastAssistantTextFor` 拿全文，进程已死时回退 `readLastAssistantTextFromFile` 读文件尾条 assistant 文本），`sessionPath` 始终带上。

## 5 编排核心：core/orchestrator.ts

`SubagentOrchestrator` 类（`orchestrator.ts`）是本插件的大脑。它把 tool 处理逻辑一文件一个丢进 `../tools/`，自己只装状态账、帧路由、终态闭环、公共 helper。

### 5.1 端口注入与可测试性

`OrchestratorPorts` 接口（第 46 行）聚合三个子端口：

- `BusPort`（第 24 行）：`sessionCreate` / `sessionAbort` / `channelMember` / `tapStart` / `send` / `status`——全是 bus 能力面的窄化。
- `SessionsPort`（第 36 行）：`updateHeader(sessionPath, patch: HeaderPatch)` / `list(cwd)`——会话头行读写。
- `ConfigFilePort`（第 41 行）：`get(path)` / `append(path, entry)`——配置读与 JSONL 追加。
- 另加 `now()` / `uuid()` 两个纯函数注入（可测性：时间与随机数不进 orchestrator）。

`buildPorts(ctx)`（`client/ports.ts`）在组件内经 `usePluginContext` 拿 ctx 后组装：`ctx.bus` 为 null 时返回 null（权限未生效 → 降级）；否则把 `ctx.bus.*` / `ctx.sessions.updateHeader` / `ctx.sessions.list` / `ctx.configFile.get/append` 映射成端口。这层封装的目的是让 `orchestrator.ts` 零 ctx 依赖、零 react 依赖，可裸单测——依赖倒置的形态：接口定义在 `core/orchestrator.ts`（内层），实现在 `client/ports.ts`（外层），组装在 `renderer/orchestrator-singleton.ts`（启动期）。

### 5.2 状态账与配置

内存表四张（第 121–124 行）：

- `subs: Map<string, SubRecord>`——子账，key 是子的 bus 地址（`session:<key>`）。`SubRecord`（第 56 行）含 `addr/key/sessionPath/cwd/parentAddr/parentSessionPath/task/name/status/allowSpawn/spawnEntryId/spawnedAt/finishedAt/batchId/timeoutTimer`。
- `batches: Map<string, BatchWaiter>`——`wait:true` 的批量挂起，key 是请求帧 id。`BatchWaiter`（第 84 行）含 `requestId/from/remaining:Set<string>/results`。
- `waiters: Map<string, Waiter[]>`——`wait_subagent` 的补等挂起，key 是子地址，值是 waiter 数组（同子可并发 wait 多次）。
- `parentTaps: Set<string>`——已挂 done-tap 的父地址，去重（一批只需一个 tap）。

`SubStatus`（第 54 行）七态：`running | done | error | aborted | timeout | spawn_failed | interrupted`。`interrupted` 是懒扫重建时对「进程已随重启死亡但头行仍 running」的归正标记（§7）。

配置 `OrchestratorConfig`（第 97 行）：`maxConcurrent`（默认 5）+ `timeoutMs`（默认 10 分钟），常量 `DEFAULT_ORCHESTRATOR_CONFIG`（第 114 行）。`readConfig()`（第 179 行）**每次 spawn 现场读，不缓存**——配置页保存即生效，免变更通知；读失败回退默认值，数值非法（非有限/非正）也回退默认。

### 5.3 帧路由 handleFrame

`handleFrame(frame)`（第 152 行）是 `bus.onMessage` 的唯一入口。三道闸：`frame.to !== this.selfAddr` 丢弃（插件地址帧广播面的自过滤）、按 `kind` switch 分派、`session_done` 走本层 `onSessionDone`。五个 tool kind 各路由到 `../tools/` 对应文件的 `handleXxx(this, frame)`，`subagent_ping` 直接 `reply {pong:true}`。

### 5.4 终态闭环 settle 与父死子清

子 agent 的终态闭环有一条铁律：**settle 只由 bus 的 session_done 触发，abort/超时/父死都殊途同归到 processExit → settleSession → session_done，不手动补 settle**。`onSessionDone`（第 224 行）拆两路：

- 帧的 `p.session` 命中活跃子账 → `settle(asSub, status, output)`。
- 帧的 `p.session` 命中 `parentTaps` 且 status 为 error/aborted → 父进程死了 → `onParentDead`。

`settle(rec, status, output)`（第 238 行）五步：

1. `isActive(rec)` 幂等闸，非活跃直接返回。
2. `abortReason` 归正：`abortReason === "timeout"` → status 归 `timeout`；有其他 abortReason → status 归 `aborted`。原因：abort/超时/父死都先记 `abortReason` 再 `sessionAbort`，回来后 `session_done` 的 status 只有 error/aborted 两种，真实语义以先记的 `abortReason` 为准。
3. 清超时定时器，写 `finishedAt`。
4. `readSubDomain(rec)` 读最新头行域 → 内存合并 → `updateHeader(sessionPath, {custom:{subagent:domain}})` 整体写回（域级浅合并是整体替换，必须读-改-写）。
5. 三路交付：`configFile.append(父, subagent_done entry)` 落父时间线卡片数据；`bus.send(父, "subagent_done", {...})` 发事件帧给父 agent；`batches`/`waiters` 有挂起则按 requestId 回 `bus_response`。

`onTimeout(addr)`（第 293 行）：先记 `abortReason = "timeout"` 再 `sessionAbort`，abort 失败手动兜底 `settle`。`onParentDead(parentAddr)`（第 302 行）：遍历该父的全部活跃子，逐个记 `abortReason = "parent_crashed"` 再 `sessionAbort`（父已死不再写父 entry，写进死文件无读者）。

## 6 五个 tool 的接收侧实现

每个 tool 处理器一文件一个，签名统一 `(orch, frame) => Promise<void>`，职责是「校验 → 编排 → 回执」。

### 6.1 spawn_subagent（tools/spawn-subagent.ts）

`handleSpawnSubagent`（第 29 行）是七步编排（设计 §3.1）：

1. **整批原子预检（资源闸）**：`normalizeTasks` 归一化 `tasks`（string 简写等价 `{task}`），空批回 `tasks_empty`。然后两道闸——递归权威闸（第 36 行）：请求方在活跃子账上且未声明 `allowSpawn` → 整批拒绝 `spawn_not_allowed`；并发闸（第 42 行）：`activeOfParent.length + tasks.length > cfg.maxConcurrent` → 回 `{error:"max_concurrent", active, requested, limit}` 整批拒绝，要么全起要么不起。
2. **`locateRunning(frame.from)`**（第 49 行）：从 `bus.status()` 的运行中会话清单查父地址的 `{key, cwd, sessionPath}`，查不到回 `parent_not_running`。
3. **挂父 done-tap**（第 52 行）：`parentTaps` 去重，`tapStart({session:父, filter:"done"})`，失败回滚删除。
4. **`Promise.all` 并行起全部子**（第 71 行）：此前 for-await 串行逐个 spawn，每个子 = 一个全新 pi 进程冷启动（1~2s），N 个累加 N 倍；并行后总时长 ≈ 单进程冷启动。并发护栏由第 1 步整批预检兜底，`spawnOne` 内 `batch.remaining/results` 变更在 await 点之间同步，无竞态。
5. **`spawnOne`**（第 83 行）：`sessionCreate({task, cwd, name, model, toolConfig, watch:true, channels})`——`watch:true` 的登记方是插件（session_done 先到插件，插件更新 UI 再转发父）；拿到 `{session, key, sessionPath}`。生成 `spawnEntryId`，建 `SubRecord` 入账，然后**双钥匙写头行**（第 119 行）——`name` 落 `header.name`（列表标题真相源，问题 C6 的根因修复：此前只写 `custom.subagent.name` 导致左侧列表标题退化成 id 前 8 位）+ `custom` 落 `{subagent: domain, "subagent.parent_session": parent.sessionPath}`。追加父 spawn entry（`configFile.append`，`customType:"subagent_spawned"`，content 带 `cwd`——切项目后点旧卡片 reopen 仍能定位工作目录）。起超时定时器，`batch.remaining.add(addr)`。
6. **按 wait 分流回执**（第 75 行）：`wait:false` 立即回 `{subagents: receipts}`；`wait:true` 存 `batches`，`batch.remaining.size === 0` 时立即回，否则 settle 逐个填 `batch.results` 全终态后回。

单个 `sessionCreate` 失败不构成整批失败——该子在返回数组里标 `status:"spawn_failed"`，不阻塞其他。

### 6.2 list_subagents（tools/list-subagents.ts）

`handleListSubagents`（第 9 行）：`orch.getSubs().filter((s) => s.parentAddr === frame.from)` 只列自己的子（from 传输认证后伪造已失效），按 `status` 参数过滤（`active`/`done`/`all`）。完成态带 200 字 `output_preview`，全文经 `session_path` 自读。

### 6.3 wait_subagent（tools/wait-subagent.ts）

`handleWaitSubagent`（第 9 行）：查子账（`unknown_subagent`），已终止立即回当前状态与输出（幂等）；活跃则建 `Waiter` 挂进 `orch.waiters`，由 `settle` 统一唤醒。显式 `timeout_ms` 到点回 `{status:"wait_timeout"}`——子不受影响，结果仍经 `subagent_done` 到达。

### 6.4 send_to_subagent（tools/send-to-subagent.ts）

`handleSendToSubagent`（第 8 行）：三道校验——归属（`rec.parentAddr !== frame.from` → `not_your_subagent`）、活跃（`subagent_finished`）、消息非空（`message_empty`）。通过后 `bus.send(rec.addr, "subagent_note", {text, from_parent})`，deliver 按事件帧 followUp 排队注入子的 stdin，不打断子当前 turn。回 `{delivered:true}`。

### 6.5 abort_subagent（tools/abort-subagent.ts）

`handleAbortSubagent`（第 9 行）：归属校验 + 已终态幂等；通过后 `rec.abortReason = reason ?? "parent_abort"` 再 `sessionAbort`，终态闭环由 `processExit → session_done → settle` 完成，本文件不手动 settle。

## 7 头行双钥匙与状态持久化

子的持久化真相源是 session 文件头行的 `custom-my-harness-desktop.subagent` 域。`SubagentDomain`（`orchestrator.ts` 第 103 行）形状：`{parent_session, spawn_entry_id, task, name, status, allowSpawn, spawned_at, abort_reason?}`。写方=本插件，读方=timeline/sessions-list/本插件恢复。

**双钥匙**（实现期补丁，设计 §6.1）：

- `custom.subagent` 域——`composerPolicies` 的存在性判定（`customKey:"subagent"`）+ 状态持久化。
- 平铺键 `"subagent.parent_session"`——`sessionGroupings` 槽的消费方是平铺直接访问（`custom[parentPathKey]`，无嵌套路径解析），父路径必须作为独立平铺键供它。

两个键各司其职：状态迁移只更新 `subagent` 域，平铺键写一次不变。写头行走 `updateHeader(sessionPath, patch)`，`HeaderPatch.custom`（`packages/shared/src/domain/sessions.ts` 第 174 行）是**域级浅合并**——`{k:v}` 只动 `custom.k`（域内整体替换，不深合并）。所以 `settle` 写 status 前必须 `readSubDomain` 读最新域、内存合并、整体写回，直接写 `{status}` 会抹掉 `parent_session`（设计 §7.2 风险二）。

父会话的 entry 走 `configFile.append(父sessionPath, {type:"custom_message", customType:"subagent_spawned"|"subagent_done", display:true, id:spawnEntryId, content:JSON.stringify({...}), timestamp})`。`custom_message` 是官方公开通道，经圆心 `sessionEntryToNeutral` 提升为 `role = customType` 的 `NeutralMessage` 进时间线（`type:"custom"` 会被圆心过滤——首版 Q18 的教训）。spawn entry 的 `id` 由插件生成而非 bus 生成，因为它要同时出现在父 entry 和子头行两处，两处写都是插件做的，插件生成 UUID 天然两处一致。

重启恢复语义（设计 §3.4）：desktop 重启后进程全死、活跃子为零、内存账清空，但头行 `custom.subagent` 域是持久化真相源。恢复是**懒扫重建**——`list_subagents` / 状态面板 / 对话入口首次访问时对 cwd 会话桶做头行扫描，把 `custom.subagent.parent_session` 归属自己的会话重建进内存账；进程已死但头行仍 `running` 的归正为 `interrupted`。注意：当前代码里懒扫重建落在 `readSubDomain` 的按需读 + `list` 查 `custom` 上，而 `interrupted` 归正的完整实现是设计文档标注的演进态，spawn 卡片靠头行 + entry 双持久化保住「回看」能力。

## 8 展示三槽的消费链路

三处渲染行为全由槽机制兑现，插件只声明 manifest + export 组件。

### 8.1 sessionGroupings → sessions-list 缩进嵌套

链路：manifest `sessionGroupings` → registry `ArraySlot` → IPC `slots.sessionGroupings` → `useSessionGroupings()` hook → sessions-list `buildGroups`/`childrenByParent` 消费。

- 注册侧：`registry.ts` 第 92 行 `private sessionGroupings = new ArraySlot<SessionGroupingContribution>()`，`sessionGroupingItems()`（第 309 行）`all()` 后按 order 升序 + 注入 `pluginId`。
- IPC 侧：`src/server/controllers/slots-dialog.ts` 第 21 行 `gateway.register(IPC.slots.sessionGroupings, () => registry.sessionGroupingItems())`；`src/web/kernel/build-kernel.ts` 第 118 行 `sessionGroupings: () => transport.invoke(IPC.slots.sessionGroupings)`。
- Hook 侧：`packages/react/src/session-groupings.ts` 的 `useSessionGroupings()`——module 级 cache + `pluginsNonce` 失效重拉，返回 `SessionGroupingItem[]`（`SessionGroupingContribution & {pluginId}`）。
- 消费侧：`sessions-list/renderer/index.tsx` 第 345 行 `const groupings = useSessionGroupings()`，第 347 行 `useMemo` 里双层遍历：对每个 `filtered` session，遍历 `groupings`，`const parentPath = s.custom[g.parentPathKey]`，`typeof parentPath === "string" && parentPath` 则 push 进 `children` 并记 `childPaths`；命中一个分组策略即 `break`。第 368 行 `topLevel = filtered.filter((s) => !childPaths.has(s.path))`（子会话从顶层摘除），`childrenByParent = Map<parentPath, ChildSession[]>`。渲染时（第 547 行）`children={query ? undefined : childrenByParent.get(s.path)}`——**搜索平铺态不嵌套**（问题 D10：父子同命中时避免重复显示），非搜索态才按分组嵌套。

### 8.2 composerPolicies → timeline 只读输入框

链路：manifest `composerPolicies` → registry `ArraySlot` → IPC `slots.composerPolicies` → `useComposerPolicies()` hook → timeline `matchedPolicy` 判定 → `readonlyBar`。

- 注册侧：`registry.ts` 第 93 行 `composerPolicies` ArraySlot，`composerPolicyItems()`（第 316 行）同构。
- Hook 侧：`packages/react/src/composer-policies.ts` 的 `useComposerPolicies()`，与 `useSessionGroupings` 完全同构。
- 消费侧：`timeline/renderer/index.tsx` 第 434 行 `const composerPolicies = useComposerPolicies()`；第 438–443 行 `sessionCustom` 从 `useSessionStore((s) => s.sessionInfos)` 取当前会话的 `custom`（不再整份 `ctx.sessions.list` 只为找一条，设计 plugin-decoupling §4.2 收编）。第 451 行 `matchedPolicy = sessionCustom && composerPolicies.length > 0 ? composerPolicies.find((p) => { const v = sessionCustom[p.customKey]; return v !== undefined && v !== null; }) : undefined`——**数据驱动**：条件是 `custom[customKey]` 的存在性，无需函数。第 1047 行 `composer = matchedPolicy ? readonlyBar(t(matchedPolicy.readonlyMessageKey) ?? t("shell.composerReadonly")) : ...`——命中则输入框换为只读提示条。

### 8.3 messageRenderers → SpawnCard / SpawnDoneCard

链路：manifest `messageRenderers` → `registerPluginMessageRenderers`（`packages/react/src/index.ts` 第 430 行，读 `contributes.messageRenderers[].component` 在 module exports 里找同名组件，`asReactComponent` 校验后 `messageRendererComponents.set(item.role, comp)`）→ timeline 渲染 `role === "subagent_spawned"` 的消息时查 `getMessageRenderer` 拿 `SpawnCard` 渲染。

`SpawnCard`/`SpawnDoneCard`（`renderer/spawn-card.tsx`）的关键点：

- `parsePayload` 用 `messageContentText` + `JSON.parse` 解 content；`statusIcon` 按 `SubStatus` 映射 ✅/●/⏳/❌。
- `useSubStatus(addr)`（第 57 行）经 `peekOrchestrator()` 读内存账翻状态——spawn 卡与后续 done 卡按 `subagent` 地址配对，卡片折叠态显示实时 running/done 状态。
- `useSessionMissing(sessionPath)`（第 66 行）读 `useSessionStore((s) => s.sessionInfos)`，判子会话是否已从列表消失（问题 C8 的优雅降级）；`sessionInfos === null` 时不判缺失，避免列表未拉取时误报「已删除」。
- 「打开」调 `ctx.sessions.setContext(cwd, sessionPath)` 切入子会话；「对话」调 `openDialogFor`（§10）。
- `SpawnDoneCard` 的 `sessionPath` 优先取卡片自带 `payload.subagent_session`，回退 `recSessionPathOf(payload.subagent)`（重启后 orchestrator 账本清空，持久化卡片仍可 reopen）。

## 9 与其他插件交互

这是本文必须单列的一节：sub-agent 的三槽贡献全部是「声明给别的插件消费」，它自己不渲染左栏列表、不渲染时间线、不渲染输入框。交互方向是「贡献方（sub-agent）→ 消费方（sessions-list / timeline）」，双向解耦——sessions-list 不认识贡献方（清单来自内核注册表），贡献方不认识 sessions-list。

### 9.1 与 sessions-list：sessionGroupings 消费

sessions-list 是「会话列表」插件（`src/plugins/sessions/sessions-list/`），它贡献 `sidebar` 槽渲染左栏会话列表。sub-agent 通过 `sessionGroupings` 槽向它注入一条分组策略：`{parentPathKey:"subagent.parent_session", childLabelKey:"sub-agent.childLabel", childIcon:"git-fork"}`。

交互的实质是**数据契约 + 查槽**，不是函数调用：

- sub-agent 在 spawn 时往每个子会话头行写平铺键 `"subagent.parent_session" = 父sessionPath`（`spawn-subagent.ts` 第 123 行）。这是贡献方的唯一动作——写数据。
- sessions-list 在渲染时 `useSessionGroupings()` 拉全部策略，`buildGroups` 前先做 `childrenByParent` 归类：命中策略的 session 从顶层摘除、按 `parentPath` 挂到父行下。它完全不知道「这是 sub-agent 的子」，只知道「有个 custom 键的值是某父会话路径」。
- 解耦的证明：sessions-list 的 `Group`/`ChildSession` 类型与 sub-agent 无任何 import 关系；`useSessionGroupings` 的返回类型是 `SessionGroupingContribution & {pluginId}`，来自圆心契约而非 sub-agent 插件。将来有第二个插件声明 `sessionGroupings`（比如「project 分组」），sessions-list 无需改动，循环里多遍历一条策略即可。
- order 语义：`sessionGroupingItems()` 按 `order` 升序，多个策略命中时先匹配 order 小的（`SessionGroupingContribution.order` 注释）。sub-agent 未声明 order，缺省 100。

一个必须写清的边界：**分组是「按父会话路径嵌套」，不是「按 lineage 树嵌套」**。`parentPathKey` 的值是 `SessionInfo.path`（会话文件绝对路径），不是 `neutralSessionId` 也不是内核的 `parentId`。这正是「壳不读内核 fork 语义」的体现——subagent 的父子关系是它自己的有向关系层（落在 custom 域），与 pi 的 `parentId` 树、dsh 的 session forest 都无关。

### 9.2 与 timeline：composerPolicies 只读

timeline 是「时间线」插件（`src/plugins/sessions/timeline/`），贡献 `mainView` 槽渲染会话消息流 + 输入框。sub-agent 通过 `composerPolicies` 槽注入一条策略：`{customKey:"subagent", readonlyMessageKey:"sub-agent.composerReadonly"}`（文案「子 agent 会话,输入不可用」）。

交互同样是纯声明 + 数据驱动：

- sub-agent 在 spawn 时写子头行 `custom.subagent` 域（`spawn-subagent.ts` 第 123 行的 `custom: {subagent: domain, ...}`）。域的存在本身就是信号——只要 `custom.subagent` 有值，timeline 就认定「这是子会话，输入框只读」。
- timeline 第 451 行 `matchedPolicy` 的判定是 `sessionCustom[p.customKey] !== undefined && !== null`——**不比较值内容，只判存在性**（`ComposerPolicyContribution.customKey` 注释「存在即触发只读，数据驱动：key 在 session.custom 里有值就匹配」）。sub-agent 的 `custom.subagent` 域是对象，`{parent_session, task, ...}`，值具体是什么 timeline 根本不看。
- 命中后 timeline 第 1047 行把 Composer 换成 `readonlyBar`，文案走 `t(matchedPolicy.readonlyMessageKey)`，未提供则回退 `t("shell.composerReadonly")`。
- 「只读」的边界要写清：它只灰掉「子会话自己时间线」的输入框，不禁止用户与子对话——用户对话发生在 sidePanel 的 `SubAgentDialog` 独立面板（§10），那是另一个窗口，与子视图的只读态不冲突。设计 §6.5 明确「子视图 composerPolicies 只读条保留，用户的对话发生在面板这个独立窗口」。

交互里有个值得注意的**多策略仲裁**：`composerPolicies.find(...)` 取第一个命中的策略（数组已按 order 升序），多个策略同时命中时 order 最小者胜。当前只有 sub-agent 一个贡献方，这个仲裁逻辑是 `ComposerPolicyContribution.order` 注释声明的通用语义，不是 sub-agent 特判。

### 9.3 与 pi 内核扩展 my-harness-fit-pi-extension

这是「壳插件 ↔ 内核插件」的跨层交互，sub-agent 是典型样本。方向是双向的：

- **内核侧 → 壳插件**：pi 扩展的 `setupSubagent`（`subagent.ts`）在 agent 调 tool 时经 `callOrchestrator` 发 `$bus` 帧（`to:"plugin:sub-agent"`），经 stdout → rpc-adapter `$bus` 分支 → `SessionBus.handleFrame` → `sink.broadcast` → `ctx.bus.onMessage` → `orch.handleFrame`。这条链上 pi 扩展不知道壳插件的存在形态（只认 `ORCHESTRATOR_ADDR` 字符串），壳插件不知道 pi 扩展的内部实现（只收标准 `$bus` 帧）。
- **壳插件 → 内核侧**：编排者的 `reply` 发 `bus_response`（steer 插队）、`subagent_done`/`subagent_note` 发事件帧（followUp 排队），经 `deliver` → `sendPromptTo` → 父/子 pi 进程 stdin → 扩展的单一 input 钩子吞帧 resolve 或 transform 人话化。

契约单源的落点：`ORCHESTRATOR_ADDR = "plugin:sub-agent"`（`runtime.ts` 第 95 行）与 `plugin.json` 的 `id` 字面量同源；私域 kind 字面量（`subagent_ping`/`spawn_subagent`/...）在两处共用同一份字符串。没有任何类型 import 跨「壳插件 ↔ 内核扩展」——pi 扩展手写窄结构 `BusFrame`（`runtime.ts` 第 76 行，注释「类型不 import 官方 pi 包，手写窄结构」），壳插件用 `SessionBusMessage`（圆心契约），两者经 JSON 传输形状对齐，不共享 TS 类型。

「子身份自感知」是体验层不是安全边界（设计 §4.3）：子扩展 `session_start` 读自己头行 `custom.subagent`，`allowSpawn !== true` 则不注册 spawn 系 tool。存在竞态——`sessionCreate` 先注入 task、插件后才 `updateHeader`，子的 session_start 可能早于头行写完，此时子误注册 tool；但 agent 真调了会被插件权威闸（`spawn-subagent.ts` 第 36 行）拒绝，所以自感知只是让 tool 清单干净，不是安全边界。

### 9.4 与 session-bus（机制层交互）

session-bus 不是壳插件，是 application 层机制（`src/server/application/sessions/session-bus.ts`），但它是 sub-agent 的全部通信底座，交互关系必须写清。sub-agent 对 bus 的依赖面是 `BusApi`（`packages/shared/src/domain/events/session-bus.ts` 第 100 行）的七个方法：`status` / `send` / `sessionCreate` / `sessionAbort` / `channelMember` / `tapStart` / `tapStop` / `onMessage`。sub-agent 用其中的 `sessionCreate`（watch:true 起子 + 登记完成通知）、`send`（回执/事件帧）、`sessionAbort`（杀子/超时/父死清）、`tapStart`（父 done-tap + 对话面板 stream-tap）、`tapStop`（对话面板关闭）、`status`（locateRunning / isSessionOnline）、`onMessage`（收帧）。

反过来，bus 对 sub-agent **一无所知**——`SessionBus` 类的 `route`/`deliver`/`settleSession` 里没有任何 subagent 分支，`kind` 是开放字符串、`payload` 是 unknown。这是「机制 vs 内容」分界的正样本：bus 管「平的世界」（地址+路由+房间+tap+完成采集），subagent 的「有向关系层」（归属/任务契约/生命周期从属/资源闸）全在插件里，一行不焊进 bus。

### 9.5 revealOn 与事件总线（subagent:dialog）

`SubAgentDialog` 的 sidePanel 贡献项声明 `revealOn:"subagent:dialog"`，插件 `renderer/index.tsx` 第 13 行 `export const channels = ["subagent:dialog"]`，`openDialogFor`（`dialog-state.ts` 第 105 行）`ctx.events?.emit("subagent:dialog")`。三者同值，构成声明式揭示：框架经事件总线 tap 侦听该 channel 的 emit → 展开右面板并激活「对话」Tab（`SidePanelContribution.revealOn` 注释「该 channel 被 emit/invoke 时框架展开右面板并激活本 Tab」）。插件代码不出现自己的 contribution id，框架居中撮合——这是 §3 里 `revealOn` 声明式揭示的完整闭环。

## 10 对话面板与续聊

对话面板是「对话范式转向」的核心（设计 §6.5）：用户经 sidePanel 与任意会话（含已完成 subagent）来回对话，终结「只能拉新的」。机制全部走既有 bus 能力，不动内核。

`dialog-state.ts` 是内存态 + 订阅模型，`dialog.tsx` 只读快照渲染。关键函数：

- `openDialogFor(ctx, target)`（第 98 行）：单调序号 `openSeq` 互斥（快速连开多个目标后发者胜，先发者放弃）；停旧 tap → 设目标 → `events.emit("subagent:dialog")` 揭示 → 历史载入（`ctx.sessions.openSession(target.sessionPath)` 纯文件读，取最近 30 条 user/assistant）→ 离线则 `session_reopen` 续上下文 → `tapStart({session, filter:"stream"})` 起流式 tap。
- `callDesktopOp(ctx, kind, payload, timeoutMs)`（第 71 行）：发 `bus.send("desktop", kind, payload, id)`，`pendingOps` 挂起等 `bus_response` 按 `replyTo` 配对（插件面没有 direct op 封装，统一走 `bus.send("desktop",...)`）。
- `isSessionOnline`（第 88 行）：`bus.status()` 的运行中清单里查 `addr`。
- `sendDialogMessage`（第 150 行）：`bus.send(target.addr, "chat", {text})` → 路由器 deliver → 目标会话 input 钩子 transform（`formatFrame` 对 plugin 来源区分「请直接回复」）→ followUp 排队注入，不打断目标当前 turn。
- `handleBusMessage`（第 175 行）：先处理 `bus_response` 配对（`replyTo` 命中 `pendingOps` → resolve）；再处理 `tap_event`（按 `tapId` 过滤 → `messageStart` 开流式气泡 / `messageUpdate`/`messageEnd` 更新文本 / `agentStart`/`agentSettled` 翻 busy）。
- `closeDialog`（第 142 行）：`openSeq += 1` 使 in-flight 的 open 放弃，`tapStop` 停 stream tap，清状态。onMessage 监听保持挂载（下次打开复用）。

生命周期纪律（§3.6 idle 回收）：面板关闭时除 `tapStop` 外，若目标会话无其他消费者则 `sessionAbort` 停进程——对话结束进程即释放，不累积（每个 done 子进程 100MB+ 内存）。`session_reopen` 起的进程同样受面板生命周期约束。`opSessionReopen`（`session-bus.ts` 第 348 行）有路径圈禁：只允许 `~/.pi/agent/sessions/` 下的会话文件（reopen 把文件内容读入上下文，越界是信息泄露）。

## 11 配置、权限与降级

- **配置**：`SubAgentSettings`（`settings.tsx`）只渲两个数字输入——`maxConcurrent`（默认 5，min 1 max 20）与 `timeoutMinutes`（默认 10，min 1 max 120），`onChange({...(config ?? {}), [key]: value})` 报改动，框架设 dirty、弹保存浮层、写回 `~/.my-harness-desktop/config/sub-agent.json`（`configMerge:"deep"`）。orchestrator 不缓存配置，每次 spawn `readConfig` 现场读。
- **权限**：`sessions:bus` 声明能力。未授权时 `ctx.bus` 为空，`buildPorts` 返回 null → `ensureOrchestrator` 返回 null → `SubAgentSection`/`SubAgentPanel` `if (!orch) return null` 静默降级。这不是「静默缺面」——权限是用户显式授予的能力边界，插件功能受限但不崩溃（CLAUDE.md §10 QA「声明了权限但用户不授权」）。
- **pi 扩展优雅退化**：`setupSubagent` 的 ping 探测编排者在线才注册 tool；编排者不在（插件未装/未在线/无 `sessions:bus` 权限）→ agent 的 tool 清单里根本没有 spawn_subagent，裸 pi / 无插件环境同理。

## 12 QA

**Q1：插件没装或没在线时，agent 调 spawn_subagent 会怎样？**
调不到。pi 扩展 `setupSubagent` 先 `subagent_ping` 探测 `plugin:sub-agent`，无响应即不注册五个 tool——agent 的 tool 清单里根本没有它。`plugin` 地址无订阅者即弃恰好构成探测语义：帧发出去没订阅者，`callOrchestrator` 超时 reject，`subagentOpCall` 捕获后把错误文本化返回（`runtime.ts` 第 156 行），agent 拿到错误自己决策。裸 pi、无 `sessions:bus` 权限、插件被禁用，三态同理优雅退化。

**Q2：为什么不直接把 spawn 逻辑加进 session-bus 的 desktop op？**
因为 bus 管「平的世界」（地址+路由+房间+tap），父子是有向关系层。加进 bus 就把「归属」这个内容层语义焊进传输层，聊天室等 bus 的其他使用场景被迫带着它跑。分层让两侧独立演化：bus 升级不动 subagent，subagent 换语义不动 bus。`SessionBus` 类里没有任何 subagent 分支就是这条边界的实证——它只认 `kind` 开放字符串与 `payload` unknown。

**Q3：子 agent 的进度，父 agent 和用户分别怎么看？**
分两侧。父 agent 看不到中间流——bus 完成通知模型（不转中间流，一次性交付完整输出，`settleSession` → `collectOutput` 全量不截断），agent 间上下文隔离比「实时感」值钱。用户经对话面板（§10）的 `tapStart({filter:"stream"})` 看到流式进度——`stream` 的正当消费者是 plugin（`opTapStart` 的 `stream` 只许 plugin 目标）。agent 看 agent 只吃完成态，人看人走面板，两套不冲突。

**Q4：用户能直接给子 agent 发消息吗？**
能，经对话面板。旧设计禁止是过度防御——用户是父 agent 的主人，用户与子协作是最终所有权。协调手段天然存在：对话消息 followUp 排队不打断子的 turn、`formatFrame` 对 plugin 来源的 chat 帧区分「请直接回复」、对话记录不落父时间线（不污染父上下文）。子视图的 composerPolicies 只读条保留——那是「子会话自己时间线」的只读态，用户的对话在面板这个独立窗口，两者不冲突。

**Q5：父死子清和超时闸，哪个先触发？**
看谁先到。超时闸（`onTimeout`）到点先记 `abortReason = "timeout"` 再 `sessionAbort`；父死（`onParentDead`）先记 `abortReason = "parent_crashed"` 再 `sessionAbort`。两条路都殊途同归到 `processExit → session_done → settle`，`settle` 里 `abortReason` 归正（第 242 行）：有 `abortReason === "timeout"` 归 timeout，有其他 abortReason 归 aborted。真实语义以先记的 abortReason 为准，因为回来后的 `session_done` status 只有 error/aborted 两种。

**Q6：为什么 spawn entry 的 id 由插件生成，而不是 bus 生成？**
双向关联的锚需要同时出现在父 entry（`configFile.append` 的 `id`）和子头行（`custom.subagent.spawn_entry_id`），两处写都是插件做的——插件生成 UUID 天然两处一致。bus 不知道 `spawn_entry_id` 的存在（它是 subagent 私域概念），bus 的 `sessionCreate` 返回 `{session, key, sessionPath}`，没有 spawn entry 的概念。

**Q7：多个父 agent 同时派活，资源闸会互相挤占吗？**
不会。`maxConcurrent` 按父隔离计数（`spawn-subagent.ts` 第 42 行 `activeOfParent` 只过滤 `parentAddr === frame.from`）——一个父的 fan-out 不影响另一个父的额度。全局并发（跨父的总子进程数）当前不设闸：pi 进程即会话进程，总量受 desktop 既有会话管理约束（`stopAll` 停全部）。

**Q8：批量 wait 时一个子失败，其他子等不等？**
等「全部终态」不是「全部成功」。`settle` 里 `done/error/aborted/timeout/spawn_failed` 都算终态，`batch.results.push({subagent, status, output})`，失败项带各自状态如实返回；`batch.remaining.size === 0` 才回一次 `bus_response`。fork-join 的正常语义——一个失败不阻塞其他，也不让父为一个失败饿死整批。
