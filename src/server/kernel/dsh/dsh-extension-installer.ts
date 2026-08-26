/**
 * dsh-extension installer —— 桌面壳对 dsh 内核 cordis 插件的同步/摘除（client/dsh 流出适配）。
 *
 * 对称 pi-extension-installer：pi 的 piExtension 通道把目录同步到 ~/.pi/agent/extensions/，
 * 本通道把 dsh cordis 插件同步到 ~/.dsh/.my-harness-desktop-plugins/<id>/，并在 cordis.yml
 * 挂载 `- id: <blockId>\n  name: ./.my-harness-desktop-plugins/<id>/index.mjs` 相对路径块
 * （dsh 的 app-boot 支持相对路径 name，相对 cordis.yml 目录解析）。
 *
 * 两条挂载路径：
 * - 随插件携带（syncPluginDshExtension）：id=插件 id，块 id=my-harness-desktop-<id>，随插件启停。
 * - 统一适配（syncFitDshExtension）：id/块 id=my-harness-fit-dsh-extension，bootstrap 常驻，
 *   合并原 ask/goal/read-claude-md/skill-manager 四个随插件携带的 dsh 插件为一块。
 *
 * marker 纪律与 pi-extension-installer 一致：同步目录写 .my-harness-desktop-plugin，摘除/对账
 * 只碰带 marker 的目录，不覆盖用户手装的同名目录；cordis.yml 块用固定 id 幂等挂摘。
 *
 * 任何异常都不让 app crash——同步失败只记日志，插件本体照常加载。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findExtensionEntry } from "../core/kernel-extension";
import type { DshConfigApi } from "@my-harness-desktop/shared";
import type { DshExtensionManifest } from "./dsh-extension-manifest";

const MARKER_FILE = ".my-harness-desktop-plugin";

/** 同步根(~/.dsh/.my-harness-desktop-plugins)。函数而非模块级 const:测试注入 homedir 时才生效。 */
function pluginsRoot(): string {
  return join(homedir(), ".dsh", ".my-harness-desktop-plugins");
}

/** 统一适配插件的固定 id + cordis 块 id（合并原 4 个随插件携带的 dsh 插件）。 */
export const FIT_DSEXTENSION_ID = "my-harness-fit-dsh-extension";

function targetDir(id: string): string {
  return join(pluginsRoot(), id);
}

/** 随插件携带的 cordis.yml 块 id（带壳前缀，避免与用户自有插件 id 冲突）。 */
function pluginBlockId(pluginId: string): string {
  return `my-harness-desktop-${pluginId}`;
}

/** cordis.yml 块的 name（相对 cordis.yml 目录的入口文件路径）。 */
function blockName(id: string, entryFile: string): string {
  return `./.my-harness-desktop-plugins/${id}/${entryFile}`;
}

