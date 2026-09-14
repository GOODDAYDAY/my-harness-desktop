# llm-recorder 双内核对齐：DSH 侧记录搬到执行面

> 症状：DSH 内核跑会话时，右侧「请求记录」里的请求只有 **147B**（响应 66B）——一条 `{"provider":"us-new","model":"…"}`，messages / system / tools / 响应内容全无。
> PI 侧同一条记录是 **313KB**（253 条实测均值）——完整请求体 + 组装态响应。用户的原话是「DSH 的一直都是 67B，核心内容完全没有」。

## 1 根因：钩子挂在了构造面，而"发了什么"是执行事实

DSH 侧记录挂在 `agent/request`：

```js
ctx.on("agent/request", async (payload, next) => {
  const cfg = await next();          // ← LlmCallConfig：provider/model/temperature/maxTokens/stop
  appendLine(sid, { …, payload: cfg });
});
```

`agent/request` 是**构造面**的钩子，它的产出契约就叫 `LlmCallConfig`——按内核自己的类型注释，它只拥有"provider、model、思考档位、采样标量"这五个字段。**对话历史、system、工具 schema 不在这个钩子的契约里，不是"没取到"，是"这里根本没有"**。

完整请求只存在于**执行面**：`llm` 服务的 `llm/stream` waterfall。

```js
// @deepseek-ai/dsh-llm: LlmRuntime.streamWithRegistration
return this.ctx.waterfall(this, "llm/stream", options, () => this.adapterStream(options, prepared));
```

`options` 的类型是 `GenerateOptions`（同一份类型注释：「A single model request, fully assembled.」）：

| 字段 | 内容 | 对应 PI 侧 |
|---|---|---|
| `provider` / `model` / `reasoningEffort` / `temperature` / `maxTokens` / `stop` | 采样与路由 | `payload.model` 等 |
| **`messages: Message[]`** | 完整对话历史（provider 看到的那一份） | `payload.messages` |
| **`system?: string`** | system prompt 成品 | `payload.system` |
| **`tools?: ToolSchema[]`** | 工具 schema 全量 | `payload.tools` |
| `sessionId` | 会话身份（= 会话 id，即日志文件名） | 来自 `ctx.sessionManager.getSessionFile()` |
| `purpose?: 'compaction' \| 'session-title'` | 调用用途（回合外内部调用） | 「无 turnIndex」那一档 |

PI 侧之所以全量，正因为它的 `before_provider_request` 就在同一个位置（"每次 LLM 请求发出前，payload 是完整请求体"）。**两个内核对齐的正确做法不是把 DSH 的配置"补全"，而是把 DSH 的记录挂到 PI 已经站着的那个位置。**

这就是 CLAUDE.md §3.2「构造与执行分开」在本 bug 上的原样复现：构造面给的是"打算怎么发"，执行面给的才是"实际发了什么"。记录工具的价值全在后半句。

### 1.1 连带的三处不对齐（同一根因）

| 位置 | 旧行为（构造面） | 新行为（执行面） |
|---|---|---|
| 响应行 | `agent/turn-stopping` 结算，只有 `durationMs`，无 message | 在 `llm/stream` 包住返回的 chunk 流，组装成与 PI 同形状的 assistant 消息 |
| turnIndex | 自己从 `payload.turn` 抄 | 回合身份取自 `session/event` 的 `step/start`（内核自己宣布的回合/步），`purpose` 非空的调用不带 turnIndex |
| 会话键 | `payload.agent.id`（构造面的 agent 句柄） | `options.sessionId`（执行面盖的会话身份，内核 invariant 断言"loop 建请求必带 sessionId"） |

## 2 终态：DSH 写侧新数据面

```
session/event(step/start) ──┐                    ← 回合身份（内核宣布）
                            ├─→ markState[sid] = {turn, step}
llm/stream(options, next) ──┴─→ ① 写 request 行（payload = options 的可序列化投影）
                                ② return wrap(next())  ← 原样透传 chunk
                                        └─ 流终结/提前结束 → 写 response 行（组装态 message）
```

**四条不变量**：

1. **透传不干扰**：wrap 出来的 async iterable 必须逐块、按序、原样把 chunk 交给下游；不改写、不缓冲整轮再吐（会破坏流式体验）、不吞异常。下游提前 `break` 时在 `finally` 里照样结算（写已组装的部分）。
2. **只读不写内核对象**：`options` 由 loop `deepFreeze` 冻结（内核 invariant 会断言冻结），我们只读。落盘走**显式投影**——`signal`（AbortSignal）是非序列化运行时句柄，显式丢弃并在设计里记明。
3. **开关前置**：`recordEnabled === false` 时 `return next()`，零包装、零开销——记录扩展不能给正常链路加任何东西。
4. **异常静默**：任何记录侧异常吞掉，绝不让记录影响会话（与 PI 侧同纪律）。

### 2.1 响应组装：为什么是自己算，而不是"影子实现"

内核把流式 chunk 组装成消息的算法是 `BlockAssembler`（"the single canonical assembly algorithm"）。我们**不 import 它**——插件目录在 `~/.dsh/.my-harness-desktop-plugins/` 下运行，import 内核包会把"能被测试的纯函数"变成"只能在真内核里跑的代码"（PI 侧同纪律：不 import 内核类型包）。

