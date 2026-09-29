// 圆心（`packages/shared/src/domain/**`）导出的**纯函数**必须至少被一个测试引用。
//
// ## 为什么守这个
//
// r147 普查发现：圆心 92 个导出纯函数里 **20 个零测试引用**
// （session-bus 5 / session-state 5 / layout 5 / contributions 2 / composer-commands 1 /
// execution-state 1 / sessions 1）。r147–r150 分四轮补完（11 + 18 + 20 + 19 测），本守卫防止回潮。
//
// 为什么圆心纯函数**必须**有测试（而外层代码可以宽一些）：
// · 它们是 §4.2 的"圆心"——换内核、换框架、换运行时都不动的那一层，
//   所以它们的错误会**同时**影响所有内核与所有宿主；
// · 按 §4.5 的判据它们**不需要 mock 外部环境**，测试成本最低（纯输入→输出）；
// · r147–r149 的实测证明它们并不"简单到不用测"：`splitGroup` 的 ratio 语义被猜反、
//   `isVisibleMessage` 是可见性总闸（比较符反过来就会让所有消息消失）、
//   `sessionKeyOf` 对错误前缀静默返回垃圾、`contentHashOf` 的 djb2 变体被猜错。
//
// ## 判据（宁可窄而准，r130 的通则）
//
// · 语料：`packages/shared/src/domain/**` 的非测试 `.ts`（发出方）与**全仓**所有 `*.test.ts(x)`（消费方）；
// · "被测试引用"= 函数名作为**词边界标识符**出现在任一测试文件里（剥注释后，r113/r125/r127 的纪律）；
// · 只统计 `export function` / `export async function`（不统计类型、常量、类）；
// · 允许**账本**（写明 why/next），但账本条目有腐烂检查：一旦有测试引用就必须删条目。

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) { if (name !== "node_modules" && !name.startsWith(".")) walk(full, out); }
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}
function strip(s0: string): string {
  const s = s0.replace(/\/\*[\s\S]*?\*\//g, "");
  return s.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
}

/** 豁免账本：确有不测理由的函数（每条写 why/next；有了测试就必须删条目）。 */
const LEDGER: { fn: string; why: string; next: string }[] = [
  // r150 起为空：r147 普查出的 20 个已在 r147–r150 分四轮全部补完。
];

describe("圆心导出纯函数：零测试引用必须为 0", () => {
  const domainFiles = walk(join(ROOT, "packages/shared/src/domain"))
    .filter((f) => !/\.test\.tsx?$/.test(f));
  const testFiles = [
    ...walk(join(ROOT, "src")),
    ...walk(join(ROOT, "packages")),
  ].filter((f) => /\.test\.tsx?$/.test(f));

  const exported: Array<{ fn: string; file: string }> = [];
  for (const f of domainFiles) {
    const src = strip(readFileSync(f, "utf-8"));
    for (const m of src.matchAll(/^export (?:async )?function (\w+)/gm)) {
      exported.push({ fn: m[1], file: relative(ROOT, f) });
    }
  }
  const testCorpus = testFiles.map((f) => strip(readFileSync(f, "utf-8"))).join("\n");
  const untested = exported.filter((e) => !new RegExp(`\\b${e.fn}\\b`).test(testCorpus));

  it("判据不空转：语料规模正常，且已知的函数被识别到", () => {
    expect(domainFiles.length, "圆心文件数（r150 实测 30）").toBeGreaterThanOrEqual(30);
    expect(testFiles.length, "全仓测试文件数").toBeGreaterThan(150);
    expect(exported.length, "圆心导出纯函数数（r147 实测 92）").toBeGreaterThanOrEqual(85);
    for (const fn of ["deriveSessionTitle", "isVisibleMessage", "contentHashOf", "pruneEmptyGroups", "sessionKeyOf"]) {
      expect(exported.map((e) => e.fn), `${fn} 应被识别为圆心导出纯函数`).toContain(fn);
    }
    // 自检：这些函数确实**有**测试引用（否则判据在漏，"0 个未测"会通过得很假）
    for (const fn of ["deriveSessionTitle", "isVisibleMessage", "contentHashOf", "pruneEmptyGroups", "sessionKeyOf"]) {
      expect(new RegExp(`\\b${fn}\\b`).test(testCorpus), `${fn} 应有测试引用`).toBe(true);
    }
  });

  it("① 零测试引用的圆心纯函数必须为 0（账本内的除外）", () => {
    const listed = new Set(LEDGER.map((l) => l.fn));
    const bad = untested.filter((u) => !listed.has(u.fn));
    expect(bad.map((b) => `${b.fn}（${b.file}）`), [
      `${bad.length} 个圆心导出纯函数没有任何测试引用。`,
      "      圆心是§4.2 的'换内核/换框架都不动'那一层，它的错误会同时影响所有内核与宿主；",
      "      而按 §4.5 它们不需要 mock 外部环境 ⇒ 测试成本最低。",
      "      r147–r149 的实测：splitGroup 的 ratio 语义被猜反、isVisibleMessage 是可见性总闸",
      "      （比较符反过来所有消息就消失）、sessionKeyOf 对错误前缀静默返回垃圾、",
      "      contentHashOf 的 djb2 变体被猜错 —— '简单'不等于'不会错'。",
      "      处置：补测试（首选），或写进本文件的 LEDGER 并给出 why/next。",
    ].join("\n")).toEqual([]);
  });

  it("② 账本卫生：条目要写清 why/next，且一旦有了测试就必须删条目", () => {
    for (const l of LEDGER) {
      expect(l.why.length, `${l.fn} 的 why 太短（等于没写）`).toBeGreaterThan(20);
      expect(l.next.length, `${l.fn} 没写 next`).toBeGreaterThan(10);
      expect(untested.some((u) => u.fn === l.fn),
        `${l.fn} 已经有测试引用了 ⇒ 从 LEDGER 删掉（r133 的账本腐烂检查同款）`).toBe(false);
    }
  });
});
