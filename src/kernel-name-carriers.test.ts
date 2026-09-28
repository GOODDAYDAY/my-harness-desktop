// 内核名泄漏的**多载体**守卫：通用层里不许出现 pi / dsh / minimal 的身份字样。
//
// ## 为什么要有这一条（而不是靠已有的依赖审计）
//
// `scripts/dependency-audit.mjs` 的十三检验扫的是 **TS 源码里的标识符与 import**
// （⑤ 壳机制层的内核名字面量、⑥ 身份硬分支、⑫ `Pi*`/`Dsh*` 类型名、⑬ 字面量键访问内核的面）。
// 但内核身份还能以**别的载体**存在，那些载体一个都不在它的扫描范围里。r27–r31 逐轮实测，
// 每种载体都真的藏过缺陷：
//
// | 载体 | 实测缺陷 | 处置 |
// |---|---|---|
// | prompt / 线格式文本 | 通用插件 `sessions/review` 的评论块标签是 `<pi-review>`，而它是**拼进 prompt 发给当前内核**的 —— dsh/minimal 会话也收到以 pi 命名的标签 | r27 改中性 `<review>` + 解析方向后兼容 |
// | CSS 类名 | `.pi-collapsible` 定义在 `src/web/index.css`（**壳机制层**），被发布面 `packages/react` 的 Section 与两个通用插件共用；另有 `.pi-composer-command-chip` | r28 改名 `.shell-*`（12 处） |
// | locale 值 / manifest 标签 | minimal 内核插件的语言包整体抄自 dsh（标题写着 "DSH 模型配置"、教用户把密钥写进 `~/.dsh/.credentials.yaml`） | r29 修 + `locale-kernel-identity.test.ts` |
// | 字面量键访问 | `ctx.kernelConfig["pi"].get()`（检验⑬ 首版只扫 `kernels` 一个名字，从旁边溜了） | r28 扩宽判据到整个面族 |
// | 存储键 / prefs 键 | **0 处**（20 个键全中性：`bookmarkOrder`/`customOrder`/`pins`/`recentCwds`…） | r31 扫过，本守卫钉住 |
// | 用户可见错误文本 | **0 处** | r31 扫过，本守卫钉住 |
// | 日志前缀 | **0 处** | r31 扫过，本守卫钉住 |
//
// 后三行是**有界的负结果**：干净不等于永远干净。r27–r31 我连续三轮用临时脚本手工扫同样的载体，
// 按 §3.7「根因修复的闭环是留下守卫」，这里把它固化——否则下一轮又得手扫一遍，
// 而且临时脚本用完就扔，判据（词边界、注释剥离、豁免清单）每次都重新发明一次、每次都踩一遍坑。
//
// ## 判据的三个要点（每个都是踩过坑换来的）
//
// 1. **词边界**：`pi` 是极短的 token，子串匹配会命中 "sticker-**pi**cker"、"**pi**ns"、"**pi**ng"、
//    "sessionGrou**pi**ngs"（r29 实测 14 处全是这类误报）。前后都不得是字母数字。
// 2. **按文件剥离注释后再判**：只看行首 `//` `*` `/*` 会漏掉**块注释的中间行**——
//    r28 因此把 `kernel-config-form.tsx` 里一句提到旧写法的说明判成违规；
//    r31 又被同款坑了一次（`font-tab.tsx` 里我自己写的 JSX 注释中间行提到 `pi.sessions.list`）。
// 3. **豁免要精确到 (文件, 字面量) 并带理由**：`minimal` 是**同形异义词**——
//    它既是内核 id，又是思考档位名（off/minimal/low/medium/high/xhigh），又是视觉风格预设名
//    （与 default/card/outline/glass 并列）。这三者不能靠正则区分，只能登记。

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

