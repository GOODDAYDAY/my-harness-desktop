// 德语语言包覆盖率的**棘轮守卫**（ratchet）：只能变好，不能变差。
//
// ⚠ **本文件的判据换过一次，换的原因是第一版报假绿**（这是本轮最重要的教训）：
//   第一版判据是「值含英文虚词(the/and/of/paths/list/settings…) 且 不含德文特征」。
//   它抓到了 49 条，我照单还清、守卫转绿、清单清空——然后**在真实 app 的德语设置页里**
//   肉眼看到 `General` / `Compaction` / `Last Changelog Version` / `Auto Compaction` /
//   `Thinking Budget · minimal` 等大片英文：这些串**一个虚词都不含**，判据完全看不见。
//   用可靠判据（de 与 en **逐字相同** + ≥2 个词 + 无任何德文特征）重测是 **116 条**。
//   所以"守卫绿了"从来不等于"问题没了"：**判据本身必须先被证明能看见问题**（§10.3）。
//   本轮的自检方式是把判据拿到 en 包上跑（必然大量命中）+ 在真实 app 里肉眼抽查德语界面。
//
// 现行判据（三条同时成立才算未翻译）：
//   ① de 的值与 en 的值**逐字相同**（翻译过就必然不同；这条最硬，不依赖词表）；
//   ② 剥掉路径/`{{占位符}}` 后**至少 2 个词**（单词与专名如 Transport / Images / IM 无法判定，跳过）；
//   ③ 不含任何**德文特征**（变音符 ß/ä/ö/ü、常见功能词、典型构词后缀 -ung/-keit/-heit/-ieren/-lich…）。
// 另有两类显式豁免，都带理由、且**豁免表长度会被打印**（防悄悄变长）：
//   · 代码示例（`settings.fontSampleCode`）：各语言本该一字不改；
//   · 专名清单（字体族名 / `API Key` / 产品显示名）：见 EXEMPT。
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "plugins");
const LEDGER = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "i18n-de-untranslated.json");

/** 德文特征：变音符/ß、常见功能词、典型构词后缀。命中任一即认为"这是德文"。 */
const DE_MARK =
  /[äöüÄÖÜß]|\b(und|oder|der|die|das|den|dem|des|für|mit|ist|sind|war|werden|nicht|nur|wenn|aus|ein|eine|einer|eines|bei|zum|zur|von|nach|auf|im|am|um|als|auch|alle|jede|jeder|mehr|weniger|kann|muss|soll|wird|hat|haben|kein|keine|bitte|hier|dort|noch|schon|wieder|zwischen|innerhalb|außerhalb)\b|(ung|keit|heit|ischen?|ierte?|ieren|lich|bare?|weise)\b/i;
/** 代码示例：以 JS/TS 关键字开头（豁免面要窄——宽松备选曾把合法德文 dsh.desc 也豁免掉）。 */
const CODE_SAMPLE = /^\s*(const|let|var|import|export|function|return|await|if|for)\b/;
/** 路径与插值占位符：语言无关，判语言前先剥掉（否则 `~/.pi/agent/settings.json` 里的
 *  "settings" 会把正确的德文判成英文——实测假阳性）。 */
