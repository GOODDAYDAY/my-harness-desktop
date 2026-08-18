# 011 Subagent：壳编排的子代理机制

pi 核心没有 sub-agent——这是刻意的设计决策，不是功能缺口（`session-bus.md` §1.1）。pi 的哲学是"要就自己去扩展"：核心只给四个工具（read/write/edit/bash），其余一切能力外挂。my-harness-desktop 作为壳，手里同时跑着多个 pi 子进程，天然是做多会话规划的那一层。本文讲子代理是怎么在壳层实现出来的：边界在哪、谁编排谁、能力怎么裁、结果怎么回。

> 本文是 `subagent-scheduling.md` 到代码的落地展开。那篇设计文档规划了完整机制（五个 tool + 编排七步 + 展示三槽 + 资源闸），代码已全部落地。本文讲"是什么、为什么、怎么工作"，不重复设计文档的细节参数；读者需要具体参数时直接读 `subagent-scheduling.md`。

## 1 定位：不是底座功能

### 1.1 底座不应该有多会话概念

pi 的设计基线是"把一个会话管到极致"。它不感知其他 pi 进程的存在，不和别的会话通信，不区分会话身份——因为不应区分。多会话能力**不该进 pi 核心**：给会话 A 装上"和会话 B 说话"的能力，这件事的正确落点不在那个会话内部，在看得见所有会话的那一层。

my-harness-desktop 恰好就是看得见所有会话的那一层。它的 session-store（`src/core/application/sessions/session-store.ts`）持有 `procs = Map<string, SessionProc>`——每个 SessionProc 绑一条 pi 子进程的 stdin/stdout。多个会话同时活着互不干扰。多进程调度的物理基础全在，缺的是逻辑层：进程之间不可寻址。

Session Bus（`docs/desktop/001-session-im.md`、`docs/design/session-bus.md`）补上了地址与路由，让会话变成了可寻址的用户。Subagent 在这之上的定位是：**把会话的"平级并列"关系升级为"父子有向"关系**，让一个 agent 能把活外包出去、等结果、纠偏、收尸——像一个工头指挥工人。

### 1.2 什么是 subagent，什么不是

subagent 和普通会话在物理层是同一种东西——都是 `pi --mode rpc` 独立进程，经同一个 `sessionCreate` 起、同一套 RPC 适配器绑、同一条 stdin→SIGTERM→SIGKILL 停。差异在关系层：

- subagent 不归用户，归父 agent 的一次 tool 调用。它的存在理由是"完成一个 task，产出 result 交付父"——不是开放式对话。
- 生命周期从属：父 abort 它该 abort，父崩溃它该被收尸。
- 上下文关系：subagent 只给父留一张卡片（spawn entry），父不给子共享自己的上下文。
- UI 地位：缩进在父下（左侧栏 `sessionGroupings` 槽）、输入框灰色（`composerPolicies` 槽）。
- 并发需要治理：人开几个会话心里有数，LLM fan-out 会失控，所以有资源闸。

物理平等 + 关系有向——两个维度缺一不可。bus 已经把"通信"做成了平的世界（地址 + 路由，不管父子）；subagent 加的是"归属"这个关系层：**`spawn_subagent = session_create + watch + 归属持久化 + 父死子清 + 资源闸 + spawn entry 落盘`**。

## 2 架构：三层各管各的

```
展示层 —— 三槽纯消费（机制已就绪，插件只声明）
  messageRenderers: spawn 卡片（role=subagent_spawned/done）
  sessionGroupings:  左侧栏按 custom.subagent 缩进嵌套
  composerPolicies:  子会话视图灰输入框

归属编排层 —— sub-agent 桌面插件（本文主角）
  spawn 七步编排 / 父子映射 / 资源闸 / 父死子清 / 完成转发

传输层 —— Session Bus（已落地，不管父子，一行不改）
  地址 + 路由 + tap + 房间 + 完成采集（agentSettled→输出）
```

**编排者住在 renderer 插件**。my-harness-desktop 的 main 侧没有插件机制，renderer 插件是"内容"的唯一合法载体。subagent 的父子归属是内容不是机制，所以编排逻辑住 renderer 插件——依赖方向始终是插件→IPC→main，不违反洋葱。常驻性靠 sidebar 槽解决：SubAgentSection 组件挂载后 `useEffect` 里挂 `bus.onMessage` 驱动 orchestrator，组件常驻 = 订阅常驻——这是设计 §7.2 风险一的解法，代码在 `src/plugins/sessions/sub-agent/renderer/index.tsx:23-31`。

