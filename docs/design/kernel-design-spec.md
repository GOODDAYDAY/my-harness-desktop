# 内核层设计规范：PI 与 DSH 的洋葱分层

> 本文是内核层的**单一真相源**：一份自包含的、照着就能实现的设计规范。它整合并深化了五篇分册——`multi-kernel-shell.md`（为什么）、`base-interface-lineage.md`（怎么做）、`kernel-layer.md`（摆对层）、`kernel-alignment.md`（能力拉平 + 基类继承）、`kernel-gap-audit.md`（缺口审计）——把方案落到了「每个接口的精确语义、每个适配器的实现要点、每个缺口的去向、每步迁移的验收」的粒度。分册讲思路，本文讲契约；分册讲为什么，本文讲照着写什么。

## 目录

- **第一编 · 总纲**（§1–§4）：问题、目标、四个抽象、术语表
- **第二编 · 洋葱分层**（§5–§7）：分层总览、物理分区、协议分层（抽象在 core）、内核层定位
- **第三编 · 圆心契约**（§8–§13）：KernelId、BaseBackend 逐方法、BackendFactory、KernelModelSource、中性类型体系（含 SessionEvent 清单 / 会话标识中性化 / 内核管理对称）
- **第四编 · 适配器层**（§14–§16）：pi 适配器、dsh 适配器、事件翻译
- **第五编 · 能力拉平**（§17–§20）：拉平三层次、能力差异矩阵、缺口去向、内核插件策略
- **第六编 · 类层次**（§21）：AbstractBackend 基类与继承
- **第七编 · 迁移路径**（§22–§26）：迁移总览、阶段 A–D 的完整步骤
- **第七编补 · 测试与运行**（§26A–§26C）：测试策略、安全与凭证、性能与事件驱动
- **第八编 · 边界与反模式**（§27–§28）：边界情况、反模式
- **第九编 · QA**（20 条问答）
- **第十编 · 附录**（§29–§33）：设计决策记录、分册关系、端到端故事、接第三个内核清单、与项目纪律对照

---

# 第一编 · 总纲

## §1 问题：底座抽象只有一个实例

my-harness-desktop 有一条设计宣言：**底座不是插件，是被管理资源，和 git、文件系统同一层抽象**。这句话如果成立，换底座就该像换 git 实现一样，壳一行不改。但到今天为止，这条宣言只被一个实例——pi——验证过，而且是「恰好」验证过：pi 的协议、会话文件、事件形状从一开始就是壳的圆心契约参照系，从来不需要换，也就从没暴露过这句话哪一部分是假的。

拿 dsh（DeepSeek Harness）当第二个实例，是因为它是「和 pi 几乎处处相反」的内核，是最锋利的探针：

| 维度 | pi | dsh |
|---|---|---|
| 会话模型 | 磁盘 JSONL 文件 + `parentId` 树 | append-only `SessionEvent` 日志 |
| fork | 文件内开分支（不拷贝，跟随原文件） | `ctx.sessions.fork` 新建自洽子会话（前缀拷贝） |
| 事件 | `message_start/update/end` 三态 | `turn/start`、`assistant/chunk` token 增量 |
| 扩展 | 装进 pi 进程的 TS 扩展 | Cordis 插件树（连 agent-loop 都是插件） |
| 能力 | 31 个 JSONL RPC 命令 | capability seam（定义 / 提供 / 消费三角色） |

如果壳能吞下这个处处相反的实例而不改一行，宣言就成立；吞不下，泄漏点会在第一次接入时当场现形。

**壳「长成了 pi 的壳」的三处泄漏**（这是本文要根治的病灶）：

1. **会话标识是文件路径**。`SessionsApi.list/openSession/forkFromSession` 全吃 `~/.pi/agent/sessions/` 下的 JSONL 文件路径，连 bookmarks 都在项目目录下管一份副本。dsh 的会话是 append-only 日志，没有文件可指。
2. **事件形状是从 pi 翻来的**。中性 `SessionEvent`（`messageStart/messageUpdate/messageEnd`、`toolCallStart/End`）是从 pi 的三态翻译来的。dsh 的粒度不同，翻译不是一一对应。
3. **fork 语义是文件内分叉**。pi 的 fork 在文件内挂 `parentId`，dsh 的 fork 出子会话，同名不同义。

如果现在直接让 dsh 当底座：壳去 `~/.pi/agent/sessions/` 找 dsh 的会话文件，找不到；壳等 pi 的 `message_end` 闭合消息，dsh 推 `assistant/chunk`，时间线永不闭合；壳调 `fork(entryId, "at")`，dsh 的 fork 没有 entryId 也没有 position，直接报错。三处泄漏，一处崩一个功能。

## §2 目标：内核无关的壳

目标不是「把 pi 换成 dsh」，是「让壳同时托管任意个同级内核」。pi 和 dsh 谁也不比谁更内建，都是注册进壳的内核；**换内核 = 换适配器，壳和壳插件不动**。

> **核心原则一（抽象在 core，全文档贯彻）**：所有**抽象**——接口、契约、类型、协议枚举——统一收敛在 `core/`；`client/` 只有**实现**（spawn、传输、进程、适配器）。抽象稳定留在内层，会变的实现推外层。这是「依赖只向内」和「依赖倒置」在物理位置上的直接表达：`core/domain` 放中立契约（`BaseBackend`/`KernelId`/中性类型），`core/protocol` 放各内核协议契约（命令枚举/方法枚举），`client/{kernel}` 只放传输实现和适配器。**这条原则在本文 §6.5（协议分层）、§9（圆心契约）、§30（ADR D3）反复出现，不是分散写，是同一个原则在不同层的投影——记住这一句，就记住了整套分层的根。**

这个目标下，「内核」这个词从「pi」变成「一类东西」：

- **内核**（kernel）：一个自洽的 agent 运行时，自带插件树、会话模型、能力集。pi 和 dsh 各是一个。
- **壳**（shell）：my-harness-desktop 的薄壳，拥有槽位、渲染、布局、事件总线等机制。
- **中立契约**（contract）：壳需要内核提供的「最小意图」集合。
- **适配器**（adapter）：内核专属形状与中立契约之间的翻译层，每个内核一个。

三条看着更省力的路都不对：

1. **继续 pi-only**：把 dsh 的 DeepSeek 适配器搬进 pi，壳一行不改——那是拆了内核的插件树、只搬一个 adapter，dsh 的价值（Cordis 插件树、能力缝）没进来。
2. **给 dsh fork 一份壳**：复制一份改 client 层——长期两份壳各自维护，槽位/渲染/布局全要双份。
3. **翻译层让 dsh 装 pi**：写适配器让 dsh 学说 pi 的 31 命令——dsh 要重新实现 pi 的会话文件、parentId 树、fork 语义，等于「让 dsh 假装自己是 pi」，真长处全被埋掉。

三条路的共同病根：都把「内核」当成「pi 的形状」，而不是「一个抽象」。

## §3 四个抽象的边界

### 3.1 内核

内核是一个自洽的 agent 运行时，判据三条：它有一棵自己的插件树（扩展机制）、它有一个自己的会话模型（怎么存、分叉、回放）、它有一个自己的能力集（工具/模型/子代理）。三条齐了，它就是一个能被壳托管的内核。

内核的价值在于它的插件树。把 dsh 接进壳，价值不是「多一个能发消息的进程」，是它的整个插件树跟着一起进来。pi 同理：价值是它的扩展（会话总线、工具门控、子代理）加技能生态。

三个「不是」：

- 内核不是壳插件。壳插件挂槽位、出 UI；内核出能力、不出 UI。
- 内核不是适配器。适配器在内核之外，内核不知道、也不需要知道自己正被托管。
- 内核不是「底座」。「底座」既暗示「被管理资源」、又暗示「pi 那一套」，两个意思混在一个词里，才让「把 dsh 也接进来」显得别扭。

内核对壳只有一项义务：兑现中立契约。它内部怎么存会话、怎么分叉、怎么跑插件，是它自己的事。

### 3.2 中立契约

中立契约是壳需要内核提供的「最小意图」，一共六条。多了是把某个内核的专属概念塞进契约，少了是壳缺一项能力。判据一句话：**壳是不是必须向每一个内核索要它？** 如果 dsh 没有、且壳不非得要，它就不进契约。

六条意图：

1. **消息** `sendMessage(text, images?)`：发一条用户消息。不含 `steer`/`followUp`（pi 的多路并发叫法）。
2. **中断** `abort()`：取消当前回合。不含 `abort_bash`（pi 内部编排）。
3. **分支** `fork(parent, boundary?)`：从某条 lineage 的某点切出新 lineage。不含 `position`（pi 的 before/at）。
4. **会话标识** `sessionId`：不透明字符串。不含文件路径。
5. **流式事件**：中性事件流（消息开始/增量/结束、工具调用开始/结束）。不含内核自己的事件形状。
6. **模型** `setModel(provider, model)`：切 provider/model。不含 `thinkingLevel`（pi 的档位，dsh 是 `reasoningEffort`）。

六条意图落到接口层不是六个方法：「会话标识」一条对应 `getTree`/`getEntries`/`bookmark`/`resume` **四个操作**（`deleteBookmark` 是书签清理的补面能力、`seed` 是跨内核切换的扩展操作，都不属六条意图之一，见 §9.7）。所以接口面 = 六条意图对应的 `sendMessage`/`abort`/`setModel`/`fork` + 会话标识四操作 + `onEvent` 流式订阅，外加生命周期 `start`/`stop`、内核身份 `kernel`、缺面能力 `deleteBookmark`/`seed`——共 15 个成员（11 方法 + 2 属性 `kernel`/`alive` + 2 缺面默认方法）。

### 3.3 适配器

适配器是内核专属形状与中立契约之间的翻译，每个内核一个。它做的事分三种：

- **直接映射**：语义完全一样，只把参数按线格式摆好（如 pi 的 `prompt` ↔ dsh 的 `session/prompt`）。
- **需翻译**：语义一样但形状变了（pi 三态 ↔ dsh 增量；文件路径 ↔ 不透明 id）。
- **缺面**：内核没有这个能力。机器语义是**抛缺面异常**（如 `` `${kernel} 后端 X 未接线` ``），壳捕获后**显式降级**（隐藏/置灰入口）；或给缺能力的内核**补面**（内核插件，见 §17）。缺面绝不静默吞掉、也绝不伪造成功。

适配器写对的标准：同一个壳插件在它上面跑，和在另一个适配器上跑，行为一致。可检验三条——意图覆盖（六条每条有实现或显式「不支持」）、事件等价（同一条内核事件投成的中性事件一致）、错误诚实（内核崩/超时/缺面，壳收到的错误一致）。

### 3.4 壳

壳拥有机制：槽位/贡献、会话意图、渲染、布局、事件总线。壳不拥有任何内核的存储格式、事件形状、插件树、fork 语义。

壳的三条不变量（「内核无关」的可检验标准）：

1. **壳不读任何内核的存储**（pi 的文件、dsh 的日志，壳都不碰，只认不透明 id）。
2. **壳只认中性事件**（内核事件由适配器投喂）。
3. **壳的渲染是纯函数**（给定同一条中性事件流，timeline 怎么画，与内核无关）。

违反任何一条，壳就偷偷依赖了某个内核。判断壳有没有漏内核身份，就看会话意图链路上有没有出现 `if (kernel === "pi")` 这种分支——出现一处，就是一处泄漏。

## §4 术语表（全文档统一）

| 术语 | 定义 |
|---|---|
| 内核（kernel） | 自洽的 agent 运行时，自带插件树 + 会话模型 + 能力集。pi / dsh 各是一个 |
| 壳（shell） | my-harness-desktop 薄壳：槽位 / 渲染 / 布局 / 事件总线 |
| 中立契约（contract） | 壳需要内核提供的六条最小意图，落成 `BaseBackend` 接口 |
| 适配器（adapter） | 内核专属形状 ↔ 中立契约的翻译层，每内核一个（`PiBackend` / `DshBackend`）。注意：传输层 `RpcAdapter`/`JsonRpcTransport` 不是「适配器」，是传输 |
| 壳插件 | 挂壳槽位的 UI 插件，只 import `@my-harness-desktop/contract` |
| 内核插件 | 内核自己的插件：pi 侧 TS 扩展、dsh 侧 Cordis 插件。**≠ 内置壳插件**（`plugins/` 里随壳分发的壳插件） |
| 圆心 | 壳最里的一层 `core/domain/`，只有类型定义和纯函数，零依赖 |
| 中性类型 / 中性事件 / 中性域 | 不依赖任何框架、库、运行时、内核。中性类型是纯 TS 类型，中性事件是去内核细节的结构化数据，中性域是它们的集合（`core/domain/events`） |
| lineage | 会话里的一条线性历史；根 lineage 最早，fork 出的分支各是一条 |
| 分叉点（boundary） | lineage 从父 lineage 切出去的位置，不透明引用（`BoundaryRef = string`） |
| anchor | 书签的可重启锚点（`{lineageId, boundary, opaque}`），`opaque` 是后端自留 token |
| session forest | dsh 的会话树：父会话 + 若干 fork 出的子会话（subagent 也是子会话） |
| 条目树 | pi 的会话树：条目靠 `parentId` 连成树，节点是「条目」（比 lineage 树的「分叉点」更细） |
| JSONL | JSON Lines，每行一个完整 JSON 对象。传输细节，不是语义契约 |
| resync | 并发拉 state+entries+tree+commands 的基线同步原语（`core/application/orchestrations/resync.ts`），接受 `ResyncTransport` 接口 |
| cwdToBucketName | 项目根 cwd → pi 会话桶名的纯函数（会话路径生成用） |
| 缺面 | 内核没有某个能力，找不到可翻译的对应物 |
| 补面 | 给缺能力的内核补一个实现（内核插件，非适配器翻译） |
| 降级 | 壳捕获缺面异常后，隐藏/禁用该能力入口，不静默不伪造 |
| capability seam | dsh 的能力组织：定义 / 提供 / 消费三角色，provider 可换 |
| Cordis 插件树 | dsh 的扩展机制：一切（工具、模型、agent-loop）都是插件 |

