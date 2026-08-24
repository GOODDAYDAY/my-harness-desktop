// IPC:Skills 管理(skills.*)—— 经聚合器消费内核回报 + 转发开关意图 + chokidar 监听变化推送。
// 壳不读任何内核存储:list/setEnabled/setModelInvocable/setUserInvocable 全走 SkillAggregator
// (聚合 pi/dsh 的 SkillProvider);内置 skills 挂摘经 bootstrap 注入的 ensureBundledSkills。
// docs/design/skills-layering.md。
import { ipcMain, BrowserWindow } from "electron";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { SkillInfo } from "../../core/domain/skills";
import { IPC } from "../preload/ipc-channels";
import { broadcastSettingsChanged } from "./broadcast";
import type { MainContext } from "./main-context";

export function registerSkillsIpc(ctx: MainContext): void {
  const { prefsStore, paths, skillAggregator, ensureBundledSkills } = ctx;
  const skillWatchers = new Map<string, { close: () => void }>();

  ipcMain.handle(IPC.skills.list, async (_e, cwd: string) => {
    return skillAggregator.listSkills(cwd || process.cwd());
  });

  ipcMain.handle(IPC.skills.getCapabilities, () => {
    return skillAggregator.capabilities;
  });

  ipcMain.handle(IPC.skills.setEnabled, async (_e, opts: { skill: SkillInfo; enabled: boolean }) => {
    await skillAggregator.setEnabled(opts.skill, opts.enabled);
    broadcastSettingsChanged();
  });

  ipcMain.handle(IPC.skills.setModelInvocable, async (_e, opts: { skill: SkillInfo; value: boolean }) => {
    await skillAggregator.setModelInvocable(opts.skill, opts.value);
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send("skills:changed");
  });

  ipcMain.handle(IPC.skills.setUserInvocable, async (_e, opts: { skill: SkillInfo; value: boolean }) => {
    await skillAggregator.setUserInvocable(opts.skill, opts.value);
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send("skills:changed");
  });

  ipcMain.handle(IPC.skills.getBundled, () => ({
    path: paths.bundledSkillsDir,
    enabled: prefsStore.get("bundledSkillsEnabled"),
  }));

  ipcMain.handle(IPC.skills.setBundledEnabled, async (_e, enabled: boolean) => {
    prefsStore.set("bundledSkillsEnabled", enabled);
    const changed = await ensureBundledSkills(enabled);
    if (changed) broadcastSettingsChanged();
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send("skills:changed");
  });

  ipcMain.handle(IPC.skills.watch, async (_e, cwd: string) => {
    const key = cwd || process.cwd();
    skillWatchers.get(key)?.close();
    skillWatchers.delete(key);

    const { watch } = await import("chokidar");
    const watchPaths = [
      join(paths.piAgentDir, "settings.json"),
      join(key, ".pi", "settings.json"),
      join(paths.piAgentDir, "desktop-skills.json"),
    ].filter((p) => existsSync(p) || p.endsWith(".pi" + join("", "settings.json")));
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const watcher = watch(watchPaths, {
      ignored: /(^|[/\\])\./,
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    });
    const debounced = (): void => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        for (const win of BrowserWindow.getAllWindows()) win.webContents.send("skills:changed");
      }, 300);
    };
    for (const ev of ["add", "unlink", "change", "addDir", "unlinkDir"] as const) {
      watcher.on(ev, debounced);
    }
    skillWatchers.set(key, { close: () => { watcher.close(); if (debounceTimer) clearTimeout(debounceTimer); } });
  });

  ipcMain.handle(IPC.skills.unwatch, (_e, cwd: string) => {
    const key = cwd || process.cwd();
    const w = skillWatchers.get(key);
    if (w) { w.close(); skillWatchers.delete(key); }
  });
}
