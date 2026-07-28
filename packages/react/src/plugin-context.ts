// usePluginContext —— 按 pluginId 绑定的 PluginContext(domain/context 的 renderer 形态)。
//
// 插件不直接拼 pluginId 参数调 window.pi(易写错、无权限语义),经此 hook 拿绑定后的
// 上下文:config/sessions/fs/git/dialog 都已按 pluginId 预绑定。
// permissions 强制在 main IPC 边界(未声明抛错),本层只是绑定便利 + 类型收口。
import type {
  PluginConfigApi,
  PluginContext,
} from "@pi-desktop/core";
import type {
  SessionsApi, MessagingApi, ModelApi, SessionTreeApi, SessionMaintenanceApi, QueueModeApi,
  FsReadApi, GitReadApi, DialogApi,
  I18nApi,
  SessionInfo, ImageInput, BashResult,
  ModelInfo, SessionStats, NeutralMessage,
} from "@pi-desktop/core";
import type { SessionEvent, SyncSnapshot } from "@pi-desktop/core";
import { useTranslation } from "react-i18next";

/** 绑定 pluginId 的 renderer PluginContext。每个槽组件内调用一次即可(无状态,纯绑定)。
 *  内部调 useTranslation(react-i18next)拿 t/locale,故本函数须在组件 render 体内调。 */
export function usePluginContext(pluginId: string): PluginContext {
  const { t, i18n } = useTranslation();

  const config: PluginConfigApi = {
    get: <T,>(key: string) => window.pi.config.get<T>(pluginId, key),
    set: <T,>(key: string, value: T) => window.pi.config.set(pluginId, key, value),
    all: () => window.pi.config.all(pluginId),
  };

  const i18nApi: I18nApi = {
    t: (key, vars) => t(key, vars as Record<string, unknown>) as string,
    locale: i18n.language,
  };

  const sessions: SessionsApi = {
    getSnapshot: () => window.pi.sessions.getSnapshot() as Promise<SyncSnapshot>,
    sync: () => window.pi.sessions.sync() as Promise<SyncSnapshot>,
    onEvent: (cb) => window.pi.sessions.onEvent((e) => cb(e as SessionEvent)),
    onSnapshot: (cb) => window.pi.sessions.onSnapshot((s) => cb(s as SyncSnapshot)),
    list: (cwd) => window.pi.sessions.list(cwd) as Promise<SessionInfo[]>,
    openSession: (sessionPath) =>
      window.pi.sessions.openSession(sessionPath).then((detail) => {
        const d = detail as { messages?: unknown[] } | null;
        return (d?.messages ?? []) as never;
      }),
    setContext: (cwd, sessionPath) => window.pi.sessions.setContext(cwd, sessionPath),
    renameSession: (sessionPath, name) =>
      window.pi.sessions.renameSession(sessionPath, name).then(() => undefined),
    updateHeader: (sessionPath, patch) =>
      window.pi.sessions.updateHeader(sessionPath, patch).then(() => undefined),
    start: (cwd, sessionPath) => window.pi.sessions.start(cwd, sessionPath).then(() => undefined),
    stop: (sessionPath?) => window.pi.sessions.stop(sessionPath).then(() => undefined),
    copySession: (srcPath, targetPath) => window.pi.sessions.copySession(srcPath, targetPath),
  };

  const messaging: MessagingApi = {
    prompt: (text, images?: ImageInput[]) => window.pi.sessions.prompt(text, images),
    abort: () => window.pi.sessions.abort(),
    steer: (text, images?: ImageInput[]) => window.pi.sessions.steer(text, images),
    followUp: (text, images?: ImageInput[]) => window.pi.sessions.followUp(text, images),
    abortRetry: () => window.pi.sessions.abortRetry(),
    getStats: () => window.pi.sessions.getStats() as Promise<SessionStats>,
  };

  const models: ModelApi = {
    getModels: () => window.pi.sessions.getModels() as Promise<ModelInfo[]>,
    setModel: (provider, modelId) => window.pi.sessions.setModel(provider, modelId),
    cycleModel: () => window.pi.sessions.cycleModel(),
    getThinkingLevels: () => window.pi.sessions.getThinkingLevels(),
    setThinkingLevel: (level) => window.pi.sessions.setThinkingLevel(level),
    cycleThinkingLevel: () => window.pi.sessions.cycleThinkingLevel(),
    getStats: () => window.pi.sessions.getStats() as Promise<SessionStats>,
  };

  const tree: SessionTreeApi = {
    fork: (entryId) => window.pi.sessions.fork(entryId),
    clone: () => window.pi.sessions.clone(),
    getForkMessages: (entryId) => window.pi.sessions.getForkMessages(entryId) as Promise<NeutralMessage[]>,
    getStats: () => window.pi.sessions.getStats() as Promise<SessionStats>,
  };

  const maintenance: SessionMaintenanceApi = {
    compact: (customInstructions?) => window.pi.sessions.compact(customInstructions),
    setAutoCompaction: (enabled) => window.pi.sessions.setAutoCompaction(enabled),
    setAutoRetry: (enabled) => window.pi.sessions.setAutoRetry(enabled),
    exportHtml: (outputPath?) => window.pi.sessions.exportHtml(outputPath),
    getLastAssistantText: () => window.pi.sessions.getLastAssistantText(),
    getStats: () => window.pi.sessions.getStats() as Promise<SessionStats>,
  };

  const queue: QueueModeApi = {
    setSteeringMode: (mode) => window.pi.sessions.setSteeringMode(mode),
    setFollowUpMode: (mode) => window.pi.sessions.setFollowUpMode(mode),
    getStats: () => window.pi.sessions.getStats() as Promise<SessionStats>,
  };

  const fs: FsReadApi = {
    listDir: (cwd) => window.pi.fs.listDir(pluginId, cwd),
    removePath: (path) => window.pi.fs.removePath(pluginId, path),
  };

  const git: GitReadApi = {
    status: (cwd) => window.pi.git.status(pluginId, cwd),
    fileDiff: (cwd, path) => window.pi.git.fileDiff(pluginId, cwd, path),
    fileContent: (cwd, path) => window.pi.git.fileContent(pluginId, cwd, path),
  };

  const dialog: DialogApi = {
    openDirectory: () => window.pi.dialog.openDirectory(),
    openImages: () => window.pi.dialog.openImages(),
    openFile: (path) => window.pi.openFile(path),
  };

  return { config, sessions, messaging, models, tree, maintenance, queue, i18n: i18nApi, fs, git, dialog };
}
