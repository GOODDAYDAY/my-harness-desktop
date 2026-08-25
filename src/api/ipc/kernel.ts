// IPC:内核管理 + 内核 settings/models 配置(kernel.*/dshKernel.*/piSettings.*/models.*/kernelModels.*)。
import { ipcMain, BrowserWindow } from "electron";
import type { KernelStatus } from "../../core/application/kernel/kernel-manager";
import { IPC } from "../preload/ipc-channels";
import type { MainContext } from "./main-context";
import { broadcastRefreshRequested } from "./broadcast";
import type { DshProvider, KernelModelsApi, KernelConfigApi } from "../../core/domain/context";
import type { KernelId } from "../../core/domain/kernel";

export function registerKernelIpc(ctx: MainContext): void {
  const { piSettings, modelsConfig, piKernelManager, dshKernelManager, kernelModels, kernelConfig, fitPiExtensionAvailable, llmOneshot } = ctx;

  // ---- IPC:pi 内核管理(application/kernel,只维护 ~/.my-harness-desktop/pi 一份)----
  // 用户决策:不掺和 PATH 里的 pi、不走 pi update,桌面端只管 ~/.my-harness-desktop/pi 这一份(装/升/降级)。
  ipcMain.handle(IPC.kernel.status, () =>
    piKernelManager.status(ctx.prefsStore.get("customCliDir")),
  );
  // 自定义内核(docs/design/custom-cli-path.md §2.7):校验(空串=清除合法;非空须 resolveCustomCli
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
      ctx.restartCoordinator.markPendingAll(running, "自定义内核路径变更");
      // 操作完成 → 通用刷新信号:消费方(会话流)重探挂载时探测的外部状态
      // (自定义内核从无到有也翻转 available,只读条随之恢复)。
      broadcastRefreshRequested();
      return { ok: true, error: null, pendingCount: running.length, status: piKernelManager.status(trimmed) };
    },
  );
  // tool-gate 内核扩展可用性探测:tool-manager 据此刻"过滤不生效"降级提示。
  ipcMain.handle(IPC.kernel.fitPiExtensionAvailable, () => fitPiExtensionAvailable());
  ipcMain.handle(IPC.kernel.listVersions, async (_e, forceRefresh: boolean) =>
    piKernelManager.listVersions(forceRefresh),
  );
  // kernel:install npm install 指定版本到 ~/.my-harness-desktop/pi(覆盖式,装新=更新、装旧=降级)。
  // 装/升内核会丢 fork position + entry_appended 补丁(postinstall 脚本只在仓库 npm install 时跑),
  // 已下沉到 PiKernelManager.postInstall,install 内部自动重打(already/missing 不算失败)。
  ipcMain.handle(IPC.kernel.install, async (e, version: string) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const send = (line: string) => win?.webContents.send("kernel:install-progress", line);
    const result = await piKernelManager.install(version, send);
    // 操作完成 → 通用刷新信号:新装的内核对所有窗口即刻生效(未装 → 已装翻转
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
      ctx.restartCoordinator.markPendingAll(running, "自定义内核路径变更");
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
  const modelsApi = (kernel: KernelId): KernelModelsApi => kernelModels[kernel];

  ipcMain.handle(IPC.kernelModels.list, (_e, kernel: KernelId) => modelsApi(kernel).list());
  ipcMain.handle(IPC.kernelModels.set, (_e, kernel: KernelId, provider: string, detail) => modelsApi(kernel).set(provider, detail));
  ipcMain.handle(IPC.kernelModels.remove, (_e, kernel: KernelId, provider: string) => modelsApi(kernel).remove(provider));
  ipcMain.handle(IPC.kernelModels.rename, (_e, kernel: KernelId, oldId: string, newId: string) => modelsApi(kernel).rename(oldId, newId));
  ipcMain.handle(IPC.kernelModels.getDefault, (_e, kernel: KernelId) => modelsApi(kernel).getDefault());
  ipcMain.handle(IPC.kernelModels.setDefault, (_e, kernel: KernelId, sel) => modelsApi(kernel).setDefault(sel));
  ipcMain.handle(IPC.kernelModels.test, (_e, kernel: KernelId, cwd: string, provider: string, modelId: string) => modelsApi(kernel).test(cwd, provider, modelId));
  ipcMain.handle(IPC.kernelModels.readConfig, (_e, kernel: KernelId) => modelsApi(kernel).readConfig());
  ipcMain.handle(IPC.kernelModels.saveConfig, (_e, kernel: KernelId, config) => modelsApi(kernel).saveConfig(config));
  // ---- IPC:中性内核原生配置 API(kernel 配置 TAB 用)----
  const configApi = (kernel: KernelId): KernelConfigApi => kernelConfig[kernel];
  ipcMain.handle(IPC.kernelConfig.get, (_e, kernel: KernelId) => configApi(kernel).get());
  ipcMain.handle(IPC.kernelConfig.set, (_e, kernel: KernelId, obj: Record<string, unknown>) => configApi(kernel).set(obj));
  ipcMain.handle(IPC.kernelConfig.fields, (_e, kernel: KernelId) => configApi(kernel).fields());
  // ---- IPC:内核身份标(logo)取回——每个内核在自己适配器声明,壳经此渲染(不硬编码)----
  ipcMain.handle(IPC.kernelLogos.get, (_e, kernel: KernelId) => ctx.kernelLogos[kernel]);
  // ---- IPC:pi 内核 settings(pi-settings 插件,读写 ~/.pi/agent/settings.json)----
  // ⚠ 偏离文档(标注):文档说壳不替内核管配置,但 settings.json 是内核标准契约,
  // 写标准字段不算重复领域知识。用户明确要在桌面端编辑 pi 所有配置。
  ipcMain.handle(IPC.piSettings.get, () => piSettings.get());
  ipcMain.handle(IPC.piSettings.set, async (_e, patch: Record<string, unknown>) => {
    await piSettings.set(patch);
    return piSettings.get();
  });
  // 解析内核 .d.ts 拿当前版本所有字段(方案 D:.d.ts 有但描述表没有的兜底展示)
  // globalResolvePaths 由 bootstrap 注入(application 不读 process 环境)。
  ipcMain.handle(IPC.piSettings.schema, () => piSettings.schema());

  // ---- IPC:pi 内核 models(models.json,pi-model-manager 插件用)----
  ipcMain.handle(IPC.models.get, () => modelsConfig.get());
  ipcMain.handle(IPC.models.set, async (_e, config: unknown) => {
    await modelsConfig.set(config);
    return modelsConfig.get();
  });
  // ---- IPC:合流模型清单(pi + dsh,带 kernel 标;会话流模型下拉用,设计 §3.3)----
  ipcMain.handle(IPC.models.list, () => ctx.modelCatalog.listModels());
  // ---- IPC:中性「兜底模型」(新会话无显式选择时壳 renderer 用;不再直读 pi models.json)----
  // 语义:返回「需要显式 set 的兜底模型」(含 kernel——内核由模型归属决定,不靠 provider 名猜)。
  // 多内核下:dsh 的 agent-default-model 是显式「默认模型」配置,优先;否则回落 pi 配置。
  // 这是「模型默认」不是「内核默认」:返回的 kernel 是这条模型的归属,不是写死的「默认 pi」。
  ipcMain.handle(IPC.models.getFallbackModel, async () => {
    const dshDefault = ctx.dshConfigSource.getDefaultModel();
    if (dshDefault) return { provider: dshDefault.provider, model: dshDefault.model, kernel: "dsh" as const };
    const cfg = await kernelModels.pi.readConfig();
    if (cfg.default) return { provider: cfg.default.provider, model: cfg.default.model, kernel: "pi" as const };
    const first = cfg.providers.find((p) => p.models.length > 0);
    return first ? { provider: first.id, model: first.models[0].id, kernel: "pi" as const } : null;
  });

  // ---- IPC:llm:oneshot 声明能力(一次性问内核;prompt 由插件拼装,cwd/cliPath 由 bootstrap 闭包)----
  ipcMain.handle(IPC.llm.oneshot, (_e, pluginId: string, prompt: string) => {
    ctx.registry.assertPermission(pluginId, "llm:oneshot");
    return llmOneshot(prompt);
  });
}
