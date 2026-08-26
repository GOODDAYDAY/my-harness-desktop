import React, { useEffect, useRef, useCallback, useState, useMemo } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { useTranslation } from "react-i18next";
import { Crosshair, Eye, EyeOff, Pin as PinIcon, Trash2, X, MessageSquare } from "lucide-react";
import { useUiStore, usePluginContext, useSessionStore, type PluginContext, type SessionInfo, type MessageActionProps } from "@my-harness-desktop/react";
import { deriveSessionTitle } from "@my-harness-desktop/shared";
import { PinSVG } from "./pin-svg";
import { usePinStore } from "./pin-store";
import { PALETTE, messagePreview, groupContentPins, backfillPreviews, type Pin, type ContentPin } from "../core/pin";


function getContrastText(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.55 ? "#1a1a1a" : "#ffffff";
}

function getSessionName(path: string): string {
  const el = document.querySelector(`[data-session-path="${CSS.escape(path)}"]`);
  if (el) {
    const titleEl = el.querySelector(".session-title, [class*='session-title']");
    if (titleEl && titleEl.textContent) return titleEl.textContent;
  }
  return path.split("/").pop()?.replace(/\.jsonl$/, "") ?? path;
}

function isRowVisible(path: string): boolean {
  const el = document.querySelector(`[data-session-path="${CSS.escape(path)}"]`);
  if (!el) return false;
  let node: Element | null = el;
  while (node && node !== document.body) {
    if (node.classList.contains("pi-collapsible") && node.getAttribute("data-state") === "closed") {
      return false;
    }
    node = node.parentElement;
  }
  return true;
}

function persistPins(ctx: PluginContext, pins: Record<string, Pin[]>): void {
  void ctx.config.set("pins", pins);
}

function persistContentPins(ctx: PluginContext, contentPins: Record<string, ContentPin[]>): void {
  void ctx.config.set("contentPins", contentPins);
}

async function loadPins(ctx: PluginContext): Promise<Record<string, Pin[]>> {
  const cfg = await ctx.config.all();
  const raw = (cfg as Record<string, unknown>)["pins"];
  return (raw && typeof raw === "object" ? raw : {}) as Record<string, Pin[]>;
}

async function loadContentPins(ctx: PluginContext): Promise<Record<string, ContentPin[]>> {
  const cfg = await ctx.config.all();
  const raw = (cfg as Record<string, unknown>)["contentPins"];
  return (raw && typeof raw === "object" ? raw : {}) as Record<string, ContentPin[]>;
}

async function loadVisibility(ctx: PluginContext): Promise<boolean> {
  const v = await ctx.config.get<boolean>("pinsVisible");
  return v !== false;
}


