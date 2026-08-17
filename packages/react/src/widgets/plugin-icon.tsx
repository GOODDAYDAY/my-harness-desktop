import type { ReactNode } from "react";
import {
  MessagesSquare, GitBranch, GitFork, GitCompare, Activity, Files, ListTree, BarChart3,
  Folder, FolderOpen, Settings, Search, Puzzle,
  Bookmark, Eye, EyeOff, Pin, Wrench, Terminal, Paperclip, Palette, Star, SlidersHorizontal,
  Globe, Boxes, StickyNote, NotebookPen, NotebookText, MessageSquarePlus, Power,
  FileCode, FileJson, FileText, FileImage, FileVideo, FileAudio, FileArchive,
  FileSpreadsheet, FileTerminal, FileType, FileCog, FileLock, FileKey, FilePieChart,
  Database, Container, Binary, BookOpen, Network, Workflow, ScrollText,
  type LucideIcon,
} from "lucide-react";

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
  puzzle: Puzzle,
  network: Network,
  workflow: Workflow,
  "scroll-text": ScrollText,
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
  power: Power,
};

function PiLogo({ className, style }: { className?: string; style?: React.CSSProperties }): ReactNode {
  return (
    <svg viewBox="0 0 800 800" className={className ?? "size-4"} style={style} aria-label="pi logo">
      <path fill="currentColor" fillRule="evenodd" d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29Z M282.65 282.65V400H400V282.65Z" />
      <path fill="currentColor" d="M517.36 400H634.72V634.72H517.36Z" />
    </svg>
  );
}

/** dsh 内核标:DeepSeek 官方鲸鱼 mark,取自 simple-icons 的 deepseek.svg
 *  (单 path、currentColor、viewBox 0 0 24 24)。与 PiLogo 对称,是「内核身份进 UI」的原子单位。 */
function DshLogo({ className, style }: { className?: string; style?: React.CSSProperties }): ReactNode {
  return (
    <svg viewBox="0 0 24 24" className={className ?? "size-4"} style={style} aria-label="dsh logo">
      <path fill="currentColor" d="M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-1.361-.801-2.5-1.86-3.301-3.306-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774.868.86 1.525 1.887 2.202 2.89.72 1.066 1.494 2.082 2.48 2.915.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615zm1.001-6.44a.306.306 0 0 1 .415-.287.3.3 0 0 1 .113.074.3.3 0 0 1 .086.214c0 .17-.136.307-.308.307a.303.303 0 0 1-.306-.307m3.11 1.596c-.2.081-.4.151-.591.16a1.25 1.25 0 0 1-.798-.254c-.274-.23-.47-.358-.551-.758a1.7 1.7 0 0 1 .015-.588c.07-.327-.007-.537-.238-.727-.188-.156-.426-.199-.689-.199a.6.6 0 0 1-.254-.078.253.253 0 0 1-.114-.358 1 1 0 0 1 .192-.21c.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.392.451.462.576.685.915.176.264.336.536.446.848.066.194-.02.353-.25.45" />
    </svg>
  );
}

export function PluginIcon({ name, className, style }: { name: string; className?: string; style?: React.CSSProperties }): ReactNode {
  if (name === "pi") return <PiLogo className={className} style={style} />;
  if (name === "dsh") return <DshLogo className={className} style={style} />;
  const Icon = ICONS[name] ?? Puzzle;
  return <Icon className={className ?? "size-4"} style={style} />;
}

/** 按名取 lucide 组件,未知名返回 null(消费方自己定回退,不吃 PluginIcon 的 Puzzle 兜底)。 */
export function resolvePluginIcon(name: string): LucideIcon | null {
  return ICONS[name] ?? null;
}
