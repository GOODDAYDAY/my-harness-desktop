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

export interface SessionToolConfig {
  mode: "all" | "custom";
  enabledGroupIds: string[];
}

export const PRESET_GROUPS: ToolGroup[] = [
  {
    id: "files",
    name: "文件操作",
    description: "文件读写、目录列表、文件搜索",
    toolIds: ["read_file", "edit_file", "write_file", "glob", "list_dir", "read_file_lines"],
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
  {
    id: "web",
    name: "网络访问",
    description: "网页搜索、URL 抓取",
    toolIds: ["web_search", "web_fetch"],
    builtIn: true,
    icon: "globe",
  },
];

export const BUILTIN_TOOLS: KnownTool[] = [
  { id: "bash", name: "bash", description: "执行 shell 命令", source: "builtin" },
  { id: "read_file", name: "read_file", description: "读取文件内容", source: "builtin" },
  { id: "edit_file", name: "edit_file", description: "编辑文件", source: "builtin" },
  { id: "write_file", name: "write_file", description: "写入新文件", source: "builtin" },
  { id: "glob", name: "glob", description: "按模式搜索文件路径", source: "builtin" },
  { id: "grep", name: "grep", description: "搜索文件内容", source: "builtin" },
  { id: "list_dir", name: "list_dir", description: "列出目录内容", source: "builtin" },
  { id: "read_file_lines", name: "read_file_lines", description: "按行范围读取文件", source: "builtin" },
  { id: "web_search", name: "web_search", description: "网络搜索", source: "builtin" },
  { id: "web_fetch", name: "web_fetch", description: "抓取网页内容", source: "builtin" },
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
