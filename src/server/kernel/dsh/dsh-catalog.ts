// dsh 的 SessionCatalog:目录/CRUD 的 dsh 实现。dsh 的会话真相源在 dsh 进程内的
// ctx.sessions + sessionPersistence,所以目录/CRUD 经一个懒初始化的 dsh transport 走
// JSON-RPC(session/list/get/rename/delete),不读 dsh 日志文件(壳不读内核存储不变量)。
// transport 由 bootstrap 注入工厂(闭包捕获 dsh spawn 配置),首次目录操作时懒 spawn、之后复用。
import type { SessionInfo, SessionDetail, SessionToolConfig, HeaderPatch } from "@my-harness-desktop/shared";
import type { ProjectStats, NeutralMessage } from "@my-harness-desktop/shared";
import type { SessionCatalog, LineageTree, Anchor } from "@my-harness-desktop/shared";
import type { JsonRpcTransport } from "./json-rpc";
import { DSH_METHODS } from "./dsh-methods";

const NOT_WIRED = "dsh 后端会话目录/CRUD 未接线(待 dsh 侧补 session/rename/delete/updateHeader)";

/** dsh 目录工厂入参:懒 transport 工厂(bootstrap 闭包捕获 spawn 配置)。 */
export interface DshCatalogOptions {
  createTransport: () => Promise<JsonRpcTransport>;
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
