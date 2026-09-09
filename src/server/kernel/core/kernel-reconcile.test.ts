// reconcileMissingKernels 单测:冷启动对账的「扫缺 → 判缺 → 补装」三步 + 失败不崩。
// 用假 KernelManager,不起真进程、不碰 npm。
import { describe, it, expect } from "vitest";
import { reconcileMissingKernels } from "./kernel-reconcile";
import type { KernelVersionApi } from "@my-harness-desktop/shared";

interface VersionApiStub {
  versionApi: KernelVersionApi;
  installCalls: string[];
}

function makeVersionApi(opts: {
  available?: boolean;
  latest?: string | null;
  installOk?: boolean;
  installThrow?: Error;
} = {}): VersionApiStub {
  const installCalls: string[] = [];
  const versionApi = {
    status: async () => ({
      currentVersion: opts.available ? "1.0.0" : null,
      installedVersion: null,
      available: opts.available ?? false,
      source: "installed",
      customCliDir: "",
      error: null,
    }),
    setCustomCliDir: async () => ({ ok: false, error: null, pendingCount: 0, status: null }),
    listVersions: async () => ({ versions: ["1.0.0"], latest: opts.latest === undefined ? "1.0.0" : opts.latest }),
    install: async (version: string, _onProgress: unknown, _onDone: unknown) => {
      if (opts.installThrow) throw opts.installThrow;
      installCalls.push(version);
      return { ok: opts.installOk ?? true, error: null };
    },
  } as KernelVersionApi;
  return { versionApi, installCalls };
}

describe("reconcileMissingKernels", () => {
  it("已装内核跳过(already),不触发 install", async () => {
    const { versionApi, installCalls } = makeVersionApi({ available: true });
    const settled: string[] = [];
    await reconcileMissingKernels(
      [{ kernel: "pi", versionApi }],
      () => {},
      (r) => settled.push(`${r.kernel}:${r.outcome}`),
    );
    expect(settled).toEqual(["pi:already"]);
    expect(installCalls).toEqual([]);
  });

  it("缺失内核按 dist-tag latest 自动补装(installed)", async () => {
    const { versionApi, installCalls } = makeVersionApi({ latest: "0.1.1-rc.2" });
    const settled: string[] = [];
    await reconcileMissingKernels(
      [{ kernel: "dsh", versionApi }],
      () => {},
      (r) => settled.push(`${r.kernel}:${r.outcome}`),
    );
    expect(settled).toEqual(["dsh:installed"]);
    expect(installCalls).toEqual(["0.1.1-rc.2"]);
  });

  it("registry 无 dist-tag 版本 → failed,不抛", async () => {
    const { versionApi, installCalls } = makeVersionApi({ latest: null });
    const settled: string[] = [];
    await reconcileMissingKernels(
      [{ kernel: "pi", versionApi }],
      () => {},
      (r) => settled.push(`${r.kernel}:${r.outcome}`),
    );
    expect(settled).toEqual(["pi:failed"]);
    expect(installCalls).toEqual([]);
  });

  it("install 抛错 → failed,继续下一个内核(串行不崩)", async () => {
    const a = makeVersionApi({ installThrow: new Error("npm boom") });
    const b = makeVersionApi({ installOk: true });
    const settled: string[] = [];
    await reconcileMissingKernels(
      [
        { kernel: "pi", versionApi: a.versionApi },
        { kernel: "dsh", versionApi: b.versionApi },
      ],
      () => {},
      (r) => settled.push(`${r.kernel}:${r.outcome}`),
    );
    expect(settled).toEqual(["pi:failed", "dsh:installed"]);
    expect(b.installCalls).toEqual(["1.0.0"]);
  });
});
