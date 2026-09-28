// 活访问器测试（boot-surface.md §3.6.3）。
//
// 这里守的不是"能取到值"（那太弱），而是三条**容易被改坏的语义**：
//   ① 访问器是**活的**——注册表变了，下一次调用就读到新值（这正是它替代快照字段的全部理由）；
//   ② 实例是**稳定的**——同一个 (kind,id) 反复调用返回同一个对象（缓存的目的，不是性能）；
//   ③ `bump()` 是**必需的失效动作**——不 bump 就会拿到由旧插件实例造出来的缓存对象，
//     重载看起来成功了、实际全在用旧实现。这条要**正向证明它会 stale**，
//     否则将来有人"优化"掉 bump 调用，测试仍然全绿。
// 另有一条独立语义：logo 走 last-known 表（内核卸载后正在跑的会话不该丢图标）。

import { describe, it, expect, beforeEach } from "vitest";
import { KernelRegistry } from "../../kernel/core/kernel-registry";
import { liveKernelAccessors } from "./kernel-accessors";
import type {
  BaseBackend,
  KernelConfigApi,
  KernelExtensionSource,
  KernelId,
  KernelLogo,
  KernelModelSource,
  KernelModelsApi,
  KernelPlugin,
  SessionCatalog,
  KernelVersionApi,
} from "@my-harness-desktop/shared";

const kid = (s: string): KernelId => s as KernelId;

/** 每次调用工厂都返回**新对象**，这样才能观测"缓存是否命中"与"bump 是否生效"。 */
function makePlugin(id: string, opts: { logo?: KernelLogo; oneshot?: boolean; configRoot?: string } = {}): KernelPlugin {
  const tag = `${id}@${Math.random().toString(36).slice(2, 7)}`;
  return {
    id: kid(id),
    logo: opts.logo ?? { viewBox: "0 0 24 24", label: id, paths: [] },
    createBackend: () => ({ tag } as unknown as BaseBackend),
    createCatalog: () => ({ tag } as unknown as SessionCatalog),
    createModelSource: () => ({ tag } as unknown as KernelModelSource),
    createModelsApi: () => ({ tag } as unknown as KernelModelsApi),
    createConfigApi: () => ({ tag } as unknown as KernelConfigApi),
    createExtensionSource: () => ({ tag } as unknown as KernelExtensionSource),
    createVersionApi: () => ({ tag } as unknown as KernelVersionApi),
    ...(opts.oneshot ? { createOneshot: () => (async () => tag) as (p: string, c?: string) => Promise<string> } : {}),
    ...(opts.configRoot ? { configRoot: () => opts.configRoot as string } : {}),
  };
}

