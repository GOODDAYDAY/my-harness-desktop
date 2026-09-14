/**
 * dsh SDK server 方法面补全 —— 桌面所需的全部 session/* JSON-RPC 方法，由我们自己的 cordis
 * 插件保证，不赌上游发版（docs/design/dsh-sdk-method-supplement.md）。
 *
 * ## 为什么需要这个文件（实测钉死，不是推测）
 *
 * npm 上发布的 `@deepseek-ai/dsh-sdk-jsonrpc-server`（0.1.1-rc.2 直到 0.1.5-rc.2）
 * `handleRequest` 只有 3 个 case：`initialize` / `session/prompt` / `shutdown`。
 * 而桌面的 `DshBackend` + `DshSessionCatalog` 实际调用 16 个方法。上游 master 有全量方法面，
 * 但一直没发出来——「请升级 dsh 内核」这条路是死的。
 *
 * 关键事实：**缺的只是方法暴露层，core 能力全在**。逐包 md5 对比 npm 版与上游构建产物，
 * `dsh-agent`/`dsh-agent-loop`/`dsh-llm`/`dsh-scope`/`dsh-attachment`/`dsh-goal`/
 * `dsh-session-persistence`/`dsh-subagent` 逐字节相同；`dsh-session` 只差 `SessionStore.delete`；
 * 唯一大缺口就是 `dsh-sdk-jsonrpc-server`（9.6 KB vs 27.7 KB）。
 *
 * 所以补面 = 用 dsh 自己的公开 core API（`ctx.agents` / `ctx.sessions` / `ctx.sessionPersistence`）
 * 实现协议层，落在 cordis 插件里（§1.6 内核源码只读，一切内核侧需求走插件）。
 *
 * ## 双副本陷阱（本文件存在的最重要理由，实测复现）
 *
 * 插件解析 `@deepseek-ai/dsh-sdk-jsonrpc-server` 走的是**插件自己所在目录**的 node_modules 解析链
 * （`~/.dsh/node_modules` → 可能是符号链接、可能是另一份安装），而 CLI 运行时用的是
 * **它自己所在安装目录**的那份（`~/.my-harness-desktop/dsh/node_modules`）。两者可以指向
 * **不同的物理副本** → 两个不同的 `HarnessSdkJsonRpcServer` 类对象。
 *
 * 实测证据（探针插件返回）：
 * ```
 * { resolved: [
 *     { via: "bare",  url: ".../.dsh/node_modules/.../index.js",                  patched: true  },
 *     { via: "argv1", url: ".../.my-harness-desktop/dsh/node_modules/.../index.js", patched: false } ],
 *   same: false }
 * ```
 * patch 打在 A 副本、实际服务请求的是 B 副本 → **所有补面静默失效**（不只 seed，
 * 连「已实施」的 setModel / thinkingLevel / session-meta 事件类型补面也一起废了），
 * 而症状表现为「dsh 内核版本过旧，缺少 session/seed」——一个完全误导人的诊断。
 *
 * 因此本文件的 patch 必须**覆盖两个副本**：`resolveServerClasses()` 同时解析
 * ① 插件自己的 bare import、② `process.argv[1]`（CLI 入口）所在运行时闭包的那份，
 * 逐个幂等 patch。谁实际服务请求都能被覆盖到。
 *
 * ## 纪律
 *
 * - 不改内核源码、不打装后补丁：只 patch 我们插件加载时能拿到的类原型，随 cordis 动态装载。
 * - 单一 patch 点：本仓所有 dsh SDK 方法面（补缺 + 强语义接管）都经 `installSdkMethodSupplement`
 *   注册进一张表，不存在第二个 patcher（避免 patch 互相包裹、顺序依赖、错误归属难查）。
 * - 不吞原生方法：表里没有的方法原样交回原生 `handleRequest`（原生抛 unknown-method 就照常抛，
 *   壳的懒探测 / 显式降级纪律不变，§7.6）。
 * - 显式降级不静默：能力真缺（如 attachment 服务未挂载）→ 抛清晰错误，绝不伪造成功。
 */
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { createRequire } from "node:module";

// ==============================================================================================
// 运行时副本解析（双副本陷阱的正解）
// ==============================================================================================

/** 已解析的运行时模块缓存：bare 名 → { url, ns }。每进程解析一次。 */
const runtimeModules = new Map();

