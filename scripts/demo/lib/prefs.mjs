// 录制前后的桌面状态文件管理 —— 快照 / 打补丁 / 种子 / 恢复。
//
// 涉及文件:
//   prefs        ~/.pi-desktop-dev/config/config.json(electron-store,currentLocale/主题基线)
//   notes        ~/.pi-desktop-dev/config/notes.json(种子 ping 笔记;统一配置通道 notes key)
//   tool-manager <cwd>/.pi-desktop/config/tool-manager.json(种子 read-only 工具组)
//
// 零污染策略:录制前整份快照各文件,打补丁/种子,全部运行结束(kill 之后)整份恢复——
// 应用运行期写入随 kill 作废。录制前不存在的文件恢复时删除。
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export const PREFS_FILE = join(homedir(), ".pi-desktop-dev", "config", "config.json");
export const NOTES_FILE = join(homedir(), ".pi-desktop-dev", "config", "notes.json");
export const GENERAL_FILE = join(homedir(), ".pi-desktop-dev", "config", "general.json");

export function snapshotFile(path) {
  return existsSync(path) ? readFileSync(path, "utf-8") : null;
}

export function restoreFile(path, snapshot) {
  if (snapshot === null) {
    if (existsSync(path)) unlinkSync(path);
    return;
  }
  writeFileSync(path, snapshot, "utf-8");
}

export function writeJsonFile(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), "utf-8");
}

export function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

/** 合并写 prefs 顶层 key(启动前调用,应用 hydrate 时读到)。 */
export function patchPrefs(patch) {
  const data = readJsonFile(PREFS_FILE) ?? {};
  Object.assign(data, patch);
  writeJsonFile(PREFS_FILE, data);
}

/** 种子一条 ping 笔记(全局层 notes key),供剧本"笔记直接发 ping"。 */
export function seedPingNote() {
  const doc = readJsonFile(NOTES_FILE) ?? {};
  const notes = Array.isArray(doc.notes) ? doc.notes : [];
  if (!notes.some((n) => n.id === "demo-ping")) {
    notes.push({
      id: "demo-ping",
      title: "ping",
      content: "ping",
      order: notes.length,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }
  writeJsonFile(NOTES_FILE, { ...doc, notes });
}

/** 种子 debugMode(debug-bar 标题栏按钮的开关;构建态默认 false,不种子不出现)。 */
export function seedDebugMode() {
  const doc = readJsonFile(GENERAL_FILE) ?? {};
  writeJsonFile(GENERAL_FILE, { ...doc, debugMode: true });
}

/** 种子 read-only 工具组(项目层,默认开),供剧本"只读工具调度"。 */
export function seedReadOnlyGroup(toolManagerFile) {
  const doc = readJsonFile(toolManagerFile) ?? {};
  const groups = Array.isArray(doc.groups) ? doc.groups : [];
  if (!groups.some((g) => g.id === "read-only")) {
    groups.push({
      id: "read-only",
      name: "read-only",
      description: "demo: read-only tools",
      toolIds: ["read", "grep", "ls", "find"],
      defaultEnabled: true,
    });
  }
  writeJsonFile(toolManagerFile, { ...doc, groups });
}

/** 全局层工具组默认全关——新会话无头行配置时按组默认生效,
 *  配合 read-only(默认开)构成"只读"基线;录制后快照恢复。 */
export function seedToolGroupsAllOff(globalToolManagerFile) {
  const doc = readJsonFile(globalToolManagerFile) ?? {};
  if (!Array.isArray(doc.groups)) return;
  writeJsonFile(globalToolManagerFile, {
    ...doc,
    groups: doc.groups.map((g) => ({ ...g, defaultEnabled: false })),
  });
}
