// 跨 locale 键集一致性守卫 —— 每个插件的每个 ns 文件，各 locale 的键集必须与 `en` 完全相同。
//
// 为什么以 `en` 为基准：`src/web/app/i18n-init.ts:29` 的 `fallbackLng: "en"`。所以
//   · 某 locale 缺键 → 该语言用户看到**英文**（可接受的降级）；
//   · `en` 缺键 → 该语言用户看到英文兜底也没有，最终**漏出裸 i18n key**（不可接受）。
// 两者都算漂移，故一律要求键集相同，而不是只要求 en 是超集。
//
// 为什么需要这条守卫（实测依据）：`scripts/demo/dom-audit.e2e.mjs` 在真实 app 的设置页抓到
// **8 处裸 i18n key**（`fieldDescs.modelThinkingLevels`、`terminal.hyperlinks` 等），根因是
// pi 内核的 settings schema 由 `parseSettingsSchema` 从内核自己的 `settings-manager.d.ts`
// **动态解析**（适配器不硬编码字段清单，内核升级加字段就自动跟着变），而壳的 locale 是
// 手工维护的静态文件——于是"内核加了字段、locale 没跟上"必然反复发生。当时 pi 有 70 个字段
// 而四个 locale 各只有 65 条 `kernel.fields.*`，差的正好是那 5 个新字段。
//
// 这条守卫只保证**各 locale 之间**不漂（补齐后不再有人只改一个语言）。"locale 是否跟上了
// 内核 schema"是另一回事，只能由 dom-audit 的"界面上不得出现裸 key"断言在真实 app 里守
// （因为字段清单要到运行时才解析得出来，静态测试拿不到）。两条守卫各守一半，不可互替。
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "plugins");
const REF_LOCALE = "en";

/** 递归找出所有 `<plugin>/locales/` 目录。 */
function findLocaleDirs(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (!statSync(full).isDirectory()) continue;
    if (name === "locales") { out.push(full); continue; }
    if (name === "node_modules" || name.startsWith(".")) continue;
    findLocaleDirs(full, out);
  }
  return out;
}

const localeDirs = findLocaleDirs(ROOT);

describe("跨 locale 键集一致性（各语言必须同键集，基准 = en）", () => {
  it("判据不空转：确实扫到了插件 locale 目录（实测 39 个 / 320 个 json）", () => {
    // 这条是**自检**：曾经写过一版把 locale 目录算成 `<plugin>/locales/locales`（off-by-one），
    // 于是每个目录都被 `continue` 跳过、报告"0 缺口"——典型的假绿。所以先断言扫到了东西。
    expect(localeDirs.length, "一个 locale 目录都没扫到，说明路径推导错了（假绿）").toBeGreaterThanOrEqual(30);
    const jsons = localeDirs.flatMap((d) =>
      readdirSync(d).filter((l) => statSync(join(d, l)).isDirectory())
        .flatMap((l) => readdirSync(join(d, l)).filter((f) => f.endsWith(".json")).map((f) => join(d, l, f))));
    expect(jsons.length, "扫到的 json 文件数异常少").toBeGreaterThanOrEqual(200);
  });

  it("每个 locale 目录都有 en（fallbackLng 的基准），且各语言的文件名集合一致", () => {
    const problems: string[] = [];
    for (const d of localeDirs) {
      const locs = readdirSync(d).filter((l) => statSync(join(d, l)).isDirectory());
      if (!locs.includes(REF_LOCALE)) problems.push(`${relative(ROOT, d)}: 缺 ${REF_LOCALE}（现有 ${locs.join(",")}）`);
      const fileSets = locs.map((l) => [l, new Set(readdirSync(join(d, l)).filter((f) => f.endsWith(".json")))] as const);
      const refFiles = fileSets.find(([l]) => l === REF_LOCALE)?.[1];
      if (!refFiles) continue;
      for (const [l, fs] of fileSets) {
        if (l === REF_LOCALE) continue;
        for (const f of refFiles) if (!fs.has(f)) problems.push(`${relative(ROOT, d)}/${l}: 缺文件 ${f}`);
        for (const f of fs) if (!refFiles.has(f)) problems.push(`${relative(ROOT, d)}/${l}: 多出文件 ${f}（en 里没有）`);
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("每个 ns 文件的键集在各 locale 间完全相同（缺键与多键都算漂移）", () => {
    const problems: string[] = [];
    for (const d of localeDirs) {
      const locs = readdirSync(d).filter((l) => statSync(join(d, l)).isDirectory());
      const refPath = join(d, REF_LOCALE);
      if (!locs.includes(REF_LOCALE)) continue;
      for (const fn of readdirSync(refPath).filter((f) => f.endsWith(".json"))) {
        const read = (l: string): Set<string> | null => {
          const p = join(d, l, fn);
          try { return new Set(Object.keys(JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>)); }
          catch { return null; }
        };
        const ref = read(REF_LOCALE);
        if (!ref) { problems.push(`${relative(ROOT, d)}/${fn}: en 版解析失败`); continue; }
        for (const l of locs) {
          if (l === REF_LOCALE) continue;
          const cur = read(l);
          if (!cur) { problems.push(`${relative(ROOT, d)}/${l}/${fn}: 缺失或解析失败`); continue; }
          const missing = [...ref].filter((k) => !cur.has(k));
          const extra = [...cur].filter((k) => !ref.has(k));
          if (missing.length) problems.push(`${relative(ROOT, d)}/${l}/${fn}: 缺 ${missing.length} 键 → ${missing.slice(0, 4).join(", ")}${missing.length > 4 ? " …" : ""}`);
          if (extra.length) problems.push(`${relative(ROOT, d)}/${l}/${fn}: 多 ${extra.length} 键（en 里没有）→ ${extra.slice(0, 4).join(", ")}${extra.length > 4 ? " …" : ""}`);
        }
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("所有 locale json 都是合法 JSON 且键为字符串（解析失败会让整个语言包静默失效）", () => {
    const problems: string[] = [];
    for (const d of localeDirs) {
      for (const l of readdirSync(d).filter((x) => statSync(join(d, x)).isDirectory())) {
        for (const fn of readdirSync(join(d, l)).filter((f) => f.endsWith(".json"))) {
          const p = join(d, l, fn);
          try {
            const j = JSON.parse(readFileSync(p, "utf-8")) as unknown;
            if (typeof j !== "object" || j === null || Array.isArray(j)) problems.push(`${relative(ROOT, p)}: 顶层不是对象`);
          } catch (e) {
            problems.push(`${relative(ROOT, p)}: JSON 解析失败 ${(e as Error).message}`);
          }
        }
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });
});
