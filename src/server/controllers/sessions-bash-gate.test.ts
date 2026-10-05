// registerSessions 的「rpc:bash 权限门」守卫 —— 对应源码里的根因修复:
//
//   // BashApi 声明能力门控(rpc:bash)——与 fs:project / git:* / llm:oneshot / sessions:bus
//   // 同一门控族:pluginId 由框架经 PluginIdContext 注入(不自报),服务端核对 manifest
//   // permissions 后放行。
//   function assertBashPermission(pluginId: string): void { … }
//
// 失效形态(修复前的实况):该通道**无门**——契约(sessions.ts BashApi)与注释都写着
// "高危 RCE、需声明 rpc:bash",但 handler 连 caller 身份都不收,任意 renderer 代码可经
// window.kernel.sessions.runBash 直投内核 bash(等价 RCE)。那是"权限只在文档里"的
// 静默缺面最重形态。
//
// 守卫三层:
//   ① **门本身**:已声明 rpc:bash 的插件放行;未声明 / 未知插件必须抛
//   ② **门被装上且收到 caller 身份**:handler 首参必须是 pluginId(通道改形状后,
//      旧形态的裸调用应该直接被拒——身份都传不进来的地方没有门可言)
//   ③ **abortBash 同门**:中止面与执行面同属一个声明能力,不许只门执行不门中止
//
// 夹具同 sessions-gate.test.ts:kernelConfigRoots 函数形状、Proxy chain sessionStore
// (handler 内任何对 sessionStore 的读路径都不该被门测试关心——门在它之前)。
import { describe, it, expect, beforeEach } from "vitest";

import { registerSessions } from "./sessions";
import { IPC } from "@my-harness-desktop/shared";

const handlers = new Map<string, (...a: unknown[]) => unknown>();

/** 已声明/未声明 rpc:bash 的两个插件 + 未知 id;permissions 即 registry.hasPermission 的真相源。 */
const PLUGINS: Record<string, { permissions: string[] }> = {
  "bash-holder": { permissions: ["rpc:bash"] },
  "plain-holder": { permissions: [] },
};

function ctxWith(): Record<string, unknown> {
  const rec = (p: string): unknown =>
    new Proxy(function () {} as unknown as Record<string | symbol, unknown>, {
      get(_t, prop) {
        if (prop === "then") return undefined;
        if (prop === Symbol.toPrimitive) return () => "";
        return rec(`${p}.${String(prop)}`);
      },
      // run/abortBash 在生产是 async 方法 → 这里让 apply 返回真 Promise,
      // 否则 handler 返回 proxy 函数而非 thenable,resolves 断言会说"不是 Promise"。
      apply: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
    });
  return {
    kernelConfigRoots: () => ["/home/u/.pi/agent"],
    paths: { myHarnessDesktopDir: "/home/u/.my-harness-desktop", homeDir: "/home/u" },
    sessionStore: rec("store"),
    registry: {
      manifestOf: (id: string) => PLUGINS[id] ?? null,
      hasPermission: (id: string, perm: string) => PLUGINS[id]?.permissions.includes(perm) ?? false,
    },
  };
}

const gateway = { register: (ch: string, h: (...a: unknown[]) => unknown) => { handlers.set(ch, h); }, broadcast: () => {} };

// 经 gateway 的真实语义调 handler:dispatch 是 `await handler(...)` + catch → ok:false。
// 这里复刻同一形状(Promise.resolve().then 调用),同步 throw 才能被测成 rejects——
// 直接裸调 handler 的话,同步异常会冒过 expect() 的 rejects 断言。
const runBash = (pluginId: string): Promise<unknown> =>
  Promise.resolve().then(() => handlers.get(IPC.session.runBash)!({}, pluginId, "echo hi"));
const abortBash = (pluginId: string): Promise<unknown> =>
  Promise.resolve().then(() => handlers.get(IPC.session.abortBash)!({}, pluginId));

beforeEach(() => {
  handlers.clear();
  registerSessions(gateway as never, ctxWith() as never);
});

describe("rpc:bash 权限门(该通道此前无门)", () => {
  it("★ 已声明 rpc:bash 的插件放行", async () => {
    await expect(runBash("bash-holder")).resolves.toBeDefined();
  });

  it("★ 未声明 rpc:bash 的插件必须抛 —— 权限不只是文档里的一句话", async () => {
    await expect(runBash("plain-holder"), "未声明权限的插件被放行了").rejects.toThrow(/未声明权限 rpc:bash/);
  });

  it("★ 未知插件必须抛(不静默当'无权限'处理,身份错误是独立信号)", async () => {
    await expect(runBash("no-such-plugin"), "未知插件被放行了").rejects.toThrow(/未知插件/);
  });

  it("★ 通道必须收 caller 身份:旧形态的裸调用(无 pluginId)到不了执行面", async () => {
    // runBash("echo hi") 这种旧形态里,"echo hi" 会被当成 pluginId —— 必然拒在门外。
    // 这条断言钉住"通道形状已改":call-site 迁移遗漏不会静默变成无门直投。
    await expect(
      Promise.resolve().then(() => handlers.get(IPC.session.runBash)!({}, "echo hi")),
      "裸调用形态竟然通过了 —— pluginId 首参丢了?",
    ).rejects.toThrow(/未知插件/);
  });

  it("★ abortBash 同门:中止面与执行面同属一个声明能力", async () => {
    await expect(abortBash("bash-holder")).resolves.toBeDefined();
    await expect(abortBash("plain-holder"), "abortBash 没门 —— 只门执行不门中止").rejects.toThrow(/未声明权限 rpc:bash/);
  });
});
