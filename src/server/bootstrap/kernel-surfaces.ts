// 内核面组装 —— 把 KernelRegistry 展开成壳需要的全部中性面（组装根的唯一一段"内核数学"）。
//
// 为什么单独成文件（两个理由，都不是"为了整齐"）：
//
// ① **「加第四个内核零改动」这句话要可验证**。此前这十几处 `registry.all().map(...)`
//    散在 assemble.ts 的 700 行里，想证明"第 4 个内核会被自动接上"只能靠人把文件读一遍。
//    收成纯函数之后，一条测试就能拿「3 个真实内核 + 1 个临时造的第四个」直接把这句话跑一遍
//    （`fourth-kernel.test.ts`）——**声明变成证据**。
//
// ② 组装根该薄。assemble 的职责是"怎么拼"（接线、注入、起服务），不是"内核面怎么长出来"。
//    这一层是 `KernelPlugin` → 壳所需各面的**投影**，与任何具体内核无关（本文件零内核名）。
//
// 依赖方向：只依赖圆心契约 + 注册表，不 import 任何具体内核、不 import electron/react。

import { ModelCatalog } from "../application/models/model-catalog";
import type { KernelAccessors } from "./boot/kernel-accessors";
import type { KernelRegistry } from "../kernel/core/kernel-registry";
import type {
  KernelConfigApi,
  KernelExtensionSource,
  KernelId,
  KernelLogo,
  KernelModelSource,
  KernelModelsApi,
  KernelModelsRegistry,
  KernelPlugin,
  KernelVersionApi,
  SkillProvider,
} from "@my-harness-desktop/shared";

/** 插件扩展同步面的形状（= KernelPlugin.createPluginExtensionSync 的返回，非空）。 */
export type KernelPluginExtensionSync = NonNullable<ReturnType<NonNullable<KernelPlugin["createPluginExtensionSync"]>>>;

/** 壳插件生命周期钩子的形状（= KernelPlugin.createLifecycle 的返回，非空）。 */
export type KernelLifecycle = NonNullable<ReturnType<NonNullable<KernelPlugin["createLifecycle"]>>>;

/** 一次问内核能力面（pi 有、dsh/minimal 无 → undefined）。 */
export type KernelOneshot = (prompt: string, cwd?: string) => Promise<string>;

/** 壳从注册表投影出来的全部内核面。字段名按"壳拿它干什么"取，不按内核取。 */
export interface KernelSurfaces {
  /** 内核插件本身（顺序 = 注册顺序 = 设置页/清单里的展示顺序）。**不是"默认内核"**：
   *  注册顺序只决定展示次序，壳不拿它当任何兜底（见下面 `ids` 的注释）。 */
  plugins: KernelPlugin[];
  /** 已注册内核 id 清单（替代曾经的 KERNEL_IDS 字面量数组）。顺序 = 注册顺序。
   *
   *  **这里没有、也不会有"默认内核"**（设计原则 22 / `docs/design/kernel-follows-model.md`）：
   *  内核身份是**模型的派生量**——用户选哪个模型就进哪个内核，选的时候内核即已知；
   *  "谁排第一谁当默认"这种兜底会让"信息缺失的缝隙"被静默填成某个内核（历史上是 pi）。
   *  缺内核的地方一律**显式报错或显式降级**，绝不从这里挑一个顶上。 */
  ids: KernelId[];
  /** 模型清单合流（ModelCatalog 只依赖 KernelModelSource 接口）。 */
  modelCatalog: ModelCatalog;
  /** 技能提供者（SkillAggregator 聚合它们，不读内核存储）。 */
  skillProviders: SkillProvider[];
  /** 带内置 skills 挂/摘面的内核插件（通常只有 pi 一个）。 */
  skillsPlugins: KernelPlugin[];
  /** 生命周期钩子（壳插件启停时逐个问）。**带内核归属**——否则多个内核都交了钩子时，
   *  出问题（某个内核的钩子抛错）只能报一个匿名失败，点不到内核。 */
  lifecycles: { kernel: KernelId; hook: KernelLifecycle }[];
  /** 插件携带内核扩展的同步面（按内核 id 派发；加第四个内核自动纳入）。 */
  extensionSyncs: { kernel: KernelId; sync: KernelPluginExtensionSync }[];
  /** 各内核会话文件根（总线路径圈禁用）。 */
  sessionRoots: string[];
  /** 各内核技能清单文件（改它们 = 技能清单变了，壳据此重挂监视器）。 */
  skillWatchPaths: (cwd: string) => string[];
  // ⚠ 这里**不再有** `modelsApis` / `configApis` / `versionApis` / `oneshots` /
  //   `extensionSources` / `logos` / `configRoots` 七个 per-id 投影字段（阶段三删除）。
  //   两个理由：① 它们的消费者已全部改走 `boot/kernel-accessors.ts` 的**活访问器**
  //   （函数形状，调用时现读注册表），留在这里就是**同一份投影的两个来源**（§1.3 契约单源），
  //   必然漂移；② 它们是**急切实例化**——`byId((p) => p.createModelsApi())` 在 boot 时对
  //   每个内核调每个工厂，而访问器是惰性 + memo 的（只在真被用到时才造，且保持实例稳定）。
  //   logo 的 last-known 语义（卸载后仍在跑的会话不丢图标）也只能在访问器里实现，
  //   快照字段做不到。
}

