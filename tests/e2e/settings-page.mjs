// 设置页 e2e:puppeteer-core 连已启动的 Electron(9222 调试口),替代手写 CDP/WebSocket。
// 前置:npm start(prod 包 + 9222)或 npm run dev -- --remote-debugging-port=9222。
// 启动脚本已 env -u ELECTRON_RUN_AS_NODE(防 VSCode/Apps Studio 等 Electron 宿主终端的注入变量)。
import puppeteer from "puppeteer-core";

const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const pages = await browser.pages();
const page = pages.find((p) => p.url().startsWith("http")) ?? pages[0];
if (!page) {
  console.error("找不到应用页面(9222 端口无 page target)");
  process.exit(1);
}

/** 等 DOM 出现目标文本(waitForFunction 走 raf 驱动,不轮询 sleep)。 */
async function waitByText(text, timeout = 5000) {
  await page.waitForFunction(
    (t) => document.body.innerText.includes(t),
    { timeout },
    text,
  );
}

/** 找含文本的最深层可点击元素(排除外层容器)并点击。 */
async function clickByText(text) {
  return page.evaluate((t) => {
    const all = [...document.querySelectorAll("div")].filter((e) => e.textContent?.trim() === t && e.style.borderRadius);
    if (all.length === 0) {
      const fallback = [...document.querySelectorAll("*")].filter((e) => e.textContent?.trim() === t);
      if (fallback.length) { fallback[fallback.length - 1].click(); return true; }
      return false;
    }
    all[all.length - 1].click();
    return true;
  }, text);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log("  ✓", msg);
}

// ============ 测试开始 ============
let failures = 0;
try {
  // 前置:若在设置页先回对话页
  const onSettings = await page.evaluate(() =>
    [...document.querySelectorAll("*")].some((e) => e.textContent?.includes("返回对话")),
  );
  if (onSettings) {
    await clickByText("返回对话");
    await waitByText("设置", 3000);
  }

  // 1. 点"设置"
  assert(await clickByText("设置"), "点设置按钮");

  // 2. 进入设置页
  await waitByText("返回对话", 5000);
  console.log("  ✓ 进入设置页");

  // 3. 左列表 3 项
  const listCount = await page.evaluate(() =>
    [...document.querySelectorAll("div")].filter(
      (e) => (e.textContent === "Pi" || e.textContent === "主题" || e.textContent === "模型") && e.style.borderRadius?.includes("var"),
    ).length,
  );
  assert(listCount === 3, `设置页左列表 3 项,实际:${listCount}`);

  // 4. 点 Pi
  await page.evaluate(() => {
    [...document.querySelectorAll("div")].find((e) => e.textContent === "Pi" && e.style.borderRadius?.includes("var"))?.click();
  });
  await waitByText("Pi 内核版本管理", 5000);
  console.log("  ✓ 点Pi右边渲染(内核+配置上下分区)");

  // 5. 点主题
  await page.evaluate(() => {
    [...document.querySelectorAll("div")].find((e) => e.textContent === "主题" && e.style.borderRadius?.includes("var"))?.click();
  });
  await waitByText("主题", 5000);
  console.log("  ✓ 点主题右边渲染");

  // 6. 不显示暂无配置
  const noConfig = await page.evaluate(() => document.body.textContent?.includes("暂无配置"));
  assert(noConfig === false, "不显示暂无配置");
} catch (e) {
  console.error("  ✗ 测试失败:", e.message);
  failures++;
}
console.log(`\n${failures === 0 ? "✅ 全部通过" : "❌ " + failures + " 项失败"}`);
browser.disconnect();
process.exit(failures === 0 ? 0 : 1);