---

# 第二编 · 洋葱分层

## §5 分层总览

内核层是洋葱架构里的一层。洋葱不是具体技术，是「依赖方向」的几何纪律：想象同心圆，最里是稳定的业务本质（圆心），向外逐层是会变的细节，依赖箭头永远指向圆心——外层可依赖内层，内层绝不依赖外层。

内核层在洋葱里的位置：

```
┌────────────────────────────────────────────────────────────┐
│ bootstrap/  (组装根 · 最外)                                  │
│   kernel/      内核注册表：把接口和实现绑起来                    │
├────────────────────────────────────────────────────────────┤
│ client/  (流出适配器 · 内核层 = PI + DSH)                     │
│   pi/          PiBackend + rpc-adapter + subprocess + 扩展安装器 │
│   dsh/         DshBackend + json-rpc + dsh-config-source       │
├────────────────────────────────────────────────────────────┤
│ core/application/  (用例编排 · 中层)                          │
│   sessions/session-store.ts   只依赖 BaseBackend + BackendFactory│
│   models/model-catalog.ts     只依赖 KernelModelSource         │
├────────────────────────────────────────────────────────────┤
│ core/protocol/  (各内核协议契约 · 抽象：命令枚举/方法枚举，纯)   │
│   commands.ts / event-translator.ts / context-binding.ts      │
├────────────────────────────────────────────────────────────┤
│ core/domain/  (圆心 · 零依赖)                                 │
│   kernel.ts    KernelId / KERNEL_IDS                          │
│   backend.ts   BaseBackend / BackendFactory / KernelModelSource│
│   events/      ModelInfo / SessionEvent / NeutralMessage       │
└────────────────────────────────────────────────────────────┘
```

依赖方向只向内：`bootstrap → client → core/application → core/domain`。跨层协作靠依赖倒置——`core/domain` 拥有接口，`client` 实现它们，`bootstrap` 组装绑定。内层永远不 import 外层。

「内核层」是「机制与内容分离」在底座这一层的延伸：壳只放「所有内核共用的机制」（槽位/渲染/意图/事件总线），内核只放「它自己的内容」（会话模型/插件树/能力集）。同一句铁律，UI 层叫「壳 vs 壳插件」，底座层叫「壳 vs 内核」。

## §6 物理分区与依赖方向检验

物理分区就是第一道防线——目录结构本身挡住违规 import。当前落点：

| 目录 | 装什么 | 不装什么 |
|---|---|---|
| `core/domain/` | 接口 + 中性类型 + 纯函数，零依赖 | 任何 import、IO、环境、框架 |
| `core/application/` | 用例编排（SessionStore / ModelCatalog / kernel-manager） | UI、进程管理、框架 API |
| `core/protocol/` | 各内核协议契约（抽象）：pi 31 命令枚举 + dsh `session/*` 方法枚举 + 事件类型（纯类型/纯函数，不 spawn） | 传输实现（在 `client/{kernel}`） |
| `client/pi/` `client/dsh/` | 内核层：适配器 + 传输 + 进程 + 扩展安装器（内核协议应在此） | 壳插件、业务编排 |
| `bootstrap/` | 组装根：内核注册表、MainContext 注入 | IPC handler 实现、业务规则 |

依赖方向检验（CI 可 grep 自动化）：

- `core/domain/` 出现任何外部包 import → 违规。
- `core/` 出现 `import 'electron'` / `import 'react'` / 对 `client/` 的**非 type-only** import → 违规。
- `client/` 出现 `import 'react'` / `import '../api/...'` / `import '../bootstrap/...'` → 违规。
- `plugins/` 出现 `import '@/core/...'` / `'@/client/...'` / `'@/api/...'` → 违规（插件只从 `@my-harness-desktop/contract` 和 `@my-harness-desktop/react` 引用）。

当前验收态（已达成，见 `kernel-layer.md` §6）：core 生产代码值 import client 归零；`core/domain` 零外部包；`"pi" | "dsh"` 字面量只剩 `core/domain/kernel.ts` 一处。

## §6.5 协议分层：抽象在 core，实现在 client

内核层洋葱不止「代码分层」，还有一层更根本的「**协议分层**」。它落在一句全文档反复强调的核心原则上：

> **核心原则（抽象在 core）**：所有**抽象**——接口、契约、类型、协议枚举——统一收敛在 `core/`；`client/` 只有**实现**（spawn、传输、进程、适配器）。抽象稳定留在内层，会变的实现推外层。这条原则在本规范里不止出现一次：§3 原理、§6.5 本层、§9 圆心契约、§30 ADR 都指向它——不是「这里写一块那里写一块」，是同一个原则在不同层的投影。

### 6.5.1 三层结构

| 层 | 是什么 | 放哪 | 性质 |
|---|---|---|---|
| **壳协议**（中立契约） | `BaseBackend` 六意图 + 中性事件 `SessionEvent` + 中性类型 `LineageTree`/`Anchor`/`ModelInfo` | `core/domain` | 抽象（圆心） |
| **内核协议契约** | pi 31 命令枚举 + dsh `session/*` 方法枚举 + 事件类型 | `core/protocol` | 抽象（纯类型 + 纯函数，不 spawn 不读写） |
| **内核协议传输** | spawn、stdin/stdout、JSONL 读写、JSON-RPC 行传输 | `client/{kernel}` | 实现 |
| **适配器** | 内核协议 ↔ 壳协议的翻译 | `client/{kernel}` | 实现 |

关键区分（「构造与执行分开」在协议层的落地）：**命令枚举/方法枚举是「契约」（抽象，放 `core/protocol`），spawn/读写行是「传输」（实现，放 `client/{kernel}`）**。协议契约（构造命令对象）在内层，协议传输（把命令发出去）在外层。壳从头到尾只读 `core/domain` 的壳协议，内核协议契约与传输都是适配器的私有物。

### 6.5.2 当前不对称（dsh 的抽象泄漏进了实现层）

- `core/protocol/`（`commands.ts` 的 `build*Command`、`rpc-types.ts`、`event-translator.ts`、`context-binding.ts`）是 pi 的协议契约——**这是对的**：抽象在 core，纯类型/纯函数，不 spawn。
- dsh 的协议契约（`"session/prompt"`、`"session/fork"`…方法名）散在 `client/dsh/json-rpc.ts` 的**字符串里**——**dsh 的抽象泄漏进了实现层**，且无类型枚举。
- 结果：pi 的协议契约在 core（对），dsh 的协议契约在 client（错），不对称；dsh 的方法名是魔法字符串。

### 6.5.3 终态（美的结构）

```
core/domain/         壳协议（中立契约：BaseBackend / 中性事件 / 中性类型）
core/protocol/       各内核协议契约（抽象）：pi 31 命令枚举 + dsh session/* 方法枚举
client/pi/           pi 传输实现（spawn / JSONL 读写）+ PiBackend 适配器
client/dsh/          dsh 传输实现（spawn / JSON-RPC 行）+ DshBackend 适配器
```

**所有抽象上提 core，所有实现下沉 client**。pi/dsh 的协议契约对称地躺在 `core/protocol`，各自的传输实现对称地躺在 `client/{kernel}`。壳读 `core/domain`，适配器读 `core/protocol` + 各自传输，依赖只向内。

### 6.5.4 迁移方案

**目标**：dsh 的协议契约（方法枚举）上提 `core/protocol`；pi 的 `core/protocol` 保持（它已是抽象）。

**步骤**：
1. **dsh 方法枚举上提**：`client/dsh/json-rpc.ts` 里散装的 `"session/prompt"` 等字符串收成 `core/protocol/dsh-methods.ts`（纯类型 + `as const` 常量枚举），杜绝魔法字符串。
2. **`json-rpc.ts` 瘦身**：`client/dsh/json-rpc.ts` 只留 JSON-RPC 行传输（实现），方法名从 `core/protocol/dsh-methods.ts` 取。
3. **依赖方向复核**：`core/protocol` 只 import `core/domain`（中性类型）；`client/{kernel}` import `core/protocol`（协议契约）+ `core/domain`，方向正确。

**验收**：grep `"session/prompt"` 等魔法字符串归零（全收进 dsh 方法枚举）；`core/protocol` 同时承载 pi/dsh 两套协议契约（抽象），pi/dsh 对称；`core` 对 `client` 的 import 仍归零。

**回滚**：字符串枚举化 + 瘦身，逐 commit 回退，无行为变化。

**状态**：「抽象在 core」这条**已达成**——`core/domain`（中立契约）+ `core/protocol`（pi 协议契约）都在 core。**未达成的只有 dsh 方法枚举上提**（当前散在 `client/dsh/json-rpc.ts` 字符串里）——属 §QA 已标注的已知不对称，落地时按本方案执行。

## §7 内核层的定位：同级的代价与收益

「同级」不是免费的，它付出三个代价：

1. **pi 失去默认特权**——今天 pi 是唯一底座，很多东西「默认就是 pi」；同级之后，默认也要显式化（「默认 pi」是配置，不是「pi 内建」）。
2. **迁移有成本**——三处泄漏要中性化，这是真工作量。
3. **测试翻倍**——壳的集成测试要跑 pi 和 dsh 两遍，任一内核的行为差异都要解释。

代价换回来的是「换内核不用改壳」这个能力。值不值，取决于预期未来有几个内核。

一个内核要「接入」壳，交三样东西：

1. **spawn 命令**（怎么起这个内核进程、起几个、怎么杀）；
2. **适配器**（把专属形状投成中立契约）；
3. **会话模型映射**（把会话落到 lineage 坐标系——`fork` 的 parent/boundary 对应它内部什么）。

三样齐了，它是「可托管内核」；缺任何一样，它只是「一个能跑的程序」。

**验收**（一个内核「可托管」的标准）：六条意图每条都能兑现或显式「不支持」，生命周期跑通。只验三件事——起得来、六条意图逐条有响应、崩了壳能收尾。

---

# 第三编 · 圆心契约

本编定义内核层的全部圆心契约。圆心契约是「壳与内核之间唯一的地基」：`core/domain/` 里的接口 + 中性类型 + 纯函数，零依赖。每个接口本节给出签名、语义、幂等性、失败语义、边界情况、以及 pi/dsh 各自怎么兑现。这是全文最该照着写的一编。

## §8 KernelId：内核身份单源

### 8.1 定义

```ts
// core/domain/kernel.ts
export type KernelId = "pi" | "dsh";
export const KERNEL_IDS = ["pi", "dsh"] as const;
```

### 8.2 语义

- `KernelId` 是内核身份的字面量联合。全仓只有这一处出现 `"pi" | "dsh"` 字面量（契约单源纪律）。
- 加第三个内核 = 联合加一个字面量 + `KERNEL_IDS` 加一项，编译器逼补全所有 `switch (kernel)` 分支——这是字面量联合而非 `string` 的直接红利。

### 8.3 归属

- `BaseBackend.kernel`（身份跟着实现走）、`BackendCreateOptions.kernel`（工厂路由依据）、`ModelInfo.kernel`（模型来源投影）、`switchKernel(target)`（跨内核切换目标）都引用 `KernelId`。
- 内核身份「不进配置文件」——它是来源的投影，不是 config 输入。`ModelInfo.kernel` 由扫描器按「从哪个内核的配置扫出来」赋值，不由 provider 名反推（反例：`if (provider.includes("deepseek")) kernel = "dsh"` 是错的，见 §28 反模式）。

## §9 BaseBackend：后端契约逐方法

```ts
// core/domain/backend.ts
export interface BaseBackend {
  readonly kernel: KernelId;
  readonly alive: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  onEvent(cb: (event: SessionEvent) => void): () => void;
  fork(parentLineageId: string, boundary?: BoundaryRef): Promise<string>;
  getTree(sessionId: string): Promise<LineageTree>;
  getEntries(lineageId: string): Promise<NeutralMessage[]>;
  bookmark(lineageId: string, boundary: BoundaryRef): Promise<Anchor>;
  resume(anchor: Anchor): Promise<string>;
  deleteBookmark(anchor: Anchor): Promise<void>;
  sendMessage(text: string, images?: ImageInput[]): Promise<void>;
  abort(): Promise<void>;
  setModel(provider: string, modelId: string): Promise<void>;
  seed(history: NeutralMessage[]): Promise<string>;
}
```

`BaseBackend` 是「一个可整体替换的底座实现」的抽象。实现方义务三条：① `fork` 不改动原 lineage，新 lineage 带共享前缀独立前行；② `boundary` 必须落在父 lineage 的一个完整回合之后，违反即拒绝；③ `anchor` 天然按后端划界——本后端建的锚点只能本后端 `resume`，收到别家锚点报错。

