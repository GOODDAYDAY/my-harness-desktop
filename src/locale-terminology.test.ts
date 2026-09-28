// 用户可见文案的**术语守卫** —— 「底座」是 pi 内核的历史称呼，新文案一律用「内核」。
//
// 依据 CLAUDE.md 开篇术语表：
//   > 历史代码里仍大量用"底座"指代 pi 内核（"pi 底座""底座事件""底座扩展"），
//   > 读到"底座"按"pi 内核"理解，**写新代码/新文档一律用"内核"**。
//
// 为什么值得单立一条守卫（实测依据）：`scripts/demo/timeline-panel-audit.e2e.mjs` 在右面板
// 「请求记录」里抓到一句「记录由随插件注入的**底座**扩展执行」——而 llm-recorder 的记录能力
// 是**内核中立**的（各内核交自己的扩展），这句话对 dsh/minimal 用户是错的。顺藤查出
// **20 个 key × 4 语言 = 66 处**同类文案，且 en/de 也一路沿用旧术语
// （"base extension" / "Basis-Extension" / "Custom pi base" / "pi-Basis"）。
//
// 只守**用户可见文案**（locale JSON 的值 + manifest 的 description/displayName），
// 不守源码注释：注释里的「底座」是历史记录的一部分，CLAUDE.md 明确说"读到按 pi 内核理解"，
// 强行改写反而会让老 commit / 老设计文档的引用对不上。
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "plugins");

/** 旧术语及其外语等价形态（都是同一个"base/底座"概念的历史译法）。 */
const LEGACY: { pattern: RegExp; label: string }[] = [
  { pattern: /底座/, label: "底座（应作「内核」）" },
  { pattern: /\bbase extension\b/i, label: "base extension（应作 kernel extension）" },
  { pattern: /\bpi base\b/i, label: "pi base（应作 pi kernel）" },
  { pattern: /Basis-Extension|Basiserweiterung/i, label: "Basis-Extension（应作 Kernel-Extension）" },
  { pattern: /\bpi-Basis\b/i, label: "pi-Basis（应作 pi-Kernel）" },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      walk(full, out);
    } else if (name.endsWith(".json")) out.push(full);
  }
  return out;
}

/** 只看用户可见的文案：locale 文件的**值** + manifest 的 description/displayName。 */
function userFacingStrings(file: string): { key: string; value: string }[] {
  const j = JSON.parse(readFileSync(file, "utf-8")) as unknown;
  const base = file.split("/").pop();
  const pairs: [string, unknown][] =
    base === "plugin.json"
      // manifest 只有这两个字段是用户可见文案（其余是 id/版本/贡献声明）
      ? [["description", (j as { description?: string }).description],
         ["displayName", (j as { displayName?: string }).displayName]]
      // locale 文件：全部键值都是文案
      : (j && typeof j === "object" ? Object.entries(j as Record<string, unknown>) : []);
  return pairs.flatMap(([key, value]) => (typeof value === "string" ? [{ key, value }] : []));
}

describe("用户可见文案不得使用旧术语「底座 / base / Basis」", () => {
  const files = walk(ROOT).filter((f) =>
    f.includes("/locales/") || f.endsWith("/plugin.json"));

  it("判据不空转：确实扫到了 locale 与 manifest 文件", () => {
    expect(files.length, "一个都没扫到 = 路径错了（假绿）").toBeGreaterThanOrEqual(300);
    expect(files.filter((f) => f.endsWith("/plugin.json")).length).toBeGreaterThanOrEqual(30);
  });

  it("没有任何一条文案含旧术语", () => {
    const problems: string[] = [];
    for (const f of files) {
      let entries: { key: string; value: string }[];
      try { entries = userFacingStrings(f); } catch { continue; }
      for (const { key, value } of entries) {
        for (const { pattern, label } of LEGACY) {
          if (pattern.test(value)) {
            problems.push(`${relative(ROOT, f)} → ${key}: ${label} — 「${value.slice(0, 56)}」`);
          }
        }
      }
    }
    expect(problems, `${problems.length} 处旧术语：\n${problems.slice(0, 12).join("\n")}`).toEqual([]);
  });

  it("四个语言的同一 key 术语一致（不许只改中文、留下英德的 base/Basis）", () => {
    // 这条守的是本次修复的**完整性**：66 处改动横跨 4 个 locale，只改一半的话
    // 上面那条可能仍然绿（比如中文改完、英文没改但英文用的是 "base" 而非 "底座"，
    // 而 LEGACY 里确实收了 base extension——所以这条是双保险，专门盯"某语言漏改"）。
    const dirs = walk(ROOT).filter((f) => f.includes("/locales/zh-CN/"))
      .map((f) => dirname(dirname(f)));
    const problems: string[] = [];
    for (const plug of new Set(dirs)) {
      for (const loc of ["zh-CN", "zh-TW", "en", "de"]) {
        const ldir = join(plug, "locales", loc);
        if (!existsSync(ldir)) continue;
        for (const fn of readdirSync(ldir).filter((x) => x.endsWith(".json"))) {
          let entries: { key: string; value: string }[];
          try { entries = userFacingStrings(join(ldir, fn)); } catch { continue; }
          for (const { key, value } of entries) {
            // 中文侧已改为「内核」的 key，英德侧不该还留着 base/Basis
            if (/kernel|内核|內核|Kernel/i.test(value)) continue;
            if (/\bbase\b|Basis/i.test(value)) {
              problems.push(`${relative(ROOT, join(ldir, fn))} → ${key}: 「${value.slice(0, 56)}」`);
            }
          }
        }
      }
    }
    expect(problems, `${problems.length} 处疑似漏改：\n${problems.slice(0, 10).join("\n")}`).toEqual([]);
  });
});
