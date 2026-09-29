// busy/loading 旗标必须在 finally 里解除（r211；钉住 r210 识别的"第四种静默失败形态"）。
//
// ## 钉的不变量
//
// **任何在 `await` 之前置起的 busy/loading 旗标，都必须在 `finally` 里解除。**
// 否则 promise reject 时（传输层 failAll 在鉴权被拒/连接断开时一律 reject，r177/r178）
// 旗标永久留着 ⇒ 按钮永久卡在 loading/disabled 态，用户只能重启应用。
//
// 这是 r210 识别的**第四种静默失败形态**：反馈通道只覆盖一半失效来源——
// "用返回值表达失败"的 API（`{ ok, error }` / done 回调）覆盖的是**被调方处理过的失败**，
// 覆盖不到**调用没完成**（reject/throw）。r210 修了 git-review 的 doCommit/doPush，
// 本轮普查全仓（判据同 r210）只找到 1 处：kernel-version-page 的 install
// （`setInstalling(true)` 后 await，清除只在 done 回调与 `if (!r.ok)` 里 ⇒ reject 时卡死），已修。
//
// ## 为什么这条能交硬断言（不是棘轮）
//
// 判据是**封闭形态**（r192 的判据：命中集可否机械复核）：
// ① `set(Busy|Loading|Working|Pending|Saving|Installing|Checking|Submitting|Removing|Switching)(非 null/false)`
// ② 同一函数体内后面有 `await`
// ③ 该函数体内**没有 `finally`**
// 三条都是语法形状，不涉及语义判断 ⇒ 可以要求 0 命中（当前实测 0）。
//
// ⚠ 已知边界（如实标注，不当作已解决）：函数体的范围用"最近的 `{` 到其配对 `}`"近似，
//   所以嵌套回调里的 `finally` 可能被算作外层的（偏宽松 ⇒ 只会漏报、不会误报）；
//   反过来，若旗标与 await 分属两个函数（如把 await 抽成助手），本判据看不见 ⇒ 也是漏报。
//   两种都是**保守方向**（不会逼人加豁免），符合 r77 的纪律。

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const ROOTS = ["src", "packages/react/src", "packages/shared/src"];

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) { if (name !== "node_modules" && name !== "locales" && !name.startsWith(".")) walk(full, out); }
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}
function strip(s0: string): string {
  // 剥注释只用于匹配；行号在原文件上算（r171/r182/r194/r202 的坑，已第五次）
  return s0.replace(/\/\*[\s\S]*?\*\//g, "").split("\n")
    .map((l) => (l.trim().startsWith("//") ? "" : l)).join("\n");
}
function matchBrace(s: string, i: number): number {
  let d = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === "{") d++;
    else if (s[j] === "}") { d--; if (d === 0) return j; }
  }
  return -1;
}

const SETTER = /\b(set(?:Busy|Loading|Working|Pending|Saving|Installing|Checking|Submitting|Removing|Switching))\s*\(\s*(?!null|false)/g;

interface Hit { file: string; line: number; setter: string }

function scan(): { hits: Hit[]; setters: number; withAwait: number } {
  const files = ROOTS.flatMap((r) => walk(join(ROOT, r)));
  const hits: Hit[] = [];
  let setters = 0, withAwait = 0;
  for (const f of files) {
    const rawFile = readFileSync(f, "utf-8");
    const s = strip(rawFile);
    const rel = relative(ROOT, f);
    for (const m of s.matchAll(SETTER)) {
      setters++;
      const st = s.lastIndexOf("{", m.index!);
      const en = st >= 0 ? matchBrace(s, st) : -1;
      const body = en > st ? s.slice(st, en) : s.slice(m.index!, m.index! + 1500);
      const after = en > st ? body.slice(m.index! - st) : body;
      if (!after.includes("await ")) continue;
      withAwait++;
      if (body.includes("finally")) continue;
      const occ = [...s.slice(0, m.index!).matchAll(SETTER)].length;
      const rawIdx = [...rawFile.matchAll(SETTER)][occ]?.index ?? m.index!;
      hits.push({ file: rel, line: rawFile.slice(0, rawIdx).split("\n").length, setter: m[1] });
    }
  }
  return { hits, setters, withAwait };
}

describe("busy/loading 旗标必须在 finally 里解除（否则 reject 时按钮永久卡住）", () => {
  const r = scan();

  it("判据不空转：扫到了旗标置起点，且其中确实有后接 await 的（否则判据可能在漏）", () => {
    expect(r.setters, `旗标置起点总数（r211 实测应 > 20）：${r.setters}`).toBeGreaterThan(20);
    expect(r.withAwait, "其中后接 await 的（这些才需要 finally）").toBeGreaterThan(5);
  });

  it("① 后接 await 的旗标置起点，所在函数体必须有 finally（0 命中；r211 修掉最后 1 处）", () => {
    expect(r.hits.map((h) => `${h.file}:${h.line} ${h.setter}`), [
      "在 await 之前置起的 busy/loading 旗标，必须在 finally 里解除。",
      "      否则 promise reject 时（传输层 failAll 在鉴权被拒/连接断开时一律 reject）",
      "      旗标永久留着 ⇒ 按钮永久卡在 loading/disabled 态，用户只能重启应用。",
      "      这是 r210 识别的**第四种静默失败形态**：'用返回值表达失败'的 API",
      "      （{ ok, error } / done 回调）只覆盖被调方处理过的失败，覆盖不到'调用没完成'。",
      "      修法：try { … } catch (err) { 把 reject 也变成可见错误 } finally { setXxx(null/false) }。",
      "      参照 r210 的 git-review doCommit/doPush 与 r211 的 kernel-version-page install。",
    ].join("\n")).toEqual([]);
  });
});
