// 布局引擎运行时状态 —— 布局树 + 视图注册表(zustand)。
//
// 页面是一棵布局树(递归 split/group),叶为视图组,组内是视图栈。
// 树里放 viewId,注册表放 ViewInstance——结构/内容分离(§1.2)。
//
// 持久化(§4.2):每变更后 300ms debounced persist 树骨架到 general-config.json 的 layout 键。
// 只存结构/sizes/hidden + shell:*/slot:* 种子视图;动态视图不落盘,重启后从默认树重建。
// 事件(§3.3):任何变更后 emitSystem("system:layoutChanged", {})——空 payload 纯信号。
//
// 设计文档: docs/design/dynamic-layout.md §4.1, §4.2, §4.3, §3.1–§3.3。
import { create } from "zustand";
import { readGeneralConfig, writeGeneralConfig } from "./general-config";
import { eventBus } from "@pi-desktop/react";
import {
  ROOT_SPLIT_ID,
  DEFAULT_GROUP_IDS,
  SHELL_VIEW_PREFIX,
  SLOT_VIEW_PREFIX,
  type LayoutNode,
  type LayoutGroup,
  type LayoutSplit,
  type ViewInstance,
  type OpenViewRequest,
  validateLayoutTree,
  buildDefaultTree,
  rehydrateLayout,
  findGroup,
  collectGroupIds,
  splitGroup,
  removeViewFromTree,
  insertViewIntoGroup,
} from "@/core/domain/layout";

// ============================================================================
// 内部工具:树遍历辅助(不可变)
// ============================================================================

/** 在树中按 id 查找 group 并应用 fn,返回新树。未找到则返回原树。 */
function updateGroup(
  tree: LayoutNode,
  groupId: string,
  fn: (g: LayoutGroup) => LayoutGroup,
): LayoutNode {
  if (tree.kind === "group") {
    return tree.id === groupId ? fn(tree) : tree;
  }
  const newChildren = tree.children.map((c) => updateGroup(c, groupId, fn));
  if (newChildren.every((c, i) => c === tree.children[i])) return tree;
  return { ...tree, children: newChildren };
}

/** 在树中查找包含指定 viewId 的 group。未找到返回 null。 */
function findGroupContaining(tree: LayoutNode, viewId: string): LayoutGroup | null {
  if (tree.kind === "group") {
    return tree.viewIds.includes(viewId) ? tree : null;
  }
  for (const child of tree.children) {
    const found = findGroupContaining(child, viewId);
    if (found) return found;
  }
  return null;
}

/** 递归更新 split 节点的 sizes。未找到返回原树。 */
function updateSplitSizes(
  tree: LayoutNode,
  splitId: string,
  sizes: number[],
): LayoutNode {
  if (tree.kind !== "split") return tree;
  if (tree.id === splitId) return { ...tree, sizes };
  const newChildren = tree.children.map((c) => updateSplitSizes(c, splitId, sizes));
  if (newChildren.every((c, i) => c === tree.children[i])) return tree;
  return { ...tree, children: newChildren };
}

/** 收集树中所有 viewId(递归遍历 groups)。 */
function collectViewIds(tree: LayoutNode): string[] {
  const ids: string[] = [];
  const walk = (node: LayoutNode): void => {
    if (node.kind === "group") {
      for (const v of node.viewIds) ids.push(v);
    } else {
      for (const child of node.children) walk(child);
    }
  };
  walk(tree);
  return ids;
}

// 深拷贝树,但 group 中只保留 shell:/slot: 前缀的 viewIds(持久化骨架,§4.2)。
function stripDynamicViews(node: LayoutNode): LayoutNode {
  if (node.kind === "group") {
    const persisted = node.viewIds.filter(
      (v) => v.startsWith(SHELL_VIEW_PREFIX) || v.startsWith(SLOT_VIEW_PREFIX),
    );
    if (persisted.length === node.viewIds.length) return node;
    return {
      ...node,
      viewIds: persisted,
      activeViewId:
        node.activeViewId !== null && persisted.includes(node.activeViewId)
          ? node.activeViewId
          : persisted.length > 0
            ? persisted[0]
            : null,
    };
  }
  const newChildren = node.children.map((c) => stripDynamicViews(c));
  if (newChildren.every((c, i) => c === node.children[i])) return node;
  return { ...node, children: newChildren };
}