/**
 * 解析一个 dsh 包在「CLI 运行时闭包」里的那份副本。
 *
 * `process.argv[1]` 是 dsh 的可执行入口（`lib/bin.js` / `lib/packaged-bin.js`），从它出发做
 * node 解析，拿到的就是**实际在服务请求的那份**。bare import 拿到的是插件目录解析链的那份
 * ——两者可能不同（见文件头注释的实测证据）。
 *
 * @param pkg 包名（如 `@deepseek-ai/dsh-sdk-jsonrpc-server`）。
 * @returns 运行时闭包里的那份 namespace；解析不到返回 null（调用方回落 bare import）。
 */
export async function resolveRuntimeModule(pkg) {
  const cached = runtimeModules.get(pkg);
  if (cached) return cached;
  let ns = null;
  let url = null;
  try {
    const entry = process.argv[1];
    if (entry) {
      url = createRequire(entry).resolve(pkg);
      ns = await import(url);
    }
  } catch {
    ns = null; // 运行时闭包解析不到（如从源码跑），回落 bare import
  }
  if (!ns) {
    try {
      ns = await import(pkg);
      url = import.meta.resolve?.(pkg) ?? "bare";
    } catch {
      ns = null;
    }
  }
  const value = ns ? { url, ns } : null;
  if (value) runtimeModules.set(pkg, value);
  return value;
}

/**
 * 取出所有需要 patch 的 `HarnessSdkJsonRpcServer` 类（去重后的**全部副本**）。
 *
 * 为什么要全部：插件加载期无法知道哪一个副本会实际服务请求（取决于 CLI 从哪份 node_modules
 * 起、cordis 如何解析裸包名）。patch 全部 = 无论解析到哪份都覆盖到；幂等标记保证不重复包。
 */
export async function resolveServerClasses() {
  const found = new Map(); // url → 类
  const bare = await import("@deepseek-ai/dsh-sdk-jsonrpc-server").catch(() => null);
  if (bare?.HarnessSdkJsonRpcServer) {
    found.set(import.meta.resolve?.("@deepseek-ai/dsh-sdk-jsonrpc-server") ?? "bare", bare.HarnessSdkJsonRpcServer);
  }
  const runtime = await resolveRuntimeModule("@deepseek-ai/dsh-sdk-jsonrpc-server");
  if (runtime?.ns?.HarnessSdkJsonRpcServer) found.set(runtime.url, runtime.ns.HarnessSdkJsonRpcServer);
  return [...found.values()];
}

/** 取运行时闭包里的纯工厂/常量（消息构造、事件类型集、热切安装器）。解析不到回落 bare import。 */
export async function resolveRuntimeHelpers() {
  const pick = async (pkg, names) => {
    const rt = await resolveRuntimeModule(pkg);
    const ns = rt?.ns ?? (await import(pkg).catch(() => null));
    const out = {};
    for (const n of names) out[n] = ns?.[n];
    return out;
  };
  const llm = await pick("@deepseek-ai/dsh-llm", ["createUserMessage", "createAssistantMessage", "CallId"]);
  const session = await pick("@deepseek-ai/dsh-session", ["SessionId", "KNOWN_SESSION_EVENT_TYPES"]);
  const agent = await pick("@deepseek-ai/dsh-agent", ["installModelSelection"]);
  return { ...llm, ...session, ...agent };
}

// ==============================================================================================
// seed 的事件重建（纯函数，可单测）
// ==============================================================================================

/** 桌面中立 content（字符串或块数组）→ dsh content blocks。 */
export function contentToBlocks(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  const blocks = [];
  for (const raw of content) {
    if (typeof raw !== "object" || raw === null) continue;
    const b = raw;
    if (b.type === "text" && typeof b.text === "string") {
      blocks.push({ type: "text", text: b.text });
    } else if (b.type === "thinking" && typeof b.thinking === "string") {
      blocks.push({ type: "reasoning", text: b.thinking });
    } else if (b.type === "toolCall") {
      blocks.push({
        type: "tool-call",
        id: typeof b.id === "string" && b.id ? b.id : crypto.randomUUID(),
        name: typeof b.name === "string" && b.name ? b.name : "tool",
        arguments: typeof b.args === "string" ? b.args : JSON.stringify(b.args ?? {}),
      });
    }
  }
  return blocks;
}

