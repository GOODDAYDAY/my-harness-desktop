// manifest 声明的 `component` 名 ↔ 插件 renderer 模块的**导出名**对账（r63）。
//
// ## 被守的缺陷形态
//
// 壳解析贡献组件的方式是**按字符串查模块导出**（`packages/react/src/index.ts` 的
// `registerPluginComponents`）：
//
// ```ts
// const comp = asReactComponent(module[item.component]);
// if (comp) registry.set(item.component, comp);
// else console.warn(`[registerPluginComponents] 组件 ${item.component} 未在 module exports 中找到 …`);
// ```
//
// 所以 manifest 里写错一个组件名（打字错、重命名组件时忘了改 manifest、
// 或组件存在但**没从 `renderer/index.tsx` 导出**），后果是：
// **只有一条 console.warn，界面上那个槽位静默空白**。不抛错、不变红、
// 正向剧本也撞不到（没人会去点一个不存在的开关/面板）。
// 这是"文件是否对应"里最难发现的一类：两侧都"看起来对"，只有名字对不上。
//
// ## 判据
//
// 对每个带 `renderer` 字段的 manifest，解析它的入口模块，收集**全部导出名**
// （`export function/const/class`、`export { A, B }`、`export { A } from "./x"`、
// `export * from "./x"`——后两种要递归进被引用的模块），
// 再核对五个槽位（`settings`（含 `tabs`）/ `sidePanel` / `sidebar` / `mainView` / `titlebar`）
// 里声明的每个 `component` 是否在其中。
//
// ⚠ 必须处理 re-export：插件的 `renderer/index.tsx` 通常只是**汇出口**
// （如 sub-agent 的 `export { SubAgentPanel } from "./panel"`），
// 只扫入口文件本身的 `export function` 会把绝大多数组件判成"缺失"。
//
// r63 首测：32 个声明的 component，错配 **0** 个 —— 所以这是一条**预防性**守卫
// （当前没有缺陷，但失败模式是静默的，值得钉住）。

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative, resolve as presolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const PLUGIN_ROOTS = ["src/plugins", "test-plugins"];
/** 会带 `component` 字段的**全部**槽位。
 *
 *  ⚠ r63 首版只列了 `registerPluginComponents` 处理的那 4 个（+ settings），
 *  而契约里带 `component` 字段的贡献**共 14 种**（逐个提取 21 种贡献的字段后数出来的）。
 *  其余 9 种走**另外两条**解析路径，失败模式一条比一条静默：
 *    · `registerPluginMessageRenderers`（`index.ts:470`）——查不到只 `console.warn`；
 *    · `getPluginComponent(pluginId, name)`（`plugin-modules.ts:31`）——查不到
 *      **直接 return undefined，连 warn 都没有**（blockRenderers / codeBlockRenderers /
 *      messageActions / composer{Stats,Top,Actions,Attachments,Voice} 都走这条）。
 *  所以"组件名对不上"在这 9 种上是**完全静默**的：槽位空着，没有任何线索。
 *  这正是 r42 那类缺陷（守卫的覆盖面小于它声称的覆盖面）——首版守卫看着绿，
 *  其实只守了三分之一的面。 */
const SLOTS = [
  "sidePanel", "sidebar", "mainView", "titlebar",
  "messageRenderers", "messageActions", "blockRenderers", "codeBlockRenderers",
  "composerAttachments", "composerActions", "composerStats", "composerTop", "composerVoice",
] as const;

function stripBlockComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** 把 `./panel` 这类说明符解析成真实文件（含 .tsx/.ts/index.tsx/index.ts 兜底）。 */
function resolveModule(baseDir: string, spec: string): string | null {
  // 发布面（@scope/…）与裸包名不是本插件内的文件；相对路径两种写法都接受
  // （`./renderer/index.tsx` 与 `renderer/index.tsx`——r63 实测 system/i18n 用的是后者，
  //  首版判据只认前者，于是把它误判成"入口不存在、导出 0 个名字"）。
  if (spec.startsWith("@") || /^[^./]/.test(spec) && !spec.startsWith("renderer")) return null;
  if (!spec.startsWith(".")) spec = `./${spec}`;
  const p = presolve(baseDir, spec);
  for (const cand of [p, `${p}.tsx`, `${p}.ts`, join(p, "index.tsx"), join(p, "index.ts")]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return null;
}

/** 收集一个模块导出的**全部名字**（含 re-export 与 `export *`，递归）。 */
function exportsOf(file: string | null, seen = new Set<string>()): Set<string> {
  const out = new Set<string>();
  if (!file) return out;
  const real = presolve(file);
  if (seen.has(real)) return out;
  seen.add(real);
  const src = stripBlockComments(readFileSync(file, "utf-8"));
  const base = dirname(file);

  for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) out.add(m[1]);
  for (const m of src.matchAll(/export\s+(?:const|let|class)\s+([A-Za-z_$][\w$]*)/g)) out.add(m[1]);
  // `export { A, B as C }` 与 `export { A } from "./x"`
  for (const m of src.matchAll(/export\s*\{([^}]*)\}\s*(?:from\s*["']([^"']+)["'])?/g)) {
    for (const part of m[1].split(",")) {
      const t = part.trim();
      if (!t) continue;
      const name = t.includes(" as ") ? t.split(" as ")[1].trim() : t;
      if (name) out.add(name);
    }
    if (m[2]) for (const n of exportsOf(resolveModule(base, m[2]), seen)) out.add(n);
  }
  for (const m of src.matchAll(/export\s*\*\s*from\s*["']([^"']+)["']/g)) {
    for (const n of exportsOf(resolveModule(base, m[1]), seen)) out.add(n);
  }
  return out;
}

interface Decl { plugin: string; slot: string; id: string; component: string; manifest: string }

function declarations(): Decl[] {
  const out: Decl[] = [];
  for (const rootName of PLUGIN_ROOTS) {
    const root = join(ROOT, rootName);
    if (!existsSync(root)) continue;
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop()!;
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) { if (name !== "node_modules" && !name.startsWith(".")) stack.push(full); continue; }
        if (name !== "plugin.json") continue;
        const m = JSON.parse(readFileSync(full, "utf-8")) as {
          id?: string;
          renderer?: string;
          contributes?: Record<string, unknown>;
        };
        if (!m.renderer || !m.contributes) continue;
        const pluginDir = dirname(full);
        const push = (slot: string, id: string, component: unknown): void => {
          if (typeof component === "string" && component) out.push({ plugin: m.id ?? "?", slot, id, component, manifest: relative(ROOT, full) });
        };
        for (const slot of SLOTS) {
          const items = m.contributes[slot];
          if (Array.isArray(items)) {
            for (const it of items) {
              if (!it || typeof it !== "object") continue;
              const o = it as { id?: string; role?: string; component?: string };
              // `messageRenderers` 没有 id，用 role 当标识（它是该槽的键）
              push(slot, o.id ?? (o.role ? `role=${o.role}` : "?"), o.component);
            }
          }
        }
        const settings = m.contributes.settings;
        if (Array.isArray(settings)) {
          for (const s of settings) {
            if (!s || typeof s !== "object") continue;
            push("settings", (s as { id?: string }).id ?? "?", (s as { component?: string }).component);
            const tabs = (s as { tabs?: unknown }).tabs;
            if (Array.isArray(tabs)) for (const t of tabs) if (t && typeof t === "object") push("settings.tabs", (t as { id?: string }).id ?? "?", (t as { component?: string }).component);
          }
        }
        // 记录入口，供判据解析导出
        // ⚠ 传**原始**说明符（形如 `./renderer/index.tsx`）：resolveModule 以 "./" 开头为判据
        //   区分"本插件内的相对路径"与"发布面/裸包"，剥掉前缀会让所有入口解析成 null
        //   （首版就是这么错的，症状是 32 个组件全部"导出 0 个名字"）。
        entries.set(relative(ROOT, full), resolveModule(pluginDir, m.renderer));
      }
    }
  }
  return out;
}

/** manifest（相对路径）→ renderer 入口文件。 */
const entries = new Map<string, string | null>();

