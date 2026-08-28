// reconcileMissingKernels 单测:冷启动对账的「扫缺 → 判缺 → 补装」三步 + 失败不崩。
// 用假 KernelManager,不起真进程、不碰 npm。
import { describe, it, expect } from "vitest";
import { reconcileMissingKernels } from "./kernel-reconcile";
import type { KernelManager } from "./kernel-manager";

interface ManagerStub {
  manager: KernelManager;
  installCalls: string[];
}

function makeManager(opts: {
  available?: boolean;
  latest?: string | null;
  installOk?: boolean;
  installThrow?: Error;
} = {}): ManagerStub {
  const installCalls: string[] = [];
  const manager = {
    currentVersion: () => ({
      currentVersion: opts.available ? "1.0.0" : null,
      available: opts.available ?? false,
      error: null,
    }),
    listVersions: async () => ({ versions: ["1.0.0"], latest: opts.latest === undefined ? "1.0.0" : opts.latest }),
    install: async (version: string) => {
      if (opts.installThrow) throw opts.installThrow;
      installCalls.push(version);
      return { ok: opts.installOk ?? true, error: null };
    },
  } as unknown as KernelManager;
  return { manager, installCalls };
}

describe("reconcileMissingKernels", () => {
  it("已装内核跳过(already),不触发 install", async () => {
    const { manager, installCalls } = makeManager({ available: true });
    const settled: string[] = [];
    await reconcileMissingKernels(
      [{ kernel: "pi", manager }],
      () => {},
      (r) => settled.push(`${r.kernel}:${r.outcome}`),
    );
    expect(settled).toEqual(["pi:already"]);
    expect(installCalls).toEqual([]);
  });

  it("缺失内核按 dist-tag latest 自动补装(installed)", async () => {
    const { manager, installCalls } = makeManager({ latest: "0.1.1-rc.2" });
    const settled: string[] = [];
    await reconcileMissingKernels(
      [{ kernel: "dsh", manager }],
      () => {},
      (r) => settled.push(`${r.kernel}:${r.outcome}`),
    );
    expect(settled).toEqual(["dsh:installed"]);
    expect(installCalls).toEqual(["0.1.1-rc.2"]);
  });

  it("registry 无 dist-tag 版本 → failed,不抛", async () => {
    const { manager, installCalls } = makeManager({ latest: null });
    const settled: string[] = [];
    await reconcileMissingKernels(
      [{ kernel: "pi", manager }],
      () => {},
      (r) => settled.push(`${r.kernel}:${r.outcome}`),
    );
    expect(settled).toEqual(["pi:failed"]);
    expect(installCalls).toEqual([]);
  });

  it("install 抛错 → failed,继续下一个内核(串行不崩)", async () => {
    const a = makeManager({ installThrow: new Error("npm boom") });
    const b = makeManager({ installOk: true });
    const settled: string[] = [];
    await reconcileMissingKernels(
      [
        { kernel: "pi", manager: a.manager },
        { kernel: "dsh", manager: b.manager },
      ],
      () => {},
      (r) => settled.push(`${r.kernel}:${r.outcome}`),
    );
    expect(settled).toEqual(["pi:failed", "dsh:installed"]);
    expect(b.installCalls).toEqual(["1.0.0"]);
  });
});
