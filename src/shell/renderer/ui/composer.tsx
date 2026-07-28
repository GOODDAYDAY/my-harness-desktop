// pi.ui Composer —— ChatGPT 式药丸输入区。
//
// 形态对照 chatgpt.com:rounded-[28px] 大药丸、surface 底、shadow 浮起、
// 左侧 "+" 圆形 ghost 按钮,右侧语音占位 + 圆形实心发送键(ArrowUp)。
// 底部工具栏三段:[+]/children · (中段:模型+思考强度 dropdown · 统计行) · [语音][发送]。
// 模型+统计由调用方拉数据传入(composer 是纯 UI,不依赖 session)。
import { Plus, Mic, ArrowUp, Square, ChevronDown, Check } from "lucide-react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useTranslation } from "react-i18next";
import type { ModelInfo, SessionStats } from "@pi-desktop/react";

/** 思考强度 level 值 → i18n key 后缀。 */
const LEVEL_KEY: Record<string, string> = {
  off: "shell.levelOff", minimal: "shell.levelMinimal", low: "shell.levelLow",
  medium: "shell.levelMedium", high: "shell.levelHigh", xhigh: "shell.levelXhigh",
};

export interface ComposerProps
  extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "onChange" | "value" | "onSubmit"> {
  value: string;
  onValueChange: (v: string) => void;
  onSubmit: () => void | Promise<void>;
  children?: React.ReactNode;
  sending?: boolean;
  streaming?: boolean;
  onStop?: () => void;
  placeholder?: string;
  /** 模型 + 统计(由调用方拉数据传入;不传则不渲染中段)。 */
  models?: ModelInfo[];
  levels?: string[];
  currentModel?: ModelInfo | null;
  currentLevel?: string;
  stats?: SessionStats | null;
  onPickModel?: (m: ModelInfo) => void;
  onPickLevel?: (l: string) => void;
}

const circleBtn = (enabled: boolean): React.CSSProperties => ({
  display: "flex", alignItems: "center", justifyContent: "center",
  width: "32px", height: "32px", borderRadius: "50%", border: "none", flexShrink: 0,
  background: "transparent", color: "var(--color-muted)", cursor: enabled ? "pointer" : "default",
});

export function Composer({
  value,
  onValueChange,
  onSubmit,
  children,
  sending = false,
  streaming = false,
  onStop,
  placeholder,
  models,
  levels,
  currentModel,
  currentLevel,
  stats,
  onPickModel,
  onPickLevel,
  ...rest
}: ComposerProps): React.ReactNode {
  const { t } = useTranslation();
  const canSend = value.trim().length > 0 && !sending && !streaming;
  const ph = placeholder ?? t("shell.composerPlaceholder");
  const levelLabel = (l: string): string => (LEVEL_KEY[l] ? t(LEVEL_KEY[l]) : l);
  const hasMiddle = !!(models || stats);

  return (
    <form
      className="flex flex-col w-full"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSend) void onSubmit();
      }}
    >
      <div
        className="flex flex-col w-full rounded-[28px] px-2 py-1.5"
        style={{
          background: "var(--color-surface)",
          boxShadow: "var(--shadow-md)",
          border: "1px solid var(--color-border)",
        }}
      >
        {/* textarea:自适高,封顶 max-h-64,无边框(容器已圆) */}
        <textarea
          {...rest}
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (canSend) void onSubmit();
            }
          }}
          placeholder={ph}
          rows={1}
          className="resize-none outline-none bg-transparent w-full px-3 pt-2.5 pb-1 max-h-64 overflow-auto scrollbar-hidden text-[length:var(--font-size-base)] leading-7 font-[var(--font-family-sans)] text-[var(--color-fg)] placeholder:text-[var(--color-muted)]"
        />

        {/* 底部工具栏:三段 —— 左 [+] / 中(模型+思考 · 统计) / 右 [语音][发送] */}
        <div className="flex justify-between items-center gap-2">
          <div className="flex items-center gap-1 shrink-0">
            <button type="button" style={circleBtn(true)} title={t("shell.attachment")} tabIndex={-1}>
              <Plus className="size-5" />
            </button>
            {children}
          </div>

          {/* 中段:模型+思考强度(左半)· 统计行(右半)。无数据时不占位。 */}
          {hasMiddle && (
            <div className="flex-1 flex items-center justify-between min-w-0 gap-2">
              {/* 左半:模型 + 思考强度 dropdown */}
              <div className="flex items-center gap-1 min-w-0">
                {models && onPickModel && currentModel && (
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger asChild>
                      <button className="flex items-center gap-1 px-1.5 py-0 rounded-full text-[13px] text-[var(--color-fg)] bg-transparent border-none cursor-pointer max-w-[160px]">
                        <span className="truncate">{currentModel.name || currentModel.id}</span>
                        <ChevronDown className="size-3 shrink-0 text-[var(--color-muted)]" />
                      </button>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content align="start" sideOffset={4} style={menuStyle} className="max-h-72 overflow-y-auto">
                        {[...groupByProvider(models)].map(([provider, ms]) => (
                          <div key={provider}>
                            <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-[var(--color-muted)]">{provider}</div>
                            {ms.map((m) => (
                              <DropdownMenu.Item key={`${m.provider}/${m.id}`} onSelect={() => onPickModel(m)} style={itemStyle}>
                                <span className="flex-1 truncate">{m.name || m.id}</span>
                                {currentModel.provider === m.provider && currentModel.id === m.id && <Check className="size-3.5" />}
                              </DropdownMenu.Item>
                            ))}
                          </div>
                        ))}
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>
                )}
                {levels && onPickLevel && currentLevel && (
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger asChild>
                      <button className="flex items-center gap-1 px-1.5 py-0 rounded-full text-[13px] text-[var(--color-muted)] bg-transparent border-none cursor-pointer">
                        <span className="truncate">{levelLabel(currentLevel)}</span>
                        <ChevronDown className="size-3" />
                      </button>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content align="start" sideOffset={4} style={menuStyle}>
                        {levels.map((l) => (
                          <DropdownMenu.Item key={l} onSelect={() => onPickLevel(l)} style={itemStyle}>
                            <span className="flex-1">{levelLabel(l)}</span>
                            {currentLevel === l && <Check className="size-3.5" />}
                          </DropdownMenu.Item>
                        ))}
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>
                )}
              </div>

              {/* 右半:统计行 */}
              {stats && <StatsInline stats={stats} contextWindow={currentModel?.contextWindow ?? 0} effort={currentLevel || "off"} />}
            </div>
          )}

          <div className="flex items-center gap-1.5 shrink-0">
            <button type="button" style={circleBtn(true)} title={t("shell.voice")} tabIndex={-1}>
              <Mic className="size-4.5" />
            </button>
            {streaming ? (
              <button
                type="button"
                onClick={onStop}
                aria-label={t("shell.stop")}
                title={t("shell.stop")}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: "32px", height: "32px", borderRadius: "50%", border: "none", flexShrink: 0,
                  background: "var(--color-primary)", color: "var(--color-primary-fg)",
                  cursor: "pointer",
                }}
              >
                <Square className="size-3.5" fill="currentColor" />
              </button>
            ) : (
              <button
                type="submit"
                disabled={!canSend}
                aria-label={t("shell.send")}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: "32px", height: "32px", borderRadius: "50%", border: "none", flexShrink: 0,
                  background: canSend ? "var(--color-primary)" : "var(--color-border)",
                  color: canSend ? "var(--color-primary-fg)" : "var(--color-muted)",
                  cursor: canSend ? "pointer" : "not-allowed",
                  transition: "background 0.15s",
                }}
              >
                <ArrowUp className="size-4.5" strokeWidth={2.5} />
              </button>
            )}
          </div>
        </div>
      </div>
    </form>
  );
}

