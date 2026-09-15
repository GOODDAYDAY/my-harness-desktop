// 会话作用域容器(renderer 侧壳机制)——「按会话隔离」这件事的唯一承载者。
//
// 设计文档:docs/design/session-scope.md。本文件是 §2.3 的落地:存储形状(§2.3.1)、
// 四个动作 read/write/carry/drop(§2.3.2)、多会话并存(§2.3.3)、惰性建域与失败形态(§2.3.4)、
// 框架七个保留槽自注册(§2.6.1)。
//
// 为什么需要它(设计 §1.2.2):此前「按会话隔离」在全仓有五处实现、五种做法——ui-store 硬编码
// 三张 map + carrySessionKey,review 手写第二遍物化迁移,goal 自造 goalBirthPath 假坐标,
// session-colors 八处混用两种 key 口径,框架自己的两个登记表压根不回收。五处互不知晓,
// 修好一处不会传导到其余四处。根因是 ui-store 是机制层、枚举不到插件模块里的变量,
// 所以「把第四张表加进 carrySessionKey」这条路对插件本来就不通。
//
// 解法是注册表 + 遍历:插件 export sessionSlots 声明进来,carry/drop 遍历注册表,
// 加第 N 张表机制层零改动(设计 §2.1.3 搬迁自动化)。
//
// 依赖方向(洋葱):本文件只 import 圆心(@my-harness-desktop/shared)与 zustand,零外层 import。
// 两处需要外层的地方都用注入,不用 import:
//   · 当前作用域 key —— setScopeKeyResolver 由装配期绑到 ui-store 的身份字段(设计 §2.2.1);
//     若直接 import ui-store,批 2 起 ui-store 反过来调本 store 的 carry 就成环。
//   · drop 清事件回放桶 —— onScopeDrop 由装配期连到 eventBus.dropScope(设计 §2.5.3)。
import { create } from "zustand";
import {
  sessionSlotKey,
  isMutableContainer,
  concatCarriedValues,
  type CarryPolicy,
  type SessionSlot,
} from "@my-harness-desktop/shared";

/** 框架保留槽的属主 id(设计 §2.6.1):机制层内部常量,不占插件 id 空间,
 *  也不在任何插件的卸载路径上——框架槽不随插件热装/卸载而 onLeave。 */
export const FRAMEWORK_PLUGIN_ID = "__framework__";

/** 作用域被摘除时的回调(设计 §2.5.3):drop 在这里通知事件总线清回放桶。
 *  由装配期注入(src/web/app),store 自己不 import event-bus——依赖倒置。 */
type ScopeDropListener = (scopeKey: string) => void;
const scopeDropListeners = new Set<ScopeDropListener>();

/** 注册作用域摘除回调,返回反注册函数。 */
export function onScopeDrop(cb: ScopeDropListener): () => void {
  scopeDropListeners.add(cb);
  return () => { scopeDropListeners.delete(cb); };
}

/** 当前作用域 key 的解析器由**装配期注入**(设计 §2.2.1/§2.5.2)。
 *
 *  为什么注入而不是直接 import ui-store:批 2 起 ui-store 的 carrySessionKey 要调本 store 的
 *  carry,若本 store 反向 import ui-store 就成环。更重要的是依赖方向——身份算法在圆心
 *  (sessionScopeKey),「从哪读身份」是外层细节:本 store 声明「我需要一个能告诉我当前
 *  作用域的函数」,src/web/app 在装配期把它绑到 useUiStore 的两个身份字段上。
 *
 *  event-bus 的 scoped channel 坐标(设计 §2.5.2)绑定的是同一个函数——两处消费同一份
 *  身份解析,不会出现「状态写进 A 域、事件坐标是 B」的错配。 */
let scopeKeyResolver: (() => string | null) | null = null;
export function setScopeKeyResolver(fn: () => string | null): void {
  scopeKeyResolver = fn;
}
/** 当前作用域 key。resolver 未注入(装配未完成/测试环境)返回 null——按「无激活会话」处理:
 *  读走容错路径返回 undefined、写丢弃并告警,不抛错(抛错会让一个装配顺序问题变成白屏)。 */
export function currentScopeKey(): string | null {
  if (!scopeKeyResolver) {
    warnOnce("resolver", "currentScopeKey 在 setScopeKeyResolver 之前被调用——装配顺序被破坏?按「无激活会话」处理");
    return null;
  }
  return scopeKeyResolver();
}

/** 值形态可变容器的 dev 告警去重(同一 slotKey 只报一次,不刷屏)。 */
const warnedSlots = new Set<string>();
function warnOnce(slotKey: string, msg: string): void {
  if (warnedSlots.has(slotKey)) return;
  warnedSlots.add(slotKey);
  console.warn(`[session-scope] ${msg}`);
}

