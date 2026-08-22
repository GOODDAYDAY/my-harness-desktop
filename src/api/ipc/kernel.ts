// IPC:pi 内核管理 + 底座 settings/models 配置(kernel.*/piSettings.*/models.*)。
import { ipcMain, BrowserWindow } from "electron";
import { join } from "node:path";
import type { KernelStatus } from "../../core/application/kernel/kernel-manager";
import { parseSettingsSchema } from "../../client/pi/pi-settings-store";
import { toolgateAvailable } from "../../client/pi/toolgate-installer";
import { runPiOneshot } from "../../client/pi/pi-oneshot";
import { IPC } from "../preload/ipc-channels";
import type { MainContext } from "./main-context";
import { broadcastRefreshRequested } from "./broadcast";
import type { DshProvider } from "../../core/domain/context";
import type { KernelModelsApi } from "../../core/domain/context";
import { createPiModelsApi } from "../../client/pi/pi-kernel-api";
import { createDshModelsApi } from "../../client/dsh/dsh-kernel-api";

export function registerKernelIpc(ctx: MainContext): void {
  const { piSettingsStore, modelsStore, paths, piKernelManager, dshKernelManager } = ctx;

  // ---- IPC:pi 内核管理(application/kernel,只维护 ~/.my-harness-desktop/pi 一份)----
  // 用户决策:不掺和 PATH 里的 pi、不走 pi update,桌面端只管 ~/.my-harness-desktop/pi 这一份(装/升/降级)。
  ipcMain.handle(IPC.kernel.status, () =>
    piKernelManager.status(ctx.prefsStore.get("customCliDir")),
  );
  // 自定义底座(docs/design/custom-cli-path.md §2.7):校验(空串=清除合法;非空须 resolveCustomCli
  // 命中,不过不写)→ 写 prefs → 运行中会话标 restart pending → 返回新 status。四步原子,无中间态。
  ipcMain.handle(
    IPC.kernel.setCustomCliDir,
    (_e, dir: string): { ok: boolean; error: string | null; pendingCount: number; status: KernelStatus | null } => {
      const trimmed = (dir ?? "").trim();
      if (trimmed && !piKernelManager.resolveCustomCli(trimmed)) {
        return { ok: false, error: "目录无效：未找到 dist/cli.js，也不是 npm 安装目录", pendingCount: 0, status: null };
      }
      ctx.prefsStore.set("customCliDir", trimmed);
      const running = ctx.sessionStore.getRunningSessionKeys();
      ctx.restartCoordinator.markPendingAll(running, "自定义底座路径变更");
      // 操作完成 → 通用刷新信号:消费方(会话流)重探挂载时探测的外部状态
      // (自定义底座从无到有也翻转 available,只读条随之恢复)。
      broadcastRefreshRequested();
      return { ok: true, error: null, pendingCount: running.length, status: piKernelManager.status(trimmed) };
    },
  );
  // tool-gate 底座扩展可用性探测:tool-manager 据此刻"过滤不生效"降级提示。
  ipcMain.handle(IPC.kernel.toolgateAvailable, () => toolgateAvailable());
  ipcMain.handle(IPC.kernel.listVersions, async (_e, forceRefresh: boolean) =>
    piKernelManager.listVersions(forceRefresh),
  );
  // kernel:install npm install 指定版本到 ~/.my-harness-desktop/pi(覆盖式,装新=更新、装旧=降级)。
  // 装/升底座会丢 fork position + entry_appended 补丁(postinstall 脚本只在仓库 npm install 时跑),
  // 已下沉到 PiKernelManager.postInstall,install 内部自动重打(already/missing 不算失败)。
  ipcMain.handle(IPC.kernel.install, async (e, version: string) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const send = (line: string) => win?.webContents.send("kernel:install-progress", line);
    const result = await piKernelManager.install(version, send);
    // 操作完成 → 通用刷新信号:新装的底座对所有窗口即刻生效(未装 → 已装翻转
    // timeline 的 kernelAvailable,只读条自动消失,不用重启;根因修复见 broadcast.ts)。
    if (result.ok) broadcastRefreshRequested();
    if (win) win.webContents.send("kernel:install-done", result);
    return result;
  });

  // ---- IPC:dsh 内核管理(与 pi 同构的版本管理,@deepseek-ai/dsh 装到 ~/.my-harness-desktop/dsh)----
  ipcMain.handle(IPC.dshKernel.status, () =>
    dshKernelManager.status(ctx.prefsStore.get("dshCustomCliDir")),
  );
  // 自定义 dsh 目录(与 pi setCustomCliDir 同构):校验 → 写 prefs → markPendingAll → 返回新 status。
  ipcMain.handle(
    IPC.dshKernel.setCustomCliDir,
    (_e, dir: string): { ok: boolean; error: string | null; pendingCount: number; status: KernelStatus | null } => {
      const trimmed = (dir ?? "").trim();
      if (trimmed && !dshKernelManager.resolveCustomCli(trimmed)) {
        return { ok: false, error: "目录无效：未找到 apps/cli/lib/bin.js，也不是 npm 安装目录", pendingCount: 0, status: null };
      }
      ctx.prefsStore.set("dshCustomCliDir", trimmed);
      const running = ctx.sessionStore.getRunningSessionKeys();
      ctx.restartCoordinator.markPendingAll(running, "自定义底座路径变更");
      broadcastRefreshRequested();
      return { ok: true, error: null, pendingCount: running.length, status: dshKernelManager.status(trimmed) };
    },
  );
  ipcMain.handle(IPC.dshKernel.listVersions, async (_e, forceRefresh: boolean) =>
    dshKernelManager.listVersions(forceRefresh),
  );
  ipcMain.handle(IPC.dshKernel.install, async (e, version: string) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const send = (line: string) => win?.webContents.send("kernel:install-progress", line);
    const result = await dshKernelManager.install(version, send);
    if (result.ok) broadcastRefreshRequested();
    if (win) win.webContents.send("kernel:install-done", result);
    return result;
  });

  // ---- IPC:dsh 模型配置(读/写 settings.yaml 的多 provider 路由详情 + 默认模型)----
  ipcMain.handle(IPC.dshModels.get, () => ctx.dshConfigSource.listProviders());
  ipcMain.handle(IPC.dshModels.set, async (_e, provider: string, detail: Omit<DshProvider, "provider">) => {
    await ctx.dshConfigSource.setProvider(provider, detail);
    return ctx.dshConfigSource.listProviders();
  });
  ipcMain.handle(IPC.dshModels.removeProvider, async (_e, provider: string) => {
    await ctx.dshConfigSource.removeProvider(provider);
    return ctx.dshConfigSource.listProviders();
  });
  ipcMain.handle(IPC.dshModels.renameProvider, async (_e, oldId: string, newId: string) => {
    await ctx.dshConfigSource.renameProvider(oldId, newId);
    return ctx.dshConfigSource.listProviders();
  });
  ipcMain.handle(IPC.dshModels.getDefault, () => ctx.dshConfigSource.getDefaultModel());
  ipcMain.handle(IPC.dshModels.setDefault, async (_e, sel: { provider: string; model: string; reasoningEffort?: string }) => {
    await ctx.dshConfigSource.setDefaultModel(sel);
    return ctx.dshConfigSource.getDefaultModel();
  });
  ipcMain.handle(IPC.dshModels.test, (_e, cwd: string, provider: string, modelId: string) =>
    ctx.sessionStore.test(cwd, provider, modelId, "dsh"));
  // ---- IPC:dsh 配置(整份 ~/.dsh/settings.yaml 读写)----
  ipcMain.handle(IPC.dshSettings.get, () => ctx.dshConfigSource.getSettings());
  ipcMain.handle(IPC.dshSettings.set, async (_e, obj: Record<string, unknown>) => {
    await ctx.dshConfigSource.setSettings(obj);
    return ctx.dshConfigSource.getSettings();
  });
  // ---- IPC:中性内核管理 API(kernel-design-spec.md §12.5)——模型页----
  const kernelModels: Record<"pi" | "dsh", KernelModelsApi> = {
    pi: createPiModelsApi(modelsStore, piSettingsStore, ctx.sessionStore),
    dsh: createDshModelsApi(ctx.dshConfigSource, ctx.sessionStore, {
      getApiKeys: () => ctx.prefsStore.get("dshApiKeys"),
      setApiKeys: (m) => ctx.prefsStore.set("dshApiKeys", m),
    }),
  };
  const modelsApi = (kernel: "pi" | "dsh"): KernelModelsApi => kernelModels[kernel];

  ipcMain.handle(IPC.kernelModels.list, (_e, kernel: "pi" | "dsh") => modelsApi(kernel).list());
  ipcMain.handle(IPC.kernelModels.set, (_e, kernel: "pi" | "dsh", provider: string, detail) => modelsApi(kernel).set(provider, detail));
  ipcMain.handle(IPC.kernelModels.remove, (_e, kernel: "pi" | "dsh", provider: string) => modelsApi(kernel).remove(provider));
  ipcMain.handle(IPC.kernelModels.rename, (_e, kernel: "pi" | "dsh", oldId: string, newId: string) => modelsApi(kernel).rename(oldId, newId));
  ipcMain.handle(IPC.kernelModels.getDefault, (_e, kernel: "pi" | "dsh") => modelsApi(kernel).getDefault());
  ipcMain.handle(IPC.kernelModels.setDefault, (_e, kernel: "pi" | "dsh", sel) => modelsApi(kernel).setDefault(sel));
  ipcMain.handle(IPC.kernelModels.test, (_e, kernel: "pi" | "dsh", cwd: string, provider: string, modelId: string) => modelsApi(kernel).test(cwd, provider, modelId));
  ipcMain.handle(IPC.kernelModels.readConfig, (_e, kernel: "pi" | "dsh") => modelsApi(kernel).readConfig());
  ipcMain.handle(IPC.kernelModels.saveConfig, (_e, kernel: "pi" | "dsh", config) => modelsApi(kernel).saveConfig(config));
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
  // ---- IPC:合流模型清单(pi + dsh,带 kernel 标;会话流模型下拉用,设计 §3.3)----
  ipcMain.handle(IPC.models.list, () => ctx.modelCatalog.listModels());

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
