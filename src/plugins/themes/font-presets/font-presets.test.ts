// font-presets 内置字体预设守卫(§3.7 守卫闭环 / §5.6 三级测试 level 1)。
//
// 两个回归风险:
// 1. labelKey 漏加语言包 —— 设置页字体 tab 的 t(labelKey) 缺 key 时回退渲染原始 key,
//    (如 "fontPresets.mono.seriousShanns" 直接当展示名),四语言里漏一种就得等用户切到那语言才发现。
// 2. 打包字体文件被误删 —— 字体是二进制内容,删了不报编译错,只有选了 Serious Shanns 的
//    用户才会遇到静默回退,无任何错误信号。
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const DIR = resolve(__dirname, ".");
const LOCALES = ["en", "zh-CN", "zh-TW", "de"] as const;

/** renderer/serious-shanns.css 的 @font-face 引用的字体文件清单(单 family 六 face)。 */
const FONT_FILES = [
  "SeriousShanns-Regular.otf",
  "SeriousShanns-Italic.otf",
  "SeriousShanns-Bold.otf",
  "SeriousShanns-BoldItalic.otf",
  "SeriousShanns-Light.otf",
  "SeriousShanns-LightItalic.otf",
];

function manifestFontPresets(): { id: string; labelKey: string }[] {
  const m = JSON.parse(readFileSync(join(DIR, "plugin.json"), "utf-8")) as {
    contributes?: { fontPresets?: { id?: unknown; labelKey?: unknown }[] };
  };
  return (m.contributes?.fontPresets ?? []).map((p) => ({
    id: String(p.id ?? ""),
    labelKey: String(p.labelKey ?? ""),
  }));
}

function localeKeys(locale: string): Set<string> {
  const raw = JSON.parse(readFileSync(join(DIR, "locales", locale, "fonts.json"), "utf-8")) as Record<string, unknown>;
  return new Set(Object.keys(raw));
}

describe("font-presets 内置字体预设守卫", () => {
  it("manifest 的每个 fontPresets.labelKey 在全部 4 个 locale 都有文案", () => {
    const missing: string[] = [];
    for (const p of manifestFontPresets()) {
      for (const loc of LOCALES) {
        if (!localeKeys(loc).has(p.labelKey)) missing.push(`${p.labelKey} @ ${loc}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("打包的 Serious Shanns 字体文件都存在(fonts/)", () => {
    const missing = FONT_FILES.filter((f) => !existsSync(join(DIR, "fonts", f)));
    expect(missing).toEqual([]);
  });
});
