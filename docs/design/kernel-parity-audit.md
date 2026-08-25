# 内核拉平审计：pi vs dsh 四轴缺口

> Version: v1 | Date: 2026-08-25
> 定位：这是「把两边内核拉平到同一套桌面协议」的核对清单，按 **事件转发 / 设置 / 能力 / 会话模型** 四轴逐项对照。
> 姊妹文档：`kernel-gap-audit.md`（历史全量缺口，部分已过期）、`dsh-fit-extension.md`（dsh 补面单一落点规则）、`dsh-capability-gate.md`（能力门槛）。
> 判据（§1.5）：**壳是不是必须向每一个内核索要它？** 答得上 → 中立契约；答不上 → 补面（`my-harness-fit-{pi,dsh}-extension`）或显式降级。不允许静默缺面。

## 1. 汇总

| 轴 | 缺口量 | 性质 | 状态 |
|---|---|---|---|
| A 事件转发 | dsh 只映射了 ~10/45 事件 | 流式/重试/压缩/标题等**有事件没转发** | 本轮补 3 类，流式仍缺 |
| B 设置 | 模型/默认/密钥已适配；思考强度/多路并发语义不同 | 配置面 vs 运行时面不对齐 | 部分拉平 |
| C 能力 | 工具发现/多路并发/扩展UI/思考档位 | pi 扩展面，dsh 显式降级 | 见 `dsh-fit-extension.md` |
| D 会话模型 | fork 已拉平；clone/compact/export 缺 | 文件级操作 pi 专属 | 部分拉平 |

## 2. A 事件转发矩阵（核心缺口）

中性事件域 `SessionEvent`（`core/domain/events/session-state.ts`）是壳唯一认的事件。dsh 侧翻译在 `client/dsh/dsh-event-translator.ts`。

| 中性事件 | pi 源 | dsh 源 | dsh 状态 |
|---|---|---|---|
| `agentStart` | `agent_start` | `turn/start` | ✅ |
| `agentSettled` | `agent_settled` | `turn/end`（带 `reason`） | ✅ |
| `agentEnd` | `agent_end` | —（dsh 用 `agentSettled` 表达回合收敛） | ⚠️ 无对应，靠 agentSettled |
| `stepStart`/`stepEnd` | `turn_start`/`turn_end` | `step/start`/`step/end` | ✅ |
| `messageStart`/`messageUpdate` | `message_start`/`message_update` | `assistant/chunk`（token 流式） | ✅ **已接**——`createDshEventTranslator` 带跨事件状态，text/reasoning 增量组装成 messageStart/Update |
| `messageEnd` | `message_end` | `user/message` + `assistant/message` + `assistant/chunk(finish-error)` | ⚠️ 端到端有，流式无 |
| `toolCallStart` | `tool_execution_start` | `tool/call` | ✅ |
| `toolCallUpdate` | `tool_execution_update` | `tool/code-dispatch*` | ❌ 未接 |
| `toolCallEnd` | `tool_execution_end` | `tool/result` | ✅ |
| `compactionStart`/`compactionEnd` | `compaction_start`/`compaction_end` | `compaction/start`/`compaction/end` | ✅ **本轮补** |
| `autoRetryStart` | `auto_retry_start` | `llm/retry` | ✅ **本轮补** |
| `autoRetryEnd` | `auto_retry_end` | —（dsh 无「重试序列终结」事件，失败经 `assistant/chunk(finish-error)` / `turn/end(error)` 表达） | ⚠️ 无干净对应 |
| `queueUpdate` | `queue_update` | `agent/inbox/spliced`（delta 非 total count） | ⚠️ 事件是 splice 增量，无 pending 总数，不精确 |
| `sessionInfoChanged` | `session_info_changed` | `session/title`（latest-wins） | ✅ **本轮补** |
| `modelSelect` | `model_select` | `request/header`（provider/model 在 header 里） | ❌ 未接 |
| `sessionStart` | `session_start`（扩展） | —（main 合成 `synthetic sessionStart`） | ✅ main 层合成 |
| `entryAppended` | `entry_appended` | —（dsh 落盘走 surface 事件） | ⚠️ 水合路径不同 |
| `thinkingLevelChanged`/`Select` | `thinking_level_changed`/`select` | —（`reasoningEffort` 是配置态） | ➖ 语义不同，降级 |

