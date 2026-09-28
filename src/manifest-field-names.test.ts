// manifest 的**字段名**与 **theme token 名**必须对得上契约（r67）。
//
// ## 补的是 r63–r66 那条缝的最后一半
//
// `plugin.json` 是 JSON、**tsc 不检查它**，所以 manifest 与契约之间没有任何自动对账。
// 前四轮各补了一半：r63 组件名 ↔ renderer 导出、r64 locale 文件 ↔ languages 登记、
// r65 `*Key` ↔ 四语言译文、r66 枚举取值 ↔ 契约允许值 + `icon` ↔ 图标表。
// 本轮补两样：
//
//   **① 字段名本身。** 拼错一个字段名（`labelKey` → `labellKey`、`revealOn` → `revealOn `）
//      比枚举值写错**更隐蔽**：枚举值错还会落到默认分支，字段名错等于**那个字段根本不存在**，
//      壳读不到、也不报错，贡献项就带着缺省的形状渲染（或干脆不生效）。
//   **② theme token 名。** `themes[].tokens` 里的路径（如 `color.accent.success`）
//      若不在圆心的 `THEME_TOKEN_DEFAULTS` 里，就是**写了一个没人读的 token**——
//      主题看起来"配了"，实际那条不生效，而且没有任何提示。
//
// ## 两个判据上的关键决定
//
// **允许值/允许名从源码解析，不在本文件另抄一份**（§1.3）：契约加了新字段、
// 圆心加了新 token，守卫自动跟上；反之若在这里硬编码一份清单，就会同时产生
// 假阳性（新合法写法被判违规）与假阴性（清单漏项没人校验）。
//
// **`themes[].tokens` 子树在 ① 里整棵豁免**：它不是固定形状的 record，
// 而是**自由 token 字典**（键就是 token 路径本身）。首版没豁免它，于是报出 307 处
// "未知字段名"（`bg` / `sm` / `fg` / `surface-fg` …全是 token 路径的分段）——
// 全是假阳性。它的合法性由 ② 单独守（token 路径必须存在于 `THEME_TOKEN_DEFAULTS`）。
//
// r67 实测：字段名 2727 个（排除 tokens 子树后）未知 **0**；
// token 声明 307 个、`THEME_TOKEN_DEFAULTS` 有 48 条路径、未知 **0**。

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const PLUGIN_ROOTS = ["src/plugins", "test-plugins"];
const CONTRACT_FILES = [
  "packages/shared/src/domain/contributions.ts",
  "packages/shared/src/domain/context.ts",
];
const TOKEN_FILE = "packages/shared/src/domain/slots/theme-tokens.ts";

function walk(dir: string, pred: (name: string) => boolean, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) { if (name !== "node_modules" && !name.startsWith(".")) walk(full, pred, out); }
    else if (pred(name)) out.push(full);
  }
  return out;
}

