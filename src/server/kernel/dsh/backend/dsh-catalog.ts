// dsh 的 SessionCatalog:目录/CRUD 的 dsh 实现。dsh 的会话真相源在 dsh 进程内的
// ctx.sessions + sessionPersistence,所以目录/CRUD 经一个懒初始化的 dsh transport 走
// JSON-RPC(session/list/get/rename/delete),不读 dsh 日志文件(壳不读内核存储不变量)。
// transport 由 bootstrap 注入工厂(闭包捕获 dsh spawn 配置),首次目录操作时懒 spawn、之后复用。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SessionInfo, SessionDetail, SessionToolConfig, HeaderPatch } from "@my-harness-desktop/shared";
import type { ProjectStats, NeutralMessage } from "@my-harness-desktop/shared";
import type { SessionCatalog, LineageTree, Anchor, ToolResultWriteback } from "@my-harness-desktop/shared";
import { cwdToBucketName } from "@my-harness-desktop/shared";
import { withDirLock } from "../../../application/config/config-file";
import type { JsonRpcTransport } from "../protocol/json-rpc";
import { DSH_METHODS } from "../protocol/dsh-methods";

const NOT_WIRED = "dsh 后端会话目录/CRUD 未接线(待 dsh 侧补 session/rename/delete/updateHeader)";

/** dsh 目录工厂入参:懒 transport 工厂(bootstrap 闭包捕获 spawn 配置)。 */
export interface DshCatalogOptions {
  createTransport: () => Promise<JsonRpcTransport>;
  /** dsh 会话持久化根(= spawn 注入的 DSH_SESSION_ROOT,bootstrap 闭包捕获)。
   *  目录解析原始文件路径用;缺省 = 未知根,rawFilePath 返回 null(显式降级,不硬猜)。 */
  sessionRoot?: string;
}

export class DshSessionCatalog implements SessionCatalog {
  readonly kernel = "dsh" as const;
  private transportPromise: Promise<JsonRpcTransport> | null = null;

  constructor(private readonly opts: DshCatalogOptions) {}

  private async transport(): Promise<JsonRpcTransport> {
    this.transportPromise ??= this.opts.createTransport();
    return this.transportPromise;
  }

  async rename(sessionId: string, name: string): Promise<void> {
    const t = await this.transport();
    await t.request(DSH_METHODS.sessionRename, { sessionId, name });
  }

  async updateHeader(sessionId: string, patch: HeaderPatch): Promise<void> {
    const t = await this.transport();
    await t.request(DSH_METHODS.sessionUpdateHeader, {
      sessionId,
      patch: { pinned: patch.pinned, archived: patch.archived, custom: patch.custom },
    });
  }

  async deleteSessions(sessionIds: string[]): Promise<void> {
    const t = await this.transport();
    for (const id of sessionIds) {
      await t.request(DSH_METHODS.sessionDelete, { sessionId: id });
    }
  }

  copy(_srcId: string, _dstId: string): void {
    throw new Error(NOT_WIRED);
  }

  async readToolConfig(_sessionId: string): Promise<SessionToolConfig | null> {
    // dsh 无 tool-gate(pi 专属扩展面):工具启停配置缺面 → 返回 null,壳按「无配置」处理。
    // 不抛错——发送路径会读它(renderer sendMessage),抛错会打断发送前的工具过滤(§7.6 显式降级)。
    return null;
  }

  async readCustom(sessionId: string): Promise<Record<string, unknown> | null> {
    const t = await this.transport();
    const detail = await t.request<{ info: { custom?: Record<string, unknown> } } | null>(DSH_METHODS.sessionGet, { sessionId });
    return detail?.info.custom ?? null;
  }

  contextProbeTokens(_sessionId: string): number | null {
    return null;
  }

  newSessionId(_cwd: string): null {
    // dsh 惰性创建会话:无需预生成内核侧会话标识,服务端首次 prompt 时建(§5 阶段 2)。
    return null;
  }

  projectionPath(_cwd: string, lineageId: string): string {
    return lineageId;
  }

  rawFilePath(cwd: string, lineageId: string): string | null {
    // dsh 投影地址是裸 lineageId(坐标系,不是文件路径)——真实落盘形状是
    // <sessionRoot>/<cwd 桶>/<lineageId>/session.jsonl(明文诊断模式,ask 续问起;
    // 旧形态是 .zstd 压缩)。两种形态都认(存在才返回);根未注入 → null(显式降级)。
    if (!this.opts.sessionRoot) return null;
    const dir = join(this.opts.sessionRoot, cwdToBucketName(cwd), lineageId);
    for (const name of ["session.jsonl", "session.jsonl.zstd"]) {
      const p = join(dir, name);
      if (existsSync(p)) return p;
    }
    return null;
  }

