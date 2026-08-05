/**
 * subagent-extension installer —— 把 packages/subagent-extension/ 同步到
 * ~/.pi/agent/extensions/subagent-extension/(index.ts + runtime.ts + tools/)。
 *
 * 与 bus-extension-installer 同模式(同一交付通道,docs/design/session-bus.md §5.1):
 * 加载顺序在首次 spawn pi 之前(installBusExtension 旁),pi 的 loader 才能 discover;
 * 按内容 diff(相同跳过);任何异常不 crash——subagent 是可选能力,写入失败就当未安装。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { app } from "electron";
import { homedir } from "node:os";

const EXT_DIR_TARGET = join(homedir(), ".pi", "agent", "extensions", "subagent-extension");
const EXT_FILE_TARGET = join(EXT_DIR_TARGET, "index.ts");

function sourceRoot(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "pi-subagent-extension")
    : resolve(__dirname, "../../packages/subagent-extension");
}

/** 同步 extension 源码到底座(index.ts + runtime.ts + tools/)。返回 { installed, path, changed }。 */
export function installSubagentExtension(): { installed: boolean; path: string; changed: boolean } {
  try {
    const srcRoot = sourceRoot();
    const src = join(srcRoot, "index.ts");
    if (!existsSync(src)) return { installed: false, path: EXT_FILE_TARGET, changed: false };
    mkdirSync(EXT_DIR_TARGET, { recursive: true });
    syncFile(join(srcRoot, "index.ts"), EXT_FILE_TARGET);
    syncFile(join(srcRoot, "runtime.ts"), join(EXT_DIR_TARGET, "runtime.ts"));
    syncToolsDir(join(srcRoot, "tools"), join(EXT_DIR_TARGET, "tools"));
    return { installed: true, path: EXT_FILE_TARGET, changed: true };
  } catch (err) {
    console.error("[subagent-extension] install failed:", (err as Error).message);
    return { installed: false, path: EXT_FILE_TARGET, changed: false };
  }
}

function syncFile(src: string, target: string): void {
  if (!existsSync(src)) return;
  const content = readFileSync(src, "utf8");
  if (existsSync(target) && readFileSync(target, "utf8") === content) return;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
  console.log(`[subagent-extension] synced → ${target}`);
}

/** tools/*.ts 逐文件同步 + 陈旧清理(tool 删了不留幽灵)。 */
function syncToolsDir(srcDir: string, targetDir: string): void {
  if (!existsSync(srcDir)) return;
  const files = readdirSync(srcDir).filter((f) => f.endsWith(".ts"));
  const wanted = new Set(files);
  if (existsSync(targetDir)) {
    for (const entry of readdirSync(targetDir)) {
      if (!wanted.has(entry)) rmSync(join(targetDir, entry), { force: true });
    }
  }
  mkdirSync(targetDir, { recursive: true });
  for (const file of files) syncFile(join(srcDir, file), join(targetDir, file));
}

/** 可用性探测(extension 是否已在底座目录里)。 */
export function subagentExtensionAvailable(): boolean {
  return existsSync(EXT_FILE_TARGET);
}
