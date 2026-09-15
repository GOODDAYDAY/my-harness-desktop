#!/usr/bin/env node
// review ↔ timeline 跨插件契约 e2e(设计 docs/design/session-scope.md §3.3.1)。
//
// 被守的契约:review 的 Overlay 把评论篮经 `timeline:composerAttachments` invoke 给 timeline,
// payload 带 `sessionKey`;timeline 用**自己的** curKey 比对,不对齐就不显示、不拼接。
// 批 4 把两侧的身份来源都改了(review 从手拼 `ns ?? new:cwd` 改成 useCurrentScopeKey(),
// timeline 从手拼改成同一个 scopeKey)——两侧必须同源,否则评论篮在输入框上方**永远不显示**
// (静默失败:没有报错,只是附件条不出现,用户以为评论没加上)。
//
// 这条链路此前**零断言覆盖**(review-comments 场景是纯 GIF 录制,record.mjs 无断言原语)。
//
// 覆盖:
//   ① 划词 → 评论入篮 → 输入框上方出现引用条(跨插件契约成立)
//   ② 篮内计数/文案正确(两条评论)
//   ③ 切到另一个会话 → 附件条消失(评论篮按会话隔离,不串台)
//   ④ 切回原会话 → 附件条复活(篮子还在,且仍与 timeline 对齐)
//   ⑤ 删除单条 → 计数跟着变(BasketBar 按 payload.sessionKey 操作,跨路径一致)
//
// 零 token(不发送;划词与 DOM 交互)。
// 用法:npm run build && node scripts/demo/review-basket-key.e2e.mjs [--port=9402] [--keep]
import { parseArgs } from "node:util";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assertPortFree, launchApp, killApp } from "./lib/app.mjs";
import { makeRunRoot, setupBaseline } from "./lib/home.mjs";
import { waitForDomIdle } from "./lib/util.mjs";
import { writeSessionFile } from "./lib/seed/session-writer.mjs";
import { selectAcross } from "./lib/interact.mjs";
import { locate } from "./lib/locate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const { values: args } = parseArgs({ options: { port: { type: "string", default: "9402" }, keep: { type: "boolean", default: false } } });
const PORT = Number(args.port);
const APP_PORT = 18425;

let passed = 0;
function ok(cond, label, detail) {
  if (!cond) throw new Error(`断言失败: ${label}${detail !== undefined ? ` — 实际 ${JSON.stringify(detail)}` : ""}`);
  passed += 1;
  console.log(`  ✓ ${label}`);
}

const NAME_A = "评论甲";
const NAME_B = "评论乙";
const MARK_A = "BASKET-A-MARK";
const MARK_B = "BASKET-B-MARK";
const LONG_A = "这是甲会话里一段足够长的正文,用来划词选中并加评论,内容要跨越多个字符才能选得出片段。";
const COMMENT_1 = "第一条评论意见";
const COMMENT_2 = "第二条评论意见";

const seedRows = (name, mark, long) => [
  { type: "message", message: { role: "user", stopReason: "end_turn", content: [{ type: "text", text: mark }] } },
  { type: "session_info", name },
  { type: "message", message: { role: "assistant", stopReason: "end_turn", content: [{ type: "text", text: long }] } },
];

if (!existsSync(join(ROOT, "out", "main", "index.js"))) {
  console.error("未找到 out/ 构建产物,先跑: npm run build");
  process.exit(1);
}

const runRoot = makeRunRoot();
const home = join(runRoot, "zh-CN");
mkdirSync(home, { recursive: true });
const ctx = setupBaseline({ home, realHome: homedir(), locale: "zh-CN" });
const proj = join(home, "proj");
mkdirSync(proj, { recursive: true });
ctx.writeConfig("projects", { recentCwds: [proj] });
ctx.setPrefs({ lastCwd: proj });
writeFileSync(join(home, ".pi", "agent", "models.json"), JSON.stringify({ providers: {} }));
writeSessionFile(ctx.agentDir, proj, seedRows(NAME_A, MARK_A, LONG_A), 1, ctx.defaultModel);
writeSessionFile(ctx.agentDir, proj, seedRows(NAME_B, MARK_B, "乙会话的正文"), 1, ctx.defaultModel);

