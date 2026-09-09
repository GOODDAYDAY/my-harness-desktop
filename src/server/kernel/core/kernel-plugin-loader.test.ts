// 内核插件加载器测试(§kernel-plugin 物理插件) —— 扫描 + 卸载鲁棒性。
// 动态 require 真实编译产物 plugin.js 的验证见 kernel-registry-n.test.ts(从 out/main 加载)。
//
// 验证第 13 点「把插件卸载掉仍然没问题」的机制面:扫描只认有 plugin.json 的目录,
// 删 manifest = 卸载,scanKernelPlugins 不再返回它,壳据此缺面降级、照常启动。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanKernelPlugins } from "./kernel-plugin-loader";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kernel-plugins-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeManifest(dir: string, id: string, order?: number): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.json"), JSON.stringify(order === undefined ? { id, factory: "./plugin.js" } : { id, factory: "./plugin.js", order }));
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
