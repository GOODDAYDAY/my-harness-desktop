export interface KnownTool {
  id: string;
  name: string;
  description: string;
  source: "builtin" | "extension" | "cordis";
  extensionId?: string;
}

export interface ToolGroup {
  id: string;
  name: string;
  description?: string;
  toolIds: string[];
  builtIn: boolean;
  icon?: string;
  /** 无 session 级配置时该组的默认开关。旧数据缺省视为 true(迁移前语义即全开)。 */
  defaultEnabled: boolean;
}

/** 契约单源：会话级工具过滤配置以圆心 domain 为唯一源，经 contract 发布面 re-export，不本地手抄。 */
export type { SessionToolConfig } from "@my-harness-desktop/contract";

/** 工具名以底座注册名为准——pi.setActiveTools 对未注册名静默忽略,
 * 写错名字的代价是白名单静默失效。三组来源:
 * 核心 7 个(@earendil-works/pi-coding-agent dist/core/tools: read/write/edit/bash/find/grep/ls)、
 * bus 扩展 6 个(packages/bus-extension/tools/)、subagent 扩展 5 个(packages/subagent-extension/tools/)。
 */
export const PRESET_GROUPS: ToolGroup[] = [
  {
    id: "readonly",
    name: "只读",
    description: "读取与搜索，不改动任何文件",
    toolIds: ["read", "find", "grep", "ls"],
    builtIn: true,
    icon: "eye",
    defaultEnabled: true,
  },
  {
    id: "writeonly",
    name: "只写",
    description: "写入、编辑与命令执行",
    toolIds: ["write", "edit", "bash"],
    builtIn: true,
    icon: "pencil",
    defaultEnabled: true,
  },
  {
    id: "bus",
    name: "bus",
    description: "Session Bus 会话编排",
    toolIds: ["bus_status", "session_create", "session_abort", "channel_member", "tap_start", "tap_stop"],
    builtIn: true,
    icon: "radio",
    defaultEnabled: true,
  },
  {
    id: "subagent",
    name: "subagent",
    description: "子代理派生与协作",
    toolIds: ["spawn_subagent", "send_to_subagent", "wait_subagent", "list_subagents", "abort_subagent"],
    builtIn: true,
    icon: "bot",
    defaultEnabled: true,
  },
];

/** 内置组随代码换新(迁移纪律):stored 里的 builtIn 组(含旧预设 files/exec)整体丢弃,
 *  结构(name/description/toolIds)以当前 PRESET_GROUPS 为准;defaultEnabled 是用户偏好,
 *  同 id 旧组有显式覆盖时保留(结构归框架、状态归用户);自定义组原样保留(缺省值补 true)。
 *  纯函数不写盘——落盘等用户下次 save 顺带完成,load 路径写盘会触发 settings:changed 广播回环。 */
export function reconcilePresetGroups(stored: ToolGroup[]): ToolGroup[] {
  const overrideById = new Map(stored.map((g) => [g.id, g.defaultEnabled]));
  return [
    ...PRESET_GROUPS.map((p) => {
      const override = overrideById.get(p.id);
      return typeof override === "boolean" ? { ...p, defaultEnabled: override } : p;
    }),
    ...stored
      .filter((g) => !g.builtIn)
      .map((g) => (typeof g.defaultEnabled === "boolean" ? g : { ...g, defaultEnabled: true })),
  ];
}

/** 无 session 配置时的默认启用组:stored 里 defaultEnabled 的组。
 *  未被任何组收录的工具不在组体系内、恒可用(见 computeEnabledToolIds),无需兜底层。 */
export function computeDefaultEnabledGroupIds(groups: ToolGroup[]): string[] {
  return groups.filter((g) => g.defaultEnabled).map((g) => g.id);
}

export const BUILTIN_TOOLS: KnownTool[] = [
  { id: "bash", name: "bash", description: "执行 shell 命令", source: "builtin" },
  { id: "read", name: "read", description: "读取文件内容", source: "builtin" },
  { id: "write", name: "write", description: "写入新文件", source: "builtin" },
  { id: "edit", name: "edit", description: "编辑文件", source: "builtin" },
  { id: "find", name: "find", description: "按模式搜索文件路径", source: "builtin" },
  { id: "grep", name: "grep", description: "搜索文件内容", source: "builtin" },
  { id: "ls", name: "ls", description: "列出目录内容", source: "builtin" },
];

export function computeEnabledToolIds(
  groups: ToolGroup[],
  enabledGroupIds: string[],
  allTools: KnownTool[],
): string[] {
  // 显式空数组 = 全禁(v7 契约,无兜底——tool-gate setActiveTools([]) 硬禁全部)。
  if (enabledGroupIds.length === 0) return [];
  const enabled = new Set<string>();
  for (const g of groups) {
    if (enabledGroupIds.includes(g.id)) {
      for (const id of g.toolIds) enabled.add(id);
    }
  }
  // 未被任何组收录的工具恒并入:组开关只控制组内工具,新扩展工具开箱可用(默认全开),
  // 不被静默挡在门外——想禁用某个未分组工具,把它加进某个组再关组。
  const assigned = new Set<string>();
  for (const g of groups) {
    for (const id of g.toolIds) assigned.add(id);
  }
  for (const t of allTools) {
    if (!assigned.has(t.id)) enabled.add(t.id);
  }
  return [...enabled];
}

/** 三源合并(docs/design/tool-manager-design.md §4.4.4):BUILTIN 兜底底版 ∪ 播报权威 ∪ 事件收集增量。
 *  同名冲突以播报文件为准(真描述真来源),其余来源先见先得。 */
export function mergeKnownTools(builtin: KnownTool[], announced: KnownTool[], discovered: KnownTool[]): KnownTool[] {
  const merged = new Map<string, KnownTool>();
  for (const t of builtin) merged.set(t.id, t);
  for (const t of discovered) if (!merged.has(t.id)) merged.set(t.id, t);
  for (const t of announced) merged.set(t.id, t);
  return [...merged.values()];
}
