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
import type { NeutralMessage } from "../../domain/events/session-state";

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
      // 读第一行(header)
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

/**
 * 读会话 JSONL 全部消息。entry type:
 * - "message":嵌套 message 对象({role,content,timestamp}),即 NeutralMessage
 * - "custom_message":content 为字符串(customType 作 role,如 loaded instructions)
 * - 其余(model_change/thinking_level_change 等元数据)跳过
 * 损坏行跳过,不拖垮整体。
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
        } else if (j.type === "message" && j.message && typeof j.message === "object") {
          messages.push(j.message as NeutralMessage);
        } else if (j.type === "custom_message" && typeof j.content === "string") {
          messages.push({
            role: typeof j.customType === "string" ? j.customType : "custom_message",
            content: j.content,
            timestamp: typeof j.timestamp === "string" ? Date.parse(j.timestamp) : undefined,
          } as NeutralMessage);
        }
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
