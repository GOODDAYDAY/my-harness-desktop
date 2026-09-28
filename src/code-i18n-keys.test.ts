// 代码里 `t("…")` 的静态键必须在四个语言包里都存在（r77）。
//
// ## 被守的缺陷：键写错 ⇒ 界面显示裸键
//
// i18next 查不到键时**不报错**，而是把键名本身当译文返回（`returnEmptyString:false` 也不影响这条），
// 于是界面上直接出现 `sessions.collapse` 这样的字符串。它显眼但不崩溃、不进控制台、
// tsc 也不管（键是普通字符串），所以只能靠对账发现。
//
// r77 实测：**911 处静态 `t("…")` 调用、749 种键**，其中 **5 种四语言全缺**（已修）：
//
// | 键 | 用处 | 修法 |
// |---|---|---|
// | `sessions.collapse` / `sessions.expand` | 子会话分组开关的 `title`（既是 tooltip 也是**可访问名**） | 改用**已存在**的共享键 `shell.collapse` / `shell.expand`（§1.3：不另造一份重复译文） |
// | `sessions.dragToReorder` | 拖拽手柄的 tooltip | 同上，改用已存在的 `shell.dragToReorder` |
// | `dsh.extTitle` | DSH 内核扩展页标题 | 补四语言（`minimal.extTitle`="Minimal 拓展"、`probe4.extTitle`="Probe4 拓展" 已确立范式 ⇒ "DSH 拓展"/"DSH Extensions"/"DSH-Erweiterungen"） |
// | `shell.composerReadonly` | 输入框只读条的**默认**文案（策略未声明 `readonlyMessageKey` 时用） | 补四语言 |
//
// 三个是"另造了一份不存在的键"，两个是"该有却没有"。前者的正确修法**不是补译文**，
// 而是改用既有共享键——补译文会让同一句文案在语言包里有两份，将来必然漂移（§1.3）。
//
// ## 判据与它**不覆盖**的部分（边界要写清）
//
// 覆盖：`t("字面量")` 与 `i18next.t("字面量")`（r56 起非组件的壳代码走 i18next 单例）。
// **不覆盖**：动态键——模板串 `` t(`shell.greeting.${n}`) ``、变量 `t(key)`、
// 以及经 manifest/`registerChannels` 传入的 `labelKey`（那两类由
// `manifest-i18n-keys.test.ts` 与 `channel-meta-i18n.test.ts` 各自负责）。
// 实测动态形态 34 处；把它们算进来会产假阳性（无法静态求出键名），
// 所以显式排除，并由"反方向死键"这类需求另立判据（需要按前缀族匹配，本轮未做）。
//
// r77 修复后实测：静态键 749 种、四语言缺失 **0**。

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const LOCALES = ["zh-CN", "zh-TW", "en", "de"];
const CODE_ROOTS = ["src/web", "src/plugins", "packages/react/src"];
const PLUGIN_ROOTS = ["src/plugins", "test-plugins"];

function walk(dir: string, pred: (n: string) => boolean, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) { if (name !== "node_modules" && !name.startsWith(".")) walk(full, pred, out); }
    else if (pred(name)) out.push(full);
  }
  return out;
}

/** 四语言各自的键集（全部插件的语言包扁平合并——i18next 就是这么合并的）。 */
function packs(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const loc of LOCALES) {
    const set = new Set<string>();
    for (const root of PLUGIN_ROOTS) {
      for (const f of walk(join(ROOT, root), (n) => n.endsWith(".json"))) {
        if (!f.includes(`/locales/${loc}/`)) continue;
        try {
          for (const k of Object.keys(JSON.parse(readFileSync(f, "utf-8")) as Record<string, unknown>)) set.add(k);
        } catch { /* 非法 JSON 由 locale-parity 那条守卫负责 */ }
      }
    }
    out.set(loc, set);
  }
  return out;
}

/** 代码里的静态 t() 键（含 i18next.t）。 */
function staticKeys(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const root of CODE_ROOTS) {
    for (const f of walk(join(ROOT, root), (n) => /\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n))) {
      if (f.includes("/locales/")) continue;
      const src = readFileSync(f, "utf-8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
      for (const m of src.matchAll(/(?:^|[^\w$.])i18next\s*\.\s*t\s*\(\s*"([^"]+)"|(?:^|[^\w$.])t\s*\(\s*"([^"]+)"/g)) {
        const key = m[1] ?? m[2];
        out.set(key, [...(out.get(key) ?? []), relative(ROOT, f)]);
      }
    }
  }
  return out;
}

