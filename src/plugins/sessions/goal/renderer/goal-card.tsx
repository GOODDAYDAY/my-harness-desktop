// GoalCard —— goal 三工具（get_goal/create_goal/update_goal）调用块的时间线渲染件（blockRenderers 槽）。
// 非交互：只渲染 args/result。与 DSH 的 goal toolview 行同语义——objective 一行 + phase/revision/rounds 元信息。
import { useState, useEffect, type ReactNode } from "react";
import { Target, Check, X, ChevronRight, ChevronDown } from "lucide-react";
import type { ToolCallBlock } from "@my-harness-desktop/react";

interface GoalView {
  id: string;
  revision: number;
  objective: string;
  phase: string;
  maxGoalRounds: number;
  roundsStarted: number;
  blockedReason?: { code: string; message: string };
}

interface GoalDetails {
  goal?: GoalView | null;
  activation?: string;
}

function phaseColor(phase: string): string {
  switch (phase) {
    case "active": return "var(--color-accent-success)";
    case "paused": return "var(--color-accent-warning)";
    case "blocked": return "var(--color-accent-error)";
    case "complete": return "var(--color-primary)";
    default: return "var(--color-muted)";
  }
}

export function GoalCard({ toolCall, collapseDefault = true }: { toolCall: ToolCallBlock; collapseDefault?: boolean }): ReactNode {
  const [collapsed, setCollapsed] = useState(collapseDefault);
  useEffect(() => { setCollapsed(collapseDefault); }, [collapseDefault]);

  const isStreaming = toolCall.state === "pending" || toolCall.state === "running";
  const details = (toolCall.result as { details?: GoalDetails } | undefined)?.details;
  const goal = details?.goal ?? null;
  const activation = details?.activation;
  const args = (toolCall.args ?? {}) as Record<string, unknown>;

  const summary = typeof args.objective === "string" && args.objective.length > 0
    ? args.objective
    : goal
      ? goal.objective
      : toolCall.name;

  const borderColor = toolCall.isError
    ? "var(--color-accent-error)"
    : goal
      ? phaseColor(goal.phase)
      : isStreaming
        ? "var(--color-accent-success)"
        : "var(--color-muted)";

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
        {!isStreaming && !toolCall.isError && goal && (
          <span className="text-xs" style={{ color: phaseColor(goal.phase) }}>{goal.phase}</span>
        )}
        {!isStreaming && !toolCall.isError && !goal && toolCall.name === "get_goal" && (
          <span className="text-xs text-[var(--color-muted)]">none</span>
        )}
        {!isStreaming && !toolCall.isError && <Check className="size-3.5 text-[var(--color-muted)]" />}
        <span className="text-[var(--color-muted)]">
          {collapsed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
        </span>
      </div>
      {!collapsed && goal && (
        <div className="mt-1 rounded-[var(--radius-md)] p-2.5 text-[length:var(--font-size-sm)] space-y-1"
          style={{ background: "color-mix(in srgb, var(--color-bg) 55%, var(--color-border))" }}>
          <div className="text-[var(--color-fg)] break-all">{goal.objective}</div>
          <div className="flex gap-3 text-xs text-[var(--color-muted)]">
            <span>phase: <span style={{ color: phaseColor(goal.phase) }}>{goal.phase}</span></span>
            <span>revision: {goal.revision}</span>
            <span>rounds: {goal.roundsStarted}/{goal.maxGoalRounds}</span>
            {activation && <span>activation: {activation}</span>}
          </div>
          {goal.blockedReason && (
            <div className="text-xs text-[var(--color-accent-error)] break-all">
              blocked: {goal.blockedReason.message}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
