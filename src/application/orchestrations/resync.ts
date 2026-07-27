// resync 共享原语 —— application/orchestrations,并发拉 state+entries+tree+commands。
//
// 依据 docs/structure/16 §9.4 + docs/modules/02 §9.3。
// 调 gateway 的 RPC 命令(经 RpcAdapter.send),组装 SyncSnapshot(中性类型)。
// 重启子进程、会话切换后调。application 依赖 gateway + domain,不依赖 shell。
import type { RpcAdapter } from "../../gateway/rpc-adapter";
import { buildGetStateCommand, buildGetEntriesCommand, buildGetTreeCommand, buildGetCommandsCommand } from "../../gateway/protocol/commands";
import type { RpcResponse, RpcSessionState, SessionEntry, SessionTreeNode, RpcSlashCommand } from "../../gateway/protocol/rpc-types";
import {
  toSessionState,
  toMessageEntry,
  toTreeNode,
  toCommandItem,
  toNeutralMessage,
} from "../../gateway/context-binding";
import type { SyncSnapshot } from "../../domain/events/session-state";

/** resync:并发发 5 条命令,组装 SyncSnapshot。 */
export async function resync(rpc: RpcAdapter): Promise<SyncSnapshot> {
  const [stateRes, entriesRes, treeRes, commandsRes, messagesRes] = await Promise.all([
    rpc.send(buildGetStateCommand()),
    rpc.send(buildGetEntriesCommand()),
    rpc.send(buildGetTreeCommand()),
    rpc.send(buildGetCommandsCommand()),
    rpc.send({ type: "get_messages" }),
  ]);

  const state = toSessionState((stateRes as RpcResponse & { data: RpcSessionState }).data);
  const entriesData = (entriesRes as RpcResponse & { data: { entries: SessionEntry[]; leafId: string | null } }).data;
  const treeData = (treeRes as RpcResponse & { data: { tree: SessionTreeNode[]; leafId: string | null } }).data;
  const commandsData = (commandsRes as RpcResponse & { data: { commands: RpcSlashCommand[] } }).data;
  const messagesData = (messagesRes as RpcResponse & { data: { messages: { role: string; content?: unknown; timestamp?: number }[] } }).data;

  return {
    state,
    entries: (entriesData?.entries ?? []).map(toMessageEntry),
    messages: (messagesData?.messages ?? []).map(toNeutralMessage),
    tree: (treeData?.tree ?? []).map(toTreeNode),
    commands: (commandsData?.commands ?? []).map(toCommandItem),
    leafId: entriesData?.leafId ?? treeData?.leafId ?? null,
  };
}
