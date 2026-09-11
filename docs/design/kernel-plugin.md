# 内核插件化：注册模型重构

## 目标

把 pi / dsh / minimal 三个内核从「核心代码」抽离成「内核插件」，核心代码（圆心 + 壳机制 + web 机制）不出现任何具体内核名（pi/dsh/minimal）字面量。加第四个内核 = 写一个插件 + 注册，不改核心一行。

## 现状病灶（侦察结论）

> ⚠ **本节「现状病灶」已过期**：本文设计的**内核插件化已完整落地**——`src/server/kernel/` 下
> `pi/`、`dsh/`、`minimal/` 各带 `plugin.json`，`core/kernel-registry.ts` 提供 `KernelPlugin`/`KernelRegistry`/
> `scanKernelPlugins`。所以下面列的"病灶"是**改动前**的形态,勿当现状读（本节的侦察结论正是这次改动的输入）。

核心代码里内核字面量分布在 12 个文件，真「判别/路由/注册」集中在 5 处：

| 文件 | 病灶 | 层 |
|---|---|---|
| `domain/kernel.ts` | `KernelId = "pi"\|"dsh"\|"minimal"` + `KERNEL_IDS` | 圆心 |
| `bootstrap/assemble.ts` | 三分支 `if kernel==="pi"/"dsh"/"minimal"` | 壳 |
| `application/sessions/session-store.ts` | `kernel==="pi"` 判别、`capabilities.pi` 能力面 | 壳 |
| `web/kernel/build-kernel.ts` | `kernels:{pi,dsh,minimal}` / `kernelModels` / `kernelConfig` Record 展开 | web |
| `application/sessions/neutral-migration.ts` | 迁移里的内核判别 | 壳 |

其余（`contributions.ts`/`kernel-event.ts`/`sessions.ts`）是注释或示例字面量，属内容泄漏，一并清。

## 核心设计

### 1. KernelId 去字面量化

```ts
// 之前：字面量联合（圆心硬编码内核名）
export type KernelId = "pi" | "dsh" | "minimal";

// 之后：不透明字符串，内核 id 由内核插件声明
export type KernelId = string;
```

- 删 `KERNEL_IDS`（内核清单由注册表运行时提供）。
- `Record<KernelId, X>` 全部改 `Map<KernelId, X>` 或 `Record<string, X>`。
- **代价**：失去编译期「漏补内核报错」的强制力。
- **兜底**：启动期完整性校验（§5）+ 运行时注册表查（缺内核时显式降级，不静默）。

### 2. KernelPlugin 接口（圆心定义，插件实现）

圆心只认这一份抽象，不认任何内核实现：

```ts
export interface KernelPlugin {
  /** 内核 id（插件声明，核心不硬编码）。 */
  readonly id: KernelId;
  readonly logo: KernelLogo;
  /** 能力探测面（替代 capabilities.pi/dsh）：有则用、无则降级，能力名中性。 */
  createBackend(opts: BackendCreateOptions): BaseBackend;
  createCatalog(agentDir: string): SessionCatalog;
  createModelSource(...): KernelModelSource;
  createModelsApi(...): KernelModelsApi;
  createConfigApi(): KernelConfigApi;
  createExtensionSource(): KernelExtensionSource;
  createVersionApi(): KernelVersionApi;
  seed(lineage: NeutralEntry[], opts: SeedOptions): Promise<string | null>;
}
```

### 3. KernelRegistry（壳机制）

```ts
export class KernelRegistry {
  private plugins = new Map<KernelId, KernelPlugin>();
  register(p: KernelPlugin): void;          // 幂等，重复注册报错
  get(id: KernelId): KernelPlugin | undefined;
  all(): KernelPlugin[];                    // 运行时内核清单（替代 KERNEL_IDS）
  has(id: KernelId): boolean;
}
```

### 4. 装配入口（bootstrap，唯一能 import 具体内核插件的地方）

核心不 import 任何具体内核。唯一例外是 `bootstrap` 的「内核插件装配」文件：

```ts
// bootstrap/kernel-plugins.ts —— 唯一知道「有哪些内核插件」的装配点
import { piKernelPlugin } from "../kernel/pi/plugin";
import { dshKernelPlugin } from "../kernel/dsh/plugin";
import { minimalKernelPlugin } from "../kernel/minimal/plugin";

export function registerKernelPlugins(registry: KernelRegistry): void {
  registry.register(piKernelPlugin);
  registry.register(dshKernelPlugin);
  registry.register(minimalKernelPlugin);
}
```

加第四个内核 = 加一个插件目录 + 在这个文件加一行 `registry.register(...)`。**核心（圆心 + 壳机制 + web 机制）零改动**。

