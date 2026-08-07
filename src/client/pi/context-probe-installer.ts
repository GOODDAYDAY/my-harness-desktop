/**
 * context-probe installer —— 把 packages/context-probe/index.ts 拷贝到 ~/.pi/agent/extensions/context-probe/index.ts。
 *
 * 与 toolgate-installer 同一模式(同约束):写底座目录、读 app 资源是流出适配(client/pi);
 * 底座 loader 只在 spawn 时扫一次扩展目录,所以只在 app 启动时同步一次,
 * 已运行的 pi 进程不热更(重启 desktop 后新 spawn 才生效)。
 * 拷贝策略:按内容 diff,相同跳过不浪费 fs 写。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { app } from "electron";
import { homedir } from "node:os";

const EXT_FILE_TARGET = join(homedir(), ".pi", "agent", "extensions", "context-probe", "index.ts");

/** packages/context-probe/index.ts 的绝对路径(dev: __dirname=out/main → 仓库根;pkg: resources/pi-context-probe/)。 */
function sourcePath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "pi-context-probe", "index.ts")
    : resolve(__dirname, "../../packages/context-probe/index.ts");
}

/** 同步 extension 源码到底座。任何异常都不让 app crash——探针是可选能力,写入失败就当未安装。 */
export function installContextProbe(): { installed: boolean; path: string; changed: boolean } {
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
    console.log(`[context-probe] installed → ${EXT_FILE_TARGET}`);
    return { installed: true, path: EXT_FILE_TARGET, changed: true };
  } catch (err) {
    console.error("[context-probe] install failed:", (err as Error).message);
    return { installed: false, path: EXT_FILE_TARGET, changed: false };
  }
}
