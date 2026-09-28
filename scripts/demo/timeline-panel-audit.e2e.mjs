#!/usr/bin/env node
// 时间线 DOM 组装 + 右面板各 Tab + 「磁盘文件 ↔ 渲染 DOM 对应」审计 e2e。
//
// 补 dom-audit.e2e.mjs 的盲区：那个剧本覆盖首屏与设置页，但**内容区**（时间线消息卡、
// 右面板各 Tab 的实际内容）一个都没进去——而用户点名的正是"DOM 组装"与"文件内容是否合理"。
// 本剧本用 minimal 内核（echo，零 token）造出真实会话内容，然后：
//
//   E. 时间线消息卡的结构体检：锚点唯一性、交互嵌套、动作按钮的可访问名、
//      role 标注、渲染顺序与发送顺序一致；
//   F. **文件 ↔ DOM 对应**：读磁盘上的会话文件（内核侧 + 中立层），与渲染出的卡片逐条对账——
//      条数、role、正文。这一条直接回答"文件是否对应、格式是否对应"：
//      若壳写盘与渲染读盘对同一份数据的理解不一致，这里会当场暴露；
//   G. 右面板逐 Tab 体检：每个 Tab 点开后内容区的结构、空面板、裸 i18n key。
//
// 用法: npm run build && node scripts/demo/timeline-panel-audit.e2e.mjs [--port 9350] [--keep]
import { parseArgs } from "node:util";
import { mkdirSync, readFileSync, readdirSync, existsSync, writeFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, killApp } from "./lib/app.mjs";
import { makeRunRoot, setupBaseline } from "./lib/home.mjs";
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
seedTestPlugins(ctx.dataRoot);
const projectDir = join(home, "project");
mkdirSync(projectDir, { recursive: true });
const prefsFile = join(ctx.configDir, "config.json");
writeFileSync(prefsFile, JSON.stringify({ ...JSON.parse(readFileSync(prefsFile, "utf-8")), lastCwd: projectDir }, null, 2));

const app = await launchApp({ appDir: ROOT, port: Number(args.port), env: { HOME: home, MHD_PORT: "18463" }, timeoutMs: 90000 });
const page = app.page;
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

