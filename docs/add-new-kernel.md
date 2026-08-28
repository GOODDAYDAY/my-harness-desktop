# 如何新增一个内核：抽象是否合理

本文回答一个具体问题：如果要接第三个内核（假设的 "kimi"，或任何新 agent 运行时），要交什么、现有抽象哪里够用、哪里不合理需要补。论证对象是 my-harness-desktop 的多内核壳——`packages/shared/src/domain`（圆心契约）+ `src/server/kernel/`（内核层）+ `src/server/application/sessions/session-store.ts`（编排）+ `src/server/bootstrap/assemble.ts`（组装根）。每一句论断都落到具体文件/函数/类型名，不空谈。

先给总判定，再展开清单、覆盖度、不合理处、逐条裁定，最后 QA。

## 0 总判定

**结论：核心抽象（BaseBackend / SessionCatalog / KernelModelSource / KernelSpec）是合理且偏保守的，但"加第三个内核一行不改"这句口号不成立——它需要动 6 个文件、补约 6 处字面量分叉、且暴露出四处结构性缺陷：`capabilities` 只有 pi/dsh 两个硬桶、`BackendCreateOptions` 字段偏 pi/dsh 对称、`SessionCatalog` 的同步/惰性二分会把第三个内核逼进"文件型 vs RPC 型"的错误选项、以及 pi 特权在 application 层仍有残留。这些缺陷今天能被 pi/dsh 两个实现掩盖，第三个内核会逐个戳穿。**

一句话概括抽象的健康度：**骨架是对的，接缝是脏的。** 骨架 = 圆心契约 + 抽象基类 + 工厂注入 + 注册表绑定，这条链上"加内核"的增量子集清晰、可编译器强制。接缝 = 内核身份泄漏进 `session-store` 的 `asPi()`/`KERNEL_IDS[0]`/`"pi"` 字面量、`assemble.ts` 的 `if (kernel !== "dsh")`、`controllers/kernel.ts` 的 dsh-优先-pi-兜底、以及圆心里 `DshCapabilities`/`SessionCapabilities.piExtension/dshExtension`/`manifest.piExtension/dshExtension` 这一串"按内核分字段"的假泛化。假泛化是最大的债：它把"N 个内核"建模成了"N 个互斥命名字段"，而不是"一个注册表 + 一个能力字典"。

---

## 1 加第三个内核的完整清单

按"圆心 → 内核层 → 注册表 → 分叉点"四段列出。清单是穷尽的，每一项都能在代码里指到行号。做完这些，一个内核才"可托管"（起得来、契约意图逐条有响应、崩了壳能收尾）。

### 1.1 圆心：身份字面量（2 处）

- `packages/shared/src/domain/kernel.ts:10` 的 `export type KernelId = "pi" | "dsh"` → 加 `| "kimi"`。
  - 这是全仓唯一合法的字面量联合源。加这一笔，编译器会逼着补完下面所有 `switch(kernel)` / `Record<KernelId, ...>` / `KERNEL_IDS` 消费处——这正是字面量联合优于 `string` 的直接红利，也是这个文件存在的全部理由。
- `kernel.ts:13` 的 `export const KERNEL_IDS = ["pi", "dsh"] as const` → 加 `"kimi"`。
  - 该常量被 `session-store` 的 `getBackend`/`sendPromptTo`（`KERNEL_IDS[0]`，见 §4.4）与运行时枚举消费。加第三个内核后，`KERNEL_IDS[0]` 仍指向 "pi"，这行代码的"默认取第一个内核"语义就变成 bug——详见 §4.4。

判定：**合理，必改。** 字面量联合 + 常量数组是唯一源，值得保留；不要改成 `string`（那会丢掉编译期穷尽检查，把所有 switch 变成运行时 undefined）。

### 1.2 交三样东西（§6.4 的硬门槛）

每样对应一个目录、一批文件：

- **spawn 命令**：新目录 `src/server/kernel/kimi/backend/subprocess-lifecycle.ts`，产出 `{ cmd, args, env }` 或 `SubprocessHandle`。
  - 参照 `pi/backend/subprocess-lifecycle.ts`（`spawn("pi", args, { shell })` + `myHarnessDesktopDir/pi/node_modules/.../dist/cli.js` 路径派生）和 `dsh/backend/subprocess-lifecycle.ts`（`createDshSubprocess`，注入 `cliPath`/`cordisConfig`/`env`）。
  - 内核专属 spawn 字段（`cliPath`/`cordisConfig`/`apiKey`/`kimiConfig`）**不进契约**，由工厂闭包捕获（§6.2 判别气味四）。
- **适配器**：`src/server/kernel/kimi/backend/kimi-backend.ts`，`class KimiBackend extends AbstractBackend<KimiBackendContext>`，override 14 条 abstract + 按需 override 缺面默认。
  - 14 条 abstract 清单见 `core/abstract-backend.ts`：`kernel`/`alive`/`start`/`stop`/`onEvent`/`sendMessage`/`abort`/`setModel`/`setSessionName`/`getTree`/`getEntries`/`bookmark`/`deleteBookmark`/`seed`。漏一条就编译错，这是防静默缺面的最后一道物理闸。
  - 事件翻译独立成文件（参照 `pi/protocol/event-translator.ts`、`dsh/backend/dsh-event-translator.ts`），把 kimi 专属事件形状投成中性 `SessionEvent`。
- **会话模型映射**：`src/server/kernel/kimi/backend/kimi-catalog.ts`，`class KimiSessionCatalog implements SessionCatalog`，把 kimi 的会话存储投影到 lineage 坐标系。
  - 关键实现点：`newSessionId`（返回 `string` = 预生成，返回 `null` = 惰性）、`projectionPath`（lineageId → 投影地址）、`rawFilePath`（可打开的原始文件，存在才返回）、`getTree`（纯存储读 lineage 树）、`seed` 对应的投影函数（参照 `piSeedSession` 写文件 / `buildDshSeedSession` 包树发 RPC）。

判定：**合理，三样东西是必要充分条件，不是可选项。** 但注意：第 1.2 的"适配器"和第 1.1 的"身份字面量"之间还缺一层——`SessionCatalog` 的 `seed` 投影不归 `SessionCatalog` 管，它归 `BackendFactory.seed`（圆心契约，`backend.ts:255`）管。这个归属的分裂是 §4.6 要讨论的缺陷，但清单本身是对的。

### 1.3 注册表绑定（4 个工厂文件 + assemble 里的 3 个映射）

