/**
 * orchestrator 单例 —— 编排核心跨组件共享(SubAgentSection 挂帧循环,SpawnCard/Panel 读账)。
 * 模块级持有,组件首次挂载时惰性组装;模块顶层不碰 ctx(lint 红线),组装只发生在组件内。
 */
import type { PluginContext } from "@pi-desktop/contract";
import { SubagentOrchestrator } from "../core/orchestrator";
import { buildPorts } from "../client/ports";

let instance: SubagentOrchestrator | null = null;

export function ensureOrchestrator(ctx: PluginContext, pluginId: string): SubagentOrchestrator | null {
  if (!instance) {
    const ports = buildPorts(ctx);
    if (!ports) return null;
    instance = new SubagentOrchestrator(ports, `plugin:${pluginId}`, "~/.pi-desktop/config/sub-agent.json");
  }
  return instance;
}

export function peekOrchestrator(): SubagentOrchestrator | null {
  return instance;
}
