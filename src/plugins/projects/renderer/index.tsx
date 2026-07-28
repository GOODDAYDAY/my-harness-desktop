// projects 插件 renderer —— 左栏"项目"分组:最近工作目录。
//
// 最近目录存自己的插件 config("recentCwds",插件配置能力的示范),
// 切目录 = sessions.start(dir)(停旧起新由 SessionStore 管)+ 清会话上下文 + nonce。
// 顺序语义:点项目只切换、不重排(置顶只由"新增/拖拽"触发);
// 新增从顶部加;dnd-kit 拖拽改序写回 config(自带 transform 过渡动画)。
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Folder, X } from "lucide-react";
import {
  DndContext, PointerSensor, useSensor, useSensors, closestCenter, type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext, useSortable, verticalListSortingStrategy, arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { registerSidebarComponent, usePluginContext, useUiStore, useSessionStore, Section } from "@pi-desktop/react";

const PLUGIN_ID = "projects";
registerSidebarComponent("ProjectsSection", ProjectsSection);

function ProjectsSection(): React.ReactNode {
  const ctx = usePluginContext(PLUGIN_ID);
  const { t } = useTranslation();
  const {
    currentCwd, setCurrentCwd, setCurrentSessionPath, setSessionTitle, bumpSession,
  } = useUiStore();
  const [cwds, setCwds] = useState<string[]>([]);

  useEffect(() => {
    void ctx.config.get<string[]>("recentCwds").then((v) => setCwds(v ?? []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const persist = (next: string[]): void => {
    setCwds(next);
    void ctx.config.set("recentCwds", next);
  };

  // 切目录:只切,不重排(置顶只由新增/拖拽触发,避免"点一下就顶到最上")
  const switchCwd = async (dir: string): Promise<void> => {
    try {
      setCurrentCwd(dir);
      setCurrentSessionPath(null);
      setSessionTitle(null);
      await useSessionStore.getState().startNewChat(dir);
      bumpSession();
    } catch (err) {
      console.error("[projects] 切换目录失败:", err);
    }
  };

  // 新增目录:从顶部加入(若已存在则先移除再置顶),并切过去
  const openDirectory = async (): Promise<void> => {
    const dir = await ctx.dialog.openDirectory();
    if (!dir) return;
    persist([dir, ...cwds.filter((c) => c !== dir)].slice(0, 10));
    await switchCwd(dir);
  };

  const removeCwd = (dir: string): void => persist(cwds.filter((c) => c !== dir));

  // 拖拽结束:按新顺序写回 config(dnd-kit 的 transform 过渡已自带动画)
  const onDragEnd = (e: DragEndEvent): void => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    setCwds((prev) => {
      const oldIndex = prev.indexOf(active.id as string);
      const newIndex = prev.indexOf(over.id as string);
      if (oldIndex < 0 || newIndex < 0) return prev;
      const next = arrayMove(prev, oldIndex, newIndex);
      void ctx.config.set("recentCwds", next);
      return next;
    });
  };

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  return (
    <Section
      title={t("projects.title")}
      actions={
        <button onClick={() => void openDirectory()} title={t("projects.add")} style={iconBtnStyle}>
          <Plus className="size-4" />
        </button>
      }
    >
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={cwds} strategy={verticalListSortingStrategy}>
          {cwds.map((dir) => (
            <ProjectRow
              key={dir}
              dir={dir}
              active={currentCwd === dir}
              onClick={() => void switchCwd(dir)}
              onRemove={() => removeCwd(dir)}
            />
          ))}
        </SortableContext>
      </DndContext>
    </Section>
  );
}

function ProjectRow({ dir, active, onClick, onRemove }: { dir: string; active: boolean; onClick: () => void; onRemove: () => void }): React.ReactNode {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const name = dir.split("/").filter(Boolean).pop() ?? dir;
  // dnd-kit 拖拽:transform/transition 由 useSortable 算,CSS.Transform 应用到 style
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: dir });
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={dir}
      className="flex items-center gap-2 px-2.5 py-2.5 pb-1.5 rounded-[var(--radius-md)] cursor-pointer select-none"
      style={{
        background: active || hovered ? "var(--color-surface)" : "transparent",
        color: active ? "var(--color-fg)" : "var(--color-muted)",
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
      }}
    >
      <Folder className="size-4 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="truncate text-[14px] text-[var(--color-fg)]">{name}</div>
        <div className="truncate text-xs opacity-60 mt-0.5">{dir}</div>
      </div>
      {hovered && (
        <span
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          className="shrink-0 opacity-60 hover:opacity-100"
          title={t("projects.remove")}
        >
          <X className="size-3.5" />
        </span>
      )}
    </div>
  );
}

const iconBtnStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "center",
  width: "22px", height: "22px", border: "none", borderRadius: "var(--radius-sm)",
  background: "transparent", color: "var(--color-muted)", cursor: "pointer",
};
