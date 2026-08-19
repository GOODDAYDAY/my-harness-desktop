// dsh 的 SessionCatalog:目录/CRUD 的 dsh 实现。dsh 的会话是 append-only log + session forest,
// 存储退进 dsh 后端——但 dsh 的 sdk-jsonrpc-server 尚未提供 session/list/get/rename/delete 等方法,
// 属「能力缺失」。按 §7.6 三分法:第一阶段显式降级(抛「未接线」,壳隐藏/置灰对应入口),
// 第二阶段给 dsh 补 JSON-RPC 方法后改走 transport(见 docs/design/session-storage-retreat.md §4.2)。
import type { SessionInfo, SessionDetail, SessionToolConfig, HeaderPatch } from "../../core/domain/sessions";
import type { ProjectStats } from "../../core/domain/events/session-state";
import type { SessionCatalog, LineageTree, Anchor } from "../../core/domain/backend";

const NOT_WIRED = "dsh 后端会话目录/CRUD 未接线(待 dsh 侧补 session/list/get/rename/delete)";

export class DshSessionCatalog implements SessionCatalog {
  readonly kernel = "dsh" as const;

  async list(_cwd: string): Promise<SessionInfo[]> {
    throw new Error(NOT_WIRED);
  }

  async open(_sessionId: string): Promise<SessionDetail | null> {
    throw new Error(NOT_WIRED);
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
    // dsh 无 pi 的 context-probe 侧车;context usage 由 dsh 原生暴露(Stage 3 补面)。
    return null;
  }

  newSessionId(_cwd: string): string {
    // dsh 会话惰性创建(首个 prompt 时),无「预生成 id」面;Stage 3 补面后由 spawn 返回。
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
