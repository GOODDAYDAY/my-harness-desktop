// 事件总线 —— renderer 侧的插件间事件通道。
//
// 依据 docs/design/plugin-isolation-principles.md §3.2-3.4。
// 代码即声明:插件 export const channels = [...],框架 import module 后读 channels 注册。
// emit 校验 channel 在自己的 channels export 里声明过。
// on 校验 channel 来自某个已加载插件或 system:* 框架事件。
// replayLast:缓存每个 channel 最近一次 emit 的 payload,新订阅者可选回放。
//
// 会话作用域 channel(设计 docs/design/session-scope.md §2.5):channelMeta 声明 scope:"session"
// 的 channel,框架在 emit 时自动注入作用域坐标(信封 { __scope, payload })、on 时按坐标过滤
// 投递、replayLast 按坐标分桶回放。缺省 global 的 channel 行为完全不变。坐标解析器由装配期
// 注入(setScopeKeyResolver)——event-bus 住在 packages/react(内层),不反向 import src/web(外层),
// 这是依赖倒置:内层声明「我需要一个能告诉我当前作用域的函数」,外层提供实现。

type EventHandler = (payload: unknown) => void;

import type { ChannelMeta, ChannelInfo } from "@my-harness-desktop/shared";

/** 作用域坐标解析器(设计 §2.5.2):由装配期绑定到 ui-store 的身份字段。
 *  与 session-scope store 的 currentScopeKey 绑同一个函数——状态写进哪个域、事件坐标是什么,
 *  两者同源,不会出现「状态写进 A 域、事件坐标是 B」的错配。 */
let scopeKeyResolver: (() => string | null) | null = null;
/** 绑定/解绑作用域坐标解析器(装配期调;传 null 解绑,测试用)。 */
export function setEventBusScopeKeyResolver(fn: (() => string | null) | null): void {
  scopeKeyResolver = fn;
}
function currentScopeKey(): string | null {
  if (!scopeKeyResolver) {
    // 装配未完成(测试环境或装配顺序被破坏):按「无会话」处理——scoped payload 仍派发但
    // 不进任何桶(切会话后不被回放),dev 告警一次,不抛错(抛错会让装配问题变白屏)。
    if (!resolverWarned) { resolverWarned = true; console.warn("[event-bus] scoped channel 在 setEventBusScopeKeyResolver 之前 emit/on——按无会话处理"); }
    return null;
  }
  return scopeKeyResolver();
}
let resolverWarned = false;
/** scoped channel 的传输信封:__scope 是坐标,payload 是插件的业务数据。 */
interface ScopedEnvelope { __scope: string | null; payload: unknown; }

interface ChannelState {
  handlers: Set<EventHandler>;
  lastPayload: unknown;
  hasLastPayload: boolean;
  /** scoped channel 的按作用域分桶回放缓存(设计 §2.5.3):scopeKey → 信封。
   *  global channel 仍用上面的 lastPayload(现状不变)。 */
  lastPayloadByScope: Map<string, ScopedEnvelope>;
  /** 归属插件 id(channel 注册时记录;枚举接口暴露,消费方(快捷键/命令面板)按插件分组)。 */
  pluginId: string;
  /** 可读描述(插件 channelMeta 可选导出,框架加载时收集;无则 undefined)。 */
  meta?: ChannelMeta;
}

/** 建一个空的 ChannelState(三处 new 同形,收敛成一个工厂,避免漏字段)。 */
function newChannelState(pluginId: string): ChannelState {
  return { handlers: new Set(), lastPayload: undefined, hasLastPayload: false, lastPayloadByScope: new Map(), pluginId };
}

class EventBusImpl {
  private channels = new Map<string, ChannelState>();
  private pluginChannels = new Map<string, Set<string>>();
  /** invoke 待发队列:目标 channel 暂无订阅者时 payload 在此排队,
   *  首个订阅者 attach 时按序冲刷——懒挂载组件(侧栏 tab)的可靠投递,
   *  不 sleep、不靠 replayLast 误重放(invoke 是一次性命令,不是可回放的状态)。 */
  private pendingInvokes = new Map<string, unknown[]>();
  /** 框架内部侦听(不暴露给插件):任何 emit/invoke/emitSystem 派发前同步触发。
   *  只观察者——回调里再 emit/invoke 会无限自激,禁止;抛错兜底不阻断派发。 */
  private taps = new Set<(channel: string) => void>();
  private systemPrefix = "system:";

  isSystemChannel(channel: string): boolean {
    return channel.startsWith(this.systemPrefix);
  }

  /** 注册框架内部侦听,返回反注册函数。不进 PluginEventsApi——插件不可用。 */
  tap(fn: (channel: string) => void): () => void {
    this.taps.add(fn);
    return () => this.taps.delete(fn);
  }

  private fireTaps(channel: string): void {
    for (const fn of this.taps) {
      try {
        fn(channel);
      } catch (err) {
        console.warn(`[event-bus] tap 侦听异常(${channel}):`, err);
      }
    }
  }

