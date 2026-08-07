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
import { PluginIcon, getSidePanelComponent, useUiStore, PluginIdContext, useGroupHidden, DEFAULT_GROUP_IDS, eventBus } from "@pi-desktop/react";
import { writeGeneralConfig } from "../stores/general-config";

interface SidePanelItem {
  id: string;
  label: string;
  icon: string;
  component: string;
  pluginId: string;
  revealOn?: string;
}

interface SidePanelData {
  items: SidePanelItem[];
  /** 是否已完成一次真实加载(EMPTY_DATA 占位期为 false)。占位期 items 为空,
   *  prune 等消费方必须等 ready,否则活跃 tab 会被误判成死 id 全清。 */
  ready: boolean;
}

const EMPTY_DATA: SidePanelData = { items: [], ready: false };

let sidePanelCache: { nonce: number; data: SidePanelData } | null = null;
let sidePanelInflight: { nonce: number; promise: Promise<SidePanelData> } | null = null;

function loadSidePanelData(nonce: number): Promise<SidePanelData> {
  if (sidePanelCache && sidePanelCache.nonce === nonce) return Promise.resolve(sidePanelCache.data);
  if (!sidePanelInflight || sidePanelInflight.nonce !== nonce) {
    sidePanelInflight = {
      nonce,
      promise: window.pi.slots.sidePanel().then((loaded) => {
        const data: SidePanelData = { items: loaded, ready: true };
        sidePanelCache = { nonce, data };
        sidePanelInflight = null;
        return data;
      }),
    };
  }
  return sidePanelInflight.promise;
}

/** 排序(sidePanelOrder)的唯一读取口:真相源是 ui-store.generalConfig——hydrate 分层读、
 *  cwd 切换重读、configFileSaved 广播重读全是框架既有通道(§3.6 事件驱动),组件订阅派生,
 *  不各自拉配置。根因修复:旧实现把配置读塞进下方清单 hook 的 nonce 键控缓存,启动竞态下
 *  拿到全局层空值后永不重读,重启"丢"顺序;且 Strip 拖拽只 mutate 缓存,Content 永不跟随。 */
function useSidePanelOrder(): string[] | null {
  return useUiStore((s) => (s.generalConfig["sidePanelOrder"] as string[] | undefined) ?? null);
}

