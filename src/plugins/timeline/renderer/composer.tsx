// pi.ui Composer —— ChatGPT 式药丸输入区。
//
// 形态对照 chatgpt.com:rounded-[28px] 大药丸、surface 底、shadow 浮起、
// 左侧 "+" 圆形 ghost 按钮,右侧语音占位 + 圆形实心发送键(ArrowUp)。
// 底部工具栏三段:[+]/children · (中段:模型+思考强度 dropdown · 统计行) · [语音][发送]。
// 模型+统计由调用方拉数据传入(composer 是纯 UI,不依赖 session)。
import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { Plus, Mic, ArrowUp, Square, ChevronDown, Check, Brain } from "lucide-react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Tooltip from "@radix-ui/react-tooltip";
import { useTranslation } from "react-i18next";
import type { ModelInfo, SessionStats, CommandItem } from "@pi-desktop/react";

/** 思考强度 level 值 → i18n key 后缀。 */
const LEVEL_KEY: Record<string, string> = {
  off: "shell.levelOff", minimal: "shell.levelMinimal", low: "shell.levelLow",
  medium: "shell.levelMedium", high: "shell.levelHigh", xhigh: "shell.levelXhigh",
};

const SOURCE_BADGE: Record<string, { color: string; label: string }> = {
  skill: { color: "var(--color-accent-success)", label: "skill" },
  extension: { color: "var(--color-primary)", label: "ext" },
  prompt: { color: "var(--color-accent-warning)", label: "prompt" },
};

const MAX_VISIBLE = 8;

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
  commands?: CommandItem[];
}

