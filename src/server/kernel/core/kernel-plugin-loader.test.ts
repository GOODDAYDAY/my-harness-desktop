// 内核插件加载器测试(§kernel-plugin 物理插件) —— 扫描 + 卸载鲁棒性。
// 动态 require 真实编译产物 plugin.js 的验证见 kernel-registry-n.test.ts(从真实插件目录加载)。
//
// 验证第 13 点「把插件卸载掉仍然没问题」的机制面。**扫描面变了**（勿按旧形状读）：
// 「一个内核 = 一个插件」之后，内核面写在**宿主壳插件自己的 manifest** 的 `kernel` 块里，
// 加载器扫的就是壳插件根目录（`<域>/<插件>/plugin.json`，递归深度 3，命中即止）。
// 于是：删掉这个插件的 plugin.json = 卸载，内核与其 desktop 对接面一起消失。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanKernelPlugins, defaultEnabledEntries, resolveKernelFactoryPath } from "./kernel-plugin-loader";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kernel-plugins-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 写一个**宿主壳插件** manifest（内核面写在 kernel 块里，id 由宿主 id 单源提供）。 */
function makePlugin(dir: string, id: string, kernel?: { order?: number; enabled?: boolean } | null): void {
  mkdirSync(dir, { recursive: true });
  const manifest: Record<string, unknown> = { id, version: "0.1.0", contributes: {} };
  if (kernel !== null) manifest.kernel = kernel ?? {};
  writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest));
}

describe("内核插件扫描 + 卸载鲁棒性", () => {
  it("只收 manifest 带 kernel 块的插件（普通壳插件不算内核插件）", () => {
    makePlugin(join(root, "kernels", "pi"), "pi", { order: 1 });
    makePlugin(join(root, "kernels", "dsh"), "dsh", { order: 2 });
    makePlugin(join(root, "kernels", "minimal"), "minimal", { order: 3, enabled: false });
    makePlugin(join(root, "sessions", "timeline"), "timeline", null); // 普通壳插件
    mkdirSync(join(root, "locales")); // 无 manifest 的目录
    const entries = scanKernelPlugins(root);
    expect(entries.map((e) => e.manifest.id)).toEqual(["pi", "dsh", "minimal"]);
    // 宿主目录就是内核插件目录本身（内核面与对接面同处一地）。
    expect(entries[0].dir).toBe(join(root, "kernels", "pi"));
  });

  it("内核 id 单源：取宿主 manifest 的 id，kernel 块里写 id 也不生效", () => {
    makePlugin(join(root, "kernels", "pi"), "pi", { order: 1 });
    const raw = JSON.parse(JSON.stringify({ id: "pi", kernel: { order: 1, id: "not-pi" } }));
    writeFileSync(join(root, "kernels", "pi", "plugin.json"), JSON.stringify(raw));
    expect(scanKernelPlugins(root)[0].manifest.id).toBe("pi");
  });

  it("卸载(删 manifest)→ 不再列出 → 缺面降级", () => {
    makePlugin(join(root, "pi"), "pi", { order: 1 });
    makePlugin(join(root, "dsh"), "dsh", { order: 2 });
    makePlugin(join(root, "minimal"), "minimal", { order: 3 });
    rmSync(join(root, "dsh", "plugin.json"));
    expect(scanKernelPlugins(root).map((e) => e.manifest.id)).toEqual(["pi", "minimal"]);
  });

  it("扫描根目录不存在 → 空清单(不抛,壳照常启动)", () => {
    expect(scanKernelPlugins(join(root, "missing"))).toEqual([]);
  });

  it("manifest JSON 损坏 → 跳过该插件(不炸整次扫描)", () => {
    makePlugin(join(root, "pi"), "pi", { order: 1 });
    mkdirSync(join(root, "broken"), { recursive: true });
    writeFileSync(join(root, "broken", "plugin.json"), "{ 不是 JSON");
    expect(scanKernelPlugins(root).map((e) => e.manifest.id)).toEqual(["pi"]);
  });
});

describe("默认装载过滤(§目标 16:kernel.enabled=false 默认不装载)", () => {
  it("enabled=false 的内核默认被过滤,enabled 缺省视为 true", () => {
    makePlugin(join(root, "pi"), "pi", { order: 1 });
    makePlugin(join(root, "dsh"), "dsh", { order: 2 });
    makePlugin(join(root, "minimal"), "minimal", { order: 3, enabled: false });
    const entries = scanKernelPlugins(root);
    expect(entries.map((e) => e.manifest.id)).toEqual(["pi", "dsh", "minimal"]);
    expect(defaultEnabledEntries(entries).map((e) => e.manifest.id)).toEqual(["pi", "dsh"]);
  });

  it("forceEnable 强制启用被声明为 off 的内核(MHD_ENABLE_KERNELS 语义)", () => {
    makePlugin(join(root, "pi"), "pi", { order: 1 });
    makePlugin(join(root, "minimal"), "minimal", { order: 3, enabled: false });
    const entries = scanKernelPlugins(root);
    expect(defaultEnabledEntries(entries, new Set(["minimal"])).map((e) => e.manifest.id)).toEqual(["pi", "minimal"]);
  });

  it("卸载与默认开关正交:删 manifest 后 forceEnable 也找不到(缺面)", () => {
    makePlugin(join(root, "pi"), "pi", { order: 1 });
    makePlugin(join(root, "minimal"), "minimal", { order: 3, enabled: false });
    rmSync(join(root, "minimal", "plugin.json"));
    const entries = scanKernelPlugins(root);
    expect(defaultEnabledEntries(entries, new Set(["minimal"])).map((e) => e.manifest.id)).toEqual(["pi"]);
  });
});

describe("工厂模块定位(约定优先,显式可覆盖)", () => {
  const BUILD_ROOT = "/build/root";

  it("缺省按构建根约定:<构建根>/<id>/plugin.js", () => {
    makePlugin(join(root, "kernels", "pi"), "pi", { order: 1 });
    const entry = scanKernelPlugins(root)[0];
    expect(resolveKernelFactoryPath(entry, BUILD_ROOT)).toBe(join(BUILD_ROOT, "pi", "plugin.js"));
  });

  it("显式 factory(不经构建的第三方内核):相对宿主插件目录解析", () => {
    makePlugin(join(root, "kernels", "kimi"), "kimi", { order: 9 });
    const entry = scanKernelPlugins(root)[0];
    entry.manifest.factory = "./plugin.js";
    expect(resolveKernelFactoryPath(entry, BUILD_ROOT)).toBe(join(root, "kernels", "kimi", "plugin.js"));
  });
});
