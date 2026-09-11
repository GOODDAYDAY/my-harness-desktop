// N 内核注册验收测试(§kernel-plugin §12) —— 用真实内核插件工厂 + 真实 ctx(真实 JsonPrefsStore
// 文件 + 真实状态标记/刷新计数)+ 真实 KernelRuntime(createNpmKernelRuntime,不 mock),验证注册模型的
// 适配性/可用性/鲁棒性:单内核注册、任意双内核注册、三内核注册 + 真实卸载(真实 manifest + 扫描 + 删 manifest)。
// 不调 listVersions(fetch registry 是远程交互,纯本地不碰;status 读本地 installDir 不碰网络)。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, symlinkSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KernelRegistry, validateKernelPlugin } from "./kernel-registry";
import { initKernelRuntime } from "./kernel-manager";
import { createNpmKernelRuntime } from "../../client/npm/kernel-runtime";
import { scanKernelPlugins, loadKernelPlugin, defaultEnabledEntries } from "./kernel-plugin-loader";
import { minimalKernelPlugin } from "../minimal/plugin";
import { piKernelPlugin } from "../pi/plugin";
import { dshKernelPlugin } from "../dsh/plugin";
import { makeRealCtx } from "./kernel-test-ctx";

let homedir: string;
let cwd: string;

beforeEach(() => {
  homedir = mkdtempSync(join(tmpdir(), "kernel-registry-n-"));
  cwd = mkdtempSync(join(tmpdir(), "kernel-registry-cwd-"));
  // 真实 KernelRuntime(npm install/fetch registry 的真实实现;测试只走 status 读本地路径,不 fetch registry)。
  initKernelRuntime(createNpmKernelRuntime());
});

