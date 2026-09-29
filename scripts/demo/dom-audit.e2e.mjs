#!/usr/bin/env node
// DOM 组装 + 文件格式对应 + 功能漂移 的实地审计 e2e。
//
// 为什么需要这个剧本：既有 46 个剧本都是「某个功能路径通不通」的正向验证，
// 没有一个回答用户点名的三类问题——
//   ① **DOM 是否混乱**：交互元素嵌套违规、锚点重复、空壳容器、i18n key 漏成可见文本、
//      图标按钮无可访问名、图片无 alt、标题层级跳级；
//   ② **文件是否对应 / 格式是否对应**：壳写出去的会话文件与配置，字段是否就是读它的那份代码所期望的；
//   ③ **功能是否漂移**：DOM 呈现的能力与内核 `capabilities` 声明是否一致（缺面的内核不该长出控件）。
//
// 这三类的共同特征是**静默**：功能路径照样通、页面照样不报错，但结构已经坏了。
// 正向剧本抓不到，所以单独立一个审计剧本，输出结构化发现清单。
//
// ⚠ 覆盖边界（r233 量化并写明，避免把"0 发现"当成全量证据）：
//   检查④（i18n key 漏成可见文本）用 TreeWalker 遍历 body 的文本节点，但**跳过不可见子树**
//   （`hidden(parentElement)` ⇒ `skippedHidden++`）。这是**设计如此**——它查的是"漏成
//   *可见* 文本"，而 `display:none` 的内容用户看不到。
//   代价：`settings-page` 用 `display: active ? flex : none` 渲染所有 tab（非激活 tab 仍在 DOM 里），
//   所以**非激活设置页的文案不在本剧本的覆盖范围内**——包括内核版本页
//   （`KernelVersionPage`，其文案键经 prop 前缀拼出；r228/r229 修过它的缺键）。
//   实测每个界面跳过 **88–95 个**不可见文本节点（数字已在摘要里打印：`跳过不可见元素 N 个`）。
//   ⇒ 要覆盖那些页面，得先**激活对应 tab** 再扫（本轮未做，记为待办）；
//     在此之前，"dom-audit 0 发现"**不能**当作"内核版本页没有裸键"的证据。
//     那一类目前由静态守卫 `src/dynamic-prefix-i18n-keys.test.ts` 负责（r228/r229，硬断言 0）。
//
// 用法: npm run build && node scripts/demo/dom-audit.e2e.mjs [--port 9350] [--keep]
// 零 token：用 minimal 内核（echo），不花真实模型额度。
import { parseArgs } from "node:util";
import { mkdirSync, readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, killApp } from "./lib/app.mjs";
import { makeRunRoot, setupBaseline } from "./lib/home.mjs";
import { seedTestPlugins } from "./lib/test-plugins.mjs";
import { waitForDomIdle } from "./lib/util.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const { values: args } = parseArgs({ options: {
  port: { type: "string", default: "9350" },
  keep: { type: "boolean", default: false },
  // 界面语言：本剧本要能在任一 locale 下跑——i18n 缺陷（裸 key / 简繁混排）是**按语言**出现的，
  // 只测 zh-CN 会漏掉 zh-TW 的简体残留这类问题（实测就是这么漏的）。
  locale: { type: "string", default: "zh-CN" },
} });
const LOCALE = args.locale;

let passed = 0;
const findings = [];          // { severity: "H"|"M"|"L", surface, kind, detail }
function ok(cond, label) {
  if (!cond) throw new Error(`断言失败: ${label}`);
  passed += 1;
  console.log(`  ✓ ${label}`);
}
function note(severity, surface, kind, detail) {
  findings.push({ severity, surface, kind, detail });
}

// ---------- 隔离 HOME（与 minimal-smoke 同款：真内核经 symlink 借用，不 npm install） ----------
const runRoot = makeRunRoot();
const home = join(runRoot, LOCALE);
mkdirSync(home, { recursive: true });
const ctx = setupBaseline({ home, realHome: homedir(), locale: LOCALE });
seedTestPlugins(ctx.dataRoot);
const projectDir = join(home, "project");
mkdirSync(projectDir, { recursive: true });
const prefsFile = join(home, ".my-harness-desktop-dev", "config", "config.json");
writeFileSync(prefsFile, JSON.stringify({ ...JSON.parse(readFileSync(prefsFile, "utf-8")), lastCwd: projectDir }, null, 2));

const app = await launchApp({ appDir: ROOT, port: Number(args.port), env: { HOME: home, MHD_PORT: "18461" }, timeoutMs: 90000 });
const page = app.page;
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

