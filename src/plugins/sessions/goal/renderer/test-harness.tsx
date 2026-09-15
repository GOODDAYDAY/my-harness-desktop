// goal 测试装置:复用共享 testkit(设计 docs/design/session-scope.md §5.2),
// 只提供 goal 自己的 pluginId 与槽声明来源——两件事都是 goal 特有的,其余逻辑不重复。
import { ensureSlotsRegistered, pluginWrapper } from "@my-harness-desktop/react";
import type { SessionSlot } from "@my-harness-desktop/shared";
import { sessionSlots } from "./index";

/** goal 插件在生产里的 pluginId(manifest.id),必须与 PluginIdContext 的值一致。 */
export const GOAL_PLUGIN_ID = "goal";

// 声明直接取自 renderer/index.tsx 的 export——不在测试里重抄一份,
// 否则测试通过也证明不了生产声明是对的(契约单源)。
ensureSlotsRegistered(GOAL_PLUGIN_ID, sessionSlots as SessionSlot[]);

/** 测试渲染的 wrapper:提供 PluginIdContext(生产由槽壳/时间线做,测试补齐)。 */
export const GoalPluginWrapper = pluginWrapper(GOAL_PLUGIN_ID);
