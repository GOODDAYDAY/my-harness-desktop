// resync 共享原语 —— client/pi,并发拉 state+entries+tree+commands 组装 SyncSnapshot。
//
// 依据 docs/structure/16 §9.4 + docs/modules/02 §9.3。
// 调 pi RPC 命令(经 RpcAdapter.send),组装 SyncSnapshot(中性类型)。重启子进程、会话切换后调。
// 这是 pi 协议 → 中性快照的翻译(pi 专属),物理下沉 client/pi(§6.2:pi 协议面在 core/protocol,
// 消费翻译在 client/pi;core/application 不再 import pi 协议)。
import { buildGetStateCommand, buildGetEntriesCommand, buildGetTreeCommand, buildGetCommandsCommand } from "../../protocol/commands";
import type { RpcResponse, RpcSessionState, SessionEntry, SessionTreeNode, RpcSlashCommand, RpcCommand } from "../../protocol/rpc-types";
import {
  toSessionState,
  toMessageEntry,
  toTreeNode,
  toCommandItem,
} from "../../protocol/context-binding";
import type { SyncSnapshot, NeutralMessage } from "@my-harness-desktop/shared";
import { sessionEntryToNeutral, deduplicateAdjacent } from "@my-harness-desktop/shared";

/** resync 只依赖 send 通道;RpcAdapter 与 PiBackend(透传 send)都满足,不必绑定具体类。 */
export interface ResyncTransport {
  send(command: RpcCommand, opts?: { timeoutMs?: number }): Promise<unknown>;
}

export async function resync(rpc: ResyncTransport): Promise<SyncSnapshot> {
  const [stateRes, entriesRes, treeRes, commandsRes] = await Promise.all([
    rpc.send(buildGetStateCommand()),
    rpc.send(buildGetEntriesCommand()),
    rpc.send(buildGetTreeCommand()),
    rpc.send(buildGetCommandsCommand()),
  ]);

  const state = toSessionState((stateRes as RpcResponse & { data: RpcSessionState }).data);
  const entriesData = (entriesRes as RpcResponse & { data: { entries: SessionEntry[]; leafId: string | null } }).data;
  const treeData = (treeRes as RpcResponse & { data: { tree: SessionTreeNode[]; leafId: string | null } }).data;
  const commandsData = (commandsRes as RpcResponse & { data: { commands: RpcSlashCommand[] } }).data;

  return {
    state,
    entries: (entriesData?.entries ?? []).map(toMessageEntry),
    messages: deduplicateAdjacent(
      (entriesData?.entries ?? [])
        .map(sessionEntryToNeutral)
        .filter((m): m is NeutralMessage => m !== null),
    ),
    tree: (treeData?.tree ?? []).map(toTreeNode),
    commands: (commandsData?.commands ?? []).map(toCommandItem),
    leafId: entriesData?.leafId ?? treeData?.leafId ?? null,
  };
}
