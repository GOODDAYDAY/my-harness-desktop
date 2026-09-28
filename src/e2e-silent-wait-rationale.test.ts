// e2e 剧本里「丢弃结果的等待」必须带行内理由（棘轮，r122）。
//
// ## 被守的形态
//
// ```js
// await page.waitForSelector("[data-composer-stop]", { timeout: 20000 }).catch(() => {});
// ```
//
// 这类写法**把"等不到"静默吞掉**，且不把结果赋给任何变量。它有两种截然不同的意图：
//   · **best-effort settle**（正当）：零 token 剧本里模型可能从不回复，
//     停止按钮合法地不出现；等一等是为了让"出现了"的情况稳定，等不到也继续。
//   · **静默失败的探针**（缺陷）：下游断言其实依赖它等到了，
//     于是"没等到"被当成"功能没发生"，症状与根因错位。
//     r118（e2e-inmem 按 title 文案找按钮，恒找不到 ⇒ 整段草稿测试空转）与
//     r121（`[aria-label*='停止']` 语言绑定 ⇒ 恒超时 ⇒ 被记成"streaming 没发生"）
//     都是这一类，两次都花了整轮才定位。
//
// **意图区分是语义判断，语法判不了**（本轮实测：361 处 `.catch(…)` 里，
// waitForDomIdle 179 / killApp 44 / screenshot 11 / press 18 / 显式布尔探针 52 都属正当族；
// waitForSelector+waitForFunction 61 处中 52 处丢弃结果，其中多数是 best-effort）。
// 所以本守卫**不判意图**，只要求：**丢弃结果的等待必须带行内理由**。
//
// 这与文档漂移审计的"退役符号 392 处命中，均需标注"是同一形态：
// 不禁止这个写法，但要求每一处都写下"为什么这里可以吞掉失败"——
// 写的过程本身就是甄别（写不出理由的那些，就是真该改成显式布尔探针的）。
//
// ## 更好的形态（写理由时通常会发现该改成它）
//
// ```js
// const appeared = await page.waitForSelector(sel, { timeout: 20000 }).then(() => true).catch(() => false);
// ok(appeared, "停止按钮应出现");        // ← 结果被断言，等不到就红，不会静默
// ```
// 剧本里已有 52 处用这个形态（`.then(() => true).catch(() => false)`），是正确示范。
//
// ## 为什么先交棘轮而不是"必须为 0"
//
// 现存 52 处要逐条写理由（或改成显式布尔探针），一轮做不完；
// 按 r85 的纪律：**判据可判但分类工作量超出一轮时，交"棘轮 + 反空转锚"，不交半个账本**。
// 棘轮保证不增长，后续每轮消化一批就下调。

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
/** r122 实测基线。只许减少；每消化一批（写理由或改成显式布尔探针）就下调。 */
const CEILING = 43;   // r122 基线 50 → r123 标注 minimal-smoke 后 43（只许继续减少）

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) { if (name !== "node_modules" && !name.startsWith(".")) walk(full, out); }
    else out.push(full);
  }
  return out;
}

/** 剧本语料：scripts 下的 .mjs（排除 lib/ —— 那是工具函数，不是探针） */
function scenarioFiles(): string[] {
  return walk(join(ROOT, "scripts"))
    .filter((f) => f.endsWith(".mjs") && !f.includes("/lib/"))
    .map((f) => relative(ROOT, f));
}

