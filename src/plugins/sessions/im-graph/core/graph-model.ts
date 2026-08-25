// im-graph/core/graph-model —— 纯 TS 图模型:不 import react、不碰 ctx,可裸单测。
// 职责:把 Session Bus 的两路输入(status 全景快照 + tap 收到的总线帧)折叠成
// "会话树 + 房间区"的图模型,并产出流动脉冲(FlowPulse)供渲染层播动画。
// 节点 ref 统一 "s:<key>" / "c:<name>" 带前缀形式,防会话 key 与房间名撞名。
import {
  isChannelAddress, isSessionAddress, sessionKeyOf, channelNameOf, truncateSessionName,
  type SessionBusMessage,
} from "@my-harness-desktop/contract";

/* ============ 模型 ============ */

export interface SessionNode {
  key: string;
  label: string;
  title: string;
  busy: boolean;
  settledAt: number | null;
  /** spawnedBy 原始地址(session:<key> | plugin:<id>),父不在图或缺失时节点落根级。 */
  spawnedBy: string | null;
}

export interface ChannelNode {
  name: string;
  throttledAt: number | null;
}

export interface GraphModel {
  sessions: Map<string, SessionNode>;
  channels: Map<string, ChannelNode>;
  /** channel name → session key 集合(只画 session 成员;plugin 成员不进图)。 */
  members: Map<string, Set<string>>;
}

export interface FlowPulse {
  id: string;
  kind: "chat" | "done" | "join" | "leave";
  /** 两点路径:[fromRef, toRef],渲染层沿直线段播粒子。 */
  path: [string, string];
  /** session_done 的完成状态(done/error/aborted),error 系染红;其余 kind 为空。 */
  status?: string;
}

export function emptyModel(): GraphModel {
  return { sessions: new Map(), channels: new Map(), members: new Map() };
}

export function sessionRef(key: string): string {
  return `s:${key}`;
}
export function channelRef(name: string): string {
  return `c:${name}`;
}

/* ============ status 快照(契约是 unknown,此处为消费方窄化的字段子集) ============ */

interface StatusSnapshot {
  sessions?: Array<{ key?: string; name?: string; busy?: boolean; cwd?: string; sessionPath?: string; spawnedBy?: string }>;
  channels?: Array<{ channel?: string; members?: string[] }>;
}

/** label 优先会话名(内核自动命名/用户命名,truncate 到显示上限);无名退回 uuid 短码。 */
function sessionLabel(s: { name?: string; sessionPath?: string }, key: string): string {
  if (typeof s.name === "string" && s.name.trim()) return truncateSessionName(s.name.trim());
  const file = s.sessionPath?.split("/").pop()?.replace(/\.jsonl$/, "") ?? "";
  const uuid = file.includes("_") ? file.slice(file.lastIndexOf("_") + 1) : file;
  return (uuid || key).slice(0, 6);
}

/** 全量重建基线;settledAt/throttledAt 是历史痕迹,跨快照保留。 */
export function applyStatus(model: GraphModel, raw: unknown): GraphModel {
  const snap = (raw ?? {}) as StatusSnapshot;
  const sessions = new Map<string, SessionNode>();
  for (const s of snap.sessions ?? []) {
    if (typeof s.key !== "string" || !s.key) continue;
    const prev = model.sessions.get(s.key);
      sessions.set(s.key, {
        key: s.key,
        label: sessionLabel(s, s.key),
        title: s.cwd ?? "",
      busy: s.busy === true,
      settledAt: prev?.settledAt ?? null,
      spawnedBy: typeof s.spawnedBy === "string" ? s.spawnedBy : null,
    });
  }
  const channels = new Map<string, ChannelNode>();
  const members = new Map<string, Set<string>>();
  for (const c of snap.channels ?? []) {
    if (typeof c.channel !== "string" || !c.channel) continue;
    const name = channelNameOf(c.channel);
    channels.set(name, { name, throttledAt: model.channels.get(name)?.throttledAt ?? null });
    const set = new Set<string>();
    for (const m of c.members ?? []) {
      if (isSessionAddress(m)) {
        const key = sessionKeyOf(m);
        if (sessions.has(key)) set.add(key);
      }
    }
    members.set(name, set);
  }
  return { sessions, channels, members };
}

/* ============ 帧增量 ============ */

export interface FrameResult {
  model: GraphModel;
  pulses: FlowPulse[];
  /** 帧里出现图上没有的会话——提醒观察层防抖 refresh 补基线。 */
  unknownSeen: boolean;
}

