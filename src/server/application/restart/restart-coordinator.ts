// 重启协调器 —— application 层,追踪 pending restart + 事件驱动空闲重载。
//
// 依据 docs/core/extension-management.md §3.2(接口)、§3.3(事件驱动)、§3.4(进程级重启)。
// 不 import electron:通过 SessionStoreForRestart 接口(依赖倒置)操作 session。
// 协调器不定义 key 格式——从 sessionStore.getRunningSessionKeys() 拿、原样传回。
import type {
  RestartCoordinator,
  RestartState,
  SessionStoreForRestart,
} from "@my-harness-desktop/shared";

export class RestartCoordinatorImpl implements RestartCoordinator {
  private store: SessionStoreForRestart;
  private states = new Map<string, RestartState>();
  private listeners = new Set<(sessionKey: string, state: RestartState) => void>();
  private pendingSubscriptions = new Map<string, () => void>();

  constructor(store: SessionStoreForRestart) {
    this.store = store;
  }

  markPending(sessionKey: string, reason: string): void {
    this.states.set(sessionKey, { status: "pending", reason, ts: Date.now() });
    this.broadcast(sessionKey);
    this.tryRestart(sessionKey);
  }

  markPendingAll(sessionKeys: string[], reason: string): void {
    for (const key of sessionKeys) {
      this.markPending(key, reason);
    }
  }

  getState(sessionKey: string): RestartState {
    return this.states.get(sessionKey) ?? { status: "idle" };
  }

  isIdle(sessionKey: string): boolean {
    return !this.store.isBusy(sessionKey);
  }

  async restart(sessionKey: string): Promise<void> {
    const state = this.states.get(sessionKey);
    if (state?.status === "restarting") return;

    this.states.set(sessionKey, { status: "restarting" });
    this.broadcast(sessionKey);

    this.cleanupSubscription(sessionKey);

    try {
      await this.store.restart(sessionKey);
      this.states.set(sessionKey, { status: "idle" });
    } catch (err) {
      this.states.set(sessionKey, {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
    this.broadcast(sessionKey);
  }

  async restartIdlePending(): Promise<void> {
    const tasks: Promise<void>[] = [];
    for (const [key, state] of this.states) {
      if (state.status === "pending" && this.isIdle(key)) {
        tasks.push(this.restart(key));
      }
    }
    await Promise.all(tasks);
  }

  onStateChange(cb: (sessionKey: string, state: RestartState) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private tryRestart(sessionKey: string): void {
    const state = this.states.get(sessionKey);
    if (state?.status !== "pending") return;

    if (this.isIdle(sessionKey)) {
      void this.restart(sessionKey);
    } else {
      this.subscribeUntilIdle(sessionKey);
    }
  }

  private subscribeUntilIdle(sessionKey: string): void {
    this.cleanupSubscription(sessionKey);

    const unsub = this.store.onSessionEvent(sessionKey, (event) => {
      if (event.type === "agentSettled") {
        this.cleanupSubscription(sessionKey);
        if (this.states.get(sessionKey)?.status === "pending") {
          void this.restart(sessionKey);
        }
      }
    });
    this.pendingSubscriptions.set(sessionKey, unsub);
  }

  private cleanupSubscription(sessionKey: string): void {
    const unsub = this.pendingSubscriptions.get(sessionKey);
    if (unsub) {
      unsub();
      this.pendingSubscriptions.delete(sessionKey);
    }
  }

  private broadcast(sessionKey: string): void {
    const state = this.states.get(sessionKey) ?? { status: "idle" };
    for (const cb of this.listeners) {
      try {
        cb(sessionKey, state);
      } catch (err) {
        console.error("[restart-coordinator] 状态监听器抛错已隔离:", err);
      }
    }
  }
}
