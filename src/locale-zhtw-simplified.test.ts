// zh-TW 语言包「简体残留」守卫。
//
// 实测缺陷（scripts/demo/dom-audit.e2e.mjs 引出的排查）：三个 zh-TW 语言文件里有 **212 条**
// 其实是**简体原文照抄**——例如 `dsh.fetchFailed` 的 zh-TW 值是「加载失败」（应为「加載失敗」）、
// `keybindings.resetDefaults` 是「恢复默认」（应为「恢復默認」）、pi 的 102 条字段标签/描述 likewise。
// 繁体用户看到的是简体字：功能不报错、页面不崩，只是**语言不对**——典型的静默质量缺陷，
// 正向功能剧本永远抓不到。
//
// 判据（两个条件同时成立才判违规，避免误伤合法的简繁同形串）：
//   ① zh-TW 的值与 zh-CN 的值**完全相同**；且
//   ② 该值含有**简体专用字**（繁体写法必然不同的字）。
// 只满足 ① 不算：像「清除」「取消」「最新」「Fira Code」「Prompt」这类简繁同形/纯 ASCII 的串，
// 两边本来就该一样（实测全仓这类合法相同条目 249 条）。只满足 ② 也不算：那说明译者已经改写过。
//
// 例外：`common.locale.*` 是**语言内名**（每种语言用自身文字显示，语言选择器的通行惯例），
// zh-TW 里 `common.locale.zh-CN` 就应当是「简体中文」。故显式排除。
//
// ⚠ 检测字集**由本次修复实际使用的简繁映射表派生**（每个字都有对应的繁体写法，已逐个验证），
//   不是手抄的大列表。首版手抄时混进了「形」这类**简繁同形**字，于是把合法译文
//   `npm 命令 argv 形式` 判成违规——假阳性会让守卫失去信任、进而被绕过，比漏报更糟。
//   依语境而定的字（里/复/并/签/台）保留在集合里，但只在「与简体完全相同」这个前置条件下才判违规，
//   所以「公里」「皇后」这类合法繁体用法不会被误伤（它们的 zh-TW 值本就与 zh-CN 相同时才触发，
//   而那种情况下确实该转成「公里/皇后」的繁体同形——即无需改动，故这类字实际只在真未翻译时命中）。
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "plugins");

/** 简体专用字（繁体写法必然不同）。来源：本次修复实际用到的简繁映射表的键集。 */
const SIMP_ONLY = new Set([
  "与","两","个","为","义","从","会","传","体","储","关","内","写","减",
  "击","删","别","动","单","压","参","双","发","变","叠","台","后","启",
  "响","图","块","声","复","实","宽","对","导","将","带","并","应","开",
  "强","当","录","径","态","总","户","执","护","拦","择","换","据","数",
  "无","旧","时","显","机","条","来","极","标","树","档","检","没","测",
  "浏","滚","滤","点","状","码","础","确","种","签","简","级","纯","组",
  "终","绑","绘","给","续","维","缀","缓","编","缩","节","荐","补","装",
  "见","览","触","认","许","设","识","词","试","话","询","该","请","败",
  "资","踪","转","载","辑","输","过","还","这","进","连","迟","选","里",
  "键","问","闲","队","隐","静","项","预","题","额",
]);

/** 例外：语言内名（每种语言用自身文字显示）。 */
const EXEMPT = (k: string): boolean => k.startsWith("common.locale.");

function findLocaleDirs(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (!statSync(full).isDirectory()) continue;
    if (name === "locales") { out.push(full); continue; }
    if (name === "node_modules" || name.startsWith(".")) continue;
    findLocaleDirs(full, out);
  }
  return out;
}

const readJson = (p: string): Record<string, unknown> | null => {
  try { return JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>; } catch { return null; }
};

describe("zh-TW 语言包不得残留简体（简繁混排是静默质量缺陷）", () => {
  const dirs = findLocaleDirs(ROOT).filter((d) =>
    existsSync(join(d, "zh-CN")) && existsSync(join(d, "zh-TW")));

  it("判据不空转：确实扫到了同时有 zh-CN 与 zh-TW 的插件", () => {
    expect(dirs.length, "一个都没扫到 = 路径推导错了（假绿）").toBeGreaterThanOrEqual(20);
  });

  it("没有「与简体完全相同 且 含简体专用字」的条目", () => {
    const problems: string[] = [];
    for (const d of dirs) {
      for (const fn of readdirSync(join(d, "zh-CN")).filter((f) => f.endsWith(".json"))) {
        const cn = readJson(join(d, "zh-CN", fn));
        const tw = readJson(join(d, "zh-TW", fn));
        if (!cn || !tw) continue;
        for (const [k, v] of Object.entries(tw)) {
          if (typeof v !== "string" || EXEMPT(k)) continue;
          if (cn[k] !== v) continue;                       // 条件①：与简体完全相同
          const hits = [...new Set([...v].filter((c) => SIMP_ONLY.has(c)))];
          if (hits.length === 0) continue;                 // 条件②：含简体专用字
          problems.push(`${relative(ROOT, join(d, "zh-TW", fn))} → ${k} = 「${v.slice(0, 40)}」 [${hits.join("")}]`);
        }
      }
    }
    expect(problems, `${problems.length} 条 zh-TW 是简体原文照抄：\n${problems.slice(0, 12).join("\n")}`).toEqual([]);
  });

  it("语言内名（common.locale.*）保持各自文字，不被本守卫误伤、也不该被翻译", () => {
    // zh-TW 里 common.locale.zh-CN 就应当是「简体中文」——这是语言选择器的通行惯例
    // （每种语言用自身文字显示自己的名字），不是漏翻译。
    const p = join(ROOT, "system/i18n/locales/zh-TW/common.json");
    const j = readJson(p);
    expect(j, "system/i18n 的 zh-TW common.json 应存在").toBeTruthy();
    expect(j!["common.locale.zh-CN"]).toBe("简体中文");
    expect(j!["common.locale.zh-TW"]).toBe("繁體中文");
  });
});
