// token-stats 插件 renderer —— 右面板"统计"页签。三层口径,一层一源,不跨层校准:
//   本轮/上一次:会话投影 stats.turn / stats.lastTurn(框架统一拉取/刷新/切会话失效,插件只读)。
//              累计在 main 侧 dispatch 完成——agentStart 翻轮(有消耗才归档,空轮不覆盖)、
//              messageEnd 按 messageUsageOf 累加;勿改回插件内累计:sidePanel 页签不保活,
//              组件卸载期的事件永久丢失,"上一次"只能靠常驻采集者(框架),插件组件做不到。
//   本会话     :会话投影 stats 其余字段(同一投影,RPC 权威)
//   项目总     :sessions.projectStats 聚合本 cwd 全部会话 JSONL(文件真值,含 app 未运行期;
//              真值不可"重置",故无清零按钮——要清零去删会话文件)
//
// 只用核心默认能力(onKernelEvent 运维流 + sessions.projectStats),
// 零权限声明、零持久化。事件驱动不轮询:stats 由框架在轮次起止刷新,
// 项目总刷新时机 = 任一会话一轮结束(agentSettled/agentEnd 哑触发,无状态可丢)。
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Activity, BarChart3, Globe2 } from "lucide-react";
import { usePluginContext, useUiStore, useSessionStore, EmptyState, type ProjectStats } from "@my-harness-desktop/react";

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
  void isActive; // 槽壳注入的可见性标记;数据全走投影/IPC,无需按可见性区分
  const ctx = usePluginContext();
  const { t } = useTranslation();
  const cwd = useUiStore((s) => s.currentCwd);
  const sessionPath = useUiStore((s) => s.currentSessionPath);

  const sessionStats = useSessionStore((s) => s.stats);
  const [projectStats, setProjectStats] = useState<ProjectStats | null>(null);

  /* ---- 项目总文件真值:挂载 / 切项目 / 任一会话轮次结束刷新(scanner 增量缓存,廉价) ---- */
  const refreshProject = async (): Promise<void> => {
    try {
      setProjectStats(await ctx.sessions.projectStats(cwd));
    } catch { /* 扫描失败保持旧值 */ }
  };

  useEffect(() => {
    setProjectStats(null);
    void refreshProject();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionPath, cwd]);

  /* ---- 项目总刷新触发:任一会话一轮结束 → 会话文件已增长,重扫(增量缓存)。
   *  哑触发无状态——卸载期漏触发不损失正确性,挂载即经上行 effect 重拉。 ---- */
  useEffect(() => {
    return ctx.sessions.onKernelEvent((event) => {
      if (event.kind !== "session") return;
      if (event.event.type === "agentSettled" || event.event.type === "agentEnd") {
        void refreshProject();
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionPath, cwd]);

  const turn = sessionStats?.turn;
  const lastTurn = sessionStats?.lastTurn ?? null;
  const sessionZero = !sessionStats
    || (sessionStats.tokens.input + sessionStats.tokens.output === 0 && sessionStats.userMessages === 0);
  const empty = (projectStats?.sessionCount ?? 0) === 0 && sessionZero
    && (turn?.input ?? 0) + (turn?.output ?? 0) === 0;

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
      {/* 本轮(投影 turn;轮结束后持续可见,直到下一轮开始) */}
      <SectionHead icon={<BarChart3 className="size-3.5" />} title={t("stats.thisTurnLive")} />
      <StatRow label={t("stats.input2")} value={turn?.input ?? 0} />
      <StatRow label={t("stats.output2")} value={turn?.output ?? 0} />
      <TpsRow label={t("stats.tps")} tps={sessionStats?.tps ?? null} />

      <div className="border-t border-[var(--color-border)] my-1" />
      {/* 上一次完成轮(进程内,重启即空) */}
      <div className="text-[length:var(--font-size-sm)] text-[var(--color-muted)]">{t("stats.lastTurn")}</div>
      <StatRow label={t("stats.input2")} value={lastTurn?.input ?? 0} />
      <StatRow label={t("stats.output2")} value={lastTurn?.output ?? 0} />

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
      <div className="flex items-center justify-between gap-2">
        <span className="text-[var(--color-muted)] whitespace-nowrap shrink-0">{label}</span>
        <span className="font-[var(--font-family-mono)] text-right min-w-0" style={{ color: "var(--color-fg)" }}>
          {tokens == null ? "—" : `${fmtCount(tokens)}${contextWindow > 0 ? ` / ${fmtCount(contextWindow)}` : ""}${pct != null ? ` (${Math.round(pct)}%)` : ""}`}
        </span>
      </div>
      <div style={{ height: 4, borderRadius: 2, background: "var(--color-border)", overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${pct ?? 0}%`, background: "var(--color-primary)", transition: "width 200ms" }} />
      </div>
    </div>
  );
}
