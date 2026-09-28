// 内核插件加载器测试(§kernel-plugin 物理插件) —— 扫描 + 卸载鲁棒性。
// 动态 require 真实编译产物 plugin.js 的验证见 kernel-registry-n.test.ts(从真实插件目录加载)。
//
// 验证第 13 点「把插件卸载掉仍然没问题」的机制面。**扫描面变了**（勿按旧形状读）：
// 「一个内核 = 一个插件」之后，内核面写在**宿主壳插件自己的 manifest** 的 `kernel` 块里，
// 加载器扫的就是壳插件根目录（`<域>/<插件>/plugin.json`，递归深度 3，命中即止）。
// 于是：删掉这个插件的 plugin.json = 卸载，内核与其 desktop 对接面一起消失。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanKernelPlugins, defaultEnabledEntries, resolveKernelFactoryPath } from "./kernel-plugin-loader";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kernel-plugins-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 写一个**宿主壳插件** manifest（内核面写在 kernel 块里，id 由宿主 id 单源提供）。 */
function makePlugin(dir: string, id: string, kernel?: { order?: number; enabled?: boolean } | null): void {
  mkdirSync(dir, { recursive: true });
  const manifest: Record<string, unknown> = { id, version: "0.1.0", contributes: {} };
  if (kernel !== null) manifest.kernel = kernel ?? {};
  writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest));
}

describe("内核插件扫描 + 卸载鲁棒性", () => {
  it("只收 manifest 带 kernel 块的插件（普通壳插件不算内核插件）", () => {
    makePlugin(join(root, "kernels", "pi"), "pi", { order: 1 });
    makePlugin(join(root, "kernels", "dsh"), "dsh", { order: 2 });
    makePlugin(join(root, "kernels", "minimal"), "minimal", { order: 3, enabled: false });
    makePlugin(join(root, "sessions", "timeline"), "timeline", null); // 普通壳插件
    mkdirSync(join(root, "locales")); // 无 manifest 的目录
    const entries = scanKernelPlugins(root);
    expect(entries.map((e) => e.manifest.id)).toEqual(["pi", "dsh", "minimal"]);
    // 宿主目录就是内核插件目录本身（内核面与对接面同处一地）。
    expect(entries[0].dir).toBe(join(root, "kernels", "pi"));
  });

  it("内核 id 单源：取宿主 manifest 的 id，kernel 块里写 id 也不生效", () => {
    makePlugin(join(root, "kernels", "pi"), "pi", { order: 1 });
    const raw = JSON.parse(JSON.stringify({ id: "pi", kernel: { order: 1, id: "not-pi" } }));
    writeFileSync(join(root, "kernels", "pi", "plugin.json"), JSON.stringify(raw));
    expect(scanKernelPlugins(root)[0].manifest.id).toBe("pi");
  });

  it("卸载(删 manifest)→ 不再列出 → 缺面降级", () => {
    makePlugin(join(root, "pi"), "pi", { order: 1 });
    makePlugin(join(root, "dsh"), "dsh", { order: 2 });
    makePlugin(join(root, "minimal"), "minimal", { order: 3 });
    rmSync(join(root, "dsh", "plugin.json"));
    expect(scanKernelPlugins(root).map((e) => e.manifest.id)).toEqual(["pi", "minimal"]);
  });

  it("扫描根目录不存在 → 空清单(不抛,壳照常启动)", () => {
    expect(scanKernelPlugins(join(root, "missing"))).toEqual([]);
  });

  it("manifest JSON 损坏 → 跳过该插件(不炸整次扫描)", () => {
    makePlugin(join(root, "pi"), "pi", { order: 1 });
    mkdirSync(join(root, "broken"), { recursive: true });
    writeFileSync(join(root, "broken", "plugin.json"), "{ 不是 JSON");
    expect(scanKernelPlugins(root).map((e) => e.manifest.id)).toEqual(["pi"]);
  });
});

describe("默认装载过滤(§目标 16:kernel.enabled=false 默认不装载)", () => {
  it("enabled=false 的内核默认被过滤,enabled 缺省视为 true", () => {
    makePlugin(join(root, "pi"), "pi", { order: 1 });
    makePlugin(join(root, "dsh"), "dsh", { order: 2 });
    makePlugin(join(root, "minimal"), "minimal", { order: 3, enabled: false });
    const entries = scanKernelPlugins(root);
    expect(entries.map((e) => e.manifest.id)).toEqual(["pi", "dsh", "minimal"]);
    expect(defaultEnabledEntries(entries).map((e) => e.manifest.id)).toEqual(["pi", "dsh"]);
  });

  it("forceEnable 强制启用被声明为 off 的内核(MHD_ENABLE_KERNELS 语义)", () => {
    makePlugin(join(root, "pi"), "pi", { order: 1 });
    makePlugin(join(root, "minimal"), "minimal", { order: 3, enabled: false });
    const entries = scanKernelPlugins(root);
    expect(defaultEnabledEntries(entries, new Set(["minimal"])).map((e) => e.manifest.id)).toEqual(["pi", "minimal"]);
  });

  it("卸载与默认开关正交:删 manifest 后 forceEnable 也找不到(缺面)", () => {
    makePlugin(join(root, "pi"), "pi", { order: 1 });
    makePlugin(join(root, "minimal"), "minimal", { order: 3, enabled: false });
    rmSync(join(root, "minimal", "plugin.json"));
    const entries = scanKernelPlugins(root);
    expect(defaultEnabledEntries(entries, new Set(["minimal"])).map((e) => e.manifest.id)).toEqual(["pi"]);
  });
});

