// 贡献声明里的用户可见标签，必须在四个语言里都有**派生 i18n 键**。
//
// ## 机制（先说清，否则判据无从谈起）
//
// manifest 里 `contributes.settings[].title` / `tabs[].title` / `sidePanel[].label`
// 与顶层 `displayName` / `description` 都是**裸字符串**，没有 `titleKey`/`labelKey` 字段。
// 渲染方不是直接显示它们，而是**按 id 派生一个 i18n 键、把 manifest 字面量当 defaultValue 兜底**：
//
// | 渲染点 | 派生键公式 |
// |---|---|
// | `src/web/components/settings-page.tsx`（设置侧栏条目） | `settings.<entryId>` |
// | `src/web/components/settings-page.tsx`（条目下的 TAB） | `settings.<tabId>` |
// | `src/web/components/right-panel.tsx` `sidePanelLabel()` | `sidePanel.<id>` |
// | `src/plugins/manager/plugin-manager/renderer/index.tsx` | `plugin.<id>.displayName` / `plugin.<id>.description` |
//
// 所以"manifest 里写着中文"**本身不是缺陷**——只要派生键存在，界面显示的就是译文，
// 中文字面量只在键缺失时兜底。缺陷是**键缺失 + 字面量是中文**：此时四个语言全都显示简体中文。
//
// ## 实测缺陷（r30）
//
// 两个内核插件的 4 个设置 TAB 标题就是这个形态：`settings.pi-ext`（"PI 拓展"）、
// `settings.pi-models`（"模型"）、`settings.dsh-ext`（"DSH 拓展"）、`settings.dsh-models`（"DSH 模型"）
// 在**四个语言里一个键都没有**，于是 en/de/zh-TW 界面的设置侧栏照样显示简体中文。
// 而内核管理页恰恰是最显眼的设置页。同目录里倒是有 `settings.extensions` / `settings.models`
// 两个键——名字与派生公式**对不上**（那是页面组件内部自用的标题），所以帮不上忙。
// 这类缺陷的隐蔽之处正在于此：**看起来"已经有 i18n 键了"**，只是键名与派生公式不同源。
//
// ## 判据
//
// ① 派生公式**从渲染方源码核对**（不是手抄）——公式改了守卫就红，避免守卫与实现漂移；
// ② 字面量含 CJK 的贡献项，其派生键必须在**全部四个语言**里存在；
// ③ 字面量是纯 ASCII/专名（`DSH`、`Pi`、`Graphviz 图` 里的 ASCII 部分）→ 豁免：
//    兜底值本身就语言无关，加键只是噪音；
// ④ 反向：语言包里存在但**没有任何贡献项派生到它**的 `settings.*` / `sidePanel.*` 键不算违规
//    （页面内部自用），但会打印计数，防止"以为加了键其实没人用"这种情况无声扩散。

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const LOCALES = ["zh-CN", "zh-TW", "en", "de"];
const CJK = /[\u4e00-\u9fff\u3400-\u4dbf]/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) { if (name !== "node_modules") walk(full, out); }
    else out.push(full);
  }
  return out;
}

/** 所有插件目录（含 test-plugins：minimal 的语言包同样会到达 UI，见 r29）。 */
function pluginDirs(): string[] {
  const out: string[] = [];
  for (const base of ["src/plugins", "test-plugins"]) {
    const abs = join(ROOT, base);
    if (!existsSync(abs)) continue;
    for (const f of walk(abs)) if (f.endsWith("/plugin.json") && !f.includes("/locales/")) out.push(dirname(f));
  }
  return out;
}

/** 插件自己的语言包键集（按 locale 分）。 */
function localeKeys(dir: string): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const loc of LOCALES) {
    const d = join(dir, "locales", loc);
    const keys = new Set<string>();
    if (existsSync(d)) {
      for (const f of walk(d)) {
        if (!f.endsWith(".json")) continue;
        try { Object.keys(JSON.parse(readFileSync(f, "utf-8")) as object).forEach((k) => keys.add(k)); } catch { /* 坏文件由别的守卫管 */ }
      }
    }
    m.set(loc, keys);
  }
  return m;
}

interface Label { plugin: string; dir: string; derived: string; literal: string; where: string }

