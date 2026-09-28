// manifest 里所有 `*Key` 字段都必须是**四语言齐全**的 i18n 键（r65）。
//
// ## 这条守卫为什么以前写不出来
//
// 贡献契约里 `*Key` 后缀原本有**两种含义**：
//   · i18n 键：`labelKey` / `titleKey` / `descKey` / `childLabelKey` / `readonlyMessageKey`
//   · **数据键**：`customKey`（`session.custom` 的域字段名）、`parentPathKey`（同）
//
// 这个歧义在 r65 一轮里骗了自动化审计**两次**：把数据键当成 i18n 键去查四语言，
// 报出 `subagent.parent_session` 缺 zh-CN/zh-TW/en/de 四条"缺失译文"——
// 而它根本不是文案，是 `session.custom` 里存父会话路径的字段名
// （证据：`sessions-list/renderer/index.tsx` 的 `s.custom[g.parentPathKey]`、
// `sub-agent/core/orchestrator.ts:15` 的注释「平铺 … 键(sessionGroupings 槽是平铺直接访问)」）。
//
// 所以先做了**改名**（`customKey` → `customField`、`parentPathKey` → `parentPathField`，
// 契约 + 发布面类型 + build-kernel + 两个消费方 + manifest 共 12 处，tsc 全程兜底），
// 让规则变干净：**契约里 `*Key` 一律指 i18n 键，数据字段一律 `*Field`**。
// 规则干净之后，本条守卫才成立——否则它必然产假阳性，而假阳性多了守卫就会被人绕过。
//
// ## 判据
//
// 递归遍历每个 manifest 的 `contributes`，凡字段名以 `Key` 结尾且值是字符串的，
// 都当作 i18n 键，要求它在 **zh-CN / zh-TW / en / de** 四个语言包（全仓合并后的键集）里都存在。
// 键写错的后果是**静默**的：`t()` 查不到就回落（显示裸键或 defaultValue），不抛错、不变红。
//
// r65 实测：59 个 `*Key` 引用，四语言缺失 **0** 条。

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const PLUGIN_ROOTS = ["src/plugins", "test-plugins"];
const LOCALES = ["zh-CN", "zh-TW", "en", "de"];

function walkFiles(dir: string, pred: (name: string) => boolean, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) { if (name !== "node_modules" && !name.startsWith(".")) walkFiles(full, pred, out); }
    else if (pred(name)) out.push(full);
  }
  return out;
}

/** 全部语言包合并后的键集（i18n 是扁平合并，所以按 loc 合并所有插件的键）。 */
function localeKeys(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const loc of LOCALES) {
    const set = new Set<string>();
    for (const root of PLUGIN_ROOTS) {
      for (const f of walkFiles(join(ROOT, root), (n) => n.endsWith(".json"))) {
        if (!f.includes(`/locales/${loc}/`)) continue;
        try {
          const obj = JSON.parse(readFileSync(f, "utf-8")) as Record<string, unknown>;
          for (const k of Object.keys(obj)) set.add(k);
        } catch { /* 非法 JSON 由 locale-parity 那条守卫负责报 */ }
      }
    }
    out.set(loc, set);
  }
  return out;
}

interface Ref { manifest: string; path: string; key: string }

/** 递归收集 contributes 里所有 `*Key` 字段的字符串值。 */
function collect(node: unknown, path: string, manifest: string, out: Ref[]): void {
  if (Array.isArray(node)) { node.forEach((v, i) => collect(v, `${path}[${i}]`, manifest, out)); return; }
  if (!node || typeof node !== "object") return;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (typeof v === "string" && /Key$/.test(k)) out.push({ manifest, path: `${path}.${k}`, key: v });
    else collect(v, `${path}.${k}`, manifest, out);
  }
}

function refs(): Ref[] {
  const out: Ref[] = [];
  for (const root of PLUGIN_ROOTS) {
    for (const f of walkFiles(join(ROOT, root), (n) => n === "plugin.json")) {
      const m = JSON.parse(readFileSync(f, "utf-8")) as { contributes?: unknown };
      if (m.contributes) collect(m.contributes, "contributes", relative(ROOT, f), out);
    }
  }
  return out;
}

