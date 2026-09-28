// 槽位贡献项的文案必须有译文 —— 守「manifest 里的中文字面量在非简中界面下原样露出」这类缺陷。
//
// 实测缺陷（scripts/demo/dom-audit.e2e.mjs 按 locale 逐个跑时抓到）：
//   · **sidePanel 槽根本没有翻译机制**：`right-panel.tsx` 直接渲染裸 `{item.label}`，
//     于是 13 个右面板 Tab 名在 zh-TW / en / de 下全是 manifest 里的硬编码简体
//     （zh-TW 界面显示「盲审 / 统计 / 请求记录」，de 界面同样）。违反 CLAUDE.md §1.2
//     「壳不内嵌功能性内容：文案 → 语言插件」。已修为与 settings 槽**同一范式**：
//     `t(`sidePanel.${id}`, { defaultValue: label })`（settings-page.tsx:88 早就是这个写法）。
//   · **settings 槽有机制但缺译文**：`t(`settings.${id}`, { defaultValue: title })` 在
//     没有对应 key 时回落到 manifest 字面量，于是 4 个插件的设置页入口在全部 4 个 locale 下
//     都显示简体（请求记录 / 语音输入 / 按键导览 / 远程访问）。
//
// 为什么必须有守卫：这两类失效都是**静默**的——功能照常、页面不报错、简中用户完全看不出问题，
// 只有切到别的语言才暴露。而 locale 切换不在任何正向功能剧本的路径上。
//
// 判据：贡献项的 `label`/`title` 若含 CJK 字符，则四个 locale 都必须存在对应的
// `<slot>.<id>` 键。**纯 ASCII 字面量豁免**（如 `DSH`、`Review`、`IM`、`Tree`）——
// 专有名词与各语言同形的词，加译文纯属噪声（实测 `settings.dsh = "DSH"` 四语相同）。
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "plugins");
const LOCALES = ["zh-CN", "zh-TW", "en", "de"];
/** 带显示文案的槽位。其余槽位没有用户可见文案：themes/languages/fileIcons 本就没有，
 *  而 **sidebar 曾有 `title` 字段但已删除**——它经 IPC 一路透传却从未被 sidebar.tsx 读取
 *  （分组标题由各插件自己渲染 `<Section title={t("…")}>`）。留着它会让本守卫产出假发现
 *  （实测：3 条"sidebar 贡献项缺四语译文"，而那 3 个 title 根本不上屏）。 */
const SLOTS = ["settings", "sidePanel"] as const;
const HAN = /[\u4e00-\u9fff]/;

interface Contribution { slot: string; id: string; literal: string; pluginDir: string; pluginId: string }

function findPluginDirs(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (!statSync(full).isDirectory()) continue;
    if (name === "node_modules" || name.startsWith(".")) continue;
    if (existsSync(join(full, "plugin.json"))) out.push(full);
    findPluginDirs(full, out);
  }
  return out;
}

const readJson = (p: string): unknown => {
  try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; }
};

function collectContributions(): Contribution[] {
  const out: Contribution[] = [];
  for (const d of findPluginDirs(ROOT)) {
    const m = readJson(join(d, "plugin.json")) as { id?: string; contributes?: Record<string, unknown> } | null;
    if (!m?.contributes) continue;
    for (const slot of SLOTS) {
      const items = m.contributes[slot];
      if (!Array.isArray(items)) continue;
      for (const it of items) {
        if (!it || typeof it !== "object") continue;
        const rec = it as { id?: string; label?: string; title?: string };
        const literal = rec.label ?? rec.title;
        if (typeof rec.id === "string" && typeof literal === "string" && literal.length > 0) {
          out.push({ slot, id: rec.id, literal, pluginDir: d, pluginId: m.id ?? relative(ROOT, d) });
        }
      }
    }
  }
  return out;
}

/** 某插件的某 locale 下，是否存在 `<slot>.<id>` 这个键（跨该 locale 的全部 ns 文件查）。 */
function hasKey(pluginDir: string, locale: string, key: string): boolean {
  const ldir = join(pluginDir, "locales", locale);
  if (!existsSync(ldir)) return false;
  for (const fn of readdirSync(ldir)) {
    if (!fn.endsWith(".json")) continue;
    const j = readJson(join(ldir, fn)) as Record<string, unknown> | null;
    if (j && key in j) return true;
  }
  return false;
}

