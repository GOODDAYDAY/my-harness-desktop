// prefs 键的读写对账：每个持久化键都必须**既被写、又被回读**（r73）。
//
// ## 被守的缺陷：只写不读的持久化键
//
// `prefs` 是动态键 API（`get<T>(key)` / `set(key, value)`，无静态形状），键名收在
// `PREF_KEYS` 单源常量里（§1.3）。这类设计有一个特有的失败模式：
//
// **新增一个偏好 → 在 setter 里 `prefs.set(PREF_KEYS.x, v)` 落盘 → 忘了在启动水合里 `prefs.get`**
//
// 症状极其隐蔽：**当次会话里一切正常**（值在 zustand store 里），只有**重启之后**才发现
// 设置没保存。而重启是最不容易在开发中反复做的动作，所以这类缺陷常常活到用户报障。
// 反过来"只读不写"也一样：那个键永远是 undefined，只能靠回落默认值，设置改了不生效。
//
// ## 判据（以及首版踩的坑）
//
// 对 `PREF_KEYS` 的每个成员，在壳侧语料里找 `prefs.get` / `prefs.set` 的调用点。
//
// ⚠ **不能用正则去解析泛型实参**：首版写 `prefs\s*\.\s*get\s*(?:<[^>]*>)?\s*\(\s*PREF_KEYS\.x`，
// 而真实的读取点是 `prefs.get<Record<string, string>>(PREF_KEYS.lastSessionByCwd)` ——
// `Record<string, string>` 里**嵌套了 `>`**，`[^>]*` 提前截断，于是这个键被判成"只写不读"。
// > 修法与 r59 那次同源：**遇到嵌套语法就别用正则解析它**，改成"定位 `prefs.get` /
// `prefs.set`，再在其后 N 字符窗口里找 `PREF_KEYS.<name>`"。窗口匹配对泛型、换行、
// 注释都不敏感，代价只是可能把邻近的另一个键算进来——所以窗口要小（本文件用 80）。
//
// r73 实测：17 个键，读 17 / 写 17，**读写不平衡 0 个**。

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const PREF_SOURCE = "src/web/stores/ui-store.ts";
/** 语料：可能读写 prefs 的层。⚠ 含 plugins（插件经 ctx.prefs 读写）与 server（MainContext 侧）。 */
const CORPUS_ROOTS = ["src/web", "src/plugins", "src/server", "packages/react/src"];
/** 定位到 `prefs.get` / `prefs.set` 之后，在多大的窗口里找 `PREF_KEYS.<name>`。 */
const WINDOW = 80;

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) { if (name !== "node_modules" && !name.startsWith(".")) walk(full, out); }
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !full.includes("/locales/")) out.push(full);
  }
  return out;
}

/** 从单源常量里解析出全部 prefs 键名（成员名，即 `PREF_KEYS.<成员>` 的那个成员）。 */
function prefKeys(): string[] {
  const src = readFileSync(join(ROOT, PREF_SOURCE), "utf-8");
  const m = /export const PREF_KEYS = \{/.exec(src);
  expect(m, "找不到 PREF_KEYS 单源（判据会空转）").toBeTruthy();
  let i = m!.index + m![0].length - 1;
  let depth = 0;
  const buf: string[] = [];
  while (i < src.length) {
    const c = src[i];
    if (c === "{") depth += 1;
    else if (c === "}") { depth -= 1; if (depth === 0) break; }
    buf.push(c);
    i += 1;
  }
  return [...buf.join("").matchAll(/^\s*(\w+)\s*:/gm)].map((x) => x[1]);
}

/** 对每个键统计 get/set 调用点数（窗口匹配，不解析泛型）。 */
function countUsages(keys: string[]): Map<string, { get: string[]; set: string[] }> {
  const out = new Map<string, { get: string[]; set: string[] }>();
  for (const k of keys) out.set(k, { get: [], set: [] });
  for (const root of CORPUS_ROOTS) {
    for (const f of walk(join(ROOT, root))) {
      const rel = relative(ROOT, f);
      const src = readFileSync(f, "utf-8").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const m of src.matchAll(/prefs\s*\.\s*(get|set)\b/g)) {
        const win = src.slice(m.index! + m[0].length, m.index! + m[0].length + WINDOW);
        for (const k of keys) {
          if (win.includes(`PREF_KEYS.${k}`)) {
            const rec = out.get(k)!;
            (m[1] === "get" ? rec.get : rec.set).push(rel);
          }
        }
      }
    }
  }
  return out;
}

