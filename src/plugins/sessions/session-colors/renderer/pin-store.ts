import { create } from "zustand";
import type { Pin, ContentPin } from "../core/pin";
import { PALETTE, CONTENT_PIN_DEFAULT } from "../core/pin";

interface PinStoreState {
  selectedColor: string | null;
  pins: Record<string, Pin[]>;
  contentPins: Record<string, ContentPin[]>;
  pinMode: boolean;
  pinsVisible: boolean;
  loaded: boolean;
  lastUsedColor: string;
  setPins: (pins: Record<string, Pin[]>) => void;
  setContentPins: (contentPins: Record<string, ContentPin[]>) => void;
  selectColor: (color: string | null) => void;
  togglePinsVisible: () => void;
  addPin: (sessionPath: string, pin: Pin) => void;
  removePin: (sessionPath: string, pinId: string) => void;
  addContentPin: (sessionPath: string, pin: ContentPin) => void;
  removeContentPin: (sessionPath: string, pinId: string) => void;
  toggleContentPin: (sessionPath: string, messageId: string) => boolean;
  setLoaded: (loaded: boolean) => void;
}

export const usePinStore = create<PinStoreState>((set, get) => ({
  selectedColor: null,
  pins: {},
  contentPins: {},
  pinMode: false,
  pinsVisible: true,
  loaded: false,
  lastUsedColor: PALETTE[0],
  setPins: (pins) => set({ pins }),
  setContentPins: (contentPins) => set({ contentPins }),
  selectColor: (color) =>
    set((s) => ({
      selectedColor: color,
      pinMode: color !== null,
      lastUsedColor: color !== null ? color : s.lastUsedColor,
    })),
  togglePinsVisible: () => set((s) => ({ pinsVisible: !s.pinsVisible })),
  addPin: (sessionPath, pin) =>
    set((s) => {
      const existing = s.pins[sessionPath] ?? [];
      const filtered = existing.filter((p) => p.color !== pin.color);
      return { pins: { ...s.pins, [sessionPath]: [...filtered, pin] } };
    }),
  removePin: (sessionPath, pinId) =>
    set((s) => {
      const existing = s.pins[sessionPath] ?? [];
      const filtered = existing.filter((p) => p.id !== pinId);
      const next = { ...s.pins };
      if (filtered.length === 0) delete next[sessionPath];
      else next[sessionPath] = filtered;
      return { pins: next };
    }),
  addContentPin: (sessionPath, pin) =>
    set((s) => {
      const existing = s.contentPins[sessionPath] ?? [];
      const filtered = existing.filter(
        (p) => !(p.messageId === pin.messageId && p.color === pin.color),
      );
      return { contentPins: { ...s.contentPins, [sessionPath]: [...filtered, pin] } };
    }),
  removeContentPin: (sessionPath, pinId) =>
    set((s) => {
      const existing = s.contentPins[sessionPath] ?? [];
      const filtered = existing.filter((p) => p.id !== pinId);
      const next = { ...s.contentPins };
      if (filtered.length === 0) delete next[sessionPath];
      else next[sessionPath] = filtered;
      return { contentPins: next };
    }),
  toggleContentPin: (sessionPath, messageId) => {
    const s = get();
    const existing = s.contentPins[sessionPath] ?? [];
    const hit = existing.find((p) => p.messageId === messageId && p.color === s.lastUsedColor);
    if (hit) {
      s.removeContentPin(sessionPath, hit.id);
      return false;
    }
    s.addContentPin(sessionPath, {
      id: crypto.randomUUID(),
      messageId,
      color: s.lastUsedColor,
      x: CONTENT_PIN_DEFAULT.x,
      y: CONTENT_PIN_DEFAULT.y,
    });
    return true;
  },
  setLoaded: (loaded) => set({ loaded }),
}));
