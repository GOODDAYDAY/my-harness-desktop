// token-stats 插件 renderer —— 右面板"统计"页签。三层口径:
//   本轮 live  :事件流 messageStart→messageEnd 实时累计(按当前 sessionKey 过滤)
//   本会话     :getStats RPC 权威值(tokens/上下文占用/消息计数/toolCalls/TPS)
//   项目总     :事件流增量 + RPC 差值校准(重启丢的历史由权威差值补回),持久化
//
// 只用核心默认能力(sessions.onKernelEvent 运维流 + messaging.getStats + config),
// 零权限声明、零新 hook 点。事件驱动,不轮询;右面板页签 keep-alive,订阅常驻。
//
// ⚠ pi 事件里 usage 的精确字段形状依赖底座版本,extractUsage 做多路径防御;
// 取不到就计 0(展示仍为 0,不报错)——字段确认后只改 extractUsage 一处。
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Activity, BarChart3, Globe2, RotateCcw } from "lucide-react";
import { usePluginContext, useUiStore, EmptyState, type SessionStats } from "@pi-desktop/react";

/* ============ 数据模型 ============ */

interface LayerStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** 费用(RPC 口径;事件流没有 cost 字段,事件侧恒 0,以 getStats 权威值为准)。 */
  cost: number;
  /** 已完成对话轮次(agentSettled/agentEnd 记一轮)。 */
  turns: number;
  toolCalls: number;
  userMessages: number;
  assistantMessages: number;
  /** TPS 均值累加(messageStart→messageEnd 自算,底座不给,domain 契约)。 */
  tpsSum: number;
  tpsCount: number;
  /** 上下文占用(仅本会话 RPC 口径才有)。 */
  contextTokens?: number | null;
  contextWindow?: number;
  contextPercent?: number | null;
}

/** 项目总校准用的每会话账本:RPC 权威值与本地事件累计的差值,重启后补回全局。 */
type SessionTotals = Pick<LayerStats, "input" | "output" | "cacheRead" | "cacheWrite" | "cost">;

interface PersistedV2 {
  lastTurn: LayerStats;
  global: LayerStats;
  /** 按 sessionKey(vite 的会话 key:sessionPath 或 `new:${cwd}`)记录的本地账本。 */
  sessions: Record<string, SessionTotals>;
}

const ZERO: LayerStats = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0,
  turns: 0, toolCalls: 0, userMessages: 0, assistantMessages: 0,
  tpsSum: 0, tpsCount: 0,
};

const PERSIST_KEY = "stats.v2";
const LEGACY_KEY = "totals";

/** 从 messageEnd 事件负载里多路径挖 usage(底座字段形状未文档化,防御性提取)。 */
function extractUsage(message: unknown): SessionTotals {
  const none: SessionTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  if (!message || typeof message !== "object") return none;
  const m = message as Record<string, unknown>;
  const usage = (m.usage ?? m.tokenUsage ?? m.tokens) as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== "object") return none;
  const num = (...keys: string[]): number => {
    for (const k of keys) { const v = usage[k]; if (typeof v === "number") return v; }
    return 0;
  };
  return {
    input: num("inputTokens", "input", "input_tokens", "promptTokens"),
    output: num("outputTokens", "output", "output_tokens", "completionTokens"),
    cacheRead: num("cacheReadTokens", "cacheRead", "cache_read", "cachedTokens"),
    cacheWrite: num("cacheWriteTokens", "cacheWrite", "cache_write"),
    cost: num("cost", "costUSD", "cost_usd"),
  };
}

function addTotals(s: SessionTotals, u: SessionTotals): void {
  s.input += u.input; s.output += u.output; s.cacheRead += u.cacheRead; s.cacheWrite += u.cacheWrite; s.cost += u.cost;
}

function avgTps(s: Pick<LayerStats, "tpsSum" | "tpsCount">): number | null {
  return s.tpsCount > 0 ? Math.round((s.tpsSum / s.tpsCount) * 10) / 10 : null;
}

