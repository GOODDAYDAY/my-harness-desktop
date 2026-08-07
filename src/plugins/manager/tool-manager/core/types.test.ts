// mergeKnownTools 单元测试 —— 三源合并的优先级与兜底语义(docs/design/tool-manager-design.md §4.4.4)。
import { describe, it, expect } from "vitest";
import {
  BUILTIN_TOOLS,
  PRESET_GROUPS,
  computeDefaultEnabledGroupIds,
  computeEnabledToolIds,
  mergeKnownTools,
  reconcilePresetGroups,
  type KnownTool,
  type ToolGroup,
} from "./types";

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

describe("reconcilePresetGroups", () => {
  const legacyBuiltin: ToolGroup[] = [
    { id: "files", name: "文件操作", toolIds: ["read"], builtIn: true, defaultEnabled: true },
    { id: "exec", name: "命令执行", toolIds: ["bash"], builtIn: true, defaultEnabled: true },
  ];

  it("旧内置组被当前预设整体替换", () => {
    const out = reconcilePresetGroups(legacyBuiltin);
    expect(out.map((g) => g.id)).toEqual(PRESET_GROUPS.map((g) => g.id));
  });

  it("自定义组原样保留且排在预设之后", () => {
    const custom: ToolGroup = { id: "custom-1", name: "沙箱", toolIds: ["read"], builtIn: false, defaultEnabled: false };
    const out = reconcilePresetGroups([...legacyBuiltin, custom]);
    expect(out).toHaveLength(PRESET_GROUPS.length + 1);
    expect(out[out.length - 1]).toEqual(custom);
  });

  it("同 id 内置组的 defaultEnabled 用户覆盖被保留(结构换新、状态归用户)", () => {
    const stored: ToolGroup[] = [{ id: "bus", name: "旧名", toolIds: ["旧"], builtIn: true, defaultEnabled: false }];
    const out = reconcilePresetGroups(stored);
    const bus = out.find((g) => g.id === "bus");
    expect(bus?.toolIds).toEqual(PRESET_GROUPS.find((g) => g.id === "bus")?.toolIds);
    expect(bus?.defaultEnabled).toBe(false);
  });

  it("缺 defaultEnabled 字段的旧数据补默认 true", () => {
    const legacy = [{ id: "custom-9", name: "旧自定义", toolIds: ["read"], builtIn: false } as ToolGroup];
    const out = reconcilePresetGroups(legacy);
    expect(out.find((g) => g.id === "custom-9")?.defaultEnabled).toBe(true);
  });
});

describe("computeDefaultEnabledGroupIds", () => {
  it("默认 = defaultEnabled 的组 + __default__", () => {
    const custom: ToolGroup = { id: "custom-1", name: "沙箱", toolIds: [], builtIn: false, defaultEnabled: false };
    const ids = computeDefaultEnabledGroupIds([...PRESET_GROUPS, custom]);
    expect(ids).toEqual([...PRESET_GROUPS.map((g) => g.id), "__default__"]);
    expect(ids).not.toContain("custom-1");
  });
});

describe("computeEnabledToolIds", () => {
  it("__default__ 展开为未被任何组收录的工具", () => {
    const all = [t("read"), t("bash"), t("bus_status")];
    expect(computeEnabledToolIds(PRESET_GROUPS, ["__default__"], all)).toEqual([]);
    const custom: ToolGroup = { id: "custom-1", name: "沙箱", toolIds: ["read"], builtIn: false, defaultEnabled: true };
    expect(computeEnabledToolIds([custom], ["__default__"], all).sort()).toEqual(["bash", "bus_status"]);
  });
});
