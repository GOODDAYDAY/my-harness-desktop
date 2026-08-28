# goal 插件技术文档（内核无关的同会话持久目标 + 壳层续跑驱动）

- goal 是 `sessions` 域下的一个壳插件，pluginId 为 `goal`，物理目录 `src/plugins/sessions/goal/`，manifest 见 `plugin.json`。
- 它的职责一句话：把一个"人类请求的长线完成目标"存成同会话内持久的状态机，并在每次 agent 回合收敛后由壳主动注入一份续跑提示，直到模型调用 `achieve_goal` 声明达成、或轮数撞上限、或用户显式暂停/删除。
- 关键定性：goal 是**内核无关**的——续跑引擎不知道也不关心当前会话跑在 pi 还是 dsh 上；它只消费中性事件、中性会话 API、中性会话头行。两个内核侧各留一个"薄工具"（`set_goal`/`achieve_goal`）作为模型唯一能触达的入口，因为"模型工具"只能由内核注册、壳注入不了。
- 历史定调（见 `docs/design/kernel-agnostic-goal.md` 顶部修订记录）：初版把续跑引擎写成 `core/application` 的 `GoalDriver`（commit `59857b00`），后来在 commit `449d9cc3` 把它迁回纯插件、在 `23f966e5` 把状态机移进插件 `core/` 并接入会话头行持久化——理由正是薄壳纪律：续跑是"功能（内容）"，不是"壳机制"；壳只出 `onEvent` + `prompt` 两个机制，续跑逻辑活在本插件里。

## 1. 目录结构与分层（插件内部的自洽小洋葱）

- `src/plugins/sessions/goal/` 下的四件套与 CLAUDE.md §7.7 的"一个功能收进同一个壳插件目录"完全对齐，但注意它**没有 `locales/`**（详见 §8 与 QA-5）：
  - `plugin.json`：manifest，声明 renderer 入口、双内核扩展相对路径、两个槽位贡献。
  - `core/`：纯函数状态机（`goal-state.ts`），零依赖，插件自己的"圆心"。
  - `renderer/`：React 侧续跑引擎（`goal-controller.ts`）+ 纯事件归约（`goal-reduce.ts`）+ 两个槽位组件（`goal-bar.tsx`、`goal-card.tsx`）+ 模块入口（`index.tsx`）。
  - `pi-extension/`：pi 内核扩展，`set_goal`/`achieve_goal` 两个薄工具（`index.ts`）。
  - `dsh-extension/`：dsh cordis 插件，同两个薄工具（`index.mjs` + `extension.json`）。
- 依赖方向严格向内：`renderer/` 依赖 `core/`（`goal-controller.ts` 与 `goal-reduce.ts` 都 `import ... from "../core/goal-state"`），`core/` 不依赖 `renderer/`、不依赖任何 React/框架/内核；`pi-extension/` 与 `dsh-extension/` 彼此独立、也不依赖 `core/`（它们是自足的薄工具，见 §6）。
- `core/goal-state.ts` 头部注释自述"圆心:goal 状态机(纯函数,零依赖)"——这里的"圆心"是插件尺度的圆心，不是全壳的 `packages/shared/src/domain/` 圆心；两者不冲突：壳圆心管跨插件的契约，插件 `core/` 管本插件内容层的纯逻辑。
- `plugin.json` 完整字段：`id: "goal"`、`version: "0.1.0"`、`tier: "official"`、`displayName: "目标"`、`tags: ["session"]`、`renderer: "./renderer/index.tsx"`、`piExtension: "./pi-extension"`、`dshExtension: "./dsh-extension"`。
- `plugin.json` 的 `contributes` 只有两槽：
  - `blockRenderers: [{ id: "goal", block: "toolCall", names: ["set_goal", "achieve_goal"], component: "GoalCard" }]`——把两个工具调用块的特化渲染交给 `GoalCard`。
  - `composerTop: [{ id: "goal", component: "GoalBar", order: 40 }]`——把目标横幅挂到输入框上方。
- `plugin.json` **没有** `permissions`、**没有** `dependsOn`：goal 只用默认注入能力（`sessions`/`messaging`/`notify`/`events`，见 `plugin-context.ts` 的 `usePluginContext`），只读框架 store，不消费任何别的插件的 channel（详见 §8 与 QA-3）。

## 2. 圆心：`core/goal-state.ts` 纯状态机

- `goal-state.ts` 是整个插件唯一的"目标是什么状态、还该不该续跑"的判定来源，全部是纯函数，无 IO、无 React、无内核 import，因此能裸单测（`goal-state.test.ts`、`goal-command.test.ts`）。
- 核心类型：
  - `GoalPhase = "active" | "paused" | "achieved"`：三个生命周期阶段。
  - `GoalState = { objective: string; phase: GoalPhase; round: number; maxRounds: number }`：一个同会话目标的可观测状态，纯数据、可 JSON 序列化（这是它能直接塞进会话头行 `custom.goal` 的前提）。
  - `SetGoalRequest = { objective: string; maxRounds?: number }`：`set_goal` 的中性入参（抹掉模型工具层的命名差异）。
  - `DEFAULT_MAX_GOAL_ROUNDS = 256`：未显式指定时的轮数上限，注释明确"对齐 DSH 的 defaultMaxGoalRounds"。
- 构造与校验：
  - `createGoal(request)`：`normalizeObjective` 校验 objective 为非空字符串并 trim，`resolveMaxRounds` 校验 maxRounds 为 `isPositiveInt`（正整数安全整数）或回退默认 256；非法抛错。产出 `{ objective, phase: "active", round: 0, maxRounds }`。
  - `isPositiveInt(n)`/`normalizeObjective(v)`/`resolveMaxRounds(v)` 三个内部守卫是唯一的入参净化点——`createGoal` 与 `parseGoal` 都复用它，避免"合法/非法"判定在几处漂移。
