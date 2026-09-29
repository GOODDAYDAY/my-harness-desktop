// hover 门控的**可交互内容**必须有键盘焦点路径（r157；把 r154–r156 的三轮发现固化成守卫）。
//
// ## 缺陷形态
//
// `{hovered && <button …>}` —— 内容只在鼠标悬停时才**渲染进 DOM**。后果：
//   · 纯键盘用户 Tab 到这一行时**看不到也够不着**那些按钮；
//   · r38 那类**可访问名普查查不出来**：元素存在于 React 树、不在 DOM 里；
//   · 若门控的还是 `<span onClick>`（不是 `<button>`），则是**双重缺陷**：
//     连聚焦都不可能，Enter/Space 也无效（r156 在 projects 插件里实测到的形态）。
//
// 已修的两处：`PanelRow`（r155，骨架组件 ⇒ 影响所有插件面板）、
// `ProjectRow` 的移除按钮（r156）。修法都是 **reveal-on-focus**：
// 常驻 DOM + `opacity` 切可见性 + `onFocus`/`onBlur`（`onBlur` 判 `relatedTarget`）。
//
// ## 判据（宁可窄而准，r130 通则）
//
// 命中条件（三条同时成立）：
//   ① 状态名形似 hover（含 hover/Hover/over 结尾）且由 `useState` 声明；
//   ② 该状态参与**条件渲染**（`{x && …}` / `{x ? … : …}` / `!x &&`）；
//   ③ 同文件里**没有**任何 `onFocus` 处理（即没有键盘揭示路径）。
// 命中即报；确实正当的（门控的是装饰/状态指示，控件本身可达）进 LEDGER 并写明理由。
// ⚠ ③ 用"同文件有没有 onFocus"而不是"门控表达式里有没有 || focused"：
//   后者会漏掉"焦点状态存在但没接到这个门控上"的情形，前者更保守（可能多报，但多报可入账本）。
//
// 两侧都剥注释（r113/r125/r127）；语料含 test-plugins（r108）。

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const ROOTS = ["src/plugins", "src/web", "packages/react/src", "test-plugins"];

/** 已判定的正当门控（r156 逐个核过）：每条写明门控的是什么、为什么不是 a11y 缺陷。 */
const LEDGER: { file: string; state: string; why: string; next: string }[] = [
  { file: "src/plugins/sessions/session-colors/renderer/index.tsx", state: "hovered",
    why: "门控的是**按钮内部的 X 图标**（视觉提示，:413），外层 <button> 常驻渲染 ⇒ 控件可聚焦可激活，图标只是装饰性提示（r156 逐个判定；r157 守卫实测该文件仍命中 1 处）",
    next: "若将来把可交互控件也放进这个门控，本条要重新判定（守卫会因新增命中而红）" },
];

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) { if (name !== "node_modules" && name !== "locales" && !name.startsWith(".")) walk(full, out); }
    else if (/\.tsx$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}
