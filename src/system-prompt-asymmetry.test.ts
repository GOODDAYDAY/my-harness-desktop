// `BackendCreateOptions.systemPromptPaths/Texts` 的**契约不对称**棘轮守卫（r49）。
//
// ## 被守的事实
//
// 这两个字段由 application 层**中性地**注入给每一个内核（`session-store.ts` 无内核分支），
// 但实测只有一个内核的 backend-factory 真消费它们；其余内核**静默忽略**。
// 这是 §1.5 唯一禁止的状态「静默缺面」（既不翻译、也不补面、也不降级）。
// 取证与完整修法见 `docs/add-new-kernel.md` §4.2 的 r49 复核结论。
//
// ## 活的后果（不是理论问题）
//
// `systemPromptPaths` 来自 `registry.systemPromptPaths()` = 壳插件贡献的 `systemPrompts` 槽，
// `src/plugins/system/goody-hao` 正在用它。于是该插件在支持的内核下真注入、
// 在其它内核下静默不注入 —— 而它的描述此前向用户承诺"随会话注入"。
// r49 已把说谎的文案改掉（manifest + 四语言 + 圆心注释里的内核专属 CLI 旗标）。
//
// ## 为什么是"棘轮"而不是"修好它"
//
// 根因修法需要先定一个设计决定（能力轴落在哪一层消费；见文档 §4.2 的 ⚠ 段），
// 不该在审计轮里顺手定。所以本守卫的职责是**让不对称无法静默变化**：
//   · 支持面**变宽**（某内核补上了翻译/补面）→ 红：必须同步更新文档结论与插件描述；
//   · 支持面**变窄**（连唯一支持者也没了）→ 红：那意味着 `systemPrompts` 槽整体失效，
//     而贡献它的插件还在承诺注入；
//   · 新增第五个内核 → 若它不消费，`UNSUPPORTED` 清单要显式加它（当场表态，不许默默漏）。
//
// ⚠ 判据要点：只扫**各内核自己的 backend-factory**（消费点），不扫 application 层
//   （生产点对所有内核一视同仁，扫它只会得到"人人都有"的假对称）。

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const KERNEL_ROOT = join(ROOT, "src/server/kernel");
/** 机制层目录：不是内核，不参与本判据。 */
const NON_KERNEL_DIRS = new Set(["core"]);

/** 当前**唯一**消费 `systemPrompt*` 的内核（r49 实测）。 */
const SUPPORTING = ["pi"];
/** 实测静默忽略的内核（含测试专用的 minimal 与开闭探针 probe4）。 */
const IGNORING = ["dsh", "minimal", "probe4"];

function kernelIds(): string[] {
  return readdirSync(KERNEL_ROOT)
    .filter((d) => !NON_KERNEL_DIRS.has(d) && statSync(join(KERNEL_ROOT, d)).isDirectory())
    .sort();
}

/** 该内核的目录里是否有**生产代码**消费 systemPromptPaths / systemPromptTexts。 */
function consumes(dir: string): boolean {
  const abs = join(KERNEL_ROOT, dir);
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push(full);
    }
  };
  walk(abs);
  return out.some((f) => {
    const src = readFileSync(f, "utf-8");
    // 只看**读取**（`opts.systemPrompt*`），不看注释里的提及
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
    return /opts\.systemPrompt(Paths|Texts)|\bsystemPrompt(Paths|Texts)\s*\?\?/.test(code);
  });
}

/** 该内核是否**声明**了 `BackendCapabilities.systemPrompt: true`。
 *  声明侧与消费侧要分开扫：两者的**一致性**才是本文件最重要的不变量（见 ⑤）。 */
function declaresAxis(dir: string): boolean {
  const abs = join(KERNEL_ROOT, dir, "backend");
  if (!existsSync(abs)) return false;
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push(full);
    }
  };
  walk(abs);
  return out.some((f) => {
    const code = readFileSync(f, "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
    return /systemPrompt\s*:\s*true/.test(code);
  });
}

