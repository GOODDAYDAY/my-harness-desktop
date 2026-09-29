// goal 续跑引擎 —— 纯壳插件内的 hook,不动 core/application、不动契约/IPC。
//
// 薄壳架构(CLAUDE.md §1.2 机制与内容分离):「回合结束后再发一份续跑提示继续」是**功能(内容)**,
// 不是壳机制。壳只提供机制面——onEvent/onKernelEvent(订阅中性事件)、messaging.prompt(发消息)、
// updateHeader/openSession/annotate(中立层读写)、events(插件间广播)、**会话作用域容器**
// (docs/design/session-scope.md:按会话隔离 + 物化搬迁 + 回收),续跑逻辑用这些机制拼,活在本插件里。
//
// ── 会话作用域迁移(设计 §3.2)────────────────────────────────────────────
// 目标态此前是模块级单例(currentGoal/goalBirthPath/lastSendError)+ hook ref,靠异步 effect
// 加字符串路径比对补换档,四个断点由此而来(设计 §1.3.3):
//   ① 新会话(currentSessionPath=null)时恢复 effect 早退,模块级单例不动 → 目标条串到新会话;
//   ② goalBirthPath 名为「诞生路径」实为「最后一次写状态时的路径」(每次 setGoal 都覆盖),
//      于是 foreign 判据不可靠,且 openSession 失败时 .catch 什么也不做(注释却说「保持无目标」)
//      → A 的目标挂在 B 的界面上、由 B 的 agentSettled 驱动续跑;
//   ③ 物化补写分支的判据永不成立(currentSessionPath 全仓没有写 `new:` 的赋值点)→ 死代码,
//      连带「壳期目标物化后补写头行」从未生效,新会话里设的目标刷新即丢;
//   ④ busy 是 hook ref(全局一份),而视图流只投激活会话 → 在 A 跑着时切到 B,A 的 agentSettled
//      到不了 renderer,busy 永远停在 true,B 的 armIfIdle 首句就被它否掉 → B 静默停摆。
// 现在五个状态都是**会话作用域槽**(renderer/index.tsx 的 sessionSlots 声明):
//   goal / sendError 用 move(物化时跟着走),busy / inflight / deferred 用 drop(执行瞬态,
//   物化后由内核事件重新建立)。切会话即自动换档,四个断点的前提(全局单例 + 事后补换档)不存在了。
//
// 持久化分工不变(设计 §3.2.3):头行 custom.goal 是跨重启的持久化真相源,作用域槽是运行期真相源。
// 壳期会话未落盘、头行写不进去,物化那一刻框架 carry 搬迁内存槽并调 onCarry,goal 在 onCarry 里
// 把 custom.goal 补写进真身头行(persistGoalOnCarry,经模块桥因为静态声明拿不到 PluginContext)。
//
// 用户命令:人敲的 /goal 与模型调的 set_goal 互补。命令经壳机制 composerCommands
// (packages/react/composer-commands)在发送前拦到这里;handleCommand 是唯一实现,
// 经模块级桥(runGoalCommand)暴露给 renderer 入口的静态导出(plugins-host 收集)。
//
// 所见即所得(用户要求 #5):/goal <目标> 不再吞掉文本——命令返回 { send: 目标正文 },
// 目标作为真实用户消息发出;续跑轮次的 <goal_round> 包装经本插件的 auxParser 渲染成
// 「目标续跑卡」,不冒充用户气泡。
//
// 即时装弹(arming):恢复/恢复持久化目标时若空闲(无回合在飞),立即发一轮续跑提示——
// 否则没有任何东西会触发 agentSettled,active 目标会静默停摆;忙时交给在飞回合的 agentSettled。
// (/goal set 不装弹:目标正文消息本身就是 kickoff 回合,它的 agentSettled 自然接第一轮。)
import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  usePluginContext, useUiStore, useSessionStore,
  useSessionScope, useSessionScopeAccess, useCurrentScopeKey,
  hasPendingUserSend, announceTransient,
} from "@my-harness-desktop/react";
import { scopeKeyFromSessionKey, isShellScopeKey, type ComposerCommandResult, type NeutralMessage, type SessionInfo } from "@my-harness-desktop/shared";
import type { GoalState } from "../core/goal-state";
import { createGoal, editGoal, GOAL_NOTE_ROLE, parseGoal, parseGoalCommand, pauseGoal, resumeGoal, setGoalMaxRounds, shouldContinue } from "../core/goal-state";
import { applyGoalEvent, renderContinuationPrompt } from "./goal-reduce";

