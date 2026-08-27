// GoalCard —— set_goal / achieve_goal 两个工具调用块的时间线渲染件(blockRenderers 槽)。
// 非交互:只渲染 args/result。set_goal 展示 objective + max_rounds;achieve_goal 展示达成态。
// 状态机与续跑都在壳层(application/goal-driver),本卡片只做内容呈现,不持有状态。
import { useState, useEffect, type ReactNode } from "react";
import { Target, Check, X, ChevronRight, ChevronDown } from "lucide-react";
import type { ToolCallBlock } from "@my-harness-desktop/react";

export function GoalCard({ toolCall, collapseDefault = true }: { toolCall: ToolCallBlock; collapseDefault?: boolean }): ReactNode {
  const [collapsed, setCollapsed] = useState(collapseDefault);
  useEffect(() => { setCollapsed(collapseDefault); }, [collapseDefault]);

  const isStreaming = toolCall.state === "pending" || toolCall.state === "running";
  const args = (toolCall.args ?? {}) as Record<string, unknown>;
  const isAchieve = toolCall.name === "achieve_goal";
  const summary = isAchieve
    ? "目标达成"
    : (typeof args.objective === "string" && args.objective.trim() !== "" ? args.objective : toolCall.name);

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
        <span className="text-[var(--color-muted)]"><Target className="size-3.5" /></span>
        <span className="text-[var(--color-fg)] flex-1 truncate">{summary}</span>
        {isStreaming && <span className="text-xs text-[var(--color-accent-success)]">running</span>}
        {!isStreaming && toolCall.isError && <X className="size-3.5 text-[var(--color-accent-error)]" />}
        {!isStreaming && !toolCall.isError && <Check className="size-3.5 text-[var(--color-muted)]" />}
        <span className="text-[var(--color-muted)]">
          {collapsed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
        </span>
      </div>
      {!collapsed && !isAchieve && typeof args.objective === "string" && (
        <div className="mt-1 rounded-[var(--radius-md)] p-2.5 text-[length:var(--font-size-sm)] space-y-1"
          style={{ background: "color-mix(in srgb, var(--color-bg) 55%, var(--color-border))" }}>
          <div className="text-[var(--color-fg)] break-all">{args.objective}</div>
          {typeof args.max_rounds === "number" && (
            <div className="text-xs text-[var(--color-muted)]">max rounds: {args.max_rounds}</div>
          )}
        </div>
      )}
    </div>
  );
}
