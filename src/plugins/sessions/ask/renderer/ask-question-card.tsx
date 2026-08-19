// AskQuestionCard —— ask_user_question 工具调用块的时间线渲染件（blockRenderers 槽）。
// 与 DSH 的 AskQuestionRow 同语义：摘要展示交互结果而非 args 全文；运行中显示 waiting，
// 结算后展示 N/M answered 或 cancelled。交互收集由 AskHost（composer 等价物）承担。
import { useState, useEffect, type ReactNode } from "react";
import { MessageCircleQuestion, Check, X, ChevronRight, ChevronDown } from "lucide-react";
import type { ToolCallBlock } from "@my-harness-desktop/react";

interface AskResult {
  answers?: { id: string; selected?: string[]; custom?: string }[];
}

export function AskQuestionCard({ toolCall, collapseDefault = true }: { toolCall: ToolCallBlock; collapseDefault?: boolean }): ReactNode {
  const [collapsed, setCollapsed] = useState(collapseDefault);
  useEffect(() => { setCollapsed(collapseDefault); }, [collapseDefault]);

  const isStreaming = toolCall.state === "pending" || toolCall.state === "running";
  const result = (toolCall.result as AskResult | undefined)?.answers;

  const answeredCount = result?.filter((a) => (a.selected?.length ?? 0) > 0 || (a.custom ?? "").length > 0).length ?? 0;
  const totalCount = result?.length ?? 0;
  const summary = isStreaming
    ? "waiting"
    : result === undefined
      ? "answered"
      : totalCount > 0
        ? `${answeredCount}/${totalCount} answered`
        : "answered";

  const borderColor = toolCall.isError
    ? "var(--color-accent-error)"
    : isStreaming
      ? "var(--color-accent-success)"
      : "var(--color-primary)";

  return (
    <div className="mb-1.5">
      <div
        className="flex items-center gap-2 text-[length:var(--font-size-sm)] font-[var(--font-family-mono)] cursor-pointer rounded-[var(--radius-md)]"
        style={{
          borderLeft: `3px solid ${borderColor}`,
          background: "color-mix(in srgb, var(--color-surface) 30%, transparent)",
          padding: "5px 12px",
        }}
        onClick={() => setCollapsed((c) => !c)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setCollapsed((c) => !c); } }}
      >
        <span className="text-[var(--color-muted)]"><MessageCircleQuestion className="size-3.5" /></span>
        <span className="text-[var(--color-fg)] flex-1 truncate">ask_user_question</span>
        <span className="text-xs text-[var(--color-muted)]">{summary}</span>
        {isStreaming && <span className="text-xs text-[var(--color-accent-success)]">running</span>}
        {!isStreaming && toolCall.isError && <X className="size-3.5 text-[var(--color-accent-error)]" />}
        {!isStreaming && !toolCall.isError && <Check className="size-3.5 text-[var(--color-muted)]" />}
        <span className="text-[var(--color-muted)]">
          {collapsed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
        </span>
      </div>
      {!collapsed && result && (
        <div className="mt-1 rounded-[var(--radius-md)] p-2.5 text-[length:var(--font-size-sm)] space-y-1.5"
          style={{ background: "color-mix(in srgb, var(--color-bg) 55%, var(--color-border))" }}>
          {result.map((a) => (
            <div key={a.id} className="flex gap-2">
              <span className="text-[var(--color-muted)] shrink-0">{a.id}</span>
              <span className="text-[var(--color-fg)] break-all">
                {a.custom ? `(wrote) ${a.custom}` : (a.selected?.join(", ") || "(skipped)")}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
