#!/usr/bin/env node
// 内核调度 e2e（§目标 16）—— 真 app、真 pi 内核、真 dsh 内核、**零 token**。
//
// 验的是什么：**壳把会话派发给了正确的内核**（调度/路由），而不是"模型能不能回话"。
// 为什么能零 token：`session:setModel` 内部走 `ensureForSend` —— 它按目标内核
// **真的 spawn 那个内核的后端进程**，但一条消息都不发。所以「哪个内核被拉起来了」
// 不需要花任何 token 就能观测。
//
// 观测手段 = **能力面指纹**（内核无关，不按内核身份硬分支）：
//   pi      → capabilities.extension = true（有 extensions 扩展面）· thinking = false
//   dsh     → capabilities.thinking  = true（有 thinking 面）        · extension = false
//   minimal → 两者皆 false，只 fileBacked = true
// `session:getCapabilities()` 在有活进程时取的是**活进程**的内核与能力面（session-store
// 的 sessionCapabilitiesOf），所以拿到什么指纹 = 当前哪个内核的后端真的活着。
//
// 矩阵：pi → dsh → pi → dsh → pi（来回切 5 轮），每轮都复核内核与指纹；
// 并断言默认内核清单 = [pi, dsh]（minimal 的 kernel.enabled=false，不装载）。
//
// 用法: npm run build && node scripts/demo/kernel-dispatch.e2e.mjs [--port 9372] [--keep]
import { parseArgs } from "node:util";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, killApp } from "./lib/app.mjs";
import { makeRunRoot, setupBaseline, setupDshKernel } from "./lib/home.mjs";
import { waitForDomIdle } from "./lib/util.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const { values: args } = parseArgs({ options: { port: { type: "string", default: "9372" }, keep: { type: "boolean", default: false } } });

let passed = 0;
/** 当前在跑的 app（失败路径也要 kill：泄漏实例会霸占 CDP 端口，让下一次运行连到旧进程 → 假结果）。 */
let liveApp = null;
function ok(cond, label) {
  if (!cond) throw new Error(`断言失败: ${label}`);
  passed += 1;
  console.log(`  ✓ ${label}`);
}

const runRoot = makeRunRoot();
const home = join(runRoot, "zh-CN");
mkdirSync(home, { recursive: true });
setupBaseline({ home, realHome: homedir(), locale: "zh-CN" });
const dshSetup = setupDshKernel(home, homedir());
if (!dshSetup.available) throw new Error("本机没装 dsh 内核，本 e2e 需要真实内核（不伪造）");
const projectDir = join(home, "project");
mkdirSync(projectDir, { recursive: true });
const prefsFile = join(home, ".my-harness-desktop-dev", "config", "config.json");
writeFileSync(prefsFile, JSON.stringify({ ...JSON.parse(readFileSync(prefsFile, "utf-8")), lastCwd: projectDir }, null, 2));

/** 每个内核各自的面貌（能力指纹）。数据面写在这里，e2e 只做断言。 */
const EXPECTED = {
  pi: { extension: true, thinking: false },
  dsh: { extension: false, thinking: true },
};

