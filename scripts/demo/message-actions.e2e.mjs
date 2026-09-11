#!/usr/bin/env node
// 消息行动作(收藏/分叉)真实 DOM e2e —— 隔离 HOME + 种中立层会话(零模型调用,确定性)。
// 复核问题8:assistant 消息行必须有「收藏」「分叉」入口
// (根因:新会话 currentNeutralSessionId 此前靠 sessionInfos 列表反查恒落空,按钮整批不渲染;
//  现 sessionStart 事件直接携带中立主键 + openSession 读回)。
//
// 用法: npm run build && node scripts/demo/message-actions.e2e.mjs [--port 9336] [--keep]
import { parseArgs } from "node:util";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { assertPortFree, launchApp, killApp } from "./lib/app.mjs";
import { makeRunRoot, setupBaseline } from "./lib/home.mjs";
import { loadScenario, applySeed } from "./lib/seed/engine.mjs";
import { waitForDomIdle } from "./lib/util.mjs";
import { clickByText } from "./lib/interact.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const { values: args } = parseArgs({
  options: { port: { type: "string", default: "9336" }, keep: { type: "boolean", default: false } },
});
const PORT = Number(args.port);
const APP_PORT = 18423;

let passed = 0;
function ok(cond, label) {
  if (!cond) throw new Error(`断言失败: ${label}`);
  passed += 1;
  console.log(`  ✓ ${label}`);
}

if (!existsSync(join(ROOT, "out", "main", "index.js"))) {
  console.error("未找到 out/ 构建产物,先跑: npm run build");
  process.exit(1);
}

await assertPortFree(PORT);
const runRoot = makeRunRoot();
const home = join(runRoot, "zh-CN");
const shotsDir = join(runRoot, "e2e-shots");
mkdirSync(shotsDir, { recursive: true });

const realHome = homedir();
const ctx = setupBaseline({ home, realHome, locale: "zh-CN" });
const scenarioDir = join(HERE, "scenarios", "goal-command");
const bundle = await loadScenario(scenarioDir, "zh-CN");
applySeed(ctx, scenarioDir, bundle.spec, bundle.dict);

// 种中立层会话(确定性,零模型):一条 user + 一条带 id 的 assistant。
const projectCwd = join(home, "project"); // goal-command 场景种的 todo 项目(presets/projects.json: todo → project/)
const NS = "ns-seeded-actions";
const now = Date.now();
const neutralDir = join(home, ".my-harness-desktop-dev", "sessions");
mkdirSync(neutralDir, { recursive: true });
writeFileSync(join(neutralDir, `${NS}.json`), JSON.stringify({
  neutralSessionId: NS,
  header: { kernel: "pi", cwd: projectCwd, createdAt: new Date(now - 60000).toISOString(), name: "种子会话" },
  lineages: [{
    lineageId: NS,
    fork: null,
    entries: [
      { neutralEntryId: `${NS}:0`, kernelEntryId: "k0", message: { role: "user", content: "帮我看看", id: "k0", timestamp: new Date(now - 50000).toISOString() } },
      { neutralEntryId: `${NS}:1`, kernelEntryId: "k1", message: { role: "assistant", content: [{ type: "text", text: "看完了，没问题。" }], id: "k1", timestamp: new Date(now - 49000).toISOString() } },
    ],
  }],
}));

const app = await launchApp({ appDir: ROOT, port: PORT, env: { HOME: home, MHD_PORT: String(APP_PORT) }, timeoutMs: 90000 });
const page = app.page;

try {
  await page.waitForFunction(() => document.readyState === "complete", { timeout: 30000 });
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 25000 });

  // 从会话列表打开种子会话(列表渲染是异步的:等列表项出现再点,点完等内容渲染;
  // 一次点击可能落空(竞态),最多重试 3 次——事件驱动,不赌固定时序)
  let opened = false;
  for (let attempt = 0; attempt < 3 && !opened; attempt++) {
    await page.waitForFunction(
      () => [...document.querySelectorAll("*")].some((e) => (e.textContent || "").trim() === "种子会话" && e.children.length < 6),
      { timeout: 15000, polling: 300 },
    );
  // 会话行点击走可信点击(合成 MouseEvent 对 Radix 行点击实测翻车过)。
  if (!(await clickByText(page, '种子会话', { exact: true }))) throw new Error("未找到会话行: 种子会话");
    opened = await page.waitForFunction(() => document.body.innerText.includes("看完了，没问题。"), { timeout: 8000, polling: 300 })
      .then(() => true)
      .catch(() => false);
  }
  ok(opened, "会话列表里点开种子会话 + 内容渲染(assistant 消息在)");
  await waitForDomIdle(page, { quietMs: 500, timeoutMs: 8000 }).catch(() => {});

  // 问题8:assistant 消息行有「收藏」「分叉」入口
  const rowTitles = await page.evaluate(() =>
    [...document.querySelectorAll("[data-message-id]")].map((row) => ({
      head: (row.textContent || "").slice(0, 30),
      titles: [...row.querySelectorAll("button[title]")].map((b) => b.getAttribute("title")),
    })));
  console.log("  [diag] 消息行:", JSON.stringify(rowTitles, null, 1));
  const flat = rowTitles.flatMap((r) => r.titles);
  ok(flat.includes("收藏"), "assistant 行有「收藏」入口(问题8)");
  ok(flat.includes("分叉"), "assistant 行有「分叉」入口(问题8)");

  await killApp(app);
  console.log(`\n✅ PASS: ${passed} 项断言全部通过(消息行收藏/分叉入口,种子会话确定性验证)`);
  if (!args.keep) rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(0);
} catch (err) {
  console.error(`\n❌ FAIL: ${err.message}`);
  await killApp(app).catch(() => {});
  process.exit(1);
}
