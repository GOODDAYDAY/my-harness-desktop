// skills-extension installer —— 把 packages/skills-extension/ 同步到
// ~/.pi/agent/extensions/skills-extension/(index.ts + scanner.ts)。
//
// 与 subagent-extension-installer 同模式(同一交付通道):首次 spawn pi 之前同步,
// pi 的 loader 才能 discover;按内容 diff(相同跳过);任何异常不 crash——skills 播报是
// 可选能力,写入失败就当未安装(pi-skill-provider 读不到播报文件时降级返回空列表)。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { app } from "electron";
import { homedir } from "node:os";

const EXT_DIR_TARGET = join(homedir(), ".pi", "agent", "extensions", "skills-extension");
const BROADCAST_FILE = join(homedir(), ".pi", "agent", "desktop-skills.json");

function sourceRoot(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "pi-skills-extension")
    : resolve(__dirname, "../../packages/skills-extension");
}

export function installSkillsExtension(): { installed: boolean; path: string } {
  try {
    const srcRoot = sourceRoot();
    const src = join(srcRoot, "index.ts");
    if (!existsSync(src)) return { installed: false, path: EXT_DIR_TARGET };
    mkdirSync(EXT_DIR_TARGET, { recursive: true });
    syncFile(join(srcRoot, "index.ts"), join(EXT_DIR_TARGET, "index.ts"));
    syncFile(join(srcRoot, "scanner.ts"), join(EXT_DIR_TARGET, "scanner.ts"));
    return { installed: true, path: EXT_DIR_TARGET };
  } catch (err) {
    console.error("[skills-extension] install failed:", (err as Error).message);
    return { installed: false, path: EXT_DIR_TARGET };
  }
}

function syncFile(src: string, target: string): void {
  if (!existsSync(src)) return;
  const content = readFileSync(src, "utf8");
  if (existsSync(target) && readFileSync(target, "utf8") === content) return;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
}

/** 播报文件路径(pi-skill-provider 读)。 */
export function skillsBroadcastFile(): string {
  return BROADCAST_FILE;
}
