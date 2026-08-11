import { describe, expect, it } from "vitest";
import { comboFromEvent, comboMatches, normalizeKey, parseCombo } from "./combo";

describe("normalizeKey", () => {
  it("别名映射", () => {
    expect(normalizeKey(" ")).toBe("space");
    expect(normalizeKey("Escape")).toBe("esc");
    expect(normalizeKey("ArrowUp")).toBe("up");
    expect(normalizeKey("Enter")).toBe("enter");
    expect(normalizeKey("Backspace")).toBe("backspace");
    expect(normalizeKey("Delete")).toBe("del");
    expect(normalizeKey("F5")).toBe("f5");
  });

  it("单字符小写", () => {
    expect(normalizeKey("K")).toBe("k");
    expect(normalizeKey("/")).toBe("/");
  });

  it("纯修饰键返回 null(不构成绑定)", () => {
    expect(normalizeKey("Meta")).toBeNull();
    expect(normalizeKey("Control")).toBeNull();
    expect(normalizeKey("Shift")).toBeNull();
  });
});

describe("comboFromEvent", () => {
  it("无修饰键单键", () => {
    expect(comboFromEvent({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, key: "k" })).toBe("k");
  });

  it("修饰键按固定顺序 ctrl→alt→shift→meta", () => {
    expect(comboFromEvent({ metaKey: true, ctrlKey: false, altKey: false, shiftKey: true, key: "F" })).toBe("shift+meta+f");
    expect(comboFromEvent({ metaKey: false, ctrlKey: true, altKey: true, shiftKey: false, key: "k" })).toBe("ctrl+alt+k");
  });

  it("纯修饰键返回 null", () => {
    expect(comboFromEvent({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, key: "Shift" })).toBeNull();
  });
});

describe("parseCombo", () => {
  it("合法组合", () => {
    expect(parseCombo("mod+k")).toEqual({ mod: true, ctrl: false, alt: false, shift: false, meta: false, key: "k" });
    expect(parseCombo("ctrl+shift+up")).toEqual({ mod: false, ctrl: true, alt: false, shift: true, meta: false, key: "up" });
    expect(parseCombo("META+ALT+P")).toEqual({ mod: false, ctrl: false, alt: true, shift: false, meta: true, key: "p" });
  });

  it("非法组合返回 null", () => {
    expect(parseCombo("")).toBeNull();
    expect(parseCombo("nonsense+k")).toBeNull(); // 未知修饰键
    expect(parseCombo("ctrl+shift")).toBeNull(); // 主键是修饰键
  });
});

describe("comboMatches", () => {
  it("mod 展开为 meta 或 ctrl", () => {
    expect(comboMatches("mod+k", "meta+k")).toBe(true);
    expect(comboMatches("mod+k", "ctrl+k")).toBe(true);
    expect(comboMatches("mod+k", "meta+shift+k")).toBe(false);
  });

  it("显式修饰键精确匹配", () => {
    expect(comboMatches("ctrl+k", "ctrl+k")).toBe(true);
    expect(comboMatches("ctrl+k", "meta+k")).toBe(false);
    expect(comboMatches("meta+k", "ctrl+k")).toBe(false);
  });

  it("主键不匹配返回 false", () => {
    expect(comboMatches("mod+k", "meta+j")).toBe(false);
    expect(comboMatches("mod+shift+up", "meta+shift+down")).toBe(false);
  });

  it("shift 精确比较", () => {
    expect(comboMatches("mod+shift+f", "shift+meta+f")).toBe(true);
    expect(comboMatches("mod+f", "shift+meta+f")).toBe(false);
  });
});
