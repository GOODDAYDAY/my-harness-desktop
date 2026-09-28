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
    r.register(makePlugin("alpha"), "1.0.0");
    r.register(makePlugin("beta"), "1.0.0");
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
    r.register(makePlugin("alpha"), "1.0.0");
    expect(() => r.register(makePlugin("alpha"), "1.0.0")).toThrow(/重复注册/);
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
    r.register(makePlugin("rpc-only", { seed: undefined }), "1.0.0");
    expect(r.get(kid("rpc-only"))?.seed).toBeUndefined();
  });

  // ---- versionOf / unregister：差量重载（boot-surface.md §3.6.1–§3.6.2）的地基 ----
  //
  // 为什么单立一组：这两条不是"顺手补的 API"，而是让「改了内核插件后点重载能生效」成为可能的
  // 唯一前提。差量判据是 **(id, version)**——只比 id 的话，改动过的内核会落进"两边都有 → 不动"
  // 分支，工厂不重跑，用户看到的还是旧行为且**没有任何报错**。而 version 的"旧值"只能从注册表取
  // （`KernelPlugin` 契约里没有 version 面），所以注册表必须存条目而不是裸插件。

  it("versionOf 返回注册时给的版本；未注册返回 undefined（不猜默认值）", () => {
    const r = new KernelRegistry();
    r.register(makePlugin("alpha"), "0.9.0");
    r.register(makePlugin("beta"), "0.1.0");
    expect(r.versionOf(kid("alpha"))).toBe("0.9.0");
    expect(r.versionOf(kid("beta"))).toBe("0.1.0");
    expect(r.versionOf(kid("gamma")), "未注册的内核不该编一个版本出来").toBeUndefined();
  });

  it("unregister 后所有投影面一致消失（get/has/all/ids/versionOf）", () => {
    const r = new KernelRegistry();
    r.register(makePlugin("alpha"), "1.0.0");
    r.register(makePlugin("beta"), "1.0.0");
    r.unregister(kid("alpha"));
    expect(r.get(kid("alpha"))).toBeUndefined();
    expect(r.has(kid("alpha"))).toBe(false);
    expect(r.versionOf(kid("alpha"))).toBeUndefined();
    expect(r.ids()).toEqual([kid("beta")]);
    expect(r.all().map((p) => p.id)).toEqual([kid("beta")]);
    // 其它条目不受影响（撤销一个不能牵连别的——§6.3 检验⑥「内核目录自包含」的同款要求）
    expect(r.get(kid("beta"))?.id).toBe("beta");
    expect(r.versionOf(kid("beta"))).toBe("1.0.0");
  });

  it("unregister 幂等：撤一个不存在的 id 是 no-op，不抛", () => {
    const r = new KernelRegistry();
    r.register(makePlugin("alpha"), "1.0.0");
    expect(() => r.unregister(kid("gamma"))).not.toThrow();   // 从没注册过
    expect(() => r.unregister(kid("alpha"))).not.toThrow();
    expect(() => r.unregister(kid("alpha"))).not.toThrow();   // 再撤一次
    expect(r.ids()).toEqual([]);
  });

  it("撤销后可以用**不同 version** 重新注册（重载路径依赖这条）", () => {
    const r = new KernelRegistry();
    const first = makePlugin("alpha");
    r.register(first, "1.0.0");
    r.unregister(kid("alpha"));
    const second = makePlugin("alpha");           // 工厂重跑 = 新的插件实例
    r.register(second, "1.1.0");
    expect(r.versionOf(kid("alpha"))).toBe("1.1.0");
    expect(r.get(kid("alpha"))).toBe(second);     // 是新实例，不是旧的
    expect(r.get(kid("alpha"))).not.toBe(first);
  });

  it("不先撤销就重复注册仍然 fail-fast（version 不同也不放行）", () => {
    // 差量重载的"同 id 异 version"分支必须先 unregister 再 register；
    // 直接 register 撞重复注册错误是**有意的**——它逼调用方显式表达"我在替换"，
    // 而不是让注册表悄悄用新实例覆盖旧的（覆盖会让持有旧引用的消费者静默 stale）。
    const r = new KernelRegistry();
    r.register(makePlugin("alpha"), "1.0.0");
    expect(() => r.register(makePlugin("alpha"), "1.1.0")).toThrow(/重复注册/);
    expect(r.versionOf(kid("alpha")), "抛错后原条目不能被破坏").toBe("1.0.0");
  });

  it("校验失败时不留下半个条目（version 也不该被记住）", () => {
    const r = new KernelRegistry();
    const broken = { ...makePlugin("alpha"), createCatalog: undefined } as unknown as KernelPlugin;
    expect(() => r.register(broken, "1.0.0")).toThrow(/缺适配器/);
    expect(r.has(kid("alpha"))).toBe(false);
    expect(r.versionOf(kid("alpha"))).toBeUndefined();
  });
});
