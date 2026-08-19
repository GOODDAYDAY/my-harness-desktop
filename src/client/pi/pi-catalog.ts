// pi 会话存储的唯一读点 —— 把 pi 的 JSONL 格式、parentId 树、cwd 桶命名、bookmark 副本路径
// 全部收在这里。对外只暴露:
//   - SessionCatalog 中性契约(PiSessionCatalog 实现,供 session-store 目录/CRUD 委托)
//   - pi 专属自由函数(piReadSessionTree / piBookmarkCopy / piDeleteBookmarkCopy,供 PiBackend 共用)
// 壳(core/application)不读 pi 存储:这一层是「存储退进内核」的落点(§7.5 不变量 #1)。
//
// 原 session-scanner.ts + project-stats.ts 的内容整体迁入本文件;同步 fs 是刻意取舍
// (会话文件大、写链路上锁原语需要同步语义)。
import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { SessionInfo, SessionDetail, SessionToolConfig, HeaderPatch } from "../../core/domain/sessions";
import { cwdToBucketName, messageContentText } from "../../core/domain/sessions";
import { sessionEntryToNeutral, deduplicateAdjacent, messageUsageOf, contextSeqItemOf, estimateContextUsageFromSeq, type ContextSeqItem, type NeutralMessage, type SessionStats, type TokenUsage, type ProjectStats, type TreeNode } from "../../core/domain/events/session-state";
import { projectLineageTree, type LineageTree, type Anchor, type SessionCatalog } from "../../core/domain/backend";
import { withDirLock, appendJsonlLine } from "../../core/application/config/config-file";
import { removePath, copyFileWithDir } from "../fs/fs-sync";

// ============ 名字/预览/叶子派生(pi JSONL 解析,私有) ============

/** 从会话全文提取会话名。名字单轨:只认 session_info 条目,以最后一条为准(空=显式清除)。 */
function extractSessionInfoName(content: string): string | undefined {
  let name: string | undefined;
  let pos = 0;
  while (pos < content.length) {
    const nl = content.indexOf("\n", pos);
    const end = nl === -1 ? content.length : nl;
    const line = content.slice(pos, end);
    pos = end + 1;
    if (!line.includes('"session_info"')) continue;
    try {
      const j = JSON.parse(line) as { type?: unknown; name?: unknown };
      if (j.type !== "session_info") continue;
      name = typeof j.name === "string" && j.name.trim() ? j.name.trim() : undefined;
    } catch {
      // 损坏行跳过
    }
  }
  return name;
}

/** 按文件读会话名(真相源 = 最后一条 session_info 条目)。 */
export function piReadSessionName(path: string): string | undefined {
  try {
    return extractSessionInfoName(readFileSync(path, "utf-8"));
  } catch {
    return undefined;
  }
}

/** 最后一条 entry 的 id(头行 type:"session" 不是 entry)。 */
function lastEntryId(content: string): string | null {
  let end = content.length;
  while (end > 0) {
    const nl = content.lastIndexOf("\n", end - 1);
    const start = nl === -1 ? 0 : nl + 1;
    const line = content.slice(start, end).trim();
    end = start > 0 ? start - 1 : 0;
    if (!line) continue;
    try {
      const j = JSON.parse(line) as { type?: unknown; id?: unknown };
      if (j.type !== "session" && typeof j.id === "string") return j.id;
    } catch {
      // 损坏行继续往上找
    }
  }
  return null;
}

/** 最后一条数据(任何条目)的时间戳:倒序找第一个带 timestamp 的行。 */
function lastEntryTime(content: string): string | undefined {
  const lines = content.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const j = JSON.parse(line) as { timestamp?: string };
      if (typeof j.timestamp === "string") return j.timestamp;
    } catch {
      // 单行损坏跳过
    }
  }
  return undefined;
}

/** 最后一条消息预览:倒序找第一条有文本的消息,前 30 字 + …(换行压成空格)。 */
function lastMessagePreview(content: string): string | undefined {
  const lines = content.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const j = JSON.parse(line) as Record<string, unknown>;
      const msg = sessionEntryToNeutral(j);
      if (msg?.role === "divider") continue;
      const text = msg ? messageContentText(msg.content) : "";
      if (text) {
        const flat = text.replace(/\s+/g, " ").trim();
        return flat.length > 30 ? flat.slice(0, 30) + "…" : flat;
      }
    } catch {
      // 单行损坏跳过
    }
  }
  return undefined;
}

