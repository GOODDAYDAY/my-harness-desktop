#!/usr/bin/env node
// 依赖方向审计(CLAUDE.md §6.3 四检验的自动化 + KernelId 单源 + 内核身份分支)——CI-able 守卫。
// 用法:node scripts/dependency-audit.mjs(违规 exit 1,全绿 exit 0)。
// 十三检验:
//   ① 圆心零外部 import(packages/shared/src/domain 不碰任何外部包/壳内部)
//   ② application 不 import 内核实现(非 type-only)·不 import electron/react
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
// **例外清单已清空**（勿再往里加东西）：此前唯一一条是 neutral-migration.ts（pi 旧会话导入，
// 它 import 了 pi-catalog）。那条依赖已经归位——读 pi 老格式是 pi 的私有知识，搬进 pi 插件
// （kernel/pi/backend/pi-legacy-sessions.ts），壳侧只剩"把中立会话写进中立层"的机制
// （application/sessions/legacy-import.ts，零内核依赖）。红线回归无条件。
const DOCUMENTED_EXCEPTIONS = [];
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

// ④ plugins 只认 shared + react（两个插件根：随壳分发的 + 测试专用的）
for (const root of ["src/plugins", "test-plugins"]) {
  for (const f of walk(join(ROOT, root))) {
    const imps = importsOf(f);
    if (/@\/(server|core|client)\//.test(imps)) violations.push(`④ plugins→壳内部 ${f.replace(ROOT, "")}`);
  }
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

  // ⑦b **同一立法的两类漏网形态**（实测：本轮之前它们从守卫旁边溜过去很久）：
  //   · PascalCase 类型名 `PiExtensions` —— 原模式 `\b(pi|dsh|minimal)Extension` 是小写起首，
  //     抓不到 `PiExtensions`（大写 P）；
  //   · **裸内核名字段** `pi: PiExtensions` —— 原模式要求 `capabilities.` 前缀，而契约里
  //     字段直接叫 `pi`（`domain/context.ts:308`、`domain/sessions.ts:456`、发布面 `react/src/index.ts:151`）。
  //     检验⑨的立法意图正是「内核名不许当契约字段名」，但它的模式也是 `<内核名>Extension` 前缀，
  //     同样抓不到裸 `pi:`。
  // 两者都是「发布面上挂着内核名」，与⑦同一立法，故并在⑦下。
  {
    // 已知待清债务：**发布面的 `ctx.pi` / `PiExtensions` 命名迁移**。这是一个概念、10 处命中，
    // 改名要连动 圆心契约(context.ts/sessions.ts) → SessionStore 的 `get pi()` →
    // IPC/renderer API(`window.kernel.sessions.pi`) → 发布面(`packages/react`) → 插件调用点，
    // → IPC/renderer API(`window.kernel.sessions.pi`, build-kernel.ts) → 发布面(`packages/react`)
    // → 插件调用点，属独立一批（与本轮「主侧能力面分轴」分开验证，§5.5 逐阶段）。
    // 名单按**文件**记账（行号会漂），且长度会被打印——防止悄悄变长。
    // **名单现为空**（债务已还清，勿回填）：`PiExtensions` 袋子已按语义域拆散归位到
    // `MessagingApi`/`ModelApi`/`SessionsApi`，`PluginContext.pi` 与 `SessionsApi.pi` 两条
    // 访问路径已删，原始 IPC 面（build-kernel.ts / react/index.ts）的 `pi:` 分组已平铺。
    // 名单留空是这条守卫有意义的前提——非空即意味着「已知违规但不修」，会慢慢变成永久豁免。
    const KNOWN_NAMED_DEBT = [];
    const out = execSync(
      `grep -rnE '\\b(Pi|Dsh|Minimal)Extensions?\\b|^[[:space:]]+(pi|dsh|minimal):' --include='*.ts' --include='*.tsx' packages/shared/src src/server src/web src/plugins packages/react/src 2>/dev/null || true`,
      { cwd: ROOT, encoding: "utf-8" },
    );
    let debt = 0;
    for (const l of out.split("\n").filter(Boolean)) {
      const parts = l.split(":");
      const file = parts[0];
      const text = parts.slice(2).join(":").trim();
      if (/^(\/\/|\*|\/\*)/.test(text)) continue;
      if (/\.test\./.test(file)) continue;
      if (KNOWN_NAMED_DEBT.includes(file)) { debt += 1; continue; }
      violations.push(`⑦b 发布面/契约上的内核名 ${file.replace(ROOT, "")}: ${text.slice(0, 80)}`);
    }
    if (debt > 0) {
      console.log(`  ⑦b 已知待清债务(发布面 ctx.pi / PiExtensions 命名迁移): ${KNOWN_NAMED_DEBT.length} 个文件、${debt} 处命中`);
    }
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


// ⑨ 内核名不许当**契约字段名**（§1.3 契约单源 / §1.4 无特权差异）。
//    这条为什么是结构性而不是"注意一下"：`piExtension`/`dshExtension` 这种按内核名分字段的写法，
//    每接一个内核就要在**圆心**（contributions.ts）加一个字段、在生命周期/装配/能力广播各加一处
//    对称分支——圆心是"拿掉所有会变的东西之后剩下的"，而内核清单恰恰是最会变的东西。
//    实测该模式一度铺到 4 处（manifest 字段 / lifecycle deps / MainContext / SessionCapabilities）。
//    现在统一成 `extensions: { 内核 id: 路径 }` + `createPluginExtensionSync()`（每个内核各交一份），
//    本检验守住不让它回潮：壳机制层与圆心不许再出现 `<内核名>Extension` 形态的标识符。
{
  const out = execSync(
    // 匹配 `<内核名>Extension…` 这个**前缀**（不带尾部 \b：piExtensionEnsureProbe 这类
    // 派生名同样是"按内核名分字段"，尾界会让它从守卫旁边溜过去）。
    `grep -rnE '\\b(pi|dsh|minimal)Extension' --include='*.ts' --include='*.tsx' packages/shared/src src/server/application src/server/bootstrap src/server/kernel/core src/web 2>/dev/null || true`,
    { encoding: "utf-8", cwd: ROOT },
  );
  for (const l of out.split("\n").filter(Boolean)) {
    const parts = l.split(":");
    const file = parts[0];
    const text = parts.slice(2).join(":").trim();
    if (/^(\/\/|\*|\/\*)/.test(text)) continue; // 注释：历史说明里会提旧写法
    if (/\.test\./.test(file)) continue;            // 测试：可用旧名做对照说明
    violations.push(`⑨ 按内核名分字段的契约 ${file.replace(ROOT, "")}: ${text.slice(0, 80)}`);
  }
}

// ⑩ 壳**机制层**生产代码里不许出现内核名字面量（§目标 11 的收口，已归零，守住别回潮）。
//
//    覆盖 `src/server/application`（用例编排）+ `src/server/bootstrap`（组装根）+
//    `src/server/kernel/core`（内核骨架）——这三层是"壳的机制"，任何一处写死 `"pi"`
//    都意味着**某个内核的特权漏进了机制层**。历史形态（都已清）：
//      · `catalogFor("pi")` / `createProc(..., "pi", ...)` —— 总线工人会话写死 pi
//        （现改为"子会话继承父会话内核"，由 `kernelOfSessionKey` 供给，application 层零内核名）；
//      · `PI_AGENT_DIR` / `DSH_INSTALL_DIR` / `DSH_FIT_EXTENSION_SOURCE` —— 壳持有内核路径常量
//        （现由各内核插件的 `sessionRoot()/configRoot()/createPluginExtensionSync()` 自报）；
//      · `manifest.piExtension` —— 按内核名分字段（现为 `extensions: { 内核 id: 路径 }`）。
//    豁免：注释行（历史说明里会提内核名）与测试文件。
{
  const out = execSync(
    // 只匹配双引号字面量（本仓字符串统一双引号）。**别在模式里塞单引号/反引号**：
    // shell 的单引号串里出现单引号会把整条命令拆坏（本轮实测：`unexpected EOF`）。
    // 模式含两种形态：完整字面量 `"pi"`，以及**以内核名开头的字符串** `"pi 未启动"`。
    // 后者是实测漏网形态：`session-store.piSend` 曾 `throw new Error("pi 未启动")`——
    // 用户可见的错误文案里点名内核，而原模式要求引号内**恰好**只有内核名，抓不到。
    `grep -rnE '"(pi|dsh|minimal)([" 　])' --include='*.ts' --include='*.tsx' src/server/application src/server/bootstrap src/server/kernel/core 2>/dev/null || true`,
    { encoding: "utf-8", cwd: ROOT },
  );
  for (const l of out.split("\n").filter(Boolean)) {
    const parts = l.split(":");
    const file = parts[0];
    const text = parts.slice(2).join(":").trim();
    if (/^(\/\/|\*|\/\*)/.test(text)) continue;
    if (/\.test\./.test(file)) continue;
    violations.push(`⑩ 机制层内核字面量 ${file.replace(ROOT, "")}: ${text.slice(0, 90)}`);
  }
}

// ⑪ 内核目录自包含：`src/server/kernel/<id>/` 之外的**生产代码**不许 import 该目录内部。
//
//    为什么必须有这条（检验⑧补不住的洞）：⑧只扫 `kernel/<id>/` **内部**的互相引用，
//    所以「pi/plugin.ts → 共享 factories → dsh/backend/*」这种**传递**依赖从它旁边溜过去了。
//    实测该形状曾真实存在：`kernel/factories/kernel-factories.ts` 一个文件同时 import 三个内核的
//    backend/catalog/transport，而三个内核插件又反向 import 它 —— 删掉 `kernel/dsh/` 会让
//    `kernel/pi/plugin.ts` 编译不过，「内核可整体卸载」（kernel-plugin.md 的验收前提、⑧的立法意图）
//    当场变成假的。现已把每个内核的工厂归位到自己目录（`<id>/backend/<id>-backend-factory.ts`），
//    本检验守住不让共享装配点回潮。
//
//    唯一入口是动态 require 的插件产物（`kernel-plugin-loader.ts` 按 `<构建根>/<id>/plugin.js`
//    定位），所以内核目录对外**只暴露 plugin.js 一个面**，任何静态 import 都是越界。
//
//    豁免：测试文件（用真实内核实现做夹具是集成测试的正当形状；删内核时其测试一并删除）。
//    生产代码走显式 allowlist，每条必须写明理由与清理归属——allowlist 长度会被打印，防止悄悄变长。
{
  // **allowlist 现为空**（曾有 1 条：`session-store.ts` 对 `kernel/pi/backend/pi-backend-extensions`
  // 的 type-only 消费）。清空的办法不是放宽判据，而是把那个 pi 专属 opaque 桶拆成圆心的
  // **逐轴中性能力面**（`BackendCapabilities`：steering/retry/compaction/snapshot/stats/
  // modelCycle/toolExec/busFrames/questions/thinking + fileBacked），application 改为按轴探测，
  // `kernel/pi/backend/pi-backend-extensions.ts` 随之删除。
  // 机制层从此不认识任何内核的专属形状——加内核时 application 一行不改（面是可选的）。
  const KNOWN = [];
  const KERNEL_IDS = ["pi", "dsh", "minimal"];
  const roots = ["src/server", "src/web", "packages/shared/src", "packages/react/src"];
  for (const root of roots) {
    let files = [];
    try { files = walk(join(ROOT, root)); } catch { continue; }
    for (const f of files) {
      const rel = f.replace(ROOT + "/", "");
      if (/\.test\.(ts|tsx)$/.test(rel)) continue;                       // 测试豁免
      if (/^src\/server\/kernel\/[^/]+\//.test(rel)) continue;           // 内核自己的目录内，⑧ 管
      for (const spec of importsOf(f).matchAll(/from\s+["']([^"']+)["']/g)) {
        const s0 = spec[1];
        if (!s0.startsWith(".")) continue;                                 // 包名不走相对路径越界
        const abs = resolve(dirname(f), s0).replace(ROOT + "/", "");
        const m = abs.match(/^src\/server\/kernel\/([^/]+)\//);
        if (!m || !KERNEL_IDS.includes(m[1])) continue;                    // 落到 kernel/core 等机制层是允许的
        if (KNOWN.some((k) => rel === k.file && abs === k.target)) continue;
        violations.push(`⑪ 内核目录越界 ${rel}: ${s0} → kernel/${m[1]}/（生产代码不许静态 import 内核内部）`);
      }
    }
  }
  if (KNOWN.length > 0) {
    console.log(`  ⑪ 已知越界 allowlist: ${KNOWN.length} 条（每条须在脚本内写明理由与清理归属）`);
  }
}

// ⑫ 圆心与发布面**零内核名前缀标识符**。
//
//    为什么单立一条（⑦b 补不住）：⑦b 抓的是 `<内核名>Extension` 形态与裸 `<内核名>:` 字段，
//    而实测漏网的是**任意内核名前缀的类型名**——`DshConfigApi` / `DshProvider` / `DshModelSpec` /
//    `DshDefaultModel` / `PiSettingsApi` 五个类型曾声明在圆心 `domain/context.ts`，
//    其中 `DshConfigApi` 还带 `addPluginBlock`（cordis 插件块）这种纯 dsh 内部概念。
//    核实后它们的真实消费者**全在各自内核目录内**，壳侧的 import 全是死 import。
//    按 §4.2「圆心 = 拿掉所有会变的东西之后还剩什么」：换掉那个内核，这些类型就该消失，
//    所以它们不是圆心材料。现已全部下移到 `kernel/<id>/` 自己的契约文件。
//
//    范围只限**圆心 + 发布面**两处（`packages/shared/src` 与 `packages/react/src`）：
//    内核自己目录内用内核名前缀是正当的（`DshConfigSource` 住在 `kernel/dsh/` 天经地义），
//    壳机制层则由检验⑩（字面量）与⑦b（能力面/字段名）覆盖。
//    豁免：注释行（退役说明里必须能提到旧名）。
{
  const out = execSync(
    `grep -rnoE '\\b(Pi|Dsh|Minimal)[A-Z][A-Za-z]*' --include='*.ts' --include='*.tsx' packages/shared/src packages/react/src 2>/dev/null || true`,
    { cwd: ROOT, encoding: "utf-8" },
  );
  const seen = new Set();
  for (const l of out.split("\n").filter(Boolean)) {
    const m = l.match(/^(.*?):(\d+):(\w+)$/);
    if (!m) continue;
    const [, file, line, ident] = m;
    if (/\.test\./.test(file)) continue;
    // 取该行原文，跳过注释行（退役说明/历史对照里会提旧名）
    let text = "";
    try { text = readFileSync(join(ROOT, file), "utf-8").split("\n")[Number(line) - 1] ?? ""; } catch { continue; }
    if (/^\s*(\/\/|\*|\/\*)/.test(text)) continue;
    const key = `${file}:${ident}`;
    if (seen.has(key)) continue;
    seen.add(key);
    violations.push(`⑫ 圆心/发布面的内核名类型 ${file.replace(ROOT, "")}:${line} ${ident} —— 应下移到 kernel/<id>/ 自己的契约文件`);
  }
}

/** 某文件某行的**去注释**版本里是否仍命中该模式。
 *  用来区分"代码里真的这么写"与"注释里提到过这个写法"（退役说明/设计注解常会引用旧写法，
 *  那是合法的）。按行首符号判断是不够的：块注释的中间行既不以 `/*` 也不以 `*` 开头。 */
const __commentStripCache = new Map();
function isInsideComment(file, lineNo, re) {
  let code = __commentStripCache.get(file);
  if (code === undefined) {
    let src = "";
    try { src = readFileSync(join(ROOT, file), "utf-8"); } catch { src = ""; }
    src = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));   // 块注释挖空（保留行数）
    code = src.split("\n").map((l) => {
      const i = l.indexOf("//");
      if (i < 0) return l;
      const before = l.slice(0, i);
      const quotes = (before.match(/(?<!\\)["'`]/g) ?? []).length;
      return quotes % 2 === 0 ? before : l;      // 偶数 = `//` 在字符串外 = 真注释
    });
    __commentStripCache.set(file, code);
  }
  const line = code[lineNo - 1] ?? "";
  return !re.test(line);                          // 去注释后不再命中 ⇒ 原本就在注释里
}

// ⑬ 不许用**字面量键**访问内核的面（`ctx.kernels.pi` / `kernelConfig["dsh"]`）。
//
//    为什么单立一条：检验⑥抓的是 `kernel === "pi"` 这类**身份硬分支**，而字面量键访问是另一种
//    形态——它不比较身份，而是直接**取某个指定内核的面**，同样让壳漏内核身份，且更隐蔽
//    （读起来像正常取值）。实测三处真实缺陷都是这个形态：
//      · `web/stores/session-store.ts` 发送前问 `kernels.pi.fitExtensionAvailable()` 决定要不要
//        给**当前会话**内联工具限制说明 —— dsh 会话下拿 pi 的答案做判断；
//      · `tool-manager` 插件报告 `kernels.pi` 的扩展可用性，与用户实际在用哪个内核无关；
//      · `sessions/timeline` 用 `ctx.kernelConfig["pi"].get()` 取 `retry.maxRetries` 当
//        重试折叠条的展示分母 —— dsh/minimal 会话也按 pi 的设置显示，且 pi 未安装时
//        `ctx.kernelConfig["pi"]` 是 undefined → `.get()` 抛 TypeError → 被 `Promise.allSettled`
//        吞掉 → 静默回落默认值（r28 修：分母改由 `autoRetryStart` 事件的 `maxAttempts` 提供，
//        那是内核自己报的、逐会话逐内核的真实值）。
//    前两处已改为「问当前会话的内核」（壳侧 `prefs.kernel`、插件侧 `capabilities.kernel`）。
//
//    ⚠ **判据必须覆盖整个"按内核键控的面族"，不能只盯 `kernels` 一个名字**：
//    首版只扫 `kernels.pi|kernels["pi"]`，于是第三处（`kernelConfig["pi"]`）从旁边溜了过去。
//    同族还有 `kernelModels` / `kernelVersionApis` / `kernelExtensions` / `kernelLogos` /
//    `kernelOneshots`（后四个在服务端已于 r15 改成函数形状，字面量键访问在类型上就不可能，
//    但仍列进判据以防回潮）。
//
//    ⚠ grep 模式里**不要出现引号字符**：命令是 `execSync` 交给 `/bin/sh -c` 的字符串，
//    模式里同时要有 `"` 和 `'` 时，无论用哪种引号包裹都要多层转义（JS 模板 → shell → grep），
//    实测三次都没写对（`\'` 在 shell 双引号里不是转义、反而会开启一个新的单引号串）。
//    这里用 `.` 匹配引号字符本身——`["pi"]` 与 `['pi']` 都能命中，误报面可忽略。
//
//    豁免：**内核自己的插件目录引用自己**（`src/plugins/kernels/<id>/` 里的 `<面>.<id>`）——
//    那是该内核的设置页在取自己的面，正是「一个内核 = 一个插件」的应有形状。
//    以及注释行（退役说明里要能提到旧写法）与测试文件。
{
  const FACES = "kernels|kernelModels|kernelConfig|kernelVersionApis|kernelExtensions|kernelLogos|kernelOneshots";
  const IDS = "pi|dsh|minimal";
  // 点号形式 `kernels.pi` 与下标形式 `kernelConfig["pi"]`（引号用 `.` 代指，理由见上）
  const pattern = `(${FACES})[[:space:]]*(\\.[[:space:]]*(${IDS})\\b|\\[[[:space:]]*.(${IDS}).[[:space:]]*\\])`;
  const out = execSync(
    `grep -rnE "${pattern}" --include=*.ts --include=*.tsx src packages 2>/dev/null || true`,
    { cwd: ROOT, encoding: "utf-8" },
  );
  const hitRe = new RegExp(`(${FACES})\\s*(?:\\.\\s*(${IDS})\\b|\\[\\s*.?(${IDS}).?\\s*\\])`);
  for (const l of out.split("\n").filter(Boolean)) {
    const parts = l.split(":");
    const file = parts[0];
    const text = parts.slice(2).join(":").trim();
    if (/\.test\./.test(file)) continue;
    if (/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(text)) continue;
    // ⚠ 行首判据**不够**：块注释的中间行不以 `*` 或 `//` 开头（实测漏掉
    //   `kernel-config-form.tsx` 里一句提到 `kernelConfig.dsh.get()` 的说明文字）。
    //   精确做法是把该文件的块注释与行注释整体剥掉，再看这一行还含不含该模式。
    if (isInsideComment(file, Number(parts[1]), hitRe)) continue;
    // 内核自己的插件目录引用自己 → 豁免
    const own = file.match(/^src\/plugins\/kernels\/([^/]+)\//);
    const hit = text.match(hitRe);
    const hitId = hit ? (hit[2] ?? hit[3]) : null;
    if (own && hitId && own[1] === hitId) continue;
    violations.push(`⑬ 字面量键访问内核的面 ${file.replace(ROOT, "")}: ${text.slice(0, 80)}`);
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
  "test-plugins",
];
const scope = walked.reduce((n, d) => n + walk(join(ROOT, d)).length, 0);
console.log(`依赖方向审计(十三检验): ${violations.length} 处违规`);
console.log(`  覆盖:walk ${walked.length} 个骨架目录共 ${scope} 文件(${walked.join(" · ")});` +
  `另有 ⑤⑥⑦⑨⑩ 五条 grep 覆盖 src/web、packages/react/src 等(核 KernelId 字面量/内核身份分支/能力名中性化)，⑪ 遍历 src/server+src/web+packages 核内核目录自包含`);
for (const v of violations) console.log("  " + v);
process.exit(violations.length > 0 ? 1 : 0);
