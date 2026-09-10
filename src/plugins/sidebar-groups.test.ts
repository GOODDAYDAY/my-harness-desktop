// sidebar 槽拓扑静态守卫(§3.7 守卫闭环)——把"左栏能不能拖"钉成 manifest 级不变量。
//
// 根因背景(实弹):projects / sessions-list / sub-agent 三个 sidebar 贡献项都写了
// group:"main"。前端 groupItems() 按 group 并组、同组塞进同一个 Panel,而壳只在
// **组之间**渲染 PanelResizeHandle——于是整个左栏 0 条手柄,项目区与会话区之间
// "怎么拖都不动",且没有任何报错(纯布局语义,类型检查与运行时全绿)。
// 本守卫把四条不变量钉住,防它换个形状回潮:
//   1) 内置 sidebar 贡献项 ≥ 2 个不同 group —— 否则一条可拖拽分隔线都没有;
//   2) 项目区(projects)与会话区(sessions)不同 group —— 这两块必须能上下拉;
//   3) 会渲染 null 的贡献项不得独占一组 —— Panel 按份额占位,空组会留一块填不上的空白
//      (sub-agent 无活跃子 agent 时组件 return null,这是它必须与 sessions-list 同组的原因);
//   4) defaultSize 是 1–99 的整数百分比,且同组只由一个插件声明(壳取组内首项,不许歧义)。
import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { readManifest, walkPluginDirs } from "./manifest-scan";

interface SidebarRow {
  pluginId: string;
  id: string;
  component: string;
  order: number;
  group?: string;
  defaultSize?: number;
}

const PLUGINS_ROOT = resolve(__dirname, ".");

/** 全插件 sidebar 贡献项(按 order 升序 —— 与壳侧 slots:sidebar 出的顺序同口径)。 */
function sidebarRows(): SidebarRow[] {
  const rows: SidebarRow[] = [];
  for (const dir of walkPluginDirs(PLUGINS_ROOT)) {
    const m = readManifest(dir);
    const items = m.contributes?.sidebar;
    if (!Array.isArray(items)) continue;
    for (const it of items as Record<string, unknown>[]) {
      rows.push({
        pluginId: m.id,
        id: String(it.id ?? ""),
        component: String(it.component ?? ""),
        order: typeof it.order === "number" ? it.order : 100,
        group: typeof it.group === "string" && it.group ? it.group : undefined,
        defaultSize: typeof it.defaultSize === "number" ? it.defaultSize : undefined,
      });
    }
  }
  return rows.sort((a, b) => a.order - b.order);
}

/** group key = 声明值 ?? 贡献项 id(与前端 groupItems() 同口径)。 */
const groupKey = (r: SidebarRow): string => r.group ?? r.id;

/** 已知「无内容时渲染 null」的贡献项:独占一组时其 Panel 仍按份额占位 → 左栏留白。 */
const NULL_RENDERING = new Set(["sub-agents"]);

describe("sidebar 槽拓扑:分组不变量(左栏能不能拖 / 空组占位)", () => {
  const rows = sidebarRows();
  const groups = [...new Set(rows.map(groupKey))];

  it("扫描到 sidebar 贡献项(防扫描漂移成 0)", () => {
    expect(rows.length).toBeGreaterThanOrEqual(3);
  });

  it("至少两个不同 group —— 壳只在组间渲染手柄,全在一组就是 0 条手柄", () => {
    expect(groups.length).toBeGreaterThanOrEqual(2);
  });

  it("项目区与会话区不同 group(否则两块之间没有可拖拽分隔线)", () => {
    const projects = rows.find((r) => r.id === "projects");
    const sessions = rows.find((r) => r.id === "sessions");
    expect(projects).toBeTruthy();
    expect(sessions).toBeTruthy();
    expect(groupKey(projects!)).not.toBe(groupKey(sessions!));
  });

  it("渲染 null 的贡献项不独占一组(空 Panel 按份额占位,会留白)", () => {
    const offenders: string[] = [];
    for (const key of groups) {
      const members = rows.filter((r) => groupKey(r) === key);
      if (members.length === 1 && NULL_RENDERING.has(members[0].id)) {
        offenders.push(`${members[0].pluginId}.${members[0].id}(独占 group「${key}」)`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("defaultSize 是 1–99 的整数百分比(越界会让首屏比例失真)", () => {
    const bad = rows.filter(
      (r) => r.defaultSize != null && (!Number.isInteger(r.defaultSize) || r.defaultSize <= 0 || r.defaultSize >= 100),
    );
    expect(bad.map((r) => `${r.pluginId}.${r.id}=${r.defaultSize}`)).toEqual([]);
  });

  it("同组最多一个插件声明 defaultSize(壳取组内首项,多写即语义歧义)", () => {
    const dup: string[] = [];
    for (const key of groups) {
      const decl = rows.filter((r) => groupKey(r) === key && r.defaultSize != null);
      if (decl.length > 1) dup.push(`${key}: ${decl.map((r) => `${r.pluginId}.${r.id}`).join(", ")}`);
    }
    expect(dup).toEqual([]);
  });
});
