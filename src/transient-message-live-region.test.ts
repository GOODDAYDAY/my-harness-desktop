// 瞬时提示必须进 live region —— 全仓扫描守卫（r59）。
//
// ## 被守的缺陷
//
// 「一闪几秒就消失的提示」对读屏用户等于**不存在**：`aria-live` 的播报要求容器先于内容存在
// （r37 已解决：`ensureToastHost()` 常驻宿主 + `<Announce>` 原语）。r37 当时接了 5 处
// （timeline / retry / continue + 两个用共享 `Toast` 部件的插件），但**没有全仓普查**，
// 于是本轮扫出还有 3 处漏网：
//   · `manager/plugin-manager`（`feedback`：安装/启用/卸载的结果，几秒后消失）
//   · `sessions/session-bookmarks/message-actions`（`toast`：错误提示）
//   · `project/stickers`（`transfer.msg`：导入导出结果，含失败原因）
// 三处的共同后果：用户点了按钮，界面上闪了一下就没了，而读屏**一个字都没念**——
// 从 AT 侧看，这个操作"没有任何反应"。
//
// ## 判据（以及它的边界，边界要如实写出来）
//
// 单文件正则能覆盖的形态：`setTimeout(…set*(null)…)` 的自动清空态 **且**在同一文件里被渲染成文本。
// 覆盖不到的形态：状态由**自定义 hook 产出**、经 `obj.prop` 在另一个组件里渲染
// （stickers 就是这样：`useStickerTransfer` 返回 `msg`，组件里写 `transfer.msg`）。
// 这类靠 `CROSS_FILE_LEDGER` 显式登记 + 腐烂检查兜住，**不假装能自动发现**。
//
// ## 自检为什么是这条守卫的命门
//
// 首版判据坏了两次而都表现为"扫出 0 个文件"：
//   ① `setTimeout\([^)]*?set(\w+)\(null\)` —— `[^)]*` 跨不过箭头函数里的 `)`，
//      于是 `setTimeout(() => setMsg(null), 3000)` 匹配不上；
//   ② 从 `setMsg` 提取出的名字是 `Msg`，而状态变量是 `msg`（**首字母大小写没换算**），
//      于是"是否被渲染"那一步永远为假。
// 两次都返回 0，而 0 看起来像"仓库很干净"。**扫描返回 0 是危险信号，不是合格证**——
// 所以判据必须在已知正例上自检（下方 `KNOWN_POSITIVES`），命中数不足就直接红。

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SCAN_ROOTS = ["src/plugins", "src/web", "packages/react/src"];

/** 已知正例：判据必须能扫到它们（否则判据坏了，而"0 处违规"是假的）。 */
const KNOWN_POSITIVES = [
  "src/plugins/sessions/continue/renderer/index.tsx",
  "src/plugins/sessions/retry/renderer/index.tsx",
  "src/plugins/sessions/timeline/renderer/index.tsx",
  "src/plugins/manager/plugin-manager/renderer/index.tsx",
  "src/plugins/sessions/session-bookmarks/renderer/message-actions.tsx",
];

/** 跨文件形态的账本：状态由 hook 产出、在别处渲染，单文件正则连不起来。
 *  每条都要写明"谁产出、谁渲染、怎么验的"，并由 ③ 做腐烂检查。 */
const CROSS_FILE_LEDGER: { file: string; state: string; why: string }[] = [
  { file: "src/plugins/project/stickers/renderer/index.tsx", state: "msg",
    why: "`useStickerTransfer` 产出 `{text,kind}`，组件里以 `transfer.msg` 渲染；r59 已接 `<Announce message={transfer.msg.text} variant={transfer.msg.kind}/>`（kind 由 flash 的第二参决定，失败态走 alert）" },
];

/** `setTimeout(…)` 里把某个状态清成空值的形态。
 *  ⚠ 不能用 `setTimeout\([^)]*?set(\w+)\(null\)`：`[^)]*` 跨不过箭头函数的 `)`。
 *  改成"定位 setTimeout，再在其后 90 字符窗口里找清空调用"。 */
const CLEAR_IN_TIMEOUT_WINDOW = 90;
const CLEAR_CALL = /set([A-Z]\w*)\(\s*(?:null|""|undefined)\s*\)/g;
/** `setMsg` → `msg`（首字母小写；⚠ 忘了换算就会永远匹配不到渲染点）。 */
const varOf = (suffix: string): string => suffix.charAt(0).toLowerCase() + suffix.slice(1);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) { if (name !== "node_modules" && !name.startsWith(".")) walk(full, out); }
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

interface Site { file: string; states: string[]; wired: boolean }