function SlashPopup({ matches, selectedIndex, onSelect, onHover, position }: {
  matches: CommandItem[];
  selectedIndex: number;
  onSelect: (cmd: CommandItem) => void;
  onHover: (i: number) => void;
  position: { top: number; left: number };
}): React.ReactNode {
  return createPortal(
    <div style={{ position: "fixed", top: position.top, left: position.left, transform: "translateY(-100%)", ...menuStyle, maxHeight: `${MAX_VISIBLE * 32 + 8}px`, overflowY: "auto" }}>
      {matches.map((cmd, i) => {
        const badge = SOURCE_BADGE[cmd.source] ?? SOURCE_BADGE.extension;
        return (
          <div key={cmd.name} onMouseDown={(e) => { e.preventDefault(); onSelect(cmd); }} onMouseEnter={() => onHover(i)} style={{ ...itemStyle, background: i === selectedIndex ? "var(--color-surface)" : "transparent" }}>
            <span style={{ fontSize: "10px", fontWeight: 500, color: badge.color, border: `1px solid ${badge.color}`, borderRadius: "var(--radius-sm)", padding: "0 4px", lineHeight: "16px", flexShrink: 0 }}>{badge.label}</span>
            <span style={{ fontFamily: "var(--font-family-mono)", fontSize: "13px", color: "var(--color-fg)" }}>/{cmd.name}</span>
            {cmd.description && <span style={{ fontSize: "11px", color: "var(--color-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{cmd.description}</span>}
          </div>
        );
      })}
    </div>,
    document.body,
  );
}

/** 悬停 1s 延迟浮出的解释气泡。
 *  原生 title 在 Electron/Chromium 里时延不可控且经常不弹;
 *  用 Radix Tooltip 固定 delayDuration=1000,portal/边界翻转/加热区交接全由成熟包代劳。 */
function HoverTip({ text, children }: { text: string; children: React.ReactNode }): React.ReactNode {
  return (
    <Tooltip.Root delayDuration={1000}>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content side="top" sideOffset={6} style={tipStyle}>
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
  fontSize: "12px",
  lineHeight: 1.6,
  fontFamily: "var(--font-family-sans)",
  maxWidth: "280px",
  whiteSpace: "normal",
  zIndex: 99999,
};

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
  commands,
  ...rest
}: ComposerProps): React.ReactNode {
  const { t } = useTranslation();
  const canSend = value.trim().length > 0 && !sending && !streaming;
  const ph = placeholder ?? t("shell.composerPlaceholder");
  const levelLabel = (l: string): string => (LEVEL_KEY[l] ? t(LEVEL_KEY[l]) : l);
  const hasMiddle = !!(models?.length || levels?.length);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const [popupPos, setPopupPos] = useState<{ top: number; left: number } | null>(null);

  const slashQuery = useMemo((): string | null => {
    if (!value.startsWith("/")) return null;
    const nl = value.indexOf("\n");
    const firstLine = nl === -1 ? value : value.slice(0, nl);
    return firstLine.slice(1);
  }, [value]);

  const slashMatches = useMemo((): CommandItem[] => {
    if (slashQuery === null || !commands?.length) return [];
    const q = slashQuery.toLowerCase();
    if (q === "") return commands.slice(0, MAX_VISIBLE);
    return commands.filter((c) => c.name.toLowerCase().includes(q)).slice(0, MAX_VISIBLE);
  }, [slashQuery, commands]);

  useEffect(() => {
    setSlashOpen(slashMatches.length > 0 && slashQuery !== null);
    setSlashIndex(0);
  }, [slashMatches, slashQuery]);

  useEffect(() => {
    if (slashOpen && textareaRef.current) {
      const rect = textareaRef.current.getBoundingClientRect();
      setPopupPos({ top: rect.top - 8, left: rect.left });
    }
  }, [slashOpen]);

  const insertCommand = useCallback((cmd: CommandItem) => {
    const ta = textareaRef.current;
    const text = "/" + cmd.name;
    if (!ta) { onValueChange(text); setSlashOpen(false); return; }
    const pos = ta.selectionStart;
    const before = value.slice(0, pos);
    const idx = before.lastIndexOf("/");
    if (idx === -1) { onValueChange(text); setSlashOpen(false); return; }
    onValueChange(value.slice(0, idx) + text + value.slice(pos));
    setSlashOpen(false);
    requestAnimationFrame(() => { ta.focus(); ta.setSelectionRange(idx + text.length, idx + text.length); });
  }, [value, onValueChange]);


  return (
    <form
      className="flex flex-col w-full"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSend) void onSubmit();
      }}
    >
      {slashOpen && popupPos && slashMatches.length > 0 && (
        <SlashPopup matches={slashMatches} selectedIndex={slashIndex} onSelect={insertCommand} onHover={setSlashIndex} position={popupPos} />
      )}
      <div
        className="flex flex-col w-full rounded-[16px] px-2 py-2"
        style={{
          background: "var(--color-surface)",
          boxShadow: "var(--shadow-md)",
          border: "1px solid var(--color-border)",
        }}
      >
        <textarea
          {...rest}
          ref={textareaRef}
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          onKeyDown={(e) => {
            if (slashOpen && slashMatches.length > 0) {
              if (e.key === "ArrowDown") { e.preventDefault(); setSlashIndex((i) => (i + 1) % slashMatches.length); return; }
              if (e.key === "ArrowUp") { e.preventDefault(); setSlashIndex((i) => (i - 1 + slashMatches.length) % slashMatches.length); return; }
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); insertCommand(slashMatches[slashIndex]); return; }
              if (e.key === "Tab" && !e.shiftKey) { e.preventDefault(); insertCommand(slashMatches[slashIndex]); return; }
              if (e.key === "Escape") { e.preventDefault(); setSlashOpen(false); return; }
            }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (canSend) void onSubmit();
            }
          }}
          onBlur={() => { setTimeout(() => setSlashOpen(false), 150); }}
          placeholder={ph}
          rows={2}
          className="resize-none outline-none bg-transparent w-full px-3 pt-3.5 pb-2 field-sizing-content max-h-[10lh] overflow-auto scrollbar-hidden text-[length:var(--font-size-base)] leading-7 font-[var(--font-family-sans)] text-[var(--color-fg)] placeholder:text-[var(--color-muted)]"
        />

        {/* 底部工具栏:三段 —— 左 [+] / 中(模型+思考 · 统计) / 右 [语音][发送] */}
        <div className="flex justify-between items-center gap-3 mt-2.5">
          <div className="flex items-center gap-1 shrink-0">
            <button type="button" style={circleBtn(true)} title={t("shell.attachment")} tabIndex={-1}>
              <Plus className="size-5" />
            </button>
            {children}
          </div>

          {/* 中段:模型+思考强度+开关(第一组)· 统计行(第二组)。
              flex-wrap:宽屏同行(统计 ml-auto 推右);窄屏统计换行到第二行左对齐。 */}
          {hasMiddle && (
            <div className="flex-1 flex flex-wrap items-center gap-2 min-w-0">
              {/* 第一组:模型 + 思考强度 + 思考开关 */}
              <div className="flex items-center gap-1.5 min-w-0">
                {/* 模型 dropdown:有清单就画(恒定展示);没当前值占位 — */}
                {models && onPickModel && models.length > 0 && (
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger asChild>
                      <button className="flex items-center gap-1 px-1.5 py-0 rounded-full text-[13px] text-[var(--color-fg)] bg-transparent border-none cursor-pointer max-w-[160px]">
                        <span className="truncate">{currentModel ? (currentModel.name || currentModel.id) : "—"}</span>
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
                                {currentModel?.provider === m.provider && currentModel?.id === m.id && <Check className="size-3.5" />}
                              </DropdownMenu.Item>
                            ))}
                          </div>
                        ))}
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>
                )}
                {/* 思考强度 dropdown:有 levels 就画;没当前值占位 — */}
                {levels && onPickLevel && levels.length > 0 && (
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger asChild>
                      <button className="flex items-center gap-1 px-1.5 py-0 rounded-full text-[13px] text-[var(--color-muted)] bg-transparent border-none cursor-pointer">
                        <span className="truncate">{currentLevel ? levelLabel(currentLevel) : "—"}</span>
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
                {/* 思考模式开关(bool):开=primary 色(Brain 亮);关=muted + 横划线(不思考)。
                    点 = 在 off 和 medium 之间切(经 onPickLevel,走偏好/setThinkingLevel)。 */}
                <ThinkingToggle
                  on={currentLevel ? currentLevel !== "off" : false}
                  disabled={!levels || levels.length === 0 || !onPickLevel}
                  onClick={() => onPickLevel?.(currentLevel && currentLevel !== "off" ? "off" : "medium")}
                  t={t}
                />
              </div>

              {/* 统计行(第二组):ml-auto 宽屏推右;窄屏 flex-wrap 后换行到第二行左对齐 */}
              <div className="ml-auto min-w-0">
                <StatsInline stats={stats ?? null} contextWindow={currentModel?.contextWindow ?? 0} effort={currentLevel || "off"} />
              </div>
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

/** 思考模式开关(bool):开=primary 色(Brain 亮);关=muted + 横划线穿过图标(不思考)。
 *  纯视觉开关,实际切换由 onClick(调 onPickLevel off↔medium)。 */
function ThinkingToggle({ on, disabled, onClick, t }: {
  on: boolean;
  disabled?: boolean;
  onClick: () => void;
  t: (k: string, vars?: Record<string, unknown>) => string;
}): React.ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={on ? t("shell.thinkingOn") : t("shell.thinkingOff")}
      className="flex items-center justify-center size-6 rounded-full border-none cursor-pointer disabled:cursor-default disabled:opacity-30"
      style={{
        background: on ? "var(--color-primary)" : "transparent",
        color: on ? "var(--color-primary-fg)" : "var(--color-muted)",
      }}
    >
      <span style={{ position: "relative", display: "inline-flex" }}>
        <Brain className="size-3.5" />
        {!on && (
          // 不思考:横划线穿过图标(禁用态)
          <span style={{
            position: "absolute", left: 0, right: 0, top: "50%",
            height: "1.5px", background: "currentColor", transform: "translateY(-50%) rotate(-25deg)",
          }} />
        )}
      </span>
    </button>
  );
}

