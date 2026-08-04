// notes 插件 renderer —— 常用语一键发送 + 两层管理。
//
// 设计文档:docs/design/note-plugin.md。要点:
// - 两个视图共享 notes-store 的全部 IO;读 = 全局/项目两层并集按 order 排序;
// - 写后 main 广播 settings:changed → 两视图订阅 system:settingsChanged 重读,
//   编辑中不重读(避免把正在输入的编辑器顶掉);
// - 面板点击卡片 = composer 同款发送序列(appendOptimisticUser + appendPendingAssistant
//   + messaging.prompt),无活动会话先 startNewChat(设计 §3.2);
// - 保存是 manual 语义:每次增删改/拖拽/迁移即时落盘,无保存浮层(设计 §2.4);
// - 两个视图同一张贴纸(NoteCard + StickerCard):面板单列贴纸流点击发送;
//   设置页 = 双 Section 分层管理,每区一张贴纸网格(设计 §4.1 的网格方向),
//   搜索过滤 + 拖拽排序/跨区迁移,点贴纸展开全文 + 操作行(发送/编辑/复制/迁移/删除)。

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Search, StickyNote } from "lucide-react";
import {
  DndContext, PointerSensor, closestCenter, useDroppable, useSensor, useSensors, type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext, arrayMove, rectSortingStrategy, useSortable, verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { AnimatePresence, motion } from "framer-motion";
import {
  EmptyState, PanelIconButton, PanelToolbar, SettingsSection, usePluginContext, useSessionStore, useUiStore,
} from "@pi-desktop/react";
import { NoteCard, NoteEditor, type NoteDraft } from "./note-card";
import {
  createNote, loadNotes, moveLayer, moveToLayer, removeNote, reorderNotes, updateNote, type LayeredNote, type NoteLayer,
} from "../client/notes-store";

// "填入输入框"事件：notes 发布、timeline 订阅（事件总线规则：只有声明方能 emit——
// 所以方向必须是 notes 声明自有 channel，timeline 以 try/catch 订阅兜底其缺席，
// timeline 不加 dependsOn，可选插件不能反过来卡住受保护插件）。
export const channels = ["notes:fillComposer"] as const;

/** 拖拽结束 → 重排 → 持久化 order（两个视图同一逻辑，收敛一处）。 */
function makeDragEnd(
  ctx: Parameters<typeof reorderNotes>[0],
  notes: LayeredNote[],
  reload: () => Promise<void>,
): (e: DragEndEvent) => void {
  return ({ active, over }) => {
    if (!over || active.id === over.id) return;
    const ids = notes.map((n) => n.id);
    const next = arrayMove(ids, ids.indexOf(String(active.id)), ids.indexOf(String(over.id)));
    void reorderNotes(ctx, next).then(reload);
  };
}

/** 编辑态：id 缺席 = 新建（targetLayer 决定落哪层，缺省项目层），id 在 = 编辑既有条目。 */
type EditingState = { id?: string; title: string; content: string; targetLayer?: NoteLayer };

/** 两视图共享的装载/同步逻辑:只读 currentCwd,订阅 settingsChanged,编辑中抑制重读。 */
function useNotes(): {
  cwd: string;
  notes: LayeredNote[];
  editing: EditingState | null;
  setEditing: (v: EditingState | null) => void;
  reload: () => Promise<void>;
} {
  const ctx = usePluginContext();
  const cwd = useUiStore((s) => s.currentCwd);
  const [notes, setNotes] = useState<LayeredNote[]>([]);
  const [editing, setEditing] = useState<EditingState | null>(null);
  const editingRef = useRef(editing);
  editingRef.current = editing;

  const reload = useCallback(async () => {
    if (!cwd) {
      setNotes([]);
      return;
    }
    setNotes(await loadNotes(ctx));
  }, [ctx, cwd]);

  // cwd 变化(切项目)即重读;settingsChanged(任一侧写盘后的广播)即重读。
  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => {
    return ctx.events.on("system:settingsChanged", () => {
      if (!editingRef.current) void reload();
    });
  }, [ctx.events, reload]);

  return { cwd, notes, editing, setEditing, reload };
}

