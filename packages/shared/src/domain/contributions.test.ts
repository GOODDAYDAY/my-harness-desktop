// messageActionApplies 裸单测(圆心纯函数,零 mock)。
//
// 钉住两件事:
// ① 两个谓词各自独立生效(role 与 settled 不互相干扰);
// ② settled 的**粒度是「这一行」而非整个会话**——流式生成中,已落定的历史行照常
//    可分叉/可收藏,只有在飞的 pending 占位行没有锚点。这条是本轮改动的核心裁定:
//    此前四个入口各自判全局 streaming,把整条历史一起禁掉了。
import { describe, it, expect } from "vitest";
import { messageActionApplies, type MessageActionContribution } from "./contributions";
import type { NeutralMessage } from "./events/session-state";

const msg = (role: string, pending?: boolean): Pick<NeutralMessage, "role" | "pending"> =>
  ({ role, pending }) as Pick<NeutralMessage, "role" | "pending">;
const action = (when?: MessageActionContribution["when"]): Pick<MessageActionContribution, "when"> => ({ when });

describe("messageActionApplies:role 谓词(契约原有行为不回退)", () => {
  it("未声明 when:任何 role 都适用", () => {
    expect(messageActionApplies(action(), msg("assistant"))).toBe(true);
    expect(messageActionApplies(action(), msg("user"))).toBe(true);
  });

  it("声明 role 白名单:命中才适用", () => {
    const a = action({ role: ["assistant"] });
    expect(messageActionApplies(a, msg("assistant"))).toBe(true);
    expect(messageActionApplies(a, msg("user"))).toBe(false);
  });
});

describe("messageActionApplies:settled 谓词(锚点类动作排除在飞的行)", () => {
  it("settled=true:pending 行不适用(在飞的还没进中立层 = 没锚可锚)", () => {
    const a = action({ role: ["assistant"], settled: true });
    expect(messageActionApplies(a, msg("assistant", true))).toBe(false);
  });

  it("settled=true:已落定的行照常适用——流式中历史行仍可分叉/收藏(粒度是行不是会话)", () => {
    const a = action({ role: ["assistant"], settled: true });
    expect(messageActionApplies(a, msg("assistant", false))).toBe(true);
    expect(messageActionApplies(a, msg("assistant", undefined))).toBe(true);
  });

  it("未声明 settled:pending 行也适用(非锚点类动作不受影响,如 continue 续跑)", () => {
    const a = action({ role: ["assistant"] });
    expect(messageActionApplies(a, msg("assistant", true))).toBe(true);
  });
});

describe("messageActionApplies:两个谓词同时声明时都要满足", () => {
  it("role 命中但 pending → 不适用", () => {
    expect(messageActionApplies(action({ role: ["user"], settled: true }), msg("user", true))).toBe(false);
  });

  it("role 不命中 → 不适用(不因 settled 通过而放行)", () => {
    expect(messageActionApplies(action({ role: ["user"], settled: true }), msg("assistant", false))).toBe(false);
  });

  it("两者都满足 → 适用", () => {
    expect(messageActionApplies(action({ role: ["user"], settled: true }), msg("user", false))).toBe(true);
  });
});