## 3 编排核心：SubagentOrchestrator

编排核心在 `src/plugins/sessions/sub-agent/core/orchestrator.ts`。纯 TypeScript——不 import react、不碰 ctx，全部出站能力经 `OrchestratorPorts` 接口注入（`src/plugins/sessions/sub-agent/client/ports.ts` 把 PluginContext 适配成 ports）。

### 3.1 状态账

```typescript
// orchestrator.ts:124-129
readonly subs = new Map<string, SubRecord>();   // 全部子（含历史的 done/aborted/timeout 态）
readonly batches = new Map<string, BatchWaiter>(); // wait:true 的批，全终态后一次回
readonly waiters = new Map<string, Waiter[]>();    // wait_subagent 补等的挂起方
readonly parentTaps = new Set<string>();            // 已 tap 的父地址（去重，一批一个）
```

`SubRecord`（orchestrator.ts:56-74）记录每个子的全部元数据：地址、sessionPath、父地址、任务、状态、spawn_entry_id、超时定时器等。内存账是活跃期的唯一真相源；头行持久化是死后的墓碑。

### 3.2 spawn 七步

入口 `handleSpawnSubagent`（`tools/spawn-subagent.ts`），对 `tasks` 数组整批执行：

1. **递归权威闸**：请求方在活跃子账上且未声明 `allowSpawn` → 拒绝（`spawn_not_allowed`）。这是递归控制的三层防线的最外层，在插件层执行，零竞态（spawn 编排先于子运行，账上信息确凿）。代码在 `spawn-subagent.ts:36-39`。
2. **资源闸（整批原子预检）**：`活跃数 + 本批数量 > 上限` → 整批拒绝 `max_concurrent`——要么全起要么不起。代码在 `spawn-subagent.ts:42-47`。配置从 `~/.my-harness-desktop/config/sub-agent.json` 读（默认上限 5，默认超时 10min），每次 spawn 现场 `readConfig()` 读，不缓存。
3. **逐个子起进程**：`orch.ports.bus.sessionCreate({task, cwd, toolConfig, watch:true})`。watch 登记方是插件——子完成时 `session_done` 先到插件，插件在链上更新 UI 再转发父。单个 spawn 失败标记 `spawn_failed`，不构成整批失败。
4. **逐个子生成 spawn_entry_id**（UUID），双向关联的锚。
5. **逐个子写头行**：`updateHeader(custom: {subagent: domain, "subagent.parent_session": parentPath})`——两把钥匙各司其职（`subagent` 域供 composerPolicies 判定 + 状态持久化，平铺键供 sessionGroupings 槽直接访问）。
6. **父死子清 + 超时闸**：tap 父会话（filter=done），父进程死亡时 `onParentDead` 逐个 abort 活跃子。逐个子挂超时定时器（到点 `onTimeout` 记 `abortReason` 后 abort，settle 走 session_done 闭环）。
7. **按 wait 分流回执**：`wait:false` → 立即回 receipts（status=dispatched）；`wait:true` → 存 batch waiter，全终态后一次回全部结果。

### 3.3 终态闭环

settle 的触发源只有一个：bus 的 `session_done` 事件。abort、超时、父死都殊途同归到 `processExit→settleSession→session_done`，不手动补 settle。`orchestrator.settle()`（orchestrator.ts:242-293）执行六件事：

1. 更新 rec 状态与 output
2. 清超时定时器
3. 写回头行（先读最新 domain → 内存合并 → 整体写回）
4. 追加父会话 `subagent_done` entry（custom_message，供 messageRenderers 渲染 done 卡片）
5. 向父地址发 `subagent_done` 总线帧（含完整输出）
6. 补 batch waiter 结果 / resolve 补等方（wait_subagent）

## 4 展示：三槽声明式，插件零命令式代码

全部展示依赖三个内核槽位，插件在 `plugin.json`（`src/plugins/sessions/sub-agent/plugin.json`）里静态声明，零命令式注册代码：

```json
{
  "messageRenderers": [
    {"role": "subagent_spawned", "component": "SpawnCard"},
    {"role": "subagent_done",     "component": "SpawnDoneCard"}
  ],
  "sessionGroupings": [
    {"id": "subagent", "parentPathKey": "subagent.parent_session",
     "childLabelKey": "subagent.childLabel", "childIcon": "git-fork"}
  ],
  "composerPolicies": [
    {"id": "subagent", "customKey": "subagent",
     "readonlyMessageKey": "subagent.composerReadonly"}
  ]
}
```

