// `data-*` 探针锚点的**消费方对账**（r111）。
//
// ## 为什么要有这条守卫
//
// r92 定过一条纪律：**加锚点的那一轮就要有剧本用它**——锚点是给探针用的，
// 没人用的锚点会腐烂（改了没人发现、删了没人报错），而它腐烂时**不会有任何信号**。
// 但那条纪律只写在 skill 里，没有守卫，所以它被违反了：r111 实测发现
// **8 个锚点发出后从未被任何测试/剧本消费**，其中两个是我自己加的
// （r97 的 `data-settings-load-error`、r61 的 `data-toast-kind`）。
// 这条守卫就是把那条纪律变成机器可判的（§3.7：没有守卫的修复只是"这次对了"）。
//
// ## 为什么这个方向适合交守卫（而 CSS 变量方向不适合，见 §17.109）
//
// **语料封闭**：发出方是生产代码（`src/**`、`packages/*/src/**`、`test-plugins/**`），
// 消费方是测试与 e2e 剧本（`*.test.ts(x)`、`scripts/**/*.mjs`）——两侧都在仓库内、都可枚举。
// 不像 CSS 变量那样存在"第三方库/构建工具/运行时数据"三类语料外消费方。
//
// ⚠ 一个必须建模的形态：JSX 里的**裸属性**（`data-ask-question` 后面不带 `=`）。
//   首版正则只认 `data-x` 后跟 `=`/`:`/`{`，于是漏掉裸属性 ⇒ 发出侧少算 21 种
//   （70 → 91），反方向还因此报出 `data-ask-question` 这种假阳性。
//   与 r73（泛型里的 `>`）、r85（`fn: () => Promise<…>` 里的 `)`）同类：
//   **判据的分隔符集合必须覆盖真实代码的所有形态，漏一种就批量错**。
//
// ## 反方向（测试引用了但生产代码没发出）为什么本轮不交
//
// 实测 58 个候选，抽查发现至少三类假阳性/需要单独处置：
//   · **测试专用的 data-* prop**：`button.test.tsx` 里 `<Button data-audit-role="…">`——
//     Button 透传 data-*（r40），所以它本来就不该在生产代码里出现；
//   · **属性选择器片段**：`[data-settings-id][data-active]` 被拆成 `data-a`/`data-active` 之类；
//   · **真·空探针**：`data-active` 在设置页**从来不存在**（r89 的诊断早就显示
//     "当前激活=(无显式激活标记)"），所以那个选择器永不匹配、日志恒打印 null。
//     本轮已把它改用真锚点 `data-settings-pane-active`。
// 第三类是真缺陷（空探针 = 看着在验、实际什么都没验），但要把它与前两类分开需要更细的判据，
// 按 r77 的纪律**判据没把握就不交**；已查明的事实写在这里，下一轮再交。

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const PROD_ROOTS = ["src/web", "src/plugins", "src/server", "packages/react/src", "packages/shared/src", "test-plugins"];
const CONS_GLOBS = ["scripts", "src", "packages", "test-plugins"];

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) { if (name !== "node_modules" && !name.startsWith(".") && name !== "out" && name !== "dist") walk(full, out); }
    else out.push(full);
  }
  return out;
}

/** 发出方：生产代码（非测试、非语言包） */
function prodFiles(): string[] {
  const out: string[] = [];
  for (const r of PROD_ROOTS) {
    for (const f of walk(join(ROOT, r))) {
      if (!/\.tsx?$/.test(f) || /\.test\.tsx?$/.test(f) || f.includes("/locales/")) continue;
      out.push(f);
    }
  }
  return out;
}

