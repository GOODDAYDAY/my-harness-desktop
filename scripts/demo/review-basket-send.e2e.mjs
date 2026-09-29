#!/usr/bin/env node
// 评论篮 → **实际发送文本** → **落盘** 的三方对账 e2e。
//
// 补的是 `review-basket-key.e2e.mjs` 明确没覆盖的那半：那个剧本标注「零 token(**不发送**)」，
// 所以它验的是"评论入篮、附件条显示、按会话隔离、可删单条"——**都是发送之前**的状态。
// 而评论篮存在的意义是"把评论拼进 prompt 发给模型"，这一段此前零覆盖：
//   · `promptFragment` 由 `buildReviewBlock(comments, promptHeader)` 生成（`sessions/review/renderer`）；
//   · timeline 在发送时经 sendSuffix 附加到 prompt；
//   · 发送成功后 review 侧靠框架 store 的 `lastSendNonce` 递增来清空篮子。
// 三者任一断掉，用户看到的都是"评论明明在篮子里、发出去却没带上"——**静默失败，没有报错**。
//
// 判据三层（与本仓其它对账剧本同款）：
//   ① DOM：echo 回复里能看到评论内容（minimal 的 echo 会把收到的 prompt 原样回显，
//      所以它是"实际发送文本"的**可读证据**，不需要插桩）；
//   ② 落盘：中立层 entries 文件里那条 user 消息含 `<review>` 块与评论文本；
//   ③ 收尾：发送成功后篮子被清空（附件条消失）——否则会把同一批评论重复带进下一条。
//
// 顺带钉住 r27 的标签中性化：落盘文本里的标签必须是 `<review>` 而不是 `<pi-review>`
// （通用插件不该往任意内核的 prompt 里塞一个以某个内核命名的标签）。
//
// 零 token：全程 minimal（echo 内核）。
//
// 用法: npm run build && node scripts/demo/review-basket-send.e2e.mjs [--port 9420] [--keep]
import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, killApp } from "./lib/app.mjs";
import { makeRunRoot, setupBaseline } from "./lib/home.mjs";
import { seedTestPlugins } from "./lib/test-plugins.mjs";
import { waitForDomIdle } from "./lib/util.mjs";
import { clickPointUntil, selectAcross } from "./lib/interact.mjs";
import { locate } from "./lib/locate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const { values: args } = parseArgs({ options: { port: { type: "string", default: "9420" }, keep: { type: "boolean", default: false } } });

let passed = 0;
function ok(cond, label, detail) {
  if (!cond) throw new Error(`断言失败: ${label}${detail !== undefined ? `（现场：${JSON.stringify(detail)?.slice(0, 220)}）` : ""}`);
  passed += 1;
  console.log(`  ✓ ${label}`);
}

const COMMENT = "请把这一段改成被动语态";
const FIRST_PROMPT = "这是一段供划词评论的正文内容";
const SECOND_PROMPT = "按评论修改";

const runRoot = makeRunRoot();
const home = join(runRoot, "zh-CN");
mkdirSync(home, { recursive: true });
const ctx = setupBaseline({ home, realHome: homedir(), locale: "zh-CN" });
seedTestPlugins(ctx.dataRoot);
const projectDir = join(home, "project");
mkdirSync(projectDir, { recursive: true });
const prefsFile = join(ctx.configDir, "config.json");
writeFileSync(prefsFile, JSON.stringify({ ...JSON.parse(readFileSync(prefsFile, "utf-8")), lastCwd: projectDir }, null, 2));
const neutralDir = join(ctx.dataRoot, "sessions");

const app = await launchApp({ appDir: ROOT, port: Number(args.port), env: { HOME: home, MHD_PORT: "18453" }, timeoutMs: 90000 });
const page = app.page;
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

const basketText = () => page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "清空全部");
  return btn ? (btn.parentElement?.innerText ?? null) : null;
});