### 9.1 生命周期：`kernel` / `alive` / `start` / `stop`

**`kernel: KernelId`（只读）**
- 语义：内核身份，跟着实现走，不散在 `SessionProc`。pi 后端固定 `"pi"`，dsh 后端固定 `"dsh"`。
- 用途：`session-store` 经 `backend.kernel === "pi"` 做能力分发（取代 `instanceof` 具体类）；`bootstrap` 工厂经 `opts.kernel` 路由。

**`alive: boolean`（只读）**
- 语义：子进程是否存活。
- 实现要点：pi 委托 `RpcAdapter.alive`，dsh 委托 `JsonRpcTransport.alive`。
- 边界：`start()` 前为 false，`stop()` 后为 false，进程崩溃后为 false。壳在发送路径上每次现读，不缓存。

**`start(): Promise<void>`**
- 语义：起内核子进程，按需。resolve 代表「进程起来 + 握手完成」——pi 的 `get_state` 探测通过、dsh 的 `initialize` 握手返回，才 resolve。
- 实现要点：pi = `RpcAdapter.start()`（经 `SubprocessHandle` 委托 `subprocess-lifecycle` 起进程 + 建 JSONL 读写，适配器不直接 spawn）；dsh = `transport.start()` + `initialize` 握手（`cwd/provider/model/maxTokens`）。
- 失败语义：spawn 失败 / 握手超时 / 探测不通 → `reject` + `alive=false`，pending 请求全报错。可重试（重试 = 再调一次 `start`，旧进程已死则重新 spawn）。
- 幂等：已 `alive` 时重复 `start` 是 no-op（不重复 spawn）。
- 就绪探测：壳不在 `start()` 里 sleep 猜就绪，就绪由 `start` 内部实证探测（pi 发 `get_state`，dsh 的 `initialize` 即握手）——探测封装在适配器内部，`get_state` 不是契约面，壳不直接发。

**`stop(): Promise<void>`**
- 语义：停内核子进程。幂等——重复 `stop()` 无害（进程已停则 no-op）。
- 实现要点：pi = `RpcAdapter.stop()`（关 stdin → 等退出 → 超时强杀）；dsh = `transport.stop()` + 清理临时会话目录（ephemeral 时）。
- 失败语义：stop 失败不阻塞壳收尾（`session-store` 里 `await backend.stop().catch(() => {})`）。

### 9.2 事件订阅：`onEvent`

```ts
onEvent(cb: (event: SessionEvent) => void): () => void;
```

- 语义：订阅中性事件流（驱动 timeline）。返回取消函数。
- 实现要点：pi = `adapter.onEvent(e => cb(translateEvent(e)))`；dsh = `transport.onNotification` 里过滤 `session.event`，`translateDshEvent` 翻译后 `cb`。
- 边界：翻译函数返回 `null`（内核有而中性域无的事件，如 dsh 的 `todo/write`、`plan/mode`）时**丢弃**，不投喂。
- 幂等：多订阅者各自独立，取消函数只解绑自己。

### 9.3 消息与中断：`sendMessage` / `abort`

**`sendMessage(text: string, images?: ImageInput[]): Promise<void>`**
- 语义：发一条用户消息。**唯一会起内核进程的意图**。resolve 只代表「内核接受」，输出靠事件流。
- 幂等：不可重入。一条消息发两次是两条消息，「已发去重」由壳上层（发送按钮）保证，契约不承诺去重。
- 失败：内核拒绝（消息格式不对）或超时，壳收到错误、不静默。
- 实现要点：pi = `buildPromptCommand`；dsh = `session/prompt`（`contentBlocks: [{type:"text",text}]`）。
- 边界：`images` 非空而内核不支持图片时，抛「未接线」显式报错（dsh 现状）。

**`abort(): Promise<void>`**
- 语义：取消当前回合。
- 幂等：可重入，重复 `abort` 无害。
- 失败：内核无响应时壳超时放弃、不阻塞。
- 实现要点：pi = `buildAbortCommand`（`ABORT_TIMEOUT_MS = 8000`，工具不响应 agent signal 时强制放弃）；dsh = `session/abort`。
- 边界：不含 `abort_bash`（pi 内部「先中断 bash 再中断 agent」的编排，pi 专属，不进契约）。

### 9.4 模型：`setModel`

```ts
setModel(provider: string, modelId: string): Promise<void>;
```

- 语义：切 provider/model 二元组。
- 幂等：可重入，同值 `setModel` 无副作用。
- 失败：内核无此 provider/model，报错（壳在模型下拉标红，不静默切上一个）。
- 实现要点：pi = `buildSetModelCommand`（同步 RPC）；dsh = `session/setModel`。
- 边界：不含 `thinkingLevel`（pi 的推理强度档位）——dsh 用 `reasoningEffort`，是两个不同概念，各自保留（§17 能力矩阵）。

### 9.5 分支：`fork`

```ts
fork(parentLineageId: string, boundary?: BoundaryRef): Promise<string>;
```

- 语义：从某条 lineage 的某点切出新 lineage；`boundary` 省略 = 从当前末尾切。返回新 lineage id。
- 幂等：不可重入，每次 `fork` 都产生一条新 lineage。
- 失败：边界无效（非连续、或落在回合中间）报错，壳把入口降级成「从末尾分叉」。
- 实现要点：
  - pi = `buildForkCommand(boundary, "at")` + `resync` 拿新会话文件路径作新 lineage id（pi 总 fork 激活会话，`parentLineageId` 对 pi 冗余忽略）。
  - dsh = `session/fork({parentSessionId, boundarySeq})`，子会话 id 即新 lineage id。
- 边界：`boundary` 必须指向「父 lineage 里一个完整回合之后的位置」。pi 的「只接受 user 锚点」和 dsh 的「boundary 不落 open turn」是同一约束的两种表达，归一进契约。
- **⚠ 已知缺口（pi 适配器约束）**：契约签名承诺「从任意 lineage 分叉」，但 pi 的 `fork` 只作用于**当前激活会话**，`parentLineageId` 被忽略，且契约里**没有「激活某条 lineage」的方法**。要 fork 非活跃 lineage 时，pi 侧无补救入口。终态二选一：① 契约明确 fork 只作用于「当前活跃 lineage」并补 `activateLineage(id)`；② pi 的 fork 接受 `parentLineageId` 映射到对应会话文件。落地前，壳只能 fork 活跃会话，其它 lineage 的 fork 走降级。

### 9.6 会话标识四操作：`getTree` / `getEntries` / `bookmark` / `resume`

这四操作是「会话标识」这一条意图的机械展开（都是「壳定位/保存一条 lineage」）。

**`getTree(sessionId: string): Promise<LineageTree>`**
- 语义：拿一个会话的全部 lineage 及父子/分叉点关系。返回 `{ rootId, lineages[] }`，每个 lineage `{ id, fork: {parentLineageId, boundary} | null }`。
- 实现要点：pi = `resync` 拿入口级树 → `projectLineageTree` 投影；dsh = `session/getTree`（session forest 沿 header lineage 字段串父子）。
- 边界：树的节点粒度是「分叉点」不是「条目」（pi 侧一个分支只显示一个节点，比今天的条目树「粗」——这是 lineage 级取舍）。

**`getEntries(lineageId: string): Promise<NeutralMessage[]>`**
- 语义：拿一条 lineage 的线性消息序列（重放历史）。timeline / git-review / token-stats 消费。
- 实现要点：pi = `resync` 的 `snapshot.messages`；dsh = `session/getEntries`（session log 投影成 `NeutralMessage`）。
- 边界：不含「增量拉取」概念（`since`）——增量是传输细节，挤进后端，接口只留语义动作。

**`bookmark(lineageId: string, boundary: BoundaryRef): Promise<Anchor>`**

> **演进标注（已被覆盖）**：本节 `Anchor = { lineageId, boundary, opaque }` 的 `opaque` 是内核私有 token，跨内核失效——已被 `session-neutral-layer.md` §6 的 `NeutralAnchor = { lineageId, entryId }`（去 opaque，中立坐标）**取代**。实现以 session-neutral-layer.md 为准，本节旧定义保留作演进对照。

- 语义：把一个分叉点持久化成可重启锚点。返回 `{ lineageId, boundary, opaque }`。
- 实现要点：pi = 全量 JSONL 拷贝到 `agentDir/bookmarks/`，`opaque` = 拷贝路径；dsh = `session/bookmark` RPC（服务端 fork 出带稳定 childSessionId 的子会话，返回 Anchor，`opaque` = childSessionId）。
- 边界：`opaque` 是后端自留的持久化线索，桌面一律不解析、只当 token 回传给 `resume`——存储格式彻底退进后端。
- 幂等：不可重入，重复 `bookmark` 产生多个锚点副本（每次都是新拷贝/新子会话）。

**`resume(anchor: Anchor): Promise<string>`**
- 语义：从一个锚点重启一条 lineage，返回重启后的 lineage id。
- 实现要点：pi = 把 `anchor.opaque`（JSONL 拷贝）物化成新会话文件返回路径（「在新文件上 fork 到 boundary」由调用方编排）；dsh = 用 childSessionId 找回子会话当活跃会话。
- 失败：锚点失效（拷贝文件被删 / childSessionId 已清理）返回「锚点已失效」，桌面给「删除」或「重建」两选择；锚点不属于本后端报「锚点不属于此后端」，不静默也不误路由。
- **⚠ 已知缺口（boundary 应用悬空）**：pi 的 `bookmark` 是**全量**拷贝（不按 boundary 截断），`resume` 只物化全量文件、不「fork 到 boundary」；「在新文件上 fork 到 boundary」被推给「调用方编排」，但壳不读 pi 文件、也没有 fork-to-boundary 的契约入口——`anchor.boundary` 存了但**没人真正消费**，书签当前从全量末尾恢复而非从分叉点恢复。终态：要么 `bookmark` 拷贝时就截断到 boundary，要么 `resume` 由 pi 后端内部完成「物化 + fork 到 boundary」两步，写成实现步骤而非「调用方编排」。

### 9.7 缺面能力：`deleteBookmark` / `seed`

这两个方法在基类 `AbstractBackend` 里给默认「显式不支持」实现（见 §21），有能力的内核 override。

**`deleteBookmark(anchor: Anchor): Promise<void>`**
- 语义：删除一个书签锚点（回收后端自留的副本）。
- 实现要点：pi = 移除 `anchor.opaque` 指向的 JSONL 文件；dsh = 删除 fork 出的子会话（生命周期暂未接线，继承基类默认抛错）。

**`seed(history: NeutralMessage[]): Promise<string>`**

> **演进标注（已被覆盖）**：本节 `seed(NeutralMessage[])` 是**线性** seed，fork 结构丢失——已被 `session-neutral-layer.md` §13 的 `seed(session: NeutralSession)`（**树**签名，含 lineages + entries，fork 结构保留）**取代**。实现以 session-neutral-layer.md 为准。
- 语义：从一段中性历史起步，返回新会话在内核侧的标识（pi = 文件路径，dsh = 子会话 id）。这是跨内核切换（§25）第 5 步：把旧内核的中性 transcript seed 到新内核。
- 与 `resume` 的区别：`resume(anchor)` 续「内核自己的会话」（锚点是内核自己造的），`seed(history)` 造「一段新历史」再续（历史是壳给的、内核侧没有对应锚点）。跨内核切换需要的是后者。
- 实现要点：pi = 把 `NeutralMessage[]` 物化成新 JSONL 文件（只 seed user/assistant/toolResult，跳过 divider/custom 元数据；工具块当历史写回、不重跑）；dsh = 待 dsh 侧补 `session/seed` 方法，未给之前继承基类默认抛错（跨内核切换 pi→dsh 在 dsh 侧降级）。

## §10 BackendFactory / BackendCreateOptions

```ts
export interface BackendCreateOptions {
  cwd: string;
  agentDir: string;
  kernel: KernelId;
  provider?: string;
  model?: string;
  sessionId?: string;
  systemPromptPaths?: string[];
  systemPromptTexts?: string[];
  ephemeral?: boolean;
  maxTokens?: number;
}

export interface BackendFactory {
  create(opts: BackendCreateOptions): BaseBackend;
}
```

### 10.1 语义

- `BackendFactory` 是中性工厂契约：`application` 只依赖本接口，实现归 `client`（`createPiBackend` / `createDshBackend`），组装归 `bootstrap`（把接口和实现绑起来）。
- `BackendCreateOptions` 是创建内核后端所需的**全部中性入参**。不含任何内核专属 spawn 参数（`args`/`env`/`cliPath`/`cordisConfig`）——那些由各内核工厂实现闭包捕获（bootstrap 组装时绑定）。

### 10.2 每个字段的语义

| 字段 | 语义 | pi 翻译 | dsh 翻译 |
|---|---|---|---|
| `cwd` | 项目根 | spawn 的 cwd | spawn 的 cwd + initialize 的 cwd |
| `agentDir` | 会话根（pi 底座会话目录） | `PiBackendContext.agentDir` | 忽略 |
| `kernel` | 内核身份，工厂路由依据 | — | — |
| `provider` / `model` | 模型偏好（六条意图 setModel 的中性输入） | spawn 后经 `setModel` 命令 | initialize 握手 |
| `sessionId` | 打开/续接的会话标识 | `--session <id>` | initialize 的 sessionId |
| `systemPromptPaths` | 注入的 system prompt 文件路径 | `--append-system-prompt <path>` | 忽略（dsh 经 cordis） |
| `systemPromptTexts` | 内联 system prompt 文本（角色卡） | `--append-system-prompt <text>` | 忽略 |
| `ephemeral` | 临时会话（测试不落盘） | `--no-session`（内存会话） | 临时 `DSH_SESSION_ROOT`（stop 清理） |
| `maxTokens` | 输出 token 上限 | 忽略 | initialize 握手 |

