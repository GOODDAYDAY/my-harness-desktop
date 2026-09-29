// 圆心最后 5 个"零测试引用"的纯函数（r150；清完 r147 普查出的 20 个）。
//
// 这 5 个看着都简单，但每个都承载一条会被悄悄改坏的语义：
// · `derivePluginTags` / `resolvePluginTags`：插件的**标签**由贡献内容派生（theme/i18n/management），
//   再与 manifest 自带 tags 合并**去重**。标签驱动扩展页的筛选——漏一个标签，插件就筛不出来。
// · `matchComposerCommandName`：斜杠命令的**大小写不敏感**匹配。若哪天变成大小写敏感，
//   用户敲 `/GOAL` 就不命中了，而 UI 上表现为"命令没反应"。
// · `emptyExecutionState`：会话执行态的**初值形状**。少一个字段，下游读它就是 undefined。
// · `contentHashOf`：内容哈希（djb2），用于会话内容去重/变更检测。
//   它的性质是**确定性 + 无符号**（`>>> 0`），若哪天漏了 `>>> 0`，哈希会变成负数字符串。
//
// ⚠ 按 r141/r143/r147–r149 的纪律覆盖两侧：该命中的命中、**不该命中的不命中**。

import { describe, it, expect } from "vitest";
import { derivePluginTags, resolvePluginTags } from "./contributions";
import { matchComposerCommandName } from "./composer-commands";
import { emptyExecutionState } from "./events/execution-state";
import { contentHashOf, isKernelId } from "./sessions";

describe("derivePluginTags：由贡献内容派生标签", () => {
  it("① 空贡献 / undefined ⇒ 空数组（不该凭空给标签）", () => {
    expect(derivePluginTags(undefined)).toEqual([]);
    expect(derivePluginTags({})).toEqual([]);
    expect(derivePluginTags({ themes: [], languages: [], settings: [] })).toEqual([]);
  });
  it("② 每类贡献各给一个标签：themes→theme、languages→i18n、settings 或 settingsGroups→management", () => {
    expect(derivePluginTags({ themes: [{ id: "t" } as never] })).toEqual(["theme"]);
    expect(derivePluginTags({ languages: [{ id: "zh-CN" } as never] })).toEqual(["i18n"]);
    expect(derivePluginTags({ settings: [{ id: "s" } as never] })).toEqual(["management"]);
    // settingsGroups 也算 management（两条路径同一标签）
    expect(derivePluginTags({ settingsGroups: [{ id: "g" } as never] })).toEqual(["management"]);
  });
  it("③ 多类贡献 ⇒ 标签**按固定顺序**（theme, i18n, management），不受声明顺序影响", () => {
    const out = derivePluginTags({
      settings: [{ id: "s" } as never],
      themes: [{ id: "t" } as never],
      languages: [{ id: "l" } as never],
    });
    expect(out).toEqual(["theme", "i18n", "management"]);
  });
  it("④ settings 与 settingsGroups 同时有 ⇒ management 只出现一次", () => {
    expect(derivePluginTags({ settings: [{ id: "s" } as never], settingsGroups: [{ id: "g" } as never] }))
      .toEqual(["management"]);
  });
});

describe("resolvePluginTags：派生标签 + manifest 自带 tags，合并去重", () => {
  it("① 两边都有且重叠 ⇒ 去重（派生的在前、自带的在后）", () => {
    const out = resolvePluginTags({
      tags: ["theme", "custom"],
      contributes: { themes: [{ id: "t" } as never] },
    });
    expect(out).toEqual(["theme", "custom"]);      // theme 不重复
  });
  it("② 只有自带 tags ⇒ 原样（但仍是新数组，且去重）", () => {
    expect(resolvePluginTags({ tags: ["a", "a", "b"] })).toEqual(["a", "b"]);
  });
  it("③ 两边都空 ⇒ 空数组；tags 缺省不抛", () => {
    expect(resolvePluginTags({})).toEqual([]);
    expect(resolvePluginTags({ contributes: {} })).toEqual([]);
  });
  it("④ 只有派生 ⇒ 只出派生标签", () => {
    expect(resolvePluginTags({ contributes: { languages: [{ id: "l" } as never] } })).toEqual(["i18n"]);
  });
});

