# 内核对齐与类层次：PI 与 DSH 的能力拉平 + 基类继承

- 本文是内核层三篇设计文档的第三篇。`multi-kernel-shell.md` 立「内核 / 中立契约 / 适配器 / 壳」四个抽象（为什么），`base-interface-lineage.md` 落 `BaseBackend` 五操作与 lineage 树（怎么做），`kernel-layer.md` 收口洋葱分层与圆心契约（摆对层）。本文回答剩下来的两个问题：**壳看到 pi 和 dsh 的差异怎么抹平**（能力拉平），以及**两个后端的实现怎么复用**（基类 + 继承）。配套的**缺口实证清单**见 `kernel-gap-audit.md`（逐文件定位每处没拉平/需要改的点并统计）。

- 名词沿用前几篇：**内核**（pi / dsh）、**契约**（圆心 `BaseBackend` 六条意图）、**适配器**（`PiBackend` / `DshBackend`）、**壳插件**（挂槽位的 UI 插件）、**内置插件**（本文新增强调——pi 侧是装进进程的 TS 扩展，dsh 侧是 Cordis 插件树里的插件，两者都是「内核自己的插件」，不是壳插件）。

## 1. 目标：壳看到的内核尽量一致

- 一句话：**壳对 pi 和 dsh 的感知差异最小化**。差异有三条出路，按优先级：适配器层翻译（形状不同）、内核层内置插件补（能力缺失）、显式降级（补不了）。目标不是让两个内核一模一样——它们的会话模型、插件树、事件形状本来就该不同（`multi-kernel-shell.md` §3.2「契约的地板」）——而是让**壳插件**不因为内核差异而写分支。

- 判据和 `multi-kernel-shell.md` §3.3 同一问：**壳是不是必须向每一个内核索要它？** 答得上，进契约；答不上，就是某个内核的专属能力，要么用内置插件给另一个内核补上，要么在壳里显式降级。

## 2. 拉平的三个层次

### 2.1 契约层（硬性，已落地）

- 圆心 `BaseBackend` 六条意图——`sendMessage` / `abort` / `setModel` / `fork` / `getTree·getEntries·bookmark·resume·deleteBookmark`（会话标识四操作）/ 流式事件订阅。pi 和 dsh **都必须兑现**，缺了就是内核不合格。这一层已经把「发消息 / 中断 / 切模型 / 分叉 / 定位会话 / 收事件」拉平了。

### 2.2 适配器层（形状翻译，已落地）

- 形状不同但语义同构的，在适配器里翻译：pi 的 `message_start/update/end` 三态 ↔ dsh 的 `assistant/chunk` 增量 → 同一条中性事件流；pi 的文件路径 ↔ dsh 的 session id → 同一个不透明 `sessionId`；pi 的 parentId 树 ↔ dsh 的 session forest → 同一棵 `LineageTree`。这些已经收在 `client/pi/pi-backend.ts` 和 `client/dsh/dsh-backend.ts` 里。

### 2.3 内核层（内置插件补面，本文重点）

- 形状翻译不了的**能力缺失**，不在适配器里硬凑，而是给缺能力的内核写**内置插件**。这是本文相对 `base-interface-lineage.md` §4.4 的一处澄清：那篇说「补面发生在适配器里」，但更稳的落点是——**适配器只做翻译，能力补面下沉到内核自己的插件树**（`multi-kernel-shell.md` §2.10「插件树是内核的能力来源」）。适配器补面是「壳替内核装一个它没有的东西」，内置插件补面是「内核自己长出一个能力」——后者不破坏「内核自洽」这条判据。

- pi 侧的内置插件 = TS 扩展，现状已在 `client/pi/`：`toolgate-installer`（会话级工具白名单 + 工具清单广播）、`subagent-extension-installer`（子 agent 五工具）、`bus-extension-installer`（Session Bus 工具面）、`context-probe-installer`（上下文探测）。dsh 侧的内置插件 = Cordis 插件（`@deepseek-ai/dsh-*`），经 `DshConfigSource` 写进 `cordis.yml` 启用。

## 3. 能力差异矩阵

- 逐能力把 pi 和 dsh 摆平，标注「已拉平 / 适配器拉平 / 内置插件拉平 / 降级」。这张表是本文的骨架，也是将来加第三个内核时的核对清单。