/** 统计行(右半):上下文比例条 + 上传/下载/cache/TPS/effort/总消耗,右对齐,渐淡。
 *  stats null(pi 没起)时占位 —— + 整行弱化,表示"未运行"。 */
function StatsInline({ stats, contextWindow, effort }: {
  stats: SessionStats | null;
  contextWindow: number;
  effort: string;
}): React.ReactNode {
  const { t } = useTranslation();
  const ctx = stats?.contextUsage;
  const used = ctx?.tokens ?? 0;
  const limit = ctx?.contextWindow ?? contextWindow;
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
    <div className="flex items-center gap-2 text-[11px] text-[var(--color-muted)] font-[var(--font-family-mono)] min-w-0" style={{ opacity: placeholder ? 0.4 : 1 }}>
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
        <Item sym="⇄" v={val((tok?.cacheRead ?? 0) + (tok?.cacheWrite ?? 0))} title={`${t("shell.cache")}: ${val((tok?.cacheRead ?? 0) + (tok?.cacheWrite ?? 0))}`} />
        <Item sym="⚡" v={placeholder ? "—" : (stats?.tps != null ? stats.tps.toFixed(1) : "—")} title={`${t("shell.tpsTitle")}: ${placeholder || stats?.tps == null ? "—" : `${stats!.tps.toFixed(1)} tokens/秒`}`} />
        <Item sym="Σ" v={val(tok?.total)} title={`${t("shell.totalTitle")}: ${val(tok?.total)}`} />
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