/** 与 review-basket-key.e2e.mjs 同源的入篮交互（三条实踩纪律照搬，见该文件的注释）。 */
async function addComment(anchorText, fromFx, toFx, comment, nth = 0) {
  await page.keyboard.press("Escape");
  await waitForDomIdle(page, { quietMs: 300, timeoutMs: 4000 }).catch(() => {});
  // ⚠ 不用像素拖选（`selectAcross`）而用**程序化选区**：review 的浮钮由 `selectionchange`
  //   触发，所以直接建 Range + addRange + 派发 selectionchange 与用户拖选**同构**
  //   （这不是 mock 产品代码，而是模拟用户输入的那一侧）。
  //   为什么放弃拖选：`locate` 的文本匹配在消息卡的嵌套结构下命中不到目标 <p>
  //   （实测：`within:"[data-message-id]"` 报"候选 0 个"，而 `document.querySelector
  //   ("[data-message-id] p")` 明确能找到含该文本的元素），且不限定 `within` 时会命中
  //   **侧栏会话行**（其文本形如 `<名字>[minimal echo] <末条消息>`，含同样字串），
  //   于是拖选落在侧栏上、getSelection() 为空。程序化选区两个问题都没有。
  const selInfo = await page.evaluate(({ text, nth }) => {
    const ps = [...document.querySelectorAll("[data-message-id] p, [data-message-id] div")]
      .filter((e) => e.children.length === 0 && (e.textContent || "").includes(text));
    const el = ps[nth] ?? ps[0];
    if (!el) return { ok: false, why: "未找到含该文本的叶子元素" };
    el.scrollIntoView({ block: "center" });
    const node = el.firstChild;
    const full = (node?.nodeValue || "");
    const from = Math.floor(full.length * 0.05);
    const to = Math.max(from + 4, Math.floor(full.length * 0.6));
    const range = document.createRange();
    range.setStart(node, from);
    range.setEnd(node, Math.min(to, full.length));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
    return { ok: true, selected: sel.toString(), rect: (() => { const r = range.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) }; })() };
  }, { text: anchorText, nth });
  if (!selInfo.ok) throw new Error(`建选区失败：${selInfo.why}`);
  console.log(`    [diag] 程序化选区：${JSON.stringify(selInfo.selected?.slice(0, 30))} @ ${JSON.stringify(selInfo.rect)}`);
  await waitForDomIdle(page, { quietMs: 500, timeoutMs: 5000 }).catch(() => {});
  const btn = await page.evaluate(() => {
    const all = [...document.querySelectorAll("button")].filter((b) => (b.textContent || "").trim() === "评论");
    const b = all[all.length - 1];                 // 取最新那个（可能有残留浮钮）
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, count: all.length };
  });
  if (!btn) throw new Error("划词后没有出现「评论」浮钮");
  await page.mouse.click(btn.x, btn.y);
  await waitForDomIdle(page, { quietMs: 400, timeoutMs: 5000 }).catch(() => {});
  const hasEditor = await page.evaluate(() => [...document.querySelectorAll("textarea")]
    .some((t) => t.placeholder && !t.matches("[data-timeline-composer]")));
  if (!hasEditor) throw new Error(`点「评论」后编辑器没出现（浮钮数 ${btn.count}，可能点到了残留浮钮）`);
  await page.evaluate(() => {
    const ta = [...document.querySelectorAll("textarea")].find((t) => t.placeholder && !t.matches("[data-timeline-composer]"));
    ta?.focus();
  });
  await page.keyboard.type(comment, { delay: 12 });
  await page.keyboard.press("Enter");
  await page.waitForFunction((c) => document.body.innerText.includes(c), { timeout: 8000, polling: 150 }, comment);
}

const sendAndWaitEcho = async (text) => {
  await page.click("[data-timeline-composer]");
  await page.keyboard.type(text);
  const r = await page.evaluate(() => {
    const b = document.querySelector("[data-composer-send]");   // r237：改用早就存在的稳定锚点（composer.tsx:573，r119 补的），不再按译文子串定位
    const rect = b.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  await page.mouse.click(r.x, r.y);
  // ⚠ waitForFunction(fn, **options**, ...args)：options 在第二位（skill §17.11）
  const got = await page.waitForFunction(
    (t) => [...document.querySelectorAll("[data-message-id]")].some((el) => (el.textContent || "").includes(`[minimal echo] ${t}`)),
    { timeout: 60000, polling: 500 },
    text,
  ).then(() => true).catch(() => false);
  if (!got) throw new Error(`等不到 echo 回复：${text}`);
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 15000 }).catch(() => {});
};

