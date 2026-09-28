// probe4 会话存储 —— probe4 自己的线性会话文件(头 + 一条活跃 lineage 的线性条目)。
//
// 依据 docs/design/minimal-kernel.md §3。与 pi-catalog 对称:壳不读 probe4 的私有文件,
// 只有 probe4 适配器读写。格式是 probe4 自己的(不是 pi 的 parentId 树、不是 dsh 的
// session forest):一个 JSONL 文件,头行 + 线性条目(无 parentId,线性序即父子),分叉归壳。

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SessionCatalog, SessionToolConfig, HeaderPatch, ProjectStats, LineageTree, Anchor, NeutralMessage, NeutralEntry, NeutralSessionHeader } from "@my-harness-desktop/shared";
import { cwdToBucketName, messageUsageOf } from "@my-harness-desktop/shared";

/** probe4 会话文件路径派生(§3.2.2):由 lineageId 确定性导出,幂等。 */
export function probe4DerivedSessionPath(agentDir: string, cwd: string, lineageId: string): string {
  return join(agentDir, "sessions", cwdToBucketName(cwd), `${lineageId}.jsonl`);
}

/** 单条 probe4 条目 → 中性消息。message 条目原样投,分隔条目投成 divider(与 pi 同形状)。 */
export function probe4EntryToNeutral(raw: unknown): NeutralMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  const ts = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : typeof e.timestamp === "number" ? e.timestamp : undefined;
  const tsNum = Number.isFinite(ts) ? ts : undefined;
  if (e.type === "message" && e.message && typeof e.message === "object") {
    return { ...(e.message as Record<string, unknown>), id: typeof e.id === "string" ? e.id : undefined, timestamp: tsNum } as NeutralMessage;
  }
  if (e.type === "session_info") {
    return { role: "divider", kind: "info", i18nKey: "timeline.sessionRenamed", i18nArgs: { name: e.name ?? "" }, content: "", id: typeof e.id === "string" ? e.id : undefined, timestamp: tsNum } as NeutralMessage;
  }
  if (e.type === "model_change") {
    return { role: "divider", kind: "model", i18nKey: "timeline.modelChange", i18nArgs: { provider: e.provider ?? "", modelId: e.modelId ?? "" }, content: "", id: typeof e.id === "string" ? e.id : undefined, timestamp: tsNum } as NeutralMessage;
  }
  if (e.type === "tools_change") {
    return { role: "divider", kind: "tools", i18nKey: "timeline.toolSetChanged", i18nArgs: { tools: e.tools ?? "" }, content: "", id: typeof e.id === "string" ? e.id : undefined, timestamp: tsNum } as NeutralMessage;
  }
  // 头行(type:"session")与未知类型不产出时间线消息。
  return null;
}

/** seed 投影纯函数(§3.4.2):把活跃 lineage 的线性内容写成 probe4 会话文件,返回派生路径。 */
export function probe4SeedSession(agentDir: string, cwd: string, lineage: NeutralEntry[], opts: { lineageId: string; header: NeutralSessionHeader }): string {
  const path = probe4DerivedSessionPath(agentDir, cwd, opts.lineageId);
  mkdirSync(dirname(path), { recursive: true });
  const header = {
    type: "session",
    id: opts.lineageId,
    createdAt: opts.header.createdAt ?? new Date().toISOString(),
    name: opts.header.name,
    model: { provider: "probe4", modelId: "echo" },
    tools: "read-only",
  };
  const lines: string[] = [JSON.stringify(header)];
  for (const entry of lineage) {
    const msg = entry.message;
    lines.push(JSON.stringify({
      type: "message",
      id: entry.kernelEntryId ?? randomUUID(),
      timestamp: typeof msg.timestamp === "number" ? new Date(msg.timestamp).toISOString() : new Date().toISOString(),
      message: { role: msg.role, content: msg.content ?? "" },
    }));
  }
  writeFileSync(path, lines.join("\n") + "\n", "utf-8");
  return path;
}

/** 读会话文件全部条目(损坏行跳过)。 */
function readEntries(path: string): unknown[] {
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, "utf-8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  } catch {
    return [];
  }
}

