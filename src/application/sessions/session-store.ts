// 会话存储 —— application 层:多会话多 pi 进程调度。
//
// 进程模型(用户拍板):会话是文件,进程是按需的临时工,且**每会话一进程、多会话多进程**。
// - 看会话 = 读文件(session-scanner.readSession),不启 pi
// - 发消息 = 按需起该会话的 pi:ensureForSend 保证激活会话的 pi 在跑,
//   不杀其他会话的进程(多会话并存)
// - 切会话:setContext 设激活;激活会话 pi 活着则 resync 推基线,没活则等 prompt 时起
// - pi 启动/关闭不阻塞展示:进程动作全在发送路径上
//
// 依赖倒置:本层不 new RpcAdapter(那是 gateway 具体类),而是持 RpcAdapterFactory
// 接口(本层拥有),实现由 shell 注入。换运行时只换 factory 实现,本文件一行不改。
// application 依赖 gateway(type)+ domain,不依赖 shell。
import type { RpcAdapter } from "../../gateway/rpc-adapter";
import { translateEvent } from "../../gateway/event-translator";
import { resync } from "../orchestrations/resync";
import {
  buildPromptCommand, buildSetModelCommand,
  buildSteerCommand, buildFollowUpCommand,
  buildCycleModelCommand, buildCycleThinkingLevelCommand,
  buildCompactCommand, buildSetAutoCompactionCommand, buildSetAutoRetryCommand, buildAbortRetryCommand,
  buildForkCommand, buildCloneCommand, buildGetForkMessagesCommand,
  buildExportHtmlCommand, buildGetLastAssistantTextCommand,
  buildSetSteeringModeCommand, buildSetFollowUpModeCommand,
  buildBashCommand, buildAbortBashCommand,
  buildSetSessionNameCommand,
} from "../../gateway/protocol/commands";
import { toModelInfo, toSessionStats } from "../../gateway/context-binding";
import type { RpcCommand, RpcResponse, Model } from "../../gateway/protocol/rpc-types";
import type { SessionEvent, SyncSnapshot, ModelInfo, SessionStats, NeutralMessage } from "../../domain/events/session-state";
import { isVisibleMessage, deduplicateAdjacent } from "../../domain/events/session-state";
import type { KernelEvent } from "../../domain/events/kernel-event";
import type { SessionStoreForRestart } from "../../domain/restart";
import type {
  SessionsApi, MessagingApi, ModelApi, SessionTreeApi, SessionMaintenanceApi, QueueModeApi, BashApi,
  ImageInput, BashResult, SessionInfo, HeaderPatch, SessionDetail, SessionToolConfig, ModelTestResult,
} from "../../domain/sessions";
import { truncateSessionName, cwdToBucketName } from "../../domain/sessions";
import {
  updateSessionHeader, listSessions, readSession, readSessionToolConfig,
  recentSessionSettings, renameSession as renameSessionFile, copySession as copySessionFile,
  removePath, deleteSessionFiles,
} from "./session-scanner";
import { randomUUID } from "node:crypto";

/**
 * RpcAdapterFactory —— application 拥有的依赖倒置抽象。
 * shell 实现并注入:create({cwd,args}) 返回一个已绑 SubprocessHandle 的 RpcAdapter,
 * 调用方再 .start()。本接口不暴露 spawn 细节(application 不感知子进程)。
 */
export interface RpcAdapterFactory {
  create(opts: { cwd?: string; args?: string[]; env?: Record<string, string> }): RpcAdapter;
}

/** 会话进程条目:adapter + 绑的 cwd/sessionPath + 该会话的 TPS 跟踪。 */
interface SessionProc {
  adapter: RpcAdapter;
  cwd: string;
  boundSessionPath: string | null;
  genStartMs: number | null;
  lastTps: number | null;
}

