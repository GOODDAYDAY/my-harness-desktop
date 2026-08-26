// 布局引擎 —— 把布局树翻译成 react-resizable-panels 的递归渲染器。
//
// 内核只识节点的 kind(判别标签),不认具体业务——split 译成 PanelGroup+PanelResizeHandle,
// group 译成 tab strip + 保活内容区。引擎不管组内内容是什么(§2.1 全文)。
// 设计文档: docs/design/dynamic-layout.md §2.1–§2.4。
import React, {
  memo, useCallback, useEffect, useMemo, useRef, useState,
} from "react";
import type { ComponentType, ReactNode } from "react";
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelHandle } from "react-resizable-panels";
import { useTranslation } from "react-i18next";
import {
  useLayoutStore,
  useUiStore,
  PluginIdContext,
  PluginIcon,
  getPluginComponent,
  DEFAULT_GROUP_IDS,
  SIDEBAR_MIN_PX,
  SIDEBAR_MAX_PX,
} from "@my-harness-desktop/react";
import { TimelineThemeScope } from "../theme-context";
import { Sidebar } from "./sidebar";
import { RightPanelContent } from "./right-panel";
import type { LayoutNode, LayoutSplit, LayoutGroup, ViewInstance } from "@my-harness-desktop/contract";

// ============================================================================
// 全局拖拽追踪(§4.3): sweepStaleViews 需在拖拽中延迟执行
// ============================================================================

let draggingCount = 0;

/** 当前是否有布局 resize handle 正在被拖拽(§4.3 拖拽护栏)。 */
export function isLayoutDragging(): boolean {
  return draggingCount > 0;
}

// ============================================================================
// 常量
// ============================================================================

const ANIM_CLASS = "panel-collapse-anim";

function collectHiddenMap(node: LayoutNode): Map<string, boolean> {
  const m = new Map<string, boolean>();
  if (node.kind === "group") {
    m.set(node.id, node.hidden === true);
  } else {
    for (const child of node.children) {
      for (const [id, h] of collectHiddenMap(child)) {
        m.set(id, h);
      }
    }
  }
  return m;
}

/** 组 panel 最小尺寸(设计 §7 Q:10% 量级);main/right 各有约束,left 用侧栏像素约束。 */
const DEF_MIN_PCT = 10;
const MAIN_MIN_PCT = 20;
const RIGHT_MIN_PCT = 16;

// ============================================================================
// Shell 组件表(§2.1): pluginId==="shell" 时按 component 名查表
// ============================================================================

const shellComponentTable: Record<string, ComponentType<unknown>> = {
  Sidebar,
  RightPanelContent,
};

// ============================================================================
// 主题作用域组件表(§2.1): themeScope 字段 → 包装组件
// ============================================================================

const scopeComponentTable: Record<string, ComponentType<{ children: ReactNode }>> = {
  timeline: TimelineThemeScope,
};

// ============================================================================
// 保活 Tab:挂载则活在 DOM,切到别的 tab 改 display:none(§2.2)
// ============================================================================

const KeepAliveView = memo(function KeepAliveView({
  view,
  active,
}: {
  view: ViewInstance;
  active: boolean;
}): ReactNode {
  const { component, pluginId, props, themeScope } = view;
  const { t } = useTranslation();

  let Comp: ComponentType<unknown> | undefined;

  if (pluginId === "shell") {
    Comp = shellComponentTable[component];
  } else {
    Comp = getPluginComponent(pluginId, component) as ComponentType<unknown> | undefined;
  }

  if (!Comp) {
    return (
      <div className="h-full flex items-center justify-center text-[var(--color-muted)] text-sm">
        {t("shell.componentNotRegistered", { component, plugin: pluginId })}
      </div>
    );
  }

  const viewProps = (props != null ? props : {}) as Record<string, unknown>;
  const inner = <Comp {...viewProps} />;

  const ScopeWrapper = themeScope ? scopeComponentTable[themeScope] : undefined;

  // h-full flex flex-col:视图根普遍是 flex-1(时间线/文件预览),父级必须是
  // flex 容器否则 flex-1 失效塌成内容高度(TimelineThemeScope 是 display:contents,
  // 不补链——它的注释里钉过同一个坑)。active 时 class 的 flex 生效,隐藏时 display:none。
  return (
    <div className="h-full flex flex-col" style={{ display: active ? undefined : "none" }}>
      <PluginIdContext.Provider value={pluginId}>
        {ScopeWrapper ? <ScopeWrapper>{inner}</ScopeWrapper> : inner}
      </PluginIdContext.Provider>
    </div>
  );
});

// ============================================================================
// GroupTabStrip: tabs 渲染(chrome)
// ============================================================================

