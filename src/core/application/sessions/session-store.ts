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
import type { RpcAdapter } from "../../../client/pi/rpc-adapter";
import { translateEvent } from "../../protocol/event-translator";
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
} from "../../protocol/commands";
import { toModelInfo, toSessionStats } from "../../protocol/context-binding";
import type { RpcCommand, RpcResponse, Model } from "../../protocol/rpc-types";
import type { SessionEvent, SyncSnapshot, ModelInfo, SessionStats, ProjectStats, NeutralMessage } from "../../domain/events/session-state";
import { isVisibleMessage, deduplicateAdjacent } from "../../domain/events/session-state";
import type { KernelEvent } from "../../domain/events/kernel-event";
import type { SessionStoreForRestart } from "../../domain/restart";
import type {
  SessionsApi, MessagingApi, ModelApi, SessionTreeApi, SessionMaintenanceApi, QueueModeApi, BashApi,
  ImageInput, BashResult, SessionInfo, HeaderPatch, SessionDetail, SessionToolConfig, ModelTestResult,
  SessionModelPrefs,
} from "../../domain/sessions";
import { truncateSessionName, cwdToBucketName, messageContentText, SESSION_MODEL_PREFS_KEY, parseSessionModelPrefs } from "../../domain/sessions";
import {
  updateSessionHeader, listSessions, readSession, readSessionToolConfig, readSessionCustom,
  renameSession as renameSessionFile, copySession as copySessionFile,
  removePath, deleteSessionFiles,
} from "./session-scanner";
import { getProjectStats } from "./project-stats";
import { randomUUID } from "node:crypto";

/**
 * RpcAdapterFactory —— application 拥有的依赖倒置抽象。
 * shell 实现并注入:create({cwd,args}) 返回一个已绑 SubprocessHandle 的 RpcAdapter,
 * 调用方再 .start()。本接口不暴露 spawn 细节(application 不感知子进程)。
 */
export interface RpcAdapterFactory {
  create(opts: { cwd?: string; args?: string[]; env?: Record<string, string>; cliPath?: string }): RpcAdapter;
}

interface SessionProc {
  adapter: RpcAdapter;
  cwd: string;
  boundSessionPath: string | null;
  genStartMs: number | null;
  lastTps: number | null;
  touched: boolean;
  /** 双写时文件未落盘(底座懒建)而降级的模型偏好——该进程首个 messageStart
   *  (文件必已落盘)补写清账(docs/design/session-model-config.md §4.5)。 */
  pendingModelPrefs?: SessionModelPrefs;
}

