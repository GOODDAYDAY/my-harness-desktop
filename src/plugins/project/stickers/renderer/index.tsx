// stickers 插件 renderer —— 表情包一键发送 + 两层管理(notes 升级版,加了 banner 图)。
//
// 设计文档:docs/design/note-plugin.md + docs/design/sticker-plugin.md。要点:
// - 两个视图共享 stickers-store 的全部 IO;读 = 全局/项目两层并集按 order 排序;
// - banner 图存全局数据根 ~/.my-harness-desktop/stickers/banners/(逻辑前缀,运行时展开),恒不分层;
// - 写后 main 广播 settings:changed → 两视图订阅 system:settingsChanged 重读,
//   编辑中不重读(避免把正在输入的编辑器顶掉);
// - 面板点击卡片 = composer 同款发送序列,带 banner 时经 sendMessage 的 {image} 选项
//   乐观注入 role:"image" 消息 + 落 custom_message 条目(会话流通用图片展示,设计 §3);
// - 保存是 manual 语义:每次增删改/拖拽/迁移即时落盘,无保存浮层;
// - 两个视图同一张贴纸(StickerDisplay + StickerCard):面板单列贴纸流点击发送;
//   设置页 = 双 Section 分层管理,每区一张贴纸网格,搜索 + 拖拽排序/跨区迁移;
// - 输入框快速入口:composerActions 槽按钮 + 网格选择器(设计 §5)。

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Search, Download, Upload } from "lucide-react";
import {
  DndContext, PointerSensor, closestCenter, useDroppable, useSensor, useSensors, type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext, arrayMove, rectSortingStrategy, useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { AnimatePresence, motion } from "framer-motion";
import {
  PanelIconButton, PanelToolbar, SettingsSection, usePluginContext, useSessionStore, useUiStore,
} from "@my-harness-desktop/react";
import type { PluginContext } from "@my-harness-desktop/contract";
import { StickerDisplay, StickerEditor, readBannerDataUri, type StickerDraft } from "./sticker-card";
import {
  createSticker, loadStickers, moveLayer, moveToLayer, removeSticker, reorderStickers, updateSticker,
  exportStickersZip, importStickersZip,
  type LayeredSticker, type StickerLayer,
} from "../client/stickers-store";

// "加入输入框"事件：stickers 发布、timeline 订阅（事件总线规则：只有声明方能 emit——
// 所以方向必须是 stickers 声明自有 channel，timeline 以 try/catch 订阅兜底其缺席，
// timeline 不加 dependsOn，可选插件不能反过来卡住受保护插件）。
export const channels = ["stickers:fillComposer"] as const;

/** 整体导入导出共享逻辑:zip 打包保存/解包还原 + 结果提示(成功/取消/失败)。
 *  设置页用(用户要求导入导出放设置页);失败原因可见,不再静默。 */
function useStickerTransfer(ctx: PluginContext, reload: () => Promise<void>): {
  busy: boolean;
  msg: string | null;
  doExport: () => Promise<void>;
  doImport: () => Promise<void>;
} {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);
  const flash = useCallback((m: string) => {
    setMsg(m);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setMsg(null), 3000);
  }, []);
  const doExport = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const path = await exportStickersZip(ctx);
      flash(path ? "已导出表情包 zip" : "已取消");
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      console.error("[stickers] 导出失败:", e);
      flash(`导出失败: ${detail}`);
    } finally {
      setBusy(false);
    }
  }, [busy, ctx, flash]);
  const doImport = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await importStickersZip(ctx);
      await reload();
      flash(`已导入 ${res.imported} 条${res.skipped > 0 ? `,跳过 ${res.skipped}` : ""}`);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      console.error("[stickers] 导入失败:", e);
      flash(`导入失败: ${detail}`);
    } finally {
      setBusy(false);
    }
  }, [busy, ctx, reload, flash]);
  return { busy, msg, doExport, doImport };
}

/** 拖拽结束 → 重排 → 持久化 order（两个视图同一逻辑，收敛一处）。 */
function makeDragEnd(
  ctx: Parameters<typeof reorderStickers>[0],
  stickers: LayeredSticker[],
  reload: () => Promise<void>,
): (e: DragEndEvent) => void {
  return ({ active, over }) => {
    if (!over || active.id === over.id) return;
    const ids = stickers.map((n) => n.id);
    const next = arrayMove(ids, ids.indexOf(String(active.id)), ids.indexOf(String(over.id)));
    void reorderStickers(ctx, next).then(reload);
  };
}

