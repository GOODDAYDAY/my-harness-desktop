import React, { useEffect, useRef, useCallback, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { motion, AnimatePresence } from "framer-motion";
import { useTranslation } from "react-i18next";
import { Eye, EyeOff, Pin as PinIcon, Trash2, X, MapPin } from "lucide-react";
import {  useUiStore, usePluginContext, type PluginContext } from "@pi-desktop/react";
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


export function SessionColorsPanel({ isActive }: { isActive: boolean }): React.ReactNode {
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
  const [visiblePaths, setVisiblePaths] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (loaded) return;
    void loadPins(ctx).then((p) => setPins(p));
    void loadVisibility(ctx).then((v) => { if (!v) usePinStore.setState({ pinsVisible: false }); });
    setLoaded(true);
  }, [loaded, setPins, setLoaded]);

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
    void ctx.config.set( "pinsVisible", !pinsVisible);
  };

  const handleSelectColor = (color: string): void => {
    selectColor(selectedColor === color ? null : color);
  };

  const handleRemovePin = (path: string, pinId: string): void => {
    usePinStore.getState().removePin(path, pinId);
    persistPins(ctx, usePinStore.getState().pins);
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
    persistPins(ctx, next);
  };

  const handleClearAll = (): void => {
    usePinStore.setState({ pins: {} });
    persistPins(ctx, {});
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
                    <PinListGroup
                      key={path}
                      pins={filtered}
                      sessionName={sessionNames[path] ?? path}
                      onRemove={(pinId) => handleRemovePin(path, pinId)}
                      onLocate={() => onLocate(path)}
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

function PinListGroup({
  pins, sessionName, onRemove, onLocate,
}: {
  pins: Pin[];
  sessionName: string;
  onRemove: (pinId: string) => void;
  onLocate: () => void;
}): React.ReactNode {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const pinCount = pins.length;
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
      onClick={onLocate}
    >
      <div className="shrink-0 flex items-center justify-center" style={{ width: 20, height: 20 }}>
        <MapPin className="size-3.5 text-[var(--color-muted)]" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="truncate text-[length:var(--font-size-sm)] font-semibold leading-tight text-[var(--color-fg)]">
          {sessionName}
        </div>
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
      <span className="text-[var(--font-size-xs)] text-[var(--color-muted)] shrink-0">
        {pinCount}
      </span>
    </div>
  );
}

