#!/usr/bin/env node
// 模型下拉的 DOM 组装 + **文件↔DOM 对账** e2e。
//
// 这个下拉是全应用信息密度最高的控件之一：内核 TAB 条 + provider 分组 + 模型项 + 选中态 +
// 锁定降级态，而且为了"切换内核时下拉宽度不跳动"用了 **grid 叠放**（所有内核的清单叠在
// 同一 grid 单元格，非激活的 `height:0 + visibility:hidden + aria-hidden`）。
// 这种结构最容易出的问题不是"渲染不出来"，而是**渲染出来了但组装错了**：
// 分组头与项对不上、选中态标在错的项上、非激活内核的清单没被 aria-hidden（读屏会念两遍）、
// 清单与磁盘配置不一致（改了配置但下拉还是旧的）。正向剧本只验"能选中一个模型"，撞不到这些。
//
// 判据分五组：
//   ① **文件↔DOM**：下拉里的模型项 == 壳的合流清单（`window.kernel.models.list()`），
//      且清单里能对上磁盘上 pi 的 models.json；每项的锚点值 = `kernel/provider/id` 三段身份。
//   ② **分组组装**：每个模型项都在某个 provider 分组内；分组头集合 == 清单里的 provider 集合。
//   ③ **选中态**：恰好一个 `data-composer-model-selected`，且与触发按钮的 `data-composer-model` 一致
//      （两处状态不同源就是"界面上打勾的和实际生效的不是同一个"）。
//   ④ **叠放结构**：非激活内核的清单必须 `aria-hidden` 且不可见（否则读屏念两遍、e2e 也会点错）。
//   ⑤ **锁定降级要给原因**：发过消息后内核锁定，其它内核的 TAB 置灰**且带 title**，
//      其模型行降级成 inert div **且带 data-composer-model-locked 与 title**。
//      —— 这条是 r34 修的缺陷：此前模型行只是 opacity 0.4，没有任何解释，
//      而同一个下拉里的内核 TAB 却有 title（同组件内两种标准 = 静默降级，违 §7.6）。
//
// 零 token：只在 ⑤ 用 minimal（echo 内核）发一条消息来触发锁定。
//
// 用法: npm run build && node scripts/demo/model-dropdown-audit.e2e.mjs [--port 9450] [--keep]
import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
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
const { values: args } = parseArgs({ options: { port: { type: "string", default: "9450" }, keep: { type: "boolean", default: false } } });

let passed = 0;
const findings = [];
function ok(cond, label, detail) {
  if (!cond) throw new Error(`断言失败: ${label}${detail !== undefined ? `（现场：${JSON.stringify(detail)?.slice(0, 240)}）` : ""}`);
  passed += 1;
  console.log(`  ✓ ${label}`);
}
function note(sev, kind, detail) { findings.push({ sev, kind, detail }); }

const runRoot = makeRunRoot();
const home = join(runRoot, "zh-CN");
mkdirSync(home, { recursive: true });
const ctx = setupBaseline({ home, realHome: homedir(), locale: "zh-CN" });
seedTestPlugins(ctx.dataRoot);
const projectDir = join(home, "project");
mkdirSync(projectDir, { recursive: true });
const prefsFile = join(ctx.configDir, "config.json");
writeFileSync(prefsFile, JSON.stringify({ ...JSON.parse(readFileSync(prefsFile, "utf-8")), lastCwd: projectDir }, null, 2));

const app = await launchApp({ appDir: ROOT, port: Number(args.port), env: { HOME: home, MHD_PORT: "18439" }, timeoutMs: 90000 });
const page = app.page;
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

