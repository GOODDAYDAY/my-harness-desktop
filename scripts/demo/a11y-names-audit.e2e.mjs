#!/usr/bin/env node
// 全应用「可交互元素必须有可访问名」普查 e2e —— a11y 的**面**级守卫。
//
// 为什么单独立一条剧本：图标按钮缺可访问名是**看不见也点不出来**的缺陷——按钮照常显示、
// 照常能点、视觉完全正常，唯一的问题是读屏只会念"按钮"两个字。正向功能剧本永远抓不到它，
// 而逐个组件写单测又覆盖不全（新增一个图标按钮就漏一个）。所以用**普查**：
// 起真 app、走遍所有视图、把每一个可交互元素的可访问名算出来，无名的就是缺陷。
//
// 可访问名按 ARIA 计算顺序的简化版取：`aria-labelledby` → `aria-label` → 元素文本内容 →
// 内部 `img[alt]` / `svg title` → `title` 属性。全部落空 = 无名。
//
// r38 首跑的实测结果（也是本剧本的基线）：23 个视图里无名元素 **12 处、去重后 3 种**，
// 全部集中在两处：① 共享 `Pagination` 部件的左右箭头（纯 ChevronLeft/Right 图标）；
// ② plugin-manager 每行的拖拽手柄（dnd-kit 给了 role=button 与 tabIndex，但里面只有 svg，
// 出现 ×10）。两处都已修（分页部件改为**必填** `prevLabel`/`nextLabel` props，
// 让漏传在编译期暴露；手柄补 `aria-label`），修完普查归零。
// 顺带修了页码按钮缺 `aria-current="page"`（有数字文本所以"有名字"，但听不出是当前页）。
//
// 零 token：不进会话、不发消息。
//
// 用法: npm run build && node scripts/demo/a11y-names-audit.e2e.mjs [--port 9460] [--keep]
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { launchApp, killApp } from "./lib/app.mjs";
import { makeRunRoot, setupBaseline } from "./lib/home.mjs";
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const { values: args } = parseArgs({ options: { port: { type: "string", default: "9460" }, keep: { type: "boolean", default: false } } });
import { seedTestPlugins } from "./lib/test-plugins.mjs";
import { waitForDomIdle } from "./lib/util.mjs";
const runRoot = makeRunRoot(); const home = join(runRoot, "zh-CN");
mkdirSync(home, { recursive: true });
const ctx = setupBaseline({ home, realHome: homedir(), locale: "zh-CN" });
seedTestPlugins(ctx.dataRoot);
const pd = join(home, "project"); mkdirSync(pd, { recursive: true });
const pf = join(ctx.configDir, "config.json");
writeFileSync(pf, JSON.stringify({ ...JSON.parse(readFileSync(pf, "utf-8")), lastCwd: pd }, null, 2));
/** 状态语义普查：分隔条 / 当前项 / 禁用态。
 *  与可访问名普查互补 —— r38 查"有没有名字"，这里查"状态有没有语义"。 */
const SCAN_STATE = () => {
  const separators = [...document.querySelectorAll("[role=separator]")].map((el) => {
    const cs = getComputedStyle(el);
    return {
      label: el.getAttribute("aria-label"),
      orient: el.getAttribute("aria-orientation"),
      valueNow: el.getAttribute("aria-valuenow"),
      tabIndex: el.getAttribute("tabindex"),
      cursor: cs.cursor,
      // 朝向必须与拖拽方向一致：col-resize = 竖向分隔条（分隔左右、水平移动）；
      // row-resize = 横向分隔条（分隔上下、垂直移动）。
      want: cs.cursor === "col-resize" ? "vertical" : cs.cursor === "row-resize" ? "horizontal" : null,
    };
  });
  const currents = [...document.querySelectorAll("[aria-current]")].map((el) => ({
    value: el.getAttribute("aria-current"),
    anchor: [...el.attributes].filter((a) => a.name.startsWith("data-")).map((a) => a.name).slice(0, 2).join(","),
  }));
  // 视觉禁用线索（cursor:not-allowed / 降透明度）却没有语义禁用态的元素
  const fakeDisabled = [...document.querySelectorAll("button,[role=button],[role=menuitem],[role=menuitemradio],a[href],input,select,textarea")]
    .filter((el) => {
      const r = el.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) return false;
      const cs = getComputedStyle(el);
      const looksDisabled = cs.cursor === "not-allowed" || cs.pointerEvents === "none";
      const saysDisabled = el.disabled === true || el.getAttribute("aria-disabled") === "true" || el.hasAttribute("data-disabled");
      return looksDisabled && !saysDisabled;
    })
    .map((el) => ({
      tag: el.tagName.toLowerCase(), role: el.getAttribute("role"),
      text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 30),
      cursor: getComputedStyle(el).cursor,
    }));
  return { separators, currents, fakeDisabled };
};

