// 启动步骤校验与拓扑排序的单测 —— 纯函数，不需要 mock 任何外层（§4.5 判据）。
//
// 这些测试是"真扫描换掉编译期校验"的**补偿**（设计文档 §3.4.3）：`requires` 从 import 关系
// 变成运行期字符串之后，写错不再编译失败，只会在启动期抛。所以每条规则都要有一个反向测试，
// 证明它真的会抛、且错误消息能定位到文件。
import { describe, it, expect } from "vitest";
import { validateBootStep, topoSort } from "./order";
import type { BootStep, ScannedStep } from "./types";

/** 造一个合法步骤（各测试按需覆盖单个字段）。 */
function step(over: Partial<BootStep> = {}): BootStep {
  return { id: "10-a", scope: "global", failure: "fatal", run: () => {}, ...over };
}
function scanned(id: string, over: Partial<BootStep> = {}): ScannedStep {
  return { file: `${id}.js`, step: step({ id, ...over }) };
}

describe("validateBootStep：七条规则逐条反向验证", () => {
  it("① id 缺失/空串 → 抛，消息点名文件", () => {
    const bad: ScannedStep = { file: "10-a.js", step: step({ id: "" }) };
    expect(() => validateBootStep(bad, [bad])).toThrow(/10-a\.js.*缺少非空的 id/);
    const none: ScannedStep = { file: "10-b.js", step: undefined as unknown as BootStep };
    expect(() => validateBootStep(none, [none])).toThrow(/10-b\.js/);
  });

  it("② id 重复 → 抛，消息列出冲突的两个文件名", () => {
    const a = scanned("10-a");
    const b: ScannedStep = { file: "20-b.js", step: step({ id: "10-a" }) };
    expect(() => validateBootStep(b, [a, b])).toThrow(/重复/);
    expect(() => validateBootStep(b, [a, b])).toThrow(/10-a\.js|20-b\.js/);
  });

  it("③ id 与产物文件名不符 → 抛，并说出应该是什么", () => {
    // 这条规则的存在理由：id 同时是 requires 的引用键与 tie-break 的载体，
    // 与文件名脱钩就会"目录列表说一个顺序、执行是另一个顺序"。
    const bad: ScannedStep = { file: "75-plugin-boot.js", step: step({ id: "plugin-boot" }) };
    expect(() => validateBootStep(bad, [bad])).toThrow(/应为 "75-plugin-boot"/);
  });

  it("④ scope 非法 → 抛（守卫据此判断该断言哪种留痕形状）", () => {
    const bad: ScannedStep = { file: "10-a.js", step: step({ scope: "entity" as never }) };
    expect(() => validateBootStep(bad, [bad])).toThrow(/scope "entity" 非法/);
  });

  it("⑤ failure 非法/缺省 → 抛（缺省值会让「未声明」与「声明 degrade」不可区分）", () => {
    const bad: ScannedStep = { file: "10-a.js", step: step({ failure: "warn" as never }) };
    expect(() => validateBootStep(bad, [bad])).toThrow(/failure "warn" 非法/);
    // 故意造一个缺 failure 的步骤：`as unknown as` 是必要的（这条测试的目的就是喂非法形状），
    // 直接 `as BootStep` 会被 TS 拦下——那恰恰说明类型层已经守住了正常写法。
    const missing: ScannedStep = { file: "10-b.js", step: { id: "10-b", scope: "global", run: () => {} } as unknown as BootStep };
    expect(() => validateBootStep(missing, [missing])).toThrow(/failure "undefined" 非法/);
  });

  it("⑥ run 不是函数 → 抛", () => {
    const bad: ScannedStep = { file: "10-a.js", step: step({ run: undefined as never }) };
    expect(() => validateBootStep(bad, [bad])).toThrow(/run 不是函数/);
  });

  it("⑦ requires 指向不存在的步骤 → 抛（静默忽略会导致以错误顺序执行，症状是 ctx 字段 undefined）", () => {
    const bad = scanned("20-b", { requires: ["10-a", "99-nope"] });
    expect(() => validateBootStep(bad, [scanned("10-a"), bad])).toThrow(/requires 了不存在的步骤 "99-nope"/);
  });

  it("⑦ 自依赖 → 抛（比等到 topoSort 报环更早、更准）", () => {
    const bad = scanned("10-a", { requires: ["10-a"] });
    expect(() => validateBootStep(bad, [bad])).toThrow(/requires 了自己/);
  });

  it("合法的 per-entity + degrade + 多依赖 → 不抛", () => {
    const a = scanned("10-a");
    const b = scanned("20-b");
    const ok = scanned("75-c", { scope: "per-entity", failure: "degrade", requires: ["10-a", "20-b"] });
    expect(() => validateBootStep(ok, [a, b, ok])).not.toThrow();
  });
});