### 10.3 纪律

- `cliPath` / `cordisConfig` / `apiKey` 等内核专属配置**不进契约**，由 `bootstrap` 的 `baseBackendFactory` 闭包捕获（`kernel-layer.md` §4 阶段 4 已落地）。
- `session-store` 不再拼 `--session`/`--append-system-prompt`/`--no-session`，改传中性字段——内核专属 args 的拼装收进 `kernel-factories.ts`。

## §11 KernelModelSource

```ts
export interface KernelModelSource {
  listModels(): ModelInfo[];
}
```

- 语义：一个内核的模型清单（已带 `kernel` 标）。
- 实现：pi = `PiModelSource`（包 `ModelsStore`，读 `models.json` 的 provider 树）；dsh = `DshConfigSource implements KernelModelSource`（读 cordis.yml 的 `llm-deepseek` / `llm-pi-ai`）。
- 消费：`ModelCatalog` 持 `KernelModelSource[]`，`listModels()` = `flatMap` 合流。加第三个内核 = 加一个 source，`ModelCatalog` 一行不改。
- 纪律：同名模型不跨内核去重（各带各的 `kernel` 标）；dsh 未配置是「显式态」不是「空态」（DSH 模型配置 TAB 给「去配 cordis.yml」入口，不静默当 pi 处理）。

## §12 中性类型体系

圆心类型全部零依赖，从 `core/domain` 发出，外层 re-export。核心清单：

| 类型 | 定义处 | 语义 |
|---|---|---|
| `KernelId` | `kernel.ts` | 内核身份字面量联合 |
| `Lineage` | `backend.ts` | 一条有序事件流 + 一个分叉点（`{id, fork}`） |
| `LineageFork` | `backend.ts` | 分叉点（`{parentLineageId, boundary}`） |
| `LineageTree` | `backend.ts` | 会话全部 lineage（`{rootId, lineages[]}`） |
| `BoundaryRef` | `backend.ts` | 分叉点不透明引用（string） |
| `Anchor` | `backend.ts` | 书签锚点（`{lineageId, boundary, opaque}`） |
| `NeutralMessage` | `events/session-state.ts` | 中性消息（role/content/…） |
| `SessionEvent` | `events/session-state.ts` | 中性事件判别联合（messageStart/Update/End、toolCallStart/End、turnStart/End 等） |
| `ModelInfo` | `events/session-state.ts` | 中性模型信息（`kernel` 标 + provider/id/…） |
| `SessionEvent`/`NeutralMessage` 等 | 同上 | 供 adapter 投喂、timeline 消费 |

**LineageTree 的投影纯函数** `projectLineageTree(roots: TreeNode[]): LineageTree`：把 pi 的入口级树投影成 lineage 树——一个 lineage = 沿首子（主干）走到尽头的最大线性链；某节点有 >1 子节点即分叉点，首子延续当前 lineage，其余子各开一条分支 lineage。主干选择（首子）是当前约定；若底座以 `leafId` 定义主干，调用方在投影前先按 leafId 重排 children。

**契约单源**：这些类型只在圆心定义一份。`packages/contract/src/index.ts` 做纯 re-export（`export type { ... } from "domain"`），一行逻辑没有。外层绝不手写「本地版」。

### 12.1 SessionEvent 中性事件完整清单

中性事件是适配器投喂、timeline 消费的判别联合（`events/session-state.ts`）。完整成员与语义：

| 事件 | 语义 | 谁投喂 |
|---|---|---|
| `messageStart` | 一条消息开始（含 message 占位） | pi 的 `message_start`（dsh 的 token 级流式未接，`assistant/chunk` 当前丢弃） |
| `messageUpdate` | 消息增量（流式文本/思考块追加） | pi 的 `message_update`（dsh 同上未接） |
| `messageEnd` | 消息闭合（完整 message 落定） | pi 的 `message_end` / dsh 的 `assistant/message` 完整帧 |
| `toolCallStart` | 工具调用开始（toolCallId/toolName/args） | pi 的 `tool_execution_start` / dsh 的 `tool/call` |
| `toolCallEnd` | 工具调用结束（结果/isError） | pi 的 `tool_execution_end` / dsh 的 `tool/result` |
| `turnStart` / `turnEnd` | 单次模型调用 + 工具执行的起止（≈ pi 的 turn） | pi 的 turn 事件 / dsh 的 `step/start` / `step/end` |
| `agentStart` / `agentEnd` / `agentSettled` | agent 循环起止/收敛（一整轮执行） | pi 的 agent 事件 / dsh 的 `turn/start` / `turn/end` |
| `compactionStart` / `compactionEnd` | 上下文压缩起止（壳只观察，不驱动） | pi 的 compact / dsh 的 compaction 事件 |
| `entryAppended` | 新条目追加（收藏/回退锚点） | pi 底座补丁发射 |

> 注：`divider`（分隔线：模型切换/思考档位切换/压缩标记）**不是** `SessionEvent` 成员，而是 `NeutralMessage` 的 role（`{role:"divider", kind, i18nKey, i18nArgs, ...}`），由会话文件读取路径（`session-scanner`）产出、经 `getEntries` 返回，不走事件流——timeline 在「历史重放」时消费它，在「流式增量」时看不到它。别把它当事件构造。

纪律：中性事件是契约，翻译器是喂线。内核有而中性域没有的事件（dsh 的 `todo/write`、`request/header`、`request/context`、`session/end-seed`）丢弃，想消费先在中性域加类型。事件是精确判别联合（每种事件一个字面量 `type`），外层不手写宽松版（契约单源）。dsh 的事件翻译按**语义对齐**（turn≈agent、step≈turn），不按名字错位映射——见 §16.2。

### 12.2 会话标识中性化的完整方案

> **完整方案见 `session-neutral-layer.md`**：本节只概述「会话标识从文件路径中性化为不透明 id」的方向；中立会话身份 `neutralSessionId` + 持久化映射表（`<kernel, neutralSessionId> → kernelPrivateId`，pi→dsh→pi 回切找回原会话）、中立锚点 `(lineageId, entryId)`、树 seed 的完整契约与投影规则，以 session-neutral-layer.md §5/§6/§13/§14 为准。

> **状态：设计目标 / 未落地**。本节是「会话标识从文件路径中性化为不透明 id」的终态设计；当前代码仍是**路径中心**——pi 后端 `fork`/`seed`/`resume` 返回的是 JSONL 文件路径（§9.5/§9.6/§14.3），dsh 后端 `sessionId` 退化为 cwd 桶名（§15.3）。落地属阶段 D 的会话标识收口，在此之前逐方法处（§9/§14/§15）以「现状」为准，本节以「终态」为准，两者并存且明确标注，不算冲突。

`sessionId` 从「文件路径」中性化为「不透明 id」是 G1 三处泄漏里牵动最广的一处（从圆心契约一路漏到插件取数层）。完整方案：

**目标**：壳不再知道「会话是文件还是日志」，只认不透明 `sessionId`。

**现状问题**：`SessionsApi.list/openSession/forkFromSession` 全吃 `~/.pi/agent/sessions/` 下的 JSONL 文件路径；bookmarks 在项目目录管一份副本；dsh 的会话没有文件可指，`sessionId` 退化为 cwd 桶名。

**方案**：

1. **会话列表 API（`SessionsApi` 层，非 `BaseBackend` 契约）**：`sessionId` 是 `string`（不透明），`list()` 返回的 `SessionInfo` 含 `id`（不透明）+ `kernel`（归属），不含路径。
2. **pi 后端映射**：不透明 id ↔ 文件路径的映射收进 `PiBackend` 内部（或 `session-scanner` 的一层「id 索引」）。pi 的会话文件仍是 JSONL，但壳拿到的 id 是「会话的稳定标识」，不是路径。
3. **dsh 后端映射**：不透明 id ↔ session id（dsh 原生），`sessionId` 直接就是 dsh 的 session id，不再退化 cwd 桶名。
4. **会话头记归属**：每个会话头记 `custom-my-harness-desktop: { kernel }`，`list()` 按头里的归属路由到对应后端打开；归属缺失的旧会话默认 pi（迁移期兼容）。
5. **bookmarks 不自己管副本**：bookmark 的 `opaque` 是后端自留 token（pi = 拷贝路径，dsh = childSessionId），桌面不再在项目目录管副本目录，改调 `bookmark`/`resume` 契约。

**迁移**：旧会话（文件路径中心）→ 新会话（不透明 id）的兼容靠「归属缺失默认 pi」+「pi 后端的 id↔路径索引」。迁移无损——它从不搬数据，只搬「哪个内核负责哪个会话」的归属。

### 12.3 内核管理（版本/安装/拓展）的对称性

pi 和 dsh 的内核管理（版本切换、自定义目录、拓展安装）已经用**「基类 + 继承」三段式**收敛——这是本文 §21「接口 → 抽象基类 → 具体类」模式在**内核版本管理域已经落地的先行实例**（`AbstractBackend` 是尚未落地的那个，两者同构）：

```
core/domain/kernel-manager.ts              KernelSpec（纯数据契约，零依赖）
        ▲ 注入 spec
core/application/kernel/kernel-manager.ts  KernelManager（抽象基类：装/查/状态合成 + postInstall 钩子）
        ▲ extends
client/pi/pi-kernel.ts                     PiKernelManager（填 PI_SPEC + postInstall 打补丁）
client/dsh/dsh-kernel.ts                   DshKernelManager（填 DSH_SPEC + installPlugin）
        ▲ 组装
bootstrap/kernel/kernel-managers.ts        createPiKernelManager / createDshKernelManager
```

| 面 | pi | dsh | 基类机制（`KernelManager`） |
|---|---|---|---|
| 内核包 | `@earendil-works/pi-coding-agent` | `@deepseek-ai/dsh-sdk-jsonrpc-demo`（主包 bin + 9 插件，`distTag: "next"`） | 读 `spec.pkg` |
| 版本读取 | 读 package.json version | 同左 | `currentVersion()` 按 `spec.pkgJsonPath` |
| 自定义目录 | `dist/cli.js` | `lib/bin.js` | `resolveCustomCli()` 按 `spec.srcCli`/`spec.cliWithinPkg` 归一化 |
| 状态合成 | installed / custom / 回落 | 同左 | `status(customCliDir)` |
| 版本切换 | `install()` + postInstall 打两个补丁 | `install()` + 附带插件同版本 | `install()` 通用 + `protected postInstall()` 钩子（pi override 打补丁，dsh 空实现） |
| 拓展安装 | 5 个 installer（toolgate/subagent/bus/context-probe/pi-extension） | `DshKernelManager.installPlugin`（npm install + `DshConfigSource.addPlugin` 写 cordis.yml） | 不对称（见下） |

**基类只 import `core/domain`，绝不 import 具体内核**——`KernelManager` 只依赖 `KernelSpec`（数据）+ `KernelRuntime`（注入），pi/dsh 的差异全在子类的 spec 值 + `postInstall` 钩子。这印证了 §3.3「框架管通用，特化归外层」：装/查/状态合成是通用机制（收敛基类），包名/路径段/装后补丁是内核专属数据（下沉子类）。

**拓展安装的不对称点**（`kernel-gap-audit.md` §5）：

- pi 的拓展是「装进进程的 TS 扩展」，有 5 个 installer 落盘管理；dsh 的拓展是「cordis 插件」，经 `installPlugin`（npm install 一半）+ `DshConfigSource.addPlugin`（写 cordis.yml 一半），没有对等的 installer 抽象。
- 理想对称：抽一个「内核拓展安装器」接口（`install(ext) / remove(ext) / reconcile()`），pi 的 5 个 installer 和 dsh 的 `installPlugin + addPlugin` 各自实现它。这是阶段 D 的收尾项之一。

## §13 契约的版本化与扩展

- 契约会变——下一个内核漏出新形状，壳的「必要面」可能扩大。但变法是「只往壳的必要面扩」，不追着内核专属形状跑：每加一条意图，都要回答「壳是不是必须向每一个内核索要它」，答不上就不加。
- **加意图**：向后兼容（旧内核不实现新意图，抛缺面异常，壳捕获降级照跑）。
- **改意图**（破坏性，如 `fork` 的 boundary 类型变化）：要显式版本号，壳和适配器按版本对齐。
- 契约没有「悄悄改」——每次改动要么是加、要么是带版本号的破坏性变更，不存在第三种。

**内核专属扩展面**：契约是下限不是上限。壳插件除了六条，还能调到某内核专属意图（如 pi 的 `steer`）——经那个内核的适配器暴露，别的内核上降级「不支持」。专属意图是「有则用、无则降级」的扩展面，不决定内核地位（`multi-kernel-shell.md` §3.3）。

---

# 第四编 · 适配器层

