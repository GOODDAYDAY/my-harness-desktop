# 内核无关的 goal 能力设计（两工具 + 壳层续跑）

> 修订记录：
>
> **2026-08-27 首版**：推翻 `goal-ask-pi-port.md` 的「pi 扩展移植」路线。按用户澄清的语义，goal 是**内核无关的壳层机制**——两个模型工具（`set_goal` / `achieve_goal`）+ desktop 主动续跑（没达成就再发一份 prompt 让它继续），与内核身份无关。本设计把状态机与续跑收进 `core/application`，工具退化为内核侧的薄标记。
>
> **2026-08-27 修订（纯插件）**：续跑引擎从 `core/application`（GoalDriver）迁回**壳插件** `plugins/sessions/goal`（`goal-controller` hook + `goal-reduce` 纯归约），删掉 GoalApi 契约与全部 IPC 改动——薄壳架构：续跑是功能（内容），不是壳机制；壳只出 `onEvent` + `prompt` 两个机制。圆心只留 `domain/goal/goal-state.ts` 纯状态机。内核侧仍保留两个薄工具（模型工具只能内核注册）。
>
> **2026-08-27 修订二（用户 /goal 命令）**：补上人类入口——此前目标只能由模型调 `set_goal` 设置，用户在输入框敲 `/goal <目标>` 现在同样直接设置（以及 `/goal stop·resume·edit·clear` 删改停、裸 `/goal` 查状态）。落法：
>
> - **机制**（壳，通用）：新增输入框斜杠命令机制——圆心 `shared/src/domain/composer-commands.ts`（`ComposerCommand` 契约 + 纯匹配），发布面 `packages/react/src/composer-commands.ts`（注册表 + `runComposerCommandIfMatch`），`plugins-host` 收集插件 module 的 `composerCommands` 导出（与 `channels`/`auxParsers` 同款），`CommandItem.source` 加 `"plugin"`（斜杠弹窗第四种来源，徽标 `cmd`）。
> - **消费**（timeline 插件）：`sendText` 在入队/发送判定前先跑拦截——命中且处理即吞掉发送、文本不进内核；弹窗清单 = 内核命令 + 插件命令。
> - **内容**（goal 插件）：`parseGoalCommand`（core 纯函数）+ `goal-controller.handleCommand`（与模型工具同状态机同持久化）+ 模块级桥 `runGoalCommand`。
> - **即时装弹（arming）**：人敲设置/恢复/窗口刷新恢复出 active 目标时若空闲（无回合在飞），立即发首轮续跑提示——否则没有任何 `agentSettled` 可触发，active 目标会静默停摆；忙时交给在飞回合收敛触发。`agentStart/agentSettled` 维护 busy。
>
> **2026-08-28 修订三（展示位置 + 生效着色 + 真实 DOM e2e）**：
>
> - **目标条挪到输入框上方**：新增 `composerTop` 槽（机械镜像 `composerStats`：圆心契约 → `slots:composerTop` IPC → registry → `useComposerTop` → timeline 渲染进 ComposerDock 顶部，空态/常态两个分支同挂载）。goal 插件的贡献从 `composerStats` 移到 `composerTop`，GoalBar 横幅化（相位色左边框 + 相位色底纹 + `data-goal-bar`/`data-goal-phase` 锚点）。
> - **goal 生效着色**：双通道同色呼应——① GoalBar 自身随 phase 变色（active 绿/paused 黄/achieved 主色）；② 输入框药丸在 active 时挂 `.pi-composer-goal` 绿晕（`data-goal-active` 锚点）。机制与内容分离：CSS 类只是表现机制，何时挂由 timeline 订阅 goal 插件的 `goal:state` 事件（`{ active }`，replayLast）决定；广播在 `goal-controller.setGoal` 单一写入口收口，命令/工具/恢复任何路径变更不漏发。
> - **两个顺手修的机制缺口**：① timeline 渲染槽组件（composerStats/composerActions/composerTop）原来不包 `PluginIdContext.Provider`，组件错认 timeline 的 pluginId——`events.emit` 所有权校验必炸（本次 goal:state 即触发），与 settings/sidebar 等槽消费者对齐补上；② 插件并行加载时 timeline 可能先挂载、目标插件 channel 尚未注册——订阅以 `pluginsNonce` 键控重试 + `replayLast` 补状态。
> - **真实 DOM e2e**：`scripts/demo/goal-command.e2e.mjs`（CDP 驱动实机构建产物，隔离 HOME 不种会话 → 零真实回合零 token），24 项断言覆盖：弹窗 /goal+cmd 徽标、设置后横幅位于输入框上方、轮次 1/256、输入框拦截清空、绿晕随 set/pause/resume/stop 翻转、编辑、删除、裸 /goal 吞发送。同轮修好 demo 测试床两处既有毛病（renderer 页发现适配 web-service 架构、等页超时杀子进程防端口泄漏）。
>
> **2026-08-28 修订四（用户输入插队）**：goal 续跑对用户输入让路——回合收敛时若 `ui-store.pendingQueue` 有排队的用户待发消息（流式期入队），本次收敛**不续跑也不进轮次**，让 timeline 先把用户消息发出去，等用户回合收敛（队列已清）再续；`armIfIdle`（set/resume/restore 即时装弹）同样让路。落法零新机制：续跑引擎只读框架 `useUiStore.pendingQueue`（§8.2 共享 store 只读），不跨插件引通道；归约函数保持纯净，让路判定在引擎订阅层。边界：发送失败重挂篮的条目同样压住续跑（用户需先处置，可见态）。单测覆盖两条路径（收敛让路 + 恢复让路）；真实 DOM 侧因队列依赖流式（零模型隔离环境无法起流式）不在 e2e 断言面。

