// 三个「构造期快照」消费者改持 getter 之后的**活性**守卫（boot-surface.md §3.6.3）。
//
// 为什么单独立这一组：把构造参数从 `T[]` 改成 `() => T[]` 之后，**所有既有测试仍然全绿**——
// 因为它们的夹具是静态的（构造时给一个数组，之后再不改）。也就是说"改了签名"这件事
// 本身没有任何测试盯着；如果实现里把 getter 调一次就存下结果（`this.sources = getSources()`），
// 或者 getter 捕获了局部快照（`() => plugins.map(...)` 里的 `plugins` 是构造期的局部数组），
// 既有测试一样全绿，而 stale 缺陷原封不动地留着。
//
// 所以这里的判据统一是：**先构造消费者，再改数据源，然后断言消费者看到了新数据**。
// 顺序反了（先改源再构造）就退化成静态夹具，什么也证明不了。
//
// 三个消费者各自的"源"不同，这也是它们不能共用一套改法的原因：
//   · `ModelCatalog` ← 活访问器（经注册表投影，且 memo 保证 source 实例稳定）
//   · `SkillAggregator` ← **当前的** `state.surfaces`（重载会整体替换 surfaces 对象）
//   · `SessionStore.kernelFacts` ← 注入的 getter（bootstrap 给成读当前 surfaces + accessors）

import { describe, it, expect } from "vitest";
import { ModelCatalog } from "./models/model-catalog";
import { SkillAggregator } from "./skills/skill-aggregator";
import { KernelRegistry } from "../kernel/core/kernel-registry";
import { liveKernelAccessors } from "../bootstrap/boot/kernel-accessors";
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
  ModelInfo,
  SkillProvider,
  SkillInfo,
  ManagedSkill,
  SkillCapabilities,
} from "@my-harness-desktop/shared";

const kid = (s: string): KernelId => s as KernelId;
const LOGO: KernelLogo = { viewBox: "0 0 24 24", label: "x", paths: [{ d: "M0 0" }] };

function model(kernel: string, id: string): ModelInfo {
  return { kernel: kid(kernel), provider: "p", id, name: id, contextWindow: 1 } as unknown as ModelInfo;
}

/** 只造本组测试用得到的面；其余给空实现（validateKernelPlugin 要求七个工厂都在）。 */
function makePlugin(id: string, models: ModelInfo[]): KernelPlugin {
  const source: KernelModelSource = { listModels: () => models };
  return {
    id: kid(id),
    logo: LOGO,
    createBackend: () => ({}) as BaseBackend,
    createCatalog: () => ({}) as SessionCatalog,
    createModelSource: () => source,
    createModelsApi: () => ({}) as KernelModelsApi,
    createConfigApi: () => ({}) as KernelConfigApi,
    createExtensionSource: () => ({}) as KernelExtensionSource,
    createVersionApi: () => ({}) as KernelVersionApi,
  };
}

describe("ModelCatalog：持 getter → 注册表变了立刻反映", () => {
  it("构造**之后**才注册的内核，模型进得了合流清单", () => {
    const registry = new KernelRegistry();
    registry.register(makePlugin("alpha", [model("alpha", "m1")]), "1.0.0");
    const accessors = liveKernelAccessors(registry);
    // 与 kernel-surfaces.ts 的装配方式同构：getter 里读 accessors（活源 + memo 稳定实例）
    const catalog = new ModelCatalog(() =>
      accessors.kernelIds().map((k) => accessors.kernelModelSource(k)).filter((s): s is KernelModelSource => !!s),
    );
    expect(catalog.listModels().map((m) => m.id)).toEqual(["m1"]);

    registry.register(makePlugin("beta", [model("beta", "m2")]), "1.0.0");
    accessors.bump();
    expect(
      catalog.listModels().map((m) => `${m.kernel}/${m.id}`).sort(),
      "后注册的内核必须进合流清单（快照形状下这里永远只有 m1）",
    ).toEqual(["alpha/m1", "beta/m2"]);

    registry.unregister(kid("alpha"));
    accessors.bump();
    expect(catalog.listModels().map((m) => m.id), "卸载的内核要退出清单").toEqual(["m2"]);
  });

  it("反例：getter 捕获**构造期局部数组**时，后注册的内核进不来（钉住这个陷阱）", () => {
    // 这条不是测产品，是**钉住一个真实踩过的写法**：r16 第一版把 kernel-surfaces 的
    // `new ModelCatalog(plugins.map(...))` 机械地包成 `new ModelCatalog(() => plugins.map(...))`——
    // 签名对了、类型过了、测试全绿，但 `plugins` 是本函数构造期的局部数组，
    // 重载造出的新 catalog 与 MainContext 持有的旧 catalog 各自捕获各自的数组，
    // 旧实例永远只看到旧内核。**延迟求值 ≠ 活**。
    const registry = new KernelRegistry();
    registry.register(makePlugin("alpha", [model("alpha", "m1")]), "1.0.0");
    const plugins = registry.all();                        // ← 构造期快照
    const stale = new ModelCatalog(() => plugins.map((p) => p.createModelSource()));
    registry.register(makePlugin("beta", [model("beta", "m2")]), "1.0.0");
    expect(stale.listModels().map((m) => m.id), "捕获局部数组的 getter 看不到新内核（这就是要避免的写法）").toEqual(["m1"]);
  });
});

