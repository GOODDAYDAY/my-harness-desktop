#!/usr/bin/env node
// 三内核同场真回合 e2e（**零 token**）—— pi + dsh + minimal 在**同一次 app 运行**里各跑一轮，
// 并验它们**互不污染**（用户诉求「别哪里给覆盖了」）。
//
// 为什么要有这条（与前两条的分工）：
//   · `kernel-dispatch.e2e.mjs` 验的是**派发**：setModel 路由到哪个内核 + 能力指纹，
//     不跑真实回合；
//   · `dsh-round.e2e.mjs` 只跑 dsh 一轮；
//   · 这一条验的是**三个内核在同一个进程/同一份壳状态里共存**时各自还能正常跑完一轮，
//     且彼此的会话文件、中立头、DOM 会话行**不串**。
//
// 做法：本地 mock OpenAI 兼容 SSE 一个，三个内核都指向它（各自的配置格式不同：
//   pi  = ~/.pi/agent/models.json（providers 是**字典**）
//   dsh = ~/.dsh/settings.yaml（llm-pi-ai.providers）
//   minimal = ~/.minimal/agent/models.json + .credentials.json
// ），mock 的回复正文里**带上请求里的 model id**，于是"这轮是谁答的"直接可从 DOM 读出。
//
// 用法: npm run build && node scripts/demo/multi-kernel-round.e2e.mjs [--port 9365] [--keep]

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { launchApp, killApp, assertPortFree } from "./lib/app.mjs";
import { makeRunRoot, setupBaseline, setupDshKernel } from "./lib/home.mjs";
import { seedTestPlugins } from "./lib/test-plugins.mjs";
import { waitForDomIdle } from "./lib/util.mjs";
import { clickPointUntil } from "./lib/interact.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const args = Object.fromEntries(process.argv.slice(2).flatMap((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return [[m[1], m[2] ?? true]];
}));
const PORT = Number(args.port) > 0 ? Number(args.port) : 9365;
const APP_PORT = 18467;

let passed = 0;
function ok(cond, label) {
  if (!cond) throw new Error(`断言失败: ${label}`);
  passed += 1;
  console.log(`  ✓ ${label}`);
}

// ── 本地 mock：把请求里的 model 回显进回复，于是"谁答的"可从回复正文直接判定。 ──
const seenModels = [];
const mockServer = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let model = "?";
    try { model = JSON.parse(body).model ?? "?"; } catch { /* 非 JSON 请求忽略 */ }
    seenModels.push(model);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: {"choices":[{"delta":{"role":"assistant","content":"答复来自 ${model}"}}]}\n\n`);
    setTimeout(() => {
      // ⚠ 必须补 finish_reason：少这一帧 dsh 会判「Stream ended without finish_reason」
      //（skills §13.3：替身的形状要真）。
      res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    }, 60);
  });
});
await new Promise((r) => mockServer.listen(0, "127.0.0.1", r));
const addr = mockServer.address();
const mockPort = typeof addr === "object" && addr ? addr.port : 0;

const runRoot = makeRunRoot();
const home = join(runRoot, "zh-CN");
mkdirSync(home, { recursive: true });
const ctx = setupBaseline({ home, realHome: homedir(), locale: "zh-CN" });
// minimal 是**测试专用内核插件**(不再随壳分发):种进隔离 HOME 的用户插件目录才会装载。
seedTestPlugins(ctx.dataRoot);
const dsh = setupDshKernel(home, homedir());
const projectDir = join(home, "project");
mkdirSync(projectDir, { recursive: true });
const prefsFile = join(home, ".my-harness-desktop-dev", "config", "config.json");
writeFileSync(prefsFile, JSON.stringify({ ...JSON.parse(readFileSync(prefsFile, "utf-8")), lastCwd: projectDir }, null, 2));

// id 用于"谁答的"（mock 回显请求里的 model id），name 用于在**下拉里找那一项**
// （下拉显示的是显示名，不是 id —— 第一版拿 id 去找，直接找不到）。
const MODELS = {
  pi: { id: "mock-pi", name: "Mock Pi" },
  dsh: { id: "mock-dsh", name: "Mock DSH" },
  minimal: { id: "mock-minimal", name: "Mock Minimal" },
};

// pi：providers 是**字典**；settings.json 的默认指向也要改（否则默认模型指向一个已不存在的 provider）。
writeFileSync(join(home, ".pi", "agent", "models.json"), JSON.stringify({
  providers: {
    mockpi: { baseUrl: `http://127.0.0.1:${mockPort}/v1`, api: "openai-completions", apiKey: "sk-mock", models: [{ id: MODELS.pi.id, name: MODELS.pi.name }] },
  },
}, null, 2));
const piSettingsPath = join(home, ".pi", "agent", "settings.json");
const piSettings = JSON.parse(readFileSync(piSettingsPath, "utf-8"));
writeFileSync(piSettingsPath, JSON.stringify({ ...piSettings, defaultProvider: "mockpi", defaultModel: MODELS.pi.id, defaultThinkingLevel: "off" }, null, 2));

