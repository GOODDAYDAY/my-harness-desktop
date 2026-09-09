// minimal 扩展源 —— KernelExtensionSource(设置页「内核拓展」TAB)。
//
// 依据 docs/design/minimal-kernel.md §6 / §7.9。minimal 的插件系统是可拆分的独立模块,
// 但第一版尚未落地(§6 是设计,不随 MVP 首批实现),所以扩展管理面是诚实桩:空清单 +
// 不支持装/卸,能力缝 update/reorder 均 false。壳据此置灰入口,不伪造扩展列表。

import type { KernelExtensionSource, KernelExtensionInfo, KernelExtensionMutationResult, KernelExtensionCapabilities } from "@my-harness-desktop/shared";

/** minimal 的扩展源:第一版空清单 + 不支持装/卸(诚实降级)。 */
export class MinimalExtensionSource implements KernelExtensionSource {
  readonly capabilities: KernelExtensionCapabilities = { update: false, reorder: false };

  list(): KernelExtensionInfo[] {
    return [];
  }

  enable(_id: string): Promise<void> {
    return Promise.resolve();
  }

  disable(_id: string): Promise<void> {
    return Promise.resolve();
  }

  install(_source: string, _onProgress: (line: string) => void): Promise<KernelExtensionMutationResult> {
    return Promise.resolve({ ok: false, error: "minimal 内核插件系统第一版未落地,不支持安装拓展" });
  }

  uninstall(_id: string, _onProgress: (line: string) => void): Promise<KernelExtensionMutationResult> {
    return Promise.resolve({ ok: false, error: "minimal 内核插件系统第一版未落地,不支持卸载拓展" });
  }
}
