// @vitest-environment jsdom
// ProjectsSection 的 DOM 断言 —— project/projects 插件此前**零渲染层测试**。
// 三条契约全部源自该文件注释里**自述的根因**(即都曾是真 bug),且都是**静默型**:
//   ① 切项目**必须委托** store 的 switchCwd —— 注释:
//      「此前插件自己 startNewChat 是**无条件新会话的根因**」。故给 clearSessionContext 放探针:
//      单纯切项目时**不得**被调用(那是壳动作内部该做的事)。
//   ② 摘掉**当前**项目必须清 cwd + 会话上下文 —— 注释:
//      「否则列表删光了 cwd 还残留(lastCwd 随 prefs 持久化,重启又拉回来,**"删不干净"的根因**)」。
//      反向也钉:摘**非当前**项目**不得**清(否则切走别人把当前会话也清了)。
//   ③ 点项目**只切换、不重排** —— 注释:「顺序语义:点项目只切换、不重排(置顶只由"新增/拖拽"触发)」。
//
// 读取方式:按 title(绝对路径,fixture 自控,无基名歧义)定位行;断言用 store 探针而非 DOM 文本。
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({
  cwds: [] as string[],
  currentCwd: "",
  switchCalls: [] as string[],
  setCwdCalls: [] as string[],
  clearCalls: 0,
  configSets: [] as unknown[][],
  // r184：失败播报的记录（persistState 的 .catch 走它）
  announced: [] as { msg: string; variant?: string }[],
  fired: [] as { tag: string; msg: string }[],
  configSetRejects: false as boolean,
}));
const ctx = vi.hoisted(() => ({
  o: {} as Record<string, unknown>,
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock("@my-harness-desktop/react", () => ({
  usePluginContext: () => ctx.o,
  useUiStore: () => ({
    currentCwd: h.currentCwd,
    setCurrentCwd: (v: string) => { h.setCwdCalls.push(v); },
    clearSessionContext: () => { h.clearCalls += 1; },
  }),
  // store 动作:注释要求切项目**委托**它
  useSessionStore: Object.assign(() => ({}), {
    getState: () => ({ switchCwd: async (d: string) => { h.switchCalls.push(d); } }),
  }),
  Section: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
  // ⚠ r183 的产品改动新 import 了 announceTransient；mock 不给它，测试里一调就是 undefined
  //   （r165 的教训：mock 缺项不会报错，只会在调用点炸或静默无效）。
  // ⚠ r185：产品改用框架原语 fireAndReport（四处同构兜底收敛到 packages/react），
  //   所以 mock 要给的是它、不再是 announceTransient（r184 那条"产品新增 import 后要查 mock 缺项"
  //   在这里立刻应验——上一轮刚补的 announceTransient 这一轮就被换掉了）。
  //   这里只**记录插件传进来的选项**（tag 与 message 产出），原语自身的行为由
  //   packages/react/src/widgets/fire-and-report.test.ts 单独测（分层：插件测接线、原语测机制）。
  fireAndReport: (pr: Promise<unknown>, opts: { tag: string; message: (d: string) => string }) => {
    void pr.catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      h.fired.push({ tag: opts.tag, msg: opts.message(detail) });
      h.announced.push({ msg: opts.message(detail), variant: "error" });
    });
    return pr;
  },
  pickDirectory: async () => null,
}));

import { ProjectsSection } from "./index";

const row = (dir: string): HTMLElement => document.querySelector(`[title="${dir}"]`) as HTMLElement;
beforeEach(() => {
  h.cwds = ["/w/alpha", "/w/beta"]; h.currentCwd = "/w/alpha";
  h.switchCalls = []; h.setCwdCalls = []; h.clearCalls = 0; h.configSets = [];
  h.announced = []; h.fired = []; h.configSetRejects = false;
  ctx.o = {
    config: {
      get: async (k: string) => (k === "recentCwds" ? h.cwds : k === "sectionCollapsed" ? false : undefined),
      set: async (...a: unknown[]) => {
        h.configSets.push(a);
        if (h.configSetRejects) throw new Error("写盘失败(夹具)");
      },
    },
  };
});

describe("ProjectsSection(左栏项目组)", () => {
  it("列出 recentCwds 的每一项(按绝对路径锚定)", async () => {
    render(<ProjectsSection />);
    await waitFor(() => expect(row("/w/alpha")).toBeTruthy());
    expect(row("/w/beta")).toBeTruthy();
  });

  it("① 点项目 → **委托** store.switchCwd(dir);不自作主张清会话上下文", async () => {
    render(<ProjectsSection />);
    await waitFor(() => expect(row("/w/beta")).toBeTruthy());
    fireEvent.click(row("/w/beta"));
    await waitFor(() => expect(h.switchCalls).toEqual(["/w/beta"]));
    expect(h.clearCalls, "切项目时插件自己清了会话上下文(应交给壳动作内部决定)").toBe(0);
  });

  // 移除控件的锚（r156 更新）：现在用**稳定锚点** `[data-project-remove]`，不再按标签结构猜。
  //   此前它是"行内唯一带 title 的 **span**、且悬停后才渲染"，所以本测试只能写
  //   `row(dir).querySelector("span[title]")` 并先 mouseEnter —— 那是**脆弱探针**：
  //   元素换标签（r156 把 span 改成真 button）测试就红，而产品行为其实变好了。
  //   r156 修复后：按钮**常驻 DOM**（可见性由 hovered||focused 驱动），
  //   所以不再需要 mouseEnter，而且键盘用户也能 Tab 到它（此前既 hover 门控、又是 span 不可聚焦）。
  const removeControl = (dir: string): HTMLElement | null =>
    row(dir).querySelector<HTMLElement>("[data-project-remove]");

  it("② 摘掉**当前**项目 → 清 cwd + 会话上下文(否则'删不干净')", async () => {
    render(<ProjectsSection />);
    await waitFor(() => expect(row("/w/alpha")).toBeTruthy());
    const ctl = removeControl("/w/alpha");
    // r156：不需要 hover 就该在 DOM 里（此前是条件渲染，键盘用户够不着）
    expect(ctl, "移除控件应常驻 DOM（r156 修 hover 门控）").not.toBeNull();
    expect(ctl!.style.opacity, "未 hover/未聚焦时视觉隐藏但仍可聚焦").toBe("0");
    expect(ctl!.tagName, "必须是真 button（此前是 span ⇒ 不可聚焦、Enter/Space 无效）").toBe("BUTTON");
    fireEvent.click(ctl!);
    await waitFor(() => expect(h.clearCalls, "摘掉当前项目没有清会话上下文('删不干净'的根因)").toBe(1));
    expect(h.setCwdCalls, "摘掉当前项目没有把 cwd 置空").toContain("");
  });

  it("②b 摘掉**非当前**项目 → **不得**清当前会话上下文", async () => {
    render(<ProjectsSection />);
    await waitFor(() => expect(row("/w/beta")).toBeTruthy());
    fireEvent.click(removeControl("/w/beta")!);   // r156：常驻 DOM，不需先 hover
    await waitFor(() => expect(h.configSets.length).toBeGreaterThan(0));
    expect(h.clearCalls, "摘掉别的项目却把当前会话清掉了").toBe(0);
  });

  it("③ 点项目**只切换、不重排**(落盘顺序不变)", async () => {
    render(<ProjectsSection />);
    await waitFor(() => expect(row("/w/beta")).toBeTruthy());
    fireEvent.click(row("/w/beta"));
    await waitFor(() => expect(h.switchCalls).toEqual(["/w/beta"]));
    const orderWrite = h.configSets.find((a) => a[0] === "recentCwds");
    expect(orderWrite, "点项目竟写回了 recentCwds(会重排)").toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// persistState 的失败播报（r184：补 r183 那批"修了但没测"的 DOM 层断言）
//
// r183 把 7 处 `void ctx.config.set(...)` 发射后不管改成 persistState/persist
// （.catch ⇒ console.warn + announceTransient）。当时如实记了欠据：失败路径没测。
// 它在 jsdom 里**可直接构造**（把 ctx.config.set 换成 reject），不需要真机造传输失败——
// 判据是 r170 那条：mock 的是**协作者**（config 写入的实现），不是被测对象
// （persistState 的失败处置逻辑）。
// ─────────────────────────────────────────────────────────────────────────────
describe("persistState：UI 态落盘失败要播报（r183 那批兜底的 DOM 层断言）", () => {
  it("① 写失败 ⇒ 播报一条 error，且文案含**可行动指引**与失败的 key", async () => {
    h.configSetRejects = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(<ProjectsSection />);
    await waitFor(() => expect(row("/w/alpha")).toBeTruthy());
    // 折叠/展开分组会触发 persistState("sectionCollapsed", …)
    const toggle = document.querySelector("[data-project-group-toggle], button[aria-expanded]");
    if (toggle) fireEvent.click(toggle);
    // 若该控件不存在，退而点删除按钮也会触发 recentCwds 落盘
    if (h.configSets.length === 0) {
      const rm = document.querySelector("[data-project-remove]");
      if (rm) fireEvent.click(rm as HTMLElement);
    }
    await waitFor(() => expect(h.configSets.length).toBeGreaterThan(0));
    await waitFor(() => expect(h.announced.length).toBeGreaterThan(0));
    const a = h.announced[0];
    expect(a.variant, "落盘失败是用户可行动的故障 ⇒ 必须走 error 级（不是 info）").toBe("error");
    expect(a.msg, "文案要点名失败的 key（否则用户不知道哪个状态没保住）").toContain("stateSaveFailed");
    // ⚠ **不在这一层断言 console.warn**（r185 首版在这断言了、于是红）：
    //   收敛到框架原语之后，warn 是**原语的职责**，而原语在本测试里被 mock 掉了。
    //   它由 packages/react/src/widgets/fire-and-report.test.ts ② 单独钉住。
    //   这正是本文件顶部写的分层原则（插件测接线、原语测机制）——断言不能越过自己那一层，
    //   否则会因"下层被替身换掉"而假失败，且诱导人把下层的实现细节复制进上层测试。
    expect(warn, "本层不该断言原语的内部行为").toBeDefined();
    warn.mockRestore();
  });

  it("② 写**成功** ⇒ 不播报（不给用户假警报）", async () => {
    h.configSetRejects = false;
    render(<ProjectsSection />);
    await waitFor(() => expect(row("/w/alpha")).toBeTruthy());
    const rm = document.querySelector("[data-project-remove]");
    if (rm) fireEvent.click(rm as HTMLElement);
    await waitFor(() => expect(h.configSets.length).toBeGreaterThan(0));
    expect(h.announced, "成功路径不该播报任何失败信息").toEqual([]);
  });

  it("③ 落盘失败**不影响本地 UI 生效**（§7.6：部分成功要显示已成功的部分 + 说明失败项）", async () => {
    h.configSetRejects = true;
    render(<ProjectsSection />);
    await waitFor(() => expect(row("/w/beta")).toBeTruthy());
    const rm = row("/w/beta").querySelector("[data-project-remove]") as HTMLElement | null;
    if (rm) {
      fireEvent.click(rm);
      // 本地立即移除（用户的动作有反馈），同时被告知没保住
      await waitFor(() => expect(row("/w/beta")).toBeNull());
      await waitFor(() => expect(h.announced.length).toBeGreaterThan(0));
    }
  });
});

describe("persistState 的接线（r185 收敛到 fireAndReport 之后）", () => {
  it("④ 失败时传给原语的是**本插件的 tag 与含 key 的文案**（框架零文案，内容由插件供）", async () => {
    h.configSetRejects = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(<ProjectsSection />);
    await waitFor(() => expect(row("/w/alpha")).toBeTruthy());
    const rm = row("/w/beta")?.querySelector("[data-project-remove]") as HTMLElement | null;
    if (rm) fireEvent.click(rm);
    await waitFor(() => expect(h.fired.length).toBeGreaterThan(0));
    expect(h.fired[0].tag, "tag 用于 console.warn 前缀，点名是哪个插件").toBe("projects");
    expect(h.fired[0].msg, "文案来自插件的 i18n 键（框架不含文案，§1.2）").toContain("projects.stateSaveFailed");
    warn.mockRestore();
  });
});