  registerChannels(pluginId: string, channels: readonly string[], meta?: Record<string, ChannelMeta>): void {
    let set = this.pluginChannels.get(pluginId);
    if (!set) {
      set = new Set();
      this.pluginChannels.set(pluginId, set);
    }
    for (const ch of channels) {
      set.add(ch);
      let state = this.channels.get(ch);
      if (!state) {
        state = newChannelState(pluginId);
        this.channels.set(ch, state);
      }
      if (meta && meta[ch]) state.meta = meta[ch];
    }
  }

  /** 动态枚举当前已注册的全部插件 channel(不含 system:* 框架事件——invoke 不支持系统频道,快捷键不可绑)。
   *  供快捷键/命令面板类插件在设置页列出可绑定目标;插件卸载后条目自动消失。 */
  listChannels(): ChannelInfo[] {
    const out: ChannelInfo[] = [];
    for (const [ch, state] of this.channels) {
      if (this.isSystemChannel(ch)) continue;
      out.push({
        channel: ch,
        pluginId: state.pluginId,
        ...(state.meta ? { meta: state.meta } : {}),
      });
    }
    return out;
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
      this.pendingInvokes.delete(ch);
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
    this.fireTaps(channel);
    const scoped = state.meta?.scope === "session";
    if (scoped) {
      // 注入作用域坐标(信封)。resolver 未注入时 key=null:仍派发给 global 语义的订阅者
      // (下方 on 的过滤会因 null!==ns 丢弃给 scoped 订阅者),但不进任何桶——设计 §2.5.2 错配边界。
      const key = currentScopeKey();
      const env: ScopedEnvelope = { __scope: key, payload };
      if (key) state.lastPayloadByScope.set(key, env);
      for (const handler of state.handlers) handler(env);
      return;
    }
    state.lastPayload = payload;
    state.hasLastPayload = true;
    for (const handler of state.handlers) {
      handler(payload);
    }
  }

  /** 定向分派(与 pub/sub 的 emit 区分):channel 必须属于某个已加载插件——
   *  调用方不需要拥有它,这是框架约定的调用通道(fileActions 等)用的原语。
   *  无订阅者时入队等首个订阅者;有订阅者立即投递。 */
  invoke(callerId: string, channel: string, payload?: unknown): void {
    if (this.isSystemChannel(channel)) {
      throw new Error(`invoke 不支持系统频道 ${channel}`);
    }
    const state = this.channels.get(channel);
    if (!state) {
      throw new Error(`plugin ${callerId} invoke 的 channel ${channel} 未被任何已加载插件注册`);
    }
    this.fireTaps(channel);
    if (state.handlers.size === 0) {
      const queue = this.pendingInvokes.get(channel) ?? [];
      queue.push(payload);
      this.pendingInvokes.set(channel, queue);
      return;
    }
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
      state = newChannelState("system");
      this.channels.set(channel, state);
    }
    this.fireTaps(channel);
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
      state = newChannelState("");
      this.channels.set(channel, state);
    }
    const scoped = state.meta?.scope === "session";
    // scoped:包一层过滤 handler——每次投递时取当前 key 比对(不在订阅时固定,因为订阅者
    // 可能常驻、活得比会话长;设计 §2.5.3)。非当前作用域的 payload 直接丢。
    const effective: EventHandler = scoped
      ? (w) => {
          // unregisterPlugin 的 teardown 哨兵是 null,不绑作用域,原样透传(否则解引用崩)。
          if (w === null) { handler(null); return; }
          const env = w as ScopedEnvelope;
          if ((env.__scope ?? null) !== currentScopeKey()) return;
          handler(env.payload);
        }
      : handler;
    if (opts?.replayLast) {
      if (scoped) {
        const key = currentScopeKey();
        const cached = key ? state.lastPayloadByScope.get(key) : undefined;
        if (cached) handler(cached.payload);   // 只回放本作用域那一桶
      } else if (state.hasLastPayload) {
        handler(state.lastPayload);
      }
    }
    state.handlers.add(effective);
    // 冲刷待发 invoke:恰好一次投递——队列清空后,后到的订阅者不会收到历史 invoke
    const pending = this.pendingInvokes.get(channel);
    if (pending && pending.length > 0) {
      this.pendingInvokes.delete(channel);
      for (const payload of pending) {
        handler(payload);
      }
    }
    return () => {
      state!.handlers.delete(effective);
    };
  }

  /** 清某作用域在全部 scoped channel 上的回放桶(设计 §2.5.3):会话删除时由 scope store 的
   *  drop 调用(onScopeDrop 注入),两个机制在 drop 这一个点汇合。不清则回放桶无界增长。 */
  dropScope(scopeKey: string): void {
    for (const state of this.channels.values()) {
      state.lastPayloadByScope.delete(scopeKey);
    }
  }
}

export const eventBus = new EventBusImpl();

// PluginEventsApi 唯一定义在圆心 domain/context.ts(经 @my-harness-desktop/shared 发布),
// 此处不再保留副本——契约单源(§1.3),此前双份定义在 invoke 切片时被迫同步两处。
export type { PluginEventsApi } from "@my-harness-desktop/shared";