// dsh：settings.yaml（只留 mock provider）。
writeFileSync(dsh.settingsPath, [
  "agent-presets:", "  default: standard",
  "permission:", "  defaultPreset: danger-full-access",
  "llm-pi-ai:", "  providers:", "    mock:", "      apiKeyEnv: MHD_MOCK_KEY",
  "      api: openai-completions", `      baseURL: http://127.0.0.1:${mockPort}/v1`,
  "      models:", `        - id: ${MODELS.dsh.id}`, `          name: ${MODELS.dsh.name}`,
  "          contextWindow: 100000", "          maxTokens: 4096", "",
].join("\n"));

// minimal：models.json + 凭证文件。
const minimalDir = join(home, ".minimal", "agent");
mkdirSync(minimalDir, { recursive: true });
writeFileSync(join(minimalDir, "models.json"), JSON.stringify({
  providers: [{ id: "mock", baseURL: `http://127.0.0.1:${mockPort}/v1`, models: [{ id: MODELS.minimal.id, name: MODELS.minimal.name }] }],
  default: { provider: "mock", model: MODELS.minimal.id },
}, null, 2));
writeFileSync(join(minimalDir, ".credentials.json"), JSON.stringify({ mock: "sk-mock" }));

await assertPortFree(PORT);
const app = await launchApp({
  appDir: ROOT,
  port: PORT,
  // 三个内核同场：pi/dsh 默认装载，minimal 需强制启用（§目标 16：默认不装载）。
  env: { HOME: home, MHD_PORT: String(APP_PORT), MHD_MOCK_KEY: "sk-mock" },
  timeoutMs: 120000,
});
const page = app.page;
const consoleTail = [];
page.on("pageerror", (e) => consoleTail.push(e.message));

