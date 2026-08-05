/**
 * 出站封装 —— 碰 ctx.* 的调用收敛一处(组件不直接碰 IPC 的红线;orchestrator 保持纯 TS)。
 * renderer/index.tsx 在组件内经 usePluginContext 拿 ctx 后调 buildPorts 组装注入。
 */
import type { PluginContext } from "@pi-desktop/contract";
import type { OrchestratorPorts } from "../core/orchestrator";

export function buildPorts(ctx: PluginContext): OrchestratorPorts | null {
  const bus = ctx.bus;
  if (!bus) return null; // sessions:bus 权限未生效:插件降级为空(orchestrator 不建,UI 静默)
  return {
    bus: {
      sessionCreate: (opts) => bus.sessionCreate(opts),
      sessionAbort: (session) => bus.sessionAbort(session),
      channelMember: (channel, action, member) => bus.channelMember(channel, action, member),
      tapStart: (opts) => bus.tapStart(opts),
      send: (to, kind, payload, replyTo) => bus.send(to, kind, payload, replyTo),
      status: () => bus.status(),
    },
    sessions: {
      updateHeader: (sessionPath, patch) => ctx.sessions.updateHeader(sessionPath, patch),
      list: (cwd) => ctx.sessions.list(cwd),
    },
    configFile: {
      get: (path) => ctx.configFile.get(path),
      append: (path, entry) => ctx.configFile.append(path, entry),
    },
    now: () => Date.now(),
    uuid: () => crypto.randomUUID(),
  };
}
