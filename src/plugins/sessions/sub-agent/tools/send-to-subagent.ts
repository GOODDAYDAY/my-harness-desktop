/**
 * send_to_subagent —— 父对运行中子的单向纠偏:subagent_note 帧 followUp 排队注入,
 * 不打断子当前 turn。归属校验(只能给自己的子发)+ 终态拒注(不给死会话注入)。
 */
import type { SessionBusMessage } from "@my-harness-desktop/contract";
import { isActive, type SubagentOrchestrator } from "../core/orchestrator";

export async function handleSendToSubagent(orch: SubagentOrchestrator, frame: SessionBusMessage): Promise<void> {
  const p = (frame.payload ?? {}) as { subagent?: string; message?: string };
  const rec = orch.subs.get(p.subagent ?? "");
  if (!rec || rec.parentAddr !== frame.from) return orch.reply(frame, { error: "not_your_subagent" });
  if (!isActive(rec)) return orch.reply(frame, { error: "subagent_finished", status: rec.status });
  if (typeof p.message !== "string" || !p.message) return orch.reply(frame, { error: "message_empty" });
  await orch.ports.bus.send(rec.addr, "subagent_note", { text: p.message, from_parent: frame.from });
  return orch.reply(frame, { subagent: rec.addr, delivered: true });
}
