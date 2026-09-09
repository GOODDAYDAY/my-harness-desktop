// 内核插件注册表测试 —— 注册/查/清单 + 完整性校验 + 重复注册 fail-fast。
//
// 依据 docs/design/kernel-plugin.md §3/§5/§12。测的是「注册模型」机制本身:核心不硬编码内核名,
// 内核经 register 进注册表。用中性别名(alpha/beta/gamma,非 pi/dsh/minimal)体现「任意内核注册」——
// 阶段五 KernelId 去字面量化后,这里的 `as KernelId` 断言自然消失。

import { describe, it, expect } from "vitest";
import { KernelRegistry, validateKernelPlugin } from "./kernel-registry";
import type { KernelPlugin, KernelId, KernelLogo, BaseBackend, SessionCatalog, KernelModelSource, KernelModelsApi, KernelConfigApi, KernelExtensionSource, KernelVersionApi } from "@my-harness-desktop/shared";

const LOGO: KernelLogo = { viewBox: "0 0 24 24", label: "x", paths: [] };

/** 中性别名 id → KernelId(阶段五去字面量化后,这个断言随 KernelId=string 自然消失)。 */
const kid = (s: string): KernelId => s as KernelId;

function makePlugin(id: string, overrides: Partial<KernelPlugin> = {}): KernelPlugin {
  return {
    id: kid(id),
    logo: LOGO,
    createBackend: () => ({} as BaseBackend),
    createCatalog: () => ({} as SessionCatalog),
    createModelSource: () => ({} as KernelModelSource),
    createModelsApi: () => ({} as KernelModelsApi),
    createConfigApi: () => ({} as KernelConfigApi),
    createExtensionSource: () => ({} as KernelExtensionSource),
    createVersionApi: () => ({} as KernelVersionApi),
    ...overrides,
  };
}

describe("KernelRegistry 注册模型", () => {
  it("注册 + 查 + 清单(all/ids)", () => {
    const r = new KernelRegistry();
    r.register(makePlugin("alpha"));
    r.register(makePlugin("beta"));
    expect(r.get(kid("alpha"))?.id).toBe("alpha");
    expect(r.get(kid("beta"))?.id).toBe("beta");
    expect(r.get(kid("gamma"))).toBeUndefined(); // 未注册 → undefined(显式降级)
    expect(r.has(kid("alpha"))).toBe(true);
    expect(r.has(kid("gamma"))).toBe(false);
    expect(r.ids()).toEqual(["alpha", "beta"]);
    expect(r.all().map((p) => p.id)).toEqual(["alpha", "beta"]);
  });

  it("重复注册同一 id → fail-fast", () => {
    const r = new KernelRegistry();
    r.register(makePlugin("alpha"));
    expect(() => r.register(makePlugin("alpha"))).toThrow(/重复注册/);
  });

  it("缺适配器 → 完整性校验 fail-fast(不静默降级)", () => {
    expect(() => validateKernelPlugin(makePlugin("alpha", { createCatalog: undefined } as Partial<KernelPlugin>))).toThrow(/缺适配器.*createCatalog/);
  });

  it("缺 id / 缺 logo → fail-fast", () => {
    expect(() => validateKernelPlugin(makePlugin("", {}))).toThrow(/缺 id/);
    expect(() => validateKernelPlugin(makePlugin("alpha", { logo: undefined } as Partial<KernelPlugin>))).toThrow(/缺 logo/);
  });

  it("seed 可缺面(文件态有、RPC 态无)——不视为缺适配器", () => {
    const r = new KernelRegistry();
    // RPC 内核(无预 seed)也能注册,seed 是可选方法。
    r.register(makePlugin("rpc-only", { seed: undefined }));
    expect(r.get(kid("rpc-only"))?.seed).toBeUndefined();
  });
});
