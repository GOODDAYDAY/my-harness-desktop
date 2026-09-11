/**
 * llm-recorder 的 dsh 内核插件 —— 每次 LLM 调用的请求配置与结果落盘成 JSONL。
 *
 * 设计 docs/design/llm-recorder-design.md §2.5（dsh 侧数据面）。与 pi 侧 pi-extension
 * 同契约、不同 hook：
 *   - pi  : before_provider_request(完整请求体) / after_provider_response(status) / message_end(组装消息)
 *   - dsh : agent/request(LlmCallConfig 配置) / agent/request-error(failure) / agent/turn-stopping(回合边界)
 *
 * 关键差异（§2.5 已定，勿"补齐"）：
 *  1. 请求侧 dsh 只给 **LlmCallConfig**（provider/model/参数），不是完整请求体——**原样记**，
 *     绝不在扩展内自持对话投影去凑"等效请求体"（那是影子实现，违反 §1.6/§3.1）。dsh 的
 *     request 行因此比 pi 薄，这是内核能力差的诚实反映。
 *  2. dsh 没有对应 message_end 的响应 hook：response 行由 **(turn, step) 配对 + 边界结算**——
 *     `agent/request-error` 结算为失败（带 failure、无 status）；`agent/turn-stopping` 或下一个
 *     `agent/request` 的 (turn,step) 变化即结算上一次**成功**（message/status 均缺省，不伪造）。
 *  3. 会话文件名 = `<agent.id>.jsonl`（dsh Agent 的 id 就是 SessionId）——"一会话一文件"契约不变，
 *     读侧（desktop 渲染面板）一行不改。
 *
 * 零 import dsh 内核包（与 pi 扩展同纪律）：只用 node 内建 + ctx.on。任何 hook 内异常静默吞掉——
 * 记录扩展炸了不该带走会话。本目录由 dshExtensionEnsure 随插件启停同步到
 * ~/.dsh/.my-harness-desktop-plugins/llm-recorder/。
 */
import * as fs from "node:fs";
import * as path from "node:path";

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
    st = { seq: 0, shard: 0, size: 0, seqSynced: false, pending: null };
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

function bumpIndex(sid, bytes) {
  try {
    const idx = readIndex();
    const cur = idx.sessions[sid] ?? { bytes: 0, requests: 0, updatedAt: 0 };
    idx.sessions[sid] = { bytes: cur.bytes + bytes, requests: (cur.requests ?? 0) + 1, updatedAt: Date.now() };
    fs.mkdirSync(logDir(), { recursive: true });
    fs.writeFileSync(path.join(logDir(), "index.json"), JSON.stringify(idx), "utf8");
  } catch { /* 统计漂移有意接受(见设计 §3.4) */ }
}

/** 接手时扫已有分片:取总字节(index 基准)与最大 seq(续号基准)——进程重启后不归零碰撞。 */
function syncFromDisk(sid, st) {
  const dir = logDir();
  const fileName = `${sid}.jsonl`;
  if (st.seqSynced) return;
  st.seqSynced = true;
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
    // syncFromDisk 由 appendLine 调用，而 appendLine 的调用点**在 seq 已经分配之后**：
    // 首次写入时文件还不存在 ⇒ maxSeq = 0 ⇒ `st.seq = 0` 把刚分配的 1 抹掉，
    // 于是下一次请求又从 1 开始 —— **同一会话的第二次请求与第一次撞 seq**。
    // 后果不是"序号难看"：读侧 pairRecords 按 seq 配对/去重，撞号会让记录互相覆盖，
    // 面板上表现为"只看到最后一条 / 记录没了"（用户症状「dsh 内核执行时右侧请求记录没有记录」）。
    // pi 侧同名逻辑一直是对的（pi-extension/index.ts 的 `if (state.maxSeq > seq) seq = state.maxSeq`），
    // 这一条是两份实现之间的漂移 —— 本文件的 dsh-extension-flow.test.ts 是两侧共同的不变式守卫。
    if (maxSeq > st.seq) st.seq = maxSeq;
    // 当前分片的已写字节 = 该分片文件大小
    try { st.size = fs.statSync(shardPath(dir, fileName, st.shard)).size; } catch { st.size = 0; }
  } catch { /* 目录还没建 */ }
}

function appendLine(sid, row) {
  const dir = logDir();
  fs.mkdirSync(dir, { recursive: true });
  const st = stateOf(sid);
  syncFromDisk(sid, st);
  const fileName = `${sid}.jsonl`;
  if (st.size >= SHARD_LIMIT) {
    st.shard += 1;
  }
  const line = `${JSON.stringify(row)}\n`;
  fs.appendFileSync(shardPath(dir, fileName, st.shard), line, "utf8");
  const lineBytes = Buffer.byteLength(line);
  st.size += lineBytes;
  // 每次追加都增量记账(bytes/requests 都是累计量)。不做「一次性按磁盘总量校准」——
  // 那会把上次进程已记过的字节再记一遍(双计),而累计语义本来就是对的。
  bumpIndex(sid, lineBytes);
}

/** 结算上一次未落 response 的调用:成功(无 status/message,不伪造 dsh 没给的东西)。 */
function settleSuccess(st) {
  const p = st.pending;
  if (!p) return;
  st.pending = null;
  appendLine(p.sid, { seq: p.seq, ts: Date.now(), kind: "response", durationMs: Date.now() - p.startTs });
}

export function apply(ctx) {
  // agent/request 是 waterfall:只读 next() 的返回值,**原样 return cfg**,绝不改写配置。
  ctx.on("agent/request", async (payload, next) => {
    const cfg = await next();
    try {
      const sid = payload?.agent?.id;
      if (typeof sid === "string" && sid && recordEnabled()) {
        const st = stateOf(sid);
        // (turn, step) 变化即视为上一次成功结算
        const key = `${payload.turn}:${payload.step}`;
        if (st.pending && st.pending.key !== key) settleSuccess(st);
        st.seq += 1;
        st.pending = { sid, seq: st.seq, key, startTs: Date.now() };
        appendLine(sid, {
          seq: st.seq, ts: Date.now(), kind: "request",
          turnIndex: payload.turn, step: payload.step,
          payload: cfg,
        });
      }
    } catch { /* 记录失败不影响会话 */ }
    return cfg;
  });

  // 失败优先结算:同一 (turn, step) 的 request 行补一条带 failure 的 response 行(无 status)。
  ctx.on("agent/request-error", async (payload, next) => {
    try {
      const sid = payload?.agent?.id;
      if (typeof sid === "string" && sid) {
        const st = stateOf(sid);
        const p = st.pending;
        if (p) {
          st.pending = null;
          appendLine(sid, {
            seq: p.seq, ts: Date.now(), kind: "response",
            durationMs: Date.now() - p.startTs,
            error: payload.failure ?? true,
          });
        }
      }
    } catch { /* ignore */ }
    return next();
  });

  // 回合边界:把该会话仍未结算的调用收成成功行(回合关闭即这次调用没失败)。
  ctx.on("agent/turn-stopping", async (payload, next) => {
    try {
      const sid = payload?.agent?.id;
      if (typeof sid === "string" && sid) settleSuccess(stateOf(sid));
    } catch { /* ignore */ }
    return next();
  });
}

export default { name, apply };
