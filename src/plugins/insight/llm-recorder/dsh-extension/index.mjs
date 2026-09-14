/**
 * llm-recorder 的 dsh 内核插件 —— 每次 LLM 调用的**完整请求**与**响应内容**落盘成 JSONL。
 *
 * 设计 docs/design/llm-recorder-dsh-parity.md（根因：钩子挂错了面）。
 *
 * ## 数据面：执行面，不是构造面
 *
 * 记录挂在 `llm` 服务的 **`llm/stream` waterfall**（内核每次流式模型调用的必经之处，
 * 上游已有 dsh-agent-loop / dsh-session-title / dsh-session-checkpoint-policy 三个消费者）：
 *
 *   llm/stream(options, next)
 *     options 是 GenerateOptions —— 内核自己的类型注释：**"A single model request, fully assembled"**，
 *     含 messages（完整对话）/ system / tools（工具 schema 全量）/ provider / model / 采样参数 /
 *     sessionId / purpose。`next()` 给出该次调用的 chunk 流。
 *
 * 曾经的写法挂在 `agent/request`：那是**构造面**的钩子，契约字段就叫 `LlmCallConfig`
 * （provider/model/思考档位/采样标量五项）——messages / system / tools 不在它的契约里，
 * 不是"没取到"，是**那里根本没有**。用户症状「DSH 的请求记录一直只有 67B、核心内容全无」
 * 就是它：一条 148 字节的 `{"provider":…,"model":…}`。pi 侧之所以全量，是因为它的
 * `before_provider_request` 本来就站在执行面。两个内核对齐 = 站到同一个面上，
 * 不是把配置"补全"（补全请求体 = 造影子实现，§1.6 禁令）。
 *
 * 回合身份（turnIndex）另取 `session/event` 的 `step/start`——内核在那里**自己宣布**
 * (turn, step)；`purpose` 非空的调用（compaction / session-title）是回合外内部调用，
 * 不带 turnIndex（与 pi 侧同语义）。
 *
 * ## 四条不变量
 *
 * 1. **透传不干扰**：wrap 出的 async iterable 逐块按序原样交出下游；不缓冲整轮再吐、
 *    不改写 chunk、不吞异常。下游提前 break 时在 `finally` 里照样结算（写已组装的片段）。
 * 2. **只读不写**：options 被 loop `deepFreeze` 冻结（内核 invariant 会断言冻结），只读。
 *    落盘走显式投影，丢掉 `signal`（AbortSignal 运行时句柄，不可序列化）——见 project.mjs。
 * 3. **开关前置**：关闭时 `return next()`，零包装零开销。
 * 4. **异常静默**：任何记录侧异常吞掉，记录扩展炸了不带走会话（与 pi 侧同纪律）。
 *
 * 零 import 内核包（与 pi 扩展同纪律）：只用 node 内建 + ctx.on。本目录由
 * dshExtensionEnsure 随插件启停整目录同步到 ~/.dsh/.my-harness-desktop-plugins/llm-recorder/。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { assembleChunks, failureOf, finishText } from "./chunks.mjs";
import { createTurnTracker, projectRequest, turnIndexOf } from "./project.mjs";

export const name = "desktop-llm-recorder";

const SHARD_LIMIT = 512 * 1024;

function logDir() {
  return path.join(process.cwd(), ".my-harness-desktop", "llm-logs");
}

function configPath() {
  return path.join(process.cwd(), ".my-harness-desktop", "config", "llm-recorder.json");
}

let cfgCache = null;

/** 开关:每请求读一次(带 mtime 缓存),recordEnabled !== false 即记,文件缺失默认开。 */
function recordEnabled() {
  try {
    const st = fs.statSync(configPath());
    if (cfgCache && cfgCache.mtimeMs === st.mtimeMs) return cfgCache.enabled;
    const parsed = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    const enabled = parsed.recordEnabled !== false;
    cfgCache = { mtimeMs: st.mtimeMs, enabled };
    return enabled;
  } catch {
    return true;
  }
}

function shardPath(dir, name_, index) {
  return index === 0 ? path.join(dir, name_) : path.join(dir, `${name_}.${index + 1}.jsonl`);
}

/** 每会话的落盘状态(seq 续号、分片、index 校准)。 */
const sessions = new Map();

function stateOf(sid) {
  let st = sessions.get(sid);
  if (!st) {
    st = { seq: 0, shard: 0, size: 0, seqSynced: false };
    sessions.set(sid, st);
  }
  return st;
}