export class SessionStore implements
  SessionsApi, MessagingApi, ModelApi, SessionTreeApi, SessionMaintenanceApi, QueueModeApi, BashApi, SessionStoreForRestart
{
  /** 会话 → 进程条目。key = sessionPath(历史会话)或 `new:${cwd}`(新会话,未落盘)。 */
  private procs = new Map<string, SessionProc>();
  private warmups = new Map<string, Promise<void>>();
  /** session busy 状态:agentStart/autoRetryStart 设 true、agentSettled/autoRetryEnd(success=false) 设 false(§6.6)。 */
  private busyStates = new Map<string, boolean>();
  private factory: RpcAdapterFactory;
  /** 视图流监听器(onEvent):只收激活会话的事件,渲染层不需关心多进程归属。 */
  private listeners = new Set<(event: SessionEvent) => void>();
  /** 运维流监听器:收全部会话的事件并带 sessionKey(restart-coordinator 等按 key 订阅)。 */
  private keyedListeners = new Set<(event: SessionEvent, sessionKey: string) => void>();
  /** Session Bus 上行帧监听器($bus 帧 + 来源 key;路由器在 bootstrap 订阅)。 */
  private busFrameListeners = new Set<(frame: Record<string, unknown>, sessionKey: string) => void>();
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
  /** 系统 prompt 文件路径列表,spawn 时拉取(由 registry.systemPromptPaths() 注入,
   *  插件贡献的 systemPrompts 槽项;插件卸载 → 贡献移除 → 不注入);空数组不拼 argv。 */
  private getSystemPromptPaths: () => string[];
  /** 自定义底座 cli.js 路径 getter(docs/design/custom-cli-path.md §2.4):
   *  每次 createProc 现读 → 指针变更新进程天然生效;不缓存、不订阅、不感知变更事件。 */
  private getCustomCliPath: () => string | undefined;
  constructor(
    factory: RpcAdapterFactory,
    agentDir: string,
    getSystemPromptPaths?: () => string[],
    getCustomCliPath?: () => string | undefined,
  ) {
    this.factory = factory;
    this.agentDir = agentDir;
    this.getSystemPromptPaths = getSystemPromptPaths ?? (() => []);
    this.getCustomCliPath = getCustomCliPath ?? (() => undefined);
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

  /** path → proc key 寻址(根因修复,勿回退):fork/clone 后底座切到新建的会话文件,
   *  proc 的 boundSessionPath 随对账更新,而 procs 的 key 不动(adapter onEvent 闭包
   *  绑初始 key,移 key 丢事件转发)。按路径找进程必须经 boundSessionPath 解析——
   *  否则 fork 后用户在列表里点新文件,setContext/start 找不到已活进程,会重复
   *  spawn 第二个 pi 写同一 JSONL(两进程交错 append,文件损坏)。 */
  private resolveProcKey(sessionPath: string): string {
    for (const [key, proc] of this.procs) {
      if (proc.boundSessionPath === sessionPath) return key;
    }
    return sessionPath;
  }

  /** 记录发送路径的上下文(cwd + 会话文件,null=新会话)。不动进程,只设激活。
   *  若激活会话 pi 活着 → resync 推基线(切回正在跑的会话拿实时状态);
   *  没活 → 清基线(renderer 走文件读或等 prompt 时起)。 */
  setContext(cwd: string, sessionPath: string | null): void {
    // 回收"未发送过消息的新会话壳"(根因修复,勿回退):
    // pref flush(setModel/setThinkingLevel 走 ensureForSend)会为本 cwd 起一个新会话进程,
    // pi 懒建会话文件——未 prompt 前 boundSessionPath 指向的文件尚不存在,进程是空壳。
    // 此前此处的回收分支查 `new:${cwd}` key,而 ensureForSend 把进程存在生成的会话路径
    // key 下(从不存 new:cwd),分支永不命中 → 每次新对话首发泄漏一个孤儿 pi(实测:一次
    // 发送起两个进程, pref flush 那个永不回收)。改为按重置前的激活 proc 判定:未发送过
    // 消息(touched=false)且活着 → stop+delete;有内容的会话进程不动(多会话并存)。
    const prevKey = this.activeProcKey;
    this.activeCwd = cwd;
    this.activeSessionPath = sessionPath;
    // procs 的 key 用初始 sessionPath 或 new:${cwd}(不随 sessionFile 变;adapter 闭包绑此 key);
    // fork/clone 后路径寻址经 resolveProcKey 解析到已 rebound 的 proc(见该方法注释)
    const key = sessionPath ? this.resolveProcKey(sessionPath) : (cwd ? `new:${cwd}` : "");
    this.activeProcKey = key;
    if (prevKey && prevKey !== key) {
      const prevProc = this.procs.get(prevKey);
      if (prevProc && prevProc.adapter.alive && !prevProc.touched) {
        void prevProc.adapter.stop().then(() => { this.procs.delete(prevKey); });
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

  warmup(cwd: string, sessionPath: string | null): void {
    const key = sessionPath ? this.resolveProcKey(sessionPath) : (cwd ? `new:${cwd}` : "");
    if (!key || this.isAlive(key) || this.warmups.has(key)) return;
    let warmPath = sessionPath;
    if (!warmPath) {
      warmPath = this.generateNewSessionPath(cwd);
      this.activeSessionPath = warmPath;
      this.dispatch(key, { type: "sessionStart", sessionFile: warmPath });
    }
    const warmKey = this.resolveProcKey(warmPath);
    if (this.isAlive(warmKey) || this.warmups.has(warmKey)) return;
    const p = this.start(cwd, warmPath);
    this.warmups.set(warmKey, p);
    p.then(
      () => { this.warmups.delete(warmKey); },
      () => { this.warmups.delete(warmKey); },
    );
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
    // procs 的 key 用初始 sessionPath 或 new:${cwd}(不随 sessionFile 变;adapter 闭包绑此 key);
    // fork/clone 后路径寻址经 resolveProcKey 解析到已 rebound 的 proc(见该方法注释)
    const key = sessionPath ? this.resolveProcKey(sessionPath) : `new:${cwd}`;
    this.activeProcKey = key;
    if (this.isAlive(key)) return; // 已活,不重复起
    const proc = this.createProc(key, cwd, sessionPath ?? null);
    this.procs.set(key, proc);
    await proc.adapter.start();
    await this.waitReady(proc.adapter);
    // 并发护栏(根因修复,勿回退):start 的 await 窗口(spawn+waitReady,tsx dev pi 1~2s)
    // 内可能插入并发 setContext(⌘N/切目录/第二次 sendText 的 startNewChat)把
    // activeProcKey 切走。此后 sync 用 activeProc() 回查会落空抛误导性的"pi 未启动"。
    // 上下文已切则跳过视图同步(进程保留给多会话并存),由调用方(ensureForSend)校验激活态。
    if (this.activeProcKey !== key) return;
    await this.sync();
  }

  /** 创建并装配一个 pi 进程条目:adapter + 全套事件绑定。
   *  start/restart 唯一装配入口——此前 restart 另抄一份丢了 onExtensionUI/onProcessExit,
   *  重启后的会话收不到扩展 UI 请求、进程退出静默(根因:同一逻辑两处拷贝)。 */
  private createProc(key: string, cwd: string, sessionPath: string | null): SessionProc {
    const args = sessionPath ? ["--session", sessionPath] : [];
    for (const p of this.getSystemPromptPaths()) args.push("--append-system-prompt", p);
    const adapter = this.factory.create({ cwd, args, cliPath: this.getCustomCliPath() });
    const proc: SessionProc = { adapter, cwd, boundSessionPath: sessionPath, genStartMs: null, lastTps: null, touched: false };
    adapter.onEvent((event) => this.dispatch(key, translateEvent(event)));
    adapter.onBusFrame((frame) => {
      for (const cb of this.busFrameListeners) {
        try {
          cb(frame, key);
        } catch (err) { console.error("[session-store] bus 帧监听器抛错已隔离:", err); }
      }
    });
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
    const key = sessionPath != null ? this.resolveProcKey(sessionPath) : this.activeKey;
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
    const warming = this.warmups.get(this.activeProcKey);
    if (warming) {
      try {
        await warming;
      } catch {
      }
    }
    if (this.alive) return;
    // 新会话(null):生成新文件路径(~/.pi/agent/sessions/<桶>/<timestamp>_<uuid>.jsonl)
    let sessionPath = this.activeSessionPath ?? undefined;
    if (!sessionPath) {
      sessionPath = this.generateNewSessionPath(this.activeCwd);
      this.activeSessionPath = sessionPath;
      // 生成即水合(根因修复,勿回退):立即推 synthetic sessionStart 让 renderer 写入
      // useUiStore.currentSessionPath。此前水合只在 prompt 发送成功后做,而 pref flush
      // (setModel/setThinkingLevel)先于 prompt 走 ensureForSend 起了进程却没水合 →
      // sendText 仍判 currentSessionPath=null → 二次 startNewChat → setContext(cwd,null)
      // 把 activeProcKey 重置走、prompt 的 ensureForSend 再 spawn 第二个进程(双 spawn,
      // pref flush 那个成孤儿)。水合前置后 sendText 跳过 startNewChat,prompt 复用同一进程。
      this.dispatch(this.activeProcKey, { type: "sessionStart", sessionFile: sessionPath });
    }
    await this.start(this.activeCwd, sessionPath);
    // 并发收尾校验:start 的 await 窗口内若并发 setContext 把 activeSessionPath 换走,
    // 发送目标已失效——给准确错误,而非让后续 activeProc() 落空抛误导性的"pi 未启动"。
    if (this.activeSessionPath !== sessionPath) throw new Error("发送期间会话上下文已切换,请重试");
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
    const detail = await readSession(sessionPath);
    if (detail) await this.nameOnOpenIfMissing(detail);
    return detail;
  }

  /** 打开即补命名:CLI/别的客户端建的会话两轨皆空(无 session_info、无 header.name),
   *  经本入口打开时用首条 user 消息派生名字,双写头行 + session_info(与 prompt 时
   *  自动命名同轨,scanner 以最后一条 session_info 为准)。
   *  仅在该会话无存活 pi 进程时写文件——活着的会话由 prompt 时自动命名(RPC)覆盖,
   *  守住「活跃路径不动文件」的竞态结论(docs/design/session-name-tracks.md §2.2)。
   *  已知缺口(内容层边界):timeline 注入的 [System] 工具限制前缀属插件内容,内核不认,
   *  若首条 user 消息带此前缀,派生名会带上它——与 prompt 时自动命名同款既有取舍。 */
  private async nameOnOpenIfMissing(detail: SessionDetail): Promise<void> {
    if (detail.info.name) return;
    if (this.isAlive(detail.info.path)) return;
    const firstUser = detail.messages.find((m) => m.role === "user");
    const text = firstUser ? messageContentText(firstUser.content) : "";
    if (!text.trim()) return;
    const name = truncateSessionName(text);
    try {
      await renameSessionFile(detail.info.path, name);
      detail.info.name = name;
    } catch (e) {
      console.error("[session-store] 打开补命名失败:", { path: detail.info.path, name, error: e });
    }
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
  async projectStats(cwd: string): Promise<ProjectStats> {
    return getProjectStats(this.agentDir, cwd);
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
    // 底座 auto-retry 退避期 get_state.isStreaming 报 false,以 busyStates 记账为准折算。
    snapshot.state.isStreaming = snapshot.state.isStreaming || this.isBusy(this.activeProcKey);
    this.latestSnapshot = snapshot;
    // sync 回写(设计 §4.4):进程≠头时以进程为真相回写头——底座 CLI /model、
    // cycle 命令、扩展自切等旁路变更,最晚在本次 sync 落盘到头。
    // 方向无条件进程→头:onSend 意图在 renderer 内存 pending,回写物理碰不到。
    if (this.activeSessionPath) {
      const fromState = this.modelPrefsFromState(snapshot.state);
      if (fromState) {
        const fromHeader = parseSessionModelPrefs(readSessionCustom(this.activeSessionPath) ?? undefined);
        const same = fromHeader
          && fromHeader.provider === fromState.provider
          && fromHeader.modelId === fromState.modelId
          && fromHeader.thinkingLevel === fromState.thinkingLevel;
        if (!same) await this.writeModelPrefsToHeader(this.activeSessionPath, fromState);
      }
    }
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
    proc.touched = true; // 已落会话内容:多会话并存保护,不再被 setContext 回收
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

  /** 双写第二半(设计 §4.1):RPC 成功后把全量三字段写进头行 model 域。
   *  patch 失败不阻塞(锁超时/磁盘错误/文件未落盘)——头短暂落后是投影合法态,
   *  文件未落盘时记 proc.pendingModelPrefs 待 messageStart 补写,其余交 sync 回写收敛。 */
  private async writeModelPrefsToHeader(sessionPath: string, prefs: SessionModelPrefs): Promise<void> {
    try {
      await updateSessionHeader(sessionPath, { custom: { [SESSION_MODEL_PREFS_KEY]: prefs } });
    } catch (e) {
      const proc = [...this.procs.values()].find((p) => p.boundSessionPath === sessionPath);
      if (proc) proc.pendingModelPrefs = prefs;
      console.warn("[session-store] 模型偏好写头降级(待补写或 sync 收敛):", e);
    }
  }

  /** 从快照拼全量三字段;凑不齐(进程未就绪边界)返回 null——交给下一次 sync 回写。 */
  private modelPrefsFromState(state: SyncSnapshot["state"]): SessionModelPrefs | null {
    const model = state.model;
    const level = state.thinkingLevel;
    if (!model || !level) return null;
    return { provider: model.provider, modelId: model.id, thinkingLevel: level };
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    // 根因:旧码进程没活就静默 return,冷启动首条消息的 pref flush 被吞,
    // 会话开在 settings.json 默认模型上。对齐 cycleModel:未起则起。
    await this.ensureForSend();
    const proc = this.activeProc();
    if (!proc) throw new Error("pi 未启动");
    await proc.adapter.send(buildSetModelCommand({ provider, modelId }));
    // 双写(设计 §4.1):RPC 拒绝抛错则 patch 不发生——头不会记下从未生效的值;
    // thinkingLevel 用快照现值补齐,守 model 域三字段原子替换(§3.2)。
    const level = this.latestSnapshot?.state.thinkingLevel;
    if (this.activeSessionPath && level) {
      await this.writeModelPrefsToHeader(this.activeSessionPath, { provider, modelId, thinkingLevel: level });
    }
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
      // set_model 是同步 RPC:provider/模型 id 不存在时底座回 success:false,
      // adapter  reject(RpcCommandError)——转成 ModelTestResult 契约,不外抛。
      try {
        await proc.adapter.send(buildSetModelCommand({ provider, modelId }));
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
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
    // 根因同 setModel:进程没活不能静默 return(pref flush 被吞),未起则起。
    await this.ensureForSend();
    const proc = this.activeProc();
    if (!proc) throw new Error("pi 未启动");
    await proc.adapter.send({ type: "set_thinking_level", level: level as never });
    // 双写(设计 §4.1):provider/modelId 用快照现值补齐,守 model 域三字段原子替换(§3.2)。
    const model = this.latestSnapshot?.state.model;
    if (this.activeSessionPath && model) {
      await this.writeModelPrefsToHeader(this.activeSessionPath, { provider: model.provider, modelId: model.id, thinkingLevel: level });
    }
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
    proc.touched = true;
  }

  async followUp(text: string, images?: ImageInput[]): Promise<void> {
    await this.ensureForSend();
    const proc = this.activeProc();
    if (!proc) throw new Error("pi 未启动");
    await proc.adapter.send(buildFollowUpCommand({
      message: text,
      images: images?.map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mimeType })),
    }));
    proc.touched = true;
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

  async fork(entryId: string, position?: "before" | "at"): Promise<void> {
    // 底座命令级失败(如旧底座不认识 position、assistant 锚点撞 "before" 的 role 校验)
    // 由 rpc-adapter reject 抛上来;这里再兜 success:true 但 cancelled 的路径
    // (session_before_fork 扩展拦截)——两种都是失败,不许静默当成功。
    const res = (await this.send(buildForkCommand(entryId, position))) as RpcResponse & {
      data?: { cancelled?: boolean };
    };
    if (res.data?.cancelled) throw new Error("fork 被取消(底座扩展拦截)");
    await this.reconcileAfterSessionReplacement();
  }

  async clone(): Promise<void> {
    await this.send(buildCloneCommand());
    await this.reconcileAfterSessionReplacement();
  }

  /** 从任意会话文件分叉(契约语义=开新会话+预制内容,见 domain SessionTreeApi)。
   *  编排:复制源文件到中间路径(generateNewSessionPath——注入的 agentDir、当前时间戳命名)
   *  → start → fork(内部对账到分叉产物)→ 删中间副本。
   *  失败回滚:恢复先前上下文、停掉跑在中间副本上的 pi、删副本——任何失败路径都不留孤儿。
   *  根因:此前该编排放插件侧(session-bookmarks),中间副本永不清理,
   *  会话桶里每 fork 一次积一个"当年时间"的幽灵会话。 */
  async forkFromSession(cwd: string, srcPath: string, entryId: string, position?: "before" | "at"): Promise<void> {
    const prevPath = this.activeSessionPath;
    const intermediate = this.generateNewSessionPath(cwd);
    copySessionFile(srcPath, intermediate);
    try {
      this.setContext(cwd, intermediate);
      await this.start(cwd, intermediate);
      await this.fork(entryId, position);
      // "at" 语义下 fork 成功必切换到底座新建的分叉产物;未切换=失败(根因:旧码把
      // 未切换当合法跳过——RPC 错误响应被 adapter 当正常值放行时,fork 实际没发生,
      // UI 静默停在中间副本(源会话的逐字节拷贝)上继续聊,中间副本还泄漏成僵尸)。
      // 未切换走 catch 统一回滚,没有"不删"的例外。
      if (this.activeSessionPath === intermediate) {
        throw new Error("fork 未生效:底座未切换到新会话");
      }
      await deleteSessionFiles([intermediate]);
      // 删文件无内核事件,列表里中间副本那行会残留成僵尸(点开文件已不在)——
      // 补播一次 sessionStart 触发重扫;值未变,renderer 水合是幂等 no-op
      const active = this.activeSessionPath;
      if (active) this.dispatch(this.activeProcKey, { type: "sessionStart", sessionFile: active });
    } catch (err) {
      this.setContext(cwd, prevPath);
      await this.stop(intermediate).catch(() => {});
      await deleteSessionFiles([intermediate]).catch(() => {});
      throw err;
    }
  }

  /** fork/clone 后的对账:底座切换会话文件不推事件(session_start 是纯扩展事件,RPC stdout
   *  永不见;fork 响应也不带新路径),框架须主动 sync 拿 get_state.sessionFile 切激活路径,
   *  并推 synthetic sessionStart 水合 renderer——否则 UI 停在 fork 前路径,
   *  prompt 时 sessionStart 还会把过期路径再播一遍(调用方各自 sync 是补丁且修不到路径)。 */
  private async reconcileAfterSessionReplacement(): Promise<void> {
    const snapshot = await this.sync();
    const sf = snapshot.state.sessionFile;
    if (typeof sf !== "string" || !sf || sf === this.activeSessionPath) return;
    this.activeSessionPath = sf;
    const proc = this.activeProc();
    if (proc) proc.boundSessionPath = sf;
    this.dispatch(this.activeProcKey, { type: "sessionStart", sessionFile: sf });
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
    } else if (event.type === "autoRetryStart") {
      this.busyStates.set(key, true);
    } else if (event.type === "autoRetryEnd") {
      // success=true:恢复生成,收尾交 agentSettled;false/取消:重试终结,清算。
      if ((event as { success?: boolean }).success !== true) this.busyStates.set(key, false);
    } else if (event.type === "compactionStart") {
      this.busyStates.set(key, true);
    } else if (event.type === "compactionEnd") {
      this.busyStates.set(key, false);
    }
    if (proc) {
      if (event.type === "messageStart") {
        proc.genStartMs = Date.now();
        // 双写降级账补写(§4.5):底座处理了消息即会话文件必已落盘,
        // 此前因文件未建而降级的模型偏好在此补写清账(幂等,失败仍降级)。
        if (proc.pendingModelPrefs && proc.boundSessionPath) {
          const prefs = proc.pendingModelPrefs;
          const path = proc.boundSessionPath;
          proc.pendingModelPrefs = undefined;
          void this.writeModelPrefsToHeader(path, prefs);
        }
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

  // ============ Session Bus 支撑(路由器经此面驱动任意会话,不涉及激活语义) ============

  /** 全会话事件订阅(带来源 key;keyedListeners 的通用暴露——总线路由器的进线)。 */
  onAnySessionEvent(cb: (event: SessionEvent, sessionKey: string) => void): () => void {
    this.keyedListeners.add(cb);
    return () => { this.keyedListeners.delete(cb); };
  }

  /** $bus 上行帧订阅(createProc 已为每条 adapter 绑好转发)。 */
  onBusFrame(cb: (frame: Record<string, unknown>, sessionKey: string) => void): () => void {
    this.busFrameListeners.add(cb);
    return () => { this.busFrameListeners.delete(cb); };
  }

  /** 按 key 取 adapter(进程不在返回 undefined)。 */
  getAdapter(sessionKey: string): RpcAdapter | undefined {
    return this.procs.get(sessionKey)?.adapter;
  }

  /** 总线 spawn:起一个不抢激活语义的会话进程(key=bus:<uuid8>,全新会话文件)。 */
  async spawnSession(cwd: string): Promise<{ key: string; sessionPath: string }> {
    const key = `bus:${randomUUID().slice(0, 8)}`;
    const sessionPath = this.generateNewSessionPath(cwd);
    const proc = this.createProc(key, cwd, sessionPath);
    this.procs.set(key, proc);
    await proc.adapter.start();
    await this.waitReady(proc.adapter);
    return { key, sessionPath };
  }

  /** 往指定会话注入一条 prompt(streamingBehavior 由调用方按帧型分派:响应=steer,事件=followUp)。 */
  async sendPromptTo(sessionKey: string, text: string, streamingBehavior?: "steer" | "followUp"): Promise<void> {
    const proc = this.procs.get(sessionKey);
    if (!proc || !proc.adapter.alive) throw new Error(`会话不在线: ${sessionKey}`);
    await proc.adapter.send(buildPromptCommand({ message: text, streamingBehavior }));
    proc.touched = true;
  }

  /** 按 key 取最后一条 assistant 文本(完成采集主源;进程不在返回空串,调用方回退读文件)。 */
  async getLastAssistantTextFor(sessionKey: string): Promise<string> {
    const proc = this.procs.get(sessionKey);
    if (!proc || !proc.adapter.alive) return "";
    // 底座命令级失败(adapter reject)同样回退空串——本方法是采集主源,读文件兜底在调用方
    const res = (await proc.adapter.send(buildGetLastAssistantTextCommand()).catch(() => null)) as (RpcResponse & {
      data?: { text?: string } | string;
    }) | null;
    if (!res) return "";
    if (typeof res.data === "string") return res.data;
    return (res.data as { text?: string } | undefined)?.text ?? "";
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