// ============ 列 / 打开 ============

/** 列某 cwd 下的所有会话文件,按 modified 降序(最新在上)。 */
export function piListSessions(agentDir: string, cwd: string): SessionInfo[] {
  const sessionsRoot = join(agentDir, "sessions");
  const bucketDir = join(sessionsRoot, cwdToBucketName(cwd));
  if (!existsSync(bucketDir)) return [];

  const files = readdirSync(bucketDir).filter((f) => f.endsWith(".jsonl"));
  const sessions: SessionInfo[] = [];
  for (const file of files) {
    const fullPath = join(bucketDir, file);
    try {
      const stat = statSync(fullPath);
      const content = readFileSync(fullPath, "utf-8");
      const firstLine = content.split("\n")[0];
      if (!firstLine) continue;
      const header = JSON.parse(firstLine) as {
        type: string;
        id?: string;
        timestamp?: string;
        cwd?: string;
        "custom-my-harness-desktop"?: Record<string, unknown>;
      };
      if (header.type !== "session" || !header.id) continue;
      const custom = header["custom-my-harness-desktop"];
      sessions.push({
        path: fullPath,
        id: header.id,
        cwd: header.cwd ?? cwd,
        name: extractSessionInfoName(content),
        pinned: custom?.pinned === true,
        archived: custom?.archived === true,
        custom,
        created: header.timestamp ?? stat.mtime.toISOString(),
        modified: lastEntryTime(content) ?? stat.mtime.toISOString(),
        lastMessage: lastMessagePreview(content),
        lastEntryId: lastEntryId(content) ?? undefined,
      });
    } catch {
      // 损坏文件跳过
    }
  }
  sessions.sort((a, b) => b.modified.localeCompare(a.modified));
  return sessions;
}

/** 读会话 JSONL 全部消息(损坏行跳过)。统计基线与 messages 同一次遍历聚合(零额外 IO)。 */
export function piReadSession(path: string): SessionDetail | null {
  if (!existsSync(path)) return null;
  let header: { id?: string; timestamp?: string; cwd?: string; "custom-my-harness-desktop"?: Record<string, unknown> } = {};
  const messages: NeutralMessage[] = [];
  let infoName: string | undefined;
  let lastId: string | null = null;
  const acc = {
    userMessages: 0, assistantMessages: 0, toolCalls: 0, toolResults: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } as TokenUsage,
    cost: 0, ctxSeq: [] as ContextSeqItem[],
  };
  let modelEvidence: { provider: string; modelId: string } | undefined;
  const addUsage = (u: { tokens: TokenUsage; cost: number }): void => {
    acc.tokens.input += u.tokens.input;
    acc.tokens.output += u.tokens.output;
    acc.tokens.cacheRead += u.tokens.cacheRead;
    acc.tokens.cacheWrite += u.tokens.cacheWrite;
    acc.cost += u.cost;
  };
  try {
    const content = readFileSync(path, "utf-8");
    infoName = extractSessionInfoName(content);
    lastId = lastEntryId(content);
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line) as Record<string, unknown>;
        if (j.type === "session") {
          header = j as typeof header;
          continue;
        }
        if (j.type === "message" && j.message && typeof j.message === "object") {
          const m = j.message as Record<string, unknown>;
          acc.ctxSeq.push(contextSeqItemOf(m));
          if (m.role === "user") acc.userMessages += 1;
          else if (m.role === "assistant") {
            acc.assistantMessages += 1;
            if (typeof m.provider === "string" && typeof m.model === "string") {
              modelEvidence = { provider: m.provider, modelId: m.model };
            }
            const u = messageUsageOf(m);
            if (u) addUsage(u);
            if (Array.isArray(m.content)) {
              for (const b of m.content) {
                if (typeof b === "object" && b !== null && (b as Record<string, unknown>).type === "toolCall") acc.toolCalls += 1;
              }
            }
          } else if (m.role === "toolResult") {
            acc.toolResults += 1;
            const u = messageUsageOf(m);
            if (u) addUsage(u);
          }
        } else if (j.type === "model_change") {
          if (typeof j.provider === "string" && typeof j.modelId === "string") {
            modelEvidence = { provider: j.provider, modelId: j.modelId };
          }
        } else if (j.type === "branch_summary" || j.type === "compaction") {
          acc.ctxSeq.push({
            est: Math.ceil(String((j as Record<string, unknown>).summary ?? "").length / 4),
            anchor: null,
            compaction: j.type === "compaction",
          });
          const u = j.usage ? messageUsageOf(j) : null;
          if (u) addUsage(u);
        }
        const msg = sessionEntryToNeutral(j);
        if (msg) messages.push(msg);
      } catch {
        // 单行损坏跳过
      }
    }
  } catch {
    return null;
  }
  const stat = statSync(path);
  const messageCount = acc.userMessages + acc.assistantMessages + acc.toolResults;
  const stats: SessionStats | null = messageCount === 0 ? null : {
    userMessages: acc.userMessages,
    assistantMessages: acc.assistantMessages,
    toolCalls: acc.toolCalls,
    toolResults: acc.toolResults,
    totalMessages: messageCount,
    tokens: { ...acc.tokens, total: acc.tokens.input + acc.tokens.output + acc.tokens.cacheRead + acc.tokens.cacheWrite },
    cost: acc.cost,
    contextUsage: estimateContextUsageFromSeq(acc.ctxSeq, 0),
    tps: null,
  };
  const custom = header["custom-my-harness-desktop"];
  return {
    info: {
      path,
      id: header.id ?? "",
      cwd: header.cwd ?? "",
      name: infoName,
      pinned: custom?.pinned === true,
      archived: custom?.archived === true,
      custom,
      created: header.timestamp ?? stat.mtime.toISOString(),
      modified: stat.mtime.toISOString(),
      lastEntryId: lastId ?? undefined,
    },
    messages: deduplicateAdjacent(messages),
    stats,
    modelEvidence,
  };
}