/** 契约里所有 interface/type 体内出现过的字段名（扁平并集）。 */
function knownFieldNames(): Set<string> {
  const out = new Set<string>();
  for (const rel of CONTRACT_FILES) {
    const p = join(ROOT, rel);
    if (!existsSync(p)) continue;
    const src = readFileSync(p, "utf-8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of src.matchAll(/(?:export )?(?:interface|type)\s+\w+[^\{]*\{/g)) {
      let i = m.index! + m[0].length;
      let depth = 1;
      const buf: string[] = [];
      while (i < src.length && depth > 0) {
        const c = src[i];
        if (c === "{") depth += 1;
        else if (c === "}") depth -= 1;
        if (depth > 0) buf.push(c);
        i += 1;
      }
      for (const ln of buf.join("").split("\n")) {
        const st = ln.trim();
        if (!st || st.startsWith("//") || st.startsWith("*")) continue;
        // ⚠ 不能锚行首：`when?: { target?: … }` 这类行内嵌套对象的字段在同一行中段（r66 踩过）
        for (const fm of st.matchAll(/(?:^|[;{,])\s*(\w+)\??\s*:/g)) out.add(fm[1]);
      }
    }
  }
  return out;
}

/** `THEME_TOKEN_DEFAULTS` 里的 token 路径（该常量是**扁平点号键**映射）。 */
function knownTokenPaths(): Set<string> {
  const src = readFileSync(join(ROOT, TOKEN_FILE), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  const m = /THEME_TOKEN_DEFAULTS[^=]*=\s*\{/.exec(src);
  expect(m, "找不到 THEME_TOKEN_DEFAULTS（判据会空转）").toBeTruthy();
  let i = m!.index + m![0].length;
  let depth = 1;
  const out = new Set<string>();
  const key = /(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$-]*))\s*:\s*/y;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === "{") { depth += 1; i += 1; continue; }
    if (c === "}") { depth -= 1; i += 1; continue; }
    if (/\s/.test(c) || c === ",") { i += 1; continue; }
    key.lastIndex = i;
    const km = key.exec(src);
    if (km) {
      const k = km[1] ?? km[2] ?? km[3];
      let j = km.index + km[0].length;
      while (j < src.length && /\s/.test(src[j])) j += 1;
      if (src[j] === "{") { depth += 1; i = j + 1; continue; }
      out.add(k);
      i = km.index + km[0].length;
      // 跳过值（字符串里的逗号/花括号要忽略）
      while (i < src.length) {
        if (src[i] === '"') { i += 1; while (i < src.length && src[i] !== '"') { if (src[i] === "\\") i += 1; i += 1; } }
        else if (src[i] === "," || src[i] === "}") break;
        i += 1;
      }
      continue;
    }
    i += 1;
  }
  return out;
}

interface Manifest { file: string; json: Record<string, unknown> }
function manifests(): Manifest[] {
  const out: Manifest[] = [];
  for (const root of PLUGIN_ROOTS) {
    for (const f of walk(join(ROOT, root), (n) => n === "plugin.json")) {
      out.push({ file: relative(ROOT, f), json: JSON.parse(readFileSync(f, "utf-8")) as Record<string, unknown> });
    }
  }
  return out;
}

/** 把嵌套的 tokens 对象扁平成点路径（`{color:{bg:x}}` → `color.bg`）。 */
function flattenTokens(obj: unknown, prefix = "", out: string[] = []): string[] {
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) flattenTokens(v, `${prefix}${k}.`, out);
  } else if (prefix) {
    out.push(prefix.slice(0, -1));
  }
  return out;
}

