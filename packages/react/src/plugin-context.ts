import type {
  PluginConfigApi,
  PluginContext,
  LayoutApi,
} from "@my-harness-desktop/shared";
import type {
  SessionsApi, MessagingApi, ModelApi, SessionTreeApi,
  FsApi, GitReadApi, GitWriteApi, LlmOneshotApi, DialogApi, BusApi,
  I18nApi,
  SessionInfo, SessionDetail, ImageInput, BashResult,
  ModelInfo, SessionStats, NeutralMessage, KnownToolInfo,
} from "@my-harness-desktop/shared";
import type { SessionEvent, SyncSnapshot } from "@my-harness-desktop/shared";
import type { KernelEvent, QuestionRequestEvent, QuestionAnswer, PendingQuestionRecord } from "@my-harness-desktop/shared";
import type { LineageTree, BookmarkSnapshot } from "@my-harness-desktop/shared";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { usePluginId } from "./plugin-id-context";
import { eventBus, type PluginEventsApi } from "./event-bus";
import { useLayoutStore } from "../../../src/web/stores/layout-store";
import { promptSession } from "../../../src/web/stores/session-store";
// r82：config.set 的框架级失败兜底需要两样非组件能力——
//   · announceTransient：Announce 的命令式孪生（同一宿主、同一 DOM 形态）
//   · i18next 单例：在 useMemo 里查文案（用 hook 的 t 会把语言切换塞进依赖数组）
import { announceTransient } from "./widgets/live-region";
import { i18next } from "../../../src/web/app/i18n-init";

