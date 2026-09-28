// 插件操作的**抛错形态**必须被处理（r80）。
//
// ## 被守的缺陷：安装失败后 UI 卡死且无任何提示
//
// 服务端 → renderer 的失败有**两种形态**，而它们的传输路径不同：
//
// | 形态 | 服务端 | gateway | transport | renderer 侧表现 |
// |---|---|---|---|---|
// | ① 返回值 | `return { ok:false, error:"plugin.error.notLoaded" }` | 原样回传 | resolve | `await` 得到对象 |
// | ② **抛错** | `throw new Error("ZIP 格式暂不支持…")` | 转成 `{ok:false, error:{code:"HANDLER_ERROR", message}}`（`routing/gateway.ts:61-66`） | **reject**（`ws-transport.ts:102`） | `await` **throw** |
//
// plugin-manager 的 5 个 handler 此前都写成 `showFeedback(await ctx.plugins.X(…))` 且**没有 try/catch**，
// 于是形态②的后果是：
//   · `showFeedback` 根本走不到 ⇒ **一点错误提示都没有**（§7.6 禁止的静默失败）；
//   · install 那条还会让后续的 `setInstalling(false)` / `setInstallOpen(false)` / `setInstallUrl("")`
//     全部走不到 ⇒ **按钮永久停在 installing 态、对话框不关、输入不清**，用户只能刷新页面。
// 而 `ctx.plugins.install` 的返回类型标称 `Promise<{ ok, error }>`——对抛错路径这个类型是**假的**
// （类型说"总会拿到对象"，运行时却可能 reject）。
//
// 触发形态②的现实场景很多：安装源是 `.zip`（installer 明确 throw）、npm 安装失败、
// URL 不可达、路径越界（controllers 里的安全 throw）——都不是罕见路径。
//
// ## 修法（根因，不是给 install 单加一个 catch）
//
// 抽 `runOp(op)` 把两种形态**收敛到一处**：成功走 `showFeedback(r)`；
// 抛错则把 `err.message` 交给同一个 `showFeedback`（它内部先按 i18n 键翻译，不是键就原样显示），
// 并返回 `boolean` 供调用方决定后续动作。5 个 handler 全部改走它（§3.3：同一逻辑多处复制该收进一处）。
// install 另用 `try/finally` 保证**无论成败都解除 installing 态**，且只在成功时关对话框/清输入
// （失败时保留，方便改完 URL 直接重试）。
//
// ## 为什么是静态守卫而不是 DOM 测试
//
// 如实说明：本轮**没有**补 DOM 级测试（该 renderer 此前无测试文件，mock 面较大：
// usePluginContext / useSessionStore.capabilities / react-i18next / 安装对话框状态）。
// 先用静态守卫钉住缺陷形态（成本极低、精确），DOM 级测试记入待办。
// 静态守卫能守住的正是"这个缺陷的语法形态不得再现"，而它当年的成因也正是语法形态
// （少了一层 try/catch），所以这一层守卫是对症的。

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const TARGET = "src/plugins/manager/plugin-manager/renderer/index.tsx";

describe("plugin-manager：插件操作的抛错形态必须被处理（否则失败无提示 + install 卡死）", () => {
  const src = existsSync(join(ROOT, TARGET)) ? readFileSync(join(ROOT, TARGET), "utf-8") : "";
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n")
    .filter((l) => !l.trim().startsWith("//")).join("\n");

  it("判据不空转：目标文件在，且确实在调用 ctx.plugins.* 操作", () => {
    expect(src.length, `${TARGET} 读不到（路径变了？改这份守卫）`).toBeGreaterThan(1000);
    const ops = code.match(/ctx\.plugins\.(enable|disable|uninstall|reload|install|list)\s*\(/g) ?? [];
    expect(ops.length, "一处 ctx.plugins.* 调用都没扫到 ⇒ 判据空转").toBeGreaterThanOrEqual(5);
  });

  it("① 不得再出现「裸 await 插件操作直接喂 showFeedback」的形态（抛错时提示与状态更新全都走不到）", () => {
    const bare = [...code.matchAll(/showFeedback\(\s*await\s+ctx\.plugins\./g)].length;
    expect(bare, [
      `发现 ${bare} 处裸形态 showFeedback(await ctx.plugins.…)。`,
      "      后果：服务端 handler **抛错**时（gateway→transport 会 reject），showFeedback 走不到 ⇒ 无任何提示；",
      "            install 那条还会让 setInstalling(false) 走不到 ⇒ 按钮永久卡在 installing 态。",
      "      修法：改走 runOp(() => ctx.plugins.X(…))——它把「返回 {ok:false}」与「抛错」两种形态收敛到一处。",
    ].join("\n")).toBe(0);
  });

  it("② 必须存在 runOp 这样的收敛点，且它内部对 await 结果做了 try/catch", () => {
    expect(/const runOp\s*=/.test(code), "找不到 runOp（收敛点被删了 ⇒ 两个失败形态又要各处理一遍）").toBe(true);
    const body = code.slice(code.indexOf("const runOp"));
    const fn = body.slice(0, body.indexOf("};") + 2);
    expect(fn.includes("try {"), "runOp 里没有 try ⇒ 抛错形态没被处理").toBe(true);
    expect(/catch\s*\([\w]+\)\s*\{[\s\S]{0,300}showFeedback/.test(fn), "runOp 的 catch 里没有把错误交给 showFeedback ⇒ 用户仍然看不到失败原因").toBe(true);
  });

  it("③ install 必须用 try/finally 保证解除 installing 态（卡死的那个根因）", () => {
    const i = code.indexOf("setInstalling(true)");
    expect(i, "找不到 setInstalling(true)（安装流程改了？更新这条守卫）").toBeGreaterThan(-1);
    const region = code.slice(i, i + 900);
    expect(region.includes("finally"), "install 流程里没有 finally ⇒ 抛错时 setInstalling(false) 走不到，按钮会永久卡住").toBe(true);
    expect(/finally\s*\{[\s\S]{0,120}setInstalling\(false\)/.test(region), "finally 里没有 setInstalling(false) ⇒ 卡死根因未修").toBe(true);
  });

  it("④ 五个操作都要走收敛点（只修 install 是不够的：enable/disable/uninstall/reload 同样会抛）", () => {
    for (const op of ["enable", "disable", "uninstall", "reload", "install"]) {
      expect(new RegExp(`runOp\\(\\s*\\(\\)\\s*=>\\s*ctx\\.plugins\\.${op}\\(`).test(code),
        `ctx.plugins.${op} 没有走 runOp ⇒ 它抛错时同样静默失败`).toBe(true);
    }
  });
});
