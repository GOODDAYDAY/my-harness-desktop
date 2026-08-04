// 笔记贴纸（展示）+ 就地编辑器（新建/编辑共用）—— 面板与设置页两个视图共用的共享子组件（设计 §3.3）。
// 视觉是便利贴：StickerCard 提供倾斜/胶带/图钉/软投影（见 sticker.tsx），面板卡片与设置页网格同一张贴纸。

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, Globe, Folder, Loader2, Pencil, Send, TextCursorInput, Trash2 } from "lucide-react";
import { PanelIconButton } from "@pi-desktop/react";
import { StickerCard } from "./sticker";
import type { LayeredNote } from "../client/notes-store";

/** 展开态操作行按钮统一样式(设置页网格用)。 */
const actionBtnClass = "flex items-center gap-1 px-2 py-1 text-xs rounded-[var(--radius-xs)] border border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-fg)] bg-transparent cursor-pointer";

/** 复制到剪贴板 + 1.5s 勾态反馈：卡片(面板)与行(设置页)两处复用，收敛一处。 */
export function useCopyFeedback(text: string): { copied: boolean; copy: () => void } {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = useCallback((): void => {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  }, [text]);
  return { copied, copy };
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
  /** 填入输入框(不发送，供用户改后手动发；面板传)。 */
  onFillComposer?: () => void;
  /** 展开态(设置页网格用)：展示全文 + 操作行，由外层控制。 */
  expanded?: boolean;
  onToggleExpand?: () => void;
  /** 展开态操作行里的"发送进会话"（设置页传；面板点击即发送，不需要）。 */
  onSend?: () => void;
  sendDisabledReason?: string | null;
  /** 不渲染 hover 浮钮（设置页网格：一切操作收进展开态操作行）。 */
  hideHoverActions?: boolean;
  /** 外层容器附加样式(如设置页网格的最小高度)。 */
  style?: CSSProperties;
}

