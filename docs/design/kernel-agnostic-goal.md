# 内核无关的 goal 能力设计（两工具 + 壳层续跑）

> 修订记录：
>
> **2026-08-27 首版**：推翻 `goal-ask-pi-port.md` 的「pi 扩展移植」路线。按用户澄清的语义，goal 是**内核无关的壳层机制**——两个模型工具（`set_goal` / `achieve_goal`）+ desktop 主动续跑（没达成就再发一份 prompt 让它继续），与内核身份无关。本设计把状态机与续跑收进 `core/application`，工具退化为内核侧的薄标记。

## 1. 问题

上一版（`goal-ask-pi-port.md`）把 goal 落成 **pi 内核扩展**：`get_goal`/`create_goal`/`update_goal` 三工具 + 扩展内 `details.goal` 持久化 + `getBranch()` 重放，无自动续跑。这套方案有两个根本问题：

1. **语义错了**：goal 的本质不是「内核里的一个状态对象」，而是「AI 没达成的时候，desktop 再给它发一份 prompt 让它继续」。续跑是 desktop 的职责，不该塞进内核扩展。
2. **与内核耦合了**：状态机、CAS、fold 全在 pi 扩展里，dsh 要再来一套，违背「内核无关」——同样的 goal 语义在两个内核里变成两套引擎。

## 2. 目标

- 两个模型工具：`set_goal`（设置目标）+ `achieve_goal`（达成目标）。
- 有 goal 之后，desktop 在每次回合收敛（`agentSettled`）时主动注入续跑提示，直到 `achieve_goal` 或轮数上限。
- 状态机与续跑全部在**壳层**（`core/application`），只依赖中性契约与中性事件，**不 import 任何内核**。

## 3. 非目标

- 不实现人类 `/goal` 斜杠命令（后续评估）。
- 不实现 `get_goal` 只读工具——续跑提示每轮都重述目标，模型无需回读。
- 不实现跨重启持久化（V1 目标状态进程内驻留；持久化到 `custom.goal` 头行是自然演进）。
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