- 生命周期转移（全部幂等、不抛错）：
  - `achieveGoal(state)`：任意非 achieved → achieved；已 achieved 直接返回原状态（不重复推进）。
  - `pauseGoal(state)`：仅 active → paused；非 active 幂等返回。
  - `resumeGoal(state)`：仅 paused → active；非 paused 幂等返回。
  - `editGoal(state, objective)`：只换 objective（下次续跑生效），阶段/轮数/上限不变；空 objective 抛错（调用方 `goal-controller.edit` 已 try/catch 静默）。
- 续跑判据 `shouldContinue(state)`：`phase === "active" && round < maxRounds`——这是续跑引擎每轮唯一的"还该不该发下一份 prompt"闸门，paused/achieved/撞上限三种情况都返回 false。
- 与模型工具对接的宽松解析 `parseSetGoalArgs(args)`：从工具入参里读 `objective`（string 非空）与 `max_rounds`（正整数），返回 `SetGoalRequest | null`；畸形返回 null，注释明确"续跑引擎据此静默忽略"——模型侧传错参数不能炸掉续跑引擎。
- 人类斜杠命令解析 `parseGoalCommand(input)` 与 `GOAL_COMMAND_NAME = "goal"`：
  - 正则 `/^\s*\/goal(?:\s+([\s\S]*))?$/i` 判定是否 `/goal` 前缀；非 `/goal` 一律返回 null（放行，`/goalx`、`/goal-set` 都不会误命中，单测专门覆盖）。
  - 只要命中前缀就一定返回一个 `GoalCommand`（吞掉发送），畸形子命令降级为 `status` 提示——绝不把 `/goal` 当普通消息漏进内核。
  - 子命令词表：`PAUSE_WORDS = {stop, pause}`、`RESUME_WORDS = {resume, start, continue}`、`CLEAR_WORDS = {clear, rm, delete}`，**单词精确命中**（`lower === word`）才算子命令；"`/goal stop the server 优化`"这样的长短语按 `{ kind: "set", request: { objective: "stop the server 优化" } }` 处理（单测 `goal-command.test.ts` 有断言），因为目标是文案、不是指令。
  - `edit <文本>` 改目标；裸 `edit`（无文本）降级 status 提示，避免把字面 "edit" 当目标。
  - 其余全部文本（含多行）当作新目标 `{ kind: "set", request: { objective: rest } }`。
- 持久化读回 `parseGoal(v)`：防御式解析一个已落盘的 GoalState（objective/phase/round/maxRounds 逐字段校验），畸形或缺失返回 null——注释点明"目标状态是插件自己落盘的数据，但可能被手改/旧版本污染，读回不信任"，静默忽略而非炸续跑引擎。

## 3. 事件归约：`renderer/goal-reduce.ts`（纯函数，续跑引擎的"脑"）

- `goal-reduce.ts` 把"一条中性会话事件"归约成"目标状态变化 + 可选续跑提示"，零 React、零副作用，可裸单测（`goal-reduce.test.ts`）。续跑引擎 `goal-controller.ts` 只做订阅 + 发消息 + 持久化，判定逻辑全在这一个纯函数里——这是"构造与执行分开"（§3.2）在本插件内的落地。
- 两个工具名常量：`SET_GOAL_TOOL = "set_goal"`、`ACHIEVE_GOAL_TOOL = "achieve_goal"`——与双内核扩展里注册的工具名一一对应，是"模型能调什么名、引擎能认什么名"的单源。
- 事件字段宽容读取：
  - `toolNameOf(event)`：优先 `event.toolName`，回退 `event.name`——容忍不同内核/不同事件形状。
  - `argsOf(event)`：`event.args ?? event.input ?? event.arguments`——pi 与 dsh 的参数键名差异在归约层抹平（虽然中性事件约定是 `args`，这里再兜一层）。
- 归约结果 `GoalReduce = { goal: GoalState | null; prompt?: string }`：`prompt` 非空表示本轮要发续跑提示，由调用方执行；本函数零副作用。
- `applyGoalEvent(state, event)` 两条主路径：
  - `toolCallStart` + `set_goal` → `parseSetGoalArgs` 解析入参，成功则 `createGoal` 建立 active 目标（round=0），畸形/抛错则 `{ goal: state }` 静默忽略。
  - `toolCallStart` + `achieve_goal` → `achieveGoal(state)` 标记 achieved（state 为 null 时原样返回 null，不凭空造目标）。
  - `agentSettled` → `shouldContinue(state)` 为真才 `round + 1` 并产出 `prompt: renderContinuationPrompt(...)`；否则原样返回。
  - 其余事件一律 `{ goal: state }` 透传。
- 续跑提示文案 `renderContinuationPrompt(objective, round, maxRounds)`：产出 `<goal_round>` 包裹的英文提示，重述 `Objective`（JSON 序列化 objective）+ `Round: n/max` + 一段"继续朝目标推进、把当前 workspace/工具结果/持久会话态当权威、达成就调 `achieve_goal`"的指令。注释明确"与 DSH goal-round-driver 的 `<goal_round>` 同语义；内容是插件的事,不进圆心"。

## 4. 续跑引擎：`renderer/goal-controller.ts`（useGoalController hook）

