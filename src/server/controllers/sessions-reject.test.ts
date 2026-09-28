// registerSessions 的「异步失败必须冒泡,不能不冒泡」守卫 —— 对应源码里的一处根因:
//
//   // 必须 await:此前 **void 派发**,复制失败(源缺失等)变 main **未捕获拒绝**,
//   // 而调用方那边看起来是"成功"。
//
// 失效形态:store 抛错 → 若 handler **不 await**,它的 promise 会**正常 resolve** ✗ →
// 调用端以为成功 ✗,而真正的错误变成进程级未捕获拒绝 ✗。**不报错给调用方,只烂在日志里** ✓。
//
// 做法(不必知道 store 的方法名):用一个"**每次调用都返回 rejected promise**"的记录型 Proxy ——
//   · handler 若 await 了 → 它的 promise **跟着 reject** ✓(守卫通过)
//   · handler 若 void 了 → 它 resolve ✓ **且** 制造一个未捕获拒绝 ✓(守卫红)
import { describe, it, expect, beforeEach } from "vitest";

import { registerSessions } from "./sessions";
import { IPC } from "@my-harness-desktop/shared";

const handlers = new Map<string, (...a: unknown[]) => unknown>();
const PI_DIR = "/home/u/.pi/agent";
const MHD_DIR = "/home/u/.my-harness-desktop";

/** 每次调用都 reject 的深 Proxy:用来证明"错误确实从 handler 冒出来"。 */
function failing(p: string): unknown {
  return new Proxy(function () {} as unknown as Record<string | symbol, unknown>, {
    get(_t, prop) {
      if (prop === "then") return undefined;
      if (prop === Symbol.toPrimitive) return () => p;          // 供路径圈禁当字符串用
      return failing(`${p}.${String(prop)}`);
    },
    apply: () => Promise.reject(new Error("store boom")),
  });
}

const gateway = { register: (ch: string, h: (...a: unknown[]) => unknown) => { handlers.set(ch, h); }, broadcast: () => {} };

beforeEach(() => {
  handlers.clear();
  registerSessions(gateway as never, {
    kernelConfigRoots: () => [PI_DIR],   // 函数形状（§3.6.3 活访问器）
    paths: { myHarnessDesktopDir: MHD_DIR },
    sessionStore: failing("store"),
  } as never);
});

describe("registerSessions:异步 store 失败必须冒泡给调用方(不能 void 掉)", () => {
  it("★ copySession:store 抛错时,handler 的 promise **必须 reject**(否则调用方误以为成功)", async () => {
    const h = handlers.get(IPC.session.copySession);
    expect(h, "copySession 通道没有注册").toBeTruthy();
    await expect(
      h!({}, `${MHD_DIR}/a.jsonl`, `${MHD_DIR}/b.jsonl`) as Promise<unknown>,
      "**handler 把失败吞了**(void 派发)——调用方看到的是成功,错误只烂在进程里",
    ).rejects.toThrow(/store boom/);
  });

  it("★ rename:同样必须冒泡(该文件里所有异步 store 调用都该 await)", async () => {
    const h = handlers.get(IPC.session.rename);
    await expect(h!({}, `${MHD_DIR}/a.jsonl`, "新名") as Promise<unknown>).rejects.toThrow(/store boom/);
  });
});
