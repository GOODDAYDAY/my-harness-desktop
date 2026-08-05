/**
 * sub-agent 编排核心 —— 归属层全部逻辑(spawn 七步/状态机/资源闸/父死子清/完成转发)。
 *
 * 设计:docs/design/subagent-scheduling.md。纯 TS:不 import react、不碰 ctx——
 * 全部出站能力经 OrchestratorPorts 注入(renderer/index.tsx 组装),可裸单测。
 *
 * 关键契约:
 * - 帧只收 to === selfAddr(plugin:<ownId>) 的——bus.onMessage 是 plugin 地址帧的广播面。
 * - 递归权威闸在这里(不在 extension 自感知):请求方在活跃子账上且未声明 allowSpawn → 拒绝。
 * - 子的终态闭环:settle 由 bus 的 session_done(watch 登记=本插件)触发,abort/超时/父死
 *   都殊途同归到 processExit→settleSession→session_done,不手动补 settle。
 * - 头行写两把钥匙:subagent 域(composerPolicies 的存在性判定 + 状态持久化)+
 *   平铺 "subagent.parent_session" 键(sessionGroupings 槽是平铺直接访问)。
 */
import type { SessionBusMessage, TapFilter } from "@pi-desktop/contract";

export interface BusPort {
  sessionCreate(opts: {
    task?: string; cwd?: string; name?: string; model?: { provider: string; modelId: string };
    toolConfig?: unknown; watch?: boolean; channels?: string[];
  }): Promise<unknown>;
  sessionAbort(session: string): Promise<unknown>;
  channelMember(channel: string, action: "join" | "leave", member?: string): Promise<unknown>;
  tapStart(opts: { session?: string; channel?: string; filter?: TapFilter; deliverTo?: string }): Promise<unknown>;
  send(to: string, kind: string, payload: unknown, replyTo?: string): Promise<unknown>;
  status(): Promise<unknown>;
}

export interface SessionsPort {
  updateHeader(sessionPath: string, patch: { custom?: Record<string, unknown> | null }): Promise<void>;
  list(cwd: string): Promise<{ path: string; custom?: Record<string, unknown> }[]>;
}

export interface ConfigFilePort {
  get(path: string): Promise<Record<string, unknown>>;
  append(path: string, entry: Record<string, unknown>): Promise<void>;
}

export interface OrchestratorPorts {
  bus: BusPort;
  sessions: SessionsPort;
  configFile: ConfigFilePort;
  now(): number;
  uuid(): string;
}

export type SubStatus = "running" | "done" | "error" | "aborted" | "timeout" | "spawn_failed" | "interrupted";

export interface SubRecord {
  addr: string;
  key: string;
  sessionPath: string;
  cwd: string;
  parentAddr: string;
  parentSessionPath: string;
  task: string;
  name: string;
  status: SubStatus;
  output?: string;
  abortReason?: string;
  allowSpawn: boolean;
  spawnEntryId: string;
  spawnedAt: number;
  finishedAt?: number;
  batchId: string;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
}

interface TaskSpec {
  task: string;
  name?: string;
  model?: { provider: string; modelId: string };
  toolConfig?: unknown;
  allowSpawn?: boolean;
}

interface BatchWaiter {
  requestId: string;
  from: string;
  remaining: Set<string>;
  results: { subagent: string; status: SubStatus; output?: string; error?: string }[];
  clipOutput: boolean;
}

interface Waiter {
  requestId: string;
  from: string;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface OrchestratorConfig {
  maxConcurrent: number;
  timeoutMs: number;
}

const DEFAULT_CONFIG: OrchestratorConfig = { maxConcurrent: 5, timeoutMs: 10 * 60_000 };
const SINGLE_OUTPUT_LIMIT = 8000 * 4;
const BATCH_OUTPUT_LIMIT = 2000 * 4;

function isActive(rec: SubRecord): boolean {
  return rec.status === "running";
}

function normalizeTasks(raw: unknown): TaskSpec[] {
  if (!Array.isArray(raw)) return [];
  const out: TaskSpec[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.trim()) out.push({ task: item });
    else if (item && typeof item === "object" && typeof (item as TaskSpec).task === "string") out.push(item as TaskSpec);
  }
  return out;
}

