// client/pi —— pi 内核管理设置中性 API 适配器（kernel-design-spec.md §12.5/§12.6）。
//
// 把 pi 的原生形状（models.json 的 ModelsConfig + settings.json 的 defaultProvider/
// defaultModel + extension 的 ExtensionInfo）翻译成中性 KernelModelsApi。
// 依赖只向内：client 可 import core/domain（类型）与 core/application（store 接口）。
import type { KernelModelsApi, KernelModelConfig, NeutralProvider } from "@my-harness-desktop/shared";
import type { ModelsConfig, ProviderConfig } from "../model/models-config";
import type { ModelsStore } from "../model/models-store";
import type { PiSettingsStore } from "../model/pi-settings-store";
import type { SessionStore } from "../../../application/sessions/session-store";

/** pi 模型配置 → 中性 KernelModelsApi。 */
export function createPiModelsApi(
  modelsStore: ModelsStore,
  piSettingsStore: PiSettingsStore,
  sessionStore: SessionStore,
): KernelModelsApi {
  const toNeutral = (cfg: ModelsConfig): NeutralProvider[] =>
    Object.entries(cfg.providers).map(([id, p]) => ({
      id,
      baseUrl: p.baseUrl,
      api: p.api,
      apiKey: p.apiKey,
      models: (p.models ?? []).map((m) => ({ id: m.id, name: m.name, reasoning: m.reasoning, contextWindow: m.contextWindow, maxTokens: m.maxTokens })),
    }));

  const fromNeutral = (detail: Omit<NeutralProvider, "id">): ProviderConfig => ({
    baseUrl: detail.baseUrl,
    api: detail.api,
    apiKey: detail.apiKey,
    models: detail.models.map((m) => ({ id: m.id, name: m.name, reasoning: m.reasoning, contextWindow: m.contextWindow, maxTokens: m.maxTokens })),
  });

  const readDefault = (): KernelModelConfig["default"] => {
    const s = piSettingsStore.get();
    return typeof s.defaultProvider === "string" && typeof s.defaultModel === "string"
      ? { provider: s.defaultProvider, model: s.defaultModel }
      : null;
  };

  const readConfig = async (): Promise<KernelModelConfig> => ({
    providers: toNeutral(modelsStore.get()),
    default: readDefault(),
  });

  return {
    list: () => Promise.resolve(toNeutral(modelsStore.get())),
    async set(provider, detail) {
      const cfg = modelsStore.get();
      cfg.providers[provider] = fromNeutral(detail);
      await modelsStore.set(cfg);
      return toNeutral(modelsStore.get());
    },
    async remove(provider) {
      const cfg = modelsStore.get();
      delete cfg.providers[provider];
      await modelsStore.set(cfg);
      return toNeutral(modelsStore.get());
    },
    async rename(oldId, newId) {
      const cfg = modelsStore.get();
      if (!(oldId in cfg.providers)) throw new Error(`provider ${oldId} 不存在`);
      if (newId in cfg.providers) throw new Error(`provider ${newId} 已存在`);
      const next: Record<string, ProviderConfig> = {};
      for (const [k, v] of Object.entries(cfg.providers)) next[k === oldId ? newId : k] = v;
      cfg.providers = next;
      await modelsStore.set(cfg);
      return toNeutral(modelsStore.get());
    },
    async getDefault() {
      return readDefault();
    },
    async setDefault(sel) {
      await piSettingsStore.set({ defaultProvider: sel.provider, defaultModel: sel.model });
      return sel;
    },
    test: (cwd, provider, modelId) => sessionStore.test(cwd, provider, modelId, "pi"),
    readConfig,
    async saveConfig(config) {
      // models.json 的 providers 是整份 dict,直接重建整份写(等价于逐 provider set 的收敛)。
      const cfg: ModelsConfig = { providers: {} };
      for (const p of config.providers) cfg.providers[p.id] = fromNeutral(p);
      await modelsStore.set(cfg);
      if (config.default) await piSettingsStore.set({ defaultProvider: config.default.provider, defaultModel: config.default.model });
      return readConfig();
    },
  };
}