/** 读会话 JSONL 的 lineage 树(纯文件读,不需活进程)。parentId 连成树,沿首子走主干、>1 子即分叉点。 */
export function piReadSessionTree(sessionPath: string): LineageTree {
  const empty: LineageTree = { rootId: "", lineages: [] };
  if (!existsSync(sessionPath)) return empty;
  const childrenOf = new Map<string, string[]>();
  const parentOf = new Map<string, string | null>();
  try {
    const content = readFileSync(sessionPath, "utf-8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      let j: Record<string, unknown>;
      try { j = JSON.parse(line); } catch { continue; }
      if (j.type === "session") continue;
      const id = typeof j.id === "string" ? j.id : undefined;
      if (!id) continue;
      parentOf.set(id, typeof j.parentId === "string" ? j.parentId : null);
      if (!childrenOf.has(id)) childrenOf.set(id, []);
    }
  } catch {
    return empty;
  }
  const ids = new Set(parentOf.keys());
  for (const [id, parentId] of parentOf) {
    if (parentId && ids.has(parentId)) childrenOf.get(parentId)!.push(id);
  }
  const roots: string[] = [];
  for (const [id, parentId] of parentOf) {
    if (!parentId || !ids.has(parentId)) roots.push(id);
  }
  const build = (id: string): TreeNode => ({
    entryId: id,
    children: (childrenOf.get(id) ?? []).map(build),
  });
  return projectLineageTree(roots.map(build));
}

/** 读会话文件某条 lineage 的独有条目(纯文件读,从锚点沿 parentId 首子走到底)。
 *  lineageAnchorId = 该 lineage 第一条 entry 的 entryId(根 lineage 用 rootId,分支 lineage 用
 *  分叉点 child 的 entryId);省略时读根 lineage。增量语义(session-neutral-layer.md §7.1):
 *  分支返回分叉点之后的独有条目,根返回完整链。 */
export function piReadSessionEntries(sessionPath: string, lineageAnchorId?: string): NeutralMessage[] {
  if (!existsSync(sessionPath)) return [];
  const entries = new Map<string, { parentId: string | null; msg: NeutralMessage | null }>();
  try {
    const content = readFileSync(sessionPath, "utf-8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      let j: Record<string, unknown>;
      try { j = JSON.parse(line); } catch { continue; }
      if (j.type === "session") continue;
      const id = typeof j.id === "string" ? j.id : undefined;
      if (!id) continue;
      entries.set(id, { parentId: typeof j.parentId === "string" ? j.parentId : null, msg: sessionEntryToNeutral(j) });
    }
  } catch {
    return [];
  }
  const ids = new Set(entries.keys());
  let root: string | null = null;
  for (const [id, e] of entries) {
    if (!e.parentId || !ids.has(e.parentId)) { root = id; break; }
  }
  if (!root) return [];
  const childrenOf = new Map<string, string[]>();
  for (const [id, e] of entries) {
    if (e.parentId && ids.has(e.parentId)) {
      if (!childrenOf.has(e.parentId)) childrenOf.set(e.parentId, []);
      childrenOf.get(e.parentId)!.push(id);
    }
  }
  const start = lineageAnchorId && ids.has(lineageAnchorId) ? lineageAnchorId : root;
  const out: NeutralMessage[] = [];
  let cur: string | null = start;
  while (cur) {
    const e = entries.get(cur);
    if (e?.msg) out.push(e.msg);
    cur = (childrenOf.get(cur) ?? [])[0] ?? null; // 首子 = 主干
  }
  return out;
}

