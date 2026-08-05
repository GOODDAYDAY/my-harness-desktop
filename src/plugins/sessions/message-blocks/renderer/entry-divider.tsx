// 分隔线块:会话流里的系统事件分隔(model 切换/思考强度/压缩/分支/重试等),
// 由 blockRenderers 槽贡献,timeline 查槽渲染——新 kind 由插件按 names 认领(设计 §4.1)。
// DIVIDER_ICONS 是本插件内部的兜底呈现表:表里没有的 kind 无图标(与搬家前行为一致),
// 任何插件可声明 names 精确接管;内置表随发版继续维护。
import { useState, type ReactNode } from "react";
import { Cpu, Brain, Archive, GitBranch, Pencil, Bookmark, FileQuestion, RotateCcw, ChevronDown, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";

const DIVIDER_ICONS: Record<string, ReactNode> = {
  model: <Cpu className="size-3" />,
  thinking: <Brain className="size-3" />,
  compaction: <Archive className="size-3" />,
  branch: <GitBranch className="size-3" />,
  info: <Pencil className="size-3" />,
  label: <Bookmark className="size-3" />,
  entry: <FileQuestion className="size-3" />,
  retry: <RotateCcw className="size-3" />,
};

export function EntryDivider({ kind, i18nKey, i18nArgs, detail, tone }: {
  kind: string;
  i18nKey: string;
  i18nArgs?: Record<string, unknown>;
  detail?: string;
  tone?: string;
}): ReactNode {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const text = t(i18nKey, i18nArgs);
  const colorClass = tone === "error" ? "text-[var(--color-accent-error)]" : "text-[var(--color-muted)]";
  return (
    <div className="select-none">
      <div className="flex items-center gap-3">
        <div className="flex-1 h-px bg-[var(--color-border)]" />
        <button
          onClick={() => detail && setOpen(!open)}
          className={`flex items-center gap-1.5 text-xs ${colorClass} bg-transparent border-none p-0 ${detail ? "cursor-pointer hover:text-[var(--color-fg)]" : "cursor-default"}`}
        >
          {DIVIDER_ICONS[kind] ?? DIVIDER_ICONS.info}
          {text}
          {detail && (open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />)}
        </button>
        <div className="flex-1 h-px bg-[var(--color-border)]" />
      </div>
      {open && detail && (
        <div className="mt-2 mx-auto max-w-[85%] rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs leading-5 text-[var(--color-muted)] whitespace-pre-wrap">
          {detail}
        </div>
      )}
    </div>
  );
}
