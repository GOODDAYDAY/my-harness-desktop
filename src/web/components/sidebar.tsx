// 左栏壳 —— sidebar 槽的渲染 chrome + 底部"设置"入口。
//
// 壳只认槽位契约:从 slots:sidebar 读贡献项(按 order 排好序来),
// 分组组件经 @my-harness-desktop/react 注册中心按 component 名查(插件自注册)。
// 对话/项目分组都是插件(sidebar 槽);设置入口是壳的(设置框架是核心)。
//
// 纵向布局:一次 group = 一个 Panel(react-resizable-panels vertical),相邻 group 之间一条
// 可拖拽 PanelResizeHandle —— 改高度比(非整体滚动)。**"两个板块之间能不能上下拉"由
// group 决定**:同 group 的贡献项挤在同一个 Panel 里,只靠 CSS flex 分高度、没有手柄,
// 用户无法调整——这正是历史上"项目区/会话区之间拖不动"的根因(三个 sidebar 贡献项
// 都写了 group:"main",于是整个左栏只有 1 个 Panel、0 条手柄)。
// 组级初值:组内**首个声明 defaultSize 的项**决定该 Panel 的首屏占比(缺省各组均分);
// 用户拖出来的比例由 autoSaveId="sidebar-v" 持久化,二者只在"首次渲染/布局记录失配"时生效。
// Panel 显式带 id=group key:react-resizable-panels 的持久化记录按"组内各 Panel 的 id 拼串"
// 作键,不给 id 时键由约束串推出——约束一变/组数一变旧记录就失配、比例被重置。
// 组内滚动分配:最后一个渲染出实际内容的项 flex-1 吃剩余空间当滚动容器(会话列表),
// 其余项 shrink-0 内容自适应固定(项目列表,不随其它项滑动),超高时 max-h 限一半
// 自己滚——防线:任何插件加进同组都不会再有"某板块内容多了不能滚动"。渲染 null 的
// 项(无运行子 agent 的 SubAgentSection)由 MutationObserver 探测为"无内容",不占
// flex 空间,滚动容器自动移交给前一个有内容的项——滚动能力不随贡献项是否为空漂移。
// 历史:sub-agents 曾把会话列表挤出滚动位(会话多了不能上下滑);空项也踩过同一坑
// (空末项占着"末项"名分把滚动容器藏了,会话被 max-h 限一半,下方留白)——滚动容器
// 按"最后可见项"分配而非数组末项。
// 手柄热区与"线"的视觉解耦(2026-02):热区恒定 8px(display:flex + cursor:row-resize),
// 只有内线显隐走 --sidebar-divider-visual-display。此前两者共用一个 token,card/minimal/
// glass 三种侧栏风格把 display 设成 none 时把手柄热区一起干掉了——组分开也依然拖不动。
// 折叠联动(2026-02):某个 group 整组收起(项渲染 null,或框架 Section 收起)时,该组 Panel
// 塌缩到"折叠头 + 组内留白"的高度,**腾出的高度让给后面的组**——收起项目区,会话区跟上来。
// 这是分组分家后必须补的一环:旧版三居民同处一个 Panel,收起项目区由 flex 自动把空间让给
// 会话列表;分家成两个固定份额的 Panel 后,收起只塌了内容,面板份额不动,原地留一块空白。
// 信号源是框架 Section 的两个声明式锚点(data-section-collapsed / data-section-header),
// 插件私有的折叠态不进壳;只在非末组生效(末组后面没有组能接住空间);只在**变化边沿**动作
// (用户手拖过手柄后不被持续拽回)。见 SidebarItemSlot 的探测与下方折叠联动 effect。
// 复用壳横向三栏(index.tsx)同库,纵向分支零新依赖;handle 拖拽态显 primary 色。
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelHandle } from "react-resizable-panels";
import { useUiStore, getSidebarComponent, PluginIdContext } from "@my-harness-desktop/react";
import { ChatRow } from "../ui/chat-row";

interface SidebarItem {
  id: string;
  component: string;
  pluginId: string;
  group?: string;
  /** 组级首屏高度占比(组内首个声明者生效);见 SidebarContribution.defaultSize。 */
  defaultSize?: number;
}

interface PanelGroup_ {
  key: string;
  items: SidebarItem[];
}

