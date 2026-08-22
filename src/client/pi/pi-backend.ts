// pi 后端 —— BaseBackend 的 pi 实现:收编 client/pi 传输 + resync 基线 + pi 命令构造 + 会话文件编排。
//
// 依据 docs/design/base-interface-lineage.md §3.1。pi 的协议(JSONL 31 命令)、会话文件、
// parentId 树,全部收编在本后端内部;对外只暴露 BaseBackend 中性操作。
//
// 分工:本类做「文件级」编排(bookmark 拷贝 / resume 物化 / getTree 树读——委托 pi-catalog)
// 与「进程级」原语(RPC 命令、getEntries 走 resync 基线);进程生命周期(start/stop/多进程调度)
// 仍归 SessionStore。resume 只物化锚点为新会话文件、返回其路径——「在该文件上 fork 到 boundary」
// 由调用方编排(start 后 fork),因为 fork 需要跑起来的 pi 进程,那一步归进程调度层。

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RpcAdapter } from "./rpc-adapter";
import type { ProcessExit } from "./subprocess-handle";
import type { Anchor, BoundaryRef, LineageTree, PiCapabilities } from "../../core/domain/backend";
import { AbstractBackend, type BackendContext } from "../backend/abstract-backend";
import { resync } from "../../core/application/orchestrations/resync";
import { piReadSessionTree, piReadSessionEntries, piNewSessionPath } from "./pi-catalog";
import { copyFileWithDir } from "../fs/fs-sync";
import { readKnownTools } from "./known-tools";
import { cwdToBucketName, type ImageInput, type KnownToolInfo } from "../../core/domain/sessions";
import {
  buildPromptCommand,
  buildAbortCommand,
  buildSetModelCommand,
  buildForkCommand,
  buildSetSessionNameCommand,
  buildSteerCommand,
  buildFollowUpCommand,
  buildAbortRetryCommand,
  buildCycleModelCommand,
  buildCycleThinkingLevelCommand,
  buildCompactCommand,
  buildSetAutoCompactionCommand,
  buildSetAutoRetryCommand,
  buildExportHtmlCommand,
  buildGetLastAssistantTextCommand,
  buildSetSteeringModeCommand,
  buildSetFollowUpModeCommand,
  buildBashCommand,
  buildAbortBashCommand,
  buildCloneCommand,
  buildGetForkMessagesCommand,
} from "../../core/protocol/commands";
import { translateEvent } from "../../core/protocol/event-translator";
import type { RpcCommand, RpcResponse, RpcExtensionUIResponse } from "../../core/protocol/rpc-types";
import type { Question, QuestionAnswer } from "../../core/domain/events/kernel-event";
import type { SessionEvent, NeutralMessage } from "../../core/domain/events/session-state";
import type { NeutralSession, NeutralEntry } from "../../core/domain/session-neutral";

/** pi 后端的文件上下文(cwd + 会话根目录,由 bootstrap 注入;application 不直读环境)。 */
export interface PiBackendContext extends BackendContext {
  /** pi 底座会话根目录(~/.pi/agent)。 */
  agentDir: string;
}

/** pi 后端:把 RpcAdapter + 命令构造 + 会话文件编排收编成一个 BaseBackend 实现。 */
export class PiBackend extends AbstractBackend<PiBackendContext> implements PiCapabilities {
  constructor(
    private readonly adapter: RpcAdapter,
    ctx: PiBackendContext,
  ) {
    super(ctx);
  }

  /** pi 扩展面(§7.6):壳经 capabilities.pi 探测,不按内核身份硬分支。 */
  override readonly capabilities = { pi: this as PiCapabilities };

  /** 内核身份(§kernel-layer 圆心契约):pi 后端固定 "pi"。 */
  readonly kernel = "pi" as const;

  /** 当前会话文件路径(getTree 时记录,getEntries 读分支 lineage 用)。 */
  private sessionFile: string | null = null;

  get alive(): boolean {
    return this.adapter.alive;
  }