export function applyFrame(model: GraphModel, frame: SessionBusMessage, now: number): FrameResult {
  const pulses: FlowPulse[] = [];
  let unknownSeen = false;
  const sessions = new Map(model.sessions);
  const channels = new Map(model.channels);
  const members = new Map(model.members);

  const fromKey = isSessionAddress(frame.from) ? sessionKeyOf(frame.from) : null;
  if (fromKey && !sessions.has(fromKey)) unknownSeen = true;

  switch (frame.kind) {
    case "chat": {
      if (!fromKey || !isChannelAddress(frame.to)) break;
      const name = channelNameOf(frame.to);
      pulses.push({ id: `${frame.id}:fan`, kind: "chat", path: [sessionRef(fromKey), channelRef(name)] });
      for (const key of members.get(name) ?? []) {
        if (key !== fromKey) {
          pulses.push({ id: `${frame.id}:${key}`, kind: "chat", path: [channelRef(name), sessionRef(key)] });
        }
      }
      break;
    }
    case "peer_joined":
    case "peer_left": {
      if (!isChannelAddress(frame.to)) break;
      const name = channelNameOf(frame.to);
      const member = (frame.payload as { member?: unknown } | undefined)?.member;
      if (typeof member !== "string" || !isSessionAddress(member)) break;
      const key = sessionKeyOf(member);
      if (!sessions.has(key)) unknownSeen = true;
      const set = new Set(members.get(name) ?? []);
      if (frame.kind === "peer_joined") set.add(key);
      else set.delete(key);
      members.set(name, set);
      pulses.push({
        id: frame.id,
        kind: frame.kind === "peer_joined" ? "join" : "leave",
        path: [sessionRef(key), channelRef(name)],
      });
      break;
    }
    case "tap_event": {
      if (!fromKey) break;
      const node = sessions.get(fromKey);
      if (!node) break;
      const eventType = (frame.payload as { eventType?: unknown } | undefined)?.eventType;
      if (eventType === "agentStart") {
        sessions.set(fromKey, { ...node, busy: true });
      } else if (eventType === "agentSettled" || eventType === "agentEnd") {
        sessions.set(fromKey, { ...node, busy: false, settledAt: now });
        const parent = spawnParentRef(model, fromKey);
        if (parent) pulses.push({ id: `${frame.id}:done`, kind: "done", path: [sessionRef(fromKey), parent] });
      }
      break;
    }
    case "session_done": {
      if (!fromKey) break;
      const node = sessions.get(fromKey);
      if (node) sessions.set(fromKey, { ...node, busy: false, settledAt: now });
      const status = (frame.payload as { status?: unknown } | undefined)?.status;
      const parent = spawnParentRef(model, fromKey);
      if (parent) {
        pulses.push({
          id: frame.id, kind: "done", path: [sessionRef(fromKey), parent],
          status: typeof status === "string" ? status : undefined,
        });
      }
      break;
    }
    case "bus_throttled": {
      if (!isChannelAddress(frame.to)) break;
      const name = channelNameOf(frame.to);
      const ch = channels.get(name);
      if (ch) channels.set(name, { ...ch, throttledAt: now });
      break;
    }
    default:
      break;
  }
  return { model: { sessions, channels, members }, pulses, unknownSeen };
}

/** spawn 父节点的 ref:spawnedBy 是 session 地址且父在图内;plugin 父不算(图上无该节点)。 */
function spawnParentRef(model: GraphModel, key: string): string | null {
  const addr = model.sessions.get(key)?.spawnedBy;
  if (!addr || !isSessionAddress(addr)) return null;
  const parentKey = sessionKeyOf(addr);
  return model.sessions.has(parentKey) ? sessionRef(parentKey) : null;
}

/* ============ 边派生 ============ */

export interface GraphEdges {
  /** spawn 父子:[parentRef, childRef],会话树内的树连接线。 */
  spawn: Array<{ from: string; to: string }>;
  /** 房间成员:[sessionRef, channelRef],会话区到房间区的连线。 */
  member: Array<{ from: string; to: string }>;
}

export function edgesOf(model: GraphModel): GraphEdges {
  const spawn: GraphEdges["spawn"] = [];
  for (const key of model.sessions.keys()) {
    const parent = spawnParentRef(model, key);
    if (parent) spawn.push({ from: parent, to: sessionRef(key) });
  }
  const member: GraphEdges["member"] = [];
  for (const [name, set] of model.members) {
    for (const key of set) member.push({ from: sessionRef(key), to: channelRef(name) });
  }
  return { spawn, member };
}