/** 通用结构体检器（与 dom-audit 同款判据，但作用域限定在给定的根选择器内）。 */
// ⚠ `page.evaluate(字符串)` 是**当表达式求值且不传参**的，所以不能写成
//   `evaluate(FN_STRING, sel)`——那会返回函数对象本身（实测 r.nesting undefined）。
//   这里把选择器 JSON 内联进 IIFE，产出一段自足源码再求值。
const auditSource = (scopeSel) => `
((scopeSel) => {
  // 哨兵值 __timeline__ = "消息卡的最近共同祖先"（timeline 是 react-virtuoso 虚拟列表，
  // 没有容器级锚点；为它加一个要动虚拟化组件，风险大于收益）。
  const resolveRoot = () => {
    if (scopeSel !== "__timeline__") return scopeSel ? document.querySelector(scopeSel) : document.body;
    const cards = [...document.querySelectorAll("[data-message-id]")];
    if (!cards.length) return null;
    let anc = cards[0].parentElement;
    while (anc && anc !== document.body) { if (cards.every((c) => anc.contains(c))) return anc; anc = anc.parentElement; }
    return null;
  };
  const root = resolveRoot();
  const out = { nesting: [], unnamedIcons: [], i18nLeak: [], empty: [], count: 0, anchors: {}, dndSkipped: 0 };
  if (!root) return out;
  const vis = (el) => { const b = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return b.width > 0 && b.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  const INTER = "button, a[href], input, select, textarea, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=switch]";
  const all = [...root.querySelectorAll("*")].filter(vis);
  out.count = all.length;
  // 交互嵌套违规。
  // ⚠ 窄排除 dnd-kit 的 sortable 包装节点：useSortable 会给被拖拽项注入
  //   role="button" tabindex="0" aria-roledescription="sortable" aria-describedby="DndDescribedBy-*"
  //   （实测 outerHTML 确认），目的是让拖拽可键盘操作。它内部再有按钮是库的既有模式，
  //   不是本仓的缺陷——把它报成 H 级只会淹没真问题（与上轮「形」假阳性同一个教训：
  //   假阳性会侵蚀审计的可信度，进而被绕过）。
  //   排除条件必须同时满足两个 dnd-kit 专有属性，且被排除的数量要打印出来，
  //   防止将来有人把排除面悄悄放宽。
  //   注：本段在模板字符串内，不能出现反引号（会提前终止模板字面量）。
  const isDndSortable = (el) => el.getAttribute("aria-roledescription") === "sortable"
    && (el.getAttribute("aria-describedby") || "").startsWith("DndDescribedBy");
  for (const el of all.filter((e) => e.matches(INTER))) {
    const bad = [...el.querySelectorAll(INTER)].find(vis);
    if (!bad) continue;
    if (isDndSortable(el)) { out.dndSkipped += 1; continue; }
    out.nesting.push({ outer: el.tagName.toLowerCase(), inner: bad.tagName.toLowerCase(),
      name: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 30) });
  }
  // 图标按钮无可访问名
  for (const b of all.filter((e) => e.matches("button, [role=button]"))) {
    const name = b.getAttribute("aria-label") || b.getAttribute("title") || (b.textContent || "").trim();
    if (!name && b.querySelector("svg")) out.unnamedIcons.push({ html: b.outerHTML.slice(0, 90) });
  }
  // 裸 i18n key
  const keyLike = /^[a-z][a-zA-Z0-9]*\\.[a-zA-Z0-9]+(\\.[a-zA-Z0-9]+)*$/;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = w.nextNode())) {
    const t = (n.nodeValue || "").trim();
    if (!t) continue;
    if (t.includes("{{") || t.includes("}}")) out.i18nLeak.push({ text: t.slice(0, 50), why: "插值残留" });
    else if (keyLike.test(t) && t.length < 48 && !/\\.(js|ts|json|md|png|svg|css)$/.test(t)) out.i18nLeak.push({ text: t.slice(0, 50), why: "疑似未翻译的 key" });
  }
  // 锚点统计（查重与查缺）
  for (const el of all) {
    for (const a of el.attributes) {
      if (!a.name.startsWith("data-")) continue;
      (out.anchors[a.name] ??= []).push(a.value);
    }
  }
  return out;
})(${JSON.stringify(scopeSel ?? null)})
`;

async function auditScope(label, scopeSel) {
  const r = await page.evaluate(auditSource(scopeSel));
  console.log(`  · [${label}] 可见元素=${r.count} 嵌套违规=${r.nesting.length} 无名图标=${r.unnamedIcons.length} i18n漏=${r.i18nLeak.length}${r.dndSkipped ? ` （另跳过 dnd-kit sortable 包装 ${r.dndSkipped} 处）` : ""}`);
  for (const x of r.nesting.slice(0, 5)) note("H", label, "交互嵌套违规", `${x.outer} 套 ${x.inner}（「${x.name}」）`);
  for (const x of r.unnamedIcons.slice(0, 5)) note("M", label, "图标按钮无可访问名", x.html);
  for (const x of r.i18nLeak.slice(0, 6)) note("H", label, "i18n key 漏成文本", `「${x.text}」（${x.why}）`);
  return r;
}

/** 读一个目录下最新的 .jsonl，返回逐行解析结果。 */
function readLatestJsonl(dir) {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith(".jsonl"))
    .map((f) => join(dir, String(f)));
  if (!files.length) return null;
  const latest = files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  const lines = readFileSync(latest, "utf-8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { __bad: l.slice(0, 60) }; } });
  return { file: latest, lines };
}

