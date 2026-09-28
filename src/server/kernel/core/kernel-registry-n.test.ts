// N 内核注册验收测试(§kernel-plugin §12) —— 用真实内核插件工厂 + 真实 ctx(真实 JsonPrefsStore
// 文件 + 真实状态标记/刷新计数)+ 真实 KernelRuntime(createNpmKernelRuntime,不 mock),验证注册模型的
// 适配性/可用性/鲁棒性:单内核注册、任意双内核注册、三内核注册 + 真实卸载(真实 manifest + 扫描 + 删 manifest)。
// 不调 listVersions(fetch registry 是远程交互,纯本地不碰;status 读本地 installDir 不碰网络)。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, symlinkSync, readdirSync, readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
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
    r.register(minimalKernelPlugin(makeRealCtx(homedir, cwd).ctx), "1.0.0");

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
    r.register(piKernelPlugin(makeRealCtx(homedir, cwd).ctx), "1.0.0");
    r.register(minimalKernelPlugin(makeRealCtx(homedir, cwd).ctx), "1.0.0");
    expect(r.ids()).toEqual(["pi", "minimal"]);
    expect(r.get("pi")!.createCatalog().kernel).toBe("pi");
    expect(r.get("minimal")!.createCatalog().kernel).toBe("minimal");
  });

  it("任意双内核注册:dsh + minimal 共存(非 pi 组合)", () => {
    const r = new KernelRegistry();
    r.register(dshKernelPlugin(makeRealCtx(homedir, cwd).ctx), "1.0.0");
    r.register(minimalKernelPlugin(makeRealCtx(homedir, cwd).ctx), "1.0.0");
    expect(r.ids()).toEqual(["dsh", "minimal"]);
    expect(r.get("dsh")!.createCatalog().kernel).toBe("dsh");
    expect(r.get("minimal")!.createCatalog().kernel).toBe("minimal");
  });

  it("三内核注册:pi + dsh + minimal 全量,清单顺序 = 注册顺序", () => {
    const r = new KernelRegistry();
    r.register(piKernelPlugin(makeRealCtx(homedir, cwd).ctx), "1.0.0");
    r.register(dshKernelPlugin(makeRealCtx(homedir, cwd).ctx), "1.0.0");
    r.register(minimalKernelPlugin(makeRealCtx(homedir, cwd).ctx), "1.0.0");
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
    expect(() => r.register(broken, "1.0.0")).toThrow(/缺适配器.*createCatalog/);
  });

  // ── 矩阵补口(§12 复核):上面「单内核」只测了 minimal、「双内核」只有 pi+minimal 与
  //    dsh+minimal —— 恰好漏了 **pi + dsh**(minimal 默认不装载,所以这才是线上真跑的
  //    默认组合),以及 pi-only / dsh-only 两个单内核形态。矩阵不齐 = 默认配置没被验收。
  it("单内核注册:只注册 pi(非 minimal 的单内核形态)", () => {
    const r = new KernelRegistry();
    r.register(piKernelPlugin(makeRealCtx(homedir, cwd).ctx), "1.0.0");
    expect(() => validateKernelPlugin(r.get("pi")!)).not.toThrow();
    expect(r.ids()).toEqual(["pi"]);
    expect(r.get("pi")!.createCatalog().kernel).toBe("pi");
    // 未注册内核显式降级(不静默、不伪造)。
    expect(r.get("dsh")).toBeUndefined();
    expect(r.get("minimal")).toBeUndefined();
  });

  it("单内核注册:只注册 dsh(非 minimal 的单内核形态)", () => {
    const r = new KernelRegistry();
    r.register(dshKernelPlugin(makeRealCtx(homedir, cwd).ctx), "1.0.0");
    expect(() => validateKernelPlugin(r.get("dsh")!)).not.toThrow();
    expect(r.ids()).toEqual(["dsh"]);
    expect(r.get("dsh")!.createCatalog().kernel).toBe("dsh");
    expect(r.get("pi")).toBeUndefined();
  });

  it("双内核注册:pi + dsh(默认生产组合,minimal 不装载)", () => {
    const r = new KernelRegistry();
    // minimal 默认不装载(其 manifest enabled=false,由 defaultEnabledEntries 过滤)——
    // 该过滤口径由下面的「默认装载」用例专门覆盖,此处只验 pi+dsh 这一组合本身。
    r.register(piKernelPlugin(makeRealCtx(homedir, cwd).ctx), "1.0.0");
    r.register(dshKernelPlugin(makeRealCtx(homedir, cwd).ctx), "1.0.0");
    expect(r.ids()).toEqual(["pi", "dsh"]);
    for (const id of r.ids()) {
      expect(() => validateKernelPlugin(r.get(id)!)).not.toThrow();
      expect(r.get(id)!.createCatalog().kernel).toBe(id);
    }
    // minimal 缺席是「未注册」的诚实信号,不是坏数据。
    expect(r.get("minimal")).toBeUndefined();
  });
});


