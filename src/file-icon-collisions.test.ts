// `fileIcons` 的扩展名/文件名**争抢**必须显式登记，且实际胜出者要与登记一致（r68）。
//
// ## 被守的缺陷
//
// 圆心的裁决语义是「同 key 后注册者胜出」（`packages/shared/src/domain/file-icons.ts` 的
// `buildFileIconIndex`：`for (const c of contributions) … byExt.set(ext, c)` —— 迭代中
// 后面的覆盖前面的）。这条语义本身没问题（它让高优先级 source 能覆盖内置），
// 但它有一个副作用：**同一个插件内部**的两个条目争抢同一扩展名时，胜负完全由
// **manifest 里的数组顺序**决定，而这个顺序没有任何人显式决定过、也没有任何提示。
//
// 实测的唯一一处（r68）就很典型：`.key` 同时被
//   · `file-tree:slides`（Keynote 演示文稿，extensions: ppt/pptx/**key**/odp，图标 file-pie-chart）
//   · `file-tree:key`（私钥与证书，extensions: pem/**key**/crt/cer/p12/pfx，图标 file-key）
// 声明。两种含义在现实里都成立，而当前胜出的是 `key`（私钥图标）——因为它在数组里靠后。
//
// 对一个开发工具来说这个结果**恰好是对的**（项目里的 `.key` 极大概率是私钥而不是 Keynote 稿），
// 但它是**偶然的**：把两个条目换个顺序，`.key` 就静默变成"演示文稿"图标——
// 不报错、不变红、也没有任何测试会发现。把私钥显示成幻灯片图标不是小事
// （用户可能因此对它做出错误的处理判断）。
//
// ## 判据
//
// ① 找出所有争抢（同一 extension / filename 被 ≥2 个条目声明）；
// ② 每处争抢都必须在 `RESOLVED` 里显式登记：**期望的胜出者 + 理由**；
// ③ 按圆心的裁决语义（同插件内 = 数组顺序，后者胜）算出**实际胜出者**，
//    必须与登记的期望一致 —— 于是"有人重排了数组"会立刻红。
// ④ 跨插件的争抢不由本条断言胜负（那取决于运行时的 source 优先级，静态算不准），
//    但必须登记并写明"由 source 优先级决定"，避免它变成没人知道的暗坑。
//
// r68 实测：182 个扩展名/文件名，争抢 **1** 处（`.key`），已登记。

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const PLUGIN_ROOTS = ["src/plugins", "test-plugins"];

interface Entry { plugin: string; id: string; icon?: string; manifest: string; index: number }

/** 显式登记每一处争抢：谁该胜出、为什么。 */
const RESOLVED: { key: string; winner: string; why: string }[] = [
  { key: "key", winner: "file-tree:key",
    why: "`.key` 既是 Keynote 演示文稿扩展名、也是 TLS 私钥/证书扩展名。本项目是**开发工具**，工作区里的 `.key` 极大概率是私钥（与 pem/crt/cer/p12/pfx 同类），因此由 `file-tree:key`（file-key 图标）胜出；把私钥显示成幻灯片图标会误导用户对敏感文件的处理判断。胜出方式=在 manifest 数组里排在 `slides` 之后（圆心语义：后者覆盖前者）。" },
];

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

/** 收集全部 fileIcons 条目，保留**同一 manifest 内的数组顺序**（裁决就靠它）。 */
function entries(): Entry[] {
  const out: Entry[] = [];
  for (const root of PLUGIN_ROOTS) {
    for (const f of walk(join(ROOT, root), (n) => n === "plugin.json")) {
      const j = JSON.parse(readFileSync(f, "utf-8")) as {
        id?: string;
        contributes?: { fileIcons?: { id?: string; icon?: string; extensions?: string[]; filenames?: string[] }[] };
      };
      const list = j.contributes?.fileIcons ?? [];
      list.forEach((fi, index) => {
        out.push({ plugin: j.id ?? "?", id: fi.id ?? "?", icon: fi.icon, manifest: relative(ROOT, f), index });
      });
      // 建立 key → 条目 的映射（与 buildFileIconIndex 同序：后面的覆盖前面的）
      list.forEach((fi, index) => {
        for (const k of [...(fi.extensions ?? []), ...(fi.filenames ?? []).map((n) => `file:${n}`)]) {
          const lower = k.toLowerCase();
          claimants.set(lower, [...(claimants.get(lower) ?? []), { plugin: j.id ?? "?", id: fi.id ?? "?", index, manifest: relative(ROOT, f) }]);
        }
      });
    }
  }
  return out;
}

