#!/usr/bin/env node
// 内核插件**差量重载**的真机 e2e（boot-surface.md §3.6.2，三方向验收里的「改」与「删」）。
//
// 为什么这两条能在本轮做、「增」不能：新增一个内核需要一份**可装载的第四内核产物**
// （`<构建根>/<id>/plugin.js`），而现有三个内核的工厂都把 id 写死在自己产物里
// （`kernel/minimal/plugin.ts:53` 是 `id: "minimal"`），复用任一产物都会撞
// r17 新加的 **id 单源校验**（`manifest.id !== plugin.id` → fail-fast）。
// 所以「增」要么等一个真的第四内核，要么在 test-plugins 下加一份完整产物——
// 那是独立一件工作，不在本轮用替身糊过去（§7 严禁 mock 式）。
//
// 「改」与「删」都用**真实的 minimal 产物**（`seedTestPlugins` 种进隔离 HOME 的用户插件目录，
// 那正是第三方内核插件被装载的真实路径），所以走的是生产代码路径，不是测试旁路。
//
// 顺带钉住一个**已知未修**的缺口（§3.6.4）：`window.kernel.kernelIds` 是 boot 时的快照，
// 重载后不会自己更新——本剧本断言它**仍然是旧值**，把这个缺口变成有证据的待办，
// 而不是"看起来重载全通了"。
//
// 用法: npm run build && node scripts/demo/kernel-reload.e2e.mjs [--port 9360] [--keep]
import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, killApp } from "./lib/app.mjs";
import { makeRunRoot, setupBaseline, setupDshKernel } from "./lib/home.mjs";
import { seedTestPlugins } from "./lib/test-plugins.mjs";
import { clickPointUntil } from "./lib/interact.mjs";
import { waitForDomIdle } from "./lib/util.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const { values: args } = parseArgs({ options: { port: { type: "string", default: "9360" }, keep: { type: "boolean", default: false } } });

let passed = 0;
function ok(cond, label) {
  if (!cond) throw new Error(`断言失败: ${label}`);
  passed += 1;
  console.log(`  ✓ ${label}`);
}

const runRoot = makeRunRoot();
const home = join(runRoot, "zh-CN");
mkdirSync(home, { recursive: true });
const ctx = setupBaseline({ home, realHome: homedir(), locale: "zh-CN" });
// dsh 的准备是**独立**的 setupDshKernel（不在 setupBaseline 里）。不调它的话 dsh 没有配置、
// 报 0 个模型，于是模型下拉只有 pi/minimal 两个 TAB——那不是缺陷，但会让"新增内核的 TAB
// 出现了吗"这类断言读起来含糊（r13 曾因此误报过一条 H 级，见 skill §17.9）。
const dsh = setupDshKernel(home, homedir());
const seeded = seedTestPlugins(ctx.dataRoot);
console.log(`  · dsh 准备：available=${dsh.available}`);
const projectDir = join(home, "project");
mkdirSync(projectDir, { recursive: true });
const prefsFile = join(ctx.configDir, "config.json");
writeFileSync(prefsFile, JSON.stringify({ ...JSON.parse(readFileSync(prefsFile, "utf-8")), lastCwd: projectDir }, null, 2));

// minimal 插件在隔离 HOME 里的真实位置（第三方内核插件的装载路径）
const minimalDir = seeded[0];
const minimalManifest = join(minimalDir, "plugin.json");
ok(existsSync(minimalManifest), `minimal 插件已种进隔离 HOME（${minimalDir.replace(home, "<HOME>")}）`);
const originalVersion = JSON.parse(readFileSync(minimalManifest, "utf-8")).version;
console.log(`  · minimal 原 version = ${originalVersion}`);

const app = await launchApp({ appDir: ROOT, port: Number(args.port), env: { HOME: home, MHD_PORT: "18469" }, timeoutMs: 90000 });
const page = app.page;
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

