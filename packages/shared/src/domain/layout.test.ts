// 布局树的 5 个纯函数（r148；此前零测试引用）。
//
// ## 为什么这一族风险最高
//
// 布局树决定**面板结构**：剪枝错了会丢面板、拍扁错了会留下空壳 split、
// 重水合错了会让用户下次启动看到完全不同的布局。而这些函数都是**递归 + 尺寸再分配**，
// 属于"改一行就可能悄悄改变整棵树形状"的代码——正是 §5.6 里 unittest 层该钉住的东西
// （纯函数、零外部依赖，按 §4.5 判据不需要 mock）。
//
// ⚠ 断言覆盖两侧（r141/r143/r147 的纪律）：该删的删、**不该删的不删**（默认组即使空也保留）；
//   该拍扁的拍扁、**0 孩子的 split 原样保留**（文档注释写明的行为，不是漏网）。

import { describe, it, expect } from "vitest";
import {
  pruneEmptyGroups, flattenSingleChildSplits, rehydrateLayout, collectGroupIds, splitGroup,
  DEFAULT_GROUP_IDS, type LayoutNode, type LayoutGroup, type LayoutSplit, type ViewInstance,
} from "./layout";

function grp(id: string, viewIds: string[] = [], activeViewId: string | null = null): LayoutGroup {
  return { kind: "group", id, viewIds, activeViewId };
}
function split(children: LayoutNode[], sizes: number[], direction: "horizontal" | "vertical" = "horizontal", id = "root"): LayoutSplit {
  return { kind: "split", id, direction, sizes, children };
}

describe("pruneEmptyGroups：删空组 + 尺寸再分配", () => {
  it("① 空的**非默认**组被删，其尺寸累加给最近的未删兄弟（**先左**）", () => {
    const tree = split([grp("left", ["shell:a"]), grp("tmp"), grp("main", ["shell:b"])], [30, 20, 50]);
    const out = pruneEmptyGroups(tree) as LayoutSplit;
    expect(out.children.map((c) => (c as LayoutGroup).id)).toEqual(["left", "main"]);
    expect(out.sizes, "被删的 20 应给左边的 left（先左后右）").toEqual([50, 50]);
  });

  it("② 左侧没有未删兄弟时，尺寸给**右边**的兄弟", () => {
    const tree = split([grp("tmp1"), grp("main", ["shell:b"])], [40, 60]);
    const out = pruneEmptyGroups(tree) as LayoutSplit;
    expect(out.children).toHaveLength(1);
    expect(out.sizes, "左边全是待删组 ⇒ 40 给右边的 main").toEqual([100]);
  });

  it("③ **默认组即使为空也不删**（left/main/right 是布局骨架，删了面板就没了）", () => {
    const tree = split([grp(DEFAULT_GROUP_IDS.LEFT), grp(DEFAULT_GROUP_IDS.MAIN), grp(DEFAULT_GROUP_IDS.RIGHT)], [20, 60, 20]);
    const out = pruneEmptyGroups(tree) as LayoutSplit;
    expect(out.children.map((c) => (c as LayoutGroup).id)).toEqual(["left", "main", "right"]);
    expect(out.sizes).toEqual([20, 60, 20]);
  });

  it("④ 递归：嵌套 split 里的空组也会被删", () => {
    const inner = split([grp("main", ["shell:b"]), grp("tmp")], [70, 30], "vertical", "inner");
    const tree = split([grp("left", ["shell:a"]), inner], [25, 75]);
    const out = pruneEmptyGroups(tree) as LayoutSplit;
    const innerOut = out.children[1] as LayoutSplit;
    expect(innerOut.children).toHaveLength(1);
    expect(innerOut.sizes, "内层的 30 应给 main").toEqual([100]);
  });

  it("⑤ group 传进来原样返回（不是 split 就没什么可剪）；且**不改入参**（纯函数）", () => {
    const g = grp("main", ["shell:a"]);
    expect(pruneEmptyGroups(g)).toBe(g);
    const tree = split([grp("left", ["shell:a"]), grp("tmp"), grp("main", ["shell:b"])], [30, 20, 50]);
    const snapshot = JSON.stringify(tree);
    pruneEmptyGroups(tree);
    expect(JSON.stringify(tree), "纯函数不得修改入参树").toBe(snapshot);
  });
});

describe("flattenSingleChildSplits：拍扁单子 split", () => {
  it("① 只剩一个孩子的 split 被那个孩子替换", () => {
    const tree = split([grp("main", ["shell:a"])], [100]);
    expect(flattenSingleChildSplits(tree)).toEqual(grp("main", ["shell:a"]));
  });

  it("② 两个孩子 ⇒ 不拍扁（结构保持）", () => {
    const tree = split([grp("left"), grp("main")], [50, 50]);
    const out = flattenSingleChildSplits(tree) as LayoutSplit;
    expect(out.kind).toBe("split");
    expect(out.children).toHaveLength(2);
  });

  it("③ **0 孩子的 split 原样保留**（文档注释写明：后续校验会处理，不是这里拍扁）", () => {
    const tree = split([], []);
    const out = flattenSingleChildSplits(tree) as LayoutSplit;
    expect(out.kind).toBe("split");
    expect(out.children).toHaveLength(0);
  });

  it("④ 递归：嵌套的单子 split 一路拍到底", () => {
    const inner = split([grp("main", ["shell:a"])], [100], "vertical", "inner");
    const tree = split([inner], [100]);
    expect(flattenSingleChildSplits(tree)).toEqual(grp("main", ["shell:a"]));
  });

  it("⑤ group 传进来原样返回", () => {
    const g = grp("left");
    expect(flattenSingleChildSplits(g)).toBe(g);
  });
});

