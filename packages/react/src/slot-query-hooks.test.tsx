// @vitest-environment jsdom
// 四个"查槽 + nonce 缓存"同构 hook 的共享性质（r162；此前全部零测试引用）。
//
// ## 为什么一个文件盖四个
//
// `useComposerActions` / `useComposerAttachments` / `useComposerPolicies` / `useComposerStats`
// 是**机械镜像**（各自文件头都写着"机械镜像 useComposerAttachments：同 nonce 单发，失效重拉"），
// 差别只在槽名与条目类型。按 r161 的通则（测试价值 = 边界数 × 消费方数），
// 这种同构族的正确做法是**一套性质 × 四个实例**，而不是四份各写一遍——
// 四份各写会漂移（改了一个忘了另外三个），一套性质则强制它们保持一致。
//
// ## 被测的六条共享性质
//
// ① 首次挂载、promise 未落 ⇒ 返回 `[]`（不返回 undefined、不抛）
// ② promise 落了 ⇒ 返回槽里的贡献（带 pluginId）
// ③ **同 nonce 时后挂载的组件同步拿到缓存**（不闪一次空数组 ⇒ 工具栏不会先空后有）
// ④ **nonce 变了 ⇒ 缓存失效**（初始回到 `[]`，effect 重拉）——插件启停后必须能看到新贡献
// ⑤ **在飞时卸载 ⇒ 不再 setState**（`alive` 标志；否则 React 报"更新已卸载组件"并泄漏）
// ⑥ 槽查询失败（reject）⇒ 不该让组件崩；hook 内已 .catch，保持空列表且不冒成 unhandled rejection

import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, waitFor } from "@testing-library/react";
import { useComposerActions } from "./composer-actions";
import { useComposerAttachments } from "./composer-attachments";
import { useComposerPolicies } from "./composer-policies";
import { useComposerStats } from "./composer-stats";
// r163 扩批：这四个与前四个**机械同构**（模块级 cache + pluginsNonce + useState/useEffect），
//   所以直接复用同一套性质（r162 的"一套性质 × N 个实例"手法）。
import { useComposerTop } from "./composer-top";
import { useComposerVoice } from "./composer-voice";
import { useFileActions, fileActionInvokeChannel } from "./file-actions";
import { useCodeBlockRenderers } from "./code-block-renderers";
// r164 再扩三个（都逐个读源码核实过形状）：sessionGroupings / settingsGroups / fileIcons。
//   ⚠ useFileIconIndex **不入批**：它不是同构实例，而是 useFileIcons + 圆心纯函数
//   buildFileIconIndex 的**组合**（返回索引对象而非数组），单独测（见文件末尾）。
//   这正是 r163 那条通则的用途：扩批前核实，不像的实例不强套家族契约。
import { useSessionGroupings } from "./session-groupings";
import { useSettingsGroups } from "./settings-groups";
import { useFileIcons, useFileIconIndex } from "./file-icons";

// ── ui-store：只暴露 pluginsNonce（可被测试改写以模拟插件启停）
const uiState = { pluginsNonce: 1 };
vi.mock("../../src/web/stores/ui-store", () => ({
  useUiStore: (sel: (s: typeof uiState) => unknown) => sel(uiState),
}));

// ── window.kernel.slots.<槽名>()：可控的 promise
type SlotFn = () => Promise<unknown[]>;
const slots: Record<string, SlotFn> = {};
const calls: Record<string, number> = {};
function installSlot(name: string, impl: SlotFn): void {
  slots[name] = impl;
  calls[name] = 0;
}
beforeEach(() => {
  (window as unknown as { kernel: unknown }).kernel = {
    slots: new Proxy({}, { get: (_t, k: string) => async () => { calls[k] = (calls[k] ?? 0) + 1; return slots[k](); } }),
  };
  uiState.pluginsNonce = 1;
});
afterEach(() => { vi.restoreAllMocks(); });

