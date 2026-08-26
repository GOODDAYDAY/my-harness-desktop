/**
 * my-harness-fit-pi-extension installer —— 把 packages/my-harness-fit-pi-extension/ 统一同步到
 * ~/.pi/agent/extensions/my-harness-fit-pi-extension/(index.ts + runtime.ts + 各能力模块 + tools/),
 * 并把 skills/ 镜像到 ~/.pi/agent/skills/bus-extension/(<name>.md → <name>/SKILL.md)。
 *
 * 统一了原 toolgate / context-probe / bus-extension / subagent-extension / skills-extension
 * 五个 installer(同一交付通道,docs/design/session-bus.md §5.1);pi-extension-installer
 * (插件 manifest 声明 piExtension 的私货通道)保持独立。
 *
 * 加载顺序:在首次 spawn pi 之前调用,pi 的 loader 才能在下一次启动时 discover 这个 extension。
 * pi 的 loader 只在 spawn 时扫一次 ~/.pi/agent/extensions/——已跑着的 pi 不会自动热更,
 * 所以本 installer 只负责"启动时同步一次",版本升级有时差(重启 desktop 才生效)。
 * 拷贝策略:按内容 diff(读两文件比较;内容相同跳过,不浪费 fs 写)。任何异常不 crash——
 * 这是可选能力,写入失败就当未安装(裸 pi 优雅退化)。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { app } from "electron";
import { homedir } from "node:os";

const EXT_DIR = join(homedir(), ".pi", "agent", "extensions");
const EXT_DIR_TARGET = join(EXT_DIR, "my-harness-fit-pi-extension");
const EXT_FILE_TARGET = join(EXT_DIR_TARGET, "index.ts");
/** skills 镜像落点:~/.pi/agent/skills 是 pi 默认发现目录(includeDefaults 会扫),
 *  但发现规则只认"子目录里的 SKILL.md"——installer 把源文件 <name>.md 映射成 <name>/SKILL.md。 */
const SKILLS_TARGET_DIR = join(homedir(), ".pi", "agent", "skills", "bus-extension");

/** 需要同步到扩展目录的顶层模块(入口 + 机制 + 各能力)。 */
const TOP_FILES = ["index.ts", "runtime.ts", "toolgate.ts", "context-probe.ts", "bus.ts", "subagent.ts", "skills.ts", "scanner.ts"];

/**
 * packages/my-harness-fit-pi-extension/ 的绝对路径。
 * dev: __dirname=out/main → 仓库根;pkg: 随壳分发在 resources/pi-my-harness-fit-pi-extension/。
 */
function sourceRoot(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "pi-my-harness-fit-pi-extension")
    : resolve(__dirname, "../../packages/my-harness-fit-pi-extension");
}

function syncFile(src: string, target: string): boolean {
  if (!existsSync(src)) return false;
  const content = readFileSync(src, "utf8");
  if (existsSync(target) && readFileSync(target, "utf8") === content) return false;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
  return true;
}

/** tools/*.ts 逐文件同步 + 陈旧清理(tool 删了不留幽灵)。 */
function syncToolsDir(srcDir: string, targetDir: string): boolean {
  let changed = false;
  if (!existsSync(srcDir)) return changed;
  const files = readdirSync(srcDir).filter((f) => f.endsWith(".ts"));
  const wanted = new Set(files);
  if (existsSync(targetDir)) {
    for (const entry of readdirSync(targetDir)) {
      if (!wanted.has(entry)) {
        rmSync(join(targetDir, entry), { force: true });
        changed = true;
      }
    }
  }
  for (const file of files) {
    if (syncFile(join(srcDir, file), join(targetDir, file))) changed = true;
  }
  return changed;
}

/** skills 镜像同步:<name>.md → <target>/<name>/SKILL.md;源里已删的技能目录一并清(防幽灵技能)。 */
function syncSkills(srcDir: string): boolean {
  let changed = false;
  try {
    if (!existsSync(srcDir)) return changed;
    const files = readdirSync(srcDir).filter((f) => f.endsWith(".md"));
    const wanted = new Set(files.map((f) => f.replace(/\.md$/, "")));
    if (existsSync(SKILLS_TARGET_DIR)) {
      for (const entry of readdirSync(SKILLS_TARGET_DIR, { withFileTypes: true })) {
        if (entry.isDirectory() && !wanted.has(entry.name)) {
          rmSync(join(SKILLS_TARGET_DIR, entry.name), { recursive: true, force: true });
          changed = true;
        }
      }
    }
    for (const file of files) {
      const target = join(SKILLS_TARGET_DIR, file.replace(/\.md$/, ""), "SKILL.md");
      if (syncFile(join(srcDir, file), target)) changed = true;
    }
  } catch (err) {
    console.error("[my-harness-fit-pi-extension] skills sync failed:", (err as Error).message);
  }
  return changed;
}

/** 同步扩展源码到内核。返回 { installed, path, changed }。 */
export function installFitPiExtension(): { installed: boolean; path: string; changed: boolean } {
  try {
    const srcRoot = sourceRoot();
    const srcIndex = join(srcRoot, "index.ts");
    if (!existsSync(srcIndex)) return { installed: false, path: EXT_FILE_TARGET, changed: false };
    mkdirSync(EXT_DIR_TARGET, { recursive: true });
    let changed = false;
    for (const file of TOP_FILES) {
      if (syncFile(join(srcRoot, file), join(EXT_DIR_TARGET, file))) changed = true;
    }
    if (syncToolsDir(join(srcRoot, "tools"), join(EXT_DIR_TARGET, "tools"))) changed = true;
    syncSkills(join(srcRoot, "skills"));
    return { installed: true, path: EXT_FILE_TARGET, changed };
  } catch (err) {
    console.error("[my-harness-fit-pi-extension] install failed:", (err as Error).message);
    return { installed: false, path: EXT_FILE_TARGET, changed: false };
  }
}

/** 供 preload / IPC 用的可用性探测——扩展是否已经在内核目录里。 */
export function fitPiExtensionAvailable(): boolean {
  return existsSync(EXT_FILE_TARGET);
}

export const FIT_PI_EXTENSION_TARGET_PATH = EXT_FILE_TARGET;

/** 技能播报文件路径(pi-skill-provider 读)。 */
export function skillsBroadcastFile(): string {
  return join(homedir(), ".pi", "agent", "desktop-skills.json");
}