const reload = () => page.evaluate(() => window.kernel.reloadKernels());
const ids = () => page.evaluate(() => window.kernel.kernelIds);

try {
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 25000 });

  const before = await ids();
  console.log(`\n── 起点 ──\n  · renderer kernelIds = ${JSON.stringify(before)}`);
  ok(before.includes("minimal"), "起点：minimal 在册");
  // 记下三张映射的对象引用，稍后验"重载后引用不变、只有内容变"
  await page.evaluate(() => { window.__mapRef = window.kernel.kernels; });
  // boot 时的初始填充必须到位（改造后三张映射是可变对象，漏了初始填充就会是空对象——
  // 类型上完全合法、tsc 拦不住，所以这里显式验一次）
  const bootMaps = await page.evaluate(() => ({
    n: Object.keys(window.kernel.kernels).length,
    m: Object.keys(window.kernel.kernelModels).length,
    c: Object.keys(window.kernel.kernelConfig).length,
  }));
  ok(bootMaps.n === before.length && bootMaps.m === before.length && bootMaps.c === before.length,
    `boot 时三张映射已按清单填充（kernels=${bootMaps.n} models=${bootMaps.m} config=${bootMaps.c}，清单 ${before.length} 个）`);

  // ===== 方向「改」：只改 manifest 顶层 version → 工厂必须重跑 =====
  console.log("\n── 方向「改」：同 id 异 version ──");
  const bumped = "9.9.9";
  const m = JSON.parse(readFileSync(minimalManifest, "utf-8"));
  writeFileSync(minimalManifest, JSON.stringify({ ...m, version: bumped }, null, 2));
  let r = await reload();
  console.log(`  · 返回：added=${JSON.stringify(r.kernels.added)} replaced=${JSON.stringify(r.kernels.replaced)} removed=${JSON.stringify(r.kernels.removed)} unchanged=${JSON.stringify(r.kernels.unchanged)} errors=${r.kernels.errors.length}`);
  ok(r.kernels.changed === true, "changed=true");
  ok(r.kernels.replaced.length === 1 && r.kernels.replaced[0].id === "minimal", `minimal 被识别为「同 id 异 version」（实际 ${JSON.stringify(r.kernels.replaced)}）`);
  ok(r.kernels.replaced[0].from === originalVersion && r.kernels.replaced[0].to === bumped, `版本号如实报告（${r.kernels.replaced[0]?.from} → ${r.kernels.replaced[0]?.to}）`);
  ok(r.kernels.added.length === 0 && r.kernels.removed.length === 0, "没有误判成新增/删除");
  ok(r.kernels.unchanged.includes("pi") && r.kernels.unchanged.includes("dsh"), "未变的内核留在 unchanged（工厂不重跑）");
  ok(r.kernels.errors.length === 0, `无装载错误（${JSON.stringify(r.kernels.errors)}）`);

  // 再重载一次：什么都不该动（语义①「同 id 同 version 不重跑工厂」）
  r = await reload();
  ok(r.kernels.changed === false, "第二次重载无变化 → changed=false（不重跑工厂、不广播）");
  ok(r.kernels.replaced.length === 0 && r.kernels.added.length === 0 && r.kernels.removed.length === 0, "第二次重载三个变动清单全空");
  ok(r.kernels.unchanged.length === before.length, `第二次重载全部 unchanged（${r.kernels.unchanged.length} 个）`);

  // ===== 方向「删」：删掉插件目录 → 只摘注册表条目，应用照常活着 =====
  console.log("\n── 方向「删」：id 消失 ──");
  rmSync(minimalDir, { recursive: true, force: true });
  ok(!existsSync(minimalDir), "插件目录已删（卸载 = 删目录，与壳插件同规则）");
  r = await reload();
  console.log(`  · 返回：removed=${JSON.stringify(r.kernels.removed)} unchanged=${JSON.stringify(r.kernels.unchanged)} errors=${r.kernels.errors.length}`);
  ok(r.kernels.removed.join() === "minimal", `minimal 被识别为已移除（实际 ${JSON.stringify(r.kernels.removed)}）`);
  console.log(`  · 壳侧：deactivated=${JSON.stringify(r.shell.deactivated)} activated=${JSON.stringify(r.shell.activated)}`);
  ok(r.shell.deactivated.includes("minimal"), "壳插件侧也摘掉了它（否则设置页 TAB 会留着、点进去只能报错）");
  ok(r.kernels.changed === true, "changed=true");
  ok(r.kernels.errors.length === 0, "删除不产生装载错误");
  ok(r.kernels.unchanged.includes("pi") && r.kernels.unchanged.includes("dsh"), "其余内核不受影响（撤销一个不牵连别的）");

  // main 侧注册表确实少了 minimal（经 reloadKernels 的 unchanged 已可推断；再直接问一次清单）
  const liveList = await page.evaluate(() => window.kernel.kernelLogos.get("minimal").then((l) => !!l).catch(() => false));
  console.log(`  · kernelLogos.get("minimal") 仍有值 = ${liveList}（last-known 语义：曾在册 → 仍返回 logo，这是**有意**的）`);

  // ===== §3.6.4 已落地：renderer 侧清单**必须**跟着变（这条断言在 r17 是反过来的）=====
  //
  // r17 时这里**故意**断言"快照仍含已删的 minimal"，把缺口变成有证据的待办，
  // 并注明"§3.6.4 落地后应当反过来改、且注释一起删掉"。现在就是那个时候。
  const after = await ids();
  console.log(`\n── §3.6.4：renderer 侧清单与三张映射 ──\n  · reloadKernels() 之后 kernelIds = ${JSON.stringify(after)}`);
  ok(!after.includes("minimal"), "已删内核必须从 renderer 清单里消失（r17 时这里还是 stale 的）");
  ok(after.includes("pi") && after.includes("dsh"), "其余内核仍在");

  // 三张 per-id 映射：内容跟着变，但**对象引用必须恒定**——这是"解构出去的引用仍然有效"的前提
  const maps = await page.evaluate(() => {
    const k = window.kernel;
    return {
      kernelsKeys: Object.keys(k.kernels),
      modelsKeys: Object.keys(k.kernelModels),
      configKeys: Object.keys(k.kernelConfig),
      // 引用恒定性：把对象存到 window 上，重载后再比是不是同一个
      sameRef: window.__mapRef ? window.__mapRef === k.kernels : null,
    };
  });
  console.log(`  · kernels 键=${JSON.stringify(maps.kernelsKeys)} models 键=${JSON.stringify(maps.modelsKeys)} config 键=${JSON.stringify(maps.configKeys)}`);
  for (const [name, keys] of [["kernels", maps.kernelsKeys], ["kernelModels", maps.modelsKeys], ["kernelConfig", maps.configKeys]]) {
    ok(!keys.includes("minimal"), `${name} 里已删内核的条目要被清掉（否则点到它只会拿到 undefined 或 TypeError）`);
    ok(keys.includes("pi") && keys.includes("dsh"), `${name} 里其余内核仍在`);
  }

  // ===== 方向「增」：把插件目录还原回去 → 必须被当作"新内核"装载，且一路通到用户可见面 =====
  //
  // 为什么用"还原 minimal"而不是造一个第四内核：① 用的是**真实产物**（不是替身，§7）；
  // ② 语义完全等价——"一个此前不在注册表里的内核插件出现了"，这正是「增」的定义；
  // ③ 它还能一路验到用户可见面并**零 token 发一条消息跑通**（minimal 是 echo 内核），
  //    而一个手写的第四内核桩只能验到注册表那一层。
  console.log("\n── 方向「增」：插件目录重新出现 ──");
  seedTestPlugins(ctx.dataRoot);
  ok(existsSync(minimalManifest), "插件目录已还原");
  r = await reload();
  console.log(`  · 返回：added=${JSON.stringify(r.kernels.added)} replaced=${JSON.stringify(r.kernels.replaced)} unchanged=${JSON.stringify(r.kernels.unchanged)} errors=${r.kernels.errors.length}`);
  ok(r.kernels.added.join() === "minimal", `minimal 被识别为新增（实际 ${JSON.stringify(r.kernels.added)}）`);
  console.log(`  · 壳侧：activated=${JSON.stringify(r.shell.activated)} deactivated=${JSON.stringify(r.shell.deactivated)}`);
  ok(r.shell.activated.includes("minimal"), "壳插件侧也拾起了它（否则设置页不会出现它的 TAB）");
  ok(r.kernels.changed === true, "changed=true");
  ok(r.kernels.errors.length === 0, `新增装载无错误（${JSON.stringify(r.kernels.errors)}）`);
  const afterAdd = await ids();
  ok(afterAdd.includes("minimal"), `renderer 清单重新含 minimal（${JSON.stringify(afterAdd)}）`);
  const mapsAfterAdd = await page.evaluate(() => ({
    kernels: Object.keys(window.kernel.kernels),
    models: Object.keys(window.kernel.kernelModels),
    config: Object.keys(window.kernel.kernelConfig),
  }));
  ok(mapsAfterAdd.kernels.includes("minimal") && mapsAfterAdd.models.includes("minimal") && mapsAfterAdd.config.includes("minimal"),
    `三张映射都补回了 minimal 条目（${JSON.stringify(mapsAfterAdd)}）`);

  // 用户可见面①：模型下拉里出现它的 TAB
  const trig = await page.evaluate(() => {
    const b = document.querySelector("button[data-composer-model]");
    if (!b) return null;
    const rect = b.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  await page.mouse.click(trig.x, trig.y);
  await page.waitForSelector("[role='menu']", { timeout: 8000 });
  await waitForDomIdle(page, { quietMs: 600, timeoutMs: 10000 }).catch(() => {});
  const tabs = await page.evaluate(() => [...document.querySelectorAll("[role='menu'] button")]
    .map((b) => (b.textContent || "").trim()).filter((t) => t && t.length < 20));
  console.log(`  · 模型下拉 TAB：${JSON.stringify(tabs)}`);
  ok(tabs.some((t) => t.toLowerCase() === "minimal"), "新增内核的 TAB 出现在模型下拉里");

  // 用户可见面②：切到它、选它的模型、发一条消息跑通（minimal 是 echo 内核 → 零 token）
  const switched = await clickPointUntil(
    page,
    () => {
      const tab = [...document.querySelectorAll("[role='menu'] button")].find((b) => (b.textContent || "").trim().toLowerCase() === "minimal");
      if (!tab) return null;
      const rect = tab.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    },
    () => [...document.querySelectorAll("[role^='menuitem']")].some((el) => (el.textContent || "").includes("Minimal Echo") && el.getBoundingClientRect().width > 0),
  );
  ok(switched, "切到新增内核的 TAB 后能列出它的模型");
  const itemRect = await page.evaluate(() => {
    const it = [...document.querySelectorAll("[role^='menuitem']")].find((el) => (el.textContent || "").includes("Minimal Echo") && el.getBoundingClientRect().width > 0);
    if (!it) return null;
    const rect = it.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  await page.mouse.click(itemRect.x, itemRect.y);
  await waitForDomIdle(page, { quietMs: 700, timeoutMs: 12000 }).catch(() => {});
  const bound = await page.evaluate(() => document.querySelector("[data-composer-model]")?.getAttribute("data-composer-model"));
  ok(String(bound).startsWith("minimal:"), `composer 已绑到新增内核（${bound}）`);

  const PROMPT = "重载后新增内核可用性验证";
  await page.click("[data-timeline-composer]");
  await page.keyboard.type(PROMPT);
  const sendRect = await page.evaluate(() => {
    const b = document.querySelector("button[aria-label*='发送']");
    if (!b) return null;
    const rect = b.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  await page.mouse.click(sendRect.x, sendRect.y);
  // ⚠ 判据要用**真实的 echo 文本**：minimal 的回复格式是 `[minimal echo] <原文>`
  //   （见 kernel/minimal/backend/minimal-backend.test.ts:70），不是 `[echo]`——
  //   首版凭印象写了 `[echo]`，于是回复明明到了却判失败。
  // ⚠ 等法用 waitForFunction 轮询目标文本，不用"等停止钮消失 + 固定 settle"：
  //   重载后第一次发送要冷启动内核进程，耗时不定（minimal-smoke.e2e.mjs 的注释里就记着这条）。
  // ⚠ puppeteer 的签名是 `waitForFunction(pageFunction, options, ...args)`——**options 在第二位**。
  //   首版写成 `(fn, PROMPT, { timeout, polling })`，于是 options 收到的是字符串 PROMPT、
  //   页内函数的 `prompt` 参数收到的是那个 options 对象，匹配的是 "[minimal echo] [object Object]"
  //   → 回复明明在 DOM 里却判失败。这类"参数顺序"陷阱不报错、不抛异常，只让断言静默为假。
  const echoed = await page.waitForFunction(
    (prompt) => [...document.querySelectorAll("[data-message-id]")].some((el) => (el.textContent || "").includes(`[minimal echo] ${prompt}`)),
    { timeout: 60000, polling: 500 },
    PROMPT,
  ).then(() => true).catch(() => false);
  const replied = await page.evaluate((prompt) => {
    const cards = [...document.querySelectorAll("[data-message-id]")];
    const texts = cards.map((c) => (c.textContent || "").replace(/\s+/g, " "));
    return { total: cards.length, hasPrompt: texts.some((t) => t.includes(prompt)), sample: texts.slice(-2) };
  }, PROMPT);
  console.log(`  · 消息卡 ${replied.total} 张；含提问=${replied.hasPrompt}；末两张=${JSON.stringify(replied.sample).slice(0, 130)}`);
  ok(echoed, "用新增内核**发一条消息跑通**（`[minimal echo] …` 回复到达，零 token）");


  // ===== 验收①：设置页 TAB 与 logo（壳插件侧也要跟着收敛）=====
  //
  // 「一个内核 = 一个插件」：同一个目录既是内核插件（manifest.kernel → 内核注册表），
  // 也是壳插件（contributes.settings → 设置页 TAB）。只重载内核侧会留下半截状态：
  //   · 装了内核但设置页没有它的 TAB（用户无从配置）；
  //   · 删了内核但 TAB 还在，点进去只能拿到"内核 X 没有原生配置面"的错误——
  //     而 40-shell-plugins 冷启动本来就有一条过滤专门防这个（内核面未装载的不注册）。
  // 所以「重载内核插件」必须两侧都收敛（50-wiring 里先内核后壳，顺序不能反：
  // 壳侧的 isKernelLoadable 要查内核注册表）。
  console.log("\n── 验收①：设置页 TAB 与 logo ──");
  const openSettings = async () => {
    await page.evaluate(() => document.querySelector('[data-sidebar-entry="settings"]').click());
    await page.waitForSelector("[data-settings-id]", { timeout: 8000 });
    await waitForDomIdle(page, { quietMs: 600, timeoutMs: 10000 }).catch(() => {});
  };
  const closeSettings = async () => {
    await page.evaluate(() => document.querySelector('[data-settings-back="chat"]').click());
    await page.waitForSelector("[data-timeline-composer]", { timeout: 8000 });
    await waitForDomIdle(page, { quietMs: 600, timeoutMs: 10000 }).catch(() => {});
  };
  const settingsIds = () => page.evaluate(() => [...document.querySelectorAll("[data-settings-id]")].map((e) => e.getAttribute("data-settings-id")));

  await openSettings();
  const idsAfterAdd = await settingsIds();
  console.log(`  · 设置页入口（增之后）：${JSON.stringify(idsAfterAdd)}`);
  ok(idsAfterAdd.includes("minimal"), "新增内核的**设置页 TAB 出现了**（壳插件侧也收敛了）");
  ok(idsAfterAdd.includes("pi") && idsAfterAdd.includes("dsh"), "其余内核的设置页入口仍在");
  await closeSettings();

  // logo 正确：不是"有值"就算，要验它确实是 minimal 自己声明的那个标
  // （MINIMAL_LOGO：viewBox "0 0 24 24"、label "minimal"、单 path、fillRule evenodd）
  const logo = await page.evaluate(() => window.kernel.kernelLogos.get("minimal"));
  console.log(`  · minimal logo：label=${JSON.stringify(logo?.label)} viewBox=${JSON.stringify(logo?.viewBox)} paths=${logo?.paths?.length} fillRule=${JSON.stringify(logo?.paths?.[0]?.fillRule)}`);
  ok(logo && logo.label === "minimal" && logo.viewBox === "0 0 24 24" && logo.paths?.length === 1 && logo.paths[0].fillRule === "evenodd",
    "logo 是 minimal 自己声明的那个标（不是占位、不是别的内核的）");

  // ===== 应用整体仍然健康（重载不该把在跑的应用打回不可用）=====
  console.log("\n── 健康检查 ──");
  const healthy = await page.evaluate(() => ({
    composer: !!document.querySelector("[data-timeline-composer]"),
    model: document.querySelector("[data-composer-model]")?.getAttribute("data-composer-model") ?? null,
    sessionRows: document.querySelectorAll("[data-session-path]").length,
  }));
  ok(healthy.composer, "composer 仍在");
  ok(typeof healthy.model === "string" && healthy.model.length > 0, `模型锚点仍有值（${healthy.model}）`);
  const sameRef = await page.evaluate(() => window.__mapRef === window.kernel.kernels);
  ok(sameRef, "三张映射的**对象引用恒定**（重载只原地重建内容）——否则解构出去的引用会指向空壳");
  // 显式重拉入口也要可用（幂等）
  // 显式重拉入口：返回值必须与"当前真实清单"一致。
  // ⚠ 这条断言在 r18 改过一次——原先写的是"不含 minimal"（那是「删」阶段之后的状态），
  //   加了「增」阶段之后 minimal 又被还原了，断言就成了过期的期望。教训：**断言要写不变量**
  //   （"与 kernelIds 一致"），不要写某个阶段的具体值，否则剧本一加阶段它就悄悄失真。
  const refetched = await page.evaluate(() => window.kernel.reloadKernelIds());
  const currentIds = await ids();
  ok(Array.isArray(refetched) && refetched.length === currentIds.length
     && refetched.every((k, i) => k === currentIds[i]),
     `reloadKernelIds() 返回的清单与 window.kernel.kernelIds 一致（${JSON.stringify(refetched)}）`);
  ok(refetched.includes("minimal"), "「增」阶段之后 minimal 应在册");
  console.log(`  · 会话行 ${healthy.sessionRows} 个`);
  ok(pageErrors.length === 0, `页面零报错（实际 ${pageErrors.length} 条${pageErrors.length ? ": " + pageErrors.slice(0, 2).join(" | ").slice(0, 160) : ""}）`);
} finally {
  await killApp(app);
}

console.log(`\n✅ PASS: ${passed} 项断言（内核插件差量重载：改 / 删 / 增 三方向，真实 minimal 产物）`);
console.log(`   隔离 HOME: ${home}${args.keep ? "（--keep 保留）" : ""}`);
console.log("   三方向齐了：改（version bump → 工厂重跑）/ 删（目录消失 → 只摘条目）/ 增（目录还原 → 装载 + 发消息跑通）。");
