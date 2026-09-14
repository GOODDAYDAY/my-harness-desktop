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
| `application/sessions/legacy-import.ts` | 旧会话导入（**已内核无关**：读各内核自报的 `readLegacySessions()`，壳只负责幂等落中立层） | 壳 |

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
4. **阶段四 · 核心改用注册表**（**已落地**）：assemble 三分支 → 注册表查；session-store 判别 → 能力探测；build-kernel Record 展开 → 注册表遍历；旧会话导入判别 → `readLegacySessions()` 内核自报。
   > 收口记录：`neutral-migration.ts` 已改名为 `application/sessions/legacy-import.ts`（壳侧只剩幂等落库），
   > 读 pi 老格式搬进 pi 插件（`kernel/pi/backend/pi-legacy-sessions.ts`）。于是
   > `scripts/dependency-audit.mjs` 的 `DOCUMENTED_EXCEPTIONS` **清空**——「application 不 import 内核实现」
   > 这条红线不再有任何明文例外。
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

### 形态（**已统一：一个内核 = 一个插件目录**）

内核面与它的 desktop 对接面同属**一个插件目录**、共用**一份** `plugin.json`：

```
src/plugins/kernels/<id>/
  ├── plugin.json          ← 唯一 manifest：壳插件字段 + `kernel` 块（内核面声明）
  ├── renderer/ locales/   ← desktop 对接面（内核的设置页、文案）
  └── （内核实现在 src/server/kernel/<id>/，其工厂编译到 out/main/server/kernel/<id>/plugin.js）
```

**内核实现在哪：仍住 `src/server/kernel/<id>/`（这是一次**考虑过并否决**的搬迁，理由在下面）**

插件目录与内核目录的分工是"声明 + 对接面"在插件、**内核本体**在 `src/server/kernel/<id>/`。
曾经打算把内核本体也搬进 `src/plugins/kernels/<id>/server/` 做到"字面一个目录"，评估后不做：

1. **职责边界不因搬家而变**。内核实现在洋葱里与 `client/fs`、`git`、`npm` 同一层——都是
   「被壳管理的外部资源」，都经依赖倒置接入。把它挪进内容层，会让 `src/plugins/` 里出现
   大量 node 重代码，并**必须放宽**「壳插件只 import shared+react」那条依赖审计（检验④）——
   为一次搬迁削弱一道守卫，方向是反的。
2. **"可卸载"已经成立且被验证**：删掉 `src/plugins/kernels/<id>/`（唯一 manifest）→
   内核不注册、它的设置页也不装载，其余内核照常（`kernel-plugin-uninstall.e2e.mjs` 17 断言）。
   留在原地的那些实现文件只是**变成死代码**，不影响任何行为。
3. **"加第四个内核零改动"也已成立且被验证**：`kernel-surfaces.test.ts` 用 3 真实 + 1 合成
   内核证明壳的每一面都从注册表投影（见下节）。搬家只省下"多建一个目录"，买不到上面两条。

若将来真要做，判据是：**它是否让某条守卫变弱**。不变弱才做。

`kernel` 块只写**内核面**要知道的事（`order` / `enabled` / 可选 `factory`），**不重复写 id**
（id 单源 = 宿主 manifest 的 `id`）。壳扫壳插件根目录时，凡 manifest 带 `kernel` 块者，
既是一个壳插件、也是一个内核插件。

- **加第四个内核** = 加**一个**插件目录（`kernel` 块 + `renderer/` + 一个 rollup 入口），核心与装配点零改动。
- **卸载** = 删这一个目录 → 内核**与它的设置页一起消失**，其余内核照常。
- **默认不装载** = `kernel.enabled: false` → 两面一起不装载（没有内核却显示它的设置页，只会得到一堆报错）。

#### 扫描根：随壳分发的内核 vs 测试专用内核

内核插件的扫描根与**壳插件**完全同源（同一份 `plugin.json`，同一套发现规则）：

