#!/usr/bin/env node
// 测试静默守卫 —— 拉起 app 的脚本不得抢用户焦点(CLAUDE.md §5.6 测试静默纪律,CI-able)。
//
// 为什么需要这条守卫(根因):
//   应用原本开窗后无条件 `win.show()`。macOS 上 show() 会激活应用 → 用户正在打字的窗口失焦、
//   鼠标被夺走,界面上凭空多出一个窗口。每个 e2e 入口各写一行 env 是"自觉",漏一个就复发。
//   这条守卫把"凡 spawn electron 的脚本必须过 quiet-env"变成结构检验,新增 e2e 忘写会被拦下。
//
// 三检验:
//   ① `scripts/**` 里任何 spawn electron 的脚本必须 import `quiet-env.mjs`
//      (默认 MHD_WINDOW=hidden);确有理由要看窗口的,写豁免标记 `quiet-launch-ok: <理由>`。
//   ② `src/server/bootstrap/electron.ts` 必须经 windowVisibilityPolicy 分岔,
//      且不得存在无条件 `win.on("ready-to-show", () => win.show())`(回潮即违规)。
//   ③ 策略函数的非法值必须抛错(MHD_WINDOW 写错一个字母若静默按 shown 走 = 用户窗口再被顶一次)。
//
// 用法:node scripts/quiet-launch-audit.mjs(退出码 0 = 无违规)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = join(ROOT, "scripts");
const ENTRY = join(ROOT, "src/server/bootstrap/electron.ts");
const POLICY = join(ROOT, "src/server/bootstrap/window-visibility.ts");
const EXEMPT = "quiet-launch-ok:";

const violations = [];

/** 去掉注释行——`scripts/run.cjs` 的注释里提到 require("electron")(它自己并不 spawn electron),
 *  不去注释会假阳性。只处理整行注释,行尾注释里的提及由豁免标记兜底。 */
const stripComments = (src) =>
  src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name.startsWith(".")) continue;
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

// ---------- ① 脚本侧:spawn electron 必须过 quiet-env ----------
let scanned = 0;
let launchers = 0;
for (const file of walk(SCRIPTS)) {
  if (!/\.(mjs|cjs)$/.test(file)) continue;
  scanned += 1;
  const src = readFileSync(file, "utf-8");
  const code = stripComments(src);
  if (!/require\(["']electron["']\)|electronPath/.test(code)) continue;
  launchers += 1;
  if (/quiet-env\.mjs/.test(code)) continue;
  if (src.includes(EXEMPT)) continue;
  violations.push(
    `① 拉起 electron 但没过 quiet-env ${relative(ROOT, file)}` +
    `(应 import { quietEnv } from "./demo/lib/quiet-env.mjs" 并把它喂给 spawn 的 env)`,
  );
}

// ---------- ② 应用侧:开窗必须经可见性策略分岔 ----------
{
  const src = readFileSync(ENTRY, "utf-8");
  if (!/windowVisibilityPolicy/.test(src)) {
    violations.push("② src/server/bootstrap/electron.ts 未使用 windowVisibilityPolicy(窗口可见性失去分岔)");
  }
  // 无条件 show 的形态:`ready-to-show` + `win.show()` 同现,却不带 `visibility.show` 前置条件。
  const unconditional = src
    .split("\n")
    .map(stripComments)
    .find((l) => /ready-to-show/.test(l) && /win\.show\(\)/.test(l) && !/visibility\.show/.test(l));
  if (unconditional) {
    violations.push(`② electron.ts 存在无条件 win.show():${unconditional.trim().slice(0, 90)}`);
  }
}

// ---------- ③ 策略侧:非法值必须响亮抛错 ----------
{
  const src = readFileSync(POLICY, "utf-8");
  if (!/throw new Error/.test(src) || !/MHD_WINDOW/.test(src)) {
    violations.push("③ window-visibility.ts 对非法 MHD_WINDOW 不再抛错(会静默按 shown 弹窗)");
  }
}

console.log(`测试静默守卫(三检验): ${violations.length} 处违规`);
console.log(`  覆盖:scripts/ 下 ${scanned} 个 js 脚本(其中 ${launchers} 个拉起 electron)` +
  ` + src/server/bootstrap/electron.ts + window-visibility.ts`);
for (const v of violations) console.log("  " + v);
process.exit(violations.length > 0 ? 1 : 0);
