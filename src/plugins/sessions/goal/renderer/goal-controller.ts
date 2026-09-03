// goal 续跑引擎 —— 纯壳插件内的 hook,不动 core/application、不动契约/IPC。
//
// 薄壳架构(CLAUDE.md §1.2 机制与内容分离):「回合结束后再发一份续跑提示继续」是**功能(内容)**,
// 不是壳机制。壳只提供机制面——onEvent(订阅中性事件)、continue(继续执行第八意图:注入续跑文案、
// 不落 user 消息、不在会话框展示)、updateHeader/openSession(会话头行 custom 域读写)、
// notify(命令反馈),续跑逻辑就用这些机制拼,活在这个插件里。
//
// 持久化:goal 状态随变更写会话头行 custom.goal(插件域,域 key 归属制),挂载/切会话时读回——
// 窗口刷新不再丢目标。归约逻辑在 goal-reduce.ts(纯函数),本 hook 只做订阅 + 续跑副作用 + 持久化。
//
// 用户命令:人敲的 /goal 与模型调的 set_goal 互补。命令经壳机制 composerCommands
// (packages/react/composer-commands)在发送前拦到这里;handleCommand 是唯一实现,
// 经模块级桥(runGoalCommand)暴露给 renderer 入口的静态导出(plugins-host 收集)。
//
// 所见即所得(用户要求 #5):/goal <目标> 不再吞掉文本——命令返回 { send: 目标正文 },
// 目标作为真实用户消息发出(输入框敲什么,会话里就是什么);续跑轮次的 <goal_round>
// 包装经本插件的 auxParser 渲染成「目标续跑卡」(另一种展示方式),不再冒充用户气泡。
//
// 即时装弹(arming):恢复/恢复持久化目标时若空闲(无回合在飞),立即发一轮续跑提示——
// 否则没有任何东西会触发 agentSettled,active 目标会静默停摆;忙时交给在飞回合的 agentSettled。
// (/goal set 不装弹:目标正文消息本身就是 kickoff 回合,它的 agentSettled 自然接第一轮。)
import { useCallback, useEffect, useRef, useState } from "react";
import { usePluginContext, useUiStore, useSessionStore } from "@my-harness-desktop/react";
import type { ComposerCommandResult, NeutralMessage } from "@my-harness-desktop/shared";
import type { GoalState } from "../core/goal-state";
import { createGoal, editGoal, GOAL_NOTE_ROLE, parseGoal, parseGoalCommand, pauseGoal, resumeGoal, setGoalMaxRounds, shouldContinue } from "../core/goal-state";
import { applyGoalEvent, renderContinuationPrompt } from "./goal-reduce";

export const GOAL_USAGE =
  "/goal <目标> 设置目标并开始续跑\n"
  + "/goal stop 暂停 · /goal resume 恢复 · /goal edit <新目标> 改 · /goal limit <n> 改上限 · /goal clear 删除 · /goal 查看状态";

/** 续跑发送的有界重试(§6.4):首发 + 2 次退避重试,耗尽转 paused 显形。 */
const MAX_SEND_ATTEMPTS = 3;
const SEND_RETRY_DELAYS_MS = [1000, 2000];

/** 通用配置(goal.maxRounds,settingsGroups 槽落 general.json)提供的默认轮数上限。
 *  只在创建目标时读取(配置管默认、状态管存量,设计 §5.3/§11);非正整数回退代码兜底。
 *  只读框架 store(§8.2 允许),非渲染闭包——创建动作发生时读最新值。 */
function configuredMaxRounds(): number | undefined {
  const v = useUiStore.getState().generalConfig["goal.maxRounds"];
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 1 ? v : undefined;
}

/** 模块级桥:composerCommands.handle 是 plugins-host 收集的静态函数,控制器活在 React hook 里。
 *  GoalBar(composerStats 槽)与 composer 同时挂载,命令到来时控制器必在;无控制器(插件被禁)→ 放行。 */
let activeCommandHandler: ((input: string) => Promise<ComposerCommandResult>) | null = null;

/** 模块级当前目标(可见会话单例):GoalBar 在会话物化瞬间会重挂载,组件内 useState 被清,
 *  实测「设 goal 后 1s 内目标条消失、续跑停摆」。目标态上移到模块级,重挂载后读回;
 *  窗口刷新仍走会话头行持久化(下读 effect)。goalBirthPath 记目标诞生时的 sessionPath,
 *  用于区分「物化(同会话 new:→真身)」与「真切换(换了会话)」:前者保留内存态+补写真身,
 *  后者按新会话头行换档。 */