describe("liveKernelAccessors：注册表派生面的活访问器", () => {
  let registry: KernelRegistry;

  beforeEach(() => {
    registry = new KernelRegistry();
  });

  it("① 是活的：访问器造好之后再注册的内核，下一次调用就能读到", () => {
    // 这条是整个方案的理由——快照字段做不到（构造期就定死了）。
    const a = liveKernelAccessors(registry);
    expect(a.kernelIds()).toEqual([]);
    expect(a.kernelModels(kid("alpha"))).toBeUndefined();
    registry.register(makePlugin("alpha"), "1.0.0");
    expect(a.kernelIds(), "注册后不必 bump 就该看到（ids 不过缓存）").toEqual([kid("alpha")]);
    expect(a.kernelModels(kid("alpha")), "per-id 访问器现读注册表").toBeDefined();
  });

  it("② 实例稳定：同一 (kind,id) 反复调用返回同一个对象", () => {
    registry.register(makePlugin("alpha"), "1.0.0");
    const a = liveKernelAccessors(registry);
    expect(a.kernelModels(kid("alpha"))).toBe(a.kernelModels(kid("alpha")));
    expect(a.kernelConfig(kid("alpha"))).toBe(a.kernelConfig(kid("alpha")));
    expect(a.kernelExtensionSource(kid("alpha"))).toBe(a.kernelExtensionSource(kid("alpha")));
    // 不同 kind 之间不该串（key 是 `${kind}:${id}`）
    expect(a.kernelModels(kid("alpha"))).not.toBe(a.kernelConfig(kid("alpha")));
  });

  it("③ bump() 作废缓存：unregister → register → bump 之后拿到的是新实例", () => {
    const first = makePlugin("alpha");
    registry.register(first, "1.0.0");
    const a = liveKernelAccessors(registry);
    const before = a.kernelModels(kid("alpha"));
    registry.unregister(kid("alpha"));
    registry.register(makePlugin("alpha"), "1.1.0");
    a.bump();
    const after = a.kernelModels(kid("alpha"));
    expect(after).toBeDefined();
    expect(after, "bump 之后必须是新工厂造的实例").not.toBe(before);
  });

  it("③' 反向证明：**不 bump 就会 stale**（这条防止有人把 bump 调用当冗余优化掉）", () => {
    const first = makePlugin("alpha");
    registry.register(first, "1.0.0");
    const a = liveKernelAccessors(registry);
    const before = a.kernelModels(kid("alpha"));
    registry.unregister(kid("alpha"));
    registry.register(makePlugin("alpha"), "1.1.0");
    // 故意不 bump
    expect(a.kernelModels(kid("alpha")), "不 bump 时缓存仍在，返回旧实例——重载会静默无效").toBe(before);
    expect(registry.versionOf(kid("alpha")), "注册表侧已经是新版本了（说明 stale 只在访问器缓存里）").toBe("1.1.0");
  });

  it("未注册的 id：per-id 访问器一律 undefined（显式缺面，不伪造、不抛）", () => {
    const a = liveKernelAccessors(registry);
    expect(a.kernelModels(kid("ghost"))).toBeUndefined();
    expect(a.kernelConfig(kid("ghost"))).toBeUndefined();
    expect(a.kernelVersionApi(kid("ghost"))).toBeUndefined();
    expect(a.kernelOneshot(kid("ghost"))).toBeUndefined();
    expect(a.kernelExtensionSource(kid("ghost"))).toBeUndefined();
  });

  it("可选面缺失（createOneshot 没有）→ undefined，且不反复调工厂", () => {
    registry.register(makePlugin("alpha", { oneshot: false }), "1.0.0");
    const a = liveKernelAccessors(registry);
    expect(a.kernelOneshot(kid("alpha"))).toBeUndefined();
    expect(a.kernelOneshot(kid("alpha"))).toBeUndefined();   // 缓存里存的就是 undefined
    registry.unregister(kid("alpha"));
    registry.register(makePlugin("alpha", { oneshot: true }), "1.1.0");
    a.bump();
    expect(typeof a.kernelOneshot(kid("alpha"))).toBe("function");
  });

  it("kernelConfigRoots 只收**声明了 configRoot 的**内核（缺面被过滤，不塞 undefined）", () => {
    registry.register(makePlugin("alpha", { configRoot: "/tmp/alpha" }), "1.0.0");
    registry.register(makePlugin("beta"), "1.0.0");            // 无 configRoot
    registry.register(makePlugin("gamma", { configRoot: "/tmp/gamma" }), "1.0.0");
    const a = liveKernelAccessors(registry);
    expect(a.kernelConfigRoots()).toEqual(["/tmp/alpha", "/tmp/gamma"]);
  });

  it("kernelIds / kernelConfigRoots 不过缓存：注册后无需 bump 即新鲜", () => {
    const a = liveKernelAccessors(registry);
    registry.register(makePlugin("alpha", { configRoot: "/tmp/a" }), "1.0.0");
    expect(a.kernelIds()).toEqual([kid("alpha")]);
    expect(a.kernelConfigRoots()).toEqual(["/tmp/a"]);
    registry.register(makePlugin("beta"), "1.0.0");
    expect(a.kernelIds()).toEqual([kid("alpha"), kid("beta")]);
  });
});

describe("kernelLogo：last-known 表（卸载后仍在跑的会话不丢图标）", () => {
  // paths 的元素是 { d, fillRule? }，不是裸字符串（照圆心的 KernelLogo 定义写，别凭印象）。
const LOGO_A: KernelLogo = { viewBox: "0 0 24 24", label: "A", paths: [{ d: "M0 0" }] };

  it("在册 → 返回它的 logo", () => {
    const r = new KernelRegistry();
    r.register(makePlugin("logo-a", { logo: LOGO_A }), "1.0.0");
    const a = liveKernelAccessors(r);
    expect(a.kernelLogo(kid("logo-a"))).toBe(LOGO_A);
  });

  it("已卸载但本进程内曾在册 → 仍返回 last-known logo（不是 undefined）", () => {
    // 语义依据：卸载注册表条目**不 stop 已在跑的进程**，那个会话确实跑在该内核上，
    // 图标消失是错的信息。logo 是不可变数据，缓存它没有 stale 风险。
    const r = new KernelRegistry();
    r.register(makePlugin("logo-b", { logo: LOGO_A }), "1.0.0");
    const a = liveKernelAccessors(r);
    expect(a.kernelLogo(kid("logo-b"))).toBe(LOGO_A);          // 先读一次，进 last-known 表
    r.unregister(kid("logo-b"));
    expect(r.get(kid("logo-b"))).toBeUndefined();
    expect(a.kernelLogo(kid("logo-b")), "卸载后仍应能渲染图标").toBe(LOGO_A);
  });

  it("last-known 表**不随 bump() 清空**（bump 只作废实例缓存）", () => {
    const r = new KernelRegistry();
    r.register(makePlugin("logo-c", { logo: LOGO_A }), "1.0.0");
    const a = liveKernelAccessors(r);
    a.kernelLogo(kid("logo-c"));
    r.unregister(kid("logo-c"));
    a.bump();
    expect(a.kernelLogo(kid("logo-c")), "bump 之后 last-known logo 仍在").toBe(LOGO_A);
  });

  it("从未在册的 id → undefined（renderer 回落占位；不伪造一个 logo）", () => {
    const r = new KernelRegistry();
    const a = liveKernelAccessors(r);
    expect(a.kernelLogo(kid("never-registered"))).toBeUndefined();
  });
});
