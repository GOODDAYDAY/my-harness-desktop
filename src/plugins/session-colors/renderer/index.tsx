import React, { useEffect, useRef, useCallback, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { motion, AnimatePresence } from "framer-motion";
import { useTranslation } from "react-i18next";
import { Crosshair, Eye, EyeOff, Pin as PinIcon, Trash2, X, MessageSquare } from "lucide-react";
import { usePluginId, useUiStore, usePluginContext, useSessionStore, PluginIdContext, type PluginContext, type SessionInfo } from "@pi-desktop/react";
import { PinSVG } from "./pin-svg";
import { usePinStore, PALETTE, type Pin } from "./pin-store";


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

async function loadPins(ctx: PluginContext): Promise<Record<string, Pin[]>> {
  const cfg = await ctx.config.all();
  const raw = (cfg as Record<string, unknown>)["pins"];
  return (raw && typeof raw === "object" ? raw : {}) as Record<string, Pin[]>;
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
  const pinsVisible = usePinStore((s) => s.pinsVisible);
  const loaded = usePinStore((s) => s.loaded);
  const selectColor = usePinStore((s) => s.selectColor);
  const togglePinsVisible = usePinStore((s) => s.togglePinsVisible);
  const setPins = usePinStore((s) => s.setPins);
  const setLoaded = usePinStore((s) => s.setLoaded);
  const activeView = useUiStore((s) => s.activeView);

  const [activeFilter, setActiveFilter] = useState<string>("all");
  const [sessionNames, setSessionNames] = useState<Record<string, string>>({});
  const [sessionInfos, setSessionInfos] = useState<Record<string, SessionInfo>>({});
  const [visiblePaths, setVisiblePaths] = useState<Set<string>>(new Set());
  const currentCwd = useUiStore((s) => s.currentCwd);

  useEffect(() => {
    if (loaded) return;
    void loadPins(ctx).then((p) => setPins(p));
    void loadVisibility(ctx).then((v) => { if (!v) usePinStore.setState({ pinsVisible: false }); });
    setLoaded(true);
  }, [ctx, loaded, setPins, setLoaded]);

  // store → config 唯一写盘点:面板在框架树内(ctx 受控、pluginId 正确),
  // overlay 是独立 React root 拿不到 PluginIdContext,只动 store,由这里统一投影写盘。
  useEffect(() => {
    let first = true;
    return usePinStore.subscribe((state, prev) => {
      if (first) { first = false; return; } // 跳过初始 load 回填,避免把刚读出的内容原样写回
      if (state.pins !== prev.pins) persistPins(ctx, state.pins);
      if (state.pinsVisible !== prev.pinsVisible) void ctx.config.set("pinsVisible", state.pinsVisible);
    });
  }, [ctx]);

  // overlay 用独立 React root(pin 不随 sidePanel Tab 卸载),渲染起步需要真实 pluginId——
  // 面板(框架树内)挂载时从 usePluginId() 拿到并交给 renderOverlay(不手写字符串)。
  const pluginId = usePluginId();
  useEffect(() => { renderOverlay(pluginId); }, [pluginId]);

  // 会话元数据拉取(name/lastMessage/icon 展示 + 打开需要):同 sessions-list 数据源
  useEffect(() => {
    if (!currentCwd) { setSessionInfos({}); return; }
    void ctx.sessions.list(currentCwd).then((list) => {
      const map: Record<string, SessionInfo> = {};
      for (const s of list) map[s.path] = s;
      setSessionInfos(map);
    });
  }, [ctx, currentCwd]);

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

  const handleOpenSession = async (path: string): Promise<void> => {
    try {
      const info = sessionInfos[path];
      useUiStore.getState().setCurrentSessionPath(path);
      useUiStore.getState().setSessionTitle(info?.name ?? null);
      await useSessionStore.getState().openSession(path);
    } catch (err) { console.error('[session-colors] openSession failed:', err); }
  };

  const pinCountByColor = (color: string): number =>
    Object.values(pins).flat().filter((p) => p.color === color).length;

  const totalPinCount = Object.values(pins).flat().length;

  const handleClearColor = (color: string): void => {
    const next = { ...pins };
    for (const path of Object.keys(next)) {
      const filtered = (next[path] ?? []).filter((p) => p.color !== color);
      if (filtered.length === 0) delete next[path];
      else next[path] = filtered;
    }
    usePinStore.setState({ pins: next });
  };

  const handleClearAll = (): void => {
    usePinStore.setState({ pins: {} });
  };

  const colorsInUse = [...new Set(Object.values(pins).flat().map((p) => p.color))];
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

  return (
    <div className="flex flex-col gap-3 p-3 h-full">
      <div className="flex items-center gap-2">
        <PinIcon className="size-4 text-[var(--color-muted)]" />
        <span className="text-[var(--font-size-sm)] font-semibold text-[var(--color-fg)] flex-1">
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

      <div className="text-[var(--font-size-xs)] text-[var(--color-muted)] leading-relaxed">
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
                  className="absolute -top-1.5 -right-1.5 flex items-center justify-center rounded-full text-[10px] font-bold leading-none border-2 transition-all hover:scale-125"
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
                className="px-2 py-0.5 rounded-full text-[var(--font-size-xs)] whitespace-nowrap border transition-all flex items-center gap-1"
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
          {filteredPins.length === 0 ? (
            <div className="text-[var(--font-size-xs)] text-[var(--color-muted)] py-2">{t("pinColors.empty")}</div>
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
                {filteredPins.map(([path, pinList]) => {
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

function PinOverlay(): React.ReactNode {
  const selectedColor = usePinStore((s) => s.selectedColor);
  const pinMode = usePinStore((s) => s.pinMode);
  const pinsVisible = usePinStore((s) => s.pinsVisible);
  const pins = usePinStore((s) => s.pins);
  const loaded = usePinStore((s) => s.loaded);
  const selectColor = usePinStore((s) => s.selectColor);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const [targets, setTargets] = useState<Map<string, HTMLElement>>(new Map());
  const rafRef = useRef<number>(0);

  const exitPinMode = useCallback(() => { selectColor(null); }, [selectColor]);

  useEffect(() => {
    if (!pinMode) return;
    const onMove = (e: MouseEvent): void => setMousePos({ x: e.clientX, y: e.clientY });
    // mousedown 钉入;随后的 click 由 onClickCapture 吞掉,避免触发行 onClick 跳会话
    const onDown = (e: MouseEvent): void => {
      if (e.button === 2) return;
      const target = document.elementFromPoint(e.clientX, e.clientY);
      if (target?.closest("[data-session-colors-pin]")) return; // 点在已有图钉上:交给拔出
      const row = target?.closest("[data-session-path]");
      if (!(row instanceof HTMLElement)) return;
      const sessionPath = row.dataset.sessionPath;
      if (!sessionPath) return;
      const rect = row.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 100;
      const y = ((e.clientY - rect.top) / rect.height) * 100;
      usePinStore.getState().addPin(sessionPath, { id: crypto.randomUUID(), color: selectedColor!, x, y });
    };
    // 捕获相吞掉落在会话行上的 click,使其不触发"切换会话";点在图钉上放行(拔出逻辑自理)
    const onClickCapture = (e: MouseEvent): void => {
      const t = document.elementFromPoint(e.clientX, e.clientY);
      if (t?.closest("[data-session-colors-pin]")) return;
      if (t?.closest("[data-session-path]")) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const onContext = (e: Event): void => { e.preventDefault(); exitPinMode(); };
    const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") exitPinMode(); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("click", onClickCapture, true);
    window.addEventListener("contextmenu", onContext);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("click", onClickCapture, true);
      window.removeEventListener("contextmenu", onContext);
      window.removeEventListener("keydown", onKey);
    };
  }, [pinMode, selectedColor, exitPinMode]);

  // pin 钉进行元素后,行重排/滚动/缩放/补间动画全部由浏览器原生跟随;
  // JS 只维护 sessionPath → 行元素的挂载关系(行的增删/迁移 = childList 变化),不再做坐标追踪
  useEffect(() => {
    if (!loaded || !pinsVisible) return;
    let observer: MutationObserver | null = null;
    let observed: Element | null = null;

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
      // 行容器可能晚出现(列表异步拉取)或整体迁移(切项目/视图):每轮扫描后按当前实际容器重锚观察目标
      const container = document.querySelector("[data-session-path]")?.closest(".overflow-y-auto") ?? document.body;
      if (container !== observed) {
        observer?.disconnect();
        observer = new MutationObserver(scheduleScan);
        observer.observe(container, { childList: true, subtree: true });
        observed = container;
      }
    };

    scan();
    return () => {
      observer?.disconnect();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [pins, pinsVisible, loaded]);

  if (!loaded || !pinsVisible) return null;

  return createPortal(
    <>
      {pinMode && (
        <div style={{ position: "fixed", left: mousePos.x, top: mousePos.y, transform: "translate(-5px, -22px)", pointerEvents: "none", zIndex: 9999, opacity: 0.8 }}>
          <PinSVG color={selectedColor!} style={{ width: 22, height: 26, filter: "drop-shadow(0 2px 4px rgba(0,0,0,0.5))" }} />
        </div>
      )}
      {pinMode && <style>{`[data-session-path]:hover{outline:1px dashed rgba(137,180,250,0.3)!important;outline-offset:2px!important;}`}</style>}
      {[...targets].map(([path, el]) => (
        <RowPins
          key={path}
          el={el}
          pins={pins[path] ?? []}
          onRemove={(pinId) => usePinStore.getState().removePin(path, pinId)}
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

/** overlay 用独立 React root(图钉不随 sidePanel Tab 卸载),渲染起步需要真实 pluginId——
 *  面板(框架树内)首次挂载时从 usePluginId() 拿到并交过来,不手写字符串。 */
let overlayRendered = false;
function renderOverlay(pluginId: string): void {
  if (overlayRendered) return;
  overlayRendered = true;
  const overlayRoot = document.createElement("div");
  overlayRoot.id = "session-colors-overlay-root";
  document.body.appendChild(overlayRoot);
  createRoot(overlayRoot).render(
    <PluginIdContext.Provider value={pluginId}>
      <PinOverlay />
    </PluginIdContext.Provider>,
  );
}