const shotsDir = join(runRoot, "shots");
mkdirSync(shotsDir, { recursive: true });
let shotN = 0;

await assertPortFree(PORT);
const app = await launchApp({ appDir: ROOT, port: PORT, env: { HOME: home, MHD_PORT: String(APP_PORT) }, timeoutMs: 90000 });
const page = app.page;
const shot = async (name) => { shotN += 1; await page.screenshot({ path: join(shotsDir, `${String(shotN).padStart(2, "0")}-${name}.png`) }); };

async function clickEl(selector, textIncludes) {
  const rect = await page.evaluate(({ sel, text }) => {
    const els = [...document.querySelectorAll(sel)];
    const el = text ? els.find((e) => (e.textContent || "").includes(text)) : els[0];
    if (!el) return null;
    el.scrollIntoView({ block: "nearest" });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, { sel: selector, text: textIncludes ?? null });
  if (!rect) throw new Error(`未找到可点元素: ${selector}${textIncludes ? ` (含「${textIncludes}」)` : ""}`);
  await page.mouse.click(rect.x, rect.y);
  await waitForDomIdle(page, { quietMs: 300, timeoutMs: 5000 }).catch(() => {});
}
async function openSession(name, mark) {
  await page.waitForFunction((n) => [...document.querySelectorAll("[data-session-path]")].some((el) => (el.textContent || "").includes(n)), { timeout: 25000, polling: 300 }, name);
  await clickEl("[data-session-path]", name);
  await page.waitForFunction((m) => [...document.querySelectorAll("[data-message-id]")].some((el) => (el.textContent || "").includes(m)), { timeout: 20000, polling: 300 }, mark);
}
/** 评论附件条(BasketBar,由 composerAttachments 槽渲染在输入框上方)的文本。
 *
 *  定位纪律:不能用「页面含 ❝」——那个符号在三处组件都有(BasketBar 的引用条、
 *  ReviewAuxBlock 会话流引用条、划词浮层的引用预览)。用 BasketBar **独有**的
 *  「清空全部」按钮当锚点,取它的容器文本,才精确对应附件条本身。 */
/** 划词 → 点「评论」浮钮 → 键入 → Enter 入篮(一次完整交互)。
 *
 *  三条实踩纪律:
 *  ① 先按 Esc 清掉上一轮可能残留的划词浮钮——页面上可能同时有两个「评论」按钮,
 *     `find` 会命中残留的那个(点了不开编辑器,实测超时)。
 *  ② 浮钮取**最后一个**匹配(最新划词产生的那个),且用全等匹配避开「评论 2 条」这类文案。
 *  ③ 锚点文本要用 DOM 里**完整可见**的片段:引用预览只留前 30 字,靠后的 slice 找不到。 */
async function addComment(anchorText, fromFx, toFx, comment) {
  await page.keyboard.press("Escape");
  await waitForDomIdle(page, { quietMs: 300, timeoutMs: 4000 }).catch(() => {});
  const loc = await locate(page, { text: anchorText, contains: true });
  await selectAcross(page, loc, { fromFx, toFx });
  await waitForDomIdle(page, { quietMs: 500, timeoutMs: 5000 }).catch(() => {});
  const btn = await page.evaluate(() => {
    const all = [...document.querySelectorAll("button")].filter((b) => (b.textContent || "").trim() === "评论");
    const b = all[all.length - 1];        // 取最新那个
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, count: all.length };
  });
  if (!btn) throw new Error("划词后没有出现「评论」浮钮");
  await page.mouse.click(btn.x, btn.y);
  await waitForDomIdle(page, { quietMs: 400, timeoutMs: 5000 }).catch(() => {});
  const hasEditor = await page.evaluate(() => [...document.querySelectorAll("textarea")]
    .some((t) => t.placeholder && !t.matches("[data-timeline-composer]")));
  if (!hasEditor) throw new Error(`点「评论」后编辑器没出现(浮钮数 ${btn.count},可能点到了残留浮钮)`);
  const editorPh = await page.evaluate(() => [...document.querySelectorAll("textarea")]
    .find((t) => t.placeholder && !t.matches("[data-timeline-composer]"))?.placeholder ?? null);
  await page.evaluate(() => {
    const ta = [...document.querySelectorAll("textarea")].find((t) => t.placeholder && !t.matches("[data-timeline-composer]"));
    ta?.focus();
  });
  await page.keyboard.type(comment, { delay: 12 });
  await page.keyboard.press("Enter");
  await page.waitForFunction((c) => document.body.innerText.includes(c), { timeout: 8000, polling: 150 }, comment);
  return { floatButtons: btn.count, editorPlaceholder: editorPh };
}

