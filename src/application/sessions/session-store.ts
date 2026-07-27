// 会话存储 —— application 层:会话状态投影 owner + pi 进程生命周期(按需)。
//
// 进程模型(用户拍板):会话是文件,进程是按需的临时工。
// - 看会话 = 读文件(session-scanner.readSession),不启 pi
// - 发消息 = 按需起进程:ensureForSend 保证"绑定当前会话的 pi"在跑,
//   绑错会话 → 停旧起新(spawn --session <path>,底座从文件续上下文)
// - 没有 switch_session:切换历史会话纯文件读,零 RPC、零进程
// - pi 启动/关闭不阻塞展示:进程动作全在发送路径上
// application 依赖 gateway + domain,不依赖 shell;cwd/sessionPath 由调用方注入。
import type { RpcAdapter } from "../../gateway/rpc-adapter";
import { RpcAdapter as RpcAdapterClass } from "../../gateway/rpc-adapter";
import { translateEvent } from "../../gateway/event-translator";
import { resync } from "../orchestrations/resync";
import { buildPromptCommand, buildSetModelCommand } from "../../gateway/protocol/commands";
import { toModelInfo } from "../../gateway/context-binding";
import type { RpcCommand, RpcResponse, Model } from "../../gateway/protocol/rpc-types";
import type { SessionEvent, SyncSnapshot, ModelInfo } from "../../domain/events/session-state";
import type { SessionsApi, ImageInput } from "../../domain/sessions";

export class SessionStore implements SessionsApi {
  private adapter: RpcAdapter | null = null;
  private listeners = new Set<(event: SessionEvent) => void>();
  private snapshotListeners = new Set<(snapshot: SyncSnapshot) => void>();
  /** 最近一次 sync 的投影基线(renderer 增量应用的起点)。 */
  latestSnapshot: SyncSnapshot | null = null;

  /** 当前上下文(发送路径的绑定目标;setContext 只记,不动进程)。 */
  private activeCwd: string | null = null;
  private activeSessionPath: string | null = null;
  /** 当前进程启动时绑的 --session(空 = 全新会话进程)。 */
  private boundSessionPath: string | null = null;

  get alive(): boolean {
    return this.adapter?.alive ?? false;
  }

  /** 记录发送路径的上下文(cwd + 会话文件,null=新会话)。不动进程。 */
  setContext(cwd: string, sessionPath: string | null): void {
    this.activeCwd = cwd;
    this.activeSessionPath = sessionPath;
  }

  /** 启动 pi(按需;sessionPath 给定时 spawn --session 续上下文)。完成后 sync 广播。 */
  async start(cwd: string, sessionPath?: string): Promise<void> {
    if (this.adapter?.alive) await this.stop();
    const adapter = new RpcAdapterClass({
      cwd,
      args: sessionPath ? ["--session", sessionPath] : [],
    });
    adapter.onEvent((event) => this.dispatch(translateEvent(event)));
    this.adapter = adapter;
    this.activeCwd = cwd;
    this.boundSessionPath = sessionPath ?? null;
    await adapter.start();
    await this.waitReady();
    await this.sync();
  }

  async stop(): Promise<void> {
    if (!this.adapter) return;
    await this.adapter.stop();
    this.adapter = null;
    this.boundSessionPath = null;
    this.latestSnapshot = null;
  }

  /**
   * 发送前的进程保证:绑定当前上下文的 pi 在跑。
   * 没起 → 起;起过但绑的会话不同 → 停旧起新(进程随会话激活,不做 switch_session)。
   */
  private async ensureForSend(): Promise<void> {
    if (!this.activeCwd) throw new Error("未选择工作目录");
    if (this.alive && this.boundSessionPath === this.activeSessionPath) return;
    await this.start(this.activeCwd, this.activeSessionPath ?? undefined);
  }

  /** pi 就绪实证:get_state 轮询(150ms 间隔,~4s 预算),首个成功即返回。 */
  private async waitReady(): Promise<void> {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      try {
        await this.send({ type: "get_state" });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    // 超时也继续:让后续 sync 的真实错误冒出去,不在此掩盖
  }

  /** resync 一次并广播新基线。start 后与显式刷新走这里。 */
  async sync(): Promise<SyncSnapshot> {
    if (!this.alive) throw new Error("pi 未启动");
    const snapshot = await resync(this.adapter!);
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

  /** 发消息(唯一会起进程的入口:ensureForSend 后才发)。 */
  async prompt(text: string, images?: ImageInput[]): Promise<void> {
    await this.ensureForSend();
    await this.send(buildPromptCommand({
      message: text,
      images: images?.map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mimeType })),
    }));
  }

  async abort(): Promise<void> {
    if (!this.alive) return;
    await this.send({ type: "abort" });
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

  /** 原样发 RPC 命令(壳内高级用途;插件不暴露,插件走意图方法)。 */
  async send(command: RpcCommand): Promise<unknown> {
    if (!this.adapter || !this.adapter.alive) throw new Error("pi 未启动");
    return this.adapter.send(command);
  }

  private dispatch(event: SessionEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(event);
      } catch (err) {
        console.error("[session-store] 事件监听器抛错已隔离:", err);
      }
    }
  }
}
