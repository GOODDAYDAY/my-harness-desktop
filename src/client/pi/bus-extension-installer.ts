/**
 * bus-extension installer —— 把 packages/bus-extension/index.ts 拷贝到 ~/.pi/agent/extensions/bus-extension/index.ts。
 *
 * 与 toolgate-installer 同模式(同一交付通道,docs/design/session-bus.md §5.1):
 * 加载顺序在首次 spawn pi 之前(installToolGate 旁),pi 的 loader 才能 discover;
 * 按内容 diff(相同跳过);任何异常不 crash——bus 是可选能力,写入失败就当未安装。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { app } from "electron";
import { homedir } from "node:os";

const EXT_DIR = join(homedir(), ".pi", "agent", "extensions");
const EXT_DIR_TARGET = join(EXT_DIR, "bus-extension");
const EXT_FILE_TARGET = join(EXT_DIR_TARGET, "index.ts");
/** skills 镜像落点:~/.pi/agent/skills 是 pi 默认发现目录(includeDefaults 会扫),
 *  但发现规则只认"子目录里的 SKILL.md"——installer 把源文件 <name>.md 映射成 <name>/SKILL.md。 */
const SKILLS_TARGET_DIR = join(homedir(), ".pi", "agent", "skills", "bus-extension");

function sourcePath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "pi-bus-extension", "index.ts")
    : resolve(__dirname, "../../../packages/bus-extension/index.ts");
}

function skillsSourceDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "pi-bus-extension", "skills")
    : resolve(__dirname, "../../../packages/bus-extension/skills");
}

/** 同步 extension 源码到底座。返回 { installed, path, changed }。 */
export function installBusExtension(): { installed: boolean; path: string; changed: boolean } {
  syncSkills();
  try {
    const src = sourcePath();
    if (!existsSync(src)) return { installed: false, path: EXT_FILE_TARGET, changed: false };
    const content = readFileSync(src, "utf8");
    if (existsSync(EXT_FILE_TARGET)) {
      const existing = readFileSync(EXT_FILE_TARGET, "utf8");
      if (existing === content) {
        return { installed: true, path: EXT_FILE_TARGET, changed: false };
      }
    }
    mkdirSync(dirname(EXT_FILE_TARGET), { recursive: true });
    writeFileSync(EXT_FILE_TARGET, content, "utf8");
    console.log(`[bus-extension] installed → ${EXT_FILE_TARGET}`);
    return { installed: true, path: EXT_FILE_TARGET, changed: true };
  } catch (err) {
    console.error("[bus-extension] install failed:", (err as Error).message);
    return { installed: false, path: EXT_FILE_TARGET, changed: false };
  }
}

/** skills 镜像同步:<name>.md → <target>/<name>/SKILL.md;源里已删的技能目录一并清(防幽灵技能)。 */
function syncSkills(): void {
  try {
    const srcDir = skillsSourceDir();
    if (!existsSync(srcDir)) return;
    const files = readdirSync(srcDir).filter((f) => f.endsWith(".md"));
    const wanted = new Set(files.map((f) => f.replace(/\.md$/, "")));
    if (existsSync(SKILLS_TARGET_DIR)) {
      for (const entry of readdirSync(SKILLS_TARGET_DIR, { withFileTypes: true })) {
        if (entry.isDirectory() && !wanted.has(entry.name)) {
          rmSync(join(SKILLS_TARGET_DIR, entry.name), { recursive: true, force: true });
        }
      }
    }
    for (const file of files) {
      const target = join(SKILLS_TARGET_DIR, file.replace(/\.md$/, ""), "SKILL.md");
      const content = readFileSync(join(srcDir, file), "utf8");
      if (existsSync(target) && readFileSync(target, "utf8") === content) continue;
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, "utf8");
    }
  } catch (err) {
    console.error("[bus-extension] skills sync failed:", (err as Error).message);
  }
}

/** 可用性探测(extension 是否已在底座目录里)。 */
export function busExtensionAvailable(): boolean {
  return existsSync(EXT_FILE_TARGET);
}