function groupItems(items: SidebarItem[]): PanelGroup_[] {
  const groups: PanelGroup_[] = [];
  const byKey = new Map<string, PanelGroup_>();
  for (const item of items) {
    const key = item.group ?? item.id;
    let g = byKey.get(key);
    if (!g) {
      g = { key, items: [] };
      byKey.set(key, g);
      groups.push(g);
    }
    g.items.push(item);
  }
  return groups;
}

// 单贡献项槽:渲染插件组件 + 探测该滚动容器内有没有实际内容、以及内容自身的高度。
// 探测经 MutationObserver 持续观察:插件内容从 null 变有内容(如子 agent 出现)、
// 或有内容变 null(全部结束),滚动容器的归属随之移交,不依赖父组件恰好重渲染。
// 探测判定 = 容器内是否存在元素子节点,与 CSS :empty 语义一致(渲染 null 即空)。
//
// 第二类信号(2026-02 起):分组**收起**要能把整组腾出的高度让给后面的组。
// - collapsed / headerPx 来自框架 Section 的两个声明式锚点(data-section-collapsed /
//   data-section-header,见 packages/react/src/widgets/section.tsx)——插件私有的折叠态
//   不进壳,壳只认"这一栏现在是收起的"这个事实;
// - attributes 必须进 MutationObserver 的观察面:收起/展开只改 Section 根上的一个属性
//   (子节点不动),只观察 childList 会整条漏掉;
// - 落定值由 transitionend(grid 0fr↔1fr 的折叠动画)精确补一枪,RO 只做兜底
//   (节流:同类变化 <12px 不上报)——避免折叠动画每帧都重渲染整栏。
interface ItemProbe {
  /** 容器里渲染出了实际元素(渲染 null 视为无内容,不占 flex 空间)。 */
  hasContent: boolean;
  /** 框架 Section 处于收起态(内容只剩折叠头)。 */
  collapsed: boolean;
  /** 折叠头高度(px)。0 = 该插件不用 Section(壳不做折叠联动,保持原样)。 */
  headerPx: number;
  /** 组内上下留白(px):塌缩目标高度 = 折叠头 + 留白,不然折叠头会被留白切掉一截。 */
  padY: number;
}

