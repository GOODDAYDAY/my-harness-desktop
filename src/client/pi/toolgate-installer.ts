/**
 * tool-gate installer —— 把 packages/toolgate/index.ts 拷贝到 ~/.pi/agent/extensions/tool-gate/index.ts。
 *
 * 为什么放在 client/pi:写底座目录、读 app 资源都是"应用驱动外界"的流出适配(CLAUDE.md §6.2)。
 * 加载顺序:在首次 spawn pi 之前调用,pi 的 loader 才能在下一次启动时 discover 这个 extension。
 * pi 的 loader 只在 spawn 时扫一次 `~/.pi/agent/extensions/`——已经跑着的 pi 不会自动热更,
 * 所以本 installer 只负责"启动时同步一次",版本升级有时差(重启 desktop 才生效)。
 *
 * 拷贝策略:按内容 diff(读俩文件比较;内容相同跳过,不浪费 fs 写)。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { app } from "electron";
import { homedir } from "node:os";

const EXT_DIR = join(homedir(), ".pi", "agent", "extensions");
const EXT_DIR_TARGET = join(EXT_DIR, "tool-gate");
const EXT_FILE_TARGET = join(EXT_DIR_TARGET, "index.ts");

/**
 * packages/toolgate/index.ts 的绝对路径。
 * dev: __dirname=out/main → 仓库根;pkg: 随壳分发在 resources/pi-toolgate/(extraResources 待接,演进)。
 */
function sourcePath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "pi-toolgate", "index.ts")
    : resolve(__dirname, "../../../packages/toolgate/index.ts");
}

/**
 * 同步 extension 源码到底座。返回 { installed, path, changed }。
 * 任何异常都不该让 app crash——tool-gate 是可选能力，写入失败就当未安装。
 */
export function installToolGate(): { installed: boolean; path: string; changed: boolean } {
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
    console.log(`[toolgate] installed → ${EXT_FILE_TARGET}`);
    return { installed: true, path: EXT_FILE_TARGET, changed: true };
  } catch (err) {
    console.error("[toolgate] install failed:", (err as Error).message);
    return { installed: false, path: EXT_FILE_TARGET, changed: false };
  }
}

/** 供 preload / IPC 用的可用性探测——extension 是否已经在底座目录里。 */
export function toolgateAvailable(): boolean {
  return existsSync(EXT_FILE_TARGET);
}

export const TOOLGATE_TARGET_PATH = EXT_FILE_TARGET;