  async start(): Promise<void> {
    await this.adapter.start();
    // 就绪探测(§3.6 事件驱动)：底座跑通后消费并响应 get_state(150ms 实证探测,4s 上限)。
    // start 返回即就绪,壳侧不再另做 waitReady。dsh 的 start 已含 initialize 握手,本探测是 pi 专属就绪面。
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      try {
        await this.adapter.send({ type: "get_state" } as RpcCommand);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
  }

  async stop(): Promise<void> {
    await this.adapter.stop();
  }

  /** 订阅中性事件流(pi 事件经 translateEvent 投成中性)。 */
  onEvent(cb: (event: SessionEvent) => void): () => void {
    return this.adapter.onEvent((event) => cb(translateEvent(event)));
  }

  async sendMessage(text: string, images?: ImageInput[], streamingBehavior?: "steer" | "followUp"): Promise<void> {
    await this.adapter.send(buildPromptCommand({
      message: text,
      images: images?.map(toImageContent),
      streamingBehavior,
    }));
  }

  async abort(): Promise<void> {
    await this.adapter.send(buildAbortCommand(), { timeoutMs: ABORT_TIMEOUT_MS });
  }

  /** pi 专属 fork(带 position + cancelled 语义):返回 RpcResponse,SessionStore 查 cancelled 后自行对账。
   *  与中性 BaseBackend.fork(返回 lineageId)并存——后者给新 lineage API 用,本方法给现有 SessionTreeApi。 */
  forkCommand(entryId: string, position?: "before" | "at"): Promise<RpcResponse> {
    return this.adapter.send(buildForkCommand(entryId, position));
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    await this.adapter.send(buildSetModelCommand({ provider, modelId }));
  }

  /** 从一段中立会话树起步(session-neutral-layer.md §13):把 NeutralSession 树重建为 pi 的
   *  parentId 树(纯文件写,不需活进程)。根 lineage 线性挂 parentId,分支 lineage 从分叉点
   *  entryId 挂 parentId。返回文件路径(= pi 侧的会话标识)。 */
  async seed(session: NeutralSession): Promise<string> {
    const sessionId = randomUUID();
    const dir = join(this.ctx.agentDir, "sessions", cwdToBucketName(this.ctx.cwd));
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${sessionId}.jsonl`);
    const lines: string[] = [
      JSON.stringify({ type: "session", id: sessionId, timestamp: new Date().toISOString(), cwd: this.ctx.cwd, "custom-my-harness-desktop": { kernel: "pi" } }),
    ];
    // 中立 entryId → pi entryId(分支 lineage 的分叉点解析用)
    const idMap = new Map<string, string>();

    const writeEntry = (entry: NeutralEntry, parentPiId: string | null): string => {
      const piId = entry.kernelEntryId ?? randomUUID();
      const msg = entry.message;
      const message: Record<string, unknown> = { role: msg.role, content: msg.content ?? "" };
      if (typeof msg.toolName === "string") message.toolName = msg.toolName;
      if (typeof msg.toolCallId === "string") message.toolCallId = msg.toolCallId;
      const ts = typeof msg.timestamp === "number" ? new Date(msg.timestamp).toISOString() : new Date().toISOString();
      const e: Record<string, unknown> = { type: "message", id: piId, timestamp: ts, message };
      if (parentPiId) e.parentId = parentPiId;
      lines.push(JSON.stringify(e));
      idMap.set(entry.neutralEntryId, piId);
      return piId;
    };

    // 按拓扑序写(session.lineages 假定根在前、分支在后,fork.parentLineageId 已处理)
    for (const lineage of session.lineages) {
      let prevId: string | null = null;
      if (lineage.fork) {
        prevId = idMap.get(lineage.fork.boundaryEntryId) ?? null;
      }
      for (const entry of lineage.entries) {
        if (!["user", "assistant", "toolResult"].includes(entry.message.role)) continue;
        prevId = writeEntry(entry, prevId);
      }
    }
    await writeFile(path, lines.join("\n") + "\n", "utf-8");
    return path;
  }

  // ===== pi 专属命令(§2.4「留在后端内部」;非 BaseBackend 契约,SessionStore 经类型守卫调用)=====

  setSessionName(name: string): Promise<RpcResponse> {
    return this.adapter.send(buildSetSessionNameCommand(name));
  }

  steer(text: string, images?: ImageInput[]): Promise<RpcResponse> {
    return this.adapter.send(buildSteerCommand({ message: text, images: images?.map(toImageContent) }));
  }

  followUp(text: string, images?: ImageInput[]): Promise<RpcResponse> {
    return this.adapter.send(buildFollowUpCommand({ message: text, images: images?.map(toImageContent) }));
  }

  abortRetry(): Promise<RpcResponse> {
    return this.adapter.send(buildAbortRetryCommand());
  }

  cycleModel(): Promise<RpcResponse> {
    return this.adapter.send(buildCycleModelCommand());
  }

  cycleThinkingLevel(): Promise<RpcResponse> {
    return this.adapter.send(buildCycleThinkingLevelCommand());
  }

  setThinkingLevel(level: string): Promise<RpcResponse> {
    return this.adapter.send({ type: "set_thinking_level", level: level as never });
  }

  compact(customInstructions?: string): Promise<RpcResponse> {
    return this.adapter.send(buildCompactCommand(customInstructions));
  }

  setAutoCompaction(enabled: boolean): Promise<RpcResponse> {
    return this.adapter.send(buildSetAutoCompactionCommand(enabled));
  }

  setAutoRetry(enabled: boolean): Promise<RpcResponse> {
    return this.adapter.send(buildSetAutoRetryCommand(enabled));
  }

  exportHtml(outputPath?: string): Promise<RpcResponse> {
    return this.adapter.send(buildExportHtmlCommand(outputPath));
  }

  getLastAssistantText(): Promise<RpcResponse> {
    return this.adapter.send(buildGetLastAssistantTextCommand());
  }

  setSteeringMode(mode: "all" | "one-at-a-time"): Promise<RpcResponse> {
    return this.adapter.send(buildSetSteeringModeCommand(mode));
  }

  setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<RpcResponse> {
    return this.adapter.send(buildSetFollowUpModeCommand(mode));
  }

  bash(command: string, excludeFromContext?: boolean): Promise<RpcResponse> {
    return this.adapter.send(buildBashCommand(command, excludeFromContext));
  }

  abortBash(): Promise<RpcResponse> {
    return this.adapter.send(buildAbortBashCommand());
  }

  clone(): Promise<RpcResponse> {
    return this.adapter.send(buildCloneCommand());
  }

  getForkMessages(entryId: string): Promise<RpcResponse> {
    return this.adapter.send(buildGetForkMessagesCommand(entryId));
  }

  getSessionStats(): Promise<RpcResponse> {
    return this.adapter.send({ type: "get_session_stats" });
  }

  getModels(): Promise<RpcResponse> {
    return this.adapter.send({ type: "get_available_models" });
  }

  getThinkingLevels(): Promise<RpcResponse> {
    return this.adapter.send({ type: "get_available_thinking_levels" });
  }

  /**
   * fork:pi 从激活会话的 boundary(entryId)分叉,底座切到新会话文件。
   * parentLineageId 对 pi 冗余(pi 总 fork 激活会话),忽略;boundary 即 entryId。
   * 返回新会话文件路径作新 lineage id(与 §3.1.1「分叉产物 = 新 lineage」一致)。
   */
  async fork(parentLineageId: string, boundary?: BoundaryRef): Promise<string> {
    if (!boundary) throw new Error("pi 后端 fork 必须给 boundary(entryId)");
    const res = (await this.adapter.send(buildForkCommand(boundary, "at"))) as { data?: { cancelled?: boolean } };
    // success:true 但 cancelled 的路径(session_before_fork 扩展拦截)——命令级失败由 rpc-adapter reject 抛上来。
    if (res.data?.cancelled) {
      throw new Error("fork 被取消(底座扩展拦截)");
    }
    const snapshot = await resync(this.adapter);
    const sessionFile = snapshot.state.sessionFile;
    if (typeof sessionFile !== "string" || !sessionFile) {
      throw new Error("fork 后未拿到新会话文件(底座未切换)");
    }
    return sessionFile;
  }

  /** getTree:读 sessionId 指向会话文件的 lineage 树(纯文件读,honor sessionId 非死参数)。
   *  记录 sessionFile,供后续 getEntries 逐 lineage 读独有条目。 */
  async getTree(sessionId: string): Promise<LineageTree> {
    this.sessionFile = sessionId;
    return piReadSessionTree(sessionId);
  }

  /** getEntries:读某条 lineage 的独有条目(纯文件读)。lineageId = 该 lineage 第一条 entry 的
   *  entryId(根用 rootId,分支用分叉点 child);文件路径由 getTree 记录的 sessionFile 提供。 */
  async getEntries(lineageId: string): Promise<NeutralMessage[]> {
    return piReadSessionEntries(this.sessionFile ?? lineageId, lineageId);
  }

  /**
   * bookmark:只存中立坐标,不拷贝副本(session-neutral-layer.md §12 终态)。
   *  resume 现场 fork 从源会话切,副本机制已去。
   */
  async bookmark(lineageId: string, entryId: string): Promise<Anchor> {
    return { lineageId, entryId };
  }

  /** 删除书签:无副本回收(bookmark 只存坐标,§12 终态)。 */
  async deleteBookmark(_anchor: Anchor): Promise<void> {
    // no-op
  }

  // ===== pi 内部通道(收编过渡期 SessionStore 仍用;不属于 BaseBackend 中性契约)=====

  /** 发任意 pi 命令(过渡期透传;最终各命令收编成语义方法后移除此通道)。 */
  send(command: RpcCommand, opts?: { timeoutMs?: number }): Promise<RpcResponse> {
    return this.adapter.send(command, opts);
  }

  /** Session Bus 上行帧透传(session-bus 路由用)。 */
  onBusFrame(cb: (frame: Record<string, unknown>) => void): () => void {
    return this.adapter.onBusFrame(cb);
  }

  /** Extension UI 请求透传(翻译成中性提问;仅 select/input,其余 method 显式降级不投)。 */
  onQuestion(cb: (req: { requestId: string; questions: Question[] }) => void): () => void {
    return this.adapter.onExtensionUI((req) => {
      if (req.method !== "select" && req.method !== "input") return;
      const payload = (req as { payload?: { title?: string; options?: string[] } }).payload;
      const title = typeof payload?.title === "string" ? payload.title : "";
      const options = Array.isArray(payload?.options) ? payload.options.map((o) => ({ label: o })) : [];
      cb({ requestId: req.id, questions: [{ id: `${req.id}-0`, question: title, options }] });
    });
  }

  /** 回答一次提问:QuestionAnswer[] 翻译成 pi extension_ui_response 帧(单值,取首个答案)。 */
  async answerQuestion(questionId: string, answers: QuestionAnswer[]): Promise<void> {
    const first = answers[0];
    const value = first?.custom ?? first?.selected[0];
    const response: RpcExtensionUIResponse = value === undefined || value === ""
      ? { type: "extension_ui_response", id: questionId, cancelled: true }
      : { type: "extension_ui_response", id: questionId, value };
    this.adapter.sendExtensionUIResponse(response);
  }

  /** 工具清单(tool-gate 播报文件读取):返回本 cwd 桶的工具;文件缺失/半截返回 null(壳走降级)。 */
  listTools(): Promise<KnownToolInfo[] | null> {
    return Promise.resolve(readKnownTools(this.ctx.cwd));
  }

  /** stderr 调试串透传。 */
  get stderr(): string {
    return this.adapter.stderr;
  }

  /** 进程退出回调透传(可赋值字段)。 */
  get onProcessExit(): ((exit: ProcessExit, expected: boolean) => void) | null {
    return this.adapter.onProcessExit;
  }
  set onProcessExit(v: ((exit: ProcessExit, expected: boolean) => void) | null) {
    this.adapter.onProcessExit = v;
  }


}

/** ImageInput(中性图片输入)→ pi ImageContent(底座线格式)。 */
function toImageContent(i: ImageInput): { type: "image"; data: string; mimeType: string } {
  return { type: "image", data: i.data, mimeType: i.mimeType };
}

/** abort 快速失败超时(工具不响应 agent signal 时强制放弃,不阻塞)。 */
const ABORT_TIMEOUT_MS = 8_000;
