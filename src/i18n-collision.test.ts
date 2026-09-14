// 插件 i18n 文案守卫（静态门）——两类真实缺陷，都从"两份定义"长出来。
//
// 缺陷一：**同一个 ns+key 被两个插件定义成不同的值**。
//   i18n 合并规则是 key 级 union、同优先级「先处理者胜」（application/i18n/merge.ts §2.6.1），
//   于是"哪个值生效"取决于**插件加载顺序**——用户看到的文案会随安装/加载次序变化。
//   实测就发生过：pi 与 dsh 各交一份 `ext.json`，`ext.empty`（"还没有 extension" / "还没有拓展"）、
//   `ext.sourcePlaceholder`（pi 的 `@scope/pkg…` / dsh 的 `@deepseek-ai/dsh-xxx…`）两侧取值不同，
//   而消费方 `KernelExtensionsPage` 是**内核无关的共享 base** —— 结果 dsh 的扩展页可能提示 pi 的包名形状。
//
// 缺陷二：**共享基座用的文案，由某个内核插件供给**。
//   内核插件是**可卸载**的（这是本项目的硬要求）。文案若由 pi 插件供给，卸掉 pi 之后
//   另一个内核的拓展页就没字了 —— "能卸载"当场变成假的。所以共享 base 消费的 key
//   必须来自**非内核插件**（框架层：语言插件）。
//
// 判据全部自动派生，不写手写清单（手写清单会过期，本仓反复吃过这个亏）：
//   ① 扫 src/plugins/**/plugin.json 的 contributes.languages → 逐 locale 展开 resources JSON；
//   ② 交叉比对同一 (locale, ns, key) 的多个贡献者与取值；
//   ③ 从共享组件源码里抽 `t("…")` 用到的 key，反查其贡献者是不是内核插件。
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

interface Contribution {
  pluginId: string;
  pluginDir: string;
  locale: string;
  resources: string;
}

/** 所有壳插件的 languages 贡献项（结构同 discoverPlugins：plugins/<组>/<插件>/plugin.json）。 */
function languageContributions(): Contribution[] {
  const out: Contribution[] = [];
  const pluginsRoot = join(ROOT, "src/plugins");
  for (const group of readdirSync(pluginsRoot)) {
    const groupDir = join(pluginsRoot, group);
    if (!statSync(groupDir).isDirectory()) continue;
    for (const name of readdirSync(groupDir)) {
      const dir = join(groupDir, name);
      if (!statSync(dir).isDirectory()) continue;
      const manifestPath = join(dir, "plugin.json");
      if (!existsSync(manifestPath)) continue;
      let manifest: { id?: string; contributes?: { languages?: { locale?: string; resources?: string }[] } };
      try {
        manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      } catch {
        continue;
      }
      for (const l of manifest.contributes?.languages ?? []) {
        if (!l.locale || !l.resources) continue;
        out.push({ pluginId: manifest.id ?? name, pluginDir: dir, locale: l.locale, resources: l.resources });
      }
    }
  }
  return out;
}

/** 展开贡献项：`${locale}|${ns}|${key}` → 贡献者+取值。 */
function expandedKeys(): Map<string, { pluginId: string; value: string }[]> {
  const map = new Map<string, { pluginId: string; value: string }[]>();
  for (const c of languageContributions()) {
    // resources 以 "./" 开头、相对插件目录（与加载器同规则）
    const file = resolve(c.pluginDir, c.resources);
    if (!existsSync(file)) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
    } catch {
      continue;
    }
    for (const [rawKey, value] of Object.entries(parsed)) {
      if (typeof value !== "string") continue;
      // 与 merge.ts 同规则：第一个 dot 前是 ns，其余是 key
      const dot = rawKey.indexOf(".");
      const ns = dot === -1 ? "common" : rawKey.slice(0, dot);
      const key = dot === -1 ? rawKey : rawKey.slice(dot + 1);
      const k = `${c.locale}|${ns}|${key}`;
      const list = map.get(k) ?? [];
      list.push({ pluginId: c.pluginId, value });
      map.set(k, list);
    }
  }
  return map;
}

/** 内核插件 id：目录形状 `<插件根>/kernels/<id>/` 且带 kernel 面（这里按目录判定，与布局同源）。
 *  **两个根**:src/plugins(随壳分发)与 test-plugins(测试专用插件,如 minimal)——测试专用插件的
 *  文案同样要进碰撞检查,否则它拿到与别人同名的 key 时没人会红。 */
