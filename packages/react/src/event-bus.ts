// 事件总线 —— renderer 侧的插件间事件通道。
//
// 依据 docs/design/plugin-isolation-principles.md §3.2-3.4。
// 代码即声明:插件 export const channels = [...],框架 import module 后读 channels 注册。
// emit 校验 channel 在自己的 channels export 里声明过。
// on 校验 channel 来自某个已加载插件或 system:* 框架事件。
// replayLast:缓存每个 channel 最近一次 emit 的 payload,新订阅者可选回放。

type EventHandler = (payload: unknown) => void;

interface ChannelState {
  handlers: Set<EventHandler>;
  lastPayload: unknown;
  hasLastPayload: boolean;
}

class EventBusImpl {
  private channels = new Map<string, ChannelState>();
  private pluginChannels = new Map<string, Set<string>>();
  private systemPrefix = "system:";

  isSystemChannel(channel: string): boolean {
    return channel.startsWith(this.systemPrefix);
  }

  registerChannels(pluginId: string, channels: readonly string[]): void {
    let set = this.pluginChannels.get(pluginId);
    if (!set) {
      set = new Set();
      this.pluginChannels.set(pluginId, set);
    }
    for (const ch of channels) {
      set.add(ch);
      if (!this.channels.has(ch)) {
        this.channels.set(ch, { handlers: new Set(), lastPayload: undefined, hasLastPayload: false });
      }
    }
  }

  unregisterPlugin(pluginId: string): void {
    const set = this.pluginChannels.get(pluginId);
    if (!set) return;
    for (const ch of set) {
      const state = this.channels.get(ch);
      if (state) {
        for (const handler of state.handlers) {
          handler(null);
        }
      }
      this.channels.delete(ch);
    }
    this.pluginChannels.delete(pluginId);
  }

  channelExists(channel: string): boolean {
    return this.channels.has(channel) || this.isSystemChannel(channel);
  }

  isChannelOwnedBy(pluginId: string, channel: string): boolean {
    const set = this.pluginChannels.get(pluginId);
    return set?.has(channel) ?? false;
  }

  emit(pluginId: string, channel: string, payload?: unknown): void {
    if (this.isSystemChannel(channel)) {
      throw new Error(`plugin ${pluginId} 无权 emit 系统事件 ${channel}`);
    }
    if (!this.isChannelOwnedBy(pluginId, channel)) {
      throw new Error(`plugin ${pluginId} emit 未声明的 channel ${channel}`);
    }
    const state = this.channels.get(channel);
    if (!state) {
      throw new Error(`channel ${channel} 未注册`);
    }
    state.lastPayload = payload;
    state.hasLastPayload = true;
    for (const handler of state.handlers) {
      handler(payload);
    }
  }

  emitSystem(channel: string, payload?: unknown): void {
    if (!this.isSystemChannel(channel)) {
      throw new Error(`emitSystem 仅限 system:* channel,收到 ${channel}`);
    }
    let state = this.channels.get(channel);
    if (!state) {
      state = { handlers: new Set(), lastPayload: undefined, hasLastPayload: false };
      this.channels.set(channel, state);
    }
    state.lastPayload = payload;
    state.hasLastPayload = true;
    for (const handler of state.handlers) {
      handler(payload);
    }
  }

  on(channel: string, handler: EventHandler, opts?: { replayLast?: boolean }): () => void {
    if (!this.channelExists(channel)) {
      throw new Error(`channel ${channel} 未被任何已加载插件注册`);
    }
    let state = this.channels.get(channel);
    if (!state) {
      state = { handlers: new Set(), lastPayload: undefined, hasLastPayload: false };
      this.channels.set(channel, state);
    }
    if (opts?.replayLast && state.hasLastPayload) {
      handler(state.lastPayload);
    }
    state.handlers.add(handler);
    return () => {
      state!.handlers.delete(handler);
    };
  }
}

export const eventBus = new EventBusImpl();

export interface PluginEventsApi {
  emit(channel: string, payload?: unknown): void;
  on(channel: string, handler: (payload: unknown) => void, opts?: { replayLast?: boolean }): () => void;
}
