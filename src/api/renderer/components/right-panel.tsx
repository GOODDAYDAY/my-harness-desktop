import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import {
  DndContext, closestCenter, type DragEndEvent,
  PointerSensor, useSensor, useSensors,
} from "@dnd-kit/core";
import {
  SortableContext, useSortable, verticalListSortingStrategy, arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useTranslation } from "react-i18next";
import { PluginIcon, getSidePanelComponent, useUiStore, PluginIdContext, GENERAL_CONFIG_PATH } from "@pi-desktop/react";

interface SidePanelItem {
  id: string;
  label: string;
  icon: string;
  component: string;
  pluginId: string;
}

interface SidePanelData {
  items: SidePanelItem[];
  customOrder: string[] | null;
}

const EMPTY_DATA: SidePanelData = { items: [], customOrder: null };

let sidePanelCache: { nonce: number; data: SidePanelData } | null = null;
let sidePanelInflight: { nonce: number; promise: Promise<SidePanelData> } | null = null;

function loadSidePanelData(nonce: number): Promise<SidePanelData> {
  if (sidePanelCache && sidePanelCache.nonce === nonce) return Promise.resolve(sidePanelCache.data);
  if (!sidePanelInflight || sidePanelInflight.nonce !== nonce) {
    sidePanelInflight = {
      nonce,
      promise: Promise.all([
        window.pi.slots.sidePanel(),
        window.pi.configFile.get(GENERAL_CONFIG_PATH),
      ]).then(([loaded, cfg]) => {
        const data: SidePanelData = {
          items: loaded,
          customOrder: (cfg["sidePanelOrder"] as string[] | undefined) ?? null,
        };
        sidePanelCache = { nonce, data };
        sidePanelInflight = null;
        return data;
      }),
    };
  }
  return sidePanelInflight.promise;
}

/** Strip/Content 共享的 sidePanel 数据 hook:同 nonce 单发请求,结果共享 */
function useSidePanelData(): SidePanelData {
  // pluginsNonce 进依赖:插件启用/禁用/安装后重拉 sidePanel 槽贡献
  const pluginsNonce = useUiStore((s) => s.pluginsNonce);
  const [data, setData] = useState<SidePanelData>(
    () => (sidePanelCache && sidePanelCache.nonce === pluginsNonce ? sidePanelCache.data : EMPTY_DATA),
  );
  useEffect(() => {
    let alive = true;
    void loadSidePanelData(pluginsNonce).then((d) => { if (alive) setData(d); });
    return () => { alive = false; };
  }, [pluginsNonce]);
  return data;
}

function applyCustomOrder(items: SidePanelItem[], customOrder: string[] | null): SidePanelItem[] {
  if (!customOrder || customOrder.length === 0) return items;
  const orderMap = new Map(customOrder.map((id, i) => [id, i]));
  return [...items].sort((a, b) => {
    const aIdx = orderMap.get(a.id);
    const bIdx = orderMap.get(b.id);
    if (aIdx !== undefined && bIdx !== undefined) return aIdx - bIdx;
    if (aIdx !== undefined) return -1;
    if (bIdx !== undefined) return 1;
    return 0;
  });
}

