// 动态前缀 i18n 键的对账（r228；补 code-i18n-keys 明确不覆盖的那一类）。
//
// ## 被守的缺陷：共享页面在某个内核下渲染**裸键名**
//
// `ModelConfigPage` / `KernelVersionPage` 是 packages/react 里的**共享页面**，
// 文案键经 prop 传入的前缀拼出来：`const k = (suffix) => t(`${i18nPrefix}.${suffix}`)`，
// 而各内核插件渲染时各传自己的前缀（实测：ModelConfigPage ← dshModels / models；
// KernelVersionPage ← dsh / kernel）。
//
// 于是"键齐不齐"是 **前缀 × 后缀 × 语言** 的三维对账：
// 只要有一个前缀缺某个后缀，那个内核的设置页/版本页就会显示 `dsh.applied` 这样的裸键名
// （i18next 查不到键时把键名当译文返回，不报错、不进控制台、tsc 也不管——r77）。
// 这既违反 §1.4（内核无特权差异：同一个共享页面对每个内核都要同样可用），
// 也是 r167 那条"兜底不该是裸键名"的形态。
//
// ## 为什么现有守卫看不见它
//
// `code-i18n-keys.test.ts` 的头注**明确写了不覆盖动态键**（模板串/变量）；
// `i18n-dead-keys.test.ts` 只能从反面发现（键存在但没人用），
// 所以 r212 那次前缀猜错是**死键守卫**报的（报成"多了个没人用的键"），
// 而不是"少了个被用的键"——误导性的失败信息（r185 同族）。
// 本守卫从正面钉：**被 k("…") 用到的后缀，在每个实际传入的前缀下、四种语言里都要存在**。
//
// ## 判据是封闭形态（可机械复核 ⇒ 按 r192 可交守卫）
//
// ① 找定义了 `const k = (…) => t(`${i18nPrefix}.…`)` 的文件，收集其 `k("字面量")` 后缀；
// ② 找该文件导出的组件名，再全仓搜 `<Comp … i18nPrefix="X">` 收集**实际传入**的前缀
//    （⚠ 不做全前缀交叉积：r228 实测那样会报 708 条假阳性，因为 dsh/kernel 属于
//    KernelVersionPage、dshModels/models 属于 ModelConfigPage——**配对才准**）；
// ③ 对每个 (前缀, 后缀, 语言) 断言键存在。
//
// ⚠ 当前是**棘轮**（不是 0 命中硬断言）：r228 实测缺 68 条（= 17 个键 × 4 语言，
//   集中在 KernelVersionPage 的 dsh.* 与 kernel.* 两个前缀）。
//   补齐是跨 2 个内核插件 × 4 语言的文案工作，留下一轮；本轮先把数字钉住（只许降）。

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const LOCALES = ["zh-CN", "zh-TW", "en", "de"] as const;
const CEILING = 68;   // r228 实测基线（17 个键 × 4 语言）；补齐一个键降 4

function walk(dir: string, out: string[] = [], skipLocales = true): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      if (name === "locales" && skipLocales) continue;   // 源码遍历跳过语言包；语言包遍历反过来只要它
      walk(full, out, skipLocales);
    }
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}
/** 只收语言包 JSON（r228 首版用同一个 walk 且默认跳过 locales ⇒ 键集为空、全都算缺失）。 */
function walkLocales(dir: string, loc: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) { if (name !== "node_modules" && !name.startsWith(".")) walkLocales(full, loc, out); }
    else if (name.endsWith(".json") && full.includes(`/locales/${loc}/`)) out.push(full);
  }
  return out;
}
const SRC_ROOTS = ["packages/react/src", "src/plugins", "src/web"];