function scan(): Site[] {
  const out: Site[] = [];
  for (const base of SCAN_ROOTS) {
    const root = join(ROOT, base);
    if (!existsSync(root)) continue;
    for (const f of walk(root)) {
      const rel = relative(ROOT, f);
      if (rel.includes("/locales/")) continue;
      const raw = readFileSync(f, "utf-8");
      const src = raw.replace(/\/\*[\s\S]*?\*\//g, "");
      const auto = new Set<string>();
      for (const m of src.matchAll(/setTimeout\(/g)) {
        const from = m.index! + m[0].length;
        CLEAR_CALL.lastIndex = from;
        let c: RegExpExecArray | null;
        while ((c = CLEAR_CALL.exec(src)) !== null && c.index < from + CLEAR_IN_TIMEOUT_WINDOW) {
          auto.add(varOf(c[1]));
        }
      }
      if (auto.size === 0) continue;
      // 该状态是否被当文本渲染（三种常见形态：{x}、{x && …}、prop={x}）
      const rendered = [...auto].filter((n) => {
        const e = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`\\{\\s*${e}\\s*\\}`).test(src)
          || new RegExp(`\\{\\s*${e}\\s*[?&|]`).test(src)
          || new RegExp(`(?:message|text|label)\\s*=\\{\\s*${e}`).test(src);
      });
      if (rendered.length === 0) continue;
      const wired = raw.includes("<Announce") || raw.includes("<Toast");
      out.push({ file: rel, states: rendered, wired });
    }
  }
  return out;
}

describe("瞬时提示必须进 live region（自动消失的文案态 ⇒ 必须有 Announce 或共享 Toast）", () => {
  const sites = scan();

  it("判据不空转：**已知正例**必须全部被扫到（否则判据坏了，而「0 处违规」是假的）", () => {
    const found = new Set(sites.map((s) => s.file));
    const missing = KNOWN_POSITIVES.filter((k) => !found.has(k));
    expect(missing, [
      `判据漏掉了 ${missing.length} 个已知正例：`,
      ...missing.map((m) => `      · ${m}`),
      `      → 这类失败曾经发生过两次且都表现为「扫出 0 个文件」：`,
      `        ① setTimeout 的正则用 [^)]* 跨不过箭头函数的 )；② setMsg 提取出 Msg 而状态变量是 msg。`,
      `        **扫描返回 0 是危险信号，不是合格证。**`,
    ].join("\n")).toEqual([]);
    expect(sites.length, "扫到的站点数异常（已知至少 5 个）").toBeGreaterThanOrEqual(KNOWN_POSITIVES.length);
  });

  it("① 每个自动消失的文案态都已接 live region（Announce 或共享 Toast 部件）", () => {
    const unwired = sites.filter((s) => !s.wired);
    expect(unwired.map((s) => `${s.file}  态=${s.states.join(",")}`), [
      `${unwired.length} 处瞬时提示没进 live region：`,
      "      后果：提示闪几秒就消失，读屏一个字都没念 ⇒ 从 AT 侧看这次操作「没有任何反应」。",
      "      修法：加 `<Announce message={…} variant={…}/>`（错误态用 \"error\" ⇒ role=alert 可打断），",
      "      视觉部分**保持原样**（Announce 只补「被读到」，不改位置与样式；r37 定的形态）。",
    ].join("\n      ")).toEqual([]);
  });

  it("② 跨文件形态的账本每条都要有理由，且理由要说清产出方/渲染方/怎么验", () => {
    for (const e of CROSS_FILE_LEDGER) {
      expect(e.why.length, `${e.file} 的账本理由太短（要说清 hook 产出、渲染点、如何验证）`).toBeGreaterThan(40);
      expect(existsSync(join(ROOT, e.file)), `${e.file} 已不存在 ⇒ 从 CROSS_FILE_LEDGER 删除`).toBe(true);
    }
  });

  it("③ 账本没有腐烂：登记的文件里确实还有那个状态与 Announce（改好了就删条目）", () => {
    const stale: string[] = [];
    for (const e of CROSS_FILE_LEDGER) {
      const src = readFileSync(join(ROOT, e.file), "utf-8");
      if (!src.includes(e.state)) stale.push(`${e.file} 里已找不到状态 ${e.state}`);
      if (!src.includes("<Announce")) stale.push(`${e.file} 里已没有 <Announce>（要么改用别的形态并更新账本，要么这条已失效）`);
    }
    expect(stale, `账本失效 ${stale.length} 条：\n      ${stale.join("\n      ")}`).toEqual([]);
  });

  it("④ 回归锚：r59 修的三处不得退回（去掉 Announce 就会让读屏用户收不到）", () => {
    const probes: [string, string][] = [
      ["src/plugins/manager/plugin-manager/renderer/index.tsx", "feedback.msg"],
      ["src/plugins/sessions/session-bookmarks/renderer/message-actions.tsx", "variant=\"error\""],
      ["src/plugins/project/stickers/renderer/index.tsx", "transfer.msg.text"],
    ];
    const back: string[] = [];
    for (const [rel, needle] of probes) {
      const src = readFileSync(join(ROOT, rel), "utf-8");
      const hasAnnounce = src.includes("<Announce");
      const hasNeedle = src.includes(needle);
      if (!hasAnnounce || !hasNeedle) back.push(`${rel}（Announce=${hasAnnounce}、${needle}=${hasNeedle}）`);
    }
    expect(back, `r59 的修复被回退：\n      ${back.join("\n      ")}`).toEqual([]);
  });
});
