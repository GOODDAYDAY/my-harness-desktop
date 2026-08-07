// mergeModelsConfig 单测:字段级深合并语义 + 报告计数口径 + 纯函数性(入参不被改)。
import { describe, expect, it } from "vitest";
import { mergeModelsConfig, type ModelsConfig } from "./sessions";

const base: ModelsConfig = {
  providers: {
    anthropic: {
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-ant-old",
      models: [
        { id: "claude-a", name: "Claude A", contextWindow: 200000 },
        { id: "claude-b", name: "Claude B" },
      ],
    },
    openai: {
      baseUrl: "https://api.openai.com",
      models: [{ id: "gpt-4o", name: "GPT-4o" }],
    },
  },
};

describe("mergeModelsConfig", () => {
  it("新 provider 整份新增,键序追加在末尾,base 声明序不动", () => {
    const { merged, report } = mergeModelsConfig(base, {
      providers: { deepseek: { baseUrl: "https://api.deepseek.com", models: [] } },
    });
    expect(Object.keys(merged.providers)).toEqual(["anthropic", "openai", "deepseek"]);
    expect(merged.providers.deepseek.baseUrl).toBe("https://api.deepseek.com");
    expect(report).toEqual({ providersAdded: 1, providersMerged: 0, modelsAdded: 0, modelsMerged: 0 });
  });

  it("同 id provider:同名字段被导入方覆盖,未提供的字段保留", () => {
    const { merged, report } = mergeModelsConfig(base, {
      providers: { anthropic: { apiKey: "sk-ant-new", models: [] } },
    });
    const p = merged.providers.anthropic;
    expect(p.apiKey).toBe("sk-ant-new");
    expect(p.baseUrl).toBe("https://api.anthropic.com");
    expect(report.providersMerged).toBe(1);
    expect(report.providersAdded).toBe(0);
  });

  it("同 id model 字段合并且原位不动;新 id 追加在该 provider 末尾", () => {
    const { merged, report } = mergeModelsConfig(base, {
      providers: {
        anthropic: {
          models: [
            { id: "claude-a", name: "Claude A+", contextWindow: 500000 },
            { id: "claude-c", name: "Claude C" },
          ],
        },
      },
    });
    const models = merged.providers.anthropic.models;
    expect(models.map((m) => m.id)).toEqual(["claude-a", "claude-b", "claude-c"]);
    expect(models[0]).toMatchObject({ name: "Claude A+", contextWindow: 500000 });
    expect(models[1]).toMatchObject({ name: "Claude B" });
    expect(report.modelsMerged).toBe(1);
    expect(report.modelsAdded).toBe(1);
  });

  it("同 id model 合并不丢未提供字段(contextWindow 保留)", () => {
    const { merged } = mergeModelsConfig(base, {
      providers: { anthropic: { models: [{ id: "claude-a", name: "Renamed" }] } },
    });
    expect(merged.providers.anthropic.models[0].contextWindow).toBe(200000);
  });

  it("不同 provider 下同 id model 互不影响", () => {
    const { merged, report } = mergeModelsConfig(base, {
      providers: { openai: { models: [{ id: "claude-a", name: "同名不同家" }] } },
    });
    expect(merged.providers.openai.models.map((m) => m.id)).toEqual(["gpt-4o", "claude-a"]);
    expect(merged.providers.anthropic.models[0].name).toBe("Claude A");
    expect(report.modelsAdded).toBe(1);
    expect(report.modelsMerged).toBe(0);
  });

  it("空导入是恒等合并(计数全零,内容不变)", () => {
    const { merged, report } = mergeModelsConfig(base, { providers: {} });
    expect(merged.providers).toEqual(base.providers);
    expect(report).toEqual({ providersAdded: 0, providersMerged: 0, modelsAdded: 0, modelsMerged: 0 });
  });

  it("纯函数:入参不被改(嵌套 models 数组也不动)", () => {
    const frozen = structuredClone(base);
    mergeModelsConfig(base, {
      providers: { anthropic: { models: [{ id: "claude-a", name: "X" }, { id: "new", name: "N" }] } },
    });
    expect(base).toEqual(frozen);
  });

  it("provider 缺 models 字段与空数组同义,不炸", () => {
    const { merged, report } = mergeModelsConfig({ providers: { a: { models: [] } } }, {
      providers: { a: { baseUrl: "https://x" } as ModelsConfig["providers"][string] },
    });
    expect(merged.providers.a.baseUrl).toBe("https://x");
    expect(merged.providers.a.models).toEqual([]);
    expect(report.providersMerged).toBe(1);
  });
});
