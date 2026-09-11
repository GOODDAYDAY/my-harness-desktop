// pi 旧会话读取面守卫 —— 这段代码从 application 搬进 pi 插件（本轮），所以守卫也跟着搬。
//
// 它守的是「搬了但没搬坏」：
//   ① 真的能读懂 pi 的老格式（头行 + message 行）并交成**中立会话**；
//   ② 名字取对：头行 custom.neutralSessionId 优先，缺省回落到文件名（新派生文件的文件名即 ns）；
//   ③ 坏文件/空文件/缺 cwd **跳过不中断**（诚实降级：宁可少导一个，也不能让启动炸在半路）；
//   ④ **不碰中立层**：去重与落库是壳的事（这层只返回数据，没有 store 参数——签名本身就是守卫）。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLegacyPiSessions } from "./pi-legacy-sessions";

const CWD = "/proj";
let agentDir: string;

/** 写一份"旧命名"（<stamp>_<id>.jsonl）的 pi 会话文件。 */
function writeLegacy(bucket: string, fileName: string, rows: Record<string, unknown>[]): string {
  const dir = join(agentDir, "sessions", bucket);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, fileName);
  writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");
  return p;
}

const msg = (text: string, id: string): Record<string, unknown> => ({
  type: "message",
  id,
  message: { role: "assistant", content: [{ type: "text", text }] },
});

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "pi-legacy-"));
});

afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true });
});

describe("readLegacyPiSessions", () => {
  it("读懂老格式并交成中立会话（单 lineage、条目带 kernelEntryId）", () => {
    writeLegacy("--proj--", "20260101_abc.jsonl", [
      { type: "session", id: "abc", cwd: CWD, timestamp: "2026-01-01T00:00:00.000Z" },
      msg("你好", "e1"),
      msg("世界", "e2"),
    ]);
    const { sessions, failed } = readLegacyPiSessions(agentDir);
    expect(failed).toBe(0);
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.neutralSessionId).toBe("20260101_abc");
    expect(s.header.kernel).toBe("pi");
    expect(s.header.cwd).toBe(CWD);
    expect(s.lineages).toHaveLength(1);
    expect(s.lineages[0].entries.map((e) => e.kernelEntryId)).toEqual(["e1", "e2"]);
  });

  it("ns 优先取头行 custom.neutralSessionId（新派生文件即便被改名也认得出）", () => {
    writeLegacy("--proj--", "whatever.jsonl", [
      { type: "session", id: "x", cwd: CWD, timestamp: "2026-01-01T00:00:00.000Z", "custom-my-harness-desktop": { neutralSessionId: "ns-real" } },
      msg("hi", "e1"),
    ]);
    expect(readLegacyPiSessions(agentDir).sessions[0].neutralSessionId).toBe("ns-real");
  });

  it("缺 cwd / 空会话 / 坏 JSON：跳过并计数，不中断其它文件", () => {
    writeLegacy("--proj--", "no-cwd.jsonl", [{ type: "session", id: "a", timestamp: "2026-01-01T00:00:00.000Z" }, msg("x", "e1")]);
    writeLegacy("--proj--", "empty.jsonl", [{ type: "session", id: "b", cwd: CWD, timestamp: "2026-01-01T00:00:00.000Z" }]);
    // 真·坏文件：头行不是合法 JSON（这才是"损坏"的形态；只是缺字段的头行仍可读，不算坏）
    writeLegacy("--proj--", "broken.jsonl", []);
    writeFileSync(join(agentDir, "sessions", "--proj--", "broken.jsonl"), "{ not json\n" + JSON.stringify(msg("still", "e9")) + "\n", "utf-8");
    writeLegacy("--proj--", "good.jsonl", [{ type: "session", id: "d", cwd: CWD, timestamp: "2026-01-01T00:00:00.000Z" }, msg("ok", "e2")]);
    const { sessions, failed } = readLegacyPiSessions(agentDir);
    expect(sessions.map((s) => s.neutralSessionId)).toEqual(["good"]);
    expect(failed, "坏/空/缺 cwd 都要计入 failed（可观测，不静默）").toBe(3);
  });

  it("会话根不存在：空结果不抛（首次运行就是这种态）", () => {
    expect(readLegacyPiSessions(join(agentDir, "nope"))).toEqual({ sessions: [], failed: 0 });
  });
});