### 5. 启动期完整性校验

编译期 `Record<KernelId>` 强制力没了，用启动期校验兜底：

```ts
// 每个注册的内核，适配器集合必须完整，缺了启动即报错（fail-fast，不静默降级）
function validateKernel(plugin: KernelPlugin): void {
  const missing = ["createBackend","createCatalog","createModelSource",...]
    .filter((k) => !(k in plugin));
  if (missing.length) throw new Error(`内核插件 ${plugin.id} 缺适配器: ${missing.join(",")}`);
}
```

### 6. pi 扩展面中性化

`capabilities.pi` / `capabilities.dsh` 这个字眼也要从核心去掉。改为**能力探测面**（能力名中性，不带内核名）：

```ts
// 之前：capabilities: { pi?: BackendExtensions; dsh?: ThinkingCapabilities; fileBacked?: boolean }
// 之后：能力按语义分桶，壳经能力名探测，不按内核名
readonly capabilities: {
  steering?: SteeringCapabilities;   // steer/followUp/onExtensionUI 等（原 pi 扩展面）
  sessionRpc?: ThinkingCapabilities;      // 原 dsh 能力面
  fileBacked?: boolean;
};
```

`session-store` 里的 `if (kernel === "pi")` / `capabilities.pi` 判别，全改成「能力接口探测」（`backend.capabilities.steering` 有则用、无则降级）。

## 迁移步骤（分阶段，每阶段三级测试；顺序关键：先骨架后迁移，字面量最后删）

1. **阶段一 · 骨架（纯新增，零风险）**：`KernelPlugin` 接口（圆心）+ `KernelRegistry`（壳机制）+ 完整性校验。**不动 KernelId**（暂留字面量联合，避免全仓瞬时爆错）。
2. **阶段二 · minimal 先行**：把 minimal 内核抽成第一个插件（`kernel/minimal/plugin.ts` 暴露 `minimalKernelPlugin`），验证接口闭环。
3. **阶段三 · pi/dsh 迁移**：pi、dsh 各抽成插件（含 pi 扩展面中性化 `capabilities.steering`）。
4. **阶段四 · 核心改用注册表**：assemble 三分支 → 注册表查；session-store 判别 → 能力探测；build-kernel Record 展开 → 注册表遍历；neutral-migration 判别 → 注册表。
5. **阶段五 · KernelId 去字面量化（最后一步）**：此时核心已注册表化，改 `KernelId = string` 只是删字面量 + 修 `Record<KernelId>` → `Map`，错误量可控。
6. **阶段六 · N 内核测试**：单内核注册 / 任意双内核注册 / 三内核注册的适配性、可用性、鲁棒性。

## 关键权衡（明确告知）

- **丢编译期强制力**：`KernelId = string` 后，`Record<KernelId,X>` 的漏补报错消失。用「启动期完整性校验 + 运行时注册表查 + 显式降级」兜底。这是插件化架构（VSCode 扩展同理）的固有代价：**运行时注册换运行时校验**。
- **唯一允许内核名的地方**：`bootstrap/kernel-plugins.ts`（装配点）+ 各内核插件目录内部。圆心、壳机制、web 机制零内核字面量。

## 测试策略（对应目标第 12 点）

- **单内核注册**：只注册 minimal（或只 pi），壳照常启动，缺失内核的能力入口显式降级。
- **双内核注册**：任意两两组合（pi+minimal / dsh+minimal / pi+dsh）。
- **三内核注册**：全量。
- **鲁棒性**：注册缺面（缺 catalog / 缺 model source）→ 启动即报错；运行时查不存在的内核 id → 显式降级不崩。

## 实施落地（六阶段完成）

### 关键交付物

| 文件 | 作用 |
|---|---|
| `packages/shared/src/domain/kernel-plugin.ts` | `KernelPlugin` 接口 + `KernelPluginContext` + `KernelPluginFactory`（圆心抽象） |
| `src/server/kernel/core/kernel-registry.ts` | `KernelRegistry`（register/get/all/ids）+ `validateKernelPlugin`（启动期完整性校验） |
| `src/server/kernel/core/kernel-version.ts` | `wrapVersionApi`（KernelManager → KernelVersionApi 通用包装，pi/dsh 共用） |
| `src/server/kernel/{pi,dsh,minimal}/plugin.ts` | 三个内核插件工厂（各自聚合会话面 + 目录面 + 管理面五槽位） |
| `src/server/kernel/core/kernel-registry-n.test.ts` | N 内核注册验收（单/双/三内核 + 鲁棒性，真实工厂） |

### 核心去内核字面量的达成

