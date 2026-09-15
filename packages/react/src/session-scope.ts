// 会话作用域发布面(设计 docs/design/session-scope.md §2.4)——壳插件唯一可见的作用域 API。
//
// 与 auxParsers / composerCommands / channelMeta 同款机制:plugins-host 收集插件 module 的
// sessionSlots 导出 → registerSessionSlots 写进 store 的注册表(单源在 store,本文件不另存一份)
// → 消费方经 useSessionScope / useSessionScopeAccess 读。卸载对称摘除。
//
// 全部读口都是 hook 形态,这是有意的(设计 §2.4.1 的实现修正,见文件末「与设计文档的偏离」):
// slotKey = `${pluginId}:${slotId}`,而 pluginId 由 PluginIdContext 注入、只能在 hook 里读到
// (CLAUDE.md §8.3 零硬编码:插件代码里不出现自己的 id 字面量)。所以「非渲染场景读最新值」
// 不能做成裸函数——那会逼插件手传 pluginId。正解是 hook 返回一组**已绑定 pluginId 的闭包**,
// 插件把它存进 ref 供事件回调/命令桥使用(与 goal 现有 handleCommandRef 同一手法,只是收进框架)。
//
// 依赖方向:本文件 import src/web/stores/session-scope(壳机制层)与圆心契约。
// 住在 packages/react 是发布面惯例(与 composer-commands.ts / composer-top.ts 同层),
// 插件只 import @my-harness-desktop/react,不直接碰 src/web。
import { useCallback, useMemo } from "react";
import { usePluginId } from "./plugin-id-context";
import { useUiStore } from "../../../src/web/stores/ui-store";
import { sessionSlotKey, sessionScopeKey, type SessionSlot } from "@my-harness-desktop/shared";
import {
  useSessionScopeStore,
  readTolerant,
  currentScopeKey,
} from "../../../src/web/stores/session-scope";

/** 插件的作用域读写面(全部已绑定 pluginId,可在事件回调/异步收口里安全使用)。 */
export interface SessionScopeAccess<T = unknown> {
  /** 当前作用域 key(事件回调里比对「是不是激活会话」用)。 */
  scopeKey(): string | null;
  /** 读当前作用域的槽。未注册抛错(非渲染侧显式失败优于静默 undefined,设计 §2.3.4)。 */
  get(): T | undefined;
  /** 写当前作用域的槽。无激活会话时丢弃(设计 §2.4.5:undefined 态 setter 是空操作)。 */
  set(next: T | ((prev: T | undefined) => T)): void;
  /** 读**指定**作用域的槽(事件驱动写入方与后台归账用:身份来自事件的 sessionKey 经
   *  scopeKeyFromSessionKey 归一,不是「用户此刻在看哪个会话」;设计 §2.4.5)。 */
  getAt(scopeKey: string): T | undefined;
  /** 写**指定**作用域的槽。 */
  setAt(scopeKey: string, next: T | ((prev: T | undefined) => T)): void;
}

/** 注册表的写入口:plugins-host 收集 mod.sessionSlots 时调(设计 §2.4.1)。
 *  注册表的**单源在 store**(useSessionScopeStore.slots),本函数只是它的写入口,不另存一份——
 *  否则 carry/drop 遍历的注册表与插件注册的注册表会漂移。 */
export function registerSessionSlots(pluginId: string, slots: SessionSlot[]): void {
  useSessionScopeStore.getState().registerSlots(pluginId, slots);
}

/** 卸载摘除(设计 §2.4.4):摘掉该插件全部槽,对**每个会话域里**的已存在值调 onLeave
 *  (释放订阅/定时器),但不删 scopes 里的数据——插件可能热装回来,用户的态要原样恢复。 */
export function unregisterSessionSlots(pluginId: string): void {
  useSessionScopeStore.getState().unregisterSlots(pluginId);
}

/** 当前作用域 key(设计 §2.4.1):身份算法的唯一合法出口。
 *  订阅 ui-store 的两个身份字段,身份一变消费方就重渲染——这是「切会话自动换档」的机制基础:
 *  scopeKey 变 → 所有 useSessionScope 读到新会话那份,插件不需要写任何侦测会话切换的 effect
 *  (goal 现有的物化补写分支 / foreign 判据 / alive 竞态守卫全部因此失去存在理由,设计 §3.2.2)。 */
export function useCurrentScopeKey(): string | null {
  const ns = useUiStore((s) => s.currentNeutralSessionId);
  const cwd = useUiStore((s) => s.currentCwd);
  return sessionScopeKey(ns, cwd);
}

