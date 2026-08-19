// model-catalog —— 合流 pi/dsh 两路模型清单(设计 §3.3 + kernel-layer.md §2.3)。
//
// 这是「扫模型」的机制层(所有内核共用),从 timeline 插件的 toModelInfos 上收到 core/application。
// 圆心契约:本层只依赖 KernelModelSource 接口(domain/backend),不 import client 具体类——
// pi 路是 PiModelSource(包 ModelsStore),dsh 路是 client/dsh 的 DshConfigSource implements 该接口。
// 两路各自在「来源」处打 kernel 标,合流后同名模型不跨内核去重。
//
// 依赖方向:本层 import domain(接口 + 类型)+ 同层 models-store,不 import client/electron。
import type { KernelModelSource } from "../../domain/backend";
import type { ModelInfo } from "../../domain/events/session-state";
import type { ModelsConfig } from "../../domain/sessions";
import type { KernelId } from "../../domain/kernel";
import type { NeutralModelRef } from "../../domain/session-neutral";
import type { ModelsStore } from "./models-store";

/** 模型推理档位分类(元数据驱动 + 命名约定兜底):reasoning=true → reasoning,
 *  id 含 flash → fast,其余 → pro。壳的中立模型引用(session-neutral-layer.md §20)。
 *  元数据(reasoning 字段)是权威档位;命名约定只是无 reasoning 字段时的兜底。 */
export function classifyModel(m: Pick<ModelInfo, "id" | "reasoning">): NeutralModelRef["ref"] {
  if (m.reasoning) return "reasoning";
  return /flash/i.test(m.id) ? "fast" : "pro";
}

/** pi 模型源:ModelsStore(models.json) 的 provider 树 → ModelInfo[](kernel="pi")。 */
export class PiModelSource implements KernelModelSource {
  constructor(private readonly store: ModelsStore) {}

  listModels(): ModelInfo[] {
    const out: ModelInfo[] = [];
    const cfg: ModelsConfig = this.store.get();
    for (const [provider, pc] of Object.entries(cfg.providers ?? {})) {
      for (const m of pc.models ?? []) {
        out.push({
          kernel: "pi",
          provider,
          id: m.id,
          name: m.name ?? m.id,
          reasoning: m.reasoning,
          contextWindow: m.contextWindow,
          maxTokens: m.maxTokens,
          input: m.input,
        });
      }
    }
    return out;
  }
}

/** 合流 pi + dsh 模型。持一组 KernelModelSource,加第三个内核 = 加一个 source,本类不动。 */
export class ModelCatalog {
  constructor(private readonly sources: KernelModelSource[]) {}

  /** 合流全部内核模型,返回带 kernel 标的 ModelInfo[]。同名模型不跨内核去重(§3.3)。 */
  listModels(): ModelInfo[] {
    return this.sources.flatMap((s) => s.listModels());
  }

  /** 解析中立模型引用到某内核的 provider/model;无对应返回 null(显式降级,session-neutral-layer.md §21)。 */
  resolveModel(kernel: KernelId, ref: NeutralModelRef): { provider: string; model: string } | null {
    const match = this.listModels().find((m) => m.kernel === kernel && classifyModel(m) === ref.ref);
    return match ? { provider: match.provider, model: match.id } : null;
  }
}