/** 编辑态：id 缺席 = 新建（targetLayer 决定落哪层，缺省项目层），id 在 = 编辑既有条目。 */
type EditingState = { id?: string; title: string; content: string; existingBanner?: string; targetLayer?: StickerLayer };

/** 两视图共享的装载/同步逻辑:只读 currentCwd,订阅 settingsChanged,编辑中抑制重读。 */
function useStickers(): {
  cwd: string;
  stickers: LayeredSticker[];
  editing: EditingState | null;
  setEditing: (v: EditingState | null) => void;
  reload: () => Promise<void>;
} {
  const ctx = usePluginContext();
  const cwd = useUiStore((s) => s.currentCwd);
  const [stickers, setStickers] = useState<LayeredSticker[]>([]);
  const [editing, setEditing] = useState<EditingState | null>(null);
  const editingRef = useRef(editing);
  editingRef.current = editing;

  const reload = useCallback(async () => {
    // 全局层贴纸不依赖 cwd:即使未打开项目(cwd null)也读全局贴纸——
    // 刷新后不丢。项目层在无项目时自然为空。
    setStickers(await loadStickers(ctx));
  }, [ctx]);

  // cwd 变化(切项目)即重读;settingsChanged(任一侧写盘后的广播)即重读。
  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => {
    return ctx.events.on("system:settingsChanged", () => {
      if (!editingRef.current) void reload();
    });
  }, [ctx.events, reload]);

  return { cwd, stickers, editing, setEditing, reload };
}

/** 带图发送:有 banner 就经 sendMessage 的 {image} 选项(乐观注入图消息 + 落盘),无图退纯文本。
 *  纯图表情包(content 空)发标题兜底,标题也空则发空文本(底座兜底)。 */
function sendSticker(ctx: Parameters<typeof loadStickers>[0], cwd: string, sticker: LayeredSticker): Promise<unknown> {
  const text = sticker.content.trim() || sticker.title?.trim() || "";
  return useSessionStore.getState().sendMessage(
    cwd,
    text,
    sticker.banner ? { image: { src: sticker.banner, title: sticker.title } } : undefined,
  );
}

