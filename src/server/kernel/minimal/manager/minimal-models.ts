// minimal 模型面 —— KernelModelSource(合流清单) + KernelModelsApi(设置页模型 TAB)。
//
// 依据 docs/design/minimal-kernel.md §4.9 / §7.6 / §7.9.3。
//
// **两个面同源**:ModelSource(读清单合流进模型下拉)与 ModelsApi(设置页读写)都走同一个
// MinimalConfigSource —— 此前 ModelSource 自己解析 models.json、ModelsApi 另写一套，
// 且 ModelsApi 的写面是空实现（set/remove/rename/setDefault/saveConfig 全返空数组），
// 设置页点保存看着成功、盘上什么都没变（§7.9.3 明令禁止的「伪造成功」）。现在读写同源：
// 写进去的，读得回来；读出来的，就是内核子进程读的那份文件。
//
// **无配置时的 `echo` 模型：已裁决为「内置 offline provider」，见 minimal-kernel.md §4.9.1b**。
// 它此前是文档没表态的灰区（代码一直有、文档从没写），灰区的危险不在于"假"，而在于
// **下一个人会以为它是 bug 而删掉**——删掉即打断 §2.10.1「零配置也能完整跑通一轮」的
// 独立内核底线，也打断 desktop 侧唯一的零 token 端到端通路。
// 现在的定性：它是内核的一等行为（真进程、真 JSONL 流、真落盘、逐字流式），
// 不是任何外部模型的替身；模型 id 就叫 `echo`、回复正文自带 `[minimal echo]` 前缀、
// 消息 model 域写着 minimal/echo —— 没有一处声称自己是别的模型。
// 边界：**只在"一个 provider 都没配"时**才作为选项出现；配了 provider 就不出面。

import { MinimalConfigSource } from "./minimal-config-source";
import type { KernelModelSource, KernelModelsApi, ModelInfo, NeutralProvider, NeutralDefaultModel, KernelModelConfig } from "@my-harness-desktop/shared";

/** 内置 offline provider 的身份（minimal-kernel.md §4.9.1b）——与 CLI 回落分支同一对常量。 */
const ECHO_PROVIDER = "minimal";
const ECHO_MODEL = "echo";

/** minimal 的模型源:会话流模型下拉合流用,读真 models.json（无配置 = 空清单,不编造）。 */
export class MinimalModelSource implements KernelModelSource {
  constructor(private readonly source: MinimalConfigSource) {}

  listModels(): ModelInfo[] {
    const providers = this.source.readModels().providers;
    const real = providers.flatMap((p) =>
      p.models.map((m) => ({ kernel: "minimal" as const, provider: p.id, id: m.id, name: m.name ?? m.id })),
    );
    if (real.length > 0) return real;
    // 零配置：交出内置 offline provider（§4.9.1b）。**只在真的一个 provider 都没有时**——
    // 有 provider 只是模型列表为空（用户删光了模型）同样算"没得选"，一并回落到 offline，
    // 否则内核会处于"能起进程但发不出消息"的半死态。
    return [{ kernel: "minimal" as const, provider: ECHO_PROVIDER, id: ECHO_MODEL, name: "Minimal Echo" }];
  }
}

/** minimal 的模型配置 API(设置页模型 TAB):读写真文件,写面与读面同源。 */
export class MinimalModelsApi implements KernelModelsApi {
  constructor(
    private readonly source: MinimalConfigSource,
    /** 连通性测试:壳注入「绑定本内核」的实现(依赖倒置,与 pi/dsh 同一条通道)。 */
    private readonly testModel: (cwd: string, provider: string, modelId: string) => Promise<{ ok: boolean; error?: string }>,
  ) {}

  private neutral(): NeutralProvider[] {
    return this.source.listProviders();
  }

  list(): Promise<NeutralProvider[]> {
    return Promise.resolve(this.neutral());
  }

  /** 新增/覆盖 provider（apiKey 落凭证文件,不落 models.json）。写后回读,返回盘上的真值。 */
  set(provider: string, detail: Omit<NeutralProvider, "id">): Promise<NeutralProvider[]> {
    this.source.setProvider(provider, detail);
    return Promise.resolve(this.neutral());
  }

  remove(provider: string): Promise<NeutralProvider[]> {
    this.source.removeProvider(provider);
    return Promise.resolve(this.neutral());
  }

  rename(oldId: string, newId: string): Promise<NeutralProvider[]> {
    this.source.renameProvider(oldId, newId);
    return Promise.resolve(this.neutral());
  }

  getDefault(): Promise<NeutralDefaultModel | null> {
    return Promise.resolve(this.source.getDefaultModel());
  }

  /** 设默认:**写盘**（此前返回入参却不落盘,刷新即丢）。 */
  setDefault(sel: NeutralDefaultModel): Promise<NeutralDefaultModel | null> {
    this.source.setDefaultModel(sel);
    return Promise.resolve(this.source.getDefaultModel());
  }

  test(cwd: string, provider: string, modelId: string): Promise<{ ok: boolean; error?: string }> {
    return this.testModel(cwd, provider, modelId);
  }

  readConfig(): Promise<KernelModelConfig> {
    return Promise.resolve({ providers: this.neutral(), default: this.source.getDefaultModel() });
  }

  /**
   * 全量 reconcile:删缺 → 增改 → 设/清默认,返回**落盘后**的配置。
   * 此前返回 `{providers:[],default:null}` 的字面值——那是编造:既没落盘,也不是盘上的真值,
   * 前端拿它去回显就会把用户刚填的清单整片擦掉。
   */
  saveConfig(config: KernelModelConfig): Promise<KernelModelConfig> {
    const nextIds = new Set(config.providers.map((p) => p.id));
    for (const p of this.neutral()) {
      if (!nextIds.has(p.id)) this.source.removeProvider(p.id);
    }
    for (const p of config.providers) {
      this.source.setProvider(p.id, p);
    }
    // default 为 null（删掉了 default provider / 清空选择）时也要清指针,
    // 否则 models.json 残留 default 指向已删 provider（与 dsh 同一条根因）。
    if (config.default) this.source.setDefaultModel(config.default);
    else this.source.clearDefaultModel();
    return Promise.resolve({ providers: this.neutral(), default: this.source.getDefaultModel() });
  }
}