function readIndex() {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(logDir(), "index.json"), "utf8"));
    return parsed && typeof parsed === "object" && parsed.sessions ? parsed : { version: 1, sessions: {} };
  } catch {
    return { version: 1, sessions: {} };
  }
}

/** index.json 增量记账。两条口径必须与 pi 侧一致（读侧是同一个 index.json）：
 *
 *  1. `isRequest` 决定请求数是否 +1 —— 只数 request 行。此前无条件 +1（把 response 行也
 *     当成一次请求），dsh 会话的「请求总数」恒为真实值的两倍。
 *  2. **键 = 该会话首片的文件名**（`<会话标识>.jsonl`），不是裸会话标识。pi 侧用的就是
 *     会话文件名（`path.basename(sessionFile)`，自带 `.jsonl`），而这边曾传裸 sid ——
 *     同一份 index.json 里于是出现两套键空间：`{"4ee4534f….jsonl":…, "72890372…":…}`。
 *     统计页只做聚合求和，所以肉眼看不出来；但只要有人拿 index 的键去 join 会话/文件
 *     （"这个会话多大"这类），两套键立刻对不上。
 *     这条漂移是多内核 e2e 的**对账断言**抓出来的（scripts/demo/multi-kernel-round.e2e.mjs
 *     "index.json 的 requests 与实际行数一致"），守卫 dsh-extension-flow.test.ts。 */
function bumpIndex(key, bytes, isRequest) {
  try {
    const idx = readIndex();
    const cur = idx.sessions[key] ?? { bytes: 0, requests: 0, updatedAt: 0 };
    idx.sessions[key] = {
      bytes: cur.bytes + bytes,
      requests: (cur.requests ?? 0) + (isRequest ? 1 : 0),
      updatedAt: Date.now(),
    };
    fs.mkdirSync(logDir(), { recursive: true });
    fs.writeFileSync(path.join(logDir(), "index.json"), JSON.stringify(idx), "utf8");
  } catch { /* 统计漂移有意接受(见设计 §3.4) */ }
}

/** 接手时扫已有分片:取最大 seq(续号基准)与当前分片已写字节——进程重启后不归零碰撞。
 *
 *  ⚠ **必须在分配 seq 之前调用**。旧的 dsh 实现在 appendLine 内部调它，而 appendLine 的
 *  调用点在 seq 已经分配之后：首次写入时文件还不存在 ⇒ maxSeq = 0 ⇒ 刚分配的号已经用掉，
 *  sync 抬高的是"下一次"的基准 —— 同一会话重启后的第一条记录仍会与磁盘上的老号碰撞。
 *  pi 侧一直是对的（分配前 `ensureSeqBaseline`），这里对齐它。 */
function syncFromDisk(sid, st) {
  if (st.seqSynced) return;
  st.seqSynced = true;
  const dir = logDir();
  const fileName = `${sid}.jsonl`;
  try {
    const entries = fs.readdirSync(dir).filter((f) => f === fileName || f.startsWith(`${fileName}.`));
    let maxSeq = 0;
    for (const f of entries) {
      const p = path.join(dir, f);
      if (f === fileName) st.shard = 0;
      else {
        const n = Number(f.slice(fileName.length + 1).replace(/\.jsonl$/, ""));
        if (Number.isFinite(n) && n > st.shard) st.shard = n - 1;
      }
      for (const line of fs.readFileSync(p, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const o = JSON.parse(line);
          if (typeof o.seq === "number" && o.seq > maxSeq) maxSeq = o.seq;
        } catch { /* 坏行跳过 */ }
      }
    }
    // **seq 单调:只许抬高,不许压低**（根因修复，勿改回 `st.seq = maxSeq`）。
    // 首次写入时文件还不存在 ⇒ maxSeq = 0 ⇒ 压低会把已分配的号抹掉 ⇒ 撞 seq ⇒
    // 读侧 pairRecords 按 seq 配对即互相覆盖，面板表现为"只看到最后一条 / 记录没了"。
    if (maxSeq > st.seq) st.seq = maxSeq;
    try { st.size = fs.statSync(shardPath(dir, fileName, st.shard)).size; } catch { st.size = 0; }
  } catch { /* 目录还没建 */ }
}

