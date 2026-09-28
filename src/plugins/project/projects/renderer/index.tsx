// projects 插件 renderer —— 左栏"项目"分组:最近工作目录。
//
// 最近目录存自己的插件 config("recentCwds",插件配置能力的示范),
// 切目录 = useSessionStore.switchCwd(dir)(壳动作:落 cwd + 恢复该项目上次看的会话,
// 无记录/文件已删则退新会话壳)+ 驱 UI 重 resync——插件不自己拼"清会话上下文"序列。
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
import {  usePluginContext, useUiStore, useSessionStore, Section } from "@my-harness-desktop/react";
import { pathBasename } from "@my-harness-desktop/shared";


export function ProjectsSection(): React.ReactNode {
  const ctx = usePluginContext();
  const { t } = useTranslation();
  const { currentCwd, setCurrentCwd, clearSessionContext } = useUiStore();
  const [cwds, setCwds] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    void ctx.config.get<string[]>("recentCwds").then((v) => setCwds(v ?? []));
    void ctx.config.get<boolean>("sectionCollapsed").then((v) => setCollapsed(v ?? false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const persist = (next: string[]): void => {
    setCwds(next);
    void ctx.config.set("recentCwds", next, { scope: "global" });
  };

  const switchCwd = async (dir: string): Promise<void> => {
    try {
      // 切项目 = 落 cwd + 恢复该项目上次看的会话(无记录/文件已删 → 新会话壳)。
      // 语义收在壳动作 session-store.switchCwd 里:openSession 的上下文对齐/水合/失败兜底
      // 只在 store 一处,插件不手抄一遍(此前插件自己 startNewChat 是无条件新会话的根因)。
      // 点当前已激活项目是幂等 no-op(判定也在壳动作里)。
      await useSessionStore.getState().switchCwd(dir);
    } catch (err) {
      console.error("[projects] 切换目录失败:", err);
    }
  };

  const openDirectory = async (): Promise<void> => {
    const dir = await ctx.dialog.openDirectory();
    if (!dir) return;
    persist([dir, ...cwds.filter((c) => c !== dir)].slice(0, 10));
    await switchCwd(dir);
  };

  const removeCwd = (dir: string): void => {
    // 函数式更新:快速连删不读渲染闭包的旧 cwds
    setCwds((prev) => {
      const next = prev.filter((c) => c !== dir);
      void ctx.config.set("recentCwds", next, { scope: "global" });
      return next;
    });
    // 摘掉的是当前挂接:清 cwd/会话上下文,回无项目空态——否则列表删光了
    // cwd 还残留(lastCwd 随 prefs 持久化,重启又拉回来,"删不干净"的根因)。
    // 会话记忆(lastSessionByCwd)不删:同路径再加回来时能直接恢复到上次那个会话。
    if (dir === currentCwd) {
      setCurrentCwd("");
      clearSessionContext();
    }
  };

  const onDragEnd = (e: DragEndEvent): void => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    setCwds((prev) => {
      const oldIndex = prev.indexOf(active.id as string);
      const newIndex = prev.indexOf(over.id as string);
      if (oldIndex < 0 || newIndex < 0) return prev;
      const next = arrayMove(prev, oldIndex, newIndex);
      void ctx.config.set("recentCwds", next, { scope: "global" });
      return next;
    });
  };

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const activeName = currentCwd ? pathBasename(currentCwd) : undefined;

  const setSectionOpen = (open: boolean): void => {
    setCollapsed(!open);
    void ctx.config.set("sectionCollapsed", !open, { scope: "global" });
  };

  return (
    <Section
      title={t("projects.title")}
      open={!collapsed}
      onOpenChange={(o) => setSectionOpen(o)}
      collapsedSuffix={activeName ? (
        // 折叠时当前项目名贴在“项目”旁边;点击即展开。高度收紧(lineHeight 14 + 零纵向 padding)
        // 与 chevron 行同高,不撑高标题行(收起/展开行高一致);全路径放 title 提示。
        <span
          role="button"
          tabIndex={0}
          onClick={() => setSectionOpen(true)}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSectionOpen(true); } }}
          title={currentCwd ?? undefined}
          className="truncate"
          style={{
            display: "inline-flex",
            alignItems: "center",
            background: "var(--color-surface)",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius-sm)",
            padding: "0 6px",
            fontSize: "var(--font-size-sm)",
            lineHeight: "14px",
            color: "var(--color-fg)",
            maxWidth: "120px",
            marginLeft: "4px",
            cursor: "pointer",
          }}
        >
          {activeName}
        </span>
      ) : undefined}
      actions={
        <button onClick={() => void openDirectory()} title={t("projects.add")} style={iconBtnStyle}>
          <Plus className="size-4" />
        </button>
      }
    >
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={cwds} strategy={verticalListSortingStrategy}>
          {/* 不自带高度上限:本组独占一个 Panel(与 sessions-list 不同 group),槽壳已把
              「最后一个有内容的项」当滚动容器(flex-1 min-h-0 overflow-y-auto),这里再压
              「最多 3 行」就等于给用户拖出来的高度留一块永远填不上的空白。滚动交给槽壳。 */}
          <div>
            {cwds.map((dir) => (
              <ProjectRow
                key={dir}
                dir={dir}
                active={currentCwd === dir}
                onClick={() => void switchCwd(dir)}
                onRemove={() => removeCwd(dir)}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </Section>
  );
}

function ProjectRow({ dir, active, onClick, onRemove }: { dir: string; active: boolean; onClick: () => void; onRemove: () => void }): React.ReactNode {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const name = pathBasename(dir);
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
      // 探针锚点(docs 纪律:探针的「没找到」必须与「现象不存在」可区分)。此前只有 title
      // (绝对路径),e2e 探针按 title 查要拼完整路径、按文本查又撞基名歧义;#19 的复现
      // 脚本正是因此 found:false 而误判「现象不存在」。project-path 是稳定、唯一、可读的锚。
      data-project-path={dir}
      data-project-active={active ? "true" : "false"}
      // 激活态此前只靠 background/border 颜色表达（视觉态有、可访问态无）。
      // dnd-kit 的 attributes 已给了 role="button" 与 tabIndex，缺的是"当前项"语义。
      aria-current={active ? "true" : undefined}
      className="flex items-center gap-2 cursor-pointer select-none whitespace-nowrap"
      style={{
        padding: "var(--sidebar-row-py) var(--sidebar-row-px)",
        marginBottom: "var(--sidebar-row-gap)",
        background: active ? "var(--sidebar-row-bg-active)" : hovered ? "var(--sidebar-row-bg-hover)" : "var(--sidebar-row-bg)",
        border: active ? "var(--sidebar-row-border-active)" : hovered ? "var(--sidebar-row-border-hover)" : "var(--sidebar-row-border)",
        borderRadius: "var(--sidebar-row-radius)",
        boxShadow: active ? "var(--sidebar-row-shadow-active)" : "var(--sidebar-row-shadow)",
        color: active ? "var(--color-fg)" : "var(--color-muted)",
        transform: CSS.Transform.toString(transform),
        transition: `${transition ?? ""}, background 0.12s, border-color 0.12s, box-shadow 0.12s`,
        opacity: isDragging ? 0.5 : 1,
      }}
    >
      <div className="shrink-0 flex items-center justify-center" style={{ width: "var(--sidebar-icon-box)", height: "var(--sidebar-icon-box)" }}>
        <Folder className="text-[var(--color-muted)]" style={{ width: "var(--sidebar-icon-size)", height: "var(--sidebar-icon-size)" }} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="truncate text-[length:var(--font-size-lg)] font-semibold leading-tight text-[var(--color-fg)]">{name}</div>
        <div className="truncate text-[length:var(--font-size-sm)] leading-tight text-[var(--color-muted)] mt-0.5">{dir}</div>
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
