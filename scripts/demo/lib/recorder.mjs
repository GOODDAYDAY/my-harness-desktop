// 帧录制 + GIF 合成 —— 每帧一张 PNG + 独立时长(concat demuxer),ffmpeg 调色板法合成。
//
// 为什么"每帧独立时长"而不是固定 fps 复制帧:点击前的定格、涟漪动画、点击后的结果
// 三种节奏差异大,固定 fps 要么复制帧撑爆磁盘,要么节奏一刀切。concat list 里每帧
// 自带 duration,ffmpeg 按真实时间轴重采样。
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";

export class Recorder {
  constructor(page, framesDir) {
    this.page = page;
    this.dir = framesDir;
    this.entries = []; // { file, durationMs }
    this.n = 0;
    mkdirSync(framesDir, { recursive: true });
  }

  /** 截一帧落盘,返回文件路径(不入时长清单,供调用方自算时长)。 */
  async shoot() {
    const file = join(this.dir, `${String(this.n++).padStart(4, "0")}.png`);
    await this.page.screenshot({ path: file, type: "png" });
    return file;
  }

  /** 登记一帧的持续时长。 */
  add(file, durationMs) {
    this.entries.push({ file, duration: Math.max(20, Math.round(durationMs)) / 1000 });
  }

  /** 截一帧并直接定时长(静态画面定格用)。 */
  async frame(durationMs) {
    const file = await this.shoot();
    this.add(file, durationMs);
  }

  get totalSeconds() {
    return this.entries.reduce((s, e) => s + e.duration, 0);
  }

  /** concat list(image2 concat 的 duration 指令;末帧时长会被忽略,按惯例重复一次末帧)。 */
  writeConcatList() {
    const lines = [];
    for (const e of this.entries) {
      lines.push(`file '${e.file}'`, `duration ${e.duration.toFixed(3)}`);
    }
    lines.push(`file '${this.entries[this.entries.length - 1].file}'`);
    const listFile = join(this.dir, "concat.txt");
    writeFileSync(listFile, lines.join("\n"), "utf-8");
    return listFile;
  }

  /** 合成 GIF:重采样到固定 fps → 缩到目标宽 → palettegen/paletteuse 调色板法(画质/体积平衡)。 */
  async toGif(outPath, { width = 880, fps = 10 } = {}) {
    const listFile = this.writeConcatList();
    const vf = [
      `fps=${fps}`,
      `scale=${width}:-2:flags=lanczos`,
      "split=2[a][b]",
      "[a]palettegen=stats_mode=diff[p]",
      "[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle",
    ].join(",");
    await runFfmpeg(["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-vf", vf, "-loop", "0", outPath]);
  }
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", args, { maxBuffer: 16 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`ffmpeg 失败: ${err.message}\n${String(stderr).slice(-2000)}`));
      else resolve();
    });
  });
}
