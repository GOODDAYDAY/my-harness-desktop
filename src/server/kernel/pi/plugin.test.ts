// pi 内核插件工厂测试(§kernel-plugin §4) —— 验证 piKernelPlugin 产出完整插件,各 create 方法
// 可实例化(管理面不真实 spawn、不碰网络;pi CLI 的真实 spawn 由 session-store.test 的 FakeAdapter 覆盖)。
// 这是「内核插件化」第二个实证:pi(带 manager/model/extension 多块依赖)也能塞进一份 KernelPlugin 契约。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piKernelPlugin } from "./plugin";
import { validateKernelPlugin } from "../core/kernel-registry";
import { initKernelRuntime } from "../core/kernel-manager";
import { createNpmKernelRuntime } from "../../client/npm/kernel-runtime";
import { makeRealCtx } from "../core/kernel-test-ctx";

let homedir: string;
let cwd: string;

beforeEach(() => {
  homedir = mkdtempSync(join(tmpdir(), "pi-plugin-homedir-"));
  cwd = mkdtempSync(join(tmpdir(), "pi-plugin-cwd-"));
  // 真实 KernelRuntime(npm install/fetch registry 的真实实现;status 读本地不碰网络)。
  initKernelRuntime(createNpmKernelRuntime());
});

afterEach(() => {
  rmSync(homedir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("piKernelPlugin 工厂", () => {
  it("工厂产出完整插件,各 create 方法可实例化(不真实 spawn)", async () => {
    const { ctx } = makeRealCtx(homedir, cwd);
    const plugin = piKernelPlugin(ctx);

    expect(plugin.id).toBe("pi");
    expect(() => validateKernelPlugin(plugin)).not.toThrow();

    // 目录面:kernel 标正确。
    const catalog = plugin.createCatalog();
    expect(catalog.kernel).toBe("pi");

    // 管理面五槽位均可实例化(读不到文件回落空,不炸)。
    expect(plugin.createModelSource()).toBeTruthy();
    expect(plugin.createModelsApi()).toBeTruthy();
    expect(plugin.createConfigApi()).toBeTruthy();
    expect(plugin.createExtensionSource()).toBeTruthy();

    // 版本面:未安装目录回落「未安装」状态,available 是 boolean(真实 status 读本地,不 fetch registry)。
    const versionApi = plugin.createVersionApi();
    const status = await versionApi.status();
    expect(typeof status.available).toBe("boolean");
    expect(status.available).toBe(false); // 临时 homedir 未安装 pi → 未安装
  });
});