export function SessionColorsPanel(): React.ReactNode {
  const { t } = useTranslation();
  const ctx = usePluginContext();
  const selectedColor = usePinStore((s) => s.selectedColor);
  const pinMode = usePinStore((s) => s.pinMode);
  const pins = usePinStore((s) => s.pins);
  const contentPins = usePinStore((s) => s.contentPins);
  const pinsVisible = usePinStore((s) => s.pinsVisible);
  const selectColor = usePinStore((s) => s.selectColor);
  const togglePinsVisible = usePinStore((s) => s.togglePinsVisible);
  const activeView = useUiStore((s) => s.activeView);
  const messages = useSessionStore((s) => s.messages);

  const [activeFilter, setActiveFilter] = useState<string>("all");
  const [sessionNames, setSessionNames] = useState<Record<string, string>>({});
  // 会话元数据收编框架 store(设计 docs/design/plugin-decoupling.md §4.2):
  // 数据源 = useSessionStore.sessionInfos(框架拉取 + 事件维护),不再自己 ctx.sessions.list——
  // 修掉"挂载拉一次即 stale"(会话改名后钉子名不更新,切走再切回才恢复)的老问题。
  const sessionInfosRaw = useSessionStore((s) => s.sessionInfos);
  const sessionInfos = useMemo(() => sessionInfosRaw ?? {}, [sessionInfosRaw]);
  const [visiblePaths, setVisiblePaths] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (activeView !== "chat" && pinMode) selectColor(null);
  }, [activeView, pinMode, selectColor]);

  useEffect(() => {
    const update = (): void => {
      const names: Record<string, string> = {};
      const visible = new Set<string>();
      for (const path of Object.keys(pins)) {
        names[path] = getSessionName(path);
        if (isRowVisible(path)) visible.add(path);
      }
      setSessionNames(names);
      setVisiblePaths(visible);
    };
    update();
    const timer = setTimeout(update, 200);
    return () => clearTimeout(timer);
  }, [pins]);

  const handleToggleVisible = (): void => {
    togglePinsVisible();
  };

  const handleSelectColor = (color: string): void => {
    selectColor(selectedColor === color ? null : color);
  };

  const handleRemovePin = (path: string, pinId: string): void => {
    usePinStore.getState().removePin(path, pinId);
  };

  const handleOpenSession = async (path: string): Promise<boolean> => {
    const { currentSessionPath: prevPath, sessionTitle: prevTitle } = useUiStore.getState();
    try {
      const info = sessionInfos[path];
      useUiStore.getState().setCurrentSessionPath(path);
      useUiStore.getState().setSessionTitle(info ? deriveSessionTitle(info) : null);
      const ok = await useSessionStore.getState().openSession(path);
      // 文件已删/不可读:回滚选中态,不留指向失效会话的残局(此前缺失,仅此处无回滚)
      if (!ok) {
        useUiStore.getState().setCurrentSessionPath(prevPath);
        useUiStore.getState().setSessionTitle(prevTitle);
      }
      return ok;
    } catch (err) { console.error('[session-colors] openSession failed:', err); return false; }
  };

  const pinCountByColor = (color: string): number =>
    Object.values(pins).flat().filter((p) => p.color === color).length +
    Object.values(contentPins).flat().filter((p) => p.color === color).length;

  const totalPinCount = Object.values(pins).flat().length + Object.values(contentPins).flat().length;

  const handleClearColor = (color: string): void => {
    const strip = <T extends { color: string }>(bucket: Record<string, T[]>): Record<string, T[]> => {
      const next = { ...bucket };
      for (const path of Object.keys(next)) {
        const filtered = (next[path] ?? []).filter((p) => p.color !== color);
        if (filtered.length === 0) delete next[path];
        else next[path] = filtered;
      }
      return next;
    };
    usePinStore.setState({ pins: strip(pins), contentPins: strip(contentPins) });
  };

  const handleClearAll = (): void => {
    usePinStore.setState({ pins: {}, contentPins: {} });
  };

  const colorsInUse = [...new Set([
    ...Object.values(pins).flat().map((p) => p.color),
    ...Object.values(contentPins).flat().map((p) => p.color),
  ])];
  const filterTabs = ["all", ...colorsInUse];
  const filteredPins = activeFilter === "all"
    ? Object.entries(pins).filter(([path]) => visiblePaths.has(path))
    : Object.entries(pins).filter(([path, list]) => visiblePaths.has(path) && list.some((p) => p.color === activeFilter));

  const onLocate = (path: string): void => {
    const row = document.querySelector(`[data-session-path="${CSS.escape(path)}"]`);
    if (row) {
      row.scrollIntoView({ behavior: "smooth", block: "nearest" });
      const el = row as HTMLElement;
      const orig = el.style.background;
      el.style.background = "var(--color-primary)";
      setTimeout(() => { el.style.background = orig; }, 600);
    }
  };

  const currentSessionPath = useUiStore((s) => s.currentSessionPath);
  const currentNeutralSessionId = useUiStore((s) => s.currentNeutralSessionId);
  const projectPaths = useMemo(() => Object.keys(sessionInfos), [sessionInfos]);
  // 跨会话聚合(core/pin.groupContentPins,设计 §6.1):当前会话按渲染口径(孤儿钉不列、
  // 按消息序),其他会话按项目顺序列出——retry 折叠的消息无 DOM 也无 messageActions,
  // 钉不上去,此处不必复刻折叠判定。
  const contentGroups = useMemo(
    () => groupContentPins(contentPins, currentNeutralSessionId ?? currentSessionPath, messages, projectPaths, activeFilter === "all" ? null : activeFilter),
    [contentPins, currentSessionPath, messages, projectPaths, activeFilter],
  );

  // 旧数据预览快照惰性补填:重开某会话时把缺 preview 的钉从 messages 解析写回
  // store(Overlay 投影落盘)——下次跨会话列出即有预览;孤儿钉补不上,不触发写盘。
  useEffect(() => {
    if (!currentSessionPath || messages.length === 0) return;
    const next = backfillPreviews(contentPins[currentNeutralSessionId ?? currentSessionPath] ?? [], messages);
    if (!next) return;
    usePinStore.getState().setContentPins({ ...contentPins, [currentNeutralSessionId ?? currentSessionPath]: next });
  }, [messages, currentSessionPath, contentPins]);

  const onLocateMessage = (messageId: string): void => {
    try { ctx.events.invoke("timeline:scrollTo", { messageId }); } catch { /* timeline 未加载:channel 未注册 */ }
  };

  // 跨会话导航两段式:先打开会话(失败即止),再 scrollTo——timeline 的 pendingScrollRef
  // 兜底接得住 messages 尚未渲染的时序(设计 §6.3)。
  const handleOpenAndLocate = async (path: string, messageId: string): Promise<void> => {
    const ok = await handleOpenSession(path);
    if (!ok) return;
    onLocateMessage(messageId);
  };

  const groupTitle = (path: string): string => {
    const info = sessionInfos[path];
    return info ? deriveSessionTitle(info) : (path.split("/").pop()?.replace(/\.jsonl$/, "") ?? path);
  };

  return (
    <div className="flex flex-col gap-3 p-3 h-full">
      <div className="flex items-center gap-2">
        <PinIcon className="size-4 text-[var(--color-muted)]" />
        <span className="text-[length:var(--font-size-sm)] font-semibold text-[var(--color-fg)] flex-1">
          {t("pinColors.title")}
        </span>
        <button
          onClick={handleToggleVisible}
          title={pinsVisible ? t("pinColors.hide") : t("pinColors.show")}
          className="flex items-center justify-center size-6 rounded-[var(--radius-sm)] text-[var(--color-muted)] hover:text-[var(--color-fg)] bg-transparent border-none cursor-pointer"
        >
          {pinsVisible ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
        </button>
      </div>

      <div className="text-[length:var(--font-size-xs)] text-[var(--color-muted)] leading-relaxed">
        {pinMode ? t("pinColors.hintActive") : t("pinColors.hintIdle")}
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        {PALETTE.map((color) => {
          const count = pinCountByColor(color);
          return (
            <div key={color} className="relative">
              <button
                onClick={() => handleSelectColor(color)}
                className="flex items-center justify-center rounded-[var(--radius-sm)] border-2 transition-all"
                style={{
                  width: 30, height: 34,
                  borderColor: selectedColor === color ? "var(--color-fg)" : "transparent",
                  background: selectedColor === color ? "var(--color-surface)" : "transparent",
                  transform: selectedColor === color ? "scale(1.1)" : "scale(1)",
                }}
              >
                <PinSVG color={color} style={{ width: 20, height: 24, opacity: selectedColor === color ? 1 : 0.5 }} />
              </button>
              {count > 0 && (
                <button
                  onClick={() => handleClearColor(color)}
                  title={t("pinColors.clearColor")}
                  className="absolute -top-1.5 -right-1.5 flex items-center justify-center rounded-full text-[length:var(--font-size-xs)] font-bold leading-none border-2 transition-all hover:scale-125"
                  style={{
                    width: 16, height: 16,
                    background: color,
                    color: getContrastText(color),
                    borderColor: "var(--color-bg)",
                  }}
                >
                  {count}
                </button>
              )}
            </div>
          );
        })}
        {totalPinCount > 0 && (
          <button
            onClick={handleClearAll}
            title={t("pinColors.clearAll")}
            className="flex items-center justify-center rounded-[var(--radius-sm)] size-7 ml-auto text-[var(--color-muted)] hover:text-[#f38ba8] bg-transparent border border-[var(--color-border)] cursor-pointer transition-colors"
          >
            <Trash2 className="size-3.5" />
          </button>
        )}
      </div>

      <div className="border-t border-[var(--color-border)] pt-2 flex-1 min-h-0 overflow-hidden flex flex-col gap-1.5">
        {filterTabs.length > 1 && (
          <div className="flex items-center gap-1 overflow-x-auto shrink-0 pb-1">
            {filterTabs.map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveFilter(tab)}
                className="px-2 py-0.5 rounded-full text-[length:var(--font-size-xs)] whitespace-nowrap border transition-all flex items-center gap-1"
                style={{
                  background: activeFilter === tab ? "var(--color-surface)" : "transparent",
                  borderColor: activeFilter === tab ? "var(--color-fg)" : "var(--color-border)",
                  color: activeFilter === tab ? "var(--color-fg)" : "var(--color-muted)",
                }}
              >
                {tab === "all" ? t("pinColors.all") : <span className="w-2 h-2 rounded-full" style={{ background: tab }} />}
              </button>
            ))}
          </div>
        )}

        <div className="overflow-y-auto flex-1 min-h-0">
          {filteredPins.length === 0 && contentGroups.length === 0 ? (
            <div className="text-[length:var(--font-size-xs)] text-[var(--color-muted)] py-2">{t("pinColors.empty")}</div>
          ) : (
            <AnimatePresence mode="wait">
              <motion.div
                key={activeFilter}
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                transition={{ duration: 0.2 }}
                className="flex flex-col gap-1"
              >
                {filteredPins.length > 0 && filteredPins.map(([path, pinList]) => {
                  const filtered = activeFilter === "all" ? pinList : pinList.filter((p) => p.color === activeFilter);
                  return (
                    <PinnedSessionRow
                      key={path}
                      pins={filtered}
                      info={sessionInfos[path]}
                      fallbackName={sessionNames[path] ?? path}
                      onRemove={(pinId) => handleRemovePin(path, pinId)}
                      onLocate={() => onLocate(path)}
                      onOpen={() => void handleOpenSession(path)}
                    />
                  );
                })}
                {contentGroups.length > 0 && (
                  <>
                    {filteredPins.length > 0 && <div className="border-t border-[var(--color-border)] my-1" />}
                    <div className="text-[length:var(--font-size-xs)] text-[var(--color-muted)] px-1 pt-1">
                      {t("pinColors.contentSection")}
                    </div>
                    {contentGroups.map((group) => (
                      <div key={group.path}>
                        {!group.isCurrent && (
                          <div className="truncate text-[length:var(--font-size-xs)] text-[var(--color-muted)] px-1 pt-1.5 pb-0.5">
                            {groupTitle(group.path)}
                          </div>
                        )}
                        {group.entries.map(({ pin, message }) => {
                          const preview = message ? messagePreview(message) : pin.preview;
                          return (
                            <ContentPinRow
                              key={pin.id}
                              pin={pin}
                              preview={preview ?? t("pinColors.previewMissing")}
                              previewMuted={!preview}
                              onLocate={group.isCurrent
                                ? () => onLocateMessage(pin.messageId)
                                : () => void handleOpenAndLocate(group.path, pin.messageId)}
                            />
                          );
                        })}
                      </div>
                    ))}
                  </>
                )}
              </motion.div>
            </AnimatePresence>
          )}
        </div>
      </div>
    </div>
  );
}