const GroupTabStrip = memo(function GroupTabStrip({
  tabs,
  activeViewId,
  onActivate,
  onClose,
}: {
  tabs: ViewInstance[];
  activeViewId: string | null;
  onActivate: (viewId: string) => void;
  onClose: (viewId: string) => void;
}): ReactNode {
  return (
    <div
      className="flex items-center shrink-0 select-none overflow-x-auto"
      style={{
        height: "36px",
        paddingLeft: "4px",
        borderBottom: "1px solid var(--color-border)",
        gap: "2px",
      }}
    >
      {tabs.map((tab) => {
        const active = tab.viewId === activeViewId;
        return (
          <div
            key={tab.viewId}
            className="flex items-center cursor-pointer shrink-0 select-none group"
            style={{
              height: "30px",
              padding: "0 6px 0 10px",
              borderRadius: "var(--radius-sm) var(--radius-sm) 0 0",
              fontSize: "var(--font-size-base)",
              color: active ? "var(--color-fg)" : "var(--color-muted)",
              background: active ? "var(--color-bg)" : "transparent",
              border: active ? "1px solid var(--color-border)" : "1px solid transparent",
              borderBottom: active ? "1px solid var(--color-bg)" : "1px solid transparent",
              gap: "6px",
            }}
            onClick={() => onActivate(tab.viewId)}
            title={tab.title}
          >
            {tab.icon ? <PluginIcon name={tab.icon} className="size-3.5 shrink-0" /> : null}
            <span className="truncate max-w-[160px]">{tab.title}</span>
            {tab.closable ? (
              <button
                className="flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-[var(--color-border)] rounded-sm shrink-0"
                style={{
                  width: "16px",
                  height: "16px",
                  border: "none",
                  background: "transparent",
                  color: "var(--color-muted)",
                  cursor: "pointer",
                  fontSize: "var(--font-size-xs)",
                  lineHeight: "1",
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.viewId);
                }}
                aria-label={`Close ${tab.title}`}
              >
                ✕
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
});

// ============================================================================
// LayoutGroupRenderer: 组的 tab strip + 保活内容区(§2.1)
// ============================================================================

const LayoutGroupRenderer = memo(function LayoutGroupRenderer({
  group,
  views,
}: {
  group: LayoutGroup;
  views: Record<string, ViewInstance>;
}): ReactNode {
  const { t } = useTranslation();
  const activateView = useLayoutStore((s) => s.activateView);
  const closeView = useLayoutStore((s) => s.closeView);
  const { viewIds, activeViewId } = group;

  // tab strip 显示条件(§2.1): viewIds.length > 1 || 单视图可关闭
  const showStrip =
    viewIds.length > 1 ||
    (viewIds.length === 1 && (views[viewIds[0]]?.closable === true));

  // 空组:main 组回退"mainView 槽无贡献"(§4.3),其余空组渲染空容器
  if (viewIds.length === 0) {
    if (group.id === DEFAULT_GROUP_IDS.MAIN) {
      return (
        <div className="h-full flex items-center justify-center text-[var(--color-muted)] text-sm">
          {t("shell.mainViewEmpty")}
        </div>
      );
    }
    return <div className="h-full" />;
  }

  const tabs = viewIds.map((vid) => views[vid]).filter(Boolean);

  return (
    <div className="h-full flex flex-col">
      {showStrip ? (
        <GroupTabStrip
          tabs={tabs}
          activeViewId={activeViewId}
          onActivate={activateView}
          onClose={closeView}
        />
      ) : null}
      <div className="flex-1 min-h-0 relative">
        {tabs.map((view) => (
          <KeepAliveView
            key={view.viewId}
            view={view}
            active={view.viewId === activeViewId}
          />
        ))}
      </div>
    </div>
  );
});

// ============================================================================
// LayoutSplitRenderer: PanelGroup + 子节点递归 + PanelResizeHandle(§2.1)
// 根 split 与嵌套 split 同一条渲染路径;onLayoutOverride 供根 split 做
// sidebarWidth 回写(§2.3 桥接),嵌套 split 缺省只 updateSizes。
// ============================================================================

const LayoutSplitRenderer = memo(function LayoutSplitRenderer({
  split,
  views,
  animatingFlags,
  transitioningGroups,
  groupPanelRefs,
  onLayoutOverride,
}: {
  split: LayoutSplit;
  views: Record<string, ViewInstance>;
  animatingFlags: ReadonlyMap<string, boolean>;
  transitioningGroups: ReadonlySet<string>;
  groupPanelRefs: React.MutableRefObject<Map<string, ImperativePanelHandle>>;
  onLayoutOverride?: (sizes: number[]) => void;
}): ReactNode {
  const [handleDraggingIdx, setHandleDraggingIdx] = useState<number | null>(null);

  const onLayout = useCallback(
    (sizes: number[]): void => {
      if (onLayoutOverride) {
        onLayoutOverride(sizes);
      } else {
        useLayoutStore.getState().updateSizes(split.id, sizes);
      }
    },
    [split.id, onLayoutOverride],
  );

  // structural key: children 数量/顺序变化时重挂 PanelGroup(§2.1 非受控模式)
  const childrenIds = useMemo(
    () => split.children.map((c) => c.id).join(","),
    [split.children],
  );

  return (
    <PanelGroup
      key={`${split.id}:${childrenIds}`}
      direction={split.direction}
      className="h-full"
      onLayout={onLayout}
    >
      {split.children.map((child, i) => {
        const isGroup = child.kind === "group";
        const groupId = isGroup ? child.id : "";
        const isAnimating = isGroup && animatingFlags.get(child.id) === true;
        const isHiddenGroup = isGroup && (child as LayoutGroup).hidden === true;
        const isTransitioning = isGroup && transitioningGroups.has(child.id);
        const isCollapsible = isGroup && (isHiddenGroup || isAnimating || isTransitioning);

        let minPct = DEF_MIN_PCT;
        let maxPct = 100;
        if (groupId === DEFAULT_GROUP_IDS.LEFT) {
          minPct = (SIDEBAR_MIN_PX / window.innerWidth) * 100;
          maxPct = (SIDEBAR_MAX_PX / window.innerWidth) * 100;
        } else if (groupId === DEFAULT_GROUP_IDS.RIGHT) {
          minPct = RIGHT_MIN_PCT;
          maxPct = 50;
        } else if (!isGroup) {
          minPct = DEF_MIN_PCT;
        } else {
          minPct = MAIN_MIN_PCT;
        }

        return (
          <React.Fragment key={child.id}>
            <Panel
              ref={
                isGroup
                  ? (ref: ImperativePanelHandle | null) => {
                      if (ref) groupPanelRefs.current.set(groupId, ref);
                      else groupPanelRefs.current.delete(groupId);
                    }
                  : undefined
              }
              collapsible={isCollapsible}
              collapsedSize={isCollapsible ? 0 : undefined}
              defaultSize={split.sizes[i]}
              minSize={minPct}
              maxSize={maxPct}
              className={isAnimating ? `min-w-0 ${ANIM_CLASS}` : "min-w-0"}
            >
              {child.kind === "split" ? (
                <LayoutSplitRenderer
                  split={child}
                  views={views}
                  animatingFlags={animatingFlags}
                  transitioningGroups={transitioningGroups}
                  groupPanelRefs={groupPanelRefs}
                />
              ) : (
                <LayoutGroupRenderer group={child} views={views} />
              )}
            </Panel>
            {i < split.children.length - 1 ? (
              <PanelResizeHandle
                key={`h-${split.id}-${i}-${childrenIds}`}
                onDragging={(dragging) => {
                  if (dragging) draggingCount += 1;
                  else draggingCount = Math.max(0, draggingCount - 1);
                  setHandleDraggingIdx(dragging ? i : null);
                }}
                style={{
                  width: split.direction === "horizontal" ? "4px" : undefined,
                  height: split.direction === "vertical" ? "4px" : undefined,
                  cursor: split.direction === "horizontal" ? "col-resize" : "row-resize",
                  background:
                    handleDraggingIdx === i ? "var(--color-primary)" : "transparent",
                  transition: "background 0.15s",
                }}
              />
            ) : null}
          </React.Fragment>
        );
      })}
    </PanelGroup>
  );
});

// ============================================================================
// LayoutEngine: 顶层——pgWidth 测量 + hidden 指令(动画+折叠) + sidebarWidth 桥接
// ============================================================================

export const LayoutEngine = memo(function LayoutEngine(): ReactNode {
  const tree = useLayoutStore((s) => s.tree);
  const views = useLayoutStore((s) => s.views);
  const sidebarWidth = useUiStore((s) => s.sidebarWidth);
  const setSidebarWidth = useUiStore((s) => s.setSidebarWidth);

  // 按 group-id 键控的折叠动画标志(§2.3):每组独立动画,互不干扰
  const [animating, setAnimating] = useState<Map<string, boolean>>(new Map());

  const [prevHiddenState, setPrevHiddenState] = useState<Map<string, boolean> | null>(null);

  const currentHiddenMap = useMemo(() => collectHiddenMap(tree), [tree]);

  const transitioningGroups = useMemo(() => {
    if (prevHiddenState === null) return new Set<string>();
    const result = new Set<string>();
    for (const [id, hidden] of currentHiddenMap) {
      if (prevHiddenState.get(id) !== hidden) result.add(id);
    }
    return result;
  }, [currentHiddenMap, prevHiddenState]);

  const fromRootDragRef = useRef(false);

  const groupPanelRefs = useRef<Map<string, ImperativePanelHandle>>(new Map());

  // pgWidth: PanelGroup 容器实际宽度(px),ResizeObserver 驱动
  const [pgWidth, setPgWidth] = useState<number>(() => window.innerWidth);
  const pgRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = pgRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.contentRect.width > 0) {
          setPgWidth(entry.contentRect.width);
        }
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ==========================================================================
  // hidden 指令(单 effect,§2.3):首帧把 hidden 组 imperative collapse(无动画);
  // 之后 hidden 变化按组挂动画标志 + imperative collapse/expand。
  // 动画标志与折叠指令必须出自同一次 prev→current 比对——拆两个 effect 会让
  // 先跑的 effect 更新 prev,后跑的永远比不出变化(实测:开关只挂动画不折叠)。
  // ==========================================================================

  useEffect(() => {
    const current = currentHiddenMap;
    const prev = prevHiddenState;
    setPrevHiddenState(current);

    // 首帧:refs 刚注册完,把初始 hidden 组静默折叠(无动画)
    if (prev === null) {
      for (const [id, hidden] of current) {
        if (!hidden) continue;
        groupPanelRefs.current.get(id)?.collapse();
      }
      return;
    }

    const changed: string[] = [];
    for (const [id, hidden] of current) {
      if (prev.get(id) !== undefined && prev.get(id) !== hidden) {
        changed.push(id);
      }
    }
    if (changed.length === 0) return;

    const next = new Map<string, boolean>();
    for (const id of changed) next.set(id, true);
    setAnimating(next);
    // 动画时长 220ms + 20ms 余量(与原 ChatView 一致)
    setTimeout(() => setAnimating(new Map()), 240);

    for (const id of changed) {
      const panel = groupPanelRefs.current.get(id);
      if (!panel) continue;
      if (current.get(id) === true) {
        panel.collapse();
      } else {
        panel.expand();
        if (id === DEFAULT_GROUP_IDS.LEFT && pgWidth > 0) {
          panel.resize((useUiStore.getState().sidebarWidth / pgWidth) * 100);
        }
      }
    }
  }, [currentHiddenMap, prevHiddenState, pgWidth]);

  // ==========================================================================
  // sidebarWidth 桥接(§2.3): 订阅 ui-store sidebarWidth → 同步到树左组宽度
  // (设置页拖它自己的左栏时这边跟随;等值守卫防回环)
  // ==========================================================================

  useEffect(() => {
    if (pgWidth <= 0) return;
    if (fromRootDragRef.current) {
      fromRootDragRef.current = false;
      return;
    }
    const leftHidden = currentHiddenMap.get(DEFAULT_GROUP_IDS.LEFT) === true;
    if (leftHidden) return;
    const panel = groupPanelRefs.current.get(DEFAULT_GROUP_IDS.LEFT);
    if (!panel) return;

    const newPct = (sidebarWidth / pgWidth) * 100;
    const state = useLayoutStore.getState();
    if (state.tree.kind === "split" && state.tree.id === "root") {
      const currentPct = state.tree.sizes[0];
      if (Math.abs(currentPct - newPct) > 0.1) {
        panel.resize(newPct);
      }
    }
  }, [sidebarWidth, pgWidth, currentHiddenMap]);

  // ==========================================================================
  // 根 split onLayout:updateSizes + sidebarWidth 回写(§2.3 桥接,等值守卫)
  // ==========================================================================

  const onRootLayout = useCallback(
    (sizes: number[]): void => {
      useLayoutStore.getState().updateSizes("root", sizes);
      if (pgWidth > 0 && sizes.length > 0) {
        const newPx = (sizes[0] / 100) * pgWidth;
        const currentPx = useUiStore.getState().sidebarWidth;
        if (Math.abs(currentPx - newPx) > 1) {
          fromRootDragRef.current = true;
          setSidebarWidth(newPx);
        }
      }
    },
    [pgWidth, setSidebarWidth],
  );

  // ==========================================================================
  // 渲染:根 split 与嵌套 split 同路径(LayoutSplitRenderer),root 只多一个
  // onLayoutOverride 做 sidebarWidth 回写。
  // ==========================================================================

  if (tree.kind !== "split") {
    return <div ref={pgRef} className="h-full flex-1 min-w-0" />;
  }

  return (
    <div ref={pgRef} className="h-full flex-1 min-w-0">
      <LayoutSplitRenderer
        split={tree}
        views={views}
        animatingFlags={animating}
        transitioningGroups={transitioningGroups}
        groupPanelRefs={groupPanelRefs}
        onLayoutOverride={onRootLayout}
      />
    </div>
  );
});