| 能力 | pi | dsh | 拉平策略 |
|---|---|---|---|
| 发消息 / 中断 / 切模型 | `prompt` / `abort` / `set_model` 命令 | `session/prompt` / `session/abort` / `session/setModel` | ✅ 契约层 |
| 会话分叉 / 树 / 书签 / 续接 | 文件内 `parentId` 树 | fork 出子会话（前缀拷贝） | ✅ 适配器层（lineage 投影） |
| 流式事件 | `message_start/update/end` 三态 | `turn/start`、`assistant/chunk` 增量 | ✅ 适配器层（`translateEvent` / `translateDshEvent`） |
| 压缩 | `compact` 命令 | `compaction-basic` 插件 | ⚠️ 契约层（观察 `compactionStart/End`）+ dsh 默认 cordis 未启用，拉平=启用插件 |
| 子代理 | `subagent` 扩展（5 工具） | `ctx.subagents` + `subagent` 工具（`dsh-subagent`） | ⚠️ 内置插件拉平（pi 扩展已装；dsh 插件存在但默认未启用） |
| 工具白名单 | `toolgate` 扩展 `setActiveTools` | scoped 工具注册 + approval policy | ✅ 各自 policy（契约层不驱动，壳只观察） |
| 上下文占用 | `context-probe` 扩展实测 | 原生 context usage | ✅ 已拉平（dsh 原生更省一步） |
| bash / 文件工具 | 内置四工具（read/write/edit/bash） | `bash` / `fs-local` 插件 | ✅ 已对齐（各自内核的工具，壳不直接驱动） |
| **多路并发** | `steer` / `followUp` / `abortRetry` / `setSteeringMode` | 无对应 | 🔻 **拉不平** → dsh 侧写 cordis 插件补，或壳降级（见 §4.4） |
| **思考档位** | `thinkingLevel`（get/set/cycle） | `reasoningEffort` | 🔻 概念不同不硬拉平，各自保留（壳按内核分开展示） |
| **会话总线 $bus** | `bus` 扩展 | 无对应 | 🔻 拉不平 → dsh 侧写 cordis 插件补，或降级 |
| **扩展 UI** | `onExtensionUI` / `replyExtensionUI` | 无对应 | 🔻 拉不平 → 降级（dsh 下扩展 UI 入口不出现） |
| todo / plan 事件 | 无 | `todo/write`、`plan/mode` | ✅ 中性域无对应，壳不消费则丢（`dsh-event-translator` 已丢） |
| 图片输入 | 支持 | 未接线（attachment 缺面） | ⚠️ 内置插件补面（dsh 侧补 attachment 插件） |

- 说明：🔻 标「拉不平」的，正是本文 §4「内置插件拉平」要处理的；⚠️ 标「插件存在但未默认启用」的，是「补面」的最小成本路径——不写新插件，只启用现成插件。

## 4. 内置插件拉平的具体策略

### 4.1 原则：补面下沉到内核，适配器只翻译

- 判断一个差异该「翻译」还是「补面」，只问一句：内核有没有「同一个语义、只是形状不同」的对应物。有 → 适配器翻译；没有 → 内核补面（内置插件）；补不了 → 降级。这条把 `base-interface-lineage.md` §4.9 的边界往前推了一步：补面的**实现载体**从适配器换成内核插件。

### 4.2 pi 缺的 → 写 pi TS 扩展

- 现状 pi 侧补面已经成套（`client/pi/*-installer.ts`），新增能力照此模式：写一个扩展 + 一个 installer，installer 负责「装进 `~/.pi/agent/extensions/` + 对账」。例如将来 dsh 有而 pi 没有的能力，就补一个 pi 扩展。

### 4.3 dsh 缺的 → 写 / 启用 cordis 插件

- dsh 的能力组织是 Cordis 插件树（`multi-kernel-shell.md` §2.3）。补面 = 往 `cordis.yml` 加一个 `@deepseek-ai/dsh-*` 插件（`DshConfigSource.addPlugin`）。最小成本是**启用现成插件**：`dsh-subagent`、`dsh-compaction-basic` 等包已存在（`dsh-config-source.ts` 的 `PLUGIN_ID_MAP` 里有映射），但 `DEFAULT_CORDIS_YAML` 默认没启用——拉平 = 默认组合里启用它们。没有现成插件的（如 `steer` 多路并发、`$bus` 会话总线），才写新 cordis 插件。

### 4.4 补不了的 → 显式降级

- 写了/启用了插件还拉不平的，或补面成本远超收益的，在壳里**显式降级**：该能力入口在当前内核下不出现（或置灰 + tooltip 说明），不静默、不伪造成功（`base-interface-lineage.md` §4.7）。典型：`steer`/`followUp` 在 dsh 下、`onExtensionUI` 在 dsh 下。

## 5. 基类 + 继承的类层次

### 5.1 现状：接口 + 两个平行实现

- 现在是 `BaseBackend`（`core/domain/backend.ts`，接口）+ `PiBackend` / `DshBackend`（`client/pi` / `client/dsh`，各自 `implements`）。两个实现里，缺面能力的「不支持」语义各写一份（dsh 的 `deleteBookmark`/`seed` 抛「未接线」，将来 pi 若也有缺面还要再写一份），且「契约 → 默认行为」没有单一落点。

### 5.2 改进：`AbstractBackend` 抽象基类