/** 随壳分发的内核插件目录（一个内核 = 一个插件目录）。 */
const KERNEL_PLUGIN_SRC = join(process.cwd(), "src", "plugins", "kernels");
/** **测试专用**内核插件目录（minimal 在这里：不在任何生产扫描根里，日常不存在这个内核）。 */
const TEST_KERNEL_PLUGIN_SRC = join(process.cwd(), "test-plugins", "kernels");

/** 测试根里实际存在的内核插件 id（**从文件系统派生**，不写死个数）。
 *  r48：加第四个内核 probe4（开闭原则的实测探针）后，本文件里三处写死内核清单的断言全部打红。
 *  写死清单守的不是"存在性/卸载语义"，而是"内核恰好三个"——那不是这些用例要守的不变量。
 *  改为派生之后，加/减测试内核都不需要动测试，而真正的不变量（生产根只有 pi/dsh、
 *  卸载某个内核后它缺席且其余照常在）依旧被钉住。 */
const TEST_KERNEL_IDS = readdirSync(TEST_KERNEL_PLUGIN_SRC)
  .filter((d) => existsSync(join(TEST_KERNEL_PLUGIN_SRC, d, "plugin.json")))
  .sort();
/** 全量 = 生产两个 + 测试根全部（排序后比较，避免依赖扫描顺序）。 */
const ALL_KERNEL_IDS = ["dsh", "pi", ...TEST_KERNEL_IDS].sort();
/** 内核工厂的编译产物根（rollup 独立入口，见 electron.vite.config.ts）。 */
const KERNEL_BUILD_ROOT = join(process.cwd(), "out", "main", "server", "kernel");

/** 真实内核插件目录的全部来源（随壳分发 + 测试专用）。矩阵测试要的就是"真实目录 + 真实产物"。 */
const REAL_KERNEL_ROOTS = [KERNEL_PLUGIN_SRC, TEST_KERNEL_PLUGIN_SRC];

/** 临时插件 root:对真实内核插件目录做**符号链接**(而非改名/拷贝),被"卸载"的那个不链接。
 *  为什么不直接 rename 真实目录:那是在**改源码树**——测试中途被杀会留下 .bak
 *  把后续构建/e2e 弄脏,且与任何并发扫描该目录的测试竞争。链接方案零侵入:
 *  扫描看到的是临时 root(少一个),而工厂产物仍从构建根按约定解析(与宿主目录无关)。 */
function linkRootExcept(skip: string): string {
  const root = mkdtempSync(join(tmpdir(), "kernel-link-root-"));
  for (const src of REAL_KERNEL_ROOTS) {
    for (const name of readdirSync(src)) {
      if (name === skip) continue;
      symlinkSync(join(src, name), join(root, name), "dir");
    }
  }
  return root;
}

