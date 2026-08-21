# 内核拉平缺口审计：PI vs DSH

- 本文是 `kernel-alignment.md` 的实证配套。那篇讲「怎么拉平」（三层次 + 内置插件 + 基类继承），本文做「哪里没拉平」的全项目扫描：把每一处 pi/dsh 不对称、每一处内核形状泄漏、每一处 dsh 缺面定位到文件与统计，作为拉平工作的核对清单。扫描基于 `main` 分支当前工作树（含已提交的 `a1eb5ab` 内核层重构）。

- 判据沿用 `multi-kernel-shell.md` §3.3 那一问：**壳是不是必须向每一个内核索要它？** 答不上（是某个内核专属）的，就进「缺口」，去向要么内置插件补面、要么显式降级，不允许静默缺面。

## 1. 汇总统计

| # | 维度 | 缺口量 | 性质 | 优先级 |
|---|---|---|---|---|
| G1 | 壳契约层 pi 形状 API（`domain/sessions.ts`） | **21 个方法** | pi 专属能力漏进圆心契约，dsh 下缺面 | 高 |
| G2 | 编排层 pi-only 分支（`session-store.ts`） | **21 处 `asPi` + 9 处 kernel 判断** | pi 专属能力经类型守卫分发，未走能力接口 | 高 |
| G3 | 协议层 pi 专属命令（`protocol/commands.ts`） | **26 个 `build*Command`** | 全 pi 31 命令，dsh 走独立 JSON-RPC | 中（协议本就内核专属） |
| G4 | 传输/进程层不对称（`client/pi` vs `client/dsh`） | pi 13 文件 / dsh 5 文件 | pi 有 5 扩展安装器 + oneshot，dsh 无对应 | 中 |
| G5 | dsh 显式缺面（`dsh-backend.ts`） | **3 处 throw** + 5 项能力缺口 | seed/deleteBookmark/图片 + oneshot/$bus/steer/扩展UI/思考档位 | 高（seed 阻塞跨内核切换） |
| G6 | 插件层 pi 假设（专属 API 调用） | **6 处** | timeline 3 + renderer store 3 | 中 |
| G7 | 内核管理 UI 不对称（pi-manager vs dsh-manager） | pi 5 文件 / dsh 1 文件 | 功能等价但实现厚度不同 | 低 |
| G8 | 收尾项（基类 + 接口化） | 3 项 | AbstractBackend / PiBackendExtensions / DshConfigApi | 中 |

## 2. G1 壳契约层：pi 形状 API（21 个）

- `core/domain/sessions.ts` 的 `SessionsApi` 接口树里，混进了 pi 的专属能力。这些是「pi 的 31 命令」直接投影到壳契约的结果，dsh 下没有对应能力（缺面）。清单：

| 接口 | 方法 | 数量 |
|---|---|---|
| `MessagingApi` | `steer` / `followUp` / `abortRetry`（多路并发） | 3 |
| `ModelApi` | `cycleModel` / `getThinkingLevels` / `setThinkingLevel` / `cycleThinkingLevel`（思考档位） | 4 |
| `SessionTreeApi` | `clone` / `forkFromSession` / `getForkMessages`（文件级 fork） | 3 |
| `SessionMaintenanceApi` | `compact` / `setAutoCompaction` / `setAutoRetry` / `exportHtml` / `getLastAssistantText` | 5 |
| `QueueModeApi` | `setSteeringMode` / `setFollowUpMode`（多路并发队列） | 2 |
| `BashApi` | `run` / `abortBash`（pi bash 工具） | 2 |
| `SessionsApi` | `onExtensionUI` / `replyExtensionUI`（pi 扩展 UI） | 2 |

- **去向**：这些方法里，`compact`（dsh 有 `compaction-basic`）、`clone/fork`（BaseBackend 已中性化）能拉平；`steer/followUp/abortRetry/setSteeringMode/setFollowUpMode`（多路并发）、`onExtensionUI/replyExtensionUI`（扩展 UI）、思考档位（`thinkingLevel` vs `reasoningEffort` 概念不同）拉不平——要么 dsh 侧写 cordis 插件补，要么壳在 dsh 下显式降级。理想终态：这 21 个方法从 `SessionsApi`（圆心契约）里拆出去，收敛成 `PiExtensions` 接口（内核专属扩展面），壳插件按「有则用、无则降级」访问（`multi-kernel-shell.md` §3.3）。

## 3. G2 编排层：session-store 的 pi-only 分支

- `core/application/sessions/session-store.ts` 是 pi 专属能力的实际分发点，全部经 `asPi` 类型守卫 + `kernel` 身份判断。统计：

