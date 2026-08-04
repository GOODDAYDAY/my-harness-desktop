// token-stats 插件 renderer —— 右面板"统计"页签。三层口径,一层一源,不跨层校准:
//   本轮 live  :事件流累计(只跟当前 sessionKey)。翻轮唯一时机 = agentStart:
//              上一轮 totals 归档为"上一次",本轮清零重新累计——本轮值在轮结束后
//              持续可见,直到下一轮开始。勿在 agentEnd/agentSettled 翻轮:底座每轮
//              同帧连发这两个事件,先到者归档并清零、后到者用清零值再覆盖一次
//              (双发覆盖,"上一次"恒为 0);且 usage 只在 messageEnd 落地,
//              settle 即清会让"本轮"在整个流式期间恒为 0。
//   本会话     :会话投影 stats(框架统一拉取/刷新/切会话失效,插件只读)
//   项目总     :sessions.projectStats 聚合本 cwd 全部会话 JSONL(文件真值,含 app 未运行期;
//              真值不可"重置",故无清零按钮——要清零去删会话文件)
//
// 只用核心默认能力(onKernelEvent 运维流 + sessions.projectStats),
// 零权限声明、零持久化。事件驱动不轮询;页签 keep-alive,订阅常驻。
// usage 形状以底座实测为准(2026-07):message.usage = {input, output, cacheRead,
// cacheWrite, cost, totalTokens},仅挂在 assistant 消息上;abort 的消息可能没有 usage。
// cost 是分解对象 {input, output, cacheRead, cacheWrite, total} —— 取 cost.total。
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Activity, BarChart3, Globe2 } from "lucide-react";
import { usePluginContext, useUiStore, useSessionStore, EmptyState, type ProjectStats } from "@pi-desktop/react";

/* ============ 数据模型 ============ */

interface TurnTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  tpsSum: number;
  tpsCount: number;
}

const ZERO: TurnTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, tpsSum: 0, tpsCount: 0 };

/** 从 messageEnd 事件负载取 usage(底座实测形状;无 usage 的消息计 0)。 */
function extractUsage(message: unknown): Pick<TurnTotals, "input" | "output" | "cacheRead" | "cacheWrite" | "cost"> {
  const none = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  if (!message || typeof message !== "object") return none;
  const u = (message as { usage?: unknown }).usage;
  if (!u || typeof u !== "object") return none;
  const r = u as Record<string, unknown>;
  const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const c = r.cost;
  return {
    input: n(r.input), output: n(r.output), cacheRead: n(r.cacheRead), cacheWrite: n(r.cacheWrite),
    cost: typeof c === "number" ? c : c && typeof c === "object" ? n((c as Record<string, unknown>).total) : 0,
  };
}

function avgTps(s: Pick<TurnTotals, "tpsSum" | "tpsCount">): number | null {
  return s.tpsCount > 0 ? Math.round((s.tpsSum / s.tpsCount) * 100) / 100 : null;
}

