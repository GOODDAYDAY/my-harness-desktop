// pi 旧会话文件一次性导入中立层的单测(session-single-source §4.3)。
// fixture:tmp 目录造真 JSONL(新派生命名 + 旧时间戳命名 + 损坏文件),不 mock 框架。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importLegacyPiSessions } from "./neutral-migration";
import { NeutralSessionStore } from "./neutral-session-store";
import { cwdToBucketName, emptyNeutralSession, appendNeutralEntry } from "@my-harness-desktop/shared";

let dir: string;
let neutralStore: NeutralSessionStore;
const CWD = "/tmp/proj";

function writeSession(file: string, opts: { customNs?: string; withCwd?: boolean } = {}): void {
  const header = {
    type: "session",
    id: "legacy-1",
    timestamp: "2026-01-01T00:00:00.000Z",
    ...(opts.withCwd === false ? {} : { cwd: CWD }),
    ...(opts.customNs ? { "custom-my-harness-desktop": { neutralSessionId: opts.customNs, pinned: true } } : {}),
  };
  const lines = [
    JSON.stringify(header),
    JSON.stringify({ type: "message", id: "e1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "旧问题" } }),
    JSON.stringify({ type: "message", id: "e2", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "旧回答" }] } }),
  ];
  writeFileSync(file, lines.join("\n") + "\n", "utf-8");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "legacy-import-"));
  mkdirSync(join(dir, "sessions", cwdToBucketName(CWD)), { recursive: true });
  neutralStore = new NeutralSessionStore(mkdtempSync(join(tmpdir(), "legacy-neutral-")));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("importLegacyPiSessions", () => {
  it("旧命名文件导入中立层:内容/内核线索/头域字段齐备", () => {
    const bucket = join(dir, "sessions", cwdToBucketName(CWD));
    writeSession(join(bucket, "2026-01-01_abcd1234.jsonl")); // 旧时间戳命名
    const r = importLegacyPiSessions(dir, neutralStore);
    expect(r).toEqual({ imported: 1, skipped: 0, failed: 0 });
    const s = neutralStore.get("2026-01-01_abcd1234");
    expect(s).toBeTruthy();
    expect(s!.header.kernel).toBe("pi");
    expect(s!.header.cwd).toBe(CWD);
    expect(s!.lineages[0].entries.map((e) => e.message.role)).toEqual(["user", "assistant"]);
    // 中立 entryId 按序派生;内核条目 id 留作投影线索
    expect(s!.lineages[0].entries[0].neutralEntryId).toBe("2026-01-01_abcd1234:0");
    expect(s!.lineages[0].entries[0].kernelEntryId).toBe("e1");
  });

  it("文件头带 neutralSessionId 的以它立档(新派生命名优先)", () => {
    const bucket = join(dir, "sessions", cwdToBucketName(CWD));
    writeSession(join(bucket, "random-stamp.jsonl"), { customNs: "ns-real" });
    const r = importLegacyPiSessions(dir, neutralStore);
    expect(r.imported).toBe(1);
    expect(neutralStore.get("ns-real")?.header.pinned).toBe(true);
    expect(neutralStore.get("random-stamp")).toBeNull(); // 不按文件名再立一份
  });

  it("幂等:已有中立会话的跳过;二次运行零导入", () => {
    const bucket = join(dir, "sessions", cwdToBucketName(CWD));
    writeSession(join(bucket, "ns-has.jsonl"));
    // 预置中立层
    let existing = emptyNeutralSession("ns-has", { kernel: "pi", cwd: CWD, createdAt: "t" });
    existing = appendNeutralEntry(existing, "ns-has", { neutralEntryId: "ns-has:0", message: { role: "user", content: "已有" } });
    neutralStore.put(existing);
    const r1 = importLegacyPiSessions(dir, neutralStore);
    expect(r1).toEqual({ imported: 0, skipped: 1, failed: 0 });
    // 内容未被覆盖
    expect(neutralStore.get("ns-has")!.lineages[0].entries).toHaveLength(1);
    const r2 = importLegacyPiSessions(dir, neutralStore);
    expect(r2.imported).toBe(0);
  });

  it("损坏文件/缺 cwd 跳过且不中断整批", () => {
    const bucket = join(dir, "sessions", cwdToBucketName(CWD));
    writeFileSync(join(bucket, "broken.jsonl"), "{ 这不是合法 JSONL\n", "utf-8");
    writeSession(join(bucket, "ok.jsonl"));
    const r = importLegacyPiSessions(dir, neutralStore);
    expect(r.imported).toBe(1);
    expect(r.failed).toBe(1); // broken 计入 failed,不中断 ok
    expect(neutralStore.get("ok")).toBeTruthy();
  });
});
