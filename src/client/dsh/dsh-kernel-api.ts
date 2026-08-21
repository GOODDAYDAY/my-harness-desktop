// client/dsh —— dsh 内核管理设置中性 API 适配器（kernel-design-spec.md §12.5/§12.6）。
//
// 把 dsh 的原生形状（settings.yaml 的 llm-deepseek 单 route + llm-pi-ai.providers
// 多路由 + cordis.yml 插件树）翻译成中性 KernelModelsApi / KernelPluginsApi。
// 密钥字面值存 prefs.dshApiKeys（spawn 时注入 apiKeyEnv），不进 settings.yaml。
import type { KernelModelsApi, KernelPluginsApi, NeutralExtension, NeutralProvider } from "../../core/domain/context";
import type { SessionStore } from "../../core/application/sessions/session-store";
import { DSH_OFFICIAL_PROVIDER, type DshConfigSource } from "./dsh-config-source";
import type { DshKernelManager } from "./dsh-kernel";

/** dsh 核心 cordis 插件（禁掉会断 JSON-RPC 通道/会话持久化），标 protected 锁标。 */
const DSH_PROTECTED = new Set(["sdk-jsonrpc-server", "settings-file", "sessions", "subprocess"]);

/** dsh 模型配置 → 中性 KernelModelsApi。 */
export function createDshModelsApi(
  dshConfigSource: DshConfigSource,
  sessionStore: SessionStore,
  prefs: { getApiKeys: () => Record<string, string>; setApiKeys: (m: Record<string, string>) => void },
): KernelModelsApi {
  const toNeutral = (): NeutralProvider[] =>
    dshConfigSource.listProviders().map((p) => ({
      id: p.provider,
      displayName: p.displayName ?? p.provider,
      baseUrl: p.baseURL,
      api: p.api,
      apiKey: prefs.getApiKeys()[p.provider] ?? "",
      models: p.models.map((m) => ({ id: m.id, name: m.name ?? m.id, contextWindow: m.contextWindow, maxTokens: m.maxTokens })),
    }));

  const writeApiKey = (provider: string, key: string | undefined): void => {
    const next = { ...prefs.getApiKeys() };
    if (key) next[provider] = key; else delete next[provider];
    prefs.setApiKeys(next);
  };

  return {
    list: () => Promise.resolve(toNeutral()),
    async set(provider, detail) {
      await dshConfigSource.setProvider(provider, {
        displayName: detail.displayName,
        api: detail.api,
        baseURL: detail.baseUrl,
        models: detail.models.map((m) => ({ id: m.id, name: m.name, contextWindow: m.contextWindow, maxTokens: m.maxTokens })),
      });
      writeApiKey(provider, detail.apiKey);
      return toNeutral();
    },
    async remove(provider) {
      await dshConfigSource.removeProvider(provider);
      writeApiKey(provider, undefined);
      return toNeutral();
    },
    async rename(oldId, newId) {
      if (oldId === DSH_OFFICIAL_PROVIDER) throw new Error(`${DSH_OFFICIAL_PROVIDER} 是固定路由,不可改名`);
      await dshConfigSource.renameProvider(oldId, newId);
      const keys = prefs.getApiKeys();
      if (keys[oldId] !== undefined) {
        const next = { ...keys, [newId]: keys[oldId] };
        delete next[oldId];
        prefs.setApiKeys(next);
      }
      return toNeutral();
    },
    getDefault: () => Promise.resolve(dshConfigSource.getDefaultModel()),
    async setDefault(sel) {
      await dshConfigSource.setDefaultModel(sel);
      return sel;
    },
    test: (cwd, provider, modelId) => sessionStore.test(cwd, provider, modelId, "dsh"),
  };
}

/** dsh 拓展 → 中性 KernelPluginsApi。 */
export function createDshPluginsApi(
  dshConfigSource: DshConfigSource,
  dshKernelManager: DshKernelManager,
): KernelPluginsApi {
  const toNeutral = (): NeutralExtension[] => {
    const enabled = dshConfigSource.listPlugins();
    const disabled = dshConfigSource.listDisabledPlugins();
    return [
      ...enabled.map((p) => ({ id: p.id, name: p.name, enabled: true, protected: DSH_PROTECTED.has(p.id) })),
      ...disabled.map((p) => ({ id: p.id, name: p.name, enabled: false, protected: DSH_PROTECTED.has(p.id) })),
    ];
  };

  return {
    list: () => Promise.resolve(toNeutral()),
    enable: (id) => { dshConfigSource.enablePlugin(id); return Promise.resolve(toNeutral()); },
    disable: (id) => { dshConfigSource.disablePlugin(id); return Promise.resolve(toNeutral()); },
    async install(pkg, onProgress) {
      const r = await dshKernelManager.installPlugin(pkg, onProgress);
      if (!r.ok) return { ok: false, error: r.error ?? undefined };
      try {
        dshConfigSource.addPlugin(pkg);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
