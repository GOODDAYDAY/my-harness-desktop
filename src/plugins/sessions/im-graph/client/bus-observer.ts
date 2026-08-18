// im-graph/client/bus-observer —— Session Bus 出站封装:status 基线 + tap 订阅 + 帧增量,
// 全部 ctx.bus 调用收敛此一处,组件不直接碰。观察策略:
//   每房间 tap channel(流量天然稀疏,订阅即得全部房间帧)
//   每会话 tap lifecycle(五边界事件,够 busy 亮灭/完成判定)
//   聚焦某会话时该会话升级 stream(全量事件流供事件流面板;stream 闸门只许
//   plugin 目标,本插件正是),退出聚焦降回 lifecycle——同时至多一个 stream。
// 帧里出现图上没有的会话(新 spawn 未入基线)→ 防抖 refresh 补齐并重挂 tap。
import type { BusApi, SessionBusMessage, TapFilter } from "@my-harness-desktop/contract";
import {
  applyFrame, applyStatus, emptyModel, type FlowPulse, type GraphModel,
} from "../core/graph-model";

const REFRESH_DEBOUNCE_MS = 600;
/** 会话 tap 的两种档位:默认 lifecycle,聚焦时 stream。channel tap 不吃 filter。 */
type SessionTapFilter = Extract<TapFilter, "lifecycle" | "stream">;

export interface ObserverHooks {
  onModel(model: GraphModel, pulses: FlowPulse[]): void;
  /** 聚焦会话的 stream 事件透传(eventType + 原始 SessionEvent;事件流面板消费)。 */
  onSessionEvent?(sessionKey: string, eventType: string, event: unknown): void;
}

export class BusObserver {
  private model: GraphModel = emptyModel();
  /** 观察目标("s:<key>" / "c:<name>")→ tap 句柄(filter 仅会话目标有意义)。 */
  private tapIds = new Map<string, { tapId: string; filter?: SessionTapFilter }>();
  private offMessage: (() => void) | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private focusedKey: string | null = null;
  private stopped = false;

  constructor(
    private readonly bus: BusApi,
    private readonly selfAddress: string,
    private readonly hooks: ObserverHooks,
  ) {}

  async start(): Promise<void> {
    this.offMessage = this.bus.onMessage((msg) => this.onMessage(msg));
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const status = await this.bus.status();
    if (this.stopped) return;
    this.model = applyStatus(this.model, status);
    await this.syncTaps();
    this.hooks.onModel(this.model, []);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.offMessage?.();
    this.offMessage = null;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    for (const { tapId } of this.tapIds.values()) await this.bus.tapStop(tapId).catch(() => {});
    this.tapIds.clear();
  }

  /** 聚焦:该会话 tap 升级 stream(同时至多一个;先降级旧的)。 */
  async focus(key: string): Promise<void> {
    if (this.stopped || this.focusedKey === key) return;
    await this.unfocus();
    this.focusedKey = key;
    await this.retapSession(key, "stream");
  }

  /** 退出聚焦:降回 lifecycle。 */
  async unfocus(): Promise<void> {
    if (!this.focusedKey) return;
    const key = this.focusedKey;
    this.focusedKey = null;
    await this.retapSession(key, "lifecycle");
  }

  private async retapSession(key: string, filter: SessionTapFilter): Promise<void> {
    const target = `s:${key}`;
    const cur = this.tapIds.get(target);
    if (cur?.filter === filter) return;
    if (cur) {
      await this.bus.tapStop(cur.tapId).catch(() => {});
      this.tapIds.delete(target);
    }
    try {
      const result = await this.bus.tapStart({ session: key, filter });
      const tapId = (result as { tapId?: unknown }).tapId;
      if (typeof tapId === "string") this.tapIds.set(target, { tapId, filter });
    } catch {
      // 目标会话已死:下轮 refresh 基线自然剔除
    }
  }

  private async syncTaps(): Promise<void> {
    const wanted = new Set<string>();
    for (const name of this.model.channels.keys()) wanted.add(`c:${name}`);
    for (const key of this.model.sessions.keys()) wanted.add(`s:${key}`);
    for (const [target, { tapId }] of [...this.tapIds]) {
      if (!wanted.has(target)) {
        await this.bus.tapStop(tapId).catch(() => {});
        this.tapIds.delete(target);
      }
    }
    for (const target of wanted) {
      if (this.tapIds.has(target)) continue;
      if (target.startsWith("c:")) {
        try {
          const result = await this.bus.tapStart({ channel: target.slice(2) });
          const tapId = (result as { tapId?: unknown }).tapId;
          if (typeof tapId === "string") this.tapIds.set(target, { tapId });
        } catch {
          // 房间随最后成员离开已消散:下轮 refresh 自愈
        }
      } else {
        const key = target.slice(2);
        await this.retapSession(key, key === this.focusedKey ? "stream" : "lifecycle");
      }
    }
  }

  private onMessage(msg: SessionBusMessage): void {
    if (this.stopped || msg.to !== this.selfAddress) return;
    if (msg.kind === "tap_event" && this.focusedKey && msg.from === `session:${this.focusedKey}`) {
      const p = msg.payload as { eventType?: unknown; event?: unknown } | undefined;
      if (typeof p?.eventType === "string") this.hooks.onSessionEvent?.(this.focusedKey, p.eventType, p.event);
    }
    const result = applyFrame(this.model, msg, Date.now());
    this.model = result.model;
    this.hooks.onModel(this.model, result.pulses);
    if (result.unknownSeen) this.scheduleRefresh();
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh().catch(() => {});
    }, REFRESH_DEBOUNCE_MS);
  }
}
