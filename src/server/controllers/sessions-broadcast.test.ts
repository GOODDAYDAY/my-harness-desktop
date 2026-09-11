// registerSessions 的「改行字段后必须广播」守卫 —— 对应源码里的一处根因:
//
//   const notifyHeaderChanged = (payload: SessionHeaderChangedEvent): void =>
//     gateway.broadcast(IPC.session.headerChanged, payload);
//   // 此前**只写不播**,操作端本地重拉,其他端纹丝不动(「归档没有同步多端」根因);
//   // 再后来各端收到广播**全量重拉**(被归档次数×客户端数乘法放大)——§2.6 起 **payload
//   // 类型化自带补丁**,客户端本地打行,**copy 例外仍重拉**。
//
// 失效形态:归档/改名/删除在一端做了、**别的端看不到** ✗ —— 不报错、不崩,只是"不同步" ✗。
// 守卫:对每个"改行字段"的通道,断言 **写 store 与广播 headerChanged 都发生**,且 payload 带正确 kind。
// 红绿证明:把 notifyHeaderChanged(...) 删掉 → 必须红。
//
// 做法:gateway 用**捕获型**替身(截 handler / 收 broadcast);ctx 用**记录型深 Proxy**
//      (不必预知 ctx 形状,任何访问都被记下);`apply` 返回**新的 recorder** 而不是 undefined,
//      于是 `await` 得到的是可继续读属性的对象,被测代码不会在半路抛。
import { describe, it, expect, beforeEach } from "vitest";

import { registerSessions } from "./sessions";
import { IPC } from "@my-harness-desktop/shared";

type Call = { path: string; args: unknown[] };
const calls: Call[] = [];
const broadcasts: { ch: string; payload: unknown }[] = [];
const handlers = new Map<string, (...a: unknown[]) => unknown>();

function recorder(prefix: string): unknown {
  const target = function () {} as unknown as Record<string | symbol, unknown>;
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === "then") return undefined;              // 不当 thenable:await 直接得到本对象
      // 被测代码会把 ctx 的字段当**字符串**用(路径圈禁里的 startsWith/模板串)。
      // 不给这个,proxy 会抛 `Cannot convert object to primitive value` ——
      // 实测就是因此让 copySession 那条红掉的(它要过 assertSessionPathAllowed)。
      if (prop === Symbol.toPrimitive) return () => "";
      return recorder(prefix ? `${prefix}.${String(prop)}` : String(prop));
    },
    apply(_t, _this, args) {
      const path = `${prefix}()`;
      calls.push({ path, args: args as unknown[] });
      return recorder(path.slice(0, -2));                  // 可继续读属性(await 后也能用)
    },
  });
}

const gateway = {
  register: (ch: string, h: (...a: unknown[]) => unknown) => { handlers.set(ch, h); },
  broadcast: (ch: string, payload: unknown) => { broadcasts.push({ ch, payload }); },
};

const headerChanged = (): { ch: string; payload: unknown }[] =>
  broadcasts.filter((b) => b.ch === IPC.session.headerChanged);

beforeEach(() => { calls.length = 0; broadcasts.length = 0; handlers.clear(); registerSessions(gateway as never, recorder("ctx") as never); });

describe("registerSessions:改行字段的操作必须广播 headerChanged(只写不播 = 不同步多端)", () => {
  it("rename:写了 store **且** 广播 {kind:'rename'}", async () => {
    await handlers.get(IPC.session.rename)!({}, "/w/s.jsonl", "新名");
    expect(calls.some((c) => c.path.includes("sessionStore")), "没有写 store").toBe(true);
    const hc = headerChanged();
    expect(hc.length, "**只写不播** —— 别的端看不到改名").toBe(1);
    expect(hc[0].payload, "payload 没有类型化 kind(客户端无法本地打补丁)").toMatchObject({ kind: "rename" });
  });

  it("delete:写了 store **且** 广播 {kind:'delete'}", async () => {
    await handlers.get(IPC.session.delete)!({}, ["/w/a.jsonl"]);
    const hc = headerChanged();
    expect(hc.length, "删除没有广播 —— 别的端列表还留着").toBe(1);
    expect(hc[0].payload).toMatchObject({ kind: "delete" });
  });

  it("copySession:同样要广播(**copy 是例外:客户端仍全量重拉**,但广播不能少)", async () => {
    await handlers.get(IPC.session.copySession)!({}, "/w/src.jsonl", "/w/dst.jsonl");
    const hc = headerChanged();
    expect(hc.length, "复制没有广播").toBe(1);
    expect(hc[0].payload).toMatchObject({ kind: "copy" });
  });

  it("广播的通道只有一个:全部走 IPC.session.headerChanged(不另开通道)", async () => {
    await handlers.get(IPC.session.rename)!({}, "/w/s.jsonl", "x");
    expect(new Set(broadcasts.map((b) => b.ch))).toEqual(new Set([IPC.session.headerChanged]));
  });
});
