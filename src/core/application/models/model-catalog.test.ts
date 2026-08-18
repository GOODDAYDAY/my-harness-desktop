// model-catalog 合流测试 —— pi(models.json)+ dsh(cordis.yml llm-deepseek)两路合成带 kernel 标的清单(设计 §3.3)。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ModelsStore } from "./models-store";
import { DshConfigSource } from "../../../client/dsh/dsh-config-source";
import { ModelCatalog } from "./model-catalog";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "model-catalog-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("ModelCatalog 合流", () => {
  it("pi + dsh 两路合成,各带正确 kernel 标", () => {
    const agentDir = join(dir, "agent");
    mkdirSync(agentDir, { recursive: true });
    const pi = new ModelsStore({ agentDir });
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({
      providers: { openai: { models: [{ id: "gpt-4o", name: "gpt-4o" }] } },
    }));

    const cordisPath = join(dir, "cordis.yml");
    writeFileSync(cordisPath, [
      "- id: llm-deepseek",
      "  name: '@deepseek-ai/dsh-llm-deepseek'",
      "  config:",
      "    models:",
      "      - id: !!js process.env.DSH_MODEL ?? 'deepseek-v4-pro'",
      "        contextWindow: !!js Number(process.env.DSH_CONTEXT_WINDOW ?? 128000)",
    ].join("\n"));

    const catalog = new ModelCatalog(pi, new DshConfigSource(cordisPath));
    const models = catalog.listModels();

    const piModel = models.find((m) => m.kernel === "pi");
    const dshModel = models.find((m) => m.kernel === "dsh");
    expect(models).toHaveLength(2);
    expect(piModel?.id).toBe("gpt-4o");
    expect(piModel?.provider).toBe("openai");
    expect(dshModel?.id).toBe("deepseek-v4-pro");
    expect(dshModel?.provider).toBe("deepseek-official");
    expect(dshModel?.contextWindow).toBe(128000);
  });

  it("dsh cordis.yml 缺失 → 只返回 pi 一路,不炸", () => {
    const agentDir = join(dir, "agent2");
    mkdirSync(agentDir, { recursive: true });
    const pi = new ModelsStore({ agentDir });
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { a: { models: [{ id: "m", name: "m" }] } } }));

    const catalog = new ModelCatalog(pi, new DshConfigSource(undefined));
    const models = catalog.listModels();
    expect(models).toHaveLength(1);
    expect(models[0].kernel).toBe("pi");
  });
});

describe("DshConfigSource 插件启停(块级文本编辑,!!js 原样保留)", () => {
  it("disable → enable 往返,插件块逐字还原", () => {
    const cordisPath = join(dir, "cordis.yml");
    writeFileSync(cordisPath, [
      "- id: a",
      "  name: pkg-a",
      "- id: llm-deepseek",
      "  config:",
      "    models:",
      "      - id: !!js process.env.DSH_MODEL ?? 'deepseek-v4-flash'",
    ].join("\n") + "\n");

    const src = new DshConfigSource(cordisPath);
    expect(src.listPlugins().map((p) => p.id)).toEqual(["a", "llm-deepseek"]);

    src.disablePlugin("a");
    expect(src.listPlugins().map((p) => p.id)).toEqual(["llm-deepseek"]);
    expect(src.listDisabledPlugins().map((p) => p.id)).toEqual(["a"]);
    // !!js 表达式在 llm-deepseek 里原样保留(禁用 a 不影响它)
    expect(readFileSync(cordisPath, "utf-8")).toContain("!!js process.env.DSH_MODEL");

    src.enablePlugin("a");
    expect(src.listPlugins().map((p) => p.id)).toEqual(["llm-deepseek", "a"]);
    expect(src.listDisabledPlugins()).toEqual([]);
    // 还原的块仍含 name(缩进在 `- id: a` 下)
    expect(readFileSync(cordisPath, "utf-8")).toContain("name: pkg-a");
  });

  it("禁用不存在的插件抛错", () => {
    const cordisPath = join(dir, "cordis2.yml");
    writeFileSync(cordisPath, "- id: a\n  name: pkg-a\n");
    const src = new DshConfigSource(cordisPath);
    expect(() => src.disablePlugin("nope")).toThrow("不在 cordis.yml");
  });
});