- `src/server/kernel/factories/kernel-factories.ts`：加 `createKimiBackend(opts: KimiFactoryOptions)`（翻译中性 `BackendCreateOptions` → kimi spawn 参数）、`createKimiCatalog(opts)`、按需导出 `kimiSeedSession`。
  - 参照 `createPiBackend`（line 38-52，把 `systemPromptPaths` 拼成 `--append-system-prompt`、`ephemeral` 拼成 `--no-session`）与 `createDshBackend`（line 63-86，`ephemeral` 建临时 `DSH_SESSION_ROOT`、`provider/model/maxTokens` 进 initialize 握手）。
  - 这是内核专属 spawn 翻译的唯一落点——"中性字段 → 内核专属 args"的翻译只允许在这里发生。
- `src/server/kernel/factories/kernel-managers.ts`：加 `createKimiKernelManager(installDir)`。
  - 参照 `createPiKernelManager`/`createDshKernelManager`，各一行 `new XxxKernelManager(XXX_SPEC, installDir)`。
  - `KIMI_SPEC: KernelSpec` 填在 `src/server/kernel/kimi/manager/kimi-kernel.ts`，只填数据（`pkg`/`pkgJsonPath`/`cliWithinPkg`/`srcCli`/`srcPkgJson`/`cliJsLabel`/`distTag`/`extraPackages`）。
- `src/server/kernel/factories/kernel-logos.ts`：`KERNEL_LOGOS: Record<KernelId, KernelLogo>` 加 `kimi: KIMI_LOGO`。
  - 这是编译期穷尽的 `Record<KernelId, ...>`，加 `KernelId` 字面量后这里漏补会编译错——好。
  - `KIMI_LOGO` 数据声明在 `src/server/kernel/kimi/manager/kimi-logo.ts`（数据，非 React 组件，参照 `pi-logo.ts`/`dsh-logo.ts`）。
- `src/server/bootstrap/assemble.ts` 里的 3 个 `Record<KernelId, ...>`/映射：
  - `kernelModels`（line 304-310，`{ pi: ..., dsh: ... }`）→ 加 `kimi: createKimiModelsApi(...)`。类型是 `KernelModelsRegistry`。
  - `kernelConfig`（line 319-322，`Record<KernelId, KernelConfigApi>`）→ 加 `kimi: createKimiConfigApi(...)`。这是编译期穷尽，加字面量后漏补会错——好。
  - `kernelExtensions`（line 449-452，`{ pi: piExtensionManager, dsh: dshExtensionManager }`）→ 加 `kimi: kimiExtensionManager`。**注意这个映射不是 `Record<KernelId,...>` 类型**，是普通对象字面量，漏补不编译错——坏（见 §4.5）。

判定：**注册表绑定这个机制合理（每个内核一个工厂文件，一行构造），但"注册"的强类型程度参差**——`KERNEL_LOGOS`/`kernelConfig`/`kernelModels` 是 `Record<KernelId,...>` 编译期穷尽，`kernelExtensions`/`skillAggregator` 的数组/字面量不是。统一成 `Record<KernelId,...>` 是廉价的改进。

### 1.4 模型源合流

- `src/server/kernel/kimi/model/kimi-model-source.ts`：`class KimiModelSource implements KernelModelSource`，`listModels(): ModelInfo[]`（每个 `kernel: "kimi"`）。
  - 参照 `pi/model/pi-model-source.ts`（`ModelsStore` 的 provider 树 → `ModelInfo[]`）与 `dsh/backend/dsh-config-source.ts`（`listModels()` line 311-322，`kernel: "dsh" as const`）。
- `src/server/bootstrap/assemble.ts:177`：`new ModelCatalog([new PiModelSource(modelsStore), dshConfigSource])` → 追加 `new KimiModelSource(...)`。
- `model-catalog.ts` 本身**一行不改**——这是四个抽象里覆盖度最干净的一个（§3.3）。

判定：**合理，零改动面是真实成立的。** `ModelCatalog` 只持 `KernelModelSource[]` 做 `flatMap`，加内核 = 加数组元素，是本文唯一敢说"一行不改"的地方。

### 1.5 补所有 `switch(kernel)` / `if (kernel === ...)` 分叉

这是清单里最容易被漏、也最说明问题的一段。grep 全仓后，内核身份分叉点分两类：**会话意图链路上的分叉（红线）**和**组装根/控制器的分叉（可接受但要补）**。

**组装根 `assemble.ts`（3 处，必须补）：**

- `baseBackendFactory.create`（line 220-245）：`if (opts.kernel !== "dsh") return createPiBackend(...)` —— 这行把 pi 当默认、dsh 当例外。加 kimi 后必须改写成三路（或查表）：`if (opts.kernel === "dsh") ... else if (opts.kernel === "kimi") ... else createPiBackend(...)`。**这行本身是缺陷**（§4.2），它把"非 dsh 即 pi"的隐含假设焊进了组装根。
- `baseBackendFactory.seed`（line 248-251）：`if (kernel === "pi") return piSeedSession(...); return null;` —— 加 kimi 后必须补 `else if (kernel === "kimi") return kimiSeedSession(...)`（若 kimi 支持预 seed），否则 kimi 会静默落到"返回 null 走 RPC seed"的 dsh 路径。
- `sessionCatalogFactory.create`（line 274-278）：`kernel === "dsh" ? createDshCatalog(...) : createPiCatalog(...)` —— 同样以 pi 为默认，加 kimi 要补三路。
- 另：`reconcileMissingKernels` 的 entries（line 690-693）加 `{ kernel: "kimi", manager: kimiKernelManager }`；`PI_INSTALL_DIR`/`DSH_INSTALL_DIR`（line 108-110）旁加 `KIMI_INSTALL_DIR`。

**控制器 `controllers/kernel.ts`（1 处，必须补）：**

- `getFallbackModel`（line 154-161）：`if (dshDefault) return {..., kernel: "dsh"}; ... return {..., kernel: "pi"}` —— 这是"模型默认"逻辑，但把 dsh 写死优先、pi 写死兜底。加 kimi 后"默认模型"的语义要重新定义（哪个内核的 agent-default-model 优先），不是简单加一行能解决的。**这是内核身份泄漏进"默认模型"策略的又一例**（§4.3）。

**application 层 `session-store.ts`（多处，加 kimi 后部分会炸）：**