try {
  const app = await launchApp({ appDir: ROOT, port: Number(args.port), env: { HOME: home, MHD_PORT: "18472" }, timeoutMs: 90000 });
  liveApp = app;
  const page = app.page;
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 25000 });

  // ── 插件携带的内核扩展：同一个壳插件的 extensions 声明，要按内核 id 各落到各的内核侧 ──
  // 这是「圆心/lifecycle/装配点零内核名」那条改动的端到端证据：框架只认 {内核 id: 相对路径}，
  // 派发给对应内核自己的同步实现（pi 写 ~/.pi/agent/extensions/，dsh 同步目录 + 挂 cordis.yml 块）。
  {
    const piFit = join(home, ".pi", "agent", "extensions", "my-harness-fit-pi-extension", "index.ts");
    const piPluginExt = join(home, ".pi", "agent", "extensions", "llm-recorder", "index.ts");
    const dshPluginExt = join(home, ".dsh", ".my-harness-desktop-plugins", "llm-recorder", "index.mjs");
    ok(existsSync(piFit), "随壳分发的 pi 适配扩展已同步（createPluginExtensionSync().syncFit 自解析资产）");
    ok(existsSync(piPluginExt), "壳插件声明的 extensions.pi 落到了 pi 的扩展位");
    ok(existsSync(dshPluginExt), "同一个壳插件的 extensions.dsh 落到了 dsh 的扩展位");
    const cordis = existsSync(dshSetup.cordisPath) ? readFileSync(dshSetup.cordisPath, "utf-8") : "";
    ok(/llm-recorder/.test(cordis), "dsh 侧同时挂上了 cordis.yml 块（不只是拷目录）");
  }

  // ── 默认内核清单：pi + dsh 装载，minimal 默认不装载（§目标 16） ──
  const kernelIds = await page.evaluate(() => window.kernel.kernelIds);
  ok(kernelIds.includes("pi") && kernelIds.includes("dsh"), `pi/dsh 都装载（实际 ${JSON.stringify(kernelIds)}）`);
  ok(!kernelIds.includes("minimal"), `minimal 默认不装载（实际 ${JSON.stringify(kernelIds)}）`);

  // ── 两个内核各自的模型清单（setModel 需要真实模型 id；从壳的中性模型面取，不写死） ──
  const models = await page.evaluate(async () => {
    const out = {};
    for (const k of window.kernel.kernelIds) out[k] = await window.kernel.kernelModels[k].list();
    return out;
  });
  for (const k of ["pi", "dsh"]) {
    ok(Array.isArray(models[k]) && models[k].length > 0, `${k} 模型清单非空（${models[k]?.length ?? 0} 个）`);
  }
  const pick = { pi: null, dsh: null };
  for (const k of ["pi", "dsh"]) {
    const p = models[k].find((x) => x.models?.length > 0);
    pick[k] = { provider: p.id, modelId: p.models[0].id };
  }
  console.log(`  调度目标：pi=${pick.pi.provider}/${pick.pi.modelId} · dsh=${pick.dsh.provider}/${pick.dsh.modelId}`);

  /** 起一个新会话壳 → 选目标内核的模型 → 读能力面指纹。全程不发消息（零 token）。 */
  const dispatch = async (kernel) => page.evaluate(async ({ cwd, kernel, provider, modelId }) => {
    await window.kernel.sessions.setContext(cwd, null);
    try {
      await window.kernel.sessions.setModel(provider, modelId, kernel);
    } catch (e) {
      return { error: String(e && e.message ? e.message : e) };
    }
    const caps = await window.kernel.sessions.getCapabilities();
    return { caps };
  }, { cwd: projectDir, kernel, provider: pick[kernel].provider, modelId: pick[kernel].modelId });

  // ── 调度矩阵：来回切 5 轮，每轮复核内核 + 能力指纹（真实内核进程被拉起） ──
  const order = ["pi", "dsh", "pi", "dsh", "pi"];
  for (let i = 0; i < order.length; i++) {
    const k = order[i];
    const r = await dispatch(k);
    ok(!r.error, `第 ${i + 1} 轮 ${k}：setModel 成功（${r.error ?? "ok"}）`);
    ok(r.caps.kernel === k, `第 ${i + 1} 轮调度到 ${k}（getCapabilities.kernel 实际 ${r.caps.kernel}）`);
    ok(
      r.caps.extension === EXPECTED[k].extension && r.caps.thinking === EXPECTED[k].thinking,
      `第 ${i + 1} 轮 ${k} 的能力指纹正确（extension=${r.caps.extension} thinking=${r.caps.thinking}）`,
    );
  }

  // ── 反面：拿一个不属于目标内核的模型去调度，必须显式报错（不静默落到别的内核） ──
  const cross = await dispatch2(page, projectDir, "dsh", pick.pi);
  async function dispatch2(p, cwd, kernel, model) {
    return p.evaluate(async (a) => {
      await window.kernel.sessions.setContext(a.cwd, null);
      try {
        await window.kernel.sessions.setModel(a.model.provider, a.model.modelId, a.kernel);
        const caps = await window.kernel.sessions.getCapabilities();
        return { caps };
      } catch (e) {
        return { error: String(e && e.message ? e.message : e) };
      }
    }, { cwd, kernel, model });
  }
  ok(
    typeof cross.error === "string" && /模型不在清单/.test(cross.error),
    `跨内核错配的模型显式报错（不静默调度到别的内核）：${cross.error ?? JSON.stringify(cross.caps)}`,
  );

  ok(pageErrors.length === 0, `无未捕获 pageerror（实际 ${pageErrors.length}）${pageErrors[0] ? "：" + pageErrors[0].slice(0, 160) : ""}`);

  await killApp(app);
  liveApp = null;
  console.log(`\n✅ PASS: ${passed} 项断言（内核调度：pi/dsh 真后端派发 + 来回切 + 错配显式拒绝，零 token）`);
  if (!args.keep) rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(0);
} catch (err) {
  console.error(`\n❌ FAIL: ${err.message}`);
  if (liveApp) await killApp(liveApp).catch(() => {});
  if (args.keep) console.error(`   现场保留: ${runRoot}`);
  if (!args.keep) rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(1);
}