记录侧只需要一个**只做投影、不参与任何内核决策**的最小组装器：chunk → `ContentBlock[]` + usage + finish。它服务的是"把流原样落成可读记录"，和内核用它来决定"下一步跑哪个工具"是两件事。组装器的输入输出都是内核的公开 chunk 类型，不做任何归一化改写。

## 3 行契约：读侧的唯一真相源（不变 + 补两个字段）

行契约与 `docs/design/llm-recorder-design.md §3.2` 一致，只有读侧类型补齐：

```jsonc
// request 行（两内核同形）
{"seq":1,"ts":…,"kind":"request","turnIndex":0,"payload":{…}}
// response 行
{"seq":1,"ts":…,"kind":"response","status":200,"durationMs":1800,"message":{…}}
//                              ↑ 可缺（DSH 无 HTTP status）  ↑ 可缺（DSH 失败/中止）
//                              error?  ← 新增：失败事实（DSH 的 agent 级失败、或流的 error/aborted finish）
```

- `turnIndex` 缺省 = 回合外内部调用（两内核同语义：PI 的 compaction、DSH 的 `purpose` 调用）。
- `message` 缺省 = 该次调用没有可展示的组装消息（失败、中止）。**读侧必须显式降级，不许把"内核没给"渲染成"形状未识别"。**
- `error` 存在 = 这次调用失败（DSH 不伪造 status）。**读侧必须据此标失败，不许因为 status 缺省而渲染成成功。**

### 3.1 读侧形状词典（按形状，不按内核身份）

两内核落盘的是**各自的原生形状**，读侧不做归一化、不判内核身份（§7.5 三条不变量），只在"块类型名/字段名"这一层认识两套词汇：

| 概念 | PI（provider 原生） | DSH（内核中立） |
|---|---|---|
| 思考块 | `{type:'thinking', thinking}` | `{type:'reasoning', text}` |
| 工具调用 | `{type:'tool_use'\|'toolCall', name, input\|arguments}` | `{type:'tool-call', id, name, arguments}`（arguments 是 **JSON 字符串**） |
| 工具结果 | `{type:'tool_result', content, is_error}` | `{type:'tool-result', toolCallId, content: 块数组, isError}` |
| system | 字符串 或 块数组 | 字符串 |
| 工具 schema | `input_schema` | `parameters` |
| usage | `input`/`output`/`cacheRead`/`cacheWrite`/`totalTokens`/`cost` | `inputTokens`/`outputTokens`/`cacheReadTokens`/`cacheWriteTokens`/`reasoningTokens` |
| stopReason | 字符串 | `{kind:'stop'\|'tool-calls'\|…}` |

这张表是**形状适配**，不是内核分支：任何 provider 只要吐这两套词汇里的任一套，面板都能画。

## 4 修复清单（根因级，非补丁）

**写侧（`dsh-extension/`）**
- `index.mjs`：钩子从 `agent/request` 迁到 `llm/stream`（`{global:true}`，子代理作用域内的调用同样可见）+ `session/event(step/start)` 取回合身份；流包装 + 结算。
- `chunks.mjs`（新，纯函数）：chunk 流 → `{blocks, usage, finish}`；有 `block-end` 用内核给成品块，delta-only 协议按 index 增量补齐。
- `project.mjs`（新，纯函数）：`GenerateOptions` → 可落盘投影（丢 `signal`）；turn 标记状态机（`step/start` 写入、`llm/stream` 消费、`purpose` 调用不消费）。
- 分期/续号/`index.json` 沿用（已有守卫），`requests` 计数口径与 PI 对齐（只数 request 行）。

**读侧**
- `core/log-model.ts`：`ResponseLine` 补 `error?`、`message?` 转可选。
- `core/payload-model.ts`：形状词典（块别名、schema 键、usage 键、stopReason 归一）；`describeRequest/describeResponse` 对缺 message 显式返回「无内容」而不是 unrecognized。
- `renderer/`：失败判定纳入 `error`；详情视图对"无 message"给显式降级文案；显示 provider；`fmtTime`/字节数收敛到单一定义。

**文档**
- 本文件；`docs/plugins/insight/llm-recorder.md`（现文写"本插件对 dsh 显式缺席"，与代码反向矛盾）；`docs/design/llm-recorder-design.md §2.5` 增补执行面数据源。

## 5 验证（三级 + 真机）

| 级 | 内容 |
|---|---|
| unittest | `chunks.test.ts`（块组装：block-end 优先、delta-only、提前结束、error finish）；`project.test.ts`（投影丢 signal、turn 标记消费/不消费、purpose 内部调用）；`log-model.test.ts` 补 `error`；`payload-model.test.ts` 补形状词典两套词汇 |
| DOM | 面板渲染 DSH 形状行：System / 工具定义 / 消息历史 / 用量 / 失败行标红 / 无 message 显式降级 |
| e2e | 真 DSH 内核 + 真模型一轮对话 → 盘上字节数（>10KB，不再 147B）、DOM 三段齐全、截图留证；同一套断言跑 PI 侧作对照 |

**验收判据（写死，免得自证）**：同一轮对话，DSH 的 request 行 `payload.messages` 非空、`system`/`tools` 与 PI 侧同量级；面板上 DSH 与 PI 的折叠结构一致（System / 工具定义 / 消息历史 / 原始 JSON）。
