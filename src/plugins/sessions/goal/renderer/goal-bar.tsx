// GoalBar —— 输入框上方(composerTop 槽)的目标状态横幅:显示当前目标 + 用户控制。
// 删改停全可见(用户要求 #6):停(pause)/恢复(resume)/改(edit,铅笔按钮进内联编辑)/
// 删(clear,垃圾桶)——编辑入口此前伪装成「轮次数字按钮」,不可发现,现为显式图标按钮。
// 数据源 = 本插件内的 useGoalController(续跑引擎同源,不跨 IPC)。
// 生效着色:边框/底纹/图标随 phase 变色——目标一开始就"看得出来"(用户要求 #4);
// 输入框本体的绿晕由 timeline 订阅 goal:state 事件挂 .pi-composer-goal,与此条同色呼应。
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Target, Play, Pause, Trash2, Check, Pencil } from "lucide-react";
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
  const { t } = useTranslation();
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

  const accent = phaseColor(goal.phase);
  return (
    <div
      data-goal-bar
      data-goal-phase={goal.phase}
      className="flex items-center gap-2 w-full rounded-[var(--radius-md)] px-3 py-1.5 mb-2 text-[length:var(--font-size-xs)]"
      style={{
        borderLeft: `3px solid ${accent}`,
        background: `color-mix(in srgb, ${accent} 12%, var(--color-surface))`,
      }}
      title={goal.objective}
    >
      <Target className="size-3.5 shrink-0" style={{ color: accent }} />
      {editing ? (
        <input
          className="flex-1 min-w-0 bg-transparent outline-none border-b border-[var(--color-border)] text-[var(--color-fg)]"
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
        <span className="flex-1 min-w-0 truncate text-[var(--color-fg)]">{goal.objective}</span>
      )}
      {editing ? (
        <button type="button" title={t("goal.bar.save")} aria-label={t("goal.bar.save")} onClick={commitEdit} className="text-[var(--color-accent-success)] hover:opacity-70">
          <Check className="size-3.5" />
        </button>
      ) : (
        <>
          {/* 轮次是纯展示(不再兼职编辑入口);编辑走显式铅笔按钮。 */}
          <span className="tabular-nums text-[var(--color-muted)] shrink-0">{goal.round}/{goal.maxRounds}</span>
          <button
            type="button"
            title={t("goal.bar.edit")}
            aria-label={t("goal.bar.edit")}
            onClick={() => { setDraft(goal.objective); setEditing(true); }}
            className="text-[var(--color-muted)] hover:opacity-70 shrink-0"
          >
            <Pencil className="size-3.5" />
          </button>
        </>
      )}
      {goal.phase === "active" ? (
        <button type="button" title={t("goal.bar.pause")} aria-label={t("goal.bar.pause")} onClick={pause} className="text-[var(--color-accent-warning)] hover:opacity-70 shrink-0">
          <Pause className="size-3.5" />
        </button>
      ) : (
        <button type="button" title={t("goal.bar.resume")} aria-label={t("goal.bar.resume")} onClick={resume} className="text-[var(--color-accent-success)] hover:opacity-70 shrink-0">
          <Play className="size-3.5" />
        </button>
      )}
      <button type="button" title={t("goal.bar.clear")} aria-label={t("goal.bar.clear")} onClick={clear} className="text-[var(--color-muted)] hover:opacity-70 shrink-0">
        <Trash2 className="size-3.5" />
      </button>
    </div>
  );
}
