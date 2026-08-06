// 会话统计的标题栏呈现(titlebar 槽贡献)——从 composer 迁出:
// 数据仍读 useSessionStore.stats(双源:文件聚合基线 + 活会话 RPC 真值),
// 本组件零拉取、零刷新时机,store 更新即重渲。
import * as Tooltip from "@radix-ui/react-tooltip";
import { useTranslation } from "react-i18next";
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
 *  stats null(pi 没起)时占位 —— + 整行弱化,表示"未运行"。 */
function StatsInline({ stats, contextWindow }: {
  stats: SessionStats | null;
  contextWindow: number;
}): React.ReactNode {
  const { t } = useTranslation();
  const ctx = stats?.contextUsage;
  const used = ctx?.tokens ?? 0;
  // 文件聚合基线的 contextWindow 是 0(文件无此字段)=未知,fallback 到当前模型配置窗口
  const limit = ctx?.contextWindow ? ctx.contextWindow : contextWindow;
  const pct = ctx?.percent ?? (limit > 0 ? Math.min(100, (used / limit) * 100) : 0);
  const tok = stats?.tokens;
  const fmt = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const placeholder = !stats;
  const val = (n: number | undefined | null): string => (placeholder || n == null ? "—" : fmt(n));
  // 每项:符号 + 值,固定 min-width 对齐(占位 — 和真实数字宽度不同,固定宽避免跳)
  const Item = ({ sym, v, title }: { sym: string; v: string; title: string }): React.ReactNode => (
    <HoverTip text={title}>
      <span className="inline-flex items-center gap-1 min-w-[44px] shrink-0"><span className="font-[var(--font-family-sans)]">{sym}</span><span className="tabular-nums">{v}</span></span>
    </HoverTip>
  );
  return (
    <div className="flex items-center gap-2 text-[length:var(--font-size-xs)] text-[var(--color-muted)] font-[var(--font-family-mono)] min-w-0" style={{ opacity: placeholder ? 0.4 : 1 }}>
      {/* 上下文比例条(主视觉) */}
      <HoverTip text={t("shell.contextUsed", { used: val(used), limit: val(limit) })}>
        <div className="flex items-center gap-1 shrink-0">
          <div className="w-12 h-1 rounded-full bg-[var(--color-border)] overflow-hidden">
            <div className="h-full rounded-full" style={{ width: `${pct}%`, background: pct > 80 ? "var(--color-accent-warning)" : "var(--color-primary)" }} />
          </div>
          <span className="min-w-[28px] tabular-nums">{placeholder ? "—" : `${Math.round(pct)}%`}</span>
        </div>
      </HoverTip>
      <span className="opacity-30">·</span>
      {/* 次统计:各项 min-w 对齐,占位真实都整齐 */}
      <div className="flex items-center gap-2 opacity-70">
        <Item sym="↑" v={val(tok?.input)} title={`${t("shell.tokensUp")}: ${val(tok?.input)}`} />
        <Item sym="↓" v={val(tok?.output)} title={`${t("shell.tokensDown")}: ${val(tok?.output)}`} />
        <Item sym="⚡" v={placeholder ? "—" : (stats?.tps != null ? stats.tps.toFixed(1) : "—")} title={`${t("shell.tpsTitle")}: ${placeholder || stats?.tps == null ? "—" : `${stats!.tps.toFixed(1)} tokens/秒`}`} />
        <Item sym="Σ" v={val(tok?.total)} title={`${t("shell.totalTitle")}: ${val(tok?.total)}`} />
      </div>
    </div>
  );
}

/** titlebar 槽贡献组件(manifest contributes.titlebar 自动匹配)。
 *  contextWindow fallback 取投影快照的当前模型;文件基线(快照未至)时比例条按 0 占位。 */
export function SessionStatsTitlebar(): React.ReactNode {
  const stats = useSessionStore((s) => s.stats);
  const contextWindow = useSessionStore((s) => s.snapshot?.state.model?.contextWindow ?? 0);
  return (
    <Tooltip.Provider>
      <div
        className="flex items-center mr-2"
        // @ts-expect-error 拖拽区是 Electron 私有 CSS 属性;统计区禁拖,tooltip 悬停才可靠
        style={{ WebkitAppRegion: "no-drag" }}
      >
        <StatsInline stats={stats} contextWindow={contextWindow} />
      </div>
    </Tooltip.Provider>
  );
}
