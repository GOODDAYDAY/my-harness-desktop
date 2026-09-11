// i18n 三个"动态收集"函数的守卫 —— **纯函数 unittest**:零 mock、零 IO、零定时器。
//
// 三处**同一类的根因**(源码注释自述,均为 P3 评估项):
//   ① collectNamespaces  「此前**硬编码 8 个内置 namespace 兜底**,写死 builtin 结构知识」
//   ② collectSupportedLngs「此前**硬编码 ["zh-CN","zh-TW","en","de"]** 兜底」
//   ③ collectLocaleList  「此前**硬编码四语言固定展示名**,**第三方 locale 不进列表**」
// 三处的**共同失效形态**:清单写死 → **插件/第三方带来的新条目被静默漏掉** ✓
// (正是 CLAUDE.md 铁律一「壳不内嵌功能性内容」在 i18n 这一处的具体违反 ✗)
// 故守卫一律这样写:**喂一个不在旧硬编码集合里的条目,断言它出现** ——
// 若哪天有人把动态收集退回成写死清单,这三条会立刻红。
import { describe, it, expect } from "vitest";

import {
  collectNamespaces,
  collectSupportedLngs,
  collectLocaleList,
  type I18nResource,
  type LanguageContributionWithMeta,
} from "./merge";

const contrib = (locale: string, id: string): LanguageContributionWithMeta =>
  ({ contribution: { locale, id } } as unknown as LanguageContributionWithMeta);

describe("i18n 动态收集(守卫:硬编码清单回退即红)", () => {
  it("① collectNamespaces:收全 resources 里的 namespace —— 含**非内置**的", () => {
    const resources: I18nResource = {
      "zh-CN": { common: { a: "x" }, settings: { b: "y" } },
      en: { common: { a: "x" }, "my-plugin": { c: "z" } },
    };
    const ns = collectNamespaces(resources);
    expect(ns, "内置 namespace 漏了").toContain("common");
    expect(ns, "另一个语言里的 namespace 漏了(应跨语言合并)").toContain("settings");
    expect(ns, "**第三方插件的 namespace 被漏掉** —— 说明清单又写死了").toContain("my-plugin");
  });

  it("①b 同一 namespace 跨语言只出现一次(去重)", () => {
    const ns = collectNamespaces({ en: { common: {} }, de: { common: {} } });
    expect(ns.filter((n) => n === "common").length).toBe(1);
  });

  it("② collectSupportedLngs:收全贡献项的 locale —— 含**四语言之外**的", () => {
    const langs = collectSupportedLngs([contrib("zh-CN", "a"), contrib("ja-JP", "b"), contrib("zh-CN", "c")]);
    expect(langs, "内置语言漏了").toContain("zh-CN");
    expect(langs, "**四语言之外的 locale 被漏掉** —— 说明又写死了兜底清单").toContain("ja-JP");
    expect(langs.length, "同一 locale 出现多次(未去重)").toBe(2);
  });

  it("③ collectLocaleList:**第三方 locale 也进列表**(此前不进)", () => {
    const list = collectLocaleList(["zh-CN", "ja-JP"], {});
    expect(list.map((l) => l.id), "第三代 locale 没有进语言列表").toEqual(["zh-CN", "ja-JP"]);
  });

  it("③b 展示名取自 resources.common.locale.<code>;**缺失则回退 locale code 本身**", () => {
    // ⚠ 实测细节(不是猜):展示名从 **`resources[id]`** 里取 —— 即**目标 locale 自己那片** resources
    //   的 `common.locale.<自己>`;不是从"当前界面语言"那片取。
    //   (源码注释写的是"各语言用自己表达**其它**语言名",而实现取的是"自己表达**自己**"——
    //    这处措辞与行为的细微不一致我**无法只凭本文件断定哪个是本意**(调用方的意图在这里看不到),
    //    故只把**实测行为**钉住,不把它当缺陷断言。)
    const resources: I18nResource = {
      en: { common: { locale: { en: "English" } } },
      "ja-JP": { common: { locale: { "ja-JP": "日本語" } } },
    };
    const list = collectLocaleList(["en", "ja-JP"], resources);
    expect(list, "有译文时没有用译文").toEqual([
      { id: "en", name: "English" },
      { id: "ja-JP", name: "日本語" },
    ]);
    // 没有任何 resources 时:名称回退成 code 本身(不是回退到写死的展示名)
    expect(collectLocaleList(["xx-XX"], [] as unknown as I18nResource)).toEqual([{ id: "xx-XX", name: "xx-XX" }]);
  });

  it("③c 展示名不是字符串(嵌套对象)时回退 locale code,不产出 [object Object]", () => {
    const resources = { xx: { common: { locale: { xx: { nested: "v" } } } } } as unknown as I18nResource;
    expect(collectLocaleList(["xx"], resources)[0].name).toBe("xx");
  });
});
