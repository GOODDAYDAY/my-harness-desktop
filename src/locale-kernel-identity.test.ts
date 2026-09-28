// 内核插件的语言包**不得提到别的内核**（跨内核复制粘贴守卫）。
//
// ## 实测缺陷（r29）
//
// `test-plugins/kernels/minimal/locales/*/minimal-models.json` 的
// `minimalModels.title` 在**四个语言里全部**是 "DSH 模型配置" / "DSH model config" /
// "DSH-Modellkonfiguration"，`minimalModels.apiKeyDesc` 也写着"密钥写入 **dsh** 凭证库
// (~/.dsh/.credentials.yaml)，**dsh** 运行时直接读取，不写进 models.json/**cordis.yml**"
// ——而 cordis.yml 是 dsh 的配置格式，minimal 的凭证实际落在
// `<agentDir>/.credentials.json`（`src/server/kernel/minimal/manager/minimal-config-source.ts:44`）。
// 整份文件是从 dsh 插件**复制粘贴后没有适配**的：用户配置 minimal 内核时，
// 界面标题写着 DSH、说明文字告诉他把密钥写进 dsh 的凭证库。
//
// 为什么值得立守卫：`test-plugins/kernels/minimal/` 是**第四个内核插件的模板**
// （CLAUDE.md §6.1 说明它"不在任何生产扫描根里，只有测试把它种进隔离 HOME 才装载"），
// 模板错 = 之后每个新内核都从这里抄错。而这类缺陷**功能不报错、页面不崩**，
// 只有读界面上的字才会发现——正向功能剧本永远抓不到。
//
// ## 判据与账本
//
// 对每个内核插件目录（`src/plugins/kernels/<id>/` 与 `test-plugins/kernels/<id>/`）的
// 每一个语言包值，扫其它内核 id 的**词边界**出现。命中即违规，除非在账本里登记了理由。
// 账本按 (own, key, other) 登记——key 在四个语言里是同一个，所以一条账本覆盖四次出现。
//
// ⚠ **不能不加账本直接判违规**：实测 20 处跨内核提及**全部合法**，分三种形态——
//   ① **包名**：dsh 的 `dshModels.desc` 提到 `llm-pi-ai`，那是 npm 包名，不是对 pi 内核的指称；
//   ② **有意的对等性陈述**：`plugin.dsh.description` 写"与 PI 同级"，这是 §1.4「无特权差异」
//      的正面表达，删掉反而丢了信息；
//   ③ **同形异义**：pi 的 `thinkingBudgets.minimal` / `defaultThinkingLevel.minimal` 里的
//      `minimal` 是**思考档位名**（off/minimal/low/medium/high/xhigh），与 minimal 内核同形。
// 所以这条守卫的价值不在"抓到多少"，而在"**新增的跨内核提及必须当场解释**"——
// 上面那个 DSH 标题的缺陷，正是因为从来没有人被要求解释过"minimal 的语言包为什么在说 dsh"。

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
/** 内核 id 清单：**从插件目录派生**，不写死（r48）。
 *
 *  ⚠ 这里原本写死 `["pi","dsh","minimal"]`，注释还声称"单源在圆心"——但圆心的
 *  `KernelId` 早已去字面量化成 `string`、`KERNEL_IDS` 数组也已删除（见
 *  `packages/shared/src/domain/kernel.ts`），所以那句注释本身就是过期的。
 *  写死清单有两个害处：① 加第四个内核（probe4，开闭原则的实测探针）时这条自检直接打红；
 *  ② 更隐蔽的是下面 ③ 处的跨内核检测循环也用这份清单——**清单里没有的内核名，
 *  就永远不会被当成"跨内核提及"**，于是新内核被别的内核语言包提到时守卫会静默放过。
 *  改为派生后，两个问题一起消失，而"每个内核插件都有语言包"这条不变量照旧被钉住
 *  （派生源是插件 manifest 目录，被比对的是 locale 目录，两者独立）。 */
const KERNEL_IDS = ["src/plugins/kernels", "test-plugins/kernels"]
  .flatMap((root) => {
    const abs = join(ROOT, root);
    return existsSync(abs) ? readdirSync(abs).filter((d) => existsSync(join(abs, d, "plugin.json"))) : [];
  })
  .sort();

