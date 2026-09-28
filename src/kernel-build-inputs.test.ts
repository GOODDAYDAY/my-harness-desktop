// 内核构建入口守卫（静态门）—— 守住「加第四个内核 = 加一个目录，构建配置零改动」。
//
// 动机是一次**真实存在的漂移风险**：`electron.vite.config.ts` 曾为三个内核各手写一行 rollup
// input（`"server/kernel/pi/plugin": resolve(...)` 等）。手写清单不会报错——漏掉一个新内核时，
// 它的 `plugin.ts` 被 bundle 进 `assemble` 所在的 chunk，运行时 `out/main/server/kernel/<id>/`
// 目录根本不存在，`loadKernelPlugin` 抛「工厂产物不存在」。而这与 dev 态无关：dev 态也是读
// `out/`，所以症状一致，但归因困难（错误指向构建产物缺失，不指向构建配置漏了一行）。
//
// 现改为按**内容判据**生成（`kernelPluginInputs`：一级子目录里含 `plugin.ts` 的才是内核）。
// 本守卫从两侧各自派生判据、不写手写清单：
//   ① 构建期判据：`src/server/kernel/<id>/plugin.ts` 存在的 id 集合；
//   ② 运行期判据：插件根里 `plugin.json` 带 `kernel` 块的 id 集合（= `scanKernelPlugins` 的选择）；
//   ③ 断言两者一致 —— 不一致就意味着「运行期会扫到、构建期不产出」（→ 启动即抛）
//      或「构建期产出、运行期扫不到」（→ 死产物）。
//   ④ 断言构建配置里没有硬编码的内核名字面量（否则「加内核零改动」是假的）。
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 构建期判据：`src/server/kernel/` 的一级子目录里含 `plugin.ts` 的才是内核。
 *  与 `electron.vite.config.ts` 的 `kernelPluginInputs` 同一判据（两处必须同步改，本文件即守卫）。 */
function buildSideKernelIds(): string[] {
  const root = join(ROOT, "src/server/kernel");
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, d.name, "plugin.ts")))
    .map((d) => d.name)
    .sort();
}

/** 运行期判据：递归找 `plugin.json` 且带 `kernel` 块，内核 id 单源 = manifest 的 `id`
 *  （`kernel-plugin-loader.ts:73` 的 `{ ...parsed.kernel, id: parsed.id }`）。
 *  递归形状与 `scanKernelPlugins` 一致（深度上限 3、命中即止、跳过点目录与 node_modules）。 */
function runtimeSideKernelIds(roots: string[]): string[] {
  const ids: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 3 || !existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (name.startsWith(".") || name === "node_modules") continue;
      const sub = join(dir, name);
      let st;
      try { st = statSync(sub); } catch { continue; }
      if (!st.isDirectory()) continue;
      const manifestPath = join(sub, "plugin.json");
      if (!existsSync(manifestPath)) { walk(sub, depth + 1); continue; }
      let parsed: { id?: string; kernel?: unknown };
      try { parsed = JSON.parse(readFileSync(manifestPath, "utf-8")); } catch { continue; }
      if (typeof parsed.id !== "string" || !parsed.id) continue;   // locale 资源等同名文件
      if (!parsed.kernel) continue;                                 // 普通壳插件，不是内核插件
      ids.push(parsed.id);
    }
  };
  for (const r of roots) walk(join(ROOT, r), 0);
  return [...new Set(ids)].sort();
}

/** 生产扫描根 + 测试专用扫描根。后者不随壳分发，只有测试把它种进隔离 HOME 才装载
 *  （`CLAUDE.md` §6.1），但它的内核同样需要构建产物，所以计入运行期判据。 */
const PLUGIN_ROOTS = ["src/plugins", "test-plugins"];

describe("内核构建入口：构建期判据与运行期判据必须选中同一批内核", () => {
  it("判据本身不空转（两侧都确实解析出了内核）", () => {
    expect(buildSideKernelIds().length, "构建期一个内核都没扫到？").toBeGreaterThan(0);
    expect(runtimeSideKernelIds(PLUGIN_ROOTS).length, "运行期一个内核插件都没扫到？").toBeGreaterThan(0);
  });

  it("每个运行期会装载的内核都有构建产物入口（否则启动即抛「工厂产物不存在」）", () => {
    const build = buildSideKernelIds();
    const runtime = runtimeSideKernelIds(PLUGIN_ROOTS);
    const missing = runtime.filter((id) => !build.includes(id));
    expect(missing, `运行期扫到但构建期不产出: ${missing.join(", ")}（electron.vite.config.ts 的 kernelPluginInputs 判据未覆盖？）`).toEqual([]);
  });

  it("每个构建产物入口都对应一个运行期能扫到的内核（否则是死产物）", () => {
    const build = buildSideKernelIds();
    const runtime = runtimeSideKernelIds(PLUGIN_ROOTS);
    const orphan = build.filter((id) => !runtime.includes(id));
    expect(orphan, `构建期产出但运行期扫不到: ${orphan.join(", ")}（缺 plugin.json 的 kernel 块？）`).toEqual([]);
  });

  it("内核 id 单源：manifest 的 id 与内核目录名一致（构建产物路径按目录名，装载按 manifest.id）", () => {
    // `resolveKernelFactoryPath` 用 `<构建根>/<manifest.id>/plugin.js` 定位，而 rollup input 的
    // 名字来自**目录名**。两者不一致时产物会落到扫不到的路径 —— 与「工厂产物不存在」同症状。
    const build = buildSideKernelIds();
    for (const root of PLUGIN_ROOTS) {
      const ids = runtimeSideKernelIds([root]);
      for (const id of ids) {
        if (!build.includes(id)) continue;   // 上一条例已覆盖
        expect(build, `${root} 的内核 "${id}" 与其目录名不一致（产物会落到扫不到的路径）`).toContain(id);
      }
    }
  });
});

describe("electron.vite.config.ts 不许硬编码内核清单", () => {
  const config = readFileSync(join(ROOT, "electron.vite.config.ts"), "utf-8");
  /** 去掉注释与字符串里的说明文字后，代码部分不应出现内核名字面量。 */
  const codeOnly = config
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");

  it("rollup input 由 kernelPluginInputs 生成，不是手写清单", () => {
    expect(codeOnly).toContain("kernelPluginInputs(");
    expect(codeOnly, "仍在手写内核 input 行？").not.toMatch(/server\/kernel\/(pi|dsh|minimal)\/plugin/);
  });

  it("代码部分零内核名字面量（加内核不需要改本文件）", () => {
    const hits = codeOnly.match(/["'`](pi|dsh|minimal)["'`]/g) ?? [];
    expect(hits, `electron.vite.config.ts 代码里出现内核名字面量: ${hits.join(", ")}`).toEqual([]);
  });

  it("生成器用的是内容判据（子目录含 plugin.ts），不是深度或白名单", () => {
    expect(codeOnly).toMatch(/existsSync\(join\(root, d\.name, "plugin\.ts"\)\)/);
  });
});