/** 右面板:单列贴纸流,点击发送,就地增删改(设计 §3)。 */
export function NotesPanel({ isActive }: { isActive: boolean }): ReactNode {
  const ctx = usePluginContext();
  const { cwd, notes, editing, setEditing, reload } = useNotes();
  const streaming = useSessionStore((s) => s.streaming);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const onDragEnd = makeDragEnd(ctx, notes, reload);

  // 激活时重读(面板反复显隐,广播只在挂载组件间生效)
  useEffect(() => {
    if (isActive) void reload();
  }, [isActive, reload]);

  const send = useCallback(
    async (note: LayeredNote): Promise<void> => {
      if (streaming || sendingId || !cwd) return;
      setSendingId(note.id);
      try {
        await useSessionStore.getState().sendMessage(cwd, note.content);
      } finally {
        setSendingId(null);
      }
    },
    [cwd, streaming, sendingId],
  );

  if (!cwd) return <EmptyState icon={<StickyNote className="size-8" />} title="先打开文件夹" />;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <PanelToolbar title="笔记">
        <div className="flex-1" />
        <PanelIconButton title="新建笔记" onClick={() => setEditing({ title: "", content: "" })}>
          <Plus className="size-4" />
        </PanelIconButton>
      </PanelToolbar>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={notes.map((n) => n.id)} strategy={verticalListSortingStrategy}>
          <div className="flex-1 overflow-y-auto min-h-0 p-2 flex flex-col gap-2">
            {editing && !editing.id && (
              <NoteEditor
                initial={editing}
                onCancel={() => setEditing(null)}
                onSave={async (draft) => {
                  await createNote(ctx, draft);
                  setEditing(null);
                  await reload();
                }}
              />
            )}
            {notes.length === 0 && !editing && (
              <div className="p-4 text-[var(--color-muted)] text-[length:var(--font-size-sm)] text-center">
                暂无笔记。点右上角 ＋ 新建,点卡片直接发送进会话。
              </div>
            )}
            {notes.map((n) =>
              editing?.id === n.id ? (
                <NoteEditor
                  key={n.id}
                  initial={editing}
                  onCancel={() => setEditing(null)}
                  onSave={async (draft) => {
                    await updateNote(ctx, n.id, draft);
                    setEditing(null);
                    await reload();
                  }}
                />
              ) : (
                <SortableNoteCard
                  key={n.id}
                  note={n}
                  dndDisabled={editing !== null}
                  onActivate={() => void send(n)}
                  activateDisabledReason={streaming ? "等待当前回复完成" : null}
                  sending={sendingId === n.id}
                  onFillComposer={() => ctx.events.emit("notes:fillComposer", { text: n.content })}
                  onEdit={() => setEditing({ id: n.id, title: n.title ?? "", content: n.content })}
                  onDelete={async () => {
                    await removeNote(ctx, n.id);
                    await reload();
                  }}
                />
              ),
            )}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
}

/** dnd 包装的贴纸(面板与设置页共用;策略由各自外层 SortableContext 决定)。 */
function SortableNoteCard({ note, dndDisabled, ...cardProps }: { note: LayeredNote; dndDisabled: boolean } & Parameters<typeof NoteCard>[0]): ReactNode {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: note.id, disabled: dndDisabled });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 10 : undefined, position: "relative" }}
      {...attributes}
      {...listeners}
    >
      <NoteCard note={note} {...cardProps} />
    </div>
  );
}

/** 贴纸/编辑器的进出过渡：高度 0↔auto + 淡入淡出；popLayout 让退场元素立刻让位,
 *  贴纸↔编辑器同位切换、增删、跨区迁移都走这一套。 */
const rowMotion = {
  initial: { opacity: 0, height: 0 },
  animate: { opacity: 1, height: "auto" },
  exit: { opacity: 0, height: 0 },
  transition: { duration: 0.18 },
  style: { overflow: "hidden" as const },
};

