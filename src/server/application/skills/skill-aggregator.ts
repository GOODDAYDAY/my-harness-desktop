// skill-aggregator —— 壳侧技能聚合器(只依赖 SkillProvider 接口,不读任何内核存储)。
//
// 聚合多个内核的 SkillProvider:合并列表、**按行的来源路由开关**、把每行它自己那份能力标志带上。
//
// ## 本轮修掉的根因（勿回退成"找第一个支持该轴的 provider"）
//
// 此前的实现是 `route(axis) = providers.find(p => p.capabilities[axis])` —— 取**第一个**
// 支持该轴的 provider。它当时是安全的，文件头注释也写明了前提：
// 「当前 dsh 降级为空列表,只有 pi 有数据,所以开关路由到'支持该轴'的 provider 是安全的」。
// **那个前提现在不成立了**：dsh 补了 `DshSkillProvider`（`capabilities` 两轴都 true，
// 播报文件 `~/.dsh/desktop-skills.json` 一存在就有数据）。于是：
//   · 面板里一条 **dsh** 技能行被点开关 → 路由到 pi → `PiSkillProvider.setEnabled(dshSkill)`
//     → 把 `+/<dsh 技能路径>` 写进 **pi 的 `~/.pi/agent/settings.json`**：
//     写错了内核的配置，而且 dsh 那条技能**根本没被切换**（静默错误，最糟的一类）；
//   · `capabilities` 是各 provider 的 **OR**，面板据此给**每一行**画开关 ——
//     于是 dsh 行按 pi 的能力标志渲染，反之亦然。
//
// 修法（契约不变，不往 SkillInfo 里塞内核身份）：**按产出该行的 provider 记账**。
// `listSkills` 时用对象身份建 `WeakMap<SkillInfo, SkillProvider>`，开关按 owner 路由；
// 顺手把 owner 的能力标志**标到那一行**上（`capabilities` 字段），面板按行渲染。
// 所有权未知（壳没列过这个对象）时**不猜**：留痕 + 不动任何内核的配置。
import type { ManagedSkill, SkillCapabilities, SkillInfo, SkillProvider } from "@my-harness-desktop/shared";

export class SkillAggregator {
  /**
   * 技能行的**稳定标识** → 产出它的 provider。
   *
   * ⚠ **不能用对象身份（WeakMap）记账**：开关是从 renderer 发回来的，经 IPC 反序列化后
   * 是一个**全新对象**，引用对不上 → 所有权查不到 → 面板所有开关变成静默 no-op。
   * （第一版就是 WeakMap，单测绿、真链路全废——因为单测里传的是同一个引用。
   * 现在守卫里有一条**过 structuredClone 再调**的用例专门钉这件事。）
   *
   * 标识取 `filePath`（技能文件的绝对路径，天然唯一），缺它时退回 `name:scope`——
   * 与 `listSkills` 的去重键**同一套规则**，两处不一致就会出现"列得出来、切不动"。
   */
  private readonly ownerByKey = new Map<string, SkillProvider>();

  private static keyOf(skill: SkillInfo): string {
    return skill.filePath ?? `${skill.name}:${skill.scope}`;
  }

  constructor(private readonly providers: SkillProvider[]) {}

  /** 合并视图整体支持哪些轴（任一行支持即 true）——空态/表头用；**行级渲染请用行上的 capabilities**。 */
  get capabilities(): SkillCapabilities {
    return {
      toggleEnabled: this.providers.some((p) => p.capabilities.toggleEnabled),
      toggleModelInvocable: this.providers.some((p) => p.capabilities.toggleModelInvocable),
    };
  }

  async listSkills(cwd: string): Promise<ManagedSkill[]> {
    const all: ManagedSkill[] = [];
    for (const p of this.providers) {
      for (const s of await p.listSkills(cwd)) {
        // 记账要记在**返回出去的那个对象**上（第一版记在原对象上、返回的是展开副本 →
        // 开关回来时 WeakMap 查不到 → 所有权丢失，守卫当场抓到）。
        // 展开一次、记一次、也只返回这一次，后续合并/去重都保持同一引用。
        const enriched: ManagedSkill = { ...s, capabilities: p.capabilities };
        this.ownerByKey.set(SkillAggregator.keyOf(s), p);
        all.push(enriched);
      }
    }
    const seen = new Set<string>();
    const dedup: ManagedSkill[] = [];
    for (const s of all) {
      const key = SkillAggregator.keyOf(s);
      if (seen.has(key)) continue;
      seen.add(key);
      dedup.push(s);
    }
    dedup.sort((a, b) => a.name.localeCompare(b.name));
    return dedup;
  }

  /** 产出这一行的 provider。**不按"谁支持该轴"回退**——那正是写错内核配置的老路。 */
  private ownerOf(skill: SkillInfo): SkillProvider | undefined {
    return this.ownerByKey.get(SkillAggregator.keyOf(skill));
  }

  async setEnabled(skill: SkillInfo, enabled: boolean): Promise<void> {
    const p = this.ownerOf(skill);
    if (!p) {
      console.warn(`[skills] 开关来源未知（不是本次聚合列出的行），已跳过：${skill.name}`);
      return;
    }
    if (!p.capabilities.toggleEnabled) {
      console.warn(`[skills] 该技能来源不支持启用/禁用轴，已跳过：${skill.name}`);
      return;
    }
    await p.setEnabled(skill, enabled);
  }

  async setModelInvocable(skill: SkillInfo, value: boolean): Promise<void> {
    const p = this.ownerOf(skill);
    if (!p) {
      console.warn(`[skills] 开关来源未知（不是本次聚合列出的行），已跳过：${skill.name}`);
      return;
    }
    if (!p.capabilities.toggleModelInvocable) {
      console.warn(`[skills] 该技能来源不支持"模型可自动调用"轴，已跳过：${skill.name}`);
      return;
    }
    await p.setModelInvocable(skill, value);
  }

  watch(cwd: string, onChanged: () => void): () => void {
    const cleanups = this.providers.map((p) => p.watch(cwd, onChanged));
    return () => { for (const c of cleanups) c(); };
  }
}
