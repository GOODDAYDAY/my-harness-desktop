// DshSessionCatalog.rawFilePath 裸单测:原始文件位置是内核专属知识(§7.6)——
// dsh 投影地址是裸 lineageId(坐标系,不是文件路径),真实落盘形状是
// <sessionRoot>/<cwd 桶>/<lineageId>/session.jsonl.zstd。fixture:tmp 目录真文件,不 mock。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cwdToBucketName } from "@my-harness-desktop/shared";
import { DshSessionCatalog } from "./dsh-catalog";

const CWD = "/Users/someone/proj";
let sessionRoot: string;

/** transport 不会被 rawFilePath 用到;给个必炸工厂,误触即暴露。 */
const createTransport = async (): Promise<never> => {
  throw new Error("rawFilePath 不应 spawn dsh transport");
};

beforeEach(() => {
  sessionRoot = mkdtempSync(join(tmpdir(), "dsh-catalog-raw-"));
});

afterEach(() => {
  rmSync(sessionRoot, { recursive: true, force: true });
});

describe("rawFilePath", () => {
  it("会话文件存在 → <root>/<cwd 桶>/<lineageId>/session.jsonl.zstd", () => {
    const lineageId = "810e80f9-ced1-4f11-a364-3873358ccad0";
    const dir = join(sessionRoot, cwdToBucketName(CWD), lineageId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "session.jsonl.zstd"), "");
    const catalog = new DshSessionCatalog({ createTransport, sessionRoot });
    expect(catalog.rawFilePath(CWD, lineageId)).toBe(join(dir, "session.jsonl.zstd"));
  });

  it("会话文件不存在(临时会话/未落盘)→ null,不返回幽灵地址", () => {
    const catalog = new DshSessionCatalog({ createTransport, sessionRoot });
    expect(catalog.rawFilePath(CWD, "missing-lineage")).toBeNull();
  });

  it("sessionRoot 未注入(组装缺面)→ null,显式降级不硬猜", () => {
    const catalog = new DshSessionCatalog({ createTransport });
    expect(catalog.rawFilePath(CWD, "any-lineage")).toBeNull();
  });
});

// ask 续路面(ask-design §5.2/§6.4):进程死亡窗口内直接编辑明文会话日志,
// 追加 tool/result 事件(形状照抄 dsh repair 的合法闭合件)。压缩存量 → 显式降级。
describe("appendToolResult(ask 续路)", () => {
  const lineageId = "lineage-1";

  /** 造一份明文会话日志:header + turn/step 边界 + tool/call(悬空)。 */
  function seedPlainLog(withResult = false): string {
    const dir = join(sessionRoot, cwdToBucketName(CWD), lineageId);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "session.jsonl");
    const lines = [
      JSON.stringify({ type: "session", seq: 0, time: 1, data: { id: lineageId } }),
      JSON.stringify({ type: "turn/start", seq: 1, time: 2, data: { turn: 1 } }),
      JSON.stringify({ type: "step/start", seq: 2, time: 3, data: { turn: 1, step: 1 } }),
      JSON.stringify({ type: "tool/call", seq: 3, time: 4, data: { turn: 1, step: 1, callId: "call_X", name: "ask_user_question", arguments: "{}" } }),
    ];
    if (withResult) {
      lines.push(JSON.stringify({
        type: "tool/result", seq: 4, time: 5,
        data: { turn: 1, step: 1, message: { id: "r", role: "user", source: { kind: "tool", callId: "call_X" }, content: [{ type: "tool-result", toolCallId: "call_X", isError: false, content: [{ type: "text", text: "{}" }] }] } },
        surfaceOp: "append",
      }));
    }
    writeFileSync(file, lines.join("\n") + "\n");
    return file;
  }

  function lastLineOf(file: string): Record<string, unknown> {
    const lines = readFileSync(file, "utf-8").split("\n").filter((l) => l.trim());
    return JSON.parse(lines.at(-1)!) as Record<string, unknown>;
  }

  it("悬空调用 → 追加 tool/result:turn/step 承自 tool/call,surfaceOp/sourceEventSeqs 齐备", async () => {
    const file = seedPlainLog();
    const catalog = new DshSessionCatalog({ createTransport, sessionRoot });
    await catalog.appendToolResult(lineageId, "call_X", { answers: [{ id: "q1", selected: ["A"] }] }, CWD);
    const ev = lastLineOf(file);
    expect(ev.type).toBe("tool/result");
    expect(ev.seq).toBe(4);
    expect(ev.surfaceOp).toBe("append");
    expect(ev.sourceEventSeqs).toEqual([3]);
    const data = ev.data as { turn: number; step: number; message: { source: { callId: string }; content: { toolCallId: string; isError: boolean; content: { text: string }[] }[] } };
    expect(data.turn).toBe(1);
    expect(data.step).toBe(1);
    expect(data.message.source.callId).toBe("call_X");
    expect(data.message.content[0].isError).toBe(false);
    expect(data.message.content[0].content[0].text).toBe(JSON.stringify({ answers: [{ id: "q1", selected: ["A"] }] }));
  });

  it("已配对 → 幂等跳过,文件一字节不动", async () => {
    const file = seedPlainLog(true);
    const before = readFileSync(file, "utf-8");
    const catalog = new DshSessionCatalog({ createTransport, sessionRoot });
    await catalog.appendToolResult(lineageId, "call_X", { answers: [] }, CWD);
    expect(readFileSync(file, "utf-8")).toBe(before);
  });

  it("压缩存量(.zstd)→ 抛错显式降级,不写", async () => {
    const dir = join(sessionRoot, cwdToBucketName(CWD), lineageId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "session.jsonl.zstd"), "compressed");
    const catalog = new DshSessionCatalog({ createTransport, sessionRoot });
    await expect(catalog.appendToolResult(lineageId, "call_X", { answers: [] }, CWD)).rejects.toThrow("压缩形态");
  });

  it("撕裂尾部(不完整末行)→ 先截断再追加,不污染日志", async () => {
    const file = seedPlainLog();
    // 模拟死亡留下的撕裂尾
    writeFileSync(file, readFileSync(file, "utf-8") + '{"type":"tool/res');
    const catalog = new DshSessionCatalog({ createTransport, sessionRoot });
    await catalog.appendToolResult(lineageId, "call_X", { cancelled: true }, CWD);
    const lines = readFileSync(file, "utf-8").split("\n").filter((l) => l.trim());
    // 撕裂半截被截掉,末行是完整 tool/result
    expect(lines.every((l) => JSON.parse(l) !== undefined)).toBe(true);
    const last = JSON.parse(lines.at(-1)!) as { type: string; data: { message: { content: { isError: boolean }[] } } };
    expect(last.type).toBe("tool/result");
    expect(last.data.message.content[0].isError).toBe(true);
  });
});