/**
 * 中立条目序列 → turn 封闭的 dsh seed 事件序列（纯函数；与上游 `entriesToSeedEvents` 同口径）。
 *
 * `user` 条目开一个 turn + step，紧随的 `assistant` 闭掉它。`toolResult` 跳过——忠实的工具环
 * 重建（配对 `tool/call` 与 `tool/result`）是上游标注的 follow-up，跨内核切换要的是对话连续性，
 * user/assistant 足够；这里不自行加戏。
 *
 * 末条若仍是打开的 turn（只有 user 没有 assistant），自动收尾——否则 dsh 认为回合未结束，
 * 下一条 prompt 会被当成同回合的 followup 而非新回合。
 *
 * @param entries 中立条目（`{ message: { role, content } }`）。
 * @param makeUser `createUserMessage` 工厂（运行时闭包里的那份）。
 * @param makeAssistant `createAssistantMessage` 工厂。
 * @param source assistant 消息的来源标记 `{ provider, model }`。
 */
export function entriesToSeedEvents(entries, makeUser, makeAssistant, source) {
  const events = [];
  let seq = 0;
  let turn = 1;
  let open = false;
  const boundary = (type, data) => { events.push({ type, seq: seq++, time: Date.now(), data }); };
  const surface = (type, data) => { events.push({ type, seq: seq++, time: Date.now(), surfaceOp: "append", data }); };
  const close = () => {
    boundary("step/end", { turn, step: 1 });
    boundary("turn/end", { turn, reason: { kind: "completed" } });
    turn += 1;
    open = false;
  };
  for (const entry of entries ?? []) {
    const msg = entry?.message;
    if (!msg) continue;
    if (msg.role === "user") {
      if (open) close();
      boundary("turn/start", { turn });
      boundary("step/start", { turn, step: 1 });
      surface("user/message", makeUser({ content: contentToBlocks(msg.content), source: { kind: "user" } }));
      open = true;
    } else if (msg.role === "assistant" && open) {
      surface("assistant/message", {
        turn,
        step: 1,
        message: makeAssistant({ content: contentToBlocks(msg.content), source }),
      });
      close();
    }
  }
  if (open) close();
  return events;
}

// ==============================================================================================
// 方法表：桌面所需的 16 个 session/* 方法（补缺 + 接管，一张表）
//
// 每个 handler 的 this = HarnessSdkJsonRpcServer 实例（可读 this.ctx / this.sessions /
// this.provider / this.model / this.maxTokens / this.cwd），入参是 wire params。
// ==============================================================================================

/** 从 live store 或持久化里拿会话对象；都没有返回 null（不是错误）。 */
async function loadSession(server, sessionId, helpers) {
  const { SessionId } = helpers;
  const sessions = server.ctx.get("sessions");
  const live = sessions?.get(SessionId(sessionId));
  if (live) return live;
  // 不 live：尝试从持久化 resume 进来（重开历史会话点书签是合法路径）。
  const persistence = server.ctx.get("sessionPersistence");
  if (!persistence) return null;
  const exists = (await persistence.list()).some((h) => String(h.id) === String(sessionId));
  if (!exists) return null;
  const rec = {
    handle: await server.ctx.agents.resume({
      resumeSessionId: SessionId(sessionId),
      agentOptions: agentOptionsOf(server),
    }),
  };
  server.sessions.set(String(sessionId), rec);
  return sessions?.get(SessionId(sessionId)) ?? null;
}

/** initialize 握手定下的 agent 选项（seed / resume 复用同一份）。 */
function agentOptionsOf(server) {
  return {
    provider: server.provider,
    model: server.model,
    ...(server.maxTokens === undefined ? {} : { maxTokens: server.maxTokens }),
  };
}

/** 折叠 session/meta 事件成一份元数据（**merge 语义**，后写的同名键胜出）。
 *
 * 为什么不是上游那种「取最后一个 meta 事件」的 last-write-wins：桌面把元数据拆成两个独立的
 * 写口分别调——`session/rename` 只写 `{name}`，`session/updateHeader` 只写 `{pinned, archived,
 * custom}`（`DshSessionCatalog` 两个方法）。last-wins 下后一次写会抹掉前一次的字段
 * （实测：先 rename 再 pin → name 丢失）。patch 语义 = 部分更新，故 merge。 */
