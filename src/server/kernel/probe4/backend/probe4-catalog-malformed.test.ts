// probe4 会话目录对**畸形行**的容错（r169；r168 普查排序第一位：probe4 零覆盖）。
//
// ## 为什么这条最值得补
//
// probe4 是验证开闭原则的**第四内核**（r47 那轮加进来的），而它的畸形行回落此前零覆盖。
// `readEntries` 的语义是"**损坏行跳过、其余照常**"（catalog 注释原话），
// 坏了的后果不是"少一条"，而是"**一条坏行让整个会话读不出来**"——
// 用户看到的是会话凭空变空，而盘上文件其实还在。
//
// `readEntries` 是私有函数，所以经导出的读口 `Probe4Catalog.getTree` 测（r168 的判定：
// 这属于"夹具型行为单测"，用临时目录造真实文件，不 mock 文件系统——被测的就是读盘容错）。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Probe4Catalog } from "./probe4-catalog";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "probe4-malformed-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function sessionFile(lines: string[]): string {
  const p = join(dir, "s.jsonl");
  writeFileSync(p, lines.join("\n") + "\n", "utf-8");
  return p;
}

describe("Probe4Catalog.getTree：畸形行容错", () => {
  it("① 首行合法、后面夹一行坏 JSON ⇒ 树照常建出来（坏行被跳过，不是整体失败）", async () => {
    const p = sessionFile([
      JSON.stringify({ id: "e1", role: "user", content: "hi" }),
      "{ 这不是合法 JSON",                       // ← 畸形行
      JSON.stringify({ id: "e2", role: "assistant", content: "yo" }),
    ]);
    const tree = await new Probe4Catalog(dir).getTree(p);
    expect(tree.rootId, "坏行不该让整棵树读不出来").toBe("e1");
    expect(tree.lineages).toHaveLength(1);
  });

  it("② **首行**就是坏的 ⇒ 回落空树（rootId 空、lineages 空），不抛", async () => {
    const p = sessionFile(["坏行在最前面", JSON.stringify({ id: "e1" })]);
    const tree = await new Probe4Catalog(dir).getTree(p);
    // 实现取 entries[0].id 作 rootId；首行坏被跳过后 entries[0] 是 e1 ⇒ 仍能建树
    expect(tree.rootId, "首行坏行被跳过后，下一条合法行成为根").toBe("e1");
  });

  it("③ 全是坏行 ⇒ 空树（不是抛错、也不是 undefined）", async () => {
    const p = sessionFile(["坏1", "坏2", "{{{"]);
    const tree = await new Probe4Catalog(dir).getTree(p);
    expect(tree).toEqual({ rootId: "", lineages: [] });
  });

  it("④ 文件不存在 ⇒ 空树（新会话还没物化是正常态，不是错误）", async () => {
    const tree = await new Probe4Catalog(dir).getTree(join(dir, "不存在的会话.jsonl"));
    expect(tree).toEqual({ rootId: "", lineages: [] });
  });

  it("⑤ 空文件 / 只有空行 ⇒ 空树（filter(Boolean) 那一步）", async () => {
    expect(await new Probe4Catalog(dir).getTree(sessionFile([]))).toEqual({ rootId: "", lineages: [] });
    expect(await new Probe4Catalog(dir).getTree(sessionFile(["", "   ", ""]))).toEqual({ rootId: "", lineages: [] });
  });

  it("⑥ 首行合法但**没有 id 字段** ⇒ 空树（形状守卫，不拿 undefined 当 rootId）", async () => {
    const p = sessionFile([JSON.stringify({ role: "user", content: "hi" })]);
    const tree = await new Probe4Catalog(dir).getTree(p);
    expect(tree.rootId, "没有 id 就不该编一个根出来").toBe("");
    expect(tree.lineages).toEqual([]);
  });
});
