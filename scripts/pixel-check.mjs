#!/usr/bin/env node
// 截图像素级自检:借 Electron 渲染器解码截图 → canvas 采样,验证非黑屏/有内容/布局区域可辨。
// 截图临时拷进 out/renderer(后端静态根)经同源加载,避免 file:// 画布污染。
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, copyFileSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = process.argv[2];
if (!DIR) { console.error("usage: node pixel-check.mjs <截图目录>"); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const staging = resolve(ROOT, "out/renderer/__pixelcheck__");
const files = ["01-ui-ready.png", "02-after-interact.png", "03-ping-typed.png", "04-ping-sent.png", "05-ping-done.png"];
mkdirSync(staging, { recursive: true });
for (const f of files) copyFileSync(`${DIR}/${f}`, `${staging}/${f}`);

const child = spawn(require("electron"), [ROOT, "--remote-debugging-port=9222"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
child.stdout.resume(); child.stderr.resume();

try {
  const deadline = Date.now() + 45000;
  let alive = false;
  while (!alive && Date.now() < deadline) {
    try { alive = (await fetch("http://127.0.0.1:9222/json/version", { signal: AbortSignal.timeout(1000) })).ok; } catch { await sleep(300); }
  }
  const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9222", defaultViewport: null });
  let page = null;
  const pd = Date.now() + 30000;
  while (!page && Date.now() < pd) {
    for (const p of await browser.pages()) if (p.url().includes("127.0.0.1:8420")) { page = p; break; }
    if (!page) await sleep(300);
  }
  if (!page) throw new Error("app 页未就绪");
  await page.waitForFunction(() => !!window.kernel?.plugins?.list, { timeout: 30000 });
  for (const f of files) {
    const stat = await page.evaluate(async (src) => {
      const img = new Image();
      img.src = src;
      await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error("img load fail")); });
      const c = document.createElement("canvas");
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, c.width, c.height).data;
      const px = (x, y) => { const i = (y * c.width + x) * 4; return [data[i], data[i + 1], data[i + 2]]; };
      const lum = (p) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
      let sum = 0, bright = 0; const colors = new Set();
      const step = 16;
      for (let y = 0; y < c.height; y += step) for (let x = 0; x < c.width; x += step) {
        const p = px(x, y); const l = lum(p);
        sum += l; if (l > 120) bright++;
        colors.add(`${p[0] >> 4}-${p[1] >> 4}-${p[2] >> 4}`);
      }
      const n = (c.width / step) * (c.height / step);
      const regions = {
        titlebar: px(c.width >> 1, 20),
        sidebar: px(100, c.height >> 1),
        center: px(c.width >> 1, c.height >> 1),
        composer: px(c.width >> 1, c.height - 60),
      };
      return { w: c.width, h: c.height, avgLum: Math.round(sum / n), brightPct: Math.round((bright / n) * 100), distinctColors: colors.size, regions };
    }, `http://127.0.0.1:8420/__pixelcheck__/${f}`);
    console.log(`${f}: ${stat.w}x${stat.h} avgLum=${stat.avgLum} bright=${stat.brightPct}% colors=${stat.distinctColors} regions=${JSON.stringify(stat.regions)}`);
  }
  browser.disconnect();
} catch (e) {
  console.error("pixel-check failed:", e);
  process.exitCode = 1;
} finally {
  child.kill("SIGINT");
  await sleep(4000);
  if (child.exitCode === null) child.kill("SIGKILL");
  rmSync(staging, { recursive: true, force: true });
}
