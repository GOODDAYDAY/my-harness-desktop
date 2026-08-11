import { describe, expect, it } from "vitest";
import { DEFAULT_BINDINGS, parseBinding, parseBindings } from "./bindings";

describe("parseBinding", () => {
  it("合法绑定收紧", () => {
    expect(parseBinding({ combo: "mod+k", channel: "timeline:focusComposer" })).toEqual({
      combo: "mod+k",
      channel: "timeline:focusComposer",
    });
    expect(parseBinding({ combo: "mod+shift+down", channel: "timeline:scrollTo", payload: { position: "bottom" } })).toEqual({
      combo: "mod+shift+down",
      channel: "timeline:scrollTo",
      payload: { position: "bottom" },
    });
  });

  it("when 字段收紧", () => {
    expect(parseBinding({ combo: "k", channel: "x", when: "always" })?.when).toBe("always");
    expect(parseBinding({ combo: "k", channel: "x", when: "smart" })?.when).toBe("smart");
    // 非法 when 值丢弃该字段(回退 smart 语义)
    expect(parseBinding({ combo: "k", channel: "x", when: "bogus" })).toEqual({ combo: "k", channel: "x" });
  });

  it("形状非法返回 null", () => {
    expect(parseBinding(null)).toBeNull();
    expect(parseBinding("str")).toBeNull();
    expect(parseBinding({ combo: "mod+k" })).toBeNull();
    expect(parseBinding({ channel: "x" })).toBeNull();
    expect(parseBinding({ combo: "", channel: "x" })).toBeNull();
  });
});

describe("parseBindings", () => {
  it("数组收紧,单条非法整条丢弃", () => {
    const raw = [
      { combo: "mod+k", channel: "a" },
      { combo: "bogus" },
      { combo: "mod+j", channel: "b", payload: 1 },
    ];
    expect(parseBindings(raw)).toEqual([
      { combo: "mod+k", channel: "a" },
      { combo: "mod+j", channel: "b", payload: 1 },
    ]);
  });

  it("非数组返回 null", () => {
    expect(parseBindings(null)).toBeNull();
    expect(parseBindings("x")).toBeNull();
  });
});

describe("DEFAULT_BINDINGS", () => {
  it("全部可被 parseBinding 收紧(默认配置自身合法)", () => {
    const parsed = parseBindings(DEFAULT_BINDINGS);
    expect(parsed).not.toBeNull();
    expect(parsed!.length).toBe(DEFAULT_BINDINGS.length);
  });
});