function PinnedSessionRow({
  pins, info, fallbackName, onRemove, onLocate, onOpen,
}: {
  pins: Pin[];
  info?: SessionInfo;
  fallbackName: string;
  onRemove: (pinId: string) => void;
  onLocate: () => void;
  onOpen: () => void;
}): React.ReactNode {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const title = info?.name ?? info?.id.slice(0, 8) ?? fallbackName;
  const sub = info?.lastMessage ?? (info ? new Date(info.created).toLocaleString() : undefined);
  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="flex items-center gap-2 rounded-[var(--radius-md)] cursor-pointer select-none"
      style={{
        padding: "8px 10px",
        background: hovered ? "var(--color-surface)" : "transparent",
        transition: "background 0.12s",
      }}
      onClick={onOpen}
    >
      <div className="shrink-0 flex items-center justify-center" style={{ width: 20, height: 20 }}>
        <MessageSquare className="size-3.5 text-[var(--color-muted)]" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="truncate text-[length:var(--font-size-sm)] font-semibold leading-tight text-[var(--color-fg)]">
          {title}
        </div>
        {sub && (
          <div className="truncate text-[length:var(--font-size-xs)] leading-tight text-[var(--color-muted)] mt-0.5">
            {sub}
          </div>
        )}
        <div className="flex items-center gap-1.5 mt-1">
          {pins.map((pin) => (
            <button
              key={pin.id}
              onClick={(e) => { e.stopPropagation(); onRemove(pin.id); }}
              title={t("pinColors.remove")}
              className="flex items-center justify-center rounded-full border-2 transition-transform hover:scale-125 shrink-0"
              style={{
                width: 14, height: 14,
                background: pin.color,
                borderColor: "var(--color-bg)",
              }}
            >
              {hovered && <X className="size-2" style={{ color: getContrastText(pin.color) }} />}
            </button>
          ))}
        </div>
      </div>
      <button
        onClick={(e) => { e.stopPropagation(); onLocate(); }}
        title={t("pinColors.locate")}
        className="flex items-center justify-center size-6 rounded-[var(--radius-sm)] bg-transparent border-none cursor-pointer text-[var(--color-muted)] hover:text-[var(--color-fg)] shrink-0"
      >
        <Crosshair className="size-3.5" />
      </button>
    </div>
  );
}