const app = await launchApp({ appDir: ROOT, port: Number(args.port), env: { HOME: home, MHD_PORT: "18437" }, timeoutMs: 90000 });
const page = app.page;
/** 计算可访问名（简化版 ARIA 计算：aria-labelledby > aria-label > 内容 > title） */
const SCAN = () => {
  const nameOf = (el) => {
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      const t = labelledby.split(/\s+/).map((id) => document.getElementById(id)?.textContent?.trim() ?? "").filter(Boolean).join(" ");
      if (t) return { name: t, via: "aria-labelledby" };
    }
    const al = el.getAttribute("aria-label");
    if (al && al.trim()) return { name: al.trim(), via: "aria-label" };
    const txt = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (txt) return { name: txt, via: "content" };
    const img = el.querySelector("img[alt]");
    if (img?.getAttribute("alt")) return { name: img.getAttribute("alt"), via: "img-alt" };
    const svgTitle = el.querySelector("svg title")?.textContent?.trim();
    if (svgTitle) return { name: svgTitle, via: "svg-title" };
    const ti = el.getAttribute("title");
    if (ti && ti.trim()) return { name: ti.trim(), via: "title" };
    return { name: "", via: null };
  };
  const desc = (el) => {
    const anchors = [...el.attributes].filter((a) => a.name.startsWith("data-")).map((a) => `${a.name}=${String(a.value).slice(0, 24)}`);
    const svg = el.querySelector("svg");
    return {
      anchors: anchors.slice(0, 3).join(","),
      cls: (el.className || "").toString().slice(0, 40),
      icon: svg ? (svg.getAttribute("class") || "").slice(0, 30) : null,
      html: el.innerHTML.replace(/\s+/g, " ").slice(0, 70),
      where: (() => { let n = el; for (let i = 0; i < 6 && n; i++) { const d = [...n.attributes ?? []].find((a) => a.name.startsWith("data-")); if (d) return `${d.name}=${String(d.value).slice(0,20)}`; n = n.parentElement; } return el.closest("aside") ? "sidebar" : el.closest("[role=dialog]") ? "dialog" : "main"; })(),
    };
  };
  const all = [...document.querySelectorAll("button, [role=button], [role=tab], [role=menuitem], [role=menuitemradio], a[href]")];
  const visible = all.filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  const unnamed = visible.map((el) => ({ role: el.getAttribute("role") ?? el.tagName.toLowerCase(), ...nameOf(el), ...desc(el) })).filter((x) => !x.name);
  return { total: all.length, visible: visible.length, unnamed };
};
try {
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 1000, timeoutMs: 25000 });
  const views = [];
  const stateViews = [];
  const r0 = await page.evaluate(SCAN);
  views.push(["聊天页", r0]);
  stateViews.push(["聊天页", await page.evaluate(SCAN_STATE)]);
  // 打开设置页并走遍所有 TAB
  await page.evaluate(() => document.querySelector('[data-sidebar-entry="settings"]')?.click());
  await waitForDomIdle(page, { quietMs: 800, timeoutMs: 15000 }).catch(() => {});
  const tabs = await page.evaluate(() => [...document.querySelectorAll("[data-settings-id]")].map((e) => e.getAttribute("data-settings-id")));
  for (const id of tabs) {
    await page.evaluate((i) => [...document.querySelectorAll("[data-settings-id]")].find((e) => e.getAttribute("data-settings-id") === i)?.click(), id);
    await waitForDomIdle(page, { quietMs: 600, timeoutMs: 10000 }).catch(() => {});
    // 该条目下的每个 TAB 也走一遍
    const sub = await page.evaluate(() => [...document.querySelectorAll("[data-settings-tab]")].map((e) => e.getAttribute("data-settings-tab")));
    for (const st of sub) {
      await page.evaluate((s) => document.querySelector(`[data-settings-tab="${s}"]`)?.click(), st);
      await waitForDomIdle(page, { quietMs: 500, timeoutMs: 8000 }).catch(() => {});
      views.push([`设置/${id}/${st}`, await page.evaluate(SCAN)]);
    stateViews.push([`设置/${id}/${st}`, await page.evaluate(SCAN_STATE)]);
    }
    if (sub.length === 0) views.push([`设置/${id}`, await page.evaluate(SCAN)]);
    if (sub.length === 0) stateViews.push([`设置/${id}`, await page.evaluate(SCAN_STATE)]);
  }
  let passed = 0;
  const ok = (cond, label, detail) => {
    if (!cond) throw new Error(`断言失败: ${label}${detail !== undefined ? `（现场：${JSON.stringify(detail)?.slice(0, 400)}）` : ""}`);
    passed += 1; console.log(`  ✓ ${label}`);
  };
  let totUnnamed = 0;
  const seen = new Map();
  for (const [where, r] of views) {
    totUnnamed += r.unnamed.length;
    for (const u of r.unnamed) {
      const k = `${u.role}|${u.anchors}|${u.icon}|${u.html.slice(0, 40)}`;
      if (!seen.has(k)) seen.set(k, { ...u, firstSeen: where, count: 0 });
      seen.get(k).count++;
    }
  }
  console.log(`\n══ 普查了 ${views.length} 个视图 ══`);
  ok(views.length >= 12, `确实走遍了足够多的视图（实际 ${views.length} 个；太少说明导航没生效，判据会空转）`);
  const totals = views.map(([, r]) => r.visible);
  ok(totals.every((n) => n > 0), "每个视图都扫到了可交互元素（有 0 的视图说明该页没渲染出来）");
  console.log(`  · 可交互元素总数（按视图）：${totals.reduce((a, b) => a + b, 0)}；无名 ${totUnnamed} 处（去重后 ${seen.size} 种）`);
  ok(totUnnamed === 0, `**所有可交互元素都有可访问名**（无名 ${totUnnamed} 处）`, [...seen.values()].slice(0, 6));
  for (const [k, u] of [...seen].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  ×${u.count} [${u.role}] @${u.firstSeen}\n       anchors=${u.anchors || "-"} icon=${u.icon || "-"}\n       html=${u.html}\n       位置=${u.where}`);
  }
  // ── 状态语义断言（r39）──
  console.log("\n── 状态语义 ──");
  const allSep = stateViews.flatMap(([w, r]) => r.separators.map((x) => ({ ...x, w })));
  const uniqSep = [...new Map(allSep.map((x) => [`${x.label}|${x.cursor}`, x])).values()];
  console.log(`  · 分隔条（去重）：${JSON.stringify(uniqSep.map((x) => ({ label: x.label, orient: x.orient, want: x.want, cursor: x.cursor, tab: x.tabIndex })))}`);
  ok(uniqSep.length > 0, "确实扫到了分隔条（否则这几条判据空转）");
  ok(uniqSep.every((x) => !!x.label && x.label.length > 0),
    `每个分隔条都有可访问名（缺名的 ${uniqSep.filter((x) => !x.label).length} 个 —— 读屏只会念「分隔条 19」，不知道分隔的是什么）`);
  ok(uniqSep.every((x) => !!x.orient),
    `每个分隔条都显式声明 aria-orientation（缺省值 horizontal 对 col-resize 的手柄是**错的**；缺的 ${uniqSep.filter((x) => !x.orient).length} 个）`);
  const wrongOrient = uniqSep.filter((x) => x.want && x.orient !== x.want);
  ok(wrongOrient.length === 0,
    `aria-orientation 与拖拽方向一致（col-resize⇒vertical、row-resize⇒horizontal；不一致 ${wrongOrient.length} 个）`,
    wrongOrient.map((x) => ({ label: x.label, cursor: x.cursor, orient: x.orient, want: x.want })));
  ok(uniqSep.every((x) => x.tabIndex === "0"), "每个分隔条都可键盘聚焦（tabIndex=0，否则键盘用户调不了布局）");
  ok(uniqSep.every((x) => x.valueNow !== null), "每个分隔条都暴露 aria-valuenow（当前比例可被读到）");

  const allCur = stateViews.flatMap(([, r]) => r.currents);
  const badCurrent = allCur.filter((c) => c.value !== "true" && c.value !== "page" && c.value !== "step" && c.value !== "location" && c.value !== "date" && c.value !== "time");
  ok(badCurrent.length === 0, `aria-current 的取值合法（true/page/step/…；非法 ${badCurrent.length} 个）`, badCurrent.slice(0, 4));
  const falseCurrent = allCur.filter((c) => c.value === "false");
  ok(falseCurrent.length === 0, `不该出现 aria-current="false"（那等于给每个元素都挂一个状态属性，是噪音；实际 ${falseCurrent.length} 个）`);

  const allFake = stateViews.flatMap(([w, r]) => r.fakeDisabled.map((x) => ({ ...x, w })));
  const uniqFake = [...new Map(allFake.map((x) => [`${x.tag}|${x.role}|${x.text}`, x])).values()];
  console.log(`  · 视觉禁用但语义未禁用（去重）：${uniqFake.length} 种`);
  ok(uniqFake.length === 0,
    `**视觉上的禁用线索必须配语义禁用态**（cursor:not-allowed / pointer-events:none 却没有 disabled 或 aria-disabled；${uniqFake.length} 种）`,
    uniqFake.slice(0, 6));

  console.log(`\n✅ PASS: ${passed} 项断言；无名可交互元素 ${totUnnamed} 处`);
  console.log(`   隔离 HOME: ${home}${args.keep ? "（--keep 保留）" : ""}`);
} catch (err) {
  console.error(`\n❌ FAIL: ${err.message}`);
  process.exitCode = 1;
} finally { await killApp(app); }