| 根 | 位置 | 谁在这里 |
|---|---|---|
| 内置 | dev `src/plugins`；打包 `resources/my-harness-desktop-builtin` | pi、dsh（随壳分发，日常都在场） |
| 用户装 | `<数据根>/plugins` | 第三方内核插件；**测试用它种测试专用插件** |
| 装过的包 / 项目级 | `<数据根>/installed`、`<cwd>/.my-harness-desktop/plugins` | 第三方内核插件 |

**minimal 不在这张表的第一行**：它是**测试专用内核插件**，插件目录在 `test-plugins/kernels/minimal/`
（仓库根的新目录，**不在任何生产扫描根里**）。生产任何路径都发现不到它，所以日常使用里这个内核
**根本不存在** —— 这是"幽灵会话"的结构性根治：

> 历史事故：minimal 曾随壳分发 + `MHD_ENABLE_KERNELS=minimal` 运行时强制启用。任何人都能在**真实项目
> 里**起一个 minimal 会话（它自带 echo 桩模型，回一句就完事），那条会话的中立头记着 `kernel: minimal`；
> 之后 normal 启动（minimal 不装载）来列这个项目，这行就变成"内核不存在"的孤儿行。修完孤儿行的降级
> 行为之后，"造不出孤儿行"这一半靠**把插件移出生产面**完成。

怎么测它（不再是环境变量开关，而是**装上去**）：
`scripts/demo/lib/test-plugins.mjs` 的 `seedTestPlugins(dataRoot)` 把 `test-plugins/kernels/<id>/`
拷进隔离 HOME 的**用户插件目录**（第三方内核插件被装载的真实路径）。它的两个面各有来路：
内核面按**构建根约定**加载 `out/main/server/kernel/<id>/plugin.js`（与插件目录位置无关）；
设置页组件走 `src/web/app/plugins-host.ts` 里**构建期 chunk 表**（那张表的 glob 显式含 `test-plugins/**`）。
换句话说：**发现**（哪些插件在场）走扫描根，**渲染代码**（组件从哪来）走构建期打包——两件事分开，
测试专用插件才可能"只随测试在场、但两 face 都在"。

> **变更记录（勿按旧形状读）**：此前内核 manifest 单住在
> `src/server/kernel/<id>/plugin.json`，而 desktop 对接面是**另一个壳插件**
> （`src/plugins/manager/<id>-manager/`）。两份 manifest、两个目录、两次生命周期：
> 删掉内核插件后设置页还在（点进去全是报错），"卸载 = 删一个插件"这句话就不成立。
> 统一后 id 也归位（`pi-manager` → `pi`），插件 id 与内核 id 同源。

### 契约 + 加载器

- `KernelPluginManifest`（圆心）：`id` + `factory`（相对插件目录的工厂入口）+ `order`（注册顺序，越小越先；**只决定清单/展示次序，不是「默认内核」**——内核是模型的派生量，缺内核处显式报错，设计原则 22）。
- `KernelPluginModule`：`default` 导出工厂（回落 `${id}KernelPlugin` 命名导出）。
- `scanKernelPlugins(pluginRootDir)`：扫描有 `plugin.json` 的子目录，按 `order` 排序（纯函数，可单测）。
- `loadKernelPlugin(registry, dir, manifest, ctx)`：cjs 同步 `require` 工厂 → register。

### 构建接线

**两个面各有来路，别混**（这是"测试专用插件也能有设置页"的关键）：

| 面 | 来路 | 与插件目录的关系 |
|---|---|---|
| 内核面 | 构建根约定 `out/main/server/kernel/<id>/plugin.js`（rollup 独立入口） | **无关**——插件目录在哪都能加载 |
| 对接面（设置页组件） | `src/web/app/plugins-host.ts` 的**构建期 glob 表**（`src/plugins/**` + `test-plugins/**`） | 由**构建**决定，与运行时发现根无关 |

