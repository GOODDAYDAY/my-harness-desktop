# seed wire 对齐：一套壳中立协议 → pi/dsh 各自转录

> 本文是 `kernel-forkless-branch.md`（seed 改单线签名）与 `dsh-capability-gate.md`（能力门槛）之后的
> **收口篇**：把「壳的中立 session 协议」与「pi / dsh 两个内核的 session 存储 / wire 协议」三方摆在一起
> 逐字段对比，指出并修复 dsh 侧 seed 的 wire 形状错位，并给出可执行的测试策略。

## 1. 一句话结论

壳的中立 session 协议（`NeutralSession` 树 + `NeutralEntry[]` 线性）对 pi / dsh 是**同一份**；
pi 和 dsh 各自把它转录成自己的内核形态（pi=JSONL 文件、dsh=`session/seed` 树）。此前 dsh 侧这一转录是
**坏的**——`DshBackend.seed` 把线性 `NeutralEntry[]` 原样当 `session` 参数发，而 dsh 运行时 `session/seed`
要的是 `NeutralSessionWire` 树。修复后两边吃同一中立输入、各投各的形态。

## 2. 三方 session 协议对照

| 层 | 形状 | 落盘/传输 | 关键字段 |
|---|---|---|---|
| **desktop 中立层** | `NeutralSession` **树** `{ neutralSessionId, header, lineages: [{ lineageId, fork, entries: [{ neutralEntryId, kernelEntryId?, message, display? }] }] }` | `NeutralSessionStore` 写 `<dir>/<neutralSessionId>.json` | `NeutralMessage = { role, content?, timestamp?, id?, error?, ... }`（宽松透传） |
| **pi 内核** | **JSONL 文件**（头行 + message 行，`parentId` 连树） | `<agentDir>/sessions/<cwd桶>/<lineageId>.jsonl` | 头行 `{ type:"session", cwd, "custom-my-harness-desktop" }`；message 行 `{ type:"message", id, parentId, message:{role, content, toolName?, toolCallId?, usage?, ...} }`；另有 `session_info` / `model_change` / `branch_summary` |
| **dsh 内核** | `NeutralSessionWire` **树**（wire 类型注释明写 mirrors desktop `NeutralSession`）+ `SessionEvent` 追加事件流 | SQLite（`session-persistence-sqlite`，事件 zstd 压缩，`session.jsonl.zstd`） | `NeutralMessageWire = { id?, role, content, toolCallId?, toolName?, error?, ... }`；`session/seed` 的 `session` 参数是 `NeutralSessionWire` |

要点：**desktop 的中立树（`NeutralSession`）与 dsh 的 wire 树（`NeutralSessionWire`）几乎逐字段镜像**——
`neutralSessionId` / `lineages[].lineageId` / `lineages[].fork` / `entries[].neutralEntryId` / `entries[].message`
两边同名同形。这正是「换内核 = 换投影实现，中立层一行不动」的落点。pi 则完全不同：它把树拍平成 JSONL 文件，
`parentId` 链替代 fork 关系（单线执行器）。

## 3. seed wire 错位（已修复）

`kernel-forkless-branch.md §21` 把壳的 seed 契约拍平成**单线签名**：

```ts
// packages/shared/src/domain/backend.ts
seed(lineage: NeutralEntry[], opts: SeedOptions): Promise<string>;  // 单条 lineage 线性内容
```

但 dsh 运行时 `session/seed` 仍要**树**（deepseek-harness `packages/sdk/server/src/server.ts`）：

```ts
seed(params: SessionSeedParams) {
  const root = session.lineages[0]   // session 必须是 NeutralSessionWire 树
  const rootEvents = entriesToSeedEvents(root.entries, ...)
}
```

修复前 `DshBackend.seed` 发 `session: lineage`（裸线性数组）→ dsh 运行时读 `session.lineages[0]` 得
`undefined` → TypeError。修复：新增纯函数 `buildDshSeedSession(lineage, opts)`，把线性 lineage 重新包回
「单 lineage 树」（`fork: null`，条目剥离 `display`），`DshBackend.seed` 改发这棵树。pi 侧 `piSeedSession`
本就把线性 lineage 写 JSONL，自洽不需改。

```ts
// src/server/kernel/dsh/backend/dsh-backend.ts
export function buildDshSeedSession(lineage: NeutralEntry[], opts: SeedOptions): NeutralSession {
  return {
    neutralSessionId: opts.neutralSessionId,
    header: opts.header,
    lineages: [{
      lineageId: opts.lineageId,
      fork: null,
      entries: lineage.map(({ neutralEntryId, kernelEntryId, message }) => ({
        neutralEntryId, ...(kernelEntryId !== undefined ? { kernelEntryId } : {}), message,
      })),
    }],
  };
}
```

这正对应 dsh 运行时自己的 `server.spec.ts` 对 `session/seed` 的期望形状（`{ sessionId, session: { neutralSessionId, lineages: [...] } }`），
两边现已对齐。

## 4. 测试策略

| 层 | 文件 | 覆盖 |
|---|---|---|
| **unit** | `src/server/kernel/dsh/backend/dsh-backend.test.ts` | `buildDshSeedSession` 包回树、剥离 `display`；`seed` 发树非裸数组、成功后重绑 `sessionId` |
| **契约一致性** | `src/server/kernel/seed-transcription.test.ts` | 同一份 `NeutralEntry[]` → pi 出 JSONL（头行+parentId 链+role/content/tool 保真）、dsh 出树（单 lineage+display 剥离），两边都不 mutate 中立输入 |
| **e2e（真机，`DSH_RUNTIME_E2E=1`）** | `src/server/kernel/dsh/backend/dsh-backend.integration.test.ts` | 起真实 dsh 二进制 → `seed` 灌一条 lineage → `getEntries` 回放同角色序列；缺 `session/seed` 时按能力门槛显式跳过，不伪造成功 |
| **DOM 交互** | `scripts/e2e-inmem.mjs` | 真实 assemble + 真实 renderer bundle（jsdom）+ 真实 DOM 交互（composer 输入/发送/切页签/设置面板/草稿恢复）；seed 转录是发送链路的地基，由上面 unit/契约/真机三层直接验形状 |

## 5. 已知不对称（诚实标注，非本修复范围）

- **dsh `entriesToSeedEvents` 跳过 `toolResult`**：dsh 运行时的 seed 只重建 user/assistant 回合，
  tool-loop 重建是 deepseek-harness 侧 follow-up（`entriesToSeedEvents` 注释明写）。pi 的 `piSeedSession`
  则保留 `toolResult`。这不是壳的转录差异，是 dsh 运行时的能力边界。
- **dsh 运行时版本门槛**：`session/seed` 依赖 deepseek-harness master（commit `818e24e` 起），npm 发布的
  `0.1.1-rc.2` 尚无此方法。`DshBackend` 已做懒探测，缺面时报清晰错误并上报降级（`dsh-capability-gate.md`）。
