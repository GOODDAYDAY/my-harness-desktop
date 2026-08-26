// skill-aggregator —— 壳侧技能聚合器(只依赖 SkillProvider 接口,不读任何内核存储)。
//
// 聚合多个内核的 SkillProvider,合并 listSkills、按能力标志暴露"这个合并视图支持哪些开关轴"。
// 已知缺口(多内核能力差异):精确意图是"每个技能行按它来源内核的能力标志渲染、开关路由回来源内核",
// 但 SkillInfo 契约无 provider 归属字段(避免内核身份泄漏)。当前 dsh 降级为空列表,只有 pi 有数据,
// 所以开关路由到"支持该轴"的 provider 是安全的;将来 dsh 补齐时需在 SkillInfo 加 provider 归属或按 provider 分组。
import type { SkillCapabilities, SkillInfo, SkillProvider } from "@my-harness-desktop/shared";

export class SkillAggregator {
  constructor(private readonly providers: SkillProvider[]) {}

  get capabilities(): SkillCapabilities {
    return {
      toggleEnabled: this.providers.some((p) => p.capabilities.toggleEnabled),
      toggleModelInvocable: this.providers.some((p) => p.capabilities.toggleModelInvocable),
    };
  }

  async listSkills(cwd: string): Promise<SkillInfo[]> {
    const all: SkillInfo[] = [];
    for (const p of this.providers) {
      all.push(...(await p.listSkills(cwd)));
    }
    const seen = new Set<string>();
    const dedup: SkillInfo[] = [];
    for (const s of all) {
      const key = s.filePath ?? `${s.name}:${s.scope}`;
      if (seen.has(key)) continue;
      seen.add(key);
      dedup.push(s);
    }
    dedup.sort((a, b) => a.name.localeCompare(b.name));
    return dedup;
  }

  private route(enabled: keyof SkillCapabilities): SkillProvider | undefined {
    return this.providers.find((p) => p.capabilities[enabled]);
  }

  async setEnabled(skill: SkillInfo, enabled: boolean): Promise<void> {
    await this.route("toggleEnabled")?.setEnabled(skill, enabled);
  }

  async setModelInvocable(skill: SkillInfo, value: boolean): Promise<void> {
    await this.route("toggleModelInvocable")?.setModelInvocable(skill, value);
  }

  watch(cwd: string, onChanged: () => void): () => void {
    const cleanups = this.providers.map((p) => p.watch(cwd, onChanged));
    return () => { for (const c of cleanups) c(); };
  }
}
