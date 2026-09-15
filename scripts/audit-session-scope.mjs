#!/usr/bin/env node
// 会话作用域静态守卫(设计 docs/design/session-scope.md §3.5)——CI-able,违规 exit 1、全绿 exit 0。
//
// 四条检查盯的是「会话作用域机制上线后最容易复发的四个形态」。没有守卫的修复只是"这次对了",
// 下一次重构就回潮(CLAUDE.md §3.7):goal 的键口径漂移在 f20248c1 修过一次、又在别处复发,
// 根因就是当时只修没守。
//
// 关键实现细节:**先剥离注释再扫**。prevKeyRef / startsWith("new:") / currentNeutralSessionId ?? …
// 这些形态在注释里是合法的文档说明(解释"为什么不再这么做"),只有出现在**代码**里才是违规。
// 纯文本 grep 会把注释里的说明误报成违规,守卫一上线就刷屏、失去信号。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const violations = [];

const walk = (dir, out = []) => {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const f of entries) {
    if (f === "node_modules" || f === "out" || f === ".git" || f === "dist") continue;
    const p = join(dir, f);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(f)) out.push(p);
  }
  return out;
};

// 剥离行注释与块注释,保留字符串字面量里的内容。
// 状态机:跟踪单引号/双引号/反引号字符串、行注释、块注释;字符串内的注释标记不剥。
// (本注释故意不用块注释形态——注释里写块注释定界符会把注释本身提前终止。)
function stripComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  let str = null;         // 当前字符串定界符
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (str) {
      out += c;
      if (c === "\\") { out += src[i + 1] ?? ""; i += 2; continue; }  // 转义:原样带过下一个字符
      if (c === str) str = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { str = c; out += c; i++; continue; }
    if (c === "/" && c2 === "/") { while (i < n && src[i] !== "\n") i++; continue; }         // 行注释:跳到行尾
    if (c === "/" && c2 === "*") { i += 2; while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; out += " "; continue; }  // 块注释:换空格(保留 token 分隔)
    out += c;
    i++;
  }
  return out;
}

/** 相对路径(报告用)。 */
const rel = (f) => f.replace(ROOT, "");
/** 是否测试文件(检查①③豁免:测试要造 key)。 */
const isTest = (f) => /\.test\./.test(f) || /[/\\]test-plugins[/\\]/.test(f);

