// dsh 后端 —— BaseBackend 的 dsh 实现:spawn dsh 子进程 + JSON-RPC + 事件翻译。
//
// 依据 docs/design/base-interface-lineage.md §3.2。dsh 的会话是扁平 append-only 事件流,
// fork 是 ctx.sessions.fork(自带前缀拷贝),会话树是 session forest(父会话 + 子会话)。
// 本后端把这些投影到 BaseBackend 中性契约上。
//
// 传输层:client/dsh/json-rpc(JSON-RPC 2.0 行传输);协议面:dsh sdk-jsonrpc-server
// 的方法集(initialize/session/prompt/session/fork/...)。事件翻译(dsh SessionEvent →
// 中性 SessionEvent)是独立一块,映射表见 §4.3,本轮只接线、翻译函数留 TODO。

import { rmSync } from "node:fs";
import type { JsonRpcTransport } from "./json-rpc";
import type { Anchor, BoundaryRef, LineageTree } from "../../core/domain/backend";
import { AbstractBackend, type BackendContext } from "../backend/abstract-backend";
import type { SessionEvent, NeutralMessage } from "../../core/domain/events/session-state";
import type { NeutralSession } from "../../core/domain/session-neutral";
import { cwdToBucketName, type ImageInput } from "../../core/domain/sessions";
import { translateDshEvent } from "./dsh-event-translator";

/** dsh 后端的会话级配置(initialize 握手参数)。cwd/sessionId 来自中性 BackendContext,
 *  provider/model/maxTokens/tempDir 是 dsh 专属的 initialize/清理字段。 */
export interface DshBackendConfig extends BackendContext {
  /** dsh 侧模型 provider(initialize 握手)。 */
  provider: string;
  /** dsh 侧模型(initialize 握手)。 */
  model: string;
  /** 输出 token 上限(initialize 握手)。 */
  maxTokens?: number;
  /** 临时会话目录(ephemeral 时由工厂创建;stop 时连同子进程一起清理)。 */
  tempDir?: string;
}

/** dsh 后端:JSON-RPC 传输 + BaseBackend 五操作投影。 */
export class DshBackend extends AbstractBackend<DshBackendConfig> {
  private sessionId: string;

  constructor(
    private readonly transport: JsonRpcTransport,
    config: DshBackendConfig,
  ) {
    super(config);
    this.sessionId = config.sessionId ?? cwdToBucketName(config.cwd);
  }

  /** 内核身份(§kernel-layer 圆心契约):dsh 后端固定 "dsh"。 */
  readonly kernel = "dsh" as const;

  get alive(): boolean {
    return this.transport.alive;
  }

  /** 起传输 + initialize 握手(sessionId 由服务端在首个 prompt 时惰性创建)。
   *  握手带重试:settings-file 插件的 settings.yaml 是异步 init(读文件+监听),initialize 可能
   *  赶上它尚未完成 → 返回 "no adapter registered"(瞬时)。短延迟重试等 settings 就绪,上限 10s;
   *  非该瞬时错误(真没配该 provider/其他错)立即外抛,不空等。 */
  async start(): Promise<void> {
    this.transport.start();
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        await this.transport.request("initialize", {
          cwd: this.ctx.cwd,
          provider: this.ctx.provider,
          model: this.ctx.model,
          maxTokens: this.ctx.maxTokens,
        });
        return;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!msg.includes("no adapter registered") || Date.now() >= deadline) throw e;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  }

  async stop(): Promise<void> {
    await this.transport.stop();
    if (this.ctx.tempDir) {
      try { rmSync(this.ctx.tempDir, { recursive: true, force: true }); } catch { /* 临时目录清理失败不致命 */ }
    }
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

  async sendMessage(text: string, images?: ImageInput[]): Promise<void> {
    await this.transport.request("session/prompt", {
      sessionId: this.sessionId,
      contentBlocks: [{ type: "text", text }],
      ...(images && images.length > 0
        ? { images: images.map(i => ({ data: i.data, mediaType: i.mimeType, ...(i.name ? { name: i.name } : {}) })) }
        : {}),
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

  async bookmark(lineageId: string, entryId: string): Promise<Anchor> {
    await this.transport.request("session/bookmark", {
      lineageId,
      boundarySeq: Number(entryId),
    });
    // 去 opaque:只回中立坐标,子会话定位线索由 dsh 服务端从坐标找回
    return { lineageId, entryId };
  }

  async resume(anchor: Anchor): Promise<string> {
    const res = await this.transport.request<{ lineageId: string }>("session/resume", { anchor });
    return res.lineageId;
  }

  /** 删除书签:坐标书签无副本要回收,dsh 侧 deleteBookmark 是 no-op。 */
  async deleteBookmark(anchor: Anchor): Promise<void> {
    await this.transport.request("session/deleteBookmark", { anchor });
  }

  /** seed:从中立会话树反向投影到 dsh(session/seed,deepseek-harness 侧已补)。
   *  NeutralSession 的 JSON 形状与 wire(NeutralSessionWire)一致,直接传。 */
  async seed(session: NeutralSession): Promise<string> {
    const res = await this.transport.request<{ sessionId: string }>("session/seed", {
      sessionId: session.neutralSessionId,
      session,
    });
    return res.sessionId;
  }
}
