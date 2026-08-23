// client/dsh —— dsh 内核管理设置中性 API 适配器（kernel-design-spec.md §12.5/§12.6）。
//
// 把 dsh 的原生形状（settings.yaml 的 llm-deepseek 单 route + llm-pi-ai.providers
// 多路由 + cordis.yml 插件树）翻译成中性 KernelModelsApi。
// 密钥字面值存 prefs.dshApiKeys（spawn 时注入 apiKeyEnv），不进 settings.yaml。
import type { KernelModelsApi, KernelModelConfig, NeutralProvider, DshConfigApi } from "../../core/domain/context";
import type { SessionStore } from "../../core/application/sessions/session-store";
import { DSH_OFFICIAL_PROVIDER, assertPiAiRouteServiceable } from "./dsh-config-source";

/** dsh 模型配置 → 中性 KernelModelsApi。 */
export function createDshModelsApi(
  dshConfigSource: DshConfigApi,
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

  const setImpl = async (provider: string, detail: Omit<NeutralProvider, "id">): Promise<void> => {
    await dshConfigSource.setProvider(provider, {
      displayName: detail.displayName,
      api: detail.api,
      baseURL: detail.baseUrl,
      models: detail.models.map((m) => ({ id: m.id, name: m.name, contextWindow: m.contextWindow, maxTokens: m.maxTokens })),
    });
    writeApiKey(provider, detail.apiKey);
  };

  const removeImpl = async (provider: string): Promise<void> => {
    await dshConfigSource.removeProvider(provider);
    writeApiKey(provider, undefined);
  };

  const readConfig = async (): Promise<KernelModelConfig> => ({
    providers: toNeutral(),
    default: dshConfigSource.getDefaultModel(),
  });

  return {
    list: () => Promise.resolve(toNeutral()),
    async set(provider, detail) {
      await setImpl(provider, detail);
      return toNeutral();
    },
    async remove(provider) {
      await removeImpl(provider);
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
    readConfig,
    async saveConfig(config) {
      // 全量 reconcile:删缺(固定路由 deepseek-official 不可删,跳过)+ 增改 + 设默认。
      // 先整体校验再动任何写入:一个空路由会毒化整段 llm-pi-ai(连带合法 provider 一起失效),
      // 若先删后写再校验,空路由抛错时会留下半写状态(旧路由已删、新路由未落)。
      for (const p of config.providers) {
        assertPiAiRouteServiceable(p.id, { models: p.models });
      }
      const oldIds = new Set(toNeutral().map((p) => p.id));
      const newIds = new Set(config.providers.map((p) => p.id));
      for (const id of oldIds) {
        if (id === DSH_OFFICIAL_PROVIDER || newIds.has(id)) continue;
        await removeImpl(id);
      }
      for (const p of config.providers) await setImpl(p.id, p);
      // default 为 null(删除了 default provider / 清空选择)时也要清掉悬空指针,
      // 否则 settings.yaml 残留 agent-default-model 指向已删路由(根因:此前只在非 null 时 set)。
      if (config.default) await dshConfigSource.setDefaultModel(config.default);
      else await dshConfigSource.clearDefaultModel();
      return readConfig();
    },
  };
}
