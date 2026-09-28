// 「工具白名单能否被强制执行」这条轴的回归守卫 —— 用**三个真实内核插件**测，不用替身。
//
// 为什么需要这条测试（根因，勿删）：壳在发送前要决定「要不要把工具限制软注入进 prompt」——
// 能硬过滤就不必塞散文，不能硬过滤时散文是唯一还能传达限制的通道。这个判据曾被写成
// **两种错的形式**，都是实测踩到的：
//   ① 固定问某一个内核（`kernels.pi`）：于是 dsh/minimal 会话的答案取决于**别的内核**装没装
//      扩展——环境依赖，且违反「壳不漏内核身份」（CLAUDE.md §1.5）；
//   ② 改成问会话内核、但问的是「桌面适配扩展装没装」（`fitExtensionAvailable`）：那只是
//      **某一个内核**实现强制过滤的手段，不是「能不能强制过滤」本身。自带工具门控的内核
//      （minimal，见 docs/design/minimal-kernel.md §5.6.1/§5.7.1）因此被判为"不能过滤"，
//      每次发送都被拼上冗余散文——实测 echo 内核把散文原样回显进时间线，弄坏 DOM 对账。
// 现在的轴是 `toolFilterEnforced`：**每个内核按自己的机制回答同一个中性问题**。
//
// 本文件把三个内核各自的答案钉住，任何一侧漂移都会红。
// 位置说明：放在 `kernel/` 顶层而非 `kernel/core/`——它必须同时 import 三个内核插件，
// 而 core 不许 import 具体内核（audit 检验③）。测试文件被检验⑪ 豁免（用真实内核实现做夹具
// 是集成测试的正当形状）。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeRealCtx } from "./core/kernel-test-ctx";
import { minimalKernelPlugin } from "./minimal/plugin";
import { piKernelPlugin } from "./pi/plugin";
import { dshKernelPlugin } from "./dsh/plugin";

let homedir: string;
let cwd: string;

/** `makeRealCtx` 返回 `{ ctx, restarts, refreshes, prefsStore }`，插件工厂要的是其中的 `ctx`
 *  （真实的 `KernelPluginContext`，不是替身——prefs 落在临时目录、回调记录进数组）。 */

beforeEach(() => {
  homedir = mkdtempSync(join(tmpdir(), "tool-axis-homedir-"));
  cwd = mkdtempSync(join(tmpdir(), "tool-axis-cwd-"));
});
afterEach(() => {
  rmSync(homedir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("toolFilterEnforced：每个内核按自己的机制回答同一个中性问题", () => {
  it("minimal → true（工具系统是内核本体：适配器把 enabledToolIds 翻译成自己的工具集语义，自带档位门控）", async () => {
    // 依据 docs/design/minimal-kernel.md §5.6.1（enabledToolIds 由适配器翻译）与
    // §5.7.1（档位门控 + per-tool 超时）。它不靠任何桌面适配扩展，故答案与扩展安装状态无关。
    const api = minimalKernelPlugin(makeRealCtx(homedir, cwd).ctx).createVersionApi();
    expect(await api.toolFilterEnforced?.()).toBe(true);
  });

  it("dsh → 不声明此面（缺面 = false），壳据此显式降级而不是伪造能力", async () => {
    // dsh 的 `readToolConfig` 返回 null（`dsh-catalog.ts:62`），壳的发送路径根本进不到
    // 软注入分支；工具管理页则据缺面显示"当前内核无工具过滤能力"的诚实状态。
    const api = dshKernelPlugin(makeRealCtx(homedir, cwd).ctx).createVersionApi();
    expect(await api.toolFilterEnforced?.()).toBe(false);
  });

  it("pi → 声明此面并返回布尔（它的强制过滤机制就是桌面适配扩展里的 tool-gate，故答案随扩展安装状态变）", async () => {
    // 不断言具体真值：那取决于本机 `~/.pi/agent/extensions/` 里有没有装 fit 扩展，
    // 是环境事实而非契约。要钉住的是**pi 确实把"扩展装没装"作为它对这条轴的回答**——
    // 这正是"每个内核按自己的机制回答"的含义：同一个中性问题，pi 的答案来源是扩展探测，
    // minimal 的答案来源是"工具系统是本体"。
    const api = piKernelPlugin(makeRealCtx(homedir, cwd).ctx).createVersionApi();
    const v = await api.toolFilterEnforced?.();
    expect(typeof v).toBe("boolean");
  });

  it("三个内核都经同一个中性面名暴露（不存在按内核命名的第二套方法）", () => {
    for (const factory of [minimalKernelPlugin, piKernelPlugin, dshKernelPlugin]) {
      const api = factory(makeRealCtx(homedir, cwd).ctx).createVersionApi();
      // 圆心的可选方法：声明了就是函数，没声明就是 undefined——两种都是合法形状，
      // 但**不许**出现 `fitPiExtensionAvailable` 这类按内核命名的别名（audit 检验⑫ 亦守）。
      const keys = Object.keys(api);
      expect(keys.some((k) => /^(fit)?(Pi|Dsh|Minimal)/.test(k)), `按内核命名的方法泄漏进中性面: ${keys.join(",")}`).toBe(false);
      expect(keys).toContain("toolFilterEnforced");
    }
  });
});
