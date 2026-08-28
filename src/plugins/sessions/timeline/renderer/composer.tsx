// pi.ui Composer —— ChatGPT 式药丸输入区。
//
// 形态对照 chatgpt.com:rounded-[28px] 大药丸、surface 底、shadow 浮起、
// 左侧 "+" 圆形 ghost 按钮,右侧语音占位 + 圆形实心发送键(ArrowUp)。
// 底部工具栏三段:[+]/children · (中段:模型+思考强度 dropdown) · [语音][发送]。
// 模型由调用方拉数据传入(composer 是纯 UI,不依赖 session)。
import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { Plus, Mic, ArrowUp, Square, ChevronDown, Check, Brain } from "lucide-react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useTranslation } from "react-i18next";
import { PluginIcon, type ModelInfo, type CommandItem } from "@my-harness-desktop/react";
import { KERNEL_IDS, type KernelId } from "@my-harness-desktop/shared";

/** 思考强度 level 值 → i18n key 后缀。 */
const LEVEL_KEY: Record<string, string> = {
  off: "shell.levelOff", minimal: "shell.levelMinimal", low: "shell.levelLow",
  medium: "shell.levelMedium", high: "shell.levelHigh", xhigh: "shell.levelXhigh",
};

const SOURCE_BADGE: Record<string, { color: string; label: string }> = {
  skill: { color: "var(--color-accent-success)", label: "skill" },
  extension: { color: "var(--color-primary)", label: "ext" },
  prompt: { color: "var(--color-accent-warning)", label: "prompt" },
  plugin: { color: "var(--color-muted)", label: "cmd" },
};

const MAX_VISIBLE = 8;

export interface ComposerProps
  extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "onChange" | "value" | "onSubmit"> {
  value: string;
  onValueChange: (v: string) => void;
  onSubmit: () => void | Promise<void>;
  children?: React.ReactNode;
  /** composer 中段(思考控件右侧)的状态指示组件(composerStats 槽解析结果,由调用方传入)。 */
  composerStats?: React.ReactNode;
  /** composer 右下角的语音输入按钮(composerVoice 槽解析结果,由调用方传入)。
   *  未传时渲染禁用态占位麦克风(「待接入」提示,不静默、不伪造)。 */
  voice?: React.ReactNode;
  sending?: boolean;
  streaming?: boolean;
  /** streaming 中点击发送的语义切换:>0 时按钮变警告色并挂徽标,提示点击将入队。 */
  queueCount?: number;
  /** 允许空正文提交(有附件时,"只发附件"是完整意图)。默认 false。 */
  allowEmptySubmit?: boolean;
  /** 自动撑高的行数上限(超过内部滚动)。默认 10,通用配置 composerMaxLines 可调。 */
  maxLines?: number;
  onStop?: () => void;
  placeholder?: string;
  /** 模型(由调用方拉数据传入;不传则不渲染中段)。 */
  models?: ModelInfo[];
  levels?: string[];
  currentModel?: ModelInfo | null;
  currentLevel?: string;
  onPickModel?: (m: ModelInfo) => void;
  onPickLevel?: (l: string) => void;
  commands?: CommandItem[];
  /** 当前会话内核归属(锁定后非此内核的 TAB 置灰)。 */
  currentKernel?: KernelId | null;
  /** 会话是否已锁定内核(锁定后不可跨内核切换,§7.6 显式降级)。 */
  kernelLocked?: boolean;
  /** goal 生效标记:药丸换绿晕(表现机制;目标语义归 timeline 订阅 goal:state 判定)。 */
  goalActive?: boolean;
}

