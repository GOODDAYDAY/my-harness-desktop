// Session Bus 路由器 —— 会话间消息路由 + 房间 + tap + 完成通知的用例编排(application 层)。
//
// 设计:docs/design/session-bus.md。职责边界:
// - 管:地址路由(session/channel/plugin/desktop 四前缀)、房间成员、tap 闸门、
//   完成采集(agentSettled → get_last_assistant_text → session_done)、死会话清理。
// - 不管:进程 spawn 细节(session-store 的事)、Electron 跨进程(sink 接口注入)、
//   业务 kind 的语义(内容层的事,路由器只区分响应帧/事件帧分派 streamingBehavior)。
// 房间成员与 tap 全是运行时状态,不持久化(§3.4);死会话经 onProcessExit 自动清理。
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  LIFECYCLE_EVENT_TYPES, channelAddress, channelNameOf, isChannelAddress, isPluginAddress, isSessionAddress,
  pluginAddress, sessionAddress, sessionKeyOf,
  type BusTap, type SessionBusMessage, type SessionDonePayload, type SessionDoneStatus, type TapFilter,
} from "../../domain/events/session-bus";
import { messageContentText, type SessionToolConfig } from "../../domain/sessions";
import type { SessionEvent } from "../../domain/events/session-state";
import { buildSetModelCommand, buildSetSessionNameCommand } from "../../protocol/commands";
import { updateSessionHeader } from "./session-scanner";
import type { SessionStore } from "./session-store";

/** renderer 投递口(依赖倒置:bootstrap 用 webContents 实现;router 不 import electron)。 */
export interface BusRendererSink {
  broadcast(message: SessionBusMessage): void;
}

interface SessionCreatePayload {
  task?: string;
  cwd?: string;
  name?: string;
  model?: { provider: string; modelId: string };
  toolConfig?: SessionToolConfig;
  watch?: boolean;
  /** 起完即拉新会话进这些房间(不存在即创建)——"起工人 + 进作战室"一轮完成。 */
  channels?: string[];
}

const OUTPUT_TOKEN_LIMIT = 8000;
const CHARS_PER_TOKEN = 4;

export class SessionBus {
  private store: SessionStore;
  private sink: BusRendererSink;
  /** 房间名 → 成员地址集合(session:<key> 或 plugin:<id>)。 */
  private channels = new Map<string, Set<string>>();
  private taps = new Map<string, BusTap>();
  /** 被 watch 的 session key → 完成时要通知的地址集合。 */
  private watchers = new Map<string, Set<string>>();
  /** 请求去重:reqId → 已回响应(重复到达重发响应不重执行;spawn 非幂等)。 */
  private handledRequests = new Map<string, unknown>();

  constructor(store: SessionStore, sink: BusRendererSink) {
    this.store = store;
    this.sink = sink;
  }

  // ============ 进线:pi 上行帧(handleLine $bus 分支 → session-store 转发) ============

  async handleFrame(sessionKey: string, raw: Record<string, unknown>): Promise<void> {
    if (raw.$bus !== true || typeof raw.to !== "string" || typeof raw.kind !== "string") return;
    // from 传输认证:覆写为到达管道绑定的地址,自报值丢弃(§3.2 安全模型)
    const message: SessionBusMessage = {
      $bus: true,
      id: typeof raw.id === "string" ? raw.id : randomUUID(),
      from: sessionAddress(sessionKey),
      to: raw.to,
      kind: raw.kind,
      payload: raw.payload,
      timestamp: typeof raw.timestamp === "number" ? raw.timestamp : Date.now(),
      replyTo: typeof raw.replyTo === "string" ? raw.replyTo : undefined,
    };
    try {
      await this.route(message);
    } catch (err) {
      await this.respondError(message, err);
    }
  }

  // ============ 进线:全会话事件流(自动 fan + tap 分发 + 完成判定) ============

  onSessionEvent(event: SessionEvent, sessionKey: string): void {
    for (const tap of this.taps.values()) {
      if (tap.target.session !== sessionKey) continue;
      if (tap.filter === "stream" || (tap.filter === "lifecycle" && LIFECYCLE_EVENT_TYPES.has(event.type))) {
        this.deliver({
          $bus: true, id: randomUUID(), from: sessionAddress(sessionKey), to: tap.deliverTo,
          kind: "tap_event", payload: { tapId: tap.id, eventType: event.type, event }, timestamp: Date.now(),
        });
      }
    }
    if (event.type === "agentSettled") void this.settleSession(sessionKey, "done");
    if (event.type === "messageEnd") this.autoFan(sessionKey, event);
  }

