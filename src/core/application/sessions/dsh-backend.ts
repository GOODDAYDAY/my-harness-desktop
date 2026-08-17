// dsh 后端 —— BaseBackend 的 dsh 实现:spawn dsh 子进程 + JSON-RPC + 事件翻译。
//
// 依据 docs/design/base-interface-lineage.md §3.2。dsh 的会话是扁平 append-only 事件流,
// fork 是 ctx.sessions.fork(自带前缀拷贝),会话树是 session forest(父会话 + 子会话)。
// 本后端把这些投影到 BaseBackend 中性契约上。
//
// 传输层:client/dsh/json-rpc(JSON-RPC 2.0 行传输);协议面:dsh sdk-jsonrpc-server
// 的方法集(initialize/session/prompt/session/fork/...)。事件翻译(dsh SessionEvent →
// 中性 SessionEvent)是独立一块,映射表见 §4.3,本轮只接线、翻译函数留 TODO。

import type { JsonRpcTransport } from "../../../client/dsh/json-rpc";
import type { BaseBackend, Anchor, BoundaryRef, LineageTree } from "../../domain/backend";
import type { SessionEvent, NeutralMessage } from "../../domain/events/session-state";
import { translateDshEvent } from "./dsh-event-translator";

/** dsh 后端的会话级配置(initialize 握手参数)。 */
export interface DshBackendConfig {
  cwd: string;
  provider: string;
  model: string;
  maxTokens?: number;
}

/** dsh 后端:JSON-RPC 传输 + BaseBackend 五操作投影。 */
export class DshBackend implements BaseBackend {
  private sessionId = "";

  constructor(
    private readonly transport: JsonRpcTransport,
    private readonly config: DshBackendConfig,
  ) {}

  get alive(): boolean {
    return this.transport.alive;
  }

  /** 起传输 + initialize 握手(sessionId 由服务端在首个 prompt 时惰性创建)。 */
  async start(): Promise<void> {
    this.transport.start();
    await this.transport.request("initialize", {
      cwd: this.config.cwd,
      provider: this.config.provider,
      model: this.config.model,
      maxTokens: this.config.maxTokens,
    });
  }

  async stop(): Promise<void> {
    await this.transport.stop();
  }

  /** 订阅中性事件流:session.event 通知 → 翻译成中性(§4.3)。 */
  onEvent(cb: (event: SessionEvent) => void): () => void {
    return this.transport.onNotification((method, params) => {
      if (method !== "session.event") return;
      const p = params as { sessionId?: string; event?: unknown };
      const translated = translateDshEvent(p.event);
      if (translated) cb(translated);
    });
  }

  async sendMessage(text: string): Promise<void> {
    await this.transport.request("session/prompt", {
      sessionId: this.sessionId,
      contentBlocks: [{ type: "text", text }],
    });
  }

  async abort(): Promise<void> {
    await this.transport.request("session/abort", { sessionId: this.sessionId });
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    await this.transport.request("session/setModel", { sessionId: this.sessionId, provider, modelId });
  }

  /** fork:dsh 的 fork 自带前缀拷贝,子会话 id 即新 lineage id。 */
  async fork(parentLineageId: string, boundary?: BoundaryRef): Promise<string> {
    const res = await this.transport.request<{ lineageId: string }>("session/fork", {
      parentSessionId: parentLineageId,
      boundarySeq: boundary === undefined ? undefined : Number(boundary),
    });
    return res.lineageId;
  }

  async getTree(sessionId: string): Promise<LineageTree> {
    return this.transport.request<LineageTree>("session/getTree", { sessionId });
  }

  async getEntries(lineageId: string): Promise<NeutralMessage[]> {
    return this.transport.request<NeutralMessage[]>("session/getEntries", { lineageId });
  }

  async bookmark(lineageId: string, boundary: BoundaryRef): Promise<Anchor> {
    return this.transport.request<Anchor>("session/bookmark", {
      lineageId,
      boundarySeq: Number(boundary),
    });
  }

  async resume(anchor: Anchor): Promise<string> {
    const res = await this.transport.request<{ lineageId: string }>("session/resume", { anchor });
    return res.lineageId;
  }
}
