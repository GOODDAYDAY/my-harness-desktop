import { describe, it, expect } from "vitest";
import { deriveSessionTitle, parseSessionModelPrefs } from "./sessions";
import { truncateSessionName, SESSION_NAME_DISPLAY_MAX } from "./text";
import { KERNEL_IDS } from "./kernel";

describe("parseSessionModelPrefs 的内核字段窄化(字面量谓词与 KERNEL_IDS 单源守卫)", () => {
  // 根因守卫(minimal-kernel §7.8.2):isKernelId 此前手写 v === "pi" || v === "dsh",
  // KernelId 扩第三个内核时它不报编译错,新内核的会话头 kernel 字段会被静默剥成
  // undefined(模型偏好读回断链)。守卫钉死:isKernelId 识别的集合 === KERNEL_IDS,
  // 加内核只改 kernel.ts 一处,本守卫自动跟上;字面量谓词与字面量联合永不再漂。
  it("isKernelId 识别集合 === KERNEL_IDS(经 parseSessionModelPrefs 端到端验)", () => {
    for (const k of KERNEL_IDS) {
      const prefs = parseSessionModelPrefs({ model: { provider: "p", modelId: "m", thinkingLevel: "", kernel: k } });
      expect(prefs?.kernel).toBe(k); // 每个注册内核都该被识别——手写谓词漏新内核时此处即红
    }
    // 非法值仍被拒(undefined,不静默落 pi)
    expect(parseSessionModelPrefs({ model: { provider: "p", modelId: "m", thinkingLevel: "", kernel: "bogus" } })?.kernel).toBeUndefined();
  });
});

describe("deriveSessionTitle 派生会话显示名", () => {
  it("自定义名优先", () => {
    expect(deriveSessionTitle({ name: "修登录", lastMessage: "帮我修登录", id: "aaaa1111" })).toBe("修登录");
  });

  it("无名字回落 lastMessage 预览(问题 B:未命名会话不再退化 id 前缀)", () => {
    expect(deriveSessionTitle({ name: undefined, lastMessage: "帮我修复登录页的 bug", id: "aaaa1111" })).toBe("帮我修复登录页的 bug");
  });

  it("无名字无 lastMessage 回落 id 前 8 位", () => {
    expect(deriveSessionTitle({ name: undefined, lastMessage: undefined, id: "aaaa1111-2222" })).toBe("aaaa1111");
  });

  it("空白名字视为无名(trim 后为空)", () => {
    expect(deriveSessionTitle({ name: "   ", lastMessage: "预览", id: "aaaa1111" })).toBe("预览");
  });

  it("超长 lastMessage 按 SESSION_NAME_DISPLAY_MAX 截断", () => {
    const long = "字".repeat(SESSION_NAME_DISPLAY_MAX + 10);
    const out = deriveSessionTitle({ name: undefined, lastMessage: long, id: "aaaa1111" });
    expect(Array.from(out).length).toBe(SESSION_NAME_DISPLAY_MAX + 1); // 20 字 + …
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("truncateSessionName 截断", () => {
  it("折叠连续空白 + trim", () => {
    expect(truncateSessionName("  a\n\t b ")).toBe("a b");
  });
});
