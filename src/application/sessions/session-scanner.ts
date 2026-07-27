// 会话文件扫描 —— application 层,扫 ~/.pi/agent/sessions/<cwd桶>/ 下的 JSONL。
//
// 依据 pi 底座 session-manager.js 的目录结构:
// - 会话根:~/.pi/agent/sessions/(agentDir 注入)
// - 按 cwd 分桶:目录名 --<cwd去掉首斜杠、斜杠换横线>--
// - 每会话一个 .jsonl 文件,第一行是 header({type:"session",id,timestamp,cwd,...})
//
// application 不 import electron:agentDir 由 shell 注入。
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SessionInfo } from "../../domain/sessions";
import { sessionEntryToNeutral, type NeutralMessage } from "../../domain/events/session-state";

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
      };
      if (header.type !== "session" || !header.id) continue;
      sessions.push({
        path: fullPath,
        id: header.id,
        cwd: header.cwd ?? cwd,
        name: header.name,
        created: header.timestamp ?? stat.mtime.toISOString(),
        modified: stat.mtime.toISOString(),
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
 * 读会话 JSONL 全部消息。全部条型走 domain 的 sessionEntryToNeutral 映射
 * (内容层/分隔层/隐藏层),损坏行跳过,不拖垮整体。
 */
export function readSession(path: string): SessionDetail | null {
  if (!existsSync(path)) return null;
  let header: { id?: string; timestamp?: string; cwd?: string; name?: string } = {};
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
      created: header.timestamp ?? stat.mtime.toISOString(),
      modified: stat.mtime.toISOString(),
    },
    messages,
  };
}
