// im-graph/client/bus-observer —— Session Bus 出站封装:status 基线 + tap 订阅 + 帧增量,
// 全部 ctx.bus 调用收敛此一处,组件不直接碰。观察策略:
//   每房间 tap channel(流量天然稀疏,订阅即得全部房间帧)
//   每会话 tap lifecycle(五边界事件,够 busy 亮灭/完成判定;不挂 stream——
//   全量增量对面板是噪音,IPC 流量也贵)
// 帧里出现图上没有的会话(新 spawn 未入基线)→ 防抖 refresh 补齐并重挂 tap。
import type { BusApi, SessionBusMessage } from "@pi-desktop/contract";
import {
  applyFrame, applyStatus, emptyModel, type FlowPulse, type GraphModel,
} from "../core/graph-model";

const REFRESH_DEBOUNCE_MS = 600;

export class BusObserver {
  private model: GraphModel = emptyModel();
  /** 观察目标("s:<key>" / "c:<name>")→ tapId,stop 时逐个 tapStop。 */
  private tapIds = new Map<string, string>();
  private offMessage: (() => void) | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private readonly bus: BusApi,
    private readonly selfAddress: string,
    private readonly emit: (model: GraphModel, pulses: FlowPulse[]) => void,
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
    this.emit(this.model, []);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.offMessage?.();
    this.offMessage = null;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    for (const tapId of this.tapIds.values()) await this.bus.tapStop(tapId).catch(() => {});
    this.tapIds.clear();
  }

  private async syncTaps(): Promise<void> {
    const wanted = new Set<string>();
    for (const name of this.model.channels.keys()) wanted.add(`c:${name}`);
    for (const key of this.model.sessions.keys()) wanted.add(`s:${key}`);
    for (const [target, tapId] of [...this.tapIds]) {
      if (!wanted.has(target)) {
        await this.bus.tapStop(tapId).catch(() => {});
        this.tapIds.delete(target);
      }
    }
    for (const target of wanted) {
      if (this.tapIds.has(target)) continue;
      try {
        const result = target.startsWith("c:")
          ? await this.bus.tapStart({ channel: target.slice(2) })
          : await this.bus.tapStart({ session: target.slice(2), filter: "lifecycle" });
        const tapId = (result as { tapId?: unknown }).tapId;
        if (typeof tapId === "string") this.tapIds.set(target, tapId);
      } catch {
        // 目标会话已死:下轮 refresh 基线自然剔除
      }
    }
  }

  private onMessage(msg: SessionBusMessage): void {
    if (this.stopped || msg.to !== this.selfAddress) return;
    const result = applyFrame(this.model, msg, Date.now());
    this.model = result.model;
    this.emit(this.model, result.pulses);
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