export function latestMeta(session) {
  let meta = {};
  for (const event of session.events ?? []) {
    if (event.type !== "session/meta") continue;
    const m = event.data?.meta;
    if (typeof m === "object" && m !== null && !Array.isArray(m)) meta = { ...meta, ...m };
  }
  return meta;
}

/** 会话的派生消息 → 中性 timeline 形状。 */
function deriveEntries(session) {
  return (session.deriveMessages() ?? []).map((message) => ({
    id: String(message.id),
    role: message.role,
    content: message.content,
  }));
}

/** persistence header → 列表投影。 */
function toListProjection(header) {
  const created = new Date(header.createdAt).toISOString();
  return {
    path: String(header.id),
    id: String(header.id),
    cwd: header.cwd ?? "",
    created,
    modified: created,
  };
}

/**
 * 补面方法表。key = wire 方法名；value = { handler, preferNativeWhen? }。
 *
 * handler 签名 `(params, deps)`，`this` = server 实例，`deps = { helpers, native }`：
 * - `helpers` 是**运行时闭包**里的纯工厂/常量（SessionId / createUserMessage / …），
 *   不从 bare import 取（双副本陷阱：bare 那份可能与实际服务的副本不是同一个模块实例）。
 * - `native` 是未 patch 的原生 `handleRequest`，供接管类方法回落到原生实现。
 */