// ============ 改 / 删 / 复制 ============

/** 改写会话元字段(desktop 私有数据落头行 custom-my-harness-desktop;name 单轨 append session_info)。 */
export async function piUpdateSessionHeader(path: string, patch: HeaderPatch): Promise<void> {
  if (!existsSync(path)) throw new Error(`会话文件不存在: ${path}`);
  const touchesHeader = ("pinned" in patch) || ("archived" in patch) || ("toolConfig" in patch) || ("custom" in patch);
  if (!touchesHeader) {
    if (!("name" in patch)) return;
    const content = readFileSync(path, "utf-8");
    const nl = content.indexOf("\n");
    if (nl <= 0) throw new Error("会话文件为空或缺头行");
    const head = JSON.parse(content.slice(0, nl)) as Record<string, unknown>;
    if (head.type !== "session") throw new Error("首行不是 session 头");
    const sanitized = (patch.name ?? "").replace(/[\r\n]+/g, " ").trim();
    await appendJsonlLine(path, {
      type: "session_info",
      id: randomUUID().slice(0, 8),
      parentId: lastEntryId(content),
      timestamp: new Date().toISOString(),
      name: sanitized,
    });
    return;
  }
  const dir = dirname(path);
  await withDirLock(dir, async () => {
    const content = readFileSync(path, "utf-8");
    const nl = content.indexOf("\n");
    if (nl <= 0) throw new Error("会话文件为空或缺头行");
    const header = JSON.parse(content.slice(0, nl)) as Record<string, unknown>;
    if (header.type !== "session") throw new Error("首行不是 session 头");
    let sessionInfoLine: string | null = null;
    if ("name" in patch) {
      const sanitized = (patch.name ?? "").replace(/[\r\n]+/g, " ").trim();
      sessionInfoLine = JSON.stringify({
        type: "session_info",
        id: randomUUID().slice(0, 8),
        parentId: lastEntryId(content),
        timestamp: new Date().toISOString(),
        name: sanitized,
      });
    }
    const cur = (header["custom-my-harness-desktop"] ?? {}) as Record<string, unknown>;
    if ("custom" in patch && patch.custom === null) {
      for (const k of Object.keys(cur)) delete cur[k];
    }
    if ("pinned" in patch) {
      if (patch.pinned) cur.pinned = true;
      else delete cur.pinned;
    }
    if ("archived" in patch) {
      if (patch.archived) cur.archived = true;
      else delete cur.archived;
    }
    if ("toolConfig" in patch) {
      if (patch.toolConfig) cur.toolConfig = patch.toolConfig;
      else delete cur.toolConfig;
    }
    if ("custom" in patch && patch.custom !== null && patch.custom !== undefined) {
      for (const [k, v] of Object.entries(patch.custom)) {
        if (v === null) delete cur[k];
        else cur[k] = v;
      }
    }
    if (Object.keys(cur).length === 0) delete header["custom-my-harness-desktop"];
    else header["custom-my-harness-desktop"] = cur;
    let rest = content.slice(nl);
    if (sessionInfoLine) {
      if (!rest.endsWith("\n")) rest += "\n";
      rest += sessionInfoLine + "\n";
    }
    const headerLine = JSON.stringify(header);
    const headerBytes = Buffer.byteLength(headerLine, "utf-8");
    if (headerBytes > 8192) {
      console.warn(`[pi-catalog] 会话头行 ${headerBytes}B 超 8KB 预算,custom-my-harness-desktop 读取链将静默失效: ${path}`);
    }
    await writeFile(path, headerLine + rest, "utf-8");
  });
}

/** 重命名会话:piUpdateSessionHeader 写 name 的特例。 */
export async function piRenameSession(path: string, name: string): Promise<void> {
  await piUpdateSessionHeader(path, { name });
}

