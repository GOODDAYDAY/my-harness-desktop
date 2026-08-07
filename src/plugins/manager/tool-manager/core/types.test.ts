// mergeKnownTools 单元测试 —— 三源合并的优先级与兜底语义(docs/design/tool-manager-design.md §4.4.4)。
import { describe, it, expect } from "vitest";
import {
  ALL_GROUP_ID,
  BUILTIN_TOOLS,
  PRESET_GROUPS,
  computeDefaultGroupTools,
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
    { id: "files", name: "文件操作", toolIds: ["read"], builtIn: true },
    { id: "exec", name: "命令执行", toolIds: ["bash"], builtIn: true },
  ];

  it("旧内置组被当前预设整体替换", () => {
    const out = reconcilePresetGroups(legacyBuiltin);
    expect(out.map((g) => g.id)).toEqual(PRESET_GROUPS.map((g) => g.id));
  });

  it("自定义组原样保留且排在预设之后", () => {
    const custom: ToolGroup = { id: "custom-1", name: "沙箱", toolIds: ["read"], builtIn: false };
    const out = reconcilePresetGroups([...legacyBuiltin, custom]);
    expect(out).toHaveLength(PRESET_GROUPS.length + 1);
    expect(out[out.length - 1]).toEqual(custom);
  });
});

describe("computeEnabledToolIds / ALL_GROUP_ID", () => {
  it("__all__ 展开为全部已知工具", () => {
    const all = [t("read"), t("bash"), t("bus_status")];
    expect(computeEnabledToolIds([], [ALL_GROUP_ID], all).sort()).toEqual(["bash", "bus_status", "read"]);
  });

  it("__all__ 是虚拟组,其 toolIds 不占默认组的名额", () => {
    const allVirtual: ToolGroup = { id: ALL_GROUP_ID, name: "全部", toolIds: ["read"], builtIn: true };
    expect(computeDefaultGroupTools([t("read"), t("bash")], [allVirtual])).toEqual(["read", "bash"]);
  });
});
