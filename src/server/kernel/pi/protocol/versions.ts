// 协议版本声明 + 命令回退集(28 字面量)—— gateway/protocol。
//
// 依据 docs/modules/02 §6 + DESIGN.md §6.4。当前不实现 handshake(内核还没补 handshake
// 命令),只声明版本 + 回退命令集。未来协议漂移时动此文件。

/** 当前协议版本(客户端声明)。 */
export const CURRENT_PROTOCOL_VERSION = "1.0";

/** 命令字面量回退集(28 项;handshake 不支持时假定内核有这些命令;计数以 Set 实际成员为准)。"31"是历史简称,勿从注释抄数字。 */
export const FALLBACK_COMMAND_SET: ReadonlySet<string> = new Set([
  "prompt", "steer", "follow_up", "abort", "new_session",
  "get_state", "set_model", "cycle_model", "get_available_models",
  "set_thinking_level", "cycle_thinking_level", "get_available_thinking_levels",
  "set_steering_mode", "set_follow_up_mode",
  "compact", "set_auto_compaction",
  "set_auto_retry", "abort_retry",
  "bash", "abort_bash",
  "get_session_stats",
  "switch_session",
  "get_entries", "get_tree", "get_last_assistant_text",
  "set_session_name", "get_messages", "get_commands",
]);
// 已从壳退役的 pi 命令(不再发送,内核侧保留无妨):export_html / fork / clone /
// get_fork_messages —— session-single-source §4.2(内容面收归中立层,fork/clone 归壳)。
