// 会话统计的标题栏呈现(titlebar 槽贡献)——上下文条已迁 composer 中段
// (docs/design/context-usage-bar-in-composer.md),本组件只留次级统计(↑↓⚡Σ)。
// 归属:由 timeline 迁至 token-stats(统计领域插件),三处统计展示同归本插件。
// 数据仍读 useSessionStore.stats(双源:文件聚合基线 + 活会话 RPC 真值),
// 本组件零拉取、零刷新时机,store 更新即重渲。
import { useTranslation } from "react-i18next";
import { useSessionStore, type SessionStats } from "@my-harness-desktop/react";
import { HoverTip } from "./hover-tip";

/** 次级统计行:上传/下载/TPS/总消耗。
 *  三级诚实态:stats null(pi 没起)整行弱化全 —。 */
function StatsInline({ stats }: { stats: SessionStats | null }): React.ReactNode {
  const { t } = useTranslation();
  const tok = stats?.tokens;
  // 内核口径 input 只是未命中缓存的新 token(实测每轮个位数),prompt 主体走
  // cacheRead/cacheWrite——"上传"必须是三项之和,否则差四个数量级。
  const promptTotal = tok ? tok.input + tok.cacheRead + tok.cacheWrite : 0;
  const fmt = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const placeholder = !stats;
  const val = (n: number | undefined | null): string => (placeholder || n == null ? "—" : fmt(n));
  // 每项:符号 + 值,固定 min-width 对齐(占位 — 和真实数字宽度不同,固定宽避免跳)
  //
  // ⚠ `aria-label` 是**必需的**,不是装饰(实测缺陷修复,勿删):
  //   这四项的可访问名此前**只有裸字形**(`↑`/`↓`/`⚡`/`Σ`),屏幕阅读器读到的是"上箭头 破折号",
  //   而字形含义的唯一解释处是 HoverTip 的气泡文案(`t("shell.tokensUp")` 等)。那个气泡由 Radix
  //   Tooltip 驱动,`Tooltip.Trigger asChild` 落在一个**没有 tabIndex 的 span** 上,于是键盘用户
  //   永远无法聚焦它、气泡永远打不开——含义对非鼠标用户完全不可达。
  //   加 `aria-label={title}` 把同一份翻译文案变成元素的可访问名,AT 直接读到"上传 tokens: 1.2k"。
  //   **不在共用组件 HoverTip 里统一加**:另一个消费者 context-usage-bar 的 child 有可见文本
  //   (`45%`),用 aria-label 覆盖它会违反 WCAG 2.5.3「Label in Name」(语音输入用户说"45%"匹配不上)。
  //   所以修在缺名的这个调用点,而不是一刀切。
  //   同一个 app 里 12 个图标按钮都有 aria-label(收藏/Review/工具/文件/IM/Tree/统计…),
  //   唯独这四项没有——是内部不一致(漂移),不是有意的取舍。
  const Item = ({ sym, v, title }: { sym: string; v: string; title: string }): React.ReactNode => (
    <HoverTip text={title}>
      {/* ⚠ r43 修正：`aria-label` 挂在**无 role 的 span** 上是不可靠的 —— ARIA 1.2 明确
          **不支持在 `role=generic` 上使用 aria-label**，各浏览器/读屏实现不一，
          很可能被忽略（那样 AT 只读到 "↑ 1.2k"，而不是这里想给的 "上传 tokens: 1.2k"）。
          改用 `role="img"`：这是"符号 + 文本作为一个整体朗读"的既定模式，
          且 role=img 的子节点对 AT 完全不透明（内层符号本来就已 aria-hidden），
          于是可访问名稳定等于 aria-label。
          上一轮的两条判断仍然成立、不变：① 修在缺名的这个调用点而不是一刀切进 HoverTip
          （另一个消费者 context-usage-bar 的 child 有可见文本 `45%`，覆盖它会违反
          WCAG 2.5.3「Label in Name」）；② 这四项曾有而 12 个图标按钮都有 aria-label，
          是内部漂移不是有意取舍。 */}
      <span role="img" aria-label={title} className="inline-flex items-center gap-1 min-w-[44px] shrink-0"><span aria-hidden="true" className="font-[var(--font-family-sans)]">{sym}</span><span className="tabular-nums">{v}</span></span>
    </HoverTip>
  );
  return (
    <div className="flex items-center gap-2 text-[length:var(--font-size-xs)] text-[var(--color-muted)] font-[var(--font-family-mono)] min-w-0" style={{ opacity: placeholder ? 0.4 : 1 }}>
      <div className="flex items-center gap-2 opacity-70">
        <Item sym="↑" v={val(promptTotal)} title={`${t("shell.tokensUp")}: ${val(promptTotal)}`} />
        <Item sym="↓" v={val(tok?.output)} title={`${t("shell.tokensDown")}: ${val(tok?.output)}`} />
        <Item sym="⚡" v={placeholder ? "—" : (stats?.tps != null ? stats.tps.toFixed(1) : "—")} title={`${t("shell.tpsTitle")}: ${placeholder || stats?.tps == null ? "—" : t("shell.tpsValue", { value: stats!.tps.toFixed(1) })}`} />
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
