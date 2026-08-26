// IPC:Skills 管理(skills.*)—— 经聚合器消费内核回报 + 转发开关意图 + chokidar 监听变化推送。
// 壳不读任何内核存储:list/setEnabled/setModelInvocable 全走 SkillAggregator
// (聚合 pi/dsh 的 SkillProvider);内置 skills 挂摘经 bootstrap 注入的 ensureBundledSkills。
// docs/design/skills-layering.md。
import { BrowserWindow } from "electron";
import type { Gateway } from "../routing/gateway";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { SkillInfo } from "@my-harness-desktop/shared";
import { IPC } from "@my-harness-desktop/shared";
import { broadcastSettingsChanged } from "../api/ipc/broadcast";
import type { MainContext } from "../api/ipc/main-context";

export function registerSkills(gateway: Gateway, ctx: MainContext): void {
  const { prefsStore, paths, skillAggregator, ensureBundledSkills } = ctx;
  const skillWatchers = new Map<string, { close: () => void }>();

  gateway.register(IPC.skills.list, async (_e, cwd: string) => {
    return skillAggregator.listSkills(cwd || process.cwd());
  });

  gateway.register(IPC.skills.getCapabilities, () => {
    return skillAggregator.capabilities;
  });

  gateway.register(IPC.skills.setEnabled, async (_e, opts: { skill: SkillInfo; enabled: boolean }) => {
    await skillAggregator.setEnabled(opts.skill, opts.enabled);
    broadcastSettingsChanged();
  });

  gateway.register(IPC.skills.setModelInvocable, async (_e, opts: { skill: SkillInfo; value: boolean }) => {
    await skillAggregator.setModelInvocable(opts.skill, opts.value);
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send("skills:changed");
  });

  gateway.register(IPC.skills.getBundled, () => ({
    path: paths.bundledSkillsDir,
    enabled: prefsStore.get("bundledSkillsEnabled"),
  }));

  gateway.register(IPC.skills.setBundledEnabled, async (_e, enabled: boolean) => {
    prefsStore.set("bundledSkillsEnabled", enabled);
    const changed = await ensureBundledSkills(enabled);
    if (changed) broadcastSettingsChanged();
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send("skills:changed");
  });

  gateway.register(IPC.skills.watch, async (_e, cwd: string) => {
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

  gateway.register(IPC.skills.unwatch, (_e, cwd: string) => {
    const key = cwd || process.cwd();
    const w = skillWatchers.get(key);
    if (w) { w.close(); skillWatchers.delete(key); }
  });
}
