/**
 * pi-extension installer —— 桌面插件携带的底座 extension 的同步/摘除（client/pi 流出适配）。
 *
 * 机制（设计 docs/design/llm-recorder-design.md §5）：插件 manifest 声明 piExtension 相对路径，
 * lifecycle activate 时把 <pluginPath>/<piExtension>/ 同步到 ~/.pi/agent/extensions/<pluginId>/，
 * deactivate/uninstall 时摘除；bootstrap 启动时对账（同步激活插件、摘除孤儿目录）。
 * 与 toolgate 的 bootstrap 常驻不同：这条通道是内容插件私货，随插件启停。
 *
 * marker 纪律：同步完成的目录里写 .pi-desktop-plugin 标记文件（内容为 pluginId）。
 * 摘除与启动对账只碰带标记的目录——用户在 extensions/ 下手装的同名目录不被误删；
 * 同步时目标已存在但无 marker（用户同名扩展）则跳过，不覆盖用户数据。
 *
 * 任何异常都不让 app crash——扩展同步失败只记日志，插件本体照常加载。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const EXT_ROOT = join(homedir(), ".pi", "agent", "extensions");
const MARKER_FILE = ".pi-desktop-plugin";

function targetDir(pluginId: string): string {
  return join(EXT_ROOT, pluginId);
}

function hasMarker(pluginId: string): boolean {
  return existsSync(join(targetDir(pluginId), MARKER_FILE));
}

/** 目录内容签名：相对路径 + 文件内容全量拼接。插件 extension 目录就一两个小文件，直接拼。 */
function dirSignature(dir: string): string {
  const parts: string[] = [];
  const walk = (d: string, prefix: string): void => {
    for (const entry of readdirSync(d).sort()) {
      if (entry === MARKER_FILE) continue;
      const full = join(d, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full, `${prefix}${entry}/`);
        continue;
      }
      parts.push(`${prefix}${entry}\n${readFileSync(full, "utf8")}`);
    }
  };
  walk(dir, "");
  return parts.join("\n---\n");
}

/** 同步插件携带的底座扩展。返回 { installed, path, changed }。 */
export function syncPluginPiExtension(
  pluginId: string,
  sourceDir: string,
): { installed: boolean; path: string; changed: boolean } {
  const target = targetDir(pluginId);
  try {
    if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
      console.warn(`[pi-extension] 跳过同步: ${pluginId} 声明的目录不存在 (${sourceDir})`);
      return { installed: false, path: target, changed: false };
    }
    if (existsSync(target) && !hasMarker(pluginId)) {
      console.warn(`[pi-extension] 跳过同步: ${target} 已被非桌面插件管理的同名扩展占用`);
      return { installed: false, path: target, changed: false };
    }
    if (existsSync(target) && dirSignature(target) === dirSignature(sourceDir)) {
      return { installed: true, path: target, changed: false };
    }
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    cpSync(sourceDir, target, { recursive: true });
    writeFileSync(join(target, MARKER_FILE), pluginId, "utf8");
    console.log(`[pi-extension] synced ${pluginId} → ${target}`);
    return { installed: true, path: target, changed: true };
  } catch (err) {
    console.error(`[pi-extension] sync failed (${pluginId}):`, (err as Error).message);
    return { installed: false, path: target, changed: false };
  }
}

/** 摘除插件的底座扩展。只删带 marker 的目录，无 marker（用户手装同名）不动。 */
export function removePluginPiExtension(pluginId: string): { removed: boolean } {
  const target = targetDir(pluginId);
  try {
    if (!existsSync(target) || !hasMarker(pluginId)) return { removed: false };
    rmSync(target, { recursive: true, force: true });
    console.log(`[pi-extension] removed ${pluginId} ← ${target}`);
    return { removed: true };
  } catch (err) {
    console.error(`[pi-extension] remove failed (${pluginId}):`, (err as Error).message);
    return { removed: false };
  }
}

/** 启动对账：EXT_ROOT 下带 marker 但不在 activePluginIds 里的目录是孤儿
 *  （插件已被删除、或新版本不再声明 piExtension），摘除。 */
export function reconcilePluginPiExtensions(activePluginIds: ReadonlySet<string>): void {
  try {
    if (!existsSync(EXT_ROOT)) return;
    for (const entry of readdirSync(EXT_ROOT)) {
      const dir = join(EXT_ROOT, entry);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      if (!existsSync(join(dir, MARKER_FILE))) continue;
      if (activePluginIds.has(entry)) continue;
      rmSync(dir, { recursive: true, force: true });
      console.log(`[pi-extension] 摘除孤儿扩展目录: ${dir}`);
    }
  } catch (err) {
    console.error("[pi-extension] reconcile failed:", (err as Error).message);
  }
}
