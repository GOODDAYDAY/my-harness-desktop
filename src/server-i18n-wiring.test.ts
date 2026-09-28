// 服务端 i18n 单例必须在启动时接线（r78）。
//
// ## 被守的缺陷：机制齐全但没人启动
//
// `src/server/application/i18n/translator.ts` 按 docs/plugins/05-plugin-i18n §6.2
// 「main 端持单例(init 一次)」实现了 `initTranslator` / `t` / `changeLocale` / `currentLocale`，
// 但 **`initTranslator` 此前零调用点** ⇒ 单例从未初始化 ⇒ `t()` 恒走
// `if (!initialized) return key` 的退化路径。后果：服务端所有面向用户的错误消息
// 只能写死中文，于是**英文界面里冒出中文句子**（i18n 泄漏），而且这个退化是静默的
// （返回键名/写死文案都不报错）。
//
// 这与 r72 删掉的死契约成员同类、方向相反：那次是"契约有面没人调"，
// 这次是"机制齐全没人启动"。两者的共同点是**编译期与运行期都不报错**。
//
// r78 已在 `bootstrap/boot/steps/50-wiring.ts` 接线（用 prefs 里的 currentLocale），
// 并把两条**面向用户**的缺面错误（含"在设置页重载内核插件后重试"这类操作指引）
// 迁移到 `t("shell.kernelFaceMissing" / "shell.kernelExtensionFaceMissing")`。
// 真机验证：en 界面下该错误返回英文、中文字符 0、无裸键；zh-CN 下照常中文。
//
// ## 为什么不把 153 处服务端中文错误全迁
//
// 实测 src/server 里 `throw new Error(含中文)` 共 **153 处 / 21 个目录**，
// 但绝大多数是**开发者可见的不变量**（启动顺序、插件注册、路径越界、"已在运行"），
// 按 r42 的定性它们该留中文（进日志与开发控制台，不是 UI 文案）。
// 判据是 r56 立的那条：**这段文本会不会作为用户可见内容出现？**
// 会（含操作指引、会经 IPC 浮到 toast/对话框）⇒ 走 t()；不会 ⇒ 留中文。
// 所以本条守卫守的是"接线不能断"+"已迁移的不能退回"，不是"全部迁完"。

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const WIRING = "src/server/bootstrap/boot/steps/50-wiring.ts";
const TRANSLATOR = "src/server/application/i18n/translator.ts";
const MIGRATED: { file: string; key: string }[] = [
  { file: "src/server/controllers/kernel.ts", key: "shell.kernelFaceMissing" },
  { file: "src/server/controllers/extensions.ts", key: "shell.kernelExtensionFaceMissing" },
];
const LOCALES = ["zh-CN", "zh-TW", "en", "de"];

describe("服务端 i18n：单例必须在启动时接线，且已迁移的消息不得退回写死文案", () => {
  it("判据不空转：translator 与 wiring 两个文件都在", () => {
    for (const f of [TRANSLATOR, WIRING, ...MIGRATED.map((m) => m.file)]) {
      expect(existsSync(join(ROOT, f)), `${f} 不存在（路径变了？改这份清单）`).toBe(true);
    }
  });

  it("① 启动装配里必须调用 initTranslator（否则 t() 静默退化成返回键名）", () => {
    const src = readFileSync(join(ROOT, WIRING), "utf-8");
    expect(src.includes("initTranslator("), [
      "50-wiring 里没有 initTranslator 调用 ⇒ 服务端 i18n 单例未初始化。",
      "      后果：所有走 t() 的服务端消息**静默**退化成返回键名（`if (!initialized) return key`），",
      "            界面上会出现 shell.kernelFaceMissing 这种字符串，而且不报错。",
      "      修法：在拿到 i18nResources 之后调用 initTranslator({ resources, lng: prefsStore.get(\"currentLocale\") || DEFAULT_LOCALE, ns, supportedLngs })。",
    ].join("\n")).toBe(true);
    // 接线必须用**真实语言资源**与**当前 locale**，不能喂空对象/写死 locale
    expect(/initTranslator\(\{[\s\S]{0,300}resources:\s*i18nResources/.test(src), "initTranslator 必须喂 mergeLanguageContributions 产出的 i18nResources").toBe(true);
    expect(/initTranslator\(\{[\s\S]{0,400}lng:[\s\S]{0,80}currentLocale/.test(src), "initTranslator 的 lng 必须来自 prefs 的 currentLocale（写死 locale 会让界面语言与错误语言不一致）").toBe(true);
  });

  it("② 已迁移的消息必须走 t()，不得写回中文字面量", () => {
    const back: string[] = [];
    for (const m of MIGRATED) {
      const src = readFileSync(join(ROOT, m.file), "utf-8");
      if (!src.includes(`t("${m.key}"`)) back.push(`${m.file} 不再用 t("${m.key}")`);
      if (/throw new Error\(`内核/.test(src)) back.push(`${m.file} 又写回了硬编码中文的 throw`);
      if (!src.includes('from "../application/i18n/translator"')) back.push(`${m.file} 少了 translator 的 import`);
    }
    expect(back, `r78 的迁移被回退：\n      ${back.join("\n      ")}`).toEqual([]);
  });

  it("③ 迁移用的键在四个语言里都存在且非空（缺一个就会有语言显示裸键）", () => {
    const missing: string[] = [];
    for (const m of MIGRATED) {
      for (const loc of LOCALES) {
        const f = join(ROOT, `src/plugins/system/i18n/locales/${loc}/shell.json`);
        const obj = JSON.parse(readFileSync(f, "utf-8")) as Record<string, string>;
        const v = obj[m.key];
        if (typeof v !== "string" || v.trim() === "") missing.push(`${m.key} 缺 ${loc}`);
      }
    }
    expect(missing, `迁移键缺译文：${missing.join(", ")}`).toEqual([]);
  });
});
