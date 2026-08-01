// IPC:插件配置(config:走 ConfigStore)+ 桌面偏好(prefs:走 electron-store)
// + 通用 JSON 配置文件读写(configFile:路径白名单)+ 分层配置。
import { ipcMain } from "electron";
import { join, sep } from "node:path";
import { existsSync, unlinkSync } from "node:fs";
import { readJsonFile, writeJsonFile } from "../../core/application/config/config-file";
import { IPC } from "../preload/ipc-channels";
import { broadcastSettingsChanged } from "./broadcast";
import type { MainContext, Prefs } from "./main-context";

export function registerConfigIpc(ctx: MainContext): void {
  const { configStore, prefsStore, paths } = ctx;

  // ---- IPC:插件配置 ----
  ipcMain.handle(IPC.config.get, (_e, pluginId: string, key: string) =>
    configStore.get<unknown>(pluginId, key),
  );
  ipcMain.handle(
    IPC.config.set,
    async (_e, pluginId: string, key: string, value: unknown) => {
      await configStore.set(pluginId, key, value);
    },
  );
  ipcMain.handle(IPC.config.all, (_e, pluginId: string) => configStore.all(pluginId));

  // ---- IPC:桌面偏好 ----
  ipcMain.handle(IPC.prefs.get, (_e, key: keyof Prefs) => prefsStore.get(key));
  ipcMain.handle(IPC.prefs.set, (_e, key: keyof Prefs, value: unknown) => {
    prefsStore.set(key, value as never);
  });

  // ---- IPC:通用 JSON 配置文件读写(框架级配置管理,路径白名单 + ~ 展开)----
  // 安全门控(§4.6/§8.1):configFile 是框架级通道,限定在 ~/.pi-desktop/(桌面配置区)
  // 和 ~/.pi/agent/(底座配置区)前缀内,杜绝任意路径读写(评估 P1-D1:此前无门控,
  // 被 session-bookmarks 用来读写项目内 <cwd>/.pi-desktop/bookmarks/,绕过 fs:project 只读沙箱)。
  // 插件的私有数据应走 ctx.config(~/.pi-desktop/plugins-data/<id>/),项目级数据走声明能力。
  function resolveConfigFilePath(path: string): string {
    const abs = path.startsWith("~/") ? join(paths.homeDir, path.slice(2)) : path;
    const allowed = [paths.piDesktopDir, paths.piAgentDir];
    const ok = allowed.some((root) => abs === root || abs.startsWith(root + sep));
    if (!ok) throw new Error(`configFile 路径越界:仅允许 ~/.pi-desktop/ 或 ~/.pi/agent/ 前缀,收到 ${path}`);
    return abs;
  }
  ipcMain.handle(IPC.configFile.get, (_e, path: string) => {
    return readJsonFile(resolveConfigFilePath(path));
  });
  ipcMain.handle(IPC.configFile.set, async (_e, path: string, data: Record<string, unknown>, mergeMode: "deep" | "replace") => {
    const abs = resolveConfigFilePath(path);
    await writeJsonFile(abs, data, mergeMode);
    broadcastSettingsChanged();
    return readJsonFile(abs);
  });

  // ---- IPC:分层配置(框架级项目配置 fallback;详见 docs/design/layered-config.md)----
  // 路径由 main 构造(插件传 cwd + relPath),不走白名单——攻击面是 relPath 能否逃逸 .pi-desktop/。
  function resolveRelPath(cwd: string, relPath: string): { project: string; global: string } {
    if (relPath.startsWith("/") || relPath.includes("~"))
      throw new Error("relPath 不能是绝对路径或含 ~");
    if (relPath.split(sep).includes(".."))
      throw new Error("relPath 不能含 ..");
    return {
      project: join(cwd, ".pi-desktop", relPath),
      global: join(paths.piDesktopDir, relPath),
    };
  }
  ipcMain.handle(IPC.configFile.getLayered, (_e, cwd: string, relPath: string) => {
    const { project, global } = resolveRelPath(cwd, relPath);
    if (existsSync(project)) return readJsonFile(project);
    if (existsSync(global)) return readJsonFile(global);
    return null;
  });
  ipcMain.handle(IPC.configFile.getProject, (_e, cwd: string, relPath: string) => {
    const { project } = resolveRelPath(cwd, relPath);
    return existsSync(project) ? readJsonFile(project) : null;
  });
  ipcMain.handle(IPC.configFile.setProject, async (_e, cwd: string, relPath: string, data: Record<string, unknown>, mode: "deep" | "replace") => {
    const { project } = resolveRelPath(cwd, relPath);
    await writeJsonFile(project, data, mode);
    broadcastSettingsChanged();
    return readJsonFile(project);
  });
  ipcMain.handle(IPC.configFile.clearProject, (_e, cwd: string, relPath: string) => {
    const { project } = resolveRelPath(cwd, relPath);
    try { unlinkSync(project); } catch {}
  });
}