  /** IM 自动路由(§3.3):成员会话的 turn 最终消息按成员关系 fan-out 到其全部房间。
   *  防回声铁律:bus 注入帧($bus 前缀可判)永远不再外 fan——断"转发再转",不断正常回复。 */
  private autoFan(sessionKey: string, event: SessionEvent): void {
    const msg = (event as { message?: { role?: string; content?: unknown } }).message;
    if (!msg || (msg.role !== "assistant" && msg.role !== "user")) return;
    const text = messageContentText(msg.content).trim();
    if (!text || looksLikeBusFrame(text)) return;
    const from = sessionAddress(sessionKey);
    for (const [name, members] of this.channels) {
      if (!members.has(from)) continue;
      if (!this.spendToken(name)) {
        this.notifyThrottled(name);
        continue;
      }
      this.broadcastToChannel(name, {
        $bus: true, id: randomUUID(), from, to: channelAddress(name),
        kind: "chat", payload: { text }, timestamp: Date.now(),
      }, from);
    }
  }

  // ============ 乒乓熔断(§3.4 硬上限:每房间令牌桶 20 条/分钟,超限丢弃 + bus_throttled) ============

  private tokenBuckets = new Map<string, { tokens: number; refillAt: number }>();
  private throttledNotifiedAt = new Map<string, number>();
  private static readonly FAN_BUCKET_CAPACITY = 20;
  private static readonly FAN_BUCKET_WINDOW_MS = 60_000;

  private spendToken(channel: string): boolean {
    const now = Date.now();
    let bucket = this.tokenBuckets.get(channel);
    if (!bucket || now >= bucket.refillAt) {
      bucket = { tokens: SessionBus.FAN_BUCKET_CAPACITY, refillAt: now + SessionBus.FAN_BUCKET_WINDOW_MS };
      this.tokenBuckets.set(channel, bucket);
    }
    if (bucket.tokens <= 0) return false;
    bucket.tokens -= 1;
    return true;
  }

  /** 熔断提示音:同一冷却窗口只发一条,不二次刷屏。 */
  private notifyThrottled(channel: string): void {
    const now = Date.now();
    if (now - (this.throttledNotifiedAt.get(channel) ?? 0) < SessionBus.FAN_BUCKET_WINDOW_MS) return;
    this.throttledNotifiedAt.set(channel, now);
    this.broadcastToChannel(channel, {
      $bus: true, id: randomUUID(), from: "desktop", to: channelAddress(channel),
      kind: "bus_throttled", payload: { channel, reason: "fan_out_budget_exceeded" }, timestamp: now,
    }, null);
  }

  // ============ 进线:进程退出(死会话清理,§3.4) ============

  onProcessExit(sessionKey: string, expected: boolean): void {
    void this.settleSession(sessionKey, expected ? "aborted" : "error");
    const addr = sessionAddress(sessionKey);
    for (const [name, members] of [...this.channels]) {
      if (members.delete(addr)) {
        this.broadcastToChannel(name, {
          $bus: true, id: randomUUID(), from: "desktop", to: channelAddress(name),
          kind: "peer_left", payload: { member: addr }, timestamp: Date.now(),
        }, null);
        if (members.size === 0) this.channels.delete(name);
      }
    }
    for (const [id, tap] of [...this.taps]) {
      if (tap.target.session === sessionKey || tap.deliverTo === addr) this.taps.delete(id);
    }
    this.watchers.delete(sessionKey);
  }

  // ============ 路由 ============

  private async route(message: SessionBusMessage): Promise<void> {
    if (message.to === "desktop") return this.handleDesktopOp(message);
    if (isSessionAddress(message.to)) return this.deliver(message);
    if (isChannelAddress(message.to)) return this.publish(message);
    if (isPluginAddress(message.to)) return this.sink.broadcast(message);
    await this.respondError(message, new Error(`undeliverable: 未知地址形态 ${message.to}`));
  }