/** 允许的跨内核提及：(所属内核插件, 语言包 key, 被提到的内核) → 理由。 */
const LEDGER: { own: string; key: string; other: string; why: string }[] = [
  { own: "dsh", key: "dsh.routeEmptyModels", other: "pi",
    why: "文中的 `llm-pi-ai` 是 **npm 包名/配置段名**（dsh 的 provider 路由段），不是对 pi 内核的指称；r91 把这条服务端错误从 dsh-config-source.ts 迁进语言包（面向用户、带可执行指引），措辞沿用原文以免丢失『空路由会毒化整段』这个关键因果" },
  { own: "dsh", key: "dshModels.desc", other: "pi",
    why: "文中的 `llm-pi-ai` 是 **npm 包名**（dsh 的 provider 路由用它），不是对 pi 内核的指称" },
  { own: "dsh", key: "plugin.dsh.description", other: "pi",
    why: "「与 PI 同级」是**有意的对等性陈述**（CLAUDE.md §1.4 无特权差异的正面表达），删掉反而丢信息" },
  // r30 新增：给 minimal 补 `plugin.minimal.description` 派生键时写的描述里有「与 pi/dsh 同级」。
  // 守卫当场把它拦下来要求解释——这正是设计意图（新增跨内核提及必须表态）。
  // 它与下面 dsh 那条同型：§1.4「无特权差异」的正面陈述，而且 minimal 是**第四个内核插件的模板**，
  // 模板里明写"与 pi/dsh 同级"恰好是在教后来者这条纪律，删掉反而丢了信息。
  { own: "minimal", key: "plugin.minimal.description", other: "pi",
    why: "「与 pi/dsh 同级」是 §1.4 无特权差异的正面陈述；minimal 是第四个内核插件的模板，此处明写对等性正是在教后来者这条纪律" },
  { own: "probe4", key: "plugin.probe4.description", other: "pi",
    why: "probe4 是 r48 建立的**开闭原则实测探针**（minimal 的克隆），描述里「与 pi/dsh 同级」沿用 minimal 的**对等性陈述**（CLAUDE.md §1.4）；它恰恰是这个探针要证明的命题本身" },
  { own: "probe4", key: "plugin.probe4.description", other: "dsh",
    why: "probe4 是 r48 建立的**开闭原则实测探针**（minimal 的克隆），描述里「与 pi/dsh 同级」沿用 minimal 的**对等性陈述**（CLAUDE.md §1.4）；它恰恰是这个探针要证明的命题本身" },
  { own: "minimal", key: "plugin.minimal.description", other: "dsh",
    why: "同上（同一句里的 pi/dsh 并列）" },
  { own: "pi", key: "kernel.fields.thinkingBudgets.minimal", other: "minimal",
    why: "此处 `minimal` 是**思考档位名**（off/minimal/low/medium/high/xhigh），与 minimal 内核同形异义" },
  { own: "pi", key: "kernel.fieldDescs.thinkingBudgets.minimal", other: "minimal",
    why: "同上：档位名的说明文字，不是指 minimal 内核" },
  { own: "pi", key: "kernel.options.defaultThinkingLevel.minimal", other: "minimal",
    why: "同上：档位选项的标签，不是指 minimal 内核" },
];

interface Hit { own: string; locale: string; key: string; other: string; value: string; file: string }

function kernelPluginRoots(): { own: string; dir: string }[] {
  const out: { own: string; dir: string }[] = [];
  for (const base of ["src/plugins/kernels", "test-plugins/kernels"]) {
    const abs = join(ROOT, base);
    if (!existsSync(abs)) continue;
    for (const name of readdirSync(abs)) {
      const d = join(abs, name, "locales");
      if (existsSync(d)) out.push({ own: name, dir: d });
    }
  }
  return out;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (name.endsWith(".json")) out.push(full);
    else if (!name.includes(".")) walk(full, out);
  }
  return out;
}

function scan(): Hit[] {
  const hits: Hit[] = [];
  for (const { own, dir } of kernelPluginRoots()) {
    for (const f of walk(dir)) {
      const locale = relative(dir, f).split("/")[0];
      let d: Record<string, unknown>;
      try { d = JSON.parse(readFileSync(f, "utf-8")) as Record<string, unknown>; } catch { continue; }
      for (const [k, v] of Object.entries(d)) {
        if (typeof v !== "string") continue;
        for (const other of KERNEL_IDS) {
          if (other === own) continue;
          // 词边界：避免 `llm-pi-ai` 之外的误伤（如 "pixel" 里的 pi）；连字符算边界，
          // 所以 `llm-pi-ai` 会命中——它靠账本豁免，而不是靠放宽正则。
          const re = new RegExp(`(?<![A-Za-z0-9])${other}(?![A-Za-z0-9])`, "i");
          if (re.test(v)) {
            hits.push({ own, locale, key: k, other, value: v, file: relative(ROOT, f) });
          }
        }
      }
    }
  }
  return hits;
}