describe("manifest 的 component 名 ↔ renderer 模块导出：必须对得上", () => {
  const decls = declarations();

  it("判据不空转：确实扫到了 manifest 与组件声明，且数量与已知事实一致", () => {
    expect(entries.size, "一个带 renderer 的 manifest 都没扫到 = 路径或字段名变了").toBeGreaterThan(20);
    // r64 实测：扩到全部 14 种带 component 的槽位后，声明数从 32 升到 55+
    expect(decls.length, `只扫到 ${decls.length} 个 component 声明（r64 实测 ≥55）——判据可能漏了某个槽位`).toBeGreaterThanOrEqual(50);
    const slots = new Set(decls.map((d) => d.slot));
    expect(slots.size, `只覆盖了 ${slots.size} 种槽位（契约里带 component 的有 14 种 + settings.tabs）`).toBeGreaterThanOrEqual(8);
    // ⚠ 这条是"覆盖面"自检：契约里带 component 的槽位若有新增而 SLOTS 没跟上，
    //   守卫会静默少守一块（r63 首版就是这么漏掉 9 种的）。
    for (const must of ["messageRenderers", "blockRenderers", "composerStats", "messageActions"]) {
      expect(SLOTS as readonly string[], `SLOTS 少了 ${must}（它的组件名错配会完全静默）`).toContain(must);
    }
    // 自检：导出解析必须能穿透 re-export（否则会把绝大多数组件误判成缺失）
    const subAgent = entries.get("src/plugins/sessions/sub-agent/plugin.json");
    expect(subAgent, "找不到 sub-agent 的 renderer 入口（它的 index.tsx 全是 re-export，是最好的自检样本）").toBeTruthy();
    const ex = exportsOf(subAgent ?? null);
    for (const name of ["SubAgentPanel", "SubAgentDialog", "SubAgentSettings"]) {
      expect(ex.has(name), `自检失败：re-export 的 ${name} 没被解析出来 ⇒ 判据会把合法组件误判成缺失`).toBe(true);
    }
  });

  it("① 每个声明的 component 都能在对应插件的 renderer 导出里找到", () => {
    const bad: string[] = [];
    for (const d of decls) {
      const ex = exportsOf(entries.get(d.manifest) ?? null);
      if (!ex.has(d.component)) {
        bad.push(`${d.manifest}  ${d.slot} id=${d.id} → component=${d.component}（该 renderer 导出了 ${ex.size} 个名字，其中没有它）`);
      }
    }
    expect(bad, [
      `${bad.length} 个 manifest 声明的组件名在 renderer 导出里找不到：`,
      ...bad.map((b) => `      ${b}`),
      `      后果（按槽位分三档，一条比一条静默）：`,
      `        · settings/sidePanel/sidebar/mainView/titlebar 与 messageRenderers：`,
      `          壳只 console.warn 一句，槽位静默空白；`,
      `        · blockRenderers/codeBlockRenderers/messageActions/composer* ：`,
      `          走 getPluginComponent()，查不到**直接 return undefined，连 warn 都没有**。`,
      `      三档都不抛错、不变红、正向剧本也撞不到（没人会去点一个不存在的面板）。`,
      `      常见成因：组件重命名时忘了改 manifest；组件存在但没从 renderer/index.tsx 导出；打字错。`,
    ].join("\n")).toEqual([]);
  });

  it("② 每个 manifest 的 renderer 入口都真实存在（否则整个插件的渲染面都是空的）", () => {
    const missing = [...entries.entries()].filter(([, v]) => !v).map(([k]) => k);
    expect(missing, `renderer 入口解析不到文件：\n      ${missing.join("\n      ")}`).toEqual([]);
  });

  it("③ 自检：判据能抓出**故意写错**的组件名（否则①恒真）", () => {
    // 用一个真实入口 + 一个必然不存在的名字，验证"缺失"这条路径真的会命中
    const entry = entries.get("src/plugins/sessions/sub-agent/plugin.json") ?? null;
    const ex = exportsOf(entry);
    expect(ex.has("SubAgentPanel"), "前提：真实组件应能被找到").toBe(true);
    expect(ex.has("SubAgentPanelTypo"), "自检失败：不存在的名字被判成存在 ⇒ ① 恒真、守卫失效").toBe(false);
  });
});
