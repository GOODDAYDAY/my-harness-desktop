// 能力面投影守卫 —— 守「逐轴降级，不是一个 bit 代表一整个桶」。
//
// 背景（根因，勿回退）：`BaseBackend.capabilities` 曾有一个 opaque 桶 `extensions?: unknown`，
// 形状定义在 `kernel/pi/backend/pi-backend-extensions.ts`，壳经 type-only import + `as` 断言收窄。
// 它对 renderer 的投影是**单个** `SessionCapabilities.extension: boolean`，于是：
//   · 「某内核缺多路并发」连带禁掉了它本可有的压缩 / 统计 / 重试入口
//     ——违背「内核同等地位、同等功能」；
//   · 桶还被当**别的轴的代理**用：`session-store` 曾以 `extensions != null` 判「有无文件头可写」
//     （该轴其实是 `fileBacked`），于是 minimal（`fileBacked: true` 但无 pi 面）被误判。
// 现按语义轴分面（圆心 `BackendCapabilities`），投影是纯函数 `projectCapabilityFlags`。
//
// 本文件测的是**投影**这一层：给定后端声明了哪些面，renderer 该看到哪些旗标。
// 不需要搭 SessionStore + 假后端脚手架（那属集成层），纯函数裸测即可（§4.5 可测性判据）。
import { describe, it, expect } from "vitest";
import { projectCapabilityFlags } from "@my-harness-desktop/shared";
import type { BackendCapabilities } from "@my-harness-desktop/shared";

/** 只声明**部分**面的后端（模拟 dsh：有思考档位补面，但无多路并发/统计/工具执行）。 */
const PARTIAL: BackendCapabilities = {
  thinking: { getThinkingLevels: async () => ["low", "high"] },
};

/** 声明「能查清单但不能运行时轮转」的后端（dsh 的真实形状）。 */
const THINKING_NO_CYCLE: BackendCapabilities = {
  thinking: { getThinkingLevels: async () => ["low"] },
};

/** 声明「能查也能轮转」的后端（pi 的真实形状：全局档位表 → approximate）。 */
const THINKING_WITH_CYCLE: BackendCapabilities = {
  thinking: {
    getThinkingLevels: async () => ["off", "low", "high"],
    cycleThinkingLevel: async () => {},
    levelsSemantics: "approximate",
  },
};

describe("逐轴投影：声明哪些面就只有哪些旗标", () => {
  it("只声明 thinking 的后端，不会被判定为「有其它轴」（一个 bit 代表一整个桶的回归守卫）", () => {
    const { faces } = projectCapabilityFlags(PARTIAL);
    expect(faces.thinking).toBe(true);
    // 关键断言：其余轴**缺席**，不是 false 也不是 true——缺席即「无此面」，
    // renderer 逐轴置灰，不会因为「有 thinking」就连带放开 steering/stats。
    expect(faces.steering).toBeUndefined();
    expect(faces.stats).toBeUndefined();
    expect(faces.compaction).toBeUndefined();
    expect(faces.retry).toBeUndefined();
  });

  it("声明多个面时逐轴各自为真（同等地位：不因缺某一轴而抹掉其它轴）", () => {
    const caps: BackendCapabilities = {
      steering: {} as never, compaction: {} as never, stats: {} as never, fileBacked: true,
    };
    const { faces } = projectCapabilityFlags(caps);
    expect(faces.steering).toBe(true);
    expect(faces.compaction).toBe(true);
    expect(faces.stats).toBe(true);
    expect(faces.fileBacked).toBe(true);
    expect(faces.thinking).toBeUndefined();
  });

  it("fileBacked 是独立轴：false 不被误读成「有此面」，且不被任何能力面代理", () => {
    // minimal 的真实形状：文件态内核，但一个 pi 式能力面都没有。
    // 此前壳拿 `extensions != null` 当文件态代理，minimal 因此被误判（根因之一）。
    const { faces } = projectCapabilityFlags({ fileBacked: true });
    expect(faces.fileBacked).toBe(true);
    expect(faces.steering).toBeUndefined();

    const off = projectCapabilityFlags({ fileBacked: false });
    expect(off.faces.fileBacked, "fileBacked: false 必须投影成 false，不能因 `!= null` 变 true").toBe(false);
  });

  it("派生自实际声明，不重列轴名：圆心加一个新轴时投影零改动", () => {
    // 传一个当前 BackendCapabilities 尚未声明的轴名，验证投影是「按实际键派生」而非白名单。
    const future = { thinking: THINKING_NO_CYCLE.thinking, someFutureAxis: {} } as unknown as BackendCapabilities;
    const { faces } = projectCapabilityFlags(future);
    expect(faces).toHaveProperty("someFutureAxis", true);
  });
});

describe("成员级旗标：能查清单 ≠ 能运行时轮转", () => {
  it("有 thinking 面但无 cycleThinkingLevel → thinkingCycle=false（renderer 只置灰开关，不置灰整个思考域）", () => {
    expect(projectCapabilityFlags(THINKING_NO_CYCLE).thinkingCycle).toBe(false);
    expect(projectCapabilityFlags(THINKING_NO_CYCLE).faces.thinking).toBe(true);
  });

  it("有 cycleThinkingLevel → thinkingCycle=true", () => {
    expect(projectCapabilityFlags(THINKING_WITH_CYCLE).thinkingCycle).toBe(true);
  });

  it("无 thinking 面 → thinkingCycle=false（不抛、不伪造）", () => {
    expect(projectCapabilityFlags({}).thinkingCycle).toBe(false);
    expect(projectCapabilityFlags(undefined).thinkingCycle).toBe(false);
  });
});

describe("档位清单语义：决定「空清单」怎么解读", () => {
  it("内核自报 approximate → 原样透传（渲染层可回落已知默认档位）", () => {
    expect(projectCapabilityFlags(THINKING_WITH_CYCLE).levelsSemantics).toBe("approximate");
  });

  it("未声明 → 缺省 precise（诚实优先：空清单就是「该模型无档位」，不许拿默认清单伪造可切）", () => {
    expect(projectCapabilityFlags(THINKING_NO_CYCLE).levelsSemantics).toBe("precise");
    expect(projectCapabilityFlags(undefined).levelsSemantics).toBe("precise");
  });
});

describe("无能力面时的投影", () => {
  it("caps 为 undefined（无激活进程）→ faces 空对象、成员级旗标全否", () => {
    const r = projectCapabilityFlags(undefined);
    expect(r.faces).toEqual({});
    expect(r.thinkingCycle).toBe(false);
    expect(r.levelsSemantics).toBe("precise");
  });
});
