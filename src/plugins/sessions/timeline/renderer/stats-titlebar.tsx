// 会话统计的标题栏呈现(titlebar 槽贡献)——上下文条已迁 composer 中段
// (docs/design/context-usage-bar-in-composer.md),本组件只留次级统计(↑↓⚡Σ)。
// 数据仍读 useSessionStore.stats(双源:文件聚合基线 + 活会话 RPC 真值),
// 本组件零拉取、零刷新时机,store 更新即重渲。
import { useTranslation } from "react-i18next";
import { useSessionStore, type SessionStats } from "@pi-desktop/react";
import { HoverTip } from "./hover-tip";

/** 次级统计行:上传/下载/TPS/总消耗。
 *  三级诚实态:stats null(pi 没起)整行弱化全 —。 */
function StatsInline({ stats }: { stats: SessionStats | null }): React.ReactNode {
  const { t } = useTranslation();
  const tok = stats?.tokens;
  // 底座口径 input 只是未命中缓存的新 token(实测每轮个位数),prompt 主体走
  // cacheRead/cacheWrite——"上传"必须是三项之和,否则差四个数量级。
  const promptTotal = tok ? tok.input + tok.cacheRead + tok.cacheWrite : 0;
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
      <div className="flex items-center gap-2 opacity-70">
        <Item sym="↑" v={val(promptTotal)} title={`${t("shell.tokensUp")}: ${val(promptTotal)}`} />
        <Item sym="↓" v={val(tok?.output)} title={`${t("shell.tokensDown")}: ${val(tok?.output)}`} />
        <Item sym="⚡" v={placeholder ? "—" : (stats?.tps != null ? stats.tps.toFixed(1) : "—")} title={`${t("shell.tpsTitle")}: ${placeholder || stats?.tps == null ? "—" : `${stats!.tps.toFixed(1)} tokens/秒`}`} />
        <Item sym="Σ" v={val(tok?.total)} title={`${t("shell.totalTitle")}: ${val(tok?.total)}`} />
      </div>
    </div>
  );
}

/** titlebar 槽贡献组件(manifest contributes.titlebar 自动匹配)。 */
export function SessionStatsTitlebar(): React.ReactNode {
  const stats = useSessionStore((s) => s.stats);
  return (
    <div
      className="flex items-center mr-2"
      // @ts-expect-error 拖拽区是 Electron 私有 CSS 属性;统计区禁拖,tooltip 悬停才可靠
      style={{ WebkitAppRegion: "no-drag" }}
    >
      <StatsInline stats={stats} />
    </div>
  );
}
