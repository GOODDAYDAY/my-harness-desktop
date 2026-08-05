// 会话文件扫描 —— application 层,扫 ~/.pi/agent/sessions/<cwd桶>/ 下的 JSONL。
//
// 依据 pi 底座 session-manager.js 的目录结构:
// - 会话根:~/.pi/agent/sessions/(agentDir 注入)
// - 按 cwd 分桶:目录名 --<cwd去掉首斜杠、斜杠换横线>--
// - 每会话一个 .jsonl 文件,第一行是 header({type:"session",id,timestamp,cwd,...})
//
// application 不 import electron:agentDir 由 shell 注入。
import { existsSync, readdirSync, readFileSync, statSync, copyFileSync, mkdirSync, rmSync, openSync, readSync, closeSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { SessionInfo, SessionDetail, SessionToolConfig, HeaderPatch } from "../../domain/sessions";
import { cwdToBucketName, messageContentText } from "../../domain/sessions";
import { sessionEntryToNeutral, deduplicateAdjacent, messageUsageOf, type NeutralMessage, type SessionStats, type TokenUsage } from "../../domain/events/session-state";
import { withDirLock } from "../config/config-file";

// SessionInfo 契约在 domain/sessions(圆心),此文件只做扫描实现;re-export 兼容既有调用方
export type { SessionInfo } from "../../domain/sessions";

/**
 * 从会话全文提取底座 session_info 轨道上的名字。语义对齐底座 session-manager.getSessionName:
 * 以最后一条 session_info 为准,name trim 后为空 = 显式清除(返回 undefined 但 found=true,
 * 调用方不得再回退头行,否则旧名字会复活)。
 *
 * 为什么需要它:名字有两条存储轨道——底座 session_info 条目(RPC set_session_name、
 * 首条消息自动命名、活跃会话改名都写这里)与 pi-desktop 私有头行 header.name(仅历史
 * 非活跃改名写的)。显示层曾只读头行,导致活跃期命名的会话永远显示 id 截断(根因)。
 * 名字真相源收敛为 session_info;头行 name 只是兼容兜底,见 updateSessionHeader。
 */
function extractSessionInfoName(content: string): { found: boolean; name?: string } {
  let found = false;
  let name: string | undefined;
  let pos = 0;
  while (pos < content.length) {
    const nl = content.indexOf("\n", pos);
    const end = nl === -1 ? content.length : nl;
    const line = content.slice(pos, end);
    pos = end + 1;
    // 快速预过滤再 parse,避免对每条 entry 都付 JSON.parse 成本
    if (!line.includes('"session_info"')) continue;
    try {
      const j = JSON.parse(line) as { type?: unknown; name?: unknown };
      if (j.type !== "session_info") continue;
      found = true;
      name = typeof j.name === "string" && j.name.trim() ? j.name.trim() : undefined;
    } catch {
      // 损坏行跳过
    }
  }
  return { found, name };
}

/** 按文件读会话名:真相源是最后一条 session_info,头行 name 兼容兜底(与 listSessions 同口径)。 */
export function readSessionName(path: string): string | undefined {
  try {
    const content = readFileSync(path, "utf-8");
    const info = extractSessionInfoName(content);
    if (info.found) return info.name;
    const first = content.split("\n")[0];
    if (!first) return undefined;
    const header = JSON.parse(first) as { name?: unknown };
    return typeof header.name === "string" && header.name.trim() ? header.name.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** 最后一条 entry 的 id(头行 type:"session" 不是 entry)。追加 entry 时作 parentId,对齐底座 leaf 语义。 */
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

/**
 * 列某 cwd 下的所有会话文件。按 mtime 降序排(最新在上)。
 * agentDir 由 shell 注入(通常 ~/.pi/agent)。
 */
export function listSessions(agentDir: string, cwd: string): SessionInfo[] {
  const sessionsRoot = join(agentDir, "sessions");
  const bucketName = cwdToBucketName(cwd);
  const bucketDir = join(sessionsRoot, bucketName);
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
        name?: string;
        pinned?: boolean;
        archived?: boolean;
        "custom-pi-desktop"?: Record<string, unknown>;
      };
      if (header.type !== "session" || !header.id) continue;
      // 名字真相源 = 最后一条 session_info;头行 header.name 只是历史兜底(见函数头注释)
      const infoName = extractSessionInfoName(content);
      sessions.push({
        path: fullPath,
        id: header.id,
        cwd: header.cwd ?? cwd,
        name: infoName.found ? infoName.name : header.name,
        pinned: header.pinned === true,
        archived: header.archived === true,
        custom: header["custom-pi-desktop"],
        created: header.timestamp ?? stat.mtime.toISOString(),
        // 排序键是"最后一条数据的时间"(内容时间),不是文件 mtime——
        // 重命名改写文件会刷 mtime,按 mtime 排会把改名的顶到最上(回归根因)
        modified: lastEntryTime(content) ?? stat.mtime.toISOString(),
        lastMessage: lastMessagePreview(content),
        lastEntryId: lastEntryId(content) ?? undefined,
      });
    } catch {
      // 损坏文件跳过
    }
  }

  // 按 modified 降序(最新在上)
  sessions.sort((a, b) => b.modified.localeCompare(a.modified));
  return sessions;
}

