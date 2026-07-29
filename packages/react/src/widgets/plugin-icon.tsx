import type { ReactNode } from "react";
import {
  MessagesSquare, GitBranch, Activity, Files, ListTree, BarChart3,
  Folder, FolderOpen, Settings, Search, Puzzle,
  Bookmark, EyeOff, Pin, Wrench, Terminal, Paperclip, Palette, Star, SlidersHorizontal,
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
  bookmark: Bookmark,
  star: Star,
  "eye-off": EyeOff,
  pin: Pin,
  wrench: Wrench,
  terminal: Terminal,
  paperclip: Paperclip,
  palette: Palette,
  "sliders-horizontal": SlidersHorizontal,
};

export function PluginIcon({ name, className, style }: { name: string; className?: string; style?: React.CSSProperties }): ReactNode {
  const Icon = ICONS[name] ?? Puzzle;
  return <Icon className={className ?? "size-4"} style={style} />;
}