/** 追加 session_info 改名条目到会话文件(非活会话改名投影,§3.3.3)。文件不存在(从未物化)则跳过——
 *  名字在 seed 时由中立头写入,无需为未物化会话建空文件。 */
export function probe4AppendSessionInfo(path: string, name: string): void {
  if (!existsSync(path)) return;
  updateHeaderLine(path, { name }); // 头行当前值快照(§3.3.1)
  appendFileSync(path, JSON.stringify({ type: "session_info", id: randomUUID(), timestamp: new Date().toISOString(), name }) + "\n", "utf-8");
}

/** 更新头行首行的当前值快照(name/model/tools,§3.3.1/§4.10.1),与 CLI 侧 updateHeader 同语义。 */
function updateHeaderLine(path: string, patch: Record<string, unknown>): void {
  const entries = readEntries(path);
  if (entries[0] && typeof entries[0] === "object" && (entries[0] as Record<string, unknown>).type === "session") {
    entries[0] = { ...(entries[0] as Record<string, unknown>), ...patch };
    writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
  }
}

/** SessionToolConfig → probe4 工具集翻译(§5.6.1):bash→full / write→write / 否则 read-only。
 *  与 CLI 侧 toolSetFromIds 同语义(两份实现一规则,靠测试守卫对账)。导出供 backend.setTools 复用。 */
export function toolSetFromConfig(config: SessionToolConfig): string {
  const ids = config.enabledToolIds ?? [];
  if (ids.includes("bash")) return "full";
  if (ids.includes("write")) return "write";
  return "read-only";
}

/** 工具集 → 工具 id 清单的反向映射(readToolConfig 用,§5.6.1 读回)。 */
const TOOL_SET_IDS: Record<string, string[]> = {
  "read-only": ["read", "list"],
  "write": ["read", "list", "write"],
  "full": ["read", "list", "write", "bash"],
};

/** 删除会话文件(真删,§3.4.1 删除归中立层、私有文件同步回收)。 */
export function probe4DeleteSessionFile(path: string): void {
  try { rmSync(path, { force: true }); } catch { /* 文件不存在/占用忽略,中立层已删 */ }
}

/** probe4 的 SessionCatalog:目录/CRUD 面,读 probe4 自己的线性会话文件。 */
export class Probe4Catalog implements SessionCatalog {
  readonly kernel = "probe4" as const;

  constructor(private readonly agentDir: string) {}

  async rename(sessionId: string, name: string): Promise<void> {
    // sessionId = probe4 文件路径(projectionPath 派生);追加 session_info 改名条目。
    probe4AppendSessionInfo(sessionId, name);
  }

  async updateHeader(sessionId: string, patch: HeaderPatch): Promise<void> {
    // pinned/archived 纯中立层(projectHeaderToKernel 已跳过内核写)。toolConfig(§5.6.1):
    // 壳下发的 enabledToolIds → 翻译成 probe4 自己的工具集(bash→full / write→write /
    // 否则 read-only),落头行 tools 字段,CLI 重开时读回。null=删配置 → 回落 read-only。
    if (patch.toolConfig != null) {
      updateHeaderLine(sessionId, { tools: toolSetFromConfig(patch.toolConfig) });
    } else if (patch.toolConfig === null) {
      updateHeaderLine(sessionId, { tools: "read-only" });
    }
  }

  async deleteSessions(sessionIds: string[]): Promise<void> {
    for (const id of sessionIds) probe4DeleteSessionFile(id);
  }

  copy(_srcId: string, _dstId: string): void {
    // 书签快照素材由中立层承担,probe4 不拷副本(§3.4.3 bookmark 只存坐标)。
  }

  async readToolConfig(sessionId: string): Promise<SessionToolConfig | null> {
    // §5.6.1 读回:头行 tools 工具集 → enabledToolIds 反向映射。与 updateHeader 对称(能写能读),
    // 否则工具管理页读回 null、显示"无配置"(曾漂移:只写不读)。
    const entries = readEntries(sessionId);
    const tools = (entries[0] as { tools?: string } | undefined)?.tools;
    const ids = tools ? TOOL_SET_IDS[tools] : undefined;
    return ids ? { enabledToolIds: ids } : null;
  }

  async readCustom(_sessionId: string): Promise<Record<string, unknown> | null> {
    return null;
  }