export const SDK_METHOD_SUPPLEMENT = {
  // ---- seed：把中立历史灌进内核（跨内核切换投影 / dsh 重开历史会话的地基）----
  "session/seed": {
    async handler(params, deps) {
      const { sessionId, session } = params ?? {};
      const root = session?.lineages?.[0];
      if (!root) throw new Error("seed session has no root lineage");
      const { SessionId, createUserMessage, createAssistantMessage } = deps.helpers;
      const seedEvents = entriesToSeedEvents(root.entries, createUserMessage, createAssistantMessage, {
        provider: this.provider,
        model: this.model,
      });
      // 幂等：同 lineageId 再 seed 不重建（壳的 materialize 会按 lineageId 幂等调用）。
      if (this.sessions.has(String(sessionId))) return { sessionId: String(sessionId) };
      const rec = {
        handle: await this.ctx.agents.create({
          sessionId: SessionId(String(sessionId)),
          seed: seedEvents,
          meta: { cwd: this.cwd },
          agentOptions: agentOptionsOf(this),
        }),
      };
      this.sessions.set(String(sessionId), rec);
      // flush：seed 出的会话 header 要落盘，getTree 的 parentSession/seedLength 反查才看得到它；
      // write-behind 队列靠定时器，进程可能在 flush 前就死（壳重启/崩溃）——不赌时序。
      const created = this.ctx.get("sessions")?.get(SessionId(String(sessionId)));
      if (created) await this.ctx.get("sessions").flush(created).catch(() => {});
      // 身份断言（session-single-source §4.3）：壳按规则派生的 id 必须原样回来。
      return { sessionId: String(sessionId) };
    },
  },

  // ---- getTree：由持久化 header 的 parentSession/seedLength 反查建 lineage 树 ----
  // 优于上游的 childIndex 方案：上游靠构造期监听 session/created 攒索引，patch 场景下 server
  // 已构造完（攒不到），且进程重启即丢。走 header 反查跨重启完整。
  "session/getTree": {
    async handler(params, deps) {
      const rootId = String(params?.sessionId ?? "");
      const session = await loadSession(this, rootId, deps.helpers);
      if (!session) {
        throw new Error(`unknown session: ${rootId}`);
      }
      const persistence = this.ctx.get("sessionPersistence");
      const headers = persistence ? await persistence.list() : [];
      const childrenOf = new Map(); // parentId → [childId]
      const seedLengthOf = new Map(); // id → seedLength
      for (const header of headers) {
        const id = String(header.id);
        if (typeof header.seedLength === "number") seedLengthOf.set(id, header.seedLength);
        const parent = header.parentSession === undefined ? null : String(header.parentSession);
        if (parent === null) continue;
        const siblings = childrenOf.get(parent);
        if (siblings) siblings.push(id);
        else childrenOf.set(parent, [id]);
      }
      const lineages = [];
      const visit = (id, parentId) => {
        const seedLength = seedLengthOf.get(id);
        lineages.push({
          id,
          fork: parentId === null ? null : {
            parentLineageId: parentId,
            // inclusive boundary 的事件 seq = seedLength - 1（实测：boundary 5 → seedLength 6）。
            boundary: seedLength === undefined ? "" : String(seedLength - 1),
          },
        });
        for (const childId of childrenOf.get(id) ?? []) visit(childId, id);
      };
      visit(rootId, null);
      return { rootId, lineages };
    },
  },

  // ---- getEntries：回放一条 lineage 的线性消息 ----
  "session/getEntries": {
    async handler(params, deps) {
      const lineageId = String(params?.lineageId ?? "");
      const session = await loadSession(this, lineageId, deps.helpers);
      if (!session) throw new Error(`unknown session: ${lineageId}`);
      return deriveEntries(session);
    },
  },

  // ---- bookmark / resume / deleteBookmark：坐标书签（无副本）----
  "session/bookmark": {
    async handler(params, deps) {
      const lineageId = String(params?.lineageId ?? "");
      const session = await loadSession(this, lineageId, deps.helpers);
      if (!session) throw new Error(`unknown session: ${lineageId}`);
      return { lineageId, boundary: String(params?.boundarySeq ?? "") };
    },
  },
  "session/resume": {
    async handler(params, deps) {
      const anchor = params?.anchor;
      const lineageId = String(anchor?.lineageId ?? "");
      const source = await loadSession(this, lineageId, deps.helpers);
      if (!source) throw new Error(`unknown session: ${lineageId}`);
      const boundary = Number(anchor?.boundary);
      const sessions = this.ctx.get("sessions");
      const child = sessions.fork(source, Number.isSafeInteger(boundary) ? boundary : undefined);
      // flush 子会话：fork 关系（parentSession / seedLength）住在 header 里，不落盘则
      // getTree 的 header 反查看不到它（实测：不 flush → getTree 只返回根 lineage）。
      await sessions.flush(child).catch(() => {});
      return { lineageId: String(child.id) };
    },
  },
  "session/deleteBookmark": {
    handler() {
      return {}; // 坐标书签无物可回收
    },
  },

  // ---- abort：取消当前回合；unknown session = no-op（空闲时 abort 无害）----
  "session/abort": {
    handler(params) {
      const record = this.sessions.get(String(params?.sessionId ?? ""));
      if (record) record.handle.agent.cancel({ kind: "user" });
      return {};
    },
  },

  // ---- rename / updateHeader：写 session/meta（持久元数据）----
  "session/rename": {
    async handler(params, deps) {
      const session = await loadSession(this, String(params?.sessionId ?? ""), deps.helpers);
      if (!session) throw new Error(`session not open: ${params?.sessionId}`);
      session.append("session/meta", { meta: { name: params?.name } });
      // flush：meta 是持久元数据（会话名要跳重启活着），write-behind 队列靠定时器，
      // 进程可能在 flush 前就死（壳重启/崩溃）——显式 flush 不赌时序。
      await this.ctx.get("sessions")?.flush(session).catch(() => {});
      return {};
    },
  },
  "session/updateHeader": {
    async handler(params, deps) {
      const session = await loadSession(this, String(params?.sessionId ?? ""), deps.helpers);
      if (!session) throw new Error(`session not open: ${params?.sessionId}`);
      session.append("session/meta", { meta: params?.patch ?? {} });
      await this.ctx.get("sessions")?.flush(session).catch(() => {}); // 同 rename：不赌 write-behind 时序
      return {};
    },
  },

  // ---- get：会话详情（列表投影 + 派生消息）；unknown → null（不是错误）----
  "session/get": {
    async handler(params, deps) {
      const sessionId = String(params?.sessionId ?? "");
      const session = await loadSession(this, sessionId, deps.helpers);
      if (!session) return null;
      const created = new Date(session.header.createdAt).toISOString();
      const meta = latestMeta(session);
      return {
        info: {
          path: sessionId,
          id: sessionId,
          cwd: session.header.cwd ?? "",
          created,
          modified: created,
          ...(typeof meta.name === "string" ? { name: meta.name } : {}),
          ...(typeof meta.pinned === "boolean" ? { pinned: meta.pinned } : {}),
          ...(typeof meta.archived === "boolean" ? { archived: meta.archived } : {}),
          ...(typeof meta.custom === "object" && meta.custom !== null ? { custom: meta.custom } : {}),
        },
        messages: deriveEntries(session),
      };
    },
  },

  // ---- list：持久化会话清单（无 persistence 插件 → 空清单，不报错）----
  "session/list": {
    async handler(params) {
      const persistence = this.ctx.get("sessionPersistence");
      if (!persistence) return [];
      const headers = await persistence.list();
      const filtered = params?.cwd === undefined ? headers : headers.filter((h) => h.cwd === params.cwd);
      return filtered.map(toListProjection);
    },
  },

  // ---- delete：live dispose + durable artifact 删除 ----
  // npm 版既无 SessionStore.delete 也无 persistence backend delete（实测），故自行组合：
  // 先 dispose（让 write-behind flush 完 + live store detach），再 rm artifact。
  // 实测该组合与上游胖版 delete 等效（dispose 后 sessions.get=GONE，rm 后 list() 里消失）。
  "session/delete": {
    async handler(params) {
      const sessionId = String(params?.sessionId ?? "");
      const record = this.sessions.get(sessionId);
      if (record) {
        this.sessions.delete(sessionId);
        await record.handle.dispose().catch(() => {});
      }
      const persistence = this.ctx.get("sessionPersistence");
      if (persistence?.delete) {
        await persistence.delete(sessionId).catch(() => {});
      } else if (persistence?.listArtifacts) {
        const artifacts = await persistence.listArtifacts().catch(() => []);
        const target = artifacts.find((a) => String(a.header?.id) === sessionId);
        if (target?.path) {
          await rm(target.path, { force: true }).catch(() => {});
          // 顺手收空目录（一个会话一个目录）；失败不致命。
          await rm(dirname(target.path), { recursive: true, force: true }).catch(() => {});
        }
      }
      return {};
    },
  },

  // ---- projectStats：跨 cwd 的 token/回合聚合（dsh 无成本核算 → cost 恒 0）----
  "session/projectStats": {
    async handler(params, deps) {
      const empty = {
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        cost: 0,
        sessionCount: 0,
        turns: 0,
      };
      const persistence = this.ctx.get("sessionPersistence");
      if (!persistence) return empty;
      const headers = await persistence.list();
      const filtered = params?.cwd === undefined ? headers : headers.filter((h) => h.cwd === params.cwd);
      const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
      let turns = 0;
      const sessions = this.ctx.get("sessions");
      const { SessionId } = deps.helpers;
      for (const header of filtered) {
        const live = sessions?.get(SessionId(String(header.id)));
        const events = live ? live.events : (await persistence.readFrom(header.id, 0).catch(() => ({ events: [] }))).events;
        for (const event of events ?? []) {
          if (event.type === "assistant/message" && event.data?.usage !== undefined) {
            const u = event.data.usage;
            tokens.input += u.inputTokens ?? 0;
            tokens.output += u.outputTokens ?? 0;
            tokens.cacheRead += u.cacheReadTokens ?? 0;
            tokens.cacheWrite += u.cacheWriteTokens ?? 0;
          }
          if (event.type === "user/message") turns += 1;
        }
      }
      tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
      return { tokens, cost: 0, sessionCount: filtered.length, turns };
    },
  },

  // ---- prompt 接管：图片附件的显式降级 ----
  // 瘦版原生 prompt 只读 contentBlocks → 桌面 sendMessage(text, images) 传的 images 会被
  // **静默丢弃**（用户以为图发出去了、模型没看到 = 伪造成功，§1.5 明令禁止）。
  // 这里接管：有 images 且 attachment 服务未挂载 → 抛清晰错误；无 images → 交回原生。
  "session/prompt": {
    preferNativeWhen: (params) => !(Array.isArray(params?.images) && params.images.length > 0),
    async handler(params, deps) {
      const attachments = this.ctx.get("attachments");
      if (!attachments?.saveImages) {
        throw new Error("该 dsh 运行时未挂载 attachment 服务，图片附件不支持（请改用纯文本，或切换到支持附件的内核）");
      }
      const refs = await attachments.saveImages(
        params.images.map((image) => ({
          data: Buffer.from(image.data, "base64"),
          mediaType: image.mediaType,
          ...(image.name === undefined ? {} : { name: image.name }),
        })),
      );
      const blocks = [...(params.contentBlocks ?? []), ...refs.map((attachment) => ({ type: "image", attachment }))];
      return deps.native.call(this, "session/prompt", { ...params, images: undefined, contentBlocks: blocks });
    },
  },
};

