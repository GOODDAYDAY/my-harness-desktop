export interface KnownTool {
  id: string;
  name: string;
  description: string;
  source: "builtin" | "extension";
  extensionId?: string;
}

export interface ToolGroup {
  id: string;
  name: string;
  description?: string;
  toolIds: string[];
  builtIn: boolean;
  icon?: string;
}

/** 契约单源：会话级工具过滤配置以圆心 domain 为唯一源，经 contract 发布面 re-export，不本地手抄。 */
export type { SessionToolConfig } from "@pi-desktop/contract";

/**
 * 工具名以底座注册名为准(@earendil-works/pi-coding-agent dist/core/tools:
 * read/write/edit/bash/find/grep/ls)——pi.setActiveTools 对未注册名静默忽略,
 * 写错名字的代价是白名单静默失效。web 组已删:底座核心无 web_search/web_fetch。
 */
export const PRESET_GROUPS: ToolGroup[] = [
  {
    id: "files",
    name: "文件操作",
    description: "文件读写、目录列表、文件搜索",
    toolIds: ["read", "write", "edit", "find", "grep", "ls"],
    builtIn: true,
    icon: "file-text",
  },
  {
    id: "exec",
    name: "命令执行",
    description: "执行 shell 命令（高风险，可独立关闭）",
    toolIds: ["bash"],
    builtIn: true,
    icon: "terminal",
  },
];

export const BUILTIN_TOOLS: KnownTool[] = [
  { id: "bash", name: "bash", description: "执行 shell 命令", source: "builtin" },
  { id: "read", name: "read", description: "读取文件内容", source: "builtin" },
  { id: "write", name: "write", description: "写入新文件", source: "builtin" },
  { id: "edit", name: "edit", description: "编辑文件", source: "builtin" },
  { id: "find", name: "find", description: "按模式搜索文件路径", source: "builtin" },
  { id: "grep", name: "grep", description: "搜索文件内容", source: "builtin" },
  { id: "ls", name: "ls", description: "列出目录内容", source: "builtin" },
];

export const TOOL_GROUPS_PATH = ".pi-desktop/config/tool-groups.json";

export function getToolGroupsPath(cwd: string): string {
  return `${cwd}/${TOOL_GROUPS_PATH}`;
}

export function computeDefaultGroupTools(allTools: KnownTool[], groups: ToolGroup[]): string[] {
  const assigned = new Set<string>();
  for (const g of groups) {
    if (g.id === "__default__") continue;
    for (const id of g.toolIds) assigned.add(id);
  }
  return allTools.map((t) => t.id).filter((id) => !assigned.has(id));
}

export function computeEnabledToolIds(
  groups: ToolGroup[],
  enabledGroupIds: string[],
  allTools: KnownTool[],
): string[] {
  const enabled = new Set<string>();
  for (const g of groups) {
    if (enabledGroupIds.includes(g.id)) {
      for (const id of g.toolIds) enabled.add(id);
    }
  }
  if (enabledGroupIds.includes("__default__")) {
    const defaultIds = computeDefaultGroupTools(allTools, groups);
    for (const id of defaultIds) enabled.add(id);
  }
  return [...enabled];
}

export function buildToolFilterInstruction(toolIds: string[]): string {
  return `[System] 本次会话已限制可用工具。\n可用工具: ${toolIds.join(", ")}\n请勿使用未在列表中的工具。`;
}