- `catalogFor`（line 225-232）是 `Map<KernelId, SessionCatalog>`，自动泛化——好。
- 但 `get catalog`（line 233-235）恒返回 `catalogFor("pi")`、`get dshCatalog`（line 236-238）恒返回 `catalogFor("dsh")`，`newPiSessionPath`（line 242-246）恒走 pi。这些是 pi/dsh 命名别名，加 kimi 后不新增 `get kimiCatalog` 也能工作（因为真正的新代码走 `catalogFor(kernel)`），但**别名本身是 pi 特权的残留**（§4.4）。
- `resolveSessionKernel`（line 388-399）：`custom?.["kernel"] === "pi" || custom?.["kernel"] === "dsh"` —— 这里把 `KernelId` 字面量又写了一遍，加 kimi 后**读回历史 kimi 会话会报错**（不是编译错，是运行时拒绝，因为这里没有走 `isKernelId`）。这是 §4.3 要展开的"字面量第二份定义"。

判定：**分叉点总量不大（10 处左右），但每一处的"补"都不只是加一个 case**——因为多处把 pi 当默认、把 dsh 当例外，加第三个内核 = 把"二值例外"重构为"三值表"或"查注册表"。这正是 §1.5 的结论：**清单不长，但暴露的是接缝的脏，不是骨架的硬。**

---

## 2 现有抽象够用的部分

逐条论证四个核心抽象的覆盖度，以及"够用"到底够在哪。

### 2.1 BaseBackend：意图集合的覆盖度是够的，且有编译器兜底

- **六条核心意图 + 两条会话意图 + seed + 探测**全部在 `backend.ts:70-151` 落成字段：`sendMessage`（消息）、`abort`（中断）、`setModel`（模型）、`getTree`/`getEntries`/`bookmark`/`resume?`（分支/会话标识）、`onEvent`（流式事件）、`setSessionName`（命名）、`continue?`（续跑）、`seed`（投影）、`listTools?`/`answerQuestion?`/`capabilities`（工具/提问/能力探测）、`setThinkingLevel`（思考强度）。
- **一个内核要"可托管"，交的就是这 14 条 abstract + 若干可缺面。** 14 条必实现里没有一条是 pi/dsh 专属形状——`seed` 入参是 `NeutralEntry[]`（中性），`bookmark` 入参是 `lineageId + BoundaryRef`（不透明引用），`getTree` 返回 `LineageTree`（中性树）。新内核只需把它自己的会话/事件/fork 语义翻译成这些中性类型，不需要知道壳怎么渲染。
- **缺面默认在 `AbstractBackend` 里免费拿到**：`listTools` 返回 null、`answerQuestion`/`continue`/`setThinkingLevel` 抛错（`abstract-backend.ts:107-125`）。新内核若不支持工具发现/提问/续跑/思考切换，**什么都不写就自动得到"显式降级"**，不会静默吞、不会伪造成功。这是三分法（§7.6）在实现层的免费落地——pi 用 override 填了 `setThinkingLevel`/`continue`/`listTools`/`answerQuestion`，dsh 填了 `continue`/`answerQuestion`/`setSessionName`/`setModel`/`resume`，第三个内核按需填。
- **`BackendCreateOptions` 把内核专属 spawn 参数挡在了契约外**：`cwd`/`agentDir`/`kernel`/`neutralSessionId`/`systemPromptPaths`/`systemPromptTexts`/`ephemeral`/`provider`/`model`/`maxTokens`（`backend.ts:222-240`），不含 `cliPath`/`cordisConfig`/`apiKey`——那些由工厂闭包捕获。这条边界是"换内核只换适配器"成立的前提，也是 §1.2"spawn 命令"能独立成文件的原因。

判定：**BaseBackend 的意图覆盖度是本文四个抽象里最成熟的**。但成熟里藏了两个裂缝，放 §4 展开：一是 `capabilities` 的形状（两个硬桶），二是 `provider`/`model`/`maxTokens` 三个字段其实各自只服务一个内核（§4.1）。

### 2.2 SessionCatalog：跨会话 CRUD 的"中性面"覆盖度够，但同步/惰性二分是定时炸弹

- **14 个方法覆盖了目录/CRUD 的全部需求**：`rename`/`updateHeader`/`deleteSessions`/`copy`/`readToolConfig`/`readCustom`/`contextProbeTokens`/`newSessionId`/`projectionPath`/`rawFilePath`/`projectStats`/`getTree`/`bookmark`/`deleteBookmark`（`backend.ts:264-321`）。
- **壳确实不读内核存储**：pi 的实现 `PiSessionCatalog`（`pi-catalog.ts:595-660`）读 JSONL 文件 + parentId 树，dsh 的实现 `DshSessionCatalog`（`dsh-catalog.ts:24-111`）经懒 spawn 的 JSON-RPC transport 走 `session/*` 方法——两者都藏在适配器里，`session-store` 只经 `catalogFor(kernel)` 拿到 `SessionCatalog` 接口，不 import 任何具体实现。
- **`rawFilePath` 是"打开原始文件"的唯一权威**（§7.6）：pi 返回派生路径（存在才返回），dsh 返回 `<sessionRoot>/<cwd桶>/<lineageId>/session.jsonl.zstd`（存在才返回）。新内核只要有"原始文件"概念就实现它，没有就返回 null，调用方显式降级。这个"返回 null = 没有可打开文件"的约定是干净的。

判定：**SessionCatalog 的"面"是够的，"形"有两个隐患**（§4.6）：`copy`/`contextProbeTokens`/`bookmark`/`deleteBookmark` 是同步的（pi 是 `copyFileSync`/`readFileSync`/`rmSync`），`newSessionId` 有"预生成 vs 惰性"的二值返回，第三个内核如果不是文件型也不是 RPC 型（比如远程 HTTP API、或内存态），会被这两个二分逼进错误选项。这不是"不够用"，是"过度特化到 pi/dsh 两个样本"。

### 2.3 KernelModelSource：最干净的抽象，真实一行不改

- 接口只有 `listModels(): ModelInfo[]`（`backend.ts:336-338`），`ModelInfo.kernel` 由实现写死自己的字面量（`pi-model-source.ts:21` 写 `"pi"`、`dsh-config-source.ts:314` 写 `"dsh" as const`）。
- `ModelCatalog`（`model-catalog.ts:22-35`）持 `KernelModelSource[]` 做 `flatMap`，`resolveModel(kernel, ref)` 按 `m.kernel === kernel` 过滤。加 kimi = 加一个 source + 在 assemble 追加一个数组元素，**`ModelCatalog` 零改动**——这是全仓唯一兑现了"加第三个内核一行不改"口号的地方。
- 模型档位分类 `classifyModel`（`model-catalog.ts:17-20`）是中性纯函数（reasoning 字段权威 + `id` 含 flash 兜底），不依赖内核，新内核的模型只要带 `id`/`reasoning` 就能被正确分类。

