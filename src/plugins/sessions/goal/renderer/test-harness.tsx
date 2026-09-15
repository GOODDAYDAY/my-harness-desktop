// goal 测试的共享装置 —— 把「插件在生产里由框架做的事」在测试里按同一条路径做一遍。
//
// 为什么需要(设计 docs/design/session-scope.md §2.4.1):会话槽的 slotKey = `${pluginId}:${slotId}`,
// 其中 pluginId 由 PluginIdContext 注入、槽声明由 plugins-host 收集 mod.sessionSlots 注册。
// 测试用 renderHook/render 直接挂组件,这两件事都不会自动发生——不补齐就会读到
// 「未注册的会话槽 :goal」(pluginId 为空 + 注册表为空)。
//
// 关键取舍:**不 mock 作用域容器**。goal 迁移的全部意义就是「按会话隔离」,mock 掉容器
// 等于把要验证的东西换成假的(等同地位、等同功能,不做内存式/mock 式替身)。所以这里
// 走真实注册 + 真实 Provider,只 mock usePluginContext(IPC/内核边界)。
import React from "react";
import { PluginIdContext } from "@my-harness-desktop/react";
import type { SessionSlot } from "@my-harness-desktop/shared";
import { registerSessionSlots } from "@my-harness-desktop/react";
import { sessionSlots } from "./index";

/** goal 插件在生产里的 pluginId(manifest.id)。测试注册槽时用它,与 PluginIdContext 的值一致。 */
export const GOAL_PLUGIN_ID = "goal";

let registered = false;
/** 注册 goal 的会话槽声明(幂等)。声明直接取自 renderer/index.tsx 的 export——
 *  不在测试里重抄一份,否则测试通过也证明不了生产声明是对的(契约单源)。 */
export function ensureGoalSlotsRegistered(): void {
  if (registered) return;
  registered = true;
  registerSessionSlots(GOAL_PLUGIN_ID, sessionSlots as SessionSlot[]);
}

/** 测试渲染的 wrapper:提供 PluginIdContext(框架在生产里做的事)。 */
export function GoalPluginWrapper({ children }: { children: React.ReactNode }): React.ReactNode {
  return <PluginIdContext.Provider value={GOAL_PLUGIN_ID}>{children}</PluginIdContext.Provider>;
}
