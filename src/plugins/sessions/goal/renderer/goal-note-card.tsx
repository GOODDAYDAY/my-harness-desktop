// GoalNoteCard —— goal 控制动作留痕卡(messageRenderers 槽,role=goal_note)。
//
// 设计 docs/design/goal.md §8.3:人对目标的每次操作(停/恢复/改/提限/删)与引擎的自动迁移
// (报错/中断/发送失败自动暂停)在会话流里留一张固定小卡——中立层会话注解,不写内核、
// 不进模型上下文。内容是机读 JSON({action, detail?}),渲染时按当前语言翻译(存储与语言解耦)。
// 形态与 GoalRoundCard 同族:居中窄卡、固定结构、默认不占视觉。
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Pause, Play, Pencil, Trash2, Gauge, AlertTriangle } from "lucide-react";
import type { MessageRendererProps } from "@my-harness-desktop/react";

/** 动作 → 图标:内容层映射,新增动作在这里加一行。 */
const ACTION_ICONS = {
  pause: Pause,
  resume: Play,
  edit: Pencil,
  limit: Gauge,
  clear: Trash2,
  auto_pause_error: AlertTriangle,
  auto_pause_interrupt: Pause,
  send_failed: AlertTriangle,
} as const;

type NoteAction = keyof typeof ACTION_ICONS;

interface GoalNoteData {
  action: NoteAction;
  detail?: string;
}

/** 解析注解内容(机读 JSON);畸形/旧格式回退 null → 卡片不渲染(不炸时间线)。 */
export function parseGoalNote(content: unknown): GoalNoteData | null {
  if (typeof content !== "string") return null;
  try {
    const v: unknown = JSON.parse(content);
    if (typeof v !== "object" || v === null) return null;
    const action = (v as Record<string, unknown>)["action"];
    if (typeof action !== "string" || !(action in ACTION_ICONS)) return null;
    const detail = (v as Record<string, unknown>)["detail"];
    return { action: action as NoteAction, ...(typeof detail === "string" ? { detail } : {}) };
  } catch {
    return null;
  }
}

export function GoalNoteCard({ message }: MessageRendererProps): ReactNode {
  const { t } = useTranslation();
  const data = parseGoalNote(message.content);
  if (!data) return null;
  const Icon = ACTION_ICONS[data.action];
  const text = t(`goal.note.${data.action}`, data.detail !== undefined ? { detail: data.detail } : undefined);
  return (
    <div className="flex justify-center my-1" data-goal-note>
      <div
        className="max-w-[85%] rounded-[var(--radius-md)] border px-3 py-1.5 text-[length:var(--font-size-xs)] flex items-center gap-1.5"
        style={{
          borderColor: "var(--color-border)",
          background: "color-mix(in srgb, var(--color-surface) 55%, transparent)",
          borderLeft: "3px solid var(--color-muted)",
        }}
      >
        <Icon className="size-3.5 shrink-0" style={{ color: "var(--color-muted)" }} />
        <span className="text-[var(--color-muted)] truncate">{text}</span>
      </div>
    </div>
  );
}