判定：**合理，是四个抽象里唯一没有结构性缺陷的。** 它之所以干净，是因为它的形状（一个纯查询接口）最小、不碰生命周期、不碰存储、不碰同步性——那些复杂度全被它推给了 BaseBackend/SessionCatalog 去扛。

### 2.4 KernelSpec / KernelManager / KernelRuntime / KernelReconcile：版本管理的"数据 vs 机制"分离是对的

- `KernelSpec`（`domain/kernel-manager.ts:11-29`）只放纯数据：`pkg`/`distTag`/`pkgJsonPath`/`extraPackages`/`cliWithinPkg`/`srcCli`/`srcPkgJson`/`cliJsLabel`。新内核交一份 `KIMI_SPEC` 即可，装/查/状态合成的通用逻辑全在 `KernelManager` 基类（`core/kernel-manager.ts:82-218`）里，一行不用写。
- 行为差异收进 `postInstall` 钩子（pi 打补丁 `pi-kernel.ts:27-32`，dsh 空实现 `dsh-kernel.ts:42-44`）+ 子类独有的 `installPlugin`（dsh 装 cordis 插件 `dsh-kernel.ts:48-60`）。
- `KernelRuntime`（`core/kernel-runtime.ts:11-29`）把 `installNpm`/`uninstallNpm`/`fetchRegistryVersions` 三个外层细节依赖倒置，`KernelManager` 不 spawn、不 fetch——新内核装不装、怎么装，都走同一套运行时，不额外写进程管理。
- `reconcileMissingKernels`（`core/kernel-reconcile.ts:37-63`）是"扫缺 → 判缺 → 补装"的通用编排，entries 数组加一项即可，串行/失败不抛/进度回调的机制全复用。

判定：**合理，这是"框架管通用、特化归外层"（§3.3）落地最彻底的一处**——pi/dsh 的版本管理差异被压成了 30 行 `KernelSpec` 数据 + 一个钩子，而不是两套装/查代码。新内核若走 npm 分发，几乎零成本接入；若不走 npm（比如 pip/二进制下载），`KernelRuntime` 的 `installNpm` 命名会露怯，但那是命名问题不是结构问题（§4.5）。

---

## 3 不合理/需要补的部分

这是本文的核心。逐条诚实指出抽象不合理处，不护短。每条给"缺陷 + 证据（文件/行号）+ 为什么第三个内核会戳穿它"。

### 4.1 `capabilities` 只有 pi/dsh 两个硬桶，没有通用扩展机制

- **证据**：`backend.ts:145` `readonly capabilities: { pi?: unknown; dsh?: DshCapabilities };`。`AbstractBackend` 默认 `capabilities = {}`（`abstract-backend.ts:48`），`PiBackend` override 成 `{ pi: this as PiBackendExtensions }`（`pi-backend.ts:111`），`DshBackend` override 成 `{ dsh: { missing, onMissing } }`（`dsh-backend.ts:85-87`）。
- **缺陷**：能力面被建模成"每个内核一个命名字段"——`pi` 槽对圆心是 opaque `unknown`，`dsh` 槽是具体 `DshCapabilities`。加 kimi 后，要么在圆心再加一个 `kimi?: KimiCapabilities` 字段，要么把 kimi 塞进现有的 pi/dsh 桶里 hack。前者是圆心每加一个内核改一次契约（违反"圆心不加内核专属概念"），后者是灾难（kimi 的能力探测要借 pi 或 dsh 的槽位语义）。
- **第三个内核会戳穿**：kimi 大概率既没有 pi 的 `steer/followUp/resync` 面，也没有 dsh 的 `missing/onMissing` 懒探测面，它有它自己的第三套能力形状（比如多模态、子 agent 树、或自有的降级协议）。现有两个桶装不下它，装不下就得改圆心。
- **正确的形状**：能力面应该是**内核自己声明、壳按 key 探测**的字典，而不是圆心预列名字。即 `capabilities: Readonly<Record<string, unknown>>`，内核放什么 key 它自己说了算，壳经 `capabilities["pi.steer"]` 或更窄的 `hasCapability("steer")` 探测；或者至少把 `pi`/`dsh` 这两个字段名从"圆心硬编码"改成"内核侧注册的 capability id"。当前 pi 槽用 `unknown` 已经是"我放弃在圆心描述你"的妥协，方向是对的，但 dsh 槽用了具体 `DshCapabilities` 又把圆心拉回了 dsh 专属——**一半妥协一半回退，最糟的中间态**。

裁定：**不合理，需补。** 优先级最高——它是"内核无特权差异"（§1.4）在能力面这条线被悄悄违反的地方：pi 用 opaque 逃过了圆心污染，dsh 没逃过。补法：把 `DshCapabilities` 挪进 `src/server/kernel/dsh/`（它本就在那定义更合适，圆心只留 `unknown` 或一个通用 `Capabilities` 字典），或把整个 `capabilities` 改成 `ReadonlyMap<string, unknown>` + 每个内核声明自己的 capability id 常量。

### 4.2 `BackendCreateOptions` 里有三个字段各自只服务一个内核

- **证据**：`backend.ts:222-240` 的 `BackendCreateOptions`：
  - `provider`/`model`：dsh 在 initialize 握手即用，pi 在 spawn 后经 `setModel` 命令（注释 line 226 自己承认了时机不对称）。
  - `maxTokens`：注释 line 238 写"dsh initialize 握手用;pi 忽略"——**一个 pi 忽略的字段进了中性契约**。
  - `systemPromptTexts`：pi 翻译成 `--append-system-prompt <text>`，dsh 忽略（注释 line 234）。`systemPromptPaths` 同理 pi 翻译、dsh 忽略。
  - `ephemeral`：pi=`--no-session`，dsh=临时 `DSH_SESSION_ROOT`（两者都有语义，这一个是真中性）。
- **缺陷**：中性契约的定义是"壳必须向每一个内核索要的字段"。`maxTokens` 只有 dsh 要、pi 忽略，`systemPromptTexts`/`systemPromptPaths` 只有 pi 要、dsh 忽略——**这两个方向各自有一个"另一个内核当空气"的字段混进了契约**。加 kimi 后，kimi 大概率也要它自己的某两个字段（比如 `thinkingBudget`、`toolsAllowlist`），照这个模式，契约会随着内核数量线性膨胀成"所有内核专属字段的大杂烩"。
- **为什么不早点修**：因为现在只有两个内核，每个"偏一方"的字段恰好能解释成"这就是两个内核的最小公约 + 一个多余"，成本低。第三个内核会把"最小公约"这个借口彻底拆穿。
- **正确形状**：`BackendCreateOptions` 只留真中性字段（`cwd`/`agentDir`/`kernel`/`neutralSessionId`/`ephemeral`），把 `provider`/`model`/`maxTokens`/`systemPromptPaths`/`systemPromptTexts` 挪进**每个内核的工厂入参**（`PiFactoryOptions`/`DshFactoryOptions` 已经在做这件事——`kernel-factories.ts:33-59` 分别 extends 了 `BackendCreateOptions` 加专属字段）。方向已经走了一半：工厂入参已经 extends 了，只是圆心契约还在替它们保留着一份"提前泄漏"。