- **`asPi(proc)` 调用 21 处**，覆盖约 13 种 pi 专属方法：`steer` / `followUp` / `abortRetry` / `cycleModel` / `cycleThinkingLevel` / `setThinkingLevel` / `setSessionName` / `compact`（经 `piSend`）/ `getSessionStats` / `getLastAssistantText` / `abortBash` / `sendExtensionUIResponse` / `sendMessage(streamingBehavior)`。
- **`kernel === "pi" / "dsh"` 判断 9 处**（行 297 / 563 / 576 / 593 / 855 / 886 / 1024 / 1205 / 1382），其中 6 处是 pi 专属通道绑定与能力分发，3 处是 dsh 分支（test/模型测试）。

- **缺口**：这些分支是「壳漏内核身份」的实据（`multi-kernel-shell.md` §5.7）。理想是换成能力接口——`asPi` 返回 `PiBackendExtensions`（而非 `import type { PiBackend }` 具体类），pi 专属通道经 `backend.capabilities` 探测而非 `kernel === "pi"` 硬判断。

- **switchKernel 的两个既有缺口**（`session-store.ts` 的 `switchKernel`）：① 切内核后新后端**不重新注入 system prompt**（`factory.create({ cwd, agentDir, kernel })` 没传 `systemPromptPaths`，角色卡/系统提示在切换后丢失）；② 会话头 `kernel` 归属重绑未完成（`boundSessionPath` 重绑了，会话头里的 `custom-my-harness-desktop.kernel` 未同步）。

## 4. G3 协议层：pi 专属命令 vs dsh JSON-RPC

- `core/protocol/commands.ts` 有 **26 个 `build*Command`** 构造（`buildPromptCommand` … `buildSetSessionNameCommand`），全部是 pi 的 JSONL 31 命令。`event-translator.ts`、`context-binding.ts` 也只服务 pi（`toModelInfo` 写死 `kernel: "pi"`）。
- dsh 走独立的 `client/dsh/json-rpc.ts`（JSON-RPC 2.0，`session/*` 方法集）+ `dsh-event-translator.ts`。
- **评估**：协议本就是内核专属形状，两套并存是「适配器各翻译各的」的正当形态（`base-interface-lineage.md` §4.2）。不是缺口，但标注：pi 的协议面（protocol/）在 `core/protocol`，dsh 的协议面在 `client/dsh`，物理位置不对称——若追求对称，dsh 的 `session/*` 方法契约也应有一个 `core` 内的纯契约层（现状 dsh 的方法名散在 `json-rpc.ts` 字符串里，无类型枚举）。

## 5. G4 传输/进程层：client 对称性

- `client/pi`：13 个生产文件——传输（`rpc-adapter`/`correlator`/`subprocess-handle`/`subprocess-lifecycle`/`pi-cli`/`pi-oneshot`/`patch-rpc-mode`/`known-tools`）+ **5 个扩展安装器**（`toolgate-installer`/`subagent-extension-installer`/`bus-extension-installer`/`context-probe-installer`/`pi-extension-installer`）。
- `client/dsh`：5 个生产文件——`json-rpc`/`subprocess-lifecycle`/`dsh-config-source`/`dsh-backend`/`dsh-event-translator`。
- **不对称**：① pi 的「内置插件」有 5 个 installer 落盘管理，dsh 的内置插件经 `DshConfigSource.addPlugin` 写 cordis.yml，没有对等的 installer 抽象（缺一个 `dsh-extension-installer` 或统一成「内核扩展安装器」接口）；② pi 有 `pi-oneshot`（`llm:oneshot` 一次性问底座），**dsh 无 oneshot**（`llm:oneshot` 在 dsh 下缺面）。

## 6. G5 dsh 显式缺面（高优先级）

- `client/dsh/dsh-backend.ts` 有 **3 处显式 throw**（诚实标注，不伪造成功）：
  1. **`seed` 未接线**（`待 dsh 侧 session/seed`）——**阻塞跨内核切换**：`switchKernel` 的 pi→dsh 在第 5 步 `seed` 降级报错（`session-store.ts` switchKernel）。
  2. **`deleteBookmark` 未接线**（dsh 书签是 fork 出的子会话，删子会话生命周期未接）。
  3. **图片输入未接线**（attachment 服务缺面）。
- 另有 **5 项能力缺口**（无对应实现，非 throw）：
  - `llm:oneshot`（dsh 无一次性问底座）
  - 会话总线 `$bus`（`onBusFrame` 仅 pi 后端有，dsh 无）
  - 多路并发 `steer/followUp`（dsh 无）
  - 扩展 UI `onExtensionUI/replyExtensionUI`（dsh 无）
  - 思考档位 `thinkingLevel`（dsh 是 `reasoningEffort`，概念不同）