function ContentPinRow({ pin, preview, previewMuted, onLocate }: {
  pin: ContentPin;
  preview: string;
  previewMuted: boolean;
  onLocate: () => void;
}): React.ReactNode {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="flex items-center gap-2 rounded-[var(--radius-md)] cursor-pointer select-none"
      style={{
        padding: "6px 10px",
        background: hovered ? "var(--color-surface)" : "transparent",
        transition: "background 0.12s",
      }}
      onClick={onLocate}
    >
      <span
        className="shrink-0 rounded-full border-2"
        style={{ width: 12, height: 12, background: pin.color, borderColor: "var(--color-bg)" }}
      />
      <div
        className="flex-1 min-w-0 truncate text-[length:var(--font-size-sm)] leading-tight text-[var(--color-fg)]"
        style={previewMuted ? { opacity: 0.55, fontStyle: "italic" } : undefined}
      >
        {preview}
      </div>
      <button
        onClick={(e) => { e.stopPropagation(); onLocate(); }}
        title={t("pinColors.locateMessage")}
        className="flex items-center justify-center size-6 rounded-[var(--radius-sm)] bg-transparent border-none cursor-pointer text-[var(--color-muted)] hover:text-[var(--color-fg)] shrink-0"
        style={{ opacity: hovered ? 1 : 0, transition: "opacity 0.12s" }}
      >
        <Crosshair className="size-3.5" />
      </button>
    </div>
  );
}

