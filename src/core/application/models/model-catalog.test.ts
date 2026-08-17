// model-catalog 合流测试 —— pi(models.json)+ dsh(cordis.yml llm-deepseek)两路合成带 kernel 标的清单(设计 §3.3)。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ModelsStore } from "./models-store";
import { DshModelSource } from "../../../client/dsh/dsh-model-source";
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

    const catalog = new ModelCatalog(pi, new DshModelSource(cordisPath));
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

    const catalog = new ModelCatalog(pi, new DshModelSource(undefined));
    const models = catalog.listModels();
    expect(models).toHaveLength(1);
    expect(models[0].kernel).toBe("pi");
  });
});
