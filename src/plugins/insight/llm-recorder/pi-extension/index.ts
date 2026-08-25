/**
 * llm-recorder —— pi 内核 extension：每次 LLM 调用的请求体与响应消息落盘成 JSONL。
 *
 * 设计 docs/design/llm-recorder-design.md。要点：
 * - 写 <cwd>/.my-harness-desktop/llm-logs/<会话文件名>(.jsonl)，跟项目走；桌面插件经 fs:project 读取。
 * - seq 跟随会话文件续号:进程内首次接触某会话时扫已有分片取最大 seq,把进程计数器抬到该值——
 *   内核进程重启(应用重启/模型配置变更/restart 协调)后同一会话续写,序号不会归零碰撞,
 *   读侧按 seq 配对不会让新记录顶掉旧记录。
 * - 进程内 pending 队列配对:before 压栈记 request 行,after 挂 status,message_end(assistant)
 *   出栈写 response 行(同 seq 为一对)。连接级失败没有 status;进程崩溃留孤儿 request 行。
 * - compaction 期间的调用是 turn 外内部调用,request 行不带 turnIndex 字段(不是 null,是无 key)。
 * - 单文件超 512KB rotate:首片无编号,次片起 <名>.2.jsonl 递增(没有 .1)。桌面 readFile 限 1MB。
 * - index.json 增量统计(bytes/requests),读-改-写;损坏从空重建,漂移是有意接受(见设计 §3.4)。
 * - 开关:每请求读 <cwd>/.my-harness-desktop/config/llm-recorder.json(mtime 缓存),recordEnabled !== false
 *   即记,文件缺失默认开。
 * - 安全红线:before_provider_headers 整条不碰(含 Authorization);payload 里无凭证。
 *
 * 类型不 import 官方 @earendil-works/pi-coding-agent(内核 node_modules 里的类型仓库 tsconfig
 * 够不到)——手写用到的窄结构,与 toolgate 同纪律。任何 hook 内异常静默吞掉:记录扩展炸了
 * 不该带走会话。本文件由内核 piExtensionEnsure 随插件启停同步/摘除( ~/.pi/agent/extensions/)。
 */
import * as fs from "node:fs";
import * as path from "node:path";

interface RecorderContext {
  sessionManager: { getSessionFile(): string | undefined };
}

interface BeforeRequestEvent {
  payload: unknown;
}

interface AfterResponseEvent {
  status: number;
}

interface MessageEndEvent {
  message: { role?: string } & Record<string, unknown>;
}

interface TurnStartEvent {
  turnIndex: number;
}

export interface RecorderApi {
  on(event: "before_provider_request", handler: (event: BeforeRequestEvent, ctx: RecorderContext) => unknown): void;
  on(event: "after_provider_response", handler: (event: AfterResponseEvent, ctx: RecorderContext) => unknown): void;
  on(event: "message_end", handler: (event: MessageEndEvent, ctx: RecorderContext) => unknown): void;
  on(event: "turn_start", handler: (event: TurnStartEvent, ctx: RecorderContext) => unknown): void;
  on(event: "compaction_start" | "compaction_end", handler: (event: unknown, ctx: RecorderContext) => unknown): void;
}

const SHARD_LIMIT = 512 * 1024;

interface PendingCall {
  seq: number;
  startTs: number;
  status?: number;
}

interface ShardState {
  /** 当前写入分片序号：0 = 首片(无编号)，1 = .2.jsonl，依此类推。 */
  index: number;
  /** 当前分片已写字节。 */
  size: number;
  /** 本进程接手时磁盘上该会话全部分片的总字节(index.json 的 bytes 基准)。 */
  diskTotal: number;
  /** index.json 是否已按 diskTotal 校准过(每进程每会话只校准一次)。 */
  indexed: boolean;
  /** 接手时扫出的磁盘最大 seq(续号基准)。 */
  maxSeq: number;
  /** 是否已把进程全局 seq 抬到 maxSeq(每进程每会话只续一次)。 */
  seqSynced: boolean;
}

interface IndexFile {
  version: number;
  sessions: Record<string, { bytes: number; requests: number; updatedAt: number }>;
}

function logDir(): string {
  return path.join(process.cwd(), ".my-harness-desktop", "llm-logs");
}

function configPath(): string {
  return path.join(process.cwd(), ".my-harness-desktop", "config", "llm-recorder.json");
}

let cfgCache: { mtimeMs: number; enabled: boolean } | null = null;

function recordEnabled(): boolean {
  try {
    const st = fs.statSync(configPath());
    if (cfgCache && cfgCache.mtimeMs === st.mtimeMs) return cfgCache.enabled;
    const parsed = JSON.parse(fs.readFileSync(configPath(), "utf8")) as { recordEnabled?: unknown };
    const enabled = parsed.recordEnabled !== false;
    cfgCache = { mtimeMs: st.mtimeMs, enabled };
    return enabled;
  } catch {
    return true;
  }
}

function shardPath(dir: string, name: string, index: number): string {
  return index === 0 ? path.join(dir, name) : path.join(dir, `${name}.${index + 1}.jsonl`);
}

function fileSize(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

/** 解析分片文本取最大 seq;坏行(进程崩溃留的半截行)跳过。 */
function maxSeqInText(text: string): number {
  let max = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as { seq?: unknown };
      if (typeof parsed.seq === "number" && parsed.seq > max) max = parsed.seq;
    } catch { /* 坏行跳过 */ }
  }
  return max;
}

