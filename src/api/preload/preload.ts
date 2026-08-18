// preload 桥 —— renderer 与 main 之间的受控通道(contextBridge)。
//
// 依据 DESIGN.md §3.2.5(RendererPluginContext)、structure/16 §7.3.1。
// 暴露 scoped pi.* API:renderer 不直接拿 Node/Electron,经此受控访问。
// security:contextIsolation=true,nodeIntegration=false(preload 在隔离上下文跑)。
//
// 能力分层(对齐 domain/context 的 PluginContext):
// - 核心默认:sessions/config/prefs/themes/settings/piSettings/models/kernel/configFile/openFile
// - 声明能力:fs(fs:project)/git(git:read)——pluginId 首参,main 边界查 manifest 门控
// - dialog:用户手势驱动,默认放行
import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "./ipc-channels";
import type { HeaderPatch, SessionToolConfig, KnownToolInfo, GitStatusResult, GitLogEntry } from "../../core/domain/sessions";
import type { KernelStatus } from "../../core/application/kernel/kernel-manager";

/** 暴露到 renderer 的 pi 全局对象(window.pi)。 */
const pi = {
  /** 插件配置:统一项目级配置通道(项目级 <cwd>/.my-harness-desktop/config/{id}.json 默认,
   *  全局 ~/.my-harness-desktop/config/{id}.json 兜底)。renderer 不直接写,经此 → main → ConfigStore。 */
  config: {
    get: <T>(pluginId: string, key: string): Promise<T | undefined> =>
      ipcRenderer.invoke(IPC.config.get, pluginId, key),
    set: (pluginId: string, key: string, value: unknown, opts?: { scope?: "project" | "global" }): Promise<void> =>
      ipcRenderer.invoke(IPC.config.set, pluginId, key, value, opts),
    all: (pluginId: string): Promise<Record<string, unknown>> =>
      ipcRenderer.invoke(IPC.config.all, pluginId),
    getScope: (pluginId: string, scope: "project" | "global"): Promise<Record<string, unknown>> =>
      ipcRenderer.invoke(IPC.config.getScope, pluginId, scope),
  },
  /** 桌面偏好(electron-store):currentThemeId/fontScale/fontMono/fontEnglish/fontChinese 等。 */
  prefs: {
    get: <T>(key: string): Promise<T> => ipcRenderer.invoke(IPC.prefs.get, key),
    set: (key: string, value: unknown): Promise<void> =>
      ipcRenderer.invoke(IPC.prefs.set, key, value),
  },
  /** 主题:列表 + 合并(经 application/theme/merge)。 */
  themes: {
    list: (): Promise<{ id: string; name: string }[]> =>
      ipcRenderer.invoke(IPC.themes.list),
    build: (
      themeId: string,
      fontScale: number,
      fontMono: string,
      fontEnglish: string,
      fontChinese: string,
    ): Promise<Record<string, string>> =>
      ipcRenderer.invoke(IPC.themes.build, themeId, fontScale, fontMono, fontEnglish, fontChinese),
    /** 系统明暗变化推送(__auto__ 动态 base 重 build 用);返回清理函数。 */
    onSystemChanged: (cb: () => void): (() => void) => {
      const listener = (): void => cb();
      ipcRenderer.on(IPC.themes.systemChanged, listener);
      return () => {
        ipcRenderer.removeListener(IPC.themes.systemChanged, listener);
      };
    },
  },
  /** 字体预设:fontPresets 槽贡献项列表(theme-manager 字体 tab 查槽渲染,不感知 IPC/注册表)。 */
  fonts: {
    list: (): Promise<{ id: string; category: "mono" | "english" | "chinese"; labelKey: string; stack: string; generic?: "serif" | "sans-serif" }[]> =>
      ipcRenderer.invoke(IPC.fonts.list),
  },
  /** 设置页:settings 槽贡献项列表。 */
  settings: {
    list: (): Promise<
      { id: string; title: string; icon: string; component: string; pluginId: string; configFile: string | null; configMerge: "deep" | "replace"; saveMode: "framework" | "manual" }[]
    > => ipcRenderer.invoke(IPC.settings.list),
  },
  /** 槽位清单:sidePanel(右面板 Tab)/ sidebar(左栏分组)/ titlebar(标题栏按钮)。 */
  slots: {
    sidePanel: (): Promise<{ id: string; label: string; icon: string; component: string; pluginId: string; revealOn?: string }[]> =>
      ipcRenderer.invoke(IPC.slots.sidePanel),
    sidebar: (): Promise<{ id: string; title: string; component: string; pluginId: string }[]> =>
      ipcRenderer.invoke(IPC.slots.sidebar),
    mainView: (): Promise<{ id: string; component: string; pluginId: string }[]> =>
      ipcRenderer.invoke(IPC.slots.mainView),
    titlebar: (): Promise<{ id: string; component: string; pluginId: string }[]> =>
      ipcRenderer.invoke(IPC.slots.titlebar),
    fileActions: (): Promise<{ id: string; labelKey: string; icon?: string; when?: { target?: "file" | "dir" | "both" }; pluginId: string }[]> =>
      ipcRenderer.invoke(IPC.slots.fileActions),
    fileIcons: (): Promise<{ id: string; icon: string; extensions?: string[]; filenames?: string[]; color?: string; pluginId: string }[]> =>
      ipcRenderer.invoke(IPC.slots.fileIcons),
    messageActions: (): Promise<{ id: string; component: string; placement?: "left" | "right"; when?: { role?: string[] }; order?: number; pluginId: string }[]> =>
      ipcRenderer.invoke(IPC.slots.messageActions),
    blockRenderers: (): Promise<{ id: string; block: string; names?: string[]; component: string; order?: number; pluginId: string }[]> =>
      ipcRenderer.invoke(IPC.slots.blockRenderers),
    codeBlockRenderers: (): Promise<{ id: string; languages: string[]; component: string; order?: number; pluginId: string }[]> =>
      ipcRenderer.invoke(IPC.slots.codeBlockRenderers),
    sessionGroupings: (): Promise<{ id: string; parentPathKey: string; childLabelKey?: string; childIcon?: string; order?: number; pluginId: string }[]> =>
      ipcRenderer.invoke(IPC.slots.sessionGroupings),
    composerPolicies: (): Promise<{ id: string; customKey: string; readonlyMessageKey?: string; order?: number; pluginId: string }[]> =>
      ipcRenderer.invoke(IPC.slots.composerPolicies),
    composerAttachments: (): Promise<{ id: string; component: string; order?: number; pluginId: string }[]> =>
      ipcRenderer.invoke(IPC.slots.composerAttachments),
    composerActions: (): Promise<{ id: string; component: string; order?: number; pluginId: string }[]> =>
      ipcRenderer.invoke(IPC.slots.composerActions),
    settingsGroups: (): Promise<{ id: string; titleKey: string; order?: number; fields: { key: string; type: "boolean" | "enum" | "int"; default?: boolean | string | number; titleKey: string; descKey?: string; options?: Array<number | { value: string; labelKey?: string }> }[]; pluginId: string }[]> =>
      ipcRenderer.invoke(IPC.slots.settingsGroups),
  },
  /** pi 内核管理:版本状态 / registry 版本清单 / 安装指定版本 / 自定义底座目录。 */
  kernel: {
    status: (): Promise<KernelStatus> => ipcRenderer.invoke(IPC.kernel.status),
    /** 设置/清除自定义底座目录(docs/design/custom-cli-path.md):空串=清除;
     *  校验不过不写入,返回 error;成功返回新 status + 被标 restart pending 的会话数。 */
    setCustomCliDir: (dir: string): Promise<{
      ok: boolean;
      error: string | null;
      pendingCount: number;
      status: KernelStatus | null;
    }> => ipcRenderer.invoke(IPC.kernel.setCustomCliDir, dir),
    toolgateAvailable: (): Promise<boolean> => ipcRenderer.invoke(IPC.kernel.toolgateAvailable),
    knownTools: (cwd: string): Promise<KnownToolInfo[] | null> =>
      ipcRenderer.invoke(IPC.kernel.knownTools, cwd),
    listVersions: (forceRefresh = false): Promise<{
      versions: string[];
      latest: string | null;
    }> => ipcRenderer.invoke(IPC.kernel.listVersions, forceRefresh),
    /** 安装/切换 pi 版本到 ~/.my-harness-desktop/pi(覆盖式:装新=更新、装旧=降级)。
     *  进度经 onProgress,完成经 onDone。完成信号以 onDone 为准(main send done),
     *  不靠 invoke 返回值(invoke reply 与 done 事件顺序不保证,曾致 onDone 不触发卡住)。 */
    install: (
      version: string,
      onProgress: (line: string) => void,
      onDone: (r: { ok: boolean; error: string | null }) => void,
    ): Promise<{ ok: boolean; error: string | null }> => {
      const progListener = (_e: unknown, line: string) => onProgress(line);
      ipcRenderer.on("kernel:install-progress", progListener);
      let cleaned = false;
      const cleanup = (): void => {
        if (cleaned) return;
        cleaned = true;
        ipcRenderer.removeListener("kernel:install-progress", progListener);
        ipcRenderer.removeListener("kernel:install-done", doneListener);
      };
      let resolveFn: ((r: { ok: boolean; error: string | null }) => void) | null = null;
      const doneListener = (_e: unknown, r: { ok: boolean; error: string | null }) => {
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
      ipcRenderer.on("kernel:install-done", doneListener);
      const invokeP = ipcRenderer.invoke(IPC.kernel.install, version) as Promise<{ ok: boolean; error: string | null }>;
      // invoke reject/异常时也清(兜底,正常路径 onDone 触发 cleanup)
      invokeP.catch(() => cleanup());
      return new Promise((resolve) => {
        resolveFn = resolve;
        // 兜底:onDone 5 分钟未到(安装卡死)也 resolve,避免 Promise 永悬
        setTimeout(() => { if (!cleaned) { cleanup(); resolveFn?.({ ok: false, error: "安装超时" }); } }, 300000);
      });
    },
  },
  /** dsh 内核版本管理(与 pi 同构:@deepseek-ai/dsh 装到 ~/.my-harness-desktop/dsh)。 */
  dshKernel: {
    status: (): Promise<KernelStatus> => ipcRenderer.invoke(IPC.dshKernel.status),
    setCustomCliDir: (dir: string): Promise<{ ok: boolean; error: string | null; status: KernelStatus | null }> =>
      ipcRenderer.invoke(IPC.dshKernel.setCustomCliDir, dir),
    listVersions: (forceRefresh = false): Promise<{ versions: string[]; latest: string | null }> =>
      ipcRenderer.invoke(IPC.dshKernel.listVersions, forceRefresh),
    install: (
      version: string,
      onProgress: (line: string) => void,
      onDone: (r: { ok: boolean; error: string | null }) => void,
    ): Promise<{ ok: boolean; error: string | null }> => {
      const progListener = (_e: unknown, line: string) => onProgress(line);
      ipcRenderer.on("kernel:install-progress", progListener);
      let cleaned = false;
      const cleanup = (): void => {
        if (cleaned) return;
        cleaned = true;
        ipcRenderer.removeListener("kernel:install-progress", progListener);
      };
      let resolveFn: ((r: { ok: boolean; error: string | null }) => void) | null = null;
      const doneListener = (_e: unknown, r: { ok: boolean; error: string | null }) => {
        cleanup();
        onDone(r);
        resolveFn?.(r);
      };
      ipcRenderer.on("kernel:install-done", doneListener);
      const invokeP = ipcRenderer.invoke(IPC.dshKernel.install, version) as Promise<{ ok: boolean; error: string | null }>;
      invokeP.catch(() => cleanup());
      return new Promise((resolve) => {
        resolveFn = resolve;
        setTimeout(() => { if (!cleaned) { cleanup(); resolveFn?.({ ok: false, error: "安装超时" }); } }, 300000);
      });
    },
  },
  /** dsh 模型配置(读写 settings.yaml 的多 provider 路由详情 + 默认模型)。 */
  dshModels: {
    get: (): Promise<unknown[]> => ipcRenderer.invoke(IPC.dshModels.get),
    set: (provider: string, detail: { api?: string; baseURL?: string; models: { id: string; name?: string; contextWindow?: number; maxTokens?: number }[] }): Promise<unknown[]> =>
      ipcRenderer.invoke(IPC.dshModels.set, provider, detail),
    removeProvider: (provider: string): Promise<unknown[]> =>
      ipcRenderer.invoke(IPC.dshModels.removeProvider, provider),
    getDefault: (): Promise<{ provider: string; model: string; reasoningEffort?: string } | null> =>
      ipcRenderer.invoke(IPC.dshModels.getDefault),
    setDefault: (sel: { provider: string; model: string; reasoningEffort?: string }): Promise<{ provider: string; model: string; reasoningEffort?: string } | null> =>
      ipcRenderer.invoke(IPC.dshModels.setDefault, sel),
    test: (cwd: string, provider: string, modelId: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.dshModels.test, cwd, provider, modelId),
  },
  /** dsh 配置(整份 ~/.dsh/settings.yaml 读写)。 */
  dshSettings: {
    get: (): Promise<Record<string, unknown>> => ipcRenderer.invoke(IPC.dshSettings.get),
    set: (obj: Record<string, unknown>): Promise<Record<string, unknown>> => ipcRenderer.invoke(IPC.dshSettings.set, obj),
  },
  /** dsh 拓展(Cordis 插件树:列/禁/启,禁=移出 cordis.yml、启=还原)。 */
  dshPlugins: {
    list: (): Promise<{ id: string; name: string }[]> => ipcRenderer.invoke(IPC.dshPlugins.list),
    listAvailable: (): Promise<{ name: string }[]> => ipcRenderer.invoke(IPC.dshPlugins.listAvailable),
    listDisabled: (): Promise<{ id: string; name: string }[]> => ipcRenderer.invoke(IPC.dshPlugins.listDisabled),
    disable: (id: string): Promise<{ id: string; name: string }[]> => ipcRenderer.invoke(IPC.dshPlugins.disable, id),
    enable: (id: string): Promise<{ id: string; name: string }[]> => ipcRenderer.invoke(IPC.dshPlugins.enable, id),
    install: (
      pkgName: string,
      onProgress: (line: string) => void,
    ): Promise<{ ok: boolean; error?: string; id?: string }> => {
      const progListener = (_e: unknown, line: string) => onProgress(line);
      ipcRenderer.on("kernel:install-progress", progListener);
      return ipcRenderer.invoke(IPC.dshPlugins.install, pkgName).finally(() => {
        ipcRenderer.removeListener("kernel:install-progress", progListener);
      });
    },
  },
  /** pi 底座 settings(读写 ~/.pi/agent/settings.json,底座标准契约)。 */
  piSettings: {
    get: (): Promise<Record<string, unknown>> => ipcRenderer.invoke(IPC.piSettings.get),
    set: (patch: Record<string, unknown>): Promise<Record<string, unknown>> =>
      ipcRenderer.invoke(IPC.piSettings.set, patch),
    /** 解析底座 .d.ts 拿当前版本所有字段(未知字段兜底用) */
    schema: (): Promise<{ key: string; type: string }[]> => ipcRenderer.invoke(IPC.piSettings.schema),
  },
  /** i18n:语言槽合并后给 renderer init + locale 列表 + 检测(05-plugin-i18n)。 */
  i18n: {
    resources: (): Promise<{
      resources: Record<string, Record<string, Record<string, string>>>;
      ns: string[];
      supportedLngs: string[];
    }> => ipcRenderer.invoke(IPC.i18n.resources),
    list: (): Promise<{ id: string; name: string }[]> => ipcRenderer.invoke(IPC.i18n.list),
    detect: (navigatorLanguage: string): Promise<string> => ipcRenderer.invoke(IPC.i18n.detect, navigatorLanguage),
  },
  /** pi 底座模型配置(读写 ~/.pi/agent/models.json)。 */
  models: {
    get: <T>(): Promise<T> => ipcRenderer.invoke(IPC.models.get),
    set: <T>(config: T): Promise<T> => ipcRenderer.invoke(IPC.models.set, config),
    /** 合流模型清单(pi + dsh,带 kernel 标;会话流模型下拉用)。 */
    list: (): Promise<unknown[]> => ipcRenderer.invoke(IPC.models.list),
  },
  /** 用系统默认编辑器打开文件(框架"打开配置"按钮用)。 */
  openFile: (path: string): Promise<void> => ipcRenderer.invoke(IPC.misc.openFile, path),
  /** 在系统文件管理器中显示该路径(核心默认,与 openFile 同级)。 */
  revealPath: (path: string): Promise<void> => ipcRenderer.invoke(IPC.misc.revealPath, path),
  /** 通用 JSON 配置文件读写(框架级配置管理)。 */
  configFile: {
    get: (path: string): Promise<Record<string, unknown>> => ipcRenderer.invoke(IPC.configFile.get, path),
    set: (path: string, data: Record<string, unknown>, mergeMode: "deep" | "replace"): Promise<Record<string, unknown>> =>
      ipcRenderer.invoke(IPC.configFile.set, path, data, mergeMode),
    getLayered: (cwd: string, relPath: string): Promise<Record<string, unknown> | null> =>
      ipcRenderer.invoke(IPC.configFile.getLayered, cwd, relPath),
    getProject: (cwd: string, relPath: string): Promise<Record<string, unknown> | null> =>
      ipcRenderer.invoke(IPC.configFile.getProject, cwd, relPath),
    setProject: (cwd: string, relPath: string, data: Record<string, unknown>, mode: "deep" | "replace"): Promise<Record<string, unknown>> =>
      ipcRenderer.invoke(IPC.configFile.setProject, cwd, relPath, data, mode),
    clearProject: (cwd: string, relPath: string): Promise<void> =>
      ipcRenderer.invoke(IPC.configFile.clearProject, cwd, relPath),
    /** 追加一行 JSONL(白名单内;条目形状是内容层的事,通道中性)。 */
    append: (path: string, entry: Record<string, unknown>): Promise<void> =>
      ipcRenderer.invoke(IPC.configFile.append, path, entry),
    /** 读白名单内文件为 base64(不存在返回 null)。 */
    readBinary: (path: string): Promise<string | null> =>
      ipcRenderer.invoke(IPC.configFile.readBinary, path),
    /** 写二进制文件(base64 解码后落盘;白名单内)。 */
    writeBinary: (path: string, base64: string): Promise<void> =>
      ipcRenderer.invoke(IPC.configFile.writeBinary, path, base64),
  },
  /** 会话能力(核心):生命周期 + 消息发送 + 模型 + 树 + 维护 + 队列 + bash。 */
  sessions: {
    // SessionsApi(生命周期)
    start: (cwd: string, sessionPath?: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(IPC.session.start, cwd, sessionPath),
    stop: (sessionPath?: string | null): Promise<{ ok: boolean }> => ipcRenderer.invoke(IPC.session.stop, sessionPath),
    setContext: (cwd: string, sessionPath: string | null): Promise<void> =>
      ipcRenderer.invoke(IPC.session.setContext, cwd, sessionPath),
    getSnapshot: (): Promise<unknown> => ipcRenderer.invoke(IPC.session.getSnapshot),
    sync: (): Promise<unknown> => ipcRenderer.invoke(IPC.session.sync),
    switchKernel: (target: "pi" | "dsh"): Promise<void> => ipcRenderer.invoke(IPC.session.switchKernel, target),
    openSession: (sessionPath: string): Promise<unknown> =>
      ipcRenderer.invoke(IPC.session.open, sessionPath),
    readToolConfig: (sessionPath: string): Promise<SessionToolConfig | null> =>
      ipcRenderer.invoke(IPC.session.readToolConfig, sessionPath),
    renameSession: (sessionPath: string, name: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(IPC.session.rename, sessionPath, name),
    updateHeader: (sessionPath: string, patch: HeaderPatch): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(IPC.session.updateHeader, sessionPath, patch),
    deleteSessions: (paths: string[]): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(IPC.session.delete, paths),
    list: (cwd: string): Promise<unknown[]> => ipcRenderer.invoke(IPC.sessions.list, cwd),
    projectStats: (cwd: string): Promise<unknown> => ipcRenderer.invoke(IPC.sessions.projectStats, cwd),
    getTree: (sessionId: string): Promise<unknown> => ipcRenderer.invoke(IPC.sessions.getTree, sessionId),
    bookmark: (lineageId: string, boundary: string): Promise<unknown> => ipcRenderer.invoke(IPC.sessions.bookmark, lineageId, boundary),
    resume: (anchor: unknown): Promise<unknown> => ipcRenderer.invoke(IPC.sessions.resume, anchor),
    deleteBookmark: (anchor: unknown): Promise<unknown> => ipcRenderer.invoke(IPC.sessions.deleteBookmark, anchor),
    onEvent: (cb: (event: unknown) => void): (() => void) => {
      const listener = (_e: unknown, event: unknown) => cb(event);
      ipcRenderer.on("session:event", listener);
      return () => { ipcRenderer.removeListener("session:event", listener); };
    },
    onKernelEvent: (cb: (event: unknown) => void): (() => void) => {
      const listener = (_e: unknown, event: unknown) => cb(event);
      ipcRenderer.on("session:kernelEvent", listener);
      return () => { ipcRenderer.removeListener("session:kernelEvent", listener); };
    },
    onExtensionUI: (cb: (req: unknown) => void): (() => void) => {
      const listener = (_e: unknown, req: unknown) => cb(req);
      ipcRenderer.on("session:extensionUI", listener);
      return () => { ipcRenderer.removeListener("session:extensionUI", listener); };
    },
    replyExtensionUI: (requestId: string, response: { value?: string; confirmed?: boolean; cancelled?: true }): Promise<void> =>
      ipcRenderer.invoke(IPC.session.replyExtensionUI, requestId, response),
    onSnapshot: (cb: (snapshot: unknown) => void): (() => void) => {
      const listener = (_e: unknown, snapshot: unknown) => cb(snapshot);
      ipcRenderer.on("session:snapshot", listener);
      return () => { ipcRenderer.removeListener("session:snapshot", listener); };
    },
    // MessagingApi
    prompt: (text: string, images?: { data: string; mimeType: string; name?: string }[]): Promise<void> =>
      ipcRenderer.invoke(IPC.session.prompt, text, images),
    abort: (): Promise<void> => ipcRenderer.invoke(IPC.session.abort),
    steer: (text: string, images?: { data: string; mimeType: string; name?: string }[]): Promise<void> =>
      ipcRenderer.invoke(IPC.session.steer, text, images),
    followUp: (text: string, images?: { data: string; mimeType: string; name?: string }[]): Promise<void> =>
      ipcRenderer.invoke(IPC.session.followUp, text, images),
    abortRetry: (): Promise<void> => ipcRenderer.invoke(IPC.session.abortRetry),
    // ModelApi
    getModels: (): Promise<unknown[]> => ipcRenderer.invoke(IPC.session.getModels),
    setModel: (provider: string, modelId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.session.setModel, provider, modelId),
    cycleModel: (): Promise<void> => ipcRenderer.invoke(IPC.session.cycleModel),
    // 模型连通性测试(内核隔离临时会话,不碰激活会话)
    testModel: (cwd: string, provider: string, modelId: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.session.testModel, cwd, provider, modelId),
    getThinkingLevels: (): Promise<string[]> => ipcRenderer.invoke(IPC.session.getThinkingLevels),
    setThinkingLevel: (level: string): Promise<void> =>
      ipcRenderer.invoke(IPC.session.setThinkingLevel, level),
    cycleThinkingLevel: (): Promise<void> => ipcRenderer.invoke(IPC.session.cycleThinkingLevel),
    // SessionTreeApi
    fork: (parentLineageId: string, boundary?: string): Promise<string> => ipcRenderer.invoke(IPC.session.fork, parentLineageId, boundary),
    forkFromSession: (cwd: string, srcPath: string, entryId: string, position?: "before" | "at"): Promise<void> =>
      ipcRenderer.invoke(IPC.session.forkFromSession, cwd, srcPath, entryId, position),
    clone: (): Promise<void> => ipcRenderer.invoke(IPC.session.clone),
    getForkMessages: (entryId: string): Promise<unknown[]> => ipcRenderer.invoke(IPC.session.getForkMessages, entryId),
    // SessionMaintenanceApi
    compact: (customInstructions?: string): Promise<void> => ipcRenderer.invoke(IPC.session.compact, customInstructions),
    setAutoCompaction: (enabled: boolean): Promise<void> => ipcRenderer.invoke(IPC.session.setAutoCompaction, enabled),
    setAutoRetry: (enabled: boolean): Promise<void> => ipcRenderer.invoke(IPC.session.setAutoRetry, enabled),
    exportHtml: (outputPath?: string): Promise<string> => ipcRenderer.invoke(IPC.session.exportHtml, outputPath),
    getLastAssistantText: (): Promise<string> => ipcRenderer.invoke(IPC.session.getLastAssistantText),
    getStats: (): Promise<unknown> => ipcRenderer.invoke(IPC.session.getStats),
    // QueueModeApi
    setSteeringMode: (mode: "all" | "one-at-a-time"): Promise<void> => ipcRenderer.invoke(IPC.session.setSteeringMode, mode),
    setFollowUpMode: (mode: "all" | "one-at-a-time"): Promise<void> => ipcRenderer.invoke(IPC.session.setFollowUpMode, mode),
    // BashApi (需声明 rpc:bash 权限)
    runBash: (command: string, excludeFromContext?: boolean): Promise<{ stdout: string; stderr: string; exitCode: number }> =>
      ipcRenderer.invoke(IPC.session.runBash, command, excludeFromContext),
    abortBash: (): Promise<void> => ipcRenderer.invoke(IPC.session.abortBash),
    // SessionSnapshotApi
    copySession: (srcPath: string, targetPath: string): Promise<void> =>
      ipcRenderer.invoke(IPC.session.copySession, srcPath, targetPath),
  },
  /** Session Bus 能力(声明 sessions:bus 权限后可用;pluginId 首参,main 门控)。 */
  bus: {
    status: (pluginId: string): Promise<unknown> => ipcRenderer.invoke(IPC.bus.status, pluginId),
    send: (pluginId: string, to: string, kind: string, payload: unknown, replyTo?: string): Promise<{ delivered: string }> =>
      ipcRenderer.invoke(IPC.bus.send, pluginId, to, kind, payload, replyTo),
    sessionCreate: (pluginId: string, opts: { task?: string; cwd?: string; name?: string; model?: { provider: string; modelId: string }; toolConfig?: unknown; watch?: boolean; channels?: string[] }): Promise<unknown> =>
      ipcRenderer.invoke(IPC.bus.sessionCreate, pluginId, opts),
    sessionAbort: (pluginId: string, session: string): Promise<unknown> =>
      ipcRenderer.invoke(IPC.bus.sessionAbort, pluginId, session),
    channelMember: (pluginId: string, channel: string, action: "join" | "leave", member?: string): Promise<unknown> =>
      ipcRenderer.invoke(IPC.bus.channelMember, pluginId, channel, action, member),
    tapStart: (pluginId: string, opts: { session?: string; channel?: string; filter?: "done" | "lifecycle" | "stream"; deliverTo?: string }): Promise<{ tapId: string; filter: string }> =>
      ipcRenderer.invoke(IPC.bus.tapStart, pluginId, opts),
    tapStop: (pluginId: string, tapId: string): Promise<unknown> =>
      ipcRenderer.invoke(IPC.bus.tapStop, pluginId, tapId),
    onMessage: (cb: (message: unknown) => void): (() => void) => {
      const listener = (_e: unknown, message: unknown) => cb(message);
      ipcRenderer.on(IPC.bus.event, listener);
      return () => { ipcRenderer.removeListener(IPC.bus.event, listener); };
    },
  },
  /** fs:project 能力(声明 permissions 后可用;pluginId 首参,main 门控)。 */
  fs: {
    listDir: (pluginId: string, cwd: string): Promise<{ name: string; isDir: boolean }[]> =>
      ipcRenderer.invoke(IPC.fs.listDir, pluginId, cwd),
    removePath: (pluginId: string, path: string): Promise<void> =>
      ipcRenderer.invoke(IPC.fs.removePath, pluginId, path),
    readDirTree: (pluginId: string, cwd: string, opts?: { maxDepth?: number; ignore?: string[] }): Promise<{ name: string; isDir: boolean; children?: unknown[] }> =>
      ipcRenderer.invoke(IPC.fs.readDirTree, pluginId, cwd, opts),
    readFile: (pluginId: string, path: string): Promise<string> =>
      ipcRenderer.invoke(IPC.fs.readFile, pluginId, path),
    readFileBase64: (pluginId: string, path: string): Promise<string> =>
      ipcRenderer.invoke(IPC.fs.readFileBase64, pluginId, path),
    createFile: (pluginId: string, path: string): Promise<void> =>
      ipcRenderer.invoke(IPC.fs.createFile, pluginId, path),
    createDir: (pluginId: string, path: string): Promise<void> =>
      ipcRenderer.invoke(IPC.fs.createDir, pluginId, path),
    renamePath: (pluginId: string, from: string, to: string): Promise<void> =>
      ipcRenderer.invoke(IPC.fs.renamePath, pluginId, from, to),
    copyPath: (pluginId: string, from: string, to: string): Promise<void> =>
      ipcRenderer.invoke(IPC.fs.copyPath, pluginId, from, to),
  },
  /** git:read 能力(声明 permissions 后可用;pluginId 首参,main 门控)。 */
  git: {
    status: (pluginId: string, cwd: string): Promise<GitStatusResult> =>
      ipcRenderer.invoke(IPC.git.status, pluginId, cwd),
    fileDiff: (pluginId: string, cwd: string, path: string): Promise<string> =>
      ipcRenderer.invoke(IPC.git.fileDiff, pluginId, cwd, path),
    fileContent: (pluginId: string, cwd: string, path: string): Promise<string> =>
      ipcRenderer.invoke(IPC.git.fileContent, pluginId, cwd, path),
    log: (pluginId: string, cwd: string, limit: number): Promise<GitLogEntry[]> =>
      ipcRenderer.invoke(IPC.git.log, pluginId, cwd, limit),
  },
  /** git:write 能力(收敛面:commit/push;pluginId 首参,main 门控)。 */
  gitWrite: {
    commit: (pluginId: string, cwd: string, message: string, files: string[]): Promise<{ ok: boolean; hash?: string; error?: string }> =>
      ipcRenderer.invoke(IPC.git.commit, pluginId, cwd, message, files),
    push: (pluginId: string, cwd: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.git.push, pluginId, cwd),
  },
  /** llm:oneshot 能力(一次性问底座;pluginId 首参,main 门控)。 */
  llm: {
    oneshot: (pluginId: string, prompt: string): Promise<string> =>
      ipcRenderer.invoke(IPC.llm.oneshot, pluginId, prompt),
  },
  /** 对话框(用户手势驱动)。 */
  dialog: {
    openDirectory: (): Promise<string | null> => ipcRenderer.invoke(IPC.dialog.openDirectory),
    openImages: (): Promise<{ name: string; data: string; mimeType: string }[]> =>
      ipcRenderer.invoke(IPC.dialog.openImages),
    openTextFile: (opts?: { filters?: { name: string; extensions: string[] }[] }): Promise<{ name: string; content: string } | null> =>
      ipcRenderer.invoke(IPC.dialog.openTextFile, opts),
    saveTextFile: (opts: { name: string; content: string; filters?: { name: string; extensions: string[] }[]; defaultFileName?: string }): Promise<string | null> =>
      ipcRenderer.invoke(IPC.dialog.saveTextFile, opts),
    writeImages: (dir: string, images: { name: string; base64: string }[]): Promise<number> =>
      ipcRenderer.invoke(IPC.dialog.writeImages, dir, images),
    saveZip: (opts: { name: string; files: { name: string; base64: string }[]; defaultFileName?: string }): Promise<string | null> =>
      ipcRenderer.invoke(IPC.dialog.saveZip, opts),
    openZip: (opts?: { filters?: { name: string; extensions: string[] }[] }): Promise<{ name: string; files: { name: string; base64: string }[] } | null> =>
      ipcRenderer.invoke(IPC.dialog.openZip, opts),
  },
  /** Skills 管理（核心默认能力）。 */
  skills: {
    list: (cwd: string): Promise<unknown[]> => ipcRenderer.invoke(IPC.skills.list, cwd),
    toggle: (opts: {
      filePath: string; sourcePath: string; enabled: boolean; scope: "user" | "project"; cwd: string;
    }): Promise<void> => ipcRenderer.invoke(IPC.skills.toggle, opts),
    toggleForce: (opts: { filePath: string; force: boolean }): Promise<void> =>
      ipcRenderer.invoke(IPC.skills.toggleForce, opts),
    addPath: (opts: { path: string; scope: "user" | "project"; cwd: string }): Promise<void> =>
      ipcRenderer.invoke(IPC.skills.addPath, opts),
    removePath: (opts: { path: string; scope: "user" | "project"; cwd: string }): Promise<void> =>
      ipcRenderer.invoke(IPC.skills.removePath, opts),
    getSourcePaths: (cwd: string): Promise<{ user: string[]; project: string[] }> =>
      ipcRenderer.invoke(IPC.skills.getSourcePaths, cwd),
    getBundled: (): Promise<{ path: string; enabled: boolean }> =>
      ipcRenderer.invoke(IPC.skills.getBundled),
    setBundledEnabled: (enabled: boolean): Promise<void> =>
      ipcRenderer.invoke(IPC.skills.setBundledEnabled, enabled),
    watch: (cwd: string, onChanged: () => void): (() => void) => {
      const listener = () => onChanged();
      ipcRenderer.on("skills:changed", listener);
      ipcRenderer.invoke(IPC.skills.watch, cwd);
      return () => {
        ipcRenderer.removeListener("skills:changed", listener);
        ipcRenderer.invoke(IPC.skills.unwatch, cwd);
      };
    },
  },
  plugins: {
    list: (): Promise<unknown[]> => ipcRenderer.invoke(IPC.plugins.list),
    enable: (pluginId: string): Promise<{ ok: boolean; error: string | null }> =>
      ipcRenderer.invoke(IPC.plugins.enable, pluginId),
    disable: (pluginId: string): Promise<{ ok: boolean; error: string | null }> =>
      ipcRenderer.invoke(IPC.plugins.disable, pluginId),
    uninstall: (pluginId: string): Promise<{ ok: boolean; error: string | null }> =>
      ipcRenderer.invoke(IPC.plugins.uninstall, pluginId),
    reload: (pluginId: string): Promise<{ ok: boolean; error: string | null }> =>
      ipcRenderer.invoke(IPC.plugins.reload, pluginId),
    /** 插件 renderer 模块加载失败时上报：主进程撤注册 + 记 error 态 + 广播 pluginsChanged。 */
    reportLoadFailed: (pluginId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.plugins.loadFailed, pluginId),
    install: (source: { type: "url" | "local"; location: string }): Promise<{ ok: boolean; error: string | null }> =>
      ipcRenderer.invoke(IPC.plugins.install, source),
    onUnloaded: (cb: (pluginId: string, components: string[]) => void): (() => void) => {
      const listener = (_e: unknown, data: { pluginId: string; components: string[] }) => cb(data.pluginId, data.components);
      ipcRenderer.on("plugin:unloaded", listener);
      return () => { ipcRenderer.removeListener("plugin:unloaded", listener); };
    },
    onPluginsChanged: (cb: (nonce: number) => void): (() => void) => {
      const listener = (_e: unknown, nonce: number) => cb(nonce);
      ipcRenderer.on("plugins:changed", listener);
      return () => { ipcRenderer.removeListener("plugins:changed", listener); };
    },
  },
  /** settings.json 被外部写入(如 skill-toggle 改 skills 字段)的通知,settings-page 订阅后重读(评估 P1-E 失同步修复)。 */
  onSettingsChanged: (cb: () => void): (() => void) => {
    const listener = () => cb();
    ipcRenderer.on("settings:changed", listener);
    return () => { ipcRenderer.removeListener("settings:changed", listener); };
  },
  /** 通用刷新信号(装/升/降级底座、自定义底座路径变更等操作完成):消费方(会话流)
   *  收到后重探挂载时探测的外部状态,不用重启。契约单源 IPC.refresh.requested,
   *  语义不绑具体资源——将来 tool-gate 安装等操作完成后也发这个。 */
  onRefreshRequested: (cb: () => void): (() => void) => {
    const listener = () => cb();
    ipcRenderer.on(IPC.refresh.requested, listener);
    return () => { ipcRenderer.removeListener(IPC.refresh.requested, listener); };
  },
  extension: {
    list: (): Promise<unknown[]> => ipcRenderer.invoke(IPC.extension.list),
    enable: (source: string): Promise<void> => ipcRenderer.invoke(IPC.extension.enable, source),
    disable: (source: string): Promise<void> => ipcRenderer.invoke(IPC.extension.disable, source),
    reorder: (sources: string[]): Promise<void> => ipcRenderer.invoke(IPC.extension.reorder, sources),
    install: (
      source: string,
      onProgress: (line: string) => void,
    ): Promise<{ ok: boolean; error: string | null }> => {
      const progListener = (_e: unknown, line: string) => onProgress(line);
      ipcRenderer.on("extension:install-progress", progListener);
      return ipcRenderer.invoke(IPC.extension.install, source).finally(() => {
        ipcRenderer.removeListener("extension:install-progress", progListener);
      });
    },
    update: (
      source: string,
      onProgress: (line: string) => void,
    ): Promise<{ ok: boolean; error: string | null }> => {
      const progListener = (_e: unknown, line: string) => onProgress(line);
      ipcRenderer.on("extension:install-progress", progListener);
      return ipcRenderer.invoke(IPC.extension.update, source).finally(() => {
        ipcRenderer.removeListener("extension:install-progress", progListener);
      });
    },
    remove: (
      source: string,
      onProgress: (line: string) => void,
    ): Promise<{ ok: boolean; error: string | null }> => {
      const progListener = (_e: unknown, line: string) => onProgress(line);
      ipcRenderer.on("extension:install-progress", progListener);
      return ipcRenderer.invoke(IPC.extension.remove, source).finally(() => {
        ipcRenderer.removeListener("extension:install-progress", progListener);
      });
    },
  },
  restart: {
    pendingSessions: (): Promise<{ sessionKey: string; state: unknown }[]> =>
      ipcRenderer.invoke(IPC.restart.pendingSessions),
    restart: (sessionKey: string): Promise<void> => ipcRenderer.invoke(IPC.restart.restart, sessionKey),
    restartAllIdle: (): Promise<void> => ipcRenderer.invoke(IPC.restart.restartAllIdle),
    onStateChange: (cb: (sessionKey: string, state: unknown) => void): (() => void) => {
      const listener = (_e: unknown, sessionKey: string, state: unknown) => cb(sessionKey, state);
      ipcRenderer.on("restart:state", listener);
      return () => { ipcRenderer.removeListener("restart:state", listener); };
    },
  },
  /** 运行平台(process.platform 直传):renderer 平台分支用(标题栏自绘按钮等)。 */
  platform: process.platform,
  /** 应用基本信息(name/version/electron/node/chrome/isPackaged)。 */
  app: {
    info: (): Promise<{
      name: string; version: string; electron: string; node: string; chrome: string;
      platform: string; isPackaged: boolean;
    }> => ipcRenderer.invoke(IPC.app.info),
    /** 整 App 重启,退出链路同手动退出(经 before-quit 回收 pi 子进程)。 */
    restart: (): Promise<void> => ipcRenderer.invoke(IPC.app.restart),
  },
  /** 窗口控制(win/linux 自绘标题栏按钮用;mac 红绿灯原生,不消费)。 */
  window: {
    minimize: (): Promise<void> => ipcRenderer.invoke(IPC.window.minimize),
    toggleMaximize: (): Promise<void> => ipcRenderer.invoke(IPC.window.toggleMaximize),
    close: (): Promise<void> => ipcRenderer.invoke(IPC.window.close),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke(IPC.window.isMaximized),
    onMaximizedChanged: (cb: (maximized: boolean) => void): (() => void) => {
      const listener = (_e: unknown, maximized: boolean) => cb(maximized);
      ipcRenderer.on(IPC.window.maximizedChanged, listener);
      return () => { ipcRenderer.removeListener(IPC.window.maximizedChanged, listener); };
    },
  },
};

contextBridge.exposeInMainWorld("pi", pi);

export {};
