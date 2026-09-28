// 技能聚合器的**来源路由**守卫 —— 一个会写坏别的内核配置的静默错误。
//
// 背景（本轮修掉的根因）：聚合器此前用 `providers.find(p => p.capabilities[axis])` 取
// **第一个**支持该轴的 provider 来执行开关。它当时安全，文件头注释也写明了前提：
// 「当前 dsh 降级为空列表,只有 pi 有数据,所以开关路由到'支持该轴'的 provider 是安全的」。
// **现在这个前提不成立了**：dsh 补了 `DshSkillProvider`（两轴都 true，播报文件一存在就有数据）。
// 于是点一条 dsh 技能行的开关 → 路由到 pi → `PiSkillProvider.setEnabled(dshSkill)`
// → 把 `+/<dsh 技能路径>` 写进 **pi 的 `~/.pi/agent/settings.json`**：
// 写错了内核的配置，而 dsh 那条技能**根本没被切换**。
// 这正是最坏的一类：不报错、面板看起来"切了"、盘上改的是别人的文件。
//
// 守卫判据：**开关必须落到产出这一行的那个 provider 上，一个字节都不许落到别人身上**。
import { describe, it, expect, vi } from "vitest";
import { SkillAggregator } from "./skill-aggregator";
import type { SkillCapabilities, SkillInfo, SkillProvider } from "@my-harness-desktop/shared";

const BOTH: SkillCapabilities = { toggleEnabled: true, toggleModelInvocable: true };
const NONE: SkillCapabilities = { toggleEnabled: false, toggleModelInvocable: false };

/** 记录型 provider 替身：名字用于断言"调用落到了谁身上"。 */
function makeProvider(name: string, skills: SkillInfo[], capabilities: SkillCapabilities = BOTH) {
  const calls: string[] = [];
  const provider: SkillProvider = {
    capabilities,
    listSkills: () => Promise.resolve(skills),
    setEnabled: (s, enabled) => { calls.push(`enabled:${s.name}:${enabled}`); return Promise.resolve(); },
    setModelInvocable: (s, value) => { calls.push(`invocable:${s.name}:${value}`); return Promise.resolve(); },
    watch: () => () => {},
  };
  return { name, provider, calls };
}

const skill = (name: string, source: string): SkillInfo => ({
  name, description: `${name} desc`, scope: "user", enabled: true, modelInvocable: false, source, filePath: `/${source}/${name}/SKILL.md`,
});

describe("技能聚合器:开关按**来源**路由（不按「谁支持该轴」）", () => {
  it("★ 第二来源支持的轴被启用时，开关仍必须落在**它自己**身上", async () => {
    const a = makeProvider("a", [skill("skill-a", "kern-a")]);
    const b = makeProvider("b", [skill("skill-b", "kern-b")]);
    const agg = new SkillAggregator(() => [a.provider, b.provider]);
    const rows = await agg.listSkills("/proj");

    const rowB = rows.find((r) => r.name === "skill-b")!;
    await agg.setEnabled(rowB, false);
    // 先断言"没写到别人身上"——这样红的时候失败信息直接就是"写错内核了"，
    // 而不是排在后面的"b 没被调用"（后者要读者自己反推第一因）。
    expect(a.calls, "开关落到了**另一个内核**身上 —— 盘上被改的是别人的配置文件，dsh 那条技能根本没切").toEqual([]);
    expect(b.calls, "b 的行必须由 b 处理").toEqual(["enabled:skill-b:false"]);

    const rowA = rows.find((r) => r.name === "skill-a")!;
    await agg.setModelInvocable(rowA, true);
    expect(a.calls).toEqual(["invocable:skill-a:true"]);
    expect(b.calls).toEqual(["enabled:skill-b:false"]);
  });

  it("每行带**它自己来源**的能力标志（不是全局 OR）—— 面板据此按行渲染", async () => {
    const a = makeProvider("a", [skill("skill-a", "kern-a")], BOTH);
    const b = makeProvider("b", [skill("skill-b", "kern-b")], NONE);
    const rows = await new SkillAggregator(() => [a.provider, b.provider]).listSkills("/proj");

    expect(rows.find((r) => r.name === "skill-a")!.capabilities).toEqual(BOTH);
    expect(rows.find((r) => r.name === "skill-b")!.capabilities, "b 不支持任何轴，它的行上就必须是 false（否则面板会按 a 的能力给它画开关）").toEqual(NONE);
    // 全局仍是 OR（问的是"有没有任何来源支持"），但**行级渲染不该用它**
    expect(new SkillAggregator(() => [a.provider, b.provider]).capabilities).toEqual(BOTH);
  });

  it("★ 技能对象经 **IPC 反序列化**（structuredClone）后开关仍要落到来源上", async () => {
    // 真链路：renderer 把 listSkills 拿到的行原样发回来，过一趟 IPC 就是**全新对象**。
    // 按对象身份记账的实现（WeakMap）在这一步全线失效 → 面板每个开关都变静默 no-op，
    // 而单测如果只传同一个引用就会一路绿。这条用例专门钉住"认的是标识，不是引用"。
    const a = makeProvider("a", [skill("skill-a", "kern-a")]);
    const b = makeProvider("b", [skill("skill-b", "kern-b")]);
    const agg = new SkillAggregator(() => [a.provider, b.provider]);
    const rows = await agg.listSkills("/proj");

    const roundTripped = structuredClone(rows.find((r) => r.name === "skill-b")!);
    await agg.setEnabled(roundTripped, false);
    expect(a.calls).toEqual([]);
    expect(b.calls, "过了 IPC 就查不到来源 = 面板开关全失效").toEqual(["enabled:skill-b:false"]);
  });

  it("来源不支持该轴 → 显式跳过并留痕，不路由到别的 provider", async () => {
    const a = makeProvider("a", [skill("skill-a", "kern-a")], NONE);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const agg = new SkillAggregator(() => [a.provider]);
    const row = (await agg.listSkills("/proj"))[0];

    await agg.setEnabled(row, true);
    expect(a.calls, "支持不了就别动（路由到别人更糟）").toEqual([]);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("不支持"))).toBe(true);
    warn.mockRestore();
  });

  it("来源未知的技能对象（不是本次聚合列出的）→ 不猜、不动任何内核，并留痕", async () => {
    const a = makeProvider("a", [skill("skill-a", "kern-a")]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const agg = new SkillAggregator(() => [a.provider]);
    await agg.listSkills("/proj");

    await agg.setEnabled(skill("陌生人", "unknown"), true);
    expect(a.calls, "来源不明的开关不该瞎猜一个 provider").toEqual([]);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("来源未知"))).toBe(true);
    warn.mockRestore();
  });

  it("合并 + 去重 + 排序：同一 filePath 只留一份（两份来源声明同一个技能时不重复列）", async () => {
    const shared = skill("dup", "kern-a");
    const a = makeProvider("a", [shared, skill("zeta", "kern-a")]);
    const b = makeProvider("b", [shared, skill("alpha", "kern-b")]);
    const rows = await new SkillAggregator(() => [a.provider, b.provider]).listSkills("/proj");
    expect(rows.map((r) => r.name)).toEqual(["alpha", "dup", "zeta"]);
  });
});