describe("topoSort：顺序由 requires 决定，不由文件名决定", () => {
  it("requires 定义的先后被遵守（即使与字典序相反）", () => {
    // 关键：`90-transport` 依赖 `70-fit`，但字典序 70 < 90 恰好也满足——
    // 所以这里故意用**反向**命名，证明顺序真的来自边而不是前缀。
    const order = topoSort([
      step({ id: "90-late", requires: ["10-early"] }),
      step({ id: "10-early" }),
    ]).map((s) => s.id);
    expect(order).toEqual(["10-early", "90-late"]);

    // 反过来：把"晚"的命名成小前缀，边仍然决定顺序
    const flipped = topoSort([
      step({ id: "20-b", requires: ["80-a"] }),
      step({ id: "80-a" }),
    ]).map((s) => s.id);
    expect(flipped).toEqual(["80-a", "20-b"]);
  });

  it("同入度按 id 字典序 tie-break（把序变成 id 的函数，而非算法实现细节）", () => {
    // 三个互不依赖的步骤，输入顺序故意打乱
    const order = topoSort([
      step({ id: "30-c" }), step({ id: "10-a" }), step({ id: "20-b" }),
    ]).map((s) => s.id);
    expect(order).toEqual(["10-a", "20-b", "30-c"]);
  });

  it("传递依赖被展开（菱形：d 依赖 b、c，两者都依赖 a）", () => {
    const order = topoSort([
      step({ id: "40-d", requires: ["20-b", "30-c"] }),
      step({ id: "30-c", requires: ["10-a"] }),
      step({ id: "20-b", requires: ["10-a"] }),
      step({ id: "10-a" }),
    ]).map((s) => s.id);
    expect(order).toEqual(["10-a", "20-b", "30-c", "40-d"]);
  });

  it("成环 → 抛，且消息说清剩余节点含「环上成员 + 环的下游」", () => {
    // 10-a → 20-b → 30-c → 20-b（环），40-d 依赖 30-c（环的下游，入度永远减不到 0）
    expect(() => topoSort([
      step({ id: "10-a", requires: ["30-c"] }),
      step({ id: "20-b", requires: ["10-a"] }),
      step({ id: "30-c", requires: ["20-b"] }),
      step({ id: "40-d", requires: ["30-c"] }),
    ])).toThrow(/循环依赖/);
    expect(() => topoSort([
      step({ id: "10-a", requires: ["30-c"] }),
      step({ id: "20-b", requires: ["10-a"] }),
      step({ id: "30-c", requires: ["20-b"] }),
      step({ id: "40-d", requires: ["30-c"] }),
    ])).toThrow(/环上成员 \+ 环的下游/);
  });

  it("空表 → 空结果（不抛；空计划的响亮失败在 buildBootPlan 那层，职责不同）", () => {
    expect(topoSort([])).toEqual([]);
  });

  it("requires 里的未知 id 不影响排序（那条由 validateBootStep 规则 7 负责抛，此处只保证不污染计数）", () => {
    const order = topoSort([step({ id: "10-a", requires: ["99-ghost"] })]).map((s) => s.id);
    expect(order).toEqual(["10-a"]);
  });
});