/**
 * 把注册表投影成壳的全部内核面。
 *
 * **本函数里不许出现任何内核名**：它循环的是注册表。加第四个内核 = 加一个插件目录，
 * 本文件与调用方零改动——这正是它单独成文件的原因（可被测试直接证明）。
 */
export function buildKernelSurfaces(registry: KernelRegistry, accessors: KernelAccessors): KernelSurfaces {
  const plugins = registry.all();
  const ids = plugins.map((p) => p.id);
  const byId = <T>(make: (p: KernelPlugin) => T): Record<KernelId, T> =>
    Object.fromEntries(plugins.map((p) => [p.id, make(p)])) as Record<KernelId, T>;

  return {
    plugins,
    ids,
    // ⚠ getter 里读的是 **accessors**（活访问器），不是本函数局部捕获的 `plugins` 数组——
    //   后者只是"构造这一刻"的快照：重载会整体替换 surfaces、造出新的 ModelCatalog，
    //   但 `MainContext.modelCatalog` 仍指向**旧实例**，于是旧实例里的 getter 若捕获局部数组，
    //   永远只看到旧内核（延迟求值 ≠ 活）。走 accessors 才能每次现读注册表，
    //   且 accessors 的 memo 保证 source 实例稳定（pi/minimal 的 createModelSource 每次 new 包装器）。
    modelCatalog: new ModelCatalog(() =>
      accessors
        .kernelIds()
        .map((id) => accessors.kernelModelSource(id))
        .filter((s): s is KernelModelSource => !!s),
    ),
    skillProviders: plugins.map((p) => p.createSkillProvider?.()).filter((s): s is SkillProvider => !!s),
    skillsPlugins: plugins.filter((p) => p.ensureSkills),
    lifecycles: plugins
      .map((p) => ({ kernel: p.id, hook: p.createLifecycle?.() }))
      .filter((e): e is { kernel: KernelId; hook: KernelLifecycle } => !!e.hook),
    extensionSyncs: plugins
      .map((p) => ({ kernel: p.id, sync: p.createPluginExtensionSync?.() }))
      .filter((e): e is { kernel: KernelId; sync: KernelPluginExtensionSync } => !!e.sync),
    sessionRoots: plugins.map((p) => p.sessionRoot?.()).filter((r): r is string => !!r),
    skillWatchPaths: (cwd) => plugins.flatMap((p) => p.skillWatchPaths?.(cwd) ?? []),
  };
}

