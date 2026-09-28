// 内核插件差量重载测试（boot-surface.md §3.6.2）。
//
// 这里的判据不是"调了没抛"，而是**四个必须钉死的语义**逐条可观测：
//   ① 同 id 同 version **不重跑工厂**（dsh 工厂带七个副作用，重复跑会重写 cordis.yml）；
//   ② 消失的内核只摘注册表条目，**不 stop 已在跑的进程**；
//   ③ 暖操作只对**变动**的内核跑；
//   ④ 重建 surfaces 之后必须 `bump()`（不 bump 就拿到旧插件实例造的缓存对象）。
// 外加一条**本实现修正了设计文档图 5 顺序**的回归锚点：新增内核的适配扩展必须真的同步上
// （文档原顺序「先跑暖操作、后重建 surfaces」会让 `syncOf` 在旧 surfaces 里找不到新内核，
// `syncFit()` 永不执行、且不报错）。这条是整组里最值钱的——它守的是一个**静默**失效。

import { describe, it, expect, beforeEach } from "vitest";
import { reloadKernelPlugins } from "./kernel-reload";
import { KernelRegistry } from "../../kernel/core/kernel-registry";
import { liveKernelAccessors } from "./kernel-accessors";
import { buildKernelSurfaces } from "../kernel-surfaces";
import type { KernelPluginLoader } from "./kernel-plugin-loading";
import type { KernelRuntimeState } from "./types";
import type { KernelBootDeps } from "./ops";
import type { KernelPluginEntry } from "../../kernel/core/kernel-plugin-loader";
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
const LOGO: KernelLogo = { viewBox: "0 0 24 24", label: "x", paths: [{ d: "M0 0" }] };

/** 每次造插件都换一个可观测标记，用来判断"工厂到底重跑了没有"。 */
let factoryRuns = 0;
function makePlugin(id: string): KernelPlugin {
  const run = ++factoryRuns;
  return {
    id: kid(id),
    logo: LOGO,
    createBackend: () => ({ run } as unknown as BaseBackend),
    createCatalog: () => ({}) as SessionCatalog,
    createModelSource: () => ({ listModels: () => [] }) as KernelModelSource,
    createModelsApi: () => ({}) as KernelModelsApi,
    createConfigApi: () => ({}) as KernelConfigApi,
    createExtensionSource: () => ({}) as KernelExtensionSource,
    createVersionApi: () => ({}) as KernelVersionApi,
    // 适配扩展同步面：`kernel-fit-extension` 暖操作经 surfaces.extensionSyncs 找它
    createPluginExtensionSync: () => ({ syncFit: () => `fit-${id}-${run}`, reconcile: () => {} }) as never,
    createLifecycle: () => ({}) as never,
  };
}

function entry(id: string, version: string): KernelPluginEntry {
  return { dir: `/plugins/${id}`, manifest: { id: kid(id), order: 1 } as never, version };
}

interface Harness {
  state: KernelRuntimeState;
  deps: KernelBootDeps & { refreshes: number; settingsNotified: number };
  wanted: KernelPluginEntry[];
  loaded: string[];
  /** 让某个 id 的装载抛错（验"单个坏插件不打回整个应用"）。 */
  failOn: Set<string>;
}

function makeHarness(initial: KernelPluginEntry[] = []): Harness {
  const registry = new KernelRegistry();
  const accessors = liveKernelAccessors(registry);
  const h: Harness = {
    wanted: [...initial],
    loaded: [],
    failOn: new Set(),
    deps: {
      surfaces: () => h.state.surfaces,
      bundledSkillsEnabled: () => true,
      extensionActiveIds: new Set<string>(),
      reconcileActive: () => new Set<string>(),
      notifySettingsChanged: () => { h.deps.settingsNotified += 1; },
      notifyKernelsChanged: () => { h.deps.refreshes += 1; },
      injectQuestion: () => {},
      refreshes: 0,
      settingsNotified: 0,
    },
    state: undefined as never,
  };
  const loader: KernelPluginLoader = {
    scan: () => h.wanted,
    load: (reg, e) => {
      if (h.failOn.has(e.manifest.id)) throw new Error(`装载 ${e.manifest.id} 失败（注入）`);
      reg.register(makePlugin(e.manifest.id), e.version);
      h.loaded.push(`${e.manifest.id}@${e.version}`);
    },
  };
  h.state = {
    registry,
    surfaces: buildKernelSurfaces(registry, accessors),
    bootDeps: h.deps,
    accessors,
    loader,
  };
  return h;
}

