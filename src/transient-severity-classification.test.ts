// 瞬时提示的**严重级分类**守卫（r61）。
//
// ## 被守的缺陷
//
// timeline 的瞬时提示此前只有文本、没有严重级，于是：
//   ① 视觉上失败与告知**长得一样**（恒中性边框 + `--color-fg`）；
//   ② 读屏侧一律 `aria-live=polite`（排队播报），而这里 15 个调用点里 **11 个是失败**
//      （modelApplyFailed / thinkingApplyFailed / rewindFailed / attachmentUnsupported /
//      attachSkipped / openFolderFirst / sessionKernelNotLoaded / kernelRequired）。
// 按 r59 定的原则——**播报强度属于语义，不是渲染细节**——失败被"礼貌地排队"等于听不到。
// 修法：状态加 `kind: "info" | "error"`，样式按 kind 着色，`<Announce variant={kind}>`
// 让错误走 `role=alert`（可打断）。
//
// ## 这条守卫守什么
//
// 修完之后，**新增的失败路径很容易忘记传 "error"**（缺省是 "info"，编译器不会提醒，
// 界面也不会报错——只是失败又一次变得"看不出来、听不到"）。所以把分类规则写成判据：
// 文案键里带失败语义的（Failed / Unsupported / Skipped / Required / NotLoaded / …First），
// 调用时必须显式传 `"error"`。
//
// ⚠ 判据是**键名语义**而不是"所有 showToast 都要 error"：告知类（queue.enqueued /
//   queue.mergedSent / toolsFilterApplied）用 polite 才对——它们不该打断用户。

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

/** 键名里带这些词 = 失败/被拒语义 ⇒ 必须标 "error"。 */
const FAILURE_HINT = /(Failed|Unsupported|Skipped|Required|NotLoaded|Unavailable|Rejected|First$)/;
/** 调用形如 `showToast(t("key"…))` 或 `showToast(t("key"…), "error")`。 */
const CALL = /showToast\(\s*([\s\S]{0,220}?)\)\s*;/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) { if (name !== "node_modules" && !name.startsWith(".")) walk(full, out); }
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

interface Call { file: string; line: number; keys: string[]; marked: boolean }

function collect(): Call[] {
  const out: Call[] = [];
  for (const base of ["src/plugins", "src/web", "packages/react/src"]) {
    const root = join(ROOT, base);
    if (!existsSync(root)) continue;
    for (const f of walk(root)) {
      const src = readFileSync(f, "utf-8").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const m of src.matchAll(CALL)) {
        const body = m[1];
        const keys = [...body.matchAll(/t\(\s*"([^"]+)"/g)].map((k) => k[1]);
        if (keys.length === 0) continue;
        const line = src.slice(0, m.index!).split("\n").length;
        out.push({ file: relative(ROOT, f), line, keys, marked: /,\s*"error"\s*\)?$/.test(body.trim()) || body.includes(', "error"') });
      }
    }
  }
  return out;
}

describe("瞬时提示的严重级分类：失败语义的文案必须标 error", () => {
  const calls = collect();

  it("判据不空转：确实扫到了 showToast 调用，且数量与已知事实一致", () => {
    // r61 实测：timeline 一个文件就有 15 处调用（11 失败 + 4 告知）
    expect(calls.length, `只扫到 ${calls.length} 处 showToast 调用（r61 实测 ≥15）——判据可能坏了`).toBeGreaterThanOrEqual(15);
    const failureCalls = calls.filter((c) => c.keys.some((k) => FAILURE_HINT.test(k)));
    expect(failureCalls.length, "一处失败语义的调用都没扫到 ⇒ FAILURE_HINT 判据失效").toBeGreaterThanOrEqual(10);
  });

  it("① 文案键带失败语义的调用，必须显式传 \"error\"（否则失败既不着色也不打断播报）", () => {
    const bad = calls.filter((c) => c.keys.some((k) => FAILURE_HINT.test(k)) && !c.marked);
    expect(bad.map((c) => `${c.file}:${c.line}  keys=${c.keys.join(",")}`), [
      `${bad.length} 处失败提示没标严重级：`,
      "      后果：① 视觉上与告知长得一样；② 读屏用 polite 排队播报（错误该用 role=alert 打断）。",
      '      修法：showToast(t("…Failed"), "error")。',
      "      若这条判据误报（某个键名带 Failed 但其实是告知），改 FAILURE_HINT 而不是给它开后门。",
    ].join("\n      ")).toEqual([]);
  });

  it("② 告知类不得误标 error（否则会打断用户，且红色边框制造虚假紧迫感）", () => {
    const INFO_KEYS = ["timeline.queue.enqueued", "timeline.queue.mergedSent", "timeline.queue.interruptedSent",
      "timeline.toolsFilterApplied", "timeline.toolsFilterCleared"];
    const bad = calls.filter((c) => c.keys.some((k) => INFO_KEYS.includes(k)) && c.marked);
    expect(bad.map((c) => `${c.file}:${c.line}  keys=${c.keys.join(",")}`),
      `告知类被误标成 error：\n      ${bad.map((c) => `${c.file}:${c.line}`).join("\n      ")}`).toEqual([]);
  });

  it("③ 自检：FAILURE_HINT 认得已知的失败键，且不会把告知键当成失败", () => {
    for (const k of ["timeline.modelApplyFailed", "shell.rewindFailed", "shell.attachmentUnsupported",
      "timeline.attachSkipped", "shell.kernelRequired", "shell.sessionKernelNotLoaded", "shell.openFolderFirst"]) {
      expect(FAILURE_HINT.test(k), `FAILURE_HINT 认不出失败键 ${k}`).toBe(true);
    }
    for (const k of ["timeline.queue.enqueued", "timeline.queue.mergedSent", "timeline.toolsFilterApplied",
      "stickers.exportedZip", "shell.toolSucceeded"]) {
      expect(FAILURE_HINT.test(k), `FAILURE_HINT 把告知键 ${k} 误判成失败`).toBe(false);
    }
  });
});