function kernelPluginIds(): Set<string> {
  const out = new Set<string>();
  for (const root of ["src/plugins/kernels", "test-plugins/kernels"]) {
    const dir = join(ROOT, root);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const manifestPath = join(dir, name, "plugin.json");
      if (!existsSync(manifestPath)) continue;
      try {
        out.add((JSON.parse(readFileSync(manifestPath, "utf-8")) as { id?: string }).id ?? name);
      } catch { /* 损坏 manifest 由别的守卫管 */ }
    }
  }
  return out;
}

/** 共享基座组件源码里 `t("…")` 用到的 i18n key（自动派生，不写清单）。 */
function keysUsedBySharedBase(): Set<string> {
  const file = join(ROOT, "packages/react/src/kernel-extensions-page.tsx");
  const text = readFileSync(file, "utf-8");
  const out = new Set<string>();
  for (const m of text.matchAll(/\bt\(\s*"([A-Za-z][\w.]*)"/g)) out.add(m[1]);
  // 动态模板键 t(`ext.tag.${tag}`) 的公共前缀也收进来（按前缀反查贡献者）
  for (const m of text.matchAll(/\bt\(\s*`([A-Za-z][\w.]*?)\.\$\{/g)) out.add(`${m[1]}.`);
  return out;
}

describe("插件 i18n 文案：同 key 不许两家给出不同值（谁生效取决于加载顺序）", () => {
  const expanded = expandedKeys();

  it("判据本身不空转（确实展开了多插件的语言文件）", () => {
    expect(expanded.size).toBeGreaterThan(50);
    const contributors = new Set([...expanded.values()].flat().map((x) => x.pluginId));
    expect(contributors.size, "只扫到一个插件，判据失效").toBeGreaterThan(2);
  });

  it("同一 (locale, ns, key) 被多个插件定义时，取值必须一致", () => {
    const conflicts: string[] = [];
    for (const [k, contributors] of expanded) {
      const distinct = [...new Set(contributors.map((c) => c.value))];
      if (contributors.length > 1 && distinct.length > 1) {
        conflicts.push(`${k} → ${contributors.map((c) => `${c.pluginId}=${JSON.stringify(c.value)}`).join(" | ")}`);
      }
    }
    expect(
      conflicts.sort(),
      "同一 ns+key 由多个插件给出**不同**文案：i18n 合并是「同优先级先处理者胜」，" +
        "于是显示哪个值取决于插件加载顺序（用户看到的文案会随次序变化）。" +
        "通用文案应归语言插件单一来源，内核/插件专属的改走各自 namespace 或 prop。\n",
    ).toEqual([]);
  });
});

describe("共享基座消费的文案必须由非内核插件供给（内核插件可卸载）", () => {
  const expanded = expandedKeys();
  const kernelIds = kernelPluginIds();
  const used = keysUsedBySharedBase();

  it("判据本身不空转（抽到了 key，且识别出了内核插件）", () => {
    expect(used.size).toBeGreaterThan(5);
    expect(kernelIds.size).toBeGreaterThan(1);
  });

  it("KernelExtensionsPage 用到的每个 key，至少有一个非内核贡献者", () => {
    const orphans: string[] = [];
    for (const key of used) {
      const isPrefix = key.endsWith(".");
      const hits = [...expanded.entries()].filter(([k]) => {
        const parts = k.split("|");
        const full = `${parts[1]}.${parts[2]}`;
        return isPrefix ? full.startsWith(key) : full === key;
      });
      if (hits.length === 0) {
        orphans.push(`${key} → 无任何插件贡献`);
        continue;
      }
      const nonKernel = hits.some(([, cs]) => cs.some((c) => !kernelIds.has(c.pluginId)));
      if (!nonKernel) orphans.push(`${key} → 只由内核插件贡献（${hits.flatMap(([, cs]) => cs.map((c) => c.pluginId)).join(",")}）`);
    }
    expect(
      orphans.sort(),
      "共享 base 的文案若只由内核插件供给，卸掉那个内核插件后页面就没字了——「能卸载」当场变成假的。" +
        "共享 UI 的通用文案应归语言插件。\n",
    ).toEqual([]);
  });
});
