// pi 后端 —— BaseBackend 的 pi 实现:收编 client/pi 传输 + resync 基线 + pi 命令构造 + 会话文件编排。
//
// 依据 docs/design/base-interface-lineage.md §3.1。pi 的协议(JSONL 31 命令)、会话文件、
// parentId 树,全部收编在本后端内部;对外只暴露 BaseBackend 中性操作。
//
// 分工:本类做「文件级」编排(bookmark 拷贝 / resume 物化)与「进程级」原语(RPC 命令、
// getTree/getEntries 走 resync 基线);进程生命周期(start/stop/多进程调度)仍归 SessionStore。
// resume 只物化锚点为新会话文件、返回其路径——「在该文件上 fork 到 boundary」由调用方编排
// (start 后 fork),因为 fork 需要跑起来的 pi 进程,那一步归进程调度层。
//
// 当前 getTree/getEntries 只对激活会话生效(RPC 基线);读任意非激活会话的树/条目需文件 IO,
// 是后续接线步骤的事。

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RpcAdapter } from "../../../client/pi/rpc-adapter";
import type { ProcessExit } from "../../../client/pi/subprocess-handle";
import type { BaseBackend, Anchor, BoundaryRef, LineageTree } from "../../domain/backend";
import { projectLineageTree } from "../../domain/backend";
import { resync } from "../orchestrations/resync";
import { copySession, removePath } from "./session-scanner";
import { cwdToBucketName, type ImageInput } from "../../domain/sessions";
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
} from "../../protocol/commands";
import { translateEvent } from "../../protocol/event-translator";
import type { RpcCommand, RpcResponse, RpcExtensionUIRequest } from "../../protocol/rpc-types";
import type { ExtensionUIResponse } from "../../domain/events/kernel-event";
import type { SessionEvent, NeutralMessage } from "../../domain/events/session-state";

/** pi 后端的文件上下文(cwd + 会话根目录,由 bootstrap 注入;application 不直读环境)。 */
export interface PiBackendContext {
  /** 当前项目根(cwd 桶名与会话路径生成用)。 */
  cwd: string;
  /** pi 底座会话根目录(~/.pi/agent)。 */
  agentDir: string;
}

/** pi 后端:把 RpcAdapter + 命令构造 + 会话文件编排收编成一个 BaseBackend 实现。 */
export class PiBackend implements BaseBackend {
  constructor(
    private readonly adapter: RpcAdapter,
    private readonly ctx: PiBackendContext,
  ) {}

  get alive(): boolean {
    return this.adapter.alive;
  }

