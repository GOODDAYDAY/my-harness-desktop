// N 内核注册验收测试(§kernel-plugin §12) —— 用真实内核插件工厂 + 真实 ctx(真实 JsonPrefsStore
// 文件 + 真实状态标记/刷新计数)+ 真实 KernelRuntime(createNpmKernelRuntime,不 mock),验证注册模型的
// 适配性/可用性/鲁棒性:单内核注册、任意双内核注册、三内核注册 + 真实卸载(真实 manifest + 扫描 + 删 manifest)。
// 不调 listVersions(fetch registry 是远程交互,纯本地不碰;status 读本地 installDir 不碰网络)。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KernelRegistry, validateKernelPlugin } from "./kernel-registry";
import { initKernelRuntime } from "./kernel-manager";
import { createNpmKernelRuntime } from "../../client/npm/kernel-runtime";
import { scanKernelPlugins, loadKernelPlugin } from "./kernel-plugin-loader";
import { minimalKernelPlugin } from "../minimal/plugin";
import { piKernelPlugin } from "../pi/plugin";
import { dshKernelPlugin } from "../dsh/plugin";
import { makeRealCtx } from "./kernel-test-ctx";

let homedir: string;
let cwd: string;

beforeEach(() => {
  homedir = mkdtempSync(join(tmpdir(), "kernel-registry-n-"));
  cwd = mkdtempSync(join(tmpdir(), "kernel-registry-cwd-"));
  // 真实 KernelRuntime(npm install/fetch registry 的真实实现;测试只走 status 读本地路径,不 fetch registry)。
  initKernelRuntime(createNpmKernelRuntime());
});

afterEach(() => {
  rmSync(homedir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("N 内核注册验收(真实插件工厂 + 真实 ctx)", () => {
  it("单内核注册:只注册 minimal,适配完整 + 真 CLI 可用 + 未注册内核显式降级", async () => {
    const r = new KernelRegistry();
    r.register(minimalKernelPlugin(makeRealCtx(homedir, cwd).ctx));

    expect(() => validateKernelPlugin(r.get("minimal")!)).not.toThrow();
    expect(r.ids()).toEqual(["minimal"]);
    // 真实 spawn minimal CLI(非 mock)。
    const backend = r.get("minimal")!.createBackend({ cwd, agentDir: join(homedir, ".minimal"), kernel: "minimal", neutralSessionId: "ns" });
    expect(backend.kernel).toBe("minimal");
    await backend.start();
    expect(backend.alive).toBe(true);
    await backend.stop();
    // 未注册内核显式降级。
    expect(r.get("pi")).toBeUndefined();
    expect(r.get("dsh")).toBeUndefined();
  });

  it("任意双内核注册:pi + minimal 共存,各查各的适配器", () => {
    const r = new KernelRegistry();
    r.register(piKernelPlugin(makeRealCtx(homedir, cwd).ctx));
    r.register(minimalKernelPlugin(makeRealCtx(homedir, cwd).ctx));
    expect(r.ids()).toEqual(["pi", "minimal"]);
    expect(r.get("pi")!.createCatalog().kernel).toBe("pi");
    expect(r.get("minimal")!.createCatalog().kernel).toBe("minimal");
  });

  it("任意双内核注册:dsh + minimal 共存(非 pi 组合)", () => {
    const r = new KernelRegistry();
    r.register(dshKernelPlugin(makeRealCtx(homedir, cwd).ctx));
    r.register(minimalKernelPlugin(makeRealCtx(homedir, cwd).ctx));
    expect(r.ids()).toEqual(["dsh", "minimal"]);
    expect(r.get("dsh")!.createCatalog().kernel).toBe("dsh");
    expect(r.get("minimal")!.createCatalog().kernel).toBe("minimal");
  });

  it("三内核注册:pi + dsh + minimal 全量,清单顺序 = 注册顺序", () => {
    const r = new KernelRegistry();
    r.register(piKernelPlugin(makeRealCtx(homedir, cwd).ctx));
    r.register(dshKernelPlugin(makeRealCtx(homedir, cwd).ctx));
    r.register(minimalKernelPlugin(makeRealCtx(homedir, cwd).ctx));
    expect(r.ids()).toEqual(["pi", "dsh", "minimal"]);
    for (const id of r.ids()) {
      expect(() => validateKernelPlugin(r.get(id)!)).not.toThrow();
      expect(r.get(id)!.createVersionApi()).toBeTruthy();
    }
  });

  it("鲁棒性:注册缺适配器的插件 → fail-fast", () => {
    const r = new KernelRegistry();
    const broken = minimalKernelPlugin(makeRealCtx(homedir, cwd).ctx);
    (broken as unknown as { createCatalog: unknown }).createCatalog = undefined;
    expect(() => r.register(broken)).toThrow(/缺适配器.*createCatalog/);
  });
});

describe("真实编译产物加载 + 真实卸载", () => {
  it("从 out/main 扫描真实 plugin.js + 注册真实内核 + 删 manifest → 缺面 → 恢复", async () => {
    // 真实编译产物目录(out/main/server/kernel/*/plugin.js 由 rollup 独立打包 + plugin.json)。
    const pluginRoot = join(process.cwd(), "out", "main", "server", "kernel");
    const before = scanKernelPlugins(pluginRoot);
    expect(before.map((e) => e.manifest.id)).toEqual(["pi", "dsh", "minimal"]);

    // 真实 loadKernelPlugin(require 真实编译产物 plugin.js,含其 chunks 依赖)。
    const registry = new KernelRegistry();
    for (const { dir, manifest } of before) {
      loadKernelPlugin(registry, dir, manifest, makeRealCtx(homedir, cwd).ctx);
    }
    expect(registry.ids()).toEqual(["pi", "dsh", "minimal"]);

    // 真实 minimal 内核:真实 spawn CLI(非 mock)。
    const backend = registry.get("minimal")!.createBackend({ cwd, agentDir: join(homedir, ".minimal"), kernel: "minimal", neutralSessionId: "ns" });
    await backend.start();
    expect(backend.alive).toBe(true);
    await backend.stop();

    // 真实卸载:rename minimal 的 manifest(等价删),重新扫描缺面,壳照常。
    const minimalManifest = join(pluginRoot, "minimal", "plugin.json");
    renameSync(minimalManifest, minimalManifest + ".bak");
    try {
      expect(scanKernelPlugins(pluginRoot).map((e) => e.manifest.id)).toEqual(["pi", "dsh"]);
    } finally {
      renameSync(minimalManifest + ".bak", minimalManifest); // 恢复,不影响后续 build/e2e
    }
    expect(scanKernelPlugins(pluginRoot).map((e) => e.manifest.id)).toEqual(["pi", "dsh", "minimal"]);
  });
});