裁定：**不合理，需补（方向已对，收尾即可）。** 把契约里的"半中性字段"下放到工厂入参，`BaseBackend` 的 `create` 只收真中性字段。这不是破坏性重构——工厂已经 extends，只是圆心契约该瘦身。

### 4.3 内核身份在圆心之外被复制了第二、第三份字面量

- **证据**：
  - `sessions.ts:217-219` 的 `isKernelId(v): v is KernelId { return v === "pi" || v === "dsh"; }` —— 圆心内部**第二次硬编码** `"pi" | "dsh"`。`kernel.ts` 注释说"全仓唯一一处能出现 'pi' | 'dsh' 字面量"，但 `isKernelId` 就是第二处，只是它恰好也在圆心目录里，被"同目录"掩盖了。
  - `session-store.ts:397` 的 `resolveSessionKernel`：`custom?.["kernel"] === "pi" || custom?.["kernel"] === "dsh"` —— application 层**第三次硬编码**。加 kimi 后读回历史 kimi 会话，这行返回 false，抛"会话头未记录内核归属"，运行时拒绝而非编译错误。
  - `session-store.ts:684` 的 `projectHeaderToKernel`：`... || "pi"` —— pi 作为默认内核字面量。
  - `assemble.ts:222` 的 `if (opts.kernel !== "dsh") return createPiBackend(...)` —— pi 作为默认分支。
  - `controllers/kernel.ts:156-160` 的 `kernel: "dsh" as const` / `kernel: "pi" as const` —— 控制器层再写。
- **缺陷**：契约单源（§1.3）说"一个概念只有一份定义"。`KernelId` 的联合字面量在 `kernel.ts` 一份，但"判断一个值是不是合法 KernelId"这个语义散在 `isKernelId`（圆心）+ `resolveSessionKernel`（application）+ `resolveKernel`（可能还有）至少三处。加 kimi 时，改 `kernel.ts` 的联合不会触发这些字面量比较的编译错（它们是比较不是 switch），于是"改了这里忘了那里"真实发生。
- **正确形状**：`isKernelId` 应该是唯一窄化函数，且应该由 `KERNEL_IDS.includes(v)` 或 `Set` 实现，而不是再次枚举字面量；`resolveSessionKernel` 应该调用 `isKernelId`，而不是自己写 `=== "pi" || === "dsh"`。这样加 kimi 只需改 `KERNEL_IDS` 一处，所有窄化自动跟进。

裁定：**不合理，需补（低成本高回报）。** 这是"契约单源"被字面量比较偷偷破坏的典型——switch 有编译期穷尽保护，`===` 比较没有。修法就是让所有运行时窄化走同一个 `isKernelId`（由 `KERNEL_IDS` 派生）。

### 4.4 pi 特权在 application 层仍有残留（`asPi` / `KERNEL_IDS[0]` / `newPiSessionPath` / `"pi"` 字面量）

- **证据**（全在 `session-store.ts`，application 层 = 用例编排层，按 §7.1 铁律这里不该有内核专属分支）：
  - `asPi(proc)`（line 1703-1707）：`proc.backend.capabilities.pi` 类型守卫，抛"当前后端不支持 pi 专属命令"。这是**能力探测**（注释自己辩解"经 capabilities.pi 探测，不按内核身份硬分支"），形式是对的，但名字叫 `asPi`、且 `piSend`（line 1687-1698）以它为唯一前提——**壳的编排里有二十多个 `piSend`/`asPi` 调用点**（`getModels`/`getThinkingLevels`/`steer`/`followUp`/`clone`/`compact`/`setAutoCompaction`/`exportHtml`/`bash`/`abortBash`/`getForkMessages`/`setSteeringMode`/`setFollowUpMode`/`cycleModel`/`cycleThinkingLevel`/`abortRetry`，line 1215-1680 一带）。这些是 pi 扩展面，壳为 pi 保留了一整套"如果我是 pi 就能调"的通道。加 kimi 后，kimi 若有专属能力，要再复制一套 `asKimi`/`kimiSend`。
  - `getBackend`（line 1905-1907）与 `sendPromptTo`（line 1964）：`this.procs.get(sessionKey)?.get(KERNEL_IDS[0])` —— **用 `KERNEL_IDS[0]`（恒 "pi"）当"默认内核"**。加 kimi 后这行语义不变（还是 pi），但它暴露了"有些 API 隐含默认 pi"。
  - `newPiSessionPath`（line 242-246）：名字和实现都写死 pi。
  - `spawnSession`（line 1933）与 `reopenSession`（line 1954）：`createProc(..., "pi", ...)` —— 会话总线的 spawn/reopen 硬编码 pi。
  - `projectHeaderToKernel`（line 684）：`|| "pi"` 兜底。
- **缺陷**：这些不是"pi 有特权"这么简单——是**pi 曾是唯一内核的历史重量还在**。`piSend`/`asPi` 是能力探测的正确形式，但它的"正确"是撞出来的（pi 恰好有扩展面），不是设计出来的（没有给"任意内核的专属扩展面"留一个统一通道）。加 kimi 后，kimi 的专属能力没有地方挂——要么再写 `asKimi`，要么把 kimi 的能力硬塞进中性契约（违反 §1.5），要么放弃 kimi 的专属能力（违反"显式降级不静默"）。
- **正确形状**：`asPi` 泛化成 `asExtensions<K>(proc, key: string)`（按 capability key 探测 + 收窄），`piSend` 泛化成 `sendViaExtensions`；`KERNEL_IDS[0]` 的"默认内核"语义要么显式成参数，要么删掉（让调用方显式传 kernel）。

裁定：**不合理，需补（中等成本，但优先级高，因为它是"内核无特权"铁律在代码里最显眼的一处违反）。** 注意：这里不是要删掉 pi 扩展面——pi 扩展面本身是对的（§7.6 三分法的"有则用无则降级"）。错的是"壳为 pi 专门开了一条 `asPi/piSend` 通道，却没有任何给下一个内核开的通用口子"。

