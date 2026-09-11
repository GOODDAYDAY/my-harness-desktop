// 动画名 ↔ @keyframes 存在性守卫（静态门，零 IO 之外的读文件）。
//
// 动机（这条门被两个真实缺陷逼出来，不是预防性洁癖）：
//   · `tool-cards.tsx` 的「工具执行中」左侧呼吸条写了 `animation: "tool-live-pulse 2.4s …"`，
//     而全仓**从未定义过 `@keyframes tool-live-pulse`** —— 没有关键帧的 animation 是**静默 no-op**：
//     不报错、不警告、什么也不动。用户看到的「运行中图标不动」有一半来自这里。
//   · `src/web/index.css` 的 `@keyframes shimmer` 上方留着同一类历史缺口的自述
//     （「组件引用了该名但关键帧从未落地，提示静止不动」）——**同类缺陷至少复发过一次**。
//   · 既有守卫（thinking-chain-block / tool-cards / phase-icon 的 DOM 测试）只查
//     `classList.contains("animate-pulse")`，查不到**内联 animation 的名字有没有落地**，
//     这个洞正是从守卫旁边溜过去的。
//
// 判据两侧都自动派生（不写手写清单——手写清单会过期，本仓反复吃过这个亏）：
//   ① 用到的动画名：TS/TSX 的 `animation:` / `animationName:` 字面量 + CSS 的 `animation:` 声明；
//   ② 已定义的关键帧：全仓 `.css` 里的 `@keyframes <name>`；
//   ③ 框架自带：Tailwind v4 内建 `animate-*` 对应的 pulse/spin/ping/bounce（由 index.css 的
//      `@import "tailwindcss"` 提供，源码里查不到 @keyframes，属合法豁免）。
// 断言 ① ⊆ ② ∪ ③。can go red：把 `@keyframes tool-live-pulse` 删掉即红。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Tailwind v4 内建动画名（`animate-pulse` 等），关键帧由框架的 @import 提供。 */
const FRAMEWORK_KEYFRAMES = new Set(["pulse", "spin", "ping", "bounce"]);

/** 值里不是动画名的关键字 / 函数 / 时间值。 */
const NON_NAME = /^(none|initial|inherit|unset|revert|var\(|cubic-bezier\(|steps\(|linear\(|ease|ease-in|ease-out|ease-in-out|linear|infinite|normal|reverse|alternate|forwards|backwards|both|running|paused|[\d.]+m?s$|[\d.]+$)/;

function walkFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "out" || entry === "dist") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walkFiles(p, out);
    else if (/\.(ts|tsx|css)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(p);
  }
  return out;
}

/** 去掉注释（否则注释里举的 `animation: "foo"` 例子会被当成真用法）。 */
const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

/** 从一个 animation 声明值里抽动画名（逗号分隔多条，各取首个 token）。 */
function namesInDeclaration(value: string): string[] {
  const out: string[] = [];
  for (const part of value.split(",")) {
    const token = part.trim().split(/\s+/)[0];
    if (!token || NON_NAME.test(token)) continue;
    if (!/^[A-Za-z_][\w-]*$/.test(token)) continue;
    out.push(token);
  }
  return out;
}

/** 全仓用到的动画名 → 出现位置（报错时能直接指到文件）。 */
function animationNamesUsed(): Map<string, string[]> {
  const used = new Map<string, string[]>();
  const add = (name: string, where: string): void => {
    const list = used.get(name) ?? [];
    list.push(where);
    used.set(name, list);
  };
  for (const file of [...walkFiles(join(ROOT, "src")), ...walkFiles(join(ROOT, "packages"))]) {
    const rel = file.replace(`${ROOT}/`, "");
    const text = stripComments(readFileSync(file, "utf-8"));
    if (file.endsWith(".css")) {
      // CSS 声明可能跨行（`animation:\n  a 1s,\n  b 2s;`），故不能用 `.` 匹配。
      for (const m of text.matchAll(/animation\s*:\s*([^;}]*)/g)) {
        for (const name of namesInDeclaration(m[1])) add(name, rel);
      }
      continue;
    }
    for (const m of text.matchAll(/\banimation(?:Name)?\s*:\s*["'`]([^"'`]+)["'`]/g)) {
      for (const name of namesInDeclaration(m[1])) add(name, rel);
    }
  }
  return used;
}

/** 全仓已定义的关键帧名。 */
function keyframesDefined(): Set<string> {
  const defined = new Set<string>();
  for (const file of [...walkFiles(join(ROOT, "src")), ...walkFiles(join(ROOT, "packages"))]) {
    if (!file.endsWith(".css")) continue;
    const text = stripComments(readFileSync(file, "utf-8"));
    for (const m of text.matchAll(/@keyframes\s+([\w-]+)/g)) defined.add(m[1]);
  }
  return defined;
}

describe("动画名 ↔ @keyframes 存在性", () => {
  const used = animationNamesUsed();
  const defined = keyframesDefined();

  it("判据本身不空转（两侧都非空）", () => {
    expect(used.size).toBeGreaterThan(0);
    expect(defined.size).toBeGreaterThan(0);
  });

  it("每个用到的动画名都有 @keyframes（或属 Tailwind 内建）", () => {
    const missing = [...used.keys()]
      .filter((n) => !defined.has(n) && !FRAMEWORK_KEYFRAMES.has(n))
      .sort();
    expect(
      missing.map((n) => `${n} @ ${[...new Set(used.get(n))].join(" ")}`),
      `引用了不存在的 @keyframes —— animation 声明会静默失效（元素不动，且不报任何错）: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("反向也不留死代码：定义了却不被任何地方引用的关键帧（信息性，不算失败）", () => {
    // 这条只做提示：关键帧可能被动态名（模板串）引用，故不做硬断言。
    const unused = [...defined].filter((n) => !used.has(n)).sort();
    if (unused.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`[animation-keyframes] 未被静态引用的关键帧（可能是动态引用）: ${unused.join(", ")}`);
    }
    expect(defined.size).toBeGreaterThan(0);
  });
});
