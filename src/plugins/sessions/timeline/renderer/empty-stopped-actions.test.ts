// @vitest-environment jsdom
// 空正文终结行的动作区守卫(r361 根因:dsh 中断空内容行的「继续」钮曾因 rowText 空门禁消失)
// —— 检 timeline 行渲染器的门禁逻辑:空 rowText + stopped/error → 动作区仍渲染。
// 行渲染器是内部大组件,此处用「门禁表达式复刻」的最小单测钉死语义(与 index.tsx 同步维护)。
import { describe, it, expect } from "vitest";

/** 与 index.tsx 行内门禁同步的表达式(改动那里必须同步这里——守卫的意义)。 */
function actionsGate(rowText: string, message: { stopped?: boolean; error?: boolean }): boolean {
  return Boolean(rowText || message.stopped === true || message.error === true);
}

describe("空正文终结行的动作区门禁(r361 根因守卫)", () => {
  it("空 rowText + stopped=true → 动作区渲染(dsh 中断空内容的「继续」恢复路径)", () => {
    expect(actionsGate("", { stopped: true })).toBe(true);
  });

  it("空 rowText + error=true → 动作区渲染(error 行的重试/继续入口)", () => {
    expect(actionsGate("", { error: true })).toBe(true);
  });

  it("有 rowText → 恒渲染(旧行为保持)", () => {
    expect(actionsGate("正文", {})).toBe(true);
  });

  it("空 rowText + 非终结态 → 不渲染(普通空行维持原门禁)", () => {
    expect(actionsGate("", {})).toBe(false);
    expect(actionsGate("", { stopped: false, error: false })).toBe(false);
  });

  it("stopped 严格 true 才开(非布尔真值不误开)", () => {
    expect(actionsGate("", { stopped: undefined })).toBe(false);
    expect(actionsGate("", { error: undefined })).toBe(false);
  });
});