// ============================================================================
// ID 生成
// ============================================================================

let nextGroupIdCounter = 0;

function generateGroupId(): string {
  const id = `group-${nextGroupIdCounter}`;
  nextGroupIdCounter += 1;
  return id;
}

// ============================================================================
// 持久化(§4.2)
// ============================================================================

let persistTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePersist(tree: LayoutNode): void {
  if (persistTimer !== null) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const skeleton = stripDynamicViews(tree);
    void writeGeneralConfig({ layout: skeleton });
  }, 300);
}

// ============================================================================
// 视图注册/注销 helper
// ============================================================================

// 判定 viewId 是否为框架种子视图(shell:/slot: 前缀)。
function isSeedView(viewId: string): boolean {
  return viewId.startsWith(SHELL_VIEW_PREFIX) || viewId.startsWith(SLOT_VIEW_PREFIX);
}

// ============================================================================
// Store 类型
// ============================================================================

export interface LayoutState {
  /** 当前布局树(§1.1)。 */
  tree: LayoutNode;
  /** 视图注册表(§1.2):viewId → ViewInstance。 */
  views: Record<string, ViewInstance>;
  /** 是否已从持久化存档重建完(初始 false)。 */
  hydrated: boolean;

  // 公开 actions(§3.1+§3.2)
  openView: (pluginId: string, req: OpenViewRequest) => void;
  closeView: (viewId: string) => void;
  activateView: (viewId: string) => void;
  moveView: (viewId: string, targetGroupId: string, index?: number) => void;
  setGroupHidden: (groupId: string, hidden: boolean) => void;
  updateSizes: (splitId: string, sizes: number[]) => void;
  setLayout: (tree: LayoutNode) => void;
  getLayout: () => LayoutNode;

  // 内部 actions(§4.1)
  registerShellViews: () => void;
  syncMainViewSlot: () => void;
  sweepStaleViews: (loadedPluginIds: Set<string>) => void;

  // 启动
  hydrate: () => Promise<void>;
}

// ============================================================================
// 默认种子视图
// ============================================================================

function createShellSidebarView(): ViewInstance {
  return {
    viewId: `${SHELL_VIEW_PREFIX}sidebar`,
    pluginId: "shell",
    component: "Sidebar",
    title: "Sidebar",
    closable: false,
  };
}

function createShellSidePanelView(): ViewInstance {
  return {
    viewId: `${SHELL_VIEW_PREFIX}sidePanel`,
    pluginId: "shell",
    component: "RightPanelContent",
    title: "Side Panel",
    closable: false,
  };
}

function createMainViewSlotView(
  pluginId: string,
  component: string,
): ViewInstance {
  return {
    viewId: `${SLOT_VIEW_PREFIX}mainView`,
    pluginId,
    component,
    title: "Main View",
    closable: false,
    themeScope: "timeline",
  };
}

// ============================================================================
// Store 定义
// ============================================================================

