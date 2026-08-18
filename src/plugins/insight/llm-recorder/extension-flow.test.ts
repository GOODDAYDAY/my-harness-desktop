import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import llmRecorder, { type RecorderApi } from "./pi-extension/index";
import { pairRecords, parseLogText } from "./core/log-model";

/**
 * llm-recorder 底座扩展的端到端流程测试：用假 pi API 驱动扩展，落盘到临时目录。
 * 核心验证点：seq 跟随会话文件续号——新扩展实例（模拟底座进程重启）接手同一会话
 * 文件时，序号从磁盘最大 seq 续接而不是归零，读侧配对不丢旧记录。
 * 放插件根目录而非 pi-extension/ 内：该目录整体同步到 ~/.pi/agent/extensions/，测试文件不能混进去。
 */

type Handler = (event: unknown, ctx: unknown) => unknown;

/** 假 pi API：实现与 RecorderApi 同签名(契约单源)，handler 存宽签名(调用侧永远用具体事件驱动)。 */
function makeFakePi(): RecorderApi & { fire: (event: string, eventData: unknown, ctx: unknown) => void } {
  const handlers = new Map<string, Handler>();
  return {
    on(event, handler) {
      handlers.set(event, handler as Handler);
    },
    fire(event, eventData, ctx) {
      handlers.get(event)?.(eventData, ctx);
    },
  };
}

const origCwd = process.cwd();
let tmp: string;
let sessionPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llm-recorder-test-"));
  process.chdir(tmp);
  sessionPath = join(tmp, "session-a.jsonl");
});

afterAll(() => {
  process.chdir(origCwd);
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function logFilePath(): string {
  return join(tmp, ".my-harness-desktop", "llm-logs", "session-a.jsonl");
}

function requestSeqNums(): number[] {
  const lines = parseLogText(readFileSync(logFilePath(), "utf8"));
  return lines.filter((l) => l.kind === "request").map((l) => l.seq);
}

/** 模拟一次完整 LLM 调用：before(记 request) → after(挂 status) → message_end(写 response)。 */
function fireRequest(pi: ReturnType<typeof makeFakePi>): void {
  const ctx = { sessionManager: { getSessionFile: () => sessionPath } };
  pi.fire("before_provider_request", { payload: { test: true } }, ctx);
  pi.fire("after_provider_response", { status: 200 }, ctx);
  pi.fire("message_end", { message: { role: "assistant" } }, ctx);
}

describe("llm-recorder seq continuation", () => {
  it("新会话 seq 从 1 开始单调递增", () => {
    const pi = makeFakePi();
    llmRecorder(pi);
    fireRequest(pi);
    fireRequest(pi);
    fireRequest(pi);
    expect(requestSeqNums()).toEqual([1, 2, 3]);
  });

  it("进程重启(新扩展实例)后续号,不归零碰撞,旧记录不被顶掉", () => {
    // 第一个底座进程:写 seq 1,2
    const pi1 = makeFakePi();
    llmRecorder(pi1);
    fireRequest(pi1);
    fireRequest(pi1);
    expect(requestSeqNums()).toEqual([1, 2]);

    // 模拟底座进程重启:同一会话文件,新的扩展实例,序号应从磁盘续到 3
    const pi2 = makeFakePi();
    llmRecorder(pi2);
    fireRequest(pi2);
    expect(requestSeqNums()).toEqual([1, 2, 3]);

    // 读侧按 seq 配对,两代记录都在(若归零碰撞,pairs 只剩 [1] 且是新的)
    const pairs = pairRecords(parseLogText(readFileSync(logFilePath(), "utf8")));
    expect(pairs.map((p) => p.seq)).toEqual([3, 2, 1]);
    expect(pairs).toHaveLength(3);
  });
});