/** 计数人性化:1234 → "1.23K",1_234_567 → "1.23M"。token 是计数不是字节,单位用 K/M/B 不用 KB/MB/GB。 */
function fmtCount(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const abs = Math.abs(n);
  if (abs < 1_000) return String(Math.round(n));
  if (abs < 1_000_000) return `${(n / 1_000).toFixed(2)}K`;
  if (abs < 1_000_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}

/* ============ 组件 ============ */

export function TokenStatsTab({ isActive }: { isActive: boolean }): React.ReactNode {
  void isActive; // 槽壳注入的可见性标记;keep-alive 下订阅常驻,无需区分
  const ctx = usePluginContext();
  const { t } = useTranslation();
  const cwd = useUiStore((s) => s.currentCwd);
  const sessionPath = useUiStore((s) => s.currentSessionPath);
  const sessionKey = sessionPath ?? `new:${cwd}`;

  const sessionStats = useSessionStore((s) => s.stats);
  const [projectStats, setProjectStats] = useState<ProjectStats | null>(null);
  const [turnLive, setTurnLive] = useState<TurnTotals>({ ...ZERO });
  const [lastTurn, setLastTurn] = useState<TurnTotals>({ ...ZERO });

  const turnRef = useRef<TurnTotals>({ ...ZERO });
  /** messageStart 时刻按 sessionKey 分桶——全量事件流里各会话的起止互不覆盖。 */
  const msgStartsRef = useRef(new Map<string, number>());
  const sessionKeyRef = useRef(sessionKey);
  sessionKeyRef.current = sessionKey;

  /* ---- 项目总文件真值:挂载 / 切项目 / 任一会话轮次结束刷新(scanner 增量缓存,廉价) ---- */
  const refreshProject = async (): Promise<void> => {
    try {
      setProjectStats(await ctx.sessions.projectStats(cwd));
    } catch { /* 扫描失败保持旧值 */ }
  };

  useEffect(() => {
    setProjectStats(null);
    turnRef.current = { ...ZERO };
    setTurnLive({ ...ZERO });
    setLastTurn({ ...ZERO });
    void refreshProject();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey, cwd]);

  /* ---- 事件订阅:本轮 live 只跟当前会话;项目总刷新时机 = 任一会话一轮结束 ---- */
  useEffect(() => {
    const off = ctx.sessions.onKernelEvent((event) => {
      if (event.kind !== "session") return;
      const ev = event.event;
      if (ev.type === "messageStart") {
        msgStartsRef.current.set(event.sessionKey, Date.now());
        return;
      }
      if (ev.type === "agentStart") {
        if (event.sessionKey !== sessionKeyRef.current) return; // live 视图只跟当前会话
        const acc = turnRef.current;
        if (acc.input + acc.output + acc.cacheRead + acc.cacheWrite > 0) {
          setLastTurn({ ...acc }); // 上一轮有真实消耗才归档——中止的空轮不覆盖"上一次"
        }
        turnRef.current = { ...ZERO };
        setTurnLive({ ...ZERO });
        return;
      }
      if (ev.type === "messageEnd") {
        const start = msgStartsRef.current.get(event.sessionKey);
        msgStartsRef.current.delete(event.sessionKey);
        if (event.sessionKey !== sessionKeyRef.current) return; // live 视图只跟当前会话
        const u = extractUsage((ev as { message?: unknown }).message);
        const tps = start != null && u.output > 0 ? u.output / Math.max(0.1, (Date.now() - start) / 1000) : 0;
        const acc = turnRef.current;
        acc.input += u.input; acc.output += u.output;
        acc.cacheRead += u.cacheRead; acc.cacheWrite += u.cacheWrite; acc.cost += u.cost;
        if (tps > 0) { acc.tpsSum += tps; acc.tpsCount += 1; }
        setTurnLive({ ...acc });
        return;
      }
      if (ev.type === "agentSettled" || ev.type === "agentEnd") {
        void refreshProject(); // 任一会话一轮结束 → 会话文件已增长,重扫(增量缓存)
      }
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey, cwd]);

  const sessionZero = !sessionStats
    || (sessionStats.tokens.input + sessionStats.tokens.output === 0 && sessionStats.userMessages === 0);
  const empty = (projectStats?.sessionCount ?? 0) === 0 && sessionZero
    && turnLive.input + turnLive.output === 0;

  return (
    <div className="flex-1 flex flex-col min-h-0 p-3 gap-3 overflow-y-auto">
      {/* 本会话(RPC 权威) */}
      <SectionHead icon={<Activity className="size-3.5" />} title={t("stats.sessionTotal")} />
      <StatRow label={t("stats.input2")} value={sessionStats?.tokens.input ?? 0} />
      <StatRow label={t("stats.output2")} value={sessionStats?.tokens.output ?? 0} />
      <StatRow label={t("stats.cacheRead")} value={sessionStats?.tokens.cacheRead ?? 0} />
      <StatRow label={t("stats.cacheWrite")} value={sessionStats?.tokens.cacheWrite ?? 0} />
      <ContextRow
        label={t("stats.contextUsed")}
        tokens={sessionStats?.contextUsage?.tokens ?? null}
        window={sessionStats?.contextUsage?.contextWindow ?? 0}
        percent={sessionStats?.contextUsage?.percent ?? null}
      />
      <TpsRow label={t("stats.tps")} tps={sessionStats?.tps ?? null} />

      <div className="border-t border-[var(--color-border)] my-1" />
      {/* 本轮 live(事件流) */}
      <SectionHead icon={<BarChart3 className="size-3.5" />} title={t("stats.thisTurnLive")} />
      <StatRow label={t("stats.input2")} value={turnLive.input} />
      <StatRow label={t("stats.output2")} value={turnLive.output} />
      <TpsRow label={t("stats.tps")} tps={avgTps(turnLive)} />

      <div className="border-t border-[var(--color-border)] my-1" />
      {/* 上一次完成轮(本次运行内,重启即空) */}
      <div className="text-[length:var(--font-size-sm)] text-[var(--color-muted)]">{t("stats.lastTurn")}</div>
      <StatRow label={t("stats.input2")} value={lastTurn.input} />
      <StatRow label={t("stats.output2")} value={lastTurn.output} />

      <div className="border-t border-[var(--color-border)] my-1" />
      {/* 项目总(本 cwd 全部会话文件的真值聚合) */}
      <SectionHead icon={<Globe2 className="size-3.5" />} title={t("stats.projectTotal")} />
      <StatRow label={t("stats.input2")} value={projectStats?.tokens.input ?? 0} />
      <StatRow label={t("stats.output2")} value={projectStats?.tokens.output ?? 0} />
      <StatRow label={t("stats.cacheRead")} value={projectStats?.tokens.cacheRead ?? 0} />
      <StatRow label={t("stats.cacheWrite")} value={projectStats?.tokens.cacheWrite ?? 0} />
      <CostRow label={t("stats.cost")} cost={projectStats?.cost ?? 0} />
      <StatRow label={t("stats.turns")} value={projectStats?.turns ?? 0} />
      <StatRow label={t("stats.sessionCount")} value={projectStats?.sessionCount ?? 0} />

      {empty && (
        <EmptyState
          icon={<BarChart3 className="size-8" />}
          title={t("system.noData")}
          description={t("system.noDataDesc")}
        />
      )}
    </div>
  );
}

/* ============ 展示件 ============ */

function SectionHead({ icon, title, action }: { icon: React.ReactNode; title: string; action?: React.ReactNode }): React.ReactNode {
  return (
    <div className="flex items-center justify-between shrink-0">
      <span className="flex items-center gap-1.5 text-[length:var(--font-size-sm)] text-[var(--color-muted)]">
        {icon}{title}
      </span>
      {action}
    </div>
  );
}

function StatRow({ label, value, strong }: { label: string; value: number; strong?: boolean }): React.ReactNode {
  return (
    <div className="flex items-center justify-between text-[length:var(--font-size-sm)]">
      <span className="text-[var(--color-muted)]">{label}</span>
      <span className="font-[var(--font-family-mono)]" style={{ color: "var(--color-fg)", fontWeight: strong ? 600 : 400 }}>
        {fmtCount(value)}
      </span>
    </div>
  );
}

function CostRow({ label, cost }: { label: string; cost: number }): React.ReactNode {
  // 亚分金额留 4 位——toFixed(2) 会把 $0.0043 显示成 $0.00,看起来像没数据
  const text = cost > 0 && cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2);
  return (
    <div className="flex items-center justify-between text-[length:var(--font-size-sm)]">
      <span className="text-[var(--color-muted)]">{label}</span>
      <span className="font-[var(--font-family-mono)]" style={{ color: "var(--color-fg)" }}>
        ${text}
      </span>
    </div>
  );
}

function TpsRow({ label, tps }: { label: string; tps: number | null }): React.ReactNode {
  return (
    <div className="flex items-center justify-between text-[length:var(--font-size-sm)]">
      <span className="text-[var(--color-muted)]">{label}</span>
      <span className="font-[var(--font-family-mono)]" style={{ color: "var(--color-fg)" }}>
        {tps == null ? "—" : `${tps.toFixed(2)} t/s`}
      </span>
    </div>
  );
}

function ContextRow({ label, tokens, window: contextWindow, percent }: {
  label: string; tokens: number | null; window: number; percent: number | null;
}): React.ReactNode {
  const pct = percent ?? (contextWindow > 0 && tokens != null ? Math.round((tokens / contextWindow) * 100) : null);
  return (
    <div className="flex flex-col gap-1 text-[length:var(--font-size-sm)]">
      <div className="flex items-center justify-between">
        <span className="text-[var(--color-muted)]">{label}</span>
        <span className="font-[var(--font-family-mono)]" style={{ color: "var(--color-fg)" }}>
          {tokens == null ? "—" : `${fmtCount(tokens)}${contextWindow > 0 ? ` / ${fmtCount(contextWindow)}` : ""}${pct != null ? ` (${pct}%)` : ""}`}
        </span>
      </div>
      <div style={{ height: 4, borderRadius: 2, background: "var(--color-border)", overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${pct ?? 0}%`, background: "var(--color-primary)", transition: "width 200ms" }} />
      </div>
    </div>
  );
}