const claimants = new Map<string, { plugin: string; id: string; index: number; manifest: string }[]>();

describe("fileIcons 的扩展名/文件名争抢：必须显式登记且实际胜出者与登记一致", () => {
  const all = entries();
  const contested = [...claimants.entries()].filter(([, v]) => v.length > 1);

  it("判据不空转：确实扫到了 fileIcons 条目与它们覆盖的键", () => {
    // r68 实测：条目数十个、覆盖 182 个扩展名/文件名
    expect(all.length, `只扫到 ${all.length} 个 fileIcons 条目（r68 实测 ≥10）`).toBeGreaterThanOrEqual(10);
    expect(claimants.size, `只收集到 ${claimants.size} 个键（r68 实测 182）⇒ 遍历可能坏了`).toBeGreaterThan(150);
    // 自检：已知的争抢必须被识别出来（否则"争抢 0 处"是假的）
    expect(claimants.get("key")?.length, "自检失败：已知 `.key` 被 slides 与 key 两个条目争抢，却没被识别").toBe(2);
  });

  it("① 每处争抢都已显式登记（未登记 = 胜负由数组顺序偶然决定，没人知道）", () => {
    const unregistered = contested
      .map(([k, v]) => ({ key: k, who: v.map((x) => `${x.plugin}:${x.id}`).join(" vs ") }))
      .filter((c) => !RESOLVED.some((r) => r.key === c.key));
    expect(unregistered.map((c) => `${c.key} ← ${c.who}`), [
      `${unregistered.length} 处争抢未登记：`,
      "      同一扩展名被多个条目声明时，胜出者由**数组顺序**决定（圆心语义：后者覆盖前者），",
      "      而这个顺序没人显式决定过。请判断哪个语义更合适，登记进 RESOLVED 并写明理由；",
      "      或者把该扩展名从不该拥有它的那个条目里删掉（消除争抢）。",
    ].join("\n      ")).toEqual([]);
  });

  it("② 实际胜出者必须与登记一致（有人重排数组就会红）", () => {
    const mismatched: string[] = [];
    for (const r of RESOLVED) {
      const list = claimants.get(r.key);
      if (!list || list.length < 2) { mismatched.push(`${r.key} 已不再被争抢（登记可以删了）`); continue; }
      // 同插件内：数组顺序靠后者胜出（与 buildFileIconIndex 的迭代覆盖一致）
      const samePlugin = list.every((x) => x.plugin === list[0].plugin);
      if (!samePlugin) continue; // 跨插件的胜负取决于运行时 source 优先级，静态不断言（见 ③）
      const winner = [...list].sort((a, b) => a.index - b.index).pop()!;
      const actual = `${winner.plugin}:${winner.id}`;
      if (actual !== r.winner) mismatched.push(`${r.key}: 登记期望 ${r.winner}，实际胜出 ${actual}（数组顺序变了？）`);
    }
    expect(mismatched, mismatched.join("\n      ")).toEqual([]);
  });

  it("③ 登记的每条都要有理由，且理由要说清「为什么是它胜出」而不是只写结论", () => {
    for (const r of RESOLVED) {
      expect(r.why.length, `${r.key} 的理由太短（要说清语义冲突的两侧与选择依据）`).toBeGreaterThan(40);
      expect(claimants.has(r.key), `登记的 ${r.key} 已不再是争抢项（争抢消除了就删掉登记）`).toBe(true);
      expect((claimants.get(r.key) ?? []).length, `${r.key} 的争抢方数量变了，登记的理由可能已过期`).toBeGreaterThan(1);
    }
  });

  it("④ 跨插件的争抢（若有）必须登记并说明由 source 优先级决定", () => {
    const cross = contested.filter(([, v]) => !v.every((x) => x.plugin === v[0].plugin));
    const undocumented = cross
      .map(([k, v]) => ({ key: k, who: v.map((x) => `${x.plugin}:${x.id}`).join(" vs ") }))
      .filter((c) => !RESOLVED.some((r) => r.key === c.key && /source 优先级/.test(r.why)));
    expect(undocumented.map((c) => `${c.key} ← ${c.who}`), [
      `${undocumented.length} 处**跨插件**争抢未登记：`,
      "      跨插件的胜负由运行时的 source 优先级决定（project > user > installed > builtin），",
      "      静态算不准，所以必须在登记里写明「由 source 优先级决定」并说明期望哪个插件胜出。",
    ].join("\n      ")).toEqual([]);
  });
});