interface LayerSectionProps {
  layer: NoteLayer;
  title: string;
  description: string;
  rows: LayeredNote[];
  searching: boolean;
  dndDisabled: boolean;
  editing: EditingState | null;
  setEditing: (v: EditingState | null) => void;
  expandedId: string | null;
  setExpandedId: (id: string | null) => void;
  streaming: boolean;
  sendingId: string | null;
  onSend: (n: LayeredNote) => void;
  onSaveNew: (draft: NoteDraft) => Promise<void>;
  onSaveEdit: (id: string, draft: NoteDraft) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onMoveLayer: (id: string) => Promise<void>;
}

/** 单层区块：SettingsSection 壳(＋ 入口收进标题行 actions) + 贴纸网格(可拖入空白区,故容器本身也是 droppable)。
 *  点贴纸展开全文 + 操作行;编辑器(新建/编辑)就是网格里一个普通格子,与展示卡同尺寸同位置。 */
function LayerSection({ layer, title, description, rows, searching, dndDisabled, editing, setEditing, expandedId, setExpandedId, streaming, sendingId, onSend, onSaveNew, onSaveEdit, onDelete, onMoveLayer }: LayerSectionProps): ReactNode {
  const { t } = useTranslation();
  const { setNodeRef, isOver } = useDroppable({ id: `section-${layer}`, data: { layer } });
  const newHere = editing !== null && editing.id === undefined && (editing.targetLayer ?? "project") === layer;
  return (
    <SettingsSection
      title={`${title} · ${rows.length}`}
      description={description}
      actions={
        <button
          onClick={() => setEditing({ title: "", content: "", targetLayer: layer })}
          className="flex items-center gap-1 px-2 py-1 text-xs rounded-[var(--radius-xs)] border border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-fg)] bg-transparent cursor-pointer"
        >
          <Plus className="size-3.5" />{layer === "project" ? t("notes.newToProject") : t("notes.newToGlobal")}
        </button>
      }
    >
      <div
        ref={setNodeRef}
        style={{
          minHeight: 44,
          borderRadius: "var(--radius-sm)",
          outline: isOver ? "1px dashed var(--color-primary)" : "1px dashed transparent",
          outlineOffset: 4,
          transition: "outline-color 0.15s",
        }}
      >
        <div className="grid gap-3 items-start" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(180px, 220px))" }}>
          <AnimatePresence initial={false} mode="popLayout">
            {newHere && (
              <motion.div key="new" {...rowMotion}>
                <NoteEditor initial={editing} onCancel={() => setEditing(null)} onSave={onSaveNew} />
              </motion.div>
            )}
            {rows.map((n) =>
              editing?.id === n.id ? (
                <motion.div key={`${n.id}-edit`} {...rowMotion}>
                  <NoteEditor initial={editing} onCancel={() => setEditing(null)} onSave={(d) => onSaveEdit(n.id, d)} />
                </motion.div>
              ) : (
                <motion.div key={n.id} {...rowMotion}>
                  <SortableNoteCard
                    note={n}
                    dndDisabled={dndDisabled}
                    expanded={expandedId === n.id}
                    onToggleExpand={() => setExpandedId(expandedId === n.id ? null : n.id)}
                    hideHoverActions
                    onSend={() => onSend(n)}
                    sendDisabledReason={streaming ? t("notes.waitForReply") : null}
                    sending={sendingId === n.id}
                    onEdit={() => setEditing({ id: n.id, title: n.title ?? "", content: n.content })}
                    onDelete={() => void onDelete(n.id)}
                    onMoveLayer={() => void onMoveLayer(n.id)}
                  />
                </motion.div>
              ),
            )}
          </AnimatePresence>
        </div>
        {rows.length === 0 && !newHere && (
          <div className="border border-dashed border-[var(--color-border)] rounded-[var(--radius-sm)] py-5 text-center text-xs text-[var(--color-muted)]">
            {searching ? t("notes.noMatch") : layer === "project" ? t("notes.emptyProject") : t("notes.emptyGlobal")}
          </div>
        )}
      </div>
    </SettingsSection>
  );
}

