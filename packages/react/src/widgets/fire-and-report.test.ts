// fireAndReport 原语（r185；收敛自四个插件各抄一份的同构兜底）。
//
// ## 为什么原语要单独测、而插件只测接线
//
// 收敛之后有两个层次：① 原语的机制（失败 ⇒ warn + 播报 error 级 + detail 提取）；
// ② 各插件传进来的选项（tag、message 文案）。①只需测一次（四个插件共享），
// ②在各插件自己的测试里断言（如 projects 的 index.test.tsx ④）。
// 这样"原语改坏"与"插件传错参数"两类回归各有归属，不会互相掩盖。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const announced: { msg: string; variant?: string }[] = [];
vi.mock("./live-region", () => ({
  announceTransient: (msg: string, variant?: string) => { announced.push({ msg, variant }); },
}));

import { fireAndReport } from "./fire-and-report";

beforeEach(() => { announced.length = 0; });
afterEach(() => { vi.restoreAllMocks(); });

const opts = (tag = "t") => ({ tag, message: (d: string) => `失败:${d}` });

describe("fireAndReport：发射后不管但不丢错误", () => {
  it("① 成功 ⇒ 不播报、不 warn（不给用户假警报）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fireAndReport(Promise.resolve("ok"), opts());
    await Promise.resolve(); await Promise.resolve();
    expect(announced, "成功路径不该播报").toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("② 失败（Error）⇒ 播报 **error** 级、文案含 detail、并留 console.warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fireAndReport(Promise.reject(new Error("写盘失败")), opts("projects"));
    await Promise.resolve(); await Promise.resolve();
    expect(announced).toHaveLength(1);
    expect(announced[0].variant, "用户动作没成功 ⇒ 必须 error 级（info 会被读屏用户忽略）").toBe("error");
    expect(announced[0].msg, "detail 要来自 Error.message").toBe("失败:写盘失败");
    expect(warn.mock.calls.some((c: unknown[]) => String(c[0]).includes("[projects]")),
      "console.warn 的前缀要点名 tag（排查时知道是哪个插件）").toBe(true);
  });

  it("③ 失败（非 Error 值）⇒ detail 走 String()（不因 throw 了字符串/对象而丢信息）", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fireAndReport(Promise.reject("裸字符串原因"), opts());
    await Promise.resolve(); await Promise.resolve();
    expect(announced[0].msg).toBe("失败:裸字符串原因");
  });

  it("④ 原语**不吞掉** promise 的结果语义：它返回 void，调用方仍可自己 await（不改变时序）", () => {
    const p = Promise.resolve(1);
    expect(fireAndReport(p, opts()), "返回值是 void（发射后不管），不返回 promise").toBeUndefined();
  });

  it("⑤ 反证：不是『任何失败都播报』——只有传进来的那个 promise 失败才播报", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const unrelated = Promise.reject(new Error("无关的失败")).catch(() => {});
    fireAndReport(Promise.resolve("好"), opts());
    await Promise.resolve(); await Promise.resolve();
    expect(announced, "无关 promise 的失败不该被算到这次动作上").toEqual([]);
    await unrelated;
  });
});
