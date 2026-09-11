#!/usr/bin/env node
// minimal 内核 CLI —— 独立内核程序(不依赖壳的任何代码),读 JSONL stdin、写 JSONL stdout。
//
// 依据 docs/design/minimal-kernel.md §4.2 协议 + §3.3 会话文件格式。这是「内核本体」:
// 一个能脱离 desktop 单独跑的进程——`echo '{"type":"send","text":"hi"}' | node minimal-cli.mjs`。
// 协议:一行一个完整 JSON 命令进、一行一个完整 JSON 事件出,无分帧无握手(单线执行器,
// 同一时刻一个回合,命令与事件天然顺序对应)。
//
// 会话文件(§3.3,minimal 自己的线性格式):头行 {type:"session",id,...} + 条目行
// {type:"message"|"session_info"|"model_change"|"tools_change",...},无 parentId(线性序即父子)。

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { loadModelConfig, streamModel } from "./minimal-model.mjs";
import { activeToolSchemas, executeTool, listTools, setActiveToolSet } from "./minimal-tools.mjs";
import { loadPlugins, dispatchPluginEvent, dispatchCommand } from "./minimal-plugin.mjs";

// ---- 会话文件路径 + 读写(§3.2/§3.3) ----

/** 会话文件路径派生:由 lineageId 确定性导出,幂等。 */
function sessionPath(agentDir, cwd, lineageId) {
  return join(agentDir, "sessions", cwdToBucket(cwd), `${lineageId}.jsonl`);
}

/** cwd → 桶名(纯字符串变换,与壳侧 cwdToBucketName 同一规则——会话按项目分桶)。 */
function cwdToBucket(cwd) {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function readEntries(path) {
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, "utf-8").split("\n").map((l) => l.trim()).filter(Boolean)
      .flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  } catch { return []; }
}

function appendLine(path, line) {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    const lineageId = path.split("/").pop().replace(/\.jsonl$/, "");
    writeFileSync(path, JSON.stringify({ type: "session", id: lineageId, createdAt: new Date().toISOString(), name: undefined, model: { provider: "minimal", modelId: "echo" }, tools: "read-only" }) + "\n" + line + "\n", "utf-8");
    return;
  }
  appendFileSync(path, line + "\n", "utf-8");
}

/** 更新头行的当前值快照(§3.3.1/§4.10.1):name/model/tools 在 setXxx 时回头重写首行,条目是历史。 */
function updateHeader(path, patch) {
  const entries = readEntries(path);
  if (entries[0]?.type !== "session") return;
  entries[0] = { ...entries[0], ...patch };
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
}

function appendMessage(path, message) {
  appendLine(path, JSON.stringify({ type: "message", id: message.id ?? randomUUID(), timestamp: new Date(typeof message.timestamp === "number" ? message.timestamp : Date.now()).toISOString(), message }));
}

function appendDivider(path, type, fields) {
  appendLine(path, JSON.stringify({ type, id: randomUUID(), timestamp: new Date().toISOString(), ...fields }));
}

// ---- 协议:stdin 命令 → stdout 事件 ----

const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

/** 解析 argv:--agent-dir <dir> --cwd <dir> --session <lineageId>。 */
function parseArgv(argv) {
  const o = { agentDir: join(process.env.HOME ?? ".", ".minimal", "agent"), cwd: process.cwd(), sessionId: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--agent-dir") o.agentDir = argv[++i];
    else if (argv[i] === "--cwd") o.cwd = argv[++i];
    else if (argv[i] === "--session") o.sessionId = argv[++i];
  }
  return o;
}

const cfg = parseArgv(process.argv);
let alive = true;
let model = { provider: "minimal", modelId: "echo" };

/**
 * 裸跑时的默认会话 id（§2.10.1「`echo '{"type":"send","text":"你好"}' | minimal` 就能喂一条」）。
 *
 * 此前 `--session` 是**必填**：不给就在第一次用到 path() 时抛「minimal 未绑定会话」，
 * 于是文档承诺的裸跑形态根本跑不起来 —— 而那正是 §2.1.2「干净的机器上只装 minimal，
 * 从命令行完整地聊完一轮、关掉、再打开续聊」的验收线。
 *
 * 默认 id **由 cwd 确定性派生**，不是 randomUUID：随机 id 会让每次裸跑都开一个新会话，
 * 「关掉再打开续聊」就永远做不到（同一个项目应当落回同一个文件）。取 cwd 的稳定短哈希，
 * 与 desktop 托管时的行为不冲突——托管态恒显式传 `--session`（= neutralSessionId）。
 */