父会话 timeline 的 spawn 卡片：由 `subagent_spawned` / `subagent_done` 两条 custom_message entry 数据驱动，经 `messageRenderers` 槽匹配到海螺的 SpawnCard/SpawnDoneCard 组件渲染——任务名 + 状态灯 + 输出预览 + "打开"按钮（跳到子会话视图）。

左侧栏：`sessionGroupings` 槽读到头行平铺键 `subagent.parent_session` 等于某父 sessionPath 的子，自动缩进嵌套在该父会话下方。

子会话视图：`composerPolicies` 槽看到头行 `subagent` 域存在，输入框替换为只读提示条——子不归用户，直接输入会产生指令冲突。

## 5 能力裁减：子代理的工具限制

### 5.1 机制三条线，互不依赖

子代理的工具限制不走新机制——spawn 时 `toolConfig` 经 `updateSessionHeader` 写进子头行的 `toolConfig.enabledToolIds`（`spawn-subagent.ts:91`，传到底层 `sessionCreate` 的 `toolConfig` 参数）。生效路径分两路：

- **主路径——tool-gate 底座扩展硬过滤**（已落地）。`client/pi/toolgate-installer.ts` 在 desktop 启动时把 `packages/toolgate/index.ts` 同步到 `~/.pi/agent/extensions/tool-gate/`。扩展挂 `turn_start` 事件，读自己会话头行的 `toolConfig.enabledToolIds`，调 `pi.setActiveTools` 强制过滤——LLM 试图调未列出的工具时底座直接拒绝。参考 `docs/design/tool-manager-design.md` §2.4 的 v3 段。

- **降级路径——prompt 注入软过滤**。tool-gate 未装时，timeline 的 `send()` 在正文前拼 `[System]` 指令告诉模型可用工具范围，LLM 可能不遵守。代码在 `tool-manager-design.md` §3.2 的 `buildToolLimitNote` 逻辑。renderer 经 `kernel.toolgateAvailable` IPC 探测扩展可用性后决定走哪条路。

- **递归控制三层防线**（`subagent-scheduling.md` §4.3）：插件权威闸（spawn 时查 `allowSpawn`，代码在 `spawn-subagent.ts:36-39`）→ extension 自感知（子发现自己是子且无 allowSpawn 则不注册 spawn 系 tool，体验层）→ toolConfig 过滤（父不传 spawn 系工具，兜底）。

### 5.2 典型配置场景

只读分析型子 agent（审查者）不给 `bash`/`write`/`edit`/`spawn`：
```json
{"mode": "custom", "enabledToolIds": ["read", "find", "grep", "ls"]}
```

编排者会话只给编排工具，不给 read/bash——防 LLM 绕开编排自己干活：
```json
{"enabledToolIds": ["session_create", "channel_member", "tap_start", "tap_stop", "session_abort", "bus_status", "spawn_subagent", "list_subagents", "wait_subagent", "abort_subagent"]}
```

全权委托型不传 `toolConfig`——子继承完整工具集（v7 起无 mode 字段，enabledToolIds 在场即过滤）。

## 6 消费者

### 6.1 blind-review：串行蓝队，不经过 sub-agent 编排

`src/plugins/insight/blind-review/` 是 subagent 模式的独立消费者——它**不走** sub-agent 插件的编排管线，而是自己直接管理会话启停。这和 sub-agent 插件是两套独立的消费者模式，证明"子代理"不只有一种用法。

盲审流程在 `client/squad-runner.ts` 的 `runSquad()` 中：

1. 逐队 `ctx.sessions.setContext(cwd, null)` 开全新会话——null 停掉旧进程、确保零历史上下文（信息屏障的物理保证）。注意这和 sub-agent 插件走 `bus.sessionCreate` 不同：blind-review 用的是内核的 `setContext` API，每队轮换激活会话——串行，因为单激活会话进程模型同时刻只有一条生成在跑。
2. `ctx.messaging.prompt(assembledPrompt)` 发审查指令。
3. `waitStreamCycle()` 事件驱动等完成——通过 `useSessionStore.subscribe` 监听 streaming 回落 + 末条 assistant 非 pending 即完成，不轮询不 sleep。10min 超时仅作保险丝。
4. `ctx.maintenance.getLastAssistantText()` 收报告文本。
5. `ctx.sessions.renameSession(path, "[盲审] 队名")` 打标记（best-effort）。
6. 全部蓝队跑完 + 至少一队成功 → 裁判会话（同流程，输入 = 被审内容 + 各队报告拼装）。
7. `finally` 里 `ctx.sessions.setContext(cwd, originalPath)` 恢复原会话。