// ⚠ 此前这里是模块级常量 `GOAL_USAGE`，把 /goal 的用法说明**写死成中文**（r54 修）。
//   模块级常量拿不到 hook，所以改为在使用点 `t("goal.usage")`（本文件只在两处用它，
//   且都在 useGoalController 内部）。四个语言各一份译文，见 locales/<loc>/goal.json。

/** 续跑发送的有界重试(设计 goal.md §6.4):首发 + 2 次退避重试,耗尽转 paused 显形。 */
const MAX_SEND_ATTEMPTS = 3;
const SEND_RETRY_DELAYS_MS = [1000, 2000];

/** 通用配置(goal.maxRounds,settingsGroups 槽落 general.json)提供的默认轮数上限。
 *  只在创建目标时读取(配置管默认、状态管存量);非正整数回退代码兜底。
 *  只读框架 store(§8.2 允许),非渲染闭包——创建动作发生时读最新值。 */
function configuredMaxRounds(): number | undefined {
  const v = useUiStore.getState().generalConfig["goal.maxRounds"];
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 1 ? v : undefined;
}

/** 模块级桥:composerCommands.handle 与 sessionSlots.onCarry 都是 plugins-host 收集的**静态**
 *  函数/声明,拿不到 PluginContext;控制器活在 React hook 里。挂载时把能力挂到桥上,卸载时摘。
 *  activeCommandHandler 是全局一份(斜杠命令只服务当前输入框,设计 §4.5.2 白名单)。 */
let activeCommandHandler: ((input: string) => Promise<ComposerCommandResult>) | null = null;
let activeCarryPersister: ((goal: GoalState | null, toKey: string) => void) | null = null;

/** 供 renderer 入口的 composerCommands 导出调用:转发给当前挂载的控制器。 */
export function runGoalCommand(input: string): Promise<ComposerCommandResult> {
  const fn = activeCommandHandler;
  return fn ? fn(input) : Promise.resolve(false);
}

/** 供 renderer 入口的 sessionSlots 声明的 onCarry 调用:物化后补写真身头行(设计 §3.2.3)。 */
export function persistGoalOnCarry(goal: GoalState | null, toKey: string): void {
  activeCarryPersister?.(goal, toKey);
}

/** ns → 投影路径的确定性解析(onCarry 的 toKey 是 ns,而 updateHeader 要真实文件路径:
 *  pi catalog 的 piUpdateSessionHeader 有 existsSync 校验,裸 ns 会抛「会话文件不存在」)。
 *  sessionInfos 是 path 与 ns 双键索引(loadSessionInfos 建表时两个键都写),所以可反查。
 *  解析不到(列表尚未加载/会话已删)返回 null,调用方跳过补写——下次状态变更会再写一遍。 */
function projectedPathOf(ns: string): string | null {
  const infos = useSessionStore.getState().sessionInfos;
  if (!infos) return null;
  const byNs = infos[ns];
  if (byNs?.path) return byNs.path;
  // 双键索引缺失时兜底扫一遍(表很小,且只在物化那一刻发生一次)
  for (const info of Object.values(infos) as SessionInfo[]) {
    if (info.neutralSessionId === ns) return info.path;
  }
  return null;
}

