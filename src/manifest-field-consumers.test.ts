// manifest 声明的字段必须有消费方读取（"声明 ⇔ 兑现"对账，r71）。
//
// ## 被守的缺陷：声明了却不兑现
//
// 契约里声明一个字段、插件 manifest 里也真在用，但**没有任何代码读它** ⇒
// 插件作者按契约声明了，界面毫无反应，且不报错、不警告、不变红。
// 这比"字段不存在"更糟：字段存在会让人以为它生效。
//
// r71 实测查出 **2 个**：`sessionGroupings[].childIcon` 与 `sessionGroupings[].childLabelKey`。
// sub-agent 的 manifest 明明白白写着
// `"childIcon": "git-fork", "childLabelKey": "sub-agent.childLabel"`，
// > 而唯一的消费方 `sessions-list` 只读了 `parentPathField`——于是子 agent 会话在列表里
// 与普通会话长得一模一样（写死的 `MessageSquare` 图标、没有子分组标题）。
// 契约注释还写着回落语义（"不提供则用默认缩进图标"/"不提供则不显子分组标题"），
// 说明设计是打算兑现的，只是消费侧漏了。已按契约兑现（r71）。
//
// 这与 r46/r47 对**能力轴**做的"声明 ⇔ 消费"普查是同一条纪律，对象换成 manifest 字段；
// 也与 r63–r67 的 manifest 对账同族（那几轮守"名字对不对得上"，本条守"字段有没有人用"）。
//
// ## 判据与它的边界
//
// 消费方语料 = `src/web` + `src/server` + `packages/react/src` + **`packages/shared/src`** + `src/plugins`
// 的全部 `.ts/.tsx`（排除测试与 locales）。
//
// ⚠ **必须含圆心层**：首版漏了 `packages/shared/src`，于是把 `fileIcons[].filenames`
// 报成"无人读取"——而它的消费方正是圆心的 `buildFileIconIndex`
// （`for (const name of c.filenames ?? []) byName.set(…)`）。
// 这个假阳性恰好证明：**判据的语料范围本身要被断言**（见下方"语料范围自检"）。
//
// 读取形态认三种：`.field`、解构 `{ …field… } =`、`["field"]`，外加 `field ??`（可选回落写法）。
// 认不全就会产假阳性——所以本条的失败信息里明确写了"若这是新的读取形态，扩 RX 而不是加豁免"。

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
/** 消费方语料范围。⚠ 必须含 packages/shared/src（圆心里的纯函数也是消费方）。 */
const CORPUS_ROOTS = ["src/web", "src/server", "packages/react/src", "packages/shared/src", "src/plugins"];
const PLUGIN_ROOTS = ["src/plugins", "test-plugins"];

function walk(dir: string, pred: (n: string) => boolean, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) { if (name !== "node_modules" && !name.startsWith(".")) walk(full, pred, out); }
    else if (pred(name)) out.push(full);
  }
  return out;
}

/** 契约里各 *Contribution 接口的字段名（含行内嵌套对象的字段）。 */
function contractFields(): Set<string> {
  const src = readFileSync(join(ROOT, "packages/shared/src/domain/contributions.ts"), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const out = new Set<string>();
  for (const m of src.matchAll(/export interface \w+Contribution\s*\{/g)) {
    let i = m.index! + m[0].length;
    let depth = 1;
    const buf: string[] = [];
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === "{") depth += 1;
      else if (c === "}") depth -= 1;
      if (depth > 0) buf.push(c);
      i += 1;
    }
    for (const ln of buf.join("").split("\n")) {
      const st = ln.trim();
      if (!st || st.startsWith("//") || st.startsWith("*")) continue;
      for (const fm of st.matchAll(/(?:^|[;{,])\s*(\w+)\??\s*:/g)) out.add(fm[1]);
    }
  }
  return out;
}

/** manifest 里各槽位实际用到的字段名。 */
function manifestFields(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const root of PLUGIN_ROOTS) {
    for (const f of walk(join(ROOT, root), (n) => n === "plugin.json")) {
      const j = JSON.parse(readFileSync(f, "utf-8")) as { contributes?: Record<string, unknown> };
      for (const [slot, items] of Object.entries(j.contributes ?? {})) {
        if (!Array.isArray(items)) continue;
        const set = out.get(slot) ?? new Set<string>();
        const rec = (o: unknown): void => {
          if (Array.isArray(o)) { o.forEach(rec); return; }
          if (!o || typeof o !== "object") return;
          for (const [k, v] of Object.entries(o as Record<string, unknown>)) { set.add(k); rec(v); }
        };
        items.forEach(rec);
        out.set(slot, set);
      }
    }
  }
  return out;
}