- 外加 **sessionId 退化**：`dsh-backend.ts` 的 `sessionId` 缺省 `cwdToBucketName(cwd)`（每项目一会话），真正的 session-id 化未做。

## 7. G6 插件层 pi 假设（6 处）

- `src/plugins/sessions/timeline/renderer/index.tsx`：`ctx.models.setThinkingLevel`（1 处）+ `ctx.messaging.abortRetry`（2 处）。
- `src/api/renderer/stores/session-store.ts`：`window.pi.sessions.getThinkingLevels`（1 处）+ `setThinkingLevel`（2 处）。
- **评估**：这几处是「思考档位 + 自动重试」两个 pi 专属能力在 timeline 里的调用。dsh 下缺面。理想：思考档位走「内核能力探测」（dsh 展示 `reasoningEffort`，pi 展示 `thinkingLevel`），`abortRetry` 在 dsh 下隐藏/禁用。

## 8. G7 内核管理 UI 不对称

- `pi-manager`：5 个 renderer 文件（`index`/`extensions`/`models`/`base-url-input`/`import-modal`），3 TAB（Pi 内核 settings.json / PI 拓展 / 模型 models.json）。
- `dsh-manager`：4 个 renderer 文件（`index`/`kernel`/`extensions`/`models`），3 TAB（DSH 内核 / DSH 拓展 / DSH 模型）。
- **评估**：三页（内核版本 / 拓展 / 模型）各自是两份 copy，漂移已超出「拆组件对齐」能修的范畴，处置是抽 base + 继承（`kernel-design-spec.md` §12.4/§12.5/§12.6），pi/dsh 各写薄 wrapper 填 spec。逐页漂移实证：

  - **安装页**：`dsh-manager/kernel.tsx` ↔ `pi-manager` 的 `KernelSection` 逐行 copy；dsh 的 `setCustomCliDir` 缺 `pendingCount`（改自定义目录不标记运行中会话待重启、UI 不提示「N 个会话已标记待重启」）。前置拉平 `dshKernel.setCustomCliDir` 的 `pendingCount` 契约 + 统一 i18n key。
  - **模型页**：pi 走 framework configFile（models.json），dsh 走 manual（settings.yaml 分 namespace），保存 UX 不同；字段拼写漂移（`baseUrl`/`baseURL`、内联 `apiKey`/`apiKeyEnv`）；默认模型落点不同；**dsh 删除/改名 provider 不落盘**（`save` 从不调已实现的 `removeProvider`/`renameProvider` IPC，settings.yaml 旧 route 残留、刷新复活）。前置拉平：抽 `KernelModelsApi` 中性契约 + `ModelConfigPage` base，`reasoning` 走 capabilities 降级，保存模式统一「页面内保存」。
  - **拓展页**：pi 有 tag 筛选 / `disallowOff` 保护锁标 / `PendingRestartSection` 真实重载，dsh 只有 id/name 卡片 + 静态重启文案。前置拉平：`NeutralExtension` 中性形状 + `KernelExtensionsPage` base（`kernel` prop 自取适配器）；元数据缺面降级（字段留空）、`protected` 与 `pendingRestart` 补面。

## 9. G8 收尾项（需要修改的）

1. **`AbstractBackend` 抽象基类**（`kernel-alignment.md` §5）：抽基类承载缺面默认，`PiBackend`/`DshBackend` 改继承，删 dsh 的 `deleteBookmark`/`seed` 重复抛错。
2. **`PiBackendExtensions` 接口**：`session-store.ts` 的 `import type { PiBackend }` 换成只 import 接口，`asPi` 返回接口类型。
3. **`DshConfigApi` 接口**：`MainContext.dshConfigSource: DshConfigSource` 换成接口，`DshConfigSource implements`。
4. **switchKernel 补两个缺口**（§3）：system prompt 重注入 + 会话头 kernel 重绑。

## 10. 优先级建议

- **P0（阻塞性）**：dsh `seed`（不补则跨内核切换 pi→dsh 恒失败）；switchKernel 的 system prompt 重注入。
- **P1（高）**：`AbstractBackend` 基类 + `PiBackendExtensions` 接口（把 G2 的 21 处 `asPi` + 9 处 kernel 判断收敛）；G1 的 21 个 pi 形状 API 拆出 `SessionsApi`。
- **P2（中）**：dsh `deleteBookmark`/图片输入；启用现成 cordis 插件拉平子代理/压缩（`kernel-alignment.md` §6 阶段 B）；`DshConfigApi` 接口。
- **P3（低）**：`steer`/`$bus`/`onExtensionUI` 的补面或显式降级；内核管理 UI 三页抽 base + 继承（G7，`kernel-design-spec.md` §12.4/§12.5/§12.6）；`llm:oneshot` 的 dsh 补面或降级。
