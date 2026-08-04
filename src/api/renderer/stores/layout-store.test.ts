// syncMainViewSlot 单元测试 —— 针对「mainView 槽无贡献」根因修复。
//
// 故障链:历史某次空 items 同步把 slot:mainView 从树里移除并 persist 空骨架
// → 下次启动 rehydrate 恢复空 main 组、注册表却有 slot:mainView(hydrate 预注册)
// → applyMainViewSlot existing 分支只比对 winner 不修树 → 中区永久"无贡献"。
// 修复:existing 分支补树一致性自愈;window.pi 未就绪/IPC 失败不再喂空数组
// 进破坏分支("不知道"不等于"没有")。
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  buildDefaultTree,
  removeViewFromTree,
  findGroup,
  DEFAULT_GROUP_IDS,
  SLOT_VIEW_PREFIX,
  type ViewInstance,
} from "@/core/domain/layout";

vi.mock("./general-config", () => ({
  readGeneralConfig: vi.fn(async () => ({})),
  writeGeneralConfig: vi.fn(async () => {}),
}));

import { useLayoutStore } from "./layout-store";

const MAIN_VID = `${SLOT_VIEW_PREFIX}mainView`;

function slotView(pluginId = "timeline", component = "TimelineView"): ViewInstance {
  return { viewId: MAIN_VID, pluginId, component, title: "Main View", closable: false };
}

function shellView(viewId: string, component: string): ViewInstance {
  return { viewId, pluginId: "shell", component, title: viewId, closable: false };
}

function defaultViews(slot: ViewInstance | null = slotView()): Record<string, ViewInstance> {
  const views: Record<string, ViewInstance> = {
    "shell:sidebar": shellView("shell:sidebar", "Sidebar"),
    "shell:sidePanel": shellView("shell:sidePanel", "RightPanelContent"),
  };
  if (slot) views[MAIN_VID] = slot;
  return views;
}

function mainGroup() {
  const g = findGroup(useLayoutStore.getState().tree, DEFAULT_GROUP_IDS.MAIN);
  if (!g) throw new Error("main 组不存在");
  return g;
}

/** 好状态:默认树(含 slot:mainView) + 全部种子视图注册。 */
function seedGoodState(): void {
  useLayoutStore.setState({
    tree: buildDefaultTree({ leftHidden: false, rightHidden: false, leftSize: 20, rightSize: 26 }),
    views: defaultViews(),
  });
}

/** 固化现场:注册表有 slot:mainView,树 main 组空(历史空骨架被 persist)。 */
function seedBrokenState(): void {
  const good = buildDefaultTree({ leftHidden: false, rightHidden: false, leftSize: 20, rightSize: 26 });
  useLayoutStore.setState({
    tree: removeViewFromTree(good, MAIN_VID),
    views: defaultViews(),
  });
}

function stubMainViewItems(items: { id: string; component: string; pluginId: string }[]): void {
  vi.stubGlobal("window", { pi: { slots: { mainView: vi.fn(async () => items) } } });
}

async function syncAndFlush(): Promise<void> {
  useLayoutStore.getState().syncMainViewSlot();
  await new Promise((r) => setTimeout(r, 0));
}

describe("syncMainViewSlot → 固化现场自愈(缺陷 A 回归)", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("注册表有 slot:mainView + 树 main 组空:同步后幂等插回并回填 active", async () => {
    seedBrokenState();
    stubMainViewItems([{ id: "timeline", component: "TimelineView", pluginId: "timeline" }]);

    await syncAndFlush();

    expect(mainGroup().viewIds).toEqual([MAIN_VID]);
    expect(mainGroup().activeViewId).toBe(MAIN_VID);
    expect(useLayoutStore.getState().views[MAIN_VID]?.pluginId).toBe("timeline");
  });

  it("已有动态视图占用 active 时:插回但不抢 active", async () => {
    const good = buildDefaultTree({ leftHidden: false, rightHidden: false, leftSize: 20, rightSize: 26 });
    let tree = removeViewFromTree(good, MAIN_VID);
    // 模拟 main 组里有一个动态视图占位(文件预览等)
    const { insertViewIntoGroup } = await import("@/core/domain/layout");
    tree = insertViewIntoGroup(tree, DEFAULT_GROUP_IDS.MAIN, "file-preview:1");
    useLayoutStore.setState({
      tree: (await import("@/core/domain/layout")).validateLayoutTree(tree, {
        ...defaultViews(),
        "file-preview:1": { viewId: "file-preview:1", pluginId: "file-preview", component: "FilePreview", title: "p", closable: true },
      }),
      views: {
        ...defaultViews(),
        "file-preview:1": { viewId: "file-preview:1", pluginId: "file-preview", component: "FilePreview", title: "p", closable: true },
      },
    });
    // 激活动态视图,再摘掉 slot(构造"active 被占用"的破损态)
    useLayoutStore.getState().activateView("file-preview:1");
    const brokenTree = removeViewFromTree(useLayoutStore.getState().tree, MAIN_VID);
    useLayoutStore.setState({ tree: brokenTree });

    stubMainViewItems([{ id: "timeline", component: "TimelineView", pluginId: "timeline" }]);
    await syncAndFlush();

    expect(mainGroup().viewIds).toContain(MAIN_VID);
    expect(mainGroup().activeViewId).toBe("file-preview:1");
  });
});

