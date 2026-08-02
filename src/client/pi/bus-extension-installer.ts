/**
 * bus-extension installer —— 把 packages/bus-extension/index.ts 拷贝到 ~/.pi/agent/extensions/bus-extension/index.ts。
 *
 * 与 toolgate-installer 同模式(同一交付通道,docs/design/session-bus.md §5.1):
 * 加载顺序在首次 spawn pi 之前(installToolGate 旁),pi 的 loader 才能 discover;
 * 按内容 diff(相同跳过);任何异常不 crash——bus 是可选能力,写入失败就当未安装。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { app } from "electron";
import { homedir } from "node:os";

const EXT_DIR = join(homedir(), ".pi", "agent", "extensions");
const EXT_DIR_TARGET = join(EXT_DIR, "bus-extension");
const EXT_FILE_TARGET = join(EXT_DIR_TARGET, "index.ts");

function sourcePath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "pi-bus-extension", "index.ts")
    : resolve(__dirname, "../../../packages/bus-extension/index.ts");
}

/** 同步 extension 源码到底座。返回 { installed, path, changed }。 */
export function installBusExtension(): { installed: boolean; path: string; changed: boolean } {
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

/** 可用性探测(extension 是否已在底座目录里)。 */
export function busExtensionAvailable(): boolean {
  return existsSync(EXT_FILE_TARGET);
}
