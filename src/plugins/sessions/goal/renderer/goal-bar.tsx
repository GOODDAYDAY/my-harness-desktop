// GoalBar —— 输入框中段(composerStats 槽)的目标状态条:显示当前目标 + 用户控制。
// 停止(pause)= desktop 不再发送续跑;恢复(resume);编辑(edit,下次生效);关闭(clear)。
// 数据源 = 本插件内的 useGoalController(续跑引擎同源,不跨 IPC)。
import { useState } from "react";
import { Target, Play, Pause, Trash2, Check } from "lucide-react";
import { useGoalController } from "./goal-controller";

function phaseColor(phase: string): string {
  switch (phase) {
    case "active": return "var(--color-accent-success)";
    case "paused": return "var(--color-accent-warning)";
    case "achieved": return "var(--color-primary)";
    default: return "var(--color-muted)";
  }
}

export function GoalBar(): React.ReactNode {
  const { goal, pause, resume, edit, clear } = useGoalController();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  // 无目标不显示。
  if (goal === null) return null;

  const commitEdit = (): void => {
    const trimmed = draft.trim();
    if (trimmed === "") { setEditing(false); return; }
    edit(trimmed);
    setEditing(false);
  };

  return (
    <div
      className="flex items-center gap-1.5 max-w-[340px] shrink-0 rounded-[var(--radius-md)] px-2 py-0.5 text-[length:var(--font-size-xs)]"
      style={{ borderLeft: `2px solid ${phaseColor(goal.phase)}`, background: "color-mix(in srgb, var(--color-surface) 60%, transparent)" }}
      title={goal.objective}
    >
      <Target className="size-3.5 shrink-0 text-[var(--color-muted)]" />
      {editing ? (
        <input
          className="flex-1 min-w-0 bg-transparent outline-none border-b border-[var(--color-border)]"
          value={draft}
          autoFocus
          placeholder={goal.objective}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitEdit();
            if (e.key === "Escape") setEditing(false);
          }}
        />
      ) : (
        <span className="truncate text-[var(--color-fg)]">{goal.objective}</span>
      )}
      {editing ? (
        <button type="button" title="保存" onClick={commitEdit} className="text-[var(--color-accent-success)] hover:opacity-70">
          <Check className="size-3.5" />
        </button>
      ) : (
        <button
          type="button"
          title="编辑目标"
          onClick={() => { setDraft(goal.objective); setEditing(true); }}
          className="text-[var(--color-muted)] hover:opacity-70"
        >
          <span className="tabular-nums">{goal.round}/{goal.maxRounds}</span>
        </button>
      )}
      {goal.phase === "active" ? (
        <button type="button" title="停止" onClick={pause} className="text-[var(--color-accent-warning)] hover:opacity-70">
          <Pause className="size-3.5" />
        </button>
      ) : (
        <button type="button" title="恢复" onClick={resume} className="text-[var(--color-accent-success)] hover:opacity-70">
          <Play className="size-3.5" />
        </button>
      )}
      <button type="button" title="关闭目标" onClick={clear} className="text-[var(--color-muted)] hover:opacity-70">
        <Trash2 className="size-3.5" />
      </button>
    </div>
  );
}
