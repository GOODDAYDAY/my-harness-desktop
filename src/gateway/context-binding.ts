// 底座类型 → 圆心中性类型映射 —— gateway。
//
// 依据 docs/modules/02 §4.4.1 + docs/structure/16 §3.4。
// 把 pi 的 RpcSessionState/SessionEntry/SessionTreeNode/RpcSlashCommand/Model
// 映射成圆心的 SessionState/MessageEntry/TreeNode/CommandItem/ModelInfo。
import type {
  RpcSessionState,
  SessionEntry,
  SessionTreeNode,
  RpcSlashCommand,
  Model,
} from "./protocol/rpc-types";
import type {
  SessionState,
  MessageEntry,
  TreeNode,
  CommandItem,
  ModelInfo,
} from "../domain/events/session-state";

/** Model → ModelInfo。 */
export function toModelInfo(pi: Model): ModelInfo {
  return {
    provider: pi.provider,
    id: pi.id,
    name: pi.name,
    reasoning: pi.reasoning,
    contextWindow: pi.contextWindow,
    maxTokens: pi.maxTokens,
    input: pi.input,
  };
}

/** RpcSessionState → SessionState。 */
export function toSessionState(pi: RpcSessionState): SessionState {
  return {
    model: pi.model ? toModelInfo(pi.model) : undefined,
    thinkingLevel: pi.thinkingLevel,
    isStreaming: pi.isStreaming,
    isCompacting: pi.isCompacting,
    steeringMode: pi.steeringMode,
    followUpMode: pi.followUpMode,
    sessionFile: pi.sessionFile,
    sessionId: pi.sessionId,
    sessionName: pi.sessionName,
    autoCompactionEnabled: pi.autoCompactionEnabled,
    messageCount: pi.messageCount,
    pendingMessageCount: pi.pendingMessageCount,
  };
}

/** SessionEntry → MessageEntry。 */
export function toMessageEntry(pi: SessionEntry): MessageEntry {
  return {
    id: pi.id,
    type: pi.type,
    content: pi.content,
    toolCalls: pi.toolCalls,
    toolCallId: pi.toolCallId,
    timestamp: pi.timestamp,
  };
}

/** SessionTreeNode → TreeNode(递归)。 */
export function toTreeNode(pi: SessionTreeNode): TreeNode {
  return {
    entryId: pi.entryId,
    children: pi.children?.map(toTreeNode),
    isLeaf: pi.isLeaf,
    label: pi.label,
  };
}

/** RpcSlashCommand → CommandItem。 */
export function toCommandItem(pi: RpcSlashCommand): CommandItem {
  return {
    name: pi.name,
    description: pi.description,
    source: pi.source,
  };
}