export const useLayoutStore = create<LayoutState>((set, get) => {
  // 初始默认树(无种子视图——registerShellViews + syncMainViewSlot 后补齐)。
  const defaultTree = buildDefaultTree({
    leftHidden: false,
    rightHidden: false,
    leftSize: 20,
    rightSize: 26,
  });

  const emitAndPersist = (): void => {
    eventBus.emitSystem("system:layoutChanged", {});
    schedulePersist(get().tree);
  };

  return {
    tree: defaultTree,
    views: {},
    hydrated: false,

    // -----------------------------------------------------------------------
    // openView(§3.1):幂等打开视图
    // -----------------------------------------------------------------------
    openView: (pluginId: string, req: OpenViewRequest): void => {
      const state = get();
      const existing = state.views[req.viewId];

      if (existing) {
        // 已存在:激活 + 可选更新 title/props
        const updates: Partial<ViewInstance> = {};
        if (req.title !== undefined) updates.title = req.title;
        if (req.props !== undefined) updates.props = req.props;
        if (Object.keys(updates).length > 0) {
          set({
            views: {
              ...state.views,
              [req.viewId]: { ...existing, ...updates },
            },
          });
        }
        // 激活
        const group = findGroupContaining(state.tree, req.viewId);
        if (group) {
          set({
            tree: updateGroup(state.tree, group.id, (g) => ({
              ...g,
              activeViewId: req.viewId,
            })),
          });
        }
        emitAndPersist();
        return;
      }

      // 新视图:注册 + 插入树
      const view: ViewInstance = {
        viewId: req.viewId,
        pluginId,
        component: req.component,
        title: req.title,
        icon: req.icon,
        props: req.props,
        closable: req.closable ?? true,
      };

      let newTree = state.tree;
      const target = req.target;

      if (target && "split" in target) {
        // 分屏 target:在 of 组旁边切出新组
        const newGroupId = generateGroupId();
        newTree = splitGroup(
          newTree,
          target.split.of,
          target.split.direction,
          newGroupId,
          target.split.ratio ?? 0.5,
        );
        newTree = insertViewIntoGroup(newTree, newGroupId, req.viewId);
        newTree = updateGroup(newTree, newGroupId, (g) => ({
          ...g,
          activeViewId: req.viewId,
        }));
      } else {
        const groupId = target && "group" in target ? target.group : DEFAULT_GROUP_IDS.MAIN;
        newTree = insertViewIntoGroup(newTree, groupId, req.viewId);
        newTree = updateGroup(newTree, groupId, (g) => ({
          ...g,
          activeViewId: req.viewId,
        }));
      }

      set({
        tree: newTree,
        views: { ...state.views, [req.viewId]: view },
      });
      emitAndPersist();
    },

    // -----------------------------------------------------------------------
    // closeView(§3.1):关闭视图,不可关闭则抛错
    // -----------------------------------------------------------------------
    closeView: (viewId: string): void => {
      const state = get();
      const view = state.views[viewId];
      if (!view) return;
      if (!view.closable) {
        throw new Error(`视图 "${viewId}" 不允许关闭(closable=false)`);
      }

      const newViews = { ...state.views };
      delete newViews[viewId];

      const newTree = removeViewFromTree(state.tree, viewId);

      set({ tree: newTree, views: newViews });
      emitAndPersist();
    },

    // -----------------------------------------------------------------------
    // activateView(§3.1):激活视图(切 tab)
    // -----------------------------------------------------------------------
    activateView: (viewId: string): void => {
      const state = get();
      if (!state.views[viewId]) return;

      const group = findGroupContaining(state.tree, viewId);
      if (!group) return;

      set({
        tree: updateGroup(state.tree, group.id, (g) => ({
          ...g,
          activeViewId: viewId,
        })),
      });
      emitAndPersist();
    },

    // -----------------------------------------------------------------------
    // moveView(§3.2):跨组移动视图
    // -----------------------------------------------------------------------
    moveView: (viewId: string, targetGroupId: string, index?: number): void => {
      const state = get();
      if (!state.views[viewId]) return;

      const sourceGroup = findGroupContaining(state.tree, viewId);
      if (!sourceGroup) return;

      // 从源组移除
      let newTree = updateGroup(state.tree, sourceGroup.id, (g) => {
        const newViewIds = g.viewIds.filter((v) => v !== viewId);
        if (newViewIds.length === g.viewIds.length) return g;
        let newActive = g.activeViewId;
        if (g.activeViewId === viewId) {
          newActive = newViewIds.length > 0 ? newViewIds[0] : null;
        }
        return { ...g, viewIds: newViewIds, activeViewId: newActive };
      });

      // 插入目标组
      newTree = insertViewIntoGroup(newTree, targetGroupId, viewId, index);

      set({ tree: newTree });
      emitAndPersist();
    },

    // -----------------------------------------------------------------------
    // setGroupHidden(§2.3):折叠/展开组,组不存在则 no-op
    // -----------------------------------------------------------------------
    setGroupHidden: (groupId: string, hidden: boolean): void => {
      const state = get();
      if (!findGroup(state.tree, groupId)) return;

      set({
        tree: updateGroup(state.tree, groupId, (g) => ({ ...g, hidden })),
      });
      emitAndPersist();
    },

    // -----------------------------------------------------------------------
    // updateSizes(§2.1):更新 split 节点的尺寸
    // -----------------------------------------------------------------------
    updateSizes: (splitId: string, sizes: number[]): void => {
      set({ tree: updateSplitSizes(get().tree, splitId, sizes) });
      emitAndPersist();
    },

    // -----------------------------------------------------------------------
    // setLayout(§3.2):整体替换布局树,清 orphan 视图
    // -----------------------------------------------------------------------
    setLayout: (tree: LayoutNode): void => {
      const state = get();

      // 校验(O(n)形态检查 + viewId 注册检查)
      const validated = validateLayoutTree(tree, state.views);

      // 根必须是 id 为 "root" 的 split
      if (validated.id !== ROOT_SPLIT_ID) {
        throw new Error(`setLayout 的树根必须 id 为 "${ROOT_SPLIT_ID}",收到 "${validated.id}"`);
      }
      if (validated.kind !== "split" || validated.children.length < 2) {
        throw new Error("setLayout 的树根必须是至少有 2 个孩子的 split");
      }

      // 清理 orphan 视图(§3.2):注册表中不再被新树引用的视图按 closeView 语义卸载
      const newViewIds = new Set(collectViewIds(validated));
      const newViews = { ...state.views };
      for (const vid of Object.keys(newViews)) {
        if (!newViewIds.has(vid)) {
          delete newViews[vid];
        }
      }

      set({ tree: validated, views: newViews });
      emitAndPersist();
    },

    // -----------------------------------------------------------------------
    // getLayout(§3.2):读当前树
    // -----------------------------------------------------------------------
    getLayout: (): LayoutNode => {
      return get().tree;
    },

    // -----------------------------------------------------------------------
    // registerShellViews(§4.1):注册 shell:sidebar 和 shell:sidePanel
    // -----------------------------------------------------------------------
    registerShellViews: (): void => {
      const state = get();

      const sidebarVid = `${SHELL_VIEW_PREFIX}sidebar`;
      const sidePanelVid = `${SHELL_VIEW_PREFIX}sidePanel`;

      // 幂等:已注册则跳过
      if (state.views[sidebarVid] && state.views[sidePanelVid]) return;

      const additions: Record<string, ViewInstance> = {};
      if (!state.views[sidebarVid]) {
        additions[sidebarVid] = createShellSidebarView();
      }
      if (!state.views[sidePanelVid]) {
        additions[sidePanelVid] = createShellSidePanelView();
      }

      if (Object.keys(additions).length === 0) return;

      set({ views: { ...state.views, ...additions } });
    },

    // -----------------------------------------------------------------------
    // syncMainViewSlot(§4.1):重查 mainView 槽,注册/更新 slot:mainView
    // -----------------------------------------------------------------------
    syncMainViewSlot: (): void => {
      const state = get();
      const mainVid = `${SLOT_VIEW_PREFIX}mainView`;

      // 查询 mainView 槽(安全调用:window.pi 可能未就绪)
      let items: { id: string; component: string; pluginId: string }[] = [];
      try {
        // syncMainViewSlot 可能在 preload 未就绪时调用(启动阶段),吞错返回空
        if (typeof window.pi?.slots?.mainView === "function") {
          void window.pi.slots.mainView().then((result) => {
            // 异步结果回来后再真正执行
            applyMainViewSlot(get(), mainVid, result);
          });
          return; // 异步路径,先返回
        }
      } catch {
        // window.pi 未就绪,稍后 hydrate 再调
      }

      // 同步路径:window.pi 不可用→移除 slot:mainView(如果存在)
      applyMainViewSlot(state, mainVid, items);
    },

    // -----------------------------------------------------------------------
    // sweepStaleViews(§4.3):清扫插件已卸载的动态视图
    // -----------------------------------------------------------------------
    sweepStaleViews: (loadedPluginIds: Set<string>): void => {
      const state = get();
      const toRemove: string[] = [];

      for (const vid of Object.keys(state.views)) {
        // 只清扫动态视图(非 shell:*/slot:* 前缀)
        if (isSeedView(vid)) continue;

        const view = state.views[vid];
        // 组件来源不在已加载插件集合中→标记删除
        if (!loadedPluginIds.has(view.pluginId) && view.pluginId !== "shell") {
          toRemove.push(vid);
        }
      }

      if (toRemove.length === 0) return;

      const newViews = { ...state.views };
      let newTree = state.tree;

      for (const vid of toRemove) {
        delete newViews[vid];
        newTree = removeViewFromTree(newTree, vid);
      }

      set({ tree: newTree, views: newViews });
      emitAndPersist();
    },

    // -----------------------------------------------------------------------
    // hydrate(§4.2):从持久化存档 + legacy prefs 重建树和视图
    // -----------------------------------------------------------------------
    hydrate: async (): Promise<void> => {
      const state = get();

      // ① 注册 shell 种子视图(rehydrate 校验依赖它们)
      state.registerShellViews();

      // ② 读 general-config + legacy prefs + mainView 槽(并行)
      let generalConfig: Record<string, unknown> = {};
      let sidebarWidthPx = 260;
      let rightPanelOpen = false;
      let sidebarDefaultOpen = false;
      let mainViewWinner: { id: string; component: string; pluginId: string } | undefined;

      try {
        const [configResult, sw, rpo, mv] = await Promise.all([
          readGeneralConfig(),
          window.pi.prefs.get<number>("sidebarWidth"),
          window.pi.prefs.get<boolean>("rightPanelOpen"),
          window.pi.slots.mainView(),
        ]);

        generalConfig = configResult;
        sidebarWidthPx = typeof sw === "number" ? sw : 260;
        rightPanelOpen = rpo === true;
        if (generalConfig["sidebarDefaultOpen"] === true) {
          sidebarDefaultOpen = true;
        }
        mainViewWinner = mv[0];
      } catch {
        // prefs/configFile 不可用,用默认值
      }

      // ②.5 预注册 slot:mainView 到注册表(不碰树——树在 ④ 由存档/默认构建给出)。
      // 存档 main 组引用 slot:mainView,校验器要求 viewIds 全有注册——
      // 注册表必须先于 ④ 的校验就绪,否则合法存档被误判损坏、永远回退默认树。
      if (mainViewWinner) {
        const mainVid = `${SLOT_VIEW_PREFIX}mainView`;
        set({
          views: {
            ...get().views,
            [mainVid]: createMainViewSlotView(mainViewWinner.pluginId, mainViewWinner.component),
          },
        });
      }

      // ③ 推导尺寸:sidebarWidth px → 百分比
      const windowWidth = window.innerWidth || 1440;
      const leftSizePercent = Math.max(
        12,
        Math.min(35, (sidebarWidthPx / windowWidth) * 100),
      );
      const rightSizePercent = 26;

      // ④ rehydrate 或 fallback
      let tree: LayoutNode;

      if (generalConfig["layout"] !== undefined) {
        const raw = generalConfig["layout"];
        const currentViews = get().views; // shell views registered above
        const result = rehydrateLayout(raw, currentViews);
        if (result !== null) {
          tree = result;
        } else {
          // 存档损坏→回退默认树
          tree = buildDefaultTree({
            leftHidden: !sidebarDefaultOpen,
            rightHidden: !rightPanelOpen,
            leftSize: leftSizePercent,
            rightSize: rightSizePercent,
          });
        }
      } else {
        tree = buildDefaultTree({
          leftHidden: !sidebarDefaultOpen,
          rightHidden: !rightPanelOpen,
          leftSize: leftSizePercent,
          rightSize: rightSizePercent,
        });
      }

      set({ tree, hydrated: true });

      // ⑤ 同步 mainView 槽(异步安全,可重复调用)
      get().syncMainViewSlot();
    },
  };
});

