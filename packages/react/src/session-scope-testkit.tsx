// 会话作用域插件测试的共享装置(设计 docs/design/session-scope.md §5.2)。
//
// 为什么需要:会话槽的 slotKey = `${pluginId}:${slotId}`,其中 pluginId 由 PluginIdContext
// 注入、槽声明由 plugins-host 收集 mod.sessionSlots 注册。测试用 render/renderHook 直接挂
// 组件,这两件事都不会自动发生——不补齐就读到「未注册的会话槽 :goal」(pluginId 为空 +
// 注册表为空)。
//
// 关键取舍:**不 mock 作用域容器**。会话作用域迁移要验证的正是「按会话隔离 + 切会话换档 +
// 物化搬迁」,mock 掉容器等于把被测对象换成假的(等同地位、等同功能,不做内存式/mock 式替身)。
// 所以这里走真实注册 + 真实 Provider,只 mock usePluginContext(IPC/内核边界)。
//
// 收敛到一处(CLAUDE.md §3.3):goal 与 review 都需要同样的两件事,各写一份就是同一逻辑的
// 多次复制;后来的插件(session-colors 等)迁入时直接复用。
//
// 为什么住在发布面(packages/react)而不是 src/web/stores:插件测试只能 import
// @my-harness-desktop/shared 与 @my-harness-desktop/react(audit:deps 检验④),
// 放 src/web 下会让插件测试违规。这与 ui-store/session-pending 经发布面 re-export 同一手法。
import React from "react";
import { PluginIdContext } from "./plugin-id-context";
import { registerSessionSlots } from "./session-scope";
import type { SessionSlot } from "@my-harness-desktop/shared";

const registered = new Set<string>();

/** 注册一个插件的会话槽声明(幂等)。声明直接取自插件的 renderer 入口 export——
 *  不在测试里重抄一份,否则测试通过也证明不了生产声明是对的(契约单源)。 */
export function ensureSlotsRegistered(pluginId: string, slots: SessionSlot[]): void {
  if (registered.has(pluginId)) return;
  registered.add(pluginId);
  registerSessionSlots(pluginId, slots);
}

/** 造一个把 PluginIdContext 绑到指定插件的 wrapper(render/renderHook 的 wrapper 选项用)。
 *  每个插件的测试各调一次拿自己的 wrapper——pluginId 不同,不能共用一个。 */
export function pluginWrapper(pluginId: string): (props: { children: React.ReactNode }) => React.ReactNode {
  return function PluginWrapper({ children }: { children: React.ReactNode }): React.ReactNode {
    return React.createElement(PluginIdContext.Provider, { value: pluginId }, children);
  };
}
