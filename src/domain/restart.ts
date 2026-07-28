// 圆心:重启协调器类型契约 —— domain,零依赖。
//
// 依据 docs/core/extension-management.md §3.2(RestartCoordinator)、§6.2(SessionStoreForRestart)。
// 圆心只定义类型和接口,实现在 application 层。
// 零外部依赖:不 import react/electron/pi(圆心纯度纪律)。
import type { SessionEvent } from "./events/session-state";

/** 一个 session 的重启状态(§3.2)。 */
export type RestartState =
  | { status: "idle" }
  | { status: "pending"; reason: string; ts: number }
  | { status: "restarting" }
  | { status: "failed"; error: string };

/** restart-coordinator 需要的 session-store 能力面(依赖倒置,§6.2)。 */
export interface SessionStoreForRestart {
  isBusy(sessionKey: string): boolean;
  onSessionEvent(sessionKey: string, cb: (event: SessionEvent) => void): () => void;
  getRunningSessionKeys(): string[];
  restart(sessionKey: string): Promise<void>;
  getCwdAndSessionPath(sessionKey: string): { cwd: string; sessionPath: string | null };
}

/** 重启协调器接口(§3.2)。 */
export interface RestartCoordinator {
  markPending(sessionKey: string, reason: string): void;
  markPendingAll(sessionKeys: string[], reason: string): void;
  getState(sessionKey: string): RestartState;
  isIdle(sessionKey: string): boolean;
  restart(sessionKey: string): Promise<void>;
  restartIdlePending(): Promise<void>;
  onStateChange(cb: (sessionKey: string, state: RestartState) => void): () => void;
}