- `goal-controller.ts` 是续跑引擎本体，一个 React hook `useGoalController()`，顶部注释把它的架构依据写得很直白："续跑是功能（内容），不是壳机制；壳只提供 `onEvent`/`prompt`/`updateHeader`/`openSession`/`notify` 这些机制面，续跑逻辑就用这些机制拼，活在这个插件里。"
- 它从 `usePluginContext()` 解构四样机制：`sessions`（`onEvent`/`openSession`/`updateHeader`）、`messaging`（`prompt`）、`notify`（`show`）、`events`（`emit`）；从 `useUiStore` 读 `currentSessionPath`。全部是默认注入能力 + 框架 store 只读，无一句 IPC、无一句内核专属调用。
- 四个 ref 构成引擎的瞬时状态（避免闭包旧值）：
  - `goalRef`：当前 `GoalState | null` 的 ref 镜像，供事件回调（稳定引用）读最新值。
  - `inflightRef`：是否有一份续跑 prompt 已在发送中（`sendRound` 置 true、`.finally` 复位），防同帧重入。
  - `busyRef`：回合在飞标志——`agentStart` 置 true、`agentSettled` 置 false，决定设置/恢复时是否"即时装弹"。
- 单一状态写入口 `setGoal(next)`：更新 `goalRef` + `setGoalState`（React state）+ `events.emit("goal:state", { active: next !== null && next.phase === "active" })` + `sessions.updateHeader(sessionPath, { custom: { goal: next } })`。注释强调"广播在写入口收口，任何路径变更不漏发"——命令、工具、恢复三条路径都经这里，所以 `goal:state` 广播与持久化永不遗漏。
  - 持久化失败被 `.catch(() => {})` 吞掉：内存态照常、续跑不阻断，下次变更再写。
- 发一轮续跑 `sendRound(g, round)`：`inflightRef.current = true` → `messaging.prompt(renderContinuationPrompt(...))` → `.finally` 复位。`messaging.prompt` 与时间线发送按钮同源（都落在 `window.kernel.sessions.prompt`，见 `plugin-context.ts` 的 `MessagingApi.prompt`），所以续跑提示是一条真正的用户侧消息、会起进程、走完整会话流。发送失败不风暴重试——目标保持 active，下次 `agentSettled` 自然再续。
- **即时装弹 `armIfIdle(g)`**（解决"active 目标静默停摆"的关键）：
  - 判据：`busyRef.current || inflightRef.current || userSendPending() || !shouldContinue(g)` 任一为真则原样返回 g；否则 `round + 1` 并 `sendRound` 发首轮。
  - 为什么需要它：若用户设置目标时没有回合在飞，就没有任何 `agentSettled` 会触发续跑，active 目标会永久停摆；`armIfIdle` 在 set/resume/restore 三条路径上主动补这一枪。
  - 忙时（回合在飞）不装弹，交给在飞回合收敛后的 `agentSettled` 接续。
- 挂载/切会话恢复（`useEffect` 依赖 `sessionPath`）：`sessions.openSession(sessionPath)` 纯文件读，从 `detail.info.custom.goal` 用 `parseGoal` 读回；恢复出的 active 目标立即 `armIfIdle`（窗口刷新不再丢目标、也不因刷新停摆），paused/achieved 原样恢复不装弹。
- 事件订阅（`useEffect` 依赖 `sessions/messaging/setGoal`）：
  - `agentStart` → `busyRef.current = true`；`agentSettled` → `busyRef.current = false`。
  - `agentSettled` 且 `userSendPending()` 为真 → **提前 return，本次收敛不续跑也不进轮次**（用户输入插队让路，见 §7）。
  - 其余事件走 `applyGoalEvent(goalRef.current, event)`；`next !== goalRef.current` 才 `setGoal`；`prompt !== undefined && !inflightRef.current` 才 `messaging.prompt`。
- 用户控制四个回调：`pause`（`pauseGoal`）、`resume`（`armIfIdle(resumeGoal(g))`，恢复即"继续干活"、空闲立即装弹）、`edit`（`editGoal`，try/catch 吞空目标）、`clear`（`setGoal(null)`，落盘 `goal=null` 删键）。
- 命令唯一实现 `handleCommand(input)`：`parseGoalCommand` → switch 六种 `kind` → 套状态机 + `notify.show` 反馈，返回 `true` 表示"已处理、吞掉发送"；无目标时的 `stop/resume/edit` 走 `notifyNoGoal` 提示（仍吞发送），裸 `/goal` 回显 `[phase] round/maxRounds · objective`。
- **模块级桥 `runGoalCommand` + `activeCommandHandler`**：`composerCommands.handle` 是插件加载时被 `plugins-host` 收集的静态函数（见 `index.tsx`），而控制器活在 React hook 里；桥变量 `activeCommandHandler` 在 hook 挂载时指向 `handleCommand`、卸载时只清自己（`if (activeCommandHandler === fn)`），让静态入口能调到"当前挂载的控制器"。无控制器（插件被禁）时 `runGoalCommand` 返回 `Promise.resolve(false)` 放行。
- 导出 `GOAL_USAGE`：`/goal <目标>` 用法文案（setting/stop/resume/edit/clear/查看状态五行），用于设置失败或裸 `/goal` 无目标时的提示正文。

## 5. 两个槽位组件：`goal-bar.tsx` 与 `goal-card.tsx`

- `GoalBar`（`composerTop` 槽）：输入框上方的目标横幅，数据源就是本插件内的 `useGoalController`（与续跑引擎同源，不跨 IPC）。
  - 无目标时 `return null`（横幅消失）；`data-goal-bar` 与 `data-goal-phase={goal.phase}` 是真实 DOM e2e 的定位锚点。
  - `phaseColor(phase)`：active → `var(--color-accent-success)`（绿）、paused → `var(--color-accent-warning)`（黄）、achieved → `var(--color-primary)`（主色）、默认 muted——左边框 3px + `color-mix` 底纹随相位变色，"目标一开始就看得出来"。
  - 控制区：active 显示"停止"（Pause 图标，title="停止"）、非 active 显示"恢复"（Play 图标）；轮次 `goal.round/goal.maxRounds` 用 `tabular-nums` 渲染且点击进入编辑态（title="编辑目标"）；"关闭目标"（Trash2 图标）删目标。
  - 编辑态：内联 `<input>`，`placeholder` 为当前目标，Enter 提交（空则取消）、Escape 取消（目标不变）。
