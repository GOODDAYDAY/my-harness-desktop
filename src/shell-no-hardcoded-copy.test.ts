// 壳发布面**用户可见位置**不得硬编码中文 —— CLAUDE.md §7.1 铁律一的自动化版。
//
// 原文说这个检验"不依赖任何外部知识，新人也能当场判"：打开壳的任何文件，看到一个写死的
// 中文文案就是违规（token key 合规、token 值违规）。但"当场判"是人工动作，于是它一直在漏——
// 本轮实测抓到 3 处真实违规，其中 1 处是**我在修别的缺陷时当场写进去的**
// （给 enum 下拉补"选项外的值"合成项时，直接写了 `（当前值不在可选项内）`）。
// 也就是说：连正在治理这类问题的人都会顺手再犯，靠自觉不行。
//
// 三处实测违规（都已修）：
//   · `error-boundary.tsx`：`渲染错误: {message}` —— 英文/德文用户在**渲染崩溃**时看到中文；
//   · `manager/kernel-config-form.tsx`：`f.group ?? "其他"` —— 分组标题写死中文，任何语言下都是中文；
//   · `manager/model-config-page.tsx`：`title="部分 OpenAI 兼容网关只认 system 角色,pi-ai …"`
//     + JSX 文本 `devRole 不兼容` —— 且该组件是 pi 与 dsh **共用**的，措辞还带内核专属名。
//
// ⚠ **判据的边界必须说清**（否则会让人误以为它覆盖了全部）：本守卫只扫**用户可见位置**的两种形态——
//   ① JSX 属性 `title` / `aria-label` / `placeholder` / `alt` / `aria-description` 里的中文字面量；
//   ② 单行 JSX 文本节点 `>…中文…<`。
//   它**抓不到**：跨行 JSX 文本、先赋值给变量再流入 UI 的字符串（如上面的 `?? "其他"`）、
//   以及 `console.*` / `throw new Error` 里的中文（那是开发者可见，不属本条铁律的对象）。
//   ①②之所以值得单独立守卫，是因为它们是**最高频**的形态，且 100% 是用户可见的——
//   抓不到的那几类由代码评审与本文件的存在感兜（把"这里有一条守卫"这件事写在明处）。
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
/** 壳的发布面：`packages/react/src`（发布面）+ `src/web`（渲染机制）。
 *  `src/plugins/**` 不在内——插件是内容层，文案本该由它自己的 locale 提供，
 *  但插件的 renderer 里同样不该写死中文；那是另一条（更宽的）检查，见文末 TODO。 */
const SHELL_DIRS = ["packages/react/src", "src/web"];
/** 插件根（只取其中 `/renderer/` 下的文件）。r12 扩进扫描范围：实测插件侧的硬编码
 *  比壳侧多得多——`project/stickers` 15 处、`sessions/ask` 整个插件**没有 languages 贡献**
 *  （13 处全硬编码）、`manager/tool-manager` 把中文写进了 `core/types.ts` 的**数据**里
 *  （组名/组说明/工具说明 11 处，德语界面因此显示「只读 / 只写」）。首版只扫壳侧，全看不见。 */
const PLUGIN_ROOT = "src/plugins";

const HAN = /[\u4e00-\u9fff]/;
/** 会呈现给用户的 JSX 属性。
 *  ⚠ 必须覆盖**表达式形态**（`title={cond ? "已复制" : "复制内容"}`），不能只认
 *  `attr="…"` / `attr={"…"}`：实测 stickers 有 3 处正是三元形态，首版判据全放过，
 *  直到在德语真机里看到「复制内容 / 删除」才发现。 */
const ATTR = /(?:title|aria-label|aria-description|placeholder|alt)\s*=\s*(?:"[^"]*[\u4e00-\u9fff][^"]*"|\{[^{}]*(?:"[^"]*[\u4e00-\u9fff][^"]*"|`[^`]*[\u4e00-\u9fff][^`]*`)[^{}]*\})/;
/** 单行 JSX 文本节点（不含表达式的形态，如 `>盲审<`）。 */
const JSX_TEXT = />[^<>{}\n]*[\u4e00-\u9fff][^<>{}\n]*</;

/** 去掉注释。
 *  ⚠ 行尾注释的判定不能用"`//` 前有两个空格"这种粗规则（实测漏掉
 *  `paddingLeft: isMac ? "88px" : "…", // mac 给红绿灯让位` 这类，于是把注释误报成违规）。
 *  正确判据：`//` 之前**未转义的引号数为偶数**时它才是注释起点（奇数说明它在字符串里，
 *  如 `"http://…"`）。块注释整体先摘掉。 */
