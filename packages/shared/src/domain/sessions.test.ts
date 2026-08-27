import { describe, it, expect } from "vitest";
import { deriveSessionTitle, truncateSessionName, SESSION_NAME_DISPLAY_MAX } from "./sessions";

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