describe("systemPrompt* 的契约不对称：支持面不得静默变化（棘轮）", () => {
  const ids = kernelIds();
  const actual = ids.filter((id) => consumes(id));

  it("判据不空转：扫到了全部内核目录，且已知事实与清单一致", () => {
    expect(ids.length, `只扫到 ${ids.length} 个内核目录（应 ≥4：pi/dsh/minimal/probe4）`).toBeGreaterThanOrEqual(4);
    expect(ids, "内核目录清单与两份白名单的并集不一致（有内核没被表态）")
      .toEqual([...SUPPORTING, ...IGNORING].sort());
    // 自检：判据必须真能识别"消费"——pi 是唯一支持者，若连它都扫不到，说明正则失效（假绿）
    expect(actual, "自检失败：连已知支持的 pi 都没扫到 ⇒ 判据正则失效").toContain("pi");
  });

  it("① 支持面**恰好**是文档记载的那一份（变宽或变窄都必须同步改文档与插件描述）", () => {
    expect(actual, [
      `消费 systemPrompt* 的内核 = ${JSON.stringify(actual)}，而文档记载 = ${JSON.stringify([...SUPPORTING].sort())}。`,
      `· 变宽（有内核补上了翻译/补面）→ 更新 docs/add-new-kernel.md §4.2 的复核结论、`,
      `  把该内核移出 IGNORING，并检查 goody-hao 的描述是否还需要"取决于内核支持"这句限定；`,
      `· 变窄（连唯一支持者也没了）→ systemPrompts 槽整体失效，而贡献它的插件仍在承诺注入，`,
      `  必须按 §1.5 走显式降级（能力轴 + UI 明示），不能留着静默吞掉。`,
    ].join("\n      ")).toEqual([...SUPPORTING].sort());
  });

  it("② 忽略面里的每个内核都仍被**显式登记**（新增内核必须当场表态，不许默默漏）", () => {
    const unregistered = ids.filter((id) => !SUPPORTING.includes(id) && !IGNORING.includes(id));
    expect(unregistered, `有内核既不在 SUPPORTING 也不在 IGNORING：${unregistered.join(", ")}（请实测它消不消费，再登记进对应清单）`).toEqual([]);
  });

  it("③ 用户可见的文案不得再承诺「无条件注入」，也不得写死某个内核的 CLI 旗标", () => {
    // goody-hao 的 manifest 与四语言描述：这是用户读到承诺的地方
    const files = [
      "src/plugins/system/goody-hao/plugin.json",
      ...["zh-CN", "zh-TW", "en", "de"].map((l) => `src/plugins/system/goody-hao/locales/${l}/plugin.json`),
    ];
    for (const rel of files) {
      const abs = join(ROOT, rel);
      expect(existsSync(abs), `${rel} 不存在`).toBe(true);
      const src = readFileSync(abs, "utf-8");
      expect(src.includes("--append-system-prompt"),
        `${rel} 里仍写死 pi 的 CLI 旗标 --append-system-prompt（内核专属细节不该出现在插件的用户可见文案里）`).toBe(false);
    }
    // 圆心的 roleToPrompt 注释同样不该出现内核专属旗标（§7.1 铁律一）
    const circle = readFileSync(join(ROOT, "packages/shared/src/domain/sessions.ts"), "utf-8");
    const live = circle.split("\n").filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//")).join("\n");
    expect(live.includes("--append-system-prompt"), "圆心**代码**里出现内核专属 CLI 旗标").toBe(false);
  });

  it("④ 生产侧必须保持中性（application 层不得按内核分支决定要不要注入）", () => {
    const store = readFileSync(join(ROOT, "src/server/application/sessions/session-store.ts"), "utf-8");
    const hits = store.split("\n").filter((l) => l.includes("systemPromptTexts:") || l.includes("systemPromptPaths:"));
    expect(hits.length, "session-store 里应仍有中性注入点（若为 0，说明注入被删了，本守卫失去对象）").toBeGreaterThan(0);
    const branched = hits.filter((l) => /kernel\s*===|===\s*["'](pi|dsh|minimal|probe4)["']/.test(l));
    expect(branched, `注入点出现了按内核分支：\n        ${branched.join("\n        ")}\n      那会把不对称焊进 application 层（§7.1 铁律二）`).toEqual([]);
  });

  it("⑤ **声明必须与事实一致**：消费 systemPrompt* 的内核 ⇔ 声明 systemPrompt: true", () => {
    // 这条是 r50 之后本文件最重要的不变量。此前（r49）只有"支持面别静默变化"的棘轮，
    // 因为那时既没有能力轴、也没有 renderer 消费者——不对称是**被容忍**的。
    // r50 把轴与显式降级都落地后，一致性才是真正要守的东西，它同时挡住两种回潮：
    //   · 声明 true 但**不消费** → 假承诺：UI 会说"这个内核支持"，而注入其实没发生；
    //   · 消费但**不声明** → 静默缺面复活：UI 会说"不生效"，而其实生效了（误报），
    //     或者更糟——faces 里没有这一轴，renderer 的三态判断落到"未知"，什么都不说。
    const mismatches = ids
      .map((id) => ({ id, consumes: consumes(id), declares: declaresAxis(id) }))
      .filter((x) => x.consumes !== x.declares);
    expect(mismatches, [
      `声明与事实不一致 ${mismatches.length} 个内核：`,
      ...mismatches.map((m) => `      · ${m.id}: 消费=${m.consumes} 声明=${m.declares}`),
      `      → 消费了就声明 true（否则 renderer 无法据此明示降级）；`,
      `        声明了就必须真消费（否则是假承诺，UI 会说这个内核支持而注入并不发生）。`,
    ].join("\n")).toEqual([]);
  });

  it("⑥ 显式降级链路仍在：轴进了 faces 投影，且 renderer 真有消费者（防『改回静默』）", () => {
    // r49 的根因是「静默缺面」；r50 的修法是「能力轴 + renderer 明示」。
    // 这条钉住后者不被悄悄拆掉——拆掉就等于把缺陷改回原样，而 ①②③④ 全都察觉不到
    // （它们只看支持面与文案，不看有没有人告诉用户）。
    const contract = readFileSync(join(ROOT, "packages/shared/src/domain/backend.ts"), "utf-8");
    expect(/systemPrompt\?:\s*boolean/.test(contract),
      "圆心契约里的 systemPrompt 轴不见了（renderer 就无从判断，退化回静默缺面）").toBe(true);
    const renderer = readFileSync(
      join(ROOT, "src/plugins/manager/plugin-manager/renderer/index.tsx"), "utf-8");
    expect(renderer.includes("faces?.systemPrompt"),
      "插件管理页不再读 faces.systemPrompt ⇒ 显式降级被拆掉了").toBe(true);
    expect(renderer.includes("data-plugin-systemprompt-inert"),
      "降级提示的锚点不见了（e2e 就验不到它，见 minimal-smoke 的「插件页的 systemPrompts 降级提示」段）").toBe(true);
  });
});
