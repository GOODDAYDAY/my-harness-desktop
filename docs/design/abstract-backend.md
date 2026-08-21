# AbstractBackend:契约骨架 + 缺面默认（abstract / pi / dsh 同级别）

> 依据 `kernel-layer.md` §9.4（继承 + 实现的三段式）。本文把「计划中」的 `AbstractBackend`
> 落成具体设计：abstract / pi / dsh 三个同级别的后端，一条一条对应实现。

## 1. 目标

`BaseBackend` 是契约（接口），`PiBackend` / `DshBackend` 是两个平行实现。两个实现各自的
「会话模型、事件形状、fork 语义」处处相反，那些差异不能共享；只有「可缺面能力的默认行为」
才收进基类。基类解决**实现复用 + 编译期强制全量意图**，不产生新能力（§9.4 边界）。

## 2. 继承结构（三列同级别）

```
core/domain/backend.ts              BaseBackend（接口，契约）
        ▲ implements
client/backend/abstract-backend.ts  AbstractBackend（抽象骨架 + 缺面默认）
        ▲ extends           ▲ extends
client/pi/pi-backend.ts            client/dsh/dsh-backend.ts
PiBackend（override pi 的能力）    DshBackend（override dsh 的能力）
```

三列同级别：`AbstractBackend` 是「机制」（契约骨架 + 缺面默认），`PiBackend` / `DshBackend`
是「内容」（各自内核的翻译）。三者同处后端这一层，谁都不是谁的特权。

## 3. 路径三层模型

「路径」按拥有者分三层，依赖只向内，内核专属路径不进契约：

| 层 | 位置 | 字段 | 谁用 |
|---|---|---|---|
| **中性契约层** | `core/domain/backend.ts` `BackendCreateOptions` | `cwd`、`kernel`、`sessionId?`、`provider?`、`model?`、`systemPromptPaths?`、`systemPromptTexts?`、`ephemeral?`、`maxTokens?`、`agentDir`（⚠ 见 §6） | 壳必须向每个内核索要 |
| **内核专属 spawn 层** | `bootstrap/kernel/kernel-factories.ts` 工厂闭包 | `cliPath`（pi）、`cliPath`/`cordisConfig`/`env`（dsh） | 不进契约，工厂捕获 |
| **后端内部上下文层** | 本文新增 | `BackendContext`（中性基）+ 子类扩展 | 后端对象构造后持有 |

**后端内部上下文层**（本文落地的部分）——与类继承同构的路径继承：

```
client/backend/abstract-backend.ts
BackendContext（中性）
  ├─ cwd: string           [pi ✅] [dsh ✅]
  └─ sessionId?: string    [pi 走 spawn --session] [dsh ✅]
        ▲
client/pi/pi-backend.ts
PiBackendContext extends BackendContext
  └─ agentDir: string      [pi 会话根 ~/.pi/agent]
        ▲
client/dsh/dsh-backend.ts
DshBackendConfig extends BackendContext
  ├─ provider: string      [initialize 握手]
  ├─ model: string         [initialize 握手]
  ├─ maxTokens?: number    [initialize 握手]
  └─ tempDir?: string      [ephemeral 清理]
```

基类用 `AbstractBackend<C extends BackendContext>` 泛型持有 `protected readonly ctx: C`，
子类 `this.ctx` 即自己扩展后的上下文，不用各自再存一份。

## 4. 方法一一对应表（17 条意图）

| # | `BaseBackend` 方法 | `AbstractBackend` | `PiBackend` | `DshBackend` |
|---|---|---|---|---|
| 1 | `kernel` | abstract | `= "pi"` | `= "dsh"` |
| 2 | `alive` | abstract | `adapter.alive` | `transport.alive` |
| 3 | `start` | abstract | `adapter.start()` | transport.start + initialize 握手（带 10s 重试） |
| 4 | `stop` | abstract | `adapter.stop()` | transport.stop + 清 tempDir |
| 5 | `onEvent` | abstract | `translateEvent` → 中性 | `translateDshEvent` → 中性 |
| 6 | `sendMessage` | abstract | `buildPromptCommand`（+ streamingBehavior 专属） | `session/prompt` |
| 7 | `abort` | abstract | `buildAbortCommand`（+ 超时） | `session/abort` |
| 8 | `setModel` | abstract | `buildSetModelCommand` | `session/setModel` |
| 9 | `fork` | abstract | `buildForkCommand` + resync 拿新文件 | `session/fork`（自带前缀拷贝） |
| 10 | `getTree` | abstract | `piReadSessionTree`（记 sessionFile） | `session/getTree` |
| 11 | `getEntries` | abstract | `piReadSessionEntries` | `session/getEntries` |
| 12 | `bookmark` | abstract | 纯回 `{ lineageId, entryId }` | `session/bookmark` + 回坐标 |
| 13 | `resume` | abstract | **throw**（走 session-store forkFromSession） | `session/resume` |
| 14 | `deleteBookmark` | abstract | **no-op** | `session/deleteBookmark` |
| 15 | `seed` | abstract | 写 JSONL + parentId 树 | `session/seed` |
| 16 | `listTools?` | **缺面默认 → `null`** | 继承 | 继承 |
| 17 | `answerQuestion?` | **缺面默认 → throw** | 继承 | 继承 |

**结论**：15 条必实现意图在基类全部 `abstract`，子类逐条 override；2 条可缺面意图在基类给
缺面默认（`listTools` 回 `null` = 壳走降级，`answerQuestion` 抛错 = 不静默吞）。基类不 import
任何具体内核，只依赖圆心契约 + 中性类型。

## 5. 三条纪律（§9.4）

1. **基类只 import `core/domain`，绝不 import 具体内核**——`AbstractBackend` 是机制（契约骨架
   + 缺面默认），不是内容。
2. **子类只填差异**：数据（上下文扩展）+ override abstract 方法。pi/dsh 的 `resume`/`fork`/
   `seed` 语义处处相反，保持 abstract，不为「看起来能复用」硬塞基类。
3. **组装归 bootstrap**：`createPiBackend` / `createDshBackend` 仍在 `bootstrap/kernel`，
   core 一行不 import 具体实现。

## 6. 决策与已知缺口

- **`agentDir` 是 pi 泄漏**：`BackendCreateOptions.agentDir` 名义中性、实际 dsh 工厂忽略它
  （dsh 会话根是 `DSH_SESSION_ROOT` env）。这是「pi 特权漏进契约」的气味。终态应下沉到
  `PiFactoryOptions`（pi 专属 spawn 层），从 `BackendCreateOptions` 移除。**本次不动**
  ——那会连带 `session-store` / `bootstrap` / 测试，是独立清理。
- **`noImplicitOverride` 未开**：当前 tsconfig 没开，子类 override 不强制标注。建议后续开启，
  让「BaseBackend 改名/增删方法」能被编译器逼着同步子类。
- **`listTools` / `answerQuestion` 尚无调用方**：缺面默认先落好，等能力探测（capability seam）
  消费时直接可用。
