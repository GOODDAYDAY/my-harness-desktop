import type { ReactNode } from "react";
import {
  MessagesSquare, GitBranch, Activity, Files, ListTree, BarChart3,
  Folder, FolderOpen, Settings, Search, Puzzle,
  Bookmark, EyeOff, Pin, Wrench, Terminal, Paperclip, Palette, Star, SlidersHorizontal,
  Globe, Boxes, StickyNote, NotebookPen, NotebookText,
  FileCode, FileJson, FileText, FileImage, FileVideo, FileAudio, FileArchive,
  FileSpreadsheet, FileTerminal, FileType, FileCog, FileLock, FileKey, FilePieChart,
  Database, Container, Binary, BookOpen,
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
  globe: Globe,
  boxes: Boxes,
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
};

function PiLogo({ className, style }: { className?: string; style?: React.CSSProperties }): ReactNode {
  return (
    <svg viewBox="0 0 800 800" className={className ?? "size-4"} style={style} aria-label="pi logo">
      <path fill="currentColor" fillRule="evenodd" d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29Z M282.65 282.65V400H400V282.65Z" />
      <path fill="currentColor" d="M517.36 400H634.72V634.72H517.36Z" />
    </svg>
  );
}

export function PluginIcon({ name, className, style }: { name: string; className?: string; style?: React.CSSProperties }): ReactNode {
  if (name === "pi") return <PiLogo className={className} style={style} />;
  const Icon = ICONS[name] ?? Puzzle;
  return <Icon className={className ?? "size-4"} style={style} />;
}

/** 按名取 lucide 组件,未知名返回 null(消费方自己定回退,不吃 PluginIcon 的 Puzzle 兜底)。 */
export function resolvePluginIcon(name: string): LucideIcon | null {
  return ICONS[name] ?? null;
}