/** 四个 hook 与其槽名/样本数据（一套性质跑四遍）。 */
const CASES = [
  { name: "useComposerActions", hook: useComposerActions, slot: "composerActions",
    sample: [{ pluginId: "p1", component: "Act" }] },
  { name: "useComposerAttachments", hook: useComposerAttachments, slot: "composerAttachments",
    sample: [{ pluginId: "p2", component: "Att" }] },
  { name: "useComposerPolicies", hook: useComposerPolicies, slot: "composerPolicies",
    sample: [{ pluginId: "p3", component: "Pol" }] },
  { name: "useComposerStats", hook: useComposerStats, slot: "composerStats",
    sample: [{ pluginId: "p4", component: "Sta" }] },
  { name: "useComposerTop", hook: useComposerTop, slot: "composerTop",
    sample: [{ pluginId: "p5", component: "Top" }] },
  { name: "useComposerVoice", hook: useComposerVoice, slot: "composerVoice",
    sample: [{ pluginId: "p6", component: "Voi" }] },
  { name: "useFileActions", hook: useFileActions, slot: "fileActions",
    sample: [{ pluginId: "p7", component: "Fil" }] },
  { name: "useCodeBlockRenderers", hook: useCodeBlockRenderers, slot: "codeBlockRenderers",
    sample: [{ pluginId: "p8", component: "Cod" }] },
  { name: "useSessionGroupings", hook: useSessionGroupings, slot: "sessionGroupings",
    sample: [{ pluginId: "p9", component: "Grp" }] },
  { name: "useSettingsGroups", hook: useSettingsGroups, slot: "settingsGroups",
    sample: [{ pluginId: "p10", component: "Set" }] },
  { name: "useFileIcons", hook: useFileIcons, slot: "fileIcons",
    sample: [{ pluginId: "p11", component: "Ico" }] },
];

function Probe({ hook, onRender }: { hook: () => unknown[]; onRender: (v: unknown[]) => void }): React.ReactNode {
  const v = hook();
  onRender(v);
  return <span data-n={v.length} />;
}

for (const c of CASES) {
  describe(`${c.name}（槽 ${c.slot}）`, () => {
    beforeEach(() => { installSlot(c.slot, async () => c.sample as unknown as unknown[]); });

    it("①② 首次挂载先给 []，promise 落后给槽内容", async () => {
      const seen: unknown[][] = [];
      render(<Probe hook={c.hook as () => unknown[]} onRender={(v) => seen.push(v)} />);
      expect(seen[0], "promise 未落时应是空数组（不是 undefined）").toEqual([]);
      await waitFor(() => expect(seen[seen.length - 1]).toEqual(c.sample));
    });

    it("③ 同 nonce 时**后挂载**的组件同步拿到缓存（不闪一次空）", async () => {
      const first: unknown[][] = [];
      const r1 = render(<Probe hook={c.hook as () => unknown[]} onRender={(v) => first.push(v)} />);
      await waitFor(() => expect(first[first.length - 1]).toEqual(c.sample));
      // 第二个组件挂载：初始 state 应直接来自缓存
      const second: unknown[][] = [];
      render(<Probe hook={c.hook as () => unknown[]} onRender={(v) => second.push(v)} />);
      expect(second[0], "缓存命中 ⇒ 首帧就该有数据，工具栏不会先空后有").toEqual(c.sample);
      r1.unmount();
    });

    it("④ nonce 变了 ⇒ 缓存失效、重新查槽（插件启停后要能看到新贡献）", async () => {
      const seen: unknown[][] = [];
      render(<Probe hook={c.hook as () => unknown[]} onRender={(v) => seen.push(v)} />);
      await waitFor(() => expect(seen[seen.length - 1]).toEqual(c.sample));
      const before = calls[c.slot];
      // 换一批贡献 + 抬 nonce（模拟装了个新插件）
      const next = [{ pluginId: "p9", component: "New" }];
      installSlot(c.slot, async () => next);
      calls[c.slot] = before;
      uiState.pluginsNonce = 2;
      const seen2: unknown[][] = [];
      render(<Probe hook={c.hook as () => unknown[]} onRender={(v) => seen2.push(v)} />);
      // ⚠ 不断言"首帧是 []"（r162 实测：RTL 的 render() 包在 act() 里，会把 effect 与
      //   微任务**同步刷完**，所以 seen2[0] 观察到的已经是刷完后的值 ⇒ 首帧不可观测）。
      //   改为断言**结果**：重新查了槽、且终值是新贡献——这才是要钉的性质
      //   （插件启停后必须能看到新贡献，而不是继续用旧 nonce 的缓存）。
      await waitFor(() => expect(seen2[seen2.length - 1]).toEqual(next));
      expect(calls[c.slot], "nonce 变了应重新查槽（缓存不该被当成有效）").toBeGreaterThan(0);
      expect(seen2[seen2.length - 1], "终值必须是**新**贡献，不是缓存里的旧的").not.toEqual(c.sample);
    });

    it("⑤ **在飞时卸载 ⇒ 不再 setState**（alive 标志；否则更新已卸载组件）", async () => {
      let resolve!: (v: unknown[]) => void;
      installSlot(c.slot, () => new Promise<unknown[]>((r) => { resolve = r; }));
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const utils = render(<Probe hook={c.hook as () => unknown[]} onRender={() => {}} />);
      utils.unmount();                 // promise 还没落就卸载
      await act(async () => { resolve(c.sample as unknown as unknown[]); });
      expect(errSpy.mock.calls.some((a) => /not wrapped in act|unmounted/i.test(String(a[0]))),
        "卸载后 resolve 不该触发对已卸载组件的更新").toBe(false);
      errSpy.mockRestore();
    });

    it("⑥ 槽查询 reject ⇒ 组件不崩，且 hook 内已 catch（不冒成 unhandled rejection）", async () => {
      installSlot(c.slot, async () => { throw new Error("槽查询失败"); });
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      let threw = false;
      try {
        render(<Probe hook={c.hook as () => unknown[]} onRender={() => {}} />);
        await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
      } catch { threw = true; }
      // 断言的是"渲染不崩"（组件树仍在）：槽查询失败是框架级故障（不是用户可行动的），
      // hook 内 .catch(() => {}) 保持空列表即可——**但必须被 catch**，
      // 否则会冒成全局 unhandled rejection（vitest 据此判失败，CI 变红）。
      expect(threw, "渲染阶段不该抛（reject 发生在 effect 里的 promise 链上）").toBe(false);
      errSpy.mockRestore();
    });
  });
}