export class SessionStore implements
  SessionsApi, MessagingApi, ModelApi, SessionTreeApi, SessionMaintenanceApi, QueueModeApi, BashApi, SessionStoreForRestart
{
  /** 会话 → 进程条目。key = sessionPath(历史会话)或 `new:${cwd}`(新会话,未落盘)。 */
  private procs = new Map<string, SessionProc>();
  /** session busy 状态:agentStart 设 true、agentSettled 设 false(§6.6)。 */
  private busyStates = new Map<string, boolean>();
  private factory: RpcAdapterFactory;
  /** 视图流监听器(onEvent):只收激活会话的事件,渲染层不需关心多进程归属。 */
  private listeners = new Set<(event: SessionEvent) => void>();
  /** 运维流监听器:收全部会话的事件并带 sessionKey(restart-coordinator 等按 key 订阅)。 */
  private keyedListeners = new Set<(event: SessionEvent, sessionKey: string) => void>();
  private kernelListeners = new Set<(event: KernelEvent) => void>();
  private extUiListeners = new Set<(req: { requestId: string; method: string; [k: string]: unknown }) => void>();
  private snapshotListeners = new Set<(snapshot: SyncSnapshot) => void>();
  /** 最近一次 sync 的投影基线(renderer 增量应用的起点)。 */
  latestSnapshot: SyncSnapshot | null = null;

  /** 当前激活会话的 key(setContext 设);发送路径的目标。 */
  private activeCwd: string | null = null;
  private activeSessionPath: string | null = null;
  /** 激活会话在 procs 里的 key(初始 = sessionPath 或 new:${cwd};不随 sessionFile 移动)。
   *  adapter.onEvent 闭包绑这个 key,移 key 会丢失事件转发,故 key 不动,只更新 boundSessionPath。 */
  private activeProcKey: string = "";

  /** factory 由 shell 在启动期注入(依赖倒置);不在此 new gateway 具体类。 */
  /** agentDir 由 shell 注入(pi 底座会话根目录);application 不直读 process.env.HOME(依赖倒置)。 */
  private agentDir: string;
  constructor(factory: RpcAdapterFactory, agentDir: string) {
    this.factory = factory;
    this.agentDir = agentDir;
  }

  /** 某会话 pi 是否活着。 */
  private isAlive(key: string): boolean {
    return this.procs.get(key)?.adapter.alive ?? false;
  }

  get alive(): boolean {
    return this.activeProcKey ? this.isAlive(this.activeProcKey) : false;
  }

  /** 激活会话的 key(= activeProcKey;adapter.onEvent 闭包绑此 key,移 key 会丢事件故不动)。 */
  private get activeKey(): string {
    return this.activeProcKey;
  }

  /** 激活会话的 adapter(没起抛错;调用方先 ensure)。 */
  private activeProc(): SessionProc | undefined {
    return this.procs.get(this.activeKey);
  }

  /** 记录发送路径的上下文(cwd + 会话文件,null=新会话)。不动进程,只设激活。
   *  若激活会话 pi 活着 → resync 推基线(切回正在跑的会话拿实时状态);
   *  没活 → 清基线(renderer 走文件读或等 prompt 时起)。 */
  setContext(cwd: string, sessionPath: string | null): void {
    this.activeCwd = cwd;
    this.activeSessionPath = sessionPath;
    // procs 的 key 用初始 sessionPath 或 new:${cwd}(不随 sessionFile 变;adapter 闭包绑此 key)
    const key = sessionPath ?? (cwd ? `new:${cwd}` : "");
    this.activeProcKey = key;
    // 新会话(sessionPath=null)时:停掉旧的新会话进程(new:cwd key),不复用旧进程。
    // 否则"新会话"会复用上一个新会话的 pi 进程(续旧会话,非新会话语义)。
    if (sessionPath === null && cwd) {
      const oldProc = this.procs.get(`new:${cwd}`);
      if (oldProc && oldProc.adapter.alive) {
        void oldProc.adapter.stop().then(() => { this.procs.delete(`new:${cwd}`); });
      }
    }
    if (this.isAlive(key)) {
      // 激活会话 pi 活着:resync 推基线(切回流式中的会话拿实时状态)
      void this.sync().catch(() => {});
    } else {
      // 没活:清基线,renderer 走文件读
      this.latestSnapshot = null;
    }
    // 激活即推给 renderer 水合 useUiStore.currentSessionPath(根因修复,勿回退):
    // 底座 session_start 是纯扩展事件(_sessionStartEvent 只经 _extensionRunner.emit
    // 走扩展通道;AgentSessionEvent 联合不含 sessionStart;RPC stdout 永不见
    // session_start),renderer 永远等不到底座推出该事件。此前打开历史会话靠
    // sessions-list 手动补写 currentSessionPath——隐式契约,第二个忘记补写的入口
    // 就会导致"视图里有会话内容、发送却走了新会话分支"。修复:main 激活会话时
    // 主动推 synthetic sessionStart,当前会话流的真相源单一在 main。
    if (sessionPath) {
      this.dispatch(key, { type: "sessionStart", sessionFile: sessionPath });
    }
  }

  /** fs:project IPC 圈禁的锚点(当前激活项目根;shell 的 IPC 边界从这里取)。 */
  getActiveCwd(): string | null {
    return this.activeCwd;
  }

  /** 启动激活会话的 pi(按需;sessionPath 给定时 spawn --session 续上下文)。
   *  不杀其他会话的进程(多会话并存)。完成后 sync 广播基线。 */
  async start(cwd: string, sessionPath?: string): Promise<void> {
    this.activeCwd = cwd;
    this.activeSessionPath = sessionPath ?? null;
    // procs 的 key 用初始 sessionPath 或 new:${cwd}(不随 sessionFile 变;adapter 闭包绑此 key)
    const key = sessionPath ?? `new:${cwd}`;
    this.activeProcKey = key;
    if (this.isAlive(key)) return; // 已活,不重复起
    const proc = this.createProc(key, cwd, sessionPath ?? null);
    this.procs.set(key, proc);
    await proc.adapter.start();
    await this.waitReady(proc.adapter);
    await this.sync();
  }

  /** 创建并装配一个 pi 进程条目:adapter + 全套事件绑定。
   *  start/restart 唯一装配入口——此前 restart 另抄一份丢了 onExtensionUI/onProcessExit,
   *  重启后的会话收不到扩展 UI 请求、进程退出静默(根因:同一逻辑两处拷贝)。 */
  private createProc(key: string, cwd: string, sessionPath: string | null): SessionProc {
    const adapter = this.factory.create({
      cwd,
      args: sessionPath ? ["--session", sessionPath] : [],
    });
    const proc: SessionProc = { adapter, cwd, boundSessionPath: sessionPath, genStartMs: null, lastTps: null };
    adapter.onEvent((event) => this.dispatch(key, translateEvent(event)));
    adapter.onExtensionUI((req) => {
      this.dispatchKernel({
        source: "pi", kind: "extensionUI",
        requestId: req.id, method: req.method, sessionKey: key,
        // 其余底座协议字段透传(显式映射 id→requestId,不散播 req 以免 method 重复覆盖)
        payload: req,
      });
      for (const cb of this.extUiListeners) {
        try {
          // 映射底座协议(id)→ 中性契约(requestId),listener 见到的是 SessionsApi.onExtensionUI 契约形状
          cb({ requestId: req.id, method: req.method, sessionKey: key, payload: req });
        } catch (err) { console.error("[session-store] Extension UI 监听器抛错已隔离:", err); }
      }
    });
    adapter.onProcessExit = (exit, expected) => {
      this.dispatchKernel({
        source: "desktop", kind: "processExit",
        code: exit.code, signal: exit.signal, expected,
        stderr: adapter.stderr.slice(-500), sessionKey: key,
      });
    };
    return proc;
  }

  /** 停指定会话的 pi(不传 = 激活会话);其他会话进程不动。 */
  async stop(sessionPath?: string | null): Promise<void> {
    const key = sessionPath != null ? sessionPath : this.activeKey;
    const proc = this.procs.get(key);
    if (!proc) return;
    await proc.adapter.stop();
    this.procs.delete(key);
    if (key === this.activeKey) this.latestSnapshot = null;
  }

  /** 停所有会话的 pi(应用退出兜底)。 */
  async stopAll(): Promise<void> {
    const ps = [...this.procs.values()].map((p) => p.adapter.stop().catch(() => {}));
    await Promise.all(ps);
    this.procs.clear();
    this.latestSnapshot = null;
  }

  /**
   * 发送前的进程保证:激活会话的 pi 在跑。没起 → 起;不杀其他会话进程。
   * 新会话(activeSessionPath=null)时:生成新文件路径传给 pi(--session <path>),
   * pi 底座拿到不存在的文件会建新会话。否则 pi 续该 cwd 桶下最新会话(非新会话语义)。
   */
  private async ensureForSend(): Promise<void> {
    if (!this.activeCwd) throw new Error("未选择工作目录");
    if (this.alive) return;
    // 新会话(null):生成新文件路径(~/.pi/agent/sessions/<桶>/<timestamp>_<uuid>.jsonl)
    let sessionPath = this.activeSessionPath ?? undefined;
    if (!sessionPath) {
      sessionPath = this.generateNewSessionPath(this.activeCwd);
      this.activeSessionPath = sessionPath;
    }
    await this.start(this.activeCwd, sessionPath);
  }

  /** 生成新会话文件路径(对齐 pi 底座格式:ISO timestamp + uuid)。 */
  private generateNewSessionPath(cwd: string): string {
    const sessionsRoot = `${this.agentDir}/sessions`;
    const bucket = cwdToBucketName(cwd);
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const uuid = randomUUID();
    return `${sessionsRoot}/${bucket}/${ts}_${uuid}.jsonl`;
  }

  // ---- SessionsApi 文件类方法:委托给 session-scanner(纯文件操作,不启 pi 进程)----
  // SessionStore 作为 SessionsApi 的聚合实现点,文件操作委托同模块 scanner 函数。
  // 进程类操作(start/stop/sync 等)由本类直接实现,文件类操作(list/openSession/...)委托。
  // 这样 SessionsApi 契约名副其实,IPC 边界可统一经 SessionStore 调用(消除 shell 直连 scanner 的散点)。
  async list(cwd: string): Promise<SessionInfo[]> {
    return listSessions(this.agentDir, cwd);
  }
  async openSession(sessionPath: string): Promise<SessionDetail | null> {
    return readSession(sessionPath);
  }
  async renameSession(sessionPath: string, name: string): Promise<void> {
    if (name && sessionPath === this.activeSessionPath && this.alive) {
      const proc = this.activeProc()!;
      await proc.adapter.send(buildSetSessionNameCommand(name));
    } else {
      await renameSessionFile(sessionPath, name);
    }
  }
  async updateHeader(sessionPath: string, patch: HeaderPatch): Promise<void> {
    if (patch.name && sessionPath === this.activeSessionPath && this.alive) {
      const proc = this.activeProc()!;
      await proc.adapter.send(buildSetSessionNameCommand(patch.name));
      const rest = { ...patch };
      delete rest.name;
      if (Object.keys(rest).length > 0) await updateSessionHeader(sessionPath, rest);
    } else {
      await updateSessionHeader(sessionPath, patch);
    }
  }
  async copySession(srcPath: string, targetPath: string): Promise<void> {
    copySessionFile(srcPath, targetPath);
  }
  async deleteSessions(paths: string[]): Promise<void> {
    // 活跃会话禁止删除:进程 append 会让文件复活,删了也白删(机制兜底,UI 侧另有 deletable 过滤)
    const targets = paths.filter((p) => p !== this.activeSessionPath);
    if (targets.length > 0) await deleteSessionFiles(targets);
  }
  async readToolConfig(sessionPath: string): Promise<SessionToolConfig | null> {
    return readSessionToolConfig(sessionPath);
  }
  async recentSettings(cwd: string): Promise<{ provider?: string; modelId?: string; thinkingLevel?: string }> {
    return recentSessionSettings(this.agentDir, cwd);
  }

  /** pi 就绪:sessionStart 事件驱动优先、get_state 轮询兜底。
   *  事件驱动首选:sessionStart 是底座跑通后第一时间推的就绪信号,到立即返回,不 sleep 等抓空。
   *  实证探测兜底(§3.6):sessionStart 未达或超时仍走 150ms get_state 实证探测,无回归风险。 */
  private async waitReady(adapter: RpcAdapter): Promise<void> {
    let readyResolve: (() => void) | null = null;
    const readyPromise = new Promise<void>((resolve) => { readyResolve = resolve; });
    const off = adapter.onEvent((event) => {
      if ((event as { type?: string } | undefined)?.type === "session_start" && readyResolve) {
        readyResolve();
        readyResolve = null;
      }
    });
    try {
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const race = await Promise.race([
          readyPromise,
          new Promise<null>((r) => setTimeout(() => r(null), 150)),
        ]);
        if (race !== null) return; // sessionStart 已触发:事件驱动就绪
        try {
          await adapter.send({ type: "get_state" });
          return;
        } catch {
          // 再等一轮:实证探测继续
        }
      }
    } finally {
      off();
    }
    // 超时也继续:让后续 sync 的真实错误冒出去,不在此掩盖
  }

  /** resync 一次并广播新基线(start 后与显式刷新走这里)。作用于激活会话。 */
  async sync(): Promise<SyncSnapshot> {
    const proc = this.activeProc();
    if (!proc || !proc.adapter.alive) throw new Error("pi 未启动");
    const snapshot = await resync(proc.adapter);
    this.latestSnapshot = snapshot;
    for (const cb of this.snapshotListeners) {
      try {
        cb(snapshot);
      } catch (err) {
        console.error("[session-store] 快照监听器抛错已隔离:", err);
      }
    }
    return snapshot;
  }

  /** 订阅新基线快照(start/sync 后每次广播一次)。 */
  onSnapshot(cb: (snapshot: SyncSnapshot) => void): () => void {
    this.snapshotListeners.add(cb);
    return () => this.snapshotListeners.delete(cb);
  }

  /** 读当前基线(无基线且 pi 活着时现拉;pi 未启动 reject,调用方走文件读)。 */
  async getSnapshot(): Promise<SyncSnapshot> {
    if (this.latestSnapshot) return this.latestSnapshot;
    return this.sync();
  }

  onEvent(cb: (event: SessionEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  onKernelEvent(cb: (event: KernelEvent) => void): () => void {
    this.kernelListeners.add(cb);
    return () => this.kernelListeners.delete(cb);
  }

  onExtensionUI(cb: (req: { requestId: string; method: string; [k: string]: unknown }) => void): () => void {
    this.extUiListeners.add(cb);
    return () => this.extUiListeners.delete(cb);
  }

  async replyExtensionUI(requestId: string, response: { value?: string; confirmed?: boolean; cancelled?: true }): Promise<void> {
    const proc = this.activeProc();
    if (!proc) throw new Error("pi 未启动");
    proc.adapter.sendExtensionUIResponse({
      type: "extension_ui_response", id: requestId,
      value: response.value, confirmed: response.confirmed, cancelled: response.cancelled,
    });
  }

  /** 发消息(唯一会起进程的入口:ensureForSend 后才发)。作用于激活会话。 */
  async prompt(text: string, images?: ImageInput[]): Promise<void> {
    await this.ensureForSend();
    const proc = this.activeProc();
    if (!proc) throw new Error("pi 未启动");
    await proc.adapter.send(buildPromptCommand({
      message: text,
      images: images?.map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mimeType })),
    }));
    // 发送确立"当前会话流":推给 renderer 水合 useUiStore.currentSessionPath
    // (根因修复,勿回退):底座 session_start 是纯扩展事件,永远不会出现在 RPC
    // stdout 流里,renderer 永远等不到底座推出→useUiStore.currentSessionPath
    // 恒 null→renderer sendText 每次发送都走 startNewChat 分支→ensureForSend
    // 每次生成全新 sessionPath→笔记/常用语连点两次=两个新会话。修复:发送
    // 成功后 main 主动推 synthetic sessionStart,renderer 现有 onEvent 分支
    // 直接水合;已发出的发送目标就是当前会话流,再发一条基于当前会话续发。
    if (this.activeSessionPath) {
      this.dispatch(this.activeProcKey, { type: "sessionStart", sessionFile: this.activeSessionPath });
    }
    // 自动命名条件是"活跃会话还没有名字"而非"新会话":真实使用多为 CLI 建会话、
    // desktop 打开续聊,wasNewSession(activeSessionPath===null) 恒 false,autoName 永不触发。
    // latestSnapshot.state.sessionName 由 dispatch 对 sessionInfoChanged 的增量 patch 保持新鲜,
    // 故手动 rename 后不会被自动命名覆盖;清空后重发消息会重新自动命名(已知取舍,见
    // docs/design/session-name-tracks.md §4.4)。
    if (this.activeSessionPath && !this.latestSnapshot?.state.sessionName) {
      const autoName = truncateSessionName(text);
      if (autoName) {
        try {
          // 走 this.send 而非 proc.adapter.send:复用其 rpcError 上报(dispatchKernel),
          // 失败从静默 console.error 变为 renderer 可订阅的 kernel 事件。
          await this.send(buildSetSessionNameCommand(autoName));
          if (this.latestSnapshot) this.latestSnapshot.state.sessionName = autoName;
        } catch (e) {
          console.error("[session-store] 自动命名失败:", { path: this.activeSessionPath, name: autoName, error: e });
        }
      }
    }
  }

  async abort(): Promise<void> {
    const proc = this.activeProc();
    if (!proc || !proc.adapter.alive) return;
    await proc.adapter.send({ type: "abort" });
  }

  async getModels(): Promise<ModelInfo[]> {
    const res = (await this.send({ type: "get_available_models" })) as RpcResponse & {
      data?: { models?: Model[] };
    };
    const models = (res.data as { models?: Model[] } | undefined)?.models ?? [];
    return models.map(toModelInfo);
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    const proc = this.activeProc();
    if (!proc || !proc.adapter.alive) return;
    await proc.adapter.send(buildSetModelCommand({ provider, modelId }));
    // model_select 同 sessionStart 一类(纯扩展事件,RPC stdout 收不到,见 prompt 处
    // 根因注释):不等底座事件,发完 set_model 立即 sync 一次取真实 state.model
    // (事件驱动于 RPC 完成,非 sleep/轮询;fire-and-forget 不阻塞调用方)。
    void this.sync().catch(() => {});
  }

  /** 模型连通性测试(ModelApi.test):起独立临时会话进程发一条 ping。
   *  与激活会话完全隔离——不设 activeProcKey、不走 sync/基线、事件只进运维流,时间线无感。
   *  判定:assistant messageEnd 无 error=通;set_model 响应失败 / 消息带 error /
   *  进程退出 / RPC 错 / 超时 = 不通,原文带回。测完停进程 + 删会话文件,零残留。 */
  async test(cwd: string, provider: string, modelId: string, timeoutMs = 60000): Promise<ModelTestResult> {
    if (!cwd) return { ok: false, error: "no working directory" };
    // 独立 proc key(`test:` 前缀永不与会话路径冲突);事件经 dispatch 走 keyed/运维流。
    const key = `test:${randomUUID()}`;
    const proc = this.createProc(key, cwd, null);
    this.procs.set(key, proc);
    try {
      await proc.adapter.start();
      await this.waitReady(proc.adapter);
      // set_model 是同步 RPC:provider/模型 id 不存在在响应里失败,不必等 ping。
      const setRes = await proc.adapter.send(buildSetModelCommand({ provider, modelId }));
      if (!setRes.success) return { ok: false, error: setRes.error ? setRes.error : "set_model failed" };
      // 先订阅再发 ping,不竞态(事件在先,请求在后)。
      const reply = this.awaitTestReply(key, timeoutMs);
      await proc.adapter.send(buildPromptCommand({ message: "ping" }));
      return await reply;
    } finally {
      // 会话文件路径由 dispatch 在 sessionStart 时写入 boundSessionPath(可能尚未生成=底座没落盘)。
      const sessionFile = proc.boundSessionPath;
      try { await proc.adapter.stop(); } catch (e) { console.warn(`[session-store] test proc stop failed:`, e); }
      this.procs.delete(key);
      if (sessionFile) { try { removePath(sessionFile); } catch (e) { console.warn(`[session-store] test session cleanup failed:`, e); } }
    }
  }

  /** 等 test 会话的 ping 结果:只订阅 key 匹配的 keyed 事件流 + 内核进程事件,超时兜底。 */
  private awaitTestReply(key: string, timeoutMs: number): Promise<ModelTestResult> {
    return new Promise((resolve) => {
      let resolved = false;
      const finish = (result: ModelTestResult): void => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        offKeyed();
        this.kernelListeners.delete(onKernel);
        resolve(result);
      };
      const timer = setTimeout(() => finish({ ok: false, error: `timeout ${Math.round(timeoutMs / 1000)}s` }), timeoutMs);
      const offKeyed = this.onSessionEvent(key, (event) => {
        if (event.type === "messageEnd") {
          const msg = (event as { message?: NeutralMessage }).message;
          if (msg?.error) return finish({ ok: false, error: extractMessageError(msg) });
          if (msg?.role === "assistant") return finish({ ok: true });
        }
        if (event.type === "agentEnd" || event.type === "agentSettled") {
          finish({ ok: false, error: "no response" });
        }
      });
      const onKernel = (event: KernelEvent): void => {
        if ((event as { sessionKey?: string }).sessionKey !== key) return;
        if (event.source === "desktop" && event.kind === "processExit" && !event.expected) {
          finish({ ok: false, error: `process exited (code ${event.code})` });
        }
        if (event.source === "desktop" && event.kind === "rpcError") {
          finish({ ok: false, error: event.message });
        }
      };
      this.kernelListeners.add(onKernel);
    });
  }

  async getThinkingLevels(): Promise<string[]> {
    const res = (await this.send({ type: "get_available_thinking_levels" })) as RpcResponse & {
      data?: unknown;
    };
    const data = res.data as { levels?: unknown } | string[] | undefined;
    const levels = Array.isArray(data) ? data : data?.levels;
    return Array.isArray(levels) ? levels.map(String) : [];
  }

  async setThinkingLevel(level: string): Promise<void> {
    const proc = this.activeProc();
    if (!proc || !proc.adapter.alive) return;
    await proc.adapter.send({ type: "set_thinking_level", level: level as never });
  }

  /** 会话统计(底座 get_session_stats):token 用量/上下文占用/消息计数/cost + 自算 tps。 */
  async getStats(): Promise<SessionStats> {
    const proc = this.activeProc();
    if (!proc || !proc.adapter.alive) throw new Error("pi 未启动");
    const res = (await proc.adapter.send({ type: "get_session_stats" })) as RpcResponse & { data?: Record<string, unknown> };
    return toSessionStats(res.data, proc.lastTps);
  }

  // ============ MessagingApi ============

  async steer(text: string, images?: ImageInput[]): Promise<void> {
    await this.ensureForSend();
    const proc = this.activeProc();
    if (!proc) throw new Error("pi 未启动");
    await proc.adapter.send(buildSteerCommand({
      message: text,
      images: images?.map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mimeType })),
    }));
  }

  async followUp(text: string, images?: ImageInput[]): Promise<void> {
    await this.ensureForSend();
    const proc = this.activeProc();
    if (!proc) throw new Error("pi 未启动");
    await proc.adapter.send(buildFollowUpCommand({
      message: text,
      images: images?.map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mimeType })),
    }));
  }

  async abortRetry(): Promise<void> {
    const proc = this.activeProc();
    if (!proc || !proc.adapter.alive) return;
    await proc.adapter.send(buildAbortRetryCommand());
  }

  // ============ ModelApi ============

  async cycleModel(): Promise<void> {
    await this.ensureForSend();
    const proc = this.activeProc();
    if (!proc) throw new Error("pi 未启动");
    await proc.adapter.send(buildCycleModelCommand());
  }

  async cycleThinkingLevel(): Promise<void> {
    await this.ensureForSend();
    const proc = this.activeProc();
    if (!proc) throw new Error("pi 未启动");
    await proc.adapter.send(buildCycleThinkingLevelCommand());
  }

  // ============ SessionTreeApi ============

  async fork(entryId: string): Promise<void> {
    await this.send(buildForkCommand(entryId));
  }

  async clone(): Promise<void> {
    await this.send(buildCloneCommand());
  }

  async getForkMessages(entryId: string): Promise<NeutralMessage[]> {
    const res = (await this.send(buildGetForkMessagesCommand(entryId))) as RpcResponse & {
      data?: { messages?: { role: string; content?: unknown; timestamp?: number }[] };
    };
    const messages = (res.data as { messages?: unknown[] } | undefined)?.messages ?? [];
    return deduplicateAdjacent(
      (messages as NeutralMessage[]).filter(isVisibleMessage),
    );
  }

  // ============ SessionMaintenanceApi ============

  async compact(customInstructions?: string): Promise<void> {
    await this.send(buildCompactCommand(customInstructions));
  }

  async setAutoCompaction(enabled: boolean): Promise<void> {
    await this.send(buildSetAutoCompactionCommand(enabled));
  }

  async setAutoRetry(enabled: boolean): Promise<void> {
    await this.send(buildSetAutoRetryCommand(enabled));
  }

  async exportHtml(outputPath?: string): Promise<string> {
    const res = (await this.send(buildExportHtmlCommand(outputPath))) as RpcResponse & {
      data?: { path?: string } | string;
    };
    if (typeof res.data === "string") return res.data;
    return (res.data as { path?: string } | undefined)?.path ?? "";
  }

  async getLastAssistantText(): Promise<string> {
    const res = (await this.send(buildGetLastAssistantTextCommand())) as RpcResponse & {
      data?: { text?: string } | string;
    };
    if (typeof res.data === "string") return res.data;
    return (res.data as { text?: string } | undefined)?.text ?? "";
  }

  // ============ QueueModeApi ============

  async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
    await this.send(buildSetSteeringModeCommand(mode));
  }

  async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
    await this.send(buildSetFollowUpModeCommand(mode));
  }

  // ============ BashApi ============

  async run(command: string, opts?: { excludeFromContext?: boolean }): Promise<BashResult> {
    const res = (await this.send(buildBashCommand(command, opts?.excludeFromContext))) as RpcResponse & {
      data?: { stdout?: string; stderr?: string; exitCode?: number };
    };
    const data = res.data as { stdout?: string; stderr?: string; exitCode?: number } | undefined;
    return {
      stdout: data?.stdout ?? "",
      stderr: data?.stderr ?? "",
      exitCode: data?.exitCode ?? 0,
    };
  }

  async abortBash(): Promise<void> {
    await this.send(buildAbortBashCommand());
  }

  /** 原样发 RPC 命令(壳内高级用途;插件不暴露,插件走意图方法)。作用于激活会话。 */
  async send(command: RpcCommand): Promise<unknown> {
    const proc = this.activeProc();
    if (!proc || !proc.adapter.alive) throw new Error("pi 未启动");
    const key = this.activeKey;
    try {
      return await proc.adapter.send(command);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 按 err.code 判定超时(评估 P3:此前 includes("超时") 靠中文 substring 匹配,
      // 改文案就误判;correlator 现抛 RpcTimeoutError 带 code="timeout")。
      const reason = err instanceof Error && (err as { code?: string }).code === "timeout" ? "timeout" : "sendError";
      this.dispatchKernel({ source: "desktop", kind: "rpcError", reason, message, sessionKey: key });
      throw err;
    }
  }

  /** 事件路由(多会话并存的核心纪律):
   *  - 状态跟踪(busy/TPS/boundSessionPath):按事件来源 key 记账,与激活无关。
   *  - 运维流(dispatchKernel + keyedListeners):激活会话全量;后台会话只发生命周期类
   *    (messageEnd/agentEnd/agentSettled/sessionStart,带 sessionKey),不转流式增量——
   *    避免后台会话的 messageUpdate 刷屏 IPC,列表刷新/统计/restart 等空闲只需生命周期事件。
   *  - 视图流(listeners,即插件的 sessions.onEvent):只转激活会话——后台会话的任何事件
   *    都不得污染当前时间线(此前 messageEnd 全转发,renderer 无 key 可用,会用别的会话的
   *    消息覆盖当前视图末条、用背景会话的 agentSettled 提前熄掉 streaming,见评估 A)。
   *  TPS 自算:messageStart 记时,messageEnd 用 output tokens / 耗时算 tps(底座不给 TPS)。 */
  private dispatch(key: string, event: SessionEvent): void {
    const proc = this.procs.get(key);
    if (event.type === "sessionStart") {
      const sf = event.sessionFile;
      if (typeof sf === "string" && sf && proc) {
        proc.boundSessionPath = sf;
        // activeSessionPath 只属于激活会话——背景会话的 sessionStart(如重启重载)不得改写
        if (key === this.activeProcKey) this.activeSessionPath = sf;
      }
    }
    if (event.type === "sessionInfoChanged" && key === this.activeProcKey && this.latestSnapshot) {
      // 基线增量:改名即时反映到 latestSnapshot.state.sessionName——prompt() 的自动命名
      // 判定(无名字才命名)依赖基线新鲜;不走全量 sync(事件驱动,见 §5.3 收敛)。
      // 显式收窄:SessionEvent 联合末尾的宽松兑底成员使 case 判别不自动窄化,与 renderer 同一手法。
      // sessionName 已由 gateway 翻译器规范化(空名→undefined),此处直接赋值。
      this.latestSnapshot.state.sessionName = (event as { sessionName?: string }).sessionName;
    }
    if (event.type === "agentStart") {
      this.busyStates.set(key, true);
    } else if (event.type === "agentSettled") {
      this.busyStates.set(key, false);
    } else if (event.type === "compactionStart") {
      this.busyStates.set(key, true);
    } else if (event.type === "compactionEnd") {
      this.busyStates.set(key, false);
    }
    if (proc) {
      if (event.type === "messageStart") {
        proc.genStartMs = Date.now();
      } else if (event.type === "messageEnd" && proc.genStartMs != null) {
        const elapsed = (Date.now() - proc.genStartMs) / 1000;
        const out = extractOutputTokens(event.message);
        proc.lastTps = elapsed > 0 && out > 0 ? out / elapsed : null;
        proc.genStartMs = null;
      }
    }
    // 运维流:激活全量、后台仅生命周期(见函数头注释)
    const isLifecycleEvent =
      event.type === "messageEnd" ||
      event.type === "agentSettled" ||
      event.type === "agentEnd" ||
      event.type === "sessionStart";
    if (key === this.activeProcKey || isLifecycleEvent) {
      this.dispatchKernel({ source: "pi", kind: "session", sessionKey: key, event });
    }
    for (const cb of this.keyedListeners) {
      try { cb(event, key); } catch (err) { console.error("[session-store] keyed 监听器抛错已隔离:", err); }
    }
    // 视图流:仅激活会话
    if (key !== this.activeProcKey) return;
    for (const cb of this.listeners) {
      try { cb(event); } catch (err) { console.error("[session-store] 事件监听器抛错已隔离:", err); }
    }
  }

  private dispatchKernel(event: KernelEvent): void {
    for (const cb of this.kernelListeners) {
      try { cb(event); } catch (err) { console.error("[session-store] kernel event 监听器抛错已隔离:", err); }
    }
  }

  // ============ SessionStoreForRestart(§6.6) ============

  isBusy(sessionKey: string): boolean {
    return this.busyStates.get(sessionKey) ?? false;
  }

  onSessionEvent(sessionKey: string, cb: (event: SessionEvent) => void): () => void {
    // 按事件来源 key 过滤(此前错拿 activeProcKey 比,后台会话的订阅永远不触发,
    // restart-coordinator 等空闲永远等不到 agentSettled——根因修复,勿回退)。
    const wrapper = (event: SessionEvent, key: string) => {
      if (key === sessionKey) cb(event);
    };
    this.keyedListeners.add(wrapper);
    return () => { this.keyedListeners.delete(wrapper); };
  }

  getRunningSessionKeys(): string[] {
    return [...this.procs.keys()].filter((k) => this.procs.get(k)?.adapter.alive);
  }

  async restart(sessionKey: string): Promise<void> {
    const proc = this.procs.get(sessionKey);
    if (!proc) return;
    const { cwd, boundSessionPath } = proc;
    await this.stop(sessionKey);
    // 与 start() 同一装配入口:createProc 绑定全部事件(含 extensionUI/processExit)。
    const newProc = this.createProc(sessionKey, cwd, boundSessionPath);
    this.procs.set(sessionKey, newProc);
    await newProc.adapter.start();
    await this.waitReady(newProc.adapter);
    // 只有重启的是激活会话才重推基线;后台会话重启不打扰当前视图,
    // 且 activeProc 没 alive 时 sync 会 throw 被误判为 restart 失败。
    if (sessionKey === this.activeProcKey) await this.sync();
  }

  getCwdAndSessionPath(sessionKey: string): { cwd: string; sessionPath: string | null } {
    const proc = this.procs.get(sessionKey);
    if (!proc) return { cwd: "", sessionPath: null };
    return { cwd: proc.cwd, sessionPath: proc.boundSessionPath };
  }
}

/** 从带 error 标记的 NeutralMessage 里提取可读错误原语(errorMessage/stopReason 透传字段)。 */
function extractMessageError(message: NeutralMessage): string {
  const m = message as Record<string, unknown>;
  if (typeof m.errorMessage === "string" && m.errorMessage) return m.errorMessage;
  if (typeof m.stopReason === "string" && m.stopReason) return m.stopReason;
  return "model error";
}

/** 从 messageEnd.message 多路径提 output tokens(底座字段形状未文档化,防御性提取)。 */
function extractOutputTokens(message: unknown): number {
  if (!message || typeof message !== "object") return 0;
  const m = message as Record<string, unknown>;
  const usage = (m.usage ?? m.tokenUsage ?? m.tokens) as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== "object") return 0;
  for (const k of ["outputTokens", "output", "output_tokens", "completionTokens"]) {
    if (typeof usage[k] === "number") return usage[k] as number;
  }
  return 0;
}
