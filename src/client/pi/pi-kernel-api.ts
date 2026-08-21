// client/pi —— pi 内核管理设置中性 API 适配器（kernel-design-spec.md §12.5/§12.6）。
//
// 把 pi 的原生形状（models.json 的 ModelsConfig + settings.json 的 defaultProvider/
// defaultModel + extension 的 ExtensionInfo）翻译成中性 KernelModelsApi / KernelPluginsApi。
// 依赖只向内：client 可 import core/domain（类型）与 core/application（store 接口）。
import type { KernelModelsApi, KernelPluginsApi, NeutralExtension, NeutralProvider } from "../../core/domain/context";
import type { ModelsConfig, ProviderConfig } from "../../core/domain/sessions";
import type { ModelsStore } from "../../core/application/models/models-store";
import type { PiSettingsStore } from "../../core/application/pi-settings/pi-settings-store";
import type { ExtensionStore } from "../../core/application/extensions/extension-store";
import type { SessionStore } from "../../core/application/sessions/session-store";
import { runPiCli } from "./pi-cli";

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
      const s = piSettingsStore.get();
      return typeof s.defaultProvider === "string" && typeof s.defaultModel === "string"
        ? { provider: s.defaultProvider, model: s.defaultModel }
        : null;
    },
    async setDefault(sel) {
      await piSettingsStore.set({ defaultProvider: sel.provider, defaultModel: sel.model });
      return sel;
    },
    test: (cwd, provider, modelId) => sessionStore.test(cwd, provider, modelId, "pi"),
  };
}

/** pi 拓展 → 中性 KernelPluginsApi。 */
export function createPiPluginsApi(extensionStore: ExtensionStore): KernelPluginsApi {
  const toNeutral = (): NeutralExtension[] =>
    extensionStore.scanExtensions().map((e) => ({
      id: e.source,
      name: e.name,
      version: e.version,
      description: e.description,
      tags: e.tags,
      enabled: e.enabled,
      protected: e.disallowOff,
    }));

  return {
    list: () => Promise.resolve(toNeutral()),
    async enable(id) { await extensionStore.enable(id); return toNeutral(); },
    async disable(id) { await extensionStore.disable(id); return toNeutral(); },
    install: async (source, onProgress) => {
      const r = await runPiCli(["install", source], onProgress);
      return { ok: r.ok, error: r.error ?? undefined };
    },
  };
}
