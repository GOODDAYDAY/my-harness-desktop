import { describe, it, expect } from "vitest";
import { deriveSessionTitle, parseSessionModelPrefs } from "./sessions";
import { truncateSessionName, SESSION_NAME_DISPLAY_MAX } from "./text";

describe("parseSessionModelPrefs 的内核字段窄化(不透明 string)", () => {
  // KernelId = string(不透明):内核 id 由插件声明、经 KernelRegistry 运行时注册,核心不硬编码
  // 内核名,任何 string 都是合法内核 id——isKernelId 收敛为 typeof v === "string"。
  it("kernel 为任意 string 时保留(内核 id 由插件声明)", () => {
    const prefs = parseSessionModelPrefs({ model: { provider: "p", modelId: "m", thinkingLevel: "", kernel: "custom-kernel" } });
    expect(prefs?.kernel).toBe("custom-kernel");
  });
  // 非 string 值仍被拒(undefined,不静默落默认内核)
  it("kernel 非 string 时被拒(undefined)", () => {
    expect(parseSessionModelPrefs({ model: { provider: "p", modelId: "m", thinkingLevel: "", kernel: 123 as unknown as string } })?.kernel).toBeUndefined();
  });

  // r367:真实世界损坏形态的容错面(半写/断电后的 custom.model)——每个损坏形态
  // 都必须安全落到 null 或降级,绝不能抛错炸掉调用方(会话列表渲染/发送链全依赖它)。
  it("损坏形态容错:model 非对象 → null(断电半写)", () => {
    expect(parseSessionModelPrefs({ model: "半写的字符串" })).toBeNull();
    expect(parseSessionModelPrefs({ model: 42 })).toBeNull();
    expect(parseSessionModelPrefs({ model: null })).toBeNull();
    expect(parseSessionModelPrefs({ model: [] })).toBeNull(); // 数组也是非模型对象
  });

  it("损坏形态容错:缺关键字段 → null(部分字段写穿失败)", () => {
    expect(parseSessionModelPrefs({ model: { provider: "p" } })).toBeNull(); // 缺 modelId/thinkingLevel
    expect(parseSessionModelPrefs({ model: { provider: "p", modelId: "m" } })).toBeNull(); // 缺 thinkingLevel
    expect(parseSessionModelPrefs({ model: { provider: 123, modelId: "m", thinkingLevel: "" } })).toBeNull(); // provider 类型错
  });

  it("损坏形态容错:kernel 缺/坏 → 降级 undefined 而非整体拒(域级容错)", () => {
    // kernel 字段损坏不该把整份偏好丢掉——provider/modelId 还有效,内核由读回侧再解析
    const p = parseSessionModelPrefs({ model: { provider: "p", modelId: "m", thinkingLevel: "" } });
    expect(p).toEqual({ provider: "p", modelId: "m", thinkingLevel: "", kernel: undefined });
    const p2 = parseSessionModelPrefs({ model: { provider: "p", modelId: "m", thinkingLevel: "", kernel: 99 } });
    expect(p2?.kernel).toBeUndefined();
  });

  it("custom 整个 undefined / 空对象 → null(无偏好的正常态)", () => {
    expect(parseSessionModelPrefs(undefined)).toBeNull();
    expect(parseSessionModelPrefs({})).toBeNull();
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