/** 框架 Overlay 挂载点(命名导出,plugins-host 挂进主 React 树并注入 pluginId):
 *  图钉常驻,不随 sidePanel Tab 卸载;config 的读(load)与投影写盘(persist)收在这里——
 *  面板只是 store 的视图,不再承担持久化。 */
export function Overlay(): React.ReactNode {
  const ctx = usePluginContext();
  const selectedColor = usePinStore((s) => s.selectedColor);
  const pinMode = usePinStore((s) => s.pinMode);
  const pinsVisible = usePinStore((s) => s.pinsVisible);
  const pins = usePinStore((s) => s.pins);
  const contentPins = usePinStore((s) => s.contentPins);
  const loaded = usePinStore((s) => s.loaded);
  const setPins = usePinStore((s) => s.setPins);
  const setContentPins = usePinStore((s) => s.setContentPins);
  const setLoaded = usePinStore((s) => s.setLoaded);
  const selectColor = usePinStore((s) => s.selectColor);
  const currentSessionPath = useUiStore((s) => s.currentSessionPath);
  const currentNeutralSessionId = useUiStore((s) => s.currentNeutralSessionId);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const [targets, setTargets] = useState<Map<string, HTMLElement>>(new Map());
  const [messageTargets, setMessageTargets] = useState<Map<string, HTMLElement>>(new Map());
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (loaded) return;
    void loadPins(ctx).then((p) => setPins(p));
    void loadContentPins(ctx).then((p) => setContentPins(p));
    void loadVisibility(ctx).then((v) => { if (!v) usePinStore.setState({ pinsVisible: false }); });
    setLoaded(true);
  }, [ctx, loaded, setPins, setContentPins, setLoaded]);

  // store → config 唯一写盘点(跳过初始 load 回填,避免刚读出的内容原样写回)
  useEffect(() => {
    let first = true;
    return usePinStore.subscribe((state, prev) => {
      if (first) { first = false; return; }
      if (state.pins !== prev.pins) persistPins(ctx, state.pins);
      if (state.contentPins !== prev.contentPins) persistContentPins(ctx, state.contentPins);
      if (state.pinsVisible !== prev.pinsVisible) void ctx.config.set("pinsVisible", state.pinsVisible, { scope: "global" });
    });
  }, [ctx]);

  const exitPinMode = useCallback(() => { selectColor(null); }, [selectColor]);

  useEffect(() => {
    if (!pinMode) return;
    const onMove = (e: MouseEvent): void => setMousePos({ x: e.clientX, y: e.clientY });
    // 钉入模式 = 指针模态:落在会话行上的交互在 window 捕获相整体截停
    // (stopPropagation 后事件到不了 React root 委托),行上现在/将来绑的任何
    // handler——切换会话的 onClick、SortableList 拖拽手势、Radix 右键菜单——
    // 一律不触发。不逐个事件堵、不依赖行实现,模态语义一处收编。
    // (监听 pointerdown 而非 mousedown:SortableList 已 preventDefault pointerdown
    // 压选区,平台语义连带抑制兼容性鼠标事件,window 级 mousedown 永远收不到)
    const onDown = (e: PointerEvent): void => {
      if (e.button !== 0) return; // 右键交 onContext:退出钉模式
      const target = document.elementFromPoint(e.clientX, e.clientY);
      if (target?.closest("[data-session-colors-pin]")) {
        e.stopPropagation(); // 点在已有图钉:只防行拖拽手势,click 放行给拔出
        return;
      }
      const msgEl = target?.closest("[data-message-id]");
      if (msgEl instanceof HTMLElement) {
        e.preventDefault();
        e.stopPropagation();
        const messageId = msgEl.dataset.messageId;
        const sessionPath = useUiStore.getState().currentSessionPath;
        if (!messageId || !sessionPath) return;
        const rect = msgEl.getBoundingClientRect();
        const x = ((e.clientX - rect.left) / rect.width) * 100;
        const y = ((e.clientY - rect.top) / rect.height) * 100;
        // 预览快照在钉入时刻落定(设计 §6.2):messages 命中走 messagePreview 单源,
        // 未命中退 DOM 文本(理论上不发生——钉入目标必在当前 messages 渲染)。
        const msg = useSessionStore.getState().messages.find((m) => m.id === messageId);
        const preview = msg ? messagePreview(msg) : (msgEl.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 30);
        usePinStore.getState().addContentPin(sessionPath, { id: crypto.randomUUID(), messageId, color: selectedColor!, x, y, preview });
        return;
      }
      const row = target?.closest("[data-session-path]");
      if (!(row instanceof HTMLElement)) return; // 行外不拦:面板/中区交互照常
      e.preventDefault();
      e.stopPropagation();
      const sessionPath = row.dataset.sessionPath;
      if (!sessionPath) return;
      const rect = row.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 100;
      const y = ((e.clientY - rect.top) / rect.height) * 100;
      usePinStore.getState().addPin(sessionPath, { id: crypto.randomUUID(), color: selectedColor!, x, y });
    };
    // 兜底:click 由 pointerup 独立派生,不受 pointerdown 拦截影响,二次截停
    const onClickCapture = (e: MouseEvent): void => {
      const t = document.elementFromPoint(e.clientX, e.clientY);
      if (t?.closest("[data-session-colors-pin]")) return;
      if (t?.closest("[data-message-id]") || t?.closest("[data-session-path]")) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    // 右键:捕获相截停(行上的 Radix 菜单不弹、会话不进),全局退出钉模式
    const onContext = (e: Event): void => {
      e.preventDefault();
      e.stopPropagation();
      exitPinMode();
    };
    const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") exitPinMode(); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("click", onClickCapture, true);
    window.addEventListener("contextmenu", onContext, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("click", onClickCapture, true);
      window.removeEventListener("contextmenu", onContext, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [pinMode, selectedColor, exitPinMode]);

  // pin 钉进宿主元素(会话行/消息)后,行重排/滚动/缩放/补间动画全部由浏览器原生跟随;
  // JS 只维护挂载关系:sessionPath → 行元素、messageId → 消息元素,不再做坐标追踪。
  // 两个触发源:数据触发(pins/contentPins 变化即依赖变化,effect 重跑立即重扫——
  // 钉入/拔出瞬间元素已在 DOM,不等 DOM 事件);DOM 触发(observer 捕获元素增删:
  // Virtuoso 滚动重建、折叠展开、切会话/切项目)。observer 只观察 childList,
  // position 补丁是 attribute 变化,不会回触发自身。
  useEffect(() => {
    if (!loaded || !pinsVisible) return;
    let listObserver: MutationObserver | null = null;
    let listObserved: Element | null = null;
    let msgObserver: MutationObserver | null = null;
    let msgObserved: Element | null = null;

    const scheduleScan = (): void => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(scan);
    };

    const scan = (): void => {
      const next = new Map<string, HTMLElement>();
      for (const path of Object.keys(pins)) {
        if (!isRowVisible(path)) continue;
        const el = document.querySelector<HTMLElement>(`[data-session-path="${CSS.escape(path)}"]`);
        if (!el) continue;
        if (getComputedStyle(el).position === "static") el.style.position = "relative";
        next.set(path, el);
      }
      setTargets((prev) => {
        if (prev.size === next.size && [...next].every(([k, v]) => prev.get(k) === v)) return prev;
        return next;
      });
      const nextMsg = new Map<string, HTMLElement>();
      const curPins = currentSessionPath ? contentPins[currentNeutralSessionId ?? currentSessionPath] ?? [] : [];
      for (const pin of curPins) {
        const el = document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(pin.messageId)}"]`);
        if (!el) continue;
        if (getComputedStyle(el).position === "static") el.style.position = "relative";
        nextMsg.set(pin.messageId, el);
      }
      setMessageTargets((prev) => {
        if (prev.size === nextMsg.size && [...nextMsg].every(([k, v]) => prev.get(k) === v)) return prev;
        return nextMsg;
      });
      // 行/消息容器可能晚出现(列表异步拉取)或整体迁移(切项目/视图):每轮扫描后按当前实际容器重锚观察目标
      const listContainer = document.querySelector("[data-session-path]")?.closest(".overflow-y-auto") ?? document.body;
      if (listContainer !== listObserved) {
        listObserver?.disconnect();
        listObserver = new MutationObserver(scheduleScan);
        listObserver.observe(listContainer, { childList: true, subtree: true });
        listObserved = listContainer;
      }
      const msgContainer = document.querySelector("[data-message-id]")?.closest("[data-virtuoso-scroller]") ?? document.body;
      if (msgContainer !== msgObserved) {
        msgObserver?.disconnect();
        msgObserver = new MutationObserver(scheduleScan);
        msgObserver.observe(msgContainer, { childList: true, subtree: true });
        msgObserved = msgContainer;
      }
    };

    scan();
    return () => {
      listObserver?.disconnect();
      msgObserver?.disconnect();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [pins, contentPins, currentSessionPath, pinsVisible, loaded]);

  if (!loaded || !pinsVisible) return null;

  return createPortal(
    <>
      {pinMode && (
        <div style={{ position: "fixed", left: mousePos.x, top: mousePos.y, transform: "translate(-5px, -22px)", pointerEvents: "none", zIndex: 9999, opacity: 0.8 }}>
          <PinSVG color={selectedColor!} style={{ width: 22, height: 26, filter: "drop-shadow(0 2px 4px rgba(0,0,0,0.5))" }} />
        </div>
      )}
      {pinMode && <style>{`[data-session-path]:hover,[data-message-id]:hover{outline:1px dashed rgba(137,180,250,0.3)!important;outline-offset:2px!important;}`}</style>}
      {[...targets].map(([path, el]) => (
        <RowPins
          key={path}
          el={el}
          pins={pins[path] ?? []}
          onRemove={(pinId) => usePinStore.getState().removePin(path, pinId)}
        />
      ))}
      {[...messageTargets].map(([messageId, el]) => (
        <RowPins
          key={`msg:${messageId}`}
          el={el}
          pins={(currentSessionPath ? contentPins[currentNeutralSessionId ?? currentSessionPath] ?? [] : []).filter((p) => p.messageId === messageId)}
          onRemove={(pinId) => { if (currentSessionPath) usePinStore.getState().removeContentPin(currentNeutralSessionId ?? currentSessionPath, pinId); }}
        />
      ))}
    </>,
    document.body,
  );
}

/** 已播过钉入动画的 pin 登记簿:行重排/视图切换导致的重挂载不再播弹跳 */
const attachedOnce = new Set<string>();

/** 一行会话上的全部图钉:portal 钉进行元素,行走到哪里图钉跟到哪里(浏览器原生) */
function RowPins({ el, pins, onRemove }: {
  el: HTMLElement;
  pins: Pin[];
  onRemove: (pinId: string) => void;
}): React.ReactNode {
  return createPortal(
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 10 }}>
      {pins.map((pin) => (
        <PinElement
          key={pin.id}
          pin={pin}
          animateIn={!attachedOnce.has(pin.id)}
          onRemove={() => onRemove(pin.id)}
        />
      ))}
    </div>,
    el,
  );
}

/** 单个图钉:钉入动画只播一次——行重排/视图切换导致的重挂载不再弹跳 */
function PinElement({ pin, animateIn, onRemove }: {
  pin: Pin;
  animateIn: boolean;
  onRemove: () => void;
}): React.ReactNode {
  const [popping, setPopping] = useState(false);
  useEffect(() => { attachedOnce.add(pin.id); }, [pin.id]);
  const handleClick = (e: React.MouseEvent): void => {
    e.stopPropagation();
    setPopping(true);
    setTimeout(onRemove, 350);
  };
  return (
    <div
      data-session-colors-pin
      onClick={handleClick}
      style={{
        position: "absolute",
        left: `${pin.x}%`,
        top: `${pin.y}%`,
        transform: "translate(-11px, -22px)",
        pointerEvents: "auto",
        cursor: "pointer",
        zIndex: 10,
      }}
    >
      <motion.div
        initial={animateIn ? { opacity: 0, y: -30, scale: 0.3, rotate: -25 } : false}
        animate={popping ? { opacity: 0, scale: 0.2, y: -60, rotate: 50 } : { opacity: 1, y: 0, scale: 1, rotate: 0 }}
        transition={popping ? { duration: 0.35, ease: "easeIn" } : { type: "spring", stiffness: 500, damping: 12, mass: 0.6 }}
        style={{ width: 22, height: 26, filter: "drop-shadow(0 2px 3px rgba(0,0,0,0.5))" }}
      >
        <PinSVG color={pin.color} style={{ width: 22, height: 26 }} />
      </motion.div>
    </div>
  );
}

/** messageActions 槽快捷入口(manifest 声明 when.role user/assistant):
 *  显式 toggle——该消息已有 lastUsedColor 钉则拔出,否则钉入默认位(设计 §5.3)。 */
export function ContentPinAction({ message }: MessageActionProps): React.ReactNode {
  const { t } = useTranslation();
  const currentSessionPath = useUiStore((s) => s.currentSessionPath);
  const currentNeutralSessionId = useUiStore((s) => s.currentNeutralSessionId);
  const lastUsedColor = usePinStore((s) => s.lastUsedColor);
  const pinned = usePinStore((s) =>
    currentSessionPath
      ? (s.contentPins[currentNeutralSessionId ?? currentSessionPath] ?? []).some((p) => p.messageId === message.id && p.color === s.lastUsedColor)
      : false,
  );
  if (!message.id || !currentSessionPath) return null;
  return (
    <button
      onClick={() => { usePinStore.getState().toggleContentPin(currentNeutralSessionId ?? currentSessionPath, message.id!, messagePreview(message)); }}
      title={pinned ? t("pinColors.quickUnpin") : t("pinColors.quickPin")}
      className="flex items-center gap-1 px-1.5 py-1 rounded-[var(--radius-sm)] text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface)] bg-transparent border-none cursor-pointer"
    >
      <PinSVG color={lastUsedColor} style={{ width: 10, height: 12 }} />
      {pinned ? t("pinColors.quickUnpin") : t("pinColors.quickPin")}
    </button>
  );
}
