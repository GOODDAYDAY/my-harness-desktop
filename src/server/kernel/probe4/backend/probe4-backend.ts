// probe4 后端 —— BaseBackend 的 probe4 实现:spawn 独立内核 CLI + JSONL 协议通信。
//
// 依据 docs/design/minimal-kernel.md §4 / §7。与 PiBackend / DshBackend 平行:PiBackend
// 持 RpcAdapter、DshBackend 持 JsonRpcTransport,probe4 持 Probe4Transport。CLI 是独立
// .mjs(零壳依赖),会话文件格式是 doc §3.3 的第二份实现(内核本体一份、适配器一份,靠文档
// 契约单源)。本后端只做「协议翻译」:命令出、事件进,不再直接读写会话文件(除预 seed)。

import type { Anchor, BoundaryRef, LineageTree, SeedOptions } from "@my-harness-desktop/shared";
import type { SessionEvent, NeutralMessage, NeutralEntry, ImageInput, KnownToolInfo, SessionToolConfig, ProcessExitInfo } from "@my-harness-desktop/shared";
import { AbstractBackend, type BackendContext } from "../../core/abstract-backend";
import { Probe4Transport, type Probe4Event } from "./probe4-transport";
import { probe4SeedSession, probe4EntryToNeutral, toolSetFromConfig } from "./probe4-catalog";

/** probe4 后端的文件上下文(cwd + 会话根,由 bootstrap 注入)。 */
export interface Probe4BackendContext extends BackendContext {
  /** probe4 会话根目录。 */
  agentDir: string;
  /** 模型偏好(spawn 时定,后续 setModel 改)。 */
  provider?: string;
  model?: string;
}

/** CLI 产出、需要透传给壳的中性 SessionEvent 类型(其余 pong/tree/entries/seeded/... 是协议响应,过滤掉)。 */
const SESSION_EVENT_TYPES = new Set([
  "agentStart", "agentEnd", "agentSettled",
  "messageStart", "messageUpdate", "messageEnd",
  "entryAppended", "sessionStart", "modelSelect",
  "compactionStart", "compactionEnd", "queueUpdate",
  "autoRetryStart", "autoRetryEnd", "stepStart", "stepEnd",
  "sessionInfoChanged", "thinkingLevelChanged", "thinkingLevelSelect",
  "toolCallStart", "toolCallUpdate", "toolCallEnd",
]);

/**
 * probe4 后端:把 CLI 子进程 + JSONL 协议收编成一个 BaseBackend 实现。
 * 命令出(transport.send)、事件进(transport.onEvent 过滤出 SessionEvent 透传)。
 */
export class Probe4Backend extends AbstractBackend<Probe4BackendContext> {
  private model = { provider: this.ctx.provider ?? "probe4", modelId: this.ctx.model ?? "echo" };

  constructor(
    private readonly transport: Probe4Transport,
    ctx: Probe4BackendContext,
  ) {
    super(ctx);
  }

  /** 内核身份:probe4 后端固定 "probe4"。 */
  readonly kernel = "probe4" as const;

  /** fileBacked=true:probe4 会话是壳要跟踪的文件(线性 JSONL,§3),boundSessionPath 指向它。
   *  不声明 pi 面(无 pi 扩展),避免 capabilities.extensions 被壳误当「文件态」代理(§probe4-kernel)。 */
  override readonly capabilities = { fileBacked: true };

  get alive(): boolean {
    return this.transport.alive;
  }

  async start(): Promise<void> {
    this.transport.start();
    // 就绪探测(§4.1.2):一条 ping,以 pong 为准,不赌固定 sleep。
    await this.transport.request({ type: "ping" }, "pong");
  }

  async stop(): Promise<void> {
    await this.transport.stop();
  }

  /** 订阅中性事件流:CLI 事件本就是中性形状,过滤掉协议响应后直接透传。 */
  onEvent(cb: (event: SessionEvent) => void): () => void {
    return this.transport.onEvent((e: Probe4Event) => {
      if (SESSION_EVENT_TYPES.has(e.type)) cb(e as unknown as SessionEvent);
    });
  }

  async sendMessage(text: string, _images?: ImageInput[]): Promise<void> {
    if (!this.transport.alive) throw new Error("probe4 内核未启动");
    this.transport.send({ type: "send", text });
  }

  async abort(): Promise<void> {
    this.transport.send({ type: "abort" });
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    this.model = { provider, modelId };
    this.transport.send({ type: "setModel", provider, modelId });
  }

  async setSessionName(name: string): Promise<void> {
    this.transport.send({ type: "setSessionName", name });
  }

  async getTree(_sessionId: string): Promise<LineageTree> {
    const resp = await this.transport.request<Probe4Event & { tree: LineageTree }>({ type: "getTree" }, "tree");
    return resp.tree;
  }

  async getEntries(_lineageId: string): Promise<NeutralMessage[]> {
    const resp = await this.transport.request<Probe4Event & { entries: unknown[] }>({ type: "getEntries" }, "entries");
    return resp.entries.flatMap((e) => { const m = probe4EntryToNeutral(e); return m ? [m] : []; });
  }

  /** 工具清单(§5.6):经协议问 CLI 拿活跃工具清单,投成 KnownToolInfo(去 probe4 私有的 grade)。 */
  async listTools(): Promise<KnownToolInfo[] | null> {
    const resp = await this.transport.request<Probe4Event & { tools: { name: string; description: string; source: string }[] }>({ type: "listTools" }, "tools");
    return resp.tools.map((t) => ({ name: t.name, description: t.description, source: "builtin" }));
  }

  /** 切工具集(§5.6.1 补面):把壳下发的工具集语义热应用到 CLI 的活跃会话。 */
  /** 切工具集(§5.6.1 补面):把壳下发的 SessionToolConfig 翻译成 probe4 工具集并热应用。 */
  async setTools(config: SessionToolConfig): Promise<void> {
    this.transport.send({ type: "setTools", tools: toolSetFromConfig(config) });
  }

  /** 崩溃收尾(§4.6.3 壳的机制):注册进程退出回调,壳经此广播 processExit。 */
  onProcessExit(cb: (exit: ProcessExitInfo, expected: boolean, stderr: string) => void): void {
    this.transport.onExit = cb;
  }

  async bookmark(lineageId: string, boundary: BoundaryRef): Promise<Anchor> {
    return { lineageId, entryId: boundary };
  }

  async deleteBookmark(_anchor: Anchor): Promise<void> {
    // no-op(bookmark 只存坐标,§3.4.3)。
  }

  /** 预 seed 已在 factory.seed 完成(probe4 是文件态、预 seed);此方法为 post-seed 兜底
   *  (probe4 正常流不走到这,switchKernel 走 factory.seed 的预 seed 分支)。 */
  async seed(lineage: NeutralEntry[], opts: SeedOptions): Promise<string> {
    return probe4SeedSession(this.ctx.agentDir, this.ctx.cwd, lineage, opts);
  }
}