export function NoteCard({ note, onActivate, activateDisabledReason, sending, onEdit, onDelete, onMoveLayer, onFillComposer, expanded, onToggleExpand, onSend, sendDisabledReason, hideHoverActions, style }: NoteCardProps): ReactNode {
  const { t } = useTranslation();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const { copied, copy: copyContent } = useCopyFeedback(note.content);
  const disabled = Boolean(activateDisabledReason);
  const sendDisabled = Boolean(sendDisabledReason);
  return (
    <div
      className="group relative"
      onClick={() => {
        if (!disabled && !sending && onActivate) onActivate();
        else if (onToggleExpand) onToggleExpand();
      }}
      title={activateDisabledReason ?? undefined}
      style={{
        cursor: onActivate ? (disabled ? "not-allowed" : "pointer") : onToggleExpand ? "pointer" : undefined,
        opacity: disabled ? 0.6 : 1,
        ...style,
      }}
    >
      <StickerCard noteId={note.id}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            {note.title ? (
              <div className="flex items-center gap-1.5">
                {sending && <Loader2 className="size-3.5 animate-spin text-[var(--color-muted)] shrink-0" />}
                <span className="text-[length:var(--font-size-sm)] font-medium text-[var(--color-fg)] truncate">{note.title}</span>
              </div>
            ) : (
              sending && <Loader2 className="size-3.5 animate-spin text-[var(--color-muted)]" />
            )}
            <div
              className={`whitespace-pre-wrap break-words text-[var(--color-muted)] ${note.title ? "text-xs mt-1" : "text-[length:var(--font-size-sm)]"}`}
              style={expanded ? undefined : { display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}
            >
              {note.content}
            </div>
            {expanded && (
              <div className="flex items-center flex-wrap gap-1.5 mt-2" onClick={(e) => e.stopPropagation()}>
                {onSend && (
                  <button
                    className={actionBtnClass}
                    title={sendDisabledReason ?? undefined}
                    onClick={() => { if (!sendDisabled && !sending) onSend(); }}
                  >
                    {sending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}{t("notes.sendToSession")}
                  </button>
                )}
                {onEdit && (
                  <button className={actionBtnClass} onClick={onEdit}><Pencil className="size-3.5" />编辑</button>
                )}
                <button className={actionBtnClass} onClick={copyContent}>
                  {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}{copied ? "已复制" : "复制"}
                </button>
                {onMoveLayer && (
                  <button className={actionBtnClass} onClick={onMoveLayer}>
                    {note.layer === "project" ? <Globe className="size-3.5" /> : <Folder className="size-3.5" />}
                    {note.layer === "project" ? "设为全局" : "移到项目"}
                  </button>
                )}
                {onDelete && (
                  <button
                    className={actionBtnClass}
                    onClick={() => {
                      if (confirmingDelete) {
                        setConfirmingDelete(false);
                        onDelete();
                      } else {
                        setConfirmingDelete(true);
                      }
                    }}
                  >
                    <Trash2 className="size-3.5" />{confirmingDelete ? "确认删除？" : "删除"}
                  </button>
                )}
              </div>
            )}
          </div>
          <span
            className="shrink-0 text-[length:var(--font-size-xs)] text-[var(--color-muted)] border border-[var(--color-border)] rounded-[var(--radius-xs)] px-1 py-px"
            title={note.layer === "global" ? "全局层：所有项目可见（存在 ~/.pi-desktop/）" : "项目层：仅当前项目可见（存在项目目录 .pi-desktop/），可“设为全局”分享给所有项目"}
          >
            {note.layer === "global" ? "全局" : "项目"}
          </span>
        </div>
        {/* hover 操作扄右下角浮出：收进贴纸内部跟着一起歪；展开态由操作行接管不重复渲染 */}
        {!expanded && !hideHoverActions && (
          <div
            className="absolute bottom-1.5 right-1.5 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
            onClick={(e) => e.stopPropagation()}
          >
            <PanelIconButton title={copied ? "已复制" : "复制内容"} onClick={copyContent}>
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            </PanelIconButton>
            {onFillComposer && (
              <PanelIconButton title="填入输入框（不发送，可改后再发）" onClick={onFillComposer}>
                <TextCursorInput className="size-3.5" />
              </PanelIconButton>
            )}
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
      </StickerCard>
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

/** 就地编辑卡：标题可选 + 内容多行，保存/取消即时落盘（manual 语义，设计 §3.3）。
 *  编辑器不歪不装饰——输入中的卡面要稳。 */
export function NoteEditor({ initial, onSave, onCancel }: NoteEditorProps): ReactNode {
  const { t } = useTranslation();
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
    <StickerCard>
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={t("notes.titlePlaceholder")}
        autoFocus
        className="w-full bg-transparent border-0 border-b border-[var(--color-border)] px-0 py-1 text-[length:var(--font-size-sm)] text-[var(--color-fg)] placeholder:text-[var(--color-muted)] outline-none focus:border-[var(--color-primary)]"
      />
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder={t("notes.contentPlaceholder")}
        rows={4}
        className="w-full bg-transparent border-0 px-0 py-1.5 text-xs text-[var(--color-fg)] placeholder:text-[var(--color-muted)] outline-none resize-y"
      />
      <div className="flex justify-end gap-2 pt-1">
        <button
          onClick={onCancel}
          className="px-2.5 py-1 text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)] bg-transparent border-none cursor-pointer"
        >
          {t("notes.cancel")}
        </button>
        <button
          onClick={() => void save()}
          disabled={!content.trim() || saving}
          className="px-2.5 py-1 text-xs rounded-[var(--radius-sm)] bg-[var(--color-primary)] text-[var(--color-bg)] border-none cursor-pointer disabled:opacity-40"
        >
          {saving ? t("notes.saving") : t("notes.save")}
        </button>
      </div>
    </StickerCard>
  );
}
