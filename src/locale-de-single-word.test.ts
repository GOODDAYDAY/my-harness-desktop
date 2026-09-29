// 德语覆盖率的**单词级盲区**棘轮（r230；补 locale-de-coverage 明确跳过的那一类）。
//
// ## 被守的盲区
//
// `locale-de-coverage.test.ts` 的判据②要求"剥掉路径/占位符后**至少 2 个词**"，
// 理由是单词与专名（Transport / Images / IM）无法判定是否该译 ⇒ **跳过**。
// 它的头注也如实写了这一点。按 r228 的通则（守卫头注里的"不覆盖"声明是**待办清单**、
// 不是免责声明），本轮把这一类量化并钉住：
//
// 判据（三条同时成立）：① de 的值与 en **逐字相同**；② 不含任何德文特征
// （变音符/ß、常见功能词、典型构词后缀 ——与 locale-de-coverage 同一张表）；
// ③ 剥掉 `{{占位符}}` 后**词数 ≤ 1**（即现有守卫跳过的那一类）。
//
// r230 实测 **69 条**。其中大多数是**正当同形**（德语里也这么写）：
// 字段名/标识符（displayName、apiKeyEnv、providerId、baseUrl、baseURL、name、api）、
// 专名与产品名（Minimal、IM、Sticker、Ping、Chat、Review、Status、Name、Global、Pins）、
// 以及只有符号+占位符的模板（`✗ {{error}}`）。
// ⇒ 所以本守卫是**棘轮**（≤ 69），不是 0 命中硬断言：
//   它的作用不是"逼你把 Status 译成德文"，而是**新增的单词级同值必须被看见**
//   （每加一条要么译掉、要么进 EXEMPT 并写理由）。
//
// ⚠ 已知边界（如实标注）：判据只看"de 与 en 逐字相同"，
//   所以"de 译成了一个错误的德文词"看不见（那需要人工/词典）；
//   "en 本身就是德文"也看不见。两类都不在本守卫的职责内。

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CEILING = 60;   // r230 实测基线（豁免表 7 条之外）；译掉或豁免一条就降

/** 与 locale-de-coverage 同一张德文特征表（判据要一致，否则两个守卫会互相打脸）。 */
const DE_MARK =
  /[äöüÄÖÜß]|\b(und|oder|der|die|das|den|dem|des|für|mit|ist|sind|war|werden|nicht|nur|wenn|aus|ein|eine|einer|eines|bei|zum|zur|von|nach|auf|im|am|um|als|auch|kann|muss|soll|hier|dort|mehr|weniger|alle|keine|bitte|danke)\b|(ung|keit|heit|lich)\b|ieren\b/;

/** 正当同形的豁免（每条写理由；长度会被打印以防悄悄变长）。 */
const EXEMPT: { value: string; reason: string }[] = [
  { value: "displayName", reason: "配置字段名（UI 上按原样展示标识符）" },
  { value: "apiKeyEnv", reason: "环境变量名" },
  { value: "providerId", reason: "配置字段名" },
  { value: "baseUrl", reason: "配置字段名" },
  { value: "baseURL", reason: "配置字段名（另一种大小写写法）" },
  { value: "name", reason: "配置字段名" },
  { value: "api", reason: "缩写专名（德语同形）" },
];

function walk(dir: string, loc: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) { if (name !== "node_modules" && !name.startsWith(".")) walk(full, loc, out); }
    else if (name.endsWith(".json") && full.includes(`/locales/${loc}/`)) out.push(full);
  }
  return out;
}
function load(loc: string): Record<string, string> {
  const d: Record<string, string> = {};
  for (const f of walk(join(ROOT, "src/plugins"), loc)) {
    try { Object.assign(d, JSON.parse(readFileSync(f, "utf-8")) as Record<string, string>); }
    catch { /* 坏 JSON 由别的守卫负责 */ }
  }
  return d;
}

function scan(): { hits: { key: string; value: string }[]; compared: number } {
  const de = load("de"), en = load("en");
  const hits: { key: string; value: string }[] = [];
  let compared = 0;
  const exempt = new Set(EXEMPT.map((e) => e.value));
  for (const [k, v] of Object.entries(de)) {
    if (typeof v !== "string") continue;
    const e = en[k];
    if (typeof e !== "string") continue;
    compared++;
    if (e !== v) continue;                       // ① 逐字相同
    if (DE_MARK.test(v)) continue;               // ② 无德文特征
    const words = v.replace(/\{\{[^}]*\}\}/g, " ").match(/[A-Za-zÄ-ÿ]{2,}/g) ?? [];
    if (words.length >= 2) continue;             // ③ ≤1 词（≥2 词归 locale-de-coverage 管）
    if (exempt.has(v)) continue;
    hits.push({ key: k, value: v });
  }
  return { hits, compared };
}

describe("德语语言包：单词级同值（locale-de-coverage 跳过的那一类）只许减少", () => {
  const r = scan();

  it("判据不空转：de/en 有大量可对比的键（否则命中 0 毫无意义）", () => {
    expect(r.compared, `de 与 en 都存在的键数（r230 实测应 > 800）：${r.compared}`).toBeGreaterThan(800);
  });

  it(`① 棘轮：单词级同值 ≤ ${CEILING}（r230 实测基线）`, () => {
    expect(r.hits.length, [
      "这些 de 值与 en **逐字相同**、无德文特征、且只有 0–1 个词",
      "      （≥2 词的由 locale-de-coverage 负责；本守卫补的是它明确跳过的那一类，见其判据②）。",
      "      大多数是正当同形（字段名/专名/产品名），所以这里是棘轮而不是 0 命中：",
      "      作用是**新增的单词级同值必须被看见**——每加一条要么译掉、要么进 EXEMPT 并写理由。",
      `      当前 ${r.hits.length} 条（豁免表 ${EXEMPT.length} 条）：`,
      ...r.hits.slice(0, 40).map((h) => `      ${h.key} = ${JSON.stringify(h.value)}`),
    ].join("\n")).toBeLessThanOrEqual(CEILING);
  });

  it("② 豁免表自检：每条理由非空，且豁免值确实还在语言包里（否则豁免失效该删）", () => {
    const de = load("de");
    const values = new Set(Object.values(de));
    for (const e of EXEMPT) {
      expect(e.reason.length, "每条豁免都要写明理由").toBeGreaterThan(4);
      expect(values.has(e.value), `豁免值 ${JSON.stringify(e.value)} 已不在 de 语言包里 ⇒ 该条豁免失效，应删除`).toBe(true);
    }
    expect(EXEMPT.length, "豁免表长度（防悄悄变长）").toBeLessThanOrEqual(12);
  });
});