export interface SessionScopeState {
  /** scopeKey → (slotKey → 值)。**多会话并存**:后台会话的槽也在,不只激活那一份
   *  (设计 §2.3.3——goal 后台归账要有处可写,否则切过去时读不到真实瞬态)。 */
  scopes: Map<string, Map<string, unknown>>;
  /** 槽注册表(**单源**):slotKey → 声明。carry/drop 遍历它,不硬编码字段名
   *  (设计 §2.3.1/§2.4.1:发布面的 registerSessionSlots 写的就是这张表,不另存一份)。 */
  slots: Map<string, SessionSlot>;
  /** slotKey → 属主 pluginId(卸载时按属主摘槽;设计 §2.4.4)。 */
  slotOwners: Map<string, string>;
  /** 变更代际:任何写递增,hook 据此订阅(与 pluginsNonce / syncNonce / openNonce 同款手法)。
   *  必需:scopes 是双层 Map,内层写不一定换外层引用,zustand 的 selector 不会重渲染。 */
  nonce: number;

  /** 注册槽(plugins-host 收集 mod.sessionSlots 时调;设计 §2.4.1)。 */
  registerSlots: (pluginId: string, slots: SessionSlot[]) => void;
  /** 摘除某插件的全部槽,并对**每个会话域里**的已存在值调 onLeave(设计 §2.4.4)。
   *  不删 scopes 里的数据:插件可能热装回来,用户的态要原样恢复。 */
  unregisterSlots: (pluginId: string) => void;
  /** 读(渲染侧容错变体见 readTolerant)。未注册的槽**抛错**——返回 undefined 会让
   *  「插件忘了声明」与「这个会话没有该状态」表现一致,根因永远查不出来(设计 §2.3.4)。 */
  read: <T>(slotKey: string, scopeKey: string) => T;
  /** 写。 */
  write: <T>(slotKey: string, scopeKey: string, next: T | ((prev: T) => T)) => void;
  /** 物化搬迁:壳键 → 真身 ns(设计 §2.3.2)。遍历注册表按各槽策略搬,随后逐槽调 onCarry。 */
  carry: (from: string, to: string) => void;
  /** 摘除整个作用域:逐槽调 onLeave + 通知事件总线清回放桶(设计 §2.3.2)。
   *  唯一调用点是 removeSessionRows(设计 §2.3.2;静态守卫检查④盯这条接线)。 */
  drop: (scopeKey: string) => void;
}

