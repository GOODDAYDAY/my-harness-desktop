#!/usr/bin/env node
// class-coverage:候选类覆盖审计——源码里出现的每个 Tailwind 候选,构建产物 CSS 里必须有对应规则。
// 回归守卫:@source 漂移一类问题(1516ebcb 相对路径未 rebase)会让某棵源码树的工具类
// 整批静默漏生成——圆角/宽度/命中全失效但构建不报错。本脚本把「漏生成」变成红灯。
//
// 用法:node scripts/class-coverage.mjs   (先 npm run build)
// 退出码 0 = 全覆盖;1 = 有缺失(打印缺失清单)。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------- 源码候选提取 ----------
// 只扫 className="…" / className={`…`} 字面量段;动态拼接段(${...})按两侧字面量各自提取。
const SOURCES = ["src/plugins", "src/web", "packages/react/src"];
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if ([".tsx", ".ts"].includes(extname(p))) out.push(p);
  }
  return out;
}
function extractCandidates(text) {
  const found = new Set();
  // className="..." 与 className={`...`} 与 className={`...${x}...`} 的模板段
  const re = /className\s*=\s*(?:"([^"]*)"|\{`([^`]*)`\})/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1] ?? m[2] ?? "";
    // 去掉 ${...} 表达式残段,按空白切候选
    for (const tok of raw.replace(/\$\{[^}]*\}/g, " ").split(/\s+/)) {
      const t = tok.trim();
      // 过滤明显非候选:空、纯表达式残片、含未配对括号的
      if (!t || t.startsWith("$") || t.includes('"')) continue;
      found.add(t);
    }
  }
  return found;
}

// ---------- CSS 选择器构造(对齐 Tailwind v4 转义) ----------
function escSel(s) {
  // CSS 类选择器:非字母数字(除 - _)一律反斜杠转义
  return s.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
}
function splitVariants(candidate) {
  // 按 [] 之外的 ':' 切;最后一段是基础工具,前面是变体
  const parts = [];
  let depth = 0, cur = "";
  for (const ch of candidate) {
    if (ch === "[") depth++;
    if (ch === "]") depth--;
    if (ch === ":" && depth === 0) { parts.push(cur); cur = ""; }
    else cur += ch;
  }
  parts.push(cur);
  return parts;
}
const VARIANT_PSEUDO = {
  hover: ":hover", focus: ":focus", active: ":active", disabled: ":disabled",
  "focus-within": ":focus-within", "focus-visible": ":focus-visible",
};
const MEDIA_VARIANTS = new Set(["sm", "md", "lg", "xl", "2xl"]);
function buildSelectors(candidate) {
  // 返回「必须在 CSS 文本中出现的子串」集合(按 Tailwind v4 转义构造主选择器)
  const parts = splitVariants(candidate);
  const base = parts[parts.length - 1];
  const variants = parts.slice(0, -1);
  // group-*/data-* 变体:规则形如 .group-hover\:x:is(:where(.group):hover *)——
  // 验转义全类名出现即可(前缀语法随 Tailwind 版本变,不锁死)
  if (variants.some((v) => v.startsWith("group") || v.startsWith("data-"))) {
    const full = `${variants.map(escSel).join("\\:")}\\:${escSel(base)}`;
    return [`.${full}`];
  }
  // 媒体变体:规则在 @media 块内,选择器就是转义全类名,无伪类后缀
  if (variants.every((v) => MEDIA_VARIANTS.has(v)) && variants.length) {
    return [`.${variants.map(escSel).join("\\:")}\\:${escSel(base)}`];
  }
  const suffix = variants.map((v) => VARIANT_PSEUDO[v] ?? "").join("");
  // 变体类名本身进选择器前缀: hover:bg-x → .hover\:bg-x:hover
  const full = `${variants.map((v) => escSel(v)).join("\\:")}${variants.length ? "\\:" : ""}${escSel(base)}`;
  return [`.${full}${suffix}`, `.${escSel(base)}`];
}

/* 语义钩子类:故意不带 CSS 规则——样式全在内联 style(如 stream-caret 竖线光标、
   laneHead 由 laneHeadStyle() 内联),或仅是组件/结构标识。新增钩子类在此登记并写明理由。 */
const HOOK_CLASSES = new Set([
  "stream-caret",   // StreamingCaret 内联 style 全量样式
  "stalled-hint",   // 停顿提示内联 style;shimmer 关键帧在 index.css
  "laneHead",       // fullscreen-map laneHeadStyle() 内联
  "markdown-body",  // 排版走 ReactMarkdown components 的 Tailwind 类,钩子本身无规则
]);

// ---------- 主流程 ----------
const assetsDir = join(ROOT, "out/renderer/assets");
const cssFiles = readdirSync(assetsDir).filter((f) => f.endsWith(".css")).map((f) => join(assetsDir, f));
if (cssFiles.length === 0) {
  console.error("未找到 out/renderer/assets/*.css —— 先 npm run build");
  process.exit(2);
}
const css = cssFiles.map((f) => readFileSync(f, "utf8")).join("\n");

const used = new Set();
for (const src of SOURCES) {
  const dir = join(ROOT, src);
  for (const file of walk(dir)) {
    for (const c of extractCandidates(readFileSync(file, "utf8"))) used.add(c);
  }
}
// 仅校验静态可判定的候选(纯字母数字-[]()%, : . / # 组合);跳过含运行时拼接残片的
const missing = [];
for (const c of [...used].sort()) {
  if (c.includes("${") || c.includes("(") && !c.includes("[")) continue; // 非候选残片
  if (HOOK_CLASSES.has(c)) continue;
  const needles = buildSelectors(c);
  if (!needles.some((n) => css.includes(n))) missing.push(c);
}

console.log(`候选总数: ${used.size}  缺失: ${missing.length}`);
if (missing.length) {
  for (const c of missing) console.log(`  MISSING  ${c}`);
  process.exit(1);
}
console.log("全覆盖 ✅");
