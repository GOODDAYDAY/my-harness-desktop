#!/usr/bin/env node
// 交叉引用审计 —— 显式点名 <doc>.md §N 的引用是否还指得着。
// 用法:node scripts/ref-audit.mjs
//
// 定位:**报告,不是阻断门**(exit 恒 0)。首跑 62 处断链,理由同 audit:docs 的演进:
// 让开场就红的检查进 CI,只会被关掉或逼出一轮潦草的批量改路径。**消化到 0 再升级为门。**
//
// 为什么只查这一种形态:docs 里还有 2800+ 处裸 `§N`,但裸 `§N` 大量是**跨文档引用**
// (`§6.4` 指 CLAUDE.md 的节),判不出归属 —— 我试过按"同句未点名他文档"过滤,假阳性依旧 243 处
// (且分句本身不可靠)。**只查显式点名了文件名的,判据才客观。** 宁可少查,不要假红。
//
// 三类断链:
//   ① 文档不存在(重命名/目录搬迁后没同步)
//   ② 节号越界(文档最大节号 < 引用节号)
//   ③ 文件名无路径且无同名文件(如裸 `DESIGN.md`)
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PATTERN = /([A-Za-z0-9_\-/]+\.md)`?\s*§\s*(\d+)(?:\.(\d+))?/g;

const files = execSync(
  // 注意 `docs/**/*.md` **不匹配 docs 顶层的文件**(git pathspec 的 `**` 语义)——
  // 实测漏掉 18 份(165 vs 183),含 i18n.md/thin-shell.md/core-design.md。必须两个都写。
  //
  // `--cached --others --exclude-standard`:审计的对象是**工作区现状**,不是索引。
  //   · 只用默认的 `--cached`(索引)会漏掉新建但尚未 `git add` 的文件——重构时新文件
  //     往往最后才一起提交,那段窗口里它们完全不在审计覆盖面内(实测:本次内核工厂归位
  //     新建的三个 `*-backend-factory.ts` 就一个都没被扫到)。
  //   · `--others --exclude-standard` 补上未跟踪但未被 .gitignore 排除的文件,
  //     同时仍然跳过 node_modules/out/dist 等。
  "git ls-files --cached --others --exclude-standard 'src/**/*.ts' 'src/**/*.tsx' 'packages/**/*.ts' 'docs/*.md' 'docs/**/*.md' 'scripts/**/*.mjs' '.claude/skills/**/*.md' 'CLAUDE.md' 'README.md'",
  { cwd: ROOT, encoding: "utf-8" },
).trim().split("\n").filter(Boolean);

/** 从同名候选里挑一个：现行文档优先，归档副本只当兜底。
 *  规则：先滤掉 `docs/legacy/`；若滤完恰好 1 个 → 用它；若滤完为空且原本恰好 1 个（只在归档里）
 *  → 用那个归档副本；否则（仍有歧义）返回 null，交由上层报断链。 */
const preferLive = (hits) => {
  if (hits.length === 0) return null;
  const live = hits.filter((h) => !h.startsWith("docs/legacy/"));
  if (live.length === 1) return live[0];
  if (live.length === 0 && hits.length === 1) return hits[0];
  return null;
};

const violations = [];
let total = 0;
let skippedMissing = 0;
for (const rel of files) {
  // docs/legacy/** 是**冻结的历史归档**(当时的设计快照),其中的引用按当时的环境写,
  // 断链是预期状态而非缺陷——对它报红只会制造噪声。有原则地排除,不是放宽判据。
  if (rel.startsWith("docs/legacy/")) continue;
  // 工作区已删但索引里还在的文件(未 `git rm` 的删除不反映到 `--cached`):没有内容可审,跳过。
  // **不能让它抛 ENOENT**——本脚本是报告工具(exit 恒 0),一次崩溃会让整条 `npm run audit`
  // 链在这里断掉,后面的 symbols/quiet/session-scope 全部不跑(实测发生过)。
  if (!existsSync(join(ROOT, rel))) { skippedMissing += 1; continue; }
  const text = readFileSync(join(ROOT, rel), "utf-8");
  for (const m of text.matchAll(PATTERN)) {
    total += 1;
    const doc = m[1];
    const n = Number(m[2]);
    const line = text.slice(0, m.index).split("\n").length;
    // 解析顺序:① 按写法当路径;② 按 docs/ 前缀;③ 按**文件名全仓搜**(docs 下任意深度)。
    // ③ 是必须的:插件文档之间习惯只写文件名(`message-blocks.md`),而它们散在
    // docs/plugins/<域>/ 下——只试固定几个目录会把它判成断链(实测假阳性)。
    // 「引用语境」豁免(与 doc-drift-audit 同款两层判定):文档里**举一个曾经引错的例子**时,
    // 那个错引用会被本审计当成真断链。实测:.claude/skills/interaction-testing/SKILL.md 的
    // "历史教训"表里逐字写着 `kernel-layer.md §9.4` 其实在 CLAUDE.md §9.4 —— 那是**引用错误**,
    // 不是**犯错误**。标记词只认"在谈某个引用本身"的语境,不认泛泛的"历史/迁移"。
    const QUOTE_CTX = ["引错", "其实在", "举例", "教训", "误引", "写作", "笔误"];
    const lines = text.split("\n");
    const ctx = lines.slice(Math.max(0, line - 4), line + 3).join("\n");
    if (QUOTE_CTX.some((w) => ctx.includes(w))) continue;

    const candidates = [doc, join("docs", doc)];
    if (!candidates.some((c) => existsSync(join(ROOT, c)))) {
      const file = basename(doc);
      // ⓐ **同插件目录**:插件自述文档住在插件自己的目录里
      //    (`docs/plugins/system/general-config.md` → `src/plugins/system/general-config/plugin.md`,
      //     `docs/plugins/sessions/session-colors.md` → `.../session-colors/DESIGN.md`)。
      //    实测:`plugin.md` / `DESIGN.md` 这类**同名多份**的文件,只能靠"同插件"来消歧——
      //    全仓按名搜会因歧义而放弃(我把 4 个 DESIGN.md 判成断链 35 处,就是漏了这条)。
      // "同插件"的键有两个来源:①引用**文档**的名字(插件文档与插件目录同名);
      // ②引用**文件**的任一**祖先目录**名(插件目录里的代码文件,如 `key-hints/core/hints.ts`)。
      // 只取 stem 会漏掉 ② —— 实测那样还剩 7 处假断链。
      const keys = [basename(rel).replace(/\.md$/, ""), ...dirname(rel).split("/").filter(Boolean)];
      const alt = keys.map((k) => `/${k}/`).join("|");
      // 按名解析时，`docs/legacy/`（冻结归档）的副本**只当兜底**、不与人竞争唯一性：
      // 同名多份时优先取现行文档。实测 `docs/legacy/token-stats.md` 与
      // `docs/plugins/insight/token-stats.md` 同名，使 ⓑ/ⓒ 两步都因"命中 2 个、不唯一"
      // 而放弃，把一条**有效**引用判成断链。反过来，只在归档里存在的文档仍可被解析到
      // （那是另一类问题：代码注释指向已归档文档，属 stale 引用，不在本门的判据内）。
      const own = execSync(
        `git ls-files --cached --others --exclude-standard | grep -E '(${alt})${file.replace(/\./g, "\\.")}$' || true`,
        { cwd: ROOT, encoding: "utf-8" },
      ).trim().split("\n").filter(Boolean);
      candidates.push(...own);
      // ⓑ **docs 下按名唯一搜**(原有规则):根设计文档 `DESIGN.md` 现归档在 `docs/legacy/`,
      //    全仓有 4 份同名,只有"限定在 docs 下"才能唯一命中——重写时丢了这步,害 7 处变假断链。
      if (!candidates.some((c) => existsSync(join(ROOT, c)))) {
        const inDocs = execSync(
          `git ls-files --cached --others --exclude-standard | grep -E '^docs/.*/${file.replace(/\./g, "\\.")}$' || true`,
          { cwd: ROOT, encoding: "utf-8" },
        ).trim().split("\n").filter(Boolean);
        const pick = preferLive(inDocs);
        if (pick) candidates.push(pick);
      }
      // ⓒ 再退一步:**全仓按文件名搜,仅当唯一**
      if (!candidates.some((c) => existsSync(join(ROOT, c)))) {
        const hits = execSync(
          `git ls-files --cached --others --exclude-standard | grep -E '(^|/)${file.replace(/\./g, "\\.")}$' | grep -v node_modules || true`,
          { cwd: ROOT, encoding: "utf-8" },
        ).trim().split("\n").filter(Boolean);
        const pick = preferLive(hits);
        if (pick) candidates.push(pick);
      }
    }
    const real = candidates.find((c) => existsSync(join(ROOT, c)));
    if (!real) {
      const kind = doc.includes("/") ? "①文档路径不存在(搬迁/重命名后没同步)" : "③文件名无路径且无同名文档";
      violations.push(`${rel}:${line} → \`${m[0]}\` ${kind}`);
      continue;
    }
    const heads = [...readFileSync(join(ROOT, real), "utf-8").matchAll(/^#{1,4}\s+§?\s*(\d+)(?:\.|\s|$)/gm)].map((h) => Number(h[1]));
    if (heads.length > 0 && n > Math.max(...heads)) {
      violations.push(`${rel}:${line} → \`${m[0]}\` ②节号越界(${real} 最大 §${Math.max(...heads)})`);
    }
  }
}

const broken = violations.length;
console.log(`交叉引用报告(显式 <doc>.md §N,${total} 处引用): ${violations.length} 处断链` +
  (skippedMissing > 0 ? `(跳过 ${skippedMissing} 个工作区已删但索引未更新的文件)` : ""));
for (const v of violations) console.log("  " + v);
// **已从"报告"升级为阻断门**(2026-09):断链清到 0 之后,它才够格当门——
// 顺序是先消化再设门(与 audit:docs 同一路数):清单没清空就设门,只会被人关掉。
// 门的意义:新写的 `.md §N` 引用若指向不存在/越界的目标,提交时当场红。
if (broken > 0) {
  console.log(`\n✗ 交叉引用门:${broken} 处断链,请修正或改写为可解析的引用。`);
  process.exit(1);
}
process.exit(0); // 报告:不阻断(理由见文件头注释)
