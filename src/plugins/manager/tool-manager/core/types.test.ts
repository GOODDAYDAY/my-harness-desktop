// mergeKnownTools 单元测试 —— 三源合并的优先级与兜底语义(docs/design/tool-manager-design.md §4.4.4)。
import { describe, it, expect } from "vitest";
import { BUILTIN_TOOLS, mergeKnownTools, type KnownTool } from "./types";

const t = (id: string, over: Partial<KnownTool> = {}): KnownTool => ({
  id,
  name: id,
  description: "",
  source: "extension",
  ...over,
});

describe("mergeKnownTools", () => {
  it("播报缺席时落回 BUILTIN + 事件收集(过渡形态)", () => {
    const merged = mergeKnownTools(BUILTIN_TOOLS, [], [t("spawn_agent")]);
    expect(merged.map((x) => x.id)).toEqual([...BUILTIN_TOOLS.map((x) => x.id), "spawn_agent"]);
  });

  it("播报带来新工具及其真描述与来源", () => {
    const announced = [t("bus_status", { description: "查询总线状态", source: "extension", extensionId: "/x/bus/index.ts" })];
    const merged = mergeKnownTools(BUILTIN_TOOLS, announced, []);
    const hit = merged.find((x) => x.id === "bus_status");
    expect(hit?.description).toBe("查询总线状态");
    expect(hit?.extensionId).toBe("/x/bus/index.ts");
  });

  it("同名冲突以播报文件为准(覆盖 BUILTIN 与事件收集)", () => {
    const announced = [t("read", { description: "Reads a file", source: "builtin" })];
    const discovered = [t("read", { description: "", source: "extension" })];
    const merged = mergeKnownTools(BUILTIN_TOOLS, announced, discovered);
    const reads = merged.filter((x) => x.id === "read");
    expect(reads).toHaveLength(1);
    expect(reads[0].description).toBe("Reads a file");
  });

  it("事件收集只补未见过的名字,不覆盖 BUILTIN", () => {
    const merged = mergeKnownTools(BUILTIN_TOOLS, [], [t("bash", { description: "篡改" }), t("new_tool")]);
    expect(merged.find((x) => x.id === "bash")?.description).toBe("执行 shell 命令");
    expect(merged.some((x) => x.id === "new_tool")).toBe(true);
  });

  it("三源全空时为空列表", () => {
    expect(mergeKnownTools([], [], [])).toEqual([]);
  });
});
