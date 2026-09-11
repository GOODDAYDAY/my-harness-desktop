// 「加第四个内核零改动」的**可执行证据**（§目标 11）。
//
// 这句话此前只能靠人把 assemble.ts 读一遍来相信。收成 `buildKernelSurfaces(registry)` 之后，
// 它可以被直接跑：**3 个真实内核 + 1 个当场造的第四个**，然后逐面检查第四个有没有被自动接上。
//
// 测试里刻意不做的事：不改任何核心代码、不在核心代码里加 kimi 的分支、不 mock 掉注册表。
// 第四个内核走的路径与 pi/dsh/minimal **完全一致**：声明 id/logo/七个必需面 → register →
// 壳的每一面都从注册表遍历出来。哪一面漏了自动纳入，这条测试就红。
//
// 另有一条**静态检查**：`kernel-surfaces.ts` 里不许出现任何内核名——它是"零改动"的对象本身。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KernelRegistry } from "../kernel/core/kernel-registry";
import { piKernelPlugin } from "../kernel/pi/plugin";
import { dshKernelPlugin } from "../kernel/dsh/plugin";
import { minimalKernelPlugin } from "../kernel/minimal/plugin";
import { makeRealCtx } from "../kernel/core/kernel-test-ctx";
import { buildKernelSurfaces, ensureBundledSkillsOnAll, makeExtensionDispatch, migrateSkillsOnAll, runKernelStartupMigrations } from "./kernel-surfaces";
import type { BaseBackend, KernelPlugin } from "@my-harness-desktop/shared";

let homedir: string;
let cwd: string;

