#!/usr/bin/env node
// 文档符号审计 —— 文档里**实指**的实现符号,是否还在代码里?
// 用法:node scripts/doc-symbol-audit.mjs
//
// 定位:**报告,不是阻断门**(exit 恒 0)。理由同 audit:refs:判据能圈候选,但"这是举例还是实指"
// 是**语义判断**——`customAction`(文档里写"比如 `customAction`")与 `translateMinimalEvent`
// (文档写"适配器里有一个纯函数 `translateMinimalEvent`")在机器眼里长得一样,前者不是缺陷。
// 所以这里只报候选,由人逐条判。
//
// 方法(实测误报率低:minimal-kernel.md 抽出 115 个符号,只 2 个找不到):
//   抽反引号里的标识符 → 只留"像实现符号"的(含小写接大写驼峰,或带点的方法形态)
//   → 用**最后一段**当 token 全仓 grep → 找不到的进报告。
// 为什么用最后一段:`foo.bar.baz()` 的真实符号是 `baz`,查全串必然假红。
//
// **候选的四类,只有第 4 类是真漂移**(实测 301 个候选里,DSH 上游符号就占 43):
//   ① 上游内核符号(DSH/pi 的,如 `goal-round-driver`)——移植/蓝本类设计文档引用它们,正常
//   ② 举例名(文档写"比如 `customAction`")——举例不是断言,正常
//   ③ 规划名(设计文档描述尚未实现的东西)——文档本就该先于实现,正常
//   ④ **已退役符号**(曾存在、现已删/改名,如 `DshCapabilities`)——**这才是漂移**
// 第 4 类怎么认:它在代码里 0 命中,且**同一族的中性替代名存在**(如 `ThinkingCapabilities`)。
// 本工具只把四类一起报出来(语义判断机器给不了);但它作为**发现机制**已经兑现过价值:
// `DshCapabilities` / `PiBackendExtensions` 正是它发现、再补进 `audit:docs` 退役表、进而照出
// 12 处隐形未标注的。**发现机制 + 强制机制要成对,单独一个都会失效。**
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith(".md")) out.push(p);
  }
  return out;
}

const files = walk(join(ROOT, "docs")).filter((f) => !f.includes("/legacy/"));
const seen = new Map(); // symbol → [file:line]
for (const file of files) {
  const text = readFileSync(file, "utf-8");
  for (const m of text.matchAll(/`([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)`/g)) {
    const sym = m[1];
    // 只留"像实现符号"的:驼峰(小写接大写)或带点的方法形态
    if (!(/[a-z][A-Z]/.test(sym) || sym.includes("."))) continue;
    const token = sym.split(".").pop();
    if (token.length < 4) continue;
    const line = text.slice(0, m.index).split("\n").length;
    if (!seen.has(sym)) seen.set(sym, []);
    seen.get(sym).push(`${file.replace(ROOT + "/", "")}:${line}`);
  }
}

// 先把代码里的标识符**一遍扫成集合**(逐符号起 grep 子进程会慢到超时——几千个符号 × 全仓 grep)。
const index = new Set();
for (const dir of ["src", "packages", "scripts"]) {
  const out = execSync(`grep -rhoE '[A-Za-z_$][A-Za-z0-9_$]*' ${dir} --include='*.ts' --include='*.tsx' --include='*.mjs' --include='*.js' 2>/dev/null || true`,
    { cwd: ROOT, encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 });
  for (const t of out.split("\n")) if (t) index.add(t);
}

const missing = [];
for (const [sym, locs] of seen) {
  const token = sym.split(".").pop();
  if (!index.has(token)) missing.push([sym, locs]);
}

// 分层:① **优先** = 0 命中且符号名里带内核 token(Pi/Dsh/Minimal…)。中性化退役的正是这一类
//   (`PiBackendExtensions` → `BackendExtensions`、`DshCapabilities` → `ThinkingCapabilities`),
//   所以它们最可能是"文档还在当现状讲"的真漂移。② 其余 = 上游符号/举例名/规划名,噪声为主。
//   分层不是过滤:两类都报,只是让读者先看该看的(301 里 90% 是噪声,不分层等于没报)。
const KERNEL_TOKEN = /(^|[a-z0-9])(Pi|Dsh|Minimal)(?=[A-Z])/;
const priority = missing.filter(([sym]) => KERNEL_TOKEN.test(sym));
const rest = missing.filter(([sym]) => !KERNEL_TOKEN.test(sym));

console.log(`文档符号报告(${files.length} 份文档,抽出实现符号 ${seen.size} 个): ${missing.length} 个在代码里找不到`);
console.log(`\n① 优先看(${priority.length} 个,名字带内核 token —— 最可能是退役名当现状讲):`);
for (const [sym, locs] of priority) {
  console.log(`  ! \`${sym}\` ← ${locs.slice(0, 3).join(", ")}${locs.length > 3 ? ` (+${locs.length - 3})` : ""}`);
}
console.log(`\n② 其余(${rest.length} 个,以上游符号/举例名/规划名为主,抽样看即可):`);
for (const [sym, locs] of rest.slice(0, 10)) {
  console.log(`  ? \`${sym}\` ← ${locs.slice(0, 2).join(", ")}${locs.length > 2 ? ` (+${locs.length - 2})` : ""}`);
}
if (rest.length > 10) console.log(`  … 另有 ${rest.length - 10} 个`);
process.exit(0); // 报告:不阻断(理由见文件头注释)
