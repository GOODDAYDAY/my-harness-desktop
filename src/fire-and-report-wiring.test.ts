// fireAndReport 调用点的**接线对账**（r186；语料=源码树 ⇒ 带反空转锚）。
//
// ## 为什么用守卫而不是三个组件夹具
//
// r185 把四处同构兜底收敛成框架原语 `fireAndReport(p, { tag, message })` 之后，
// 插件侧只剩两件事要钉：**tag 对不对**、**message 有没有给**。
// 这两件都是**静态可判**的接线属性，给三个重组件（plugin-manager / session-bookmarks /
// file-preview）各建 jsdom 夹具的成本远高于收益——而且夹具只能验"被渲染到的那条路径"，
// 守卫能一次覆盖**全部调用点，包括将来新增的**（§3.7 留下守卫）。
//
// ## 钉的两条性质
//
// ① **tag 必须与调用点所属插件一致**。r185 是一次四处的复制式迁移，
//   抄错 tag 是真实风险：`console.warn("[projects] …")` 若出现在 plugin-manager 里，
//   排查时会把人引到错误的插件（**误导性的日志比没有日志更糟**——它会消耗信任）。
//   判据：调用点路径形如 `src/plugins/<域>/<插件名>/…` ⇒ tag 必须等于 `<插件名>`。
//
// ② **每个调用点都必须给 message**（框架零文案契约的兑现侧）。
//   `fireAndReport` 自己不含任何用户可见文案（§1.2 铁律一），失败消息全靠调用方供；
//   若某个调用点漏了 `message`，失败时就只剩 console.warn ⇒ **用户侧退回静默失败**
//   （正是 r180–r183 修掉的那个缺陷），而且 TS 类型不一定拦得住
//   （`message` 是必填，但用 `as` 或部分展开就能绕过）。
//
// ## 为什么不算"用形态代替语义"（r159 的教训）
//
// 这里判的是**路径与字符串的一致性**（tag 与目录名），不是"名字长得像组件"这类形态推断；
// 而 message 那条判的是"这个键在调用里出现了"，属结构存在性。
// 两条都是可反驳的（改错就红），且有反空转锚证明判据真的在扫。

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const PLUGINS = join(ROOT, "src", "plugins");

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) { if (name !== "node_modules" && name !== "locales") walk(full, out); }
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}
function strip(s0: string): string {
  // ⚠ 剥注释只用于**匹配**；行号一律在原文件上算（r171/r182 的坑：剥离后的行号不能导航）。
  return s0.replace(/\/\*[\s\S]*?\*\//g, "").split("\n")
    .map((l) => (l.trim().startsWith("//") ? "" : l)).join("\n");
}

interface Site { file: string; line: number; pluginDir: string | null; tag: string | null; hasMessage: boolean }

function sites(): Site[] {
  const out: Site[] = [];
  // 语料：src/plugins/**（插件侧）+ packages/react/src/**（框架侧若有自调用）
  const files = [
    ...walk(PLUGINS),
    ...walk(join(ROOT, "packages", "react", "src")),
    // ⚠ r195 扩语料：壳前端 src/web 也在射程内。r194 给 settings-page.tsx 加了 fireAndReport，
    //   而它此前**不在语料里**（守卫只走 src/plugins 与 packages/react/src）⇒ 那处接线无人对账。
    //   这正是"守卫的语料边界"要跟着代码边界走的例子：新调用点出现在新目录时，
    //   要么扩语料、要么如实记为盲区（不能默认"守卫会覆盖"）。
    ...walk(join(ROOT, "src", "web")),
  ];
  for (const f of files) {
    const raw = readFileSync(f, "utf-8");
    const s = strip(raw);
    const rel = relative(ROOT, f);
    for (const m of s.matchAll(/fireAndReport\s*\(/g)) {
      if (/export function fireAndReport/.test(s.slice(Math.max(0, m.index - 40), m.index + 40))) continue;
      // 用**原文件**算行号：把剥离后文本的前缀长度映射回原文近似不可靠，
      // 所以直接在原文里找第 n 次出现的位置。
      const occ = [...s.slice(0, m.index).matchAll(/fireAndReport\s*\(/g)].length;
      const rawIdx = [...raw.matchAll(/fireAndReport\s*\(/g)][occ]?.index ?? m.index;
      const line = raw.slice(0, rawIdx).split("\n").length;
      // 取调用点后面的选项对象（到配对的 } 为止，粗略取 400 字内）
      const tail = s.slice(m.index, m.index + 400);
      const tagM = /tag:\s*"([^"]*)"/.exec(tail) ?? /tag:\s*'([^']*)'/.exec(tail);
      // 插件目录名：src/plugins/<域>/<插件名>/…
      const parts = rel.split(sep);
      const i = parts.indexOf("plugins");
      const pluginDir = i >= 0 && parts.length > i + 2 ? parts[i + 2] : null;
      out.push({ file: rel, line, pluginDir, tag: tagM ? tagM[1] : null, hasMessage: /message:\s*\(/.test(tail) });
    }
  }
  return out;
}

describe("fireAndReport 调用点接线对账", () => {
  const S = sites();

  it("判据不空转：扫到了调用点、且已知的四处都在（r185 迁移的那批）", () => {
    expect(S.length, "调用点数（r186 实测 4）").toBeGreaterThan(0);
    const files = S.map((x) => x.file);
    for (const expectFile of [
      "src/plugins/project/projects/renderer/index.tsx",
      "src/plugins/project/file-preview/renderer/index.tsx",
      "src/plugins/manager/plugin-manager/renderer/index.tsx",
      "src/plugins/sessions/session-bookmarks/renderer/index.tsx",
    ]) {
      expect(files.some((f) => f.endsWith(expectFile.split("/").slice(-3).join("/"))),
        `应扫到 ${expectFile}`).toBe(true);
    }
  });

  it("① tag 必须与调用点所属**插件目录名**一致（抄错 tag 会让日志指向错误的插件、把排查引偏）", () => {
    const bad = S.filter((x) => x.pluginDir && x.tag !== x.pluginDir);
    expect(bad.map((x) => `${x.file}:${x.line} tag="${x.tag}" 但插件目录是 "${x.pluginDir}"`), [
      "fireAndReport 的 tag 是 console.warn 的前缀，用来告诉排查者『是哪个插件失败了』。",
      "      r185 是一次四处的复制式迁移，抄错 tag 的风险是真实的——而**误导性日志比没有日志更糟**：",
      "      它会把人引到错误的插件，消耗对日志的信任。",
      "      修法：把 tag 改成所在插件的目录名（src/plugins/<域>/<插件名>/…）。",
    ].join("\n")).toEqual([]);
  });

  it("①b 非插件目录的调用点：tag 必须与**文件名**一致（壳前端/框架层没有插件目录可对账）", () => {
    // r195：语料扩到 src/web 之后，那里的调用点没有 pluginDir 可对账（①会自动跳过它们）。
    // 但 tag 仍然要可追溯——判据退而求其次：tag 等于所在文件名（去扩展名）。
    // 例：src/web/components/settings-page.tsx ⇒ tag "settings-page"；
    //     packages/react/src/widgets/file-tree.tsx ⇒ tag "file-tree"。
    // 这比"tag 非空"强：它保证 console.warn 的前缀能**直接定位到文件**。
    const base = (f: string): string => f.split("/").pop()!.replace(/\.tsx?$/, "");
    const bad = S.filter((x) => !x.pluginDir && x.tag !== base(x.file));
    expect(bad.map((x) => `${x.file}:${x.line} tag="${x.tag}" 但文件名是 "${base(x.file)}"`), [
      "非插件目录（src/web、packages/react）的调用点，tag 应等于所在文件名（去扩展名），",
      "      这样 console.warn 的前缀能直接定位到文件（r190 的教训：误导性日志比没有日志更糟）。",
    ].join("\n")).toEqual([]);
  });

  it("② 每个调用点都必须给 message（框架零文案 ⇒ 漏了 message 就退回静默失败）", () => {
    const bad = S.filter((x) => !x.hasMessage);
    expect(bad.map((x) => `${x.file}:${x.line}`), [
      "fireAndReport 自己**不含任何用户可见文案**（§1.2 铁律一：框架零文案），",
      "      失败消息全靠调用方经 message(detail) 提供。漏了 message ⇒ 失败时只剩 console.warn，",
      "      用户侧**退回静默失败**（正是 r180–r183 修掉的那个缺陷）。",
    ].join("\n")).toEqual([]);
  });

  it("③ 自检：tag 都非空、且行号来自**原文件**（不是剥离后的位置）", () => {
    expect(S.every((x) => typeof x.tag === "string" && x.tag.length > 0), "tag 不该为空串").toBe(true);
    // 行号可导航性：拿报出的行号回原文件读，应能看到 fireAndReport 或它的邻近上下文
    const s0 = S[0];
    const raw = readFileSync(join(ROOT, s0.file), "utf-8").split("\n");
    const near = raw.slice(Math.max(0, s0.line - 3), s0.line + 2).join("\n");
    expect(near, `行号 ${s0.line} 附近应能看到 fireAndReport（r171/r182 的坑：剥离后行号不能导航）`)
      .toContain("fireAndReport");
  });
});
