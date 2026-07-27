// token-stats 插件 renderer —— 右面板"统计"页签(hooks 机制的试金石)。
//
// 证明"事件流即钩子":只用核心默认能力(sessions.onEvent + config),
// 零权限声明、零新 hook 点——订阅 messageEnd 事件提 usage 累加,agentSettled 落盘。
// 右面板页签 keep-alive(forceMount),订阅常驻不丢事件。
//
// ⚠ pi 事件里 usage 的精确字段形状依赖底座版本,extractUsage 做多路径防御;
// 取不到就计 0(展示仍为 0,不报错)——字段确认后只改 extractUsage 一处。
import { useEffect, useRef, useState } from "react";
import { BarChart3, RotateCcw } from "lucide-react";
import { registerSidePanelComponent, usePluginContext, EmptyState } from "@pi-desktop/react";

const PLUGIN_ID = "token-stats";
registerSidePanelComponent("TokenStatsTab", TokenStatsTab);

interface Stats {
  input: number;
  output: number;
  turns: number;
}
const ZERO: Stats = { input: 0, output: 0, turns: 0 };

/** 从 messageEnd 事件负载里多路径挖 usage(底座字段形状未文档化,防御性提取)。 */
function extractUsage(message: unknown): { input: number; output: number } {
  if (!message || typeof message !== "object") return { input: 0, output: 0 };
  const m = message as Record<string, unknown>;
  const usage = (m.usage ?? m.tokenUsage ?? m.tokens) as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== "object") return { input: 0, output: 0 };
  const num = (...keys: string[]): number => {
    for (const k of keys) {
      const v = usage[k];
      if (typeof v === "number") return v;
    }
    return 0;
  };
  return {
    input: num("inputTokens", "input", "input_tokens", "promptTokens"),
    output: num("outputTokens", "output", "output_tokens", "completionTokens"),
  };
}

function TokenStatsTab(): React.ReactNode {
  const ctx = usePluginContext(PLUGIN_ID);
  const [stats, setStats] = useState<Stats>(ZERO);
  const [ready, setReady] = useState(false);
  // 本轮(agentStart→agentSettled)增量,Settled 时并入累计并落盘
  const turnRef = useRef<Stats>({ ...ZERO });
  const statsRef = useRef(stats);
  statsRef.current = stats;

  // 启动读持久化的累计
  useEffect(() => {
    void ctx.config.get<Stats>("totals").then((v) => {
      if (v) setStats(v);
      setReady(true);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 订阅事件流:messageEnd 提 usage,agentSettled 并账 + 落盘
  useEffect(() => {
    const off = ctx.sessions.onEvent((event) => {
      if (event.type === "messageEnd") {
        const u = extractUsage((event as { message?: unknown }).message);
        turnRef.current = {
          input: turnRef.current.input + u.input,
          output: turnRef.current.output + u.output,
          turns: turnRef.current.turns,
        };
      } else if (event.type === "agentSettled" || event.type === "agentEnd") {
        const next: Stats = {
          input: statsRef.current.input + turnRef.current.input,
          output: statsRef.current.output + turnRef.current.output,
          turns: statsRef.current.turns + (turnRef.current.input + turnRef.current.output > 0 ? 1 : 0),
        };
        turnRef.current = { ...ZERO };
        setStats(next);
        void ctx.config.set("totals", next);
      }
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reset = async (): Promise<void> => {
    turnRef.current = { ...ZERO };
    setStats(ZERO);
    await ctx.config.set("totals", ZERO);
  };

  if (!ready) return null;
  const live = turnRef.current;

  return (
    <div className="flex-1 flex flex-col min-h-0 p-3 gap-3 overflow-y-auto">
      <div className="flex items-center justify-between shrink-0">
        <span className="text-[var(--font-size-sm)] text-[var(--color-muted)]">累计 token(持久化)</span>
        <button onClick={() => void reset()} title="清零" style={iconBtnStyle}>
          <RotateCcw className="size-3.5" />
        </button>
      </div>
      <StatRow label="输入 tokens" value={stats.input} />
      <StatRow label="输出 tokens" value={stats.output} />
      <StatRow label="合计" value={stats.input + stats.output} strong />
      <StatRow label="完成轮次" value={stats.turns} />
      <div className="border-t border-[var(--color-border)] my-1" />
      <div className="text-[var(--font-size-sm)] text-[var(--color-muted)]">本轮(进行中)</div>
      <StatRow label="输入 tokens" value={live.input} />
      <StatRow label="输出 tokens" value={live.output} />
      {stats.input + stats.output === 0 && live.input + live.output === 0 && (
        <EmptyState
          icon={<BarChart3 className="size-8" />}
          title="暂无数据"
          description="发消息跑一轮后自动累计"
        />
      )}
    </div>
  );
}

function StatRow({ label, value, strong }: { label: string; value: number; strong?: boolean }): React.ReactNode {
  return (
    <div className="flex items-center justify-between text-[var(--font-size-sm)]">
      <span className="text-[var(--color-muted)]">{label}</span>
      <span
        className="font-[var(--font-family-mono)]"
        style={{ color: "var(--color-fg)", fontWeight: strong ? 600 : 400 }}
      >
        {value.toLocaleString()}
      </span>
    </div>
  );
}

const iconBtnStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "center",
  width: "22px", height: "22px", border: "none", borderRadius: "var(--radius-sm)",
  background: "transparent", color: "var(--color-muted)", cursor: "pointer",
};