- `GoalCard`（`blockRenderers` 槽）：`set_goal`/`achieve_goal` 两个工具调用块的时间线卡片，**非交互**、只渲染 args/result。
  - props 契约 `{ toolCall: ToolCallBlock; collapseDefault?: boolean }`；`toolCall.name === "achieve_goal"` 时摘要固定"目标达成"，否则取 `args.objective`（非空 string）或回退 `toolCall.name`。
  - `isStreaming = toolCall.state === "pending" || "running"`；边框色 error → `--color-accent-error`、streaming → `--color-accent-success`、常态 → `--color-primary`。
  - 展开态对 `set_goal` 渲染 `args.objective` 全文 + `args.max_rounds`（若有），`achieve_goal` 不渲染 args 详情。

## 6. 内核无关设计：`set_goal`/`achieve_goal` 双内核实现与中性事件捕获

- 内核无关的根：续跑引擎的**全部输入**都来自中性契约，没有一条内核专属通道：
  - 检测"模型调了 set_goal/achieve_goal"靠中性事件 `toolCallStart`（`type` + `toolName` + `args`），不 import pi/dsh。
  - 判定"回合结束了该续跑"靠中性事件 `agentSettled`（`type: "agentSettled"`，见 `packages/shared/src/domain/events/session-state.ts` 的 `AgentSettledEvent`）。
  - 发续跑靠中性 API `messaging.prompt`（`MessagingApi.prompt`，`packages/shared/src/domain/sessions.ts:248`），与内核无关、与发送按钮同源。
  - 持久化靠中性 API `sessions.updateHeader` 写会话头行 `custom.goal`（`SessionsApi.updateHeader` + `HeaderPatch.custom`），落 `custom-my-harness-desktop` 命名空间、内核不感知。
- 两个内核侧各留一个**薄工具**，因为"模型工具"只能由内核注册、壳注入不了——这是 goal 唯一留在内核侧的部分：
  - **pi 侧** `pi-extension/index.ts`：默认导出 `function goal(pi: GoalApi)`，调 `pi.registerTool(...)` 注册 `set_goal` 与 `achieve_goal`。`set_goal` 的 `execute` 只校验 objective 非空后返回 `ack({ goal: { objective, ...max_rounds } })`，`achieve_goal` 返回 `ack({ goal: { achieved: true } })`。`ack(value)` 就是 `{ content: [{ type: "text", text: JSON.stringify(value) }] }`——**只回确认文本，不落盘、不维护状态**。
  - **dsh 侧** `dsh-extension/index.mjs`：`export const name = "desktop-goal"`、`export const inject = ["tools"]`（cordis 服务依赖声明，缺了会在插件树加载期抛"cannot get property tools without inject"→ 整个 dsh 内核崩溃，注释对齐旧 goal 插件的 inject 纪律）、`export function apply(ctx)` 调 `ctx.tools.register(...)` 注册同名两工具，`set_goal` 返回 `{ goal: { objective, ...max_rounds } }`、`achieve_goal` 返回 `{ goal: { achieved: true } }`；`outputOf()` 声明 `schema` + `render` 把返回值 JSON 序列化成文本。
- 两侧薄工具的对称性（详见 §9）保证模型看到的工具面完全一致：同一 `set_goal(objective, max_rounds?)` + `achieve_goal()`，同一 `SET_DESCRIPTION`/`ACHIEVE_DESCRIPTION` 文案，同一"返回确认、不持状态"的契约。
- 中性 `toolCallStart` 是怎么从两个内核来的（适配器翻译层抹平差异）：
  - pi 侧 `src/server/kernel/pi/protocol/event-translator.ts:26` 把 pi 原生事件 `tool_execution_start` 映射为 `toolCallStart`（`toolCallId`/`toolName` 保持原名，pi 已用 camelCase）。
  - dsh 侧 `src/server/kernel/dsh/backend/dsh-event-translator.ts:93` 把 dsh 事件 `tool/call` 映射为 `toolCallStart`：`toolCallId = callId`、`toolName = name`、`args = parseArgs(arguments)`（`arguments` 是模型产出的 JSON 字符串，解析成 args 对象；解析失败原样返回字符串，见 `dsh-event-translator.test.ts:50-57`）。
  - 两者归一后，goal 归约层 `toolNameOf`/`argsOf` 只认中性形状，完全无感内核身份。
- 内核无关的可检验证据：`goal-reduce.ts` 只 `import type { SessionEvent } from "@my-harness-desktop/shared"`；`goal-controller.ts` 只 `import { usePluginContext, useUiStore } from "@my-harness-desktop/react"` + `import ... from "../core/goal-state"`；全插件无 `import` 自 `@/core`、`@/client`、`@/api`、无 `if (kernel === "pi")` 分支。这与设计文档 §6 的证明一脉相承（原文"GoalDriver 只 import @my-harness-desktop/shared … 不 import client/pi / client/dsh"，迁移成纯插件后等价命题不变）。

## 7. 用户输入插队：续跑对"排队中的用户消息"让路

- 需求来源（设计文档修订四）：续跑提示和用户输入共用同一条发送通道（都走 `messaging.prompt`），若回合收敛时用户恰好刚敲了一条消息等待发送，续跑引擎若抢发会插队到用户消息之前，违背"用户优先"。
- 判据函数 `userSendPending()`（`goal-controller.ts:34-37`）：`useUiStore.getState().pendingQueue` 是 `Record<string, QueuedMessage[]>`（key = 活会话 `sessionPath` 或新会话 `new:${cwd}`），只要 `Object.values(queues).some(list => list.length > 0)` 就认为"有排队中的用户待发消息"。
  - 这读的是框架 `ui-store` 的 `pendingQueue`（`src/web/stores/ui-store.ts`，`enqueueMessage`/`removeFromQueue`/`clearQueue`/`markQueueFailed` 管理，流式期按发送入队、发送成功后清空）。
  - 注释点明这是"只读框架 store（§8.2 允许）"，不跨插件引通道、不开新机制。