// ============================================================================
// 检查① 禁止手写会话 key 拼装(设计 §3.5.1)
// ============================================================================
// 身份算法单源在圆心 sessionScopeKey;消费方读 useCurrentScopeKey()/currentScopeKey()。
// 手写 `ns ?? path` / `ns ?? new:${cwd}` 就是绕过单源——同一个会话在不同消费方是两个 key。
const KEY_PATTERNS = [
  /currentNeutralSessionId\s*\?\?\s*currentSessionPath/,
  /currentNeutralSessionId\s*\?\?\s*\(?\s*currentCwd/,
  /\?\?\s*`new:\$\{/,
];
// 机制本体与派生层合法地计算 key(它们就是单源出口的实现);测试要造 key。
const KEY_EXEMPT = [/src[/\\]web[/\\]stores[/\\]session-scope\.ts$/, /src[/\\]web[/\\]stores[/\\]session-pending\.ts$/];
for (const f of [...walk(join(ROOT, "src/plugins")), ...walk(join(ROOT, "src/web"))]) {
  if (isTest(f)) continue;
  if (KEY_EXEMPT.some((re) => re.test(f))) continue;
  const code = stripComments(readFileSync(f, "utf-8"));
  code.split("\n").forEach((line, idx) => {
    if (KEY_PATTERNS.some((re) => re.test(line))) {
      violations.push(`① 手写会话 key 拼装 ${rel(f)}:${idx + 1}: ${line.trim().slice(0, 80)}`);
    }
  });
}

// ============================================================================
// 检查③ 禁止插件自写物化迁移(设计 §3.5.3)
// ============================================================================
// 物化搬迁是框架 carry 的职责;插件侦测 key 变化自己搬 = 重造 carry(review 旧实现那 17 行)。
const MIGRATE_PATTERNS = [/prevKeyRef/, /\.startsWith\(\s*["']new:/];
for (const f of walk(join(ROOT, "src/plugins"))) {
  if (isTest(f)) continue;
  const code = stripComments(readFileSync(f, "utf-8"));
  code.split("\n").forEach((line, idx) => {
    if (MIGRATE_PATTERNS.some((re) => re.test(line))) {
      violations.push(`③ 插件自写物化迁移 ${rel(f)}:${idx + 1}: ${line.trim().slice(0, 80)}`);
    }
  });
}

// ============================================================================
// 检查② 禁止插件 renderer 模块级可变态(设计 §3.5.2)
// ============================================================================
// 判据按优先级:① 白名单命中→豁免;② 该标识符在本插件目录内无写操作→豁免(只读常量);③ 其余→违规。
// 扫描单位是**插件目录**(不是单文件):模块级可变容器 export 出去、在另一文件写,是最容易
// 绕过单文件检查的形态。跨插件写入不追(插件间只能走事件通信,直接 import 对方已被 audit:deps 检验④ 拦)。
const MUTABLE_WHITELIST = [
  { file: /message-blocks[/\\]renderer[/\\]thinking-chain-block\.tsx?$/, name: "thinkingOpenOverride", reason: "全局 UI 态度(我想看思考过程),不是会话态;设计 §4.5.1" },
  { file: /session-colors[/\\]renderer[/\\]index\.tsx?$/, name: "attachedOnce", reason: "pin id 是 uuid 全局唯一,跨会话共享是正确语义;设计 §4.5.2" },
  { file: /goal[/\\]renderer[/\\]goal-controller\.tsx?$/, name: "activeCommandHandler", reason: "斜杠命令桥只服务当前输入框,全局一份是对的;设计 §4.5.2" },
  { file: /goal[/\\]renderer[/\\]goal-controller\.tsx?$/, name: "activeCarryPersister", reason: "onCarry 桥,同 activeCommandHandler;静态声明拿不到 PluginContext" },
  { file: /sub-agent[/\\]renderer[/\\]dialog-state\.tsx?$/, name: ".*", reason: "对话框单例态,隔离维度是 bus 地址;设计 §4.5.3" },
  // 以下三条是**全局单例**,不是会话态——切会话时它们必须保持不变(按 §4.5 判据):
  { file: /sub-agent[/\\]renderer[/\\]orchestrator-singleton\.tsx?$/, name: "instance", reason: "编排器单例:隔离维度是 bus 地址(父→子编排关系),天然跨会话,按会话切分会切断编排;设计 §4.5.3" },
  { file: /voice-input[/\\]renderer[/\\]stt-engine\.tsx?$/, name: "pipelinePromise", reason: "ASR 推理管线(数秒加载 + 数百 MB 模型):设备级资源,切会话必须复用同一实例,按会话各建一份会耗尽内存" },
  { file: /voice-input[/\\]renderer[/\\]stt-engine\.tsx?$/, name: "loadedModel", reason: "已加载的 ASR 模型 id:与 pipelinePromise 配对,记录设备级单例当前装的是哪个模型" },
];
// 模块级可变声明:`let x` / `const x = new Map(`/`new Set(` / `const x = {`(对象字面量)
// 只认 Map/Set 与 let 声明(它们才是「模块级可变容器/可重赋值」)。
// 对象/数组字面量不在此列:插件里大量 `const X = {...}` 是只读配置表(如字典、样式映射),
// 逐个查写操作成本高且噪音大;真正危险的会话态形态是 Map/Set 与 let。
const MUTABLE_DECL = /^const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*new\s+(?:Map|Set)\s*[<(]/;
const LET_DECL = /^let\s+([A-Za-z_$][\w$]*)/;
for (const f of walk(join(ROOT, "src/plugins"))) {
  if (isTest(f)) continue;
  if (!/[/\\]renderer[/\\]/.test(f)) continue;   // 只扫 renderer 层(core/ 是纯函数层,本就无可变态)
  const code = stripComments(readFileSync(f, "utf-8"));
  const lines = code.split("\n");
  // 收集本文件顶层(非缩进)声明的可变标识符
  const decls = [];
  lines.forEach((line, idx) => {
    if (/^\s/.test(line)) return;   // 只看顶层(缩进的是函数体内局部变量)
    const m = MUTABLE_DECL.exec(line) || (LET_DECL.test(line) ? LET_DECL.exec(line) : null);
    if (!m) return;
    const name = m[1];
    // 只读常量豁免:全插件目录内无写操作
    decls.push({ name, line: idx + 1 });
  });
  for (const { name, line } of decls) {
    if (MUTABLE_WHITELIST.some((w) => w.file.test(f) && (w.name === ".*" || w.name === name))) continue;
    // 判据②:该标识符在本插件目录内有无写操作(无 → 只读常量,豁免)
    if (!isWrittenInPluginDir(name, pluginDirOf(f))) continue;
    violations.push(`② 插件 renderer 模块级可变态 ${rel(f)}:${line}: ${name}(该进会话作用域槽或加白名单并写明理由)`);
  }
}
function pluginDirOf(f) {
  // src/plugins/<组>/<插件>/ 的 <插件> 目录
  const m = f.match(/^(.*[/\\]plugins[/\\][^/\\]+[/\\][^/\\]+)[/\\]/);
  return m ? m[1] : dirname(f);
}
function isWrittenInPluginDir(name, dir) {
  // 写操作三类:① 变更方法(.add/.set/.delete/.clear/.push/.pop/.splice);
  // ② 重新赋值(但**排除声明行自身**——`const X = new Set()` 里的 `=` 是初始化不是写);
  // ③ 下标赋值(X[k] = …)。
  const mutateRe = new RegExp(`\\b${name}\\b\\s*\\.\\s*(?:add|set|delete|clear|push|pop|splice|has)\\s*\\(`);
  const reassignRe = new RegExp(`^\\s*${name}\\s*=[^=]`, "m");           // let 重赋值(行首即标识符)
  const indexRe = new RegExp(`\\b${name}\\b\\s*\\[[^\\]]*\\]\\s*=[^=]`);
  const declRe = new RegExp(`^\\s*(?:const|let)\\s+${name}\\b`, "m");   // 声明行:不算写
  for (const f of walk(dir)) {
    if (isTest(f)) continue;
    const code = stripComments(readFileSync(f, "utf-8"));
    // .has() 只读,不算写:从 mutateRe 里剔掉(它只用于「有没有变更方法」的判定)
    const mutateNoHas = new RegExp(`\\b${name}\\b\\s*\\.\\s*(?:add|set|delete|clear|push|pop|splice)\\s*\\(`);
    if (mutateNoHas.test(code)) return true;
    if (indexRe.test(code)) return true;
    // 重赋值:命中且该行不是声明行
    const m = reassignRe.exec(code);
    if (m && !declRe.test(m[0])) return true;
    if (reassignRe.test(code) && !declRe.test(code)) return true;
  }
  return false;
}

// ============================================================================
// 检查④ drop 必须被调用(设计 §3.5.4)
// ============================================================================
// drop 的唯一调用点必须在 removeSessionRows(三条删除路径的汇聚点)。漏接的后果不是功能错误,
// 是那个会话的作用域与事件回放桶常驻内存(无界增长),没有可见症状——人工 review 盯不住。
{
  const storePath = join(ROOT, "src/web/stores/session-store.ts");
  const src = stripComments(readFileSync(storePath, "utf-8"));
  const i = src.indexOf("removeSessionRows: (paths)");
  if (i < 0) {
    violations.push("④ removeSessionRows 未找到(session-store.ts 结构变了?drop 接线可能丢了)");
  } else {
    // 取该函数体(到下一个 `  },\n` 方法边界)
    const body = src.slice(i, i + 1200);
    if (!/\.drop\(/.test(body)) {
      violations.push("④ removeSessionRows 未调用 scope.drop(ns)——会话删除时作用域与回放桶不会回收(§3.5.4)");
    }
  }
}

// ============================================================================
// 报告
// ============================================================================
if (violations.length > 0) {
  console.error(`\n会话作用域静态守卫: ${violations.length} 处违规\n`);
  for (const v of violations) console.error("  " + v);
  console.error(`\n设计依据:docs/design/session-scope.md §3.5。豁免见脚本内 MUTABLE_WHITELIST / KEY_EXEMPT(每条带理由)。\n`);
  process.exit(1);
}
console.log(`会话作用域静态守卫(四检验): 0 处违规`);
console.log(`  ① 手写 key 拼装 ② 插件模块级可变态 ③ 插件自写迁移 ④ drop 接线`);
console.log(`  覆盖:src/plugins + src/web(剥注释后扫);白名单 ${MUTABLE_WHITELIST.length} 条各带理由`);