try {
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 25000 });

  // ---- 选 minimal 模型（零 token）----
  // 按**稳定锚点**定位模型触发器（`data-composer-model` 是 timeline 插件的既有锚点，
  // 值形如 `<kernel>:<provider>/<model>`）。不用"带 svg 且文本长度>2 且不是思考档位"这类
  // 文案启发式——那种写法在 closest("form") 落空时会退回 document.body、点到页面上第一个
  // 符合条件的按钮（实测本剧本首版就是这样，8s 等不到下拉而超时）。
  const trig = await page.evaluate(() => {
    const b = document.querySelector("button[data-composer-model]");
    if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!trig) throw new Error("未找到 composer 模型触发器（button[data-composer-model]）");
  await page.mouse.click(trig.x, trig.y);
  // 模型下拉是**按内核分 TAB** 的：不先切到 minimal TAB，菜单里只有当前内核（默认 pi）的模型，
  // 于是"Minimal Echo"永远等不到（本剧本首版就栽在这里，8s 超时）。
  // 用仓库既有的 clickPointUntil 重试范式（minimal-smoke.e2e.mjs:71-84 同款）：
  // 每轮重新算坐标，判据是"目标模型项真的可见"，而不是"点过了"。
  const tabClicked = await clickPointUntil(
    page,
    () => {
      const menu = document.querySelector("[role='menu']");
      const tab = [...(menu?.querySelectorAll("button") ?? [])].find((b) => (b.textContent || "").trim().toLowerCase() === "minimal");
      if (!tab) return null;
      const r = tab.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    },
    () => [...document.querySelectorAll("[role^='menuitem']")].some((el) => (el.textContent || "").includes("Minimal Echo") && el.getBoundingClientRect().width > 0),
  );
  if (!tabClicked) throw new Error("点了多次仍没切到 minimal 内核 TAB（模型项未出现）");
  const itemRect = await page.evaluate(() => {
    const it = [...document.querySelectorAll("[role^='menuitem']")].find((el) => (el.textContent || "").includes("Minimal Echo") && el.getBoundingClientRect().width > 0);
    const r = it.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(itemRect.x, itemRect.y);
  await page.keyboard.press("Escape").catch(() => {});
  await waitForDomIdle(page, { quietMs: 500, timeoutMs: 6000 }).catch(() => {});

  // ---- 发两轮，造出真实时间线内容 ----
  const sent = ["第一条审计消息", "第二条审计消息"];
  for (const text of sent) {
    await page.click("[data-timeline-composer]");
    await page.keyboard.type(text);
    const sendRect = await page.evaluate(() => {
      const b = document.querySelector("button[aria-label*='发送']"); if (!b) return null;
      const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (!sendRect) throw new Error("未找到发送按钮");
    await page.mouse.click(sendRect.x, sendRect.y);
    // best-effort settle（r124 标注，同族判定见 minimal-smoke r123）：两阶段收敛的第一阶段——
    // 等「停止」出现。零 token / 模型端点不可达的剧本里 streaming 可能**从不开始**，
    // 停止钮合法地不出现，所以等不到不算失败（真失败由『发送后该出现的产物』那些断言报出来）。
    await page.waitForSelector("[data-composer-stop]", { timeout: 20000 }).catch(() => {});
    // best-effort settle（r124 标注，同族判定见 minimal-smoke r123）：两阶段收敛的第二阶段——
    // 等「停止」消失（streaming 收尾）。等不到也继续：后续断言读的是终态 DOM，
    // 若仍在 streaming 会由那些断言报出来，而不是在这里静默吞掉一个『没收尾』的信号。
    await page.waitForFunction(() => !document.querySelector("[data-composer-stop]"), { timeout: 30000, polling: 500 }).catch(() => {});
  }
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 20000 }).catch(() => {});
  ok(true, `已发送 ${sent.length} 轮（minimal echo，零 token）`);

  // ===== 阶段 E：时间线消息卡结构体检 =====
  console.log("\n── 阶段 E：时间线 DOM 组装 ──");
  // ⚠ 作用域**不能**写 `[data-timeline-composer]`——那是 composer 的 <textarea> 本身（无子元素），
  //   首版就这么写，于是"可见元素=0"、后面所有结构检查全部空转（假绿）。
  //   timeline 的消息列表是 react-virtuoso 虚拟列表，没有容器级 data-* 锚点；
  //   为它加一个要动虚拟化组件，风险大于收益。改为运行时取**消息卡的最近共同祖先**当作用域。
  const tlScope = await page.evaluate(() => {
    const cards = [...document.querySelectorAll("[data-message-id]")];
    if (!cards.length) return null;
    let anc = cards[0].parentElement;
    while (anc && anc !== document.body) {
      if (cards.every((c) => anc.contains(c))) break;
      anc = anc.parentElement;
    }
    if (!anc || anc === document.body) return null;
    // ⚠ 不再 setAttribute 打临时标记：那会让 DOM 出现一个源码里不存在的 data-*，
    //   被 e2e-anchor-coverage 守卫判为"依赖了不存在的锚点"（且污染被测 DOM）。
    //   改为返回哨兵值，由审计函数在页内自己解析共同祖先。
    return "__timeline__";
  });
  ok(!!tlScope, "定位到时间线容器（消息卡的最近共同祖先）");
  const tl = await auditScope("时间线", tlScope);
  ok(tl.count > 0, `时间线作用域内确实有可见元素（实际 ${tl.count}；为 0 说明作用域又选错了，检查会空转）`);
  const cards = await page.evaluate(() => [...document.querySelectorAll("[data-message-id]")].map((el) => ({
    id: el.getAttribute("data-message-id"),
    text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 90),
    buttons: [...el.querySelectorAll("button, [role=button]")].map((b) => b.getAttribute("aria-label") || (b.textContent || "").trim()).filter(Boolean),
    unnamedButtons: [...el.querySelectorAll("button, [role=button]")].filter((b) => !(b.getAttribute("aria-label") || b.getAttribute("title") || (b.textContent || "").trim()) && b.querySelector("svg")).length,
  })));
  console.log(`  · 消息卡 ${cards.length} 张`);
  for (const c of cards) console.log(`      id=${String(c.id).slice(0, 22)} 动作=[${c.buttons.join("|")}] 无名按钮=${c.unnamedButtons} ‹${c.text.slice(0, 46)}›`);

  ok(cards.length >= sent.length * 2, `消息卡数量 ≥ 发送轮数×2（实际 ${cards.length}，期望 ≥ ${sent.length * 2}）`);
  const ids = cards.map((c) => c.id);
  ok(new Set(ids).size === ids.length, `data-message-id 全部唯一（${ids.length} 张卡）`);
  ok(cards.every((c) => c.unnamedButtons === 0), "每张卡内的图标按钮都有可访问名");
  // 渲染顺序必须与发送顺序一致（DOM 组装的线性序）
  const joined = cards.map((c) => c.text).join(" | ");
  let orderOk = true;
  let lastIdx = -1;
  for (const s of sent) { const i = joined.indexOf(s); if (i < 0 || i < lastIdx) { orderOk = false; break; } lastIdx = i; }
  ok(orderOk, "两条用户消息在 DOM 里的先后与发送顺序一致（线性序不乱）");
  // 每条用户消息后面应跟着它的 echo 回复
  for (const s of sent) {
    ok(joined.includes(`[minimal echo] ${s}`), `「${s}」的 echo 回复已渲染（写读闭环）`);
  }
  if (tl.nesting.length) note("H", "时间线", "交互嵌套违规", `${tl.nesting.length} 处`);

  // ===== 阶段 F：磁盘文件 ↔ 渲染 DOM 对应 =====
  console.log("\n── 阶段 F：文件 ↔ DOM 对应 ──");
  const kernelFile = readLatestJsonl(join(home, ".minimal", "agent", "sessions"));
  ok(!!kernelFile, "minimal 内核侧会话文件存在");
  if (kernelFile) {
    const lines = kernelFile.lines;
    ok(lines.every((l) => !l.__bad), `内核侧文件每行都是合法 JSON（${lines.length} 行）`);
    ok(lines[0]?.type === "session", `头行 type=session（实际 ${lines[0]?.type}）`);
    const msgs = lines.filter((l) => l.type === "message");
    ok(msgs.length === sent.length * 2, `内核侧 message 条目 = ${sent.length * 2}（实际 ${msgs.length}）`);
    ok(msgs.every((m) => m.message && typeof m.message.role === "string"), "每条 message 都有 message.role");
    const roles = msgs.map((m) => m.message.role);
    ok(roles.filter((r) => r === "user").length === sent.length, `user 条目 = ${sent.length}（实际 ${roles.filter((r) => r === "user").length}）`);
    ok(roles.filter((r) => r === "assistant").length === sent.length, `assistant 条目 = ${sent.length}（实际 ${roles.filter((r) => r === "assistant").length}）`);
    // **文件内容 ↔ DOM 文本对账**：发出去的每句话都必须能在内核侧文件里找到
    for (const s of sent) {
      const inFile = msgs.some((m) => JSON.stringify(m.message).includes(s));
      ok(inFile, `「${s}」确实落进了内核侧会话文件（不是只在内存里）`);
    }
    console.log(`  · 内核侧文件 ${kernelFile.file.replace(home, "~")}：${lines.length} 行（1 头 + ${msgs.length} 消息）`);
  }
  // 中立层：壳自己的会话索引。**它不是 jsonl**——布局是 `<数据根>/sessions/<ns>.header.json`
  // + `<ns>.entries.json`（neutral-session-store.ts:10-12 的文件头写明；另有遗留整树
  // `<ns>.json`，读到即懒迁移拆开）。首版按 `.jsonl` 找，于是断言"中立层文件存在"直接失败——
  // 那不是我修出来的 bug，是剧本对**格式**的假设错了。这恰好印证本轮要查的正是
  // "文件是否对应、格式是否对应"：连写审计脚本的人都会把格式记错，说明它值得被钉住。
  const neutralDir = join(ctx.dataRoot, "sessions");
  ok(existsSync(neutralDir), `中立层目录存在（${neutralDir.replace(home, "~")}）`);
  const allFiles = existsSync(neutralDir) ? readdirSync(neutralDir) : [];
  const headers = allFiles.filter((f) => f.endsWith(".header.json"));
  const entries = allFiles.filter((f) => f.endsWith(".entries.json"));
  const legacy = allFiles.filter((f) => f.endsWith(".json") && !f.endsWith(".header.json") && !f.endsWith(".entries.json"));
  console.log(`  · 中立层目录：${headers.length} 个 .header.json、${entries.length} 个 .entries.json、${legacy.length} 个遗留整树`);
  ok(headers.length > 0, "至少有一个 .header.json（壳的写穿回执）");
  ok(legacy.length === 0, `没有遗留整树文件残留（懒迁移应已拆开；实际 ${legacy.length} 个）`);
  ok(headers.length === entries.length, `header 与 entries 一一对应（${headers.length} vs ${entries.length}）`);
  if (headers.length) {
    const h = JSON.parse(readFileSync(join(neutralDir, headers[0]), "utf-8"));
    const ePath = join(neutralDir, headers[0].replace(/\.header\.json$/, ".entries.json"));
    const e = existsSync(ePath) ? JSON.parse(readFileSync(ePath, "utf-8")) : null;
    // header 文件的契约形状（neutral-session-store.ts:10）
    ok(typeof h.neutralSessionId === "string" && h.neutralSessionId.length > 0, "header.json 含非空 neutralSessionId");
    ok(typeof h.rootLineageId === "string", `header.json 含 rootLineageId（实际 ${typeof h.rootLineageId}）`);
    ok(h.header && typeof h.header === "object", "header.json 含 header 对象");
    ok(h.header?.kernel === "minimal", `header.kernel = minimal（实际 ${h.header?.kernel}）`);
    ok(h.header?.custom?.model?.kernel === "minimal", "header.custom.model.kernel = minimal（模型域也标了内核）");
    console.log(`  · header.json 字段：${Object.keys(h).join(", ")}；header 内字段：${Object.keys(h.header ?? {}).join(", ")}`);
    if (e) {
      ok(typeof e.neutralSessionId === "string", "entries.json 含 neutralSessionId");
      ok(Array.isArray(e.lineages), `entries.json 的 lineages 是数组（实际 ${typeof e.lineages}）`);
      const flat = (e.lineages ?? []).flatMap((l) => (Array.isArray(l.entries) ? l.entries : []));
      const nEntries = flat.length;
      console.log(`  · entries.json：${(e.lineages ?? []).length} 条 lineage，共 ${nEntries} 个 entry`);
      console.log(`      entry 类型分布：${JSON.stringify(flat.reduce((m, x) => { const k = x.kind ?? x.type ?? "(无kind)"; m[k] = (m[k] ?? 0) + 1; return m; }, {}))}`);
      for (const x of flat) console.log(`        - ${JSON.stringify(x).slice(0, 130)}`);
      // **跨存储对账**。⚠ 正确的不变量不是"两边条数相等"（首版就这么写，直接红）：
      //   中立层是**超集**——它除了内核消息，还记壳侧事件（`role: "divider"` 的模型切换分隔卡、
      //   会话重命名卡），实测 2 轮发送 = 内核侧 4 条 message、中立层 7 个 entry、DOM 7 张卡。
      //   真正的对应关系是下面三条：
      if (kernelFile) {
        const kMsgs = kernelFile.lines.filter((l) => l.type === "message");
        // ① 内核侧每条 message 都能在中立层找到对应条目（按内容对账）
        // 内核侧的 content 可能是字符串，也可能是**内容块数组**（[{type:"text",text:"…"}]）；
        // 中立层是内核无关的，形状可以不同。所以对账比的是**抽取出的文本**，不是原始 JSON——
        // 首版直接比 JSON 串，assistant 条目就假红了（数组 .toString() 得到 "[object Object]"）。
        const textsOf = (content) => {
          if (typeof content === "string") return [content];
          if (Array.isArray(content)) return content.flatMap((b) => textsOf(b?.text ?? b?.content ?? ""));
          if (content && typeof content === "object") return textsOf(content.text ?? "");
          return [];
        };
        const neutralBlob = JSON.stringify(flat);
        for (const m of kMsgs) {
          const texts = textsOf(m.message?.content).map((t) => String(t).trim()).filter((t) => t.length >= 6);
          if (!texts.length) continue;                       // 无文本内容（纯工具调用等）不参与文本对账
          const needle = texts[0].slice(0, 24);
          ok(neutralBlob.includes(needle), `内核侧的 ${m.message?.role} 条目在中立层里有对应（「${needle}」）`);
        }
        // ② 中立层是超集：entry 数 ≥ 内核侧 message 数
        ok(nEntries >= kMsgs.length, `中立层 entry 数（${nEntries}）≥ 内核侧 message 数（${kMsgs.length}）——它是超集`);
        const dividers = flat.filter((x) => x.message?.role === "divider").length;
        console.log(`      其中壳侧 divider ${dividers} 个（模型切换/重命名这类不属内核消息的事件）`);
      }
      // 发出去的每句话也要能在中立层里找到（否则列表/搜索会漏内容）
      for (const text of sent) {
        ok(JSON.stringify(e).includes(text), `「${text}」也在中立层里（列表与搜索读的是这份）`);
      }
      // ③ **文件 ↔ DOM 对应**：时间线渲染的就是中立层这份，条数必须一一对应。
      //   这是本轮最核心的一条——它把"磁盘上写了什么"与"界面上画了什么"直接对账，
      //   任何一侧多算/漏算（折叠、去重、虚拟化窗口）都会在这里暴露。
      const domCards = cards.length;
      ok(nEntries === domCards, `中立层 entry 数 == 时间线渲染的卡片数（文件 ${nEntries} / DOM ${domCards}）`);
    } else {
      note("H", "中立层", "entries 文件缺失", `${headers[0]} 有 header 但没有对应的 .entries.json`);
    }
  }

  // ===== 阶段 G：右面板逐 Tab 体检 =====
  console.log("\n── 阶段 G：右面板各 Tab 内容 ──");
  // 右面板是**多窗格 toggle** 语义（`toggleSidePanelTab`，prefs 里就是 activeSidePanelTabs 数组），
  // 所以① 点已开的 Tab 会把它**关掉**（首版就把默认打开的「收藏」点没了，报"没有内容容器"）；
  //      ② 多个窗格可以同时存在，必须按身份选，不能取"第一个 .overflow-y-auto"
  //        （首版那样做，10 个 Tab 全在审 Review 的内容，可见元素恒为 14 —— 整段空转）。
  // 窗格身份用 react-resizable-panels 渲染出的 `data-panel-id="<贡献项 id>"`（既有锚点，无需改产品）。
  const stripSel = "[data-sidepanel-style] button[aria-pressed]";
  const tabs = await page.evaluate((sel) => [...document.querySelectorAll(sel)]
    .map((b, i) => ({ i, label: b.getAttribute("aria-label") || (b.textContent || "").trim(), pressed: b.getAttribute("aria-pressed") === "true" }))
    .filter((t) => t.label), stripSel);
  console.log(`  · 右面板 Tab ${tabs.length} 个（初始已开 ${tabs.filter((t) => t.pressed).length}）：${tabs.map((t) => t.label + (t.pressed ? "*" : "")).join(" / ")}`);
  // ⚠ 返回**数组**而不是 Set：Set 经 CDP 序列化会变成空对象（实测 `after.has` 不是函数）。
  const panesOf = async () => new Set(await page.evaluate(() => [...document.querySelectorAll("[data-sidepanel-pane]")]
    .filter((p) => p.getBoundingClientRect().height > 0).map((p) => p.getAttribute("data-sidepanel-pane"))));
  let visited = 0;
  for (const t of tabs) {
    const before = await panesOf();
    if (!t.pressed) {
      // 只点未开的（开它）；已开的直接审，不点（点=关）
      const clicked = await page.evaluate(({ sel, label }) => {
        const b = [...document.querySelectorAll(sel)].find((x) => (x.getAttribute("aria-label") || (x.textContent || "").trim()) === label);
        if (!b) return false; b.click(); return true;
      }, { sel: stripSel, label: t.label });
      if (!clicked) { note("M", `右面板/${t.label}`, "Tab 点不开", "按可访问名找不到对应按钮"); continue; }
      await waitForDomIdle(page, { quietMs: 500, timeoutMs: 10000 }).catch(() => {});
    }
    const after = await panesOf();
    const appeared = [...after].filter((x) => !before.has(x));
    // 新出现的窗格就是本次点开的那个；若没有新窗格（本来已开），退化为"当前唯一/最后一个"不可靠，
    // 于是改为：把所有可见窗格都审一遍（去重），保证覆盖且不重复计数。
    const targets = appeared.length ? appeared : [...after];
    for (const pid of targets) {
      const sel = `[data-sidepanel-pane="${pid}"]`;
      const info = await page.evaluate((s) => {
        const root = document.querySelector(s);
        if (!root) return { found: false };
        const vis = (el) => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
        return { found: true, elements: [...root.querySelectorAll("*")].filter(vis).length,
                 text: (root.textContent || "").replace(/\s+/g, " ").trim().slice(0, 64) };
      }, sel);
      if (!info.found) { note("M", `右面板/${t.label}`, "窗格消失", `${pid} 点开后又找不到了`); continue; }
      const r = await auditScope(`右面板/${t.label}#${pid}`, sel);
      if (info.elements <= 1) note("M", `右面板/${t.label}`, "窗格内容近乎为空", `仅 ${info.elements} 个元素，文本「${info.text}」`);
      else console.log(`      [${pid}] 元素=${info.elements} ‹${info.text}›`);
      visited += 1;
    }
  }
  ok(visited > 0, `右面板审了 ${visited} 个窗格（Tab 共 ${tabs.length} 个）`);

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
    if (list.length > 8) console.log(`      …另 ${list.length - 8} 处`);
  }
}
console.log(`\n✅ 断言通过 ${passed} 项；审计发现 ${findings.length} 条（H=${bySev.H.length} M=${bySev.M.length} L=${bySev.L.length}）`);
console.log(`   隔离 HOME: ${home}${args.keep ? "（--keep 保留）" : ""}`);
if (bySev.H.length > 0) process.exitCode = 2;