describe("matchComposerCommandName：斜杠命令的大小写不敏感匹配", () => {
  const names = ["goal", "compact", "review"];

  it("① 精确命中 ⇒ 返回**清单里的原名**（不是输入的大小写）", () => {
    expect(matchComposerCommandName("/goal 做点什么", names)).toBe("goal");
    expect(matchComposerCommandName("/GOAL x", names), "大小写不敏感").toBe("goal");
    expect(matchComposerCommandName("/Compact", names)).toBe("compact");
  });
  it("② 不该命中的都不命中 ⇒ null", () => {
    expect(matchComposerCommandName("普通消息", names), "不以 / 开头").toBeNull();
    expect(matchComposerCommandName("/unknown", names), "清单里没有").toBeNull();
    expect(matchComposerCommandName("/", names), "只有斜杠").toBeNull();
    expect(matchComposerCommandName("", names)).toBeNull();
  });
  it("③ 整词匹配：/goalish 不该命中 goal（前缀相同但不是同一命令）", () => {
    expect(matchComposerCommandName("/goalish x", names)).toBeNull();
  });
  it("④ 多行输入：命令头只取首行，rest 保留全文（多行 objective 合法）", () => {
    expect(matchComposerCommandName("/goal\n第二行\n第三行", names)).toBe("goal");
  });
  it("⑤ 空清单 ⇒ null（不抛）", () => {
    expect(matchComposerCommandName("/goal", [])).toBeNull();
  });
});

describe("emptyExecutionState：执行态初值形状", () => {
  it("① 全部字段都在且是**空值**（少一个字段下游就读到 undefined）", () => {
    expect(emptyExecutionState()).toEqual({
      busy: false, compacting: false, retry: null, streaming: null,
      inflightTools: {}, effectiveModel: null,
      turn: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
      lastTurn: null, tps: null, turns: 0, steps: 0,
    });
  });
  it("② 每次调用返回**新对象**（共享同一个初值对象会让多个会话互相污染）", () => {
    const a = emptyExecutionState();
    const b = emptyExecutionState();
    expect(a).not.toBe(b);
    expect(a.inflightTools).not.toBe(b.inflightTools);
    expect(a.turn).not.toBe(b.turn);
  });
});

describe("contentHashOf：djb2 内容哈希", () => {
  it("① 确定性：同文本同哈希，不同文本不同哈希", () => {
    expect(contentHashOf("abc")).toBe(contentHashOf("abc"));
    expect(contentHashOf("abc")).not.toBe(contentHashOf("abd"));
  });
  it("② **无符号**：结果是纯数字字符串，不出现负号（`>>> 0` 的作用）", () => {
    for (const s of ["", "a", "会话内容", "x".repeat(500), "\u{1F600}emoji"]) {
      const h = contentHashOf(s);
      expect(h, `『${s.slice(0, 8)}』的哈希应无负号`).not.toContain("-");
      expect(Number.isNaN(Number(h)), `『${s.slice(0, 8)}』的哈希应是数字字符串`).toBe(false);
    }
  });
  it("③ 空串也有稳定哈希（djb2 初值 5381）", () => {
    expect(contentHashOf("")).toBe("5381");
  });
  it("④ 钉桩：已知输入的哈希值（改算法时这条会红 ⇒ 那会改变已落盘内容的去重判定）", () => {
    // 若哪天换哈希算法，会话去重/变更检测的历史判定会变——这条钉桩迫使改动是有意识的。
    // ⚠ 值是**实测**来的：首版按直觉写了 514420305（那是 djb2 的**异或变体** h*33^c 的值），
    //   而本实现是 h*33+c（(h<<5)+h+c）⇒ 实测 193485963。与 r148 的 ratio、r149 的 TurnUsage
    //   同一类：凭直觉写期望、让测试纠正，纠正过程留下注释（下一个人不会再猜）。
    expect(contentHashOf("abc")).toBe("193485963");
  });
});

describe("isKernelId：**形状守卫**（不是成员校验——r150 查明并在契约里写明）", () => {
  it("① 任何字符串都通过（圆心无法枚举合法内核 id：清单由 KernelRegistry 运行时驱动）", () => {
    for (const s of ["pi", "dsh", "minimal", "probe4", "第四内核", ""]) {
      expect(isKernelId(s), `形状上『${s}』是字符串 ⇒ 通过（成员校验不在这一层）`).toBe(true);
    }
  });
  it("② 非字符串一律不通过，且**不抛**（IPC/盘上数据可能是任意形状）", () => {
    for (const bad of [null, undefined, 42, {}, [], true]) {
      expect(() => isKernelId(bad)).not.toThrow();
      expect(isKernelId(bad)).toBe(false);
    }
  });
  it("③ 钉桩：这条**限制**本身（若哪天圆心开始校验成员，这条会红 ⇒ 那是违反 §1.5 的改动）", () => {
    // 圆心若开始拒绝"不在清单里的字符串"，就意味着圆心持有了内核清单——
    // 而 §1.5 要求"加内核 = 写插件、圆心一行不改"（domain/kernel.ts 的 KERNEL_IDS 已因此删除）。
    // 真正的成员校验住在 bootstrap 的路由工厂（kernelRegistry.get 未装载时抛可行动的错误）。
    expect(isKernelId("一个从没注册过的内核名"), "圆心不该做成员校验").toBe(true);
  });
});