### 4.5 插件 manifest 的 `piExtension`/`dshExtension` 字段，是把内核焊进了壳插件契约

- **证据**：
  - `contributions.ts:511-517`：`piExtension?: string; dshExtension?: string;` —— 壳插件 manifest 里按内核名字命名的两个字段。
  - `context.ts:284` / `sessions.ts:283,394`：`capabilities.piExtension` 相关。
  - `kernel-event.ts:113-115`：`SessionCapabilities { piExtension: boolean; dshExtension: boolean; }` —— **内核能力探测的结果也被拍平成两个布尔字段**。
  - `lifecycle/index.ts:78-90`：`PluginLifecycleDeps.piExtensionEnsure` / `dshExtensionEnsure`，line 102-106 逐个 `if (deps.piExtensionEnsure && manifest.piExtension)` 触发。
  - `assemble.ts:363-379`：`pluginPiExtensionEnsure`/`pluginDshExtensionEnsure` 两个闭包，各接一个安装器（`syncPluginPiExtension`/`syncPluginDshExtension`）。
- **缺陷**：壳插件要"给内核补能力"，manifest 里必须写 `piExtension` 或 `dshExtension`。加 kimi 后，壳插件要给 kimi 补能力，得在 `contributions.ts`（圆心！）加 `kimiExtension?: string`，在 `SessionCapabilities` 加 `kimiExtension: boolean`，在 `PluginLifecycleDeps` 加 `kimiExtensionEnsure`，在 assemble 加第三个闭包。**圆心每加一个内核改一次契约**，而且是改"壳插件契约"（`contributions.ts` 是槽位契约，本应内核无关）。这是四件套（§7.7）的 `pi-extension/`/`dsh-extension/` 目录结构在 manifest 层的投影——四件套本身是对的（每个内核的补面插件各归各），但 manifest 用"按内核命名字段"而不是"一个 `extensions: { kernel: path }` 映射"来表达，是错的。
- **正确形状**：`extensions?: Array<{ kernel: KernelId; path: string }>` 或 `{ [KernelId]: string }`，一个字段装所有内核；`SessionCapabilities` 的 `piExtension/dshExtension` 拍平成 `extensions: Record<KernelId, boolean>`（或干脆由 renderer 自己从 `capabilities` 字典推导，不拍平进 `SessionCapabilities`）。

裁定：**不合理，需补（中等成本）。** 它是"按内核分字段"这个假泛化模式污染最广的一处——从圆心 `contributions.ts` 到生命周期到能力广播，一路都在按内核名字铺字段。

### 4.6 `SessionCatalog` 的同步/惰性二分，会把第三个内核逼进错误选项

- **证据**（`backend.ts:264-321` 的 `SessionCatalog`）：
  - `copy(srcId, dstId): void` —— 同步，注释 line 276-278 明确"pi 是 copyFileSync，forkFromSession 编排依赖 copy 在 setContext 之前的同步段竞态护栏；dsh 无此面，降级抛错"。
  - `contextProbeTokens(sessionId): number | null` —— 同步，pi 是 `readFileSync`，dsh 返回 null。
  - `bookmark(cwd, lineageId, boundary): Anchor` —— 同步，pi 是 `copyFileSync`。
  - `deleteBookmark(anchor): void` —— 同步，pi 是 `rmSync`。
  - `newSessionId(cwd): string | null` —— 返回 `string` = 预生成（pi 新文件路径），返回 `null` = 惰性（dsh 服务端首次 prompt 建）。
  - 其余（`rename`/`updateHeader`/`deleteSessions`/`readToolConfig`/`readCustom`/`projectStats`/`getTree`）是 async。
- **缺陷一（同步混入 async 接口）**：`copy`/`contextProbeTokens`/`bookmark`/`deleteBookmark` 四个是同步签名，其余是 async。同步是 pi 的 `copyFileSync`/`readFileSync`/`rmSync` 硬塞进来的——pi 的文件写链路上锁需要同步语义（`pi-catalog.ts:7-8` 注释承认了），于是 `SessionCatalog` 接口为了迁就 pi 的锁语义，把本可 async 的 `copy`/`bookmark` 压成了同步。dsh 的 `copy` 直接抛 `NOT_WIRED`（`dsh-catalog.ts:55-57`），`bookmark`/`deleteBookmark` 是 no-op。**加 kimi 后，如果 kimi 的 copy 是 async（比如远程存储），它无法在同步签名里完成，只能像 dsh 一样抛"未接线"或硬改接口。**
- **缺陷二（newSessionId 的二值返回）**：`string | null` 把"会话标识的创建时机"压成两档：预生成（文件型）vs 惰性（服务端型）。第三个内核如果是"客户端生成 id 但不落文件"（比如纯内存会话、或 id 由客户端 UUID 直接决定且无文件），会被迫选 `string`（谎称有文件）或 `null`（谎称惰性）——两者都会让 `ensureForSend`（`session-store.ts:551-591`）的 `generated ?? catalog.projectionPath(cwd, randomUUID())` 分支走错。
- **缺陷三（boundSessionPath 的 `capabilities.pi` 判定）**：`session-store.ts:988` 和 `:1587` 的 `proc.boundSessionPath = newBackend.capabilities.pi ? newSessionId : null` —— **用"是不是 pi"来判"有没有文件型会话标识"**。这是把"文件型内核"这个语义偷换成了"pi"。加 kimi 后，如果 kimi 是文件型，这行会因 `capabilities.pi === undefined` 而错误地置 `boundSessionPath = null`，导致 `writeKernelToHeader`（line 1029-1033）跳过写回、`resolveProcKey` 兜底扫描失配。正确形状应该是 `newBackend.sessionId != null` 或一个显式的 `hasFileSession` 标志，而不是 `capabilities.pi`。

裁定：**不合理，需补（中等成本，但涉及接口签名，要谨慎）。** 同步/惰性二分不是"抽象错了"，是"抽象被 pi 的实现细节（同步锁 + 文件型 id）渗透了"。补法分两步：先把 `copy`/`bookmark`/`deleteBookmark`/`contextProbeTokens` 异步化（pi 内部用 `await` 包一层同步调用，接口回归 async 统一），再给 `newSessionId` 的"会话标识形态"一个显式字段（如 `SessionIdentityKind: "file" | "lazy" | "client-generated"`），替代 `string | null` 的二值猜测。

### 4.7 `switchKernel` 现在是 gate=false，且七步编排里的 seed 生命周期不对称是否泛化

