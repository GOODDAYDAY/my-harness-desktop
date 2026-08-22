// createDshModelsApi 的 readConfig/saveConfig 单测：中性快照读写 + 全量 reconcile(删缺/增改/设默认 + 固定路由保护)。
import { describe, it, expect } from "vitest";
import type { DshConfigApi, DshDefaultModel, DshProvider } from "../../core/domain/context";
import { createDshModelsApi } from "./dsh-kernel-api";
import { DSH_OFFICIAL_PROVIDER } from "./dsh-config-source";

function makeConfig(initial: { providers: DshProvider[]; default: DshDefaultModel | null }) {
  let providers = [...initial.providers];
  let def = initial.default;
  let keys: Record<string, string> = {};
  const api: DshConfigApi = {
    listProviders: () => providers,
    async setProvider(id, detail) {
      const next: DshProvider = { provider: id, ...detail };
      const idx = providers.findIndex((p) => p.provider === id);
      if (idx >= 0) providers[idx] = next; else providers.push(next);
    },
    async renameProvider(oldId, newId) {
      providers = providers.map((p) => (p.provider === oldId ? { ...p, provider: newId } : p));
    },
    async removeProvider(id) {
      if (id === DSH_OFFICIAL_PROVIDER) throw new Error(`${DSH_OFFICIAL_PROVIDER} 是固定路由,不可删除`);
      providers = providers.filter((p) => p.provider !== id);
    },
    getDefaultModel: () => def,
    async setDefaultModel(sel) { def = sel; },
    getSettings: () => ({}),
    async setSettings() {},
    addPluginBlock() {},
    removePluginBlock() {},
  };
  const prefs = {
    getApiKeys: () => keys,
    setApiKeys: (m: Record<string, string>) => { keys = m; },
  };
  const modelsApi = createDshModelsApi(api, {} as never, prefs);
  return { modelsApi, api, prefs, read: () => providers, def: () => def };
}

describe("createDshModelsApi.readConfig/saveConfig", () => {
  it("readConfig 返回 providers + default", async () => {
    const { modelsApi } = makeConfig({
      providers: [
        { provider: "us-new", baseURL: "https://x", models: [{ id: "m1" }] },
      ],
      default: { provider: "us-new", model: "m1" },
    });
    const cfg = await modelsApi.readConfig();
    expect(cfg.providers).toHaveLength(1);
    expect(cfg.providers[0]).toMatchObject({ id: "us-new", baseUrl: "https://x" });
    expect(cfg.default).toEqual({ provider: "us-new", model: "m1" });
  });

  it("saveConfig 全量 reconcile:增/改/删 + 设默认,固定路由不可删", async () => {
    const { modelsApi, read } = makeConfig({
      providers: [
        { provider: DSH_OFFICIAL_PROVIDER, models: [{ id: "deepseek-v4-pro" }] },
        { provider: "us-new", baseURL: "https://x", models: [{ id: "m1" }] },
        { provider: "to-delete", models: [{ id: "m2" }] },
      ],
      default: { provider: "us-new", model: "m1" },
    });

    await modelsApi.saveConfig({
      providers: [
        { id: DSH_OFFICIAL_PROVIDER, models: [{ id: "deepseek-v4-pro", name: "deepseek-v4-pro" }] },
        { id: "us-new", baseUrl: "https://y", models: [{ id: "m1", name: "m1" }, { id: "m3", name: "m3" }] },
        { id: "added", models: [{ id: "m4", name: "m4" }] },
      ],
      default: { provider: "added", model: "m4" },
    });

    const ids = read().map((p) => p.provider).sort();
    expect(ids).toEqual([DSH_OFFICIAL_PROVIDER, "added", "us-new"].sort());
    expect(read().find((p) => p.provider === "us-new")?.baseURL).toBe("https://y");
    expect(read().find((p) => p.provider === "us-new")?.models).toHaveLength(2);
    const cfg = await modelsApi.readConfig();
    expect(cfg.default).toEqual({ provider: "added", model: "m4" });
  });
});
