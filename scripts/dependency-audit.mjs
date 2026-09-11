#!/usr/bin/env node
// 依赖方向审计(CLAUDE.md §6.3 四检验的自动化 + KernelId 单源 + 内核身份分支)——CI-able 守卫。
// 用法:node scripts/dependency-audit.mjs(违规 exit 1,全绿 exit 0)。
// 八检验:
//   ① 圆心零外部 import(packages/shared/src/domain 不碰任何外部包/壳内部)
//   ② application 不 import 内核实现(非 type-only)·不 import electron/react
//      ——neutral-migration.ts 是 session-single-source.md §4.3 明文例外(离线迁移工具)
//   ③ kernel/core 骨架不 import 具体内核(pi/dsh)·不 import react
//   ④ plugins 只 import @my-harness-desktop/shared + @my-harness-desktop/react
//   ⑤ "pi" | "dsh" 字面量联合收敛到 domain/kernel.ts 单源
//   ⑥ 会话意图链路(application)零 kernel === "pi"/"dsh" 身份硬分支
//   (能力接口探测替代身份分支——§1.5 判别气味;测试文件豁免,注释行豁免)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let violations = [];
const walk = (dir, out = []) => {
  for (const f of readdirSync(dir)) {
    if (f === "node_modules" || f === "out" || f === ".git" || f === "dist") continue;
    const p = join(dir, f);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(f)) out.push(p);
  }
  return out;
};
/** 收集 import/export-from 行(含多行 import 块)。 */
const importsOf = (file) => {
  const src = readFileSync(file, "utf-8");
  const lines = src.split("\n");
  const imports = [];
  let inBlock = false;
  for (const l of lines) {
    if (/^\s*import\s/.test(l) || inBlock) {
      imports.push(l);
      if (inBlock && /from\s+["']/.test(l)) inBlock = false;
      if (/^\s*import\s*\{[^}]*$/.test(l)) inBlock = true;
    }
    if (/^\s*export\s.*from\s+["']/.test(l)) imports.push(l);
  }
  return imports.join("\n");
};

// ① 圆心零外部 import
for (const f of walk(join(ROOT, "packages/shared/src/domain"))) {
  const imps = importsOf(f);
  for (const bad of ["electron", "better-sqlite3", "react", "@my-harness-desktop/react", "@/server", "src/server"]) {
    if (imps.includes(`"${bad}"`) || imps.includes(`'${bad}'`)) {
      violations.push(`① 圆心外部依赖 ${f.replace(ROOT, "")}: ${bad}`);
    }
  }
}

// ② application 红线(§4.3 明文例外豁免)
const DOCUMENTED_EXCEPTIONS = ["neutral-migration.ts"]; // session-single-source.md §4.3:离线迁移工具,非会话流
for (const f of walk(join(ROOT, "src/server/application"))) {
  if (/\.test\./.test(f)) continue;
  if (DOCUMENTED_EXCEPTIONS.some((x) => f.endsWith(x))) continue;
  const src = readFileSync(f, "utf-8");
  for (const l of src.split("\n").filter((x) => /import\s/.test(x))) {
    if (/^\s*import\s+type\s/.test(l)) continue; // type-only 豁免
    if (/from\s+["'].*kernel\/(pi|dsh)\//.test(l)) {
      violations.push(`② application→内核实现 ${f.replace(ROOT, "")}: ${l.trim().slice(0, 90)}`);
    }
    if (/from\s+["'](electron|react)["']/.test(l)) {
      violations.push(`② application→electron/react ${f.replace(ROOT, "")}: ${l.trim().slice(0, 90)}`);
    }
  }
}

// ③ kernel/core 骨架
for (const f of walk(join(ROOT, "src/server/kernel/core"))) {
  const imps = importsOf(f);
  if (/kernel\/(pi|dsh)\//.test(imps)) violations.push(`③ core→具体内核 ${f.replace(ROOT, "")}`);
  if (/from\s+["']react["']/.test(imps)) violations.push(`③ core→react ${f.replace(ROOT, "")}`);
}

// ④ plugins 只认 shared + react
for (const f of walk(join(ROOT, "src/plugins"))) {
  const imps = importsOf(f);
  if (/@\/(server|core|client)\//.test(imps)) violations.push(`④ plugins→壳内部 ${f.replace(ROOT, "")}`);
}

// ⑤ KernelId 字面量单源(全仓 "pi" | "dsh" 联合只许 domain/kernel.ts)
try {
  const out = execSync(
    `grep -rn '"pi"\\s*|\\s*"dsh"\\|"dsh"\\s*|\\s*"pi"' --include='*.ts' --include='*.tsx' packages/shared/src src/server src/web src/plugins packages/react/src 2>/dev/null || true`,
    { encoding: "utf-8", cwd: ROOT },
  );
  for (const l of out.split("\n").filter(Boolean)) {
    if (l.includes("domain/kernel.ts")) continue;
    if (/\.test\./.test(l)) continue;
    violations.push(`⑤ KernelId 副本: ${l.slice(0, 110)}`);
  }
} catch { /* grep 无匹配 */ }

// ⑥ 会话意图链路零内核身份硬分支(能力接口探测替代;注释/测试豁免)
for (const f of walk(join(ROOT, "src/server/application"))) {
  if (/\.test\./.test(f) || !/session-store|models/.test(f)) continue;
  readFileSync(f, "utf-8").split("\n").forEach((l, i) => {
    const t = l.trim();
    if (t.startsWith("*") || t.startsWith("//")) return;
    if (/kernel\s*===\s*["']pi["']|kernel\s*===\s*["']dsh["']/.test(l) && !/capabilities/.test(l)) {
      violations.push(`⑥ 内核身份分支 ${f.replace(ROOT, "")}:${i + 1}: ${t.slice(0, 80)}`);
    }
  });
}

// ⑦ 能力名中性化(§1.5):源码里不许再出现**按内核分字段**的能力面(`capabilities.pi` / `.dsh` / …)。
//    这条为什么比"更新 audit:docs 的手写退役表"更可靠:手写清单会随新人遗忘而失效(守卫慢慢瞎掉),
//    而**模式**本身可以一直守——谁再把内核名写进能力字段,这条当场红。注释行豁免(历史说明里会提旧写法),
//    测试文件豁免(测试用中性 id 是 skills 明文纪律)。
{
  const out = execSync(
    `grep -rnE 'capabilities\\.(pi|dsh|minimal)\\b' --include='*.ts' --include='*.tsx' packages/shared/src src/server src/web src/plugins packages/react/src 2>/dev/null || true`,
    { encoding: "utf-8", cwd: ROOT },
  );
  for (const l of out.split("\n").filter(Boolean)) {
    const parts = l.split(":");
    const file = parts[0];
    const text = parts.slice(2).join(":").trim();
    if (/^(\/\/|\*|\/\*)/.test(text)) continue;   // 注释行:历史说明里会提到旧写法
    if (/\.test\./.test(file)) continue;             // 测试:用中性 id 是既定纪律
    violations.push(`⑦ 按内核分字段的能力面 ${file.replace(ROOT, "")}: ${text.slice(0, 80)}`);
  }
}

// ⑧ 内核之间零 import(§目标 13 可卸载性的物理前提)。
//    为什么必须是一条**结构**检验而不是"注意一下":内核插件是可以被整体删掉的(卸载验收),
//    只要 A 内核 import 了 B 内核的一个文件,删掉 B 就让 A 编译不过——"能卸载"当场变成假的。
//    实测就发生过:SubprocessHandle(三个内核共用的子进程句柄契约)曾放在 pi/backend/ 下,
//    dsh/minimal 都写 `../../pi/backend/subprocess-handle` —— 删 pi 即 dsh/minimal 崩。
//    现已收进 kernel/core/(机制层),本检验守住不让它复发:任一内核的依赖只许指向
//    `kernel/core/`(机制)或自己的目录,不许指向另一个内核。
{
  const KERNEL_DIRS = ["pi", "dsh", "minimal"];
  for (const k of KERNEL_DIRS) {
    const base = join(ROOT, "src/server/kernel", k);
    let files = [];
    try { files = walk(base); } catch { continue; } // 内核被卸载(目录已删)→ 无事可查
    for (const f of files) {
      for (const spec of importsOf(f).matchAll(/from\s+["']([^"']+)["']/g)) {
        const s = spec[1];
        if (!s.startsWith(".")) {
          // 非相对:任何 `kernel/<other>/` 或 `@/server/kernel/<other>/` 都是跨内核
          const m = s.match(/kernel\/([^/]+)\//);
          if (m && KERNEL_DIRS.includes(m[1]) && m[1] !== k) {
            violations.push(`⑧ 内核互引 ${f.replace(ROOT, "")}: ${s}(内核 ${k} → 内核 ${m[1]})`);
          }
          continue;
        }
        const abs = resolve(dirname(f), s);
        const m = abs.match(/src\/server\/kernel\/([^/]+)\//);
        // 相对路径也必须落在自己目录或 core 里;落进另一个内核目录即违规。
        if (m && KERNEL_DIRS.includes(m[1]) && m[1] !== k) {
          violations.push(`⑧ 内核互引 ${f.replace(ROOT, "")}: ${s} → kernel/${m[1]}/`);
        }
      }
    }
  }
}

// 这个数是**四个被 walk 的骨架目录的文件数之和**(含 plugin.json/locales 等非 ts 文件),
// **不是整条审计的覆盖面**——⑤⑥⑦ 三条是 grep,另外覆盖 `src/web` / `packages/react/src`。
// 原来只写"七检验,N 文件"会被读成"整条审计只看了 N 个文件",是**标签误导**(实测 289 里
// 四个目录各为 98+191;而 src/web 那 23 个 ts 压根不在这个数里)。标签要说清它数的是什么。
const walked = [
  "packages/shared/src/domain",
  "src/server/application",
  "src/server/kernel/core",
  "src/plugins",
];
const scope = walked.reduce((n, d) => n + walk(join(ROOT, d)).length, 0);
console.log(`依赖方向审计(八检验): ${violations.length} 处违规`);
console.log(`  覆盖:walk ${walked.length} 个骨架目录共 ${scope} 文件(${walked.join(" · ")});` +
  `另有 ⑤⑥⑦ 三条 grep 覆盖 src/web、packages/react/src 等(核 KernelId 字面量/内核身份分支/能力名中性化)`);
for (const v of violations) console.log("  " + v);
process.exit(violations.length > 0 ? 1 : 0);
