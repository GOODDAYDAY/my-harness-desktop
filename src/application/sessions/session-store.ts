// 会话存储 —— application 层用例编排:pi 子进程生命周期 + 事件分发 + 意图命令出口。
//
// 核心(会话管理 + pi 交互)的落点:
// - RpcAdapter 全局单持(gateway 实例只此一处),插件/壳不再各自 start/send
// - pi 事件 → 中性 SessionEvent 翻译后统一分发(插件经 PluginContext.sessions.onEvent 收)
// - 插件看到的意图(prompt/newSession/...)→ RpcCommand 字面量的翻译在此,
//   圆心/插件不感知 pi 协议
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

  get alive(): boolean {
    return this.adapter?.alive ?? false;
  }

  /** 启动/重启 pi(切 cwd 也是调它:停旧起新)。已 alive 时先停。 */
  async start(cwd: string): Promise<void> {
    if (this.adapter?.alive) await this.stop();
    const adapter = new RpcAdapterClass({ cwd });
    adapter.onEvent((event) => this.dispatch(translateEvent(event)));
    this.adapter = adapter;
    await adapter.start();
  }

  async stop(): Promise<void> {
    if (!this.adapter) return;
    await this.adapter.stop();
    this.adapter = null;
  }

  /** resync 拿全量快照。pi 未启动时 reject(调用方决定先 start 或显示空态)。 */
  async getSnapshot(): Promise<SyncSnapshot> {
    if (!this.alive) throw new Error("pi 未启动");
    return resync(this.adapter!);
  }

  onEvent(cb: (event: SessionEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** 列会话文件走 session-scanner(fs 读,不经 pi),main 直接调 scanner,不在此包。 */

  async newSession(): Promise<void> {
    await this.send({ type: "new_session" });
  }

  async switchSession(sessionPath: string): Promise<void> {
    await this.send({ type: "switch_session", sessionPath });
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
    // 防御:底座可能返回 {levels:[...]} 或直接数组
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