beforeEach(() => {
  homedir = mkdtempSync(join(tmpdir(), "surfaces-home-"));
  cwd = mkdtempSync(join(tmpdir(), "surfaces-cwd-"));
});
afterEach(() => {
  rmSync(homedir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

/** 第四个内核：**只实现契约要求的面**，不碰任何壳代码。用最小替身，够验"接上了没有"。 */
function makeFourthKernel(id: string): { plugin: KernelPlugin; log: string[] } {
  const log: string[] = [];
  const backend = { kernel: id } as unknown as BaseBackend;
  const plugin: KernelPlugin = {
    id,
    logo: { viewBox: "0 0 24 24", label: id, paths: [{ d: "M0 0h24v24H0z" }] },
    createBackend: () => { log.push("createBackend"); return backend; },
    seed: () => { log.push("seed"); return Promise.resolve(`/${id}/sessions/x.jsonl`); },
    createCatalog: () => ({ kernel: id }) as never,
    createModelSource: () => ({ listModels: () => [{ kernel: id, provider: `${id}-p`, id: `${id}-m`, name: `${id} model` }] }),
    createModelsApi: () => ({ __api: id, kind: "models" }) as never,
    createConfigApi: () => ({ __api: id, kind: "config" }) as never,
    createExtensionSource: () => ({ __api: id, kind: "extensions" }) as never,
    // 版本面：内置型（不装/不可指定目录）——第四个内核可以自己选，壳不预设
    createVersionApi: () => ({
      capabilities: () => Promise.resolve({ install: false, customDir: false }),
      status: () => Promise.resolve({ currentVersion: id, installedVersion: id, available: true, source: "installed" as const, customCliDir: "", error: null }),
      setCustomCliDir: () => Promise.resolve({ ok: false, error: null, pendingCount: 0, status: null }),
      listVersions: () => Promise.resolve({ versions: [], latest: null }),
      install: () => Promise.resolve({ ok: false, error: null }),
    }),
    createOneshot: () => { log.push("oneshot"); return (p) => Promise.resolve(`${id}:${p}`); },
    // 带内核归属标记，供断言认出「这一份是第四个内核交的」（否则只能写成恒真断言）
    createSkillProvider: () => ({ __kernel: id, list: () => [], capabilities: { modelInvocable: false } }) as never,
    ensureSkills: () => { log.push("ensureSkills"); return Promise.resolve(true); },
    createLifecycle: () => { log.push("lifecycle"); return { skillsEnsure: { onActivate: async () => false, onDeactivate: async () => false } }; },
    createPluginExtensionSync: () => {
      log.push("extensionSync");
      return {
        onActivate: (pluginId, _path, dir) => log.push(`ext.onActivate:${pluginId}:${dir}`),
        onDeactivate: (pluginId) => log.push(`ext.onDeactivate:${pluginId}`),
        syncFit: () => { log.push("ext.syncFit"); return `${id}-fit`; },
        reconcile: (active) => log.push(`ext.reconcile:${[...active].join(",")}`),
      };
    },
    sessionRoot: () => `/${id}/sessions`,
    configRoot: () => `/${id}/config`,
    skillWatchPaths: (c) => [`/${id}/settings.json`, join(c, `.${id}`, "settings.json")],
    migrateLegacyState: () => log.push("migrateLegacyState"),
    readLegacySessions: () => { log.push("readLegacySessions"); return []; },
  };
  return { plugin, log };
}

function registryWithRealThree(): KernelRegistry {
  const ctx = makeRealCtx(homedir, cwd).ctx;
  const r = new KernelRegistry();
  r.register(piKernelPlugin(ctx));
  r.register(dshKernelPlugin(ctx));
  r.register(minimalKernelPlugin(ctx));
  return r;
}

describe("第四个内核：不碰核心代码，能被每一面自动接上", () => {
  it("注册进同一个注册表 → 全部中性面里都出现它（不需要在核心加一行）", () => {
    const r = registryWithRealThree();
    const { plugin } = makeFourthKernel("kimi");
    r.register(plugin);

    const s = buildKernelSurfaces(r);
    expect(s.ids).toEqual(["pi", "dsh", "minimal", "kimi"]);
    expect(s.defaultId, "默认内核 = 注册顺序第一个，不由代码里的字符串决定").toBe("pi");
    // 逐面检查：任何一面漏了自动纳入，这里就红
    expect(s.modelCatalog.listModels().filter((m) => m.kernel === "kimi")).toHaveLength(1);
    expect(Object.keys(s.modelsApis)).toContain("kimi");
    expect(Object.keys(s.configApis)).toContain("kimi");
    expect(Object.keys(s.versionApis)).toContain("kimi");
    expect(Object.keys(s.extensionSources)).toContain("kimi");
    expect(s.oneshots["kimi"], "第四个内核也交 oneshot 面 → 壳要认得，不能只有 pi 有").toBeTruthy();
    expect(
      s.skillProviders.some((p) => (p as unknown as { __kernel?: string }).__kernel === "kimi"),
      "第四个内核的 skillProvider 没被收进来",
    ).toBe(true);
    expect(s.skillsPlugins.map((p) => p.id)).toContain("kimi");
    // 生命周期钩子必须带内核归属：多个内核都交钩子时，匿名数组无法点名失败源
    expect(s.lifecycles.map((l) => l.kernel)).toContain("kimi");
    expect(s.extensionSyncs.map((e) => e.kernel)).toContain("kimi");
    expect(s.sessionRoots).toContain("/kimi/sessions");
    expect(s.configRoots).toContain("/kimi/config");
    expect(s.skillWatchPaths(cwd)).toContain("/kimi/settings.json");
  });

  it("单/双/三/四内核都是同一段代码跑出来的（面的数量随注册表线性增长，无分支）", () => {
    const ctx = makeRealCtx(homedir, cwd).ctx;
    const mk = (ids: string[]): KernelRegistry => {
      const r = new KernelRegistry();
      const byId: Record<string, (c: unknown) => KernelPlugin> = {
        pi: piKernelPlugin as never, dsh: dshKernelPlugin as never, minimal: minimalKernelPlugin as never,
      };
      for (const id of ids) {
        if (id === "kimi") r.register(makeFourthKernel("kimi").plugin);
        else r.register(byId[id](ctx));
      }
      return r;
    };
    for (const ids of [["pi"], ["pi", "dsh"], ["pi", "dsh", "minimal"], ["pi", "dsh", "minimal", "kimi"]]) {
      const s = buildKernelSurfaces(mk(ids));
      expect(s.ids, `注册 ${ids.length} 个内核时面没跟上`).toEqual(ids);
      expect(s.sessionRoots).toHaveLength(ids.length);
      expect(s.configRoots).toHaveLength(ids.length);
      expect(Object.keys(s.modelsApis)).toHaveLength(ids.length);
    }
  });

  it("插件携带的扩展按内核 id 派发到第四个内核（挂与摘都到），未知内核 id 显式跳过", () => {
    const r = registryWithRealThree();
    const { plugin, log } = makeFourthKernel("kimi");
    r.register(plugin);
    const dispatch = makeExtensionDispatch(buildKernelSurfaces(r));

    dispatch.onActivate("kimi", "some-plugin", "/plugins/some-plugin", "./kimi-extension");
    expect(log).toContain("ext.onActivate:some-plugin:./kimi-extension");
    dispatch.onDeactivate("kimi", "some-plugin");
    expect(log).toContain("ext.onDeactivate:some-plugin");

    // 未知内核：显式跳过（warn），不抛——插件声明了一个没装载的内核的扩展不该炸掉生命周期
    expect(() => dispatch.onActivate("not-loaded", "some-plugin", "/p", "./x")).not.toThrow();
  });

  it("内核自己的历史状态迁移：第四个内核被调到；某个内核抛错只点名它，不拖垮别的", () => {
    const r = registryWithRealThree();
    const { plugin, log } = makeFourthKernel("kimi");
    r.register(plugin);
    const boom = makeFourthKernel("boom").plugin;
    boom.migrateLegacyState = () => { throw new Error("迁移炸了"); };
    r.register(boom);

    const failed = runKernelStartupMigrations(r);
    expect(log, "第四个内核的迁移面没被调到（壳只认 pi/dsh？）").toContain("migrateLegacyState");
    expect(failed).toEqual(["boom"]);
  });
});

describe("内置技能面：**逐个内核都要挂**（不是「取第一个」）", () => {
  /** 能记事的 ensureSkills/migrateSkills 面。 */
  function withSkills(id: string, log: string[], behavior?: { throwOnEnsure?: boolean }) {
    const { plugin } = makeFourthKernel(id);
    plugin.ensureSkills = async (enabled: boolean) => {
      log.push(`${id}:ensure:${enabled}`);
      if (behavior?.throwOnEnsure) throw new Error(`${id} 挂了`);
      return true;
    };
    plugin.migrateSkills = async () => { log.push(`${id}:migrate`); return false; };
    return plugin;
  }

  it("两个内核都有内置技能面 → 两个都被调到（此前只调第一个，第二个静默不生效）", async () => {
    const r = registryWithRealThree();
    const log: string[] = [];
    r.register(withSkills("kimi", log));
    r.register(withSkills("qwen", log));
    const surfaces = buildKernelSurfaces(r);
    expect(surfaces.skillsPlugins.map((p) => p.id)).toEqual(["pi", "kimi", "qwen"]);

    const changed = await ensureBundledSkillsOnAll(surfaces, true);
    expect(log.filter((l) => l.endsWith(":ensure:true")), "第二个支持该面的内核被静默忽略了").toEqual(["kimi:ensure:true", "qwen:ensure:true"]);
    expect(changed).toBe(true);

    log.length = 0;
    await migrateSkillsOnAll(surfaces);
    expect(log, "迁移面也要逐个内核都跑").toEqual(["kimi:migrate", "qwen:migrate"]);
  });

  it("单个内核抛错：点名留痕、不阻断其余内核（一个坏的不能让别的挂不上）", async () => {
    const r = registryWithRealThree();
    const log: string[] = [];
    r.register(withSkills("broken", log, { throwOnEnsure: true }));
    r.register(withSkills("fine", log));
    const surfaces = buildKernelSurfaces(r);

    const changed = await ensureBundledSkillsOnAll(surfaces, false);
    expect(log, "坏内核之后的那个没被调到 —— 一个内核抛错不该阻断其余").toContain("fine:ensure:false");
    expect(changed, "只有一个内核真的改了也应报告 changed").toBe(true);
  });
});

describe("「零改动」的对象本身：kernel-surfaces.ts 里不许出现内核名", () => {
  it("源码扫描：pi/dsh/minimal 字面量 0 处", () => {
    const src = readFileSync(join(process.cwd(), "src/server/bootstrap/kernel-surfaces.ts"), "utf-8");
    // 去掉注释再扫（注释里出现内核名是**解释**，不是依赖）
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    const hits = [...code.matchAll(/["'`](pi|dsh|minimal)["'`]/g)].map((m) => m[0]);
    expect(hits, `这一层出现了内核字面量，它就不再是"内核无关的投影"了：${hits.join(", ")}`).toEqual([]);
  });
});
