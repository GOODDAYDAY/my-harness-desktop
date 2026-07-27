// PluginIcon —— manifest 里的图标字符串 → lucide 组件的映射。
//
// sidePanel 贡献项的 icon 字段是字符串契约("git-branch" 等),
// 未知名字回退 Puzzle(插件通用图标)。映射表按需扩充。
import type { ReactNode } from "react";
import {
  MessagesSquare, GitBranch, Activity, Files, ListTree, BarChart3,
  Folder, FolderOpen, Settings, Search, Puzzle,
  type LucideIcon,
} from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  "messages-square": MessagesSquare,
  "git-branch": GitBranch,
  activity: Activity,
  files: Files,
  "list-tree": ListTree,
  "bar-chart-3": BarChart3,
  folder: Folder,
  "folder-open": FolderOpen,
  settings: Settings,
  search: Search,
};

export function PluginIcon({ name, className }: { name: string; className?: string }): ReactNode {
  const Icon = ICONS[name] ?? Puzzle;
  return <Icon className={className ?? "size-4"} />;
}
