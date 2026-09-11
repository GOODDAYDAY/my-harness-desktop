// config-file 原语单测:重点钉住 **deep 合并路径遇损坏文件时"先备份再继续"**。
//
// 背景(实测):`readJsonFile` 把"损坏"与"不存在"都归成 `{}`——只读时是健壮,但 deep 合并是
// **读-改-写**:损坏 → 读回 `{}` → 合并 → 写回,原文件其余键**整段消失**且无告警。
// 可达路径:`pi-bundled-skills` 用 deep 写 `~/.pi/agent/settings.json`。
// 本测试钉住的是**数据可恢复**:损坏时先原样备份,再照常合并。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readJsonFile, writeJsonFile } from "./config-file";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cfg-file-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const backupsOf = (p: string): string[] =>
  readdirSync(dir).filter((f) => f.startsWith(`${p.split("/").pop()!}.corrupt-`));

describe("writeJsonFile(deep)遇损坏文件:先备份,不静默销毁", () => {
  it("文件损坏时:原内容被原样备份下来,且本次仍按空对象合并写回", async () => {
    const p = join(dir, "settings.json");
    const corrupt = '{ "a": 1, "b": 2,,, }';   // 非法 JSON
    writeFileSync(p, corrupt, "utf-8");

    await writeJsonFile(p, { c: 3 }, "deep");

    const backups = backupsOf(p);
    expect(backups.length, "损坏文件未被备份(原内容将永久丢失)").toBe(1);
    expect(readFileSync(join(dir, backups[0]), "utf-8"), "备份内容与损坏前不一致").toBe(corrupt);
    // 语义不变:仍然按空对象继续合并
    expect(readJsonFile(p)).toEqual({ c: 3 });
  });

  it("文件合法时:正常深合并,且不产生备份", async () => {
    const p = join(dir, "settings.json");
    writeFileSync(p, JSON.stringify({ a: 1, nested: { x: 1 } }), "utf-8");

    await writeJsonFile(p, { b: 2, nested: { y: 2 } }, "deep");

    expect(readJsonFile(p)).toEqual({ a: 1, b: 2, nested: { x: 1, y: 2 } });
    expect(backupsOf(p).length, "合法文件被误备份").toBe(0);
  });

  it("文件不存在时:视为空,正常写入,且不产生备份(不存在 ≠ 损坏)", async () => {
    const p = join(dir, "new.json");
    await writeJsonFile(p, { a: 1 }, "deep");
    expect(readJsonFile(p)).toEqual({ a: 1 });
    expect(backupsOf(p).length, "不存在被误判为损坏").toBe(0);
  });

  it("replace 模式不进读路径:损坏文件直接整份覆盖,不备份(调用方本就意图整份写)", async () => {
    const p = join(dir, "settings.json");
    writeFileSync(p, "not json at all", "utf-8");
    await writeJsonFile(p, { a: 1 }, "replace");
    expect(readJsonFile(p)).toEqual({ a: 1 });
    expect(backupsOf(p).length).toBe(0);
  });
});