/* ============ 聚焦相关集:选中会话 + spawn 直系亲属 + 其所在房间 ============ */

/** 聚焦时保留高亮的 ref 集合;其余节点/边由渲染层沉入背景(dim)。 */
export function linkedRefs(model: GraphModel, key: string): Set<string> {
  const set = new Set<string>([sessionRef(key)]);
  const parent = spawnParentRef(model, key);
  if (parent) set.add(parent);
  for (const k of model.sessions.keys()) {
    if (spawnParentRef(model, k) === sessionRef(key)) set.add(sessionRef(k));
  }
  for (const [name, members] of model.members) {
    if (members.has(key)) set.add(channelRef(name));
  }
  return set;
}

/* ============ 布局 v2:会话树在左(竖向 DFS 缩进),房间在右列 ============ */

export interface PlacedNode {
  ref: string;
  kind: "session" | "channel";
  x: number;
  y: number;
  w: number;
  h: number;
  depth: number;
}

export interface LayoutResult {
  nodes: PlacedNode[];
  width: number;
  height: number;
  /** 房间列标题位置(null = 无房间);渲染层画"房间"分段标题。 */
  channelsHeader: { x: number; y: number } | null;
}

const PAD = 8;
const ROW_H = 30;
const INDENT = 16;
const SESSION_W = 120;
const SESSION_H = 22;
const CHANNEL_X = 196;
const CHANNEL_W = 76;
const CHANNEL_H = 18;
const CHANNEL_ROW_H = 24;
const WIDTH = 280;

export function layout(model: GraphModel): LayoutResult {
  const nodes: PlacedNode[] = [];
  // spawn 树 DFS:根 = 无 spawn 父的会话;子顺序按 Map 插入序(先到先排)。
  const childrenOf = new Map<string, string[]>();
  const roots: string[] = [];
  for (const key of model.sessions.keys()) {
    const parent = spawnParentRef(model, key);
    if (parent) {
      const arr = childrenOf.get(parent) ?? [];
      arr.push(sessionRef(key));
      childrenOf.set(parent, arr);
    } else {
      roots.push(key);
    }
  }
  let row = 0;
  const yOf = new Map<string, number>();
  const walk = (ref: string, depth: number): void => {
    const y = PAD + row * ROW_H;
    nodes.push({ ref, kind: "session", depth, x: PAD + depth * INDENT, y, w: SESSION_W, h: SESSION_H });
    yOf.set(ref, y + SESSION_H / 2);
    row += 1;
    for (const child of childrenOf.get(ref) ?? []) walk(child, depth + 1);
  };
  for (const key of roots) walk(sessionRef(key), 0);
  const sessionsBottom = PAD + row * ROW_H;

  // 房间列:y 取成员中心均值(交叉天然最少);无成员房间排在会话树下方依次下排。
  const withMean: Array<{ name: string; mean: number }> = [];
  const orphans: string[] = [];
  for (const [name, members] of model.members) {
    const ys = [...members].map((k) => yOf.get(sessionRef(k))).filter((y): y is number => y != null);
    if (ys.length > 0) withMean.push({ name, mean: ys.reduce((a, b) => a + b, 0) / ys.length });
    else orphans.push(name);
  }
  withMean.sort((a, b) => a.mean - b.mean);
  let orphanY = sessionsBottom + (orphans.length > 0 ? ROW_H : 0);
  for (const { name, mean } of withMean) {
    nodes.push({ ref: channelRef(name), kind: "channel", depth: 0, x: CHANNEL_X, y: mean - CHANNEL_H / 2, w: CHANNEL_W, h: CHANNEL_H });
  }
  for (const name of orphans) {
    nodes.push({ ref: channelRef(name), kind: "channel", depth: 0, x: CHANNEL_X, y: orphanY, w: CHANNEL_W, h: CHANNEL_H });
    orphanY += CHANNEL_ROW_H;
  }

  const channelCount = model.channels.size;
  const height = Math.max(sessionsBottom, channelCount > 0 ? orphanY : 0) + PAD;
  return {
    nodes, width: WIDTH, height: Math.max(height, 40),
    channelsHeader: channelCount > 0 ? { x: CHANNEL_X, y: PAD + 2 } : null,
  };
}
