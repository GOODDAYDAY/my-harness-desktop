import type {
  PluginConfigApi,
  PluginContext,
} from "@pi-desktop/core";
import type {
  SessionsApi, MessagingApi, ModelApi, SessionTreeApi, SessionMaintenanceApi, QueueModeApi,
  FsReadApi, GitReadApi, DialogApi,
  I18nApi,
  SessionInfo, SessionDetail, ImageInput, BashResult,
  ModelInfo, SessionStats, NeutralMessage,
} from "@pi-desktop/core";
import type { SessionEvent, SyncSnapshot } from "@pi-desktop/core";
import type { KernelEvent } from "@pi-desktop/core";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { usePluginId } from "./plugin-id-context";
import { eventBus, type PluginEventsApi } from "./event-bus";

export function usePluginContext(): PluginContext {
  const pluginId = usePluginId();
  const { t, i18n } = useTranslation();

  const config: PluginConfigApi = useMemo(() => ({
    get: <T,>(key: string) => window.pi.config.get<T>(pluginId, key),
    set: <T,>(key: string, value: T) => window.pi.config.set(pluginId, key, value),
    all: () => window.pi.config.all(pluginId),
  }), [pluginId]);

  const i18nApi: I18nApi = useMemo(() => ({
    t: (key, vars) => t(key, vars as Record<string, unknown>) as string,
    locale: i18n.language,
    list: () => window.pi.i18n.list(),
  }), [t, i18n.language]);

  const sessions: SessionsApi = useMemo(() => ({
    getSnapshot: () => window.pi.sessions.getSnapshot() as Promise<SyncSnapshot>,
    sync: () => window.pi.sessions.sync() as Promise<SyncSnapshot>,
    onEvent: (cb) => window.pi.sessions.onEvent((e) => cb(e as SessionEvent)),
    onKernelEvent: (cb) => window.pi.sessions.onKernelEvent((e) => cb(e as KernelEvent)),
    onExtensionUI: (cb) => window.pi.sessions.onExtensionUI((req) => cb(req as { requestId: string; method: string; [k: string]: unknown })),
    replyExtensionUI: (requestId, response) => window.pi.sessions.replyExtensionUI(requestId, response),
    onSnapshot: (cb) => window.pi.sessions.onSnapshot((s) => cb(s as SyncSnapshot)),
    list: (cwd) => window.pi.sessions.list(cwd) as Promise<SessionInfo[]>,
    openSession: (sessionPath) =>
      // domain 契约已对齐真实返回值(SessionDetail|null),不再在边界处裁剪丢 info
      window.pi.sessions.openSession(sessionPath) as Promise<SessionDetail | null>,
    setContext: (cwd, sessionPath) => window.pi.sessions.setContext(cwd, sessionPath),
    renameSession: (sessionPath, name) =>
      window.pi.sessions.renameSession(sessionPath, name).then(() => undefined),
    updateHeader: (sessionPath, patch) =>
      window.pi.sessions.updateHeader(sessionPath, patch).then(() => undefined),
    deleteSessions: (paths) =>
      window.pi.sessions.deleteSessions(paths).then(() => undefined),
    start: (cwd, sessionPath) => window.pi.sessions.start(cwd, sessionPath).then(() => undefined),
    stop: (sessionPath?) => window.pi.sessions.stop(sessionPath).then(() => undefined),
    copySession: (srcPath, targetPath) => window.pi.sessions.copySession(srcPath, targetPath),
    readToolConfig: (sessionPath) => window.pi.sessions.readToolConfig(sessionPath),
    recentSettings: (cwd) => window.pi.sessions.recentSettings(cwd),
  }), []);

  const messaging: MessagingApi = useMemo(() => ({
    prompt: (text, images?: ImageInput[]) => window.pi.sessions.prompt(text, images),
    abort: () => window.pi.sessions.abort(),
    steer: (text, images?: ImageInput[]) => window.pi.sessions.steer(text, images),
    followUp: (text, images?: ImageInput[]) => window.pi.sessions.followUp(text, images),
    abortRetry: () => window.pi.sessions.abortRetry(),
    getStats: () => window.pi.sessions.getStats() as Promise<SessionStats>,
  }), []);

  const models: ModelApi = useMemo(() => ({
    getModels: () => window.pi.sessions.getModels() as Promise<ModelInfo[]>,
    setModel: (provider, modelId) => window.pi.sessions.setModel(provider, modelId),
    cycleModel: () => window.pi.sessions.cycleModel(),
    test: (cwd, provider, modelId) => window.pi.sessions.testModel(cwd, provider, modelId),
    getThinkingLevels: () => window.pi.sessions.getThinkingLevels(),
    setThinkingLevel: (level) => window.pi.sessions.setThinkingLevel(level),
    cycleThinkingLevel: () => window.pi.sessions.cycleThinkingLevel(),
    getStats: () => window.pi.sessions.getStats() as Promise<SessionStats>,
  }), []);

  const tree: SessionTreeApi = useMemo(() => ({
    fork: (entryId) => window.pi.sessions.fork(entryId),
    clone: () => window.pi.sessions.clone(),
    getForkMessages: (entryId) => window.pi.sessions.getForkMessages(entryId) as Promise<NeutralMessage[]>,
    getStats: () => window.pi.sessions.getStats() as Promise<SessionStats>,
  }), []);

  const maintenance: SessionMaintenanceApi = useMemo(() => ({
    compact: (customInstructions?) => window.pi.sessions.compact(customInstructions),
    setAutoCompaction: (enabled) => window.pi.sessions.setAutoCompaction(enabled),
    setAutoRetry: (enabled) => window.pi.sessions.setAutoRetry(enabled),
    exportHtml: (outputPath?) => window.pi.sessions.exportHtml(outputPath),
    getLastAssistantText: () => window.pi.sessions.getLastAssistantText(),
    getStats: () => window.pi.sessions.getStats() as Promise<SessionStats>,
  }), []);

  const queue: QueueModeApi = useMemo(() => ({
    setSteeringMode: (mode) => window.pi.sessions.setSteeringMode(mode),
    setFollowUpMode: (mode) => window.pi.sessions.setFollowUpMode(mode),
    getStats: () => window.pi.sessions.getStats() as Promise<SessionStats>,
  }), []);

  const fs: FsReadApi = useMemo(() => ({
    listDir: (cwd) => window.pi.fs.listDir(pluginId, cwd),
    removePath: (path) => window.pi.fs.removePath(pluginId, path),
    readDirTree: (cwd, opts) => window.pi.fs.readDirTree(pluginId, cwd, opts),
  }), [pluginId]);

  const git: GitReadApi = useMemo(() => ({
    status: (cwd) => window.pi.git.status(pluginId, cwd),
    fileDiff: (cwd, path) => window.pi.git.fileDiff(pluginId, cwd, path),
    fileContent: (cwd, path) => window.pi.git.fileContent(pluginId, cwd, path),
  }), [pluginId]);

  const dialog: DialogApi = useMemo(() => ({
    openDirectory: () => window.pi.dialog.openDirectory(),
    openImages: () => window.pi.dialog.openImages(),
    openFile: (path) => window.pi.openFile(path),
  }), []);

  const events: PluginEventsApi = useMemo(() => ({
    emit: (channel, payload) => eventBus.emit(pluginId, channel, payload),
    on: (channel, handler, opts) => eventBus.on(channel, handler, opts),
    invoke: (channel, payload) => eventBus.invoke(pluginId, channel, payload),
  }), [pluginId]);

  return useMemo(() => ({
    config, sessions, messaging, models, tree, maintenance, queue,
    i18n: i18nApi, fs, git, dialog, events,
    prefs: window.pi.prefs,
    themes: window.pi.themes,
    kernel: window.pi.kernel,
    modelsConfig: window.pi.models,
    piSettings: window.pi.piSettings,
    configFile: window.pi.configFile,
    plugins: window.pi.plugins,
    extension: window.pi.extension,
    skills: window.pi.skills,
    restart: window.pi.restart,
    openFile: window.pi.openFile,
  }), [config, sessions, messaging, models, tree, maintenance, queue, i18nApi, fs, git, dialog, events]);
}
