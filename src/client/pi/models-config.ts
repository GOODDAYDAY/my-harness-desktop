// client/pi —— pi 底座 models.json 的结构契约(pi 专属存储格式,下沉到 client/pi)。
//
// 之前这些类型定义在 core/domain/sessions.ts(圆心),被壳 renderer + contract 引用,
// 违反「壳不读内核存储格式」。现下沉到 client/pi,只有 pi 适配器(models-store/pi-kernel-api/
// pi-model-source)import;壳层不碰这些形状。

/** pi 底座 models.json 的单个模型配置。 */
export interface ModelConfig {
  id: string;
  name: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
}

/** pi 底座 models.json 的单个 provider 配置。 */
export interface ProviderConfig {
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  authHeader?: boolean;
  models: ModelConfig[];
}

/** pi 底座 models.json 结构(宽松,实际字段见底座 config.ts)。 */
export interface ModelsConfig {
  providers: Record<string, ProviderConfig>;
}

/** models.json 声明序首个可用模型(第一个挂有模型的 provider 的首个 model);空配置返 null。
 *  消费方:pi 适配器内部,以及需要「无默认模型时的兜底首项」的调用方(经中性接口拿,不直读 models.json)。 */
export function firstModelOf(cfg: ModelsConfig | null | undefined): { provider: string; modelId: string } | null {
  for (const [provider, pc] of Object.entries(cfg?.providers ?? {})) {
    const m = pc.models?.[0];
    if (m) return { provider, modelId: m.id };
  }
  return null;
}