export const useSessionScopeStore = create<SessionScopeState>((set, get) => ({
  scopes: new Map(),
  slots: new Map(),
  slotOwners: new Map(),
  nonce: 0,

  registerSlots: (pluginId, slots) => {
    const nextSlots = new Map(get().slots);
    const nextOwners = new Map(get().slotOwners);
    for (const slot of slots) {
      const slotKey = sessionSlotKey(pluginId, slot.id);
      // 注册期拦截「值形态的可变容器」:共享实例会让隔离从第一行就失效(设计 §2.2.3)。
      if (!(typeof slot.initial === "function") && isMutableContainer(slot.initial)) {
        warnOnce(slotKey, `槽 ${slotKey} 的 initial 是可变容器(${slot.initial instanceof Map ? "Map" : Array.isArray(slot.initial) ? "Array" : "Object"}),所有会话会共享同一实例、隔离失效——改成工厂形态 initial: () => …`);
      }
      nextSlots.set(slotKey, slot);
      nextOwners.set(slotKey, pluginId);
    }
    set({ slots: nextSlots, slotOwners: nextOwners });
  },

  unregisterSlots: (pluginId) => {
    const { slots, slotOwners, scopes } = get();
    const owned: string[] = [];
    for (const [slotKey, owner] of slotOwners) {
      if (owner === pluginId) owned.push(slotKey);
    }
    if (owned.length === 0) return;
    // onLeave 遍历**全部会话域**的已存在值,不只激活域(设计 §2.4.4):
    // 否则后台会话域里那份槽持有的资源(定时器、订阅)就泄了。
    for (const scope of scopes.values()) {
      for (const slotKey of owned) {
        if (!scope.has(slotKey)) continue;
        try { slots.get(slotKey)?.onLeave?.(scope.get(slotKey)); } catch (err) {
          console.error(`[session-scope] onLeave 抛错已隔离(${slotKey}):`, err);
        }
      }
    }
    const nextSlots = new Map(slots);
    const nextOwners = new Map(slotOwners);
    for (const slotKey of owned) { nextSlots.delete(slotKey); nextOwners.delete(slotKey); }
    set({ slots: nextSlots, slotOwners: nextOwners });
  },

  read: <T>(slotKey: string, scopeKey: string): T => {
    const slot = get().slots.get(slotKey);
    if (!slot) throw new Error(`未注册的会话槽 ${slotKey}(插件忘了 export sessionSlots?)`);
    return readSlot<T>(slotKey, scopeKey, slot);
  },

  write: <T>(slotKey: string, scopeKey: string, next: T | ((prev: T) => T)) => {
    const slot = get().slots.get(slotKey);
    if (!slot) throw new Error(`未注册的会话槽 ${slotKey}(插件忘了 export sessionSlots?)`);
    const scope = ensureScope(scopeKey);
    const prev = scope.has(slotKey) ? (scope.get(slotKey) as T) : resolveInitial<T>(slot);
    const value = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
    scope.set(slotKey, value);
    set((s) => ({ nonce: s.nonce + 1 }));
  },

  carry: (from, to) => {
    if (!from || !to || from === to) return;
    const { scopes, slots } = get();
    const src = scopes.get(from);
    if (!src) return;
    const dst = scopes.get(to) ?? new Map<string, unknown>();
    const carried: Array<{ slot: SessionSlot; value: unknown }> = [];
    for (const [slotKey, slot] of slots) {
      if (!src.has(slotKey)) continue;
      const v = src.get(slotKey);
      const policy: CarryPolicy = slot.carry ?? "move";
      if (policy === "drop") continue;   // 不搬;值随旧域一起丢(靠 GC,设计 §2.2.4)
      if (policy === "move") {
        if (!dst.has(slotKey)) { dst.set(slotKey, v); carried.push({ slot, value: v }); }
        continue;
      }
      // concat:目标已有值则追加(首版数组语义,非数组降级为 move 并告警)
      const merged = concatCarriedValues(dst.get(slotKey), v);
      if (merged.degraded) {
        warnOnce(slotKey, `槽 ${slotKey} 声明 carry:"concat" 但值不是数组,已降级为 move(以目标值为准)——改声明或扩 concatBy`);
      }
      dst.set(slotKey, merged.value);
      carried.push({ slot, value: merged.value });
    }
    const nextScopes = new Map(scopes);
    nextScopes.delete(from);
    nextScopes.set(to, dst);
    set({ scopes: nextScopes, nonce: get().nonce + 1 });
    // onCarry 在 set 之外调,避免在 reducer 内做副作用(钩子里会发 IPC)。
    // toKey 作为参数传入而非回调内读当前 scopeKey:microtask 落地前用户可能又切走,
    // 读渲染态会把补写落到错误的会话上(设计 §2.2.5)。
    if (carried.length > 0) {
      queueMicrotask(() => {
        for (const { slot, value } of carried) {
          try { slot.onCarry?.(value, to); } catch (err) {
            console.error("[session-scope] onCarry 抛错已隔离:", err);
          }
        }
      });
    }
  },

  drop: (scopeKey) => {
    const { scopes, slots } = get();
    const scope = scopes.get(scopeKey);
    if (!scope) return;
    for (const [slotKey, value] of scope) {
      try { slots.get(slotKey)?.onLeave?.(value); } catch (err) {
        console.error(`[session-scope] onLeave 抛错已隔离(${slotKey}):`, err);
      }
    }
    const next = new Map(scopes);
    next.delete(scopeKey);
    set({ scopes: next, nonce: get().nonce + 1 });
    // 通知事件总线清回放桶(设计 §2.5.3):两个机制在 drop 这一个点汇合,不散落。
    for (const cb of scopeDropListeners) {
      try { cb(scopeKey); } catch (err) { console.error("[session-scope] scopeDrop 回调抛错已隔离:", err); }
    }
  },
}));

/** 取(必要时建)某作用域的槽 map。惰性建域:会话数可能上百,预建全域是纯粹浪费。 */
function ensureScope(scopeKey: string): Map<string, unknown> {
  const { scopes } = useSessionScopeStore.getState();
  let scope = scopes.get(scopeKey);
  if (!scope) {
    scope = new Map();
    scopes.set(scopeKey, scope);
  }
  return scope;
}

/** 按声明算初值(工厂形态则调用)。 */
function resolveInitial<T>(slot: SessionSlot): T {
  return (typeof slot.initial === "function" ? (slot.initial as () => T)() : slot.initial) as T;
}

/** 读一个槽,不存在则按 initial 落一份(惰性)。落初值也是一次写,必须递增 nonce——
 *  否则首次 read 建域后订阅方不重渲染(与 carry/write 的递增口径一致;设计 §2.3.4)。 */
function readSlot<T>(slotKey: string, scopeKey: string, slot: SessionSlot): T {
  const scope = ensureScope(scopeKey);
  if (!scope.has(slotKey)) {
    scope.set(slotKey, resolveInitial<T>(slot));
    useSessionScopeStore.setState((s) => ({ nonce: s.nonce + 1 }));
  }
  return scope.get(slotKey) as T;
}

