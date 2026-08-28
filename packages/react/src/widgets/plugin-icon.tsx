import type { ReactNode } from "react";
import {
  MessagesSquare, GitBranch, GitFork, GitCompare, Activity, Files, ListTree, BarChart3,
  Folder, FolderOpen, Settings, Search, Puzzle,
  Bookmark, Eye, EyeOff, Pin, Wrench, Terminal, Paperclip, Palette, Star, SlidersHorizontal,
  Globe, Boxes, StickyNote, NotebookPen, NotebookText, MessageSquare, MessageSquarePlus, Power,
  Keyboard, MousePointerClick, RadioTower, Sparkles, Sticker,
  FileCode, FileJson, FileText, FileImage, FileVideo, FileAudio, FileArchive,
  FileSpreadsheet, FileTerminal, FileType, FileCog, FileLock, FileKey, FilePieChart,
  Database, Container, Binary, BookOpen, Network, Workflow, ScrollText,
  type LucideIcon,
} from "lucide-react";
import { KernelLogo } from "./kernel-logo";

const ICONS: Record<string, LucideIcon> = {
  "messages-square": MessagesSquare,
  "git-branch": GitBranch,
  "git-fork": GitFork,
  "git-compare": GitCompare,
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
  eye: Eye,
  "eye-off": EyeOff,
  pin: Pin,
  wrench: Wrench,
  terminal: Terminal,
  paperclip: Paperclip,
  palette: Palette,
  "sliders-horizontal": SlidersHorizontal,
  "message-square-plus": MessageSquarePlus,
  "message-square": MessageSquare,
  keyboard: Keyboard,
  "mouse-pointer-click": MousePointerClick,
  "radio-tower": RadioTower,
  sparkles: Sparkles,
  puzzle: Puzzle,
  network: Network,
  workflow: Workflow,
  "scroll-text": ScrollText,
  globe: Globe,
  boxes: Boxes,
  sticker: Sticker,
  "sticky-note": StickyNote,
  "notebook-pen": NotebookPen,
  "notebook-text": NotebookText,
  "file-code": FileCode,
  "file-json": FileJson,
  "file-text": FileText,
  "file-image": FileImage,
  "file-video": FileVideo,
  "file-audio": FileAudio,
  "file-archive": FileArchive,
  "file-spreadsheet": FileSpreadsheet,
  "file-terminal": FileTerminal,
  "file-type": FileType,
  "file-cog": FileCog,
  "file-lock": FileLock,
  "file-key": FileKey,
  "file-pie-chart": FilePieChart,
  database: Database,
  container: Container,
  binary: Binary,
  "book-open": BookOpen,
  power: Power,
};

export function PluginIcon({ name, className, style }: { name: string; className?: string; style?: React.CSSProperties }): ReactNode {
  // 内核身份标("pi"/"dsh")委托 KernelLogo:logo path 由内核自己在适配器里声明,
  // 壳不硬编码(机制与内容分离)。其余按 lucide 图标表解析,未知回落 Puzzle。
  if (name === "pi" || name === "dsh") return <KernelLogo kernel={name} className={className} style={style} />;
  const Icon = ICONS[name] ?? Puzzle;
  return <Icon className={className ?? "size-4"} style={style} />;
}

/** 按名取 lucide 组件,未知名返回 null(消费方自己定回退,不吃 PluginIcon 的 Puzzle 兜底)。 */
export function resolvePluginIcon(name: string): LucideIcon | null {
  return ICONS[name] ?? null;
}