function corpus(): { file: string; src: string }[] {
  const out: { file: string; src: string }[] = [];
  for (const root of CORPUS_ROOTS) {
    for (const f of walk(join(ROOT, root), (n) => /\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n))) {
      if (f.includes("/locales/")) continue;
      out.push({ file: relative(ROOT, f), src: readFileSync(f, "utf-8") });
    }
  }
  return out;
}

/** 读取形态：`.field` / 解构 / `["field"]` / `field ??`。 */
function readRx(field: string): RegExp {
  const e = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\.${e}\\b|\\{[^}]*\\b${e}\\b[^}]*\\}\\s*=|\\["${e}"\\]|\\b${e}\\s*\\?\\?`);
}

describe("manifest 声明的字段必须有消费方读取（声明 ⇔ 兑现）", () => {
  const contract = contractFields();
  const used = manifestFields();
  const files = corpus();

  it("判据不空转：三份清单都非空，且**语料范围含圆心层**", () => {
    // r71 实测：*Contribution 接口里共 44 个字段名（阈值按实测钉，不凭想象写 60）
    expect(contract.size, `契约里只解析到 ${contract.size} 个字段（r71 实测 44）⇒ 接口解析可能坏了`).toBeGreaterThanOrEqual(40);
    expect(used.size, "一个槽位都没扫到").toBeGreaterThan(10);
    expect(files.length, `消费方语料只有 ${files.length} 个文件（r71 实测 440+）`).toBeGreaterThan(400);
    // ⚠ 语料范围自检：圆心层必须在内。首版漏了它，于是把 `fileIcons.filenames`
    //   报成"无人读取"（它的消费方正是圆心的 buildFileIconIndex）。
    expect(files.some((f) => f.file.startsWith("packages/shared/src/domain/")),
      "语料漏了圆心层（packages/shared/src/domain）⇒ 会把圆心纯函数消费的字段误判成死字段").toBe(true);
    // 自检：已知有消费方的字段必须被判为"有读取"（否则判据太严，全是假阳性）
    for (const f of ["filenames", "parentPathField", "revealOn", "configMerge", "saveMode"]) {
      expect(files.some((x) => readRx(f).test(x.src)), `自检失败：${f} 明明有消费方却没被识别 ⇒ 读取形态判据漏了`).toBe(true);
    }
  });

  it("① 契约声明且 manifest 在用的字段，必须至少有一个消费方读取它", () => {
    const dead: string[] = [];
    let checked = 0;
    for (const [slot, fields] of used) {
      for (const field of fields) {
        if (field === "id") continue;            // 每个槽位都有 id，且由 registry 统一消费
        if (!contract.has(field)) continue;      // 契约外的字段由 manifest-field-names 那条守卫负责
        checked += 1;
        const rx = readRx(field);
        if (!files.some((f) => rx.test(f.src))) dead.push(`${slot}[].${field}`);
      }
    }
    expect(checked, `只核对了 ${checked} 个字段（r71 实测 60+）⇒ 判据可能坏了`).toBeGreaterThan(50);
    expect(dead, [
      `${dead.length} 个字段声明了却没有任何消费方读取：`,
      ...dead.map((d) => `      ${d}`),
      `      后果：插件按契约声明了，界面毫无反应，且不报错、不警告、不变红——`,
      `            比"字段不存在"更糟，因为字段存在会让人以为它生效。`,
      `      修法二选一：① 在消费方兑现它（按契约注释的语义与回落）；`,
      `                 ② 若设计上决定不要这个字段，从契约与全部 manifest 里删掉（别留着骗人）。`,
      `      ⚠ 若这是**新的读取形态**（例如经变量间接访问），扩 readRx 而不是加豁免。`,
    ].join("\n")).toEqual([]);
  });

  it("② 回归锚：r71 兑现的两个字段不得再退回（消费方必须真的读它们）", () => {
    const target = files.find((f) => f.file.endsWith("sessions-list/renderer/index.tsx"));
    expect(target, "找不到 sessions-list 的渲染入口（路径变了？改这条锚）").toBeTruthy();
    const src = target!.src;
    for (const field of ["childIcon", "childLabelKey"]) {
      expect(readRx(field).test(src), `r71 的兑现被回退：sessions-list 不再读取 ${field}`).toBe(true);
    }
    // 兑现必须是"声明优先、缺省回落"，不是无条件替换掉原默认图标
    expect(src.includes("child.childIcon"), "childIcon 应来自命中的分组声明（child.childIcon）").toBe(true);
    // ⚠ 窗口要给足：三元的两支之间夹着注释与一长串内联样式，200 字符不够（首版就是这么假红的）。
    expect(/child\.childIcon\s*\?[\s\S]{0,600}?MessageSquare/.test(src),
      "childIcon 未声明时必须回落到默认缩进图标（契约：不提供则用默认）").toBe(true);
  });
});
