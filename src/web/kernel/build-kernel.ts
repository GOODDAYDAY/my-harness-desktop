// buildKernel —— 从 transport 三原语构建 window.kernel(web-service-architecture.md §4/§15)。
// 原 preload.ts 的 kernel 对象整体迁来:ipcRenderer.invoke/on/removeListener → transport
// .invoke/on/off;platform 由宿主注入(纯值,不经 transport)。依赖只向内,零 electron。
import type { KernelApi } from "@my-harness-desktop/react";
import type { RemoteTransport } from "../transport/ws-transport";

import { IPC } from "@my-harness-desktop/shared";
import type { HeaderPatch, SessionToolConfig, KnownToolInfo, GitStatusResult, GitLogEntry } from "@my-harness-desktop/shared";
import type { DshProvider, DshDefaultModel } from "@my-harness-desktop/shared";
import type { KernelId, KernelLogo, KernelStatusView } from "@my-harness-desktop/shared";


/** 从 RemoteTransport + 平台值构建完整 kernel API(§15.3)。Core 方法走 transport,platform 注入。 */
export function buildKernel(transport: RemoteTransport, platform: string): KernelApi {
/** 中性模型配置 API 的 preload 桥（pi/dsh 共用一个形状）。 */
function kernelModelsFor(kernel: KernelId) {
  return {
    list: (): Promise<unknown[]> => transport.invoke(IPC.kernelModels.list, kernel),
    set: (provider: string, detail: unknown): Promise<unknown[]> => transport.invoke(IPC.kernelModels.set, kernel, provider, detail),
    remove: (provider: string): Promise<unknown[]> => transport.invoke(IPC.kernelModels.remove, kernel, provider),
    rename: (oldId: string, newId: string): Promise<unknown[]> => transport.invoke(IPC.kernelModels.rename, kernel, oldId, newId),
    getDefault: (): Promise<unknown> => transport.invoke(IPC.kernelModels.getDefault, kernel),
    setDefault: (sel: unknown): Promise<unknown> => transport.invoke(IPC.kernelModels.setDefault, kernel, sel),
    test: (cwd: string, provider: string, modelId: string): Promise<{ ok: boolean; error?: string }> =>
      transport.invoke(IPC.kernelModels.test, kernel, cwd, provider, modelId),
    readConfig: (): Promise<unknown> => transport.invoke(IPC.kernelModels.readConfig, kernel),
    saveConfig: (config: unknown): Promise<unknown> => transport.invoke(IPC.kernelModels.saveConfig, kernel, config),
  };
}

/** 中性内核原生配置 API 的 preload 桥（pi/dsh 共用一个形状）。 */
function kernelConfigFor(kernel: KernelId) {
  return {
    get: (): Promise<Record<string, unknown>> => transport.invoke(IPC.kernelConfig.get, kernel),
    set: (obj: Record<string, unknown>): Promise<Record<string, unknown>> => transport.invoke(IPC.kernelConfig.set, kernel, obj),
    fields: (): Promise<unknown[]> => transport.invoke(IPC.kernelConfig.fields, kernel),
  };
}

/** 暴露到 renderer 的 kernel 全局对象(window.kernel)。 */
const kernel = {
  /** 插件配置:统一项目级配置通道(项目级 <cwd>/.my-harness-desktop/config/{id}.json 默认,
   *  全局 ~/.my-harness-desktop/config/{id}.json 兜底)。renderer 不直接写,经此 → main → ConfigStore。 */
  config: {
    get: <T>(pluginId: string, key: string): Promise<T | undefined> =>
      transport.invoke(IPC.config.get, pluginId, key),
    set: (pluginId: string, key: string, value: unknown, opts?: { scope?: "project" | "global" }): Promise<void> =>
      transport.invoke(IPC.config.set, pluginId, key, value, opts),
    all: (pluginId: string): Promise<Record<string, unknown>> =>
      transport.invoke(IPC.config.all, pluginId),
    getScope: (pluginId: string, scope: "project" | "global"): Promise<Record<string, unknown>> =>
      transport.invoke(IPC.config.getScope, pluginId, scope),
  },
  /** 桌面偏好(electron-store):currentThemeId/fontScale/fontMono/fontEnglish/fontChinese 等。 */
  prefs: {
    get: <T>(key: string): Promise<T> => transport.invoke(IPC.prefs.get, key),
    set: (key: string, value: unknown): Promise<void> =>
      transport.invoke(IPC.prefs.set, key, value),
  },
  /** 主题:列表 + 合并(经 application/theme/merge)。 */
  themes: {
    list: (): Promise<{ id: string; name: string }[]> =>
      transport.invoke(IPC.themes.list),
    build: (
      themeId: string,
      fontScale: number,
      fontMono: string,
      fontEnglish: string,
      fontChinese: string,
    ): Promise<Record<string, string>> =>
      transport.invoke(IPC.themes.build, themeId, fontScale, fontMono, fontEnglish, fontChinese),
    /** 系统明暗变化推送(__auto__ 动态 base 重 build 用);返回清理函数。 */
    onSystemChanged: (cb: () => void): (() => void) => {
      const listener = (): void => cb();
      transport.on(IPC.themes.systemChanged, listener);
      return () => {
        transport.off(IPC.themes.systemChanged, listener);
      };
    },
  },
  /** 字体预设:fontPresets 槽贡献项列表(theme-manager 字体 tab 查槽渲染,不感知 IPC/注册表)。 */
  fonts: {
    list: (): Promise<{ id: string; category: "mono" | "english" | "chinese"; labelKey: string; stack: string; generic?: "serif" | "sans-serif" }[]> =>
      transport.invoke(IPC.fonts.list),
  },
  /** 设置页:settings 槽贡献项列表。 */
  settings: {
    list: (): Promise<
      { id: string; title: string; icon: string; component: string; pluginId: string; configFile: string | null; configMerge: "deep" | "replace"; saveMode: "framework" | "manual" }[]
    > => transport.invoke(IPC.settings.list),
  },
  /** 槽位清单:sidePanel(右面板 Tab)/ sidebar(左栏分组)/ titlebar(标题栏按钮)。 */
  slots: {
    sidePanel: (): Promise<{ id: string; label: string; icon: string; component: string; pluginId: string; revealOn?: string }[]> =>
      transport.invoke(IPC.slots.sidePanel),
    sidebar: (): Promise<{ id: string; title: string; component: string; pluginId: string }[]> =>
      transport.invoke(IPC.slots.sidebar),
    mainView: (): Promise<{ id: string; component: string; pluginId: string }[]> =>
      transport.invoke(IPC.slots.mainView),
    titlebar: (): Promise<{ id: string; component: string; pluginId: string }[]> =>
      transport.invoke(IPC.slots.titlebar),
    fileActions: (): Promise<{ id: string; labelKey: string; icon?: string; when?: { target?: "file" | "dir" | "both" }; pluginId: string }[]> =>
      transport.invoke(IPC.slots.fileActions),
    fileIcons: (): Promise<{ id: string; icon: string; extensions?: string[]; filenames?: string[]; color?: string; pluginId: string }[]> =>
      transport.invoke(IPC.slots.fileIcons),
    messageActions: (): Promise<{ id: string; component: string; placement?: "left" | "right"; when?: { role?: string[] }; order?: number; pluginId: string }[]> =>
      transport.invoke(IPC.slots.messageActions),
    blockRenderers: (): Promise<{ id: string; block: string; names?: string[]; component: string; order?: number; pluginId: string }[]> =>
      transport.invoke(IPC.slots.blockRenderers),
    codeBlockRenderers: (): Promise<{ id: string; languages: string[]; component: string; order?: number; pluginId: string }[]> =>
      transport.invoke(IPC.slots.codeBlockRenderers),
    sessionGroupings: (): Promise<{ id: string; parentPathKey: string; childLabelKey?: string; childIcon?: string; order?: number; pluginId: string }[]> =>
      transport.invoke(IPC.slots.sessionGroupings),
    composerPolicies: (): Promise<{ id: string; customKey: string; readonlyMessageKey?: string; order?: number; pluginId: string }[]> =>
      transport.invoke(IPC.slots.composerPolicies),
    composerAttachments: (): Promise<{ id: string; component: string; order?: number; pluginId: string }[]> =>
      transport.invoke(IPC.slots.composerAttachments),
    composerActions: (): Promise<{ id: string; component: string; order?: number; pluginId: string }[]> =>
      transport.invoke(IPC.slots.composerActions),
    composerStats: (): Promise<{ id: string; component: string; order?: number; pluginId: string }[]> =>
      transport.invoke(IPC.slots.composerStats),
    settingsGroups: (): Promise<{ id: string; titleKey: string; order?: number; fields: { key: string; type: "boolean" | "enum" | "int"; default?: boolean | string | number; titleKey: string; descKey?: string; options?: Array<number | { value: string; labelKey?: string }> }[]; pluginId: string }[]> =>
      transport.invoke(IPC.slots.settingsGroups),
  },
  /** 内核版本管理(统一对外面,按 KernelId 键控):pi/dsh 各一个,同构 status/setCustomCliDir/
   *  listVersions/install;pi 多 fitPiExtensionAvailable。 */
  kernels: {
    pi: {
    status: (): Promise<KernelStatusView> => transport.invoke(IPC.kernel.status),
    /** 设置/清除自定义内核目录(docs/design/custom-cli-path.md):空串=清除;
     *  校验不过不写入,返回 error;成功返回新 status + 被标 restart pending 的会话数。 */
    setCustomCliDir: (dir: string): Promise<{
      ok: boolean;
      error: string | null;
      pendingCount: number;
      status: KernelStatusView | null;
    }> => transport.invoke(IPC.kernel.setCustomCliDir, dir),
    fitPiExtensionAvailable: (): Promise<boolean> => transport.invoke(IPC.kernel.fitPiExtensionAvailable),
    listVersions: (forceRefresh = false): Promise<{
      versions: string[];
      latest: string | null;
    }> => transport.invoke(IPC.kernel.listVersions, forceRefresh),
    /** 安装/切换 pi 版本到 ~/.my-harness-desktop/pi(覆盖式:装新=更新、装旧=降级)。
     *  进度经 onProgress,完成经 onDone。完成信号以 onDone 为准(main send done),
     *  不靠 invoke 返回值(invoke reply 与 done 事件顺序不保证,曾致 onDone 不触发卡住)。 */
    install: (
      version: string,
      onProgress: (line: string) => void,
      onDone: (r: { ok: boolean; error: string | null }) => void,
    ): Promise<{ ok: boolean; error: string | null }> => {
      const progListener = (line: string) => onProgress(line);
      transport.on("kernel:install-progress", progListener);
      let cleaned = false;
      const cleanup = (): void => {
        if (cleaned) return;
        cleaned = true;
        transport.off("kernel:install-progress", progListener);
        transport.off("kernel:install-done", doneListener);
      };
      let resolveFn: ((r: { ok: boolean; error: string | null }) => void) | null = null;
      const doneListener = (r: { ok: boolean; error: string | null }) => {
        // 先调 onDone 再延迟 cleanup:在监听器内同步移除 off2(自己)会中断后续
        // onDone 调用,故 onDone 先执行、cleanup 延迟到当前监听器返回后(setTimeout 0)
        try {
          onDone(r);
        } catch (e) {
          console.error("[my-harness-desktop] kernel install onDone threw", e);
        }
        resolveFn?.(r);
        setTimeout(() => cleanup(), 0);
      };
      transport.on("kernel:install-done", doneListener);
      const invokeP = transport.invoke(IPC.kernel.install, version) as Promise<{ ok: boolean; error: string | null }>;
      // invoke reject/异常时也清(兜底,正常路径 onDone 触发 cleanup)
      invokeP.catch(() => cleanup());
      return new Promise((resolve) => {
        resolveFn = resolve;
        // 兜底:onDone 5 分钟未到(安装卡死)也 resolve,避免 Promise 永悬
        setTimeout(() => { if (!cleaned) { cleanup(); resolveFn?.({ ok: false, error: "安装超时" }); } }, 300000);
      });
    },
    },
    dsh: {
    status: (): Promise<KernelStatusView> => transport.invoke(IPC.dshKernel.status),
    setCustomCliDir: (dir: string): Promise<{ ok: boolean; error: string | null; pendingCount: number; status: KernelStatusView | null }> =>
      transport.invoke(IPC.dshKernel.setCustomCliDir, dir),
    listVersions: (forceRefresh = false): Promise<{ versions: string[]; latest: string | null }> =>
      transport.invoke(IPC.dshKernel.listVersions, forceRefresh),
    install: (
      version: string,
      onProgress: (line: string) => void,
      onDone: (r: { ok: boolean; error: string | null }) => void,
    ): Promise<{ ok: boolean; error: string | null }> => {
      const progListener = (line: string) => onProgress(line);
      transport.on("kernel:install-progress", progListener);
      let cleaned = false;
      const cleanup = (): void => {
        if (cleaned) return;
        cleaned = true;
        transport.off("kernel:install-progress", progListener);
      };
      let resolveFn: ((r: { ok: boolean; error: string | null }) => void) | null = null;
      const doneListener = (r: { ok: boolean; error: string | null }) => {
        cleanup();
        onDone(r);
        resolveFn?.(r);
      };
      transport.on("kernel:install-done", doneListener);
      const invokeP = transport.invoke(IPC.dshKernel.install, version) as Promise<{ ok: boolean; error: string | null }>;
      invokeP.catch(() => cleanup());
      return new Promise((resolve) => {
        resolveFn = resolve;
        setTimeout(() => { if (!cleaned) { cleanup(); resolveFn?.({ ok: false, error: "安装超时" }); } }, 300000);
      });
    },
    },
  },
  /** dsh 模型配置(读写 settings.yaml 的多 provider 路由详情 + 默认模型)。 */
  dshModels: {
    get: (): Promise<DshProvider[]> => transport.invoke(IPC.dshModels.get),
    set: (provider: string, detail: Omit<DshProvider, "provider">): Promise<DshProvider[]> =>
      transport.invoke(IPC.dshModels.set, provider, detail),
    removeProvider: (provider: string): Promise<DshProvider[]> =>
      transport.invoke(IPC.dshModels.removeProvider, provider),
    renameProvider: (oldId: string, newId: string): Promise<DshProvider[]> =>
      transport.invoke(IPC.dshModels.renameProvider, oldId, newId),
    getDefault: (): Promise<DshDefaultModel | null> =>
      transport.invoke(IPC.dshModels.getDefault),
    setDefault: (sel: DshDefaultModel): Promise<DshDefaultModel | null> =>
      transport.invoke(IPC.dshModels.setDefault, sel),
    test: (cwd: string, provider: string, modelId: string): Promise<{ ok: boolean; error?: string }> =>
      transport.invoke(IPC.dshModels.test, cwd, provider, modelId),
  },
  /** dsh 配置(整份 ~/.dsh/settings.yaml 读写)。 */
  dshSettings: {
    get: (): Promise<Record<string, unknown>> => transport.invoke(IPC.dshSettings.get),
    set: (obj: Record<string, unknown>): Promise<Record<string, unknown>> => transport.invoke(IPC.dshSettings.set, obj),
  },
  /** 中性内核管理 API：模型页(kernel-design-spec.md §12.5):pi/dsh 各一个适配器。 */
  kernelModels: {
    pi: kernelModelsFor("pi"),
    dsh: kernelModelsFor("dsh"),
  },
  /** 中性内核原生配置 API(kernel 配置 TAB 用):pi/dsh 各一个适配器。 */
  kernelConfig: {
    pi: kernelConfigFor("pi"),
    dsh: kernelConfigFor("dsh"),
  },
  /** 内核身份标(logo)取回:每个内核在自己适配器声明,壳经此取回渲染(不硬编码)。 */
  kernelLogos: {
    get: (kernel: KernelId): Promise<KernelLogo> => transport.invoke(IPC.kernelLogos.get, kernel),
  },
  /** pi 内核 settings(读写 ~/.pi/agent/settings.json,内核标准契约)。 */
  piSettings: {
    get: (): Promise<Record<string, unknown>> => transport.invoke(IPC.piSettings.get),
    set: (patch: Record<string, unknown>): Promise<Record<string, unknown>> =>
      transport.invoke(IPC.piSettings.set, patch),
    /** 解析内核 .d.ts 拿当前版本所有字段(未知字段兜底用) */
    schema: (): Promise<{ key: string; type: string }[]> => transport.invoke(IPC.piSettings.schema),
  },
  /** i18n:语言槽合并后给 renderer init + locale 列表 + 检测(05-plugin-i18n)。 */
  i18n: {
    resources: (): Promise<{
      resources: Record<string, Record<string, Record<string, string>>>;
      ns: string[];
      supportedLngs: string[];
    }> => transport.invoke(IPC.i18n.resources),
    list: (): Promise<{ id: string; name: string }[]> => transport.invoke(IPC.i18n.list),
    detect: (navigatorLanguage: string): Promise<string> => transport.invoke(IPC.i18n.detect, navigatorLanguage),
  },
  /** pi 内核模型配置(读写 ~/.pi/agent/models.json)。 */
  models: {
    get: <T>(): Promise<T> => transport.invoke(IPC.models.get),
    set: <T>(config: T): Promise<T> => transport.invoke(IPC.models.set, config),
    /** 合流模型清单(pi + dsh,带 kernel 标;会话流模型下拉用)。 */
    list: (): Promise<unknown[]> => transport.invoke(IPC.models.list),
    /** 中性「默认或首项模型」(新会话无显式选择时的发送兜底;不直读 pi models.json)。 */
    getFallbackModel: (): Promise<{ provider: string; model: string; kernel: KernelId } | null> =>
      transport.invoke(IPC.models.getFallbackModel),
  },
  /** 用系统默认编辑器打开文件(框架"打开配置"按钮用)。 */
  openFile: (path: string): Promise<void> => transport.invoke(IPC.misc.openFile, path),
  /** 在系统文件管理器中显示该路径(核心默认,与 openFile 同级)。 */
  revealPath: (path: string): Promise<void> => transport.invoke(IPC.misc.revealPath, path),
  /** 通用 JSON 配置文件读写(框架级配置管理)。 */
  configFile: {
    get: (path: string): Promise<Record<string, unknown>> => transport.invoke(IPC.configFile.get, path),
    set: (path: string, data: Record<string, unknown>, mergeMode: "deep" | "replace"): Promise<Record<string, unknown>> =>
      transport.invoke(IPC.configFile.set, path, data, mergeMode),
    getLayered: (cwd: string, relPath: string): Promise<Record<string, unknown> | null> =>
      transport.invoke(IPC.configFile.getLayered, cwd, relPath),
    getProject: (cwd: string, relPath: string): Promise<Record<string, unknown> | null> =>
      transport.invoke(IPC.configFile.getProject, cwd, relPath),
    setProject: (cwd: string, relPath: string, data: Record<string, unknown>, mode: "deep" | "replace"): Promise<Record<string, unknown>> =>
      transport.invoke(IPC.configFile.setProject, cwd, relPath, data, mode),
    clearProject: (cwd: string, relPath: string): Promise<void> =>
      transport.invoke(IPC.configFile.clearProject, cwd, relPath),
    /** 追加一行 JSONL(白名单内;条目形状是内容层的事,通道中性)。 */
    append: (path: string, entry: Record<string, unknown>): Promise<void> =>
      transport.invoke(IPC.configFile.append, path, entry),
    /** 读白名单内文件为 base64(不存在返回 null)。 */
    readBinary: (path: string): Promise<string | null> =>
      transport.invoke(IPC.configFile.readBinary, path),
    /** 写二进制文件(base64 解码后落盘;白名单内)。 */
    writeBinary: (path: string, base64: string): Promise<void> =>
      transport.invoke(IPC.configFile.writeBinary, path, base64),
  },
  /** 会话能力(核心):生命周期 + 消息发送 + 模型 + 树 + 维护 + 队列 + bash。 */
  sessions: {
    // SessionsApi(生命周期)
    start: (cwd: string, sessionPath?: string): Promise<{ ok: boolean }> =>
      transport.invoke(IPC.session.start, cwd, sessionPath),
    stop: (sessionPath?: string | null): Promise<{ ok: boolean }> => transport.invoke(IPC.session.stop, sessionPath),
    setContext: (cwd: string, sessionPath: string | null): Promise<void> =>
      transport.invoke(IPC.session.setContext, cwd, sessionPath),
    getSnapshot: (): Promise<unknown> => transport.invoke(IPC.session.getSnapshot),
    sync: (): Promise<unknown> => transport.invoke(IPC.session.sync),
    switchKernel: (target: KernelId): Promise<void> => transport.invoke(IPC.session.switchKernel, target),
    getCapabilities: (): Promise<{ kernel: KernelId | null; locked: boolean; piExtension: boolean; dshExtension: boolean }> => transport.invoke(IPC.session.getCapabilities),
    openSession: (sessionPath: string): Promise<unknown> =>
      transport.invoke(IPC.session.open, sessionPath),
    readToolConfig: (sessionPath: string): Promise<SessionToolConfig | null> =>
      transport.invoke(IPC.session.readToolConfig, sessionPath),
    renameSession: (sessionPath: string, name: string): Promise<{ ok: boolean }> =>
      transport.invoke(IPC.session.rename, sessionPath, name),
    updateHeader: (sessionPath: string, patch: HeaderPatch): Promise<{ ok: boolean }> =>
      transport.invoke(IPC.session.updateHeader, sessionPath, patch),
    deleteSessions: (paths: string[]): Promise<{ ok: boolean }> =>
      transport.invoke(IPC.session.delete, paths),
    list: (cwd: string): Promise<unknown[]> => transport.invoke(IPC.sessions.list, cwd),
    projectStats: (cwd: string): Promise<unknown> => transport.invoke(IPC.sessions.projectStats, cwd),
    getTree: (sessionId: string): Promise<unknown> => transport.invoke(IPC.sessions.getTree, sessionId),
    bookmark: (sessionPath: string, entryId: string, id: string, label: string, preview: string): Promise<unknown> => transport.invoke(IPC.sessions.bookmark, sessionPath, entryId, id, label, preview),
    resume: (snapshotId: string): Promise<unknown> => transport.invoke(IPC.sessions.resume, snapshotId),
    deleteBookmark: (snapshotId: string): Promise<unknown> => transport.invoke(IPC.sessions.deleteBookmark, snapshotId),
    onEvent: (cb: (event: unknown) => void): (() => void) => {
      const listener = (event: unknown) => cb(event);
      transport.on("session:event", listener);
      return () => { transport.off("session:event", listener); };
    },
    onKernelEvent: (cb: (event: unknown) => void): (() => void) => {
      const listener = (event: unknown) => cb(event);
      transport.on("session:kernelEvent", listener);
      return () => { transport.off("session:kernelEvent", listener); };
    },
    onQuestion: (cb: (req: unknown) => void): (() => void) => {
      const listener = (req: unknown) => cb(req);
      transport.on("session:question", listener);
      return () => { transport.off("session:question", listener); };
    },
    answerQuestion: (requestId: string, answers: unknown): Promise<void> =>
      transport.invoke(IPC.session.answerQuestion, requestId, answers),
    listTools: (): Promise<unknown> =>
      transport.invoke(IPC.session.listTools),
    onSnapshot: (cb: (snapshot: unknown) => void): (() => void) => {
      const listener = (snapshot: unknown) => cb(snapshot);
      transport.on("session:snapshot", listener);
      return () => { transport.off("session:snapshot", listener); };
    },
    // MessagingApi
    prompt: (text: string, images?: { data: string; mimeType: string; name?: string }[], display?: { image?: { src: string; title?: string } }, prefs?: unknown): Promise<void> =>
      transport.invoke(IPC.session.prompt, text, images, display, prefs),
    abort: (): Promise<void> => transport.invoke(IPC.session.abort),
    continue: (): Promise<void> => transport.invoke(IPC.session.continue),
    // ModelApi
    getModels: (): Promise<unknown[]> => transport.invoke(IPC.session.getModels),
    setModel: (provider: string, modelId: string, kernel: KernelId): Promise<void> =>
      transport.invoke(IPC.session.setModel, provider, modelId, kernel),
    // 模型连通性测试(内核隔离临时会话,不碰激活会话)
    testModel: (cwd: string, provider: string, modelId: string, kernel: KernelId): Promise<{ ok: boolean; error?: string }> =>
      transport.invoke(IPC.session.testModel, cwd, provider, modelId, kernel),
    setThinkingLevel: (level: string): Promise<void> =>
      transport.invoke(IPC.session.setThinkingLevel, level),
    // SessionTreeApi
    fork: (parentLineageId: string, boundary?: string): Promise<string> => transport.invoke(IPC.session.fork, parentLineageId, boundary),
    // SessionMaintenanceApi
    getStats: (): Promise<unknown> => transport.invoke(IPC.session.getStats),
    // QueueModeApi
    // BashApi (需声明 rpc:bash 权限)
    runBash: (command: string, excludeFromContext?: boolean): Promise<{ stdout: string; stderr: string; exitCode: number }> =>
      transport.invoke(IPC.session.runBash, command, excludeFromContext),
    abortBash: (): Promise<void> => transport.invoke(IPC.session.abortBash),
    // pi 内核专属扩展面(§7.6):壳插件经 capabilities.piExtension 探测「有则用、无则降级」
    pi: {
      steer: (text: string, images?: { data: string; mimeType: string; name?: string }[]): Promise<void> =>
        transport.invoke(IPC.session.steer, text, images),
      followUp: (text: string, images?: { data: string; mimeType: string; name?: string }[]): Promise<void> =>
        transport.invoke(IPC.session.followUp, text, images),
      abortRetry: (): Promise<void> => transport.invoke(IPC.session.abortRetry),
      cycleModel: (): Promise<void> => transport.invoke(IPC.session.cycleModel),
      getThinkingLevels: (): Promise<string[]> => transport.invoke(IPC.session.getThinkingLevels),
      cycleThinkingLevel: (): Promise<void> => transport.invoke(IPC.session.cycleThinkingLevel),
      forkFromSession: (cwd: string, srcNs: string, entryId: string, position?: "before" | "at"): Promise<void> =>
        transport.invoke(IPC.session.forkFromSession, cwd, srcNs, entryId, position),
      clone: (): Promise<void> => transport.invoke(IPC.session.clone),
      getForkMessages: (entryId: string): Promise<unknown[]> => transport.invoke(IPC.session.getForkMessages, entryId),
      compact: (customInstructions?: string): Promise<void> => transport.invoke(IPC.session.compact, customInstructions),
      setAutoCompaction: (enabled: boolean): Promise<void> => transport.invoke(IPC.session.setAutoCompaction, enabled),
      setAutoRetry: (enabled: boolean): Promise<void> => transport.invoke(IPC.session.setAutoRetry, enabled),
      exportHtml: (outputPath?: string): Promise<string> => transport.invoke(IPC.session.exportHtml, outputPath),
      getLastAssistantText: (): Promise<string> => transport.invoke(IPC.session.getLastAssistantText),
      setSteeringMode: (mode: "all" | "one-at-a-time"): Promise<void> => transport.invoke(IPC.session.setSteeringMode, mode),
      setFollowUpMode: (mode: "all" | "one-at-a-time"): Promise<void> => transport.invoke(IPC.session.setFollowUpMode, mode),
    },
    // SessionSnapshotApi
    copySession: (srcPath: string, targetPath: string): Promise<void> =>
      transport.invoke(IPC.session.copySession, srcPath, targetPath),
  },
  /** Session Bus 能力(声明 sessions:bus 权限后可用;pluginId 首参,main 门控)。 */
  bus: {
    status: (pluginId: string): Promise<unknown> => transport.invoke(IPC.bus.status, pluginId),
    send: (pluginId: string, to: string, kind: string, payload: unknown, replyTo?: string): Promise<{ delivered: string }> =>
      transport.invoke(IPC.bus.send, pluginId, to, kind, payload, replyTo),
    sessionCreate: (pluginId: string, opts: { task?: string; cwd?: string; name?: string; model?: { provider: string; modelId: string }; toolConfig?: unknown; watch?: boolean; channels?: string[] }): Promise<unknown> =>
      transport.invoke(IPC.bus.sessionCreate, pluginId, opts),
    sessionAbort: (pluginId: string, session: string): Promise<unknown> =>
      transport.invoke(IPC.bus.sessionAbort, pluginId, session),
    channelMember: (pluginId: string, channel: string, action: "join" | "leave", member?: string): Promise<unknown> =>
      transport.invoke(IPC.bus.channelMember, pluginId, channel, action, member),
    tapStart: (pluginId: string, opts: { session?: string; channel?: string; filter?: "done" | "lifecycle" | "stream"; deliverTo?: string }): Promise<{ tapId: string; filter: string }> =>
      transport.invoke(IPC.bus.tapStart, pluginId, opts),
    tapStop: (pluginId: string, tapId: string): Promise<unknown> =>
      transport.invoke(IPC.bus.tapStop, pluginId, tapId),
    onMessage: (cb: (message: unknown) => void): (() => void) => {
      const listener = (message: unknown) => cb(message);
      transport.on(IPC.bus.event, listener);
      return () => { transport.off(IPC.bus.event, listener); };
    },
  },
  /** fs:project 能力(声明 permissions 后可用;pluginId 首参,main 门控)。 */
  fs: {
    listDir: (pluginId: string, cwd: string): Promise<{ name: string; isDir: boolean }[]> =>
      transport.invoke(IPC.fs.listDir, pluginId, cwd),
    removePath: (pluginId: string, path: string): Promise<void> =>
      transport.invoke(IPC.fs.removePath, pluginId, path),
    readDirTree: (pluginId: string, cwd: string, opts?: { maxDepth?: number; ignore?: string[] }): Promise<{ name: string; isDir: boolean; children?: unknown[] }> =>
      transport.invoke(IPC.fs.readDirTree, pluginId, cwd, opts),
    readFile: (pluginId: string, path: string): Promise<string> =>
      transport.invoke(IPC.fs.readFile, pluginId, path),
    readFileBase64: (pluginId: string, path: string): Promise<string> =>
      transport.invoke(IPC.fs.readFileBase64, pluginId, path),
    createFile: (pluginId: string, path: string): Promise<void> =>
      transport.invoke(IPC.fs.createFile, pluginId, path),
    createDir: (pluginId: string, path: string): Promise<void> =>
      transport.invoke(IPC.fs.createDir, pluginId, path),
    renamePath: (pluginId: string, from: string, to: string): Promise<void> =>
      transport.invoke(IPC.fs.renamePath, pluginId, from, to),
    copyPath: (pluginId: string, from: string, to: string): Promise<void> =>
      transport.invoke(IPC.fs.copyPath, pluginId, from, to),
  },
  /** git:read 能力(声明 permissions 后可用;pluginId 首参,main 门控)。 */
  git: {
    status: (pluginId: string, cwd: string): Promise<GitStatusResult> =>
      transport.invoke(IPC.git.status, pluginId, cwd),
    fileDiff: (pluginId: string, cwd: string, path: string): Promise<string> =>
      transport.invoke(IPC.git.fileDiff, pluginId, cwd, path),
    fileContent: (pluginId: string, cwd: string, path: string): Promise<string> =>
      transport.invoke(IPC.git.fileContent, pluginId, cwd, path),
    log: (pluginId: string, cwd: string, limit: number): Promise<GitLogEntry[]> =>
      transport.invoke(IPC.git.log, pluginId, cwd, limit),
  },
  /** git:write 能力(收敛面:commit/push;pluginId 首参,main 门控)。 */
  gitWrite: {
    commit: (pluginId: string, cwd: string, message: string, files: string[]): Promise<{ ok: boolean; hash?: string; error?: string }> =>
      transport.invoke(IPC.git.commit, pluginId, cwd, message, files),
    push: (pluginId: string, cwd: string): Promise<{ ok: boolean; error?: string }> =>
      transport.invoke(IPC.git.push, pluginId, cwd),
  },
  /** llm:oneshot 能力(一次性问内核;pluginId 首参,main 门控)。 */
  llm: {
    oneshot: (pluginId: string, prompt: string): Promise<string> =>
      transport.invoke(IPC.llm.oneshot, pluginId, prompt),
  },
  /** 对话框(用户手势驱动)。 */
  dialog: {
    openDirectory: (): Promise<string | null> => transport.invoke(IPC.dialog.openDirectory),
    openImages: (): Promise<{ name: string; data: string; mimeType: string }[]> =>
      transport.invoke(IPC.dialog.openImages),
    openTextFile: (opts?: { filters?: { name: string; extensions: string[] }[] }): Promise<{ name: string; content: string } | null> =>
      transport.invoke(IPC.dialog.openTextFile, opts),
    saveTextFile: (opts: { name: string; content: string; filters?: { name: string; extensions: string[] }[]; defaultFileName?: string }): Promise<string | null> =>
      transport.invoke(IPC.dialog.saveTextFile, opts),
    writeImages: (dir: string, images: { name: string; base64: string }[]): Promise<number> =>
      transport.invoke(IPC.dialog.writeImages, dir, images),
    saveZip: (opts: { name: string; files: { name: string; base64: string }[]; defaultFileName?: string }): Promise<string | null> =>
      transport.invoke(IPC.dialog.saveZip, opts),
    openZip: (opts?: { filters?: { name: string; extensions: string[] }[] }): Promise<{ name: string; files: { name: string; base64: string }[] } | null> =>
      transport.invoke(IPC.dialog.openZip, opts),
  },
  /** Skills 管理（核心默认能力）。 */
  skills: {
    list: (cwd: string): Promise<unknown[]> => transport.invoke(IPC.skills.list, cwd),
    getCapabilities: (): Promise<unknown> => transport.invoke(IPC.skills.getCapabilities),
    setEnabled: (skill: unknown, enabled: boolean): Promise<void> =>
      transport.invoke(IPC.skills.setEnabled, { skill, enabled }),
    setModelInvocable: (skill: unknown, value: boolean): Promise<void> =>
      transport.invoke(IPC.skills.setModelInvocable, { skill, value }),
    getBundled: (): Promise<{ path: string; enabled: boolean }> =>
      transport.invoke(IPC.skills.getBundled),
    setBundledEnabled: (enabled: boolean): Promise<void> =>
      transport.invoke(IPC.skills.setBundledEnabled, enabled),
    watch: (cwd: string, onChanged: () => void): (() => void) => {
      const listener = () => onChanged();
      transport.on("skills:changed", listener);
      transport.invoke(IPC.skills.watch, cwd);
      return () => {
        transport.off("skills:changed", listener);
        transport.invoke(IPC.skills.unwatch, cwd);
      };
    },
  },
  plugins: {
    list: (): Promise<unknown[]> => transport.invoke(IPC.plugins.list),
    enable: (pluginId: string): Promise<{ ok: boolean; error: string | null }> =>
      transport.invoke(IPC.plugins.enable, pluginId),
    disable: (pluginId: string): Promise<{ ok: boolean; error: string | null }> =>
      transport.invoke(IPC.plugins.disable, pluginId),
    uninstall: (pluginId: string): Promise<{ ok: boolean; error: string | null }> =>
      transport.invoke(IPC.plugins.uninstall, pluginId),
    reload: (pluginId: string): Promise<{ ok: boolean; error: string | null }> =>
      transport.invoke(IPC.plugins.reload, pluginId),
    /** 插件 renderer 模块加载失败时上报：主进程撤注册 + 记 error 态 + 广播 pluginsChanged。 */
    reportLoadFailed: (pluginId: string): Promise<void> =>
      transport.invoke(IPC.plugins.loadFailed, pluginId),
    install: (source: { type: "url" | "local"; location: string }): Promise<{ ok: boolean; error: string | null }> =>
      transport.invoke(IPC.plugins.install, source),
    onUnloaded: (cb: (pluginId: string, components: string[]) => void): (() => void) => {
      const listener = (data: { pluginId: string; components: string[] }) => cb(data.pluginId, data.components);
      transport.on("plugin:unloaded", listener);
      return () => { transport.off("plugin:unloaded", listener); };
    },
    onPluginsChanged: (cb: (nonce: number) => void): (() => void) => {
      const listener = (nonce: number) => cb(nonce);
      transport.on("plugins:changed", listener);
      return () => { transport.off("plugins:changed", listener); };
    },
  },
  /** settings.json 被外部写入(如 skill-toggle 改 skills 字段)的通知,settings-page 订阅后重读(评估 P1-E 失同步修复)。 */
  onSettingsChanged: (cb: () => void): (() => void) => {
    const listener = () => cb();
    transport.on("settings:changed", listener);
    return () => { transport.off("settings:changed", listener); };
  },
  /** 通用刷新信号(装/升/降级内核、自定义内核路径变更等操作完成):消费方(会话流)
   *  收到后重探挂载时探测的外部状态,不用重启。契约单源 IPC.refresh.requested,
   *  语义不绑具体资源——将来 tool-gate 安装等操作完成后也发这个。 */
  onRefreshRequested: (cb: () => void): (() => void) => {
    const listener = () => cb();
    transport.on(IPC.refresh.requested, listener);
    return () => { transport.off(IPC.refresh.requested, listener); };
  },
  /** 内核拓展管理(中性,按 kernel 作用域):pi/dsh 各交一个 KernelExtensionSource。 */
  kernelExtensions: {
    list: (kernel: string): Promise<unknown[]> => transport.invoke(IPC.kernelExtensions.list, kernel),
    enable: (kernel: string, id: string): Promise<void> => transport.invoke(IPC.kernelExtensions.enable, kernel, id),
    disable: (kernel: string, id: string): Promise<void> => transport.invoke(IPC.kernelExtensions.disable, kernel, id),
    install: (
      kernel: string,
      source: string,
      onProgress: (line: string) => void,
    ): Promise<{ ok: boolean; error?: string }> => {
      const progListener = (line: string) => onProgress(line);
      transport.on(IPC.kernelExtensions.installProgress, progListener);
      return transport.invoke(IPC.kernelExtensions.install, kernel, source).finally(() => {
        transport.off(IPC.kernelExtensions.installProgress, progListener);
      });
    },
    uninstall: (
      kernel: string,
      id: string,
      onProgress: (line: string) => void,
    ): Promise<{ ok: boolean; error?: string }> => {
      const progListener = (line: string) => onProgress(line);
      transport.on(IPC.kernelExtensions.installProgress, progListener);
      return transport.invoke(IPC.kernelExtensions.uninstall, kernel, id).finally(() => {
        transport.off(IPC.kernelExtensions.installProgress, progListener);
      });
    },
  },
  restart: {
    pendingSessions: (): Promise<{ sessionKey: string; state: unknown }[]> =>
      transport.invoke(IPC.restart.pendingSessions),
    restart: (sessionKey: string): Promise<void> => transport.invoke(IPC.restart.restart, sessionKey),
    restartAllIdle: (): Promise<void> => transport.invoke(IPC.restart.restartAllIdle),
    onStateChange: (cb: (sessionKey: string, state: unknown) => void): (() => void) => {
      const listener = (sessionKey: string, state: unknown) => cb(sessionKey, state);
      transport.on("restart:state", listener);
      return () => { transport.off("restart:state", listener); };
    },
  },
  /** 运行平台(platform 直传):renderer 平台分支用(标题栏自绘按钮等)。 */
  platform: platform,
  /** 应用基本信息(name/version/electron/node/chrome/isPackaged)。 */
  app: {
    info: (): Promise<{
      name: string; version: string; electron: string; node: string; chrome: string;
      platform: string; isPackaged: boolean;
    }> => transport.invoke(IPC.app.info),
    /** 整 App 重启,退出链路同手动退出(经 before-quit 回收 pi 子进程)。 */
    restart: (): Promise<void> => transport.invoke(IPC.app.restart),
  },
  /** 系统通知(mac 通知中心 / win toast / linux libnotify):纯机制,文案由调用方传。 */
  notify: {
    show: (opts: { title: string; body: string; silent?: boolean }): Promise<void> =>
      transport.invoke(IPC.notification.show, opts),
  },
  /** 窗口控制(win/linux 自绘标题栏按钮用;mac 红绿灯原生,不消费)。 */
  window: {
    minimize: (): Promise<void> => transport.invoke(IPC.window.minimize),
    toggleMaximize: (): Promise<void> => transport.invoke(IPC.window.toggleMaximize),
    close: (): Promise<void> => transport.invoke(IPC.window.close),
    isMaximized: (): Promise<boolean> => transport.invoke(IPC.window.isMaximized),
    isFocused: (): Promise<boolean> => transport.invoke(IPC.window.isFocused),
    onMaximizedChanged: (cb: (maximized: boolean) => void): (() => void) => {
      const listener = (maximized: boolean) => cb(maximized);
      transport.on(IPC.window.maximizedChanged, listener);
      return () => { transport.off(IPC.window.maximizedChanged, listener); };
    },
  },
  /** 远程访问控制面(§18.6)。 */
  remote: {
    status: (): Promise<unknown> => transport.invoke(IPC.remote.status),
    start: (): Promise<unknown> => transport.invoke(IPC.remote.start),
    stop: (): Promise<unknown> => transport.invoke(IPC.remote.stop),
    setPassword: (password: string): Promise<unknown> => transport.invoke(IPC.remote.setPassword, password),
    refreshPassword: (): Promise<unknown> => transport.invoke(IPC.remote.refreshPassword),
    setLanPasswordEnabled: (enabled: boolean): Promise<unknown> => transport.invoke(IPC.remote.setLanPasswordEnabled, enabled),
    tunnelStart: (opts?: { binary?: string; disclaimer?: boolean }): Promise<unknown> => transport.invoke(IPC.remote.tunnelStart, opts),
    tunnelStop: (): Promise<unknown> => transport.invoke(IPC.remote.tunnelStop),
    qr: (): Promise<string | null> => transport.invoke(IPC.remote.qr),
    onStateChanged: (cb: (state: unknown) => void): (() => void) => {
      const listener = (...args: unknown[]) => cb(args[0]);
      transport.on(IPC.remote.stateChanged, listener);
      return () => { transport.off(IPC.remote.stateChanged, listener); };
    },
  },
};

  return kernel as KernelApi;
}