export function SidePanelStrip(): React.ReactNode {
  const sidepanelStyle = useUiStore((s) => s.sidepanelStyle);
  const { items, customOrder: sharedOrder } = useSidePanelData();
  // 拖拽排序是 Strip 的交互状态:本地覆盖,写回 configFile + 共享缓存
  const [customOrder, setCustomOrderState] = useState<string[] | null>(null);
  const effectiveOrder = customOrder ?? sharedOrder;
  const activeTabs = useUiStore((s) => s.activeSidePanelTabs);
  const toggleSidePanelTab = useUiStore((s) => s.toggleSidePanelTab);

  const setCustomOrder = (order: string[]): void => {
    setCustomOrderState(order);
    if (sidePanelCache) sidePanelCache.data = { ...sidePanelCache.data, customOrder: order };
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const orderedItems = useMemo(() => applyCustomOrder(items, effectiveOrder), [items, effectiveOrder]);

  const rightPanelOpen = useUiStore((s) => s.rightPanelOpen);
  useEffect(() => {
    if (rightPanelOpen && activeTabs.length === 0 && orderedItems.length > 0) {
      toggleSidePanelTab(orderedItems[0].id);
    }
  }, [rightPanelOpen, activeTabs.length, orderedItems, toggleSidePanelTab]);

  const handleDragEnd = (e: DragEndEvent): void => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIdx = orderedItems.findIndex((i) => i.id === active.id);
    const newIdx = orderedItems.findIndex((i) => i.id === over.id);
    if (oldIdx === -1 || newIdx === -1) return;
    const newOrder = arrayMove(orderedItems, oldIdx, newIdx).map((i) => i.id);
    setCustomOrder(newOrder);
    void window.pi.configFile.set(GENERAL_CONFIG_PATH, { sidePanelOrder: newOrder }, "deep");
  };

  if (orderedItems.length === 0) return null;

  return (
    <div data-sidepanel-style={sidepanelStyle} className="flex flex-col items-center gap-1.5 py-3 w-12 shrink-0 bg-[var(--color-chrome)] border-l border-[var(--color-border)]" style={{ gap: "var(--sidepanel-icon-gap)" }}>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={orderedItems.map((i) => i.id)} strategy={verticalListSortingStrategy}>
          {orderedItems.map((item) => (
            <SortableIcon
              key={item.id}
              item={item}
              isActive={activeTabs.includes(item.id)}
              onClick={() => toggleSidePanelTab(item.id)}
            />
          ))}
        </SortableContext>
      </DndContext>
    </div>
  );
}

function SortableIcon({ item, isActive, onClick }: {
  item: SidePanelItem;
  isActive: boolean;
  onClick: () => void;
}): React.ReactNode {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 50 : undefined,
    position: "relative",
  };

  return (
    <div ref={setNodeRef} style={style}>
      <button
        {...attributes}
        {...listeners}
        onClick={onClick}
        title={item.label}
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: "var(--sidepanel-icon-btn-size)",
          height: "var(--sidepanel-icon-btn-size)",
          borderRadius: "var(--sidepanel-icon-btn-radius)",
          border: "var(--sidepanel-icon-btn-border)",
          background: isActive ? "var(--sidepanel-icon-btn-bg-active)" : "var(--sidepanel-icon-btn-bg)",
          backdropFilter: "var(--sidepanel-glass-blur, none)",
          color: isActive ? "var(--color-fg)" : "var(--color-muted)",
          cursor: "pointer",
          transition: "background 0.15s, color 0.15s, border-color 0.15s",
          touchAction: "none",
        }}
      >
        {isActive && (
          <span style={{
            position: "absolute",
            left: 0,
            top: "50%",
            transform: "translateY(-50%)",
            height: "var(--sidepanel-icon-active-indicator-height)",
            borderLeft: "var(--sidepanel-icon-active-indicator)",
            borderRadius: "0 2px 2px 0",
          }} className="sidepanel-indicator-in" />
        )}
        <PluginIcon name={item.icon} style={{ width: "var(--sidepanel-icon-size)", height: "var(--sidepanel-icon-size)" }} />
      </button>
    </div>
  );
}

// 板块收起动画(docs/design/sidepanel-close-animation.md):
// closing panel 保持原位,rAF 驱动 ImperativePanelHandle.resize() 平滑收起到 0,
// rAF 结束帧(确定性信号,非 setTimeout 赌注)才真正从 PanelGroup 移除。
// 移除瞬间 active panel 用 defaultSize=记录值精确恢复尺寸,无跳变。
// closing 期间重新激活:cancelAnimationFrame + resize 回 startSize 精确恢复。
const CLOSE_ANIM_MS = 240;
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

type PanelRefLike = {
  getSize(): number;
  resize(size: number): void;
};

