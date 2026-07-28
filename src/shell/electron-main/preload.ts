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

/** 暴露到 renderer 的 pi 全局对象(window.pi)。 */
const pi = {
  /** 插件配置:读写 ~/.pi-desktop/plugins-data/{id}/config.json。renderer 不直接写,经此 → main → ConfigStore。 */
  config: {
    get: <T>(pluginId: string, key: string): Promise<T | undefined> =>
      ipcRenderer.invoke("config:get", pluginId, key),
    set: (pluginId: string, key: string, value: unknown): Promise<void> =>
      ipcRenderer.invoke("config:set", pluginId, key, value),
    all: (pluginId: string): Promise<Record<string, unknown>> =>
      ipcRenderer.invoke("config:all", pluginId),
  },
  /** 桌面偏好(electron-store):currentThemeId/fontScale/fontMono/fontSans 等。 */
  prefs: {
    get: <T>(key: string): Promise<T> => ipcRenderer.invoke("prefs:get", key),
    set: (key: string, value: unknown): Promise<void> =>
      ipcRenderer.invoke("prefs:set", key, value),
  },
  /** 主题:列表 + 合并(经 application/theme/merge)。 */
  themes: {
    list: (): Promise<{ id: string; name: string }[]> =>
      ipcRenderer.invoke("themes:list"),
    build: (
      themeId: string,
      fontScale: number,
      fontMono: string,
      fontSans: string,
    ): Promise<Record<string, string>> =>
      ipcRenderer.invoke("themes:build", themeId, fontScale, fontMono, fontSans),
  },
  /** 设置页:settings 槽贡献项列表。 */
  settings: {
    list: (): Promise<
      { id: string; title: string; component: string; pluginId: string }[]
    > => ipcRenderer.invoke("settings:list"),
  },
  /** 槽位清单:sidePanel(右面板 Tab)/ sidebar(左栏分组)。 */
  slots: {
    sidePanel: (): Promise<{ id: string; label: string; icon: string; component: string; pluginId: string }[]> =>
      ipcRenderer.invoke("slots:sidePanel"),
    sidebar: (): Promise<{ id: string; title: string; component: string; pluginId: string }[]> =>
      ipcRenderer.invoke("slots:sidebar"),
  },
  /** pi 内核管理:版本状态 / registry 版本清单 / 安装指定版本。 */
  kernel: {
    status: (): Promise<{
      currentVersion: string | null;
      available: boolean;
      error: string | null;
    }> => ipcRenderer.invoke("kernel:status"),
    listVersions: (forceRefresh = false): Promise<{
      versions: string[];
      latest: string | null;
    }> => ipcRenderer.invoke("kernel:listVersions", forceRefresh),
    /** 安装/切换 pi 版本到 ~/.pi-desktop/pi(覆盖式:装新=更新、装旧=降级)。
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
          console.error("[pi-desktop] kernel install onDone threw", e);
        }
        resolveFn?.(r);
        setTimeout(() => cleanup(), 0);
      };
      ipcRenderer.on("kernel:install-done", doneListener);
      const invokeP = ipcRenderer.invoke("kernel:install", version) as Promise<{ ok: boolean; error: string | null }>;
      // invoke reject/异常时也清(兜底,正常路径 onDone 触发 cleanup)
      invokeP.catch(() => cleanup());
      return new Promise((resolve) => {
        resolveFn = resolve;
        // 兜底:onDone 5 分钟未到(安装卡死)也 resolve,避免 Promise 永悬
        setTimeout(() => { if (!cleaned) { cleanup(); resolveFn?.({ ok: false, error: "安装超时" }); } }, 300000);
      });
    },
  },
  /** pi 底座 settings(读写 ~/.pi/agent/settings.json,底座标准契约)。 */
  piSettings: {
    get: (): Promise<Record<string, unknown>> => ipcRenderer.invoke("pi-settings:get"),
    set: (patch: Record<string, unknown>): Promise<Record<string, unknown>> =>
      ipcRenderer.invoke("pi-settings:set", patch),
    /** 解析底座 .d.ts 拿当前版本所有字段(未知字段兜底用) */
    schema: (): Promise<{ key: string; type: string }[]> => ipcRenderer.invoke("pi-settings:schema"),
  },
  /** i18n:语言槽合并后给 renderer init + locale 列表 + 检测(05-plugin-i18n)。 */
  i18n: {
    resources: (): Promise<{
      resources: Record<string, Record<string, Record<string, string>>>;
      ns: string[];
      supportedLngs: string[];
    }> => ipcRenderer.invoke("i18n:resources"),
    list: (): Promise<{ id: string; name: string }[]> => ipcRenderer.invoke("i18n:list"),
    detect: (navigatorLanguage: string): Promise<string> => ipcRenderer.invoke("i18n:detect", navigatorLanguage),
  },
  /** pi 底座模型配置(读写 ~/.pi/agent/models.json)。 */
  models: {
    get: <T>(): Promise<T> => ipcRenderer.invoke("models:get"),
    set: <T>(config: T): Promise<T> => ipcRenderer.invoke("models:set", config),
  },
  /** 用系统默认编辑器打开文件(框架"打开配置"按钮用)。 */
  openFile: (path: string): Promise<void> => ipcRenderer.invoke("open-file", path),
  /** 通用 JSON 配置文件读写(框架级配置管理)。 */
  configFile: {
    get: (path: string): Promise<Record<string, unknown>> => ipcRenderer.invoke("config-file:get", path),
    set: (path: string, data: Record<string, unknown>, mergeMode: "deep" | "replace"): Promise<Record<string, unknown>> =>
      ipcRenderer.invoke("config-file:set", path, data, mergeMode),
  },
  /** 会话能力(核心):生命周期 + 消息发送 + 模型 + 树 + 维护 + 队列 + bash。 */
  sessions: {
    // SessionsApi(生命周期)
    start: (cwd: string, sessionPath?: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("session:start", cwd, sessionPath),
    stop: (sessionPath?: string | null): Promise<{ ok: boolean }> => ipcRenderer.invoke("session:stop", sessionPath),
    setContext: (cwd: string, sessionPath: string | null): Promise<void> =>
      ipcRenderer.invoke("session:setContext", cwd, sessionPath),
    getSnapshot: (): Promise<unknown> => ipcRenderer.invoke("session:getSnapshot"),
    sync: (): Promise<unknown> => ipcRenderer.invoke("session:sync"),
    openSession: (sessionPath: string): Promise<unknown> =>
      ipcRenderer.invoke("session:open", sessionPath),
    renameSession: (sessionPath: string, name: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("session:rename", sessionPath, name),
    updateHeader: (
      sessionPath: string,
      patch: { name?: string; pinned?: boolean; archived?: boolean },
    ): Promise<{ ok: boolean }> => ipcRenderer.invoke("session:updateHeader", sessionPath, patch),
    list: (cwd: string): Promise<unknown[]> => ipcRenderer.invoke("sessions:list", cwd),
    recentSettings: (cwd: string): Promise<{ provider?: string; modelId?: string; thinkingLevel?: string }> => ipcRenderer.invoke("sessions:recentSettings", cwd),
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
      ipcRenderer.invoke("session:replyExtensionUI", requestId, response),
    onSnapshot: (cb: (snapshot: unknown) => void): (() => void) => {
      const listener = (_e: unknown, snapshot: unknown) => cb(snapshot);
      ipcRenderer.on("session:snapshot", listener);
      return () => { ipcRenderer.removeListener("session:snapshot", listener); };
    },
    // MessagingApi
    prompt: (text: string, images?: { data: string; mimeType: string; name?: string }[]): Promise<void> =>
      ipcRenderer.invoke("session:prompt", text, images),
    abort: (): Promise<void> => ipcRenderer.invoke("session:abort"),
    steer: (text: string, images?: { data: string; mimeType: string; name?: string }[]): Promise<void> =>
      ipcRenderer.invoke("session:steer", text, images),
    followUp: (text: string, images?: { data: string; mimeType: string; name?: string }[]): Promise<void> =>
      ipcRenderer.invoke("session:followUp", text, images),
    abortRetry: (): Promise<void> => ipcRenderer.invoke("session:abortRetry"),
    // ModelApi
    getModels: (): Promise<unknown[]> => ipcRenderer.invoke("session:getModels"),
    setModel: (provider: string, modelId: string): Promise<void> =>
      ipcRenderer.invoke("session:setModel", provider, modelId),
    cycleModel: (): Promise<void> => ipcRenderer.invoke("session:cycleModel"),
    getThinkingLevels: (): Promise<string[]> => ipcRenderer.invoke("session:getThinkingLevels"),
    setThinkingLevel: (level: string): Promise<void> =>
      ipcRenderer.invoke("session:setThinkingLevel", level),
    cycleThinkingLevel: (): Promise<void> => ipcRenderer.invoke("session:cycleThinkingLevel"),
    // SessionTreeApi
    fork: (entryId: string): Promise<void> => ipcRenderer.invoke("session:fork", entryId),
    clone: (): Promise<void> => ipcRenderer.invoke("session:clone"),
    getForkMessages: (entryId: string): Promise<unknown[]> => ipcRenderer.invoke("session:getForkMessages", entryId),
    // SessionMaintenanceApi
    compact: (customInstructions?: string): Promise<void> => ipcRenderer.invoke("session:compact", customInstructions),
    setAutoCompaction: (enabled: boolean): Promise<void> => ipcRenderer.invoke("session:setAutoCompaction", enabled),
    setAutoRetry: (enabled: boolean): Promise<void> => ipcRenderer.invoke("session:setAutoRetry", enabled),
    exportHtml: (outputPath?: string): Promise<string> => ipcRenderer.invoke("session:exportHtml", outputPath),
    getLastAssistantText: (): Promise<string> => ipcRenderer.invoke("session:getLastAssistantText"),
    getStats: (): Promise<unknown> => ipcRenderer.invoke("session:getStats"),
    // QueueModeApi
    setSteeringMode: (mode: "all" | "one-at-a-time"): Promise<void> => ipcRenderer.invoke("session:setSteeringMode", mode),
    setFollowUpMode: (mode: "all" | "one-at-a-time"): Promise<void> => ipcRenderer.invoke("session:setFollowUpMode", mode),
    // BashApi (需声明 rpc:bash 权限)
    runBash: (command: string, excludeFromContext?: boolean): Promise<{ stdout: string; stderr: string; exitCode: number }> =>
      ipcRenderer.invoke("session:runBash", command, excludeFromContext),
    abortBash: (): Promise<void> => ipcRenderer.invoke("session:abortBash"),
    // SessionSnapshotApi
    copySession: (srcPath: string, targetPath: string): Promise<void> =>
      ipcRenderer.invoke("session:copySession", srcPath, targetPath),
  },
  /** fs:project 能力(声明 permissions 后可用;pluginId 首参,main 门控)。 */
  fs: {
    listDir: (pluginId: string, cwd: string): Promise<{ name: string; isDir: boolean }[]> =>
      ipcRenderer.invoke("fs:listDir", pluginId, cwd),
    removePath: (pluginId: string, path: string): Promise<void> =>
      ipcRenderer.invoke("fs:removePath", pluginId, path),
  },
  /** git:read 能力(声明 permissions 后可用;pluginId 首参,main 门控)。 */
  git: {
    status: (pluginId: string, cwd: string): Promise<{ isRepo: boolean; files: { path: string; status: string }[] }> =>
      ipcRenderer.invoke("git:status", pluginId, cwd),
    fileDiff: (pluginId: string, cwd: string, path: string): Promise<string> =>
      ipcRenderer.invoke("git:fileDiff", pluginId, cwd, path),
    fileContent: (pluginId: string, cwd: string, path: string): Promise<string> =>
      ipcRenderer.invoke("git:fileContent", pluginId, cwd, path),
  },
  /** 对话框(用户手势驱动)。 */
  dialog: {
    openDirectory: (): Promise<string | null> => ipcRenderer.invoke("dialog:openDirectory"),
    openImages: (): Promise<{ name: string; data: string; mimeType: string }[]> =>
      ipcRenderer.invoke("dialog:openImages"),
  },
  plugins: {
    list: (): Promise<unknown[]> => ipcRenderer.invoke("plugins:list"),
    enable: (pluginId: string): Promise<{ ok: boolean; error: string | null }> =>
      ipcRenderer.invoke("plugins:enable", pluginId),
    disable: (pluginId: string): Promise<{ ok: boolean; error: string | null }> =>
      ipcRenderer.invoke("plugins:disable", pluginId),
    uninstall: (pluginId: string): Promise<{ ok: boolean; error: string | null }> =>
      ipcRenderer.invoke("plugins:uninstall", pluginId),
    reload: (pluginId: string): Promise<{ ok: boolean; error: string | null }> =>
      ipcRenderer.invoke("plugins:reload", pluginId),
    install: (source: { type: "url" | "local"; location: string }): Promise<{ ok: boolean; error: string | null }> =>
      ipcRenderer.invoke("plugins:install", source),
    onUnloaded: (cb: (components: string[]) => void): (() => void) => {
      const listener = (_e: unknown, data: { components: string[] }) => cb(data.components);
      ipcRenderer.on("plugin:unloaded", listener);
      return () => { ipcRenderer.removeListener("plugin:unloaded", listener); };
    },
    onPluginsChanged: (cb: (nonce: number) => void): (() => void) => {
      const listener = (_e: unknown, nonce: number) => cb(nonce);
      ipcRenderer.on("plugins:changed", listener);
      return () => { ipcRenderer.removeListener("plugins:changed", listener); };
    },
  },
};

contextBridge.exposeInMainWorld("pi", pi);

export {};
