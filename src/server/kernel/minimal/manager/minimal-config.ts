// minimal 原生配置面 —— KernelConfigApi(设置页「内核配置」TAB)。
//
// 依据 docs/design/minimal-kernel.md §7.9。minimal 第一版没有需要编辑的原生配置
// (不像 pi 的 settings.json / dsh 的 settings.yaml),所以是诚实桩:空字段清单 + 空配置,
// 设置页据此不渲染任何字段,而不是伪造几个假字段。

import type { KernelConfigApi, KernelConfigField } from "@my-harness-desktop/shared";

/** minimal 的原生配置 API:第一版空字段、空配置(显式降级,不伪造)。 */
export class MinimalConfigApi implements KernelConfigApi {
  get(): Promise<Record<string, unknown>> {
    return Promise.resolve({});
  }

  set(obj: Record<string, unknown>): Promise<Record<string, unknown>> {
    return Promise.resolve(obj);
  }

  fields(): Promise<KernelConfigField[]> {
    return Promise.resolve([]);
  }
}