/**
 * 内核**自己的历史遗留状态**一次性迁移（如 dsh 的 prefs 明文 apiKey → 凭证库）。
 * 注册表驱动逐个问；单个内核迁移失败不阻断启动，但**要留痕**（点名到 stderr）。
 * 实现方必须幂等（每次启动都会调）。返回失败的内核 id 便于测试断言"坏内核不拖垮别的"。
 */
export function runKernelStartupMigrations(registry: KernelRegistry): KernelId[] {
  const failed: KernelId[] = [];
  for (const p of registry.all()) {
    try {
      p.migrateLegacyState?.();
    } catch (e) {
      failed.push(p.id);
      console.warn(`[kernel-migration] 内核 ${p.id} 的历史状态迁移失败(不阻断启动):`, e instanceof Error ? e.message : e);
    }
  }
  return failed;
}

/**
 * 内置技能的挂/摘：**逐个内核都要挂**（不是"取第一个"）。
 *
 * 为什么单独成函数并在这里：`ensureSkills` 是可选面，此前 assemble 写的是
 * `skillsPlugins[0]?.ensureSkills?.(enabled)` —— 取**第一个**支持该面的内核。
 * 当时只有一个实现（pi），所以看不出问题；但形状与刚修掉的技能开关路由是同一个
 * （"第一个赢、其余静默忽略"），加第二个支持内置技能的内核时，它的内置技能会被
 * **静默地不挂也不摘**：用户点了开关，一半内核生效、一半没生效，且没有任何提示。
 *
 * 语义：**全部都要成功**才算 changed（有一个变了就该广播刷新）；单个内核抛错**点名留痕**
 * 且不阻断其余内核（一个坏内核不该让其它内核的技能挂不上）。
 * 返回"是否有任一内核真的改了东西"，供壳决定要不要广播设置变更。
 */
export async function ensureBundledSkillsOnAll(surfaces: KernelSurfaces, enabled: boolean): Promise<boolean> {
  let changed = false;
  for (const p of surfaces.skillsPlugins) {
    try {
      if (await p.ensureSkills?.(enabled)) changed = true;
    } catch (e) {
      console.error(`[skills] 内核 ${p.id} 的内置技能${enabled ? "挂载" : "摘除"}失败:`, e instanceof Error ? e.message : e);
    }
  }
  return changed;
}

/** 内置技能的旧命名迁移：同样**逐个内核都要跑**（理由见上）。 */
export async function migrateSkillsOnAll(surfaces: KernelSurfaces): Promise<boolean> {
  let changed = false;
  for (const p of surfaces.skillsPlugins) {
    try {
      if (await p.migrateSkills?.()) changed = true;
    } catch (e) {
      console.error(`[skills] 内核 ${p.id} 的技能旧命名迁移失败:`, e instanceof Error ? e.message : e);
    }
  }
  return changed;
}

/**
 * 插件携带**内核扩展**的挂/摘派发器（壳的生命周期钩子接它）。
 * 按 manifest.extensions 的内核 id 找对应内核的同步实现；找不到时**显式降级 + 留痕**——
 * 不静默，否则表现为"扩展装了、内核就是看不见"，是最难查的一类。
 */
export function makeExtensionDispatch(surfaces: KernelSurfaces): {
  onActivate(kernel: KernelId, pluginId: string, pluginPath: string, extensionDir: string): void;
  onDeactivate(kernel: KernelId, pluginId: string): void;
} {
  return {
    onActivate(kernel, pluginId, pluginPath, extensionDir) {
      const target = surfaces.extensionSyncs.find((e) => e.kernel === kernel);
      if (!target) {
        console.warn(`[plugin-extension] 插件 ${pluginId} 声明了内核 "${kernel}" 的扩展，但该内核没有扩展同步面（未装载？），已跳过`);
        return;
      }
      target.sync.onActivate(pluginId, pluginPath, extensionDir);
    },
    onDeactivate(kernel, pluginId) {
      surfaces.extensionSyncs.find((e) => e.kernel === kernel)?.sync.onDeactivate(pluginId);
    },
  };
}
