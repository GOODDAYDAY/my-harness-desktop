// model-catalog —— 合流 pi/dsh 两路模型清单 + 打 kernel 标(设计 §3.3)。
//
// 这是「扫模型 + 打标」的机制层(所有内核共用),从 timeline 插件的 toModelInfos 上收到
// core/application。pi 路读 ModelsStore(~/.pi/agent/models.json),dsh 路经 DshConfigSource
// 接口读 cordis.yml(实现落 client/dsh,依赖倒置)。两路各自在「来源」处打 kernel 标。
//
// application 不 import electron/具体存储:dsh 侧的 cordis.yml 读取经 DshConfigSource 接口注入。
import type { ModelsConfig } from "../../domain/sessions";
import type { ModelInfo } from "../../domain/events/session-state";
import type { ModelsStore } from "./models-store";
import type { DshConfigSource } from "../../../client/dsh/dsh-config-source";

export class ModelCatalog {
  constructor(
    private readonly pi: ModelsStore,
    private readonly dsh: DshConfigSource,
  ) {}

  /** 合流 pi + dsh 模型,返回带 kernel 标的 ModelInfo[]。同名模型不跨内核去重(§3.3)。 */
  listModels(): ModelInfo[] {
    return [...this.toPiModelInfos(this.pi.get()), ...this.dsh.listModels()];
  }

  /** pi 路:models.json 的 provider 树 → ModelInfo[](kernel="pi")。 */
  private toPiModelInfos(cfg: ModelsConfig): ModelInfo[] {
    const out: ModelInfo[] = [];
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
