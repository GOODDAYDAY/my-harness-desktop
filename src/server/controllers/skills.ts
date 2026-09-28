// IPC:Skills 管理(skills.*)—— 经聚合器消费内核回报 + 转发开关意图 + chokidar 监听变化推送。
// 壳不读任何内核存储:list/setEnabled/setModelInvocable 全走 SkillAggregator
// (聚合 pi/dsh 的 SkillProvider);内置 skills 挂摘经 bootstrap 注入的 ensureBundledSkills。
// docs/design/skills-layering.md。
import type { Gateway } from "../routing/gateway";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import type { SkillInfo } from "@my-harness-desktop/shared";
import { IPC } from "@my-harness-desktop/shared";
import { broadcastSettingsChanged } from "../routing/broadcast";
import type { MainContext } from "../application/context/main-context";

export function registerSkills(gateway: Gateway, ctx: MainContext): void {
  const { prefsStore, paths, skillAggregator, ensureBundledSkills, kernelSkillWatchPaths } = ctx;
  const skillWatchers = new Map<string, { close: () => void }>();

  gateway.register(IPC.skills.list, async (_e, cwd: string) => {
    return skillAggregator.listSkills(cwd || process.cwd());
  });

  gateway.register(IPC.skills.getCapabilities, () => {
    return skillAggregator.capabilities;
  });

  gateway.register(IPC.skills.setEnabled, async (_e, opts: { skill: SkillInfo; enabled: boolean }) => {
    await skillAggregator.setEnabled(opts.skill, opts.enabled);
    broadcastSettingsChanged(gateway);
  });

  gateway.register(IPC.skills.setModelInvocable, async (_e, opts: { skill: SkillInfo; value: boolean }) => {
    await skillAggregator.setModelInvocable(opts.skill, opts.value);
    gateway.broadcast(IPC.skills.changed);
  });

  gateway.register(IPC.skills.getBundled, () => ({
    path: paths.bundledSkillsDir,
    enabled: prefsStore.get("bundledSkillsEnabled"),
  }));

  gateway.register(IPC.skills.setBundledEnabled, async (_e, enabled: boolean) => {
    prefsStore.set("bundledSkillsEnabled", enabled);
    const changed = await ensureBundledSkills(enabled);
    if (changed) broadcastSettingsChanged(gateway);
    gateway.broadcast(IPC.skills.changed);
  });

  gateway.register(IPC.skills.watch, async (_e, cwd: string) => {
    const key = cwd || process.cwd();
    skillWatchers.get(key)?.close();
    skillWatchers.delete(key);

    const { watch } = await import("chokidar");
    // 监视哪些文件由各内核自报（技能清单存在哪是内核的私有知识）：此前这里写死了 pi 的三个路径，
    // 等于壳知道 pi 的配置格式与文件名。现在从注册表收集，加内核自动纳入；没有该面的内核不挂监视器。
    //
    // ⚠ 但那次修复留了一条**特判尾巴**：`.filter((p) => existsSync(p) || p.endsWith(".pi" + join("", "settings.json")))`。
    //   它的意图是合法的——清单文件**还不存在**时也要监视，好让用户创建它的那一刻能触发刷新；
    //   可它把这个意图写死在 pi 的路径上，于是 dsh / minimal / 第四个内核的清单若尚未创建就**不会**被监视
    //   （症状：装了内核、建了清单文件，技能列表不刷新，要重启才行）。
    //   而且那个字符串被拆成 `".pi" + join("", "settings.json")` —— 无论初衷是什么，
    //   这种形态在效果上就是**躲开按字面量搜索的审计**（本仓 r31 的多载体守卫正是靠词边界才抓到它）。
    //   中性修法：存在的照旧直接监视；不存在的改监视其**父目录**（创建事件同样能捕获），
    //   不点名任何内核，意图完整保留且对任意内核一致生效。
    const declared = kernelSkillWatchPaths(key);
    const watchPaths = [...new Set(declared.flatMap((p) => {
      if (existsSync(p)) return [p];
      const parent = dirname(p);
      return existsSync(parent) ? [parent] : [];
    }))];
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
        gateway.broadcast(IPC.skills.changed);
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