// ---------- 页内审计器（在 renderer 上下文跑，返回发现清单） ----------
const AUDIT_FN = `
(() => {
  const out = { nesting: [], dupAnchors: [], emptyAnchored: [], i18nLeak: [], skippedDataControl: 0, skippedTemplateDoc: 0, unnamedIcons: [], imgNoAlt: [], headings: [], dupText: [], skippedHidden: 0 };
  const INTERACTIVE = "button, a[href], input, select, textarea, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=switch]";

  // ⚠ 必须排除不可见子树（实测教训，勿删）：设置页是 keep-mounted 的——
  //   src/web/components/settings-page.tsx:84 用 display: active ? flex : none，
  //   其注释明写「激活过的组件才挂载,active 显示、其余 display:none(切 tab 不重 mount)」。
  //   所以访问过的每个设置子页都常驻 DOM。不排除的话，同一批元素会在每次 auditSurface
  //   里被重复计数：实测首版把 8 处 i18n 裸 key 报成了 112 处（8 × 14 个子页），
  //   数字大得吓人但其实是同一批——审计结论因此失真（既夸大严重度，也掩盖到底几处）。
  //   注：本段在模板字符串内，不能出现反引号（会提前终止模板字面量）。
  const hiddenRoots = new Set();
  for (const el of document.querySelectorAll("*")) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") hiddenRoots.add(el);
  }
  const hidden = (el) => {
    for (let p = el; p && p !== document.body; p = p.parentElement) if (hiddenRoots.has(p)) return true;
    return false;
  };
  const visible = (els) => { const arr = [...els]; out.skippedHidden += arr.filter(hidden).length; return arr.filter((e) => !hidden(e)); };

  // ① 交互元素嵌套违规：可交互元素套可交互元素（HTML 规范禁止，且点击目标歧义）
  for (const el of visible(document.querySelectorAll(INTERACTIVE))) {
    const bad = el.querySelector(INTERACTIVE);
    if (bad) {
      out.nesting.push({
        outer: el.tagName.toLowerCase() + (el.getAttribute("role") ? '[role=' + el.getAttribute("role") + ']' : ''),
        inner: bad.tagName.toLowerCase() + (bad.getAttribute("role") ? '[role=' + bad.getAttribute("role") + ']' : ''),
        outerLabel: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 40),
        anchor: [...el.attributes].filter(a => a.name.startsWith("data-")).map(a => a.name).join(",") || "",
      });
    }
  }

  // ② 锚点重复：带 id 语义的 data-* 锚点应当唯一（message-id / session-id / tab-id）
  const anchorKinds = ["data-message-id", "data-session-id", "data-tab-id", "data-slot-id", "data-plugin-id"];
  for (const kind of anchorKinds) {
    const seen = new Map();
    for (const el of visible(document.querySelectorAll("[" + kind + "]"))) {
      const v = el.getAttribute(kind);
      seen.set(v, (seen.get(v) || 0) + 1);
    }
    for (const [v, n] of seen) if (n > 1) out.dupAnchors.push({ kind, value: String(v).slice(0, 60), count: n });
  }

  // ③ 空壳容器：带 data-* 锚点但既无子元素也无文本（挂载点没被填，或渲染条件永假）。
  // ⚠ 只用源码里真实存在的锚点：src/e2e-anchor-coverage.test.ts 会把 e2e 脚本里出现、
  //   而 src/ 中不存在的 data-* 全部列为失败。首版凭空写了 data-slot/data-region/data-container
  //   三个选择器，被那条守卫当场抓住——这正是它存在的意义（e2e 不该依赖想象中的锚点）。
  // ⚠ r112 修掉一个**空探针**：此前这里写死了两个属性选择器（data-section / data-panel），
  //   而生产代码**这两个属性一个都不发**（实测 91 种 data- 前缀属性里没有它们）⇒
  //   选择器恒匹配空集 ⇒ ③ 这一维的 emptyAnchored **永远是空数组**，
  //   看起来像"没有空壳容器"，实际是"根本没扫"。
  //   而且上面那段注释声称 e2e-anchor-coverage 会抓住这种想象出来的锚点——它没抓住，
  //   说明那条守卫的判据也有漏（本轮一并记入待办）。
  //   修法不是再换两个锚点（下次锚点演化又会变空集），而是**扫所有带 data- 前缀属性的元素**：
  //   这一维的语义本来就是"任何锚点元素都不该是空壳"，与具体锚点名无关。
  // 设计上就该为空的锚点族（白名单，每条写明理由——不是豁免，是"这一族的空是语义"）：
  //   · data-toast-live-region：常驻 live region **宿主**（r37 的设计：宿主先于内容存在，
  //     才能播报瞬时内容），空的时候正是它待命的正常态；
  //   · data-resize-handle：拖拽把手，本身不含文本也不含子元素（视觉靠 CSS 伪元素/边框）；
  //   · data-panel-group-*：布局库（panel-group）的包装层与手柄，内容由库在运行时填。
  // ⚠ 判据是"**全部** data-* 都命中白名单才排除"（r114）：因为一个元素可能同时带
  //   库发出的布局属性与我们自己的语义属性，只要有一个不属于"设计上就该空"的族，
  //   它就仍然值得被审。所以白名单要按**前缀族**列全，漏一个前缀整族就漏不掉。
  const EMPTY_BY_DESIGN = [
    "data-toast-live-region",        // 常驻 live region 宿主（r37：空是待命态）
    "data-resize-handle",            // 拖拽把手（视觉靠 CSS）+ 其 -state 变体
    "data-panel-group-",             // react-resizable-panels 的 PanelGroup 包装层
    "data-panel-resize-handle-",     // 同库的把手属性（r114 实测：漏了这个前缀，6 个把手全漏不掉）
    "data-kernel-custom-dir",        // 条件挂载点：未设自定义内核目录时本就为空（不是空壳）
    "data-timeline-composer",        // 零会话基线下时间线无内容 ⇒ 容器为空是正常态
  ];
  const anchored = [...document.querySelectorAll("*")].filter((el) => {
    const names = [...el.attributes].map((a) => a.name).filter((n) => n.startsWith("data-"));
    if (names.length === 0) return false;
    return !names.every((n) => EMPTY_BY_DESIGN.some((p) => n.startsWith(p)));
  });
  for (const el of visible(anchored)) {
    const hasKids = el.children.length > 0;
    const hasText = (el.textContent || "").trim().length > 0;
    if (!hasKids && !hasText) {
      out.emptyAnchored.push({ anchor: [...el.attributes].filter(a => a.name.startsWith("data-")).map(a => a.name).join(",").slice(0, 200), tag: el.tagName });
    }
  }

  // ④ i18n key 漏成可见文本（形如 ns.key.sub，或含 {{ 插值残留）
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const keyLike = /^[a-z][a-zA-Z0-9]*\\.[a-zA-Z0-9]+(\\.[a-zA-Z0-9]+)*$/;
  let n;
  while ((n = walker.nextNode())) {
    const t = (n.nodeValue || "").trim();
    if (!t) continue;
    if (n.parentElement && hidden(n.parentElement)) { out.skippedHidden += 1; continue; }
    // r235：排除**承载数据的控件**（textarea / input / select）里的文本。
    //   它们装的是用户可编辑的**数据**，不是 UI 文案——例如 blind-review 设置页的 prompt 模板
    //   里本来就写着 {{content}} / {{reports}}（由插件在发送时替换，不经 i18next），
    //   首版把它报成"插值残留"（4 条 H 级假阳性）。
    //   判据：这些元素的文本不参与"界面文案是否漏键/漏译"这个问题域。
    if (n.parentElement && n.parentElement.closest("textarea, input, select")) { out.skippedDataControl = (out.skippedDataControl || 0) + 1; continue; }
    if (t.includes("{{") || t.includes("}}")) {
      // r235 窄豁免：**文档化模板语法**的文案里本来就要写出占位符名
      //   （blind-review 的 review.blindReviewDesc / *PromptPlaceholder：
      //   "{{content}} 是内容占位符"、"{{reports}} 是各队报告"），
      //   那不是 i18next 插值残留，而是**内容本身**。
      //   判据封闭：占位符名必须全在已知模板变量集合里（content/reports/tree/prompt），
      //   否则仍算残留（例如 {{detail}} 没被替换就是真缺陷）。
      const names = [...t.matchAll(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g)].map((m) => m[1]);
      const TEMPLATE_VARS = new Set(["content", "reports", "tree", "prompt"]);
      const allTemplate = names.length > 0 && names.every((n) => TEMPLATE_VARS.has(n));
      if (allTemplate) out.skippedTemplateDoc = (out.skippedTemplateDoc || 0) + 1;
      else out.i18nLeak.push({ text: t.slice(0, 60), why: "插值残留" });
    }
    else if (keyLike.test(t) && t.length < 48 && !/\\.(js|ts|json|md|png|svg|css)$/.test(t)) out.i18nLeak.push({ text: t.slice(0, 60), why: "疑似未翻译的 key" });
  }

  // ⑤ 图标按钮无可访问名（只有 svg、无 aria-label/title/文本）——屏幕阅读器读不出
  for (const b of visible(document.querySelectorAll("button, [role=button]"))) {
    const txt = (b.textContent || "").trim();
    const name = b.getAttribute("aria-label") || b.getAttribute("title") || txt;
    if (!name && b.querySelector("svg")) {
      const svgClass = (b.querySelector("svg").getAttribute("class") || "").slice(0, 40);
      out.unnamedIcons.push({ svgClass, html: b.outerHTML.slice(0, 100) });
    }
  }

  // ⑥ 图片无 alt
  for (const img of visible(document.querySelectorAll("img"))) {
    if (!img.hasAttribute("alt")) out.imgNoAlt.push({ src: (img.getAttribute("src") || "").slice(0, 80) });
  }

  // ⑦ 标题层级：h1 数量、是否跳级
  const hs = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")].map(h => Number(h.tagName[1]));
  out.headings = { h1: hs.filter(x => x === 1).length, total: hs.length, seq: hs.slice(0, 24) };

  return out;
})()
`;