describe("reloadKernelPlugins：按 (id, version) 差量重载", () => {
  beforeEach(() => { factoryRuns = 0; });

  it("新增：装载 + 注册 + 重建 surfaces + 广播", async () => {
    const h = makeHarness();
    h.wanted = [entry("alpha", "1.0.0")];
    const r = await reloadKernelPlugins(h.state);
    expect(r.added).toEqual([kid("alpha")]);
    expect(r.changed).toBe(true);
    expect(h.state.registry.ids()).toEqual([kid("alpha")]);
    expect(h.state.surfaces.ids, "surfaces 必须重建（否则 ModelCatalog 等看不到新内核）").toEqual([kid("alpha")]);
    expect(h.deps.refreshes, "有变化就要广播（renderer 据此重拉 kernelIds）").toBe(1);
  });

  it("① 同 id 同 version → 工厂**不重跑**、不广播", async () => {
    const h = makeHarness([entry("alpha", "1.0.0")]);
    await reloadKernelPlugins(h.state);            // 首次装载
    const runsAfterFirst = factoryRuns;
    h.loaded.length = 0;
    h.deps.refreshes = 0;

    const r = await reloadKernelPlugins(h.state);  // 再重载一次，清单没变
    expect(r.unchanged).toEqual([kid("alpha")]);
    expect(r.added).toEqual([]);
    expect(r.replaced).toEqual([]);
    expect(r.changed, "没有变化就不该广播").toBe(false);
    expect(factoryRuns, "工厂不能重跑（dsh 工厂带七个副作用，重复跑会重写 cordis.yml）").toBe(runsAfterFirst);
    expect(h.loaded, "装载器不该被再次调用").toEqual([]);
    expect(h.deps.refreshes).toBe(0);
  });

  it("① 同 id **异** version → 工厂重跑，且注册表记的是新版本", async () => {
    const h = makeHarness([entry("alpha", "1.0.0")]);
    await reloadKernelPlugins(h.state);
    const first = h.state.registry.get(kid("alpha"));
    h.loaded.length = 0;                          // 只看第二次重载装载了什么
    h.wanted = [entry("alpha", "1.1.0")];

    const r = await reloadKernelPlugins(h.state);
    expect(r.replaced).toEqual([{ id: kid("alpha"), from: "1.0.0", to: "1.1.0" }]);
    expect(r.added).toEqual([]);
    expect(h.state.registry.versionOf(kid("alpha"))).toBe("1.1.0");
    expect(h.state.registry.get(kid("alpha")), "必须是新插件实例（改动要真生效）").not.toBe(first);
    expect(h.loaded).toEqual(["alpha@1.1.0"]);
  });

  it("④ version 变更后访问器缓存被作废（否则拿到旧插件实例造的对象）", async () => {
    const h = makeHarness([entry("alpha", "1.0.0")]);
    await reloadKernelPlugins(h.state);
    const before = h.state.accessors.kernelModels(kid("alpha"));
    h.wanted = [entry("alpha", "1.1.0")];
    await reloadKernelPlugins(h.state);
    expect(h.state.accessors.kernelModels(kid("alpha")), "bump() 没调的话这里会等于 before").not.toBe(before);
  });

  it("② 消失的内核：只摘注册表条目，重载本身不抛（不 stop 已在跑的进程）", async () => {
    const h = makeHarness([entry("alpha", "1.0.0"), entry("beta", "1.0.0")]);
    await reloadKernelPlugins(h.state);
    h.wanted = [entry("alpha", "1.0.0")];

    const r = await reloadKernelPlugins(h.state);
    expect(r.removed).toEqual([kid("beta")]);
    expect(r.unchanged).toEqual([kid("alpha")]);
    expect(h.state.registry.has(kid("beta"))).toBe(false);
    expect(h.state.registry.has(kid("alpha")), "撤销一个不能牵连别的").toBe(true);
    expect(h.state.surfaces.ids).toEqual([kid("alpha")]);
    // 语义 2 的正面表述：重载没有任何"停进程"的动作可做——它连 SessionStore 都拿不到。
    // 这条断言钉住"接口上没有这个能力"，防止将来有人往重载里塞 stopAll。
    expect(typeof (h.state as unknown as { sessionStore?: unknown }).sessionStore, "重载不该持有 SessionStore").toBe("undefined");
  });

  it("③ 暖操作只对**变动**的内核跑（未变的不重挂技能/不同步扩展）", async () => {
    const h = makeHarness([entry("alpha", "1.0.0")]);
    await reloadKernelPlugins(h.state);
    h.deps.extensionActiveIds.clear();
    h.wanted = [entry("alpha", "1.0.0"), entry("beta", "1.0.0")];   // 只新增 beta

    await reloadKernelPlugins(h.state);
    // kernel-fit-extension 暖操作会为变动内核同步适配扩展；alpha 未变，不该再同步一次
    expect([...h.deps.extensionActiveIds], "只有变动的 beta 被同步").toEqual(["fit-beta-2"]);
  });

  it("★ 新增内核的**适配扩展真的同步上了**（修正图 5 顺序的回归锚点）", async () => {
    // 这条守的是本实现对设计文档的修正：图 5 原顺序是「跑暖操作 → 重建 surfaces」，
    // 而 KERNEL_FIT_OPS 经 syncOf(k,d) 读 d.surfaces().extensionSyncs——
    // surfaces 还是旧的、没有新内核条目 → syncOf 返回 undefined → syncFit() 永不执行，
    // 且 `if (fitId)` 让它**静默**跳过。改成「重建 surfaces → 跑暖操作」后才会真同步。
    const h = makeHarness();
    h.wanted = [entry("alpha", "1.0.0")];
    await reloadKernelPlugins(h.state);
    expect([...h.deps.extensionActiveIds], "新内核的适配扩展必须进 active 集合").toEqual(["fit-alpha-1"]);
  });

  it("装载失败进 errors 而**不抛**：其余内核照常可用（暖路径不该把在跑的应用打回不可用）", async () => {
    const h = makeHarness([entry("alpha", "1.0.0")]);
    await reloadKernelPlugins(h.state);
    h.wanted = [entry("alpha", "1.0.0"), entry("bad", "1.0.0"), entry("beta", "1.0.0")];
    h.failOn.add("bad");

    const r = await reloadKernelPlugins(h.state);
    expect(r.errors.map((e) => e.id)).toEqual(["bad"]);
    expect(r.errors[0].message).toContain("注入");
    expect(r.added, "坏插件之后的内核仍要装载成功").toEqual([kid("beta")]);
    expect(h.state.registry.has(kid("beta"))).toBe(true);
    expect(h.state.registry.has(kid("bad")), "失败的内核不该留半个条目").toBe(false);
  });

  it("空清单 → 全部标记为 removed，且 surfaces 跟着空（不是残留旧投影）", async () => {
    const h = makeHarness([entry("alpha", "1.0.0")]);
    await reloadKernelPlugins(h.state);
    h.wanted = [];
    const r = await reloadKernelPlugins(h.state);
    expect(r.removed).toEqual([kid("alpha")]);
    expect(h.state.surfaces.ids).toEqual([]);
    expect(h.state.accessors.kernelIds()).toEqual([]);
  });
});
