// probe4 原生配置面 —— KernelConfigApi(设置页「内核配置」TAB)。
//
// 依据 docs/design/minimal-kernel.md §7.9 / §7.9.3。
//
// 字段清单为空是**诚实降级**：probe4 第一版没有需要表单编辑的原生配置
// (不像 pi 的 settings.json / dsh 的 settings.yaml)，设置页据此不渲染任何字段——
// 这是显式降级，不是伪造。
//
// 但**存储是真的**：get/set 落到 probe4 自己的 config.json（原子写），set 返回的是
// 回读后的盘上真值。此前 set 直接 `return obj` 回显入参、什么都没落盘——那是伪造成功：
// 调用方（框架的 save 链）会以为自己保存成功，用户下次打开发现配置没了。

import { Probe4ConfigSource } from "./probe4-config-source";
import type { KernelConfigApi, KernelConfigField } from "@my-harness-desktop/shared";

/** probe4 的原生配置 API:空字段清单（不渲染表单）+ 真落盘存储。 */
export class Probe4ConfigApi implements KernelConfigApi {
  constructor(private readonly source: Probe4ConfigSource) {}

  get(): Promise<Record<string, unknown>> {
    return Promise.resolve(this.source.readConfig());
  }

  /** 写配置并**回读**（返回盘上的真值，不是入参的回显）。 */
  set(obj: Record<string, unknown>): Promise<Record<string, unknown>> {
    return Promise.resolve(this.source.writeConfig(obj));
  }

  /** 无内置字段：设置页不渲染任何字段（空清单 = 显式降级，不是「忘了填」）。 */
  fields(): Promise<KernelConfigField[]> {
    return Promise.resolve([]);
  }
}
