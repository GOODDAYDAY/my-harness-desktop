// 内核插件注册表(§kernel-plugin) —— 运行时内核清单,替代 KERNEL_IDS 字面量数组。
//
// 依据 docs/design/kernel-plugin.md §3/§5。核心机制:壳只认这份注册表,不认任何具体内核。
// 每个内核插件在 bootstrap 装配点 register 自己,核心经 get/all 查。加第四个内核 = 写插件 + register。
// 编译期 Record<KernelId> 强制力在阶段五去字面量化后消失,用启动期完整性校验(validate)兜底。

import type { KernelPlugin, KernelId } from "@my-harness-desktop/shared";

/** 注册表条目：插件 + 它的版本。
 *
 * 为什么要记 version：`reloadKernelPlugins` 的差量判据是 **(id, version)**，不是 id
 * （boot-surface.md §3.6.2）。只比 id 集合的后果是——用户改了一个内核插件的代码或 manifest
 * 后点重载，它落在"两边都有 → 不动"分支，工厂不重跑，**改动完全不生效**；这与壳插件侧的
 * `reloadPlugin`（deactivate → rediscover → activate，会重读 manifest）不对称。
 * 而 version 今天只存在于扫描侧的 `KernelPluginEntry`，`KernelPlugin` 与注册表都没有 version 面，
 * 所以"与当前 registry 对比"取不到旧值——把条目存进注册表是唯一能取到旧版本的地方。 */
export interface KernelRegistryEntry {
  plugin: KernelPlugin;
  version: string;
}

/** 内核插件注册表。 */
export class KernelRegistry {
  private readonly entries = new Map<KernelId, KernelRegistryEntry>();

  /** 注册一个内核插件。重复 id 报错(防装配点手滑重复注册);缺必需适配器 fail-fast(§5)。
   *  `version` 来自内核插件 manifest 顶层（差量重载的判据之一），唯一调用点
   *  `loadKernelPlugin` 手上正好有 `entry.version`。 */
  register(plugin: KernelPlugin, version: string): void {
    if (this.entries.has(plugin.id)) {
      throw new Error(`内核插件重复注册: ${plugin.id}`);
    }
    validateKernelPlugin(plugin);
    this.entries.set(plugin.id, { plugin, version });
  }

  /** 按 id 查插件;未注册返回 undefined(调用方显式降级,不静默)。 */
  get(id: KernelId): KernelPlugin | undefined {
    return this.entries.get(id)?.plugin;
  }

  /** 按 id 查**注册时的版本**;未注册返回 undefined。差量重载靠它取"旧值"。 */
  versionOf(id: KernelId): string | undefined {
    return this.entries.get(id)?.version;
  }

  has(id: KernelId): boolean {
    return this.entries.has(id);
  }

  /** 撤销一个内核插件。**不存在时 no-op**（幂等，与 `PluginRegistry.unregister`
   *  `application/loader/registry.ts:166` 同语义）——`Map.delete` 天然幂等。
   *  ⚠ 撤销注册表条目**不 stop 已在跑的进程**：会话进程由 `SessionStore` 持有，
   *  卸载内核不等于杀会话（boot-surface.md §3.6.2 的"id 消失"分支）。 */
  unregister(id: KernelId): void {
    this.entries.delete(id);
  }

  /** 全部已注册插件(运行时内核清单,替代 KERNEL_IDS)。签名不变，既有消费者零改动。 */
  all(): KernelPlugin[] {
    return [...this.entries.values()].map((e) => e.plugin);
  }

  /** 全部内核 id。 */
  ids(): KernelId[] {
    return [...this.entries.keys()];
  }
}

/** 启动期完整性校验(§kernel-plugin §5):每个内核插件的适配器集合必须完整,缺了 fail-fast,
 *  不静默降级(编译期漏补报错没了,运行时补)。 */
export function validateKernelPlugin(plugin: KernelPlugin): void {
  if (!plugin.id) {
    throw new Error("内核插件缺 id");
  }
  if (!plugin.logo) {
    throw new Error(`内核插件 ${plugin.id} 缺 logo`);
  }
  const required = [
    "createBackend",
    "createCatalog",
    "createModelSource",
    "createModelsApi",
    "createConfigApi",
    "createExtensionSource",
    "createVersionApi",
  ] as const;
  const missing = required.filter((k) => typeof (plugin as unknown as Record<string, unknown>)[k] !== "function");
  if (missing.length > 0) {
    throw new Error(`内核插件 ${plugin.id} 缺适配器: ${missing.join(", ")}`);
  }
}
