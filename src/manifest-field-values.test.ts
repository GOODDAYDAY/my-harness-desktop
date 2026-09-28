// manifest 的**字段值**校验：枚举取值合法 + 图标名可解析（r66）。
//
// ## 为什么需要这条守卫
//
// `plugin.json` 是 JSON，**tsc 不检查它**。契约（`packages/shared/src/domain/contributions.ts`）
// 把很多字段定义成字符串枚举（`saveMode?: "framework" | "manual"`、
// `when?: { target?: "file" | "dir" | "both" }`、`placement?: "left" | "right"` …），
// 但 manifest 里写成 `"manual "`（多个空格）、`"files"`（多个 s）、`"Manual"`（大小写）
// 都不会有任何编译期信号——运行时的表现是**静默失效**：
//   · `saveMode` 写错 ⇒ 落到默认保存模式，用户改配置后"保存"按钮的行为与预期不符；
//   · `when.target` 写错 ⇒ 文件动作在错误的目标类型上出现/消失；
//   · `placement` 写错 ⇒ 消息动作按钮跑到另一侧；
//   · `icon` 写错 ⇒ 回落成 Puzzle 图标（这个至少**看得见**，其余三个都看不见）。
//
// 这与 r63（component 名对不上 ⇒ 槽位静默空白）、r64（locale 文件未登记 ⇒ 静默不加载）、
// r65（i18n 键不存在 ⇒ 显示裸键）是同一族：**manifest 是字符串世界，契约是类型世界，
// 两者之间没有任何自动检查**。本条补的是"值域"这一半（r63 补的是"组件名"，r65 补的是"键名"）。
//
// ## 判据要点
//
// 允许值**从契约源码解析**，不在本文件里另抄一份——否则契约加了新取值而守卫不知道，
// 合法写法会被判违规（假阳性），或者反过来新取值没人校验（假阴性）。§1.3 契约单源。
// 图标名的合法集 = `ICONS` 表的键 ∪ **内核插件的 id**（`PluginIcon` 对内核 id 走
// `KernelLogo` 投影，判据是运行时的 `window.kernel.kernelIds`，所以静态侧用
// "带 `kernel` 块的插件 id" 来对应）。

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const PLUGIN_ROOTS = ["src/plugins", "test-plugins"];
const CONTRACT = join(ROOT, "packages/shared/src/domain/contributions.ts");
const ICON_FILE = join(ROOT, "packages/react/src/widgets/plugin-icon.tsx");

function walkFiles(dir: string, pred: (name: string) => boolean, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) { if (name !== "node_modules" && !name.startsWith(".")) walkFiles(full, pred, out); }
    else if (pred(name)) out.push(full);
  }
  return out;
}

/** 从契约源码解析「字段名 → 允许的字符串字面量集合」。
 *  认两种写法：`field?: "a" | "b";` 与嵌套对象里的 `field?: "a" | "b";`。 */
