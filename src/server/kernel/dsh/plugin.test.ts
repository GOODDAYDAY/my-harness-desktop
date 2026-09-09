// dsh 内核插件工厂测试(§kernel-plugin §4) —— 验证 dshKernelPlugin 产出完整插件,各 create 方法
// 可实例化(ensure* 初始化写临时 homedir 的 cordis.yml,不碰真实 ~/.dsh;dsh CLI 真实 spawn 由
// session-store.dsh.integration 覆盖)。这是「内核插件化」第三个实证:dsh(带 ensure* + 迁移)也能塞进契约。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dshKernelPlugin } from "./plugin";
import { validateKernelPlugin } from "../core/kernel-registry";
import { initKernelRuntime } from "../core/kernel-manager";
import { createNpmKernelRuntime } from "../../client/npm/kernel-runtime";
import { makeRealCtx } from "../core/kernel-test-ctx";

let homedir: string;
let cwd: string;

beforeEach(() => {
  homedir = mkdtempSync(join(tmpdir(), "dsh-plugin-homedir-"));
  cwd = mkdtempSync(join(tmpdir(), "dsh-plugin-cwd-"));
  // 真实 KernelRuntime(npm install/fetch registry 的真实实现;status 读本地不碰网络)。
  initKernelRuntime(createNpmKernelRuntime());
});

afterEach(() => {
  rmSync(homedir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("dshKernelPlugin 工厂", () => {
  it("工厂产出完整插件,各 create 方法可实例化(不真实 spawn)", async () => {
    const { ctx } = makeRealCtx(homedir, cwd);
    const plugin = dshKernelPlugin(ctx);

    expect(plugin.id).toBe("dsh");
    expect(() => validateKernelPlugin(plugin)).not.toThrow();

    const catalog = plugin.createCatalog();
    expect(catalog.kernel).toBe("dsh");

    expect(plugin.createModelSource()).toBeTruthy();
    expect(plugin.createModelsApi()).toBeTruthy();
    expect(plugin.createConfigApi()).toBeTruthy();
    expect(plugin.createExtensionSource()).toBeTruthy();

    const versionApi = plugin.createVersionApi();
    const status = await versionApi.status();
    expect(typeof status.available).toBe("boolean");
    expect(status.available).toBe(false); // 临时 homedir 未安装 dsh → 未安装
  });

  it("seed 是 RPC 语义(返回 null,无预 seed)", async () => {
    const { ctx } = makeRealCtx(homedir, cwd);
    const plugin = dshKernelPlugin(ctx);
    expect(plugin.seed).toBeDefined();
    expect(await plugin.seed!([], { neutralSessionId: "ns", lineageId: "ns", header: { kernel: "dsh", cwd: "/p", createdAt: "now" }, kernel: "dsh", cwd: "/p", agentDir: "/a" })).toBeNull();
  });
});