function defaultSessionId(cwd) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < cwd.length; i++) {
    const c = cwd.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return `local-${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

/** 本次运行的会话 id：显式 `--session` 优先，裸跑时用 cwd 派生的默认 id（见上）。 */
const sessionId = () => cfg.sessionId ?? defaultSessionId(cfg.cwd);

const path = () => sessionPath(cfg.agentDir, cfg.cwd, sessionId());

/** 处理一条命令,产出一串事件。 */
function handle(cmd) {
  switch (cmd.type) {
    case "ping":
      out({ type: "pong" });
      return;
    case "send":
      void handleSend(cmd); // fire-and-forget:send 是异步流式,主循环不阻塞(abort 可即时打断)
      return;
    case "abort":
      currentAbort?.abort(); // 掐断在飞 SSE 流(§4.6.2)
      aborted = true;
      return;
    case "setModel":
      model = { provider: cmd.provider, modelId: cmd.modelId };
      updateHeader(path(), { model: { provider: cmd.provider, modelId: cmd.modelId } }); // 头行当前值
      appendDivider(path(), "model_change", { provider: cmd.provider, modelId: cmd.modelId }); // 历史条目
      return;
    case "setSessionName":
      updateHeader(path(), { name: cmd.name });
      appendDivider(path(), "session_info", { name: cmd.name });
      return;
    case "setTools":
      setActiveToolSet(cmd.tools ?? "read-only");
      updateHeader(path(), { tools: cmd.tools ?? "read-only" });
      appendDivider(path(), "tools_change", { tools: cmd.tools ?? "read-only" });
      return;
    case "listTools":
      out({ type: "tools", tools: listTools() });
      return;
    case "getTree": {
      const entries = readEntries(path());
      const rootId = typeof entries[0]?.id === "string" ? entries[0].id : "";
      out({ type: "tree", tree: rootId ? { rootId, lineages: [{ id: rootId, fork: null }] } : { rootId: "", lineages: [] } });
      return;
    }
    case "getEntries": {
      out({ type: "entries", entries: readEntries(path()) });
      return;
    }
    case "seed": {
      // seed 投影:把活跃 lineage 的线性内容写进会话文件(覆盖写,幂等)。
      const p = path();
      mkdirSync(dirname(p), { recursive: true });
      const header = { type: "session", id: sessionId(), createdAt: cmd.header?.createdAt ?? new Date().toISOString(), name: cmd.header?.name };
      const lines = [JSON.stringify(header)];
      for (const entry of cmd.lineage ?? []) {
        const msg = entry.message ?? { role: "user", content: "" };
        lines.push(JSON.stringify({ type: "message", id: entry.kernelEntryId ?? randomUUID(), timestamp: new Date(typeof msg.timestamp === "number" ? msg.timestamp : Date.now()).toISOString(), message: { role: msg.role, content: msg.content ?? "" } }));
      }
      writeFileSync(p, lines.join("\n") + "\n", "utf-8");
      out({ type: "seeded", sessionId: sessionId(), path: p });
      return;
    }
    case "stop":
      alive = false;
      out({ type: "stopped" });
      return;
    default:
      // 插件命令(§6.3.2):未知命令先问插件注册表,未命中才报 unknown。
      if (!dispatchCommand(cmd.type, cmd)) out({ type: "error", error: `unknown command: ${cmd.type}` });
  }
}

/** 在飞回合的中断信号(§4.6.2):send 建一个、abort 掐一个,单线执行器同一时刻一个回合。 */
let currentAbort = null;

/** 工具回环轮数上限(§5.10.1):防「调工具失败又重试」死循环,超限强制收尾。 */
const MAX_TOOL_ROUNDS = 8;

/** 异步 send:落 user → agentStart → messageStart → 工具循环(注入 schema → 调模型 →
 *  有 tool_call 就执行回喂,直到最终文本,§4.3.2)→ messageEnd → 落 assistant → agentSettled。
 *  未配真模型时回落 echo(独立内核的可用底线)。 */
async function handleSend(cmd) {
  if (!alive) throw new Error("minimal 未启动");
  const controller = new AbortController();
  currentAbort = controller;
  const now = Date.now();
  appendMessage(path(), { role: "user", content: cmd.text, timestamp: now });
  out({ type: "agentStart" });
  const id = randomUUID();
  out({ type: "messageStart", message: { role: "assistant", id, pending: true, timestamp: now, model: { provider: model.provider, modelId: model.modelId, kernel: "minimal" } } });
  let full = "";
  let failed = false;
  let hitMaxRounds = false;
  const toolCallsAll = [];
  const onDelta = (d) => {
    full += d;
    out({ type: "messageUpdate", message: { role: "assistant", id, content: [{ type: "text", text: d }], pending: true } });
  };
  try {
    const config = loadModelConfig(cfg.agentDir);
    // 模型选择优先级:setModel 显式设的 > 配置 default > echo。
    const providerId = model.provider !== "minimal" ? model.provider : (config?.default?.provider ?? "minimal");
    const modelId = model.modelId !== "echo" ? model.modelId : (config?.default?.model ?? "echo");
    if (config && config.providers.some((p) => p.id === providerId)) {
      const messages = [{ role: "user", content: cmd.text }];
      const tools = activeToolSchemas();
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const { toolCalls } = await streamModel(config, cfg.agentDir, providerId, modelId, messages, tools, onDelta, controller.signal);
        if (toolCalls.length === 0) break; // 最终文本已流式发出
        // 达上限强制收尾(§5.10.1):最后一轮仍调工具 = 未收敛,标 maxToolRounds。
        if (round === MAX_TOOL_ROUNDS - 1) { hitMaxRounds = true; break; }
        // 先落 assistant 的 tool_calls 消息,再落每条 tool 结果(OpenAI 消息序)。
        messages.push({ role: "assistant", content: null, tool_calls: toolCalls.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: t.arguments } })) });
        for (const tc of toolCalls) {
          let args = {};
          try { args = JSON.parse(tc.arguments || "{}"); } catch { /* 参数损坏按空对象 */ }
          out({ type: "toolCallStart", toolCallId: tc.id, toolName: tc.name, args });
          const result = executeTool(tc.name, args);
          out({ type: "toolCallEnd", toolCallId: tc.id, toolName: tc.name, result, isError: result.isError === true });
          dispatchPluginEvent("toolCallEnd", { toolCallId: tc.id, toolName: tc.name, result, isError: result.isError === true });
          toolCallsAll.push({ id: tc.id, name: tc.name, args, result });
          messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) });
        }
      }
    } else {
      onDelta(`[minimal echo] ${cmd.text}`);
    }
  } catch (e) {
    // 模型失败(超时/5xx/连接重置,§4.6.1):不静默——记为 failed,messageEnd 带 error、
    //  agentSettled 带 reason。abort 是用户主动中断,走 stopped 不标 error。
    if (!controller.signal.aborted) failed = true;
  } finally {
    if (currentAbort === controller) currentAbort = null;
  }
  const content = [];
  for (const tc of toolCallsAll) {
    content.push({ type: "toolCall", id: tc.id, name: tc.name, args: tc.args, result: tc.result, isError: tc.result.isError === true });
  }
  if (full) content.push({ type: "text", text: full });
  const final = {
    role: "assistant", id,
    content,
    timestamp: now, startedAt: now,
    model: { provider: model.provider, modelId: model.modelId, kernel: "minimal" },
    ...(controller.signal.aborted ? { stopped: true } : {}),
    ...(failed ? { error: true } : {}),
  };
  // §4.3.3 写穿先于发事件:先落 assistant 条目、再发 messageEnd——否则事件发出后崩溃,
  // 壳侧按事件 append 进中立层、minimal 文件却缺条目,两边漂(曾漂移:messageEnd 先发后写)。
  appendMessage(path(), final);
  out({ type: "messageEnd", message: final });
  dispatchPluginEvent("messageEnd", { message: final });
  const reason = controller.signal.aborted ? "aborted" : failed ? "error" : hitMaxRounds ? "maxToolRounds" : "completed";
  out({ type: "agentSettled", reason });
  dispatchPluginEvent("agentSettled", { reason });
}

// 启动:加载插件(§6.9 目录扫描),插件注册的工具进注册表;读头行 tools 快照(§5.6.1
// 工具集翻译的结果,重开时应用),再开始读 stdin。
await loadPlugins(cfg.agentDir);
try {
  const header = readEntries(path())[0];
  if (typeof header?.tools === "string") setActiveToolSet(header.tools);
} catch { /* 会话文件不存在(新会话)或 tools 非法:用默认 read-only */ }

// 主循环:逐行读 stdin,每行一个完整 JSON 命令。
const buf = [];
process.stdin.on("data", (chunk) => {
  buf.push(chunk);
  let s = buf.join("");
  let idx;
  while ((idx = s.indexOf("\n")) >= 0) {
    const line = s.slice(0, idx).trim();
    s = s.slice(idx + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch (e) {
      out({ type: "error", error: e.message });
    }
  }
  buf.length = 0;
  buf.push(s);
});
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