// SessionDetail 契约在 domain/sessions(圆心,契约单源),此处仅 re-export 兼容既有调用方
export type { SessionDetail } from "../../domain/sessions";

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

/** 最后一条消息预览:倒序找第一条有文本的消息/场景消息,前 30 字 + …(换行压成空格)。 */
function lastMessagePreview(content: string): string | undefined {
  const lines = content.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const j = JSON.parse(line) as Record<string, unknown>;
      const msg = sessionEntryToNeutral(j);
      // 预览只认消息,分隔线(模型/思考强度等元变更)不算"最后一条消息"
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

/**
 * 改写 JSONL 头行(第一行)的可选字段,其余行原样保留。
 * name 双写两条轨道:头行 name(历史数据与外部只读消费者的兜底)+ 追加一条 session_info
 * 条目(名字真相源,与底座 RPC set_session_name、首条消息自动命名同轨,scanner 以最后一
 * 条为准)。此处仅服务非活跃会话(活跃会话的 name 走 RPC 分支,见 session-store),没有
 * 底座进程在写文件,append-only 追加无读改写竞态。
 * 语义:name 空串/纯空白=清除自定义名(回退 id 显示;空名也追加 session_info 作"显式清
 * 除"标记,阻断旧名字复活);pinned/archived 传 false=删字段(回退未标记);toolConfig 传
 * null=删字段;pinned/archived/toolConfig 是 pi-desktop 私有字段,只存头行。
 */
export async function updateSessionHeader(
  path: string,
  patch: HeaderPatch,
): Promise<void> {
  if (!existsSync(path)) throw new Error(`会话文件不存在: ${path}`);
  const dir = dirname(path);
  // 读-改-写整体进锁:并发 patch 同一文件时不再互相覆盖丢更新(原先读在锁外,A/B 交叉后写者赢)。
  await withDirLock(dir, async () => {
    const content = readFileSync(path, "utf-8");
    const nl = content.indexOf("\n");
    if (nl <= 0) throw new Error("会话文件为空或缺头行");
    const header = JSON.parse(content.slice(0, nl)) as Record<string, unknown>;
    if (header.type !== "session") throw new Error("首行不是 session 头");
    let sessionInfoLine: string | null = null;
    if ("name" in patch) {
      // sanitize 对齐底座 appendSessionInfo(去换行再 trim);空名 = 清除自定义名
      // (回退 id 显示;name:"" 会把 ?? 回退绕过)
      const sanitized = (patch.name ?? "").replace(/[\r\n]+/g, " ").trim();
      if (sanitized) header.name = sanitized;
      else delete header.name;
      // 同步底座 session_info 轨道(entry 格式对齐底座 appendSessionInfo)
      sessionInfoLine = JSON.stringify({
        type: "session_info",
        id: randomUUID().slice(0, 8),
        parentId: lastEntryId(content),
        timestamp: new Date().toISOString(),
        name: sanitized,
      });
    }
    if ("pinned" in patch) {
      if (patch.pinned) header.pinned = true;
      else delete header.pinned;
    }
    if ("archived" in patch) {
      if (patch.archived) header.archived = true;
      else delete header.archived;
    }
    if ("toolConfig" in patch) {
      if (patch.toolConfig) header.toolConfig = patch.toolConfig;
      else delete header.toolConfig;
    }
    // custom:域级浅合并({k:v} 只动 k 域、域内整体替换;{k:null} 删域;null 删整字段;空壳不留)。
    // 合并在本锁内完成,调用方零负担;落盘长名 custom-pi-desktop(防撞底座字段)。
    // 设计 docs/design/session-header-custom.md §2.2/§3.2。
    if ("custom" in patch) {
      const pc = patch.custom;
      if (pc === null) {
        delete header["custom-pi-desktop"];
      } else if (pc !== undefined) {
        const cur = (header["custom-pi-desktop"] ?? {}) as Record<string, unknown>;
        for (const [k, v] of Object.entries(pc)) {
          if (v === null) delete cur[k];
          else cur[k] = v;
        }
        if (Object.keys(cur).length === 0) delete header["custom-pi-desktop"];
        else header["custom-pi-desktop"] = cur;
      }
    }
    let rest = content.slice(nl);
    if (sessionInfoLine) {
      if (!rest.endsWith("\n")) rest += "\n";
      rest += sessionInfoLine + "\n";
    }
    const headerLine = JSON.stringify(header);
    // 8KB 软信号:readSessionToolConfig 与 tool-gate 同为 8KB 窗口,超限两链静默失效——
    // 打 warning 不拒绝写入(拒绝会让插件功能不可用;约定见设计 §2.4/§6.1)。
    const headerBytes = Buffer.byteLength(headerLine, "utf-8");
    if (headerBytes > 8192) {
      console.warn(`[session-scanner] 会话头行 ${headerBytes}B 超 8KB 预算,toolConfig 读取链将静默失效: ${path}`);
    }
    await writeFile(path, headerLine + rest, "utf-8");
  });
}

/** 重命名会话:updateSessionHeader 写 name 的特例(保留旧入口,向后兼容)。 */
export async function renameSession(path: string, name: string): Promise<void> {
  await updateSessionHeader(path, { name });
}

export function copySession(srcPath: string, targetPath: string): void {
  if (!existsSync(srcPath)) throw new Error(`源会话文件不存在: ${srcPath}`);
  const targetDir = dirname(targetPath);
  if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
  copyFileSync(srcPath, targetPath);
}

export function removePath(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

/** 删除会话 JSONL 文件(真删,不可恢复)。按目录分组逐目录加锁,锁内逐文件 rm;
 *  不存在的路径跳过(force);单文件失败不拖垮整批。watcher 的 unlink 事件会触发列表重扫。 */
export async function deleteSessionFiles(paths: string[]): Promise<void> {
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
        try { rmSync(f, { force: true }); } catch { /* 单文件失败不拖垮整批 */ }
      }
    });
  }
}