/** 设置页:双 Section 分层管理——搜索 + 贴纸网格 + 拖拽排序/跨区迁移(设计 §4.1 的网格方向)。 */
export function NotesSettings(): ReactNode {
  const ctx = usePluginContext();
  const { t } = useTranslation();
  const { cwd, notes, editing, setEditing, reload } = useNotes();
  const streaming = useSessionStore((s) => s.streaming);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const send = useCallback(
    async (note: LayeredNote): Promise<void> => {
      if (streaming || sendingId || !cwd) return;
      setSendingId(note.id);
      try {
        await useSessionStore.getState().sendMessage(cwd, note.content);
      } finally {
        setSendingId(null);
      }
    },
    [cwd, streaming, sendingId],
  );

  if (!cwd) return <EmptyState icon={<StickyNote className="size-8" />} title={t("notes.openFolderFirst")} />;

  const q = query.trim().toLowerCase();
  const matched = (n: LayeredNote): boolean =>
    !q || (n.title ?? "").toLowerCase().includes(q) || n.content.toLowerCase().includes(q);
  const byLayer = (layer: NoteLayer): LayeredNote[] => notes.filter((n) => n.layer === layer && matched(n));
  // 搜索态/编辑态禁拖拽:过滤子集里重排会写回错误的 order
  const dndDisabled = editing !== null || q !== "";

  const onDragEnd = ({ active, over }: DragEndEvent): void => {
    if (!over || active.id === over.id) return;
    const activeNote = notes.find((n) => n.id === String(active.id));
    if (!activeNote) return;
    const overNote = notes.find((n) => n.id === String(over.id));
    const overLayer = overNote?.layer ?? (over.data.current as { layer?: NoteLayer } | undefined)?.layer;
    if (!overLayer) return;
    if (overLayer !== activeNote.layer) {
      const layerNotes = notes.filter((n) => n.layer === overLayer);
      const targetIndex = overNote ? layerNotes.indexOf(overNote) : null;
      void moveToLayer(ctx, activeNote.id, overLayer, targetIndex).then(reload);
      return;
    }
    if (!overNote) return;
    const ids = notes.map((n) => n.id);
    void reorderNotes(ctx, arrayMove(ids, ids.indexOf(activeNote.id), ids.indexOf(overNote.id))).then(reload);
  };

  const saveNew = async (draft: NoteDraft): Promise<void> => {
    await createNote(ctx, draft, editing?.targetLayer ?? "project");
    setEditing(null);
    await reload();
  };
  const saveEdit = async (id: string, draft: NoteDraft): Promise<void> => {
    await updateNote(ctx, id, draft);
    setEditing(null);
    await reload();
  };
  const del = async (id: string): Promise<void> => {
    await removeNote(ctx, id);
    await reload();
  };
  const move = async (id: string): Promise<void> => {
    await moveLayer(ctx, id);
    await reload();
  };

  const sectionProps = { editing, setEditing, expandedId, setExpandedId, streaming, sendingId, onSend: (n: LayeredNote): void => void send(n), onSaveNew: saveNew, onSaveEdit: saveEdit, onDelete: del, onMoveLayer: move, dndDisabled, searching: q !== "" };

  return (
    <div className="flex-1 overflow-y-auto min-h-0 p-4 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <div className="flex-1 flex items-center gap-1.5 px-2 border border-[var(--color-border)] rounded-[var(--radius-sm)] text-[var(--color-muted)]">
          <Search className="size-3.5 shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("notes.searchPlaceholder")}
            className="flex-1 bg-transparent border-none outline-none py-1.5 text-xs text-[var(--color-fg)] placeholder:text-[var(--color-muted)]"
          />
        </div>
        <button
          onClick={() => setEditing({ title: "", content: "", targetLayer: "project" })}
          className="flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-[var(--radius-sm)] bg-[var(--color-primary)] text-[var(--color-bg)] border-none cursor-pointer"
        >
          <Plus className="size-3.5" />{t("notes.newNote")}
        </button>
      </div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={notes.map((n) => n.id)} strategy={rectSortingStrategy}>
          <LayerSection layer="project" title={t("notes.projectSection")} description={t("notes.projectSectionDesc")} rows={byLayer("project")} {...sectionProps} />
          <LayerSection layer="global" title={t("notes.globalSection")} description={t("notes.globalSectionDesc")} rows={byLayer("global")} {...sectionProps} />
        </SortableContext>
      </DndContext>
    </div>
  );
}