适配器是内核专属形状与中立契约之间的翻译层，每个内核一个。本编定义 pi 适配器（`client/pi/pi-backend.ts`）与 dsh 适配器（`client/dsh/dsh-backend.ts`）的完整设计，以及事件翻译。

## §14 pi 适配器：PiBackend

### 14.1 职责与结构

`PiBackend` 把 pi 的三样东西收编进自身，对外只暴露 `BaseBackend` 中性操作：

- **pi 协议**（JSONL 31 命令）——经 `RpcAdapter` 传输；
- **pi 会话文件**（`~/.pi/agent/sessions/<bucket>/<stamp>.jsonl`）——经 `session-scanner` 的文件操作；
- **pi 的 parentId 树**——经 `resync` 基线 + `projectLineageTree` 投影成 lineage 树。

```ts
// client/pi/pi-backend.ts（目标态；现状是 `implements BaseBackend`，阶段 A 后改 `extends AbstractBackend`）
export class PiBackend extends AbstractBackend {
  constructor(
    private readonly adapter: RpcAdapter,
    private readonly ctx: PiBackendContext,   // { cwd, agentDir }
  ) {}
  readonly kernel = "pi" as const;
  // ... BaseBackend 各方法 + pi 专属命令
}
```

依赖：`client/pi` import `core/domain`（契约）+ `core/protocol`（命令构造/事件翻译）+ `core/application`（`resync` / `session-scanner`）。方向正确——外层依赖内层。

### 14.2 分工：本类做「文件级编排」+「进程级原语」

- **文件级编排**：`bookmark`（全量 JSONL 拷贝）、`resume`（锚点物化成新会话文件）、`deleteBookmark`（移除副本）、`seed`（中性历史物化成 JSONL）。
- **进程级原语**：`start`/`stop` 委托 `RpcAdapter`；`fork`/`getTree`/`getEntries` 走 `resync`（RPC 基线）。
- **进程调度（多会话多进程）归 `SessionStore`**，不归 `PiBackend`——`PiBackend` 只持一个 adapter，不感知别的会话进程。

### 14.3 每个契约方法的 pi 实现

> 表内 `adapter` 指 `RpcAdapter`（pi 的 JSONL 传输层，非「适配器」PiBackend）。术语约定：本文「适配器」专指 `PiBackend`/`DshBackend`，传输层一律写全名 `RpcAdapter`/`JsonRpcTransport`。

| 方法 | pi 实现 |
|---|---|
| `start` | `RpcAdapter.start()`（经 `SubprocessHandle` 委托 `subprocess-lifecycle` 起进程 + 建 JSONL 读写，不直接 spawn） |
| `stop` | `RpcAdapter.stop()` |
| `onEvent` | `RpcAdapter.onEvent(e => cb(translateEvent(e)))` |
| `sendMessage` | `RpcAdapter.send(buildPromptCommand({message, images, streamingBehavior}))` |
| `abort` | `RpcAdapter.send(buildAbortCommand(), { timeoutMs: 8000 })` |
| `setModel` | `RpcAdapter.send(buildSetModelCommand({provider, modelId}))` |
| `fork` | `RpcAdapter.send(buildForkCommand(boundary, "at"))` → `resync` 拿新会话文件路径作 lineage id（pi 总 fork 激活会话，`parentLineageId` 冗余忽略） |
| `getTree` | `resync` → `projectLineageTree(snapshot.tree)` |
| `getEntries` | `resync` → `snapshot.messages` |
| `bookmark` | `copySession(lineageId, newBookmarkPath())`，`opaque` = 拷贝路径 |
| `resume` | `copySession(anchor.opaque, newSessionPath(cwd))`，返回新路径 |
| `deleteBookmark` | `removePath(anchor.opaque)` |
| `seed` | `NeutralMessage[]` 物化成新 JSONL（只 seed user/assistant/toolResult；会话头记 `custom-my-harness-desktop: { kernel: "pi" }`） |

### 14.4 pi 专属命令（扩展面，非 BaseBackend 契约）

`PiBackend` 上还有 pi 专属命令，经 `SessionStore` 的类型守卫（`asPi`）访问，dsh 下缺面。这些是 pi 31 命令的透传，最终应收敛成 `PiBackendExtensions` 接口（§28 反模式）：

- **多路并发**：`steer` / `followUp` / `abortRetry` / `setSteeringMode` / `setFollowUpMode`；
- **思考档位**：`getThinkingLevels` / `setThinkingLevel` / `cycleThinkingLevel`；
- **模型**：`cycleModel` / `getModels`；
- **会话维护**：`compact` / `setAutoCompaction` / `setAutoRetry` / `exportHtml` / `getLastAssistantText` / `setSessionName` / `getSessionStats`；
- **文件级 fork**：`forkCommand` / `clone` / `getForkMessages`；
- **bash**：`bash` / `abortBash`；
- **内部通道（过渡期）**：`send`（透传任意 pi 命令）、`onBusFrame` / `onExtensionUI` / `sendExtensionUIResponse` / `stderr` / `onProcessExit`。

### 14.5 pi 的内核插件（拉平的抓手）

pi 侧的内核插件 = TS 扩展，经 `client/pi/*-installer.ts` 落盘管理（`kernel-gap-audit.md` §5）：

- `toolgate-installer`：会话级工具白名单 + 工具清单广播（`packages/toolgate/` 同步到 `~/.pi/agent/extensions/tool-gate/`）；
- `subagent-extension-installer`：子 agent 五工具；
- `bus-extension-installer`：Session Bus 工具面（`$bus`）；
- `context-probe-installer`：上下文探测；
- `pi-extension-installer`：插件携带底座扩展的同步/摘除/孤儿对账（manifest 声明 `piExtension` 即走此通道）。

## §15 dsh 适配器：DshBackend

### 15.1 职责与结构

`DshBackend` 把 dsh 的三样东西投影到 BaseBackend：

- **dsh 协议**（JSON-RPC 2.0 `session/*` 方法集）——经 `JsonRpcTransport`；
- **dsh 会话**（append-only `SessionEvent` 日志）——经 `session/getTree`/`session/getEntries`；
- **dsh 的 session forest**（父会话 + fork 出的子会话）——投影成 lineage 树。

```ts
// client/dsh/dsh-backend.ts（目标态；现状是 `implements BaseBackend`，阶段 A 后改 `extends AbstractBackend`）
export class DshBackend extends AbstractBackend {
  private sessionId: string;
  constructor(
    private readonly transport: JsonRpcTransport,
    private readonly config: DshBackendConfig,  // { cwd, provider, model, maxTokens?, sessionId?, tempDir? }
  ) { this.sessionId = config.sessionId ?? cwdToBucketName(config.cwd); }
  readonly kernel = "dsh" as const;
  // ... BaseBackend 各方法 + 缺面继承基类默认
}
```

### 15.2 每个契约方法的 dsh 实现

| 方法 | dsh 实现 |
|---|---|
| `start` | `transport.start()` + `request("initialize", {cwd, provider, model, maxTokens})` |
| `stop` | `transport.stop()` + 清理 `config.tempDir`（ephemeral 时） |
| `onEvent` | `transport.onNotification` 过滤 `session.event` → `translateDshEvent` |
| `sendMessage` | `request("session/prompt", {sessionId, contentBlocks: [{type:"text", text}]})` |
| `abort` | `request("session/abort", {sessionId})` |
| `setModel` | `request("session/setModel", {sessionId, provider, modelId})` |
| `fork` | `request("session/fork", {parentSessionId, boundarySeq})`，返回 `lineageId` |
| `getTree` | `request("session/getTree", {sessionId})` |
| `getEntries` | `request("session/getEntries", {lineageId})` |
| `bookmark` | `request("session/bookmark", {lineageId, boundarySeq})` |
| `resume` | `request("session/resume", {anchor})` |
| `deleteBookmark` | 继承基类默认抛「未接线」（子会话删除生命周期未接） |
| `seed` | 继承基类默认抛「未接线」（待 dsh 侧 `session/seed`） |

### 15.3 dsh 的缺面（显式标注，不伪造）

- **`seed`**：阻塞跨内核切换 pi→dsh（§25）。待 dsh 侧 `sdk-jsonrpc-server` 补 `session/seed` 方法。
- **`deleteBookmark`**：dsh 书签是 fork 出的子会话，删除子会话生命周期未接。
- **图片输入**：`sendMessage` 收到非空 `images` 抛「attachment 服务缺面」。
- **`sessionId` 退化**：缺省 `cwdToBucketName(cwd)`（每项目一会话），真正 session-id 化待会话标识中性化收口。

### 15.4 dsh 的内核插件（Cordis 插件树）

dsh 的能力组织是 Cordis 插件树。补面 = 往 `cordis.yml` 加 `@deepseek-ai/dsh-*` 插件（`DshConfigSource.addPlugin`）。默认组合（`DEFAULT_CORDIS_YAML`）：`sdk-jsonrpc-server` + `agent-spine-demo` + `llm-deepseek` + `llm-pi-ai` + `sessions` + `session-checkpoints` + `subprocess` + `bash` + `fs-local`。

- **拉平最小成本**：`dsh-subagent`、`dsh-compaction-basic` 等包已存在（`PLUGIN_ID_MAP` 有映射）但默认未启用——拉平 = 默认组合里启用它们。
- **没有现成插件的**（`steer` 多路并发、`$bus` 会话总线）→ 写新 cordis 插件（§18）。

## §16 事件翻译

事件翻译是适配器的核心：把内核专属事件投成中性 `SessionEvent`。以中性事件为靶，两边往它身上投。

### 16.1 pi 事件翻译（`translateEvent`）

pi 的 `message_start/update/end` 三态 → 中性 `messageStart/messageUpdate/messageEnd`；`tool_execution_start/end` → `toolCallStart/End`。是「拆」——pi 把一条消息拆成三条，适配器把它们投成中性的「开始/增量/结束」。

### 16.2 dsh 事件翻译（`translateDshEvent`）

dsh 的 `SessionEventMap`（声明合并的联合）→ 中性。映射表按**语义对齐**（非按名字错位）——dsh 的「turn」是粗粒度一整轮执行（≈ pi 的 agent loop），「step」是一次模型调用 + 它请求的工具执行（≈ pi 的 turn）。所以 turn 边界投 agent 事件、step 边界投 turn 事件，这样 pi/dsh 吐给壳子的中性事件同一套，切内核透明：

| dsh 事件 | 中性事件 | 说明 |
|---|---|---|
| `turn/start` | `agentStart` | dsh 的 turn ≈ pi 的 agent loop |
| `turn/end` | `agentSettled` | 同上 |
| `step/start` | `turnStart` | dsh 的 step ≈ pi 的 turn |
| `step/end` | `turnEnd` | 同上 |
| `user/message` | `messageEnd`（user） | 完整用户消息 |
| `assistant/message` | `messageEnd`（assistant） | 完整 assistant 消息 |
| `assistant/chunk` | 丢弃 | token 级流式未接（chunk 组装需跨事件维护状态，非纯函数能干净做，留后续） |
| `tool/call` | `toolCallStart` | 工具调用（arguments 字符串解析成 args 对象） |
| `tool/result` | `toolCallEnd` | 工具结果 |
| `todo/write`、`request/header`、`request/context`、`session/end-seed` | 无对应 | dsh 特有，桌面暂不消费则丢弃 |

> 语义对齐的意义：若按名字错位映射（`turn/end → turnEnd`），pi/dsh 的「回合收敛」信号被劈成两个名字，壳子被迫感知内核差异。改按语义后 notifier 依赖的 `agentSettled` 即内核无关。

### 16.3 翻译的纪律

- 以中性事件为靶，两边往它身上投；dsh 有而中性域没有的事件（`todo/write`、`plan/mode`），桌面不消费就丢；哪天想消费，先在中性域加类型、再让翻译器投。
- 翻译器是喂线、不是第二套语义——不许绕过中性域直接读 dsh 事件（`multi-kernel-shell.md` §4.3）。

---

# 第五编 · 能力拉平

本编回答：壳看到 pi 和 dsh 的差异怎么抹平。目标不是让两个内核一模一样（会话模型、插件树、事件形状本来就该不同），而是让**壳插件**不因内核差异而写分支。

## §17 拉平三层次

差异有三条出路，按优先级：

1. **契约层（硬性）**：`BaseBackend` 六条意图，pi 和 dsh 都必须兑现。这一层已把「发消息/中断/切模型/分叉/定位会话/收事件」拉平。
2. **适配器层（形状翻译）**：形状不同但语义同构的，在适配器里翻译（三态↔增量、文件↔id、parentId 树↔session forest）。已落地。
3. **内核插件层（补面）**：形状翻译不了的**能力缺失**，给缺能力的内核写**内核插件**——pi 侧 TS 扩展、dsh 侧 Cordis 插件。

判据同一问：**壳是不是必须向每一个内核索要它？** 答得上，进契约；答不上，就是某内核专属，要么内核插件补、要么显式降级，不允许静默缺面。

**补面下沉到内核，适配器只翻译**（本文对 `multi-kernel-shell.md` §4.4「补面发生在适配器里」的修正）：适配器补面是「壳替内核装一个它没有的东西」，内核插件补面是「内核自己长出一个能力」——后者不破坏「内核自洽」判据。

## §18 能力差异矩阵

逐能力摆平，标注「已拉平 / 适配器拉平 / 内核插件拉平 / 降级」：

