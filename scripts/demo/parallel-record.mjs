#!/usr/bin/env node
// 并发录制编排 —— 10 剧本 × 2 语言 = 20 个录制任务,并发 N 个 worker 并行跑。
//
// 并发安全依据(record.mjs/prefs.mjs 已适配):
// - 每条录制独立一次性 HOME(pi-demo-<时间戳>/<locale>),实例间互不干扰
// - makeRunRoot 只清过期残留(>1h),不删并发实例的根
// - 每个 worker 独立 CDP 端口(9222 + i),互不冲突
//
// 用法:
//   node scripts/demo/parallel-record.mjs [--concurrency 4] [--scenario basic-tour]
//     --scenario 指定则只录该剧本(× 2 语言),省略录全部 10 个
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const RECORD = resolve(HERE, "record.mjs");

const args = process.argv.slice(2);
const concIdx = args.indexOf("--concurrency");
const concurrency = Number(concIdx >= 0 ? args[concIdx + 1] : 4);
const scenIdx = args.indexOf("--scenario");
const onlyScenario = scenIdx >= 0 ? args[scenIdx + 1] : null;

const SCENARIOS = [
  "basic-tour", "theme-settings", "notes-ping", "tool-schedule", "llm-recorder",
  "review-comments", "pins", "bookmark", "manager-tour", "debug-inspect",
];
const LOCALES = ["zh-CN", "en"];

// 场景交错排列(locale 外层):并发窗口尽量展示不同场景——
// 按场景顺序排时前 N 个任务常是同批主题类场景,4 个窗口看起来都在干同一件事。
const tasks = [];
for (const l of LOCALES) {
  for (const s of SCENARIOS) {
    if (onlyScenario && s !== onlyScenario) continue;
    tasks.push({ s, l });
  }
}

if (!existsSync(resolve(ROOT, "out", "main", "index.js"))) {
  console.error("未找到 out/ 构建产物,先跑: npm run build");
  process.exit(1);
}
console.log(`任务 ${tasks.length} 个 × 并发 ${concurrency} (端口 9222..${9221 + concurrency})`);
console.log(`场景: ${[...new Set(tasks.map((t) => t.s))].join(", ")}`);

/** 跑一个录制任务(独立进程,独立端口)。resolve(exitCode)。 */
function runTask(task, port) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RECORD, "--scenario", task.s, "--locales", task.l, "--port", String(port)], {
      cwd: ROOT,
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("exit", (code) => resolve({ ...task, code: code ?? -1 }));
  });
}

const results = [];
let next = 0;
const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async (_, i) => {
  const port = 9222 + i;
  while (next < tasks.length) {
    const task = tasks[next++];
    const t0 = Date.now();
    process.stdout.write(`\n[${task.s}/${task.l}] 开始(端口 ${port})\n`);
    const r = await runTask(task, port);
    const sec = ((Date.now() - t0) / 1000).toFixed(0);
    process.stdout.write(`[${task.s}/${task.l}] 结束(${sec}s, 退出码 ${r.code})\n`);
    results.push(r);
  }
});

await Promise.all(workers);

console.log("\n===== 汇总 =====");
const ok = results.filter((r) => r.code === 0);
const fail = results.filter((r) => r.code !== 0);
for (const r of ok) console.log(`  ✓ ${r.s}/${r.l}`);
for (const r of fail) console.log(`  ✗ ${r.s}/${r.l} (退出码 ${r.code})`);
console.log(`成功 ${ok.length}/${results.length}${fail.length ? `, 失败 ${fail.length} 个见上` : ""}`);
process.exit(fail.length ? 1 : 0);
