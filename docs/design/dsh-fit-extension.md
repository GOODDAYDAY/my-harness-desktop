# dsh 适配能力的单一落点：my-harness-fit-dsh-extension

> Version: v1 | Date: 2026-08-25
> 姊妹文档：`kernel-gap-audit.md`（pi/dsh 全量缺口审计）、`dsh-capability-gate.md`（能力门槛）、
> `atomic-send.md`（发送原子化 + 思考强度契约）、`dsh-sdk-server-supplement.md`（阶段二交接规格）。

## 1. 规则（一条）

**dsh 相对「通用流程」没补齐的能力，统一在 `my-harness-fit-dsh-extension` 这个 cordis 插件里补。** 不散在 per-plugin `dshExtension`、不新开桌面插件私货、不改 deepseek-harness、不做「让 dsh 装 pi」的运行时翻译。

「通用流程」= 中立契约（`BaseBackend`）+ 适配器翻译（`DshBackend` 把 dsh 原生 SDK server 的 `session/*` 方法投成契约）。凡通用流程覆盖得了的，走通用流程；覆盖不了的，落进本包；本包也补不了的，显式降级（壳置灰/隐藏入口，不静默、不伪造成功，§7.6）。

## 2. 三层次：dsh 能力从哪来

| 层 | 载体 | 覆盖什么 |
|---|---|---|
| ① 通用流程（适配器翻译） | `client/dsh/dsh-backend.ts` + SDK server `session/*` | 会话/分支/消息/模型/中断/命名/seed/续跑/书签 |
| ② 内核插件补面（本包） | `my-harness-fit-dsh-extension`（cordis 插件） | 工具、生命周期钩子、服务 fork、文件侧车 |
| ③ 显式降级 | 壳 `capabilities` 探测 + 置灰/抛错 | 补不了也不伪造的 pi 专属扩展面 |

## 3. 本包已收编（合并自 4 个随插件 dsh 扩展）

| 能力 | 形态 | 原来源 |
|---|---|---|
| `ask_user_question` 工具 | 工具 + 文件侧车（写问句 → 轮询答案 → 回灌） | ask |
| `get_goal` / `create_goal` / `update_goal` 三工具 | 工具 + 文件侧车持久化（CAS） | goal |
| 全局 CLAUDE.md 注入 | `agent/pre-step` 钩子 | read-claude-md |
| 技能启用/禁用轴 + 完整列表播报 | fork `dsh-skill-filesystem` + 写 `~/.dsh/desktop-skills.json` | skill-manager |

`inject = ["tools", "skills"]`；除 skill 轴需 `import @deepseek-ai/dsh-skill-filesystem`（「关闭」轴唯一可靠落法）外，其余零 import dsh 内核包。

## 4. 仍显式降级的（按规则判断「该不该进本包」）

| 能力 | 现状 | 判定 |
|---|---|---|
| `listTools`（工具发现） | `AbstractBackend` 缺面默认 → null | **不进本包**：这是 SDK server 方法面，属 deepseek-harness（`dsh-sdk-server-supplement.md` 阶段二 `session/listTools`）。本包是 cordis 插件，加不了 JSON-RPC 方法。 |
| `setThinkingLevel`（运行时切档） | 抛「当前内核不支持思考强度切换」 | **不进本包**：dsh 的 `reasoningEffort` 是配置态（`agent-default-model`/settings.yaml），运行时切档是 pi 专属语义，硬补 = 让 dsh 装 pi（§3.1）。发送路径已跳过（能力探测），显式切档抛错显形。 |
| `getThinkingLevels`（档位清单） | pi 扩展面，dsh 无清单 | **不进本包**：同上，`reasoningEffort` 无清单 RPC，composer 对 dsh 空档位置灰。 |
| `steer` / `followUp` / `abortRetry` / `$bus` / `onExtensionUI` | pi 扩展面，dsh 无对应 | **不进本包**：都是 pi 的多路并发/会话总线/扩展 UI 专属面，dsh 无同语义物，显式降级（入口置灰）。 |
| `llm:oneshot`（一次性问底座） | dsh 无 | **可进本包**（若要做）：一个一次性 spawn 的工具，可作 cordis 工具或壳侧降级。当前降级，演进再定。 |

**判定口诀**：dsh 内核**能原生兑现**的能力补面（注册工具 / 挂生命周期钩子 / fork 服务 / 文件侧车）→ 进本包；**把 pi 的运行时协议/扩展面硬翻译过来**（steer、thinkingLevel 运行时切档、扩展 UI）→ 不进本包，显式降级或留 deepseek-harness 原生支持。

## 5. 落地约束（写新补面时）

1. **只动 `src/client/dsh/dsh-extension/index.mjs`**（加工具/钩子/服务），`extension.json` 更新描述；同步/挂摘/对账全走现成 `syncFitDshExtension` + `reconcilePluginDshExtensions`（单块 id `my-harness-fit-dsh-extension`）。
2. **零 import dsh 内核包**（skill 轴除外）：优先 node 内建模块 + 文件侧车，避免把桌面壳耦合进 dsh 的包图。
3. **文件侧车落点**：`~/.pi/agent/.my-harness-desktop-*`（问句/目标）或 `~/.dsh/*`（技能播报/禁用名单），壳侧适配器（`dsh-question-bridge`/`dsh-skill-provider`）已按这些路径消费，不换路径。
4. **能力探测对称**：新增能力若需壳侧感知「有/无」，走 `capabilities.dsh`（懒探测缺面）或能力位，不写 `kernel === "dsh"` 硬分支（§1.5）。
5. **补面失败不炸 dsh**：同步失败只记日志；插件内异常 try/catch 降级，不因一块能力拖垮整个插件树。

## 6. 对照：为什么「让 dsh 装 pi」是错的

- `set_thinking_level`（pi RPC）↔ `reasoningEffort`（dsh 配置）：语义不同（运行时 vs 配置），硬补运行时切档 = 给 dsh 造一个 pi 形状的 RPC，真长处（进程级模型 + 配置态 effort）被埋掉。
- `session/persistence-jsonl`（dsh 侧插件）↔ pi 的 JSONL 文件：dsh 用 JSONL 持久化是为了「能跑成桌面内核」，不是「读 pi 的存储格式」——这是能力补面，不是翻译。
- 分界：**补「能力」**（dsh 缺什么就给什么，用 dsh 自己的插件机制）= 本包；**翻译「协议」**（把 pi 的运行时协议照搬到 dsh）= 违反 §3.1，不做。
