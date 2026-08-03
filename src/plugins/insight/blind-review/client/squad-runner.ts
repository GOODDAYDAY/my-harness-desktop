// 出站执行器 —— 唯一碰 ctx 的逻辑单元:串行蓝队 + 裁判 + 会话恢复。
//
// 流程(对齐 docs/plugins/blind-review.md §3.4):
//   逐队:setContext(cwd, null) 开全新会话(信息屏障)→ prompt → 等生成完成
//        → getLastAssistantText 收报告 → renameSession 打标记(best-effort)
//   裁判:同样独立会话,输入 = 内容 + 全部各队报告
//   finally:setContext(cwd, 原会话) 恢复——含中止与失败路径
//
// 串行是进程模型决定的(单激活会话),隔离靠每队真新会话(零历史)。
// 等完成靠 zustand subscribe 事件驱动,不轮询不 sleep;超时仅进程失联的保险丝。
// 一切自然语言文本(prompt 标注、树失败占位、会话命名标记)经 SquadRunLabels 注入。

import { useSessionStore, useUiStore, type PluginContext } from "@pi-desktop/react";
import type { JudgeConfig, TeamConfig } from "../core/config";
import {
  assembleJudgePrompt,
  assembleTeamPrompt,
  serializeTree,
  TREE_IGNORE_DIRS,
  type AssembleLabels,
  type TeamReport,
} from "../core/assemble";
import { initRunState, markJudge, markPhase, markTeam, type SquadRunState } from "../core/run-state";

/** 单轮生成的等待保险丝:正常路径 agentStart/agentEnd 事件驱动,超时只在进程异常失联时兜底。 */
const STREAM_TIMEOUT_MS = 10 * 60 * 1000;

/** 运行期文案:组装标注 + 树失败占位(prompt 用)+ 会话命名标记前缀(sessions-list 可辨)。 */
export interface SquadRunLabels extends AssembleLabels {
  treeUnavailable: string;
  sessionMark: string;
}

export interface SquadRunResult {
  reports: TeamReport[];
  judgeText: string | null;
  cancelled: boolean;
}

export interface SquadRunOptions {
  cwd: string;
  content: string;
  /** 本次出场的队(调用方已过 enabled/单发筛选)。 */
  teams: TeamConfig[];
  /** null = 单发模式,无裁判。 */
  judge: JudgeConfig | null;
  labels: SquadRunLabels;
  onProgress: (state: SquadRunState) => void;
  isCancelled: () => boolean;
}

/** 两阶段等待:先等 streaming 起(确认本轮生成开始——订阅早于 agentStart 时 store 还是
 *  旧会话状态,直接等回落会用旧 assistant 消息误判完成),再等 streaming 回落 +
 *  末条 assistant 非 pending。stopped/error 记失败,由调用方决定继续还是中止。
 *  cancel 用于 prompt 发送失败路径:回收订阅与计时器,promise 悬空无人等。 */
interface StreamWaiter {
  promise: Promise<{ ok: boolean; error?: string }>;
  cancel: () => void;
}

function waitStreamCycle(): StreamWaiter {
  let settled = false;
  let unsub: () => void = () => {};
  let timer: ReturnType<typeof setTimeout>;
  const promise = new Promise<{ ok: boolean; error?: string }>((resolve) => {
    const done = (r: { ok: boolean; error?: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsub();
      resolve(r);
    };
    timer = setTimeout(() => done({ ok: false, error: "timeout" }), STREAM_TIMEOUT_MS);
    let started = false;
    unsub = useSessionStore.subscribe((s) => {
      if (!started) {
        if (s.streaming) started = true;
        return;
      }
      if (s.streaming) return;
      const last = s.messages[s.messages.length - 1];
      if (!last || last.role !== "assistant" || last.pending) return;
      done(last.stopped || last.error ? { ok: false, error: "interrupted" } : { ok: true });
    });
  });
  return {
    promise,
    cancel: () => {
      settled = true;
      clearTimeout(timer);
      unsub();
    },
  };
}

async function runOne(
  ctx: PluginContext,
  cwd: string,
  promptText: string,
  markName: string,
  labels: SquadRunLabels,
): Promise<string> {
  await ctx.sessions.setContext(cwd, null);
  const waiter = waitStreamCycle();
  try {
    await ctx.messaging.prompt(promptText);
  } catch (err) {
    waiter.cancel();
    throw err;
  }
  const r = await waiter.promise;
  if (!r.ok) throw new Error(r.error ?? "unknown");
  const text = await ctx.maintenance.getLastAssistantText();
  if (!text.trim()) throw new Error("empty");
  const sp = useUiStore.getState().currentSessionPath;
  if (sp) void ctx.sessions.renameSession(sp, `${labels.sessionMark} ${markName}`).catch(() => {});
  return text;
}

export async function runSquad(ctx: PluginContext, opts: SquadRunOptions): Promise<SquadRunResult> {
  const { cwd, content, teams, judge, labels, onProgress, isCancelled } = opts;
  const originalPath = useUiStore.getState().currentSessionPath;
  let state = initRunState(teams, judge !== null);
  const emit = (s: SquadRunState): void => {
    state = s;
    onProgress(s);
  };

  const reports: TeamReport[] = [];
  let judgeText: string | null = null;
  let cancelled = false;

  // 白盒队共享一份树快照:流程启动读一次(树在流程期间不变),无白盒队不读。
  // 读取失败给占位文本——{{tree}} 不能原样留在 prompt 里发给模型。
  let tree: string | null = null;
  if (teams.some((t) => t.access === "project")) {
    try {
      if (!ctx.fs) throw new Error("fs unavailable");
      tree = serializeTree(await ctx.fs.readDirTree(cwd, { maxDepth: 3, ignore: TREE_IGNORE_DIRS }), labels);
    } catch {
      tree = labels.treeUnavailable;
    }
  }

  try {
    for (const team of teams) {
      if (isCancelled()) {
        cancelled = true;
        break;
      }
      emit(markTeam(state, team.id, "running"));
      try {
        const text = await runOne(ctx, cwd, assembleTeamPrompt(team, content, team.access === "project" ? tree : null, labels), team.name, labels);
        reports.push({ teamId: team.id, teamName: team.name, text, ok: true });
        emit(markTeam(state, team.id, "done"));
      } catch (err) {
        reports.push({ teamId: team.id, teamName: team.name, text: String(err), ok: false });
        emit(markTeam(state, team.id, "failed"));
      }
    }
    if (isCancelled()) cancelled = true;

    // 裁判:至少一队成功才有汇总意义;中止则跳过。跳过要显式标记,不留 pending 假相。
    if (!cancelled && judge && reports.some((r) => r.ok)) {
      emit(markPhase(state, "judge"));
      emit(markJudge(state, "running"));
      try {
        judgeText = await runOne(ctx, cwd, assembleJudgePrompt(judge, content, reports, labels), judge.name, labels);
        emit(markJudge(state, "done"));
      } catch {
        emit(markJudge(state, "failed"));
      }
    } else if (judge) {
      emit(markJudge(state, "skipped"));
    }
    if (isCancelled()) cancelled = true;
    emit(markPhase(state, cancelled ? "cancelled" : "done"));
  } finally {
    try {
      ctx.sessions.setContext(cwd, originalPath);
    } catch {
      // 恢复失败不阻塞结果返回
    }
  }
  return { reports, judgeText, cancelled };
}
