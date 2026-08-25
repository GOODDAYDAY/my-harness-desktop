/**
 * skills 能力 —— pi 内核的技能播报。
 * (原 packages/skills-extension/index.ts,收编进统一扩展)
 *
 * 跑在 pi 进程里,是"内核负责读"的 pi 侧实现:session_start 时扫 pi 自己的存储
 * (settings.json + skills 目录),算完整列表(含禁用),写播报文件 ~/.pi/agent/desktop-skills.json。
 * 桌面侧 pi-skill-provider 读这个播报文件,壳不碰 pi 的任何存储。扫描逻辑在 scanner.ts。
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { scanPiSkills } from "./scanner";
import type { ExtensionApi } from "./runtime";

export function setupSkills(pi: ExtensionApi): void {
  let broadcast = false;
  pi.on("session_start", () => {
    if (broadcast) return;
    broadcast = true;
    try {
      const skills = scanPiSkills(process.cwd());
      const dir = join(homedir(), ".pi", "agent");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "desktop-skills.json"), JSON.stringify(skills, null, 2), "utf-8");
    } catch (err) {
      // 扫失败不炸 pi,静默降级(播报文件缺失,桌面侧返回空列表)
      console.error("[skills] scan failed:", err);
    }
  });
}
