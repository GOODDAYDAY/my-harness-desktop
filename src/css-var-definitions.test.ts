// CSS 变量：代码里 `var(--x)` 引用的名字必须有定义处（r76）。
//
// ## 被守的缺陷：引用未定义的 CSS 变量是**纯静默**失败
//
// `var(--未定义)` 且无回落值时，该声明在计算值阶段无效 ⇒ 属性被丢弃，
// 元素回落到继承值/初始值。**不报错、不警告、控制台干净、tsc 无关**——
// 只是界面某处颜色/间距/圆角"不太对"，而没人说得清为什么。
//
// r76 实测查出 **5 个变量、27 处引用**属于这一类（已修）：
//
// | 变量 | 引用 | 真相 |
// |---|---|---|
// | `--color-accent` | 21 | token 表里**没有**裸 `color.accent`（只有 `color.accent.success/warning/error/danger`）；本设计系统的强调色是 `color.primary` ⇒ 改 `--color-primary` |
// | `--color-danger` | 2 | 表里叫 `color.accent.danger` ⇒ 改 `--color-accent-danger` |
// | `--color-error` | 2 | 表里叫 `color.accent.error` ⇒ 改 `--color-accent-error` |
// | `--color-bg-secondary` | 1 | 表里叫 `color.surface` ⇒ 改 `--color-surface` |
// | `--spacing-xxs` | 1 | 表里最小是 `spacing.xs`（没有 xxs）⇒ 改 `--spacing-xs` |
//
// 其中 `--color-accent` 那 21 处分布在 skill-manager 的图标、keybindings 的边框等**装饰性强调**位置，
// 因为无回落值，实际渲染成继承色——观感"淡得看不出强调"，而这类偏差最容易被人当成设计如此。
//
// ## 判据与它的三类合法例外（例外要显式登记，不放宽判据）
//
// "有定义处"= 下列任一：
//   ① token 单源 `THEME_TOKEN_DEFAULTS`（`color.bg` → `--color-bg`）；
//   ② CSS/TS 里的 `--x:` 声明（含 `src/web/index.css` 的壳级布局变量 `--sidebar-*`/`--sidepanel-*`）；
//   ③ **动态注入**：`injectThemeCssVars` 对 `font.size.*` 额外注入 `-raw` 基值
//      （`element.style.setProperty(\`${cssVar}-raw\`, value)`，模板拼名，静态扫不到）。
//
// 另有**框架提供**的变量（我们源码里没有定义、运行时确实有值），走 `EXTERNAL` 账本逐条登记理由：
//   · Tailwind v4 默认主题：`--radius-xs` 等（真机实测 `.125rem`，与 Tailwind 默认值一致）；
//   · Radix：`--radix-*`（组件库运行时注入）。
//
// ⚠ 只统计**代码行**里的 `var(...)`：注释里的退役说明（例如 `right-panel.tsx` 解释
//   旧名 `--sidepanel-divider-display` 为什么被改名）不是引用，算进来就是假阳性。
//   本轮就靠这条区分，把一个"看着像缺陷"的项判成合法。
//
// ## 真机取证
//
// 静态判据之外，本轮还在真机上用 `getComputedStyle(document.documentElement).getPropertyValue(v)`
// 逐个取值：6 个报空（含仅注释提及的那个），对照组 `--color-primary`/`--radius-sm` 有值——
// **对照组是必要的**，否则"全空"可能只是取法错了（r45 的教训：反空转探针自己也会给假结果）。

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CORPUS_ROOTS = ["src/web", "src/plugins", "packages/react/src", "src/server", "packages/shared/src"];
const TOKEN_FILE = "packages/shared/src/domain/slots/theme-tokens.ts";

/** 框架提供的变量（我们源码里无定义、运行时有值）。每条都要写清来源与验证方式。 */
const EXTERNAL: { pattern: RegExp; why: string }[] = [
  { pattern: /^--radix-/, why: "Radix UI 运行时注入（如 --radix-popper-transform-origin）；真机实测存在" },
  { pattern: /^--radius-(xs|sm|md|lg|xl)$/, why: "Tailwind v4 默认主题提供；真机实测 --radius-xs = .125rem（= Tailwind 默认值），而我们源码里没有它的定义处" },
];

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) { if (name !== "node_modules" && !name.startsWith(".")) walk(full, out); }
    else if (/\.(tsx?|css)$/.test(name) && !/\.test\.tsx?$/.test(name) && !full.includes("/locales/")) out.push(full);
  }
  return out;
}

