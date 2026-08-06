// 会话统计的标题栏呈现(titlebar 槽贡献)——从 composer 迁出:
// 数据读 useSessionStore.stats(双源:文件聚合基线 + 活会话 RPC 真值),
// 本组件零拉取、零刷新时机,store 更新即重渲。
// 会话绑定(设计 session-stats-alignment.md §4):stats null = 会话没有统计 →
// 整个组件不渲染,无幽灵占位;可见性从数据在场涌现,不加声明开关。
import * as Tooltip from "@radix-ui/react-tooltip";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { useSessionStore, type SessionStats } from "@pi-desktop/react";

/** 悬停 1s 延迟浮出的解释气泡。
 *  原生 title 在 Electron/Chromium 里时延不可控且经常不弹;
 *  用 Radix Tooltip 固定 delayDuration=1000,portal/边界翻转/加热区交接全由成熟包代劳。 */
function HoverTip({ text, children }: { text: string; children: React.ReactNode }): React.ReactNode {
  return (
    <Tooltip.Root delayDuration={1000}>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content side="bottom" sideOffset={6} style={tipStyle}>
          {text}
          <Tooltip.Arrow style={{ fill: "var(--color-border)" }} width={10} height={5} />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

const tipStyle: React.CSSProperties = {
  background: "var(--color-surface)",
  color: "var(--color-fg)",
  border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-md)",
  boxShadow: "var(--shadow-lg)",
  padding: "6px 12px",
  fontSize: "var(--font-size-sm)",
  lineHeight: 1.6,
  fontFamily: "var(--font-family-sans)",
  maxWidth: "280px",
  whiteSpace: "normal",
  zIndex: 99999,
};

/** 统计行:上下文比例条 + 上传/下载/TPS/总消耗。
 *  比例条渲染判据一条:percent 算不出来(contextUsage 缺失 / tokens 为 null 的
 *  诚实未知)→ 不渲染,显示层不区分不可知的来路(设计 §4.1);累计项照常。
 *  refreshing:stats RPC 在飞中,比例条左侧挂旋转标识;常驻占位(opacity 切换)
 *  而非条件挂载,出现/消失不推动布局。 */
function StatsInline({ stats, contextWindow, refreshing }: {
  stats: SessionStats;
  contextWindow: number;
  refreshing: boolean;
}): React.ReactNode {
  const { t } = useTranslation();
  const ctx = stats.contextUsage;
  const used = ctx?.tokens ?? 0;
  // 文件聚合基线的 contextWindow 是 0(文件无此字段)=未知,fallback 到当前模型配置窗口
  const limit = ctx?.contextWindow ? ctx.contextWindow : contextWindow;
  const pct = ctx?.percent ?? (limit > 0 ? Math.min(100, (used / limit) * 100) : 0);
  const showBar = ctx != null && ctx.tokens != null;
  const tok = stats.tokens;
  // 底座口径 input 只是未命中缓存的新 token(实测每轮个位数),prompt 主体走
  // cacheRead/cacheWrite——"上传"必须是三项之和,否则差四个数量级。
  const promptTotal = tok.input + tok.cacheRead + tok.cacheWrite;
  const fmt = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const val = (n: number | undefined | null): string => (n == null ? "—" : fmt(n));
  // 每项:符号 + 值,固定 min-width 对齐避免数字变化时跳动
  const Item = ({ sym, v, title }: { sym: string; v: string; title: string }): React.ReactNode => (
    <HoverTip text={title}>
      <span className="inline-flex items-center gap-1 min-w-[44px] shrink-0"><span className="font-[var(--font-family-sans)]">{sym}</span><span className="tabular-nums">{v}</span></span>
    </HoverTip>
  );
  return (
    <div className="flex items-center gap-2 text-[length:var(--font-size-xs)] text-[var(--color-muted)] font-[var(--font-family-mono)] min-w-0">
      {/* 刷新标识(比例条左侧):RPC 在飞时旋转显现;opacity 切换不推动布局 */}
      {showBar && (
        <Loader2
          className="size-3 shrink-0 animate-spin"
          style={{ opacity: refreshing ? 0.9 : 0, transition: "opacity 0.15s" }}
        />
      )}
      {/* 上下文比例条(主视觉):percent 算不出来时整条不渲染 */}
      {showBar && (
        <HoverTip text={t("shell.contextUsed", { used: val(used), limit: val(limit) })}>
          <div className="flex items-center gap-1 shrink-0">
            <div className="w-12 h-1 rounded-full bg-[var(--color-border)] overflow-hidden">
              <div className="h-full rounded-full" style={{ width: `${pct}%`, background: pct > 80 ? "var(--color-accent-warning)" : "var(--color-primary)" }} />
            </div>
            <span className="min-w-[28px] tabular-nums">{`${Math.round(pct)}%`}</span>
          </div>
        </HoverTip>
      )}
      {showBar && <span className="opacity-30">·</span>}
      {/* 次统计:各项 min-w 对齐 */}
      <div className="flex items-center gap-2 opacity-70">
        <Item sym="↑" v={val(promptTotal)} title={`${t("shell.tokensUp")}: ${val(promptTotal)}`} />
        <Item sym="↓" v={val(tok.output)} title={`${t("shell.tokensDown")}: ${val(tok.output)}`} />
        <Item sym="⚡" v={stats.tps != null ? stats.tps.toFixed(1) : "—"} title={`${t("shell.tpsTitle")}: ${stats.tps == null ? "—" : `${stats.tps.toFixed(1)} tokens/秒`}`} />
        <Item sym="Σ" v={val(tok.total)} title={`${t("shell.totalTitle")}: ${val(tok.total)}`} />
      </div>
    </div>
  );
}

/** titlebar 槽贡献组件(manifest contributes.titlebar 自动匹配)。
 *  stats null(未打开会话/新对话/空会话)→ 不渲染;contextWindow fallback
 *  取投影快照的当前模型(文件基线 contextWindow=0 时兜底)。 */
export function SessionStatsTitlebar(): React.ReactNode {
  const stats = useSessionStore((s) => s.stats);
  const refreshing = useSessionStore((s) => s.statsRefreshing);
  const contextWindow = useSessionStore((s) => s.snapshot?.state.model?.contextWindow ?? 0);
  if (!stats) return null;
  return (
    <Tooltip.Provider>
      <div
        className="flex items-center mr-2"
        // @ts-expect-error 拖拽区是 Electron 私有 CSS 属性;统计区禁拖,tooltip 悬停才可靠
        style={{ WebkitAppRegion: "no-drag" }}
      >
        <StatsInline stats={stats} contextWindow={contextWindow} refreshing={refreshing} />
      </div>
    </Tooltip.Provider>
  );
}