/** 内核 id。⚠ 与圆心 `KERNEL_IDS` 对齐；下面有一条自检核对这个假设。 */
const IDS = ["pi", "dsh", "minimal"];
// ⚠ 边界规则：**只要前后不是字母或数字就算边界**——标点、引号、连字符、点、下划线都是分隔符。
//   首版把 `- . / _` 也算进"不是边界"，结果 `.dsh-legacy-panel`（前面是 `.`）与
//   `piLayout`（后面是字母）都匹配不到 —— 反向注入 CSS 类名与存储键时守卫**全绿**（假绿），
//   而 CSS 类名恰恰是 r28 抓到过真实缺陷（`.pi-collapsible`）的那个载体。
//   收窄到"字母数字"仍然不会误报 `picker`/`pins`/`ping`/`sessionGroupings`
//   （它们的 `pi` 后接字母），也不会误报 `api`（前接字母）。
// 形态一：**独立词**（前后都不是字母数字）。标点/引号/连字符/点/下划线都算边界，
//   所以 `kernels["pi"]`、`.dsh-legacy-panel`、`<pi-review>` 都命中；
//   而 `picker`/`pins`/`ping`/`sessionGroupings`/`api`/`pixel` 不会（pi 前后接字母）。
const BOUND = new RegExp(`(?<![A-Za-z0-9])(${IDS.join("|")})(?![A-Za-z0-9])`, "i");
// 形态二：**复合名的前缀**（内核名后紧跟大写字母、`_` 或 `-`），如 `piLayout` / `dshManager` /
//   `pi_collapsible`。形态一抓不到它（后面是字母）。这条是反向注入 `config.set("piLayout")`
//   时暴露出来的缺口——存储键最容易写成这种驼峰前缀形态。
const PREFIX = new RegExp(`(?<![A-Za-z0-9])(${IDS.join("|")})(?=[A-Z_-])`);
const ANY = new RegExp(`${BOUND.source}|${PREFIX.source}`);

/** 通用层 = 除内核自己的目录与内核侧四件套之外的所有生产源码。 */
const EXCLUDE = ["/kernels/", "/pi-extension/", "/dsh-extension/", "/minimal-extension/",
  "kernel/pi/", "kernel/dsh/", "kernel/minimal/", "my-harness-fit-pi-extension"];
const SCAN_ROOTS = ["src", "packages/shared/src", "packages/react/src"];

/** 账本分两类，处置完全不同：
 *  · `homonym`（同形异义）——**永久合法**，不是债（`minimal` 既是内核 id，又是思考档位名、
 *    又是视觉风格预设名；`pi-review` 是历史线格式，必须继续认）。
 *  · `debt`（架构债）——**暂时保留**，必须只减不增（下面有棘轮断言）。
 *    这类不能"顺手改"：它们的正确修法是让内核自报自己的配置目录/路径（经注册表或 KernelPlugin 面），
 *    而不是把常量改个名。改名只是把泄漏藏得更深，属 §3.7 禁止的补丁式修复。 */