export function usePluginContext(): PluginContext {
  const pluginId = usePluginId();
  const { t, i18n } = useTranslation();

  const config: PluginConfigApi = useMemo(() => ({
    get: <T,>(key: string) => window.kernel.config.get<T>(pluginId, key),
    // ⚠ 框架级兜底（r82）：`config.set` 失败此前是**静默**的——服务端 handler 抛错时
    //   gateway 转成 {ok:false,error:{code:"HANDLER_ERROR"}}、transport 据此 reject
    //   （ws-transport.ts:102），而 9 处调用点既不在 try 内也无 .catch ⇒ 用户的设置
    //   界面上已翻、实际没落盘，且一点提示都没有（§7.6 禁止的静默失败）。
    //   收进框架一处（§3.3：9 个调用方的处理逻辑大同小异 ⇒ 该收进框架，而不是各写一遍）：
    //   失败时用 announceTransient 播报（错误 ⇒ role=alert 可打断），并**保持 reject 语义**
    //   （已经自己 try/catch 的调用方行为不变）。
    set: <T,>(key: string, value: T, opts?: { scope?: "project" | "global" }) =>
      window.kernel.config.set(pluginId, key, value, opts).catch((err: unknown) => {
        // 播报用 role=alert（错误可打断）；随后**重新抛出**，保持原有 reject 语义
        // （已经自己 try/catch 的调用方行为完全不变）。
        // 文案走 i18next 单例（不是 hook 里的 t）：这段在 useMemo 里构造，
        // 依赖数组只有 pluginId，把 t 塞进来会让每次语言切换都重建整个 config 面。
        announceTransient(
          i18next.t("shell.configWriteFailed", { detail: (err as Error)?.message ?? String(err) }),
          "error",
        );
        throw err;
      }),
    all: () => window.kernel.config.all(pluginId),
    getScope: (scope: "project" | "global") => window.kernel.config.getScope(pluginId, scope),
  }), [pluginId]);

  const i18nApi: I18nApi = useMemo(() => ({
    t: (key, vars) => t(key, vars as Record<string, unknown>) as string,
    locale: i18n.language,
    list: () => window.kernel.i18n.list(),
  }), [t, i18n.language]);

  const sessions: SessionsApi = useMemo(() => ({
    getSnapshot: () => window.kernel.sessions.getSnapshot() as Promise<SyncSnapshot>,
    sync: () => window.kernel.sessions.sync() as Promise<SyncSnapshot>,
    onEvent: (cb) => window.kernel.sessions.onEvent((e) => cb(e as SessionEvent)),
    onKernelEvent: (cb) => window.kernel.sessions.onKernelEvent((e) => cb(e as KernelEvent)),
    onQuestion: (cb) => window.kernel.sessions.onQuestion((req) => cb(req as QuestionRequestEvent)),
    answerQuestion: (requestId, answers) => window.kernel.sessions.answerQuestion(requestId, answers as QuestionAnswer[]),
    getPendingQuestions: () => window.kernel.sessions.getPendingQuestions() as Promise<PendingQuestionRecord[]>,
    listTools: () => window.kernel.sessions.listTools() as Promise<KnownToolInfo[] | null>,
    onSnapshot: (cb) => window.kernel.sessions.onSnapshot((s) => cb(s as SyncSnapshot)),
    list: (cwd) => window.kernel.sessions.list(cwd) as Promise<SessionInfo[]>,
    rawFilePaths: (sessionId) => window.kernel.sessions.rawFilePaths(sessionId),
    // 压缩与内容读取（曾在 `ctx.pi` 袋子里；归位到 sessions，能力轴 compaction/snapshot）
    compact: (customInstructions?) => window.kernel.sessions.compact(customInstructions),
    setAutoCompaction: (enabled) => window.kernel.sessions.setAutoCompaction(enabled),
    getLastAssistantText: () => window.kernel.sessions.getLastAssistantText(),
    openSession: (sessionPath) =>
      // domain 契约已对齐真实返回值(SessionDetail|null),不再在边界处裁剪丢 info
      window.kernel.sessions.openSession(sessionPath) as Promise<SessionDetail | null>,
    setContext: (cwd, sessionPath) => window.kernel.sessions.setContext(cwd, sessionPath),
    renameSession: (sessionPath, name) =>
      window.kernel.sessions.renameSession(sessionPath, name).then(() => undefined),
    updateHeader: (sessionPath, patch) =>
      window.kernel.sessions.updateHeader(sessionPath, patch).then(() => undefined),
    annotate: (sessionPath, customType, content) =>
      window.kernel.sessions.annotate(sessionPath, customType, content),
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
  }), []);

  const messaging: MessagingApi = useMemo(() => ({
    // promptSession:系统发送面——prefs 缺省时框架三级解析(pending>头>兜底),插件不传也有归属;
    // 不过输入框管线(无乐观回显/待发队列)。goal 续跑等插件自驱动发送走这里。
    prompt: (text, images?: ImageInput[], display?, prefs?) => promptSession(text, images, display, prefs),
    abort: () => window.kernel.sessions.abort(),
    // 多路并发 + 重试（曾在 `ctx.pi` 袋子里；按语义域归位到 messaging，能力轴 steering/retry）
    steer: (text, images?: ImageInput[]) => window.kernel.sessions.steer(text, images),
    followUp: (text, images?: ImageInput[]) => window.kernel.sessions.followUp(text, images),
    setSteeringMode: (mode) => window.kernel.sessions.setSteeringMode(mode),
    setFollowUpMode: (mode) => window.kernel.sessions.setFollowUpMode(mode),
    abortRetry: () => window.kernel.sessions.abortRetry(),
    setAutoRetry: (enabled) => window.kernel.sessions.setAutoRetry(enabled),
    getStats: () => window.kernel.sessions.getStats() as Promise<SessionStats>,
  }), []);

  const models: ModelApi = useMemo(() => ({
    getModels: () => window.kernel.sessions.getModels() as Promise<ModelInfo[]>,
    setModel: (provider, modelId, kernel) => window.kernel.sessions.setModel(provider, modelId, kernel),
    test: (cwd, provider, modelId, kernel) => window.kernel.sessions.testModel(cwd, provider, modelId, kernel),
    setThinkingLevel: (level) => window.kernel.sessions.setThinkingLevel(level),
    // 轮转与档位清单（曾在 `ctx.pi` 袋子里；归位到 models，能力轴 modelCycle/thinking）
    cycleModel: () => window.kernel.sessions.cycleModel(),
    getThinkingLevels: () => window.kernel.sessions.getThinkingLevels(),
    cycleThinkingLevel: () => window.kernel.sessions.cycleThinkingLevel(),
    getStats: () => window.kernel.sessions.getStats() as Promise<SessionStats>,
  }), []);

  const tree: SessionTreeApi = useMemo(() => ({
    fork: (parentLineageId, boundary, position, opts) => window.kernel.sessions.fork(parentLineageId, boundary, position, opts) as Promise<string>,
    // forkFromSession 是中性面(unify §7.1:同一 deriveSession 派生核,两内核平等),
    // 不再是 pi 扩展面——返回新 neutralSessionId,派生即跳转(壳侧 setContext)。
    forkFromSession: (srcNs, entryId, position, opts) => window.kernel.sessions.forkFromSession(srcNs, entryId, position, opts),
    getStats: () => window.kernel.sessions.getStats() as Promise<SessionStats>,
    // clone/getForkMessages 已是壳的中性实现(session-single-source §4.2),从 pi 扩展面收编到树面
    clone: () => window.kernel.sessions.clone(),
    getForkMessages: (entryId) => window.kernel.sessions.getForkMessages(entryId) as Promise<NeutralMessage[]>,
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
    openFiles: (opts) => window.kernel.dialog.openFiles(opts),
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
    config, sessions, messaging, models, tree,
    i18n: i18nApi, fs, git, gitWrite, llm, dialog, events, bus, layout,
    prefs: window.kernel.prefs,
    themes: window.kernel.themes,
    fonts: window.kernel.fonts,
    kernels: window.kernel.kernels,
    kernelModels: window.kernel.kernelModels,
    modelsProbe: window.kernel.modelsProbe,
    kernelConfig: window.kernel.kernelConfig,
    modelsConfig: window.kernel.models,
    configFile: { get: window.kernel.configFile.get, append: window.kernel.configFile.append, readBinary: window.kernel.configFile.readBinary, writeBinary: window.kernel.configFile.writeBinary },
    plugins: window.kernel.plugins,
    kernelExtensions: window.kernel.kernelExtensions,
    skills: window.kernel.skills,
    restart: window.kernel.restart,
    openFile: window.kernel.openFile,
    appInfo: { get: () => window.kernel.app.info(), restart: () => window.kernel.app.restart() },
    notify: { show: (opts) => window.kernel.notify.show(opts) },
    window: { isFocused: () => window.kernel.window.isFocused() },
  }), [config, sessions, messaging, models, tree, i18nApi, fs, git, gitWrite, llm, dialog, events, bus, layout]);
}
