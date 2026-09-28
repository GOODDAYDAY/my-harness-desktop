// i18n 反方向：语言包里的**死键**普查（棘轮 + 账本，r105）。
//
// ## 为什么这条方向比正方向难
//
// 正方向（r77 的 code-i18n-keys）是"代码用了哪些键 → 语言包里有没有"，
// 漏报的代价是运行时显示裸键（可见、可发现）。
// 反方向是"语言包里有哪些键 → 代码用没用"，**误报的代价是删掉还在用的文案**（不可见、难回滚）。
// 所以判据必须先把**所有消费机制**建模，剩下的才可能是死键。
//
// ## 建模的六类消费方（少一类就会批量误报）
//
// ① 静态 `t("key")` / `i18next.t("key")`
// ② 模板前缀族：`t(\`debug.density.${d}\`)` ⇒ 前缀 `debug.density.` 下的键全算已用
// ③ **完全动态**键：`t(\`${i18nPrefix}.${suffix}\`)` —— 前缀是运行时变量，
//    所以去调用方收集 `i18nPrefix="…"` 的字面量，得到若干族（实测 dsh./dshModels./kernel./models.）
// ④ manifest 的 `*Key` 字段（titleKey/descKey/labelKey…）——键当**数据**传，不出现在 t() 里
// ⑤ 派生键前缀：`settings.<id>.` / `sidePanel.<id>.` / `plugin.<id>.`
//    （r63 查明：这些键由消费方用 `defaultValue` 拼出来，语言包里可以没有，但**有就算已用**）
// ⑦ **键作为变量/常量传递**（r106 补）：`const failKey = "ext.toggleFailed"` 然后 `t(failKey, …)`，
//    或 `runGuarded(t, op, "ext.restartFailed")`。键以字面量出现在代码里但不在 `t(` 紧邻位置，
//    所以 ① 抓不到。实测这一类不小——r86 自己加的两个键就被首版误判成死键。
//    收集方式：语料里所有"含点"的字符串字面量（**精确值**，不做前缀匹配，
//    否则又会退化成"匹配一切"，见 r104 的空前缀教训）。
// ⑧ **manifest 里任何含点的字符串值**（r107 补）：如主题贡献的 `name: "theme.dark"`，
//    由 `t(opt.name, { defaultValue })` 在运行时查——键当数据传、字段名不带 Key 后缀。
//    ⚠ 语言包有两种键形态（带 ns 前缀 / 裸键），所以完整值与 ns 剥离尾键都要登记。
// ⑥ **结构性遍历 resources**（不经 t()）：实测全仓只有一处——
//    `src/server/application/i18n/merge.ts` 的 `collectLocaleList` 读 `resources[id].common.locale[id]`
//    ⇒ `common.locale.*` 整族算已用。
//    ⚠ 这一类最容易漏：它长得像普通对象访问，任何基于 `t(` 的扫描都看不见它。
//
// ## 已知历史（每次下调棘轮都要在这里记一句）
//
// r104 首轮建模后仍有 255 个候选，逐个抽查发现真假混杂，删掉两族真死键共 80 条：
//   · `dshExt.*` 13 键 ×4 语言 —— r58/r63 把按内核分的扩展页统一成 kernel-extensions-page
//     （改用 `ext.*`）后的残渣；`piExt.*` 当时已清成 0，只漏了 dsh 这半。
//   · `debug.area.*` / `copyDomTitle` / `simplify` / `areaNotFound` 7 键 ×4 —— "复制区域 DOM"
//     功能退役后的残留（debug-bar 里唯一的动态拼键是 `debug.density.${d}`，已被 ② 覆盖）。
//   删除前用"候选键全仓字面量反查"救回了 `debug.copied`（正则列入候选、反查发现仍在用）——
//   **候选清单不等于删除清单**。
//
// 剩余候选**未逐个核实**，所以本轮只交棘轮（不许增长）+ 账本（已核实的两族），
// 不交"必须为 0"——按 r77 的纪律：判据没把握时不交那条守卫。

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const LOCALES = ["zh-CN", "zh-TW", "en", "de"];
/** r105 实测基线（删掉 80 条死键后）。只许减少；每核实并删一批就下调。 */
const CEILING = 26;   // r105 六类 231 → r106 七类 190 → r107 删4键+八类 186 → r108 语料补 test-plugins（消除 160 个假阳性）26（只许继续减少）   // r105 六类 231 → r106 补第七类 190 → r107 删 4 个确证死键 + 补第八类 186（只许继续减少）   // r105 建模六类后 231 → r106 补第七类（键作变量传递）后 190（只许继续减少）

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) { if (name !== "node_modules" && !name.startsWith(".")) walk(full, out); }
    else out.push(full);
  }
  return out;
}