describe("prefs 键的读写对账：每个持久化键都必须既被写、又被回读", () => {
  const keys = prefKeys();
  const usage = countUsages(keys);

  it("判据不空转：解析到了单源里的全部键，且规模与实测一致", () => {
    // r73 实测 17 个键
    expect(keys.length, `只解析到 ${keys.length} 个 PREF_KEYS 成员（r73 实测 17）⇒ 单源解析可能坏了`).toBeGreaterThanOrEqual(15);
    for (const k of ["currentThemeId", "sidebarWidth", "lastCwd", "currentLocale", "lastSessionByCwd"]) {
      expect(keys, `已知键 ${k} 没被解析出来 ⇒ 判据漏了成员`).toContain(k);
    }
  });

  it("① 每个键都既有 prefs.set（落盘）又有 prefs.get（启动回读）", () => {
    const bad: string[] = [];
    for (const k of keys) {
      const u = usage.get(k)!;
      if (u.set.length === 0 && u.get.length === 0) bad.push(`${k}: 既不写也不读（死键 ⇒ 从 PREF_KEYS 删掉）`);
      else if (u.set.length === 0) bad.push(`${k}: 只读不写（永远 undefined，只能靠回落 ⇒ 补落盘或删键）`);
      else if (u.get.length === 0) bad.push(`${k}: **只写不读**（当次会话正常、重启后设置丢失 ⇒ 在启动水合里补 prefs.get）`);
    }
    expect(bad, [
      `${bad.length} 个 prefs 键读写不平衡：`,
      ...bad.map((x) => `      ${x}`),
      `      ⚠ "只写不读"的症状极隐蔽：当次会话一切正常（值在 store 里），只有**重启之后**才发现没保存。`,
      `      若这是**间接读写**（把 PREF_KEYS.x 存进变量再传），扩窗口或改成跟踪变量，不要加豁免。`,
    ].join("\n")).toEqual([]);
  });

  it("② 自检：窗口判据认得**嵌套泛型**的读取形态（首版就是在这里产假阳性的）", () => {
    // 真实形态：prefs.get<Record<string, string>>(PREF_KEYS.lastSessionByCwd)
    // 首版用 <[^>]*> 解析泛型，被 Record<string, string> 里的 `>` 截断 ⇒ 误判"只写不读"。
    const u = usage.get("lastSessionByCwd")!;
    expect(u.get.length, "自检失败：lastSessionByCwd 的读取点是 prefs.get<Record<string, string>>(…)，窗口判据必须认得它").toBeGreaterThan(0);
    expect(u.set.length, "自检失败：lastSessionByCwd 的写入点没被认出来").toBeGreaterThan(0);
    // 反例：窗口不得大到把无关的键算进来（否则判据太松、①恒真）
    expect(WINDOW, "窗口过大 ⇒ 邻近的其它键会被误算成读写点").toBeLessThanOrEqual(120);
  });

  it("③ 单源里的键名字面量与成员名一致（防止成员名与落盘键名漂移）", () => {
    const src = readFileSync(join(ROOT, PREF_SOURCE), "utf-8");
    const m = /export const PREF_KEYS = \{([\s\S]*?)\n\} as const;/.exec(src);
    expect(m, "PREF_KEYS 的字面量块没解析到").toBeTruthy();
    const mismatched: string[] = [];
    for (const line of m![1].split("\n")) {
      const fm = /^\s*(\w+)\s*:\s*"([^"]+)"/.exec(line);
      if (fm && fm[1] !== fm[2]) mismatched.push(`${fm[1]} → "${fm[2]}"`);
    }
    expect(mismatched, [
      `${mismatched.length} 个键的成员名与字面量不一致：`,
      ...mismatched.map((x) => `      ${x}`),
      `      后果：改成员名时落盘键名会跟着变（或反之），**用户已保存的偏好会静默失联**。`,
      `      若确实要改名，必须同时写迁移（读旧键 → 写新键），不能只改一边。`,
    ].join("\n")).toEqual([]);
  });
});