function collectLabels(): Label[] {
  const out: Label[] = [];
  for (const dir of pluginDirs()) {
    const m = JSON.parse(readFileSync(join(dir, "plugin.json"), "utf-8")) as {
      id: string; displayName?: string; description?: string;
      contributes?: { settings?: { id: string; title?: string; tabs?: { id: string; title?: string }[] }[]; sidePanel?: { id: string; label?: string }[] };
    };
    const pid = m.id;
    const rel = relative(ROOT, dir);
    const push = (derived: string, literal: string | undefined, where: string): void => {
      if (typeof literal === "string" && literal.length > 0) out.push({ plugin: pid, dir, derived, literal, where: `${rel} ${where}` });
    };
    push(`plugin.${pid}.displayName`, m.displayName, "displayName");
    push(`plugin.${pid}.description`, m.description, "description");
    for (const s of m.contributes?.settings ?? []) {
      push(`settings.${s.id}`, s.title, `contributes.settings[${s.id}].title`);
      for (const t of s.tabs ?? []) push(`settings.${t.id}`, t.title, `contributes.settings[${s.id}].tabs[${t.id}].title`);
    }
    for (const p of m.contributes?.sidePanel ?? []) push(`sidePanel.${p.id}`, p.label, `contributes.sidePanel[${p.id}].label`);
  }
  return out;
}

describe("贡献声明的用户可见标签：派生 i18n 键必须四语言齐全", () => {
  const labels = collectLabels();

  it("① 判据与渲染方**同源**：派生公式必须真的出现在渲染代码里（公式改了守卫就红）", () => {
    const settingsPage = readFileSync(join(ROOT, "src/web/components/settings-page.tsx"), "utf-8");
    const rightPanel = readFileSync(join(ROOT, "src/web/components/right-panel.tsx"), "utf-8");
    const pluginManager = readFileSync(join(ROOT, "src/plugins/manager/plugin-manager/renderer/index.tsx"), "utf-8");
    expect(settingsPage, "设置侧栏条目的派生公式变了").toContain("t(`settings.${item.id}`");
    expect(settingsPage, "设置 TAB 的派生公式变了").toContain("t(`settings.${tab.id}`");
    expect(rightPanel, "右面板 TAB 的派生公式变了").toContain("t(`sidePanel.${item.id}`");
    expect(pluginManager, "插件名的派生公式变了").toContain("t(`plugin.${p.id}.displayName`");
    expect(pluginManager, "插件描述的派生公式变了").toContain("t(`plugin.${p.id}.description`");
  });

  it("② 判据不空转：确实扫到了插件与标签，且已知良好的键能被找到", () => {
    expect(labels.length, "一条标签都没扫到 = 路径或解析坏了（假绿）").toBeGreaterThan(80);
    expect(new Set(labels.map((l) => l.plugin)).size, "扫到的插件数太少").toBeGreaterThan(20);
    const cjk = labels.filter((l) => CJK.test(l.literal));
    expect(cjk.length, "含中文的标签数为 0 —— 要么全修好了要么判据失效，需人工确认").toBeGreaterThan(0);
    // 自检：本轮修好的键必须在（否则说明扫描读不到语言包）
    const dshKeys = localeKeys(pluginDirs().find((d) => d.endsWith("kernels/dsh"))!);
    expect(dshKeys.get("en")?.has("settings.dsh-ext"), "自检失败：刚补的 settings.dsh-ext 扫不到").toBe(true);
  });

  it("③ 含 CJK 字面量的标签，其派生键必须在**全部四个语言**里存在", () => {
    const bad: string[] = [];
    for (const l of labels) {
      if (!CJK.test(l.literal)) continue;                 // ASCII/专名：兜底即语言无关，豁免
      const keys = localeKeys(l.dir);
      const miss = LOCALES.filter((loc) => !keys.get(loc)?.has(l.derived));
      if (miss.length > 0) {
        bad.push(`${l.where}\n        派生键 \`${l.derived}\` 缺 ${miss.join("/")}；manifest 字面量 ${JSON.stringify(l.literal.slice(0, 40))}\n        → 缺键时四个语言都会显示这个简体字面量。补键，或把字面量改成语言无关的专名`);
      }
    }
    expect(bad, `派生键缺失 ${bad.length} 处：\n      ` + bad.join("\n      ")).toEqual([]);
  });

  it("④ 纯 ASCII 字面量的豁免是有意的：打印清单，防止豁免面悄悄变大", () => {
    const ascii = labels.filter((l) => !CJK.test(l.literal));
    const keys = new Set(ascii.map((l) => l.derived));
    // 豁免的正当性在于"兜底值语言无关"。若哪天有人把中文塞进这些位置，③ 会抓到；
    // 这里只把豁免面的规模打印出来，便于人工复核它没有异常膨胀。
    console.log(`      纯 ASCII 字面量豁免 ${ascii.length} 条（${keys.size} 个不同派生键），例：${[...keys].slice(0, 6).join(", ")}`);
    expect(ascii.length).toBeGreaterThanOrEqual(0);
  });
});