describe("内核插件语言包：跨内核提及必须登记理由（防复制粘贴未适配）", () => {
  const hits = scan();

  it("判据不空转：确实扫到了内核插件的语言包，且 id 清单与插件目录一一对应", () => {
    const roots = kernelPluginRoots();
    expect(roots.length, "一个内核插件语言包目录都没扫到 = 路径错了（假绿）").toBeGreaterThanOrEqual(3);
    const own = roots.map((r) => r.own).sort();
    expect(own, "扫到的语言包目录应与**插件 manifest 目录**一一对应（缺 = 该内核没有语言包；多 = 有无主的语言包目录）").toEqual([...KERNEL_IDS].sort());
    expect(KERNEL_IDS.length, "派生出的内核清单不该为空（空 = 派生路径错了，会让整组判据空转）").toBeGreaterThanOrEqual(3);
    // 自检：known-good 的跨内核提及必须被扫出来（否则正则或路径失效）
    expect(hits.some((h) => h.own === "dsh" && h.key === "dshModels.desc"), "自检失败：dsh 的 llm-pi-ai 提及没被扫到").toBe(true);
    expect(hits.some((h) => h.own === "pi" && h.key.includes("thinkingBudgets.minimal")), "自检失败：pi 的档位名提及没被扫到").toBe(true);
  });

  it("① 没有**未登记**的跨内核提及（新增必须当场解释，不能默默抄别的内核）", () => {
    const bad = hits.filter((h) => !LEDGER.some((l) => l.own === h.own && l.key === h.key && l.other === h.other));
    const lines = bad.map((h) =>
      `${h.own} 的语言包提到「${h.other}」：${h.file} ${h.key}\n        ${h.value.slice(0, 110)}\n        → 若确属合法（包名/对等性陈述/同形异义），加进 LEDGER 并写明理由；否则是复制粘贴未适配，改掉`,
    );
    expect(bad, `未登记的跨内核提及 ${bad.length} 处：\n      ` + lines.join("\n      ")).toEqual([]);
  });

  it("② 账本没有腐烂：每条登记都必须仍能在扫描结果里找到（改好了就删，否则账本越长越假）", () => {
    const stale: string[] = [];
    for (const l of LEDGER) {
      if (!hits.some((h) => h.own === l.own && h.key === l.key && h.other === l.other)) {
        stale.push(`${l.own} ${l.key} 提到「${l.other}」（扫描结果里已不存在 → 从 LEDGER 删除）`);
      }
    }
    expect(stale, `账本里有 ${stale.length} 条已失效：\n      ` + stale.join("\n      ")).toEqual([]);
  });

  it("③ 每条账本登记都带理由，且理由不是空话", () => {
    for (const l of LEDGER) {
      expect(typeof l.why === "string" && l.why.length >= 12, `${l.own} ${l.key} 的理由太短`).toBe(true);
    }
  });

  it("④ 回归锚：minimal 的**模型页**文案不得再是 dsh 的复制粘贴（r29 修掉的那个缺陷）", () => {
    // ⚠ 这条锚的范围要**精确到出缺陷的那份文件**，不能写成"minimal 的语言包一个 dsh 字都不该有"。
    //   首版就是那么写的，结果 r30 给 minimal 补 `plugin.minimal.description` 时写了
    //   「与 pi/dsh 同级」（§1.4 对等性陈述，合法且已入账本），这条锚立刻变红——
    //   而它要保护的从来不是"任何提及"，是**模型页那份被整体抄自 dsh 的文案**。
    //   锚写太宽 = 合法改动被迫绕过守卫，守卫就会失去信任（§17.2 的假阳性教训）。
    const dir = join(ROOT, "test-plugins/kernels/minimal/locales");
    for (const loc of ["zh-CN", "zh-TW", "en", "de"]) {
      const d = JSON.parse(readFileSync(join(dir, loc, "minimal-models.json"), "utf-8")) as Record<string, string>;
      for (const [k, v] of Object.entries(d)) {
        expect(/(?<![A-Za-z0-9])dsh(?![A-Za-z0-9])/i.test(v),
          `${loc}/minimal-models.json ${k} 又提到 dsh 了（复制粘贴未适配的回潮）：${v.slice(0, 80)}`).toBe(false);
      }
      // cordis.yml 是 dsh 的配置格式，minimal 用不上——它出现在这里就是抄没改干净
      expect(d["minimalModels.apiKeyDesc"] ?? "", `${loc} 的 apiKeyDesc 不该提 cordis.yml`).not.toContain("cordis");
      // 凭证路径必须是 minimal 自己的（源码事实：minimal-config-source.ts 的 credentialsPath
      // = join(agentDir, ".credentials.json")），不能是 dsh 的 .credentials.yaml
      expect(d["minimalModels.apiKeyDesc"] ?? "", `${loc} 的 apiKeyDesc 应写 minimal 自己的凭证文件`)
        .toContain(".credentials.json");
      // 标题必须是 minimal 自己
      expect(d["minimalModels.title"] ?? "", `${loc} 的模型页标题应写 minimal 自己`).toContain("Minimal");
    }
  });
});