- 让路落点有两处，都在引擎订阅层、归约函数保持纯净：
  - **回合收敛让路**（`goal-controller.ts:111`）：`agentSettled` 且 `userSendPending()` 时提前 `return`——本次收敛**既不续跑也不进轮次**，把发送权让给 timeline 先把用户消息发出去；等用户消息的回合也收敛（队列已清）后，下一次 `agentSettled` 再续。
  - **即时装弹让路**（`armIfIdle` 内嵌 `userSendPending()` 判据）：set/resume/restore 的即时装弹同样在有排队用户消息时让路，不抢发。
- 边界情形（注释与单测都覆盖）：发送失败重挂篮的条目同样压住续跑——"用户需先处置，可见态"。单测 `goal-controller.test.tsx` 两条路径：收敛让路（`pendingQueue = { s: [{id:"u1"}] }` 时 `agentSettled` 不抢发、轮次不空转、队列清后 `agentSettled` 才 round+1）与恢复让路（排队未清时 resume 状态恢复但 `prompt` 不增、队列清后 `agentSettled` 才续）。
- 为什么不让路进 `goal-reduce.ts`：让路依赖框架 store（副作用/环境），归约层只做"事件 → 状态 + prompt"的纯映射，判据放引擎订阅层——纯函数不碰 store，保持可裸单测（`goal-reduce.test.ts` 只断言纯归约，不涉及 pendingQueue）。

## 8. 与其他插件交互：槽位、事件通道、命令拦截

- goal 贡献两个槽位、emit 一个 channel、挂一个 composer 命令，但**不 invoke 任何 channel、不订阅任何其他插件的 channel**——这是它无需 `dependsOn` 的直接原因。
- **composerTop 槽 → timeline**：
  - 契约 `ComposerTopContribution { id, component, order? }` 定义在 `packages/shared/src/domain/contributions.ts:277`；renderer 侧查询 hook `useComposerTop()` 在 `packages/react/src/composer-top.ts`（经 `window.kernel.slots.composerTop()` 取贡献清单，`pluginsNonce` 键控失效重拉）。
  - 消费方是 timeline 插件：`src/plugins/sessions/timeline/renderer/index.tsx:748-756` 用 `useComposerTop()` 拿贡献项，`getPluginComponent(c.pluginId, c.component)` 匹配组件，并**包一层 `<PluginIdContext.Provider value={c.pluginId}>`**——这是让 `GoalBar` 内部 `usePluginContext()` 拿到 goal 的 pluginId 的关键，否则组件会错认 timeline 的 pluginId、`events.emit` 的所有权校验必炸（设计文档修订三专门修了这个机制缺口）。
  - 渲染进 `ComposerDock` 顶部（`index.tsx:1134` 的 `<ComposerDock>{composerTopNodes}{composer}</ComposerDock>`），即输入框上方、输入药丸之前。
- **blockRenderers 槽 → timeline**：
  - 契约 `BlockRendererContribution { id, block, names?, component, order? }` 在 `contributions.ts:465`，解析规则是"toolCall 的 name 比工具名（小写）、names 精确命中的特化层优先于未声明 names 的通用层"。
  - goal 贡献 `block: "toolCall"` + `names: ["set_goal", "achieve_goal"]`，所以时间线遇到这两个工具的调用块时用 `GoalCard` 特化渲染，其余工具落通用工具卡。
  - `GoalCard` 收到的 `ToolCallBlock` 类型定义在 `packages/shared/src/domain/events/session-state.ts:361`（`id/name/args/state/result/isError`），由 `packages/react/src/index.ts:311` re-export 供插件引用。
- **`goal:state` 事件通道 → timeline 着色**：
  - `renderer/index.tsx:7` 声明 `export const channels = ["goal:state"]`，`events.emit("goal:state", { active: boolean })` 在 `setGoal` 单一写入口广播。
  - 消费方 timeline（`index.tsx:788-797`）：`ctx.events.on("goal:state", payload => setGoalActive(payload?.active === true), { replayLast: true })`，active 时给输入药丸挂 `.pi-composer-goal` 绿晕类 + `data-goal-active="true"` 锚点（`composer.tsx:67-68, 293-294`）。
  - 两个机制细节（设计文档修订三）：`replayLast` 让晚订阅的 timeline 立即拿到最近一次状态；订阅用 `pluginsNonce` 键控重试 + `catch` 兜底——插件并行加载时 timeline 可能先挂载而 goal 的 channel 尚未注册（`on` 会抛错），每次插件集合变化重试订阅；goal 始终缺席（被禁）则每次重试落 catch、保持无晕、绝不影响 timeline 自身。
- **composerCommands 命令拦截 → timeline**：
  - 机制链：圆心契约 `ComposerCommand { name, description?, handle }`（`packages/shared/src/domain/composer-commands.ts:11`）+ 纯匹配 `parseComposerCommandText`/`matchComposerCommand`；renderer 注册表在 `packages/react/src/composer-commands.ts`（`registerComposerCommands`/`unregisterComposerCommands`/`getComposerCommands`/`runComposerCommandIfMatch`）。
  - goal 在 `renderer/index.tsx:16-22` 导出 `composerCommands: ComposerCommand[]`，`name: "goal"`、`handle: (input) => runGoalCommand(input)`；`plugins-host` 加载 module 时与 `channels`/`auxParsers` 同款收集进注册表。
  - timeline 在发送前拦截（`timeline/renderer/index.tsx:947-953`）：`trimmed.startsWith("/")` → `runComposerCommandIfMatch(trimmed)`，命中且 handle 返回 true → 清空输入框、`return false`（吞掉发送、文本不进内核）；拦截放在"入队/streaming 判定之前"，因为命令是即时状态动作，不入消息队列、不依赖内核可用性。
  - timeline 同时把注册表映射成 `CommandItem { source: "plugin" }` 并入斜杠弹窗清单（`index.tsx:801-809`），插件命令与内核命令（`snapshot.commands`）并列展示。