| 能力 | pi | dsh | 拉平策略 |
|---|---|---|---|
| 发消息 / 中断 / 切模型 | `prompt`/`abort`/`set_model` 命令 | `session/prompt`/`session/abort`/`session/setModel` | ✅ 契约层 |
| 会话分叉 / 树 / 书签 / 续接 | 文件内 `parentId` 树 | fork 出子会话（前缀拷贝） | ✅ 适配器层（lineage 投影） |
| 流式事件 | `message_start/update/end` 三态 | `turn/start`、`assistant/chunk` 增量 | ✅ 适配器层 |
| 压缩 | `compact` 命令 | `compaction-basic` 插件 | ⚠️ 契约层观察 + dsh 默认 cordis 未启用，拉平=启用插件 |
| 子代理 | `subagent` 扩展（5 工具） | `ctx.subagents` + `dsh-subagent` | ⚠️ 内核插件拉平（pi 扩展已装；dsh 插件存在但默认未启用） |
| 工具白名单 | `toolgate` 扩展 | scoped 工具注册 + approval policy | ✅ 各自 policy（契约层不驱动，壳只观察） |
| 上下文占用 | `context-probe` 扩展实测 | 原生 context usage | ✅ 已拉平（dsh 原生更省一步） |
| bash / 文件工具 | 内置四工具 | `bash`/`fs-local` 插件 | ✅ 已对齐（壳不直接驱动） |
| **多路并发** | `steer`/`followUp`/`abortRetry`/`set*Mode` | 无对应 | 🔻 拉不平 → dsh 写 cordis 插件补，或壳降级 |
| **思考档位** | `thinkingLevel`（get/set/cycle） | `reasoningEffort` | 🔻 概念不同不硬拉平，各自保留 |
| **会话总线 $bus** | `bus` 扩展 | 无对应 | 🔻 拉不平 → dsh 写 cordis 插件补，或降级 |
| **扩展 UI** | `onExtensionUI`/`replyExtensionUI` | 无对应 | 🔻 拉不平 → 降级（dsh 下扩展 UI 入口不出现） |
| todo / plan 事件 | 无 | `todo/write`、`plan/mode` | ✅ 中性域无对应，壳不消费则丢 |
| 图片输入 | 支持 | 未接线（attachment 缺面） | ⚠️ 内核插件补面（dsh 侧补 attachment） |

## §19 缺口去向方案

每条「🔻」或「⚠️」都有明确去向（对应 `kernel-gap-audit.md`）：

| 缺口 | 去向 | 优先级 |
|---|---|---|
| dsh `seed` | dsh 侧补 `session/seed`（deepseek-harness 改动），补前显式「不支持」 | **P0**（阻塞跨内核切换） |
| switchKernel system prompt 重注入 | `switchKernel` 传 `systemPromptPaths`/`systemPromptTexts` | **P0** |
| dsh `deleteBookmark` | dsh 侧接子会话删除生命周期 | P2 |
| dsh 图片输入 | dsh 侧补 attachment 插件 | P2 |
| 子代理 / 压缩拉平 | `DEFAULT_CORDIS_YAML` 启用 `dsh-subagent`/`dsh-compaction-basic` | P2 |
| `steer`/`$bus`/`onExtensionUI` | dsh 写 cordis 插件补，或壳显式降级（入口不出现） | P3 |
| 思考档位 | 各自保留：pi 展示 `thinkingLevel`，dsh 展示 `reasoningEffort` | P3 |
| `llm:oneshot`（pi 专属） | dsh 补 oneshot 能力，或 dsh 下降级 | P3 |

## §20 内核插件策略

- **pi 缺的 → 写 pi TS 扩展**：照 `client/pi/*-installer.ts` 模式——写扩展 + installer（装进 `~/.pi/agent/extensions/` + 对账）。
- **dsh 缺的 → 写 / 启用 cordis 插件**：往 `cordis.yml` 加 `@deepseek-ai/dsh-*`。最小成本是启用现成插件（`dsh-subagent`/`dsh-compaction-basic`）；没有现成的才写新插件。
- **补不了的 → 显式降级**：壳在该内核下隐藏/禁用该能力入口，不静默、不伪造成功。

---

# 第六编 · 类层次

## §21 AbstractBackend 抽象基类

### 21.1 现状与问题

现在是 `BaseBackend`（接口）+ `PiBackend`/`DshBackend`（各自 `implements`）。两个实现里，缺面能力的「不支持」语义各写一份（dsh 的 `deleteBookmark`/`seed` 各抛一次「未接线」），「契约 → 默认行为」没有单一落点。

### 21.2 改进：接口 → 抽象基类 → 具体类

在接口和具体类之间插一层抽象基类，承载「契约骨架 + 缺面默认」，子类只 override 内核差异。基类只依赖 `core/domain`（契约 + 中性类型），不 import 传输/协议——它属于内核层，放 `client/backend/abstract-backend.ts`。

```
core/domain/backend.ts         BaseBackend（接口，契约）
        ▲ implements
client/backend/abstract-backend.ts   AbstractBackend（抽象基类：骨架 + 缺面默认）
        ▲ extends
client/pi/pi-backend.ts        PiBackend（override pi 能力）
client/dsh/dsh-backend.ts      DshBackend（继承缺面默认 + override dsh 能力）
```

```ts
// client/backend/abstract-backend.ts（示意）
export abstract class AbstractBackend implements BaseBackend {
  abstract readonly kernel: KernelId;
  abstract get alive(): boolean;
  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract onEvent(cb: (e: SessionEvent) => void): () => void;
  abstract sendMessage(text: string, images?: ImageInput[]): Promise<void>;
  abstract abort(): Promise<void>;
  abstract setModel(provider: string, modelId: string): Promise<void>;
  abstract fork(parentLineageId: string, boundary?: BoundaryRef): Promise<string>;
  abstract getTree(sessionId: string): Promise<LineageTree>;
  abstract getEntries(lineageId: string): Promise<NeutralMessage[]>;
  abstract bookmark(lineageId: string, boundary: BoundaryRef): Promise<Anchor>;
  abstract resume(anchor: Anchor): Promise<string>;

  deleteBookmark(_anchor: Anchor): Promise<void> {
    throw new Error(`${this.kernel} 后端 deleteBookmark 未接线`);
  }
  seed(_history: NeutralMessage[]): Promise<string> {
    throw new Error(`${this.kernel} 后端 seed 未接线`);
  }
}
```

- `PiBackend extends AbstractBackend`，override `deleteBookmark`（移除 JSONL 副本）与 `seed`（物化 `NeutralMessage[]` 为 JSONL）——它本来就有实现，只是从「平行实现」变成「覆盖基类默认」。
- `DshBackend extends AbstractBackend`，不 override `deleteBookmark`/`seed`，继承基类默认抛错，删掉自己那两份重复。

### 21.3 基类还能收什么（诚实边界）

不能夸大「基类复用」。pi 和 dsh 在会话模型/事件形状/fork 语义上处处相反，`start`/`stop`/`onEvent`/`fork`/`getTree` 这些**不能共享**，仍是 abstract。基类真实收益两条：

1. **缺面语义单源**：所有「未接线」能力默认抛 `` `${kernel} 后端 X 未接线` ``，不再每后端各写一份，加新缺面能力只加基类一处。
2. **契约骨架单一落点**：`BaseBackend` 每个方法在基类有明确归属（abstract 或默认实现），新内核接入 = 继承 + 补 abstract，漏实现由编译器报错。

若将来出现「第三个内核也共享的编排」（如「fork 前校验 boundary 是否落在完整回合之后」这种契约级守卫），再往基类加 protected 模板方法——今天不预支，等真有第二个共享点再收。

### 21.4 与「拉平」的关系

基类解决**实现复用**（怎么少写重复），拉平解决**能力对齐**（怎么让壳无感）。两者正交：基类不产生新能力，内核插件才产生新能力。避免「抽了基类就以为拉平了」的错觉。

---

# 第七编 · 迁移路径

## §22 迁移总览

迁移顺序从内往外、每阶段编译 + 测试全绿，不出现「新契约 + 新分层一起炸」。总体四阶段：

- **阶段 A**（基类落地）：抽 `AbstractBackend`，改继承。低风险，行为零变化。
- **阶段 B**（启用现成 cordis 插件拉平）：`DEFAULT_CORDIS_YAML` 启用 `dsh-subagent`/`dsh-compaction-basic`。
- **阶段 C**（补面 `steer`/`$bus`，视需求）：给 dsh 写 cordis 插件拉平 pi 专属能力，拉不平的显式降级。
- **阶段 D**（接口收尾）：`PiBackendExtensions` / `DshConfigApi` 接口 + `SessionsApi` 拆出 pi 专属 API + 会话标识中性化收口。

每阶段的验收标准在对应节列明；每阶段都独立可回滚（阶段 A 纯重构、阶段 B/C 改默认配置可回退、阶段 D 是接口平移）。

## §23 阶段 A：AbstractBackend 基类落地

**目标**：把「缺面语义」从两个平行实现收敛到基类单源。

**步骤**：
1. 新建 `client/backend/abstract-backend.ts`，`AbstractBackend implements BaseBackend`——abstract 声明 13 个内核差异方法，`deleteBookmark`/`seed` 给默认抛错。
2. `PiBackend extends AbstractBackend`：override `deleteBookmark`/`seed`，删 `implements BaseBackend` 改为继承，`kernel`/`alive`/`start`/`stop`/`onEvent` 等保留为实现。
3. `DshBackend extends AbstractBackend`：删自己两份 `deleteBookmark`/`seed` 抛错，继承基类默认。
4. 依赖方向确认：`AbstractBackend` 只 import `core/domain`。

**验收**：typecheck 通过；既有 403 测试 + build 全绿；`deleteBookmark`/`seed` 的「未接线」抛错只在 `abstract-backend.ts` 出现一处（grep 可证）。

**回滚**：`git revert` 阶段 A 的 commit——纯重构，无行为变化，回滚零风险。

## §24 阶段 B：启用现成 cordis 插件拉平

**目标**：把「子代理 / 压缩」在 dsh 下拉平到 pi 同级。

**步骤**：
1. `DshConfigSource.DEFAULT_CORDIS_YAML` 增加 `@deepseek-ai/dsh-subagent` 与 `@deepseek-ai/dsh-compaction-basic` 两项（对齐 `PLUGIN_ID_MAP` 已有映射）。
2. 首次运行 `ensureDefaultCordis` 时写含这两项的组合；已有用户 cordis.yml 不动（不强制改用户文件），仅「可用插件」列表可见可启用。
3. 验证 dsh 会话能跑子代理、能压缩。

**验收**：dsh 底座下 `ctx.subagents` 子代理与 compaction 事件（`compactionStart/End`）端到端可见。

**回滚**：从 `DEFAULT_CORDIS_YAML` 移除两项即可；用户已写的 cordis.yml 属用户数据，不自动回滚。

## §25 阶段 C：补面 + 降级（视需求）

**目标**：给 dsh 拉平 pi 的专属能力，拉不平的显式降级。

**步骤**：
1. **补 `session/seed`（P0，阻塞跨内核切换 pi→dsh）**：dsh 侧 `sdk-jsonrpc-server` 补 `session/seed` 方法（deepseek-harness 改动），`DshBackend.seed` override 实现；补前 `seed` 显式抛「未接线」，pi→dsh 切换在 seed 步降级报错。
2. **补面 `steer`（多路并发）**：写 `@deepseek-ai/dsh-steer` cordis 插件，在 dsh 会话里支持并发消息线；或评估成本后走降级。
3. **补面 `$bus`（会话总线）**：写 `@deepseek-ai/dsh-bus` cordis 插件；或走降级。
4. **显式降级 `onExtensionUI`/思考档位**：壳在 dsh 下不出现 `onExtensionUI` 相关入口；思考档位 pi 展示 `thinkingLevel`、dsh 展示 `reasoningEffort`，各自保留不硬拉平。
5. **跨内核切换补缺口（属本阶段）**：`switchKernel` 传 `systemPromptPaths`/`systemPromptTexts`（system prompt 重注入）+ 会话头 `custom-my-harness-desktop.kernel` 重绑。

**验收**：dsh 会话能 seed（跨内核切换 pi→dsh 通）；壳插件在 dsh 下不出现 pi 专属入口、不静默失败；跨内核切换 pi↔dsh 消息流续接正确、system prompt 不丢、会话头 kernel 归属正确。

**回滚**：新增 cordis 插件从 `cordis.yml` 摘除；降级逻辑回退；`session/seed` 由 dsh 侧版本回退。

## §26 阶段 D：接口收尾

**目标**：把 G1（21 个 pi 形状 API）与 G2（21 处 `asPi`）从「pi 专属散落」收敛成「内核专属扩展面接口」。

**步骤**：
1. **`PiBackendExtensions` 接口**（放 `client/pi`）：把 `PiBackend` 的 pi 专属命令 + 内部通道（`send`/`onBusFrame`/`onExtensionUI`/`stderr`/`onProcessExit`）收成接口，`PiBackend implements BaseBackend, PiBackendExtensions`。`session-store` 的 `import type { PiBackend }` 换成 `import type { PiBackendExtensions }`，`asPi` 返回接口类型，经 `backend.kernel === "pi"` + 类型断言获取。
2. **`DshConfigApi` 接口**：把 `DshConfigSource` 的 15+ 方法收成接口（`listModels`/`listProviders`/`setProvider`/`addPlugin`/`getDefaultModel`/…），`DshConfigSource implements`，`MainContext.dshConfigSource` 换接口类型。
3. **`SessionsApi` 拆 pi 专属 API**：把 21 个 pi 形状方法从 `domain/sessions.ts` 的 `SessionsApi` 拆出，收敛成 `PiExtensions`（内核专属扩展面），壳插件按「有则用、无则降级」访问。这是 G1 的终态——圆心契约只留六条意图，pi 专属能力回内核扩展面。

