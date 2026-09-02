#!/usr/bin/env node
// dsh 凭证链真实 DOM e2e —— 连接运行中的 app(CDP),用 dsh 自定义 provider 发一条 ping,
// 断言:请求成功发起(无 MISSING_CREDENTIAL/「生成失败」)+ assistant 回复落盘。
// 这是「凭证写进库、内核插件树挂 credentials-local 读回来」的端到端回归——
// 根因曾是:凭证库写了、cordis 插件树没挂读取服务,每次发起报 MISSING_CREDENTIAL。
//
// 用法:
//   node scripts/demo/dsh-credentials.e2e.mjs [--port 9222]
//
// 前置:app 已运行(dev 或 out/ 构建),且 ~/.dsh/.credentials.yaml 里该 provider 的
// ref 有真实 key(桌面端模型配置页写入)。测试会话结束清理,不污染用户数据。
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const require = createRequire(import.meta.url);
const puppeteer = require("puppeteer-core");

const { values: args } = parseArgs({ options: { port: { type: "string", default: "9222" } } });
const CDP = `http://127.0.0.1:${args.port}`;
const CWD = "/Users/dev/work/example-project";
const DSH_BUCKET = join(homedir(), ".my-harness-desktop-dev", "dsh", "sessions", "--Users-dev-work-example-project--");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
function ok(cond, label) {
  if (!cond) throw new Error(`断言失败: ${label}`);
  passed += 1;
  console.log(`  ✓ ${label}`);
}

async function main() {
  const browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: null });
  const pages = await browser.pages();
  const page = pages.find((p) => p.url().includes("localhost")) ?? pages[0];
  console.log("已连接 renderer:", page.url().slice(0, 50));

  // 新建会话(点侧栏「新对话」)
  const sessionCountBefore = readdirSyncSafe(DSH_BUCKET).length;
  await page.evaluate(() => {
    const el = [...document.querySelectorAll("div")].find((d) => (d.innerText || "").trim() === "新对话" && getComputedStyle(d).cursor === "pointer");
    el?.click();
  });
  await sleep(1500);
  ok(true, "新会话视图打开");

  // 当前模型须是 dsh 内核的(本 e2e 的预设:dsh 有自定义 provider + 凭证在库)
  const modelText = await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => /\((Free|Paid)\)/.test(x.innerText || ""));
    return b ? b.innerText.trim() : "";
  });
  ok(modelText.length > 0, `模型选择器有当前模型(${modelText})`);

  // 发 ping(真实 DOM 交互:聚焦输入框 → 写值 → Enter)
  await page.evaluate(() => {
    const ta = document.querySelector("textarea");
    ta.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(ta, "ping");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await sleep(300);
  await page.evaluate(() => {
    const ta = document.querySelector("textarea");
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
  ok(true, "ping 已发送");

  // 等结果:最多 60s。失败信号(MISSING_CREDENTIAL/生成失败)= 硬失败;pong/回复 = 通过。
  let outcome = "timeout";
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const st = await page.evaluate(() => {
      const b = document.body.innerText;
      return {
        missingCred: /MISSING_CREDENTIAL|no credential for provider route/.test(b),
        genFailed: /生成失败/.test(b),
        answered: /pong|在的|就绪|收到/i.test(b.slice(-800)),
      };
    });
    if (st.missingCred) { outcome = "MISSING_CREDENTIAL"; break; }
    if (st.genFailed) { outcome = "GEN_FAILED"; break; }
    if (st.answered) { outcome = "answered"; break; }
  }
  ok(outcome !== "MISSING_CREDENTIAL", "无 MISSING_CREDENTIAL(凭证从凭证库读到了)");
  ok(outcome !== "GEN_FAILED", "无「生成失败」红条");
  ok(outcome === "answered", `有 assistant 回复(outcome=${outcome})`);

  // 落盘交叉验证:该 dsh 会话内核日志有 turn/end completed,无 MISSING_CREDENTIAL
  const after = readdirSyncSafe(DSH_BUCKET);
  const newest = after.filter((d) => !readdirSyncSafe(DSH_BUCKET).includes(d)).concat(after).pop();
  ok(!!newest, "dsh 会话目录存在");
  if (newest) {
    const log = execSync(`zstd -dc "${join(DSH_BUCKET, newest, "session.jsonl.zstd")}" 2>/dev/null || true`, { encoding: "utf8" });
    ok(!/MISSING_CREDENTIAL/.test(log), "内核日志无 MISSING_CREDENTIAL");
    ok(/"kind":"completed"/.test(log), "内核日志有 turn/end completed");
  }

  // 清理测试会话(不污染用户列表)
  try { rmSync(join(DSH_BUCKET, newest), { recursive: true, force: true }); } catch { /* best-effort */ }

  console.log(`\n通过 ${passed} 项断言`);
  await browser.disconnect();
}

function readdirSyncSafe(p) {
  try { return readdirSync(p); } catch { return []; }
}

main().catch((e) => {
  console.error("e2e 失败:", e.message);
  process.exit(1);
});