function appendLine(sid, row) {
  const dir = logDir();
  fs.mkdirSync(dir, { recursive: true });
  const st = stateOf(sid);
  syncFromDisk(sid, st);
  const fileName = `${sid}.jsonl`;
  if (st.size >= SHARD_LIMIT) st.shard += 1;
  const line = `${JSON.stringify(row)}\n`;
  fs.appendFileSync(shardPath(dir, fileName, st.shard), line, "utf8");
  const lineBytes = Buffer.byteLength(line);
  st.size += lineBytes;
  // 键恒取**首片文件名**（fileName 就是 `<会话标识>.jsonl`），与 pi 侧同约定、也与磁盘同名。
  bumpIndex(fileName, lineBytes, row.kind === "request");
}

/** 分配该会话的下一个 seq（**先与磁盘对账再分配**，见 syncFromDisk 的警告）。 */
function allocateSeq(sid) {
  const st = stateOf(sid);
  syncFromDisk(sid, st);
  st.seq += 1;
  return st.seq;
}

/** 回合身份：session/event 的 step/start 宣布 (turn, step)，请求侧取用。 */
const turns = createTurnTracker();

/** 异常对象 → 可落盘的失败事实（只取可序列化的几个字段）。 */
function errorFact(e) {
  const message = e && typeof e.message === "string" ? e.message : String(e);
  return { kind: "error", ...(e && typeof e.code === "string" ? { code: e.code } : {}), message };
}

/**
 * 包住内核的 chunk 流：原样透传 + 顺带组装落盘。
 * @param {AsyncIterable<object>|Iterable<object>} stream `next()` 的产出
 * @param {{sid:string, seq:number, startedAt:number, model?:string, provider?:string}} call 本次调用的落盘上下文
 */
async function* recordStream(stream, call) {
  const chunks = [];
  let thrown;
  try {
    for await (const chunk of stream) {
      chunks.push(chunk);
      yield chunk;
    }
  } catch (e) {
    thrown = e;
    throw e; // 下游必须照样看见异常
  } finally {
    try {
      const { blocks, usage, finish } = assembleChunks(chunks);
      const row = { seq: call.seq, ts: Date.now(), kind: "response", durationMs: Date.now() - call.startedAt };
      const stopReason = finishText(finish);
      if (blocks.length > 0 || usage !== undefined || stopReason !== undefined) {
        row.message = {
          role: "assistant",
          content: blocks,
          ...(call.model === undefined ? {} : { model: call.model }),
          ...(call.provider === undefined ? {} : { provider: call.provider }),
          ...(usage === undefined ? {} : { usage }),
          ...(stopReason === undefined ? {} : { stopReason }),
        };
      }
      const failure = thrown !== undefined ? errorFact(thrown) : failureOf(finish);
      if (failure !== undefined) row.error = failure;
      appendLine(call.sid, row);
    } catch { /* 记录失败不影响会话 */ }
  }
}

export function apply(ctx) {
  // 回合身份（全局：子代理作用域内的会话同样要能认出来）。
  ctx.on("session/event", (session, event) => {
    try {
      if (event?.type === "step/start") turns.note(session?.id, event.turn, event.step);
    } catch { /* ignore */ }
  }, { global: true });

  // 执行面：每次流式模型调用的必经之处。prepend = 站在最上游，包住下游所有消费者看到的流。
  ctx.on("llm/stream", (options, next) => {
    let call = null;
    try {
      const sid = typeof options?.sessionId === "string" && options.sessionId ? options.sessionId : null;
      if (sid && recordEnabled()) {
        const seq = allocateSeq(sid);
        const startedAt = Date.now();
        const turnIndex = turnIndexOf(turns.current(sid), options.purpose);
        appendLine(sid, {
          seq,
          ts: startedAt,
          kind: "request",
          ...(turnIndex === undefined ? {} : { turnIndex }),
          payload: projectRequest(options),
        });
        call = { sid, seq, startedAt, model: options.model, provider: options.provider };
      }
    } catch {
      call = null; // 记录侧任何失败 → 退回纯透传
    }

    let stream;
    try {
      stream = next();
    } catch (e) {
      // 取流这一步就抛（适配器选择失败等）——下游照样收到异常，但我们记下这次失败。
      if (call) {
        try {
          appendLine(call.sid, {
            seq: call.seq, ts: Date.now(), kind: "response",
            durationMs: Date.now() - call.startedAt, error: errorFact(e),
          });
        } catch { /* ignore */ }
      }
      throw e;
    }
    return call ? recordStream(stream, call) : stream;
  }, { global: true, prepend: true });
}

export default { name, apply };
