// notes 插件 renderer —— 常用语一键发送 + 两层管理。
//
// 设计文档:docs/design/note-plugin.md。要点:
// - 两个视图共享 notes-store 的全部 IO;读 = 全局/项目两层并集按 order 排序;
// - 写后 main 广播 settings:changed → 两视图订阅 system:settingsChanged 重读,
//   编辑中不重读(避免把正在输入的编辑器顶掉);
// - 面板点击卡片 = composer 同款发送序列(appendOptimisticUser + appendPendingAssistant
//   + messaging.prompt),无活动会话先 startNewChat(设计 §3.2);
// - 保存是 manual 语义:每次增删改/拖拽/迁移即时落盘,无保存浮层(设计 §2.4)。

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Plus, StickyNote } from "lucide-react";
import {
  DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext, arrayMove, rectSortingStrategy, useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  EmptyState, PanelIconButton, PanelToolbar, usePluginContext, useSessionStore, useUiStore,
} from "@pi-desktop/react";
import { NoteCard, NoteEditor } from "./note-card";
import {
  createNote, loadNotes, moveLayer, removeNote, reorderNotes, updateNote, type LayeredNote,
} from "./notes-store";

/** 两视图共享的装载/同步逻辑:只读 currentCwd,订阅 settingsChanged,编辑中抑制重读。 */
function useNotes(): {
  cwd: string;
  notes: LayeredNote[];
  editing: { id?: string; title: string; content: string } | null;
  setEditing: (v: { id?: string; title: string; content: string } | null) => void;
  reload: () => Promise<void>;
} {
  const ctx = usePluginContext();
  const cwd = useUiStore((s) => s.currentCwd);
  const [notes, setNotes] = useState<LayeredNote[]>([]);
  const [editing, setEditing] = useState<{ id?: string; title: string; content: string } | null>(null);
  const editingRef = useRef(editing);
  editingRef.current = editing;

  const reload = useCallback(async () => {
    if (!cwd) {
      setNotes([]);
      return;
    }
    setNotes(await loadNotes(ctx, cwd));
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

/** 右面板:单列卡片流,点击发送,就地增删改(设计 §3)。 */
export function NotesPanel({ isActive }: { isActive: boolean }): ReactNode {
  const ctx = usePluginContext();
  const { cwd, notes, editing, setEditing, reload } = useNotes();
  const currentSessionPath = useUiStore((s) => s.currentSessionPath);
  const streaming = useSessionStore((s) => s.streaming);
  const [sendingId, setSendingId] = useState<string | null>(null);

  // 激活时重读(面板反复显隐,广播只在挂载组件间生效)
  useEffect(() => {
    if (isActive) void reload();
  }, [isActive, reload]);

  const send = useCallback(
    async (note: LayeredNote): Promise<void> => {
      if (streaming || sendingId || !cwd) return;
      setSendingId(note.id);
      try {
        if (!currentSessionPath) await useSessionStore.getState().startNewChat(cwd);
        const store = useSessionStore.getState();
        store.appendOptimisticUser(note.content);
        store.appendPendingAssistant();
        await ctx.messaging.prompt(note.content);
      } finally {
        setSendingId(null);
      }
    },
    [ctx, cwd, currentSessionPath, streaming, sendingId],
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
      <div className="flex-1 overflow-y-auto min-h-0 p-2 flex flex-col gap-2">
        {editing && !editing.id && (
          <NoteEditor
            initial={editing}
            onCancel={() => setEditing(null)}
            onSave={async (draft) => {
              await createNote(ctx, cwd, draft);
              setEditing(null);
              await reload();
            }}
          />
        )}
        {notes.length === 0 && !editing && (
          <div className="p-4 text-[var(--color-muted)] text-[var(--font-size-sm)] text-center">
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
                await updateNote(ctx, cwd, n.id, draft);
                setEditing(null);
                await reload();
              }}
            />
          ) : (
            <NoteCard
              key={n.id}
              note={n}
              onActivate={() => void send(n)}
              activateDisabledReason={streaming ? "等待当前回复完成" : null}
              sending={sendingId === n.id}
              onEdit={() => setEditing({ id: n.id, title: n.title ?? "", content: n.content })}
              onDelete={async () => {
                await removeNote(ctx, cwd, n.id);
                await reload();
              }}
            />
          ),
        )}
      </div>
    </div>
  );
}

/** dnd 包装的卡片(设置页专用)。 */
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

/** 设置页:三列网格 + dnd 拖拽排序 + 层间迁移(设计 §4)。 */
export function NotesSettings(): ReactNode {
  const ctx = usePluginContext();
  const { cwd, notes, editing, setEditing, reload } = useNotes();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const dndDisabled = editing !== null;

  const onDragEnd = (e: DragEndEvent): void => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const ids = notes.map((n) => n.id);
    const next = arrayMove(ids, ids.indexOf(String(active.id)), ids.indexOf(String(over.id)));
    void reorderNotes(ctx, cwd, next).then(reload);
  };

  if (!cwd) return <EmptyState icon={<StickyNote className="size-8" />} title="先打开文件夹" />;

  return (
    <div className="flex-1 overflow-y-auto min-h-0 p-4">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={notes.map((n) => n.id)} strategy={rectSortingStrategy}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 12, alignItems: "start" }}>
            {editing && !editing.id ? (
              <NoteEditor
                initial={editing}
                onCancel={() => setEditing(null)}
                onSave={async (draft) => {
                  await createNote(ctx, cwd, draft);
                  setEditing(null);
                  await reload();
                }}
              />
            ) : (
              <button
                onClick={() => setEditing({ title: "", content: "" })}
                className="border border-dashed border-[var(--color-border)] rounded-[var(--radius-md)] min-h-24 bg-transparent text-[var(--color-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface)] cursor-pointer text-lg"
              >
                ＋
              </button>
            )}
            {notes.map((n) =>
              editing?.id === n.id ? (
                <NoteEditor
                  key={n.id}
                  initial={editing}
                  onCancel={() => setEditing(null)}
                  onSave={async (draft) => {
                    await updateNote(ctx, cwd, n.id, draft);
                    setEditing(null);
                    await reload();
                  }}
                />
              ) : (
                <SortableNoteCard
                  key={n.id}
                  note={n}
                  dndDisabled={dndDisabled}
                  onEdit={() => setEditing({ id: n.id, title: n.title ?? "", content: n.content })}
                  onDelete={async () => {
                    await removeNote(ctx, cwd, n.id);
                    await reload();
                  }}
                  onMoveLayer={async () => {
                    await moveLayer(ctx, cwd, n.id);
                    await reload();
                  }}
                />
              ),
            )}
          </div>
        </SortableContext>
      </DndContext>
      {notes.length === 0 && !editing && (
        <div className="pt-6 text-center text-[var(--color-muted)] text-[var(--font-size-sm)]">
          暂无笔记。新建后可在右面板"笔记"页一键发送进会话。
        </div>
      )}
    </div>
  );
}
