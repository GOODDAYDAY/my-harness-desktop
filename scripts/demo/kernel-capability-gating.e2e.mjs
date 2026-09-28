#!/usr/bin/env node
// 共享组件的**能力门控** e2e —— 三个内核同等地位、按各自声明降级。
//
// 覆盖两个面（都是"pi/dsh/minimal 共用一个组件"的形态）：
//   ① 模型配置页 `ModelConfigPage`：devRole / reasoning 两个控件按 `KernelModelsCapabilities` 门控；
//   ② 扩展页 `KernelExtensionsPage`：安装区块按 `KernelExtensionCapabilities.install` 门控。
// 第 ② 面是 r46 补的：minimal 的内核插件系统第一版未落地（install 直接返回失败），
// 而共享页此前**不读能力面**，于是 minimal 的扩展页上有一个完整可用的安装表单——
// 用户填完来源、点安装、等一轮，才在事后看到「不支持安装拓展」（§7.6 该显式降级却没降级）。
// 更糟的是 `minimal-extension.ts` 的文件头注释写着「壳据此置灰入口」，而壳从来没读过
// capabilities：**注释描述了一个不存在的行为**。
//
// 被守的缺陷（r44）：`ModelConfigPage` 是 pi / dsh / minimal **共用**的组件，
// 而「developer role 不兼容」勾选框写的 `supportsDeveloperRole` **只有 pi 消费**
// （`kernel/pi/model/models-config.ts` 的 `compat.supportsDeveloperRole`）。它此前无条件渲染，
// 于是 dsh / minimal 的模型页上有一个勾了也没任何作用的开关（§7.6 该显式降级却没降级）。
// 修法：中立契约 `KernelModelsCapabilities` 加 `developerRole` 轴（**必填**，漏声明 = 编译错），
// 三内核各自声明（pi true / dsh false / minimal false），控件按它门控。
//
// 为什么单测不够、还要这条 e2e：单测能证明"组件按 capabilities 门控"，但证明不了
// **三个内核插件各自声明的值真的传到了组件**（那是 manifest/renderer → 发布面 → 组件的接线）。
// r44 只有单测级证据，本剧本把真机那一半补上。
//
// ⚠ 两条判据纪律（都是 r44 实踩过的坑）：
//   ① **空页面的负结果不是证据**：隔离 HOME 里 dsh/minimal 原本没有模型配置，
//      页面基本是空的 ⇒ "没看到 devRole 控件" 什么也证明不了。所以本剧本先用
//      `seedDshModels` / `seedMinimalModels` 播种，再断言**播种的模型名确实出现在页面上**
//      （反空转），然后才断言控件的有无。
//   ② **设置页的 pane 挂载后不卸载**（非激活只是 display:none），document 级查询会被
//      之前访问过的 pane 污染 ⇒ 一律限定到当前**可见**的 `[role=tabpanel]`。
//
// 零 token：不进会话、不发消息、不测连通性（播种用的是不可达的假 baseURL）。
//
// 用法: npm run build && node scripts/demo/model-capability-gating.e2e.mjs [--port 9470] [--keep]
import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, killApp } from "./lib/app.mjs";
import { makeRunRoot, setupBaseline } from "./lib/home.mjs";
import { seedTestPlugins } from "./lib/test-plugins.mjs";
import { seedDshModels, seedMinimalModels } from "./lib/seed/kernel-models.mjs";
import { waitForDomIdle } from "./lib/util.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const { values: args } = parseArgs({ options: { port: { type: "string", default: "9470" }, keep: { type: "boolean", default: false } } });

let passed = 0;
function ok(cond, label, detail) {
  if (!cond) throw new Error(`断言失败: ${label}${detail !== undefined ? `（现场：${JSON.stringify(detail)?.slice(0, 260)}）` : ""}`);
  passed += 1;
  console.log(`  ✓ ${label}`);
}

const runRoot = makeRunRoot();
const home = join(runRoot, "zh-CN");
mkdirSync(home, { recursive: true });
const ctx = setupBaseline({ home, realHome: homedir(), locale: "zh-CN" });
seedTestPlugins(ctx.dataRoot);
const projectDir = join(home, "project");
mkdirSync(projectDir, { recursive: true });
const prefsFile = join(ctx.configDir, "config.json");
writeFileSync(prefsFile, JSON.stringify({ ...JSON.parse(readFileSync(prefsFile, "utf-8")), lastCwd: projectDir }, null, 2));