/** 删除会话 JSONL(真删)。按目录分组逐目录加锁,单文件失败不拖垮整批。 */
export async function piDeleteSessionFiles(paths: string[]): Promise<void> {
  const byDir = new Map<string, string[]>();
  for (const p of paths) {
    const dir = dirname(p);
    const list = byDir.get(dir) ?? [];
    list.push(p);
    byDir.set(dir, list);
  }
  for (const [dir, files] of byDir) {
    await withDirLock(dir, async () => {
      for (const f of files) {
        try { removePath(f); } catch { /* 单文件失败不拖垮整批 */ }
      }
    });
  }
}

/** 只读会话头行 JSON(8KB 窗口)。 */
export function piReadSessionHeader(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(8192);
      const bytes = readSync(fd, buf, 0, buf.length, 0);
      const head = buf.toString("utf-8", 0, bytes);
      const nl = head.indexOf("\n");
      if (nl <= 0) return null;
      const header = JSON.parse(head.slice(0, nl)) as Record<string, unknown>;
      if (header.type !== "session") return null;
      return header;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** 读会话头行 custom-my-harness-desktop(同 8KB 热路径;无字段返回 null)。 */
export function piReadSessionCustom(path: string): Record<string, unknown> | null {
  const head = piReadSessionHeader(path);
  if (!head) return null;
  const custom = head["custom-my-harness-desktop"];
  return typeof custom === "object" && custom !== null ? (custom as Record<string, unknown>) : null;
}

/** 读会话头行工具配置。 */
export function piReadSessionToolConfig(path: string): SessionToolConfig | null {
  const custom = piReadSessionCustom(path);
  if (!custom) return null;
  return (custom.toolConfig as SessionToolConfig | undefined) ?? null;
}

/** 读 pi 侧车文件 desktop-context-probe.json 里某会话最近一次请求的实测 token 数
 *  (宽字符÷1.5、其余÷4);无记录/损坏返回 null。写方是 context-probe 底座扩展。 */
export function piReadContextProbeTokens(agentDir: string, sessionFile: string): number | null {
  try {
    const parsed = JSON.parse(readFileSync(join(agentDir, "desktop-context-probe.json"), "utf8")) as {
      bySession?: Record<string, { tokens?: unknown }>;
    };
    const t = parsed?.bySession?.[sessionFile]?.tokens;
    return typeof t === "number" && Number.isFinite(t) && t > 0 ? t : null;
  } catch {
    return null;
  }
}

// ============ 会话路径 + bookmark 快照(pi 私有,PiBackend/session-store 共用) ============

function stamp(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}_${randomUUID()}`;
}

/** pi 的新会话文件路径(对齐 pi 底座格式:ISO timestamp + uuid)。会话路径规则单源在此,
 *  session-store(PiSessionCatalog)与 PiBackend 共用,不再各自拼一份(契约单源)。 */
export function piNewSessionPath(agentDir: string, cwd: string): string {
  return `${agentDir}/sessions/${cwdToBucketName(cwd)}/${stamp()}.jsonl`;
}

/** pi 的 bookmark 快照路径(项目级:<cwd>/.my-harness-desktop/session-bookmarks/,跟随项目)。 */
export function piBookmarkPath(cwd: string): string {
  return `${cwd}/.my-harness-desktop/session-bookmarks/${stamp()}.jsonl`;
}

/** pi 的 bookmark:全量 JSONL 拷贝到项目级快照,返回 Anchor(opaque = 副本路径)。 */
export function piBookmarkCopy(cwd: string, lineageId: string, boundary: string): Anchor {
  const target = piBookmarkPath(cwd);
  copyFileWithDir(lineageId, target);
  return { lineageId, boundary, opaque: target };
}

/** pi 的删除书签:回收 opaque 指向的快照副本。 */
export function piDeleteBookmarkCopy(anchor: Anchor): void {
  removePath(anchor.opaque);
}

// ============ 项目总统计 ============

interface FileAgg {
  mtimeMs: number;
  size: number;
  agg: ProjectStats;
}

const zeroStats = (): ProjectStats => ({
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  cost: 0, sessionCount: 0, turns: 0,
});

const fileCache = new Map<string, FileAgg>();

function parseSessionFile(path: string): ProjectStats {
  const stats = zeroStats();
  stats.sessionCount = 1;
  const content = readFileSync(path, "utf-8");
  let pos = 0;
  while (pos < content.length) {
    const nl = content.indexOf("\n", pos);
    const end = nl === -1 ? content.length : nl;
    const line = content.slice(pos, end);
    pos = end + 1;
    if (!line.includes('"message"')) continue;
    try {
      const j = JSON.parse(line) as { type?: unknown; message?: Record<string, unknown> };
      if (j.type !== "message" || !j.message) continue;
      if (j.message.role === "user") stats.turns += 1;
      const u = messageUsageOf(j.message);
      if (!u) continue;
      stats.tokens.input += u.tokens.input;
      stats.tokens.output += u.tokens.output;
      stats.tokens.cacheRead += u.tokens.cacheRead;
      stats.tokens.cacheWrite += u.tokens.cacheWrite;
      stats.tokens.total += u.tokens.total;
      stats.cost += u.cost;
    } catch {
      // 损坏行跳过
    }
  }
  return stats;
}

/** 聚合某 cwd 桶的项目总统计(增量缓存按 mtime+size)。 */
export function piGetProjectStats(agentDir: string, cwd: string): ProjectStats {
  const bucketDir = join(join(agentDir, "sessions"), cwdToBucketName(cwd));
  const total = zeroStats();
  if (!existsSync(bucketDir)) return total;

  const alive = new Set<string>();
  for (const file of readdirSync(bucketDir)) {
    if (!file.endsWith(".jsonl")) continue;
    const fullPath = join(bucketDir, file);
    alive.add(fullPath);
    try {
      const st = statSync(fullPath);
      const hit = fileCache.get(fullPath);
      const fresh = hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size;
      const agg = fresh ? hit.agg : parseSessionFile(fullPath);
      if (!fresh) fileCache.set(fullPath, { mtimeMs: st.mtimeMs, size: st.size, agg });
      total.tokens.input += agg.tokens.input;
      total.tokens.output += agg.tokens.output;
      total.tokens.cacheRead += agg.tokens.cacheRead;
      total.tokens.cacheWrite += agg.tokens.cacheWrite;
      total.tokens.total += agg.tokens.total;
      total.cost += agg.cost;
      total.turns += agg.turns;
      total.sessionCount += 1;
    } catch {
      continue;
    }
  }
  for (const path of fileCache.keys()) {
    if (path.startsWith(bucketDir) && !alive.has(path)) fileCache.delete(path);
  }
  return total;
}

// ============ SessionCatalog 实现 ============

/** pi 的 SessionCatalog:目录/CRUD 的 pi 实现,读 pi 的 JSONL 存储。 */
export class PiSessionCatalog implements SessionCatalog {
  readonly kernel = "pi" as const;

  constructor(private readonly agentDir: string) {}

  async list(cwd: string): Promise<SessionInfo[]> {
    return piListSessions(this.agentDir, cwd);
  }

  async open(sessionId: string): Promise<SessionDetail | null> {
    return piReadSession(sessionId);
  }

  async rename(sessionId: string, name: string): Promise<void> {
    await piRenameSession(sessionId, name);
  }

  async updateHeader(sessionId: string, patch: HeaderPatch): Promise<void> {
    await piUpdateSessionHeader(sessionId, patch);
  }

  async deleteSessions(sessionIds: string[]): Promise<void> {
    await piDeleteSessionFiles(sessionIds);
  }

  copy(srcId: string, dstId: string): void {
    copyFileWithDir(srcId, dstId);
  }

  async readToolConfig(sessionId: string): Promise<SessionToolConfig | null> {
    return piReadSessionToolConfig(sessionId);
  }

  async readCustom(sessionId: string): Promise<Record<string, unknown> | null> {
    return piReadSessionCustom(sessionId);
  }

  contextProbeTokens(sessionId: string): number | null {
    return piReadContextProbeTokens(this.agentDir, sessionId);
  }

  newSessionId(cwd: string): string {
    return piNewSessionPath(this.agentDir, cwd);
  }

  async projectStats(cwd: string): Promise<ProjectStats> {
    return piGetProjectStats(this.agentDir, cwd);
  }

  async getTree(sessionId: string): Promise<LineageTree> {
    return piReadSessionTree(sessionId);
  }

  bookmark(cwd: string, lineageId: string, boundary: string): Anchor {
    return piBookmarkCopy(cwd, lineageId, boundary);
  }

  deleteBookmark(anchor: Anchor): void {
    piDeleteBookmarkCopy(anchor);
  }
}