  /** 按帧型分派 streamingBehavior(路由器固定策略:响应=steer 插队,事件=followUp 排队)。 */
  private deliver(message: SessionBusMessage): void {
    if (isSessionAddress(message.to)) {
      const key = sessionKeyOf(message.to);
      void this.store
        .sendPromptTo(key, JSON.stringify(message), message.kind === "bus_response" ? "steer" : "followUp")
        .catch(() => { /* 目标已死:投递静默失败(其 processExit 清理已广播 peer_left) */ });
      return;
    }
    if (isPluginAddress(message.to)) this.sink.broadcast(message);
  }

  private publish(message: SessionBusMessage): void {
    this.broadcastToChannel(channelNameOf(message.to), message, message.from);
  }

  /** 向房间成员 fan-out(excludeAddress 跳过发送者);房间 tap 收同帧副本。 */
  private broadcastToChannel(name: string, message: SessionBusMessage, excludeAddress: string | null): void {
    const members = this.channels.get(name);
    if (members) {
      for (const member of members) {
        if (member === excludeAddress) continue;
        if (isSessionAddress(member)) this.deliver({ ...message, id: randomUUID() });
        else if (isPluginAddress(member)) this.sink.broadcast(message);
      }
    }
    for (const tap of this.taps.values()) {
      if (tap.target.channel === name && tap.deliverTo !== excludeAddress) {
        if (isSessionAddress(tap.deliverTo)) this.deliver({ ...message, id: randomUUID() });
        else if (isPluginAddress(tap.deliverTo)) this.sink.broadcast(message);
      }
    }
  }

  // ============ desktop 内部 op(to === "desktop" 的请求;kind 即 op 名) ============

  private async handleDesktopOp(message: SessionBusMessage): Promise<void> {
    // 请求去重:同 id 重到达 → 重发缓存的响应,不重执行(spawn 非幂等)
    const cached = this.handledRequests.get(message.id);
    if (cached !== undefined) {
      await this.respond(message, cached);
      return;
    }
    const result = await this.executeOp(message.from, message.kind, message.payload);
    if (this.handledRequests.size > 500) this.handledRequests.clear();
    this.handledRequests.set(message.id, result);
    await this.respond(message, result);
  }

  private async respond(request: SessionBusMessage, payload: unknown): Promise<void> {
    this.deliver({
      $bus: true, id: randomUUID(), from: "desktop", to: request.from, kind: "bus_response",
      payload, timestamp: Date.now(), replyTo: request.id,
    });
  }

  private async respondError(request: SessionBusMessage, err: unknown): Promise<void> {
    await this.respond(request, { error: err instanceof Error ? err.message : String(err) });
  }

  private async executeOp(origin: string, op: string, raw: unknown): Promise<unknown> {
    const p = (raw ?? {}) as Record<string, unknown>;
    switch (op) {
      case "ping":
        return { pong: true };
      case "bus_status":
        return this.opBusStatus(origin);
      case "session_create":
        return this.opSessionCreate(origin, p as unknown as SessionCreatePayload);
      case "session_abort":
        return this.opSessionAbort(origin, String(p.session ?? ""));
      case "channel_member":
        return this.opChannelMember(String(p.channel ?? ""), String(p.action ?? "join"), String(p.member ?? origin));
      case "tap_start":
        return this.opTapStart(origin, p);
      case "tap_stop":
        this.taps.delete(String(p.tapId ?? ""));
        return { stopped: true };
      default:
        throw new Error(`未知 desktop op: ${op}`);
    }
  }

  /** 一轮查全景:身份 + 运行中会话 + 全部房间(含成员)+ 相关 tap——编排前的唯一查询入口。 */
  opBusStatus(origin: string): unknown {
    return {
      me: this.opWhoami(origin),
      sessions: (this.opSessions() as { sessions: unknown }).sessions,
      channels: [...this.channels].map(([name, m]) => ({ channel: name, members: [...m] })),
    };
  }

  // ============ op 实现(plugin IPC 与 extension 上行共用;origin 是地址) ============

  opWhoami(origin: string): unknown {
    const memberships = [...this.channels].filter(([, m]) => m.has(origin)).map(([name]) => channelAddress(name));
    const taps = [...this.taps.values()]
      .filter((t) => t.owner === origin || t.deliverTo === origin)
      .map((t) => ({ tapId: t.id, target: t.target, filter: t.filter, deliverTo: t.deliverTo, owner: t.owner }));
    return { address: origin, channels: memberships, taps };
  }

