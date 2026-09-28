// `ChannelMeta` 声明的每个 i18n 键，必须在该插件的**四个语言**里都存在（r55）。
//
// ## 背景
//
// `ChannelMeta` 的文案字段原本是 `label` / `description`（**文本**），契约注释还明写
// 「文案归插件自持有，直接写文本或走 i18n 均可」。那句"均可"就是债务的批准书：
// 8 个通道**全部**直接写了中文，于是 en / de / zh-TW 用户在键位绑定页看到中文，
// 而硬编码文案守卫的债务棘轮里长期挂着这 20 处（r53 首测 37 处里的一大半）。
//
// r55 把字段改成 `labelKey` / `descriptionKey`（与本仓既有的 `ThemeContribution.labelKey` /
// `FontPresetContribution.labelKey` 同形态），消费方（`keybindings/renderer/settings.tsx`）
// 一律 `t(key)` 解析，缺键时回退显示 **channel 名**（不是键名——键名对用户毫无意义）。
//
// ## 这条守卫补的是什么
//
// 改成键之后出现一个**新的失败模式**：键写错或某个语言漏译 ⇒ 界面显示裸键
// （`timeline.channel.scrollTo.label`），而 tsc **不会报错**（键是字符串）。
// 所以要把"每个声明的键在四个语言里都存在"变成可执行事实。
//
// 判据双向：① 声明的键必须都能在对应语言包里找到；② 语言包里的通道键不能是死键
// （声明侧已删而译文还在 = 漂移，§1.3）。

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const LOCALES = ["zh-CN", "zh-TW", "en", "de"];
/** 本守卫覆盖的键形态：
 *  · `<ns>.channel.<name>.label|desc` —— `ChannelMeta.labelKey/descriptionKey`（r55）
 *  · `<ns>.command.desc`             —— `ComposerCommand.descriptionKey`（r56，斜杠弹窗的命令说明）
 *  两者同型：契约字段从"文本"改成"i18n 键"，于是**键写错/漏译会显示裸键而 tsc 不报错**。 */
const KEY_SHAPE = /^[a-z][\w-]*(?:\.channel\.[\w-]+\.(label|desc)|\.command\.desc)$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) { if (name !== "node_modules") walk(full, out); }
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

/** 源码里声明的全部通道文案键（`labelKey: "…"` / `descriptionKey: "…"`）。 */
function declaredKeys(): { key: string; file: string; line: number }[] {
  const out: { key: string; file: string; line: number }[] = [];
  for (const base of ["src/plugins", "src/web", "packages/react/src"]) {
    const root = join(ROOT, base);
    if (!existsSync(root)) continue;
    for (const f of walk(root)) {
      const rel = relative(ROOT, f);
      if (rel.includes("/locales/")) continue;
      readFileSync(f, "utf-8").split("\n").forEach((l, i) => {
        const m = /\b(?:labelKey|descriptionKey)\s*:\s*"([^"]+)"/.exec(l);
        if (m && KEY_SHAPE.test(m[1])) out.push({ key: m[1], file: rel, line: i + 1 });
      });
    }
  }
  return out;
}

/** 全部语言包里实际存在的键（loc → Set）。 */
function localeKeys(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const loc of LOCALES) {
    const set = new Set<string>();
    for (const base of ["src/plugins"]) {
      const root = join(ROOT, base);
      if (!existsSync(root)) continue;
      const stack = [root];
      while (stack.length) {
        const d = stack.pop()!;
        for (const name of readdirSync(d)) {
          const full = join(d, name);
          const st = statSync(full);
          if (st.isDirectory()) { if (name === loc) {
            for (const jf of readdirSync(full)) if (jf.endsWith(".json")) {
              const obj = JSON.parse(readFileSync(join(full, jf), "utf-8")) as Record<string, unknown>;
              for (const k of Object.keys(obj)) set.add(k);
            }
          } else if (name !== "node_modules") stack.push(full); }
        }
      }
    }
    out.set(loc, set);
  }
  return out;
}

describe("ChannelMeta 的 i18n 键：四个语言都必须有译文（不得显示裸键）", () => {
  const declared = declaredKeys();
  const packs = localeKeys();

  it("判据不空转：确实扫到了通道键，且数量与已知事实一致", () => {
    // r55 实测：8 个通道 × (label + desc) + 壳的 2 个导航通道 × 2 = 20 个键；r56 再加 1 个命令说明键
    expect(declared.length, `扫到 ${declared.length} 个键（r56 实测 21）——少了说明判据漏了某种写法`).toBeGreaterThanOrEqual(21);
    for (const loc of LOCALES) {
      expect(packs.get(loc)!.size, `${loc} 语言包一个键都没扫到 = 路径错了（判据会空转）`).toBeGreaterThan(20);
    }
  });

  it("① 每个声明的键在**四个语言**里都存在（缺一个就会有语言显示裸键）", () => {
    const missing: string[] = [];
    for (const d of declared) {
      for (const loc of LOCALES) {
        if (!packs.get(loc)!.has(d.key)) missing.push(`${d.key} 缺 ${loc}（声明于 ${d.file}:${d.line}）`);
      }
    }
    expect(missing, `缺译文 ${missing.length} 条：\n      ${missing.join("\n      ")}`).toEqual([]);
  });

  it("② 译文不能是空的，也不该等于键名本身（占位式假翻译）", () => {
    const bad: string[] = [];
    for (const d of declared) {
      for (const loc of LOCALES) {
        // 逐语言包找出该键的值
        let value: unknown;
        const root = join(ROOT, "src/plugins");
        const stack = [root];
        while (stack.length && value === undefined) {
          const dir = stack.pop()!;
          for (const name of readdirSync(dir)) {
            const full = join(dir, name);
            const st = statSync(full);
            if (st.isDirectory()) { if (name === loc) {
              for (const jf of readdirSync(full)) if (jf.endsWith(".json")) {
                const obj = JSON.parse(readFileSync(join(full, jf), "utf-8")) as Record<string, unknown>;
                if (d.key in obj) { value = obj[d.key]; break; }
              }
            } else if (name !== "node_modules") stack.push(full); }
          }
        }
        if (typeof value !== "string" || value.trim().length === 0 || value === d.key) {
          bad.push(`${d.key} @${loc} = ${JSON.stringify(value)}`);
        }
      }
    }
    expect(bad, `空/占位译文 ${bad.length} 条：\n      ${bad.slice(0, 8).join("\n      ")}`).toEqual([]);
  });

  it("③ 语言包里的通道键不能是**死键**（声明侧已删而译文还在 = 漂移）", () => {
    const declaredSet = new Set(declared.map((d) => d.key));
    const dead: string[] = [];
    for (const loc of LOCALES) {
      for (const k of packs.get(loc)!) {
        if (KEY_SHAPE.test(k) && !declaredSet.has(k)) dead.push(`${k} @${loc}`);
      }
    }
    expect(dead, `死键 ${dead.length} 条（删掉声明就要一并删译文，否则两份必然漂移）：\n      ${dead.join("\n      ")}`).toEqual([]);
  });
});
