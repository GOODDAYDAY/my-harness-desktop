// 内核插件注册表(§kernel-plugin) —— 运行时内核清单,替代 KERNEL_IDS 字面量数组。
//
// 依据 docs/design/kernel-plugin.md §3/§5。核心机制:壳只认这份注册表,不认任何具体内核。
// 每个内核插件在 bootstrap 装配点 register 自己,核心经 get/all 查。加第四个内核 = 写插件 + register。
// 编译期 Record<KernelId> 强制力在阶段五去字面量化后消失,用启动期完整性校验(validate)兜底。

import type { KernelPlugin, KernelId } from "@my-harness-desktop/shared";

/** 内核插件注册表。 */
export class KernelRegistry {
  private readonly plugins = new Map<KernelId, KernelPlugin>();

  /** 注册一个内核插件。重复 id 报错(防装配点手滑重复注册);缺必需适配器 fail-fast(§5)。 */
  register(plugin: KernelPlugin): void {
    if (this.plugins.has(plugin.id)) {
      throw new Error(`内核插件重复注册: ${plugin.id}`);
    }
    validateKernelPlugin(plugin);
    this.plugins.set(plugin.id, plugin);
  }

  /** 按 id 查插件;未注册返回 undefined(调用方显式降级,不静默)。 */
  get(id: KernelId): KernelPlugin | undefined {
    return this.plugins.get(id);
  }

  has(id: KernelId): boolean {
    return this.plugins.has(id);
  }

  /** 全部已注册插件(运行时内核清单,替代 KERNEL_IDS)。 */
  all(): KernelPlugin[] {
    return [...this.plugins.values()];
  }

  /** 全部内核 id。 */
  ids(): KernelId[] {
    return [...this.plugins.keys()];
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
