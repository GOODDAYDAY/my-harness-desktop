// IPC:Skills 管理(skills.*)—— 扫描/开关/路径管理 + chokidar 监听变化推送。
import { ipcMain, BrowserWindow } from "electron";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { scanSkills, getSkillSourcePaths } from "../../core/application/skills/skill-scanner";
import { toggleSkill, toggleForceInvocation, addSkillPath, removeSkillPath } from "../../core/application/skills/skill-toggle";
import { ensureBundledSkillsEntry } from "../../core/application/skills/bundled-skills";
import type { PluginSkillDir } from "../../core/domain/skills";
import { IPC } from "../preload/ipc-channels";
import { broadcastSettingsChanged } from "./broadcast";
import type { MainContext } from "./main-context";

export function registerSkillsIpc(ctx: MainContext): void {
  const { prefsStore, paths, registry } = ctx;
  const skillWatchers = new Map<string, { close: () => void }>();

  function collectPluginSkillDirs(cwd: string): PluginSkillDir[] {
    const dirs: PluginSkillDir[] = [];
    for (const [, plugin] of registry.allPlugins()) {
      const skillsDir = join(plugin.path, "skills");
      if (!existsSync(skillsDir)) continue;
      dirs.push({
        dir: skillsDir,
        pluginId: plugin.manifest.id,
        scope: plugin.source === "project" ? "project" : "user",
      });
    }
    return dirs;
  }

  ipcMain.handle(IPC.skills.list, (_e, cwd: string) => {
    const effectiveCwd = cwd || process.cwd();
    return scanSkills({
      agentDir: paths.piAgentDir,
      cwd: effectiveCwd,
      homeDir: paths.homeDir,
      pluginSkillDirs: collectPluginSkillDirs(effectiveCwd),
    });
  });

  ipcMain.handle(IPC.skills.toggle, async (_e, opts: {
    filePath: string; sourcePath: string; enabled: boolean; scope: "user" | "project"; cwd: string;
  }) => {
    await toggleSkill({ ...opts, agentDir: paths.piAgentDir, homeDir: paths.homeDir });
    broadcastSettingsChanged();
  });

  ipcMain.handle(IPC.skills.toggleForce, async (_e, opts: { filePath: string; force: boolean }) => {
    await toggleForceInvocation(opts);
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send("skills:changed");
  });

  ipcMain.handle(IPC.skills.addPath, async (_e, opts: { path: string; scope: "user" | "project"; cwd: string }) => {
    await addSkillPath({ ...opts, agentDir: paths.piAgentDir, homeDir: paths.homeDir });
    broadcastSettingsChanged();
  });

  ipcMain.handle(IPC.skills.removePath, async (_e, opts: { path: string; scope: "user" | "project"; cwd: string }) => {
    await removeSkillPath({ ...opts, agentDir: paths.piAgentDir, homeDir: paths.homeDir });
    broadcastSettingsChanged();
  });

  ipcMain.handle(IPC.skills.getSourcePaths, (_e, cwd: string) => {
    return getSkillSourcePaths(paths.piAgentDir, cwd || process.cwd());
  });

  ipcMain.handle(IPC.skills.getBundled, () => ({
    path: paths.bundledSkillsDir,
    enabled: prefsStore.get("bundledSkillsEnabled"),
  }));

  ipcMain.handle(IPC.skills.setBundledEnabled, async (_e, enabled: boolean) => {
    prefsStore.set("bundledSkillsEnabled", enabled);
    const changed = await ensureBundledSkillsEntry({
      settingsPath: join(paths.piAgentDir, "settings.json"),
      targetDir: paths.bundledSkillsDir,
      enabled,
      homeDir: paths.homeDir,
    });
    if (changed) broadcastSettingsChanged();
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send("skills:changed");
  });

  ipcMain.handle(IPC.skills.watch, async (_e, cwd: string) => {
    const key = cwd || process.cwd();
    if (skillWatchers.has(key)) return;
    const { watch } = await import("chokidar");
    const skills = scanSkills({ agentDir: paths.piAgentDir, cwd: key, homeDir: paths.homeDir, pluginSkillDirs: collectPluginSkillDirs(key) });
    const pathsToWatch = new Set<string>();
    pathsToWatch.add(join(paths.piAgentDir, "settings.json"));
    pathsToWatch.add(join(key, ".pi", "settings.json"));
    for (const s of skills) pathsToWatch.add(s.sourcePath);
    pathsToWatch.add(join(key, ".pi", "skills"));
    pathsToWatch.add(join(key, ".agents", "skills"));
    pathsToWatch.add(join(paths.piAgentDir, "skills"));
    pathsToWatch.add(join(paths.homeDir, ".agents", "skills"));
    for (const psd of collectPluginSkillDirs(key)) pathsToWatch.add(psd.dir);
    const projectSettingsPath = join(key, ".pi", "settings.json");
    // project settings 可能尚不存在(用户首次添加 project 级路径时才创建),chokidar 支持监听
    // 不存在的路径(监听父目录),强制保留它,否则创建那一刻收不到事件。
    const watchPaths = [...pathsToWatch].filter((p) => existsSync(p) || p === projectSettingsPath);
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const watcher = watch(watchPaths, {
      ignored: /(^|[/\\])\./,
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    });
    const debouncedRescan = (): void => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send("skills:changed");
        }
      }, 300);
    };
    watcher.on("add", debouncedRescan);
    watcher.on("unlink", debouncedRescan);
    watcher.on("change", debouncedRescan);
    watcher.on("addDir", debouncedRescan);
    watcher.on("unlinkDir", debouncedRescan);
    skillWatchers.set(key, { close: () => { watcher.close(); if (debounceTimer) clearTimeout(debounceTimer); } });
  });

  ipcMain.handle(IPC.skills.unwatch, (_e, cwd: string) => {
    const key = cwd || process.cwd();
    const w = skillWatchers.get(key);
    if (w) { w.close(); skillWatchers.delete(key); }
  });
}