async function auditSurface(label) {
  const r = await page.evaluate(AUDIT_FN);
  const counts = {
    nesting: r.nesting.length, dup: r.dupAnchors.length, empty: r.emptyAnchored.length,
    i18n: r.i18nLeak.length, unnamed: r.unnamedIcons.length, imgNoAlt: r.imgNoAlt.length,
  };
  console.log(`  · [${label}] 嵌套违规=${counts.nesting} 锚点重复=${counts.dup} 空壳=${counts.empty} i18n漏=${counts.i18n} 无名图标=${counts.unnamed} 图无alt=${counts.imgNoAlt} 标题h1=${r.headings.h1}/共${r.headings.total} （跳过不可见元素 ${r.skippedHidden} 个、数据控件文本 ${r.skippedDataControl || 0} 个、模板语法文档 ${r.skippedTemplateDoc || 0} 个）`);
  for (const x of r.nesting.slice(0, 6)) note("H", label, "交互嵌套违规", `${x.outer} 套 ${x.inner}（外层可访问名「${x.outerLabel}」，锚点 ${x.anchor || "无"}）`);
  for (const x of r.dupAnchors.slice(0, 6)) note("H", label, "锚点重复", `${x.kind}="${x.value}" 出现 ${x.count} 次`);
  for (const x of r.emptyAnchored.slice(0, 6)) note("M", label, "空壳容器", x.anchor);
  // ③「空壳容器」从**审计输出**升级为**断言**（r114）：此前它只打印条数，
  //   而 r112 查明这一维因为写死了两个不存在的锚点而**恒为空**——恒空 + 只打印
  //   是最坏的组合：它既没在验，也不会因为没在验而报错。
  //   现在扫描范围改成"所有带 data- 前缀属性的元素"，并给"设计上就该为空"的族
  //   建了带理由的白名单（EMPTY_BY_DESIGN），所以 0 是一个**有意义的结果**。
  //   ⚠ 断言放在 auditSurface 内部（不是外层）：每个被审的界面各自断言，
  //     放外层只能覆盖最后一次调用的结果（首版就放错了作用域，报 r is not defined）。
  ok(r.emptyAnchored.length === 0, [
    `[${label}] 有 ${r.emptyAnchored.length} 个带 data-* 锚点的元素既无子元素也无文本（空壳容器）：`,
    ...r.emptyAnchored.slice(0, 6).map((x) => `      <${x.tag}> ${x.anchor}`),
    "      两种可能：① 挂载点没被填（贡献没注册成功/组件没渲染）；② 渲染条件永假（功能漂移）。",
    "      若确认是'设计上就该为空'（条件挂载点、库的包装层、待命态宿主），",
    "      把它加进 AUDIT_FN 里的 EMPTY_BY_DESIGN 白名单并**写明理由**——白名单不是豁免表。",
  ].join("\n"));
  for (const x of r.i18nLeak.slice(0, 8)) note("H", label, "i18n key 漏成文本", `「${x.text}」（${x.why}）`);
  for (const x of r.unnamedIcons.slice(0, 8)) note("M", label, "图标按钮无可访问名", x.html);
  for (const x of r.imgNoAlt.slice(0, 4)) note("L", label, "图片无 alt", x.src);
  return r;
}