- **与 sessions-list 的关系（澄清一个常见误解）**：goal **不**与 sessions-list 交互——它不贡献 `sessionGroupings` 槽、不在会话列表行上做任何标记、也不 emit/invoke sessions-list 的通道。目标状态只持久化在会话头行 `custom.goal`（`custom-my-harness-desktop` 命名空间的 `goal` 域），sessions-list 目前不消费该键；goal 与 sessions-list 唯一的间接联系是"同一个会话、同一份头行文件"，谈不上通道或槽位交互。

## 9. pi-extension 与 dsh-extension 的对称实现

- 两侧目录都是"内容插件私货的生命周期通道"（manifest 的 `piExtension`/`dshExtension` 字段，契约见 `contributions.ts:507-517`），由壳 lifecycle 在 activate/deactivate 时挂摘：
  - `src/server/application/lifecycle/index.ts:102-107`：activate 时若 `manifest.piExtension` 则 `deps.piExtensionEnsure.onActivate(...)`，若 `manifest.dshExtension` 则 `deps.dshExtensionEnsure.onActivate(...)`；`126-131` deactivate 时对称 `onDeactivate`。
  - 实现在 `src/server/bootstrap/assemble.ts:363-379`：`pluginPiExtensionEnsure` 调 `syncPluginPiExtension(pluginId, join(pluginPath, piExtension))`，`pluginDshExtensionEnsure` 调 `syncPluginDshExtension(pluginId, join(pluginPath, dshExtension), dshConfigSource)`。
- **pi 侧同步**（`src/server/kernel/pi/extension/pi-extension-installer.ts`）：
  - `syncPluginPiExtension` 把 `<pluginPath>/<piExtension>/` 同步到 `~/.pi/agent/extensions/<pluginId>/`，`removePluginPiExtension` 摘除。
  - marker 纪律：同步目录写 `.my-harness-desktop-plugin` 标记文件（内容 = pluginId），摘除/启动对账只碰带标记的目录——用户手装的同名目录不被误删；目标已存在但无 marker（用户同名扩展）则跳过。
  - 修正 `package.json` 的 `pi.extensions` 指向壳扫描出的入口文件（`findExtensionEntry` 统一发现 `.ts/.js`，与 dsh 侧同一发现逻辑）。
  - 任何异常只记日志、不让 app crash——扩展同步失败不阻断插件本体加载。
- **dsh 侧同步**（`src/server/kernel/dsh/extension/dsh-extension-installer.ts`）：
  - `syncPluginDshExtension` 把 cordis 插件同步到 `~/.dsh/.my-harness-desktop-plugins/<id>/`，并在 `cordis.yml` 挂 `my-harness-desktop-<id>` 相对路径块（`name: ./.my-harness-desktop-plugins/<id>/index.mjs`，相对 cordis.yml 目录解析）。
  - marker 纪律与 pi 侧一致（`.my-harness-desktop-plugin`），cordis.yml 块用固定 id 幂等挂摘。
- **两侧薄工具的代码对称**：
  - 工具面完全同构：都注册 `set_goal`（`objective` 必填、`max_rounds` 可选正整数）+ `achieve_goal`（无参），`SET_DESCRIPTION`/`ACHIEVE_DESCRIPTION` 两段描述文案逐字相同。
  - 返回值语义同构：pi 返回 `{ content: [{ type: "text", text: JSON.stringify({ goal: {...} }) }] }`，dsh 返回 `{ goal: {...} }` 再经 `outputOf().render` 序列化成文本——都是"只回确认、不持状态"。
  - 入参校验同构：都要求 `objective` 为非空 string（trim 后非空），空则返回错误（pi `isError: true` + 错误文本；dsh `{ error: "..." }`）。
- **两侧的差异点（各自内核的固有形状）**：
  - pi 侧是默认导出 `function goal(pi: GoalApi)`，手写 `GoalToolResult`/`GoalToolDefinition`/`GoalApi` 三个窄结构（注释"不 import 官方 pi 包——内核 node_modules 类型仓库 tsconfig 够不到——手写窄结构，同 toolgate 纪律"）。
  - dsh 侧是 cordis 插件形状：`name` + `inject = ["tools"]` + `apply(ctx)`，`ctx.tools.register` 的 `output` 需要 `{ schema, render }`。
  - dsh 侧多一个 `extension.json`（`displayName`/`description`），供 dsh 扩展管理展示名/描述/来源标签（`dsh-extension-manager` 消费）。
- 对称的落点：同一能力（"给内核补 set_goal/achieve_goal 两个工具"）在两个内核里各交一份适配其注册机制的薄实现，续跑语义零重复——状态机与续跑只在壳插件里有一份。

## 10. 端到端生命周期与闭环

- 完整闭环（`goal-controller.test.tsx` 首条用例"set_goal → 续跑 → achieve_goal → 停止"）：
  - 模型调 `set_goal(objective)` → 内核工具返回确认 → 适配器投中性 `toolCallStart` → `applyGoalEvent` 建立 `{ objective, phase: "active", round: 0, maxRounds: 256 }` → `setGoal` 广播 `goal:state {active:true}` + 落盘 `custom.goal`。
  - 该回合 `agentSettled` → `shouldContinue` 真 → `round: 1` + `messaging.prompt("<goal_round>…")` 发起新一轮。
  - 如此往复，每轮 `round + 1`，直到 `round` 达 `maxRounds`（防失控安全阀）或模型调 `achieve_goal`。
  - 模型调 `achieve_goal` → `toolCallStart` → `achieveGoal` 标记 achieved → 广播 `goal:state {active:false}` + 落盘 → 后续 `agentSettled` 因 `shouldContinue` 假而不再续跑。