- `KernelId = string`（不透明，内核 id 由插件声明）
- `KERNEL_IDS` 字面量数组**已删**（内核清单由 `KernelRegistry.all()` 运行时驱动，经 `IPC.kernel.list` → `window.kernel.kernelIds` 提供给前端）
- `capabilities.pi/dsh` → `extension/thinking/fileBacked`（能力语义命名，非内核名）
- assemble 三分支 / session-store 判别 / build-kernel Record 展开 → 全部注册表驱动
- reconcileMissingKernels / versionApi / modelSource / modelsApi / configApi / extensionSource → 全部从 registry 遍历

### 验证矩阵

typecheck 0 · **577 全量测试**（60 文件）· 5 e2e · build OK · 零 push

### 剩余演进项（非核心阻塞）

1. **pi/dsh 别名（文件类方法）**：`session-store.ts` 的 `catalogFor("pi")/("dsh")` 别名 getter + `createProc(...,"pi")` 硬编码 + `defaultKernelId` 迁移期默认 `"pi"`——pi 文件态/dsh RPC 的历史别名，应收敛为「文件态内核/RPC 内核」的能力语义（`capabilities.fileBacked` 探测），非内核名。
2. **pi/dsh 专属 IPC**（`dshModels`/`dshSettings`/`models`/`piSettings` + `llmOneshot`）：历史遗留的专属端点，与中性面 `kernelModels`/`kernelConfig` 功能重叠，属"内核专属能力插件化"范畴。
3. **`BackendExtensions` 语义拆分**：`capabilities.extensions`（原 pi 扩展面）内部仍有 steer/followUp/compact/bash/getThinkingLevels 等 20+ 方法，按语义拆 steering/thinking/compaction/bash 与 dsh 能力面统一是后续演进。

### 已清理的内核名判别（round 27-28）

- `build-kernel.ts` 的 `kernel === "pi"`（fitPiExtensionAvailable 条件挂载）→ `kernelVersion.fitPiExtensionAvailable(kernel)` 带参数能力探测。
- `controllers/kernel.ts` 的 `getFallbackModel` 的 `kernel: "dsh"/"pi" as const` → 遍历注册内核（`kernelIds`）找默认模型。

**审计结论：真正的"内核名判别"（`kernel === "pi"` / `"dsh" as const` / `asPi()`）已全部清零**，剩余 pi/dsh 字面量均为"资源命名/别名/装配点"的非判别残留。

## 物理插件（round 1-4 追加）

"代码级插件"（KernelPlugin 接口 + registry）之上，进一步落成"物理插件"——内核是独立目录 + manifest + 运行时动态加载，可插拔。

### 形态

```
src/server/kernel/{pi,dsh,minimal}/
  ├── plugin.json    ← manifest(id + factory + order)
  ├── plugin.ts      ← KernelPluginFactory(default 导出)
  └── backend/ manager/ model/ ...  ← 内核实现
```

- **加第四个内核** = 加一个目录 + 一个 `plugin.json`，核心和装配点**零改动**（动态扫描自动注册）。
- **卸载** = 删某内核的 `plugin.json` → 扫描不返回它 → 壳缺面降级、照常启动。

### 契约 + 加载器

- `KernelPluginManifest`（圆心）：`id` + `factory`（相对插件目录的工厂入口）+ `order`（注册顺序，越小越先 = 默认内核）。
- `KernelPluginModule`：`default` 导出工厂（回落 `${id}KernelPlugin` 命名导出）。
- `scanKernelPlugins(pluginRootDir)`：扫描有 `plugin.json` 的子目录，按 `order` 排序（纯函数，可单测）。
- `loadKernelPlugin(registry, dir, manifest, ctx)`：cjs 同步 `require` 工厂 → register。

### 构建接线

- rollup `main.input` 加三个 `plugin.ts` 额外入口 → 独立打包 `out/main/server/kernel/*/plugin.js`。
- `scripts/copy-kernel-manifests.mjs` + build 脚本：把 `plugin.json` 补齐到 out/。
- **关键坑**：assemble 被 rollup 拆进 `out/main/chunks/`（双入口共享），`import.meta.url` 是 chunk 路径 → 插件目录解析错误。改用 `process.cwd()` 定位（dev/build = 项目根/out/main/server/kernel/；packaged = resourcesPath/app.asar/...）。

### 卸载验收（第 13 点）

`minimal-uninstall.e2e.mjs`：删 minimal 的 manifest → 起 app → 内核清单不含 minimal + 模型下拉无 minimal TAB + 其余内核照常 + app 不崩。加载器单测（`kernel-plugin-loader.test.ts`）覆盖扫描/卸载/空目录/动态 require。

