import type {
  PluginConfigApi,
  PluginContext,
  LayoutApi,
} from "@my-harness-desktop/contract";
import type {
  SessionsApi, MessagingApi, ModelApi, SessionTreeApi, SessionMaintenanceApi, QueueModeApi,
  FsApi, GitReadApi, GitWriteApi, LlmOneshotApi, DialogApi, BusApi,
  I18nApi,
  SessionInfo, SessionDetail, ImageInput, BashResult,
  ModelInfo, SessionStats, NeutralMessage, KnownToolInfo,
} from "@my-harness-desktop/contract";
import type { SessionEvent, SyncSnapshot } from "@my-harness-desktop/contract";
import type { KernelEvent, QuestionRequestEvent, QuestionAnswer } from "@my-harness-desktop/contract";
import type { LineageTree, Anchor } from "@my-harness-desktop/contract";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { usePluginId } from "./plugin-id-context";
import { eventBus, type PluginEventsApi } from "./event-bus";
import { useLayoutStore } from "../../../src/api/renderer/stores/layout-store";

export function usePluginContext(): PluginContext {
  const pluginId = usePluginId();
  const { t, i18n } = useTranslation();

  const config: PluginConfigApi = useMemo(() => ({
    get: <T,>(key: string) => window.pi.config.get<T>(pluginId, key),
    set: <T,>(key: string, value: T, opts?: { scope?: "project" | "global" }) => window.pi.config.set(pluginId, key, value, opts),
    all: () => window.pi.config.all(pluginId),
    getScope: (scope: "project" | "global") => window.pi.config.getScope(pluginId, scope),
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
    onQuestion: (cb) => window.pi.sessions.onQuestion((req) => cb(req as QuestionRequestEvent)),
    answerQuestion: (requestId, answers) => window.pi.sessions.answerQuestion(requestId, answers as QuestionAnswer[]),
    listTools: () => window.pi.sessions.listTools() as Promise<KnownToolInfo[] | null>,
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
    projectStats: (cwd) => window.pi.sessions.projectStats(cwd),
    getTree: (sessionId) => window.pi.sessions.getTree(sessionId) as Promise<LineageTree>,
    bookmark: (lineageId, boundary) => window.pi.sessions.bookmark(lineageId, boundary) as Promise<Anchor>,
    resume: (anchor) => window.pi.sessions.resume(anchor) as Promise<string>,
    deleteBookmark: (anchor) => window.pi.sessions.deleteBookmark(anchor) as Promise<void>,
    switchKernel: (target) => window.pi.sessions.switchKernel(target),
  }), []);

  const messaging: MessagingApi = useMemo(() => ({
    prompt: (text, images?: ImageInput[]) => window.pi.sessions.prompt(text, images),
    abort: () => window.pi.sessions.abort(),
    steer: (text, images?: ImageInput[]) => window.pi.sessions.steer(text, images),
    followUp: (text, images?: ImageInput[]) => window.pi.sessions.followUp(text, images),
    abortRetry: () => window.pi.sessions.abortRetry(),
    continue: () => window.pi.sessions.continue(),
    getStats: () => window.pi.sessions.getStats() as Promise<SessionStats>,
  }), []);

  const models: ModelApi = useMemo(() => ({
    getModels: () => window.pi.sessions.getModels() as Promise<ModelInfo[]>,
    setModel: (provider, modelId, kernel) => window.pi.sessions.setModel(provider, modelId, kernel),
    cycleModel: () => window.pi.sessions.cycleModel(),
    test: (cwd, provider, modelId) => window.pi.sessions.testModel(cwd, provider, modelId),
    getThinkingLevels: () => window.pi.sessions.getThinkingLevels(),
    setThinkingLevel: (level) => window.pi.sessions.setThinkingLevel(level),
    cycleThinkingLevel: () => window.pi.sessions.cycleThinkingLevel(),
    getStats: () => window.pi.sessions.getStats() as Promise<SessionStats>,
  }), []);

  const tree: SessionTreeApi = useMemo(() => ({
    fork: (parentLineageId, boundary) => window.pi.sessions.fork(parentLineageId, boundary) as Promise<string>,
    forkFromSession: (cwd, srcPath, entryId) => window.pi.sessions.forkFromSession(cwd, srcPath, entryId),
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

  const fs: FsApi = useMemo(() => ({
    listDir: (cwd) => window.pi.fs.listDir(pluginId, cwd),
    removePath: (path) => window.pi.fs.removePath(pluginId, path),
    readDirTree: (cwd, opts) => window.pi.fs.readDirTree(pluginId, cwd, opts),
    readFile: (path) => window.pi.fs.readFile(pluginId, path),
    readFileBase64: (path) => window.pi.fs.readFileBase64(pluginId, path),
    createFile: (path) => window.pi.fs.createFile(pluginId, path),
    createDir: (path) => window.pi.fs.createDir(pluginId, path),
    renamePath: (from, to) => window.pi.fs.renamePath(pluginId, from, to),
    copyPath: (from, to) => window.pi.fs.copyPath(pluginId, from, to),
  }), [pluginId]);

  const git: GitReadApi = useMemo(() => ({
    status: (cwd) => window.pi.git.status(pluginId, cwd),
    fileDiff: (cwd, path) => window.pi.git.fileDiff(pluginId, cwd, path),
    fileContent: (cwd, path) => window.pi.git.fileContent(pluginId, cwd, path),
    log: (cwd, limit) => window.pi.git.log(pluginId, cwd, limit),
  }), [pluginId]);

  const gitWrite: GitWriteApi = useMemo(() => ({
    commit: (cwd, message, files) => window.pi.gitWrite.commit(pluginId, cwd, message, files),
    push: (cwd) => window.pi.gitWrite.push(pluginId, cwd),
  }), [pluginId]);

  const llm: LlmOneshotApi = useMemo(() => ({
    oneshot: (prompt) => window.pi.llm.oneshot(pluginId, prompt),
  }), [pluginId]);

  const bus: BusApi = useMemo(() => ({
    status: () => window.pi.bus.status(pluginId),
    send: (to, kind, payload, replyTo) => window.pi.bus.send(pluginId, to, kind, payload, replyTo),
    sessionCreate: (opts) => window.pi.bus.sessionCreate(pluginId, opts),
    sessionAbort: (session) => window.pi.bus.sessionAbort(pluginId, session),
    channelMember: (channel, action, member) => window.pi.bus.channelMember(pluginId, channel, action, member),
    tapStart: (opts) => window.pi.bus.tapStart(pluginId, opts),
    tapStop: (tapId) => window.pi.bus.tapStop(pluginId, tapId),
    onMessage: (cb) => window.pi.bus.onMessage(cb),
  }), [pluginId]);

  const dialog: DialogApi = useMemo(() => ({
    openDirectory: () => window.pi.dialog.openDirectory(),
    openImages: () => window.pi.dialog.openImages(),
    openTextFile: (opts) => window.pi.dialog.openTextFile(opts),
    saveTextFile: (opts) => window.pi.dialog.saveTextFile(opts),
    writeImages: (dir, images) => window.pi.dialog.writeImages(dir, images),
    saveZip: (opts) => window.pi.dialog.saveZip(opts),
    openZip: (opts) => window.pi.dialog.openZip(opts),
    openFile: (path) => window.pi.openFile(path),
  }), []);

  const events: PluginEventsApi = useMemo(() => ({
    emit: (channel, payload) => eventBus.emit(pluginId, channel, payload),
    on: (channel, handler, opts) => eventBus.on(channel, handler, opts),
    invoke: (channel, payload) => eventBus.invoke(pluginId, channel, payload),
  }), [pluginId]);

  const layout: LayoutApi = useMemo(() => ({
    openView: (req) => { useLayoutStore.getState().openView(pluginId, req); },
    closeView: (viewId) => { useLayoutStore.getState().closeView(viewId); },
    activateView: (viewId) => { useLayoutStore.getState().activateView(viewId); },
    moveView: (viewId, targetGroupId, index) => { useLayoutStore.getState().moveView(viewId, targetGroupId, index); },
    setLayout: (tree) => { useLayoutStore.getState().setLayout(tree); },
    getLayout: () => useLayoutStore.getState().getLayout(),
  }), [pluginId]);

  return useMemo(() => ({
    config, sessions, messaging, models, tree, maintenance, queue,
    i18n: i18nApi, fs, git, gitWrite, llm, dialog, events, bus, layout,
    prefs: window.pi.prefs,
    themes: window.pi.themes,
    fonts: window.pi.fonts,
    kernels: window.pi.kernels,
    dshModels: window.pi.dshModels,
    kernelModels: window.pi.kernelModels,
    kernelConfig: window.pi.kernelConfig,
    dshSettings: window.pi.dshSettings,
    modelsConfig: window.pi.models,
    piSettings: window.pi.piSettings,
    configFile: { get: window.pi.configFile.get, append: window.pi.configFile.append, readBinary: window.pi.configFile.readBinary, writeBinary: window.pi.configFile.writeBinary },
    plugins: window.pi.plugins,
    kernelExtensions: window.pi.kernelExtensions,
    skills: window.pi.skills,
    restart: window.pi.restart,
    openFile: window.pi.openFile,
    appInfo: { get: () => window.pi.app.info(), restart: () => window.pi.app.restart() },
    notify: { show: (opts) => window.pi.notify.show(opts) },
    window: { isFocused: () => window.pi.window.isFocused() },
  }), [config, sessions, messaging, models, tree, maintenance, queue, i18nApi, fs, git, gitWrite, llm, dialog, events, bus, layout]);
}
