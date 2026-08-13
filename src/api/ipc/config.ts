// IPC:插件配置(config:走 ConfigStore)+ 桌面偏好(prefs:走 electron-store)
// + 通用 JSON 配置文件读写(configFile:路径白名单)+ 分层配置。
import { ipcMain } from "electron";
import { join, sep } from "node:path";
import { existsSync, unlinkSync } from "node:fs";
import { appendJsonlLine, readBinaryFile, readJsonFile, writeBinaryFile, writeJsonFile } from "../../core/application/config/config-file";
import { expandDesktopPath } from "../../client/paths";
import { IPC } from "../preload/ipc-channels";
import { broadcastSettingsChanged } from "./broadcast";
import type { MainContext, Prefs } from "./main-context";

export function registerConfigIpc(ctx: MainContext): void {
  const { configStore, prefsStore, paths } = ctx;

  // ---- IPC:插件配置(统一项目级配置通道;scope/getScope 见 unified-project-config.md)----
  ipcMain.handle(IPC.config.get, (_e, pluginId: string, key: string) =>
    configStore.get<unknown>(pluginId, key),
  );
  ipcMain.handle(
    IPC.config.set,
    async (_e, pluginId: string, key: string, value: unknown, opts?: { scope?: "project" | "global" }) => {
      await configStore.set(pluginId, key, value, opts);
      // 写后广播(与 configFile.set 同契约):订阅方(设置页/notes 等插件的多视图)重读刷新
      broadcastSettingsChanged();
    },
  );
  ipcMain.handle(IPC.config.all, (_e, pluginId: string) => configStore.all(pluginId));
  ipcMain.handle(IPC.config.getScope, (_e, pluginId: string, scope: "project" | "global") =>
    configStore.getScope(pluginId, scope),
  );

  // ---- IPC:桌面偏好 ----
  ipcMain.handle(IPC.prefs.get, (_e, key: keyof Prefs) => prefsStore.get(key));
  ipcMain.handle(IPC.prefs.set, (_e, key: keyof Prefs, value: unknown) => {
    prefsStore.set(key, value as never);
  });

  // ---- IPC:通用 JSON 配置文件读写(框架级配置管理,路径白名单 + 逻辑前缀展开)----
  // 安全门控(§4.6/§8.1):configFile 是框架级通道,限定在 ~/.pi-desktop/(桌面配置区)
  // 和 ~/.pi/agent/(底座配置区)前缀内,杜绝任意路径读写(评估 P1-D1:此前无门控,
  // 被 session-bookmarks 用来读写项目内 <cwd>/.pi-desktop/bookmarks/,绕过 fs:project 只读沙箱)。
  // 插件的私有数据应走 ctx.config(数据根 plugins-data/<id>/),项目级数据走声明能力。
  // ~/.pi-desktop 是逻辑前缀(expandDesktopPath 映射到当前数据根,dev 态 -dev 目录)。
  function resolveConfigFilePath(path: string): string {
    const abs = expandDesktopPath(path, paths.homeDir, paths.piDesktopDir);
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
  // JSONL 追加(白名单同上):append-only 原语,不走整写。不广播 settingsChanged——
  // 那是"settings.json 变了、设置页刷新"的语义,session 文件追加不是设置变更
  // (设计:docs/design/session-jsonl-append.md §5.3)。
  ipcMain.handle(IPC.configFile.append, async (_e, path: string, entry: Record<string, unknown>) => {
    await appendJsonlLine(resolveConfigFilePath(path), entry);
  });
  // 二进制读写(白名单同上):banner 图等二进制资源经此通道存取,base64 只存在于传输/内存。
  ipcMain.handle(IPC.configFile.readBinary, (_e, path: string) => readBinaryFile(resolveConfigFilePath(path)));
  ipcMain.handle(IPC.configFile.writeBinary, async (_e, path: string, base64: string) => {
    await writeBinaryFile(resolveConfigFilePath(path), base64);
  });

  // ---- IPC:分层配置(项目级 <cwd>/.pi-desktop/ 覆盖全局 ~/.pi-desktop/;key 级浅合并)----
  // 语义(unified-project-config.md):getLayered 读两层做顶层 key 浅合并——项目级文件
  // 只存 diff,全局更新未覆盖的 key 项目自动享受;setProject 写项目级;clearProject 删项目级。
  // 路径由 main 构造(插件/框架传 cwd + relPath),不走白名单——攻击面是 relPath 能否逃逸 .pi-desktop/。
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
    const globalDoc = existsSync(global) ? readJsonFile(global) : null;
    const projectDoc = existsSync(project) ? readJsonFile(project) : null;
    if (projectDoc === null && globalDoc === null) return null;
    return { ...(globalDoc ?? {}), ...(projectDoc ?? {}) };
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