/** 渲染侧容错读(设计 §2.3.4):槽未注册时返回 undefined + dev 告警,**不抛**。
 *  React 渲染期抛错会冒到最近的错误边界,一个插件漏声明会炸掉整个 timeline,
 *  与 CLAUDE.md §10 QA「壳插件功能受限但不崩溃」冲突。漏声明是开发期错误,
 *  用 dev 告警 + 静态守卫(audit:session-scope)拦,不用运行期崩溃拦。
 *  非渲染侧(read / getSessionScopeValue)仍然抛错:它在事件回调里调用,
 *  抛错只影响那一次回调,显式失败比静默 undefined 好查。 */
export function readTolerant<T>(slotKey: string, scopeKey: string): T | undefined {
  const slot = useSessionScopeStore.getState().slots.get(slotKey);
  if (!slot) {
    warnOnce(`unregistered:${slotKey}`, `读取未注册的会话槽 ${slotKey}——插件是否忘了 export sessionSlots?`);
    return undefined;
  }
  return readSlot<T>(slotKey, scopeKey, slot);
}

/** 框架保留槽的读写(设计 §2.6.1/§2.6.2):不经 pluginId 注入,直接用 FRAMEWORK_PLUGIN_ID 拼键。
 *  不在发布面上,插件 import 不到。 */
export function readFrameworkSlot<T>(slotId: string, scopeKey: string): T {
  return readSlot<T>(sessionSlotKey(FRAMEWORK_PLUGIN_ID, slotId), scopeKey, frameworkSlotOrThrow(slotId));
}
export function writeFrameworkSlot<T>(slotId: string, scopeKey: string, next: T | ((prev: T) => T)): void {
  useSessionScopeStore.getState().write(sessionSlotKey(FRAMEWORK_PLUGIN_ID, slotId), scopeKey, next);
}
function frameworkSlotOrThrow(slotId: string): SessionSlot {
  const slot = useSessionScopeStore.getState().slots.get(sessionSlotKey(FRAMEWORK_PLUGIN_ID, slotId));
  if (!slot) throw new Error(`框架保留槽未注册:${slotId}(装配顺序被破坏?)`);
  return slot;
}

// ============================================================================
// 框架七个保留槽自注册(设计 §2.6.1)
// ============================================================================
//
// 框架自己的会话态也进容器,否则又是「机制两套」——插件的态有回收钩子,框架的态没有。
// 七个槽对应现状(设计 §2.6.1 表):
//   toolResultLedger / inflightToolCalls —— session-store.ts:24/:345 的两个模块级登记表,
//     此前全仓无 .clear(),切会话清了一半(overlay 清、登记表不清),跨会话撞 toolCallId 会
//     串工具结果/串在飞态(设计 §1.1.3)。carry:"drop" 因为它们是在飞瞬态。
//   overlay —— 流式占位与乐观回显,与 ledger 同理。
//   modelPending / pendingQueue / composerDraft —— ui-store 三张 Record 的内层值,
//     外层键由作用域承担,所以迁进来的是内层值(设计 §2.6.1)。
//   toolConfig —— ui-store.pendingToolConfig 的内层值(单值内嵌 sessionPath 的形态,
//     key 由作用域承担后内嵌字段删掉;设计 §4.6.5)。
//
// initial 一律用工厂或标量:Map/Set/数组必须是工厂,否则所有会话共享同一实例。
useSessionScopeStore.getState().registerSlots(FRAMEWORK_PLUGIN_ID, [
  {
    id: "toolResultLedger",
    initial: () => new Map<string, { result?: unknown; isError?: boolean; state?: string }>(),
    carry: "drop",
    // SessionSlot 的默认泛型是 unknown,钩子参数须显式收窄(值形态由本声明的 initial 保证)
    onLeave: (m): void => { (m as Map<string, unknown>).clear(); },
  },
  {
    id: "inflightToolCalls",
    initial: () => new Set<string>(),
    carry: "drop",
    onLeave: (s): void => { (s as Set<string>).clear(); },
  },
  { id: "overlay", initial: () => [], carry: "drop" },
  { id: "modelPending", initial: null, carry: "move" },
  { id: "pendingQueue", initial: () => [], carry: "concat" },
  { id: "composerDraft", initial: "", carry: "move" },
  { id: "toolConfig", initial: null, carry: "move" },
]);

/** 测试专用:清空全部作用域与告警去重(测试间隔离)。注册表不动——框架槽是模块级自注册,
 *  清空注册表会让后续测试读不到槽。 */
export function __resetScopesForTests(): void {
  useSessionScopeStore.setState({ scopes: new Map(), nonce: 0 });
  warnedSlots.clear();
}