const basketText = () => page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "清空全部");
  if (!btn) return null;
  // BasketBar 的根容器:按钮的父级(条目列表 + 清空按钮同层)
  return btn.parentElement?.innerText ?? null;
});
const basketVisible = async () => (await basketText()) !== null;

try {
  await page.waitForFunction(() => document.readyState === "complete", { timeout: 30000 });
  await page.waitForSelector("[data-sidebar-style]", { timeout: 30000 });
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 25000 });

  await openSession(NAME_A, MARK_A);
  ok(!(await basketVisible()), "前提:未加评论时输入框上方无附件条");

  // ── ① 划词 → 评论入篮 → 附件条出现(跨插件契约:review invoke → timeline 按 sessionKey 匹配) ──
  const r1 = await addComment(LONG_A.slice(0, 12), 0.05, 0.6, COMMENT_1);
  ok(r1.floatButtons >= 1, "① 划词后出现「评论」浮钮", r1.floatButtons);
  ok(!!r1.editorPlaceholder, "① 评论编辑器出现(浮层锚定选区)", r1.editorPlaceholder);
  ok(true, `① 评论「${COMMENT_1}」入篮(DOM 可见)`);
  await shot("1-editor");

  // 附件条出现 = 跨插件契约成立(review 的 payload.sessionKey 与 timeline 的 curKey 对齐)。
  // 用 BasketBar 独有的「清空全部」按钮当锚点(❝ 符号在三处组件都有,不唯一)。
  const attached = await page.waitForFunction(
    () => [...document.querySelectorAll("button")].some((b) => (b.textContent || "").trim() === "清空全部"),
    { timeout: 6000, polling: 150 },
  ).then(() => true).catch(() => false);
  ok(attached, "① 输入框上方出现评论附件条(review→timeline 跨插件契约成立:sessionKey 同源)");
  await shot("2-basket-attached");

  // ── ② 第二条评论:计数变成 2(同一行不同水平区间划出另一段)──
  await addComment(LONG_A.slice(0, 12), 0.3, 0.9, COMMENT_2);
  const btext = await basketText();
  ok(btext?.includes(COMMENT_1) && btext?.includes(COMMENT_2), "② 附件条含两条评论(①② 序号条目)", btext?.slice(0, 120));
  ok(btext?.includes("①") && btext?.includes("②"), "② 序号 ①② 渲染(顺序即入篮顺序)");
  await shot("3-two-comments");

  // ── ③ 切到乙会话:附件条消失(评论篮按会话隔离) ──
  await openSession(NAME_B, MARK_B);
  await waitForDomIdle(page, { quietMs: 500, timeoutMs: 6000 }).catch(() => {});
  const gone = await page.waitForFunction(
    () => ![...document.querySelectorAll("button")].some((b) => (b.textContent || "").trim() === "清空全部"),
    { timeout: 6000, polling: 150 },
  ).then(() => true).catch(() => false);
  ok(gone, "③ 切到乙会话后附件条消失(甲的评论篮不串到乙)");
  const btextB = await basketText();
  ok(!(btextB?.includes(COMMENT_1) ?? false), "③ 乙会话看不到甲的评论文本", btextB?.slice(0, 80));
  await shot("4-switched-clean");

  // ── ④ 切回甲:附件条复活且两条都在 ──
  await openSession(NAME_A, MARK_A);
  await waitForDomIdle(page, { quietMs: 500, timeoutMs: 6000 }).catch(() => {});
  const back = await page.waitForFunction((c) => {
    const btn = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "清空全部");
    return btn?.parentElement?.innerText.includes(c) ?? false;
  }, { timeout: 6000, polling: 150 }, COMMENT_1).then(() => true).catch(() => false);
  ok(back, "④ 切回甲后附件条复活(篮子仍在,且仍与 timeline 对齐)");
  const btextA = await basketText();
  ok(btextA?.includes(COMMENT_2), "④ 第二条评论也在(篮子内容完整恢复)", btextA?.slice(0, 120));
  await shot("5-back-restored");

  // ── ⑤ 删单条:计数跟着变(BasketBar 按 payload.sessionKey 操作) ──
  const removed = await page.evaluate(() => {
    const clear = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "清空全部");
    const btn = clear?.parentElement && [...clear.parentElement.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "✕");
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  ok(!!removed, "⑤ 附件条里有删除按钮(✕)");
  await page.mouse.click(removed.x, removed.y);
  // 删除后 review 的 pushState → timeline 更新 attachments 是异步链,轮询等一条消失
  // (skill §3.7:别赌固定 sleep)。等到附件条里只剩一条评论。
  const removedOne = await page.waitForFunction(([c1, c2]) => {
    const btn = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "清空全部");
    const txt = btn?.parentElement?.innerText ?? "";
    const n = [c1, c2].filter((c) => txt.includes(c)).length;
    return n === 1;
  }, { timeout: 6000, polling: 150 }, [COMMENT_1, COMMENT_2]).then(() => true).catch(() => false);
  const afterRemove = await basketText();
  const remaining = [COMMENT_1, COMMENT_2].filter((c) => afterRemove?.includes(c));
  ok(removedOne && remaining.length === 1, "⑤ 删单条后附件条只剩一条(BasketBar 按 payload.sessionKey 操作生效)", { removedOne, remaining, afterRemove: afterRemove?.slice(0, 120) });
  await shot("6-after-remove");

  await killApp(app);
  console.log(`\n✅ PASS: ${passed} 项断言全部通过(review↔timeline 跨插件契约 + 评论篮按会话隔离)`);
  console.log(`   截图: ${shotsDir}`);
  if (!args.keep) rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(0);
} catch (err) {
  console.error(`\n❌ FAIL: ${err.message}`);
  try {
    await shot("failure");
    const diag = await page.evaluate(() => ({
      basketText: (() => {
        const btn = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "清空全部");
        return btn?.parentElement?.innerText.slice(0, 300) ?? null;
      })(),
      textareas: [...document.querySelectorAll("textarea")].map((t) => ({ ph: t.placeholder?.slice(0, 30), isComposer: t.matches("[data-timeline-composer]") })),
      buttons: [...document.querySelectorAll("button")].map((b) => (b.textContent || "").trim().slice(0, 12)).filter(Boolean).slice(0, 30),
    })).catch(() => null);
    if (diag) console.error("现场:", JSON.stringify(diag, null, 2));
  } catch { /* 诊断失败不掩盖原因 */ }
  await killApp(app).catch(() => {});
  console.error(`诊断截图保留: ${shotsDir}`);
  process.exit(1);
}
