// e2e 锚点存在性守卫(静态,零 IO)。
//
// 动机:e2e 靠 `[data-*]` 选择器等元素。**若某个锚点在源码里已不存在,那条断言就是在空转**
// (等一个永远不会出现的元素)——而本仓 e2e 不随单测自动跑,改锚点名时不会有人立刻发现。
//
// 判据两侧**都自动派生**,不写任何手写清单(手写清单会过期,这是本仓反复吃过的亏):
//   ① e2e 侧:从 scripts/demo/*.e2e.mjs 里抽 `[data-xxx...` 的锚点名;
//   ② 源码侧:从 src/、packages/ 的 ts/tsx 里抽所有 `data-*` 字面量。
// 断言 ① ⊆ ②。can go red:把源码里的 `data-foo` 改名、或 e2e 里写个不存在的锚点。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** e2e 里用到的锚点名(不含 `data-` 前缀)。 */
function anchorsUsedByE2e(): Set<string> {
  const out = new Set<string>();
  const dir = join(ROOT, "scripts/demo");
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".e2e.mjs")) continue;
    const text = readFileSync(join(dir, f), "utf-8");
    for (const m of text.matchAll(/\[data-([a-z0-9-]+)[\]=]/g)) out.add(m[1]);
  }
  return out;
}

/** 源码里出现过的所有 `data-*` 字面量(含前缀)。 */
function anchorsInSource(): Set<string> {
  const out = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "out" || entry === "dist") continue;
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(entry)) {
        for (const m of readFileSync(p, "utf-8").matchAll(/data-[a-z0-9-]+/g)) out.add(m[0]);
      }
    }
  };
  walk(join(ROOT, "src"));
  walk(join(ROOT, "packages"));
  return out;
}

describe("e2e 锚点 ↔ 源码 data-* 存在性", () => {
  const used = anchorsUsedByE2e();
  const defined = anchorsInSource();

  it("两侧都非空(判据本身不空转)", () => {
    expect(used.size).toBeGreaterThan(0);
    expect(defined.size).toBeGreaterThan(0);
  });

  it("e2e 用到的每个锚点在源码里都存在", () => {
    const missing = [...used].filter((a) => !defined.has(`data-${a}`)).sort();
    expect(
      missing.map((m) => `data-${m}`),
      `e2e 依赖但源码里没有的锚点: ${missing.join(", ")}`,
    ).toEqual([]);
  });
});
