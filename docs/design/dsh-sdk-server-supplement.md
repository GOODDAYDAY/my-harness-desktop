# dsh SDK server 补面规格（阶段二：session/listTools + session/answer）

> **2026-08-21 首版**：给 deepseek-harness 仓库执行。目标是把 pi-desktop 的 dsh 侧"工具发现"与"提问往返"从文件侧车桥收敛到内核协议——补 `session/listTools` 与 `session/answer` 两个 SDK server 方法 + 一条提问通知，废掉 pi-desktop 侧的 `dsh-question-bridge.ts` 文件侧车。本仓库（pi-desktop）改不动 deepseek-harness，本文是交接规格。

## 1. 定位与目标

pi-desktop 接 dsh 走的是 `@deepseek-ai/dsh-sdk-jsonrpc-server`（`packages/sdk/server`）。该 server 已暴露一批 `session/*` 方法（`seed`/`fork`/`getTree`/`getEntries`/`prompt`/`abort`/`setModel`/`list`/`get`/`delete`/`rename`/`updateHeader`/`projectStats`/`bookmark`/`resume`/`deleteBookmark`），但缺两个能力：

| 缺的能力 | pi-desktop 当前 workaround | 补面后 |
|---|---|---|
| 工具发现 | dsh 侧缺面（`listTools` 返回 null，走降级） | `session/listTools` |
| 提问往返 | **文件侧车桥**（`dsh-extension` 写问句文件 + `dsh-question-bridge.ts` fs.watch + 写答案文件，双轮询） | `session/answer` + 提问通知 |

补面后，pi-desktop 的 `DshBackend.listTools` = `session/listTools`、`DshBackend.answerQuestion` = `session/answer`，`dsh-event-translator` 译提问通知 → 中性事件，`dsh-question-bridge.ts` 整个删除。

## 2. 现状与参考锚点

### 2.1 SDK server 方法注册

`packages/sdk/server/src/server.ts`：

- 类 `HarnessSdkJsonRpcServer`（L164），构造注入 `ctx: Context` + `transport: JsonRpcTransportPeer`。
- 方法分派在 `handleRequest(method, params)` 的 switch（L576-616），每个 case 转成类型化 params 后调私有方法。
- 通知广播用 `this.transport.notify(...)`，已有先例：`session.event`（L184）、`session.status`（L188）、`subagent.started`（L204）。
- 会话记录 `SessionRecord { handle: AgentHandle }`（L61-63），`getOrCreateSession(sessionId)` 拿 agent handle，`rec.handle.agent` 是活 agent（L256 有"exact live agent"校验先例）。

### 2.2 协议类型

`packages/sdk/protocol/src/types.ts`：`SessionSeedParams`/`SessionSeedResult` 等都在此。新增类型照这个文件的命名与形状惯例。

### 2.3 ask 机制（核心参考）

`packages/host/apiproxy/src/api-proxy.ts` L1369-1405 是 **web provider 的完整参考实现**：

- `ctx.userQuestions.registerProvider({ ask(request) })` 注册一个 UI provider。
- `ask(request)` 收到 `{ agent, questions, signal }`，铸造 `rpcId`，把 `{rpcId, resolve, reject}` 存进进程内 pending 表，广播 `{type:'question/requested', sessionId, questions}`，返回 Promise 挂起。
- 客户端应答后，api-proxy 的 `respond(message)`（L3696）按 `rpcId` 找到 pending，`resolve(answer)` / `claimQuestion(...)`，再广播 `question/resolved`。
- 用户取消 / turn 中断 → `ASK_CANCELLED` / `ASK_ABORTED`（结构化错误码）。

SDK server 要做的，是把这套 provider 机制**接到 JSON-RPC 通道**上（代替 web 的 mux 通道）。

### 2.4 工具清单

`packages/core/tools/src/index.ts`：`ctx.tools` 是 `ToolRuntime`，作用域解析后的可见工具在 `ToolView.visible: ReadonlyMap<string, ToolDefinition>`（L696）。`ToolDefinition` 有 `name`/`description`（L222 起）。listTools 读可见工具，映射成中性形状即可。

## 3. 补面一：`session/listTools`

### 3.1 协议类型（`packages/sdk/protocol/src/types.ts`）

```ts
export interface SessionListToolsParams {
  /** 目标会话 id；服务端惰性创建该会话（与 session/prompt 同语义）。 */
  sessionId: string
}

export interface SessionListToolsResult {
  /** 当前可见工具清单（含 name/description/source）。 */
  tools: SessionListToolInfo[]
}

export interface SessionListToolInfo {
  name: string
  description: string
  /** 对齐 pi-desktop 的中性 KnownToolInfo.source 三值。 */
  source: 'builtin' | 'extension' | 'cordis'
}
```

### 3.2 server 实现（`server.ts`）

```ts
case 'session/listTools':
  return this.listTools(params as unknown as SessionListToolsParams)
```

私有方法：

- `getOrCreateSession(params.sessionId)` 拿 `SessionRecord`（复用现有惰性创建语义）。
- 读该 agent 作用域的可见工具 `ctx.tools`（`visible` map，或按 agent 作用域解析），迭代映射成 `SessionListToolInfo[]`。
- `source` 映射：core/builtin 工具 → `builtin`；cordis 插件注册 → `cordis`；扩展 → `extension`。若作用域信息不足，退而统一 `cordis`（显式降级，不伪造）。

**语义**：返回"该会话当前模型可见的工具"，与 pi 的 tool-gate 播报对齐（pi 播报的是 `pi.getAllTools()` 全量清单）。

## 4. 补面二：提问往返（provider + `session/answer` + 通知）

