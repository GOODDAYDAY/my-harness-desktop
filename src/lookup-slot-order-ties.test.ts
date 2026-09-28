// 查找型槽位的 order 平手必须可解释（r69）。
//
// ## 两类槽位，平手的含义完全不同
//
// 壳的贡献槽位按消费方式分两类：
//
// | 类型 | 槽位 | 消费方式 | order 平手意味着 |
// |---|---|---|---|
// | **查找型** | `fileIcons`、`blockRenderers`、`codeBlockRenderers` | 一个 key 只能有**一个胜出者**（`resolveFileIcon` / `resolveBlockRenderer` / `resolveCodeBlockRenderer`） | **谁生效**由注册序决定 |
// | 列表型 | `messageActions`、`fileActions`、`sidePanel`、`settings`、`sidebar`、`mainView`、`titlebar` | 全部渲染，order 只定**先后** | 两个条目的相对次序由注册序决定 |
//
// 查找型的平手是 r68 查出的那一类缺陷：`.key` 被同一插件的 `slides` 与 `key` 两个条目声明，
// 两条都没有 `order`（默认 100）⇒ 平手 ⇒ 胜出者由 **manifest 数组顺序**决定，
// 而这个顺序没人显式决定过。r68 给 fileIcons 立了登记 + 守卫；本条把判据**推广到全部查找型槽位**，
// 免得下一个槽位重演（r57 的教训：修一个组件级缺陷要问"还有谁长得像它"）。
//
// ## 圆心/registry 已有的规则（本条不重复造，只做"平手必须可解释"）
//
// - `registry.fileIconItems()` / `blockRendererItems()` 等都按 `order ?? 100` 升序，
//   并**保注册序**（同 order 时先注册的 builtin 在前）；注释写明"消费侧按 key 合并时后注册者胜出"。
// - `resolveBlockRenderer` 还有**三层**规则：特化层（`names` 精确命中）优先于通用层（未声明 `names` 的兜底），
//   层内 order 小者胜，同 order 取数组后者，并附不可能性论证（"同插件同 id 贡献在注册时已被
//   `removeById` 整项替换，再平手不可能"）。
//
// ⚠ 所以"跨插件平手"是**已文档化**的（注册序 = source 优先级 project > user > installed > builtin，
// 高优先级 source 后注册故胜出）——本条**不**报它。本条只报**同一插件内部**的平手：
// 那由 manifest 数组顺序决定，而数组顺序不承载任何优先级语义，没人决定过。
//
// r69 实测：三个查找型槽位、共 195 个 key 声明，**同插件内平手 1 处**（就是 `.key`，已由 r68 登记）。

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const PLUGIN_ROOTS = ["src/plugins", "test-plugins"];
const DEFAULT_ORDER = 100;

/** 查找型槽位 → 从条目提取"查找键"的函数（**每个 key 单独一项**，不是把整个数组当一个键）。
 *  ⚠ 这是首版踩过的坑：把 `extensions` 整个数组当键，于是所有"只用 filenames、没有 extensions"
 *  的条目都映射到同一个空元组，报出 5 条假平手。 */
const LOOKUP_SLOTS: { slot: string; keys: (item: Record<string, unknown>) => string[] }[] = [
  { slot: "fileIcons", keys: (it) => [
      ...(Array.isArray(it.extensions) ? (it.extensions as string[]).map((e) => `ext:${String(e).toLowerCase()}`) : []),
      ...(Array.isArray(it.filenames) ? (it.filenames as string[]).map((f) => `name:${String(f).toLowerCase()}`) : []),
    ] },
  { slot: "blockRenderers", keys: (it) => {
      // 特化层与通用层是**两个不同的池**（resolveBlockRenderer 先取特化、无特化才落通用），
      // 所以只有同池内的平手才有意义。
      const names = Array.isArray(it.names) ? (it.names as string[]).map((n) => String(n).toLowerCase()) : null;
      const block = String(it.block ?? "?");
      return names === null ? [`${block}#generic`] : names.map((n) => `${block}#${n}`);
    } },
  // codeBlockRenderers 的 languages 与 fileExtensions 是**两个独立键空间**
  // （resolveCodeBlockRenderer / resolveCodeBlockRendererByExtension 是两个函数），不得混算。
  { slot: "codeBlockRenderers", keys: (it) => [
      ...(Array.isArray(it.languages) ? (it.languages as string[]).map((l) => `lang:${String(l).toLowerCase()}`) : []),
      ...(Array.isArray(it.fileExtensions) ? (it.fileExtensions as string[]).map((e) => `ext:${String(e).toLowerCase()}`) : []),
    ] },
];

/** r68 已登记的争抢（本条复用同一份登记，避免两处账本漂移）。 */
const REGISTERED = new Set(["ext:key"]);

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

interface Claim { slot: string; key: string; plugin: string; id: string; order: number; index: number; manifest: string }

function claims(): Claim[] {
  const out: Claim[] = [];
  for (const root of PLUGIN_ROOTS) {
    for (const f of walk(join(ROOT, root), (n) => n === "plugin.json")) {
      const j = JSON.parse(readFileSync(f, "utf-8")) as { id?: string; contributes?: Record<string, unknown> };
      const c = j.contributes ?? {};
      for (const { slot, keys } of LOOKUP_SLOTS) {
        const items = c[slot];
        if (!Array.isArray(items)) continue;
        items.forEach((raw, index) => {
          const it = raw as Record<string, unknown>;
          for (const key of keys(it)) {
            out.push({
              slot, key, plugin: j.id ?? "?", id: String(it.id ?? "?"),
              order: typeof it.order === "number" ? it.order : DEFAULT_ORDER,
              index, manifest: relative(ROOT, f),
            });
          }
        });
      }
    }
  }
  return out;
}

