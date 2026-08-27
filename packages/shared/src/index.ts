// @my-harness-desktop/shared —— 圆心契约 + 通道契约 + 线协议（前后端共享的 workspace 包，零依赖）。
//
// 单源纪律：圆心类型只在 packages/shared/src/domain 定义一份，本文件只 re-export。
// src/web 与 src/server 都 import 这个包（§前后端分离），不互相 import。

// 通道契约（channel 树 + 元数据）
export * from "./channel/channel-contract";
export * from "./channel/channel-meta";

// 圆心契约类型
export * from "./domain/aux-blocks";
export * from "./domain/backend";
export * from "./domain/bookmark-snapshot";
export * from "./domain/context";
export * from "./domain/contributions";
export * from "./domain/custom-order";
export * from "./domain/events/kernel-event";
export * from "./domain/events/session-bus";
export * from "./domain/events/session-state";
export * from "./domain/extensions";
export * from "./domain/file-icons";
export * from "./domain/goal/goal-state";
export * from "./domain/host";
export * from "./domain/kernel-manager";
export * from "./domain/kernel-warmup";
export * from "./domain/kernel";
export * from "./domain/layout";
export * from "./domain/path-utils";
export * from "./domain/remote";
export * from "./domain/restart";
export * from "./domain/session-neutral";
export * from "./domain/sessions";
export * from "./domain/text";
export * from "./domain/skills";
export * from "./domain/slots/theme-tokens";
export * from "./domain/working-phase";

// 线协议实现（parse/serialize，前后端都跑）
export * from "./wire/wire";

// 配置路径契约 + 样式预设清单(原 packages/contract,插件 import 的发布面)
export * from "./contract/paths";
export * from "./contract/style-presets";
