// `packages/react` 发布面导出的**值**（组件/hooks/函数/常量）零测试引用的数量只许减少。
//
// ## 为什么守这个
//
// r151 普查发现：发布面 113 个导出**值**里 **57 个零测试引用**（组件 20 / hooks 19 / 函数常量 18）。
// 发布面是壳插件唯一能用的 API 面（§7.2：插件只 import shared 与 react），
// 所以它的每个导出都被多个插件依赖——改坏一个会同时坏多个插件，
// 而它不像圆心纯函数那样"显然该测"，于是长期欠债。
//
// 与 r150 那条（圆心纯函数零测试引用必须为 0）的差别：
// 圆心 92 个已在 r147–r150 四轮清零，所以那边是**硬断言 = 0**；
// 发布面这边债务是 55 个（r151 清掉 2 个），一轮清不完，
// 所以按 r85 的形态先钉**棘轮**：基线取实测值，每轮只许减少，
// 减了就更新基线（r123 的纪律：**基线取守卫实测值，不用"原值−修掉数"推算**）。
//
// ## 判据（r151 的教训：分类器不对，指标就没意义）
//
// · 先分离 `export type { … }` 与 `export { … , type X , … }` 里的**类型**，
//   只统计**值**导出（首版把 `ButtonProps` 这类类型算成组件，虚报成"90 个组件 65 个未覆盖"）；
// · "被测试引用" = 名字作为**词边界标识符**出现在任一 `*.test.ts(x)` 里（剥注释后，r113/r125/r127）；
// · 语料含 `src/**` 与 `packages/**`（插件的 DOM 测试也算覆盖——发布面就是给它们用的）；
// · 残余误差如实记：全大写常量（`GENERAL_CONFIG_PATH`）会被算进"组件"类，
//   所以分类计数读作**量级**；但**总数与棘轮是准的**（它只按"值 vs 类型"分，不按形态细分）。

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

/** 基线取**守卫实测值**（r123 纪律：不用"原值−修掉数"推算）。
 *  r151 的 Python 普查也估 57，但**成因不同**：那个把类型算成了组件（多算），
 *  首版守卫漏了直接导出声明（少算）——两个错恰好抵消成同一个数字。
 *  ⚠ 这正是"数字对上了不等于判据对了"的实例：必须分别核对两侧的分类器。
 *  现判据两种导出形态都认、类型已分离 ⇒ 以守卫实测 57 为准（r129/r151 的通则：分类器不对，指标就没意义；两个分类器不一致时信可复跑的那个）。 */
const CEILING = 35;   // r163 清掉四个同构 hook + fileActionInvokeChannel ⇒ 40 → 35（实测值）

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

/** 发布面导出的**值**名字（类型已排除） */
function exportedValues(): string[] {
  const idx = readFileSync(join(ROOT, "packages/react/src/index.ts"), "utf-8");
  const types = new Set<string>();
  const values = new Set<string>();
  for (const m of idx.matchAll(/export type \{([^}]*)\}/gs)) {
    for (const p of m[1].split(",")) { const n = p.trim().split(" as ").pop()!.trim(); if (n) types.add(n); }
  }
  for (const m of idx.matchAll(/(?<!type )export \{([^}]*)\}/gs)) {
    for (const raw of m[1].split(",")) {
      const p = raw.trim();
      if (!p) continue;
      if (p.startsWith("type ")) { types.add(p.slice(5).trim().split(" as ").pop()!.trim()); continue; }
      const n = p.split(" as ").pop()!.trim();
      if (/^\w+$/.test(n)) values.add(n);
    }
  }
  // ⚠ 发布面有**两种**导出形态，只认花括号再导出会漏（r152 反向注入查出的判据洞）：
  //   ① `export { A, B } from "./x"` / `export type { C } from "./y"`（绝大多数）
  //   ② **直接导出声明** `export const X = …` / `export function f() {}` / `export class K {}`
  //   首版只解析①，于是注入一个 `export const r152FakeSurfaceExport = 1` 时棘轮**没红**
  //   （注入已自证落盘 ⇒ 是判据在漏，不是注入失败；r135 的三步走：先证注入、再疑守卫）。
  for (const m of idx.matchAll(/^export (?:declare )?(?:const|let|var|function|async function|class) (\w+)/gm)) {
    values.add(m[1]);
  }
  for (const t of types) values.delete(t);
  return [...values].sort();
}

