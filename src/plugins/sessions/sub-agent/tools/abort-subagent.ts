/**
 * abort_subagent —— 中止一个运行中的子(归属校验:只能中止自己的子;已终态幂等)。
 * 先记 abortReason 再调 sessionAbort——终态闭环由 processExit→session_done→settle
 * 完成(core/orchestrator.settle),本文件不手动 settle。
 */
import type { SessionBusMessage } from "@my-harness-desktop/contract";
import { isActive, type SubagentOrchestrator } from "../core/orchestrator";

export async function handleAbortSubagent(orch: SubagentOrchestrator, frame: SessionBusMessage): Promise<void> {
  const p = (frame.payload ?? {}) as { subagent?: string; reason?: string };
  const rec = orch.subs.get(p.subagent ?? "");
  if (!rec || rec.parentAddr !== frame.from) return orch.reply(frame, { error: "not_your_subagent" });
  if (!isActive(rec)) return orch.reply(frame, { subagent: rec.addr, status: rec.status });
  rec.abortReason = p.reason ?? "parent_abort";
  try {
    await orch.ports.bus.sessionAbort(rec.addr);
  } catch (err) {
    return orch.reply(frame, { error: "abort_failed", message: err instanceof Error ? err.message : String(err) });
  }
  return orch.reply(frame, { subagent: rec.addr, status: "aborted" });
}
