#!/usr/bin/env node
// 批量三倍速 + 合并 —— 把 docs/demo/demo-<scenario>-<locale>.gif 全部加速 3x,
// 再按场景顺序合成一条总 GIF(demo-all.gif)。
//
// 用法:
//   node scripts/demo/speed-up.mjs            # 处理 docs/demo/ 下全部 demo-*-<locale>.gif
//   node scripts/demo/speed-up.mjs --list     # 只列出将处理的文件不执行
//
// ffmpeg 调色板管线(与 recorder.mjs toGif 同款):setpts=PTS/3 加速后
// palettegen/paletteuse 收敛色板,体积与画质和原 GIF 同级。
import { execFile } from "node:child_process";
import { existsSync, readdirSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const HERE = resolve(import.meta.dirname ?? ".");
const OUT_DIR = resolve(HERE, "..", "..", "docs", "demo");

/** 场景顺序:与录制清单一致,合并按此序拼接。 */
const SCENARIO_ORDER = [
  "basic-tour", "theme-settings", "notes-ping", "tool-schedule", "llm-recorder",
  "review-comments", "pins", "bookmark", "manager-tour", "debug-inspect",
];

async function ffmpeg(args) {
  try {
    await run("ffmpeg", args, { maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    throw new Error(`ffmpeg 失败: ${err.message}\n${String(err.stderr ?? "").slice(-1500)}`);
  }
}

/** 3x 加速:setpts=PTS/3 + 调色板管线(与 recorder 同款滤镜链)。 */
async function speedUp3x(src, dst) {
  const vf = [
    "setpts=PTS/3",
    "split[a][b]",
    "[a]palettegen=stats_mode=diff[p]",
    "[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle",
  ].join(",");
  await ffmpeg(["-y", "-loglevel", "error", "-i", src, "-vf", vf, "-loop", "0", dst]);
}

/** 合并:按场景顺序 concat 所有 3x GIF(调色板统一管线,衔接处抖动最小化)。 */
async function mergeAll(orderedFiles, dst) {
  const inputs = [];
  const filters = [];
  orderedFiles.forEach((f, i) => {
    inputs.push("-i", f);
    filters.push(`[${i}:v]setpts=PTS-STARTPTS[v${i}]`);
  });
  const inputLabels = orderedFiles.map((_, i) => `[v${i}]`).join("");
  const concat = `${inputLabels}concat=n=${orderedFiles.length}:v=1:a=0,split[a][b],[a]palettegen=stats_mode=diff[p],[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle[out]`;
  await ffmpeg(["-y", "-loglevel", "error", ...inputs, "-filter_complex", [...filters, concat].join(";"), "-map", "[out]", "-loop", "0", dst]);
}

function plan() {
  const files = readdirSync(OUT_DIR).filter((f) => /^demo-.*-(zh|en)\.gif$/.test(f));
  const byScenario = new Map();
  for (const f of files) {
    const m = f.match(/^demo-(.+)-(zh|en)\.gif$/);
    if (!m) continue;
    if (!byScenario.has(m[1])) byScenario.set(m[1], []);
    byScenario.get(m[1]).push(f);
  }
  const ordered = SCENARIO_ORDER
    .filter((s) => byScenario.has(s))
    .flatMap((s) => [...byScenario.get(s)].sort());
  // 未在清单里的场景(遗留/新加的)排在后面
  for (const [s, fs] of byScenario) {
    if (!SCENARIO_ORDER.includes(s)) ordered.push(...fs.sort());
  }
  return ordered;
}

const ordered = plan();
if (process.argv.includes("--list")) {
  console.log("将处理:", ordered.join(", ") || "(无)");
  process.exit(0);
}
if (ordered.length === 0) {
  console.error("docs/demo/ 下没有 demo-*-<locale>.gif,先跑录制。");
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
console.log(`共 ${ordered.length} 条 GIF,逐个 3x 加速…`);
const speedUpList = [];
for (const f of ordered) {
  const src = join(OUT_DIR, f);
  const dst = join(OUT_DIR, f.replace(/\.gif$/, "-3x.gif"));
  speedUpList.push(dst);
  console.log(`  3x → ${f.replace(/\.gif$/, "")}-3x.gif`);
  await speedUp3x(src, dst);
}

const merged = join(OUT_DIR, "demo-all.gif");
console.log(`合并 ${speedUpList.length} 条 → demo-all.gif`);
await mergeAll(speedUpList, merged);
const { statSync } = await import("node:fs");
for (const f of [...speedUpList, merged]) {
  console.log(`  ${join(OUT_DIR, f).replace(OUT_DIR + "/", "")}  (${(statSync(f).size / 1024).toFixed(0)}KB)`);
}
console.log("完成。");