/** Strip/Content 共享的 sidePanel 清单 hook:同 nonce 单发请求,结果共享。只管贡献清单。 */
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
  const { items, ready } = useSidePanelData();
  const configOrder = useSidePanelOrder();
  // 拖拽乐观值:松手即写盘,广播追平前本地先行;内容与追平后的 configOrder 等价,
  // 无需清空对齐——组件卸载自然归零,重启后由 configOrder 恢复。
  const [customOrder, setCustomOrder] = useState<string[] | null>(null);
  const effectiveOrder = customOrder ?? configOrder;
  const activeTabs = useUiStore((s) => s.activeSidePanelTabs);
  const toggleSidePanelTab = useUiStore((s) => s.toggleSidePanelTab);
  const pruneSidePanelTabs = useUiStore((s) => s.pruneSidePanelTabs);

  // 清单刷新后剔除死 tab id(卸载/禁用的插件贡献已从清单消失,但 prefs 持久化的
  // 活跃数组不会自动收缩)。ready 守卫:占位期 items 为空,此时 prune 会把活跃
  // tab 误判成死 id 全清。
  useEffect(() => {
    if (!ready) return;
    pruneSidePanelTabs(items.map((i) => i.id));
  }, [items, ready, pruneSidePanelTabs]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const orderedItems = useMemo(() => applyCustomOrder(items, effectiveOrder), [items, effectiveOrder]);

  const rightPanelHidden = useGroupHidden(DEFAULT_GROUP_IDS.RIGHT);
  useEffect(() => {
    if (!rightPanelHidden && activeTabs.length === 0 && orderedItems.length > 0) {
      toggleSidePanelTab(orderedItems[0].id);
    }
  }, [rightPanelHidden, activeTabs.length, orderedItems, toggleSidePanelTab]);

  // revealOn 声明式揭示(契约见 domain SidePanelContribution):事件总线 tap 侦听,
  // 命中即幂等激活对应 Tab 并展开右面板——触发方(如 timeline 收藏按钮)不认识
  // 贡献者,贡献者代码不出现自己的 contribution id,框架居中撮合。
  const activateSidePanelTab = useUiStore((s) => s.activateSidePanelTab);
  useEffect(() => {
    const byChannel = new Map<string, string>();
    for (const item of items) {
      if (item.revealOn) byChannel.set(item.revealOn, item.id);
    }
    if (byChannel.size === 0) return;
    return eventBus.tap((channel) => {
      const tabId = byChannel.get(channel);
      if (tabId) activateSidePanelTab(tabId);
    });
  }, [items, activateSidePanelTab]);

  const handleDragEnd = (e: DragEndEvent): void => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIdx = orderedItems.findIndex((i) => i.id === active.id);
    const newIdx = orderedItems.findIndex((i) => i.id === over.id);
    if (oldIdx === -1 || newIdx === -1) return;
    const newOrder = arrayMove(orderedItems, oldIdx, newIdx).map((i) => i.id);
    setCustomOrder(newOrder);
    void writeGeneralConfig({ sidePanelOrder: newOrder });
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
// closing 期间重新激活:cancelAnimationFrame + resize 回 startSize 精确恢复。
//
// 板块尺寸模型(v2,id 键控权重,docs/design/sidepanel-close-animation.md §2.2 决策四):
//   单一数据源 weightsRef: panel id → 权重(比例即可,不必归一);
//   渲染时 defaultSize = 权重/全部渲染 id 权重和 × 100。
//   加板块:新 id 权重 = 现存均权 → 未拖过时第 n 个精确 1/n,拖过后新旧间等比吸收;
//   删板块:摘除其权重 → 剩余按各自权重归一,等比放大吸收空间;
//   拖拽:库 onLayout 按 renderIds 序把尺寸回写成 id 权重——id 键控,
//        杜绝 autoSaveId 按位置存档/恢复(板块序与存档位置序错位)造成的整组布局污染
//        (旧"重开近 0 修复"就是它的补丁,随 autoSaveId 一并删除)。
//   尺寸不跨会话持久化:冷启动恒平分,会话内手动拖动/开关板块有效。
const CLOSE_ANIM_MS = 240;
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

type PanelRefLike = {
  getSize(): number;
  resize(size: number): void;
};

function meanWeight(weights: Map<string, number>): number {
  if (weights.size === 0) return 1;
  let sum = 0;
  weights.forEach((v) => { sum += v; });
  return sum / weights.size;
}

export function RightPanelContent(): React.ReactNode {
  const { t } = useTranslation();
  const sidepanelStyle = useUiStore((s) => s.sidepanelStyle);
  const { items } = useSidePanelData();
  const customOrder = useSidePanelOrder();
  const activeTabs = useUiStore((s) => s.activeSidePanelTabs);
  const [handleDragging, setHandleDragging] = useState(false);

  const orderedItems = useMemo(
    () => applyCustomOrder(items.filter((i) => activeTabs.includes(i.id)), customOrder),
    [items, activeTabs, customOrder],
  );

  const itemsById = useMemo(() => new Map(items.map((x) => [x.id, x])), [items]);

  // renderIds = PanelGroup 渲染的 panel id 顺序(活跃 ∪ closing),closing 保持原位
  const [renderIds, setRenderIds] = useState<string[]>(() => orderedItems.map((x) => x.id));
  // render 期同步(非 useEffect):库 onLayout 在 useLayoutEffect 中触发,先于 useEffect。
  // 若用 useEffect 同步,syncWeights 拿到的是旧 renderIds → 尺寸映射错位,
  // 多轮 toggle 顶部板块后底部板块权重逐轮递减趋 0,面板"消失"。
  const renderIdsRef = useRef<string[]>(renderIds);
  renderIdsRef.current = renderIds;
  const [closingIds, setClosingIds] = useState<string[]>([]);
  // 尺寸单一数据源:panel id → 权重。render 期按 id 幂等填充(缺省=均权),
  // 每次渲染的 defaultSize 用本批 renderIds 归一:同一渲染内所有 panel 拿到同一分母。
  const weightsRef = useRef(new Map<string, number>());
  const panelRefs = useRef(new Map<string, PanelRefLike>());
  const rafIdsRef = useRef(new Map<string, number>());
  const startSizesRef = useRef(new Map<string, number>());

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

  // 尺寸权重归一成该 panel 的百分比(defaultSize 数据源)。
  const sizeFor = (id: string): number => {
    const w = weightsRef.current;
    let sum = 0;
    for (const rid of renderIds) {
      if (!w.has(rid)) w.set(rid, meanWeight(w));
      sum += w.get(rid)!;
    }
    return sum > 0 ? (w.get(id)! / sum) * 100 : 100 / Math.max(1, renderIds.length);
  };

  // 库布局(初始化/拖拽/关闭动画帧)的唯一回写点:按 renderIds 序映射回 id 权重。
  // 关闭动画的中间帧也回写——幸存者的"吸收后尺寸"自然存续,finishClose 后归一零跳变。
  const syncWeights = useCallback((sizes: number[]): void => {
    const ids = renderIdsRef.current;
    for (let i = 0; i < ids.length; i++) {
      const s = sizes[i];
      if (typeof s === "number" && s > 0) weightsRef.current.set(ids[i], s);
    }
  }, []);

  // finishClose:摘除权重——onLayout 每帧已把幸存者吸收后的尺寸写回权重,
  // 移除后 re-render 按剩余权重归一,结果=动画末布局,移除瞬间无跳变。
  const finishClose = useCallback((id: string) => {
    weightsRef.current.delete(id);
    setRenderIds((prev) => prev.filter((x) => x !== id));
    setClosingIds((ex) => (ex.includes(id) ? ex.filter((x) => x !== id) : ex));
  }, []);

  const startCloseAnim = useCallback((id: string) => {
    if (rafIdsRef.current.has(id)) return;
    const startSize = panelRefs.current.get(id)?.getSize();
    if (startSize == null || startSize <= 0) { finishClose(id); return; }
    startSizesRef.current.set(id, startSize);
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
      setClosingIds((ex) => {
        const next = ex.filter((x) => !reopened.includes(x));
        return next.length === ex.length ? ex : next;
      });
    }
    if (removed.length === 0 && added.length === 0) {
      // 成员不变仅顺序变(Strip 拖拽排序经 configFileSaved 广播追平):按新活跃序
      // reconcile 重排——closing 保位,权重 id 键控不带尺寸污染。sameIds 双守卫:
      // 外层拦"closingIds 依赖触发的空跑",内层拦"reconcile 结果与现状一致"。
      if (!sameIds(prev, cur)) {
        setRenderIds((prev2) => {
          const next = reconcile(prev2, cur, closingIds);
          return sameIds(prev2, next) ? prev2 : next;
        });
      }
      return;
    }
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
        // 幂等守卫(根因修复 G-20260802-01):animated 已全部在 closingIds 时返回原引用。
        // closingIds 是本 effect 的依赖——内容没变却返回新数组会让 effect 自触发,
        // 整个动画期间每秒数百次空转;空转帧持过期 closingIds/renderIds 闭包,与
        // rAF 结束帧 finishClose 的移除更新落在同一批:刚移除的 id 被重新塞回
        // closingIds,reconcile 在已过滤的 prev 里 indexOf=-1 → splice(0,0) 把它
        // 插到最前(实证:被收起的是底部板块,缩到 0 的却是最上面的板块),panel id
        // 序变化又使库约束签名失效、布局重置均分,rafIdsRef 已清 → startCloseAnim
        // 重启动画——收起动画以 240ms 为周期无限循环。
        setClosingIds((ex) => {
          const missing = animated.filter((id) => !ex.includes(id));
          return missing.length > 0 ? [...ex, ...missing] : ex;
        });
        animated.forEach(startCloseAnim);
      }
      setRenderIds((prev2) => {
        const next = reconcile(
          instant.length > 0 ? prev2.filter((x) => !instant.includes(x)) : prev2,
          cur,
          [...closingIds, ...animated],
        );
        return sameIds(prev2, next) ? prev2 : next;
      });
    } else {
      setRenderIds((prev2) => {
        const next = reconcile(prev2, cur, closingIds);
        return sameIds(prev2, next) ? prev2 : next;
      });
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

  if (renderIds.length === 0) {
    return <div className="h-full bg-[var(--color-chrome)]" />;
  }

  return (
    <div data-sidepanel-style={sidepanelStyle} className="h-full flex flex-col bg-[var(--color-chrome)]"
      style={{
        "--font-size-xs": "calc(var(--font-size-xs-raw) * var(--sidepanel-font-scale, 1))",
        "--font-size-sm": "calc(var(--font-size-sm-raw) * var(--sidepanel-font-scale, 1))",
        "--font-size-base": "calc(var(--font-size-base-raw) * var(--sidepanel-font-scale, 1))",
        "--font-size-lg": "calc(var(--font-size-lg-raw) * var(--sidepanel-font-scale, 1))",
        "--sidepanel-header-fs": "calc(var(--font-size-sm-raw) * var(--sidepanel-font-scale, 1))",
        "--sidepanel-section-fs": "calc(var(--font-size-sm-raw) * var(--sidepanel-font-scale, 1))",
      } as React.CSSProperties}
    >
      <PanelGroup direction="vertical" className="h-full" onLayout={syncWeights}>
        {renderIds.map((id, i) => {
          const item = itemsById.get(id);
          if (!item) return null;
          const isActive = activeTabs.includes(id);
          const Comp = getSidePanelComponent(item.component);
          return (
            <Fragment key={id}>
              <Panel
                id={id}
                order={i}
                ref={(h) => {
                  if (h) panelRefs.current.set(id, h as PanelRefLike);
                  else panelRefs.current.delete(id);
                }}
                minSize={0}
                collapsible
                collapsedSize={0}
                defaultSize={sizeFor(id)}
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
                    <div className="p-4 text-[var(--color-muted)] text-[length:var(--font-size-sm)]">
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