/** ① 语言包全集（zh-CN 为基准；四语言齐全由 locale-parity 守卫负责，这里不重复） */
function localeKeys(): Set<string> {
  const keys = new Set<string>();
  for (const base of ["src/plugins", "test-plugins"]) {
    for (const f of walk(join(ROOT, base)).filter((x) => x.includes(`/locales/${LOCALES[0]}/`) && x.endsWith(".json"))) {
      for (const k of Object.keys(JSON.parse(readFileSync(f, "utf-8")) as Record<string, unknown>)) keys.add(k);
    }
  }
  return keys;
}

/** 代码语料（生产代码；不含测试与语言包） */
function codeFiles(): string[] {
  const out: string[] = [];
  // ⚠ 语料必须与 localeKeys() 的扫描根**对称**（r108）：语言包侧扫 src/plugins + test-plugins
  //   两个根，代码侧首版却只扫 src/* 与 packages/*，漏了 test-plugins/。
  //   后果是**系统性假阳性**：minimal / probe4 是 test-plugins 里的测试内核，
  //   它们的 renderer 确实用 `<KernelVersionPage i18nPrefix="minimal">` 消费
  //   `minimal.customCli.*` / `probe4.customCli.*`（经 kernel-version-page.tsx 的
  //   `t(`${i18nPrefix}.customCli.${suffix}`)` 两级动态键），但那 26 个键全被判成死键。
  //   这正是 r67/r76 那条纪律的又一次应验：**任何计数都要能报出语料基数，
  //   而"两侧语料范围不一致"是最隐蔽的一类判据缺陷**（它不报错，只是默默多报）。
  for (const base of ["src/web", "src/plugins", "src/server", "packages/react/src", "packages/shared/src", "test-plugins"]) {
    for (const f of walk(join(ROOT, base))) {
      if (!/\.tsx?$/.test(f) || /\.test\.tsx?$/.test(f) || f.includes("/locales/")) continue;
      out.push(f);
    }
  }
  return out;
}