**验收**：`domain/sessions.ts` 不再有 pi 专属方法；`session-store` 无 `import type { PiBackend }` 具体类；`MainContext` 无 `DshConfigSource` 具体类；全量测试 + build 绿。

**回滚**：接口平移，逐 commit 回退。

---

# 第七编补 · 测试与运行

## §26A 测试策略

「换内核 = 换适配器」的可检验形式是：**同一套壳插件测试，参数化地跑在 pi 和 dsh 两个后端上，全绿且壳插件代码零改动**。三层测试：

**单测（纯函数，无 mock）**：
- `KernelId` / `KERNEL_IDS`：字面量联合 + 枚举。
- `projectLineageTree`：入口级树 → lineage 树的投影（首子主干、分叉点、森林多根）。
- `model-catalog` 合流：`PiModelSource` + `DshConfigSource` 两路合成带 `kernel` 标的 `ModelInfo[]`，同名不跨内核去重。
- 事件翻译：`translateDshEvent` 映射表逐条（turn/user-message/assistant-message/tool-call/tool-result/丢弃项）。

**集成测试（mock transport，不起真进程）**：
- `PiBackend` / `DshBackend` 各自用 fake adapter/transport 验证契约方法映射到正确命令/请求。
- `session-store` 用 fake `BackendFactory` 验证：`switchKernel` 五步顺序、`createProc` 中性字段翻译、pi 专属通道只在 pi 后端绑定。

**回归测试（参数化双后端）**：
- 「会话流三处显标」「跨内核切换」两组用例参数化——同一套断言，先 `createPiBackend` 跑、再 `createDshBackend` 跑。差异只在适配器，壳插件代码零改动。
- 若某条在 dsh 上红，先分清「dsh 缺面」（§19 已列）还是「壳漏内核身份」（§28 反模式），后者才是要修的。

**测试纪律**：dsh 集成测试若无法起真进程（无网络/无 key），用 mock transport（`JsonRpcTransport` 假实现）验证 seed/resume 的调用参数，不依赖真模型。不 sleep 等就绪，就绪用实证探测。

## §26B 安全与凭证

- **凭证不进圆心契约明文往返**：圆心/application 只声明「需要读/写内核的 llm 配置」接口，apiKey 的脱敏、加密、不回显在协议翻译层 / IPC 边界处理。renderer 拿到的 apiKey 是「可写、不回显明文」（或只显示「已设置」态），与 pi 的 apiKey 处理对齐。
- **凭证落盘位置是内核原生**：壳写凭证写 env 侧（`DEEPSEEK_API_KEY` 环境变量），不把明文 key 写进 cordis.yml（`apiKeyEnv: DEEPSEEK_API_KEY` 是「key 名」不是「key 值」——token key 合规、token 值违规）。
- **路径圈禁**：dsh reader 读 cordis.yml 时，路径限定在 dsh harness home（`$DSH_HOME`/`~/.dsh`）或显式声明的路径，不开放「任意路径读 cordis.yml」；写回同理，`dsh:models.set` 只写 dsh 原生配置路径，越界抛错——与 config-file 路径白名单（`~/.my-harness-desktop/`、`~/.pi/agent/`）同款纪律，dsh 配置是第三类白名单前缀。
- **模型清单合流不额外 spawn**：读 pi models.json 和 dsh cordis.yml 都是文件读，不起 pi/dsh 进程。谁要为了「读 dsh 模型」就 spawn 一个 dsh，是性能反模式（§28.3）。

## §26C 性能与事件驱动

- **就绪探测不 sleep**：冷启动不用 sleep 猜就绪时间，向内核发探测命令以结果为准（pi 发 `get_state`，dsh 的 `initialize` 握手本身即探测）。删掉固定 sleep，换成实证探测（`session-store` 的 `waitReady` 已落地）。
- **模型清单读文件不 spawn**：`listModels()` 是「一次触发两个文件读」（pi models.json + dsh cordis.yml），冷启动多一个文件读可忽略；刷新走事件驱动（`system:configFileSaved` 按 path 匹配 models.json / cordis.yml），不轮询不 sleep。
- **事件增量应用**：组件只读 store、零拉取，基线 + 事件增量。数据源变了推给订阅者，没变不打扰。
- **「一个内核 = 一个子进程」不变**：模型清单合流不额外 spawn；跨内核切换是「stop 旧 + spawn 新」，任一时刻单进程，不叠加。

---

# 第八编 · 边界与反模式

## §27 边界情况

逐条钉死最会踩的边界（`multi-kernel-shell.md` §3.7 展开）：

| 边界 | 处置 |
|---|---|
| 空会话上 fork | `fork(parent, 空 boundary)` = 「开一条新 lineage」，不报错 |
| setModel 到不存在的模型 | 内核报错，壳在模型下拉标红，不静默切上一个 |
| 流断开在消息中间 | 壳把已收部分标「已停止」，不假装完整，下次从「重试」开始 |
| 两个内核同名模型 | 模型名是内核各自的，壳不跨内核比对，选哪个内核用哪个模型表 |
| anchor 失效（pi 拷贝被删 / dsh 子会话清理） | `resume` 返回「锚点已失效」，壳给「删除」或「重建」两选择 |
| 锚点跨后端（pi 锚点给 dsh resume） | `resume` 报「锚点不属于此后端」，壳提示换后端打开，不静默不误路由 |
| 内核崩溃（进程退出） | 适配器把「已收部分」投「已停止」，pending 请求全报错，壳进「内核离线」态可重启 |
| RPC 超时 | 单条请求超时报错，不影响内核进程本身 |
| 缺面调用 | 适配器抛缺面异常（如 `` `${kernel} 后端 X 未接线` ``），壳捕获降级（隐藏/置灰入口），不静默不伪造成功 |
| switchKernel 时有 fork 的会话 | 第一期只支持无 fork 的线性 lineage；有 fork 的降级提示 |

三条共同纪律：适配器不吞错、不伪造成功——内核没做的事，适配器绝不假装做了（`multi-kernel-shell.md` §4.7）。

## §28 反模式

### 28.1 壳代码里写 `if (kernel === "pi")` 分支

- 症状：壳（渲染/编排）里出现 `if (kernel === "pi") PiLogo else DshLogo` 或 `if (sessionPath.endsWith(".jsonl"))`。
- 根因：壳漏了内核身份。内核身份只应出现在「路由」这一跳（`bootstrap` 工厂），壳的其余代码不感知。
- 正解：内核标走 `PluginIcon name={kernel}`（单源映射，加内核只加一处 `PluginIcon` 分支）；文件路径判断收进适配器。

### 28.2 `if (provider.includes("deepseek")) kernel = "dsh"`

- 症状：按 provider 名反推内核身份。
- 根因：pi 里也能配一个叫 `deepseek-official` 的 provider，猜错就静默串内核。
- 正解：内核由**来源**判别——`kernel` 是扫描器在「读哪路」时赋的值，不由 provider 名反推（`ModelInfo.kernel` 的来源投影）。

### 28.3 为了读模型 spawn 一个内核

- 症状：`listModels()` 里 spawn 一个 dsh 去问模型。
- 根因：「读模型」和「跑会话」职责混了，且打开会话页就起常驻进程。
- 正解：dsh 模型从 cordis.yml 文件读（它是配置，不依赖 dsh 进程），spawn 只在「要跑会话」时发生。

### 28.4 dsh 未配置静默当 pi

- 症状：dsh reader 读不到 cordis.yml 返回空，模型下拉只显示 pi，用户以为「没有 dsh 模型」。
- 正解：dsh 未配置是「显式态」不是「空态」——DSH 模型配置 TAB 给「去配 cordis.yml」入口。

### 28.5 翻译层让 dsh 装 pi

- 症状：写适配器让 dsh 学说 pi 的 31 命令、重新实现 parentId 树。
- 根因：把「内核」当成「pi 的形状」。dsh 的 append-only 日志、子会话这些真长处全被埋掉。
- 正解：lineage 树是两边都能原生表达的最小公共语义，pi 投影 parentId 树、dsh 投影 session forest，谁也不装谁。

### 28.6 `import type { PiBackend }` 具体类进 core

- 症状：`session-store.ts` `import type { PiBackend } from client/pi/pi-backend`（type-only 但 import 具体类）。
- 根因：pi 专属能力经类型守卫分发，没走接口。
- 正解：`PiBackendExtensions` 接口（§26 阶段 D），core 只 import 接口不 import 类。

### 28.7 把内核专属 spawn 参数写进工厂契约

- 症状：`BackendFactory.create` 的 opts 里出现 `args`/`cliPath`/`cordisConfig`。
- 根因：内核专属形状漏进中性契约。
- 正解：`BackendCreateOptions` 只收中性字段，专属参数由 bootstrap 工厂闭包捕获（已落地）。

### 28.8 在适配器里 spawn 进程

- 症状：`BaseBackend` 的实现类里既拼命令又 spawn 又等响应又解析（构造与执行不分）。
- 根因：违背「构造与执行分开」。适配器只做「把中性意图翻译成内核命令」，spawn 归子进程生命周期。
- 正解：传输（`RpcAdapter`/`JsonRpcTransport`）持 `SubprocessHandle` 接口，spawn/kill 策略在 `subprocess-lifecycle`，适配器不直接 `spawn()`。

### 28.9 基类里 import 具体传输

- 症状：`AbstractBackend` import `RpcAdapter` 或 `JsonRpcTransport` 具体类。
- 根因：基类应只依赖 `core/domain`（契约），传输是内核专属。
- 正解：基类只 import 契约 + 中性类型；传输具体类由子类持有、经 abstract 方法暴露。

### 28.10 会话头不记内核归属

- 症状：会话头只记内容，不记 `kernel` 归属；切换内核后「这是哪个内核的会话」丢失。
- 根因：内核归属是会话自带的元数据，不记进头就会靠「默认 pi」猜，dsh 会话被误当 pi 打开。
- 正解：会话头记 `custom-my-harness-desktop: { kernel }`，`list()` 按头路由；归属缺失默认 pi（迁移期兼容）。

### 28.11 事件翻译绕过中性域

- 症状：壳插件直接消费 dsh 的 `todo/write` 或 pi 的 `message_update` 原始事件。
- 根因：翻译器是喂线、不是第二套语义。绕过中性域读内核事件，壳就偷偷依赖了内核。
- 正解：内核事件必须经翻译器投成中性 `SessionEvent`；想消费新事件，先在中性域加类型再让翻译器投。

### 28.12 切内核时把会话「搬」过去

- 症状：切内核 = 把 pi 的 JSONL 翻译成 dsh 的 session log 搬过去。
- 根因：会话数据边界是内核私有的，不存在「跨内核搬会话」这条路径。
- 正解：切内核 = 五步切换（abort → getEntries 快照 → stop → create+start → seed），把**中性 transcript** seed 到新内核，新内核自己开新会话，旧会话留在原地。

---

# 第九编 · QA

**Q：pi 有 `steer`、dsh 没有；dsh 的热切模型要补面、pi 现成——两边各有对方没有的东西，还算「同级」吗？**
答：算。同级指「地位」（谁都不是内建、谁都能被换掉），不是「能力完全重合」。契约只保证六条最小意图两边都兑现；超出最小意图的能力谁有谁用，没有的一方降级。

**Q：加了 dsh 之后，下一个内核又漏新形状，契约会不会永远补？**
答：契约补不补取决于「壳是不是必须向每一个内核索要它」。非必须的留在适配器降级，不进契约。契约只往「壳的必要面」扩。

**Q：「地板」画在哪，谁说了算？**
答：画在「壳必须中立」和「内核各自专属」的分界上，判据是那一问。壳插件/渲染/布局必须中立；文件树、append-only 日志是内核价值本身，削平了就没内核可换。

**Q：壳插件现在真的内核无关，还是「只遇到过 pi 所以看起来无关」？**
答：是「半解耦」。会话标识、事件形状、fork 语义三处曾漏 pi，已收进适配器；`SessionsApi` 的 21 个 pi 形状 API 还没拆出（阶段 D）。真正内核无关要等 dsh 挂上来壳插件一个不改地跑。

**Q：迁移期 pi 和 dsh 并存，一个会话能不能在两个内核间切？**
答：会话数据边界是内核私有的（pi 是文件、dsh 是日志），一个会话永远只在一个内核下打开，内核归属记在会话头。切内核 = 五步切换（abort → getEntries 快照 → stop → create+start → seed），不是「把同一会话搬过去」。有 fork 的会话第一期降级。

**Q：适配器「缺面降级」时，壳插件会不会感知到差异？**
答：会，但差异只体现在「那个能力不可用」，不是「内核身份泄露」。壳插件调 `steer` 得到「不支持」，知道的是「当前内核没有多路并发」，不是「当前是 pi 还是 dsh」。