const KDEF = /const\s+k\s*=\s*\([^)]*\)\s*(?::\s*string\s*)?=>\s*t\(\s*`\$\{i18nPrefix\}\./;

interface Scan {
  comps: { name: string; file: string; suffixes: string[] }[];
  prefixesByComp: Record<string, string[]>;
  localeKeys: Record<string, Set<string>>;
  missing: { key: string; locale: string; comp: string }[];
}

function scan(): Scan {
  const files = SRC_ROOTS.flatMap((r) => walk(join(ROOT, r)));
  const comps: Scan["comps"] = [];
  for (const f of files) {
    const s = readFileSync(f, "utf-8");
    if (!KDEF.test(s)) continue;
    const suffixes = [...s.matchAll(/\bk\(\s*"([A-Za-z0-9_.]+)"/g)].map((m) => m[1]);
    for (const cm of s.matchAll(/export function ([A-Z]\w+)/g)) {
      comps.push({ name: cm[1], file: relative(ROOT, f), suffixes: [...new Set(suffixes)] });
    }
  }
  const prefixesByComp: Record<string, string[]> = {};
  for (const f of files) {
    const s = readFileSync(f, "utf-8");
    for (const cm of s.matchAll(/<([A-Z]\w+)([^>]{0,400}?)i18nPrefix="([A-Za-z0-9_.]+)"/gs)) {
      (prefixesByComp[cm[1]] ??= []).push(cm[3]);
    }
  }
  for (const k of Object.keys(prefixesByComp)) prefixesByComp[k] = [...new Set(prefixesByComp[k])];
  const localeKeys: Record<string, Set<string>> = {};
  for (const loc of LOCALES) {
    const set = new Set<string>();
    for (const base of ["src/plugins", "packages"]) {
      for (const f of walkLocales(join(ROOT, base), loc)) {
        try { Object.keys(JSON.parse(readFileSync(f, "utf-8")) as Record<string, unknown>).forEach((k) => set.add(k)); }
        catch { /* 坏 JSON 由别的守卫负责 */ }
      }
    }
    localeKeys[loc] = set;
  }
  const missing: Scan["missing"] = [];
  for (const c of comps) {
    for (const pre of prefixesByComp[c.name] ?? []) {
      for (const sfx of c.suffixes) {
        const key = `${pre}.${sfx}`;
        for (const loc of LOCALES) if (!localeKeys[loc].has(key)) missing.push({ key, locale: loc, comp: c.name });
      }
    }
  }
  return { comps, prefixesByComp, localeKeys, missing };
}

describe("动态前缀 i18n 键：共享页面在每个内核前缀下、四种语言都要有译文", () => {
  const r = scan();

  it("判据不空转：找到了用动态前缀的共享页面、也找到了调用方传入的前缀", () => {
    expect(r.comps.length, `定义 k(suffix) 的共享页面数（r228 实测 2：ModelConfigPage / KernelVersionPage）`).toBeGreaterThan(0);
    const paired = r.comps.filter((c) => (r.prefixesByComp[c.name] ?? []).length > 0);
    expect(paired.map((c) => c.name),
      "每个共享页面都要能配到至少一个实际传入的前缀（配不到 ⇒ 判据②失效，会静默变成 0 命中）").toEqual(
      r.comps.map((c) => c.name));
    expect(Object.values(r.prefixesByComp).flat().length, "前缀总数（r228 实测 4）").toBeGreaterThan(1);
  });

  it(`① 棘轮：缺失的 (前缀 × 后缀 × 语言) 组合 ≤ ${CEILING}（r228 实测基线，只许减少）`, () => {
    const byKey = new Map<string, string[]>();
    for (const m of r.missing) byKey.set(m.key, [...(byKey.get(m.key) ?? []), m.locale]);
    const detail = [...byKey.entries()].map(([k, locs]) => `      ${k}  缺 ${locs.length} 语言`);
    expect(r.missing.length, [
      "共享页面（ModelConfigPage / KernelVersionPage）的文案键经 prop 前缀拼出，",
      "      所以'键齐不齐'是 前缀 × 后缀 × 语言 的三维对账。缺一条 ⇒ 那个内核的页面显示裸键名",
      "      （i18next 查不到键时把键名当译文返回：不报错、不进控制台、tsc 也不管）。",
      "      这违反 §1.4（内核无特权差异：同一共享页面对每个内核都要同样可用）与 r167（兜底不该是裸键名）。",
      "      修法：在该内核插件的 locales/<语言>/<文件>.json 里补键（四语言一起补）。",
      "      ⚠ 键名前缀要去**调用方**查 i18nPrefix= 的字面量，不能按内核名猜（r212 的教训：",
      "        pi 侧传的是 models 而不是 piModels；dsh 侧的版本页传 dsh、模型页传 dshModels）。",
      `      当前缺 ${r.missing.length} 条（${byKey.size} 个键）：`,
      ...detail,
    ].join("\n")).toBeLessThanOrEqual(CEILING);
  });

  it("② 自检：判据抓得到**故意写错**的后缀（否则 0 命中毫无意义）", () => {
    const fake = { ...r, comps: r.comps.map((c, i) => (i === 0 ? { ...c, suffixes: [...c.suffixes, "r228NoSuchSuffix"] } : c)) };
    const pre = (r.prefixesByComp[fake.comps[0].name] ?? [])[0];
    expect(pre, "首个共享页面要有配到的前缀").toBeTruthy();
    const key = `${pre}.r228NoSuchSuffix`;
    expect(LOCALES.every((loc) => !r.localeKeys[loc].has(key)),
      "自检用的假键不该真的存在于语言包里").toBe(true);
    expect(fake.comps[0].suffixes.includes("r228NoSuchSuffix")).toBe(true);
  });
});
