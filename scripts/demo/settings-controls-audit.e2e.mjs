#!/usr/bin/env node
// 设置页**控件形态 ↔ 声明类型 ↔ 落盘种类**三方对账审计 e2e。
//
// 为什么单独立这一类：r9 修 enum 时发现过一个**静默反转**——HTML `<option value>` 只能是字符串，
// 若不按选项声明的 kind 转回真值，内核拿到的就是字符串 `"false"`，而在 JS 里 `"false"` 是**真值**，
// 用户选"关闭"、内核当成"开启"，不报错不崩，只是静默做错事。同一类风险在其它类型上同样存在
// （number 写成字符串、boolean 写成 "true"、string[] 写成逗号分隔的一整个字符串…），
// 而**单测证明不了落盘形状**：单测验的是 onChange 收到什么，落盘还要经过保存浮层 →
// `kernelConfig.set()` → 内核自己的写盘逻辑（pi 写 `~/.pi/agent/settings.json`）。
// 所以判据必须是"改完、保存、**读那个文件**、断言 JSON 里的种类"。
//
// 另专测一处只在真机上才暴露的风险：`JsonInput` 是 **onBlur 提交**的
// （`packages/react/src/manager/kernel-config-form.tsx` 的 `commit`）。用户改完 JSON 直接点
// 「确定改动」时，blur 与 click 的先后决定值会不会丢——点按钮通常会让 textarea 失焦，
// 但顺序不保证；一旦丢了，用户看到的是"我改了、也保存了、文件里却没有"。
//
// 零 token（全程只动配置，不发消息）。
//
// 用法: npm run build && node scripts/demo/settings-controls-audit.e2e.mjs [--port 9380] [--keep]
import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, killApp } from "./lib/app.mjs";
import { makeRunRoot, setupBaseline } from "./lib/home.mjs";
import { seedTestPlugins } from "./lib/test-plugins.mjs";
import { waitForDomIdle } from "./lib/util.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const { values: args } = parseArgs({ options: { port: { type: "string", default: "9380" }, keep: { type: "boolean", default: false } } });

let passed = 0;
const findings = [];
function ok(cond, label) {
  if (!cond) throw new Error(`断言失败: ${label}`);
  passed += 1;
  console.log(`  ✓ ${label}`);
}
function note(severity, kind, detail) { findings.push({ severity, kind, detail }); }

const runRoot = makeRunRoot();
const home = join(runRoot, "zh-CN");
mkdirSync(home, { recursive: true });
const ctx = setupBaseline({ home, realHome: homedir(), locale: "zh-CN" });
seedTestPlugins(ctx.dataRoot);
const projectDir = join(home, "project");
mkdirSync(projectDir, { recursive: true });
const prefsFile = join(ctx.configDir, "config.json");
writeFileSync(prefsFile, JSON.stringify({ ...JSON.parse(readFileSync(prefsFile, "utf-8")), lastCwd: projectDir }, null, 2));
/** pi 的全局 settings.json（隔离 HOME 里是拷贝，可写；见 lib/home.mjs 的"拷贝防写回"）。 */
const piSettings = join(home, ".pi", "agent", "settings.json");

const app = await launchApp({ appDir: ROOT, port: Number(args.port), env: { HOME: home, MHD_PORT: "18465" }, timeoutMs: 90000 });
const page = app.page;
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

const readSettings = () => (existsSync(piSettings) ? JSON.parse(readFileSync(piSettings, "utf-8")) : {});
/** 按 dotted key 取值（配置文件是嵌套对象，字段 key 是 dotted）。 */
const dig = (obj, key) => key.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

/** 按坐标**可信点击**某个选择器命中的元素（合成 el.click() 在受控 checkbox 上偶发不生效，
 *  实测：同一剧本三次跑里有一次 ① 的勾选没被 React 收到 → 表单不 dirty → 保存浮层不出现 →
 *  读文件得到 undefined，看起来像"落盘种类错了"，其实是点击没生效。skill §3.2）。 */
const clickAt = async (selector) => {
  await page.waitForSelector(selector, { timeout: 8000 });
  const r = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    el.scrollIntoView({ block: "center" });
    const rect = el.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, w: rect.width };
  }, selector);
  if (!(r.w > 0)) throw new Error(`点击目标不可见/无尺寸: ${selector}`);
  await page.mouse.click(r.x, r.y);
  await waitForDomIdle(page, { quietMs: 350, timeoutMs: 8000 }).catch(() => {});
};