function PinOverlay(): React.ReactNode {
  const ctx = usePluginContext();
  const selectedColor = usePinStore((s) => s.selectedColor);
  const pinMode = usePinStore((s) => s.pinMode);
  const pinsVisible = usePinStore((s) => s.pinsVisible);
  const pins = usePinStore((s) => s.pins);
  const loaded = usePinStore((s) => s.loaded);
  const selectColor = usePinStore((s) => s.selectColor);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const [pinPositions, setPinPositions] = useState<Map<string, { left: number; top: number }>>(new Map());
  const rafRef = useRef<number>(0);
  const observerRef = useRef<MutationObserver | null>(null);
  const resizeRef = useRef<ResizeObserver | null>(null);

  const exitPinMode = useCallback(() => { selectColor(null); }, [selectColor]);

  useEffect(() => {
    if (!pinMode) return;
    const onMove = (e: MouseEvent): void => setMousePos({ x: e.clientX, y: e.clientY });
    const onDown = (e: MouseEvent): void => {
      if (e.button === 2) return;
      const target = document.elementFromPoint(e.clientX, e.clientY);
      const row = target?.closest("[data-session-path]");
      if (!row) return;
      const sessionPath = (row as HTMLElement).dataset.sessionPath;
      if (!sessionPath) return;
      const rect = row.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 100;
      const y = ((e.clientY - rect.top) / rect.height) * 100;
      const pin: Pin = { id: crypto.randomUUID(), color: selectedColor!, x, y };
      usePinStore.getState().addPin(sessionPath, pin);
      persistPins(ctx, usePinStore.getState().pins);
    };
    const onContext = (e: Event): void => { e.preventDefault(); exitPinMode(); };
    const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") exitPinMode(); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("contextmenu", onContext);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("contextmenu", onContext);
      window.removeEventListener("keydown", onKey);
    };
  }, [pinMode, selectedColor, exitPinMode]);

  const scheduleReposition = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const next = new Map<string, { left: number; top: number }>();
      for (const [path, pinList] of Object.entries(pins)) {
        if (!isRowVisible(path)) continue;
        const el = document.querySelector(`[data-session-path="${CSS.escape(path)}"]`);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        for (const pin of pinList) {
          next.set(pin.id, { left: rect.left + (pin.x / 100) * rect.width, top: rect.top + (pin.y / 100) * rect.height });
        }
      }
      setPinPositions(next);
    });
  }, [pins]);

  useEffect(() => { scheduleReposition(); }, [scheduleReposition]);

  useEffect(() => {
    let scrollContainer = document.querySelector(".overflow-y-auto");
    if (!scrollContainer) {
      const retry = setTimeout(() => {
        scrollContainer = document.querySelector(".overflow-y-auto");
        if (scrollContainer) setup();
      }, 500);
      return () => clearTimeout(retry);
    }
    setup();
    function setup(): void {
      const sc = document.querySelector(".overflow-y-auto");
      if (!sc) return;
      sc.addEventListener("scroll", () => scheduleReposition(), { passive: true });
      observerRef.current = new MutationObserver(() => scheduleReposition());
      observerRef.current.observe(sc, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-state"] });
      resizeRef.current = new ResizeObserver(() => scheduleReposition());
      resizeRef.current.observe(sc);
    }
    return () => { observerRef.current?.disconnect(); resizeRef.current?.disconnect(); };
  }, [scheduleReposition]);

  if (!loaded || !pinsVisible) return null;

  const allPins = Object.entries(pins).flatMap(([path, list]) => list.map((p) => ({ ...p, path })));

  return createPortal(
    <>
      {pinMode && (
        <div style={{ position: "fixed", left: mousePos.x, top: mousePos.y, transform: "translate(-5px, -22px)", pointerEvents: "none", zIndex: 9999, opacity: 0.8 }}>
          <PinSVG color={selectedColor!} style={{ width: 22, height: 26, filter: "drop-shadow(0 2px 4px rgba(0,0,0,0.5))" }} />
        </div>
      )}
      {pinMode && <style>{`[data-session-path]:hover{outline:1px dashed rgba(137,180,250,0.3)!important;outline-offset:2px!important;}`}</style>}
      <div style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 9998 }}>
        {allPins.map((pin) => {
          const pos = pinPositions.get(pin.id);
          if (!pos) return null;
          return <PinElement key={pin.id} pin={pin} pos={pos} onRemove={() => {
            usePinStore.getState().removePin(pin.path, pin.id);
            persistPins(ctx, usePinStore.getState().pins);
          }} />;
        })}
      </div>
    </>,
    document.body,
  );
}

const PinElement = React.memo(function PinElement({ pin, pos, onRemove }: {
  pin: Pin & { path: string };
  pos: { left: number; top: number };
  onRemove: () => void;
}): React.ReactNode {
  const [popping, setPopping] = useState(false);
  const handleClick = (e: React.MouseEvent): void => {
    e.stopPropagation();
    setPopping(true);
    setTimeout(() => { onRemove(); setPopping(false); }, 350);
  };
  return (
    <div onClick={handleClick} style={{ position: "fixed", left: pos.left, top: pos.top, transform: "translate(-11px, -22px)", pointerEvents: "auto", cursor: "pointer", zIndex: 9998 }}>
      <motion.div
        initial={{ opacity: 0, y: -30, scale: 0.3, rotate: -25 }}
        animate={popping ? { opacity: 0, scale: 0.2, y: -60, rotate: 50 } : { opacity: 1, y: 0, scale: 1, rotate: 0 }}
        transition={popping ? { duration: 0.35, ease: "easeIn" } : { type: "spring", stiffness: 500, damping: 12, mass: 0.6 }}
        style={{ width: 22, height: 26, filter: "drop-shadow(0 2px 3px rgba(0,0,0,0.5))" }}
      >
        <PinSVG color={pin.color} style={{ width: 22, height: 26 }} />
      </motion.div>
    </div>
  );
});



const overlayRoot = document.createElement("div");
overlayRoot.id = "session-colors-overlay-root";
document.body.appendChild(overlayRoot);
createRoot(overlayRoot).render(<PinOverlay />);