/**
 * 读会话 JSONL 全部消息。全部条型走 domain 的 sessionEntryToNeutral 映射
 * (内容层/分隔层/隐藏层),损坏行跳过,不拖垮整体。
 */
export function readSession(path: string): SessionDetail | null {
  if (!existsSync(path)) return null;
  let header: { id?: string; timestamp?: string; cwd?: string; name?: string; pinned?: boolean; archived?: boolean; "custom-pi-desktop"?: Record<string, unknown> } = {};
  const messages: NeutralMessage[] = [];
  // infoName 提升到 try 外:catch 已 return null,走到 return 时必有实值
  let infoName: ReturnType<typeof extractSessionInfoName> = { found: false };
  let lastId: string | null = null;
  // 统计基线与 messages 同一次遍历聚合(零额外 IO):usage 仅挂 assistant,
  // contextUsage.tokens 取末条带 usage 的 totalTokens(compaction 后重置天然对齐底座口径)
  const acc = {
    userMessages: 0, assistantMessages: 0, toolCalls: 0, toolResults: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } as TokenUsage,
    cost: 0, lastContextTokens: null as number | null,
  };
  try {
    const content = readFileSync(path, "utf-8");
    infoName = extractSessionInfoName(content);
    lastId = lastEntryId(content);
    const lines = content.split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line) as Record<string, unknown>;
        if (j.type === "session") {
          header = j as typeof header;
          continue;
        }
        if (j.type === "message" && j.message && typeof j.message === "object") {
          const m = j.message as Record<string, unknown>;
          if (m.role === "user") acc.userMessages += 1;
          else if (m.role === "assistant") {
            acc.assistantMessages += 1;
            const u = messageUsageOf(m);
            if (u) {
              acc.tokens.input += u.tokens.input;
              acc.tokens.output += u.tokens.output;
              acc.tokens.cacheRead += u.tokens.cacheRead;
              acc.tokens.cacheWrite += u.tokens.cacheWrite;
              acc.tokens.total += u.tokens.total;
              acc.cost += u.cost;
              acc.lastContextTokens = u.tokens.total;
            }
            if (Array.isArray(m.content)) {
              for (const b of m.content) {
                if (typeof b === "object" && b !== null && (b as Record<string, unknown>).type === "toolCall") acc.toolCalls += 1;
              }
            }
          } else if (m.role === "toolResult") acc.toolResults += 1;
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
    tokens: acc.tokens,
    cost: acc.cost,
    contextUsage: acc.lastContextTokens != null
      ? { tokens: acc.lastContextTokens, contextWindow: 0, percent: null }
      : undefined,
    tps: null,
  };
  return {
    info: {
      path,
      id: header.id ?? "",
      cwd: header.cwd ?? "",
      name: infoName.found ? infoName.name : header.name,
      pinned: header.pinned === true,
      archived: header.archived === true,
      custom: header["custom-pi-desktop"],
      created: header.timestamp ?? stat.mtime.toISOString(),
      modified: stat.mtime.toISOString(),
      lastEntryId: lastId ?? undefined,
    },
    messages: deduplicateAdjacent(messages),
    stats,
  };
}

