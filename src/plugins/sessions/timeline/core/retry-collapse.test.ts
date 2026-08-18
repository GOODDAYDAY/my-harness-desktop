import { describe, it, expect } from "vitest";
import type { NeutralMessage } from "@my-harness-desktop/contract";
import { collapseRetryFailures } from "./retry-collapse";

const fail = (id: string, errorMessage = "Connection error."): NeutralMessage =>
  ({ id, role: "assistant", content: [], stopReason: "error", errorMessage, error: true }) as NeutralMessage;

const ok = (id: string, text = "好的"): NeutralMessage =>
  ({ id, role: "assistant", content: [{ type: "text", text }], stopReason: "stop" }) as NeutralMessage;

const user = (id: string, text = "hi"): NeutralMessage =>
  ({ id, role: "user", content: text }) as NeutralMessage;

describe("collapseRetryFailures", () => {
  it("空流/无失败消息原样通过", () => {
    expect(collapseRetryFailures([], 3)).toEqual([]);
    const msgs = [user("u1"), ok("a1")];
    expect(collapseRetryFailures(msgs, 3)).toEqual(msgs);
  });

  it("单条失败不折叠(未发生重试)", () => {
    const msgs = [user("u1"), fail("e1")];
    expect(collapseRetryFailures(msgs, 3)).toEqual(msgs);
  });

  it("9 条连续同错误失败折叠成一条 divider:重试 8/20,仍未成功", () => {
    const msgs = [user("u1"), ...Array.from({ length: 9 }, (_, i) => fail(`e${i}`))];
    const out = collapseRetryFailures(msgs, 20);
    expect(out).toHaveLength(2);
    const d = out[1];
    expect(d.role).toBe("divider");
    expect(d.kind).toBe("retry");
    expect(d.i18nKey).toBe("timeline.autoRetryFailed");
    expect(d.i18nArgs).toEqual({ count: 8, max: 20 });
    expect(d.tone).toBe("error");
    expect(d.detail).toBe("Connection error.");
    expect(d.id).toBe("e0");
  });

  it("组后紧跟正常 assistant = 恢复:count 含成功那次重试", () => {
    const msgs = [user("u1"), fail("e1"), fail("e2"), ok("a1")];
    const out = collapseRetryFailures(msgs, 20);
    expect(out).toHaveLength(3);
    expect(out[1].i18nKey).toBe("timeline.autoRetryRecovered");
    expect(out[1].i18nArgs).toEqual({ count: 2, max: 20 });
    expect(out[1].tone).toBeUndefined();
    expect(out[2].id).toBe("a1");
  });

  it("组后是 user(失败后用户改发新消息)按未恢复处理", () => {
    const msgs = [fail("e1"), fail("e2"), user("u2")];
    const out = collapseRetryFailures(msgs, 3);
    expect(out[0].i18nKey).toBe("timeline.autoRetryFailed");
    expect(out[0].i18nArgs).toEqual({ count: 1, max: 3 });
  });

  it("aborted(用户停止)不折叠:stopReason 非 error", () => {
    const aborted = { id: "a0", role: "assistant", content: [], stopReason: "aborted", errorMessage: "Request was aborted.", error: true } as NeutralMessage;
    const msgs = [aborted, fail("e1"), fail("e2")];
    const out = collapseRetryFailures(msgs, 3);
    expect(out[0]).toBe(aborted);
    expect(out[1].kind).toBe("retry");
  });

  it("有实质内容的 error 消息不折叠(部分文本+失败)", () => {
    const partial = { id: "p1", role: "assistant", content: [{ type: "text", text: "半截输出" }], stopReason: "error", errorMessage: "Connection error.", error: true } as NeutralMessage;
    const msgs = [partial, fail("e1"), fail("e2")];
    const out = collapseRetryFailures(msgs, 3);
    expect(out[0]).toBe(partial);
    expect(out[1].kind).toBe("retry");
  });

  it("不同 errorMessage 分两组各自折叠", () => {
    const msgs = [fail("e1", "Connection error."), fail("e2", "Connection error."), fail("e3", "429 rate limit"), fail("e4", "429 rate limit")];
    const out = collapseRetryFailures(msgs, 3);
    expect(out).toHaveLength(2);
    expect(out[0].detail).toBe("Connection error.");
    expect(out[1].detail).toBe("429 rate limit");
  });

  it("两段失败被正常消息隔开时各自折叠", () => {
    const msgs = [fail("e1"), fail("e2"), ok("a1"), fail("e3"), fail("e4"), fail("e5")];
    const out = collapseRetryFailures(msgs, 10);
    expect(out.map((m) => m.kind ?? m.role)).toEqual(["retry", "assistant", "retry"]);
    expect(out[0].i18nKey).toBe("timeline.autoRetryRecovered");
    expect(out[2].i18nKey).toBe("timeline.autoRetryFailed");
    expect(out[2].i18nArgs).toEqual({ count: 2, max: 10 });
  });

  it("相邻单条失败不构成组,各自保留", () => {
    const msgs = [fail("e1"), ok("a1"), fail("e2"), ok("a2")];
    expect(collapseRetryFailures(msgs, 3)).toEqual(msgs);
  });
});
