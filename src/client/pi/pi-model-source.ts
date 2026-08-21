// pi 模型源 —— client/pi 流出适配器：ModelsStore(models.json) 的 provider 树 → ModelInfo[](kernel="pi")。
//
// 依据 kernel-layer.md §2.3 + docs/core-spec.md：pi 的模型清单实现下沉 client/pi，
// 与 dsh 的 DshConfigSource(client/dsh) 对称。ModelCatalog(core/application) 只依赖
// KernelModelSource 接口，本类由 bootstrap 注入。
import type { KernelModelSource } from "../../core/domain/backend";
import type { ModelInfo } from "../../core/domain/events/session-state";
import type { ModelsConfig } from "../../core/domain/sessions";
import type { ModelsStore } from "./models-store";

/** pi 模型源：ModelsStore(models.json) 的 provider 树 → ModelInfo[](kernel="pi")。 */
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