/** 读会话头行的工具配置(toolConfig 是 pi-desktop 私有头行字段;文件缺失/损坏/无配置返回 null)。
 *  只读首行前缀(8KB),不整文件扫描——发送路径每次调用,整读大文件成本高。 */
export function readSessionToolConfig(path: string): SessionToolConfig | null {
  const head = readSessionHeaderLine(path);
  if (!head) return null;
  return (head.toolConfig as SessionToolConfig | undefined) ?? null;
}

/** 只读会话头行 JSON(8KB 窗口;文件缺失/首行损坏/非 session 头返回 null)。
 *  readSessionToolConfig 与 readSessionCustom 共用的头行热路径——8KB 是 tool-gate
 *  与发送链共享的预算,头行超预算两条读取链静默失效(updateSessionHeader 超限有告警)。 */
function readSessionHeaderLine(path: string): Record<string, unknown> | null {
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

/** 读会话头行的 custom-pi-desktop 字段(同 8KB 热路径;无字段返回 null)。
 *  消费方:session-store 的 sync 回写(进程≠头时以进程为真相补头,设计
 *  docs/design/session-model-config.md §4.4)——每次 sync 都跑,必须轻量。 */
export function readSessionCustom(path: string): Record<string, unknown> | null {
  const head = readSessionHeaderLine(path);
  if (!head) return null;
  const custom = head["custom-pi-desktop"];
  return typeof custom === "object" && custom !== null ? (custom as Record<string, unknown>) : null;
}
