// 内置 CLAUDE.md 同步 —— application layer,与 bundled-skills 同模式的单文件镜像。
//
// 链路:bootstrap 启动时把随壳分发的 assets/CLAUDE.md 镜像到 ~/.pi-desktop/claude.md
// (本函数);SessionStore spawn 会话时按 prefs.bundledClaudePromptEnabled 拼
// --append-system-prompt <path> 注入底座 system prompt(消费方)。
//
// 关键纪律:
// - 目标文件是"受管副本":源文件是真相,用户要改请改源文件(assets/CLAUDE.md)或 fork。
// - 不碰 pi 底座自生态的 ~/.pi/agent,不混用两者领地。
// - 单文件镜像:无目录树遍历,比镜像 skills 更薄——仅"source 存在则覆盖 target"。
import { cpSync, existsSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function mirrorBundledClaude(sourceFile: string, targetFile: string): void {
  if (!existsSync(sourceFile)) return;
  mkdirSync(dirname(targetFile), { recursive: true });
  cpSync(sourceFile, targetFile);
}
