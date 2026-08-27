/**
 * sub-agent 编排机制层 —— 状态账、帧路由、终态闭环(settle)、公共 helper。
 * tool 处理逻辑一文件一个在 ../tools/(spawn/list/wait/send_to/abort),本文件不装它们。
 *
 * 设计:docs/design/subagent-scheduling.md。纯 TS:不 import react、不碰 ctx——
 * 全部出站能力经 OrchestratorPorts 注入(renderer/index.tsx 组装),可裸单测。
 *
 * 关键契约:
 * - 帧只收 to === selfAddr(plugin:<ownId>) 的——bus.onMessage 是 plugin 地址帧的广播面。
 * - 递归权威闸在 tools/spawn-subagent(请求方在活跃子账上且未声明 allowSpawn → 拒绝);
 *   extension 自感知只是体验层(session_start 竞态,设计 §4.3)。
 * - 子的终态闭环:settle 由 bus 的 session_done(watch 登记=本插件)触发,abort/超时/父死
 *   都殊途同归到 processExit→settleSession→session_done,不手动补 settle。
 * - 头行写两把钥匙:subagent 域(composerPolicies 的存在性判定 + 状态持久化)+
 *   平铺 "subagent.parent_session" 键(sessionGroupings 槽是平铺直接访问)。
 */
import type { SessionBusMessage, TapFilter, HeaderPatch } from "@my-harness-desktop/shared";
import { handleSpawnSubagent } from "../tools/spawn-subagent";
import { handleListSubagents } from "../tools/list-subagents";
import { handleWaitSubagent } from "../tools/wait-subagent";
import { handleSendToSubagent } from "../tools/send-to-subagent";
import { handleAbortSubagent } from "../tools/abort-subagent";

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
  updateHeader(sessionPath: string, patch: HeaderPatch): Promise<void>;
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

export interface TaskSpec {
  task: string;
  name?: string;
  model?: { provider: string; modelId: string };
  toolConfig?: unknown;
  allowSpawn?: boolean;
}

export interface BatchWaiter {
  requestId: string;
  from: string;
  remaining: Set<string>;
  results: { subagent: string; status: SubStatus; output?: string; error?: string }[];
}

export interface Waiter {
  requestId: string;
  from: string;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface OrchestratorConfig {
  maxConcurrent: number;
  timeoutMs: number;
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

export const DEFAULT_ORCHESTRATOR_CONFIG: OrchestratorConfig = { maxConcurrent: 5, timeoutMs: 10 * 60_000 };

export function isActive(rec: SubRecord): boolean {
  return rec.status === "running";
}

export class SubagentOrchestrator {
  readonly subs = new Map<string, SubRecord>();
  readonly batches = new Map<string, BatchWaiter>();
  readonly waiters = new Map<string, Waiter[]>();
  readonly parentTaps = new Set<string>();
  private listeners = new Set<() => void>();

  constructor(
    readonly ports: OrchestratorPorts,
    readonly selfAddr: string,
    readonly configPath: string,
  ) {}

  /** 状态面板等 UI 订阅:任何账变动后触发(轻量全量通知,读方自 getSubs)。 */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  notify(): void {
    for (const cb of this.listeners) cb();
  }

  getSubs(): SubRecord[] {
    return [...this.subs.values()].sort((a, b) => b.spawnedAt - a.spawnedAt);
  }

  getSub(addr: string): SubRecord | undefined {
    return this.subs.get(addr);
  }

  /** bus.onMessage 入口:ping/session_done 本层处理,5 个 tool 路由到 ../tools/ 各自文件。 */
  async handleFrame(frame: SessionBusMessage): Promise<void> {
    if (frame.to !== this.selfAddr) return;
    switch (frame.kind) {
      case "subagent_ping":
        return this.reply(frame, { pong: true });
      case "spawn_subagent":
        return handleSpawnSubagent(this, frame);
      case "list_subagents":
        return handleListSubagents(this, frame);
      case "wait_subagent":
        return handleWaitSubagent(this, frame);
      case "send_to_subagent":
        return handleSendToSubagent(this, frame);
      case "abort_subagent":
        return handleAbortSubagent(this, frame);
      case "session_done":
        return this.onSessionDone(frame);
      default:
        return;
    }
  }

  async reply(req: SessionBusMessage, payload: unknown): Promise<void> {
    await this.ports.bus.send(req.from, "bus_response", payload, req.id).catch(() => {});
  }

  /** 每次 spawn 现场读,不缓存——配置页保存即生效,免变更通知。 */
  async readConfig(): Promise<OrchestratorConfig> {
    try {
      const raw = await this.ports.configFile.get(this.configPath);
      const maxConcurrent = Number(raw.maxConcurrent);
      const timeoutMinutes = Number(raw.timeoutMinutes);
      return {
        maxConcurrent: Number.isFinite(maxConcurrent) && maxConcurrent > 0 ? Math.floor(maxConcurrent) : DEFAULT_ORCHESTRATOR_CONFIG.maxConcurrent,
        timeoutMs: Number.isFinite(timeoutMinutes) && timeoutMinutes > 0 ? timeoutMinutes * 60_000 : DEFAULT_ORCHESTRATOR_CONFIG.timeoutMs,
      };
    } catch {
      return DEFAULT_ORCHESTRATOR_CONFIG;
    }
  }

  /** bus.status() 的运行中会话清单里查地址 → { key, cwd, sessionPath }(父信息用)。 */
  async locateRunning(addr: string): Promise<{ key: string; cwd: string; sessionPath: string } | null> {
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

  /** 域级浅合并是整体替换:写 status 前先读最新 subagent 域,合并后整体写回。 */
  async readSubDomain(rec: SubRecord): Promise<SubagentDomain> {
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

  async settle(rec: SubRecord, status: SubStatus, output: string): Promise<void> {
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
      content: JSON.stringify({
        subagent: rec.addr, subagent_session: rec.sessionPath, name: rec.name, status,
        output_preview: output.slice(0, 500), cwd: rec.cwd,
      }),
      timestamp: new Date(this.ports.now()).toISOString(),
    }).catch(() => {});

    await this.ports.bus.send(rec.parentAddr, "subagent_done", {
      subagent: rec.addr, name: rec.name, task: rec.task, status, output, session_path: rec.sessionPath,
    }).catch(() => {});

    const batch = this.batches.get(rec.batchId);
    if (batch && batch.remaining.delete(rec.addr)) {
      // 完整输出回传(需求拍板:截断全删,内容零丢失)。
      batch.results.push({ subagent: rec.addr, status, output });
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

  /** 超时闸到点:先记 abortReason 再 abort,settle 由 session_done 闭环;abort 失败手动兜底。 */
  async onTimeout(addr: string): Promise<void> {
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
}