/* ============ 组件 ============ */

export function TokenStatsTab({ isActive }: { isActive: boolean }): React.ReactNode {
  void isActive; // 槽壳注入的可见性标记;keep-alive 下订阅常驻,无需区分
  const ctx = usePluginContext();
  const { t } = useTranslation();
  const cwd = useUiStore((s) => s.currentCwd);
  const sessionPath = useUiStore((s) => s.currentSessionPath);
  const sessionKey = sessionPath ?? `new:${cwd}`;

  const [ready, setReady] = useState(false);
  const [globalStats, setGlobalStats] = useState<LayerStats>({ ...ZERO });
  const [sessionStats, setSessionStats] = useState<LayerStats>({ ...ZERO });
  const [lastTurn, setLastTurn] = useState<LayerStats>({ ...ZERO });
  const [turnLive, setTurnLive] = useState<LayerStats>({ ...ZERO });

  const turnRef = useRef<LayerStats>({ ...ZERO });
  const lastTurnRef = useRef<LayerStats>({ ...ZERO });
  const globalRef = useRef<LayerStats>({ ...ZERO });
  const sessionTotalsRef = useRef<Record<string, SessionTotals>>({});
  const msgStartRef = useRef<number | null>(null);
  const sessionKeyRef = useRef(sessionKey);
  sessionKeyRef.current = sessionKey;

  const persist = async (): Promise<void> => {
    const data: PersistedV2 = { lastTurn: lastTurnRef.current, global: globalRef.current, sessions: sessionTotalsRef.current };
    await ctx.config.set(PERSIST_KEY, data);
  };

  /* ---- 启动:读持久化(新版 stats.v2,无则迁移旧 key totals 的累计) ---- */
  useEffect(() => {
    void (async () => {
      const data = await ctx.config.get<PersistedV2>(PERSIST_KEY);
      if (data) {
        lastTurnRef.current = { ...ZERO, ...data.lastTurn };
        globalRef.current = { ...ZERO, ...data.global };
        sessionTotalsRef.current = { ...data.sessions };
      } else {
        // 旧版只持久化了全局累计 {input, output, turns} —— 迁移进 projectTotal,不丢历史
        const legacy = await ctx.config.get<Pick<LayerStats, "input" | "output" | "turns">>(LEGACY_KEY);
        if (legacy) globalRef.current = { ...ZERO, ...legacy };
      }
      setLastTurn({ ...lastTurnRef.current });
      setGlobalStats({ ...globalRef.current });
      setReady(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---- 切换会话 / 轮次结束:getStats RPC 拿本会话权威值 + 项目总差值校准 ---- */
  async function refreshSessionStats(key: string): Promise<void> {
    let stats: SessionStats;
    try {
      stats = await ctx.messaging.getStats();
    } catch { return; } // 底座未就绪:保持事件流口径,下个 agentSettled 再校准
    const tokens: SessionTotals = {
      input: stats.tokens?.input ?? 0, output: stats.tokens?.output ?? 0,
      cacheRead: stats.tokens?.cacheRead ?? 0, cacheWrite: stats.tokens?.cacheWrite ?? 0,
      cost: stats.cost ?? 0,
    };
    // 差值补偿:权威值 − 本地事件账本 = 重启丢失期间漏计的增量,补进项目总
    const prev = sessionTotalsRef.current[key] ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    const g = globalRef.current;
    g.input = Math.max(0, g.input + tokens.input - prev.input);
    g.output = Math.max(0, g.output + tokens.output - prev.output);
    g.cacheRead = Math.max(0, g.cacheRead + tokens.cacheRead - prev.cacheRead);
    g.cacheWrite = Math.max(0, g.cacheWrite + tokens.cacheWrite - prev.cacheWrite);
    g.cost = Math.max(0, g.cost + tokens.cost - prev.cost);
    sessionTotalsRef.current[key] = { ...tokens };
    const next: LayerStats = {
      ...ZERO, ...tokens,
      turns: sessionTotalsRef.current[key] ? globalRef.current.turns : 0,
      toolCalls: stats.toolCalls ?? 0,
      userMessages: stats.userMessages ?? 0,
      assistantMessages: stats.assistantMessages ?? 0,
      tpsSum: 0, tpsCount: 0,
      contextTokens: stats.contextUsage?.tokens ?? null,
      contextWindow: stats.contextUsage?.contextWindow ?? 0,
      contextPercent: stats.contextUsage?.percent ?? null,
    };
    setSessionStats(next);
    setGlobalStats({ ...g });
    await persist();
  }

  useEffect(() => {
    if (!ready) return;
    void refreshSessionStats(sessionKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey, ready]);

  /* ---- 事件订阅:运维流全量记账(全局不过滤),本轮视图按 sessionKey 归属过滤 ---- */
  useEffect(() => {
    if (!ready) return;
    const off = ctx.sessions.onKernelEvent((event) => {
      if (event.kind !== "session") return;
      const ev = event.event;
      if (ev.type === "messageStart") {
        msgStartRef.current = Date.now();
        return;
      }
      if (ev.type === "messageEnd") {
        const u = extractUsage((ev as { message?: unknown }).message);
        const tps = msgStartRef.current != null && u.output > 0
          ? u.output / Math.max(0.1, (Date.now() - msgStartRef.current) / 1000)
          : 0;
        msgStartRef.current = null;
        // 项目总:全量会话都记账,后台会话的产出不能漏
        addTotals(globalRef.current, u);
        if (tps > 0) { globalRef.current.tpsSum += tps; globalRef.current.tpsCount += 1; }
        setGlobalStats({ ...globalRef.current });
        // 本轮 live:只跟当前会话
        if (event.sessionKey === sessionKeyRef.current) {
          addTotals(turnRef.current, u);
          if (tps > 0) { turnRef.current.tpsSum += tps; turnRef.current.tpsCount += 1; }
          setTurnLive({ ...turnRef.current });
        }
        return;
      }
      if (ev.type === "agentSettled" || ev.type === "agentEnd") {
        // 一轮结束:快照本轮 → 上一次对话;清 live;RPC 校准本会话权威值
        lastTurnRef.current = { ...turnRef.current };
        setLastTurn({ ...lastTurnRef.current });
        turnRef.current = { ...ZERO };
        setTurnLive({ ...ZERO });
        globalRef.current.turns += 1;
        setGlobalStats({ ...globalRef.current });
        void refreshSessionStats(sessionKeyRef.current);
      }
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, sessionKey]);

  const resetGlobal = async (): Promise<void> => {
    globalRef.current = { ...ZERO };
    sessionTotalsRef.current = {};
    lastTurnRef.current = { ...ZERO };
    setGlobalStats({ ...ZERO });
    setLastTurn({ ...ZERO });
    await persist();
  };

  if (!ready) return null;

  const empty = globalStats.userMessages === 0 && globalStats.input + globalStats.output === 0
    && turnLive.input + turnLive.output === 0 && sessionStats.input + sessionStats.output === 0;

  return (
    <div className="flex-1 flex flex-col min-h-0 p-3 gap-3 overflow-y-auto">
      {/* 本会话(RPC 权威) */}
      <SectionHead icon={<Activity className="size-3.5" />} title={t("stats.sessionTotal")} />
      <StatRow label={t("stats.input2")} value={sessionStats.input} />
      <StatRow label={t("stats.output2")} value={sessionStats.output} />
      <StatRow label={t("stats.cacheRead")} value={sessionStats.cacheRead} />
      <StatRow label={t("stats.cacheWrite")} value={sessionStats.cacheWrite} />
      <ContextRow
        label={t("stats.contextUsed")}
        tokens={sessionStats.contextTokens ?? null}
        window={sessionStats.contextWindow ?? 0}
        percent={sessionStats.contextPercent ?? null}
      />
      <TpsRow label={t("stats.tps")} tps={avgTps(sessionStats)} />

      <div className="border-t border-[var(--color-border)] my-1" />
      {/* 本轮 live(事件流) */}
      <SectionHead icon={<BarChart3 className="size-3.5" />} title={t("stats.thisTurnLive")} />
      <StatRow label={t("stats.input2")} value={turnLive.input} />
      <StatRow label={t("stats.output2")} value={turnLive.output} />
      <TpsRow label={t("stats.tps")} tps={avgTps(turnLive)} />

      <div className="border-t border-[var(--color-border)] my-1" />
      {/* 上一次完成轮 */}
      <div className="text-[var(--font-size-sm)] text-[var(--color-muted)]">{t("stats.lastTurn")}</div>
      <StatRow label={t("stats.input2")} value={lastTurn.input} />
      <StatRow label={t("stats.output2")} value={lastTurn.output} />

      <div className="border-t border-[var(--color-border)] my-1" />
      {/* 项目总(持久化 + RPC 校准) */}
      <SectionHead
        icon={<Globe2 className="size-3.5" />}
        title={t("stats.projectTotal")}
        action={
          <button onClick={() => void resetGlobal()} title={t("common.clear")} style={iconBtnStyle}>
            <RotateCcw className="size-3.5" />
          </button>
        }
      />
      <StatRow label={t("stats.input2")} value={globalStats.input} />
      <StatRow label={t("stats.output2")} value={globalStats.output} />
      <StatRow label={t("stats.cacheRead")} value={globalStats.cacheRead} />
      <StatRow label={t("stats.cacheWrite")} value={globalStats.cacheWrite} />
      <StatRow label={t("stats.turns")} value={globalStats.turns} />
      <TpsRow label={t("stats.tps")} tps={avgTps(globalStats)} />

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
      <span className="flex items-center gap-1.5 text-[var(--font-size-sm)] text-[var(--color-muted)]">
        {icon}{title}
      </span>
      {action}
    </div>
  );
}

function StatRow({ label, value, strong }: { label: string; value: number; strong?: boolean }): React.ReactNode {
  return (
    <div className="flex items-center justify-between text-[var(--font-size-sm)]">
      <span className="text-[var(--color-muted)]">{label}</span>
      <span className="font-[var(--font-family-mono)]" style={{ color: "var(--color-fg)", fontWeight: strong ? 600 : 400 }}>
        {value.toLocaleString()}
      </span>
    </div>
  );
}

function TpsRow({ label, tps }: { label: string; tps: number | null }): React.ReactNode {
  return (
    <div className="flex items-center justify-between text-[var(--font-size-sm)]">
      <span className="text-[var(--color-muted)]">{label}</span>
      <span className="font-[var(--font-family-mono)]" style={{ color: "var(--color-fg)" }}>
        {tps == null ? "—" : `${tps} t/s`}
      </span>
    </div>
  );
}

function ContextRow({ label, tokens, window: contextWindow, percent }: {
  label: string; tokens: number | null; window: number; percent: number | null;
}): React.ReactNode {
  const pct = percent ?? (contextWindow > 0 && tokens != null ? Math.round((tokens / contextWindow) * 100) : null);
  return (
    <div className="flex flex-col gap-1 text-[var(--font-size-sm)]">
      <div className="flex items-center justify-between">
        <span className="text-[var(--color-muted)]">{label}</span>
        <span className="font-[var(--font-family-mono)]" style={{ color: "var(--color-fg)" }}>
          {tokens == null ? "—" : `${tokens.toLocaleString()}${contextWindow > 0 ? ` / ${contextWindow.toLocaleString()}` : ""}${pct != null ? ` (${pct}%)` : ""}`}
        </span>
      </div>
      <div style={{ height: 4, borderRadius: 2, background: "var(--color-border)", overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${pct ?? 0}%`, background: "var(--color-primary)", transition: "width 200ms" }} />
      </div>
    </div>
  );
}

const iconBtnStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "center",
  width: "22px", height: "22px", border: "none", borderRadius: "var(--radius-sm)",
  background: "transparent", color: "var(--color-muted)", cursor: "pointer",
};