/** 是否有排队中的用户发送(timeline 流式期入队的待发消息)。只读框架作用域槽(§8.2 允许)。
 *  goal 续跑对用户输入让路=「用户插队」:有待发用户消息时,续跑不抢发,等用户消息
 *  的回合收敛后再续(用户要求 #5)。失败重挂篮的条目同样压住续跑——用户需先处置。
 *
 *  只看**当前会话**的队列(设计 §2.4.5):此前实现扫全部会话的队列,于是 B 会话里排队的
 *  消息会压住 A 会话的续跑——跨会话泄漏,与「按会话隔离」的语义相反。 */
function userSendPending(): boolean {
  return hasPendingUserSend();
}

/** 异常收敛检测(设计 goal.md §5.2):回合收敛时看最后一条 assistant 消息的终结标记。
 *  error=生成/工具失败、stopped=用户中断;两者都视为「异常收敛」——goal 不续跑、转 paused。
 *  时序依据:messageEnd 先于 agentSettled 派发,终结标记在收敛事件前已落 store。
 *  只读框架 store(§8.2 允许);视图流只含激活会话,所以这里读到的就是当前会话的消息。 */
function lastAssistantTerminal(): "error" | "stopped" | null {
  const messages = useSessionStore.getState().messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as NeutralMessage & { error?: boolean; stopped?: boolean };
    if (m.role !== "assistant") continue;
    if (m.error === true) return "error";
    if (m.stopped === true) return "stopped";
    return null; // 最近一条 assistant 是正常终结
  }
  return null;
}