describe("DshConfigSource 多 provider 模型", () => {
  it("listProviders 读 llm-deepseek + llm-pi-ai 两路", () => {
    const cordisPath = join(dir, "cordis-multi.yml");
    writeFileSync(cordisPath, [
      "- id: llm-deepseek",
      "  config:",
      "    models:",
      "      - id: deepseek-v4-pro",
      "        contextWindow: 1000000",
      "- id: llm-pi-ai",
      "  config:",
      "    providers:",
      "      openai:",
      "        api: openai",
      "        models:",
      "          - id: gpt-4o",
      "            name: GPT-4o",
      "            contextWindow: 128000",
      "            maxTokens: 8192",
    ].join("\n") + "\n");

    const src = new DshConfigSource(cordisPath);
    const providers = src.listProviders();
    expect(providers.map((p) => p.provider)).toEqual(["deepseek-official", "openai"]);
    expect(providers[0].models[0].id).toBe("deepseek-v4-pro");
    expect(providers[1].models[0]).toEqual({ id: "gpt-4o", name: "GPT-4o", contextWindow: 128000, maxTokens: 8192 });

    // listModels 合流:两 provider 的模型都带正确 provider 字段
    const models = src.listModels();
    expect(models.map((m) => `${m.provider}/${m.id}`)).toEqual(["deepseek-official/deepseek-v4-pro", "openai/gpt-4o"]);
  });
});

describe("DshConfigSource 插件安装(resolvePluginId + addPlugin)", () => {
  it("resolvePluginId 走映射表 + 未知包剥前缀回落", () => {
    const src = new DshConfigSource(join(dir, "nope.yml"));
    expect(src.resolvePluginId("@deepseek-ai/dsh-bash-local")).toBe("bash");
    expect(src.resolvePluginId("@deepseek-ai/dsh-agent-spine-demo")).toBe("agent-spine");
    expect(src.resolvePluginId("@deepseek-ai/dsh-session-persistence-jsonl")).toBe("sessions");
    expect(src.resolvePluginId("@deepseek-ai/dsh-unknown-thing")).toBe("unknown-thing");
  });

  it("addPlugin 追加 cordis.yml 项(幂等)", () => {
    const cordisPath = join(dir, "cordis-install.yml");
    writeFileSync(cordisPath, "- id: llm-deepseek\n  name: '@deepseek-ai/dsh-llm-deepseek'\n");
    const src = new DshConfigSource(cordisPath);
    const id = src.addPlugin("@deepseek-ai/dsh-tool-todo");
    expect(id).toBe("tool-todo");
    const text = readFileSync(cordisPath, "utf-8");
    expect(text).toContain("- id: tool-todo");
    expect(text).toContain("name: '@deepseek-ai/dsh-tool-todo'");
    // 幂等:再装一次不重复追加
    src.addPlugin("@deepseek-ai/dsh-tool-todo");
    expect(readFileSync(cordisPath, "utf-8").split("- id: tool-todo").length).toBe(2);
  });
});

describe("DshConfigSource provider 详情(api/baseURL)写回", () => {
  it("setProvider 写连接事实 + 空串清覆盖", async () => {
    const settingsPath = join(dir, "settings.yaml");
    const src = new DshConfigSource(join(dir, "nope.yml"), settingsPath);
    await src.setProvider("openai", {
      api: "openai",
      baseURL: "https://api.openai.com",
      models: [{ id: "gpt-4o", contextWindow: 128000 }],
    });
    const providers = src.listProviders();
    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({
      provider: "openai",
      api: "openai",
      baseURL: "https://api.openai.com",
    });
    expect(providers[0].models[0].id).toBe("gpt-4o");

    // 空串清覆盖:两字段全落空 → listProviders 不再返回它们
    await src.setProvider("openai", { api: "", baseURL: "", models: [{ id: "gpt-4o" }] });
    const after = src.listProviders()[0];
    expect(after.api).toBeUndefined();
    expect(after.baseURL).toBeUndefined();
  });
});
