// model-catalog —— 合流 pi/dsh 两路模型清单(设计 §3.3 + kernel-layer.md §2.3)。
//
// 这是「扫模型」的机制层(所有内核共用),从 timeline 插件的 toModelInfos 上收到 core/application。
// 圆心契约:本层只依赖 KernelModelSource 接口(domain/backend),不 import client 具体类——
// pi 路是 client/pi 的 PiModelSource(包 ModelsStore),dsh 路是 client/dsh 的 DshConfigSource,
// 两者都 implements 该接口,由 bootstrap 注入。加第三个内核 = 加一个 source,本类不动。
//
// 依赖方向:本层只 import domain(接口 + 类型),不 import client/electron。
import type { KernelModelSource } from "@my-harness-desktop/shared";
import type { ModelInfo } from "@my-harness-desktop/shared";
import type { KernelId } from "@my-harness-desktop/shared";
import type { NeutralModelRef } from "@my-harness-desktop/shared";

/** 模型推理档位分类(元数据驱动 + 命名约定兜底):reasoning=true → reasoning,
 *  id 含 flash → fast,其余 → pro。壳的中立模型引用(session-neutral-layer.md §20)。
 *  元数据(reasoning 字段)是权威档位;命名约定只是无 reasoning 字段时的兜底。 */
export function classifyModel(m: Pick<ModelInfo, "id" | "reasoning">): NeutralModelRef["ref"] {
  if (m.reasoning) return "reasoning";
  return /flash/i.test(m.id) ? "fast" : "pro";
}

/** 合流各内核模型。持**取 source 的函数**,加内核 = 注册表多一个插件,本类不动。
 *
 *  ⚠ 构造参数是 `() => KernelModelSource[]` 而不是 `KernelModelSource[]`（boot-surface.md §3.6.3）：
 *  本类的实例被 `MainContext.modelCatalog` 长期持有，而内核插件重载只会**整体替换**
 *  `state.surfaces`——若这里存的是构造期数组，替换 surfaces 不会追溯更新它，
 *  于是新内核的模型永远进不了合流清单（用户看到的现象：装了新内核、模型下拉里没有它的模型，
 *  且没有任何报错）。持 getter 之后每次 `listModels()` 现读，重载即生效。
 *  getter 由调用方给成"经活访问器投影"（`boot/kernel-accessors.ts`），所以既活又保持实例稳定。 */
export class ModelCatalog {
  constructor(private readonly getSources: () => KernelModelSource[]) {}

  /** 合流全部内核模型,返回带 kernel 标的 ModelInfo[]。同名模型不跨内核去重(§3.3)。 */
  listModels(): ModelInfo[] {
    return this.getSources().flatMap((s) => s.listModels());
  }

  /** 解析中立模型引用到某内核的 provider/model;无对应返回 null(显式降级,session-neutral-layer.md §21)。 */
  resolveModel(kernel: KernelId, ref: NeutralModelRef): { provider: string; model: string } | null {
    const match = this.listModels().find((m) => m.kernel === kernel && classifyModel(m) === ref.ref);
    return match ? { provider: match.provider, model: match.id } : null;
  }
}