  opSessions(): unknown {
    return {
      sessions: this.store.getRunningSessionKeys().map((key) => ({
        address: sessionAddress(key),
        key,
        ...this.store.getCwdAndSessionPath(key),
        busy: this.store.isBusy(key),
      })),
    };
  }

  async opSessionCreate(origin: string, p: SessionCreatePayload): Promise<unknown> {
    const originKey = isSessionAddress(origin) ? sessionKeyOf(origin) : "";
    const cwd = p.cwd ?? (originKey ? this.store.getCwdAndSessionPath(originKey).cwd : "");
    if (!cwd) throw new Error("session_create 缺 cwd(调用方会话无 cwd 记录)");
    const { key, sessionPath } = await this.store.spawnSession(cwd);
    const adapter = this.store.getAdapter(key);
    if (p.name && adapter) await adapter.send(buildSetSessionNameCommand(p.name)).catch(() => {});
    if (p.model && adapter) await adapter.send(buildSetModelCommand(p.model)).catch(() => {});
    if (p.toolConfig) await updateSessionHeader(sessionPath, { toolConfig: p.toolConfig }).catch(() => {});
    if (p.watch) {
      const set = this.watchers.get(key) ?? new Set<string>();
      set.add(origin);
      this.watchers.set(key, set);
    }
    const addr = sessionAddress(key);
    for (const channel of p.channels ?? []) this.opChannelJoin(channel, addr);
    if (p.task) await this.store.sendPromptTo(key, p.task);
    return { session: addr, key, sessionPath };
  }

  opChannelMember(channel: string, action: string, member: string): unknown {
    if (action === "join") return this.opChannelJoin(channel, member);
    if (action === "leave") return this.opChannelLeave(channel, member);
    throw new Error(`channel_member 的 action 只能是 join/leave: ${action}`);
  }

  async opSessionAbort(origin: string, target: string): Promise<unknown> {
    if (!isSessionAddress(target)) throw new Error(`session_abort 目标是 session 地址: ${target}`);
    const key = sessionKeyOf(target);
    await this.store.stop(key);
    return { aborted: target, by: origin };
  }

  opChannelJoin(channel: string, member: string): unknown {
    const name = channel.replace(/^channel:/, "");
    const set = this.channels.get(name) ?? new Set<string>();
    const isNew = !set.has(member);
    set.add(member);
    this.channels.set(name, set);
    if (isNew) {
      this.broadcastToChannel(name, {
        $bus: true, id: randomUUID(), from: "desktop", to: channelAddress(name),
        kind: "peer_joined", payload: { member }, timestamp: Date.now(),
      }, null);
    }
    return { channel: channelAddress(name), member, members: [...set] };
  }

  opChannelLeave(channel: string, member: string): unknown {
    const name = channel.replace(/^channel:/, "");
    const set = this.channels.get(name);
    if (set?.delete(member)) {
      this.broadcastToChannel(name, {
        $bus: true, id: randomUUID(), from: "desktop", to: channelAddress(name),
        kind: "peer_left", payload: { member }, timestamp: Date.now(),
      }, null);
      if (set.size === 0) this.channels.delete(name);
    }
    return { channel: channelAddress(name), member, left: true };
  }

  opTapStart(origin: string, p: Record<string, unknown>): unknown {
    const target: BusTap["target"] = {};
    if (typeof p.session === "string" && p.session) target.session = sessionKeyOf(p.session);
    else if (typeof p.channel === "string" && p.channel) target.channel = p.channel.replace(/^channel:/, "");
    else throw new Error("tap_start 需要 session 或 channel 目标");
    let filter = (p.filter as TapFilter | undefined) ?? "done";
    const deliverTo = typeof p.deliverTo === "string" && p.deliverTo ? p.deliverTo : origin;
    // 闸门纪律:stream 只许 plugin 目标;session 目标降级 lifecycle 并告知(§3.5)
    let degraded = false;
    if (filter === "stream" && isSessionAddress(deliverTo)) {
      filter = "lifecycle";
      degraded = true;
    }
    const id = randomUUID().slice(0, 8);
    const tap: BusTap = { id, target, filter, deliverTo, owner: origin };
    this.taps.set(id, tap);
    if (degraded) {
      this.deliver({
        $bus: true, id: randomUUID(), from: "desktop", to: origin, kind: "tap_degraded",
        payload: { tapId: id, reason: "stream 仅 plugin 目标可用,session 目标已降级 lifecycle" }, timestamp: Date.now(),
      });
    }
    return { tapId: id, filter };
  }

