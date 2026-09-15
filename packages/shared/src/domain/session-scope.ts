// 圆心:会话作用域契约(纯类型 + 纯函数,零依赖)。
//
// 定位:机制契约。「一份状态属于哪个会话、会话身份切换时它怎么搬、作用域终结时怎么回收」
// 这三件事的形状在所有消费方那里完全一致(设计 docs/design/session-scope.md §1.2.1),
// 差别只在参数——状态的类型、合并策略、回收动作。参数级差异按 CLAUDE.md §3.3 收敛到
// 一份实现:圆心出身份算法与槽契约,壳机制层出容器(src/web/stores/session-scope.ts),
// 发布面出声明式 API(packages/react/src/session-scope.ts)。
//
// 为什么身份算法必须在圆心:renderer 侧此前有四种「当前会话是谁」的口径并存
// (中立主键 ns / 投影路径 / 壳键 `new:${cwd}` / main 侧 proc.key),每个消费方自己拼一套,
// 于是同一个会话在不同插件里是两个 key、投影路径在 dsh 会话与迁移前旧 pi 会话上压根不存在
// (设计 §1.1.2)。口径收敛成一个纯函数后,加一个消费方不再产生第五种拼装。
//
// 零依赖纪律(CLAUDE.md §6.2):本文件不 import 任何外部包、不碰 IO、不感知环境。
// 需要查表的归一(scopeKeyFromSessionKey)把查表函数当参数收进来,由外层注入。

/** 会话作用域 key 的唯一算法(契约单源,CLAUDE.md §1.3;设计 §2.2.1)。
 *
 *  - 已物化会话 = 中立主键 ns(壳自己生成、跨内核稳定,docs/design/kernel-forkless-branch.md §32);
 *  - 未物化壳 = `new:${cwd}`(与草稿/排队/模型意图同一口径,设计 §0.2);
 *  - 两者皆无 = null(没有激活会话,调用方不该读写任何槽)。
 *
 *  投影路径(`currentSessionPath`)**不参与**:它是内核坐标系,`SessionInfo.path` 的契约注释
 *  明写「投影地址是坐标系,不承诺磁盘上有文件」(packages/shared/src/domain/sessions.ts:37-39)。
 *  拿它当身份会让 dsh 会话(投影地址是裸 lineageId)与迁移前旧 pi 会话(可能没有投影文件)
 *  落到错误的桶上——设计 §3.3.2 记录的正是这个后果。
 *
 *  物化那一刻身份会从壳键换成 ns,挂在壳键上的状态由容器的 carry 搬迁(设计 §2.3.2),
 *  调用方不需要也不应该自己侦测这个切换。 */
export function sessionScopeKey(ns: string | null | undefined, cwd: string | null | undefined): string | null {
  if (typeof ns === "string" && ns.length > 0) return ns;
  if (typeof cwd === "string" && cwd.length > 0) return `new:${cwd}`;
  return null;
}

/** 壳键的判别(设计 §2.2.1):作用域 key 是壳键形态时,会话还没落盘,头行写不进去。
 *  与 `sessionScopeKey` 的壳键分支同一形态定义,单源在此,消费方不要自己写 startsWith。 */
export function isShellScopeKey(scopeKey: string): boolean {
  return scopeKey.startsWith("new:");
}

/** main 侧 proc.key → 作用域 key 的归一(设计 §2.2.2)。
 *
 *  proc.key 是 main 侧进程账的键(src/server/application/sessions/session-store.ts:104-107):
 *  初值等于投影路径或壳键,但 fork/clone 对账经 rekeyProc 迁到新路径后**不再等于任何
 *  renderer 侧的值**。renderer 消费运维流(onKernelEvent,每条事件带 sessionKey)之前必须归一,
 *  否则「是不是激活会话」的判定会错——设计 §1.1.2 记录的 goal 后台归账 round 双跳就是这个后果。
 *
 *  归一在 renderer 侧执行(消费运维流的那一侧),查表数据是 renderer 内存里的 sessionInfos
 *  (由 main 广播维护)。圆心零 IO,所以查表函数由调用方注入:命中即返回中立主键,
 *  未命中说明这个 key 本身就是 ns(正常态,main 侧 key 与 ns 同形的会话)。 */
export function scopeKeyFromSessionKey(
  sessionKey: string,
  lookup: (sessionKey: string) => string | undefined | null,
): string {
  return lookup(sessionKey) ?? sessionKey;
}

/** 物化搬迁(壳键 → 真身 ns)时,目标键已有值的处置(设计 §2.2.4)。
 *
 *  三种是同一件事的参数化,不是三类槽:都是「旧键的值怎么进新键」。
 *  这是数据本身的合并语义,不是让引擎按类型戳分支的外挂标签(设计 §4.2 论证了这个区别):
 *  合并算法读它选一条路径,加一种形态只加一个策略值、算法内一处。 */
export type CarryPolicy =
  /** 目标为空则整体搬过去;目标已有值则以目标为准(草稿、模型意图、目标态)。 */
  | "move"
  /** 追加到目标已有值之后(待发队列、评论篮)。首版按数组语义合并,见 §2.3.2。 */
  | "concat"
  /** 不搬:值随旧域一起丢弃(在飞瞬态——流式占位、工具在飞登记;搬了就是把壳态当真身态)。 */
  | "drop";