盲审的"每队一个新会话"模式用同一套内核能力（`setContext`/`prompt`/`getLastAssistantText`）实现了子代理语义，但它不需要 sub-agent 插件的编排层——因为它的编排是固定流程（固定串行 + 固定裁判），不需要 LLM 动态决策拓扑。

**设计文档与代码的漂移**：`blind-review.md` §3.4 描述的是"每队 setContext null→prompt→等生成→收报告"的流程，代码已落地。但那份设计文档写于 sub-agent 插件之前，提到"审查会话的进程是临时工"——这个描述在 sub-agent 插件落地后应更新为"sub-agent 插件提供了另一种通用的子代理调度方式，blind-review 走的是更轻量的直接 session 管理路径"。

### 6.2 llm:oneshot：无会话的一次性问询

`src/client/pi/pi-oneshot.ts` 是另一个独立机制——spawn 一个 `pi -p --no-session --no-tools <prompt>` 一次性进程，拿 stdout 文本。特点：

- `--no-session`：不落会话文件。
- `--no-tools`：禁用全部工具，纯推理。
- 走 permissions `llm:oneshot` 门控（IPC 边界检查）。
- prompt 内容由调用方插件拼装——机制与内容分离。

与 sub-agent 的区别：oneshot 是"问一句拿答案"的轻量操作，无会话生命周期、无文件持久化、无工具调用。sub-agent 是有完整会话文件、可跨 turn 执行、可被监控的持久计算单元。两者在同一体系内分工不同——oneshot 管一次性推理（如 git-review 的 commit message 生成），sub-agent 管跨 turn 的委托任务（如 blind-review 的蓝队审查）。

### 6.3 review 插件：人的内联批注，不是 agent

`docs/design/review-plugin.md` 里的 review 插件管的是"人在会话里对模型产出做选区批注"——选中原文片段、写意见、随下一条消息发出。它是**人对模型的反馈通道**，不是 agent 对 agent 的编排。和 blind-review（agent 审查代码）、sub-agent（agent 委派任务）是不同正交维度。四者在名称上沾边但职责各不相干。

## 7 结果回流通道

### 7.1 sub-agent 插件：总线帧 + custom_message entry 双通道

子完成时 settle 产生三条信息流：

1. **`subagent_done` 总线帧** → 发给父 agent 的 pi 进程（经 prompt 注入，extension 识别 `$bus` 信封后 transform 人话化进上下文：`【子 agent 完成】任务<name> 状态<status> …`）。父 agent 收到后自行决策：汇总、继续派活、向用户汇报。代码在 `orchestrator.ts:266-268`。

2. **`subagent_done` custom_message entry** → 追加到父会话 JSONL 文件尾部，供 timeline 渲染 done 卡片（content 含 subagent 地址、name、status、output_preview）。代码在 `orchestrator.ts:260-264`。

3. **状态面板**（SubAgentPanel）——实时展示活跃子列表（任务/状态/耗时）、abort 按钮。消费者是用户，经 `orch.onChange` 订阅通知机制更新（`orchestrator-singleton.ts` → `renderer/index.tsx:26` 的 `setVersion` 触发重渲染）。

### 7.2 blind-review：面板聚合，会话文件存原报告

- 每份蓝队报告天然落在各自的 `[盲审]` 会话 JSONL 文件里（`squad-runner.ts:116` 的 renameSession 打标记），长期可溯。
- 裁判汇总报告在面板内展示（折叠可展开各队原始报告）。面板不持久化——重开面板结果清空，回看历史去 sessions-list 找 `[盲审]` 会话。
- 裁判报告**不进**父会话上下文——blind-review 的审查是用户显式发起的重操作，审查结果给用户看，不给当前会话的 agent 看（审查的目标往往就是这个 agent 自己的产出，自评没有意义）。

### 7.3 oneshot：纯 stdout 文本

`pi-oneshot.ts` 的 `runPiOneshot()` 返回 `Promise<string>`——stdout 的纯文本输出。调用方（如 git-review 的 commit message 生成）自己在组件内用这个文本，不落任何会话文件。

## 8 落地状态

### 已落地

