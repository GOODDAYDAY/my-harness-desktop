/**
 * dsh-extension installer —— 桌面插件携带的 dsh cordis 插件的同步/摘除（client/dsh 流出适配）。
 *
 * 对称 pi-extension-installer：pi 的 piExtension 通道把目录同步到 ~/.pi/agent/extensions/，
 * 本通道把 dsh cordis 插件同步到 ~/.dsh/.my-harness-desktop-plugins/<pluginId>/，并在 cordis.yml
 * 挂载 `- id: my-harness-desktop-<pluginId>\n  name: ./.my-harness-desktop-plugins/<pluginId>/index.mjs`
 * 相对路径块（dsh 的 app-boot 支持相对路径 name，相对 cordis.yml 目录解析）。
 *
 * marker 纪律与 pi-extension-installer 一致：同步目录写 .my-harness-desktop-plugin，摘除/对账
 * 只碰带 marker 的目录，不覆盖用户手装的同名目录；cordis.yml 块用固定 id 幂等挂摘。
 *
 * 任何异常都不让 app crash——同步失败只记日志，插件本体照常加载。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findExtensionEntry } from "../kernel-extension";
import type { DshConfigSource } from "./dsh-config-source";

const PLUGINS_ROOT = join(homedir(), ".dsh", ".my-harness-desktop-plugins");
const MARKER_FILE = ".my-harness-desktop-plugin";

function targetDir(pluginId: string): string {
  return join(PLUGINS_ROOT, pluginId);
}

/** cordis.yml 块的 id（带壳前缀，避免与用户自有插件 id 冲突）。 */
function blockId(pluginId: string): string {
  return `my-harness-desktop-${pluginId}`;
}

/** cordis.yml 块的 name（相对 cordis.yml 目录的入口文件路径）。 */
function blockName(pluginId: string, entryFile: string): string {
  return `./.my-harness-desktop-plugins/${pluginId}/${entryFile}`;
}

function hasMarker(pluginId: string): boolean {
  return existsSync(join(targetDir(pluginId), MARKER_FILE));
}

/** 目录内容签名：相对路径 + 文件内容全量拼接（与 pi-extension-installer 的 dirSignature 同语义）。 */
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

/** 同步插件携带的 dsh cordis 插件。返回 { installed, changed }。 */
export function syncPluginDshExtension(
  pluginId: string,
  sourceDir: string,
  dshConfigSource: DshConfigSource,
): { installed: boolean; changed: boolean } {
  const target = targetDir(pluginId);
  try {
    if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
      console.warn(`[dsh-extension] 跳过同步: ${pluginId} 声明的目录不存在 (${sourceDir})`);
      return { installed: false, changed: false };
    }
    const entryFile = findExtensionEntry(sourceDir, [".mjs"]);
    if (entryFile === undefined) {
      console.warn(`[dsh-extension] 跳过同步: ${pluginId} 目录无 .mjs 入口 (${sourceDir})`);
      return { installed: false, changed: false };
    }
    if (existsSync(target) && !hasMarker(pluginId)) {
      console.warn(`[dsh-extension] 跳过同步: ${target} 已被非桌面插件管理的同名目录占用`);
      return { installed: false, changed: false };
    }
    let changed = false;
    if (!(existsSync(target) && dirSignature(target) === dirSignature(sourceDir))) {
      rmSync(target, { recursive: true, force: true });
      mkdirSync(target, { recursive: true });
      cpSync(sourceDir, target, { recursive: true });
      writeFileSync(join(target, MARKER_FILE), pluginId, "utf8");
      changed = true;
      console.log(`[dsh-extension] synced ${pluginId} → ${target}`);
    }
    // 挂载 cordis.yml 块（幂等：同 id 存在则替换 name）。
    dshConfigSource.addPluginBlock(blockId(pluginId), blockName(pluginId, entryFile));
    return { installed: true, changed };
  } catch (err) {
    console.error(`[dsh-extension] sync failed (${pluginId}):`, (err as Error).message);
    return { installed: false, changed: false };
  }
}

/** 摘除插件的 dsh cordis 插件：删 cordis.yml 块 + 删带 marker 的目录。 */
export function removePluginDshExtension(pluginId: string, dshConfigSource: DshConfigSource): void {
  try {
    dshConfigSource.removePluginBlock(blockId(pluginId));
    const target = targetDir(pluginId);
    if (existsSync(target) && hasMarker(pluginId)) {
      rmSync(target, { recursive: true, force: true });
      console.log(`[dsh-extension] removed ${pluginId} ← ${target}`);
    }
  } catch (err) {
    console.error(`[dsh-extension] remove failed (${pluginId}):`, (err as Error).message);
  }
}

/** 启动对账：PLUGINS_ROOT 下带 marker 但不在 activePluginIds 里的目录是孤儿，摘除 + 摘 cordis 块。 */
export function reconcilePluginDshExtensions(
  activePluginIds: ReadonlySet<string>,
  dshConfigSource: DshConfigSource,
): void {
  try {
    if (!existsSync(PLUGINS_ROOT)) return;
    for (const entry of readdirSync(PLUGINS_ROOT)) {
      const dir = join(PLUGINS_ROOT, entry);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      if (!existsSync(join(dir, MARKER_FILE))) continue;
      if (activePluginIds.has(entry)) continue;
      rmSync(dir, { recursive: true, force: true });
      dshConfigSource.removePluginBlock(blockId(entry));
      console.log(`[dsh-extension] 摘除孤儿扩展目录: ${dir}`);
    }
  } catch (err) {
    console.error("[dsh-extension] reconcile failed:", (err as Error).message);
  }
}
