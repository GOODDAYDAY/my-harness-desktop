// 启动面（boot surface）的操作侧机制 —— 内层（application）。
//
// 依据 docs/design/boot-surface.md §2.4.2 / §3.3 / §5.1.1。本文件是「冷启动与暖启动共用同一份
// 启动面实现」的落点：操作表 + 单一驱动器 `runOps` 住在这里，于是
//   · 冷启动步骤（`bootstrap/boot/steps/75-plugin-boot.ts`）值 import 本文件；
//   · 暖启动触发者（同目录 `index.ts` 的 `activate` / `deactivate`）同层 import 本文件。
// 两侧共用同一张表、同一个驱动器，所以留痕格式与失败语义只有一份（消除 §1.2.1 的两份实现）。
//
// **为什么类型住内层而不是 `bootstrap/`**：`BootContext` 是组装根的类型（`bootstrap/boot/types.ts`）。
// 若 `BootOp` 也住那里，本文件就要 import `bootstrap` —— 那是外层，反向依赖，
// 分层论证会在它自己的文件布局下不闭合。所以 `BootOp.run` 吃**泛型 deps**，不认识 `BootContext`。
//
// **为什么 `BootOp` 没有 `failure` 字段**（与设计文档 §2.4.2 第一版的偏离，依据是文档自己的
// §2.2.1）：文档曾给它一个单值字段 `failure: "degrade"`，理由是"让留痕格式可被守卫检查"——
// 但 §6.2.2 那条守卫扫的是**步骤源码文本**，不读这个字段；而"实体级失败一律降级"是 `runOps`
// 的**不变量**，不是每个操作可选的策略（选择权在步骤级：`BootStep.failure` 有 fatal/degrade/
// background 三个取值且被 `runColdBoot` 真读）。单值 + 零读者 = §2.2.1 定义的死字段，
// "为将来可能需要 fatal 而保留"则是 `contributions.ts:536-541` 警告的假泛化。故删。
import type { KernelId, PluginManifest } from "@my-harness-desktop/shared";
import type { DiscoveredPlugin } from "../loader/discover";

// ============ 驱动机制（与实体种类无关） ============

/** 启动时机。冷启动 = 进程起来跑一遍完整步骤表；暖启动 = 运行期对**单个实体**装/卸启动面。 */
export type BootPhase = "cold" | "warm";

/**
 * 一个启动面操作：把「一个实体」的某类资源装进壳/内核，或从中摘除。
 *
 * `E` = 实体类型（`PluginEntity` / `KernelPlugin`），`D` = 该表所需的依赖形状
 * （`PluginBootDeps` / `KernelBootDeps`）。泛型化是为了让本文件不认识 `BootContext`（见文件头）。
 */
export interface BootOp<E, D> {
  /** **全表范围内唯一**：内核侧用 `kernel-` 前缀，插件挂侧用 `attach-`、摘侧用 `detach-`。
   *  前缀化的真实作用是**留痕可区分**（`[boot-op:attach-plugin-skills]` vs
   *  `[boot-op:detach-plugin-skills]`）；守卫按**表**对账（§6.1.3），不按裸 id。
   *  运行期没有"按 id 查询操作"这条路径——id 只用于留痕与守卫。 */
  id: string;
  /** 作用的实体种类。决定冷启动由哪个步骤遍历、暖启动由哪个触发者调用。 */
  entity: "plugin" | "kernel";
  /** 时机声明。每个取值都要有真实读者：冷启动按 `includes("cold")` 过滤，
   *  暖启动按 `includes("warm")` 过滤。声明 warm 却无暖路径调用 → 守卫报错（§6.1.3）。 */
  phases: BootPhase[];
  run(entity: E, deps: D): Promise<void> | void;
}

/**
 * 唯一的操作驱动器。冷启动步骤与暖启动触发者都经它，故**留痕格式与失败语义只有一份**。
 *
 * 三件事：① 按 `phases` 过滤；② 逐实体 try/catch（一个实体失败不阻断其余实体）；
 * ③ 留痕点名到**操作 id + 实体 id**（不是匿名下标——`kernel-surfaces.ts:141` 已确立的纪律）。
 *
 * 返回 `Promise<void>`：操作的结果不回传（需要回传的数据经 `deps` 里的收集器引用 mutate，
 * 见 `KernelBootDeps.extensionActiveIds`），因为"每实体一个返回值"没有统一消费方，
 * 而扭曲驱动器签名去服务单一消费方不划算（§5.4.3 对偏好变更路径的同一判断）。
 */