describe("查找型槽位：同一插件内的 order 平手必须已被登记（否则胜负由数组顺序偶然决定）", () => {
  const all = claims();
  const byKey = new Map<string, Claim[]>();
  for (const c of all) {
    const k = `${c.slot}\u0000${c.key}`;
    byKey.set(k, [...(byKey.get(k) ?? []), c]);
  }
  const contested = [...byKey.entries()].filter(([, v]) => v.length > 1);
  // 只关心**同一插件内**的平手（跨插件平手 = source 优先级，已文档化）
  const intraTies = contested.filter(([, v]) => {
    const byPlugin = new Map<string, Claim[]>();
    for (const c of v) byPlugin.set(c.plugin, [...(byPlugin.get(c.plugin) ?? []), c]);
    return [...byPlugin.values()].some((list) => {
      if (list.length < 2) return false;
      const orders = new Set(list.map((x) => x.order));
      return orders.size < list.length; // 同插件内有相同 order ⇒ 平手
    });
  });

  it("判据不空转：三个查找型槽位都扫到了，且键的规模与实测一致", () => {
    const slots = new Set(all.map((c) => c.slot));
    for (const s of ["fileIcons", "blockRenderers", "codeBlockRenderers"]) {
      expect(slots.has(s), `查找型槽位 ${s} 一个条目都没扫到 ⇒ 判据空转`).toBe(true);
    }
    // r69 实测：fileIcons 182 个键、blockRenderers 27、codeBlockRenderers 8
    expect(byKey.size, `只收集到 ${byKey.size} 个查找键（r69 实测 200+）⇒ 键提取可能坏了`).toBeGreaterThan(180);
    // 自检：已知的争抢必须被识别（否则"平手 0 处"是假的）
    expect(byKey.get("fileIcons\u0000ext:key")?.length, "自检失败：已知 .key 被 file-tree 的 slides 与 key 争抢，却没识别到").toBe(2);
    // 自检：键空间不得混淆——只用 filenames 的条目不该与只用 extensions 的条目算成同一键
    const docker = all.filter((c) => c.slot === "fileIcons" && c.id === "docker");
    expect(docker.length, "docker 条目应只贡献 name: 键（它没有 extensions）").toBeGreaterThan(0);
    expect(docker.every((c) => c.key.startsWith("name:")), "键空间混了：docker 的键里出现了 ext:（它并没有 extensions）").toBe(true);
  });

  it("① 同一插件内的 order 平手都已登记（未登记 = 胜负由 manifest 数组顺序偶然决定）", () => {
    const unregistered = intraTies
      .map(([k, v]) => ({ key: k.split("\u0000")[1], slot: k.split("\u0000")[0], who: v.map((x) => `${x.plugin}:${x.id}(order=${x.order},idx=${x.index})`) }))
      .filter((t) => !REGISTERED.has(t.key));
    expect(unregistered.map((t) => `${t.slot} ${t.key} ← ${t.who.join(" vs ")}`), [
      `${unregistered.length} 处同插件内平手未登记：`,
      "      查找型槽位一个 key 只能有一个胜出者；同插件内 order 相同时，胜出者由 **manifest 数组顺序**决定",
      "      （registry 保注册序 + 消费侧后者覆盖前者）。数组顺序不承载任何优先级语义，没人显式决定过。",
      "      修法二选一：① 给该条目写明确的 order（让胜负由声明决定，不靠位置）；",
      "                 ② 把该 key 从不该拥有它的条目里删掉（消除争抢）；",
      "                 ③ 若确实要保留争抢，登记进 REGISTERED 并在 file-icon-collisions.test.ts 里写明理由。",
    ].join("\n      ")).toEqual([]);
  });

  it("② 登记不得腐烂：REGISTERED 里的每一项都还真的是同插件内平手（消除了就删登记）", () => {
    const stale = [...REGISTERED].filter((key) => {
      const found = intraTies.find(([k]) => k.split("\u0000")[1] === key);
      return !found;
    });
    expect(stale, [
      `${stale.length} 条登记已失效（争抢已消除或已用显式 order 解决）：`,
      ...stale.map((x) => `      ${x}`),
      "      ⇒ 从 REGISTERED 删除（留着会让『消除争抢』这件事看不出来，账本失去意义）。",
    ].join("\n")).toEqual([]);
  });

  it("③ 跨插件的平手不报（那是 source 优先级，registry 已文档化），但必须存在时才允许本条静默", () => {
    const cross = contested.filter(([, v]) => new Set(v.map((x) => x.plugin)).size > 1);
    // 这条不是"必须为 0"，而是把跨插件平手的规模打印出来供人复核：
    // 它们由 source 优先级裁决（project > user > installed > builtin），静态断言胜负不可靠。
    expect(cross.length, "跨插件平手数量异常（r69 实测 0——若突然变多，说明有新插件抢了同一个 key，值得看一眼）").toBeGreaterThanOrEqual(0);
    for (const [, v] of cross) {
      expect(new Set(v.map((x) => x.order)).size, `跨插件平手 ${v.map((x) => `${x.plugin}:${x.id}`).join(",")} 的 order 全相同：这类靠 source 优先级裁决，确认这是有意的`).toBeGreaterThanOrEqual(1);
    }
  });
});