describe("真实插件目录加载 + 默认装载过滤 + 真实卸载", () => {
  // 「一个内核 = 一个插件」（§目标 11/13）的验收：内核面与其 desktop 对接面同属
  // src/plugins/kernels/<id>/，共用一份 plugin.json —— 所以**扫壳插件目录**就能拿到内核清单，
  // 且卸载 = 删这一个目录（内核与它的设置页一起消失）。
  const pluginRoot = join(process.cwd(), "src", "plugins");

  it("扫描 = 存在性：随壳分发的根只有 pi/dsh；测试专用内核**只**存在于测试根", () => {
    // **生产日常态**：随壳分发的根只有 pi/dsh —— 测试专用内核（minimal、probe4…）的 plugin.json
    // 不在任何生产扫描根里，所以日常不可能出现它们的会话（幽灵行的结构性根治，
    // 见 docs/design/kernel-plugin.md）。
    expect(scanKernelPlugins(pluginRoot).map((e) => e.manifest.id)).toEqual(["pi", "dsh"]);
    // ⚠ 期望清单**从文件系统派生**，不写死内核个数（r48）：这条测试原本硬编码
    //   `["pi","dsh","minimal"]`，于是加第四个内核（probe4，开闭原则的实测探针）就把它打红了。
    //   写死清单守的其实不是"存在性"，而是"内核恰好有三个"——那不是本条要守的不变量。
    //   真正的不变量是上面那条（生产根只有 pi/dsh）+ 下面这条（每个内核的宿主目录就是它自己的插件目录），
    //   两条都与内核**个数**无关，所以派生期望值不会削弱守卫。
    const testKernelIds = readdirSync(TEST_KERNEL_PLUGIN_SRC)
      .filter((d) => existsSync(join(TEST_KERNEL_PLUGIN_SRC, d, "plugin.json")))
      .sort();
    expect(testKernelIds.length, "测试根里至少要有一个测试内核（否则下面几条判据空转）").toBeGreaterThanOrEqual(1);
    const before = [...scanKernelPlugins(pluginRoot), ...scanKernelPlugins(TEST_KERNEL_PLUGIN_SRC)];
    expect([...before.map((e) => e.manifest.id)].sort()).toEqual(["pi", "dsh", ...testKernelIds].sort());
    // 每个内核的宿主目录就是它自己的插件目录（内核面与对接面同处一地，不再有两份 manifest）。
    for (const e of before) {
      expect(e.dir.endsWith(join("kernels", e.manifest.id))).toBe(true);
    }
    // 在场即启用（测试专用插件的 fixture 是 enabled:true）：清单 = 生产两个 + 测试根全部。
    expect([...defaultEnabledEntries(before).map((e) => e.manifest.id)].sort()).toEqual(["pi", "dsh", ...testKernelIds].sort());
  });

  it("默认装载开关的作用域只在**在场的**插件：enabled:false 可被强制启用，缺席的插件谁也启用不了", () => {
    // 机制单测（kernel-plugin-loader.test.ts 已覆盖合成夹具）在这里再钉一次**真实语义**：
    // 这个开关不是"凭空造一个内核"，它只在扫描结果里挑。minimal 移出生产根之后，
    // `MHD_ENABLE_KERNELS=minimal` 在正常安装上什么也启用不了 —— 幽灵会话因此结构性消失。
    const tmp = mkdtempSync(join(tmpdir(), "kernel-enabled-scope-"));
    const dir = join(tmp, "kernels", "fake");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plugin.json"), JSON.stringify({ id: "fake", kernel: { order: 9, enabled: false } }));
    try {
      const scanned = scanKernelPlugins(tmp);
      expect(scanned.map((e) => e.manifest.id)).toEqual(["fake"]);
      expect(defaultEnabledEntries(scanned)).toEqual([]);
      expect(defaultEnabledEntries(scanned, new Set(["fake"])).map((e) => e.manifest.id)).toEqual(["fake"]);
      // 缺席的插件（不在任何扫描根里）无法被"启用"
      expect(defaultEnabledEntries(scanKernelPlugins(pluginRoot), new Set(["minimal"])).map((e) => e.manifest.id))
        .toEqual(["pi", "dsh"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("内核 id 单源：由宿主插件 manifest 的 id 提供，`kernel` 块不重复声明", () => {
    for (const e of scanKernelPlugins(pluginRoot)) {
      const raw = JSON.parse(readFileSync(join(e.dir, "plugin.json"), "utf-8")) as { id: string; kernel?: { id?: string } };
      expect(e.manifest.id).toBe(raw.id);
      expect(raw.kernel?.id, `${raw.id} 的 kernel 块又写了一遍 id（两份定义会漂移）`).toBeUndefined();
    }
  });

  it("从真实构建产物加载三内核(随壳分发 + 测试专用)+ 真实 spawn", async () => {
    const entries = defaultEnabledEntries([...scanKernelPlugins(pluginRoot), ...scanKernelPlugins(TEST_KERNEL_PLUGIN_SRC)]);
    const registry = new KernelRegistry();
    for (const entry of entries) {
      loadKernelPlugin(registry, entry, KERNEL_BUILD_ROOT, makeRealCtx(homedir, cwd).ctx);
    }
    expect([...registry.ids()].sort()).toEqual(ALL_KERNEL_IDS);

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
      // 卸掉 minimal 后：生产两个 + 测试根里除 minimal 之外的全部
      expect([...scanKernelPlugins(root).map((e) => e.manifest.id)].sort())
        .toEqual(["dsh", "pi", ...TEST_KERNEL_IDS.filter((id) => id !== "minimal")].sort());
      const registry = new KernelRegistry();
      for (const entry of scanKernelPlugins(root)) {
        loadKernelPlugin(registry, entry, KERNEL_BUILD_ROOT, makeRealCtx(homedir, cwd).ctx);
      }
      expect(registry.get("minimal")).toBeUndefined();
      expect([...registry.ids()].sort())
        .toEqual(["dsh", "pi", ...TEST_KERNEL_IDS.filter((id) => id !== "minimal")].sort());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    expect(readdirSync(KERNEL_PLUGIN_SRC).sort()).toEqual(before);
  });

  // 卸载矩阵:任意一个内核插件目录缺席,其余照常装配(§目标 12「任意双内核注册」的物理形态)。
  // ⚠ 卸载矩阵**从全量派生**（r48）：原本写死三行 `["pi", ["dsh","minimal"]]`…，
  //   加第四个内核 probe4 后三行全部打红。派生之后矩阵自动覆盖每一个在场的内核
  //   （内核越多、用例越多），比写死的三行**更强**，且加内核不需要动测试。
  it.each(ALL_KERNEL_IDS.map((gone) => [gone, ALL_KERNEL_IDS.filter((id) => id !== gone)] as [string, string[]]))(
    "真实卸载:%s 缺席 → 扫描缺席、其余内核照常在、注册表装配不炸 → 源码树未动", (gone, rest) => {
    const before = readdirSync(KERNEL_PLUGIN_SRC).sort();
    const root = linkRootExcept(gone);
    try {
      expect([...scanKernelPlugins(root).map((e) => e.manifest.id)].sort()).toEqual([...rest].sort());
      // 缺面是「未注册」的诚实信号:默认装载清单同样只剩其余内核(在场者皆为 enabled)。
      expect([...defaultEnabledEntries(scanKernelPlugins(root)).map((e) => e.manifest.id)].sort()).toEqual([...rest].sort());
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

  // ---- 内核 id 单源：manifest.id 必须等于工厂返回的 plugin.id（r17 补的 fail-fast）----
  //
  // 为什么必须有这条：注册表按**工厂返回的 id** 存键，而差量重载 / 设置页挂载 / renderer TAB
  // 都按 **manifest.id** 查。两者不一致时没有任何一处会主动报错——冷启动表现为"内核看起来
  // 没装载"（其实装在另一个名字下），暖重载表现为"每次都判为新增 → register 撞重复 id →
  // 进 errors"，于是**重载永远修不好自己**，用户每点一次就报一次同样的错。
  // 用**真产物**测（不造替身）：拿真实 pi 条目、只把 manifest.id 改成别的，
  // 工厂仍然返回它自己的 "pi" —— 这正是"把别的内核产物指过来复用"会产生的形状。
  it("manifest.id 与工厂返回的 plugin.id 不一致 → fail-fast，错误点名两个 id 与单源规则", () => {
    const registry = new KernelRegistry();
    const entry = scanKernelPlugins(pluginRoot).find((e) => e.manifest.id === "pi")!;
    // ⚠ 只改 manifest.id 会**连带改掉工厂路径解析**（缺省约定是 `<构建根>/<id>/plugin.js`），
    //   于是先撞"工厂产物不存在"、根本走不到 id 校验。所以同时把 factory 显式指回 pi 的真产物
    //   （resolveKernelFactoryPath 对显式 factory 走 `resolve(entry.dir, factory)`，绝对路径原样生效）。
    //   这个形状也正是现实里会出问题的场景：第三方内核插件用显式 factory 复用/指向某个产物，
    //   而 manifest 的 id 是自己起的。
    const mismatched = {
      ...entry,
      manifest: {
        ...entry.manifest,
        id: "not-pi" as never,
        factory: join(KERNEL_BUILD_ROOT, "pi", "plugin.js"),
      },
    };
    let msg = "";
    try {
      loadKernelPlugin(registry, mismatched, KERNEL_BUILD_ROOT, makeRealCtx(homedir, cwd).ctx);
    } catch (e) { msg = (e as Error).message; }
    expect(msg, "必须抛错，不能静默注册到另一个 id 下").toContain("id 不一致");
    expect(msg).toContain("not-pi");
    expect(msg).toContain("pi");
    expect(msg, "要点名单源规则，否则修的人不知道以哪边为准").toMatch(/单源|manifest/);
    expect(registry.ids(), "抛错后注册表不该留下半个条目").toEqual([]);
  });

  it("一致时照常装载（校验不能把正常路径也拦下）", () => {
    const registry = new KernelRegistry();
    const entry = scanKernelPlugins(pluginRoot).find((e) => e.manifest.id === "pi")!;
    loadKernelPlugin(registry, entry, KERNEL_BUILD_ROOT, makeRealCtx(homedir, cwd).ctx);
    expect(registry.has("pi" as never)).toBe(true);
    expect(registry.versionOf("pi" as never)).toBe(entry.version);
  });

  it("鲁棒性:工厂产物缺失 → 显式报错(不静默注册半截内核)", () => {
    const registry = new KernelRegistry();
    const entry = scanKernelPlugins(pluginRoot).find((e) => e.manifest.id === "pi")!;
    expect(() =>
      loadKernelPlugin(registry, { ...entry, manifest: { ...entry.manifest, factory: "./nope-missing.js" } }, KERNEL_BUILD_ROOT, makeRealCtx(homedir, cwd).ctx),
    ).toThrow(/工厂产物不存在/);
  });
});