/** 右面板:贴纸网格(随宽度自适应 2/3/4 列),点击发送,就地增删改,支持搜索/导入/导出。 */
export function StickersPanel({ isActive }: { isActive: boolean }): ReactNode {
  const ctx = usePluginContext();
  const { cwd, stickers, editing, setEditing, reload } = useStickers();
  const streaming = useSessionStore((s) => s.streaming);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const onDragEnd = makeDragEnd(ctx, stickers, reload);

  // 激活时重读(面板反复显隐,广播只在挂载组件间生效)
  useEffect(() => {
    if (isActive) void reload();
  }, [isActive, reload]);

  const send = useCallback(
    async (sticker: LayeredSticker): Promise<void> => {
      if (streaming || sendingId || !cwd) return;
      setSendingId(sticker.id);
      try {
        await sendSticker(ctx, cwd, sticker);
      } finally {
        setSendingId(null);
      }
    },
    [cwd, streaming, sendingId, ctx],
  );

  // 加入输入框:文本 + 图(dataUri 供 timeline 的 composer 展示;src/title 发送时落 custom 条目)
  const fillComposer = useCallback(
    async (sticker: LayeredSticker): Promise<void> => {
      const dataUri = sticker.banner ? await readBannerDataUri(ctx, sticker.banner) : undefined;
      ctx.events.emit("stickers:fillComposer", {
        text: sticker.content,
        image: sticker.banner
          ? { src: sticker.banner, title: sticker.title, dataUri: dataUri ?? undefined }
          : undefined,
      });
    },
    [ctx],
  );

  // cwd null 时也显示贴纸(全局层不依赖项目;发送/导入导出时按钮给提示)
  const q = query.trim().toLowerCase();
  const matched = stickers.filter(
    (n) => !q || (n.title ?? "").toLowerCase().includes(q) || n.content.toLowerCase().includes(q),
  );
  // 搜索/编辑态禁拖拽:过滤子集里重排会写回错误的 order
  const dndDisabled = editing !== null || q !== "";

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <PanelToolbar title="表情包">
        <div className="flex-1" />
        <PanelIconButton title="新建贴纸" onClick={() => setEditing({ title: "", content: "" })}>
          <Plus className="size-4" />
        </PanelIconButton>
      </PanelToolbar>
      {/* 搜索:标题 + 内容 */}
      <div className="px-2 pb-1.5">
        <div className="flex items-center gap-1.5 px-2 border border-[var(--color-border)] rounded-[var(--radius-sm)] text-[var(--color-muted)]">
          <Search className="size-3.5 shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索标题或内容…"
            className="flex-1 bg-transparent border-none outline-none py-1.5 text-xs text-[var(--color-fg)] placeholder:text-[var(--color-muted)]"
          />
        </div>
      </div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={matched.map((n) => n.id)} strategy={rectSortingStrategy}>
          <div className="flex-1 overflow-y-auto min-h-0 p-2">
            <div className="grid gap-2 items-start" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))" }}>
              {editing && !editing.id && (
                <StickerEditor
                  initial={editing}
                  onCancel={() => setEditing(null)}
                  onSave={async (draft) => {
                    await createSticker(ctx, draft);
                    setEditing(null);
                    await reload();
                  }}
                />
              )}
              {matched.length === 0 && !editing && (
                <div className="col-span-full p-4 text-[var(--color-muted)] text-[length:var(--font-size-sm)] text-center">
                  暂无贴纸。点右上角 ＋ 新建,点卡片直接发送进会话。
                </div>
              )}
              {matched.map((n) =>
                editing?.id === n.id ? (
                  <StickerEditor
                    key={n.id}
                    initial={{ title: editing.title, content: editing.content, existingBanner: n.banner }}
                    onCancel={() => setEditing(null)}
                    onSave={async (draft) => {
                      await updateSticker(ctx, n.id, draft);
                      setEditing(null);
                      await reload();
                    }}
                  />
                ) : (
                  <SortableStickerCard
                    key={n.id}
                    sticker={n}
                    dndDisabled={dndDisabled || n.layer === "builtin"}
                    onActivate={() => void send(n)}
                    activateDisabledReason={streaming ? "等待当前回复完成" : !cwd ? "先打开文件夹" : null}
                    sending={sendingId === n.id}
                    onFillComposer={() => void fillComposer(n)}
                    onEdit={n.layer === "builtin" ? undefined : () => setEditing({ id: n.id, title: n.title ?? "", content: n.content, existingBanner: n.banner })}
                    onDelete={async () => {
                      await removeSticker(ctx, n.id);
                      await reload();
                    }}
                  />
                ),
              )}
            </div>
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
}

/** dnd 包装的贴纸(面板与设置页共用;策略由各自外层 SortableContext 决定)。 */
function SortableStickerCard({ sticker, dndDisabled, ...cardProps }: { sticker: LayeredSticker; dndDisabled: boolean } & Parameters<typeof StickerDisplay>[0]): ReactNode {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: sticker.id, disabled: dndDisabled });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 10 : undefined, position: "relative" }}
      {...attributes}
      {...listeners}
    >
      <StickerDisplay sticker={sticker} {...cardProps} />
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
  layer: StickerLayer;
  title: string;
  description: string;
  rows: LayeredSticker[];
  searching: boolean;
  dndDisabled: boolean;
  editing: EditingState | null;
  setEditing: (v: EditingState | null) => void;
  expandedId: string | null;
  setExpandedId: (id: string | null) => void;
  streaming: boolean;
  sendingId: string | null;
  onSend: (n: LayeredSticker) => void;
  onSaveNew: (draft: StickerDraft) => Promise<void>;
  onSaveEdit: (id: string, draft: StickerDraft) => Promise<void>;
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
          <Plus className="size-3.5" />{layer === "project" ? t("stickers.newToProject") : t("stickers.newToGlobal")}
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
                <StickerEditor initial={editing} onCancel={() => setEditing(null)} onSave={onSaveNew} />
              </motion.div>
            )}
            {rows.map((n) =>
              editing?.id === n.id ? (
                <motion.div key={`${n.id}-edit`} {...rowMotion}>
                  <StickerEditor initial={{ title: editing.title, content: editing.content, existingBanner: n.banner }} onCancel={() => setEditing(null)} onSave={(d) => onSaveEdit(n.id, d)} />
                </motion.div>
              ) : (
                <motion.div key={n.id} {...rowMotion}>
                  <SortableStickerCard
                    sticker={n}
                    dndDisabled={dndDisabled}
                    expanded={expandedId === n.id}
                    onToggleExpand={() => setExpandedId(expandedId === n.id ? null : n.id)}
                    hideHoverActions
                    onSend={() => onSend(n)}
                    sendDisabledReason={streaming ? t("stickers.waitForReply") : null}
                    sending={sendingId === n.id}
                    onEdit={() => setEditing({ id: n.id, title: n.title ?? "", content: n.content, existingBanner: n.banner })}
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
            {searching ? t("stickers.noMatch") : layer === "project" ? t("stickers.emptyProject") : t("stickers.emptyGlobal")}
          </div>
        )}
      </div>
    </SettingsSection>
  );
}

