// PNG 解码 + "有没有内容"统计(零依赖,只借 node:zlib)。
//
// 为什么需要它:静默态窗口是**隐藏**的,唯一能证明"隐藏窗口照样渲染"的物证是截图。
// 但"截图非黑屏"不能靠"文件挺大"这种手感——本仓有过"截了图没人看"的先例,
// 所以这里真解像素:统计采样到的**不同颜色数**与**与背景色不同的像素占比**。
//   实测标尺(生成合成图校准,2560×1680):
//     · 纯 #0b0b0c 空帧 → 约 16KB,颜色数 1
//     · 空帧 + 一小块白框 → 约 18KB,非背景像素占比 ~1.4%
//     · 真实 UI 帧 → 颜色数 数百至数千,非背景像素占比 >20%
// 所以判据取 colors >= 24 且 nonBgRatio > 0.02:空帧必挂,真 UI 有量级余量。
import { inflateSync } from "node:zlib";

const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

/** 解 PNG,返回 { width, height, bytes, colors, nonBgRatio, bg }。支持 8bit 灰度/RGB/RGBA。 */
export function pngStats(buf) {
  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let colorType = 6;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    off += 12 + len;
  }
  const channels = CHANNELS[colorType];
  if (bitDepth !== 8) throw new Error(`pngStats: 只支持 8bit(收到 ${bitDepth})`);
  if (!channels) throw new Error(`pngStats: 不支持的颜色类型 ${colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const px = Buffer.alloc(height * stride); // 反滤波后的像素
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const out = px.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? out[i - channels] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= channels ? prev[i - channels] : 0;
      const v = line[i];
      let r;
      switch (filter) {
        case 0: r = v; break;
        case 1: r = (v + a) & 0xff; break;
        case 2: r = (v + b) & 0xff; break;
        case 3: r = (v + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          r = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
          break;
        }
        default: throw new Error(`pngStats: 未知滤波器 ${filter}`);
      }
      out[i] = r;
    }
  }

  const bg = [px[0], px[1] ?? px[0], px[2] ?? px[0]];
  const colors = new Set();
  let nonBg = 0;
  let sampled = 0;
  const colStep = Math.max(1, Math.floor(width / 400)) * channels; // 抽样,别为 4M 像素空转
  const rowStep = Math.max(1, Math.floor(height / 400));
  for (let y = 0; y < height; y += rowStep) {
    for (let i = 0; i < stride; i += colStep) {
      const o = y * stride + i;
      const r = px[o];
      const g = px[o + 1] ?? r;
      const b = px[o + 2] ?? r;
      colors.add((r << 16) | (g << 8) | b);
      sampled += 1;
      if (Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2]) > 24) nonBg += 1;
    }
  }
  return { width, height, bytes: buf.length, colors: colors.size, nonBgRatio: nonBg / sampled, bg };
}
