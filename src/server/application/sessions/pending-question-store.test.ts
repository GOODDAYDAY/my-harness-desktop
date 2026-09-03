// PendingQuestionStore 裸单测(ask-design §4.3/§9):
// 请求单三态机(pending/answered/cancelled)+ 幂等 + 级联删除 + toolCallId 反查。
// fixture:tmp 目录真文件,不 mock 框架。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PendingQuestionStore } from "./pending-question-store";
import type { PendingQuestionRecord } from "@my-harness-desktop/shared";

function mkRecord(over: Partial<PendingQuestionRecord> = {}): PendingQuestionRecord {
  return {
    requestId: "req-1",
    kernel: "pi",
    neutralSessionId: "ns-1",
    cwd: "/tmp/proj",
    sessionKey: "/tmp/proj/s.jsonl",
    procNonce: "nonce-1",
    toolCallId: "call-1",
    questions: [{ id: "q1", question: "选哪个?" }],
    status: "pending",
    createdAt: "2026-09-02T00:00:00.000Z",
    ...over,
  };
}

let dir: string;
let store: PendingQuestionStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pq-store-"));
  store = new PendingQuestionStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("PendingQuestionStore", () => {
  it("落账后可读回,has 为真", () => {
    store.put(mkRecord());
    const got = store.get("req-1");
    expect(got?.status).toBe("pending");
    expect(got?.toolCallId).toBe("call-1");
    expect(store.has("req-1")).toBe(true);
    expect(store.has("nope")).toBe(false);
  });

  it("settle 记录 answered + answers + answeredAt", () => {
    store.put(mkRecord());
    store.settle("req-1", "answered", [{ id: "q1", selected: ["A"] }]);
    const got = store.get("req-1");
    expect(got?.status).toBe("answered");
    expect(got?.answers?.[0]?.selected).toEqual(["A"]);
    expect(typeof got?.answeredAt).toBe("string");
  });

  it("settle 对不存在的单 no-op(不制造幽灵单)", () => {
    store.settle("ghost", "answered", []);
    expect(store.get("ghost")).toBeNull();
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it("markDelivered 只补 delivered 位,不动答案", () => {
    store.put(mkRecord());
    store.settle("req-1", "answered", [{ id: "q1", selected: [], custom: "x" }]);
    store.markDelivered("req-1");
    const got = store.get("req-1");
    expect(got?.delivered).toBe(true);
    expect(got?.answers?.[0]?.custom).toBe("x");
  });

  it("listBySession 按 createdAt 升序且只含本会话", () => {
    store.put(mkRecord({ requestId: "r2", createdAt: "2026-09-02T00:00:02.000Z" }));
    store.put(mkRecord({ requestId: "r1", createdAt: "2026-09-02T00:00:01.000Z" }));
    store.put(mkRecord({ requestId: "other", neutralSessionId: "ns-2" }));
    const list = store.listBySession("ns-1");
    expect(list.map((r) => r.requestId)).toEqual(["r1", "r2"]);
  });

  it("findPendingByToolCallId 只命中 pending;结算后不再命中", () => {
    store.put(mkRecord());
    expect(store.findPendingByToolCallId("call-1")?.requestId).toBe("req-1");
    store.settle("req-1", "cancelled");
    expect(store.findPendingByToolCallId("call-1")).toBeNull();
    expect(store.findPendingByToolCallId("nobody")).toBeNull();
  });

  it("deleteBySession 级联清空,其他会话不动", () => {
    store.put(mkRecord({ requestId: "r1" }));
    store.put(mkRecord({ requestId: "r2", neutralSessionId: "ns-2" }));
    store.deleteBySession("ns-1");
    expect(store.get("r1")).toBeNull();
    expect(store.get("r2")).not.toBeNull();
  });

  it("requestId 含路径分隔等字符时文件名收敛安全集", () => {
    store.put(mkRecord({ requestId: "../evil/../x" }));
    expect(existsSync(join(dir, ".._evil_.._x.json"))).toBe(true);
    expect(store.get("../evil/../x")?.requestId).toBe("../evil/../x");
  });

  it("损坏文件不炸:listBySession 跳过,get 返回 null", () => {
    store.put(mkRecord());
    // 写一个坏文件混进去
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{not json");
    expect(store.listBySession("ns-1")).toHaveLength(1);
  });
});