- 在接口和具体类之间插一层抽象基类，承载「契约骨架 + 缺面默认」，子类只 override 内核差异。基类只依赖 `core/domain`（契约 + 中性类型），不 import 传输/协议——它属于内核层，放 `client/backend/abstract-backend.ts`（或 `client/backend.ts`），被 `PiBackend` / `DshBackend` 继承。

```
core/domain/backend.ts         BaseBackend（接口，契约）
        ▲ implements
client/backend/abstract-backend.ts   AbstractBackend（抽象基类：骨架 + 缺面默认）
        ▲ extends
client/pi/pi-backend.ts        PiBackend（override：pi 的能力）
client/dsh/dsh-backend.ts      DshBackend（继承缺面默认 + override dsh 能力）
```

```ts
// client/backend/abstract-backend.ts（示意）
export abstract class AbstractBackend implements BaseBackend {
  // —— 内核差异：子类必实现 ——
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

  // —— 缺面默认：子类 override 提供实现，否则统一「显式不支持」——
  deleteBookmark(_anchor: Anchor): Promise<void> {
    throw new Error(`${this.kernel} 后端 deleteBookmark 未接线`);
  }
  seed(_history: NeutralMessage[]): Promise<string> {
    throw new Error(`${this.kernel} 后端 seed 未接线`);
  }
}
```

- `PiBackend` `extends AbstractBackend`，override `deleteBookmark`（移除 JSONL 副本）与 `seed`（物化 `NeutralMessage[]` 为 JSONL 文件）——它本来就有实现，只是从「平行实现」变成「覆盖基类默认」。`DshBackend` `extends AbstractBackend`，不 override `deleteBookmark`/`seed`，继承基类的「未接线」默认，删掉自己那两份重复的抛错。

### 5.3 基类还能收什么（诚实边界）

- 不能夸大「基类复用」。pi 和 dsh 在会话模型 / 事件形状 / fork 语义上处处相反，`start`/`stop`/`onEvent`/`fork`/`getTree` 这些**不能共享**，仍是 abstract。基类的真实收益只有两条：

1. **缺面语义单源**：所有「未接线」能力默认抛 `` `${kernel} 后端 X 未接线` ``，不再每后端各写一份，加新缺面能力只加基类一处。
2. **契约骨架单一落点**：`BaseBackend` 的每个方法在基类里有一个明确归属（abstract 或默认实现），新内核接入 = 继承基类 + 补 abstract，漏实现由编译器报错。

- 若将来出现「第三个内核也共享的编排」（如「fork 前校验 boundary 是否落在完整回合之后」这种契约级守卫），可以再往基类加 protected 模板方法——但今天不预支，等真有第二个共享点再收。

### 5.4 与「拉平」的关系

- 基类解决的是**实现复用**（怎么少写重复），拉平解决的是**能力对齐**（怎么让壳无感）。两者正交：基类不产生新能力，内置插件才产生新能力。文档把两者分开写，避免「抽了基类就以为拉平了」的错觉。

## 6. 演进路线

- **阶段 A（基类落地，低风险）**：抽 `AbstractBackend`，`PiBackend`/`DshBackend` 改继承，删 dsh 的两份重复抛错。验收：typecheck + 既有 403 测试 + build 全绿，行为零变化。
- **阶段 B（启用现成 cordis 插件拉平）**：`DEFAULT_CORDIS_YAML` 默认启用 `dsh-subagent`、`dsh-compaction-basic`，把「子代理 / 压缩」在 dsh 下拉平到 pi 同级。验收：dsh 会话能跑子代理、能压缩。
- **阶段 C（补面 `steer` / `$bus`，视需求）**：给 dsh 写 `dsh-steer`（多路并发）或 `dsh-bus`（会话总线）cordis 插件，拉平 pi 的专属能力；拉不平的（`onExtensionUI`、思考档位）走显式降级。验收：壳插件在 dsh 下不出现 pi 专属入口、不静默失败。
- **阶段 D（`PiBackendExtensions` / `DshConfigApi` 接口收尾）**：把 `session-store` 的 `import type { PiBackend }` 换成只 import `PiBackendExtensions` 接口，`MainContext.dshConfigSource` 换成 `DshConfigApi` 接口（`kernel-layer.md` §7 的剩余演进项）。

## 7. 验收

- **拉平**：能力差异矩阵里每条「🔻」都有明确去向（内置插件或降级），没有「既没补面也没降级」的静默缺面。
- **基类**：`deleteBookmark`/`seed` 的「不支持」抛错只在 `AbstractBackend` 出现一处；`PiBackend`/`DshBackend` 无重复的缺面抛错。
- **依赖方向**：`AbstractBackend` 只 import `core/domain`；`core/application` 仍只依赖 `BaseBackend` / `BackendFactory` 接口，不 import 基类（基类是内核层实现细节）。
- **回归**：pi / dsh 两端既有集成测试全绿，壳插件代码零改动。