- 人类命令闭环（与模型工具同状态机同持久化）：人敲 `/goal <目标>` → timeline `sendText` 拦截 → `runComposerCommandIfMatch` → `runGoalCommand` → `handleCommand` 解析并 `armIfIdle` 即时发首轮（空闲时 round 直接 1）→ 返回 true 吞掉发送；`/goal stop·resume·edit·clear` 走同一 `setGoal` 写入口，删改停与工具路径完全同源。
- 跨刷新持久化：目标状态随每次变更写 `custom.goal`，窗口刷新后 `useGoalController` 挂载时 `openSession` 读回、active 目标立即 `armIfIdle` 补一轮——"active=续跑中"不因窗口刷新停摆。
- 与 `sessions/continue` 插件的分工（避免混淆）：`continue` 是第八意图"异常停机后原地续跑、不 fork、不重发旧消息"（`MessagingApi.continue`），由用户点按钮触发、单次；goal 是"目标未达成就由壳每回合自动再发提示"，由状态机驱动、多轮。两者是并列的会话能力，goal 不调用 `continue`。

## 11. 测试全景

- `core/goal-state.test.ts`（圆心单测）：create 规范化/默认 maxRounds/非法拒绝、achieve 幂等、shouldContinue 边界（active+达上限/achieved/paused）、pause/resume 幂等、edit 只换 objective 且空拒绝、parseSetGoalArgs 畸形返回 null、parseGoal 读回校验逐字段畸形返回 null。
- `core/goal-command.test.ts`（命令解析单测）：命令名注册、`/goal <目标>` set（含多行、两端空白规范化）、大小写不敏感、`/goalx`/`/goal-set` 不误匹配、裸 `/goal` → status、stop/pause/resume/start/continue/clear/rm/delete 词表、`edit <新目标>`/裸 edit 降级、长短语按目标处理、非 `/goal` 放行。
- `renderer/goal-reduce.test.ts`（纯归约单测）：set_goal 建 active、achieve_goal 标 achieved、agentSettled 注入续跑+round+1、achieved/paused 不续、畸形 set_goal 静默忽略、轮数上限不续、`renderContinuationPrompt` 带 objective+轮次。
- `renderer/goal-controller.test.tsx`（引擎 e2e，mock `usePluginContext`/`useUiStore` 只给机制面、续跑逻辑全真跑）：完整闭环、pause 停/resume 续、edit 下次生效/clear 停、挂载从 `custom.goal` 恢复 + 变更写回、clear 落 `goal=null` 删键、`/goal` 全子命令同状态机、裸 `/goal` 状态回显、非 `/goal` 放行、`goal:state` 广播（工具路径与命令路径同收口、全程只翻 active 位）、用户输入插队两条路径（收敛让路 + 恢复让路）。
- `renderer/goal-bar.test.tsx`（GoalBar DOM e2e）：无目标不渲染、`/goal` 后横幅出现且首轮已发、停止/恢复/编辑/关闭的 DOM 交互逐条对账、`data-goal-bar`/`data-goal-phase` 锚点、模型 set_goal 与用户 `/goal` 同状态机删改停。
- 真实 DOM e2e `scripts/demo/goal-command.e2e.mjs`（设计文档修订三）：CDP 驱动实机构建产物，24 项断言覆盖弹窗 `/goal`+cmd 徽标、横幅位置在输入框上方、轮次 1/256、输入框拦截清空、绿晕随 set/pause/resume/stop 翻转、编辑、删除、裸 `/goal` 吞发送；隔离 HOME 不种会话 → 零真实回合零 token。commit `3d1696d8` 补上方位置断言 + 生效绿晕断言。

## 12. 设计文档与演进（从 core/application 迁回纯插件）

- 设计文档 `docs/design/kernel-agnostic-goal.md` 是真相源，顶部修订记录完整记录了五次演进：
  - **首版**（`59857b00`）：推翻 `goal-ask-pi-port.md` 的"pi 扩展移植"路线（那版是 `get_goal`/`create_goal`/`update_goal` 三工具 + 扩展内 `details.goal` 持久化 + `getBranch()` 重放，无自动续跑），理由是语义错了（goal 本质是"没达成就再发 prompt 让它继续"，续跑是 desktop 职责、不该塞内核扩展）且与内核耦合（状态机/CAS/fold 全在 pi 扩展，dsh 要再来一套）。当时状态机落 `packages/shared/src/domain/goal.ts`、续跑驱动落 `src/server/application/goal/goal-driver.ts`（`GoalDriver` + `GoalDriverHost { onEvent, prompt }`），装配在 `bootstrap/assemble.ts`。
  - **修订一（纯插件，`449d9cc3`）**：续跑引擎从 `core/application` 迁回壳插件 `plugins/sessions/goal`（`goal-controller` hook + `goal-reduce` 纯归约），删掉 GoalApi 契约与全部 IPC 改动——薄壳架构，续跑是功能不是机制，壳只出 `onEvent` + `prompt`。
  - **修订二（用户 `/goal` 命令，`f3b7899d`）**：补人类入口；机制在圆心 `shared/src/domain/composer-commands.ts` + 发布面 `packages/react/src/composer-commands.ts` + `plugins-host` 收集 + timeline `sendText` 拦截；内容在 `parseGoalCommand` + `handleCommand` + 模块级桥；即时装弹（arming）。
  - **修订三（展示位置 + 生效着色，`90cf912d`）**：目标条从 `composerStats` 移到新开 `composerTop` 槽；GoalBar 相位色 + timeline 订阅 `goal:state` 挂 `.pi-composer-goal` 绿晕；顺手修两个机制缺口（槽组件补 `PluginIdContext.Provider`、`pluginsNonce` 键控重试 + `replayLast`）；真实 DOM e2e 24 断言。
  - **修订四（用户输入插队，`c08b2ff7`）**：`pendingQueue` 让路，零新机制。