let currentGoal: GoalState | null = null;
let goalBirthPath: string | null = null;
/** 最近一次续跑发送的失败原因(引擎态,不落 GoalState——状态机纯数据不含瞬态)。
 *  与目标态同级模块级(抗重挂载);成功发送/恢复/清除时清掉。 */
let lastSendError: string | null = null;
const goalListeners = new Set<() => void>();
function notifyGoalListeners(): void {
  for (const l of goalListeners) l();
}
function setCurrentGoal(next: GoalState | null, birthPath?: string | null): void {
  currentGoal = next;
  if (birthPath !== undefined) goalBirthPath = birthPath;
  notifyGoalListeners();
}
function setLastSendError(msg: string | null): void {
  if (lastSendError === msg) return;
  lastSendError = msg;
  notifyGoalListeners();
}
/** 测试专用:清空模块级目标态(测试间隔离)。 */
export function __resetGoalStoreForTests(): void {
  currentGoal = null;
  goalBirthPath = null;
  lastSendError = null;
  notifyGoalListeners();
}

/** 是否有排队中的用户发送(timeline 流式期入队的待发消息)。只读框架 store(§8.2 允许)。
 *  goal 续跑对用户输入让路=「用户插队」:有待发用户消息时,续跑不抢发,等用户消息
 *  的回合收敛后再续(用户要求 #5)。失败重挂篮的条目同样压住续跑——用户需先处置。 */
function userSendPending(): boolean {
  const queues = useUiStore.getState().pendingQueue;
  return Object.values(queues).some((list) => list.length > 0);
}

/** 异常收敛检测(设计 §5.2):回合收敛时看最后一条 assistant 消息的终结标记。
 *  error=生成/工具失败、stopped=用户中断;两者都视为「异常收敛」——goal 不续跑、转 paused。
 *  时序依据:messageEnd 先于 agentSettled 派发,终结标记在收敛事件前已落 store。
 *  只读框架 store(§8.2 允许)。 */
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

/** 供 renderer 入口的 composerCommands 导出调用:转发给当前挂载的控制器。 */
export function runGoalCommand(input: string): Promise<ComposerCommandResult> {
  const fn = activeCommandHandler;
  return fn ? fn(input) : Promise.resolve(false);
}

