# 内核层（kernel layer）：PI 与 DSH 的洋葱分层

- `multi-kernel-shell.md` 立了「内核 / 中立契约 / 适配器 / 壳」四个抽象，`base-interface-lineage.md` 落了 `BaseBackend` 五操作与 lineage 树。本文是那两份的**分层收口篇**：把 pi 和 dsh 物理收进洋葱架构里同一层（内核层），这一层与其他层只经接口交互——依赖倒置，内层拥有抽象，外层提供实现。目标不是再立新概念，是把已有的抽象**摆对层、清掉泄漏**。

## 1. 洋葱分层

```
┌────────────────────────────────────────────────────────────┐
│ bootstrap/  (组装根 · 最外)                                  │
│   kernel/      内核注册表：把接口和实现绑起来                    │
│                （createPiBackend / createDshBackend 的组装）    │
├────────────────────────────────────────────────────────────┤
│ client/  (流出适配器 · 内核层 = PI + DSH)                     │
│   pi/          PiBackend(实现 BaseBackend) + rpc-adapter +     │
│                subprocess-lifecycle + 各扩展安装器              │
│   dsh/         DshBackend(实现 BaseBackend) + json-rpc +       │
│                dsh-config-source + subprocess-lifecycle        │
├────────────────────────────────────────────────────────────┤
│ core/application/  (用例编排 · 中层)                          │
│   sessions/session-store.ts   只依赖 domain 的 BaseBackend +   │
│                                BackendFactory 接口             │
│   models/model-catalog.ts     只依赖 KernelModelSource 接口    │
│   kernel/kernel-manager.ts    KernelSpec 已参数化              │
├────────────────────────────────────────────────────────────┤
│ core/domain/  (圆心 · 零依赖)                                 │
│   kernel.ts    KernelId / KERNEL_IDS（内核身份单源）            │
│   backend.ts   BaseBackend / BackendFactory /                  │
│                BackendCreateOptions / LineageTree / Anchor      │
│   events/session-state.ts  ModelInfo(kernel: KernelId)         │
└────────────────────────────────────────────────────────────┘
```

依赖方向只向内：`bootstrap → client → core/application → core/domain`。跨层协作靠依赖倒置——`core/domain` 拥有 `BaseBackend` / `BackendFactory` / `KernelModelSource` 接口，`client` 实现它们，`bootstrap` 组装绑定。内层永远不 import 外层。

## 2. 圆心契约（接口清单）

### 2.1 内核身份单源 `core/domain/kernel.ts`

```ts
/** 内核标识。加第三个内核 = 这里加一个字面量，编译器逼补全所有 switch(kernel)。 */
export type KernelId = "pi" | "dsh";
export const KERNEL_IDS = ["pi", "dsh"] as const;
```

`KernelId` 是圆心原子，零依赖。`ModelInfo.kernel`、`switchKernel(target)`、`BaseBackend.kernel` 全部引用它，不再各处写 `"pi" | "dsh"` 字面量。

### 2.2 后端契约 `core/domain/backend.ts`

```ts
export interface BaseBackend {
  readonly kernel: KernelId;          // 新增：内核身份跟着实现走，不散在 SessionProc
  readonly alive: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  onEvent(cb): () => void;
  fork(...): Promise<string>;
  getTree(...): Promise<LineageTree>;
  getEntries(...): Promise<NeutralMessage[]>;
  bookmark(...): Promise<Anchor>;
  resume(...): Promise<string>;
  deleteBookmark(...): Promise<void>;
  sendMessage(...): Promise<void>;
  abort(): Promise<void>;
  setModel(...): Promise<void>;
  seed(...): Promise<string>;
}

/** 中性：创建内核后端所需的全部入参。不含任何内核专属 spawn 参数。 */
export interface BackendCreateOptions {
  cwd: string;
  agentDir: string;
  kernel: KernelId;
  /** 模型偏好（六条意图 setModel 的中性输入；pi 走 setModel 命令、dsh 走 initialize 握手）。 */
  provider?: string;
  model?: string;
}

/** 后端工厂：中性契约，产出 BaseBackend。实现归 client，组装归 bootstrap。 */
export interface BackendFactory {
  create(opts: BackendCreateOptions): BaseBackend;
}
```

### 2.3 模型源契约 `core/application/models/model-catalog.ts`（消费侧拥有）

```ts
/** 内核模型源：模型清单（带 kernel 标）。pi=ModelsStore，dsh=DshConfigSource。 */
export interface KernelModelSource {
  listModels(): ModelInfo[];
}
```

`ModelCatalog` 持 `KernelModelSource[]` 或两个 `KernelModelSource`（pi/dsh），不 import `DshConfigSource` 具体类。

## 3. 现状泄漏清单（对照）

| # | 泄漏 | 现状位置 | 处置 |
|---|---|---|---|
| L1 | `"pi" \| "dsh"` 字面量散落 60+ 处 | session-store / sessions.ts / session-state.ts / context-binding / bootstrap | 收敛为 `KernelId` |
| L2 | core→client 依赖反转（适配器 import 传输具体类） | `core/application/sessions/pi-backend.ts` → `client/pi/rpc-adapter`；`dsh-backend.ts` → `client/dsh/json-rpc` | 适配器下沉 `client/pi` `client/dsh` |
| L3 | 组装职责错位到 application | `core/application/sessions/backend-factories.ts` import `client/pi`+`client/dsh` 具体类做 spawn | 工厂下沉 bootstrap |
| L4 | 工厂契约泄漏内核专属参数 | `session-store.ts` 的 `BaseBackendFactory.create` opts 含 `args/env/cliPath/cordisConfig/provider/model/maxTokens` | 换成中性 `BackendCreateOptions`，专属参数由工厂闭包捕获 |
| L5 | 模型清单依赖具体类 | `model-catalog.ts` / `main-context.ts` import `DshConfigSource` | 依赖 `KernelModelSource` 接口 |
| L6 | pi 专属能力经 `instanceof PiBackend` 散落 20+ 处 | `session-store.ts` 的 `asPi` / `getAdapter(): PiBackend` | 能力接口（渐进，见 §5 阶段 4） |

