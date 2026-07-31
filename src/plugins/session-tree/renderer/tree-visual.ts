// tree-visual —— session-tree 渲染层共享视觉映射:entryType→图标、分组→圆点颜色。
// index.tsx(紧凑树)与 fullscreen-map.tsx(全景泳道)共用,避免两处各写一份。
import {
  User, Bot, Wrench, Terminal, Archive, Cpu, FileText, HelpCircle,
  Bookmark, GitFork,
} from "lucide-react";
import { groupOf } from "./tree-model";

const ICONS: Record<string, typeof User> = {
  user: User, assistant: Bot, toolResult: Wrench, bashExecution: Terminal,
  compaction: Archive, model_change: Cpu, thinking_level_change: Cpu,
  branch_summary: GitFork, compactionSummary: Archive, branchSummary: GitFork,
  label: Bookmark, label_reset: Bookmark, session_info: FileText,
  custom: HelpCircle, custom_message: FileText,
};

export function iconOf(entryType?: string): typeof User {
  return ICONS[entryType ?? ""] ?? HelpCircle;
}

export function dotColor(entryType?: string): string {
  switch (groupOf(entryType)) {
    case "chat": return "var(--color-primary)";
    case "tool": return "var(--color-accent-success)";
    case "label": return "var(--color-accent-warning)";
    default: return "var(--color-muted)";
  }
}