/** token 单源里的 CSS 变量名（`color.accent.error` → `--color-accent-error`）。 */
function tokenVars(): Set<string> {
  const src = readFileSync(join(ROOT, TOKEN_FILE), "utf-8").replace(/\/\*[\s\S]*?\*\//g, "");
  const m = /THEME_TOKEN_DEFAULTS[^=]*=\s*\{/.exec(src);
  expect(m, "找不到 THEME_TOKEN_DEFAULTS（判据会空转）").toBeTruthy();
  let i = m!.index + m![0].length;
  let depth = 1;
  const buf: string[] = [];
  while (i < src.length) {
    const c = src[i];
    if (c === "{") depth += 1;
    else if (c === "}") { depth -= 1; if (depth === 0) break; }
    buf.push(c);
    i += 1;
  }
  const out = new Set<string>();
  for (const k of buf.join("").matchAll(/^\s*"([^"]+)"\s*:/gm)) out.add(`--${k[1].replace(/\./g, "-")}`);
  return out;
}

describe("CSS 变量：var(--x) 引用的名字必须有定义处", () => {
  const files = CORPUS_ROOTS.flatMap((r) => walk(join(ROOT, r)));
  const defined = new Set<string>(tokenVars());
  const used = new Map<string, string[]>();

  for (const f of files) {
    const raw = readFileSync(f, "utf-8");
    const noBlock = raw.replace(/\/\*[\s\S]*?\*\//g, "");
    // 定义处：`--x:` / `"--x":` / setProperty("--x" | setProperty(`--x…
    for (const m of noBlock.matchAll(/(?:^|[^-\w])"(--[\w-]+)"\s*:|(?:^|[^-\w])(--[\w-]+)\s*:/gm)) {
      defined.add(m[1] ?? m[2]);
    }
    for (const m of noBlock.matchAll(/setProperty\(\s*[`"']([^`"']+)/g)) defined.add(m[1]);
    // 引用处：只算**代码行**（注释里的退役说明不是引用）
    const code = noBlock.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
    for (const m of code.matchAll(/var\(\s*(--[\w-]+)/g)) {
      const rel = relative(ROOT, f);
      used.set(m[1], [...(used.get(m[1]) ?? []), rel]);
    }
  }
  // 动态注入的 -raw 家族（injectThemeCssVars 用模板拼名，静态扫不到）
  for (const size of ["xs", "sm", "base", "lg", "xl"]) defined.add(`--font-size-${size}-raw`);

  const undefinedVars = [...used.keys()].filter((v) => !defined.has(v) && !EXTERNAL.some((e) => e.pattern.test(v)));

  it("判据不空转：扫到了足够多的变量与定义处，且对照组有值", () => {
    // r76 实测：代码里用到 141 种 var(--…)
    expect(used.size, `只扫到 ${used.size} 种 var(--…)（r76 实测 141）⇒ 引用判据可能坏了`).toBeGreaterThan(100);
    expect(defined.size, `只收集到 ${defined.size} 个定义处 ⇒ 定义判据可能坏了（那会让①报一堆假阳性）`).toBeGreaterThan(100);
    // 对照组：已知有定义的变量必须在定义集里（否则"未定义 0 个"是假的）
    for (const v of ["--color-primary", "--color-accent-error", "--color-surface", "--spacing-xs", "--sidebar-row-px"]) {
      expect(defined.has(v), `自检失败：${v} 明明有定义却没被收集到`).toBe(true);
    }
    // 自检：本轮修掉的那 5 个不得复活（它们没有定义处）
    for (const v of ["--color-accent", "--color-danger", "--color-error", "--color-bg-secondary", "--spacing-xxs"]) {
      expect(defined.has(v), `${v} 不该有定义处（它本来就是"用了但没定义"的那个）——若这条失败说明判据把引用当成了定义`).toBe(false);
    }
  });

  it("① 代码里引用的每个 CSS 变量都有定义处（或在 EXTERNAL 账本里登记）", () => {
    expect(undefinedVars.map((v) => `${v}（${used.get(v)!.length} 处，如 ${used.get(v)![0]}）`), [
      `${undefinedVars.length} 个 CSS 变量被引用但找不到定义处：`,
      ...undefinedVars.map((v) => `      ${v}  ← ${(used.get(v) ?? []).slice(0, 3).join(", ")}`),
      `      后果是**纯静默**的：无回落值时该声明在计算值阶段无效 ⇒ 属性被丢弃、回落继承值/初始值，`,
      `            不报错、不警告、控制台干净——只是界面某处颜色/间距/圆角"不太对"。`,
      `      修法：改用 token 单源里真实存在的名字（见 THEME_TOKEN_DEFAULTS）；`,
      `            若确实需要新 token，先在圆心加默认值再引用。`,
      `      若它由**框架**提供（Tailwind 默认主题 / Radix），登记进 EXTERNAL 并写明来源与真机验证方式。`,
    ].join("\n")).toEqual([]);
  });

  it("② EXTERNAL 账本每条都要有理由，且理由要说清『我们怎么验证过它运行时有值』", () => {
    for (const e of EXTERNAL) {
      expect(e.why.length, `账本理由太短（要写清来源与验证方式）`).toBeGreaterThan(20);
      const hit = [...used.keys()].filter((v) => e.pattern.test(v));
      expect(hit.length, `账本条目 ${e.pattern} 已不再匹配任何被引用的变量 ⇒ 删掉它（账本不许留死条目）`).toBeGreaterThan(0);
    }
  });

  it("③ 回归锚：r76 修的 27 处不得写回未定义的名字", () => {
    const back: string[] = [];
    for (const f of files) {
      const rel = relative(ROOT, f);
      const code = readFileSync(f, "utf-8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
      for (const bad of ["var(--color-accent)", "var(--color-danger", "var(--color-error)", "var(--color-bg-secondary", "var(--spacing-xxs)"]) {
        if (code.includes(bad)) back.push(`${rel}: ${bad}`);
      }
    }
    expect(back, [
      `${back.length} 处写回了 r76 修掉的未定义变量名：`,
      ...back.map((x) => `      ${x}`),
      `      正确名字：--color-primary（强调色）/ --color-accent-danger / --color-accent-error / --color-surface / --spacing-xs`,
    ].join("\n")).toEqual([]);
  });
});