// 播种：让 dsh 与 minimal 的模型页**非空**（否则"控件不存在"的断言恒真）
const dshSeed = seedDshModels(home);
const minSeed = seedMinimalModels(home);
console.log(`  · 已播种 dsh：${dshSeed.providerId} / ${dshSeed.models.map((m) => m.name ?? m.id).join(", ")}`);
console.log(`  · 已播种 minimal：${minSeed.providerId} / ${minSeed.models.map((m) => m.name ?? m.id).join(", ")}`);

const app = await launchApp({ appDir: ROOT, port: Number(args.port), env: { HOME: home, MHD_PORT: "18431" }, timeoutMs: 90000 });
const page = app.page;
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

/** 打开设置页 → 某内核条目 → 它的模型 TAB，并把查询限定到**可见的** tabpanel。 */
const gotoModelsTab = async (entryId, tabId) => {
  await page.evaluate((e) => [...document.querySelectorAll("[data-settings-id]")].find((x) => x.getAttribute("data-settings-id") === e)?.click(), entryId);
  await waitForDomIdle(page, { quietMs: 700, timeoutMs: 12000 }).catch(() => {});
  await page.evaluate((t) => document.querySelector(`[data-settings-tab="${t}"]`)?.click(), tabId);
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 15000 }).catch(() => {});
  return page.evaluate((t) => {
    const panes = [...document.querySelectorAll("[role=tabpanel]")];
    // ⚠ 只看**可见**的那个 pane：设置页的 pane 挂载后不卸载（非激活只是 display:none），
    //   document 级查询会把之前访问过的 pane 一并算进来（r44 实踩）。
    const pane = panes.find((p) => getComputedStyle(p).display !== "none" && p.id === `settings-tabpanel-${t}`) ?? null;
    if (!pane) return { paneFound: false };
    const text = pane.innerText ?? "";
    return {
      paneFound: true,
      paneId: pane.id,
      textLen: text.replace(/\s+/g, "").length,
      checkboxes: pane.querySelectorAll('input[type="checkbox"]').length,
      devRole: pane.querySelectorAll("[data-model-devrole]").length,
      reasoning: pane.querySelectorAll("[data-model-reasoning]").length,
      text: text.slice(0, 400),
      // ⚠ 反空转探针必须**连 input 的 value 一起看**：模型名/id 是渲染成 `<input value=…>` 的，
      //   而 `innerText` 不含 input 的值 —— 首版就是因此把"页面明明有 2 个模型行"判成
      //   "播种的模型没渲染出来"（假红，而且是反空转断言自己报的，最容易让人怀疑播种失败）。
      inputValues: [...pane.querySelectorAll("input")].map((i) => i.value).filter(Boolean).slice(0, 40),
    };
  }, tabId);
};