function SlashPopup({ matches, selectedIndex, onSelect, onHover, position }: {
  matches: CommandItem[];
  selectedIndex: number;
  onSelect: (cmd: CommandItem) => void;
  onHover: (i: number) => void;
  position: { top: number; left: number };
}): React.ReactNode {
  // 键盘上下键移动选中时,把选中项滚入 popup 可视区(容器自身滚动,不碰页面)。
  const containerRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const c = containerRef.current;
    const el = selectedRef.current;
    if (!c || !el) return;
    if (el.offsetTop < c.scrollTop) {
      c.scrollTop = el.offsetTop;
    } else if (el.offsetTop + el.offsetHeight > c.scrollTop + c.clientHeight) {
      c.scrollTop = el.offsetTop + el.offsetHeight - c.clientHeight;
    }
  }, [selectedIndex]);
  return createPortal(
    <div ref={containerRef} style={{ position: "fixed", top: position.top, left: position.left, transform: "translateY(-100%)", ...menuStyle, maxHeight: `${MAX_VISIBLE * 32 + 8}px`, overflowY: "auto" }}>
      {matches.map((cmd, i) => {
        const badge = SOURCE_BADGE[cmd.source] ?? SOURCE_BADGE.extension;
        return (
          <div
            key={cmd.name}
            ref={(el) => { if (i === selectedIndex) selectedRef.current = el; }}
            onMouseDown={(e) => { e.preventDefault(); onSelect(cmd); }} onMouseEnter={() => onHover(i)} style={{ ...itemStyle, background: i === selectedIndex ? "var(--color-surface)" : "transparent" }}>
            <span style={{ fontSize: "var(--font-size-xs)", fontWeight: 500, color: badge.color, border: `1px solid ${badge.color}`, borderRadius: "var(--radius-sm)", padding: "0 4px", lineHeight: "16px", flexShrink: 0 }}>{badge.label}</span>
            <span style={{ fontFamily: "var(--font-family-mono)", fontSize: "var(--font-size-base)", color: "var(--color-fg)" }}>/{cmd.name}</span>
            {cmd.description && <span style={{ fontSize: "var(--font-size-xs)", color: "var(--color-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{cmd.description}</span>}
          </div>
        );
      })}
    </div>,
    document.body,
  );
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
  composerStats,
  voice,
  sending = false,
  streaming = false,
  queueCount = 0,
  allowEmptySubmit = false,
  maxLines = 10,
  onStop,
  placeholder,
  models,
  levels,
  currentModel,
  currentLevel,
  onPickModel,
  onPickLevel,
  commands,
  currentKernel,
  kernelLocked = false,
  goalActive = false,
  ...rest
}: ComposerProps): React.ReactNode {
  const { t } = useTranslation();
  // streaming 中不再禁用发送——onSubmit 由父组件分流(立即发送 / 入队)。
  const canSend = (allowEmptySubmit || value.trim().length > 0) && !sending;
  // 光效状态机(与 index.css 三变量结构配套):streaming→亮态(fadein 慢慢变亮);
  // 结束→fadeout 态(transition 慢慢变暗),700ms 与 CSS --pi-composer-fade
  // transition 时长一致,到点摘除——摘 class 伪元素即销毁,退场动画播不了,
  // 故必须延迟摘。中途再亮:清定时器直接切回亮态。
  const [glowOn, setGlowOn] = useState(false);
  const [glowFading, setGlowFading] = useState(false);
  const glowTimerRef = useRef<number | null>(null);
  const glowOnRef = useRef(false);
  useEffect(() => {
    if (streaming) {
      if (glowTimerRef.current) { clearTimeout(glowTimerRef.current); glowTimerRef.current = null; }
      setGlowFading(false);
      glowOnRef.current = true;
      setGlowOn(true);
      return;
    }
    if (!glowOnRef.current) return;
    glowOnRef.current = false;
    setGlowOn(false);
    setGlowFading(true);
    glowTimerRef.current = window.setTimeout(() => {
      setGlowFading(false);
      glowTimerRef.current = null;
    }, 700);
  }, [streaming]);
  useEffect(() => () => {
    if (glowTimerRef.current) clearTimeout(glowTimerRef.current);
  }, []);
  const ph = placeholder ?? t("shell.composerPlaceholder");
  const levelLabel = (l: string): string => (LEVEL_KEY[l] ? t(LEVEL_KEY[l]) : l);
  const hasMiddle = !!(models?.length || levels?.length);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const [popupPos, setPopupPos] = useState<{ top: number; left: number } | null>(null);
  // 模型下拉的内核 TAB 状态:null = 跟随当前模型内核/首个内核(打开下拉时重置为 null)。
  const [modelKernel, setModelKernel] = useState<KernelId | null>(null);

  // 有模型的内核列表(固定序 KERNEL_IDS),用于模型下拉顶部的 TAB 条。
  const kernels = useMemo((): KernelId[] => {
    const present = new Set<KernelId>();
    for (const m of models ?? []) present.add(m.kernel);
    return (KERNEL_IDS as readonly KernelId[]).filter((k) => present.has(k));
  }, [models]);
  const byKernel = useMemo(() => groupByKernel(models ?? []), [models]);
  // 当前生效的内核 TAB:显式点选 → 当前模型内核 → 首个内核。
  const tabKernel: KernelId | undefined =
    modelKernel && kernels.includes(modelKernel) ? modelKernel
    : currentModel && kernels.includes(currentModel.kernel) ? currentModel.kernel
    : kernels[0];

  // 渲染某个内核的 provider → models 清单。interactive=false 时用 inert div(仅占宽不占高,
  // 让下拉宽度取两个内核清单的最大值),避免把隐藏项注册进 Radix 键盘导航。
  const renderKernelList = (k: KernelId, interactive: boolean): React.ReactNode => {
    const providers = byKernel.get(k);
    if (!providers) return null;
    return [...providers].map(([provider, ms]) => (
      <div key={provider}>
        <div className="px-2 py-0.5 text-[length:var(--font-size-xs)] uppercase tracking-wide text-[var(--color-muted)] opacity-70">{provider}</div>
        {ms.map((m) => {
          const body = (
            <>
              <PluginIcon name={m.kernel} className="size-3.5 shrink-0" />
              <span className="flex-1 truncate">{m.name || m.id}</span>
              {currentModel?.kernel === m.kernel && currentModel?.provider === m.provider && currentModel?.id === m.id && <Check className="size-3.5" />}
            </>
          );
          if (!interactive) {
            return (
              <div key={`${m.kernel}/${m.provider}/${m.id}`} style={itemStyle}>
                {body}
              </div>
            );
          }
          return (
            <DropdownMenu.Item key={`${m.kernel}/${m.provider}/${m.id}`} onSelect={() => onPickModel?.(m)} style={itemStyle}>
              {body}
            </DropdownMenu.Item>
          );
        })}
      </div>
    ));
  };

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
    return commands
      .filter((c) => c.name.toLowerCase().includes(q))
      .sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)))
      .slice(0, MAX_VISIBLE);
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
        data-goal-active={goalActive ? "true" : undefined}
        className={`flex flex-col w-full rounded-[16px] px-2 py-2 bg-[var(--color-surface)] shadow-[var(--shadow-md)] border border-[var(--color-border)]${glowOn ? " pi-composer-thinking" : ""}${glowFading ? " pi-composer-fadeout" : ""}${goalActive ? " pi-composer-goal" : ""}`}
      >
        <textarea
          {...rest}
          ref={textareaRef}
          data-timeline-composer
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          onKeyDown={(e) => {
            if (slashOpen && slashMatches.length > 0) {
              if (e.key === "ArrowDown") { e.preventDefault(); setSlashIndex((i) => (i + 1) % slashMatches.length); return; }
              if (e.key === "ArrowUp") { e.preventDefault(); setSlashIndex((i) => (i - 1 + slashMatches.length) % slashMatches.length); return; }
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); insertCommand(slashMatches[slashIndex]); return; }
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
          style={{ maxHeight: `${maxLines}lh` }}
          className="resize-none outline-none bg-transparent w-full px-3 pt-3.5 pb-2 field-sizing-content overflow-auto scrollbar-hidden text-[length:var(--font-size-base)] leading-7 font-[var(--font-family-sans)] text-[var(--color-fg)] placeholder:text-[var(--color-muted)]"
        />

        {/* 底部工具栏:三段 —— 左 [+] / 中(模型+思考 · 统计) / 右 [语音][发送] */}
        <div className="flex justify-between items-center gap-3 mt-2.5">
          <div className="flex items-center gap-1 shrink-0">
            <button type="button" style={circleBtn(true)} title={t("shell.attachment")} tabIndex={-1}>
              <Plus className="size-5" />
            </button>
            {children}
          </div>

          {/* 中段:模型 + 思考强度 + 思考开关 */}
          {hasMiddle && (
            <div className="flex-1 flex items-center gap-2 min-w-0">
              <div className="flex items-center gap-1.5 min-w-0">
                {/* 模型 dropdown:有清单就画(恒定展示);没当前值占位 — */}
                {models && onPickModel && models.length > 0 && (
                  <DropdownMenu.Root onOpenChange={(open) => { if (open) setModelKernel(null); }}>
                    <DropdownMenu.Trigger asChild>
                      <button className="flex items-center gap-1 px-1.5 py-0 rounded-full text-[length:var(--font-size-base)] text-[var(--color-fg)] bg-transparent border-none cursor-pointer max-w-[160px]">
                        {currentModel && <PluginIcon name={currentModel.kernel} className="size-3.5 shrink-0" />}
                        <span className="truncate">{currentModel ? (currentModel.name || currentModel.id) : "—"}</span>
                        <ChevronDown className="size-3 shrink-0 text-[var(--color-muted)]" />
                      </button>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content align="start" sideOffset={4} style={menuStyle} className="max-h-72 flex flex-col">
                        {/* 模型清单:独立滚动;内核 TAB 固定在底部。两个内核清单叠在同一 grid 单元格,
                            非激活内核 height:0 + visibility:hidden 只占宽不占高 → 下拉宽度取两个内核的最大值、切换不跳动。 */}
                        <div className="overflow-y-auto" style={{ flex: "1 1 auto", minHeight: 0 }}>
                          <div style={{ display: "grid" }}>
                            {kernels.map((k) => {
                              const active = k === tabKernel;
                              return (
                                <div
                                  key={k}
                                  aria-hidden={!active}
                                  style={{
                                    gridArea: "1 / 1",
                                    ...(active
                                      ? {}
                                      : { height: 0, overflow: "hidden", visibility: "hidden", pointerEvents: "none" }),
                                  }}
                                >
                                  {renderKernelList(k, active)}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                        {/* 底部内核 TAB:pi / dsh 切换。多内核才有 TAB;单内核直接铺清单(无 TAB)。 */}
                        {kernels.length > 1 && (
                          <div style={{ display: "flex", gap: "2px", padding: "4px 2px 2px", borderTop: "1px solid var(--color-border)", flexShrink: 0 }}>
                            {kernels.map((k) => {
                              const active = k === tabKernel;
                              // 锁定后非当前内核的 TAB 置灰(显式降级,§7.6):disabled + 降透明 + tooltip。
                              const lockedOut = kernelLocked && k !== currentKernel;
                              return (
                                <button
                                  key={k}
                                  type="button"
                                  tabIndex={-1}
                                  disabled={lockedOut}
                                  title={lockedOut ? t("shell.kernelLocked", { kernel: currentKernel }) : undefined}
                                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); setModelKernel(k); }}
                                  style={{
                                    flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: "5px",
                                    padding: "4px 8px", borderRadius: "var(--radius-sm)", border: "none",
                                    cursor: lockedOut ? "default" : "pointer", fontSize: "var(--font-size-xs)", fontWeight: 600,
                                    letterSpacing: "0.04em", textTransform: "uppercase",
                                    background: active ? "color-mix(in srgb, var(--color-primary) 16%, transparent)" : "transparent",
                                    color: active ? "var(--color-fg)" : "var(--color-muted)",
                                    opacity: lockedOut ? 0.4 : 1,
                                  }}
                                >
                                  <PluginIcon name={k} className="size-3.5 shrink-0" />
                                  <span>{k}</span>
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>
                )}
                {/* 思考强度 dropdown:有 levels 就画;没当前值占位 — */}
                {levels && onPickLevel && levels.length > 0 && (
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger asChild>
                      <button className="flex items-center gap-1 px-1.5 py-0 rounded-full text-[length:var(--font-size-base)] text-[var(--color-muted)] bg-transparent border-none cursor-pointer">
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
                {/* composerStats 槽:思考控件右侧的统计指示区(上下文占用条等),ml-auto 推右贴向语音/发送。
                    组件由调用方经 composerStats 槽解析传入(归属 token-stats 插件),composer 只提供挂载点。 */}
                <span className="ml-auto flex items-center shrink-0">{composerStats}</span>
              </div>
            </div>
          )}

          <div className="flex items-center gap-1.5 shrink-0">
            {voice ?? (
              <button type="button" style={circleBtn(false)} title={t("shell.voice")} tabIndex={-1} disabled>
                <Mic className="size-4.5" />
              </button>
            )}
            {streaming && (
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
            )}
            <button
              type="submit"
              disabled={!canSend}
              aria-label={streaming ? t("timeline.queue.send") : t("shell.send")}
              title={streaming ? t("timeline.queue.sendHint") : undefined}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: "32px", height: "32px", borderRadius: "50%", border: "none", flexShrink: 0,
                background: !canSend
                  ? "var(--color-border)"
                  : streaming
                    ? "var(--color-accent-warning)"
                    : "var(--color-primary)",
                color: !canSend
                  ? "var(--color-muted)"
                  : streaming
                    ? "var(--color-bg)"
                    : "var(--color-primary-fg)",
                cursor: canSend ? "pointer" : "not-allowed",
                transition: "background 0.15s",
                position: "relative",
              }}
            >
              <ArrowUp className="size-4.5" strokeWidth={2.5} />
              {streaming && queueCount > 0 && (
                <span
                  style={{
                    position: "absolute", top: -4, right: -4,
                    background: "var(--color-accent-warning)", color: "var(--color-bg)",
                    fontSize: 10, fontWeight: 700, padding: "1px 5px",
                    borderRadius: 8, border: "1px solid var(--color-bg)",
                  }}
                >{queueCount}</span>
              )}
            </button>
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

/** 模型按内核再按供应商分组(kernel → provider → models)。内核标在组标题 + 每条前缀显示(§3.5)。 */
function groupByKernel(models: ModelInfo[]): Map<string, Map<string, ModelInfo[]>> {
  const byKernel = new Map<string, Map<string, ModelInfo[]>>();
  for (const mo of models) {
    if (!byKernel.has(mo.kernel)) byKernel.set(mo.kernel, new Map());
    const byProvider = byKernel.get(mo.kernel)!;
    if (!byProvider.has(mo.provider)) byProvider.set(mo.provider, []);
    byProvider.get(mo.provider)!.push(mo);
  }
  return byKernel;
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
  fontSize: "var(--font-size-base)", color: "var(--color-fg)",
  fontFamily: "var(--font-family-sans)",
  cursor: "pointer", outline: "none",
};
