/**
 * wait_subagent —— 补等:发起时选了异步、事后需要汇总时,挂起等一个子到终态。
 * 已终止立即返回(幂等);挂起的 waiter 由 settle 统一唤醒(core/orchestrator.settle);
 * 显式 timeout_ms 到点回 wait_timeout——子不受影响,结果仍经 subagent_done 到达。
 */
import type { SessionBusMessage } from "@pi-desktop/contract";
import { isActive, type SubagentOrchestrator, type Waiter } from "../core/orchestrator";

export async function handleWaitSubagent(orch: SubagentOrchestrator, frame: SessionBusMessage): Promise<void> {
  const p = (frame.payload ?? {}) as { subagent?: string; timeout_ms?: number };
  const rec = orch.subs.get(p.subagent ?? "");
  if (!rec) return orch.reply(frame, { error: "unknown_subagent" });
  if (!isActive(rec)) return orch.reply(frame, { subagent: rec.addr, status: rec.status, output: rec.output ?? "" });

  const waiter: Waiter = { requestId: frame.id, from: frame.from, timer: null };
  if (typeof p.timeout_ms === "number" && p.timeout_ms > 0) {
    waiter.timer = setTimeout(() => {
      const arr = orch.waiters.get(rec.addr);
      if (arr) {
        const idx = arr.indexOf(waiter);
        if (idx >= 0) arr.splice(idx, 1);
        if (arr.length === 0) orch.waiters.delete(rec.addr);
      }
      void orch.ports.bus.send(waiter.from, "bus_response", { subagent: rec.addr, status: "wait_timeout" }, waiter.requestId).catch(() => {});
    }, p.timeout_ms);
  }
  const arr = orch.waiters.get(rec.addr) ?? [];
  arr.push(waiter);
  orch.waiters.set(rec.addr, arr);
}