function stripComments(src: string): string {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, "");
  return noBlock
    .split("\n")
    .map((line) => {
      if (/^\s*\/\//.test(line)) return "";
      const idx = line.indexOf("//");
      if (idx < 0) return line;
      const before = line.slice(0, idx);
      const quotes = (before.match(/(?<!\\)["'`]/g) ?? []).length;
      return quotes % 2 === 0 ? before : line;   // 偶数 = 在字符串外 = 真注释
    })
    .join("\n");
}

/** 正则字面量：`/…/flags`。⚠ 必须挖掉，否则会把**模式串**误判成文案——
 *  实例：`ask-question-card.tsx` 的 `/\s*(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)\s*$/i`
 *  是用来剥掉内核回传选项标签里「(推荐)」后缀的**匹配模式**，它必须同时认中英文两种写法
 *  （内核可能回传任一种），把它改成 i18n key 反而是错的。 */
const REGEX_LITERAL = /\/(?:\\.|[^/\\\n])+\/[gimsuy]*/g;

/** JSX 文本 = **花括号、引号与正则字面量之外**的中文。
 *  这条补的是 JSX_TEXT 的漏洞：`渲染错误: {String(err.message)}` 含表达式，
 *  `>[^<>{}]*中文[^<>{}]*<` 匹配不到（实测反向注入时通用判据没红，只有回归锚点红了）。
 *  做法是把 `{…}` 与各类引号串挖空，剩下的中文只可能是 JSX 文本。 */
function jsxTextOf(line: string): string {
  return line
    .replace(REGEX_LITERAL, "RX")
    .replace(/\{[^{}]*\}/g, "{}")
    .replace(/"[^"]*"/g, '""')
    .replace(/'[^']*'/g, "''")
    .replace(/`[^`]*`/g, "``");
}

/** 递归收集源码文件。`exts` 决定收哪些扩展名——⚠ 必须可配：
 *  首版写死只收 `.tsx`，于是"插件 core/ 数据形态"那条守卫扫到 **0 个文件**
 *  （core 下全是 `.ts`），断言恒真空转。是它自己那条"判据不空转"当场抓出来的。 */
function walk(dir: string, out: string[] = [], exts: string[] = [".tsx"]): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "dist" || name === "out" || name.startsWith(".")) continue;
      walk(full, out, exts);
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && exts.some((e) => name.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

describe("壳发布面 + 插件 renderer：用户可见位置不得硬编码中文（§7.1 铁律一）", () => {
  const files = [
    ...SHELL_DIRS.flatMap((d) => walk(join(ROOT, d))),
    // 插件侧只扫 renderer（core/ 里的中文数据由下面那条专门检查——它是另一种形态）
    ...walk(join(ROOT, PLUGIN_ROOT)).filter((f) => f.includes("/renderer/")),
  ];

  it("判据不空转：壳侧与插件侧都真的扫到了文件", () => {
    expect(files.length, "一个都没扫到 = 路径错了（假绿）").toBeGreaterThan(20);
    expect(files.some((f) => f.includes("manager/")), "应扫到共享 manager 组件").toBe(true);
    // 插件侧必须真的进了扫描集（首版只扫壳侧，插件里 20+ 处硬编码全都看不见）
    const pluginFiles = files.filter((f) => f.includes("/src/plugins/"));
    expect(pluginFiles.length, "插件 renderer 一个都没扫到 = walk 或过滤坏了").toBeGreaterThan(60);
  });

  it("没有硬编码中文的用户可见文案", () => {
    const problems: string[] = [];
    for (const f of files) {
      const code = stripComments(readFileSync(f, "utf-8"));
      code.split("\n").forEach((line, i) => {
        const attr = ATTR.exec(line);
        const jsx = JSX_TEXT.exec(line);
        const bare = HAN.test(jsxTextOf(line)) ? jsxTextOf(line).match(/[^\s]*[\u4e00-\u9fff][^\s]*/) : null;
        const hit = attr?.[0] ?? jsx?.[0] ?? bare?.[0];
        if (hit) problems.push(`${relative(ROOT, f)}:${i + 1}  ${hit.trim().slice(0, 88)}`);
      });
    }
    expect(
      problems,
      `${problems.length} 处用户可见的硬编码中文（应走 i18n key；token key 合规、token 值违规）：\n${problems.slice(0, 10).join("\n")}`,
    ).toEqual([]);
  });

  it("本轮修掉的三处保持干净（回归锚点：谁把它们改回去，这条会红）", () => {
    const read = (p: string): string => stripComments(readFileSync(join(ROOT, p), "utf-8"));
    // ① error-boundary 走 i18next.t + 英文 defaultValue（i18n 自身崩了也读得到）
    const eb = read("packages/react/src/error-boundary.tsx");
    expect(eb).toContain('i18next.t("shell.renderError"');
    expect(eb).toContain('defaultValue: "Render error"');
    expect(eb).not.toContain("渲染错误");
    // ② 分组兜底是 i18n key 而不是写死的「其他」
    const kcf = read("packages/react/src/manager/kernel-config-form.tsx");
    expect(kcf).toContain('const UNGROUPED_KEY = "settings.ungrouped"');
    expect(kcf).not.toMatch(/\?\?\s*"其他"/);
    // ③ model-config-page 的 devRole 控件走 k()，且措辞不再带内核专属名
    const mcp = read("packages/react/src/manager/model-config-page.tsx");
    expect(mcp).toContain('k("devRoleIncompatible")');
    expect(mcp).toContain('title={k("devRoleHint")}');
    expect(mcp).not.toContain("devRole 不兼容");
    expect(mcp).not.toContain("pi-ai");
  });

  it("为这三处补的译文在四个语言里都存在（缺一个就会有语言退回 defaultValue）", () => {
    const KEYS: [string, string][] = [
      ["system/i18n/shell.json", "shell.renderError"],
      ["system/i18n/settings.json", "settings.ungrouped"],
      ["kernels/pi/models.json", "models.devRoleIncompatible"],
      ["kernels/pi/models.json", "models.devRoleHint"],
      ["kernels/dsh/dsh.json", "dshModels.devRoleIncompatible"],
      ["kernels/dsh/dsh.json", "dshModels.devRoleHint"],
    ];
    const problems: string[] = [];
    for (const loc of ["zh-CN", "zh-TW", "en", "de"]) {
      for (const [rel, key] of KEYS) {
        // rel 形如 `system/i18n/shell.json` → `src/plugins/system/i18n/locales/<loc>/shell.json`。
        // ⚠ 不能用 rel.replace("/", …)：那只替换**第一个**斜杠，多级插件目录会拼错
        //   （实测拼成 system/locales/zh-CN/i18n/shell.json）。要在最后一段之前插入。
        const segs = rel.split("/");
        const file = segs.pop() as string;
        const p = join(ROOT, "src/plugins", ...segs, "locales", loc, file);
        let j: Record<string, unknown> = {};
        try { j = JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>; } catch { problems.push(`${loc}: 读不到 ${p}`); continue; }
        if (typeof j[key] !== "string" || !(j[key] as string).length) problems.push(`${loc}: ${rel} 缺 ${key}`);
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });
});

describe("aria-label 不得是**机器标识符**（slug 形态）", () => {
  // 判据：`aria-label="<字面量>"` 且该字面量是 kebab/snake 形态的纯 ASCII 标识符
  // （含 `-` 或 `_`、无空格、全小写）→ 那是给代码用的锚点，不是给人读的可访问名。
  // 为什么单立一条：`aria-label` 会**覆盖**元素内容作为可访问名，塞一个 slug 进去
  // 等于让屏幕阅读器念出 "message-meta" 这种对用户毫无意义的串，同时**丢掉**真正的内容。
  // 实测抓到 1 处（`sessions/timeline/renderer/MessageMeta.tsx`，唯一用途是给单测当锚点），
  // 已改成 `data-message-meta`——锚点归 data-*，可访问名归内容。
  //
  // ⚠ 这条也补上了本文件的一个盲区：上面几条判据找的是**中文**硬编码，
  //   而 §7.1 的判据是"用户可见文案有没有走 i18n"，**英文硬编码同样违规**
  //   （同轮抓到的 `aria-label="remove"` 就是英文，躲过了只找 CJK 的判据）。
  const SLUG_LABEL = /\baria-label\s*=\s*"([a-z0-9]+[-_][a-z0-9-_]*)"/;
  const files = [
    ...SHELL_DIRS.flatMap((d) => walk(join(ROOT, d))),
    ...walk(join(ROOT, PLUGIN_ROOT)).filter((f) => f.includes("/renderer/")),
  ];

  it("判据不空转：确实扫到了文件", () => {
    expect(files.length).toBeGreaterThan(60);
  });

  it("没有把 slug 当可访问名（应改用 data-* 锚点，或给出真译文）", () => {
    const problems: string[] = [];
    for (const f of files) {
      stripComments(readFileSync(f, "utf-8")).split("\n").forEach((line, i) => {
        const m = SLUG_LABEL.exec(line);
        if (m) problems.push(`${relative(ROOT, f)}:${i + 1}  aria-label="${m[1]}"`);
      });
    }
    expect(problems, `${problems.length} 处把机器标识符当成了可访问名：\n${problems.slice(0, 8).join("\n")}`).toEqual([]);
  });
});

describe("插件 core/ 的数据结构里不得嵌中文展示文案", () => {
  // 这是**另一种形态**，renderer 扫描覆盖不到：`manager/tool-manager/core/types.ts` 曾把
  // 组名/组说明/工具说明直接写成中文字面量（`name: "只读"`、`description: "执行 shell 命令"`），
  // 于是德语界面显示「只读 / 只写」——数据里嵌了展示文案。
  // 修法是加 `nameKey`/`descriptionKey`（有 key 用 key、没有就用字面值，用户改名后清 key），
  // 因为 `name` 同时是**可改的用户数据**与**内置预设的默认文案**，两个身份都得留位置。
  //
  // 判据只认 `name:` / `description:` / `title:` / `label:` 这几个**展示字段名**，
  // 不扫全部字符串（core 里大量中文是注释、日志、错误消息，那些不属本条铁律）。
  const FIELD = /\b(?:name|description|title|label):\s*"([^"]*[\u4e00-\u9fff][^"]*)"/;
  const files = walk(join(ROOT, "src/plugins"), [], [".ts"])
    .filter((f) => f.includes("/core/"));

  it("判据不空转：确实扫到了插件 core 文件", () => {
    expect(files.length, "一个都没扫到 = 路径错了（假绿）").toBeGreaterThan(10);
  });

  it("展示字段里的中文字面量必须有配套的 <field>Key（否则任何语言都显示中文）", () => {
    // ⚠ 判据不能是"有中文就违规"：修好之后中文字面量**仍然在**，它是
    //   `t(nameKey, { defaultValue: name })` 的兜底值，同时也是**用户可改的数据**
    //   （重命名写回 `name`）——两个身份都要留位置。真正的违规是"有中文展示值、却没有 key"。
    //   判定用邻近窗口（±4 行）找 `<field>Key:`：这些对象字面量都是一行一个字段写的，
    //   key 与 value 相邻。**局限**：若有人把 key 写到 4 行之外，会误报——那反而促使
    //   key 与 value 放在一起，是可接受的约束。
    const problems: string[] = [];
    for (const f of files) {
      const lines = stripComments(readFileSync(f, "utf-8")).split("\n");
      lines.forEach((line, i) => {
        const m = FIELD.exec(line);
        if (!m) return;
        const field = m[0].split(":")[0].trim();
        const window = lines.slice(Math.max(0, i - 4), i + 5).join("\n");
        if (new RegExp(`${field}Key\\s*:`).test(window)) return;   // 有配套 key → 合法
        problems.push(`${relative(ROOT, f)}:${i + 1}  ${m[0].slice(0, 66)}（缺 ${field}Key）`);
      });
    }
    expect(problems, `${problems.length} 处数据里嵌了中文展示文案且无 i18n key：\n${problems.slice(0, 8).join("\n")}`).toEqual([]);
  });
});

// 仍未覆盖（明确标注，别让它看起来像已覆盖）：
//   · 跨行 JSX 文本；
//   · 先赋值给变量/常量再流入 UI 的字符串（如曾经的 `f.group ?? "其他"`）——靠回归锚点那条兜；
//   · `console.*` / `throw new Error` 里的中文（开发者可见，不属 §7.1 铁律一的对象）。

// ── 硬编码**英文**（r42 补）──────────────────────────────────────────────────
//
// 为什么原来那条守卫抓不到：它的三个探测器（ATTR / JSX_TEXT / CJK-in-braces）都以
// `[\u4e00-\u9fff]` 为判据 —— 只认中文。于是 `running` / `error` / `lines collapsed` /
// `exit {code}` / `unknown error` / `File system access is not available` 这类**硬编码英文**
// 全部从旁边溜过去，而这是个**四语言**产品：de / zh-CN / zh-TW 用户同样会看到英文。
//
// 实测最糟的形态不是"整句英文"，而是**一句话里两种语言**：file-preview 把
// `throw new Error("File system access is not available")` 的消息经 `setError(err.message)`
// 存下、再按 `${t("preview.loadFailed")}: ${error}` 显示 ⇒ 用户看到
// 「加载失败: File system access is not available」。前缀翻译了、原因没翻译，
// 这种混合串比纯英文更难被发现（因为"看起来已经 i18n 了"）。
//
// 判据（刻意收紧，避免专有名词/代码样本造成大片假阳性）：
//   字符串字面量的内容**整体**形如「2 个以上纯英文单词、单个空格分隔、无任何标点/符号」，
//   且不在明显的代码上下文里（className / import / 比较 / 对象键 / 选择器 / t() 参数等）。
//   合法的少数（如 rel 属性值 `noopener noreferrer`）走 EXEMPT_EN 账本，逐条给理由。
const EN_SENTENCE = /^[A-Za-z]+(?: [A-Za-z]+)+$/;
const STR_LIT = /(["'`])((?:[^"'`\\\n]|\\.){2,90})\1/g;
const CTX_SKIP = /(className|class=|style=|data-[\w-]+=|aria-[\w-]+=|key=|id=|href=|rel=|import |from |require\(|querySelector|\.test\(|\.replace\(|\.split\(|\.join\(|\.includes\(|startsWith|endsWith|===|!==|:\s*$|\bt\(|defaultValue| i18n)/;
/** 合法英文串账本（逐条理由；新增必须解释，不能靠放宽判据）。 */
const EXEMPT_EN: { value: string; why: string }[] = [
  { value: "noopener noreferrer", why: "`<a rel>` 的**规范关键字**，不是文案（浏览器按字面匹配，翻译即失效）" },
  { value: "My Harness Desktop", why: "产品名（标题栏），专名各语言同形" },
  { value: "fs unavailable", why: "blind-review 里的**内部流程信号**：抛出后立刻被 `catch {}` 丢弃、改用 `t(\"review.readFileFailed\")` 显示，字符串本身从不进 UI" },
];

function enHits(): { file: string; line: number; value: string; text: string }[] {
  const out: { file: string; line: number; value: string; text: string }[] = [];
  const roots = [...SHELL_DIRS.map((d) => join(ROOT, d)), join(ROOT, PLUGIN_ROOT)];
  for (const root of roots) {
    for (const f of walk(root, [], [".tsx", ".ts"])) {
      const rel = relative(ROOT, f);
      // 只扫 renderer 侧与壳前端：client/core/server 侧的英文多是内部错误与日志，
      // 不经 UI 呈现（真要呈现会在 renderer 侧被 t() 包一层）。
      if (rel.startsWith("src/plugins/") && !rel.includes("/renderer/")) continue;
      const lines = stripComments(readFileSync(f, "utf-8")).split("\n");
      lines.forEach((l, idx) => {
        const st = l.trim();
        if (!st || st.startsWith("*")) return;
        for (const m of l.matchAll(STR_LIT)) {
          const v = m[2];
          if (!EN_SENTENCE.test(v)) continue;
          if (EXEMPT_EN.some((e) => e.value === v)) continue;
          const before = l.slice(Math.max(0, m.index - 44), m.index);
          if (CTX_SKIP.test(before)) continue;
          // CSS 声明上下文整行跳过：`src/web/login-gate.ts` 是 React 之前的登录闸，
          // 内联 style 模板串里的 `font-family:-apple-system,…,'Segoe UI',…,'PingFang SC'`
          // 会被当成"两个英文单词的文案"。字体名不是文案（且翻译即失效），
          // 用**行级**判据跳过比把每个字体名塞进账本更稳（新增字体不必改守卫）。
          if (/font-family|style\s*=|^[\w-]+\s*:\s*[^;]*;/.test(l)) continue;
          out.push({ file: rel, line: idx + 1, value: v, text: st.slice(0, 88) });
        }
      });
    }
  }
  return out;
}

describe("壳发布面 + 插件 renderer：用户可见位置不得硬编码**英文**（四语言产品，r42）", () => {
  const hits = enHits();

  it("判据不空转：探测器能抓到本轮修掉的那几种形态", () => {
    // 自检样本必须是**真实出现过**的形态，否则判据可能只对合成样本有效。
    for (const sample of ["lines collapsed", "unknown error", "File system access is not available", "No content returned"]) {
      expect(EN_SENTENCE.test(sample), `自检失败：判据抓不到 ${JSON.stringify(sample)}`).toBe(true);
    }
    // 反向自检：这些**不该**被抓（否则会产出大片假阳性，守卫就会被绕过）
    for (const notSample of ["flex items-center gap-2", "settings.unknownError", "~/.pi/agent/models.json", "text-[length:var(--font-size-sm)]", "const sessions = await"]) {
      expect(EN_SENTENCE.test(notSample), `自检失败：${JSON.stringify(notSample)} 被误判成文案`).toBe(false);
    }
    expect(EXEMPT_EN.length, "账本不该为空也不该太长（太长说明判据太松）").toBeLessThanOrEqual(8);
  });

  it("① 没有硬编码的英文用户可见文案（新增即违规；专名/规范关键字走账本并写理由）", () => {
    const lines = hits.map((h) => `${h.file}:${h.line}  ${JSON.stringify(h.value)}\n        ${h.text}`);
    expect(hits, `硬编码英文 ${hits.length} 处：\n      ` + lines.join("\n      ")).toEqual([]);
  });

  it("⑤ 回归锚：JSX **文本节点**里的单词级英文（引号判据抓不到的那一类）", () => {
    // ⚠ 这条是 ④ 的补充，而且必须分开写：④ 的探针查的是**带引号的字面量**
    //   （`"unknown error"` 这种），而 r51 修掉的 `truncated` 是 **JSX 文本节点**
    //   （`<div …>truncated</div>`，不带引号）——用 ④ 的形态去钉它会得到一条
    //   **永远绿的假锚**（首版就是这么写的，自己复核时才发现：回潮成 `>truncated<`
    //   它照样通过）。所以判据要按缺陷的真实形态写。
    //
    // 单词级英文本身是 r42 英文判据的**已知盲区**（那条刻意要求 2+ 词，
    // 以避免专名/类名/CSS 值造成大片假阳性），所以这类只能靠回归锚逐个钉。
    const probes: [string, RegExp, string][] = [
      ["src/plugins/sessions/message-blocks/renderer/tool-cards.tsx", />\s*truncated\s*</,
        "输出截断提示又变回硬编码英文 `truncated`（应走 t(\"timeline.outputTruncated\")；宿主是 CollapsibleOutput）"],
    ];
    const back: string[] = [];
    for (const [rel, rx, why] of probes) {
      const src = stripComments(readFileSync(join(ROOT, rel), "utf-8"));
      if (rx.test(src)) back.push(`${rel}: ${why}`);
    }
    expect(back, back.join("\n      ")).toEqual([]);
    // 自检：判据必须能认出**缺陷形态**本身，否则它就是一条恒绿的装饰
    expect(probes[0][1].test("<div>truncated</div>"), "自检失败：判据认不出 >truncated< 这个缺陷形态").toBe(true);
    expect(probes[0][1].test('{t("timeline.outputTruncated")}'), "自检失败：判据会把已修好的形态误判成缺陷").toBe(false);
  });

  it("② 账本没有腐烂：每条豁免都必须仍能在源码里找到（改好了就删）", () => {
    const all = new Set<string>();
    const roots = [...SHELL_DIRS.map((d) => join(ROOT, d)), join(ROOT, PLUGIN_ROOT)];
    for (const root of roots) {
      for (const f of walk(root, [], [".tsx", ".ts"])) {
        const src = readFileSync(f, "utf-8");
        for (const e of EXEMPT_EN) if (src.includes(e.value)) all.add(e.value);
      }
    }
    const stale = EXEMPT_EN.filter((e) => !all.has(e.value)).map((e) => e.value);
    expect(stale, `账本里有 ${stale.length} 条已不存在：${stale.join(", ")}（从 EXEMPT_EN 删除）`).toEqual([]);
  });

  it("③ 每条豁免都带理由", () => {
    for (const e of EXEMPT_EN) {
      expect(typeof e.why === "string" && e.why.length >= 10, `${JSON.stringify(e.value)} 的理由太短`).toBe(true);
    }
  });

  it("④ 回归锚：r42 修掉的几处不得回潮", () => {
    // ⚠ 回归保护写在**这里**，不是写进 EXEMPT_EN：账本的语义是"当前存在且合法的豁免"，
    //   把已修好的条目留在账本里会被 ② 的腐烂检查抓到（r42 实踩：我想拿账本条目当
    //   "若它再出现就说明回退了"的对照，但账本条目的存在本身就意味着源码里还有这个串）。
    const probes: [string, string][] = [
      ["src/plugins/sessions/message-blocks/renderer/tool-cards.tsx", "lines collapsed"],
      ["packages/react/src/manager/model-config-page.tsx", "unknown error"],
      ["src/plugins/project/file-preview/renderer/index.tsx", "File system access is not available"],
      ["src/plugins/project/file-preview/renderer/index.tsx", "No content returned"],
      ["src/web/transport/ws-transport.ts", "remote error"],
      ["src/web/kernel/build-kernel.ts", "安装超时"],
    ];
    const back: string[] = [];
    for (const [rel, needle] of probes) {
      // 判**代码**不判原文：修复说明的注释里常会引用旧字面量（否则守卫被自己的注释绊倒）
      const src = stripComments(readFileSync(join(ROOT, rel), "utf-8"));
      if (src.includes(`"${needle}"`) || src.includes(`'${needle}'`)) back.push(`${rel} 又出现 ${JSON.stringify(needle)}`);
    }
    expect(back, back.join("\n      ")).toEqual([]);
  });
});

// ── 壳侧 `.ts`（非组件）里的硬编码文案：按「必然被显示的汇点」判（r42）──────────────
//
// 为什么原来的中文守卫漏了这一整片：它的 `walk()` 默认 exts 是 `[".tsx"]`，
// 所以 `src/web` 与 `packages/react/src` 里的 **`.ts` 文件从不被扫**。实测那一片有
// 34 处中文字符串，其中确有用户可见的（`build-kernel.ts` 的安装超时 error、
// `bootstrap.ts` 的断连浮层 textContent、`login-gate.ts` 的整个登录闸文案）。
//
// ⚠ 但**不能**简单把 exts 放宽到 `.ts` 就完事：那 34 处里大多数是**开发者可见的不变量违规**
//   （`throw new Error("setLayout 的树根必须…")`、`warnOnce("装配顺序被破坏")`），
//   它们只进 console / 只给开发者看，翻译它们反而有害（报错原文是排查线索）。
//   而且"是不是 throw 出来的"**不能**当判据 —— 本轮修的 file-preview 那两处正是
//   `throw new Error(...)`，却被 `setError(err.message)` 存下、按 `${t(前缀)}: ${error}` 显示给用户。
//
// 所以判据换成**静态可判的"必然被显示"汇点**：
//   `.textContent =` / `.innerText =`（直接写进 DOM 文本）、
//   对象字面量的 `error:` 字段（本仓的 API 结果形状，UI 会渲染它）。
// 这三类一旦出现中文/英文字面量就是缺陷；其余（throw / warn / console）不在本判据内。
const DISPLAY_SINK = /(?:\.(?:textContent|innerText)\s*=|(?:^|[,{\s])error\s*:)/;
/** 合法豁免：i18n **尚未加载**的前置闸门（登录闸 / 断连浮层），只能自带文案。 */
const EXEMPT_SINK: { file: string; why: string }[] = [
  { file: "src/web/login-gate.ts",
    why: "远程访问的**登录闸**在 React 与 i18n 之前就要渲染（拿不到 t），所以文案自带且刻意做成中英双语；它只服务于局域网鉴权这一个场景" },
  { file: "src/web/bootstrap.ts",
    why: "**断连浮层**恰恰是在 renderer 与服务端断开时出现——那时 i18n 资源可能根本拉不到，只能自带文案（同样刻意双语）" },
];

describe("壳侧 .ts（非组件）：写进「必然被显示的汇点」的文案不得硬编码", () => {
  const files = SHELL_DIRS.flatMap((d) => walk(join(ROOT, d), [], [".ts"]));
  const hits: { file: string; line: number; text: string }[] = [];
  for (const f of files) {
    const rel = relative(ROOT, f);
    if (EXEMPT_SINK.some((e) => rel === e.file)) continue;
    const lines = stripComments(readFileSync(f, "utf-8")).split("\n");
    lines.forEach((l, i) => {
      if (!DISPLAY_SINK.test(l)) return;
      if (/console\.(log|warn|error|info)/.test(l)) return;
      if (HAN.test(l) || EN_SENTENCE.test((l.match(STR_LIT)?.[2] ?? ""))) {
        hits.push({ file: rel, line: i + 1, text: l.trim().slice(0, 96) });
      }
    });
  }

  it("判据不空转：确实扫到了 .ts 文件，且能抓到本轮修掉的那一处", () => {
    expect(files.length, "一个 .ts 都没扫到 = exts 传错了（这正是原守卫的盲区成因）").toBeGreaterThan(20);
    // 自检：三种汇点形态都要能识别
    expect(DISPLAY_SINK.test('msg.textContent = "x";'), "textContent 汇点识别失效").toBe(true);
    expect(DISPLAY_SINK.test("el.innerText = x;"), "innerText 汇点识别失效").toBe(true);
    expect(DISPLAY_SINK.test('resolve({ ok: false, error: "x" });'), "error 字段汇点识别失效").toBe(true);
    // 反向：throw / warn 不算汇点（否则会把开发者可见的不变量违规也判成缺陷）
    expect(DISPLAY_SINK.test('throw new Error("x");'), "throw 不该被当成显示汇点").toBe(false);
    expect(DISPLAY_SINK.test('warnOnce("k", "x");'), "warn 不该被当成显示汇点").toBe(false);
  });

  it("① 汇点上的文案不得硬编码（要么走 i18n，要么在豁免清单里写明为什么不能）", () => {
    expect(hits.map((h) => `${h.file}:${h.line}\n        ${h.text}`),
      `汇点上硬编码文案 ${hits.length} 处：\n      ` + hits.map((h) => `${h.file}:${h.line} ${h.text}`).join("\n      ")).toEqual([]);
  });

  it("② 豁免清单里的文件必须仍然存在且仍含硬编码文案（否则豁免已无必要，应删）", () => {
    for (const e of EXEMPT_SINK) {
      const abs = join(ROOT, e.file);
      expect(existsSync(abs), `豁免清单里的 ${e.file} 已不存在 → 删掉这条豁免`).toBe(true);
      const src = readFileSync(abs, "utf-8");
      expect(HAN.test(src), `${e.file} 里已经没有中文文案了 → 豁免可以删`).toBe(true);
      expect(e.why.length, `${e.file} 的豁免理由太短`).toBeGreaterThan(20);
    }
  });

  it("③ 回归锚：build-kernel 的安装超时不得再写死中文（r42 修的那处）", () => {
    // ⚠ 判**代码**而不是原文：修复说明的注释里会引用旧字面量（"此前写死中文 \"安装超时\""），
    //   按原文判会被自己的注释绊倒（首版就是这么红的）。
    const src = stripComments(readFileSync(join(ROOT, "src/web/kernel/build-kernel.ts"), "utf-8"));
    expect(src.includes('"安装超时"'), "安装超时的文案又写死中文了（应走 i18next.t 取 shell.installTimeout）").toBe(false);
    expect(src.includes("shell.installTimeout"), "应通过 i18n 键取文案").toBe(true);
  });
});

// ── 第四个探测器：renderer 里 **JS 表达式/字符串字面量**中的硬编码中文（r53）──────────
//
// 前三个探测器都覆盖不到这一类，机制上的原因很具体：
//   · `ATTR` 只认 title/aria-label/aria-description/placeholder/alt 五个属性；
//   · `JSX_TEXT` 只认 `>…中文…<` 这种**裸文本节点**；
//   · `bare` 走 `jsxTextOf(line)`，而那个函数会**把所有 `{…}` 块与所有字符串字面量先剥掉**
//     （它本来就是为了"只看裸文本"而设计的）⇒ 中文在判定之前就被抹掉了。
// 于是下面这些形态**全部漏网**（实测 43 处）：
//   `flash("已导出表情包 zip")`（toast 文案）、
//   `activateDisabledReason={streaming ? "等待当前回复完成" : …}`（传给组件去显示的 prop）、
//   `{copied ? "已复制" : "复制"}`（JSX 里但**在花括号内**，所以 JSX_TEXT 也匹配不到）、
//   `notify.show({ body: \`续跑发送失败…\` })`（系统通知正文）、
//   `const CONTINUE_PROMPT = "继续未完成的工作…"`（送进模型的正文）。
//
// ⚠ 修法不是"一次修完 43 处"（那要动 4 个语言包 × 数十个键，一轮做不完且容易改错），
//   而是**棘轮**：把当前数量钉成上限，只许减少不许增加。这与 r31–r33 清架构债
//   （4 → 3 → 2 → 1 → 0）是同一手法。每修一处就把上限调低一格——上限就成了进度条。
const CJK_LITERAL = /(["'`])((?:[^"'`\\\n]|\\.)*[\u4e00-\u9fff](?:[^"'`\\\n]|\\.)*)\1/;
/** 合法上下文：不是"给用户看的文案"，或已经走了 i18n。
 *  ⚠ 用 `new Error\(` 而不是 `throw new Error\(`：错误对象也常被**构造后交给别处**
 *    （实测 `reject(new Error("保存超时:main 进程无响应"))`），只认 throw 会漏掉这一形态。
 *  ⚠ 加 `warnOnce\(`：那是 r42 已定性的**开发者可见**不变量违规（装配序被破坏等），
 *    只进 console、不经 UI 呈现，翻译它反而有害（报错原文是排查线索）。 */
const CJK_OK_CTX = /(defaultValue|console\.(log|warn|error|info|debug)|new Error\(|warnOnce\(|\bt\(|i18nKey)/;
/** 债务上限（r53 首测：粗判据 56 → 收紧假阳性 37；r54 修 8 处 ⇒ 29；
 *  r55 `ChannelMeta` 改键 ⇒ 9；**r56 归零 ⇒ 0**）。
 *
 *  r56 把最后 9 处**按性质分别处置**（这是关键：它们不是同一类，用一种办法处理必错）：
 *   · **修掉 4 处**：`ws-transport` 的 2 条传输错误（经 failAll → reject 原因 → 浮到 UI，
 *     用 `i18next` 单例，同 r42 的 build-kernel）；`continue` 的续跑文案（它是经
 *     `messaging.prompt()` **发出去的用户消息**、会出现在用户气泡里 ⇒ 属"用户说的话"）；
 *     `goal` 的斜杠命令说明（契约字段 `ComposerCommand.description` → `descriptionKey`，
 *     与 r55 的 `ChannelMeta.labelKey` 同批同理）。
 *   · **豁免 5 处**（逐条写进 `CJK_EXPR_EXEMPT` 并给理由 + 腐烂检查）：
 *     4× `session-store` 的工具白名单注入（发往内核的**协议指令**，渲染层 `startsWith` 剥除、
 *     用户不可见；本地化会让**历史消息**剥不掉而露出协议原文）；
 *     1× `stt-engine` 的 `"中文"`（语言选择器的 **endonym**，各语言用自己的文字书写自身，
 *     译名反而让用户找不到自己的语言）。
 *
 *  ⚠ 上限归零之后，这条判据就从"棘轮"变成了**硬门禁**：任何新增的 JS 表达式硬编码中文
 *  都会当场红。要新增合法形态时，走 `CJK_EXPR_EXEMPT` 并写理由（会被腐烂检查盯着），
 *  **不要调高上限**。
 *  ⚠ 只许调低，不许调高；调低时在提交说明里写清修了哪几处、补了哪些语言的键。
 *  收紧过程本身也是产出：56 → 40（登录闸文件级豁免 + 跨行 `throw` 的上下文回看）
 *  → 37（`new Error(` 与 `warnOnce(` 两种形态）。**先收敛判据再钉上限**，
 *  否则上限里混着假阳性，将来"减少债务"就分不清是真修了还是判据漂了。 */
const CJK_EXPR_DEBT_CEILING = 0;

/** 合法豁免（逐条给理由 + 腐烂检查）。两类都不是"忘了修"，而是**修了会出错**或**本就不该译**。 */
const CJK_EXPR_EXEMPT: { file: string; value: string; why: string }[] = [
  // ── ① 发往内核的**协议注入**，不是 UI 文案（4 处，同一组）──
  // 依据就在源码注释里（session-store.ts:137-138）：「注入文本是发往内核的协议指令
  // （渲染层经 stripToolLimitNote 剥除，用户气泡不可见），非 UI 文案——演进：内核提供
  // 工具白名单 RPC 后整体移除（**勿 i18n，勿当界面文案改**）」。
  // ⚠ 还有一条比"偏好"更硬的理由：`stripToolLimitNote` 用 `text.startsWith(TOOL_LIMIT_PREFIX)`
  //   剥除。若前缀被本地化，**此前已发送并落盘的消息**（带旧语言前缀）就不再被剥除，
  //   老会话的用户气泡里会突然露出协议原文。所以本地化它会造成真实回归。
  { file: "src/web/stores/session-store.ts", value: "[System] 本次会话已限制可用工具。",
    why: "发往内核的协议指令前缀；渲染层 startsWith 剥除、用户不可见；本地化会让历史消息剥不掉" },
  { file: "src/web/stores/session-store.ts", value: "无",
    why: "同上（工具白名单为空时的显式语义，属协议正文）" },
  { file: "src/web/stores/session-store.ts", value: "\\n可用工具: ",
    why: "同上：协议正文里的字段名，与前后两句一起构成发给内核的工具白名单指令" },
  { file: "src/web/stores/session-store.ts", value: "\\n请勿使用未在列表中的工具。",
    why: "同上（协议正文的约束句，是给模型读的不是给人读的）" },
  // ── ② 语言选择器里的 **endonym**（各语言用自己的文字书写自身）──
  // 「中文 / English / Deutsch」是标准 UX 惯例：让用户无论界面是什么语言都能找到自己的语言。
  // 把 "中文" 译成 "Chinese"（在中文界面）或 "Chinesisch"（在德语界面）反而**降低**可用性。
  { file: "src/plugins/sessions/voice-input/renderer/stt-engine.ts", value: "中文",
    why: "转写语言选择器的 endonym（同列的 English / Deutsch 同理）；译名反而让用户找不到自己的语言" },
];

function cjkExprHits(): { file: string; line: number; value: string; text: string }[] {
  const out: { file: string; line: number; value: string; text: string }[] = [];
  const roots = [
    ...SHELL_DIRS.map((d) => join(ROOT, d)),
    join(ROOT, PLUGIN_ROOT),
  ];
  for (const root of roots) {
    for (const f of walk(root, [], [".tsx", ".ts"])) {
      const rel = relative(ROOT, f);
      // 只扫**会呈现给用户**的那一层：壳前端 + 发布面 + 插件 renderer。
      // 插件的 core/ 与 client/ 里的中文另有判据（见上一条 describe）。
      if (rel.startsWith("src/plugins/") && !rel.includes("/renderer/")) continue;
      // 登录闸豁免：与本文件「显示汇点」那条守卫同一份理由——它在 React 与 i18n
      // **之前**就要渲染（拿不到 t），文案自带且刻意做成中英双语。
      if (EXEMPT_SINK.some((e) => rel === e.file)) continue;
      const lines = stripComments(readFileSync(f, "utf-8")).split("\n");
      lines.forEach((l, i) => {
        const st = l.trim();
        if (!st || st.startsWith("*")) return;
        // ⚠ 上下文要**回看几行**，不能只看当前行：`throw new Error(` 与它的消息常跨行写
        //   （实测 `src/web/app/plugins-host.ts:9-11` 就是这么写的），只看当前行会把
        //   开发者可见的错误消息误算成用户文案债务。回看 3 行覆盖常见的跨行调用形态。
        const ctx = lines.slice(Math.max(0, i - 3), i + 1).join("\n");
        if (CJK_OK_CTX.test(ctx)) return;
        if (JSX_TEXT.test(l)) return;      // 裸文本节点由既有探测器负责，不重复计
        // ⚠ 用 matchAll 而不是 exec：一行里可以有**多个**中文字面量
        //   （实测 `flash(path ? "已导出表情包 zip" : "已取消")`、
        //   `{sticker.layer === "project" ? "设为全局" : "移到项目"}`）。
        //   首版只取每行第一个匹配 ⇒ 债务数**低报**（r53 首测的 37 就偏小），
        //   而低报的棘轮更危险：修掉一处后总数可能不变（因为同行的另一处此前没被计入），
        //   看起来"没进度"，或者反过来新增一处也看不出来。
        for (const m of l.matchAll(new RegExp(CJK_LITERAL.source, "g"))) {
          if (CJK_EXPR_EXEMPT.some((e) => e.file === rel && m[2].startsWith(e.value))) continue;
          out.push({ file: rel, line: i + 1, value: m[2].slice(0, 44), text: st.slice(0, 92) });
        }
      });
    }
  }
  return out;
}

describe("renderer 里 JS 表达式中的硬编码中文：债务棘轮（只许减少）", () => {
  const hits = cjkExprHits();

  it("判据不空转：探测器能抓到已知形态，且不会把合法上下文算进来", () => {
    // 正向：四种真实出现过的形态都要能抓到
    for (const sample of [
      'flash("已导出表情包 zip");',
      'activateDisabledReason={streaming ? "等待当前回复完成" : null}',
      '{copied ? "已复制" : "复制"}',
      'const CONTINUE_PROMPT = "继续未完成的工作";',
    ]) {
      expect(CJK_LITERAL.test(sample) && !CJK_OK_CTX.test(sample), `判据抓不到 ${sample.slice(0, 44)}`).toBe(true);
    }
    // 反向：这些**不该**算债务（否则棘轮会被假阳性撑大，最终被人调高上限绕过）
    for (const ok of [
      't("stickers.copied", { defaultValue: "已复制" })',
      'console.warn("装配顺序被破坏")',
      'throw new Error("未注册的会话槽")',
      // r53 收紧判据时补的两种形态（此前会被误算成债务）：
      'setTimeout(() => reject(new Error("保存超时:main 进程无响应")), 10000),',
      'warnOnce("resolver", "装配顺序被破坏?按「无激活会话」处理");',
      '// 中文注释不算',
    ]) {
      expect(CJK_OK_CTX.test(ok) || ok.trim().startsWith("//"), `${ok.slice(0, 40)} 被误判成债务`).toBe(true);
    }
  });

  it(`① 债务数不得超过上限（当前上限 ${CJK_EXPR_DEBT_CEILING}；只许调低）`, () => {
    const byFile = new Map<string, number>();
    for (const h of hits) byFile.set(h.file, (byFile.get(h.file) ?? 0) + 1);
    const summary = [...byFile.entries()].sort((a, b) => b[1] - a[1]).map(([f, n]) => `${n}× ${f}`);
    expect(hits.length, [
      `JS 表达式里的硬编码中文共 ${hits.length} 处（上限 ${CJK_EXPR_DEBT_CEILING}）。`,
      `按文件：${summary.slice(0, 12).join("；")}`,
      `前若干处：`,
      ...hits.slice(0, 8).map((h) => `      ${h.file}:${h.line}  ${JSON.stringify(h.value)}  |  ${h.text}`),
      `→ 每修一处（改走 i18n 键 + 补四语言译文）就把 CJK_EXPR_DEBT_CEILING 调低一格；`,
      `  这条上限**只能降不能升**（升了就是把新债合法化）。`,
    ].join("\n")).toBeLessThanOrEqual(CJK_EXPR_DEBT_CEILING);
  });

  it("② r53 修掉的那处不得回潮（goal-card 的「目标达成」）", () => {
    const src = stripComments(readFileSync(join(ROOT, "src/plugins/sessions/goal/renderer/goal-card.tsx"), "utf-8"));
    expect(src.includes('"目标达成"'), "goal-card 又写死了「目标达成」（应走 i18n 键）").toBe(false);
  });

  it("③ 豁免清单没有腐烂：每条都仍能在源码里找到（修好了就删，否则清单越长越假）", () => {
    const stale: string[] = [];
    for (const e of CJK_EXPR_EXEMPT) {
      const abs = join(ROOT, e.file);
      if (!existsSync(abs)) { stale.push(`${e.file} 已不存在`); continue; }
      const src = stripComments(readFileSync(abs, "utf-8"));
      if (!src.includes(e.value)) stale.push(`${e.file} 里已找不到 ${JSON.stringify(e.value)}`);
      expect(e.why.length, `${JSON.stringify(e.value)} 的理由太短`).toBeGreaterThan(12);
    }
    expect(stale, `豁免已失效 ${stale.length} 条（应从 CJK_EXPR_EXEMPT 删除）：\n      ${stale.join("\n      ")}`).toEqual([]);
  });
});
