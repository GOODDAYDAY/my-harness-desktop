// theme/contrast 的守卫 —— **纯函数 unittest**(零 mock、零 IO、零定时器)。
//
// 源码注释自述根因:「消费圆心 CONTRAST_PAIRS(**此前定义后零消费**,本轮落地)」
//   —— 即**声明了却没人用** ✗:圆心定义了该核对哪些颜色对,但没人真的去核对 ✓
//   故最关键的一条守卫是:**审计必须真的逐对消费**(诊断条数 = 配对条数)✓
//
// 其余用 WCAG 的**硬锚点**钉住公式与边界(这些值是可查的客观量,不是我编的期望值):
//   · 相对亮度:纯黑 = 0、纯白 = 1
//   · 对比度:**同色 = 1**、**黑白 = 21**(WCAG 规定的最大值)
//   · 对比度**对称**:ratio(a,b) === ratio(b,a)
import { describe, it, expect } from "vitest";

import { parseColor, relativeLuminance, contrastRatio, auditThemeContrast } from "./contrast";
// ContrastPair 是**圆心**的类型,从发布面引(不是 local 类型 —— 实测 import 失败过一次)
import type { ContrastPair } from "@my-harness-desktop/shared";

const BLACK: [number, number, number] = [0, 0, 0];
const WHITE: [number, number, number] = [255, 255, 255];

describe("theme/contrast:颜色解析", () => {
  it("① 解析 #rrggbb 与 #rgb;大小写都认", () => {
    expect(parseColor("#ff8800")).toEqual([255, 136, 0]);
    expect(parseColor("#FFF")).toEqual([255, 255, 255]);
    expect(parseColor("#FF8800")).toEqual([255, 136, 0]);
  });

  it("② 解析不了 → **null**(不是抛错、更不是静默当成黑)", () => {
    // 注:`rgb()/rgba()` 是**认的**(实测) —— 我原以为只认 hex,写错过一轮 ✗
    for (const bad of ["", "red", "#12345", "#gggggg", "var(--color-fg)", "color-mix(in srgb, red, blue)", "transparent"]) {
      expect(parseColor(bad), `把 ${JSON.stringify(bad)} 解析成了颜色`).toBeNull();
    }
  });
});

describe("theme/contrast:WCAG 量(用客观锚点,不用自编期望值)", () => {
  it("③ 相对亮度:纯黑 = 0,纯白 = 1", () => {
    expect(relativeLuminance(BLACK)).toBeCloseTo(0, 5);
    expect(relativeLuminance(WHITE)).toBeCloseTo(1, 5);
  });

  it("★ ③b **三个权重各自钉住**(三原色 → 亮度 = 该通道的权重本身)", () => {
    // ⚠ 上一版我只用"黑=0/白=1"钉亮度 —— 那是**不够的** ✗:
    //   黑与白三通道相等,**保和地改权重**(如把 R 与 G 对调)它们**都不会变** ✗,
    //   而**中间调全错** ✓。三原色不一样:纯红/绿/蓝的亮度**正好等于该权重** ✓✓,
    //   于是任何一个权重被动过(哪怕总和不变),这里立刻红 ✓。
    expect(relativeLuminance([255, 0, 0]), "R 权重被改了(WCAG 应为 0.2126)").toBeCloseTo(0.2126, 4);
    expect(relativeLuminance([0, 255, 0]), "G 权重被改了(WCAG 应为 0.7152)").toBeCloseTo(0.7152, 4);
    expect(relativeLuminance([0, 0, 255]), "B 权重被改了(WCAG 应为 0.0722)").toBeCloseTo(0.0722, 4);
  });

  it("④ 对比度:**同色 = 1**;**黑白 = 21**(WCAG 最大值)", () => {
    expect(contrastRatio(WHITE, WHITE)).toBeCloseTo(1, 5);
    expect(contrastRatio(BLACK, WHITE)).toBeCloseTo(21, 3);
  });

  it("⑤ 对比度**对称**(谁在前谁在后不影响比值)", () => {
    const a: [number, number, number] = [12, 200, 77];
    const b: [number, number, number] = [240, 240, 240];
    expect(contrastRatio(a, b)).toBeCloseTo(contrastRatio(b, a), 10);
  });

  it("⑥ 对比度恒 ≥ 1(不可能出现小于 1 的比值)", () => {
    const samples: [number, number, number][] = [[0, 0, 0], [1, 2, 3], [128, 128, 128], [255, 255, 255], [200, 10, 90]];
    for (const x of samples) for (const y of samples) {
      expect(contrastRatio(x, y), `对比度 ${contrastRatio(x, y)} < 1`).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("theme/contrast:审计的**诚实态**('定义后零消费'的根因 + skipped 不计 fail)", () => {
  const themeWith = (tokens: Record<string, string>): never => ({ tokens } as never);
  const pair = (fg: string, bg: string, min = 4.5): ContrastPair => ({ fg, bg, min }) as unknown as ContrastPair;

  it("★ ⑦ **每一对都必须有归属**:failed ∪ skipped 的条数 = 配对条数(不许有对静默丢掉)", () => {
    // 这条**不依赖 pair 的字段名**(我先前按猜测的字段名写过,红过 ✗),只钉根因本身:
    // 「CONTRAST_PAIRS 声明了却零消费」的形态就是**一对也没进任何桶** ✗ ——
    // 故"每对都有归属"这条一旦回退成零消费,会立刻红 ✓。
    const pairs = [
      pair("a", "b", 4.5),           // 可解析
      pair("v", "b"),                // var() → skipped
      pair("t", "b"),                // transparent → skipped
    ];
    const audit = auditThemeContrast(themeWith({ a: "#777777", b: "#888888", v: "var(--x)", t: "transparent" }), pairs);
    expect(
      audit.failed.length + audit.skipped.length,
      "**有配对没被核对也没被跳过**(CONTRAST_PAIRS 声明了却零消费的根因)",
    ).toBe(pairs.length);
  });

  it("★ ⑦b 高对比对**不进** failed(否则审计恒红、等于没判)", () => {
    const audit = auditThemeContrast(themeWith({ a: "#000000", b: "#ffffff" }), [pair("a", "b", 4.5)]);
    expect(audit.failed, "黑白对竟判失败").toEqual([]);
  });

  it("★★ ⑧ 解析不了的值(var/color-mix/transparent)记 **skipped 不计 fail**", () => {
    // 源码注释:「它们引用其他 token,静态展开会重复实现合并逻辑,运行期由浏览器求解」
    // —— 所以必须**诚实跳过**,而不是当成"对比度不足"报错 ✗
    const pairs = [pair("v", "b"), pair("m", "b"), pair("t", "b")];
    const audit = auditThemeContrast(
      themeWith({ v: "var(--color-fg)", m: "color-mix(in srgb, red, blue)", t: "transparent", b: "#ffffff" }),
      pairs,
    );
    expect(audit.skipped.length, "无法静态解析的对没有被记为 skipped").toBe(3);
    expect(audit.failed, "**把 var()/color-mix()/transparent 当成对比度不足报了出来** —— 误报").toEqual([]);
  });
});