/** 消费方：测试文件 + e2e/审计脚本 */
function consumerFiles(): string[] {
  const out: string[] = [];
  for (const r of CONS_GLOBS) {
    for (const f of walk(join(ROOT, r))) {
      const isTest = /\.test\.tsx?$/.test(f);
      const isScript = f.includes("/scripts/") && /\.mjs$/.test(f);
      // ⚠ 必须排除**本文件**：账本里逐条写着死锚点的名字，而本文件也在 `*.test.ts` 语料里 ⇒
      //   自指会让每个账本条目都算"已被消费"，dead 恒为 0、守卫彻底失效（r111 首版实测就是这样：
      //   ②③ 同时红，报"账本里这些锚点已经有消费方了"）。
      //   通则：**对账类守卫的两侧语料必须互斥，尤其要排除守卫自己**——
      //   它天然是"引用了所有被对账标识符"的那个文件。同类陷阱：r65 的 i18n 键守卫
      //   若把自己的样本清单算进消费方，也会自证清白。
      if (f.endsWith("data-anchor-consumers.test.ts")) continue;
      if (isTest || isScript) out.push(f);
    }
  }
  return out;
}

// ⚠ 裸属性形态必须覆盖：`data-x` 后面可能是 = : { " ' ` ) / > 空白 或行尾
const EMIT = /\b(data-[a-z][\w-]*)(?=[\s=:{"'`)/>]|$)/g;
const REF = /(data-[a-z][\w-]*)/g;

/**
 * 账本：已发出但**暂无消费方**的锚点，每条写明"为什么还没用上 + 该怎么补"。
 * ⚠ 这不是豁免表：账本里的每一条都是一个**待办**（要么补消费方、要么删锚点）。
 *   条目只许减少；新增必须当场写明理由（与 r68/r79/r105 的账本同款纪律）。
 */
const LEDGER: { anchor: string; why: string; next: string }[] = [
  { anchor: "data-child-group-label",
    why: "r71 加的：子会话分组的标题行。分组只在**真的有子 agent 会话**时才渲染，零 token 剧本造不出来",
    next: "要么在需要真机起子会话的剧本里消费它，要么删（它目前没有第二种用途）" },
  { anchor: "data-debug-bar-root",
    why: "debug-bar 是 devRole 门控的（r47），普通剧本里整个插件不渲染",
    next: "用 r47 的 devRole 播种夹具写一个 debug-bar 剧本，顺手消费这个根锚点" },
  { anchor: "data-kernel-custom-dir-browse",
    why: "自定义内核目录的「浏览」按钮；系统文件对话框在隐藏窗口里不可自动化",
    next: "可断言它**存在且可点**（不点），或改为断言其 aria/禁用态" },
  { anchor: "data-plugin-drag-handle",
    why: "插件列表的拖拽手柄。拖拽/粘贴一族自 r26 起就没有自动化覆盖（CDP 合成拖拽不稳定）",
    next: "与附件链拖拽（r26 待办）一起解决，或改为键盘可达性断言" },
  { anchor: "data-rewind-inline",
    why: "时间线内联回退条。需要真实会话历史才能渲染",
    next: "在会话类剧本里消费它（ask-resume / timeline 系列已有真会话夹具可借）" },
  { anchor: "data-settings-load-error",
    why: "r97 加的：设置页加载失败提示。但 r102 查明**服务端三条读取路径都吞错回落空值**，这条路径当前不可达（见 settings-page.tsx 里的可达性分析注释）",
    next: "若哪天服务端改成抛错（那是更好的设计），立刻用它写剧本；在此之前保留锚点即可" },
  { anchor: "data-toast-kind",
    why: "r61 加的：瞬时提示的语义级别。严重级分类由 transient-severity-classification 单测覆盖，DOM 侧还没断言",
    next: "write-failure-feedback 剧本里已经查了 role=alert，可顺手断言 data-toast-kind=error" },
];

describe("data-* 探针锚点：发出 ⇔ 消费对账", () => {
  const prod = prodFiles();
  const cons = consumerFiles();
  const emitted = new Map<string, string>();
  const emittedBy = new Map<string, Set<string>>();   // 锚点 → 发出它的文件集合（r125）
  for (const f of prod) {
    const rel = relative(ROOT, f);
    const src = readFileSync(f, "utf-8");
    for (const m of src.matchAll(EMIT)) {
      if (!emitted.has(m[1])) emitted.set(m[1], rel);
      (emittedBy.get(m[1]) ?? emittedBy.set(m[1], new Set()).get(m[1])!).add(rel);
    }
  }
  /** 被 **多个文件** 发出的锚点（r125：同名锚点多义性检查的输入） */
  const multiFile = [...emittedBy.entries()].filter(([, v]) => v.size > 1)
    .map(([k, v]) => ({ anchor: k, files: [...v].sort() })).sort((a, b) => a.anchor.localeCompare(b.anchor));
  const used = new Set<string>();
  for (const f of cons) {
    for (const m of readFileSync(f, "utf-8").matchAll(REF)) used.add(m[1]);
  }
  const dead = [...emitted.keys()].filter((k) => !used.has(k)).sort();

  it("判据不空转：两侧语料规模正常，且**裸属性形态被覆盖**", () => {
    expect(prod.length, `生产代码语料只有 ${prod.length} 个文件`).toBeGreaterThan(250);
    expect(cons.length, `消费方语料只有 ${cons.length} 个文件`).toBeGreaterThan(150);
    expect(emitted.size, `只认出 ${emitted.size} 种 data-* 锚点（r111 实测 91）⇒ 正则可能漏了裸属性形态`).toBeGreaterThan(85);
    // ⚠ 反空转的关键：这个锚点在 JSX 里是**裸属性**（不带 =），只认 `=`/`:`/`{` 的正则会漏掉它
    expect(emitted.has("data-ask-question"),
      "裸属性形态没被覆盖：data-ask-question 在 ask-question-card.tsx 里是 `data-ask-question` 后面直接换行").toBe(true);
    expect(used.size, "消费方引用数异常少 ⇒ 语料范围可能错了").toBeGreaterThan(80);
  });

  it("① 自检：已知**在用**的锚点必须两侧都在（否则判据在漏）", () => {
    // 样本来自实测：r93/r96/r92 三轮新加的锚点都已被剧本消费
    for (const a of ["data-settings-pane-active", "data-plugin-install", "data-settings-unsaved"]) {
      expect(emitted.has(a), `${a} 应由生产代码发出`).toBe(true);
      expect(used.has(a), `${a} 应被测试/剧本消费（r92 的纪律：加锚点那一轮就要用它）`).toBe(true);
    }
  });

  it("② 账本外的死锚点必须为 0（账本内的是待办，不是豁免）", () => {
    const listed = new Set(LEDGER.map((l) => l.anchor));
    const unlisted = dead.filter((d) => !listed.has(d));
    expect(unlisted.map((d) => `${d}（发出于 ${emitted.get(d)}）`), [
      `${unlisted.length} 个 data-* 锚点发出后没有任何测试/剧本消费，且不在账本里。`,
      "      r92 的纪律：锚点是给探针用的，没人用的锚点会腐烂（改了没人发现、删了没人报错），",
      "      而它腐烂时**不会有任何信号**。所以新增锚点的那一轮就要有剧本用它；",
      "      确实当轮用不上的，必须写进上面的账本（why = 为什么用不上，next = 该怎么补），",
      "      账本条目只许减少。",
    ].join("\n")).toEqual([]);
    // 账本自身不许腐：登记了但已经被消费 ⇒ 该删条目（仿 r83 的腐烂检查）
    const stale = [...listed].filter((a) => !dead.includes(a));
    expect(stale, `账本里这些锚点已经有消费方了，删掉条目（账本只放待办）：${stale.join()}`).toEqual([]);
    const gone = [...listed].filter((a) => !emitted.has(a));
    expect(gone, `账本里这些锚点生产代码已不再发出（连同条目一起删）：${gone.join()}`).toEqual([]);
  });

  /**
   * 多文件发出的锚点账本（r125）：每条写明**共享语义**。
   *
   * 为什么需要这条：同名锚点有两种情形——
   *   · **同语义、多发出方**（合法）：镜像预览组件与真组件用同一个属性，
   *     好让剧本用一条选择器同时命中；或同一语义的行在多个视图里各渲染一次。
   *   · **同名、不同语义**（危险）：r124 我差点造出一个——给搜索**输入框**新加
   *     `data-session-search`，而工具条上那个**展开/收起按钮**已经占用了这个名字。
   *     ⚠ 运行时 DOM 审计抓不到它：输入框是条件渲染（searchOpen 时才在 DOM 里），
   *     两个同名锚点从不同时出现，所以"锚点重复"检查恒为 0。**只有静态对账能抓。**
   * 判据无法自动区分这两种（那需要理解语义），所以要求**每个多文件锚点都登记共享语义**：
   * 登记时写不出"它们语义相同"的，就是撞名了。
   */
  const MULTI_FILE_LEDGER: { anchor: string; semantics: string }[] = [
    { anchor: "data-message-id",
      semantics: "消息行的 id——timeline / review / session-colors 三处各自渲染消息行，语义同一（同一条消息在哪个视图里都是它）" },
    { anchor: "data-section-header",
      semantics: "侧栏分组的**标题行**——section.tsx（分组组件本体）与 sidebar.tsx（容器）共用同一语义；与 data-section-collapsed 配对使用（一个定位标题行、一个读折叠态）。r125 由守卫发现（Python 预估脚本漏了它，说明两侧判据有细微差别，以守卫为准）" },
    { anchor: "data-section-collapsed",
      semantics: "侧栏分组的折叠态——section.tsx（分组组件本体）与 sidebar.tsx（容器）共用同一语义，供剧本判展开/收起" },
    { anchor: "data-session-path",
      semantics: "会话行的路径标识——两个会话列表视图（主列表与搜索结果）各渲染一次，语义同一" },
    { anchor: "data-sidebar-style",
      semantics: "侧栏样式变体——sidebar.tsx（真组件）与 sidebar-style-preview.tsx（设置页里的**镜像预览**）刻意同名，好让一条选择器同时命中真品与预览" },
    { anchor: "data-sidepanel-style",
      semantics: "右面板样式变体——right-panel.tsx 与 sidepanel-style-preview.tsx，同上的镜像预览模式" },
    { anchor: "data-state",
      semantics: "**Radix 约定**的展开态（open/closed），挂在 .shell-collapsible 上；sessions-list 两处发出、session-colors 读它。属库约定的通用属性，不是本项目自有锚点" },
  ];

  it("③ 多文件发出的锚点必须登记**共享语义**（防同名不同义）", () => {
    const listed = new Set(MULTI_FILE_LEDGER.map((l) => l.anchor));
    const unlisted = multiFile.filter((m) => !listed.has(m.anchor));
    expect(unlisted.map((m) => `${m.anchor} ← ${m.files.map((f) => f.split("/").pop()).join(" + ")}`), [
      `${unlisted.length} 个锚点被多个文件发出，但没登记共享语义。`,
      "      两种可能：① 它们语义确实相同（镜像预览 / 同一语义在多个视图各渲染一次）",
      "      ⇒ 在 MULTI_FILE_LEDGER 里写明共享语义；",
      "      ② **同名不同义**（r124 差点造出的那种：搜索输入框与展开按钮都想叫 data-session-search）",
      "      ⇒ 改名，让每个语义有自己的锚点名。",
      "      ⚠ 运行时 DOM 审计抓不到 ②：条件渲染的两个同名锚点从不同时出现在 DOM 里，",
      "      所以 dom-audit 的『锚点重复』恒为 0。这条静态对账是唯一的防线。",
    ].join("\n")).toEqual([]);
    // 账本腐烂检查：登记了但已不再是多文件发出 ⇒ 删条目
    const stale = MULTI_FILE_LEDGER.filter((l) => !multiFile.some((m) => m.anchor === l.anchor));
    expect(stale.map((l) => l.anchor),
      `这些锚点已不再被多个文件发出，从账本删掉：${stale.map((l) => l.anchor).join()}`).toEqual([]);
    // 账本条目必须真的写了语义（防空条目）
    const thin = MULTI_FILE_LEDGER.filter((l) => l.semantics.trim().length < 12);
    expect(thin.map((l) => l.anchor), "账本条目的共享语义写得太短（等于没写）").toEqual([]);
  });

  it("④ 棘轮：死锚点总数只许减少（r115 基线 7）", () => {
    expect(dead.length, [
      `无消费方的 data-* 锚点从 7 涨到了 ${dead.length}。`,
      "      每消化一条（补消费方或删锚点）就下调这个数字；账本条目的 why/next 必须具体到能照着做。",
    ].join("\n")).toBeLessThanOrEqual(7);
    expect(LEDGER.length, "账本条目数应与死锚点数一致（每条都是一个待办）").toBe(dead.length);
  });
});