describe("SkillAggregator：持 getter → 提供方集合变了立刻反映", () => {
  const provider = (tag: string, names: string[]): SkillProvider =>
    ({
      capabilities: { toggleEnabled: true, toggleModelInvocable: false } as SkillCapabilities,
      listSkills: async (): Promise<ManagedSkill[]> =>
        names.map((n) => ({ name: n, scope: "user", enabled: true, filePath: `${tag}/${n}` } as unknown as ManagedSkill)),
      watch: () => () => {},
    }) as unknown as SkillProvider;

  it("构造**之后**换掉提供方集合，聚合结果跟着变", async () => {
    // 模拟 50-wiring 的写法：getter 读**当前** surfaces（这里用一个可替换的 holder 代替）
    const holder: { skillProviders: SkillProvider[] } = { skillProviders: [provider("a", ["s1"])] };
    const agg = new SkillAggregator(() => holder.skillProviders);
    expect((await agg.listSkills("/proj")).map((s) => s.name)).toEqual(["s1"]);

    holder.skillProviders = [provider("a", ["s1"]), provider("b", ["s2"])];   // 重载 = 整体替换
    expect(
      (await agg.listSkills("/proj")).map((s) => s.name).sort(),
      "新内核的技能必须进聚合（快照形状下这里永远只有 s1）",
    ).toEqual(["s1", "s2"]);

    holder.skillProviders = [];
    expect(await agg.listSkills("/proj"), "卸载后要退出").toEqual([]);
  });

  it("capabilities 也走活源（它是聚合视图的表头/空态依据）", () => {
    const none: SkillCapabilities = { toggleEnabled: false, toggleModelInvocable: false };
    const some: SkillCapabilities = { toggleEnabled: true, toggleModelInvocable: true };
    const mk = (c: SkillCapabilities): SkillProvider =>
      ({ capabilities: c, listSkills: async () => [] as ManagedSkill[], watch: () => () => {} }) as unknown as SkillProvider;
    const holder: { p: SkillProvider[] } = { p: [mk(none)] };
    const agg = new SkillAggregator(() => holder.p);
    expect(agg.capabilities.toggleModelInvocable).toBe(false);
    holder.p = [mk(none), mk(some)];
    expect(agg.capabilities.toggleModelInvocable, "任一行支持即 true，且要现读").toBe(true);
  });
});

describe("SessionStore.kernelFacts：持 getter → 会话根与已知内核跟着变", () => {
  it("构造**之后**改事实源，公开面 sessionRoots 立刻反映", async () => {
    const { SessionStore } = await import("./sessions/session-store");
    const noopFactory = (() => ({}) as BaseBackend) as never;
    const noopCatalog = (() => ({}) as SessionCatalog) as never;
    // 可替换的事实源：模拟 bootstrap 注入的 `() => ({ sessionRoots: 当前 surfaces…, ids: accessors.kernelIds() })`
    const holder: { facts: { sessionRoots: string[]; ids: KernelId[] } } = {
      facts: { sessionRoots: ["/kernels/alpha/sessions"], ids: [kid("alpha")] },
    };
    const store = new SessionStore(noopFactory, noopCatalog, () => holder.facts);
    expect([...store.sessionRoots]).toEqual(["/kernels/alpha/sessions"]);

    holder.facts = { sessionRoots: ["/kernels/alpha/sessions", "/kernels/beta/sessions"], ids: [kid("alpha"), kid("beta")] };
    expect(
      [...store.sessionRoots],
      "新内核的会话根必须进路径圈禁白名单（快照形状下会把它判成越界路径）",
    ).toEqual(["/kernels/alpha/sessions", "/kernels/beta/sessions"]);

    holder.facts = { sessionRoots: [], ids: [] };
    expect([...store.sessionRoots], "卸载后要退出白名单").toEqual([]);
  });
});