/** 一个会话作用域槽的声明。插件 export const sessionSlots: SessionSlot[] 即完成注册
 *  (plugins-host 收集,与 channels / auxParsers / composerCommands / channelMeta 同款机制)。
 *
 *  五个字段,每个都对应「按会话隔离」这件事的一个维度(设计 §2.2.3): */
export interface SessionSlot<T = unknown> {
  /** ① 槽 id(同插件内唯一)。框架按 `${pluginId}:${id}` 拼成 slotKey 存储,插件侧只见短 id——
   *  与 PluginIdContext 自动注入 pluginId 同一手法(CLAUDE.md §8.3 零硬编码:
   *  插件代码里不出现自己的 id 字面量)。 */
  id: string;

  /** ② 初始值或工厂。**值本身是可变容器(对象/数组/Map/Set)时必须用工厂形态**:
   *  若写 `initial: new Map()`,注册时只求值一次、所有会话共享同一个实例,
   *  A 会话的数据直接出现在 B 会话里,隔离从第一行就失效(设计 §2.2.3)。
   *  框架在注册期对值形态的可变容器发 dev 告警,把这个坑拦在注册期而不是运行期。 */
  initial: T | (() => T);

  /** ③ 物化搬迁时的合并策略(缺省 "move")。 */
  carry?: CarryPolicy;

  /** ④ 回收钩子:由框架在**两个**时机调用——drop(删除会话,设计 §2.3.2)与插件卸载
   *  (unregisterSessionSlots,设计 §2.4.4);这是仅有的两个调用点。
   *
   *  切会话换档与 carry 的 "drop" 策略都**不**调它:换档时本域原封保留(后台归账要有处可写,
   *  设计 §2.3.3/§4.5.5),carry 丢弃的旧值随旧域不可达由 GC 回收(设计 §2.2.4)。
   *  四个时机的完整对照见设计 §4.5.5。
   *
   *  钩子的职责边界(设计 §2.4.4):**只释放外部资源**(退订、清定时器、关句柄),
   *  不清空自己的数据——数据留存与否是容器的决定(留,供热装恢复),不是钩子的。
   *  框架保留槽的 `clear` 型 onLeave 是例外且无害:它们不随插件卸载,只在删除会话时跑,
   *  而那时整个作用域都要被摘除。 */
  onLeave?: (value: T) => void;

  /** ⑤ 搬迁后钩子:carry 把值搬进新键之后由框架调用一次。
   *
   *  value = 搬进新键的那份值(concat 策略下是合并后的结果);
   *  toKey = 新作用域 key(真身 ns),由 carry 在调用时**作为参数传入**,
   *  不是回调内部去读当前 scopeKey——这是有意的设计(设计 §2.2.5):onCarry 在 microtask 里
   *  执行(避免在 store 的 reducer 内做副作用),microtask 落地前用户完全可能又切走了会话;
   *  若钩子读当前 scopeKey,持久化补写就会写进用户刚切过去的那个会话。
   *
   *  用途:内存态搬好了,但持久化真相源(会话头行 custom 域)还挂在旧身份上写不进去——
   *  壳键期间会话尚未落盘,头行够不到。goal 用它在物化后把 custom.goal 补写进真身头行
   *  (设计 §3.2.3)。异步实现由声明者自理(fire-and-forget),框架不 await、不重试:
   *  内存槽已搬好,头行写失败只影响「刷新后能否恢复」,下一次状态变更会再写一遍。 */
  onCarry?: (value: T, toKey: string) => void;
}

/** 槽的命名空间键:`${pluginId}:${id}`(设计 §2.3.1)。
 *  拼装规则单源在此——机制层(store)与发布面(hook)都必须经它,不许各自手写模板串,
 *  否则两侧算出的键对不上,插件写进去机制读不出来。 */
export function sessionSlotKey(pluginId: string, slotId: string): string {
  return `${pluginId}:${slotId}`;
}

/** 判断一个 initial 是否「值形态的可变容器」(注册期 dev 告警用,设计 §2.2.3/§2.3.4)。
 *  对象/数组/Map/Set 都算(共享实例会让隔离失效),null 与标量不算;函数形态是工厂,不在此列。 */
export function isMutableContainer(value: unknown): boolean {
  return value !== null && typeof value === "object";
}

/** concat 策略的合并语义(设计 §2.3.2):首版按数组实现——这是现有全部 concat 消费方的形态
 *  (待发队列 QueuedMessage[]、评论篮 ReviewComment[])。
 *
 *  非数组值**降级为 move 并显式告警**,不静默(CLAUDE.md §1.5:静默缺面是唯一不允许的状态):
 *  降级结果是「目标已有值时以目标为准」,数据不丢、只是不追加,且告警让声明者知道自己声明错了。
 *  将来出现 Map 形态的 concat 需求,扩 SessionSlot 加 `concatBy?: (dst, src) => T`,机制层结构不变。
 *
 *  返回 `{ value, degraded }`:degraded=true 表示走了降级路径,调用方据此发一次 dev 告警。 */
export function concatCarriedValues<T>(dst: T | undefined, src: T): { value: T; degraded: boolean } {
  if (Array.isArray(dst) && Array.isArray(src)) {
    return { value: [...dst, ...src] as unknown as T, degraded: false };
  }
  if (dst === undefined) return { value: src, degraded: false };
  // 目标已有值且两侧不都是数组 → 以目标为准(move 语义)
  return { value: dst, degraded: true };
}
