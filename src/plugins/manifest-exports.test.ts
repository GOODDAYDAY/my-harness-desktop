// manifest 组件声明 ↔ renderer 入口 exports 静态守卫(§3.7 守卫闭环 / §7.4 组件自动匹配)。
//
// 根因背景:框架加载 renderer module 后按 manifest 的 contributes.*[].component 字段在
// module exports 里找同名组件自动注册(registerPluginComponents / getPluginComponent),
// 找不到就是静默缺席——stickers 的 StickerComposerButton 曾因 index.tsx 漏 re-export,
// composer 快速入口长期不渲染,无任何报错信号。本守卫把「manifest 声明的每个组件名
// 必须能从 renderer 入口导出(含相对路径 re-export 链)」钉成 CI 断言。
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const PLUGINS_ROOT = resolve(__dirname, ".");

/** 递归找所有 plugin.json 所在目录(i18n 语言资源 plugin.json 无 id,被滤掉)。 */
function* walkPluginDirs(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (!statSync(p).isDirectory()) continue;
    if (existsSync(join(p, "plugin.json"))) {
      try {
        const m = JSON.parse(readFileSync(join(p, "plugin.json"), "utf-8")) as { id?: unknown };
        if (typeof m.id === "string" && m.id) { yield p; continue; }
      } catch { /* 损坏 manifest 由 loader 侧报 */ }
    }
    yield* walkPluginDirs(p);
  }
}

/** 收集一个 TS/TSX 模块的具名导出(含相对路径 re-export 递归,循环引用安全)。 */
function collectExports(file: string, seen = new Set<string>()): Set<string> {
  if (seen.has(file) || !existsSync(file)) return new Set();
  seen.add(file);
  const src = readFileSync(file, "utf-8");
  const out = new Set<string>();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|const|class|let|var)\s+([A-Za-z0-9_]+)/g)) out.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]+)\}(?:\s*from\s*["']([^"']+)["'])?/g)) {
    for (const part of m[1].split(",")) {
      const as = part.trim().match(/(?:.+?\s+as\s+)?([A-Za-z0-9_]+)$/);
      if (as) out.add(as[1]);
    }
    // `export { X } from "./y"` —— 名字已在本地登记,无需递归也能匹配组件名
  }
  // `export * from "./y"` —— 必须递归跟相对路径
  for (const m of src.matchAll(/export\s*\*\s*from\s*["'](\.[^"']+)["']/g)) {
    const base = resolve(dirname(file), m[1]);
    for (const ext of [".tsx", ".ts", "/index.tsx", "/index.ts"]) {
      const target = base.endsWith(ext) ? base : base + ext;
      if (existsSync(target)) {
        for (const name of collectExports(target, seen)) out.add(name);
        break;
      }
    }
  }
  return out;
}

describe("manifest 组件声明 ↔ renderer exports 对账(全插件)", () => {
  const pluginDirs = [...walkPluginDirs(PLUGINS_ROOT)];

  it("扫描到插件(防 glob 漂移成 0)", () => {
    expect(pluginDirs.length).toBeGreaterThan(40);
  });

  it("每个 contributes.*[].component 都能从 renderer 入口导出", () => {
    const missing: string[] = [];
    for (const dir of pluginDirs) {
      const rel = dir.slice(PLUGINS_ROOT.length + 1);
      const manifest = JSON.parse(readFileSync(join(dir, "plugin.json"), "utf-8")) as {
        contributes?: Record<string, unknown>;
      };
      const entry = ["renderer/index.tsx", "renderer/index.ts"]
        .map((r) => join(dir, r))
        .find((f) => existsSync(f));
      const names: { slot: string; name: string }[] = [];
      for (const [slot, items] of Object.entries(manifest.contributes ?? {})) {
        if (!Array.isArray(items)) continue;
        for (const it of items as { component?: unknown }[]) {
          if (typeof it?.component === "string" && it.component) names.push({ slot, name: it.component });
        }
      }
      if (!names.length) continue;
      if (!entry) {
        missing.push(`${rel}: 声明了组件(${names.map((n) => n.name).join(",")})但无 renderer/index 入口`);
        continue;
      }
      const exported = collectExports(entry);
      for (const { slot, name } of names) {
        if (!exported.has(name)) missing.push(`${rel}: 槽位 ${slot} 的组件「${name}」未从 renderer 入口导出`);
      }
    }
    expect(missing).toEqual([]);
  });
});
