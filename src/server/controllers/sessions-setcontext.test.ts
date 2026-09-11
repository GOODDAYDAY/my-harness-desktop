// registerSessions 的 "setContext 不得预热内核" 守卫 —— 对应源码里一处**正中多内核要害**的根因:
//
//   gateway.register(IPC.session.setContext, (_e, cwd, sessionPath) => {
//     // 只设上下文,不抢跑起内核进程(**内核=模型的派生量**)…
//     // 此前此处 **warmup 抢跑双内核**,会话被绑进预热时随机定的中立会话 + 首注册内核
//     // —— **选 dsh 却路由到 pi、幽灵会话、列表混乱的根因**(§1.5 多内核默认)。
//     sessionStore.setContext(cwd, sessionPath);
//   });
//
// 失效形态:**不报错、不崩**,只是"选 dsh 却路由到 pi" ✗。所以守卫要能抓住**任何形式**的预热,
// 而不是只防某个函数名。做法:给 `ctx` 套一个**记录型 Proxy** —— 任何属性访问/方法调用都被记下,
// 于是"它到底碰了什么"不靠我预先知道 ✓;断言只允许 `sessionStore.setContext` 出现一次。
import { describe, it, expect, vi, beforeEach } from "vitest";

import { registerSessions } from "./sessions";
import { IPC } from "@my-harness-desktop/shared";

type Call = { path: string; args: unknown[] };
const calls: Call[] = [];

/** 记录型深 Proxy:访问记录为 "a.b.c",调用记录为 "a.b.c()" 并返回 ok。 */
function recorder(prefix: string, sink: Call[]): unknown {
  const target = function () {} as unknown as Record<string | symbol, unknown>;
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === "then") return undefined;               // 不当 thenable
      const path = prefix ? `${prefix}.${String(prop)}` : String(prop);
      return recorder(path, sink);
    },
    apply(_t, _this, args) {
      sink.push({ path: `${prefix}()`, args: args as unknown[] });
      return undefined;
    },
  });
}

const handlers = new Map<string, (...a: unknown[]) => unknown>();

beforeEach(() => { calls.length = 0; handlers.clear(); });

describe("registerSessions:session.setContext 只设上下文,不预热内核", () => {
  it("★ setContext handler **只碰 sessionStore.setContext**,不触任何预热路径", () => {
    const gateway = {
      register: (ch: string, h: (...a: unknown[]) => unknown) => { handlers.set(ch, h); },
    };
    registerSessions(gateway as never, recorder("ctx", calls) as never);

    const h = handlers.get(IPC.session.setContext);
    expect(h, "setContext 通道没有注册").toBeTruthy();
    calls.length = 0;                                     // 只看调用时碰了什么(注册期的访问不算)

    h!({}, "/w/proj", "/w/proj/s.jsonl");

    const paths = calls.map((c) => c.path);
    expect(paths, "**预热/起了内核进程** —— 会话会被绑到随机内核(选 dsh 却路由到 pi 的根因)")
      .toEqual(["ctx.sessionStore.setContext()"]);
    expect(calls[0].args, "setContext 的入参没有原样透传").toEqual(["/w/proj", "/w/proj/s.jsonl"]);
  });

  it("★ 即使某些未用到的 ctx 字段是 undefined,也不得误触预热(缺面不猜)", () => {
    const gateway = { register: (ch: string, h: (...a: unknown[]) => unknown) => { handlers.set(ch, h); } };
    registerSessions(gateway as never, recorder("ctx", calls) as never);
    const h = handlers.get(IPC.session.setContext)!;
    calls.length = 0;
    h!({}, "/w/x", null);
    expect(calls.map((c) => c.path)).toEqual(["ctx.sessionStore.setContext()"]);
    expect(calls[0].args).toEqual(["/w/x", null]);
  });
});