describe("代码里的静态 i18n 键：四个语言包都必须有", () => {
  const keys = staticKeys();
  const pk = packs();

  it("判据不空转：键与语言包的规模都与实测一致", () => {
    // r77 实测：749 种静态键 / 911 处调用；每语言 1707 个键
    expect(keys.size, `只扫到 ${keys.size} 种静态 t() 键（r77 实测 749）⇒ 判据可能坏了`).toBeGreaterThan(600);
    let sites = 0;
    for (const v of keys.values()) sites += v.length;
    expect(sites, `只扫到 ${sites} 处调用点`).toBeGreaterThan(700);
    for (const loc of LOCALES) {
      expect(pk.get(loc)!.size, `${loc} 语言包只有 ${pk.get(loc)!.size} 个键（r77 实测 1700+）⇒ 语言包路径判据坏了`).toBeGreaterThan(1500);
    }
    // 自检：已知存在的键必须在（否则"缺失 0"是假的）
    for (const k of ["shell.collapse", "shell.expand", "shell.dragToReorder", "dsh.extTitle", "shell.composerReadonly"]) {
      for (const loc of LOCALES) {
        expect(pk.get(loc)!.has(k), `自检失败：${k} 在 ${loc} 里找不到（r77 刚补/刚改用的键）`).toBe(true);
      }
    }
  });

  it("① 每个静态键在四个语言里都有译文（缺一个就会有语言显示裸键）", () => {
    const missing: string[] = [];
    for (const [key, where] of keys) {
      const lack = LOCALES.filter((loc) => !pk.get(loc)!.has(key));
      if (lack.length > 0) missing.push(`${key} 缺 ${lack.join(",")}（${where[0]}${where.length > 1 ? ` 等 ${where.length} 处` : ""}）`);
    }
    expect(missing, [
      `${missing.length} 个静态键缺译文：`,
      ...missing.slice(0, 16).map((x) => `      ${x}`),
      `      后果：i18next 查不到键时**把键名当译文返回**，界面上直接出现 "sessions.collapse" 这种字符串；`,
      `            不报错、不进控制台、tsc 也不管（键是普通字符串）。`,
      `      修法：① 若已有同义的**共享键**（shell.* 等），改用它——不要另造一份重复译文（§1.3，将来必漂移）；`,
      `            ② 确实需要新键，就在归属插件的 locales/<四个语言>/ 里同时补齐（缺一即本条红）。`,
    ].join("\n")).toEqual([]);
  });

  it("② 译文非空、且不得与键名相同（那等于没译）", () => {
    const bad: string[] = [];
    for (const key of keys.keys()) {
      for (const loc of LOCALES) {
        const set = pk.get(loc)!;
        if (!set.has(key)) continue; // 缺失由 ① 报
      }
    }
    // 逐语言取值检查（需要读到值，不只是键集）
    for (const loc of LOCALES) {
      for (const root of PLUGIN_ROOTS) {
        for (const f of walk(join(ROOT, root), (n) => n.endsWith(".json"))) {
          if (!f.includes(`/locales/${loc}/`)) continue;
          let obj: Record<string, unknown>;
          try { obj = JSON.parse(readFileSync(f, "utf-8")) as Record<string, unknown>; } catch { continue; }
          for (const [k, v] of Object.entries(obj)) {
            if (!keys.has(k)) continue;
            if (typeof v !== "string" || v.trim() === "" || v === k) {
              bad.push(`${loc} ${k} = ${JSON.stringify(v)}（${relative(ROOT, f)}）`);
            }
          }
        }
      }
    }
    expect(bad, `被代码引用的键里有 ${bad.length} 条译文为空或等于键名：\n      ${bad.slice(0, 10).join("\n      ")}`).toEqual([]);
  });

  it("③ 自检：判据抓得到**故意写错**的键，且认得 i18next.t 形态", () => {
    // 用真实语料拼一段代码，验证提取器行为（不依赖仓库当前状态）
    const probe = (code: string): string[] => {
      const out: string[] = [];
      for (const m of code.matchAll(/(?:^|[^\w$.])i18next\s*\.\s*t\s*\(\s*"([^"]+)"|(?:^|[^\w$.])t\s*\(\s*"([^"]+)"/g)) out.push(m[1] ?? m[2]);
      return out;
    };
    expect(probe('const a = t("shell.collapse");'), "自检失败：普通 t(\"…\") 没被提取").toEqual(["shell.collapse"]);
    expect(probe('failAll(i18next.t("shell.wsDisconnected"));'), "自检失败：i18next.t(\"…\") 形态没被提取（r56 起壳代码用这个）").toEqual(["shell.wsDisconnected"]);
    expect(probe('const x = t(`shell.greeting.${n}`);'), "自检失败：模板串被当成静态键了（会产生无法核对的假键）").toEqual([]);
    expect(probe("const y = t(key);"), "自检失败：变量键被当成静态键了").toEqual([]);
    // 反例：不要把 xxxt("…") 之类的同名后缀误当 t(
    expect(probe('const z = format("a.b");'), "自检失败：非 t() 的调用被算进来了").toEqual([]);
    // 缺失检测本身：一个显然不存在的键必须被判为缺失
    expect(LOCALES.every((loc) => !pk.get(loc)!.has("shell.thisKeyDoesNotExistR77")), "自检失败：不存在的键被判成存在 ⇒ ① 恒真").toBe(true);
  });
});