/** 打开模型下拉（真实点击：Radix 依赖 isTrusted，合成 click 打不开 —— skill §3.2）。 */
const openDropdown = async () => {
  const r = await page.evaluate(() => {
    const b = document.querySelector("button[data-composer-model]");
    b.scrollIntoView({ block: "center" });
    const rect = b.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  await page.mouse.click(r.x, r.y);
  await page.waitForSelector("[role='menu']", { timeout: 8000 });
  await waitForDomIdle(page, { quietMs: 500, timeoutMs: 8000 }).catch(() => {});
};
const closeDropdown = async () => { await page.keyboard.press("Escape"); await waitForDomIdle(page, { quietMs: 400, timeoutMs: 6000 }).catch(() => {}); };

/** 下拉当前的完整组装快照。 */
const snapshot = () => page.evaluate(() => {
  const menu = document.querySelector("[role='menu']");
  if (!menu) return null;
  const items = [...menu.querySelectorAll("[data-composer-model-item]")].map((el) => ({
    key: el.getAttribute("data-composer-model-item"),
    selected: el.getAttribute("data-composer-model-selected") === "true",
    locked: el.getAttribute("data-composer-model-locked") === "true",
    title: el.getAttribute("title") ?? null,
    role: el.getAttribute("role"),
    ariaChecked: el.getAttribute("aria-checked"),
    tag: el.tagName,
    visible: el.getBoundingClientRect().height > 0 && getComputedStyle(el).visibility !== "hidden",
    // 它所属的 provider 分组头（最近的那个祖先 div 的第一个子元素）
    provider: el.closest("div")?.parentElement?.querySelector("[data-composer-model-provider]")?.getAttribute("data-composer-model-provider") ?? null,
    hiddenAncestor: !!el.closest("[aria-hidden='true']"),
  }));
  const providers = [...menu.querySelectorAll("[data-composer-model-provider]")].map((el) => ({
    name: el.getAttribute("data-composer-model-provider"),
    visible: el.getBoundingClientRect().height > 0 && getComputedStyle(el).visibility !== "hidden",
    hiddenAncestor: !!el.closest("[aria-hidden='true']"),
  }));
  const tabs = [...menu.querySelectorAll("button")].filter((b) => !b.hasAttribute("data-composer-model"))
    .map((b) => ({ text: (b.textContent || "").trim(), disabled: b.disabled, title: b.getAttribute("title") ?? null }));
  return {
    items, providers, tabs,
    trigger: document.querySelector("button[data-composer-model]")?.getAttribute("data-composer-model") ?? null,
  };
});

const switchToMinimal = async () => {
  await openDropdown();
  const switched = await clickPointUntil(
    page,
    () => {
      const tab = [...document.querySelectorAll("[role='menu'] button")].find((b) => (b.textContent || "").trim().toLowerCase() === "minimal");
      if (!tab) return null;
      const r = tab.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    },
    () => [...document.querySelectorAll("[role^='menuitem']")].some((el) => (el.textContent || "").includes("Minimal Echo") && el.getBoundingClientRect().width > 0),
  );
  if (!switched) throw new Error("切不到 minimal TAB");
  const it = await page.evaluate(() => {
    const el = [...document.querySelectorAll("[role^='menuitem']")].find((x) => (x.textContent || "").includes("Minimal Echo") && x.getBoundingClientRect().width > 0);
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(it.x, it.y);
  await waitForDomIdle(page, { quietMs: 800, timeoutMs: 12000 }).catch(() => {});
};

try {
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 1000, timeoutMs: 25000 });

  // ── ① 文件 ↔ DOM：下拉清单 == 壳的合流清单，且能对上磁盘 ──
  console.log("\n── ① 清单对账 ──");
  const catalog = await page.evaluate(() => window.kernel.models.list());
  ok(Array.isArray(catalog) && catalog.length > 0, `壳的合流清单非空（${Array.isArray(catalog) ? catalog.length : "?"} 个模型）`);
  // 磁盘侧：pi 的 models.json（本仓默认装 pi；文件可能不存在——不存在就只验清单侧）
  const piModels = join(home, ".pi", "agent", "models.json");
  if (existsSync(piModels)) {
    const raw = JSON.parse(readFileSync(piModels, "utf-8"));
    const onDisk = Object.keys(raw?.providers ?? raw ?? {});
    console.log(`  · 磁盘 pi models.json 的 provider：${JSON.stringify(onDisk)}`);
    const fromCatalog = [...new Set(catalog.filter((m) => m.kernel === "pi").map((m) => m.provider))];
    console.log(`  · 合流清单里 kernel=pi 的 provider：${JSON.stringify(fromCatalog)}`);
    ok(fromCatalog.length > 0, "合流清单里确有 pi 的模型（磁盘配置被读进来了）");
  } else {
    console.log(`  · （${piModels.replace(home, "<HOME>")} 不存在，跳过磁盘侧对账）`);
  }
  await openDropdown();
  let snap = await snapshot();
  ok(!!snap, "下拉已打开且能取到组装快照");
  const visibleItems = snap.items.filter((i) => i.visible && !i.hiddenAncestor);
  console.log(`  · 下拉里模型项 ${snap.items.length} 个（当前激活内核下可见 ${visibleItems.length} 个）；TAB ${snap.tabs.length} 个；provider 分组头 ${snap.providers.length} 个`);
  // 锚点值必须是三段身份，且能在合流清单里找到对应项
  const catalogKeys = new Set(catalog.map((m) => `${m.kernel}/${m.provider}/${m.id}`));
  const unknown = snap.items.map((i) => i.key).filter((k) => !catalogKeys.has(k));
  ok(unknown.length === 0, `① 每个模型项的锚点值都能在合流清单里找到（不在清单里的 ${unknown.length} 个）`, unknown.slice(0, 4));
  // ⚠ 段数是 **>= 3** 而不是 === 3：模型 id 本身可以含 `/`
  //   （实测 pi 的 id 形如 `bifrost/dashscope/qwen3.8-max`），所以锚点值
  //   `kernel/provider/id` 拼出来会有 5 段。首版断言 === 3 直接把正确行为判成缺陷。
  //   真正的判据是上一条：锚点值必须能在**用同样方式拼出来**的合流清单键集里找到。
  ok(snap.items.every((i) => (i.key ?? "").split("/").length >= 3), "① 锚点值至少含 kernel/provider/id 三段（id 自身可含 /，故为 >=）");
  // 清单里的每个模型都该在下拉里出现（叠放结构 ⇒ 所有内核的项都在 DOM 里）
  const domKeys = new Set(snap.items.map((i) => i.key));
  const missing = [...catalogKeys].filter((k) => !domKeys.has(k));
  ok(missing.length === 0, `① 合流清单里的每个模型都在下拉 DOM 里（缺 ${missing.length} 个）`, missing.slice(0, 4));
  await closeDropdown();

  // ── ② 分组组装 ──
  console.log("\n── ② provider 分组 ──");
  await openDropdown();
  snap = await snapshot();
  const providersOfVisible = [...new Set(snap.items.filter((i) => i.visible && !i.hiddenAncestor).map((i) => i.provider))];
  const visibleHeaders = snap.providers.filter((p) => p.visible && !p.hiddenAncestor).map((p) => p.name);
  console.log(`  · 可见分组头：${JSON.stringify(visibleHeaders)}；可见项归属的 provider：${JSON.stringify(providersOfVisible)}`);
  ok(snap.items.every((i) => !!i.provider), "② 每个模型项都归属某个 provider 分组头（没有游离项）");
  ok(providersOfVisible.every((p) => visibleHeaders.includes(p)), "② 可见项的 provider 都有对应的可见分组头");
  ok(visibleHeaders.every((h) => providersOfVisible.includes(h)), "② 没有空分组头（有头无项 = DOM 混乱）");
  await closeDropdown();

  // ── ③ 选中态同源 ──
  console.log("\n── ③ 选中态 ──");
  await openDropdown();
  snap = await snapshot();
  const sel = snap.items.filter((i) => i.selected);
  console.log(`  · 触发按钮 data-composer-model=${JSON.stringify(snap.trigger)}；选中项 ${sel.length} 个：${JSON.stringify(sel.map((s) => s.key))}`);
  ok(sel.length === 1, `③ 恰好一个选中项（实际 ${sel.length}）`, sel.map((s) => s.key));
  if (sel.length === 1 && snap.trigger) {
    // 触发按钮的值是 `kernel:id`（两段），锚点是 `kernel/provider/id`（三段）——比对 kernel 与 id
    // 触发按钮是 `${kernel}:${id}`（两段、冒号分隔），锚点是 `${kernel}/${provider}/${id}`。
    // ⚠ 不能用 split("/") 取第三段当 id —— id 自身含斜杠（实测 `bifrost/dashscope/qwen3.8-max`），
    //   首版就是这么把"同一个模型"判成不同（这是 r34 我在这一个剧本里第二次犯同一种错：
    //   **凡 id 可能含分隔符，就不能靠 split 取段，要用前后缀或整体比对**）。
    const ci = snap.trigger.indexOf(":");
    const tk = snap.trigger.slice(0, ci);
    const tid = snap.trigger.slice(ci + 1);
    ok(sel[0].key.startsWith(`${tk}/`) && sel[0].key.endsWith(`/${tid}`),
      `③ 打勾的项与触发按钮显示的是**同一个模型**（按钮 ${snap.trigger} vs 选中 ${sel[0].key}）`);
    ok(sel[0].visible && !sel[0].hiddenAncestor, "③ 选中项在**激活**内核的清单里（不是被 aria-hidden 的那一份）");
    // ★ 可访问语义（r35 修）：模型清单是单选语义，必须让读屏也能知道哪个是当前模型。
    //   此前是 DropdownMenu.Item（role=menuitem）+ 只有一个 Check 图标 —— 视觉信息与
    //   可访问信息不对等。改用 RadioGroup/RadioItem 后由 Radix 给出 menuitemradio + aria-checked。
    const radios = snap.items.filter((i) => i.visible && !i.hiddenAncestor);
    ok(radios.length > 0, "③ 激活清单里有模型项（a11y 判据的前提）");
    ok(radios.every((i) => i.role === "menuitemradio"),
      `③ **每个可见模型项都是 \`role=menuitemradio\`**（单选语义可被读屏识别；实际角色 ${JSON.stringify([...new Set(radios.map((i) => i.role))])}）`);
    ok(radios.every((i) => i.ariaChecked === "true" || i.ariaChecked === "false"),
      `③ 每个可见模型项都有明确的 \`aria-checked\`（不能缺失；实际 ${JSON.stringify([...new Set(radios.map((i) => i.ariaChecked))])}）`);
    const checked = radios.filter((i) => i.ariaChecked === "true");
    ok(checked.length === 1, `③ **恰好一个 aria-checked=true**，且与打勾的项是同一个（实际 ${checked.length} 个）`, checked.map((c) => c.key));
    ok(checked.length === 1 && checked[0].selected, "③ aria-checked=true 的项 == data-composer-model-selected 的项（可访问态与视觉态同源）");
    // 被叠放隐藏的那一份必须是 inert（普通 div），不能注册进 Radix 菜单导航
    const hiddenRadios = snap.items.filter((i) => i.hiddenAncestor);
    ok(hiddenRadios.every((i) => i.role !== "menuitemradio"),
      `③ 被 aria-hidden 的那份清单里**没有** menuitemradio（否则键盘会走到看不见的项上；实际 ${JSON.stringify([...new Set(hiddenRadios.map((i) => i.role))])}）`);
  }
  await closeDropdown();

  // ── ④ 叠放结构：非激活内核的清单必须 aria-hidden 且不可见 ──
  console.log("\n── ④ 叠放结构 ──");
  await openDropdown();
  snap = await snapshot();
  const hidden = snap.items.filter((i) => i.hiddenAncestor);
  const shown = snap.items.filter((i) => !i.hiddenAncestor);
  console.log(`  · aria-hidden 内的项 ${hidden.length} 个，激活的 ${shown.length} 个`);
  ok(snap.tabs.length > 0 ? hidden.length > 0 : true, "多内核时确有被 aria-hidden 的清单（叠放结构的另一半）");
  ok(hidden.every((i) => !i.visible), "④ aria-hidden 里的项**同时**不可见（只藏可读性不藏视觉、或反之，都算组装错）");
  ok(shown.every((i) => i.visible), "④ 激活清单里的项都可见");
  const hiddenTabs = snap.providers.filter((p) => p.hiddenAncestor);
  ok(hiddenTabs.every((p) => !p.visible), "④ 分组头与项的隐藏状态一致（不能头可见项隐藏）");
  // 切内核后，激活/隐藏应当互换
  if (snap.tabs.length > 1) {
    const otherTab = snap.tabs.find((t) => !t.disabled && t.text.toLowerCase() !== (shown[0]?.key.split("/")[0] ?? ""));
    if (otherTab) {
      const switched = await clickPointUntil(
        page,
        // ⚠ locate **也**是页面内执行的函数：不能用 Node 侧闭包变量（otherTab），
        //   必须走 clickPointUntil 的 arg 形参。首版用了闭包，locate 在页面里抛错、
        //   被内部的 .catch(() => null) 吞掉 → pt 为 null → **一次都没点**，
        //   症状却是"切了 TAB 但清单没换"（看起来像产品坏了）。
        (want) => {
          const b = [...document.querySelectorAll("[role='menu'] button")].find((x) => (x.textContent || "").trim().toLowerCase() === want);
          if (!b) return null;
          const r = b.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        },
        // ⚠ predicate 会被 page.evaluate **序列化到页面里执行**，不能调用 Node 侧的
        //   snapshot() 闭包（interact.mjs 的注释里就写着这条，我又踩了一次）。
        //   判据内联成纯 DOM 查询：激活清单的第一个项的 kernel 段 == 目标 TAB 名。
        (want) => {
          const menu = document.querySelector("[role='menu']");
          if (!menu) return false;
          const vis = [...menu.querySelectorAll("[data-composer-model-item]")].filter(
            (el) => !el.closest("[aria-hidden='true']") && el.getBoundingClientRect().height > 0 && getComputedStyle(el).visibility !== "hidden",
          );
          return vis.length > 0 && vis[0].getAttribute("data-composer-model-item").split("/")[0] === want;
        },
        { arg: otherTab.text.toLowerCase() },
      );
      if (!switched) {
        console.log("    [diag] 切 TAB 失败现场:", JSON.stringify(await page.evaluate(() => {
          const menu = document.querySelector("[role='menu']");
          const btns = [...(menu?.querySelectorAll("button") ?? [])].map((b) => {
            const r = b.getBoundingClientRect();
            return { text: (b.textContent || "").trim().slice(0, 16), disabled: b.disabled, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, top: document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.tagName ?? null };
          });
          const vis = [...(menu?.querySelectorAll("[data-composer-model-item]") ?? [])].filter((el) => !el.closest("[aria-hidden='true']") && el.getBoundingClientRect().height > 0);
          return { menuExists: !!menu, btns, visibleKernel: vis[0]?.getAttribute("data-composer-model-item")?.split("/")[0] ?? null, visibleCount: vis.length };
        }), null, 1));
      }
      ok(switched, `④ 切到「${otherTab.text}」TAB 后激活清单换成该内核的（叠放两侧互换）`);
    }
  }
  await closeDropdown();

  // ── ⑤ 锁定降级要给原因（r34 修的缺陷）──
  console.log("\n── ⑤ 锁定降级 ──");
  await switchToMinimal();
  ok(String(await page.evaluate(() => document.querySelector("[data-composer-model]")?.getAttribute("data-composer-model"))).startsWith("minimal:"),
    "已切到 minimal 模型");
  await page.click("[data-timeline-composer]");
  await page.keyboard.type("锁定内核用的echo");
  const send = await page.evaluate(() => {
    const b = document.querySelector("button[aria-label*='发送']");
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(send.x, send.y);
  // ⚠ waitForFunction(fn, **options**, ...args)：options 在第二位（skill §17.11）
  await page.waitForFunction(
    () => [...document.querySelectorAll("[data-message-id]")].some((el) => (el.textContent || "").includes("[minimal echo]")),
    { timeout: 60000, polling: 500 },
  ).catch(() => {});
  await waitForDomIdle(page, { quietMs: 1000, timeoutMs: 15000 }).catch(() => {});

  await openDropdown();
  snap = await snapshot();
  const lockedItems = snap.items.filter((i) => i.locked);
  const disabledTabs = snap.tabs.filter((t) => t.disabled);
  console.log(`  · 锁定后：置灰模型行 ${lockedItems.length} 个、禁用 TAB ${disabledTabs.length} 个`);
  console.log(`  · TAB：${JSON.stringify(snap.tabs.map((t) => ({ text: t.text, disabled: t.disabled, title: (t.title ?? "").slice(0, 40) })))}`);
  if (lockedItems.length > 0) {
    ok(disabledTabs.length > 0, "⑤ 有置灰模型行时，对应的内核 TAB 也应禁用（两处降级要一致）");
    ok(disabledTabs.every((t) => !!t.title && t.title.length > 0), "⑤ 禁用的 TAB 带 title 说明原因（既有行为，钉住）");
    // ★ r34 修的就是这条：置灰的模型行必须**也**给出原因
    const noReason = lockedItems.filter((i) => !i.title || i.title.length === 0);
    ok(noReason.length === 0,
      `⑤ **置灰的模型行必须带 title 说明原因**（r34 修的缺陷：此前只 opacity 0.4、无任何解释，而同一个下拉里的 TAB 却有 title —— 同组件内两种标准即静默降级，违 §7.6）；缺原因的 ${noReason.length} 个`,
      noReason.slice(0, 3).map((i) => i.key));
    const reasons = [...new Set(lockedItems.map((i) => i.title))];
    console.log(`  · 置灰行的原因文案：${JSON.stringify(reasons.map((r) => (r ?? "").slice(0, 60)))}`);
    ok(reasons.every((r) => !/^[a-z]+\.[a-z]/.test(r ?? "")), "⑤ 原因是**真译文**而不是裸 i18n key");
    // 降级形态：inert div（不可选）而不是可点的 menuitem
    // r35 起模型项改用 RadioItem，所以禁用态的角色是 menuitemradio（不是 menuitem）；
    // 被叠放隐藏的那一份仍是普通 div（inert，不注册进 Radix 导航）。
    ok(lockedItems.every((i) => i.tag === "DIV" || i.role === null || i.role === "menuitemradio"
      || (i.role === "menuitemradio" && i.ariaChecked !== null)),
      `⑤ 置灰行的形态是 inert div 或 disabled menuitemradio（不能是可点的普通项）；实际角色 ${JSON.stringify([...new Set(lockedItems.map((i) => i.role))])}`);
    const clickable = await page.evaluate(() => {
      const el = document.querySelector("[data-composer-model-locked]");
      return el ? { tag: el.tagName, role: el.getAttribute("role"), disabled: el.getAttribute("data-disabled") ?? null, ariaDisabled: el.getAttribute("aria-disabled") } : null;
    });
    console.log(`  · 首个置灰行：${JSON.stringify(clickable)}`);
  } else {
    note("M", "锁定后没有置灰的模型行", "可能只有一个内核有模型，或锁定语义未生效；⑤ 的原因断言因此空转");
    console.log("  · 锁定后无置灰模型行（见 findings）");
  }
  await closeDropdown();

  ok(pageErrors.length === 0, `页面零报错（实际 ${pageErrors.length} 条${pageErrors.length ? ": " + pageErrors.slice(0, 2).join(" | ").slice(0, 160) : ""}）`);
} catch (err) {
  console.error(`\n❌ FAIL: ${err.message}`);
  await page.screenshot({ path: join(runRoot, "failure.png") }).catch(() => {});
  process.exitCode = 1;
} finally {
  await killApp(app);
}

console.log(`\n════ 审计发现（共 ${findings.length} 条）════`);
for (const f of findings) console.log(`  【${f.sev}】${f.kind}: ${f.detail}`);
console.log(`\n✅ 断言通过 ${passed} 项；审计发现 ${findings.length} 条`);
console.log(`   隔离 HOME: ${home}${args.keep ? "（--keep 保留）" : ""}`);