## 1. 问题

上一版（`goal-ask-pi-port.md`）把 goal 落成 **pi 内核扩展**：`get_goal`/`create_goal`/`update_goal` 三工具 + 扩展内 `details.goal` 持久化 + `getBranch()` 重放，无自动续跑。这套方案有两个根本问题：

1. **语义错了**：goal 的本质不是「内核里的一个状态对象」，而是「AI 没达成的时候，desktop 再给它发一份 prompt 让它继续」。续跑是 desktop 的职责，不该塞进内核扩展。
2. **与内核耦合了**：状态机、CAS、fold 全在 pi 扩展里，dsh 要再来一套，违背「内核无关」——同样的 goal 语义在两个内核里变成两套引擎。

## 2. 目标

- 两个模型工具：`set_goal`（设置目标）+ `achieve_goal`（达成目标）。
- 有 goal 之后，desktop 在每次回合收敛（`agentSettled`）时主动注入续跑提示，直到 `achieve_goal` 或轮数上限。
- 状态机与续跑全部在**壳层**（`core/application`），只依赖中性契约与中性事件，**不 import 任何内核**。

## 3. 非目标

- ~~不实现人类 `/goal` 斜杠命令~~ → **已实现**（修订二，见顶部）：`/goal <目标>` 设置 + `stop·resume·edit·clear` 删改停 + 裸 `/goal` 查状态。
- 不实现 `get_goal` 只读工具——续跑提示每轮都重述目标，模型无需回读（人类查状态走裸 `/goal` 通知，不进工具面）。
- ~~不实现跨重启持久化~~ → **已实现**：状态随变更写会话头行 `custom.goal`，挂载/切会话读回，窗口刷新不丢（修订二恢复出的 active 目标会即时装弹续跑）。
- 不实现 DSH 的 blocked/usage-limited 等策略结算（异常停机沿用既有 `continue()` 第八意图，不归 goal 管）。

## 4. 架构分层