describe("manifest 的 `*Key` 字段：必须是四语言齐全的 i18n 键", () => {
  const found = refs();
  const packs = localeKeys();

  it("判据不空转：确实扫到了 *Key 引用与四份语言包", () => {
    // r65 实测 59 个引用（labelKey 28 / titleKey 17 / descKey 12 / childLabelKey 1 / readonlyMessageKey 1）
    expect(found.length, `只扫到 ${found.length} 个 *Key 引用（r65 实测 59）——遍历可能漏了嵌套形态`).toBeGreaterThanOrEqual(55);
    for (const loc of LOCALES) {
      expect(packs.get(loc)!.size, `${loc} 语言包一个键都没扫到 = 路径判据坏了（本条会恒真）`).toBeGreaterThan(1000);
    }
  });

  it("① 契约里不该再出现「数据键也叫 *Key」的形态（改名后 *Field 才是数据字段）", () => {
    // 这条守的是**规则本身**：一旦有人新加一个数据字段又叫 xxxKey，本文件的 ② 就会对它产假阳性，
    // 于是有人会把 xxxKey 塞进豁免清单——歧义又回来了。所以直接在这里拦住命名。
    const contract = readFileSync(join(ROOT, "packages/shared/src/domain/contributions.ts"), "utf-8");
    // ⚠ 只扫 **\*Contribution 接口内部**的字段，不扫整个文件：
    //   `sessionKey` 这类运行时会话标识也在这个文件里（属别的接口），它不是 manifest 字段、
    //   也不该被这条规则管。首版扫全文，于是把它报成"语义不明的 \*Key"（假阳性）。
    const bodies: string[] = [];
    for (const m of contract.matchAll(/export interface (\w*Contribution)\s*\{/g)) {
      let i = m.index! + m[0].length;
      let depth = 1;
      const buf: string[] = [];
      while (i < contract.length && depth > 0) {
        const c = contract[i];
        if (c === "{") depth += 1;
        else if (c === "}") depth -= 1;
        if (depth > 0) buf.push(c);
        i += 1;
      }
      bodies.push(buf.join(""));
    }
    expect(bodies.length, "一个 \*Contribution 接口都没解析到 ⇒ 判据空转").toBeGreaterThan(10);
    const dataKeyish = bodies
      .flatMap((b) => [...b.matchAll(/^\s*(\w*Key)\s*:\s*string;/gm)].map((x) => x[1]))
      .filter((n) => !/(label|title|desc|description|message|name)Key$/i.test(n));
    expect(dataKeyish, [
      `契约里出现了语义不明的 *Key 字段：${dataKeyish.join(", ")}`,
      `      规则（r65 定）：*Key = i18n 键（必须在四语言里存在）；数据字段名用 *Field。`,
      `      若这是数据字段，请改名为 *Field；若确实是 i18n 键，请把它的名字形态补进上面的白名单正则。`,
    ].join("\n")).toEqual([]);
  });

  it("② 每个 *Key 引用的译文在四个语言里都存在（缺一个就会有语言显示裸键或回落）", () => {
    const missing: string[] = [];
    for (const r of found) {
      for (const loc of LOCALES) {
        if (!packs.get(loc)!.has(r.key)) missing.push(`${r.key} 缺 ${loc}（${r.manifest} ${r.path}）`);
      }
    }
    expect(missing, [
      `缺失译文 ${missing.length} 条：`,
      ...missing.slice(0, 14).map((x) => `      ${x}`),
      `      后果是**静默**的：t() 查不到就回落（显示裸键或 defaultValue），不抛错、不变红。`,
      `      ⚠ 若报的是"数据字段"（session.custom 的键之类），说明它被误命名成 *Key 了 —— 改名成 *Field。`,
    ].join("\n")).toEqual([]);
  });

  it("③ 自检：判据认得嵌套与数组形态（否则深层的 *Key 会被整体漏掉）", () => {
    // ⚠ 样本要挑**判据最难通过的那种形态**（r63 的教训）。实测真实分布是：
    //   18× fontPresets[].labelKey
    //   12× settingsGroups[].fields[].titleKey / 12× …descKey
    //    8× settingsGroups[].fields[].options[].labelKey   ← **三层数组嵌套**，最容易漏
    //    5× settingsGroups[].titleKey
    //    2× fileActions[].labelKey / 1× sessionGroupings[].childLabelKey / 1× composerPolicies[].readonlyMessageKey
    // 首版自检写的是 `settings[].titleKey` / `sidePanel[].labelKey`——**两个都不存在**
    // （settings 与 sidePanel 用的是 `title`/`label` 字面量 + 派生键，见 contribution-label-i18n），
    // 于是自检立刻红。这说明自检样本必须来自**实测分布**，不能凭想象写。
    const paths = new Set(found.map((f) => f.path.replace(/\[\d+\]/g, "[]")));
    for (const must of [
      "contributes.fontPresets[].labelKey",
      "contributes.settingsGroups[].titleKey",
      "contributes.settingsGroups[].fields[].titleKey",
      "contributes.settingsGroups[].fields[].options[].labelKey",   // 三层嵌套
      "contributes.fileActions[].labelKey",
      "contributes.sessionGroupings[].childLabelKey",
      "contributes.composerPolicies[].readonlyMessageKey",
    ]) {
      expect(paths.has(must), `自检失败：${must} 这种形态没被收集到 ⇒ 遍历漏了该层嵌套`).toBe(true);
    }
  });
});