function enumsFromContract(): Map<string, Set<string>> {
  const src = readFileSync(CONTRACT, "utf-8").replace(/\/\*[\s\S]*?\*\//g, "");
  const out = new Map<string, Set<string>>();
  // ⚠ 不能锚在行首：`when?: { target?: "file" | "dir" | "both" };` 这种**行内嵌套对象**里的
  //   字段也在同一行中段。首版用 `^\s*` 锚行首，于是 `target` 整个漏掉——
  //   是 ③ 的自检（拿契约里真实存在的字段名当样本）当场抓出来的。
  //   还要允许值后面跟 `}`（行内对象的收尾）：`when?: { target?: "file" | "dir" | "both" };`
  //   的值结束符是 `};` 而不是 `;`——首版漏了这个，`target` 依旧解析不到。
  for (const m of src.matchAll(/(?:^|[;{,])\s*(\w+)\??\s*:\s*((?:"[^"]+"(?:\s*\|\s*)?)+)\s*\}?\s*;/gm)) {
    const field = m[1];
    const values = [...m[2].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    if (values.length >= 2) out.set(field, new Set(values));
  }
  return out;
}

/** ICONS 表里的图标名。 */
function iconNames(): Set<string> {
  const src = readFileSync(ICON_FILE, "utf-8");
  const m = /const ICONS[^=]*=\s*\{/.exec(src);
  expect(m, "找不到 ICONS 表（判据会空转）").toBeTruthy();
  let i = m!.index + m![0].length - 1;
  let depth = 0;
  const buf: string[] = [];
  while (i < src.length) {
    const c = src[i];
    if (c === "{") depth += 1;
    else if (c === "}") depth -= 1;
    buf.push(c);
    if (depth === 0) break;
    i += 1;
  }
  return new Set([...buf.join("").matchAll(/^\s*"?([\w-]+)"?\s*:/gm)].map((x) => x[1]));
}

/** 带 `kernel` 块的插件 id（= 内核插件，它们的 id 可以当图标名用，走 KernelLogo）。 */
function kernelPluginIds(): Set<string> {
  const out = new Set<string>();
  for (const root of PLUGIN_ROOTS) {
    for (const f of walkFiles(join(ROOT, root), (n) => n === "plugin.json")) {
      const j = JSON.parse(readFileSync(f, "utf-8")) as { id?: string; kernel?: unknown };
      if (j.id && j.kernel) out.add(j.id);
    }
  }
  return out;
}

interface Manifest { file: string; json: Record<string, unknown> }
function manifests(): Manifest[] {
  const out: Manifest[] = [];
  for (const root of PLUGIN_ROOTS) {
    for (const f of walkFiles(join(ROOT, root), (n) => n === "plugin.json")) {
      out.push({ file: relative(ROOT, f), json: JSON.parse(readFileSync(f, "utf-8")) as Record<string, unknown> });
    }
  }
  return out;
}

/** 递归收集所有 (字段名, 值, 路径)，供枚举校验用。 */
function collectFields(node: unknown, path: string, out: { field: string; value: string; path: string }[]): void {
  if (Array.isArray(node)) { node.forEach((v, i) => collectFields(v, `${path}[${i}]`, out)); return; }
  if (!node || typeof node !== "object") return;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (typeof v === "string") out.push({ field: k, value: v, path: `${path}.${k}` });
    else collectFields(v, `${path}.${k}`, out);
  }
}

describe("manifest 字段值：枚举取值必须合法，图标名必须可解析", () => {
  const enums = enumsFromContract();
  const icons = iconNames();
  const kernelIds = kernelPluginIds();
  const ms = manifests();

  it("判据不空转：契约里解析到了枚举字段，且已知的几个都在", () => {
    expect(enums.size, `只从契约解析到 ${enums.size} 个枚举字段（应 ≥4）——解析正则可能失效`).toBeGreaterThanOrEqual(4);
    for (const f of ["saveMode", "configMerge", "placement", "target"]) {
      expect(enums.has(f), `契约里的枚举字段 ${f} 没被解析出来 ⇒ 它不会被校验（假绿）`).toBe(true);
    }
    // 自检：解析出的取值必须是"看得懂的短词"，而不是把注释/类型名当成了取值
    expect([...enums.get("saveMode")!].sort(), "saveMode 的允许值解析错了").toEqual(["framework", "manual"]);
    expect(icons.size, "ICONS 表一个图标都没解析到").toBeGreaterThan(30);
    expect(kernelIds.size, "一个内核插件都没扫到（应含 pi/dsh/minimal/probe4）").toBeGreaterThanOrEqual(4);
    expect(ms.length, "一个 manifest 都没扫到").toBeGreaterThan(30);
  });

  it("① manifest 里的枚举字段取值必须在契约允许的集合内（写错 = 静默失效）", () => {
    const bad: string[] = [];
    for (const m of ms) {
      const fields: { field: string; value: string; path: string }[] = [];
      collectFields(m.json, "", fields);
      for (const f of fields) {
        const allowed = enums.get(f.field);
        if (!allowed) continue;
        if (!allowed.has(f.value)) {
          bad.push(`${m.file} ${f.path} = ${JSON.stringify(f.value)}（契约允许：${[...allowed].join(" | ")}）`);
        }
      }
    }
    expect(bad, [
      `${bad.length} 处枚举取值非法：`,
      ...bad.slice(0, 12).map((x) => `      ${x}`),
      `      后果是**静默**的：manifest 是 JSON、tsc 不检查，运行时会落到默认分支或直接不匹配。`,
    ].join("\n")).toEqual([]);
  });

  it("② manifest 里的 icon 名必须可解析（ICONS 表 ∪ 内核插件 id），否则回落成 Puzzle 图标", () => {
    const bad: string[] = [];
    let checked = 0;
    for (const m of ms) {
      const fields: { field: string; value: string; path: string }[] = [];
      collectFields(m.json, "", fields);
      for (const f of fields) {
        if (f.field !== "icon") continue;
        checked += 1;
        if (!icons.has(f.value) && !kernelIds.has(f.value)) {
          bad.push(`${m.file} ${f.path} = ${JSON.stringify(f.value)}`);
        }
      }
    }
    expect(checked, "一个 icon 字段都没扫到（r66 实测 40+ 个）⇒ 判据空转").toBeGreaterThan(20);
    expect(bad, [
      `${bad.length} 个图标名解析不到：`,
      ...bad.slice(0, 10).map((x) => `      ${x}`),
      `      后果：PluginIcon 回落到 Puzzle 图标（这个至少看得见，不像枚举那样完全静默）。`,
      `      合法集 = ICONS 表的键 ∪ 内核插件 id（后者走 KernelLogo 投影，§6.1 logo 不进静态表）。`,
    ].join("\n")).toEqual([]);
  });

  it("③ 自检：判据抓得到**故意写错**的枚举值与图标名（否则 ①② 恒真）", () => {
    // 枚举：拿一个真实允许值改一个字母，必须被判非法
    const allowed = [...enums.get("saveMode")!];
    for (const v of allowed) expect(enums.get("saveMode")!.has(v)).toBe(true);
    expect(enums.get("saveMode")!.has("manua1"), "自检失败：非法值被判成合法 ⇒ ① 恒真").toBe(false);
    expect(enums.get("saveMode")!.has("Manual"), "自检失败：大小写不同也应判非法（枚举是精确匹配）").toBe(false);
    // 图标：真名要在、错一名要不在
    const someIcon = [...icons][0];
    expect(icons.has(someIcon)).toBe(true);
    expect(icons.has(`${someIcon}-typo`), "自检失败：不存在的图标名被判成存在 ⇒ ② 恒真").toBe(false);
  });
});
