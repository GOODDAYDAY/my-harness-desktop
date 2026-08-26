/**
 * spawn_subagent —— 派活(一轮场景搭建):tasks 批量 + wait 声明 + channel 作战室。
 * 设计 §3.1 七步:闸预检(整批原子) → 逐个子起进程 → spawn_entry_id → 写子头行 →
 * 写父 spawn entry → tap 父 + 超时闸(+拉房) → 按 wait 分流回执。
 * 递归权威闸在本文件:请求方在活跃子账上且未声明 allowSpawn → 整批拒绝。
 */
import type { SessionBusMessage } from "@my-harness-desktop/shared";
import {
  isActive,
  type BatchWaiter,
  type OrchestratorConfig,
  type SubRecord,
  type SubStatus,
  type SubagentDomain,
  type SubagentOrchestrator,
  type TaskSpec,
} from "../core/orchestrator";

function normalizeTasks(raw: unknown): TaskSpec[] {
  if (!Array.isArray(raw)) return [];
  const out: TaskSpec[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.trim()) out.push({ task: item });
    else if (item && typeof item === "object" && typeof (item as TaskSpec).task === "string") out.push(item as TaskSpec);
  }
  return out;
}

export async function handleSpawnSubagent(orch: SubagentOrchestrator, frame: SessionBusMessage): Promise<void> {
  const p = (frame.payload ?? {}) as {
    tasks?: unknown; wait?: boolean; channel?: string; cwd?: string; toolConfig?: unknown;
  };
  const tasks = normalizeTasks(p.tasks);
  if (tasks.length === 0) return orch.reply(frame, { error: "tasks_empty" });

  const callerAsSub = orch.subs.get(frame.from);
  if (callerAsSub && isActive(callerAsSub) && !callerAsSub.allowSpawn) {
    return orch.reply(frame, { error: "spawn_not_allowed", reason: "本子未声明 allowSpawn,不能再派生" });
  }

  const cfg = await orch.readConfig();
  const activeOfParent = [...orch.subs.values()].filter((s) => s.parentAddr === frame.from && isActive(s));
  if (activeOfParent.length + tasks.length > cfg.maxConcurrent) {
    return orch.reply(frame, {
      error: "max_concurrent", active: activeOfParent.length, requested: tasks.length, limit: cfg.maxConcurrent,
    });
  }

  const parent = await orch.locateRunning(frame.from);
  if (!parent) return orch.reply(frame, { error: "parent_not_running" });

  if (!orch.parentTaps.has(frame.from)) {
    orch.parentTaps.add(frame.from);
    await orch.ports.bus.tapStart({ session: frame.from, filter: "done" }).catch(() => {
      orch.parentTaps.delete(frame.from);
    });
  }

  const waitAll = p.wait === true;
  const batch: BatchWaiter = {
    requestId: frame.id, from: frame.from, remaining: new Set(), results: [],
  };
  if (waitAll) orch.batches.set(frame.id, batch);

  // 并行起全部子进程(根因修复,勿回退):此前 for-await 串行逐个 spawn,
  // 每个子 = 一个全新 pi 进程冷启动(tsx dev 下 1~2s),批量 N 个就是 N 倍累加——
  // 派 5 个活等 5~10s,体验上是"启动慢"的直接来源。并行后总时长 ≈ 单进程冷启动。
  // 并发护栏:max_concurrent 已在入口按 active+tasks 总量闸过,这里不再重闸;
  // spawnOne 内的 batch.remaining/results 变更都是同步临界区(await 点之间),
  // Promise.all 并行不引入竞态。
  const receipts: Record<string, unknown>[] = await Promise.all(
    tasks.map((t) => spawnOne(orch, frame, t, p, parent, cfg, batch)),
  );

  if (!waitAll) return orch.reply(frame, { subagents: receipts });
  if (batch.remaining.size === 0) {
    orch.batches.delete(frame.id);
    return orch.reply(frame, { subagents: batch.results });
  }
  // 尚有活跃子:settle 逐个填 batch.results,全终态后回(core/orchestrator.settle)
}

async function spawnOne(
  orch: SubagentOrchestrator,
  frame: SessionBusMessage,
  t: TaskSpec,
  p: { channel?: string; cwd?: string; toolConfig?: unknown },
  parent: { cwd: string; sessionPath: string },
  cfg: OrchestratorConfig,
  batch: BatchWaiter,
): Promise<Record<string, unknown>> {
  const name = t.name ?? t.task.slice(0, 20);
  const toolConfig = t.toolConfig ?? p.toolConfig;
  let created: { session: string; key: string; sessionPath: string };
  try {
    created = (await orch.ports.bus.sessionCreate({
      task: t.task, cwd: p.cwd, name, model: t.model, toolConfig, watch: true,
      channels: p.channel ? [p.channel] : undefined,
    })) as { session: string; key: string; sessionPath: string };
  } catch (err) {
    const failed = { subagent: "", status: "spawn_failed" as SubStatus, error: err instanceof Error ? err.message : String(err) };
    batch.results.push(failed);
    return { task: t.task, name, ...failed };
  }

  const spawnEntryId = orch.ports.uuid();
  const rec: SubRecord = {
    addr: created.session, key: created.key, sessionPath: created.sessionPath,
    cwd: parent.cwd, parentAddr: frame.from, parentSessionPath: parent.sessionPath,
    task: t.task, name, status: "running", allowSpawn: t.allowSpawn === true,
    spawnEntryId, spawnedAt: orch.ports.now(), batchId: batch.requestId, timeoutTimer: null,
  };
  orch.subs.set(rec.addr, rec);

  const domain: SubagentDomain = {
    parent_session: parent.sessionPath, spawn_entry_id: spawnEntryId, task: t.task, name,
    status: "running", allowSpawn: rec.allowSpawn, spawned_at: rec.spawnedAt,
  };
  await orch.ports.sessions.updateHeader(created.sessionPath, {
    custom: { subagent: domain, "subagent.parent_session": parent.sessionPath },
  }).catch(() => {});

  await orch.ports.configFile.append(parent.sessionPath, {
    id: spawnEntryId, type: "custom_message", customType: "subagent_spawned", display: true,
    content: JSON.stringify({
      subagent: rec.addr, subagent_session: rec.sessionPath, task: t.task, name, tool_config: toolConfig ?? null,
      // cwd 进卡片 payload:切项目后点旧卡片 reopen 仍能定位工作目录(卡片在父时间线,
      // currentCwd 已是新项目时不等于子会话的 cwd)。
      cwd: parent.cwd,
    }),
    timestamp: new Date(orch.ports.now()).toISOString(),
  }).catch(() => {});

  rec.timeoutTimer = setTimeout(() => void orch.onTimeout(rec.addr), cfg.timeoutMs);
  batch.remaining.add(rec.addr);
  orch.notify();
  return { subagent: rec.addr, subagent_session: rec.sessionPath, spawn_entry_id: spawnEntryId, status: "dispatched" };
}