export function RightPanelContent(): React.ReactNode {
  const { t } = useTranslation();
  const sidepanelStyle = useUiStore((s) => s.sidepanelStyle);
  const { items, customOrder } = useSidePanelData();
  const activeTabs = useUiStore((s) => s.activeSidePanelTabs);
  const [handleDragging, setHandleDragging] = useState(false);

  const orderedItems = useMemo(
    () => applyCustomOrder(items.filter((i) => activeTabs.includes(i.id)), customOrder),
    [items, activeTabs, customOrder],
  );

  const itemsById = useMemo(() => new Map(items.map((x) => [x.id, x])), [items]);

  // renderIds = PanelGroup 渲染的 panel id 顺序(活跃 ∪ closing),closing 保持原位
  const [renderIds, setRenderIds] = useState<string[]>(() => orderedItems.map((x) => x.id));
  const renderIdsRef = useRef<string[]>(renderIds);
  useEffect(() => { renderIdsRef.current = renderIds; }, [renderIds]);
  const [closingIds, setClosingIds] = useState<string[]>([]);
  // 移除瞬时:active panel 用 defaultSize=记录值精确恢复,恢复后 effect 清空
  const [defaultSizes, setDefaultSizes] = useState<Record<string, number>>({});
  const panelRefs = useRef(new Map<string, PanelRefLike>());
  const rafIdsRef = useRef(new Map<string, number>());
  const startSizesRef = useRef(new Map<string, number>());
  // 各 tab 关闭前的尺寸(关闭开始时记录,finishClose 不清),重开修复用
  const lastSizesRef = useRef(new Map<string, number>());

  // reconcile:活跃顺序为骨架,closing id 插回上帧原位
  const reconcile = useCallback((prev: string[], active: string[], closing: string[]): string[] => {
    const next = [...active];
    for (const cid of closing) {
      if (next.includes(cid)) continue;
      const idx = prev.indexOf(cid);
      let anchor = -1;
      for (let i = idx - 1; i >= 0; i--) {
        const j = next.indexOf(prev[i]);
        if (j !== -1) { anchor = j; break; }
      }
      next.splice(anchor + 1, 0, cid);
    }
    return next;
  }, []);

  // 幸存者尺寸快照与过滤放在同一个 updater 里完成:保证"移除 id + 记录其余
  // panel 尺寸"在同一个 commit 生效,不给 reconcile 留下按 closing 身份回插的空隙。
  const finishClose = useCallback((id: string) => {
    setRenderIds((prev) => {
      const ids = prev.filter((x) => x !== id);
      const sizes: Record<string, number> = {};
      for (const rid of ids) {
        const sz = panelRefs.current.get(rid)?.getSize();
        if (sz != null) sizes[rid] = sz;
      }
      setDefaultSizes(sizes);
      return ids;
    });
    setClosingIds((ex) => ex.filter((x) => x !== id));
  }, []);

  const startCloseAnim = useCallback((id: string) => {
    if (rafIdsRef.current.has(id)) return;
    const startSize = panelRefs.current.get(id)?.getSize();
    if (startSize == null || startSize <= 0) { finishClose(id); return; }
    startSizesRef.current.set(id, startSize);
    lastSizesRef.current.set(id, startSize);
    const start = performance.now();
    const tick = (now: number): void => {
      // 多 tab 同关时其余 panel 可能先收完,组内只剩本 panel——
      // 继续 resize() 同样踩 1-panel pivot 断言,终止动画直接移除。
      if (panelRefs.current.size <= 1) {
        rafIdsRef.current.delete(id);
        startSizesRef.current.delete(id);
        finishClose(id);
        return;
      }
      const tt = Math.min((now - start) / CLOSE_ANIM_MS, 1);
      panelRefs.current.get(id)?.resize(startSize * (1 - easeInOutCubic(tt)));
      if (tt < 1) {
        rafIdsRef.current.set(id, requestAnimationFrame(tick));
      } else {
        rafIdsRef.current.delete(id);
        startSizesRef.current.delete(id);
        panelRefs.current.get(id)?.resize(0);
        finishClose(id);
      }
    };
    rafIdsRef.current.set(id, requestAnimationFrame(tick));
  }, [finishClose]);

  // 活跃集合变化:removed → closing 保留原位;added → reconcile 插入;renderIds 维护
  useEffect(() => {
    const cur = orderedItems.map((x) => x.id);
    const prev = renderIdsRef.current;
    const removed = prev.filter((id) => !cur.includes(id));
    const added = cur.filter((id) => !prev.includes(id));
    // closing 期间重新激活:移出 closingIds,触发下方 cancel effect 停 rAF 并恢复尺寸
    const reopened = closingIds.filter((id) => cur.includes(id));
    if (reopened.length > 0) {
      setClosingIds((ex) => ex.filter((x) => !reopened.includes(x)));
    }
    if (removed.length === 0 && added.length === 0) return;
    if (removed.length > 0) {
      // 组内 ≤1 panel 时直接移除、不进 closing/rAF 流程:单 panel 恒 100% 无邻居
      // 可吸收空间,动画无对象;且库 imperative resize() 在 1-panel 组 pivot 算出
      // [-1,0](panelDataHelper:isLastPanel → [panelIndex-1, panelIndex]),
      // adjustLayoutByDelta 断言 initialLayout[-1] 直接抛错白屏。
      // 关键:instant 路径若走 finishClose+reconcile 组合,reconcile 会在同一批
      // 更新里把刚移除的 id 按 closing 身份插回去,renderIds 移而不除无限循环。
      const instant = panelRefs.current.size <= 1 ? removed : [];
      const animated = removed.filter((id) => !instant.includes(id));
      if (animated.length > 0) {
        setClosingIds((ex) => [...new Set([...ex, ...animated])]);
        animated.forEach(startCloseAnim);
      }
      setRenderIds((prev2) => reconcile(
        instant.length > 0 ? prev2.filter((x) => !instant.includes(x)) : prev2,
        cur,
        [...closingIds, ...animated],
      ));
    } else {
      setRenderIds((prev2) => reconcile(prev2, cur, closingIds));
    }
  }, [orderedItems, closingIds, reconcile, startCloseAnim]);

  // closing 取消:id 重新激活时取消 rAF 并恢复起始尺寸;组件卸载时全部取消
  useEffect(() => {
    for (const [id, rafId] of rafIdsRef.current) {
      if (!closingIds.includes(id)) {
        cancelAnimationFrame(rafId);
        rafIdsRef.current.delete(id);
        const startSize = startSizesRef.current.get(id);
        if (startSize != null) panelRefs.current.get(id)?.resize(startSize);
        startSizesRef.current.delete(id);
      }
    }
  }, [closingIds]);
  useEffect(() => () => {
    for (const [, rafId] of rafIdsRef.current) cancelAnimationFrame(rafId);
  }, []);

  // defaultSizes 恢复后清空(state 恢复帧用,不持久)
  useEffect(() => {
    if (Object.keys(defaultSizes).length > 0) setDefaultSizes({});
  }, [defaultSizes]);

  // 重开尺寸修复:库 autoSave 可能把动画中途(closing panel 近 0)的布局落盘,
  // 重开按位置恢复——被压到近 0 的不一定是新挂的 panel(位置序,谁落 index 0
  // 谁吃 0)。不信任存档:renderIds 变化(panel 挂载 + 库恢复落定都在本 effect
  // 之前完成——库的恢复在 layout effect,本 effect 是 passive)后全组巡检,
  // 非 closing 面板恢复值近 0 的 resize 回 lastSize(无记录则均摊)。
  // 单 panel 组跳过:恒 100%,且 resize() 会踩 1-panel pivot 断言。
  useEffect(() => {
    if (panelRefs.current.size <= 1) return;
    for (const [pid, h] of panelRefs.current) {
      if (rafIdsRef.current.has(pid)) continue;
      if (h.getSize() >= 1) continue;
      try {
        // lastSize 本身也可能是毒化值(被压时关闭就会记录压后尺寸):<5% 视为不可用,
        // 回退均摊——修复的目的是可用,不是精确还原一个本来就不可用的尺寸。
        const recorded = lastSizesRef.current.get(pid);
        const target = recorded != null && recorded >= 5 ? recorded : 100 / panelRefs.current.size;
        h.resize(target);
      } catch { /* 与库状态竞争时放弃本次矫正,不影响主流程 */ }
    }
  }, [renderIds]);

  if (renderIds.length === 0) {
    return <div className="h-full bg-[var(--color-chrome)]" />;
  }

  return (
    <div data-sidepanel-style={sidepanelStyle} className="h-full flex flex-col bg-[var(--color-chrome)]">
      <PanelGroup direction="vertical" className="h-full" autoSaveId="right-panel-v">
        {renderIds.map((id, i) => {
          const item = itemsById.get(id);
          if (!item) return null;
          const isActive = activeTabs.includes(id);
          const Comp = getSidePanelComponent(item.component);
          return (
            <Fragment key={id}>
              <Panel
                ref={(h) => {
                  if (h) panelRefs.current.set(id, h as PanelRefLike);
                  else panelRefs.current.delete(id);
                }}
                minSize={0}
                collapsible
                collapsedSize={0}
                defaultSize={defaultSizes[id]}
                className="min-h-0"
              >
              <div
                className="h-full flex flex-col min-h-0 sidepanel-panel-enter"
                style={{ opacity: isActive ? 1 : 0.5, transition: "opacity 0.15s" }}
              >
                <div
                  className="flex items-center gap-2 shrink-0 select-none cursor-pointer transition-colors"
                  style={{
                    padding: "var(--sidepanel-header-py) var(--sidepanel-header-px)",
                    border: "var(--sidepanel-header-border)",
                    background: "var(--sidepanel-header-bg)",
                    backdropFilter: "var(--sidepanel-glass-blur, none)",
                    fontSize: "var(--sidepanel-header-fs)",
                    fontWeight: "var(--sidepanel-header-fw)",
                    color: "var(--color-fg)",
                  }}
                  onClick={() => useUiStore.getState().toggleSidePanelTab(item.id)}
                >
                  <PluginIcon name={item.icon} className="size-4 shrink-0" />
                  <span className="truncate">{item.label}</span>
                </div>
                <div className="flex-1 overflow-y-auto min-h-0" style={{ padding: "var(--sidepanel-content-py) var(--sidepanel-content-px)" }}>
                  {Comp ? (
                    <PluginIdContext.Provider value={item.pluginId}>
                      <Comp isActive={isActive} />
                    </PluginIdContext.Provider>
                  ) : (
                    <div className="p-4 text-[var(--color-muted)] text-[var(--font-size-sm)]">
                      {t("shell.componentNotRegistered", { component: item.component, plugin: item.pluginId })}
                    </div>
                  )}
                </div>
              </div>
              </Panel>
              {i < renderIds.length - 1 && (
                <PanelResizeHandle
                  onDragging={setHandleDragging}
                  style={{
                    height: "8px",
                    cursor: "row-resize",
                    background: "transparent",
                    display: "var(--sidepanel-divider-display)",
                    alignItems: "center",
                    transition: "background 0.15s",
                  }}
                >
                  <div
                    style={{
                      width: "100%",
                      height: "var(--divider-width)",
                      margin: "0 var(--divider-inset)",
                      background: handleDragging ? "var(--color-primary)" : "var(--sidepanel-divider-color)",
                      borderRadius: "var(--radius-sm)",
                      transition: "background 0.15s",
                    }}
                  />
                </PanelResizeHandle>
              )}
            </Fragment>
          );
        })}
      </PanelGroup>
    </div>
  );
}
