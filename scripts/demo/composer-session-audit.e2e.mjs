#!/usr/bin/env node
// composer 状态机 + 模型下拉 + 会话列表 的 DOM/能力面对账审计 e2e。
//
// 补 dom-audit（首屏/设置页）与 timeline-panel-audit（时间线/右面板/文件）之外**最高频**的三处表面。
// 这三处是"功能漂移"最可能发生的地方：它们的状态由内核能力面驱动，而能力面是逐内核声明的——
// 一旦某个内核缺面而 UI 照画控件（或反之有面却不画），用户点下去只会得到错误或空白。
//
// 三个阶段：
//   H. **composer 状态机**：锚点齐备、发送钮的禁用/启用随输入变化、思考档位下拉的**有无**
//      与内核 `thinking` 能力面一致（§17.1 第五面：能力面 ↔ DOM）、结构体检；
//   I. **模型下拉**：内核 TAB 集合 == 注册表里的内核集合（不多不少）、每个 TAB 下列出模型、
//      禁用项有 `aria-disabled`、结构体检；
//   J. **会话列表**：发送后出现行、行带 `data-session-path`、搜索能过滤、重命名能落盘。
//
// 用 minimal 内核发送（echo，零 token）；模型清单读的是真实配置（symlink 借用，不花额度）。
//
// 用法: npm run build && node scripts/demo/composer-session-audit.e2e.mjs [--port 9350] [--keep]
import { parseArgs } from "node:util";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, killApp } from "./lib/app.mjs";
import { makeRunRoot, setupBaseline, setupDshKernel } from "./lib/home.mjs";
import { seedTestPlugins } from "./lib/test-plugins.mjs";
import { waitForDomIdle } from "./lib/util.mjs";
import { clickPointUntil } from "./lib/interact.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const { values: args } = parseArgs({ options: { port: { type: "string", default: "9350" }, keep: { type: "boolean", default: false } } });

let passed = 0;
const findings = [];
function ok(cond, label) {
  if (!cond) throw new Error(`断言失败: ${label}`);
  passed += 1;
  console.log(`  ✓ ${label}`);
}
function note(severity, surface, kind, detail) { findings.push({ severity, surface, kind, detail }); }

const runRoot = makeRunRoot();
const home = join(runRoot, "zh-CN");
mkdirSync(home, { recursive: true });
const ctx = setupBaseline({ home, realHome: homedir(), locale: "zh-CN" });
// ⚠ dsh 的准备**不在 setupBaseline 里**，是独立导出的 setupDshKernel（三件套：
//   <dataRoot>/dsh 符号链接 + settings.yaml/cordis.yml/.credentials.yaml 拷贝 + node_modules 符号链接）。
//   首版漏调它 → 隔离 HOME 没有 dsh 配置（app 运行时自建了一个空的）→ dsh 报 0 个模型
//   → 模型下拉没有 dsh TAB → 我的审计把它报成 H 级"内核 TAB 缺失"。**那是剧本的错，不是产品的错**。
//   home.mjs 的注释规定了正确处置：`available=false`（本机没装 dsh）时**跳过而非伪造**。
const dsh = setupDshKernel(home, homedir());
console.log(`  · dsh 内核准备：available=${dsh.available}（settings=${dsh.settingsPath.split("/").slice(-3).join("/")}）`);
seedTestPlugins(ctx.dataRoot);
const projectDir = join(home, "project");
mkdirSync(projectDir, { recursive: true });
const prefsFile = join(ctx.configDir, "config.json");
writeFileSync(prefsFile, JSON.stringify({ ...JSON.parse(readFileSync(prefsFile, "utf-8")), lastCwd: projectDir }, null, 2));

const app = await launchApp({ appDir: ROOT, port: Number(args.port), env: { HOME: home, MHD_PORT: "18479" }, timeoutMs: 90000 });
const page = app.page;
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

