// pi-kernel-api 中性翻译的 compat.supportsDeveloperRole 往返守卫。
// 根因:pi-ai 对 reasoning 模型默认发 developer 角色,部分网关(bifrost tencent 路由)只认
// system → 400 拒。桌面透传 compat.supportsDeveloperRole 让用户可关。守卫「读回/写回不丢该字段」。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPiModelsApi } from "./pi-kernel-api";
import { ModelsStore } from "../model/models-store";
import { PiSettingsStore } from "../model/pi-settings-store";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "pi-api-compat-")); writeFileSync(join(dir, "models.json"), "{}"); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function makeApi() {
  const modelsStore = new ModelsStore({ agentDir: dir });
  const settingsStore = new PiSettingsStore({ agentDir: dir } as never);
  return createPiModelsApi(modelsStore, settingsStore, {} as never);
}

describe("pi-kernel-api compat.supportsDeveloperRole 往返", () => {
  it("写回 supportsDeveloperRole:false → models.json 落 compat.supportsDeveloperRole=false", async () => {
    const api = makeApi();
    await api.set("p", {
      baseUrl: "https://gw/", api: "openai-completions", apiKey: "k",
      models: [{ id: "bifrost/tencent/deepseek-v4-pro", name: "dsv4", reasoning: true, supportsDeveloperRole: false }],
    });
    const raw = JSON.parse(readFileSync(join(dir, "models.json"), "utf-8"));
    expect(raw.providers.p.models[0].compat.supportsDeveloperRole).toBe(false);
  });

  it("读回 compat.supportsDeveloperRole=false → 中性模型 supportsDeveloperRole=false(不丢)", async () => {
    writeFileSync(join(dir, "models.json"), JSON.stringify({
      providers: { p: { api: "openai-completions", models: [{ id: "bifrost/tencent/deepseek-v4-pro", name: "dsv4", reasoning: true, compat: { supportsDeveloperRole: false } }] } },
    }));
    const api = makeApi();
    const providers = await api.list();
    expect(providers[0].models[0].supportsDeveloperRole).toBe(false);
  });

  it("未设 compat 时 supportsDeveloperRole 缺省 undefined(写回不产生空 compat)", async () => {
    const api = makeApi();
    await api.set("p", { baseUrl: "https://gw/", api: "openai-completions", models: [{ id: "m", name: "m" }] });
    const raw = JSON.parse(readFileSync(join(dir, "models.json"), "utf-8"));
    expect(raw.providers.p.models[0].compat).toBeUndefined();
  });
});