```
packages/shared/src/domain/goal.ts         圆心:GoalState + createGoal/achieveGoal/shouldContinue(纯函数,零依赖)
src/server/application/goal/goal-driver.ts 应用层:GoalDriver —— 订阅中性事件,驱动续跑(不 import client/{kernel})
src/plugins/sessions/goal/pi-extension/    pi 扩展:set_goal/achieve_goal 两个薄工具(唯一留在内核侧的部分)
src/plugins/sessions/goal/renderer/        GoalCard 渲染件(blockRenderers 槽)
src/server/bootstrap/assemble.ts           组装:new GoalDriver({ onEvent, prompt }).install()
```

- **圆心**只回答「目标现在是什么状态、还该不该续跑」，纯函数、可裸单测。
- **应用层** `GoalDriver` 是续跑引擎，依赖一个最小中性宿主面 `GoalDriverHost{ onEvent, prompt }`——换内核 = 换 `prompt` 的实现（assembly 绑定），本文件一行不改。
- **内核侧**只留 `set_goal`/`achieve_goal` 两个薄工具（工具是内核注册的，壳注入不了），它们只返回确认文本，不持久化、不维护状态。

## 5. 生命周期

```
模型调 set_goal(objective, max_rounds?) ──toolCallStart──▶ 驱动建立目标(active, round=0)
       │
agentSettled(回合收敛) ──shouldContinue?──▶ store.prompt(<goal_round> 续跑提示) ──▶ 新一轮 turn
       │
模型调 achieve_goal() ──toolCallStart──▶ 驱动标记达成(achieved) ──▶ 不再续跑
```

- 续跑提示 `renderContinuationPrompt` 与 DSH `goal-round-driver` 的 `<goal_round>` 同语义：重述 objective + 轮次 + 指令。
- `maxRounds`（默认 `DEFAULT_MAX_GOAL_ROUNDS = 256`，对齐 DSH）是防失控安全阀；`shouldContinue = active && round < maxRounds`。
- `inflight` 护栏防同帧重入（`agentEnd`/`agentSettled` 双发只取后者，此处再兜一层）。

## 6. 内核无关的证明

`GoalDriver` 只 import `@my-harness-desktop/shared`（圆心契约 + 中性事件），不 import `client/pi` / `client/dsh`。检测工具调用靠中性 `toolCallStart`（`toolName` + `args`，pi 透传、dsh 翻译层映射，两侧归一），续跑靠中性 `agentSettled` + 宿主 `prompt`。

装配在 `bootstrap/assemble.ts`：

```ts
new GoalDriver({
  onEvent: (cb) => sessionStore.onEvent(cb),
  prompt: (text) => sessionStore.prompt(text),
}).install();
```

## 7. 测试

- **圆心单测** `packages/shared/src/domain/goal.test.ts`：create 规范化/非法拒绝、achieve 幂等、shouldContinue 边界、parseSetGoalArgs 畸形返回 null。
- **驱动单测** `src/server/application/goal/goal-driver.test.ts`：set→续跑、achieve→停、无目标不续、畸形忽略、轮数上限、uninstall。
- **集成（壳层 e2e）** `src/server/application/goal/goal-driver.integration.test.ts`：真实 `SessionStore` + 真实 `PiBackend`（脚本化 FakeAdapter）+ 真实 `GoalDriver`，走通「内核事件翻译 → dispatch → 驱动捕获 → store.prompt → backend.sendMessage」，证明 set_goal → 续跑 → achieve_goal → 停止。

## 8. 已知限制

- V1 目标状态进程内驻留，重启即清空（对齐「activation 进程本地、重启 disarmed」的既有取向）；持久化到中立层 `custom.goal` 是后续演进。
- 单目标模型（一次一个 goal，`set_goal` 覆盖旧的）；多会话并行 goal 后续评估。
- dsh 侧的 `set_goal`/`achieve_goal` 工具（cordis 插件）未接——壳层续跑驱动已内核无关，dsh 只差两个薄工具（P3）。