afterEach(() => {
  rmSync(homedir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("N 内核注册验收(真实插件工厂 + 真实 ctx)", () => {
  it("单内核注册:只注册 minimal,适配完整 + 真 CLI 可用 + 未注册内核显式降级", async () => {
    const r = new KernelRegistry();
    r.register(minimalKernelPlugin(makeRealCtx(homedir, cwd).ctx));

    expect(() => validateKernelPlugin(r.get("minimal")!)).not.toThrow();
    expect(r.ids()).toEqual(["minimal"]);
    // 真实 spawn minimal CLI(非 mock)。
    const backend = r.get("minimal")!.createBackend({ cwd, kernel: "minimal", neutralSessionId: "ns" });
    expect(backend.kernel).toBe("minimal");
    await backend.start();
    expect(backend.alive).toBe(true);
    await backend.stop();
    // 未注册内核显式降级。
    expect(r.get("pi")).toBeUndefined();
    expect(r.get("dsh")).toBeUndefined();
  });

  it("任意双内核注册:pi + minimal 共存,各查各的适配器", () => {
    const r = new KernelRegistry();
    r.register(piKernelPlugin(makeRealCtx(homedir, cwd).ctx));
    r.register(minimalKernelPlugin(makeRealCtx(homedir, cwd).ctx));
    expect(r.ids()).toEqual(["pi", "minimal"]);
    expect(r.get("pi")!.createCatalog().kernel).toBe("pi");
    expect(r.get("minimal")!.createCatalog().kernel).toBe("minimal");
  });

  it("任意双内核注册:dsh + minimal 共存(非 pi 组合)", () => {
    const r = new KernelRegistry();
    r.register(dshKernelPlugin(makeRealCtx(homedir, cwd).ctx));
    r.register(minimalKernelPlugin(makeRealCtx(homedir, cwd).ctx));
    expect(r.ids()).toEqual(["dsh", "minimal"]);
    expect(r.get("dsh")!.createCatalog().kernel).toBe("dsh");
    expect(r.get("minimal")!.createCatalog().kernel).toBe("minimal");
  });

  it("三内核注册:pi + dsh + minimal 全量,清单顺序 = 注册顺序", () => {
    const r = new KernelRegistry();
    r.register(piKernelPlugin(makeRealCtx(homedir, cwd).ctx));
    r.register(dshKernelPlugin(makeRealCtx(homedir, cwd).ctx));
    r.register(minimalKernelPlugin(makeRealCtx(homedir, cwd).ctx));
    expect(r.ids()).toEqual(["pi", "dsh", "minimal"]);
    for (const id of r.ids()) {
      expect(() => validateKernelPlugin(r.get(id)!)).not.toThrow();
      expect(r.get(id)!.createVersionApi()).toBeTruthy();
    }
  });

  it("鲁棒性:注册缺适配器的插件 → fail-fast", () => {
    const r = new KernelRegistry();
    const broken = minimalKernelPlugin(makeRealCtx(homedir, cwd).ctx);
    (broken as unknown as { createCatalog: unknown }).createCatalog = undefined;
    expect(() => r.register(broken)).toThrow(/缺适配器.*createCatalog/);
  });

  // ── 矩阵补口(§12 复核):上面「单内核」只测了 minimal、「双内核」只有 pi+minimal 与
  //    dsh+minimal —— 恰好漏了 **pi + dsh**(minimal 默认不装载,所以这才是线上真跑的
  //    默认组合),以及 pi-only / dsh-only 两个单内核形态。矩阵不齐 = 默认配置没被验收。
  it("单内核注册:只注册 pi(非 minimal 的单内核形态)", () => {
    const r = new KernelRegistry();
    r.register(piKernelPlugin(makeRealCtx(homedir, cwd).ctx));
    expect(() => validateKernelPlugin(r.get("pi")!)).not.toThrow();
    expect(r.ids()).toEqual(["pi"]);
    expect(r.get("pi")!.createCatalog().kernel).toBe("pi");
    // 未注册内核显式降级(不静默、不伪造)。
    expect(r.get("dsh")).toBeUndefined();
    expect(r.get("minimal")).toBeUndefined();
  });

  it("单内核注册:只注册 dsh(非 minimal 的单内核形态)", () => {
    const r = new KernelRegistry();
    r.register(dshKernelPlugin(makeRealCtx(homedir, cwd).ctx));
    expect(() => validateKernelPlugin(r.get("dsh")!)).not.toThrow();
    expect(r.ids()).toEqual(["dsh"]);
    expect(r.get("dsh")!.createCatalog().kernel).toBe("dsh");
    expect(r.get("pi")).toBeUndefined();
  });

  it("双内核注册:pi + dsh(默认生产组合,minimal 不装载)", () => {
    const r = new KernelRegistry();
    // minimal 默认不装载(其 manifest enabled=false,由 defaultEnabledEntries 过滤)——
    // 该过滤口径由下面的「默认装载」用例专门覆盖,此处只验 pi+dsh 这一组合本身。
    r.register(piKernelPlugin(makeRealCtx(homedir, cwd).ctx));
    r.register(dshKernelPlugin(makeRealCtx(homedir, cwd).ctx));
    expect(r.ids()).toEqual(["pi", "dsh"]);
    for (const id of r.ids()) {
      expect(() => validateKernelPlugin(r.get(id)!)).not.toThrow();
      expect(r.get(id)!.createCatalog().kernel).toBe(id);
    }
    // minimal 缺席是「未注册」的诚实信号,不是坏数据。
    expect(r.get("minimal")).toBeUndefined();
  });
});


/** 内核插件所在的真实目录（一个内核 = 一个插件目录）。 */
const KERNEL_PLUGIN_SRC = join(process.cwd(), "src", "plugins", "kernels");
/** 内核工厂的编译产物根（rollup 独立入口，见 electron.vite.config.ts）。 */
const KERNEL_BUILD_ROOT = join(process.cwd(), "out", "main", "server", "kernel");

/** 临时插件 root:对真实内核插件目录做**符号链接**(而非改名/拷贝),被"卸载"的那个不链接。
 *  为什么不直接 rename 真实目录:那是在**改源码树**——测试中途被杀会留下 .bak
 *  把后续构建/e2e 弄脏,且与任何并发扫描该目录的测试竞争。链接方案零侵入:
 *  扫描看到的是临时 root(少一个),而工厂产物仍从构建根按约定解析(与宿主目录无关)。 */
function linkRootExcept(skip: string): string {
  const root = mkdtempSync(join(tmpdir(), "kernel-link-root-"));
  for (const name of readdirSync(KERNEL_PLUGIN_SRC)) {
    if (name === skip) continue;
    symlinkSync(join(KERNEL_PLUGIN_SRC, name), join(root, name), "dir");
  }
  return root;
}

describe("真实插件目录加载 + 默认装载过滤 + 真实卸载", () => {
  // 「一个内核 = 一个插件」（§目标 11/13）的验收：内核面与其 desktop 对接面同属
  // src/plugins/kernels/<id>/，共用一份 plugin.json —— 所以**扫壳插件目录**就能拿到内核清单，
  // 且卸载 = 删这一个目录（内核与它的设置页一起消失）。
  const pluginRoot = join(process.cwd(), "src", "plugins");

  it("默认装载:minimal(kernel.enabled=false)默认不装载,MHD_ENABLE_KERNELS 强制启用", () => {
    const before = scanKernelPlugins(pluginRoot);
    // 扫描 = 存在性:三个内核面都在(含 enabled=false 的 minimal)。
    expect(before.map((e) => e.manifest.id)).toEqual(["pi", "dsh", "minimal"]);
    // 三者的宿主目录就是各自的插件目录（内核面与对接面同处一地，不再有两份 manifest）。
    for (const e of before) {
      expect(e.dir.endsWith(join("plugins", "kernels", e.manifest.id))).toBe(true);
    }

    // 装载 = 默认开关(§目标 16):minimal 默认 off,清单 = [pi, dsh]。
    const def = defaultEnabledEntries(before);
    expect(def.map((e) => e.manifest.id)).toEqual(["pi", "dsh"]);
    // 强制启用(等价 MHD_ENABLE_KERNELS=minimal):三内核全量。
    const forced = defaultEnabledEntries(before, new Set(["minimal"]));
    expect(forced.map((e) => e.manifest.id)).toEqual(["pi", "dsh", "minimal"]);
  });

  it("内核 id 单源：由宿主插件 manifest 的 id 提供，`kernel` 块不重复声明", () => {
    for (const e of scanKernelPlugins(pluginRoot)) {
      const raw = JSON.parse(readFileSync(join(e.dir, "plugin.json"), "utf-8")) as { id: string; kernel?: { id?: string } };
      expect(e.manifest.id).toBe(raw.id);
      expect(raw.kernel?.id, `${raw.id} 的 kernel 块又写了一遍 id（两份定义会漂移）`).toBeUndefined();
    }
  });

  it("从真实构建产物加载三内核(强制启用 minimal)+ 真实 spawn", async () => {
    const entries = defaultEnabledEntries(scanKernelPlugins(pluginRoot), new Set(["minimal"]));
    const registry = new KernelRegistry();
    for (const entry of entries) {
      loadKernelPlugin(registry, entry, KERNEL_BUILD_ROOT, makeRealCtx(homedir, cwd).ctx);
    }
    expect(registry.ids()).toEqual(["pi", "dsh", "minimal"]);

    // 真实 minimal 内核:真实 spawn CLI(非 mock)。
    const backend = registry.get("minimal")!.createBackend({ cwd, kernel: "minimal", neutralSessionId: "ns" });
    await backend.start();
    expect(backend.alive).toBe(true);
    await backend.stop();
  });

  it("真实卸载:minimal 插件目录缺席 → 扫描与默认装载都只剩其余 → 源码树未被触碰", () => {
    const before = readdirSync(KERNEL_PLUGIN_SRC).sort();
    const root = linkRootExcept("minimal");
    try {
      expect(scanKernelPlugins(root).map((e) => e.manifest.id)).toEqual(["pi", "dsh"]);
      const registry = new KernelRegistry();
      for (const entry of scanKernelPlugins(root)) {
        loadKernelPlugin(registry, entry, KERNEL_BUILD_ROOT, makeRealCtx(homedir, cwd).ctx);
      }
      expect(registry.get("minimal")).toBeUndefined();
      expect(registry.ids()).toEqual(["pi", "dsh"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    expect(readdirSync(KERNEL_PLUGIN_SRC).sort()).toEqual(before);
  });

  // 卸载矩阵:任意一个内核插件目录缺席,其余照常装配(§目标 12「任意双内核注册」的物理形态)。
  it.each([
    ["pi", ["dsh", "minimal"]],
    ["dsh", ["pi", "minimal"]],
    ["minimal", ["pi", "dsh"]],
  ])("真实卸载:%s 缺席 → 扫描缺席、其余内核照常在、注册表装配不炸 → 源码树未动", (gone, rest) => {
    const before = readdirSync(KERNEL_PLUGIN_SRC).sort();
    const root = linkRootExcept(gone);
    try {
      expect(scanKernelPlugins(root).map((e) => e.manifest.id)).toEqual(rest);
      // 缺面是「未注册」的诚实信号:默认装载清单同样只剩其余内核(minimal 仍按开关过滤)。
      expect(defaultEnabledEntries(scanKernelPlugins(root)).map((e) => e.manifest.id))
        .toEqual(rest.filter((id) => id !== "minimal"));
      const registry = new KernelRegistry();
      for (const entry of scanKernelPlugins(root)) {
        loadKernelPlugin(registry, entry, KERNEL_BUILD_ROOT, makeRealCtx(homedir, cwd).ctx);
      }
      expect(registry.get(gone)).toBeUndefined();
      expect(registry.ids().length).toBe(rest.length);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    expect(readdirSync(KERNEL_PLUGIN_SRC).sort()).toEqual(before);
  });

  it("鲁棒性:工厂产物缺失 → 显式报错(不静默注册半截内核)", () => {
    const registry = new KernelRegistry();
    const entry = scanKernelPlugins(pluginRoot).find((e) => e.manifest.id === "pi")!;
    expect(() =>
      loadKernelPlugin(registry, { ...entry, manifest: { ...entry.manifest, factory: "./nope-missing.js" } }, KERNEL_BUILD_ROOT, makeRealCtx(homedir, cwd).ctx),
    ).toThrow(/工厂产物不存在/);
  });
});