// ==============================================================================================
// 安装：单一 patch 点 + 一张表 + 全副本覆盖 + 幂等
// ==============================================================================================

const INSTALLED = Symbol.for("my-harness-desktop.dsh-sdk-method-supplement");

/**
 * 无副作用地读出原生 `handleRequest` 实际支持的方法名集合。
 *
 * 为什么不用「试调原生看它报不报 unknown-method」：试调是有副作用的——`session/prompt`
 * 试调一次就真的发了一条消息、`session/delete` 试调一次就真的删了会话。探测能力不能
 * 拿业务调用当探针。改用静态特征：原生 `handleRequest` 就是一个 switch，源码文本里的
 * `case "session/xxx"` 就是它的方法面（实测：npm 版 3 个 case、上游构建版 20 个 case）。
 *
 * 这也顺带解决了 §2.3 的「版本号不可信」：判据是运行时的真实代码，不是 package.json。
 */
export function nativeMethodSet(nativeHandleRequest) {
  const src = Function.prototype.toString.call(nativeHandleRequest ?? (() => {}));
  return new Set([...src.matchAll(/case\s*["']([a-z]+\/[a-zA-Z]+|initialize|shutdown)["']/g)].map((m) => m[1]));
}

/**
 * 把补面方法表装到**所有** `HarnessSdkJsonRpcServer` 副本上（双副本陷阱的正解）。
 *
 * 幂等：同一类对象只装一次（重复调用是 no-op）。原生优先：标了 `preferNative: true` 的方法，
 * 若原生已支持则让位原生（上游哪天真发了全量方法面，补面自动退役，§4.6）；强语义接管类
 * （setModel / thinkingLevel）不让位——它们的语义严格强于原生。
 *
 * @param extra 额外/覆盖的方法表（如 index.mjs 的强语义接管项 setModel / thinkingLevel）。
 * @returns 实际 patch 的副本数（0 = 一个都没找到，调用方应记日志）。
 */
export async function installSdkMethodSupplement(extra = {}) {
  const classes = await resolveServerClasses();
  const helpers = await resolveRuntimeHelpers();
  let patched = 0;
  for (const Klass of classes) {
    if (Klass[INSTALLED]) continue;
    const native = Klass.prototype.handleRequest;
    const nativeMethods = nativeMethodSet(native);
    const table = { ...SDK_METHOD_SUPPLEMENT, ...extra };
    Klass.prototype.handleRequest = async function (method, params) {
      const entry = table[method];
      if (!entry) return native.call(this, method, params);
      // 原生已有该方法且本项声明让位（preferNative）→ 走原生，补面自动退役。
      if (entry.preferNative === true && nativeMethods.has(method)) return native.call(this, method, params);
      // 条件让位：只在特定参数形态下接管（如 prompt 仅在带 images 时接管）。
      if (entry.preferNativeWhen?.(params)) return native.call(this, method, params);
      return entry.handler.call(this, params, { helpers, native });
    };
    Klass[INSTALLED] = true;
    patched += 1;
  }
  return patched;
}

/**
 * session/meta 事件类型补面（幂等）。
 *
 * dsh 的 rename / updateHeader 会写 `session/meta` 事件，但上游 `KNOWN_SESSION_EVENT_TYPES`
 * 漏收该类型 → resume 重放时 coordinator.assertEventsSupported 抛「session/meta unknown」，
 * 重开续聊崩。该集合是普通 Set，运行时可 add（ReadonlySet 只是 TS 标注）。
 *
 * ⚠ 必须用**运行时闭包**里的那份集合：bare import 到的可能是另一副本（同双副本陷阱），
 * add 在错的副本上等于没补——这正是本次事故里「session-meta 补面静默失效」的形态。
 */
export async function supplementKnownSessionEventTypes() {
  const { KNOWN_SESSION_EVENT_TYPES } = await resolveRuntimeHelpers();
  const set = KNOWN_SESSION_EVENT_TYPES;
  if (!set || typeof set.add !== "function") return false;
  if (!set.has("session/meta")) set.add("session/meta");
  return true;
}
