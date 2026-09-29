// 契约常量的**跨产物对账**（r254；消化发布面零测试引用清单里的两个常量）。
//
// ## 为什么这两个常量值得测（它们看起来只是字面量）
//
// 两个常量的文档注释各自**承认了一处漂移风险**：
//
// ① `GENERAL_CONFIG_PATH`（packages/shared/src/contract/paths.ts:1-5）：
//    "契约单源：general-config 插件拥有此文件，其余消费方统一引用此常量……
//     **manifest 的 configFile 字段是 JSON 声明，无法 import，仍保留同值字面量——改路径时两处同步**"。
//    ⇒ "靠人记得同步"就是漂移的邀请函（§1.3 契约单源的反面）。这里把它变成断言。
//
// ② `RECOMMENDED_PLUGIN_TAGS`（packages/shared/src/domain/contributions.ts:634-639）：
//    "标识符非用户可见文案（**文案走 i18n pluginManager.tag\\* key**）"。
//    ⇒ 词表里每加一个 tag，就必须有对应的 `pluginManager.tag.<tag>` 键，
//      否则管理页的 chip 会渲染成**裸键名**（r228/r229 那一类缺陷：缺键时 i18next 把键当译文返回）。
//      这类缺陷 tsc 查不到（键是拼出来的）、vitest 也查不到（要读四份语言包）⇒ 只能靠对账守卫。
//
// ⚠ 这是**跨产物**守卫（TS 常量 ⇄ plugin.json ⇄ 四份 locale JSON），所以放在 src/ 下
//   （与 dynamic-prefix-i18n-keys / i18n-dead-keys 同类），不放 packages/shared（圆心零依赖，
//   不该为了测试去读外层文件——§1.1 依赖只向内）。

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { GENERAL_CONFIG_PATH } from "@my-harness-desktop/shared";
import { RECOMMENDED_PLUGIN_TAGS } from "@my-harness-desktop/shared";

const LOCALES = ["zh-CN", "zh-TW", "en", "de"] as const;

describe("① GENERAL_CONFIG_PATH ⇄ general-config 插件 manifest 的 configFile", () => {
  const manifestPath = join(__dirname, "plugins/system/general-config/plugin.json");

  it("manifest 存在且 configFile 与常量**逐字相同**（注释说的'两处同步'由断言看着）", () => {
    expect(existsSync(manifestPath), `找不到 manifest：${manifestPath}`).toBe(true);
    const raw = readFileSync(manifestPath, "utf8");
    const manifest = JSON.parse(raw) as Record<string, unknown>;
    // configFile 在 contributions.settings（或同类块）里，逐层找而不猜层级
    const found: string[] = [];
    const walk = (v: unknown): void => {
      if (!v || typeof v !== "object") return;
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (k === "configFile" && typeof x === "string") found.push(x);
        else walk(x);
      }
    };
    walk(manifest);
    expect(found.length, "manifest 里应恰有一处 configFile").toBe(1);
    expect(found[0], "改路径时两处必须同步（TS 常量与 JSON 声明）").toBe(GENERAL_CONFIG_PATH);
  });
});

describe("② RECOMMENDED_PLUGIN_TAGS ⇄ pluginManager.tag.<tag> 四语言键", () => {
  it("词表非空、无重复、全是小写 ascii 标识符（它是标识符不是文案）", () => {
    expect(RECOMMENDED_PLUGIN_TAGS.length).toBeGreaterThan(0);
    const arr = [...RECOMMENDED_PLUGIN_TAGS];
    expect(new Set(arr).size, "tag 不该重复（重复会让 chip 排序出现两个同名项）").toBe(arr.length);
    for (const t of arr) expect(/^[a-z][a-z0-9]*$/.test(t), `tag 应是小写标识符（实际 ${t}）`).toBe(true);
  });

  it("每个 tag 在**四个语言**里都有 pluginManager.tag.<tag>（缺键 ⇒ chip 渲染成裸键名）", () => {
    const missing: string[] = [];
    for (const loc of LOCALES) {
      const p = join(__dirname, `plugins/manager/plugin-manager/locales/${loc}/pluginManager.json`);
      expect(existsSync(p), `缺语言包：${p}`).toBe(true);
      const dict = JSON.parse(readFileSync(p, "utf8")) as Record<string, string>;
      for (const tag of RECOMMENDED_PLUGIN_TAGS) {
        const key = `pluginManager.tag.${tag}`;
        const v = dict[key];
        if (typeof v !== "string" || v.trim().length === 0) missing.push(`${loc}/${key}`);
      }
    }
    expect(missing, `推荐 tag 词表与 i18n 键不对账（缺键会渲染成裸键名）：\n  ${missing.join("\n  ")}`).toEqual([]);
  });

  it("反向：语言包里的 pluginManager.tag.* 不该有词表外的**孤儿键**（有则是死键或词表漏收）", () => {
    const known = new Set<string>([...RECOMMENDED_PLUGIN_TAGS].map((t) => `pluginManager.tag.${t}`));
    const orphans: string[] = [];
    for (const loc of LOCALES) {
      const p = join(__dirname, `plugins/manager/plugin-manager/locales/${loc}/pluginManager.json`);
      const dict = JSON.parse(readFileSync(p, "utf8")) as Record<string, string>;
      for (const k of Object.keys(dict)) {
        if (k.startsWith("pluginManager.tag.") && !known.has(k)) orphans.push(`${loc}/${k}`);
      }
    }
    // 说明：这条是**信息性对账**——manifest 可自由追加词表外 tag（注释：推荐而非强制），
    // 所以孤儿键也可能是"某插件用了新 tag、管理页为它补了文案、但没进推荐词表"。
    // 那种情况是合法的，因此这里只断言"孤儿键要么为 0，要么每个都能在内置插件 manifest 的 tags 里找到"。
    const tagged = new Set<string>();
    const walkManifests = (dir: string): void => {
      // 只扫内置插件（第三方插件不在仓里，无法对账）
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) walkManifests(full);
        else if (e.name === "plugin.json") {
          const m = JSON.parse(readFileSync(full, "utf8")) as Record<string, unknown>;
          const collect = (v: unknown): void => {
            if (!v || typeof v !== "object") return;
            for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
              if (k === "tags" && Array.isArray(x)) for (const t of x) if (typeof t === "string") tagged.add(t);
              else collect(x);
            }
          };
          collect(m);
        }
      }
    };
    walkManifests(join(__dirname, "plugins"));
    const unexplained = orphans.filter((o) => {
      const tag = o.split("pluginManager.tag.")[1];
      return !tagged.has(tag);
    });
    expect(unexplained,
      `这些 tag 文案既不在推荐词表、也没有任何内置插件 manifest 用它（死键或词表漏收）：\n  ${unexplained.join("\n  ")}`).toEqual([]);
  });
});
