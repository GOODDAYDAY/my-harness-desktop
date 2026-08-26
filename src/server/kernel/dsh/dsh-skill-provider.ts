// dsh-skill-provider —— dsh 内核的技能适配器(实现中立契约 SkillProvider)。
//
// 与 pi-skill-provider 对称的消费端:dsh 侧 fork 插件(统一适配插件 my-harness-fit-dsh-extension)
// 扫描目录、维护 disabled 名单、把完整列表(含禁用)写播报文件 ~/.dsh/desktop-skills.json,
// 这里读播报文件、转发开关意图(setEnabled 写 disabled 名单、setModelInvocable 改 frontmatter)。
// 壳不读任何 dsh 存储的扫描细节——读/写都是 dsh 侧的约定文件,由内核插件与适配器共同拥有。
import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withDirLock, writeJsonFile } from "../../application/config/config-file";
import type { SkillCapabilities, SkillInfo, SkillProvider } from "@my-harness-desktop/shared";
import { setFrontmatterField } from "../../application/skills/skill-frontmatter";

const CAPABILITIES: SkillCapabilities = {
  toggleEnabled: true,
  toggleModelInvocable: true,
};

export interface DshSkillProviderOptions {
  /** dsh 配置根(~/.dsh),disabled 名单与播报文件都落这里。 */
  dshHome: string;
}

export class DshSkillProvider implements SkillProvider {
  readonly capabilities = CAPABILITIES;

  constructor(private readonly opts: DshSkillProviderOptions) {}

  private get broadcastFile(): string {
    return join(this.opts.dshHome, "desktop-skills.json");
  }

  private get disabledFile(): string {
    return join(this.opts.dshHome, ".my-harness-desktop-disabled-skills.json");
  }

  async listSkills(): Promise<SkillInfo[]> {
    // dsh 侧 fork 插件写播报文件;缺失/损坏降级空列表,不炸。
    try {
      const raw = JSON.parse(readFileSync(this.broadcastFile, "utf-8")) as SkillInfo[];
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }

  private readDisabled(): Set<string> {
    try {
      const raw = JSON.parse(readFileSync(this.disabledFile, "utf-8")) as { skills?: unknown };
      return new Set(Array.isArray(raw?.skills) ? (raw.skills as string[]) : []);
    } catch {
      return new Set();
    }
  }

  async setEnabled(skill: SkillInfo, enabled: boolean): Promise<void> {
    // enabled 轴落地 = disabled 名单(壳写、dsh fork 插件读 + 发现阶段过滤)。
    const disabled = this.readDisabled();
    if (enabled) disabled.delete(skill.name);
    else disabled.add(skill.name);
    await writeJsonFile(this.disabledFile, { skills: [...disabled] }, "deep");
  }

  async setModelInvocable(skill: SkillInfo, value: boolean): Promise<void> {
    if (!skill.filePath) return;
    await withDirLock(dirname(skill.filePath), async () => {
      const content = await readFile(skill.filePath!, "utf-8");
      const next = setFrontmatterField(content, "disable-model-invocation", String(!value));
      await writeFile(skill.filePath!, next, "utf-8");
    });
  }

  watch(_cwd: string, onChanged: () => void): () => void {
    // 播报文件/disabled 名单变化由 api/ipc/skills.ts 的 chokidar 统一监听(与 pi 对称),
    // 这里 no-op:真正的刷新走 skills:changed 广播 → 壳重拉 listSkills。
    void onChanged;
    return () => {};
  }
}