const LEDGER: { file: string; token: string; kind: "homonym" | "debt"; why: string }[] = [
  { file: "packages/shared/src/contract/style-presets.ts", token: "minimal", kind: "homonym",
    why: "视觉**风格预设**名（与 default/card/outline/glass 并列），与 minimal 内核同形异义" },
  { file: "src/plugins/sessions/timeline/renderer/index.tsx", token: "minimal", kind: "homonym",
    why: "**思考档位**名（DEFAULT_LEVELS = off/minimal/low/medium/high/xhigh），与 minimal 内核同形异义" },
  { file: "src/plugins/sessions/timeline/renderer/composer.tsx", token: "minimal", kind: "homonym",
    why: "**思考档位** → i18n 键的映射表项（`minimal: 『shell.levelMinimal』`），与上面同源，同形异义" },
  // 侧栏/右面板的视觉密度档位取值集是 card | glass | minimal | outline（实测自 index.css 与
  // settings-page.tsx 的 `data-sidebar-style={sidebarStyle}`），与 style-presets.ts 同族。
  { file: "src/web/index.css", token: "minimal", kind: "homonym",
    why: "侧栏/右面板的**视觉风格档位**选择器 `[data-sidebar-style=『minimal』]`（取值集 card/glass/minimal/outline，实测自 style-presets.ts 的 StylePresetId），与 minimal 内核同形异义" },
  { file: "src/plugins/sessions/review/renderer/index.tsx", token: "pi", kind: "homonym",
    why: "评论块解析正则 `/<(pi-review|review)>…<\\1>/` 里的 `pi-review` 是**历史线格式**：标签随 prompt 落进了会话文件，历史消息里全是它，解析方必须继续认（r27 改中性 `<review>` 时特意保留的向后兼容），删掉会让老会话的评论块退化成裸 XML" },
  // ── 架构债（必须只减不增）──

];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "dist" || name === "out" || name.startsWith(".")) continue;
      walk(full, out);
    } else if (/\.(ts|tsx|css)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

/** 去掉注释后的逐行内容（保留行数，便于报错时给准确行号）。 */
function stripComments(src: string): string[] {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return noBlock.split("\n").map((l) => {
    const i = l.indexOf("//");
    if (i < 0) return l;
    const before = l.slice(0, i);
    // 引号计数为偶数 ⇒ 这个 `//` 在字符串外 ⇒ 是真注释（否则可能是 URL 里的 `//`）
    const quotes = (before.match(/(?<!\\)["'`]/g) ?? []).length;
    return quotes % 2 === 0 ? before : l;
  });
}

interface Hit { file: string; line: number; token: string; text: string; carrier: string }

/** 判定命中属于哪种载体（用于报错信息可读；判据本身对所有载体一视同仁）。 */
function carrierOf(line: string): string {
  if (/^\s*[\w-]+\s*:|^\s*\./.test(line) && /\.(css)$/.test(line)) return "CSS";
  if (/console\.(log|warn|error|info|debug)/.test(line)) return "日志前缀";
  if (/throw new Error|\.reject\(|showToast|toast\(/.test(line)) return "用户可见错误文本";
  if (/data-[a-z-]+=|className=|\.[\w-]+\s*\{/.test(line)) return "DOM 属性 / CSS 类名";
  if (/(?:config|prefs|store|localStorage)\s*\.\s*(?:get|set|remove|has)/.test(line)) return "存储键";
  if (/["'`][\w-]+:[\w-]+["'`]/.test(line)) return "事件名 / channel";
  return "字符串字面量";
}

function scan(): Hit[] {
  const hits: Hit[] = [];
  for (const base of SCAN_ROOTS) {
    const abs = join(ROOT, base);
    if (!existsSync(abs)) continue;
    for (const f of walk(abs)) {
      const rel = relative(ROOT, f).split("\\").join("/");
      if (EXCLUDE.some((x) => rel.includes(x))) continue;
      const lines = stripComments(readFileSync(f, "utf-8"));
      lines.forEach((l, idx) => {
        for (const m of l.matchAll(new RegExp(ANY.source, "g"))) {
          hits.push({ file: rel, line: idx + 1, token: m[0], text: l.trim().slice(0, 96), carrier: carrierOf(l) });
        }
      });
    }
  }
  return hits;
}

const isLedgered = (h: Hit): boolean => LEDGER.some((l) => h.file.endsWith(l.file) && h.token.toLowerCase() === l.token.toLowerCase());

describe("内核名泄漏：通用层的多载体扫描（标识符之外的那些）", () => {
  const hits = scan();

  it("判据不空转：确实扫到了文件，且词边界与注释剥离都真的生效", () => {
    const files = SCAN_ROOTS.flatMap((b) => (existsSync(join(ROOT, b)) ? walk(join(ROOT, b)) : []))
      .filter((f) => !EXCLUDE.some((x) => relative(ROOT, f).split("\\").join("/").includes(x)));
    // ⚠ 阈值要按**每个扫描根分别**断言，不能只断总数：只断总数时，某一个根整体失效
    //   （路径写错、被 EXCLUDE 全吃掉）可能被其它根的数量掩盖过去。
    //   数字取自 r31 实测（src 3xx、packages/shared/src 与 packages/react/src 各数十），
    //   留出余量但不放宽到"接近 0 也算过"。
    expect(files.length, "一个文件都没扫到 = 路径坏了（假绿）").toBeGreaterThan(300);
    for (const base of SCAN_ROOTS) {
      const abs = join(ROOT, base);
      if (!existsSync(abs)) continue;
      const n = walk(abs).filter((f) => !EXCLUDE.some((x) => relative(ROOT, f).split("\\").join("/").includes(x))).length;
      expect(n, `扫描根 ${base} 只剩 ${n} 个文件——该根可能整体失效（判据会静默变空）`).toBeGreaterThan(20);
    }
    // 自检①：词边界 —— "picker"/"pins"/"ping" 里的 pi 不该命中
    expect(BOUND.test("sticker-picker"), "词边界失效：picker 里的 pi 被命中了").toBe(false);
    expect(BOUND.test("sessionGroupings"), "词边界失效：Groupings 里的 pi 被命中了").toBe(false);
    expect(BOUND.test('kernels["pi"]'), "真实的字面量键访问必须能命中").toBe(true);
    // 这两条是**假绿的回归锚**：首版边界规则漏掉了它们，反向注入时守卫全绿
    expect(BOUND.test(".dsh-legacy-panel"), "CSS 类名形态（连字符/点作边界）必须能命中").toBe(true);
    expect(PREFIX.test('config.set("piLayout", 1)'), "内核名作前缀的存储键必须能命中（形态二）").toBe(true);
    expect(PREFIX.test("dshManager"), "驼峰前缀必须能命中").toBe(true);
    expect(PREFIX.test("picker"), "自检：picker 不该被形态二命中（后接小写）").toBe(false);
    expect(ANY.test(".pi-collapsible"), "CSS 类名两种形态都要能命中").toBe(true);
    expect(BOUND.test("api"), "自检：api 里的 pi 不该命中（前接字母）").toBe(false);
    expect(BOUND.test("pixel"), "自检：pixel 里的 pi 不该命中（后接字母）").toBe(false);
    // 自检②：注释剥离 —— 块注释中间行提到的旧写法不该算命中
    const stripped = stripComments("code();\n/* 首行\n   中间行提到 kernels.pi 与 <pi-review>\n   末行 */\nmore();");
    expect(stripped.some((l) => ANY.test(l)), "块注释中间行没被剥掉（会误报）").toBe(false);
    // 自检③：真代码里的命中必须留下
    const kept = stripComments('const x = kernels["pi"];  // 行尾注释提到 dsh');
    expect(kept.some((l) => ANY.test(l)), "真代码被误剥了（会漏报）").toBe(true);
  });

  it("① 通用层没有未登记的内核名（任何载体：标识符/CSS/DOM/存储键/错误文本/日志/事件名/字符串）", () => {
    const bad = hits.filter((h) => !isLedgered(h));
    const lines = bad.map((h) => `${h.file}:${h.line} [${h.carrier}] 命中「${h.token}」\n        ${h.text}`);
    expect(bad, `通用层出现内核名 ${bad.length} 处：\n      ` + lines.join("\n      ")).toEqual([]);
  });

  it("② 账本没有腐烂：每条豁免都仍能在扫描结果里找到（改好了就删）", () => {
    const stale: string[] = [];
    for (const l of LEDGER) {
      if (!hits.some((h) => h.file.endsWith(l.file) && h.token.toLowerCase() === l.token)) {
        stale.push(`${l.file} 的「${l.token}」（扫描结果里已不存在 → 从 LEDGER 删除）`);
      }
    }
    expect(stale, `账本里有 ${stale.length} 条已失效：\n      ` + stale.join("\n      ")).toEqual([]);
  });

  it("③ 每条豁免都带理由；同形异义类必须说清是哪种歧义，架构债类必须写清正确修法", () => {
    for (const l of LEDGER) {
      expect(typeof l.why === "string" && l.why.length >= 20, `${l.file} 的理由太短`).toBe(true);
      if (l.kind === "homonym") {
        expect(/同形异义|历史线格式/.test(l.why), `${l.file} 属同形异义类，理由应说清是哪种歧义`).toBe(true);
      } else {
        expect(l.why, `${l.file} 属架构债类，理由必须写清正确修法`).toContain("正确修法");
      }
    }
  });

  it("⑤ 架构债**只减不增**（棘轮）：新增一条内核名泄漏必须要么改掉、要么当场写下正确修法", () => {
    // 上限 = 当前实测值。修好一条就把它调低——调高需要在 PR 里解释为什么债变多了。
    // 这条的意义不在数字本身，在于**让债可见**：没有它，"通用层零内核名"这个目标
    // 会在一次次"就这一处、下轮再收"里悄悄退化成"到处都有"。
    // r32 收掉 3 条，r33 收掉最后 1 条（发布面的 MODELS_CONFIG_PATH：语义改由声明方派生，
    // 见 contract/config-saved.ts），债清零。**上限保持 0**：再出现内核名泄漏就必须当场修，
    // 或者写明正确修法后把上限调高——调高需要在提交里解释为什么债变多了。
    const DEBT_CEILING = 0;
    const debt = LEDGER.filter((l) => l.kind === "debt");
    expect(debt.length, `架构债从 ${DEBT_CEILING} 涨到了 ${debt.length} 条：${debt.map((d) => d.file).join(", ")}`).toBeLessThanOrEqual(DEBT_CEILING);
    console.log(`      架构债 ${debt.length}/${DEBT_CEILING} 条（同形异义 ${LEDGER.length - debt.length} 条，永久合法不计债）`);
  });

  it("④ 覆盖面自证：已扫的载体清单与 r27–r31 的实测结论一致（负结果也要钉住）", () => {
    // 这条不是查违规，是**把"哪些载体扫过了"写成可执行的事实**：
    // 载体分类函数必须认得出这几类，否则①的报错信息会全归到"字符串字面量"，
    // 下一次排查又得从头判断"这处是哪类载体"。
    expect(carrierOf('console.warn("[pi] 起不来")'), "日志前缀识别失效").toBe("日志前缀");
    expect(carrierOf('throw new Error("dsh 没有该面")'), "错误文本识别失效").toBe("用户可见错误文本");
    expect(carrierOf('ctx.config.set("piFoo", 1)'), "存储键识别失效").toBe("存储键");
    expect(carrierOf('<div className="pi-collapsible" />'), "CSS 类名识别失效").toBe("DOM 属性 / CSS 类名");
    expect(carrierOf('emit("dsh:reload")'), "事件名识别失效").toBe("事件名 / channel");
  });
});