/** 头行 custom.subagent 域的形状(写方=本插件,读方=timeline/sessions-list/本插件恢复)。 */
export interface SubagentDomain {
  parent_session: string;
  spawn_entry_id: string;
  task: string;
  name: string;
  status: SubStatus;
  allowSpawn: boolean;
  spawned_at: number;
  abort_reason?: string;
}

export class SubagentOrchestrator {
  private subs = new Map<string, SubRecord>();
  private batches = new Map<string, BatchWaiter>();
  private waiters = new Map<string, Waiter[]>();
  private parentTaps = new Set<string>();
  private listeners = new Set<() => void>();

  constructor(
    private ports: OrchestratorPorts,
    private selfAddr: string,
    private configPath: string,
  ) {}

  /** 状态面板等 UI 订阅:任何账变动后触发(轻量全量通知,读方自 getSubs)。 */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private notify(): void {
    for (const cb of this.listeners) cb();
  }

  getSubs(): SubRecord[] {
    return [...this.subs.values()].sort((a, b) => b.spawnedAt - a.spawnedAt);
  }

  getSub(addr: string): SubRecord | undefined {
    return this.subs.get(addr);
  }

  /** bus.onMessage 入口。 */
  async handleFrame(frame: SessionBusMessage): Promise<void> {
    if (frame.to !== this.selfAddr) return;
    switch (frame.kind) {
      case "subagent_ping":
        return this.reply(frame, { pong: true });
      case "spawn_subagent":
        return this.spawn(frame);
      case "list_subagents":
        return this.listSubs(frame);
      case "wait_subagent":
        return this.waitSub(frame);
      case "send_to_subagent":
        return this.sendTo(frame);
      case "abort_subagent":
        return this.abortSub(frame);
      case "session_done":
        return this.onSessionDone(frame);
      default:
        return;
    }
  }

  private async reply(req: SessionBusMessage, payload: unknown): Promise<void> {
    await this.ports.bus.send(req.from, "bus_response", payload, req.id).catch(() => {});
  }

  private async readConfig(): Promise<OrchestratorConfig> {
    try {
      const raw = await this.ports.configFile.get(this.configPath);
      const maxConcurrent = Number(raw.maxConcurrent);
      const timeoutMinutes = Number(raw.timeoutMinutes);
      return {
        maxConcurrent: Number.isFinite(maxConcurrent) && maxConcurrent > 0 ? Math.floor(maxConcurrent) : DEFAULT_CONFIG.maxConcurrent,
        timeoutMs: Number.isFinite(timeoutMinutes) && timeoutMinutes > 0 ? timeoutMinutes * 60_000 : DEFAULT_CONFIG.timeoutMs,
      };
    } catch {
      return DEFAULT_CONFIG;
    }
  }

  /** bus.status() 的运行中会话清单里查地址 → { cwd, sessionPath }(父信息/子域读回都用)。 */
  private async locateRunning(addr: string): Promise<{ key: string; cwd: string; sessionPath: string } | null> {
    try {
      const status = (await this.ports.bus.status()) as {
        sessions?: { address: string; key: string; cwd?: string; sessionPath?: string }[];
      };
      const found = (status.sessions ?? []).find((s) => s.address === addr);
      if (!found?.cwd || !found.sessionPath) return null;
      return { key: found.key, cwd: found.cwd, sessionPath: found.sessionPath };
    } catch {
      return null;
    }
  }

  // ============ spawn(§3.1 七步,tasks 整批) ============