try {
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 1000, timeoutMs: 25000 });
  await page.evaluate(() => document.querySelector('[data-sidebar-entry="settings"]')?.click());
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 15000 }).catch(() => {});

  // 期望值来自三个内核插件 renderer 里的**声明**（capabilities={{ reasoning, developerRole }}）
  const CASES = [
    { entry: "pi", tab: "pi-models", reasoning: true, developerRole: true, seededNames: null },
    { entry: "dsh", tab: "dsh-models", reasoning: true, developerRole: false, seededNames: dshSeed.models.map((m) => m.name ?? m.id) },
    { entry: "minimal", tab: "minimal-models", reasoning: false, developerRole: false, seededNames: minSeed.models.map((m) => m.name ?? m.id) },
  ];

  for (const c of CASES) {
    console.log(`\n── ${c.entry} / ${c.tab} ──`);
    const r = await gotoModelsTab(c.entry, c.tab);
    ok(r.paneFound, `${c.entry}：模型 TAB 的面板已渲染（role=tabpanel 且可见）`);
    console.log(`  · pane=${r.paneId} 文案量=${r.textLen} 复选框=${r.checkboxes} devRole=${r.devRole} reasoning=${r.reasoning}`);
    // ★ 反空转：先证明这一页**真的有模型数据**，否则下面的"控件不存在"毫无意义
    if (c.seededNames) {
      const hay = `${r.text ?? ""}\n${(r.inputValues ?? []).join("\n")}`;
      const found = c.seededNames.filter((n) => hay.includes(n));
      ok(found.length === c.seededNames.length,
        `${c.entry}：播种的模型确实渲染出来了（${found.length}/${c.seededNames.length}）——否则"控件不存在"是空页面造成的假绿`,
        { found, want: c.seededNames, textHead: (r.text ?? "").slice(0, 160) });
    } else {
      ok(r.checkboxes > 0, `${c.entry}：页面非空（有 ${r.checkboxes} 个复选框；pi 的模型来自 setupBaseline 复制的真实 ~/.pi）`);
    }
    // 门控本体
    ok((r.devRole > 0) === c.developerRole,
      `${c.entry}：devRole 控件${c.developerRole ? "**应在**（该内核消费 supportsDeveloperRole）" : "**不该在**（没有消费者，勾了也没作用）"}（实际 ${r.devRole} 个）`);
    ok((r.reasoning > 0) === c.reasoning,
      `${c.entry}：reasoning 控件${c.reasoning ? "应在" : "不该在"}（声明 reasoning=${c.reasoning}；实际 ${r.reasoning} 个）`);
  }

  // ── 面②：扩展页的安装区块 ──
  console.log("\n── 扩展页安装区块的能力门控 ──");
  const EXT = [
    { entry: "pi", tab: "pi-ext", canInstall: true },
    { entry: "dsh", tab: "dsh-ext", canInstall: true },
    { entry: "minimal", tab: "minimal-ext", canInstall: false },
  ];
  for (const e of EXT) {
    await page.evaluate((id) => [...document.querySelectorAll("[data-settings-id]")].find((x) => x.getAttribute("data-settings-id") === id)?.click(), e.entry);
    await waitForDomIdle(page, { quietMs: 700, timeoutMs: 12000 }).catch(() => {});
    await page.evaluate((t) => document.querySelector(`[data-settings-tab="${t}"]`)?.click(), e.tab);
    await waitForDomIdle(page, { quietMs: 900, timeoutMs: 12000 }).catch(() => {});
    const r = await page.evaluate((t) => {
      const pane = [...document.querySelectorAll("[role=tabpanel]")].find((p) => getComputedStyle(p).display !== "none" && p.id === `settings-tabpanel-${t}`);
      if (!pane) return { paneFound: false };
      const unsup = pane.querySelector("[data-ext-install-unsupported]");
      return {
        paneFound: true,
        // 安装表单的特征：来源输入框 + 安装按钮
        hasSourceInput: !!pane.querySelector('input[type="text"], input:not([type])'),
        notice: unsup ? (unsup.textContent || "").replace(/\s+/g, " ").trim() : null,
        textLen: (pane.innerText || "").replace(/\s+/g, "").length,
      };
    }, e.tab);
    ok(r.paneFound, `${e.entry}：扩展 TAB 的面板已渲染且可见`);
    console.log(`  · [${e.entry}] 安装输入框=${r.hasSourceInput} 降级说明=${JSON.stringify((r.notice ?? "").slice(0, 40))} 文案量=${r.textLen}`);
    ok(r.textLen > 20, `${e.entry}：扩展页非空（反空转：文案量 ${r.textLen}）`);
    if (e.canInstall) {
      ok(r.hasSourceInput, `${e.entry} 声明 install=true ⇒ 应有安装表单`);
      ok(r.notice === null, `${e.entry} 不该出现"不支持安装"的降级说明（它有这个能力）`);
    } else {
      ok(!r.hasSourceInput, `${e.entry} 声明 install=false ⇒ **不该给安装表单**（给了就是让用户填完再事后失败）`);
      ok(!!r.notice && r.notice.length > 10,
        `${e.entry}：应有**显式降级说明**而不是整块静默消失（§7.6；实际 ${JSON.stringify(r.notice)}）`);
      ok(/不支持|没有提供/.test(r.notice ?? ""), `降级说明要讲清原因（实际 ${JSON.stringify((r.notice ?? "").slice(0, 60))}）`);
    }
  }

  // 跨内核对照：门控不是"全关"或"全开"，而是**逐内核按声明**
  console.log("\n── 跨内核对照 ──");
  const pi = await gotoModelsTab("pi", "pi-models");
  const dsh = await gotoModelsTab("dsh", "dsh-models");
  ok(pi.devRole > 0 && dsh.devRole === 0,
    `同一个共享组件在两个内核下呈现不同（pi 有 devRole=${pi.devRole}、dsh 无=${dsh.devRole}）⇒ 门控真的按内核声明生效，不是写死`);

  ok(pageErrors.length === 0, `页面零报错（实际 ${pageErrors.length} 条${pageErrors.length ? ": " + pageErrors.slice(0, 2).join(" | ").slice(0, 160) : ""}）`);
} catch (err) {
  console.error(`\n❌ FAIL: ${err.message}`);
  await page.screenshot({ path: join(runRoot, "failure.png") }).catch(() => {});
  process.exitCode = 1;
} finally {
  await killApp(app);
}

console.log(`\n✅ PASS: ${passed} 项断言（共享组件能力门控：模型配置页 + 扩展页，三内核真机对照，页面均非空）`);
console.log(`   隔离 HOME: ${home}${args.keep ? "（--keep 保留）" : ""}`);