function hasMarker(id: string): boolean {
  return existsSync(join(targetDir(id), MARKER_FILE));
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

/** 校验随附目录的 extension.json:缺失/缺 displayName/坏 JSON 时告警(不阻断同步)。
 *  本地 dsh 扩展是自描述结构(index.mjs + extension.json),缺 manifest 会让拓展管理页
 *  回落 cordis id、无描述——这里在同步期就把作者的疏漏喊出来。 */
function warnMissingManifest(id: string, sourceDir: string): void {
  const manifestPath = join(sourceDir, "extension.json");
  if (!existsSync(manifestPath)) {
    console.warn(`[dsh-extension] ${id} 缺 extension.json:拓展管理页将无展示名/描述,请补 { displayName, description }`);
    return;
  }
  try {
    const m = JSON.parse(readFileSync(manifestPath, "utf-8")) as Partial<DshExtensionManifest>;
    if (typeof m.displayName !== "string" || m.displayName.trim() === "") {
      console.warn(`[dsh-extension] ${id} 的 extension.json 缺 displayName:请补展示名`);
    }
  } catch {
    console.warn(`[dsh-extension] ${id} 的 extension.json 不是合法 JSON:无法读取展示元数据`);
  }
}

/** 同步一个 dsh cordis 插件目录到 PLUGINS_ROOT/<id> 并挂 cordis 块 <blockId>。返回 { installed, changed }。 */
function syncExtension(
  id: string,
  blockId: string,
  sourceDir: string,
  dshConfigSource: DshConfigApi,
): { installed: boolean; changed: boolean } {
  const target = targetDir(id);
  try {
    if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
      console.warn(`[dsh-extension] 跳过同步: ${id} 声明的目录不存在 (${sourceDir})`);
      return { installed: false, changed: false };
    }
    const entryFile = findExtensionEntry(sourceDir, [".mjs"]);
    if (entryFile === undefined) {
      console.warn(`[dsh-extension] 跳过同步: ${id} 目录无 .mjs 入口 (${sourceDir})`);
      return { installed: false, changed: false };
    }
    warnMissingManifest(id, sourceDir);
    if (existsSync(target) && !hasMarker(id)) {
      console.warn(`[dsh-extension] 跳过同步: ${target} 已被非桌面插件管理的同名目录占用`);
      return { installed: false, changed: false };
    }
    let changed = false;
    if (!(existsSync(target) && dirSignature(target) === dirSignature(sourceDir))) {
      rmSync(target, { recursive: true, force: true });
      mkdirSync(target, { recursive: true });
      cpSync(sourceDir, target, { recursive: true });
      writeFileSync(join(target, MARKER_FILE), id, "utf8");
      changed = true;
      console.log(`[dsh-extension] synced ${id} → ${target}`);
    }
    // 挂载 cordis.yml 块（幂等：同 id 存在则替换 name）。
    dshConfigSource.addPluginBlock(blockId, blockName(id, entryFile));
    return { installed: true, changed };
  } catch (err) {
    console.error(`[dsh-extension] sync failed (${id}):`, (err as Error).message);
    return { installed: false, changed: false };
  }
}

/** 同步插件携带的 dsh cordis 插件（随插件启停）。返回 { installed, changed }。 */
export function syncPluginDshExtension(
  pluginId: string,
  sourceDir: string,
  dshConfigSource: DshConfigApi,
): { installed: boolean; changed: boolean } {
  return syncExtension(pluginId, pluginBlockId(pluginId), sourceDir, dshConfigSource);
}

/** 同步统一适配插件（bootstrap 常驻，先于任何 dsh spawn）。返回 { installed, changed }。 */
export function syncFitDshExtension(
  sourceDir: string,
  dshConfigSource: DshConfigApi,
): { installed: boolean; changed: boolean } {
  return syncExtension(FIT_DSEXTENSION_ID, FIT_DSEXTENSION_ID, sourceDir, dshConfigSource);
}

/** 摘除插件的 dsh cordis 插件：删 cordis.yml 块 + 删带 marker 的目录。 */
export function removePluginDshExtension(pluginId: string, dshConfigSource: DshConfigApi): void {
  try {
    dshConfigSource.removePluginBlock(pluginBlockId(pluginId));
    const target = targetDir(pluginId);
    if (existsSync(target) && hasMarker(pluginId)) {
      rmSync(target, { recursive: true, force: true });
      console.log(`[dsh-extension] removed ${pluginId} ← ${target}`);
    }
  } catch (err) {
    console.error(`[dsh-extension] remove failed (${pluginId}):`, (err as Error).message);
  }
}

/** 启动对账：PLUGINS_ROOT 下带 marker 但不在 activeIds 里的目录是孤儿，摘除 + 摘 cordis 块。 */
export function reconcilePluginDshExtensions(
  activeIds: ReadonlySet<string>,
  dshConfigSource: DshConfigApi,
): void {
  try {
    const root = pluginsRoot();
    if (!existsSync(root)) return;
    for (const entry of readdirSync(root)) {
      const dir = join(root, entry);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      if (!existsSync(join(dir, MARKER_FILE))) continue;
      if (activeIds.has(entry)) continue;
      rmSync(dir, { recursive: true, force: true });
      dshConfigSource.removePluginBlock(pluginBlockId(entry));
      console.log(`[dsh-extension] 摘除孤儿扩展目录: ${dir}`);
    }
  } catch (err) {
    console.error("[dsh-extension] reconcile failed:", (err as Error).message);
  }
}
