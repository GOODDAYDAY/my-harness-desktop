#!/usr/bin/env node
// 依赖方向审计(CLAUDE.md §6.3 四检验的自动化 + KernelId 单源 + 内核身份分支)——CI-able 守卫。
// 用法:node scripts/dependency-audit.mjs(违规 exit 1,全绿 exit 0)。
// 六检验:
//   ① 圆心零外部 import(packages/shared/src/domain 不碰任何外部包/壳内部)
//   ② application 不 import 内核实现(非 type-only)·不 import electron/react
//      ——neutral-migration.ts 是 session-single-source.md §4.3 明文例外(离线迁移工具)
//   ③ kernel/core 骨架不 import 具体内核(pi/dsh)·不 import react
//   ④ plugins 只 import @my-harness-desktop/shared + @my-harness-desktop/react
//   ⑤ "pi" | "dsh" 字面量联合收敛到 domain/kernel.ts 单源
//   ⑥ 会话意图链路(application)零 kernel === "pi"/"dsh" 身份硬分支
//   (能力接口探测替代身份分支——§1.5 判别气味;测试文件豁免,注释行豁免)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
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

const scope = walk(join(ROOT, "packages/shared/src/domain")).length
  + walk(join(ROOT, "src/server/application")).length
  + walk(join(ROOT, "src/server/kernel/core")).length
  + walk(join(ROOT, "src/plugins")).length;
console.log(`依赖方向审计(六检验,${scope} 文件): ${violations.length} 处违规`);
for (const v of violations) console.log("  " + v);
process.exit(violations.length > 0 ? 1 : 0);
