// 类型化命令构造器 —— gateway/protocol。
//
// 避免 application/renderer 裸拼命令字面量,用构造器返回 RpcCommand 字面量类型。
// 构造(在这里)和执行(在 session-store.send)分开。
import type { RpcCommand, ImageContent } from "./rpc-types";

/** 构造 prompt 命令。 */
export function buildPromptCommand(opts: { message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }): RpcCommand {
  return { type: "prompt", message: opts.message, images: opts.images, streamingBehavior: opts.streamingBehavior };
}

/** 构造 steer 命令。 */
export function buildSteerCommand(opts: { message: string; images?: ImageContent[] }): RpcCommand {
  return { type: "steer", message: opts.message, images: opts.images };
}

/** 构造 follow_up 命令。 */
export function buildFollowUpCommand(opts: { message: string; images?: ImageContent[] }): RpcCommand {
  return { type: "follow_up", message: opts.message, images: opts.images };
}

/** 构造 get_state 命令。 */
export function buildGetStateCommand(): RpcCommand {
  return { type: "get_state" };
}

/** 构造 get_entries 命令(since 增量拉)。 */
export function buildGetEntriesCommand(opts?: { since?: string }): RpcCommand {
  return { type: "get_entries", since: opts?.since };
}

/** 构造 get_tree 命令。 */
export function buildGetTreeCommand(): RpcCommand {
  return { type: "get_tree" };
}

/** 构造 get_commands 命令。 */
export function buildGetCommandsCommand(): RpcCommand {
  return { type: "get_commands" };
}

/** 构造 set_model 命令。 */
export function buildSetModelCommand(opts: { provider: string; modelId: string }): RpcCommand {
  return { type: "set_model", provider: opts.provider, modelId: opts.modelId };
}

/** 构造 abort 命令。 */
export function buildAbortCommand(): RpcCommand {
  return { type: "abort" };
}

/** 构造 cycle_model 命令。 */
export function buildCycleModelCommand(): RpcCommand {
  return { type: "cycle_model" };
}

/** 构造 cycle_thinking_level 命令。 */
export function buildCycleThinkingLevelCommand(): RpcCommand {
  return { type: "cycle_thinking_level" };
}

/** 构造 compact 命令。 */
export function buildCompactCommand(customInstructions?: string): RpcCommand {
  return { type: "compact", customInstructions };
}

/** 构造 set_auto_compaction 命令。 */
export function buildSetAutoCompactionCommand(enabled: boolean): RpcCommand {
  return { type: "set_auto_compaction", enabled };
}

/** 构造 set_auto_retry 命令。 */
export function buildSetAutoRetryCommand(enabled: boolean): RpcCommand {
  return { type: "set_auto_retry", enabled };
}

/** 构造 abort_retry 命令。 */
export function buildAbortRetryCommand(): RpcCommand {
  return { type: "abort_retry" };
}

/** 构造 fork 命令。 */
export function buildForkCommand(entryId: string): RpcCommand {
  return { type: "fork", entryId };
}

/** 构造 clone 命令。 */
export function buildCloneCommand(): RpcCommand {
  return { type: "clone" };
}

/** 构造 get_fork_messages 命令。 */
export function buildGetForkMessagesCommand(entryId: string): RpcCommand {
  return { type: "get_fork_messages", entryId };
}

/** 构造 export_html 命令。 */
export function buildExportHtmlCommand(outputPath?: string): RpcCommand {
  return { type: "export_html", outputPath };
}

/** 构造 get_last_assistant_text 命令。 */
export function buildGetLastAssistantTextCommand(): RpcCommand {
  return { type: "get_last_assistant_text" };
}

/** 构造 set_steering_mode 命令。 */
export function buildSetSteeringModeCommand(mode: "all" | "one-at-a-time"): RpcCommand {
  return { type: "set_steering_mode", mode };
}

/** 构造 set_follow_up_mode 命令。 */
export function buildSetFollowUpModeCommand(mode: "all" | "one-at-a-time"): RpcCommand {
  return { type: "set_follow_up_mode", mode };
}

/** 构造 bash 命令。 */
export function buildBashCommand(command: string, excludeFromContext?: boolean): RpcCommand {
  return { type: "bash", command, excludeFromContext };
}

/** 构造 abort_bash 命令。 */
export function buildAbortBashCommand(): RpcCommand {
  return { type: "abort_bash" };
}