const WAIT_CALL = /await\s+page\.waitFor(?:Selector|Function)\s*\(/;
// ⚠ 只认**空体** `.catch(() => {})`（r122 修正）：这才是"把结果丢弃"。
//   返回值形态（`.catch(() => false)` / `=> null`）一定是被某个表达式接住的
//   ——那正是剧本里 52 处"显式布尔探针"的正确形态，不属本判据。
//   首版把两者都算进来，于是**多行写法**的布尔探针被误报：
//   `const appeared = await page.waitForSelector(…)` 换行后接 `.then(() => true).catch(() => false)`，
//   含 .catch 的那一行不以 const 开头 ⇒ ASSIGNED 认不出 ⇒ ① 自检红。
//   与其去做跨行语句分析，不如把判据收窄到"空体"这一个无歧义形态。
const SWALLOW = /\.catch\(\s*\(\s*\w*\s*\)\s*=>\s*\{\s*\}\s*\)/;
const ASSIGNED = /^\s*(?:const|let|var|return)\b|[^=!<>]=\s*(?:await\s+)?page\.waitFor/;
/**
 * 理由标记。**看同行 + 向上连续的注释块**（最多 6 行），不只看上一行。
 * ⚠ r123 修正：首版只看"同行或上一行"，于是写成 2–3 行的注释块**不被认**
 *   （紧邻的上一行未必含标记词）——标注了却仍被计入棘轮，看着像"标注没用"。
 *   通则：**要求人写理由的判据，必须接受"多行理由"**；
 *   否则人会为了过判据把理由挤成一行，反而写不清。
 * 标记词也放宽了：`等不到也` → `等不到`（真实写法是"等不到不算失败"/"等不到也继续"两种都有）。
 */
const RATIONALE = /(best-effort|尽力而为|可[选不]|等不到|不[影响]要?紧|swallow|optional|非必需|为了稳定|settle|吞掉失败)/i;
/** 从 idx 向上收集连续注释行（含 idx 行自身的行尾注释） */
function rationaleAbove(lines: string[], idx: number): string {
  const parts: string[] = [lines[idx] ?? ""];
  for (let k = idx - 1, n = 0; k >= 0 && n < 6; k -= 1, n += 1) {
    const t = (lines[k] ?? "").trim();
    if (!t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*")) break;
    parts.push(t);
  }
  return parts.join("\n");
}

describe("e2e 剧本：丢弃结果的等待必须带行内理由（棘轮）", () => {
  const files = scenarioFiles();
  const rows = files.map((rel) => ({ rel, lines: readFileSync(join(ROOT, rel), "utf-8").split("\n") }));
  const bare: { where: string; code: string }[] = [];
  for (const { rel, lines } of rows) {
    lines.forEach((ln, idx) => {
      const st = ln.trim();
      if (st.startsWith("//") || st.startsWith("*")) return;
      if (!WAIT_CALL.test(st) || !SWALLOW.test(st)) return;
      if (ASSIGNED.test(ln)) return;                       // 结果被接住 ⇒ 可断言，不在本判据范围
      if (RATIONALE.test(rationaleAbove(lines, idx))) return;  // 已有理由（同行或上方注释块）
      // ⚠ 存**整行**（不截断）：②③ 的自检要在 code 上跑正则，截断会把 .catch(() => {}) 切掉 ⇒ 假红
      bare.push({ where: `${rel}:${idx + 1}`, code: st });
    });
  }

  it("判据不空转：语料规模正常，且判据能认出**正当族**（否则会把 300 多处全报上来）", () => {
    expect(files.length, `剧本语料只有 ${files.length} 个文件`).toBeGreaterThan(60);
    // ⚠ 反空转锚：waitForDomIdle / killApp / screenshot 这三族必须**不被本判据捕获**
    //   （它们不是 page.waitForSelector|Function，正则上就该排除）。
    //   同时确认语料里确实存在这些正当族（否则"没报"可能是因为语料里没有）。
    const all = rows.flatMap((r) => r.lines).join("\n");
    expect(all.includes("waitForDomIdle"), "语料里应有 waitForDomIdle（正当族样本，用于确认判据没把它算进来）").toBe(true);
    expect(all.includes("killApp("), "语料里应有 killApp（同上）").toBe(true);
    expect(bare.every((b) => !/waitForDomIdle|killApp|screenshot/.test(b.code)),
      "判据越界：把 settle/teardown/诊断这类正当族也算进来了").toBe(true);
  });

  it("① 自检：显式布尔探针形态（.then(()=>true).catch(()=>false)）不得被报上来", () => {
    // 这是剧本里已有的**正确形态**（52 处）：结果被赋值并断言，所以不该进 bare 名单
    expect(bare.every((b) => !/\.then\(\s*\(\)\s*=>\s*true\s*\)/.test(b.code)),
      "显式布尔探针被误报了 ⇒ SWALLOW 判据把返回值形态也算进来了").toBe(true);
    expect(bare.every((b) => /\.catch\(\s*\(\s*\w*\s*\)\s*=>\s*\{\s*\}\s*\)/.test(b.code)),
      "名单里出现了非空体 .catch ⇒ 判据越界（返回值形态属显式探针，不该报）").toBe(true);
    // 反空转：语料里确实存在布尔探针形态（否则上面两条"全 true"是因为语料里没有）
    const allCode = rows.flatMap((r) => r.lines).join("\n");
    expect(allCode.includes(".then(() => true).catch(() => false)"),
      "语料里应有显式布尔探针样本（用于确认判据没把它算进来）").toBe(true);
  });

  it(`② 棘轮：无理由的「丢弃结果等待」只许减少（r122 基线 ${CEILING}）`, () => {
    expect(bare.length, [
      `无行内理由的「丢弃结果等待」从 ${CEILING} 涨到了 ${bare.length}。`,
      "      处置二选一（不要只为了让它变绿而加一句敷衍注释）：",
      "      · 若确实 best-effort（等不到也继续是对的）⇒ 在同行或上一行写清**为什么可以吞掉失败**；",
      "      · 若下游断言其实依赖它 ⇒ 改成显式布尔探针：",
      "        `const appeared = await page.waitForSelector(sel, {timeout}).then(() => true).catch(() => false);`",
      "        然后 `ok(appeared, …)` —— 等不到就红，不会静默（r118/r121 两次事故都源于静默）。",
      `      当前前 8 处：${bare.slice(0, 8).map((b) => b.where).join(", ")}`,
    ].join("\n")).toBeLessThanOrEqual(CEILING);
  });

  it("③ 分布可见：按剧本统计（便于逐轮消化，而不是只看总数）", () => {
    const by = new Map<string, number>();
    for (const b of bare) {
      const f = b.where.split(":")[0];
      by.set(f, (by.get(f) ?? 0) + 1);
    }
    // 不断言具体分布（那会随消化变动），只要求总数与棘轮一致，并把分布打印出来供人看
    expect([...by.values()].reduce((a, b) => a + b, 0)).toBe(bare.length);
    if (bare.length > 0) {
      console.log("      无理由的丢弃等待分布：",
        [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([f, n]) => `${f.split("/").pop()}×${n}`).join(" "));
    }
  });
});