export async function runOps<E, D>(
  ops: readonly BootOp<E, D>[],
  phase: BootPhase,
  entities: Iterable<E>,
  deps: D,
  nameOf: (e: E) => string,
): Promise<void> {
  for (const op of ops) {
    if (!op.phases.includes(phase)) continue;
    for (const e of entities) {
      try {
        await op.run(e, deps);
      } catch (err) {
        console.error(
          `[boot-op:${op.id}] ${nameOf(e)} 失败（已降级，不阻断其余实体）:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }
}

// ============ 插件侧的依赖与实体 ============

/** 插件来源（四级优先级：builtin < installed < user < project）。 */
export type PluginSource = DiscoveredPlugin["source"];

/**
 * 技能挂摘面。**逐内核遍历与点名住在这份实现里**，不在操作里——
 * 操作只调一次 `onActivate`，实现内部遍历各内核的生命周期钩子并逐内核 try/catch。
 *
 * 为什么这样分：冷启动今天已经在 catch 里点名到内核（`assemble.ts:494-495`），而暖启动走的
 * 闭包**没有 try/catch、不点名内核**（`assemble.ts:303-316`），一个内核的钩子抛错会冒泡到
 * `activate` 的 catch、被记成"插件激活失败"并撤注册。合一之后冷暖两侧走同一份带点名与隔离的
 * 实现，这处漂移随之消失（§1.2.1 第 2 行）。
 */
export interface SkillsEnsure {
  onActivate(pluginId: string, pluginPath: string, source: PluginSource): Promise<void>;
  onDeactivate(pluginId: string, pluginPath: string, source: PluginSource): Promise<void>;
}

/**
 * 插件携带**内核扩展**的挂摘面（`manifest.extensions` 声明才触发）。
 *
 * 按内核 id 派发，不是一个内核一个字段：实现自己知道"哪个 id 归我"，其余 id 显式忽略
 * （不静默吞——见装配点 `makeExtensionDispatch` 的 warn）。实现在各内核插件里，
 * application 只持接口。加第四个内核：圆心与本层零改动。
 */
export interface PluginExtensionEnsure {
  onActivate(kernel: KernelId, pluginId: string, pluginPath: string, extensionDir: string): void;
  onDeactivate(kernel: KernelId, pluginId: string): void;
}

/** 插件侧操作表的依赖形状。由组装根的 `50-wiring` 步骤构造，冷暖两侧共用同一份内容。 */
export interface PluginBootDeps {
  skillsEnsure?: SkillsEnsure;
  pluginExtensionEnsure?: PluginExtensionEnsure;
}

/**
 * 一个插件实体。由 manifest + 路径 + 来源**直接构造**，不需反查注册表
 * （暖启动的 `activate` 手上正好有这三样；冷启动从 `registry.allPlugins()` 取）。
 */
export interface PluginEntity {
  id: string;
  manifest: PluginManifest;
  path: string;
  source: PluginSource;
}

// ============ 插件侧的两张表 ============

/**
 * 挂载侧。**冷启动与暖启动共用这一张表**：冷启动由 `75-plugin-boot` 步骤遍历全部已注册插件，
 * 暖启动由 `lifecycle.activate` 对单个插件调用。
 *
 * `id` 带 `attach-` 前缀是为了与摘除侧区分——留痕里 `[boot-op:plugin-skills]` 无法分辨
 * 是挂失败还是摘失败（设计文档第一版的缺陷）。
 */
export const PLUGIN_ATTACH_OPS: BootOp<PluginEntity, PluginBootDeps>[] = [
  {
    id: "attach-plugin-skills",
    entity: "plugin",
    phases: ["cold", "warm"],
    async run(p, deps) {
      // 逐内核遍历与点名在 skillsEnsure 的实现里（见 SkillsEnsure 的文档），操作只调一次。
      await deps.skillsEnsure?.onActivate(p.id, p.path, p.source);
    },
  },
  {
    id: "attach-plugin-extensions",
    entity: "plugin",
    phases: ["cold", "warm"],
    run(p, deps) {
      // 传**原始插件目录 + 相对路径**，由内核侧实现自己 join。这个形状是 `assemble.ts:514-516`
      // 记录的历史 bug（路径双重拼接导致扩展永远同步不上）修出来的，合一之后只有一处实现，
      // 因此只可能错一次、也只可能修一次。
      for (const [kernel, dir] of Object.entries(p.manifest.extensions ?? {})) {
        deps.pluginExtensionEnsure?.onActivate(kernel, p.id, p.path, dir);
      }
    },
  },
];

/**
 * 摘除侧。两个操作都是 `["warm"]`——冷启动时**禁用插件根本不注册**（§5.1.2），
 * 所以没有"启动时要摘"的情形；摘除只发生在运行期的 disable/uninstall/reload。
 */
export const PLUGIN_DETACH_OPS: BootOp<PluginEntity, PluginBootDeps>[] = [
  {
    id: "detach-plugin-skills",
    entity: "plugin",
    phases: ["warm"],
    async run(p, deps) {
      await deps.skillsEnsure?.onDeactivate(p.id, p.path, p.source);
    },
  },
  {
    id: "detach-plugin-extensions",
    entity: "plugin",
    phases: ["warm"],
    run(p, deps) {
      for (const kernel of Object.keys(p.manifest.extensions ?? {})) {
        deps.pluginExtensionEnsure?.onDeactivate(kernel as KernelId, p.id);
      }
    },
  },
];

/** 从注册表条目构造插件实体（冷启动步骤用；暖启动直接用手上的 manifest/path/source）。 */
export function toPluginEntity(entry: { manifest: PluginManifest; path: string; source: PluginSource }): PluginEntity {
  return { id: entry.manifest.id, manifest: entry.manifest, path: entry.path, source: entry.source };
}
