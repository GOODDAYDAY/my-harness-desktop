// demo 录制前的桌面偏好(prefs)管理 —— 快照 / 打补丁 / 恢复。
//
// prefs 落点:~/.pi-desktop-dev/config/config.json(electron-store,显式 cwd 进数据根 config 树,
// 见 bootstrap/index.ts)。npm start 跑 electron .(app.isPackaged=false)走 dev 数据根。
//
// 零污染策略:录制前整份快照,每遍运行前打补丁(currentLocale + 基线主题),
// 全部运行结束(kill 之后)整份恢复——应用运行期对 prefs 的写入随 kill 作废。
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const PREFS_FILE = join(homedir(), ".pi-desktop-dev", "config", "config.json");

/** 读整份 prefs 原文(不存在返回 null,恢复时据此决定是否删除)。 */
export function snapshotPrefs() {
  return existsSync(PREFS_FILE) ? readFileSync(PREFS_FILE, "utf-8") : null;
}

/** 合并写 prefs 顶层 key(启动前调用,应用 hydrate 时读到)。 */
export function patchPrefs(patch) {
  let data = {};
  if (existsSync(PREFS_FILE)) {
    try {
      data = JSON.parse(readFileSync(PREFS_FILE, "utf-8"));
    } catch {
      data = {};
    }
  }
  Object.assign(data, patch);
  writeFileSync(PREFS_FILE, JSON.stringify(data, null, 2), "utf-8");
}

/** 恢复录制前原文;录制前不存在则删除(应用运行期会新建)。 */
export function restorePrefs(snapshot) {
  if (snapshot === null) {
    if (existsSync(PREFS_FILE)) unlinkSync(PREFS_FILE);
    return;
  }
  writeFileSync(PREFS_FILE, snapshot, "utf-8");
}
