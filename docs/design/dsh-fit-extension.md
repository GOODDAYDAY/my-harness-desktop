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
| ② 内核插件补面（本包） | `my-harness-fit-dsh-extension`（cordis 插件） | 工具、生命周期钩子、服务 fork、文件侧车、**SDK server 方法面**（§3.1） |
| ③ 显式降级 | 壳 `capabilities` 探测 + 置灰/抛错 | 补不了也不伪造的 pi 专属扩展面 |

## 3. 本包已收编（合并自 4 个随插件 dsh 扩展）

| 能力 | 形态 | 原来源 |
|---|---|---|
| `ask_user_question` 工具 | 工具 + 文件侧车（写问句 → 轮询答案 → 回灌） | ask |
| `get_goal` / `create_goal` / `update_goal` 三工具 | 工具 + 文件侧车持久化（CAS） | goal |
| 全局 CLAUDE.md 注入 | `agent/pre-step` 钩子 | read-claude-md |
| 技能启用/禁用轴 + 完整列表播报 | fork `dsh-skill-filesystem` + 写 `~/.dsh/desktop-skills.json` | skill-manager |
| **SDK server 方法面补全**（16 个 `session/*`） | patch `HarnessSdkJsonRpcServer.prototype.handleRequest`，用 dsh core API 实现（§3.1） | — （本包新增，无前身） |

`inject = ["tools", "skills"]`；除 skill 轴需 `import @deepseek-ai/dsh-skill-filesystem`（「关闭」轴唯一可靠落法）外，其余零 import dsh 内核包。

## 3.1 本包新增：SDK server 方法面补全（2026-09-14）

除上表四块能力外，本包现在还承担**桌面所需的全部 dsh JSON-RPC 方法面**（`sdk-methods.mjs`，
设计文档 `dsh-sdk-method-supplement.md`）。背景：npm 发布的 `dsh-sdk-jsonrpc-server` 只有 3 个
request 方法（`initialize` / `session/prompt` / `shutdown`），0.1.1-rc.2 到 0.1.5-rc.2 一直如此；
而桌面要调 16 个。症状是 goal 续跑失败 +「dsh 内核版本过旧,缺少 session/seed(请升级 dsh 内核)」——
而升级是死路（装到的还是 3 个方法）。

关键认知：**缺的只是方法暴露层，core 能力全在**（`ctx.agents` / `ctx.sessions` /
`ctx.sessionPersistence` 在 npm 版与上游构建版逐字节相同）。所以补面 = 用 dsh 自己的公开 core API
实现协议层，不是把上游 `server.ts` 抄一遍，也不是「让 dsh 装 pi」。

两个实测教训（勿回退）：

1. **双副本陷阱**：插件 bare import 到的 dsh 包可能与 CLI 运行时实际用的不是同一份
   （`~/.dsh/node_modules` 可能是符号链接指向别处）。patch 打在 A 副本、服务请求的是 B 副本
   → **补面全部静默失效**（连既有的 setModel / thinkingLevel / session-meta 一起废），
   而症状是「内核版本过旧」。正解：`resolveRuntimeModule` 从 `process.argv[1]` 出发解析，
   且 patch 覆盖**全部副本**。
2. **单一 patch 点**：本仓所有 SDK 方法面（补缺 + 强语义接管）都经 `installSdkMethodSupplement`
   注册进一张表。不要加第二个 `handleRequest` patcher（两个 patcher 互相包裹 → 顺序依赖 +
   错误归属难查）。静态守卫已钉：`dsh-sdk-method-coverage.test.ts`。

## 4. 仍显式降级的（按规则判断「该不该进本包」）

> ⚠ **本表「现状」列有两行已过期**（"判定"列的结论仍可参考，但"现状"已不准）：
> - `setThinkingLevel` 那行写"抛「当前内核不支持思考强度切换」"——**已不成立**：`setThinkingLevel` **已进中立契约**
>   （`docs/design/atomic-send.md`），dsh 走 thinking 补面，不支持的档位**显式跳过**（`session-store.ts` 的档位校验），不再抛错。
> - `getThinkingLevels` 那行写"pi 扩展面，dsh 无清单"——**已不成立**：dsh 经其适配插件提供
>   `session/getThinkingLevels`（这正是"思考档位补发失败"那个 bug 的成因：dsh **有**清单、只是该模型返回空）。
>
> （`listTools` 那行"缺面默认 → null"仍然成立。）

