/**
 * list_subagents —— 查请求方自己的子全景(编排侦察/完成后盘点,一轮闭环)。
 * 只列 parentAddr === from 的(from 传输认证,伪造在路由器层已失效);
 * 完成态带 200 字 output_preview,全文经 session_path 自读。
 */
import type { SessionBusMessage } from "@pi-desktop/contract";
import { isActive, type SubagentOrchestrator } from "../core/orchestrator";

export function handleListSubagents(orch: SubagentOrchestrator, frame: SessionBusMessage): Promise<void> {
  const p = (frame.payload ?? {}) as { status?: string };
  const mine = orch.getSubs().filter((s) => s.parentAddr === frame.from);
  const filtered = p.status === "active" ? mine.filter(isActive)
    : p.status === "done" ? mine.filter((s) => !isActive(s))
    : mine;
  return orch.reply(frame, {
    subagents: filtered.map((s) => ({
      subagent: s.addr, name: s.name, task: s.task, status: s.status,
      spawned_at: s.spawnedAt, finished_at: s.finishedAt ?? null,
      output_preview: isActive(s) ? null : (s.output ?? "").slice(0, 200),
      session_path: s.sessionPath,
    })),
  });
}