function SidebarItemSlot({
  item,
  isScroll,
  hidden,
  onProbe,
}: {
  item: SidebarItem;
  isScroll: boolean;
  hidden: boolean;
  onProbe: (id: string, probe: ItemProbe) => void;
}): React.ReactNode {
  const { t } = useTranslation();
  const divRef = useRef<HTMLDivElement>(null);
  const cbRef = useRef(onProbe);
  cbRef.current = onProbe;
  const lastRef = useRef<ItemProbe | null>(null);
  const observedInnerRef = useRef<Element | null>(null);

  useLayoutEffect(() => {
    const el = divRef.current;
    if (!el) return;
    const measure = (): ItemProbe => {
      const inner = el.firstElementChild;
      const parent = el.parentElement;
      const cs = parent ? getComputedStyle(parent) : null;
      const padY = cs ? (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0) : 0;
      const header = inner?.querySelector("[data-section-header]");
      return {
        hasContent: inner != null,
        collapsed: (inner as HTMLElement | null)?.dataset.sectionCollapsed === "true",
        headerPx: header ? Math.ceil(header.getBoundingClientRect().height) : 0,
        padY: Math.ceil(padY),
      };
    };
    const emit = (force: boolean): void => {
      const next = measure();
      const prev = lastRef.current;
      if (
        !force && prev
        && prev.hasContent === next.hasContent
        && prev.collapsed === next.collapsed
        && prev.padY === next.padY
        && Math.abs(prev.headerPx - next.headerPx) < 12
      ) return;
      lastRef.current = next;
      cbRef.current(item.id, next);
    };
    // paint 前先按当前内容纠正一次(避免空项首帧占着滚动容器闪一下)
    emit(true);
    const mo = new MutationObserver(() => emit(false));
    mo.observe(el, {
      childList: true,
      subtree: true,
      // 收起/展开只改属性,不观察属性就漏掉折叠(见上方注释)
      attributes: true,
      attributeFilter: ["data-section-collapsed"],
    });
    const ro = new ResizeObserver(() => {
      // 内容元素可能被插件整块换掉(如条件渲染),换掉即重新挂观察,否则新内容的高度没人跟
      const inner = el.firstElementChild;
      if (inner && inner !== observedInnerRef.current) {
        if (observedInnerRef.current) ro.unobserve(observedInnerRef.current);
        observedInnerRef.current = inner;
        ro.observe(inner);
      }
      emit(false);
    });
    ro.observe(el);
    const inner0 = el.firstElementChild;
    if (inner0) {
      observedInnerRef.current = inner0;
      ro.observe(inner0);
    }
    const onTransitionEnd = (e: TransitionEvent): void => {
      if (e.propertyName === "grid-template-rows") emit(true);
    };
    el.addEventListener("transitionend", onTransitionEnd);
    return () => {
      mo.disconnect();
      ro.disconnect();
      el.removeEventListener("transitionend", onTransitionEnd);
    };
    // 观察生命周期随槽位挂载,不随父重渲染重建;回调走 ref 拿最新闭包
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const Comp = getSidebarComponent(item.component);
  return (
    <div
      ref={divRef}
      // 滚动容器 = 最后一个有内容的项(flex-1 吃剩余空间);其余项 shrink-0 固定,
      // 超高限一半自己滚(防线)。空项(渲染 null)hidden 不占 flex 空间,
      // 滚动容器由前一个有内容的项接管——滚动能力不随贡献项是否为空漂移。
      className={`${hidden ? "hidden " : ""}${
        isScroll ? "flex-1 min-h-0 overflow-y-auto" : "shrink-0 max-h-[50%] overflow-y-auto"
      }`}
    >
      {Comp ? (
        <PluginIdContext.Provider value={item.pluginId}>
          <Comp />
        </PluginIdContext.Provider>
      ) : (
        <div className="px-2 py-1 text-[length:var(--font-size-sm)] text-[var(--color-muted)]">
          {t("shell.componentNotRegistered", { component: item.component, plugin: item.pluginId })}
        </div>
      )}
    </div>
  );
}

/** 面板最小高度(百分比),与 Panel 的 minSize 同源。 */
const PANEL_MIN_SIZE = 10;

/** 折叠态下该组面板应占的高度比(百分比)= (折叠头 + 组内留白) / 容器高度。
 *  夹在 [1, minSize-1]:必须**小于 minSize**,库才把"拖到低于中点"判成塌缩;
 *  不能为 0,否则折叠头一起没了,那一组再没有展开入口(只能靠邻居手柄,体验差)。
 *  容器高度未测量(0)时返回 0,调用方不据此动作。 */
export function collapsedSizePercent(headerPx: number, padY: number, boxPx: number, minSize: number): number {
  if (boxPx <= 0 || headerPx <= 0) return 0;
  const pct = ((headerPx + padY) / boxPx) * 100;
  return Math.max(1, Math.min(minSize - 1, Math.round(pct * 10) / 10));
}

export function Sidebar(): React.ReactNode {
  const { t } = useTranslation();
  const setActiveView = useUiStore((s) => s.setActiveView);
  const sidebarStyle = useUiStore((s) => s.sidebarStyle);
  // pluginsNonce 进 effect 依赖:插件启用/禁用/安装后重拉 sidebar 槽贡献
  // (与 titlebar 同一模式;只订阅重渲染不够,items 是 useEffect 拉的快照)
  const pluginsNonce = useUiStore((s) => s.pluginsNonce);
  const [items, setItems] = useState<SidebarItem[]>([]);
  const [handleDragging, setHandleDragging] = useState(false);
  // 组内各项的探测表:item.id -> {有无内容 / 是否收起 / 折叠头高度 / 组内留白}。
  // 初始为空对象 = 全项默认有内容(未探测前按数组末项分配,与旧行为一致,不闪烁)。
  const [probes, setProbes] = useState<Record<string, ItemProbe>>({});
  // PanelGroup 容器高度(px):折叠塌缩目标高度要按百分比给库,这里做分母。
  const [boxPx, setBoxPx] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  // 各组 Panel 的命令式句柄(只有"可塌缩的非末组"登记)。
  const panelRefs = useRef(new Map<string, ImperativePanelHandle | null>());
  // 各组上一次的"收起"态:折叠联动按**变化边沿**动作,不做持续覆盖——用户手拖过手柄之后
  // 不该被一个还在收起的 Section 反复拽回去。
  const prevCollapsedRef = useRef(new Map<string, boolean>());

  useEffect(() => {
    void window.kernel.slots.sidebar().then(setItems);
  }, [pluginsNonce]);

  // 探测回写:状态未变时返回原对象,React bail out,不触发多余重渲染
  const onProbe = useCallback((id: string, p: ItemProbe): void => {
    setProbes((prev) => {
      const cur = prev[id];
      if (
        cur && cur.hasContent === p.hasContent && cur.collapsed === p.collapsed
        && cur.headerPx === p.headerPx && cur.padY === p.padY
      ) return prev;
      return { ...prev, [id]: p };
    });
  }, []);

  // 容器高度:只在窗口/布局真的变化时更新(百分比分母)
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const sync = (): void => setBoxPx((prev) => {
      const next = Math.round(el.getBoundingClientRect().height);
      return prev === next ? prev : next;
    });
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const panelGroups = groupItems(items);

  // 每组:整组是否收起 + 折叠头/留白高度(用于算塌缩目标百分比)
  const groupStates = panelGroups.map((pg) => {
    const known = pg.items.map((it) => probes[it.id]).filter((p): p is ItemProbe => p != null);
    return {
      key: pg.key,
      collapsed: known.length > 0 && known.every((p) => !p.hasContent || p.collapsed),
      headerPx: known.reduce((max, p) => Math.max(max, p.headerPx), 0),
      padY: known.reduce((max, p) => Math.max(max, p.padY), 0),
    };
  });

  // 折叠联动:整组收起 → 该组面板塌缩到折叠头高度,腾出的高度交给后面的组(收起项目区,
  // 会话区跟上来);展开 → expand() 恢复折叠前比例(库的 expandToSizes 语义)。
  //   · 只在**非末组**生效:末组后面没有组能接住腾出的空间,塌了只是把留白换个地方;
  //   · boxPx 未测到(容器隐藏/首帧)时不动——量不出百分比就没有正确的塌缩目标,
  //     等测到再说(顺带让 jsdom 这类无排版环境不会去调库的塌缩 API);
  //   · 首帧按当前态对齐一次(插件配置里存着"上次是收起的"),此后只在翻转时动。
  useEffect(() => {
    if (boxPx <= 0) return;
    groupStates.forEach((gs, gi) => {
      if (gi === groupStates.length - 1) return;
      const panel = panelRefs.current.get(gs.key);
      if (!panel) return;
      const prev = prevCollapsedRef.current.get(gs.key);
      if (prev === gs.collapsed) return;
      prevCollapsedRef.current.set(gs.key, gs.collapsed);
      if (gs.collapsed) panel.collapse();
      else panel.expand();
    });
  }, [groupStates, boxPx]);

  return (
    <div
      data-sidebar-style={sidebarStyle}
      className="flex flex-col h-full w-full border-r border-[var(--color-border)]"
      style={{
        background: "var(--color-chrome)",
        "--font-size-xs": "calc(var(--font-size-xs-raw) * var(--sidebar-font-scale, 1))",
        "--font-size-sm": "calc(var(--font-size-sm-raw) * var(--sidebar-font-scale, 1))",
        "--font-size-base": "calc(var(--font-size-base-raw) * var(--sidebar-font-scale, 1))",
        "--font-size-lg": "calc(var(--font-size-lg-raw) * var(--sidebar-font-scale, 1))",
        "--sidebar-section-fs": "calc(var(--font-size-sm-raw) * var(--sidebar-font-scale, 1))",
      } as React.CSSProperties}
    >
      <div ref={boxRef} className="flex-1 min-h-0">
        <PanelGroup direction="vertical" className="h-full" autoSaveId="sidebar-v">
          {panelGroups.map((pg, gi) => {
            const isLast = gi === panelGroups.length - 1;
            const gs = groupStates[gi];
            // 可塌缩 = 非末组 且 量到了折叠头高度(用 Section 的组才有折叠头;自定义根组不做联动,
            // 免得"拖到塌缩"把整组收成 1% 且没有可点的展开入口)
            const canCollapse = !isLast && gs.headerPx > 0 && boxPx > 0;
            // 滚动容器 = 最后一个有内容的项;空项(渲染 null)不参与,滚动能力移交
            const lastVisibleIndex = pg.items.reduce(
              (acc, item, ii) => (probes[item.id]?.hasContent === false ? acc : ii),
              -1
            );
            return (
              <Fragment key={pg.key}>
                <Panel
                  // id 进持久化键:不给 id 时库用"约束串"当 id,约束/组数一变旧比例就失配被重置
                  id={pg.key}
                  minSize={PANEL_MIN_SIZE}
                  // 组级初值只认组内首个声明者(item 已按 order 排好序)
                  defaultSize={pg.items[0]?.defaultSize}
                  // 收起态下塌到"折叠头 + 组内留白"的高度(见上方折叠联动注释)
                  collapsible={canCollapse}
                  collapsedSize={canCollapse ? collapsedSizePercent(gs.headerPx, gs.padY, boxPx, PANEL_MIN_SIZE) : undefined}
                  ref={canCollapse ? (h: ImperativePanelHandle | null) => {
                    if (h) panelRefs.current.set(pg.key, h);
                    else panelRefs.current.delete(pg.key);
                  } : undefined}
                  className="min-h-0"
                >
                  <div className="h-full flex flex-col px-2.5 pt-3 pb-2">
                    {pg.items.map((item, ii) => {
                      const hasContent = probes[item.id]?.hasContent !== false; // 默认有内容
                      return (
                        <SidebarItemSlot
                          key={item.id}
                          item={item}
                          isScroll={hasContent && ii === lastVisibleIndex}
                          hidden={!hasContent}
                          onProbe={onProbe}
                        />
                      );
                    })}
                  </div>
                </Panel>
                {!isLast && (
                  <PanelResizeHandle
                    onDragging={setHandleDragging}
                    // 可访问名与朝向要自己给（库只给 role=separator / aria-valuenow / tabIndex）。
                    // 左栏是**上下**堆叠的板块，手柄水平横置、垂直移动 ⇒ row-resize ⇒ orientation=horizontal
                    // （这一处与 ARIA 默认值一致，但仍显式写出：默认值不是契约，库改版就可能变）。
                    aria-label={t("shell.resizeSidebarSections")}
                    aria-orientation="horizontal"
                    // 热区恒在(display:"flex"):风格差异只作用在内线,不再像旧版那样
                    // 用同一个 token 把热区一起 display:none —— 那会让"隐藏分割线"的
                    // card/minimal/glass 三种风格彻底拖不动(有手柄但点不到)。
                    style={{
                      height: "8px",
                      cursor: "row-resize",
                      background: "transparent",
                      display: "flex",
                      alignItems: "center",
                      transition: "background 0.15s",
                    }}
                  >
                    <div
                      style={{
                        width: "100%",
                        height: "var(--divider-width)",
                        margin: "0 var(--divider-inset)",
                        background: handleDragging
                          ? "var(--color-primary)"
                          : "var(--divider-color)",
                        borderRadius: "var(--radius-sm)",
                        transition: "background 0.15s",
                        // 线可隐藏,但拖拽中一律显形——否则"无分隔线"的风格拖起来没有反馈
                        display: handleDragging
                          ? "flex"
                          : "var(--sidebar-divider-visual-display)",
                      }}
                    />
                  </PanelResizeHandle>
                )}
              </Fragment>
            );
          })}
        </PanelGroup>
      </div>

      <div className="border-t border-[var(--color-border)] shrink-0 px-2 py-2">
        {/* `data-sidebar-entry` 是稳定锚点：e2e 与 DOM 审计据此定位，**不按译文文案匹配**。
            实测教训：审计剧本曾按 /^(设置|Settings)$/ 找入口，换成 zh-TW 就失效——
            繁中的 `shell.settings` 是「設定」（正确的台式术语），不是「設置」。
            按文案匹配等于把测试绑死在某一种语言上，每加一个 locale 就可能红一次。 */}
        <ChatRow data-sidebar-entry="settings" onClick={() => setActiveView("settings")} icon={<Settings className="size-4.5" />}>
          {t("shell.settings")}
        </ChatRow>
      </div>
    </div>
  );
}