function strip(s0: string): string {
  const s = s0.replace(/\/\*[\s\S]*?\*\//g, "");
  return s.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
}

interface Hit { file: string; state: string; gates: number }

function scan(): Hit[] {
  const files = ROOTS.flatMap((r) => walk(join(ROOT, r)));
  const hits: Hit[] = [];
  for (const f of files) {
    const src = strip(readFileSync(f, "utf-8"));
    const rel = relative(ROOT, f);
    const lines = src.split("\n");
    // ③ 键盘揭示路径的判定用**邻近性**（±40 行）而不是"整个文件有没有 onFocus"。
    //   ⚠ 首版用的是文件级判定，实测**命中数为 0**：sessions-list 有 1301 行，
    //   文件里别处有个无关的 onFocus 就把整文件豁免了（r156 的 Python 扫描查出 5 处，
    //   本守卫却一处不报）。**文件级抑制对大组件文件必然失效**——这是判据设计的真问题，
    //   不是数据问题。邻近性是折中：不精确解析组件边界，但能把"同一块 UI 的焦点处理"圈进来。
    const focusLines: number[] = [];
    lines.forEach((l, i) => { if (/\bonFocus\s*[=:{]/.test(l) || /focus-within/.test(l)) focusLines.push(i); });
    // ⚠ 名字启发式只认 **hover**，不要放宽到 `over`（r157 实测的假阳性来源）：
    //   `[Oo]ver` 会匹配 `overviewMode`（session-tree 的总览模式）与 `discoverOpen`
    //   （model-config 的发现面板展开态）——两者与鼠标悬停毫无关系。
    //   判据放宽换来的"多扫一点"，代价是要为每个假阳性写账本条目，得不偿失。
    for (const m of src.matchAll(/const \[(\w*[Hh]over\w*),\s*set/g)) {
      const state = m[1];
      const gateIdx: number[] = [];
      lines.forEach((l, i) => { if (new RegExp(`\\{\\s*!?${state}\\s*(&&|\\?)`).test(l)) gateIdx.push(i); });
      if (gateIdx.length === 0) continue;
      // 每个门控点各自判：附近 ±40 行内有 onFocus 才算有键盘路径
      const ungated = gateIdx.filter((gi) => !focusLines.some((fi) => Math.abs(fi - gi) <= 40));
      if (ungated.length > 0) hits.push({ file: rel, state, gates: ungated.length });
    }
  }
  return hits.sort((a, b) => a.file.localeCompare(b.file) || a.state.localeCompare(b.state));
}

describe("hover 门控的可交互内容必须有键盘焦点路径", () => {
  const hits = scan();
  const ledgerKeys = new Set(LEDGER.map((l) => `${l.file}::${l.state}`));
  const unlisted = hits.filter((h) => !ledgerKeys.has(`${h.file}::${h.state}`));

  it("判据不空转：语料规模正常，且 r155/r156 修过的两处**不再**命中（它们已有 onFocus）", () => {
    const files = ROOTS.flatMap((r) => walk(join(ROOT, r)));
    expect(files.length, "渲染层 .tsx 语料（r156 实测 141）").toBeGreaterThan(100);
    // 反空转锚：已修的两处必须有 onFocus（否则判据③失效，它们会重新命中）
    for (const f of ["packages/react/src/panel/panel-row.tsx", "src/plugins/project/projects/renderer/index.tsx"]) {
      const src = readFileSync(join(ROOT, f), "utf-8");
      expect(/\bonFocus\s*=/.test(src), `${f} 应已有 onFocus 焦点揭示路径（r155/r156 修的）`).toBe(true);
      expect(hits.some((h) => h.file === f), `${f} 不该再被本守卫命中`).toBe(false);
    }
    // 自检：判据真的会命中（账本里的 4 处就是活样本）
    expect(hits.length, "命中数应 >0（账本里那条正当门控就是活样本）；为 0 说明判据没扫到东西（r157 首版就因捕获组边界放错而恒 0）").toBeGreaterThan(0);
  });

  it("① 账本外的 hover 门控必须为 0（新增的要修或登记）", () => {
    expect(unlisted.map((h) => `${h.file}（状态 ${h.state}，门控 ${h.gates} 处）`), [
      `${unlisted.length} 处 hover 门控的条件渲染没有键盘焦点路径：`,
      "      若门控的是**可交互控件**（按钮/输入/链接）⇒ 真缺陷（r155 的 PanelRow、r156 的 ProjectRow），",
      "      修法是 reveal-on-focus：常驻 DOM + opacity 切可见性 + onFocus/onBlur（onBlur 判 relatedTarget）。",
      "      ⚠ 别用 visibility:hidden（会把元素移出 tab 序，键盘照样够不着）。",
      "      若门控的是**装饰/状态指示**且控件本身可达 ⇒ 不是 a11y 缺陷，登记进 LEDGER 并写明理由。",
      "      判据是『门控的是什么』（r156 的通则），不是『有没有 hover 门控』。",
    ].join("\n")).toEqual([]);
  });

  it("② 账本卫生：理由要写清门控的是什么，且命中一旦消失就要删条目", () => {
    for (const l of LEDGER) {
      expect(l.why.length, `${l.file} 的理由太短`).toBeGreaterThan(40);
      expect(l.next.length, `${l.file} 没写 next`).toBeGreaterThan(10);
      expect(hits.some((h) => h.file === l.file && h.state === l.state),
        `${l.file} 的 ${l.state} 已不再命中（改了？）⇒ 从 LEDGER 删掉`).toBe(true);
    }
  });
});
