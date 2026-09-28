// 思考档位派生规则单测 —— 覆盖 e2e 覆盖不到的分支。
//
// 为什么需要它：`kernel-thinking-matrix.e2e.mjs` 幕D 验的是 **dsh**（precise 语义、清单非空）
// 的真实渲染；而 **pi 的 `approximate` 回落分支**（内核清单为空时用 DEFAULT_LEVELS）
// 在 e2e 里不会触发——pi 的 `get_available_thinking_levels` 正常都返非空。
// 那条分支恰恰是「拿默认清单伪造可切」与「诚实回落」的分界，必须有测试钉住。
import { describe, it, expect } from "vitest";
import { deriveThinkingLevels, shouldHintThinkingUnavailable } from "./thinking-levels";

const FALLBACK = ["off", "low", "high"];

describe("deriveThinkingLevels：三种结果各对应一种真实状态", () => {
  it("无 thinking 面 → 空（该内核没有档位概念，下拉不画）", () => {
    // minimal 的形状：fileBacked 但一个能力面都没有
    expect(deriveThinkingLevels({
      faces: { fileBacked: true }, levelsSemantics: "precise", fromKernel: ["low"], fallback: FALLBACK,
    })).toEqual([]);
  });

  it("approximate + 内核清单为空 → 回落已知默认（pi 的真实形状：RPC 形状不识别时返 []）", () => {
    expect(deriveThinkingLevels({
      faces: { thinking: true }, levelsSemantics: "approximate", fromKernel: [], fallback: FALLBACK,
    })).toEqual(FALLBACK);
  });

  it("approximate + 内核清单非空 → 用内核清单，不回落", () => {
    expect(deriveThinkingLevels({
      faces: { thinking: true }, levelsSemantics: "approximate", fromKernel: ["off", "medium"], fallback: FALLBACK,
    })).toEqual(["off", "medium"]);
  });

  it("precise + 清单为空 → 空（如实表达「该模型无档位」，**不许**拿默认清单伪造可切）", () => {
    // 这条是 §1.5「不伪造成功」的落点：dsh 的清单是模型特定的精确清单，
    // 空 = 该模型无推理元数据/补面缺席，此时渲染默认档位会让用户选到内核不支持的档。
    expect(deriveThinkingLevels({
      faces: { thinking: true }, levelsSemantics: "precise", fromKernel: [], fallback: FALLBACK,
    })).toEqual([]);
  });

  it("precise + 清单非空 → 用内核清单（dsh 补面生效时的真实形状）", () => {
    expect(deriveThinkingLevels({
      faces: { thinking: true }, levelsSemantics: "precise", fromKernel: ["关", "低", "中", "高"], fallback: FALLBACK,
    })).toEqual(["关", "低", "中", "高"]);
  });

  it("语义由内核自报，不由「是不是某个内核」推断：同一份清单换个语义声明就换结果", () => {
    const base = { faces: { thinking: true }, fromKernel: [], fallback: FALLBACK };
    expect(deriveThinkingLevels({ ...base, levelsSemantics: "approximate" })).toEqual(FALLBACK);
    expect(deriveThinkingLevels({ ...base, levelsSemantics: "precise" })).toEqual([]);
  });
});

describe("shouldHintThinkingUnavailable：成员级判据（能查清单 ≠ 能运行时轮转）", () => {
  it("有清单面、无轮转面 → 提示（思考开关置灰并给真实原因）", () => {
    expect(shouldHintThinkingUnavailable({ faces: { thinking: true }, thinkingCycle: false })).toBe(true);
  });

  it("清单面与轮转面都在 → 不提示", () => {
    expect(shouldHintThinkingUnavailable({ faces: { thinking: true }, thinkingCycle: true })).toBe(false);
  });

  it("连清单面都没有 → 不提示（整个思考域本就不渲染，再挂提示是噪声）", () => {
    expect(shouldHintThinkingUnavailable({ faces: {}, thinkingCycle: false })).toBe(false);
    expect(shouldHintThinkingUnavailable({ faces: { fileBacked: true }, thinkingCycle: false })).toBe(false);
  });

  it("不因缺**别的**轴而误提示（逐轴降级的回归守卫：缺多路并发不该影响思考域）", () => {
    // 此前单个 `extension` bit 会让「缺 steering」连带影响所有依赖该 bit 的入口。
    expect(shouldHintThinkingUnavailable({
      faces: { thinking: true, compaction: true, stats: true }, thinkingCycle: true,
    })).toBe(false);
    expect(shouldHintThinkingUnavailable({
      faces: { thinking: true }, thinkingCycle: true,
    })).toBe(false);
  });
});