// ============================================================================
// syncMainViewSlot 的实际执行体(异步安全)
// ============================================================================

function applyMainViewSlot(
  prevState: { views: Record<string, ViewInstance>; tree: LayoutNode },
  mainVid: string,
  items: { id: string; component: string; pluginId: string }[],
): void {
  const store = useLayoutStore.getState();

  if (items.length > 0 && items[0]) {
    const winner = items[0];
    const existing = store.views[mainVid];

    const newView = createMainViewSlotView(winner.pluginId, winner.component);

    if (existing) {
      // 更新已有 slot:mainView(pluginId/component 可能变化)
      if (
        existing.pluginId !== newView.pluginId ||
        existing.component !== newView.component
      ) {
        useLayoutStore.setState({
          views: { ...store.views, [mainVid]: newView },
        });
        eventBus.emitSystem("system:layoutChanged", {});
      }
    } else {
      // 新注册 slot:mainView + 插入 main 组
      let newTree = store.tree;

      // 确保 main 组存在
      if (!findGroup(newTree, DEFAULT_GROUP_IDS.MAIN)) {
        // main 组不存在(异常情况),不做插入
        useLayoutStore.setState({
          views: { ...store.views, [mainVid]: newView },
        });
        eventBus.emitSystem("system:layoutChanged", {});
        return;
      }

      // 插入 main 组(viewIds 中尚未有 mainVid)
      const mainGroup = findGroup(newTree, DEFAULT_GROUP_IDS.MAIN)!;
      if (!mainGroup.viewIds.includes(mainVid)) {
        newTree = insertViewIntoGroup(newTree, DEFAULT_GROUP_IDS.MAIN, mainVid, 0);

        // 若 main 组暂无 active,设为 slot:mainView
        if (mainGroup.activeViewId === null) {
          newTree = updateGroup(newTree, DEFAULT_GROUP_IDS.MAIN, (g) => ({
            ...g,
            activeViewId: mainVid,
          }));
        }
      }

      useLayoutStore.setState({
        tree: newTree,
        views: { ...store.views, [mainVid]: newView },
      });
      eventBus.emitSystem("system:layoutChanged", {});
      schedulePersist(newTree);
    }
  } else {
    // 无槽贡献:移除 slot:mainView(如果存在)
    if (store.views[mainVid]) {
      const newViews = { ...store.views };
      delete newViews[mainVid];

      const newTree = removeViewFromTree(store.tree, mainVid);

      useLayoutStore.setState({ tree: newTree, views: newViews });
      eventBus.emitSystem("system:layoutChanged", {});
      schedulePersist(newTree);
    }
  }
}

// ============================================================================
// 读端 selector(§2.3 显隐的唯一查询入口,消费方不各自遍历树)
// ============================================================================

/** 订阅某组的 hidden 状态(组不存在或为 split 顶层时视为 false)。 */
export function useGroupHidden(groupId: string): boolean {
  return useLayoutStore((s) => findGroup(s.tree, groupId)?.hidden === true);
}