describe("槽位贡献项的显示文案必须四语齐全（含 CJK 的字面量不许直接上屏）", () => {
  const all = collectContributions();
  const withCjk = all.filter((c) => HAN.test(c.literal));

  it("判据不空转：确实收集到了贡献项，且其中确有含中文的", () => {
    expect(all.length, "一个贡献项都没收集到 = 路径或解析错了（假绿）").toBeGreaterThanOrEqual(15);
    expect(withCjk.length, "含中文的贡献项为 0，说明判据失效").toBeGreaterThan(0);
  });

  it("含 CJK 字面量的贡献项，四个 locale 都有 <slot>.<id> 译文", () => {
    const problems: string[] = [];
    for (const c of withCjk) {
      const key = `${c.slot}.${c.id}`;
      const missing = LOCALES.filter((l) => !hasKey(c.pluginDir, l, key));
      if (missing.length) {
        problems.push(`${relative(ROOT, c.pluginDir)} [${c.slot}] id=${c.id} 字面量「${c.literal}」缺 ${missing.join(",")} 的 "${key}"`);
      }
    }
    expect(problems, `${problems.length} 个贡献项缺译文（非简中界面会露出硬编码中文）：\n${problems.slice(0, 10).join("\n")}`).toEqual([]);
  });

  it("纯 ASCII 字面量豁免（专有名词各语言同形，加译文是噪声）", () => {
    // 把豁免范围钉住：只有**完全不含 CJK** 的字面量才豁免。
    // 若将来有人给一个含中文的项挂上"它是专有名词"的借口，上一条会红。
    const ascii = all.filter((c) => !HAN.test(c.literal));
    expect(ascii.length, "应存在纯 ASCII 的贡献项（如 Review / IM / Tree / DSH）").toBeGreaterThan(0);
    for (const c of ascii) expect(c.literal, `${c.id} 的字面量应纯 ASCII`).toMatch(/^[\x20-\x7e]+$/);
  });

  it("声明了 locale 文件的贡献项，其 resources 路径真实存在（防 manifest 指向不存在的文件）", () => {
    const problems: string[] = [];
    for (const d of findPluginDirs(ROOT)) {
      const m = readJson(join(d, "plugin.json")) as { contributes?: { languages?: { id?: string; locale?: string; resources?: string }[] } } | null;
      for (const c of m?.contributes?.languages ?? []) {
        if (typeof c.resources !== "string") { problems.push(`${relative(ROOT, d)}: languages 贡献缺 resources`); continue; }
        if (!existsSync(join(d, c.resources))) problems.push(`${relative(ROOT, d)}: languages 指向不存在的文件 ${c.resources}`);
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("反方向：磁盘上的每个 locale 文件都必须被 `contributes.languages` 登记（否则静默不加载）", () => {
    // ## 为什么两个方向都要守
    //
    // 上一条守的是「声明 → 文件存在」（manifest 指向空气）。本条守**反方向**：
    // 「文件存在 → 已被声明」。后者才是历史上真出过事的那一半——r29/r30 查出
    // **72 个**语言文件躺在 `locales/` 里却没登记进 manifest，于是**静默不加载**：
    // 文件在、内容对、键也齐，界面上却永远显示 fallback 或裸键，而且不报错。
    //
    // 根因是 `contributes.languages` 是**显式文件清单**（`[{id, locale, resources}]`），
    // 不是目录扫描 ⇒ 新增一个语言文件时，"忘记登记"不会有任何信号。
    // §3.7：没有守卫的修复只是"这次对了"。r29/r30 修完那 72 个之后一直没立守卫，
    // 本条补上（r64 实测：504 个文件 / 504 条登记，未登记 0）。
    const problems: string[] = [];
    let files = 0;
    let declaredTotal = 0;
    for (const d of findPluginDirs(ROOT)) {
      const locDir = join(d, "locales");
      if (!existsSync(locDir) || !statSync(locDir).isDirectory()) continue;
      const m = readJson(join(d, "plugin.json")) as { contributes?: { languages?: { resources?: string }[] } } | null;
      const declared = new Set<string>();
      for (const c of m?.contributes?.languages ?? []) {
        if (typeof c.resources === "string") declared.add(resolve(dirname(join(d, "plugin.json")), c.resources));
      }
      declaredTotal += declared.size;
      for (const loc of readdirSync(locDir)) {
        const lp = join(locDir, loc);
        if (!statSync(lp).isDirectory()) continue;
        for (const f of readdirSync(lp)) {
          if (!f.endsWith(".json")) continue;
          files += 1;
          const full = resolve(lp, f);
          if (!declared.has(full)) problems.push(`${relative(ROOT, d)}: locales/${loc}/${f} 未登记进 contributes.languages`);
        }
      }
    }
    // 反空转：一个文件都没扫到 = 路径判据坏了（那会让本条恒真）
    expect(files, "一个 locale 文件都没扫到（r64 实测 504）——路径判据可能坏了").toBeGreaterThan(400);
    expect(declaredTotal, "一条 languages 登记都没扫到（r64 实测 504）").toBeGreaterThan(400);
    expect(problems, [
      `${problems.length} 个语言文件未被登记（会被**静默忽略**：文件在、键也齐，界面却显示 fallback 或裸键）：`,
      ...problems.slice(0, 12).map((x) => `      ${x}`),
      `      修法：在该插件 plugin.json 的 contributes.languages 里补 {id, locale, resources}。`,
    ].join("\n")).toEqual([]);
  });
});