- **证据**：`session-store.ts:181` `private switchKernelEnabled = false;`，`:921` `if (!this.switchKernelEnabled) throw new Error("跨内核切换暂未启用");`。七步编排（`switchKernel` line 919-998）原样保留，但入口 gate 死。
- **缺陷（两层）**：
  - **功能层**：跨内核切换是"加第三个内核"的核心用户价值（用户在 kimi 和 pi 之间切历史）。它现在被 gate 死，意味着第三个内核接进来后，用户切不过去——`switchKernel` 的七步（abort → 快照 → stop 旧 → seed → 模型中立化 → 重绑 → 收尾）只存在于死代码里，从未在真实 pi↔dsh 之间跑通过。
  - **抽象层（更根本）**：`switchKernel` 和 `materializeActiveLineage`（line 1552-1591）各写了一份几乎相同的"seed → 分内核 start/seed → 重绑"编排，且两份都靠 `seeded != null`（`BackendFactory.seed` 返回 null 的二分）来分 pi（预 seed）和 dsh（先 start 后 seed）。这就是 §4.6 缺陷二的动态版：**`BackendFactory.seed` 的"返回 null = 不支持预 seed"是 dsh 的 RPC 依赖进程这个事实的硬编码**。加 kimi 后，如果 kimi 的 seed 需要第三种时序（比如"先 start 再 seed 再 restart"），两份编排都得加第三个分支。
- **正确形状**：把 seed 生命周期从"pi 先 seed / dsh 后 seed"的二值，泛化成**内核自己声明的"seed 时序"能力**——比如 `BackendFactory.seedKind: "pre" | "post"`（或直接让 `seed` 内部自己处理 start 依赖），编排只调一个统一的 `materialize(lineage)` 流程。同时把 `switchKernel` 与 `materializeActiveLineage` 的重复编排收敛成一个（它们本就是"换内核"与"换分支"的同一件事——单线执行器的重投影）。

裁定：**不合理（gate=false 是产品决策，但把 seed 时序二分焊进编排是抽象缺陷），需补。** 优先级中等——因为 gate 关了，缺陷目前是死代码里的，不咬人；但第三个内核会让它活过来，活过来就是两份编排 + 三个分支的维护地狱。

### 4.8 契约注释与代码已经漂移（`fork` 不在 BaseBackend，"15 条"实为 14 条）

- **证据**：
  - `backend.ts:63` 注释"五个会话分支操作(§2.4)是核心"——五个分支操作实际是 `getTree`/`getEntries`/`bookmark`/`resume?`/`deleteBookmark`，**没有 `fork`**。
  - `abstract-backend.ts:37-38` 注释"15 条必实现意图全部声明为 abstract"，但实际 abstract 成员只有 **14 条**：`kernel`/`alive`/`start`/`stop`/`onEvent`/`sendMessage`/`abort`/`setModel`/`setSessionName`/`getTree`/`getEntries`/`bookmark`/`deleteBookmark`/`seed`。没有 `fork`。
  - CLAUDE/设计文档里"六条核心意图：消息/中断/模型/**分支**/会话标识/流式事件"仍把"分支"列为意图，但 `fork` 已经从后端契约挪到了中立层（`forkFromSession` 走 `upsertNeutralLineage` 纯操作，`session-store.ts:1601-1617`；`projectLineageTree` 是圆心纯函数，`backend.ts:181-211`）。**fork 是壳侧纯操作，不是内核 RPC**——这是 "kernel-forkless" 设计的落地。
- **缺陷**：这是"stale 标注"（§5.3），但它对"加第三个内核"有实际杀伤：**接入者读注释会以为要 override 一个 `fork` 方法，实际上 `fork` 不存在、真正要 override 的是 `getTree`（把内核的分叉结构读成 `LineageTree`）**。文档说 15 条、代码 14 条，差的那条恰好是"分支"这条最语义核心的意图——它被静默改成了中立层操作，文档没跟上。
- **正确形状**：把"六条核心意图"里的"分支"改成"读分支结构（getTree/getEntries）+ 壳侧 fork（中立层纯操作）"，把 `abstract-backend.ts` 的"15 条"改成"14 条 + fork 已上提中立层"。

裁定：**不合理（文档债），需补（零成本，改注释）。** 它不影响运行时，但影响下一个内核接入者对这个契约的准确理解——接入者最怕的就是"注释说有、代码没有"。

---

## 4 逐条裁定总表

把上面所有论断压成一张可对照执行的表。每条给「抽象 → 裁定 → 一句话改进」。

| 抽象 / 接缝 | 裁定 | 改进建议（一句话） |
|---|---|---|
| `KernelId` + `KERNEL_IDS`（`kernel.ts`） | 合理 | 保留字面量联合，不要降级成 `string` |
| `BaseBackend` 意图集合 | 合理（最成熟） | 维持 14 条 abstract + 缺面默认，不增不减 |
| `AbstractBackend` 骨架 | 合理 | 把注释"15 条"改回"14 条"，标注 fork 已上提中立层 |
| `SessionCatalog` 中性面 | 面合理、形有债 | `copy`/`bookmark`/`deleteBookmark`/`contextProbeTokens` 异步化；`newSessionId` 的 `string|null` 换成显式身份形态 |
| `KernelModelSource` + `ModelCatalog` | 合理（最干净） | 零改动，维持现状 |
| `KernelSpec`/`KernelManager`/`KernelRuntime`/`KernelReconcile` | 合理 | 维持；`KernelRuntime.installNpm` 命名可泛化为 `installPackage` |
| `BackendFactory` + 工厂注入 | 合理 | 维持；工厂入参已 extends，圆心契约该瘦身 |
| `capabilities: { pi?, dsh? }` | **不合理** | 改通用 capability 字典，`DshCapabilities` 下放 dsh 目录 |
| `BackendCreateOptions` 半中性字段（`maxTokens`/`systemPrompt*`/`provider`/`model`） | **不合理** | 下放到各内核工厂入参，契约只留真中性字段 |
| `isKernelId` / `resolveSessionKernel` 的字面量第二、三份 | **不合理** | 全部收口到 `KERNEL_IDS.includes` 派生的单一 `isKernelId` |
| `asPi`/`piSend`/`KERNEL_IDS[0]`/`newPiSessionPath`/`spawnSession("pi")` | **不合理** | `asPi` 泛化为按 capability key 探测；`KERNEL_IDS[0]` 删或显式化 |
| `manifest.piExtension`/`dshExtension` + `SessionCapabilities.piExtension/dshExtension` | **不合理** | 改成 `extensions: Record<KernelId, path>` + `extensions: Record<KernelId, boolean>` |
| `switchKernel` gate=false + seed 时序二分 | 门关着（产品）+ 抽象缺陷 | seed 时序声明化（`seedKind`），`switchKernel` 与 `materializeActiveLineage` 收敛 |
| `assemble.ts` 的 `if (kernel !== "dsh")` / `if (kernel === "pi")` | **不合理** | 改查注册表（`Record<KernelId, createFn>`），删掉"默认 pi" |
| `controllers/kernel.ts` 的 dsh-优先-pi-兜底 | **不合理** | 默认模型改为"各内核注册自己的 default 优先级"，不写死 pi/dsh 顺序 |