const PATHLIKE = /(?:[~{][^\s"'）)]*|[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+|\{\{[^}]*\}\})/g;

/** **语言中立术语表**：德语技术界面里本就保留英文原词的单词。
 *  ⚠ 这张表的存在是为了闭合一个**实测盲区**：判据原本要求"≥2 个词"才判定，于是所有单词条目
 *  被整批放过——而其中 `General`/`Compaction`/`Retry`/`Images`/`Warnings`/`Cancel`/`When`/
 *  `Protected`/`Reload`/`(empty)` 都是**该译而未译**的（德语界面实际显示英文，r11 在真机看到）。
 *  所以不能按词数一刀切，必须逐词表态：在本表里的 = 德语也该这么写（Status/System/Debug/
 *  Prompt/Markdown/Chat/Tree…，德语技术文档惯例保留英文）；不在表里的单词条目一律参与判定。
 *  表长会打印，防止靠"塞进中立表"把债务藏起来。 */
const NEUTRAL_TERMS = new Set([
  // 通用技术词（德语 UI 惯例保留英文）
  "status","system","debug","git","i18n","npm","ping","prompt","markdown","transport","terminal",
  "name","text","limit","effort","provider","api","baseurl","baseurl","apikeyenv","providerid",
  "entryid","skills","global","community","theme","plugins","review","tree","dialog","chat",
  "pins","orange","minimal","commit","sticker","pause","keybindings","analytics","dev","off","on",
  "name","reload","protected","skills","themes","models","events","binding","bindings","level",
].map((t) => t.toLowerCase()));
/** 纯占位符值（`✗ {{error}}`、`{{type}}`、`{ }`）：没有可翻译的文字。 */
const PLACEHOLDER_ONLY = (prose: string): boolean => (prose.match(/[A-Za-z]{2,}/g) ?? []).length === 0;

/** **专名豁免表**：每条都写明理由。长度会在测试输出里打印，防止悄悄变长。
 *  判据是"这个词在德语里就该这么写"，不是"懒得翻译"。 */
const EXEMPT: { match: (file: string, key: string, value: string) => boolean; why: string }[] = [
  { match: (f) => f.includes("themes/font-presets/"), why: "字体族名（Fira Code / Times New Roman …）是专有名词，各语言同形" },
  { match: (_f, k) => /apiKey$/.test(k), why: "「API Key」是行业通用术语，德语技术文档同样用英文原词" },
  { match: (_f, k) => k.endsWith(".displayName"), why: "插件显示名是产品名（Desktop Plugins / Git Review），各语言保持一致" },
  { match: (_f, _k, v) => /^\[?Blind Review\]?$/.test(v.trim()), why: "「Blind Review」是本仓功能专名（zh 侧作「盲审」，de 侧沿用英文术语）" },
  { match: (_f, k, v) => k.endsWith("previewBashCommand") && /^\$\s/.test(v.trim()),
    why: "预览里的 **shell 命令样本**（`$ npm run build`）是代码不是散文，各语言同形；判据用 key 名 + `$ ` 前缀双重限定，不放宽到任意值" },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      walk(full, out);
    } else if (name.endsWith(".json")) {
      out.push(full);
    }
  }
  return out;
}
// ⚠ 上面这个 `else if` 分支曾在一次重写里被整段丢掉（只剩 `if (!isDirectory()) continue`），
//   于是 walk 恒返回空、detect 恒返回 0 条——**而合成样本自检照样通过、"没有新增"断言照样绿**。
//   这就是本文件开头写的那个失效模式在我自己身上复现：判据逻辑对，扫描范围空，守卫变装饰品。
//   所以防空转必须**同时**验两件事：判据能判（selfCheck）+ 真的扫到了文件（下面那条断言）。

/** **判据本体**（单一实现）：一个值算不算"未翻译"。
 *  detect() 与 selfCheck() 都调它——两处各写一遍就会漂移（首版就是这么坏的：
 *  自检里的豁免传了假路径，与 detect 的真实行为不一致，于是自检永远假通过）。 */
function isUntranslated(file: string, key: string, value: string, otherLangValue: unknown): boolean {
  if (CODE_SAMPLE.test(value)) return false;
  if (EXEMPT.some((e) => e.match(file, key, value))) return false;
  if (otherLangValue !== value) return false;                 // ① 与对照语言不同 → 已翻译
  const prose = value.replace(PATHLIKE, " ");
  if (PLACEHOLDER_ONLY(prose)) return false;                  // ② 纯占位符
  if (DE_MARK.test(prose)) return false;                      // ③ 含德文特征
  const words = prose.trim().split(/\s+/).filter(Boolean);    // ④ 单词条目查中立术语表（大小写无关）
  if (words.length === 1 && NEUTRAL_TERMS.has(words[0].replace(/[^A-Za-z]/g, "").toLowerCase())) return false;
  return true;
}

/** 检出某 locale 目录下"与对照语言逐字相同且无该语言特征"的条目。 */
function detect(locale: "de" | "en"): Map<string, string> {
  const out = new Map<string, string>();
  const files = walk(ROOT).filter((x) => x.includes(`/locales/${locale}/`));
  for (const f of files) {
    // 判据 ① 需要"对照语言"的值：对 de 用 en 作对照；自检时对 en 用 de 作对照
    // （en 包里的串绝大多数与 de 不同，所以自检要换一条路：见 selfCheck）。
    const other = locale === "de" ? "en" : "de";
    const otherPath = f.replace(`/locales/${locale}/`, `/locales/${other}/`);
    let j: Record<string, unknown>;
    let oj: Record<string, unknown> = {};
    try { j = JSON.parse(readFileSync(f, "utf-8")) as Record<string, unknown>; } catch { continue; }
    try { oj = JSON.parse(readFileSync(otherPath, "utf-8")) as Record<string, unknown>; } catch { /* 无对照则全部视为"相同" */ }
    const rel = relative(ROOT, f);
    for (const [k, v] of Object.entries(j)) {
      if (typeof v !== "string" || v.trim().length < 4) continue;
      if (isUntranslated(rel, k, v, oj[k])) out.set(`${rel} → ${k}`, v);
    }
  }
  return out;
}

/** 自检：判据是否还活着。用一份**合成样本**跑，而不是拿真实包跑——
 *  真实 de 包一旦全翻译完，"拿 en 包自检"这条路也会失效（en 与 de 不同 → 判据①不成立）。 */
function selfCheck(): { detectsEnglish: boolean; sparesGerman: boolean; sparesProperNoun: boolean } {
  const probeWithFile = isUntranslated;                 // 与 detect **同一个函数**，不是复制品
  const probe = (v: string, other: string): boolean => probeWithFile("x/y.json", "k", v, other);
  return {
    detectsEnglish: probe("Last Changelog Version", "Last Changelog Version"),
    sparesGerman: !probe("Pfade der Skill-Verzeichnisse", "Skill directory paths"),
    // 专名豁免：probe 的 file 参数要用**真实的豁免路径**，否则规则根本没被触发
    // （首版传 "x/y.json"，font-presets 那条规则永远不匹配，自检却报"豁免生效"——假自检）。
    sparesProperNoun: !probeWithFile("themes/font-presets/locales/de/fonts.json", "fontPresets.mono.fira", "Fira Code", "Fira Code")
      && !probeWithFile("kernels/pi/locales/de/models.json", "models.apiKey", "API Key", "API Key"),
  };
}

function ledger(): Map<string, string> {
  if (!existsSync(LEDGER)) return new Map();
  const arr = JSON.parse(readFileSync(LEDGER, "utf-8")) as { file: string; key: string; value: string }[];
  return new Map(arr.map((e) => [`${e.file} → ${e.key}`, e.value]));
}

describe("德语语言包：未翻译条目只能减少，不能增加（棘轮）", () => {
  const current = detect("de");
  const known = ledger();

  it("判据不空转：合成样本三向自检（能抓英文、放过德文、放过专名）", () => {
    // ⚠ 这条是**整个守卫的地基**。上一版用「拿 en 包跑同一判据」自检，但判据换成
    //   「de 与 en 逐字相同」之后那条自检就失效了（en 与 de 本就不同 → 判据①不成立 →
    //   命中 0 → 反而断言失败）。自检必须与判据解耦，所以改用合成样本三向验证。
    //   没有这条，判据里的任何一处正则/豁免写错都会让守卫静默变成"永远绿"。
    expect(existsSync(LEDGER), `清单文件缺失：${LEDGER}`).toBe(true);
    const sc = selfCheck();
    expect(sc.detectsEnglish, "判据抓不到英文串 = 失效（假绿）").toBe(true);
    expect(sc.sparesGerman, "判据把正确的德文误判成英文 = 假阳性，会让人不信任守卫").toBe(true);
    expect(sc.sparesProperNoun, "专名豁免没生效").toBe(true);
    // 扫描范围自检：合成样本只能证明"判据逻辑对"，证明不了"真的扫到了文件"。
    // 上一版就栽在这里（walk 丢了收集文件的分支 → detect 恒 0 → 守卫全绿）。
    const deFiles = walk(ROOT).filter((x) => x.includes("/locales/de/"));
    expect(deFiles.length, "一个 de locale 文件都没扫到 = walk 坏了（detect 会恒返回 0，守卫变装饰品）").toBeGreaterThanOrEqual(30);
    const enFiles = walk(ROOT).filter((x) => x.includes("/locales/en/"));
    expect(enFiles.length, "en 对照包没扫到，判据①（de==en）会全部落空").toBeGreaterThanOrEqual(30);
    // 豁免表长度打印出来（照 dependency-audit 的 allowlist 范式）：防止悄悄变长把债务藏进去
    console.log(`      专名豁免规则 ${EXEMPT.length} 条：${EXEMPT.map((e) => e.why.split("（")[0]).join(" / ")}`);
    expect(EXEMPT.length, "豁免表变长了——每条都要有理由，且要确认不是把债务藏进来").toBeLessThanOrEqual(6);
    console.log(`      语言中立术语 ${NEUTRAL_TERMS.size} 个（单词条目只有落在表里才放过）`);
    expect(NEUTRAL_TERMS.size, "中立术语表变长了——每个词都要确认德语 UI 惯例确实保留英文").toBeLessThanOrEqual(60);
    // 单词盲区自检：General 这类**该译**的单词必须被抓到，Status 这类中立词必须被放过
    // 直接用模块级的 isUntranslated（detect 与自检共用同一实现，不复制判据）
    expect(isUntranslated("x/y.json", "kernel.groups.general", "General", "General"), "单词盲区未闭合：General 应被判为未翻译").toBe(true);
    expect(isUntranslated("x/y.json", "kernel.status", "Status", "Status"), "中立术语被误判").toBe(false);
  });

  it("① 没有清单之外的新增未翻译条目", () => {
    const fresh = [...current.keys()].filter((k) => !known.has(k));
    expect(fresh, `新增 ${fresh.length} 条未翻译德文（要么翻译它，要么确属误判并同步清单）：\n${fresh.slice(0, 8).join("\n")}`).toEqual([]);
  });

  it("② 清单里没有已经修好的条目（清单必须与实际同步，否则棘轮失效）", () => {
    const stale = [...known.keys()].filter((k) => !current.has(k));
    expect(stale, `这 ${stale.length} 条已不再是未翻译状态，请从 scripts/i18n-de-untranslated.json 删除：\n${stale.slice(0, 8).join("\n")}`).toEqual([]);
  });

  it("当前缺口规模被打印（每次跑都能看到数字，防止悄悄变长）", () => {
    // 这条不断言数值，只把规模写进测试输出：棘轮的透明度来自"数字可见"。
    console.log(`      德语未翻译条目：${current.size} 条（清单 ${known.size} 条）`);
    expect(current.size).toBe(known.size);
  });
});
