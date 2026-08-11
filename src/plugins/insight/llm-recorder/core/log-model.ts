// llm-recorder 日志模型 —— 纯 TS,不 import react/ctx,可裸单测。
// 契约与 pi-extension/index.ts 的写入侧一一对应(设计 llm-recorder-design.md §3.2/§3.4)。

export interface RequestLine {
  seq: number;
  ts: number;
  kind: "request";
  /** turn 外内部调用(compaction 等)无此 key——不是 null,是字段缺失。 */
  turnIndex?: number;
  payload: unknown;
}

export interface ResponseLine {
  seq: number;
  ts: number;
  kind: "response";
  /** 连接级失败无 status(after_provider_response 未触发)。 */
  status?: number;
  durationMs?: number;
  message: unknown;
}

export type LogLine = RequestLine | ResponseLine;

export interface RecordPair {
  seq: number;
  request: RequestLine;
  /** null = 孤儿(进程崩在 before 之后),面板标「未返回」。 */
  response: ResponseLine | null;
}

/** 解析日志文本:跳过坏行(进程崩溃留的半截行)与形态不合法的行。
 *  fromLine:从第 N 行(0 基)开始解析——增量读的游标续读入口(设计
 *  docs/design/plugin-decoupling.md §6.2):只解析新增行,不重读全部历史。 */
export function parseLogText(text: string, fromLine = 0): LogLine[] {
  const rawLines = text.split("\n");
  const out: LogLine[] = [];
  for (let i = fromLine; i < rawLines.length; i++) {
    const line = rawLines[i].trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (typeof parsed.seq !== "number" || typeof parsed.ts !== "number") continue;
      if (parsed.kind === "request") out.push(parsed as unknown as RequestLine);
      else if (parsed.kind === "response") out.push(parsed as unknown as ResponseLine);
    } catch {
      // 坏行跳过
    }
  }
  return out;
}

/** 按 seq 配对,倒序(最新在前)。孤儿 response(无 request 配对,理论上不该有)丢弃。 */
export function pairRecords(lines: LogLine[]): RecordPair[] {
  const bySeq = new Map<number, RecordPair>();
  for (const l of lines) {
    if (l.kind === "request") {
      bySeq.set(l.seq, { seq: l.seq, request: l, response: null });
    } else {
      const p = bySeq.get(l.seq);
      if (p) p.response = l;
    }
  }
  return [...bySeq.values()].sort((a, b) => b.seq - a.seq);
}

/** 分片匹配:name(首片)或 name.N.jsonl(N≥2)。命中返回分片号(首片=1),否则 null。 */
export function shardNumber(fileName: string, base: string): number | null {
  if (fileName === base) return 1;
  if (!fileName.startsWith(base) || !fileName.endsWith(".jsonl")) return null;
  const mid = fileName.slice(base.length, -".jsonl".length);
  if (!/^\.\d+$/.test(mid)) return null;
  return Number(mid.slice(1));
}

export interface SessionStats {
  bytes: number;
  requests: number;
  updatedAt: number;
}

/** 解析 index.json;文件缺失/损坏返回 null(调用方按「暂无数据」展示)。 */
export function parseIndex(text: string): Record<string, SessionStats> | null {
  try {
    const parsed = JSON.parse(text) as { sessions?: unknown };
    if (!parsed || typeof parsed.sessions !== "object" || parsed.sessions === null) return null;
    return parsed.sessions as Record<string, SessionStats>;
  } catch {
    return null;
  }
}