describe("syncMainViewSlot → 不知道不等于没有(缺陷 B 回归)", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("window.pi.slots.mainView 不是函数:不动现状(slot:mainView 保留在树里)", async () => {
    seedGoodState();
    vi.stubGlobal("window", { pi: { slots: {} } });

    await syncAndFlush();

    expect(mainGroup().viewIds).toEqual([MAIN_VID]);
    expect(useLayoutStore.getState().views[MAIN_VID]).toBeDefined();
  });

  it("window.pi 整体缺失:不动现状", async () => {
    seedGoodState();
    vi.stubGlobal("window", {});

    await syncAndFlush();

    expect(mainGroup().viewIds).toEqual([MAIN_VID]);
  });

  it("IPC reject(瞬态失败):不动现状", async () => {
    seedGoodState();
    vi.stubGlobal("window", {
      pi: { slots: { mainView: vi.fn(async () => { throw new Error("IPC 瞬态失败"); }) } },
    });

    await syncAndFlush();

    expect(mainGroup().viewIds).toEqual([MAIN_VID]);
    expect(useLayoutStore.getState().views[MAIN_VID]).toBeDefined();
  });
});

describe("syncMainViewSlot → 原有语义无回归", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("IPC 权威返回空(timeline 被卸载):移除 slot:mainView(树 + 注册表)", async () => {
    seedGoodState();
    stubMainViewItems([]);

    await syncAndFlush();

    expect(mainGroup().viewIds).toEqual([]);
    expect(mainGroup().activeViewId).toBeNull();
    expect(useLayoutStore.getState().views[MAIN_VID]).toBeUndefined();
  });

  it("winner 相同且树一致:零写入(引用不变)", async () => {
    seedGoodState();
    stubMainViewItems([{ id: "timeline", component: "TimelineView", pluginId: "timeline" }]);
    const treeBefore = useLayoutStore.getState().tree;
    const viewsBefore = useLayoutStore.getState().views;

    await syncAndFlush();

    expect(useLayoutStore.getState().tree).toBe(treeBefore);
    expect(useLayoutStore.getState().views).toBe(viewsBefore);
  });

  it("winner 变化:更新注册表,树不动", async () => {
    seedGoodState();
    stubMainViewItems([{ id: "other", component: "OtherView", pluginId: "other-plugin" }]);

    await syncAndFlush();

    expect(useLayoutStore.getState().views[MAIN_VID]?.pluginId).toBe("other-plugin");
    expect(useLayoutStore.getState().views[MAIN_VID]?.component).toBe("OtherView");
    expect(mainGroup().viewIds).toEqual([MAIN_VID]);
  });

  it("注册表无 slot:mainView(首次启动):新注册并插入 main 组", async () => {
    const good = buildDefaultTree({ leftHidden: false, rightHidden: false, leftSize: 20, rightSize: 26 });
    useLayoutStore.setState({
      tree: removeViewFromTree(good, MAIN_VID),
      views: defaultViews(null),
    });
    stubMainViewItems([{ id: "timeline", component: "TimelineView", pluginId: "timeline" }]);

    await syncAndFlush();

    expect(mainGroup().viewIds).toEqual([MAIN_VID]);
    expect(mainGroup().activeViewId).toBe(MAIN_VID);
    expect(useLayoutStore.getState().views[MAIN_VID]?.pluginId).toBe("timeline");
  });
});