**未接但 dsh 有对应事件的**（按优先级）：
1. ~~`assistant/chunk` → `messageStart`/`messageUpdate`~~ ✅ 已接（流式）。
2. `request/header` → `modelSelect`：dsh 的 `request/header` 每 step 都发（`reason: initial/resume/change`），映射会刷屏；且壳已通过 `setModel`/`ModelCatalog` 跟踪模型——**不是干净补面，降级不接**。
3. `tool/code-dispatch*` → `toolCallUpdate`：dsh 工具是 call→result（无中间进度），`tool/code-dispatch` 是 `run_code` 子调度的专用事件，非通用工具进度——**语义缺口，非「忘了转发」**。

**dsh 有但中性域无对应、丢弃的**（log-only）：`todo/write`、`request/context`、`session/end-seed`、`session/meta`、`hook/*`、`approval/*`、`schedule/change`、`feedback/record`、`plan/mode`、`sandbox/mode`、`permission/preset`、`subagent/descriptor`、`tool-workflow/*`、`command/*`、`goal/change` 等——这些要么不在壳渲染面，要么是内核私有生命周期。

## 3. B 设置矩阵

| 设置 | pi | dsh | 状态 |
|---|---|---|---|
| 模型清单 | `models.json`（providers） | `settings.yaml` `llm-pi-ai` 多路由 + `agent-default-model` | ✅ 已适配（`KernelModelsApi`） |
| 默认模型 | `settings.json` default | `agent-default-model`（provider/model/reasoningEffort） | ✅ 已适配 |
| API 密钥 | `models.json` apiKey | `.credentials.yaml` / `apiKeyEnv` | ✅ 已适配（`prefs.dshApiKeys`） |
| 思考强度 | `thinkingLevel`（运行时 RPC） | `reasoningEffort`（配置态） | ➖ 语义不同，显式降级（发送路径跳过，下拉置灰） |
| 重试上限 | `settings.json` `retry.maxRetries` | `llm-retry` 插件（事件有 `maxRetries`/`policyKey`） | ⚠️ 事件已转发，配置面未对齐（dsh 侧 retry 策略在哪配待确认） |
| 自动压缩 | `settings.json` autoCompaction | `compaction-basic` 插件 | ⚠️ 事件已转发，启停配置未对齐 |
| 多路并发档 | `steeringMode`/`followUpMode` | —（dsh 无多路并发） | ➖ pi 扩展面，降级 |
| 插件树 | pi extensions（目录） | `cordis.yml`（插件块） | ✅ 各自管理（`PiExtensionManager`/`DshExtensionManager`） |
| 技能启停 | skills-extension 播报 | fit-dsh-extension fork + 播报 | ✅ 已拉平 |

## 4. C 能力矩阵（摘要，详见 `dsh-fit-extension.md`）

| 能力 | 层 | 状态 |
|---|---|---|
| 消息/中断/切模型/命名/seed/续跑/分支/书签 | 适配器（`DshBackend` + SDK server `session/*`） | ✅ |
| 提问 / goal / CLAUDE.md / 技能轴 | `my-harness-fit-dsh-extension`（cordis） | ✅ |
| 工具发现 `listTools` | 缺面 → null | ⚠️ SDK server 方法面（`dsh-sdk-server-supplement.md`），不进 cordis 包 |
| 思考强度运行时切档 | 显式降级抛错 | ➖ 配置态，不补（避免「让 dsh 装 pi」） |
| 多路并发 / 会话总线 / 扩展 UI | pi 扩展面 | ➖ 降级 |

## 5. D 会话模型矩阵

| 操作 | pi | dsh | 状态 |
|---|---|---|---|
| fork | 文件副本 | `session/fork`（子会话） | ✅ 已拉平（`ForkResult.sessionReplaced` 归一） |
| getTree/getEntries/bookmark/resume | parentId 树 / 文件 | `session/getTree` 等 | ✅ |
| clone（复制会话） | `copy` 文件 | — | ⚠️ 文件级操作，dsh 缺 |
| compact（手动压缩） | `compact` RPC | compaction-basic 插件（自动） | ⚠️ 手动触发面缺 |
| exportHtml | `export_html` | — | ➖ 缺面 |
| 会话统计 | `get_session_stats` | `session/projectStats` + 壳自算 | ✅（壳自算字段已内核无关） |

## 6. 优先级（拉平顺序）

- **P0（已做）**：`compaction/start+end`、`llm/retry`、`session/title` 三组事件转发；`assistant/chunk` token 流式（`createDshEventTranslator`）。
- **P1（剩余）**：重试/压缩的配置面拉平（`llm-retry`/`compaction-basic` 的 settings 命名空间待对齐）；`queueUpdate` 的 pending 总数（若 dsh 暴露）。
- **P2（语义缺口，显式降级）**：`modelSelect`（壳已用 setModel 跟踪）、`toolCallUpdate`（dsh 无中间进度）、多路并发/扩展UI/思考档位。