function strip(s0: string): string {
  const s = s0.replace(/\/\*[\s\S]*?\*\//g, "");
  return s.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
}

interface Model {
  staticKeys: Set<string>;
  prefixes: Set<string>;       // ②③⑤⑥ 全部以前缀族表达
  dataKeys: Set<string>;       // ④ manifest *Key + channel meta
}

function buildModel(): Model {
  const files = codeFiles();
  const staticKeys = new Set<string>();
  const prefixes = new Set<string>();
  const dataKeys = new Set<string>();
  for (const f of files) {
    const s = strip(readFileSync(f, "utf-8"));
    for (const m of s.matchAll(/\bt\s*\(\s*"([^"]+)"/g)) staticKeys.add(m[1]);
    // ② 模板前缀族：t(`prefix${ … }) —— 前缀必须**非空**（空前缀会让判据恒真，见下）
    for (const m of s.matchAll(/\bt\s*\(\s*`([^`$]+)\$\{/g)) prefixes.add(m[1]);
    // ③ 完全动态键：收集 i18nPrefix="字面量" 的调用方
    for (const m of s.matchAll(/i18nPrefix\s*=\s*"([^"]+)"/g)) prefixes.add(`${m[1]}.`);
    // ④ 键当数据传：channel meta 的 labelKey/descriptionKey
    for (const m of s.matchAll(/(?:labelKey|descriptionKey)\s*:\s*"([^"]+)"/g)) dataKeys.add(m[1]);
    // ⑦ **键作为变量/常量传递**（r106 补）：`const failKey = "ext.toggleFailed"; … t(failKey, …)`
    //    或 `runGuarded(t, op, "ext.restartFailed")` —— 键以字面量出现在代码里，
    //    但**不在 `t(` 的紧邻位置**，所以 ① 抓不到。实测这一类不小：
    //    r86 自己加的 ext.toggleFailed / ext.restartFailed 就被误判成死键。
    //    做法：收集语料里所有"含点"的字符串字面量（精确值，不做前缀匹配）。
    //    ⚠ 用精确值而不是前缀，是为了不让它退化成"匹配一切"（r104 的空前缀教训）。
    for (const m of s.matchAll(/"([a-z][\w-]*\.[\w.-]+)"/g)) dataKeys.add(m[1]);
  }
  // ⑥ 结构性遍历 resources（不经 t()）——实测全仓唯一一处：merge.ts 的 collectLocaleList
  prefixes.add("common.locale.");
  // ④⑤ manifest：*Key 字段 + 派生键前缀
  for (const base of ["src/plugins", "test-plugins"]) {
    for (const f of walk(join(ROOT, base)).filter((x) => x.endsWith("plugin.json"))) {
      const d = JSON.parse(readFileSync(f, "utf-8")) as {
        id?: string;
        contributes?: Record<string, unknown>;
      };
      const walkKeys = (o: unknown): void => {
        if (Array.isArray(o)) { for (const x of o) walkKeys(x); return; }
        if (o && typeof o === "object") {
          for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
            if (typeof v === "string" && /Key$/.test(k)) dataKeys.add(v);
            else walkKeys(v);
          }
        }
      };
      walkKeys(d.contributes ?? {});
      // ⑧ **manifest 里任何含点的字符串值**（r107 补）：不只 `*Key` 字段。
      //    实测形态：theme-tab.tsx 用 `t(opt.name, { defaultValue: opt.name })` 翻译主题名，
      //    而 `opt.name` 来自主题贡献的 `name` 字段（值形如 `theme.dark`）——
      //    键当**运行时数据**传，字段名不带 Key 后缀，所以 ④ 抓不到。
      //    ⚠ 语言包里有两种键形态：带 ns 前缀的扁平键（`shell.cancel`）与
      //    **裸键**（`theme.json` 里的 `dark`，ns 由文件名给出）。所以两个形态都要登记：
      //    完整值进 dataKeys，ns 剥离后的尾键也进（否则裸键永远匹配不上）。
      const walkAny = (o: unknown): void => {
        if (Array.isArray(o)) { for (const x of o) walkAny(x); return; }
        if (o && typeof o === "object") { for (const v of Object.values(o as Record<string, unknown>)) walkAny(v); return; }
        if (typeof o === "string" && /^[a-z][\w-]*\.[\w.-]+$/.test(o)) {
          dataKeys.add(o);
          const dot = o.indexOf(".");
          dataKeys.add(o.slice(dot + 1));
        }
      };
      walkAny(d.contributes ?? {});
      const c = (d.contributes ?? {}) as Record<string, Array<Record<string, unknown>> | undefined>;
      for (const st of c.settings ?? []) {
        if (typeof st.id === "string") prefixes.add(`settings.${st.id}.`);
        for (const tb of (st.tabs as Array<Record<string, unknown>> | undefined) ?? []) {
          if (typeof tb.id === "string") prefixes.add(`settings.${tb.id}.`);
        }
      }
      for (const sp of c.sidePanel ?? []) {
        if (typeof sp.id === "string") prefixes.add(`sidePanel.${sp.id}.`);
      }
      if (typeof d.id === "string") prefixes.add(`plugin.${d.id}.`);
    }
  }
  return { staticKeys, prefixes, dataKeys };
}

describe("i18n 死键普查（六类消费方建模 + 棘轮）", () => {
  const all = localeKeys();
  const model = buildModel();
  const covered = (k: string): boolean =>
    model.staticKeys.has(k) || model.dataKeys.has(k) ||
    [...model.prefixes].some((p) => k.startsWith(p));
  const dead = [...all].filter((k) => !covered(k)).sort();

  it("判据不空转：语言包与语料规模正常，且**前缀族里没有空串**", () => {
    // ⚠ 反空转的关键一条：r104 首版的模板前缀正则把 t(`${var}.x`) 的前缀匹配成 ""，
    //   而 "".startsWith 恒真 ⇒ covered() 对所有键成立 ⇒ 报"死键 0 个"。
    //   判据退化时"0 违规"是最危险的结果（它看起来像彻底干净），所以这里显式钉住。
    expect([...all].length, `zh-CN 语言包只有 ${all.size} 个键（r105 实测 1658）⇒ 扫描根可能错了`).toBeGreaterThan(1500);
    expect(model.staticKeys.size, "静态 t() 键数异常少 ⇒ 正则可能坏了").toBeGreaterThan(700);
    const empty = [...model.prefixes].filter((p) => p.trim() === "");
    expect(empty, "前缀族里混进了空串 ⇒ covered() 会恒真、死键永远报 0（r104 踩过）").toEqual([]);
    expect([...model.prefixes].every((p) => p.length > 0), "存在空/纯空白前缀").toBe(true);
    expect(model.prefixes.has("common.locale."), "结构性遍历族 common.locale. 必须在模型里（merge.ts 的 collectLocaleList 不经 t()）").toBe(true);
    const cf = codeFiles();
    expect(cf.length, `代码语料只有 ${cf.length} 个文件 ⇒ 扫描根可能漏了`).toBeGreaterThan(400);
    // ⚠ 显式钉住"语料含 test-plugins"：r108 的缺陷正是漏了它，而总数仍 >400 所以看不出来。
    //   只看总量看不出**缺了哪一根**，必须按根断言。
    // ⚠ codeFiles() 返回的是**绝对路径**（join(ROOT, base)），所以判归属要用 includes
    //   而不是 startsWith——首版写 startsWith("test-plugins/") 恒假，
    //   于是"按根断言"自己成了假红（而前缀其实已经收进来了、计数已降到 26）。
    expect(cf.some((f) => f.includes("/test-plugins/")),
      "代码语料里没有 test-plugins/ ⇒ 测试内核（minimal/probe4）消费的键会被全部误判成死键（r108）").toBe(true);
    expect(model.prefixes.has("minimal.") || model.prefixes.has("probe4."),
      "test-plugins 里内核插件的 i18nPrefix 没被收进来 ⇒ 语料或正则失效").toBe(true);
  });

  it("① 自检：已知的**在用**键必须被判为已覆盖（否则判据在漏，死键数会虚高）", () => {
    // 每类取一个实测在用的样本（来自 r104 的建模过程，不是编造的）
    const samples = [
      "shell.cancel",                 // ① 静态 t()
      "debug.density.smart",         // ② 模板前缀族 debug.density.（实测存在的键：smart/structure/all）
      "common.locale.zh-CN",          // ⑥ 结构性遍历（不经 t()）
    ];
    const missing = samples.filter((k) => !all.has(k));
    expect(missing, `自检样本不在语言包里（样本必须来自实测分布，不能凭空造）：${missing.join()}`).toEqual([]);
    const notCovered = samples.filter((k) => !covered(k));
    expect(notCovered, `这些在用的键被判成死键 ⇒ 判据在漏：${notCovered.join()}`).toEqual([]);
  });

  it("② 棘轮：未被任何消费方覆盖的键数只许减少（r108 基线 26）", () => {
    expect(dead.length, [
      `疑似死键从 ${CEILING} 涨到了 ${dead.length}。`,
      "      新增的键要么真的没人用（该删或该接上消费方），要么引入了一种**本判据没建模的消费方式**。",
      "      后者更常见也更危险：删掉会造成运行时缺文案。已建模的六类见文件头注释；",
      "      若新增了第七类（例如某处开始直接遍历 resources、或把键存进配置文件再查），",
      "      **先把它加进模型**再看数字，不要直接加豁免。",
      `      当前前 12 个：${dead.slice(0, 12).join(", ")}`,
    ].join("\n")).toBeLessThanOrEqual(CEILING);
  });

  it("③ 账本：已核实为死键并删除的两族**不得复活**", () => {
    // r104 删掉的 20 个键（13 + 7）。它们若重新出现，说明有人复制了旧文案或回退了统一改造。
    const DELETED_FAMILIES = ["dshExt.", "debug.area.", "debug.copyDomTitle", "debug.simplify", "debug.areaNotFound"];
    const revived = dead.length >= 0 ? [...all].filter((k) => DELETED_FAMILIES.some((p) => k.startsWith(p))) : [];
    expect(revived, [
      `${revived.length} 个 r104 已删除的死键又回来了：${revived.slice(0, 8).join(", ")}`,
      "      dshExt.* 是「按内核分的扩展页」被统一成 kernel-extensions-page（用 ext.*）后的残渣；",
      "      debug.area.*/copyDomTitle/simplify 是「复制区域 DOM」功能退役后的残留。",
      "      复活通常意味着复制了旧文案，或把已统一的页面又拆回按内核分支。",
    ].join("\n")).toEqual([]);
  });

  it("④ 四语言键集严格对齐（删键必须四语言同步，否则某语言会回落英文或显示裸键）", () => {
    const per = new Map<string, Set<string>>();
    for (const loc of LOCALES) {
      const keys = new Set<string>();
      for (const base of ["src/plugins", "test-plugins"]) {
        for (const f of walk(join(ROOT, base)).filter((x) => x.includes(`/locales/${loc}/`) && x.endsWith(".json"))) {
          for (const k of Object.keys(JSON.parse(readFileSync(f, "utf-8")) as Record<string, unknown>)) keys.add(k);
        }
      }
      per.set(loc, keys);
    }
    const base = per.get("zh-CN")!;
    for (const loc of LOCALES.slice(1)) {
      const s = per.get(loc)!;
      const missing = [...base].filter((k) => !s.has(k));
      const extra = [...s].filter((k) => !base.has(k));
      expect({ loc, missing: missing.slice(0, 6), extra: extra.slice(0, 6) },
        `${loc} 与 zh-CN 的键集不一致（missing ${missing.length} / extra ${extra.length}）`).toEqual({ loc, missing: [], extra: [] });
    }
  });
});
