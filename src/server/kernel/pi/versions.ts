// 协议版本声明 + 31 命令回退集 —— gateway/protocol。
//
// 依据 docs/modules/02 §6 + DESIGN.md §6.4。当前不实现 handshake(内核还没补 handshake
// 命令),只声明版本 + 回退命令集。未来协议漂移时动此文件。

/** 当前协议版本(客户端声明)。 */
export const CURRENT_PROTOCOL_VERSION = "1.0";

/** 31 命令字面量回退集(handshake 不支持时假定内核有这些命令)。 */
export const FALLBACK_COMMAND_SET: ReadonlySet<string> = new Set([
  "prompt", "steer", "follow_up", "abort", "new_session",
  "get_state", "set_model", "cycle_model", "get_available_models",
  "set_thinking_level", "cycle_thinking_level", "get_available_thinking_levels",
  "set_steering_mode", "set_follow_up_mode",
  "compact", "set_auto_compaction",
  "set_auto_retry", "abort_retry",
  "bash", "abort_bash",
  "get_session_stats", "export_html",
  "switch_session", "fork", "clone", "get_fork_messages",
  "get_entries", "get_tree", "get_last_assistant_text",
  "set_session_name", "get_messages", "get_commands",
]);