/** 内置层区块:SettingsSection 壳(无 ＋ 入口) + 普通网格——不进 DndContext 的 droppable、
 *  卡片不包 sortable,不可编辑/迁移/拖拽,可删除(墓碑);可展开、可发送、可复制(展开态操作行)。 */
function BuiltinSection({ rows, searching, expandedId, setExpandedId, streaming, sendingId, onSend, onDelete }: {
  rows: LayeredSticker[];
  searching: boolean;
  expandedId: string | null;
  setExpandedId: (id: string | null) => void;
  streaming: boolean;
  sendingId: string | null;
  onSend: (n: LayeredSticker) => void;
  onDelete: (id: string) => Promise<void>;
}): ReactNode {
  const { t } = useTranslation();
  return (
    <SettingsSection title={`${t("stickers.builtinSection")} · ${rows.length}`} description={t("stickers.builtinSectionDesc")}>
      <div className="grid gap-3 items-start" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(180px, 220px))" }}>
        <AnimatePresence initial={false} mode="popLayout">
          {rows.map((n) => (
            <motion.div key={n.id} {...rowMotion}>
              <StickerDisplay
                sticker={n}
                expanded={expandedId === n.id}
                onToggleExpand={() => setExpandedId(expandedId === n.id ? null : n.id)}
                hideHoverActions
                onSend={() => onSend(n)}
                sendDisabledReason={streaming ? t("stickers.waitForReply") : null}
                sending={sendingId === n.id}
                onDelete={() => void onDelete(n.id)}
              />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
      {rows.length === 0 && searching && (
        <div className="border border-dashed border-[var(--color-border)] rounded-[var(--radius-sm)] py-5 text-center text-xs text-[var(--color-muted)]">
          {t("stickers.noMatch")}
        </div>
      )}
    </SettingsSection>
  );
}

/** 设置页:双 Section 分层管理——搜索 + 贴纸网格 + 拖拽排序/跨区迁移。 */
export function StickersSettings(): ReactNode {
  const ctx = usePluginContext();
  const { t } = useTranslation();
  const { cwd, stickers, editing, setEditing, reload } = useStickers();
  const streaming = useSessionStore((s) => s.streaming);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  // 整体导入导出(zip):图标语义——上箭头=导出(打包带走),下箭头=导入(收进库)。
  const transfer = useStickerTransfer(ctx, reload);

  const send = useCallback(
    async (sticker: LayeredSticker): Promise<void> => {
      if (streaming || sendingId || !cwd) return;
      setSendingId(sticker.id);
      try {
        await sendSticker(ctx, cwd, sticker);
      } finally {
        setSendingId(null);
      }
    },
    [cwd, streaming, sendingId, ctx],
  );

  // cwd null 时也显示贴纸(全局层不依赖项目;发送需打开项目)

  const q = query.trim().toLowerCase();
  const matched = (n: LayeredSticker): boolean =>
    !q || (n.title ?? "").toLowerCase().includes(q) || n.content.toLowerCase().includes(q);
  const byLayer = (layer: StickerLayer): LayeredSticker[] => stickers.filter((n) => n.layer === layer && matched(n));
  // 搜索态/编辑态禁拖拽:过滤子集里重排会写回错误的 order
  const dndDisabled = editing !== null || q !== "";

  const onDragEnd = ({ active, over }: DragEndEvent): void => {
    if (!over || active.id === over.id) return;
    const activeSticker = stickers.find((n) => n.id === String(active.id));
    if (!activeSticker) return;
    const overSticker = stickers.find((n) => n.id === String(over.id));
    const overLayer = overSticker?.layer ?? (over.data.current as { layer?: StickerLayer } | undefined)?.layer;
    if (!overLayer) return;
    if (overLayer !== activeSticker.layer) {
      const layerStickers = stickers.filter((n) => n.layer === overLayer);
      const targetIndex = overSticker ? layerStickers.indexOf(overSticker) : null;
      void moveToLayer(ctx, activeSticker.id, overLayer, targetIndex).then(reload);
      return;
    }
    if (!overSticker) return;
    const ids = stickers.map((n) => n.id);
    void reorderStickers(ctx, arrayMove(ids, ids.indexOf(activeSticker.id), ids.indexOf(overSticker.id))).then(reload);
  };

  const saveNew = async (draft: StickerDraft): Promise<void> => {
    await createSticker(ctx, draft, editing?.targetLayer ?? "project");
    setEditing(null);
    await reload();
  };
  const saveEdit = async (id: string, draft: StickerDraft): Promise<void> => {
    await updateSticker(ctx, id, draft);
    setEditing(null);
    await reload();
  };
  const del = async (id: string): Promise<void> => {
    await removeSticker(ctx, id);
    await reload();
  };
  const move = async (id: string): Promise<void> => {
    await moveLayer(ctx, id);
    await reload();
  };

  const sectionProps = { editing, setEditing, expandedId, setExpandedId, streaming, sendingId, onSend: (n: LayeredSticker): void => void send(n), onSaveNew: saveNew, onSaveEdit: saveEdit, onDelete: del, onMoveLayer: move, dndDisabled, searching: q !== "" };

  return (
    <>
      <div className="flex items-center gap-2">
        <div className="flex-1 flex items-center gap-1.5 px-2 border border-[var(--color-border)] rounded-[var(--radius-sm)] text-[var(--color-muted)]">
          <Search className="size-3.5 shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("stickers.searchPlaceholder")}
            className="flex-1 bg-transparent border-none outline-none py-1.5 text-xs text-[var(--color-fg)] placeholder:text-[var(--color-muted)]"
          />
        </div>
        <button
          onClick={() => void transfer.doImport()}
          disabled={transfer.busy}
          title="导入贴纸 zip(整体还原:数据 + banner 图)"
          className="flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-[var(--radius-sm)] border border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-fg)] bg-transparent cursor-pointer disabled:opacity-40"
        >
          <Download className="size-3.5" />导入
        </button>
        <button
          onClick={() => void transfer.doExport()}
          disabled={transfer.busy}
          title="导出贴纸 zip(整体打包:数据 + banner 图)"
          className="flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-[var(--radius-sm)] border border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-fg)] bg-transparent cursor-pointer disabled:opacity-40"
        >
          <Upload className="size-3.5" />导出
        </button>
        <button
          onClick={() => setEditing({ title: "", content: "", targetLayer: "project" })}
          className="flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-[var(--radius-sm)] bg-[var(--color-primary)] text-[var(--color-bg)] border-none cursor-pointer"
        >
          <Plus className="size-3.5" />{t("stickers.newSticker")}
        </button>
      </div>
      {transfer.msg && (
        <div className="mt-1.5 px-2 py-1 text-xs rounded-[var(--radius-sm)] bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-muted)]">
          {transfer.msg}
        </div>
      )}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={stickers.map((n) => n.id)} strategy={rectSortingStrategy}>
          <LayerSection layer="project" title={t("stickers.projectSection")} description={t("stickers.projectSectionDesc")} rows={byLayer("project")} {...sectionProps} />
          <LayerSection layer="global" title={t("stickers.globalSection")} description={t("stickers.globalSectionDesc")} rows={byLayer("global")} {...sectionProps} />
        </SortableContext>
        <BuiltinSection rows={byLayer("builtin")} searching={q !== ""} expandedId={expandedId} setExpandedId={setExpandedId} streaming={streaming} sendingId={sendingId} onSend={(n) => void send(n)} onDelete={del} />
      </DndContext>
    </>
  );
}