describe("manifest 的字段名与 theme token 名：必须对得上契约/圆心", () => {
  const known = knownFieldNames();
  const tokens = knownTokenPaths();
  const ms = manifests();

  it("判据不空转：三份清单都非空，且规模与实测一致", () => {
    expect(known.size, `只解析到 ${known.size} 个契约字段名（r67 实测 200+）——解析正则可能失效`).toBeGreaterThan(150);
    expect(tokens.size, `只解析到 ${tokens.size} 个 token 路径（r67 实测 48）——扁平点号键的解析可能失效`).toBeGreaterThanOrEqual(40);
    expect(ms.length, "一个 manifest 都没扫到").toBeGreaterThan(30);
    // 自检：已知应该被解析到的真实名字必须在清单里（用真名，不用编造名）
    for (const f of ["labelKey", "revealOn", "saveMode", "component", "configFile"]) {
      expect(known.has(f), `契约字段 ${f} 没被解析出来 ⇒ 它的拼写错误不会被发现（假绿）`).toBe(true);
    }
    for (const t of ["color.bg", "color.accent.success", "border.width.thin"]) {
      expect(tokens.has(t), `token 路径 ${t} 没被解析出来 ⇒ 判据基数是空的，②会恒真`).toBe(true);
    }
  });

  it("① manifest 里不得出现契约之外的字段名（拼错 = 该字段静默不存在）", () => {
    const bad: string[] = [];
    let checked = 0;
    for (const m of ms) {
      const c = (m.json.contributes ?? {}) as Record<string, unknown>;
      for (const [slot, items] of Object.entries(c)) {
        if (!Array.isArray(items)) continue;
        items.forEach((item, n) => {
          const chk = (obj: unknown, path: string, skipTokens: boolean): void => {
            if (Array.isArray(obj)) { obj.forEach((v, j) => chk(v, `${path}[${j}]`, false)); return; }
            if (!obj || typeof obj !== "object") return;
            for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
              // ⚠ `themes[].tokens` 是**自由 token 字典**（键就是 token 路径），
              //   整棵子树跳过 —— 它的合法性由 ② 单独守。首版没跳，报了 307 处假阳性。
              if (skipTokens && k === "tokens") continue;
              checked += 1;
              if (!known.has(k)) bad.push(`${m.file}  ${slot}[${n}]${path}.${k}`);
              chk(v, `${path}.${k}`, false);
            }
          };
          chk(item, "", true);
        });
      }
    }
    expect(checked, `只检查了 ${checked} 个字段名（r67 实测 2700+）⇒ 遍历可能坏了`).toBeGreaterThan(2000);
    expect(bad, [
      `${bad.length} 个字段名在契约里不存在：`,
      ...bad.slice(0, 12).map((x) => `      ${x}`),
      `      后果比枚举值写错**更隐蔽**：枚举错会落到默认分支，字段名错等于该字段根本不存在，`,
      `      壳读不到也不报错，贡献项带着缺省形状渲染（或干脆不生效）。`,
      `      ⚠ 若报的是 themes[].tokens 里的键，说明豁免逻辑失效了（那是自由字典，由 ② 守）。`,
    ].join("\n")).toEqual([]);
  });

  it("② themes[].tokens 里的每个 token 路径都必须存在于 THEME_TOKEN_DEFAULTS", () => {
    const bad = new Map<string, string[]>();
    let total = 0;
    for (const m of ms) {
      const themes = ((m.json.contributes ?? {}) as { themes?: { id?: string; tokens?: unknown }[] }).themes ?? [];
      for (const th of themes) {
        for (const p of flattenTokens(th.tokens)) {
          total += 1;
          if (!tokens.has(p)) {
            const arr = bad.get(p) ?? [];
            arr.push(`${m.file} theme=${th.id ?? "?"}`);
            bad.set(p, arr);
          }
        }
      }
    }
    expect(total, `只检查了 ${total} 个 token 声明（r67 实测 307）⇒ 遍历可能坏了`).toBeGreaterThan(200);
    const lines = [...bad.entries()].map(([p, where]) => `${p}  ← ${where.slice(0, 2).join(", ")}`);
    expect(lines, [
      `${bad.size} 种 token 路径不在圆心的 THEME_TOKEN_DEFAULTS 里：`,
      ...lines.slice(0, 14).map((x) => `      ${x}`),
      `      后果：主题"看起来配了"，实际那条 token 没人读、不生效，且没有任何提示。`,
      `      修法：改用 DEFAULTS 里已有的 token 名；若确实需要新 token，先在圆心加默认值`,
      `      （THEME_TOKEN_DEFAULTS 是兜底色值的单源，§7.1 已标注为演进项）。`,
    ].join("\n")).toEqual([]);
  });

  it("③ 自检：判据抓得到**故意拼错**的字段名与 token 名（否则 ①② 恒真）", () => {
    expect(known.has("labelKeyy"), "自检失败：拼错的字段名被判成合法 ⇒ ① 恒真").toBe(false);
    expect(known.has("revealOnn"), "自检失败：同上").toBe(false);
    expect(tokens.has("color.bg.extra"), "自检失败：不存在的 token 路径被判成合法 ⇒ ② 恒真").toBe(false);
    expect(tokens.has("colour.bg"), "自检失败：拼错的 token 名被判成合法").toBe(false);
    // 正向对照：真名必须在（否则上面四条只是"集合恒空"的假象）
    expect(known.has("labelKey")).toBe(true);
    expect(tokens.has("color.bg")).toBe(true);
  });
});