/** 进程内首次接触某会话：扫描已有分片，定位最新可写分片 + 磁盘总字节 + 最大 seq。 */
function initShard(dir: string, name: string): ShardState {
  let index = 0;
  let diskTotal = fileSize(shardPath(dir, name, 0));
  while (fileSize(shardPath(dir, name, index)) >= SHARD_LIMIT) {
    index += 1;
    const p = shardPath(dir, name, index);
    if (fileSize(p) === 0 && !fs.existsSync(p)) break;
    diskTotal += fileSize(p);
  }
  let maxSeq = 0;
  for (let i = 0; i <= index; i += 1) {
    const p = shardPath(dir, name, i);
    if (!fs.existsSync(p)) continue;
    try {
      maxSeq = Math.max(maxSeq, maxSeqInText(fs.readFileSync(p, "utf8")));
    } catch { /* 读失败按 0 处理——最坏回退到旧行为(seq 碰撞),不带走会话 */ }
  }
  return { index, size: fileSize(shardPath(dir, name, index)), diskTotal, indexed: false, maxSeq, seqSynced: false };
}

function updateIndex(dir: string, name: string, state: ShardState, bytes: number, isRequest: boolean): void {
  const p = path.join(dir, "index.json");
  let file: IndexFile = { version: 1, sessions: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8")) as IndexFile;
    if (parsed && typeof parsed.sessions === "object" && parsed.sessions !== null) file = parsed;
  } catch {
    // 缺失/半截 JSON:从空重建(桶按会话增量累积,历史偏低是有意接受的漂移)
  }
  const bucket = file.sessions[name] ?? { bytes: 0, requests: 0, updatedAt: 0 };
  if (!state.indexed) {
    bucket.bytes = state.diskTotal + bytes;
    state.indexed = true;
  } else {
    bucket.bytes += bytes;
  }
  if (isRequest) bucket.requests += 1;
  bucket.updatedAt = Date.now();
  file.sessions[name] = bucket;
  fs.writeFileSync(p, JSON.stringify(file), "utf8");
}

export default function llmRecorder(pi: RecorderApi): void {
  let seq = 0;
  let turnIndex: number | undefined;
  let inCompaction = false;
  const pending: PendingCall[] = [];
  const shards = new Map<string, ShardState>();

  const appendLine = (name: string, entry: Record<string, unknown>): void => {
    const dir = logDir();
    const line = `${JSON.stringify(entry)}\n`;
    const bytes = Buffer.byteLength(line);
    let state = shards.get(name);
    if (!state) {
      state = initShard(dir, name);
      shards.set(name, state);
    }
    if (state.size > 0 && state.size + bytes > SHARD_LIMIT) {
      state = { index: state.index + 1, size: 0, diskTotal: state.diskTotal, indexed: state.indexed, maxSeq: state.maxSeq, seqSynced: state.seqSynced };
      shards.set(name, state);
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(shardPath(dir, name, state.index), line, "utf8");
    state.size += bytes;
    updateIndex(dir, name, state, bytes, entry.kind === "request");
  };

  pi.on("turn_start", (event) => {
    try {
      turnIndex = event.turnIndex;
    } catch { /* 记录失败不影响会话 */ }
  });

  pi.on("compaction_start", () => {
    try {
      inCompaction = true;
    } catch { /* ignore */ }
  });

  pi.on("compaction_end", () => {
    try {
      inCompaction = false;
    } catch { /* ignore */ }
  });

  /** 首次接触某会话时把全局 seq 抬到磁盘最大 seq——进程重启后续号,避免碰撞。 */
  const ensureSeqBaseline = (name: string): void => {
    let state = shards.get(name);
    if (!state) {
      state = initShard(logDir(), name);
      shards.set(name, state);
    }
    if (!state.seqSynced) {
      if (state.maxSeq > seq) seq = state.maxSeq;
      state.seqSynced = true;
    }
  };

  pi.on("before_provider_request", (event, ctx) => {
    try {
      if (!recordEnabled()) return;
      const sf = ctx.sessionManager.getSessionFile();
      if (!sf) return;
      const name = path.basename(sf);
      ensureSeqBaseline(name);
      const mySeq = ++seq;
      pending.push({ seq: mySeq, startTs: Date.now() });
      appendLine(name, {
        seq: mySeq,
        ts: Date.now(),
        kind: "request",
        ...(turnIndex !== undefined && !inCompaction ? { turnIndex } : {}),
        payload: event.payload,
      });
    } catch { /* 记录失败不影响会话 */ }
  });

  pi.on("after_provider_response", (event) => {
    try {
      const top = pending[pending.length - 1];
      if (top) top.status = event.status;
    } catch { /* ignore */ }
  });

  pi.on("message_end", (event, ctx) => {
    try {
      const msg = event.message;
      if (!msg || msg.role !== "assistant") return;
      const head = pending.shift();
      if (!head) return;
      const sf = ctx.sessionManager.getSessionFile();
      if (!sf) return;
      appendLine(path.basename(sf), {
        seq: head.seq,
        ts: Date.now(),
        kind: "response",
        ...(head.status !== undefined ? { status: head.status } : {}),
        durationMs: Date.now() - head.startTs,
        message: msg,
      });
    } catch { /* 记录失败不影响会话 */ }
  });
}
