// minimal 内核插件工厂测试(§kernel-plugin §4) —— 验证 minimalKernelPlugin 产出完整插件,
// 各 create 方法真实可用(createBackend 真实 spawn CLI,非 mock)。这是「内核插件化」的第一个
// 实证:一个内核的完整适配器集合经一份 KernelPlugin 工厂暴露,核心经注册表查插件即可用。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { minimalKernelPlugin } from "./plugin";
import { validateKernelPlugin } from "../core/kernel-registry";
import { makeRealCtx } from "../core/kernel-test-ctx";

let homedir: string;
let cwd: string;

beforeEach(() => {
  homedir = mkdtempSync(join(tmpdir(), "minimal-plugin-homedir-"));
  cwd = mkdtempSync(join(tmpdir(), "minimal-plugin-cwd-"));
});

afterEach(() => {
  rmSync(homedir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("minimalKernelPlugin 工厂", () => {
  it("工厂产出完整插件,各 create 方法真实可用(真 CLI)", async () => {
    const { ctx } = makeRealCtx(homedir, cwd);
    const plugin = minimalKernelPlugin(ctx);

    // 完整性:不缺适配器。
    expect(plugin.id).toBe("minimal");
    expect(() => validateKernelPlugin(plugin)).not.toThrow();

    // createCatalog:per-kernel 目录面,kernel 标正确。
    const catalog = plugin.createCatalog();
    expect(catalog.kernel).toBe("minimal");

    // createBackend:真实 spawn minimal CLI,backend.kernel = minimal。
    const backend = plugin.createBackend({ cwd, agentDir: "ignored", kernel: "minimal", neutralSessionId: "ns-plug", lineageId: "ns-plug" });
    expect(backend.kernel).toBe("minimal");
    await backend.start();
    expect(backend.alive).toBe(true);
    await backend.stop();
    expect(backend.alive).toBe(false);

    // createModelSource:无配置回落 echo 占位模型。
    const modelSource = plugin.createModelSource();
    expect(modelSource.listModels()).toEqual([{ kernel: "minimal", provider: "minimal", id: "echo", name: "Minimal Echo" }]);

    // createModelsApi / createConfigApi / createExtensionSource 可实例化。
    expect(plugin.createModelsApi()).toBeTruthy();
    expect(plugin.createConfigApi()).toBeTruthy();
    expect(plugin.createExtensionSource()).toBeTruthy();

    // createVersionApi:内置内核诚实桩(不装不升不降)。
    const versionApi = plugin.createVersionApi();
    expect((await versionApi.status()).currentVersion).toBe("built-in");
    expect((await versionApi.listVersions()).versions).toEqual([]);
  });
});