/** goal 续跑 hook:返回当前目标 + 发送失败态 + 用户控制操作(停止/恢复/编辑/关闭)。 */
export function useGoalController() {
  const { t } = useTranslation();
  const { sessions, messaging, notify, events } = usePluginContext();
  const sessionPath = useUiStore((s) => s.currentSessionPath);
  // 中立 ns:openSession 的入参是中立会话 id,不是投影 sessionPath(投影路径经 neutralStore.get(ns)
  // 查不到——此前 goal 重启/切会话不水合的根因,commit f20248c1 修过一次,现在身份算法单源在圆心)。
  const neutralSessionId = useUiStore((s) => s.currentNeutralSessionId);
  const scopeKey = useCurrentScopeKey();

  // ── 五个会话作用域槽(设计 §3.2.1)───────────────────────────────────────
  // goal/sendError 走渲染读口(要驱动 GoalBar 重渲染);busy/inflight/deferred 走 access
  // 闭包(只在事件回调与异步收口里读写,不参与渲染,存成 ref 形态避免闭包旧值)。
  const [goal, setGoalSlot] = useSessionScope<GoalState | null>("goal");
  const [sendError, setSendErrorSlot] = useSessionScope<string | null>("sendError");
  const goalAccess = useSessionScopeAccess<GoalState | null>("goal");
  const busyAccess = useSessionScopeAccess<boolean>("busy");
  const inflightAccess = useSessionScopeAccess<boolean>("inflight");
  const deferredAccess = useSessionScopeAccess<boolean>("deferred");

  /** 单一状态写入口:写作用域槽(当前会话)+ 持久化到会话头行 custom.goal(clear 时 goal=null 删键)。
   *  壳期(currentSessionPath 为 null)写不了头行属预期——物化那一刻由 onCarry 补写。
   *
   *  goal:state 广播**不在这里发**,而在下面的 effect 里按「当前会话的 goal 值变化」发。这是根因修复:
   *  此前广播只在写入口 emit,但**切会话换档是读不是写**(useSessionScope 读到新会话那份),
   *  于是 timeline 缓存的绿晕态滞留——甲会话亮着的绿晕切到乙会话不熄灭(真机 e2e 抓到)。
   *  改成监听 goal 值本身:换档/写入/水合三条路径都会让 goal 引用变化,effect 统一补发,
   *  「值变了就广播」而不是「写了才广播」——语义上也更贴消费方(着色只关心当前值)。 */
  const setGoal = useCallback((next: GoalState | null) => {
    setGoalSlot(next);
    if (sessionPath) {
      void sessions.updateHeader(sessionPath, { custom: { goal: next } }).catch(() => {
        // 持久化失败不阻断续跑(内存槽照常),下次变更再写。
      });
    }
  }, [sessions, sessionPath, setGoalSlot]);

  // goal:state 广播(设计 §2.5 scoped channel:坐标由框架注入,这里只发业务数据)。
  // 监听当前会话的 goal 值:切会话换档使 goal 变(读到新会话那份)→ 重发→消费方绿晕随之亮灭;
  // 写入/水合同理。goal 引用是唯一依赖,换档与写入都被它捕获,不漏发也不重发。
  useEffect(() => {
    events.emit("goal:state", { goal: goal ?? null });
  }, [goal, events]);

  const setSendError = useCallback((msg: string | null) => {
    setSendErrorSlot(msg);
  }, [setSendErrorSlot]);

  /** 控制动作留痕(设计 goal.md §8.3):中立层会话注解,不写内核、不进模型上下文。
   *  内容是机读 JSON({action, detail?}),卡片渲染时按当前语言翻译——存储与语言解耦。
   *  壳期会话没有中立层可写,静默跳过。 */
  const markNote = useCallback((note: { action: string; detail?: string }) => {
    if (!sessionPath) return;
    void sessions.annotate(sessionPath, GOAL_NOTE_ROLE, JSON.stringify(note)).catch(() => {});
  }, [sessions, sessionPath]);

  /** 发一轮续跑提示:经 messaging.prompt 把续跑文案作为一条普通消息发出(续跑=发消息,
   *  设计 goal.md §3.2——契约无独立 continue 意图;忙态由内核发消息面吸收)。
   *
   *  失败显形 + 有界重驱动(goal.md §6.4):发送失败做有界退避重试;耗尽后转入 paused + 显形
   *  (notify + GoalBar 失败态)——发送失败意味着没起新回合,「下次 agentSettled 自然再续」
   *  是不成立的假设(那个事件不会来),绝不允许目标条亮着 active 实际停摆。
   *
   *  在飞收口时补发欠账(根因修复,勿回退):回合收敛撞上在飞续跑时,此前实现「推进了 round
   *  却丢了 prompt」——轮数空转、目标停摆(「让跑三轮只发两轮」的根因)。现在欠账挂起
   *  (deferred 槽),inflight 落定那一刻按**当时最新状态**重算补发(已暂停/已达成就丢弃)——
   *  轮数推进与发送永远成对。读最新状态经 goalAccess.get()(直接读 store,不经闭包旧值)。 */
  const firePrompt = useCallback((prompt: string): void => {
    inflightAccess.set(true);
    void (async () => {
      try {
        for (let attempt = 0; attempt < MAX_SEND_ATTEMPTS; attempt++) {
          if (attempt > 0) {
            await new Promise((r) => setTimeout(r, SEND_RETRY_DELAYS_MS[attempt - 1]));
            // 重试前按最新状态确认仍应发:暂停/清除/到顶/用户插队都让重试失效。
            // (首发不查:调用方已按当时状态判定,且 armIfIdle 是先发后写,首发读旧态会把自己否掉。)
            const g = goalAccess.get();
            if (!g || !shouldContinue(g) || userSendPending()) return;
          }
          try {
            await messaging.prompt(prompt);
            setSendError(null); // 成功清失败态
            return;
          } catch (err) {
            if (attempt === MAX_SEND_ATTEMPTS - 1) {
              const msg = err instanceof Error ? err.message : String(err);
              // 有界重试耗尽 → 转 paused + 显形,把处置权交还给人(resume 即重新驱动)
              const cur = goalAccess.get();
              if (cur && cur.phase === "active") setGoal(pauseGoal(cur));
              setSendError(msg);
              void notify.show({ title: "Goal", body: t("goal.continueSendFailed", { msg }) });
              markNote({ action: "send_failed", detail: msg });
              return;
            }
          }
        }
      } finally {
        inflightAccess.set(false);
        // finally 里不写 return(no-unsafe-finally:会吞掉在飞异常)——改条件嵌套,语义等价。
        if (deferredAccess.get()) {
          deferredAccess.set(false);
          const g = goalAccess.get();
          // 补发按当时最新状态重算(编辑/暂停/排队让路都生效),不欠旧账、不抢用户输入。
          if (g && shouldContinue(g) && !userSendPending()) {
            const round = g.round + 1;
            setGoal({ ...g, round });
            firePrompt(renderContinuationPrompt(g.objective, round, g.maxRounds));
          }
        }
      }
    })();
  }, [messaging, notify, markNote, setGoal, setSendError, goalAccess, inflightAccess, deferredAccess]);

  const sendRound = useCallback((g: GoalState, round: number) => {
    firePrompt(renderContinuationPrompt(g.objective, round, g.maxRounds));
  }, [firePrompt]);

  /** 空闲且应续跑 → 立即装下一轮并返回推进后的状态;忙/在飞/有排队用户输入/不该续 → 原样返回。
   *  busy 读**当前会话**的作用域槽:此前是 hook ref(全局一份),A 跑着时切到 B,A 的 agentSettled
   *  到不了 renderer → busy 永远停在 true → B 的 armIfIdle 首句被否掉、静默停摆(设计 §3.2.2 断点④)。
   *  用户输入插队(#5):排队中有用户待发消息时即时装弹让路,由其回合收敛后的 agentSettled 接续。 */
  const armIfIdle = useCallback((g: GoalState): GoalState => {
    if (busyAccess.get() || inflightAccess.get() || userSendPending() || !shouldContinue(g)) return g;
    const round = g.round + 1;
    const next = { ...g, round };
    sendRound(next, round);
    return next;
  }, [sendRound, busyAccess, inflightAccess]);

  // 桥接:把当前控制器的能力挂到模块级入口(静态导出侧)。卸载时只清自己,不误伤后续挂载者。
  const handleCommandRef = useRef<(input: string) => Promise<ComposerCommandResult>>(null as never);
  useEffect(() => {
    const fn = (input: string): Promise<ComposerCommandResult> => handleCommandRef.current(input);
    activeCommandHandler = fn;
    return () => { if (activeCommandHandler === fn) activeCommandHandler = null; };
  }, []);
  // onCarry 桥:物化后把内存槽里的目标补写进真身头行(设计 §3.2.3)。
  // toKey 是 ns(由框架 carry 作为参数传入,**不是**回调时读当前 scopeKey——microtask 落地前
  // 用户可能已切走,读渲染态会把 A 的目标写进 B 的头行,设计 §2.2.5)。
  useEffect(() => {
    activeCarryPersister = (g, toKey) => {
      const path = projectedPathOf(toKey);
      if (!path) return;   // 列表尚未加载:跳过,下次状态变更会再写一遍
      void sessions.updateHeader(path, { custom: { goal: g } }).catch(() => {});
    };
    return () => { activeCarryPersister = null; };
  }, [sessions]);

  // 读:挂载/切会话时从会话头行 custom.goal 恢复目标(窗口刷新不再丢)。
  // 恢复出的 active 目标立即装弹——「active=续跑中」不因窗口刷新停摆。
  //
  // 换档由作用域容器承担(scopeKey 一变,useSessionScope 自动读新会话那份),本 effect 只做
  // 「内存槽为空时从头行水合」这一件事:作用域槽是运行期真相源,头行是持久化真相源,
  // 冷启动/刷新后内存全空,靠这里从头行重建(设计 §3.2.3 阶段4)。
  // 不再需要:物化补写分支(carry+onCarry 承担)、foreign 判据(每会话各一份,没有「别人的目标」)、
  // alive 竞态守卫(水合结果写进**发起时**的 scopeKey,切走了就写进旧域,不串)。
  const hydratedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!scopeKey || hydratedKeyRef.current === scopeKey) return;
    hydratedKeyRef.current = scopeKey;
    // 已有内存态(本会话刚设的目标/切回来)就不水合——内存槽是运行期真相源,比头行新。
    if (goalAccess.get() != null) return;
    const openKey = neutralSessionId ?? sessionPath;
    if (!openKey) return;   // 壳期且无投影路径:没有中立层可读,等物化后 onCarry 补写
    void sessions.openSession(openKey)
      .then((detail) => {
        // 水合期间用户又切走了:写进**发起时**的 scopeKey(不是当前),避免串会话。
        if (hydratedKeyRef.current !== scopeKey) {
          const restored = parseGoal((detail as { info?: { custom?: Record<string, unknown> } } | null)?.info?.custom?.goal);
          if (restored) goalAccess.setAt(scopeKey, restored);
          return;
        }
        const custom = (detail as { info?: { custom?: Record<string, unknown> } } | null)?.info?.custom;
        const restored = parseGoal(custom?.goal);
        if (!restored) return;   // 头行没有目标:保持 null(不伪造、不清别人的)
        setGoal(restored.phase === "active" ? armIfIdle(restored) : restored);
      })
      .catch(() => { /* 会话未就绪/读失败:保持无目标,下次切换再读 */ });
  }, [scopeKey, neutralSessionId, sessionPath, sessions, goalAccess, setGoal, armIfIdle]);

  // 续跑事件订阅(视图流:只含激活会话):toolCallStart 捕获 set_goal/achieve_goal,
  // agentSettled 判定续跑。busy 的维护改到运维流(下面那个 effect),因为视图流收不到
  // 后台会话的 agentStart/agentSettled,而 busy 必须按会话各存一份(设计 §2.3.3/§2.4.5)。
  useEffect(() => {
    return sessions.onEvent((event) => {
      // 用户输入插队(#5):回合收敛时若有排队的用户待发消息,本次收敛不续跑也不进轮次——
      // 让 timeline 先把用户消息发出去,等用户消息的回合收敛(队列已清)再续。
      if (event.type === "agentSettled" && userSendPending()) return;
      // 异常收敛不续跑(设计 goal.md §5.2):模型报错/人为中断的回合收敛 → 转 paused,不拿轮次硬烧。
      if (event.type === "agentSettled" && goalAccess.get()?.phase === "active") {
        const terminal = lastAssistantTerminal();
        if (terminal !== null) {
          const cur = goalAccess.get();
          if (cur) setGoal(pauseGoal(cur));
          if (terminal === "error") {
            const msg = t("goal.roundAborted");
            setSendError(msg);
            void notify.show({ title: "Goal", body: msg });
            markNote({ action: "auto_pause_error" });
          } else {
            markNote({ action: "auto_pause_interrupt" });
          }
          return;
        }
      }
      const cur = goalAccess.get() ?? null;
      const { goal: next, prompt } = applyGoalEvent(cur, event, { defaultMaxRounds: configuredMaxRounds() });
      if (prompt !== undefined) {
        // 续跑发送撞上在飞:不丢轮次也不推进空轮——欠账挂起,由 firePrompt 的 inflight
        // 收口按当时最新状态补发(根因修复:旧实现推进 round 却丢 prompt,轮数空转)。
        if (inflightAccess.get()) {
          deferredAccess.set(true);
          return;
        }
        setGoal(next); // 推进与发送成对发生
        firePrompt(prompt);
        return;
      }
      if (next !== cur) setGoal(next);
    });
    // deps 必须含 markNote/notify:markNote 闭包随 sessionPath 重建,缺依赖=切会话后
    // 旧订阅仍往旧会话写留痕(闭包旧值)。messaging 不被本 effect 使用,移出。
  }, [sessions, setGoal, setSendError, firePrompt, markNote, notify, goalAccess, inflightAccess, deferredAccess]);

  // busy 维护 + 后台归账(运维流:带 sessionKey,激活会话全量、后台会话按白名单)。
  // agentStart/agentSettled 都在白名单里(session-store.ts:3026-3039),所以后台会话的
  // 回合边界也到得了 renderer——busy 按事件身份写**目标域**,不写当前激活域,于是
  // 「切回后台会话读到真实 busy」成立(设计 §2.3.3),不再依赖「切走前那一刻的值」。
  useEffect(() => {
    const lookup = (k: string): string | undefined =>
      (useSessionStore.getState().sessionInfos?.[k] as SessionInfo | undefined)?.neutralSessionId;
    return sessions.onKernelEvent((ke) => {
      if (ke.kind !== "session") return;
      const rawKey = ke.sessionKey;
      if (!rawKey) return;
      // 运维键(总线工人/测试)没有中立层归属,不参与作用域。
      if (rawKey.startsWith("bus:") || rawKey.startsWith("test:")) return;
      const ev = ke.event;
      // proc.key → 作用域 key 的归一走圆心函数(设计 §2.2.2):此前拿 proc.key 直接比投影路径,
      // fork 过的会话(rekeyProc 后 key≠path)会被误判成后台会话 → 视图流与后台各归一次账、round 双跳。
      const evScopeKey = scopeKeyFromSessionKey(rawKey, lookup);
      if (isShellScopeKey(evScopeKey)) return;   // 未物化壳:没有中立层可写(壳键判别走圆心单源)

      // busy:按事件身份写目标域(激活与后台同一处理,因为运维流两边都投)。
      if (ev.type === "agentStart") { busyAccess.setAt(evScopeKey, true); return; }
      if (ev.type === "agentSettled") { busyAccess.setAt(evScopeKey, false); }

      // 后台归账(设计 goal.md §9.1):激活会话走视图流那条路(上面那个 effect),这里只处理后台。
      if (evScopeKey === scopeKey) return;
      if (ev.type !== "toolCallStart") return;
      const toolName = (ev as { toolName?: unknown }).toolName;
      if (toolName !== "set_goal" && toolName !== "achieve_goal") return;
      void (async () => {
        const detail = await sessions.openSession(rawKey).catch(() => null);
        const custom = (detail as { info?: { custom?: Record<string, unknown> } } | null)?.info?.custom;
        // 内存槽优先于头行:后台会话可能已有内存态(切走前设的目标),头行是它的持久化快照。
        const cur = goalAccess.getAt(evScopeKey) ?? parseGoal(custom?.goal);
        const { goal: next } = applyGoalEvent(cur ?? null, ev, { defaultMaxRounds: configuredMaxRounds() });
        if (next === cur) return;
        goalAccess.setAt(evScopeKey, next);   // 写内存槽(切回去即见真实态,含 busy)
        await sessions.updateHeader(rawKey, { custom: { goal: next } }).catch(() => {});  // 写头行(持久化真相源)
      })();
    });
  }, [sessions, scopeKey, busyAccess, goalAccess]);

  const pause = useCallback(() => {
    const g = goalAccess.get();
    if (!g || g.phase !== "active") return;
    setGoal(pauseGoal(g));
    markNote({ action: "pause" });
  }, [setGoal, markNote, goalAccess]);
  // 恢复即「继续干活」:空闲时立即装下一轮,不等下一次回合收敛(否则 active 但无人触发,停摆)。
  // 恢复同时清失败态(上次失败已被处置)。
  const resume = useCallback(() => {
    const g = goalAccess.get();
    if (!g || g.phase !== "paused") return;
    setSendError(null);
    setGoal(armIfIdle(resumeGoal(g)));
    markNote({ action: "resume" });
  }, [setGoal, setSendError, armIfIdle, markNote, goalAccess]);
  const edit = useCallback((objective: string) => {
    const g = goalAccess.get();
    if (!g || g.phase === "achieved") return;
    try {
      setGoal(editGoal(g, objective));
      markNote({ action: "edit", detail: objective });
    } catch { /* 空 objective 忽略 */ }
  }, [setGoal, markNote, goalAccess]);
  const limit = useCallback((maxRounds: number) => {
    const g = goalAccess.get();
    if (!g) return;
    try {
      // 到顶停摆(active 但 round 到顶)且空闲时 armIfIdle 立即装弹续跑(goal.md §5.3)。
      setGoal(armIfIdle(setGoalMaxRounds(g, maxRounds)));
      markNote({ action: "limit", detail: String(maxRounds) });
    } catch { /* 非正整数忽略 */ }
  }, [setGoal, armIfIdle, markNote, goalAccess]);
  const clear = useCallback(() => {
    if (!goalAccess.get()) return;
    setSendError(null);
    setGoal(null);
    markNote({ action: "clear" });
  }, [setGoal, setSendError, markNote, goalAccess]);

  /** 用户 /goal 命令的唯一实现:解析 → 套状态机 → 通知反馈。
   *  返回值语义(ComposerCommandResult):
   *  - set:创建目标(round=0 不装弹)并返回 { send: 目标正文 }——目标正文作为真实用户
   *    消息由 timeline 正常发送(所见即所得:输入框敲什么,会话里就是什么)。kickoff
   *    回合的 agentSettled 自然接第一轮续跑,不再由插件伪造一条包装过的"用户消息"。
   *  - stop/resume/edit/limit/clear/status:纯命令,吞掉发送(true)。
   *  与模型工具同状态机同持久化:人敲 /goal 和模型调 set_goal 落到同一个 GoalState。 */
  const handleCommand = useCallback(async (input: string): Promise<ComposerCommandResult> => {
    const cmd = parseGoalCommand(input);
    if (!cmd) return false;
    const g = goalAccess.get();
    const notifyNoGoal = (): void => {
      // ⚠ r192：加**应用内**播报作主通道（与 r191 的 openRawFile 同族缺陷）。
      //   此前唯一反馈是系统通知，而 notification.ts 的头注写明
      //   "remote 连接 host 为缺省降级(no-op/不支持)"、node-host 的 notify 就是 no-op
      //   （**resolve 而不是 reject** ⇒ 加 .catch 无用）。于是远程/纯 Node 宿主下，
      //   用户输入 /goal pause 而当前无目标时**什么都收不到**（§7.6 禁止的静默）。
      //   斜杠命令的返回值契约是 `boolean | { send: string }`（composer-commands.ts:15），
      //   **没有承载提示文案的字段** ⇒ 不改契约，直接用命令式播报原语（r83）。
      announceTransient(t("goal.noGoal"), "info");
      void notify.show({ title: "Goal", body: t("goal.noGoal"), silent: true });
    };
    switch (cmd.kind) {
      case "set": {
        try {
          // 只建状态,不装弹:首轮就是返回 { send } 发出去的那条目标正文,
          // 它的回合收敛(agentSettled)自然接第一轮续跑。
          // 上限:命令不带 max_rounds → 取通用配置(只在创建时读取,见 configuredMaxRounds)。
          setSendError(null);
          setGoal(createGoal({ ...cmd.request, maxRounds: configuredMaxRounds() }));
        } catch {
          void notify.show({ title: "Goal", body: t("goal.usage"), silent: true });
          return true;
        }
        return { send: cmd.request.objective };
      }
      case "pause":
        if (g) pause(); else notifyNoGoal();
        return true;
      case "resume":
        if (g) resume(); else notifyNoGoal();
        return true;
      case "edit":
        if (!g) { notifyNoGoal(); return true; }
        if (g.phase === "achieved") {
          void notify.show({ title: "Goal", body: t("goal.achievedNotEditable"), silent: true });
          return true;
        }
        edit(cmd.objective);
        return true;
      case "limit":
        if (!g) { notifyNoGoal(); return true; }
        limit(cmd.maxRounds);
        return true;
      case "clear":
        clear();
        return true;
      case "status":
        void notify.show({
          title: "Goal",
          body: g ? `[${g.phase}] ${g.round}/${g.maxRounds} · ${g.objective}` : t("goal.usage"),
          silent: true,
        });
        return true;
    }
  }, [notify, setGoal, setSendError, pause, resume, edit, limit, clear, goalAccess]);
  handleCommandRef.current = handleCommand;

  return { goal: goal ?? null, sendError: sendError ?? null, pause, resume, edit, clear };
}
