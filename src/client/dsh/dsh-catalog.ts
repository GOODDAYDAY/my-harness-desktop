// dsh 的 SessionCatalog:目录/CRUD 的 dsh 实现。dsh 的会话真相源在 dsh 进程内的
// ctx.sessions + sessionPersistence,所以目录/CRUD 经一个懒初始化的 dsh transport 走
// JSON-RPC(session/list/get/rename/delete),不读 dsh 日志文件(壳不读内核存储不变量)。
// transport 由 bootstrap 注入工厂(闭包捕获 dsh spawn 配置),首次目录操作时懒 spawn、之后复用。
import type { SessionInfo, SessionDetail, SessionToolConfig, HeaderPatch } from "../../core/domain/sessions";
import type { ProjectStats, NeutralMessage } from "../../core/domain/events/session-state";
import type { SessionCatalog, LineageTree, Anchor } from "../../core/domain/backend";
import type { JsonRpcTransport } from "./json-rpc";

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

  async list(cwd: string): Promise<SessionInfo[]> {
    const t = await this.transport();
    return t.request<SessionInfo[]>("session/list", { cwd });
  }

  async open(sessionId: string): Promise<SessionDetail | null> {
    const t = await this.transport();
    const detail = await t.request<{ info: SessionInfo; messages: NeutralMessage[] } | null>("session/get", { sessionId });
    if (!detail) return null;
    return { info: detail.info, messages: detail.messages, stats: null };
  }

  async rename(sessionId: string, name: string): Promise<void> {
    const t = await this.transport();
    await t.request("session/rename", { sessionId, name });
  }

  async updateHeader(sessionId: string, patch: HeaderPatch): Promise<void> {
    const t = await this.transport();
    await t.request("session/updateHeader", {
      sessionId,
      patch: { pinned: patch.pinned, archived: patch.archived, custom: patch.custom },
    });
  }

  async deleteSessions(sessionIds: string[]): Promise<void> {
    const t = await this.transport();
    for (const id of sessionIds) {
      await t.request("session/delete", { sessionId: id });
    }
  }

  copy(_srcId: string, _dstId: string): void {
    throw new Error(NOT_WIRED);
  }

  async readToolConfig(_sessionId: string): Promise<SessionToolConfig | null> {
    throw new Error(NOT_WIRED);
  }

  async readCustom(sessionId: string): Promise<Record<string, unknown> | null> {
    const t = await this.transport();
    const detail = await t.request<{ info: { custom?: Record<string, unknown> } } | null>("session/get", { sessionId });
    return detail?.info.custom ?? null;
  }

  contextProbeTokens(_sessionId: string): number | null {
    return null;
  }

  newSessionId(_cwd: string): string {
    throw new Error(NOT_WIRED);
  }

  async projectStats(_cwd: string): Promise<ProjectStats> {
    throw new Error(NOT_WIRED);
  }

  async getTree(sessionId: string): Promise<LineageTree> {
    const t = await this.transport();
    return t.request<LineageTree>("session/getTree", { sessionId });
  }

  bookmark(_cwd: string, lineageId: string, boundary: string): Anchor {
    // 坐标书签(session-neutral-layer §12):只返回坐标,不需 RPC;resume 现场 fork 校验 source。
    return { lineageId, entryId: boundary };
  }

  deleteBookmark(_anchor: Anchor): void {
    // 坐标书签无副本回收,no-op。
  }
}
