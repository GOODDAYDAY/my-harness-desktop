// pi-skill-provider —— pi 内核的技能适配器(实现中立契约 SkillProvider)。
//
// "内核负责读"的 pi 侧消费端:读 pi 扩展播报的完整列表(desktop-skills.json),
// 把内置目录的技能标 source:"builtin",实现两根轴(enabled 写 settings.json 的 +/-、
// modelInvocable 改 frontmatter)。
// 这里读/写的是 pi 自己的存储(settings.json + SKILL.md),合法;壳不碰。
import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withDirLock, writeJsonFile } from "../../../application/config/config-file";
import type { SkillCapabilities, SkillInfo, SkillProvider } from "@my-harness-desktop/shared";
import { skillsBroadcastFile } from "./my-harness-fit-pi-extension-installer";
import { setFrontmatterField } from "../../../application/skills/skill-frontmatter";

const CAPABILITIES: SkillCapabilities = {
  toggleEnabled: true,
  toggleModelInvocable: true,
};

function readSettings(filePath: string): Record<string, unknown> {
  try {
    if (!existsSync(filePath)) return {};
    return JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function stripPrefix(s: string): string {
  return s.startsWith("!") || s.startsWith("+") || s.startsWith("-") ? s.slice(1) : s;
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

export interface PiSkillProviderOptions {
  agentDir: string;
  homeDir: string;
  builtinSkillsDir: string;
  getCwd: () => string | null;
}

export class PiSkillProvider implements SkillProvider {
  readonly capabilities = CAPABILITIES;

  constructor(private readonly opts: PiSkillProviderOptions) {}

  async listSkills(): Promise<SkillInfo[]> {
    const raw = (() => {
      try {
        return JSON.parse(readFileSync(skillsBroadcastFile(), "utf-8")) as SkillInfo[];
      } catch {
        return [];
      }
    })();
    if (!Array.isArray(raw)) return [];
    // 内置目录的技能标 builtin(pi 适配器知道内置目录,这是它在内核层的知识)
    const builtin = this.opts.builtinSkillsDir;
    return raw.map((s) => {
      if (builtin && s.filePath && s.filePath.startsWith(builtin)) {
        return { ...s, source: "builtin" };
      }
      return s;
    });
  }

  async setEnabled(skill: SkillInfo, enabled: boolean): Promise<void> {
    const absPattern = toPosix(skill.filePath ?? "");
    if (!absPattern) return;
    const settingsPath = skill.scope === "project"
      ? join(this.opts.getCwd() ?? "", ".pi", "settings.json")
      : join(this.opts.agentDir, "settings.json");
    const settings = readSettings(settingsPath);
    const current = (settings.skills as string[]) ?? [];
    const filtered = current.filter((entry) => stripPrefix(entry) !== absPattern);
    filtered.push(`${enabled ? "+" : "-"}${absPattern}`);
    await writeJsonFile(settingsPath, { skills: filtered }, "deep");
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
    // 简化:真正的变化由 settings:changed 广播兜底(skill-manager 页面自身订阅 settings 变化重拉)。
    // 播报文件的 mtime 监听留给后续;这里返回 no-op cleanup,契约不破坏。
    void onChanged;
    return () => {};
  }
}