  contextProbeTokens(_sessionId: string): number | null {
    return null;
  }

  newSessionId(cwd: string): string | null {
    // probe4 是文件态内核(与 pi 同预生成,§8.2.2):新会话路径 = 派生路径(文件名 = 新 ns)。
    // 曾返 null(惰性)——但 null 是 dsh(RPC)的语义,ensureForSend 据此把 probe4 误判成
    // 惰性内核(!touched && lazyKernel → 空会话切模型不必要重启),文件态内核应预生成。
    return probe4DerivedSessionPath(this.agentDir, cwd, randomUUID());
  }

  projectionPath(cwd: string, lineageId: string): string {
    return probe4DerivedSessionPath(this.agentDir, cwd, lineageId);
  }

  rawFilePath(cwd: string, lineageId: string): string | null {
    const p = probe4DerivedSessionPath(this.agentDir, cwd, lineageId);
    return existsSync(p) ? p : null;
  }

  /**
   * 项目统计：**从 probe4 自己的会话文件里算**（此前恒返全零）。
   *
   * 全零的代价不是"少几个数字"，而是**读起来像"这个项目一条会话都没有"**：
   * 壳侧 `SessionStore.projectStats` 会把各内核的数字**相加**（pi/dsh/probe4 各报一份），
   * 于是 probe4 的会话在统计面板里等于不存在。dsh 走 `sessionProjectStats` 由内核算，
   * pi 有自己的扫描；probe4 这里是第三条实现，必须**同等诚实**地报它能报的：
   *   · sessionCount / turns —— 从自己的文件数得出来，就报真数（`turns` = user 消息条数）；
   *   · tokens —— 从 `message.usage` 累加（圆心 `messageUsageOf` 是唯一解析处，壳与内核同源）；
   *   · cost —— probe4 不做计价（没有价格表），**留 0**，不编造（§4.9 的"不伪造"口径）。
   * 单个文件损坏跳过、不炸整次统计（与列出会话同一条降级纪律）。
   */
  async projectStats(cwd: string): Promise<ProjectStats> {
    const zero: ProjectStats = { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0, sessionCount: 0, turns: 0 };
    const dir = join(this.agentDir, "sessions", cwdToBucketName(cwd));
    if (!existsSync(dir)) return zero;
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      return zero;
    }
    const acc = { ...zero, tokens: { ...zero.tokens } };
    for (const f of files) {
      let text: string;
      try {
        text = readFileSync(join(dir, f), "utf-8");
      } catch {
        continue; // 不可读：跳过，不炸整次统计
      }
      acc.sessionCount += 1;
      for (const line of text.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          const e = JSON.parse(t) as { type?: unknown; message?: unknown };
          if (e.type !== "message") continue; // 头行与分隔条目不计
          const msg = e.message as { role?: unknown } | undefined;
          if (msg?.role === "user") acc.turns += 1;
          const u = messageUsageOf(msg);
          if (u) {
            acc.tokens.input += u.tokens.input;
            acc.tokens.output += u.tokens.output;
            acc.tokens.cacheRead += u.tokens.cacheRead;
            acc.tokens.cacheWrite += u.tokens.cacheWrite;
            acc.tokens.total += u.tokens.total;
            acc.cost += u.cost;
          }
        } catch {
          continue; // 单行损坏跳过
        }
      }
    }
    return acc;
  }

  async getTree(sessionId: string): Promise<LineageTree> {
    // probe4 是单线执行器,单 lineage 树;文件存在即一条根 lineage,不存在返回空树。
    const entries = readEntries(sessionId);
    const rootId = typeof (entries[0] as Record<string, unknown>)?.id === "string" ? (entries[0] as Record<string, unknown>).id as string : "";
    return rootId ? { rootId, lineages: [{ id: rootId, fork: null }] } : { rootId: "", lineages: [] };
  }

  bookmark(_cwd: string, lineageId: string, boundary: string): Anchor {
    return { lineageId, entryId: boundary }; // 只存中立坐标(§3.4.3),不拷副本。
  }

  deleteBookmark(_anchor: Anchor): void {
    // 无副本回收(bookmark 只存坐标)。
  }
}