  /** 迟到的 toolResult 补写(ask 续路,docs/design/ask-design.md §5.2/§6.4):
   *  直接编辑明文会话日志(<sessionRoot>/<cwd 桶>/<lineageId>/session.jsonl)追加
   *  一行 tool/result 事件(形状照抄 dsh repair 的合法闭合件)。前提:发起进程已死
   *  (调用方已停同槽位存活进程)——编辑发生在下一次 resume 的加载路径之前,repair 不抢先。
   *  降级红线:压缩形态(.zstd)/文件不存在/锚点缺失 → 抛错,调用方降级用户消息通道,
   *  不静默、不伪造。cwd 由调用方从记录带过来(catalog 不从 sessionId 反推桶)。 */
  async appendToolResult(sessionId: string, toolCallId: string, outcome: ToolResultWriteback, cwd?: string): Promise<void> {
    if (!this.opts.sessionRoot || !cwd) {
      throw new Error("dsh 续路缺会话根或 cwd,显式降级");
    }
    const dir = join(this.opts.sessionRoot, cwdToBucketName(cwd), sessionId);
    const file = join(dir, "session.jsonl");
    if (!existsSync(file)) {
      throw new Error(existsSync(join(dir, "session.jsonl.zstd"))
        ? "dsh 会话日志是压缩形态(.zstd),续路写显式降级"
        : `dsh 会话日志不存在: ${file}`);
    }
    await withDirLock(dir, async () => {
      let content = readFileSync(file, "utf-8");
      // 撕裂尾部截断:上次死亡留下的不完整末行,截到最后一个完整换行——并写回文件,
      // 只截变量不写回 = 追加仍在撕裂尾之后(修复:test 抓到半截行残留)。
      if (content.length > 0 && !content.endsWith("\n")) {
        const lastNl = content.lastIndexOf("\n");
        content = lastNl === -1 ? "" : content.slice(0, lastNl + 1);
        writeFileSync(file, content, "utf-8");
      }
      let hasCall = false;
      let hasResult = false;
      let lastSeq = 0;
      let callTurn = 0;
      let callStep = 0;
      let callSeq: number | null = null;
      for (const line of content.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          const j = JSON.parse(t) as { type?: unknown; seq?: unknown; data?: Record<string, unknown> };
          if (typeof j.seq === "number" && j.seq > lastSeq) lastSeq = j.seq;
          if (j.type === "tool/call" && String(j.data?.callId ?? "") === toolCallId) {
            hasCall = true;
            callSeq = typeof j.seq === "number" ? j.seq : null;
            callTurn = typeof j.data?.turn === "number" ? j.data.turn : 0;
            callStep = typeof j.data?.step === "number" ? j.data.step : 0;
          }
          if (j.type === "tool/result") {
            const msg = j.data?.message as { content?: unknown[] } | undefined;
            const block = (Array.isArray(msg?.content) ? msg!.content[0] : undefined) as Record<string, unknown> | undefined;
            if (block && String(block.toolCallId ?? "") === toolCallId) hasResult = true;
          }
        } catch { /* 损坏行跳过 */ }
      }
      if (hasResult) return; // 幂等:已配对,不重复追加
      if (!hasCall) throw new Error(`锚点不在该 lineage 日志: ${toolCallId}`);
      const cancelled = outcome.cancelled === true;
      const answers = cancelled ? [] : outcome.answers;
      // 事件形状照抄 dsh repair 的合法闭合件(core/session/src/repair.ts):
      // data.turn/step 是契约必填(session/types.ts 的 tool/result),surfaceOp 是 surface
      // 事件的强制元数据,sourceEventSeqs 引用被闭合的 tool/call;isError:false + 真答案,
      // cancelled 走 isError:true 同形。
      const entry = {
        type: "tool/result",
        seq: lastSeq + 1,
        time: Date.now(),
        data: {
          turn: callTurn,
          step: callStep,
          message: {
            id: randomUUID().slice(0, 8),
            role: "user",
            source: { kind: "tool", callId: toolCallId },
            content: [{
              type: "tool-result",
              toolCallId,
              isError: cancelled,
              content: [{ type: "text", text: cancelled ? "User cancelled the question" : JSON.stringify({ answers }) }],
            }],
          },
        },
        surfaceOp: "append",
        ...(callSeq !== null ? { sourceEventSeqs: [callSeq] } : {}),
      };
      await appendFile(file, JSON.stringify(entry) + "\n", "utf-8");
    });
  }

  async projectStats(cwd: string): Promise<ProjectStats> {
    const t = await this.transport();
    return t.request<ProjectStats>(DSH_METHODS.sessionProjectStats, { cwd });
  }

  async getTree(sessionId: string): Promise<LineageTree> {
    const t = await this.transport();
    return t.request<LineageTree>(DSH_METHODS.sessionGetTree, { sessionId });
  }

  bookmark(_cwd: string, lineageId: string, boundary: string): Anchor {
    // 坐标书签(session-neutral-layer §12):只返回坐标,不需 RPC;resume 现场 fork 校验 source。
    return { lineageId, entryId: boundary };
  }

  deleteBookmark(_anchor: Anchor): void {
    // 坐标书签无副本回收,no-op。
  }
}
