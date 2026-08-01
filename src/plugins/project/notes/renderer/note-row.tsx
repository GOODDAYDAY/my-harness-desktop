// 设置页行式笔记项 —— 分层管理页的列表行（低保真方向 A）：手柄拖拽 + 标题/摘要 + hover 行尾操作组。
// 与面板卡片(NoteCard)分家：卡片服务"点击即发送"的便签场景，行服务"管理"场景——
// 行整体不可点，一切操作走行尾按钮；编辑态由外层在行位置直接替换渲染 NoteEditor。

import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, Folder, Globe, GripVertical, Loader2, Pencil, Send, Trash2 } from "lucide-react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ListItem, PanelIconButton } from "@pi-desktop/react";
import { useCopyFeedback } from "./note-card";
import type { LayeredNote } from "../client/notes-store";

interface NoteRowProps {
  note: LayeredNote;
  /** 拖拽手柄元素（由 SortableNoteRow 注入 dnd listeners；行本体不碰 dnd 类型）。 */
  grip?: ReactNode;
  /** 发送禁用原因（tooltip），如"等待当前回复完成"。 */
  sendDisabledReason?: string | null;
  sending?: boolean;
  onSend?: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onMoveLayer: () => void;
}

export function NoteRow({ note, grip, sendDisabledReason, sending, onSend, onEdit, onDelete, onMoveLayer }: NoteRowProps): ReactNode {
  const { t } = useTranslation();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const { copied, copy } = useCopyFeedback(note.content);
  const sendDisabled = Boolean(sendDisabledReason);
  return (
    <ListItem style={{ cursor: "default", position: "relative" }}>
      <div className="group flex items-start gap-1.5">
        {grip}
        <div className="min-w-0 flex-1">
          {note.title ? (
            <>
              <div className="flex items-center gap-1.5 text-[var(--font-size-sm)] font-medium text-[var(--color-fg)]">
                {sending && <Loader2 className="size-3.5 animate-spin text-[var(--color-muted)] shrink-0" />}
                <span className="truncate">{note.title}</span>
              </div>
              <div className="text-xs text-[var(--color-muted)] truncate mt-0.5" title={note.content}>{note.content}</div>
            </>
          ) : (
            <div className="flex items-center gap-1.5 text-[var(--font-size-sm)] text-[var(--color-fg)]">
              {sending && <Loader2 className="size-3.5 animate-spin text-[var(--color-muted)] shrink-0" />}
              <span className="truncate">{note.content}</span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
          {onSend && (
            <PanelIconButton title={sendDisabledReason ?? t("notes.sendToSession")} onClick={() => { if (!sendDisabled && !sending) onSend(); }}>
              {sending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
            </PanelIconButton>
          )}
          <PanelIconButton title={copied ? t("notes.copied") : t("notes.copy")} onClick={copy}>
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </PanelIconButton>
          <PanelIconButton title={t("notes.edit")} onClick={onEdit}>
            <Pencil className="size-3.5" />
          </PanelIconButton>
          <PanelIconButton title={note.layer === "project" ? t("notes.moveToGlobal") : t("notes.moveToProject")} onClick={onMoveLayer}>
            {note.layer === "project" ? <Globe className="size-3.5" /> : <Folder className="size-3.5" />}
          </PanelIconButton>
          <PanelIconButton
            title={confirmingDelete ? t("notes.confirmDelete") : t("notes.delete")}
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
        </div>
      </div>
    </ListItem>
  );
}

/** dnd 包装：listeners 只挂手柄（整行不可拖——避免挡文本选择与按钮点击）；
 *  data.layer 供 DndContext 跨 section 判定迁移。 */
export function SortableNoteRow({ note, dndDisabled, ...rowProps }: { note: LayeredNote; dndDisabled: boolean } & Omit<NoteRowProps, "grip">): ReactNode {
  const { t } = useTranslation();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: note.id,
    disabled: dndDisabled,
    data: { layer: note.layer },
  });
  const grip = (
    <span
      {...attributes}
      {...listeners}
      className="pt-0.5 cursor-grab active:cursor-grabbing text-[var(--color-muted)] hover:text-[var(--color-fg)] touch-none"
      title={t("notes.dragHint")}
    >
      <GripVertical className="size-4" />
    </span>
  );
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 10 : undefined, position: "relative", opacity: isDragging ? 0.75 : 1 }}
    >
      <NoteRow note={note} grip={grip} {...rowProps} />
    </div>
  );
}