/** 统计行(右半):上下文比例条 + 上传/下载/cache/TPS/effort/总消耗,右对齐,渐淡。 */
function StatsInline({ stats, contextWindow, effort }: {
  stats: SessionStats;
  contextWindow: number;
  effort: string;
}): React.ReactNode {
  const { t } = useTranslation();
  const ctx = stats.contextUsage;
  const used = ctx?.tokens ?? 0;
  const limit = ctx?.contextWindow ?? contextWindow;
  const pct = ctx?.percent ?? (limit > 0 ? Math.min(100, (used / limit) * 100) : 0);
  const tok = stats.tokens;
  const fmt = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  return (
    <div className="flex items-center gap-1.5 text-[11px] text-[var(--color-muted)] font-[var(--font-family-mono)] min-w-0">
      {/* 上下文比例条(主视觉) */}
      <div className="flex items-center gap-1 shrink-0" title={t("shell.contextUsed", { used: fmt(used), limit: fmt(limit) })}>
        <div className="w-12 h-1 rounded-full bg-[var(--color-border)] overflow-hidden">
          <div className="h-full rounded-full" style={{ width: `${pct}%`, background: pct > 80 ? "var(--color-accent-warning)" : "var(--color-primary)" }} />
        </div>
        <span>{Math.round(pct)}%</span>
      </div>
      {/* 次统计:渐淡(opacity 0.7) */}
      <div className="flex items-center gap-1.5 opacity-70">
        <span title={t("shell.tokensUp")}>↑{fmt(tok?.input ?? 0)}</span>
        <span title={t("shell.tokensDown")}>↓{fmt(tok?.output ?? 0)}</span>
        <span title={t("shell.cache")}>⇄{fmt((tok?.cacheRead ?? 0) + (tok?.cacheWrite ?? 0))}</span>
        {stats.tps != null && <span title={t("shell.tpsTitle")}>⚡{stats.tps.toFixed(1)}</span>}
        <span title={t("shell.effortTitle")}>{effort}</span>
        <span title={t("shell.totalTitle")}>Σ{fmt(tok?.total ?? 0)}</span>
      </div>
    </div>
  );
}

/** 模型按供应商分组。 */
function groupByProvider(models: ModelInfo[]): Map<string, ModelInfo[]> {
  const m = new Map<string, ModelInfo[]>();
  for (const mo of models) {
    if (!m.has(mo.provider)) m.set(mo.provider, []);
    m.get(mo.provider)!.push(mo);
  }
  return m;
}

const menuStyle: React.CSSProperties = {
  minWidth: "200px",
  background: "var(--color-surface)",
  border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-md)",
  boxShadow: "var(--shadow-lg)",
  padding: "4px",
  zIndex: 99999,
};
const itemStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: "6px",
  padding: "5px 10px", borderRadius: "var(--radius-sm)",
  fontSize: "13px", color: "var(--color-fg)",
  fontFamily: "var(--font-family-sans)",
  cursor: "pointer", outline: "none",
};