describe("工厂模块定位(约定优先,显式可覆盖)", () => {
  const BUILD_ROOT = "/build/root";

  it("缺省按构建根约定:<构建根>/<id>/plugin.js", () => {
    makePlugin(join(root, "kernels", "pi"), "pi", { order: 1 });
    const entry = scanKernelPlugins(root)[0];
    expect(resolveKernelFactoryPath(entry, BUILD_ROOT)).toBe(join(BUILD_ROOT, "pi", "plugin.js"));
  });

  it("显式 factory(不经构建的第三方内核):相对宿主插件目录解析", () => {
    makePlugin(join(root, "kernels", "kimi"), "kimi", { order: 9 });
    const entry = scanKernelPlugins(root)[0];
    entry.manifest.factory = "./plugin.js";
    expect(resolveKernelFactoryPath(entry, BUILD_ROOT)).toBe(join(root, "kernels", "kimi", "plugin.js"));
  });
});

// ---- 顶层 version：差量重载的判据之一（boot-surface.md §3.6.2）----
//
// version 必须取自**宿主 manifest 顶层**，不是 `kernel` 块里：内核面块声明的是 order/enabled
// 这类装载策略，版本号属于整个插件包（与壳插件发现用的是同一个字段）。
describe("内核插件清单带 version（差量重载判据）", () => {
  it("version 取自宿主 manifest 顶层，逐条目如实带出", () => {
    makePlugin(join(root, "kernels", "alpha"), "alpha");
    makePlugin(join(root, "kernels", "beta"), "beta");
    // 改 beta 的顶层 version，模拟"用户升级了这个内核插件"
    const betaDir = join(root, "kernels", "beta");
    writeFileSync(join(betaDir, "plugin.json"), JSON.stringify({ id: "beta", version: "0.2.0", kernel: {}, contributes: {} }));
    const entries = scanKernelPlugins(root);
    const byId = new Map(entries.map((e) => [e.manifest.id, e.version]));
    expect(byId.get("alpha")).toBe("0.1.0");
    expect(byId.get("beta"), "顶层 version 变了，扫描结果必须跟着变——否则差量重载看不出改动").toBe("0.2.0");
  });

  it("缺 version / version 不是非空字符串 → 退化为 \"0.0.0\"（不抛、不塞 undefined）", () => {
    // 退化方向是**有意**的：宁可让差量判定偏保守（认为没变），也不要因为读不到版本
    // 就把整个重载做成"全部重装"（那会重跑所有内核的 ensure* 首次准备，代价大且可能扰动运行中的会话）。
    const d1 = join(root, "kernels", "nover"); mkdirSync(d1, { recursive: true });
    writeFileSync(join(d1, "plugin.json"), JSON.stringify({ id: "nover", kernel: {}, contributes: {} }));
    const d2 = join(root, "kernels", "badver"); mkdirSync(d2, { recursive: true });
    writeFileSync(join(d2, "plugin.json"), JSON.stringify({ id: "badver", version: 42, kernel: {}, contributes: {} }));
    const d3 = join(root, "kernels", "emptyver"); mkdirSync(d3, { recursive: true });
    writeFileSync(join(d3, "plugin.json"), JSON.stringify({ id: "emptyver", version: "", kernel: {}, contributes: {} }));
    const byId = new Map(scanKernelPlugins(root).map((e) => [e.manifest.id, e.version]));
    expect(byId.get("nover")).toBe("0.0.0");
    expect(byId.get("badver"), "非字符串 version 不能被原样带出（消费者按 string 用）").toBe("0.0.0");
    expect(byId.get("emptyver"), "空串等同于没有").toBe("0.0.0");
  });

  it("`kernel` 块里写的 version 不生效（顶层才是单源，与 id 单源同款纪律）", () => {
    const d = join(root, "kernels", "alpha"); mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "plugin.json"), JSON.stringify({
      id: "alpha", version: "0.1.0", kernel: { version: "9.9.9" }, contributes: {},
    }));
    const [entry] = scanKernelPlugins(root);
    expect(entry.version, "内核面块不是版本号的来源").toBe("0.1.0");
  });

  it("真实内核插件的 manifest 都带 version（否则差量重载对它们永远判\"没变\"）", async () => {
    // 这条不是纯逻辑单测，而是**对仓库现状的守卫**：三个真实内核插件（pi/dsh 在 src/plugins、
    // minimal 在 test-plugins）都必须有顶层 version。少了它，重载会静默不生效——
    // 而"静默不生效"正是 §3.6.2 点名要避免的后果。
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    // ⚠ __dirname = <repo>/src/server/kernel/core，所以要退 **4** 层才到仓库根。
    //   这是本轮第三次犯同一个 off-by-one（前两次在 locale 目录推导上，写进 skill §17.2 第 6 条）。
    //   对策不是"下次小心点"，而是**推导完立刻断言路径本身**——否则错误只在 ENOENT 时才暴露，
    //   而 ENOENT 的消息（`src/src/plugins/...`）还得反推才知道是层数错了。
    const repo = resolve(__dirname, "..", "..", "..", "..");
    expect(existsSync(join(repo, "package.json")), `仓库根推导错了：${repo}`).toBe(true);
    expect(existsSync(join(repo, "src", "plugins")), `仓库根推导错了（缺 src/plugins）：${repo}`).toBe(true);
    for (const rel of ["src/plugins/kernels/pi/plugin.json", "src/plugins/kernels/dsh/plugin.json", "test-plugins/kernels/minimal/plugin.json"]) {
      const m = JSON.parse(readFileSync(join(repo, rel), "utf-8")) as { version?: unknown };
      expect(typeof m.version === "string" && m.version.length > 0, `${rel} 缺顶层 version`).toBe(true);
    }
  });
});
