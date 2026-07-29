import React, { useEffect, useRef, useCallback, useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { useTranslation } from "react-i18next";
import { PinIcon } from "lucide-react";
import { registerSidePanelComponent, usePluginContext, useUiStore } from "@pi-desktop/react";
import { PinSVG } from "./pin-svg";
import { usePinStore, PALETTE, type Pin } from "./pin-store";

const PLUGIN_ID = "session-colors";
registerSidePanelComponent("SessionColorsPanel", SessionColorsPanel);

function SessionColorsPanel(): React.ReactNode {
  const ctx = usePluginContext(PLUGIN_ID);
  const { t } = useTranslation();
  const selectedColor = usePinStore((s) => s.selectedColor);
  const pinMode = usePinStore((s) => s.pinMode);
  const pins = usePinStore((s) => s.pins);
  const loaded = usePinStore((s) => s.loaded);
  const selectColor = usePinStore((s) => s.selectColor);
  const setPins = usePinStore((s) => s.setPins);
  const addPin = usePinStore((s) => s.addPin);
  const removePin = usePinStore((s) => s.removePin);
  const setLoaded = usePinStore((s) => s.setLoaded);
  const activeView = useUiStore((s) => s.activeView);

  const persistPins = useCallback(
    (next: Record<string, Pin[]>) => {
      void ctx.config.set("pins", next);
    },
    [ctx],
  );

  useEffect(() => {
    if (loaded) return;
    void ctx.config.all().then((cfg) => {
      const raw = (cfg as Record<string, unknown>)["pins"];
      if (raw && typeof raw === "object") {
        setPins(raw as Record<string, Pin[]>);
      }
      setLoaded(true);
    });
  }, [ctx, loaded, setPins, setLoaded]);

  useEffect(() => {
    if (activeView !== "chat" && pinMode) {
      selectColor(null);
    }
  }, [activeView, pinMode, selectColor]);

  const handleSelectColor = (color: string): void => {
    if (selectedColor === color) {
      selectColor(null);
      return;
    }
    selectColor(color);
  };

  const handleAddPin = (sessionPath: string, pin: Pin): void => {
    addPin(sessionPath, pin);
    persistPins(usePinStore.getState().pins);
  };

  const handleRemovePin = (sessionPath: string, pinId: string): void => {
    removePin(sessionPath, pinId);
    persistPins(usePinStore.getState().pins);
  };

  const visiblePins = Object.entries(pins).filter(([path]) =>
    document.querySelector(`[data-session-path="${CSS.escape(path)}"]`),
  );

  return (
    <>
      <div className="flex flex-col gap-3 p-3">
        <div className="text-[var(--font-size-sm)] font-semibold text-[var(--color-fg)]">
          {t("pinColors.title", "图钉")}
        </div>

        <div className="text-[var(--font-size-xs)] text-[var(--color-muted)] leading-relaxed">
          {pinMode
            ? t("pinColors.hint.active", "点击会话行钉入 · 右键/Esc 退出")
            : t("pinColors.hint.idle", "选一个颜色的图钉开始")}
        </div>

        <div className="flex items-center gap-1.5">
          {PALETTE.map((color) => (
            <button
              key={color}
              onClick={() => handleSelectColor(color)}
              className="flex items-center justify-center rounded-[var(--radius-sm)] border-2 transition-all"
              style={{
                width: 32,
                height: 36,
                borderColor: selectedColor === color ? "var(--color-fg)" : "transparent",
                background: selectedColor === color ? "var(--color-surface)" : "transparent",
                transform: selectedColor === color ? "scale(1.1)" : "scale(1)",
              }}
            >
              <PinSVG color={color} style={{ width: 22, height: 26, opacity: selectedColor === color ? 1 : 0.5 }} />
            </button>
          ))}
        </div>

        <div className="border-t border-[var(--color-border)] pt-2">
          <div className="text-[var(--font-size-xs)] text-[var(--color-muted)] mb-1.5">
            {t("pinColors.listTitle", "已钉")} ({visiblePins.length})
          </div>
          {visiblePins.length === 0 ? (
            <div className="text-[var(--font-size-xs)] text-[var(--color-muted)] py-2">
              {t("pinColors.empty", "暂无图钉")}
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              {visiblePins.map(([path, pinList]) => (
                <PinListGroup
                  key={path}
                  path={path}
                  pins={pinList}
                  onRemove={(pinId) => handleRemovePin(path, pinId)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {loaded && <PinOverlay onRemovePin={handleRemovePin} onAddPin={handleAddPin} />}
    </>
  );
}

function PinListGroup({
  path,
  pins,
  onRemove,
}: {
  path: string;
  pins: Pin[];
  onRemove: (pinId: string) => void;
}): React.ReactNode {
  const sessionName = path.split("/").pop()?.replace(/\.jsonl$/, "") ?? path;
  return (
    <div className="flex flex-col gap-0.5 rounded-[var(--radius-sm)] bg-[var(--color-surface)] px-2 py-1.5">
      <div className="text-[var(--font-size-xs)] text-[var(--color-muted)] truncate">{sessionName}</div>
      {pins.map((pin) => (
        <div key={pin.id} className="flex items-center gap-1.5 py-0.5">
          <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: pin.color }} />
          <span className="text-[var(--font-size-xs)] text-[var(--color-fg)] flex-1 truncate">
            {Math.round(pin.x)}%, {Math.round(pin.y)}%
          </span>
          <button
            onClick={() => onRemove(pin.id)}
            className="text-[var(--color-muted)] hover:text-[#f38ba8] text-xs w-4 h-4 flex items-center justify-center rounded"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

function PinOverlay({
  onAddPin,
  onRemovePin,
}: {
  onAddPin: (sessionPath: string, pin: Pin) => void;
  onRemovePin: (sessionPath: string, pinId: string) => void;
}): React.ReactNode {
  const selectedColor = usePinStore((s) => s.selectedColor);
  const pinMode = usePinStore((s) => s.pinMode);
  const selectColor = usePinStore((s) => s.selectColor);
  const pins = usePinStore((s) => s.pins);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const [pinPositions, setPinPositions] = useState<Map<string, { left: number; top: number }>>(new Map());
  const rafRef = useRef<number>(0);
  const observerRef = useRef<MutationObserver | null>(null);
  const resizeRef = useRef<ResizeObserver | null>(null);

  const exitPinMode = useCallback(() => {
    selectColor(null);
  }, [selectColor]);

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
      onAddPin(sessionPath, pin);
    };
    const onContext = (e: Event): void => {
      e.preventDefault();
      exitPinMode();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") exitPinMode();
    };

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
  }, [pinMode, selectedColor, onAddPin, exitPinMode]);

  const scheduleReposition = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const next = new Map<string, { left: number; top: number }>();
      for (const [path, pinList] of Object.entries(pins)) {
        const el = document.querySelector(`[data-session-path="${CSS.escape(path)}"]`);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        for (const pin of pinList) {
          const left = rect.left + (pin.x / 100) * rect.width;
          const top = rect.top + (pin.y / 100) * rect.height;
          next.set(pin.id, { left, top });
        }
      }
      setPinPositions(next);
    });
  }, [pins]);

  useEffect(() => {
    scheduleReposition();
  }, [scheduleReposition]);

  useEffect(() => {
    const scrollContainer = document.querySelector(".overflow-y-auto");
    if (!scrollContainer) return;

    const onScroll = (): void => scheduleReposition();
    scrollContainer.addEventListener("scroll", onScroll, { passive: true });

    observerRef.current = new MutationObserver(() => scheduleReposition());
    observerRef.current.observe(scrollContainer, { childList: true, subtree: true });

    resizeRef.current = new ResizeObserver(() => scheduleReposition());
    resizeRef.current.observe(scrollContainer);

    return () => {
      scrollContainer.removeEventListener("scroll", onScroll);
      observerRef.current?.disconnect();
      resizeRef.current?.disconnect();
    };
  }, [scheduleReposition]);

  if (!usePinStore.getState().loaded) return null;

  const allPins = Object.entries(pins).flatMap(([path, list]) => list.map((p) => ({ ...p, path })));

  return createPortal(
    <>
      {pinMode && (
        <div
          style={{
            position: "fixed",
            left: mousePos.x,
            top: mousePos.y,
            transform: "translate(-5px, -22px)",
            pointerEvents: "none",
            zIndex: 9999,
            opacity: 0.8,
          }}
        >
          <PinSVG color={selectedColor!} style={{ width: 22, height: 26, filter: "drop-shadow(0 2px 4px rgba(0,0,0,0.5))" }} />
        </div>
      )}

      {pinMode && (
        <style>{`
          [data-session-path]:hover {
            outline: 1px dashed rgba(137,180,250,0.3) !important;
            outline-offset: 2px !important;
          }
        `}</style>
      )}

      <div style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 9998 }}>
        {allPins.map((pin) => {
          const pos = pinPositions.get(pin.id);
          if (!pos) return null;
          return (
            <PinElement
              key={pin.id}
              pin={pin}
              pos={pos}
              onRemove={() => onRemovePin(pin.path, pin.id)}
            />
          );
        })}
      </div>
    </>,
    document.body,
  );
}

const PinElement = React.memo(function PinElement({
  pin,
  pos,
  onRemove,
}: {
  pin: Pin & { path: string };
  pos: { left: number; top: number };
  onRemove: () => void;
}): React.ReactNode {
  const [popping, setPopping] = useState(false);

  const handleClick = (e: React.MouseEvent): void => {
    e.stopPropagation();
    setPopping(true);
    setTimeout(() => {
      onRemove();
      setPopping(false);
    }, 350);
  };

  return (
    <div
      onClick={handleClick}
      style={{
        position: "fixed",
        left: pos.left,
        top: pos.top,
        transform: "translate(-11px, -22px)",
        pointerEvents: "auto",
        cursor: "pointer",
        zIndex: 9998,
      }}
    >
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