try {
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 25000 });
  ok(true, "应用拉起，composer 就绪");

  // 界面语言必须真的等于种入的 locale。这条守的是一个**已修的静默 bug**：
  // `initI18n()` 与 `hydrateFromPrefs()` 并行（app-main.tsx:216），它原先读
  // `store.currentLocale`——那个字段有非空默认值 "zh-CN"（ui-store.ts:178），于是
  // ① 读到的是默认值而非用户选的，② `if (!lng)` 的浏览器语言检测兜底永不触发，
  // ③ 自愈用的 `subscribeLocaleChange()` 在 `.finally()` 里才装（app-main.tsx:222），
  //    那时水合早已完成、prev 初值就等于最终值，于是 `changeLanguage` 一次都不会被调用。
  // 实测症状：prefs 存着 zh-TW、`window.kernel.prefs.get("currentLocale")` 也返回 zh-TW，
  // 但 `document.documentElement.lang` 与整个界面都是 zh-CN。修法见 app/i18n-init.ts 的注释。
  const langInfo = await page.evaluate(async () => ({
    htmlLang: document.documentElement.lang,
    prefsLocale: await window.kernel.prefs.get("currentLocale"),
    sample: [...document.querySelectorAll('div[role="button"]')]
      .map((x) => (x.textContent || "").trim()).find((t) => /^(设置|設置|Einstellungen|Settings)$/.test(t)) ?? "(未找到设置项)",
  }));
  ok(langInfo.prefsLocale === LOCALE, `prefs 里的语言偏好是种入的 ${LOCALE}（实际 ${langInfo.prefsLocale}）`);
  ok(langInfo.htmlLang === LOCALE, `界面语言真的切到了 ${LOCALE}（document.documentElement.lang=${langInfo.htmlLang}；此前这里会停在 zh-CN）`);
  console.log(`  · 设置入口文案实测为「${langInfo.sample}」（应与 locale 一致）`);

  // ===== 阶段 A：首屏体检 =====
  console.log("\n── 阶段 A：首屏 DOM 体检 ──");
  await auditSurface("首屏");

  // 记录全部 data-* 锚点清单（供「文件/DOM 是否对应」核对）
  const anchors = await page.evaluate(() => {
    const set = new Set();
    for (const el of document.querySelectorAll("*")) {
      for (const a of el.attributes) if (a.name.startsWith("data-")) set.add(a.name);
    }
    return [...set].sort();
  });
  console.log(`  · 首屏 data-* 锚点共 ${anchors.length} 种`);

  // ===== 阶段 B：走到设置页与右面板各 Tab 再体检 =====
  console.log("\n── 阶段 B：设置页 / 右面板 遍历体检 ──");
  // 设置入口：找 aria-label 或文本含「设置」的按钮
  // 设置入口是 `ChatRow`（div[role=button] + tabIndex=0 + Enter/Space 键处理，见 src/web/ui/chat-row.tsx）。
  // ⚠ 它**没有 data-* 锚点**，所以只能按文案找——这本身是一条发现（记进清单）：主导航控件缺稳定锚点，
  // 让 e2e 与 DOM 审计只能依赖 i18n 文案，换语言即失效。
  const ROW_SEL = 'div[role="button"], button, [role="option"], [role="tab"]';
  const labelOf = (x) => (x.getAttribute("aria-label") || x.textContent || "").trim();
  // 按**稳定锚点**定位（src/web/components/sidebar.tsx 的 data-sidebar-entry="settings"），
  // 不按译文文案匹配——后者每换一种语言就失效（zh-TW 是「設定」而非「設置」）。
  const openedSettings = await page.evaluate(() => {
    const b = document.querySelector('[data-sidebar-entry="settings"]');
    if (!b) return false;
    b.click();
    return true;
  });
  if (!openedSettings) {
    note("M", "设置页", "入口未找到", "没能按文案定位设置入口，设置页各 TAB 未被体检（审计覆盖不足）");
  } else {
    await waitForDomIdle(page, { quietMs: 700, timeoutMs: 15000 });
    await auditSurface("设置页");
    // 设置页左列表用 ListItem（不是 [role=tab]）——按"可点行"泛化查找，不猜具体控件类型。
    const tabs = await page.evaluate(({ sel }) => {
      const rows = [...document.querySelectorAll(sel)];
      return rows
        .map((el, i) => ({ i, label: (el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 26), tag: el.tagName.toLowerCase() }))
        .filter((r) => r.label && r.label.length <= 26);
    }, { sel: ROW_SEL });
    console.log(`  · 设置页可点行 ${tabs.length} 个：${tabs.map((t) => t.label).join(" / ").slice(0, 200)}`);
    let visited = 0;
    for (const t of tabs) {
      // 每轮重新按**文案**定位（点击后 DOM 会重排，索引会失效——这是遍历动态列表的正确做法）
      const clicked = await page.evaluate(({ sel, label }) => {
        const el = [...document.querySelectorAll(sel)].find((x) => (x.getAttribute("aria-label") || x.textContent || "").trim().replace(/\s+/g, " ").slice(0, 26) === label);
        if (!el) return false;
        el.click();
        return true;
      }, { sel: ROW_SEL, label: t.label });
      if (!clicked) continue;
      await waitForDomIdle(page, { quietMs: 450, timeoutMs: 10000 }).catch(() => {});
      await auditSurface(`设置页/${t.label}`);
      visited += 1;
      if (visited >= 14) break;
    }
    if (visited === 0) note("M", "设置页", "TAB 遍历失败", "找到了设置页但一个可点行都没能进入，设置页内部未被体检");
    else ok(visited > 0, `设置页遍历了 ${visited} 个子页并逐个体检`);

    // ── 阶段 B2（r234 建、r235 改成按**稳定锚点**遍历）：走完全部设置条目 ──
    // 为什么不用文案匹配（r235 更正）：r234 的首版按标签数组定向点击
    // （["Pi","DSH","Minimal","Probe4","通用","主题",…]），结果在 **de 语言下只走到 4 页**——
    // 德文的 Allgemein/Themen/Fertigkeiten/Tastenkürzel 匹配不上中文标签。
    // 这正是 §1.2/r113 那条：**别把界面文案当结构**（文案经 i18n 查表、随语言变）。
    // 改用设置页自带的稳定锚点：`[data-settings-id]`（入口探针，settings-page.tsx:563 的注释
    // 明确说它是"稳定探针锚点"）；激活态可由 `[data-settings-pane-active="true"]` 复核。
    const ids = await page.evaluate(() =>
      [...document.querySelectorAll("[data-settings-id]")].map((el) => String(el.getAttribute("data-settings-id"))));
    console.log(`  · 设置条目（data-settings-id）${ids.length} 个：${ids.join(" / ").slice(0, 220)}`);
    let visited2 = 0;
    const visitedIds = [];
    for (const id of ids) {
      const clicked = await page.evaluate((want) => {
        const el = document.querySelector(`[data-settings-id="${want}"]`);
        if (!el) return false;
        el.click();
        return true;
      }, id);
      if (!clicked) continue;
      await waitForDomIdle(page, { quietMs: 400, timeoutMs: 10000 }).catch(() => {});
      // 复核激活态：确认这次点击真的切到了该条目（否则审计的还是上一页）
      const activeId = await page.evaluate(() => {
        const el = document.querySelector('[data-settings-pane-active="true"]');
        return el ? String(el.getAttribute("data-settings-pane")) : null;
      });
      await auditSurface(`设置页#${id}`);
      visited2 += 1;
      visitedIds.push(activeId === id ? id : `${id}(激活态=${activeId})`);
    }
    console.log(`  · 阶段 B2：按锚点走完 ${visited2}/${ids.length} 个设置条目：${visitedIds.join(" / ").slice(0, 240)}`);
    ok(ids.length >= 8, `设置条目锚点数应 ≥ 8（实际 ${ids.length}）——过少说明锚点没挂上或设置页没打开（r235）`);
    ok(visited2 === ids.length, `阶段 B2 应走完**全部**设置条目（实际 ${visited2}/${ids.length}）——按锚点遍历不受语言影响（r235）`);
  }

  // ===== 阶段 C：文件与格式对应 =====
  console.log("\n── 阶段 C：文件格式对应（壳写出的 vs 代码读的）──");
  const dataRoot = join(home, ".my-harness-desktop-dev");
  const cfgDir = join(dataRoot, "config");
  for (const f of ["config.json", "general.json"]) {
    const p = join(cfgDir, f);
    if (!existsSync(p)) { note("H", "配置文件", "缺失", `${f} 不存在于 ${cfgDir}`); continue; }
    try {
      const j = JSON.parse(readFileSync(p, "utf-8"));
      console.log(`  · ${f} 字段：${Object.keys(j).join(", ").slice(0, 160)}`);
      if (f === "general.json") {
        // 壳读它的地方期望 defaultThinkingLevel / sidebarDefaultOpen（assemble 的种子写的就是这两个）
        if (!("defaultThinkingLevel" in j)) note("H", "general.json", "字段缺失", "缺 defaultThinkingLevel（种子应写入）");
        if (!("sidebarDefaultOpen" in j)) note("H", "general.json", "字段缺失", "缺 sidebarDefaultOpen（种子应写入）");
        ok("defaultThinkingLevel" in j && "sidebarDefaultOpen" in j, "general.json 含壳期望的两个字段（写读对应）");
      }
    } catch (e) {
      note("H", "配置文件", "JSON 解析失败", `${f}: ${e.message}`);
    }
  }
  // 插件配置目录（ConfigStore 的全局层：一个插件一个文件）
  const pluginCfgs = existsSync(cfgDir) ? readdirSync(cfgDir).filter((n) => n.endsWith(".json")) : [];
  console.log(`  · config 目录下 ${pluginCfgs.length} 个 json：${pluginCfgs.join(", ").slice(0, 140)}`);

  // ===== 阶段 D：功能漂移（DOM 呈现 vs 内核能力声明）=====
  console.log("\n── 阶段 D：功能漂移（缺面内核不该长出控件）──");
  const capsDump = await page.evaluate(async () => {
    // 经 renderer 的 kernel 面读注册表事实：有哪些内核、各自能力
    const k = window.kernel;
    if (!k) return { error: "window.kernel 不存在" };
    const ids = k.kernelIds ?? Object.keys(k.kernels ?? {});
    const out = { ids, perKernel: {} };
    for (const id of ids) {
      const api = k.kernels?.[id];
      out.perKernel[id] = {
        hasToolFilterFace: typeof api?.toolFilterEnforced === "function",
        toolFilterEnforced: typeof api?.toolFilterEnforced === "function" ? await api.toolFilterEnforced().catch(() => null) : null,
        caps: (await api?.capabilities?.().catch(() => null)) ?? null,
      };
    }
    return out;
  });
  console.log(`  · renderer 侧内核清单：${JSON.stringify(capsDump.ids)}`);
  for (const [id, v] of Object.entries(capsDump.perKernel ?? {})) {
    console.log(`    - ${id}: toolFilterEnforced 面=${v.hasToolFilterFace} 值=${v.toolFilterEnforced} capabilities=${JSON.stringify(v.caps)}`);
    if (!v.hasToolFilterFace && v.toolFilterEnforced !== null) {
      note("H", "能力面", "缺面却返回值", `${id} 未声明 toolFilterEnforced 却给出 ${v.toolFilterEnforced}`);
    }
  }
  ok(Array.isArray(capsDump.ids) && capsDump.ids.length > 0, "renderer 能取到内核清单（注册表事实经 IPC 可达）");

  // ===== 收尾 =====
  // ── 常驻 live region 宿主（r37）：必须从**启动**就在 DOM 里 ──
  //
  // 为什么这条要在真机验：`aria-live` 的播报前提是**容器先于内容存在**。若宿主由第一条
  // toast 惰性创建，则"建容器"与"填内容"同一次挂载，多数读屏不播报 —— 用户听不到的
  // 恰好是最该听到的第一条（「附件类型不支持」「保存失败」）。单测能证明组件行为，
  // 但"应用根真的挂了它"只有起真 app 才知道。
  const liveRegion = await page.evaluate(() => {
    const hosts = [...document.querySelectorAll("[data-toast-live-region]")];
    return {
      count: hosts.length,
      ariaLive: hosts[0]?.getAttribute("aria-live") ?? null,
      ariaAtomic: hosts[0]?.getAttribute("aria-atomic") ?? null,
      role: hosts[0]?.getAttribute("role") ?? null,
      text: (hosts[0]?.textContent ?? "").trim(),
      box: hosts[0] ? { w: hosts[0].getBoundingClientRect().width, h: hosts[0].getBoundingClientRect().height } : null,
    };
  });
  console.log(`  · 常驻 live region：${JSON.stringify(liveRegion)}`);
  ok(liveRegion.count === 1, `启动即有且仅有 1 个常驻 live region 宿主（实际 ${liveRegion.count} 个；0 个 = 应用根没挂 LiveRegionHost，第一条 toast 播不出来）`);
  ok(liveRegion.ariaLive === "polite", `宿主 aria-live=polite（toast 是告知不该抢占；实际 ${liveRegion.ariaLive}）`);
  ok(liveRegion.ariaAtomic === "true", "宿主 aria-atomic=true（整条消息作为整体播报）");
  ok(liveRegion.role === "status", `宿主 role=status（实际 ${liveRegion.role}）`);
  ok(liveRegion.box !== null && liveRegion.box.w === 0 && liveRegion.box.h === 0,
    `宿主不占可见空间（实际 ${JSON.stringify(liveRegion.box)}）——否则会影响布局`);

  // ── 界面级语言不变量（把 locale 文件层的判据搬到**真实渲染结果**上复核）──
  //
  // 为什么要重复一遍：locale 文件全绿 ≠ 界面全绿。r29/r30 实测两种"文件对但界面错"：
  //   ① 语言文件没在 manifest 的 `contributes.languages`（**显式清单**）里登记 → 静默不加载，
  //      界面回落到 manifest 的中文字面量（守卫 `contribution-label-i18n.test.ts` 管这层）；
  //   ② 文案压根不在语言包里，而是硬编码在组件/manifest 里。
  // 两种都只有看**渲染出来的字**才抓得到。
  const visible = await page.evaluate(() => document.body.innerText);
  if (LOCALE === "en" || LOCALE === "de") {
    // 非中文语言下，界面里出现任何 CJK 都是未本地化的串漏出来了
    // r235 窄豁免：**语言自称**（endonym）按惯例用其自身文字显示（语言选择器里
    //   "简体中文 / 繁體中文 / English / Deutsch" 并列），所以非中文语言下它们是正当的中文串。
    //   判据封闭：只豁免这两个确切字符串，其它中文串一律算未本地化。
    const ENDONYMS = new Set(["简体中文", "繁體中文"]);
    const cjk = [...new Set(visible.match(/[\u4e00-\u9fff]{2,}/g) ?? [])].filter((x) => !ENDONYMS.has(x));
    console.log(`  · [${LOCALE}] 界面里的中文串 ${cjk.length} 处${cjk.length ? ": " + JSON.stringify(cjk.slice(0, 8)) : ""}`);
    ok(cjk.length === 0, `${LOCALE} 界面里不该出现任何中文串（未本地化的文案会这样漏出来）`);
  }
  if (LOCALE === "zh-TW") {
    // 术语层：这些是**大陆专用词**（字形已是繁体也不对），与 src/locale-zhtw-terminology.test.ts 同源。
    // 用词而不是字集判：字集里「默/加」这类简繁同形字会造成假阳性（r29 实踩过）。
    const MAINLAND = ["插件", "內核", "配置", "默認", "加載", "存儲", "數據", "消息", "字符串", "硬件", "文件夾", "屏幕", "鼠標", "激活"];
    const bad = MAINLAND.filter((w) => visible.includes(w));
    console.log(`  · [zh-TW] 界面里的大陆术语 ${bad.length} 种${bad.length ? ": " + JSON.stringify(bad) : ""}`);
    ok(bad.length === 0, `zh-TW 界面里不该出现大陆术语（应作 外掛/核心/設定/預設/載入/儲存/資料/訊息/字串/硬體/資料夾…）`);
  }

  ok(pageErrors.length === 0, `页面零报错（实际 ${pageErrors.length} 条${pageErrors.length ? ": " + pageErrors.slice(0, 2).join(" | ").slice(0, 160) : ""}）`);
} finally {
  await killApp(app);
}