## 4. 迁移路径

迁移顺序从内往外、每阶段编译 + 测试全绿，不出现「新契约 + 新分层一起炸」。

### 阶段 1：圆心契约（纯增量）
- 新增 `core/domain/kernel.ts`（`KernelId` / `KERNEL_IDS`）。
- `BaseBackend` 加 `readonly kernel: KernelId`；新增 `BackendCreateOptions` / `BackendFactory`。
- `ModelInfo.kernel`、`sessions.ts` 的 `switchKernel` 改用 `KernelId`。
- `PiBackend` / `DshBackend` 实现 `kernel` 属性。
- `packages/contract/src/index.ts` re-export 新契约。

### 阶段 2：模型源接口化
- `model-catalog.ts` 定义 `KernelModelSource` 接口，`ModelCatalog` 依赖接口而非 `DshConfigSource`。
- `DshConfigSource` `implements KernelModelSource`；`MainContext.dshConfigSource` 换接口类型。

### 阶段 3：适配器 / 工厂下沉（消除 core→client）
- `PiBackend` → `client/pi/pi-backend.ts`；`DshBackend` → `client/dsh/dsh-backend.ts`。
- `backend-factories.ts` → `bootstrap/kernel/kernel-factories.ts`（组装归 bootstrap）。
- `session-store.ts` 改用圆心 `BackendFactory`（中性 opts），删除本地 `BaseBackendFactory`。
- 依赖方向 grep：`core` 目录 `import .../client/` 归零（除 type-only 契约外，实际目标归零）。

### 阶段 4：内核身份收敛 + 能力接口替代 instanceof（渐进）
- `asPi` / `getAdapter(): PiBackend` 换成可选能力接口（如 `backend.capabilities.pi`），「有则用、无则降级」，不再 instanceof 具体类。

## 5. 验收标准

- **依赖方向**：`src/core/` 无任何 `import ... client/`；`src/core/domain/` 零 import。
- **契约单源**：全仓 `"pi" | "dsh"` 字面量只出现在 `core/domain/kernel.ts` 一处。
- **换内核 = 换适配器**：`session-store.ts` 不感知 pi/dsh 具体类，只认 `BaseBackend` + `BackendFactory`。
- **单测**：`KernelId` / `BackendFactory` 中性契约有单测；model-catalog 合流测试改走 `KernelModelSource` 接口；pi/dsh 后端测试随文件下沉保持绿。
- **build**：`pnpm build` / `vitest run` 全绿。

## 6. 落地状态（已达成）

- ✅ **圆心契约**：`core/domain/kernel.ts`（`KernelId`/`KERNEL_IDS`）、`core/domain/backend.ts`（`BaseBackend.kernel`、`BackendCreateOptions`、`BackendFactory`、`KernelModelSource`、`projectLineageTree`）。`ModelInfo.kernel`、`sessions.ts` 的 `switchKernel` 均引用 `KernelId`。
- ✅ **物理下沉**：`PiBackend`→`client/pi/pi-backend.ts`、`DshBackend`→`client/dsh/dsh-backend.ts`、`dsh-event-translator`→`client/dsh/`、工厂→`bootstrap/kernel/kernel-factories.ts`。
- ✅ **依赖方向**：core 生产代码值 import client 归零；`core/domain` 零外部包 import。
- ✅ **工厂契约中性化**：`session-store` 走圆心 `BackendFactory`（`BackendCreateOptions` 含 `sessionId`/`systemPromptPaths`/`systemPromptTexts`/`ephemeral`/`maxTokens`），不再拼 `--session`/`--append-system-prompt`/`--no-session`；cliPath/cordisConfig/apiKey 由 bootstrap 工厂闭包捕获。
- ✅ **模型源接口化**：`ModelCatalog` 持 `KernelModelSource[]`，`PiModelSource` + `DshConfigSource implements KernelModelSource`。
- ✅ **验证**：typecheck、vitest（403）、electron-vite build 全绿。

## 7. 剩余演进（诚实标注，不阻塞）

- **能力接口替代 type-only 类**：`session-store.ts` 的 `import type { PiBackend }` 是 type-only import 具体类（`asPi` 类型标注用），运行时零依赖但可进一步抽成 `PiBackendExtensions` 接口（放 `client/pi`），让 core 只 import 接口、不 import 类。属「依赖只向内」的加分项，非硬违规。
- **dsh 配置能力接口化**：`MainContext.dshConfigSource: DshConfigSource` 是 api→client 具体类依赖（外层依赖外层，非硬违规）。可抽 `DshConfigApi` 接口（含 listProviders/setProvider/addPlugin 等 15+ 方法 + dsh 专属返回类型）让 `DshConfigSource implements`。涉及面大，独立收尾。
- **`context-binding.ts` 写死 `kernel: "pi"`**：这是 pi 专属 RPC 映射（`Model → ModelInfo`），`kernel` 写死是正确语义（来源是 pi），标注即可。
- **会话标识中性化**：`DshBackend` 的 `sessionId` 仍退化为 `cwdToBucketName(cwd)`（每项目一会话），真正 session-id 化待 `base-interface-lineage.md` 的会话标识中性化收口。
