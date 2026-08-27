import type {
  PluginConfigApi,
  PluginContext,
  LayoutApi,
} from "@my-harness-desktop/shared";
import type {
  SessionsApi, MessagingApi, ModelApi, SessionTreeApi, PiExtensions,
  FsApi, GitReadApi, GitWriteApi, LlmOneshotApi, DialogApi, BusApi,
  I18nApi,
  SessionInfo, SessionDetail, ImageInput, BashResult,
  ModelInfo, SessionStats, NeutralMessage, KnownToolInfo,
} from "@my-harness-desktop/shared";
import type { SessionEvent, SyncSnapshot } from "@my-harness-desktop/shared";
import type { KernelEvent, QuestionRequestEvent, QuestionAnswer } from "@my-harness-desktop/shared";
import type { LineageTree, BookmarkSnapshot, GoalState } from "@my-harness-desktop/shared";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { usePluginId } from "./plugin-id-context";
import { eventBus, type PluginEventsApi } from "./event-bus";
import { useLayoutStore } from "../../../src/web/stores/layout-store";

export function usePluginContext(): PluginContext {
  const pluginId = usePluginId();
  const { t, i18n } = useTranslation();

  const config: PluginConfigApi = useMemo(() => ({
    get: <T,>(key: string) => window.kernel.config.get<T>(pluginId, key),
    set: <T,>(key: string, value: T, opts?: { scope?: "project" | "global" }) => window.kernel.config.set(pluginId, key, value, opts),
    all: () => window.kernel.config.all(pluginId),
    getScope: (scope: "project" | "global") => window.kernel.config.getScope(pluginId, scope),
  }), [pluginId]);

  const i18nApi: I18nApi = useMemo(() => ({
    t: (key, vars) => t(key, vars as Record<string, unknown>) as string,
    locale: i18n.language,
    list: () => window.kernel.i18n.list(),
  }), [t, i18n.language]);

  const pi: PiExtensions = useMemo(() => ({
    steer: (text, images?: ImageInput[]) => window.kernel.sessions.pi.steer(text, images),
    followUp: (text, images?: ImageInput[]) => window.kernel.sessions.pi.followUp(text, images),
    abortRetry: () => window.kernel.sessions.pi.abortRetry(),
    cycleModel: () => window.kernel.sessions.pi.cycleModel(),
    getThinkingLevels: () => window.kernel.sessions.pi.getThinkingLevels(),
    cycleThinkingLevel: () => window.kernel.sessions.pi.cycleThinkingLevel(),
    clone: () => window.kernel.sessions.pi.clone(),
    forkFromSession: (cwd, srcPath, entryId) => window.kernel.sessions.pi.forkFromSession(cwd, srcPath, entryId),
    getForkMessages: (entryId) => window.kernel.sessions.pi.getForkMessages(entryId) as Promise<NeutralMessage[]>,
    compact: (customInstructions?) => window.kernel.sessions.pi.compact(customInstructions),
    setAutoCompaction: (enabled) => window.kernel.sessions.pi.setAutoCompaction(enabled),
    setAutoRetry: (enabled) => window.kernel.sessions.pi.setAutoRetry(enabled),
    exportHtml: (outputPath?) => window.kernel.sessions.pi.exportHtml(outputPath),
    getLastAssistantText: () => window.kernel.sessions.pi.getLastAssistantText(),
    setSteeringMode: (mode) => window.kernel.sessions.pi.setSteeringMode(mode),
    setFollowUpMode: (mode) => window.kernel.sessions.pi.setFollowUpMode(mode),
  }), []);
  const sessions: SessionsApi = useMemo(() => ({
    getSnapshot: () => window.kernel.sessions.getSnapshot() as Promise<SyncSnapshot>,
    sync: () => window.kernel.sessions.sync() as Promise<SyncSnapshot>,
    onEvent: (cb) => window.kernel.sessions.onEvent((e) => cb(e as SessionEvent)),
    onKernelEvent: (cb) => window.kernel.sessions.onKernelEvent((e) => cb(e as KernelEvent)),
    onQuestion: (cb) => window.kernel.sessions.onQuestion((req) => cb(req as QuestionRequestEvent)),
    answerQuestion: (requestId, answers) => window.kernel.sessions.answerQuestion(requestId, answers as QuestionAnswer[]),
    listTools: () => window.kernel.sessions.listTools() as Promise<KnownToolInfo[] | null>,
    onSnapshot: (cb) => window.kernel.sessions.onSnapshot((s) => cb(s as SyncSnapshot)),
    list: (cwd) => window.kernel.sessions.list(cwd) as Promise<SessionInfo[]>,
    openSession: (sessionPath) =>
      // domain 契约已对齐真实返回值(SessionDetail|null),不再在边界处裁剪丢 info
      window.kernel.sessions.openSession(sessionPath) as Promise<SessionDetail | null>,
    setContext: (cwd, sessionPath) => window.kernel.sessions.setContext(cwd, sessionPath),
    renameSession: (sessionPath, name) =>
      window.kernel.sessions.renameSession(sessionPath, name).then(() => undefined),
    updateHeader: (sessionPath, patch) =>
      window.kernel.sessions.updateHeader(sessionPath, patch).then(() => undefined),
    deleteSessions: (paths) =>
      window.kernel.sessions.deleteSessions(paths).then(() => undefined),
    start: (cwd, sessionPath) => window.kernel.sessions.start(cwd, sessionPath).then(() => undefined),
    stop: (sessionPath?) => window.kernel.sessions.stop(sessionPath).then(() => undefined),
    copySession: (srcPath, targetPath) => window.kernel.sessions.copySession(srcPath, targetPath),
    readToolConfig: (sessionPath) => window.kernel.sessions.readToolConfig(sessionPath),
    projectStats: (cwd) => window.kernel.sessions.projectStats(cwd),
    getTree: (sessionId) => window.kernel.sessions.getTree(sessionId) as Promise<LineageTree>,
    bookmark: (sessionPath, entryId, id, label, preview) =>
      window.kernel.sessions.bookmark(sessionPath, entryId, id, label, preview) as Promise<BookmarkSnapshot>,
    resume: (snapshotId) => window.kernel.sessions.resume(snapshotId) as Promise<string>,
    deleteBookmark: (snapshotId) => window.kernel.sessions.deleteBookmark(snapshotId) as Promise<void>,
    switchKernel: (target) => window.kernel.sessions.switchKernel(target),
    goal: {
      get: () => window.kernel.sessions.goal.get() as Promise<GoalState | null>,
      pause: () => window.kernel.sessions.goal.pause(),
      resume: () => window.kernel.sessions.goal.resume(),
      edit: (objective) => window.kernel.sessions.goal.edit(objective),
      clear: () => window.kernel.sessions.goal.clear(),
      onChange: (cb) => window.kernel.sessions.goal.onChange((s) => cb(s as GoalState | null)),
    },
    pi,
  }), []);

  const messaging: MessagingApi = useMemo(() => ({
    prompt: (text, images?: ImageInput[], display?, prefs?) => window.kernel.sessions.prompt(text, images, display, prefs),
    abort: () => window.kernel.sessions.abort(),
    continue: () => window.kernel.sessions.continue(),
    getStats: () => window.kernel.sessions.getStats() as Promise<SessionStats>,
  }), []);

  const models: ModelApi = useMemo(() => ({
    getModels: () => window.kernel.sessions.getModels() as Promise<ModelInfo[]>,
    setModel: (provider, modelId, kernel) => window.kernel.sessions.setModel(provider, modelId, kernel),
    test: (cwd, provider, modelId, kernel) => window.kernel.sessions.testModel(cwd, provider, modelId, kernel),
    setThinkingLevel: (level) => window.kernel.sessions.setThinkingLevel(level),
    getStats: () => window.kernel.sessions.getStats() as Promise<SessionStats>,
  }), []);

  const tree: SessionTreeApi = useMemo(() => ({
    fork: (parentLineageId, boundary) => window.kernel.sessions.fork(parentLineageId, boundary) as Promise<string>,
    getStats: () => window.kernel.sessions.getStats() as Promise<SessionStats>,
  }), []);



  const fs: FsApi = useMemo(() => ({
    listDir: (cwd) => window.kernel.fs.listDir(pluginId, cwd),
    removePath: (path) => window.kernel.fs.removePath(pluginId, path),
    readDirTree: (cwd, opts) => window.kernel.fs.readDirTree(pluginId, cwd, opts),
    readFile: (path) => window.kernel.fs.readFile(pluginId, path),
    readFileBase64: (path) => window.kernel.fs.readFileBase64(pluginId, path),
    createFile: (path) => window.kernel.fs.createFile(pluginId, path),
    createDir: (path) => window.kernel.fs.createDir(pluginId, path),
    renamePath: (from, to) => window.kernel.fs.renamePath(pluginId, from, to),
    copyPath: (from, to) => window.kernel.fs.copyPath(pluginId, from, to),
  }), [pluginId]);

  const git: GitReadApi = useMemo(() => ({
    status: (cwd) => window.kernel.git.status(pluginId, cwd),
    fileDiff: (cwd, path) => window.kernel.git.fileDiff(pluginId, cwd, path),
    fileContent: (cwd, path) => window.kernel.git.fileContent(pluginId, cwd, path),
    log: (cwd, limit) => window.kernel.git.log(pluginId, cwd, limit),
  }), [pluginId]);

  const gitWrite: GitWriteApi = useMemo(() => ({
    commit: (cwd, message, files) => window.kernel.gitWrite.commit(pluginId, cwd, message, files),
    push: (cwd) => window.kernel.gitWrite.push(pluginId, cwd),
  }), [pluginId]);

  const llm: LlmOneshotApi = useMemo(() => ({
    oneshot: (prompt) => window.kernel.llm.oneshot(pluginId, prompt),
  }), [pluginId]);

  const bus: BusApi = useMemo(() => ({
    status: () => window.kernel.bus.status(pluginId),
    send: (to, kind, payload, replyTo) => window.kernel.bus.send(pluginId, to, kind, payload, replyTo),
    sessionCreate: (opts) => window.kernel.bus.sessionCreate(pluginId, opts),
    sessionAbort: (session) => window.kernel.bus.sessionAbort(pluginId, session),
    channelMember: (channel, action, member) => window.kernel.bus.channelMember(pluginId, channel, action, member),
    tapStart: (opts) => window.kernel.bus.tapStart(pluginId, opts),
    tapStop: (tapId) => window.kernel.bus.tapStop(pluginId, tapId),
    onMessage: (cb) => window.kernel.bus.onMessage(cb),
  }), [pluginId]);

  const dialog: DialogApi = useMemo(() => ({
    openDirectory: () => window.kernel.dialog.openDirectory(),
    openImages: () => window.kernel.dialog.openImages(),
    openTextFile: (opts) => window.kernel.dialog.openTextFile(opts),
    saveTextFile: (opts) => window.kernel.dialog.saveTextFile(opts),
    writeImages: (dir, images) => window.kernel.dialog.writeImages(dir, images),
    saveZip: (opts) => window.kernel.dialog.saveZip(opts),
    openZip: (opts) => window.kernel.dialog.openZip(opts),
    openFile: (path) => window.kernel.openFile(path),
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
    config, sessions, messaging, models, tree, pi,
    i18n: i18nApi, fs, git, gitWrite, llm, dialog, events, bus, layout,
    prefs: window.kernel.prefs,
    themes: window.kernel.themes,
    fonts: window.kernel.fonts,
    kernels: window.kernel.kernels,
    dshModels: window.kernel.dshModels,
    kernelModels: window.kernel.kernelModels,
    kernelConfig: window.kernel.kernelConfig,
    dshSettings: window.kernel.dshSettings,
    modelsConfig: window.kernel.models,
    piSettings: window.kernel.piSettings,
    configFile: { get: window.kernel.configFile.get, append: window.kernel.configFile.append, readBinary: window.kernel.configFile.readBinary, writeBinary: window.kernel.configFile.writeBinary },
    plugins: window.kernel.plugins,
    kernelExtensions: window.kernel.kernelExtensions,
    skills: window.kernel.skills,
    restart: window.kernel.restart,
    openFile: window.kernel.openFile,
    appInfo: { get: () => window.kernel.app.info(), restart: () => window.kernel.app.restart() },
    notify: { show: (opts) => window.kernel.notify.show(opts) },
    window: { isFocused: () => window.kernel.window.isFocused() },
  }), [config, sessions, messaging, models, tree, pi, i18nApi, fs, git, gitWrite, llm, dialog, events, bus, layout]);
}