  private async spawn(frame: SessionBusMessage): Promise<void> {
    const p = (frame.payload ?? {}) as {
      tasks?: unknown; wait?: boolean; channel?: string; cwd?: string; toolConfig?: unknown;
    };
    const tasks = normalizeTasks(p.tasks);
    if (tasks.length === 0) return this.reply(frame, { error: "tasks_empty" });

    const callerAsSub = this.subs.get(frame.from);
    if (callerAsSub && isActive(callerAsSub) && !callerAsSub.allowSpawn) {
      return this.reply(frame, { error: "spawn_not_allowed", reason: "本子未声明 allowSpawn,不能再派生" });
    }

    const cfg = await this.readConfig();
    const activeOfParent = [...this.subs.values()].filter((s) => s.parentAddr === frame.from && isActive(s));
    if (activeOfParent.length + tasks.length > cfg.maxConcurrent) {
      return this.reply(frame, {
        error: "max_concurrent", active: activeOfParent.length, requested: tasks.length, limit: cfg.maxConcurrent,
      });
    }

    const parent = await this.locateRunning(frame.from);
    if (!parent) return this.reply(frame, { error: "parent_not_running" });

    if (!this.parentTaps.has(frame.from)) {
      this.parentTaps.add(frame.from);
      await this.ports.bus.tapStart({ session: frame.from, filter: "done" }).catch(() => {
        this.parentTaps.delete(frame.from);
      });
    }

    const waitAll = p.wait === true;
    const batch: BatchWaiter = {
      requestId: frame.id, from: frame.from, remaining: new Set(), results: [], clipOutput: tasks.length > 1,
    };
    if (waitAll) this.batches.set(frame.id, batch);

    const receipts: Record<string, unknown>[] = [];
    for (const t of tasks) {
      receipts.push(await this.spawnOne(frame, t, p, parent, cfg, batch));
    }

    if (!waitAll) return this.reply(frame, { subagents: receipts });
    if (batch.remaining.size === 0) {
      this.batches.delete(frame.id);
      return this.reply(frame, { subagents: batch.results });
    }
    // 尚有活跃子:settle 逐个填 batch.results,全终态后回(见 settle)
  }

  private async spawnOne(
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
      created = (await this.ports.bus.sessionCreate({
        task: t.task, cwd: p.cwd, name, model: t.model, toolConfig, watch: true,
        channels: p.channel ? [p.channel] : undefined,
      })) as { session: string; key: string; sessionPath: string };
    } catch (err) {
      const failed = { subagent: "", status: "spawn_failed" as SubStatus, error: err instanceof Error ? err.message : String(err) };
      batch.results.push(failed);
      return { task: t.task, name, ...failed };
    }

    const spawnEntryId = this.ports.uuid();
    const rec: SubRecord = {
      addr: created.session, key: created.key, sessionPath: created.sessionPath,
      cwd: parent.cwd, parentAddr: frame.from, parentSessionPath: parent.sessionPath,
      task: t.task, name, status: "running", allowSpawn: t.allowSpawn === true,
      spawnEntryId, spawnedAt: this.ports.now(), batchId: batch.requestId, timeoutTimer: null,
    };
    this.subs.set(rec.addr, rec);

    const domain: SubagentDomain = {
      parent_session: parent.sessionPath, spawn_entry_id: spawnEntryId, task: t.task, name,
      status: "running", allowSpawn: rec.allowSpawn, spawned_at: rec.spawnedAt,
    };
    await this.ports.sessions.updateHeader(created.sessionPath, {
      custom: { subagent: domain, "subagent.parent_session": parent.sessionPath },
    }).catch(() => {});

    await this.ports.configFile.append(parent.sessionPath, {
      id: spawnEntryId, type: "custom_message", customType: "subagent_spawned", display: true,
      content: JSON.stringify({
        subagent: rec.addr, subagent_session: rec.sessionPath, task: t.task, name, tool_config: toolConfig ?? null,
      }),
      timestamp: new Date(this.ports.now()).toISOString(),
    }).catch(() => {});