describe("packages/react 发布面：零测试引用的导出值只许减少", () => {
  const values = exportedValues();
  const testFiles = [...walk(join(ROOT, "src")), ...walk(join(ROOT, "packages"))]
    .filter((f) => /\.test\.tsx?$/.test(f));
  const corpus = testFiles.map((f) => strip(readFileSync(f, "utf-8"))).join("\n");
  const uncovered = values.filter((n) => !new RegExp(`\\b${n}\\b`).test(corpus));

  it("判据不空转：值/类型分离生效，语料规模正常，已知覆盖项被认出来", () => {
    expect(values.length, `发布面值导出数（r151 实测 113）：${values.length}`).toBeGreaterThanOrEqual(100);
    expect(testFiles.length, "测试文件语料").toBeGreaterThan(150);
    // 类型必须被排除（否则 r151 那个虚报的 65 会重现）
    for (const t of ["ButtonProps", "ComposerAttachmentItem", "ComposerVoiceProps", "DirectoryPicker"]) {
      expect(values, `${t} 是类型，不该算进值导出`).not.toContain(t);
    }
    // 自检：这些确实**有**测试引用（否则"未覆盖数"会虚高，棘轮也就无意义）
    for (const v of ["copyToClipboard", "pickDirectory", "buildToolLimitNote", "stripToolLimitNote", "Announce"]) {
      expect(values, `${v} 应是值导出`).toContain(v);
      expect(uncovered, `${v} 应已被测试覆盖`).not.toContain(v);
    }
  });

  it(`① 棘轮：零测试引用的发布面值 ≤ ${CEILING}（r151 基线 57，r151 当轮清掉 3）`, () => {
    expect(uncovered.length, [
      `发布面零测试引用的导出值从 ${CEILING} 涨到了 ${uncovered.length}。`,
      "      发布面是壳插件唯一能用的 API 面（§7.2），每个导出都被多个插件依赖——",
      "      改坏一个会同时坏多个插件，而它不像圆心纯函数那样'显然该测'，所以长期欠债。",
      `      新增的未覆盖项：${uncovered.slice(0, 10).join(", ")}`,
      "      处置：给新加的导出补 DOM/unittest（首选），或按 r85 的形态记进 LEDGER 写明 why/next。",
      "      ⚠ 基线更新纪律（r123）：数字取本守卫的**实测值**，不用'原值−修掉数'推算。",
    ].join("\n")).toBeLessThanOrEqual(CEILING);
    // 每轮清掉的要如实反映在基线上：这里打印当前实测值，便于下轮更新 CEILING
    if (uncovered.length < CEILING) {
      // 不是失败，只是提示：可以把 CEILING 降到实测值（棘轮只收紧不放松）
      expect(uncovered.length, `可以把 CEILING 从 ${CEILING} 降到实测 ${uncovered.length}`).toBeLessThanOrEqual(CEILING);
    }
  });

  it("② 高危名单必须被覆盖（会话作用域 / 渲染分派 / 注册对称性）", () => {
    // 这三族的错误后果最重：
    //   · 会话作用域错了 ⇒ 跨项目读数据（r74 那条守卫守的是服务端，这里是 renderer 侧 hook）
    //   · 渲染分派错了 ⇒ 代码块渲染成错误的组件（或静默不渲染）
    //   · 注册不对称 ⇒ 卸载后仍留着旧槽位（幽灵贡献）
    const HIGH_RISK = ["useSessionScope", "useSessionScopeAccess", "useSessionScopeRef",
      "resolveCodeBlockRenderer", "resolveCodeBlockRendererComponent",
      "registerSessionSlots", "unregisterSessionSlots"];
    // ⚠ 反空转：先确认这些名字真的在**值导出清单**里——否则 `uncovered.includes(n)` 恒 false，
    //   ② 会通过得很假（r72/r105 的同款陷阱：断言的样本不在实测分布里）。
    const missing = HIGH_RISK.filter((n) => !values.includes(n));
    expect(missing, `这些高危名字已不在发布面值导出清单里（改名/下架了？）⇒ 更新名单：${missing.join(", ")}`).toEqual([]);
    const still = HIGH_RISK.filter((n) => uncovered.includes(n));
    expect(still.map((n) => n), [
      `${still.length} 个高危导出仍零测试引用：${still.join(", ")}`,
      "      这三族的错误后果最重（跨项目读数据 / 渲染分派错 / 卸载后留幽灵贡献），",
      "      所以它们不参与'慢慢消化棘轮'，而是**点名要求**先补。",
    ].join("\n")).toEqual([]);
  });
});
