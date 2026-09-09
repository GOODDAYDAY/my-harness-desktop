// minimal 模型源测试 —— ModelSource 从 models.json 读清单(与 CLI 同源),无配置回落 echo 占位。
// 依据 docs/design/minimal-kernel.md §4.9(曾漂移:ModelSource 交写死固定模型,与 CLI 读真配置脱节)。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MinimalModelSource } from "../manager/minimal-models";

let agentDir: string;

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "minimal-src-"));
});

afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true });
});

describe("MinimalModelSource", () => {
  it("读真 models.json 清单(kernel 标 minimal)", () => {
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({
      providers: [{ id: "mock", models: [{ id: "m1", name: "Mock 1" }, { id: "m2" }] }],
      default: { provider: "mock", model: "m1" },
    }));
    const source = new MinimalModelSource(agentDir);
    const models = source.listModels();
    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({ kernel: "minimal", provider: "mock", id: "m1", name: "Mock 1" });
    expect(models[1]).toMatchObject({ kernel: "minimal", provider: "mock", id: "m2", name: "m2" }); // name 缺省回 id
  });

  it("无配置回落 echo 占位模型", () => {
    const source = new MinimalModelSource(agentDir);
    const models = source.listModels();
    expect(models).toEqual([{ kernel: "minimal", provider: "minimal", id: "echo", name: "Minimal Echo" }]);
  });
});