/** 选一个内核的模型：开下拉 → （多内核才有）点该内核 TAB → 点该模型项。 */
async function selectModel(kernel, modelName) {
  const trigger = await page.evaluate(() => {
    const ta = document.querySelector("[data-timeline-composer]");
    const scope = ta?.closest("form") ?? document.body;
    const b = [...scope.querySelectorAll("button")].find((x) => {
      const t = (x.textContent || "").trim();
      return x.querySelector("svg") && t.length > 2 && !/^(off|minimal|low|medium|high|xhigh)$/i.test(t);
    });
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!trigger) throw new Error("未找到模型下拉触发器");
  await page.mouse.click(trigger.x, trigger.y);
  // best-effort settle（r124 标注，同族判定见 minimal-smoke r123）：等右键/溢出菜单展开，
  // 只为让后续对菜单项的采样稳定；菜单真没出来时，下面对**菜单项**的断言会自己红。
  await page.waitForSelector("[role='menu']", { timeout: 8000 }).catch(() => {});
  // 注意：page.evaluate 是跨进程序列化的，**闭包变量传不过去** —— 必须显式当参数传
  //（这条在本文件里踩了两次；见 skills 里"替身/探针的闭包"那条）。
  const itemVisible = (n) => [...document.querySelectorAll("[role^='menuitem']")].some((el) => (el.textContent || "").includes(n) && el.getBoundingClientRect().width > 0);
  if (!(await page.evaluate(itemVisible, modelName))) {
    // 多内核才有内核 TAB；点它，用有界重试（菜单动画未落定时坐标会打偏，见 skills §13.7）
    await clickPointUntil(
      page,
      ({ kernel: k }) => {
        const tab = [...document.querySelectorAll("[role='menu'] button")].find((b) => (b.textContent || "").trim().toLowerCase() === k);
        if (!tab) return null;
        const r = tab.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      },
      ({ modelName: n }) => [...document.querySelectorAll("[role^='menuitem']")].some((el) => (el.textContent || "").includes(n) && el.getBoundingClientRect().width > 0),
      { tries: 5, settleMs: 250, arg: { kernel, modelName } },
    );
  }
  const ready = await page.waitForFunction(
    (n) => [...document.querySelectorAll("[role^='menuitem']")].some((el) => (el.textContent || "").includes(n) && el.getBoundingClientRect().width > 0),
    { timeout: 15000, polling: 300 }, modelName,
  ).then(() => true).catch(() => false);
  if (!ready) throw new Error(`${kernel} 的模型项「${modelName}」没出现`);
  const item = await page.evaluate((n) => {
    const el = [...document.querySelectorAll("[role^='menuitem']")].find((x) => (x.textContent || "").includes(n) && x.getBoundingClientRect().width > 0);
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, modelName);
  await page.mouse.click(item.x, item.y);
  await page.keyboard.press("Escape").catch(() => {});
  await waitForDomIdle(page, { quietMs: 500, timeoutMs: 8000 }).catch(() => {});
}

/** 发一条消息并等回复正文出现。 */
async function send(text, expected) {
  await page.click("[data-timeline-composer]");
  await page.keyboard.type(text);
  const sendRect = await page.evaluate(() => {
    const b = document.querySelector("[data-composer-send]");   // r237：改用早就存在的稳定锚点（composer.tsx:573，r119 补的），不再按译文子串定位
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!sendRect) throw new Error("未找到发送按钮");
  await page.mouse.click(sendRect.x, sendRect.y);
  // best-effort settle（r124 标注，同族判定见 minimal-smoke r123）：两阶段收敛的第一阶段——
  // 等「停止」出现。零 token / 模型端点不可达的剧本里 streaming 可能**从不开始**，
  // 停止钮合法地不出现，所以等不到不算失败（真失败由『发送后该出现的产物』那些断言报出来）。
  await page.waitForSelector("[data-composer-stop]", { timeout: 30000 }).catch(() => {});
  // best-effort settle（r124 标注，同族判定见 minimal-smoke r123）：两阶段收敛的第二阶段——
  // 等「停止」消失（streaming 收尾）。等不到也继续：后续断言读的是终态 DOM，
  // 若仍在 streaming 会由那些断言报出来，而不是在这里静默吞掉一个『没收尾』的信号。
  await page.waitForFunction(() => !document.querySelector("[data-composer-stop]"), { timeout: 90000, polling: 500 }).catch(() => {});
  return page.waitForFunction(
    (exp) => [...document.querySelectorAll("[data-message-id]")].some((el) => (el.textContent || "").includes(exp)),
    { timeout: 60000, polling: 300 }, expected,
  ).then(() => true).catch(() => false);
}

try {
  await page.waitForSelector("[data-timeline-composer]", { timeout: 40000 });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 30000 });

  // 三个内核各跑一轮（顺序：pi → dsh → minimal）。每一轮都用**新会话**（⌘N）避免上下文串台。
  const expect = { pi: `答复来自 ${MODELS.pi.id}`, dsh: `答复来自 ${MODELS.dsh.id}`, minimal: `答复来自 ${MODELS.minimal.id}` };
  for (const kernel of ["pi", "dsh", "minimal"]) {
    // 新一轮：新建会话，确保这一轮只属于这个内核
    await page.keyboard.down("Meta"); await page.keyboard.press("n"); await page.keyboard.up("Meta");
    await waitForDomIdle(page, { quietMs: 600, timeoutMs: 10000 }).catch(() => {});
    await selectModel(kernel, MODELS[kernel].name);
    const model = await page.evaluate(() => document.querySelector("[data-composer-model]")?.dataset.composerModel ?? "");
    ok(model.startsWith(`${kernel}:`), `[${kernel}] composer 固定到该内核的模型（实际 ${model}）`);
    const replied = await send(`第 ${kernel} 轮`, expect[kernel]);
    if (!replied) {
      const diag = await page.evaluate(() => ({
        model: document.querySelector("[data-composer-model]")?.dataset.composerModel ?? "",
        messages: [...document.querySelectorAll("[data-message-id]")].map((el) => (el.textContent || "").replace(/\s+/g, " ").slice(0, 60)),
        timelineMounted: !!document.querySelector("[data-timeline-composer]"),
        // 会话区文本头：空态会写"还没有会话/新建对话"之类，据此区分"没开会话"与"开了但没消息"
        bodyHead: document.body.innerText.replace(/\s+/g, " ").slice(0, 220),
        sidebarRows: [...document.querySelectorAll("[data-session-path]")].map((el) => (el.textContent || "").replace(/\s+/g, " ").slice(0, 30)),
      }));
      console.error(`  诊断(${kernel}):`, JSON.stringify(diag));
      console.error("  mock 收到的 model:", JSON.stringify(seenModels));
    }
    ok(replied, `[${kernel}] 真回合跑通：mock 的回复进了时间线`);
  }
  ok(new Set(seenModels).size >= 3 || seenModels.length >= 3, `mock 被三个内核分别调到（${seenModels.length} 次：${[...new Set(seenModels)].join(", ")}）`);

  // ── 互不污染：三份中立头、三份内核会话文件、左栏三行 ──
  await waitForDomIdle(page, { quietMs: 1200, timeoutMs: 15000 }).catch(() => {});
  const sessionsDir = join(home, ".my-harness-desktop-dev", "sessions");
  const headers = readdirSync(sessionsDir).filter((f) => f.endsWith(".header.json"))
    .map((f) => JSON.parse(readFileSync(join(sessionsDir, f), "utf-8")).header);
  const byKernel = {};
  for (const h of headers) (byKernel[h.kernel] ??= []).push(h);
  for (const kernel of ["pi", "dsh", "minimal"]) {
    ok((byKernel[kernel]?.length ?? 0) >= 1, `中立层有 ${kernel} 归属的会话（${byKernel[kernel]?.length ?? 0} 个）`);
  }
  const rows = await page.evaluate(() => [...document.querySelectorAll("[data-session-path]")].map((el) => (el.textContent || "").replace(/\s+/g, " ").slice(0, 40)));
  ok(rows.length >= 3, `左栏列出三个内核的会话行（${rows.length} 行）`);
  // 内核文件各归各的根：minimal 的在 .minimal 下、dsh 的在 dsh 会话根下
  const minimalFiles = (() => { try { return readdirSync(join(home, ".minimal", "agent", "sessions"), { recursive: true }).filter((f) => String(f).endsWith(".jsonl")); } catch { return []; } })();
  ok(minimalFiles.length >= 1, `minimal 会话文件落在 .minimal/agent/sessions（${minimalFiles.length} 个）`);
  const piFiles = (() => { try { return readdirSync(join(home, ".pi", "agent", "sessions"), { recursive: true }).filter((f) => String(f).endsWith(".jsonl")); } catch { return []; } })();
  ok(piFiles.length >= 1, `pi 会话文件落在 .pi/agent/sessions（${piFiles.length} 个）—— 三个内核各写各的根，没有互相覆盖`);
  // ── 请求记录：**两内核的日志文件对账**（文件 ↔ 会话 ↔ 行 ↔ index）────────────────
  // 用户的原话是「文件是否对应，格式是否对应」——所以这里不验"有没有记录"（dsh-round 已验），
  // 而是验**两份写半产出的东西能不能对上账**：文件名是不是那个会话、行数是不是与 index 一致、
  // 两内核的请求行是不是都装得下核心内容（messages）。这是"对齐"的机器判据。
  const logDir = join(projectDir, ".my-harness-desktop", "llm-logs");
  const allLogFiles = (() => { try { return readdirSync(logDir).filter((f) => f.endsWith(".jsonl") && f !== "index.json"); } catch { return []; } })();
  ok(allLogFiles.length > 0, `请求记录有日志文件（${allLogFiles.length} 个：${allLogFiles.slice(0, 3).join(", ")}${allLogFiles.length > 3 ? " …" : ""}）`);

  // 分片命名：首片 <stem>.jsonl，续片 <stem>.N.jsonl 且 N>=2（约定里没有 .1）
  let shardOk = true;
  for (const f of allLogFiles) {
    const m = /^(.*?)(?:\.(\d+))?\.jsonl$/.exec(f);
    if (!m) { shardOk = false; break; }
    if (m[2] !== undefined && Number(m[2]) < 2) { shardOk = false; break; }
  }
  ok(shardOk, "分片命名合法：首片无编号、续片从 .2.jsonl 起（没有 .1）");

  // 逐文件解析 + 按**行形状**归类（不靠内核身份）：dsh 的 GenerateOptions 带 sessionId，pi 的 provider 原生体不带。
  const perStem = new Map();
  for (const f of allLogFiles) {
    let rows = [];
    try { rows = readFileSync(join(logDir, f), "utf-8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)); } catch { /* 读失败按空算 */ }
    const stem = f.replace(/(?:\.\d+)?\.jsonl$/, "");
    const rec = perStem.get(stem) ?? { kernel: new Set(), reqs: 0, resps: 0, paired: 0, files: [] };
    rec.files.push(f);
    const reqSeq = new Set();
    for (const row of rows) {
      if (row.kind === "request") {
        rec.reqs += 1;
        reqSeq.add(row.seq);
        rec.kernel.add(row.payload && typeof row.payload.sessionId === "string" ? "dsh" : "pi");
      } else if (row.kind === "response") {
        rec.resps += 1;
        if (reqSeq.has(row.seq)) rec.paired += 1;
      }
    }
    perStem.set(stem, rec);
  }
  const kernelsSeen = new Set();
  for (const rec of perStem.values()) for (const k of rec.kernel) kernelsSeen.add(k);
  ok(kernelsSeen.has("pi") && kernelsSeen.has("dsh"),
     `两个内核都留下了记录（实测 ${[...kernelsSeen].join(" + ")}）—— 这正是"对齐"的最外层判据`);

  // ① 内容对齐：**两内核**的每次请求都必须装得下对话历史（messages 非空）。
  //    旧实现下 dsh 侧会在这里红（payload 只有 provider/model 五个字段）。
  const badReqs = [];
  for (const [stem, rec] of perStem) {
    for (const f of rec.files) {
      for (const row of readFileSync(join(logDir, f), "utf-8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l))) {
        if (row.kind !== "request") continue;
        const msgs = row.payload?.messages;
        if (!Array.isArray(msgs) || msgs.length === 0) badReqs.push(`${f}#${row.seq}(${[...(row.payload ? Object.keys(row.payload) : [])].slice(0, 4).join("/")})`);
      }
    }
  }
  ok(badReqs.length === 0, `每个请求行都带着完整对话历史（messages 非空）；不合规 ${badReqs.length} 条 ${badReqs.slice(0, 3).join(", ")}`);

  // ② 计数口径：index.json 的 requests 必须等于该会话实际落盘的 request 行数（两内核同一口径）。
  const idx = JSON.parse(readFileSync(join(logDir, "index.json"), "utf-8"));
  const countMismatch = [];
  for (const [stem, rec] of perStem) {
    const bucket = idx.sessions?.[`${stem}.jsonl`];
    if (!bucket) { countMismatch.push(`${stem}(无桶)`); continue; }
    if (bucket.requests !== rec.reqs) countMismatch.push(`${stem}(桶 ${bucket.requests} ≠ 行 ${rec.reqs})`);
  }
  ok(countMismatch.length === 0, `index.json 的 requests 与实际行数一致（不一致 ${countMismatch.length} 条 ${countMismatch.slice(0, 3).join(", ")}）`);

  // ③ 配对完整：每个 request 都有同 seq 的 response（本轮三个内核都跑完了回合，不该有孤儿）。
  const unpaired = [...perStem.entries()].filter(([, r]) => r.paired !== r.reqs).map(([s2, r]) => `${s2}(${r.paired}/${r.reqs})`);
  ok(unpaired.length === 0, `请求与响应成对（未配对 ${unpaired.length} 个 ${unpaired.slice(0, 3).join(", ")}）`);

  // ④ 文件名 ↔ 会话对应：dsh 的日志文件名必须真的是某个 dsh 会话 id（面板按会话文件名定位，错一个就看不到记录）。
  const dshSids = new Set();
  const dshRoot = join(home, ".my-harness-desktop-dev", "dsh", "sessions");
  for (const rel of readdirSync(dshRoot, { recursive: true }).map(String)) {
    const m = /([0-9a-f-]{36})\/session\.jsonl$/.exec(rel);
    if (m) dshSids.add(m[1]);
  }
  const dshStems = [...perStem.entries()].filter(([, r]) => r.kernel.has("dsh")).map(([s2]) => s2);
  const orphanNames = dshStems.filter((s2) => !dshSids.has(s2));
  ok(dshStems.length > 0 && orphanNames.length === 0,
     `dsh 日志文件名 ↔ dsh 会话 id 一一对应（${dshStems.length} 个文件，会话根下 ${dshSids.size} 个 id，孤儿 ${orphanNames.length} 个）`);

  // ⑤ 同一面板对两内核的行都画得出来（DOM 层面对齐，不是只有数据层）
  await page.keyboard.down("Meta"); await page.keyboard.press("j"); await page.keyboard.up("Meta");
  await page.waitForFunction(
    () => [...document.querySelectorAll("[data-sidepanel-style] button[aria-label]")].some((b) => (b.getAttribute("aria-label") || "").includes("请求记录")),
    { timeout: 15000, polling: 300 },
  ).catch(() => {});
  // **等 tab 出现 ≠ tab 已激活**：不点它，面板里根本不会渲染记录行（第一版就栽在这，
  // 断言直接红成"0 个会话有记录行"——看着像产品坏了，其实是测试少点了一下）。
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("[data-sidepanel-style] button[aria-label]")].find((x) => (x.getAttribute("aria-label") || "").includes("请求记录"));
    b?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await waitForDomIdle(page, { quietMs: 600, timeoutMs: 8000 }).catch(() => {});
  const tabStates = [];
  // 逐条点开左栏会话行（切会话 → 面板重读），记录每行日志的状态属性
  const sessionPaths = await page.evaluate(() => [...document.querySelectorAll("[data-session-path]")].map((el) => el.getAttribute("data-session-path")));
  for (const sp of sessionPaths.slice(0, 4)) {
    await page.evaluate((sel) => {
      const el = [...document.querySelectorAll("[data-session-path]")].find((x) => x.getAttribute("data-session-path") === sel);
      el?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }, sp);
    await waitForDomIdle(page, { quietMs: 400, timeoutMs: 5000 }).catch(() => {});
    const st = await page.evaluate(() => [...document.querySelectorAll("[data-llm-log-row]")].map((r) => r.getAttribute("data-llm-log-state")));
    if (st.length === 0) continue;
    // 点开第一条 → 该内核的记录在 DOM 上摊开成哪些分区（两内核必须一样，这是"渲染层对齐"）
    await page.evaluate(() => {
      const row = document.querySelector("[data-llm-log-row]");
      row?.querySelector("div")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // best-effort settle（r124 单独判定）：等请求记录详情出现。
    // 零 token 剧本里可能没有任何请求被记录 ⇒ 等不到是合法的；
    // 后面读详情内容的地方会自己判空并报出来，不靠这里。
    await page.waitForFunction(() => document.querySelector("[data-llm-log-detail]") !== null, { timeout: 8000, polling: 200 }).catch(() => {});
    const detail = await page.evaluate(() => document.querySelector("[data-llm-log-detail]")?.innerText ?? "");
    const stem = String(sp).split("/").pop().replace(/\.jsonl$/, "");
    tabStates.push({ session: String(sp).split("/").pop(), kernel: dshStems.includes(stem) ? "dsh" : "pi", states: st, detail });
  }
  ok(tabStates.length > 0, `面板能对会话行展示记录（${tabStates.length} 个会话有记录行）`);
  ok(tabStates.every((t) => t.states.every((x) => x === "ok")), `面板里每条记录行状态都是 ok（${JSON.stringify(tabStates.slice(0, 3).map((t) => ({ k: t.kernel, s: t.states })))}）`);
  // 两内核在**同一个面板**里渲染出同一套分区（数据层对齐 ≠ DOM 对齐，这条断的是后者）。
  //
  // ⚠ 判据分两档，别加码（这一条第一版就栽了，红在 pi 上）：
  //   · **契约定档**（任何被识别的请求都必须有）：请求 / 响应 / 消息历史 / 原始 JSON；
  //   · **形状定档**（有才画）：`工具定义` 看 payload.tools 有没有；**`System 提示` 看顶层有没有
  //     `system` 字段**——Anthropic 形状与 dsh 的 GenerateOptions 都有，**OpenAI 形状没有**
  //     （它的 system prompt 是 messages 里的一条 role=system，落在「消息历史」里）。
  //   要求两内核都出现「System 提示」= 我发明的强条件，系统从没承诺过。
  const ALWAYS = ["请求", "响应", "消息历史", "原始 JSON"];
  const byK = {};
  for (const t of tabStates) (byK[t.kernel] ??= []).push(t);
  const shapes = { pi: new Set(), dsh: new Set() };
  for (const k of ["pi", "dsh"]) {
    const ts = byK[k] ?? [];
    ok(ts.length > 0, `[${k}] 面板里能看到它的记录行（${ts.length} 个会话）`);
    ok(ts.every((t) => ALWAYS.every((sec) => t.detail.includes(sec))),
       `[${k}] 记录详情摊开成契约保证的分区（${ALWAYS.join("/")}）—— 与另一内核同构`);
    for (const t of ts) for (const sec of ["工具定义", "System 提示"]) if (t.detail.includes(sec)) shapes[k].add(sec);
  }
  ok(shapes.dsh.has("System 提示") && shapes.dsh.has("工具定义"),
     "[dsh] 有顶层 system 与 tools → 「System 提示」「工具定义」两区都画出来了");
  ok(shapes.pi.has("工具定义"),
     "[pi] 有 tools → 「工具定义」画出来了（OpenAI 形状无顶层 system，System 提示不画是**对的**）");

  ok(consoleTail.length === 0, `页面零报错（实际 ${consoleTail.length} 条）`);

  await killApp(app);
  mockServer.close();
  console.log(`\n✅ PASS: ${passed} 项断言（三内核同场：pi/dsh/minimal 各跑一轮真回合 + 互不污染，零 token）`);
  if (!args.keep) rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(0);
} catch (e) {
  console.error(`\n❌ FAIL: ${e.message}`);
  console.error("  页面报错:", JSON.stringify(consoleTail.slice(0, 3)));
  console.error("  mock 收到的 model:", JSON.stringify(seenModels));
  await killApp(app).catch(() => {});
  mockServer.close();
  console.error(`   现场保留: ${runRoot}`);
  process.exit(1);
}
