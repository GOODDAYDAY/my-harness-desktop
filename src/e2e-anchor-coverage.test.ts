// e2e 锚点存在性守卫(静态,零 IO)。
//
// 动机:e2e 靠 `[data-*]` 选择器等元素。**若某个锚点在源码里已不存在,那条断言就是在空转**
// (等一个永远不会出现的元素)——而本仓 e2e 不随单测自动跑,改锚点名时不会有人立刻发现。
//
// 判据两侧**都自动派生**,不写任何手写清单(手写清单会过期,这是本仓反复吃过的亏):
//   ① e2e 侧:从 scripts/demo/*.e2e.mjs 里抽 `[data-xxx...` 的锚点名;
//   ② 源码侧:从 src/、packages/ 的 ts/tsx 里抽所有 `data-*` 字面量。
// 断言 ① ⊆ ②。can go red:把源码里的 `data-foo` 改名、或 e2e 里写个不存在的锚点。
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
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

// ---- 第二部分：`.claude/skills/interaction-testing/SKILL.md` §2 的锚点清单不许腐烂 ----
//
// 为什么单独守 skill：它是写 e2e 时的**实操查阅处**（§2「DOM 锚点清单(实测有效)」）。
// 清单一旦过期，下一个人照它写就会命中不存在的元素——症状是 `waitForSelector` 超时，
// 然后他"顺手"改成按文案匹配（`/^(设置|Settings)$/`），于是测试被绑死在某一种语言上
// （zh-TW 是「設定」，实测就这么失效过）。**锚点清单腐烂是"按文案定位"这个反模式的上游成因**，
// 所以要在源头守住。
//
// ⚠ 只取表格的**第一列**：第二列是说明文字，里面会刻意提到反例
// （如"别改用 react-resizable-panels 的 `data-panel-id`"——那是第三方库属性、本仓源码里没有），
// 整行扫描会把这类**告诫**误判成违规。
describe("skill §2 锚点清单 ↔ 源码存在性（防清单腐烂）", () => {
  const SKILL = join(ROOT, ".claude/skills/interaction-testing/SKILL.md");

  it("skill 文件存在且 §2 表格非空（判据不空转）", () => {
    expect(existsSync(SKILL), `找不到 ${SKILL}`).toBe(true);
    expect(anchorsInSkill().length, "§2 一个锚点都没抽到 = 解析错了（假绿）").toBeGreaterThanOrEqual(8);
  });

  it("§2 清单里的每个锚点在源码里都存在", () => {
    const defined = anchorsInSource();
    const missing = anchorsInSkill().filter((a) => !defined.has(`data-${a}`)).sort();
    expect(
      missing.map((m) => `data-${m}`),
      `skill §2 列了但源码里没有的锚点（清单已腐烂，照它写 e2e 会超时）: ${missing.join(", ")}`,
    ).toEqual([]);
  });
});

/** 抽 SKILL.md §2 表格第一列里的 `data-*` 名。 */
function anchorsInSkill(): string[] {
  const text = readFileSync(join(ROOT, ".claude/skills/interaction-testing/SKILL.md"), "utf-8");
  const start = text.indexOf("## 2 DOM 锚点清单");
  if (start < 0) return [];
  const end = text.indexOf("\n## 3 ", start);
  const section = text.slice(start, end > 0 ? end : undefined);
  const out = new Set<string>();
  for (const line of section.split("\n")) {
    if (!line.startsWith("|")) continue;
    const firstCell = line.split("|")[1] ?? "";      // 只取第一列
    for (const m of firstCell.matchAll(/data-([a-z0-9-]+)/g)) out.add(m[1]);
  }
  return [...out];
}
