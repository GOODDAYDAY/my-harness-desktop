// dsh JSON-RPC 方法名单源 —— client/dsh ↔ dsh 内核的 wire 契约。
//
// dsh 内核走 JSON-RPC 2.0（base-interface-lineage.md §4.2），方法名是线协议字符串。
// 此前散落在 client/dsh/{backend,catalog,event-translator} 的 "session/*" 魔法字符串里，
// 加一个方法要改多处、拼错只在运行时现形。这里收成单源常量：方法名只在此定义一次，
// client/dsh 各文件 import 引用（契约单源，§1.3）。
//
// 与 pi 的对称性（CLAUDE.md §6.2）：pi 的协议面在 kernel/pi/protocol（commands.ts 21 个
// build*Command 构造器；RpcCommand 联合 29 个 type 字面量），dsh 的方法枚举收在这里。
// 两边协议面各归各的内核目录、同为纯契约层——消除「pi 协议在 core、dsh 协议散在 client」
// 的物理不对称。两边的权威计数以各自文件的实际导出为准，勿从注释抄数字——"26 个"
// 曾在此漂移过一轮（docs/reports/doc-code-gap-audit-2026-10.md §4A 的教训）。
//
// 本文件零依赖：纯字符串常量，不 import 任何包（与 core/protocol 其余文件同一纪律）。

/** dsh JSON-RPC 方法名（client/dsh 与 dsh 内核之间的 wire 契约）。 */
export const DSH_METHODS = {
  /** 握手：传递 provider/model/env/maxTokens 等，dsh 内核据此初始化。 */
  initialize: "initialize",
  /** 模型重试（dsh 侧通知，翻译成 autoRetryStart）。 */
  llmRetry: "llm/retry",
  sessionAbort: "session/abort",
  sessionBookmark: "session/bookmark",
  sessionContinue: "session/continue",
  sessionDelete: "session/delete",
  sessionDeleteBookmark: "session/deleteBookmark",
  sessionFork: "session/fork",
  sessionGet: "session/get",
  sessionGetEntries: "session/getEntries",
  sessionGetTree: "session/getTree",
  /** 思考档位清单(补面方法,由桌面适配插件拦截提供;dsh-thinking-level.md)。 */
  sessionGetThinkingLevels: "session/getThinkingLevels",
  sessionList: "session/list",
  sessionProjectStats: "session/projectStats",
  sessionPrompt: "session/prompt",
  sessionRename: "session/rename",
  // ⚠ 曾有 sessionResume: "session/resume"，r72 随契约的 resume? 一起删除（无人 import 的死条目；
  //   本文件是"壳会调用的方法名"单源，不被调用的方法留在这里会让人以为壳在用它）。
  sessionSeed: "session/seed",
  sessionSetModel: "session/setModel",
  /** 运行时切思考深度(补面方法,由桌面适配插件拦截提供;dsh-thinking-level.md)。 */
  sessionSetThinkingLevel: "session/setThinkingLevel",
  sessionTitle: "session/title",
  sessionUpdateHeader: "session/updateHeader",
} as const;
