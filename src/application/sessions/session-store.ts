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
} from "../../gateway/protocol/commands";
import { toModelInfo, toSessionStats } from "../../gateway/context-binding";
import type { RpcCommand, RpcResponse, Model } from "../../gateway/protocol/rpc-types";
import type { SessionEvent, SyncSnapshot, ModelInfo, SessionStats, NeutralMessage } from "../../domain/events/session-state";
import { isVisibleMessage, deduplicateAdjacent } from "../../domain/events/session-state";
import type { KernelEvent, ExtensionUIResponse } from "../../domain/events/kernel-event";
import type {
  SessionsApi, MessagingApi, ModelApi, SessionTreeApi, SessionMaintenanceApi, QueueModeApi, BashApi,
  ImageInput, BashResult,
} from "../../domain/sessions";
import { cwdToBucketName, updateSessionHeader } from "./session-scanner";
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
  SessionsApi, MessagingApi, ModelApi, SessionTreeApi, SessionMaintenanceApi, QueueModeApi, BashApi
{
  /** 会话 → 进程条目。key = sessionPath(历史会话)或 `new:${cwd}`(新会话,未落盘)。 */
  private procs = new Map<string, SessionProc>();
  private factory: RpcAdapterFactory;
  private listeners = new Set<(event: SessionEvent) => void>();
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
  constructor(factory: RpcAdapterFactory) {
    this.factory = factory;
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
    const adapter = this.factory.create({
      cwd,
      args: sessionPath ? ["--session", sessionPath] : [],
    });
    const proc: SessionProc = { adapter, cwd, boundSessionPath: sessionPath ?? null, genStartMs: null, lastTps: null };
    adapter.onEvent((event) => this.dispatch(key, translateEvent(event)));
    adapter.onExtensionUI((req) => {
      this.dispatchKernel(key, {
        source: "pi", kind: "extensionUI",
        requestId: req.id, method: req.method, ...req,
      });
      for (const cb of this.extUiListeners) {
        try { cb(req); } catch (err) { console.error("[session-store] Extension UI 监听器抛错已隔离:", err); }
      }
    });
    adapter.onProcessExit = (exit, expected) => {
      this.dispatchKernel(key, {
        source: "desktop", kind: "processExit",
        code: exit.code, signal: exit.signal, expected,
        stderr: adapter.stderr.slice(-500), sessionKey: key,
      });
    };
    this.procs.set(key, proc);
    await adapter.start();
    await this.waitReady(adapter);
    await this.sync();
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
    const sessionsRoot = `${process.env["HOME"] ?? ""}/.pi/agent/sessions`;
    const bucket = cwdToBucketName(cwd);
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const uuid = randomUUID();
    return `${sessionsRoot}/${bucket}/${ts}_${uuid}.jsonl`;
  }

  /** pi 就绪实证:get_state 轮询(150ms 间隔,~4s 预算),首个成功即返回。 */
  private async waitReady(adapter: RpcAdapter): Promise<void> {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      try {
        await adapter.send({ type: "get_state" });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 150));
      }
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
    const wasNewSession = this.activeSessionPath === null;
    await this.ensureForSend();
    const proc = this.activeProc();
    if (!proc) throw new Error("pi 未启动");
    if (wasNewSession && this.activeSessionPath) {
      const autoName = text.slice(0, 20).trim();
      if (autoName) {
        try {
          await updateSessionHeader(this.activeSessionPath, { name: autoName });
          if (this.latestSnapshot) this.latestSnapshot.state.sessionName = autoName;
        } catch {}
      }
    }
    await proc.adapter.send(buildPromptCommand({
      message: text,
      images: images?.map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mimeType })),
    }));
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
    await this.send(buildSetModelCommand({ provider, modelId }));
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
    await this.send({ type: "set_thinking_level", level: level as never });
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
    await this.send(buildCycleModelCommand());
  }

  async cycleThinkingLevel(): Promise<void> {
    await this.send(buildCycleThinkingLevelCommand());
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
      const reason = message.includes("超时") ? "timeout" : "sendError";
      this.dispatchKernel(key, { source: "desktop", kind: "rpcError", reason, message, sessionKey: key });
      throw err;
    }
  }

  /** 事件路由:流式增量只转发激活会话;定稿/轮结束/新文件事件全转发(列表刷新需要)。
   *  TPS 自算:messageStart 记时,messageEnd 用 output tokens / 耗时算 tps(底座不给 TPS)。 */
  private dispatch(key: string, event: SessionEvent): void {
    if (event.type === "sessionStart" && key.startsWith("new:")) {
      const sf = event.sessionFile;
      if (typeof sf === "string" && sf) {
        const proc = this.procs.get(key);
        if (proc) {
          proc.boundSessionPath = sf;
          this.activeSessionPath = sf;
        }
      }
    }
    const isLifecycleEvent =
      event.type === "messageEnd" ||
      event.type === "agentSettled" ||
      event.type === "agentEnd" ||
      event.type === "sessionStart";
    if (!isLifecycleEvent && key !== this.activeProcKey) return;
    const proc = this.procs.get(key);
    if (!proc) return;
    if (event.type === "messageStart") {
      proc.genStartMs = Date.now();
    } else if (event.type === "messageEnd" && proc.genStartMs != null) {
      const elapsed = (Date.now() - proc.genStartMs) / 1000;
      const out = extractOutputTokens(event.message);
      proc.lastTps = elapsed > 0 && out > 0 ? out / elapsed : null;
      proc.genStartMs = null;
    }
    this.dispatchKernel(key, { source: "pi", kind: "session", event });
    for (const cb of this.listeners) {
      try { cb(event); } catch (err) { console.error("[session-store] 事件监听器抛错已隔离:", err); }
    }
  }

  private dispatchKernel(_key: string, event: KernelEvent): void {
    for (const cb of this.kernelListeners) {
      try { cb(event); } catch (err) { console.error("[session-store] kernel event 监听器抛错已隔离:", err); }
    }
  }
}

/** 从 messageEnd.message 多路径提 output tokens(底座字段形状未文档化,防御性提取)。 */
function extractOutputTokens(message: NeutralMessage | undefined): number {
  if (!message || typeof message !== "object") return 0;
  const m = message as Record<string, unknown>;
  const usage = (m.usage ?? m.tokenUsage ?? m.tokens) as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== "object") return 0;
  for (const k of ["outputTokens", "output", "output_tokens", "completionTokens"]) {
    if (typeof usage[k] === "number") return usage[k] as number;
  }
  return 0;
}
