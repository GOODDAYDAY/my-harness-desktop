// 会话存储 —— application 层:会话状态投影的唯一 owner(核心 = 会话管理 + pi 交互)。
//
// 投影模型(长期收益,替代"组件各自拉快照"的聊天模型):
// - resync 只在 start/switch/new 后做一次,结果存 latestSnapshot 并广播给订阅方
// - 之后的事件流(RpcAdapter → 翻译 → 分发)维持投影鲜活;renderer 侧投影 store
//   应用增量,任何组件不再各自 getSnapshot
// - waitReady:pi 就绪靠 get_state 轮询实证,不用固定 sleep(冷启动立省 ~600ms)
// application 依赖 gateway + domain,不依赖 shell;cwd 等由调用方(main)注入。
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

  get alive(): boolean {
    return this.adapter?.alive ?? false;
  }

  /** 启动/重启 pi(切 cwd 也是调它:停旧起新)。完成后自动 sync 广播。 */
  async start(cwd: string): Promise<void> {
    if (this.adapter?.alive) await this.stop();
    const adapter = new RpcAdapterClass({ cwd });
    adapter.onEvent((event) => this.dispatch(translateEvent(event)));
    this.adapter = adapter;
    await adapter.start();
    await this.waitReady();
    await this.sync();
  }

  async stop(): Promise<void> {
    if (!this.adapter) return;
    await this.adapter.stop();
    this.adapter = null;
    this.latestSnapshot = null;
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

  /** resync 一次并广播新基线。所有"切换型"动作完成后统一走这里。 */
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

  /** 订阅新基线快照(start/switch/new 后每次广播一次)。 */
  onSnapshot(cb: (snapshot: SyncSnapshot) => void): () => void {
    this.snapshotListeners.add(cb);
    return () => this.snapshotListeners.delete(cb);
  }

  /** 兼容旧契约:直接读当前基线(无基线时现拉一次)。 */
  async getSnapshot(): Promise<SyncSnapshot> {
    if (this.latestSnapshot) return this.latestSnapshot;
    return this.sync();
  }

  onEvent(cb: (event: SessionEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async newSession(): Promise<void> {
    await this.send({ type: "new_session" });
    await this.sync();
  }

  async switchSession(sessionPath: string): Promise<void> {
    await this.send({ type: "switch_session", sessionPath });
    await this.sync();
  }

  async prompt(text: string, images?: ImageInput[]): Promise<void> {
    await this.send(buildPromptCommand({
      message: text,
      images: images?.map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mimeType })),
    }));
  }

  async abort(): Promise<void> {
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
