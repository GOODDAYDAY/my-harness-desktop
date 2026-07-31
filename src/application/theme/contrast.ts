// 主题对比度审计 —— WCAG AA 对比度校验(06 §3.2 末 + §870)。
//
// 消费圆心 CONTRAST_PAIRS(此前定义后零消费,本轮落地):
// build 时对合并后的 Theme 跑一遍审计,诊断不阻断、由调用处上报
// (main 侧 console.warn,主题开发者可见;终端用户不受损)。
//
// 纯函数,不碰 IO:颜色解析只认 #rgb/#rrggbb 与 rgb()/rgba(),
// 解析不了的值(var()/color-mix()/transparent)记 skipped 不计 fail——
// 它们引用其他 token,静态展开会重复实现合并逻辑,运行期由浏览器求解。
import { CONTRAST_PAIRS, type ContrastPair, type Theme } from "../../domain/slots/theme-tokens";

export interface ContrastDiagnostic {
  fg: string;
  bg: string;
  ratio: number;
  required: number;
}

export interface ContrastAudit {
  failed: ContrastDiagnostic[];
  /** 颜色值无法静态解析(var/color-mix/transparent),未参与校验的 token 对。 */
  skipped: ContrastPair[];
}

/** sRGB 通道 → 线性光亮度(WCAG 2.x 相对亮度公式)。 */
function linearize(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** 解析颜色值为 [r,g,b];不支持的颜色函数返回 null(调用方记 skipped)。 */
export function parseColor(value: string): [number, number, number] | null {
  const v = value.trim();
  const hex = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1];
    if (h.length === 3) return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  const rgb = v.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  return null;
}

/** WCAG 相对亮度(0=纯黑,1=纯白)。 */
export function relativeLuminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

/** WCAG 对比度比值(1..21)。 */
export function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** 审计合并后的 Theme:对 CONTRAST_PAIRS 逐对算比值,低于 WCAG AA 阈值记 fail。 */
export function auditThemeContrast(theme: Theme, pairs: readonly ContrastPair[] = CONTRAST_PAIRS): ContrastAudit {
  const failed: ContrastDiagnostic[] = [];
  const skipped: ContrastPair[] = [];
  for (const pair of pairs) {
    const fg = parseColor(theme[pair.fg] ?? "");
    const bg = parseColor(theme[pair.bg] ?? "");
    if (!fg || !bg) {
      skipped.push(pair);
      continue;
    }
    const required = pair.largeText ? 3 : 4.5;
    const ratio = contrastRatio(fg, bg);
    if (ratio < required) failed.push({ fg: pair.fg, bg: pair.bg, ratio, required });
  }
  return { failed, skipped };
}
