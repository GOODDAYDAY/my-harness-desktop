// 上下文占用条:比例条 + 百分比 + tooltip。自订阅 useSessionStore(共享 store 只读),
// 零 props——位置无关,挂哪都能用(当前经 composerStats 槽挂 composer 中段思考控件右侧)。
// 归属:由 timeline 迁至 token-stats(统计领域插件),timeline 只提供 composerStats 挂载点。
// 逻辑与迁移前 stats-titlebar 的上下文条逐条一致:三级诚实态、>80% 警告色、
// 窗口 fallback 到模型配置。设计 docs/design/context-usage-bar-in-composer.md。
import { useTranslation } from "react-i18next";
import { useSessionStore } from "@my-harness-desktop/react";
import { HoverTip } from "./hover-tip";

/** 上下文比例条(主视觉):pct null(未知)时空条 + —,不冒充 0%(底座 TUI 同样显示 "?" 而非 0%)。
 *  三级诚实态:stats null(pi 没起)弱化;used/limit 任一未知(压缩后待测、
 *  窗口未至)空条 + "—"——未知不显示成 0%。 */
export function ContextUsageBar(): React.ReactNode {
  const { t } = useTranslation();
  const stats = useSessionStore((s) => s.stats);
  const contextWindow = useSessionStore((s) => s.snapshot?.state.model?.contextWindow ?? 0);
  const ctx = stats?.contextUsage;
  const used = ctx?.tokens ?? null;
  // 文件聚合基线的 contextWindow 是 0(文件无此字段)=未知,fallback 到当前模型配置窗口
  const limit = ctx?.contextWindow ? ctx.contextWindow : contextWindow;
  const known = stats != null && used != null && limit > 0;
  const pct = known ? (ctx?.percent ?? Math.min(100, (used / limit) * 100)) : null;
  const fmt = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const placeholder = !stats;
  const val = (n: number | undefined | null): string => (placeholder || n == null ? "—" : fmt(n));
  return (
    <HoverTip text={t("shell.contextUsed", { used: val(used), limit: val(limit > 0 ? limit : null) })}>
      <div className="flex items-center gap-1 shrink-0" style={{ opacity: placeholder ? 0.4 : 1 }}>
        <div className="w-12 h-1 rounded-full bg-[var(--color-border)] overflow-hidden">
          <div className="h-full rounded-full" style={{ width: `${pct ?? 0}%`, background: pct != null && pct > 80 ? "var(--color-accent-warning)" : "var(--color-primary)" }} />
        </div>
        <span className="min-w-[28px] tabular-nums">{pct != null ? `${Math.round(pct)}%` : "—"}</span>
      </div>
    </HoverTip>
  );
}