---

## 5 QA

**Q1：加 kimi 到底要改几个文件？能给个精确数吗？**

必改 6 个：`kernel.ts`（字面量 + KERNEL_IDS）、`kernel-factories.ts`、`kernel-managers.ts`、`kernel-logos.ts`、`assemble.ts`（3 个映射 + 2 个工厂 + 1 个 entries + installDir）、`controllers/kernel.ts`（getFallbackModel）。新建 1 个目录 `src/server/kernel/kimi/`（约 8-10 个文件：backend/catalog/protocol/manager/model/extension/logo）。若走 §4 的补丁（capabilities 泛化、manifest extensions 泛化），再追加 `backend.ts`、`contributions.ts`、`sessions.ts`、`kernel-event.ts`、`lifecycle/index.ts`、`session-store.ts` 共 6 个文件的结构性改动。**结论：MVP 接入 12-16 个文件，若要抽象健康则 22 个文件左右。**

**Q2："加第三个内核一行不改"到底哪句是真的、哪句是假的？**

真：`ModelCatalog`（一行不改）、`AbstractBackend`（不 import 新内核）、`KernelManager`/`KernelRuntime`/`KernelReconcile`（不 import 新内核）、`BaseBackend` 接口（若不修 capabilities）。假：`assemble.ts`（必须补工厂分叉和映射）、`controllers/kernel.ts`（默认模型策略）、`session-store.ts`（若 kimi 是文件型，`capabilities.pi` 判定会错）、圆心契约（若修 capabilities/manifest）。

**Q3：kimi 如果是"文件型"内核（像 pi），能直接复用 pi 的 SessionCatalog 吗？**

不能，也不该。`PiSessionCatalog` 读的是 pi 的 JSONL + parentId 树（`pi-catalog.ts` 的 `piReadSessionTree` 直接解析 pi 头行 `type:"session"`/`parentId`），这是 pi 的存储格式，不是通用文件格式。kimi 文件型要写自己的 `KimiSessionCatalog`，实现同一个 `SessionCatalog` 接口——这正是"存储退进内核"（§7.5 不变量 #1）的正确落点。但注意：§4.6 的 `boundSessionPath = capabilities.pi ? ...` 这行会让文件型 kimi 出错，所以"文件型"这个语义不能靠 `capabilities.pi` 判定，要先修这个缺陷。

**Q4：`capabilities` 泛化成字典后，`asPi` 怎么改才不破坏现有 20 多个 `piSend` 调用点？**

分两步，非破坏：第一步，`asPi(proc)` 内部实现从 `proc.backend.capabilities.pi` 改成 `asCapability(proc, "pi")`，签名和调用点不变——只是把"pi 槽"从硬编码字段名改成字典 key，零调用点改动；第二步，把 `piSend` 泛化成 `sendViaExtensions(proc, key, fn)`，让新内核的专属能力走同一条通道。第一步先做、立竿见影，第二步等真有第二个内核需要专属扩展面时再做，不预支（§9.4 纪律二）。

**Q5：`SessionCatalog.copy` 异步化会不会破坏 pi 的 fork 竞态护栏？**

不会，前提是异步化只改接口签名、不改 pi 的同步语义。pi 内部 `copy` 仍是 `copyFileSync`（`pi-catalog.ts:612-614`），只是外面包一层 `async`（`async copy(...) { copyFileWithDir(...) }`），返回的 Promise 立刻 resolve——对"copy 在 setContext 之前的同步段"这个护栏（`forkFromSession`）而言，`await catalog.copy(...)` 依旧在同一微任务前完成，竞态语义不变。真正要小心的是"异步化后有人开始 `copyFile` 异步写"，那才是破坏护栏——所以异步化要连带注释写死"pi 的 copy 仍须同步完成"。

**Q6：默认模型现在 dsh 优先、pi 兜底，加 kimi 后默认模型到底该是谁的？**

这个问题本身暴露了"默认模型"策略被内核顺序污染了。正确语义应该是：**默认模型是"用户显式配置的默认"，不是"哪个内核排在前面"**。dsh 的 `agent-default-model` 是显式默认（用户配了就优先），pi 的 `models.json` default 也是显式默认——两者的优先级应该是"用户最后一次显式设置的默认"或"当前激活内核的默认"，而不是写死的 dsh > pi。加 kimi 后，建议把"默认模型"改成读当前激活内核的默认 + 回退全内核扫描，删掉 `getFallbackModel` 里的内核顺序假设。

**Q7：kimi 的"内核插件补面"（四件套的 kimi-extension）怎么走？现在 manifest 只有 piExtension/dshExtension 两个字段。**

这正是 §4.5 的缺陷的直接后果：现在要给 kimi 补能力，没有 manifest 字段可用。短期 hack 是复用 `dshExtension`（把 kimi 的补面插件塞进 cordis-like 机制），但这是把 kimi 装成 dsh，违反"消费而非翻译"（§3.1）。正确路径是先做 §4.5 的 `extensions: Record<KernelId, path>` 泛化，再给 kimi 写它自己的补面通道。**顺序上，manifest extensions 泛化应该排在"接 kimi"之前，而不是之后**——否则 kimi 只能"有内核、无补面"，能力拉不平。

**Q8：这些缺陷里，哪一条是"今天必须修"、哪一条是"接 kimi 时再修"？**

必须今天修（不修会继续腐烂）：`isKernelId` 字面量收敛（§4.3）、`capabilities` 的 `DshCapabilities` 下放（§4.1）、注释"15→14"（§4.8）——这三条都是纯收尾，零行为风险。接 kimi 时再修（跟着 kimi 一起动）：`BackendCreateOptions` 瘦身（§4.2）、manifest extensions 泛化（§4.5）、`SessionCatalog` 异步化 + 身份形态（§4.6）、`asPi` 泛化（§4.4）、seed 时序声明化（§4.7）——这些动了接口签名或编排，应该借"接 kimi"这个真实需求驱动，而不是空转重构。**总原则：骨架不动，接缝跟着下一个真实内核一起收。**
