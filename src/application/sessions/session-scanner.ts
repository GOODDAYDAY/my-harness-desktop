// 会话文件扫描 —— application 层,扫 ~/.pi/agent/sessions/<cwd桶>/ 下的 JSONL。
//
// 依据 pi 底座 session-manager.js 的目录结构:
// - 会话根:~/.pi/agent/sessions/(agentDir 注入)
// - 按 cwd 分桶:目录名 --<cwd去掉首斜杠、斜杠换横线>--
// - 每会话一个 .jsonl 文件,第一行是 header({type:"session",id,timestamp,cwd,...})
//
// application 不 import electron:agentDir 由 shell 注入。
import { existsSync, readdirSync, readFileSync, statSync, copyFileSync, mkdirSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SessionInfo } from "../../domain/sessions";
import { sessionEntryToNeutral, type NeutralMessage } from "../../domain/events/session-state";
import { withDirLock } from "../config/config-file";

// SessionInfo 契约在 domain/sessions(圆心),此文件只做扫描实现;re-export 兼容既有调用方
export type { SessionInfo } from "../../domain/sessions";

/** 按 pi 底座编码规则算 cwd 桶目录名。 */
export function cwdToBucketName(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
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
      };
      if (header.type !== "session" || !header.id) continue;
      sessions.push({
        path: fullPath,
        id: header.id,
        cwd: header.cwd ?? cwd,
        name: header.name,
        pinned: header.pinned === true,
        archived: header.archived === true,
        created: header.timestamp ?? stat.mtime.toISOString(),
        // 排序键是"最后一条数据的时间"(内容时间),不是文件 mtime——
        // 重命名改写文件会刷 mtime,按 mtime 排会把改名的顶到最上(回归根因)
        modified: lastEntryTime(content) ?? stat.mtime.toISOString(),
        lastMessage: lastMessagePreview(content),
      });
    } catch {
      // 损坏文件跳过
    }
  }

  // 按 modified 降序(最新在上)
  sessions.sort((a, b) => b.modified.localeCompare(a.modified));
  return sessions;
}

/** 会话文件的全部内容(打开会话用,纯文件读、不启 pi 进程)。 */
export interface SessionDetail {
  info: SessionInfo;
  messages: NeutralMessage[];
}

/** 最近一条会话的模型/思考设置(没起 pi 时的默认值兜底,从会话条目反推)。 */
export interface RecentSessionSettings {
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
}

/** 从某会话文件内容倒序找最后的 model_change + thinking_level_change(没起 pi 时的默认值兜底)。 */
function extractRecentSettings(content: string): RecentSessionSettings {
  const lines = content.split("\n");
  let model: { provider: string; modelId: string } | undefined;
  let level: string | undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const j = JSON.parse(line) as Record<string, unknown>;
      if (!model && j.type === "model_change" && typeof j.provider === "string" && typeof j.modelId === "string") {
        model = { provider: j.provider, modelId: j.modelId };
      }
      if (!level && j.type === "thinking_level_change" && typeof j.thinkingLevel === "string") {
        level = j.thinkingLevel;
      }
      if (model && level) break;
    } catch {
      // 单行损坏跳过
    }
  }
  return { provider: model?.provider, modelId: model?.modelId, thinkingLevel: level };
}

/** 最近一条会话的模型/思考设置:扫最近会话(mtime 最大),提取最后的 model/thinking_level。
 *  没会话返回空对象。供没起 pi + 没偏好时的默认值兜底(纯文件读、不启 pi)。 */
export function recentSessionSettings(agentDir: string, cwd: string): RecentSessionSettings {
  const sessionsRoot = join(agentDir, "sessions");
  const bucketDir = join(sessionsRoot, cwdToBucketName(cwd));
  if (!existsSync(bucketDir)) return {};
  // mtime 最大的会话文件
  const files = readdirSync(bucketDir).filter((f) => f.endsWith(".jsonl"));
  let latest: string | null = null;
  let latestMtime = 0;
  for (const f of files) {
    const fp = join(bucketDir, f);
    try {
      const st = statSync(fp);
      if (st.mtimeMs > latestMtime) { latestMtime = st.mtimeMs; latest = fp; }
    } catch { /* 跳过 */ }
  }
  if (!latest) return {};
  try {
    return extractRecentSettings(readFileSync(latest, "utf-8"));
  } catch {
    return {};
  }
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
      const text = msg ? textOfContent(msg.content) : "";
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

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => typeof c === "object" && c !== null && (c as Record<string, unknown>).type === "text")
      .map((c) => String((c as Record<string, unknown>).text ?? ""))
      .join("");
  }
  return "";
}

/**
 * 改写 JSONL 头行(第一行)的可选字段,其余行原样保留。
 * 显示层以 header.name/pinned/archived 为来源,故写头行;底座 session_info 条目是另一套,不冲突。
 * 语义:name 空串=清除自定义名;pinned/archived 传 false=删字段(回退未标记);其余字段按 patch 原样写。
 */
export async function updateSessionHeader(
  path: string,
  patch: { name?: string; pinned?: boolean; archived?: boolean; toolConfig?: { mode: "all" | "custom"; enabledGroupIds?: string[] } | null },
): Promise<void> {
  if (!existsSync(path)) throw new Error(`会话文件不存在: ${path}`);
  const content = readFileSync(path, "utf-8");
  const nl = content.indexOf("\n");
  if (nl <= 0) throw new Error("会话文件为空或缺头行");
  const header = JSON.parse(content.slice(0, nl)) as Record<string, unknown>;
  if (header.type !== "session") throw new Error("首行不是 session 头");
  if ("name" in patch) {
    // 空名 = 清除自定义名(回退 id 显示;name:"" 会把 ?? 回退绕过)
    if (patch.name) header.name = patch.name;
    else delete header.name;
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
  const dir = dirname(path);
  await withDirLock(dir, () => writeFile(path, JSON.stringify(header) + content.slice(nl), "utf-8"));
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

/**
 * 读会话 JSONL 全部消息。全部条型走 domain 的 sessionEntryToNeutral 映射
 * (内容层/分隔层/隐藏层),损坏行跳过,不拖垮整体。
 */
export function readSession(path: string): SessionDetail | null {
  if (!existsSync(path)) return null;
  let header: { id?: string; timestamp?: string; cwd?: string; name?: string; pinned?: boolean; archived?: boolean } = {};
  const messages: NeutralMessage[] = [];
  try {
    const lines = readFileSync(path, "utf-8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line) as Record<string, unknown>;
        if (j.type === "session") {
          header = j as typeof header;
          continue;
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
  return {
    info: {
      path,
      id: header.id ?? "",
      cwd: header.cwd ?? "",
      name: header.name,
      pinned: header.pinned === true,
      archived: header.archived === true,
      created: header.timestamp ?? stat.mtime.toISOString(),
      modified: stat.mtime.toISOString(),
    },
    messages,
  };
}