### 4.1 协议类型

```ts
/** 提问请求通知（server → 客户端）。 */
export interface QuestionRequestedNotification {
  sessionId: string
  /** server 铸造的提问 id，session/answer 回填时原样带回。 */
  questionId: string
  questions: AskUserQuestionItem[]
}

export interface SessionAnswerParams {
  sessionId: string
  questionId: string
  /** 对齐 pi-desktop 中性 QuestionAnswer：{id, selected[], custom?}。 */
  answers: SessionQuestionAnswer[]
}

export interface SessionQuestionAnswer {
  id: string
  selected: string[]
  custom?: string
}

export interface SessionAnswerResult {
  /** 答已送达；无值时回答被取消（对应 ASK_CANCELLED）。 */
  acknowledged: boolean
}
```

`AskUserQuestionItem` 从 `@deepseek-ai/dsh-user-questions/types` 引入（web provider 已在用，形状 = `{id, question, header?, options?, multi_select?}`）。

### 4.2 server 实现

**注册 provider**（构造期，仿 api-proxy L1369-1405）：

```ts
const pendingQuestions = new Map<string, { resolve, reject, sessionId }>()
const disposeProvider = ctx.userQuestions.registerProvider({
  ask(request) {
    const sessionId = request.agent?.id
    if (sessionId === undefined) {
      return Promise.reject(new UserQuestionError('sdk user interaction requires an agent-owned session', 'ASK_MISSING_AGENT'))
    }
    return new Promise((resolve, reject) => {
      const questionId = crypto.randomUUID()
      const pending = { resolve, reject, sessionId }
      pendingQuestions.set(questionId, pending)
      const onAbort = () => {
        pendingQuestions.delete(questionId)
        reject(new UserQuestionError('ask_user_question was aborted before the user answered', 'ASK_ABORTED'))
      }
      request.signal?.addEventListener('abort', onAbort, { once: true })
      this.transport.notify('session.question', {
        sessionId: String(sessionId),
        questionId,
        questions: request.questions,
      } satisfies QuestionRequestedNotification)
    })
  },
})
this.disposers.push(disposeProvider)
```

**`session/answer` handler**：

```ts
case 'session/answer':
  return this.answer(params as unknown as SessionAnswerParams)

private answer(params: SessionAnswerParams): SessionAnswerResult {
  const pending = pendingQuestions.get(params.questionId)
  if (pending === undefined) {
    // 已超时/已答/已取消——first-wins 语义，静默 acknowledge 不炸。
    return { acknowledged: false }
  }
  pendingQuestions.delete(params.questionId)
  pending.resolve(params.answers)  // resolve 成 AskUserQuestionAnswer
  return { acknowledged: true }
}
```

**语义要点**（与 web provider 对齐）：
- `questionId` 是 server 铸造的 rpcId，客户端原样回带，first-wins 认领。
- 答案形状对齐 pi-desktop 中性 `QuestionAnswer`（`{id, selected[], custom?}`），dsd 的 `AskUserQuestionAnswer` 若形状不同，在 server 侧做一次映射。
- 取消 = `answer` 回 `selected:[]` 且无 `custom`，或 server 在超时/abort 时 reject（结构化错误码）。

## 5. pi-desktop 侧对接清单（阶段二落地，本仓库执行）

dsh 补面完成后，pi-desktop 侧收尾：

| 文件 | 改动 |
|---|---|
| `client/dsh/dsh-backend.ts` | override `listTools` = `session/listTools`；`answerQuestion` = `session/answer`（替换 `writeDshAnswer`） |
| `client/dsh/dsh-event-translator.ts` | 译 `session.question` 通知 → 中性 `QuestionRequestEvent`（不再译丢，见 `goal-ask-pi-port.md` §2.3 标注的缺口） |
| `client/dsh/dsh-question-bridge.ts` | **删除**（文件侧车桥彻底下线） |
| `bootstrap/index.ts` | 删 `DshQuestionBridge` 装配 + `injectQuestion` 投递（提问改走 backend.onEvent 统一通道） |
| `plugins/sessions/ask/dsh-extension/index.mjs` | `ask_user_question` 改调 `ctx.userQuestions.ask`（或启用 DSH 自带 `dsh-tool-ask-user`，删文件侧车实现） |

## 6. 验收标准

1. `session/listTools` 返回非空工具清单（含 dsh 侧 goal/ask 工具），pi-desktop `DshBackend.listTools` 不再缺面。
2. `session/answer` 端到端：dsh 会话内 `ask_user_question` 触发 → 客户端收到 `session.question` → 回 `session/answer` → 工具结果回灌模型，同轮继续。
3. 取消/超时/abort 各路径返回结构化错误码（`ASK_CANCELLED`/`ASK_ABORTED`），不永久挂起。
4. pi-desktop 侧 `dsh-question-bridge.ts` 删除，`core/application`/`api`/插件 renderer 层零 `.my-harness-desktop-questions` 字面量。
5. 提问通知经 `transport.notify` 广播（事件驱动），无轮询。

## 7. 关键源码锚点

- SDK server：`packages/sdk/server/src/server.ts`（`handleRequest` L576、通知 L183-221、`getOrCreateSession` L619）
- 协议类型：`packages/sdk/protocol/src/types.ts`
- web provider 参考：`packages/host/apiproxy/src/api-proxy.ts`（`registerProvider` L1369-1405、`respond` L3696）
- ask 核心：`@deepseek-ai/dsh-user-questions`（`ctx.userQuestions.ask`/`registerProvider`）
- 工具注册表：`packages/core/tools/src/index.ts`（`ToolRuntime`、`ToolView.visible` L696、`ToolDefinition` L222）