- 迁移前后的关键对比：迁移前状态机在共享圆心 `goal.ts`、续跑在应用层 `GoalDriver`、装配在 bootstrap（依赖注入 `new GoalDriver({ onEvent, prompt }).install()`）；迁移后状态机在插件 `core/goal-state.ts`、续跑在插件 `renderer/goal-controller.ts`、装配消失（hook 直接从 `usePluginContext` 拿机制面）。这印证 CLAUDE.md §7.7 的判据——"改动一个功能时 diff 落在 server/（壳）而非 plugins/ 是判别气味"，goal 把 diff 收回了 plugins/。
- 设计文档 §8 的已知限制已在迁移中逐条作废/落地：进程内驻留 → 已落 `custom.goal` 持久化；单目标模型保留；dsh 侧工具未接 → 已接（`dsh-extension/index.mjs`）。

## QA

- **Q：goal 为什么是纯插件，而不是壳机制（core/application 的 GoalDriver）？**
  - 因为"回合结束后再发一份 prompt 继续"是功能（内容），不是壳机制。壳只提供 `onEvent`（订阅中性事件）与 `prompt`（发消息，与发送按钮同源）两个机制面，续跑逻辑用这些机制就能拼出来，就该活在插件里。历史 commit `449d9cc3` 从 `core/application` 迁回纯插件正是这个理由；迁走后 `core/application`、契约、IPC 一概不碰。判据（CLAUDE.md §7.7）：功能的 diff 应落在 `plugins/` 而非 `server/`（壳）。

- **Q：两个内核的 `set_goal`/`achieve_goal` 工具为什么只返回确认文本、不落盘不维护状态？**
  - 因为"模型工具"只能由内核注册、壳注入不了，这是 goal 唯一必须留在内核侧的部分；但一旦让工具持状态，状态机就分裂成 pi/dsh 两份（回到 `goal-ask-pi-port.md` 被推翻的老路）。正确姿势是工具退化为"薄标记"——只返回 `{ goal: {...} }` 或 `{ goal: { achieved: true } }` 的确认文本，真正的目标状态由壳插件经中性 `toolCallStart` 事件捕获、在 `goal-controller`/`goal-reduce` 里用唯一一份 `core/goal-state.ts` 状态机驱动。内核无关、契约单源两者兼得。

- **Q：goal 为什么不在 manifest 里声明 `dependsOn`？**
  - `dependsOn` 是生命周期护栏，凡消费别人的 channel（on/invoke）才需要（§8.2）。goal 不消费任何插件的 channel：它只读框架 store（`useUiStore.pendingQueue`/`currentSessionPath`，共享 store 只读允许）、只用框架机制（`sessions`/`messaging`/`notify`/`events` 默认注入能力）。它 emit 的 `goal:state` 由 timeline 消费，是"我供、别人 dependsOn 我"，不是"我 dependsOn 别人"。

- **Q：用户输入插队为什么读 `useUiStore.pendingQueue`，而不是新开一条通道让 timeline 通知 goal？**
  - 因为"队列里有没有待发用户消息"这个事实已经存在于框架的 `ui-store.pendingQueue`（`src/web/stores/ui-store.ts`），goal 只读它就是零新机制的方案（设计文档修订四明说"落法零新机制"）。新开通道需要 timeline 在入队/清空时额外 emit、goal 再订阅，多一个跨插件契约与竞态面；读框架 store 是 §8.2 明确允许的共享 store 只读，且 `goal-reduce` 归约函数保持纯净、让路判定只在引擎订阅层。

- **Q：goal 插件为什么没有 `locales/` 目录，文案直接写在组件/控制器里？**
  - 这是事实：`GOAL_USAGE`、`notify.show` 的 body、`goal-bar.tsx` 的按钮 `title`（"停止"/"恢复"/"编辑目标"/"关闭目标"）都是内联中英文，未走 `languages` 槽 + `i18n.t()`。这偏离了"文案 → 语言插件"（CLAUDE.md §1.2/铁律一），是一个已知内容泄漏点——但 goal 没有因此破坏薄壳（泄漏在插件内部、不在壳），属可演进项：把用户可见文案抽到 `locales/` + `languages` 贡献即可，不影响任何机制。

- **Q：续跑提示 `renderContinuationPrompt` 为什么是英文 `<goal_round>` 而非中文？**
  - 因为它是**模型侧的 prompt**，不是用户可见文案。它对齐 DSH `goal-round-driver` 的 `<goal_round>` 语义，喂给 LLM 读（"Continue working toward the objective…call the achieve_goal tool"），用英文与系统提示/工具描述的语言保持一致。用户可见文案（横幅、命令反馈）才是中文、才该走 i18n（见上一问）。

- **Q：goal 与 sessions/continue 插件的"继续执行"是什么关系，会不会重复续跑？**
  - 不重复。`continue` 是第八意图（`MessagingApi.continue` → pi 翻译成 `followUp` / dsh 走 `session/continue`），由用户点按钮触发、**单次**、语义是"异常停机后原地续跑不 fork"；goal 是状态机驱动的**多轮自动**续跑，每轮 `agentSettled` 注入一份新的 `<goal_round>` 提示。二者走不同的触发源（用户按钮 vs 状态机），goal 内部也不调用 `continue`。