/** 渲染侧读口(设计 §2.4.2):返回 [值, setter]。
 *  值可能是 undefined——两种成因(槽未注册 / 无激活会话),消费方按设计 §2.4.5 三态处置:
 *  undefined = 机制不可用,null = 业务上的「没有」,其余 = 正常值。
 *  nonce 订阅必需:scopes 是双层 Map,内层写不一定换外层引用,靠递增 nonce 触发重渲染。 */
export function useSessionScope<T>(slotId: string): [T | undefined, (next: T | ((prev: T | undefined) => T)) => void] {
  const pluginId = usePluginId();
  const slotKey = sessionSlotKey(pluginId, slotId);
  // 订阅 nonce(任何作用域写都递增)+ 身份字段(切会话换档)
  useSessionScopeStore((s) => s.nonce);
  const scopeKey = useCurrentScopeKey();
  const value = scopeKey ? readTolerant<T>(slotKey, scopeKey) : undefined;
  const setter = useCallback((next: T | ((prev: T | undefined) => T)) => {
    const key = currentScopeKey();
    if (!key) return;   // 无激活会话:写丢弃(没有会话能取回)
    useSessionScopeStore.getState().write<T>(slotKey, key, next as T | ((prev: T) => T));
  }, [slotKey]);
  return [value, setter];
}

/** ref 形态读口(设计 §2.4.3):给「在组件里订阅、但在事件回调/异步收口里读最新值」的场景。
 *  current 每次渲染刷新;回调里要拿**调用那一刻**的最新值,用 useSessionScopeAccess 的 get()
 *  (它直接读 store 快照,不经渲染闭包)。省掉插件手工维护的 xxxRef 桥
 *  (goal 现有 goalRef / setGoalRef / handleCommandRef 三个就是为此;设计 §2.4.3)。 */
export function useSessionScopeRef<T>(slotId: string): { current: T | undefined } {
  const pluginId = usePluginId();
  const slotKey = sessionSlotKey(pluginId, slotId);
  useSessionScopeStore((s) => s.nonce);
  const scopeKey = useCurrentScopeKey();
  return { current: scopeKey ? readTolerant<T>(slotKey, scopeKey) : undefined };
}

/** 作用域读写面(设计 §2.4.3 非渲染读口的正确形态):返回一组已绑定 pluginId 的闭包。
 *  插件在组件里取一次、存进 ref 或直接放进 useCallback deps,即可在事件回调、命令桥、
 *  异步收口(firePrompt 的 finally 补发那种)里读写最新值——不经闭包捕获旧值。
 *
 *  为什么必须是 hook 返回闭包、而不是裸函数:slotKey 需要 pluginId,而 pluginId 由
 *  PluginIdContext 注入、只能在 hook 里读;裸函数会逼插件手传自己的 id,违反 §8.3 零硬编码。 */
export function useSessionScopeAccess<T>(slotId: string): SessionScopeAccess<T> {
  const pluginId = usePluginId();
  const slotKey = sessionSlotKey(pluginId, slotId);
  return useMemo<SessionScopeAccess<T>>(() => {
    const store = () => useSessionScopeStore.getState();
    return {
      scopeKey: () => currentScopeKey(),
      get: () => {
        const key = currentScopeKey();
        if (!key) return undefined;
        return store().read<T>(slotKey, key);
      },
      set: (next) => {
        const key = currentScopeKey();
        if (!key) return;
        store().write<T>(slotKey, key, next as T | ((prev: T) => T));
      },
      getAt: (sk) => store().read<T>(slotKey, sk),
      setAt: (sk, next) => store().write<T>(slotKey, sk, next as T | ((prev: T) => T)),
    };
  }, [slotKey]);
}

// ============================================================================
// 与设计文档的偏离(实现期发现,已回写设计 §2.4.1/§2.4.3)
// ============================================================================
// 设计 §2.4.1 列的发布面里有三个裸函数:getSessionScopeValue(slotId) /
// setSessionScopeValue(slotId, next) / …At(slotId, scopeKey, …)。实现时发现它们拿不到
// pluginId——slotKey 的命名空间前缀来自 PluginIdContext,只能在 hook 里读;做成裸函数就得让
// 插件手传自己的 id,与 CLAUDE.md §8.3「插件代码里不出现自己的 id 字面量」直接冲突。
//
// 修正:三个裸函数收成一个 hook `useSessionScopeAccess(slotId)`,返回已绑定 pluginId 的
// { scopeKey, get, set, getAt, setAt }。语义完全等价(同样能读最新值、同样能按域写),
// 差别只在「闭包由框架绑定 pluginId」而非「调用方传 pluginId」。这不是简化也不是缩水:
// 它是把设计里那条「插件侧只见短 id」的纪律贯彻到非渲染路径——原设计只在渲染路径贯彻了。