// ---------- 发现清单 ----------
console.log(`\n════ 审计发现（locale=${LOCALE}，共 ${findings.length} 条）════`);
const bySev = { H: [], M: [], L: [] };
for (const f of findings) bySev[f.severity].push(f);
for (const sev of ["H", "M", "L"]) {
  if (!bySev[sev].length) continue;
  console.log(`\n【${sev === "H" ? "高（结构坏了/用户可见错误）" : sev === "M" ? "中（可访问性/空壳）" : "低（规范瑕疵）"}】${bySev[sev].length} 条`);
  // 同类合并，避免刷屏
  const grouped = new Map();
  for (const f of bySev[sev]) {
    const key = f.kind;
    grouped.set(key, [...(grouped.get(key) ?? []), f]);
  }
  for (const [kind, list] of grouped) {
    console.log(`  ▸ ${kind}（${list.length} 处）`);
    for (const f of list.slice(0, 10)) console.log(`      [${f.surface}] ${f.detail}`);
    if (list.length > 10) console.log(`      …另 ${list.length - 10} 处`);
  }
}
console.log(`\n✅ 断言通过 ${passed} 项；审计发现 ${findings.length} 条（H=${bySev.H.length} M=${bySev.M.length} L=${bySev.L.length}）`);
console.log(`   隔离 HOME: ${home}${args.keep ? "（--keep 保留）" : ""}`);
if (bySev.H.length > 0) process.exitCode = 2;   // 高severity 发现 → 非零退出，便于 CI 拦
