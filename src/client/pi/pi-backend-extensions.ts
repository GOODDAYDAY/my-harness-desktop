// pi 内核专属扩展面 —— PiBackend 的 pi 专属命令 + 内部通道，收成接口。
//
// 依据 docs/design/kernel-design-spec.md §26 阶段 D / §28.6：这些 pi 专属能力
// （steer/followUp/cycleModel/getThinkingLevels/…）不该定义在圆心 core/domain/backend.ts
// ——那是 pi 专属形状泄漏进中性契约。这里收成接口，PiBackend implements；
// 壳（core/application）经 `backend.capabilities.pi` 探测「有则用、无则降级」，
// 类型经本接口（type-only import，§28.6「core 只 import 接口不 import 类」）。
//
// 需要壳读回结果的方法返回中性类型（ModelInfo[]/SessionStats/NeutralMessage[] 等），
// pi 协议的 RpcResponse 解包与翻译收进 PiBackend——圆心与 core/application 都不 import
// pi 协议（core/protocol）的类型实现细节。
//
// 本文件在 client/pi（pi 内核适配器层），import core/domain 的中性类型（依赖只向内）。

import type { SyncSnapshot, SessionStats, TurnUsage, ModelInfo, NeutralMessage } from "../../core/domain/events/session-state";
import type { Question } from "../../core/domain/events/kernel-event";
import type { ImageInput, BashResult } from "../../core/domain/sessions";
import type { ProcessExitInfo } from "../../core/domain/backend";

export interface PiBackendExtensions {
  /** pi 专属 RPC 通道(命令透传/就绪探测)。 */
  send(command: unknown, opts?: { timeoutMs?: number }): Promise<unknown>;
  /** pi 版 sendMessage 多一个 streamingBehavior(steer/followUp 多路并发档)。 */
  sendMessage(text: string, images?: ImageInput[], streamingBehavior?: "steer" | "followUp"): Promise<void>;
  /** 并发拉 state+entries+tree+commands 组装中性快照(pi 协议 → 中性翻译在 client/pi)。 */
  resync(): Promise<SyncSnapshot>;
  setSessionName(name: string): Promise<unknown>;
  abortBash(): Promise<unknown>;
  /** 会话统计:pi 侧拉取 + 翻译,tps/轮次用量/回合数与步数由壳自算注入。 */
  getSessionStats(local: { tps: number | null; turn: TurnUsage; lastTurn: TurnUsage | null; turns: number; steps: number }): Promise<SessionStats>;
  steer(text: string, images?: ImageInput[]): Promise<void>;
  followUp(text: string, images?: ImageInput[]): Promise<void>;
  abortRetry(): Promise<void>;
  cycleModel(): Promise<void>;
  cycleThinkingLevel(): Promise<void>;
  getLastAssistantText(): Promise<string>;
  getModels(): Promise<ModelInfo[]>;
  getThinkingLevels(): Promise<string[]>;
  clone(): Promise<void>;
  getForkMessages(entryId: string): Promise<NeutralMessage[]>;
  compact(customInstructions?: string): Promise<void>;
  setAutoCompaction(enabled: boolean): Promise<void>;
  setAutoRetry(enabled: boolean): Promise<void>;
  exportHtml(outputPath?: string): Promise<string>;
  setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void>;
  setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void>;
  bash(command: string, excludeFromContext?: boolean): Promise<BashResult>;
  forkCommand(entryId: string, position?: "before" | "at"): Promise<unknown>;
  /** $bus 上行帧透传。 */
  onBusFrame(cb: (frame: Record<string, unknown>) => void): () => void;
  /** 中性提问投递(pi extension_ui 帧翻译)。 */
  onQuestion(cb: (req: { requestId: string; questions: Question[] }) => void): () => void;
  /** 进程退出回调(可赋值字段)。 */
  onProcessExit: ((exit: ProcessExitInfo, expected: boolean) => void) | null;
  /** stderr 调试串。 */
  readonly stderr: string;
}
