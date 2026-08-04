// IPC:pi 内核管理 + 底座 settings/models 配置(kernel.*/piSettings.*/models.*)。
import { ipcMain, BrowserWindow } from "electron";
import { join } from "node:path";
import {
  kernelStatus,
  listRegistryVersions,
  installPi,
  resolveCustomCli,
  type KernelStatus,
} from "../../core/application/kernel/kernel-manager";
import { parseSettingsSchema } from "../../core/application/pi-settings/pi-settings-store";
import { toolgateAvailable } from "../../client/pi/toolgate-installer";
import { runPiOneshot } from "../../client/pi/pi-oneshot";
import { IPC } from "../preload/ipc-channels";
import type { MainContext } from "./main-context";

export function registerKernelIpc(ctx: MainContext): void {
  const { piSettingsStore, modelsStore, paths } = ctx;

  // ---- IPC:pi 内核管理(application/kernel,只维护 ~/.pi-desktop/pi 一份)----
  // 用户决策:不掺和 PATH 里的 pi、不走 pi update,桌面端只管 ~/.pi-desktop/pi 这一份(装/升/降级)。
  ipcMain.handle(IPC.kernel.status, () =>
    kernelStatus(paths.piInstallDir, ctx.prefsStore.get("customCliDir")),
  );
  // 自定义底座(docs/design/custom-cli-path.md §2.7):校验(空串=清除合法;非空须 resolveCustomCli
  // 命中,不过不写)→ 写 prefs → 运行中会话标 restart pending → 返回新 status。四步原子,无中间态。
  ipcMain.handle(
    IPC.kernel.setCustomCliDir,
    (_e, dir: string): { ok: boolean; error: string | null; pendingCount: number; status: KernelStatus | null } => {
      const trimmed = (dir ?? "").trim();
      if (trimmed && !resolveCustomCli(trimmed)) {
        return { ok: false, error: "目录无效：未找到 dist/cli.js，也不是 npm 安装目录", pendingCount: 0, status: null };
      }
      ctx.prefsStore.set("customCliDir", trimmed);
      const running = ctx.sessionStore.getRunningSessionKeys();
      ctx.restartCoordinator.markPendingAll(running, "自定义底座路径变更");
      return { ok: true, error: null, pendingCount: running.length, status: kernelStatus(paths.piInstallDir, trimmed) };
    },
  );
  // tool-gate 底座扩展可用性探测:tool-manager 据此刻"过滤不生效"降级提示。
  ipcMain.handle(IPC.kernel.toolgateAvailable, () => toolgateAvailable());
  ipcMain.handle(IPC.kernel.listVersions, async (_e, forceRefresh: boolean) =>
    listRegistryVersions(forceRefresh),
  );
  // kernel:install npm install 指定版本到 ~/.pi-desktop/pi(覆盖式,装新=更新、装旧=降级)
  ipcMain.handle(IPC.kernel.install, async (e, version: string) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const send = (line: string) => win?.webContents.send("kernel:install-progress", line);
    const result = await installPi(version, paths.piInstallDir, send);
    if (win) win.webContents.send("kernel:install-done", result);
    return result;
  });

  // ---- IPC:pi 底座 settings(pi-settings 插件,读写 ~/.pi/agent/settings.json)----
  // ⚠ 偏离文档(标注):文档说壳不替底座管配置,但 settings.json 是底座标准契约,
  // 写标准字段不算重复领域知识。用户明确要在桌面端编辑 pi 所有配置。
  ipcMain.handle(IPC.piSettings.get, () => piSettingsStore.get());
  ipcMain.handle(IPC.piSettings.set, async (_e, patch: Record<string, unknown>) => {
    await piSettingsStore.set(patch);
    return piSettingsStore.get();
  });
  // 解析底座 .d.ts 拿当前版本所有字段(方案 D:.d.ts 有但描述表没有的兜底展示)
  // globalResolvePaths 由 shell 注入(application 不读 process 环境):进程 cwd + npm 全局目录。
  const PI_SETTINGS_RESOLVE_PATHS = [
    process.cwd(),
    join(paths.homeDir, ".npm-global"),
    "/usr/local/lib",
  ];
  ipcMain.handle(IPC.piSettings.schema, () => parseSettingsSchema(paths.piInstallDir, PI_SETTINGS_RESOLVE_PATHS));

  // ---- IPC:pi 底座 models(models.json,pi-model-manager 插件用)----
  ipcMain.handle(IPC.models.get, () => modelsStore.get());
  ipcMain.handle(IPC.models.set, async (_e, config: unknown) => {
    await modelsStore.set(config as Record<string, unknown> as never);
    return modelsStore.get();
  });

  // ---- IPC:llm:oneshot 声明能力(一次性问底座;prompt 由插件拼装,cwd 取激活项目根)----
  // cliPath 与会话进程同源(ctx.customCliPath 单源):自定义底座生效时 oneshot 不分裂(§2.5)。
  ipcMain.handle(IPC.llm.oneshot, (_e, pluginId: string, prompt: string) => {
    ctx.registry.assertPermission(pluginId, "llm:oneshot");
    return runPiOneshot(prompt, {
      cwd: ctx.sessionStore.getActiveCwd() ?? undefined,
      cliPath: ctx.customCliPath(),
    });
  });
}