**Q：多内核会不会让壳变复杂？壳插件会不会更难写？**
答：壳多一层「路由」，但只有一个职责（按内核归属路由到适配器）。壳插件看到的还是那份契约，不增加 API 面。真正变难的是适配器作者——要同时懂一个内核的专属形状和一份中立契约。

**Q：「多内核」和「多 provider」是一回事吗？**
答：不是。「多 provider」是同一内核里换模型供应商（pi 里换 Anthropic/OpenAI），内核内部的事，壳无感。「多内核」是换整个 agent 运行时（pi↔dsh），会话怎么存、fork 怎么分叉、扩展怎么装都变了。前者是 `setModel`，后者是换适配器。

**Q：内核的「能力」和契约的「意图」是一回事吗？**
答：不是。能力是内核**有什么**（pi 有 31 命令、dsh 有能力缝），意图是壳**要什么**（六条）。两者靠适配器对上：直接映射、需翻译、缺面。

**Q：为什么每个内核要有自己的插件树，不让壳统一管？**
答：插件树是内核的能力来源，不是壳的 UI 扩展。dsh 的工具、模型适配器、能力缝全是 Cordis 插件，直接操作 dsh 的 session/agent 内部；pi 的扩展同理直接 patch pi 的 RPC。挂到壳上等于让壳实现每个内核的运行时细节，壳就不是薄壳了。

**Q：`BaseBackend` 和 `AbstractBackend` 是什么关系？**
答：`BaseBackend` 是圆心接口（契约），`AbstractBackend` 是内核层的抽象基类（实现复用）。接口定义「有什么」，基类给「缺面默认」。application 只依赖接口，不 import 基类（基类是内核层实现细节）。

**Q：补面到底在适配器还是内核插件？**
答：本文明确：**适配器只翻译，补面下沉到内核的内核插件**（§17）。适配器补面是「壳替内核装能力」，内核插件补面是「内核自己长能力」——后者不破坏内核自洽。这是对 `multi-kernel-shell.md` §4.4 的一处修正。

**Q：会话标识中性化后，旧会话（文件路径中心）怎么兼容？**
答：靠「归属缺失默认 pi」+「pi 后端的 id↔路径索引」两层兼容。旧会话头没有 `kernel` 归属，`list()` 默认按 pi 打开，pi 后端内部把不透明 id 映射回文件路径。迁移无损——它从不搬数据，只搬「哪个内核负责哪个会话」的归属（§12.2）。

**Q：内核管理（版本切换/自定义目录）怎么和适配器解耦？**
答：`KernelSpec`（`pkg`/`pkgJsonPath`/`extraPackages`）把「pi 和 dsh 的 npm 安装形态」参数化，版本读取/切换/自定义目录归一化共用同一套函数（`currentVersion`/`installKernel`/`resolve*CustomCli`）。适配器（`PiBackend`/`DshBackend`）不感知「内核装在哪、什么版本」——它只拿到 `cliPath`（由 bootstrap 解析后注入）。

**Q：为什么 pi 的 31 命令构造留在 `client/pi` 依赖的 `core/protocol`，而不是 dsh 也共用？**
答：这是「抽象在 core」原则下的一处**不对称**——`core/protocol` 现在只有 pi 的协议契约（抽象，对），dsh 的协议契约（方法名）却散在 `client/dsh/json-rpc.ts` 字符串里（抽象泄漏进实现层）。正解是 §6.5「协议分层」：**所有协议契约（抽象）统一上提 `core/protocol`**（pi 命令枚举 + dsh 方法枚举都在此），传输实现留在 `client/{kernel}`。当前只有 dsh 方法枚举上提未做，属已知不对称，落地按 §6.5.4 迁移方案执行。

**Q：`AbstractBackend` 基类放 `client/` 还是 `core/application/`？**
答：放 `client/backend/`（内核层内部）。理由：基类是「内核层共享骨架」，只被 `PiBackend`/`DshBackend` import；`core/application` 只依赖 `BaseBackend`/`BackendFactory` 接口，不 import 基类（基类是内核层实现细节）。基类只依赖 `core/domain`，方向正确。

**Q：测试参数化双后端怎么落地？**
答：把「会话流三处显标」「跨内核切换」两组集成测试写成参数化——同一套断言，先 `createPiBackend` 跑、再 `createDshBackend` 跑（§26A）。差异只在适配器，壳插件代码零改动。若某条在 dsh 上红，先分清「dsh 缺面」还是「壳漏内核身份」，后者才是要修的。

**Q：图片输入为什么不进六条意图？**
答：图片是「消息内容」的一部分，不是独立意图——`sendMessage(text, images?)` 的 `images` 参数已经承载了它。六条意图是「壳必须向每个内核索要」的最小集，图片只是其中「消息」意图的可选输入。dsh 图片未接线是「消息意图的缺面」，不是「缺一条意图」。

**Q：`sessionId` 为什么不进配置文件，`kernel` 归属却记进会话头？**
答：两者性质不同。`sessionId` 是内核侧造的标识（pi 文件路径 / dsh session id），是「来源投影」不是「config 输入」；`kernel` 归属是「这个会话由哪个内核负责」的元数据，是会话头自带的，必须持久化否则切内核后丢失。前者退进后端存储，后者进会话头——一退一进，各归其位。

**Q：切内核时为什么是「seed 中性历史」而不是「复用旧会话」？**
答：因为 `resume(anchor)` 续「内核自己的会话」，锚点是内核自己造的；跨内核切换的旧历史是「壳给的、新内核没有对应锚点」，只能 `seed`。两者都进 `BaseBackend`，但语义不同：`resume` 续旧，`seed` 造新再续（§9.7）。

---

# 第十编 · 附录

## §29 设计决策记录（ADR）

| # | 决策 | 理由 | 替代方案（被否） |
|---|---|---|---|
| D1 | 会话语义归一为 lineage 树（分叉点节点），不保留 pi 的条目树 | pi/dsh 两边都原生表达；session-tree 和 session-groupings 能合体 | 保留条目树（dsh 造不出，硬翻译） |
| D2 | 内核身份用字面量联合 `"pi" \| "dsh"`，不用 `string` | 加内核编译器逼补全所有 `switch` | `string`（失去编译期检查） |
| D3 | 工厂契约只收中性字段，专属参数闭包捕获 | 内核形状不进契约 | 专属参数进契约（泄漏） |
| D4 | 补面下沉内核插件，适配器只翻译 | 不破坏内核自洽 | 适配器补面（壳替内核装能力） |
| D5 | 缺面能力基类给默认「不支持」，子类 override | 缺面语义单源 | 每后端各写一份（重复） |
| D6 | `sessionId` 是不透明 id，存储退进后端 | 壳不读任何内核存储 | 文件路径进契约（泄漏） |
| D7 | 迁移顺序「pi 先降级、dsh 后入列」 | 每步有已知正确参照线 | 一起改（分不清谁的错） |
| D8 | 会话按内核划界，切内核 = 五步切换，不跨内核搬数据 | 数据边界内核私有 | 会话在两个内核间搬（无此路径） |
| D9 | 抽象在 core：接口/契约/类型/协议枚举统一收敛 `core/`，`client/` 只有实现 | 抽象稳定留内层，会变实现推外层（§6.5） | 协议契约下沉 client（抽象泄漏进实现层） |

## §30 与分册文档的关系

**冲突裁决（契约单源纪律）**：本文是内核层的**唯一权威**。五篇分册是演进过程中的「思路稿」，与本文冲突时**以本文为准**。已知的实质冲突，本文已做改写（不回写分册、不标废弃，避免多份真相漂移）：

1. **类型覆盖**：本文 §12 的 `BoundaryRef=string`、`Anchor{lineageId,boundary,opaque}`、`LineageTree{rootId,lineages[]}`、`Lineage{id,fork}`、`getEntries→NeutralMessage[]` 与已落地 `core/domain/backend.ts` 一致，**覆盖并取代** `base-interface-lineage.md` §2.5 的类型草案（`boundarySeq:number`、`root`、`forkPoint`、`NeutralEvent`）。
2. **事件映射覆盖**：本文 §16.2 的「语义对齐」映射表（turn→agent、step→turn）**覆盖** `base-interface-lineage.md` §4.3 的「名字错位」草案。
3. **补面归属修正**：本文 §17「补面下沉内核插件、适配器只翻译」是对 `multi-kernel-shell.md` §4.4「补面发生在适配器里」的修正（注意：原文出处是 multi-kernel-shell §4.4，不是 base-interface-lineage §4.4）。

| 分册 | 本文对应编 | 关系 |
|---|---|---|
| `multi-kernel-shell.md` | 第一编（总纲） | 本文是它的契约化展开 |
| `base-interface-lineage.md` | 第三编（圆心契约） | 本文补全逐方法语义 + 覆盖其类型/事件草案 |
| `kernel-layer.md` | 第二编（洋葱分层） | 本文是它的规范版 |
| `kernel-alignment.md` | 第五、六编（拉平 + 类层次） | 本文是它的展开 |
| `kernel-gap-audit.md` | 第五编 §19（缺口去向）+ 第八编（反模式） | 本文引用其统计 |

## §31 端到端故事：一个会话把六条意图串起来

**pi 内核下**：用户开新会话（内核归属记进会话头 `kernel: "pi"`）→ 发消息 `sendMessage`（起 pi 进程，`prompt` 命令）→ pi 边生成边推 `message_start/update/end`，适配器投成中性事件流，timeline 流式滚出回复 → 用户不满意，点「从这里分叉」`fork`（`buildForkCommand` + resync 拿新 lineage id）→ 在新分支里觉得值得留，点书签 `bookmark`（全量 JSONL 拷贝，`opaque` = 拷贝路径）→ 换模型 `setModel` 继续 → 聊完，中途点过几次停止 `abort`。

**dsh 内核下**：同样六条意图，落点不同——`sendMessage` 走 `session/prompt`，事件是 `assistant/chunk` 增量组装，`fork` 走 `session/fork`（子会话 id 即 lineage id），`bookmark` 走 `session/bookmark`（`opaque` = childSessionId），`setModel` 走 `session/setModel`。壳从头到尾没碰过 pi 的 JSONL 文件、没消费过 dsh 的原始事件——这就是六条够用的证明。

**跨内核切换**：用户在 pi 会话里聊了一段，想试 dsh 的 DeepSeek → 点切内核 → 五步：`abort` 在飞回合 → `getEntries` 快照中性历史 → `stop` 旧 pi → `create + start` 新 dsh → `seed` 历史到 dsh → 会话头 `kernel` 重绑为 dsh。消息流续接，后续 `sendMessage` 走 dsh。切回来同理。

## §32 接入第三个内核的检查清单

将来加第三个内核（比如一个只有 LSP 的本地 agent），照这张清单核对——每一项都是「可托管内核」的必要条件：

1. **spawn 命令**：怎么起进程、起几个、怎么杀（进 `client/<new>/subprocess-lifecycle`）。
2. **适配器**：`<New>Backend extends AbstractBackend`，六条意图每条兑现或显式「不支持」。
3. **会话模型映射**：`fork` 的 parent/boundary 对应它内部什么，落到 lineage 坐标系。
4. **事件翻译**：专属事件 → 中性 `SessionEvent`，无对应的丢弃或先在中性域加类型。
5. **模型源**：`KernelModelSource` 实现（`listModels` 带 `kernel` 标）。
6. **内核管理**：`KernelSpec`（pkg/pkgJsonPath/extraPackages）注册进 `kernel-manager`。
7. **契约面**：`KernelId` 加一个字面量 + `KERNEL_IDS` 加一项（编译器逼补全 `switch`）。
8. **内核标**：`PluginIcon` 加一个分支（logo + `name === "<new>"`）。
9. **管理 UI**：一个 `<new>-manager` 插件（内核版本/拓展/模型三 TAB）。
10. **回归**：壳插件集成测试参数化跑第三个后端，全绿且壳插件零改动。

这十项全过，第三个内核就是「可托管内核」；缺任何一项，它只是「一个能跑的程序」。前九项是「接入成本」，第十项是「接入成功的判据」——同一套壳插件测试跑第三个后端不改一行，那句「内核无关」才第三次被验证。

## §33 与项目纪律的对照

本文落实了 my-harness-desktop 的核心纪律，逐条对照：

| 纪律 | 本文对应 |
|---|---|
| 依赖只向内 | §5 分层总览 + §6 依赖方向检验（core 值 import client 归零） |
| 机制与内容分离 | §3.4 壳拥有机制、内核拥有内容；壳 vs 内核 = UI 层「壳 vs 壳插件」的延伸 |
| 契约单源 | §8 KernelId + §12 中性类型（圆心定义一份，外层 re-export） |
| 无特权差异 | §7 pi 失去默认特权，「默认 pi」是配置不是内建 |
| 消费而非翻译 | §28.5 反模式（翻译层让 dsh 装 pi 被禁）+ 协议翻译的边界 |
| 构造与执行分开 | §28.8 反模式（适配器不 spawn）+ `BackendFactory` 组装归 bootstrap |
| 依赖倒置连通内外 | §10 BackendFactory / §11 KernelModelSource（接口在内层，实现在外层） |
| 框架管通用，特化归外层 | §18 能力矩阵（六条意图是通用面，pi 专属命令是扩展面） |
| 根因修复不打补丁 | §28 反模式（逐条标根因）+ §19 缺口去向（补面而非静默） |
