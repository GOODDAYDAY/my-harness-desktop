// assignHints 纯函数单测 —— 前缀唯一性 + 容量边界(设计 DESIGN.md §4)。
import { describe, expect, it } from "vitest";
import { assignDigits, assignHints, DIGIT_CHARS, HINT_CHARS, MAX_HINTS, MAX_SINGLE } from "./hints";

/** 前缀唯一性:任意两个 hint 不互为前缀(一个不是另一个的前缀)。 */
function assertPrefixUnique(hints: string[]): void {
  for (let i = 0; i < hints.length; i++) {
    for (let j = 0; j < hints.length; j++) {
      if (i === j) continue;
      expect(hints[j].startsWith(hints[i]), `${hints[i]} 是 ${hints[j]} 的前缀`).toBe(false);
    }
  }
}

describe("assignHints", () => {
  it("空/负 count 返回空数组", () => {
    expect(assignHints(0)).toEqual([]);
    expect(assignHints(-3)).toEqual([]);
  });

  it("单字符段:a-z 在前,A-Z 在后,区分大小写", () => {
    expect(assignHints(1)).toEqual(["a"]);
    expect(assignHints(2)).toEqual(["a", "b"]);
    expect(assignHints(27)).toEqual([...HINT_CHARS.slice(0, 26), "A"]);
    expect(assignHints(52)).toEqual(HINT_CHARS.split(""));
  });

  it("第 53 个起升级双字符:从尾部让位首字符,前缀唯一", () => {
    const hints = assignHints(53);
    expect(hints).toHaveLength(53);
    expect(hints.slice(0, 51)).toEqual(HINT_CHARS.slice(0, 51).split("")); // a-z + A-Y
    expect(hints[51]).toBe("Za"); // Z 让位,开双字符组
    assertPrefixUnique(hints);
  });

  it("让位一个首字符可容纳 103 个(51 单 + 52 双)", () => {
    const hints = assignHints(103);
    expect(hints).toHaveLength(103);
    expect(hints[51]).toBe("Za");
    expect(hints[102]).toBe("ZZ");
    assertPrefixUnique(hints);
  });

  it("超过 103 再让位一个首字符(容量 52 + 51h)", () => {
    const hints = assignHints(104);
    expect(hints).toHaveLength(104);
    // 单字符 50 个(a-z + A-X),双字符首字符 Y/Z,尾字符 a-z A-Z 循环
    expect(hints.slice(0, 50)).toEqual(HINT_CHARS.slice(0, 50).split(""));
    expect(hints[50]).toBe("Ya");
    expect(hints[51]).toBe("Yb");
    expect(hints[101]).toBe("YZ"); // Y 组最后一个
    expect(hints[102]).toBe("Za"); // 换到 Z 组
    expect(hints[103]).toBe("Zb");
    assertPrefixUnique(hints);
  });

  it("超过 MAX_HINTS 截断,不分配无界多字符", () => {
    const hints = assignHints(MAX_HINTS + 100);
    expect(hints).toHaveLength(MAX_HINTS);
    assertPrefixUnique(hints);
  });

  it("规模扫描:1..MAX_HINTS 全部无重复且数量正确(O(n²) 前缀检查仅在固定 case 做)", () => {
    for (let n = 1; n <= MAX_HINTS; n++) {
      const hints = assignHints(n);
      expect(hints).toHaveLength(n);
      expect(new Set(hints).size).toBe(n);
    }
  });

  it("MAX_SINGLE 与字符表长度一致", () => {
    expect(MAX_SINGLE).toBe(52);
    expect(HINT_CHARS.length).toBe(52);
  });

  it("数字 hint:1-0 十个,超出容量返回 null(并入字母池,前缀唯一保持)", () => {
    expect(DIGIT_CHARS).toBe("1234567890");
    expect(assignDigits(0)).toEqual([]);
    expect(assignDigits(3)).toEqual(["1", "2", "3"]);
    expect(assignDigits(10)).toEqual(DIGIT_CHARS.split(""));
    const over = assignDigits(12);
    expect(over).toHaveLength(12);
    expect(over[9]).toBe("0");
    expect(over[10]).toBeNull();
    expect(over[11]).toBeNull();
  });

  it("数字与字母 hint 首字符不相交(前缀唯一性跨组保持)", () => {
    const digits = assignDigits(10).filter(Boolean) as string[];
    const letters = assignHints(52);
    for (const d of digits) {
      for (const l of letters) {
        expect(l.startsWith(d), `${l} 以数字 ${d} 开头`).toBe(false);
      }
    }
  });
});