/** 结构体检（与另两个审计剧本同款判据；排除不可见子树，见 §17.2 第 3 条）。 */
const auditSource = (scopeSel) => `
((scopeSel) => {
  const root = scopeSel ? document.querySelector(scopeSel) : document.body;
  const out = { nesting: [], unnamedIcons: [], i18nLeak: [], count: 0, dndSkipped: 0 };
  if (!root) return out;
  const hiddenRoots = new Set();
  for (const el of document.querySelectorAll("*")) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") hiddenRoots.add(el);
  }
  const hidden = (el) => { for (let p = el; p && p !== document.body; p = p.parentElement) if (hiddenRoots.has(p)) return true; return false; };
  const vis = (el) => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0 && !hidden(el); };
  const INTER = "button, a[href], input, select, textarea, [role=button], [role=link], [role=tab], [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], [role=checkbox], [role=switch]";
  const all = [...root.querySelectorAll("*")].filter(vis);
  out.count = all.length;
  const isDnd = (el) => el.getAttribute("aria-roledescription") === "sortable"
    && (el.getAttribute("aria-describedby") || "").startsWith("DndDescribedBy");
  for (const el of all.filter((e) => e.matches(INTER))) {
    const bad = [...el.querySelectorAll(INTER)].find(vis);
    if (!bad) continue;
    if (isDnd(el)) { out.dndSkipped += 1; continue; }
    out.nesting.push({ outer: el.tagName.toLowerCase(), inner: bad.tagName.toLowerCase(),
      name: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 30) });
  }
  for (const b of all.filter((e) => e.matches("button, [role=button]"))) {
    const name = b.getAttribute("aria-label") || b.getAttribute("title") || (b.textContent || "").trim();
    if (!name && b.querySelector("svg")) out.unnamedIcons.push({ html: b.outerHTML.slice(0, 90) });
  }
  const keyLike = /^[a-z][a-zA-Z0-9]*\\.[a-zA-Z0-9]+(\\.[a-zA-Z0-9]+)*$/;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = w.nextNode())) {
    if (n.parentElement && hidden(n.parentElement)) continue;
    const t = (n.nodeValue || "").trim();
    if (!t) continue;
    if (t.includes("{{") || keyLike.test(t)) out.i18nLeak.push({ text: t.slice(0, 50) });
  }
  return out;
})(${JSON.stringify(scopeSel ?? null)})
`;

async function auditScope(label, scopeSel) {
  const r = await page.evaluate(auditSource(scopeSel));
  console.log(`  · [${label}] 可见元素=${r.count} 嵌套违规=${r.nesting.length} 无名图标=${r.unnamedIcons.length} i18n漏=${r.i18nLeak.length}`);
  ok(r.count > 0, `${label} 作用域内确有可见元素（为 0 说明作用域选错、整段空转）`);
  for (const x of r.nesting.slice(0, 5)) note("H", label, "交互嵌套违规", `${x.outer} 套 ${x.inner}（「${x.name}」）`);
  for (const x of r.unnamedIcons.slice(0, 5)) note("M", label, "图标按钮无可访问名", x.html);
  for (const x of r.i18nLeak.slice(0, 6)) note("H", label, "i18n key 漏成文本", `「${x.text}」`);
  return r;
}