| 能力 | 现状 | 判定 |
|---|---|---|
| `listTools`（工具发现） | `AbstractBackend` 缺面默认 → null | **暂不进本包**（演进）。❗ 旧理由「本包是 cordis 插件，加不了 JSON-RPC 方法」**已被证伪**（2026-09-14）：本包现在就用 `HarnessSdkJsonRpcServer.prototype.handleRequest` 的 patch 补了 13 个 `session/*` 方法（`sdk-methods.mjs`，见 §3.1）。真实理由是优先级：工具发现不在核心链路上（缺了只影响工具面板，不影响发送），且 `session/listTools` 需先定好中性 `source` 三值（builtin/extension/cordis）的映射口径——口径未定就补等于自己发明契约。上游交接规格仍在 `dsh-sdk-server-supplement.md`。 |
| `setThinkingLevel`（运行时切档） | 抛「当前内核不支持思考强度切换」 | **不进本包**：dsh 的 `reasoningEffort` 是配置态（`agent-default-model`/settings.yaml），运行时切档是 pi 专属语义，硬补 = 让 dsh 装 pi（§3.1）。发送路径已跳过（能力探测），显式切档抛错显形。 |
| `getThinkingLevels`（档位清单） | pi 扩展面，dsh 无清单 | **不进本包**：同上，`reasoningEffort` 无清单 RPC，composer 对 dsh 空档位置灰。 |
| `steer` / `followUp` / `abortRetry` / `$bus` / `onExtensionUI` | pi 扩展面，dsh 无对应 | **不进本包**：都是 pi 的多路并发/会话总线/扩展 UI 专属面，dsh 无同语义物，显式降级（入口置灰）。 |
| `llm:oneshot`（一次性问底座） | dsh 无 | **可进本包**（若要做）：一个一次性 spawn 的工具，可作 cordis 工具或壳侧降级。当前降级，演进再定。 |

**判定口诀**：dsh 内核**能原生兑现**的能力补面（注册工具 / 挂生命周期钩子 / fork 服务 / 文件侧车 / **用 core API 实现 SDK 方法面**）→ 进本包；**把 pi 的运行时协议/扩展面硬翻译过来**（steer、扩展 UI）→ 不进本包，显式降级或留 deepseek-harness 原生支持。

❗ 口诀前半句在 2026-09-14 扩了一项：「用 dsh 自己的 core API 实现 JSON-RPC 方法面」也是**补能力**，
不是翻译协议——它用的是 dsh 的 `ctx.agents.create({seed})` / `ctx.sessions.fork` /
`deriveMessages()`，形状全是 dsh 自己的，只是把上游未发布的协议层补上（§3.1）。

## 5. 落地约束（写新补面时）

1. **只动 `src/server/kernel/dsh/extension/dsh-extension/`**（`index.mjs` 加工具/钩子/服务，`sdk-methods.mjs` 加 SDK 方法面），`extension.json` 更新描述；同步/挂摘/对账全走现成 `syncFitDshExtension` + `reconcilePluginDshExtensions`（单块 id `my-harness-fit-dsh-extension`；同步是整目录 `cpSync`，多文件天然支持）。
2. **对 dsh 内核包的取用走运行时闭包解析**（`resolveRuntimeModule`，从 `process.argv[1]` 出发），不用 bare import：bare import 可能解析到另一份副本，patch / 集合补面打在错副本上等于没做（§3.1 教训 1）。除此之外优先 node 内建模块 + 文件侧车，避免把桌面壳耦合进 dsh 的包图。
3. **文件侧车落点**：`~/.pi/agent/.my-harness-desktop-*`（问句/目标）或 `~/.dsh/*`（技能播报/禁用名单），壳侧适配器（`dsh-question-bridge`/`dsh-skill-provider`）已按这些路径消费，不换路径。
4. **能力探测对称**：新增能力若需壳侧感知「有/无」，走 `capabilities.thinking`（懒探测缺面）或能力位，不写 `kernel === "dsh"` 硬分支（§1.5）。
5. **补面失败不炸 dsh**：同步失败只记日志；插件内异常 try/catch 降级，不因一块能力拖垮整个插件树。

## 6. 对照：为什么「让 dsh 装 pi」是错的

- `set_thinking_level`（pi RPC）↔ `reasoningEffort`（dsh 配置）：语义不同（运行时 vs 配置），硬补运行时切档 = 给 dsh 造一个 pi 形状的 RPC，真长处（进程级模型 + 配置态 effort）被埋掉。
- `session/persistence-jsonl`（dsh 侧插件）↔ pi 的 JSONL 文件：dsh 用 JSONL 持久化是为了「能跑成桌面内核」，不是「读 pi 的存储格式」——这是能力补面，不是翻译。
- 分界：**补「能力」**（dsh 缺什么就给什么，用 dsh 自己的插件机制）= 本包；**翻译「协议」**（把 pi 的运行时协议照搬到 dsh）= 违反 §3.1，不做。
