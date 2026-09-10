// 内核插件加载器测试(§kernel-plugin 物理插件) —— 扫描 + 卸载鲁棒性。
// 动态 require 真实编译产物 plugin.js 的验证见 kernel-registry-n.test.ts(从 out/main 加载)。
//
// 验证第 13 点「把插件卸载掉仍然没问题」的机制面:扫描只认有 plugin.json 的目录,
// 删 manifest = 卸载,scanKernelPlugins 不再返回它,壳据此缺面降级、照常启动。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanKernelPlugins, defaultEnabledEntries } from "./kernel-plugin-loader";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kernel-plugins-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeManifest(dir: string, id: string, order?: number, enabled?: boolean): void {
  mkdirSync(dir, { recursive: true });
  const manifest: Record<string, unknown> = { id, factory: "./plugin.js" };
  if (order !== undefined) manifest.order = order;
  if (enabled !== undefined) manifest.enabled = enabled;
  writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest));
}

describe("内核插件扫描 + 卸载鲁棒性", () => {
  it("扫描只认有 plugin.json 的目录(非插件目录跳过)", () => {
    makeManifest(join(root, "pi"), "pi", 1);
    makeManifest(join(root, "dsh"), "dsh", 2);
    makeManifest(join(root, "minimal"), "minimal", 3);
    mkdirSync(join(root, "not-a-plugin")); // 无 manifest 的目录,不是插件
    const entries = scanKernelPlugins(root);
    expect(entries.map((e) => e.manifest.id)).toEqual(["pi", "dsh", "minimal"]);
  });

  it("卸载(删 manifest)→ 不再列出 → 缺面降级", () => {
    makeManifest(join(root, "pi"), "pi", 1);
    makeManifest(join(root, "dsh"), "dsh", 2);
    makeManifest(join(root, "minimal"), "minimal", 3);
    // 卸载 dsh:删它的 manifest(模拟「卸载插件」)。
    rmSync(join(root, "dsh", "plugin.json"));
    const entries = scanKernelPlugins(root);
    expect(entries.map((e) => e.manifest.id)).toEqual(["pi", "minimal"]);
  });

  it("扫描根目录不存在 → 空清单(不抛,壳照常启动)", () => {
    expect(scanKernelPlugins(join(root, "missing"))).toEqual([]);
  });
});

describe("默认装载过滤(§目标 16:enabled=false 默认不装载)", () => {
  it("enabled=false 的内核默认被过滤,enabled 缺省视为 true", () => {
    makeManifest(join(root, "pi"), "pi", 1);
    makeManifest(join(root, "dsh"), "dsh", 2);
    makeManifest(join(root, "minimal"), "minimal", 3, false); // minimal 默认 off
    const entries = scanKernelPlugins(root);
    // 扫描 = 存在性:三个都在。
    expect(entries.map((e) => e.manifest.id)).toEqual(["pi", "dsh", "minimal"]);
    // 装载 = 默认开关:minimal 被过滤。
    expect(defaultEnabledEntries(entries).map((e) => e.manifest.id)).toEqual(["pi", "dsh"]);
  });

  it("forceEnable 强制启用被声明为 off 的内核(MHD_ENABLE_KERNELS 语义)", () => {
    makeManifest(join(root, "pi"), "pi", 1);
    makeManifest(join(root, "minimal"), "minimal", 3, false);
    const entries = scanKernelPlugins(root);
    expect(defaultEnabledEntries(entries, new Set(["minimal"])).map((e) => e.manifest.id)).toEqual(["pi", "minimal"]);
  });

  it("卸载与默认开关正交:删 manifest 后 forceEnable 也找不到(缺面)", () => {
    makeManifest(join(root, "pi"), "pi", 1);
    makeManifest(join(root, "minimal"), "minimal", 3, false);
    rmSync(join(root, "minimal", "plugin.json"));
    const entries = scanKernelPlugins(root);
    expect(defaultEnabledEntries(entries, new Set(["minimal"])).map((e) => e.manifest.id)).toEqual(["pi"]);
  });
});