推论一：**没有编译产物的插件要按"没有 renderer"处理**。main 侧 `plugins:list` 只在
`<plugin>/renderer/index.js` **真的存在**时才交缺省 renderer 入口（`rendererEntryFor`，`controllers/plugins.ts`）——
否则 renderer 侧会去 `import(file://不存在)` 失败，把插件记成 error 并**把 app 拖进错误态**
（实测：种上 renderer 只在 chunk 里的内核插件后，composer 直接起不来）。显式声明 `manifest.renderer` 的照旧原样交
（缺文件是作者的错，要响亮失败）。
推论二：同一 id **不能既走 chunk 又走磁盘 import** —— `plugins-host` 的第三方分支带 `!builtinPathById.has(id)`，
构建期固化那份优先。

- rollup `main.input` 加三个 `plugin.ts` 额外入口 → 独立打包 `out/main/server/kernel/*/plugin.js`。
- `scripts/copy-kernel-manifests.mjs` + build 脚本：把 `plugin.json` 补齐到 out/。
- **关键坑**：assemble 被 rollup 拆进 `out/main/chunks/`（双入口共享），`import.meta.url` 是 chunk 路径 → 插件目录解析错误。改用 `process.cwd()` 定位（dev/build = 项目根/out/main/server/kernel/；packaged = resourcesPath/app.asar/...）。

### 卸载验收（第 13 点）

`kernel-plugin-uninstall.e2e.mjs`（18 断言）：**不种插件**（= 生产日常态）内核清单不含 minimal **且设置页没有 Minimal 入口** → **种进隔离 HOME 的用户插件目录**后**两面一起出现**（内核清单 + 设置页导航锚点 `[data-settings-id]`，DOM 面复核）→ 删这一个插件的 `plugin.json` 后**两面一起消失**、pi/dsh 照常、app 不崩。全程只动隔离 HOME 里的副本，**不碰仓库源码树**（旧版改的是 `src/plugins` 下的 manifest 再恢复）。
加载器单测（`kernel-plugin-loader.test.ts`）覆盖扫描/普通壳插件不误收/id 单源/卸载/坏 JSON/根目录不存在/工厂路径约定；N 内核注册矩阵（`kernel-registry-n.test.ts`）覆盖单内核 ×3、双内核 ×3、三内核、卸载 ×3，全部跑在**真实插件目录 + 真实编译产物**上。

### 内核之间零 import（可卸载性的物理前提）

「删掉某内核的 manifest，壳照常启动」这句要真的成立，光靠加载器不抛异常是不够的——
**只要 A 内核 import 了 B 内核的任何一个文件，删掉 B 就让 A 编译不过**，"能卸载"当场变成假的。

实测踩过：`SubprocessHandle`（三个内核的 transport / rpc-adapter 共用的子进程句柄契约，
文档里写明是"依赖倒置接口"）当时放在 `src/server/kernel/pi/backend/subprocess-handle.ts`，
于是 dsh 与 minimal 都写 `import type { SubprocessHandle } from "../../pi/backend/subprocess-handle"`——
**pi 从"三个内核之一"变成了"另外两个的编译期依赖"**，删 pi 即 dsh/minimal 崩。
这同时违反「内核无特权差异」：共享机制寄生在其中一个内核的目录里，就是那一个内核的特权。

修法：共享机制归机制层。`SubprocessHandle`/`ProcessExit` 已移到 `src/server/kernel/core/subprocess-handle.ts`，
三个内核各自的 `subprocess-lifecycle` 只实现它、消费方只依赖它，内核之间零 import。

**守卫**：`scripts/dependency-audit.mjs` 检验 ⑧（内核互引审计）——扫描 `src/server/kernel/<k>/` 下每个文件的
import，解析相对路径到绝对路径后判定落点，凡落在**另一个内核目录**即报错。目录被整个删掉时该内核无文件可扫，
自然跳过（卸载态不误报）。这条是"结构"检验而非"注意一下"：谁再把共享类型塞进某个内核目录并让别处引用，当场红。