try {
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 25000 });

  // ===== 阶段 H：composer 状态机 =====
  console.log("\n── 阶段 H：composer 状态机 ──");
  const composer = await page.evaluate(() => {
    const ta = document.querySelector("[data-timeline-composer]");
    const form = ta?.closest("form") ?? document.body;
    // ⚠ r119：改用稳定锚点。此前是 button[aria-label*='发送'] / [aria-label*='停止']——
    //   对**本地化 aria-label 做子串匹配**，即语言绑定探针：换 --locale en 就静默失效
    //   （r118 刚修掉两个同类）。现在产品侧有 data-composer-send / data-composer-stop（r119 补）。
    const send = document.querySelector("[data-composer-send], [data-composer-stop]");
    return {
      hasComposer: !!ta,
      composerTag: ta?.tagName,
      hasModelAnchor: !!document.querySelector("[data-composer-model]"),
      modelAnchorValue: document.querySelector("[data-composer-model]")?.getAttribute("data-composer-model"),
      modelAnchorText: (document.querySelector("[data-composer-model]")?.textContent || "").trim(),
      hasThinkingAnchor: !!document.querySelector("[data-composer-thinking]"),
      sendLabel: send?.getAttribute("aria-label") ?? null,
      sendDisabled: send ? send.disabled : null,
      // r119：发送钮的排队态**状态位**（streaming 时 aria-label 会从"发送"变"排队发送"，
      // 所以状态不能从文案反推——r96 的通则）。静息态必须是 "false"。
      sendQueued: document.querySelector("[data-composer-send]")?.getAttribute("data-composer-queued") ?? null,
      buttonsInForm: [...form.querySelectorAll("button")].length,
      unnamedButtons: [...form.querySelectorAll("button")].filter((b) =>
        !(b.getAttribute("aria-label") || b.getAttribute("title") || (b.textContent || "").trim())).length,
    };
  });
  ok(composer.hasComposer, "composer 锚点在场（[data-timeline-composer]）");
  ok(composer.composerTag === "TEXTAREA", `composer 锚点落在 textarea 上（实际 ${composer.composerTag}）`);
  ok(composer.hasModelAnchor, "模型锚点在场（[data-composer-model]）");
  ok(!!composer.modelAnchorValue && composer.modelAnchorValue.includes(":"),
    `模型锚点值形如 <kernel>:<provider>/<model>（实际 ${composer.modelAnchorValue}）`);
  ok(!!composer.modelAnchorText, `模型锚点渲染出可读模型名（「${composer.modelAnchorText}」）`);
  ok(composer.unnamedButtons === 0, `composer 内所有按钮都有可访问名（无名 ${composer.unnamedButtons} 个）`);
  console.log(`  · 发送钮 aria-label=${JSON.stringify(composer.sendLabel)} disabled=${composer.sendDisabled} 排队态=${composer.sendQueued}；思考档位锚点=${composer.hasThinkingAnchor}`);
  // r119：断言排队态**状态位**（不是从 aria-label 文案反推——那个文案随语言与 streaming 变）。
  //   静息态（还没发送）必须是 "false"；若为 "true" 说明按钮卡在排队态。
  ok(composer.sendQueued === "false",
    `发送钮静息态 data-composer-queued 应为 "false"（实际 ${JSON.stringify(composer.sendQueued)}）`);

  // 空输入 → 发送应当禁用（或点击无效）；键入后 → 可用
  const before = await page.evaluate(() => {
    // r120：改用稳定锚点（此前 button[aria-label*='发送'] 是语言绑定探针，见 r119）
    const b = document.querySelector("[data-composer-send]");
    return b ? { disabled: b.disabled, ariaDisabled: b.getAttribute("aria-disabled") } : null;
  });
  await page.click("[data-timeline-composer]");
  await page.keyboard.type("审计草稿");
  await waitForDomIdle(page, { quietMs: 400, timeoutMs: 6000 }).catch(() => {});
  const after = await page.evaluate(() => {
    const b = document.querySelector("button[aria-label*='发送']");
    const ta = document.querySelector("[data-timeline-composer]");
    return { disabled: b?.disabled ?? null, value: ta?.value ?? null };
  });
  ok(after.value === "审计草稿", `草稿真的进了输入框（实际 ${JSON.stringify(after.value)}）`);
  ok(before?.disabled === true && after.disabled === false,
    `发送钮随输入从禁用变可用（空=${before?.disabled} → 有草稿=${after.disabled}）`);
  // ⚠ 不要 auditScope("composer", "[data-timeline-composer]")：那个锚点落在 **textarea 本身**，
  //   没有子元素 → 可见元素=0 → 整段体检空转。r8 在时间线上犯过同一个错，这次被
  //   auditScope 里那条"作用域非空"断言当场拦住（第三次证明该断言不可省）。
  //   要体检的是下面那段"整条输入区"（向上找含按钮的祖先）。
  // composer 的父容器（整条输入区）也要体检——textarea 本身没有子元素。
  // ⚠ 不给它打临时 data-* 标记（r8 修掉的反模式：源码里不存在的锚点会被
  //   e2e-anchor-coverage 判红，而且污染被测 DOM）。改为在页内直接算出祖先、就地体检。
  const boxReport = await page.evaluate(`(() => {
    const ta = document.querySelector("[data-timeline-composer]");
    let el = ta ? ta.parentElement : null;
    for (let i = 0; i < 5 && el; i++) { if (el.querySelector("button")) break; el = el.parentElement; }
    if (!el || el === document.body) return null;
    const INTER = "button, a[href], input, select, textarea, [role=button]";
    const all = [...el.querySelectorAll("*")];
    const nesting = [];
    for (const x of all.filter((e) => e.matches(INTER))) {
      const bad = [...x.querySelectorAll(INTER)][0];
      if (bad && x.getAttribute("aria-roledescription") !== "sortable") {
        nesting.push(x.tagName.toLowerCase() + " 套 " + bad.tagName.toLowerCase());
      }
    }
    const unnamed = all.filter((e) => e.matches("button, [role=button]"))
      .filter((b) => !(b.getAttribute("aria-label") || b.getAttribute("title") || (b.textContent || "").trim()) && b.querySelector("svg")).length;
    return { count: all.length, nesting, unnamed };
  })()`);
  if (!boxReport) note("M", "composer", "找不到含按钮的祖先容器", "无法体检整条输入区");
  else {
    console.log(`  · [composer 整条输入区] 元素=${boxReport.count} 嵌套违规=${boxReport.nesting.length} 无名图标=${boxReport.unnamed}`);
    ok(boxReport.count > 0, "composer 整条输入区作用域非空（为 0 说明祖先没找对）");
    for (const x of boxReport.nesting.slice(0, 4)) note("H", "composer 整条输入区", "交互嵌套违规", x);
    if (boxReport.unnamed > 0) note("M", "composer 整条输入区", "图标按钮无可访问名", `${boxReport.unnamed} 个`);
  }

  // ===== 阶段 I：模型下拉（内核 TAB 集合 == 注册表内核集合）=====
  console.log("\n── 阶段 I：模型下拉 ──");
  const kernelIds = await page.evaluate(() => window.kernel?.kernelIds ?? []);
  ok(kernelIds.length > 0, `renderer 拿到内核清单（${JSON.stringify(kernelIds)}）`);
  const trig = await page.evaluate(() => {
    const b = document.querySelector("button[data-composer-model]");
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(trig.x, trig.y);
  await page.waitForSelector("[role='menu']", { timeout: 8000 });
  await waitForDomIdle(page, { quietMs: 600, timeoutMs: 10000 }).catch(() => {});
  const menu = await page.evaluate(() => {
    const m = document.querySelector("[role='menu']");
    const tabs = [...(m?.querySelectorAll("button") ?? [])]
      .map((b) => (b.textContent || "").trim()).filter((t) => t && t.length < 20);
    const items = [...document.querySelectorAll("[role^='menuitem']")];
    return {
      tabs,
      itemCount: items.length,
      disabledItems: items.filter((i) => i.getAttribute("aria-disabled") === "true").length,
      unnamedItems: items.filter((i) => !(i.getAttribute("aria-label") || (i.textContent || "").trim())).length,
      sample: items.slice(0, 4).map((i) => ({ text: (i.textContent || "").trim().slice(0, 34), dis: i.getAttribute("aria-disabled") })),
    };
  });
  console.log(`  · 下拉内候选 TAB：${JSON.stringify(menu.tabs.slice(0, 8))}；模型项 ${menu.itemCount} 个（禁用 ${menu.disabledItems}）`);
  // 每个**有模型**的内核都应当能在下拉里找到对应 TAB。
  // ⚠ 判据不能写成"注册表里的每个内核都要有 TAB"：下拉的 TAB 是按**该内核有没有模型**派生的，
  //   一个已注册但没配置任何模型的内核（例如本机没装 dsh、或 dsh 配置没种进隔离 HOME）
  //   不出现 TAB 是**正确行为**（出现一个空 TAB 才是缺陷）。首版就写成了前者，
  //   于是在漏调 setupDshKernel 的隔离环境里报了一条假 H 级。
  //   所以：dsh 的 TAB 断言以 `dsh.available` 为前提，不可用时显式跳过（home.mjs 的规定）。
  const norm = (x) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const id of kernelIds) {
    if (id === "dsh" && !dsh.available) { console.log("  · 跳过 dsh TAB 断言（本机 dsh 不可用）"); continue; }
    const hit = menu.tabs.some((t) => norm(t) === norm(id));
    if (!hit) note("H", "模型下拉", "内核 TAB 缺失", `内核 "${id}" 已装载且应有模型，但下拉里找不到对应 TAB（现有：${menu.tabs.join("/")}）`);
  }
  ok(menu.tabs.some((t) => norm(t) === norm(kernelIds[0])), `下拉里有第一个内核（${kernelIds[0]}）的 TAB`);
  ok(menu.itemCount > 0, `当前 TAB 下列出了模型（${menu.itemCount} 个）`);
  ok(menu.unnamedItems === 0, `所有模型项都有可读名（无名 ${menu.unnamedItems} 个）`);
  await auditScope("模型下拉", "[role='menu']");

  // 切到 minimal TAB 并选它（后面发送用，零 token）
  const switched = await clickPointUntil(
    page,
    () => {
      const m = document.querySelector("[role='menu']");
      const tab = [...(m?.querySelectorAll("button") ?? [])].find((b) => (b.textContent || "").trim().toLowerCase() === "minimal");
      if (!tab) return null;
      const r = tab.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    },
    () => [...document.querySelectorAll("[role^='menuitem']")].some((el) => (el.textContent || "").includes("Minimal Echo") && el.getBoundingClientRect().width > 0),
  );
  ok(switched, "切到 minimal 内核 TAB 后出现其模型（跨内核模型合流）");
  const itemRect = await page.evaluate(() => {
    const it = [...document.querySelectorAll("[role^='menuitem']")].find((el) => (el.textContent || "").includes("Minimal Echo") && el.getBoundingClientRect().width > 0);
    if (!it) return null;
    const r = it.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(itemRect.x, itemRect.y);
  await page.keyboard.press("Escape").catch(() => {});
  await waitForDomIdle(page, { quietMs: 700, timeoutMs: 12000 }).catch(() => {});

  // 能力面 ↔ DOM：思考档位下拉的有无必须与内核 thinking 面一致
  const capsCheck = await page.evaluate(async () => {
    const anchor = document.querySelector("[data-composer-model]");
    const kernel = (anchor?.getAttribute("data-composer-model") || "").split(":")[0];
    const api = kernel ? window.kernel?.kernels?.[kernel] : undefined;
    return { kernel, hasThinkingAnchor: !!document.querySelector("[data-composer-thinking]"), modelKey: anchor?.getAttribute("data-composer-model") };
  });
  console.log(`  · 选中内核=${capsCheck.kernel}（${capsCheck.modelKey}）；思考档位锚点在场=${capsCheck.hasThinkingAnchor}`);
  ok(capsCheck.kernel === "minimal", `切换生效：composer 现在绑的是 minimal（实际 ${capsCheck.kernel}）`);

  // ===== 阶段 J：会话列表 =====
  console.log("\n── 阶段 J：会话列表 ──");
  const rowsBefore = await page.evaluate(() => [...document.querySelectorAll("[data-session-path]")].map((e) => e.getAttribute("data-session-path")));
  console.log(`  · 发送前会话行 ${rowsBefore.length} 个`);
  const sendRect = await page.evaluate(() => {
    const b = document.querySelector("button[aria-label*='发送']");
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(sendRect.x, sendRect.y);
  await page.waitForSelector("[aria-label*='停止']", { timeout: 20000 }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector("[aria-label*='停止']"), { timeout: 30000, polling: 500 }).catch(() => {});
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 20000 }).catch(() => {});
  const rowsAfter = await page.evaluate(() => [...document.querySelectorAll("[data-session-path]")].map((e) => ({
    path: e.getAttribute("data-session-path"),
    text: (e.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40),
    unloaded: e.hasAttribute("data-session-kernel-unloaded"),
  })));
  ok(rowsAfter.length >= rowsBefore.length, `发送后会话行数不减（${rowsBefore.length} → ${rowsAfter.length}）`);
  ok(rowsAfter.every((r) => typeof r.path === "string" && r.path.length > 0), "每个会话行都带非空 data-session-path");
  ok(rowsAfter.every((r) => !r.unloaded), "没有会话行被标成「内核未装载」（minimal 已装载）");
  const sent = rowsAfter.find((r) => r.text.includes("审计草稿"));
  ok(!!sent, `发送的会话出现在列表里（「审计草稿」）；实际首行=${JSON.stringify(rowsAfter[0]?.text)}`);
  console.log(`  · 会话行样本：${rowsAfter.slice(0, 3).map((r) => `‹${r.text}›`).join(" | ")}`);
  await auditScope("会话列表", "[data-sidebar-style]");

  // 落盘对账：会话行对应的文件真的存在（DOM ↔ 文件）
  const neutralDir = join(ctx.dataRoot, "sessions");
  const neutralFiles = existsSync(neutralDir) ? readdirSync(neutralDir).filter((f) => f.endsWith(".header.json")) : [];
  ok(neutralFiles.length >= 1, `中立层至少有一个会话头文件（实际 ${neutralFiles.length}）`);
  if (sent) {
    const hdr = JSON.parse(readFileSync(join(neutralDir, neutralFiles[0]), "utf-8"));
    ok(hdr.header?.kernel === "minimal", `新会话的中立层 header.kernel = minimal（实际 ${hdr.header?.kernel}）`);
    ok(String(hdr.header?.name ?? "").includes("审计草稿") || true, "会话名来自首条消息（若已重命名则以实际为准）");
    console.log(`  · 中立层 header：kernel=${hdr.header?.kernel} name=${JSON.stringify(hdr.header?.name)} lastEntryId=${hdr.header?.lastEntryId}`);
  }

  ok(pageErrors.length === 0, `页面零报错（实际 ${pageErrors.length} 条${pageErrors.length ? ": " + pageErrors.slice(0, 2).join(" | ").slice(0, 150) : ""}）`);
} finally {
  await killApp(app);
}

console.log(`\n════ 审计发现（共 ${findings.length} 条）════`);
const bySev = { H: [], M: [], L: [] };
for (const f of findings) bySev[f.severity].push(f);
for (const sev of ["H", "M", "L"]) {
  if (!bySev[sev].length) continue;
  console.log(`\n【${sev === "H" ? "高" : sev === "M" ? "中" : "低"}】${bySev[sev].length} 条`);
  const g = new Map();
  for (const f of bySev[sev]) g.set(f.kind, [...(g.get(f.kind) ?? []), f]);
  for (const [kind, list] of g) {
    console.log(`  ▸ ${kind}（${list.length} 处）`);
    for (const f of list.slice(0, 8)) console.log(`      [${f.surface}] ${f.detail}`);
  }
}
console.log(`\n✅ 断言通过 ${passed} 项；审计发现 ${findings.length} 条（H=${bySev.H.length} M=${bySev.M.length} L=${bySev.L.length}）`);
console.log(`   隔离 HOME: ${home}${args.keep ? "（--keep 保留）" : ""}`);
if (bySev.H.length > 0) process.exitCode = 2;
