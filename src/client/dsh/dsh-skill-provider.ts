// dsh-skill-provider —— dsh 内核的技能适配器(实现中立契约 SkillProvider)。
//
// 降级版:ds​h 的"完整列表回报"和"关闭"需要 dsh 侧 cordis 插件(在 deepseek-harness 仓库),
// 本仓库做不了,故 capabilities.toggleEnabled=false、listSkills 返回空。这是能力标志驱动的
// 显式降级——壳如实不渲染"启用/禁用"开关,不伪造、不静默。
import type { SkillCapabilities, SkillInfo, SkillProvider } from "../../core/domain/skills";

const CAPABILITIES: SkillCapabilities = {
  toggleEnabled: false,
  toggleModelInvocable: true,
};

export class DshSkillProvider implements SkillProvider {
  readonly capabilities = CAPABILITIES;

  async listSkills(_cwd: string): Promise<SkillInfo[]> {
    // 降级:dsh 的完整列表(含禁用)需要 dsh 插件扩 skill.list,留待 deepseek-harness 仓库。
    return [];
  }

  async setEnabled(): Promise<void> {
    // 降级:无 dsh 关闭插件,no-op。capabilities 报 false,壳不会调。
  }

  async setModelInvocable(): Promise<void> {
    // 降级:无数据可点(frontmatter 改写留待 dsh 插件补齐列表后启用)。
  }

  watch(_cwd: string, _onChanged: () => void): () => void {
    return () => {};
  }
}