  // ============ 插件面(api/ipc/bus 转调;from = plugin:<id>,框架注入) ============

  /** 插件发消息(send/publish/reply 同一路由:publish=to 填 channel 地址,reply=带 replyTo)。 */
  async pluginSend(pluginId: string, to: string, kind: string, payload: unknown, replyTo?: string): Promise<{ delivered: string }> {
    await this.route({
      $bus: true, id: randomUUID(), from: pluginAddress(pluginId), to,
      kind: kind || "chat", payload, timestamp: Date.now(), replyTo,
    });
    return { delivered: to };
  }

  pluginStatus(pluginId: string): unknown {
    return this.opBusStatus(pluginAddress(pluginId));
  }

  pluginChannelMember(pluginId: string, channel: string, action: string, member?: string): unknown {
    return this.opChannelMember(channel, action, member ?? pluginAddress(pluginId));
  }

  pluginTapStop(tapId: string): unknown {
    this.taps.delete(tapId);
    return { stopped: true };
  }

  async pluginSessionCreate(pluginId: string, opts: Record<string, unknown>): Promise<unknown> {
    return this.opSessionCreate(pluginAddress(pluginId), opts as unknown as SessionCreatePayload);
  }

  // ============ 完成通知(§4:一次性交付完整输出) ============

  private async settleSession(sessionKey: string, status: SessionDoneStatus): Promise<void> {
    const notify = new Set<string>(this.watchers.get(sessionKey) ?? []);
    for (const tap of this.taps.values()) {
      if (tap.target.session === sessionKey && tap.filter === "done") notify.add(tap.deliverTo);
    }
    if (notify.size === 0) return;
    const payload = await this.collectOutput(sessionKey, status);
    for (const addr of notify) {
      this.deliver({
        $bus: true, id: randomUUID(), from: sessionAddress(sessionKey), to: addr,
        kind: "session_done", payload, timestamp: Date.now(),
      });
    }
  }

  /** 采集最终态完整输出;超 8000 token(按 4 字符≈1 token 估)截断头 1/4 尾 3/4 并附文件路径(§4.3)。 */
  private async collectOutput(sessionKey: string, status: SessionDoneStatus): Promise<SessionDonePayload> {
    let text = await this.store.getLastAssistantTextFor(sessionKey).catch(() => "");
    const { sessionPath } = this.store.getCwdAndSessionPath(sessionKey);
    if (!text && sessionPath) text = readLastAssistantTextFromFile(sessionPath);
    const limit = OUTPUT_TOKEN_LIMIT * CHARS_PER_TOKEN;
    if (text.length > limit) {
      const head = Math.floor(limit / 4);
      const tail = limit - head;
      const elided = text.length - limit;
      text = `${text.slice(0, head)}\n\n…[${elided} chars elided]…\n\n${text.slice(-tail)}`;
      return { session: sessionAddress(sessionKey), status, output: text, sessionPath: sessionPath ?? undefined };
    }
    return { session: sessionAddress(sessionKey), status, output: text };
  }
}

/** 防回声判定:这条消息文本是不是 bus 注入帧(纯机械检查,见 §3.3 误判分析)。 */
function looksLikeBusFrame(text: string): boolean {
  if (!text.startsWith("{")) return false;
  try {
    return (JSON.parse(text) as { $bus?: unknown }).$bus === true;
  } catch {
    return false;
  }
}

/** 进程已退出时的采集回退:读 session 文件尾部最后一条 assistant 消息文本。 */
function readLastAssistantTextFromFile(sessionPath: string): string {
  try {
    const lines = readFileSync(sessionPath, "utf-8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const e = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } };
        if (e.type === "message" && e.message?.role === "assistant") {
          const text = messageContentText(e.message.content);
          if (text) return text;
        }
      } catch { /* 单行损坏跳过 */ }
    }
  } catch { /* 文件不可读按空输出 */ }
  return "";
}
