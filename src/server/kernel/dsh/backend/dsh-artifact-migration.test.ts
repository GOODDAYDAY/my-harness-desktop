// dsh 工件编码迁移的守卫测试(§3.7:混合编码根让全部 dsh 会话「生成失败」的根因修复守卫)。
// 对账:① zstd 工件迁成明文且字节 1:1 ② 幂等 ③ 双份并存取更长 ④ 损坏隔离不销毁 ⑤ 空根零操作。
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { zstdCompressSync } from "node:zlib";
import { migrateZstdSessionArtifacts } from "./dsh-artifact-migration";

let roots: string[] = [];
function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "dsh-mig-test-"));
  roots.push(root);
  return root;
}
function seedArtifact(root: string, bucket: string, id: string, lines: string[], zstd = true): { dir: string; plain: string } {
  const dir = join(root, bucket, id);
  mkdirSync(dir, { recursive: true });
  const content = Buffer.from(lines.join("\n") + "\n", "utf-8");
  if (zstd) writeFileSync(join(dir, "session.jsonl.zstd"), zstdCompressSync(content));
  else writeFileSync(join(dir, "session.jsonl"), content);
  return { dir, plain: content.toString("utf-8") };
}

afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
});

describe("migrateZstdSessionArtifacts(dsh 会话工件 zstd→明文 一次性迁移)", () => {
  it("zstd 工件迁成明文,字节与源一致,zstd 清除", () => {
    const root = makeRoot();
    const { dir, plain } = seedArtifact(root, "--proj--", "sess-1", [
      '{"type":"session","version":0,"id":"sess-1"}',
      '{"type":"turn/start","seq":1}',
    ]);
    const r = migrateZstdSessionArtifacts(root);
    expect(r).toEqual({ migrated: 1, deduped: 0, quarantined: 0 });
    expect(readFileSync(join(dir, "session.jsonl"), "utf-8")).toBe(plain);
    expect(existsSync(join(dir, "session.jsonl.zstd"))).toBe(false);
  });

  it("幂等:第二次运行零操作", () => {
    const root = makeRoot();
    seedArtifact(root, "--proj--", "sess-1", ['{"type":"session","id":"s"}']);
    migrateZstdSessionArtifacts(root);
    const r2 = migrateZstdSessionArtifacts(root);
    expect(r2).toEqual({ migrated: 0, deduped: 0, quarantined: 0 });
  });

  it("明文+zstd 双份并存:append-only 取更长者为准,清 zstd", () => {
    const root = makeRoot();
    const dir = join(root, "--proj--", "sess-2");
    mkdirSync(dir, { recursive: true });
    const short = '{"type":"session","id":"s2"}\n';
    const longer = short + '{"type":"turn/start","seq":1}\n';
    writeFileSync(join(dir, "session.jsonl"), short);
    writeFileSync(join(dir, "session.jsonl.zstd"), zstdCompressSync(Buffer.from(longer, "utf-8")));
    const r = migrateZstdSessionArtifacts(root);
    expect(r).toEqual({ migrated: 0, deduped: 1, quarantined: 0 });
    expect(readFileSync(join(dir, "session.jsonl"), "utf-8")).toBe(longer);
    expect(existsSync(join(dir, "session.jsonl.zstd"))).toBe(false);
  });

  it("双份并存且明文更长:保留明文,清 zstd", () => {
    const root = makeRoot();
    const dir = join(root, "--proj--", "sess-3");
    mkdirSync(dir, { recursive: true });
    const short = '{"type":"session","id":"s3"}\n';
    const longer = short + '{"type":"x"}\n{"type":"y"}\n';
    writeFileSync(join(dir, "session.jsonl"), longer);
    writeFileSync(join(dir, "session.jsonl.zstd"), zstdCompressSync(Buffer.from(short, "utf-8")));
    migrateZstdSessionArtifacts(root);
    expect(readFileSync(join(dir, "session.jsonl"), "utf-8")).toBe(longer);
  });

  it("损坏 zstd:隔离成 .broken(不销毁),根编码扫描面出清", () => {
    const root = makeRoot();
    const dir = join(root, "--proj--", "sess-4");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "session.jsonl.zstd"), Buffer.from("not a zstd frame"));
    const r = migrateZstdSessionArtifacts(root);
    expect(r).toEqual({ migrated: 0, deduped: 0, quarantined: 1 });
    expect(existsSync(join(dir, "session.jsonl.zstd"))).toBe(false);
    expect(existsSync(join(dir, "session.jsonl.zstd.broken"))).toBe(true);
  });

  it("空根/不存在根:零操作不抛错", () => {
    expect(migrateZstdSessionArtifacts(join(tmpdir(), "dsh-mig-nonexistent"))).toEqual({ migrated: 0, deduped: 0, quarantined: 0 });
    const root = makeRoot();
    expect(migrateZstdSessionArtifacts(root)).toEqual({ migrated: 0, deduped: 0, quarantined: 0 });
  });

  it("已是明文的工件不动", () => {
    const root = makeRoot();
    const { dir, plain } = seedArtifact(root, "--proj--", "sess-5", ['{"type":"session","id":"s5"}'], false);
    const r = migrateZstdSessionArtifacts(root);
    expect(r).toEqual({ migrated: 0, deduped: 0, quarantined: 0 });
    expect(readFileSync(join(dir, "session.jsonl"), "utf-8")).toBe(plain);
  });
});
