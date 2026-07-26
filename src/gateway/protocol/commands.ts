// 类型化命令构造器 —— gateway/protocol。
//
// 避免 application/renderer 裸拼命令字面量,用构造器返回 RpcCommand 字面量类型。
// 依据 docs/modules/02 §3.2.4(19.2.4)。先做 5 个核心命令,其余后续补。
import type { RpcCommand, ImageContent } from "./rpc-types";

/** 构造 prompt 命令。 */
export function buildPromptCommand(opts: { message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }): RpcCommand {
  return { type: "prompt", message: opts.message, images: opts.images, streamingBehavior: opts.streamingBehavior };
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