try {
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 25000 });

  // ---- 切到 minimal（零 token），发一条造出可供划词的正文 ----
  console.log("\n── 准备：minimal 会话 + 一条正文 ──");
  const trig = await page.evaluate(() => {
    const b = document.querySelector("button[data-composer-model]");
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(trig.x, trig.y);
  await page.waitForSelector("[role='menu']", { timeout: 8000 });
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
  ok(switched, "切到 minimal TAB 并列出它的模型");
  const itemRect = await page.evaluate(() => {
    const it = [...document.querySelectorAll("[role^='menuitem']")].find((el) => (el.textContent || "").includes("Minimal Echo") && el.getBoundingClientRect().width > 0);
    const r = it.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(itemRect.x, itemRect.y);
  await waitForDomIdle(page, { quietMs: 700, timeoutMs: 12000 }).catch(() => {});
  ok(String(await page.evaluate(() => document.querySelector("[data-composer-model]")?.getAttribute("data-composer-model"))).startsWith("minimal:"),
    "composer 已绑到 minimal");

  await sendAndWaitEcho(FIRST_PROMPT);
  ok(!(await basketText()), "前提：还没加评论时输入框上方无附件条");

  // ---- 划词 → 评论入篮 ----
  console.log("\n── 划词入篮 ──");
  // ⚠ fromFx/toFx 是**宽度比例**（0..1），不是字符偏移——首版传了 2 和 9，
  //   拖选起点落到元素矩形之外，selectionchange 不触发，于是"评论浮钮没出现"
  //   看起来像产品坏了。取值与 review-basket-key.e2e.mjs 一致（0.05 → 0.6）。
  // ⚠ 锚文本必须**只**出现在消息气泡里。首版用 FIRST_PROMPT 本身，而会话被自动命名成
  //   第一条消息的文本 → 侧栏行与标题栏也含它（locate 报 matches:7、命中 y=17 的元素），
  //   于是拖选落在标题栏上、getSelection() 为空、浮钮不出现。
  //   改用 echo 前缀（`[minimal echo] …` 不会进标题），命中的只可能是助手气泡——
  //   而"对助手的回复划词评论"本来就是评论篮的主用例。
  // 锚文本用**正文**（不是带 echo 前缀的整串）：消息卡里 `[minimal echo]` 前缀与正文
  // 是两个不同元素，没有单个元素含整串（实测 within 限定后整串 0 命中）。
  // nth:1 取第二个命中 = 助手气泡（第一个是用户气泡）——"对助手回复划词评论"是评论篮的主用例。
  await addComment(FIRST_PROMPT, 0.05, 0.6, COMMENT, 1);
  const basket = await basketText();
  ok(!!basket, "附件条出现（评论已入篮）");
  ok(basket?.includes(COMMENT) ?? false, `附件条里能看到评论文本`, basket?.slice(0, 120));

  // ---- 发送：评论必须被拼进 prompt ----
  console.log("\n── 发送：promptFragment 是否真的拼进了 prompt ──");
  await sendAndWaitEcho(SECOND_PROMPT);
  // ① DOM 证据：minimal 的 echo 原样回显收到的 prompt，所以回复里应同时含用户输入与评论内容
  const cards = await page.evaluate(() => [...document.querySelectorAll("[data-message-id]")]
    .map((el) => (el.textContent || "").replace(/\s+/g, " ")));
  const echoOfSecond = cards.find((t) => t.includes(`[minimal echo] ${SECOND_PROMPT}`)) ?? null;
  console.log(`  · 第二条的 echo 卡片：${JSON.stringify(echoOfSecond?.slice(0, 190))}`);
  ok(!!echoOfSecond, "第二条消息的 echo 回复已到达");
  ok(echoOfSecond?.includes(COMMENT) ?? false,
    "① **echo 回显里含评论内容** ⇒ promptFragment 真的被拼进了发送的 prompt（不是只在篮子里好看）",
    echoOfSecond?.slice(0, 200));

  // ② 落盘证据：中立层 entries 里那条 user 消息含 review 块
  const entriesFiles = existsSync(neutralDir) ? readdirSync(neutralDir).filter((f) => f.endsWith(".entries.json")) : [];
  ok(entriesFiles.length >= 1, `中立层 entries 文件存在（${entriesFiles.length} 份）`);
  // ⚠ entries 文件的真实结构是 `{ neutralSessionId, lineages }`（**不是**扁平数组，
  //   也不是 `{ entries }`）——首版按数组读，取到 0 条，于是"落盘里没有评论"这条假红。
  //   教训同 §17.16 第 2 条：对账的**结构**要先查清再写，别按想象的形状读。
  let storedUserText = "";
  let storedRaw = "";
  const collectUserTexts = (node, out) => {
    if (node == null) return;
    if (Array.isArray(node)) { for (const x of node) collectUserTexts(x, out); return; }
    if (typeof node !== "object") return;
    const role = node.role ?? node.message?.role;
    if (role === "user") out.push(JSON.stringify(node));
    for (const v of Object.values(node)) collectUserTexts(v, out);
  };
  for (const f of entriesFiles) {
    const raw = readFileSync(join(neutralDir, f), "utf-8");
    if (!raw.includes(SECOND_PROMPT)) continue;
    storedRaw = raw;
    const users = [];
    collectUserTexts(JSON.parse(raw), users);
    storedUserText = users.filter((t) => t.includes(SECOND_PROMPT)).join("\n");
  }
  console.log(`  · 落盘的 user 条目片段：${storedUserText.slice(0, 220)}`);
  if (!storedUserText) {
    console.log("  · [diag] entries 文件结构:", JSON.stringify(await (async () => {
      const f = entriesFiles[0];
      const j = JSON.parse(readFileSync(join(neutralDir, f), "utf-8"));
      const arr = Array.isArray(j) ? j : (j.entries ?? []);
      return { topLevelKeys: Array.isArray(j) ? "(数组)" : Object.keys(j), n: arr.length, sample: arr.slice(0, 3).map((e) => ({ keys: Object.keys(e), role: e.role ?? e.message?.role, txt: JSON.stringify(e).slice(0, 110) })), hasSecond: readFileSync(join(neutralDir, f), "utf-8").includes(SECOND_PROMPT) };
    })()));
  }
  ok(storedUserText.includes(COMMENT), "② 落盘的 user 消息里含评论文本（不只是界面上有）");
  // r27 的标签中性化：新写入的必须是 <review>，不能再是 <pi-review>
  ok(storedRaw.includes("<review>") || storedRaw.includes("\\u003creview\\u003e") || storedRaw.includes("&lt;review&gt;"),
    "② 落盘文本里的块标签是**中性**的 `<review>`（r27 改名后新写入的不应再是 `<pi-review>`）");
  ok(!storedRaw.includes("<pi-review>") && !storedRaw.includes("pi-review"),
    "② 新写入的内容里**不含**任何内核名（`pi-review` 只应作为历史格式存在于旧会话）");

  // ③ 收尾：发送成功后篮子必须被清空（否则同一批评论会被重复带进下一条）
  console.log("\n── 收尾：篮子清空 ──");
  const basketAfter = await basketText();
  ok(basketAfter === null, `③ 发送成功后附件条消失（篮子已清空；实际 ${JSON.stringify(basketAfter?.slice(0, 80))}）`);

  ok(pageErrors.length === 0, `页面零报错（实际 ${pageErrors.length} 条${pageErrors.length ? ": " + pageErrors.slice(0, 2).join(" | ").slice(0, 160) : ""}）`);
} catch (err) {
  console.error(`\n❌ FAIL: ${err.message}`);
  await page.screenshot({ path: join(runRoot, "failure.png") }).catch(() => {});
  process.exitCode = 1;
} finally {
  await killApp(app);
}

console.log(`\n✅ PASS: ${passed} 项断言（评论篮 → 发送文本 → 落盘 三方对账，零 token）`);
console.log(`   隔离 HOME: ${home}${args.keep ? "（--keep 保留）" : ""}`);