  async start(): Promise<void> {
    await this.adapter.start();
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

  /** 从一段中性历史起步(§3.6):把 NeutralMessage[] 物化成一个新 pi 会话 JSONL 文件,
   *  返回文件路径(= pi 侧的会话标识)。只 seed 对话消息(user/assistant/toolResult),
   *  跳过 divider/custom 等元数据;工具块当历史写回、不重跑。 */
  async seed(history: NeutralMessage[]): Promise<string> {
    const sessionId = randomUUID();
    const dir = join(this.ctx.agentDir, "sessions", cwdToBucketName(this.ctx.cwd));
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${sessionId}.jsonl`);
    const lines: string[] = [
      // 会话头记内核归属(§5.4 第 3 项「会话头重绑」):desktop 私有命名空间平铺保留键。
      JSON.stringify({ type: "session", id: sessionId, timestamp: new Date().toISOString(), cwd: this.ctx.cwd, "custom-pi-desktop": { kernel: "pi" } }),
    ];
    let prevId: string | null = null;
    for (const msg of history) {
      if (!["user", "assistant", "toolResult"].includes(msg.role)) continue;
      const id = typeof msg.id === "string" ? msg.id : randomUUID();
      const ts = typeof msg.timestamp === "number" ? new Date(msg.timestamp).toISOString() : new Date().toISOString();
      const message: Record<string, unknown> = { role: msg.role, content: msg.content ?? "" };
      if (typeof msg.toolName === "string") message.toolName = msg.toolName;
      if (typeof msg.toolCallId === "string") message.toolCallId = msg.toolCallId;
      const entry: Record<string, unknown> = { type: "message", id, timestamp: ts, message };
      if (prevId) entry.parentId = prevId;
      lines.push(JSON.stringify(entry));
      prevId = id;
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
    await this.adapter.send(buildForkCommand(boundary, "at"));
    const snapshot = await resync(this.adapter);
    const sessionFile = snapshot.state.sessionFile;
    if (typeof sessionFile !== "string" || !sessionFile) {
      throw new Error("fork 后未拿到新会话文件(底座未切换)");
    }
    return sessionFile;
  }

  /** getTree:激活会话的入口级树 → lineage 树(RPC get_tree 经 resync 投影)。 */
  async getTree(sessionId: string): Promise<LineageTree> {
    const snapshot = await resync(this.adapter);
    return projectLineageTree(snapshot.tree);
  }

  /** getEntries:激活会话的线性消息历史(RPC get_entries 经 resync 投影)。 */
  async getEntries(lineageId: string): Promise<NeutralMessage[]> {
    const snapshot = await resync(this.adapter);
    return snapshot.messages;
  }

  /**
   * bookmark:全量 JSONL 拷贝(§3.1.2)。lineageId 对 pi 即会话文件路径,
   * 拷贝到 agentDir/bookmarks 下的快照路径作 opaque 持久化线索。
   */
  async bookmark(lineageId: string, boundary: BoundaryRef): Promise<Anchor> {
    const target = this.newBookmarkPath();
    copySession(lineageId, target);
    return { lineageId, boundary, opaque: target };
  }

  /**
   * resume:把锚点物化成新会话文件(拷贝 opaque → sessions 桶新路径)。
   * 「在新文件上 fork 到 boundary」由调用方编排——本方法只做文件物化,返回新 lineage id。
   */
  async resume(anchor: Anchor): Promise<string> {
    const target = this.newSessionPath(this.ctx.cwd);
    copySession(anchor.opaque, target);
    return target;
  }

  /** 删除书签副本:移除 opaque 指向的 JSONL 文件(回收后端自留副本)。 */
  async deleteBookmark(anchor: Anchor): Promise<void> {
    removePath(anchor.opaque);
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

  /** Extension UI 请求透传。 */
  onExtensionUI(cb: (req: RpcExtensionUIRequest) => void): () => void {
    return this.adapter.onExtensionUI(cb);
  }

  /** 回 Extension UI 响应。 */
  sendExtensionUIResponse(response: ExtensionUIResponse): void {
    this.adapter.sendExtensionUIResponse(response);
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

  /** 生成新会话文件路径(对齐 pi 底座格式:ISO timestamp + uuid)。 */
  private newSessionPath(cwd: string): string {
    const bucket = cwdToBucketName(cwd);
    return `${this.ctx.agentDir}/sessions/${bucket}/${this.stamp()}.jsonl`;
  }

  /** 生成 bookmark 快照路径(独立于 sessions 桶,不与活跃会话争列)。 */
  private newBookmarkPath(): string {
    return `${this.ctx.agentDir}/bookmarks/${this.stamp()}.jsonl`;
  }

  private stamp(): string {
    return `${new Date().toISOString().replace(/[:.]/g, "-")}_${randomUUID()}`;
  }
}

/** ImageInput(中性图片输入)→ pi ImageContent(底座线格式)。 */
function toImageContent(i: ImageInput): { type: "image"; data: string; mimeType: string } {
  return { type: "image", data: i.data, mimeType: i.mimeType };
}

/** abort 快速失败超时(工具不响应 agent signal 时强制放弃,不阻塞)。 */
const ABORT_TIMEOUT_MS = 8_000;