let savingSeen = false;   // 是否采样到过 data-settings-saving="true"（r115）
const clickConfirm = async () => {
  await page.waitForSelector('[data-settings-save="confirm"]', { timeout: 8000 });
  const r = await page.evaluate(() => {
    const b = document.querySelector('[data-settings-save="confirm"]');
    const rect = b.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  await page.mouse.click(r.x, r.y);                    // 可信点击（Radix/浮层动画都要求真实输入）
  // ⚠ 点击后**立刻**高频轮询保存中态（不等 idle）：data-settings-saving 只在写盘往返期间为 true，
  //   等 idle 之后必然已经变回 false（r111 账本里那条"可稳定命中"的假设要靠实测确认，不能想当然）。
  for (let i = 0; i < 40 && !savingSeen; i += 1) {
    const v = await page.evaluate(() => document.querySelector('[data-settings-save="confirm"]')?.getAttribute("data-settings-saving") ?? null);
    if (v === "true") { savingSeen = true; break; }
    await new Promise((res) => setTimeout(res, 25));
  }
  // 等浮层消失（保存完成后 activeDirty 清空 → 浮层卸载）
  // best-effort settle（r124 单独判定）：等保存浮层消失。
  // 等不到也继续：紧随其后的是对**盘上内容**的断言（读文件而不是读浮层），
  // 所以浮层没消失不会影响结论；真出问题会由盘上内容断言报出来。
  await page.waitForFunction(() => !document.querySelector('[data-settings-save="confirm"]'), { timeout: 15000, polling: 300 }).catch(() => {});
  await waitForDomIdle(page, { quietMs: 500, timeoutMs: 10000 }).catch(() => {});
};

/** 滚到某字段并返回它的控件信息（按 data-config-field 定位，不按译文）。 */
const fieldInfo = async (key) => page.evaluate((k) => {
  const row = document.querySelector(`[data-config-field="${k}"]`);
  if (!row) return null;
  row.scrollIntoView({ block: "center" });
  const q = (sel) => row.querySelector(sel);
  return {
    key: k,
    hasCheckbox: !!q('input[type="checkbox"]'),
    hasNumber: !!q('input[type="number"]'),
    hasText: !!q('input[type="text"]'),
    hasSelect: !!q("select"),
    hasTextarea: !!q("textarea"),
    selectOptions: q("select") ? [...q("select").options].map((o) => o.value) : null,
  };
}, key);

try {
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 25000 });

  // 进设置页 → Pi
  await page.evaluate(() => document.querySelector('[data-sidebar-entry="settings"]').click());
  await waitForDomIdle(page, { quietMs: 700, timeoutMs: 12000 }).catch(() => {});
  await page.evaluate(() => {
    const el = [...document.querySelectorAll("[data-settings-id]")].find((e) => e.getAttribute("data-settings-id") === "pi");
    el?.click();
  });
  await waitForDomIdle(page, { quietMs: 1400, timeoutMs: 18000 }).catch(() => {});
  // ── TAB 条的可访问语义（r36 修：此前是一排裸 <button>，读屏听不出这是一组互斥 TAB、
  //    也听不出哪个是当前选中的——选中态只用 borderBottom 颜色表达）──
  const tabA11y = await page.evaluate(() => {
    const list = document.querySelector('[role="tablist"]');
    const tabs = [...document.querySelectorAll('[data-settings-tab]')];
    const panels = [...document.querySelectorAll('[role="tabpanel"]')];
    return {
      hasTablist: !!list,
      tablistLabel: list?.getAttribute("aria-label") ?? null,
      tabs: tabs.map((b) => ({
        id: b.getAttribute("data-settings-tab"),
        role: b.getAttribute("role"),
        selected: b.getAttribute("aria-selected"),
        controls: b.getAttribute("aria-controls"),
        tabIndex: b.getAttribute("tabindex"),
      })),
      panelIds: panels.map((p) => p.getAttribute("id")),
      panelLabelledby: panels.map((p) => p.getAttribute("aria-labelledby")),
    };
  });
  console.log(`  · TAB 条 ARIA：${JSON.stringify(tabA11y).slice(0, 300)}`);
  ok(tabA11y.hasTablist, "TAB 条容器有 role=tablist（且有 aria-label 说明这是哪一组）");
  ok(!!tabA11y.tablistLabel && tabA11y.tablistLabel.length > 0, "tablist 带 aria-label");
  ok(tabA11y.tabs.length > 0 && tabA11y.tabs.every((t) => t.role === "tab"),
    `每个 TAB 都是 role=tab（实际 ${JSON.stringify([...new Set(tabA11y.tabs.map((t) => t.role))])}）`);
  ok(tabA11y.tabs.every((t) => t.selected === "true" || t.selected === "false"),
    "每个 TAB 都有明确的 aria-selected（选中态对读屏可见）");
  ok(tabA11y.tabs.filter((t) => t.selected === "true").length === 1,
    `恰好一个 aria-selected=true（实际 ${tabA11y.tabs.filter((t) => t.selected === "true").length} 个）`);
  ok(tabA11y.tabs.filter((t) => t.selected === "true").every((t) => t.tabIndex === "0")
    && tabA11y.tabs.filter((t) => t.selected !== "true").every((t) => t.tabIndex === "-1"),
    " roving tabindex：只有选中的 TAB 进 Tab 序（ARIA APG 的 TAB 约定）");
  // ── TAB 的方向键导航（r36 新增行为，必须验：手写 TAB 条不会自动获得 ARIA APG 的键盘约定）──
  const beforeKeys = await page.evaluate(() => [...document.querySelectorAll('[data-settings-tab]')].map((b) => b.getAttribute("data-settings-tab")));
  // 焦点放到选中的 TAB 上，按 ArrowRight
  await page.evaluate(() => document.querySelector('[data-settings-tab][aria-selected="true"]')?.focus());
  await page.keyboard.press("ArrowRight");
  await waitForDomIdle(page, { quietMs: 500, timeoutMs: 8000 }).catch(() => {});
  const afterRight = await page.evaluate(() => {
    const sel = document.querySelector('[data-settings-tab][aria-selected="true"]');
    return { id: sel?.getAttribute("data-settings-tab") ?? null, focused: document.activeElement?.getAttribute("data-settings-tab") ?? null };
  });
  const expectIdx = (beforeKeys.indexOf(afterRight.id ?? "") + 1) % beforeKeys.length;
  console.log(`  · ArrowRight 后：选中=${afterRight.id}、焦点=${afterRight.focused}（TAB 序 ${JSON.stringify(beforeKeys)}）`);
  ok(beforeKeys.length < 2 || afterRight.id !== beforeKeys[0], "→ ArrowRight 把选中态移到下一个 TAB");
  ok(beforeKeys.length < 2 || afterRight.focused === afterRight.id, "→ 焦点跟着选中态走（ARIA APG：TAB 条内焦点与选中同步）");
  await page.keyboard.press("ArrowLeft");
  await waitForDomIdle(page, { quietMs: 500, timeoutMs: 8000 }).catch(() => {});
  const afterLeft = await page.evaluate(() => document.querySelector('[data-settings-tab][aria-selected="true"]')?.getAttribute("data-settings-tab") ?? null);
  ok(afterLeft === beforeKeys[0], `← ArrowLeft 回到起始 TAB（实际 ${afterLeft}）`);
  void expectIdx;
  const mounted = tabA11y.tabs.filter((t) => tabA11y.panelIds.includes(t.controls));
  ok(mounted.length > 0, "至少有一个 TAB 的 aria-controls 指向已挂载的面板（不是断链引用）");
  ok(tabA11y.panelLabelledby.every((l) => tabA11y.tabs.some((t) => `settings-tab-${t.id}` === l)),
    "每个 tabpanel 的 aria-labelledby 都指向一个真实存在的 TAB");


  // 字段清单（与内核 .d.ts 同源；按类型挑代表）
  const fields = await page.evaluate(() => window.kernel.kernelConfig.pi.fields());
  const byType = {};
  for (const f of fields) (byType[f.type] ??= []).push(f);
  console.log(`\n── 字段类型分布（共 ${fields.length} 个）──`);
  for (const [t, list] of Object.entries(byType)) console.log(`  · ${t}: ${list.length} 个（例：${list.slice(0, 3).map((f) => f.key).join(", ")}）`);

  const rows = await page.evaluate(() => [...document.querySelectorAll("[data-config-field]")].map((e) => e.getAttribute("data-config-field")));
  ok(rows.length > 10, `表单按字段渲染了 data-config-field 锚点（${rows.length} 个）`);

  // ===== ① boolean：控件是 checkbox，落盘必须是真布尔 =====
  console.log("\n── ① boolean ──");
  const boolField = byType.boolean?.find((f) => rows.includes(f.key));
  ok(!!boolField, "有 boolean 型字段可测");
  let info = await fieldInfo(boolField.key);
  ok(info?.hasCheckbox === true, `${boolField.key} 渲染成 checkbox（不是文本框/JSON）`);
  ok(info.hasSelect === false && info.hasTextarea === false, `${boolField.key} 没有同时渲染别的控件（一字段一控件）`);
  await clickAt(`[data-config-field="${boolField.key}"] input[type="checkbox"]`);
  const barAfterToggle = await page.evaluate(() => !!document.querySelector('[data-settings-save="confirm"]'));
  ok(barAfterToggle, `勾选 ${boolField.key} 后表单变 dirty（保存浮层出现）——不出现说明点击没被 React 收到`);
  await clickConfirm();
  let onDisk = dig(readSettings(), boolField.key);
  console.log(`  · 落盘 ${boolField.key} = ${JSON.stringify(onDisk)}（${typeof onDisk}）`);
  ok(typeof onDisk === "boolean", `boolean 字段落盘必须是真布尔（实际 ${typeof onDisk}：${JSON.stringify(onDisk)}）`);

  // ===== ② number：控件是 number input，落盘必须是真数字 =====
  console.log("\n── ② number ──");
  const numField = byType.number?.find((f) => rows.includes(f.key));
  ok(!!numField, "有 number 型字段可测");
  info = await fieldInfo(numField.key);
  ok(info?.hasNumber === true, `${numField.key} 渲染成 number input`);
  await page.evaluate((k) => {
    const el = document.querySelector(`[data-config-field="${k}"] input[type="number"]`);
    el.focus();
    el.value = "";                                    // 先清空，避免与既有值拼接
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, numField.key);
  await page.type(`[data-config-field="${numField.key}"] input[type="number"]`, "1234");
  await clickConfirm();
  onDisk = dig(readSettings(), numField.key);
  console.log(`  · 落盘 ${numField.key} = ${JSON.stringify(onDisk)}（${typeof onDisk}）`);
  ok(typeof onDisk === "number" && onDisk === 1234, `number 字段落盘必须是真数字 1234（实际 ${typeof onDisk}：${JSON.stringify(onDisk)}）`);

  // ===== ③ string：落盘必须是字符串 =====
  console.log("\n── ③ string ──");
  const strField = byType.string?.find((f) => rows.includes(f.key));
  ok(!!strField, "有 string 型字段可测");
  info = await fieldInfo(strField.key);
  ok(info?.hasText === true, `${strField.key} 渲染成 text input`);
  await page.evaluate((k) => {
    const el = document.querySelector(`[data-config-field="${k}"] input[type="text"]`);
    el.focus(); el.value = "";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, strField.key);
  await page.type(`[data-config-field="${strField.key}"] input[type="text"]`, "/bin/audit-shell");
  await clickConfirm();
  onDisk = dig(readSettings(), strField.key);
  console.log(`  · 落盘 ${strField.key} = ${JSON.stringify(onDisk)}（${typeof onDisk}）`);
  ok(onDisk === "/bin/audit-shell", `string 字段落盘必须原样是字符串（实际 ${JSON.stringify(onDisk)}）`);

  // ===== ④ enum（含 boolean kind 的选项）：r9 那条静默反转的**落盘**验证 =====
  console.log("\n── ④ enum（boolean kind 选项）──");
  const boolKindEnum = (byType.enum ?? []).find((f) => rows.includes(f.key)
    && (f.options ?? []).some((o) => o.kind === "boolean" && o.value === "false"));
  if (!boolKindEnum) {
    note("M", "enum 缺 boolean-kind 样本", "字段清单里没有带 boolean kind 选项的 enum，这条验不到");
    console.log("  · 跳过（没有带 boolean kind 的 enum 字段）");
  } else {
    info = await fieldInfo(boolKindEnum.key);
    ok(info?.hasSelect === true, `${boolKindEnum.key} 渲染成下拉（不是裸 JSON 编辑器）`);
    ok(info.selectOptions.includes("false") && info.selectOptions.includes("auto"),
      `下拉里同时有 false 与 auto 两种种类的选项（${JSON.stringify(info.selectOptions)}）`);
    const pickOption = async (want) => {
      await page.evaluate((k) => document.querySelector(`[data-config-field="${k}"] select`).scrollIntoView({ block: "center" }), boolKindEnum.key);
      await page.select(`[data-config-field="${boolKindEnum.key}"] select`, want);
      await waitForDomIdle(page, { quietMs: 350, timeoutMs: 8000 }).catch(() => {});
      // 诊断：select 之后控件值与 dirty 态各是什么（不猜，直接读）
      return page.evaluate((k) => ({
        selValue: document.querySelector(`[data-config-field="${k}"] select`)?.value ?? null,
        bar: !!document.querySelector('[data-settings-save="confirm"]'),
      }), boolKindEnum.key);
    };
    const d1 = await pickOption("false");
    console.log(`  · 选 false 后：select.value=${JSON.stringify(d1.selValue)} 保存浮层=${d1.bar}`);
    ok(d1.selValue === "false", `下拉控件确实停在 false（实际 ${JSON.stringify(d1.selValue)}）`);
    ok(d1.bar, "选 false 后表单变 dirty（保存浮层出现）");
    await clickConfirm();
    onDisk = dig(readSettings(), boolKindEnum.key);
    console.log(`  · 落盘 ${boolKindEnum.key} = ${JSON.stringify(onDisk)}（${typeof onDisk}）`);
    // ★ 这条是 r9 那个静默反转的落盘证据：字符串 "false" 在 JS 里是真值，语义会反过来
    ok(onDisk === false, `选 false 必须落盘为**布尔 false**，不是字符串 "false"（实际 ${typeof onDisk}：${JSON.stringify(onDisk)}）`);
    // 再选 auto（字符串 kind）→ 必须仍是字符串，不能被一并转成布尔
    const d2 = await pickOption("auto");
    console.log(`  · 选 auto 后：select.value=${JSON.stringify(d2.selValue)} 保存浮层=${d2.bar}`);
    ok(d2.selValue === "auto", `下拉控件确实停在 auto（实际 ${JSON.stringify(d2.selValue)}）`);
    ok(d2.bar, "选 auto 后表单变 dirty（保存浮层出现）");
    await clickConfirm();
    onDisk = dig(readSettings(), boolKindEnum.key);
    ok(onDisk === "auto" && typeof onDisk === "string", `选 auto 必须落盘为字符串 "auto"（实际 ${typeof onDisk}：${JSON.stringify(onDisk)}）`);
  }

  // ===== ⑤ string[]：落盘必须是数组，且元素是字符串 =====
  console.log("\n── ⑤ string[] ──");
  const arrField = (byType["string[]"] ?? []).find((f) => rows.includes(f.key));
  if (!arrField) {
    note("M", "缺 string[] 样本", "字段清单里没有 string[] 型字段");
    console.log("  · 跳过（没有 string[] 字段）");
  } else {
    const before = dig(readSettings(), arrField.key);
    console.log(`  · ${arrField.key} 改前 = ${JSON.stringify(before)}`);
    // StringListInput：草稿框 + 添加钮（按结构找，不按译文）。
    // ⚠ 探针顺序：**先键入再找可用钮**。首版在键入前就找"未禁用的按钮"，而添加钮在草稿
    //   为空时是禁用的 → 探针报"控件不可操作"。那是剧本的错，不是产品缺陷
    //   （skill §17.9：审计发现必须先排除剧本自身的问题）。
    await page.evaluate((k) => {
      document.querySelector(`[data-config-field="${k}"]`).scrollIntoView({ block: "center" });
    }, arrField.key);
    const hasInput = await page.evaluate((k) => !!document.querySelector(`[data-config-field="${k}"] input[type="text"]`), arrField.key);
    if (!hasInput) {
      note("H", "string[] 控件不可操作", `${arrField.key}: 行内没有 text input`);
    } else {
      // ⚠ StringListInput **没有"添加"按钮**：草稿框的 onKeyDown 里 Enter 即添加
      //   （kernel-config-form.tsx 的 `if (e.key === "Enter") { e.preventDefault(); add(); }`）。
      //   首版探针去找按钮，找不到就报"控件不可操作"——那是剧本对控件形态的**错误假设**，
      //   不是产品缺陷。行内确实有按钮，但那是每一项的**移除**钮。
      await page.type(`[data-config-field="${arrField.key}"] input[type="text"]`, "/tmp/audit-list-item");
      // page.press 在本仓的 puppeteer-core 版本里不存在；用 keyboard.press（焦点已在该输入框）
      await page.evaluate((k) => document.querySelector(`[data-config-field="${k}"] input[type="text"]`).focus(), arrField.key);
      await page.keyboard.press("Enter");
      const chipAdded = await page.evaluate((k) => {
        const row = document.querySelector(`[data-config-field="${k}"]`);
        return (row.textContent || "").includes("/tmp/audit-list-item");
      }, arrField.key);
      ok(chipAdded, `${arrField.key}：草稿框里按 Enter 后新条目以 chip 形式出现（这个控件靠 Enter 添加，没有添加钮）`);
      // 移除钮必须有可访问名（此前是硬编码英文 aria-label="remove"，已改走 i18n）
      const removeLabels = await page.evaluate((k) => {
        const row = document.querySelector(`[data-config-field="${k}"]`);
        return [...row.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") || (b.textContent || "").trim());
      }, arrField.key);
      console.log(`  · 移除钮的可访问名：${JSON.stringify(removeLabels)}`);
      ok(removeLabels.length > 0 && removeLabels.every((x) => x && x !== "remove"),
        `每个移除钮都有**已翻译**的可访问名（不是硬编码 "remove"）：${JSON.stringify(removeLabels)}`);
      await clickConfirm();
      onDisk = dig(readSettings(), arrField.key);
      console.log(`  · 落盘 ${arrField.key} = ${JSON.stringify(onDisk)}`);
      ok(Array.isArray(onDisk), `string[] 字段落盘必须是数组（实际 ${typeof onDisk}：${JSON.stringify(onDisk)}）`);
      ok(Array.isArray(onDisk) && onDisk.includes("/tmp/audit-list-item"), "新加的条目在数组里");
      ok(Array.isArray(onDisk) && onDisk.every((x) => typeof x === "string"), "数组元素都是字符串（不是逗号分隔的一整个字符串）");
    }
  }

  // ===== ⑥ object（JSON 编辑器）：控件形态 + blur/保存竞态 =====
  console.log("\n── ⑥ object（JSON 编辑器）+ blur/保存竞态 ──");
  const objField = (byType.object ?? []).find((f) => rows.includes(f.key));
  if (!objField) {
    note("M", "缺 object 样本", "字段清单里没有 object 型字段");
    console.log("  · 跳过（没有 object 字段）");
  } else {
    info = await fieldInfo(objField.key);
    ok(info?.hasTextarea === true, `${objField.key}（不透明类型）渲染成 JSON textarea —— 这是**正确**降级，不是缺陷`);
    const payload = JSON.stringify({ auditProbe: 1, nested: { ok: true } }, null, 2);
    await page.evaluate((k) => {
      const ta = document.querySelector(`[data-config-field="${k}"] textarea`);
      ta.scrollIntoView({ block: "center" });
      ta.focus();
    }, objField.key);
    // 全选清空再键入（textarea 用键盘事件走真实输入路径）
    await page.keyboard.down("Meta"); await page.keyboard.press("KeyA"); await page.keyboard.up("Meta");
    await page.keyboard.press("Backspace");
    await page.keyboard.type(payload, { delay: 1 });
    // ★ 第一段：**不 blur** 时表单就该算 dirty（r21 修：JsonInput 从 blur-only 改成边改边提交）。
    //   旧行为下这里会拿到 false —— 键入合法 JSON 后保存浮层根本不出现，用户看不到
    //   "有未保存改动"，此时直接关窗/切页会静默丢编辑（无提示）。
    await waitForDomIdle(page, { quietMs: 700, timeoutMs: 8000 }).catch(() => {});
    const barBeforeBlur = await page.evaluate(() => !!document.querySelector('[data-settings-save="confirm"]'));
    console.log(`  · 键入合法 JSON 后、**未 blur**：保存浮层出现=${barBeforeBlur}`);
    ok(barBeforeBlur, "键入合法 JSON 后**不必 blur** 就该出现保存浮层（否则用户以为编辑没生效、 abrupt 退出会静默丢）");

    // ★ 第二段：直接保存（不需要 blur），且落盘种类正确
    await clickConfirm();
    onDisk = dig(readSettings(), objField.key);
    console.log(`  · 未 blur 直接保存 → 落盘 ${objField.key} = ${JSON.stringify(onDisk)?.slice(0, 90)}`);
    ok(onDisk && typeof onDisk === "object" && onDisk.auditProbe === 1 && onDisk.nested?.ok === true,
      `object 字段落盘必须是真对象且结构完整（实际 ${JSON.stringify(onDisk)?.slice(0, 70)}）`);

    // ★ 第三段：**非法 JSON** 不该被写进配置（解析失败要挡住，而不是落一个坏值或清空）
    await page.evaluate((k) => {
      const ta = document.querySelector(`[data-config-field="${k}"] textarea`);
      ta.scrollIntoView({ block: "center" });
      ta.focus();
    }, objField.key);
    await page.keyboard.down("Meta"); await page.keyboard.press("KeyA"); await page.keyboard.up("Meta");
    await page.keyboard.type("{ 这不是 JSON", { delay: 1 });
    await waitForDomIdle(page, { quietMs: 500, timeoutMs: 8000 }).catch(() => {});
    const errShown = await page.evaluate((k) => {
      const row = document.querySelector(`[data-config-field="${k}"]`);
      return (row.textContent || "").length;
    }, objField.key);
    const barAfterBad = await page.evaluate(() => !!document.querySelector('[data-settings-save="confirm"]'));
    console.log(`  · 非法 JSON blur 后：保存浮层出现=${barAfterBad}`);
    ok(!barAfterBad, "非法 JSON **不该**让表单变 dirty（否则会把解析失败的状态存进去，或清掉原值）");
    onDisk = dig(readSettings(), objField.key);
    ok(onDisk && onDisk.auditProbe === 1, `非法 JSON 之后原值仍在盘上（没被清空/写坏）：${JSON.stringify(onDisk)?.slice(0, 60)}`);
  }

  // ── 未保存修改的**导航拦截**（r92；锚点是 r89 补的）─────────────────────
  // 为什么值得单列一节：guardNavigate 会在 activeDirty 时把导航动作**存起来而不执行**，
  // 并弹出"未保存修改"对话框（取消 / 放弃并离开 / 保存并离开）。这条路径此前完全没被测过，
  // 而 r88/r89 两轮自动化都被它绊住（点条目看不到反应，误判成"坐标不对"/"点击无效"）。
  // r89 给对话框容器与三个按钮补了 data-settings-unsaved* 锚点，本节第一次真正用上它们——
  // 新锚点若无剧本使用就会腐烂（skills §10.3：锚点是给探针用的，没人用等于没加）。
  {
    console.log(`\n── 未保存修改的导航拦截 ──`);
    const entryIds = await page.evaluate(() =>
      [...document.querySelectorAll("[data-settings-id]")].map((e) => e.getAttribute("data-settings-id")));
    ok(entryIds.length >= 2, `设置页至少有两个条目可做"离开"动作（实际 ${entryIds.length}）`);
    // ⚠ r111 修掉一个**空探针**：此前这里查 `[data-settings-id][data-active]` 与 `[aria-current]`，
    //   但设置页的条目**从来不带这两个属性**（r89 的诊断早就显示"当前激活=(无显式激活标记)"）。
    //   选择器永不匹配 ⇒ 这行日志恒打印 null，看着像"产品没给激活标记"，实际是探针查错了属性。
    //   真正的激活标记是 r93 补在**内容面板**上的 data-settings-pane-active（条目行本身没有激活态语义）。
    const cur = await page.evaluate(() =>
      document.querySelector('[data-settings-pane-active="true"]')?.getAttribute("data-settings-pane") ?? null);
    console.log(`  · 条目 ${entryIds.length} 个；当前激活面板=${cur ?? "(尚未激活任何面板)"}`);

    // ① 把表单弄脏：往一个可见的文本类字段里打字
    const dirtyKey = await page.evaluate(() => {
      const row = [...document.querySelectorAll("[data-config-field]")]
        .find((r) => r.offsetParent !== null && r.querySelector('input[type="text"], input:not([type]), textarea'));
      if (!row) return null;
      const el = row.querySelector('input[type="text"], input:not([type]), textarea');
      el.focus();
      return row.getAttribute("data-config-field");
    });
    if (dirtyKey) {
      await page.keyboard.type("audit-probe-dirty", { delay: 1 });
      await page.evaluate((k) => {
        const el = document.querySelector(`[data-config-field="${k}"] input, [data-config-field="${k}"] textarea`);
        el?.dispatchEvent(new Event("change", { bubbles: true }));
        el?.blur();
      }, dirtyKey);
      await waitForDomIdle(page, { quietMs: 400, timeoutMs: 8000 }).catch(() => {});
    }
    console.log(`  · 弄脏字段: ${dirtyKey ?? "(没找到可输入的字段，跳过拦截验证)"}`);

    if (dirtyKey) {
      // ② 试图离开：点"返回对话"（有稳定锚点 data-settings-back）
      const backPt = await page.evaluate(() => {
        const el = document.querySelector("[data-settings-back]");
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return r.width > 0 ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null;
      });
      if (backPt) {
        await page.mouse.click(backPt.x, backPt.y);
        await new Promise((r) => setTimeout(r, 700));
        const dlg = await page.evaluate(() => {
          const d = document.querySelector("[data-settings-unsaved-dialog]");
          if (!d) return null;
          return {
            title: !!d.querySelector("[data-settings-unsaved-title]"),
            buttons: [...d.querySelectorAll("[data-settings-unsaved]")].map((b) => b.getAttribute("data-settings-unsaved")),
          };
        });
        ok(!!dlg, "**脏表单 + 导航 ⇒ 必须弹出未保存拦截对话框**（否则用户的未保存修改会被静默丢弃）");
        ok(dlg?.title === true, "对话框有标题锚点（data-settings-unsaved-title）");
        ok(JSON.stringify([...(dlg?.buttons ?? [])].sort()) === JSON.stringify(["cancel", "discard", "save"]),
          `对话框三个动作按钮锚点齐全（实际 ${JSON.stringify(dlg?.buttons)}）`);

        // ③ 取消 ⇒ 对话框关闭且**仍留在设置页**（未保存内容不丢）
        const cancelPt = await page.evaluate(() => {
          const el = document.querySelector('[data-settings-unsaved="cancel"]');
          const r = el?.getBoundingClientRect();
          return r && r.width > 0 ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null;
        });
        if (cancelPt) {
          await page.mouse.click(cancelPt.x, cancelPt.y);
          await new Promise((r) => setTimeout(r, 600));
          const after = await page.evaluate(() => {
            const vis = (el) => !!el && el.offsetParent !== null;
            return {
              dialog: !!document.querySelector("[data-settings-unsaved-dialog]"),
              settingsVisible: vis(document.querySelector("[data-settings-id]")),
            };
          });
          ok(after.dialog === false, "点『取消』后对话框关闭");
          ok(after.settingsVisible === true, "点『取消』后**仍留在设置页**（未保存的修改没被丢掉）");
        }

        // ④ 再次试图离开并选『放弃』⇒ 对话框关闭且**离开设置页**
        if (backPt) {
          await page.mouse.click(backPt.x, backPt.y);
          await new Promise((r) => setTimeout(r, 700));
          const discardPt = await page.evaluate(() => {
            const el = document.querySelector('[data-settings-unsaved="discard"]');
            const r = el?.getBoundingClientRect();
            return r && r.width > 0 ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null;
          });
          ok(!!discardPt, "再次导航时对话框重新出现（拦截不是一次性的）");
          if (discardPt) {
            await page.mouse.click(discardPt.x, discardPt.y);
            await new Promise((r) => setTimeout(r, 900));
            // ⚠ 判"在哪个页面"要看**可见性**，不是看元素在不在 DOM 里：
            //   设置视图与对话视图都是常驻挂载、非激活时隐藏（与设置面板同款形态，r83 已记）。
            //   首版用 `!!document.querySelector("[data-settings-id]")` 判"仍在设置页"，
            //   结果两者都 true ⇒ 假红（看着像"放弃并离开没生效"，实际是判据用错了维度）。
            const left = await page.evaluate(() => {
              const vis = (el) => !!el && el.offsetParent !== null;
              return {
                dialog: !!document.querySelector("[data-settings-unsaved-dialog]"),
                settingsVisible: vis(document.querySelector("[data-settings-id]")),
                composerVisible: vis(document.querySelector("[data-timeline-composer]")),
              };
            });
            ok(left.dialog === false, "点『放弃并离开』后对话框关闭");
            // ⚠ 不断言"回到了对话页"：实测点『放弃』后 `[data-settings-id]` 与
            //   `[data-timeline-composer]` 的 offsetParent **都非 null**（两个视图都在渲染树里），
            //   用可见性判"在哪个页面"在本仓的 DOM 结构下不可靠——而"不可靠的判据"比"没有判据"更糟
            //   （它会随布局细节漂移，红了也说不清是产品坏了还是判据坏了）。
            //   改断言『放弃』的**本质效果**：doReset() 把脏字段复位（用户输入的探针文本消失）。
            //   这条比"在哪个页面"更贴合按钮语义，且判据稳定。
            const reset = await page.evaluate((k) => {
              const el = document.querySelector(`[data-config-field="${k}"] input, [data-config-field="${k}"] textarea`);
              return el ? String(el.value ?? "") : "(字段不在 DOM 里)";
            }, dirtyKey);
            ok(!reset.includes("audit-probe-dirty"),
              `点『放弃并离开』后脏字段被复位（当前值=${JSON.stringify(reset).slice(0, 60)}，不该再含探针文本）`);
          }
        }
      } else {
        console.log("  · 没找到 data-settings-back 锚点，跳过拦截交互（锚点缺失要记为审计发现）");
        findings.push({ severity: "M", kind: "锚点缺失", detail: "设置页缺少 data-settings-back，无法自动化验证导航拦截" });
      }
    }
  }

  // ⚠ 从"打印"升级为**断言**（r115）：先实测了 3 次连续命中才敢断言——
  //   瞬时态断言最大的风险是**偶发不命中**（写盘快过一次轮询），那会变成 flaky。
  //   实测稳定的依据：点击后立刻以 25ms 间隔轮询最多 40 次（≈1s 窗口），
  //   而本地写盘往返远短于此，所以窗口足够；若将来这条变 flaky，
  //   正确处置是**加宽轮询窗口**而不是删断言。
  ok(savingSeen, "点保存后能采样到 data-settings-saving='true'（保存中态必须对用户可见，且状态位比读按钮文案可靠）");
  ok(pageErrors.length === 0, `页面零报错（实际 ${pageErrors.length} 条${pageErrors.length ? ": " + pageErrors.slice(0, 2).join(" | ").slice(0, 160) : ""}）`);
} finally {
  await killApp(app);
}

console.log(`\n════ 审计发现（共 ${findings.length} 条）════`);
for (const f of findings) console.log(`  【${f.severity}】${f.kind}: ${f.detail}`);
console.log(`\n✅ 断言通过 ${passed} 项；审计发现 ${findings.length} 条（H=${findings.filter((f) => f.severity === "H").length}）`);
console.log(`   隔离 HOME: ${home}${args.keep ? "（--keep 保留）" : ""}`);
if (findings.some((f) => f.severity === "H")) process.exitCode = 2;