    rec.timeoutTimer = setTimeout(() => void this.onTimeout(rec.addr), cfg.timeoutMs);
    batch.remaining.add(rec.addr);
    this.notify();
    return { subagent: rec.addr, subagent_session: rec.sessionPath, spawn_entry_id: spawnEntryId, status: "dispatched" };
  }

  // ============ 终态闭环:settle ============

  private onSessionDone(frame: SessionBusMessage): void {
    const p = (frame.payload ?? {}) as { session?: string; status?: string; output?: string };
    if (!p.session) return;
    const asSub = this.subs.get(p.session);
    if (asSub && isActive(asSub)) {
      void this.settle(asSub, (p.status as SubStatus) ?? "done", p.output ?? "");
      return;
    }
    if (this.parentTaps.has(p.session) && (p.status === "error" || p.status === "aborted")) {
      this.parentTaps.delete(p.session);
      void this.onParentDead(p.session);
    }
  }

  private async settle(rec: SubRecord, status: SubStatus, output: string): Promise<void> {
    if (!isActive(rec)) return;
    // abortReason 归正:abort/超时/父死殊途同归到 processExit,回来的 status 只有 error/aborted
    // 两种——真实语义(timeout/parent_crashed/parent_abort)以先记的 abortReason 为准。
    if (rec.abortReason === "timeout") status = "timeout";
    else if (rec.abortReason) status = "aborted";
    rec.status = status;
    rec.output = output;
    rec.finishedAt = this.ports.now();
    if (rec.timeoutTimer) {
      clearTimeout(rec.timeoutTimer);
      rec.timeoutTimer = null;
    }

    const latest = await this.readSubDomain(rec);
    const domain: SubagentDomain = { ...latest, status, ...(rec.abortReason ? { abort_reason: rec.abortReason } : {}) };
    await this.ports.sessions.updateHeader(rec.sessionPath, { custom: { subagent: domain } }).catch(() => {});

    await this.ports.configFile.append(rec.parentSessionPath, {
      id: this.ports.uuid(), type: "custom_message", customType: "subagent_done", display: true,
      content: JSON.stringify({ subagent: rec.addr, name: rec.name, status, output_preview: output.slice(0, 500) }),
      timestamp: new Date(this.ports.now()).toISOString(),
    }).catch(() => {});

    await this.ports.bus.send(rec.parentAddr, "subagent_done", {
      subagent: rec.addr, name: rec.name, task: rec.task, status, output, session_path: rec.sessionPath,
    }).catch(() => {});

    const batch = this.batches.get(rec.batchId);
    if (batch && batch.remaining.delete(rec.addr)) {
      batch.results.push({
        subagent: rec.addr, status,
        output: batch.clipOutput ? output.slice(0, BATCH_OUTPUT_LIMIT) : output.slice(0, SINGLE_OUTPUT_LIMIT),
      });
      if (batch.remaining.size === 0) {
        this.batches.delete(rec.batchId);
        await this.ports.bus.send(batch.from, "bus_response", { subagents: batch.results }, batch.requestId).catch(() => {});
      }
    }

    const ws = this.waiters.get(rec.addr);
    if (ws) {
      this.waiters.delete(rec.addr);
      for (const w of ws) {
        if (w.timer) clearTimeout(w.timer);
        await this.ports.bus.send(w.from, "bus_response", {
          subagent: rec.addr, status, output,
        }, w.requestId).catch(() => {});
      }
    }
    this.notify();
  }

  /** 域级浅合并是整体替换:写 status 前先读最新 subagent 域,合并后整体写回。 */
  private async readSubDomain(rec: SubRecord): Promise<SubagentDomain> {
    const fallback: SubagentDomain = {
      parent_session: rec.parentSessionPath, spawn_entry_id: rec.spawnEntryId, task: rec.task,
      name: rec.name, status: "running", allowSpawn: rec.allowSpawn, spawned_at: rec.spawnedAt,
    };
    try {
      const list = await this.ports.sessions.list(rec.cwd);
      const found = list.find((s) => s.path === rec.sessionPath);
      return (found?.custom?.subagent as SubagentDomain | undefined) ?? fallback;
    } catch {
      return fallback;
    }
  }

  private async onTimeout(addr: string): Promise<void> {
    const rec = this.subs.get(addr);
    if (!rec || !isActive(rec)) return;
    rec.abortReason = "timeout";
    await this.ports.bus.sessionAbort(addr).catch(() => {
      void this.settle(rec, "timeout", rec.output ?? "");
    });
  }

  private async onParentDead(parentAddr: string): Promise<void> {
    for (const rec of this.subs.values()) {
      if (rec.parentAddr !== parentAddr || !isActive(rec)) continue;
      rec.abortReason = "parent_crashed";
      await this.ports.bus.sessionAbort(rec.addr).catch(() => {
        void this.settle(rec, "aborted", rec.output ?? "");
      });
    }
  }

  // ============ list / wait / send / abort ============

  private listSubs(frame: SessionBusMessage): Promise<void> {
    const p = (frame.payload ?? {}) as { status?: string };
    const mine = this.getSubs().filter((s) => s.parentAddr === frame.from);
    const filtered = p.status === "active" ? mine.filter(isActive)
      : p.status === "done" ? mine.filter((s) => !isActive(s))
      : mine;
    return this.reply(frame, {
      subagents: filtered.map((s) => ({
        subagent: s.addr, name: s.name, task: s.task, status: s.status,
        spawned_at: s.spawnedAt, finished_at: s.finishedAt ?? null,
        output_preview: isActive(s) ? null : (s.output ?? "").slice(0, 200),
        session_path: s.sessionPath,
      })),
    });
  }

  private async waitSub(frame: SessionBusMessage): Promise<void> {
    const p = (frame.payload ?? {}) as { subagent?: string; timeout_ms?: number };
    const rec = this.subs.get(p.subagent ?? "");
    if (!rec) return this.reply(frame, { error: "unknown_subagent" });
    if (!isActive(rec)) return this.reply(frame, { subagent: rec.addr, status: rec.status, output: rec.output ?? "" });
    const waiter: Waiter = { requestId: frame.id, from: frame.from, timer: null };
    if (typeof p.timeout_ms === "number" && p.timeout_ms > 0) {
      waiter.timer = setTimeout(() => {
        const arr = this.waiters.get(rec.addr);
        if (arr) {
          const idx = arr.indexOf(waiter);
          if (idx >= 0) arr.splice(idx, 1);
          if (arr.length === 0) this.waiters.delete(rec.addr);
        }
        void this.ports.bus.send(waiter.from, "bus_response", { subagent: rec.addr, status: "wait_timeout" }, waiter.requestId).catch(() => {});
      }, p.timeout_ms);
    }
    const arr = this.waiters.get(rec.addr) ?? [];
    arr.push(waiter);
    this.waiters.set(rec.addr, arr);
  }

  private async sendTo(frame: SessionBusMessage): Promise<void> {
    const p = (frame.payload ?? {}) as { subagent?: string; message?: string };
    const rec = this.subs.get(p.subagent ?? "");
    if (!rec || rec.parentAddr !== frame.from) return this.reply(frame, { error: "not_your_subagent" });
    if (!isActive(rec)) return this.reply(frame, { error: "subagent_finished", status: rec.status });
    if (typeof p.message !== "string" || !p.message) return this.reply(frame, { error: "message_empty" });
    await this.ports.bus.send(rec.addr, "subagent_note", { text: p.message, from_parent: frame.from });
    return this.reply(frame, { subagent: rec.addr, delivered: true });
  }

  private async abortSub(frame: SessionBusMessage): Promise<void> {
    const p = (frame.payload ?? {}) as { subagent?: string; reason?: string };
    const rec = this.subs.get(p.subagent ?? "");
    if (!rec || rec.parentAddr !== frame.from) return this.reply(frame, { error: "not_your_subagent" });
    if (!isActive(rec)) return this.reply(frame, { subagent: rec.addr, status: rec.status });
    rec.abortReason = p.reason ?? "parent_abort";
    try {
      await this.ports.bus.sessionAbort(rec.addr);
    } catch (err) {
      return this.reply(frame, { error: "abort_failed", message: err instanceof Error ? err.message : String(err) });
    }
    return this.reply(frame, { subagent: rec.addr, status: "aborted" });
  }
}