/** goal 续跑 hook:返回当前目标 + 发送失败态 + 用户控制操作(停止/恢复/编辑/关闭)。 */
export function useGoalController() {
  const { sessions, messaging, notify, events } = usePluginContext();
  const sessionPath = useUiStore((s) => s.currentSessionPath);
  // 初始化读模块级单例(重挂载存活),而不是固定 null。
  const [goal, setGoalState] = useState<GoalState | null>(currentGoal);
  const [sendError, setSendErrorState] = useState<string | null>(lastSendError);
  const goalRef = useRef<GoalState | null>(currentGoal);
  const inflightRef = useRef(false);
  /** 回合在飞:agentStart 置真 / agentSettled 置假。决定设置/恢复/恢复持久化时是否立即发首轮续跑。 */
  const busyRef = useRef(false);

  /** 单一状态写入口:更新模块级单例(抗重挂载)+ 广播 goal:state(全量快照,消费方着色用)
   *  + 持久化到会话头行 custom.goal(clear 时 goal=null 删键)。广播在写入口收口,任何路径变更不漏发。
   *  持久化对「new:」前缀的未物化路径静默失败属预期——物化瞬间由恢复 effect 补写(见下)。 */
  const setGoal = useCallback((next: GoalState | null) => {
    goalRef.current = next;
    setGoalState(next);
    setCurrentGoal(next, sessionPath);
    events.emit("goal:state", { goal: next });
    if (sessionPath && !sessionPath.startsWith("new:")) {
      void sessions.updateHeader(sessionPath, { custom: { goal: next } }).catch(() => {
        // 持久化失败不阻断续跑(内存态照常),下次变更再写。
      });
    }
  }, [events, sessions, sessionPath]);

  /** 最新 setGoal 的 ref:firePrompt 的 inflight 收口(异步)按当时最新状态补发,
   *  不经闭包捕获旧值(与 handleCommandRef 同一手法)。 */
  const setGoalRef = useRef(setGoal);
  setGoalRef.current = setGoal;

  /** 控制动作留痕(设计 §8.3):中立层会话注解,不写内核、不进模型上下文。
   *  内容是机读 JSON({action, detail?}),卡片渲染时按当前语言翻译——存储与语言解耦。
   *  未物化(new:)会话没有中立层可写,静默跳过。 */
  const markNote = useCallback((note: { action: string; detail?: string }) => {
    const p = sessionPath;
    if (!p || p.startsWith("new:")) return;
    void sessions.annotate(p, GOAL_NOTE_ROLE, JSON.stringify(note)).catch(() => {});
  }, [sessions, sessionPath]);

  /** 发一轮续跑提示:经 messaging.prompt 把续跑文案作为一条普通消息发出（续跑=发消息,
   *  设计 docs/design/goal.md §3.2——契约无独立 continue 意图;忙态由内核发消息面吸收）。
   *
   *  失败显形 + 有界重驱动(§6.4):发送失败做有界退避重试;耗尽后转入 paused + 显形
   *  (notify + GoalBar 失败态)——发送失败意味着没起新回合,「下次 agentSettled 自然再续」
   *  是不成立的假设(那个事件不会来),绝不允许目标条亮着 active 实际停摆。
   *
   *  在飞收口时补发欠账(根因修复,勿回退):回合收敛撞上在飞续跑时,此前实现「推进了 round
   *  却丢了 prompt」——轮数空转、目标停摆(「让跑三轮只发两轮」的根因)。现在欠账挂起
   *  (deferredRef),inflight 落定那一刻按**当时最新状态**重算补发(已暂停/已达成就丢弃)——
   *  轮数推进与发送永远成对。 */
  const deferredRef = useRef(false);
  const firePrompt = useCallback((prompt: string): void => {
    inflightRef.current = true;
    void (async () => {
      try {
        for (let attempt = 0; attempt < MAX_SEND_ATTEMPTS; attempt++) {
          if (attempt > 0) {
            await new Promise((r) => setTimeout(r, SEND_RETRY_DELAYS_MS[attempt - 1]));
            // 重试前按最新状态确认仍应发:暂停/清除/到顶/用户插队都让重试失效。
            // (首发不查:调用方已按当时状态判定,且 goalRef 可能还没轮到 setGoal 落定——
            //  armIfIdle 是先发后写,首发读旧态会把自己否掉。)
            const g = goalRef.current;
            if (!g || !shouldContinue(g) || userSendPending()) return;
          }
          try {
            await messaging.prompt(prompt);
            setLastSendError(null); // 成功清失败态
            setSendErrorState(null);
            return;
          } catch (err) {
            if (attempt === MAX_SEND_ATTEMPTS - 1) {
              const msg = err instanceof Error ? err.message : String(err);
              // 有界重试耗尽 → 转 paused + 显形,把处置权交还给人(resume 即重新驱动)
              const cur = goalRef.current;
              if (cur && cur.phase === "active") setGoalRef.current(pauseGoal(cur));
              setLastSendError(msg);
              setSendErrorState(msg);
              void notify.show({ title: "Goal", body: `续跑发送失败,目标已暂停:${msg}` });
              markNote({ action: "send_failed", detail: msg });
              return;
            }
          }
        }
      } finally {
        inflightRef.current = false;
        // finally 里不写 return(no-unsafe-finally:会吞掉在飞异常)——改条件嵌套,语义等价。
        if (deferredRef.current) {
          deferredRef.current = false;
          const g = goalRef.current;
          // 补发按当时最新状态重算(编辑/暂停/排队让路都生效),不欠旧账、不抢用户输入。
          if (g && shouldContinue(g) && !userSendPending()) {
            const round = g.round + 1;
            setGoalRef.current({ ...g, round });
            firePrompt(renderContinuationPrompt(g.objective, round, g.maxRounds));
          }
        }
      }
    })();
  }, [messaging, notify, markNote]);

  const sendRound = useCallback((g: GoalState, round: number) => {
    firePrompt(renderContinuationPrompt(g.objective, round, g.maxRounds));
  }, [firePrompt]);

  /** 空闲且应续跑 → 立即装下一轮并返回推进后的状态;忙/在飞/有排队用户输入/不该续 → 原样返回。
   *  用户输入插队(#5):排队中有用户待发消息时即时装弹让路,由其回合收敛后的 agentSettled 接续。 */
  const armIfIdle = useCallback((g: GoalState): GoalState => {
    if (busyRef.current || inflightRef.current || userSendPending() || !shouldContinue(g)) return g;
    const round = g.round + 1;
    const next = { ...g, round };
    sendRound(next, round);
    return next;
  }, [sendRound]);

  // 模块级单例同步:别处的 setGoal(其它实例/命令桥)变化时本实例跟上(重挂载后读回单例);
  // 失败态同级同步。
  useEffect(() => {
    const l = (): void => {
      goalRef.current = currentGoal;
      setGoalState(currentGoal);
      setSendErrorState(lastSendError);
    };
    goalListeners.add(l);
    return () => { goalListeners.delete(l); };
  }, []);

  // 读:挂载/切会话时从会话头行 custom.goal 恢复目标(窗口刷新不再丢)。
  // 恢复出的 active 目标立即装弹——「active=续跑中」不因窗口刷新停摆。
  // 物化补写:目标诞生于「new:」壳(物化前 updateHeader 够不到文件),路径变真身时补写。
  useEffect(() => {
    let alive = true;
    if (!sessionPath) return;
    const materialized = goalBirthPath !== null && goalBirthPath.startsWith("new:") && !sessionPath.startsWith("new:");
    if (materialized && currentGoal) {
      // 物化而非切换:保留内存态,补写到真身头行(下轮窗口刷新即可恢复)。
      void sessions.updateHeader(sessionPath, { custom: { goal: currentGoal } }).catch(() => {});
      goalBirthPath = sessionPath;
      return;
    }
    // 真切换/冷启动:读头行换档——头行有目标恢复;没有且目标本就属于别的会话(诞生路径不同)→ 清掉;
    // 没有且目标诞生于本会话(含未物化的 new: 壳)→ 保留内存态。
    void sessions.openSession(sessionPath)
      .then((detail) => {
        if (!alive) return;
        const custom = (detail as { info?: { custom?: Record<string, unknown> } } | null)?.info?.custom;
        const restored = parseGoal(custom?.goal);
        if (restored) {
          setGoal(restored.phase === "active" ? armIfIdle(restored) : restored);
          return;
        }
        const foreign = goalBirthPath !== null && goalBirthPath !== sessionPath && !goalBirthPath.startsWith("new:");
        if (foreign) setGoal(null); // 目标是别的会话的,切走即清
      })
      .catch(() => { /* 会话未就绪/读失败:保持无目标,下次切换再读 */ });
    return () => { alive = false; };
  }, [sessions, sessionPath, setGoal, armIfIdle]);

  // 续跑事件订阅:toolCallStart 捕获 set_goal/achieve_goal,agentSettled 判定续跑;
  // agentStart/agentSettled 同时维护 busy(用户命令的即时装弹判据)。
  useEffect(() => {
    return sessions.onEvent((event) => {
      if (event.type === "agentStart") busyRef.current = true;
      if (event.type === "agentSettled") busyRef.current = false;
      // 用户输入插队(#5):回合收敛时若有排队的用户待发消息,本次收敛不续跑也不进轮次——
      // 让 timeline 先把用户消息发出去,等用户消息的回合收敛(队列已清)再续。
      if (event.type === "agentSettled" && userSendPending()) return;
      // 异常收敛不续跑(设计 §5.2):模型报错/人为中断的回合收敛 → 转 paused,不拿轮次硬烧。
      if (event.type === "agentSettled" && goalRef.current?.phase === "active") {
        const terminal = lastAssistantTerminal();
        if (terminal !== null) {
          const cur = goalRef.current;
          if (cur) setGoal(pauseGoal(cur));
          if (terminal === "error") {
            const msg = "回合异常结束,目标已暂停(/goal resume 恢复)";
            setLastSendError(msg);
            setSendErrorState(msg);
            void notify.show({ title: "Goal", body: msg });
            markNote({ action: "auto_pause_error" });
          } else {
            markNote({ action: "auto_pause_interrupt" });
          }
          return;
        }
      }
      const { goal: next, prompt } = applyGoalEvent(goalRef.current, event, { defaultMaxRounds: configuredMaxRounds() });
      if (prompt !== undefined) {
        // 续跑发送撞上在飞:不丢轮次也不推进空轮——欠账挂起,由 firePrompt 的 inflight
        // 收口按当时最新状态补发(根因修复:旧实现推进 round 却丢 prompt,轮数空转)。
        if (inflightRef.current) {
          deferredRef.current = true;
          return;
        }
        setGoal(next); // 推进与发送成对发生
        firePrompt(prompt);
        return;
      }
      if (next !== goalRef.current) setGoal(next);
    });
    // deps 必须含 markNote/notify:markNote 闭包随 sessionPath 重建,缺依赖=切会话后
    // 旧订阅仍往旧会话写留痕(闭包旧值)。messaging 不被本 effect 使用,移出。
  }, [sessions, setGoal, firePrompt, markNote, notify]);

  // 后台归账(设计 §9.1):视图流只含激活会话,而 onKernelEvent 带 sessionKey、后台会话也派发。
  // 后台会话里模型调 set_goal/achieve_goal 时,按来源会话归账写进那个会话自己的头行——
  // 不丢、不串台、不续跑(驱动只服务激活会话);切回时由恢复 effect 读回。引擎不持后台
  // 内存态:读头行 → 套状态机迁移 → 写回头行(头行是跨会话唯一真相源)。
  useEffect(() => {
    return sessions.onKernelEvent((ke) => {
      if (ke.kind !== "session") return;
      const key = ke.sessionKey;
      if (!key || key === useUiStore.getState().currentSessionPath) return; // 激活会话走视图流
      if (key.startsWith("new:") || key.startsWith("bus:") || key.startsWith("test:")) return; // 未物化/运维键
      const ev = ke.event;
      if (ev.type !== "toolCallStart") return;
      const toolName = (ev as { toolName?: unknown }).toolName;
      if (toolName !== "set_goal" && toolName !== "achieve_goal") return;
      void (async () => {
        const detail = await sessions.openSession(key).catch(() => null);
        const custom = (detail as { info?: { custom?: Record<string, unknown> } } | null)?.info?.custom;
        const cur = parseGoal(custom?.goal);
        const { goal: next } = applyGoalEvent(cur, ev, { defaultMaxRounds: configuredMaxRounds() });
        if (next !== cur) await sessions.updateHeader(key, { custom: { goal: next } }).catch(() => {});
      })();
    });
  }, [sessions]);

  const pause = useCallback(() => {
    const g = goalRef.current;
    if (!g || g.phase !== "active") return;
    setGoal(pauseGoal(g));
    markNote({ action: "pause" });
  }, [setGoal, markNote]);
  // 恢复即「继续干活」:空闲时立即装下一轮,不等下一次回合收敛(否则 active 但无人触发,停摆)。
  // 恢复同时清失败态(上次失败已被处置)。
  const resume = useCallback(() => {
    const g = goalRef.current;
    if (!g || g.phase !== "paused") return;
    setLastSendError(null);
    setSendErrorState(null);
    setGoal(armIfIdle(resumeGoal(g)));
    markNote({ action: "resume" });
  }, [setGoal, armIfIdle, markNote]);
  const edit = useCallback((objective: string) => {
    const g = goalRef.current;
    if (!g || g.phase === "achieved") return;
    try {
      setGoal(editGoal(g, objective));
      markNote({ action: "edit", detail: objective });
    } catch { /* 空 objective 忽略 */ }
  }, [setGoal, markNote]);
  const limit = useCallback((maxRounds: number) => {
    const g = goalRef.current;
    if (!g) return;
    try {
      // 到顶停摆(active 但 round 到顶)且空闲时 armIfIdle 立即装弹续跑(§5.3)。
      setGoal(armIfIdle(setGoalMaxRounds(g, maxRounds)));
      markNote({ action: "limit", detail: String(maxRounds) });
    } catch { /* 非正整数忽略 */ }
  }, [setGoal, armIfIdle, markNote]);
  const clear = useCallback(() => {
    if (!goalRef.current) return;
    setLastSendError(null);
    setSendErrorState(null);
    setGoal(null);
    markNote({ action: "clear" });
  }, [setGoal, markNote]);

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
    const g = goalRef.current;
    const notifyNoGoal = (): void => {
      void notify.show({ title: "Goal", body: "当前没有目标。用 /goal <目标内容> 设置。", silent: true });
    };
    switch (cmd.kind) {
      case "set": {
        try {
          // 只建状态,不装弹:首轮就是返回 { send } 发出去的那条目标正文,
          // 它的回合收敛(agentSettled)自然接第一轮续跑。
          // 上限:命令不带 max_rounds → 取通用配置(只在创建时读取,见 configuredMaxRounds)。
          setLastSendError(null);
          setSendErrorState(null);
          setGoal(createGoal({ ...cmd.request, maxRounds: configuredMaxRounds() }));
        } catch {
          void notify.show({ title: "Goal", body: GOAL_USAGE, silent: true });
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
          void notify.show({ title: "Goal", body: "目标已达成,不可编辑(/goal clear 删除后可设新目标)", silent: true });
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
          body: g ? `[${g.phase}] ${g.round}/${g.maxRounds} · ${g.objective}` : GOAL_USAGE,
          silent: true,
        });
        return true;
    }
  }, [notify, setGoal, pause, resume, edit, limit, clear]);

  // 桥接:把当前控制器挂到模块级入口(静态导出侧)。卸载时只清自己,不误伤后续挂载者。
  const handleCommandRef = useRef(handleCommand);
  handleCommandRef.current = handleCommand;
  useEffect(() => {
    const fn = (input: string): Promise<ComposerCommandResult> => handleCommandRef.current(input);
    activeCommandHandler = fn;
    return () => { if (activeCommandHandler === fn) activeCommandHandler = null; };
  }, []);

  return { goal, sendError, pause, resume, edit, clear };
}