- **sub-agent 插件**（`src/plugins/sessions/sub-agent/`）：全部五个 tool（spawn/list/wait/send_to/abort）+ orchestrator（spawn 七步、状态机、资源闸、父死子清、超时闸）+ 五槽位声明（sidebar/sidePanel/messageRenderers/sessionGroupings/composerPolicies）+ settings 配置页。详见 `subagent-scheduling.md` 的全部设计参数——本文不重复。
- **sessionGroupings、composerPolicies 槽位**：内核已实现，sub-agent 插件通过 manifest 声明消费。
- **messageRenderers 槽位**：SpawnCard/SpawnDoneCard 组件已在 `renderer/spawn-card.tsx` 实现。
- **tool-gate 底座扩展**：`packages/toolgate/index.ts` + `client/pi/toolgate-installer.ts`，启动时同步进 `~/.pi/agent/extensions/tool-gate/`，挂 `turn_start` 读头行 `toolConfig.enabledToolIds` 调 `setActiveTools` 硬过滤。与 tool-manager 插件（右面板开关写头行 + onSend flush 落盘）配合形成完整闭环。
- **Session Bus**（`src/core/application/sessions/session-bus.ts`）：地址、路由、tap、房间、`session_create`、`session_done`——sub-agent 的全部通信底座。
- **bus-extension**（`packages/bus-extension/index.ts`）：注册 bus 六件 tool + input 钩子信封识别（handled/transform 分流）+ pending 表配对请求-响应。由 `client/pi/bus-extension-installer.ts` 同步到底座目录。
- **subagent-extension**（`packages/subagent-extension/index.ts`）：注册 sub-agent 五件 tool（经 bus 帧与桌面插件通信）+ 子身份自感知（读头行决定注册与否）。同由 installer 同步。
- **blind-review 插件**（`src/plugins/insight/blind-review/`）：串行蓝队 + 裁判流程，见 §6.1。
- **llm:oneshot**（`src/client/pi/pi-oneshot.ts`）：无会话一次性问询，见 §6.2。

### 设计中（未落地）

- **sub-agent 的 `channel`（作战室）参数**：设计在 `subagent-scheduling.md` §5.1——spawn 时声明 `channel` 把本批子拉进同一房间互通。bus 的 channel 基础设施已有，spawn 七步第 6 步的拉房代码在 `spawn-subagent.ts` 里引用 `p.channel` 参数传给 `sessionCreate({channels: [...]})`——bus 侧本身支持，但子之间的自动 fan-out（工人在房间里说话自动互达）是否正常工作待实测验证。
- **递归 pipeline（子再拆孙）的实测打通**：设计在 `subagent-scheduling.md` §4.3——父配 `allowSpawn:true` 后子可再 spawn 孙，层层 require `allowSpawn`。三层防线代码均已落地，但全链路（子→孙→完成回流）尚未实测。
- **`bus_send` 退役后 plugins 侧保留的 send**：`session-bus.md` §5.8 附注——IM 范式下 agent 说话就是发消息，`bus_send` tool 从 agent 侧退役；plugin 侧保留 `bus.send` 作为插件无自然嗓子的发声通道。

## 9 与近邻功能的边界

| 机制 | 管什么 | 谁控制 | 结果去哪 |
|------|--------|--------|----------|
| **sub-agent 插件** | agent 把活外包给另一个 agent | 父 agent（LLM 调 tool） | 父会话 timeline 卡片 + 总线帧进父 agent 上下文 |
| **blind-review** | 多蓝队独立审查 + 裁判汇总 | 用户（面板按钮） | 面板聚合 + 各队独立 `[盲审]` 会话文件 |
| **llm:oneshot** | 一次性推理，无会话无工具 | 插件（代码调用） | 纯 stdout 文本，调用方自己消费 |
| **review 插件** | 人对模型产出的选区批注 | 用户（拖选 + 输入） | 随下一条消息拼装发给模型 |
| **Session Bus** | 会话间地址、路由、IM 通信 | agent / 插件 | 各 target 地址（session/channel/plugin/desktop） |
| **tool-manager** | 会话级工具开关注入 | 用户（右面板切开关） | `custom-my-harness-desktop.toolConfig` → tool-gate 硬过滤 |

一句话：sub-agent 是"LLM 把活外包出去"，blind-review 是"用户让多个 LLM 独立审同一份内容"，oneshot 是"代码问模型一句"，review 是"人批注给模型看"。各自解决各自的问题，互不交叉。
