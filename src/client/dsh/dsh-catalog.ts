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

  async rename(_sessionId: string, _name: string): Promise<void> {
    throw new Error(NOT_WIRED);
  }

  async updateHeader(_sessionId: string, _patch: HeaderPatch): Promise<void> {
    throw new Error(NOT_WIRED);
  }

  async deleteSessions(_sessionIds: string[]): Promise<void> {
    throw new Error(NOT_WIRED);
  }

  copy(_srcId: string, _dstId: string): void {
    throw new Error(NOT_WIRED);
  }

  async readToolConfig(_sessionId: string): Promise<SessionToolConfig | null> {
    throw new Error(NOT_WIRED);
  }

  async readCustom(_sessionId: string): Promise<Record<string, unknown> | null> {
    throw new Error(NOT_WIRED);
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

  async getTree(_sessionId: string): Promise<LineageTree> {
    throw new Error(NOT_WIRED);
  }

  bookmark(_cwd: string, _lineageId: string, _boundary: string): Anchor {
    throw new Error(NOT_WIRED);
  }

  deleteBookmark(_anchor: Anchor): void {
    throw new Error(NOT_WIRED);
  }
}
