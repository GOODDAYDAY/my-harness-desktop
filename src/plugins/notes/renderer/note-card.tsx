// 笔记卡片（展示）+ 就地编辑器（新建/编辑共用）—— 面板与设置页两个视图共用的共享子组件（设计 §3.3）。

import { useState, type ReactNode } from "react";
import { Globe, Folder, Loader2, Pencil, Trash2 } from "lucide-react";
import { PanelCard, PanelIconButton } from "@pi-desktop/react";
import type { LayeredNote } from "./notes-store";

/** 无标题时取内容开头当摘要（设计 §2.1）。 */
export function noteSummary(note: { title?: string; content: string }): string {
  return note.title ?? note.content.slice(0, 120);
}

interface NoteCardProps {
  note: LayeredNote;
  /** 主点击（面板=发送；设置页不传）。 */
  onActivate?: () => void;
  /** 主点击被禁用时的原因（tooltip），如"等待当前回复完成"。 */
  activateDisabledReason?: string | null;
  sending?: boolean;
  onEdit?: () => void;
  onDelete?: () => void;
  /** 层间迁移：project→global 传"设为全局"，global→project 传"移到项目"。 */
  onMoveLayer?: () => void;
}

export function NoteCard({ note, onActivate, activateDisabledReason, sending, onEdit, onDelete, onMoveLayer }: NoteCardProps): ReactNode {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const disabled = Boolean(activateDisabledReason);
  return (
    <div
      className="group relative"
      onClick={() => {
        if (!disabled && !sending && onActivate) onActivate();
      }}
      title={activateDisabledReason ?? undefined}
      style={{ cursor: onActivate ? (disabled ? "not-allowed" : "pointer") : undefined, opacity: disabled ? 0.6 : 1 }}
    >
      <PanelCard>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            {note.title ? (
              <div className="flex items-center gap-1.5">
                {sending && <Loader2 className="size-3.5 animate-spin text-[var(--color-muted)] shrink-0" />}
                <span className="text-[var(--font-size-sm)] font-medium text-[var(--color-fg)] truncate">{note.title}</span>
              </div>
            ) : (
              sending && <Loader2 className="size-3.5 animate-spin text-[var(--color-muted)]" />
            )}
            <div
              className={`whitespace-pre-wrap break-words text-[var(--color-muted)] ${note.title ? "text-xs mt-1" : "text-[var(--font-size-sm)]"}`}
              style={{ display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}
            >
              {note.content}
            </div>
          </div>
          <span className="shrink-0 text-[10px] text-[var(--color-muted)] border border-[var(--color-border)] rounded-[var(--radius-xs)] px-1 py-px">
            {note.layer === "global" ? "全局" : "项目"}
          </span>
        </div>
      </PanelCard>
      {(onEdit || onDelete || onMoveLayer) && (
        <div
          className="absolute top-1.5 right-1.5 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={(e) => e.stopPropagation()}
        >
          {onMoveLayer && (
            <PanelIconButton title={note.layer === "project" ? "设为全局" : "移到项目"} onClick={onMoveLayer}>
              {note.layer === "project" ? <Globe className="size-3.5" /> : <Folder className="size-3.5" />}
            </PanelIconButton>
          )}
          {onEdit && (
            <PanelIconButton title="编辑" onClick={onEdit}>
              <Pencil className="size-3.5" />
            </PanelIconButton>
          )}
          {onDelete && (
            <PanelIconButton
              title={confirmingDelete ? "确认删除？" : "删除"}
              danger
              onClick={() => {
                if (confirmingDelete) {
                  setConfirmingDelete(false);
                  onDelete();
                } else {
                  setConfirmingDelete(true);
                }
              }}
            >
              <Trash2 className="size-3.5" />
            </PanelIconButton>
          )}
        </div>
      )}
    </div>
  );
}

export interface NoteDraft {
  title: string;
  content: string;
}

interface NoteEditorProps {
  initial: NoteDraft;
  onSave: (draft: NoteDraft) => void | Promise<void>;
  onCancel: () => void;
}

/** 就地编辑卡：标题可选 + 内容多行，保存/取消即时落盘（manual 语义，设计 §3.3）。 */
export function NoteEditor({ initial, onSave, onCancel }: NoteEditorProps): ReactNode {
  const [title, setTitle] = useState(initial.title);
  const [content, setContent] = useState(initial.content);
  const [saving, setSaving] = useState(false);
  const save = async (): Promise<void> => {
    if (!content.trim() || saving) return;
    setSaving(true);
    try {
      await onSave({ title, content });
    } finally {
      setSaving(false);
    }
  };
  return (
    <PanelCard>
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="标题（可选）"
        autoFocus
        className="w-full bg-transparent border-0 border-b border-[var(--color-border)] px-0 py-1 text-[var(--font-size-sm)] text-[var(--color-fg)] placeholder:text-[var(--color-muted)] outline-none focus:border-[var(--color-primary)]"
      />
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="内容——点击卡片时原样发送给当前会话"
        rows={4}
        className="w-full bg-transparent border-0 px-0 py-1.5 text-xs text-[var(--color-fg)] placeholder:text-[var(--color-muted)] outline-none resize-y"
      />
      <div className="flex justify-end gap-2 pt-1">
        <button
          onClick={onCancel}
          className="px-2.5 py-1 text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)] bg-transparent border-none cursor-pointer"
        >
          取消
        </button>
        <button
          onClick={() => void save()}
          disabled={!content.trim() || saving}
          className="px-2.5 py-1 text-xs rounded-[var(--radius-sm)] bg-[var(--color-primary)] text-[var(--color-bg)] border-none cursor-pointer disabled:opacity-40"
        >
          {saving ? "保存中…" : "保存"}
        </button>
      </div>
    </PanelCard>
  );
}