describe("fileActionInvokeChannel：文件动作回调的 channel 名（纯函数）", () => {
  it("① 形状是 `<pluginId>:fileActionInvoke`（事件总线按 channel 路由，名字错了贡献方收不到）", () => {
    expect(fileActionInvokeChannel("stickers")).toBe("stickers:fileActionInvoke");
  });
  it("② 不同 pluginId 得到**不同** channel（否则两个插件的文件动作会互相串）", () => {
    expect(fileActionInvokeChannel("a")).not.toBe(fileActionInvokeChannel("b"));
  });
  it("③ 确定性：同输入同输出（它被用作事件路由键，不能每次不同）", () => {
    expect(fileActionInvokeChannel("x")).toBe(fileActionInvokeChannel("x"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// useFileIconIndex：不是同构实例，而是 useFileIcons + buildFileIconIndex 的组合
// （r164 逐个核实后单写；见上方 CASES 注释里的理由）
// ─────────────────────────────────────────────────────────────────────────────
describe("useFileIconIndex：查槽 + 建索引一步完成", () => {
  beforeEach(() => { installSlot("fileIcons", async () => []); });

  it("① 槽为空 ⇒ 得到**空索引对象**（不是 null/undefined；消费方直接按行解析不该判空）", async () => {
    let last: unknown = "未渲染";
    render(<Probe hook={useFileIconIndex as unknown as () => unknown[]} onRender={(v) => { last = v; }} />);
    await waitFor(() => expect(last).not.toBe("未渲染"));
    expect(last).toBeTruthy();
    expect(typeof last).toBe("object");
  });

  it("② 槽有贡献 ⇒ 索引里能解析出该扩展名的图标（组合真的把两边接上了）", async () => {
    installSlot("fileIcons", async () => [
      { pluginId: "p1", extensions: ["r164ext"], icon: "star", color: "#fff" },
    ] as unknown[]);
    // ⚠ 索引形状是 `{ byName: Map, byExt: Map }`（圆心 buildFileIconIndex 的返回值）——
    //   **是 Map 不是普通对象**，所以不能用 JSON.stringify 断言（Map 序列化成 {}，
    //   r164 首版就这么写、于是"索引为空"的假象让我以为槽数据没传进去）。
    //   正确做法是直接查 Map。索引内部结构由圆心那边的单测负责，这里只钉
    //   "组合真的把槽数据传给了建索引函数"。
    let last: { byName: Map<string, unknown>; byExt: Map<string, unknown> } | null = null;
    render(<Probe hook={useFileIconIndex as unknown as () => unknown[]} onRender={(v) => { last = v as unknown as { byName: Map<string, unknown>; byExt: Map<string, unknown> }; }} />);
    await waitFor(() => expect(last?.byExt.get("r164ext")).toBeTruthy());
    expect((last!.byExt.get("r164ext") as { icon: string }).icon, "扩展名规则应来自槽里的贡献").toBe("star");
    expect(last!.byName.size, "本样本没有 filenames 规则 ⇒ byName 应为空（不误填）").toBe(0);
  });
});
