// registerSessions 的「会话文件路径圈禁」守卫 —— 对应源码里的一处根因:
//
//   // …声明能力的圈禁被**核心默认能力绕过**(根因:**该通道无门控**)
//   function assertSessionPathAllowed(p: string, paths: MainPaths): void {
//     const allowed =
//       p.startsWith(paths.piAgentDir + sep) ||
//       p.startsWith(paths.myHarnessDesktopDir + sep) ||
//       p.includes(`${sep}.my-harness-desktop${sep}`);
//     if (!allowed) throw new Error(`session 文件路径越界: ${p}`);
//   }
//
// 失效形态:越界路径**能读写会话文件** ✗ —— 不报错、不崩,只是"圈禁被绕过" ✗。
// 守卫分两层:
//   ① **门本身**:三条允许分支放行、其余抛;**且 `+ sep` 的边界不能少**(否则
//      `~/.pi/agent-evil/…` 会被 `startsWith("~/.pi/agent")` 放行 ✗ —— 这是最容易漏的一处)
//   ② **门被装上**:经 `copySession` 通道走一遍 —— 该通道此前无门控,现在 src/target 都要过 ✓
import { describe, it, expect, beforeEach } from "vitest";

import { registerSessions } from "./sessions";
import { IPC } from "@my-harness-desktop/shared";

const handlers = new Map<string, (...a: unknown[]) => unknown>();
const PI_DIR = "/home/u/.pi/agent";
const MHD_DIR = "/home/u/.my-harness-desktop";

function ctxWith(): Record<string, unknown> {
  const rec = (p: string): unknown =>
    new Proxy(function () {} as unknown as Record<string | symbol, unknown>, {
      get(_t, prop) {
        if (prop === "then") return undefined;
        if (prop === Symbol.toPrimitive) return () => "";
        return rec(`${p}.${String(prop)}`);
      },
      apply: () => rec(p),                                    // await 后仍可读属性
    });
  return { paths: { piAgentDir: PI_DIR, myHarnessDesktopDir: MHD_DIR }, sessionStore: rec("store") };
}

const gateway = { register: (ch: string, h: (...a: unknown[]) => unknown) => { handlers.set(ch, h); }, broadcast: () => {} };

const copy = (src: string, dst: string): Promise<unknown> =>
  handlers.get(IPC.session.copySession)!({}, src, dst) as Promise<unknown>;

beforeEach(() => {
  handlers.clear();
  registerSessions(gateway as never, ctxWith() as never);
});

describe("会话文件路径圈禁(该通道此前无门控)", () => {
  it("★ 三条允许分支都放行(pi 目录 / 桌面数据目录 / 项目级 .my-harness-desktop)", async () => {
    await expect(copy(`${PI_DIR}/sessions/a.jsonl`, `${MHD_DIR}/sessions/b.jsonl`)).resolves.toBeDefined();
    await expect(copy("/w/proj/.my-harness-desktop/sessions/a.jsonl", `${MHD_DIR}/x.jsonl`)).resolves.toBeDefined();
  });

  it("★ 越界路径**必须抛** —— 该通道不能绕过圈禁", async () => {
    await expect(copy("/etc/passwd", `${MHD_DIR}/x.jsonl`), "越界源路径被放行了").rejects.toThrow(/越界/);
    await expect(copy(`${PI_DIR}/a.jsonl`, "/etc/passwd"), "越界目标路径被放行了").rejects.toThrow(/越界/);
  });

  it("★ `+ sep` 的边界不能少:同前缀但**不是**该目录的路径也必须抛", async () => {
    await expect(copy("/home/u/.pi/agent-evil/a.jsonl", `${MHD_DIR}/x.jsonl`),
      "`~/.pi/agent-evil/` 被 `startsWith('~/.pi/agent')` 放行了 —— `+ sep` 的边界丢了").rejects.toThrow(/越界/);
    await expect(copy(`${MHD_DIR}-evil/a.jsonl`, `${MHD_DIR}/x.jsonl`),
      "`~/.my-harness-desktop-evil/` 被放行了 —— `+ sep` 的边界丢了").rejects.toThrow(/越界/);
  });
});