describe("rehydrateLayout：从盘上原始值重建布局树", () => {
  const views: Record<string, ViewInstance> = {
    // ViewInstance 的必填字段是 viewId/pluginId/component/**title**/**closable**（icon/props 可选）
    "shell:a": { viewId: "shell:a", pluginId: "shell", component: "A", title: "视图 A", closable: false },
  };
  const validRaw = {
    kind: "split", id: "root", direction: "horizontal", sizes: [20, 80],
    children: [
      { kind: "group", id: "left", viewIds: ["shell:a"], activeViewId: "shell:a" },
      { kind: "group", id: "main", viewIds: [], activeViewId: null },
    ],
  };

  it("① 合法输入 ⇒ 返回树（且经过剪枝与拍扁）", () => {
    const out = rehydrateLayout(validRaw, views);
    expect(out?.kind).toBe("split");
    expect((out as LayoutSplit).children).toHaveLength(2);
  });

  it("② 非法输入 ⇒ null（不抛给调用方；盘上数据可能是旧版本/被手改过）", () => {
    expect(rehydrateLayout(null, views)).toBeNull();
    expect(rehydrateLayout({}, views)).toBeNull();
    expect(rehydrateLayout("不是树", views)).toBeNull();
    expect(rehydrateLayout({ kind: "unknown" }, views)).toBeNull();
  });

  it("③ 剪枝/拍扁后根 split 孩子数 <2 ⇒ **整棵树回退**（返回 null，让调用方用默认布局）", () => {
    const oneChild = {
      kind: "split", id: "root", direction: "horizontal", sizes: [100],
      children: [{ kind: "group", id: "left", viewIds: ["shell:a"], activeViewId: "shell:a" }],
    };
    expect(rehydrateLayout(oneChild, views), "单孩子的根 split 不是一个可用布局").toBeNull();
  });

  it("④ 引用了不存在的 viewId ⇒ null（视图注册表是真相源，不允许悬空引用）", () => {
    const dangling = JSON.parse(JSON.stringify(validRaw));
    dangling.children[0].viewIds = ["shell:不存在的视图"];
    expect(rehydrateLayout(dangling, views)).toBeNull();
  });
});

describe("collectGroupIds / splitGroup", () => {
  it("① collectGroupIds 按**前序**收集所有 group id", () => {
    const inner = split([grp("main"), grp("right")], [60, 40], "vertical", "inner");
    const tree = split([grp("left"), inner], [25, 75]);
    expect(collectGroupIds(tree)).toEqual(["left", "main", "right"]);
  });

  it("② splitGroup：ratio 越界 ⇒ **抛错**（不是夹到 0–1，静默夹会让调用方以为成功了）", () => {
    const tree = split([grp("left"), grp("main")], [50, 50]);
    expect(() => splitGroup(tree, "left", "vertical", "n1", 1.5)).toThrow(/ratio/);
    expect(() => splitGroup(tree, "left", "vertical", "n1", -0.1)).toThrow(/ratio/);
  });

  it("③ splitGroup：目标组不存在 ⇒ 抛错并点名该组 id（可行动的报错）", () => {
    const tree = split([grp("left"), grp("main")], [50, 50]);
    expect(() => splitGroup(tree, "不存在的组", "vertical", "n1")).toThrow(/不存在的组/);
  });

  it("④ splitGroup：正常分裂 ⇒ 原组位置变成 split，尺寸按 ratio 分（且总和不变）", () => {
    const tree = split([grp("left"), grp("main")], [40, 60]);
    const out = splitGroup(tree, "left", "vertical", "newG", 0.25) as LayoutSplit;
    expect(out.children).toHaveLength(2);
    const replaced = out.children[0] as LayoutSplit;
    expect(replaced.kind, "原 left 的位置应变成一个 split").toBe("split");
    expect(replaced.direction).toBe("vertical");
    // ⚠ ratio 的语义是**原组保留的份额**（实现：ofNewSize = ofGroupSize * ratio，新组拿剩下的），
    //   不是"分给新组的比例"。r148 首版按后者写期望（[75,25]）被这条测试当场纠正——
    //   这正是补测的价值：语义只写在实现里、没有测试钉住时，连读代码的人都会猜反。
    expect(replaced.sizes, "left 保留 25%，新组 newG 拿 75%").toEqual([25, 75]);
    expect(out.sizes.reduce((a, b) => a + b, 0), "外层总尺寸不变").toBe(100);
    expect(collectGroupIds(out)).toEqual(["left", "newG", "main"]);
  });
});
